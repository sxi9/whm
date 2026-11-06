import crypto from 'node:crypto';
import path from 'node:path';
import { HttpError, CapabilityError, notFound, conflict, unprocessable } from '../lib/errors.js';
import { assertFeature, auditArgs } from './panel-domains.js';
import { installIdOf, WP_PATH_RE, WP_PATH_MESSAGE } from './panel-software.js';

// One-click installers beyond WordPress (Phase 8 P5-2): a small catalog of
// web applications the account can drop onto one of its document roots. The
// release pins (version, https URL, SHA-256) live in the agent
// (`agent/src/ops/app-install.js`, read back through `web.app.catalog`) so the
// panel process never names an archive; this file holds what the page shows
// and what each app needs from the form. Same pipeline as WordPress: the
// database and its user come from panel-databases, `web.app.fetch` downloads
// and unpacks as the account, then the app's own setup runs — Joomla's CLI
// installer (`web.app.joomla.install`) finishes the site; Drupal has no
// non-interactive installer without Composer, so `web.app.drupal.configure`
// writes settings.php with the database and the page links to the web
// installer, which then skips its database step. Installs are detected from
// the trees (`web.app.discover`), never from SQLite. Feature `installers`.
//
//   panelInstallers.list / install / remove / getJob / streamJob

export const FEATURE = 'installers';
export const JOB_INSTALL = 'panel.app.install';
export const JOB_TYPES = [JOB_INSTALL];
export const WEB_TYPES = ['main', 'addon', 'sub'];
export const INSTALL_HINT = 'Install PHP with its MySQL driver (php-mysql), unzip and tar on the server, then try again';
export const APPS = Object.freeze({
  joomla: Object.freeze({
    id: 'joomla', name: 'Joomla', dbBase: 'joomla', finish: 'cli', adminPath: 'administrator/', site: 'https://www.joomla.org/',
    description: 'A full content management system with a built-in administrator, templates and thousands of extensions.',
    fields: ['title', 'adminUser', 'adminEmail', 'adminPassword'], passwordMin: 12,
  }),
  drupal: Object.freeze({
    id: 'drupal', name: 'Drupal', dbBase: 'drupal', finish: 'web', adminPath: 'user/login', installPath: 'core/install.php', site: 'https://www.drupal.org/',
    description: 'A flexible framework-style CMS for structured content; the site name and administrator are chosen in its own installer.',
    fields: [], passwordMin: null,
  }),
});
export const APP_IDS = Object.keys(APPS);
const ACTIVE_JOB = ['queued', 'running'];
const FINISHED_JOB = ['done', 'failed', 'cancelled'];
const SECRET_PARAMS = ['adminPasswordEnc', 'dbPasswordEnc'];
const CATALOG_TTL_MS = 10 * 60 * 1000;

export const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
export function randomTablePrefix() {
  const bytes = crypto.randomBytes(5);
  let out = PREFIX_ALPHABET[bytes[0] % 26];
  const symbols = `${PREFIX_ALPHABET}0123456789`;
  for (let i = 1; i < 5; i++) out += symbols[bytes[i] % symbols.length];
  return `${out}_`;
}

