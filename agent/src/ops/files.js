import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { accountPath, asUser, failureOf, lstatOrNull } from './as-user.js';

// File manager ops for the account panel. Every command runs under the
// account's own uid (as-user.js), so permissions and quota are the kernel's
// verdict and root never opens anything inside the home tree: file contents
// travel in on the command's stdin (dd) and out on its stdout as hex (od), so
// no scratch file has to be shared between root and the account.

const MiB = 1024 * 1024;
const FIND_FORMAT = '%y\t%s\t%T@\t%m\t%u\t%f\0';
const TYPES = { d: 'dir', f: 'file', l: 'symlink', b: 'other', c: 'other', p: 'other', s: 'other' };
const STAT_TYPES = { 'regular file': 'file', 'regular empty file': 'file', directory: 'dir', 'symbolic link': 'symlink' };
const ARCHIVE_FORMATS = { zip: { ext: /\.zip$/i, bins: ['zip'] }, 'tar.gz': { ext: /\.(tar\.gz|tgz)$/i, bins: ['tar', 'gzip'] } };
const EXTRACT_EXT = /\.(zip|tar|tar\.gz|tgz)$/i;

const base = { username: arg.username };
const pathArg = arg.absPath;
const pathList = (max) => z.array(arg.absPath).min(1).max(max);
const toIso = (epoch) => (Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : null);
const hexToBuffer = (stdout) => Buffer.from(stdout.replace(/\s+/g, ''), 'hex');

function isUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

function parseFind(stdout) {
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

// Reads `length` bytes from `offset` as the account and returns them raw.
async function readRange(info, target, offset, length) {
  const r = await asUser(info, 'od', ['-An', '-v', '-tx1', '-w4096', '-j', String(offset), '-N', String(length), '--', target], { allowFailure: true, timeoutMs: 120_000, maxBuffer: 4 * length + MiB });
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
  schema: z.object({ ...base, path: pathArg, offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), length: z.number().int().min(1).max(8 * MiB).default(8 * MiB) }).strict(),
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
async function stagedWrite(info, home, target, data, mode) {
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
  schema: z.object({ ...base, path: pathArg, content: arg.text, mode: arg.mode.optional() }).strict(),
  run: async ({ username, path: p, content, mode }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write');
    assertNotHome(target, home, 'files.write');
    const existing = rejectSymlinkTarget(target);
    const finalMode = mode ?? (existing ? (existing.mode & 0o777).toString(8).padStart(4, '0') : '0644');
    assertPlainMode(finalMode);
    const data = Buffer.from(content, 'utf8');
    await stagedWrite(info, home, target, data, finalMode);
    return { path: target, bytes: data.length, mode: finalMode, created: !existing };
  },
});

defineOp('files.chunk_write', {
  description: 'Append a base64 chunk to a file in an account home as the account (truncate starts the file over)',
  schema: z.object({ ...base, path: pathArg, data: z.string().min(1).max(3 * MiB).regex(/^[A-Za-z0-9+/=]+$/), truncate: z.boolean().default(false) }).strict(),
  run: async ({ username, path: p, data, truncate }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write');
    assertNotHome(target, home, 'files.chunk_write');
    rejectSymlinkTarget(target);
    const buf = Buffer.from(data, 'base64');
    const argv = truncate ? [`of=${target}`, 'bs=1M', 'status=none'] : [`of=${target}`, 'bs=1M', 'conv=notrunc', 'oflag=append', 'status=none'];
    const r = await asUser(info, 'dd', argv, { input: buf, allowFailure: true, timeoutMs: 120_000 });
    if (r.code !== 0) throw failureOf(r, `write ${path.relative(home, target)}`);
    const st = lstatOrNull(target);
    return { path: target, bytes: buf.length, size: st?.isFile() ? st.size : null, truncated: truncate };
  },
});

