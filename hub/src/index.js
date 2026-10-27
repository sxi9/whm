import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { loadConfig } from './config.js';
import { createApp, finalizeApp, createLoopbackApp } from './app.js';
import { openDb, newId, nowIso, json } from '../shared/db.js';
import { createCrypto } from '../shared/crypto.js';
import { loadSigningKeys } from '../shared/keys.js';
import { createAudit } from '../shared/audit.js';
import * as webhooks from '../shared/webhooks.js';
import { createMailer, sendmailTransport, recordingTransport } from '../shared/mailer.js';
import { createScheduler, LICENSE_SCHEDULES } from '../shared/scheduler.js';
import { createNonceStore } from '../shared/nonce.js';
import { createSafeFetch } from '../shared/safe-fetch.js';
import psl from '../shared/psl.js';
import { createProductsService } from '../license/services/products.js';
import { createCustomersService } from '../license/services/customers.js';
import { createResellersService } from '../license/services/resellers.js';
import { createLicensesService } from '../license/services/licenses.js';
import { createActivationsService } from '../license/services/activations.js';
import { createTrialsService } from '../license/services/trials.js';
import { createTransfersService } from '../license/services/transfers.js';
import { createBillingService } from '../license/services/billing.js';
import { createReportsService } from '../license/services/reports.js';
import { createPortalUsersService } from '../license/services/portal-users.js';
import { createSigningKeysService } from '../license/services/signing-keys.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LICENSE_MIGRATIONS = path.join(HERE, '../license/migrations');

function createMetrics() {
  const counters = new Map();
  const summaries = new Map();
  return {
    inc(name, labels = {}, by = 1) {
      const key = `${name}|${JSON.stringify(labels)}`;
      counters.set(key, { name, labels, value: (counters.get(key)?.value || 0) + by });
    },
    observe(name, value) {
      const s = summaries.get(name) || { count: 0, sum: 0, max: 0 };
      s.count++; s.sum += value; s.max = Math.max(s.max, value);
      summaries.set(name, s);
    },
    gauges: [],
    render() {
      const lines = [];
      for (const { name, labels, value } of counters.values()) {
        const l = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
        lines.push(`${name}${l ? `{${l}}` : ''} ${value}`);
      }
      for (const [name, s] of summaries) lines.push(`${name}_count ${s.count}`, `${name}_sum ${s.sum.toFixed(3)}`, `${name}_max ${s.max.toFixed(3)}`);
      for (const g of this.gauges) { try { for (const [k, v, labels] of g()) lines.push(`${k}${labels ? `{${labels}}` : ''} ${v}`); } catch { /* skip */ } }
      return lines.join('\n') + '\n';
    },
  };
}

// Long operations (bulk issue) run in-process; results are encrypted at rest
// because they contain clear-text keys, and are readable only by their owner.
function createJobs(ctx) {
  const db = ctx.dbs.license;
  const stmts = {
    insert: db.prepare('INSERT INTO jobs (id, type, owner_type, owner_id, status, params_json, created_at) VALUES (@id, @type, @owner_type, @owner_id, \'queued\', @params_json, @created_at)'),
    get: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    finish: db.prepare('UPDATE jobs SET status = @status, result_json = @result_json, error = @error, finished_at = @finished_at WHERE id = @id'),
  };
  const pending = [];
  function run(id, fn) {
    const p = Promise.resolve().then(fn).then(
      (result) => stmts.finish.run({ id, status: 'done', result_json: ctx.crypto.encrypt(JSON.stringify(result)), error: null, finished_at: nowIso(ctx.clock.now()) }),
      (err) => stmts.finish.run({ id, status: 'failed', result_json: null, error: String(err?.message || err), finished_at: nowIso(ctx.clock.now()) }),
    );
    pending.push(p);
    return p;
  }
  return {
    enqueueBulkIssue(input, { actor, scope, owner }) {
      const id = newId('job', ctx.clock.now());
      stmts.insert.run({ id, type: 'bulk_issue', owner_type: owner?.ownerType || null, owner_id: owner?.ownerId || null, params_json: JSON.stringify({ sku: input.sku, count: input.count, customer_id: input.customer_id }), created_at: nowIso(ctx.clock.now()) });
      run(id, () => {
        const licenses = [];
        db.transaction(() => {
          for (let i = 0; i < input.count; i++) {
            const { license, key } = ctx.licenses.issue({ sku: input.sku, customer_id: input.customer_id, reseller_id: input.reseller_id, notes: input.notes, term_months: input.term_months, notify: false }, { actor, scope });
            licenses.push({ license_id: license.id, key, key_prefix: license.key_prefix, edition: license.edition, expires_at: license.expires_at });
          }
        })();
        return { licenses, count: licenses.length };
      });
      return { id };
    },
    get(id, principal) {
      const row = stmts.get.get(id);
      if (!row || (row.owner_type && principal && (row.owner_type !== principal.ownerType || row.owner_id !== principal.ownerId))) {
        const err = new Error('Job not found'); err.status = 404; err.code = 'not_found'; throw Object.assign(err, { fields: undefined });
      }
      return { id: row.id, type: row.type, status: row.status, params: json.parse(row.params_json, {}), result: row.result_json ? JSON.parse(ctx.crypto.decrypt(row.result_json)) : null, error: row.error, created_at: row.created_at, finished_at: row.finished_at };
    },
    settle: () => Promise.allSettled(pending.splice(0)),
  };
}

