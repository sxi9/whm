import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { z } from 'zod';
import { exec, hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { renderClientCnf, classifyMysqlError, parseBatch, cloneUserStatements, q } from './db.js';

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
  fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  return TMP_DIR;
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
    const m = line.match(/^([-dlcbps][-rwxsStT]{9})\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)\s+(.*)$/);
    if (!m) continue;
    let name = m[5];
    let target = null;
    const type = m[1][0] === 'd' ? 'dir' : m[1][0] === 'l' ? 'link' : m[1][0] === '-' ? 'file' : 'other';
    if (type === 'link') { const i = name.indexOf(' -> '); if (i >= 0) { target = name.slice(i + 4); name = name.slice(0, i); } }
    if (type === 'dir') name = name.replace(/\/$/, '');
    const [owner, group] = m[2].split('/');
    out.push({ name, type, mode: m[1], owner, group, size: Number(m[3]), mtime: m[4], target });
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
    const archive = name || buildArchiveName(username);
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
        if (!include.mail) argv.push(`--exclude=${base}/mail`);
        for (const ex of excludes) argv.push(`--exclude=${base}/${ex.replace(/\/+$/, '')}`);
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
    const readJson = async (member) => {
      const r = await exec('tar', ['--extract', '--to-stdout', '--file', file, '--', `${top}/${member}`], { allowFailure: true, timeoutMs: 1_800_000, maxBuffer: 16 * 1024 * 1024 });
      if (r.code !== 0) return null;
      try { return JSON.parse(r.stdout); } catch { return null; }
    };
    const info = await readJson('meta/info.json');
    const metadata = username ? await readJson(`cp/${username}.json`) : null;
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

// With `as`, tar runs under the account's uid/gid (setpriv) so every write into
// the home tree is subject to the account's own permissions: a symlink the
// account planted (public_html -> /etc) cannot turn a restore into a root file
// write, whatever tar version the host has. The root-only archive stays
// readable through an ambient CAP_DAC_READ_SEARCH, which grants no write access.
async function extractMembers(file, destDir, members, { strip, overwrite = true, as = null }) {
  const argv = ['--extract', '--file', file, '-C', destDir, '--no-same-owner', `--strip-components=${strip}`, '--warning=no-unknown-keyword'];
  if (as) argv.push('--preserve-permissions');
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
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const { missing } = await extractMembers(file, destDir, ['mysql', 'dnszones', 'cp', 'meta'].map((m) => `${top}/${m}`), { strip: 1 });
    const listDir = (sub, ext) => { try { return fs.readdirSync(path.join(destDir, sub)).filter((f) => f.endsWith(ext)).sort().map((f) => ({ name: f.slice(0, -ext.length), file: path.join(destDir, sub, f) })); } catch { return []; } };
    const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
    const username = archiveUser(file);
    return {
      path: file, top, stagingDir: destDir, username,
      info: readJson(path.join(destDir, 'meta', 'info.json')),
      metadata: username ? readJson(path.join(destDir, 'cp', `${username}.json`)) : null,
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

defineOp('backup.db.restore_users', {
  description: 'Recreate database users (password hash, plugin and grants) exported in mysql/users.json; existing user@host rows are kept',
  schema: z.object({
    users: z.array(z.object({ user: mysqlUser, host: mysqlHost, plugin: z.string().regex(/^[A-Za-z0-9_]{0,64}$/).default(''), hashHex: z.string().regex(/^([A-Fa-f0-9]{2}){0,512}$/).default(''), grants: z.array(z.string().max(4096).regex(/^GRANT /i)).max(200).default([]) }).strict()).min(1).max(500),
    credentials,
  }).strict(),
  run: async ({ users, credentials: creds }, ctx) => {
    const [[version]] = await mysqlQuery('SELECT VERSION()', creds, ctx, { headers: false });
    const engine = /mariadb/i.test(version || '') ? 'mariadb' : 'mysql';
    const created = [];
    const skipped = [];
    const errors = [];
    for (const u of users) {
      try {
        const present = await mysqlQuery(`SELECT 1 FROM mysql.user WHERE User = ${q.str(u.user)} AND Host = ${q.str(u.host)}`, creds, ctx, { headers: false });
        if (present.length) { skipped.push(`${u.user}@${u.host}`); continue; }
        const { statements } = cloneUserStatements({ user: u.user, toHost: u.host, engine, plugin: u.plugin, hashHex: u.hashHex, grantLines: u.grants });
        await mysqlQuery(`${statements.map((s) => `${s};`).join('\n')}\nFLUSH PRIVILEGES;`, creds, ctx);
        created.push(`${u.user}@${u.host}`);
      } catch (err) {
        if (err.code === 'capability_missing') throw err;
        errors.push(`${u.user}@${u.host}: ${err.message}`);
      }
    }
    return { engine, created, skipped, errors };
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
const urlField = z.string().url().max(2048).refine((u) => /^https?:\/\//.test(u), 'http(s) URL required');
const nonEmpty = z.string().min(1).max(256).regex(/^[^\n\r\0]+$/);
const secretField = z.string().max(256).regex(/^[^\n\r\0]*$/);

export const destinationConfig = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), dir: arg.absPath }).strict(),
  z.object({ kind: z.literal('ftp'), host: hostField, port: z.number().int().min(1).max(65535).default(21), username: nonEmpty, password: secretField.default(''), path: remotePath.default(''), tls: z.boolean().default(false), insecure: z.boolean().default(false), passive: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal('sftp'), host: hostField, port: z.number().int().min(1).max(65535).default(22), username: nonEmpty, password: secretField.optional(), privateKey: z.string().max(16384).optional(), hostKeySha256: z.string().regex(/^[A-Za-z0-9+/=]{40,48}$/).optional(), path: remotePath.default(''), insecure: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('webdav'), url: urlField, username: nonEmpty.optional(), password: secretField.optional(), insecure: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('s3'), endpoint: urlField.optional(), region: z.string().regex(/^[a-z0-9-]{1,32}$/).default('us-east-1'), bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/), prefix: remotePath.default(''), accessKey: nonEmpty, secretKey: nonEmpty, pathStyle: z.boolean().default(false), insecure: z.boolean().default(false) }).strict(),
]);

