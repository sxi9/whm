import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError, ensurePrivateDir } from './registry.js';
import { accountPath, asUser, failureOf, lstatOrNull, SSH_DIR } from './as-user.js';

// File manager ops for the account panel. Every command runs under the
// account's own uid (as-user.js), so permissions and quota are the kernel's
// verdict and root never opens anything inside the home tree: file contents
// travel in on the command's stdin (dd) and out on its stdout as hex (hexdump,
// or od where util-linux lacks it), so no scratch file has to be shared
// between root and the account. The one scratch file, the copy of an archive
// files.extract works from, is written by the account onto a descriptor root
// holds and never has a path the account can reach.

const MiB = 1024 * 1024;
// find expands the two characters "\0" to NUL itself: exec() refuses an argv
// element that carries a real NUL, and a name may contain anything but NUL.
export const FIND_FORMAT = '%y\t%s\t%T@\t%m\t%u\t%f\\0';
const TYPES = { d: 'dir', f: 'file', l: 'symlink', b: 'other', c: 'other', p: 'other', s: 'other' };
const STAT_TYPES = { 'regular file': 'file', 'regular empty file': 'file', directory: 'dir', 'symbolic link': 'symlink' };
const ARCHIVE_FORMATS = { zip: { ext: /\.zip$/i, bins: ['zip'] }, 'tar.gz': { ext: /\.(tar\.gz|tgz)$/i, bins: ['tar', 'gzip'] } };
const EXTRACT_EXT = /\.(zip|tar|tar\.gz|tgz)$/i;
// One in-flight range read costs the agent roughly five times its length
// (hex on stdout, the decoded Buffer, base64 and the JSON frame), so the
// ceiling is what bounds memory whatever the caller asks for.
export const CHUNK_READ_MAX = 2 * MiB;
// The account's .ssh directory is written only by the SSH-key feature, whose
// gates (shell access, session login, no impersonation) a file write or an
// archive would bypass: every writing op takes protectSshDir (default on) and
// the agent refuses a write whose real path lands there, whatever link the
// tenant planted on the way.
export { SSH_DIR };

const base = { username: arg.username };
const protect = { protectSshDir: z.boolean().default(true) };
const pathArg = arg.absPath;
const pathList = (max) => z.array(arg.absPath).min(1).max(max);
const toIso = (epoch) => (Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : null);
const hexToBuffer = (stdout) => Buffer.from(stdout.replace(/\s+/g, ''), 'hex');

function isUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

export function parseFind(stdout) {
  const entries = [];
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const parts = record.split('\t');
    if (parts.length < 6) continue;
    const [type, size, mtime, mode, owner] = parts;
    const name = parts.slice(5).join('\t');
    entries.push({ name, type: TYPES[type] || 'other', size: Number(size) || 0, mtime: toIso(Number(mtime)), mode: mode.padStart(4, '0'), owner });
  }
  return entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
}

function requireBins(bins, what) {
  for (const b of bins) if (!hasBinary(b)) throw new OpError('capability_missing', `${b} is not installed on this server; it is required to ${what}`);
}

// The hex dumper for a range read: hexdump emits two characters per byte,
// od (the fallback) three.
export function readRangeArgv(target, offset, length, tool = hasBinary('hexdump') ? 'hexdump' : 'od') {
  if (tool === 'hexdump') return ['hexdump', ['-v', '-e', '1/1 "%02x"', '-s', String(offset), '-n', String(length), '--', target], 2 * length + MiB];
  return ['od', ['-An', '-v', '-tx1', '-w4096', '-j', String(offset), '-N', String(length), '--', target], 3 * length + MiB];
}

// Reads `length` bytes from `offset` as the account and returns them raw.
async function readRange(info, target, offset, length) {
  const [bin, argv, maxBuffer] = readRangeArgv(target, offset, Math.min(length, CHUNK_READ_MAX));
  const r = await asUser(info, bin, argv, { allowFailure: true, timeoutMs: 120_000, maxBuffer });
  if (r.code !== 0) throw failureOf(r, `read ${target}`);
  return hexToBuffer(r.stdout);
}

function regularFile(target, what) {
  const st = lstatOrNull(target);
  if (!st) throw new OpError('not_found', `${target} does not exist`);
  if (st.isSymbolicLink()) throw new OpError('refused', `${target} is a symbolic link; ${what} refuses to follow it`);
  if (!st.isFile()) throw new OpError('refused', `${target} is not a regular file`);
  return st;
}

function rejectSymlinkTarget(target) {
  const st = lstatOrNull(target);
  if (st?.isSymbolicLink()) throw new OpError('refused', `${target} is a symbolic link; refusing to write through it`);
  if (st && !st.isFile()) throw new OpError('refused', `${target} exists and is not a regular file`);
  return st;
}

function assertNotHome(target, home, what) {
  if (target === home) throw new OpError('refused', `${what} refuses to act on the home directory itself`);
}

