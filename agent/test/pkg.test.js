import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exec, hasBinary } from '../src/exec.js';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import {
  parseInstalledList, parseAptSearch, parseDnfSearch, parseAptSimulation, parseDnfCheckUpdate, parseAptPolicy, parsePeclList, parseGemList,
  parsePerlModules, parseIni, setIniDirectives, parseFpmPool, renderNginxProxy, parseProxyHeader, NGINX_PROXY_CONF, hostHasIpv6,
  versionAtLeast, nginxHttp2Directive, nginxRejectHandshake, disableServerBlocks, restoreServerBlocks,
  parseAptRemoveSimulation, parseDnfRemoveSimulation, peclIniHint, startRun, pollRun, PKG_RUN_DIR, NGINX_SSL_ROOTS, nginxSslPath,
} from '../src/ops/pkg.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

const ctx = createContext();

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

const INJECTION = ['-r', '--purge', 'a;b', 'a b', '../x', '$(id)', 'a|b', 'a&&b', 'a\nb', '', '`id`'];

describe('pkg op schemas reject injection before anything runs', () => {
  it('unknown ops are refused', async () => {
    expect((await opError(runOp('pkg.nope', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('pkg.install.now', {}, ctx))).code).toBe('unknown_op');
  });

  it('package names (install / remove / upgrade / info / list prefix)', async () => {
    exec.mockClear();
    for (const bad of INJECTION) {
      expect((await opError(runOp('pkg.install', { packages: [bad] }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.remove', { packages: [bad] }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.upgrade', { packages: [bad] }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.info', { name: bad }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.list_installed', { prefix: [bad] }, ctx))).code, bad).toBe('invalid_args');
    }
    expect((await opError(runOp('pkg.install', { packages: [] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.install', { packages: ['nginx'], extra: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.install', { packages: 'nginx' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.install', { packages: ['nginx'], wait: 'no' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.remove', { packages: ['nginx'], purge: 'yes' }, ctx))).code).toBe('invalid_args');
    for (const bad of INJECTION) expect((await opError(runOp('pkg.remove_simulate', { packages: [bad] }, ctx))).code, bad).toBe('invalid_args');
    expect((await opError(runOp('pkg.remove_simulate', { packages: ['nginx'], wait: false }, ctx))).code).toBe('invalid_args');
    for (const bad of ['-r', '../x', 'abc', 'a;b-000000000000', 'ABC-0123456789ab', 'x'.repeat(40)]) expect((await opError(runOp('pkg.run.status', { id: bad }, ctx))).code, bad).toBe('invalid_args');
    expect((await opError(runOp('pkg.run.status', { id: 'abc123-0123456789ab', offset: -1 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.update_index', { wait: 1 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.rebuild_rpmdb', { extra: 1 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('a well-formed but unknown run id is not found and never touches a process', async () => {
    exec.mockClear();
    expect((await opError(runOp('pkg.run.status', { id: 'abc123-0123456789ab' }, ctx))).code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
  });

  it('search terms and search limit', async () => {
    exec.mockClear();
    for (const bad of [...INJECTION, 'x'.repeat(65), '*']) expect((await opError(runOp('pkg.search', { q: bad }, ctx))).code, bad).toBe('invalid_args');
    expect((await opError(runOp('pkg.search', { q: 'curl', limit: 0 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.list_installed', { q: 'a;b' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('module installer names', async () => {
    exec.mockClear();
    for (const bad of [...INJECTION, '::Foo', 'Foo::', 'Foo::-Bar', 'Foo/Bar']) expect((await opError(runOp('pkg.perl.install', { modules: [bad] }, ctx))).code, bad).toBe('invalid_args');
    for (const bad of [...INJECTION, 'Redis', 'redis-1.0;x', 'redis--']) expect((await opError(runOp('pkg.pecl.install', { extension: bad }, ctx))).code, bad).toBe('invalid_args');
    for (const bad of [...INJECTION, 'Mail-1.0', 'pear/Mail']) expect((await opError(runOp('pkg.pear.install', { package: bad }, ctx))).code, bad).toBe('invalid_args');
    for (const bad of INJECTION) {
      expect((await opError(runOp('pkg.gem.install', { gem: bad }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.pip.install', { package: bad }, ctx))).code, bad).toBe('invalid_args');
    }
    for (const bad of ['-1', '1.0; id', 'latest', '1.0 2.0']) {
      expect((await opError(runOp('pkg.gem.install', { gem: 'rails', version: bad }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.pip.install', { package: 'requests', version: bad }, ctx))).code, bad).toBe('invalid_args');
    }
    expect((await opError(runOp('pkg.perl.install', { modules: [] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.pip.install', { package: 'requests', extras: ['x'] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('PHP version ids, SAPIs and ini directives', async () => {
    exec.mockClear();
    for (const bad of [...INJECTION, 'PHP8.3', '8.3/..', '/etc/php']) {
      expect((await opError(runOp('pkg.php.ini.read', { version: bad }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.php.ini.write', { version: bad, content: '' }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.php.default.set', { version: bad }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.phpfpm.pools', { version: bad }, ctx))).code, bad).toBe('invalid_args');
    }
    expect((await opError(runOp('pkg.php.ini.read', { version: '8.3', sapi: 'cgi' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.ini.write', { version: '8.3' }, ctx))).code).toBe('invalid_args');
    for (const bad of [{ 'memory_limit; x': '1' }, { '-x': '1' }, { 'a b': '1' }, { memory_limit: 'a\nb=1' }, { memory_limit: 'x'.repeat(1025) }, { memory_limit: 1 }]) {
      expect((await opError(runOp('pkg.php.ini.write', { version: '8.3', directives: bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
      expect((await opError(runOp('pkg.php.userini.write', { docroot: '/home/bob/public_html', directives: bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    for (const bad of ['relative/path', '/home/../etc', '/home/bob/../../etc/passwd', 'a\0b']) {
      expect((await opError(runOp('pkg.php.userini.read', { docroot: bad }, ctx))).code, bad).toBe('invalid_args');
    }
    expect((await opError(runOp('pkg.php.userini.write', { docroot: '/home/bob/public_html', owner: 'Bob', content: '' }, ctx))).code).toBe('invalid_args');
    // Branch installs take a bare d.d branch and a catalogued source key, nothing else (argv is built from the catalog).
    for (const bad of [...INJECTION, '83', '8.3.1', 'php8.3', 'ea-php83', '8.10', 'PHP 8.3']) {
      expect((await opError(runOp('pkg.php.install', { version: bad }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.php.remove', { version: bad }, ctx))).code, bad).toBe('invalid_args');
      expect((await opError(runOp('pkg.php.sources.detect', { branches: [bad] }, ctx))).code, bad).toBe('invalid_args');
    }
    for (const bad of [...INJECTION, 'ppa:ondrej/php', 'https://packages.sury.org/php/', 'remi-safe', 'SURY']) expect((await opError(runOp('pkg.php.source.enable', { source: bad }, ctx))).code, bad).toBe('invalid_args');
    for (const bad of [...INJECTION, 'Curl', 'x'.repeat(33)]) expect((await opError(runOp('pkg.php.install', { version: '8.3', extensions: [bad] }, ctx))).code, bad).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.install', { version: '8.3', purge: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.php.source.enable', { source: 'remi', force: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('.user.ini paths outside allowed roots are refused by the context', async () => {
    expect((await opError(runOp('pkg.php.userini.read', { docroot: '/usr/share' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('pkg.php.userini.read', { docroot: '/root' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('pkg.php.userini.write', { docroot: '/etc/ssh', content: 'x' }, ctx))).code).toBe('path_not_allowed');
  });
});

// /tmp/whm is an allowed root, so these exercise the real filesystem checks the
// way a hostile account would see them.
describe('.user.ini ops never follow links planted in an account docroot', () => {
  fs.mkdirSync('/tmp/whm', { recursive: true, mode: 0o700 });
  const base = fs.mkdtempSync('/tmp/whm/pkg-userini-');
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it('refuses a .user.ini that is a symbolic link, on read and on write', async () => {
    const docroot = path.join(base, 'link', 'public_html');
    fs.mkdirSync(docroot, { recursive: true });
    fs.symlinkSync('/etc/hostname', path.join(docroot, '.user.ini'));
    const read = await opError(runOp('pkg.php.userini.read', { docroot }, ctx));
    expect(read.code).toBe('refused');
    expect(read.message).toMatch(/symbolic link/);
    const write = await opError(runOp('pkg.php.userini.write', { docroot, directives: { memory_limit: '1G' } }, ctx));
    expect(write.code).toBe('refused');
    expect(fs.readlinkSync(path.join(docroot, '.user.ini'))).toBe('/etc/hostname');
    expect(fs.readdirSync(docroot)).toEqual(['.user.ini']);
  });

  it('refuses a docroot that resolves outside the allowed roots', async () => {
    const docroot = path.join(base, 'escape', 'public_html');
    fs.mkdirSync(path.dirname(docroot), { recursive: true });
    fs.symlinkSync('/etc', docroot);
    expect((await opError(runOp('pkg.php.userini.read', { docroot }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('pkg.php.userini.write', { docroot, content: 'x' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('pkg.php.userini.read', { docroot: path.join(base, 'missing') }, ctx))).code).toBe('not_found');
  });

  it('refuses a docroot outside the owner home and an unknown owner', async () => {
    const docroot = path.join(base, 'owner', 'public_html');
    fs.mkdirSync(docroot, { recursive: true });
    expect((await opError(runOp('pkg.php.userini.read', { docroot, owner: 'root' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('pkg.php.userini.write', { docroot, owner: 'nosuchuser', content: 'x' }, ctx))).code).toBe('not_found');
  });

  it('round-trips a regular file without leaving backups or temp files behind', async () => {
    const docroot = path.join(base, 'ok', 'public_html');
    fs.mkdirSync(docroot, { recursive: true });
    expect(await runOp('pkg.php.userini.read', { docroot }, ctx)).toMatchObject({ exists: false, content: '', directives: {} });
    const written = await runOp('pkg.php.userini.write', { docroot, directives: { memory_limit: '256M', display_errors: 'Off' } }, ctx);
    expect(written.directives).toEqual({ memory_limit: '256M', display_errors: 'Off' });
    expect(fs.readdirSync(docroot)).toEqual(['.user.ini']);
    expect(fs.lstatSync(written.path).isFile()).toBe(true);
    expect(fs.lstatSync(written.path).mode & 0o777).toBe(0o644);
    const again = await runOp('pkg.php.userini.write', { docroot, directives: { display_errors: null } }, ctx);
    expect(again.directives).toEqual({ memory_limit: '256M' });
    expect(fs.readdirSync(docroot)).toEqual(['.user.ini']);
    expect((await runOp('pkg.php.userini.read', { docroot }, ctx)).content).toBe('memory_limit = 256M\n');
    expect(await runOp('pkg.php.userini.write', { docroot, content: '' }, ctx)).toMatchObject({ removed: true });
    expect(fs.readdirSync(docroot)).toEqual([]);
  });

  it('refuses a .user.ini that is not a regular file', async () => {
    const docroot = path.join(base, 'dir', 'public_html');
    fs.mkdirSync(path.join(docroot, '.user.ini'), { recursive: true });
    expect((await opError(runOp('pkg.php.userini.read', { docroot }, ctx))).code).toBe('refused');
  });
});

// Background runs are what keeps every agent request short: the installer is
// started detached and polled, so a 45-minute dist-upgrade never has to fit in
// one socket round trip. perl stands in for the package manager here.
describe('background package runs', () => {
  const dir = fs.mkdtempSync('/tmp/whm/pkg-runs-');
  const previous = process.env.WHM_PKG_RUN_DIR;
  process.env.WHM_PKG_RUN_DIR = dir;
  afterAll(() => { if (previous === undefined) delete process.env.WHM_PKG_RUN_DIR; else process.env.WHM_PKG_RUN_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const settle = async (id, { timeoutMs = 10_000 } = {}) => {
    const lines = [];
    let offset = 0;
    const started = Date.now();
    for (;;) {
      const st = await runOp('pkg.run.status', { id, offset }, ctx);
      lines.push(...st.output);
      offset = st.offset;
      if (st.done) return { ...st, lines };
      if (Date.now() - started > timeoutMs) throw new Error(`run ${id} still ${st.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it.skipIf(!hasBinary('perl'))('streams the output of a detached command and records its exit code', async () => {
    const run = startRun({ kind: 'test', bin: 'perl', argv: ['-e', '$|=1; print "line one\\n"; print STDERR "to stderr\\n"; select(undef,undef,undef,0.2); print "partial"; print " line\\n"; exit 3;'], timeoutMs: 10_000 }, ctx);
    expect(run).toMatchObject({ status: 'running', kind: 'test', code: null });
    expect(run.id).toMatch(/^[a-z0-9]+-[0-9a-f]{12}$/);
    expect(path.dirname(run.logPath)).toBe(dir);
    expect(fs.statSync(run.logPath).mode & 0o777).toBe(0o600);
    const final = await settle(run.id);
    expect(final.status).toBe('finished');
    expect(final.code).toBe(3);
    expect(final.lines).toEqual(['line one', 'to stderr', 'partial line']);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith(run.id)).sort()).toEqual([`${run.id}.json`, `${run.id}.log`]);
    // The state file is not world readable: argv may name packages an operator considers private.
    expect(fs.statSync(path.join(dir, `${run.id}.json`)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!hasBinary('perl'))('terminates a run that outlives its timeout', async () => {
    const run = startRun({ kind: 'test', bin: 'perl', argv: ['-e', 'sleep 30'], timeoutMs: 100 }, ctx);
    await new Promise((r) => setTimeout(r, 150));
    const st = await runOp('pkg.run.status', { id: run.id }, ctx);
    expect(st.status).toBe('timeout');
    expect(st.error).toMatch(/terminated/);
    await new Promise((r) => setTimeout(r, 200));
    // The exit that follows the SIGTERM does not overwrite the timeout verdict.
    expect((await runOp('pkg.run.status', { id: run.id }, ctx)).status).toBe('timeout');
    expect(fs.existsSync(`/proc/${run.pid}/cmdline`)).toBe(false);
  });

  it('reports a run whose process vanished without an exit record as lost', async () => {
    const id = 'lostrun-0123456789ab';
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, kind: 'test', bin: '/usr/bin/apt-get', argv: ['install'], pid: 2147483000, startedAt: new Date().toISOString(), timeoutMs: 60_000, status: 'running', logPath: path.join(dir, `${id}.log`) }));
    fs.writeFileSync(path.join(dir, `${id}.log`), 'Reading package lists...\n');
    const st = await runOp('pkg.run.status', { id }, ctx);
    expect(st.status).toBe('lost');
    expect(st.done).toBe(true);
    expect(st.output).toEqual(['Reading package lists...']);
    expect(st.error).toMatch(/exit status was not recorded/);
  });

  it('refuses to start or poll when the run directory is outside the allowed roots', async () => {
    process.env.WHM_PKG_RUN_DIR = '/usr/share/whm-runs';
    try {
      expect(() => startRun({ kind: 'test', bin: 'perl', argv: ['-e', '1'], timeoutMs: 1000 }, ctx)).toThrow(OpError);
      expect((await opError(runOp('pkg.run.status', { id: 'abc123-0123456789ab' }, ctx))).code).toBe('path_not_allowed');
      expect(fs.existsSync('/usr/share/whm-runs')).toBe(false);
    } finally { process.env.WHM_PKG_RUN_DIR = dir; }
    expect(PKG_RUN_DIR).toBe('/var/lib/whm/pkg-runs');
    expect(() => startRun({ kind: 'test', bin: 'perl', argv: ['-e', 'a\0b'], timeoutMs: 1000 }, ctx)).toThrow(/NUL-free/);
    expect(() => startRun({ kind: 'test', bin: 'no-such-binary-xyz', argv: [], timeoutMs: 1000 }, ctx)).toThrow(/not installed/);
  });
});

describe('removal simulation parsers', () => {
  it('reads apt-get -s remove / purge output', () => {
    const out = parseAptRemoveSimulation('Reading package lists...\nBuilding dependency tree...\nRemv apache2 [2.4.58-1ubuntu8]\nRemv apache2-utils [2.4.58-1ubuntu8]\nPurg libapache2-mod-evasive\nConf foo (1.0 noble)\n');
    expect(out.map((p) => p.name)).toEqual(['apache2', 'apache2-utils', 'libapache2-mod-evasive']);
    expect(out[0]).toEqual({ name: 'apache2', version: '2.4.58-1ubuntu8', section: 'remove' });
    expect(parseAptRemoveSimulation('Reading package lists...\n')).toEqual([]);
  });

  it('reads the dnf --assumeno transaction table with its dependent and unused sections', () => {
    const text = ['Dependencies resolved.', '================================================================================', ' Package           Architecture  Version            Repository        Size', '================================================================================', 'Removing:', ' httpd-tools       x86_64        2.4.57-8.el9       @appstream       212 k', 'Removing dependent packages:', ' httpd             x86_64        2.4.57-8.el9       @appstream       4.9 M', ' mod_ssl           x86_64        1:2.4.57-8.el9     @appstream       290 k', 'Removing unused dependencies:', ' apr               x86_64        1.7.0-12.el9       @appstream       329 k', '', 'Transaction Summary', '================================================================================', 'Remove  4 Packages', '', 'Freed space: 6.1 M', 'Is this ok [y/N]: Operation aborted.', ''].join('\n');
    const out = parseDnfRemoveSimulation(text);
    expect(out).toEqual([
      { name: 'httpd-tools', version: '2.4.57-8.el9', section: 'remove' },
      { name: 'httpd', version: '2.4.57-8.el9', section: 'dependent' },
      { name: 'mod_ssl', version: '1:2.4.57-8.el9', section: 'dependent' },
      { name: 'apr', version: '1.7.0-12.el9', section: 'unused' },
    ]);
    expect(parseDnfRemoveSimulation('No match for argument: foo\nError: No packages marked for removal.\n')).toEqual([]);
    expect(peclIniHint('Build process completed successfully\nInstalling \'/usr/lib/php/20230831/redis.so\'\ninstall ok: channel://pecl.php.net/redis-6.0.2\nconfiguration option "php_ini" is not set to php.ini location\nYou should add "extension=redis.so" to php.ini\n')).toBe('extension=redis.so');
    expect(peclIniHint('nothing')).toBeNull();
  });
});

describe('nginx proxy rendering is valid for every supported nginx', () => {
  it('never lets an unknown HTTPS name fall through to a tenant block', () => {
    expect(nginxRejectHandshake('1.19.3')).toBe(false);
    expect(nginxRejectHandshake('1.19.4')).toBe(true);
    expect(nginxRejectHandshake('1.24.0')).toBe(true);
    expect(nginxRejectHandshake(null)).toBe(false);
    const domains = [
      { domain: 'bob.com', aliases: ['www.bob.com', 'parked.net', 'bob.com'], ssl: { cert: '/etc/ssl/whm/bob.com/fullchain.pem', key: '/etc/ssl/whm/bob.com/key.pem' } },
      { domain: 'alice.com', aliases: ['www.alice.com'] },
    ];
    const modern = renderNginxProxy({ apachePort: 8080, cache: false, domains, rejectHandshake: true });
    const blocks = modern.split(/^server \{/m).slice(1);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toContain('listen 443 ssl default_server;');
    expect(blocks[1]).toContain('ssl_reject_handshake on;');
    expect(blocks[1]).not.toContain('ssl_certificate');
    expect(blocks[2]).toContain('server_name bob.com www.bob.com parked.net;');
    expect(modern).not.toContain('alice.com');
    const legacy = renderNginxProxy({ apachePort: 8080, cache: false, domains, rejectHandshake: false, defaultCert: { cert: '/etc/nginx/whm-default/cert.pem', key: '/etc/nginx/whm-default/key.pem' } });
    expect(legacy).toContain('ssl_certificate /etc/nginx/whm-default/cert.pem;');
    expect(legacy).toContain('return 444;');
    expect(legacy).not.toContain('ssl_reject_handshake');
    expect(legacy.split(/^server \{/m).slice(1)).toHaveLength(3);
    const none = renderNginxProxy({ apachePort: 8080, cache: false, domains });
    expect(none.split(/^server \{/m).slice(1)).toHaveLength(2);
  });

  it('uses the http2 listen flag before 1.25.1 and the directive after', () => {
    expect(versionAtLeast('1.24.0', '1.25.1')).toBe(false);
    expect(versionAtLeast('1.25.1', '1.25.1')).toBe(true);
    expect(versionAtLeast('1.26', '1.25.1')).toBe(true);
    expect(versionAtLeast('1.22.1', '1.25.1')).toBe(false);
    expect(nginxHttp2Directive(null)).toBe(false);
    expect(nginxHttp2Directive('1.24.0')).toBe(false);
    expect(nginxHttp2Directive('1.27.2')).toBe(true);
    const domains = [{ domain: 'example.com', aliases: [], ssl: { cert: '/etc/ssl/whm/c.pem', key: '/etc/ssl/whm/k.pem' } }];
    const old = renderNginxProxy({ apachePort: 8080, cache: false, domains, http2Directive: false });
    expect(old).toContain('listen 443 ssl http2;');
    expect(old).not.toContain('http2 on;');
    const modern = renderNginxProxy({ apachePort: 8080, cache: false, domains, http2Directive: true });
    expect(modern).toContain('listen 443 ssl;');
    expect(modern).toContain('http2 on;');
    expect(modern).not.toContain('ssl http2');
  });

  it('omits the [::] listeners when the host has no usable IPv6', () => {
    const dir = fs.mkdtempSync('/tmp/whm/pkg-ipv6-');
    expect(hostHasIpv6(path.join(dir, 'if_inet6'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'if_inet6'), '');
    expect(hostHasIpv6(path.join(dir, 'if_inet6'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'if_inet6'), '00000000000000000000000000000001 01 80 10 80       lo\n');
    expect(hostHasIpv6(path.join(dir, 'if_inet6'))).toBe(true);
    const domains = [{ domain: 'example.com', aliases: ['www.example.com'], ssl: { cert: '/etc/ssl/whm/c.pem', key: '/etc/ssl/whm/k.pem' } }];
    const dual = renderNginxProxy({ apachePort: 8080, cache: false, domains, rejectHandshake: true });
    expect(dual).toContain('listen [::]:80 default_server;');
    expect(dual).toContain('listen [::]:443 ssl default_server;');
    expect(dual).toContain('listen [::]:443 ssl http2;');
    const v4 = renderNginxProxy({ apachePort: 8080, cache: false, domains, rejectHandshake: true, ipv6: false });
    expect(v4).not.toContain('[::]');
    expect(v4.split(/^server \{/m).slice(1)).toHaveLength(3);
    expect(v4).toContain('listen 80 default_server;');
    expect(v4).toContain('listen 443 ssl default_server;');
    expect(v4).toContain('listen 443 ssl http2;');
    const legacy = renderNginxProxy({ apachePort: 8080, cache: false, domains, rejectHandshake: false, defaultCert: { cert: '/etc/nginx/whm-default/cert.pem', key: '/etc/nginx/whm-default/key.pem' }, ipv6: false });
    expect(legacy).not.toContain('[::]');
    expect(legacy).toContain('listen 443 ssl default_server;');
    expect(legacy).toContain('return 444;');
  });

  it('comments out stock server blocks in nginx.conf reversibly', () => {
    const rhel = ['user nginx;', 'http {', '    include /etc/nginx/conf.d/*.conf;', '', '    server {', '        listen       80 default_server;', '        listen       [::]:80 default_server;', '        server_name  _;', '        location / {', '        }', '        error_page 404 /404.html; # not { a brace', '    }', '', '# Settings for a TLS enabled server.', '#    server {', '#        listen 443 ssl;', '#    }', '}', ''].join('\n');
    const { text, changed } = disableServerBlocks(rhel);
    expect(changed).toBe(true);
    expect(text).toContain('#whm-proxy#     server {');
    expect(text).toContain('#whm-proxy#         listen       80 default_server;');
    expect(text).toContain('#whm-proxy#     }\n\n# Settings for a TLS');
    expect(text).toContain('    include /etc/nginx/conf.d/*.conf;');
    expect(text).toContain('\n#    server {');
    expect(text).not.toContain('#whm-proxy# #    server {');
    expect(text.split('\n').filter((l) => l.startsWith('#whm-proxy# '))).toHaveLength(8);
    expect(restoreServerBlocks(text)).toBe(rhel);
    const debian = 'http {\n\tinclude /etc/nginx/conf.d/*.conf;\n\tinclude /etc/nginx/sites-enabled/*;\n}\n';
    expect(disableServerBlocks(debian)).toEqual({ text: debian, changed: false });
  });

  it.skipIf(!hasBinary('nginx'))('passes nginx -t on this host for plain and TLS domains', () => {
    const dir = fs.mkdtempSync('/tmp/whm/pkg-nginx-');
    try {
      const domains = [{ domain: 'plain.example.net', aliases: [] }];
      if (hasBinary('openssl')) {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-subj', '/CN=example.com', '-days', '1'], { stdio: 'ignore' });
        domains.push({ domain: 'example.com', aliases: ['www.example.com'], ssl: { cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem') } });
      }
      const version = execFileSync('nginx', ['-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).match(/nginx\/(\d+(?:\.\d+)*)/)?.[1];
      for (const cache of [false, true]) {
        const proxy = renderNginxProxy({ apachePort: 8080, cache, cacheMaxSizeMb: 64, cacheTtl: '1m', domains, http2Directive: nginxHttp2Directive(version), cachePath: path.join(dir, 'cache'), ipv6: hostHasIpv6() });
        fs.writeFileSync(path.join(dir, 'whm-proxy.conf'), proxy);
        fs.writeFileSync(path.join(dir, 'nginx.conf'), `pid ${dir}/nginx.pid;\nerror_log ${dir}/error.log;\nevents {}\nhttp {\n  access_log off;\n  include ${dir}/whm-proxy.conf;\n}\n`);
        const out = execFileSync('nginx', ['-t', '-p', dir, '-c', path.join(dir, 'nginx.conf')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        expect(out).not.toMatch(/emerg/);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('nginx proxy arguments', async () => {
    exec.mockClear();
    for (const bad of [{ apachePort: 0 }, { apachePort: 70000 }, { apachePort: '8080' }, { cacheTtl: '10 m; id' }, { cacheTtl: '10x' }, { cacheMaxSizeMb: 1 }, { extra: 1 }]) {
      expect((await opError(runOp('pkg.nginx.proxy.write', bad, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    for (const domain of ['-d', 'a;b.com', 'a b.com', 'EXAMPLE.COM', '../etc']) {
      expect((await opError(runOp('pkg.nginx.proxy.write', { domains: [{ domain }] }, ctx))).code, domain).toBe('invalid_args');
      expect((await opError(runOp('pkg.nginx.proxy.write', { domains: [{ domain: 'example.com', aliases: [domain] }] }, ctx))).code, domain).toBe('invalid_args');
    }
    expect((await opError(runOp('pkg.nginx.proxy.write', { domains: [{ domain: 'example.com', ssl: { cert: 'relative.pem', key: '/etc/ssl/whm/k.pem' } }] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.nginx.proxy.write', { domains: [{ domain: 'example.com', ssl: { cert: '/etc/ssl/whm/../../shadow', key: '/etc/ssl/whm/k.pem' } }] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pkg.nginx.status', { includeContent: 'yes' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('certificate paths cannot smuggle nginx directives and must live under the SSL stores', async () => {
    exec.mockClear();
    const ssl = (cert, key = '/etc/ssl/whm/example.com/key.pem') => runOp('pkg.nginx.proxy.write', { domains: [{ domain: 'example.com', ssl: { cert, key } }] }, ctx);
    const bad = [
      '/etc/ssl/whm/x.pem;\nlocation /x { alias /var/lib/whm/; autoindex on; }\n#',
      '/etc/ssl/whm/x.pem; include /etc/passwd;',
      '/etc/ssl/whm/x.pem }',
      '/etc/ssl/whm/x.pem #c',
      '/etc/ssl/whm/x pem',
      '/etc/ssl/whm/x.pem\t',
      '/etc/ssl/whm/$host.pem',
      '/etc/ssl/whm//x.pem',
      '/etc/ssl/whm/./x.pem',
      '/etc/ssl/whm/x.pem/..',
      '/etc/ssl/whm',
      '/etc/ssl/whmx/x.pem',
      '/etc/shadow',
      '/var/lib/whm/whm.db',
      '/home/alice/evil.pem',
      `/etc/ssl/whm/${'a'.repeat(260)}.pem`,
    ];
    for (const cert of bad) {
      expect((await opError(ssl(cert))).code, JSON.stringify(cert)).toBe('invalid_args');
      expect((await opError(ssl('/etc/ssl/whm/example.com/fullchain.pem', cert))).code, JSON.stringify(cert)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
    expect(NGINX_SSL_ROOTS).toEqual(['/etc/ssl/whm', '/etc/letsencrypt', '/etc/pki/tls/whm']);
    // Paths under every SSL root pass the schema (checked on the schema alone so nothing is written to /etc/nginx on a host that has it).
    for (const root of NGINX_SSL_ROOTS) {
      expect(nginxSslPath.safeParse(`${root}/example.com/fullchain.pem`).success, root).toBe(true);
      expect(nginxSslPath.safeParse(`${root}/live/example.com/privkey.pem`).success, root).toBe(true);
    }
    expect(nginxSslPath.safeParse('/etc/ssl/whm/example.com/fullchain.pem; include /etc/passwd;').success).toBe(false);
  });

  it('marks removals, file-displacing writes and the proxy removal as destructive', () => {
    expect(catalog.get('pkg.remove').destructive).toBe(true);
    expect(catalog.get('pkg.autoremove').destructive).toBe(true);
    expect(catalog.get('pkg.nginx.proxy.remove').destructive).toBe(true);
    expect(catalog.get('pkg.nginx.proxy.write').destructive).toBe(true);
    expect(catalog.get('pkg.php.userini.write').destructive).toBe(true);
    expect(catalog.get('pkg.php.userini.read').destructive).toBe(false);
    expect(catalog.get('pkg.install').destructive).toBe(false);
    expect(catalog.get('pkg.php.remove').destructive).toBe(true);
    expect(catalog.get('pkg.php.install').destructive).toBe(false);
    expect(catalog.get('pkg.php.source.enable').destructive).toBe(false);
    expect(NGINX_PROXY_CONF).toBe('/etc/nginx/conf.d/whm-proxy.conf');
  });

  it('the unit verbs the Software service drives are in the catalog', () => {
    for (const verb of ['start', 'stop', 'reload', 'restart', 'enable', 'disable']) expect(catalog.has(`svc.${verb}`), verb).toBe(true);
    expect(catalog.get('svc.stop').destructive).toBe(true);
    expect(catalog.get('svc.disable').destructive).toBe(true);
  });
});

describe('pure parsers', () => {
  it('parses dpkg/rpm installed lists and skips non-installed states', () => {
    const list = parseInstalledList('curl\t8.5.0\tamd64\tii \tcommand line tool\nold-pkg\t1.0\tamd64\trc \tremoved config\nnginx\t1.24\tamd64\tii \tweb server\n');
    expect(list.map((p) => p.name)).toEqual(['curl', 'nginx']);
    expect(list[0]).toEqual({ name: 'curl', version: '8.5.0', arch: 'amd64', summary: 'command line tool' });
  });

  it('parses apt and dnf search output', () => {
    expect(parseAptSearch('nginx - small, powerful web server\nnginx-common - common files\n')).toEqual([{ name: 'nginx', summary: 'small, powerful web server' }, { name: 'nginx-common', summary: 'common files' }]);
    expect(parseDnfSearch('=== Name Exactly Matched: nginx ===\nnginx.x86_64 : A high performance web server\nnginx-core.x86_64 : core\nnginx.x86_64 : dup\n')).toEqual([{ name: 'nginx', summary: 'A high performance web server' }, { name: 'nginx-core', summary: 'core' }]);
  });

  it('parses upgrade simulations', () => {
    const apt = parseAptSimulation('Reading package lists...\nInst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-security [amd64])\nInst vim (2:9.1 Ubuntu:24.04/noble-updates [amd64])\nConf libssl3 (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-security [amd64])\n');
    expect(apt).toHaveLength(2);
    expect(apt[0]).toMatchObject({ name: 'libssl3', current: '3.0.2-0ubuntu1.10', candidate: '3.0.2-0ubuntu1.12', security: true });
    expect(apt[1]).toMatchObject({ name: 'vim', current: null, security: false });
    const dnf = parseDnfCheckUpdate('\nopenssl-libs.x86_64    1:3.0.7-24.el9    baseos\nkernel.x86_64          5.14.0-362.el9    baseos\nObsoleting Packages\nfoo.x86_64  1  appstream\n');
    expect(dnf.map((p) => p.name)).toEqual(['openssl-libs', 'kernel']);
    expect(parseAptPolicy('curl:\n  Installed: (none)\n  Candidate: 8.5.0\n')).toEqual({ installed: null, candidate: '8.5.0' });
  });

  it('parses pecl, gem and perl lists', () => {
    expect(parsePeclList('Installed packages, channel pecl.php.net:\n=========================================\nPackage Version State\nredis   6.0.2   stable\nimagick 3.7.0   stable\n')).toEqual([{ name: 'redis', version: '6.0.2', state: 'stable' }, { name: 'imagick', version: '3.7.0', state: 'stable' }]);
    expect(parseGemList('\n*** LOCAL GEMS ***\n\nbundler (default: 2.5.3)\nrake (13.1.0, 13.0.6)\n')).toEqual([{ name: 'bundler', version: '2.5.3', versions: ['2.5.3'] }, { name: 'rake', version: '13.1.0', versions: ['13.1.0', '13.0.6'] }]);
    expect(parsePerlModules('DBD::mysql\t4.050\nJSON::XS\t\nPerl\n')).toEqual([{ name: 'DBD::mysql', version: '4.050' }, { name: 'JSON::XS', version: null }]);
    // ExtUtils::Installed reports the interpreter as "Perl\t<version>"; it is not a CPAN module.
    expect(parsePerlModules('Perl\t5.38.2\nDBI\t1.643\n')).toEqual([{ name: 'DBI', version: '1.643' }]);
  });

  it('reads and rewrites ini directives without touching sections or comments', () => {
    const ini = '[PHP]\n; memory_limit = 64M\nmemory_limit = 128M\nupload_max_filesize = 2M ; comment\n;display_errors = On\ndate.timezone = "Europe/Berlin"\n[Session]\nsession.save_path = "/var/lib/php/sessions"\n';
    expect(parseIni(ini)).toEqual({ memory_limit: '128M', upload_max_filesize: '2M', 'date.timezone': 'Europe/Berlin', 'session.save_path': '/var/lib/php/sessions' });
    const next = setIniDirectives(ini, { memory_limit: '256M', display_errors: 'Off', max_input_vars: '5000', upload_max_filesize: null, 'date.timezone': 'UTC' });
    expect(next).toContain('memory_limit = 256M');
    expect(next).not.toContain('memory_limit = 128M');
    expect(next).toContain(';display_errors = On\ndisplay_errors = Off');
    expect(next).not.toContain('upload_max_filesize');
    expect(next.trim().endsWith('max_input_vars = 5000')).toBe(true);
    expect(parseIni(next)['date.timezone']).toBe('UTC');
    expect(parseIni(next)['session.save_path']).toBe('/var/lib/php/sessions');
    expect(setIniDirectives('', { disable_functions: 'exec, system' })).toBe('disable_functions = "exec, system"\n');
  });

  it('parses FPM pools', () => {
    expect(parseFpmPool('[www]\nuser = www-data\ngroup = www-data\nlisten = /run/php/php8.3-fpm.sock\npm = dynamic\npm.max_children = 5\n', '/etc/php/8.3/fpm/pool.d/www.conf')).toMatchObject({ name: 'www', user: 'www-data', listen: '/run/php/php8.3-fpm.sock', pm: 'dynamic', maxChildren: 5 });
  });

  it('renders a valid-looking proxy config and reads its header back', () => {
    const conf = renderNginxProxy({ apachePort: 8080, cache: true, cacheMaxSizeMb: 512, cacheTtl: '5m', domains: [{ domain: 'example.com', aliases: ['www.example.com'], ssl: { cert: '/etc/ssl/whm/example.com/fullchain.pem', key: '/etc/ssl/whm/example.com/key.pem' } }, { domain: 'plain.example.net', aliases: [] }] });
    expect(conf).toContain('proxy_pass http://127.0.0.1:8080;');
    expect(conf).toContain('proxy_cache_path /var/cache/nginx/whm');
    expect(conf).toContain('max_size=512m');
    expect(conf).toContain('proxy_cache_valid 200 301 302 5m;');
    expect(conf).toContain('server_name example.com www.example.com;');
    expect(conf).toContain('ssl_certificate /etc/ssl/whm/example.com/fullchain.pem;');
    expect(conf).not.toContain('server_name plain.example.net');
    expect((conf.match(/^server \{/gm) || []).length).toBe(2);
    expect(parseProxyHeader(conf)).toMatchObject({ version: 1, apachePort: 8080, cache: true, domains: 2 });
    const plain = renderNginxProxy({ apachePort: 8081, cache: false });
    expect(plain).not.toContain('proxy_cache');
    expect(parseProxyHeader(plain)).toMatchObject({ apachePort: 8081, cache: false, domains: 0 });
    expect(parseProxyHeader('server {}')).toBeNull();
  });
});
