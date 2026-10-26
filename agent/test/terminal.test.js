import { describe, it, expect, vi } from 'vitest';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { sessions, sweep, LIMITS } from '../src/ops/terminal.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

const ctx = createContext({ principal: { username: 'root', role: 'root' } });
const ID = 'c'.repeat(32);

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

// Opening a shell is a side effect, so these tests only exercise schemas and
// the session bookkeeping; the real PTY round trip is checked by hand.
describe('terminal op schemas', () => {
  it('unknown ops are refused', async () => {
    expect((await opError(runOp('terminal.exec', { command: 'id' }, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('terminal.resize', { id: ID, cols: 80 }, ctx))).code).toBe('unknown_op');
  });

  it('terminal.open accepts only known shells and bounded sizes', async () => {
    exec.mockClear();
    for (const args of [{ shell: '/bin/zsh' }, { shell: '/bin/bash; id' }, { shell: '../bin/sh' }, { cols: 1 }, { rows: 1000 }, { idleMinutes: 0 }, { idleMinutes: 10_000 }, { command: 'id' }, { cwd: '/' }]) {
      expect((await opError(runOp('terminal.open', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('terminal.open and terminal.write refuse any principal but root', async () => {
    exec.mockClear();
    for (const principal of [null, { username: 'resell1', role: 'reseller' }, { username: 'root', role: 'user' }]) {
      const other = createContext({ principal });
      expect((await opError(runOp('terminal.open', {}, other))).code, JSON.stringify(principal)).toBe('refused');
      expect((await opError(runOp('terminal.write', { id: ID, data: 'id\r' }, other))).code, JSON.stringify(principal)).toBe('refused');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('session ids must be 32 hex characters and input must be NUL-free', async () => {
    for (const id of ['abc', 'A'.repeat(32), '../' + 'a'.repeat(29), 'a'.repeat(31) + ';', '-' + 'a'.repeat(31)]) {
      expect((await opError(runOp('terminal.read', { id }, ctx))).code, id).toBe('invalid_args');
      expect((await opError(runOp('terminal.write', { id, data: 'ls\r' }, ctx))).code, id).toBe('invalid_args');
      expect((await opError(runOp('terminal.close', { id }, ctx))).code, id).toBe('invalid_args');
    }
    expect((await opError(runOp('terminal.write', { id: ID, data: '' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('terminal.write', { id: ID, data: 'a\0b' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('terminal.write', { id: ID, data: 'x'.repeat(64 * 1024 + 1) }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('terminal.read', { id: ID, since: -1 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('terminal.read', { id: ID, maxBytes: 0 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('terminal.read', { id: ID, extra: true }, ctx))).code).toBe('invalid_args');
  });

  it('unknown sessions are not_found for read/write and a no-op for close', async () => {
    expect((await opError(runOp('terminal.read', { id: ID }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('terminal.write', { id: ID, data: 'id\r' }, ctx))).code).toBe('not_found');
    await expect(runOp('terminal.close', { id: ID }, ctx)).resolves.toEqual({ id: ID, existed: false });
    await expect(runOp('terminal.list', {}, ctx)).resolves.toEqual([]);
  });

  it('read slices the scrollback by offset and the sweeper drops idle or finished sessions', async () => {
    const kills = [];
    const fake = { id: ID, child: { pid: 1, kill: (sig) => kills.push(sig), stdin: { write() {} } }, shell: '/bin/bash', chunks: [{ offset: 0, data: Buffer.from('hello ') }, { offset: 6, data: Buffer.from('world') }], offset: 11, bytes: 11, startedAt: 0, lastActivity: Date.now(), exited: false, exitCode: null, signal: null, exitedAt: null, idleMs: 60_000, closeReason: null, closedAt: null };
    sessions.set(ID, fake);
    try {
      const all = await runOp('terminal.read', { id: ID }, ctx);
      expect(Buffer.from(all.data, 'base64').toString()).toBe('hello world');
      expect(all).toMatchObject({ offset: 11, truncated: false, exited: false });
      const tail = await runOp('terminal.read', { id: ID, since: 8 }, ctx);
      expect(Buffer.from(tail.data, 'base64').toString()).toBe('rld');
      const capped = await runOp('terminal.read', { id: ID, since: 2, maxBytes: 5 }, ctx);
      expect(Buffer.from(capped.data, 'base64').toString()).toBe('llo w');
      expect(capped.offset).toBe(7);
      await expect(runOp('terminal.write', { id: ID, data: 'id\r' }, ctx)).resolves.toEqual({ id: ID, bytes: 3 });
      expect((await runOp('terminal.list', {}, ctx))[0]).toMatchObject({ id: ID, pid: 1, exited: false });
      expect(sweep(Date.now())).toEqual([]);
      expect(sweep(Date.now() + 61_000)).toEqual([ID]);
      expect(kills).toEqual(['SIGHUP']);
      // The idle kill is kept so the API's next read sees why the shell ended.
      expect(sessions.get(ID)).toMatchObject({ closeReason: 'idle' });
      expect((await runOp('terminal.read', { id: ID, since: 11 }, ctx))).toMatchObject({ closeReason: 'idle', exited: false });
      expect((await opError(runOp('terminal.write', { id: ID, data: 'id\r' }, ctx))).code).toBe('exited');
      expect(sweep(Date.now() + 61_000)).toEqual([]);
      expect(sweep(Date.now() + 61_000 + LIMITS.exitedKeepMs + 1)).toEqual([ID]);
      expect(sessions.has(ID)).toBe(false);
      sessions.set(ID, { ...fake, exited: true, exitedAt: 0 });
      expect((await opError(runOp('terminal.write', { id: ID, data: 'id\r' }, ctx))).code).toBe('exited');
      expect(sweep(LIMITS.exitedKeepMs + 1)).toEqual([ID]);
    } finally { sessions.delete(ID); }
  });
});
