import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec, hasBinary } from '../src/exec.js';
import { runOp, createContext, OpError, DEFAULT_ALLOWED_ROOTS, catalog, PHP_MINORS, PHP_UNIT_PATHS, PHP_LINK_PATHS } from '../src/lib.js';
import {
  parseOsRelease, pickNodeTarball, verifySha256, probePpaSeries, phpDiscovery, phpPackageGlob, discoverPhp, preferKeelBuilds, parsePhpRelease, renderPhpUnit, phpMinor, PHP_SOURCE_MINORS,
  APT_SOURCES_DIR, APT_KEYRINGS_DIR, YUM_REPOS_DIR, NODE_DIR, LOCAL_BIN_DIR, KEEL_PHP_DIR, KEEL_PHP_RUN_DIR, SYSTEMD_UNIT_DIR,
} from '../src/ops/pkg.js';
import { phpLayout } from '../src/ops/web.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const realHasBinary = async () => (await vi.importActual('../src/exec.js')).hasBinary;

// Every directory the runtime ops touch is moved into one scratch tree; each
// is an allowed root of its own so the checks behave the same on every host.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-runtime-'));
const dirs = {
  WHM_APT_SOURCES_DIR: path.join(base, 'sources.list.d'),
  WHM_APT_KEYRINGS_DIR: path.join(base, 'keyrings'),
  WHM_YUM_REPOS_DIR: path.join(base, 'yum.repos.d'),
  WHM_NODE_DIR: path.join(base, 'node'),
  WHM_LOCAL_BIN_DIR: path.join(base, 'bin'),
  WHM_KEEL_PHP_DIR: path.join(base, 'php'),
  WHM_SYSTEMD_UNIT_DIR: path.join(base, 'systemd'),
  WHM_PKG_RUN_DIR: path.join(base, 'pkg-runs'),
};
const osRelease = path.join(base, 'os-release');
const previousEnv = {};
for (const [k, v] of Object.entries({ ...dirs, WHM_OS_RELEASE_FILE: osRelease })) { previousEnv[k] = process.env[k]; process.env[k] = v; fs.mkdirSync(path.dirname(v), { recursive: true }); }
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
afterAll(() => {
  for (const [k, v] of Object.entries(previousEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(base, { recursive: true, force: true });
});

const ctx = createContext({ allowedRoots: [...DEFAULT_ALLOWED_ROOTS, ...Object.values(dirs), osRelease] });
const defaultCtx = createContext();
const linux = process.platform === 'linux';
const archOk = process.arch === 'x64' || process.arch === 'arm64';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

const OS = {
  ubuntu: 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n',
  debian: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nVERSION="12 (bookworm)"\nVERSION_CODENAME=bookworm\nID=debian\n',
  rocky: 'NAME="Rocky Linux"\nVERSION="9.4 (Blue Onyx)"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\nPLATFORM_ID="platform:el9"\n',
  el7: 'NAME="CentOS Linux"\nID="centos"\nID_LIKE="rhel fedora"\nVERSION_ID="7"\n',
};
const setOs = (text) => fs.writeFileSync(osRelease, text);
const clearDir = (dir) => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); };
const ok = (stdout = '', code = 0) => ({ stdout, stderr: '', code });

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

const realDiscover = phpDiscovery.discover;
beforeEach(async () => {
  exec.mockReset();
  exec.mockImplementation(async (bin, argv) => { throw new Error(`unexpected exec: ${bin} ${argv.join(' ')}`); });
  hasBinary.mockReset();
  hasBinary.mockImplementation(await realHasBinary());
  phpDiscovery.discover = realDiscover;
  for (const d of Object.values(dirs)) clearDir(d);
});

const INJECTION = ['-r', 'a;b', 'a b', '../x', '$(id)', 'a|b', 'a\nb', '', '`id`', 'ppa:ondrej/php', 'PHP', 'php '];

