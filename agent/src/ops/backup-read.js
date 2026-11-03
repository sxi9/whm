import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineOp, arg, OpError } from './registry.js';
import { assertRealPath } from './acct.js';
import { assertManaged, accountPath, asUser, failureOf, lstatOrNull } from './as-user.js';

// Byte-range reads of account archives for customer downloads. Archives are
// root-owned 0600 under the backup directory, so there is no as-user path: the
// read runs root-side with the same guards as acct.read_range (allowed root,
// no symlink in any component, O_NOFOLLOW, regular file only) and only for a
// file whose name is a cPanel-compatible account archive.
//
// backup.dump.import is the other half of the panel's database dumps: mysqldump
// writes into a root-owned staging directory (never into the home, where a
// planted symlink could redirect --result-file), and this op hands the file to
// the account by opening it root-side and feeding that descriptor to a writer
// running under the account's own uid, so files.copy's home-only rule stays
// intact. The account never needs to reach the staging tree itself: on a
// production host /var/lib/whm is 0750 whmpanel:whmpanel, so a copy run as the
// account would fail on the first directory it cannot search.

// Verbatim copy of READ_NAME in backup.js (private there); agent/test/backup-read.test.js
// keeps the two in step through backup.js's exported readableName schema.
export const READ_NAME = /^(backup-\d{2}\.\d{2}\.\d{4}_\d{2}-\d{2}-\d{2}_|cpmove-)?[a-z][a-z0-9_-]{0,31}\.tar(\.gz)?$/;
export const ARCHIVE_ROOTS = ['/backup', '/var/backups/whm', '/var/lib/whm'];
export const MAX_RANGE = 8 * 1024 * 1024;

const archivePath = arg.absPath.refine((p) => READ_NAME.test(path.basename(p)), 'Not a cPanel-compatible account archive');

export function underArchiveRoot(resolved) {
  return ARCHIVE_ROOTS.some((r) => resolved === r || resolved.startsWith(`${r}/`));
}

defineOp('backup.archive.read_range', {
  description: 'Read a byte range (base64) of an account archive under the backup directories for chunked customer downloads; no symlink in the path',
  schema: z.object({
    archive: archivePath,
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    length: z.number().int().min(1).max(MAX_RANGE).default(MAX_RANGE),
  }).strict(),
  run: async ({ archive, offset, length }, ctx) => {
    const resolved = ctx.assertAllowedPath(archive, 'read');
    if (!underArchiveRoot(resolved)) throw new OpError('path_not_allowed', `${archive} is not inside a backup directory (${ARCHIVE_ROOTS.join(', ')})`);
    let st;
    try { st = fs.lstatSync(resolved); } catch { throw new OpError('not_found', `${archive} does not exist`); }
    if (st.isSymbolicLink() || !st.isFile()) throw new OpError('refused', `${archive} is not a regular file`);
    assertRealPath(resolved, ctx, 'read');
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

export const DUMP_STAGING_ROOT = '/var/lib/whm/panel/dumps';
export const DUMP_NAME = /^[a-z0-9_]{1,64}-\d{8}T\d{6}Z\.sql$/;

const dumpPath = arg.absPath.refine((p) => DUMP_NAME.test(path.basename(p)), 'Not a panel database dump name');

export function stagingDirFor(username) {
  return `${DUMP_STAGING_ROOT}/${username}`;
}

export const DUMP_MODE = '0600';

defineOp('backup.dump.import', {
  description: 'Copy a database dump from the panel staging directory into the account home: the staging file is opened root-side and written under the account uid (dd conv=excl from stdin, then chmod 0600), so the staging tree stays root-only',
  timeoutMs: 600_000,
  schema: z.object({ username: arg.username, from: dumpPath, to: dumpPath }).strict(),
  run: async ({ username, from, to }, ctx) => {
    const staging = stagingDirFor(username);
    const source = path.resolve(from);
    if (path.dirname(source) !== staging) throw new OpError('path_not_allowed', `${from} is not inside the dump staging directory of ${username} (${staging})`);
    const info = assertManaged(username);
    ctx.assertAllowedPath(source, 'read');
    const st = lstatOrNull(source);
    if (!st) throw new OpError('not_found', `${from} does not exist`);
    if (st.isSymbolicLink() || !st.isFile()) throw new OpError('refused', `${from} is not a regular file`);
    assertRealPath(source, ctx, 'read');
    const dst = accountPath(username, to, ctx, 'write');
    if (dst.target === dst.home) throw new OpError('refused', 'backup.dump.import refuses to write the home directory itself');
    const rel = path.relative(dst.home, dst.target);
    if (lstatOrNull(dst.target)) throw new OpError('exists', `${rel} already exists`);
    const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stream = fs.createReadStream('', { fd, autoClose: true });
    try {
      const open = fs.fstatSync(fd);
      if (!open.isFile() || open.ino !== st.ino || open.dev !== st.dev) throw new OpError('refused', `${from} changed while it was being checked`);
      // conv=excl creates the target with O_CREAT|O_EXCL: a file or link the
      // account slipped in after the check above fails the write instead of
      // being overwritten or followed. A partial file (quota, short read) is
      // removed as the account; an `exists` failure created nothing to remove.
      let r;
      try {
        r = await asUser(info, 'dd', [`of=${dst.target}`, 'bs=1M', 'status=none', 'conv=excl'], { input: stream, allowFailure: true, timeoutMs: 600_000 });
      } catch (err) {
        await asUser(info, 'rm', ['-f', '--', dst.target], { allowFailure: true, timeoutMs: 30_000 }).catch(() => {});
        throw err;
      }
      if (r.code !== 0) {
        const err = failureOf(r, `import ${rel}`);
        if (err.code !== 'exists') await asUser(info, 'rm', ['-f', '--', dst.target], { allowFailure: true, timeoutMs: 30_000 }).catch(() => {});
        throw err;
      }
      const c = await asUser(info, 'chmod', ['--', DUMP_MODE, dst.target], { allowFailure: true, timeoutMs: 30_000 });
      if (c.code !== 0) throw failureOf(c, `chmod ${DUMP_MODE} ${rel}`);
    } finally {
      stream.destroy();
    }
    return { from: source, to: dst.target, username, sizeBytes: st.size, mode: DUMP_MODE };
  },
});