const modeBits = (mode) => parseInt(mode, 8);
function assertPlainMode(mode) {
  if (modeBits(mode) & 0o6000) throw new OpError('refused', `mode ${mode} sets the setuid/setgid bits, which the panel never grants`);
}

defineOp('files.list', {
  description: 'List one directory of an account home as the account (never follows symlinks)',
  schema: z.object({ ...base, path: pathArg, limit: z.number().int().min(1).max(10000).default(2000) }).strict(),
  run: async ({ username, path: p, limit }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'read');
    const st = lstatOrNull(target);
    if (!st) throw new OpError('not_found', `${p} does not exist`);
    if (st.isSymbolicLink()) throw new OpError('refused', `${p} is a symbolic link; the file manager does not follow links`);
    if (!st.isDirectory()) throw new OpError('refused', `${p} is not a directory`);
    const r = await asUser(info, 'find', ['-P', target, '-mindepth', '1', '-maxdepth', '1', '-printf', FIND_FORMAT], { allowFailure: true, timeoutMs: 120_000, maxBuffer: 64 * MiB });
    if (r.code !== 0 && !r.stdout) throw failureOf(r, `list ${p}`);
    const entries = parseFind(r.stdout);
    return { path: target, rel: path.relative(home, target) || '.', entries: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit };
  },
});

defineOp('files.stat', {
  description: 'Stat one path of an account home as the account (lstat semantics)',
  schema: z.object({ ...base, path: pathArg }).strict(),
  run: async ({ username, path: p }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'read');
    const r = await asUser(info, 'stat', ['--printf', '%F\t%s\t%Y\t%a\t%U\t%G\t%h', '--', target], { allowFailure: true, timeoutMs: 60_000 });
    if (r.code !== 0) {
      if (/No such file|cannot stat/i.test(r.stderr)) return { path: target, rel: path.relative(home, target) || '.', exists: false };
      throw failureOf(r, `stat ${p}`);
    }
    const [kind, size, mtime, mode, owner, group, links] = r.stdout.split('\t');
    return { path: target, rel: path.relative(home, target) || '.', name: path.basename(target), exists: true, type: STAT_TYPES[kind] || 'other', kind, size: Number(size) || 0, mtime: toIso(Number(mtime)), mode: String(mode).padStart(4, '0'), owner, group, links: Number(links) || 0 };
  },
});

defineOp('files.read', {
  description: 'Read a regular file of an account home as the account for the text editor (utf8; binary flagged, never decoded)',
  schema: z.object({ ...base, path: pathArg, maxBytes: z.number().int().min(1).max(4 * MiB).default(MiB) }).strict(),
  run: async ({ username, path: p, maxBytes }, ctx) => {
    const { info, target } = accountPath(username, p, ctx, 'read');
    const st = regularFile(target, 'the editor');
    const buf = st.size ? await readRange(info, target, 0, Math.min(maxBytes, st.size)) : Buffer.alloc(0);
    const binary = buf.includes(0) || !isUtf8(buf);
    return { path: target, size: st.size, bytes: buf.length, truncated: st.size > maxBytes, binary, content: binary ? null : buf.toString('utf8'), mtime: st.mtime.toISOString(), mode: (st.mode & 0o7777).toString(8).padStart(4, '0') };
  },
});

defineOp('files.chunk_read', {
  description: 'Read a byte range of a regular file in an account home as the account (base64), for downloads',
  schema: z.object({ ...base, path: pathArg, offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), length: z.number().int().min(1).max(CHUNK_READ_MAX).default(CHUNK_READ_MAX) }).strict(),
  run: async ({ username, path: p, offset, length }, ctx) => {
    const { info, target } = accountPath(username, p, ctx, 'read');
    const st = regularFile(target, 'the download');
    const want = Math.max(0, Math.min(length, st.size - offset));
    const buf = want ? await readRange(info, target, offset, want) : Buffer.alloc(0);
    return { path: target, size: st.size, offset, length: buf.length, data: buf.toString('base64'), eof: offset + buf.length >= st.size, mtime: st.mtime.toISOString() };
  },
});

// A write lands in a sibling staging file first and is renamed over the target
// (mv -T, same directory, so the rename is atomic and a failed write, quota
// included, leaves the previous content intact). Each step is its own exec as
// the account; there is no shell to chain them.
export async function stagedWrite(info, home, target, data, mode) {
  const stage = `${target}.whm-${crypto.randomBytes(6).toString('hex')}`;
  try {
    const w = await asUser(info, 'dd', [`of=${stage}`, 'bs=1M', 'status=none'], { input: data, allowFailure: true, timeoutMs: 120_000 });
    if (w.code !== 0) throw failureOf(w, `write ${path.relative(home, target)}`);
    const c = await asUser(info, 'chmod', ['--', mode, stage], { allowFailure: true, timeoutMs: 30_000 });
    if (c.code !== 0) throw failureOf(c, `chmod ${mode} ${path.relative(home, target)}`);
    const m = await asUser(info, 'mv', ['-f', '-T', '--', stage, target], { allowFailure: true, timeoutMs: 60_000 });
    if (m.code !== 0) throw failureOf(m, `replace ${path.relative(home, target)}`);
  } catch (err) {
    await asUser(info, 'rm', ['-f', '--', stage], { allowFailure: true, timeoutMs: 30_000 }).catch(() => {});
    throw err;
  }
}

