import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';
import { z } from 'zod';
import { exec, hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError, ensurePrivateDir } from './registry.js';
import { renderClientCnf, classifyMysqlError, parseBatch, cloneUserStatements, parseGrant, q } from './db.js';
import { createSqlCodeFilter, createClientCommandGuard, SQL_MODE_TRAP } from './transfer.js';

// Backup op family. An account archive is a cPanel-compatible tarball:
//
//   backup-MM.DD.YYYY_HH-MM-SS_<user>/
//     homedir/            the account's home (mail/ is a subtree of it)
//     mysql/<db>.sql      mysqldump per database; mysql/users.json auth + grants
//     dnszones/<zone>.db  zone files as the panel renders them
//     cp/<user>.json      panel metadata (account row, domains, databases, mail)
//     meta/info.json      archive manifest
//
// Archives, staging trees and credentials files only ever live under allowed
// roots; every program runs through exec(argv). Remote destinations use curl
// (ftp/ftps/sftp/webdav) driven by a 0600 config file so credentials never
// appear in argv, or an S3 SigV4 client written on node:crypto + node:https.

const TMP_DIR = '/tmp/whm';
const ROOT_MY_CNF = '/root/.my.cnf';
const CLIENT_BINS = ['mysql', 'mariadb'];
const DUMP_BINS = ['mysqldump', 'mariadb-dump'];
const SYSTEM_SCHEMAS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

// Names the panel creates (backup-…_<user>.tar.gz) and names it may read
// (also cPanel's cpmove-<user>.tar.gz and <user>.tar.gz).
const CREATED_NAME = /^backup-\d{2}\.\d{2}\.\d{4}_\d{2}-\d{2}-\d{2}_[a-z][a-z0-9_-]{0,31}\.tar\.gz$/;
const READ_NAME = /^(backup-\d{2}\.\d{2}\.\d{4}_\d{2}-\d{2}-\d{2}_|cpmove-)?[a-z][a-z0-9_-]{0,31}\.tar(\.gz)?$/;

export const archiveName = z.string().regex(CREATED_NAME, 'Archive name must look like backup-MM.DD.YYYY_HH-MM-SS_<user>.tar.gz');
export const readableName = z.string().regex(READ_NAME, 'Not a WHM/cPanel account archive name');
const archivePath = arg.absPath.refine((p) => READ_NAME.test(path.basename(p)), 'Not a WHM/cPanel account archive');
// A path inside the archive: relative, no traversal, no leading dash (argv) and no newline.
export const relPath = z.string().min(1).max(1024).regex(/^(?![-/])(?!.*(^|\/)\.\.(\/|$))[^\0\n\r]+$/, 'Relative path without ".." segments');
const dbName = z.string().regex(/^[a-z0-9_]{1,64}$/);
const mysqlUser = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/);
const mysqlHost = z.string().regex(/^[A-Za-z0-9%:][A-Za-z0-9.%:_-]{0,254}$/);
const credentials = z.object({
  host: mysqlHost.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: mysqlUser.optional(),
  password: z.string().max(256).regex(/^[^\n\r\0]*$/).optional(),
  socket: arg.absPath.optional(),
  bindAddress: z.string().ip().optional(),
}).strict().optional();

// ------------------------------------------------------------------ helpers ---

function ownership(username) {
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${username}:`));
  if (!line) throw new OpError('not_found', `Linux user "${username}" does not exist`);
  const parts = line.split(':');
  return { uid: Number(parts[2]), gid: Number(parts[3]), home: parts[5] };
}

function tmpDir(ctx) {
  ctx.assertAllowedPath(TMP_DIR, 'write');
  return ensurePrivateDir(TMP_DIR);
}

function secretFile(dir, prefix, content) {
  const file = path.join(dir, `${prefix}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); }
  return file;
}

const unlinkQuiet = (f) => { try { fs.unlinkSync(f); } catch { /* gone */ } };
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };

// --defaults-extra-file for the given credentials, falling back to /root/.my.cnf
// and finally to the caller's socket authentication; cleanup() removes the temp file.
function defaultsFor(creds, ctx) {
  if (creds && Object.keys(creds).length) {
    const file = secretFile(tmpDir(ctx), 'backup-my', renderClientCnf(creds));
    return { argv: [`--defaults-extra-file=${file}`], cleanup: () => unlinkQuiet(file) };
  }
  if (exists(ROOT_MY_CNF)) return { argv: [`--defaults-extra-file=${ROOT_MY_CNF}`], cleanup: () => {} };
  return { argv: [], cleanup: () => {} };
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex')));
  });
}

export function archiveTop(file) {
  return path.basename(file).replace(/\.tar(\.gz)?$/, '');
}

export function archiveUser(name) {
  const m = path.basename(name).match(/^(?:backup-\d{2}\.\d{2}\.\d{4}_\d{2}-\d{2}-\d{2}_|cpmove-)?([a-z][a-z0-9_-]{0,31})\.tar(?:\.gz)?$/);
  return m ? m[1] : null;
}

export function buildArchiveName(username, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `backup-${p(date.getMonth() + 1)}.${p(date.getDate())}.${date.getFullYear()}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}_${username}.tar.gz`;
}

// Two archives of one account inside the same second (a manual run next to a
// Transfers call) take the next free second instead of colliding.
export function freeArchiveName(username, taken, date = new Date()) {
  const d = new Date(date);
  for (let i = 0; i < 120; i++) {
    const name = buildArchiveName(username, d);
    if (!taken(name)) return name;
    d.setSeconds(d.getSeconds() + 1);
  }
  throw new OpError('exists', `No free archive name for ${username}`);
}

// Exclude patterns are anchored at the member root so "tmp" drops <home>/tmp
// only, never a deeper public_html/<x>/tmp.
export function tarExcludeArgs(base, excludes, includeMail) {
  const out = ['--anchored', '--no-wildcards-match-slash'];
  if (!includeMail) out.push(`--exclude=${base}/mail`);
  for (const ex of excludes) out.push(`--exclude=${base}/${ex.replace(/\/+$/, '')}`);
  return out;
}

// cPanel's cp/<user> is a KEY=value file; the keys a restore needs become the
// same metadata shape the panel writes to cp/<user>.json.
export function parseCpUserFile(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_-]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function cpmoveMetadata(cpText, username, { pds = '', addons = '', sds2 = '' } = {}) {
  const cp = parseCpUserFile(cpText);
  const domain = (cp.DNS || '').toLowerCase();
  if (!arg.domain.safeParse(domain).success) return null;
  const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const subDocroots = new Map();
  for (const l of lines(sds2)) { const i = l.indexOf('='); if (i > 0) subDocroots.set(l.slice(0, i).toLowerCase(), l.slice(i + 1)); }
  const domains = [];
  const addonSubs = new Set();
  for (const l of lines(addons)) {
    const i = l.indexOf('=');
    if (i <= 0) continue;
    const addon = l.slice(0, i).toLowerCase();
    const sub = l.slice(i + 1).toLowerCase().replace('_', '.');
    addonSubs.add(sub);
    if (arg.domain.safeParse(addon).success) domains.push({ domain: addon, type: 'addon', docroot: subDocroots.get(sub) ?? null });
  }
  for (const [sub, docroot] of subDocroots) if (!addonSubs.has(sub) && arg.domain.safeParse(sub).success) domains.push({ domain: sub, type: 'sub', docroot });
  for (const parked of lines(pds)) if (arg.domain.safeParse(parked.toLowerCase()).success) domains.push({ domain: parked.toLowerCase(), type: 'parked', docroot: null });
  return {
    version: 0,
    source: 'cpmove',
    account: { username, domain, package_name: cp.PLAN || null, owner: cp.OWNER || null, contact_email: cp.CONTACTEMAIL || null, ip: cp.IP || null, plan: {} },
    domains: domains.filter((d) => d.domain !== domain),
    databases: [], dbUsers: [], mail: [], dnsZones: [],
  };
}

// Members an archive may never carry into a home: device nodes, absolute
// names and ".." segments. The panel's own archives have none; an imported
// one is refused before tar extracts anything.
export function unsafeMembers(entries) {
  const out = [];
  for (const e of entries) {
    if (/^[bc]/.test(e.mode || '')) out.push({ name: e.name, reason: 'device node' });
    else if (e.name.startsWith('/')) out.push({ name: e.name, reason: 'absolute path' });
    else if (/(^|\/)\.\.(\/|$)/.test(e.name)) out.push({ name: e.name, reason: '".." segment' });
  }
  return out;
}

const sedEscape = (s) => s.replace(/[\\|.*^$[\]]/g, '\\$&');

// tar exits 1 when a file changed while it was read; that is a warning for a
// live home directory, not a failure. Anything else is fatal.
function tarFailure(result, what) {
  if (result.code === 0 || result.code === 1) return null;
  const line = result.stderr.trim().split('\n').filter((l) => !/Exiting with failure status/.test(l)).pop() || `tar exited with status ${result.code}`;
  return new OpError('command_failed', `${what}: ${line}`, { stderr: result.stderr.slice(-4000) });
}

function requireTar() {
  if (!hasBinary('tar')) throw new OpError('capability_missing', 'tar is not installed on this server');
}

function findBin(names) { return names.find(hasBinary) || null; }

// GNU tar -tv lines: "mode owner/group size date time name[ -> target]".
export function parseTarListing(stdout) {
  const out = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^([-dlcbps][-rwxsStT]{9})\s+(\S+)\s+(\d+(?:,\d+)?)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)\s+(.*)$/);
    if (!m) continue;
    let name = m[5];
    let target = null;
    const type = m[1][0] === 'd' ? 'dir' : m[1][0] === 'l' ? 'link' : m[1][0] === '-' ? 'file' : 'other';
    if (type === 'link') { const i = name.indexOf(' -> '); if (i >= 0) { target = name.slice(i + 4); name = name.slice(0, i); } }
    if (type === 'dir') name = name.replace(/\/$/, '');
    const [owner, group] = m[2].split('/');
    out.push({ name, type, mode: m[1], owner, group, size: m[3].includes(',') ? 0 : Number(m[3]), mtime: m[4], target });
  }
  return out;
}

