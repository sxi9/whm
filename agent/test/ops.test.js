import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { exec, hasBinary } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';

// Every op reaches the system through exec(); spying on it (with the real
// implementation behind the spy) lets tests prove an op refused *before* running
// anything. Pure-fs ops never go through exec and are exercised for real under
// /tmp/whm, which is an allowed root.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

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
  root = `${TMP_ROOT}/test-${crypto.randomBytes(6).toString('hex')}`;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (!tmpRootExisted) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('sys ops', () => {
  it('sys.info reports host facts in the expected shape', async () => {
    const info = await runOp('sys.info', {}, ctx);
    expect(typeof info.hostname).toBe('string');
    expect(info.hostname.length).toBeGreaterThan(0);
    expect(typeof info.os.name).toBe('string');
    expect(typeof info.os.kernel).toBe('string');
    expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(info.loadAverage).toHaveLength(3);
    expect(info.cpu.count).toBeGreaterThan(0);
    expect(info.memory.totalBytes).toBeGreaterThan(0);
    expect(info.memory.availableBytes).toBeGreaterThan(0);
    expect(Array.isArray(info.disks)).toBe(true);
    for (const d of info.disks) expect(d).toMatchObject({ filesystem: expect.any(String), mountpoint: expect.any(String), sizeBytes: expect.any(Number) });
    expect(Array.isArray(info.interfaces)).toBe(true);
    for (const i of info.interfaces) expect(Array.isArray(i.addresses)).toBe(true);
    expect(info.node).toBe(process.version);
  });

  it('sys.binaries reports which programs exist', async () => {
    await expect(runOp('sys.binaries', { names: ['sh', 'definitely-missing-xyz'] }, ctx)).resolves.toEqual({ sh: true, 'definitely-missing-xyz': false });
    expect((await opError(runOp('sys.binaries', { names: [] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('sys.binaries', { names: ['../../bin/sh'] }, ctx))).code).toBe('invalid_args');
  });

  it('sys.processes returns at most `limit` rows with numeric fields', async () => {
    const rows = await runOp('sys.processes', { limit: 5 }, ctx);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(5);
    for (const row of rows) {
      expect(Number.isInteger(row.pid)).toBe(true);
      expect(row.pid).toBeGreaterThan(0);
      expect(typeof row.user).toBe('string');
      expect(typeof row.command).toBe('string');
      expect(Number.isFinite(row.cpuPercent)).toBe(true);
      expect(Number.isFinite(row.rssBytes)).toBe(true);
    }
    const byPid = await runOp('sys.processes', { limit: 3, sort: 'pid' }, ctx);
    expect(byPid.map((r) => r.pid)).toEqual([...byPid.map((r) => r.pid)].sort((a, b) => a - b));
  });

  it('sys.process.signal refuses PID 1 and the agent itself before signalling', async () => {
    expect((await opError(runOp('sys.process.signal', { pid: 1, signal: 'SIGTERM' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('sys.process.signal', { pid: process.pid }, ctx))).code).toBe('refused');
    expect((await opError(runOp('sys.process.signal', { pid: 1, signal: 'SIGSTOP;id' }, ctx))).code).toBe('invalid_args');
  });

  it('sys.read_file only reads inside allowed roots', async () => {
    expect((await opError(runOp('sys.read_file', { path: '/etc/shadow' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('sys.read_file', { path: '/home/../etc/passwd' }, ctx))).code).toBe('invalid_args');
  });

  it('sys.resolvers.get and sys.time.get are read-only', async () => {
    const resolvers = await runOp('sys.resolvers.get', {}, ctx);
    expect(Array.isArray(resolvers.nameservers)).toBe(true);
    expect(typeof resolvers.raw).toBe('string');
    const time = await runOp('sys.time.get', {}, ctx);
    expect(() => new Date(time.now).toISOString()).not.toThrow();
  });
});

describe('user ops', () => {
  it('user.get resolves root to uid 0', async () => {
    const info = await runOp('user.get', { username: 'root' }, ctx);
    expect(info).toMatchObject({ username: 'root', uid: 0, gid: 0 });
    expect(typeof info.home).toBe('string');
    expect(typeof info.shell).toBe('string');
    await expect(runOp('user.get', { username: 'definitely-no-such-user-xyz' }, ctx)).resolves.toBeNull();
  });

  it('user.delete refuses system accounts without executing anything', async () => {
    exec.mockClear();
    const err = await opError(runOp('user.delete', { username: 'root' }, ctx));
    expect(err.code).toBe('refused');
    expect((await opError(runOp('user.delete', { username: 'nobody' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('user.delete', { username: 'daemon' }, ctx))).code).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
  });

  it('user.lock, user.unlock, user.set_shell and user.create refuse reserved users before exec', async () => {
    exec.mockClear();
    expect((await opError(runOp('user.lock', { username: 'root' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('user.unlock', { username: 'root' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('user.set_shell', { username: 'root', shell: '/bin/sh' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('user.create', { username: 'root', homeDir: '/home/root' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('user.create', { username: 'nobody', homeDir: '/home/nobody' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('user.create', { username: 'definitely-no-such-user-xyz', homeDir: '/opt/elsewhere' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('user.set_password', { username: 'definitely-no-such-user-xyz', password: 'x' }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('user.set_password', { username: 'root', password: 'with\nnewline' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('user.create', { username: '-r', homeDir: '/home/x' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('user.lock expires the account as well as locking the password; user.unlock clears both', async () => {
    exec.mockClear();
    const ok = async (bin, argv) => ({ code: 0, stdout: '', stderr: '', bin, argv });
    exec.mockImplementationOnce(ok).mockImplementationOnce(ok);
    const username = 'definitely-no-such-user-xyz';
    await expect(runOp('user.lock', { username }, ctx)).resolves.toEqual({ username, locked: true });
    await expect(runOp('user.unlock', { username }, ctx)).resolves.toEqual({ username, locked: false });
    expect(exec.mock.calls.map(([bin, argv]) => [bin, argv])).toEqual([
      ['usermod', ['-L', '-e', '1', username]],
      ['usermod', ['-U', '-e', '', username]],
    ]);
  });

  it('user.set_quota reports a missing quota toolchain as capability_missing', async () => {
    if (hasBinary('setquota')) return;
    exec.mockClear();
    const err = await opError(runOp('user.set_quota', { username: 'definitely-no-such-user-xyz', softMb: 100, hardMb: 105 }, ctx));
    expect(err.code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });

  it('user.list_managed and user.groups.members are read-only lookups', async () => {
    const managed = await runOp('user.list_managed', {}, ctx);
    expect(Array.isArray(managed)).toBe(true);
    for (const u of managed) expect(u.uid).toBeGreaterThanOrEqual(1000);
    const group = await runOp('user.groups.members', { group: 'root' }, ctx);
    expect(group).toMatchObject({ group: 'root', exists: true });
    expect(Array.isArray(group.members)).toBe(true);
    await expect(runOp('user.groups.members', { group: 'no-such-group-xyz' }, ctx)).resolves.toEqual({ group: 'no-such-group-xyz', exists: false, members: [] });
  });
});

describe('fs ops', () => {
  it('refuses paths outside the allowed roots', async () => {
    expect((await opError(runOp('fs.read_file', { path: '/etc/passwd' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('fs.stat', { path: '/etc/passwd' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('fs.list', { path: '/etc' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('fs.write_file', { path: '/etc/evil', content: 'x' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('fs.mkdir', { path: '/opt/evil' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('fs.remove', { path: '/etc/passwd' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('fs.read_file', { path: '/home/../etc/passwd' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('fs.chmod', { path: '/home/x', mode: '999' }, ctx))).code).toBe('invalid_args');
    expect(fs.existsSync('/etc/evil')).toBe(false);
    expect(fs.existsSync('/opt/evil')).toBe(false);
  });

  it('round-trips mkdir, write, read, stat, list and remove inside an allowed root', async () => {
    await expect(runOp('fs.mkdir', { path: root, mode: '0750' }, ctx)).resolves.toEqual({ path: root });
    expect(fs.statSync(root).isDirectory()).toBe(true);
    expect((fs.statSync(root).mode & 0o777).toString(8)).toBe('750');

    const file = `${root}/a.txt`;
    await expect(runOp('fs.stat', { path: file }, ctx)).resolves.toEqual({ path: file, exists: false });
    await expect(runOp('fs.write_file', { path: file, content: 'hello', backup: false, mode: '0600' }, ctx)).resolves.toEqual({ path: file, bytes: 5 });
    await expect(runOp('fs.read_file', { path: file }, ctx)).resolves.toEqual({ path: file, content: 'hello', size: 5 });

    const stat = await runOp('fs.stat', { path: file }, ctx);
    expect(stat).toMatchObject({ path: file, exists: true, isDirectory: false, size: 5, mode: '600' });
    expect(() => new Date(stat.mtime).toISOString()).not.toThrow();

    await expect(runOp('fs.write_file', { path: file, content: 'hello again' }, ctx)).resolves.toEqual({ path: file, bytes: 11 });
    expect(fs.readFileSync(`${file}.whm-bak`, 'utf8')).toBe('hello');
    expect(fs.readFileSync(file, 'utf8')).toBe('hello again');
    expect(fs.readdirSync(root).some((n) => n.includes('.whm-tmp-'))).toBe(false);

    await expect(runOp('fs.write_file', { path: `${root}/nested/deep/b.txt`, content: 'nested', backup: false }, ctx)).resolves.toMatchObject({ bytes: 6 });
    expect((await opError(runOp('fs.read_file', { path: file, maxBytes: 4 }, ctx))).code).toBe('too_large');

    const list = await runOp('fs.list', { path: root }, ctx);
    expect(list.path).toBe(root);
    expect(list.entries.map((e) => e.name).sort()).toEqual(['a.txt', 'a.txt.whm-bak', 'nested']);
    expect(list.entries.find((e) => e.name === 'nested')).toMatchObject({ type: 'dir' });
    expect(list.entries.find((e) => e.name === 'a.txt')).toMatchObject({ type: 'file', size: 11 });
    expect((await runOp('fs.list', { path: root, limit: 1 }, ctx)).entries).toHaveLength(1);

    const tail = await runOp('sys.read_file', { path: file, maxBytes: 5 }, ctx);
    expect(tail).toMatchObject({ path: file, size: 11, truncated: true, content: 'again' });
    const head = await runOp('sys.read_file', { path: file, maxBytes: 5, tail: false }, ctx);
    expect(head.content).toBe('hello');

    expect((await opError(runOp('fs.remove', { path: `${root}/nested` }, ctx))).code).toBe('op_failed');
    expect(fs.existsSync(`${root}/nested`)).toBe(true);
    await expect(runOp('fs.remove', { path: `${root}/nested`, recursive: true }, ctx)).resolves.toEqual({ path: `${root}/nested` });
    expect(fs.existsSync(`${root}/nested`)).toBe(false);
    await expect(runOp('fs.remove', { path: file }, ctx)).resolves.toEqual({ path: file });
    await expect(runOp('fs.stat', { path: file }, ctx)).resolves.toEqual({ path: file, exists: false });
    await expect(runOp('fs.remove', { path: root, recursive: true }, ctx)).resolves.toEqual({ path: root });
    expect(fs.existsSync(root)).toBe(false);
  });

  it('refuses to remove an allowed root itself', async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const err = await opError(runOp('fs.remove', { path: TMP_ROOT, recursive: true }, ctx));
    expect(err.code).toBe('refused');
    expect((await opError(runOp('fs.remove', { path: `${TMP_ROOT}/`, recursive: true }, ctx))).code).toBe('refused');
    expect(fs.existsSync(TMP_ROOT)).toBe(true);
  });

  it('fs.du measures a tree in bytes through du', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(`${root}/big.bin`, Buffer.alloc(8192, 1));
    const du = await runOp('fs.du', { path: root }, ctx);
    expect(du.path).toBe(root);
    expect(du.bytes).toBeGreaterThanOrEqual(8192);
    expect(exec).toHaveBeenCalledWith('du', ['-sk', '--', root], expect.any(Object));
  });
});