const CURL_CODES = { 5: 'could not resolve proxy', 6: 'could not resolve host', 7: 'failed to connect', 9: 'access denied to the remote path', 19: 'file not found on the server', 22: 'the server returned an HTTP error', 25: 'upload failed (STOR/PUT refused)', 28: 'operation timed out', 35: 'TLS handshake failed', 51: 'TLS certificate verification failed', 60: 'TLS certificate could not be verified (enable "insecure" or install the CA)', 67: 'login denied', 78: 'the remote file does not exist', 79: 'SSH session error (host key or authentication)' };

function curlFailure(result, what) {
  const line = result.stderr.trim().split('\n').filter((l) => /^curl:/.test(l)).pop() || result.stderr.trim().split('\n').pop() || '';
  const reason = CURL_CODES[result.code] || `curl exited with status ${result.code}`;
  return new OpError('destination_failed', `${what}: ${reason}${line ? ` (${line.replace(/^curl: \(\d+\) /, '')})` : ''}`, { exitCode: result.code });
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
  if (config.kind === 'ftp') {
    all.push(`user = ${curlQuote(`${config.username}:${config.password}`)}`);
    if (config.tls) all.push('ssl-reqd');
    if (config.insecure) all.push('insecure');
    if (!config.passive) all.push('ftp-port = "-"');
    all.push('ftp-create-dirs');
  } else if (config.kind === 'sftp') {
    all.push(`user = ${curlQuote(`${config.username}:${config.password || ''}`)}`);
    if (config.privateKey) { const key = secretFile(dir, 'backup-sshkey', config.privateKey.endsWith('\n') ? config.privateKey : `${config.privateKey}\n`); cleanup.push(key); all.push(`key = ${curlQuote(key)}`); }
    if (config.hostKeySha256) all.push(`hostpubsha256 = ${curlQuote(config.hostKeySha256)}`);
    else if (config.insecure) all.push('insecure');
    all.push('ftp-create-dirs');
  } else if (config.kind === 'webdav') {
    if (config.username) all.push(`user = ${curlQuote(`${config.username}:${config.password || ''}`)}`, 'anyauth');
    if (config.insecure) all.push('insecure');
    all.push('fail', 'location');
  }
  const cnf = secretFile(dir, 'backup-curl', `${all.join('\n')}\n`);
  cleanup.push(cnf);
  try {
    const r = await exec('curl', ['-K', cnf], { allowFailure: true, timeoutMs: timeoutMs + 5000, maxBuffer: 64 * 1024 * 1024 });
    if (r.code !== 0) throw curlFailure(r, what);
    return r;
  } finally { for (const f of cleanup) unlinkQuiet(f); }
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
    const local = ctx.assertAllowedPath(file, 'read');
    if (!exists(local)) throw new OpError('not_found', `${file} does not exist`);
    const started = Date.now();
    const name = remoteName || path.basename(local);
    const result = await uploadTo(config, local, name, ctx);
    return { kind: config.kind, name, ...result, ms: Date.now() - started };
  },
});

defineOp('backup.destination.download', {
  description: 'Fetch an archive from a destination into a local directory',
  timeoutMs: 7_200_000,
  schema: z.object({ config: destinationConfig, remoteName: readableName, dest: arg.absPath }).strict(),
  run: async ({ config, remoteName, dest }, ctx) => {
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
  run: async ({ config }, ctx) => ({ kind: config.kind, archives: (await listRemote(config, ctx)).map((a) => ({ ...a, username: archiveUser(a.name) })) }),
});

defineOp('backup.destination.remove', {
  description: 'Delete an archive from a destination (retention pruning)',
  destructive: true,
  timeoutMs: 300_000,
  schema: z.object({ config: destinationConfig, remoteName: readableName }).strict(),
  run: async ({ config, remoteName }, ctx) => ({ kind: config.kind, name: remoteName, ...(await removeFrom(config, remoteName, ctx)) }),
});
