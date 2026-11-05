import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { HttpError, CapabilityError, notFound, conflict, unprocessable } from '../lib/errors.js';
import { assertFeature, auditArgs } from './panel-domains.js';

// WordPress from the account panel (design P1-7). The service pins every
// install under one of the account's document roots, takes the database and
// its user from panel-databases (plan quota, prefix, audit), and runs the
// long part as a job: WP-CLI (`web.wp.install`) when the host has it,
// otherwise the panel's own path — `web.wp.fetch` (release archive, checksum,
// size limit, unpacked as the account), `web.wp.configure` (wp-config.php) and
// `web.wp.webinstall` (the installer's own step over loopback). Installs are
// detected from wp-config.php (`web.wp.discover`), never from SQLite, so a
// site uploaded by hand is listed and removable too. Feature `wordpress`.
//
//   panelSoftware.list / install / update / remove / getJob / streamJob

export const FEATURE = 'wordpress';
export const JOB_INSTALL = 'panel.wp.install';
export const JOB_UPDATE = 'panel.wp.update';
export const JOB_TYPES = [JOB_INSTALL, JOB_UPDATE];
export const WEB_TYPES = ['main', 'addon', 'sub'];
export const WP_PATH_RE = /^(?!-)[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
export const WP_PATH_MESSAGE = 'A folder below the domain\'s document root: letters, digits, ".", "_" and "-" separated by "/", no ".."';
export const wpPath = z.string().max(200).regex(WP_PATH_RE, WP_PATH_MESSAGE).refine((p) => !p.split('/').some((s) => s === '..' || s === '.'), WP_PATH_MESSAGE);
export const WP_ADMIN_USER = /^[a-z0-9][a-z0-9._@-]{0,59}$/i;
export const WP_TITLE = /^[^\0\r\n]{1,120}$/;
export const WP_LOCALE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
export const DB_BASE = 'wp';
export const INSTALL_HINT = 'Install WP-CLI (https://wp-cli.org) on the server, or PHP with its MySQL driver (php-mysql) and unzip, then try again';
const ACTIVE_JOB = ['queued', 'running'];
const FINISHED_JOB = ['done', 'failed', 'cancelled'];
const SECRET_PARAMS = ['adminPasswordEnc', 'dbPasswordEnc'];

// A stable id for an install that has no row: the first 16 hex of the
// sha256 of its absolute path, which only this account's docroots can name.
export const installIdOf = (absPath) => crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
export const INSTALL_ID_RE = /^[a-f0-9]{16}$/;

export function createPanelSoftwareService(ctx) {
  const { db } = ctx;
  const stmts = {
    account: db.prepare('SELECT id, username, owner_id, home_dir, domain FROM accounts WHERE id = ? AND username = ?'),
    ownerById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
    dbByName: db.prepare('SELECT name FROM databases WHERE name = ? AND account_id = ?'),
    dbUserByName: db.prepare('SELECT name FROM db_users WHERE name = ? AND account_id = ?'),
  };
  const agent = () => ctx.agent;
  const op = (name, args, req) => agent().op(name, args, { req });
  const domains = () => { if (!ctx.panelDomains) throw new HttpError(503, 'service_unavailable', 'The panel domains service is not loaded'); return ctx.panelDomains; };
  const databases = () => { if (!ctx.panelDatabases) throw new CapabilityError('mysql', 'Database Services are not available'); return ctx.panelDatabases; };
  const audit = (req, scope, action, args = {}, result) => {
    const entry = { action, target: scope.username, args: auditArgs(scope, args), ...(result ? { result } : {}) };
    if (req?.audit) req.audit(entry); else ctx.auditRecord?.(req ?? null, entry);
  };
  const isAgentCode = (err, codes) => Boolean(err?.agentError) && codes.includes(err.code);

  function requireScopeShape(scope) {
    if (!scope?.username || !scope.accountId) throw new HttpError(403, 'panel_scope_required', 'No hosting account is bound to this session');
    assertFeature(scope, FEATURE);
  }
  function home(scope) {
    const dir = scope.account?.home_dir;
    if (!dir || !path.isAbsolute(dir)) throw new HttpError(409, 'no_home', 'This account has no home directory on the server yet');
    return path.resolve(dir);
  }
  function sites(scope) {
    const base = home(scope);
    return domains().allDomains(scope)
      .filter((r) => WEB_TYPES.includes(r.type) && r.docroot)
      .map((r) => ({ domain: r.domain, type: r.type, docroot: path.resolve(r.docroot) }))
      .filter((r) => r.docroot === base || r.docroot.startsWith(`${base}/`));
  }
  const scheme = (domain) => (typeof ctx.ssl?.certForDomain === 'function' && ctx.ssl.certForDomain(domain)?.state === 'installed' ? 'https' : 'http');
  const urlOf = (domain, rel) => `${scheme(domain)}://${domain}${rel ? `/${rel.split('/').map(encodeURIComponent).join('/')}` : ''}`;

  // The site directory for a domain plus a folder below its document root,
  // pinned under that docroot and the home (422 otherwise; a foreign domain
  // is 404, never 403).
  function resolveSite(scope, domain, rel = '') {
    const site = sites(scope).find((s) => s.domain === domain);
    if (!site) throw notFound(`Domain "${domain}"`);
    const clean = String(rel ?? '').replace(/^\/+|\/+$/g, '');
    if (clean && (!WP_PATH_RE.test(clean) || clean.split('/').some((s) => s === '..' || s === '.'))) throw unprocessable('Request validation failed', { path: [WP_PATH_MESSAGE] });
    const abs = path.resolve(site.docroot, clean);
    if (abs !== site.docroot && !abs.startsWith(`${site.docroot}/`)) throw unprocessable('Request validation failed', { path: ['The folder must stay inside the document root'] });
    const under = path.relative(site.docroot, abs);
    return { domain, type: site.type, docroot: site.docroot, abs, rel: path.relative(home(scope), abs), under, url: urlOf(domain, under), isDocroot: abs === site.docroot };
  }

  // The deepest document root that holds an install decides its domain.
  function siteFor(scope, absPath) {
    const roots = sites(scope).filter((s) => absPath === s.docroot || absPath.startsWith(`${s.docroot}/`)).sort((a, b) => b.docroot.length - a.docroot.length);
    return roots[0] || null;
  }

  async function requirements(req) {
    try {
      const r = await op('web.wp.requirements', {}, req);
      const canInstall = Boolean(r.asUser && (r.wpcli || (r.php && r.phpMysql && r.unzip)));
      return { ...r, canInstall, hint: canInstall ? null : INSTALL_HINT };
    } catch (err) {
      if (isAgentCode(err, ['capability_missing', 'binary_not_found', 'unknown_op'])) return { wpcli: false, php: false, phpMysql: null, unzip: false, asUser: false, canInstall: false, hint: INSTALL_HINT };
      throw err;
    }
  }

  async function discover(scope, req) {
    let r;
    try { r = await op('web.wp.discover', { usernames: [scope.username] }, req); } catch (err) {
      if (isAgentCode(err, ['not_found'])) return [];
      throw err;
    }
    const out = [];
    for (const i of r?.installs || []) {
      const abs = path.resolve(i.path);
      const site = siteFor(scope, abs);
      if (!site) continue;
      const under = path.relative(site.docroot, abs);
      out.push({
        id: installIdOf(abs), abs, path: path.relative(home(scope), abs), domain: site.domain, under, url: urlOf(site.domain, under), adminUrl: `${urlOf(site.domain, under)}/wp-admin/`,
        version: i.version ?? null, database: i.dbName ?? null, dbUser: i.dbUser ?? null, dbHost: i.dbHost ?? null, tablePrefix: i.tablePrefix ?? null, isDocroot: abs === site.docroot,
        databaseOwned: Boolean(i.dbName && stmts.dbByName.get(i.dbName, scope.accountId)),
      });
    }
    return out.sort((a, b) => a.url.localeCompare(b.url));
  }

  const publicRow = ({ abs: _abs, ...row }) => row;

  async function installOf(scope, id, req) {
    const row = (await discover(scope, req)).find((r) => r.id === id);
    if (!row) throw notFound('WordPress installation');
    return row;
  }

  async function list(scope, req) {
    requireScopeShape(scope);
    const [reqs, installs] = await Promise.all([requirements(req), discover(scope, req)]);
    const base = home(scope);
    return {
      data: installs.map(publicRow),
      meta: {
        total: installs.length, requirements: reqs, canInstall: reqs.canInstall, hint: reqs.hint, updates: reqs.wpcli,
        sites: sites(scope).map((s) => ({ domain: s.domain, type: s.type, docroot: path.relative(base, s.docroot) || '.' })),
        prefix: `${scope.username}_`,
      },
    };
  }

  async function install(scope, input, req) {
    requireScopeShape(scope);
    const site = resolveSite(scope, input.domain, input.path);
    const existing = (await discover(scope, req)).find((r) => r.abs === site.abs);
    if (existing) throw conflict(`${site.rel} already holds a WordPress installation`);
    const reqs = await requirements(req);
    if (!reqs.canInstall) throw new CapabilityError('wordpress', `WordPress cannot be installed on this server yet: ${INSTALL_HINT}`);
    const generated = !input.adminPassword;
    const adminPassword = input.adminPassword || ctx.crypto.randomPassword(20);
    const created = await databases().createForApp(scope, { base: DB_BASE }, req);
    const dbHost = created.hosts.includes('localhost') ? 'localhost' : created.hosts[0] || 'localhost';
    const method = reqs.wpcli ? 'wpcli' : 'web';
    const params = {
      accountId: scope.accountId, username: scope.username, ownerId: scope.ownerPrincipal?.id ?? null, actor: scope.actor?.username ?? null,
      domain: site.domain, path: site.abs, rel: site.rel, url: site.url, isDocroot: site.isDocroot, method,
      title: input.title, adminUser: input.adminUser, adminEmail: input.adminEmail, locale: input.locale || 'en_US',
      adminPasswordEnc: ctx.crypto.encrypt(adminPassword), dbName: created.database, dbUser: created.user, dbPasswordEnc: ctx.crypto.encrypt(created.password), dbHost, tablePrefix: 'wp_',
    };
    const job = ctx.jobs.enqueue(JOB_INSTALL, params, { userId: scope.actor?.id || null });
    audit(req, scope, 'panel.wp.install', { domain: site.domain, path: site.rel, url: site.url, database: created.database, dbUser: created.user, adminUser: input.adminUser, method, job: job.id });
    return {
      job: { id: job.id }, id: installIdOf(site.abs), domain: site.domain, path: site.rel, url: site.url, adminUrl: `${site.url}/wp-admin/`, database: created.database, dbUser: created.user,
      adminUser: input.adminUser, adminEmail: input.adminEmail, method, generatedPassword: generated, ...(generated ? { adminPassword } : {}),
    };
  }

  // The job acts for the account's owner, read back at run time (as the dump
  // job does): a missing or changed owner fails the job instead of falling
  // back to a root principal.
  function jobScope(params) {
    const account = stmts.account.get(params.accountId, params.username);
    if (!account) throw new Error(`Account "${params.username}" no longer exists`);
    const owner = params.ownerId != null ? stmts.ownerById.get(params.ownerId) : null;
    if (!owner) throw new Error(`The owner of account "${params.username}" no longer exists; start the install again`);
    if (account.owner_id !== owner.id) throw new Error(`Account "${params.username}" changed owner since the job was queued; start it again`);
    const req = { user: { id: owner.id, username: owner.username, role: owner.role }, ip: null, id: null };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    const scope = { account, accountId: account.id, username: account.username, mode: 'job', actor: null, actingAs: null, owner, ownerPrincipal: req.user, limits: {}, features: {} };
    return { scope, req };
  }

  async function runInstall(job) {
    const p = job.params;
    const { scope, req } = jobScope(p);
    const site = `${p.domain}${p.rel ? ` (${p.rel})` : ''}`;
    const dbPassword = ctx.crypto.decrypt(p.dbPasswordEnc);
    const adminPassword = ctx.crypto.decrypt(p.adminPasswordEnc);
    job.log(`Installing WordPress for ${p.username} at ${p.url} with database ${p.dbName}`);
    let fetched = false;
    try {
      let version = null;
      if (p.method === 'wpcli') {
        job.progress(10, 'WP-CLI: downloading, configuring and installing');
        const r = await agent().op('web.wp.install', { username: p.username, path: p.path, url: p.url, title: p.title, adminUser: p.adminUser, adminEmail: p.adminEmail, adminPassword, dbName: p.dbName, dbUser: p.dbUser, dbPassword, dbHost: p.dbHost, tablePrefix: p.tablePrefix, locale: p.locale });
        version = r.version ?? null;
        if (r.warning) job.log(r.warning, 'warn');
      } else {
        job.progress(10, 'Downloading the WordPress release');
        const f = await agent().op('web.wp.fetch', { username: p.username, path: p.path });
        fetched = true;
        version = f.version ?? null;
        job.log(`Unpacked WordPress ${version || ''} (${f.members} entries, ${f.bytes} bytes, sha1 ${f.sha1})`.replace(/\s+/g, ' '));
        job.progress(55, 'Writing wp-config.php');
        await agent().op('web.wp.configure', { username: p.username, path: p.path, dbName: p.dbName, dbUser: p.dbUser, dbPassword, dbHost: p.dbHost, tablePrefix: p.tablePrefix });
        job.progress(70, 'Running the WordPress installer');
        const w = await agent().op('web.wp.webinstall', { username: p.username, path: p.path, url: p.url, title: p.title, adminUser: p.adminUser, adminEmail: p.adminEmail, adminPassword, locale: p.locale });
        version = w.version ?? version;
      }
      job.progress(100, 'done');
      const result = { id: installIdOf(p.path), domain: p.domain, path: p.rel, url: p.url, adminUrl: `${p.url}/wp-admin/`, version, database: p.dbName, dbUser: p.dbUser, adminUser: p.adminUser, method: p.method };
      audit(req, scope, 'panel.wp.install.done', { domain: p.domain, path: p.rel, url: p.url, version, database: p.dbName, method: p.method, job: job.job.id });
      job.log(`WordPress is ready at ${p.url}; sign in at ${p.url}/wp-admin/`);
      return result;
    } catch (err) {
      const cleanup = await compensate(p, { scope, req, fetched, err }, job);
      audit(req, scope, 'panel.wp.install.failed', { domain: p.domain, path: p.rel, database: p.dbName, method: p.method, job: job.job.id, reason: err.message, cleanup }, 'error');
      throw err;
    }
  }

  // A failed install leaves nothing behind: files the panel unpacked go (as
  // the account, through web.wp.remove; the agent's own cleanup is reported
  // in the error details when the failure was inside fetch/install), then the
  // database user and database created for it (user first, it holds the
  // grants) so the same names are free for the retry.
  async function compensate(p, { scope, req, fetched, err }, job) {
    const notes = [];
    const agentCleanup = err?.details?.cleanup;
    if (typeof agentCleanup === 'string' && agentCleanup) {
      notes.push(`files: ${agentCleanup}`);
      job.log(`files: ${agentCleanup}`, /left in place/i.test(agentCleanup) ? 'warn' : 'info');
    } else if (fetched || p.method === 'wpcli') {
      try {
        const r = await agent().op('web.wp.remove', { username: p.username, path: p.path, mode: p.isDocroot ? 'entries' : 'tree' });
        notes.push(`removed ${r.removed.length} entr${r.removed.length === 1 ? 'y' : 'ies'} from ${p.rel}`);
        job.log(`removed the unpacked files from ${p.rel}`);
      } catch (rmErr) {
        if (!(rmErr?.agentError && rmErr.code === 'not_found')) { notes.push(`files in ${p.rel} could not be removed: ${rmErr.message}`); job.log(`the files in ${p.rel} could not be removed: ${rmErr.message}`, 'warn'); }
      }
    }
    const steps = [['user', p.dbUser, (name) => databases().dropUser(scope, name, req)], ['database', p.dbName, (name) => databases().drop(scope, name, req)]];
    for (const [kind, name, drop] of steps) {
      if (!name) continue;
      try { await drop(name); notes.push(`dropped ${kind} ${name}`); job.log(`dropped the ${kind} ${name} created for this install`); } catch (dropErr) {
        notes.push(`could not drop ${kind} ${name}: ${dropErr.message}`);
        job.log(`could not drop the ${kind} ${name}: ${dropErr.message}`, 'warn');
      }
    }
    return notes.join('; ') || null;
  }

  async function update(scope, id, req) {
    requireScopeShape(scope);
    const row = await installOf(scope, id, req);
    const reqs = await requirements(req);
    if (!reqs.wpcli) throw new CapabilityError('wpcli', 'Updating WordPress from the panel needs WP-CLI on the server; ask your hosting provider to install it (https://wp-cli.org), or update from the WordPress dashboard');
    const params = { accountId: scope.accountId, username: scope.username, ownerId: scope.ownerPrincipal?.id ?? null, actor: scope.actor?.username ?? null, domain: row.domain, path: row.abs, rel: row.path, url: row.url, fromVersion: row.version };
    const job = ctx.jobs.enqueue(JOB_UPDATE, params, { userId: scope.actor?.id || null });
    audit(req, scope, 'panel.wp.update', { domain: row.domain, path: row.path, fromVersion: row.version, job: job.id });
    return { job: { id: job.id }, id, domain: row.domain, path: row.path, fromVersion: row.version };
  }

  async function runUpdate(job) {
    const p = job.params;
    const { scope, req } = jobScope(p);
    job.progress(10, 'wp core update');
    const r = await agent().op('web.wp.update', { username: p.username, path: p.path, kind: 'core' });
    job.progress(100, 'done');
    audit(req, scope, 'panel.wp.update.done', { domain: p.domain, path: p.rel, fromVersion: p.fromVersion, databaseUpdated: r.databaseUpdated ?? null, job: job.job.id });
    return { id: installIdOf(p.path), domain: p.domain, path: p.rel, fromVersion: p.fromVersion, output: r.output ?? null, databaseUpdated: r.databaseUpdated ?? null };
  }

  async function remove(scope, id, { database = false } = {}, req) {
    requireScopeShape(scope);
    const row = await installOf(scope, id, req);
    const r = await op('web.wp.remove', { username: scope.username, path: row.abs, mode: row.isDocroot ? 'entries' : 'tree' }, req);
    let droppedDatabase = null;
    let droppedUser = null;
    // Only objects of this account go, and the user only when it is the
    // install's own (same name as the database, the panel's convention).
    if (database && row.database && row.databaseOwned) {
      if (row.dbUser === row.database && stmts.dbUserByName.get(row.dbUser, scope.accountId)) {
        try { await databases().dropUser(scope, row.dbUser, req); droppedUser = row.dbUser; } catch (err) { ctx.logger?.warn?.({ err, user: row.dbUser }, 'wordpress: database user not dropped'); }
      }
      await databases().drop(scope, row.database, req);
      droppedDatabase = row.database;
    }
    audit(req, scope, 'panel.wp.remove', { domain: row.domain, path: row.path, mode: r.mode, files: r.removed.length, database: droppedDatabase, dbUser: droppedUser });
    return { id, domain: row.domain, path: row.path, removed: true, files: r.removed, database: droppedDatabase, dbUser: droppedUser, databaseKept: database ? null : row.database };
  }

  // The account's own install/update jobs (/api/system/jobs is reseller-only);
  // anything else is 404 so job ids stay unguessable. Encrypted secrets never
  // leave the job record.
  function jobOf(scope, id) {
    const job = ctx.jobs.get(id);
    if (!JOB_TYPES.includes(job.type) || job.params?.accountId !== scope.accountId) throw notFound('Job');
    return job;
  }
  function shapeJob(job) {
    const params = { ...(job.params ?? {}) };
    for (const k of [...SECRET_PARAMS, 'ownerId', 'accountId']) delete params[k];
    return { id: job.id, type: job.type, status: job.status, progress: job.progress, message: job.message, params, result: job.result ?? null, error: job.error ?? null, errorCode: job.error_code ?? null, createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at, ...(job.logs ? { logs: job.logs } : {}) };
  }
  function getJob(scope, id) {
    requireScopeShape(scope);
    return shapeJob(jobOf(scope, id));
  }
  function streamJob(scope, id, req, res) {
    requireScopeShape(scope);
    const job = shapeJob(jobOf(scope, id));
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'snapshot', job });
    if (!ACTIVE_JOB.includes(job.status)) { res.end(); return; }
    const unsubscribe = ctx.jobs.subscribe(job.id, (event) => { send(event); if (FINISHED_JOB.includes(event.type)) { unsubscribe(); res.end(); } });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  }

  return { list, install, update, remove, runInstall, runUpdate, getJob, streamJob, resolveSite, requirements, sites };
}
