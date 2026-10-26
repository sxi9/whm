import { describe, it, expect, vi, afterAll } from 'vitest';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { parsePsOwner } from '../src/ops/bpk.js';

// exec is spied with the real implementation behind it so a test can prove an op
// refused before `ps` ran. The only process ever signalled is a `sleep` child
// this file spawns itself, and only when the test user is not root.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});
const { exec } = await import('../src/exec.js');

const ctx = createContext();
const me = os.userInfo().username;
const children = [];

function spawnSleeper() {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

afterAll(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch {} } });

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

describe('bpk op catalog', () => {
  it('registers bpk.kill as destructive and rejects unknown ops', async () => {
    expect(catalog.has('bpk.kill')).toBe(true);
    expect(catalog.get('bpk.kill').destructive).toBe(true);
    expect((await opError(runOp('bpk.scan', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('bpk.exec', { cmd: 'id' }, ctx))).code).toBe('unknown_op');
  });
});

describe('bpk.kill schema rejects injection before anything runs', () => {
  const bad = [
    { pid: '1;kill -9 1', user: 'alice' },
    { pid: -5, user: 'alice' },
    { pid: 0, user: 'alice' },
    { pid: 1.5, user: 'alice' },
    { pid: 1234 },
    { pid: 1234, user: '-r' },
    { pid: 1234, user: 'a;b' },
    { pid: 1234, user: '../etc' },
    { pid: 1234, user: 'Alice' },
    { pid: 1234, user: 'alice', signal: 'SIGSTOP;id' },
    { pid: 1234, user: 'alice', signal: 9 },
    { pid: 1234, user: 'alice', elapsedSeconds: -1 },
    { pid: 1234, user: 'alice', elapsedSeconds: '60' },
    { pid: 1234, user: 'alice', extra: true },
  ];
  for (const args of bad) {
    it(`rejects ${JSON.stringify(args)}`, async () => {
      exec.mockClear();
      expect((await opError(runOp('bpk.kill', args, ctx))).code).toBe('invalid_args');
      expect(exec).not.toHaveBeenCalled();
    });
  }
});

describe('bpk.kill re-verifies the process before signalling', () => {
  it('parses the ps owner line', () => {
    expect(parsePsOwner('alice                     1234\n')).toEqual({ user: 'alice', elapsedSeconds: 1234 });
    expect(parsePsOwner('')).toBeNull();
    expect(parsePsOwner('\n  \n')).toBeNull();
  });

  it('refuses PID 1, itself and root-owned targets without running ps', async () => {
    exec.mockClear();
    expect((await opError(runOp('bpk.kill', { pid: 1, user: 'alice' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('bpk.kill', { pid: process.pid, user: 'alice' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('bpk.kill', { pid: 4194000, user: 'root' }, ctx))).code).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports not_found for a PID that is not running', async () => {
    exec.mockClear();
    expect((await opError(runOp('bpk.kill', { pid: 4194303, user: 'alice' }, ctx))).code).toBe('not_found');
    expect(exec).toHaveBeenCalledWith('ps', ['-o', 'user:32=,etimes=', '-p', '4194303'], expect.anything());
  });

  it('refuses with owner_mismatch when the PID now belongs to another user', async () => {
    const child = spawnSleeper();
    await new Promise((r) => child.once('spawn', r));
    const err = await opError(runOp('bpk.kill', { pid: child.pid, user: 'nobody', signal: 'SIGKILL' }, ctx));
    expect(err.code).toBe('owner_mismatch');
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it('refuses with owner_mismatch when the PID is younger than the snapshot it was matched in', async () => {
    if (me === 'root') return;
    const child = spawnSleeper();
    await new Promise((r) => child.once('spawn', r));
    const err = await opError(runOp('bpk.kill', { pid: child.pid, user: me, signal: 'SIGKILL', elapsedSeconds: 86400 }, ctx));
    expect(err.code).toBe('owner_mismatch');
    expect(err.message).toMatch(/recycled/);
    expect(child.signalCode).toBeNull();
  });

  it('signals the process once owner and age check out', async () => {
    if (me === 'root') return;
    const child = spawnSleeper();
    await new Promise((r) => child.once('spawn', r));
    const exited = new Promise((r) => child.once('exit', (code, signal) => r(signal)));
    const result = await runOp('bpk.kill', { pid: child.pid, user: me, signal: 'SIGKILL', elapsedSeconds: 0 }, ctx);
    expect(result).toMatchObject({ pid: child.pid, signal: 'SIGKILL', user: me });
    expect(await exited).toBe('SIGKILL');
  });
});
