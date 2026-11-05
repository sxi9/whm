import { notFound, badRequest, HttpError, CapabilityError } from '../lib/errors.js';
import { PRIVILEGES, PG_PRIVILEGES, signonUserFor } from './database-services.js';

// Customer panel: databases, users, grants and remote hosts of exactly one
// hosting account. Every method takes the pinned scope from ctx.panel.scope(req)
// (design §3.1) and re-checks that each named object belongs to that account
// before delegating to ctx.databases with the account's owner principal. The
// panel never relies on the delegate's owner-level visibility checks: two
// accounts of the same reseller look identical to it. SYSTEM_ROOT is used for
// read-only lookups only (forAccount, listDatabases), as backup.js does.

export const DB_NAME = /^[a-z0-9_]{1,54}$/;
export const DB_USER_NAME = /^[a-z0-9_]{1,22}$/;
export const ACCESS_HOST = /^[A-Za-z0-9.%:_-]{1,255}$/;
export const ALL_PRIVILEGES = [...new Set([...PRIVILEGES, ...PG_PRIVILEGES])];
export const DUMP_STAGING_ROOT = '/var/lib/whm/panel/dumps';
export const SYSTEM_ROOT = Object.freeze({ id: null, username: 'panel', role: 'root' });

const DB_NAME_MAX = 64;
const DB_USER_MAX = 32;
export const JOB_TYPES = ['db.repair', 'panel.db.dump'];
const ACTIVE_JOB = ['queued', 'running'];
const FINISHED_JOB = ['done', 'failed', 'cancelled'];

