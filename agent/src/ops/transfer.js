import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import readline from 'node:readline';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { renderClientCnf, classifyMysqlError, PRIVILEGES, q } from './db.js';

// Transfers op family: everything the Transfer Tool, cpmove restores and the
// addon-domain conversion need from the host. Remote servers are reached over
// OpenSSH only (ssh/rsync argv, never a shell); the private key or password
// arrives decrypted from the panel for the duration of one call and lives in a
// 0600 file (key) or the SSHPASS environment of the child (password, via sshpass).
// The command run on the remote side is a shell string by nature of ssh, so
// every token is single-quoted and the program comes from a fixed allowlist.
// Every remote command is assembled by a purpose-specific op from constants and
// schema-validated arguments; no op runs caller-supplied argv remotely.

const KNOWN_HOSTS = '/var/lib/whm/transfers/known_hosts';
const TMP_PREFIX = path.join(os.tmpdir(), 'whm-transfer-');
const MARK = '__WHM_TRANSFER_MARK__';

const REMOTE_PROGRAMS = new Set(['cat', 'ls', 'getent', 'id', 'hostname', 'uname', 'command', 'test', 'stat', 'df', 'mysqldump', 'mysql', 'rm', 'echo']);
const CLIENT_BINS = ['mysql', 'mariadb'];
export const AUTH_PLUGINS = ['mysql_native_password', 'caching_sha2_password', 'sha256_password', 'ed25519'];
// crypt(3) hashes as found in /etc/shadow ($6$, $y$, $2b$, …): no ':' or whitespace can appear.
export const SHADOW_HASH = /^\$[A-Za-z0-9]{1,6}\$[A-Za-z0-9./$=+,-]{8,500}$/;

const remoteUser = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'SSH user: lowercase letters, digits, "_" or "-"');
const remoteHost = z.union([arg.hostname, arg.ipv6]);
const privateKey = z.string().max(16 * 1024).regex(/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\r?\n[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----\s*$/, 'Must be a PEM/OpenSSH private key');
const password = z.string().min(1).max(256).regex(/^[^\n\r\0]+$/, 'Password must be a single line');
const remotePath = z.string().regex(/^\/(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9._/@+-]{0,1023}$/, 'Remote path: absolute, letters, digits, ". _ / @ + -" and no ".."');
const linuxUser = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Username: lowercase letters, digits, "_" or "-"');
const dbName = z.string().regex(/^[a-z0-9_]{1,64}$/);
const dbPrefix = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const mysqlUser = z.string().regex(/^[a-z0-9_]{1,80}$/, 'Database user: lowercase letters, digits or "_"');
const mysqlHost = z.string().regex(/^[A-Za-z0-9%:][A-Za-z0-9.%:_-]{0,254}$/, 'Host: IP, hostname or wildcard');
// Native "*<SHA1>" hashes, hex literals (0x…) and the printable sha256/ed25519
// forms; nothing that could close a string literal.
const authHash = z.string().regex(/^(?:\*[0-9A-F]{40}|0x[0-9A-Fa-f]{2,1024}|\$[A-Za-z0-9./$+=]{8,300}|[A-Za-z0-9+/=]{20,100})$/, 'Unsupported password hash format');
const privilege = z.enum(PRIVILEGES);
const archiveName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(tar\.gz|tgz|tar)$/;
const memberPattern = z.string().regex(/^(?!-)(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9._*?/-]{1,512}$/, 'Archive member: letters, digits, ". _ - * ? /", no leading "-" and no ".."');

export const connection = z.object({
  host: remoteHost,
  port: z.number().int().min(1).max(65535).default(22),
  user: remoteUser.default('root'),
  password: password.optional(),
  privateKey: privateKey.optional(),
}).strict().refine((c) => Boolean(c.password) !== Boolean(c.privateKey), { message: 'Provide either a password or a private key', path: ['password'] });

const credentials = z.object({
  host: z.string().regex(/^[A-Za-z0-9.%:_-]{1,255}$/).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/).optional(),
  password: z.string().max(256).regex(/^[^\n\r\0]*$/).optional(),
  socket: arg.absPath.optional(),
}).strict().optional();

// POSIX single-quoting: the only characters that survive are the ones inside
// the quotes, so a username such as "a;rm -rf /" is one literal word remotely.
export const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export function remoteCommand(argv) {
  if (!argv.length) throw new OpError('invalid_args', 'Remote command is empty');
  if (!REMOTE_PROGRAMS.has(argv[0])) throw new OpError('refused', `"${argv[0]}" is not a program the transfer tool runs on remote servers`);
  return argv.map(shellQuote).join(' ');
}

function sshOptions(conn, keyFile) {
  const opts = ['-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`, '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30', '-o', 'LogLevel=ERROR', '-p', String(conn.port)];
  if (keyFile) opts.push('-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no', '-i', keyFile);
  else opts.push('-o', 'BatchMode=no', '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1');
  return opts;
}

// Runs fn with everything needed to spawn ssh/rsync for this connection and
// removes the key material afterwards. Password logins go through sshpass, which
// reads the secret from the SSHPASS variable so it never appears in argv.
async function withAuth(conn, fn) {
  if (!hasBinary('ssh')) throw new OpError('capability_missing', 'The OpenSSH client (ssh) is not installed on this server; install openssh-client (Debian/Ubuntu) or openssh-clients (RHEL)');
  if (conn.password && !hasBinary('sshpass')) throw new OpError('capability_missing', 'Password logins to remote servers need sshpass; install the sshpass package or authenticate with an SSH key');
  fs.mkdirSync(path.dirname(KNOWN_HOSTS), { recursive: true, mode: 0o700 });
  let dir = null;
  let keyFile = null;
  if (conn.privateKey) {
    dir = fs.mkdtempSync(TMP_PREFIX);
    fs.chmodSync(dir, 0o700);
    keyFile = path.join(dir, 'id_key');
    fs.writeFileSync(keyFile, conn.privateKey.endsWith('\n') ? conn.privateKey : `${conn.privateKey}\n`, { mode: 0o600 });
  }
  try {
    const options = sshOptions(conn, keyFile);
    const env = conn.password ? { SSHPASS: conn.password } : {};
    const ssh = conn.password ? { bin: 'sshpass', argv: ['-e', 'ssh', ...options] } : { bin: 'ssh', argv: options };
    const transport = [conn.password ? 'sshpass -e ssh' : 'ssh', ...options].join(' ');
    return await fn({ ssh, env, transport, destination: `${conn.user}@${conn.host}` });
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function classifySsh(code, stderr) {
  const text = String(stderr || '').trim();
  if (code === 255 || /Connection (refused|timed out|closed)|Could not resolve|No route to host|Permission denied|Host key verification failed|kex_exchange|Connection reset/i.test(text)) {
    if (/Permission denied/i.test(text)) return new OpError('ssh_auth_failed', `The remote server rejected the login: ${text.split('\n').pop()}`);
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return new OpError('ssh_hostkey_changed', `The host key of the remote server changed; remove its entry from ${KNOWN_HOSTS} if the server was reinstalled`);
    return new OpError('ssh_unreachable', `Could not connect to the remote server: ${text.split('\n').pop() || `ssh exited with status ${code}`}`);
  }
  if (code === 5 && /sshpass/i.test(text)) return new OpError('ssh_auth_failed', 'The remote server rejected the password');
  return null;
}

async function remoteExec(conn, command, { timeoutMs = 600_000, maxBuffer } = {}) {
  return withAuth(conn, async ({ ssh, env, destination }) => {
    const { code, stdout, stderr } = await exec(ssh.bin, [...ssh.argv, '--', destination, command], { env, timeoutMs, maxBuffer, allowFailure: true });
    const sshErr = classifySsh(code, stderr);
    if (sshErr) throw sshErr;
    return { code, stdout, stderr };
  });
}

// Fingerprints of the host keys recorded for a server, so the operator can
// compare them with the source machine after the first (trust-on-first-use)
// connection. Accepts the "-l -F" line form ("host TYPE SHA256:…") and the
// plain "-lf" form ("256 SHA256:… comment (TYPE)").
export function parseFingerprints(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    let m = line.match(/^\d+\s+(SHA256:[A-Za-z0-9+/=]+)\s.*\((\w+)\)\s*$/);
    if (m) { out.push({ type: m[2].toUpperCase(), fingerprint: m[1] }); continue; }
    m = line.match(/^\S+\s+(\S+)\s+(SHA256:[A-Za-z0-9+/=]+)/);
    if (m) out.push({ type: m[1].toUpperCase().replace(/^SSH-/, ''), fingerprint: m[2] });
  }
  return out;
}

async function hostKeysOf(conn) {
  if (!hasBinary('ssh-keygen') || !fs.existsSync(KNOWN_HOSTS)) return [];
  const spec = conn.port === 22 ? conn.host : `[${conn.host}]:${conn.port}`;
  try {
    const { code, stdout } = await exec('ssh-keygen', ['-l', '-F', spec, '-f', KNOWN_HOSTS], { timeoutMs: 30_000, allowFailure: true });
    return code === 0 ? parseFingerprints(stdout) : [];
  } catch { return []; }
}

export function parsePasswd(text, { minUid = 1000 } = {}) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const [username, , uid, gid, , home, shell] = line.split(':');
    if (!username || !/^[a-z][a-z0-9_-]{0,31}$/.test(username) || username === 'nobody') continue;
    if (Number(uid) < minUid) continue;
    out.push({ username, uid: Number(uid), gid: Number(gid), home: home || null, shell: shell || null });
  }
  return out;
}

