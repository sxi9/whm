import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runOp, createContext, OpError } from '../src/lib.js';

// fs.mkdir, fs.chown, fs.chmod and fs.copy_tree run as root inside account
// homes, where a tenant can plant symbolic links. The lexical allowed-root
// check passes for /home/<user>/public_html whatever it points to, so each op
// must refuse a link in any component before it creates, chmods, chowns or
// rsyncs. exec is spied with the real implementation behind it so a refusal
// is proven to happen before a program ran.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});
const { exec, hasBinary } = await import('../src/exec.js');

const ctx = createContext();
const TMP_ROOT = '/tmp/whm';
let root;
let tmpRootExisted;
// A directory a tenant's link points at: anything root does through the link
// would land here.
let victim;

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

const mode = (p) => (fs.lstatSync(p).mode & 0o7777).toString(8);

beforeAll(() => {
  tmpRootExisted = fs.existsSync(TMP_ROOT);
  fs.mkdirSync(TMP_ROOT, { recursive: true, mode: 0o700 });
  root = fs.mkdtempSync(`${TMP_ROOT}/fs-`);
  victim = path.join(root, 'victim');
  fs.mkdirSync(victim, { mode: 0o700 });
  fs.writeFileSync(path.join(victim, 'secret.txt'), 'secret', { mode: 0o600 });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (!tmpRootExisted) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('fs.mkdir never creates, chmods or chowns through a planted link', () => {
  it('creates a nested directory with its mode inside an allowed root', async () => {
    const dir = path.join(root, 'home', 'alice', 'public_html');
    await expect(runOp('fs.mkdir', { path: dir, mode: '0750', owner: 'root' }, ctx)).resolves.toEqual({ path: dir });
    expect(fs.lstatSync(dir).isDirectory()).toBe(true);
    expect(mode(dir)).toBe('750');
    // Idempotent on an existing real directory, and the mode is reapplied.
    await expect(runOp('fs.mkdir', { path: dir, mode: '0755' }, ctx)).resolves.toEqual({ path: dir });
    expect(mode(dir)).toBe('755');
  });

  it('refuses a target that is a link to a directory and leaves the target alone', async () => {
    const home = path.join(root, 'home', 'stale');
    fs.mkdirSync(home, { recursive: true });
    const link = path.join(home, 'public_html');
    fs.symlinkSync(victim, link);
    const err = await opError(runOp('fs.mkdir', { path: link, mode: '0777', owner: 'root' }, ctx));
    expect(err.code).toBe('refused');
    expect(err.message).toMatch(/symbolic link/);
    expect(mode(victim)).toBe('700');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('refuses a path whose parent is a link, so nothing is created behind it', async () => {
    const link = path.join(root, 'home', 'stale', 'public_html');
    const err = await opError(runOp('fs.mkdir', { path: `${link}/cgi-bin`, mode: '0755', owner: 'root' }, ctx));
    expect(err.code).toBe('refused');
    expect(fs.existsSync(path.join(victim, 'cgi-bin'))).toBe(false);
    expect((await opError(runOp('fs.mkdir', { path: `${link}/a/b/c` }, ctx))).code).toBe('refused');
    expect(fs.existsSync(path.join(victim, 'a'))).toBe(false);
  });

  it('refuses a dangling link instead of creating its target', async () => {
    const nowhere = path.join(root, 'nowhere');
    const link = path.join(root, 'dangling');
    fs.symlinkSync(nowhere, link);
    expect((await opError(runOp('fs.mkdir', { path: link }, ctx))).code).toBe('refused');
    expect((await opError(runOp('fs.mkdir', { path: `${link}/sub` }, ctx))).code).toBe('refused');
    expect(fs.existsSync(nowhere)).toBe(false);
  });

  it('still accepts an allowed root that is itself a root-owned link', async () => {
    const real = path.join(root, 'linked-real');
    const link = path.join(root, 'linked-root');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    const linkedCtx = createContext({ allowedRoots: [link] });
    await expect(runOp('fs.mkdir', { path: `${link}/bob/public_html`, mode: '0750' }, linkedCtx)).resolves.toEqual({ path: `${link}/bob/public_html` });
    expect(fs.lstatSync(`${real}/bob/public_html`).isDirectory()).toBe(true);
    exec.mockClear();
    try { await runOp('fs.copy_tree', { from: link, to: `${link}/bob/copy` }, linkedCtx); } catch (err) { expect(err.code).toBe('binary_not_found'); }
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1].slice(-2)).toEqual([`${link}/`, `${link}/bob/copy/`]);
    // A link planted below that root is still a tenant's link.
    fs.symlinkSync(victim, `${real}/bob/mail`);
    expect((await opError(runOp('fs.mkdir', { path: `${link}/bob/mail/inbox` }, linkedCtx))).code).toBe('refused');
    expect(fs.existsSync(path.join(victim, 'inbox'))).toBe(false);
  });
});

describe('fs.chown and fs.chmod refuse links before the program runs', () => {
  it('fs.chown refuses a link, a path through a link and a missing path', async () => {
    const home = path.join(root, 'home', 'new');
    fs.mkdirSync(home, { recursive: true });
    const link = path.join(home, 'public_html');
    fs.symlinkSync(victim, link);
    exec.mockClear();
    expect((await opError(runOp('fs.chown', { path: link, owner: 'root', recursive: true }, ctx))).code).toBe('refused');
    expect((await opError(runOp('fs.chown', { path: `${link}/secret.txt`, owner: 'root' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('fs.chown', { path: `${home}/missing`, owner: 'root' }, ctx))).code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
  });

  it('fs.chown runs chown with --no-dereference on a real directory', async () => {
    const dir = path.join(root, 'home', 'new', 'real');
    fs.mkdirSync(dir);
    exec.mockClear();
    try { await runOp('fs.chown', { path: dir, owner: 'root', group: 'root', recursive: true }, ctx); } catch (err) { expect(['command_failed', 'binary_not_found']).toContain(err.code); }
    try { await runOp('fs.chown', { path: dir, owner: 'root' }, ctx); } catch (err) { expect(['command_failed', 'binary_not_found']).toContain(err.code); }
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][0]).toBe('chown');
    expect(exec.mock.calls[0][1]).toEqual(['-h', '-R', 'root:root', dir]);
    expect(exec.mock.calls[1][1]).toEqual(['-h', 'root', dir]);
  });

  it('fs.chmod refuses a link and a path through a link, and runs on a real file', async () => {
    const link = path.join(root, 'home', 'new', 'public_html');
    exec.mockClear();
    expect((await opError(runOp('fs.chmod', { path: link, mode: '0777', recursive: true }, ctx))).code).toBe('refused');
    expect((await opError(runOp('fs.chmod', { path: `${link}/secret.txt`, mode: '0644' }, ctx))).code).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
    expect(mode(victim)).toBe('700');
    expect(mode(path.join(victim, 'secret.txt'))).toBe('600');
    const file = path.join(root, 'home', 'new', 'real', 'f.txt');
    fs.writeFileSync(file, 'x', { mode: 0o600 });
    try { await runOp('fs.chmod', { path: file, mode: '0644' }, ctx); } catch (err) { expect(err.code).toBe('binary_not_found'); }
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toEqual(['0644', file]);
    if (hasBinary('chmod')) expect(mode(file)).toBe('644');
  });
});

describe('fs.copy_tree never rsyncs through a planted link', () => {
  it('refuses a source that is a link, goes through a link, is a file or is missing', async () => {
    const home = path.join(root, 'home', 'old');
    fs.mkdirSync(path.join(home, 'public_html'), { recursive: true });
    fs.symlinkSync(victim, path.join(home, 'public_html', 'addon.example.com'));
    fs.writeFileSync(path.join(home, 'file.txt'), 'x');
    const to = path.join(root, 'home', 'new', 'copied');
    exec.mockClear();
    expect((await opError(runOp('fs.copy_tree', { from: `${home}/public_html/addon.example.com`, to }, ctx))).code).toBe('refused');
    expect((await opError(runOp('fs.copy_tree', { from: `${home}/public_html/addon.example.com/`, to }, ctx))).code).toBe('refused');
    expect((await opError(runOp('fs.copy_tree', { from: `${home}/public_html/addon.example.com/sub`, to }, ctx))).code).not.toBe('path_not_allowed');
    expect((await opError(runOp('fs.copy_tree', { from: `${home}/file.txt`, to }, ctx))).code).toBe('refused');
    expect((await opError(runOp('fs.copy_tree', { from: `${home}/missing`, to }, ctx))).code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
    expect(fs.existsSync(to)).toBe(false);
  });

  it('refuses a destination that is a link or whose existing parent is a link', async () => {
    const from = path.join(root, 'home', 'old', 'public_html');
    fs.writeFileSync(path.join(from, 'index.html'), 'hi');
    const home = path.join(root, 'home', 'new');
    const link = path.join(home, 'public_html');
    exec.mockClear();
    expect((await opError(runOp('fs.copy_tree', { from, to: link }, ctx))).code).toBe('refused');
    expect((await opError(runOp('fs.copy_tree', { from, to: `${link}/addon` }, ctx))).code).toBe('refused');
    expect((await opError(runOp('fs.copy_tree', { from, to: `${link}/a/b` }, ctx))).code).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
    expect(fs.readdirSync(victim)).toEqual(['secret.txt']);
  });

  it.skipIf(!hasBinary('rsync'))('copies a real tree into a destination that does not exist yet', async () => {
    const from = path.join(root, 'home', 'old', 'public_html');
    const to = path.join(root, 'home', 'new', 'www');
    exec.mockClear();
    await expect(runOp('fs.copy_tree', { from: `${from}/`, to }, ctx)).resolves.toEqual({ from: `${from}/`, to });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toEqual(['-a', '--no-devices', '--no-specials', '--numeric-ids', `${from}/`, `${to}/`]);
    expect(fs.readFileSync(path.join(to, 'index.html'), 'utf8')).toBe('hi');
    // Links inside the tree are copied as links, not followed.
    expect(fs.lstatSync(path.join(to, 'addon.example.com')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(to, 'secret.txt'))).toBe(false);
  });
});
