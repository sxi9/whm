import { posix as path } from 'node:path';
import { HttpError, CapabilityError, notFound, conflict, unprocessable } from '../lib/errors.js';
import { json } from '../db/index.js';
import { assertFeature, assertLimit, auditArgs } from './panel-domains.js';

// Application Manager of the account panel (contract §65): a Node.js or Python
// program of the account runs as the systemd unit keel-app-<username>.<name>
// (agent apps.unit.*, unit file under /etc/whm/apps, the account's own uid)
// on a loopback port from the host's pool, and one of the account's domains
// proxies a path to it (ctx.web.setProxies → web.vhost.write). The Apache
// proxy modules are enabled by the server, as root, the first time an app is
// published; dependency installs are jobs that run npm/pip as the account.
//
//   panelApps.list / get / runtimes / create / update / remove / control / logs / deps / getJob / streamJob
//   panelApps.countForDomain(scope, domain)   -> panel-domains refuses to drop a domain that serves apps
//   panelApps.removeAccountApps(username, req) -> accounts.cleanupAccount, before the vhosts are removed

export const FEATURE = 'applicationmanager';
export const JOB_DEPS = 'panel.apps.deps';
export const JOB_TYPES = [JOB_DEPS];
export const APP_TYPES = ['node', 'python'];
export const APP_NAME_RE = /^[a-z0-9-]{2,32}$/;
export const APP_REL_RE = /^(?!-)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._][A-Za-z0-9._\/-]{0,255}$/;
export const MOUNT_RE = /^\/(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/;
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
export const ENV_VALUE_RE = /^[^\0\r\n]{0,1024}$/;
export const ENV_MAX = 64;
export const RESERVED_ENV = ['PORT', 'HOME', 'USER', 'LOGNAME', 'PATH'];
export const NODE_RUNTIME_RE = /^(system|[1-9]\d)$/;
export const PYTHON_RUNTIME_RE = /^(system|3\.\d{1,2})$/;
export const DEFAULT_PORT_RANGE = Object.freeze({ min: 31000, max: 31999 });
export const PORT_RANGE_SETTING = 'panel.app_port_range';
export const PROXY_MODULES = ['proxy', 'proxy_http', 'proxy_wstunnel', 'rewrite'];
export const LOGS_MAX_LINES = 500;
export const DEPS_TIMEOUT_MS = 20 * 60_000;
export const WEB_TYPES = ['main', 'addon', 'sub'];
export const STATUSES = ['pending', 'running', 'stopped', 'failed', 'unknown'];
const ACTIVE_JOB = ['queued', 'running'];
const FINISHED_JOB = ['done', 'failed', 'cancelled'];
const RUNTIMES_TTL_MS = 60_000;

export const normalizeMount = (m) => { const s = `/${String(m ?? '/').trim().replace(/^\/+|\/+$/g, '')}`; return s; };
const nowIso = () => new Date().toISOString();

// The port pool: `[min, max]` or `{ min, max }` in the setting, inside the
// unprivileged range; a broken setting falls back to the default.
export function portRange(settings) {
  const raw = settings?.get?.(PORT_RANGE_SETTING, null);
  const pair = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw.min, raw.max] : null;
  if (!pair) return { ...DEFAULT_PORT_RANGE };
  const [min, max] = pair.map(Number);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1024 || max > 65535 || min > max) return { ...DEFAULT_PORT_RANGE };
  return { min, max };
}

