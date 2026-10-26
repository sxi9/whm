import crypto from 'node:crypto';
import path from 'node:path';
import { json } from '../db/index.js';
import { notFound, forbidden, conflict, unprocessable, HttpError, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';
import { PRIVILEGES } from './database-services.js';

// Transfers. Attached as ctx.transfers; other categories may call:
//   transfers.capabilityStatus()                                  -> { ssh, sshpass, rsync, tar, mysql } install state
//   transfers.sessions.create({ host, port, user, authType, password|privateKey }, user, req) -> probed remote connection (secret encrypted)
//   transfers.sessions.list(user) / get(id, user) / remove(id, user, req) / probe(id, user, req) / accounts(id, user, { refresh })
//   transfers.previewTransfer({ sessionId, accounts, options }, user) / startTransfer(input, user, req) -> { job, run }
//   transfers.archives.list(user) / inspect(path, user) / uploads.begin|status|chunk|finish|abort
//   transfers.startRestore({ path, username?, domain?, package?, password?, options }, user, req) -> { job, run }  (restore.cpmove job)
//   transfers.restoreArchive(path, overrides, user, req)            -> same, for the Backup category's restore flow
//   transfers.previewConvertAddon({ domain, username, ... }, user) / startConvertAddon(input, user, req)
//   transfers.listRuns({ kind, limit }, user) / getRun(id, user) / listJobs({ limit }, user) / getJob(id, user)
// Per-account work goes through ctx.accounts.create/setPassword, ctx.databases
// (createDatabase, createUser, assign), ctx.dns (saveRawZone, ensureZoneForDomain),
// ctx.web.ensureVhost and ctx.mail.setRouting. A missing daemon leaves a step
// 'pending' instead of failing the whole account; a missing ssh/rsync/tar raises
// CapabilityError before a run starts.
// Untrusted input (archives, remote servers) never reaches MySQL as raw SQL:
// dumps are imported into a database named after the local account after the
// agent scans them, and database users are rebuilt from parsed statements with
// the grants limited to that account's databases.

export const RUN_KINDS = ['transfer', 'restore', 'convert_addon'];
export const ITEM_STATUSES = ['queued', 'running', 'done', 'pending', 'failed', 'skipped'];
export const JOB_TYPES = { transfer: 'transfer.remote', restore: 'restore.cpmove', convert_addon: 'transfer.convert_addon', cleanup: 'transfer.cleanup' };
export const ARCHIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(tar\.gz|tgz|tar)$/;
export const UPLOAD_CHUNK_BYTES = 1_310_720;
const ZONE_CANDIDATES = (domain) => [`/var/named/${domain}.db`, `/etc/bind/zones/${domain}.db`, `/var/lib/bind/${domain}.db`, `/etc/bind/db.${domain}`, `/var/named/zones/${domain}.db`];
const HOME_EXCLUDES = ['.cpanel/caches/', '.cpanel/datastore/', 'tmp/', '.cphorde/', 'cpbackup-exclude.conf'];
const SHADOW_HASH = /^\$[A-Za-z0-9]{1,6}\$[A-Za-z0-9./$=+,-]{8,500}$/;
const AUTH_PLUGINS = new Set(['mysql_native_password', 'caching_sha2_password', 'sha256_password', 'ed25519']);
const AUTH_HASH = /^(?:\*[0-9A-F]{40}|0x[0-9A-Fa-f]{2,1024}|\$[A-Za-z0-9./$+=]{8,300}|[A-Za-z0-9+/=]{20,100})$/;
const SYSTEM_DATABASES = new Set(['mysql', 'sys', 'information_schema', 'performance_schema']);
// Socket-client timeouts for the long agent ops (split mode defaults to 1 h);
// they match the maxima of the ops' own timeoutMs schemas.
const COPY_TIMEOUT_MS = 86_400_000;
const IMPORT_TIMEOUT_MS = 7_200_000;
const INSPECT_CACHE_MS = 3600_000;

const isCapabilityMissing = (err) => err instanceof CapabilityError || err?.code === 'capability_missing' || err?.code === 'binary_not_found' || err?.status === 501;
const isConflict = (err) => err?.status === 409 || err?.code === 'exists' || err?.code === 'conflict';
const belongsTo = (name, prefix) => name === prefix || name.startsWith(`${prefix}_`);

// A database user of the source account renamed for the local one: "bob" ->
// "robert", "bob_app" -> "robert_app".
export function renameForAccount(name, from, to) {
  if (name === from) return to;
  if (name.startsWith(`${from}_`)) return `${to}${name.slice(from.length)}`;
  return `${to}_${name}`;
}

// The local name of an imported database: always "<username>_…", so a dump
// called mysql.sql or sys.sql can never land in a system schema.
export function targetDatabaseName(name, from, to) {
  return name.startsWith(`${from}_`) ? `${to}${name.slice(from.length)}` : `${to}_${name}`;
}

const ACCOUNT_RE = /(['`"])([A-Za-z0-9_.-]{1,80})\1@(['`"])([A-Za-z0-9.%:_-]{1,255})\3/;
const PRIVILEGE_SET = new Set(PRIVILEGES);
const unescapeLike = (s) => s.replace(/\\([_%])/g, '$1');

function parseAuthClause(text) {
  let m = text.match(/IDENTIFIED\s+WITH\s+['`"]?([A-Za-z0-9_]+)['`"]?(?:\s+(?:AS|BY)\s+(?:'([^']*)'|(0x[0-9A-Fa-f]+)))?/i);
  if (m) return { plugin: m[1], hash: m[2] ?? m[3] ?? null };
  m = text.match(/IDENTIFIED\s+VIA\s+['`"]?([A-Za-z0-9_]+)['`"]?(?:\s+USING\s+(?:'([^']*)'|(0x[0-9A-Fa-f]+)))?/i);
  if (m) return { plugin: m[1], hash: m[2] ?? m[3] ?? null };
  m = text.match(/IDENTIFIED\s+BY\s+PASSWORD\s+'([^']*)'/i);
  if (m) return { plugin: 'mysql_native_password', hash: m[1] };
  return null;
}

const usableAuth = (auth) => (auth && auth.hash && AUTH_PLUGINS.has(auth.plugin) && AUTH_HASH.test(auth.hash) ? { plugin: auth.plugin, hash: auth.hash } : null);

// Turns the CREATE USER / GRANT text captured from a source server or an
// archive's mysql.sql into per-user records, keeping only what an account may
// own: users named <src> or <src>_…, grants on <src>_….* without GRANT OPTION,
// database-level privileges from the panel's list. Everything else is refused
// with a reason instead of being replayed.
export function parseGrantStatements(statements, src) {
  const users = new Map();
  const refused = [];
  const userOf = (acct) => {
    const key = `${acct.user}@${acct.host}`;
    if (!users.has(key)) users.set(key, { user: acct.user, host: acct.host, auth: null, grants: [] });
    return users.get(key);
  };
  const owned = (acct, statement) => {
    if (!belongsTo(acct.user, src)) { refused.push({ statement, reason: `user '${acct.user}' does not belong to account "${src}"` }); return false; }
    return true;
  };
  for (const raw of statements) {
    const statement = String(raw).trim().replace(/;$/, '');
    if (!statement) continue;
    const grantee = statement.match(ACCOUNT_RE);
    if (!grantee) { refused.push({ statement, reason: 'no user@host grantee' }); continue; }
    const acct = { user: grantee[2], host: grantee[4] };
    if (/^CREATE\s+USER\b/i.test(statement)) {
      if (!owned(acct, statement)) continue;
      const u = userOf(acct);
      u.auth = u.auth || parseAuthClause(statement.slice(grantee.index + grantee[0].length));
      continue;
    }
    const grant = statement.match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i);
    if (!grant) { refused.push({ statement, reason: 'only CREATE USER and GRANT … ON … TO statements are replayed' }); continue; }
    if (!owned(acct, statement)) continue;
    const tail = statement.slice(grant[0].length);
    if (/\bWITH\s+GRANT\s+OPTION\b/i.test(tail)) { refused.push({ statement, reason: 'WITH GRANT OPTION is not replayed' }); continue; }
    const privileges = grant[1].split(',').map((p) => p.trim().toUpperCase().replace(/\s+/g, ' ')).map((p) => (p === 'ALL' ? 'ALL PRIVILEGES' : p));
    const object = grant[2].trim();
    if (/^\*\.\*$/.test(object)) {
      if (privileges.length === 1 && privileges[0] === 'USAGE') {
        const u = userOf(acct);
        u.auth = u.auth || parseAuthClause(tail);
      } else refused.push({ statement, reason: `global privileges (${privileges.join(', ')} ON *.*) are not replayed` });
      continue;
    }
    const obj = object.match(/^(?:`((?:[^`]|``)+)`|'([^']+)'|([A-Za-z0-9_\\%]+))\.(\*|`[^`]+`|[A-Za-z0-9_]+)$/);
    if (!obj) { refused.push({ statement, reason: `unsupported grant object ${object}` }); continue; }
    const database = unescapeLike((obj[1] ?? obj[2] ?? obj[3]).replace(/``/g, '`'));
    if (obj[4] !== '*') { refused.push({ statement, reason: `table-level grant on ${database}.${obj[4]} is not replayed` }); continue; }
    if (!/^[a-z0-9_]{1,64}$/.test(database) || SYSTEM_DATABASES.has(database) || !belongsTo(database, src)) { refused.push({ statement, reason: `database "${database}" does not belong to account "${src}"` }); continue; }
    const bad = privileges.filter((p) => p !== 'USAGE' && !PRIVILEGE_SET.has(p));
    if (bad.length) { refused.push({ statement, reason: `privilege ${bad.join(', ')} is not a database-level privilege` }); continue; }
    const u = userOf(acct);
    u.auth = u.auth || parseAuthClause(tail);
    const privs = privileges.filter((p) => p !== 'USAGE');
    if (privs.length) u.grants.push({ database, privileges: privs.includes('ALL PRIVILEGES') ? ['ALL PRIVILEGES'] : [...new Set(privs)] });
  }
  return { users: [...users.values()], refused };
}

// cPanel addon/parked/subdomain lists inside an account archive.
export function parseDomainLists({ addons, pds, sds2 }) {
  const out = [];
  for (const line of String(addons || '').split('\n')) { const m = line.match(/^([a-z0-9.-]+)=([a-z0-9._-]+)\s*$/i); if (m) out.push({ domain: m[1].toLowerCase(), type: 'addon', via: m[2].replace(/_/g, '.').toLowerCase() }); }
  for (const line of String(pds || '').split('\n')) { const d = line.trim().toLowerCase(); if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) out.push({ domain: d, type: 'parked' }); }
  for (const line of String(sds2 || '').split('\n')) { const m = line.match(/^([a-z0-9._-]+)=(\/\S+)?\s*$/i); if (m) out.push({ domain: m[1].replace(/_/g, '.').toLowerCase(), type: 'sub', docroot: m[2] || null }); }
  return out;
}

export function parseUserdata(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) { const m = line.match(/^([a-z_]+):\s*(.*)$/); if (m) out[m[1]] = m[2].trim(); }
  return { documentroot: out.documentroot || null, servername: out.servername?.toLowerCase() || null, ip: out.ip || null, phpversion: out.phpversion || null };
}

export function createTransfersService(ctx) {
  const { db, agent, capabilities, settings, logger, jobs } = ctx;
  const stmts = {
    insertSession: db.prepare('INSERT INTO transfer_sessions (host, port, user, auth_type, secret_enc, created_by, probe_json) VALUES (@host, @port, @user, @auth_type, @secret_enc, @created_by, @probe_json)'),
    session: db.prepare('SELECT s.*, u.username AS created_by_name FROM transfer_sessions s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?'),
    sessions: db.prepare('SELECT s.*, u.username AS created_by_name FROM transfer_sessions s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.id DESC'),
    sessionProbe: db.prepare("UPDATE transfer_sessions SET probe_json = ?, last_used_at = datetime('now') WHERE id = ?"),
    sessionAccounts: db.prepare("UPDATE transfer_sessions SET accounts_json = ?, last_used_at = datetime('now') WHERE id = ?"),
    deleteSession: db.prepare('DELETE FROM transfer_sessions WHERE id = ?'),
    pruneSessions: db.prepare("DELETE FROM transfer_sessions WHERE last_used_at < datetime('now', ?)"),
    insertRun: db.prepare('INSERT INTO transfer_runs (kind, session_id, created_by, requested_by, status, source, params_json) VALUES (@kind, @session_id, @created_by, @requested_by, @status, @source, @params_json)'),
    setRunJob: db.prepare('UPDATE transfer_runs SET job_id = ? WHERE id = ?'),
    runStatus: db.prepare('UPDATE transfer_runs SET status = ? WHERE id = ?'),
    finishRun: db.prepare("UPDATE transfer_runs SET status = ?, totals_json = ?, finished_at = datetime('now') WHERE id = ?"),
    run: db.prepare('SELECT r.*, u.username AS created_by_name FROM transfer_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ?'),
    runs: db.prepare('SELECT r.*, u.username AS created_by_name FROM transfer_runs r LEFT JOIN users u ON u.id = r.created_by WHERE (@kind IS NULL OR r.kind = @kind) AND (@owner IS NULL OR r.created_by = @owner) ORDER BY r.id DESC LIMIT @limit'),
    pruneRuns: db.prepare("DELETE FROM transfer_runs WHERE finished_at IS NOT NULL AND finished_at < datetime('now', ?)"),
    insertItem: db.prepare('INSERT INTO transfer_run_items (run_id, source_username, username, domain, status, detail, steps_json) VALUES (@run_id, @source_username, @username, @domain, @status, @detail, @steps_json)'),
    items: db.prepare('SELECT * FROM transfer_run_items WHERE run_id = ? ORDER BY id'),
    queuedItems: db.prepare("SELECT * FROM transfer_run_items WHERE run_id = ? AND status = 'queued' ORDER BY id"),
    itemStatus: db.prepare('UPDATE transfer_run_items SET status = ? WHERE id = ?'),
    finishItem: db.prepare("UPDATE transfer_run_items SET status = @status, detail = @detail, steps_json = @steps_json, finished_at = datetime('now') WHERE id = @id"),
    itemCounts: db.prepare('SELECT status, COUNT(*) AS n FROM transfer_run_items WHERE run_id = ? GROUP BY status'),
    jobsOfKinds: db.prepare("SELECT j.*, u.username AS created_by_name FROM jobs j LEFT JOIN users u ON u.id = j.created_by WHERE (j.type LIKE 'transfer.%' OR j.type LIKE 'restore.%') AND (@owner IS NULL OR j.created_by = @owner) AND (@status IS NULL OR j.status = @status) ORDER BY j.id DESC LIMIT @limit"),
    job: db.prepare('SELECT j.*, u.username AS created_by_name FROM jobs j LEFT JOIN users u ON u.id = j.created_by WHERE j.id = ?'),
    runByJob: db.prepare('SELECT id, kind FROM transfer_runs WHERE job_id = ?'),
    account: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.username = ?'),
    accountById: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.id = ?'),
    domainHosted: db.prepare('SELECT d.domain, d.type, a.username FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.domain = ?'),
    addonRow: db.prepare("SELECT d.*, a.username, a.owner_id, a.home_dir, a.ip, a.domain AS main_domain, a.package_name, a.id AS account_id FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.domain = ? AND d.type = 'addon'"),
    addonRows: db.prepare("SELECT d.*, a.username, a.owner_id, a.home_dir, a.domain AS main_domain, a.package_name FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.type = 'addon' AND (@owner IS NULL OR a.owner_id = @owner) ORDER BY a.username, d.domain"),
    linkedSubs: db.prepare("SELECT * FROM account_domains WHERE account_id = ? AND type = 'sub' AND docroot = ?"),
    insertDomain: db.prepare('INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, ?, ?, ?)'),
    insertDomainFull: db.prepare('INSERT INTO account_domains (id, account_id, domain, type, docroot, php_version, created_at) VALUES (@id, @account_id, @domain, @type, @docroot, @php_version, @created_at)'),
    deleteDomain: db.prepare('DELETE FROM account_domains WHERE id = ?'),
    userById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
    packageByName: db.prepare('SELECT id, name FROM packages WHERE name = ?'),
    activeDbProfile: db.prepare('SELECT * FROM db_instances WHERE is_active = 1 ORDER BY id LIMIT 1'),
  };
  const uploads = new Map();
  const inspectCache = new Map();

  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req ?? null, entry));
  const stagingDir = () => settings.get('transfers.staging_dir', '/var/lib/whm/transfers');
  const uploadDir = () => path.join(stagingDir(), 'uploads');
  const retentionDays = () => Math.max(1, Number(settings.get('transfers.run_retention_days', 90)) || 90);
  const sessionTtlHours = () => Math.max(1, Number(settings.get('transfers.session_ttl_hours', 24)) || 24);
  const bwlimit = () => Math.max(0, Number(settings.get('transfers.rsync_bwlimit_kbps', 0)) || 0);

  function assertRoot(user, what = 'This operation') {
    if (!isRoot(user)) throw forbidden(`${what} requires the root user`);
  }

  // A request-like principal for the job worker so ctx.accounts / ctx.dns audit
  // and authorise as the user who started the run.
  function actorRequest(userId, requestId) {
    const user = (userId && stmts.userById.get(userId)) || { id: null, username: 'scheduler', role: 'root' };
    const req = { user, ip: null, id: requestId ?? null };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    return req;
  }

  // Agent failures that are the remote server's or the caller's fault surface
  // as 422 with the op's message; a missing local tool is an install prompt.
  function translate(err) {
    if (isCapabilityMissing(err)) return err instanceof CapabilityError ? err : new CapabilityError(/sshpass/i.test(err.message) ? 'sshpass' : /rsync/i.test(err.message) ? 'rsync' : /tar\b/i.test(err.message) ? 'tar' : /mysql|mariadb/i.test(err.message) ? 'mysql' : 'ssh', err.message);
    if (['ssh_unreachable', 'ssh_auth_failed', 'ssh_hostkey_changed', 'remote_command_failed', 'remote_tool_missing', 'remote_db_auth_failed', 'remote_db_unreachable', 'invalid_archive', 'rsync_failed', 'extract_failed', 'import_failed'].includes(err?.code)) return new HttpError(422, err.code, err.message);
    if (err?.code === 'path_not_allowed') return forbidden(err.message);
    return err;
  }

  function capabilityStatus() {
    const caps = {
      ssh: { installed: capabilities.has('ssh'), label: 'OpenSSH client (remote transfers)', packages: 'openssh-client / openssh-clients' },
      sshpass: { installed: capabilities.has('sshpass'), label: 'sshpass (password logins to remote servers)', packages: 'sshpass' },
      rsync: { installed: capabilities.has('rsync'), label: 'rsync (home directory copies)', packages: 'rsync' },
      tar: { installed: capabilities.has('tar'), label: 'tar (cpmove archives)', packages: 'tar' },
      mysql: { installed: capabilities.has('mysql'), label: 'MySQL/MariaDB client (database imports)', packages: 'mariadb-client / mysql-client' },
    };
    return { ...caps, services: { accounts: Boolean(ctx.accounts), databases: Boolean(ctx.databases), dns: Boolean(ctx.dns), web: Boolean(ctx.web), mail: Boolean(ctx.mail?.setRouting) }, stagingDir: stagingDir(), uploadDir: uploadDir(), bwlimitKbps: bwlimit() };
  }

  function requireTools({ remote = false, password = false, rsync = false, tar = false } = {}) {
    if (remote) capabilities.require('ssh', 'The OpenSSH client (ssh) is not installed on this server, so remote servers cannot be reached. Install openssh-client (Debian/Ubuntu) or openssh-clients (RHEL).');
    if (remote && password) capabilities.require('sshpass', 'Password logins to remote servers need sshpass. Install the sshpass package, or connect with an SSH private key instead.');
    if (rsync) capabilities.require('rsync', 'rsync is not installed on this server, so home directories cannot be copied. Install the rsync package (or skip the home directory).');
    if (tar) capabilities.require('tar', 'tar is not installed on this server, so account archives cannot be read.');
  }

  // --------------------------------------------------------------- sessions ---

  function shapeSession(row, { withAccounts = false } = {}) {
    if (!row) return null;
    const expiresAt = new Date(new Date(`${row.last_used_at.replace(' ', 'T')}Z`).getTime() + sessionTtlHours() * 3600_000).toISOString();
    const out = { id: row.id, host: row.host, port: row.port, user: row.user, authType: row.auth_type, probe: json.parse(row.probe_json, {}), created_by: row.created_by_name, created_at: row.created_at, last_used_at: row.last_used_at, expiresAt, accountsCached: Boolean(row.accounts_json) };
    if (withAccounts) out.accounts = json.parse(row.accounts_json, null);
    return out;
  }

  function loadSession(id, user) {
    assertRoot(user, 'The Transfer Tool');
    const row = stmts.session.get(id);
    if (!row) throw notFound('Transfer session');
    return row;
  }

  function connectionOf(row) {
    const secret = ctx.crypto.decrypt(row.secret_enc);
    return { host: row.host, port: row.port, user: row.user, ...(row.auth_type === 'password' ? { password: secret } : { privateKey: secret }) };
  }

  async function remote(name, row, args, req) {
    try {
      return await agent.op(name, { connection: connectionOf(row), ...args }, { req });
    } catch (err) {
      throw translate(err);
    }
  }

  function annotateAccounts(accounts) {
    return accounts.map((a) => {
      const local = stmts.account.get(a.username);
      const domainHost = a.domain ? stmts.domainHosted.get(a.domain) : null;
      return { ...a, localExists: Boolean(local), localDomain: local?.domain ?? null, domainHostedBy: domainHost?.username ?? null, suggestedUsername: a.username, suggestedDomain: a.domain || null };
    });
  }

  const sessions = {
    async create(input, user, req) {
      assertRoot(user, 'The Transfer Tool');
      requireTools({ remote: true, password: input.authType === 'password' });
      const secret = input.authType === 'password' ? input.password : input.privateKey;
      if (!secret) throw unprocessable(`A ${input.authType === 'password' ? 'password' : 'private key'} is required`, { [input.authType === 'password' ? 'password' : 'privateKey']: ['Required'] });
      const connection = { host: input.host, port: input.port ?? 22, user: input.user || 'root', ...(input.authType === 'password' ? { password: secret } : { privateKey: secret }) };
      let probe;
      try { probe = await agent.op('transfer.remote.probe', { connection }, { req }); } catch (err) { throw translate(err); }
      const { lastInsertRowid } = stmts.insertSession.run({ host: connection.host, port: connection.port, user: connection.user, auth_type: input.authType, secret_enc: ctx.crypto.encrypt(secret), created_by: user.id ?? null, probe_json: JSON.stringify(probe) });
      audit(req, { action: 'transfer.session.create', target: `${connection.user}@${connection.host}:${connection.port}`, args: { authType: input.authType, cpanel: probe.cpanel, isRoot: probe.isRoot } });
      return shapeSession(stmts.session.get(lastInsertRowid));
    },
    list(user) {
      assertRoot(user, 'The Transfer Tool');
      stmts.pruneSessions.run(`-${sessionTtlHours()} hours`);
      return stmts.sessions.all().map((r) => shapeSession(r));
    },
    get(id, user) { return shapeSession(loadSession(id, user), { withAccounts: true }); },
    remove(id, user, req) {
      const row = loadSession(id, user);
      stmts.deleteSession.run(id);
      audit(req, { action: 'transfer.session.delete', target: `${row.user}@${row.host}` });
      return { id, deleted: true };
    },
    async probe(id, user, req) {
      const row = loadSession(id, user);
      requireTools({ remote: true, password: row.auth_type === 'password' });
      const probe = await remote('transfer.remote.probe', row, {}, req);
      stmts.sessionProbe.run(JSON.stringify(probe), id);
      return shapeSession(stmts.session.get(id));
    },
    async accounts(id, user, { refresh = false } = {}, req) {
      const row = loadSession(id, user);
      const cached = json.parse(row.accounts_json, null);
      if (cached && !refresh) return { ...cached, accounts: annotateAccounts(cached.accounts), cached: true };
      requireTools({ remote: true, password: row.auth_type === 'password' });
      const listed = await remote('transfer.remote.list_accounts', row, {}, req);
      const fresh = { cpanel: listed.cpanel, accounts: listed.accounts, fetchedAt: new Date().toISOString() };
      stmts.sessionAccounts.run(JSON.stringify(fresh), id);
      return { ...fresh, accounts: annotateAccounts(fresh.accounts), cached: false };
    },
  };

  // ------------------------------------------------------------------- runs ---

  function createRun(kind, { user, sessionId = null, source = null, params, items }) {
    return db.transaction(() => {
      const { lastInsertRowid } = stmts.insertRun.run({ kind, session_id: sessionId, created_by: user.id ?? null, requested_by: user.username, status: 'queued', source, params_json: JSON.stringify(params) });
      for (const it of items) stmts.insertItem.run({ run_id: lastInsertRowid, source_username: it.sourceUsername ?? null, username: it.username, domain: it.domain ?? null, status: it.status ?? 'queued', detail: it.detail ?? null, steps_json: JSON.stringify(it.steps ?? {}) });
      return Number(lastInsertRowid);
    })();
  }

  const shapeItem = (r) => ({ ...r, steps: json.parse(r.steps_json, {}), steps_json: undefined });
  function shapeRun(row, { withItems = false } = {}) {
    if (!row) return null;
    const run = { ...row, params: json.parse(row.params_json, {}), totals: json.parse(row.totals_json, {}), params_json: undefined, totals_json: undefined };
    if (run.params.password) run.params.password = '[set]';
    for (const a of run.params.accounts || []) if (a.password) a.password = '[set]';
    if (!Object.keys(run.totals).length) run.totals = totalsOf(row.id);
    if (withItems) run.items = stmts.items.all(row.id).map(shapeItem);
    return run;
  }

  function loadRun(id, user) {
    const row = stmts.run.get(id);
    if (!row) throw notFound('Run');
    if (!isRoot(user) && row.created_by !== user.id) throw forbidden('That run belongs to another reseller');
    return row;
  }

  function totalsOf(runId) {
    const totals = { total: 0, done: 0, pending: 0, failed: 0, skipped: 0, queued: 0, running: 0 };
    for (const { status, n } of stmts.itemCounts.all(runId)) { totals[status] = n; totals.total += n; }
    return totals;
  }

  const finishItem = (item, { status, detail, steps }) => stmts.finishItem.run({ id: item.id, status, detail: detail ?? null, steps_json: JSON.stringify(steps ?? {}) });

  function outcomeOf(steps) {
    const flat = [];
    for (const v of Object.values(steps)) { if (Array.isArray(v)) flat.push(...v); else if (v && typeof v === 'object' && v.status) flat.push(v); }
    const failed = flat.filter((s) => s.status === 'failed');
    const pending = flat.filter((s) => s.status === 'pending');
    if (failed.length) return { status: 'failed', detail: failed.map((s) => `${s.name || s.domain || s.label || 'step'}: ${s.detail}`).join('; ') };
    if (pending.length) return { status: 'pending', detail: [...new Set(pending.map((s) => s.detail))].join('; ') };
    return { status: 'done', detail: null };
  }

  // Runs one provisioning step and turns the three kinds of failure into a
  // recorded status instead of aborting the account.
  async function step(fn, { label } = {}) {
    try {
      const r = await fn();
      return { status: 'applied', ...(r || {}), label };
    } catch (err) {
      if (isCapabilityMissing(err)) return { status: 'pending', detail: err.message, label };
      return { status: 'failed', detail: err.message, label };
    }
  }

  function finishRunRow(runId, items) {
    const totals = totalsOf(runId);
    stmts.finishRun.run(totals.failed && totals.failed === items.length ? 'failed' : 'done', JSON.stringify(totals), runId);
    return totals;
  }

  // ---------------------------------------------------------- shared steps ---

  function localDbCredentials() {
    let row = null;
    try { row = stmts.activeDbProfile.get(); } catch { return undefined; }
    if (!row) return undefined;
    if (!row.admin_user && !row.admin_password_enc && (row.is_local || !row.host || row.host === 'localhost')) return undefined;
    const creds = {};
    if (row.host && row.host !== 'localhost') creds.host = row.host;
    if (row.port) creds.port = row.port;
    if (row.admin_user) creds.user = row.admin_user;
    if (row.admin_password_enc) creds.password = ctx.crypto.decrypt(row.admin_password_enc);
    return creds;
  }

  // Creates the local account for an imported one (or reuses it when
  // overwriting). DNS is left out so the zone of the source can be imported.
  async function ensureAccount({ username, domain, pkg, contactEmail, overwrite }, user, req, log) {
    const existing = stmts.account.get(username);
    if (existing) {
      if (!isRoot(user) && existing.owner_id !== user.id) throw forbidden(`Account "${username}" belongs to another reseller`);
      if (!overwrite) throw conflict(`Account "${username}" already exists on this server; enable "overwrite" to merge into it`);
      log(`${username}: account exists, merging into it`);
      return { account: existing, created: false };
    }
    const hosted = stmts.domainHosted.get(domain);
    if (hosted) throw conflict(`The domain ${domain} is already hosted by account "${hosted.username}"`);
    const created = await ctx.accounts.create({ username, domain, package: pkg || undefined, contactEmail: contactEmail || undefined, provision: { web: true, dns: false, mail: true } }, user, req);
    log(`${username}: account created (${domain}, package ${created.package_name}${created.provisioning?.systemUser ? ', Linux user provisioned' : ', no Linux user on this host'})`);
    return { account: stmts.account.get(username), created: true, provisioning: created.provisioning };
  }

  // The database is created and the dump imported under one and the same
  // "<username>_…" name; the agent refuses dumps carrying user, grant, global or
  // foreign-DEFINER statements before anything runs as the MySQL admin.
  async function importDatabase({ account, name, dumpPath, overwrite, sourceUsername }, user, req) {
    if (!ctx.databases) return { name, status: 'skipped', detail: 'Database Services is not loaded' };
    if (!name.startsWith(`${account.username}_`) || SYSTEM_DATABASES.has(name)) return { name, status: 'failed', detail: `"${name}" is not a database name of account ${account.username}` };
    try {
      const created = await ctx.databases.createDatabase({ name, account: account.username }, user, req);
      if (created.name !== name) return { name, status: 'failed', detail: `the database was created as "${created.name}" instead of "${name}"; import the dump by hand` };
    } catch (err) {
      if (isCapabilityMissing(err)) return { name, status: 'pending', detail: err.message };
      if (!isConflict(err)) return { name, status: 'failed', detail: err.message };
      if (!overwrite) return { name, status: 'skipped', detail: 'database already exists (overwrite is off)' };
    }
    try {
      await agent.op('transfer.mysql.import', { path: dumpPath, database: name, definerPrefix: sourceUsername, credentials: localDbCredentials() }, { req, timeoutMs: IMPORT_TIMEOUT_MS });
      return { name, status: 'applied', detail: 'imported' };
    } catch (err) {
      return { name, status: isCapabilityMissing(err) ? 'pending' : 'failed', detail: err.message };
    }
  }

  const randomPassword = () => `${crypto.randomBytes(18).toString('base64url')}!Aa1`;

  // Rebuilds the source account's database users from parsed statements: a user
  // with a supported password hash is recreated with it (so applications keep
  // working), the rest get a fresh random password; grants are limited to the
  // account's own databases and refused statements are reported, never run.
  async function replayGrants({ account, statements, sourceUsername }, user, req) {
    const parsed = parseGrantStatements(statements, sourceUsername);
    if (!parsed.users.length && !parsed.refused.length) return { status: 'skipped', detail: 'no database users on the source' };
    if (!ctx.databases) return { status: 'skipped', detail: 'Database Services is not loaded' };
    const results = { hashed: [], fresh: [], existing: [], failed: [] };
    let pending = null;
    for (const u of parsed.users) {
      const name = renameForAccount(u.user, sourceUsername, account.username);
      const grants = u.grants.map((g) => ({ database: targetDatabaseName(g.database, sourceUsername, account.username), privileges: g.privileges }));
      const auth = usableAuth(u.auth);
      try {
        if (auth) {
          await agent.op('transfer.mysql.create_user', { user: name, host: u.host, ownerPrefix: account.username, auth, grants, credentials: localDbCredentials() }, { req });
          try { await ctx.databases.assign({ kind: 'user', name, account: account.username }, user, req); } catch (err) { logger.warn({ err, name }, 'transfer: could not map database user'); }
          results.hashed.push(`${name}@${u.host}`);
        } else {
          await ctx.databases.createUser({ name, account: account.username, password: randomPassword(), databases: grants.map((g) => g.database) }, user, req);
          results.fresh.push(name);
        }
      } catch (err) {
        if (isCapabilityMissing(err)) { pending = err.message; break; }
        if (isConflict(err)) results.existing.push(name);
        else results.failed.push(`${name}: ${err.message}`);
      }
    }
    const parts = [];
    if (results.hashed.length) parts.push(`${results.hashed.length} user(s) recreated with their password (${results.hashed.join(', ')})`);
    if (results.fresh.length) parts.push(`${results.fresh.length} user(s) recreated with a new random password, set one in Manage Database Users (${results.fresh.join(', ')})`);
    if (results.existing.length) parts.push(`${results.existing.length} already existed (${results.existing.join(', ')})`);
    if (results.failed.length) parts.push(`failed: ${results.failed.join('; ')}`);
    if (parsed.refused.length) parts.push(`${parsed.refused.length} statement(s) refused: ${[...new Set(parsed.refused.map((r) => r.reason))].join('; ')}`);
    if (pending) return { status: 'pending', detail: `${pending}${parts.length ? ` (${parts.join('; ')})` : ''}`, refused: parsed.refused };
    const status = results.failed.length ? 'failed' : parsed.refused.length || results.fresh.length ? 'pending' : 'applied';
    return { status, detail: parts.join('; ') || 'nothing to replay', refused: parsed.refused };
  }

  // Sets the Linux password of a created account: the one entered in the form,
  // else the crypt hash read from the source (/etc/shadow or the archive's
  // shadow member); without either the step stays pending so the admin knows
  // nobody can log in yet.
  async function applyPassword({ account, created, password, readHash }, user, req) {
    if (password) {
      try { await ctx.accounts.setPassword(account.username, password, user, req); return { status: 'applied', detail: 'password set from the form' }; }
      catch (err) { return { status: isCapabilityMissing(err) ? 'pending' : 'failed', detail: err.message }; }
    }
    let hash = null;
    let reason = null;
    try {
      const r = await readHash();
      hash = r?.hash && SHADOW_HASH.test(r.hash) ? r.hash : null;
      reason = r?.reason || (r?.locked ? 'the source account is locked' : 'no password hash on the source');
    } catch (err) { reason = err.message; }
    if (!hash) {
      if (!created) return { status: 'skipped', detail: `existing password kept (${reason})` };
      return { status: 'pending', detail: `no password set (${reason}); set one under Password Modification before the user can log in` };
    }
    if (account.uid == null) return { status: 'pending', detail: 'no Linux user on this host; the password hash is applied when one is provisioned' };
    try {
      await agent.op('transfer.user.set_password_hash', { username: account.username, hash }, { req });
      audit(req, { action: 'account.password', target: account.username, args: { source: 'hash' } });
      return { status: 'applied', detail: 'password hash copied from the source' };
    } catch (err) {
      return { status: isCapabilityMissing(err) ? 'pending' : 'failed', detail: err.message };
    }
  }

  async function importZone({ account, domain, text, remoteIps }, user, req) {
    if (!ctx.dns) return { domain, status: 'skipped', detail: 'DNS Functions is not loaded' };
    if (text) {
      let body = text;
      if (account.ip) for (const ip of (remoteIps || []).filter((x) => x && x !== account.ip)) body = body.split(ip).join(account.ip);
      try {
        const r = await ctx.dns.saveRawZone(domain, body, user, req, { create: true });
        return { domain, status: r.applied === false ? 'pending' : 'applied', detail: `zone imported from the source${r.applied === false ? '; published once BIND runs' : ''}${remoteIps?.length && account.ip ? ` (addresses rewritten to ${account.ip})` : ''}` };
      } catch (err) {
        if (isCapabilityMissing(err)) return { domain, status: 'pending', detail: err.message };
        logger.warn({ err, domain }, 'transfer: source zone rejected, creating a standard zone instead');
      }
    }
    try {
      const r = await ctx.dns.ensureZoneForDomain(domain, { ip: account.ip || undefined, accountId: account.id }, req);
      return { domain, status: r.applied === false ? 'pending' : 'applied', detail: text ? 'source zone was invalid; a standard zone was created' : r.created ? 'standard zone created (no zone found on the source)' : 'zone already existed and now belongs to this account' };
    } catch (err) {
      return { domain, status: isCapabilityMissing(err) ? 'pending' : 'failed', detail: err.message };
    }
  }

  function rewriteHome(docroot, sourceHome, home) {
    if (!docroot) return null;
    if (sourceHome && docroot.startsWith(`${sourceHome}/`)) return `${home}${docroot.slice(sourceHome.length)}`;
    const m = docroot.match(/^\/home\d*\/[^/]+(\/.*)$/);
    return m ? `${home}${m[1]}` : null;
  }

  function addDomains(account, extra) {
    const added = [];
    const skipped = [];
    for (const d of extra) {
      if (!d.domain || d.domain === account.domain) continue;
      if (stmts.domainHosted.get(d.domain)) { skipped.push(d.domain); continue; }
      const type = d.type || (d.domain.endsWith(`.${account.domain}`) ? 'sub' : 'addon');
      const docroot = d.docroot || (type === 'parked' ? `${account.home_dir}/public_html` : `${account.home_dir}/public_html/${type === 'sub' ? d.domain.slice(0, -(account.domain.length + 1)) : d.domain}`);
      stmts.insertDomain.run(account.id, d.domain, type, docroot);
      added.push({ domain: d.domain, type, docroot });
    }
    return { added, skipped };
  }

  async function finishWeb(account, req, domains) {
    const steps = {};
    steps.web = await step(async () => {
      if (!ctx.web?.ensureVhost) return { status: 'skipped', detail: 'Service Configuration is not loaded' };
      const r = await ctx.web.ensureVhost(account.username, req);
      if (r.applied) return { detail: `${r.vhosts?.length ?? 1} vhost(s) written${r.reload?.reloaded ? ', web server reloaded' : ''}` };
      if (r.reason === 'capability_missing') return { status: 'pending', detail: 'Apache is not installed; the vhosts are written when it is' };
      return { status: 'failed', detail: r.vhosts?.find((v) => !v.applied)?.error || r.reason || 'vhost not applied' };
    });
    steps.mail = await step(async () => {
      if (!ctx.mail?.setRouting) return { status: 'skipped', detail: 'Email is not loaded' };
      let applied = 0;
      for (const domain of domains) { const r = await ctx.mail.setRouting(domain, 'local', req); if (r.applied) applied++; }
      return { status: applied === domains.length ? 'applied' : 'pending', detail: applied === domains.length ? `${domains.length} domain(s) routed locally` : 'Exim is not installed; the domains are routed when it is' };
    });
    return steps;
  }

  // ------------------------------------------------------------- transfers ---

  function resolveTargets(input, user, remoteAccounts) {
    const byName = new Map((remoteAccounts || []).map((a) => [a.username, a]));
    const seen = new Set();
    const items = [];
    for (const sel of input.accounts) {
      const src = byName.get(sel.source);
      const username = sel.username || sel.source;
      const domain = (sel.domain || src?.domain || '').toLowerCase();
      const item = { sourceUsername: sel.source, username, domain: domain || null, package: sel.package || null, issues: [], remote: src ? { home: src.home, uid: src.uid, domains: src.domains || [] } : null };
      if (!src) item.issues.push(`${sel.source} was not found on the source server (refresh the account list)`);
      if (seen.has(username)) item.issues.push(`${username} is selected more than once`);
      seen.add(username);
      if (!domain) item.issues.push('No domain: the source has no main domain for this account, enter one');
      const local = stmts.account.get(username);
      if (local && !input.options?.overwrite) item.issues.push(`${username} already exists on this server (enable overwrite to merge)`);
      if (local && !isRoot(user) && local.owner_id !== user.id) item.issues.push(`${username} belongs to another reseller`);
      if (domain && !local) { const hosted = stmts.domainHosted.get(domain); if (hosted) item.issues.push(`${domain} is already hosted by ${hosted.username}`); }
      if (sel.package && !stmts.packageByName.get(sel.package)) item.issues.push(`Package "${sel.package}" does not exist`);
      items.push(item);
    }
    return items;
  }

  async function previewTransfer(input, user) {
    const row = loadSession(input.sessionId, user);
    const cached = json.parse(row.accounts_json, null);
    const remoteAccounts = cached?.accounts || (await sessions.accounts(input.sessionId, user, {})).accounts;
    const options = { skipHome: false, skipDatabases: false, skipDns: false, overwrite: false, ...(input.options || {}) };
    const items = resolveTargets({ ...input, options }, user, remoteAccounts);
    const caps = capabilityStatus();
    const probe = json.parse(row.probe_json, {});
    const warnings = [];
    if (!options.skipHome && !caps.rsync.installed) warnings.push('rsync is not installed here: home directories cannot be copied (install rsync or skip home directories)');
    if (!options.skipHome && probe.tools && probe.tools.rsync === false) warnings.push('rsync is not installed on the source server: home directories cannot be copied');
    if (!options.skipDatabases && probe.tools && probe.tools.mysqldump === false) warnings.push('mysqldump is not installed on the source server: databases are skipped');
    if (!options.skipDatabases && !caps.mysql.installed) warnings.push('The MySQL client is not installed here: dumps are fetched but imports finish "pending"');
    if (!options.skipDatabases && !ctx.databases) warnings.push('Database Services is not loaded: databases are not imported');
    if (!options.skipDns && !ctx.dns) warnings.push('DNS Functions is not loaded: zones are not imported');
    if (probe.isRoot === false) warnings.push(`The SSH user ${row.user} is not root on the source: files of other users and the MySQL root credentials will not be readable`);
    const totals = { accounts: items.length, ready: items.filter((i) => !i.issues.length).length, blocked: items.filter((i) => i.issues.length).length };
    return { session: shapeSession(row), items, totals, warnings, options, capabilities: caps, ok: totals.blocked === 0 && totals.ready > 0 };
  }

  async function startTransfer(input, user, req) {
    const preview = await previewTransfer(input, user);
    if (preview.totals.blocked) throw unprocessable('Some accounts cannot be transferred', { accounts: preview.items.filter((i) => i.issues.length).flatMap((i) => i.issues.map((m) => `${i.sourceUsername}: ${m}`)) });
    if (!preview.totals.ready) throw unprocessable('Select at least one account', { accounts: ['Nothing to transfer'] });
    requireTools({ remote: true, password: preview.session.authType === 'password', rsync: !preview.options.skipHome });
    const passwords = new Map(input.accounts.filter((a) => a.password).map((a) => [`${a.source}:${a.username || a.source}`, a.password]));
    const params = { options: preview.options, accounts: preview.items.map((i) => ({ sourceUsername: i.sourceUsername, username: i.username, domain: i.domain, package: i.package, remote: i.remote, password: passwords.has(`${i.sourceUsername}:${i.username}`) ? ctx.crypto.encrypt(passwords.get(`${i.sourceUsername}:${i.username}`)) : null })), host: preview.session.host, remoteIps: preview.session.probe?.addresses || [] };
    const runId = createRun('transfer', { user, sessionId: input.sessionId, source: `${preview.session.user}@${preview.session.host}`, params, items: preview.items.map((i) => ({ sourceUsername: i.sourceUsername, username: i.username, domain: i.domain, steps: { plan: { package: i.package, remote: i.remote } } })) });
    const job = jobs.enqueue(JOB_TYPES.transfer, { runId, userId: user.id ?? null }, { userId: user.id ?? null });
    stmts.setRunJob.run(job.id, runId);
    audit(req, { action: 'transfer.start', target: `run:${runId}`, args: { job: job.id, host: preview.session.host, accounts: preview.items.map((i) => `${i.sourceUsername}→${i.username}`), ...preview.options } });
    return { job, run: shapeRun(stmts.run.get(runId), { withItems: true }), preview };
  }

  async function transferAccount({ item, plan, options, sessionRow, remoteIps, runId }, user, req, log) {
    const steps = { plan: plan.steps?.plan };
    const { account, created } = await ensureAccount({ username: item.username, domain: item.domain, pkg: plan.package, overwrite: options.overwrite }, user, req, log);
    steps.account = { status: 'applied', detail: created ? 'created' : 'existing account reused' };
    const remoteHome = plan.remote?.home || `/home/${item.source_username}`;
    const domains = [item.domain];

    steps.password = await applyPassword({
      account, created,
      password: plan.password ? ctx.crypto.decrypt(plan.password) : null,
      readHash: () => agent.op('transfer.remote.password_hash', { connection: connectionOf(sessionRow), username: item.source_username }, { req }),
    }, user, req);
    log(`${item.username}: password ${steps.password.status} – ${steps.password.detail}`, steps.password.status === 'failed' ? 'error' : 'info');

    if (options.skipHome) steps.home = { status: 'skipped', detail: 'not requested' };
    else {
      steps.home = await step(async () => {
        const r = await agent.op('transfer.remote.rsync', { connection: connectionOf(sessionRow), remotePath: remoteHome, localPath: account.home_dir, directory: true, excludes: HOME_EXCLUDES, bwlimitKbps: bwlimit() }, { req, timeoutMs: COPY_TIMEOUT_MS });
        if (account.uid != null) await agent.op('fs.chown', { path: account.home_dir, owner: account.username, recursive: true }, { req });
        return { detail: `${r.filesTransferred ?? r.files ?? '?'} file(s), ${r.transferredBytes ?? 0} bytes copied from ${remoteHome}${r.partial ? ' (some files vanished or were unreadable)' : ''}`, bytes: r.transferredBytes ?? null };
      });
      log(`${item.username}: home ${steps.home.status}${steps.home.detail ? ` – ${steps.home.detail}` : ''}`, steps.home.status === 'failed' ? 'error' : 'info');
    }

    if (options.skipDatabases) steps.databases = [{ name: '*', status: 'skipped', detail: 'not requested' }];
    else {
      steps.databases = [];
      let names = [];
      try { names = (await agent.op('transfer.remote.databases', { connection: connectionOf(sessionRow), prefix: item.source_username }, { req })).databases; }
      catch (err) { steps.databases.push({ name: '*', status: err.code === 'remote_tool_missing' ? 'skipped' : 'failed', detail: err.message }); }
      for (const name of names) {
        const target = targetDatabaseName(name, item.source_username, item.username);
        const local = path.join(stagingDir(), `run-${runId}`, `${target}.sql`);
        let dump = null;
        try {
          dump = await agent.op('transfer.remote.dump_database', { connection: connectionOf(sessionRow), database: name }, { req, timeoutMs: IMPORT_TIMEOUT_MS });
          await agent.op('transfer.remote.rsync', { connection: connectionOf(sessionRow), remotePath: dump.remotePath, localPath: local, directory: false, bwlimitKbps: bwlimit() }, { req, timeoutMs: COPY_TIMEOUT_MS });
          const r = await importDatabase({ account, name: target, dumpPath: local, overwrite: options.overwrite, sourceUsername: item.source_username }, user, req);
          steps.databases.push({ ...r, name: target, source: name, sizeBytes: dump.sizeBytes });
          log(`${item.username}: database ${name} → ${target} ${r.status}${r.detail ? ` – ${r.detail}` : ''}`, r.status === 'failed' ? 'error' : 'info');
        } catch (err) {
          steps.databases.push({ name: target, source: name, status: isCapabilityMissing(err) ? 'pending' : 'failed', detail: err.message });
          log(`${item.username}: database ${name} failed – ${err.message}`, 'error');
        } finally {
          if (dump?.remotePath) await agent.op('transfer.remote.remove_file', { connection: connectionOf(sessionRow), path: dump.remotePath }, { req }).catch(() => {});
          await agent.op('fs.remove', { path: local }, { req }).catch(() => {});
        }
      }
      if (names.length) {
        try {
          const g = await agent.op('transfer.remote.db_grants', { connection: connectionOf(sessionRow), prefix: item.source_username }, { req });
          steps.grants = await replayGrants({ account, statements: g.users.flatMap((u) => u.statements), sourceUsername: item.source_username }, user, req);
        } catch (err) { steps.grants = { status: isCapabilityMissing(err) ? 'pending' : 'failed', detail: err.message }; }
      }
    }

    // Addon/sub/parked domains of the source (cPanel userdomains); docroots come
    // from the source's userdata when readable.
    const extra = [];
    for (const d of plan.remote?.domains || []) {
      let docroot = null;
      try {
        const ud = await agent.op('transfer.remote.read_file', { connection: connectionOf(sessionRow), path: `/var/cpanel/userdata/${item.source_username}/${d}` }, { req });
        if (ud.exists) docroot = rewriteHome(parseUserdata(ud.content).documentroot, remoteHome, account.home_dir);
      } catch { /* not cPanel or unreadable: default docroot */ }
      extra.push({ domain: d, docroot });
    }
    const { added, skipped } = addDomains(account, extra);
    steps.domains = { status: 'applied', detail: `${added.length} additional domain(s) added${skipped.length ? `, ${skipped.length} already hosted (${skipped.join(', ')})` : ''}`, added };
    domains.push(...added.map((d) => d.domain));

    if (options.skipDns) steps.dns = [{ domain: '*', status: 'skipped', detail: 'not requested' }];
    else {
      steps.dns = [];
      for (const domain of domains.filter((d) => !added.find((a) => a.domain === d && a.type === 'sub'))) {
        let text = null;
        for (const candidate of ZONE_CANDIDATES(domain)) {
          try { const f = await agent.op('transfer.remote.read_file', { connection: connectionOf(sessionRow), path: candidate }, { req }); if (f.exists) { text = f.content; break; } } catch { break; }
        }
        const r = await importZone({ account, domain, text, remoteIps }, user, req);
        steps.dns.push(r);
        log(`${item.username}: zone ${domain} ${r.status} – ${r.detail}`, r.status === 'failed' ? 'error' : 'info');
      }
    }

    Object.assign(steps, await finishWeb(account, req, domains));
    return steps;
  }

  async function runTransfer(jobCtx) {
    const { runId, userId } = jobCtx.params;
    const run = stmts.run.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const req = actorRequest(userId ?? run.created_by, `job:${jobCtx.job?.id ?? ''}`);
    const user = req.user;
    const params = json.parse(run.params_json, {});
    const sessionRow = run.session_id ? stmts.session.get(run.session_id) : null;
    if (!sessionRow) throw new Error('the transfer session expired before the job started; connect again');
    stmts.runStatus.run('running', runId);
    const items = stmts.queuedItems.all(runId);
    jobCtx.log(`Transferring ${items.length} account(s) from ${sessionRow.user}@${sessionRow.host}${params.options.skipHome ? ' (no home directories)' : ''}${params.options.skipDatabases ? ' (no databases)' : ''}${params.options.skipDns ? ' (no DNS zones)' : ''}`);
    for (const [i, item] of items.entries()) {
      const plan = params.accounts.find((a) => a.sourceUsername === item.source_username && a.username === item.username) || {};
      stmts.itemStatus.run('running', item.id);
      jobCtx.progress((i / items.length) * 100, `${item.source_username} → ${item.username}`);
      try {
        const steps = await transferAccount({ item, plan: { ...plan, steps: json.parse(item.steps_json, {}) }, options: params.options, sessionRow, remoteIps: params.remoteIps, runId }, user, req, jobCtx.log);
        const outcome = outcomeOf(steps);
        finishItem(item, { status: outcome.status, detail: outcome.detail, steps });
        jobCtx.log(`${item.username}: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ''}`, outcome.status === 'failed' ? 'error' : outcome.status === 'pending' ? 'warn' : 'info');
      } catch (err) {
        const status = isCapabilityMissing(err) ? 'pending' : 'failed';
        finishItem(item, { status, detail: err.message, steps: json.parse(item.steps_json, {}) });
        jobCtx.log(`${item.username}: ${err.message}`, status === 'failed' ? 'error' : 'warn');
      }
    }
    await agent.op('fs.remove', { path: path.join(stagingDir(), `run-${runId}`), recursive: true }, { req }).catch(() => {});
    stmts.sessionProbe.run(sessionRow.probe_json, sessionRow.id);
    const totals = finishRunRow(runId, items);
    jobCtx.progress(100, `${totals.done} transferred, ${totals.pending} pending, ${totals.failed} failed`);
    audit(req, { action: 'transfer.result', target: `run:${runId}`, args: { host: sessionRow.host, ...totals } });
    return { runId, ...totals };
  }

  // -------------------------------------------------------------- archives ---

  function archiveDirs() {
    const dirs = settings.get('transfers.archive_dirs', [uploadDir(), '/backup', '/home']);
    return [...new Set([uploadDir(), ...(Array.isArray(dirs) ? dirs : [])])];
  }

  const archives = {
    async list(user) {
      assertRoot(user, 'Restoring accounts');
      const out = [];
      for (const dir of archiveDirs()) {
        try { const r = await agent.op('transfer.archive.list', { path: dir }); for (const a of r.archives) out.push({ ...a, dir }); }
        catch (err) { if (err.code !== 'path_not_allowed') logger.warn({ err, dir }, 'transfer: could not list archives'); }
      }
      out.sort((a, b) => b.mtime.localeCompare(a.mtime));
      return { archives: out, dirs: archiveDirs(), uploadDir: uploadDir() };
    },
    // Listing a large archive decompresses the whole stream, so the result is
    // kept per path and reused while size and mtime are unchanged (the UI's
    // inspect feeds the restore that follows).
    async inspect(file, user, req) {
      assertRoot(user, 'Restoring accounts');
      requireTools({ tar: true });
      const annotate = (info) => {
        const local = info.username ? stmts.account.get(info.username) : null;
        const hosted = info.config?.domain ? stmts.domainHosted.get(info.config.domain) : null;
        return { ...info, localExists: Boolean(local), localDomain: local?.domain ?? null, domainHostedBy: hosted?.username ?? null };
      };
      try {
        const st = await agent.op('fs.stat', { path: file }, { req }).catch(() => null);
        const key = st?.exists && st.size != null && st.mtime ? `${st.size}:${st.mtime}` : null;
        const hit = key ? inspectCache.get(file) : null;
        if (hit && hit.key === key && Date.now() - hit.at < INSPECT_CACHE_MS) return annotate(hit.info);
        const info = await agent.op('transfer.cpmove.inspect', { path: file }, { req });
        if (key) {
          inspectCache.set(file, { key, info, at: Date.now() });
          if (inspectCache.size > 50) inspectCache.delete(inspectCache.keys().next().value);
        }
        return annotate(info);
      } catch (err) { throw translate(err); }
    },
  };

  const shapeUpload = (u) => ({ id: u.id, filename: u.filename, path: u.path, size: u.size, received: u.received, chunks: u.chunks, chunkBytes: UPLOAD_CHUNK_BYTES });

  const uploadsApi = {
    begin({ filename, size }, user, req) {
      assertRoot(user, 'Uploading archives');
      if (!ARCHIVE_NAME.test(filename)) throw unprocessable('Archive names must end in .tar.gz, .tgz or .tar', { filename: ['Not an archive file name'] });
      for (const [id, u] of uploads) if (Date.now() - u.touched > 6 * 3600_000) uploads.delete(id);
      const id = crypto.randomBytes(12).toString('hex');
      uploads.set(id, { id, path: path.join(uploadDir(), filename), filename, size, received: 0, chunks: 0, createdBy: user.id ?? null, touched: Date.now(), started: false });
      audit(req, { action: 'transfer.upload.begin', target: filename, args: { size } });
      return shapeUpload(uploads.get(id));
    },
    get(id, user) {
      assertRoot(user, 'Uploading archives');
      const u = uploads.get(id);
      if (!u) throw notFound('Upload');
      return u;
    },
    // Lets the uploader resume from the bytes that really arrived after a lost
    // response or a rate-limited chunk.
    status(id, user) { return shapeUpload(uploadsApi.get(id, user)); },
    async chunk(id, data, user, req) {
      const u = uploadsApi.get(id, user);
      const bytes = Buffer.byteLength(data, 'base64');
      if (u.size != null && u.received + bytes > u.size) throw unprocessable('More data than announced', { data: ['Upload exceeds the declared size'] });
      try { await agent.op('transfer.upload.append', { path: u.path, data, truncate: !u.started }, { req }); } catch (err) { throw translate(err); }
      u.started = true; u.received += bytes; u.chunks++; u.touched = Date.now();
      return shapeUpload(u);
    },
    async finish(id, user, req) {
      const u = uploadsApi.get(id, user);
      if (u.size != null && u.received !== u.size) throw unprocessable(`Received ${u.received} of ${u.size} bytes`, { data: ['Upload is incomplete'] });
      uploads.delete(id);
      audit(req, { action: 'transfer.upload.finish', target: u.filename, args: { bytes: u.received } });
      const info = await archives.inspect(u.path, user, req);
      return { id, path: u.path, bytes: u.received, archive: info };
    },
    async abort(id, user, req) {
      const u = uploadsApi.get(id, user);
      uploads.delete(id);
      await agent.op('fs.remove', { path: u.path }, { req }).catch(() => {});
      audit(req, { action: 'transfer.upload.abort', target: u.filename });
      return { id, aborted: true };
    },
  };

  // --------------------------------------------------------------- restore ---

  async function startRestore(input, user, req) {
    const info = await archives.inspect(input.path, user, req);
    const options = { skipHome: false, skipDatabases: false, skipDns: false, overwrite: false, ...(input.options || {}) };
    const username = input.username || info.username;
    const domain = (input.domain || info.config?.domain || '').toLowerCase();
    if (!username) throw unprocessable('The archive does not name an account; enter a username', { username: ['Required'] });
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(username)) throw unprocessable(`"${username}" is not a valid username`, { username: ['Lowercase letters, digits, "_" or "-"'] });
    if (!domain) throw unprocessable('The archive does not record the main domain; enter one', { domain: ['Required'] });
    const local = stmts.account.get(username);
    if (local && !options.overwrite) throw conflict(`Account "${username}" already exists; enable overwrite to restore into it`);
    if (!local) { const hosted = stmts.domainHosted.get(domain); if (hosted) throw conflict(`${domain} is already hosted by account "${hosted.username}"`); }
    if (input.package && !stmts.packageByName.get(input.package)) throw notFound(`Package "${input.package}"`);
    const params = { path: info.path, options, username, domain, package: input.package || null, password: input.password ? ctx.crypto.encrypt(input.password) : null, sourceUsername: info.username, archive: { top: info.top, databases: info.databases, zones: info.zones, userdata: info.userdata, hasHomedir: info.hasHomedir, hasGrants: info.hasGrants, hasShadow: Boolean(info.hasShadow), hasAddons: info.hasAddons, hasParked: info.hasParked, hasSubdomains: info.hasSubdomains, config: info.config } };
    const runId = createRun('restore', { user, source: info.path, params, items: [{ sourceUsername: info.username, username, domain, steps: { plan: { package: input.package || null, archive: path.basename(info.path) } } }] });
    const job = jobs.enqueue(JOB_TYPES.restore, { runId, userId: user.id ?? null }, { userId: user.id ?? null });
    stmts.setRunJob.run(job.id, runId);
    audit(req, { action: 'transfer.restore.start', target: username, args: { job: job.id, archive: info.path, domain, ...options } });
    return { job, run: shapeRun(stmts.run.get(runId), { withItems: true }), archive: info };
  }

  async function restoreAccount({ item, params, runId }, user, req, log) {
    const { options, archive } = params;
    const steps = { plan: json.parse(item.steps_json, {}).plan };
    const file = params.path;
    const top = archive.top;
    const member = (rel) => `${top}/${rel}`;
    const readMember = async (rel) => { const r = await agent.op('transfer.cpmove.read_member', { path: file, member: member(rel) }, { req }); return r.exists ? r.content : null; };
    const { account, created } = await ensureAccount({ username: item.username, domain: item.domain, pkg: params.package, contactEmail: archive.config?.contactEmail, overwrite: options.overwrite }, user, req, log);
    steps.account = { status: 'applied', detail: created ? `created from ${path.basename(file)}` : 'existing account reused' };
    const sourceHome = `/home/${archive.config?.raw?.USER || params.sourceUsername || item.username}`;
    const domains = [item.domain];

    steps.password = await applyPassword({
      account, created,
      password: params.password ? ctx.crypto.decrypt(params.password) : null,
      readHash: async () => {
        if (!archive.hasShadow) return { hash: null, reason: 'the archive has no shadow member' };
        const text = await readMember('shadow');
        const field = String(text || '').trim().split('\n')[0] || '';
        const clean = field.replace(/^!+/, '');
        return { hash: SHADOW_HASH.test(clean) ? clean : null, locked: /^!/.test(field), reason: /^!/.test(field) ? 'the archived account was locked' : 'the archived shadow entry has no usable hash' };
      },
    }, user, req);
    log(`${item.username}: password ${steps.password.status} – ${steps.password.detail}`, steps.password.status === 'failed' ? 'error' : 'info');

    if (options.skipHome) steps.home = { status: 'skipped', detail: 'not requested' };
    else if (!archive.hasHomedir) steps.home = { status: 'skipped', detail: 'the archive has no homedir/' };
    else {
      steps.home = await step(async () => {
        const r = await agent.op('transfer.cpmove.extract', { path: file, destination: account.home_dir, members: [member('homedir/*')], stripComponents: 2, owner: account.uid != null ? account.username : undefined }, { req, timeoutMs: COPY_TIMEOUT_MS });
        return { detail: r.extracted ? `homedir extracted into ${account.home_dir}` : 'homedir/ was empty' };
      });
      log(`${item.username}: home ${steps.home.status}${steps.home.detail ? ` – ${steps.home.detail}` : ''}`, steps.home.status === 'failed' ? 'error' : 'info');
    }

    if (options.skipDatabases) steps.databases = [{ name: '*', status: 'skipped', detail: 'not requested' }];
    else {
      steps.databases = [];
      const staging = path.join(stagingDir(), `run-${runId}`);
      const src = params.sourceUsername || item.username;
      for (const name of archive.databases || []) {
        const target = targetDatabaseName(name, src, item.username);
        const dumpPath = path.join(staging, `${name}.sql`);
        try {
          const ex = await agent.op('transfer.cpmove.extract', { path: file, destination: staging, members: [member(`mysql/${name}.sql`)], stripComponents: 2 }, { req, timeoutMs: COPY_TIMEOUT_MS });
          if (!ex.extracted) { steps.databases.push({ name: target, source: name, status: 'failed', detail: 'dump missing from the archive' }); continue; }
          const r = await importDatabase({ account, name: target, dumpPath, overwrite: options.overwrite, sourceUsername: src }, user, req);
          steps.databases.push({ ...r, name: target, source: name });
          log(`${item.username}: database ${name} → ${target} ${r.status}${r.detail ? ` – ${r.detail}` : ''}`, r.status === 'failed' ? 'error' : 'info');
        } catch (err) {
          steps.databases.push({ name: target, source: name, status: isCapabilityMissing(err) ? 'pending' : 'failed', detail: err.message });
        } finally {
          await agent.op('fs.remove', { path: dumpPath }, { req }).catch(() => {});
        }
      }
      if (archive.hasGrants && (archive.databases || []).length) {
        try {
          const text = await readMember('mysql.sql');
          const statements = String(text || '').split(/;\s*\n/).map((s) => s.trim()).filter((s) => /^(CREATE USER|GRANT)\s/i.test(s));
          steps.grants = await replayGrants({ account, statements, sourceUsername: src }, user, req);
        } catch (err) { steps.grants = { status: isCapabilityMissing(err) ? 'pending' : 'failed', detail: err.message }; }
      }
    }

    // Addon, parked and sub domains with docroots from userdata/<domain>.
    let lists = [];
    try {
      lists = parseDomainLists({ addons: archive.hasAddons ? await readMember('addons') : null, pds: archive.hasParked ? await readMember('pds') : null, sds2: archive.hasSubdomains ? await readMember('sds2') : null });
      for (const d of lists) {
        if (d.type === 'parked') continue;
        try { const ud = await readMember(`userdata/${d.domain}`); if (ud) d.docroot = rewriteHome(parseUserdata(ud).documentroot, sourceHome, account.home_dir) || d.docroot; } catch { /* keep default */ }
        if (d.docroot) d.docroot = rewriteHome(d.docroot, sourceHome, account.home_dir) || null;
      }
    } catch (err) { steps.domains = { status: 'failed', detail: err.message }; }
    if (!steps.domains) {
      const addonVia = new Set(lists.filter((d) => d.type === 'addon').map((d) => d.via));
      const { added, skipped } = addDomains(account, lists.filter((d) => !(d.type === 'sub' && addonVia.has(d.domain))));
      steps.domains = { status: 'applied', detail: `${added.length} additional domain(s) restored${skipped.length ? `, ${skipped.length} already hosted (${skipped.join(', ')})` : ''}`, added };
      domains.push(...added.filter((d) => d.type !== 'sub').map((d) => d.domain));
    }

    if (options.skipDns) steps.dns = [{ domain: '*', status: 'skipped', detail: 'not requested' }];
    else {
      steps.dns = [];
      const remoteIps = [archive.config?.ip, ...(steps.domains.added || []).map((d) => d.ip)].filter(Boolean);
      for (const domain of domains) {
        let text = null;
        if ((archive.zones || []).includes(domain)) { try { text = await readMember(`dnszones/${domain}.db`); } catch { text = null; } }
        const r = await importZone({ account, domain, text, remoteIps }, user, req);
        steps.dns.push(r);
        log(`${item.username}: zone ${domain} ${r.status} – ${r.detail}`, r.status === 'failed' ? 'error' : 'info');
      }
    }

    Object.assign(steps, await finishWeb(account, req, domains));
    return steps;
  }

  async function runRestore(jobCtx) {
    const { runId, userId } = jobCtx.params;
    const run = stmts.run.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const req = actorRequest(userId ?? run.created_by, `job:${jobCtx.job?.id ?? ''}`);
    const params = json.parse(run.params_json, {});
    stmts.runStatus.run('running', runId);
    const items = stmts.queuedItems.all(runId);
    jobCtx.log(`Restoring ${path.basename(params.path)} as ${params.username} (${params.domain})`);
    for (const item of items) {
      stmts.itemStatus.run('running', item.id);
      jobCtx.progress(5, item.username);
      try {
        const steps = await restoreAccount({ item, params, runId }, req.user, req, jobCtx.log);
        const outcome = outcomeOf(steps);
        finishItem(item, { status: outcome.status, detail: outcome.detail, steps });
        jobCtx.log(`${item.username}: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ''}`, outcome.status === 'failed' ? 'error' : outcome.status === 'pending' ? 'warn' : 'info');
      } catch (err) {
        const status = isCapabilityMissing(err) ? 'pending' : 'failed';
        finishItem(item, { status, detail: err.message, steps: json.parse(item.steps_json, {}) });
        jobCtx.log(`${item.username}: ${err.message}`, status === 'failed' ? 'error' : 'warn');
      }
    }
    await agent.op('fs.remove', { path: path.join(stagingDir(), `run-${runId}`), recursive: true }, { req }).catch(() => {});
    const totals = finishRunRow(runId, items);
    jobCtx.progress(100, totals.done ? 'restored' : totals.pending ? 'restored with pending steps' : 'failed');
    audit(req, { action: 'transfer.restore.result', target: params.username, args: { archive: params.path, ...totals } });
    return { runId, ...totals };
  }

  // ------------------------------------------------------- convert addon ---

  function loadAddon(domain, user) {
    const row = stmts.addonRow.get(domain);
    if (!row) throw notFound(`Addon domain ${domain}`);
    if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That addon domain belongs to another reseller\'s account');
    return row;
  }

  function previewConvertAddon(input, user) {
    const addon = loadAddon(input.domain, user);
    const issues = [];
    if (stmts.account.get(input.username)) issues.push(`${input.username} already exists on this server`);
    if (input.username === addon.username) issues.push('The new username must differ from the current account');
    if (input.package && !stmts.packageByName.get(input.package)) issues.push(`Package "${input.package}" does not exist`);
    const docroot = addon.docroot || `${addon.home_dir}/public_html/${addon.domain}`;
    const linked = stmts.linkedSubs.all(addon.account_id, docroot).map((d) => d.domain);
    const zone = (() => { try { return db.prepare('SELECT id, domain FROM dns_zones WHERE domain = ?').get(addon.domain); } catch { return null; } })();
    let databases = [];
    try { databases = db.prepare('SELECT name FROM databases WHERE account_id = ?').all(addon.account_id).map((d) => d.name); } catch { databases = []; }
    const caps = capabilityStatus();
    const warnings = [];
    if (!caps.rsync.installed) warnings.push('rsync is not installed here: the document root cannot be copied (the account is created with an empty public_html)');
    if (!ctx.web) warnings.push('Service Configuration is not loaded: virtual hosts are not rewritten');
    if (!ctx.dns) warnings.push('DNS Functions is not loaded: the zone stays with the old account');
    const homeRoot = settings.get('basic.home_root', '/home');
    return {
      addon: { domain: addon.domain, account: addon.username, mainDomain: addon.main_domain, docroot, linkedSubdomains: linked, package: addon.package_name, zone: Boolean(zone), databases },
      target: { username: input.username, domain: addon.domain, home: `${homeRoot}/${input.username}`, package: input.package || addon.package_name, docroot: `${homeRoot}/${input.username}/public_html` },
      options: { copyFiles: true, removeSource: false, moveMail: true, moveDatabases: [], ...(input.options || {}) },
      issues, warnings, capabilities: caps, ok: issues.length === 0,
    };
  }

  async function startConvertAddon(input, user, req) {
    const preview = previewConvertAddon(input, user);
    if (preview.issues.length) throw unprocessable('The addon domain cannot be converted', { username: preview.issues });
    const unknownDb = (preview.options.moveDatabases || []).filter((n) => !preview.addon.databases.includes(n));
    if (unknownDb.length) throw unprocessable(`These databases do not belong to ${preview.addon.account}: ${unknownDb.join(', ')}`, { 'options.moveDatabases': unknownDb });
    if (preview.options.copyFiles) requireTools({ rsync: true });
    const params = { addon: preview.addon, target: preview.target, options: preview.options, password: input.password ? ctx.crypto.encrypt(input.password) : null, contactEmail: input.contactEmail || null };
    const runId = createRun('convert_addon', { user, source: `${preview.addon.account}:${preview.addon.domain}`, params, items: [{ sourceUsername: preview.addon.account, username: preview.target.username, domain: preview.addon.domain, steps: { plan: { from: preview.addon.account, docroot: preview.addon.docroot, package: preview.target.package } } }] });
    const job = jobs.enqueue(JOB_TYPES.convert_addon, { runId, userId: user.id ?? null }, { userId: user.id ?? null });
    stmts.setRunJob.run(job.id, runId);
    audit(req, { action: 'transfer.convert_addon.start', target: preview.addon.domain, args: { job: job.id, from: preview.addon.account, to: preview.target.username, ...preview.options } });
    return { job, run: shapeRun(stmts.run.get(runId), { withItems: true }), preview };
  }

  async function convertAddon({ item, params }, user, req, log) {
    const { addon, target, options } = params;
    const steps = { plan: json.parse(item.steps_json, {}).plan };
    const row = stmts.addonRow.get(addon.domain);
    if (!row) throw new Error(`${addon.domain} is no longer an addon domain`);
    if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That addon domain belongs to another reseller\'s account');
    const oldAccount = stmts.accountById.get(row.account_id);
    const docroot = row.docroot || addon.docroot;
    const removedRows = [row, ...stmts.linkedSubs.all(row.account_id, docroot)].map((d) => ({ id: d.id, account_id: row.account_id, domain: d.domain, type: d.type, docroot: d.docroot ?? null, php_version: d.php_version ?? null, created_at: d.created_at }));

    // The domain must leave account_domains before the new account can claim
    // it; the rows are put back when the account cannot be created.
    db.transaction(() => { for (const r of removedRows) stmts.deleteDomain.run(r.id); })();
    let account;
    try {
      const created = await ctx.accounts.create({ username: target.username, domain: addon.domain, package: target.package || undefined, password: params.password ? ctx.crypto.decrypt(params.password) : undefined, contactEmail: params.contactEmail || oldAccount.contact_email || undefined, provision: { web: false, dns: false, mail: false } }, user, req);
      account = stmts.account.get(target.username);
      steps.account = { status: 'applied', detail: `created (${created.package_name}${created.provisioning?.systemUser ? ', Linux user provisioned' : ''})` };
    } catch (err) {
      db.transaction(() => { for (const r of removedRows) stmts.insertDomainFull.run(r); })();
      throw err;
    }
    steps.domains = { status: 'applied', detail: `${addon.domain} removed from ${oldAccount.username}${removedRows.length > 1 ? ` with ${removedRows.length - 1} linked subdomain(s)` : ''}`, removed: removedRows.map((r) => r.domain) };
    log(`${target.username}: account created for ${addon.domain}`);

    if (!options.copyFiles) steps.files = { status: 'skipped', detail: 'not requested' };
    else {
      steps.files = await step(async () => {
        const st = await agent.op('fs.stat', { path: docroot }, { req });
        if (!st.exists) return { status: 'skipped', detail: `${docroot} does not exist` };
        await agent.op('fs.copy_tree', { from: docroot, to: `${account.home_dir}/public_html` }, { req });
        if (account.uid != null) await agent.op('fs.chown', { path: `${account.home_dir}/public_html`, owner: account.username, recursive: true }, { req });
        return { detail: `${docroot} copied to ${account.home_dir}/public_html` };
      });
      log(`${target.username}: files ${steps.files.status} – ${steps.files.detail}`, steps.files.status === 'failed' ? 'error' : 'info');
    }

    if (!options.moveMail) steps.mail_data = { status: 'skipped', detail: 'not requested' };
    else {
      steps.mail_data = await step(async () => {
        let moved = 0;
        for (const sub of [`mail/${addon.domain}`, `etc/${addon.domain}`]) {
          const st = await agent.op('fs.stat', { path: `${oldAccount.home_dir}/${sub}` }, { req });
          if (!st.exists) continue;
          await agent.op('fs.copy_tree', { from: `${oldAccount.home_dir}/${sub}`, to: `${account.home_dir}/${sub}` }, { req });
          if (account.uid != null) await agent.op('fs.chown', { path: `${account.home_dir}/${sub}`, owner: account.username, recursive: true }, { req });
          moved++;
        }
        return moved ? { detail: `${moved} mail folder(s) copied` } : { status: 'skipped', detail: 'no mailboxes for the domain' };
      });
    }

    steps.databases = [];
    for (const name of options.moveDatabases || []) {
      if (!ctx.databases?.assign) { steps.databases.push({ name, status: 'skipped', detail: 'Database Services is not loaded' }); continue; }
      try { await ctx.databases.assign({ kind: 'database', name, account: account.username }, user, req); steps.databases.push({ name, status: 'applied', detail: `moved to ${account.username}` }); }
      catch (err) { steps.databases.push({ name, status: err.status === 403 ? 'skipped' : 'failed', detail: err.message }); }
    }

    steps.dns = await step(async () => {
      if (!ctx.dns) return { status: 'skipped', detail: 'DNS Functions is not loaded' };
      const r = await ctx.dns.ensureZoneForDomain(addon.domain, { ip: account.ip || undefined, accountId: account.id }, req);
      return { status: r.applied === false ? 'pending' : 'applied', detail: r.created ? 'zone created' : 'zone moved to the new account' };
    });

    const web = await finishWeb(account, req, [addon.domain]);
    steps.web = web.web;
    steps.mail = web.mail;
    steps.old_web = await step(async () => {
      if (!ctx.web?.ensureVhost) return { status: 'skipped', detail: 'Service Configuration is not loaded' };
      const r = await ctx.web.ensureVhost(oldAccount.username, req);
      return r.applied ? { detail: `${oldAccount.username}'s vhosts rewritten without ${addon.domain}` } : r.reason === 'capability_missing' ? { status: 'pending', detail: 'Apache is not installed' } : { status: 'failed', detail: r.reason || 'vhost not applied' };
    });

    if (options.removeSource && steps.files.status === 'applied') {
      steps.cleanup = await step(async () => { await agent.op('fs.remove', { path: docroot, recursive: true }, { req }); return { detail: `${docroot} removed from ${oldAccount.username}` }; });
    } else steps.cleanup = { status: 'skipped', detail: options.removeSource ? 'files were not copied' : 'source files kept' };

    audit(req, { action: 'account.addon.convert', target: addon.domain, args: { from: oldAccount.username, to: account.username, files: steps.files.status, dns: steps.dns.status } });
    return steps;
  }

  async function runConvertAddon(jobCtx) {
    const { runId, userId } = jobCtx.params;
    const run = stmts.run.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const req = actorRequest(userId ?? run.created_by, `job:${jobCtx.job?.id ?? ''}`);
    const params = json.parse(run.params_json, {});
    stmts.runStatus.run('running', runId);
    const items = stmts.queuedItems.all(runId);
    jobCtx.log(`Converting ${params.addon.domain} from ${params.addon.account} into the account ${params.target.username}`);
    for (const item of items) {
      stmts.itemStatus.run('running', item.id);
      try {
        const steps = await convertAddon({ item, params }, req.user, req, jobCtx.log);
        const outcome = outcomeOf(steps);
        finishItem(item, { status: outcome.status, detail: outcome.detail, steps });
        jobCtx.log(`${item.username}: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ''}`, outcome.status === 'failed' ? 'error' : outcome.status === 'pending' ? 'warn' : 'info');
      } catch (err) {
        const status = isCapabilityMissing(err) ? 'pending' : 'failed';
        finishItem(item, { status, detail: err.message, steps: json.parse(item.steps_json, {}) });
        jobCtx.log(`${item.username}: ${err.message}`, status === 'failed' ? 'error' : 'warn');
      }
    }
    const totals = finishRunRow(runId, items);
    jobCtx.progress(100, totals.done ? 'converted' : totals.pending ? 'converted with pending steps' : 'failed');
    audit(req, { action: 'transfer.convert_addon.result', target: params.addon.domain, args: totals });
    return { runId, ...totals };
  }

  // ---------------------------------------------------------------- review ---

  function shapeJob(row) {
    if (!row) return null;
    const run = stmts.runByJob.get(row.id);
    return { ...row, params: json.parse(row.params_json, {}), result: json.parse(row.result_json, null), params_json: undefined, result_json: undefined, run: run || null, kind: run?.kind || (row.type.startsWith('restore.') ? 'restore' : 'transfer') };
  }

  function cleanup(jobCtx) {
    const removedRuns = stmts.pruneRuns.run(`-${retentionDays()} days`).changes;
    const removedSessions = stmts.pruneSessions.run(`-${sessionTtlHours()} hours`).changes;
    jobCtx?.log?.(`Removed ${removedRuns} run(s) older than ${retentionDays()} days and ${removedSessions} expired connection(s)`);
    return { removedRuns, removedSessions };
  }

  return {
    capabilityStatus,
    sessions,
    previewTransfer, startTransfer, runTransfer,
    archives, uploads: uploadsApi,
    startRestore, runRestore,
    // Backup category: restore a cpmove archive by path with optional overrides.
    restoreArchive: (file, overrides = {}, user, req) => startRestore({ path: file, ...overrides }, user, req),
    listAddonDomains(user) { return stmts.addonRows.all({ owner: isRoot(user) ? null : user.id }).map((r) => ({ domain: r.domain, account: r.username, mainDomain: r.main_domain, docroot: r.docroot || `${r.home_dir}/public_html/${r.domain}`, package: r.package_name, created_at: r.created_at })); },
    previewConvertAddon, startConvertAddon, runConvertAddon,
    listRuns({ kind, limit = 50 } = {}, user) { return stmts.runs.all({ kind: kind ?? null, owner: isRoot(user) ? null : user.id, limit }).map((r) => shapeRun(r)); },
    getRun(id, user) {
      const run = shapeRun(loadRun(id, user), { withItems: true });
      let job = null;
      if (run.job_id) { try { job = jobs.get(run.job_id); } catch { job = null; } }
      return { ...run, job };
    },
    listJobs({ status, limit = 50 } = {}, user) { return stmts.jobsOfKinds.all({ owner: isRoot(user) ? null : user.id, status: status ?? null, limit }).map(shapeJob); },
    getJob(id, user) {
      const row = stmts.job.get(id);
      if (!row || !(row.type.startsWith('transfer.') || row.type.startsWith('restore.'))) throw notFound('Job');
      if (!isRoot(user) && row.created_by !== user.id) throw forbidden('That job belongs to another reseller');
      return { ...shapeJob(row), logs: jobs.get(id).logs };
    },
    cleanup,
    JOB_TYPES,
  };
}
