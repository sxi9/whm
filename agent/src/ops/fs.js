import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { exec } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { assertRealPath } from './acct.js';

// The allowed-root check is lexical. Every op below that creates, chmods,
// chowns or rsyncs inside an account home therefore also requires the path
// to be its own real path: a link a tenant planted (public_html -> /etc,
// addon docroot -> /var/lib/whm) would otherwise be followed by root.
// Components above an allowed root are the administrator's layout and are
// not checked; a root that is itself a link is accepted by assertRealPath
// when root owns it.
const insideRoot = (p, ctx) => ctx.allowedRoots.some((root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`));

// For a path that may not exist yet (mkdir -p, an rsync destination): the
// deepest existing prefix must not go through a link below an allowed root.
function assertExistingPathReal(resolved, ctx, mode) {
  let existing = resolved;
  let st;
  for (;;) {
    try { st = fs.lstatSync(existing); break; } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  if (!insideRoot(existing, ctx)) return null;
  if (st.isSymbolicLink()) {
    try { fs.realpathSync(existing); } catch { throw new OpError('refused', `${existing} is a dangling symbolic link; refusing to create through it`); }
  }
  return assertRealPath(existing, ctx, mode);
}

function ownership(owner, group) {
  const passwd = fs.readFileSync('/etc/passwd', 'utf8').split('\n');
  const groups = fs.readFileSync('/etc/group', 'utf8').split('\n');
  const u = passwd.find((l) => l.startsWith(`${owner}:`))?.split(':');
  if (!u) throw new OpError('not_found', `Unknown user "${owner}"`);
  const g = group ? groups.find((l) => l.startsWith(`${group}:`))?.split(':') : null;
  if (group && !g) throw new OpError('not_found', `Unknown group "${group}"`);
  return { uid: Number(u[2]), gid: g ? Number(g[2]) : Number(u[3]) };
}

const ownerSchema = z.object({ owner: arg.username.or(z.literal('root')).optional(), group: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(), mode: arg.mode.optional() });

defineOp('fs.stat', {
  description: 'File or directory metadata',
  schema: z.object({ path: arg.absPath }).strict(),
  run: async ({ path: p }, ctx) => {
    ctx.assertAllowedPath(p, 'read');
    try {
      const st = fs.statSync(p);
      return { path: p, exists: true, isDirectory: st.isDirectory(), size: st.size, mode: (st.mode & 0o7777).toString(8), uid: st.uid, gid: st.gid, mtime: st.mtime.toISOString() };
    } catch (err) {
      if (err.code === 'ENOENT') return { path: p, exists: false };
      throw err;
    }
  },
});

defineOp('fs.mkdir', {
  description: 'Create a directory (recursively) with owner and mode',
  schema: z.object({ path: arg.absPath }).merge(ownerSchema).strict(),
  run: async ({ path: p, owner, group, mode }, ctx) => {
    const target = ctx.assertAllowedPath(p, 'write');
    const ids = owner ? ownership(owner, group) : null;
    assertExistingPathReal(target, ctx, 'write');
    fs.mkdirSync(target, { recursive: true, mode: mode ? parseInt(mode, 8) : 0o755 });
    if (mode || ids) {
      // The mode and owner are applied through a descriptor that refuses to
      // open a link, so a swap between the check and here changes nothing else.
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        if (mode) fs.fchmodSync(fd, parseInt(mode, 8));
        if (ids) fs.fchownSync(fd, ids.uid, ids.gid);
      } finally { fs.closeSync(fd); }
    }
    return { path: p };
  },
});

defineOp('fs.write_file', {
  description: 'Write a file atomically with owner and mode (configs, templates, zone files)',
  schema: z.object({ path: arg.absPath, content: arg.text, backup: z.boolean().default(true) }).merge(ownerSchema).strict(),
  run: async ({ path: p, content, backup, owner, group, mode }, ctx) => {
    ctx.assertAllowedPath(p, 'write');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // The backup and the temporary file are created exclusively: a link an
    // account planted under one of these names fails instead of being followed
    // by root, and the final rename replaces (never follows) whatever sits at p.
    if (backup && fs.existsSync(p)) {
      const bak = `${p}.whm-bak`;
      fs.rmSync(bak, { force: true });
      fs.copyFileSync(p, bak, fs.constants.COPYFILE_EXCL);
    }
    const tmp = `${p}.whm-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, content, { mode: mode ? parseInt(mode, 8) : 0o644, flag: 'wx' });
    if (owner) { const { uid, gid } = ownership(owner, group); fs.lchownSync(tmp, uid, gid); }
    fs.renameSync(tmp, p);
    return { path: p, bytes: Buffer.byteLength(content) };
  },
});

