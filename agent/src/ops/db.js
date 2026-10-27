import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError, ensurePrivateDir } from './registry.js';

// Database Services op family. MySQL/MariaDB administration goes through the
// mysql CLI with --defaults-extra-file pointing at a 0600 temp file that holds the
// credentials of the active profile (fallback /root/.my.cnf, then socket auth as
// root). SQL is fed over stdin, so neither passwords nor statements ever appear in
// argv or /proc. Identifiers are validated by schema and quoted with backticks;
// string literals are escaped. PostgreSQL ops (pg.*) run psql as the postgres
// system user via runuser, or over TCP with PGPASSWORD in the environment.

const TMP_DIR = '/tmp/whm';
const ROOT_MY_CNF = '/root/.my.cnf';
const MANAGED = '# Managed by WHM panel';

const CLIENT_BINS = ['mysql', 'mariadb'];
const SERVER_BINS = ['mysqld', 'mariadbd'];
const CHECK_BINS = ['mysqlcheck', 'mariadb-check'];
const DUMP_BINS = ['mysqldump', 'mariadb-dump'];
const UPGRADE_BINS = ['mysql_upgrade', 'mariadb-upgrade'];
const UNIT_CANDIDATES = ['mariadb', 'mysql', 'mysqld'];

export const PRIVILEGES = ['ALL PRIVILEGES', 'ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE', 'CREATE TEMPORARY TABLES', 'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'INDEX', 'INSERT', 'LOCK TABLES', 'REFERENCES', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'UPDATE'];
export const PG_PRIVILEGES = ['ALL PRIVILEGES', 'CONNECT', 'CREATE', 'TEMPORARY'];

// ------------------------------------------------------------------ schemas ---

const dbName = z.string().regex(/^[a-z0-9_]{1,64}$/, 'Database name: lowercase letters, digits or "_" (max 64)');
// Existing server users may carry dots and dashes (debian-sys-maint, mysql.sys);
// the panel enforces its own naming for users it creates.
const mysqlUser = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/, 'User name: letters, digits, "_", "." or "-" (max 80)');
const pgName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'PostgreSQL identifier: lowercase letters, digits or "_" (max 63)');
const host = z.string().regex(/^[A-Za-z0-9%:][A-Za-z0-9.%:_-]{0,254}$/, 'Host: IP, hostname or wildcard such as 10.0.0.% (max 255)');
const password = z.string().min(1).max(256).regex(/^[^\n\r\0]+$/, 'Password must be a single line');
const privilege = z.enum(PRIVILEGES);
const pgPrivilege = z.enum(PG_PRIVILEGES);
const configKey = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'Option name: lowercase letters, digits, "_" or "-"');
const configValue = z.string().regex(/^[A-Za-z0-9_./:%,+=-]{0,255}$/, 'Option value: letters, digits and . / : % , + = - _');
const variableName = z.string().regex(/^[A-Za-z0-9_%]{1,64}$/);
const packageName = z.string().regex(/^[a-z0-9][a-z0-9+._-]{0,80}$/);

const ipAddress = z.string().max(45).refine((v) => net.isIP(v) !== 0, 'Must be an IPv4 or IPv6 address');

const credentials = z.object({
  host: host.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: mysqlUser.optional(),
  password: z.string().max(256).regex(/^[^\n\r\0]*$/).optional(),
  socket: arg.absPath.optional(),
  database: pgName.optional(),
  // Local source address for TCP connections to remote servers (Configure
  // Remote Service IPs).
  bindAddress: ipAddress.optional(),
}).strict().optional();

const withCreds = (shape) => z.object({ ...shape, credentials }).strict();

// ------------------------------------------------------------------ helpers ---

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function writeAtomic(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exists(file)) fs.copyFileSync(file, `${file}.whm-bak`);
  const tmp = `${file}.whm-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// Credential files are written in place: no sibling .whm-bak / .whm-tmp files,
// which would sit outside the single allowed path and keep the previous
// password on disk. A backup left behind by earlier versions is removed.
function writeSecret(file, content) {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.unlinkSync(`${file}.whm-bak`); } catch { /* no stale backup */ }
}

function restore(file, previous) {
  if (previous == null) { try { fs.unlinkSync(file); } catch { /* already gone */ } } else fs.writeFileSync(file, previous);
}

export const q = {
  id: (s) => `\`${String(s).replace(/`/g, '``')}\``,
  str: (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/\0/g, '\\0').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/'/g, "\\'")}'`,
  account: (user, h) => `${q.str(user)}@${q.str(h)}`,
  pgId: (s) => `"${String(s).replace(/"/g, '""')}"`,
  pgStr: (s) => `'${String(s).replace(/'/g, "''")}'`,
};

const findBin = (names) => names.find(hasBinary) || null;

function requireClient() {
  const bin = findBin(CLIENT_BINS);
  if (!bin) throw new OpError('capability_missing', 'The MySQL/MariaDB client (mysql or mariadb) is not installed on this server');
  return bin;
}

function requirePsql() {
  if (!hasBinary('psql')) throw new OpError('capability_missing', 'PostgreSQL (psql) is not installed on this server');
  return 'psql';
}

// Option-file values use double quotes with backslash escapes.
const optionValue = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function renderClientCnf(creds) {
  const lines = [`${MANAGED} (temporary client credentials)`, '[client]'];
  if (creds.host) lines.push(`host=${optionValue(creds.host)}`);
  if (creds.port) lines.push(`port=${creds.port}`);
  if (creds.socket) lines.push(`socket=${optionValue(creds.socket)}`);
  if (creds.user) lines.push(`user=${optionValue(creds.user)}`);
  if (creds.password != null) lines.push(`password=${optionValue(creds.password)}`);
  // "loose-": MySQL clients honour bind-address, MariaDB clients only warn.
  if (creds.bindAddress) lines.push(`loose-bind-address=${optionValue(creds.bindAddress)}`);
  return `${lines.join('\n')}\n`;
}

// Non-fatal client diagnostics (e.g. "unknown variable 'loose-bind-address'").
export function clientWarnings(stderr) {
  return String(stderr || '').split('\n').map((l) => l.trim()).filter((l) => /^(warning|\S+: unknown (variable|option))/i.test(l));
}

// Runs fn(defaultsArgv) with a short-lived 0600 credentials file; falls back to
// /root/.my.cnf and finally to the caller's own socket authentication.
async function withDefaults(creds, ctx, fn) {
  if (creds && (creds.user || creds.password != null || creds.host || creds.socket || creds.bindAddress)) {
    ctx.assertAllowedPath(TMP_DIR, 'write');
    ensurePrivateDir(TMP_DIR);
    const file = path.join(TMP_DIR, `my-${process.pid}-${crypto.randomBytes(6).toString('hex')}.cnf`);
    fs.writeFileSync(file, renderClientCnf(creds), { mode: 0o600, flag: 'wx' });
    try { return await fn([`--defaults-extra-file=${file}`]); } finally { try { fs.unlinkSync(file); } catch { /* gone */ } }
  }
  if (exists(ROOT_MY_CNF)) return fn([`--defaults-extra-file=${ROOT_MY_CNF}`]);
  return fn([]);
}

export function classifyMysqlError(stderr) {
  const line = String(stderr || '').trim().split('\n').filter((l) => l.startsWith('ERROR')).pop() || String(stderr || '').trim().split('\n').pop() || 'unknown error';
  const m = line.match(/^ERROR (\d+)/);
  const errno = m ? Number(m[1]) : null;
  let code = 'db_error';
  if (errno === 2002 || errno === 2003 || errno === 2005 || errno === 2013) code = 'db_unreachable';
  else if (errno === 1045 || errno === 1698 || errno === 1044) code = 'db_auth_failed';
  else if (errno === 1007 || errno === 1396 || errno === 1050) code = 'exists';
  else if (errno === 1008 || errno === 1049 || errno === 1141) code = 'not_found';
  else if (errno === 1094) code = 'not_found';
  return { code, errno, message: line.replace(/^ERROR \d+ \([^)]+\)( at line \d+)?:\s*/, '') };
}

// mysql --batch escapes tabs, newlines, backslashes and NUL in values.
function unescapeBatch(v) {
  return v.replace(/\\(.)/g, (_m, c) => ({ t: '\t', n: '\n', 0: '\0', '\\': '\\' }[c] ?? c));
}

