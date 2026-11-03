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
// the account by making it group-readable and copying it under the account's
// own uid, so files.copy's home-only rule stays intact.

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

defineOp('backup.dump.import', {
  description: 'Copy a database dump from the panel staging directory into the account home as the account (the staging file becomes root:<account gid> 0640 first)',
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
    if (lstatOrNull(dst.target)) throw new OpError('exists', `${path.relative(dst.home, dst.target)} already exists`);
    fs.chownSync(staging, 0, info.gid);
    fs.chmodSync(staging, 0o750);
    fs.chownSync(source, 0, info.gid);
    fs.chmodSync(source, 0o640);
    const r = await asUser(info, 'cp', ['--no-dereference', '--', source, dst.target], { allowFailure: true, timeoutMs: 600_000 });
    if (r.code !== 0) throw failureOf(r, `import ${path.basename(source)}`);
    return { from: source, to: dst.target, username, sizeBytes: st.size };
  },
});
