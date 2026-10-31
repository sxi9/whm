import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';

// Installing a PHP branch from the panel: the catalogued source per family is
// enabled with fixed argv (never a shell), the branch's packages are filtered
// through what the repositories offer, and nothing here ever runs a real
// package manager — every exec is answered by the mock below.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, hasBinary: vi.fn(() => false), exec: vi.fn(async (bin, argv) => ({ code: 0, stdout: '', stderr: '', bin, argv })) };
});
const { exec, hasBinary } = await import('../src/exec.js');
const { readOsRelease, phpSourceFor, phpPackageNames, parseAptPolicyBlocks, parseDnfList, PHP_SOURCES, PHP_BRANCHES, PHP_EXTENSIONS } = await import('../src/ops/pkg.js');

const ctx = createContext();
fs.mkdirSync('/tmp/whm', { recursive: true, mode: 0o700 });
const base = fs.mkdtempSync('/tmp/whm/pkg-php-');
const previous = { apt: process.env.WHM_APT_ROOT, os: process.env.WHM_OS_RELEASE_FILE };
afterAll(() => {
  if (previous.apt === undefined) delete process.env.WHM_APT_ROOT; else process.env.WHM_APT_ROOT = previous.apt;
  if (previous.os === undefined) delete process.env.WHM_OS_RELEASE_FILE; else process.env.WHM_OS_RELEASE_FILE = previous.os;
  fs.rmSync(base, { recursive: true, force: true });
});

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

const calls = () => exec.mock.calls.map(([bin, argv]) => [bin, ...argv]);
const APT_INSTALL = ['install', '-y', '-q', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];

// One host per describe block: its /etc/os-release, its apt tree and the
// programs on its PATH.
function host(name, { osRelease, binaries, answer }) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'apt', 'sources.list.d'), { recursive: true });
  fs.writeFileSync(path.join(root, 'os-release'), osRelease);
  process.env.WHM_APT_ROOT = path.join(root, 'apt');
  process.env.WHM_OS_RELEASE_FILE = path.join(root, 'os-release');
  hasBinary.mockImplementation((bin) => binaries.includes(bin));
  exec.mockReset();
  exec.mockImplementation(async (bin, argv) => ({ code: 0, stdout: '', stderr: '', bin, argv, ...((await answer?.(bin, argv)) || {}) }));
  return root;
}

const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n';
const DEBIAN = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\nVERSION_CODENAME=bookworm\n';
const ALMA = 'NAME="AlmaLinux"\nVERSION="9.4 (Seafoam Ocelot)"\nID="almalinux"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\nPRETTY_NAME="AlmaLinux 9.4 (Seafoam Ocelot)"\n';

const policyBlock = (name, { installed = null, candidate = null, origin = 'http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages' } = {}) => {
  if (!installed && !candidate) return '';
  const lines = [`${name}:`, `  Installed: ${installed || '(none)'}`, `  Candidate: ${candidate || installed || '(none)'}`, '  Version table:'];
  if (installed) lines.push(` *** ${installed} 100`, '        100 /var/lib/dpkg/status');
  if (candidate && candidate !== installed) lines.push(`     ${candidate} 500`, `        500 ${origin}`);
  else if (installed) lines.push(`     ${installed} 500`, `        500 ${origin}`);
  return `${lines.join('\n')}\n`;
};