export function createPanelAppsService(ctx) {
  const { db } = ctx;
  const stmts = {
    account: db.prepare('SELECT id, username, owner_id, home_dir, domain FROM accounts WHERE id = ? AND username = ?'),
    ownerById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
    list: db.prepare('SELECT * FROM panel_apps WHERE account_id = ? ORDER BY name'),
    byId: db.prepare('SELECT * FROM panel_apps WHERE id = ? AND account_id = ?'),
    byName: db.prepare('SELECT id FROM panel_apps WHERE account_id = ? AND name = ?'),
    byDomain: db.prepare('SELECT * FROM panel_apps WHERE account_id = ? AND domain = ? ORDER BY id'),
    byMount: db.prepare('SELECT id FROM panel_apps WHERE account_id = ? AND domain = ? AND mount = ?'),
    countDomain: db.prepare('SELECT COUNT(*) AS n FROM panel_apps WHERE account_id = ? AND domain = ?'),
    byUsername: db.prepare('SELECT p.* FROM panel_apps p JOIN accounts a ON a.id = p.account_id WHERE a.username = ? ORDER BY p.id'),
    count: db.prepare('SELECT COUNT(*) AS n FROM panel_apps WHERE account_id = ?'),
    // Web Disk rows keep their port while disabled (nothing listens, so the
    // probe would call it free); both tables share the pool.
    ports: db.prepare('SELECT port FROM panel_apps UNION SELECT port FROM panel_webdisk'),
    insert: db.prepare(`INSERT INTO panel_apps (account_id, name, type, dir, entry, runtime, port, domain, mount, websocket, env_json, status, error)
      VALUES (@account_id, @name, @type, @dir, @entry, @runtime, @port, @domain, @mount, @websocket, @env_json, @status, @error)`),
    update: db.prepare(`UPDATE panel_apps SET dir = @dir, entry = @entry, runtime = @runtime, domain = @domain, mount = @mount, websocket = @websocket, env_json = @env_json, status = @status, error = @error, updated_at = @updated_at
      WHERE id = @id AND account_id = @account_id`),
    setStatus: db.prepare('UPDATE panel_apps SET status = ?, error = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM panel_apps WHERE id = ? AND account_id = ?'),
  };
  const agent = () => ctx.agent;
  const op = (name, args, req, timeoutMs) => agent().op(name, args, { req, ...(timeoutMs ? { timeoutMs } : {}) });
  const domains = () => { if (!ctx.panelDomains) throw new HttpError(503, 'service_unavailable', 'The panel domains service is not loaded'); return ctx.panelDomains; };
  const web = () => { if (!ctx.web?.setProxies) throw new HttpError(503, 'service_unavailable', 'The web service is not loaded'); return ctx.web; };
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
  // A home-relative directory pinned under the home (lexically; the agent re-pins it through symlinks).
  function pinRel(scope, rel, field) {
    const clean = String(rel ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!clean || !APP_REL_RE.test(clean) || clean.split('/').some((s) => s === '..' || s === '.')) throw unprocessable('Request validation failed', { [field]: ['A path relative to your home directory without "..", spaces or quotes'] });
    const base = home(scope);
    const abs = path.resolve(base, clean);
    if (abs === base || !abs.startsWith(`${base}/`)) throw unprocessable('Request validation failed', { [field]: ['The path must stay inside your home directory'] });
    return path.relative(base, abs);
  }
  function pinEntry(entry) {
    const clean = String(entry ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!clean || !APP_REL_RE.test(clean) || clean.split('/').some((s) => s === '..' || s === '.')) throw unprocessable('Request validation failed', { entry: ['A file inside the application folder, such as server.js or app.py'] });
    return clean;
  }
  function pinEnv(env) {
    const out = {};
    const errors = [];
    for (const [k, v] of Object.entries(env || {})) {
      if (!ENV_KEY_RE.test(k)) { errors.push(`${k}: upper-case letters, digits and "_", not starting with a digit`); continue; }
      if (RESERVED_ENV.includes(k)) { errors.push(`${k} is set by the panel`); continue; }
      if (typeof v !== 'string' || !ENV_VALUE_RE.test(v)) { errors.push(`${k}: one line of at most 1024 characters`); continue; }
      out[k] = v;
    }
    if (Object.keys(out).length > ENV_MAX) errors.push(`At most ${ENV_MAX} variables`);
    if (errors.length) throw unprocessable('Request validation failed', { env: errors });
    return out;
  }
  function pinRuntime(type, runtime) {
    const re = type === 'node' ? NODE_RUNTIME_RE : PYTHON_RUNTIME_RE;
    if (!re.test(String(runtime ?? ''))) throw unprocessable('Request validation failed', { runtime: [type === 'node' ? 'A Node.js major such as 22, or "system"' : 'A Python minor such as 3.12, or "system"'] });
    return String(runtime);
  }
  // The domain must be one of the account's own websites (a foreign one is 404, never 403).
  function pinDomain(scope, domain) {
    const row = domains().allDomains(scope).find((r) => r.domain === domain && WEB_TYPES.includes(r.type));
    if (!row) throw notFound(`Domain "${domain}"`);
    return row.domain;
  }
  function pinMount(mount) {
    const m = normalizeMount(mount);
    if (!MOUNT_RE.test(m) || m.length > 200 || m.split('/').some((s) => s === '.' || s === '..')) throw unprocessable('Request validation failed', { mount: ['A site path such as / or /app'] });
    return m;
  }
  const memoryMaxOf = (scope) => {
    const mb = Number(scope.account?.plan?.app_memory_mb);
    return Number.isInteger(mb) && mb > 0 ? `${mb}M` : null;
  };
  const unitOf = (scope, row) => `keel-app-${scope.username}.${row.name}`;
  const scheme = (domain) => (typeof ctx.ssl?.certForDomain === 'function' && ctx.ssl.certForDomain(domain)?.state === 'installed' ? 'https' : 'http');
  const urlOf = (row) => `${scheme(row.domain)}://${row.domain}${row.mount === '/' ? '/' : `${row.mount}/`}`;

  function shape(scope, r, status = null) {
    return {
      id: r.id, name: r.name, type: r.type, dir: r.dir, entry: r.entry, runtime: r.runtime, port: r.port, domain: r.domain, mount: r.mount, websocket: Boolean(r.websocket),
      env: json.parse(r.env_json, {}), status: r.status, error: r.error ?? null, unit: unitOf(scope, r), url: urlOf(r), createdAt: r.created_at, updatedAt: r.updated_at,
      ...(status ? { service: status } : {}),
    };
  }

  // Live state of the unit, folded into the row's status; an unreachable agent
  // leaves the stored status and reports `service: null`.
  async function liveStatus(scope, row, req) {
    try {
      const s = await op('apps.unit.status', { username: scope.username, name: row.name }, req);
      const status = !s.installed ? 'pending' : s.active ? 'running' : s.state === 'failed' || s.result === 'exit-code' ? 'failed' : 'stopped';
      if (status !== row.status && row.status !== 'pending') stmts.setStatus.run(status, status === 'failed' ? (row.error || `unit ${s.state}${s.subState ? ` (${s.subState})` : ''}`) : null, nowIso(), row.id);
      return { status, service: { state: s.state, subState: s.subState ?? null, pid: s.pid ?? null, startedAt: s.startedAt ?? null, memoryBytes: s.memoryBytes ?? null, restarts: s.restarts ?? 0, enabled: Boolean(s.enabled) } };
    } catch (err) {
      if (isAgentCode(err, ['capability_missing', 'unknown_op', 'agent_unavailable', 'timeout'])) return { status: row.status, service: null };
      throw err;
    }
  }

  async function withStatus(scope, row, req) {
    const live = await liveStatus(scope, row, req);
    const r = stmts.byId.get(row.id, scope.accountId) || row;
    return { ...shape(scope, r, live.service), status: live.status };
  }

  let runtimesCache = { at: 0, value: null };
  async function runtimes(req) {
    if (runtimesCache.value && Date.now() - runtimesCache.at < RUNTIMES_TTL_MS) return runtimesCache.value;
    let d = null;
    try { d = await op('pkg.runtime.detect', {}, req); } catch (err) {
      if (!isAgentCode(err, ['capability_missing', 'unknown_op', 'binary_not_found'])) throw err;
    }
    const node = [];
    for (const v of d?.node?.versions || []) node.push({ id: String(v.major), label: `Node.js ${v.version || v.major} (Keel build)`, version: v.version ?? null, keel: true });
    if (d?.node?.system?.version) node.push({ id: 'system', label: `Node.js ${d.node.system.version} (system)`, version: d.node.system.version, keel: false });
    const python = (d?.python || []).map((p) => ({ id: p.minor, label: `Python ${p.version || p.minor}`, version: p.version ?? null, keel: false }));
    if (python.length && !python.some((p) => p.id === 'system')) python.push({ id: 'system', label: 'Python 3 (system default)', version: null, keel: false });
    const value = { node, python, portRange: portRange(ctx.settings) };
    runtimesCache = { at: Date.now(), value };
    return value;
  }

  // The lowest port of the pool no app or Web Disk row holds and nothing on
  // the host listens on (apps.port.free; a host without `ss` is trusted on the rows).
  async function pickPort(req) {
    const range = portRange(ctx.settings);
    const used = new Set(stmts.ports.all().map((r) => r.port));
    for (let p = range.min; p <= range.max; p++) {
      if (used.has(p)) continue;
      let free = true;
      try { const r = await op('apps.port.free', { port: p }, req); free = r.free !== false; } catch (err) { if (!isAgentCode(err, ['capability_missing', 'unknown_op', 'binary_not_found'])) throw err; }
      if (free) return p;
    }
    throw conflict(`No free port is left in the application port range ${range.min}–${range.max}; ask your hosting provider`);
  }

  const proxiesFor = (scope, domain) => stmts.byDomain.all(scope.accountId, domain).map((r) => ({ path: r.mount, port: r.port, websocket: Boolean(r.websocket) }));

  // Root-level: the proxy modules (and mod_rewrite) are loaded once, audited,
  // before the first app of this host is published; a host without Apache
  // answers 501.
  const requireApache = () => { if (!ctx.capabilities?.has?.('apache')) throw new CapabilityError('apache', 'Apache is not installed on this server; applications cannot be published without it'); };
  async function ensureModules(scope, req) {
    requireApache();
    const status = await op('web.modules.status', { modules: PROXY_MODULES }, req);
    if (!status.missing?.length) return { enabled: [] };
    const r = await op('web.modules.enable', { modules: status.missing }, req);
    audit(req, scope, 'web.modules.enable', { modules: status.missing, enabled: r.enabled, reloaded: Boolean(r.reloaded) });
    return { enabled: r.enabled };
  }

  async function publish(scope, domain, req) {
    await ensureModules(scope, req);
    return web().setProxies(domain, proxiesFor(scope, domain), req);
  }

  // Stop, disable and unlink a unit; a unit that is already gone, or a host
  // without the op, is not an error here.
  async function dropUnit(username, name, req) {
    try { return await op('apps.unit.remove', { username, name }, req); } catch (err) {
      if (!isAgentCode(err, ['not_found', 'capability_missing', 'unknown_op'])) throw err;
      return { removed: false };
    }
  }

  // How many of the account's applications a domain serves: panel-domains
  // refuses to remove a domain while this is non-zero.
  function countForDomain(scope, domain) {
    return stmts.countDomain.get(scope.accountId, domain).n;
  }

  // Account termination (accounts.cleanupAccount, before the vhosts go): every
  // unit of the account is stopped, disabled and unlinked, then the rows are
  // deleted. No proxy rewrite: the vhosts are removed right after.
  async function removeAccountApps(username, req) {
    const rows = stmts.byUsername.all(username);
    if (!rows.length) return null;
    const removed = [];
    for (const row of rows) {
      const unit = await dropUnit(username, row.name, req);
      stmts.remove.run(row.id, row.account_id);
      removed.push({ name: row.name, port: row.port, domain: row.domain, unitRemoved: Boolean(unit.removed) });
    }
    return { removed };
  }

  async function list(scope, req) {
    requireScopeShape(scope);
    const rows = stmts.list.all(scope.accountId);
    const data = [];
    for (const r of rows) data.push(await withStatus(scope, r, req));
    const sites = domains().allDomains(scope).filter((r) => WEB_TYPES.includes(r.type)).map((r) => ({ domain: r.domain, type: r.type }));
    return { data, meta: { total: data.length, sites, portRange: portRange(ctx.settings), apache: Boolean(ctx.capabilities?.has?.('apache')), limit: scope.account?.plan?.max_apps ?? null } };
  }

  function rowOf(scope, id) {
    const row = stmts.byId.get(id, scope.accountId);
    if (!row) throw notFound('Application');
    return row;
  }

  async function get(scope, id, req) {
    requireScopeShape(scope);
    return withStatus(scope, rowOf(scope, id), req);
  }

  async function writeUnit(scope, fields, req) {
    return op('apps.unit.write', { username: scope.username, name: fields.name, type: fields.type, dir: fields.dir, entry: fields.entry, runtime: fields.runtime, port: fields.port, env: fields.env, memoryMax: memoryMaxOf(scope) }, req, 180_000);
  }

  async function create(scope, input, req) {
    requireScopeShape(scope);
    assertLimit(scope, 'max_apps', stmts.count.get(scope.accountId).n, 'application(s)');
    const name = String(input.name ?? '').trim();
    if (!APP_NAME_RE.test(name)) throw unprocessable('Request validation failed', { name: ['2 to 32 lowercase letters, digits or "-"'] });
    if (!APP_TYPES.includes(input.type)) throw unprocessable('Request validation failed', { type: [`One of ${APP_TYPES.join(', ')}`] });
    if (stmts.byName.get(scope.accountId, name)) throw conflict(`An application named "${name}" already exists`);
    const fields = {
      name, type: input.type, dir: pinRel(scope, input.dir, 'dir'), entry: pinEntry(input.entry), runtime: pinRuntime(input.type, input.runtime ?? 'system'),
      domain: pinDomain(scope, input.domain ?? scope.account.domain), mount: pinMount(input.mount ?? '/'), websocket: input.websocket !== false, env: pinEnv(input.env),
    };
    if (stmts.byMount.get(scope.accountId, fields.domain, fields.mount)) throw conflict(`${fields.domain}${fields.mount === '/' ? '' : fields.mount} already serves an application`);
    requireApache();
    fields.port = await pickPort(req);
    // Host first: the unit is written and started before the row exists, so a
    // missing folder or entry file answers 404 and leaves nothing behind. A
    // row that fails the unique checks after all (a concurrent create took the
    // name, the mount or the port meanwhile) takes its unit down with it.
    const unit = await writeUnit(scope, fields, req);
    let info;
    try {
      info = stmts.insert.run({ account_id: scope.accountId, name, type: fields.type, dir: fields.dir, entry: fields.entry, runtime: fields.runtime, port: fields.port, domain: fields.domain, mount: fields.mount, websocket: fields.websocket ? 1 : 0, env_json: JSON.stringify(fields.env), status: unit.started ? 'running' : 'failed', error: unit.startError ?? null });
    } catch (err) {
      await dropUnit(scope.username, name, req).catch(() => {});
      if (/UNIQUE|constraint/i.test(err.message)) throw conflict(`An application with this name, path or port was created at the same time; try again`);
      throw err;
    }
    const id = Number(info.lastInsertRowid);
    let published = null;
    try { published = await publish(scope, fields.domain, req); } catch (err) {
      stmts.setStatus.run('failed', `published: ${err.message}`, nowIso(), id);
      audit(req, scope, 'panel.apps.create', { id, name, type: fields.type, domain: fields.domain, mount: fields.mount, port: fields.port, reason: err.message }, 'error');
      throw err;
    }
    audit(req, scope, 'panel.apps.create', { id, name, type: fields.type, dir: fields.dir, entry: fields.entry, runtime: fields.runtime, domain: fields.domain, mount: fields.mount, port: fields.port, envKeys: Object.keys(fields.env), started: Boolean(unit.started) });
    const row = stmts.byId.get(id, scope.accountId);
    return { ...(await withStatus(scope, row, req)), applied: published?.applied !== false, started: Boolean(unit.started), startError: unit.startError ?? null, interpreter: unit.interpreter ?? null };
  }

  async function update(scope, id, input, req) {
    requireScopeShape(scope);
    const row = rowOf(scope, id);
    const fields = {
      name: row.name, type: row.type,
      dir: input.dir != null ? pinRel(scope, input.dir, 'dir') : row.dir,
      entry: input.entry != null ? pinEntry(input.entry) : row.entry,
      runtime: input.runtime != null ? pinRuntime(row.type, input.runtime) : row.runtime,
      domain: input.domain != null ? pinDomain(scope, input.domain) : row.domain,
      mount: input.mount != null ? pinMount(input.mount) : row.mount,
      websocket: input.websocket != null ? Boolean(input.websocket) : Boolean(row.websocket),
      env: input.env != null ? pinEnv(input.env) : json.parse(row.env_json, {}),
      port: row.port,
    };
    const moved = fields.domain !== row.domain || fields.mount !== row.mount;
    if (moved) {
      const taken = stmts.byMount.get(scope.accountId, fields.domain, fields.mount);
      if (taken && taken.id !== row.id) throw conflict(`${fields.domain}${fields.mount === '/' ? '' : fields.mount} already serves an application`);
    }
    const unit = await writeUnit(scope, fields, req);
    stmts.update.run({ id: row.id, account_id: scope.accountId, dir: fields.dir, entry: fields.entry, runtime: fields.runtime, domain: fields.domain, mount: fields.mount, websocket: fields.websocket ? 1 : 0, env_json: JSON.stringify(fields.env), status: unit.started ? 'running' : 'failed', error: unit.startError ?? null, updated_at: nowIso() });
    const results = [];
    if (moved || fields.websocket !== Boolean(row.websocket)) {
      if (fields.domain !== row.domain) results.push(await publish(scope, row.domain, req));
      results.push(await publish(scope, fields.domain, req));
    }
    audit(req, scope, 'panel.apps.update', { id: row.id, name: row.name, changed: Object.keys(input), domain: fields.domain, mount: fields.mount, started: Boolean(unit.started) });
    return { ...(await withStatus(scope, stmts.byId.get(row.id, scope.accountId), req)), applied: results.every((r) => r.applied !== false), started: Boolean(unit.started), startError: unit.startError ?? null };
  }

  // The unit goes first (stop, disable, file), then the proxy, then the row;
  // the application's files are never touched.
  async function remove(scope, id, req) {
    requireScopeShape(scope);
    const row = rowOf(scope, id);
    const unit = await dropUnit(scope.username, row.name, req);
    stmts.remove.run(row.id, scope.accountId);
    let proxy = null;
    if (ctx.capabilities?.has?.('apache')) {
      try { proxy = await web().setProxies(row.domain, proxiesFor(scope, row.domain), req); } catch (err) { ctx.logger?.warn?.({ err, domain: row.domain }, 'apps: proxy removal failed'); proxy = { applied: false, error: err.message }; }
    }
    audit(req, scope, 'panel.apps.remove', { id: row.id, name: row.name, domain: row.domain, mount: row.mount, port: row.port, unitRemoved: Boolean(unit.removed) });
    return { id: row.id, name: row.name, removed: true, unitRemoved: Boolean(unit.removed), applied: proxy ? proxy.applied !== false : false, filesKept: row.dir };
  }

  async function control(scope, id, action, req) {
    requireScopeShape(scope);
    const row = rowOf(scope, id);
    const r = await op('apps.unit.control', { username: scope.username, name: row.name, action }, req);
    audit(req, scope, `panel.apps.${action}`, { id: row.id, name: row.name });
    const status = action === 'stop' ? 'stopped' : r.status?.active ? 'running' : 'failed';
    stmts.setStatus.run(status, status === 'failed' ? `unit ${r.status?.state ?? 'inactive'}` : null, nowIso(), row.id);
    return withStatus(scope, stmts.byId.get(row.id, scope.accountId), req);
  }

  async function logs(scope, id, { lines = 100 } = {}, req) {
    requireScopeShape(scope);
    const row = rowOf(scope, id);
    const n = Math.max(1, Math.min(LOGS_MAX_LINES, Number(lines) || 100));
    const r = await op('apps.unit.logs', { username: scope.username, name: row.name, lines: n }, req);
    return { id: row.id, name: row.name, unit: r.unit, lines: r.lines || [] };
  }

  async function deps(scope, id, req) {
    requireScopeShape(scope);
    const row = rowOf(scope, id);
    const params = { accountId: scope.accountId, username: scope.username, ownerId: scope.ownerPrincipal?.id ?? null, actor: scope.actor?.username ?? null, appId: row.id, name: row.name, type: row.type, dir: row.dir, runtime: row.runtime };
    const job = ctx.jobs.enqueue(JOB_DEPS, params, { userId: scope.actor?.id || null });
    audit(req, scope, 'panel.apps.deps', { id: row.id, name: row.name, type: row.type, job: job.id });
    return { job: { id: job.id }, id: row.id, name: row.name, type: row.type };
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

  async function runDeps(job) {
    const p = job.params;
    const { scope, req } = jobScope(p);
    job.log(`Installing the dependencies of ${p.name} (${p.type}) in ${p.dir} as ${p.username}`);
    job.progress(10, p.type === 'node' ? 'npm install --omit=dev' : 'python -m venv .venv && pip install -r requirements.txt');
    const r = await agent().op('apps.deps.install', { username: p.username, dir: p.dir, type: p.type, runtime: p.runtime }, { req, timeoutMs: DEPS_TIMEOUT_MS + 60_000 });
    for (const s of r.steps || []) {
      job.log(`$ ${s.command}`);
      for (const line of String(s.output || '').split('\n').filter(Boolean)) job.log(line, s.code === 0 ? 'info' : 'error');
    }
    if (r.skipped) job.log(`Nothing to install: ${r.skipped}`, 'warn');
    job.progress(100, 'done');
    audit(req, scope, 'panel.apps.deps.done', { id: p.appId, name: p.name, type: p.type, steps: (r.steps || []).length, skipped: r.skipped ?? null, job: job.job.id });
    return { id: p.appId, name: p.name, type: p.type, steps: (r.steps || []).map((s) => ({ step: s.step, code: s.code })), skipped: r.skipped ?? null };
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

  return { list, get, runtimes, create, update, remove, control, logs, deps, runDeps, getJob, streamJob, proxiesFor, pickPort, countForDomain, removeAccountApps };
}