function ensureMasterKey(config, logger) {
  if (config.master_key) return config.master_key;
  if (fs.existsSync(config.master_key_file)) return fs.readFileSync(config.master_key_file, 'utf8').trim();
  const generated = crypto.randomBytes(32).toString('hex');
  const target = path.join(config.db_dir, 'master.key');
  fs.mkdirSync(config.db_dir, { recursive: true, mode: 0o750 });
  fs.writeFileSync(target, generated + '\n', { mode: 0o600 });
  logger.warn({ file: target }, 'no master key found; generated one in the data directory (run hub/scripts/gen-key.js --master for production)');
  return generated;
}

function ensureSessionSecret(config) {
  if (config.session_secret) return config.session_secret;
  const file = path.join(config.db_dir, 'session.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(config.db_dir, { recursive: true, mode: 0o750 });
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  return secret;
}

// bootstrap({ dbDir, config, now, mailTransport, fetch }) -> ctx.
export async function bootstrap(overrides = {}) {
  const config = loadConfig({ overrides: { ...(overrides.config || {}), ...(overrides.dbDir ? { db_dir: overrides.dbDir } : {}) } });
  if (overrides.dbDir && !overrides.config?.keys?.dir) config.keys.dir = path.join(overrides.dbDir, 'keys');
  const logger = overrides.logger || pino({ level: config.log_level });
  const clock = { now: overrides.now || (() => Date.now()) };
  const dbs = { license: openDb(path.join(config.db_dir, 'license.db'), { migrationsDir: LICENSE_MIGRATIONS, logger }) };
  const cryptoSvc = createCrypto(ensureMasterKey(config, logger));
  config.session_secret = ensureSessionSecret(config);
  const keys = loadSigningKeys(config.keys.dir, dbs.license, { activeKids: config.keys.active_kid, logger, now: clock.now });
  const audit = createAudit({ db: dbs.license, logger, now: clock.now });
  const safeFetch = overrides.fetch || createSafeFetch();
  const mailer = createMailer({
    from: config.license.mail.from, logger, enabled: config.license.mail.enabled,
    transport: overrides.mailTransport || (config.license.mail.transport === 'none' ? recordingTransport() : sendmailTransport()),
  });
  const ctx = {
    config, logger, clock, dbs, crypto: cryptoSvc, keys, audit, mailer, safeFetch, psl, metrics: createMetrics(),
    nonce: createNonceStore(dbs.license, { ttlS: config.license.nonce_ttl_s, maxSkewS: config.license.max_skew_s, now: clock.now }),
    scheduler: createScheduler({ logger, now: clock.now }),
    hooks: { checkin: [], billing: [], activationExtras: [], keyActivated: [], beforeKeyRetire: [] },
    webhooks: {
      ...webhooks,
      deliverDue: (opts = {}) => webhooks.deliver(dbs.license, { ownerType: 'vendor', fetch: overrides.webhookFetch || ((url, init) => safeFetch(url, { ...init, maxBytes: 65536, timeoutMs: init?.timeoutMs || 10_000 })), crypto: cryptoSvc, now: clock.now, logger, ...opts }),
    },
    modules: [],
    finalized: false,
    registerModule(fn) {
      if (ctx.finalized) throw new Error('registerModule() must be called before the app is finalised');
      ctx.modules.push(fn);
    },
  };
  ctx.products = createProductsService(ctx);
  ctx.customers = createCustomersService(ctx);
  ctx.resellers = createResellersService(ctx);
  ctx.licenses = createLicensesService(ctx);
  ctx.activations = createActivationsService(ctx);
  ctx.trials = createTrialsService(ctx);
  ctx.transfers = createTransfersService(ctx);
  ctx.billing = createBillingService(ctx);
  ctx.reports = createReportsService(ctx);
  ctx.portalUsers = createPortalUsersService(ctx);
  ctx.signingKeys = createSigningKeysService(ctx);
  ctx.jobs = createJobs(ctx);

  ctx.health = () => {
    let dbOk = false;
    try { dbs.license.prepare('SELECT 1').get(); dbs.license.prepare("INSERT INTO nonces (nonce, seen_at) VALUES ('healthz', 0)").run(); dbs.license.prepare("DELETE FROM nonces WHERE nonce = 'healthz'").run(); dbOk = true; } catch { dbOk = false; }
    const license = keys.active('license');
    const plugin = keys.active('plugin');
    const clockOk = Math.abs(Date.now() - clock.now()) < 24 * 3600_000;
    return { ok: dbOk && !!license?.privateKey && !!plugin?.privateKey && clockOk, db: dbOk, keys: { license: license?.kid || null, plugin: plugin?.kid || null }, clock: clockOk, version: 1 };
  };
  ctx.metrics.gauges.push(() => [
    ...dbs.license.prepare("SELECT l.edition, COUNT(*) AS n FROM activations a JOIN licenses l ON l.id = a.license_id WHERE a.status = 'active' GROUP BY l.edition").all().map((r) => ['activations_active', r.n, `edition="${r.edition}"`]),
    ['webhook_failures', dbs.license.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status IN ('failed', 'retrying')").get().n],
    ['nonces_cached', dbs.license.prepare('SELECT COUNT(*) AS n FROM nonces').get().n],
  ]);

  const jobs = {
    'expire-licenses': () => ({ ...ctx.licenses.expireDue(), ...ctx.activations.flagMissedCheckins() }),
    'expiring-reminders': () => ctx.licenses.expiringReminders(),
    'stale-activations': () => ({ stale: ctx.activations.stale().length }),
    'trial-expiry': () => ctx.trials.expireDue(),
    'webhook-retry': () => ctx.webhooks.deliverDue(),
    'nonce-prune': () => ({ pruned: ctx.nonce.prune(), lookups: ctx.licenses.lookupGuard.prune() }),
    'checkin-prune': () => ctx.activations.pruneCheckins(),
    'db-backup': async () => {
      const dir = config.license.backup_dir;
      if (!dir || !fs.existsSync(dir)) return { skipped: 'backup_dir missing' };
      const file = path.join(dir, `license-${nowIso(clock.now()).replace(/[:.]/g, '-')}.db`);
      await dbs.license.backup(file);
      const old = fs.readdirSync(dir).filter((f) => /^license-.*\.db$/.test(f)).sort().slice(0, -config.license.backup_keep);
      for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
      return { file };
    },
  };
  for (const { name, cron } of LICENSE_SCHEDULES) ctx.scheduler.ensure(name, cron, jobs[name]);

  createApp(ctx);
  // ctx.registerModule(...) lines belong here, before the modules run:
  for (const fn of ctx.modules) await fn(ctx);
  ctx.finalized = true;
  ctx.registerModule = () => { throw new Error('registerModule() must be called before the app is finalised'); };
  finalizeApp(ctx);
  ctx.loopback = createLoopbackApp(ctx);

  ctx.close = async () => {
    ctx.scheduler.stop();
    await ctx.jobs.settle();
    ctx.portalSessionStore?.close();
    for (const db of Object.values(dbs)) db.close();
  };
  return ctx;
}

export async function start() {
  const ctx = await bootstrap();
  const { config, logger, app } = ctx;
  const servers = [];
  if (config.tls) {
    const srv = https.createServer({ cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key), minVersion: 'TLSv1.2' }, app);
    srv.listen(config.port, config.host, () => logger.info({ port: config.port }, 'whm-hub listening (https)'));
    servers.push(srv);
  } else if (config.insecure_http) {
    const srv = http.createServer(app);
    srv.listen(config.port, config.host, () => logger.warn({ port: config.port }, 'whm-hub listening on PLAIN HTTP (insecure_http); put TLS in front'));
    servers.push(srv);
  } else {
    throw new Error('TLS is required: set tls.cert/tls.key in hub.conf (or insecure_http: true behind a TLS proxy)');
  }
  if (config.loopback_port) {
    const lb = http.createServer(ctx.loopback);
    lb.listen(config.loopback_port, '127.0.0.1', () => logger.info({ port: config.loopback_port }, 'whm-hub loopback /healthz /metrics'));
    servers.push(lb);
  }
  ctx.scheduler.start();
  const shutdown = async () => { for (const s of servers) s.close(); await ctx.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return ctx;
}

// `--check-config`: boots against a temp dir with ephemeral keys, answers
// GET /healthz on an ephemeral loopback port, prints the result and exits.
export async function checkConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-hub-check-'));
  const ctx = await bootstrap({ dbDir: dir, config: { log_level: 'silent', license: { mail: { transport: 'none' }, backup_dir: null } }, logger: pino({ level: 'silent' }) });
  ctx.keys.generate('license', { activate: true });
  ctx.keys.generate('plugin', { activate: true });
  const server = http.createServer(ctx.loopback);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/healthz' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
  server.close();
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const ok = body.status === 200;
  process.stdout.write(`config: ${ctx.config.config_file}\nhealthz: ${body.status} ${body.body}\n`);
  return ok;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check-config')) {
    checkConfig().then((ok) => process.exit(ok ? 0 : 1), (err) => { console.error(err); process.exit(1); });
  } else {
    start().catch((err) => { console.error(err); process.exit(1); });
  }
}