// Folds a full listing under `prefix` into its direct children with totals.
export function foldChildren(entries, prefix) {
  const base = prefix ? `${prefix}/` : '';
  const children = new Map();
  for (const e of entries) {
    if (!e.name.startsWith(base) || e.name === prefix) continue;
    const rest = e.name.slice(base.length);
    const slash = rest.indexOf('/');
    const childName = slash === -1 ? rest : rest.slice(0, slash);
    const key = `${base}${childName}`;
    let c = children.get(key);
    if (!c) { c = { name: childName, path: key, type: 'dir', size: 0, files: 0, mtime: null, mode: null, owner: null, target: null, own: false }; children.set(key, c); }
    if (slash === -1) {
      Object.assign(c, { type: e.type, mode: e.mode, owner: `${e.owner}:${e.group}`, mtime: e.mtime, target: e.target, own: true });
    } else if (!c.own && (!c.mtime || e.mtime > c.mtime)) c.mtime = e.mtime;
    if (e.type === 'file') { c.size += e.size; c.files += 1; }
  }
  return [...children.values()].map(({ own, ...c }) => c).sort((a, b) => ((a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

async function mysqlQuery(sql, creds, ctx, { headers = true, timeoutMs = 120_000 } = {}) {
  const bin = findBin(CLIENT_BINS);
  if (!bin) throw new OpError('capability_missing', 'The MySQL/MariaDB client (mysql or mariadb) is not installed on this server');
  const defaults = defaultsFor(creds, ctx);
  try {
    const argv = [...defaults.argv, '--batch', '--no-auto-rehash', '--connect-timeout=10'];
    if (!headers) argv.push('--skip-column-names');
    const { code, stdout, stderr } = await exec(bin, argv, { input: `${sql}\n`, allowFailure: true, timeoutMs });
    if (code !== 0) { const err = classifyMysqlError(stderr); throw new OpError(err.code, `MySQL: ${err.message}`, { errno: err.errno }); }
    return parseBatch(stdout, { headers });
  } finally { defaults.cleanup(); }
}

// --------------------------------------------------------------- archive ---

const includeSchema = z.object({
  home: z.boolean().default(true),
  mail: z.boolean().default(true),
  dbs: z.boolean().default(true),
  dns: z.boolean().default(true),
  metadata: z.boolean().default(true),
}).strict().default({});

defineOp('backup.account.archive', {
  description: 'Build a cPanel-compatible account archive (home, MySQL dumps, DNS zones, metadata) as tar.gz with sha256',
  timeoutMs: 7_200_000,
  schema: z.object({
    username: arg.username,
    homeDir: arg.absPath,
    dest: arg.absPath,
    name: archiveName.optional(),
    include: includeSchema,
    excludes: z.array(relPath).max(200).default([]),
    databases: z.array(dbName).max(500).default([]),
    dbUsers: z.array(mysqlUser).max(500).default([]),
    credentials,
    dnsZones: z.array(z.object({ domain: arg.domain, body: arg.text }).strict()).max(500).default([]),
    metadata: z.record(z.string(), z.unknown()).refine((m) => JSON.stringify(m).length <= 4 * 1024 * 1024, 'metadata too large').optional(),
    compressionLevel: z.number().int().min(1).max(9).default(6),
    strict: z.boolean().default(false),
  }).strict(),
  run: async ({ username, homeDir, dest, name, include, excludes, databases, dbUsers, credentials: creds, dnsZones, metadata, compressionLevel, strict }, ctx) => {
    requireTar();
    if (!hasBinary('gzip')) throw new OpError('capability_missing', 'gzip is not installed on this server');
    const destDir = ctx.assertAllowedPath(dest, 'write');
    const home = ctx.assertAllowedPath(homeDir, 'read');
    const started = Date.now();
    const archive = name || freeArchiveName(username, (n) => exists(path.join(destDir, n)) || exists(path.join(destDir, `.staging-${archiveTop(n)}`)));
    if (archiveUser(archive) !== username) throw new OpError('invalid_args', `Archive name ${archive} does not belong to ${username}`);
    const top = archiveTop(archive);
    const base = path.basename(home);
    if (base === top || !base) throw new OpError('refused', `Cannot archive ${home} under the name ${archive}`);
    const out = path.join(destDir, archive);
    if (exists(out)) throw new OpError('exists', `${out} already exists`);
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const staging = path.join(destDir, `.staging-${top}`);
    fs.rmSync(staging, { recursive: true, force: true });
    const root = path.join(staging, top);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const warnings = [];
    const components = { home: { included: false }, mysql: [], users: 0, dnszones: [], metadata: Boolean(include.metadata && metadata) };
    const soft = (what, err) => {
      if (strict) throw err instanceof OpError ? err : new OpError('op_failed', `${what}: ${err.message}`);
      warnings.push(`${what}: ${err.message}`);
    };
    try {
      let homeStat = null;
      if (include.home) {
        try { homeStat = fs.statSync(home); } catch { homeStat = null; }
        if (!homeStat?.isDirectory()) { homeStat = null; soft('home', new OpError('not_found', `${home} does not exist or is not a directory`)); }
      }
      if (include.dbs && databases.length) {
        const dumpBin = findBin(DUMP_BINS);
        if (!dumpBin) soft('mysql', new OpError('capability_missing', 'mysqldump (mysql-client / mariadb-client package) is not installed on this server'));
        else {
          fs.mkdirSync(path.join(root, 'mysql'), { mode: 0o700 });
          const defaults = defaultsFor(creds, ctx);
          try {
            for (const db of databases) {
              const file = path.join(root, 'mysql', `${db}.sql`);
              const argv = [...defaults.argv, '--single-transaction', '--quick', '--routines', '--events', '--triggers', '--add-drop-database', `--result-file=${file}`, '--databases', db];
              const r = await exec(dumpBin, argv, { allowFailure: true, timeoutMs: 7_200_000 });
              if (r.code !== 0) { unlinkQuiet(file); const err = classifyMysqlError(r.stderr); soft(`mysql ${db}`, new OpError(err.code, `mysqldump: ${err.message}`)); continue; }
              components.mysql.push({ database: db, file: `mysql/${db}.sql`, sizeBytes: fs.statSync(file).size });
            }
          } finally { defaults.cleanup(); }
          if (dbUsers.length) {
            try {
              const users = await exportUsers(dbUsers, creds, ctx);
              fs.writeFileSync(path.join(root, 'mysql', 'users.json'), JSON.stringify(users, null, 2), { mode: 0o600 });
              components.users = users.users.length;
            } catch (err) { soft('mysql users', err); }
          }
        }
      }
      if (include.dns && dnsZones.length) {
        fs.mkdirSync(path.join(root, 'dnszones'), { mode: 0o700 });
        for (const zone of dnsZones) {
          fs.writeFileSync(path.join(root, 'dnszones', `${zone.domain}.db`), zone.body, { mode: 0o600 });
          components.dnszones.push(zone.domain);
        }
      }
      if (include.metadata && metadata) {
        fs.mkdirSync(path.join(root, 'cp'), { mode: 0o700 });
        fs.writeFileSync(path.join(root, 'cp', `${username}.json`), JSON.stringify(metadata, null, 2), { mode: 0o600 });
      }
      fs.mkdirSync(path.join(root, 'meta'), { mode: 0o700 });
      const info = { version: 1, generator: 'whm', username, homeDir: home, createdAt: new Date().toISOString(), include: { ...include, home: Boolean(homeStat) }, excludes, databases: components.mysql.map((m) => m.database), dbUsers: components.users, dnszones: components.dnszones, warnings };
      fs.writeFileSync(path.join(root, 'meta', 'info.json'), JSON.stringify(info, null, 2), { mode: 0o600 });

      const argv = ['--create', '--gzip', '--file', out, '--sparse', '--warning=no-file-changed', '--warning=no-file-removed', '--ignore-failed-read', '-C', staging, top];
      if (homeStat) {
        argv.push('--transform', `s|^${sedEscape(base)}\\(/\\|$\\)|${top}/homedir\\1|S`);
        argv.push(...tarExcludeArgs(base, excludes, include.mail));
        argv.push('-C', path.dirname(home), base);
      }
      // gzip honours GZIP for the level (with a deprecation note on stderr); the default level needs nothing.
      const env = compressionLevel === 6 ? undefined : { GZIP: `-${compressionLevel}` };
      const r = await exec('tar', argv, { allowFailure: true, timeoutMs: 7_200_000, env, maxBuffer: 64 * 1024 * 1024 });
      const failure = tarFailure(r, 'tar');
      if (failure) { unlinkQuiet(out); throw failure; }
      if (r.code === 1) warnings.push('some files changed while they were read');
      fs.chmodSync(out, 0o600);
      const sha256 = await sha256File(out);
      fs.writeFileSync(`${out}.sha256`, `${sha256}  ${archive}\n`, { mode: 0o600 });
      components.home = homeStat ? { included: true, path: home, mail: include.mail } : { included: false };
      return { path: out, name: archive, top, sizeBytes: fs.statSync(out).size, sha256, sha256File: `${out}.sha256`, components, warnings, durationMs: Date.now() - started };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  },
});

// Authentication rows and grants of the account's database users, so a restore
// can recreate them with their original password hashes.
async function exportUsers(names, creds, ctx) {
  const [[version]] = await mysqlQuery('SELECT VERSION()', creds, ctx, { headers: false });
  const engine = /mariadb/i.test(version || '') ? 'mariadb' : 'mysql';
  const hasPassword = engine === 'mariadb' && (await mysqlQuery("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'mysql' AND TABLE_NAME = 'user' AND COLUMN_NAME = 'Password'", creds, ctx, { headers: false })).length > 0;
  const list = names.map((n) => q.str(n)).join(', ');
  const rows = await mysqlQuery(`SELECT User, Host, plugin, HEX(authentication_string)${hasPassword ? ', HEX(Password)' : ", ''"} FROM mysql.user WHERE User IN (${list}) ORDER BY User, Host`, creds, ctx, { headers: false });
  const users = [];
  const hex = (v) => (!v || v === 'NULL' ? '' : v);
  for (const [user, host, plugin, authHex, passwordHex] of rows) {
    let grants = [];
    try { grants = (await mysqlQuery(`SHOW GRANTS FOR ${q.account(user, host)}`, creds, ctx, { headers: false })).map((r) => r[0]).filter((g) => /^GRANT /i.test(g)); } catch { /* user vanished */ }
    users.push({ user, host, plugin: plugin === 'NULL' ? '' : plugin, hashHex: hex(authHex) || hex(passwordHex), grants });
  }
  return { version: 1, engine, serverVersion: version, users };
}

// ---------------------------------------------------------------- inspect ---

defineOp('backup.archive.list', {
  description: 'Account archives in a local directory with size, time and recorded sha256',
  schema: z.object({ dir: arg.absPath, username: arg.username.optional() }).strict(),
  run: async ({ dir, username }, ctx) => {
    const d = ctx.assertAllowedPath(dir, 'read');
    let names = [];
    try { names = fs.readdirSync(d); } catch (err) { if (err.code === 'ENOENT') return { dir: d, exists: false, archives: [] }; throw err; }
    const archives = [];
    for (const n of names.sort()) {
      if (!READ_NAME.test(n)) continue;
      const user = archiveUser(n);
      if (username && user !== username) continue;
      let st;
      try { st = fs.statSync(path.join(d, n)); } catch { continue; }
      if (!st.isFile()) continue;
      let sha256 = null;
      try { sha256 = fs.readFileSync(path.join(d, `${n}.sha256`), 'utf8').trim().split(/\s+/)[0] || null; } catch { /* no sidecar */ }
      archives.push({ name: n, path: path.join(d, n), username: user, sizeBytes: st.size, mtime: st.mtime.toISOString(), sha256 });
    }
    return { dir: d, exists: true, archives };
  },
});

defineOp('backup.archive.verify', {
  description: 'Recompute the sha256 of an archive and compare it with the expected digest',
  timeoutMs: 3_600_000,
  schema: z.object({ archive: archivePath, sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  run: async ({ archive, sha256 }, ctx) => {
    const file = ctx.assertAllowedPath(archive, 'read');
    if (!exists(file)) throw new OpError('not_found', `${archive} does not exist`);
    const actual = await sha256File(file);
    return { path: file, sha256: actual, expected: sha256 ?? null, ok: sha256 ? actual === sha256 : null, sizeBytes: fs.statSync(file).size };
  },
});

defineOp('backup.archive.info', {
  description: 'Manifest, panel metadata and component list of an account archive',
  timeoutMs: 1_800_000,
  schema: z.object({ archive: archivePath }).strict(),
  run: async ({ archive }, ctx) => {
    requireTar();
    const file = ctx.assertAllowedPath(archive, 'read');
    if (!exists(file)) throw new OpError('not_found', `${archive} does not exist`);
    const top = archiveTop(file);
    const username = archiveUser(file);
    const readText = async (member) => {
      const r = await exec('tar', ['--extract', '--to-stdout', '--file', file, '--', `${top}/${member}`], { allowFailure: true, timeoutMs: 1_800_000, maxBuffer: 16 * 1024 * 1024 });
      return r.code === 0 ? r.stdout : null;
    };
    const readJson = async (member) => { const t = await readText(member); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };
    const info = await readJson('meta/info.json');
    let metadata = username ? await readJson(`cp/${username}.json`) : null;
    if (!metadata && username) metadata = cpmoveMetadata(await readText(`cp/${username}`), username);
    const list = await exec('tar', ['--list', '--file', file, '--no-recursion', '--wildcards', '--', `${top}/mysql/*`, `${top}/dnszones/*`, `${top}/homedir`], { allowFailure: true, timeoutMs: 1_800_000, maxBuffer: 16 * 1024 * 1024 });
    const members = list.stdout.split('\n').filter(Boolean).map((m) => m.slice(top.length + 1).replace(/\/$/, ''));
    return {
      path: file, top, username, sizeBytes: fs.statSync(file).size, info, metadata,
      components: {
        home: members.includes('homedir'),
        mysql: members.filter((m) => /^mysql\/[^/]+\.sql$/.test(m)).map((m) => ({ database: path.basename(m, '.sql'), file: m })),
        users: members.includes('mysql/users.json'),
        dnszones: members.filter((m) => /^dnszones\/[^/]+\.db$/.test(m)).map((m) => path.basename(m, '.db')),
      },
    };
  },
});

defineOp('backup.archive.inspect', {
  description: 'Browse an archive: direct children of a path inside it (tar -tv), with sizes and file counts',
  timeoutMs: 1_800_000,
  schema: z.object({ archive: archivePath, prefix: relPath.default('homedir'), limit: z.number().int().min(1).max(20000).default(2000) }).strict(),
  run: async ({ archive, prefix, limit }, ctx) => {
    requireTar();
    const file = ctx.assertAllowedPath(archive, 'read');
    if (!exists(file)) throw new OpError('not_found', `${archive} does not exist`);
    const top = archiveTop(file);
    const clean = prefix.replace(/\/+$/, '');
    const r = await exec('tar', ['--list', '--verbose', '--file', file, '--', `${top}/${clean}`], { allowFailure: true, timeoutMs: 1_800_000, maxBuffer: 256 * 1024 * 1024 });
    if (r.code !== 0 && /Not found in archive/.test(r.stderr)) throw new OpError('not_found', `${clean} is not in the archive`);
    const failure = tarFailure(r, 'tar');
    if (failure) throw failure;
    const entries = parseTarListing(r.stdout).map((e) => ({ ...e, name: e.name.slice(top.length + 1) }));
    const children = foldChildren(entries, clean);
    return { path: file, top, prefix: clean, total: children.length, truncated: children.length > limit, entries: children.slice(0, limit) };
  },
});

// ---------------------------------------------------------------- restore ---

// An archive from a destination is untrusted: before tar touches it the members
// to be extracted are listed and device nodes, absolute names and ".." segments
// are refused. tar --list on a missing member only reports it (exit 2); the
// extraction tolerates missing members itself.
async function refuseUnsafeMembers(file, members) {
  const listing = await exec('tar', ['--list', '--verbose', '--absolute-names', '--file', file, '--', ...members], { allowFailure: true, timeoutMs: 7_200_000, maxBuffer: 256 * 1024 * 1024 });
  const unsafe = unsafeMembers(parseTarListing(listing.stdout));
  if (unsafe.length) throw new OpError('invalid_archive', `${path.basename(file)} carries members that are never restored: ${unsafe.slice(0, 5).map((m) => `${m.name} (${m.reason})`).join(', ')}${unsafe.length > 5 ? ', …' : ''}`, { unsafe: unsafe.slice(0, 50) });
}

// With `as`, tar runs under the account's uid/gid (setpriv) so every write into
// the home tree is subject to the account's own permissions: a symlink the
// account planted (public_html -> /etc) cannot turn a restore into a root file
// write, whatever tar version the host has. The root-only archive stays
// readable through an ambient CAP_DAC_READ_SEARCH, which grants no write access.
// Without `as` tar runs as root, which by default recreates archived modes
// including setuid/setgid bits; --no-same-permissions applies the umask instead.
async function extractMembers(file, destDir, members, { strip, overwrite = true, as = null }) {
  const argv = ['--extract', '--file', file, '-C', destDir, '--no-same-owner', `--strip-components=${strip}`, '--warning=no-unknown-keyword'];
  argv.push(as ? '--preserve-permissions' : '--no-same-permissions');
  if (!overwrite) argv.push('--skip-old-files');
  argv.push('--', ...members);
  const tarBin = resolveBinary('tar');
  const [bin, args] = as
    ? ['setpriv', ['--reuid', String(as.uid), '--regid', String(as.gid), '--clear-groups', '--inh-caps', '+dac_read_search', '--ambient-caps', '+dac_read_search', '--no-new-privs', '--', tarBin, ...argv]]
    : ['tar', argv];
  const raw = await exec(bin, args, { allowFailure: true, timeoutMs: 7_200_000, maxBuffer: 64 * 1024 * 1024 });
  if (as && raw.code !== 0 && /^setpriv:/m.test(raw.stderr)) throw new OpError('command_failed', `setpriv: ${raw.stderr.trim().split('\n').pop()}`, { stderr: raw.stderr.slice(-4000) });
  // tar prefixes its messages with argv[0], which is the absolute path under setpriv.
  const r = as ? { ...raw, stderr: raw.stderr.split(`${tarBin}:`).join('tar:') } : raw;
  const missing = [...r.stderr.matchAll(/^tar: (.+): Not found in archive$/gm)].map((m) => m[1]);
  const otherErrors = r.stderr.split('\n').filter((l) => l.startsWith('tar:') && !/Not found in archive|Exiting with failure status|Removing leading/.test(l));
  if (r.code !== 0 && (r.code !== 2 || otherErrors.length)) throw new OpError('command_failed', `tar: ${(otherErrors[0] || r.stderr.trim().split('\n').pop() || `exit ${r.code}`).replace(/^tar: /, '')}`, { stderr: r.stderr.slice(-4000) });
  return { missing, warnings: otherErrors };
}

defineOp('backup.archive.extract', {
  description: 'Extract the control parts of an archive (mysql/, dnszones/, cp/, meta/) into a staging directory for a restore',
  timeoutMs: 7_200_000,
  schema: z.object({ archive: archivePath, dest: arg.absPath }).strict(),
  run: async ({ archive, dest }, ctx) => {
    requireTar();
    const file = ctx.assertAllowedPath(archive, 'read');
    const destDir = ctx.assertAllowedPath(dest, 'write');
    if (!exists(file)) throw new OpError('not_found', `${archive} does not exist`);
    const top = archiveTop(file);
    const members = ['mysql', 'dnszones', 'cp', 'meta', 'pds', 'addons', 'sds2'].map((m) => `${top}/${m}`);
    await refuseUnsafeMembers(file, members);
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const { missing } = await extractMembers(file, destDir, members, { strip: 1 });
    const listDir = (sub, ext) => { try { return fs.readdirSync(path.join(destDir, sub)).filter((f) => f.endsWith(ext)).sort().map((f) => ({ name: f.slice(0, -ext.length), file: path.join(destDir, sub, f) })); } catch { return []; } };
    const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
    const readJson = (p) => { try { return JSON.parse(readText(p)); } catch { return null; } };
    const username = archiveUser(file);
    let metadata = username ? readJson(path.join(destDir, 'cp', `${username}.json`)) : null;
    if (!metadata && username) {
      const cp = readText(path.join(destDir, 'cp', username));
      if (cp != null) metadata = cpmoveMetadata(cp, username, { pds: readText(path.join(destDir, 'pds')), addons: readText(path.join(destDir, 'addons')), sds2: readText(path.join(destDir, 'sds2')) });
    }
    return {
      path: file, top, stagingDir: destDir, username,
      info: readJson(path.join(destDir, 'meta', 'info.json')),
      metadata,
      mysql: listDir('mysql', '.sql').map((d) => ({ database: d.name, file: d.file, sizeBytes: fs.statSync(d.file).size })),
      users: readJson(path.join(destDir, 'mysql', 'users.json')),
      dnszones: listDir('dnszones', '.db').map((d) => ({ domain: d.name, file: d.file, body: fs.readFileSync(d.file, 'utf8') })),
      missing: missing.map((m) => m.slice(top.length + 1)),
    };
  },
});

defineOp('backup.files.restore', {
  description: 'Restore paths from an archive homedir/ into an account home, extracting as the account user (whole home when paths is empty)',
  destructive: true,
  timeoutMs: 7_200_000,
  schema: z.object({ archive: archivePath, username: arg.username, homeDir: arg.absPath, paths: z.array(relPath).max(500).default([]), overwrite: z.boolean().default(true) }).strict(),
  run: async ({ archive, username, homeDir, paths, overwrite }, ctx) => {
    requireTar();
    if (!hasBinary('setpriv')) throw new OpError('capability_missing', 'setpriv (util-linux) is not installed on this server; it is required to restore files with the account\'s privileges');
    const file = ctx.assertAllowedPath(archive, 'read');
    const home = ctx.assertAllowedPath(homeDir, 'write');
    const { uid, gid } = ownership(username);
    if (uid === 0) throw new OpError('refused', `Files are never restored for uid 0 (${username})`);
    if (!exists(file)) throw new OpError('not_found', `${archive} does not exist`);
    const top = archiveTop(file);
    if (!exists(home)) { fs.mkdirSync(home, { recursive: true, mode: 0o711 }); fs.chownSync(home, uid, gid); }
    const rel = paths.map((p) => p.replace(/\/+$/, ''));
    const members = rel.length ? rel.map((p) => `${top}/homedir/${p}`) : [`${top}/homedir`];
    await refuseUnsafeMembers(file, members);
    const { missing, warnings } = await extractMembers(file, home, members, { strip: 2, overwrite, as: { uid, gid } });
    const restored = [];
    for (const p of rel.length ? rel : ['.']) {
      let st = null;
      try { st = fs.lstatSync(path.resolve(home, p)); } catch { continue; }
      if (st.uid === uid) restored.push(p);
    }
    return { archive: file, homeDir: home, username, uid, gid, restored, missing: missing.map((m) => m.slice(`${top}/homedir/`.length)), overwrite, warnings };
  },
});

// cPanel ships per-database dumps (mysql/<db>.sql, no CREATE DATABASE/USE) with
// the schema's CREATE statement in mysql/<db>.create. Only its charset and
// collation are taken from that file; the name is the validated argument.
export function createDatabaseStatement(database, createFileText = '') {
  const text = String(createFileText || '');
  const charset = /(?:DEFAULT\s+)?CHARACTER\s+SET\s*=?\s*`?([A-Za-z0-9_]{1,32})`?/i.exec(text)?.[1];
  const collate = /COLLATE\s*=?\s*`?([A-Za-z0-9_]{1,64})`?/i.exec(text)?.[1];
  return `CREATE DATABASE IF NOT EXISTS ${q.id(database)}${charset ? ` DEFAULT CHARACTER SET ${charset}` : ''}${collate ? ` COLLATE ${collate}` : ''}`;
}

// The mysql client runs its own commands from a dump ("system <cmd>", "\\!",
// "tee", "source" ...), as the user running the client: root here, with the
// admin credentials. An archive restored from another server is untrusted, so
// the dump is screened line by line for those commands (and for a USE of any
// other database) before the client ever opens it. SQL itself is not judged:
// the panel's own dumps carry DROP DATABASE / CREATE DATABASE for the target.
export async function screenDumpForClientCommands(file, { database } = {}) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const codeOf = createSqlCodeFilter();
  const guard = createClientCommandGuard({ database });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      // A dump that switches the server to NO_BACKSLASH_ESCAPES / ANSI_QUOTES
      // makes the client tokenise strings differently from this screen, which
      // would let a later client command hide inside a literal.
      if (SQL_MODE_TRAP.test(line)) return { ok: false, line: lineNo, reason: 'sql_mode changes that alter string quoting are not allowed in a restored dump' };
      const reason = guard(codeOf(line));
      if (reason) return { ok: false, line: lineNo, reason };
    }
  } finally { rl.close(); stream.destroy(); }
  return { ok: true, lines: lineNo };
}

defineOp('backup.db.import', {
  description: 'Import a mysqldump file through the client (source <file>); with `database`, the schema is created first (mysql/<db>.create charset honoured) and the dump is sourced inside it',
  destructive: true,
  timeoutMs: 7_200_000,
  // The file name is placed on the client's `source` line, so it is kept to a plain character set.
  schema: z.object({ file: arg.absPath.refine((p) => /^[A-Za-z0-9._/-]+\.sql$/.test(p), 'Dump path: letters, digits, "._/-" ending in .sql'), database: dbName.optional(), credentials, force: z.boolean().default(false) }).strict(),
  run: async ({ file, database, credentials: creds, force }, ctx) => {
    const bin = findBin(CLIENT_BINS);
    if (!bin) throw new OpError('capability_missing', 'The MySQL/MariaDB client (mysql or mariadb) is not installed on this server');
    const sql = ctx.assertAllowedPath(file, 'read');
    if (!/\.sql$/.test(sql) || !exists(sql)) throw new OpError('not_found', `${file} is not an existing .sql dump`);
    const screen = await screenDumpForClientCommands(sql, { database });
    if (!screen.ok) throw new OpError('refused', `${path.basename(sql)} line ${screen.line}: ${screen.reason}; review the dump and import it by hand if it is legitimate`);
    // The screen tokenises strings the standard way; a server running with
    // NO_BACKSLASH_ESCAPES would read the same bytes differently.
    const modeRows = await mysqlQuery('SELECT @@GLOBAL.sql_mode', creds, ctx, { headers: false });
    const sqlMode = [].concat(...(Array.isArray(modeRows) ? modeRows : [])).map(String).join(' ');
    if (/\bNO_BACKSLASH_ESCAPES\b/i.test(sqlMode)) throw new OpError('refused', 'The MySQL server runs with sql_mode NO_BACKSLASH_ESCAPES, under which dumps cannot be screened for mysql client commands; import the dump by hand');
    let created = false;
    if (database) {
      let createText = '';
      try { createText = fs.readFileSync(`${sql.slice(0, -4)}.create`, 'utf8').slice(0, 4096); } catch { /* panel archives carry no .create file */ }
      const before = await mysqlQuery(`SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${q.str(database)}`, creds, ctx, { headers: false });
      await mysqlQuery(createDatabaseStatement(database, createText), creds, ctx);
      created = before.length === 0;
    }
    const defaults = defaultsFor(creds, ctx);
    try {
      const argv = [...defaults.argv, '--batch', '--no-auto-rehash', '--connect-timeout=10'];
      if (force) argv.push('--force');
      if (database) argv.push('--database', database);
      // `source` makes the client stream the file itself, so dumps of any size never pass through this process.
      argv.push('--execute', `source ${sql}`);
      const { code, stderr } = await exec(bin, argv, { allowFailure: true, timeoutMs: 7_200_000 });
      if (code !== 0) { const err = classifyMysqlError(stderr); throw new OpError(err.code, `MySQL: ${err.message}`, { errno: err.errno }); }
      return { file: sql, database: database ?? null, created, sizeBytes: fs.statSync(sql).size, warnings: stderr.trim() ? stderr.trim().split('\n').slice(-5) : [] };
    } finally { defaults.cleanup(); }
  },
});

// The database a GRANT line names, with MySQL's "\_" / "\%" escapes removed so
// it compares with the plain database names the panel keeps.
export function grantDatabase(line) {
  const g = parseGrant(line);
  return g ? g.database.replace(/\\([_%])/g, '$1') : null;
}

// A restore never widens privileges: global (*.*) and system-schema grants are
// refused outright, and with allowedDatabases every grant on another database
// is dropped. GRANT USAGE lines fall away with the rest; the user is still created.
const grantLine = z.string().max(4096).regex(/^GRANT /i).refine((line) => {
  const database = grantDatabase(line);
  return database == null || (database !== '*' && !SYSTEM_SCHEMAS.has(database.toLowerCase()));
}, 'Global (*.*) and system-schema grants are never restored');

defineOp('backup.db.restore_users', {
  description: 'Recreate database users (password hash, plugin and grants) exported in mysql/users.json; existing user@host rows are kept; grants outside allowedDatabases are dropped',
  schema: z.object({
    users: z.array(z.object({ user: mysqlUser, host: mysqlHost, plugin: z.string().regex(/^[A-Za-z0-9_]{0,64}$/).default(''), hashHex: z.string().regex(/^([A-Fa-f0-9]{2}){0,512}$/).default(''), grants: z.array(grantLine).max(200).default([]) }).strict()).min(1).max(500),
    allowedDatabases: z.array(dbName).max(500).optional(),
    credentials,
  }).strict(),
  run: async ({ users, allowedDatabases, credentials: creds }, ctx) => {
    const [[version]] = await mysqlQuery('SELECT VERSION()', creds, ctx, { headers: false });
    const engine = /mariadb/i.test(version || '') ? 'mariadb' : 'mysql';
    const allowed = allowedDatabases ? new Set(allowedDatabases) : null;
    const created = [];
    const skipped = [];
    const errors = [];
    const dropped = [];
    for (const u of users) {
      try {
        const present = await mysqlQuery(`SELECT 1 FROM mysql.user WHERE User = ${q.str(u.user)} AND Host = ${q.str(u.host)}`, creds, ctx, { headers: false });
        if (present.length) { skipped.push(`${u.user}@${u.host}`); continue; }
        const grantLines = u.grants.filter((line) => {
          const database = grantDatabase(line);
          if (database == null) return true;
          const ok = database !== '*' && !SYSTEM_SCHEMAS.has(database.toLowerCase()) && (!allowed || allowed.has(database));
          if (!ok) dropped.push(`${u.user}@${u.host}: ${line.slice(0, 160)}`);
          return ok;
        });
        const { statements } = cloneUserStatements({ user: u.user, toHost: u.host, engine, plugin: u.plugin, hashHex: u.hashHex, grantLines });
        await mysqlQuery(`${statements.map((s) => `${s};`).join('\n')}\nFLUSH PRIVILEGES;`, creds, ctx);
        created.push(`${u.user}@${u.host}`);
      } catch (err) {
        if (err.code === 'capability_missing') throw err;
        errors.push(`${u.user}@${u.host}: ${err.message}`);
      }
    }
    return { engine, created, skipped, errors, dropped };
  },
});

defineOp('backup.archive.remove', {
  description: 'Delete a local archive and its sha256 sidecar',
  destructive: true,
  schema: z.object({ archive: archivePath }).strict(),
  run: async ({ archive }, ctx) => {
    const file = ctx.assertAllowedPath(archive, 'write');
    const existed = exists(file);
    unlinkQuiet(file);
    unlinkQuiet(`${file}.sha256`);
    return { path: file, removed: existed };
  },
});

defineOp('backup.staging.remove', {
  description: 'Remove a restore staging directory created by backup.archive.extract',
  destructive: true,
  schema: z.object({ dir: arg.absPath }).strict(),
  run: async ({ dir }, ctx) => {
    const d = ctx.assertAllowedPath(dir, 'write');
    if (!/(^|\/)\.?(restore|staging)-[A-Za-z0-9._-]+$/.test(d)) throw new OpError('refused', `${dir} is not a backup staging directory`);
    fs.rmSync(d, { recursive: true, force: true });
    return { dir: d, removed: true };
  },
});

// ----------------------------------------------------------- destinations ---

const remotePath = z.string().max(512).regex(/^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._~/-]*$/, 'Remote path: letters, digits, "._~/-", no ".."');
const hostField = arg.hostname.or(z.string().ip());
// The URL is written as a quoted literal into curl's -K config file, which is
// read line by line; the WHATWG parser behind .url() strips tabs and newlines
// before validating, so they are refused here together with quotes and
// backslashes.
const urlField = z.string().max(2048).regex(/^https?:\/\/[^\s"'\\\x00-\x1f\x7f]+$/, 'http(s) URL without whitespace, quotes or control characters').url();
const nonEmpty = z.string().min(1).max(256).regex(/^[^\n\r\0]+$/);
const secretField = z.string().max(256).regex(/^[^\n\r\0]*$/);

// SFTP without a pinned host key verifies nothing on a host that has no
// known_hosts yet, so the fingerprint is required unless verification is
// explicitly skipped.
const requireSftpHostKey = (c, issues) => {
  if (c.kind === 'sftp' && !c.hostKeySha256 && !c.insecure) issues.addIssue({ code: z.ZodIssueCode.custom, path: ['hostKeySha256'], message: 'Pin the server host key (SHA-256 fingerprint from ssh-keyscan | ssh-keygen -lf -) or explicitly skip host key verification' });
};

// Values written into the rendered rclone.conf (`key = value`, one per line).
// rclone's INI reader takes a value that starts with a quote or backtick as
// quoted and trims surrounding whitespace, so those shapes are refused rather
// than silently changed; the secrets themselves never reach argv.
const iniValue = (max) => z.string().max(max).regex(/^(?!["'`#;\s])(?:[^\n\r\0]*[^\s\n\r\0])?$/, 'No quotes, comment markers, surrounding whitespace or control characters');
const cryptFields = { crypt: z.boolean().default(false), cryptPassword: iniValue(256).optional(), cryptPassword2: iniValue(256).optional() };
const oauthFields = { clientId: iniValue(512), clientSecret: iniValue(512), refreshToken: iniValue(8192), folder: remotePath.default('') };
const requireCryptKeys = (c, issues) => {
  if (c.crypt && !(c.cryptPassword && c.cryptPassword2)) issues.addIssue({ code: z.ZodIssueCode.custom, path: ['cryptPassword'], message: 'An encrypted destination needs its encryption password and salt' });
  if (c.kind === 'azureblob' && !c.accountKey && !c.sasToken) issues.addIssue({ code: z.ZodIssueCode.custom, path: ['accountKey'], message: 'Azure Blob needs an account key or a SAS token' });
};

export const destinationConfig = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), dir: arg.absPath, ...cryptFields }).strict(),
  z.object({ kind: z.literal('ftp'), host: hostField, port: z.number().int().min(1).max(65535).default(21), username: nonEmpty, password: secretField.default(''), path: remotePath.default(''), tls: z.boolean().default(false), insecure: z.boolean().default(false), passive: z.boolean().default(true), ...cryptFields }).strict(),
  z.object({ kind: z.literal('sftp'), host: hostField, port: z.number().int().min(1).max(65535).default(22), username: nonEmpty, password: secretField.optional(), privateKey: z.string().max(16384).optional(), hostKeySha256: z.string().regex(/^[A-Za-z0-9+/=]{40,48}$/).optional(), path: remotePath.default(''), insecure: z.boolean().default(false), ...cryptFields }).strict(),
  z.object({ kind: z.literal('webdav'), url: urlField, username: nonEmpty.optional(), password: secretField.optional(), insecure: z.boolean().default(false), ...cryptFields }).strict(),
  z.object({ kind: z.literal('s3'), endpoint: urlField.optional(), region: z.string().regex(/^[a-z0-9-]{1,32}$/).default('us-east-1'), bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/), prefix: remotePath.default(''), accessKey: nonEmpty, secretKey: nonEmpty, pathStyle: z.boolean().default(false), insecure: z.boolean().default(false), ...cryptFields }).strict(),
  z.object({ kind: z.literal('gdrive'), ...oauthFields, rootFolderId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), ...cryptFields }).strict(),
  z.object({ kind: z.literal('onedrive'), ...oauthFields, driveId: z.string().regex(/^[A-Za-z0-9!_-]{1,128}$/), driveType: z.enum(['personal', 'business', 'documentLibrary']), ...cryptFields }).strict(),
  z.object({ kind: z.literal('dropbox'), ...oauthFields, ...cryptFields }).strict(),
  z.object({ kind: z.literal('azureblob'), account: z.string().regex(/^[a-z0-9]{3,24}$/), container: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/), prefix: remotePath.default(''), accountKey: iniValue(256).optional(), sasToken: iniValue(2048).optional(), endpoint: urlField.optional(), ...cryptFields }).strict(),
  z.object({ kind: z.literal('b2'), keyId: z.string().regex(/^[A-Za-z0-9]{1,64}$/), applicationKey: iniValue(256), bucket: z.string().regex(/^[A-Za-z0-9-]{6,63}$/), prefix: remotePath.default(''), ...cryptFields }).strict(),
]).superRefine((c, issues) => { requireSftpHostKey(c, issues); requireCryptKeys(c, issues); });