describe('runtime op schemas reject anything but the enum and the integer range', () => {
  it('pkg.repo.ensure takes only the four repository names', async () => {
    for (const bad of INJECTION) expect((await opError(runOp('pkg.repo.ensure', { repo: bad }, ctx))).code, bad).toBe('invalid_args');
    expect((await opError(runOp('pkg.repo.ensure', {}, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.repo.ensure', { repo: 'php', update: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.repo.ensure', { repo: ['php'] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('pkg.node.install / pkg.node.remove take an integer major between 16 and 30 and nothing else', async () => {
    for (const bad of [15, 31, 20.5, '20', '20; rm -rf /', -20, null, 1e3, NaN]) {
      expect((await opError(runOp('pkg.node.install', { major: bad }, ctx))).code, String(bad)).toBe('invalid_args');
      expect((await opError(runOp('pkg.node.remove', { major: bad }, ctx))).code, String(bad)).toBe('invalid_args');
    }
    expect((await opError(runOp('pkg.node.install', {}, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.node.install', { major: 20, url: 'https://evil' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.node.install', { major: 20, wait: 'no' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.node.remove', { major: 20, wait: false }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.os.release', { file: '/etc/passwd' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.node.list', { dir: '/' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.runtime.detect', { install: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('registers the six ops with pkg.node.remove as the only destructive one', () => {
    for (const name of ['pkg.os.release', 'pkg.repo.ensure', 'pkg.node.list', 'pkg.node.install', 'pkg.node.remove', 'pkg.runtime.detect']) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('pkg.node.remove').destructive).toBe(true);
    expect(catalog.get('pkg.node.install').destructive).toBe(false);
    expect(catalog.get('pkg.node.install').timeoutMs).toBe(15 * 60_000);
    expect([APT_SOURCES_DIR, APT_KEYRINGS_DIR, YUM_REPOS_DIR, NODE_DIR].every((p) => DEFAULT_ALLOWED_ROOTS.includes(p))).toBe(true);
    // Only the versioned links are writable, never the directory: a hook or any other op must not reach /usr/local/bin/sh.
    expect(DEFAULT_ALLOWED_ROOTS).not.toContain(LOCAL_BIN_DIR);
    for (const m of [16, 20, 30]) for (const n of ['node', 'npm', 'npx']) expect(DEFAULT_ALLOWED_ROOTS).toContain(`${LOCAL_BIN_DIR}/${n}${m}`);
    expect(DEFAULT_ALLOWED_ROOTS).not.toContain(`${LOCAL_BIN_DIR}/node31`);
  });
});

describe('parseOsRelease', () => {
  it('reads Ubuntu, Debian and an EL derivative into a family', () => {
    expect(parseOsRelease(OS.ubuntu)).toEqual({ id: 'ubuntu', idLike: ['debian'], versionId: '24.04', codename: 'noble', family: 'debian' });
    expect(parseOsRelease(OS.debian)).toEqual({ id: 'debian', idLike: [], versionId: '12', codename: 'bookworm', family: 'debian' });
    expect(parseOsRelease(OS.rocky)).toEqual({ id: 'rocky', idLike: ['rhel', 'centos', 'fedora'], versionId: '9.4', codename: null, family: 'rhel' });
  });

  it('tolerates comments, quotes, escapes and unknown distributions', () => {
    expect(parseOsRelease('# comment\nID=\'alpine\'\nVERSION_ID=3.19.1\nPRETTY_NAME="Alpine \\"Linux\\""\n')).toEqual({ id: 'alpine', idLike: [], versionId: '3.19.1', codename: null, family: null });
    expect(parseOsRelease('')).toEqual({ id: null, idLike: [], versionId: null, codename: null, family: null });
    expect(parseOsRelease(null).family).toBeNull();
  });

  it('pkg.os.release serves the parsed file', async () => {
    setOs(OS.ubuntu);
    expect(await runOp('pkg.os.release', {}, ctx)).toMatchObject({ id: 'ubuntu', family: 'debian', codename: 'noble' });
    expect(exec).not.toHaveBeenCalled();
  });
});

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHASUMS = [
  `${SHA_A}  node-v20.18.1-darwin-arm64.tar.gz`,
  `${SHA_B}  node-v20.18.1-linux-arm64.tar.xz`,
  `${'c'.repeat(64)}  node-v20.18.1-linux-x64.tar.gz`,
  `${'d'.repeat(64)}  node-v20.18.1-linux-x64.tar.xz`,
  `${'e'.repeat(64)}  node-v20.18.1-win-x64.zip`,
  '',
].join('\n');

describe('pickNodeTarball / verifySha256', () => {
  it('picks the linux tar.xz of the requested arch and reports its version', () => {
    expect(pickNodeTarball(SHASUMS, 20, 'x64')).toEqual({ file: 'node-v20.18.1-linux-x64.tar.xz', sha256: 'd'.repeat(64), version: 'v20.18.1' });
    expect(pickNodeTarball(SHASUMS, 20, 'arm64')).toEqual({ file: 'node-v20.18.1-linux-arm64.tar.xz', sha256: SHA_B, version: 'v20.18.1' });
  });

  it('returns null when the major has no linux build for that arch', () => {
    expect(pickNodeTarball(SHASUMS, 20, 'ppc64le')).toBeNull();
    expect(pickNodeTarball(SHASUMS, 22, 'x64')).toBeNull();
    expect(pickNodeTarball(`${SHA_A}  node-v2.18.1-linux-x64.tar.xz\n`, 20, 'x64')).toBeNull();
    expect(pickNodeTarball(`${SHA_A}  node-v20.18.1-linux-x64.tar.xz.sig\n`, 20, 'x64')).toBeNull();
    expect(pickNodeTarball('', 20, 'x64')).toBeNull();
  });

  it('verifies a sha256 and rejects malformed digests', () => {
    const buf = Buffer.from('hello node');
    const hex = crypto.createHash('sha256').update(buf).digest('hex');
    expect(verifySha256(buf, hex)).toBe(true);
    expect(verifySha256(buf, hex.toUpperCase())).toBe(true);
    expect(verifySha256(buf, SHA_A)).toBe(false);
    expect(verifySha256(buf, hex.slice(0, 63))).toBe(false);
    expect(verifySha256(buf, 'not hex')).toBe(false);
    expect(verifySha256(Buffer.from('hello nodf'), hex)).toBe(false);
  });
});

describe('pkg.repo.ensure', () => {
  it('reports an Ubuntu PPA as present without running anything (new and legacy host names)', async () => {
    setOs(OS.ubuntu);
    fs.writeFileSync(path.join(dirs.WHM_APT_SOURCES_DIR, 'ondrej-ubuntu-php-noble.sources'), 'Types: deb\nURIs: https://ppa.launchpadcontent.net/ondrej/php/ubuntu/\nSuites: noble\n');
    fs.writeFileSync(path.join(dirs.WHM_APT_SOURCES_DIR, 'deadsnakes.list'), 'deb http://ppa.launchpad.net/deadsnakes/ppa/ubuntu noble main\n');
    const php = await runOp('pkg.repo.ensure', { repo: 'php' }, ctx);
    expect(php).toMatchObject({ repo: 'php', family: 'debian', action: 'present' });
    expect(php.detail).toContain('ondrej-ubuntu-php-noble.sources');
    expect(await runOp('pkg.repo.ensure', { repo: 'python' }, ctx)).toMatchObject({ repo: 'python', action: 'present' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('enables CRB on Enterprise Linux through dnf config-manager only when repolist lacks it, and refuses it on Debian', async () => {
    setOs(OS.rocky);
    const calls = [];
    exec.mockImplementation(async (bin, argv) => { calls.push([bin, ...argv]); if (argv[1] === 'repolist') return ok('repo id  repo name\nappstream  Rocky Linux 9 - AppStream\nbaseos  Rocky Linux 9 - BaseOS\n'); return ok(); });
    expect(await runOp('pkg.repo.ensure', { repo: 'crb' }, ctx)).toMatchObject({ repo: 'crb', family: 'rhel', action: 'added' });
    expect(calls).toEqual([['dnf', '-q', 'repolist', '--enabled'], ['dnf', '-y', '-q', 'config-manager', '--set-enabled', 'crb']]);
    exec.mockImplementation(async (bin, argv) => (argv[1] === 'repolist' ? ok('crb  Rocky Linux 9 - CRB\n') : (() => { throw new Error('unexpected'); })()));
    expect(await runOp('pkg.repo.ensure', { repo: 'crb' }, ctx)).toMatchObject({ action: 'present' });
    setOs(OS.ubuntu);
    expect(await runOp('pkg.repo.ensure', { repo: 'crb' }, ctx)).toMatchObject({ action: 'unsupported' });
  });

  it('does not count a file that merely names another PPA', async () => {
    setOs(OS.ubuntu);
    fs.writeFileSync(path.join(dirs.WHM_APT_SOURCES_DIR, 'other.list'), 'deb https://ppa.launchpadcontent.net/ondrej/apache2/ubuntu noble main\n');
    fs.writeFileSync(path.join(dirs.WHM_APT_SOURCES_DIR, 'notes.txt'), 'ppa.launchpadcontent.net/ondrej/php\n');
    const real = await realHasBinary();
    let sptInstalled = false;
    exec.mockImplementation(async (bin, argv) => { if (bin === 'curl') return ok('200'); if (bin === 'apt-get') { sptInstalled = true; return ok(); } if (bin === 'add-apt-repository') return ok(); throw new Error(`unexpected ${bin} ${argv}`); });
    // add-apt-repository counts as present once the (mocked) software-properties-common install ran, whatever this host has.
    hasBinary.mockImplementation((name) => (name === 'add-apt-repository' ? sptInstalled || real(name) : real(name)));
    const r = await runOp('pkg.repo.ensure', { repo: 'php' }, ctx);
    expect(r).toMatchObject({ repo: 'php', family: 'debian', action: 'added' });
    const calls = exec.mock.calls.map((c) => [c[0], c[1]]);
    expect(calls[0][0]).toBe('curl');
    expect(calls[calls.length - 1]).toEqual(['add-apt-repository', ['-y', '--no-update', 'ppa:ondrej/php']]);
    const aptGet = calls.filter((c) => c[0] === 'apt-get');
    expect(aptGet.length).toBeLessThanOrEqual(1);
    if (aptGet.length) expect(aptGet[0][1]).toEqual(['install', '-y', '-q', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', '--', 'software-properties-common']);
    for (const c of exec.mock.calls.filter((c) => c[0] !== 'curl')) expect(c[2].env).toMatchObject({ DEBIAN_FRONTEND: 'noninteractive' });
    expect(exec.mock.calls.some((c) => c[0] === 'apt-get' && c[1].includes('update'))).toBe(false);
  });

  it('adds the sury repository on Debian with a verified key file and an exact list line', async () => {
    setOs(OS.debian);
    exec.mockImplementation(async (bin, argv) => {
      if (bin !== 'curl') throw new Error(`unexpected ${bin}`);
      expect(argv.slice(0, 7)).toEqual(['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--max-time', '60']);
      expect(argv[argv.length - 1]).toBe('https://packages.sury.org/php/apt.gpg');
      const out = argv[argv.indexOf('-o') + 1];
      expect(path.dirname(out)).toBe(dirs.WHM_APT_KEYRINGS_DIR);
      expect(fs.lstatSync(out).isFile()).toBe(true);
      fs.writeFileSync(out, 'KEYDATA');
      return ok();
    });
    const r = await runOp('pkg.repo.ensure', { repo: 'php' }, ctx);
    expect(r).toMatchObject({ repo: 'php', family: 'debian', action: 'added' });
    const key = path.join(dirs.WHM_APT_KEYRINGS_DIR, 'keel-sury-php.gpg');
    expect(fs.readFileSync(key, 'utf8')).toBe('KEYDATA');
    if (linux) expect(fs.statSync(key).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(path.join(dirs.WHM_APT_SOURCES_DIR, 'keel-sury-php.list'), 'utf8')).toBe(`deb [signed-by=${key}] https://packages.sury.org/php/ bookworm main\n`);
    expect(fs.readdirSync(dirs.WHM_APT_KEYRINGS_DIR)).toEqual(['keel-sury-php.gpg']);
    expect(fs.readdirSync(dirs.WHM_APT_SOURCES_DIR)).toEqual(['keel-sury-php.list']);
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockClear();
    expect(await runOp('pkg.repo.ensure', { repo: 'php' }, ctx)).toMatchObject({ action: 'present' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('leaves no key behind when the download fails', async () => {
    setOs(OS.debian);
    exec.mockImplementation(async () => { throw new OpError('command_failed', 'curl: (22) 404'); });
    expect((await opError(runOp('pkg.repo.ensure', { repo: 'php' }, ctx))).code).toBe('command_failed');
    expect(fs.readdirSync(dirs.WHM_APT_KEYRINGS_DIR)).toEqual([]);
    expect(fs.readdirSync(dirs.WHM_APT_SOURCES_DIR)).toEqual([]);
  });

  it('is unsupported for python on Debian and for epel/remi on any Debian family, without running anything', async () => {
    setOs(OS.debian);
    expect(await runOp('pkg.repo.ensure', { repo: 'python' }, ctx)).toMatchObject({ repo: 'python', family: 'debian', action: 'unsupported' });
    expect(await runOp('pkg.repo.ensure', { repo: 'epel' }, ctx)).toMatchObject({ action: 'unsupported' });
    setOs(OS.ubuntu);
    expect(await runOp('pkg.repo.ensure', { repo: 'remi' }, ctx)).toMatchObject({ action: 'unsupported' });
    setOs('ID=alpine\n');
    expect(await runOp('pkg.repo.ensure', { repo: 'php' }, ctx)).toMatchObject({ family: null, action: 'unsupported' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('on EL asks rpm first and only installs what is missing', async () => {
    setOs(OS.rocky);
    const installed = new Set(['epel-release']);
    exec.mockImplementation(async (bin, argv) => {
      if (bin === 'rpm') { expect(argv.slice(0, 2)).toEqual(['-q', '--']); return ok('', installed.has(argv[2]) ? 0 : 1); }
      if (bin === 'dnf') { expect(argv.slice(0, 4)).toEqual(['-y', '-q', 'install', '--']); installed.add(argv[4] === 'epel-release' ? 'epel-release' : 'remi-release'); return ok(); }
      throw new Error(`unexpected ${bin}`);
    });
    expect(await runOp('pkg.repo.ensure', { repo: 'epel' }, ctx)).toMatchObject({ repo: 'epel', family: 'rhel', action: 'present' });
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['rpm']);
    exec.mockClear();
    expect(await runOp('pkg.repo.ensure', { repo: 'php' }, ctx)).toMatchObject({ repo: 'php', family: 'rhel', action: 'added' });
    expect(exec.mock.calls.map((c) => [c[0], c[1][c[1].length - 1]])).toEqual([['rpm', 'epel-release'], ['rpm', 'remi-release'], ['dnf', 'https://rpms.remirepo.net/enterprise/remi-release-9.rpm']]);
    exec.mockClear();
    expect(await runOp('pkg.repo.ensure', { repo: 'remi' }, ctx)).toMatchObject({ action: 'present' });
    expect(await runOp('pkg.repo.ensure', { repo: 'python' }, ctx)).toMatchObject({ family: 'rhel', action: 'present' });
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['rpm']);
  });

  it('refuses remi on an EL major it does not publish', async () => {
    setOs(OS.el7);
    exec.mockImplementation(async (bin) => { if (bin === 'rpm') return ok('', 1); throw new Error(`unexpected ${bin}`); });
    const r = await runOp('pkg.repo.ensure', { repo: 'remi' }, ctx);
    expect(r).toMatchObject({ repo: 'remi', family: 'rhel', action: 'unsupported' });
    expect(r.detail).toMatch(/8, 9, 10/);
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['rpm']);
  });

  it('refuses a sources directory override outside the allowed roots before reading or running anything', async () => {
    setOs(OS.ubuntu);
    const prev = process.env.WHM_APT_SOURCES_DIR;
    process.env.WHM_APT_SOURCES_DIR = '/usr/share/keel-sources';
    try {
      expect((await opError(runOp('pkg.repo.ensure', { repo: 'php' }, ctx))).code).toBe('path_not_allowed');
    } finally { process.env.WHM_APT_SOURCES_DIR = prev; }
    const prevOs = process.env.WHM_OS_RELEASE_FILE;
    process.env.WHM_OS_RELEASE_FILE = '/usr/share/os-release';
    try {
      expect((await opError(runOp('pkg.os.release', {}, ctx))).code).toBe('path_not_allowed');
    } finally { process.env.WHM_OS_RELEASE_FILE = prevOs; }
    expect((await opError(runOp('pkg.repo.ensure', { repo: 'php' }, defaultCtx))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('pkg.node.*', () => {
  const nodeMock = ({ shasums, tarball, extract = true, version = 'v20.18.1' }) => async (bin, argv) => {
    if (bin === 'curl') {
      expect(argv.slice(0, 7)).toEqual(['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--max-time', '600']);
      const url = argv[argv.length - 1];
      if (url.endsWith('/SHASUMS256.txt')) { expect(url).toBe('https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt'); return ok(shasums); }
      const out = argv[argv.indexOf('-o') + 1];
      expect(path.basename(path.dirname(out))).toMatch(/^\.tmp-/);
      expect(path.dirname(path.dirname(out))).toBe(dirs.WHM_NODE_DIR);
      fs.writeFileSync(out, tarball);
      return ok();
    }
    if (bin === 'tar') {
      expect(argv.slice(0, 3)).toEqual(['--no-same-owner', '--no-same-permissions', '-xJf']);
      expect(argv[4]).toBe('-C');
      const dir = path.join(argv[5], path.basename(argv[3]).replace(/\.tar\.xz$/, ''));
      if (extract) { fs.mkdirSync(path.join(dir, 'bin'), { recursive: true }); for (const n of ['node', 'npm', 'npx']) fs.writeFileSync(path.join(dir, 'bin', n), `#!${n}\n`); }
      return ok();
    }
    if (argv[0] === '--version' && bin.endsWith(path.join('bin', 'node'))) return ok(`${version}\n`);
    throw new Error(`unexpected ${bin} ${argv.join(' ')}`);
  };
  const tarball = Buffer.from('fake-node-tarball');
  const shasumsFor = (buf) => `${crypto.createHash('sha256').update(buf).digest('hex')}  node-v20.18.1-linux-${arch}.tar.xz\n`;

  it.skipIf(!archOk)('refuses a tarball whose checksum differs and leaves no partial directory behind', async () => {
    exec.mockImplementation(nodeMock({ shasums: shasumsFor(Buffer.from('the real tarball')), tarball }));
    const err = await opError(runOp('pkg.node.install', { major: 20 }, ctx));
    expect(err.code).toBe('checksum_mismatch');
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['curl', 'curl']);
    expect(fs.readdirSync(dirs.WHM_NODE_DIR)).toEqual([]);
    expect(fs.readdirSync(dirs.WHM_LOCAL_BIN_DIR)).toEqual([]);
  });

  it.skipIf(!archOk)('reports a major nodejs.org has no linux build for and cleans up', async () => {
    exec.mockImplementation(nodeMock({ shasums: `${SHA_A}  node-v20.18.1-darwin-${arch}.tar.gz\n`, tarball }));
    expect((await opError(runOp('pkg.node.install', { major: 20 }, ctx))).code).toBe('not_found');
    expect(fs.readdirSync(dirs.WHM_NODE_DIR)).toEqual([]);
  });

  it.skipIf(!archOk || !linux)('installs a verified build under <dir>/<major> with node20/npm20/npx20 links and replaces an older one', async () => {
    fs.mkdirSync(path.join(dirs.WHM_NODE_DIR, '20', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dirs.WHM_NODE_DIR, '20', 'bin', 'node'), 'old');
    fs.symlinkSync(path.join(dirs.WHM_NODE_DIR, '20', 'bin', 'node'), path.join(dirs.WHM_LOCAL_BIN_DIR, 'node20'));
    fs.writeFileSync(path.join(dirs.WHM_LOCAL_BIN_DIR, 'npx20'), '#!/bin/sh\n');
    exec.mockImplementation(nodeMock({ shasums: shasumsFor(tarball), tarball }));
    const r = await runOp('pkg.node.install', { major: 20, wait: false }, ctx);
    const target = path.join(dirs.WHM_NODE_DIR, '20');
    expect(r).toMatchObject({ major: 20, version: 'v20.18.1', path: target, bin: path.join(target, 'bin', 'node') });
    expect(r.symlinks).toEqual([path.join(dirs.WHM_LOCAL_BIN_DIR, 'node20'), path.join(dirs.WHM_LOCAL_BIN_DIR, 'npm20')]);
    expect(r.conflicts.map((c) => c.link)).toEqual([path.join(dirs.WHM_LOCAL_BIN_DIR, 'npx20')]);
    expect(r.output.some((l) => /installed under/.test(l))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toBe('#!node\n');
    expect(fs.readlinkSync(path.join(dirs.WHM_LOCAL_BIN_DIR, 'node20'))).toBe(path.join(target, 'bin', 'node'));
    expect(fs.readFileSync(path.join(dirs.WHM_LOCAL_BIN_DIR, 'npx20'), 'utf8')).toBe('#!/bin/sh\n');
    expect(fs.readdirSync(dirs.WHM_NODE_DIR)).toEqual(['20']);
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['curl', 'curl', 'tar', path.join(target, 'bin', 'node')]);
    const list = await runOp('pkg.node.list', {}, ctx);
    expect(list.versions).toEqual([{ major: 20, version: 'v20.18.1', path: target, bin: path.join(target, 'bin', 'node') }]);
    const removed = await runOp('pkg.node.remove', { major: 20 }, ctx);
    expect(removed).toMatchObject({ major: 20, removed: true, path: target });
    expect(removed.symlinks.sort()).toEqual([path.join(dirs.WHM_LOCAL_BIN_DIR, 'node20'), path.join(dirs.WHM_LOCAL_BIN_DIR, 'npm20')]);
    expect(fs.readdirSync(dirs.WHM_LOCAL_BIN_DIR)).toEqual(['npx20']);
    expect(fs.existsSync(target)).toBe(false);
    expect(await runOp('pkg.node.remove', { major: 20 }, ctx)).toMatchObject({ removed: false, symlinks: [] });
  });

  it('lists builds by their directory name and probes each binary with a timeout', async () => {
    for (const major of ['18', '22', 'x', '.tmp-abc']) { fs.mkdirSync(path.join(dirs.WHM_NODE_DIR, major, 'bin'), { recursive: true }); fs.writeFileSync(path.join(dirs.WHM_NODE_DIR, major, 'bin', 'node'), ''); }
    fs.mkdirSync(path.join(dirs.WHM_NODE_DIR, '20'));
    exec.mockImplementation(async (bin, argv, opts) => { expect(argv).toEqual(['--version']); expect(opts.timeoutMs).toBe(15_000); return ok(bin.includes(`${path.sep}18${path.sep}`) ? 'v18.20.4\n' : 'v22.11.0\n'); });
    const list = await runOp('pkg.node.list', {}, ctx);
    expect(list.versions.map((v) => [v.major, v.version])).toEqual([[18, 'v18.20.4'], [22, 'v22.11.0']]);
    expect(list.versions[0].bin).toBe(path.join(dirs.WHM_NODE_DIR, '18', 'bin', 'node'));
    expect(list.system === null || (typeof list.system.path === 'string')).toBe(true);
  });

  it('refuses a node directory override outside the allowed roots', async () => {
    const prev = process.env.WHM_NODE_DIR;
    process.env.WHM_NODE_DIR = '/usr/share/keel-node';
    try {
      expect((await opError(runOp('pkg.node.list', {}, ctx))).code).toBe('path_not_allowed');
      expect((await opError(runOp('pkg.node.install', { major: 20 }, ctx))).code).toBe(archOk ? 'path_not_allowed' : 'unsupported');
      expect((await opError(runOp('pkg.node.remove', { major: 20 }, ctx))).code).toBe('path_not_allowed');
    } finally { process.env.WHM_NODE_DIR = prev; }
    expect(fs.existsSync('/usr/share/keel-node')).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('pkg.runtime.detect', () => {
  it('probes only with --version style calls and returns every runtime slot', async () => {
    setOs(OS.ubuntu);
    fs.mkdirSync(path.join(dirs.WHM_NODE_DIR, '22', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dirs.WHM_NODE_DIR, '22', 'bin', 'node'), '');
    exec.mockImplementation(async (bin, argv, opts) => {
      expect(opts.timeoutMs).toBeLessThanOrEqual(20_000);
      expect(argv.some((a) => /install|add|remove/.test(a))).toBe(false);
      if (bin.endsWith('node')) return ok('v22.11.0\n');
      if (/python/.test(bin)) return ok('Python 3.12.3\n');
      if (/ruby/.test(bin)) return ok('ruby 3.3.0 (2023-12-25 revision 5124f9ac75) [x86_64-linux]\n');
      if (/go$/.test(bin)) return ok('go version go1.22.1 linux/amd64\n');
      if (/composer/.test(bin)) { expect(argv).toEqual(['--version', '--no-ansi', '--no-interaction', '--no-plugins', '--no-scripts']); expect(opts.cwd).toBe('/'); return ok('Composer version 2.7.1 2024-02-09 15:26:28\n'); }
      if (/perl/.test(bin)) return ok('v5.38.2');
      if (/php/.test(bin)) return ok('8.3.6');
      return ok('');
    });
    const r = await runOp('pkg.runtime.detect', {}, ctx);
    expect(r.os).toMatchObject({ id: 'ubuntu', family: 'debian' });
    expect(Array.isArray(r.php)).toBe(true);
    expect(r.node.versions).toEqual([{ major: 22, version: 'v22.11.0', path: path.join(dirs.WHM_NODE_DIR, '22'), bin: path.join(dirs.WHM_NODE_DIR, '22', 'bin', 'node') }]);
    expect(Array.isArray(r.python)).toBe(true);
    for (const p of r.python) expect(p).toMatchObject({ minor: expect.stringMatching(/^3\.\d+$/), version: '3.12.3', bin: expect.any(String) });
    for (const key of ['ruby', 'go', 'composer', 'perl']) expect(r[key] === null || typeof r[key] === 'string', key).toBe(true);
    if (r.perl) expect(r.perl).toBe('5.38.2');
    if (r.ruby) expect(r.ruby).toBe('3.3.0');
    if (r.go) expect(r.go).toBe('1.22.1');
    if (r.composer) expect(r.composer).toBe('2.7.1');
  });

  it('reports a Keel source build with its layout, source flag and prefix', async () => {
    setOs(OS.ubuntu);
    const prefix = fakeKeelTree('8.4');
    exec.mockImplementation(async (bin) => (bin === path.join(prefix, 'bin', 'php') ? ok('8.4.27') : ok('')));
    const r = await runOp('pkg.runtime.detect', {}, ctx);
    expect(r.php.find((p) => p.id === '8.4')).toEqual({ id: '8.4', version: '8.4.27', layout: 'keel', source: true, prefix });
    for (const p of r.php.filter((x) => x.layout !== 'keel')) expect(p.source).toBe(false);
    // packagedTwin appears only when distro packages of the same minor remain (the host has no /etc/php/8.4 here).
    expect(r.php.find((p) => p.id === '8.4').packagedTwin).toBeUndefined();
    expect(r.php.filter((p) => p.id === '8.4')).toHaveLength(1);
  });

  it.skipIf(!linux)('reports the distribution packages a Keel build shadows as packagedTwin with their PHP_VERSION', async () => {
    const distro = fs.existsSync('/etc/php') ? fs.readdirSync('/etc/php').find((d) => /^\d\.\d+$/.test(d) && fs.existsSync(`/usr/bin/php${d}`)) : null;
    if (!distro) return;
    setOs(OS.ubuntu);
    const prefix = fakeKeelTree(distro);
    exec.mockImplementation(async (bin) => (bin === path.join(prefix, 'bin', 'php') ? ok(`${distro}.99`) : bin === `/usr/bin/php${distro}` ? ok(`${distro}.1`) : ok('')));
    const r = await runOp('pkg.runtime.detect', {}, ctx);
    expect(r.php.filter((p) => p.id === distro)).toHaveLength(1);
    expect(r.php.find((p) => p.id === distro)).toEqual({ id: distro, version: `${distro}.99`, layout: 'keel', source: true, prefix, packagedTwin: { binary: `/usr/bin/php${distro}`, version: `${distro}.1`, layout: 'debian', packagePrefix: `php${distro}-` } });
    const v = (await runOp('pkg.php.versions', {}, ctx)).versions.find((x) => x.id === distro);
    expect(v).toMatchObject({ layout: 'keel', version: `${distro}.99`, packagePrefix: null, packagedTwin: { binary: `/usr/bin/php${distro}`, version: `${distro}.1`, fpmUnit: `php${distro}-fpm`, poolDir: `/etc/php/${distro}/fpm/pool.d` } });
    expect(phpLayout().versions.filter((x) => x.version === distro)).toEqual([expect.objectContaining({ flavor: 'keel', poolDir: `${prefix}/etc/php-fpm.d` })]);
  });
});

// --- PHP Version Manager: PPA series probe, pkg.repo.status, pkg.php.remove ---

const HEAD_ARGV = ['-fsSI', '--proto', '=https', '--proto-redir', '=https', '--max-time', '20', '-o', '/dev/null', '-w', '%{http_code}'];
const RESOLUTE = 'NAME="Ubuntu"\nVERSION_ID="26.04"\nID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=resolute\nUBUNTU_CODENAME=resolute\n';
const PHP_SET = (defaultId = '8.3') => ({
  versions: [
    { id: '8.3', binary: '/usr/bin/php8.3', layout: 'debian', label: 'PHP 8.3', packagePrefix: 'php8.3-' },
    { id: '8.2', binary: '/usr/bin/php8.2', layout: 'debian', label: 'PHP 8.2', packagePrefix: 'php8.2-' },
  ],
  defaultId, defaultBinary: `/usr/bin/php${defaultId}`,
});

describe('probePpaSeries / ensurePpa series check', () => {
  it('asks launchpad with a HEAD request over https only and reads the status code', async () => {
    exec.mockImplementation(async (bin, argv, opts) => {
      expect(bin).toBe('curl');
      expect(argv.slice(0, HEAD_ARGV.length)).toEqual(HEAD_ARGV);
      expect(argv[argv.length - 1]).toBe('https://ppa.launchpadcontent.net/ondrej/php/ubuntu/dists/resolute/InRelease');
      expect(opts.allowFailure).toBe(true);
      return ok('404', 22);
    });
    expect(await probePpaSeries('ondrej/php', 'resolute')).toEqual({ supported: false, status: 404 });
    exec.mockImplementation(async () => ok('200'));
    expect(await probePpaSeries('ondrej/php', 'noble')).toEqual({ supported: true });
    exec.mockImplementation(async () => ok('000', 6));
    expect((await probePpaSeries('ondrej/php', 'noble')).supported).toBeNull();
    exec.mockImplementation(async () => { throw new Error('spawn curl ENOENT'); });
    expect((await probePpaSeries('deadsnakes/ppa', 'resolute')).supported).toBeNull();
    expect((await probePpaSeries('ondrej/php', null)).supported).toBeNull();
    // A codename that is not a plain series name never reaches the URL.
    exec.mockClear();
    exec.mockImplementation(async () => ok('200'));
    for (const bad of ['../../other/ppa/ubuntu/dists/noble', 'noble?x=1', 'noble#frag', 'Noble', 'a', 'x'.repeat(40)]) expect(await probePpaSeries('ondrej/php', bad)).toEqual({ supported: null, error: 'codename unknown' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('pkg.repo.ensure answers unsupported on a 404 series without touching add-apt-repository', async () => {
    setOs(RESOLUTE);
    exec.mockImplementation(async (bin) => { if (bin === 'curl') return ok('404', 22); throw new Error(`unexpected ${bin}`); });
    const r = await runOp('pkg.repo.ensure', { repo: 'php' }, ctx);
    expect(r).toMatchObject({ repo: 'php', family: 'debian', action: 'unsupported' });
    expect(r.detail).toMatch(/ppa:ondrej\/php has no packages for Ubuntu 26.04 resolute/);
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['curl']);
    expect(fs.readdirSync(dirs.WHM_APT_SOURCES_DIR)).toEqual([]);
  });

  it('pkg.repo.ensure still adds the PPA when the probe itself fails (offline host)', async () => {
    setOs(RESOLUTE);
    const real = await realHasBinary();
    let sptInstalled = false;
    exec.mockImplementation(async (bin) => { if (bin === 'curl') return ok('000', 6); if (bin === 'apt-get') { sptInstalled = true; return ok(); } if (bin === 'add-apt-repository') return ok(); throw new Error(`unexpected ${bin}`); });
    hasBinary.mockImplementation((name) => (name === 'add-apt-repository' ? sptInstalled || real(name) : real(name)));
    expect(await runOp('pkg.repo.ensure', { repo: 'python' }, ctx)).toMatchObject({ action: 'added' });
    const calls = exec.mock.calls.map((c) => [c[0], c[1]]);
    expect(calls[calls.length - 1]).toEqual(['add-apt-repository', ['-y', '--no-update', 'ppa:deadsnakes/ppa']]);
  });
});

describe('pkg.repo.status', () => {
  it('takes only the four repository names and never writes', async () => {
    for (const bad of INJECTION) expect((await opError(runOp('pkg.repo.status', { repo: bad }, ctx))).code, bad).toBe('invalid_args');
    expect((await opError(runOp('pkg.repo.status', { repo: 'php', probe: false }, ctx))).code).toBe('invalid_args');
    expect(catalog.get('pkg.repo.status').destructive).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('on Ubuntu reports a configured PPA without a probe and probes an absent one', async () => {
    setOs(RESOLUTE);
    fs.writeFileSync(path.join(dirs.WHM_APT_SOURCES_DIR, 'deadsnakes.list'), 'deb https://ppa.launchpadcontent.net/deadsnakes/ppa/ubuntu resolute main\n');
    expect(await runOp('pkg.repo.status', { repo: 'python' }, ctx)).toMatchObject({ repo: 'python', family: 'debian', present: true, supported: true });
    expect(exec).not.toHaveBeenCalled();
    exec.mockImplementation(async (bin, argv) => { expect(bin).toBe('curl'); expect(argv[argv.length - 1]).toMatch(/ondrej\/php\/ubuntu\/dists\/resolute\/InRelease$/); return ok('404', 22); });
    const php = await runOp('pkg.repo.status', { repo: 'php' }, ctx);
    expect(php).toMatchObject({ repo: 'php', present: false, supported: false });
    expect(php.detail).toMatch(/no packages for Ubuntu 26.04 resolute/);
    exec.mockImplementation(async () => ok('000', 7));
    expect((await runOp('pkg.repo.status', { repo: 'php' }, ctx))).toMatchObject({ present: false, supported: null });
    expect(fs.readdirSync(dirs.WHM_APT_SOURCES_DIR)).toEqual(['deadsnakes.list']);
  });

  it('knows the Debian, EL and unknown-family answers without running anything but rpm', async () => {
    setOs(OS.debian);
    expect(await runOp('pkg.repo.status', { repo: 'php' }, ctx)).toMatchObject({ family: 'debian', present: false, supported: true });
    fs.writeFileSync(path.join(dirs.WHM_APT_SOURCES_DIR, 'keel-sury-php.list'), 'deb [signed-by=/x] https://packages.sury.org/php/ bookworm main\n');
    expect(await runOp('pkg.repo.status', { repo: 'php' }, ctx)).toMatchObject({ present: true, supported: true });
    expect(await runOp('pkg.repo.status', { repo: 'python' }, ctx)).toMatchObject({ present: false, supported: false });
    expect(await runOp('pkg.repo.status', { repo: 'epel' }, ctx)).toMatchObject({ present: false, supported: false });
    expect(exec).not.toHaveBeenCalled();
    setOs(OS.rocky);
    exec.mockImplementation(async (bin, argv) => { expect(bin).toBe('rpm'); return ok('', argv[2] === 'epel-release' ? 0 : 1); });
    expect(await runOp('pkg.repo.status', { repo: 'python' }, ctx)).toMatchObject({ family: 'rhel', present: true, supported: true });
    expect(await runOp('pkg.repo.status', { repo: 'epel' }, ctx)).toMatchObject({ present: true, supported: true });
    expect(await runOp('pkg.repo.status', { repo: 'php' }, ctx)).toMatchObject({ present: false, supported: true });
    setOs(OS.el7);
    expect(await runOp('pkg.repo.status', { repo: 'remi' }, ctx)).toMatchObject({ present: false, supported: false });
    setOs('ID=alpine\n');
    expect(await runOp('pkg.repo.status', { repo: 'php' }, ctx)).toMatchObject({ family: null, present: false, supported: false });
  });
});

describe('pkg.php.remove', () => {
  it('is destructive, takes a version id only and refuses injection before any discovery', async () => {
    expect(catalog.get('pkg.php.remove').destructive).toBe(true);
    phpDiscovery.discover = () => { throw new Error('discovery must not run on a rejected schema'); };
    for (const bad of [...INJECTION, 'ea-php83;id', '8.3/../x', 'A.B']) expect((await opError(runOp('pkg.php.remove', { version: bad }, ctx))).code, bad).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.remove', { version: '8.2', packages: ['x'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.remove', {}, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses the CLI default, the only installed version and an unknown one without running anything', async () => {
    phpDiscovery.discover = () => PHP_SET('8.3');
    const def = await opError(runOp('pkg.php.remove', { version: '8.3' }, ctx));
    expect(def.code).toBe('refused');
    expect(def.message).toMatch(/CLI default/);
    expect((await opError(runOp('pkg.php.remove', { version: '8.4' }, ctx))).code).toBe('not_found');
    phpDiscovery.discover = () => ({ ...PHP_SET('8.3'), versions: PHP_SET('8.3').versions.slice(1), defaultId: null });
    const only = await opError(runOp('pkg.php.remove', { version: '8.2' }, ctx));
    expect(only.code).toBe('refused');
    expect(only.message).toMatch(/only installed version/);
    expect(exec).not.toHaveBeenCalled();
  });

  // apt's dry run names what the transaction would remove; the version's own packages only here.
  const aptSim = (names) => ok(names.map((n) => `Remv ${n} [1.0]`).join('\n') + '\n');
  const SIM_ARGV = ['-s', '-q', '-o', 'Debug::NoLocking=true', 'remove', '--', 'php8.2-cli', 'php8.2-fpm', 'php8.2-common'];
  const REMOVE_ARGV = ['remove', '-y', '-q', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', '--', 'php8.2-cli', 'php8.2-fpm', 'php8.2-common'];

  it('on Debian lists the php<ver>-* packages with dpkg-query, simulates, then removes exactly those', async () => {
    phpDiscovery.discover = () => PHP_SET('8.3');
    hasBinary.mockImplementation((name) => name === 'apt-get' || name === 'dpkg-query');
    exec.mockImplementation(async (bin, argv) => {
      if (bin === 'dpkg-query') { expect(argv).toEqual(['-W', '-f', '${binary:Package}\n', 'php8.2-*']); return ok('php8.2-cli\nphp8.2-fpm\nphp8.2-common:amd64\nphp-common\n\n'); }
      if (bin === 'apt-get' && argv[0] === '-s') return aptSim(['php8.2-cli', 'php8.2-fpm', 'php8.2-common']);
      if (bin === 'apt-get') return ok('Removing php8.2-cli');
      throw new Error(`unexpected ${bin}`);
    });
    const r = await runOp('pkg.php.remove', { version: '8.2' }, ctx);
    expect(r).toMatchObject({ version: '8.2', manager: 'apt', packages: ['php8.2-cli', 'php8.2-fpm', 'php8.2-common'], purge: false, forced: false, extra: [], background: false, code: 0 });
    const apts = exec.mock.calls.filter((c) => c[0] === 'apt-get');
    expect(apts.map((c) => c[1])).toEqual([SIM_ARGV, REMOVE_ARGV]);
    expect(apts[1][2].env).toMatchObject({ DEBIAN_FRONTEND: 'noninteractive' });
    exec.mockClear();
    exec.mockImplementation(async (bin) => (bin === 'dpkg-query' ? ok('php-common\n') : ok()));
    expect((await opError(runOp('pkg.php.remove', { version: '8.2' }, ctx))).code).toBe('not_found');
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['dpkg-query']);
    exec.mockClear();
    exec.mockImplementation(async (bin, argv) => (bin === 'dpkg-query' ? ok('php8.2-cli\n') : argv[0] === '-s' ? aptSim(['php8.2-cli']) : ok()));
    expect((await runOp('pkg.php.remove', { version: '8.2', purge: true }, ctx)).packages).toEqual(['php8.2-cli']);
    expect(exec.mock.calls.filter((c) => c[0] === 'apt-get').map((c) => c[1][0] === '-s' ? c[1][4] : c[1][0])).toEqual(['purge', 'purge']);
  });

  it('refuses a removal that would take packages outside php<ver>-* with it (roundcube-core, phpmyadmin) unless forced; dry only simulates', async () => {
    phpDiscovery.discover = () => PHP_SET('8.3');
    hasBinary.mockImplementation((name) => name === 'apt-get' || name === 'dpkg-query');
    // The version's own metapackage, its Apache module and Debian's php-defaults
    // metapackages (php, php-fpm, php-mysql: no payload, depend on php8.2-*) are
    // the version's own, never collateral.
    let sim = ['php8.2-cli', 'php8.2-fpm', 'php8.2-common', 'php8.2-mysql', 'php8.2', 'php', 'php-fpm', 'php-mysql', 'libapache2-mod-php8.2', 'roundcube-core', 'phpmyadmin', 'php8.2-opcache'];
    exec.mockImplementation(async (bin, argv) => {
      if (bin === 'dpkg-query') return ok('php8.2-cli\nphp8.2-fpm\nphp8.2-common\n');
      if (bin === 'apt-get' && argv[0] === '-s') return aptSim(sim);
      if (bin === 'apt-get') return ok('Removing roundcube-core');
      throw new Error(`unexpected ${bin}`);
    });
    // dry: the simulated list and the packages outside the version's own set, nothing removed.
    const dry = await runOp('pkg.php.remove', { version: '8.2', dry: true }, ctx);
    expect(dry).toEqual({ version: '8.2', layout: 'debian', manager: 'apt', packages: ['php8.2-cli', 'php8.2-fpm', 'php8.2-common'], purge: false, dry: true, remove: sim, extra: ['roundcube-core', 'phpmyadmin'], output: sim.map((n) => `Remv ${n} [1.0]`) });
    expect(exec.mock.calls.filter((c) => c[0] === 'apt-get').map((c) => c[1])).toEqual([SIM_ARGV]);
    // A versionless php-<ext> package whose php8.2-<ext> is not in the transaction is a real extra.
    sim = [...sim, 'php-imagick'];
    expect((await runOp('pkg.php.remove', { version: '8.2', dry: true }, ctx)).extra).toEqual(['roundcube-core', 'phpmyadmin', 'php-imagick']);
    sim = sim.slice(0, -1);
    // Without force the removal is refused and apt-get remove never runs.
    exec.mockClear();
    const err = await opError(runOp('pkg.php.remove', { version: '8.2' }, ctx));
    expect(err.code).toBe('refused');
    expect(err.message).toBe('Removing PHP 8.2 would also remove roundcube-core, phpmyadmin; move what depends on it to another version first, or force the removal');
    expect(err.details).toEqual({ version: '8.2', packages: ['php8.2-cli', 'php8.2-fpm', 'php8.2-common'], extra: ['roundcube-core', 'phpmyadmin'] });
    expect(exec.mock.calls.filter((c) => c[0] === 'apt-get').map((c) => c[1])).toEqual([SIM_ARGV]);
    // force is bound to the collateral the caller confirmed: a fresh simulation naming more is refused again.
    exec.mockClear();
    const unconfirmed = await opError(runOp('pkg.php.remove', { version: '8.2', force: true }, ctx));
    expect(unconfirmed.code).toBe('refused');
    expect(unconfirmed.message).toBe('the removal would now also take roundcube-core, phpmyadmin; confirm again');
    expect(unconfirmed.details).toEqual({ version: '8.2', packages: ['php8.2-cli', 'php8.2-fpm', 'php8.2-common'], extra: ['roundcube-core', 'phpmyadmin'], confirmed: [], unexpected: ['roundcube-core', 'phpmyadmin'] });
    const partial = await opError(runOp('pkg.php.remove', { version: '8.2', force: true, extra: ['roundcube-core'] }, ctx));
    expect(partial.code).toBe('refused');
    expect(partial.details.unexpected).toEqual(['phpmyadmin']);
    expect(exec.mock.calls.filter((c) => c[0] === 'apt-get').map((c) => c[1])).toEqual([SIM_ARGV, SIM_ARGV]);
    // force with the confirmed list: the same argv as before (only the version's own packages are named; apt takes the dependants).
    exec.mockClear();
    const forced = await runOp('pkg.php.remove', { version: '8.2', force: true, extra: ['roundcube-core', 'phpmyadmin'] }, ctx);
    expect(forced).toMatchObject({ version: '8.2', packages: ['php8.2-cli', 'php8.2-fpm', 'php8.2-common'], forced: true, extra: ['roundcube-core', 'phpmyadmin'], confirmed: ['roundcube-core', 'phpmyadmin'], code: 0 });
    expect(exec.mock.calls.filter((c) => c[0] === 'apt-get').map((c) => c[1])).toEqual([SIM_ARGV, REMOVE_ARGV]);
    // The confirmed list takes package names only.
    for (const bad of [{ extra: 'roundcube-core' }, { extra: ['a;b'] }, { extra: ['../x'] }]) expect((await opError(runOp('pkg.php.remove', { version: '8.2', force: true, ...bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    // A simulation apt cannot run (broken dependencies) is an error, not a removal.
    exec.mockClear();
    exec.mockImplementation(async (bin, argv) => (bin === 'dpkg-query' ? ok('php8.2-cli\n') : argv[0] === '-s' ? { stdout: '', stderr: 'E: Unable to correct problems', code: 100 } : ok()));
    expect((await opError(runOp('pkg.php.remove', { version: '8.2', force: true }, ctx))).code).toBe('command_failed');
    expect(exec.mock.calls.filter((c) => c[0] === 'apt-get')).toHaveLength(1);
    // The flags are booleans only.
    for (const bad of [{ force: 'yes' }, { dry: 1 }, { force: null }]) expect((await opError(runOp('pkg.php.remove', { version: '8.2', ...bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
  });

  it('on EL lists rpm names under the layout glob, simulates with dnf --assumeno and removes them with the package manager', async () => {
    phpDiscovery.discover = () => ({ versions: [{ id: 'php83', binary: '/opt/remi/php83/root/usr/bin/php', layout: 'remi' }, { id: 'ea-php82', binary: '/opt/cpanel/ea-php82/root/usr/bin/php', layout: 'ea4' }], defaultId: null, defaultBinary: null });
    hasBinary.mockImplementation((name) => name === 'dnf' || name === 'rpm');
    const table = ['Removing:', ' ea-php82-php-cli    x86_64   8.2.20-1   @ea4', ' ea-php82-runtime    x86_64   8.2.20-1   @ea4', 'Removing dependent packages:', ' roundcubemail       noarch   1.6.9-1    @epel', 'Transaction Summary', 'Operation aborted.'].join('\n');
    exec.mockImplementation(async (bin, argv) => {
      if (bin === 'rpm') { expect(argv).toEqual(['-qa', '--qf', '%{NAME}\n', 'ea-php82-*']); return ok('ea-php82-php-cli\nea-php82-runtime\n'); }
      if (bin === 'dnf' && argv.includes('--assumeno')) return { stdout: table, stderr: '', code: 1 };
      if (bin === 'dnf') return ok();
      throw new Error(`unexpected ${bin}`);
    });
    const refused = await opError(runOp('pkg.php.remove', { version: 'ea-php82' }, ctx));
    expect(refused.code).toBe('refused');
    expect(refused.details.extra).toEqual(['roundcubemail']);
    expect(exec.mock.calls.filter((c) => c[0] === 'dnf').map((c) => c[1])).toEqual([['-q', 'remove', '--assumeno', '--', 'ea-php82-php-cli', 'ea-php82-runtime']]);
    exec.mockClear();
    const r = await runOp('pkg.php.remove', { version: 'ea-php82', force: true, extra: ['roundcubemail'] }, ctx);
    expect(r).toMatchObject({ manager: 'dnf', packages: ['ea-php82-php-cli', 'ea-php82-runtime'], forced: true, extra: ['roundcubemail'] });
    expect(exec.mock.calls.filter((c) => c[0] === 'dnf').map((c) => c[1])).toEqual([['-q', 'remove', '--assumeno', '--', 'ea-php82-php-cli', 'ea-php82-runtime'], ['-y', '-q', 'remove', '--', 'ea-php82-php-cli', 'ea-php82-runtime']]);
    expect(phpPackageGlob({ id: 'php83', layout: 'remi' })).toBe('php83-php-*');
    expect(phpPackageGlob({ id: '8.3', layout: 'debian' })).toBe('php8.3-*');
    expect(phpPackageGlob({ id: 'system', layout: 'unknown' })).toBeNull();
  });
});

// --- PHP from source: pkg.php.build / pkg.php.build.finish / keel removal ----

const RELEASE = (version = '8.4.27', extra = {}) => JSON.stringify({ version, source: [{ filename: `php-${version}.tar.gz`, sha256: SHA_A }, { filename: `php-${version}.tar.xz`, sha256: extra.sha256 ?? SHA_A }], supported_versions: ['8.4'] });
const SRC_TARBALL = Buffer.from('fake-php-source-tarball');
const SRC_SHA = crypto.createHash('sha256').update(SRC_TARBALL).digest('hex');
const keelPrefix = (minor) => path.join(dirs.WHM_KEEL_PHP_DIR, minor);
const fakeKeelTree = (minor) => {
  const prefix = keelPrefix(minor);
  for (const d of ['bin', 'sbin', 'lib/conf.d', 'etc/php-fpm.d', 'var/log']) fs.mkdirSync(path.join(prefix, d), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'bin', 'php'), '#!php\n');
  fs.writeFileSync(path.join(prefix, 'sbin', 'php-fpm'), '#!php-fpm\n');
  fs.writeFileSync(path.join(prefix, 'lib', 'php.ini'), 'memory_limit = 128M\n');
  fs.writeFileSync(path.join(prefix, 'etc', 'php-fpm.conf'), '[global]\n');
  fs.writeFileSync(path.join(prefix, '.keel-build-ok'), '');
  return prefix;
};
const buildScript = fs.readFileSync(new URL('../src/ops/php-build.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const KEEL_ENV = ['KEEL_PHP_SRC', 'KEEL_PHP_PREFIX', 'KEEL_PHP_MINOR', 'KEEL_PHP_JOBS', 'KEEL_FPM_USER', 'KEEL_FPM_GROUP'];

// curl answers the release index and the tarball, tar "extracts" the source tree, bash is the build script.
const buildMock = ({ release = RELEASE('8.4.27', { sha256: SRC_SHA }), tarball = SRC_TARBALL, extract = true, bash = ok('built'), seen = {} } = {}) => async (bin, argv, opts) => {
  if (bin === 'curl') {
    const url = argv[argv.length - 1];
    expect(url.startsWith('https://www.php.net/')).toBe(true);
    expect(argv.slice(0, 5)).toEqual(['-fsSL', '--proto', '=https', '--proto-redir', '=https']);
    if (url.includes('releases/index.php')) { expect(url).toBe('https://www.php.net/releases/index.php?json&version=8.4'); expect(argv).toEqual(['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--max-time', '60', url]); return ok(release); }
    expect(url).toBe('https://www.php.net/distributions/php-8.4.27.tar.xz');
    expect(argv.slice(5, 7)).toEqual(['--max-time', '900']);
    const out = argv[argv.indexOf('-o') + 1];
    expect(path.basename(path.dirname(out))).toMatch(/^\.build-/);
    expect(path.dirname(path.dirname(out))).toBe(dirs.WHM_KEEL_PHP_DIR);
    seen.buildDir = path.dirname(out);
    fs.writeFileSync(out, tarball);
    return ok();
  }
  if (bin === 'tar') {
    expect(argv).toEqual(['--no-same-owner', '--no-same-permissions', '-xJf', argv[3], '-C', seen.buildDir]);
    expect(argv[3]).toBe(path.join(seen.buildDir, 'php-8.4.27.tar.xz'));
    if (extract) { fs.mkdirSync(path.join(seen.buildDir, 'php-8.4.27'), { recursive: true }); fs.writeFileSync(path.join(seen.buildDir, 'php-8.4.27', 'configure'), '#!/bin/sh\n'); }
    return ok();
  }
  if (bin === 'bash') { seen.bash = { argv, opts }; return bash; }
  throw new Error(`unexpected ${bin} ${argv.join(' ')}`);
};

describe('pkg.php.build / pkg.php.build.finish schemas and registration', () => {
  it('take a two-part PHP minor and nothing else; nothing runs on a rejected schema', async () => {
    for (const bad of [...INJECTION, '8.4.1', '8.4; rm', '7.3', '8.7', '10.0', '8', '8.', '.4', ' 8.4', '8.4\n', 'latest', 84, null]) {
      expect((await opError(runOp('pkg.php.build', { minor: bad }, ctx))).code, String(bad)).toBe('invalid_args');
      expect((await opError(runOp('pkg.php.build.finish', { minor: bad }, ctx))).code, String(bad)).toBe('invalid_args');
      expect(phpMinor.safeParse(bad).success, String(bad)).toBe(false);
    }
    for (const good of ['7.4', '8.0', '8.4', '8.5', '9.0']) expect(phpMinor.safeParse(good).success, good).toBe(true);
    for (const m of PHP_MINORS) expect(phpMinor.safeParse(m).success, m).toBe(true);
    expect((await opError(runOp('pkg.php.build', {}, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.build', { minor: '8.4', prefix: '/tmp/x' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.build', { minor: '8.4', wait: 'no' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.build.finish', { minor: '8.4', wait: false }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
    expect(fs.readdirSync(dirs.WHM_KEEL_PHP_DIR)).toEqual([]);
  });

  it('registers both ops, the build with a 90 minute budget, neither destructive', () => {
    expect(catalog.get('pkg.php.build').timeoutMs).toBe(90 * 60_000);
    expect(catalog.get('pkg.php.build').destructive).toBe(false);
    expect(catalog.get('pkg.php.build.finish').destructive).toBe(false);
  });

  it('allows the prefix tree, the socket dir and only the per-minor unit files and php<minor> links', () => {
    expect(PHP_MINORS).toEqual(['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5', '8.6', '9.0', '9.1']);
    for (const p of [KEEL_PHP_DIR, KEEL_PHP_RUN_DIR, ...PHP_UNIT_PATHS, ...PHP_LINK_PATHS]) expect(DEFAULT_ALLOWED_ROOTS, p).toContain(p);
    expect(PHP_UNIT_PATHS).toContain(`${SYSTEMD_UNIT_DIR}/keel-php8.4-fpm.service`);
    expect(PHP_LINK_PATHS).toContain(`${LOCAL_BIN_DIR}/php8.4`);
    expect(DEFAULT_ALLOWED_ROOTS).not.toContain(SYSTEMD_UNIT_DIR);
    expect(DEFAULT_ALLOWED_ROOTS).not.toContain(LOCAL_BIN_DIR);
    expect(() => defaultCtx.assertAllowedPath('/etc/systemd/system/ssh.service')).toThrow(OpError);
    expect(() => defaultCtx.assertAllowedPath('/usr/local/bin/php')).toThrow(OpError);
    expect(() => defaultCtx.assertAllowedPath('/usr/local/bin/php8.4.1')).toThrow(OpError);
    expect(defaultCtx.assertAllowedPath('/etc/systemd/system/keel-php8.4-fpm.service', 'write')).toBe('/etc/systemd/system/keel-php8.4-fpm.service');
    expect(defaultCtx.assertAllowedPath('/opt/keel/php/8.4/etc/php-fpm.d/whm-alice.conf', 'write')).toBeTruthy();
  });
});

describe('parsePhpRelease', () => {
  it('picks the tar.xz entry with its SHA-256 and refuses a release without one', () => {
    expect(parsePhpRelease(RELEASE('8.4.27', { sha256: SRC_SHA.toUpperCase() }), '8.4')).toEqual({ version: '8.4.27', filename: 'php-8.4.27.tar.xz', sha256: SRC_SHA });
    expect(() => parsePhpRelease(JSON.stringify({ version: '8.4.27', source: [{ filename: 'php-8.4.27.tar.xz' }] }), '8.4')).toThrow(/SHA-256/);
    expect(() => parsePhpRelease(JSON.stringify({ version: '8.4.27', source: [{ filename: 'php-8.4.27.tar.xz', sha256: 'abc' }] }), '8.4')).toThrow(/SHA-256/);
    expect(() => parsePhpRelease(JSON.stringify({ version: '8.4.27', source: [{ filename: 'php-8.4.27.tar.gz', sha256: SHA_A }] }), '8.4')).toThrow(/tar\.xz/);
  });

  it('answers not_found for an unknown minor and invalid_release for anything that is not that minor', () => {
    for (const text of ['[]', '{}', '{"version":""}']) { let err; try { parsePhpRelease(text, '8.4'); } catch (e) { err = e; } expect(err?.code, text).toBe('not_found'); }
    for (const text of ['not json', RELEASE('8.3.1'), RELEASE('8.4'), RELEASE('8.4.27-rc1'), RELEASE('../8.4.27'), JSON.stringify({ version: '8.4.27', source: 'x' })]) { let err; try { parsePhpRelease(text, '8.4'); } catch (e) { err = e; } expect(err?.code, text).toBe('invalid_release'); }
  });
});

describe('renderPhpUnit', () => {
  it('contains only constants and the validated minor', () => {
    const unit = renderPhpUnit('8.4');
    expect(unit).toBe([
      '[Unit]', 'Description=Keel PHP 8.4 FPM', 'After=network.target', '',
      '[Service]', 'Type=simple', 'ExecStartPre=+/usr/bin/mkdir -p /run/keel-php',
      'ExecStart=/opt/keel/php/8.4/sbin/php-fpm --nodaemonize --fpm-config /opt/keel/php/8.4/etc/php-fpm.conf',
      'ExecReload=/bin/kill -USR2 $MAINPID', 'PrivateTmp=true', '',
      '[Install]', 'WantedBy=multi-user.target', '',
    ].join('\n'));
    for (const bad of ['8.4; rm', '../8.4', '8.4\nExecStart=/bin/sh']) expect(() => renderPhpUnit(bad)).toThrow(OpError);
  });
});

describe('pkg.php.build', () => {
  it('downloads the verified php.net source and runs only the shipped script with the KEEL_* environment', async () => {
    const seen = {};
    exec.mockImplementation(buildMock({ seen }));
    const r = await runOp('pkg.php.build', { minor: '8.4' }, ctx);
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['curl', 'curl', 'tar', 'bash']);
    expect(r).toMatchObject({ minor: '8.4', version: '8.4.27', release: { version: '8.4.27', filename: 'php-8.4.27.tar.xz', sha256: SRC_SHA }, prefix: keelPrefix('8.4'), buildDir: seen.buildDir, background: false, code: 0 });
    expect(r.output.some((l) => /Checksum verified/.test(l))).toBe(true);
    expect(seen.bash.argv).toEqual([path.join(seen.buildDir, 'php-build.sh')]);
    expect(fs.readFileSync(seen.bash.argv[0], 'utf8')).toBe(buildScript);
    expect(buildScript).toMatch(/^set -euo pipefail$/m);
    expect(buildScript).not.toMatch(/xmlrpc/);
    if (linux) expect(fs.statSync(seen.bash.argv[0]).mode & 0o777).toBe(0o700);
    expect(seen.bash.opts.env).toMatchObject({ KEEL_PHP_SRC: path.join(seen.buildDir, 'php-8.4.27'), KEEL_PHP_PREFIX: keelPrefix('8.4'), KEEL_PHP_MINOR: '8.4', KEEL_FPM_GROUP: seen.bash.opts.env.KEEL_FPM_USER });
    expect(seen.bash.opts.env.KEEL_PHP_JOBS).toMatch(/^[1-9]\d*$/);
    expect(seen.bash.opts.env.PATH).toBeTruthy();
    expect(seen.bash.opts.timeoutMs).toBe(90 * 60_000);
    // The script reads every parameter from the environment: nothing but constants and quoted $KEEL_* references.
    for (const v of KEEL_ENV) expect(buildScript).toContain('"$' + v + '"');
    expect(fs.existsSync(path.join(seen.buildDir, 'php-8.4.27.tar.xz'))).toBe(false);
    expect(fs.existsSync(keelPrefix('8.4'))).toBe(false);
    if (linux) expect(fs.statSync(seen.buildDir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(seen.buildDir)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(seen.buildDir, 'keel-build.json'), 'utf8'))).toMatchObject({ minor: '8.4', version: '8.4.27', done: true });
    expect(fs.existsSync(path.join(dirs.WHM_KEEL_PHP_DIR, '.build-8.4.lock'))).toBe(false);
  });

  it('refuses the minors whose last php.net release no longer compiles, before any network call', async () => {
    expect(PHP_SOURCE_MINORS).toEqual(['8.1', '8.2', '8.3', '8.4', '8.5']);
    for (const minor of ['7.4', '8.0']) expect((await opError(runOp('pkg.php.build', { minor }, ctx))).code, minor).toBe('unsupported');
    expect(exec).not.toHaveBeenCalled();
    expect(fs.readdirSync(dirs.WHM_KEEL_PHP_DIR)).toEqual([]);
  });

  it('refuses a tarball whose checksum differs, removes the build dir and installs nothing', async () => {
    const seen = {};
    exec.mockImplementation(buildMock({ seen, tarball: Buffer.from('tampered') }));
    expect((await opError(runOp('pkg.php.build', { minor: '8.4' }, ctx))).code).toBe('checksum_mismatch');
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['curl', 'curl']);
    expect(fs.readdirSync(dirs.WHM_KEEL_PHP_DIR)).toEqual([]);
    expect(fs.readdirSync(dirs.WHM_LOCAL_BIN_DIR)).toEqual([]);
    expect(fs.readdirSync(dirs.WHM_SYSTEMD_UNIT_DIR)).toEqual([]);
  });

  it('reports an unknown minor, a bad release and a failed build without leaving a build dir', async () => {
    exec.mockImplementation(buildMock({ release: '[]' }));
    expect((await opError(runOp('pkg.php.build', { minor: '8.4' }, ctx))).code).toBe('not_found');
    exec.mockImplementation(buildMock({ release: JSON.stringify({ version: '8.4.27', source: [{ filename: 'php-8.4.27.tar.xz' }] }) }));
    expect((await opError(runOp('pkg.php.build', { minor: '8.4' }, ctx))).code).toBe('invalid_release');
    exec.mockImplementation(buildMock({ extract: false }));
    expect((await opError(runOp('pkg.php.build', { minor: '8.4' }, ctx))).code).toBe('extract_failed');
    exec.mockImplementation(buildMock({ bash: ok('configure: error: no libxml', 1) }));
    const err = await opError(runOp('pkg.php.build', { minor: '8.4' }, ctx));
    expect(err.code).toBe('build_failed');
    expect(err.message).toMatch(/libxml/);
    expect(fs.readdirSync(dirs.WHM_KEEL_PHP_DIR)).toEqual([]);
    expect(exec.mock.calls.filter((c) => c[0] === 'curl').every((c) => c[1][c[1].length - 1].startsWith('https://'))).toBe(true);
  });

  it.skipIf(!linux)('records the run id in the marker and lets a failed background build be retried at once', async () => {
    const seen = {};
    exec.mockImplementation(buildMock({ seen }));
    const r = await runOp('pkg.php.build', { minor: '8.4', wait: false }, ctx);
    expect(r.background).toBe(true);
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['curl', 'curl', 'tar']);
    const marker = JSON.parse(fs.readFileSync(path.join(r.buildDir, 'keel-build.json'), 'utf8'));
    expect(marker).toMatchObject({ minor: '8.4', version: '8.4.27', runId: r.run.id });
    // The detached script (a fake bash here) exits non-zero: the run is finished, so the marker is stale.
    for (let i = 0; i < 100 && JSON.parse(fs.readFileSync(path.join(dirs.WHM_PKG_RUN_DIR, `${r.run.id}.json`), 'utf8')).status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(JSON.parse(fs.readFileSync(path.join(dirs.WHM_PKG_RUN_DIR, `${r.run.id}.json`), 'utf8')).status).not.toBe('running');
    expect((await opError(runOp('pkg.php.build.finish', { minor: '8.4' }, ctx))).code).toBe('build_failed');
    exec.mockClear();
    exec.mockImplementation(buildMock({ seen }));
    const again = await runOp('pkg.php.build', { minor: '8.4' }, ctx);
    expect(fs.existsSync(r.buildDir)).toBe(false);
    expect(again.buildDir).not.toBe(r.buildDir);
  });

  it('keeps in_use while the marker names a run that is still alive, without a run id only within the budget', async () => {
    fs.mkdirSync(dirs.WHM_PKG_RUN_DIR, { recursive: true });
    const live = path.join(dirs.WHM_KEEL_PHP_DIR, '.build-live');
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, 'keel-build.json'), JSON.stringify({ minor: '8.4', startedAt: new Date(Date.now() - 5 * 3600_000).toISOString(), runId: 'build-0123456789ab' }));
    fs.writeFileSync(path.join(dirs.WHM_PKG_RUN_DIR, 'build-0123456789ab.json'), JSON.stringify({ id: 'build-0123456789ab', bin: process.execPath, pid: process.pid, status: 'running', startedAt: new Date().toISOString(), timeoutMs: 90 * 60_000 }));
    if (linux) {
      expect((await opError(runOp('pkg.php.build', { minor: '8.4' }, ctx))).code).toBe('in_use');
      expect((await opError(runOp('pkg.php.build.finish', { minor: '8.4' }, ctx))).code).toBe('build_failed');
      expect(fs.existsSync(live)).toBe(true);
      expect(exec).not.toHaveBeenCalled();
    }
    // The run finished: the marker is stale however young it is.
    fs.writeFileSync(path.join(dirs.WHM_PKG_RUN_DIR, 'build-0123456789ab.json'), JSON.stringify({ id: 'build-0123456789ab', bin: process.execPath, pid: process.pid, status: 'finished', code: 2, startedAt: new Date().toISOString(), timeoutMs: 90 * 60_000 }));
    fs.writeFileSync(path.join(live, 'keel-build.json'), JSON.stringify({ minor: '8.4', startedAt: new Date().toISOString(), runId: 'build-0123456789ab' }));
    exec.mockImplementation(buildMock({}));
    await runOp('pkg.php.build', { minor: '8.4' }, ctx);
    expect(fs.existsSync(live)).toBe(false);
  });

  it('takes a per-minor lock before the first network call and sweeps one left by a dead agent', async () => {
    const lock = path.join(dirs.WHM_KEEL_PHP_DIR, '.build-8.4.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    expect((await opError(runOp('pkg.php.build', { minor: '8.4' }, ctx))).code).toBe('in_use');
    expect(exec).not.toHaveBeenCalled();
    expect(fs.existsSync(lock)).toBe(true);
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 - 7, startedAt: new Date().toISOString() }));
    exec.mockImplementation(buildMock({}));
    await runOp('pkg.php.build', { minor: '8.4' }, ctx);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('refuses a second build of the same minor while one is running and sweeps a stale build dir', async () => {
    const stale = path.join(dirs.WHM_KEEL_PHP_DIR, '.build-stale');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'keel-build.json'), JSON.stringify({ minor: '8.4', startedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    const running = path.join(dirs.WHM_KEEL_PHP_DIR, '.build-running');
    fs.mkdirSync(running, { recursive: true });
    fs.writeFileSync(path.join(running, 'keel-build.json'), JSON.stringify({ minor: '8.3', startedAt: new Date().toISOString() }));
    expect((await opError(runOp('pkg.php.build', { minor: '8.3' }, ctx))).code).toBe('in_use');
    expect(exec).not.toHaveBeenCalled();
    exec.mockImplementation(buildMock({}));
    await runOp('pkg.php.build', { minor: '8.4' }, ctx);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(running)).toBe(true);
  });

  it('refuses a prefix override outside the allowed roots before anything runs', async () => {
    const prev = process.env.WHM_KEEL_PHP_DIR;
    process.env.WHM_KEEL_PHP_DIR = '/usr/share/keel-php';
    try {
      expect((await opError(runOp('pkg.php.build', { minor: '8.4' }, ctx))).code).toBe('path_not_allowed');
      expect((await opError(runOp('pkg.php.build.finish', { minor: '8.4' }, ctx))).code).toBe('path_not_allowed');
    } finally { process.env.WHM_KEEL_PHP_DIR = prev; }
    expect(fs.existsSync('/usr/share/keel-php')).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('pkg.php.build.finish', () => {
  const systemctl = (calls) => async (bin, argv) => {
    if (bin === 'systemctl') { calls.push(argv); return argv[0] === 'is-active' ? ok('active\n') : ok(); }
    if (bin.endsWith(path.join('bin', 'php'))) return ok('8.4.27');
    throw new Error(`unexpected ${bin} ${argv.join(' ')}`);
  };

  it('refuses when the prefix holds no complete build', async () => {
    expect((await opError(runOp('pkg.php.build.finish', { minor: '8.4' }, ctx))).code).toBe('build_failed');
    fs.mkdirSync(path.join(keelPrefix('8.4'), 'bin'), { recursive: true });
    fs.writeFileSync(path.join(keelPrefix('8.4'), 'bin', 'php'), '');
    expect((await opError(runOp('pkg.php.build.finish', { minor: '8.4' }, ctx))).code).toBe('build_failed');
    // Every file but the script's final .keel-build-ok: make install died half-way.
    fakeKeelTree('8.4');
    fs.unlinkSync(path.join(keelPrefix('8.4'), '.keel-build-ok'));
    expect((await opError(runOp('pkg.php.build.finish', { minor: '8.4' }, ctx))).code).toBe('build_failed');
    expect(discoverPhp().versions.some((v) => v.layout === 'keel')).toBe(false);
    expect(phpLayout().versions.some((v) => v.flavor === 'keel')).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(fs.readdirSync(dirs.WHM_SYSTEMD_UNIT_DIR)).toEqual([]);
  });

  it.skipIf(!linux)('writes the unit, enables it, links php<minor>, drops the build dir and is idempotent', async () => {
    const prefix = fakeKeelTree('8.4');
    const build = path.join(dirs.WHM_KEEL_PHP_DIR, '.build-abc');
    fs.mkdirSync(build);
    fs.writeFileSync(path.join(build, 'keel-build.json'), JSON.stringify({ minor: '8.4', version: '8.4.27', startedAt: new Date().toISOString(), done: true }));
    const other = path.join(dirs.WHM_KEEL_PHP_DIR, '.build-other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'keel-build.json'), JSON.stringify({ minor: '8.3', startedAt: new Date().toISOString() }));
    hasBinary.mockImplementation((name) => name === 'systemctl');
    const calls = [];
    exec.mockImplementation(systemctl(calls));
    const r = await runOp('pkg.php.build.finish', { minor: '8.4' }, ctx);
    const unitFile = path.join(dirs.WHM_SYSTEMD_UNIT_DIR, 'keel-php8.4-fpm.service');
    const link = path.join(dirs.WHM_LOCAL_BIN_DIR, 'php8.4');
    expect(r).toEqual({ minor: '8.4', version: '8.4.27', prefix, binary: path.join(prefix, 'bin', 'php'), unit: 'keel-php8.4-fpm', unitFile, active: true, enabled: true, link, buildDirsRemoved: [build] });
    expect(fs.readFileSync(unitFile, 'utf8')).toBe(renderPhpUnit('8.4'));
    expect(fs.statSync(unitFile).mode & 0o777).toBe(0o644);
    expect(fs.readlinkSync(link)).toBe(path.join(prefix, 'bin', 'php'));
    expect(calls).toEqual([['daemon-reload'], ['enable', '--now', 'keel-php8.4-fpm.service'], ['is-active', 'keel-php8.4-fpm.service'], ['is-enabled', 'keel-php8.4-fpm.service']]);
    expect(fs.existsSync(build)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    const again = await runOp('pkg.php.build.finish', { minor: '8.4' }, ctx);
    expect(again).toMatchObject({ link, active: true, buildDirsRemoved: [] });
  });

  it.skipIf(!linux)('leaves a foreign php<minor> alone and reports a unit that failed to start', async () => {
    fakeKeelTree('8.4');
    const link = path.join(dirs.WHM_LOCAL_BIN_DIR, 'php8.4');
    fs.writeFileSync(link, '#!/bin/sh\n');
    hasBinary.mockImplementation((name) => name === 'systemctl');
    exec.mockImplementation(async (bin, argv) => {
      if (bin === 'systemctl' && argv[0] === 'enable') return { stdout: '', stderr: 'Job for keel-php8.4-fpm.service failed', code: 1 };
      if (bin === 'systemctl' && argv[0] === 'is-active') return { stdout: 'failed\n', stderr: '', code: 3 };
      if (bin === 'systemctl') return ok();
      return ok('8.4.27');
    });
    const r = await runOp('pkg.php.build.finish', { minor: '8.4' }, ctx);
    expect(r).toMatchObject({ active: false, unitError: expect.stringMatching(/failed/), link: null, linkConflict: expect.stringMatching(/not a symbolic link/) });
    expect(fs.readFileSync(link, 'utf8')).toBe('#!/bin/sh\n');
  });
});

describe('discoverPhp / phpLayout see a Keel build', () => {
  it('a Keel build of a minor wins over the distro tree of the same minor and reports it as packagedTwin', () => {
    const deb = (id) => ({ id, binary: `/usr/bin/php${id}`, layout: 'debian', label: `PHP ${id}`, packagePrefix: `php${id}-`, fpmUnit: `php${id}-fpm`, poolDir: `/etc/php/${id}/fpm/pool.d` });
    const keel = (id) => ({ id, binary: `/opt/keel/php/${id}/bin/php`, layout: 'keel', label: `PHP ${id} (Keel build)`, packagePrefix: null, source: true, prefix: `/opt/keel/php/${id}` });
    const out = preferKeelBuilds([deb('8.5'), deb('8.3'), keel('8.5'), keel('8.4')]);
    expect(out.map((v) => [v.id, v.layout])).toEqual([['8.5', 'keel'], ['8.3', 'debian'], ['8.4', 'keel']]);
    expect(out[0]).toEqual({ ...keel('8.5'), packagedTwin: { binary: '/usr/bin/php8.5', layout: 'debian', packagePrefix: 'php8.5-', fpmUnit: 'php8.5-fpm', poolDir: '/etc/php/8.5/fpm/pool.d', version: null } });
    expect(out[1].packagedTwin).toBeUndefined();
    expect(out[2].packagedTwin).toBeUndefined();
    // Two trees of the same minor without a build keep the first (the /etc/php one); a build never shadows another build.
    expect(preferKeelBuilds([deb('8.3'), { ...deb('8.3'), layout: 'rhel' }]).map((v) => v.layout)).toEqual(['debian']);
    expect(preferKeelBuilds([keel('8.4'), keel('8.4')])).toHaveLength(1);
  });

  it('lists /opt/keel/php/<minor> with the keel layout, instead of any distro tree of the same minor', () => {
    fakeKeelTree('9.1');
    fs.mkdirSync(path.join(dirs.WHM_KEEL_PHP_DIR, '8.3'), { recursive: true });
    fs.mkdirSync(path.join(dirs.WHM_KEEL_PHP_DIR, '.build-x'), { recursive: true });
    fs.mkdirSync(path.join(dirs.WHM_KEEL_PHP_DIR, 'latest', 'bin'), { recursive: true });
    const prefix = keelPrefix('9.1');
    const v = discoverPhp().versions.find((x) => x.layout === 'keel');
    expect(v).toEqual({
      id: '9.1', binary: path.join(prefix, 'bin', 'php'), layout: 'keel', label: 'PHP 9.1 (Keel build)', iniPath: path.join(prefix, 'lib', 'php.ini'), iniPaths: { php: path.join(prefix, 'lib', 'php.ini') },
      poolDir: path.join(prefix, 'etc', 'php-fpm.d'), fpmUnit: 'keel-php9.1-fpm', packagePrefix: null, source: true, prefix,
    });
    expect(discoverPhp().versions.filter((x) => x.layout === 'keel')).toHaveLength(1);
    const ids = discoverPhp().versions.map((x) => x.id);
    expect(ids.indexOf('9.1')).toBe(ids.length - 1);
    const tree = phpLayout().versions.find((x) => x.flavor === 'keel');
    expect(tree).toEqual({ version: '9.1', flavor: 'keel', poolDir: `${dirs.WHM_KEEL_PHP_DIR}/9.1/etc/php-fpm.d`, bin: `${dirs.WHM_KEEL_PHP_DIR}/9.1/sbin/php-fpm`, fpmConfig: `${dirs.WHM_KEEL_PHP_DIR}/9.1/etc/php-fpm.conf`, units: ['keel-php9.1-fpm'], socketDir: '/run/keel-php', listenOwner: fs.existsSync('/etc/apache2') ? 'www-data' : 'apache' });
    expect(phpLayout().versions.filter((x) => x.flavor === 'keel')).toHaveLength(1);
    expect(phpLayout().versions.filter((x) => x.version === '9.1')).toHaveLength(1);
  });
});

describe('pkg.php.remove for a Keel build', () => {
  const KEEL_SET = () => ({
    versions: [
      { id: '8.5', binary: '/usr/bin/php8.5', layout: 'debian', label: 'PHP 8.5', packagePrefix: 'php8.5-' },
      { id: '8.4', binary: path.join(keelPrefix('8.4'), 'bin', 'php'), layout: 'keel', label: 'PHP 8.4 (Keel build)', packagePrefix: null, source: true, prefix: keelPrefix('8.4') },
    ],
    defaultId: '8.5', defaultBinary: '/usr/bin/php8.5',
  });

  it.skipIf(!linux)('stops and removes the unit, the php<minor> link and the prefix without touching a package manager or /etc/php', async () => {
    const prefix = fakeKeelTree('8.4');
    const unitFile = path.join(dirs.WHM_SYSTEMD_UNIT_DIR, 'keel-php8.4-fpm.service');
    fs.mkdirSync(dirs.WHM_SYSTEMD_UNIT_DIR, { recursive: true });
    fs.writeFileSync(unitFile, renderPhpUnit('8.4'));
    const link = path.join(dirs.WHM_LOCAL_BIN_DIR, 'php8.4');
    fs.symlinkSync(path.join(prefix, 'bin', 'php'), link);
    const foreign = path.join(dirs.WHM_LOCAL_BIN_DIR, 'php8.3');
    fs.symlinkSync('/usr/bin/php8.3', foreign);
    const build = path.join(dirs.WHM_KEEL_PHP_DIR, '.build-left');
    fs.mkdirSync(build);
    fs.writeFileSync(path.join(build, 'keel-build.json'), JSON.stringify({ minor: '8.4', startedAt: new Date().toISOString(), runId: 'run-gone' }));
    fs.writeFileSync(path.join(dirs.WHM_KEEL_PHP_DIR, '.build-8.4.lock'), '{}');
    phpDiscovery.discover = KEEL_SET;
    hasBinary.mockImplementation((name) => name === 'systemctl' || name === 'apt-get');
    const calls = [];
    exec.mockImplementation(async (bin, argv) => { if (bin !== 'systemctl') throw new Error(`unexpected ${bin}`); calls.push(argv); return ok(); });
    const r = await runOp('pkg.php.remove', { version: '8.4' }, ctx);
    expect(r).toMatchObject({ version: '8.4', layout: 'keel', manager: null, packages: [], prefix, removed: true, unit: 'keel-php8.4-fpm', unitRemoved: true, link, linkRemoved: true, buildDirsRemoved: [build], background: false, code: 0 });
    expect(calls).toEqual([['disable', '--now', 'keel-php8.4-fpm.service'], ['daemon-reload']]);
    expect(fs.existsSync(prefix)).toBe(false);
    expect(fs.existsSync(unitFile)).toBe(false);
    expect(() => fs.lstatSync(link)).toThrow();
    expect(fs.readlinkSync(foreign)).toBe('/usr/bin/php8.3');
    expect(fs.existsSync(build)).toBe(false);
    expect(fs.readdirSync(dirs.WHM_KEEL_PHP_DIR)).toEqual([]);
  });

  it.skipIf(!linux)('keeps a php<minor> that points elsewhere and refuses a prefix that is a symbolic link', async () => {
    const link = path.join(dirs.WHM_LOCAL_BIN_DIR, 'php8.4');
    fs.symlinkSync('/usr/bin/php8.4', link);
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, keelPrefix('8.4'));
    phpDiscovery.discover = KEEL_SET;
    hasBinary.mockImplementation(() => false);
    expect((await opError(runOp('pkg.php.remove', { version: '8.4' }, ctx))).code).toBe('refused');
    expect(fs.existsSync(elsewhere)).toBe(true);
    expect(fs.readlinkSync(link)).toBe('/usr/bin/php8.4');
    expect(exec).not.toHaveBeenCalled();
  });

  it('{ packages: true } removes the distribution packages a Keel build shadows and leaves the build alone', async () => {
    const prefix = fakeKeelTree('8.5');
    const twin = { binary: '/usr/bin/php8.5', layout: 'debian', packagePrefix: 'php8.5-', fpmUnit: 'php8.5-fpm', poolDir: '/etc/php/8.5/fpm/pool.d', version: '8.5.4' };
    const both = () => ({
      versions: [
        { id: '8.5', binary: path.join(prefix, 'bin', 'php'), layout: 'keel', label: 'PHP 8.5 (Keel build)', packagePrefix: null, source: true, prefix, packagedTwin: twin },
        { id: '8.3', binary: '/usr/bin/php8.3', layout: 'debian', label: 'PHP 8.3', packagePrefix: 'php8.3-' },
      ],
      defaultId: '8.3', defaultBinary: '/usr/bin/php8.3',
    });
    phpDiscovery.discover = both;
    hasBinary.mockImplementation((name) => name === 'apt-get' || name === 'dpkg-query' || name === 'systemctl');
    const calls = [];
    exec.mockImplementation(async (bin, argv) => {
      calls.push([bin, argv]);
      if (bin === 'dpkg-query') return ok('php8.5-fpm\nphp8.5-cli\nphp8.5-common:amd64\n');
      if (bin === 'apt-get' && argv.includes('-s')) return ok('Remv php8.5-fpm [8.5.4-1]\nRemv php8.5-cli [8.5.4-1]\nRemv php8.5-common [8.5.4-1]\n');
      if (bin === 'apt-get') return ok('Removing php8.5-fpm');
      throw new Error(`unexpected ${bin}`);
    });
    const dry = await runOp('pkg.php.remove', { version: '8.5', packages: true, dry: true }, ctx);
    expect(dry).toMatchObject({ version: '8.5', layout: 'debian', manager: 'apt', packages: ['php8.5-fpm', 'php8.5-cli', 'php8.5-common'], dry: true, extra: [], packagesOnly: true, keelPrefix: prefix });
    expect(calls.some(([bin, argv]) => bin === 'apt-get' && !argv.includes('-s'))).toBe(false);
    calls.length = 0;
    const r = await runOp('pkg.php.remove', { version: '8.5', packages: true }, ctx);
    expect(r).toMatchObject({ version: '8.5', layout: 'debian', manager: 'apt', packages: ['php8.5-fpm', 'php8.5-cli', 'php8.5-common'], packagesOnly: true, keelPrefix: prefix, forced: false, extra: [] });
    expect(calls.filter(([bin]) => bin === 'systemctl')).toHaveLength(0);
    expect(calls.find(([bin, argv]) => bin === 'apt-get' && !argv.includes('-s'))[1].slice(-3)).toEqual(['php8.5-fpm', 'php8.5-cli', 'php8.5-common']);
    // The build is untouched: prefix, marker and ini still there.
    expect(fs.existsSync(path.join(prefix, '.keel-build-ok'))).toBe(true);
    expect(fs.existsSync(path.join(prefix, 'lib', 'php.ini'))).toBe(true);
    // Without packages: true the same minor removes the Keel build (and refuses while it is the CLI default).
    phpDiscovery.discover = () => ({ ...both(), defaultId: '8.5', defaultBinary: '/usr/bin/php8.5' });
    expect((await opError(runOp('pkg.php.remove', { version: '8.5' }, ctx))).code).toBe('refused');
    // /usr/bin/php resolving to the packages refuses the package removal (defaultBinary is a realpath; the twin binary must exist to compare).
    const twinBin = path.join(base, 'usr-bin-php8.5');
    fs.writeFileSync(twinBin, '');
    phpDiscovery.discover = () => { const b = both(); b.versions[0] = { ...b.versions[0], packagedTwin: { ...twin, binary: twinBin } }; return { ...b, defaultId: '8.5', defaultBinary: fs.realpathSync(twinBin) }; };
    const refused = await opError(runOp('pkg.php.remove', { version: '8.5', packages: true }, ctx));
    expect(refused.code).toBe('refused');
    expect(refused.message).toMatch(/still points at the PHP 8\.5 packages/);
    // A minor without packages beside its build has nothing to remove that way.
    phpDiscovery.discover = KEEL_SET;
    expect((await opError(runOp('pkg.php.remove', { version: '8.4', packages: true }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('pkg.php.remove', { version: '8.5', packages: 'yes' }, ctx))).code).toBe('invalid_args');
  });

  it('still refuses the CLI default and the only version, and refuses a prefix override outside the allowed roots', async () => {
    phpDiscovery.discover = () => ({ ...KEEL_SET(), defaultId: '8.4' });
    expect((await opError(runOp('pkg.php.remove', { version: '8.4' }, ctx))).code).toBe('refused');
    phpDiscovery.discover = () => ({ versions: KEEL_SET().versions.slice(1), defaultId: null, defaultBinary: null });
    expect((await opError(runOp('pkg.php.remove', { version: '8.4' }, ctx))).code).toBe('refused');
    phpDiscovery.discover = KEEL_SET;
    const prev = process.env.WHM_KEEL_PHP_DIR;
    process.env.WHM_KEEL_PHP_DIR = '/usr/share/keel-php';
    try { expect((await opError(runOp('pkg.php.remove', { version: '8.4' }, ctx))).code).toBe('path_not_allowed'); } finally { process.env.WHM_KEEL_PHP_DIR = prev; }
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('pkg.php.release / pkg.node.release (read-only release lookups)', () => {
  it('take only the PHP minor / Node major the installers take; nothing runs on a rejected schema', async () => {
    for (const bad of [...INJECTION, '8.4.1', '7.3', 84, null]) expect((await opError(runOp('pkg.php.release', { minor: bad }, ctx))).code, String(bad)).toBe('invalid_args');
    for (const bad of [15, 31, '20', '20; rm -rf /', null, NaN]) expect((await opError(runOp('pkg.node.release', { major: bad }, ctx))).code, String(bad)).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.release', { minor: '8.4', wait: false }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.node.release', { major: 20, url: 'https://evil' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.release', {}, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.node.release', {}, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
    expect(catalog.get('pkg.php.release').destructive).toBe(false);
    expect(catalog.get('pkg.node.release').destructive).toBe(false);
  });

  it('resolves a PHP minor through php.net\'s JSON index over https only, with the sha256 of the .tar.xz', async () => {
    exec.mockImplementation(async (bin, argv) => {
      expect(bin).toBe('curl');
      expect(argv.slice(0, 7)).toEqual(['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--max-time', '60']);
      expect(argv[argv.length - 1]).toBe('https://www.php.net/releases/index.php?json&version=8.4');
      return ok(RELEASE('8.4.27', { sha256: SRC_SHA }));
    });
    expect(await runOp('pkg.php.release', { minor: '8.4' }, ctx)).toEqual({ minor: '8.4', version: '8.4.27', filename: 'php-8.4.27.tar.xz', sha256: SRC_SHA });
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockImplementation(async () => ok('{"version":""}'));
    expect((await opError(runOp('pkg.php.release', { minor: '8.4' }, ctx))).code).toBe('not_found');
    exec.mockImplementation(async () => ok(RELEASE('8.3.1')));
    expect((await opError(runOp('pkg.php.release', { minor: '8.4' }, ctx))).code).toBe('invalid_release');
    expect(fs.readdirSync(dirs.WHM_KEEL_PHP_DIR)).toEqual([]);
  });

  it.skipIf(!archOk)('resolves a Node.js major through the SHASUMS256 index for this architecture and downloads nothing', async () => {
    exec.mockImplementation(async (bin, argv) => {
      expect(bin).toBe('curl');
      expect(argv[argv.length - 1]).toBe('https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt');
      return ok(`${SHA_A}  node-v20.19.4-linux-${arch}.tar.xz\n${'b'.repeat(64)}  node-v20.19.4-darwin-${arch}.tar.gz\n`);
    });
    expect(await runOp('pkg.node.release', { major: 20 }, ctx)).toEqual({ major: 20, arch, version: 'v20.19.4', file: `node-v20.19.4-linux-${arch}.tar.xz`, sha256: SHA_A });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dirs.WHM_NODE_DIR)).toEqual([]);
    exec.mockImplementation(async () => ok(`${SHA_A}  node-v20.19.4-darwin-${arch}.tar.gz\n`));
    expect((await opError(runOp('pkg.node.release', { major: 20 }, ctx))).code).toBe('not_found');
  });
});

describe('pkg.php.build.finish over an already registered unit (update of a Keel build)', () => {
  const unitFileFor = () => path.join(dirs.WHM_SYSTEMD_UNIT_DIR, 'keel-php8.4-fpm.service');
  // The unit's state before the op, then what systemctl answers once the op acted on it.
  const systemctl = (calls, { activeBefore, enabledAfter = 'enabled' }) => {
    let acted = false;
    return async (bin, argv) => {
      if (bin === 'systemctl') {
        calls.push(argv);
        if (argv[0] === 'is-active') return acted || activeBefore ? ok('active\n') : { stdout: 'inactive\n', stderr: '', code: 3 };
        if (argv[0] === 'is-enabled') return enabledAfter === 'enabled' ? ok('enabled\n') : { stdout: `${enabledAfter}\n`, stderr: '', code: 1 };
        acted = true;
        return ok();
      }
      if (bin.endsWith(path.join('bin', 'php'))) return ok('8.4.28');
      throw new Error(`unexpected ${bin} ${argv.join(' ')}`);
    };
  };

  it.skipIf(!linux)('restarts a running unit instead of enabling it and reports restarted: true', async () => {
    const prefix = fakeKeelTree('8.4');
    fs.writeFileSync(unitFileFor(), '[Unit]\nDescription=old\n');
    hasBinary.mockImplementation((name) => name === 'systemctl');
    const calls = [];
    exec.mockImplementation(systemctl(calls, { activeBefore: true }));
    const r = await runOp('pkg.php.build.finish', { minor: '8.4' }, ctx);
    expect(r).toMatchObject({ minor: '8.4', version: '8.4.28', prefix, unit: 'keel-php8.4-fpm', active: true, enabled: true, restarted: true });
    expect(calls).toEqual([['is-active', 'keel-php8.4-fpm.service'], ['daemon-reload'], ['restart', 'keel-php8.4-fpm.service'], ['is-active', 'keel-php8.4-fpm.service'], ['is-enabled', 'keel-php8.4-fpm.service']]);
    expect(fs.readFileSync(unitFileFor(), 'utf8')).toBe(renderPhpUnit('8.4'));
  });

  it.skipIf(!linux)('enables a unit whose file exists but which is not running (first enable failed, or stopped by the admin) instead of restarting it', async () => {
    fakeKeelTree('8.4');
    fs.writeFileSync(unitFileFor(), renderPhpUnit('8.4'));
    hasBinary.mockImplementation((name) => name === 'systemctl');
    const calls = [];
    exec.mockImplementation(systemctl(calls, { activeBefore: false }));
    const r = await runOp('pkg.php.build.finish', { minor: '8.4' }, ctx);
    expect(r).toMatchObject({ active: true, enabled: true });
    expect(r.restarted).toBeUndefined();
    expect(calls).toEqual([['is-active', 'keel-php8.4-fpm.service'], ['daemon-reload'], ['enable', '--now', 'keel-php8.4-fpm.service'], ['is-active', 'keel-php8.4-fpm.service'], ['is-enabled', 'keel-php8.4-fpm.service']]);
  });

  it.skipIf(!linux)('reports enabled: false when systemctl says so, and never probes a unit that has no file yet', async () => {
    fakeKeelTree('8.4');
    hasBinary.mockImplementation((name) => name === 'systemctl');
    const calls = [];
    exec.mockImplementation(systemctl(calls, { activeBefore: true, enabledAfter: 'disabled' }));
    const r = await runOp('pkg.php.build.finish', { minor: '8.4' }, ctx);
    expect(r).toMatchObject({ active: true, enabled: false });
    expect(r.restarted).toBeUndefined();
    expect(calls[0]).toEqual(['daemon-reload']);
    expect(calls[1]).toEqual(['enable', '--now', 'keel-php8.4-fpm.service']);
  });
});

describe('php-build.sh over a live prefix (update of a Keel build)', () => {
  it('guards the discovery marker and the seeded configuration so a rebuild keeps the running version and the operator\'s php.ini', () => {
    expect(buildScript).toMatch(/^if \[ \$fresh = 1 \]; then rm -f "\$KEEL_PHP_PREFIX\/\.keel-build-ok"; fi$/m);
    expect(buildScript).not.toMatch(/^rm -f "\$KEEL_PHP_PREFIX\/\.keel-build-ok"/m);
    expect(buildScript).toMatch(/^\[ -e "\$KEEL_PHP_PREFIX\/lib\/php\.ini" \] \|\| install -m 0644 php\.ini-production "\$KEEL_PHP_PREFIX\/lib\/php\.ini"$/m);
    // The opcache snippet is seeded only when the build produced opcache.so (php-config --extension-dir), and never reset.
    expect(buildScript).toMatch(/^extdir="\$\("\$KEEL_PHP_PREFIX\/bin\/php-config" --extension-dir 2>\/dev\/null \|\| true\)"$/m);
    expect(buildScript).toMatch(/^if \[ -n "\$extdir" \] && \[ -e "\$extdir\/opcache\.so" \]; then\n  \[ -e "\$KEEL_PHP_PREFIX\/lib\/conf\.d\/10-opcache\.ini" \] \|\| printf 'zend_extension=opcache\\n' > "\$KEEL_PHP_PREFIX\/lib\/conf\.d\/10-opcache\.ini"\nelse/m);
    expect(buildScript.match(/10-opcache\.ini/g)).toHaveLength(3);
    expect(buildScript.match(/php\.ini-production/g)).toHaveLength(1);
    // php-fpm.conf and keel-idle.conf stay panel-owned and are regenerated on every run; the marker is still written last.
    expect(buildScript).toMatch(/^mv "\$fpmconf\.tmp" "\$fpmconf"$/m);
    expect(buildScript).toMatch(/^mv "\$idle\.tmp" "\$idle"$/m);
    expect(buildScript.trimEnd().split('\n').pop()).toBe(': > "$KEEL_PHP_PREFIX/.keel-build-ok"');
  });

  // The script only accepts a prefix under /opt/keel/php, so the real run needs a writable
  // /opt/keel/php (the Linux host clone); configure, make and the built binaries are shims.
  const keelRoot = '/opt/keel/php';
  const canRun = linux && fs.existsSync('/bin/bash') && (() => { try { fs.accessSync(keelRoot, fs.constants.W_OK); return true; } catch { return false; } })();
  it.skipIf(!canRun)('keeps .keel-build-ok, php.ini and 10-opcache.ini across a rebuild, and keeps them when the rebuild fails', async () => {
    const { execFile } = await import('node:child_process');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-php-build-'));
    const prefix = path.join(keelRoot, `.rebuild-test-${process.pid}`);
    const freshPrefix = path.join(keelRoot, `.fresh-test-${process.pid}`);
    const src = path.join(work, 'php-8.4.28');
    const shims = path.join(work, 'bin');
    const scriptPath = path.join(work, 'php-build.sh');
    const run = (env) => new Promise((resolve) => execFile('/bin/bash', [scriptPath], { env: { ...process.env, PATH: `${shims}:${process.env.PATH}`, ...env }, maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr })));
    fs.mkdirSync(src); fs.mkdirSync(shims);
    fs.writeFileSync(scriptPath, buildScript);
    fs.writeFileSync(path.join(src, 'configure'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(src, 'php.ini-production'), 'memory_limit = 128M\n');
    // make install writes the binaries the script runs afterwards; make records whether the marker was present while it ran and fails on demand.
    fs.writeFileSync(path.join(shims, 'make'), [
      '#!/bin/sh',
      'if [ -e "$KEEL_TEST_FAIL" ]; then echo "make: simulated failure" >&2; exit 2; fi',
      'if [ -e "$KEEL_PHP_PREFIX/.keel-build-ok" ]; then echo present >> "$KEEL_TEST_LOG"; else echo absent >> "$KEEL_TEST_LOG"; fi',
      'if [ "$1" = install ]; then',
      '  mkdir -p "$KEEL_PHP_PREFIX/bin" "$KEEL_PHP_PREFIX/sbin" "$KEEL_PHP_PREFIX/lib/php/extensions/no-debug-non-zts"',
      '  printf \'#!/bin/sh\\necho "== built PHP 8.4.28"\\n\' > "$KEEL_PHP_PREFIX/bin/php"; chmod 755 "$KEEL_PHP_PREFIX/bin/php"',
      '  printf \'#!/bin/sh\\nexit 0\\n\' > "$KEEL_PHP_PREFIX/sbin/php-fpm"; chmod 755 "$KEEL_PHP_PREFIX/sbin/php-fpm"',
      '  printf \'#!/bin/sh\\n[ "$1" = --extension-dir ] && echo "%s/lib/php/extensions/no-debug-non-zts"\\n\' "$KEEL_PHP_PREFIX" > "$KEEL_PHP_PREFIX/bin/php-config"; chmod 755 "$KEEL_PHP_PREFIX/bin/php-config"',
      '  if [ -z "$KEEL_TEST_NO_OPCACHE" ]; then : > "$KEEL_PHP_PREFIX/lib/php/extensions/no-debug-non-zts/opcache.so"; fi',
      'fi',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    const log = path.join(work, 'make.log');
    const failFlag = path.join(work, 'fail');
    const env = { KEEL_PHP_SRC: src, KEEL_PHP_PREFIX: prefix, KEEL_PHP_MINOR: '8.4', KEEL_PHP_JOBS: '1', KEEL_FPM_USER: 'nobody', KEEL_FPM_GROUP: 'nogroup', KEEL_TEST_LOG: log, KEEL_TEST_FAIL: failFlag };
    try {
      const first = await run(env);
      expect(first.code, first.stderr).toBe(0);
      expect(fs.existsSync(path.join(prefix, '.keel-build-ok'))).toBe(true);
      expect(fs.readFileSync(path.join(prefix, 'lib', 'php.ini'), 'utf8')).toBe('memory_limit = 128M\n');
      expect(fs.readFileSync(path.join(prefix, 'lib', 'conf.d', '10-opcache.ini'), 'utf8')).toBe('zend_extension=opcache\n');
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['absent', 'absent']);
      // A build without the opcache extension gets no 10-opcache.ini (php-fpm would log "Failed loading Zend extension 'opcache'" on every start).
      const noOpcache = path.join(keelRoot, `.no-opcache-test-${process.pid}`);
      try {
        const bare = await run({ ...env, KEEL_PHP_PREFIX: noOpcache, KEEL_TEST_NO_OPCACHE: '1' });
        expect(bare.code, bare.stderr).toBe(0);
        expect(fs.existsSync(path.join(noOpcache, 'lib', 'conf.d', '10-opcache.ini'))).toBe(false);
        expect(bare.stdout).toMatch(/opcache\.so not found/);
        expect(fs.existsSync(path.join(noOpcache, '.keel-build-ok'))).toBe(true);
      } finally { fs.rmSync(noOpcache, { recursive: true, force: true }); }
      // The operator edited both files; the rebuild must keep them and the marker must stay for the whole run.
      fs.writeFileSync(path.join(prefix, 'lib', 'php.ini'), 'memory_limit = 512M\n');
      fs.writeFileSync(path.join(prefix, 'lib', 'conf.d', '10-opcache.ini'), 'zend_extension=opcache\nopcache.memory_consumption=256\n');
      fs.writeFileSync(log, '');
      const second = await run(env);
      expect(second.code, second.stderr).toBe(0);
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['present', 'present']);
      expect(fs.existsSync(path.join(prefix, '.keel-build-ok'))).toBe(true);
      expect(fs.readFileSync(path.join(prefix, 'lib', 'php.ini'), 'utf8')).toBe('memory_limit = 512M\n');
      expect(fs.readFileSync(path.join(prefix, 'lib', 'conf.d', '10-opcache.ini'), 'utf8')).toBe('zend_extension=opcache\nopcache.memory_consumption=256\n');
      expect(fs.readFileSync(path.join(prefix, 'etc', 'php-fpm.conf'), 'utf8')).toContain('[global]');
      // A failed rebuild keeps the prefix, the marker and the configuration: the version that still serves stays listed.
      fs.writeFileSync(failFlag, '');
      const failed = await run(env);
      expect(failed.code).not.toBe(0);
      expect(fs.existsSync(path.join(prefix, '.keel-build-ok'))).toBe(true);
      expect(fs.existsSync(path.join(prefix, 'bin', 'php'))).toBe(true);
      expect(fs.readFileSync(path.join(prefix, 'lib', 'php.ini'), 'utf8')).toBe('memory_limit = 512M\n');
      // A fresh prefix that fails is removed entirely.
      const fresh = await run({ ...env, KEEL_PHP_PREFIX: freshPrefix });
      expect(fresh.code).not.toBe(0);
      expect(fs.existsSync(freshPrefix)).toBe(false);
    } finally {
      fs.rmSync(prefix, { recursive: true, force: true });
      fs.rmSync(freshPrefix, { recursive: true, force: true });
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