defineOp('files.write', {
  description: 'Write a whole text file into an account home as the account (staged, then renamed into place; symlink targets refused)',
  schema: z.object({ ...base, ...protect, path: pathArg, content: arg.text, mode: arg.mode.optional() }).strict(),
  run: async ({ username, path: p, content, mode, protectSshDir }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write', { protectSshDir });
    assertNotHome(target, home, 'files.write');
    const existing = rejectSymlinkTarget(target);
    const finalMode = mode ?? (existing ? (existing.mode & 0o777).toString(8).padStart(4, '0') : '0644');
    assertPlainMode(finalMode);
    const data = Buffer.from(content, 'utf8');
    await stagedWrite(info, home, target, data, finalMode);
    return { path: target, bytes: data.length, mode: finalMode, created: !existing };
  },
});

// A chunk lands at a byte offset (dd seek=, oflag=seek_bytes): without
// conv=notrunc dd first truncates the file to that offset, which is how the
// first chunk of an upload starts the file over whichever index it carries;
// every later chunk keeps what the others wrote.
export function chunkWriteArgv(target, offset = 0, truncate = false) {
  return [`of=${target}`, 'bs=1M', `seek=${offset}`, 'oflag=seek_bytes', ...(truncate ? [] : ['conv=notrunc']), 'status=none'];
}

defineOp('files.chunk_write', {
  description: 'Write a base64 chunk at a byte offset of a file in an account home as the account (truncate starts the file over)',
  schema: z.object({ ...base, ...protect, path: pathArg, data: z.string().min(1).max(3 * MiB).regex(/^[A-Za-z0-9+/=]+$/), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), truncate: z.boolean().default(false) }).strict(),
  run: async ({ username, path: p, data, offset, truncate, protectSshDir }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write', { protectSshDir });
    assertNotHome(target, home, 'files.chunk_write');
    rejectSymlinkTarget(target);
    const buf = Buffer.from(data, 'base64');
    const r = await asUser(info, 'dd', chunkWriteArgv(target, offset, truncate), { input: buf, allowFailure: true, timeoutMs: 120_000 });
    if (r.code !== 0) throw failureOf(r, `write ${path.relative(home, target)}`);
    const st = lstatOrNull(target);
    return { path: target, bytes: buf.length, size: st?.isFile() ? st.size : null, truncated: truncate };
  },
});

// The argv guard for getent: the schema admits the same names.
export const GROUP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

// getent answers from every NSS source (LDAP, SSSD...), so /etc/group is read
// directly only on a host without it.
export async function groupId(name, { groupFile = '/etc/group' } = {}) {
  if (!GROUP_NAME.test(name)) throw new OpError('invalid_args', `Invalid group name "${name}"`);
  let line = null;
  if (hasBinary('getent')) {
    const r = await exec('getent', ['group', '--', name], { allowFailure: true, timeoutMs: 30_000 });
    if (r.code === 0) line = r.stdout.split('\n').find((l) => l.startsWith(`${name}:`)) ?? null;
  } else {
    let text = '';
    try { text = fs.readFileSync(groupFile, 'utf8'); } catch { text = ''; }
    line = text.split('\n').find((l) => l.startsWith(`${name}:`)) ?? null;
  }
  const gid = line ? Number(line.split(':')[2]) : NaN;
  if (!Number.isInteger(gid) || gid < 0) throw new OpError('not_found', `Unknown group "${name}"`);
  return gid;
}

// The account cannot hand its directory to a group it is not a member of
// (the web server's), so that one step is root's: the leaf is opened without
// following links and only a directory the account owns changes group.
export function setGroup(target, info, gid) {
  let fd;
  try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); } catch (err) {
    throw new OpError('refused', `${target} is not a plain directory; its group was not changed (${err.code})`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.uid !== info.uid) throw new OpError('refused', `${target} is not owned by ${info.username}; its group was not changed`);
    fs.fchownSync(fd, st.uid, gid);
  } finally { fs.closeSync(fd); }
}

// A directory the op just created is the account's by construction, so a
// refused hand-over there is an error; a leaf that already existed (a restored
// docroot root owns) keeps its owner and the refusal is returned as a note.
export function handOverGroup(target, info, gid, { existed = false } = {}) {
  try { setGroup(target, info, gid); return null; } catch (err) {
    if (!existed || !(err instanceof OpError) || err.code !== 'refused' || !lstatOrNull(target)?.isDirectory()) throw err;
    return err.message;
  }
}

