import crypto from 'node:crypto';
import { HttpError, CapabilityError, notFound, conflict, unprocessable } from '../lib/errors.js';
import { assertFeature, auditArgs } from './panel-domains.js';
import { portRange } from './panel-apps.js';

// Web Disk of the account panel (contract §71): the account's home mounted
// over WebDAV by desktop and mobile clients. One `rclone serve webdav` runs as
// the account (agent webdisk.unit.*, unit keel-webdisk-<username> under
// /etc/whm/apps, a loopback port from the apps pool) and the hostname site
// proxies https://<hostname>/webdisk/<username>/ to it (ctx.web.hostApps). The
// password is bcrypt-hashed here; only the hash reaches the agent, which writes
// it as the account into ~/.keel/webdisk.htpasswd. rclone is installed on the
// first enable through a job (pkg.install), then the enable continues.
//
//   panelWebdisk.status / setEnabled / setPassword / clients / getJob / streamJob / runInstall
//   panelWebdisk.listAll()                    -> the admin Web Disk card
//   panelWebdisk.rewrite(username, req)       -> account-functions' rearrange job, after the home moved
//   panelWebdisk.removeAccount(username, id)  -> accounts.cleanupAccount, before the vhosts go

export const FEATURE = 'webdisk';
export const JOB_INSTALL = 'panel.webdisk.install';
export const JOB_TYPES = [JOB_INSTALL];
export const WEBDISK_PACKAGES = ['rclone'];
export const PROXY_MODULES = ['proxy', 'proxy_http', 'headers'];
export const PASSWORD_MIN_LENGTH = 8;
export const URL_PREFIX = '/webdisk';
export const CLIENTS = ['windows', 'macos', 'ios', 'android', 'linux'];
const FQDN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ACTIVE_JOB = ['queued', 'running'];
const FINISHED_JOB = ['done', 'failed', 'cancelled'];
const nowIso = () => new Date().toISOString();

// The hostname-site drop-in name: `webdisk-<username>` when that fits the
// host app name grammar (lowercase, "-", 32 chars), else a hashed form that
// cannot collide between two accounts.
export function appNameFor(username) {
  const plain = `webdisk-${username}`;
  if (/^[a-z][a-z0-9-]{0,31}$/.test(plain)) return plain;
  return `webdisk-${username.replace(/[^a-z0-9-]/g, '-').slice(0, 14)}-${crypto.createHash('sha256').update(username).digest('hex').slice(0, 8)}`;
}
export const aliasFor = (username) => `${URL_PREFIX}/${username}`;

