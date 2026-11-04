import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { assertFtpDir, assertLoginFree, parsePurePwList, pureFtpdVirtualStatus, login, PURE_PASSWD, PURE_PDB, PROFTPD_PASSWD } from '../src/ops/ftp.js';
import { pureFtpdAuthLink, PURE_FTPD_AUTH_LINK } from '../src/ops/web.js';

// exec/hasBinary are spied so a test can prove an op refused before any
// program ran, or hand pure-pw/ftpasswd a canned success to inspect the argv
// and stdin they would have received. No FTP tool is ever executed for real.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary } = await import('../src/exec.js');

const ctx = createContext();
const TMP_ROOT = '/tmp/whm';
let root;
let tmpRootExisted;

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

// A hosting account the tests may name without changing anything: the ops
// refuse on other grounds (tool missing, directory outside the home) before
// any program runs.
const MANAGED = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find(([name, , uid, , , home]) => Number(uid) >= 1000 && Number(uid) < 65534 && home?.startsWith('/') && !['nobody', 'whmpanel'].includes(name));
const MANAGED_USER = MANAGED?.[0] ?? null;
const MANAGED_HOME = MANAGED?.[5] ?? null;

beforeAll(() => {
  tmpRootExisted = fs.existsSync(TMP_ROOT);
  root = `${TMP_ROOT}/ftp-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(`${root}/home/alice/pub`, { recursive: true });
  fs.mkdirSync(`${root}/home/bob`, { recursive: true });
  fs.symlinkSync('../bob', `${root}/home/alice/escape`);
  fs.symlinkSync('/etc', `${root}/home/alice/etc`);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (!tmpRootExisted) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('ftp op catalog', () => {
  it('registers the family with the right destructive flags', () => {
    for (const name of ['ftp.user.add', 'ftp.user.passwd', 'ftp.user.set_quota', 'ftp.user.remove', 'ftp.user.list', 'ftp.sync', 'ftp.virtual.status']) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('ftp.user.remove').destructive).toBe(true);
    for (const name of ['ftp.user.add', 'ftp.user.passwd', 'ftp.user.set_quota', 'ftp.user.list', 'ftp.sync', 'ftp.virtual.status']) expect(catalog.get(name).destructive, name).toBe(false);
  });
});

describe('ftp.* schemas refuse injection before anything runs', () => {
  const good = { daemon: 'pure-ftpd', login: 'shop@alice.com', password: 'S3cret-pass', username: 'alice', dir: '/home/alice/pub', quotaMb: 100 };

  it('rejects malformed logins, passwords, daemons, users and directories', async () => {
    exec.mockClear();
    for (const bad of ['-m', 'A', 'a b', 'a:b', 'a;b', '$(id)', 'a\nb', '', '.hidden', 'x'.repeat(65), 'shop@alice.com/..']) {
      const err = await opError(runOp('ftp.user.add', { ...good, login: bad }, ctx));
      expect(err.code, JSON.stringify(bad)).toBe('invalid_args');
      expect(login.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of ['', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(257)]) {
      expect((await opError(runOp('ftp.user.add', { ...good, password: bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
      expect((await opError(runOp('ftp.user.passwd', { daemon: 'pure-ftpd', login: 'shop@alice.com', password: bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    for (const bad of ['vsftpd', 'pure-pw', '', 'proftpd; id']) {
      expect((await opError(runOp('ftp.user.add', { ...good, daemon: bad }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('ftp.user.remove', { daemon: bad, login: 'x' }, ctx))).code, bad).toBe('invalid_args');
    }
    for (const bad of ['-root', 'root;x', 'Alice', '../alice', 'alice user', '']) {
      expect((await opError(runOp('ftp.user.add', { ...good, username: bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    for (const bad of ['home/alice/pub', '/home/alice/../bob', '/home/alice/pub/..', '', '/home/alice/\0x']) {
      expect((await opError(runOp('ftp.user.add', { ...good, dir: bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    for (const bad of [-1, 1.5, '10', 1e12]) {
      expect((await opError(runOp('ftp.user.add', { ...good, quotaMb: bad }, ctx))).code, String(bad)).toBe('invalid_args');
      expect((await opError(runOp('ftp.user.set_quota', { daemon: 'pure-ftpd', login: 'shop@alice.com', quotaMb: bad }, ctx))).code, String(bad)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('never accepts a caller-supplied uid, gid or home (option smuggling)', async () => {
    exec.mockClear();
    for (const extra of [{ uid: 0 }, { gid: 0 }, { home: '/root' }, { homeDir: '/root' }, { file: '/etc/passwd' }, { argv: ['-f', '/etc/shadow'] }]) {
      const err = await opError(runOp('ftp.user.add', { ...good, ...extra }, ctx));
      expect(err.code, JSON.stringify(extra)).toBe('invalid_args');
    }
    expect((await opError(runOp('ftp.user.list', { daemon: 'pure-ftpd', file: '/etc/shadow' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('ftp.sync', { daemon: 'pure-ftpd', db: '/etc/passwd' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('ftp.virtual.status', { daemon: 'wu-ftpd' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses system and unknown users without touching the host', async () => {
    exec.mockClear();
    expect((await opError(runOp('ftp.user.add', { ...good, username: 'root', dir: '/root/pub' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('ftp.user.add', { ...good, username: 'daemon' }, ctx))).code).toBe('refused');
    const ghost = `nouser${crypto.randomBytes(3).toString('hex')}`;
    expect((await opError(runOp('ftp.user.add', { ...good, username: ghost, dir: `/home/${ghost}/pub` }, ctx))).code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a virtual login that names a system user on either daemon, before any tool runs', async () => {
    exec.mockClear();
    for (const name of ['root', 'daemon', 'nobody', 'www-data', 'mysql']) {
      expect(() => assertLoginFree(name), name).toThrow(/system login/);
      for (const which of ['pure-ftpd', 'proftpd']) {
        const err = await opError(runOp('ftp.user.add', { ...good, daemon: which, login: name }, ctx));
        expect(err.code, `${which} ${name}`).toBe('exists');
      }
    }
    const [firstPasswdUser] = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')[0]).filter((n) => /^[a-z][a-z0-9._@-]{0,63}$/.test(n));
    if (firstPasswdUser) expect((await opError(runOp('ftp.user.add', { ...good, login: firstPasswdUser }, ctx))).code).toBe('exists');
    expect(() => assertLoginFree(`free${crypto.randomBytes(3).toString('hex')}`)).not.toThrow();
    expect(() => assertLoginFree('shop@alice.com')).not.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it.skipIf(!MANAGED_USER)('pins the directory inside the account home before any tool runs', async () => {
    exec.mockClear();
    const outside = ['/home/someone-else/pub', '/tmp/whm/x', '/etc', `${MANAGED_HOME}x/pub`];
    for (const dir of outside) {
      const err = await opError(runOp('ftp.user.add', { ...good, username: MANAGED_USER, dir }, ctx));
      expect(['path_not_allowed', 'invalid_args']).toContain(err.code);
    }
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('assertFtpDir', () => {
  it('accepts paths inside the home, including ones not created yet', () => {
    const home = `${root}/home/alice`;
    expect(assertFtpDir(home, `${home}/pub`, ctx)).toBe(`${home}/pub`);
    expect(assertFtpDir(home, `${home}/pub/new/deeper`, ctx)).toBe(`${home}/pub/new/deeper`);
    expect(assertFtpDir(home, home, ctx)).toBe(home);
  });

  it('refuses a sibling home under the same allowed root and symlink escapes', () => {
    const home = `${root}/home/alice`;
    expect(() => assertFtpDir(home, `${root}/home/bob`, ctx)).toThrow(/not inside/);
    expect(() => assertFtpDir(home, `${root}/home/bob/pub`, ctx)).toThrow(/not inside/);
    expect(() => assertFtpDir(home, `${root}/home/alicex/pub`, ctx)).toThrow(/not inside/);
    expect(() => assertFtpDir(home, `${home}/escape`, ctx)).toThrow(/escapes/);
    expect(() => assertFtpDir(home, `${home}/escape/pub`, ctx)).toThrow(/escapes/);
    expect(() => assertFtpDir(home, `${home}/etc/passwd`, ctx)).toThrow(/escapes/);
  });

  it('refuses a home outside the allowed roots', () => {
    expect(() => assertFtpDir('/root', '/root/pub', ctx)).toThrow(/outside the locations/);
  });
});

describe('argv construction (tools answered by a stub, never executed)', () => {
  const ok = { code: 0, stdout: '', stderr: '', bin: 'x', argv: [] };

  it('pure-pw passwd takes the login positionally and the password twice on stdin', async () => {
    hasBinary.mockImplementation((n) => n === 'pure-pw');
    exec.mockResolvedValueOnce(ok);
    try {
      const r = await runOp('ftp.user.passwd', { daemon: 'pure-ftpd', login: 'shop@alice.com', password: 'S3cret-pass' }, ctx);
      expect(r).toEqual({ daemon: 'pure-ftpd', login: 'shop@alice.com', changed: true });
      const [bin, argv, opts] = exec.mock.calls.at(-1);
      expect(bin).toBe('pure-pw');
      expect(argv).toEqual(['passwd', 'shop@alice.com', '-f', PURE_PASSWD, '-F', PURE_PDB, '-m']);
      expect(opts.input).toBe('S3cret-pass\nS3cret-pass\n');
      expect(argv.join(' ')).not.toContain('S3cret');
    } finally { hasBinary.mockReset(); hasBinary.mockImplementation((await vi.importActual('../src/exec.js')).hasBinary); exec.mockReset(); exec.mockImplementation((await vi.importActual('../src/exec.js')).exec); }
  });

  it('ftpasswd uses --stdin and the proftpd passwd file; quotas are unsupported there', async () => {
    hasBinary.mockImplementation((n) => n === 'ftpasswd');
    exec.mockResolvedValueOnce(ok).mockResolvedValueOnce(ok);
    try {
      await runOp('ftp.user.passwd', { daemon: 'proftpd', login: 'shop_alice', password: 'S3cret-pass' }, ctx);
      let [bin, argv, opts] = exec.mock.calls.at(-1);
      expect(bin).toBe('ftpasswd');
      expect(argv).toEqual(['--passwd', `--file=${PROFTPD_PASSWD}`, '--name=shop_alice', '--change-password', '--stdin']);
      expect(opts.input).toBe('S3cret-pass\n');
      await runOp('ftp.user.remove', { daemon: 'proftpd', login: 'shop_alice' }, ctx);
      [bin, argv] = exec.mock.calls.at(-1);
      expect(argv).toEqual(['--passwd', `--file=${PROFTPD_PASSWD}`, '--name=shop_alice', '--delete-user']);
      expect((await opError(runOp('ftp.user.set_quota', { daemon: 'proftpd', login: 'shop_alice', quotaMb: 10 }, ctx))).code).toBe('unsupported');
    } finally { hasBinary.mockReset(); hasBinary.mockImplementation((await vi.importActual('../src/exec.js')).hasBinary); exec.mockReset(); exec.mockImplementation((await vi.importActual('../src/exec.js')).exec); }
  });

  it('maps tool failures to stable codes', async () => {
    hasBinary.mockImplementation((n) => n === 'pure-pw');
    exec.mockResolvedValueOnce({ ...ok, code: 1, stderr: 'Error: user already exists' }).mockResolvedValueOnce({ ...ok, code: 1, stderr: 'Unable to find user' });
    try {
      expect((await opError(runOp('ftp.user.passwd', { daemon: 'pure-ftpd', login: 'dup@alice.com', password: 'S3cret-pass' }, ctx))).code).toBe('exists');
      const r = await runOp('ftp.user.remove', { daemon: 'pure-ftpd', login: 'gone@alice.com' }, ctx);
      expect(r.removed).toBe(false);
    } finally { hasBinary.mockReset(); hasBinary.mockImplementation((await vi.importActual('../src/exec.js')).hasBinary); exec.mockReset(); exec.mockImplementation((await vi.importActual('../src/exec.js')).exec); }
  });

  it('reports capability_missing without the tool and never runs anything', async () => {
    exec.mockClear();
    if (hasBinary('pure-pw') || hasBinary('ftpasswd')) return;
    expect((await opError(runOp('ftp.user.passwd', { daemon: 'pure-ftpd', login: 'shop@alice.com', password: 'S3cret-pass' }, ctx))).code).toBe('capability_missing');
    expect((await opError(runOp('ftp.user.remove', { daemon: 'proftpd', login: 'shop_alice' }, ctx))).code).toBe('capability_missing');
    expect((await opError(runOp('ftp.sync', { daemon: 'pure-ftpd' }, ctx))).code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('read-only helpers', () => {
  it('parses pure-pw list output without hashes', () => {
    expect(parsePurePwList('shop@alice.com      /home/alice/pub/./\nblog@alice.com   /home/alice/blog\n\n')).toEqual([
      { login: 'shop@alice.com', dir: '/home/alice/pub' }, { login: 'blog@alice.com', dir: '/home/alice/blog' },
    ]);
  });

  // Debian's pure-ftpd-wrapper loads an auth backend only through a symlink in
  // auth/ whose target basename names it; conf/PureDB alone (as shipped) is not
  // enough, so the status must not call it enabled.
  it('pure-ftpd PureDB counts as enabled only with a live auth/ link pointing at conf/PureDB', () => {
    const confDir = `${root}/pure-ftpd`;
    fs.mkdirSync(`${confDir}/conf`, { recursive: true });
    fs.mkdirSync(`${confDir}/auth`, { recursive: true });
    fs.writeFileSync(`${confDir}/conf/PureDB`, '/etc/pure-ftpd/pureftpd.pdb\n');
    fs.writeFileSync(`${confDir}/conf/PAMAuthentication`, 'yes\n');
    fs.symlinkSync('../conf/PAMAuthentication', `${confDir}/auth/70pam`);
    expect(pureFtpdAuthLink(confDir)).toBeNull();
    let s = pureFtpdVirtualStatus(confDir);
    expect(s).toMatchObject({ daemon: 'pure-ftpd', configured: false, enabled: false, authLink: null });
    expect(s.hint).toMatch(/auth\/50puredb/);
    // A dangling link is not a backend the wrapper can load.
    fs.symlinkSync('../conf/Missing', `${confDir}/auth/40missing`);
    expect(pureFtpdAuthLink(confDir)).toBeNull();
    // An admin's own link under Debian's README name counts (matched by target, not name).
    fs.symlinkSync('../conf/PureDB', `${confDir}/auth/50pure`);
    expect(pureFtpdAuthLink(confDir)).toBe(`${confDir}/auth/50pure`);
    s = pureFtpdVirtualStatus(confDir);
    expect(s).toMatchObject({ configured: true, dbFile: '/etc/pure-ftpd/pureftpd.pdb', authLink: `${confDir}/auth/50pure`, hint: null });
    expect(s.enabled).toBe(hasBinary('pure-pw'));
    fs.unlinkSync(`${confDir}/auth/50pure`);
    // A regular file named like the link is not a symlink and does not count.
    fs.writeFileSync(`${confDir}/auth/${PURE_FTPD_AUTH_LINK}`, '../conf/PureDB\n');
    expect(pureFtpdAuthLink(confDir)).toBeNull();
    expect(pureFtpdVirtualStatus(confDir).configured).toBe(false);
    // No auth dir at all (non-Debian layout) is simply "no link".
    expect(pureFtpdAuthLink(`${root}/nowhere`)).toBeNull();
    // The single-file layout keeps reading the PureDB directive.
    const fileLayout = `${root}/pure-file`;
    fs.mkdirSync(fileLayout, { recursive: true });
    fs.writeFileSync(`${fileLayout}/pure-ftpd.conf`, '# comment\nPureDB /etc/pure-ftpd/pureftpd.pdb\n');
    expect(pureFtpdVirtualStatus(fileLayout, `${fileLayout}/pure-ftpd.conf`)).toMatchObject({ configured: true, dbFile: '/etc/pure-ftpd/pureftpd.pdb', authLink: null });
  });

  it('ftp.virtual.status reports every daemon and marks vsftpd unsupported', async () => {
    const r = await runOp('ftp.virtual.status', {}, ctx);
    expect(Object.keys(r.daemons).sort()).toEqual(['proftpd', 'pure-ftpd', 'vsftpd']);
    expect(r.daemons.vsftpd).toMatchObject({ supported: false, enabled: false });
    for (const d of ['pure-ftpd', 'proftpd']) expect(r.daemons[d]).toMatchObject({ supported: true, passwdFile: expect.any(String) });
    const one = await runOp('ftp.virtual.status', { daemon: 'proftpd' }, ctx);
    expect(one.daemon).toBe('proftpd');
  });
});
