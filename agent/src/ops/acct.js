import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exec } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// Account Functions helpers that no other family covers: moving a user's home
// entry after the files were copied (Rearrange an Account), listing and reading
// log files by byte range (raw log downloads) and archiving web logs into the
// account home (Web Log Retention).
//
// Everything that touches a path inside an account home refuses symlinks in any
// component: the lexical allowed-root check alone would let a tenant replace
// ~/logs with a link to another tenant's logs or to /etc and have root follow it.

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

// The path as given must be the real path: realpath resolves every component,
// so any symlink on the way (not only the last one) makes them differ.
export function assertRealPath(resolved, ctx, mode = 'read') {
  let real;
  try { real = fs.realpathSync(resolved); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new OpError('not_found', `${resolved} does not exist`);
    throw err;
  }
  if (real !== resolved) throw new OpError('refused', `${resolved} goes through a symbolic link (${real}); refusing to follow it`);
  ctx.assertAllowedPath(real, mode);
  return real;
}

const ownedBy = (st, uid) => st.uid === 0 || st.uid === uid;

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

defineOp('acct.list_logs', {
  description: 'List the regular log files of a directory with no symlink in its path; with owner, the directory and the files must belong to root or that account',
  schema: z.object({ path: arg.absPath, owner: arg.username.optional(), limit: z.number().int().min(1).max(10000).default(5000) }).strict(),
  run: async ({ path: dir, owner, limit }, ctx) => {
    const resolved = ctx.assertAllowedPath(dir, 'read');
    const uid = owner ? assertManaged(owner).uid : null;
    const real = assertRealPath(resolved, ctx, 'read');
    const st = fs.lstatSync(real);
    if (!st.isDirectory()) throw new OpError('refused', `${dir} is not a directory`);
    if (uid != null && !ownedBy(st, uid)) throw new OpError('refused', `${dir} is not owned by ${owner} or root (uid ${st.uid}); refusing to list it`);
    const entries = [];
    const skipped = [];
    for (const d of fs.readdirSync(real, { withFileTypes: true })) {
      if (entries.length >= limit) break;
      if (!LOG_NAME.test(d.name)) continue;
      let fst;
      try { fst = fs.lstatSync(path.join(real, d.name)); } catch { continue; }
      if (!fst.isFile()) { skipped.push({ name: d.name, reason: fst.isSymbolicLink() ? 'symlink' : 'not a file' }); continue; }
      if (uid != null && !ownedBy(fst, uid)) { skipped.push({ name: d.name, reason: `owned by uid ${fst.uid}` }); continue; }
      entries.push({ name: d.name, size: fst.size, mtime: fst.mtime.toISOString(), uid: fst.uid, mode: (fst.mode & 0o7777).toString(8) });
    }
    return { path: real, entries, skipped };
  },
});

defineOp('acct.read_range', {
  description: 'Read a byte range of a log file inside an allowed root (base64), for chunked raw log downloads; no symlink in the path, and with owner the file must belong to root or that account',
  schema: z.object({
    path: arg.absPath,
    owner: arg.username.optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    length: z.number().int().min(1).max(8 * 1024 * 1024).default(1024 * 1024),
  }).strict(),
  run: async ({ path: file, owner, offset, length }, ctx) => {
    const resolved = ctx.assertAllowedPath(file, 'read');
    if (!LOG_NAME.test(path.basename(resolved))) throw new OpError('refused', `${path.basename(resolved)} is not a log file`);
    const uid = owner ? assertManaged(owner).uid : null;
    let st;
    try { st = fs.lstatSync(resolved); } catch { throw new OpError('not_found', `${file} does not exist`); }
    if (st.isSymbolicLink() || !st.isFile()) throw new OpError('refused', `${file} is not a regular file`);
    assertRealPath(resolved, ctx, 'read');
    if (uid != null && !ownedBy(st, uid)) throw new OpError('refused', `${file} is not owned by ${owner} or root (uid ${st.uid})`);
    const size = st.size;
    const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const want = Math.max(0, Math.min(length, size - offset));
      const buf = Buffer.alloc(want);
      const read = want ? fs.readSync(fd, buf, 0, want, offset) : 0;
      return { path: resolved, size, offset, length: read, data: buf.subarray(0, read).toString('base64'), eof: offset + read >= size, mtime: st.mtime.toISOString() };
    } finally { fs.closeSync(fd); }
  },
});

const ARCHIVE_LABEL = /^\d{4}-(0[1-9]|1[0-2])$/;

// The copy, the directories and the pruning all run as the account (runuser), so
// root never creates or removes anything inside the user-writable home tree: a
// planted symlink can only ever redirect the account's own privileges. The
// domlogs source is root-owned with the account's group, which is enough to
// read it.
defineOp('acct.archive_logs', {
  description: 'Archive a web log directory into <archiveDir>/<YYYY-MM> inside the account home as the account user, and prune archives older than retainMonths',
  destructive: true,
  timeoutMs: 3_600_000,
  schema: z.object({
    username: arg.username,
    source: arg.absPath,
    archiveDir: arg.absPath,
    label: z.string().regex(ARCHIVE_LABEL),
    retainMonths: z.number().int().min(1).max(120).nullable().default(null),
  }).strict(),
  run: async ({ username, source, archiveDir, label, retainMonths }, ctx) => {
    const info = assertManaged(username);
    const src = assertRealPath(ctx.assertAllowedPath(source, 'read'), ctx, 'read');
    if (!fs.lstatSync(src).isDirectory()) throw new OpError('refused', `${source} is not a directory`);
    const archive = ctx.assertAllowedPath(archiveDir, 'write');
    const home = path.resolve(info.home);
    if (!archive.startsWith(`${home}/`)) throw new OpError('refused', `${archiveDir} is outside ${username}'s home directory ${home}`);
    const homeSt = fs.lstatSync(home);
    if (!homeSt.isDirectory() || homeSt.uid !== info.uid) throw new OpError('refused', `${home} is not a directory owned by ${username}`);
    const dest = `${archive}/${label}`;
    const asUser = (argv, opts) => exec('runuser', ['-u', username, '--', ...argv], opts);
    await asUser(['mkdir', '-p', '-m', '0750', '--', dest]);
    await asUser(['rsync', '-rlt', '--safe-links', '--', `${src}/`, `${dest}/`], { timeoutMs: 3_600_000 });
    const pruned = [];
    if (retainMonths != null) {
      const now = new Date();
      const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - retainMonths, 1)).toISOString().slice(0, 7);
      assertRealPath(archive, ctx, 'write');
      for (const d of fs.readdirSync(archive, { withFileTypes: true })) {
        if (!ARCHIVE_LABEL.test(d.name) || d.name >= cutoff) continue;
        let st;
        try { st = fs.lstatSync(path.join(archive, d.name)); } catch { continue; }
        if (!st.isDirectory()) continue;
        await asUser(['rm', '-rf', '--', `${archive}/${d.name}`]);
        pruned.push(d.name);
      }
    }
    return { username, uid: info.uid, source: src, dest, pruned };
  },
});
