import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { READ_NAME, ARCHIVE_ROOTS, MAX_RANGE, underArchiveRoot } from '../src/ops/backup-read.js';
import { readableName } from '../src/ops/backup.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});
const { exec } = await import('../src/exec.js');

const ctx = createContext();

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

// The real read is exercised under /var/lib/whm (an archive root the agent may
// read) when the test process can create files there; otherwise only the
// refusals are checked.
const BASE = '/var/lib/whm';
// Created at collection time so skipIf() below sees the result.
const dir = (() => {
  const d = `${BASE}/panel-test-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${d}/cpmove-alice.tar.gz`, Buffer.from('0123456789abcdef'), { mode: 0o600 });
    fs.mkdirSync(`${d}/linked`);
    fs.symlinkSync(`${d}/cpmove-alice.tar.gz`, `${d}/linked/cpmove-bob.tar.gz`);
    fs.symlinkSync(d, `${d}/dirlink`);
    return d;
  } catch { fs.rmSync(d, { recursive: true, force: true }); return null; }
})();
afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe('backup.archive.read_range catalog + schema', () => {
  it('is registered, read-only, and keeps READ_NAME identical to backup.js', () => {
    expect(catalog.has('backup.archive.read_range')).toBe(true);
    expect(catalog.get('backup.archive.read_range').destructive).toBe(false);
    const names = ['cpmove-alice.tar.gz', 'alice.tar', 'backup-10.26.2026_02-00-01_alice.tar.gz', 'backup-10.26.2026_02-00-01_alice.tar', 'cpmove-a_b-c.tar.gz',
      'Alice.tar.gz', '-alice.tar.gz', 'alice.tgz', 'alice.zip', 'cpmove-alice.tar.gz.sha256', 'backup-1.26.2026_02-00-01_alice.tar.gz', '', 'x'.repeat(40) + '.tar.gz', 'alice.tar.gz\n', '1alice.tar.gz'];
    for (const n of names) expect(READ_NAME.test(n), n).toBe(readableName.safeParse(n).success);
  });

  it('rejects traversal, relative paths, non-archive names, bad ranges and extra keys', async () => {
    exec.mockClear();
    const bad = [
      { archive: 'backup/cpmove-alice.tar.gz' },
      { archive: '/backup/../etc/cpmove-alice.tar.gz' },
      { archive: '/backup/cpmove-alice.tar.gz/..' },
      { archive: '/backup/passwd' },
      { archive: '/backup/cpmove-alice.zip' },
      { archive: '/backup/cpmove-Alice.tar.gz' },
      { archive: '/backup/-alice.tar.gz' },
      { archive: '/backup/cpmove-alice.tar.gz\0' },
      { archive: '/backup/cpmove-alice.tar.gz', offset: -1 },
      { archive: '/backup/cpmove-alice.tar.gz', offset: 1.5 },
      { archive: '/backup/cpmove-alice.tar.gz', length: 0 },
      { archive: '/backup/cpmove-alice.tar.gz', length: MAX_RANGE + 1 },
      { archive: '/backup/cpmove-alice.tar.gz', owner: 'alice' },
      { archive: '/backup/cpmove-alice.tar.gz', follow: true },
      {},
    ];
    for (const args of bad) {
      const err = await opError(runOp('backup.archive.read_range', args, ctx));
      expect(err.code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses archives outside the backup roots even when the agent may read the path', async () => {
    expect(ARCHIVE_ROOTS).toEqual(['/backup', '/var/backups/whm', '/var/lib/whm']);
    for (const p of ['/home/alice/cpmove-alice.tar.gz', '/etc/whm/cpmove-alice.tar.gz', '/tmp/whm/cpmove-alice.tar.gz', '/var/lib/whmx/cpmove-alice.tar.gz']) {
      expect(underArchiveRoot(p), p).toBe(false);
      const err = await opError(runOp('backup.archive.read_range', { archive: p }, ctx));
      expect(err.code, p).toBe('path_not_allowed');
    }
    expect(underArchiveRoot('/backup/cpmove-alice.tar.gz')).toBe(true);
    expect(underArchiveRoot('/var/lib/whm/panel/cpmove-alice.tar.gz')).toBe(true);
  });

  it('reports not_found for a missing archive', async () => {
    const err = await opError(runOp('backup.archive.read_range', { archive: `/backup/no-such-${crypto.randomBytes(3).toString('hex')}.tar.gz` }, ctx));
    expect(err.code).toBe('not_found');
  });
});

describe('backup.archive.read_range on disk', () => {
  it.skipIf(!dir)('reads byte ranges with eof and refuses symlinked files or directories', async () => {
    const archive = `${dir}/cpmove-alice.tar.gz`;
    const first = await runOp('backup.archive.read_range', { archive, offset: 0, length: 10 }, ctx);
    expect(first).toMatchObject({ path: archive, size: 16, offset: 0, length: 10, eof: false });
    expect(Buffer.from(first.data, 'base64').toString()).toBe('0123456789');
    const rest = await runOp('backup.archive.read_range', { archive, offset: 10, length: 10 }, ctx);
    expect(rest).toMatchObject({ length: 6, eof: true });
    expect(Buffer.from(rest.data, 'base64').toString()).toBe('abcdef');
    const past = await runOp('backup.archive.read_range', { archive, offset: 100, length: 10 }, ctx);
    expect(past).toMatchObject({ length: 0, data: '', eof: true });
    expect((await opError(runOp('backup.archive.read_range', { archive: `${dir}/linked/cpmove-bob.tar.gz` }, ctx))).code).toBe('refused');
    expect((await opError(runOp('backup.archive.read_range', { archive: `${dir}/dirlink/cpmove-alice.tar.gz` }, ctx))).code).toBe('refused');
  });
});
