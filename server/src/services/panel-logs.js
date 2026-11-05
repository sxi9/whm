import { HttpError, CapabilityError, notFound } from '../lib/errors.js';
import { domainLogFile, DOMLOGS_ROOT, NGINX_LOG_DIR } from './account-functions.js';
import { assertFeature, auditArgs, homeOf } from './panel-domains.js';

export const MAX_TAIL_BYTES = 1024 * 1024;

// Visitors (design P1-5): GoAccess reports rendered as the account into
// <home>/.keel/stats/<domain>.html with a compact <domain>.summary.json next
// to it, by the daily job (every active account whose plan includes the
// feature) or on demand per domain. The panel only ever reads them back as the
// account through files.*.
export const STATS_JOB = 'panel.stats.generate';
export const STATS_SCHEDULE = { name: 'panel-stats-generate', cron: '50 1 * * *' };
export const STATS_FEATURE = 'webstats';
export const STATS_COOLDOWN_SETTING = 'panel.stats.generate_cooldown_s';
export const STATS_COOLDOWN_DEFAULT_S = 600;
const STATS_DOMAIN_TYPES = ['main', 'addon', 'sub'];
const SUMMARY_MAX_BYTES = 1024 * 1024;
const REPORT_CHUNK = 2 * 1024 * 1024;

export const statsPaths = (home, domain) => ({ html: `${home}/.keel/stats/${domain}.html`, summary: `${home}/.keel/stats/${domain}.summary.json` });

// Errors (design P2-5): only the live error logs, never rotated or archived
// copies; the range read per file is sized from the line budget.
export const ERRORS_DEFAULT_LINES = 300;
export const ERRORS_MAX_LINES = 1000;
const ERRORS_BYTES_PER_LINE = 256;
export const ERROR_LOG = /[._-](ssl[._-]?)?error(_log|\.log)?$/i;

export const domainOfLog = (name, domains) => (domains || []).filter((d) => domainLogFile(d).test(name)).sort((a, b) => b.length - a.length)[0] || null;

async function tailEntry(ctx, scope, entry, bytes, req) {
  const file = entry.name;
  const want = Math.min(Math.max(1, bytes), MAX_TAIL_BYTES);
  const size = Number(entry.size) || 0;
  if (size === 0) return { file, size: 0, offset: 0, length: 0, truncated: false, content: '', mtime: entry.mtime ?? null };
  const offset = Math.max(0, size - want);
  const part = await ctx.agent.op('acct.read_range', { path: entry.path, owner: scope.username, offset, length: Math.min(want, size - offset) }, { req });
  let content = Buffer.from(part.data || '', 'base64').toString('utf8');
  if (offset > 0) { const nl = content.indexOf('\n'); if (nl >= 0) content = content.slice(nl + 1); }
  return { file, size: part.size, offset, length: part.length, truncated: offset > 0, content, mtime: part.mtime ?? entry.mtime ?? null };
}