// Cloud providers are reached through rclone only; any kind becomes an rclone
// remote once it is wrapped in a crypt remote.
const RCLONE_ONLY_KINDS = ['gdrive', 'onedrive', 'dropbox', 'azureblob', 'b2'];
export const needsRclone = (config) => RCLONE_ONLY_KINDS.includes(config.kind) || Boolean(config.crypt);
function assertLegacyEngine(config) {
  if (needsRclone(config)) throw new OpError('unsupported', `${config.kind}${config.crypt ? ' (encrypted)' : ''} destinations are served by the backup.rclone.* ops`);
}

const CURL_CODES = { 5: 'could not resolve proxy', 6: 'could not resolve host', 7: 'failed to connect', 9: 'access denied to the remote path', 19: 'file not found on the server', 22: 'the server returned an HTTP error', 25: 'upload failed (STOR/PUT refused)', 28: 'operation timed out', 35: 'TLS handshake failed', 51: 'TLS certificate verification failed', 60: 'TLS certificate could not be verified (enable "insecure" or install the CA)', 67: 'login denied', 78: 'the remote file does not exist', 79: 'SSH session error (host key or authentication)' };

// curl reports a rejected SSH host key with the TLS verification codes.
const SFTP_CODES = { 51: 'SSH host key verification failed (it does not match the pinned fingerprint)', 60: 'SSH host key verification failed (it does not match the pinned fingerprint)' };

