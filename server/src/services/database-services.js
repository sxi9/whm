import net from 'node:net';
import path from 'node:path';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, forbidden, badRequest, unprocessable, HttpError, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

// Database Services. Attached as ctx.databases; other categories may call:
//   databases.activeProfile()                       -> the active db_instances row (no secret)
//   databases.run(opBase, args, req)                -> agent op on the active profile ('databases.list' -> db.* or pg.*)
//   databases.forAccount(username, user)            -> { account, databases, users, accessHosts, quota }
//   databases.createDatabase({ name, account }, user, req) / dropDatabase(name, user, req)
//   databases.createUser({ name, password, account }, user, req) / dropUser(name, user, req)
//   databases.setGrants(userName, [{ database, privileges }], user, req)
//   databases.removeAccountData(username, req)      -> drops every database and user of an account (terminate)
//   databases.dump({ databases, path }, req)        -> mysqldump to a file under an allowed root (backups)
//   databases.quotaFor(account)                     -> { max, used, remaining }
//   databases.hostsFor(accountId)                   -> hosts a per-account user is provisioned at
//   databases.phpMyAdmin(user)                      -> install status and URL (paths root-only)
//   databases.setClientAddresses({ ipv4, ipv6 }, req) -> source address for connections to remote
//                                                      profiles (Configure Remote Service IPs)