defineOp('files.mkdir', {
  description: 'Create a directory (and parents) inside an account home as the account; optionally hand the leaf to a group such as the web server\'s',
  schema: z.object({ ...base, ...protect, path: pathArg, mode: arg.mode.default('0755'), group: z.string().regex(GROUP_NAME).optional() }).strict(),
  run: async ({ username, path: p, mode, group, protectSshDir }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write', { protectSshDir });
    assertNotHome(target, home, 'files.mkdir');
    assertPlainMode(mode);
    const gid = group ? await groupId(group) : null;
    const existed = Boolean(lstatOrNull(target)?.isDirectory());
    const r = await asUser(info, 'mkdir', ['-p', '-m', mode, '--', target], { allowFailure: true, timeoutMs: 60_000 });
    if (r.code !== 0) throw failureOf(r, `create ${path.relative(home, target)}`);
    const note = gid != null ? handOverGroup(target, info, gid, { existed }) : null;
    return { path: target, mode, group: note ? null : group ?? null, note };
  },
});

defineOp('files.move', {
  description: 'Rename or move a path inside an account home as the account (never overwrites unless asked)',
  schema: z.object({ ...base, ...protect, from: pathArg, to: pathArg, overwrite: z.boolean().default(false) }).strict(),
  run: async ({ username, from, to, overwrite, protectSshDir }, ctx) => {
    const src = accountPath(username, from, ctx, 'write', { protectSshDir });
    const dst = accountPath(username, to, ctx, 'write', { protectSshDir });
    assertNotHome(src.target, src.home, 'files.move');
    assertNotHome(dst.target, dst.home, 'files.move');
    if (dst.target === src.target || dst.target.startsWith(`${src.target}/`)) throw new OpError('refused', 'A path cannot be moved into itself');
    if (!overwrite && lstatOrNull(dst.target)) throw new OpError('exists', `${path.relative(dst.home, dst.target)} already exists`);
    const r = await asUser(src.info, 'mv', [overwrite ? '-f' : '-n', '-T', '--', src.target, dst.target], { allowFailure: true, timeoutMs: 600_000 });
    if (r.code !== 0) throw failureOf(r, `move ${path.relative(src.home, src.target)}`);
    if (!overwrite && lstatOrNull(src.target) && lstatOrNull(dst.target)) throw new OpError('exists', `${path.relative(dst.home, dst.target)} already exists`);
    return { from: src.target, to: dst.target };
  },
});

defineOp('files.copy', {
  description: 'Copy a path inside an account home as the account (archive mode, symlinks kept as links)',
  timeoutMs: 600_000,
  schema: z.object({ ...base, ...protect, from: pathArg, to: pathArg }).strict(),
  run: async ({ username, from, to, protectSshDir }, ctx) => {
    const src = accountPath(username, from, ctx, 'read');
    const dst = accountPath(username, to, ctx, 'write', { protectSshDir });
    assertNotHome(src.target, src.home, 'files.copy');
    assertNotHome(dst.target, dst.home, 'files.copy');
    if (dst.target === src.target || dst.target.startsWith(`${src.target}/`)) throw new OpError('refused', 'A path cannot be copied into itself');
    if (lstatOrNull(dst.target)) throw new OpError('exists', `${path.relative(dst.home, dst.target)} already exists`);
    const r = await asUser(src.info, 'cp', ['-a', '--no-dereference', '--', src.target, dst.target], { allowFailure: true, timeoutMs: 600_000 });
    if (r.code !== 0) throw failureOf(r, `copy ${path.relative(src.home, src.target)}`);
    return { from: src.target, to: dst.target };
  },
});

defineOp('files.remove', {
  description: 'Delete paths inside an account home as the account (recursive, one file system; the home itself is refused)',
  destructive: true,
  timeoutMs: 600_000,
  schema: z.object({ ...base, ...protect, paths: pathList(200) }).strict(),
  run: async ({ username, paths, protectSshDir }, ctx) => {
    const targets = [];
    let info;
    let home;
    for (const p of paths) {
      const r = accountPath(username, p, ctx, 'write', { protectSshDir });
      ({ info, home } = r);
      assertNotHome(r.target, home, 'files.remove');
      if (ctx.allowedRoots.includes(r.target)) throw new OpError('refused', `${p} is a managed root and is never deleted`);
      targets.push(r.target);
    }
    const r = await asUser(info, 'rm', ['-rf', '--one-file-system', '--', ...targets], { allowFailure: true, timeoutMs: 600_000 });
    if (r.code !== 0) throw failureOf(r, 'delete');
    return { removed: targets.map((t) => path.relative(home, t)) };
  },
});