function curlFailure(result, what, kind) {
  const line = result.stderr.trim().split('\n').filter((l) => /^curl:/.test(l)).pop() || result.stderr.trim().split('\n').pop() || '';
  const reason = (kind === 'sftp' && SFTP_CODES[result.code]) || CURL_CODES[result.code] || `curl exited with status ${result.code}`;
  return new OpError('destination_failed', `${what}: ${reason}${line ? ` (${line.replace(/^curl: \(\d+\) /, '')})` : ''}`, { exitCode: result.code });
}

export function parseCurlVersion(stdout) {
  const m = /^curl (\d+)\.(\d+)/.exec(String(stdout || ''));
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

// --hostpubsha256 exists since curl 7.80; RHEL/Alma/Rocky 9 ship 7.76 for the
// whole release, where the option is only a warning in a -K file and the
// transfer then fails host verification.
export const curlPinsHostKey = (v) => Boolean(v && (v.major > 7 || (v.major === 7 && v.minor >= 80)));

let curlVersionCache = null;
async function curlVersion() {
  if (curlVersionCache) return curlVersionCache;
  const r = await exec('curl', ['--version'], { allowFailure: true, timeoutMs: 15_000 });
  const v = parseCurlVersion(r.stdout);
  if (v) curlVersionCache = v;
  return v;
}
export function resetCurlVersionCache() { curlVersionCache = null; }

// ssh-keyscan prints "host keytype base64 [comment]" per key; OpenSSH's SHA-256
// fingerprint of a key (ssh-keygen -lf) is base64(sha256(key)) without padding.
export function matchHostKeyLines(stdout, pinnedSha256) {
  const pinned = String(pinnedSha256 || '').replace(/=+$/, '');
  const matched = [];
  const offered = [];
  for (const raw of String(stdout || '').split('\n')) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 3 || parts[0].startsWith('#') || !/^[A-Za-z0-9+/]+=*$/.test(parts[2])) continue;
    const fp = crypto.createHash('sha256').update(Buffer.from(parts[2], 'base64')).digest('base64').replace(/=+$/, '');
    offered.push(`${parts[1]} SHA256:${fp}`);
    if (fp === pinned) matched.push(parts.slice(0, 3).join(' '));
  }
  return { matched, offered };
}