defineOp('files.mkdir', {
  description: 'Create a directory (and parents) inside an account home as the account',
  schema: z.object({ ...base, path: pathArg, mode: arg.mode.default('0755') }).strict(),
  run: async ({ username, path: p, mode }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write');
    assertNotHome(target, home, 'files.mkdir');
    assertPlainMode(mode);
    const r = await asUser(info, 'mkdir', ['-p', '-m', mode, '--', target], { allowFailure: true, timeoutMs: 60_000 });
    if (r.code !== 0) throw failureOf(r, `create ${path.relative(home, target)}`);
    return { path: target, mode };
  },
});

defineOp('files.move', {
  description: 'Rename or move a path inside an account home as the account (never overwrites unless asked)',
  schema: z.object({ ...base, from: pathArg, to: pathArg, overwrite: z.boolean().default(false) }).strict(),
  run: async ({ username, from, to, overwrite }, ctx) => {
    const src = accountPath(username, from, ctx, 'write');
    const dst = accountPath(username, to, ctx, 'write');
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
  schema: z.object({ ...base, from: pathArg, to: pathArg }).strict(),
  run: async ({ username, from, to }, ctx) => {
    const src = accountPath(username, from, ctx, 'read');
    const dst = accountPath(username, to, ctx, 'write');
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
  schema: z.object({ ...base, paths: pathList(200) }).strict(),
  run: async ({ username, paths }, ctx) => {
    const targets = [];
    let info;
    let home;
    for (const p of paths) {
      const r = accountPath(username, p, ctx, 'write');
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
  schema: z.object({ ...base, path: pathArg, mode: arg.mode, recursive: z.boolean().default(false) }).strict(),
  run: async ({ username, path: p, mode, recursive }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write');
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
  schema: z.object({ ...base, paths: pathList(500), dest: pathArg, format: z.enum(['zip', 'tar.gz']) }).strict(),
  run: async ({ username, paths, dest, format }, ctx) => {
    const spec = ARCHIVE_FORMATS[format];
    requireBins(spec.bins, `create ${format} archives`);
    const out = accountPath(username, dest, ctx, 'write');
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

defineOp('files.extract', {
  description: 'Extract a zip or tar archive of an account home into a directory of that home, as the account at low priority',
  timeoutMs: 1_800_000,
  schema: z.object({ ...base, archive: pathArg, dest: pathArg }).strict(),
  run: async ({ username, archive, dest }, ctx) => {
    const src = accountPath(username, archive, ctx, 'read');
    const out = accountPath(username, dest, ctx, 'write');
    const m = path.basename(src.target).match(EXTRACT_EXT);
    if (!m) throw new OpError('unsupported', `${path.basename(src.target)} is not a .zip, .tar, .tar.gz or .tgz archive`);
    const zip = m[1].toLowerCase() === 'zip';
    requireBins(zip ? ['unzip'] : ['tar'], 'extract archives');
    regularFile(src.target, 'extract');
    const mk = await asUser(out.info, 'mkdir', ['-p', '--', out.target], { allowFailure: true, timeoutMs: 60_000 });
    if (mk.code !== 0) throw failureOf(mk, `create ${path.relative(out.home, out.target) || '.'}`);
    const r = zip
      ? await asUser(out.info, 'unzip', ['-o', '-q', src.target, '-d', out.target], { cwd: out.target, allowFailure: true, timeoutMs: 1_800_000, nice: true })
      : await asUser(out.info, 'tar', ['--extract', '--file', src.target, '-C', out.target, '--no-same-owner', '--warning=no-unknown-keyword'], { cwd: out.target, allowFailure: true, timeoutMs: 1_800_000, nice: true });
    const warnings = r.stderr.split('\n').filter((l) => l.trim()).slice(0, 50);
    if (r.code !== 0 && !(zip && r.code === 1)) throw failureOf(r, `extract ${path.basename(src.target)}`);
    return { archive: src.target, dest: out.target, format: zip ? 'zip' : 'tar', warnings };
  },
});
