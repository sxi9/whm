import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOp, createContext, OpError, catalog, DEFAULT_ALLOWED_ROOTS } from '../src/lib.js';
import { sessions, LIMITS, BRIDGE, PANEL_GROUP, SOCKET_NAME, loginShellOf, groupIdOf, publicInfo } from '../src/ops/term.js';
import { TERM_RUN_DIR } from '../src/managed-paths.js';

// term.open starts a shell as an account (a side effect no test may cause), so
// the ops are exercised up to the schema, the shell gate and the session
// bookkeeping; the pty round trip is the host acceptance (contract §68).
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary), resolveBinary: vi.fn(mod.resolveBinary) };
});
const { exec, hasBinary } = await import('../src/exec.js');

const ctx = createContext();
const ID = 'c'.repeat(32);

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

beforeEach(() => { exec.mockClear(); hasBinary.mockClear(); });

describe('term op catalog', () => {
  it('registers the four ops, ships the bridge and allows only /run/whm/term', () => {
    for (const name of ['term.open', 'term.resize', 'term.close', 'term.list']) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('term.open').destructive).toBe(true);
    expect(catalog.get('term.close').destructive).toBe(true);
    expect(catalog.get('term.list').destructive).toBe(false);
    expect(fs.existsSync(BRIDGE)).toBe(true);
    expect(fs.readFileSync(BRIDGE, 'utf8').startsWith('#!/usr/bin/env python3')).toBe(true);
    expect(TERM_RUN_DIR).toBe('/run/whm/term');
    expect(DEFAULT_ALLOWED_ROOTS).toContain('/run/whm/term');
    expect(DEFAULT_ALLOWED_ROOTS).not.toContain('/run/whm');
    expect(DEFAULT_ALLOWED_ROOTS).not.toContain('/run');
    expect(PANEL_GROUP).toBe('whmpanel');
    expect(SOCKET_NAME).toBe('pty.sock');
    expect(LIMITS).toMatchObject({ idleSeconds: 15 * 60, maxSeconds: 4 * 60 * 60, perAccount: 4 });
  });

  it('refuses bad usernames, sizes and extra fields before anything runs', async () => {
    for (const args of [{}, { username: 'root; id' }, { username: '../x' }, { username: 'Alice' }, { username: 'alice', cols: 1 }, { username: 'alice', rows: 1000 }, { username: 'alice', shell: '/bin/sh' }, { username: 'alice', cols: '80' }]) {
      expect((await opError(runOp('term.open', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    for (const id of ['abc', 'A'.repeat(32), `../${'a'.repeat(29)}`, `-${'a'.repeat(31)}`]) {
      expect((await opError(runOp('term.resize', { id, cols: 80, rows: 24 }, ctx))).code, id).toBe('invalid_args');
      expect((await opError(runOp('term.close', { id }, ctx))).code, id).toBe('invalid_args');
    }
    expect((await opError(runOp('term.list', {}, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('term.list', { username: 'alice', extra: 1 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses system accounts and unknown users', async () => {
    expect((await opError(runOp('term.open', { username: 'root' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('term.open', { username: 'whmpanel' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('term.open', { username: 'no-such-user-zz' }, ctx))).code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
  });

  it('the login shell gate rejects nologin/false, relative and missing shells', () => {
    for (const shell of ['/usr/sbin/nologin', '/bin/false', '/usr/bin/false', '', 'bash']) {
      expect(() => loginShellOf({ username: 'alice', shell }), shell).toThrow(expect.objectContaining({ code: 'shell_disabled' }));
    }
    expect(() => loginShellOf({ username: 'alice', shell: '/bin/no-such-shell' })).toThrow(expect.objectContaining({ code: 'capability_missing' }));
    if (process.platform !== 'win32' && fs.existsSync('/bin/sh')) expect(loginShellOf({ username: 'alice', shell: '/bin/sh' })).toBe('/bin/sh');
  });

  it('reads a group id from a group file and tolerates a missing one', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whm-term-')), 'group');
    fs.writeFileSync(file, 'root:x:0:\nwhmpanel:x:987:\n');
    expect(groupIdOf('whmpanel', file)).toBe(987);
    expect(groupIdOf('nobody-here', file)).toBeNull();
    expect(groupIdOf('whmpanel', `${file}.missing`)).toBeNull();
  });

  it('resize writes a control line, close signals SIGHUP, list names only the account\'s live sessions', async () => {
    const written = [];
    const kills = [];
    const fake = { id: ID, username: 'alice', dir: path.join(os.tmpdir(), 'whm-term-fake'), socket: '/run/whm/term/x/pty.sock', child: { pid: 4242, kill: (sig) => kills.push(sig), stdin: { write: (s) => written.push(s) } }, cols: 120, rows: 32, startedAt: 0, exited: false, exitReason: null, stderr: '' };
    sessions.set(ID, fake);
    try {
      await expect(runOp('term.resize', { id: ID, cols: 100, rows: 40 }, ctx)).resolves.toEqual({ id: ID, cols: 100, rows: 40 });
      expect(written).toEqual(['resize 100 40\n']);
      expect(await runOp('term.list', { username: 'alice' }, ctx)).toEqual([publicInfo({ ...fake, cols: 100, rows: 40 })]);
      expect((await runOp('term.list', { username: 'alice' }, ctx))[0]).toMatchObject({ id: ID, pid: 4242, socket: '/run/whm/term/x/pty.sock', cols: 100, rows: 40 });
      await expect(runOp('term.list', { username: 'bob' }, ctx)).resolves.toEqual([]);
      await expect(runOp('term.close', { id: ID }, ctx)).resolves.toEqual({ id: ID, existed: true, pid: 4242 });
      expect(kills).toEqual(['SIGHUP']);
      fake.exited = true;
      await expect(runOp('term.list', { username: 'alice' }, ctx)).resolves.toEqual([]);
      expect((await opError(runOp('term.resize', { id: ID, cols: 80, rows: 24 }, ctx))).code).toBe('exited');
    } finally { sessions.delete(ID); }
    expect((await opError(runOp('term.resize', { id: ID, cols: 80, rows: 24 }, ctx))).code).toBe('not_found');
    await expect(runOp('term.close', { id: ID }, ctx)).resolves.toEqual({ id: ID, existed: false });
    expect(exec).not.toHaveBeenCalled();
  });
});
