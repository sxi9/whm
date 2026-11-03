import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineOp, arg, OpError } from './registry.js';
import { assertRealPath } from './acct.js';

// Byte-range reads of account archives for customer downloads. Archives are
// root-owned 0600 under the backup directory, so there is no as-user path: the
// read runs root-side with the same guards as acct.read_range (allowed root,
// no symlink in any component, O_NOFOLLOW, regular file only) and only for a
// file whose name is a cPanel-compatible account archive.

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