// cPanel's /etc/userdomains lists "domain: user" (trueuserdomains has only the
// main domain of each user).
export function parseUserDomains(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([a-z0-9.-]+):\s*([a-z0-9_-]+)\s*$/i);
    if (m && m[1] !== '*') out.push({ domain: m[1].toLowerCase(), username: m[2] });
  }
  return out;
}

export function parseRsyncStats(stdout) {
  const num = (re) => { const m = String(stdout).match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
  return {
    files: num(/Number of (?:regular )?files(?: transferred)?: ([\d,]+)/),
    filesTransferred: num(/Number of (?:regular )?files transferred: ([\d,]+)/),
    totalBytes: num(/Total file size: ([\d,]+)/),
    transferredBytes: num(/Total transferred file size: ([\d,]+)/),
  };
}

// cpmove-<user>.tar.gz layout: <top>/cp/<user>, homedir/, mysql/<db>.sql,
// mysql.sql (grants), dnszones/<zone>.db, userdata/<domain>, addons, pds, sds2.
// The top directory becomes a tar argv element, so it must look like a name.
const TOP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function summarizeArchive(entries) {
  const names = entries.map((e) => e.replace(/^\.\//, ''));
  const tops = new Set(names.map((n) => n.split('/')[0]).filter(Boolean));
  const top = tops.size === 1 && TOP_NAME.test([...tops][0]) ? [...tops][0] : null;
  const rel = (n) => (top ? n.slice(top.length + 1) : n);
  const rels = names.map(rel).filter(Boolean);
  const cpUser = rels.find((r) => /^cp\/[a-z][a-z0-9_-]*$/.test(r))?.slice(3) || null;
  const username = cpUser || (top && top.match(/^cpmove-([a-z][a-z0-9_-]{0,31})$/)?.[1]) || (top && /^[a-z][a-z0-9_-]{0,31}$/.test(top) ? top : null);
  const databases = [...new Set(rels.filter((r) => /^mysql\/[a-z0-9_]+\.sql$/.test(r)).map((r) => r.slice(6, -4)))];
  const zones = [...new Set(rels.filter((r) => /^dnszones\/[a-z0-9.-]+\.db$/i.test(r)).map((r) => r.slice(9, -3).toLowerCase()))];
  const userdata = [...new Set(rels.filter((r) => /^userdata\/[a-z0-9.-]+$/i.test(r) && !/^userdata\/(main|cache)$/.test(r) && !/_SSL$/.test(r)).map((r) => r.slice(9).toLowerCase()))];
  return {
    top, username, databases, zones, userdata,
    hasHomedir: rels.some((r) => r === 'homedir' || r.startsWith('homedir/')),
    hasGrants: rels.includes('mysql.sql'),
    hasShadow: rels.includes('shadow'),
    hasAddons: rels.includes('addons'), hasParked: rels.includes('pds'), hasSubdomains: rels.includes('sds2') || rels.includes('sds'),
    hasCpConfig: Boolean(cpUser),
    version: rels.includes('version'),
  };
}

export function parseCpUserFile(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([A-Z0-9_-]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return {
    domain: out.DNS?.toLowerCase() || null, plan: out.PLAN || null, contactEmail: out.CONTACTEMAIL || null, ip: out.IP || null,
    owner: out.OWNER || null, maxDbs: out.MAXSQL ?? null, hasShell: out.HASSHELL === '1', raw: out,
  };
}

// A shadow entry's hash field: "!" prefixes mean the account is locked, a bare
// "*" / "!" / "!!" means no password was ever set.
export function parseShadowHash(username, field) {
  const raw = String(field || '').trim();
  const locked = /^!/.test(raw);
  const clean = raw.replace(/^!+/, '');
  const available = SHADOW_HASH.test(clean);
  return { username, hash: available ? clean : null, locked, available, reason: available ? null : locked ? 'the source account is locked' : 'no password hash on the source' };
}

function localPasswd(username) {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${username}:`));
    if (!line) return null;
    const [, , uid, gid, , home] = line.split(':');
    return { username, uid: Number(uid), gid: Number(gid), home };
  } catch { return null; }
}

// ---------------------------------------------------------------- remote ---

defineOp('transfer.remote.password_hash', {
  description: 'Read the password hash of a Linux user on a remote server (getent shadow) so a transferred account keeps its password',
  timeoutMs: 60_000,
  schema: z.object({ connection, username: linuxUser }).strict(),
  run: async ({ connection: conn, username }) => {
    const r = await remoteExec(conn, remoteCommand(['getent', 'shadow', '--', username]), { timeoutMs: 60_000 });
    if (r.code !== 0) return { username, hash: null, locked: false, available: false, reason: r.code === 2 ? 'no such user on the source' : 'the shadow database is not readable on the source (not root?)' };
    return parseShadowHash(username, r.stdout.split('\n')[0]?.split(':')[1]);
  },
});

defineOp('transfer.remote.probe', {
  description: 'Test an SSH connection and report the remote OS, tooling (rsync, mysqldump) and cPanel presence',
  timeoutMs: 120_000,
  schema: z.object({ connection }).strict(),
  run: async ({ connection: conn }) => {
    const parts = [
      ['hostname', '-f'], ['uname', '-r'], ['id', '-u'], ['hostname', '-I'],
      ['command', '-v', 'rsync'], ['command', '-v', 'mysqldump'], ['command', '-v', 'mysql'],
      ['test', '-d', '/var/cpanel/users'], ['cat', '/etc/os-release'], ['df', '-Pk', '/home'],
    ];
    // Each probe is a constant argv; the separators are constants too, so the
    // joined string carries no caller-supplied bytes.
    const command = parts.map((p) => `${remoteCommand(p)} 2>/dev/null; echo ${shellQuote(MARK)}$?`).join('; ');
    const { stdout } = await remoteExec(conn, command, { timeoutMs: 120_000 });
    const sections = stdout.split(new RegExp(`${MARK}(\\d+)\\n?`)).slice(0, -1);
    const out = [];
    for (let i = 0; i + 1 < sections.length; i += 2) out.push({ text: sections[i].trim(), code: Number(sections[i + 1]) });
    const get = (i) => out[i] || { text: '', code: 1 };
    const osRelease = Object.fromEntries(get(8).text.split('\n').map((l) => l.split('=')).filter((kv) => kv.length === 2).map(([k, v]) => [k, v.replace(/^"|"$/g, '')]));
    const df = get(9).text.split('\n').pop()?.trim().split(/\s+/) || [];
    return {
      ok: true,
      hostKeys: await hostKeysOf(conn),
      hostname: get(0).text || conn.host,
      kernel: get(1).text || null,
      uid: get(2).code === 0 ? Number(get(2).text) : null,
      isRoot: get(2).text === '0',
      addresses: get(3).text.split(/\s+/).filter(Boolean),
      tools: { rsync: get(4).code === 0, mysqldump: get(5).code === 0, mysql: get(6).code === 0 },
      cpanel: get(7).code === 0,
      os: { id: osRelease.ID || null, name: osRelease.PRETTY_NAME || osRelease.NAME || null, version: osRelease.VERSION_ID || null },
      homeDisk: df.length >= 4 ? { sizeBytes: Number(df[1]) * 1024, usedBytes: Number(df[2]) * 1024, availableBytes: Number(df[3]) * 1024 } : null,
    };
  },
});

defineOp('transfer.remote.list_accounts', {
  description: 'Enumerate hosting accounts on a remote server (/etc/passwd uid >= 1000 plus cPanel domain maps and /home listing)',
  timeoutMs: 120_000,
  schema: z.object({ connection, minUid: z.number().int().min(0).max(65535).default(1000) }).strict(),
  run: async ({ connection: conn, minUid }) => {
    const parts = [['cat', '/etc/passwd'], ['cat', '/etc/trueuserdomains'], ['cat', '/etc/userdomains'], ['ls', '-1', '/home']];
    const command = parts.map((p) => `${remoteCommand(p)} 2>/dev/null; echo ${shellQuote(MARK)}`).join('; ');
    const { stdout } = await remoteExec(conn, command, { timeoutMs: 120_000 });
    const [passwd = '', trueDomains = '', userDomains = '', homes = ''] = stdout.split(`${MARK}\n`);
    const users = parsePasswd(passwd, { minUid });
    const mains = new Map(parseUserDomains(trueDomains).map((d) => [d.username, d.domain]));
    const all = parseUserDomains(userDomains);
    const homeDirs = new Set(homes.split('\n').map((s) => s.trim()).filter(Boolean));
    return {
      cpanel: mains.size > 0,
      accounts: users.map((u) => ({
        ...u,
        domain: mains.get(u.username) || null,
        domains: all.filter((d) => d.username === u.username && d.domain !== mains.get(u.username)).map((d) => d.domain),
        homeListed: homeDirs.has(u.username),
      })),
    };
  },
});

defineOp('transfer.remote.read_file', {
  description: 'Read a file from a remote server over ssh (zone files, cPanel user configs)',
  timeoutMs: 120_000,
  schema: z.object({ connection, path: remotePath, maxBytes: z.number().int().min(1).max(8 * 1024 * 1024).default(1024 * 1024) }).strict(),
  run: async ({ connection: conn, path: file, maxBytes }) => {
    const result = await remoteExec(conn, remoteCommand(['cat', '--', file]), { timeoutMs: 120_000, maxBuffer: maxBytes + 65536 });
    if (result.code !== 0) return { path: file, exists: false, content: null };
    return { path: file, exists: true, content: result.stdout.length > maxBytes ? result.stdout.slice(0, maxBytes) : result.stdout, truncated: result.stdout.length > maxBytes };
  },
});

defineOp('transfer.remote.databases', {
  description: 'List MySQL databases on a remote server whose name starts with "<prefix>_" (remote root .my.cnf credentials)',
  timeoutMs: 120_000,
  schema: z.object({ connection, prefix: dbPrefix, defaultsFile: remotePath.optional() }).strict(),
  run: async ({ connection: conn, prefix, defaultsFile }) => {
    const argv = ['mysql'];
    if (defaultsFile) argv.push(`--defaults-extra-file=${defaultsFile}`);
    argv.push('-N', '-B', '-e', `SHOW DATABASES LIKE '${prefix}\\_%'`);
    const result = await remoteExec(conn, remoteCommand(argv), { timeoutMs: 120_000 });
    if (result.code !== 0) {
      const err = classifyMysqlError(result.stderr);
      if (/not found|No such file/i.test(result.stderr) && !/^ERROR/.test(result.stderr.trim())) throw new OpError('remote_tool_missing', 'The mysql client is not installed on the remote server');
      throw new OpError(err.code === 'db_error' ? 'remote_command_failed' : `remote_${err.code}`, `Remote MySQL: ${err.message}`);
    }
    return { prefix, databases: result.stdout.split('\n').map((s) => s.trim()).filter((s) => /^[a-z0-9_]{1,64}$/.test(s)) };
  },
});

defineOp('transfer.remote.db_grants', {
  description: 'CREATE USER / GRANT statements for the remote MySQL users of an account prefix, for replay on this server',
  timeoutMs: 300_000,
  schema: z.object({ connection, prefix: dbPrefix, defaultsFile: remotePath.optional() }).strict(),
  run: async ({ connection: conn, prefix, defaultsFile }) => {
    const base = ['mysql'];
    if (defaultsFile) base.push(`--defaults-extra-file=${defaultsFile}`);
    const list = await remoteExec(conn, remoteCommand([...base, '-N', '-B', '-e', `SELECT user, host FROM mysql.user WHERE user LIKE '${prefix}\\_%' OR user = '${prefix}'`]), { timeoutMs: 120_000 });
    if (list.code !== 0) throw new OpError('remote_command_failed', `Remote MySQL: ${classifyMysqlError(list.stderr).message}`);
    const users = list.stdout.split('\n').map((l) => l.split('\t')).filter((c) => c.length === 2 && /^[A-Za-z0-9_.-]{1,80}$/.test(c[0]) && /^[A-Za-z0-9.%:_-]{1,255}$/.test(c[1]));
    const out = [];
    for (const [user, host] of users) {
      const account = `'${user}'@'${host}'`;
      const r = await remoteExec(conn, remoteCommand([...base, '-N', '-B', '-e', `SHOW CREATE USER ${account}; SHOW GRANTS FOR ${account}`]), { timeoutMs: 120_000 });
      if (r.code !== 0) { out.push({ user, host, error: classifyMysqlError(r.stderr).message, statements: [] }); continue; }
      const statements = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).filter((s) => /^(CREATE USER|GRANT) /i.test(s));
      out.push({ user, host, statements });
    }
    return { prefix, users: out };
  },
});

defineOp('transfer.remote.dump_database', {
  description: 'mysqldump a remote database to a file under /tmp on the remote server (fetched with transfer.remote.rsync, removed with transfer.remote.remove_file)',
  timeoutMs: 7_200_000,
  schema: z.object({ connection, database: dbName, defaultsFile: remotePath.optional(), timeoutMs: z.number().int().min(10_000).max(7_200_000).default(3_600_000) }).strict(),
  run: async ({ connection: conn, database, defaultsFile, timeoutMs }) => {
    const remoteFile = `/tmp/whm-transfer-${database}-${crypto.randomBytes(4).toString('hex')}.sql`;
    const argv = ['mysqldump'];
    if (defaultsFile) argv.push(`--defaults-extra-file=${defaultsFile}`);
    // MySQL's mysqldump adds SET @@GLOBAL.GTID_PURGED / SQL_LOG_BIN statements
    // on GTID-enabled servers; the import runs without the privileges for them
    // (and must not alter GTID state). MariaDB's mysqldump has no such option.
    const help = await remoteExec(conn, remoteCommand(['mysqldump', '--help']), { timeoutMs: 60_000, maxBuffer: 4 * 1024 * 1024 });
    if (/--set-gtid-purged/.test(help.stdout)) argv.push('--set-gtid-purged=OFF');
    argv.push('--single-transaction', '--quick', '--routines', '--triggers', '--events', `--result-file=${remoteFile}`, '--', database);
    const dump = await remoteExec(conn, remoteCommand(argv), { timeoutMs });
    if (dump.code !== 0) {
      await remoteExec(conn, remoteCommand(['rm', '-f', '--', remoteFile]), { timeoutMs: 60_000 }).catch(() => {});
      if (/not found|No such file/i.test(dump.stderr) && !/^mysqldump:/.test(dump.stderr.trim())) throw new OpError('remote_tool_missing', 'mysqldump is not installed on the remote server');
      throw new OpError('remote_command_failed', `Remote mysqldump: ${classifyMysqlError(dump.stderr).message}`);
    }
    const stat = await remoteExec(conn, remoteCommand(['stat', '-c', '%s', '--', remoteFile]), { timeoutMs: 60_000 });
    return { database, remotePath: remoteFile, sizeBytes: stat.code === 0 ? Number(stat.stdout.trim()) || 0 : null };
  },
});

defineOp('transfer.remote.remove_file', {
  description: 'Remove a temporary dump the transfer tool created under /tmp on the remote server',
  destructive: true,
  timeoutMs: 60_000,
  schema: z.object({ connection, path: remotePath.refine((p) => /^\/tmp\/whm-transfer-[A-Za-z0-9_.-]+$/.test(p), 'Only files the transfer tool created under /tmp can be removed') }).strict(),
  run: async ({ connection: conn, path: file }) => {
    const r = await remoteExec(conn, remoteCommand(['rm', '-f', '--', file]), { timeoutMs: 60_000 });
    return { path: file, removed: r.code === 0 };
  },
});

// Modes are preserved (-p) so 0600 credential files and 0700 directories stay
// private and scripts keep their execute bit; ownership is reassigned afterwards.
// Device and special files are never recreated (no -D): the copy runs as root
// and the tree is handed to the account afterwards.
// rsync splits "user@host:path" at the first ':', so an IPv6 host is bracketed.
export function rsyncArgv({ transport, destination, src, dest, directory = true, excludes = [], deleteExtraneous = false, bwlimitKbps = 0, dryRun = false }) {
  const argv = ['-rlpt', '-z', '--partial', '--stats', '--no-human-readable', '-e', transport];
  if (deleteExtraneous) argv.push('--delete');
  if (bwlimitKbps) argv.push(`--bwlimit=${bwlimitKbps}`);
  if (dryRun) argv.push('--dry-run');
  for (const ex of excludes) argv.push(`--exclude=${ex}`);
  const remote = destination.includes(':') ? destination.replace(/^([^@]*@)?(.*)$/, '$1[$2]') : destination;
  const from = directory ? `${remote}:${src.replace(/\/+$/, '')}/` : `${remote}:${src}`;
  const to = directory ? `${dest.replace(/\/+$/, '')}/` : dest;
  argv.push(from, to);
  return argv;
}

defineOp('transfer.remote.rsync', {
  description: 'Copy a directory or file from a remote server with rsync over ssh into an allowed local path',
  timeoutMs: 86_400_000,
  schema: z.object({
    connection,
    remotePath,
    localPath: arg.absPath,
    directory: z.boolean().default(true),
    excludes: z.array(z.string().regex(/^(?!-)[A-Za-z0-9._*?/-]{1,200}$/)).max(50).default([]),
    deleteExtraneous: z.boolean().default(false),
    bwlimitKbps: z.number().int().min(0).max(10_000_000).default(0),
    dryRun: z.boolean().default(false),
    timeoutMs: z.number().int().min(10_000).max(86_400_000).default(43_200_000),
  }).strict(),
  run: async ({ connection: conn, remotePath: src, localPath, directory, excludes, deleteExtraneous, bwlimitKbps, dryRun, timeoutMs }, ctx) => {
    if (!hasBinary('rsync')) throw new OpError('capability_missing', 'rsync is not installed on this server; install the rsync package');
    const dest = ctx.assertAllowedPath(localPath, 'write');
    if (directory) fs.mkdirSync(dest, { recursive: true });
    else fs.mkdirSync(path.dirname(dest), { recursive: true });
    return withAuth(conn, async ({ env, transport, destination }) => {
      const argv = rsyncArgv({ transport, destination, src, dest, directory, excludes, deleteExtraneous, bwlimitKbps, dryRun });
      const { code, stdout, stderr } = await exec('rsync', argv, { env, timeoutMs, allowFailure: true });
      const sshErr = classifySsh(code === 255 ? 255 : 0, stderr);
      if (sshErr) throw sshErr;
      // 23/24 = some files vanished or could not be read; the copy itself is usable.
      if (code !== 0 && code !== 23 && code !== 24) throw new OpError('rsync_failed', `rsync exited with status ${code}: ${stderr.trim().split('\n').pop() || 'no error output'}`, { code });
      return { from: src, to: dest, code, partial: code !== 0, dryRun, ...parseRsyncStats(stdout) };
    });
  },
});

// ---------------------------------------------------------------- cpmove ---

function requireTar() {
  if (!hasBinary('tar')) throw new OpError('capability_missing', 'tar is not installed on this server');
}

function assertArchive(ctx, file) {
  const resolved = ctx.assertAllowedPath(file, 'read');
  if (!archiveName.test(path.basename(resolved))) throw new OpError('refused', `${path.basename(resolved)} is not a .tar.gz / .tgz / .tar archive`);
  let st;
  try { st = fs.lstatSync(resolved); } catch { throw new OpError('not_found', `${file} does not exist`); }
  if (st.isSymbolicLink() || !st.isFile()) throw new OpError('refused', `${file} is not a regular file`);
  return { resolved, size: st.size, mtime: st.mtime.toISOString() };
}

defineOp('transfer.cpmove.inspect', {
  description: 'Inspect a cpmove / pkgacct archive: account name, databases, zones, userdata and whether a homedir is present',
  timeoutMs: 3_600_000,
  schema: z.object({ path: arg.absPath, maxEntries: z.number().int().min(100).max(1_000_000).default(200_000) }).strict(),
  run: async ({ path: file, maxEntries }, ctx) => {
    requireTar();
    const { resolved, size, mtime } = assertArchive(ctx, file);
    // Only the metadata members are listed; --no-recursion keeps tar from
    // expanding the matched homedir/ directory into every file below it, so the
    // output stays small for multi-gigabyte accounts (homedir is detected by its
    // directory entry).
    const patterns = ['*/cp/*', '*/mysql/*', '*/mysql.sql', '*/shadow', '*/dnszones/*', '*/userdata/*', '*/homedir', '*/addons', '*/pds', '*/sds', '*/sds2', '*/version', '*/meta/*'];
    const argv = ['-tf', resolved, '--wildcards', '--no-anchored', '--no-recursion', ...patterns];
    const { code, stdout, stderr } = await exec('tar', argv, { timeoutMs: 3_600_000, allowFailure: true, maxBuffer: 64 * 1024 * 1024 });
    const entries = stdout.split('\n').map((s) => s.replace(/\/$/, '')).filter(Boolean).slice(0, maxEntries);
    if (code !== 0 && !entries.length) {
      if (/not in gzip format|Unexpected EOF|does not look like a tar archive|not recoverable/i.test(stderr)) throw new OpError('invalid_archive', `${path.basename(resolved)} is not a readable tar archive: ${stderr.trim().split('\n')[0]}`);
      if (!/Not found in archive/i.test(stderr)) throw new OpError('invalid_archive', `tar could not read ${path.basename(resolved)}: ${stderr.trim().split('\n').pop() || `status ${code}`}`);
    }
    const summary = summarizeArchive(entries);
    let cp = null;
    if (summary.hasCpConfig && summary.top) {
      const r = await exec('tar', ['-xOf', resolved, '--', `${summary.top}/cp/${summary.username}`], { timeoutMs: 3_600_000, allowFailure: true, maxBuffer: 4 * 1024 * 1024 });
      if (r.code === 0) cp = parseCpUserFile(r.stdout);
    }
    if (!summary.top || !summary.username) throw new OpError('invalid_archive', `${path.basename(resolved)} does not look like a cPanel account archive (expected a single cpmove-<user>/ or <user>/ top-level directory)`);
    return { path: resolved, sizeBytes: size, mtime, ...summary, config: cp, entries: entries.length, sample: entries.slice(0, 50) };
  },
});

defineOp('transfer.cpmove.read_member', {
  description: 'Read one text member of an account archive (cp config, zone file, userdata, addons list)',
  timeoutMs: 3_600_000,
  schema: z.object({ path: arg.absPath, member: memberPattern, maxBytes: z.number().int().min(1).max(32 * 1024 * 1024).default(4 * 1024 * 1024) }).strict(),
  run: async ({ path: file, member, maxBytes }, ctx) => {
    requireTar();
    const { resolved } = assertArchive(ctx, file);
    const { code, stdout, stderr } = await exec('tar', ['-xOf', resolved, '--wildcards', '--no-anchored', '--', member], { timeoutMs: 3_600_000, allowFailure: true, maxBuffer: maxBytes + 65536 });
    if (code !== 0 && !stdout) {
      if (/Not found in archive/i.test(stderr)) return { member, exists: false, content: null };
      throw new OpError('invalid_archive', `tar could not read ${member}: ${stderr.trim().split('\n').pop() || `status ${code}`}`);
    }
    return { member, exists: true, content: stdout.slice(0, maxBytes), truncated: stdout.length > maxBytes };
  },
});

// One line of "tar --numeric-owner -tvf": mode, uid/gid, size (or
// "major,minor" for devices), date, time, name ("name -> target" for
// symlinks, "name link to target" for hard links). The first character of
// the mode is the member type. The owner column is pinned to digits because
// the archive's own uname/gname (which may contain spaces) would otherwise
// shift the columns; a line that does not fit is a refusal, never a skip,
// so the screen cannot be bypassed by a member it cannot read.
const LISTING_LINE = /^([-bcdlhps?])[-rwxsStTX]{9}\s+\d+\/\d+\s+\S+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.*)$/;
export const LISTING_ARGV = ['--numeric-owner', '-tvf'];

export function parseTarListing(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(LISTING_LINE);
    if (!m) throw new OpError('invalid_archive', `listing line could not be parsed, so the archive cannot be screened before extraction: ${line.slice(0, 120)}`);
    let name = m[2];
    let link = null;
    const type = m[1];
    if (type === 'l') { const at = name.lastIndexOf(' -> '); if (at >= 0) { link = name.slice(at + 4); name = name.slice(0, at); } }
    else if (type === 'h') { const at = name.lastIndexOf(' link to '); if (at >= 0) { link = name.slice(at + 9); name = name.slice(0, at); } }
    out.push({ type, name, link });
  }
  return out;
}

// Why a listed member must not be extracted as root into an account's tree:
// device nodes would be handed to the account by the chown that follows,
// absolute or ".." names would land outside the destination.
export function unsafeMember(entry) {
  if (entry.type === 'b' || entry.type === 'c') return `"${entry.name}" is a ${entry.type === 'b' ? 'block' : 'character'} device node`;
  const name = entry.name.replace(/^\.\//, '');
  if (name.startsWith('/')) return `"${entry.name}" has an absolute path`;
  if (name.split('/').includes('..')) return `"${entry.name}" contains ".."`;
  return null;
}

defineOp('transfer.cpmove.extract', {
  description: 'Extract members of an account archive into an allowed directory (homedir into the new home, dumps into staging) after refusing device nodes and absolute/".." members',
  timeoutMs: 86_400_000,
  schema: z.object({
    path: arg.absPath,
    destination: arg.absPath,
    members: z.array(memberPattern).min(1).max(100),
    stripComponents: z.number().int().min(0).max(10).default(0),
    owner: arg.username.optional(),
  }).strict(),
  run: async ({ path: file, destination, members, stripComponents, owner }, ctx) => {
    requireTar();
    const { resolved } = assertArchive(ctx, file);
    const dest = ctx.assertAllowedPath(destination, 'write');
    // The same member selection is listed first; anything tar would recreate
    // as a device node or outside the destination refuses the whole extraction.
    let listing;
    try {
      listing = await exec('tar', [...LISTING_ARGV, resolved, '--wildcards', '--no-anchored', '--', ...members], { timeoutMs: 86_400_000, allowFailure: true, maxBuffer: 256 * 1024 * 1024 });
    } catch (err) {
      if (err.code === 'spawn_failed' && /maxBuffer/i.test(err.message)) throw new OpError('refused', `${path.basename(resolved)} lists too many members to screen before extraction; extract it by hand`);
      throw err;
    }
    if (listing.code !== 0 && !listing.stdout.trim()) {
      if (/Not found in archive/i.test(listing.stderr)) return { destination: dest, extracted: false, members };
      throw new OpError('invalid_archive', `tar could not read ${path.basename(resolved)}: ${listing.stderr.trim().split('\n').pop() || `status ${listing.code}`}`);
    }
    const entries = parseTarListing(listing.stdout);
    const unsafe = entries.map(unsafeMember).filter(Boolean);
    if (unsafe.length) throw new OpError('invalid_archive', `${path.basename(resolved)} contains members that must not be extracted as root: ${unsafe.slice(0, 3).join('; ')}${unsafe.length > 3 ? ` (+${unsafe.length - 3} more)` : ''}`);
    fs.mkdirSync(dest, { recursive: true });
    // GNU tar drops leading "/" and refuses ".." members by default; the
    // ownership from the archive is discarded and reapplied for the new user.
    const argv = ['-xf', resolved, '-C', dest, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir', `--strip-components=${stripComponents}`, '--wildcards', '--no-anchored', '--', ...members];
    const { code, stderr } = await exec('tar', argv, { timeoutMs: 86_400_000, allowFailure: true });
    if (code !== 0) {
      if (/Not found in archive/i.test(stderr)) return { destination: dest, extracted: false, members };
      throw new OpError('extract_failed', `tar exited with status ${code}: ${stderr.trim().split('\n').pop() || 'no error output'}`);
    }
    if (owner) await exec('chown', ['-R', `${owner}:${owner}`, '--', dest], { timeoutMs: 3_600_000 });
    return { destination: dest, extracted: true, members, owner: owner || null };
  },
});

// ------------------------------------------------------------- mysql/upload ---

function findClient() {
  return CLIENT_BINS.find(hasBinary) || null;
}

// Runs fn(defaultsArgv) with the credentials in a short-lived 0600 option file
// (or /root/.my.cnf when none were given). `exclusive` makes that file the
// only option file the client reads.
async function withClientDefaults(creds, fn, { exclusive = false } = {}) {
  let dir = null;
  const defaults = [];
  if (creds && Object.keys(creds).length) {
    dir = fs.mkdtempSync(TMP_PREFIX);
    fs.chmodSync(dir, 0o700);
    const cnf = path.join(dir, 'client.cnf');
    fs.writeFileSync(cnf, renderClientCnf(creds), { mode: 0o600 });
    defaults.push(`${exclusive ? '--defaults-file' : '--defaults-extra-file'}=${cnf}`);
  } else if (fs.existsSync('/root/.my.cnf')) defaults.push('--defaults-extra-file=/root/.my.cnf');
  try { return await fn(defaults); } finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
}

async function runSql(bin, sql, creds, { timeoutMs = 120_000 } = {}) {
  return withClientDefaults(creds, async (defaults) => {
    const { code, stdout, stderr } = await exec(bin, [...defaults, '--batch', '--skip-column-names', '--no-auto-rehash', '--connect-timeout=10'], { input: `${sql}\n`, timeoutMs, allowFailure: true });
    if (code !== 0) {
      const err = classifyMysqlError(stderr);
      throw new OpError(err.code, `mysql: ${err.message}`, { errno: err.errno });
    }
    return stdout;
  });
}

const belongsTo = (name, prefix) => name === prefix || name.startsWith(`${prefix}_`);
const SYSTEM_SCHEMAS = new Set(['mysql', 'sys', 'information_schema', 'performance_schema']);

// Statements a dump of one account's database never needs. The import runs as
// a temporary user limited to the target database, so the server refuses them
// too; this pre-check gives a readable reason before anything is loaded.
// Conditional comments (/*!50106 …*/) are stripped before matching, so hiding
// a statement in one does not help.
const DENIED_SQL = [
  [/\b(?:CREATE|DROP|ALTER|RENAME)\s+(?:OR\s+REPLACE\s+)?(?:USER|ROLE)\b/i, 'user or role management'],
  [/\bGRANT\s+[A-Z_ ,()*]+?\s+ON\s+/i, 'GRANT'],
  [/\bGRANT\s+(?:PROXY|`|')/i, 'GRANT'],
  [/\bREVOKE\s+[A-Z_ ,()*]+?\s+(?:ON|FROM)\s+/i, 'REVOKE'],
  [/\bSET\s+(?:DEFAULT\s+)?ROLE\b/i, 'SET ROLE'],
  [/\bGTID_PURGED\b|\bGTID_NEXT\b|\bSQL_LOG_BIN\b/i, 'GTID and binary-log', ' (export the source with --set-gtid-purged=OFF)'],
  [/\bSET\s+(?:GLOBAL|PERSIST|PERSIST_ONLY)\b|@@\s*(?:GLOBAL|PERSIST|PERSIST_ONLY)\s*\./i, 'SET GLOBAL'],
  [/\bSET\s+PASSWORD\b/i, 'SET PASSWORD'],
  [/\bDROP\s+(?:DATABASE|SCHEMA)\b/i, 'DROP DATABASE'],
  [/\b(?:INSTALL|UNINSTALL)\s+(?:PLUGIN|COMPONENT|SONAME)\b/i, 'plugin installation'],
  [/\bSONAME\s+['"]/i, 'loadable function (SONAME)'],
  [/\bLOAD\s+(?:DATA|XML)\s+(?:LOW_PRIORITY\s+|CONCURRENT\s+)?(?:LOCAL\s+)?INFILE\b/i, 'LOAD DATA / LOAD XML INFILE'],
  [/\bINTO\s+(?:OUTFILE|DUMPFILE)\s+['"]/i, 'SELECT INTO OUTFILE'],
  [/\bLOAD_FILE\s*\(/i, 'LOAD_FILE()'],
  [/\bIMPORT\s+TABLE\s+FROM\b/i, 'IMPORT TABLE'],
  [/\b(?:DATA|INDEX)\s+DIRECTORY\s*=/i, 'DATA DIRECTORY / INDEX DIRECTORY'],
  [/\b(?:CREATE|ALTER|DROP)\s+(?:UNDO\s+)?TABLESPACE\b|\b(?:CREATE|ALTER|DROP)\s+LOGFILE\s+GROUP\b/i, 'TABLESPACE'],
  [/\bALTER\s+INSTANCE\b|\bCLONE\s+(?:LOCAL|INSTANCE)\b|\bRESTART\s*;|\bSHUTDOWN\s*;/i, 'server instance'],
  [/\b(?:CREATE|ALTER|DROP)\s+(?:SERVER|RESOURCE\s+GROUP)\b|\bSET\s+RESOURCE\s+GROUP\b/i, 'CREATE SERVER / RESOURCE GROUP'],
  [/\bENGINE\s*=\s*(?:FEDERATED|FEDERATEDX|CONNECT|SPIDER)\b|\bCONNECTION\s*=\s*['"]/i, 'remote or file-backed storage engine'],
  [/\bFLUSH\s+(?:PRIVILEGES|HOSTS|USER_RESOURCES|LOGS|BINARY|ENGINE|ERROR|GENERAL|SLOW|TABLES\s+WITH\s+READ\s+LOCK)\b/i, 'FLUSH'],
  [/\bCHANGE\s+(?:MASTER|REPLICATION\s+SOURCE|REPLICATION\s+FILTER)\s+TO\b|\b(?:START|STOP|RESET)\s+(?:REPLICA|SLAVE|GROUP_REPLICATION|MASTER|PERSIST)\b|\bPURGE\s+(?:BINARY|MASTER)\s+LOGS\b|\bBINLOG\s+['"]/i, 'replication'],
  [/\bKILL\s+(?:QUERY\s+|CONNECTION\s+)?\d/i, 'KILL'],
];
// References to the privilege tables and other schemas. Only the direct
// target of a DML/DDL statement is checked here (aliases make "x.y" ambiguous
// elsewhere); the server enforces the rest through the import user's grants.
const SYSTEM_SCHEMA_REF = /(?:^|[^A-Za-z0-9_$.`'"@])`?(mysql|sys|performance_schema)`?\s*\.\s*`?[A-Za-z0-9_$*]/i;
const QUALIFIED = '`?[A-Za-z0-9_$]+`?\\s*\\.\\s*`?[A-Za-z0-9_$]+`?';
const QUALIFIED_PAIR = /(?:^|[^A-Za-z0-9_$.`'"@])`?([A-Za-z0-9_$]+)`?\s*\.\s*`?([A-Za-z0-9_$]+)`?/g;
const TARGET_CLAUSES = [
  new RegExp(`\\bINSERT(?:\\s+(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE))*\\s+(?:INTO\\s+)?(${QUALIFIED})`, 'gi'),
  new RegExp(`\\bREPLACE(?:\\s+(?:LOW_PRIORITY|DELAYED))?\\s+(?:INTO\\s+)?(${QUALIFIED})`, 'gi'),
  new RegExp(`\\bUPDATE\\s+(?:LOW_PRIORITY\\s+)?(?:IGNORE\\s+)?(${QUALIFIED})`, 'gi'),
  new RegExp(`\\bDELETE\\s+(?:LOW_PRIORITY\\s+|QUICK\\s+|IGNORE\\s+)*FROM\\s+(${QUALIFIED})`, 'gi'),
  new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?(${QUALIFIED})`, 'gi'),
  new RegExp(`\\b(?:CREATE|ALTER)\\s+(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`, 'gi'),
  /\bDROP\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+EXISTS\s+)?([^;]{0,2000})/gi,
  /\bRENAME\s+TABLE\s+([^;]{0,2000})/gi,
  /\bLOCK\s+TABLES?\s+([^;]{0,2000})/gi,
  new RegExp(`\\b(?:CREATE|ALTER|DROP)\\b[^;]{0,200}?\\bVIEW\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(${QUALIFIED})`, 'gi'),
  new RegExp(`\\bTRIGGER\\s+\`?[A-Za-z0-9_$]+\`?\\s+(?:BEFORE|AFTER)\\s+(?:INSERT|UPDATE|DELETE)\\s+ON\\s+(${QUALIFIED})`, 'gi'),
  new RegExp(`\\bINDEX\\s+\`?[A-Za-z0-9_$]+\`?\\s+(?:USING\\s+\\w+\\s+)?ON\\s+(${QUALIFIED})`, 'gi'),
  new RegExp(`\\b(?:PROCEDURE|FUNCTION|EVENT)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(${QUALIFIED})`, 'gi'),
  new RegExp(`\\bCALL\\s+(${QUALIFIED})`, 'gi'),
];

function foreignSchema(code, database) {
  const sys = code.match(SYSTEM_SCHEMA_REF);
  if (sys) return `the dump references the system schema "${sys[1].toLowerCase()}"`;
  for (const re of TARGET_CLAUSES) {
    for (const m of code.matchAll(re)) {
      for (const p of m[1].matchAll(QUALIFIED_PAIR)) {
        if (!database || p[1].toLowerCase() !== database) return `the dump targets "${p[1]}.${p[2]}" outside database "${database || 'the target database'}"`;
      }
    }
  }
  return null;
}

// The mysql client runs its own commands from a dump: "system <cmd>" / "\! <cmd>"
// start a shell as the user running the client, "tee" / "\T" write to any file,
// "source", "pager", "connect" … likewise. Long forms are recognised when they
// are the first word of a statement (find_command() on the line, or on the
// buffer at every delimiter); short forms "\x" anywhere outside strings and
// comments. This mirrors that tokenisation and refuses every command except a
// plain DELIMITER switch and USE of the target database.
const CLIENT_COMMANDS = new Map([
  ['?', true], ['clear', false], ['connect', true], ['delimiter', true], ['edit', false], ['ego', false], ['exit', false], ['go', false], ['help', true],
  ['nopager', false], ['notee', false], ['pager', true], ['print', false], ['prompt', true], ['quit', false], ['rehash', false], ['source', true],
  ['status', false], ['system', true], ['tee', true], ['use', true], ['charset', true], ['warnings', false], ['nowarning', false],
  ['resetconnection', false], ['query_attributes', true], ['ssl_session_data_print', true],
]);
const DELIMITER_TOKEN = /^[;$|/]{1,4}$/;

export function clientCommand(text) {
  const name = text.replace(/^\s+/, '');
  const m = name.match(/^([^ \t]+)(?:[ \t]+([\s\S]*))?$/);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const takesParams = CLIENT_COMMANDS.get(word);
  if (takesParams === undefined) return null;
  const args = (m[2] || '').replace(/^\s+/, '');
  if (args && !takesParams) return null;
  return { name: word, args };
}

export function createClientCommandGuard({ database } = {}) {
  let delimiter = ';';
  let stmt = '';
  const handle = (com) => {
    if (com.name === 'delimiter') {
      const next = com.args.split(/\s+/)[0] || '';
      if (!DELIMITER_TOKEN.test(next)) return `the dump sets the statement delimiter to "${next}"; only ";", "$$", "//" and the like are allowed`;
      delimiter = next;
      return null;
    }
    if (com.name === 'use') {
      const db = com.args.replace(/[`'"]/g, '').split(/\s/)[0] || '';
      return !database || db !== database ? `the dump switches to database "${db}" (only ${database || 'the target database'} may be used)` : null;
    }
    return `the dump contains the mysql client command "${com.name}", which the client would run outside SQL`;
  };
  return function feed(code) {
    if (/\\(?![N\n]|$)/.test(code)) return 'the dump contains a backslash command ("\\!", "\\T", "\\." …) that the mysql client would run outside SQL';
    if (!stmt.trim() && (!code.includes(delimiter) || /^\s*delimiter\b/i.test(code))) {
      const com = clientCommand(code);
      if (com) return handle(com);
    }
    let rest = code;
    let at;
    while ((at = rest.indexOf(delimiter)) >= 0) {
      stmt += rest.slice(0, at);
      const com = clientCommand(stmt);
      if (com) { const reason = handle(com); if (reason) return reason; }
      stmt = '';
      rest = rest.slice(at + delimiter.length);
    }
    stmt = `${stmt}${rest}\n`.slice(0, 4000);
    return null;
  };
}
const CREATE_OBJECT = /\bCREATE\b([^;]{0,400}?)\b(PROCEDURE|FUNCTION|TRIGGER|EVENT|VIEW)\b/gi;
const CREATE_MODIFIERS = /^\s*(?:OR\s+REPLACE\s+)?(?:AGGREGATE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*(\S+)\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?$/i;
const USE_DB = /(?:^|;)\s*USE\s+[`'"]?([A-Za-z0-9_$]+)/gim;
const DDL_DB = /\b(?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:DATABASE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`'"]?([A-Za-z0-9_$]+)/gi;
// sql_mode changes that would make the server tokenise strings differently
// from the filter below are refused on the raw text, literals included.
const SQL_MODE_TRAP = /\bSQL_MODE\b[^\n]*\b(?:NO_BACKSLASH_ESCAPES|ANSI_QUOTES|ANSI)\b/i;
const SHORT_LITERAL = /^[A-Za-z0-9_.$%*@-]{0,80}$/;
const definerUser = (token) => { const m = String(token).match(/^[`'"]?([^`'"@]+)[`'"]?@/); return m ? m[1] : token.replace(/[`'"]/g, ''); };

// Reduces SQL text to its code: string literals become '' (identifier-like
// ones such as account names keep their value), comments disappear and the
// markers of executable /*!NNNNN … */ comments are removed. Quote state carries
// over between calls so multi-line literals are handled; prose inside INSERT
// data therefore never looks like a statement.
export function createSqlCodeFilter() {
  let state = 'code';
  let literal = '';
  let quote = '';
  return function codeOf(line) {
    let out = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      const c = line[i];
      if (state === 'code') {
        if (c === "'" || c === '"') { state = 'str'; quote = c; literal = ''; i++; continue; }
        if (c === '`') { state = 'ident'; out += c; i++; continue; }
        if (c === '#' || (c === '-' && line[i + 1] === '-' && (i + 2 >= n || /\s/.test(line[i + 2])))) { i = n; continue; }
        if (c === '/' && line[i + 1] === '*') {
          // /*! … */, /*M! … */ and /*+ … */ (optimizer hints) are code to the
          // mysql client and the server; only plain block comments are dropped.
          const executable = line[i + 2] === '!' || line[i + 2] === '+' || (line[i + 2] === 'M' && line[i + 3] === '!');
          if (!executable) { state = 'block'; i += 2; continue; }
          i += line[i + 2] === 'M' ? 4 : 3;
          while (i < n && /\d/.test(line[i])) i++;
          out += ' ';
          continue;
        }
        if (c === '*' && line[i + 1] === '/') { out += ' '; i += 2; continue; }
        out += c; i++; continue;
      }
      if (state === 'str') {
        if (c === '\\') { literal += line.slice(i, i + 2); i += 2; continue; }
        if (c === quote) {
          if (line[i + 1] === quote) { literal += c; i += 2; continue; }
          out += SHORT_LITERAL.test(literal) ? `${quote}${literal}${quote}` : `${quote}${quote}`;
          state = 'code'; i++; continue;
        }
        literal += c; i++; continue;
      }
      if (state === 'ident') {
        // The client treats backticks like strings, so "\" inside one is never a command.
        out += c === '\\' ? '_' : c; i++;
        if (c === '`') { if (line[i] === '`') { out += '`'; i++; } else state = 'code'; }
        continue;
      }
      if (state === 'block') {
        const j = line.indexOf('*/', i);
        if (j < 0) i = n; else { state = 'code'; i = j + 2; }
      }
    }
    if (state === 'str') literal += '\n';
    return out;
  };
}

// Returns the reason a piece of dump code must not be imported as root, or
// null. `database` is the only schema the dump may name; `definerPrefix` is the
// account whose users may own routines, views, triggers and events. `code`
// comes from createSqlCodeFilter; `raw` is the unfiltered text.
export function scanSqlCode(code, raw, { database, definerPrefix } = {}) {
  if (SQL_MODE_TRAP.test(raw)) return 'sql_mode changes that alter string quoting are not allowed in an account dump';
  for (const [re, what, hint] of DENIED_SQL) if (re.test(code)) return `${what} statements are not allowed in an account dump${hint || ''}`;
  for (const m of code.matchAll(USE_DB)) if (!database || m[1] !== database) return `the dump switches to database "${m[1]}" (only ${database || 'the target database'} may be used)`;
  for (const m of code.matchAll(DDL_DB)) if (!database || m[1] !== database) return `the dump creates or alters database "${m[1]}" (only ${database || 'the target database'} may be used)`;
  const foreign = foreignSchema(code, database);
  if (foreign) return foreign;
  for (const m of code.matchAll(CREATE_OBJECT)) {
    const mods = m[1].match(CREATE_MODIFIERS);
    if (!mods) continue;
    const kind = m[2].toLowerCase();
    if (!mods[1]) return `a ${kind} without an explicit DEFINER would run as the import user`;
    const owner = definerUser(mods[1]);
    if (/^current_user/i.test(owner)) return `a ${kind} with DEFINER = CURRENT_USER would run as the import user`;
    if (definerPrefix && !belongsTo(owner, definerPrefix)) return `a ${kind} is owned by DEFINER '${owner}', which is not a user of account "${definerPrefix}"`;
  }
  return null;
}

export function scanSql(text, options = {}) {
  const codeOf = createSqlCodeFilter();
  const guard = createClientCommandGuard(options);
  const codes = String(text).split('\n').map(codeOf);
  const reason = scanSqlCode(codes.join('\n'), text, options);
  if (reason) return reason;
  for (const code of codes) { const r = guard(code); if (r) return r; }
  return null;
}

// Streams the dump line by line; a rolling window of filtered code keeps
// statements split across lines ("CREATE\nUSER", mysqldump's multi-line view
// definitions) visible as one text.
async function scanDumpFile(file, options) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const codeOf = createSqlCodeFilter();
  const guard = createClientCommandGuard(options);
  let window = '';
  let lineNo = 0;
  let definers = false;
  try {
    for await (const line of rl) {
      lineNo++;
      const code = codeOf(line);
      window = `${window.slice(-600)}\n${code}`;
      const reason = scanSqlCode(window, line, options) || guard(code);
      if (reason) return { ok: false, line: lineNo, reason };
      if (!definers && /\bDEFINER\s*=/i.test(code)) definers = true;
    }
  } finally { rl.close(); stream.destroy(); }
  return { ok: true, lines: lineNo, definers };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
// Privileges that let a non-SUPER user keep the DEFINER of views, routines,
// triggers and events found in the dump: MySQL 8.2+, MySQL 8.0/8.1, MariaDB
// 10.5.2+. Older servers offer only SUPER, which the import never gets.
const DEFINER_PRIVILEGES = ['SET_ANY_DEFINER, ALLOW_NONEXISTENT_DEFINER', 'SET_USER_ID', 'SET USER'];

async function grantDefinerPrivilege(bin, accounts, creds) {
  for (const priv of DEFINER_PRIVILEGES) {
    try {
      await runSql(bin, accounts.map((a) => `GRANT ${priv} ON *.* TO ${a};`).join('\n'), creds);
      return priv;
    } catch (err) {
      if (err.code !== 'db_error') throw err;
    }
  }
  return null;
}

// Runs fn with a temporary MySQL user that holds ALL PRIVILEGES on the target
// database and nothing else, so cross-schema statements, SET GLOBAL, FILE
// operations and the like are refused by the server itself, whatever the
// scanner missed. The user is dropped when fn settles.
async function withImportUser(bin, creds, database, { definers }, fn) {
  const user = `whm_import_${crypto.randomBytes(6).toString('hex')}`;
  const password = crypto.randomBytes(24).toString('base64url');
  const hosts = !creds?.host ? ['localhost'] : LOCAL_HOSTS.has(creds.host) ? [...LOCAL_HOSTS] : ['%'];
  const accounts = hosts.map((h) => q.account(user, h));
  const setup = accounts.flatMap((a) => [`CREATE USER ${a} IDENTIFIED BY ${q.str(password)};`, `GRANT ALL PRIVILEGES ON ${q.id(database)}.* TO ${a};`]);
  await runSql(bin, setup.join('\n'), creds);
  try {
    const definerPrivilege = definers ? await grantDefinerPrivilege(bin, accounts, creds) : null;
    return await fn({ user, password, definerPrivilege });
  } finally {
    await runSql(bin, accounts.map((a) => `DROP USER IF EXISTS ${a};`).join('\n'), creds).catch(() => {});
  }
}

defineOp('transfer.mysql.import', {
  description: 'Load a SQL dump into a local database as a temporary user limited to that database, after refusing user/grant/global/client-command statements ("source <file>", admin credentials via a 0600 defaults file or /root/.my.cnf)',
  timeoutMs: 7_200_000,
  schema: z.object({ path: arg.absPath, database: dbName, definerPrefix: dbPrefix.optional(), credentials, timeoutMs: z.number().int().min(10_000).max(7_200_000).default(3_600_000) }).strict(),
  run: async ({ path: file, database, definerPrefix, credentials: creds, timeoutMs }, ctx) => {
    const resolved = ctx.assertAllowedPath(file, 'read');
    if (SYSTEM_SCHEMAS.has(database)) throw new OpError('refused', `"${database}" is a system database`);
    // The path is handed to the client's own "source" command, which splits
    // its line on whitespace and ";" rather than taking argv.
    if (!/^[A-Za-z0-9._/@+-]+$/.test(resolved)) throw new OpError('refused', `The dump path ${resolved} contains characters the mysql client's "source" command cannot take (use letters, digits and ". _ / @ + -")`);
    if (!fs.existsSync(resolved)) throw new OpError('not_found', `${file} does not exist`);
    const scan = await scanDumpFile(resolved, { database, definerPrefix });
    if (!scan.ok) throw new OpError('refused', `${path.basename(resolved)} line ${scan.line}: ${scan.reason}; review the dump and import it by hand if it is legitimate`);
    const bin = findClient();
    if (!bin) throw new OpError('capability_missing', 'The MySQL/MariaDB client (mysql or mariadb) is not installed on this server');
    const [sqlMode = '', socket = '', port = ''] = (await runSql(bin, 'SELECT @@GLOBAL.sql_mode, @@socket, @@port', creds)).trim().split('\t');
    // Under NO_BACKSLASH_ESCAPES the client tokenises strings differently from
    // the scanner, which would let "\!" hide inside a literal.
    if (/\bNO_BACKSLASH_ESCAPES\b/i.test(sqlMode)) throw new OpError('refused', 'The MySQL server runs with sql_mode NO_BACKSLASH_ESCAPES, under which dumps cannot be screened for mysql client commands; import the dump by hand');
    return withImportUser(bin, creds, database, { definers: scan.definers }, async (login) => {
      const client = { user: login.user, password: login.password };
      if (creds?.host) { client.host = creds.host; if (creds.port) client.port = creds.port; } else if (creds?.socket) client.socket = creds.socket;
      else if (socket && socket !== 'NULL') client.socket = socket;
      else if (port && port !== 'NULL') { client.host = '127.0.0.1'; client.port = Number(port); }
      // --defaults-file (not -extra-file): /root/.my.cnf is read after an extra
      // file and would put the admin user back.
      return withClientDefaults(client, async (defaults) => {
        const argv = [...defaults, '--batch', '--no-auto-rehash', `--database=${database}`, '-e', `source ${resolved}`];
        const { code, stderr } = await exec(bin, argv, { timeoutMs, allowFailure: true });
        if (code !== 0) {
          const err = classifyMysqlError(stderr);
          const hint = !login.definerPrivilege && /SUPER|SET_USER_ID|SET_ANY_DEFINER|SET USER/i.test(stderr) ? ' (this server offers no privilege short of SUPER for keeping a DEFINER; recreate those objects by hand)' : '';
          throw new OpError(err.code === 'db_error' || err.code === 'db_auth_failed' ? 'import_failed' : err.code, `mysql: ${err.message}${hint}`, { errno: err.errno });
        }
        return { path: resolved, database, imported: true, scannedLines: scan.lines, importUser: login.user, definerPrivilege: login.definerPrivilege };
      }, { exclusive: true });
    });
  },
});

defineOp('transfer.mysql.create_user', {
  description: 'Recreate a database user of a transferred account from its password hash, with grants limited to databases of that account',
  timeoutMs: 300_000,
  schema: z.object({
    user: mysqlUser,
    host: mysqlHost,
    ownerPrefix: dbPrefix,
    auth: z.object({ plugin: z.enum(AUTH_PLUGINS), hash: authHash }).strict().nullable().default(null),
    grants: z.array(z.object({ database: dbName, privileges: z.array(privilege).min(1).max(PRIVILEGES.length) }).strict()).max(50).default([]),
    credentials,
  }).strict(),
  run: async ({ user, host, ownerPrefix, auth, grants, credentials: creds }) => {
    if (!belongsTo(user, ownerPrefix)) throw new OpError('refused', `Database user "${user}" does not belong to account "${ownerPrefix}"`);
    for (const g of grants) {
      if (SYSTEM_SCHEMAS.has(g.database) || !belongsTo(g.database, ownerPrefix)) throw new OpError('refused', `Database "${g.database}" does not belong to account "${ownerPrefix}"`);
    }
    const bin = findClient();
    if (!bin) throw new OpError('capability_missing', 'The MySQL/MariaDB client (mysql or mariadb) is not installed on this server');
    const version = (await runSql(bin, 'SELECT VERSION()', creds)).trim();
    const mariadb = /mariadb/i.test(version);
    const acct = q.account(user, host);
    let create = `CREATE USER IF NOT EXISTS ${acct}`;
    if (auth) {
      const literal = auth.hash.startsWith('0x') ? auth.hash : q.str(auth.hash);
      if (mariadb) create += auth.plugin === 'mysql_native_password' ? ` IDENTIFIED BY PASSWORD ${literal}` : ` IDENTIFIED VIA ${auth.plugin} USING ${literal}`;
      else create += ` IDENTIFIED WITH ${auth.plugin} AS ${literal}`;
    }
    const statements = [create];
    for (const g of grants) {
      const list = g.privileges.includes('ALL PRIVILEGES') ? 'ALL PRIVILEGES' : [...new Set(g.privileges)].join(', ');
      statements.push(`GRANT ${list} ON ${q.id(g.database)}.* TO ${acct}`);
    }
    await runSql(bin, `${statements.map((s) => `${s};`).join('\n')}\nFLUSH PRIVILEGES;`, creds, { timeoutMs: 300_000 });
    return { user, host, created: true, plugin: auth?.plugin ?? null, grants: grants.map((g) => g.database), engine: mariadb ? 'mariadb' : 'mysql' };
  },
});

defineOp('transfer.user.set_password_hash', {
  description: 'Set a Linux user password from an existing crypt(3) hash (chpasswd -e) so a transferred or restored account keeps its password',
  schema: z.object({ username: arg.username, hash: z.string().regex(SHADOW_HASH, 'Must be a crypt(3) hash such as $6$…') }).strict(),
  run: async ({ username, hash }) => {
    const info = localPasswd(username);
    if (!info) throw new OpError('not_found', `Linux user "${username}" does not exist`);
    if (username === 'root' || info.uid < 1000) throw new OpError('refused', `"${username}" is a system account and is not managed by the panel`);
    // chpasswd -e reads "user:hash" from stdin, so the hash never appears in argv.
    await exec('chpasswd', ['-e'], { input: `${username}:${hash}\n` });
    return { username, applied: true };
  },
});

defineOp('transfer.upload.append', {
  description: 'Append a base64 chunk to an archive being uploaded into an allowed staging directory (truncate starts a new file)',
  schema: z.object({ path: arg.absPath, data: z.string().max(3 * 1024 * 1024).regex(/^[A-Za-z0-9+/=\s]*$/), truncate: z.boolean().default(false) }).strict(),
  run: async ({ path: file, data, truncate }, ctx) => {
    const resolved = ctx.assertAllowedPath(file, 'write');
    if (!archiveName.test(path.basename(resolved))) throw new OpError('refused', `${path.basename(resolved)} is not an archive file name (.tar.gz, .tgz or .tar)`);
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    const buf = Buffer.from(data.replace(/\s+/g, ''), 'base64');
    if (truncate) fs.writeFileSync(resolved, buf, { mode: 0o600 });
    else fs.appendFileSync(resolved, buf, { mode: 0o600 });
    return { path: resolved, bytes: buf.length, size: fs.statSync(resolved).size };
  },
});

defineOp('transfer.archive.list', {
  description: 'List account archives (.tar.gz/.tgz/.tar) in a directory with size and mtime',
  schema: z.object({ path: arg.absPath, limit: z.number().int().min(1).max(5000).default(500) }).strict(),
  run: async ({ path: dir, limit }, ctx) => {
    const resolved = ctx.assertAllowedPath(dir, 'read');
    let names;
    try { names = fs.readdirSync(resolved); } catch (err) { if (err.code === 'ENOENT') return { path: resolved, exists: false, archives: [] }; throw err; }
    const archives = [];
    for (const name of names) {
      if (!archiveName.test(name)) continue;
      let st;
      try { st = fs.lstatSync(path.join(resolved, name)); } catch { continue; }
      if (!st.isFile()) continue;
      archives.push({ name, path: path.join(resolved, name), sizeBytes: st.size, mtime: st.mtime.toISOString() });
      if (archives.length >= limit) break;
    }
    archives.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return { path: resolved, exists: true, archives };
  },
});