// Older curl cannot pin a host key itself: the key is read with ssh-keyscan,
// compared with the pinned fingerprint here, and handed to curl as the only
// known_hosts entry of a private HOME (both the libssh and libssh2 backends
// read $HOME/.ssh/known_hosts). Returns that HOME; the caller removes it.
async function pinnedKnownHostsHome(config, dir) {
  if (!hasBinary('ssh-keyscan')) throw new OpError('destination_failed', 'curl on this server is older than 7.80 and cannot pin an SSH host key by fingerprint; install ssh-keyscan (openssh-clients / openssh-client) or upgrade curl');
  const r = await exec('ssh-keyscan', ['-p', String(config.port), '-T', '15', '--', config.host], { allowFailure: true, timeoutMs: 60_000 });
  const { matched, offered } = matchHostKeyLines(r.stdout, config.hostKeySha256);
  const where = `${config.host}:${config.port}`;
  if (!offered.length) { const line = r.stderr.trim().split('\n').filter((l) => !l.startsWith('#')).pop(); throw new OpError('destination_failed', `could not read the SSH host key of ${where}${line ? ` (${line})` : ''}`); }
  if (!matched.length) throw new OpError('destination_failed', `the SSH host key of ${where} does not match the pinned fingerprint; the server offers ${offered.join(', ')}`);
  const home = fs.mkdtempSync(path.join(dir, 'backup-sshhome-'));
  fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
  fs.writeFileSync(path.join(home, '.ssh', 'known_hosts'), `${matched.join('\n')}\n`, { mode: 0o600 });
  return home;
}

const curlQuote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const encodeSegments = (p) => p.split('/').map((s) => encodeURIComponent(s)).join('/');

// FTP paths are relative to the login directory ("/x" → "//x" is absolute);
// SFTP paths are absolute from the root, "~/x" is relative to the home.
export function remoteUrl(config, name = '') {
  if (config.kind === 'ftp') {
    const dir = config.path.replace(/\/+$/, '');
    return `ftp://${config.host}:${config.port}/${encodeSegments(dir)}${dir ? '/' : ''}${name}`;
  }
  if (config.kind === 'sftp') {
    const dir = config.path.replace(/\/+$/, '').replace(/^\/+/, '');
    return `sftp://${config.host}:${config.port}/${encodeSegments(dir)}${dir ? '/' : ''}${name}`;
  }
  if (config.kind === 'webdav') return `${config.url.replace(/\/+$/, '')}/${name}`;
  throw new OpError('unsupported', `${config.kind} has no URL form`);
}

