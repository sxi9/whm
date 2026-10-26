import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';

// exec is spied with the real implementation behind it so tests prove an op
// refused before any program ran. acct.set_home is never executed for real
// (it would change /etc/passwd); acct.read_range is exercised under /tmp/whm.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});
const { exec } = await import('../src/exec.js');

const ctx = createContext();
const TMP_ROOT = '/tmp/whm';
let root;
let tmpRootExisted;

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

beforeAll(() => {
  tmpRootExisted = fs.existsSync(TMP_ROOT);
  root = `${TMP_ROOT}/acct-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(root, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (!tmpRootExisted) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('acct op catalog', () => {
  it('registers the family and rejects unknown ops', async () => {
    for (const name of ['acct.set_home', 'acct.read_range']) expect(catalog.has(name), name).toBe(true);
    expect((await opError(runOp('acct.delete', { username: 'bob' }, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('acct.read', { path: '/home/bob/logs/a.log' }, ctx))).code).toBe('unknown_op');
  });
});

describe('acct.set_home refuses bad input before running usermod', () => {
  it('rejects injection-shaped usernames and paths', async () => {
    exec.mockClear();
    for (const username of ['-r', 'a;b', '../x', 'Bob', 'bob user', '', '$(id)', 'root;x']) {
      const err = await opError(runOp('acct.set_home', { username, homeDir: '/home2/bob' }, ctx));
      expect(err.code, JSON.stringify(username)).toBe('invalid_args');
    }
    for (const homeDir of ['home2/bob', '/home2/../etc', '/home2/bob/..', '', '-d', '/home\0x']) {
      const err = await opError(runOp('acct.set_home', { username: 'bob', homeDir }, ctx));
      expect(err.code, JSON.stringify(homeDir)).toBe('invalid_args');
    }
    expect((await opError(runOp('acct.set_home', { username: 'bob', homeDir: '/home2/bob', extra: 1 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses system users and unknown users without touching the host', async () => {
    exec.mockClear();
    expect((await opError(runOp('acct.set_home', { username: 'root', homeDir: '/home2/root' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('acct.set_home', { username: 'daemon', homeDir: '/home2/daemon' }, ctx))).code).toBe('refused');
    const ghost = `nouser${crypto.randomBytes(3).toString('hex')}`;
    expect((await opError(runOp('acct.set_home', { username: ghost, homeDir: `/home2/${ghost}` }, ctx))).code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('acct.read_range', () => {
  it('rejects traversal, non-log names, bad ranges and paths outside allowed roots', async () => {
    for (const p of ['relative.log', '/tmp/whm/../etc/passwd', '/tmp/whm/x/../../y.log', '']) {
      expect((await opError(runOp('acct.read_range', { path: p }, ctx))).code, p).toBe('invalid_args');
    }
    expect((await opError(runOp('acct.read_range', { path: '/etc/passwd' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('acct.read_range', { path: `${root}/notes.txt` }, ctx))).code).toBe('refused');
    expect((await opError(runOp('acct.read_range', { path: `${root}/a.log`, offset: -1 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('acct.read_range', { path: `${root}/a.log`, length: 0 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('acct.read_range', { path: `${root}/a.log`, length: 9 * 1024 * 1024 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('acct.read_range', { path: `${root}/missing.log` }, ctx))).code).toBe('not_found');
  });

  it('reads byte ranges and reports eof', async () => {
    const file = `${root}/example.com-access.log`;
    fs.writeFileSync(file, 'abcdefghij');
    const first = await runOp('acct.read_range', { path: file, offset: 0, length: 4 }, ctx);
    expect(first).toMatchObject({ size: 10, offset: 0, length: 4, eof: false });
    expect(Buffer.from(first.data, 'base64').toString()).toBe('abcd');
    const last = await runOp('acct.read_range', { path: file, offset: 8, length: 4 }, ctx);
    expect(last).toMatchObject({ length: 2, eof: true });
    expect(Buffer.from(last.data, 'base64').toString()).toBe('ij');
    const past = await runOp('acct.read_range', { path: file, offset: 20, length: 4 }, ctx);
    expect(past).toMatchObject({ length: 0, eof: true, data: '' });
  });

  it('refuses symlinks and directories', async () => {
    fs.mkdirSync(`${root}/dir.log`, { recursive: true });
    expect((await opError(runOp('acct.read_range', { path: `${root}/dir.log` }, ctx))).code).toBe('refused');
    fs.symlinkSync('/etc/hostname', `${root}/link.log`);
    expect((await opError(runOp('acct.read_range', { path: `${root}/link.log` }, ctx))).code).toBe('refused');
  });
});