// '8.5.0' satisfies '8.3'; an unknown host version is not a refusal (the
// install tells the truth when php refuses the code).
export function phpSatisfies(have, need) {
  if (!have || !need) return true;
  const a = String(have).split('.').map(Number);
  const b = String(need).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

export function createPanelInstallersService(ctx) {
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
  let catalogCache = { at: 0, apps: null };

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
  const appOf = (id) => { const app = APPS[id]; if (!app) throw notFound(`Application "${id}"`); return app; };
  const adminUrlOf = (app, url) => `${url}/${APPS[app].adminPath}`;
  const installUrlOf = (app, url) => (APPS[app].installPath ? `${url}/${APPS[app].installPath}` : null);

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

  function siteFor(scope, absPath) {
    const roots = sites(scope).filter((s) => absPath === s.docroot || absPath.startsWith(`${s.docroot}/`)).sort((a, b) => b.docroot.length - a.docroot.length);
    return roots[0] || null;
  }

  async function requirements(req) {
    try {
      const r = await op('web.app.requirements', {}, req);
      const canInstall = Boolean(r.asUser && r.php && r.phpMysql && r.unzip && r.tar);
      return { ...r, canInstall, hint: canInstall ? null : INSTALL_HINT };
    } catch (err) {
      if (isAgentCode(err, ['capability_missing', 'binary_not_found', 'unknown_op'])) return { php: false, phpVersion: null, phpMysql: null, unzip: false, tar: false, asUser: false, canInstall: false, hint: INSTALL_HINT };
      throw err;
    }
  }

  async function releases(req) {
    if (catalogCache.apps && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.apps;
    let apps = {};
    try { apps = (await op('web.app.catalog', {}, req))?.apps || {}; } catch (err) {
      if (!isAgentCode(err, ['capability_missing', 'binary_not_found', 'unknown_op'])) throw err;
    }
    catalogCache = { at: Date.now(), apps };
    return apps;
  }

  async function catalog(req, reqs) {
    const pins = await releases(req);
    return APP_IDS.map((id) => {
      const app = APPS[id];
      const pin = pins[id] || null;
      const supported = Boolean(pin) && phpSatisfies(reqs.phpVersion, pin.requires?.php);
      return {
        id, name: app.name, description: app.description, site: app.site, finish: app.finish, fields: app.fields, passwordMin: app.passwordMin, adminPath: app.adminPath, installPath: app.installPath ?? null,
        version: pin?.version ?? null, url: pin?.url ?? null, sha256: pin?.sha256 ?? null, bytes: pin?.bytes ?? null, requires: pin?.requires ?? null,
        available: Boolean(pin), supported, canInstall: reqs.canInstall && supported,
        hint: !pin ? 'The server does not know this release yet; ask your hosting provider to update the panel' : !supported ? `${app.name} ${pin.version} needs PHP ${pin.requires.php} or newer on the server (it has ${reqs.phpVersion || 'none'})` : reqs.hint,
      };
    });
  }

  async function discover(scope, req) {
    let r;
    try { r = await op('web.app.discover', { usernames: [scope.username] }, req); } catch (err) {
      if (isAgentCode(err, ['not_found'])) return [];
      throw err;
    }
    const out = [];
    for (const i of r?.installs || []) {
      if (!APPS[i.app]) continue;
      const abs = path.resolve(i.path);
      const site = siteFor(scope, abs);
      if (!site) continue;
      const under = path.relative(site.docroot, abs);
      const url = urlOf(site.domain, under);
      out.push({
        id: installIdOf(abs), abs, app: i.app, name: APPS[i.app].name, path: path.relative(home(scope), abs), domain: site.domain, under, url, adminUrl: adminUrlOf(i.app, url),
        installUrl: i.app === 'drupal' && i.pendingInstaller ? installUrlOf(i.app, url) : null,
        version: i.version ?? null, database: i.dbName ?? null, dbUser: i.dbUser ?? null, dbHost: i.dbHost ?? null, dbPrefix: i.dbPrefix ?? null, configured: Boolean(i.configured), isDocroot: abs === site.docroot,
        databaseOwned: Boolean(i.dbName && stmts.dbByName.get(i.dbName, scope.accountId)),
      });
    }
    return out.sort((a, b) => a.url.localeCompare(b.url));
  }

  const publicRow = ({ abs: _abs, ...row }) => row;

  async function installOf(scope, id, req) {
    const row = (await discover(scope, req)).find((r) => r.id === id);
    if (!row) throw notFound('Installation');
    return row;
  }

  async function list(scope, req) {
    requireScopeShape(scope);
    const [reqs, installs] = await Promise.all([requirements(req), discover(scope, req)]);
    const base = home(scope);
    return {
      data: installs.map(publicRow),
      meta: {
        total: installs.length, requirements: reqs, canInstall: reqs.canInstall, hint: reqs.hint, catalog: await catalog(req, reqs),
        sites: sites(scope).map((s) => ({ domain: s.domain, type: s.type, docroot: path.relative(base, s.docroot) || '.' })),
        prefix: `${scope.username}_`,
      },
    };
  }

  // The form fields an app needs are checked here (the route accepts the
  // union): a missing one is a 422 naming the field, like any validation.
  function requireFields(app, input) {
    const fields = {};
    for (const f of app.fields) {
      const v = input[f];
      if (f === 'adminPassword') continue;
      if (v == null || String(v).trim() === '') fields[f] = ['Required'];
    }
    if (app.fields.includes('adminPassword') && input.adminPassword && app.passwordMin && input.adminPassword.length < app.passwordMin) fields.adminPassword = [`At least ${app.passwordMin} characters`];
    if (Object.keys(fields).length) throw unprocessable('Request validation failed', fields);
  }

  async function install(scope, appId, input, req) {
    requireScopeShape(scope);
    const app = appOf(appId);
    requireFields(app, input);
    const site = resolveSite(scope, input.domain, input.path);
    const existing = (await discover(scope, req)).find((r) => r.abs === site.abs);
    if (existing) throw conflict(`${site.rel} already holds a ${existing.name} installation`);
    const reqs = await requirements(req);
    const entry = (await catalog(req, reqs)).find((c) => c.id === appId);
    if (!entry.canInstall) throw new CapabilityError('installers', `${app.name} cannot be installed on this server yet: ${entry.hint}`);
    const wantsAdmin = app.fields.includes('adminPassword');
    const generated = wantsAdmin && !input.adminPassword;
    const adminPassword = wantsAdmin ? (input.adminPassword || ctx.crypto.randomPassword(20)) : null;
    const created = await databases().createForApp(scope, { base: app.dbBase }, req);
    const dbHost = created.hosts.includes('localhost') ? 'localhost' : created.hosts[0] || 'localhost';
    const dbPrefix = appId === 'joomla' ? randomTablePrefix() : '';
    const params = {
      accountId: scope.accountId, username: scope.username, ownerId: scope.ownerPrincipal?.id ?? null, actor: scope.actor?.username ?? null,
      app: appId, version: entry.version, domain: site.domain, path: site.abs, rel: site.rel, url: site.url, isDocroot: site.isDocroot,
      title: input.title ?? null, adminUser: input.adminUser ?? null, adminEmail: input.adminEmail ?? null,
      ...(adminPassword ? { adminPasswordEnc: ctx.crypto.encrypt(adminPassword) } : {}),
      dbName: created.database, dbUser: created.user, dbPasswordEnc: ctx.crypto.encrypt(created.password), dbHost, dbPrefix,
    };
    const job = ctx.jobs.enqueue(JOB_INSTALL, params, { userId: scope.actor?.id || null });
    audit(req, scope, 'panel.app.install', { app: appId, version: entry.version, domain: site.domain, path: site.rel, url: site.url, database: created.database, dbUser: created.user, adminUser: input.adminUser ?? null, job: job.id });
    return {
      job: { id: job.id }, id: installIdOf(site.abs), app: appId, name: app.name, version: entry.version, domain: site.domain, path: site.rel, url: site.url, adminUrl: adminUrlOf(appId, site.url), installUrl: installUrlOf(appId, site.url),
      database: created.database, dbUser: created.user, dbHost, finish: app.finish,
      ...(wantsAdmin ? { adminUser: input.adminUser, adminEmail: input.adminEmail, generatedPassword: generated, ...(generated ? { adminPassword } : {}) } : {}),
    };
  }

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
    const app = APPS[p.app];
    const { scope, req } = jobScope(p);
    const dbPassword = ctx.crypto.decrypt(p.dbPasswordEnc);
    job.log(`Installing ${app.name} ${p.version || ''} for ${p.username} at ${p.url} with database ${p.dbName}`.replace(/\s+/g, ' '));
    let fetched = false;
    try {
      job.progress(10, `Downloading the ${app.name} release and checking its SHA-256`);
      const f = await agent().op('web.app.fetch', { username: p.username, path: p.path, app: p.app });
      fetched = true;
      let version = f.version ?? p.version ?? null;
      job.log(`Unpacked ${app.name} ${version || ''} (${f.members} entries, ${f.bytes} bytes, sha256 ${f.sha256})`.replace(/\s+/g, ' '));
      let installUrl = null;
      let note = null;
      if (p.app === 'joomla') {
        job.progress(60, "Running Joomla's installer (database schema, administrator, configuration.php)");
        const r = await agent().op('web.app.joomla.install', { username: p.username, path: p.path, url: p.url, title: p.title, adminUser: p.adminUser, adminEmail: p.adminEmail, adminPassword: ctx.crypto.decrypt(p.adminPasswordEnc), dbName: p.dbName, dbUser: p.dbUser, dbPassword, dbHost: p.dbHost, dbPrefix: p.dbPrefix });
        version = r.version ?? version;
        if (r.warning) job.log(r.warning, 'warn');
      } else {
        job.progress(60, 'Writing sites/default/settings.php with the database');
        const r = await agent().op('web.app.drupal.configure', { username: p.username, path: p.path, dbName: p.dbName, dbUser: p.dbUser, dbPassword, dbHost: p.dbHost, dbPrefix: p.dbPrefix || '', trustedHosts: [p.domain, `www.${p.domain}`] });
        version = r.version ?? version;
        installUrl = `${p.url}/${r.installPath || app.installPath}`;
        note = `Open ${installUrl} to choose the language, the profile, the site name and the administrator; the database is already configured.`;
      }
      job.progress(100, 'done');
      const result = { id: installIdOf(p.path), app: p.app, name: app.name, domain: p.domain, path: p.rel, url: p.url, adminUrl: adminUrlOf(p.app, p.url), installUrl, version, database: p.dbName, dbUser: p.dbUser, adminUser: p.adminUser ?? null, finish: app.finish, note };
      audit(req, scope, 'panel.app.install.done', { app: p.app, domain: p.domain, path: p.rel, url: p.url, version, database: p.dbName, job: job.job.id });
      job.log(installUrl ? note : `${app.name} is ready at ${p.url}; sign in at ${adminUrlOf(p.app, p.url)}`);
      return result;
    } catch (err) {
      const cleanup = await compensate(p, { scope, req, fetched, err }, job);
      audit(req, scope, 'panel.app.install.failed', { app: p.app, domain: p.domain, path: p.rel, database: p.dbName, job: job.job.id, reason: err.message, cleanup }, 'error');
      throw err;
    }
  }

  // A failed install leaves nothing behind: the unpacked files go (as the
  // account; the agent's own cleanup is reported in the error details when the
  // failure was inside fetch), then the database user and the database.
  async function compensate(p, { scope, req, fetched, err }, job) {
    const notes = [];
    const agentCleanup = err?.details?.cleanup;
    if (typeof agentCleanup === 'string' && agentCleanup) {
      notes.push(`files: ${agentCleanup}`);
      job.log(`files: ${agentCleanup}`, /left in place/i.test(agentCleanup) ? 'warn' : 'info');
    } else if (fetched) {
      try {
        const r = await agent().op('web.app.remove', { username: p.username, path: p.path, app: p.app, mode: p.isDocroot ? 'entries' : 'tree' });
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

  async function remove(scope, id, { database = false } = {}, req) {
    requireScopeShape(scope);
    const row = await installOf(scope, id, req);
    const r = await op('web.app.remove', { username: scope.username, path: row.abs, app: row.app, mode: row.isDocroot ? 'entries' : 'tree' }, req);
    let droppedDatabase = null;
    let droppedUser = null;
    if (database && row.database && row.databaseOwned) {
      if (row.dbUser === row.database && stmts.dbUserByName.get(row.dbUser, scope.accountId)) {
        try { await databases().dropUser(scope, row.dbUser, req); droppedUser = row.dbUser; } catch (err) { ctx.logger?.warn?.({ err, user: row.dbUser }, 'installers: database user not dropped'); }
      }
      await databases().drop(scope, row.database, req);
      droppedDatabase = row.database;
    }
    audit(req, scope, 'panel.app.remove', { app: row.app, domain: row.domain, path: row.path, mode: r.mode, files: r.removed.length, database: droppedDatabase, dbUser: droppedUser });
    return { id, app: row.app, name: row.name, domain: row.domain, path: row.path, removed: true, files: r.removed, database: droppedDatabase, dbUser: droppedUser, databaseKept: database ? null : row.database };
  }

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

  return { list, install, remove, runInstall, getJob, streamJob, resolveSite, requirements, catalog, sites };
}