// Runs curl with a 0600 config file so credentials never reach argv or /proc.
async function curl(config, lines, ctx, { what, timeoutMs = 3_600_000 } = {}) {
  if (!hasBinary('curl')) throw new OpError('capability_missing', 'curl is not installed on this server');
  const dir = tmpDir(ctx);
  const all = ['silent', 'show-error', 'connect-timeout = 20', `max-time = ${Math.floor(timeoutMs / 1000)}`, ...lines];
  const cleanup = [];
  let env;
  try {
    if (config.kind === 'ftp') {
      all.push(`user = ${curlQuote(`${config.username}:${config.password}`)}`);
      if (config.tls) all.push('ssl-reqd');
      if (config.insecure) all.push('insecure');
      if (!config.passive) all.push('ftp-port = "-"');
      all.push('ftp-create-dirs');
    } else if (config.kind === 'sftp') {
      all.push(`user = ${curlQuote(`${config.username}:${config.password || ''}`)}`);
      if (config.privateKey) { const key = secretFile(dir, 'backup-sshkey', config.privateKey.endsWith('\n') ? config.privateKey : `${config.privateKey}\n`); cleanup.push(key); all.push(`key = ${curlQuote(key)}`); }
      if (config.hostKeySha256) {
        if (curlPinsHostKey(await curlVersion())) all.push(`hostpubsha256 = ${curlQuote(config.hostKeySha256)}`);
        else { const home = await pinnedKnownHostsHome(config, dir); cleanup.push(home); env = { HOME: home }; }
      } else if (config.insecure) all.push('insecure');
      all.push('ftp-create-dirs');
    } else if (config.kind === 'webdav') {
      if (config.username) all.push(`user = ${curlQuote(`${config.username}:${config.password || ''}`)}`, 'anyauth');
      if (config.insecure) all.push('insecure');
      all.push('fail', 'location');
    }
    const cnf = secretFile(dir, 'backup-curl', `${all.join('\n')}\n`);
    cleanup.push(cnf);
    const r = await exec('curl', ['-K', cnf], { allowFailure: true, timeoutMs: timeoutMs + 5000, maxBuffer: 64 * 1024 * 1024, env });
    if (r.code !== 0) throw curlFailure(r, what, config.kind);
    return r;
  } finally { for (const f of cleanup) fs.rmSync(f, { recursive: true, force: true }); }
}

// --- S3 SigV4 (node:crypto + node:https; AWS, Backblaze B2, MinIO, Wasabi, …)

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function s3Target(config, key = '') {
  const endpoint = new URL(config.endpoint || `https://s3.${config.region}.amazonaws.com`);
  const pathStyle = Boolean(config.pathStyle);
  const host = pathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const hostname = pathStyle ? endpoint.hostname : `${config.bucket}.${endpoint.hostname}`;
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const objectPath = `${basePath}${pathStyle ? `/${config.bucket}` : ''}/${key.split('/').map(rfc3986).join('/')}`;
  return { protocol: endpoint.protocol, host, hostname, port: endpoint.port ? Number(endpoint.port) : undefined, path: objectPath };
}

export function signS3({ method, host, path: p, query = {}, headers = {}, payloadHash, region, accessKey, secretKey, date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const scopeDate = amzDate.slice(0, 8);
  const all = {};
  for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  Object.assign(all, { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate });
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((h) => `${h}:${all[h]}\n`).join('');
  const canonicalQuery = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(String(query[k]))}`).join('&');
  const canonical = [method, p, canonicalQuery, canonicalHeaders, names.join(';'), payloadHash].join('\n');
  const scope = `${scopeDate}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, scopeDate), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

function s3Request(config, { method, key, query = {}, headers = {}, body = null, contentLength = 0, payloadHash = sha256Hex(''), sink = null, timeoutMs = 3_600_000 }) {
  const target = s3Target(config, key);
  const signed = signS3({ method, host: target.host, path: target.path, query, headers: { ...headers, ...(body ? { 'content-length': String(contentLength) } : {}) }, payloadHash, region: config.region, accessKey: config.accessKey, secretKey: config.secretKey });
  const qs = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(String(query[k]))}`).join('&');
  const mod = target.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request({ method, hostname: target.hostname, port: target.port, path: `${target.path}${qs ? `?${qs}` : ''}`, headers: signed, rejectUnauthorized: !config.insecure, timeout: timeoutMs }, (res) => {
      if (sink && res.statusCode < 300) {
        res.pipe(sink);
        sink.on('finish', () => resolve({ status: res.statusCode, headers: res.headers, text: '' }));
        sink.on('error', reject);
        return;
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 65536) text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body) { body.on('error', reject); body.pipe(req); } else req.end();
  });
}

function s3Failure(res, what) {
  const code = res.text.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const message = res.text.match(/<Message>([^<]+)<\/Message>/)?.[1];
  return new OpError('destination_failed', `${what}: S3 responded ${res.status}${code ? ` ${code}` : ''}${message ? ` (${message})` : ''}`, { status: res.status, code: code ?? null });
}

const s3Prefix = (config) => config.prefix.replace(/^\/+|\/+$/g, '');
const s3Key = (config, name) => `${s3Prefix(config)}${s3Prefix(config) ? '/' : ''}${name}`;

async function s3Call(config, what, opts) {
  let res;
  try { res = await s3Request(config, opts); } catch (err) { throw new OpError('destination_failed', `${what}: ${err.message}`); }
  if (res.status >= 300) throw s3Failure(res, what);
  return res;
}

export function parseS3Listing(xml) {
  const out = [];
  const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = m[1].match(/<Key>([^<]+)<\/Key>/)?.[1];
    if (!key) continue;
    out.push({ key: unescape(key), sizeBytes: Number(m[1].match(/<Size>(\d+)<\/Size>/)?.[1] || 0), mtime: m[1].match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] || null });
  }
  return out;
}

async function uploadTo(config, file, name, ctx) {
  const what = `upload to ${config.kind}`;
  const st = fs.statSync(file);
  if (config.kind === 'local') {
    const dir = ctx.assertAllowedPath(config.dir, 'write');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, name);
    if (target === file) return { remotePath: target, sizeBytes: st.size };
    fs.copyFileSync(file, target);
    fs.chmodSync(target, 0o600);
    return { remotePath: target, sizeBytes: st.size };
  }
  if (config.kind === 's3') {
    const key = s3Key(config, name);
    const payloadHash = await sha256File(file);
    await s3Call(config, what, { method: 'PUT', key, headers: { 'content-type': 'application/gzip' }, body: fs.createReadStream(file), contentLength: st.size, payloadHash });
    return { remotePath: `s3://${config.bucket}/${key}`, sizeBytes: st.size };
  }
  const url = remoteUrl(config, name);
  await curl(config, [`url = ${curlQuote(url)}`, `upload-file = ${curlQuote(file)}`], ctx, { what });
  return { remotePath: url, sizeBytes: st.size };
}

async function removeFrom(config, name, ctx) {
  const what = `delete on ${config.kind}`;
  if (config.kind === 'local') { const target = path.join(ctx.assertAllowedPath(config.dir, 'write'), name); const existed = exists(target); unlinkQuiet(target); return { removed: existed }; }
  if (config.kind === 's3') { await s3Call(config, what, { method: 'DELETE', key: s3Key(config, name) }); return { removed: true }; }
  if (config.kind === 'webdav') { await curl(config, [`url = ${curlQuote(remoteUrl(config, name))}`, 'request = "DELETE"'], ctx, { what, timeoutMs: 120_000 }); return { removed: true }; }
  const dir = config.path.replace(/\/+$/, '');
  if (config.kind === 'ftp') { await curl(config, [`url = ${curlQuote(remoteUrl(config))}`, `quote = ${curlQuote(`DELE ${dir ? `${dir}/` : ''}${name}`)}`, 'list-only'], ctx, { what, timeoutMs: 120_000 }); return { removed: true }; }
  const sftpDir = dir.replace(/^\/+/, '');
  await curl(config, [`url = ${curlQuote(remoteUrl(config))}`, `quote = ${curlQuote(`rm ${dir.startsWith('/') ? '/' : ''}${sftpDir ? `${sftpDir}/` : ''}${name}`)}`, 'list-only'], ctx, { what, timeoutMs: 120_000 });
  return { removed: true };
}

async function listRemote(config, ctx) {
  const what = `list ${config.kind}`;
  if (config.kind === 'local') {
    const dir = ctx.assertAllowedPath(config.dir, 'read');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((n) => READ_NAME.test(n)).map((n) => { const st = fs.statSync(path.join(dir, n)); return { name: n, sizeBytes: st.size, mtime: st.mtime.toISOString() }; });
  }
  if (config.kind === 's3') {
    const prefix = s3Prefix(config);
    const res = await s3Call(config, what, { method: 'GET', key: '', query: { 'list-type': '2', 'max-keys': '1000', ...(prefix ? { prefix: `${prefix}/` } : {}) }, timeoutMs: 120_000 });
    return parseS3Listing(res.text).map((o) => ({ name: o.key.split('/').pop(), sizeBytes: o.sizeBytes, mtime: o.mtime })).filter((o) => READ_NAME.test(o.name));
  }
  if (config.kind === 'webdav') {
    const r = await curl(config, [`url = ${curlQuote(`${remoteUrl(config)}`)}`, 'request = "PROPFIND"', 'header = "Depth: 1"'], ctx, { what, timeoutMs: 120_000 });
    const names = [...r.stdout.matchAll(/<[Dd]:href>([^<]+)<\/[Dd]:href>/g)].map((m) => { try { return decodeURIComponent(m[1].split('/').filter(Boolean).pop() || ''); } catch { return ''; } });
    return [...new Set(names)].filter((n) => READ_NAME.test(n)).map((n) => ({ name: n, sizeBytes: null, mtime: null }));
  }
  const r = await curl(config, [`url = ${curlQuote(remoteUrl(config))}`, 'list-only'], ctx, { what, timeoutMs: 120_000 });
  return r.stdout.split('\n').map((l) => l.trim()).filter((n) => READ_NAME.test(n)).map((n) => ({ name: n, sizeBytes: null, mtime: null }));
}