// Raw web logs and bandwidth history for one account (design §4.11). A file is
// only ever addressed by the name the listing produced; the agent reads the
// listed path with the account as owner, so a planted symlink or a foreign
// file under ~/logs is refused on the host as well.
export function createPanelLogsService(ctx) {
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const accountFunctions = () => { if (!ctx.accountFunctions?.logs) throw new HttpError(503, 'service_unavailable', 'The Account Functions category is not loaded'); return ctx.accountFunctions; };
  const accountInfo = () => { if (!ctx.accountInfo?.bandwidthHistory) throw new HttpError(503, 'service_unavailable', 'The Account Information category is not loaded'); return ctx.accountInfo; };
  const ownDomains = (scope) => (ctx.panelDomains?.allDomains ? ctx.panelDomains.allDomains(scope).map((d) => d.domain) : []);
  const serverDirs = (scope) => [`${DOMLOGS_ROOT}/${scope.username}`, NGINX_LOG_DIR];
  const shapeFile = (scope, f) => ({ name: f.name, size: f.size, mtime: f.mtime, location: serverDirs(scope).includes(f.dir) ? 'server' : 'home' });

  // The delegate lists the account's directories; the server-side directories
  // are narrowed to files named after the account's own hostnames.
  async function listing(scope, kind) {
    const result = await accountFunctions().logs.list(scope.username, kind, scope.ownerPrincipal);
    const home = `${homeOf(ctx, scope.account)}/logs`;
    // The delegate lists the main domain once from the account and again from
    // its account_domains row when one exists.
    const domains = [...new Set([...(result.domains || []), ...ownDomains(scope)])];
    const patterns = domains.map((d) => domainLogFile(d));
    const files = (result.files || []).filter((f) => f.dir === home || patterns.some((p) => p.test(f.name)));
    return { ...result, domains, files };
  }

  return {
    async list(scope, { kind = 'apache' } = {}) {
      assertFeature(scope, 'rawlog');
      const result = await listing(scope, kind);
      return { kind, domains: result.domains, files: result.files.map((f) => shapeFile(scope, f)), warnings: result.warnings ?? [], apache: result.apache, nginx: result.nginx };
    },

    async tail(scope, { kind = 'apache', file, bytes = 64 * 1024 }, req) {
      assertFeature(scope, 'rawlog');
      const result = await listing(scope, kind);
      const entry = result.files.find((f) => f.name === file);
      if (!entry) throw notFound(`Log file "${file}"`);
      return tailEntry(ctx, scope, entry, bytes, req);
    },

    // Errors (design P2-5): the newest lines of every error log of the
    // account's domains, from both web servers when both exist, each read with
    // the same bounded range as the tail.
    async errors(scope, { lines = ERRORS_DEFAULT_LINES, domain = null } = {}, req) {
      assertFeature(scope, 'errlog');
      const want = Math.min(Math.max(1, lines), ERRORS_MAX_LINES);
      const bytes = Math.min(MAX_TAIL_BYTES, Math.max(64 * 1024, want * ERRORS_BYTES_PER_LINE));
      const listings = [];
      const warnings = [];
      const servers = {};
      for (const kind of ['apache', 'nginx']) {
        try {
          const result = await listing(scope, kind);
          listings.push({ kind, result });
          warnings.push(...(result.warnings ?? []));
          servers[kind] = result[kind] !== false;
        } catch (err) {
          if (err instanceof CapabilityError || err?.code === 'capability_missing') { servers[kind] = false; continue; }
          throw err;
        }
      }
      const domains = [...new Set(listings.flatMap((l) => l.result.domains))];
      if (domain && !domains.includes(domain)) throw notFound(`Domain "${domain}"`);
      const entries = listings.flatMap(({ kind, result }) => result.files
        .filter((f) => ERROR_LOG.test(f.name))
        .map((f) => ({ kind, entry: f, domain: domainOfLog(f.name, domains) }))
        .filter((f) => !domain || f.domain === domain));
      const files = await Promise.all(entries.map(async ({ kind, entry, domain: d }) => {
        const part = await tailEntry(ctx, scope, entry, bytes, req);
        const all = part.content.split('\n');
        if (all.length && all[all.length - 1] === '') all.pop();
        const shown = all.slice(-want).reverse();
        return { name: entry.name, kind, domain: d, location: shapeFile(scope, entry).location, size: part.size, mtime: part.mtime, lines: shown, truncated: part.truncated || all.length > shown.length };
      }));
      files.sort((a, b) => (Date.parse(b.mtime || 0) || 0) - (Date.parse(a.mtime || 0) || 0) || a.name.localeCompare(b.name));
      return { lines: want, domain, domains, files, warnings, apache: servers.apache === true, nginx: servers.nginx === true };
    },

    async download(scope, { kind = 'apache', file }, req, res) {
      assertFeature(scope, 'rawlog');
      const result = await listing(scope, kind);
      if (!result.files.some((f) => f.name === file)) throw notFound(`Log file "${file}"`);
      audit(req, { action: 'panel.logs.download', target: scope.username, args: auditArgs(scope, { kind, file }) });
      return accountFunctions().logs.download(scope.username, kind, file, scope.ownerPrincipal, req, res);
    },

    bandwidth(scope, { months = 12 } = {}) {
      assertFeature(scope, 'bandwidth');
      const result = accountInfo().bandwidthHistory(scope.username, scope.ownerPrincipal, months);
      return { domain: result.domain, limitMb: result.limitMb, months: result.months, sources: (result.sources || []).map((s) => ({ path: s.path, bytes: s.bytes_processed, lastSeenAt: s.last_seen_at })) };
    },

    retention(scope) {
      assertFeature(scope, 'rawlog');
      const r = accountFunctions().logRetention.get(scope.username, scope.ownerPrincipal);
      return { archiveLogs: r.archive_logs, removeOldArchives: r.remove_old_archives, retainMonths: r.retain_months, lastArchivedAt: r.last_archived_at, archiveDir: r.archive_dir };
    },

    setRetention(scope, { archiveLogs, removeOldArchives }, req) {
      assertFeature(scope, 'rawlog');
      const r = accountFunctions().logRetention.set(scope.username, { archiveLogs, removeOldArchives }, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.logs.retention', target: scope.username, args: auditArgs(scope, { archiveLogs, removeOldArchives }) });
      return { archiveLogs: r.archive_logs, removeOldArchives: r.remove_old_archives, retainMonths: r.retain_months, lastArchivedAt: r.last_archived_at, archiveDir: r.archive_dir };
    },

    stats: createStats(ctx, { audit }),
  };
}

function createStats(ctx, { audit }) {
  const db = () => ctx.db;
  const cooldownMs = () => {
    const v = Number(ctx.settings?.get?.(STATS_COOLDOWN_SETTING, STATS_COOLDOWN_DEFAULT_S));
    return (Number.isFinite(v) && v >= 0 ? v : STATS_COOLDOWN_DEFAULT_S) * 1000;
  };
  const statsDomains = (scope) => (ctx.panelDomains?.allDomains ? ctx.panelDomains.allDomains(scope) : [{ domain: scope.account.domain, type: 'main' }])
    .filter((r) => STATS_DOMAIN_TYPES.includes(r.type))
    .sort((a, b) => (a.type === 'main' ? -1 : b.type === 'main' ? 1 : a.domain.localeCompare(b.domain)));
  const ownDomain = (scope, domain) => {
    const row = statsDomains(scope).find((r) => r.domain === domain);
    if (!row) throw notFound(`Domain "${domain}"`);
    return row;
  };
  const jobsFor = (username) => ['running', 'queued'].flatMap((status) => ctx.jobs.list({ type: STATS_JOB, status, limit: 200 })).filter((j) => j.params?.username === username);
  const lastRequestFor = (username, domain) => ctx.jobs.list({ type: STATS_JOB, limit: 500 }).find((j) => j.params?.username === username && j.params?.domain === domain) || null;
  const sqliteMs = (ts) => (ts ? Date.parse(`${String(ts).replace(' ', 'T')}Z`) : NaN);

  async function detect() {
    const d = await ctx.agent.op('stats.goaccess.detect', {});
    if (!d?.installed) throw new CapabilityError('goaccess', 'GoAccess is not installed on this server, so visitor statistics cannot be generated');
    return { installed: true, version: d.version ?? null };
  }

  async function readSummary(scope, domain) {
    const paths = statsPaths(homeOf(ctx, scope.account), domain);
    try {
      const r = await ctx.agent.op('files.read', { username: scope.username, path: paths.summary, maxBytes: SUMMARY_MAX_BYTES });
      if (r.binary || r.truncated || !r.content) return { summary: null, error: 'unreadable' };
      const parsed = JSON.parse(r.content);
      if (!parsed || typeof parsed !== 'object' || parsed.domain !== domain || !parsed.totals) return { summary: null, error: 'unreadable' };
      // Server-side log paths stay out of the customer's view.
      const { logFiles, ...summary } = parsed;
      return { summary, error: null };
    } catch (err) {
      if (err?.code === 'not_found') return { summary: null, error: null };
      if (err instanceof SyntaxError) return { summary: null, error: 'unreadable' };
      return { summary: null, error: err?.message || String(err) };
    }
  }

  // The scheduled run covers every active account whose plan includes the
  // feature; a per-account request names the account (and domain).
  async function runAccount(job, account, domains, counters) {
    for (const domain of domains) {
      try {
        const r = await ctx.agent.op('stats.goaccess.run', { username: account.username, domain });
        if (r.skipped) { counters.skipped++; job.log(`${account.username}/${domain}: skipped (${r.reason})`); } else { counters.generated++; job.log(`${account.username}/${domain}: ${r.totals?.requests ?? 0} requests, ${r.totals?.visitors ?? 0} visitors`); }
      } catch (err) {
        if (err?.code === 'capability_missing' || err?.code === 'binary_not_found') throw err;
        counters.failed++;
        job.log(`${account.username}/${domain}: ${err?.message || err}`, 'warn');
      }
    }
  }

  return {
    async summary(scope) {
      assertFeature(scope, STATS_FEATURE);
      const goaccess = await detect();
      const active = jobsFor(scope.username);
      const domains = await Promise.all(statsDomains(scope).map(async (row) => {
        const { summary, error } = await readSummary(scope, row.domain);
        const job = active.find((j) => !j.params?.domain || j.params.domain === row.domain) || null;
        const last = lastRequestFor(scope.username, row.domain);
        const retryAt = last ? sqliteMs(last.created_at) + cooldownMs() : NaN;
        return {
          domain: row.domain, type: row.type, available: Boolean(summary), generatedAt: summary?.generatedAt ?? null, error,
          running: job ? { id: job.id, status: job.status } : null,
          cooldownUntil: Number.isFinite(retryAt) && retryAt > Date.now() ? new Date(retryAt).toISOString() : null,
          summary,
        };
      }));
      return { goaccess, cooldownSeconds: Math.round(cooldownMs() / 1000), schedule: STATS_SCHEDULE.cron, domains };
    },

    async generate(scope, domain, req) {
      assertFeature(scope, STATS_FEATURE);
      ownDomain(scope, domain);
      await detect();
      // One generation per account at a time, whichever domain it covers.
      const running = jobsFor(scope.username)[0];
      if (running) throw new HttpError(409, 'busy', `Statistics for ${running.params?.domain || 'this account'} are already being generated (job ${running.id})`);
      const last = lastRequestFor(scope.username, domain);
      const retryAt = last ? sqliteMs(last.created_at) + cooldownMs() : NaN;
      if (Number.isFinite(retryAt) && retryAt > Date.now()) {
        const seconds = Math.ceil((retryAt - Date.now()) / 1000);
        throw new HttpError(429, 'generate_cooldown', `Statistics for ${domain} were generated recently; try again in ${seconds} second${seconds === 1 ? '' : 's'}`, { retryAfterSeconds: seconds });
      }
      const job = ctx.jobs.enqueue(STATS_JOB, { username: scope.username, accountId: scope.accountId, domain, actor: scope.actor?.username ?? null }, { userId: scope.actor?.id || null });
      audit(req, { action: 'panel.stats.generate', target: scope.username, args: auditArgs(scope, { domain, job: job.id }) });
      return { job: { id: job.id }, domain };
    },

    async run(job) {
      const { username, accountId, domain } = job.params || {};
      const counters = { accounts: 0, generated: 0, skipped: 0, failed: 0 };
      if (username) {
        const account = db().prepare('SELECT id, username, domain FROM accounts WHERE id = ? AND username = ?').get(accountId, username);
        if (!account) throw new Error(`Account "${username}" no longer exists`);
        counters.accounts = 1;
        await runAccount(job, account, [domain], counters);
        return counters;
      }
      if (ctx.panel?.settings?.enabled && !ctx.panel.settings.enabled()) return { ...counters, skipped: 'panel_disabled' };
      // The nightly schedule exists on every host: without GoAccess the run
      // ends here, before any account is walked or an error logged.
      try { await detect(); } catch (err) {
        if (!(err instanceof CapabilityError)) throw err;
        job.log('GoAccess is not installed on this server; nothing to generate', 'warn');
        return { ...counters, skipped: 'goaccess_missing' };
      }
      const accounts = db().prepare('SELECT id, username, domain, plan_snapshot_json FROM accounts WHERE suspended = 0 ORDER BY username').all();
      const domainRows = db().prepare('SELECT domain FROM account_domains WHERE account_id = ? AND type IN (?, ?, ?) ORDER BY domain');
      for (const account of accounts) {
        let plan = {};
        try { plan = JSON.parse(account.plan_snapshot_json || '{}') || {}; } catch { plan = {}; }
        if (plan.features && plan.features[STATS_FEATURE] === false) continue;
        const domains = [...new Set([account.domain, ...domainRows.all(account.id, ...STATS_DOMAIN_TYPES).map((r) => r.domain)])].filter(Boolean);
        counters.accounts++;
        try {
          await runAccount(job, account, domains, counters);
        } catch (err) {
          job.log(`stopping: ${err.message}`, 'error');
          return { ...counters, skipped: 'goaccess_missing' };
        }
      }
      job.progress(100, `${counters.generated} report(s) generated`);
      return counters;
    },

    // The report is customer-generated HTML: it is streamed as the account
    // with a sandbox CSP and is only ever framed by the panel's own origin.
    async report(scope, domain, req, res) {
      assertFeature(scope, STATS_FEATURE);
      ownDomain(scope, domain);
      const { html } = statsPaths(homeOf(ctx, scope.account), domain);
      const read = (offset) => ctx.agent.op('files.chunk_read', { username: scope.username, path: html, offset, length: REPORT_CHUNK }, { req });
      let part;
      try { part = await read(0); } catch (err) {
        if (err?.code === 'not_found') throw notFound(`A visitors report for "${domain}"`);
        throw err;
      }
      res.status(200);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts; frame-ancestors 'self'");
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Length', String(part.size));
      for (;;) {
        const chunk = Buffer.from(part.data || '', 'base64');
        if (chunk.length && !res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
        if (part.eof || !chunk.length) break;
        try { part = await read(part.offset + chunk.length); } catch (err) { res.destroy(err); return; }
      }
      res.end();
    },
  };
}
