import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec, hasBinary } from '../src/exec.js';
import { runOp, createContext, OpError, DEFAULT_ALLOWED_ROOTS, catalog } from '../src/lib.js';
import {
  parseOsRelease, pickNodeTarball, verifySha256, probePpaSeries, phpDiscovery, phpPackageGlob,
  APT_SOURCES_DIR, APT_KEYRINGS_DIR, YUM_REPOS_DIR, NODE_DIR, LOCAL_BIN_DIR,
} from '../src/ops/pkg.js';

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
    expect([APT_SOURCES_DIR, APT_KEYRINGS_DIR, YUM_REPOS_DIR, NODE_DIR, LOCAL_BIN_DIR].every((p) => DEFAULT_ALLOWED_ROOTS.includes(p))).toBe(true);
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

  it('on Debian lists the php<ver>-* packages with dpkg-query and removes exactly those', async () => {
    phpDiscovery.discover = () => PHP_SET('8.3');
    hasBinary.mockImplementation((name) => name === 'apt-get' || name === 'dpkg-query');
    exec.mockImplementation(async (bin, argv) => {
      if (bin === 'dpkg-query') { expect(argv).toEqual(['-W', '-f', '${binary:Package}\n', 'php8.2-*']); return ok('php8.2-cli\nphp8.2-fpm\nphp8.2-common:amd64\nphp-common\n\n'); }
      if (bin === 'apt-get') return ok('Removing php8.2-cli');
      throw new Error(`unexpected ${bin}`);
    });
    const r = await runOp('pkg.php.remove', { version: '8.2' }, ctx);
    expect(r).toMatchObject({ version: '8.2', manager: 'apt', packages: ['php8.2-cli', 'php8.2-fpm', 'php8.2-common'], purge: false, background: false, code: 0 });
    const apt = exec.mock.calls.find((c) => c[0] === 'apt-get');
    expect(apt[1]).toEqual(['remove', '-y', '-q', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', '--', 'php8.2-cli', 'php8.2-fpm', 'php8.2-common']);
    expect(apt[2].env).toMatchObject({ DEBIAN_FRONTEND: 'noninteractive' });
    exec.mockClear();
    exec.mockImplementation(async (bin) => (bin === 'dpkg-query' ? ok('php-common\n') : ok()));
    expect((await opError(runOp('pkg.php.remove', { version: '8.2' }, ctx))).code).toBe('not_found');
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['dpkg-query']);
    exec.mockClear();
    exec.mockImplementation(async (bin) => (bin === 'dpkg-query' ? ok('php8.2-cli\n') : ok()));
    expect((await runOp('pkg.php.remove', { version: '8.2', purge: true }, ctx)).packages).toEqual(['php8.2-cli']);
    expect(exec.mock.calls.find((c) => c[0] === 'apt-get')[1][0]).toBe('purge');
  });

  it('on EL lists rpm names under the layout glob and removes them with the package manager', async () => {
    phpDiscovery.discover = () => ({ versions: [{ id: 'php83', binary: '/opt/remi/php83/root/usr/bin/php', layout: 'remi' }, { id: 'ea-php82', binary: '/opt/cpanel/ea-php82/root/usr/bin/php', layout: 'ea4' }], defaultId: null, defaultBinary: null });
    hasBinary.mockImplementation((name) => name === 'dnf' || name === 'rpm');
    exec.mockImplementation(async (bin, argv) => {
      if (bin === 'rpm') { expect(argv).toEqual(['-qa', '--qf', '%{NAME}\n', 'ea-php82-*']); return ok('ea-php82-php-cli\nea-php82-runtime\n'); }
      if (bin === 'dnf') return ok();
      throw new Error(`unexpected ${bin}`);
    });
    const r = await runOp('pkg.php.remove', { version: 'ea-php82' }, ctx);
    expect(r).toMatchObject({ manager: 'dnf', packages: ['ea-php82-php-cli', 'ea-php82-runtime'] });
    expect(exec.mock.calls.find((c) => c[0] === 'dnf')[1]).toEqual(['-y', '-q', 'remove', '--', 'ea-php82-php-cli', 'ea-php82-runtime']);
    expect(phpPackageGlob({ id: 'php83', layout: 'remi' })).toBe('php83-php-*');
    expect(phpPackageGlob({ id: '8.3', layout: 'debian' })).toBe('php8.3-*');
    expect(phpPackageGlob({ id: 'system', layout: 'unknown' })).toBeNull();
  });
});
