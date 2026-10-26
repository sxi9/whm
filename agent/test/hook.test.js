import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { HOOKS_DIR, inspectScript } from '../src/ops/hook.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

const ctx = createContext();

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('hook op schemas reject injection and traversal before anything runs', () => {
  it('unknown ops are refused', async () => {
    expect((await opError(runOp('hook.nope', {}, ctx))).code).toBe('unknown_op');
  });

  it('hook.run refuses bad names, events, stages and extra keys', async () => {
    exec.mockClear();
    const good = { name: 'notify-slack', event: 'account.created', stage: 'post', payload: '{}' };
    for (const name of ['-r', 'a;b', '../etc/passwd', '../../bin/sh', 'a/b', 'Upper', '', '.hidden', 'x'.repeat(65)]) {
      expect((await opError(runOp('hook.run', { ...good, name }, ctx))).code, name).toBe('invalid_args');
    }
    for (const event of ['account', 'Account.Created', 'a.b;c', '../x', 'a.b.c.d.e.f.g']) {
      expect((await opError(runOp('hook.run', { ...good, event }, ctx))).code, event).toBe('invalid_args');
    }
    expect((await opError(runOp('hook.run', { ...good, stage: 'during' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('hook.run', { ...good, timeoutMs: 10 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('hook.run', { ...good, timeoutMs: 10_000_000 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('hook.run', { ...good, extra: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('hook.run', { ...good, payload: 42 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('a hook that is not installed is not_found and nothing is executed', async () => {
    exec.mockClear();
    const err = await opError(runOp('hook.run', { name: 'definitely-missing-hook', event: 'account.created', payload: '{}' }, ctx));
    expect(err.code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
  });

  it('the hooks directory is the only allowed location', () => {
    expect(ctx.allowedRoots).toContain(HOOKS_DIR);
    expect(() => ctx.assertAllowedPath('/usr/local/whm/hooks/../bin/sh')).toThrow(OpError);
    expect(() => ctx.assertAllowedPath('/usr/local/bin/sh')).toThrow(OpError);
  });
});

describe('hook.list and inspectScript', () => {
  it('lists an absent directory as empty without failing', async () => {
    const res = await runOp('hook.list', {}, ctx);
    expect(res.dir).toBe(HOOKS_DIR);
    expect(Array.isArray(res.scripts)).toBe(true);
    if (!fs.existsSync(HOOKS_DIR)) expect(res).toMatchObject({ exists: false, scripts: [] });
    for (const s of res.scripts) expect(s).toMatchObject({ name: expect.any(String), runnable: expect.any(Boolean), problems: expect.any(Array) });
  });

  it('reports a missing script as not existing', () => {
    expect(inspectScript('no-such-hook')).toEqual({ name: 'no-such-hook', path: `${HOOKS_DIR}/no-such-hook`, exists: false });
  });
});