export function ensurePrefixed(username, name) {
  const prefix = `${username}_`;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

export function featureDisabled(key) {
  return new HttpError(403, 'feature_disabled', `The "${key}" feature is not enabled for this account's package`);
}

export function limitReached(key, limit) {
  return new HttpError(409, 'limit_reached', `This account's package allows ${limit} ${key.replace(/^max_/, '').replace(/_/g, ' ')}(s)`);
}

// null means unlimited; enhancements (scope.limits) may only raise a plan limit.
export function effectiveLimit(scope, key) {
  const plan = scope.account?.plan?.[key];
  if (plan == null) return null;
  const extra = scope.limits?.[key];
  return typeof extra === 'number' ? Math.max(Number(plan), extra) : Number(plan);
}

export function createPanelDatabasesService(ctx) {
  const { db, settings } = ctx;

  const stmts = {
    dbByName: db.prepare('SELECT * FROM databases WHERE name = ? AND account_id = ?'),
    dbsFor: db.prepare('SELECT name FROM databases WHERE account_id = ? ORDER BY name'),
    countDbs: db.prepare('SELECT COUNT(*) AS n FROM databases WHERE account_id = ?'),
    userByName: db.prepare('SELECT * FROM db_users WHERE name = ? AND account_id = ?'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM db_users WHERE account_id = ?'),
    accessHostById: db.prepare('SELECT * FROM db_access_hosts WHERE id = ? AND account_id = ?'),
    ownerById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
  };

  const databases = () => {
    if (!ctx.databases) throw new CapabilityError('mysql', 'Database Services are not available');
    return ctx.databases;
  };

  const engine = () => databases().activeProfile()?.engine ?? null;
  const isPg = () => engine() === 'postgres';
  const featureKey = () => (isPg() ? 'postgres' : 'mysql');
  const featureOn = (scope, key) => scope.features?.[key] !== false;

  function requireFeature(scope) {
    const key = featureKey();
    if (!featureOn(scope, key)) throw featureDisabled(key);
  }

  function ownedDatabase(scope, name) {
    const row = stmts.dbByName.get(name, scope.accountId);
    if (!row) throw notFound(`Database "${name}"`);
    return row;
  }

  // The phpMyAdmin signon user is the panel's own (hidden, rotated per
  // sign-on): to the account it does not exist.
  function ownedUser(scope, name) {
    const row = stmts.userByName.get(name, scope.accountId);
    if (!row || name === signonUserFor(scope.username)) throw notFound(`Database user "${name}"`);
    return row;
  }

  function assertOwnedDatabases(scope, names) {
    for (const n of names) ownedDatabase(scope, n);
  }

  function fullName(scope, name, kind) {
    const full = ensurePrefixed(scope.username, name);
    const max = kind === 'user' ? DB_USER_MAX : DB_NAME_MAX;
    if (full.length > max) throw badRequest(`"${full}" is longer than ${max} characters; choose a shorter ${kind} name`, { name: [`Including the "${scope.username}_" prefix the name must be at most ${max} characters`] });
    return full;
  }

  function quota(scope) {
    const max = effectiveLimit(scope, 'max_sql') ?? effectiveLimit(scope, 'max_db');
    const used = stmts.countDbs.get(scope.accountId).n;
    return { max, used, remaining: max == null ? null : Math.max(0, max - used) };
  }

  const audit = (req, scope, entry) => req?.audit?.({ ...entry, target: scope.username, args: { ...(entry.args || {}), ...(scope.mode === 'acting' ? { actingAs: scope.username, by: scope.actor?.username } : {}) } });

  async function list(scope) {
    requireFeature(scope);
    const svc = databases();
    const mine = svc.forAccount(scope.username, SYSTEM_ROOT);
    let listed = null;
    let engineError = null;
    try {
      listed = await svc.listDatabases({ account: scope.username, page: 1, pageSize: 500 }, SYSTEM_ROOT);
      engineError = listed.meta.engineError ?? null;
    } catch (err) {
      if (err instanceof CapabilityError) throw err;
      engineError = { code: err.code, message: err.message };
    }
    const live = new Map((listed?.data || []).map((d) => [d.name, d]));
    const names = new Set([...mine.databases.map((d) => d.name), ...live.keys()]);
    const data = [...names].sort().map((name) => {
      const l = live.get(name);
      const m = mine.databases.find((d) => d.name === name);
      return { name, sizeBytes: l?.sizeBytes ?? null, tables: l?.tables ?? null, charset: l?.charset ?? null, collation: l?.collation ?? null, onServer: l ? l.onServer : null, users: m?.users ?? l?.users ?? [], created_at: m?.created_at ?? null };
    });
    return { data, meta: { total: data.length, engine: engine(), engineError, quota: quota(scope), prefix: `${scope.username}_` } };
  }

  async function create(scope, input, req) {
    requireFeature(scope);
    const q = quota(scope);
    if (q.max != null && q.used >= q.max) throw limitReached('max_sql', q.max);
    const name = fullName(scope, input.name, 'database');
    const args = { name, account: scope.username };
    if (!isPg()) {
      if (input.charset) args.charset = input.charset;
      if (input.collation) args.collation = input.collation;
    }
    const created = await databases().createDatabase(args, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.db.create', args: { database: name } });
    return { name: created.name, account: scope.username, quota: quota(scope) };
  }

  // A database plus a user of the same name for an application the panel
  // installs (WordPress): the first free <user>_<base>, <user>_<base>2, …
  // across both namespaces, through create/createUser so the plan quota,
  // the prefix rules and the audit apply; a user that cannot be created
  // takes the database with it. The password is returned once to the caller.
  async function createForApp(scope, { base = 'app', password } = {}, req) {
    requireFeature(scope);
    if (!/^[a-z][a-z0-9]{0,15}$/.test(base)) throw badRequest('Invalid application name');
    const taken = new Set([...stmts.dbsFor.all(scope.accountId).map((d) => d.name), ...databases().forAccount(scope.username, SYSTEM_ROOT).users.map((u) => u.name)]);
    let short = null;
    for (let n = 1; n <= 99 && short === null; n++) {
      const candidate = n === 1 ? base : `${base}${n}`;
      if (!taken.has(ensurePrefixed(scope.username, candidate))) short = candidate;
    }
    if (short === null) throw new HttpError(409, 'conflict', `No free database name of the form ${scope.username}_${base}N`);
    const secret = password || ctx.crypto.randomPassword(24);
    const created = await create(scope, { name: short }, req);
    try {
      const user = await createUser(scope, { name: short, password: secret, databases: [created.name] }, req);
      return { database: created.name, user: user.name, password: secret, hosts: user.hosts ?? [] };
    } catch (err) {
      try { await drop(scope, created.name, req); } catch (dropErr) { ctx.logger?.warn?.({ err: dropErr, database: created.name }, 'could not drop the database after its user failed'); }
      throw err;
    }
  }

  async function drop(scope, name, req) {
    requireFeature(scope);
    ownedDatabase(scope, name);
    const result = await databases().dropDatabase(name, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.db.drop', args: { database: name } });
    return { name, dropped: true, account: scope.username, result: result ?? null };
  }

  async function check(scope, name, action, req) {
    requireFeature(scope);
    ownedDatabase(scope, name);
    const r = await databases().enqueueRepair({ action, databases: [name] }, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.db.check', args: { database: name, action: r.action, job: r.job.id } });
    return { job: r.job, action: r.action, databases: r.databases };
  }

  function listUsers(scope) {
    requireFeature(scope);
    const mine = databases().forAccount(scope.username, SYSTEM_ROOT);
    return { data: mine.users.map((u) => ({ name: u.name, hosts: isPg() ? [] : u.hosts, grants: u.grants })), meta: { total: mine.users.length, engine: engine(), prefix: `${scope.username}_` } };
  }

  async function createUser(scope, input, req) {
    requireFeature(scope);
    const name = fullName(scope, input.name, 'user');
    const dbs = input.databases || [];
    assertOwnedDatabases(scope, dbs);
    const created = await databases().createUser({ name, password: input.password, account: scope.username, databases: dbs }, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.db.user.create', args: { user: name, databases: dbs } });
    return { name: created.name, hosts: created.hosts, grants: created.grants, account: scope.username };
  }

  async function setUserPassword(scope, name, password, req) {
    requireFeature(scope);
    ownedUser(scope, name);
    const r = await databases().setUserPassword(name, password, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.db.user.password', args: { user: name } });
    return { name: r.name, hosts: r.hosts ?? [] };
  }

  async function dropUser(scope, name, req) {
    requireFeature(scope);
    ownedUser(scope, name);
    await databases().dropUser(name, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.db.user.drop', args: { user: name } });
    return { name, dropped: true };
  }

  async function grantsFor(scope, name) {
    requireFeature(scope);
    ownedUser(scope, name);
    const r = await databases().grantsFor(name, scope.ownerPrincipal);
    const owned = new Set(stmts.dbsFor.all(scope.accountId).map((d) => d.name));
    return { name, hosts: r.hosts, grants: r.grants.filter((g) => owned.has(g.database)), recorded: r.recorded, privileges: isPg() ? PG_PRIVILEGES : PRIVILEGES };
  }

  async function setGrants(scope, name, grants, req) {
    requireFeature(scope);
    ownedUser(scope, name);
    assertOwnedDatabases(scope, grants.map((g) => g.database));
    const r = await databases().setGrants(name, grants, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.db.grants', args: { user: name, grants: r.grants } });
    return { name, hosts: r.hosts, grants: r.grants, changes: r.changes };
  }

  function listAccessHosts(scope) {
    requireFeature(scope);
    if (isPg()) return { data: [], meta: { total: 0, engine: engine(), supported: false } };
    const r = databases().listAccessHosts({ account: scope.username }, scope.ownerPrincipal);
    const data = r.data.filter((h) => h.account_id === scope.accountId || h.account_id == null).map((h) => ({ id: h.id, host: h.host, scope: h.account_id == null ? 'global' : 'account', editable: h.account_id === scope.accountId, created_at: h.created_at }));
    return { data, meta: { total: data.length, engine: engine(), supported: true } };
  }

  async function addAccessHost(scope, host, req) {
    requireFeature(scope);
    if (isPg()) throw new HttpError(422, 'unsupported', 'Remote access hosts are not available for PostgreSQL');
    const r = await databases().addAccessHost({ host, account: scope.username }, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.db.access_host.add', args: { host } });
    return { id: r.id, host: r.host, scope: 'account', editable: true, applied: r.applied, failed: r.failed };
  }

  async function removeAccessHost(scope, id, req) {
    requireFeature(scope);
    const row = stmts.accessHostById.get(id, scope.accountId);
    if (!row) throw notFound('Access host');
    await databases().removeAccessHost(id, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.db.access_host.remove', args: { host: row.host } });
    return { id, host: row.host, removed: true };
  }

  async function phpMyAdmin(scope) {
    if (!featureOn(scope, 'phpmyadmin')) throw featureDisabled('phpmyadmin');
    if (isPg()) return { installed: false, url: null, featureEnabled: false, engine: 'postgres', users: [], sso: false };
    const r = await databases().phpMyAdmin(scope.ownerPrincipal);
    const featureEnabled = Boolean(settings.get('db.phpmyadmin.enabled', true)) && Boolean(r.featureEnabled);
    const users = databases().forAccount(scope.username, SYSTEM_ROOT).users.map((u) => u.name);
    return { installed: Boolean(r.installed), url: featureEnabled ? r.url ?? null : null, featureEnabled, version: r.version ?? null, users, sso: Boolean(featureEnabled && r.url && r.sso) };
  }

  // POST /databases/phpmyadmin/sso: the hidden <account>_pma user gets a fresh
  // password, which travels only inside the encrypted token payload; the
  // loopback exchange (contract §44, phpMyAdmin kind) hands it to the signon
  // script once within 60 s. Audited without the password.
  async function phpMyAdminSso(scope, req) {
    requireFeature(scope);
    const info = await phpMyAdmin(scope);
    if (!info.sso) throw new HttpError(409, 'sso_unavailable', 'phpMyAdmin single sign-on is not available on this server');
    if (!ctx.panelSso) throw new HttpError(409, 'sso_unavailable', 'phpMyAdmin single sign-on is not available on this server');
    const cred = await databases().phpmyadmin.sso.signon(scope.username, req);
    const { token, expiresAt } = ctx.panelSso.issue({ kind: 'phpmyadmin', userId: scope.actor?.id || null, account: scope.username, payload: { user: cred.user, password: cred.password, host: cred.host } });
    const url = `${databases().phpmyadmin.sso.signonUrl(info.url)}?_keel=${token}`;
    audit(req, scope, { action: 'panel.db.phpmyadmin.sso', args: { user: cred.user, expiresAt } });
    return { url, user: cred.user, expiresAt };
  }

  // The loopback exchange (GET /api/panel/sso/phpmyadmin/:token): the payload
  // the sign-on stored, once, and only while the switch is still on.
  function registerSso() {
    ctx.panelSso?.register('phpmyadmin', (claim) => {
      const p = claim.payload;
      if (!p || typeof p.user !== 'string' || typeof p.password !== 'string' || typeof p.host !== 'string') throw new HttpError(404, 'sso_token_invalid', 'This sign-on link is invalid, already used or has expired');
      if (!databases().phpmyadmin?.sso?.enabled?.()) throw new HttpError(409, 'sso_unavailable', 'phpMyAdmin single sign-on is not enabled on this server');
      return { user: p.user, password: p.password, host: p.host };
    });
  }

  // Dumps go through a root-only staging directory under /var/lib/whm (never a
  // path inside the home: mysqldump --result-file follows a symlink the tenant
  // planted at ~/backups), then backup.dump.import opens the file root-side and
  // writes it into the home under the account's uid from that descriptor, so
  // the account never needs to search /var/lib/whm (0750 whmpanel on a
  // production host); files.copy only accepts sources inside the home and is
  // not used here.
  function enqueueDump(scope, name, req) {
    requireFeature(scope);
    if (isPg()) throw new CapabilityError('mysql', 'Dumps from the panel are available for MySQL/MariaDB only');
    ownedDatabase(scope, name);
    const job = ctx.jobs.enqueue('panel.db.dump', { accountId: scope.accountId, username: scope.username, database: name, ownerId: scope.ownerPrincipal?.id ?? null, actor: scope.actor?.username ?? null }, { userId: scope.actor?.id || null });
    audit(req, scope, { action: 'panel.db.dump', args: { database: name, job: job.id } });
    return { job: { id: job.id }, database: name };
  }

  // The account's own check/repair/optimize and dump jobs (/api/system/jobs is
  // reseller-only). A db.repair job carries no accountId and its created_by is
  // the owner's principal, so it is the account's when every database it names
  // belongs to the account; anything else is 404 so job ids stay unguessable.
  function jobOf(scope, id) {
    const job = ctx.jobs.get(id);
    const p = job.params ?? {};
    const mine = job.type === 'panel.db.dump'
      ? p.accountId === scope.accountId
      : job.type === 'db.repair' && Array.isArray(p.databases) && p.databases.length > 0 && p.databases.every((n) => typeof n === 'string' && Boolean(stmts.dbByName.get(n, scope.accountId)));
    if (!JOB_TYPES.includes(job.type) || !mine) throw notFound('Job');
    return job;
  }

  function shapeJob(job) {
    const { profileId: _p, ownerId: _o, ...params } = job.params ?? {};
    return { id: job.id, type: job.type, status: job.status, progress: job.progress, message: job.message, params, result: job.result ?? null, error: job.error ?? null, errorCode: job.error_code ?? null, createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at, ...(job.logs ? { logs: job.logs } : {}) };
  }

  function getJob(scope, id) {
    requireFeature(scope);
    return shapeJob(jobOf(scope, id));
  }

  function streamJob(scope, id, req, res) {
    requireFeature(scope);
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

  // The job acts as the account's owner, read back at run time; a missing or
  // changed owner fails the job instead of falling back to a root principal.
  function ownerRequest(params, account) {
    const owner = params.ownerId != null ? stmts.ownerById.get(params.ownerId) : null;
    if (!owner) throw new Error(`The owner of account "${params.username}" no longer exists; request the dump again`);
    if (account.owner_id !== owner.id) throw new Error(`Account "${params.username}" changed owner since the dump was requested; request it again`);
    const req = { user: { id: owner.id, username: owner.username, role: owner.role }, ip: null, id: null };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    return req;
  }

  async function runDump(job) {
    const { accountId, username, database: name } = job.params;
    const account = db.prepare('SELECT id, username, owner_id, home_dir, uid, gid FROM accounts WHERE id = ? AND username = ?').get(accountId, username);
    if (!account) throw new Error(`Account "${username}" no longer exists`);
    if (!stmts.dbByName.get(name, account.id)) throw new Error(`Database "${name}" no longer belongs to ${username}`);
    const req = ownerRequest(job.params, account);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const staging = `${DUMP_STAGING_ROOT}/${username}`;
    const file = `${staging}/${name}-${stamp}.sql`;
    const home = account.home_dir || `${settings.get('basic.home_root', '/home')}/${username}`;
    const target = `${home}/backups/${name}-${stamp}.sql`;
    job.log(`Dumping ${name} for ${username}`);
    await ctx.agent.op('fs.mkdir', { path: DUMP_STAGING_ROOT, mode: '0711', owner: 'root' });
    await ctx.agent.op('fs.mkdir', { path: staging, mode: '0700', owner: 'root' });
    try {
      const dumped = await ctx.databases.dump({ path: file, databases: [name] }, req);
      await ctx.agent.op('files.mkdir', { username, path: `${home}/backups`, mode: '0700' });
      await ctx.agent.op('backup.dump.import', { username, from: file, to: target });
      job.log(`Dump copied to ${target}`);
      req.audit({ action: 'panel.db.dump.done', target: username, args: { database: name, file: `backups/${name}-${stamp}.sql`, sizeBytes: dumped?.sizeBytes ?? null } });
      return { database: name, file: `backups/${name}-${stamp}.sql`, sizeBytes: dumped?.sizeBytes ?? null };
    } finally {
      await ctx.agent.op('fs.remove', { path: file }).catch(() => {});
    }
  }

  return {
    engine, list, create, createForApp, drop, check,
    listUsers, createUser, setUserPassword, dropUser, grantsFor, setGrants,
    listAccessHosts, addAccessHost, removeAccessHost,
    phpMyAdmin, phpMyAdminSso, registerSso, enqueueDump, runDump, getJob, streamJob, quota, ensurePrefixed,
  };
}
