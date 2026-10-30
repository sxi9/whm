import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError } from '../src/lib.js';
import { parseQuotaonState } from '../src/ops/user.js';

// user.set_quota runs setquota as root. On a host whose quota tools are
// installed but whose filesystem was never set up (fresh AlmaLinux/Ubuntu),
// setquota fails with an opaque command_failed; the op now probes quotaon
// first and answers quota_not_enabled, which the panel records as pending.
// exec is spied with the real implementation behind it so every refusal is
// proven to happen before a program ran; setquota itself is never executed.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary } = await import('../src/exec.js');

const ctx = createContext();
const QUOTA = { username: 'whmquota', softMb: 1024, hardMb: 2048, filesystem: '/home' };

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

async function withBinaries(binaries, answer, fn) {
  const actual = await vi.importActual('../src/exec.js');
  hasBinary.mockImplementation((name) => binaries.includes(name));
  exec.mockClear();
  exec.mockImplementation(async (bin, argv) => ({ code: 0, stdout: '', stderr: '', bin, argv, ...(answer(bin, argv) || {}) }));
  try { await fn(() => exec.mock.calls.map(([bin, argv]) => [bin, ...argv])); } finally { hasBinary.mockImplementation(actual.hasBinary); exec.mockImplementation(actual.exec); }
}

describe('user.set_quota', () => {
  it('refuses bad arguments and system accounts before anything runs', async () => {
    exec.mockClear();
    for (const args of [{ ...QUOTA, username: '-u' }, { ...QUOTA, username: 'Alice' }, { ...QUOTA, softMb: -1 }, { ...QUOTA, hardMb: 1.5 }, { ...QUOTA, hardMb: '2048' }, { ...QUOTA, filesystem: 'home' }, { ...QUOTA, filesystem: '/home/../etc' }, { ...QUOTA, extra: 1 }]) {
      expect((await opError(runOp('user.set_quota', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    for (const username of ['root', 'www-data', 'mysql']) expect((await opError(runOp('user.set_quota', { ...QUOTA, username }, ctx))).code, username).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
  });

  it('answers capability_missing without the quota tools, running nothing', async () => {
    await withBinaries([], () => ({}), async (calls) => {
      const err = await opError(runOp('user.set_quota', QUOTA, ctx));
      expect(err.code).toBe('capability_missing');
      expect(calls()).toEqual([]);
    });
  });

  it('answers quota_not_enabled when quotaon reports user quotas off, and never runs setquota', async () => {
    await withBinaries(['setquota', 'quotaon'], (bin) => (bin === 'quotaon' ? { stdout: 'user quota on /home (/dev/vdb1) is off\n' } : {}), async (calls) => {
      const err = await opError(runOp('user.set_quota', QUOTA, ctx));
      expect(err.code).toBe('quota_not_enabled');
      expect(err.message).toMatch(/not enabled on \/home .*Initial Quota Setup/);
      expect(err.details).toEqual({ filesystem: '/home' });
      expect(calls()).toEqual([['quotaon', '-p', '-u', '/home']]);
    });
  });

  it('answers quota_not_enabled when the filesystem carries no quota at all (quotaon fails)', async () => {
    await withBinaries(['setquota', 'quotaon'], (bin) => (bin === 'quotaon' ? { code: 1, stderr: 'quotaon: Mountpoint (or device) /home not found or has no quota enabled.\n' } : {}), async (calls) => {
      const err = await opError(runOp('user.set_quota', QUOTA, ctx));
      expect(err.code).toBe('quota_not_enabled');
      expect(err.message).toMatch(/has no quota enabled/);
      expect(calls()).toEqual([['quotaon', '-p', '-u', '/home']]);
    });
  });

  it('runs setquota in 1K blocks once quotaon reports user quotas on', async () => {
    await withBinaries(['setquota', 'quotaon'], (bin) => (bin === 'quotaon' ? { stdout: 'user quota on /home (/dev/vdb1) is on\n' } : {}), async (calls) => {
      await expect(runOp('user.set_quota', QUOTA, ctx)).resolves.toEqual({ ...QUOTA, quotaActive: true });
      expect(calls()).toEqual([['quotaon', '-p', '-u', '/home'], ['setquota', '-u', 'whmquota', '1048576', '2097152', '0', '0', '/home']]);
      exec.mockClear();
      await expect(runOp('user.set_quota', { username: 'whmquota', softMb: 0, hardMb: 0 }, ctx)).resolves.toMatchObject({ filesystem: '/', quotaActive: true });
      expect(calls()[1]).toEqual(['setquota', '-u', 'whmquota', '0', '0', '0', '0', '/']);
    });
  });

  it('skips the probe when quotaon is missing and lets setquota decide', async () => {
    await withBinaries(['setquota'], () => ({}), async (calls) => {
      await expect(runOp('user.set_quota', QUOTA, ctx)).resolves.toEqual({ ...QUOTA, quotaActive: null });
      expect(calls()).toEqual([['setquota', '-u', 'whmquota', '1048576', '2097152', '0', '0', '/home']]);
    });
  });

  it('parseQuotaonState reads on/off from stdout or stderr and null otherwise', () => {
    expect(parseQuotaonState('user quota on / (/dev/vda1) is on\n')).toBe(true);
    expect(parseQuotaonState('', 'user quota on /home (/dev/vdb1) is off\n')).toBe(false);
    expect(parseQuotaonState('group quota on / (/dev/vda1) is on\n')).toBeNull();
    expect(parseQuotaonState('quotaon: Mountpoint (or device) / not found or has no quota enabled.\n')).toBeNull();
    expect(parseQuotaonState('')).toBeNull();
  });
});