export const PRIVILEGES = ['ALL PRIVILEGES', 'ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE', 'CREATE TEMPORARY TABLES', 'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'INDEX', 'INSERT', 'LOCK TABLES', 'REFERENCES', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'UPDATE'];
export const PG_PRIVILEGES = ['ALL PRIVILEGES', 'CONNECT', 'CREATE', 'TEMPORARY'];

// Tunables the configuration editor offers with inline help; any other [mysqld]
// option can still be added by name.
export const KNOWN_TUNABLES = [
  { key: 'max-connections', label: 'max_connections', help: 'Maximum simultaneous client connections', type: 'number' },
  { key: 'innodb-buffer-pool-size', label: 'innodb_buffer_pool_size', help: 'Memory for InnoDB data and index cache, e.g. 1G or 512M', type: 'size' },
  { key: 'innodb-log-file-size', label: 'innodb_log_file_size', help: 'Redo log file size, e.g. 256M', type: 'size' },
  { key: 'innodb-flush-log-at-trx-commit', label: 'innodb_flush_log_at_trx_commit', help: '1 = durable (default), 2 = flush every second', type: 'number' },
  { key: 'innodb-file-per-table', label: 'innodb_file_per_table', help: 'ON stores each table in its own file', type: 'onoff' },
  { key: 'key-buffer-size', label: 'key_buffer_size', help: 'MyISAM index cache, e.g. 64M', type: 'size' },
  { key: 'tmp-table-size', label: 'tmp_table_size', help: 'In-memory temporary table limit, e.g. 64M', type: 'size' },
  { key: 'max-heap-table-size', label: 'max_heap_table_size', help: 'Should match tmp_table_size', type: 'size' },
  { key: 'table-open-cache', label: 'table_open_cache', help: 'Open tables cached across threads', type: 'number' },
  { key: 'thread-cache-size', label: 'thread_cache_size', help: 'Threads kept for reuse', type: 'number' },
  { key: 'max-allowed-packet', label: 'max_allowed_packet', help: 'Largest packet / BLOB, e.g. 64M', type: 'size' },
  { key: 'wait-timeout', label: 'wait_timeout', help: 'Seconds an idle connection stays open', type: 'number' },
  { key: 'interactive-timeout', label: 'interactive_timeout', help: 'Idle timeout for interactive clients', type: 'number' },
  { key: 'slow-query-log', label: 'slow_query_log', help: 'Log slow statements', type: 'onoff' },
  { key: 'long-query-time', label: 'long_query_time', help: 'Seconds before a query counts as slow', type: 'number' },
  { key: 'slow-query-log-file', label: 'slow_query_log_file', help: 'Path of the slow query log', type: 'text' },
  { key: 'bind-address', label: 'bind_address', help: '127.0.0.1 for local only, 0.0.0.0 to accept remote access hosts', type: 'text' },
  { key: 'port', label: 'port', help: 'TCP port (default 3306)', type: 'number' },
  { key: 'sql-mode', label: 'sql_mode', help: 'Comma-separated SQL modes', type: 'text' },
  { key: 'character-set-server', label: 'character_set_server', help: 'Default character set for new databases', type: 'text' },
  { key: 'collation-server', label: 'collation_server', help: 'Default collation for new databases', type: 'text' },
  { key: 'local-infile', label: 'local_infile', help: 'Allow LOAD DATA LOCAL (security sensitive)', type: 'onoff' },
  { key: 'skip-name-resolve', label: 'skip_name_resolve', help: 'Match grants by IP only (faster connects)', type: 'flag' },
  { key: 'performance-schema', label: 'performance_schema', help: 'Instrumentation tables (uses memory)', type: 'onoff' },
  { key: 'open-files-limit', label: 'open_files_limit', help: 'File descriptors the server may use', type: 'number' },
];

const SYSTEM_DATABASES = new Set(['mysql', 'information_schema', 'performance_schema', 'sys', 'postgres', 'template0', 'template1']);
const SYSTEM_USERS = new Set(['root', 'postgres', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys', 'debian-sys-maint', 'mysqlxsys', 'phpmyadmin', 'pma']);

export function createDatabaseServicesService(ctx) {
  const { db, agent, capabilities, settings, crypto, logger } = ctx;

  const stmts = {
    activeProfile: db.prepare('SELECT * FROM db_instances WHERE is_active = 1 ORDER BY id LIMIT 1'),
    firstProfile: db.prepare('SELECT * FROM db_instances ORDER BY is_local DESC, id LIMIT 1'),
    profiles: db.prepare('SELECT i.*, s.ok AS test_ok, s.message AS test_message, s.version AS test_version, s.tested_at FROM db_instances i LEFT JOIN db_instance_status s ON s.instance_id = i.id ORDER BY i.is_active DESC, i.profile_name'),
    profileById: db.prepare('SELECT * FROM db_instances WHERE id = ?'),
    profileByName: db.prepare('SELECT * FROM db_instances WHERE profile_name = ?'),
    insertProfile: db.prepare('INSERT INTO db_instances (profile_name, engine, host, port, is_local, admin_user, admin_password_enc, is_active) VALUES (@profile_name, @engine, @host, @port, @is_local, @admin_user, @admin_password_enc, 0)'),
    updateProfile: db.prepare('UPDATE db_instances SET profile_name = @profile_name, engine = @engine, host = @host, port = @port, is_local = @is_local, admin_user = @admin_user, admin_password_enc = @admin_password_enc WHERE id = @id'),
    setAdminPassword: db.prepare('UPDATE db_instances SET admin_password_enc = ? WHERE id = ?'),
    deleteProfile: db.prepare('DELETE FROM db_instances WHERE id = ?'),
    deactivateAll: db.prepare('UPDATE db_instances SET is_active = 0'),
    activate: db.prepare('UPDATE db_instances SET is_active = 1 WHERE id = ?'),
    upsertStatus: db.prepare(`INSERT INTO db_instance_status (instance_id, ok, message, version, tested_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (instance_id) DO UPDATE SET ok = excluded.ok, message = excluded.message, version = excluded.version, tested_at = excluded.tested_at`),

    dbRows: db.prepare('SELECT d.*, a.username AS account, a.owner_id FROM databases d LEFT JOIN accounts a ON a.id = d.account_id ORDER BY d.name'),
    dbByName: db.prepare('SELECT d.*, a.username AS account, a.owner_id FROM databases d LEFT JOIN accounts a ON a.id = d.account_id WHERE d.name = ?'),
    dbsForAccount: db.prepare('SELECT * FROM databases WHERE account_id = ? ORDER BY name'),
    countDbs: db.prepare('SELECT COUNT(*) AS n FROM databases WHERE account_id = ?'),
    insertDb: db.prepare('INSERT INTO databases (account_id, name, instance_id) VALUES (?, ?, ?)'),
    assignDb: db.prepare('INSERT INTO databases (account_id, name, instance_id) VALUES (@account_id, @name, @instance_id) ON CONFLICT (name) DO UPDATE SET account_id = excluded.account_id'),
    deleteDb: db.prepare('DELETE FROM databases WHERE name = ?'),

    userRows: db.prepare('SELECT u.*, a.username AS account, a.owner_id FROM db_users u LEFT JOIN accounts a ON a.id = u.account_id ORDER BY u.name'),
    userByName: db.prepare('SELECT u.*, a.username AS account, a.owner_id FROM db_users u LEFT JOIN accounts a ON a.id = u.account_id WHERE u.name = ?'),
    usersForAccount: db.prepare('SELECT * FROM db_users WHERE account_id = ? ORDER BY name'),
    insertUser: db.prepare('INSERT INTO db_users (account_id, name, instance_id) VALUES (?, ?, ?)'),
    assignUser: db.prepare('INSERT INTO db_users (account_id, name, instance_id) VALUES (@account_id, @name, @instance_id) ON CONFLICT (name) DO UPDATE SET account_id = excluded.account_id'),
    deleteUser: db.prepare('DELETE FROM db_users WHERE name = ?'),
    userHosts: db.prepare('SELECT host FROM db_user_hosts WHERE db_user_id = ? ORDER BY host'),
    addUserHost: db.prepare('INSERT OR IGNORE INTO db_user_hosts (db_user_id, host) VALUES (?, ?)'),
    removeUserHost: db.prepare('DELETE FROM db_user_hosts WHERE db_user_id = ? AND host = ?'),
    clearUserHosts: db.prepare('DELETE FROM db_user_hosts WHERE db_user_id = ?'),
    usersAtHost: db.prepare('SELECT u.* FROM db_users u JOIN db_user_hosts h ON h.db_user_id = u.id WHERE h.host = @host AND u.account_id IS NOT NULL AND (@account IS NULL OR u.account_id = @account) ORDER BY u.name'),

    grantsForUser: db.prepare('SELECT g.*, d.name AS database FROM db_grants g JOIN databases d ON d.id = g.database_id WHERE g.db_user_id = ? ORDER BY d.name'),
    grantsForDb: db.prepare('SELECT g.*, u.name AS user FROM db_grants g JOIN db_users u ON u.id = g.db_user_id WHERE g.database_id = ? ORDER BY u.name'),
    upsertGrant: db.prepare('INSERT INTO db_grants (db_user_id, database_id, privileges) VALUES (?, ?, ?) ON CONFLICT (db_user_id, database_id) DO UPDATE SET privileges = excluded.privileges'),
    deleteGrant: db.prepare('DELETE FROM db_grants WHERE db_user_id = ? AND database_id = ?'),
    deleteGrantsForUser: db.prepare('DELETE FROM db_grants WHERE db_user_id = ?'),

    accessHosts: db.prepare('SELECT h.*, a.username AS account, a.owner_id FROM db_access_hosts h LEFT JOIN accounts a ON a.id = h.account_id ORDER BY a.username, h.host'),
    accessHostsFor: db.prepare('SELECT host FROM db_access_hosts WHERE account_id = ? OR account_id IS NULL ORDER BY host'),
    accessHostById: db.prepare('SELECT h.*, a.username AS account, a.owner_id FROM db_access_hosts h LEFT JOIN accounts a ON a.id = h.account_id WHERE h.id = ?'),
    insertAccessHost: db.prepare('INSERT INTO db_access_hosts (account_id, host) VALUES (?, ?)'),
    deleteAccessHost: db.prepare('DELETE FROM db_access_hosts WHERE id = ?'),

    insertRepairRun: db.prepare('INSERT INTO db_repair_runs (job_id, action, databases, summary, started_by) VALUES (?, ?, ?, ?, ?)'),
    updateRepairRun: db.prepare('UPDATE db_repair_runs SET summary = ? WHERE job_id = ?'),
    repairRuns: db.prepare('SELECT r.*, j.status AS job_status, j.finished_at FROM db_repair_runs r LEFT JOIN jobs j ON j.id = r.job_id ORDER BY r.id DESC LIMIT 20'),

    accountByUsername: db.prepare('SELECT id, username, owner_id, plan_snapshot_json, suspended FROM accounts WHERE username = ?'),
    accountById: db.prepare('SELECT id, username, owner_id, plan_snapshot_json FROM accounts WHERE id = ?'),
    accountsVisible: db.prepare('SELECT username FROM accounts WHERE (@owner IS NULL OR owner_id = @owner) ORDER BY username'),
  };

  // ------------------------------------------------------------ profiles ---

  function shapeProfile(row) {
    if (!row) return null;
    const { admin_password_enc, test_ok, test_message, test_version, tested_at, ...rest } = row;
    return { ...rest, is_local: Boolean(row.is_local), is_active: Boolean(row.is_active), has_password: Boolean(admin_password_enc), status: tested_at ? { ok: Boolean(test_ok), message: test_message, version: test_version, tested_at } : null };
  }

  function activeRow() {
    return stmts.activeProfile.get() || stmts.firstProfile.get() || null;
  }

  function requireProfile() {
    const p = activeRow();
    if (!p) throw new CapabilityError('mysql', 'No database profile is configured; add one under Manage Database Profiles');
    return p;
  }

  const isPg = (profile) => profile.engine === 'postgres';
  const isRemote = (profile) => !profile.is_local && profile.host && !['localhost', '127.0.0.1', '::1'].includes(profile.host);

  // Source addresses chosen in "Configure Remote Service IPs" (ip-functions).
  function clientAddresses() {
    return { ipv4: settings.get('db.client.bind_address_ipv4', null) || null, ipv6: settings.get('db.client.bind_address_ipv6', null) || null };
  }

  // The local address a remote profile's connections are bound to: the family
  // of an IP-literal host decides; a hostname prefers IPv4.
  function bindAddressFor(profile) {
    if (!isRemote(profile) || isPg(profile)) return null;
    const { ipv4, ipv6 } = clientAddresses();
    const family = net.isIP(profile.host);
    if (family === 6) return ipv6;
    if (family === 4) return ipv4;
    return ipv4 || ipv6;
  }

  function credsFor(profile) {
    if (!profile.admin_user && !profile.admin_password_enc && (profile.is_local || profile.host === 'localhost')) return undefined;
    const creds = {};
    if (profile.host && profile.host !== 'localhost') creds.host = profile.host;
    else if (profile.host) creds.host = 'localhost';
    if (profile.port) creds.port = profile.port;
    if (profile.admin_user) creds.user = profile.admin_user;
    if (profile.admin_password_enc) creds.password = crypto.decrypt(profile.admin_password_enc);
    const bindAddress = bindAddressFor(profile);
    if (bindAddress) creds.bindAddress = bindAddress;
    return creds;
  }
  const capFor = (profile) => (isPg(profile) ? 'postgres' : 'mysql');

  function translateError(err, profile) {
    if (err?.code === 'capability_missing' || err?.code === 'binary_not_found') return new CapabilityError(capFor(profile), err.message);
    if (err?.code === 'db_unreachable') return new HttpError(503, 'db_unreachable', `${err.message}. Check that the database server is running and the active profile points at it.`);
    if (err?.code === 'db_auth_failed') return new HttpError(502, 'db_auth_failed', `${err.message}. Update the credentials of the active database profile.`);
    if (err?.code === 'exists') return conflict(err.message);
    if (err?.code === 'not_found') return notFound(err.message.replace(/^(MySQL|PostgreSQL): /, ''));
    if (err?.code === 'refused') return badRequest(err.message);
    if (err?.code === 'config_invalid') return new HttpError(400, 'config_invalid', err.message, err.details?.output ? { output: [err.details.output] } : undefined);
    if (err?.code === 'invalid_args') return unprocessable(`The agent rejected the request: ${err.message}`, err.details?.fields);
    return err;
  }

  const unitOp = (profile) => (isPg(profile) ? 'pg.unit' : 'db.unit');
  const restartOp = (profile) => (isPg(profile) ? 'pg.restart' : 'db.restart');

  async function requireEngine(profile) {
    await capabilities.ensureFresh();
    if (!capabilities.has(capFor(profile))) {
      throw new CapabilityError(capFor(profile), isPg(profile) ? 'PostgreSQL (psql) is not installed on this server' : 'MySQL/MariaDB is not installed on this server (no mysql, mysqld or mariadbd binary)');
    }
    return profile;
  }

  // Runs an agent op against a profile: 'databases.list' -> db.databases.list or pg.databases.list.
  async function run(base, args = {}, req, profile = requireProfile()) {
    await requireEngine(profile);
    const name = `${isPg(profile) ? 'pg' : 'db'}.${base}`;
    const creds = credsFor(profile);
    try {
      return await agent.op(name, creds ? { ...args, credentials: creds } : args, { req });
    } catch (err) {
      throw translateError(err, profile);
    }
  }

  // ------------------------------------------------------------ accounts ---

  function loadAccount(username, user) {
    const row = stmts.accountByUsername.get(username);
    if (!row) throw notFound(`Account "${username}"`);
    if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That account belongs to another reseller');
    return { ...row, plan: json.parse(row.plan_snapshot_json, {}) };
  }

  function assertRoot(user, what = 'This operation') {
    if (!isRoot(user)) throw forbidden(`${what} requires the root user`);
  }

  // Ownership of a database/user row: root sees everything, resellers only rows
  // mapped to their own accounts (unmapped rows are root's).
  function assertVisible(row, user, what) {
    if (!row) throw notFound(what);
    if (isRoot(user)) return row;
    if (row.account_id == null || row.owner_id !== user.id) throw forbidden(`That ${what.toLowerCase()} is not managed by one of your accounts`);
    return row;
  }

  function quotaFor(account) {
    const max = account.plan?.max_db ?? null;
    const used = stmts.countDbs.get(account.id).n;
    return { max, used, remaining: max == null ? null : Math.max(0, max - used) };
  }

  const prefixing = () => settings.get('db.prefixing', true) !== false;

  // cPanel-style naming: per-account objects are "<username>_<name>".
  function ownedName(account, name, kind) {
    const prefix = `${account.username}_`;
    const full = prefixing() ? (name.startsWith(prefix) ? name : `${prefix}${name}`) : name;
    const limit = kind === 'user' ? 32 : 64;
    if (full.length > limit) throw badRequest(`"${full}" is longer than ${limit} characters; choose a shorter ${kind} name`, { name: [`Including the "${prefix}" prefix the name must be at most ${limit} characters`] });
    return full;
  }

  const orderHosts = (hosts) => [...new Set(hosts)].sort((a, b) => (a === 'localhost' ? -1 : b === 'localhost' ? 1 : a.localeCompare(b)));

  // Per-account users are always provisioned at localhost plus the access hosts.
  function hostsFor(accountId) {
    return orderHosts(['localhost', ...stmts.accessHostsFor.all(accountId ?? null).map((r) => r.host)]);
  }

  const recordedHosts = (row) => orderHosts(stmts.userHosts.all(row.id).map((h) => h.host));
  const preferredHost = (hosts) => (hosts.includes('localhost') ? 'localhost' : hosts[0]);

  // The hosts a user really exists at, from mysql.user; users adopted through the
  // Map Tool or created with explicit hosts are often not at localhost at all.
  async function liveHostsOf(name, profile, req) {
    if (isPg(profile)) return [];
    const users = await run('users.list', {}, req, profile);
    return orderHosts(users.filter((u) => u.user === name && u.host).map((u) => u.host));
  }

  const recordHosts = db.transaction((userId, hosts) => {
    stmts.clearUserHosts.run(userId);
    for (const h of hosts) stmts.addUserHost.run(userId, h);
  });

  async function resolveHosts(name, row, profile, req) {
    const hosts = await liveHostsOf(name, profile, req);
    if (!hosts.length) throw notFound(`Database user "${name}" does not exist on the server`);
    if (row) recordHosts(row.id, hosts);
    return hosts;
  }

  // ------------------------------------------------------------ overview ---

  async function status(user) {
    const profile = activeRow();
    const detect = await agent.op('db.detect');
    await capabilities.ensureFresh();
    const out = { profile: shapeProfile(profile), detect, capabilities: { mysql: capabilities.has('mysql'), postgres: capabilities.has('postgres') }, version: null, unit: null, counts: { databases: stmts.dbRows.all().length, users: stmts.userRows.all().length }, prefixing: prefixing(), error: null };
    if (profile && capabilities.has(capFor(profile))) {
      try { out.version = await run('version', {}, null, profile); } catch (err) { out.error = { code: err.code, message: err.message }; }
      if (profile.is_local) { try { out.unit = await agent.op(unitOp(profile)); } catch { out.unit = null; } }
    }
    if (user && !isRoot(user)) return trimStatus(out);
    return out;
  }

  // Resellers see what engine runs and whether it answers, not where the server
  // keeps its files, which profile/credentials the panel uses or the unit's PID.
  function trimStatus(out) {
    const profile = out.profile ? { id: out.profile.id, profile_name: out.profile.profile_name, engine: out.profile.engine, is_local: out.profile.is_local, is_active: out.profile.is_active } : null;
    const detect = out.detect ? { installed: out.detect.installed, serverInstalled: out.detect.serverInstalled, engine: out.detect.engine, postgres: { installed: Boolean(out.detect.postgres?.installed) } } : null;
    const version = out.version ? { version: out.version.version, engine: out.version.engine, major: out.version.major } : null;
    const unit = out.unit ? { unit: out.unit.unit, state: out.unit.state } : null;
    return { profile, detect, capabilities: out.capabilities, version, unit, counts: out.counts, prefixing: out.prefixing, error: out.error };
  }

  // ----------------------------------------------------------- databases ---

  async function serverDatabases(req) {
    return run('databases.list', {}, req);
  }

  async function listDatabases(query, user) {
    const mapped = stmts.dbRows.all();
    const byName = new Map(mapped.map((r) => [r.name, r]));
    let serverList = null;
    let engineError = null;
    try { serverList = await serverDatabases(); } catch (err) { if (err instanceof CapabilityError) throw err; engineError = { code: err.code, message: err.message }; }
    let rows;
    if (serverList) {
      rows = serverList.map((d) => ({ ...d, account: byName.get(d.name)?.account ?? null, owner_id: byName.get(d.name)?.owner_id ?? null, mapped: byName.has(d.name), onServer: true }));
      for (const r of mapped) if (!serverList.some((d) => d.name === r.name)) rows.push({ name: r.name, sizeBytes: null, tables: null, charset: null, collation: null, system: false, account: r.account, owner_id: r.owner_id, mapped: true, onServer: false });
    } else {
      rows = mapped.map((r) => ({ name: r.name, sizeBytes: null, tables: null, charset: null, collation: null, system: false, account: r.account, owner_id: r.owner_id, mapped: true, onServer: null }));
    }
    if (!isRoot(user)) rows = rows.filter((r) => r.owner_id === user.id);
    if (query.account) rows = rows.filter((r) => r.account === query.account);
    if (query.q) { const needle = query.q.toLowerCase(); rows = rows.filter((r) => r.name.toLowerCase().includes(needle) || (r.account || '').toLowerCase().includes(needle)); }
    if (!query.system) rows = rows.filter((r) => !r.system);
    for (const r of rows) r.users = byName.has(r.name) ? stmts.grantsForDb.all(byName.get(r.name).id).map((g) => g.user) : [];
    const sortKey = query.sort || 'name';
    rows.sort((a, b) => { const x = a[sortKey] ?? ''; const y = b[sortKey] ?? ''; return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * (query.dir === 'desc' ? -1 : 1); });
    const page = query.page || 1; const pageSize = query.pageSize || 50;
    return { data: rows.slice((page - 1) * pageSize, page * pageSize).map(({ owner_id, ...r }) => r), meta: { page, pageSize, total: rows.length, engineError } };
  }

  async function createDatabase(input, user, req) {
    const profile = requireProfile();
    let account = null;
    let name = input.name;
    if (input.account) {
      account = loadAccount(input.account, user);
      if (account.suspended) throw conflict(`Account "${account.username}" is suspended`);
      const quota = quotaFor(account);
      if (quota.remaining === 0) throw conflict(`Account "${account.username}" has reached its database limit (${quota.max})`);
      name = ownedName(account, input.name, 'database');
    } else {
      assertRoot(user, 'Creating a database that is not assigned to an account');
    }
    if (SYSTEM_DATABASES.has(name)) throw badRequest(`"${name}" is a system database name`);
    if (stmts.dbByName.get(name)) throw conflict(`Database "${name}" already exists`);
    const args = isPg(profile) ? { name } : { name, charset: input.charset || settings.get('db.default_charset', 'utf8mb4'), collation: input.collation || settings.get('db.default_collation', 'utf8mb4_unicode_ci') };
    const created = await run('database.create', args, req, profile);
    stmts.insertDb.run(account?.id ?? null, name, profile.id);
    req?.audit?.({ action: 'db.database.create', target: name, args: { account: account?.username ?? null, engine: profile.engine } });
    return { ...created, name, account: account?.username ?? null, quota: account ? quotaFor(account) : null };
  }

  async function dropDatabase(name, user, req) {
    const profile = requireProfile();
    const row = stmts.dbByName.get(name);
    if (row) assertVisible(row, user, 'Database');
    else assertRoot(user, 'Dropping a database that is not mapped to an account');
    if (SYSTEM_DATABASES.has(name)) throw badRequest(`"${name}" is a system database and cannot be dropped`);
    const result = await run('database.drop', { name }, req, profile);
    stmts.deleteDb.run(name);
    req?.audit?.({ action: 'db.database.drop', target: name, args: { account: row?.account ?? null } });
    return { ...result, account: row?.account ?? null };
  }

  // --------------------------------------------------------------- users ---

  function shapeUserRow(r, serverHosts) {
    return { name: r.name, account: r.account ?? null, hosts: serverHosts ?? stmts.userHosts.all(r.id).map((h) => h.host), grants: stmts.grantsForUser.all(r.id).map((g) => ({ database: g.database, privileges: g.privileges.split(',').map((p) => p.trim()) })), mapped: true, created_at: r.created_at };
  }

  async function listUsers(query, user) {
    const mapped = stmts.userRows.all();
    const byName = new Map(mapped.map((r) => [r.name, r]));
    let serverUsers = null;
    let engineError = null;
    try { serverUsers = await run('users.list'); } catch (err) { if (err instanceof CapabilityError) throw err; engineError = { code: err.code, message: err.message }; }
    const rows = [];
    if (serverUsers) {
      const grouped = new Map();
      for (const u of serverUsers) { const g = grouped.get(u.user) || { name: u.user, hosts: [], system: u.system }; if (u.host) g.hosts.push(u.host); grouped.set(u.user, g); }
      for (const g of grouped.values()) {
        const row = byName.get(g.name);
        rows.push(row ? { ...shapeUserRow(row, g.hosts), owner_id: row.owner_id, system: false, onServer: true } : { name: g.name, account: null, owner_id: null, hosts: g.hosts, grants: [], mapped: false, system: g.system, onServer: true });
      }
      for (const r of mapped) if (!grouped.has(r.name)) rows.push({ ...shapeUserRow(r), owner_id: r.owner_id, system: false, onServer: false });
    } else {
      for (const r of mapped) rows.push({ ...shapeUserRow(r), owner_id: r.owner_id, system: false, onServer: null });
    }
    let out = isRoot(user) ? rows : rows.filter((r) => r.owner_id === user.id);
    if (query.account) out = out.filter((r) => r.account === query.account);
    if (query.q) { const needle = query.q.toLowerCase(); out = out.filter((r) => r.name.toLowerCase().includes(needle) || (r.account || '').toLowerCase().includes(needle)); }
    if (!query.system) out = out.filter((r) => !r.system);
    out.sort((a, b) => String(a[query.sort || 'name'] ?? '').localeCompare(String(b[query.sort || 'name'] ?? '')) * (query.dir === 'desc' ? -1 : 1));
    const page = query.page || 1; const pageSize = query.pageSize || 50;
    return { data: out.slice((page - 1) * pageSize, page * pageSize).map(({ owner_id, ...r }) => r), meta: { page, pageSize, total: out.length, engineError } };
  }

  async function checkPasswordPolicy(password) {
    const fn = ctx.security?.passwordStrength;
    if (typeof fn !== 'function') return;
    const verdict = fn(password, 'mysql');
    if (verdict && verdict.ok === false) throw badRequest(`Password too weak (strength ${verdict.score}, minimum ${verdict.minimum})`, { password: [`Strength ${verdict.score} is below the required minimum ${verdict.minimum}`] });
  }

  async function createUser(input, user, req) {
    const profile = requireProfile();
    let account = null;
    let name = input.name;
    let hosts = input.hosts;
    if (input.account) {
      account = loadAccount(input.account, user);
      if (account.suspended) throw conflict(`Account "${account.username}" is suspended`);
      name = ownedName(account, input.name, 'user');
      hosts = hostsFor(account.id);
    } else {
      assertRoot(user, 'Creating a database user that is not assigned to an account');
      hosts = hosts?.length ? hosts : ['localhost'];
    }
    if (SYSTEM_USERS.has(name)) throw badRequest(`"${name}" is a reserved database user name`);
    if (stmts.userByName.get(name)) throw conflict(`Database user "${name}" already exists`);
    await checkPasswordPolicy(input.password);
    // Grant targets are checked before the user exists so a refused database
    // never leaves a half-provisioned user behind.
    const wanted = (input.databases || []).map((d) => ({ database: d, privileges: settings.get('db.default_privileges', ['ALL PRIVILEGES']) }));
    assertGrantTargets(wanted, { account_id: account?.id ?? null }, user, profile, name);
    const created = await run('user.create', isPg(profile) ? { user: name, password: input.password } : { user: name, password: input.password, hosts }, req, profile);
    const userId = db.transaction(() => {
      const { lastInsertRowid } = stmts.insertUser.run(account?.id ?? null, name, profile.id);
      for (const h of isPg(profile) ? [] : hosts) stmts.addUserHost.run(lastInsertRowid, h);
      return Number(lastInsertRowid);
    })();
    req?.audit?.({ action: 'db.user.create', target: name, args: { account: account?.username ?? null, hosts } });
    let grants = [];
    if (wanted.length) {
      try {
        grants = (await setGrants(name, wanted, user, req)).grants;
      } catch (err) {
        // The grant step failed on the server: drop the user again rather than
        // leave an account the caller does not know exists.
        try { await run('user.drop', { user: name }, req, profile); stmts.deleteUser.run(name); } catch (dropErr) { logger.warn({ err: dropErr, user: name }, 'could not remove a user whose grants failed'); }
        req?.audit?.({ action: 'db.user.create', target: name, result: 'error', args: { account: account?.username ?? null, reason: err.message } });
        throw err;
      }
    }
    return { ...created, name, account: account?.username ?? null, hosts: isPg(profile) ? [] : hosts, grants, id: userId };
  }

  async function dropUser(name, user, req) {
    const profile = requireProfile();
    const row = stmts.userByName.get(name);
    if (row) assertVisible(row, user, 'Database user');
    else assertRoot(user, 'Dropping a database user that is not mapped to an account');
    if (SYSTEM_USERS.has(name)) throw badRequest(`"${name}" is a system user and cannot be dropped`);
    const result = await run('user.drop', { user: name }, req, profile);
    stmts.deleteUser.run(name);
    req?.audit?.({ action: 'db.user.drop', target: name, args: { account: row?.account ?? null } });
    return { ...result, account: row?.account ?? null };
  }

  async function setUserPassword(name, password, user, req) {
    const profile = requireProfile();
    const row = stmts.userByName.get(name);
    if (row) assertVisible(row, user, 'Database user');
    else assertRoot(user, 'Changing the password of an unmapped database user');
    if (name === 'root' || name === 'postgres') throw badRequest('Use Change Database Root Password for the superuser');
    await checkPasswordPolicy(password);
    const result = await run('user.set_password', { user: name, password }, req, profile);
    req?.audit?.({ action: 'db.user.password', target: name, args: { account: row?.account ?? null } });
    return { name, hosts: result.hosts, account: row?.account ?? null };
  }

  async function setRootPassword(password, user, req) {
    assertRoot(user, 'Changing the database root password');
    const profile = requireProfile();
    await checkPasswordPolicy(password);
    // /root/.my.cnf only exists for MySQL; pg.root_password.set is strict about its keys.
    const result = await run('root_password.set', isPg(profile) ? { password } : { password, updateMyCnf: Boolean(profile.is_local) }, req, profile);
    const superuser = isPg(profile) ? 'postgres' : 'root';
    if (profile.admin_user === superuser || (!profile.admin_user && !profile.is_local)) stmts.setAdminPassword.run(crypto.encrypt(password), profile.id);
    req?.audit?.({ action: 'db.root_password', target: profile.profile_name, args: { hosts: result.hosts, myCnfUpdated: result.myCnfUpdated } });
    return { ...result, profile: profile.profile_name, engine: profile.engine, profileUpdated: profile.admin_user === superuser };
  }

  // -------------------------------------------------------------- grants ---

  const normalizePrivs = (privs, profile) => {
    const allowed = isPg(profile) ? PG_PRIVILEGES : PRIVILEGES;
    const list = [...new Set(privs.map((p) => String(p).toUpperCase().trim()))];
    const bad = list.filter((p) => !allowed.includes(p));
    if (bad.length) throw unprocessable(`Unknown privilege(s): ${bad.join(', ')}`, { privileges: bad.map((p) => `"${p}" is not a grantable privilege`) });
    return list.includes('ALL PRIVILEGES') ? ['ALL PRIVILEGES'] : list.sort();
  };

  // Database-level grants of a user at every host it exists at. `grants` is the
  // union across hosts; a database whose privileges differ between hosts is
  // flagged `mixed` so the editor normalises all hosts on save.
  async function liveGrants(name, hosts, profile, req) {
    if (isPg(profile)) {
      const live = await run('grants.list', { user: name }, req, profile);
      const grants = live.grants.filter((g) => g.table === '*' && g.database !== '*').map((g) => ({ database: g.database, privileges: g.privileges.map((p) => p.toUpperCase()).sort() }));
      return { grants, raw: live.raw, perHost: {} };
    }
    const perHost = {};
    const raw = [];
    for (const h of hosts) {
      const live = await run('grants.list', { user: name, host: h }, req, profile);
      perHost[h] = live.grants.filter((g) => g.table === '*' && g.database !== '*').map((g) => ({ database: g.database, privileges: g.privileges.map((p) => p.toUpperCase()).sort() }));
      raw.push(...(live.raw || []));
    }
    const byDb = new Map();
    for (const h of hosts) {
      for (const g of perHost[h]) {
        const entry = byDb.get(g.database) || { database: g.database, privileges: g.privileges, hosts: [], mixed: false };
        if (entry.hosts.length && entry.privileges.join(',') !== g.privileges.join(',')) entry.mixed = true;
        entry.hosts.push(h);
        byDb.set(g.database, entry);
      }
    }
    const grants = [...byDb.values()].map((g) => ({ ...g, mixed: g.mixed || g.hosts.length !== hosts.length })).sort((a, b) => a.database.localeCompare(b.database));
    return { grants, raw, perHost };
  }

  async function grantsFor(name, user) {
    const profile = requireProfile();
    const row = stmts.userByName.get(name);
    if (row) assertVisible(row, user, 'Database user');
    else assertRoot(user, 'Reading grants of an unmapped database user');
    const hosts = isPg(profile) ? [] : await resolveHosts(name, row, profile, null);
    const live = await liveGrants(name, hosts, profile, null);
    const grants = live.grants.map((g) => ({ database: g.database, privileges: g.privileges, ...(isPg(profile) ? {} : { hosts: g.hosts, mixed: g.mixed }) }));
    return { name, account: row?.account ?? null, hosts, grants, perHost: live.perHost, raw: live.raw, recorded: row ? stmts.grantsForUser.all(row.id).map((g) => ({ database: g.database, privileges: g.privileges.split(',').map((p) => p.trim()) })) : [] };
  }

  // Ownership and system-database checks for a grant list, shared by
  // setGrants and createUser (which runs them before the user exists).
  function assertGrantTargets(wanted, row, user, profile, name) {
    const target = new Map();
    for (const g of wanted) {
      const dbRow = stmts.dbByName.get(g.database);
      if (!isRoot(user)) {
        if (!dbRow || dbRow.owner_id !== user.id) throw forbidden(`Database "${g.database}" is not managed by one of your accounts`);
        if (row?.account_id != null && dbRow.account_id !== row.account_id) throw forbidden(`Database "${g.database}" belongs to a different account than user "${name}"`);
      }
      if (SYSTEM_DATABASES.has(g.database)) throw badRequest(`Privileges on system database "${g.database}" cannot be granted from the panel`);
      target.set(g.database, normalizePrivs(g.privileges, profile));
    }
    return target;
  }

  // Replaces the user's database-level grants with `wanted` (revoke + grant diff).
  async function setGrants(name, wanted, user, req) {
    const profile = requireProfile();
    const row = stmts.userByName.get(name);
    if (row) assertVisible(row, user, 'Database user');
    else assertRoot(user, 'Granting privileges to an unmapped database user');
    const target = assertGrantTargets(wanted, row, user, profile, name);
    const hosts = isPg(profile) ? [] : await resolveHosts(name, row, profile, req);
    // The diff is computed against the union of every host's grants, so a
    // privilege that drifted onto one host only is still revoked, and a
    // database present at some hosts only is re-granted everywhere.
    const live = await liveGrants(name, hosts, profile, req);
    const current = new Map(live.grants.map((g) => [g.database, g.mixed ? null : g.privileges]));
    const changes = [];
    for (const [database] of current) {
      if (!target.has(database)) { await run('revoke', { user: name, database, ...(isPg(profile) ? {} : { hosts }) }, req, profile); changes.push({ database, action: 'revoked' }); }
    }
    for (const [database, privs] of target) {
      const had = current.has(database);
      const have = current.get(database);
      if (have && have.join(',') === privs.join(',')) continue;
      if (had) await run('revoke', { user: name, database, ...(isPg(profile) ? {} : { hosts }) }, req, profile);
      await run('grant', { user: name, database, privileges: privs, ...(isPg(profile) ? {} : { hosts }) }, req, profile);
      changes.push({ database, action: had ? 'changed' : 'granted', privileges: privs });
    }
    if (row) {
      db.transaction(() => {
        stmts.deleteGrantsForUser.run(row.id);
        for (const [database, privs] of target) {
          const dbRow = stmts.dbByName.get(database);
          if (dbRow) stmts.upsertGrant.run(row.id, dbRow.id, privs.join(', '));
        }
      })();
    }
    req?.audit?.({ action: 'db.grants.set', target: name, args: { grants: [...target].map(([database, privileges]) => ({ database, privileges })), changes: changes.length } });
    return { name, hosts, grants: [...target].map(([database, privileges]) => ({ database, privileges })), changes };
  }

  // ------------------------------------------------------------ map tool ---

  async function map(user) {
    assertRoot(user, 'The Database Map Tool');
    let serverDbs = [];
    let serverUsers = [];
    let engineError = null;
    try {
      serverDbs = await run('databases.list');
      serverUsers = await run('users.list');
    } catch (err) { if (err instanceof CapabilityError) throw err; engineError = { code: err.code, message: err.message }; }
    const dbMap = new Map(stmts.dbRows.all().map((r) => [r.name, r]));
    const userMap = new Map(stmts.userRows.all().map((r) => [r.name, r]));
    const databases = serverDbs.filter((d) => !d.system).map((d) => ({ name: d.name, sizeBytes: d.sizeBytes, account: dbMap.get(d.name)?.account ?? null, onServer: true }));
    for (const [name, r] of dbMap) if (!databases.some((d) => d.name === name)) databases.push({ name, sizeBytes: null, account: r.account, onServer: false });
    const seenUsers = new Set();
    const users = [];
    for (const u of serverUsers) {
      if (u.system || seenUsers.has(u.user)) continue;
      seenUsers.add(u.user);
      users.push({ name: u.user, hosts: serverUsers.filter((x) => x.user === u.user).map((x) => x.host).filter(Boolean), account: userMap.get(u.user)?.account ?? null, onServer: true });
    }
    for (const [name, r] of userMap) if (!seenUsers.has(name)) users.push({ name, hosts: stmts.userHosts.all(r.id).map((h) => h.host), account: r.account, onServer: false });
    const accounts = stmts.accountsVisible.all({ owner: null }).map((a) => a.username);
    // Suggest an owner for unmapped objects from the cPanel-style prefix.
    const suggest = (name) => accounts.find((a) => name.startsWith(`${a}_`)) || (accounts.includes(name) ? name : null);
    return { databases: databases.map((d) => ({ ...d, suggested: d.account ? null : suggest(d.name) })).sort((a, b) => a.name.localeCompare(b.name)), users: users.map((u) => ({ ...u, suggested: u.account ? null : suggest(u.name) })).sort((a, b) => a.name.localeCompare(b.name)), accounts, engineError, prefixing: prefixing() };
  }

  async function assign({ kind, name, account }, user, req) {
    assertRoot(user, 'The Database Map Tool');
    const profile = activeRow();
    let accountRow = null;
    if (account) {
      accountRow = loadAccount(account, user);
      if (kind === 'database') {
        const existing = stmts.dbByName.get(name);
        if ((!existing || existing.account_id !== accountRow.id) && quotaFor(accountRow).remaining === 0) throw conflict(`Account "${account}" has reached its database limit (${accountRow.plan.max_db})`);
      }
    }
    let hosts = [];
    if (kind === 'database') {
      stmts.assignDb.run({ account_id: accountRow?.id ?? null, name, instance_id: profile?.id ?? null });
    } else {
      stmts.assignUser.run({ account_id: accountRow?.id ?? null, name, instance_id: profile?.id ?? null });
      const row = stmts.userByName.get(name);
      // Adopted users keep the hosts they really exist at, so grants and access
      // hosts act on those rather than on an assumed localhost.
      if (profile && !stmts.userHosts.all(row.id).length) {
        try { hosts = await liveHostsOf(name, profile, req); } catch (err) { logger.warn({ err, user: name }, 'could not read the hosts of an adopted database user'); }
        if (hosts.length) recordHosts(row.id, hosts);
      } else {
        hosts = recordedHosts(row);
      }
    }
    req?.audit?.({ action: 'db.map.assign', target: name, args: { kind, account: account ?? null, hosts } });
    return { kind, name, account: account ?? null, hosts };
  }

  function unassign({ kind, name }, user, req) {
    assertRoot(user, 'The Database Map Tool');
    if (kind === 'database') stmts.deleteDb.run(name); else stmts.deleteUser.run(name);
    req?.audit?.({ action: 'db.map.unassign', target: name, args: { kind } });
    return { kind, name, account: null };
  }

  // -------------------------------------------------------- access hosts ---

  // Resellers see their own accounts' hosts plus the global ones (read-only for
  // them), since their users are provisioned at both.
  function listAccessHosts(query, user) {
    let rows = stmts.accessHosts.all();
    if (!isRoot(user)) rows = rows.filter((r) => r.account_id == null || r.owner_id === user.id);
    if (query.account) rows = rows.filter((r) => r.account === query.account || (r.account_id == null && !isRoot(user)));
    const profile = activeRow();
    return { data: rows.map(({ owner_id, ...r }) => ({ ...r, scope: r.account_id == null ? 'global' : 'account', editable: isRoot(user) || r.account_id != null })), meta: { total: rows.length, engine: profile?.engine ?? null, supported: profile ? !isPg(profile) : false } };
  }

  async function addAccessHost(input, user, req) {
    const profile = await requireEngine(requireProfile());
    let account = null;
    if (input.account) account = loadAccount(input.account, user); else assertRoot(user, 'Adding a global access host');
    const host = input.host.trim();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') throw badRequest('Local access is always allowed; add remote hosts only');
    const exists = stmts.accessHosts.all().find((r) => r.host === host && (r.account_id ?? null) === (account?.id ?? null));
    if (exists) throw conflict(`Host "${host}" is already allowed${account ? ` for ${account.username}` : ' globally'}`);
    const users = account ? stmts.usersForAccount.all(account.id) : stmts.userRows.all().filter((u) => u.account_id != null);
    const applied = [];
    const failed = [];
    if (!isPg(profile)) {
      for (const u of users) {
        try {
          const existing = recordedHosts(u);
          const r = await run('user.add_host', { user: u.name, fromHost: existing.length ? preferredHost(existing) : 'localhost', toHost: host }, req, profile);
          stmts.addUserHost.run(u.id, host);
          applied.push({ user: u.name, created: r.created });
        } catch (err) {
          if (err instanceof CapabilityError) throw err;
          failed.push({ user: u.name, error: err.message });
        }
      }
      // The host is only recorded once the server side reflects it; otherwise
      // the panel would claim remote access that no user actually has.
      if (users.length && !applied.length) {
        req?.audit?.({ action: 'db.access_host.add', target: host, result: 'error', args: { account: account?.username ?? null, users: 0, failed: failed.length } });
        throw new HttpError(502, 'db_error', `Host "${host}" was not added: no database user could be provisioned at it (${failed.map((f) => `${f.user}: ${f.error}`).join('; ')})`, { host: failed.map((f) => `${f.user}: ${f.error}`) });
      }
    }
    const { lastInsertRowid } = stmts.insertAccessHost.run(account?.id ?? null, host);
    req?.audit?.({ action: 'db.access_host.add', target: host, args: { account: account?.username ?? null, users: applied.length, failed: failed.length } });
    return { id: Number(lastInsertRowid), host, account: account?.username ?? null, scope: account ? 'account' : 'global', applied, failed, supported: !isPg(profile) };
  }

  async function removeAccessHost(id, user, req) {
    const profile = requireProfile();
    const row = stmts.accessHostById.get(id);
    if (!row) throw notFound('Access host');
    if (row.account_id == null) assertRoot(user, 'Removing a global access host');
    else if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That access host belongs to another reseller');
    // Only users the panel provisioned at this host are touched: a user that was
    // never cloned there (a failed add, or one adopted later) has nothing to drop.
    const users = isPg(profile) ? [] : stmts.usersAtHost.all({ host: row.host, account: row.account_id ?? null });
    const removed = [];
    for (const u of users) {
      // Keep the host when another rule (global vs per-account) still grants it.
      const stillAllowed = stmts.accessHosts.all().some((r) => r.id !== id && r.host === row.host && (r.account_id == null || r.account_id === u.account_id));
      if (stillAllowed) continue;
      try {
        await run('user.drop', { user: u.name, hosts: [row.host] }, req, profile);
      } catch (err) {
        // Already gone on the server (1141/1396): the record is still cleared.
        if (err instanceof CapabilityError || (err.status !== 404 && err.status !== 409)) throw err;
      }
      stmts.removeUserHost.run(u.id, row.host);
      removed.push(u.name);
    }
    stmts.deleteAccessHost.run(id);
    req?.audit?.({ action: 'db.access_host.remove', target: row.host, args: { account: row.account ?? null, users: removed.length } });
    return { id, host: row.host, account: row.account ?? null, removedFrom: removed };
  }

  // ------------------------------------------------------------ profiles ---

  function listProfiles(user) {
    assertRoot(user, 'Managing database profiles');
    return stmts.profiles.all().map(shapeProfile);
  }

  function profileInput(input, current = {}) {
    const row = {
      profile_name: input.profile_name ?? current.profile_name,
      engine: input.engine ?? current.engine ?? 'mysql',
      host: input.host ?? current.host ?? 'localhost',
      port: input.port === undefined ? (current.port ?? null) : input.port,
      is_local: input.is_local === undefined ? (current.is_local ?? 1) : (input.is_local ? 1 : 0),
      admin_user: input.admin_user === undefined ? (current.admin_user ?? null) : (input.admin_user || null),
      admin_password_enc: current.admin_password_enc ?? null,
    };
    if (input.admin_password !== undefined) row.admin_password_enc = input.admin_password ? crypto.encrypt(input.admin_password) : null;
    if (row.host !== 'localhost' && row.host !== '127.0.0.1' && row.host !== '::1') row.is_local = 0;
    if (!row.is_local && !row.admin_user) throw badRequest('Remote profiles need an administrative user', { admin_user: ['Required for remote servers'] });
    if (!row.port) row.port = row.engine === 'postgres' ? 5432 : 3306;
    return row;
  }

  function createProfile(input, user, req) {
    assertRoot(user, 'Managing database profiles');
    if (stmts.profileByName.get(input.profile_name)) throw conflict(`A profile named "${input.profile_name}" already exists`);
    const row = profileInput(input);
    const { lastInsertRowid } = stmts.insertProfile.run(row);
    req?.audit?.({ action: 'db.profile.create', target: input.profile_name, args: { engine: row.engine, host: row.host, port: row.port, admin_user: row.admin_user } });
    return shapeProfile(stmts.profileById.get(lastInsertRowid));
  }

  function updateProfile(id, input, user, req) {
    assertRoot(user, 'Managing database profiles');
    const current = stmts.profileById.get(id);
    if (!current) throw notFound('Database profile');
    if (input.profile_name && input.profile_name !== current.profile_name && stmts.profileByName.get(input.profile_name)) throw conflict(`A profile named "${input.profile_name}" already exists`);
    const row = profileInput(input, current);
    stmts.updateProfile.run({ ...row, id });
    req?.audit?.({ action: 'db.profile.update', target: current.profile_name, args: { engine: row.engine, host: row.host, port: row.port, admin_user: row.admin_user, passwordChanged: input.admin_password !== undefined } });
    return shapeProfile(stmts.profileById.get(id));
  }

  function removeProfile(id, user, req) {
    assertRoot(user, 'Managing database profiles');
    const current = stmts.profileById.get(id);
    if (!current) throw notFound('Database profile');
    if (current.is_active) throw conflict('The active profile cannot be deleted; activate another profile first');
    stmts.deleteProfile.run(id);
    req?.audit?.({ action: 'db.profile.delete', target: current.profile_name });
    return { id, deleted: true };
  }

  async function testProfile(id, user, req) {
    assertRoot(user, 'Managing database profiles');
    const profile = stmts.profileById.get(id);
    if (!profile) throw notFound('Database profile');
    let result;
    try {
      result = await run('ping', {}, req, profile);
    } catch (err) {
      if (err instanceof CapabilityError) { stmts.upsertStatus.run(id, 0, err.message, null); throw err; }
      result = { ok: false, error: err.message, code: err.code };
    }
    stmts.upsertStatus.run(id, result.ok ? 1 : 0, result.ok ? `Connected as ${result.user} in ${result.ms} ms` : result.error, result.version ?? null);
    req?.audit?.({ action: 'db.profile.test', target: profile.profile_name, args: { ok: result.ok } });
    return { id, profile: profile.profile_name, ...result };
  }

  function activateProfile(id, user, req) {
    assertRoot(user, 'Managing database profiles');
    const profile = stmts.profileById.get(id);
    if (!profile) throw notFound('Database profile');
    db.transaction(() => { stmts.deactivateAll.run(); stmts.activate.run(id); })();
    req?.audit?.({ action: 'db.profile.activate', target: profile.profile_name });
    return shapeProfile(stmts.profileById.get(id));
  }

  // ------------------------------------------------------- configuration ---

  // A PostgreSQL profile is not a missing MySQL: the page gets a plain notice
  // instead of an install prompt.
  function requireMysqlConfigProfile() {
    const profile = requireProfile();
    if (isPg(profile)) throw new HttpError(409, 'unsupported_engine', 'Configuration editing is available for MySQL/MariaDB profiles; PostgreSQL is tuned through postgresql.conf. Activate a MySQL/MariaDB profile to use this page.');
    if (!profile.is_local) throw badRequest('The active profile is a remote server; configuration files can only be edited for the local server');
    return profile;
  }

  // Variables shown in the "Running value" column: every known tunable plus
  // whatever the managed include currently sets (option names use dashes,
  // variables underscores).
  function runtimeVariableNames(settingsInFile = {}) {
    const names = new Set(KNOWN_TUNABLES.map((t) => t.label));
    for (const k of Object.keys(settingsInFile)) {
      const v = k.replace(/-/g, '_');
      if (/^[A-Za-z0-9_]{1,64}$/.test(v)) names.add(v);
    }
    return [...names].slice(0, 200);
  }

  async function getConfig(user) {
    assertRoot(user, 'Editing the database configuration');
    const profile = requireMysqlConfigProfile();
    await capabilities.ensureFresh();
    let file;
    try { file = await agent.op('db.config.read'); } catch (err) { throw translateError(err, profile); }
    let unit = null;
    try { unit = await agent.op('db.unit'); } catch { unit = null; }
    let runtime = null;
    if (capabilities.has('mysql')) {
      try { runtime = await run('variables.get', { names: runtimeVariableNames(file.settings), status: true }, null, profile); } catch (err) { runtime = { error: err.message }; }
    }
    return { ...file, unit, runtime, tunables: KNOWN_TUNABLES };
  }

  async function setConfig(input, user, req) {
    assertRoot(user, 'Editing the database configuration');
    const profile = requireMysqlConfigProfile();
    let result;
    try { result = await agent.op('db.config.write', { settings: input.settings, replace: Boolean(input.replace) }, { req }); } catch (err) { throw translateError(err, profile); }
    let restart = null;
    if (input.restart) {
      try { restart = await agent.op(restartOp(profile), {}, { req }); } catch (err) { throw translateError(err, profile); }
    }
    req?.audit?.({ action: 'db.config.update', target: result.path, args: { settings: input.settings, restart: Boolean(input.restart) } });
    return { ...result, restart };
  }

  async function restart(user, req) {
    assertRoot(user, 'Restarting the database server');
    const profile = await requireEngine(requireProfile());
    if (!profile.is_local) throw badRequest('The active profile is a remote server; only the local database server can be restarted from this panel');
    try {
      const result = await agent.op(restartOp(profile), {}, { req });
      req?.audit?.({ action: 'db.restart', target: result.unit, args: { engine: profile.engine } });
      return result;
    } catch (err) { throw translateError(err, profile); }
  }

  async function variables(user) {
    assertRoot(user, 'Reading server variables');
    return run('variables.get', { status: true });
  }

  // -------------------------------------------------------------- repair ---

  function visibleDatabaseNames(user) {
    return stmts.dbRows.all().filter((r) => isRoot(user) || (r.account_id != null && r.owner_id === user.id)).map((r) => r.name);
  }

  async function enqueueRepair(input, user, req) {
    const profile = requireProfile();
    await capabilities.ensureFresh();
    if (!capabilities.has(capFor(profile))) throw new CapabilityError(capFor(profile));
    let databases = input.databases || [];
    if (!isRoot(user)) {
      const mine = visibleDatabaseNames(user);
      if (!databases.length) databases = mine;
      const bad = databases.filter((d) => !mine.includes(d));
      if (bad.length) throw forbidden(`Database(s) not managed by your accounts: ${bad.join(', ')}`);
      if (!databases.length) throw badRequest('None of your accounts has a database to check');
    }
    const job = ctx.jobs.enqueue('db.repair', { action: input.action || 'check', databases, autoRepair: Boolean(input.autoRepair), profileId: profile.id }, { userId: user.id });
    stmts.insertRepairRun.run(job.id, input.action || 'check', JSON.stringify(databases), null, user.username);
    req?.audit?.({ action: 'db.repair.enqueue', target: databases.length ? databases.join(',') : 'all', args: { action: input.action || 'check', job: job.id } });
    return { job: { id: job.id }, action: input.action || 'check', databases };
  }

  async function runRepair(job) {
    const { action, databases, autoRepair, profileId } = job.params;
    const profile = (profileId && stmts.profileById.get(profileId)) || requireProfile();
    job.log(`${action} ${databases?.length ? databases.join(', ') : 'all databases'} on profile ${profile.profile_name} (${profile.engine})`);
    job.progress(10, 'running mysqlcheck');
    const result = await run('check', { action, ...(databases?.length ? { databases } : {}), ...(isPg(profile) ? {} : { autoRepair }) }, null, profile);
    for (const r of result.results) if (r.status !== 'ok') job.log(`${r.table}: ${r.status}${r.messages.length ? ` — ${r.messages.join(' | ')}` : ''}`, r.status === 'error' ? 'error' : 'warn');
    job.log(`${result.summary.tables} table(s): ${result.summary.ok} ok, ${result.summary.repaired} repaired, ${result.summary.warnings} warnings, ${result.summary.errors} errors`);
    stmts.updateRepairRun.run(JSON.stringify(result.summary), job.job.id);
    job.progress(100, 'finished');
    return result;
  }

  function repairHistory(user) {
    const rows = stmts.repairRuns.all().map((r) => ({ ...r, databases: json.parse(r.databases, []), summary: json.parse(r.summary, null) }));
    return { runs: isRoot(user) ? rows : rows.filter((r) => r.started_by === user.username), databases: visibleDatabaseNames(user) };
  }

  // ----------------------------------------------------------- processes ---

  async function processes(user) {
    assertRoot(user, 'Viewing database processes');
    const rows = await run('processlist');
    return { processes: rows, profile: shapeProfile(activeRow()) };
  }

  async function kill(id, queryOnly, user, req) {
    assertRoot(user, 'Killing database processes');
    const result = await run('kill', { id, queryOnly: Boolean(queryOnly) }, req);
    req?.audit?.({ action: 'db.process.kill', target: String(id), args: { queryOnly: Boolean(queryOnly) } });
    return result;
  }

  // ------------------------------------------------------------- upgrade ---

  async function upgradeStatus(user) {
    assertRoot(user, 'Upgrading the database server');
    const profile = activeRow();
    let version = null;
    let error = null;
    if (profile) { try { version = await run('version', {}, null, profile); } catch (err) { if (err instanceof CapabilityError) error = { code: err.code, message: err.message }; else error = { code: err.code, message: err.message }; } }
    const packages = await serverPackages();
    const jobs = ctx.jobs.list({ type: 'db.upgrade', limit: 5 });
    return { profile: shapeProfile(profile), version, error, packages, packageManager: packages.manager, installerAvailable: Boolean(packages.manager), local: profile ? Boolean(profile.is_local) : false, recentJobs: jobs.map((j) => ({ id: j.id, status: j.status, created_at: j.created_at, finished_at: j.finished_at, params: j.params, result: j.result, error: j.error })), backupDir: settings.get('db.upgrade.backup_dir', '/var/backups/whm/db') };
  }

  async function serverPackages(candidates) {
    const empty = { manager: null, installed: [], available: [], engine: null };
    try { return { ...empty, ...(await agent.op('db.packages', candidates ? { candidates } : {})) }; } catch (err) { logger.warn({ err }, 'db.packages failed'); return empty; }
  }

  async function enqueueUpgrade(input, user, req) {
    assertRoot(user, 'Upgrading the database server');
    const profile = requireProfile();
    if (!profile.is_local) throw badRequest('Only the local database server can be upgraded from this panel');
    // The principal travels with the job so the agent log of pkg.install names
    // who asked for it.
    const principal = { username: user.username, role: user.role, ip: req?.ip ?? null, requestId: req?.id ?? null };
    const job = ctx.jobs.enqueue('db.upgrade', { target: input.target, backup: input.backup !== false, profileId: profile.id, principal }, { userId: user.id });
    req?.audit?.({ action: 'db.upgrade.enqueue', target: input.target, args: { backup: input.backup !== false, job: job.id } });
    return { job: { id: job.id }, target: input.target };
  }

  // "apt-get install" / "dnf install" of a package that is already at the
  // candidate version changes nothing; the server is then left alone.
  function installChangedNothing(output) {
    const lines = Array.isArray(output) ? output : String(output || '').split('\n');
    const text = lines.join('\n');
    if (/is already the newest version/i.test(text) && !/^(Setting up|Unpacking|Preparing to unpack) /m.test(text)) return true;
    if (/^Nothing to do\.?$/m.test(text) || /Package .* is already installed/i.test(text) && !/^(Upgrading|Installing|Installed:|Upgraded:)/m.test(text)) return true;
    return false;
  }

  async function runUpgrade(job) {
    const { target, backup, profileId, principal } = job.params;
    const req = principal ? { user: { username: principal.username, role: principal.role }, ip: principal.ip, id: principal.requestId } : undefined;
    const profile = (profileId && stmts.profileById.get(profileId)) || requireProfile();
    const result = { target, backup: null, installed: false, alreadyCurrent: false, manager: null, restarted: null, tablesUpgraded: null, versionBefore: null, versionAfter: null, available: true, reason: null };
    try { result.versionBefore = (await run('version', {}, null, profile)).version; } catch (err) { job.log(`could not read current version: ${err.message}`, 'warn'); }
    job.progress(5, 'preparing');
    const packages = await serverPackages([target]);
    if (!packages.manager) {
      result.available = false;
      result.reason = 'No supported package manager (apt-get, dnf or yum) was found on this server, so no package was installed. Install the target package by hand and re-run the table upgrade.';
      job.log(result.reason, 'warn');
      job.progress(100, 'not available');
      return result;
    }
    result.manager = packages.manager;
    const candidate = packages.available.find((p) => p.name === target);
    job.log(candidate ? `${packages.manager}: ${target} candidate ${candidate.candidate}${candidate.installed ? ` (installed ${candidate.installed})` : ''}` : `${packages.manager}: no candidate version listed for ${target}; the package manager decides what to install`);
    if (backup && !isPg(profile)) {
      const dir = settings.get('db.upgrade.backup_dir', '/var/backups/whm/db');
      const file = path.join(dir, `pre-upgrade-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);
      job.progress(10, 'dumping all databases');
      try { result.backup = await run('dump', { path: file }, null, profile); job.log(`backup written to ${file} (${result.backup.sizeBytes} bytes)`); } catch (err) { throw new Error(`pre-upgrade backup failed: ${err.message}`); }
    }
    job.progress(30, `installing ${target}`);
    job.log(`${packages.manager} install ${target}`);
    let install;
    try { install = await agent.op('pkg.install', { packages: [target] }, { req }); } catch (err) { throw new Error(`${packages.manager} could not install ${target}: ${err.message}`); }
    for (const line of Array.isArray(install.output) ? install.output : String(install.output || '').split('\n')) if (line.trim()) job.log(line);
    if (installChangedNothing(install.output) || (candidate?.installed && candidate.candidate === candidate.installed)) {
      result.alreadyCurrent = true;
      result.reason = `${target} is already at the newest version the package manager offers${candidate?.installed ? ` (${candidate.installed})` : ''}; the server was not restarted and no table upgrade ran.`;
      result.versionAfter = result.versionBefore;
      job.log(result.reason);
      job.progress(100, 'already current');
      return result;
    }
    result.installed = true;
    job.progress(70, 'restarting database server');
    try { result.restarted = await agent.op(restartOp(profile), {}, { req }); job.log(`restarted ${result.restarted.unit}: ${result.restarted.state}`); } catch (err) { job.log(`restart failed: ${err.message}`, 'error'); throw err; }
    if (!isPg(profile)) {
      job.progress(85, 'upgrading system tables');
      try { result.tablesUpgraded = await run('upgrade_tables', {}, req, profile); job.log(result.tablesUpgraded.ran ? result.tablesUpgraded.output.split('\n').slice(-5).join('\n') : result.tablesUpgraded.reason); } catch (err) { job.log(`table upgrade failed: ${err.message}`, 'error'); }
    }
    try { result.versionAfter = (await run('version', {}, null, profile)).version; } catch (err) { job.log(`could not read new version: ${err.message}`, 'warn'); }
    job.progress(100, `upgraded to ${result.versionAfter || 'unknown'}`);
    return result;
  }

  // ----------------------------------------------------------- phpMyAdmin ---

  async function phpMyAdmin(user) {
    let detect;
    try { detect = await agent.op('db.phpmyadmin.detect'); } catch (err) { detect = { installed: false, error: err.message }; }
    const override = settings.get('db.phpmyadmin.url', '') || '';
    const hostname = settings.get('basic.hostname', '') || '';
    const url = override || (detect.urlPath ? `https://${hostname}${detect.urlPath}` : null);
    const common = { installed: Boolean(detect.installed), version: detect.version ?? null, url, php: Boolean(detect.php), featureEnabled: Boolean(settings.get('db.phpmyadmin.enabled', true)) };
    // Install directories, config files and web-server files are root's business.
    if (user && !isRoot(user)) return common;
    return { ...detect, ...common, urlOverride: override, hostname };
  }

  function setPhpMyAdminUrl(url, user, req) {
    assertRoot(user, 'Configuring phpMyAdmin');
    settings.set('db.phpmyadmin.url', url || '');
    req?.audit?.({ action: 'db.phpmyadmin.url', target: url || '(auto)' });
    return { url: url || '' };
  }

  // ------------------------------------------------------- per account ---

  function forAccount(username, user) {
    const account = loadAccount(username, user);
    return {
      account: { username: account.username, id: account.id },
      databases: stmts.dbsForAccount.all(account.id).map((d) => ({ name: d.name, users: stmts.grantsForDb.all(d.id).map((g) => g.user), created_at: d.created_at })),
      users: stmts.usersForAccount.all(account.id).map((u) => ({ name: u.name, hosts: stmts.userHosts.all(u.id).map((h) => h.host), grants: stmts.grantsForUser.all(u.id).map((g) => ({ database: g.database, privileges: g.privileges.split(',').map((p) => p.trim()) })) })),
      accessHosts: hostsFor(account.id).filter((h) => h !== 'localhost'),
      quota: quotaFor(account),
      prefix: prefixing() ? `${account.username}_` : '',
    };
  }

  async function removeAccountData(username, req) {
    const account = stmts.accountByUsername.get(username);
    if (!account) return { databases: [], users: [] };
    const profile = activeRow();
    const dropped = { databases: [], users: [], errors: [] };
    for (const u of stmts.usersForAccount.all(account.id)) {
      try { if (profile) await run('user.drop', { user: u.name }, req, profile); dropped.users.push(u.name); } catch (err) { dropped.errors.push(`user ${u.name}: ${err.message}`); }
      stmts.deleteUser.run(u.name);
    }
    for (const d of stmts.dbsForAccount.all(account.id)) {
      try { if (profile) await run('database.drop', { name: d.name }, req, profile); dropped.databases.push(d.name); } catch (err) { dropped.errors.push(`database ${d.name}: ${err.message}`); }
      stmts.deleteDb.run(d.name);
    }
    req?.audit?.({ action: 'db.account.cleanup', target: username, args: dropped });
    return dropped;
  }

  async function dump(input, req) {
    const profile = requireProfile();
    if (isPg(profile)) throw new CapabilityError('mysql', 'Dumps through this service are available for MySQL/MariaDB profiles');
    return run('dump', input, req, profile);
  }

  // ------------------------------------------------- remote service IPs ---

  // "Configure Remote Service IPs" (ip-functions) hands over the local address
  // the panel's connections to remote database profiles are sourced from. It is
  // recorded in settings and written as bind-address into the per-op client
  // credentials file of every remote profile. When the active profile is remote
  // the new address is verified with a connection test before it is kept.
  async function setClientAddresses({ ipv4 = null, ipv6 = null } = {}, req) {
    const fields = {};
    if (ipv4 && net.isIP(ipv4) !== 4) fields.ipv4 = ['Must be an IPv4 address'];
    if (ipv6 && net.isIP(ipv6) !== 6) fields.ipv6 = ['Must be an IPv6 address'];
    if (Object.keys(fields).length) throw unprocessable('Database client addresses must be IP addresses bound to this server', fields);
    const previous = clientAddresses();
    const next = { ipv4: ipv4 || null, ipv6: ipv6 || null };
    const changed = previous.ipv4 !== next.ipv4 || previous.ipv6 !== next.ipv6;
    settings.setMany({ 'db.client.bind_address_ipv4': next.ipv4, 'db.client.bind_address_ipv6': next.ipv6 });
    await capabilities.ensureFresh();
    if (!capabilities.has('mysql')) throw new CapabilityError('mysql', 'MySQL/MariaDB client tools are not installed on this server; the database source address is saved and used once they are');
    const profile = activeRow();
    let verified = null;
    const warnings = [];
    if (profile && isRemote(profile) && !isPg(profile) && bindAddressFor(profile)) {
      let ping;
      try { ping = await run('ping', {}, req, profile); } catch (err) { settings.setMany({ 'db.client.bind_address_ipv4': previous.ipv4, 'db.client.bind_address_ipv6': previous.ipv6 }); throw err; }
      if (!ping.ok) {
        settings.setMany({ 'db.client.bind_address_ipv4': previous.ipv4, 'db.client.bind_address_ipv6': previous.ipv6 });
        throw new HttpError(502, 'db_bind_failed', `Connections to ${profile.profile_name} (${profile.host}) fail when bound to ${next.ipv4 || next.ipv6}: ${ping.error}. The previous address was kept.`);
      }
      verified = true;
      for (const w of ping.warnings || []) if (/bind-address/i.test(w)) warnings.push(`The ${profile.engine} client on this server ignores bind-address (${w}); connections use the routing table's source address.`);
    }
    req?.audit?.({ action: 'db.client_addresses', target: profile?.profile_name ?? 'settings', args: { ...next, changed, verified } });
    return { applied: true, changed, verified, warnings, ...next, profile: profile ? { name: profile.profile_name, remote: isRemote(profile) } : null };
  }

  return {
    activeProfile: () => shapeProfile(activeRow()),
    run,
    status,
    quotaFor,
    hostsFor,
    clientAddresses, setClientAddresses,
    listDatabases, createDatabase, dropDatabase, serverDatabases,
    listUsers, createUser, dropUser, setUserPassword, setRootPassword,
    grantsFor, setGrants,
    map, assign, unassign,
    listAccessHosts, addAccessHost, removeAccessHost,
    listProfiles, createProfile, updateProfile, removeProfile, testProfile, activateProfile,
    getConfig, setConfig, restart, variables,
    enqueueRepair, runRepair, repairHistory,
    processes, kill,
    upgradeStatus, enqueueUpgrade, runUpgrade,
    phpMyAdmin, setPhpMyAdminUrl,
    forAccount, removeAccountData, dump,
    PRIVILEGES, PG_PRIVILEGES, KNOWN_TUNABLES,
  };
}