export function parseBatch(stdout, { headers = true } = {}) {
  const lines = stdout.replace(/\r?\n$/, '').split('\n').filter((l) => l !== '');
  if (!lines.length) return [];
  const rows = lines.map((l) => l.split('\t').map(unescapeBatch));
  if (!headers) return rows;
  const [head, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === 'NULL' ? null : r[i] ?? null])));
}

// Executes SQL (over stdin) and returns the parsed batch output.
async function mysql(sql, creds, ctx, { headers = true, timeoutMs = 120_000, database, onStderr } = {}) {
  const bin = requireClient();
  return withDefaults(creds, ctx, async (defaults) => {
    const argv = [...defaults, '--batch', '--no-auto-rehash', '--connect-timeout=10'];
    if (!headers) argv.push('--skip-column-names');
    if (database) argv.push(database);
    const { code, stdout, stderr } = await exec(bin, argv, { input: `${sql}\n`, allowFailure: true, timeoutMs });
    if (code !== 0) {
      const err = classifyMysqlError(stderr);
      throw new OpError(err.code, `MySQL: ${err.message}`, { errno: err.errno });
    }
    onStderr?.(stderr);
    return parseBatch(stdout, { headers });
  });
}

async function mysqlScalar(sql, creds, ctx) {
  const rows = await mysql(sql, creds, ctx, { headers: false });
  return rows[0]?.[0] ?? null;
}

export function detectLayout() {
  const debian = exists('/etc/mysql');
  const rhel = exists('/etc/my.cnf.d') || exists('/etc/my.cnf');
  // Debian's my.cnf reads conf.d/ first and then mariadb.conf.d/ or mysql.conf.d/,
  // so the managed include must live in the last directory read, sorted last.
  let managedInclude = null;
  if (exists('/etc/mysql/mariadb.conf.d')) managedInclude = '/etc/mysql/mariadb.conf.d/zz-whm.cnf';
  else if (exists('/etc/mysql/mysql.conf.d')) managedInclude = '/etc/mysql/mysql.conf.d/zz-whm.cnf';
  else if (debian) managedInclude = '/etc/mysql/conf.d/zz-whm.cnf';
  else if (rhel) managedInclude = '/etc/my.cnf.d/zz-whm.cnf';
  const confDirs = ['/etc/mysql/conf.d', '/etc/mysql/mariadb.conf.d', '/etc/mysql/mysql.conf.d', '/etc/my.cnf.d'].filter(exists);
  return {
    flavor: debian ? 'debian' : rhel ? 'rhel' : null,
    mainConf: ['/etc/mysql/my.cnf', '/etc/my.cnf'].find(exists) || null,
    confDirs,
    managedInclude,
    dataDir: exists('/var/lib/mysql') ? '/var/lib/mysql' : null,
    rootMyCnf: exists(ROOT_MY_CNF),
  };
}

export function detectEngine() {
  const client = findBin(CLIENT_BINS);
  const server = findBin(SERVER_BINS);
  const check = findBin(CHECK_BINS);
  const dump = findBin(DUMP_BINS);
  const upgradeTool = findBin(UPGRADE_BINS);
  let engine = null;
  if (server === 'mariadbd' || client === 'mariadb' || exists('/etc/mysql/mariadb.conf.d') || hasBinary('mariadb-check')) engine = 'mariadb';
  else if (server || client) engine = 'mysql';
  return {
    installed: Boolean(client),
    serverInstalled: Boolean(server),
    engine,
    binaries: { client, server, check, dump, upgradeTool, psql: hasBinary('psql') ? 'psql' : null, runuser: hasBinary('runuser') },
    units: UNIT_CANDIDATES,
    layout: detectLayout(),
    postgres: { installed: hasBinary('psql'), dataDirs: ['/var/lib/postgresql', '/var/lib/pgsql'].filter(exists) },
  };
}

async function resolveUnit() {
  if (!hasBinary('systemctl')) return null;
  for (const unit of UNIT_CANDIDATES) {
    const { stdout } = await exec('systemctl', ['show', `${unit}.service`, '--no-pager', '--property=LoadState'], { allowFailure: true });
    if (/LoadState=(loaded|masked)/.test(stdout) && !/not-found/.test(stdout)) return unit;
  }
  return null;
}

// Debian ships an umbrella postgresql.service that restarts every
// postgresql@<ver>-<cluster> instance; RHEL names the unit postgresql-<ver>.
export function pickPgUnit(listUnitsOutput) {
  const units = listUnitsOutput.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => /^postgresql(-\d[\w.]*)?(@[\w.-]+)?\.service$/.test(u)).map((u) => u.replace(/\.service$/, ''));
  return units.find((u) => u === 'postgresql') || units.filter((u) => !u.includes('@')).sort()[0] || units.sort()[0] || null;
}

async function resolvePgUnit() {
  if (!hasBinary('systemctl')) return null;
  const { stdout } = await exec('systemctl', ['list-units', '--all', '--plain', '--no-legend', '--no-pager', 'postgresql*.service'], { allowFailure: true });
  return pickPgUnit(stdout);
}

async function unitState(unit, properties = 'ActiveState,SubState,MainPID') {
  const { stdout } = await exec('systemctl', ['show', `${unit}.service`, '--no-pager', `--property=${properties}`], { allowFailure: true });
  return Object.fromEntries(stdout.trim().split('\n').map((l) => l.split('=')));
}

// Parses a my.cnf-style include into { section: { key: value } }.
export function parseCnf(text) {
  const out = {};
  let section = null;
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('!')) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1].trim(); out[section] ||= {}; continue; }
    if (!section) continue;
    const i = line.indexOf('=');
    const key = (i >= 0 ? line.slice(0, i) : line).trim().replace(/_/g, '-');
    let value = i >= 0 ? line.slice(i + 1).trim() : '';
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    out[section][key] = value;
  }
  return out;
}

export function renderCnf(settings) {
  const lines = [`${MANAGED} (Edit Database Configuration). Values here override the distribution files; edit through the panel.`, '[mysqld]'];
  for (const [k, v] of Object.entries(settings).sort(([a], [b]) => a.localeCompare(b))) {
    if (v == null) continue;
    lines.push(v === '' ? k : `${k}=${v}`);
  }
  return `${lines.join('\n')}\n`;
}

// mysqld refuses to start as root ("Please read 'Security' section of the
// manual") even for --validate-config, so the probe always runs as the mysql
// user. A probe that could not run at all (root guard, missing user, missing
// data dir permissions) is reported as not validated rather than as a rejection
// so a valid file is never rolled back by a mis-probe.
const PROBE_FAILURES = /Please read ["']?Security["']? section|Can't change to run as user|Can't create test file|Can't lock aria control file|InnoDB: Unable to lock|Permission denied|Could not open the mysql\.plugin table/i;
const CONFIG_REJECTIONS = /unknown (variable|option)|ambiguous option|error while loading|unknown suffix|option '[^']*' requires an argument|Wrong value for|value is invalid|Error while setting value/i;

export function classifyProbeOutput(code, text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const rejection = lines.find((l) => CONFIG_REJECTIONS.test(l));
  if (rejection) return { validated: true, ok: false, output: rejection };
  if (code === 0) return { validated: true, ok: true, output: lines.pop() || '' };
  const failure = lines.find((l) => PROBE_FAILURES.test(l));
  if (failure) return { validated: false, ok: true, output: `configuration not validated (${failure})` };
  return { validated: true, ok: false, output: lines.pop() || `server exited with status ${code}` };
}

export async function validateServerConfig(server = findBin(SERVER_BINS)) {
  if (!server) return { validated: false, ok: true, output: 'server binary not found; configuration not validated' };
  const probe = await exec(server, ['--validate-config', '--user=mysql'], { allowFailure: true, timeoutMs: 60_000 });
  const probeText = `${probe.stderr}\n${probe.stdout}`;
  if (!/unknown option '--validate-config'|unrecognized option '--validate-config'|unknown variable 'validate-config/i.test(probeText)) {
    return classifyProbeOutput(probe.code, probeText);
  }
  // MariaDB: --help --verbose parses every option file and complains about unknown variables.
  const help = await exec(server, ['--help', '--verbose', '--user=mysql'], { allowFailure: true, timeoutMs: 60_000 });
  const bad = `${help.stderr}\n${help.stdout}`.split('\n').map((l) => l.trim()).find((l) => CONFIG_REJECTIONS.test(l) && !/^Usage:|^--/.test(l));
  return { validated: true, ok: !bad, output: bad || '' };
}

