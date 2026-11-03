import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { READ_NAME, ARCHIVE_ROOTS, MAX_RANGE, DUMP_STAGING_ROOT, DUMP_NAME, underArchiveRoot, stagingDirFor } from '../src/ops/backup-read.js';
import { readableName } from '../src/ops/backup.js';
import { SYSTEM_USERS } from '../src/ops/as-user.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary } = await import('../src/exec.js');

// A hosting account the dump import may name: its home sits under /home and
// nothing inside it is touched (exec is stubbed before cp would run).
const MANAGED = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find(([name, , uid, , , home]) => Number(uid) >= 1000 && Number(uid) < 65534 && /^\/home\//.test(home || '') && !SYSTEM_USERS.has(name));
const USER = MANAGED?.[0] ?? null;
const HOME = MANAGED?.[5] ?? null;
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

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

describe('backup.dump.import', () => {
  const dump = `alice_shop-20261103T120000Z.sql`;
  const good = { username: 'alice', from: `${DUMP_STAGING_ROOT}/alice/${dump}`, to: `/home/alice/backups/${dump}` };

  it('is registered with a bounded timeout and a staging root under /var/lib/whm', () => {
    expect(catalog.has('backup.dump.import')).toBe(true);
    expect(catalog.get('backup.dump.import').destructive).toBe(false);
    expect(catalog.get('backup.dump.import').timeoutMs).toBe(600_000);
    expect(DUMP_STAGING_ROOT).toBe('/var/lib/whm/panel/dumps');
    expect(stagingDirFor('alice')).toBe('/var/lib/whm/panel/dumps/alice');
    for (const n of ['alice_shop-20261103T120000Z.sql', 'a-20261103T120000Z.sql']) expect(DUMP_NAME.test(n), n).toBe(true);
    for (const n of ['alice_shop.sql', 'Alice-20261103T120000Z.sql', '-x-20261103T120000Z.sql', 'alice_shop-20261103T120000Z.sql.gz', 'x'.repeat(65) + '-20261103T120000Z.sql', '']) expect(DUMP_NAME.test(n), n).toBe(false);
  });

  it('rejects malformed names, relative paths, traversal and extra keys before anything runs', async () => {
    exec.mockClear();
    const bad = [
      { ...good, from: `var/lib/whm/panel/dumps/alice/${dump}` },
      { ...good, from: `${DUMP_STAGING_ROOT}/alice/../bob/${dump}` },
      { ...good, from: `${DUMP_STAGING_ROOT}/alice/shadow` },
      { ...good, from: `${DUMP_STAGING_ROOT}/alice/${dump}\0` },
      { ...good, to: `backups/${dump}` },
      { ...good, to: `/home/alice/../bob/${dump}` },
      { ...good, to: '/home/alice/.ssh/authorized_keys' },
      { ...good, username: '-alice' },
      { ...good, username: 'Alice' },
      { ...good, uid: 0 },
      { ...good, gid: 0 },
      { ...good, mode: '0777' },
      {},
    ];
    for (const args of bad) {
      const err = await opError(runOp('backup.dump.import', args, ctx));
      expect(err.code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a source outside the account\'s own staging directory, whoever the account is', async () => {
    exec.mockClear();
    for (const from of [`${DUMP_STAGING_ROOT}/bob/${dump}`, `${DUMP_STAGING_ROOT}/${dump}`, `/var/lib/whm/${dump}`, `/home/alice/${dump}`, `/backup/${dump}`, `${DUMP_STAGING_ROOT}/alice/deeper/${dump}`]) {
      const err = await opError(runOp('backup.dump.import', { ...good, from }, ctx));
      expect(err.code, from).toBe('path_not_allowed');
    }
    const ghost = `ghost${crypto.randomBytes(3).toString('hex')}`;
    expect((await opError(runOp('backup.dump.import', { username: ghost, from: `${DUMP_STAGING_ROOT}/${ghost}/${dump}`, to: `/home/${ghost}/${dump}` }, ctx))).code).toBe('not_found');
    for (const sys of ['root', 'daemon']) expect((await opError(runOp('backup.dump.import', { username: sys, from: `${DUMP_STAGING_ROOT}/${sys}/${dump}`, to: `/home/${sys}/${dump}` }, ctx))).code, sys).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
  });

  it.skipIf(!USER || !IS_ROOT)('hands the staging file to the account gid and copies it under the account uid (cp never executed)', async () => {
    const staging = stagingDirFor(USER);
    const existed = fs.existsSync(staging);
    const name = `${USER.replace(/[^a-z0-9_]/g, '_')}_t${crypto.randomBytes(2).toString('hex')}-20261103T120000Z.sql`;
    const from = `${staging}/${name}`;
    const to = `${HOME}/backups-${crypto.randomBytes(3).toString('hex')}/${name}`;
    fs.mkdirSync(staging, { recursive: true, mode: 0o750 });
    fs.writeFileSync(from, 'CREATE TABLE t (id INT);\n', { mode: 0o600 });
    const [, , uidS, gidS] = MANAGED;
    hasBinary.mockImplementation((n) => ['setpriv', 'cp'].includes(n));
    exec.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', bin: 'x', argv: [] });
    try {
      expect((await opError(runOp('backup.dump.import', { username: USER, from: `${staging}/missing-20261103T120000Z.sql`, to }, ctx))).code).toBe('not_found');
      expect(exec).not.toHaveBeenCalled();
      const r = await runOp('backup.dump.import', { username: USER, from, to }, ctx);
      expect(r).toMatchObject({ from, to, username: USER, sizeBytes: 25 });
      const st = fs.statSync(from);
      expect(st.uid).toBe(0);
      expect(st.gid).toBe(Number(gidS));
      expect(st.mode & 0o777).toBe(0o640);
      expect(fs.statSync(staging).gid).toBe(Number(gidS));
      expect(fs.statSync(staging).mode & 0o777).toBe(0o750);
      const [bin, argv] = exec.mock.calls.at(-1);
      expect(bin).toBe('setpriv');
      expect(argv.slice(0, 7)).toEqual(['--reuid', uidS, '--regid', gidS, '--clear-groups', '--no-new-privs', '--']);
      expect(argv[7]).toMatch(/\/cp$/);
      expect(argv.slice(8)).toEqual(['--no-dereference', '--', from, to]);
      expect(fs.existsSync(to)).toBe(false);
    } finally {
      hasBinary.mockReset(); hasBinary.mockImplementation((await vi.importActual('../src/exec.js')).hasBinary);
      exec.mockReset(); exec.mockImplementation((await vi.importActual('../src/exec.js')).exec);
      fs.rmSync(from, { force: true });
      if (!existed) fs.rmSync(staging, { recursive: true, force: true });
    }
  });
});