defineOp('backup.destination.test', {
  description: 'Upload and delete a probe file on a destination; returns ok:false with the reason instead of throwing',
  timeoutMs: 300_000,
  schema: z.object({ config: destinationConfig }).strict(),
  run: async ({ config }, ctx) => {
    assertLegacyEngine(config);
    const started = Date.now();
    const name = `whm-backup-test-${crypto.randomBytes(6).toString('hex')}.txt`;
    const probe = path.join(tmpDir(ctx), name);
    fs.writeFileSync(probe, `WHM backup destination test ${new Date().toISOString()}\n`, { mode: 0o600 });
    try {
      if (config.kind === 'local') {
        const dir = ctx.assertAllowedPath(config.dir, 'write');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.copyFileSync(probe, path.join(dir, name));
        unlinkQuiet(path.join(dir, name));
        return { ok: true, message: `${dir} is writable`, ms: Date.now() - started };
      }
      if (config.kind === 's3') {
        const key = s3Key(config, name);
        const body = fs.readFileSync(probe);
        await s3Call(config, 'test upload', { method: 'PUT', key, headers: { 'content-type': 'text/plain' }, body: fs.createReadStream(probe), contentLength: body.length, payloadHash: sha256Hex(body), timeoutMs: 120_000 });
        await s3Call(config, 'test delete', { method: 'DELETE', key, timeoutMs: 120_000 });
        return { ok: true, message: `Uploaded and deleted ${key} in bucket ${config.bucket}`, ms: Date.now() - started };
      }
      const url = remoteUrl(config, name);
      await curl(config, [`url = ${curlQuote(url)}`, `upload-file = ${curlQuote(probe)}`], ctx, { what: 'test upload', timeoutMs: 120_000 });
      let cleaned = true;
      try { await removeFrom(config, name, ctx); } catch { cleaned = false; }
      return { ok: true, message: `Uploaded a probe file to ${url}${cleaned ? ' and deleted it' : ' (could not delete it afterwards)'}`, ms: Date.now() - started };
    } catch (err) {
      if (err.code === 'capability_missing' || err.code === 'path_not_allowed') throw err;
      return { ok: false, message: err.message, code: err.code || 'failed', ms: Date.now() - started };
    } finally { unlinkQuiet(probe); }
  },
});

defineOp('backup.destination.upload', {
  description: 'Copy a local archive to a destination (local dir, FTP/FTPS, SFTP, WebDAV or S3-compatible storage)',
  timeoutMs: 7_200_000,
  schema: z.object({ config: destinationConfig, file: archivePath, remoteName: readableName.optional() }).strict(),
  run: async ({ config, file, remoteName }, ctx) => {
    assertLegacyEngine(config);
    const local = ctx.assertAllowedPath(file, 'read');
    if (!exists(local)) throw new OpError('not_found', `${file} does not exist`);
    const started = Date.now();
    const name = remoteName || path.basename(local);
    const result = await uploadTo(config, local, name, ctx);
    return { kind: config.kind, name, ...result, encrypted: false, ms: Date.now() - started };
  },
});

defineOp('backup.destination.download', {
  description: 'Fetch an archive from a destination into a local directory',
  timeoutMs: 7_200_000,
  schema: z.object({ config: destinationConfig, remoteName: readableName, dest: arg.absPath }).strict(),
  run: async ({ config, remoteName, dest }, ctx) => {
    assertLegacyEngine(config);
    const dir = ctx.assertAllowedPath(dest, 'write');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, remoteName);
    const started = Date.now();
    if (config.kind === 'local') {
      const source = path.join(ctx.assertAllowedPath(config.dir, 'read'), remoteName);
      if (!exists(source)) throw new OpError('not_found', `${remoteName} is not on the destination`);
      if (source !== target) fs.copyFileSync(source, target);
    } else if (config.kind === 's3') {
      const sink = fs.createWriteStream(target, { mode: 0o600 });
      try { await s3Call(config, 'download', { method: 'GET', key: s3Key(config, remoteName), sink }); } catch (err) { sink.destroy(); unlinkQuiet(target); throw err; }
    } else {
      try { await curl(config, [`url = ${curlQuote(remoteUrl(config, remoteName))}`, `output = ${curlQuote(target)}`], ctx, { what: 'download' }); } catch (err) { unlinkQuiet(target); throw err; }
    }
    fs.chmodSync(target, 0o600);
    return { path: target, name: remoteName, sizeBytes: fs.statSync(target).size, sha256: await sha256File(target), ms: Date.now() - started };
  },
});

defineOp('backup.destination.list', {
  description: 'Account archives present on a destination',
  timeoutMs: 300_000,
  schema: z.object({ config: destinationConfig }).strict(),
  run: async ({ config }, ctx) => { assertLegacyEngine(config); return { kind: config.kind, encrypted: false, archives: (await listRemote(config, ctx)).map((a) => ({ ...a, username: archiveUser(a.name) })) }; },
});

defineOp('backup.destination.remove', {
  description: 'Delete an archive from a destination (retention pruning)',
  destructive: true,
  timeoutMs: 300_000,
  schema: z.object({ config: destinationConfig, remoteName: readableName }).strict(),
  run: async ({ config, remoteName }, ctx) => { assertLegacyEngine(config); return { kind: config.kind, name: remoteName, ...(await removeFrom(config, remoteName, ctx)) }; },
});

// --- rclone: cloud providers and at-rest encryption ---------------------------
//
// Every call renders a root-only rclone.conf into a fresh private directory
// (secrets never reach argv or /proc), runs one rclone command against the
// remote "whm:" and removes the directory afterwards. With `crypt` set the
// backend sits in "[whmbase]" and "whm" is a crypt remote on top of it, so
// names and contents are ciphertext at rest; the operator's encryption key is
// the (password, salt) pair rendered as rclone's obscured password/password2.

// rclone's reversible obscuring of config passwords (lib/obscure): AES-256-CTR
// under a key compiled into every rclone build, base64url without padding.
const RCLONE_OBSCURE_KEY = Buffer.from([0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d, 0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b, 0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb, 0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38]);
export function rcloneObscure(value, iv = crypto.randomBytes(16)) {
  const cipher = crypto.createCipheriv('aes-256-ctr', RCLONE_OBSCURE_KEY, iv);
  return Buffer.concat([iv, cipher.update(Buffer.from(String(value), 'utf8')), cipher.final()]).toString('base64url');
}

const RCLONE_CODES = { 1: 'usage error', 2: 'the operation failed', 3: 'directory not found', 4: 'file not found', 5: 'temporary error, retries exhausted', 6: 'the remote refused the operation', 7: 'fatal error (authentication or configuration)', 8: 'transfer limit exceeded', 9: 'nothing was transferred' };
const RCLONE_SECRET_FIELDS = ['password', 'secretKey', 'privateKey', 'refreshToken', 'clientSecret', 'accountKey', 'sasToken', 'applicationKey', 'cryptPassword', 'cryptPassword2'];
const OAUTH_KINDS = ['gdrive', 'onedrive', 'dropbox'];