// ------------------------------------------------------------ detection ---

defineOp('db.detect', {
  description: 'Which database engine (MySQL/MariaDB/PostgreSQL) and tooling this host has, plus the config layout',
  run: async () => detectEngine(),
});

defineOp('db.version', {
  description: 'Server version and comment (SELECT VERSION())',
  schema: withCreds({}),
  run: async ({ credentials: creds }, ctx) => {
    const [row] = await mysql('SELECT VERSION() AS version, @@version_comment AS comment, @@hostname AS hostname, @@port AS port, @@datadir AS datadir, @@socket AS socket', creds, ctx);
    const version = row?.version || '';
    return { ...row, port: Number(row?.port) || null, engine: /mariadb/i.test(`${version} ${row?.comment}`) ? 'mariadb' : 'mysql', major: version.split('-')[0] };
  },
});

defineOp('db.ping', {
  description: 'Test a connection; returns ok:false with the reason instead of throwing',
  schema: withCreds({}),
  run: async ({ credentials: creds }, ctx) => {
    const started = Date.now();
    try {
      let warnings = [];
      const [row] = await mysql('SELECT VERSION() AS version, CURRENT_USER() AS user', creds, ctx, { timeoutMs: 30_000, onStderr: (stderr) => { warnings = clientWarnings(stderr); } });
      return { ok: true, version: row?.version || null, user: row?.user || null, ms: Date.now() - started, warnings };
    } catch (err) {
      if (err.code === 'capability_missing') throw err;
      return { ok: false, code: err.code, error: err.message, ms: Date.now() - started };
    }
  },
});

// ------------------------------------------------------------ databases ---

const SYSTEM_DATABASES = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

defineOp('db.databases.list', {
  description: 'All databases with size and table counts',
  schema: withCreds({}),
  run: async ({ credentials: creds }, ctx) => {
    const rows = await mysql(`SELECT s.SCHEMA_NAME AS name, s.DEFAULT_CHARACTER_SET_NAME AS charset, s.DEFAULT_COLLATION_NAME AS collation,
        COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS size_bytes, COUNT(t.TABLE_NAME) AS tables
      FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
      GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME ORDER BY s.SCHEMA_NAME`, creds, ctx);
    return rows.map((r) => ({ name: r.name, charset: r.charset, collation: r.collation, sizeBytes: Number(r.size_bytes) || 0, tables: Number(r.tables) || 0, system: SYSTEM_DATABASES.has(r.name) }));
  },
});

defineOp('db.database.create', {
  description: 'CREATE DATABASE with a character set and collation',
  schema: withCreds({ name: dbName, charset: z.string().regex(/^[a-z0-9_]{1,32}$/).default('utf8mb4'), collation: z.string().regex(/^[a-z0-9_]{1,64}$/).optional() }),
  run: async ({ name, charset, collation, credentials: creds }, ctx) => {
    if (SYSTEM_DATABASES.has(name)) throw new OpError('refused', `"${name}" is a system database`);
    await mysql(`CREATE DATABASE ${q.id(name)} CHARACTER SET ${q.id(charset)}${collation ? ` COLLATE ${q.id(collation)}` : ''}`, creds, ctx);
    return { name, charset, collation: collation || null };
  },
});

defineOp('db.database.drop', {
  description: 'DROP DATABASE (all tables and data are lost)',
  destructive: true,
  schema: withCreds({ name: dbName }),
  run: async ({ name, credentials: creds }, ctx) => {
    if (SYSTEM_DATABASES.has(name)) throw new OpError('refused', `"${name}" is a system database and cannot be dropped`);
    await mysql(`DROP DATABASE ${q.id(name)}`, creds, ctx, { timeoutMs: 600_000 });
    return { name, dropped: true };
  },
});

// ---------------------------------------------------------------- users ---