defineOp('files.chmod', {
  description: 'Change permissions inside an account home as the account (recursion never follows symlinks)',
  timeoutMs: 600_000,
  schema: z.object({ ...base, ...protect, path: pathArg, mode: arg.mode, recursive: z.boolean().default(false) }).strict(),
  run: async ({ username, path: p, mode, recursive, protectSshDir }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write', { protectSshDir });
    assertPlainMode(mode);
    const r = recursive
      ? await asUser(info, 'find', ['-P', target, '!', '-type', 'l', '-exec', 'chmod', mode, '--', '{}', '+'], { allowFailure: true, timeoutMs: 600_000 })
      : await asUser(info, 'chmod', ['--', mode, target], { allowFailure: true, timeoutMs: 60_000 });
    if (r.code !== 0) throw failureOf(r, `chmod ${path.relative(home, target) || '.'}`);
    return { path: target, mode, recursive };
  },
});

defineOp('files.du', {
  description: 'Disk usage of a directory inside an account home as the account (du -k, limited depth)',
  timeoutMs: 600_000,
  schema: z.object({ ...base, path: pathArg, depth: z.number().int().min(0).max(2).default(1) }).strict(),
  run: async ({ username, path: p, depth }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'read');
    const r = await asUser(info, 'du', ['-k', `--max-depth=${depth}`, '--one-file-system', '-P', '--', target], { allowFailure: true, timeoutMs: 600_000, maxBuffer: 64 * MiB });
    if (r.code !== 0 && !r.stdout) throw failureOf(r, `measure ${path.relative(home, target) || '.'}`);
    const entries = [];
    let totalKb = 0;
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^(\d+)\t(.*)$/);
      if (!m) continue;
      const rel = path.relative(home, m[2]) || '.';
      const kb = Number(m[1]);
      if (m[2] === target) totalKb = kb;
      else entries.push({ path: rel, kb });
    }
    entries.sort((a, b) => b.kb - a.kb);
    return { path: target, rel: path.relative(home, target) || '.', depth, totalKb, entries, partial: r.code !== 0 };
  },
});

// Archive members are relativised to the home and prefixed with "./" so no
// argv element can start with "-" whatever the file is called.
function relativeMembers(home, targets) {
  return targets.map((t) => {
    const rel = path.relative(home, t);
    if (!rel || rel === '.') throw new OpError('refused', 'The home directory itself cannot be archived');
    return `./${rel}`;
  });
}

defineOp('files.archive', {
  description: 'Compress paths of an account home into a zip or tar.gz archive, as the account at low priority',
  timeoutMs: 1_800_000,
  schema: z.object({ ...base, ...protect, paths: pathList(500), dest: pathArg, format: z.enum(['zip', 'tar.gz']) }).strict(),
  run: async ({ username, paths, dest, format, protectSshDir }, ctx) => {
    const spec = ARCHIVE_FORMATS[format];
    requireBins(spec.bins, `create ${format} archives`);
    const out = accountPath(username, dest, ctx, 'write', { protectSshDir });
    assertNotHome(out.target, out.home, 'files.archive');
    if (!spec.ext.test(out.target)) throw new OpError('invalid_args', `The destination must end in .${format}`);
    if (lstatOrNull(out.target)) throw new OpError('exists', `${path.relative(out.home, out.target)} already exists`);
    const targets = paths.map((p) => accountPath(username, p, ctx, 'read').target);
    if (targets.some((t) => out.target === t || out.target.startsWith(`${t}/`))) throw new OpError('refused', 'The archive cannot be written inside a path it contains');
    const members = relativeMembers(out.home, targets);
    const r = format === 'zip'
      ? await asUser(out.info, 'zip', ['-r', '-y', '-q', out.target, ...members], { cwd: out.home, allowFailure: true, timeoutMs: 1_800_000, nice: true })
      : await asUser(out.info, 'tar', ['--create', '--gzip', '--file', out.target, '--', ...members], { cwd: out.home, allowFailure: true, timeoutMs: 1_800_000, nice: true });
    if (r.code !== 0 && !(format === 'zip' && r.code === 12)) throw failureOf(r, `archive ${path.relative(out.home, out.target)}`);
    const st = lstatOrNull(out.target);
    return { dest: out.target, format, members: members.length, size: st?.isFile() ? st.size : null };
  },
});

// `tar --list --verbose` and `unzip -Z` (zipinfo) lines, reduced to what the
// member check needs: the entry type, its name and, for tar symlinks, the
// target. Lines that are not entries (zipinfo's header and trailer) are skipped.
const TAR_LIST_RE = /^([-dlhbcps])[-rwxsStT]{9}\s+\S+\s+\d+\s+\d{4}-\d\d-\d\d\s+\d\d:\d\d(?::\d\d)?\s+(.*)$/;
const ZIP_LIST_RE = /^([-dl])\S+\s+\d+\.\d+\s+\S+\s+\d+\s+\S\S\s+\S+\s+\S+\s+\S+\s+(.*)$/;
export function parseTarListing(stdout) {
  const members = [];
  for (const line of String(stdout).split('\n')) {
    const m = line.match(TAR_LIST_RE);
    if (!m) continue;
    let name = m[2];
    let target = null;
    if (m[1] === 'l') {
      const at = name.lastIndexOf(' -> ');
      if (at >= 0) { target = name.slice(at + 4); name = name.slice(0, at); }
    } else if (m[1] === 'h') {
      const at = name.lastIndexOf(' link to ');
      if (at >= 0) { target = name.slice(at + 9); name = name.slice(0, at); }
    }
    members.push({ type: m[1] === 'l' ? 'symlink' : m[1] === 'h' ? 'hardlink' : m[1] === 'd' ? 'dir' : 'file', name, target });
  }
  return members;
}
export function parseZipListing(stdout) {
  const members = [];
  for (const line of String(stdout).split('\n')) {
    const m = line.match(ZIP_LIST_RE);
    if (!m) continue;
    members.push({ type: m[1] === 'l' ? 'symlink' : m[1] === 'd' ? 'dir' : 'file', name: m[2], target: null });
  }
  return members;
}

