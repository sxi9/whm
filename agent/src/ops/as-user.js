import fs from 'node:fs';
import path from 'node:path';
import { exec, hasBinary, resolveBinary } from '../exec.js';
import { OpError } from './registry.js';

// Helpers for ops that act inside a hosting account's home tree on the
// account's behalf (files.*, cron.*, ftp.*, vmail.*). Nothing here runs as
// root inside the home: the program is executed under the account's uid/gid
// (setpriv, or runuser when util-linux lacks setpriv), so the kernel enforces
// ownership, permissions and quota, and a symlink the tenant planted can only
// ever point the tenant at what the tenant may already reach. The home itself
// is read from /etc/passwd, never from the caller.

export { passwdHome } from './web.js';
export { assertRealPath } from './acct.js';

export const SYSTEM_USERS = new Set(['root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'nobody', 'systemd-network', 'systemd-resolve', 'messagebus', 'sshd', 'mysql', 'postfix', 'exim', 'exim4', 'named', 'bind', 'dovecot', 'nginx', 'apache', 'whmpanel', 'Debian-exim']);
export const MIN_MANAGED_UID = 1000;

export function getent(username) {
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
  if (!Number.isInteger(info.uid) || info.uid < MIN_MANAGED_UID) throw new OpError('refused', `"${username}" has a system UID (${info.uid}) and is not managed by the panel`);
  if (!info.home || !path.isAbsolute(info.home) || info.home === '/') throw new OpError('refused', `"${username}" has no usable home directory`);
  return info;
}

const isMissing = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

// Lexical containment first (no ".." can get past the schemas, but a path is
// normalised here anyway), then real containment: every existing component of
// the path is resolved and the not-yet-existing tail is appended, so a symlink
// anywhere on the way that leaves the (resolved) home refuses the path.
export function assertUnderHome(home, p) {
  const resolved = path.resolve(p);
  const homeResolved = path.resolve(home);
  if (resolved !== homeResolved && !resolved.startsWith(`${homeResolved}/`)) throw new OpError('path_not_allowed', `${p} is not inside the home directory ${home}`);
  let realHome;
  try { realHome = fs.realpathSync(homeResolved); } catch (err) {
    if (isMissing(err)) throw new OpError('not_found', `Home directory ${home} does not exist`);
    throw err;
  }
  let cur = resolved;
  const tail = [];
  let real = null;
  while (real === null) {
    try { real = fs.realpathSync(cur); } catch (err) {
      if (!isMissing(err)) throw err;
      if (cur === '/' || cur === homeResolved) throw new OpError('not_found', `${p} has no existing parent inside ${home}`);
      tail.unshift(path.basename(cur));
      cur = path.dirname(cur);
    }
  }
  real = path.join(real, ...tail);
  if (real !== realHome && !real.startsWith(`${realHome}/`)) throw new OpError('path_not_allowed', `${p} escapes the home directory through a symbolic link`);
  return resolved;
}

// Resolves a caller-supplied absolute path against the account whose name was
// given: the home comes from /etc/passwd, the path must sit under it (lexically
// and through symlinks) and under an allowed root.
export function accountPath(username, p, ctx, mode = 'read') {
  const info = assertManaged(username);
  const home = path.resolve(info.home);
  ctx.assertAllowedPath(home, mode);
  const target = assertUnderHome(home, p);
  ctx.assertAllowedPath(target, mode);
  return { info, home, target };
}

export function privilegeTool() {
  if (hasBinary('setpriv')) return 'setpriv';
  if (hasBinary('runuser')) return 'runuser';
  return null;
}

export function requireAsUser() {
  const tool = privilegeTool();
  if (!tool) throw new OpError('capability_missing', 'setpriv or runuser (util-linux) is required to run commands as a hosting account');
  return tool;
}

// The exact [program, argv] pair that runs `bin argv...` as the account.
// setpriv drops to the real+effective uid/gid with no supplementary groups and
// no-new-privs; runuser is the fallback. `--` ends the option list of both, so
// nothing in argv is ever read as an option of the wrapper.
export function asUserArgv(info, bin, argv, { tool = 'setpriv', nice = false } = {}) {
  const program = path.isAbsolute(bin) ? bin : resolveBinary(bin);
  if (!program) throw new OpError('binary_not_found', `Required program "${bin}" is not installed on this server`, { bin });
  let exe;
  let args;
  if (tool === 'setpriv') {
    exe = 'setpriv';
    args = ['--reuid', String(info.uid), '--regid', String(info.gid), '--clear-groups', '--no-new-privs', '--', program, ...argv];
  } else if (tool === 'runuser') {
    exe = 'runuser';
    args = ['-u', info.username, '--', program, ...argv];
  } else {
    throw new OpError('capability_missing', 'setpriv or runuser (util-linux) is required to run commands as a hosting account');
  }
  if (nice) {
    const wrapper = resolveBinary(exe);
    if (!wrapper) throw new OpError('binary_not_found', `Required program "${exe}" is not installed on this server`, { bin: exe });
    return ['nice', ['-n', '10', '--', wrapper, ...args]];
  }
  return [exe, args];
}

export async function asUser(info, bin, argv, { timeoutMs = 120_000, input, cwd, allowFailure = false, maxBuffer, nice = false, env = {} } = {}) {
  const tool = requireAsUser();
  const [exe, args] = asUserArgv(info, bin, argv, { tool, nice });
  if (nice && !hasBinary('nice')) throw new OpError('binary_not_found', 'Required program "nice" is not installed on this server', { bin: 'nice' });
  return exec(exe, args, { timeoutMs, input, cwd, allowFailure, maxBuffer, env: { HOME: info.home, USER: info.username, LOGNAME: info.username, ...env } });
}

export const lastLine = (r) => (r.stderr || r.stdout || '').trim().split('\n').pop() || `exit ${r.code}`;

// Maps a failed as-user command onto the op error codes the panel understands;
// anything the kernel refused to the account is the account's own permission
// problem, not a server fault.
export function failureOf(r, what) {
  const line = lastLine(r);
  if (/setpriv:|runuser:/.test(line) && /(cannot|failed|unknown user)/i.test(line)) return new OpError('command_failed', `${what}: ${line}`, { stderr: r.stderr.slice(-4000) });
  if (/No such file or directory|cannot stat|does not exist/i.test(line)) return new OpError('not_found', `${what}: ${line}`);
  if (/Permission denied|Operation not permitted|not permitted/i.test(line)) return new OpError('refused', `${what}: ${line}`);
  if (/Disk quota exceeded|No space left/i.test(line)) return new OpError('refused', `${what}: ${line}`);
  if (/File exists|not overwriting|not replacing|already exists/i.test(line)) return new OpError('exists', `${what}: ${line}`);
  if (/Is a directory|Not a directory|cannot overwrite directory|Directory not empty/i.test(line)) return new OpError('refused', `${what}: ${line}`);
  return new OpError('command_failed', `${what}: ${line}`, { stderr: r.stderr.slice(-4000) });
}

export function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}