defineOp('db.users.list', {
  description: 'All user@host accounts with their authentication plugin and lock state',
  schema: withCreds({}),
  run: async ({ credentials: creds }, ctx) => {
    const rows = await mysql("SELECT User AS user, Host AS host, plugin AS plugin FROM mysql.user WHERE User <> '' ORDER BY User, Host", creds, ctx);
    return rows.map((r) => ({ user: r.user, host: r.host, plugin: r.plugin || null, system: ['root', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys', 'debian-sys-maint', 'mysqlxsys'].includes(r.user) }));
  },
});

defineOp('db.user.create', {
  description: 'CREATE USER at each of the given hosts with the same password',
  schema: withCreds({ user: mysqlUser, password, hosts: z.array(host).min(1).max(50).default(['localhost']) }),
  run: async ({ user, password: pw, hosts, credentials: creds }, ctx) => {
    const sql = hosts.map((h) => `CREATE USER ${q.account(user, h)} IDENTIFIED BY ${q.str(pw)};`).join('\n');
    await mysql(`${sql}\nFLUSH PRIVILEGES;`, creds, ctx);
    return { user, hosts };
  },
});

defineOp('db.user.drop', {
  description: 'DROP USER at the given hosts (or every host the user exists at)',
  destructive: true,
  schema: withCreds({ user: mysqlUser, hosts: z.array(host).max(50).optional() }),
  run: async ({ user, hosts, credentials: creds }, ctx) => {
    if (user === 'root') throw new OpError('refused', 'The root user cannot be dropped from the panel');
    // DROP USER fails as a whole (errno 1396) when any listed account is missing,
    // so only the user@host rows that exist are dropped; the rest are reported.
    const existing = (await mysql(`SELECT Host FROM mysql.user WHERE User = ${q.str(user)}`, creds, ctx, { headers: false })).map((r) => r[0]);
    const targets = hosts ? hosts.filter((h) => existing.includes(h)) : existing;
    const missing = hosts ? hosts.filter((h) => !existing.includes(h)) : [];
    if (!targets.length) return { user, dropped: [], missing };
    await mysql(`${targets.map((h) => `DROP USER ${q.account(user, h)};`).join('\n')}\nFLUSH PRIVILEGES;`, creds, ctx);
    return { user, dropped: targets, missing };
  },
});

async function setPasswordSql(user, h, pw, creds, ctx) {
  try {
    await mysql(`ALTER USER ${q.account(user, h)} IDENTIFIED BY ${q.str(pw)}`, creds, ctx);
  } catch (err) {
    if (err.details?.errno !== 1064) throw err;
    // MariaDB < 10.2 has no ALTER USER ... IDENTIFIED BY.
    await mysql(`SET PASSWORD FOR ${q.account(user, h)} = PASSWORD(${q.str(pw)})`, creds, ctx);
  }
}

defineOp('db.user.set_password', {
  description: 'Change a user password at every host it exists at (ALTER USER)',
  schema: withCreds({ user: mysqlUser, password, hosts: z.array(host).max(50).optional() }),
  run: async ({ user, password: pw, hosts, credentials: creds }, ctx) => {
    let targets = hosts;
    if (!targets) targets = (await mysql(`SELECT Host FROM mysql.user WHERE User = ${q.str(user)}`, creds, ctx, { headers: false })).map((r) => r[0]);
    if (!targets.length) throw new OpError('not_found', `No MySQL user named "${user}"`);
    for (const h of targets) await setPasswordSql(user, h, pw, creds, ctx);
    await mysql('FLUSH PRIVILEGES', creds, ctx);
    return { user, hosts: targets };
  },
});

const pluginName = /^[A-Za-z0-9_]{1,64}$/;
const NATIVE_PLUGINS = new Set(['', 'mysql_native_password', 'mysql_old_password']);

// Builds the statements that recreate user@toHost from the stored authentication
// row (plugin + hash read from mysql.user, hex-encoded so binary caching_sha2
// salts survive stdout) and the parsed SHOW GRANTS lines of the source account.
// Nothing from the server's SHOW CREATE USER / SHOW GRANTS text is replayed
// verbatim: MySQL 8 and MariaDB 10.4+ print backtick-quoted accounts, older
// servers single-quoted ones, so a textual rewrite cannot be trusted.
export function cloneUserStatements({ user, toHost, engine, plugin, hashHex, grantLines }) {
  const to = q.account(user, toHost);
  const name = (plugin || '').trim();
  if (name && !pluginName.test(name)) throw new OpError('db_error', `Authentication plugin "${name}" of ${user} cannot be cloned`);
  const bytes = hashHex ? Buffer.from(hashHex, 'hex') : Buffer.alloc(0);
  const printable = bytes.length > 0 && bytes.every((b) => b >= 0x20 && b <= 0x7e);
  const literal = bytes.length === 0 ? null : printable ? q.str(bytes.toString('latin1')) : `0x${bytes.toString('hex').toUpperCase()}`;
  let create;
  if (engine === 'mariadb') {
    if (NATIVE_PLUGINS.has(name)) create = literal ? `CREATE USER ${to} IDENTIFIED BY PASSWORD ${literal}` : `CREATE USER ${to}`;
    else create = `CREATE USER ${to} IDENTIFIED VIA ${q.id(name)}${literal ? ` USING ${literal}` : ''}`;
  } else if (name) {
    create = `CREATE USER ${to} IDENTIFIED WITH ${q.id(name)}${literal ? ` AS ${literal}` : ''}`;
  } else {
    create = `CREATE USER ${to}`;
  }
  const grants = [];
  for (const line of grantLines || []) {
    const g = parseGrant(line);
    if (!g || (g.privileges.length === 1 && g.privileges[0] === 'USAGE')) continue;
    const obj = `${g.database === '*' ? '*' : q.id(g.database)}.${g.table === '*' ? '*' : q.id(g.table)}`;
    grants.push(`GRANT ${g.raw.join(', ')} ON ${obj} TO ${to}${/\bWITH GRANT OPTION\b/i.test(line) ? ' WITH GRANT OPTION' : ''}`);
  }
  return { create, grants, statements: [create, ...grants] };
}

// Clones user@fromHost (password hash and grants) to user@toHost so remote access
// hosts can be added without knowing the password.
defineOp('db.user.add_host', {
  description: 'Copy an existing user (credentials and grants) to another host',
  schema: withCreds({ user: mysqlUser, fromHost: host.default('localhost'), toHost: host }),
  run: async ({ user, fromHost, toHost, credentials: creds }, ctx) => {
    const present = await mysql(`SELECT 1 FROM mysql.user WHERE User = ${q.str(user)} AND Host = ${q.str(toHost)}`, creds, ctx, { headers: false });
    if (present.length) return { user, host: toHost, created: false };
    const [[version]] = await mysql('SELECT VERSION()', creds, ctx, { headers: false });
    const engine = /mariadb/i.test(version || '') ? 'mariadb' : 'mysql';
    // MariaDB keeps native hashes in Password (and, from 10.4, also in
    // authentication_string); MySQL 5.7+ dropped the Password column.
    const hasPassword = engine === 'mariadb' && (await mysql("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'mysql' AND TABLE_NAME = 'user' AND COLUMN_NAME = 'Password'", creds, ctx, { headers: false })).length > 0;
    const where = `WHERE User = ${q.str(user)} AND Host = ${q.str(fromHost)}`;
    const rows = await mysql(`SELECT plugin, HEX(authentication_string)${hasPassword ? ', HEX(Password)' : ", ''"} FROM mysql.user ${where}`, creds, ctx, { headers: false });
    if (!rows.length) throw new OpError('not_found', `No MySQL user ${user}@${fromHost}`);
    const hex = (v) => (!v || v === 'NULL' ? '' : v);
    const [plugin, authHex, passwordHex] = rows[0];
    const grantLines = (await mysql(`SHOW GRANTS FOR ${q.account(user, fromHost)}`, creds, ctx, { headers: false })).map((r) => r[0]).filter((g) => /^GRANT /i.test(g));
    const { statements, grants } = cloneUserStatements({ user, toHost, engine, plugin: plugin === 'NULL' ? '' : plugin, hashHex: hex(authHex) || hex(passwordHex), grantLines });
    try {
      await mysql(`${statements.map((s) => `${s};`).join('\n')}\nFLUSH PRIVILEGES;`, creds, ctx);
    } catch (err) {
      // A grant failing after CREATE USER would leave a half-provisioned account.
      if (err.details?.errno !== 1396) { try { await mysql(`DROP USER IF EXISTS ${q.account(user, toHost)}`, creds, ctx); } catch { /* nothing created */ } }
      throw err;
    }
    return { user, host: toHost, created: true, grants: grants.length, plugin: plugin || null };
  },
});

// --------------------------------------------------------------- grants ---

export function parseGrant(line) {
  const m = line.match(/^GRANT (.+?) ON (\*|`[^`]*(?:``[^`]*)*`|[^ ]+)\.(\*|`[^`]+`|[^ ]+) TO /i);
  if (!m) return null;
  const unq = (s) => (s.startsWith('`') ? s.slice(1, -1).replace(/``/g, '`') : s);
  return { privileges: m[1].split(',').map((p) => p.trim().toUpperCase()), raw: m[1].split(',').map((p) => p.trim()), database: unq(m[2]), table: unq(m[3]) };
}

defineOp('db.grants.list', {
  description: 'SHOW GRANTS for a user at a host, parsed per database',
  schema: withCreds({ user: mysqlUser, host: host.default('localhost') }),
  run: async ({ user, host: h, credentials: creds }, ctx) => {
    const lines = (await mysql(`SHOW GRANTS FOR ${q.account(user, h)}`, creds, ctx, { headers: false })).map((r) => r[0]);
    const grants = lines.map(parseGrant).filter(Boolean).filter((g) => !(g.database === '*' && g.privileges.length === 1 && g.privileges[0] === 'USAGE')).map(({ raw, ...g }) => g);
    return { user, host: h, raw: lines, grants };
  },
});

defineOp('db.grant', {
  description: 'GRANT privileges on a database to user@host (at every listed host)',
  schema: withCreds({ user: mysqlUser, database: dbName, privileges: z.array(privilege).min(1).max(PRIVILEGES.length), hosts: z.array(host).min(1).max(50).default(['localhost']) }),
  run: async ({ user, database, privileges, hosts, credentials: creds }, ctx) => {
    const list = privileges.includes('ALL PRIVILEGES') ? 'ALL PRIVILEGES' : [...new Set(privileges)].join(', ');
    const sql = hosts.map((h) => `GRANT ${list} ON ${q.id(database)}.* TO ${q.account(user, h)};`).join('\n');
    await mysql(`${sql}\nFLUSH PRIVILEGES;`, creds, ctx);
    return { user, database, privileges: list.split(', '), hosts };
  },
});

defineOp('db.revoke', {
  description: 'REVOKE ALL PRIVILEGES on a database from user@host',
  destructive: true,
  schema: withCreds({ user: mysqlUser, database: dbName, hosts: z.array(host).min(1).max(50).default(['localhost']) }),
  run: async ({ user, database, hosts, credentials: creds }, ctx) => {
    const sql = hosts.map((h) => `REVOKE ALL PRIVILEGES, GRANT OPTION ON ${q.id(database)}.* FROM ${q.account(user, h)};`).join('\n');
    try {
      await mysql(`${sql}\nFLUSH PRIVILEGES;`, creds, ctx);
    } catch (err) {
      // 1141: there is no such grant defined; nothing to revoke.
      if (err.details?.errno !== 1141) throw err;
    }
    return { user, database, hosts, revoked: true };
  },
});

// ------------------------------------------------------------ processes ---

defineOp('db.processlist', {
  description: 'Live connections and running statements (information_schema.PROCESSLIST)',
  schema: withCreds({}),
  run: async ({ credentials: creds }, ctx) => {
    const rows = await mysql('SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS time, STATE AS state, INFO AS info FROM information_schema.PROCESSLIST ORDER BY TIME DESC', creds, ctx);
    return rows.map((r) => ({ id: Number(r.id), user: r.user, host: r.host, db: r.db, command: r.command, time: Number(r.time) || 0, state: r.state, info: r.info ? r.info.slice(0, 2000) : null }));
  },
});

defineOp('db.kill', {
  description: 'KILL a connection or its running query',
  destructive: true,
  schema: withCreds({ id: z.number().int().positive().max(2 ** 53), queryOnly: z.boolean().default(false) }),
  run: async ({ id, queryOnly, credentials: creds }, ctx) => {
    await mysql(`KILL ${queryOnly ? 'QUERY ' : ''}${id}`, creds, ctx);
    return { id, queryOnly, killed: true };
  },
});

// ------------------------------------------------------- check / repair ---

export function parseMysqlcheck(stdout) {
  const results = [];
  let current = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const head = /^\S/.test(line) ? line.match(/^(\S+\.\S+)(?:\s{2,}(.*))?$/) : null;
    if (head) {
      const status = (head[2] || '').trim();
      current = { table: head[1], status: !status || status === 'OK' || /up to date/i.test(status) ? 'ok' : 'warning', messages: !status || status === 'OK' ? [] : [status] };
      results.push(current);
      continue;
    }
    if (!current) continue;
    const msg = line.trim();
    current.messages.push(msg);
    if (/^error/i.test(msg) || /corrupt|crashed/i.test(msg)) current.status = 'error';
    else if (/^(warning|note)/i.test(msg) && current.status === 'ok') current.status = /does not support|^note/i.test(msg) ? 'ok' : 'warning';
    else if (/repair|fixed|upgrade/i.test(msg) && current.status !== 'error') current.status = 'repaired';
  }
  return results;
}

defineOp('db.check', {
  description: 'mysqlcheck --check / --repair / --optimize / --analyze on selected or all databases',
  schema: withCreds({ action: z.enum(['check', 'repair', 'optimize', 'analyze']).default('check'), databases: z.array(dbName).max(500).optional(), autoRepair: z.boolean().default(false) }),
  timeoutMs: 3_600_000,
  run: async ({ action, databases, autoRepair, credentials: creds }, ctx) => {
    const bin = findBin(CHECK_BINS);
    if (!bin) throw new OpError('capability_missing', 'mysqlcheck (mysql-client / mariadb-client package) is not installed on this server');
    return withDefaults(creds, ctx, async (defaults) => {
      const argv = [...defaults, `--${action}`];
      if (autoRepair && action === 'check') argv.push('--auto-repair');
      if (databases?.length) argv.push('--databases', ...databases); else argv.push('--all-databases');
      const { code, stdout, stderr } = await exec(bin, argv, { allowFailure: true, timeoutMs: 3_600_000 });
      if (code !== 0 && !stdout.trim()) {
        const err = classifyMysqlError(stderr);
        throw new OpError(err.code, `mysqlcheck: ${err.message}`, { errno: err.errno });
      }
      const results = parseMysqlcheck(stdout);
      return { action, databases: databases || null, exitCode: code, results, summary: { tables: results.length, ok: results.filter((r) => r.status === 'ok').length, repaired: results.filter((r) => r.status === 'repaired').length, warnings: results.filter((r) => r.status === 'warning').length, errors: results.filter((r) => r.status === 'error').length }, stderr: stderr.trim().slice(-4000) };
    });
  },
});

// -------------------------------------------------------- root password ---

export function renderRootMyCnf(pw, extra = {}) {
  const lines = [`${MANAGED} (Change Database Root Password). Lets root tooling log in without a prompt.`, '[client]', 'user=root', `password=${optionValue(pw)}`];
  if (extra.socket) lines.push(`socket=${optionValue(extra.socket)}`);
  return `${lines.join('\n')}\n`;
}

defineOp('db.root_password.set', {
  description: "Set the MySQL root password at every root@host and rewrite /root/.my.cnf (0600)",
  schema: withCreds({ password, updateMyCnf: z.boolean().default(true) }),
  run: async ({ password: pw, updateMyCnf, credentials: creds }, ctx) => {
    const hosts = (await mysql("SELECT Host FROM mysql.user WHERE User = 'root'", creds, ctx, { headers: false })).map((r) => r[0]);
    if (!hosts.length) throw new OpError('not_found', 'No root user exists on this database server');
    for (const h of hosts) await setPasswordSql('root', h, pw, creds, ctx);
    await mysql('FLUSH PRIVILEGES', creds, ctx);
    let myCnf = false;
    if (updateMyCnf) {
      ctx.assertAllowedPath(ROOT_MY_CNF, 'write');
      writeSecret(ROOT_MY_CNF, renderRootMyCnf(pw));
      myCnf = true;
    }
    return { hosts, myCnfUpdated: myCnf, path: myCnf ? ROOT_MY_CNF : null };
  },
});

// ----------------------------------------------------------- variables ---

defineOp('db.variables.get', {
  description: 'SHOW GLOBAL VARIABLES (optionally filtered by LIKE patterns) and key status counters',
  schema: withCreds({ names: z.array(variableName).max(200).optional(), status: z.boolean().default(true) }),
  run: async ({ names, status, credentials: creds }, ctx) => {
    const variables = {};
    if (names?.length) {
      for (const n of names) for (const r of await mysql(`SHOW GLOBAL VARIABLES LIKE ${q.str(n)}`, creds, ctx, { headers: false })) variables[r[0]] = r[1];
    } else {
      for (const r of await mysql('SHOW GLOBAL VARIABLES', creds, ctx, { headers: false })) variables[r[0]] = r[1];
    }
    const counters = {};
    if (status) {
      for (const n of ['Uptime', 'Threads_connected', 'Threads_running', 'Max_used_connections', 'Questions', 'Slow_queries', 'Connections', 'Aborted_connects', 'Innodb_buffer_pool_pages_total', 'Innodb_buffer_pool_pages_free', 'Created_tmp_disk_tables', 'Open_tables', 'Opened_tables', 'Bytes_received', 'Bytes_sent']) {
        for (const r of await mysql(`SHOW GLOBAL STATUS LIKE ${q.str(n)}`, creds, ctx, { headers: false })) counters[r[0]] = /^-?\d+$/.test(r[1]) ? Number(r[1]) : r[1];
      }
    }
    return { variables, status: counters };
  },
});

// -------------------------------------------------------- configuration ---

defineOp('db.config.read', {
  description: 'The panel-managed [mysqld] include and the distribution config files it overrides',
  run: async (_args, ctx) => {
    const layout = detectLayout();
    if (!layout.managedInclude) throw new OpError('capability_missing', 'No MySQL/MariaDB configuration directory (/etc/mysql or /etc/my.cnf.d) exists on this server');
    ctx.assertAllowedPath(layout.managedInclude, 'read');
    const raw = readText(layout.managedInclude);
    const files = [];
    for (const dir of layout.confDirs) {
      let names = [];
      try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.cnf')).sort(); } catch { continue; }
      for (const f of names) {
        const p = path.join(dir, f);
        if (p === layout.managedInclude) continue;
        files.push({ path: p, mysqld: parseCnf(readText(p)).mysqld || {} });
      }
    }
    if (layout.mainConf) files.unshift({ path: layout.mainConf, mysqld: parseCnf(readText(layout.mainConf)).mysqld || {} });
    return { path: layout.managedInclude, exists: raw != null, raw, settings: parseCnf(raw).mysqld || {}, files, layout };
  },
});

defineOp('db.config.write', {
  description: 'Write [mysqld] options to the managed include, validate with the server binary and roll back on error',
  schema: z.object({ settings: z.record(configKey, configValue.nullable()).refine((s) => Object.keys(s).length <= 200, 'Too many options'), replace: z.boolean().default(false) }).strict(),
  run: async ({ settings, replace }, ctx) => {
    const layout = detectLayout();
    if (!layout.managedInclude) throw new OpError('capability_missing', 'No MySQL/MariaDB configuration directory (/etc/mysql or /etc/my.cnf.d) exists on this server');
    ctx.assertAllowedPath(layout.managedInclude, 'write');
    const previous = readText(layout.managedInclude);
    const current = replace ? {} : (parseCnf(previous).mysqld || {});
    for (const [k, v] of Object.entries(settings)) {
      if (v === null) delete current[k]; else current[k] = v;
    }
    writeAtomic(layout.managedInclude, renderCnf(current));
    const check = await validateServerConfig();
    if (!check.ok) {
      restore(layout.managedInclude, previous);
      throw new OpError('config_invalid', `The database server rejected the configuration; the previous file was restored: ${check.output}`, { output: check.output });
    }
    return { path: layout.managedInclude, settings: current, validated: check.validated, restartRequired: true };
  },
});

defineOp('db.restart', {
  description: 'systemctl restart the database server unit (mariadb / mysql / mysqld)',
  destructive: true,
  timeoutMs: 300_000,
  run: async () => {
    const unit = await resolveUnit();
    if (!unit) throw new OpError('capability_missing', 'No MySQL/MariaDB systemd unit (mariadb, mysql or mysqld) exists on this server');
    await exec('systemctl', ['restart', `${unit}.service`], { timeoutMs: 300_000 });
    const kv = await unitState(unit);
    return { unit, state: kv.ActiveState || 'unknown', subState: kv.SubState || null, pid: Number(kv.MainPID) || null };
  },
});

defineOp('db.unit', {
  description: 'Which systemd unit runs the database server, and its state',
  run: async () => {
    const unit = await resolveUnit();
    if (!unit) return { unit: null, state: 'not-installed' };
    const kv = await unitState(unit, 'ActiveState,SubState,MainPID,ExecMainStartTimestamp');
    return { unit, state: kv.ActiveState || 'unknown', subState: kv.SubState || null, pid: Number(kv.MainPID) || null, startedAt: kv.ExecMainStartTimestamp || null };
  },
});

// ---------------------------------------------------------------- dumps ---

defineOp('db.dump', {
  description: 'mysqldump selected or all databases straight to a file (--result-file) under an allowed root',
  schema: withCreds({ path: arg.absPath, databases: z.array(dbName).max(500).optional(), addDropDatabase: z.boolean().default(true) }),
  timeoutMs: 7_200_000,
  run: async ({ path: file, databases, addDropDatabase, credentials: creds }, ctx) => {
    const bin = findBin(DUMP_BINS);
    if (!bin) throw new OpError('capability_missing', 'mysqldump (mysql-client / mariadb-client package) is not installed on this server');
    ctx.assertAllowedPath(file, 'write');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    return withDefaults(creds, ctx, async (defaults) => {
      const argv = [...defaults, '--single-transaction', '--quick', '--routines', '--events', '--triggers', `--result-file=${file}`];
      if (addDropDatabase) argv.push('--add-drop-database');
      if (databases?.length) argv.push('--databases', ...databases); else argv.push('--all-databases');
      const { code, stderr } = await exec(bin, argv, { allowFailure: true, timeoutMs: 7_200_000 });
      if (code !== 0) {
        try { fs.unlinkSync(file); } catch { /* nothing written */ }
        const err = classifyMysqlError(stderr);
        throw new OpError(err.code, `mysqldump: ${err.message}`, { errno: err.errno });
      }
      fs.chmodSync(file, 0o600);
      return { path: file, sizeBytes: fs.statSync(file).size, databases: databases || 'all' };
    });
  },
});

// -------------------------------------------------------------- upgrade ---

export function parseDpkgQuery(stdout) {
  return stdout.split('\n').filter(Boolean).map((l) => { const [name, version, status] = l.split('\t'); return { name, version, installed: status === 'installed' }; });
}

defineOp('db.packages', {
  description: 'Installed database server packages and the candidate versions the package manager offers',
  schema: z.object({ candidates: z.array(packageName).max(20).optional() }).strict(),
  run: async ({ candidates }) => {
    const installed = [];
    let manager = null;
    if (hasBinary('dpkg-query')) {
      manager = hasBinary('apt-get') ? 'apt' : 'dpkg';
      const { stdout } = await exec('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\t${db:Status-Status}\n', 'mariadb-server*', 'mysql-server*', 'mysql-community-server*', 'percona-server-server*', 'postgresql*'], { allowFailure: true });
      installed.push(...parseDpkgQuery(stdout).filter((p) => p.installed && !/-core|-common|-client|-dbg|-doc/.test(p.name)));
    } else if (hasBinary('rpm')) {
      manager = hasBinary('dnf') ? 'dnf' : hasBinary('yum') ? 'yum' : 'rpm';
      const { stdout } = await exec('rpm', ['-qa', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\tinstalled\n', 'mariadb-server*', 'mysql-server*', 'mysql-community-server*', 'percona-server-server*', 'postgresql*-server'], { allowFailure: true });
      installed.push(...parseDpkgQuery(stdout));
    }
    const available = [];
    for (const pkg of candidates || ['mariadb-server', 'mysql-server', 'default-mysql-server', 'mysql-community-server']) {
      if (manager === 'apt') {
        const { code, stdout } = await exec('apt-cache', ['policy', pkg], { allowFailure: true, timeoutMs: 60_000 });
        const candidate = stdout.match(/Candidate:\s*(\S+)/)?.[1];
        const current = stdout.match(/Installed:\s*(\S+)/)?.[1];
        if (code === 0 && candidate && candidate !== '(none)') available.push({ name: pkg, candidate, installed: current && current !== '(none)' ? current : null });
      } else if (manager === 'dnf' || manager === 'yum') {
        const { code, stdout } = await exec(manager, ['--quiet', '-y', 'list', '--available', pkg], { allowFailure: true, timeoutMs: 120_000 });
        const line = stdout.split('\n').find((l) => l.trim().startsWith(`${pkg}.`));
        if (code === 0 && line) available.push({ name: pkg, candidate: line.trim().split(/\s+/)[1] || null, installed: null });
      }
    }
    return { manager, installed, available, engine: detectEngine().engine };
  },
});

defineOp('db.upgrade_tables', {
  description: 'Run mysql_upgrade / mariadb-upgrade after a server package upgrade',
  schema: withCreds({}),
  timeoutMs: 3_600_000,
  run: async ({ credentials: creds }, ctx) => {
    const bin = findBin(UPGRADE_BINS);
    if (!bin) return { ran: false, reason: 'no mysql_upgrade/mariadb-upgrade binary (MySQL 8 upgrades tables on start-up)' };
    return withDefaults(creds, ctx, async (defaults) => {
      const { code, stdout, stderr } = await exec(bin, [...defaults, '--force'], { allowFailure: true, timeoutMs: 3_600_000 });
      return { ran: true, tool: bin, exitCode: code, output: `${stdout}\n${stderr}`.trim().slice(-8000) };
    });
  },
});

// ----------------------------------------------------------- phpMyAdmin ---

const PMA_DIRS = ['/usr/share/phpmyadmin', '/usr/share/phpMyAdmin', '/var/www/html/phpmyadmin', '/var/www/phpmyadmin', '/opt/phpmyadmin', '/srv/phpmyadmin', '/usr/local/cpanel/base/3rdparty/phpMyAdmin', '/var/lib/whm/phpmyadmin'];
const PMA_CONFIGS = ['/etc/phpmyadmin/config.inc.php', '/etc/phpMyAdmin/config.inc.php'];
const PMA_WEB_CONFS = ['/etc/apache2/conf-enabled/phpmyadmin.conf', '/etc/apache2/conf-available/phpmyadmin.conf', '/etc/httpd/conf.d/phpMyAdmin.conf', '/etc/httpd/conf.d/phpmyadmin.conf', '/etc/nginx/conf.d/phpmyadmin.conf', '/etc/nginx/snippets/phpmyadmin.conf', '/etc/nginx/sites-enabled/phpmyadmin'];

export function phpMyAdminVersion(dir) {
  const version = readText(path.join(dir, 'libraries/classes/Version.php'))?.match(/VERSION\s*=\s*'([^']+)'/)?.[1]
    || readText(path.join(dir, 'src/Version.php'))?.match(/VERSION\s*=\s*'([^']+)'/)?.[1]
    || readText(path.join(dir, 'package.json'))?.match(/"version"\s*:\s*"([^"]+)"/)?.[1]
    || readText(path.join(dir, 'README'))?.match(/Version\s+(\d[\w.-]*)/)?.[1]
    || readText(path.join(dir, 'ChangeLog'))?.match(/^(\d+\.\d+[\w.-]*)/m)?.[1]
    || null;
  return version;
}

defineOp('db.phpmyadmin.detect', {
  description: 'Whether phpMyAdmin is installed, its version, config file and the web server alias that serves it',
  run: async () => {
    const dir = PMA_DIRS.find((d) => exists(path.join(d, 'index.php'))) || null;
    const configFile = PMA_CONFIGS.find(exists) || (dir && exists(path.join(dir, 'config.inc.php')) ? path.join(dir, 'config.inc.php') : null);
    const web = [];
    for (const f of PMA_WEB_CONFS) {
      const text = readText(f);
      if (text == null) continue;
      const alias = text.match(/^\s*Alias\s+(\S+)\s+(\S+)/mi) || text.match(/^\s*location\s+(\S+)\s*\{/mi);
      web.push({ path: f, enabled: !f.includes('conf-available'), server: f.includes('nginx') ? 'nginx' : 'apache', urlPath: alias?.[1] || null });
    }
    const active = web.find((w) => w.enabled && w.urlPath) || null;
    return {
      installed: Boolean(dir), dir, version: dir ? phpMyAdminVersion(dir) : null, configFile, webConfigs: web, urlPath: active?.urlPath || null,
      php: hasBinary('php'), candidates: PMA_DIRS,
      packageHint: hasBinary('apt-get') ? 'apt-get install phpmyadmin' : hasBinary('dnf') ? 'dnf install phpMyAdmin' : hasBinary('yum') ? 'yum install phpMyAdmin' : null,
    };
  },
});

// =========================================================== PostgreSQL ===

async function psql(sql, creds, { database = 'postgres', timeoutMs = 120_000 } = {}) {
  const bin = requirePsql();
  const base = ['-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-d', creds?.database || database];
  const user = creds?.user || null;
  let run;
  if (creds?.host && creds.host !== 'localhost') {
    const argv = [...base, '-h', creds.host, '-p', String(creds.port || 5432), '-U', user || 'postgres'];
    run = exec(bin, argv, { input: `${sql}\n`, allowFailure: true, timeoutMs, env: { PGPASSWORD: creds.password || '', PGCONNECT_TIMEOUT: '10' } });
  } else if (user && creds.password) {
    const argv = [...base, '-h', creds.host || 'localhost', '-p', String(creds.port || 5432), '-U', user];
    run = exec(bin, argv, { input: `${sql}\n`, allowFailure: true, timeoutMs, env: { PGPASSWORD: creds.password, PGCONNECT_TIMEOUT: '10' } });
  } else if ((!user || user === 'postgres') && hasBinary('runuser') && process.getuid?.() === 0) {
    // Peer authentication over the socket: only valid for the postgres OS user.
    run = exec('runuser', ['-u', 'postgres', '--', bin, ...base], { input: `${sql}\n`, allowFailure: true, timeoutMs, env: { PGCONNECT_TIMEOUT: '10' } });
  } else {
    run = exec(bin, [...base, '-U', user || 'postgres'], { input: `${sql}\n`, allowFailure: true, timeoutMs, env: { PGCONNECT_TIMEOUT: '10' } });
  }
  const { code, stdout, stderr } = await run;
  if (code !== 0) {
    const line = stderr.trim().split('\n').filter((l) => /ERROR|FATAL|could not|fe_sendauth|Peer authentication/.test(l)).pop() || stderr.trim().split('\n').pop() || 'psql failed';
    const errCode = /could not connect|Connection refused|No such file/i.test(line) ? 'db_unreachable' : /authentication|password/i.test(line) ? 'db_auth_failed' : /already exists/i.test(line) ? 'exists' : /does not exist/i.test(line) ? 'not_found' : 'db_error';
    throw new OpError(errCode, `PostgreSQL: ${line.replace(/^(psql: )?(error|ERROR|FATAL):\s*/i, '')}`);
  }
  return stdout.replace(/\n$/, '').split('\n').filter((l) => l !== '').map((l) => l.split('\t'));
}

defineOp('pg.version', {
  description: 'PostgreSQL server version',
  schema: withCreds({}),
  run: async ({ credentials: creds }) => {
    const [[version]] = await psql('SELECT version()', creds);
    return { version, major: version.match(/PostgreSQL (\d+(?:\.\d+)?)/)?.[1] || null, engine: 'postgres' };
  },
});

defineOp('pg.ping', {
  description: 'Test a PostgreSQL connection without throwing',
  schema: withCreds({}),
  run: async ({ credentials: creds }) => {
    const started = Date.now();
    try {
      const [[version, user]] = await psql('SELECT version(), current_user', creds, { timeoutMs: 30_000 });
      return { ok: true, version, user, ms: Date.now() - started };
    } catch (err) {
      if (err.code === 'capability_missing') throw err;
      return { ok: false, code: err.code, error: err.message, ms: Date.now() - started };
    }
  },
});

defineOp('pg.databases.list', {
  description: 'Databases with owner and size',
  schema: withCreds({}),
  run: async ({ credentials: creds }) => {
    const rows = await psql("SELECT d.datname, pg_get_userbyid(d.datdba), pg_database_size(d.datname), pg_encoding_to_char(d.encoding) FROM pg_database d WHERE NOT d.datistemplate ORDER BY d.datname", creds);
    return rows.map(([name, owner, size, encoding]) => ({ name, owner, sizeBytes: Number(size) || 0, charset: encoding, collation: null, tables: null, system: name === 'postgres' }));
  },
});

defineOp('pg.database.create', {
  description: 'CREATE DATABASE, optionally owned by a role',
  schema: withCreds({ name: pgName, owner: pgName.optional() }),
  run: async ({ name, owner, credentials: creds }) => {
    await psql(`CREATE DATABASE ${q.pgId(name)}${owner ? ` OWNER ${q.pgId(owner)}` : ''}`, creds);
    return { name, owner: owner || null };
  },
});

defineOp('pg.database.drop', {
  description: 'Terminate connections and DROP DATABASE',
  destructive: true,
  schema: withCreds({ name: pgName }),
  run: async ({ name, credentials: creds }) => {
    if (name === 'postgres') throw new OpError('refused', 'The postgres maintenance database cannot be dropped');
    await psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${q.pgStr(name)} AND pid <> pg_backend_pid()`, creds);
    await psql(`DROP DATABASE ${q.pgId(name)}`, creds, { timeoutMs: 600_000 });
    return { name, dropped: true };
  },
});

defineOp('pg.users.list', {
  description: 'Login roles',
  schema: withCreds({}),
  run: async ({ credentials: creds }) => {
    const rows = await psql("SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname", creds);
    return rows.map(([user, superuser, login]) => ({ user, host: null, plugin: null, superuser: superuser === 't', login: login === 't', system: user === 'postgres' }));
  },
});

defineOp('pg.user.create', {
  description: 'CREATE ROLE ... LOGIN PASSWORD',
  schema: withCreds({ user: pgName, password }),
  run: async ({ user, password: pw, credentials: creds }) => {
    await psql(`CREATE ROLE ${q.pgId(user)} LOGIN PASSWORD ${q.pgStr(pw)}`, creds);
    return { user, hosts: [] };
  },
});

defineOp('pg.user.drop', {
  description: 'DROP ROLE (owned objects are reassigned to postgres first)',
  destructive: true,
  schema: withCreds({ user: pgName }),
  run: async ({ user, credentials: creds }) => {
    if (user === 'postgres') throw new OpError('refused', 'The postgres superuser cannot be dropped');
    const dbs = (await psql(`SELECT datname FROM pg_database WHERE NOT datistemplate AND has_database_privilege(${q.pgStr(user)}, datname, 'CONNECT')`, creds)).map((r) => r[0]);
    for (const d of dbs) {
      try { await psql(`REASSIGN OWNED BY ${q.pgId(user)} TO postgres; DROP OWNED BY ${q.pgId(user)}`, creds, { database: d }); } catch { /* role may own nothing there */ }
    }
    await psql(`DROP ROLE ${q.pgId(user)}`, creds);
    return { user, dropped: ['*'] };
  },
});

defineOp('pg.user.set_password', {
  description: 'ALTER ROLE ... PASSWORD',
  schema: withCreds({ user: pgName, password }),
  run: async ({ user, password: pw, credentials: creds }) => {
    await psql(`ALTER ROLE ${q.pgId(user)} PASSWORD ${q.pgStr(pw)}`, creds);
    return { user, hosts: [] };
  },
});

defineOp('pg.grants.list', {
  description: 'Databases a role may connect to or create in',
  schema: withCreds({ user: pgName }),
  run: async ({ user, credentials: creds }) => {
    const u = q.pgStr(user);
    const rows = await psql(`SELECT datname, has_database_privilege(${u}, datname, 'CONNECT'), has_database_privilege(${u}, datname, 'CREATE'), has_database_privilege(${u}, datname, 'TEMP'), pg_get_userbyid(datdba) = ${u} FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname`, creds);
    const grants = rows.filter(([, c, cr, t, owner]) => owner === 't' || c === 't' || cr === 't' || t === 't').map(([database, c, cr, t, owner]) => ({ database, table: '*', privileges: owner === 't' ? ['ALL PRIVILEGES'] : [c === 't' && 'CONNECT', cr === 't' && 'CREATE', t === 't' && 'TEMPORARY'].filter(Boolean) }));
    return { user, host: null, raw: [], grants };
  },
});

defineOp('pg.grant', {
  description: 'GRANT privileges on a database (and its public schema) to a role',
  schema: withCreds({ user: pgName, database: pgName, privileges: z.array(pgPrivilege).min(1).max(PG_PRIVILEGES.length) }),
  run: async ({ user, database, privileges, credentials: creds }) => {
    const list = privileges.includes('ALL PRIVILEGES') ? 'ALL PRIVILEGES' : [...new Set(privileges)].join(', ');
    await psql(`GRANT ${list} ON DATABASE ${q.pgId(database)} TO ${q.pgId(user)}`, creds);
    if (list === 'ALL PRIVILEGES') {
      try { await psql(`GRANT ALL ON SCHEMA public TO ${q.pgId(user)}; ALTER DATABASE ${q.pgId(database)} OWNER TO ${q.pgId(user)}`, creds, { database }); } catch { /* older servers: schema grant is implicit */ }
    }
    return { user, database, privileges: list.split(', '), hosts: [] };
  },
});

defineOp('pg.revoke', {
  description: 'REVOKE ALL on a database from a role',
  destructive: true,
  schema: withCreds({ user: pgName, database: pgName }),
  run: async ({ user, database, credentials: creds }) => {
    await psql(`REVOKE ALL PRIVILEGES ON DATABASE ${q.pgId(database)} FROM ${q.pgId(user)}`, creds);
    try { await psql(`REVOKE ALL ON SCHEMA public FROM ${q.pgId(user)}`, creds, { database }); } catch { /* nothing granted there */ }
    return { user, database, revoked: true };
  },
});

defineOp('pg.processlist', {
  description: 'pg_stat_activity',
  schema: withCreds({}),
  run: async ({ credentials: creds }) => {
    const rows = await psql("SELECT pid, COALESCE(usename, ''), COALESCE(client_addr::text, 'local'), COALESCE(datname, ''), COALESCE(state, ''), COALESCE(EXTRACT(EPOCH FROM now() - query_start)::int, 0), left(COALESCE(query, ''), 2000) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY query_start", creds);
    return rows.map(([id, user, h, db, state, time, info]) => ({ id: Number(id), user, host: h, db, command: state || 'idle', time: Number(time) || 0, state, info: info || null }));
  },
});

defineOp('pg.kill', {
  description: 'pg_terminate_backend / pg_cancel_backend',
  destructive: true,
  schema: withCreds({ id: arg.pid, queryOnly: z.boolean().default(false) }),
  run: async ({ id, queryOnly, credentials: creds }) => {
    const [[ok]] = await psql(`SELECT ${queryOnly ? 'pg_cancel_backend' : 'pg_terminate_backend'}(${id})`, creds);
    if (ok !== 't') throw new OpError('not_found', `No backend with PID ${id}`);
    return { id, queryOnly, killed: true };
  },
});

defineOp('pg.check', {
  description: 'VACUUM (ANALYZE) every table of the selected or all databases',
  schema: withCreds({ action: z.enum(['check', 'repair', 'optimize', 'analyze']).default('check'), databases: z.array(pgName).max(500).optional() }),
  timeoutMs: 3_600_000,
  run: async ({ action, databases, credentials: creds }) => {
    let targets = databases;
    if (!targets?.length) targets = (await psql("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'", creds)).map((r) => r[0]);
    const results = [];
    for (const d of targets) {
      try {
        await psql(action === 'optimize' ? 'VACUUM (FULL, ANALYZE)' : action === 'analyze' ? 'ANALYZE' : 'VACUUM (ANALYZE)', creds, { database: d, timeoutMs: 3_600_000 });
        results.push({ table: `${d}.*`, status: 'ok', messages: [] });
      } catch (err) {
        results.push({ table: `${d}.*`, status: 'error', messages: [err.message] });
      }
    }
    return { action, databases: targets, exitCode: results.some((r) => r.status === 'error') ? 1 : 0, results, summary: { tables: results.length, ok: results.filter((r) => r.status === 'ok').length, repaired: 0, warnings: 0, errors: results.filter((r) => r.status === 'error').length }, stderr: '' };
  },
});

defineOp('pg.root_password.set', {
  description: 'ALTER ROLE postgres PASSWORD',
  schema: withCreds({ password }),
  run: async ({ password: pw, credentials: creds }) => {
    await psql(`ALTER ROLE postgres PASSWORD ${q.pgStr(pw)}`, creds);
    return { hosts: ['*'], myCnfUpdated: false, path: null };
  },
});

// Counter names mirror the MySQL status keys so the panel renders both engines alike.
defineOp('pg.variables.get', {
  description: 'pg_settings (optionally filtered by LIKE patterns) and connection / transaction counters',
  schema: withCreds({ names: z.array(variableName).max(200).optional(), status: z.boolean().default(true) }),
  run: async ({ names, status, credentials: creds }) => {
    const where = names?.length ? ` WHERE ${names.map((n) => `name LIKE ${q.pgStr(n)}`).join(' OR ')}` : '';
    const variables = Object.fromEntries((await psql(`SELECT name, setting FROM pg_settings${where} ORDER BY name`, creds)).map(([k, v]) => [k, v ?? '']));
    const counters = {};
    if (status) {
      const num = (v) => (/^-?\d+$/.test(v || '') ? Number(v) : v ?? null);
      const [[uptime, connected, running, maxConnections]] = await psql("SELECT EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::bigint, (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'), (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active'), current_setting('max_connections')", creds);
      const [[commits, rollbacks, blksRead, blksHit, tupReturned, deadlocks]] = await psql('SELECT COALESCE(SUM(xact_commit), 0), COALESCE(SUM(xact_rollback), 0), COALESCE(SUM(blks_read), 0), COALESCE(SUM(blks_hit), 0), COALESCE(SUM(tup_returned), 0), COALESCE(SUM(deadlocks), 0) FROM pg_stat_database', creds);
      Object.assign(counters, { Uptime: num(uptime), Threads_connected: num(connected), Threads_running: num(running), Max_connections: num(maxConnections), Xact_commit: num(commits), Xact_rollback: num(rollbacks), Blks_read: num(blksRead), Blks_hit: num(blksHit), Tup_returned: num(tupReturned), Deadlocks: num(deadlocks) });
    }
    return { variables, status: counters };
  },
});

defineOp('pg.unit', {
  description: 'Which systemd unit runs PostgreSQL, and its state',
  run: async () => {
    const unit = await resolvePgUnit();
    if (!unit) return { unit: null, state: 'not-installed' };
    const kv = await unitState(unit, 'ActiveState,SubState,MainPID,ExecMainStartTimestamp');
    return { unit, state: kv.ActiveState || 'unknown', subState: kv.SubState || null, pid: Number(kv.MainPID) || null, startedAt: kv.ExecMainStartTimestamp || null };
  },
});

defineOp('pg.restart', {
  description: 'systemctl restart the PostgreSQL unit (postgresql / postgresql-<version>)',
  destructive: true,
  timeoutMs: 300_000,
  run: async () => {
    const unit = await resolvePgUnit();
    if (!unit) throw new OpError('capability_missing', 'No PostgreSQL systemd unit exists on this server');
    await exec('systemctl', ['restart', `${unit}.service`], { timeoutMs: 300_000 });
    const kv = await unitState(unit);
    return { unit, state: kv.ActiveState || 'unknown', subState: kv.SubState || null, pid: Number(kv.MainPID) || null };
  },
});