describe('schemas', () => {
  it('reject anything but a catalogued source, a d.d branch and plain extension suffixes before anything runs', async () => {
    host('schema', { osRelease: UBUNTU, binaries: ['apt-get', 'dpkg-query', 'apt-cache'] });
    for (const bad of ['ppa:ondrej/php', 'ondrej;id', 'remi-safe', '', 'SURY', '../sury', 'deb.sury.org']) expect((await opError(runOp('pkg.php.source.enable', { source: bad }, ctx))).code, bad).toBe('invalid_args');
    for (const bad of ['83', '8.3.1', '8', 'php8.3', '8.3;id', '8.3 ', '-8.3', '8.3\n', 'ea-php83', '8.10', '']) {
      expect((await opError(runOp('pkg.php.install', { version: bad }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.php.remove', { version: bad }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.php.sources.detect', { branches: [bad] }, ctx))).code, bad).toBe('invalid_args');
    }
    for (const bad of ['-r', 'Curl', 'curl;id', 'a b', '../x', 'x'.repeat(33), '']) expect((await opError(runOp('pkg.php.install', { version: '8.3', extensions: [bad] }, ctx))).code, bad).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.install', { version: '8.3', purge: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.install', { version: '8.3', wait: 'no' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.remove', { version: '8.3', extra: 1 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.source.enable', { source: 'ondrej', refresh: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.sources.detect', { all: true }, ctx))).code).toBe('invalid_args');
    for (const bad of ['ppa:ondrej/php', '', 'SURY', '../sury']) expect((await opError(runOp('pkg.php.source.rollback', { source: bad }, ctx))).code, bad).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.source.rollback', { source: 'sury', wait: false }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('marks the branch removal and the source rollback destructive and keeps the catalog entries', () => {
    expect(catalog.get('pkg.php.remove').destructive).toBe(true);
    expect(catalog.get('pkg.php.source.rollback').destructive).toBe(true);
    expect(catalog.get('pkg.php.install').destructive).toBe(false);
    expect(catalog.get('pkg.php.source.enable').destructive).toBe(false);
    expect(catalog.get('pkg.php.sources.detect').destructive).toBe(false);
    expect(PHP_BRANCHES).toContain('8.3');
    expect(PHP_EXTENSIONS.debian).toContain('opcache');
    expect(PHP_EXTENSIONS.rhel).toContain('pecl-zip');
  });

  it('refuses every op without a package manager', async () => {
    host('nopm', { osRelease: UBUNTU, binaries: [] });
    for (const [name, args] of [['pkg.php.sources.detect', {}], ['pkg.php.source.enable', { source: 'ondrej' }], ['pkg.php.source.rollback', { source: 'ondrej' }], ['pkg.php.install', { version: '8.3' }], ['pkg.php.remove', { version: '8.3' }]]) {
      expect((await opError(runOp(name, args, ctx))).code, name).toBe('capability_missing');
    }
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('catalog helpers', () => {
  it('pick the source per family and derive package names per layout', () => {
    const apt = { family: 'debian' };
    expect(phpSourceFor(apt, readOsRelease(path.join(host('h1', { osRelease: UBUNTU, binaries: [] }), 'os-release')))).toMatchObject({ key: 'ondrej', codename: 'noble', supported: true });
    expect(phpSourceFor(apt, readOsRelease(path.join(host('h2', { osRelease: DEBIAN, binaries: [] }), 'os-release')))).toMatchObject({ key: 'sury', codename: 'bookworm', supported: true });
    expect(phpSourceFor({ family: 'rhel' }, readOsRelease(path.join(host('h3', { osRelease: ALMA, binaries: [] }), 'os-release')))).toMatchObject({ key: 'remi', major: 9, supported: true });
    // Linux Mint reads as Ubuntu through ID_LIKE and UBUNTU_CODENAME.
    expect(phpSourceFor(apt, readOsRelease(path.join(host('h4', { osRelease: 'ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_CODENAME=wilma\nUBUNTU_CODENAME=noble\n', binaries: [] }), 'os-release')))).toMatchObject({ key: 'ondrej', codename: 'noble' });
    expect(phpSourceFor(apt, readOsRelease(path.join(host('h5', { osRelease: 'ID=debian\n', binaries: [] }), 'os-release')))).toMatchObject({ key: 'sury', supported: false });
    expect(phpSourceFor({ family: null }, readOsRelease('/nonexistent/os-release'))).toMatchObject({ key: null, supported: false });
    expect(phpPackageNames('debian', '8.3')).toMatchObject({ id: '8.3', prefix: 'php8.3-', probe: 'php8.3-fpm', fpmUnit: 'php8.3-fpm', core: ['php8.3-fpm', 'php8.3-cli', 'php8.3-common'] });
    expect(phpPackageNames('debian', '8.3').extensions).toEqual(PHP_EXTENSIONS.debian.map((e) => `php8.3-${e}`));
    expect(phpPackageNames('rhel', '8.3')).toMatchObject({ id: 'php83', prefix: 'php83-php-', probe: 'php83-php-fpm', fpmUnit: 'php83-php-fpm' });
    expect(phpPackageNames('rhel', '8.3', ['mysqlnd']).extensions).toEqual(['php83-php-mysqlnd']);
    expect(Object.keys(PHP_SOURCES)).toEqual(['ondrej', 'sury', 'remi']);
  });

  it('parse multi-package apt-cache policy output with the candidate origin, and dnf list with wrapped names', () => {
    const text = `${policyBlock('php8.3-fpm', { installed: '8.3.6-0ubuntu0.24.04.2', origin: 'http://archive.ubuntu.com/ubuntu noble-updates/universe amd64 Packages' })}${policyBlock('php8.4-fpm', { candidate: '8.4.12-1+ubuntu24.04.1+deb.sury.org+1', origin: 'https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble/main amd64 Packages' })}`;
    const parsed = parseAptPolicyBlocks(text);
    expect(parsed['php8.3-fpm']).toEqual({ installed: '8.3.6-0ubuntu0.24.04.2', candidate: '8.3.6-0ubuntu0.24.04.2', origin: 'http://archive.ubuntu.com/ubuntu', versions: [{ version: '8.3.6-0ubuntu0.24.04.2', origin: 'http://archive.ubuntu.com/ubuntu' }] });
    expect(parsed['php8.4-fpm']).toEqual({ installed: null, candidate: '8.4.12-1+ubuntu24.04.1+deb.sury.org+1', origin: 'https://ppa.launchpadcontent.net/ondrej/php/ubuntu', versions: [{ version: '8.4.12-1+ubuntu24.04.1+deb.sury.org+1', origin: 'https://ppa.launchpadcontent.net/ondrej/php/ubuntu' }] });
    expect(parsed['php8.5-fpm']).toBeUndefined();
    expect(parseAptPolicyBlocks('php-opcache:\n  Installed: (none)\n  Candidate: (none)\n  Version table:\n')['php-opcache']).toEqual({ installed: null, candidate: null, origin: null, versions: [] });
    // A PPA entry above the archive entry: every table entry keeps its first repository, the dpkg status line never counts.
    expect(parseAptPolicyBlocks(PHP_FPM_META_POLICY)['php-fpm']).toEqual({
      installed: '2:8.4+96+ubuntu24.04.1+deb.sury.org+1', candidate: '2:8.4+96+ubuntu24.04.1+deb.sury.org+1', origin: 'https://ppa.launchpadcontent.net/ondrej/php/ubuntu',
      versions: [{ version: '2:8.4+96+ubuntu24.04.1+deb.sury.org+1', origin: 'https://ppa.launchpadcontent.net/ondrej/php/ubuntu' }, { version: '2:8.3+93ubuntu2', origin: 'http://archive.ubuntu.com/ubuntu' }],
    });
    const dnf = ['Last metadata expiration check: 0:10:00 ago.', 'Installed Packages', 'php82-php-fpm.x86_64        8.2.24-1.el9.remi        @remi-safe', 'Available Packages', 'php83-php-fpm.x86_64        8.3.12-1.el9.remi        remi-safe', 'php84-php-pecl-zip.x86_64', '                            1.22.3-1.el9.remi.8.4     remi-safe', ''].join('\n');
    expect(parseDnfList(dnf)).toEqual({
      'php82-php-fpm': { installed: '8.2.24-1.el9.remi', candidate: null, origin: 'remi-safe' },
      'php83-php-fpm': { installed: null, candidate: '8.3.12-1.el9.remi', origin: 'remi-safe' },
      'php84-php-pecl-zip': { installed: null, candidate: '1.22.3-1.el9.remi.8.4', origin: 'remi-safe' },
    });
    expect(parseDnfList('Error: No matching Packages to list\n')).toEqual({});
  });
});

// The php-fpm meta-package once the PPA is enabled: its build is the candidate, the archive's 8.3 build sits below it.
const PHP_FPM_META_POLICY = ['php-fpm:', '  Installed: 2:8.4+96+ubuntu24.04.1+deb.sury.org+1', '  Candidate: 2:8.4+96+ubuntu24.04.1+deb.sury.org+1', '  Version table:',
  ' *** 2:8.4+96+ubuntu24.04.1+deb.sury.org+1 500', '        500 https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble/main amd64 Packages', '        100 /var/lib/dpkg/status',
  '     2:8.3+93ubuntu2 500', '        500 http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages', ''].join('\n');

describe('Ubuntu: ppa:ondrej/php', () => {
  const binaries = ['apt-get', 'apt-cache', 'dpkg-query', 'systemctl'];
  const answer = (bin, argv) => {
    if (bin === 'apt-cache' && argv[0] === 'policy') {
      return { stdout: argv.slice(2).map((name) => {
        if (name === 'php8.3-fpm') return policyBlock(name, { installed: '8.3.6-0ubuntu0.24.04.2' });
        if (name === 'php8.3-opcache' || name === 'php8.3-common' || name === 'php8.3-cli') return policyBlock(name, { candidate: '8.3.6-0ubuntu0.24.04.2' });
        if (/^php8\.[12]-/.test(name) || name === 'php8.4-fpm') return policyBlock(name, { candidate: `${name.slice(3, 6)}.1-1+ubuntu24.04.1+deb.sury.org+1`, origin: 'https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble/main amd64 Packages' });
        if (name === 'php-fpm') return PHP_FPM_META_POLICY;
        return '';
      }).join('') };
    }
    // The PPA's meta-package depends on php8.4-fpm; the archive's build on php8.3-fpm.
    if (bin === 'apt-cache' && argv[0] === 'depends') return { stdout: argv[2] === 'php-fpm=2:8.3+93ubuntu2' ? 'php-fpm\n  Depends: php8.3-fpm\n' : 'php-fpm\n  Depends: php8.4-fpm\n' };
    return {};
  };

  it('detects the PPA from the apt sources, the stock branch from the archive entry and what each branch resolves to', async () => {
    const root = host('ubuntu-detect', { osRelease: UBUNTU, binaries, answer });
    const before = await runOp('pkg.php.sources.detect', {}, ctx);
    expect(before).toMatchObject({ manager: 'apt', family: 'debian', os: { id: 'ubuntu', codename: 'noble' }, source: { key: 'ondrej', configured: false, supported: true, codename: 'noble' }, stock: '8.3', branches: PHP_BRANCHES });
    expect(before.versions.map((v) => [v.version, v.offered, v.installed, v.source])).toEqual([['7.4', false, false, null], ['8.0', false, false, null], ['8.1', true, false, 'ondrej'], ['8.2', true, false, 'ondrej'], ['8.3', true, true, 'distro'], ['8.4', true, false, 'ondrej'], ['8.5', false, false, null]]);
    expect(before.versions[4]).toMatchObject({ id: '8.3', package: 'php8.3-fpm', fpmUnit: 'php8.3-fpm', installedVersion: '8.3.6-0ubuntu0.24.04.2' });
    // One policy call carries the meta-package too; the stock branch is resolved from its archive build, not the PPA's candidate.
    expect(calls()).toEqual([['apt-cache', 'policy', '--', ...PHP_BRANCHES.map((v) => `php${v}-fpm`), 'php-fpm'], ['apt-cache', 'depends', '--', 'php-fpm=2:8.3+93ubuntu2']]);
    // Without an archive entry the plain meta-package decides (the pre-PPA host).
    exec.mockClear();
    exec.mockImplementation(async (bin, argv) => ({ code: 0, stdout: '', stderr: '', bin, argv, ...(bin === 'apt-cache' && argv[0] === 'policy' ? { stdout: '' } : (await answer(bin, argv)) || {}) }));
    expect((await runOp('pkg.php.sources.detect', { branches: ['8.3'] }, ctx)).stock).toBe('8.4');
    expect(calls()[1]).toEqual(['apt-cache', 'depends', '--', 'php-fpm']);
    exec.mockImplementation(async (bin, argv) => ({ code: 0, stdout: '', stderr: '', bin, argv, ...((await answer(bin, argv)) || {}) }));
    // A commented-out entry does not count; an active deb822 file does.
    fs.writeFileSync(path.join(root, 'apt', 'sources.list.d', 'old.list'), '# deb https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble main\n');
    expect((await runOp('pkg.php.sources.detect', { branches: ['8.3'] }, ctx)).source.configured).toBe(false);
    // A stanza disabled by software-properties carries `Enabled: no` after its URIs line.
    fs.writeFileSync(path.join(root, 'apt', 'sources.list.d', 'ondrej-ubuntu-php-noble.sources'), 'Types: deb\nURIs: https://ppa.launchpadcontent.net/ondrej/php/ubuntu/\nSuites: noble\nComponents: main\nEnabled: no\n');
    expect((await runOp('pkg.php.sources.detect', { branches: ['8.3'] }, ctx)).source.configured).toBe(false);
    // `# Enabled: no` is a comment, and a second active stanza in the same file counts on its own.
    fs.writeFileSync(path.join(root, 'apt', 'sources.list.d', 'ondrej-ubuntu-php-noble.sources'), 'Types: deb\nURIs: https://example.org/other/\nSuites: noble\nComponents: main\nEnabled: no\n\nTypes: deb\n# Enabled: no\nURIs: https://ppa.launchpadcontent.net/ondrej/php/ubuntu/\nSuites: noble\nComponents: main\n');
    const after = await runOp('pkg.php.sources.detect', { branches: ['8.3'] }, ctx);
    expect(after.source.configured).toBe(true);
    expect(after.versions).toHaveLength(1);
  });

  it('enables the PPA with add-apt-repository (installing software-properties-common first when missing) and refreshes the index; a second call changes nothing', async () => {
    const root = host('ubuntu-enable', { osRelease: UBUNTU, binaries, answer });
    const r = await runOp('pkg.php.source.enable', { source: 'ondrej' }, ctx);
    expect(r).toMatchObject({ source: 'ondrej', changed: true, alreadyConfigured: false, background: false, code: 0 });
    expect(r.steps.map((s) => s.step)).toEqual(['software-properties-common', 'add-apt-repository ppa:ondrej/php']);
    expect(calls()).toEqual([
      ['apt-get', ...APT_INSTALL, '--no-install-recommends', '--', 'software-properties-common'],
      ['add-apt-repository', '-y', '-n', 'ppa:ondrej/php'],
      ['apt-get', 'update', '-q'],
    ]);
    expect(exec.mock.calls.every(([, , opts]) => opts?.env?.DEBIAN_FRONTEND === 'noninteractive')).toBe(true);
    // Nothing was written by hand: add-apt-repository owns the sources file.
    expect(fs.readdirSync(path.join(root, 'apt', 'sources.list.d'))).toEqual([]);
    fs.writeFileSync(path.join(root, 'apt', 'sources.list.d', 'ondrej-ubuntu-php-noble.list'), 'deb https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble main\n');
    hasBinary.mockImplementation((bin) => [...binaries, 'add-apt-repository'].includes(bin));
    exec.mockClear();
    const again = await runOp('pkg.php.source.enable', { source: 'ondrej' }, ctx);
    expect(again).toMatchObject({ changed: false, alreadyConfigured: true, steps: [] });
    expect(calls()).toEqual([['apt-get', 'update', '-q']]);
    expect((await opError(runOp('pkg.php.source.enable', { source: 'sury' }, ctx))).code).toBe('unsupported');
    expect((await opError(runOp('pkg.php.source.enable', { source: 'remi' }, ctx))).code).toBe('unsupported');
    expect((await opError(runOp('pkg.php.source.rollback', { source: 'sury' }, ctx))).code).toBe('unsupported');
  });

  it('removes the PPA again when the index refresh fails right after enabling it, and leaves a pre-existing entry alone', async () => {
    const root = host('ubuntu-refresh-fails', { osRelease: UBUNTU, binaries: [...binaries, 'add-apt-repository'], answer: (bin, argv) => (bin === 'apt-get' && argv[0] === 'update' ? { code: 100, stderr: 'E: The repository \'https://ppa.launchpadcontent.net/ondrej/php/ubuntu plucky Release\' does not have a Release file.\n' } : answer(bin, argv)) });
    const err = await opError(runOp('pkg.php.source.enable', { source: 'ondrej' }, ctx));
    expect(err.code).toBe('refused');
    expect(err.message).toMatch(/exited with status 100: E: The repository/);
    expect(err.message).toMatch(/entry was removed again/);
    expect(err.details).toMatchObject({ rolledBack: true });
    expect(err.details.steps.map((s) => s.step)).toEqual(['add-apt-repository ppa:ondrej/php', 'rollback: add-apt-repository -r ppa:ondrej/php']);
    expect(calls()).toEqual([
      ['add-apt-repository', '-y', '-n', 'ppa:ondrej/php'],
      ['apt-get', 'update', '-q'],
      ['add-apt-repository', '-r', '-y', '-n', 'ppa:ondrej/php'],
    ]);
    // Already configured: the failure is reported, nothing is removed.
    fs.writeFileSync(path.join(root, 'apt', 'sources.list.d', 'ondrej-ubuntu-php-noble.list'), 'deb https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble main\n');
    exec.mockClear();
    const existing = await opError(runOp('pkg.php.source.enable', { source: 'ondrej' }, ctx));
    expect(existing.code).toBe('command_failed');
    expect(calls()).toEqual([['apt-get', 'update', '-q']]);
    // The detached path cannot roll back inside the op: the service calls the rollback op when the run fails.
    exec.mockClear();
    const rb = await runOp('pkg.php.source.rollback', { source: 'ondrej' }, ctx);
    expect(rb).toMatchObject({ source: 'ondrej', steps: [{ step: 'add-apt-repository -r ppa:ondrej/php', ok: true }] });
    expect(calls()).toEqual([['add-apt-repository', '-r', '-y', '-n', 'ppa:ondrej/php']]);
  });

  it('installs a branch with only the packages the repositories offer and enables its FPM unit', async () => {
    host('ubuntu-install', { osRelease: UBUNTU, binaries: [...binaries, 'add-apt-repository'], answer });
    const r = await runOp('pkg.php.install', { version: '8.2', extensions: ['mysql', 'curl', 'opcache', 'zip'] }, ctx);
    expect(r).toMatchObject({ manager: 'apt', family: 'debian', version: '8.2', id: '8.2', fpmUnit: 'php8.2-fpm', prefix: 'php8.2-', background: false, code: 0, skipped: [], unit: { unit: 'php8.2-fpm', enabled: true } });
    expect(r.packages).toEqual(['php8.2-fpm', 'php8.2-cli', 'php8.2-common', 'php8.2-mysql', 'php8.2-curl', 'php8.2-opcache', 'php8.2-zip']);
    expect(calls()).toEqual([
      ['apt-cache', 'policy', '--', 'php8.2-fpm', 'php8.2-cli', 'php8.2-common', 'php8.2-mysql', 'php8.2-curl', 'php8.2-opcache', 'php8.2-zip'],
      ['apt-get', ...APT_INSTALL, '--', 'php8.2-fpm', 'php8.2-cli', 'php8.2-common', 'php8.2-mysql', 'php8.2-curl', 'php8.2-opcache', 'php8.2-zip'],
      ['systemctl', 'enable', '--now', 'php8.2-fpm.service'],
    ]);
    exec.mockClear();
    // The stock branch: php8.3-fpm installed, only cli/common/opcache offered of the rest → the others are skipped, never failing the transaction.
    const stock = await runOp('pkg.php.install', { version: '8.3' }, ctx);
    expect(stock.packages).toEqual(['php8.3-fpm', 'php8.3-cli', 'php8.3-common', 'php8.3-opcache']);
    expect(stock.skipped).toEqual(PHP_EXTENSIONS.debian.filter((e) => e !== 'opcache').map((e) => `php8.3-${e}`));
    expect(stock.alreadyInstalled).toEqual(['php8.3-fpm']);
    expect(calls()[1]).toEqual(['apt-get', ...APT_INSTALL, '--', 'php8.3-fpm', 'php8.3-cli', 'php8.3-common', 'php8.3-opcache']);
    exec.mockClear();
    // A branch no repository offers is refused before apt-get runs.
    expect((await opError(runOp('pkg.php.install', { version: '8.5' }, ctx))).code).toBe('unsupported');
    expect(calls().map((c) => c[0])).toEqual(['apt-cache']);
  });

  it('refuses to remove a branch that is not installed and never touches the package manager for it', async () => {
    host('ubuntu-remove', { osRelease: UBUNTU, binaries, answer });
    const err = await opError(runOp('pkg.php.remove', { version: '7.4' }, ctx));
    expect(err.code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('Debian: packages.sury.org/php', () => {
  const KEY = Buffer.from([0x99, 0x01, 0x0d, 0x04, 0x5a, 0x1b, 0x2c, 0x3d]);
  const binaries = ['apt-get', 'apt-cache', 'dpkg-query', 'curl', 'systemctl'];
  const fetches = [];
  const answer = (bin, argv, keyBytes = KEY) => {
    if (bin === 'curl') { fetches.push(argv); fs.writeFileSync(argv[argv.indexOf('-o') + 1], keyBytes); return {}; }
    if (bin === 'apt-cache' && argv[0] === 'depends') return { stdout: 'php-fpm\n  Depends: php8.2-fpm\n' };
    return {};
  };
  beforeEach(() => { fetches.length = 0; });

  it('fetches the signing key into the keyring directory, writes a signed-by sources entry, refreshes; idempotent', async () => {
    const root = host('debian-enable', { osRelease: DEBIAN, binaries, answer });
    const apt = path.join(root, 'apt');
    const r = await runOp('pkg.php.source.enable', { source: 'sury' }, ctx);
    expect(r).toMatchObject({ source: 'sury', changed: true, background: false, code: 0 });
    const keyring = path.join(apt, 'keyrings', 'whm-sury-php.gpg');
    expect(r.steps).toEqual([{ step: 'signing key', ok: true, path: keyring }, { step: 'sources list', ok: true, path: path.join(apt, 'sources.list.d', 'whm-sury-php.list') }]);
    expect(fetches).toEqual([['-fsSL', '--max-time', '60', '-o', expect.stringMatching(/\/keyrings\/whm-sury-php\.whm-[0-9a-f]{12}$/), 'https://packages.sury.org/php/apt.gpg']]);
    expect(fs.readFileSync(keyring)).toEqual(KEY);
    expect(fs.statSync(keyring).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(path.join(apt, 'sources.list.d', 'whm-sury-php.list'), 'utf8')).toBe(`deb [signed-by=${keyring}] https://packages.sury.org/php/ bookworm main\n`);
    expect(fs.readdirSync(path.join(apt, 'keyrings'))).toEqual(['whm-sury-php.gpg']);
    expect(fs.readdirSync(path.join(apt, 'sources.list.d'))).toEqual(['whm-sury-php.list']);
    expect(calls()).toEqual([['curl', ...fetches[0]], ['apt-get', 'update', '-q']]);
    exec.mockClear();
    const again = await runOp('pkg.php.source.enable', { source: 'sury' }, ctx);
    expect(again).toMatchObject({ changed: false, alreadyConfigured: true, steps: [] });
    expect(calls()).toEqual([['apt-get', 'update', '-q']]);
    expect(fs.readdirSync(path.join(apt, 'keyrings'))).toEqual(['whm-sury-php.gpg']);
    expect((await opError(runOp('pkg.php.source.enable', { source: 'ondrej' }, ctx))).code).toBe('unsupported');
  });

  it('keeps an armored key as .asc, refuses a download that is not a key, and installs curl when no fetcher exists', async () => {
    const armored = Buffer.from('-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQINBF...\n-----END PGP PUBLIC KEY BLOCK-----\n');
    const root = host('debian-armored', { osRelease: DEBIAN, binaries, answer: (bin, argv) => answer(bin, argv, armored) });
    const r = await runOp('pkg.php.source.enable', { source: 'sury' }, ctx);
    expect(r.steps[0].path).toBe(path.join(root, 'apt', 'keyrings', 'whm-sury-php.asc'));
    expect(fs.readFileSync(path.join(root, 'apt', 'sources.list.d', 'whm-sury-php.list'), 'utf8')).toContain('[signed-by=' + path.join(root, 'apt', 'keyrings', 'whm-sury-php.asc') + ']');

    const bad = host('debian-badkey', { osRelease: DEBIAN, binaries, answer: (bin, argv) => answer(bin, argv, Buffer.from('<html>not found</html>')) });
    const err = await opError(runOp('pkg.php.source.enable', { source: 'sury' }, ctx));
    expect(err.code).toBe('command_failed');
    expect(err.message).toMatch(/not an OpenPGP key/);
    expect(fs.readdirSync(path.join(bad, 'apt', 'keyrings'))).toEqual([]);
    expect(fs.existsSync(path.join(bad, 'apt', 'sources.list.d', 'whm-sury-php.list'))).toBe(false);
    expect(calls().some((c) => c[0] === 'apt-get')).toBe(false);

    host('debian-nocurl', { osRelease: DEBIAN, binaries: ['apt-get', 'apt-cache', 'dpkg-query'], answer });
    hasBinary.mockImplementation((bin) => ['apt-get', 'apt-cache', 'dpkg-query'].includes(bin) || (bin === 'curl' && exec.mock.calls.length > 0));
    const installed = await runOp('pkg.php.source.enable', { source: 'sury' }, ctx);
    expect(installed.steps.map((s) => s.step)).toEqual(['curl', 'signing key', 'sources list']);
    expect(calls()[0]).toEqual(['apt-get', ...APT_INSTALL, '--no-install-recommends', '--', 'curl', 'ca-certificates']);
  });

  it('refuses to write outside the allowed roots while the detection keeps the host supported; the default roots cover exactly the catalog files', async () => {
    host('debian-outside', { osRelease: DEBIAN, binaries, answer });
    process.env.WHM_APT_ROOT = '/usr/share/whm-apt-test';
    try {
      expect((await opError(runOp('pkg.php.source.enable', { source: 'sury' }, ctx))).code).toBe('path_not_allowed');
      expect(fs.existsSync('/usr/share/whm-apt-test')).toBe(false);
      expect(exec).not.toHaveBeenCalled();
      expect((await opError(runOp('pkg.php.source.rollback', { source: 'sury' }, ctx))).code).toBe('path_not_allowed');
      expect((await runOp('pkg.php.sources.detect', { branches: ['8.3'] }, ctx)).source).toMatchObject({ key: 'sury', configured: false, supported: true, reason: null });
    } finally { process.env.WHM_APT_ROOT = path.join(base, 'debian-outside', 'apt'); }
    expect((await runOp('pkg.php.sources.detect', { branches: ['8.3'] }, ctx)).source).toMatchObject({ key: 'sury', supported: true, reason: null });
    // On a real Debian host the agent's default roots take the keyring and the
    // list file under their catalog names and nothing else under /etc/apt.
    const real = createContext();
    const refused = (p) => { try { real.assertAllowedPath(p, 'write'); } catch (err) { return err.code; } return null; };
    for (const p of ['/etc/apt/keyrings/whm-sury-php.gpg', '/etc/apt/keyrings/whm-sury-php.asc', '/etc/apt/sources.list.d/whm-sury-php.list']) expect(real.assertAllowedPath(p, 'write'), p).toBe(p);
    for (const p of ['/etc/apt', '/etc/apt/sources.list', '/etc/apt/apt.conf', '/etc/apt/trusted.gpg', '/etc/apt/trusted.gpg.d/whm.gpg', '/etc/apt/preferences.d/whm', '/etc/apt/keyrings/../sources.list', '/etc/apt/sources.list.d/../apt.conf', '/etc/apt/keyringsx/k.gpg', '/etc/apt/sources.list.dx/x.list']) expect(refused(p), p).toBe('path_not_allowed');
  });

  it('removes the list file and the keyring again when the index refresh fails after enabling', async () => {
    const root = host('debian-refresh-fails', { osRelease: DEBIAN, binaries, answer: (bin, argv) => (bin === 'apt-get' && argv[0] === 'update' ? { code: 100, stderr: 'E: The repository \'https://packages.sury.org/php/ forky Release\' does not have a Release file.\n' } : answer(bin, argv)) });
    const apt = path.join(root, 'apt');
    const err = await opError(runOp('pkg.php.source.enable', { source: 'sury' }, ctx));
    expect(err.code).toBe('refused');
    expect(err.details.steps.map((s) => s.step)).toEqual(['signing key', 'sources list', 'rollback: sources list', 'rollback: signing key']);
    expect(fs.existsSync(path.join(apt, 'sources.list.d', 'whm-sury-php.list'))).toBe(false);
    expect(fs.readdirSync(path.join(apt, 'keyrings'))).toEqual([]);
    expect(calls().map((c) => c[0])).toEqual(['curl', 'apt-get']);
    // The same host, enabled with a detached refresh: the service rolls back through the op.
    exec.mockClear();
    const detached = await runOp('pkg.php.source.enable', { source: 'sury', wait: false }, ctx);
    expect(detached).toMatchObject({ changed: true, background: true });
    expect(fs.existsSync(path.join(apt, 'sources.list.d', 'whm-sury-php.list'))).toBe(true);
    const rb = await runOp('pkg.php.source.rollback', { source: 'sury' }, ctx);
    expect(rb.steps.map((s) => s.step)).toEqual(['sources list', 'signing key']);
    expect(rb.configured).toBe(false);
    expect(fs.existsSync(path.join(apt, 'sources.list.d', 'whm-sury-php.list'))).toBe(false);
    expect(fs.readdirSync(path.join(apt, 'keyrings'))).toEqual([]);
  });
});

describe('RHEL family: Remi SCL packages', () => {
  const binaries = ['dnf', 'rpm', 'systemctl'];
  const state = { remi: false, epel: false, epelFromBase: true };
  const answer = (bin, argv) => {
    if (bin === 'rpm' && argv[0] === '-q' && argv[1] === '--') return { code: argv[2] === 'remi-release' ? (state.remi ? 0 : 1) : argv[2] === 'epel-release' ? (state.epel ? 0 : 1) : 1 };
    if (bin === 'rpm' && argv[0] === '-q') return { stdout: argv.includes('php82-php-fpm') ? 'php82-php-fpm\t8.2.24-1.el9.remi\n' : '', stderr: 'package php83-php-fpm is not installed\n' };
    if (bin === 'dnf' && argv.includes('install')) {
      const target = argv[argv.length - 1];
      if (target === 'epel-release') { if (!state.epelFromBase) return { code: 1, stderr: 'Error: Unable to find a match: epel-release\n' }; state.epel = true; }
      if (target.includes('epel-release-latest')) state.epel = true;
      if (target.includes('remi-release')) state.remi = true;
      return {};
    }
    if (bin === 'dnf' && argv.includes('list')) {
      const names = argv.slice(argv.indexOf('--') + 1);
      const rows = ['Available Packages'];
      for (const n of names) {
        if (n === 'php82-php-fpm') continue;
        if (/^php8[134]-php-(fpm|cli|common|mysqlnd|gd|opcache)$/.test(n)) rows.push(`${n}.x86_64        ${n.slice(3, 4)}.${n.slice(4, 5)}.9-1.el9.remi        remi-safe`);
        if (n === 'php-fpm') rows.push('php-fpm.x86_64        8.0.30-1.el9        appstream');
      }
      return { stdout: `${['Installed Packages', 'php82-php-fpm.x86_64        8.2.24-1.el9.remi        @remi-safe', ...rows].join('\n')}\n` };
    }
    return {};
  };

  it('detects Remi through rpm, the stock branch through the php-fpm package and SCL branches through dnf list', async () => {
    host('alma-detect', { osRelease: ALMA, binaries, answer });
    state.remi = false;
    const r = await runOp('pkg.php.sources.detect', {}, ctx);
    expect(r).toMatchObject({ manager: 'dnf', family: 'rhel', os: { id: 'almalinux', versionId: '9.4' }, source: { key: 'remi', configured: false, major: 9, supported: true }, stock: '8.0' });
    expect(r.versions.map((v) => [v.version, v.id, v.offered, v.installed, v.source])).toEqual([['7.4', 'php74', false, false, null], ['8.0', 'php80', false, false, null], ['8.1', 'php81', true, false, 'remi'], ['8.2', 'php82', true, true, 'remi'], ['8.3', 'php83', true, false, 'remi'], ['8.4', 'php84', true, false, 'remi'], ['8.5', 'php85', false, false, null]]);
    expect(r.versions[3]).toMatchObject({ package: 'php82-php-fpm', fpmUnit: 'php82-php-fpm', installedVersion: '8.2.24-1.el9.remi' });
    expect(calls()[0]).toEqual(['rpm', '-q', '--', 'remi-release']);
    expect(calls()[2]).toEqual(['dnf', '-q', '-y', 'list', '--', ...PHP_BRANCHES.map((v) => `php${v.replace('.', '')}-php-fpm`), 'php-fpm']);
    expect(calls()).toHaveLength(3);
    state.remi = true;
    expect((await runOp('pkg.php.sources.detect', { branches: ['8.3'] }, ctx)).source.configured).toBe(true);
  });

  it('removes remi-release again when makecache fails after enabling', async () => {
    host('alma-refresh-fails', { osRelease: ALMA, binaries, answer: (bin, argv) => (bin === 'dnf' && argv.includes('makecache') ? { code: 1, stderr: 'Error: Failed to download metadata for repo \'remi-safe\'\n' } : answer(bin, argv)) });
    Object.assign(state, { remi: false, epel: true, epelFromBase: true });
    const err = await opError(runOp('pkg.php.source.enable', { source: 'remi' }, ctx));
    expect(err.code).toBe('refused');
    expect(err.message).toMatch(/Failed to download metadata/);
    expect(calls().slice(-2)).toEqual([['dnf', '-y', '-q', 'makecache'], ['dnf', '-y', '-q', 'remove', '--', 'remi-release']]);
    exec.mockClear();
    expect(await runOp('pkg.php.source.rollback', { source: 'remi' }, ctx)).toMatchObject({ source: 'remi', steps: [{ step: 'remove remi-release', ok: true }] });
    expect(calls()[0]).toEqual(['dnf', '-y', '-q', 'remove', '--', 'remi-release']);
  });

  it('enables Remi: epel-release, the remi-release RPM for the OS major, CRB, makecache; falls back to the EPEL URL on RHEL proper', async () => {
    host('alma-enable', { osRelease: ALMA, binaries, answer });
    Object.assign(state, { remi: false, epel: false, epelFromBase: true });
    const r = await runOp('pkg.php.source.enable', { source: 'remi' }, ctx);
    expect(r).toMatchObject({ source: 'remi', changed: true, background: false, code: 0 });
    expect(r.steps).toEqual([{ step: 'epel-release', ok: true, output: null }, { step: 'remi-release', ok: true }, { step: 'enable crb', ok: true, output: null }]);
    expect(calls()).toEqual([
      ['rpm', '-q', '--', 'remi-release'],
      ['rpm', '-q', '--', 'epel-release'],
      ['dnf', '-y', '-q', 'install', '--', 'epel-release'],
      ['dnf', '-y', '-q', 'install', '--', 'https://rpms.remirepo.net/enterprise/remi-release-9.rpm'],
      ['dnf', '-q', 'config-manager', '--set-enabled', 'crb'],
      ['dnf', '-y', '-q', 'makecache'],
    ]);
    exec.mockClear();
    expect(await runOp('pkg.php.source.enable', { source: 'remi' }, ctx)).toMatchObject({ changed: false, alreadyConfigured: true, steps: [] });
    expect(calls()).toEqual([['rpm', '-q', '--', 'remi-release'], ['dnf', '-y', '-q', 'makecache']]);

    host('rhel-enable', { osRelease: 'NAME="Red Hat Enterprise Linux"\nVERSION_ID="8.10"\nID="rhel"\nID_LIKE="fedora"\nPRETTY_NAME="Red Hat Enterprise Linux 8.10 (Ootpa)"\n', binaries, answer });
    Object.assign(state, { remi: false, epel: false, epelFromBase: false });
    const rhel = await runOp('pkg.php.source.enable', { source: 'remi' }, ctx);
    expect(rhel.steps[0]).toEqual({ step: 'epel-release', ok: true, output: null });
    expect(calls().slice(2, 6)).toEqual([
      ['dnf', '-y', '-q', 'install', '--', 'epel-release'],
      ['dnf', '-y', '-q', 'install', '--', 'https://dl.fedoraproject.org/pub/epel/epel-release-latest-8.noarch.rpm'],
      ['dnf', '-y', '-q', 'install', '--', 'https://rpms.remirepo.net/enterprise/remi-release-8.rpm'],
      ['dnf', '-q', 'config-manager', '--set-enabled', 'powertools'],
    ]);
    expect((await opError(runOp('pkg.php.source.enable', { source: 'ondrej' }, ctx))).code).toBe('unsupported');
  });

  it('installs the SCL package set (dnf install php83-php-*) skipping what Remi does not ship and enables php83-php-fpm', async () => {
    host('alma-install', { osRelease: ALMA, binaries, answer });
    state.remi = true;
    const r = await runOp('pkg.php.install', { version: '8.3', extensions: PHP_EXTENSIONS.rhel }, ctx);
    expect(r).toMatchObject({ manager: 'dnf', family: 'rhel', version: '8.3', id: 'php83', fpmUnit: 'php83-php-fpm', prefix: 'php83-php-', unit: { unit: 'php83-php-fpm', enabled: true } });
    expect(r.packages).toEqual(['php83-php-fpm', 'php83-php-cli', 'php83-php-common', 'php83-php-mysqlnd', 'php83-php-gd', 'php83-php-opcache']);
    expect(r.skipped).toEqual(['php83-php-mbstring', 'php83-php-xml', 'php83-php-pdo', 'php83-php-intl', 'php83-php-bcmath', 'php83-php-soap', 'php83-php-pecl-zip']);
    const wanted = ['php83-php-fpm', 'php83-php-cli', 'php83-php-common', ...PHP_EXTENSIONS.rhel.map((e) => `php83-php-${e}`)];
    expect(calls()).toEqual([
      ['rpm', '-q', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\n', '--', ...wanted],
      ['dnf', '-q', '-y', 'list', '--', ...wanted],
      ['dnf', '-y', '-q', 'install', '--', ...r.packages],
      ['systemctl', 'enable', '--now', 'php83-php-fpm.service'],
    ]);
    expect((await opError(runOp('pkg.php.install', { version: '7.4' }, ctx))).code).toBe('unsupported');
  });

  it('yum hosts use the same argv shape', async () => {
    host('centos', { osRelease: 'ID="centos"\nVERSION_ID="7"\nPRETTY_NAME="CentOS Linux 7 (Core)"\n', binaries: ['yum', 'rpm'], answer });
    state.remi = true;
    const r = await runOp('pkg.php.sources.detect', { branches: ['8.3'] }, ctx);
    expect(r).toMatchObject({ manager: 'yum', source: { key: 'remi', major: 7, configured: true } });
    expect(calls()[2][0]).toBe('yum');
  });
});