const underDir = (p, dir) => p === dir || p.startsWith(`${dir}/`);
const hasDotDot = (name) => name.split('/').includes('..');
const landsInSsh = (abs, home) => underDir(abs, path.join(home, SSH_DIR));
const components = (p) => p.split('/').filter((c) => c && c !== '.');
const MAX_LINK_HOPS = 40;

// Where a member name really lands once tar has written it: GNU tar creates
// a symlink member as soon as it is read (only absolute and ".." targets are
// deferred), so a later member can be written through it, and through any
// link already on disk under the destination. Components are resolved left to
// right the way the kernel does, substituting the archive's own links
// (`links`, name -> target) and the on-disk ones (`readLink(abs)`).
export function resolveMemberPath(name, { dest, links, readLink = () => null }) {
  let cur = dest;
  let parts = components(name);
  let hops = 0;
  while (parts.length) {
    const part = parts.shift();
    if (part === '..') { cur = path.dirname(cur); continue; }
    const next = path.join(cur, part);
    const target = links.get(path.relative(dest, next)) ?? readLink(next);
    if (target == null) { cur = next; continue; }
    if (++hops > MAX_LINK_HOPS) throw new OpError('refused', `the archive member "${name}" goes through too many symbolic links`);
    if (target.startsWith('/')) cur = '/';
    parts = [...components(target), ...parts];
  }
  return cur;
}

// Refuses an archive whose members would leave the destination (absolute or
// ".." names, links pointing out of it, directly or through other links) or
// land in the home's .ssh directory, the one place the file manager never
// writes unless the caller could write it directly; a zip symlink's target is
// not listed, so it is refused outright while .ssh is protected. `readLink`
// answers the target of a symlink already on disk (null for anything else).
export function checkArchiveMembers(members, { home, dest, allowSshDir = false, readLink = () => null }) {
  const links = new Map();
  for (const m of members) if (m.type === 'symlink' && m.target != null) links.set(components(m.name).join('/'), m.target);
  const opts = { dest, links, readLink };
  const sshParent = (p) => p === home || home.startsWith(`${p}/`);
  for (const m of members) {
    const name = m.name.replace(/\/+$/, '');
    if (!name || name === '.') continue;
    if (name.startsWith('/') || hasDotDot(name)) throw new OpError('refused', `the archive member "${m.name}" would be written outside the destination`);
    const abs = path.resolve(dest, name);
    if (!underDir(abs, dest)) throw new OpError('refused', `the archive member "${m.name}" would be written outside the destination`);
    if (!allowSshDir && landsInSsh(abs, home)) throw new OpError('refused', `the archive member "${m.name}" would be written into ${SSH_DIR}, which only the SSH-key feature may change`);
    // tar writes a file or link member at its own name (an existing entry is
    // unlinked first) but descends into an existing directory, link or not.
    const real = m.type === 'dir' ? resolveMemberPath(name, opts) : path.join(resolveMemberPath(path.dirname(name), opts), path.basename(name));
    if (!underDir(real, home)) throw new OpError('refused', `the archive member "${m.name}" would be written outside the home directory through a symbolic link`);
    if (!allowSshDir && landsInSsh(real, home)) throw new OpError('refused', `the archive member "${m.name}" would be written into ${SSH_DIR} through a symbolic link`);
    if (m.type !== 'symlink' && m.type !== 'hardlink') continue;
    if (m.target == null) {
      if (!allowSshDir) throw new OpError('refused', `the archive member "${m.name}" is a symbolic link; zip archives with links cannot be extracted for this account`);
      continue;
    }
    // A hard link names another member (relative to the destination); a
    // symlink's target is relative to the link's own directory.
    const linked = m.type === 'hardlink'
      ? (m.target.startsWith('/') || hasDotDot(m.target) ? '/' : resolveMemberPath(m.target, opts))
      : (m.target.startsWith('/') ? '/' : resolveMemberPath(`${path.dirname(name)}/${m.target}`, opts));
    if (!underDir(linked, dest)) throw new OpError('refused', `the archive member "${m.name}" is a ${m.type === 'hardlink' ? 'hard' : 'symbolic'} link pointing outside the destination`);
    if (!allowSshDir && (landsInSsh(linked, home) || (m.type === 'symlink' && sshParent(linked)))) throw new OpError('refused', `the archive member "${m.name}" is a ${m.type === 'hardlink' ? 'hard' : 'symbolic'} link into ${SSH_DIR}${m.type === 'symlink' && sshParent(linked) ? "'s parent directory" : ''}`);
  }
  return members.length;
}