export function createPanelWebdiskService(ctx) {
  const { db, settings, logger } = ctx;
  const stmts = {
    byAccount: db.prepare('SELECT * FROM panel_webdisk WHERE account_id = ?'),
    byLogin: db.prepare('SELECT * FROM panel_webdisk WHERE login = ?'),
    ports: db.prepare('SELECT port FROM panel_webdisk UNION SELECT port FROM panel_apps'),
    insert: db.prepare('INSERT INTO panel_webdisk (account_id, enabled, port, login, has_password, password_set_at, status) VALUES (?, 0, ?, ?, 0, NULL, ?)'),
    setPassword: db.prepare('UPDATE panel_webdisk SET has_password = 1, password_set_at = ?, updated_at = ? WHERE id = ?'),
    setEnabled: db.prepare('UPDATE panel_webdisk SET enabled = ?, status = ?, error = ?, updated_at = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE panel_webdisk SET status = ?, error = ?, updated_at = ? WHERE id = ?'),
    setPort: db.prepare('UPDATE panel_webdisk SET port = ?, updated_at = ? WHERE id = ?'),
    byUsername: db.prepare('SELECT w.* FROM panel_webdisk w JOIN accounts a ON a.id = w.account_id WHERE a.username = ?'),
    remove: db.prepare('DELETE FROM panel_webdisk WHERE account_id = ?'),
    listAll: db.prepare('SELECT w.*, a.username, a.domain FROM panel_webdisk w JOIN accounts a ON a.id = w.account_id ORDER BY a.username'),
    account: db.prepare('SELECT id, username, owner_id, home_dir, domain FROM accounts WHERE id = ? AND username = ?'),
    ownerById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
  };
  const agent = () => ctx.agent;
  const op = (name, args, req, timeoutMs) => agent().op(name, args, { req, ...(timeoutMs ? { timeoutMs } : {}) });
  const web = () => { if (!ctx.web?.hostApps) throw new HttpError(503, 'service_unavailable', 'Service Configuration is not loaded'); return ctx.web; };
  const capabilities = () => ctx.capabilities;
  const audit = (req, scope, action, args = {}, result) => {
    const entry = { action, target: scope.username, args: auditArgs(scope, args), ...(result ? { result } : {}) };
    if (req?.audit) req.audit(entry); else ctx.auditRecord?.(req ?? null, entry);
  };
  const isAgentCode = (err, codes) => Boolean(err?.agentError) && codes.includes(err.code);
  const rawHostname = () => String(settings.get('basic.hostname', '') || '').trim();
  const serverHostname = () => { const h = rawHostname().toLowerCase(); return FQDN.test(h) ? h : null; };
  const serverUrl = (username) => { const h = serverHostname(); return h ? `https://${h}${aliasFor(username)}/` : null; };

  function requireScopeShape(scope) {
    if (!scope?.username || !scope.accountId) throw new HttpError(403, 'panel_scope_required', 'No hosting account is bound to this session');
    assertFeature(scope, FEATURE);
  }
  const requireHome = (scope) => { if (!scope.account?.home_dir) throw new HttpError(409, 'no_home', 'This account has no home directory on the server yet'); };

  // The lowest port of the pool no app or Web Disk row holds and nothing on
  // the host listens on (apps.port.free; a host without `ss` is trusted on the rows).
  async function pickPort(req) {
    const range = portRange(settings);
    const used = new Set(stmts.ports.all().map((r) => r.port));
    for (let p = range.min; p <= range.max; p++) {
      if (used.has(p)) continue;
      let free = true;
      try { const r = await op('apps.port.free', { port: p }, req); free = r.free !== false; } catch (err) { if (!isAgentCode(err, ['capability_missing', 'unknown_op', 'binary_not_found'])) throw err; }
      if (free) return p;
    }
    throw conflict(`No free port is left in the application port range ${range.min}–${range.max}; ask your hosting provider`);
  }

  // The row of the account, created on first use with its login (the account
  // name) and a port of its own. A login row of another account is impossible
  // by construction (usernames are unique) but never silently taken over.
  async function rowFor(scope, req, { create = false } = {}) {
    const row = stmts.byAccount.get(scope.accountId);
    if (row || !create) return row ?? null;
    const taken = stmts.byLogin.get(scope.username);
    if (taken && taken.account_id !== scope.accountId) throw new HttpError(409, 'login_taken', `${scope.username} is registered to another account; ask your hosting provider`);
    const port = await pickPort(req);
    try { stmts.insert.run(scope.accountId, port, scope.username, 'disabled'); } catch (err) {
      if (/UNIQUE|constraint/i.test(err.message)) throw conflict('Web Disk was set up at the same time by another request; try again');
      throw err;
    }
    return stmts.byAccount.get(scope.accountId);
  }

  async function unitState(scope, req) {
    try { return await op('webdisk.unit.status', { username: scope.username }, req); } catch (err) {
      if (isAgentCode(err, ['capability_missing', 'unknown_op', 'not_found', 'refused', 'binary_not_found'])) return null;
      logger.debug({ err, username: scope.username }, 'panel-webdisk: unit status unavailable');
      return null;
    }
  }

  const recentJobs = (scope) => ctx.jobs.list({ limit: 100 }).filter((j) => j.type === JOB_INSTALL && j.params?.accountId === scope.accountId).slice(0, 3).map((j) => ({ id: j.id, status: j.status, createdAt: j.created_at, error: j.error ?? null }));

  function shape(scope, row, unit, published) {
    const active = unit ? Boolean(unit.active) : null;
    return {
      enabled: Boolean(row?.enabled), login: row?.login ?? scope.username, port: row?.port ?? null,
      hasPassword: Boolean(row?.has_password), passwordSetAt: row?.password_set_at ?? null,
      status: row?.enabled ? (active === false ? 'failed' : active ? 'active' : row.status) : 'disabled', error: row?.error ?? null,
      serverUrl: serverUrl(scope.username), hostname: serverHostname(), fqdn: Boolean(serverHostname()),
      available: { rclone: capabilities().has('rclone'), apache: capabilities().has('apache'), published: Boolean(published) },
      unit: unit ? { unit: unit.unit, installed: Boolean(unit.installed), active: Boolean(unit.active), state: unit.state ?? null, pid: unit.pid ?? null, restarts: unit.restarts ?? 0, startedAt: unit.startedAt ?? null } : null,
      passwordMinLength: PASSWORD_MIN_LENGTH, packages: WEBDISK_PACKAGES,
      pending: recentJobs(scope).some((j) => ACTIVE_JOB.includes(j.status)), recentJobs: recentJobs(scope),
    };
  }

  async function publication(scope) {
    if (!capabilities().has('apache')) return null;
    try { const apps = await web().hostApps.list(); return (apps.apps || []).find((a) => a.name === appNameFor(scope.username) && a.managed) ?? null; } catch { return null; }
  }

  async function status(scope, req) {
    requireScopeShape(scope);
    await capabilities().ensureFresh();
    const row = await rowFor(scope, req);
    const unit = row?.enabled ? await unitState(scope, req) : null;
    const published = row?.enabled ? await publication(scope) : null;
    return shape(scope, row, unit, published);
  }

  // Root-level: the proxy modules are loaded once, audited, before the first
  // Web Disk of this host is published.
  async function ensureModules(scope, req) {
    const st = await op('web.modules.status', { modules: PROXY_MODULES }, req);
    if (!st.missing?.length) return [];
    const r = await op('web.modules.enable', { modules: st.missing, reload: false }, req);
    audit(req, scope, 'panel.webdisk.modules.enable', { modules: r.enabled || st.missing });
    return r.enabled || st.missing;
  }

  // A disabled row keeps its port, so something else may listen there by the
  // time the disk is switched on again; then the row moves to a free port.
  async function portStillFree(row, req) {
    try { const r = await op('apps.port.free', { port: row.port }, req); return r.free !== false; } catch (err) {
      if (isAgentCode(err, ['capability_missing', 'unknown_op', 'binary_not_found'])) return true;
      throw err;
    }
  }

  // Host first (unit, then the drop-in), row second.
  async function enableNow(scope, row, req) {
    capabilities().require('apache', 'Apache is not installed on this server, so Web Disk cannot be published under the hostname site');
    capabilities().require('rclone', 'rclone is not installed on this server; Web Disk cannot start');
    if (!serverHostname()) throw new HttpError(409, 'hostname_required', 'This server has no fully qualified hostname yet; ask your hosting provider');
    if (!(await portStillFree(row, req))) {
      const previous = row.port;
      stmts.setPort.run(await pickPort(req), nowIso(), row.id);
      row = stmts.byAccount.get(scope.accountId);
      audit(req, scope, 'panel.webdisk.port.move', { from: previous, to: row.port });
    }
    const unit = await op('webdisk.unit.write', { username: scope.username, port: row.port }, req, 180_000);
    let app;
    try {
      const modules = await ensureModules(scope, req);
      app = await web().hostApps.publish({ name: appNameFor(scope.username), alias: aliasFor(scope.username), php: false, proxy: { port: row.port, scriptName: aliasFor(scope.username), path: aliasFor(scope.username), preserveHost: true }, options: ['None'], reload: true }, req);
      app.modules = modules;
    } catch (err) {
      await op('webdisk.unit.remove', { username: scope.username }, req).catch((e) => logger.warn({ err: e, username: scope.username }, 'panel-webdisk: unit left after a failed publish'));
      stmts.setEnabled.run(0, 'failed', `published: ${err.message}`, nowIso(), row.id);
      audit(req, scope, 'panel.webdisk.enable', { port: row.port, reason: err.message }, 'error');
      throw err;
    }
    const status = unit.started ? 'active' : 'failed';
    stmts.setEnabled.run(1, status, unit.started ? null : unit.startError ?? null, nowIso(), row.id);
    audit(req, scope, 'panel.webdisk.enable', { port: row.port, login: row.login, unit: unit.unit, alias: app.alias, url: app.url, started: Boolean(unit.started), modules: app.modules });
    return { unit, app };
  }

  async function disableNow(scope, row, req) {
    let unpublished = null;
    if (capabilities().has('apache')) {
      try { unpublished = await web().hostApps.unpublish(appNameFor(scope.username), req); } catch (err) {
        if (!(err instanceof CapabilityError)) throw err;
      }
    }
    let removed = false;
    try { removed = Boolean((await op('webdisk.unit.remove', { username: scope.username }, req)).removed); } catch (err) {
      if (!isAgentCode(err, ['capability_missing', 'binary_not_found'])) throw err;
    }
    stmts.setEnabled.run(0, 'disabled', null, nowIso(), row.id);
    audit(req, scope, 'panel.webdisk.disable', { port: row.port, unitRemoved: removed, unpublished: Boolean(unpublished?.removed) });
    return { removed, unpublished };
  }

  async function setEnabled(scope, { enabled }, req) {
    requireScopeShape(scope);
    requireHome(scope);
    await capabilities().ensureFresh();
    const row = await rowFor(scope, req, { create: enabled });
    if (!enabled) {
      if (!row) return { ...shape(scope, null, null, null), applied: true };
      if (row.enabled) await disableNow(scope, row, req);
      return { ...shape(scope, stmts.byAccount.get(scope.accountId), null, null), applied: true };
    }
    if (!row.has_password) throw new HttpError(409, 'password_required', 'Set a Web Disk password before switching Web Disk on');
    if (!capabilities().has('rclone')) {
      capabilities().require('apache', 'Apache is not installed on this server, so Web Disk cannot be published under the hostname site');
      if (recentJobs(scope).some((j) => ACTIVE_JOB.includes(j.status))) throw conflict('rclone is being installed already; wait for the job to finish');
      const params = { accountId: scope.accountId, username: scope.username, ownerId: scope.ownerPrincipal?.id ?? null, actor: scope.actor?.username ?? null, packages: WEBDISK_PACKAGES };
      const job = ctx.jobs.enqueue(JOB_INSTALL, params, { userId: scope.actor?.id || null });
      audit(req, scope, 'panel.webdisk.install', { packages: WEBDISK_PACKAGES, job: job.id });
      return { ...shape(scope, row, null, null), pending: true, job: { id: job.id } };
    }
    await enableNow(scope, row, req);
    const fresh = stmts.byAccount.get(scope.accountId);
    return { ...shape(scope, fresh, await unitState(scope, req), await publication(scope)), applied: true };
  }

  async function setPassword(scope, { password }, req) {
    requireScopeShape(scope);
    requireHome(scope);
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) throw unprocessable('The password is too short', { password: [`At least ${PASSWORD_MIN_LENGTH} characters`] });
    const row = await rowFor(scope, req, { create: true });
    const hash = await ctx.crypto.hashPassword(password);
    if (!/^\$2[aby]\$/.test(hash)) throw new HttpError(500, 'internal', 'A Web Disk password must be hashed before it reaches the agent');
    // Apache's htpasswd writes $2y$; every bcrypt reader (rclone's included) takes that prefix, not all take $2b$.
    const r = await op('webdisk.htpasswd.set', { username: scope.username, login: row.login, hash: hash.replace(/^\$2b\$/, '$2y$') }, req);
    stmts.setPassword.run(nowIso(), nowIso(), row.id);
    let restarted = null;
    if (row.enabled) {
      // rclone reads the htpasswd file at start; the daemon follows the new hash after a restart.
      try { const c = await op('webdisk.unit.control', { username: scope.username, action: 'restart' }, req); restarted = Boolean(c.status?.active); } catch (err) {
        logger.warn({ err, username: scope.username }, 'panel-webdisk: restart after password change failed');
        restarted = false;
        stmts.setStatus.run('failed', `restart: ${err.message}`, nowIso(), row.id);
      }
    }
    audit(req, scope, 'panel.webdisk.password.set', { login: row.login, created: Boolean(r.created), restarted });
    return { login: row.login, hasPassword: true, created: Boolean(r.created), restarted, serverUrl: serverUrl(scope.username) };
  }

  // Static client recipes; the page translates the steps, the server only
  // knows the addresses each platform wants.
  function clients(scope) {
    requireScopeShape(scope);
    const host = serverHostname();
    const url = serverUrl(scope.username);
    const row = stmts.byAccount.get(scope.accountId);
    const login = row?.login ?? scope.username;
    const list = CLIENTS.map((id) => {
      if (id === 'windows') return { id, url, unc: host ? `\\\\${host}@SSL\\webdisk\\${scope.username}` : null };
      if (id === 'linux') return { id, url, gvfs: host ? `davs://${host}${aliasFor(scope.username)}/` : null, davfs: url };
      return { id, url };
    });
    return { serverUrl: url, hostname: host, login, port: 443, clients: list };
  }

  // ---- the install job --------------------------------------------------
  function jobScope(params) {
    const account = stmts.account.get(params.accountId, params.username);
    if (!account) throw new Error(`Account "${params.username}" no longer exists`);
    const owner = params.ownerId != null ? stmts.ownerById.get(params.ownerId) : null;
    if (!owner) throw new Error(`The owner of account "${params.username}" no longer exists; switch Web Disk on again`);
    if (account.owner_id !== owner.id) throw new Error(`Account "${params.username}" changed owner since the job was queued; switch Web Disk on again`);
    const req = { user: { id: owner.id, username: owner.username, role: owner.role }, ip: null, id: null };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    const scope = { account, accountId: account.id, username: account.username, mode: 'job', actor: null, actingAs: null, owner, ownerPrincipal: req.user, limits: {}, features: {} };
    return { scope, req };
  }

  async function runInstall(job) {
    const { scope, req } = jobScope(job.params);
    job.progress(5, 'installing rclone');
    if (!capabilities().has('rclone')) {
      job.log(`installing ${WEBDISK_PACKAGES.join(' ')}`);
      const r = await job.agent.op('pkg.install', { packages: WEBDISK_PACKAGES, noRecommends: true }, { timeoutMs: 45 * 60_000 });
      for (const line of (r.output || []).slice(-40)) job.log(line);
      await capabilities().refresh().catch((err) => job.log(`capability re-detection failed: ${err.message}`, 'warn'));
      if (!capabilities().has('rclone')) throw new Error('rclone is still missing after the package install');
    } else job.log('rclone is already installed');
    job.progress(60, 'starting Web Disk');
    const row = stmts.byAccount.get(scope.accountId);
    if (!row) throw new Error('The Web Disk row disappeared while rclone was installed; switch Web Disk on again');
    if (!row.has_password) throw new Error('No Web Disk password is set; set one and switch Web Disk on again');
    const r = await enableNow(scope, row, req);
    job.log(`${r.unit.unit} ${r.unit.started ? 'started' : `not started: ${r.unit.startError}`}; published at ${r.app.url}`);
    job.progress(100, 'finished');
    return { enabled: true, port: row.port, url: r.app.url, started: Boolean(r.unit.started) };
  }

  function jobOf(scope, id) {
    const job = ctx.jobs.get(id);
    if (!JOB_TYPES.includes(job.type) || job.params?.accountId !== scope.accountId) throw notFound('Job');
    return job;
  }
  function shapeJob(job) {
    const params = { ...(job.params ?? {}) };
    for (const k of ['ownerId', 'accountId']) delete params[k];
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

  // ---- admin and termination -------------------------------------------
  function listAll() {
    return stmts.listAll.all().map((r) => ({ username: r.username, domain: r.domain, login: r.login, enabled: Boolean(r.enabled), port: r.port, status: r.status, error: r.error ?? null, hasPassword: Boolean(r.has_password), url: serverUrl(r.username), updatedAt: r.updated_at }));
  }

  // account-functions' rearrange hook: the unit bakes the home into its
  // paths, so a moved home needs the unit rendered again (the row's port and
  // the drop-in stay). Nothing to do for a disabled disk.
  async function rewrite(username, req) {
    const row = stmts.byUsername.get(username);
    if (!row || !row.enabled) return { enabled: false, rewritten: false };
    const scope = { username, accountId: row.account_id, account: { username } };
    try {
      const unit = await op('webdisk.unit.write', { username, port: row.port }, req, 180_000);
      stmts.setStatus.run(unit.started ? 'active' : 'failed', unit.started ? null : unit.startError ?? null, nowIso(), row.id);
      audit(req, scope, 'panel.webdisk.rewrite', { port: row.port, unit: unit.unit, started: Boolean(unit.started) });
      return { enabled: true, rewritten: true, started: Boolean(unit.started), unit: unit.unit, port: row.port };
    } catch (err) {
      stmts.setStatus.run('failed', `rewrite: ${err.message}`, nowIso(), row.id);
      audit(req, scope, 'panel.webdisk.rewrite', { port: row.port, reason: err.message }, 'error');
      throw err;
    }
  }

  // accounts.cleanupAccount hook: the unit and the drop-in go before the home
  // and the row (cascade) do.
  async function removeAccount(username, accountId, req) {
    const row = stmts.byAccount.get(accountId);
    if (!row) return null;
    const scope = { username, accountId, account: { username } };
    const out = { login: row.login, port: row.port, enabled: Boolean(row.enabled) };
    if (row.enabled) {
      try { const r = await disableNow(scope, row, req); out.unitRemoved = r.removed; out.unpublished = Boolean(r.unpublished?.removed); } catch (err) { out.error = err.message; logger.warn({ err, username }, 'panel-webdisk: Web Disk not removed on termination'); }
    }
    stmts.remove.run(accountId);
    return out;
  }

  return { status, setEnabled, setPassword, clients, getJob, streamJob, runInstall, listAll, rewrite, removeAccount, pickPort, appNameFor, aliasFor, serverUrl };
}