defineOp('fs.read_file', {
  description: 'Read a file from an allowed location',
  schema: z.object({ path: arg.absPath, maxBytes: z.number().int().min(1).max(32 * 1024 * 1024).default(4 * 1024 * 1024) }).strict(),
  run: async ({ path: p, maxBytes }, ctx) => {
    ctx.assertAllowedPath(p, 'read');
    const st = fs.statSync(p);
    if (st.size > maxBytes) throw new OpError('too_large', `${p} is ${st.size} bytes; limit is ${maxBytes}`);
    return { path: p, content: fs.readFileSync(p, 'utf8'), size: st.size };
  },
});

defineOp('fs.remove', {
  description: 'Remove a file or directory tree inside an allowed root',
  destructive: true,
  schema: z.object({ path: arg.absPath, recursive: z.boolean().default(false) }).strict(),
  run: async ({ path: p, recursive }, ctx) => {
    ctx.assertAllowedPath(p, 'write');
    if (ctx.allowedRoots.some((root) => path.resolve(p) === path.resolve(root))) throw new OpError('refused', `Refusing to remove an allowed root (${p})`);
    fs.rmSync(p, { recursive, force: true });
    return { path: p };
  },
});

defineOp('fs.chown', {
  description: 'Change owner/group (optionally recursive)',
  schema: z.object({ path: arg.absPath, owner: arg.username.or(z.literal('root')), group: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(), recursive: z.boolean().default(false) }).strict(),
  run: async ({ path: p, owner, group, recursive }, ctx) => {
    const target = ctx.assertAllowedPath(p, 'write');
    assertRealPath(target, ctx, 'write');
    // -h: a link that appears after the check gets its own owner changed,
    // never the file it points to.
    const argv = recursive ? ['-h', '-R'] : ['-h'];
    argv.push(group ? `${owner}:${group}` : owner, target);
    await exec('chown', argv, { timeoutMs: 600_000 });
    return { path: p, owner, group };
  },
});

defineOp('fs.chmod', {
  description: 'Change permissions (optionally recursive)',
  schema: z.object({ path: arg.absPath, mode: arg.mode, recursive: z.boolean().default(false) }).strict(),
  run: async ({ path: p, mode, recursive }, ctx) => {
    const target = ctx.assertAllowedPath(p, 'write');
    // chmod follows a link named on the command line and has no -h on Linux.
    assertRealPath(target, ctx, 'write');
    const argv = recursive ? ['-R', mode, target] : [mode, target];
    await exec('chmod', argv, { timeoutMs: 600_000 });
    return { path: p, mode };
  },
});

defineOp('fs.du', {
  description: 'Disk usage of a directory tree in bytes',
  schema: z.object({ path: arg.absPath }).strict(),
  run: async ({ path: p }, ctx) => {
    ctx.assertAllowedPath(p, 'read');
    const { stdout } = await exec('du', ['-sk', '--', p], { timeoutMs: 600_000, allowFailure: true });
    const kb = Number(stdout.trim().split(/\s+/)[0]) || 0;
    return { path: p, bytes: kb * 1024 };
  },
});

defineOp('fs.list', {
  description: 'List directory entries',
  schema: z.object({ path: arg.absPath, limit: z.number().int().min(1).max(10000).default(2000) }).strict(),
  run: async ({ path: p, limit }, ctx) => {
    ctx.assertAllowedPath(p, 'read');
    const entries = fs.readdirSync(p, { withFileTypes: true }).slice(0, limit).map((d) => {
      let st = null;
      try { st = fs.lstatSync(path.join(p, d.name)); } catch { /* vanished */ }
      return { name: d.name, type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file', size: st?.size ?? null, mtime: st?.mtime?.toISOString() ?? null, mode: st ? (st.mode & 0o7777).toString(8) : null };
    });
    return { path: p, entries };
  },
});

defineOp('fs.copy_tree', {
  description: 'Copy a directory tree preserving ownership (rsync -a)',
  timeoutMs: 3_600_000,
  schema: z.object({ from: arg.absPath, to: arg.absPath, deleteExtraneous: z.boolean().default(false) }).strict(),
  run: async ({ from, to, deleteExtraneous }, ctx) => {
    const src = ctx.assertAllowedPath(from, 'read');
    const dst = ctx.assertAllowedPath(to, 'write');
    // rsync resolves a trailing-slash source or destination through a link.
    const realSrc = assertRealPath(src, ctx, 'read');
    if (!fs.lstatSync(realSrc).isDirectory()) throw new OpError('refused', `${from} is not a directory`);
    assertExistingPathReal(dst, ctx, 'write');
    // -a implies -D; a tree the account controls is never allowed to turn
    // into device nodes or sockets created by root at the destination.
    const argv = ['-a', '--no-devices', '--no-specials', '--numeric-ids'];
    if (deleteExtraneous) argv.push('--delete');
    argv.push(`${src}/`, `${dst}/`);
    await exec('rsync', argv, { timeoutMs: 3_600_000 });
    return { from, to };
  },
});