// The on-disk links under a destination, read root-side without following
// anything (lstat + readlink): what tar would write through.
export function diskLinkReader() {
  return (abs) => {
    const st = lstatOrNull(abs);
    if (!st?.isSymbolicLink()) return null;
    try { return fs.readlinkSync(abs); } catch { return null; }
  };
}

// A metadata fingerprint of the home's .ssh directory (lstat of the directory
// and of everything inside it, two levels deep). Taken before and after an
// extraction while .ssh is protected: a difference means a member reached
// .ssh regardless of the pre-extraction listing (a swap of the archive in
// between, a link the check did not model), and the entries that changed are
// removed as the account before the op fails.
const FINGERPRINT_MAX = 500;
const statSig = (st) => `${st.ino}:${(st.mode & 0o7777).toString(8)}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}`;
export function sshFingerprint(home) {
  const dir = path.join(home, SSH_DIR);
  const entries = new Map();
  const st = lstatOrNull(dir);
  if (!st) return { exists: false, self: null, entries };
  const walk = (base, depth) => {
    let names = [];
    try { names = fs.readdirSync(base); } catch { return; }
    for (const name of names.sort()) {
      if (entries.size >= FINGERPRINT_MAX) return;
      const abs = path.join(base, name);
      const s = lstatOrNull(abs);
      if (!s) continue;
      entries.set(path.relative(dir, abs), statSig(s));
      if (s.isDirectory() && depth < 2) walk(abs, depth + 1);
    }
  };
  if (st.isDirectory()) walk(dir, 1);
  return { exists: true, self: { ino: st.ino, mode: (st.mode & 0o7777).toString(8), type: st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f' }, entries };
}

// What changed between two fingerprints: `remove` lists the new or replaced
// entries ('.' when .ssh itself appeared or was replaced), `mode` the previous
// mode of .ssh when only its permissions changed.
export function sshChanges(before, after) {
  if (!after.exists) return { remove: [], mode: null };
  if (!before.exists || before.self.ino !== after.self.ino || before.self.type !== after.self.type) return { remove: ['.'], mode: null };
  const changed = [];
  for (const [name, sig] of after.entries) if (before.entries.get(name) !== sig) changed.push(name);
  // Nested changes are covered by their top-level entry.
  const remove = changed.filter((n) => !changed.some((o) => o !== n && n.startsWith(`${o}/`)));
  return { remove, mode: before.self.mode !== after.self.mode ? before.self.mode : null };
}

async function revertSshChanges(info, home, before) {
  const { remove, mode } = sshChanges(before, sshFingerprint(home));
  if (!remove.length && mode == null) return null;
  const dir = path.join(home, SSH_DIR);
  if (remove.length) await asUser(info, 'rm', ['-rf', '--one-file-system', '--', ...remove.map((n) => (n === '.' ? dir : path.join(dir, n)))], { allowFailure: true, timeoutMs: 60_000 }).catch(() => {});
  if (mode != null && !remove.includes('.')) await asUser(info, 'chmod', ['--', mode.padStart(4, '0'), dir], { allowFailure: true, timeoutMs: 30_000 }).catch(() => {});
  return [...remove, ...(mode != null ? [`mode ${mode}`] : [])];
}

export const listArchiveArgv = (zip, archive) => (zip ? ['unzip', ['-Z', '--', archive]] : ['tar', ['--list', '--verbose', '--file', archive]]);

// The member check and the extraction must see the same bytes, and the file
// in the home is the account's to replace at any moment. So the account's own
// dd (its permissions decide what it may read) copies the archive once onto a
// descriptor of a 0600 scratch file root created under /tmp/whm, and the
// listing and the extraction both read that copy through an inherited
// descriptor: the account never has a path to it. tar reads "-" straight from
// fd 0; unzip has to reopen its archive to seek, which /dev/fd/0 only allows
// when the inode is readable to it, so a zip copy is root:<account gid> 0640
// (still unreachable by path and unwritable). The copy is bounded in size and
// removed whatever happens.
const EXTRACT_TMP_DIR = '/tmp/whm';
export const EXTRACT_MAX_BYTES = 4 * 1024 * MiB;
export const STDIN_ARCHIVE = { zip: '/dev/fd/0', tar: '-' };
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;

function scratchArchive(ctx) {
  ctx.assertAllowedPath(EXTRACT_TMP_DIR, 'write');
  const dir = ensurePrivateDir(EXTRACT_TMP_DIR);
  const file = path.join(dir, `extract-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  return { file, fd };
}

async function withScratchFd(file, fn) {
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
  try { return await fn(fd); } finally { fs.closeSync(fd); }
}

defineOp('files.extract', {
  description: 'Extract a zip or tar archive of an account home into a directory of that home, as the account at low priority, from a copy root holds for the whole run (members are listed first; those leaving the destination or landing in .ssh, directly or through links, are refused; .ssh is checked again afterwards)',
  timeoutMs: 1_800_000,
  schema: z.object({ ...base, archive: pathArg, dest: pathArg, allowSshDir: z.boolean().default(false) }).strict(),
  run: async ({ username, archive, dest, allowSshDir }, ctx) => {
    const src = accountPath(username, archive, ctx, 'read');
    const out = accountPath(username, dest, ctx, 'write');
    const name = path.basename(src.target);
    const m = name.match(EXTRACT_EXT);
    if (!m) throw new OpError('unsupported', `${name} is not a .zip, .tar, .tar.gz or .tgz archive`);
    const zip = m[1].toLowerCase() === 'zip';
    requireBins([zip ? 'unzip' : 'tar', 'dd'], 'extract archives');
    const st = regularFile(src.target, 'extract');
    const tooLarge = () => new OpError('refused', `${name} is larger than ${EXTRACT_MAX_BYTES / MiB} MiB, the most an archive extracted here may be`);
    if (st.size > EXTRACT_MAX_BYTES) throw tooLarge();
    const scratch = scratchArchive(ctx);
    try {
      const copy = await asUser(out.info, 'dd', [`if=${src.target}`, 'bs=1M', 'status=none', 'iflag=count_bytes', `count=${EXTRACT_MAX_BYTES + 1}`], { stdoutFd: scratch.fd, allowFailure: true, timeoutMs: 1_800_000, nice: true });
      if (copy.code !== 0) throw failureOf(copy, `read ${name}`);
      const copied = fs.fstatSync(scratch.fd);
      if (!copied.isFile()) throw new OpError('refused', `${name} could not be copied for extraction`);
      if (copied.size > EXTRACT_MAX_BYTES) throw tooLarge();
      if (zip) {
        try { fs.fchownSync(scratch.fd, 0, out.info.gid); fs.fchmodSync(scratch.fd, 0o640); } catch (err) { throw new OpError('refused', `the copy of ${name} could not be shared with ${username} (${err.code})`); }
      }
      fs.closeSync(scratch.fd);
      scratch.fd = null;
      const [listBin, listArgv] = listArchiveArgv(zip, zip ? STDIN_ARCHIVE.zip : STDIN_ARCHIVE.tar);
      const listing = await withScratchFd(scratch.file, (fd) => asUser(out.info, listBin, listArgv, { stdinFd: fd, allowFailure: true, timeoutMs: 600_000, maxBuffer: 64 * MiB, nice: true }));
      if (listing.code !== 0 && !(zip && listing.code === 1)) throw failureOf(listing, `read ${name}`);
      const members = zip ? parseZipListing(listing.stdout) : parseTarListing(listing.stdout);
      checkArchiveMembers(members, { home: out.home, dest: out.target, allowSshDir, readLink: diskLinkReader() });
      const mk = await asUser(out.info, 'mkdir', ['-p', '--', out.target], { allowFailure: true, timeoutMs: 60_000 });
      if (mk.code !== 0) throw failureOf(mk, `create ${path.relative(out.home, out.target) || '.'}`);
      const before = allowSshDir ? null : sshFingerprint(out.home);
      const r = await withScratchFd(scratch.file, (fd) => (zip
        ? asUser(out.info, 'unzip', ['-o', '-q', STDIN_ARCHIVE.zip, '-d', out.target], { stdinFd: fd, cwd: out.target, allowFailure: true, timeoutMs: 1_800_000, nice: true })
        : asUser(out.info, 'tar', ['--extract', '--file', STDIN_ARCHIVE.tar, '-C', out.target, '--no-same-owner', '--warning=no-unknown-keyword'], { stdinFd: fd, cwd: out.target, allowFailure: true, timeoutMs: 1_800_000, nice: true })));
      if (before) {
        const reverted = await revertSshChanges(out.info, out.home, before);
        if (reverted) throw new OpError('refused', `the archive changed ${SSH_DIR} while it was extracted (${reverted.join(', ')}); those changes were removed`);
      }
      const warnings = r.stderr.split('\n').filter((l) => l.trim()).slice(0, 50);
      if (r.code !== 0 && !(zip && r.code === 1)) throw failureOf(r, `extract ${name}`);
      return { archive: src.target, dest: out.target, format: zip ? 'zip' : 'tar', members: members.length, warnings };
    } finally {
      if (scratch.fd != null) { try { fs.closeSync(scratch.fd); } catch { /* closed */ } }
      try { fs.unlinkSync(scratch.file); } catch { /* gone */ }
    }
  },
});
