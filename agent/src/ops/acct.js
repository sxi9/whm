import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exec } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// Account Functions helpers that no other family covers: moving a user's home
// entry after the files were copied (Rearrange an Account) and reading a log
// file by byte range so raw logs of any size can be streamed to a download.

const SYSTEM_USERS = new Set(['root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'nobody', 'systemd-network', 'systemd-resolve', 'messagebus', 'sshd', 'mysql', 'postfix', 'exim', 'exim4', 'named', 'bind', 'dovecot', 'nginx', 'apache', 'whmpanel', 'Debian-exim']);

function getent(username) {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${username}:`));
    if (!line) return null;
    const [name, , uid, gid, gecos, home, shell] = line.split(':');
    return { username: name, uid: Number(uid), gid: Number(gid), gecos, home, shell };
  } catch { return null; }
}

function assertManaged(username) {
  if (SYSTEM_USERS.has(username)) throw new OpError('refused', `"${username}" is a system account and is not managed by the panel`);
  const info = getent(username);
  if (!info) throw new OpError('not_found', `Linux user "${username}" does not exist`);
  if (info.uid < 1000) throw new OpError('refused', `"${username}" has a system UID (${info.uid}) and is not managed by the panel`);
  return info;
}

defineOp('acct.set_home', {
  description: 'Point a hosting account user at a new home directory (usermod -d; the tree must already exist, e.g. after fs.copy_tree)',
  schema: z.object({ username: arg.username, homeDir: arg.absPath }).strict(),
  run: async ({ username, homeDir }, ctx) => {
    const info = assertManaged(username);
    const target = ctx.assertAllowedPath(homeDir, 'write');
    let st;
    try { st = fs.statSync(target); } catch { st = null; }
    if (!st?.isDirectory()) throw new OpError('not_found', `${homeDir} does not exist or is not a directory; copy the account first`);
    if (st.uid !== info.uid) throw new OpError('refused', `${homeDir} is not owned by ${username} (uid ${info.uid})`);
    await exec('usermod', ['-d', target, username]);
    return { ...getent(username), previousHome: info.home };
  },
});

const LOG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}(\.log|\.log\.\d+|\.gz|\.\d+|-access_log|-error_log|_log)$/;

defineOp('acct.read_range', {
  description: 'Read a byte range of a log file inside an allowed root (base64), for chunked raw log downloads',
  schema: z.object({
    path: arg.absPath,
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    length: z.number().int().min(1).max(8 * 1024 * 1024).default(1024 * 1024),
  }).strict(),
  run: async ({ path: file, offset, length }, ctx) => {
    const resolved = ctx.assertAllowedPath(file, 'read');
    if (!LOG_NAME.test(path.basename(resolved))) throw new OpError('refused', `${path.basename(resolved)} is not a log file`);
    let st;
    try { st = fs.lstatSync(resolved); } catch { throw new OpError('not_found', `${file} does not exist`); }
    if (st.isSymbolicLink() || !st.isFile()) throw new OpError('refused', `${file} is not a regular file`);
    const size = st.size;
    const fd = fs.openSync(resolved, 'r');
    try {
      const want = Math.max(0, Math.min(length, size - offset));
      const buf = Buffer.alloc(want);
      const read = want ? fs.readSync(fd, buf, 0, want, offset) : 0;
      return { path: resolved, size, offset, length: read, data: buf.subarray(0, read).toString('base64'), eof: offset + read >= size, mtime: st.mtime.toISOString() };
    } finally { fs.closeSync(fd); }
  },
});
