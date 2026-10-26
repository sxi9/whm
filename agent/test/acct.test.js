import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { assertRealPath } from '../src/ops/acct.js';

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
    for (const name of ['acct.set_home', 'acct.read_range', 'acct.list_logs', 'acct.archive_logs']) expect(catalog.has(name), name).toBe(true);
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

// A hosting account the tests may name without changing anything: any
// non-system user with a regular UID (the ops refuse before usermod runs).
const MANAGED_USER = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find(([name, , uid, , , home]) => Number(uid) >= 1000 && Number(uid) < 65534 && home?.startsWith('/') && !['nobody', 'whmpanel'].includes(name))?.[0] ?? null;

describe('acct.set_home never follows a symlinked home', () => {
  it.skipIf(!MANAGED_USER)('refuses a target that is a symbolic link before running usermod', async () => {
    exec.mockClear();
    fs.mkdirSync(`${root}/home-real`, { recursive: true });
    fs.symlinkSync(`${root}/home-real`, `${root}/home-link`);
    const err = await opError(runOp('acct.set_home', { username: MANAGED_USER, homeDir: `${root}/home-link` }, ctx));
    expect(err.code).toBe('refused');
    expect(err.message).toMatch(/symbolic link/);
    expect((await opError(runOp('acct.set_home', { username: MANAGED_USER, homeDir: `${root}/missing-home` }, ctx))).code).toBe('not_found');
    fs.writeFileSync(`${root}/home-file`, 'x');
    expect((await opError(runOp('acct.set_home', { username: MANAGED_USER, homeDir: `${root}/home-file` }, ctx))).code).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('assertRealPath', () => {
  it('accepts an allowed root that is itself a symbolic link but still refuses links below it', async () => {
    const real = `${root}/linked-real`;
    const link = `${root}/linked-root`;
    fs.mkdirSync(`${real}/logs`, { recursive: true });
    fs.writeFileSync(`${real}/logs/a.com-access.log`, 'hello');
    fs.symlinkSync(real, link);
    const linkedCtx = createContext({ allowedRoots: [link] });
    expect(assertRealPath(`${link}/logs`, linkedCtx, 'read')).toBe(`${real}/logs`);
    expect(assertRealPath(link, linkedCtx, 'read')).toBe(real);
    const r = await runOp('acct.list_logs', { path: `${link}/logs` }, linkedCtx);
    expect(r.entries.map((e) => e.name)).toEqual(['a.com-access.log']);
    expect((await runOp('acct.read_range', { path: `${link}/logs/a.com-access.log` }, linkedCtx)).size).toBe(5);
    // A link planted below the root is still a tenant's link and is refused.
    fs.symlinkSync(`${real}/logs`, `${real}/tenant-logs`);
    const err = await opError(runOp('acct.list_logs', { path: `${link}/tenant-logs` }, linkedCtx));
    expect(err.code).toBe('refused');
    expect(() => assertRealPath(`${link}/tenant-logs`, linkedCtx, 'read')).toThrow(/symbolic link/);
    // The lexical root check still applies before anything is resolved.
    expect(() => assertRealPath('/etc/passwd', linkedCtx, 'read')).toThrow(OpError);
    // Under the real root (not an allowed root) the lexical check refuses outright.
    expect((await opError(runOp('acct.list_logs', { path: `${real}/logs` }, linkedCtx))).code).toBe('path_not_allowed');
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

  // A tenant who replaces ~/logs with a link cannot have root read through it:
  // the lexical path is inside the allowed root, the real one is wherever the
  // link points, and only the real one counts.
  it('refuses a path whose directory component is a symlink, even inside an allowed root', async () => {
    fs.mkdirSync(`${root}/real`, { recursive: true });
    fs.writeFileSync(`${root}/real/other.com-access.log`, 'secret');
    fs.symlinkSync(`${root}/real`, `${root}/logs`);
    const err = await opError(runOp('acct.read_range', { path: `${root}/logs/other.com-access.log` }, ctx));
    expect(err.code).toBe('refused');
    expect(err.message).toMatch(/symbolic link/);
    expect((await runOp('acct.read_range', { path: `${root}/real/other.com-access.log` }, ctx)).size).toBe(6);
    expect((await opError(runOp('acct.read_range', { path: `${root}/real/other.com-access.log`, owner: 'root' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('acct.read_range', { path: `${root}/real/other.com-access.log`, owner: '-r' }, ctx))).code).toBe('invalid_args');
  });
});

describe('acct.list_logs', () => {
  it('lists only regular log files and refuses symlinked directories or foreign owners', async () => {
    const dir = `${root}/list`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/a.com-access.log`, 'x');
    fs.writeFileSync(`${dir}/a.com-error.log.1`, 'xx');
    fs.writeFileSync(`${dir}/notes.txt`, 'x');
    fs.mkdirSync(`${dir}/sub.log`);
    fs.symlinkSync('/etc/hostname', `${dir}/link.log`);
    const r = await runOp('acct.list_logs', { path: dir }, ctx);
    expect(r.entries.map((e) => e.name).sort()).toEqual(['a.com-access.log', 'a.com-error.log.1']);
    expect(r.entries.find((e) => e.name === 'a.com-error.log.1')).toMatchObject({ size: 2, uid: process.getuid() });
    expect(r.skipped.map((e) => e.name).sort()).toEqual(['link.log', 'sub.log']);
    fs.symlinkSync(dir, `${root}/list-link`);
    expect((await opError(runOp('acct.list_logs', { path: `${root}/list-link` }, ctx))).code).toBe('refused');
    expect((await opError(runOp('acct.list_logs', { path: `${root}/list/a.com-access.log` }, ctx))).code).toBe('refused');
    expect((await opError(runOp('acct.list_logs', { path: `${root}/missing` }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('acct.list_logs', { path: '/etc' }, ctx))).code).toBe('path_not_allowed');
    for (const owner of ['-r', 'a;b', '../x', 'root;x']) expect((await opError(runOp('acct.list_logs', { path: dir, owner }, ctx))).code, owner).toBe('invalid_args');
    for (const path of ['relative', `${root}/../x`, '']) expect((await opError(runOp('acct.list_logs', { path }, ctx))).code, path).toBe('invalid_args');
    expect((await opError(runOp('acct.list_logs', { path: dir, owner: 'root' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('acct.list_logs', { path: dir, owner: `nouser${crypto.randomBytes(3).toString('hex')}` }, ctx))).code).toBe('not_found');
  });
});

describe('acct.archive_logs never runs for an unmanaged user or bad input', () => {
  it('rejects injection-shaped arguments and refuses system or unknown users before runuser/rsync', async () => {
    exec.mockClear();
    const good = { username: 'bob', source: '/var/log/whm/domlogs/bob', archiveDir: '/home/bob/logs/archive', label: '2026-09', retainMonths: 3 };
    for (const username of ['-r', 'a;b', '../x', 'Bob', '', '$(id)']) expect((await opError(runOp('acct.archive_logs', { ...good, username }, ctx))).code, username).toBe('invalid_args');
    for (const label of ['2026-13', '2026-9', '../x', '2026-09;rm', 'latest', '']) expect((await opError(runOp('acct.archive_logs', { ...good, label }, ctx))).code, label).toBe('invalid_args');
    for (const source of ['relative', '/var/log/whm/domlogs/../../etc', '']) expect((await opError(runOp('acct.archive_logs', { ...good, source }, ctx))).code, source).toBe('invalid_args');
    for (const archiveDir of ['home/bob/logs', '/home/bob/../root', '-rf']) expect((await opError(runOp('acct.archive_logs', { ...good, archiveDir }, ctx))).code, archiveDir).toBe('invalid_args');
    expect((await opError(runOp('acct.archive_logs', { ...good, retainMonths: 0 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('acct.archive_logs', { ...good, extra: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('acct.archive_logs', { ...good, username: 'root' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('acct.archive_logs', { ...good, username: 'www-data' }, ctx))).code).toBe('refused');
    const ghost = `nouser${crypto.randomBytes(3).toString('hex')}`;
    expect((await opError(runOp('acct.archive_logs', { ...good, username: ghost }, ctx))).code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
  });
});
