import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { catalog } from '../src/ops/registry.js';
import { getent } from '../src/ops/as-user.js';
import { CLAMAV_AS_TIMEOUT_MS, clamdFailure } from '../src/ops/sec-clamav-as.js';

// The account panel's scanner (P2-9): the schema and the account checks refuse
// bad input before anything runs; the real-account block records the argv the
// op would run as the account and never scans for real.

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

const ctx = createContext();

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('sec.clamav.scan_as schema and account gates', () => {
  it('is registered with the 15 minute cap and a strict schema', async () => {
    const op = catalog.get('sec.clamav.scan_as');
    expect(op).toBeTruthy();
    expect(op.timeoutMs).toBe(CLAMAV_AS_TIMEOUT_MS);
    expect(CLAMAV_AS_TIMEOUT_MS).toBe(15 * 60_000);
    expect(op.schema.safeParse({ username: 'alice', path: '/home/alice' }).success).toBe(true);
    expect(op.schema.safeParse({ username: 'alice', path: '/home/alice', maxDurationSec: 900 }).success).toBe(true);
    for (const bad of [{}, { username: 'alice' }, { path: '/home/alice' }, { username: 'alice', path: '/home/alice', extra: 1 }, { username: 'alice', path: '/home/alice', maxDurationSec: 901 }, { username: 'alice', path: '/home/alice', maxDurationSec: 59 }]) {
      expect(op.schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses usernames outside the account grammar and relative or traversing paths before exec', async () => {
    exec.mockClear();
    for (const u of ['-r', 'a;b', 'Root', '../x', 'a'.repeat(33), 'root user', '']) {
      expect((await opError(runOp('sec.clamav.scan_as', { username: u, path: '/home/x' }, ctx))).code, u).toBe('invalid_args');
    }
    for (const p of ['home/alice', '/home/alice/../root', '/home/alice/..', '', 'public_html', '/home/alice\0']) {
      expect((await opError(runOp('sec.clamav.scan_as', { username: 'alice', path: p }, ctx))).code, JSON.stringify(p)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('system accounts are refused and unknown accounts are not_found, still without exec', async () => {
    exec.mockClear();
    expect((await opError(runOp('sec.clamav.scan_as', { username: 'root', path: '/root' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('sec.clamav.scan_as', { username: 'daemon', path: '/home/daemon' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('sec.clamav.scan_as', { username: 'nosuchuserzz', path: '/home/nosuchuserzz' }, ctx))).code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
  });

  it('maps clamdscan failures onto the op error codes', () => {
    expect(clamdFailure({ code: 2, stdout: '', stderr: 'ERROR: Could not connect to clamd on LocalSocket /var/run/clamav/clamd.ctl: No such file or directory\n' }, '/home/a').code).toBe('capability_missing');
    expect(clamdFailure({ code: 2, stdout: '', stderr: '/home/a/x: No such file or directory\n' }, '/home/a/x').code).toBe('not_found');
    expect(clamdFailure({ code: 2, stdout: '', stderr: 'ERROR: something odd\n' }, '/home/a').code).toBe('command_failed');
  });
});

// On a provisioned host (WHM_TEST_ACCOUNT=<user>, as root) the op is run with
// exec mocked: the argv it builds is checked, nothing is scanned.
describe('sec.clamav.scan_as against a real account', () => {
  const account = process.env.WHM_TEST_ACCOUNT;
  const info = account ? getent(account) : null;
  const canRun = Boolean(info && info.uid >= 1000 && typeof process.getuid === 'function' && process.getuid() === 0 && fs.existsSync(info.home));
  const run = canRun ? it : it.skip;

  run('runs clamdscan --fdpass as the account on a path pinned under the home', async () => {
    const calls = [];
    exec.mockImplementation(async (bin, argv) => {
      calls.push([bin, argv]);
      if (bin === 'which' || bin === 'command') return { code: 0, stdout: '/usr/bin/clamdscan\n', stderr: '' };
      return { code: 1, stdout: `${info.home}/public_html/eicar.txt: Win.Test.EICAR_HDB-1 FOUND\n${info.home}/public_html/locked: Access denied. ERROR\n`, stderr: '' };
    });
    try {
      const res = await runOp('sec.clamav.scan_as', { username: account, path: path.join(info.home, 'public_html') }, ctx);
      expect(res.infected).toEqual([{ file: `${info.home}/public_html/eicar.txt`, signature: 'Win.Test.EICAR_HDB-1' }]);
      expect(res.errors).toEqual([{ file: `${info.home}/public_html/locked`, error: 'Access denied.' }]);
      expect(res.exitCode).toBe(1);
      const scan = calls.find(([, argv]) => argv.some((a) => /clamdscan$/.test(String(a))));
      expect(scan, 'a clamdscan call').toBeTruthy();
      const [bin, argv] = scan;
      expect(bin).toBe('nice');
      expect(argv.join(' ')).toMatch(/--reuid \d+ --regid \d+ --clear-groups --no-new-privs -- \S*clamdscan --fdpass --no-summary --infected --stdout -- /);
      expect(argv.at(-1)).toBe(fs.realpathSync(path.join(info.home, 'public_html')));
    } finally { exec.mockReset(); }
    expect((await opError(runOp('sec.clamav.scan_as', { username: account, path: '/etc' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('sec.clamav.scan_as', { username: account, path: `${info.home}-other` }, ctx))).code).toBe('path_not_allowed');
  });
});
