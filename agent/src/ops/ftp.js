import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { passwdHome, assertUnderHome } from './web.js';

// FTP virtual users for the customer panel: pure-ftpd's PureDB (pure-pw) and
// proftpd's AuthUserFile (ftpasswd). Every virtual login is pinned to a managed
// hosting account: its uid, gid and home are read from /etc/passwd here, never
// taken from the caller, and the login directory must resolve inside that home.
// Passwords travel on stdin only; nothing secret is ever an argv element.
//
// Enabling PureDB / AuthUserFile in the daemon configuration belongs to
// service-configuration (ctx.web.ftp.enableVirtualUsers); ftp.virtual.status
// only reports whether it is in place.

export const PURE_PASSWD = '/etc/pure-ftpd/pureftpd.passwd';
export const PURE_PDB = '/etc/pure-ftpd/pureftpd.pdb';
export const PROFTPD_PASSWD = '/etc/proftpd/ftpd.passwd';
const PROFTPD_CONF = '/etc/proftpd/proftpd.conf';
const PROFTPD_CONF_DIR = '/etc/proftpd/conf.d';
const PURE_CONF_DIR = '/etc/pure-ftpd/conf';
const PURE_CONF_FILE = '/etc/pure-ftpd/pure-ftpd.conf';

const SYSTEM_USERS = new Set(['root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'nobody', 'systemd-network', 'systemd-resolve', 'messagebus', 'sshd', 'mysql', 'postfix', 'exim', 'exim4', 'named', 'bind', 'dovecot', 'nginx', 'apache', 'whmpanel', 'Debian-exim']);

const daemon = z.enum(['pure-ftpd', 'proftpd']);
// A login never starts with "-" (it follows the pure-pw verb as a positional
// argument) and never carries ":" or whitespace (passwd-file field separators).
export const login = z.string().regex(/^[a-z0-9][a-z0-9._@-]{0,63}$/);
const password = z.string().regex(/^[^\n\r\0]{1,256}$/);
const quotaMb = z.number().int().min(0).max(1_000_000_000).nullable();

function getent(username) {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${username}:`));
    if (!line) return null;
    const [name, , uid, gid, gecos, home, shell] = line.split(':');
    return { username: name, uid: Number(uid), gid: Number(gid), gecos, home, shell };
  } catch { return null; }
}

export function assertManaged(username) {
  if (SYSTEM_USERS.has(username)) throw new OpError('refused', `"${username}" is a system account and is not managed by the panel`);
  const info = getent(username);
  if (!info) throw new OpError('not_found', `Linux user "${username}" does not exist`);
  if (info.uid < 1000) throw new OpError('refused', `"${username}" has a system UID (${info.uid}) and is not managed by the panel`);
  return info;
}

// The login directory must sit inside the account's own home (lexically and
// after resolving symlinks) and inside an allowed root. A sibling home under
// the same root is refused like any other outside path.
export function assertFtpDir(home, dir, ctx) {
  const resolved = assertUnderHome(home, dir);
  ctx.assertAllowedPath(home, 'read');
  ctx.assertAllowedPath(resolved, 'read');
  return resolved;
}

function requireDaemonTool(which) {
  const bin = which === 'pure-ftpd' ? 'pure-pw' : 'ftpasswd';
  if (!hasBinary(bin)) throw new OpError('capability_missing', `${bin} is not installed on this server; install ${which === 'pure-ftpd' ? 'pure-ftpd' : 'proftpd'} virtual-user tools to manage FTP accounts`);
  return bin;
}

const lastLine = (r) => (r.stderr || r.stdout || '').trim().split('\n').pop() || `exit status ${r.code}`;

function translate(r, what) {
  const text = `${r.stderr}\n${r.stdout}`;
  if (/already exists|duplicate/i.test(text)) return new OpError('exists', `${what}: the FTP login already exists`);
  if (/unable to find|no such user|not found|does not exist|unknown user/i.test(text)) return new OpError('not_found', `${what}: no such FTP login`);
  return new OpError('command_failed', `${what} failed: ${lastLine(r)}`, { stderr: r.stderr.slice(-2000) });
}

async function purePw(argv, { input, what }) {
  const r = await exec('pure-pw', argv, { input, allowFailure: true, timeoutMs: 60_000 });
  if (r.code !== 0) throw translate(r, what);
  return r;
}

async function ftpasswd(argv, { input, what }) {
  const r = await exec('ftpasswd', argv, { input, allowFailure: true, timeoutMs: 60_000 });
  if (r.code !== 0) throw translate(r, what);
  return r;
}

const pureArgs = (verb, name) => [verb, name, '-f', PURE_PASSWD, '-F', PURE_PDB];
const twice = (pw) => `${pw}\n${pw}\n`;

// pure-pw rebuilds the PureDB with -m; without it the daemon keeps serving the
// old database, so every mutation carries it.
defineOp('ftp.user.add', {
  description: 'Create an FTP virtual user bound to a hosting account (uid/gid/home from /etc/passwd, directory inside that home), password on stdin',
  schema: z.object({ daemon, login, password, username: arg.username, dir: arg.absPath, quotaMb: quotaMb.default(null) }).strict(),
  run: async ({ daemon: which, login: name, password: pw, username, dir, quotaMb: mb }, ctx) => {
    const info = assertManaged(username);
    const home = passwdHome(username);
    const target = assertFtpDir(home, dir, ctx);
    requireDaemonTool(which);
    if (which === 'pure-ftpd') {
      const argv = [...pureArgs('useradd', name), '-u', String(info.uid), '-g', String(info.gid), '-d', target];
      if (mb != null && mb > 0) argv.push('-N', String(mb));
      argv.push('-m');
      await purePw(argv, { input: twice(pw), what: `pure-pw useradd ${name}` });
    } else {
      const argv = ['--passwd', `--file=${PROFTPD_PASSWD}`, `--name=${name}`, `--uid=${info.uid}`, `--gid=${info.gid}`, `--home=${target}`, '--shell=/bin/false', '--stdin'];
      await ftpasswd(argv, { input: `${pw}\n`, what: `ftpasswd add ${name}` });
    }
    return { daemon: which, login: name, username, uid: info.uid, gid: info.gid, dir: target, quotaMb: which === 'pure-ftpd' ? mb : null, quotaSupported: which === 'pure-ftpd' };
  },
});

defineOp('ftp.user.passwd', {
  description: 'Change the password of an FTP virtual user (password on stdin)',
  schema: z.object({ daemon, login, password }).strict(),
  run: async ({ daemon: which, login: name, password: pw }) => {
    requireDaemonTool(which);
    if (which === 'pure-ftpd') await purePw([...pureArgs('passwd', name), '-m'], { input: twice(pw), what: `pure-pw passwd ${name}` });
    else await ftpasswd(['--passwd', `--file=${PROFTPD_PASSWD}`, `--name=${name}`, '--change-password', '--stdin'], { input: `${pw}\n`, what: `ftpasswd passwd ${name}` });
    return { daemon: which, login: name, changed: true };
  },
});

defineOp('ftp.user.set_quota', {
  description: 'Set or clear the disk quota (MB) of a pure-ftpd virtual user; proftpd has no per-user quota in the passwd file',
  schema: z.object({ daemon, login, quotaMb }).strict(),
  run: async ({ daemon: which, login: name, quotaMb: mb }) => {
    requireDaemonTool(which);
    if (which !== 'pure-ftpd') throw new OpError('unsupported', 'proftpd virtual users have no per-user quota; use the account disk quota instead');
    await purePw([...pureArgs('usermod', name), '-N', String(mb ?? 0), '-m'], { what: `pure-pw usermod ${name}` });
    return { daemon: which, login: name, quotaMb: mb };
  },
});

defineOp('ftp.user.remove', {
  description: 'Delete an FTP virtual user',
  destructive: true,
  schema: z.object({ daemon, login }).strict(),
  run: async ({ daemon: which, login: name }) => {
    requireDaemonTool(which);
    let existed = true;
    try {
      if (which === 'pure-ftpd') await purePw([...pureArgs('userdel', name), '-m'], { what: `pure-pw userdel ${name}` });
      else await ftpasswd(['--passwd', `--file=${PROFTPD_PASSWD}`, `--name=${name}`, '--delete-user'], { what: `ftpasswd delete ${name}` });
    } catch (err) {
      if (err.code !== 'not_found') throw err;
      existed = false;
    }
    return { daemon: which, login: name, removed: existed };
  },
});

function parseProftpdPasswd(text) {
  const users = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [name, , uid, gid, , home] = line.split(':');
    if (!name) continue;
    users.push({ login: name, uid: Number(uid), gid: Number(gid), dir: home || null });
  }
  return users;
}

export function parsePurePwList(stdout) {
  const users = [];
  for (const raw of (stdout || '').split('\n')) {
    const m = raw.match(/^(\S+)\s+(\S.*?)\s*$/);
    if (!m) continue;
    users.push({ login: m[1], dir: m[2].replace(/\/\.\/?$/, '') });
  }
  return users;
}

defineOp('ftp.user.list', {
  description: 'FTP virtual users known to the daemon (logins and directories, never hashes)',
  schema: z.object({ daemon }).strict(),
  run: async ({ daemon: which }, ctx) => {
    if (which === 'pure-ftpd') {
      requireDaemonTool(which);
      if (!fs.existsSync(PURE_PASSWD)) return { daemon: which, users: [] };
      const r = await exec('pure-pw', ['list', '-f', PURE_PASSWD], { allowFailure: true, timeoutMs: 60_000 });
      if (r.code !== 0) throw translate(r, 'pure-pw list');
      return { daemon: which, users: parsePurePwList(r.stdout) };
    }
    const file = ctx.assertAllowedPath(PROFTPD_PASSWD, 'read');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return { daemon: which, users: parseProftpdPasswd(text) };
  },
});

async function reloadUnit(names) {
  if (!hasBinary('systemctl')) return { reloaded: false, unit: null };
  for (const unit of names) {
    const r = await exec('systemctl', ['try-reload-or-restart', '--', unit], { allowFailure: true, timeoutMs: 60_000 });
    if (r.code === 0) return { reloaded: true, unit };
  }
  return { reloaded: false, unit: null };
}

defineOp('ftp.sync', {
  description: 'Rebuild the pure-ftpd PureDB from the passwd file; proftpd reads its AuthUserFile live (reload only)',
  schema: z.object({ daemon }).strict(),
  run: async ({ daemon: which }) => {
    if (which === 'pure-ftpd') {
      requireDaemonTool(which);
      if (!fs.existsSync(PURE_PASSWD)) return { daemon: which, synced: false, reason: 'no passwd file yet' };
      await purePw(['mkdb', PURE_PDB, '-f', PURE_PASSWD], { what: 'pure-pw mkdb' });
      return { daemon: which, synced: true, db: PURE_PDB };
    }
    return { daemon: which, synced: true, ...(await reloadUnit(['proftpd'])) };
  },
});

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function pureFtpdVirtualStatus() {
  const installed = fs.existsSync('/etc/pure-ftpd') || hasBinary('pure-ftpd') || hasBinary('pure-pw');
  let configured = false;
  let dbFile = null;
  if (fs.existsSync(PURE_CONF_DIR)) {
    const v = (readText(path.join(PURE_CONF_DIR, 'PureDB')) || '').trim();
    if (v) { configured = true; dbFile = v; }
  } else {
    const text = readText(PURE_CONF_FILE) || '';
    const m = text.split('\n').map((l) => l.trim()).find((l) => /^PureDB\s+\S/.test(l));
    if (m) { configured = true; dbFile = m.replace(/^PureDB\s+/, '').trim(); }
  }
  return { daemon: 'pure-ftpd', installed, supported: true, tool: hasBinary('pure-pw'), configured, enabled: configured && hasBinary('pure-pw'), passwdFile: PURE_PASSWD, dbFile: dbFile || PURE_PDB, hint: configured ? null : 'Enable PureDB (conf/PureDB or "PureDB /etc/pure-ftpd/pureftpd.pdb") under FTP Server Configuration' };
}

function proftpdVirtualStatus() {
  const installed = fs.existsSync('/etc/proftpd') || hasBinary('proftpd');
  const files = [PROFTPD_CONF];
  try { for (const f of fs.readdirSync(PROFTPD_CONF_DIR)) if (f.endsWith('.conf')) files.push(path.join(PROFTPD_CONF_DIR, f)); } catch { /* none */ }
  let authUserFile = null;
  let authOrder = null;
  for (const f of files) {
    for (const raw of (readText(f) || '').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^AuthUserFile\s+(\S+)/i);
      if (m) authUserFile = m[1];
      const o = line.match(/^AuthOrder\s+(.+)$/i);
      if (o) authOrder = o[1].trim();
    }
  }
  const configured = Boolean(authUserFile);
  return { daemon: 'proftpd', installed, supported: true, tool: hasBinary('ftpasswd'), configured, enabled: configured && hasBinary('ftpasswd'), passwdFile: authUserFile || PROFTPD_PASSWD, authOrder, systemLoginsKept: !authOrder || /mod_auth_unix\.c|mod_auth_pam\.c/.test(authOrder), hint: configured ? null : 'Add "AuthUserFile /etc/proftpd/ftpd.passwd" and "AuthOrder mod_auth_file.c mod_auth_unix.c" under FTP Server Configuration' };
}

defineOp('ftp.virtual.status', {
  description: 'Whether virtual FTP users are enabled in the daemon configuration (pure-ftpd PureDB, proftpd AuthUserFile); vsftpd never supports them',
  schema: z.object({ daemon: z.enum(['pure-ftpd', 'proftpd', 'vsftpd']).optional() }).strict(),
  run: async ({ daemon: which }) => {
    const daemons = {
      'pure-ftpd': pureFtpdVirtualStatus(),
      proftpd: proftpdVirtualStatus(),
      vsftpd: { daemon: 'vsftpd', installed: hasBinary('vsftpd') || fs.existsSync('/etc/vsftpd.conf') || fs.existsSync('/etc/vsftpd/vsftpd.conf'), supported: false, configured: false, enabled: false, hint: 'vsftpd serves system users only; choose pure-ftpd or proftpd for per-account FTP logins' },
    };
    return which ? daemons[which] : { daemons };
  },
});