// The token rclone refreshes and rewrites itself; an expired placeholder makes
// the first call refresh it from the stored refresh token.
const oauthToken = (refreshToken) => JSON.stringify({ access_token: '', token_type: 'Bearer', refresh_token: refreshToken, expiry: '2000-01-01T00:00:00Z' });
const joinRemote = (...parts) => parts.map((p) => String(p || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

export function scrubSecrets(text, config) {
  let out = String(text || '');
  for (const f of RCLONE_SECRET_FIELDS) {
    const v = config?.[f];
    if (typeof v === 'string' && v.length >= 4) out = out.split(v).join('[redacted]');
  }
  return out;
}

// Backend section of the rendered config plus the path inside it that holds
// the archives (`root`). Files needed by the backend (SSH key, pinned
// known_hosts) are written into `dir`, which the caller removes.
async function rcloneBackend(config, dir, ctx) {
  const s = {};
  const flags = [];
  let root = '';
  switch (config.kind) {
    case 'local': s.type = 'local'; root = ctx.assertAllowedPath(config.dir, 'write'); break;
    case 'ftp':
      s.type = 'ftp'; s.host = config.host; s.port = String(config.port); s.user = config.username; s.pass = rcloneObscure(config.password || '');
      if (config.tls) s.explicit_tls = 'true';
      if (config.insecure) flags.push('--no-check-certificate');
      root = config.path.replace(/^\/+/, '');
      break;
    case 'sftp':
      s.type = 'sftp'; s.host = config.host; s.port = String(config.port); s.user = config.username;
      if (config.password) s.pass = rcloneObscure(config.password);
      if (config.privateKey) s.key_file = secretFile(dir, 'rclone-sshkey', config.privateKey.endsWith('\n') ? config.privateKey : `${config.privateKey}\n`);
      if (config.hostKeySha256) s.known_hosts_file = path.join(await pinnedKnownHostsHome(config, dir), '.ssh', 'known_hosts');
      root = config.path.replace(/^~\/?/, '');
      break;
    case 'webdav':
      s.type = 'webdav'; s.url = config.url; s.vendor = 'other';
      if (config.username) { s.user = config.username; s.pass = rcloneObscure(config.password || ''); }
      if (config.insecure) flags.push('--no-check-certificate');
      break;
    case 's3':
      s.type = 's3'; s.provider = config.endpoint ? 'Other' : 'AWS'; s.access_key_id = config.accessKey; s.secret_access_key = config.secretKey; s.region = config.region;
      if (config.endpoint) s.endpoint = config.endpoint;
      s.force_path_style = config.pathStyle ? 'true' : 'false';
      if (config.insecure) flags.push('--no-check-certificate');
      root = joinRemote(config.bucket, config.prefix);
      break;
    case 'gdrive':
      s.type = 'drive'; s.scope = 'drive.file'; s.client_id = config.clientId; s.client_secret = config.clientSecret; s.token = oauthToken(config.refreshToken);
      if (config.rootFolderId) s.root_folder_id = config.rootFolderId;
      root = joinRemote(config.folder);
      break;
    case 'onedrive':
      s.type = 'onedrive'; s.client_id = config.clientId; s.client_secret = config.clientSecret; s.token = oauthToken(config.refreshToken); s.drive_id = config.driveId; s.drive_type = config.driveType;
      root = joinRemote(config.folder);
      break;
    case 'dropbox':
      s.type = 'dropbox'; s.client_id = config.clientId; s.client_secret = config.clientSecret; s.token = oauthToken(config.refreshToken);
      root = joinRemote(config.folder);
      break;
    case 'azureblob': {
      s.type = 'azureblob'; s.account = config.account;
      const endpoint = (config.endpoint || `https://${config.account}.blob.core.windows.net`).replace(/\/+$/, '');
      if (config.accountKey) s.key = config.accountKey;
      else s.sas_url = `${endpoint}/${config.container}?${String(config.sasToken).replace(/^\?/, '')}`;
      if (config.endpoint) s.endpoint = config.endpoint;
      root = joinRemote(config.container, config.prefix);
      break;
    }
    case 'b2':
      s.type = 'b2'; s.account = config.keyId; s.key = config.applicationKey;
      root = joinRemote(config.bucket, config.prefix);
      break;
    default: throw new OpError('unsupported', `${config.kind} has no rclone backend`);
  }
  return { section: s, root, flags };
}

function assertIniValue(key, value) {
  if (!/^(?!["'`#;\s])(?:[^\n\r\0]*[^\s\n\r\0])?$/.test(String(value))) throw new OpError('invalid_args', `rclone.conf value for "${key}" contains characters the configuration file cannot carry`);
}

export function renderRcloneConf(config, backend) {
  const sections = [];
  let root;
  if (config.crypt) {
    sections.push(['whmbase', backend.section]);
    sections.push(['whm', { type: 'crypt', remote: `whmbase:${backend.root}`, filename_encryption: 'standard', directory_name_encryption: 'true', password: rcloneObscure(config.cryptPassword), password2: rcloneObscure(config.cryptPassword2) }]);
    root = '';
  } else {
    sections.push(['whm', backend.section]);
    root = backend.root;
  }
  const lines = [];
  for (const [name, kv] of sections) {
    lines.push(`[${name}]`);
    for (const [k, v] of Object.entries(kv)) {
      if (v == null || v === '') continue;
      assertIniValue(k, v);
      lines.push(`${k} = ${v}`);
    }
    lines.push('');
  }
  return { text: lines.join('\n'), root };
}

// "whm:" plus the path inside the remote; an empty root and name address the
// remote itself. Never starts with "-", so it is safe after the flags.
export const rcloneTarget = (root, name = '') => `whm:${root ? `${root.replace(/\/+$/, '')}${name ? '/' : ''}` : ''}${name}`;

// A refresh token the provider rotated during the call (rclone writes the new
// token back into its config file) so the panel can persist it.
export function readTokenUpdate(text, config) {
  if (!OAUTH_KINDS.includes(config.kind)) return null;
  const section = config.crypt ? 'whmbase' : 'whm';
  let inSection = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inSection = line === `[${section}]`; continue; }
    if (!inSection) continue;
    const m = /^token\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    try {
      const tok = JSON.parse(m[1]);
      if (typeof tok?.refresh_token === 'string' && tok.refresh_token && tok.refresh_token !== config.refreshToken) return { refreshToken: tok.refresh_token };
    } catch { /* not ours to repair */ }
    return null;
  }
  return null;
}

function rcloneFailure(result, what, config) {
  const line = result.stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  const reason = RCLONE_CODES[result.code] || `rclone exited with status ${result.code}`;
  const detail = scrubSecrets(line.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s+(ERROR|NOTICE|INFO|DEBUG)?\s*:?\s*/, ''), config).slice(0, 500);
  return new OpError('destination_failed', `${what}: ${reason}${detail ? ` (${detail})` : ''}`, { exitCode: result.code });
}

export function parseLsjson(stdout) {
  let entries;
  try { entries = JSON.parse(String(stdout || '[]')); } catch { throw new OpError('destination_failed', 'rclone returned an unreadable listing'); }
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => e && !e.IsDir && typeof e.Name === 'string').map((e) => ({ name: e.Name, sizeBytes: Number.isFinite(e.Size) && e.Size >= 0 ? e.Size : null, mtime: typeof e.ModTime === 'string' ? e.ModTime : null }));
}

// Runs one rclone command. `argv` receives the root inside the remote (empty
// for a crypt remote, whose root is part of its definition) and returns the
// command and its arguments; the config file is removed whatever happens.
async function rclone(config, argv, ctx, { what, timeoutMs = 600_000 } = {}) {
  if (!hasBinary('rclone')) throw new OpError('capability_missing', 'rclone is not installed on this server; install the rclone package to use cloud storage destinations and encrypted uploads', { bin: 'rclone', capability: 'rclone' });
  const dir = fs.mkdtempSync(path.join(tmpDir(ctx), 'backup-rclone-'));
  try {
    const backend = await rcloneBackend(config, dir, ctx);
    const conf = renderRcloneConf(config, backend);
    const confFile = secretFile(dir, 'rclone', conf.text);
    const cache = path.join(dir, 'cache');
    fs.mkdirSync(cache, { mode: 0o700 });
    const args = ['--config', confFile, '--cache-dir', cache, '--contimeout', '30s', '--timeout', '5m', '--retries', '3', '--retries-sleep', '5s', '--low-level-retries', '10', '--stats', '0', '--log-level', 'ERROR', ...backend.flags, ...argv(conf.root)];
    const r = await exec('rclone', args, { allowFailure: true, timeoutMs: timeoutMs + 5000, maxBuffer: 64 * 1024 * 1024, env: { HOME: dir } });
    let tokenUpdate = null;
    try { tokenUpdate = readTokenUpdate(fs.readFileSync(confFile, 'utf8'), config); } catch { tokenUpdate = null; }
    if (r.code !== 0) throw rcloneFailure(r, what, config);
    return { stdout: r.stdout, code: r.code, root: backend.root, tokenUpdate };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const displayPath = (config, root, name) => `${config.kind}://${joinRemote(root, name)}${config.crypt ? ' (encrypted)' : ''}`;

defineOp('backup.rclone.test', {
  description: 'Upload, list and delete a probe file through rclone (cloud providers, encrypted remotes); returns ok:false with the reason instead of throwing',
  timeoutMs: 300_000,
  schema: z.object({ config: destinationConfig }).strict(),
  run: async ({ config }, ctx) => {
    const started = Date.now();
    const name = `whm-backup-test-${crypto.randomBytes(6).toString('hex')}.txt`;
    const probe = path.join(tmpDir(ctx), name);
    fs.writeFileSync(probe, `WHM backup destination test ${new Date().toISOString()}\n`, { mode: 0o600 });
    try {
      const up = await rclone(config, (root) => ['copyto', probe, rcloneTarget(root, name)], ctx, { what: 'test upload', timeoutMs: 120_000 });
      const ls = await rclone(config, (root) => ['lsjson', rcloneTarget(root, name)], ctx, { what: 'test listing', timeoutMs: 120_000 });
      const seen = parseLsjson(ls.stdout).some((e) => e.name === name);
      let cleaned = true;
      try { await rclone(config, (root) => ['deletefile', rcloneTarget(root, name)], ctx, { what: 'test delete', timeoutMs: 120_000 }); } catch { cleaned = false; }
      const where = displayPath(config, up.root, '');
      if (!seen) return { ok: false, message: `test listing: the probe file was uploaded to ${where} but does not show in the listing`, code: 'destination_failed', ms: Date.now() - started, tokenUpdate: ls.tokenUpdate || up.tokenUpdate };
      return { ok: true, message: `Uploaded, listed and ${cleaned ? 'deleted' : 'could not delete'} a probe file at ${where}`, encrypted: Boolean(config.crypt), ms: Date.now() - started, tokenUpdate: ls.tokenUpdate || up.tokenUpdate };
    } catch (err) {
      if (err.code === 'capability_missing' || err.code === 'path_not_allowed' || err.code === 'invalid_args') throw err;
      return { ok: false, message: err.message, code: err.code || 'failed', ms: Date.now() - started };
    } finally { unlinkQuiet(probe); }
  },
});

defineOp('backup.rclone.upload', {
  description: 'Copy a local archive to a destination through rclone (cloud providers, encrypted remotes)',
  timeoutMs: 7_200_000,
  schema: z.object({ config: destinationConfig, file: archivePath, remoteName: readableName.optional() }).strict(),
  run: async ({ config, file, remoteName }, ctx) => {
    const local = ctx.assertAllowedPath(file, 'read');
    if (!exists(local)) throw new OpError('not_found', `${file} does not exist`);
    const started = Date.now();
    const name = remoteName || path.basename(local);
    const size = fs.statSync(local).size;
    const up = await rclone(config, (root) => ['copyto', local, rcloneTarget(root, name)], ctx, { what: `upload to ${config.kind}`, timeoutMs: 7_200_000 });
    const ls = await rclone(config, (root) => ['lsjson', rcloneTarget(root, name)], ctx, { what: `verify upload to ${config.kind}`, timeoutMs: 120_000 });
    const entry = parseLsjson(ls.stdout).find((e) => e.name === name);
    if (!entry) throw new OpError('destination_failed', `upload to ${config.kind}: ${name} is not listed on the destination after the copy`);
    if (entry.sizeBytes != null && entry.sizeBytes !== size) throw new OpError('destination_failed', `upload to ${config.kind}: the destination holds ${entry.sizeBytes} bytes for ${name}, the archive has ${size}`);
    return { kind: config.kind, name, remotePath: displayPath(config, up.root, name), sizeBytes: size, encrypted: Boolean(config.crypt), ms: Date.now() - started, tokenUpdate: ls.tokenUpdate || up.tokenUpdate };
  },
});

defineOp('backup.rclone.download', {
  description: 'Fetch an archive from an rclone destination into a local directory (decrypts through the crypt remote)',
  timeoutMs: 7_200_000,
  schema: z.object({ config: destinationConfig, remoteName: readableName, dest: arg.absPath }).strict(),
  run: async ({ config, remoteName, dest }, ctx) => {
    const dir = ctx.assertAllowedPath(dest, 'write');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, remoteName);
    const started = Date.now();
    let r;
    try {
      r = await rclone(config, (root) => ['copyto', rcloneTarget(root, remoteName), target], ctx, { what: `download from ${config.kind}`, timeoutMs: 7_200_000 });
    } catch (err) { unlinkQuiet(target); throw err; }
    if (!exists(target)) throw new OpError('destination_failed', `download from ${config.kind}: rclone finished but ${remoteName} was not written`);
    fs.chmodSync(target, 0o600);
    return { path: target, name: remoteName, sizeBytes: fs.statSync(target).size, sha256: await sha256File(target), encrypted: Boolean(config.crypt), ms: Date.now() - started, tokenUpdate: r.tokenUpdate };
  },
});

defineOp('backup.rclone.list', {
  description: 'Account archives present on an rclone destination (names decrypted through the crypt remote)',
  timeoutMs: 300_000,
  schema: z.object({ config: destinationConfig }).strict(),
  run: async ({ config }, ctx) => {
    let r;
    try {
      r = await rclone(config, (root) => ['lsjson', '--files-only', rcloneTarget(root)], ctx, { what: `list ${config.kind}`, timeoutMs: 300_000 });
    } catch (err) {
      if (err.code === 'destination_failed' && err.details?.exitCode === 3) return { kind: config.kind, encrypted: Boolean(config.crypt), archives: [], tokenUpdate: null };
      throw err;
    }
    return { kind: config.kind, encrypted: Boolean(config.crypt), archives: parseLsjson(r.stdout).filter((a) => READ_NAME.test(a.name)).map((a) => ({ ...a, username: archiveUser(a.name) })), tokenUpdate: r.tokenUpdate };
  },
});

defineOp('backup.rclone.delete', {
  description: 'Delete an archive from an rclone destination (retention pruning)',
  destructive: true,
  timeoutMs: 300_000,
  schema: z.object({ config: destinationConfig, remoteName: readableName }).strict(),
  run: async ({ config, remoteName }, ctx) => {
    try {
      const r = await rclone(config, (root) => ['deletefile', rcloneTarget(root, remoteName)], ctx, { what: `delete on ${config.kind}`, timeoutMs: 300_000 });
      return { kind: config.kind, name: remoteName, removed: true, tokenUpdate: r.tokenUpdate };
    } catch (err) {
      if (err.code === 'destination_failed' && (err.details?.exitCode === 3 || err.details?.exitCode === 4)) return { kind: config.kind, name: remoteName, removed: false, tokenUpdate: null };
      throw err;
    }
  },
});
