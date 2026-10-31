import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import {
  renderVhost, parseVhostMeta, renderRedirects, renderGlobalInclude, renderPhpPool, renderLogrotate, mergeKeyValueFile, renderProftpd, vsftpdSettings, pureFtpdSettings,
  ftpSettingsFrom, parseServerStatus, parseApacheVersion, parseModules, parseDoveconf, rewriteListen, apacheLayout, eximLayout, phpLayout, SERVICE_ROLES, hintsFor, ensureRootLogDir, confPath, parseEximVersion,
  mergeEximBlock, readEximBlock, stripEximBlock, eximTlsLibrary, primaryGroupName, EXIM_SENTINEL_MACRO, renderHttpsRedirect, enableApacheModules,
  applyListen, listenDropIns, ensureSelinuxWebAccess, selinuxRules, DOMLOGS_ROOT, unitState, DOCROOT_OPTIONS, DOCROOT_ALLOW_OVERRIDE,
  reconcileHtaccessOptions, HTACCESS_OPTIONS,
  renderDefaultVhost, parseDefaultVhostMeta, writeDefaultVhost, removeDefaultVhost, defaultVhostFile, DEFAULT_SSL_FALLBACKS, DEFAULT_VHOST_NAMES,
} from '../src/ops/web.js';

// Fake host for the layout detection: which paths exist, what they contain, which binaries resolve.
function hostIo({ files = {}, dirs = [], binaries = [] }) {
  return { exists: (p) => dirs.includes(p) || p in files, readText: (p) => (p in files ? files[p] : null), hasBinary: (b) => binaries.includes(b) };
}

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});

const ctx = createContext();
const VHOST = { domain: 'example.com', aliases: ['parked.net'], docroot: '/home/alice/public_html', user: 'alice', ip: '203.0.113.5', redirects: [], customDirectives: '', meta: {}, port: 80, sslPort: 443 };

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('web op schemas reject injection and traversal before anything runs', () => {
  it('unknown ops are refused', async () => {
    expect((await opError(runOp('web.nope', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('web.vhost.delete_all', {}, ctx))).code).toBe('unknown_op');
  });

  it('vhost arguments: domains, users, paths, ips, php versions, redirects', async () => {
    exec.mockClear();
    const bad = [
      { ...VHOST, domain: '-r' }, { ...VHOST, domain: 'a;b.com' }, { ...VHOST, domain: '../etc' }, { ...VHOST, domain: 'exa mple.com' },
      { ...VHOST, user: '-R' }, { ...VHOST, user: 'root;id' }, { ...VHOST, user: 'Alice' },
      { ...VHOST, docroot: 'public_html' }, { ...VHOST, docroot: '/home/alice/../../etc' }, { ...VHOST, docroot: '/home/alice\0x' },
      { ...VHOST, ip: '203.0.113.5; rm -rf /' }, { ...VHOST, ip: 'not-an-ip' }, { ...VHOST, ipv6: '203.0.113.5' },
      { ...VHOST, aliases: ['bad alias'] }, { ...VHOST, aliases: ['-x.com'] },
      { ...VHOST, phpVersion: '8.3; id' }, { ...VHOST, phpVersion: 'ea-php83' }, { ...VHOST, phpVersion: '../8.3' },
      { ...VHOST, redirects: [{ to: 'javascript:alert(1)' }] }, { ...VHOST, redirects: [{ to: 'https://x.com/"><script>' }] }, { ...VHOST, redirects: [{ from: '../x', to: 'https://x.com' }] }, { ...VHOST, redirects: [{ to: 'https://x.com', type: '999' }] },
      { ...VHOST, ssl: { cert: 'relative/cert.pem', key: '/etc/ssl/whm/k.pem' } }, { ...VHOST, ssl: { cert: '/etc/ssl/whm/c.pem' } },
      { ...VHOST, logDir: '/home/alice/../../var/log' }, { ...VHOST, serverAdmin: 'not-an-email' }, { ...VHOST, options: 'Indexes; rm' },
      { ...VHOST, options: '-Indexes +FollowSymLinks' }, { ...VHOST, options: 'FollowSymLinks' }, { ...VHOST, options: '+followsymlinks' },
      { ...VHOST, meta: { 'bad key': 'x' } }, { ...VHOST, extra: true }, { ...VHOST, port: 70000 },
      // Paths are rendered into a root-parsed config: no directive injection through newlines, quotes or spaces.
      { ...VHOST, docroot: '/home/alice/x\nCustomLog |/home/alice/evil.sh combined\n<Directory /x' }, { ...VHOST, docroot: '/home/alice/my site' }, { ...VHOST, docroot: '/home/alice/"x' }, { ...VHOST, docroot: "/home/alice/'x" }, { ...VHOST, docroot: '/home/alice/x\tt' },
      { ...VHOST, ssl: { cert: '/etc/ssl/whm/c pem', key: '/etc/ssl/whm/k.pem' } }, { ...VHOST, ssl: { cert: '/etc/ssl/whm/c.pem', key: '/etc/ssl/whm/k.pem', fullchain: '/etc/ssl/whm/f.pem\n' } },
      { ...VHOST, logDir: '/var/log/whm/domlogs/alice\n' }, { ...VHOST, logDir: '/var/log/whm/domlogs/alice;x' },
      { ...VHOST, bind: 'localhost' }, { ...VHOST, bind: '127.0.0.1:8080' }, { ...VHOST, sslPort: 0 },
      { ...VHOST, redirectHttps: 'yes' }, { ...VHOST, redirectHttps: 1 },
    ];
    for (const args of bad) expect((await opError(runOp('web.vhost.write', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    for (const domain of ['-r', 'a;b', '../x', 'a b']) {
      expect((await opError(runOp('web.vhost.remove', { domain }, ctx))).code).toBe('invalid_args');
      expect((await opError(runOp('web.vhost.read', { domain }, ctx))).code).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('vhost paths are pinned to allowed roots before the daemon is even consulted', async () => {
    exec.mockClear();
    expect((await opError(runOp('web.vhost.write', { ...VHOST, docroot: '/etc/passwd' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('web.vhost.write', { ...VHOST, ssl: { cert: '/etc/shadow', key: '/etc/ssl/whm/k.pem' } }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('web.vhost.write', { ...VHOST, ssl: { cert: '/etc/ssl/whm/c.pem', key: '/etc/ssl/whm/k.pem', chain: '/root/.bash_history' } }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('web.vhost.write', { ...VHOST, logDir: '/var/log/syslog.d' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('web.phpfpm.pool.write', { user: 'alice', version: '8.3', errorLog: '/etc/shadow' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('web.phpfpm.pool.write', { user: 'alice', version: '8.3', tmpDir: '/dev/shm' }, ctx))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
    for (const p of ['/home/alice/public_html', '/home/alice/public_html/shop.example.com', '/etc/ssl/whm/example.com/fullchain.pem', '/var/log/whm/domlogs/alice']) expect(confPath.safeParse(p).success, p).toBe(true);
    for (const p of ['relative', '/a b', '/a"b', '/a\\b', '/a:b', '/a;b', '/a\nb', '/a/../b', '/a/..', '', '/a\0']) expect(confPath.safeParse(p).success, JSON.stringify(p)).toBe(false);
  });

  it('status probes only a valid port/bind address', async () => {
    exec.mockClear();
    expect((await opError(runOp('web.status', { port: 0 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.status', { port: 8080, bind: 'localhost' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.status', { port: 8080, bind: '127.0.0.1; id' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.status', { host: '127.0.0.1' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('global directives, MPM and ports', async () => {
    exec.mockClear();
    const bad = [
      { directives: { timeout: 0 } }, { directives: { timeout: 'abc' } }, { directives: { serverTokens: 'Prod; rm' } }, { directives: { directoryIndex: ['index.php; id'] } }, { directives: { directoryIndex: ['../index'] } },
      { directives: { serverAdmin: 'x' } }, { directives: { mpm: { module: 'threaded' } } }, { directives: { mpm: { maxRequestWorkers: -1 } } }, { directives: { fileETag: 'Everything' } }, { directives: { customDirectives: 'a\0b' } }, { directives: { unknown: 1 } }, { directives: {}, dryRun: 'yes' },
    ];
    for (const args of bad) expect((await opError(runOp('web.global.write', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    expect((await opError(runOp('web.mpm.set', { module: 'prefork; reboot' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.mpm.set', { module: 'itk' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.ports.set', { http: 0 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.ports.set', { http: '8080' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.ports.set', { http: 8080, bind: 'lo' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.ports.set', { http: 8080, bind: '127.0.0.1; reboot' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('module names must be plain a2enmod names, at most ten, never flags or paths', async () => {
    exec.mockClear();
    for (const modules of [['-m'], ['Rewrite'], ['proxy fcgi'], ['x;y'], ['../ssl'], ['rewrite\n'], [''], [], Array.from({ length: 11 }, (_, i) => `m${i}`), 'rewrite', [{ name: 'rewrite' }]]) {
      expect((await opError(runOp('web.module.enable', { modules }, ctx))).code, JSON.stringify(modules)).toBe('invalid_args');
    }
    expect((await opError(runOp('web.module.enable', { modules: ['rewrite'], reload: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.module.enable', {}, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('php-fpm pools', async () => {
    exec.mockClear();
    const ok = { user: 'alice', version: '8.3' };
    const bad = [{ ...ok, user: '-u' }, { ...ok, user: 'a;b' }, { ...ok, version: '8.3;id' }, { ...ok, version: 'ea-php83' }, { ...ok, pm: 'forever' }, { ...ok, maxChildren: 0 }, { ...ok, memoryLimit: '256M; rm' }, { ...ok, memoryLimit: '1T' }, { ...ok, openBasedir: ['/home/alice/../../'] }, { ...ok, openBasedir: ['/home/alice:/etc'] }, { ...ok, openBasedir: ['/home/alice\nphp_admin_value[disable_functions] ='] }, { ...ok, errorLog: 'logs/php.log' }, { ...ok, errorLog: '/home/alice/logs/php error.log' }, { ...ok, tmpDir: '/tmp/x\0' }, { ...ok, extra: 1 }];
    for (const args of bad) expect((await opError(runOp('web.phpfpm.pool.write', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    expect((await opError(runOp('web.phpfpm.pool.remove', { user: '../x', version: '8.3' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('ftp settings and daemon selection', async () => {
    exec.mockClear();
    const bad = [
      { server: 'wu-ftpd', settings: {} }, { server: 'pure-ftpd; id', settings: {} }, { server: 'vsftpd', settings: { passivePortMin: 80 } }, { server: 'vsftpd', settings: { passivePortMin: 60000, passivePortMax: 50000 } },
      { server: 'vsftpd', settings: { passiveAddress: '1.2.3.4\nanonymous_enable=YES' } }, { server: 'proftpd', settings: { tls: 'maybe' } }, { server: 'proftpd', settings: { maxClients: 'many' } }, { server: 'pure-ftpd', settings: { idleTimeoutMinutes: 0 } }, { server: 'pure-ftpd', settings: { rm: true } },
    ];
    for (const args of bad) expect((await opError(runOp('web.ftp.config.write', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    expect((await opError(runOp('web.ftp.config.read', { server: '../vsftpd' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.service.detect', { role: 'mail' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.service.select', { role: 'ftp', server: 'vsftpd; reboot' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.service.select', { role: 'ftp', server: '../x' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.service.select', { role: 'dns', server: 'unbound' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('logrotate policies stay inside /etc/logrotate.d and only reference log paths', async () => {
    exec.mockClear();
    const ok = { name: 'accounts', paths: ['/home/*/logs/*.log'] };
    const stanza = { paths: ['/home/alice/logs/*.log'], su: { user: 'alice', group: 'alice' }, postrotate: 'none' };
    const bad = [{ ...ok, name: '../cron' }, { ...ok, name: 'Apache' }, { ...ok, name: 'a b' }, { ...ok, name: '-x' }, { ...ok, paths: ['/home/../etc/passwd'] }, { ...ok, paths: ['relative/*.log'] }, { ...ok, paths: ['/var/log/x.log; rm -rf /'] }, { ...ok, paths: [] }, { ...ok, frequency: 'always' }, { ...ok, rotate: -1 }, { ...ok, maxSize: '10 M' }, { ...ok, postrotate: 'rm -rf /' }, { ...ok, create: { mode: '0644', owner: 'root; id', group: 'adm' } }, { ...ok, su: { user: 'root', group: 'adm;x' } },
      { ...ok, stanzas: [{ ...stanza, su: { user: 'alice; id', group: 'alice' } }] }, { ...ok, stanzas: [{ ...stanza, su: { user: 'Alice', group: 'alice' } }] }, { ...ok, stanzas: [{ ...stanza, paths: ['/home/alice/../../etc/*.log'] }] }, { ...ok, stanzas: [{ ...stanza, paths: [] }] }, { ...ok, stanzas: [{ ...stanza, postrotate: 'reboot' }] }, { ...ok, stanzas: [{ ...stanza, extra: 1 }] }, { ...ok, stanzas: 'x' }];
    for (const args of bad) expect((await opError(runOp('web.logrotate.write', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    for (const name of ['../x', 'UPPER', 'a b']) {
      expect((await opError(runOp('web.logrotate.read', { name }, ctx))).code).toBe('invalid_args');
      expect((await opError(runOp('web.logrotate.remove', { name }, ctx))).code).toBe('invalid_args');
      expect((await opError(runOp('web.logrotate.run', { name }, ctx))).code).toBe('invalid_args');
    }
    expect((await opError(runOp('web.logrotate.write', { ...ok, paths: ['/etc/shadow'] }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('web.logrotate.write', { ...ok, stanzas: [{ ...stanza, paths: ['/etc/cron.daily/*'] }] }, ctx))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
  });

  it('dovecot and exim includes', async () => {
    exec.mockClear();
    expect((await opError(runOp('web.dovecot.include.write', { content: 'a\0b' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.dovecot.include.write', { content: 'ssl = yes', path: '/etc/passwd' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.exim.include.write', { slot: 'routers', content: 'x' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.exim.include.write', { slot: '../main', content: 'x' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.exim.include.remove', { slot: 'main', force: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('daemon-backed ops report capability_missing on a host without the daemon', async () => {
    if (apacheLayout()?.bin) return;
    for (const [name, args] of [['web.configtest', {}], ['web.vhost.write', VHOST], ['web.global.write', { directives: { timeout: 30 } }], ['web.mpm.set', { module: 'event' }], ['web.module.enable', { modules: ['rewrite'] }]]) {
      expect((await opError(runOp(name, args, ctx))).code, name).toBe('capability_missing');
    }
    if (!eximLayout()?.installed) expect((await opError(runOp('web.exim.include.write', { slot: 'main', content: 'x' }, ctx))).code).toBe('capability_missing');
    if (!phpLayout().versions.some((v) => v.version === '7.0')) expect((await opError(runOp('web.phpfpm.pool.write', { user: 'root', version: '7.0' }, ctx))).code).toBe('capability_missing');
  });
});

// Runs before any op touches the host, so the unit cache inside web.js is
// still empty and the mocked `systemctl list-unit-files` answer is what
// reloadUnit sees.
describe('web.module.enable enables what is off, validates, rolls back and reloads', () => {
  const DEBIAN = { flavor: 'debian', root: '/etc/apache2', bin: 'apache2ctl', units: ['apache2'], a2tools: true };
  const RHEL = { flavor: 'rhel', root: '/etc/httpd', bin: 'httpd', units: ['httpd'], a2tools: false };
  const calls = () => exec.mock.calls.map(([bin, argv]) => [bin, ...argv]);

  async function withHost(binaries, answer, fn) {
    const { hasBinary } = await import('../src/exec.js');
    const actual = await vi.importActual('../src/exec.js');
    hasBinary.mockImplementation((name) => binaries.includes(name));
    exec.mockClear();
    exec.mockImplementation(async (bin, argv) => ({ code: 0, stdout: '', stderr: '', bin, argv, ...answer(bin, argv) }));
    try { await fn(); } finally { hasBinary.mockImplementation(actual.hasBinary); exec.mockImplementation(actual.exec); }
  }

  const apacheAnswers = (bin, argv) => {
    if (bin === 'apache2ctl' && argv[0] === '-V') return { stdout: 'Server version: Apache/2.4.58 (Ubuntu)\nServer MPM:     event\n' };
    if (bin === 'apache2ctl' && argv[0] === '-M') return { stdout: 'Loaded Modules:\n core_module (static)\n ssl_module (shared)\n' };
    if (bin === 'systemctl' && argv[0] === 'list-unit-files') return { stdout: 'apache2.service enabled enabled\nssh.service enabled enabled\n' };
    return {};
  };

  it('debian: a2query decides, a2enmod runs only for modules that are off, configtest precedes the reload', async () => {
    await withHost(['a2enmod', 'a2query', 'a2dismod', 'apache2ctl', 'systemctl'], (bin, argv) => {
      if (bin === 'a2query') return { code: argv[2] === 'headers' ? 0 : 1 };
      if (bin === 'a2enmod') return argv[1] === 'nope' ? { code: 1, stderr: 'ERROR: Module nope does not exist!\n' } : {};
      if (bin === 'apache2ctl' && argv[0] === '-t') return { stderr: 'Syntax OK\n' };
      return apacheAnswers(bin, argv);
    }, async () => {
      const result = await enableApacheModules(DEBIAN, ['rewrite', 'ssl', 'headers', 'nope']);
      expect(result).toMatchObject({ skipped: false, flavor: 'debian', enabled: ['rewrite'], alreadyEnabled: ['ssl', 'headers'], missing: ['nope'], validated: true, reloaded: true, unit: 'apache2' });
      expect(result.failed).toEqual([{ module: 'nope', error: 'ERROR: Module nope does not exist!' }]);
      const c = calls();
      expect(c).toContainEqual(['a2enmod', '-q', 'rewrite']);
      expect(c).toContainEqual(['a2enmod', '-q', 'nope']);
      expect(c).not.toContainEqual(['a2enmod', '-q', 'ssl']);
      expect(c).not.toContainEqual(['a2enmod', '-q', 'headers']);
      expect(c.filter(([bin]) => bin === 'a2query').map((x) => x[3])).toEqual(['rewrite', 'headers', 'nope']);
      expect(c).toContainEqual(['apache2ctl', '-t']);
      expect(c).toContainEqual(['systemctl', 'reload-or-restart', 'apache2.service']);
      expect(c.findIndex(([bin, a]) => bin === 'apache2ctl' && a === '-t')).toBeLessThan(c.findIndex(([bin, verb]) => bin === 'systemctl' && verb === 'reload-or-restart'));
      expect(c.some(([bin]) => bin === 'a2dismod')).toBe(false);
    });
  });

  it('debian: nothing to enable means no configtest and no reload', async () => {
    await withHost(['a2enmod', 'a2query', 'apache2ctl', 'systemctl'], (bin, argv) => (bin === 'a2query' ? { code: 0 } : apacheAnswers(bin, argv)), async () => {
      const result = await enableApacheModules(DEBIAN, ['ssl', 'rewrite']);
      expect(result).toMatchObject({ skipped: false, enabled: [], alreadyEnabled: ['ssl', 'rewrite'], failed: [], reloaded: false, validated: null });
      expect(calls().some(([bin, a]) => (bin === 'apache2ctl' && a === '-t') || bin === 'systemctl' && a !== 'list-unit-files')).toBe(false);
    });
  });

  it('debian: a failed configtest disables exactly what was switched on and never reloads', async () => {
    await withHost(['a2enmod', 'a2query', 'a2dismod', 'apache2ctl', 'systemctl'], (bin, argv) => {
      if (bin === 'a2query') return { code: argv[2] === 'headers' ? 0 : 1 };
      if (bin === 'apache2ctl' && argv[0] === '-t') return { code: 1, stderr: 'AH00526: Syntax error on line 3 of /etc/apache2/mods-enabled/suexec.load:\nCannot load mod_suexec.so\n' };
      return apacheAnswers(bin, argv);
    }, async () => {
      const err = await opError(enableApacheModules(DEBIAN, ['rewrite', 'headers', 'suexec']));
      expect(err.code).toBe('config_invalid');
      expect(err.message).toMatch(/disabled again/);
      expect(err.details).toMatchObject({ enabled: ['rewrite', 'suexec'], rolledBack: ['rewrite', 'suexec'] });
      const c = calls();
      expect(c.filter(([bin]) => bin === 'a2dismod')).toEqual([['a2dismod', '-q', '-f', 'rewrite'], ['a2dismod', '-q', '-f', 'suexec']]);
      expect(c.findIndex(([bin]) => bin === 'a2dismod')).toBeGreaterThan(c.findIndex(([bin, a]) => bin === 'apache2ctl' && a === '-t'));
      expect(c.some(([bin, verb]) => bin === 'systemctl' && verb === 'reload-or-restart')).toBe(false);
    });
  });

  it('debian without a2enmod/a2query reports capability_missing before running anything', async () => {
    await withHost(['apache2ctl', 'systemctl'], apacheAnswers, async () => {
      expect((await opError(enableApacheModules(DEBIAN, ['rewrite']))).code).toBe('capability_missing');
      expect(calls().some(([bin]) => bin === 'a2enmod' || bin === 'a2dismod')).toBe(false);
    });
  });

  it('rhel: verifies against httpd -M, reports the conf.modules.d hint and touches nothing', async () => {
    await withHost(['httpd', 'systemctl'], (bin, argv) => (bin === 'httpd' && argv[0] === '-M' ? { stdout: 'Loaded Modules:\n core_module (static)\n rewrite_module (shared)\n' } : {}), async () => {
      const result = await enableApacheModules(RHEL, ['rewrite', 'headers']);
      expect(result).toMatchObject({ skipped: true, flavor: 'rhel', enabled: [], alreadyEnabled: ['rewrite'], missing: ['headers'], failed: [], reloaded: false });
      expect(result.reason).toMatch(/\/etc\/httpd\/conf\.modules\.d/);
      expect(result.reason).toMatch(/mod_headers/);
      expect(result.reason).toMatch(/reload httpd/);
      expect(calls().every(([bin]) => bin === 'httpd')).toBe(true);
      const all = await enableApacheModules(RHEL, ['rewrite']);
      expect(all).toMatchObject({ skipped: true, missing: [], reason: expect.stringMatching(/already loaded/) });
    });
  });
});

describe('renderers produce the expected daemon syntax', () => {
  it('renders a vhost with aliases, logs, PHP-FPM handler, redirects and an SSL block', () => {
    const text = renderVhost({ ...VHOST, ipv6: '2001:db8::5', phpVersion: '8.3', logDir: '/home/alice/logs', redirects: [{ from: '/', to: 'https://new.example.com', type: '301', matchWww: true, keepPath: true }, { from: '/old', to: 'https://x.org/landing', type: '302', matchWww: false, keepPath: false }], ssl: { cert: '/etc/ssl/whm/example.com/cert.pem', key: '/etc/ssl/whm/example.com/key.pem', fullchain: '/etc/ssl/whm/example.com/fullchain.pem' }, customDirectives: 'Header set X-Test "1"', meta: { account: 'alice', type: 'main' } });
    expect(text).toContain('<VirtualHost 203.0.113.5:80 [2001:db8::5]:80>');
    expect(text).toContain('ServerName example.com');
    expect(text).toContain('ServerAlias www.example.com parked.net');
    expect(text).toContain('DocumentRoot "/home/alice/public_html"');
    expect(text).toContain('CustomLog "/home/alice/logs/example.com-access.log" combined');
    expect(text).toContain('UserDir disabled');
    expect(text).toContain('SetHandler "proxy:unix:/run/php/php8.3-fpm-alice.sock|fcgi://localhost"');
    // Basic auth reaches PHP-FPM on the plain and the TLS vhost alike.
    expect(text.match(/SetEnvIf Authorization "\(\.\*\)" HTTP_AUTHORIZATION=\$1/g)).toHaveLength(2);
    expect(renderVhost({ ...VHOST, phpVersion: '8.3' }).match(/SetEnvIf Authorization/g)).toHaveLength(1);
    expect(renderVhost(VHOST)).not.toContain('SetEnvIf Authorization');
    expect(text).toContain('RedirectMatch 301 "^/?(.*)$" "https://new.example.com/$1"');
    expect(text).toContain('<If "%{HTTP_HOST} !~ /^www\\./i">');
    expect(text).toContain('RedirectMatch 302 "^/old" "https://x.org/landing"');
    expect(text).toContain('<VirtualHost 203.0.113.5:443 [2001:db8::5]:443>');
    expect(text).toContain('SSLCertificateFile "/etc/ssl/whm/example.com/fullchain.pem"');
    expect(text).toContain('SSLCertificateKeyFile "/etc/ssl/whm/example.com/key.pem"');
    expect(text).toContain('  Header set X-Test "1"');
    expect(text).not.toContain('SuexecUserGroup');
    // Account docroots never follow links into other accounts' www-data-readable
    // files, and .htaccess cannot turn FollowSymLinks, ExecCGI or full SSI back on.
    expect(DOCROOT_OPTIONS).toBe('-Indexes +SymLinksIfOwnerMatch');
    expect(DOCROOT_ALLOW_OVERRIDE).toBe('AuthConfig FileInfo Indexes Limit Options=Indexes,MultiViews,SymLinksIfOwnerMatch,IncludesNOEXEC');
    expect(text.match(/<Directory "\/home\/alice\/public_html">\n    Options -Indexes \+SymLinksIfOwnerMatch\n    AllowOverride AuthConfig FileInfo Indexes Limit Options=Indexes,MultiViews,SymLinksIfOwnerMatch,IncludesNOEXEC\n    Require all granted\n  <\/Directory>/g)).toHaveLength(2);
    expect(text).not.toMatch(/FollowSymLinks|AllowOverride All/);
    expect(renderVhost({ ...VHOST, options: '+Indexes +SymLinksIfOwnerMatch' })).toContain('    Options +Indexes +SymLinksIfOwnerMatch\n    AllowOverride AuthConfig FileInfo');
    expect(() => renderVhost({ ...VHOST, options: '-Indexes +FollowSymLinks' })).toThrow(OpError);
    const meta = parseVhostMeta(text);
    expect(meta).toMatchObject({ domain: 'example.com', user: 'alice', ssl: true, redirects: 2, account: 'alice', type: 'main', phpVersion: '8.3' });
    expect(renderVhost(VHOST)).not.toContain('SSLEngine');
    expect(renderVhost({ ...VHOST, ip: null })).toContain('<VirtualHost *:80>');
    expect(renderVhost(VHOST)).toContain('CustomLog "/var/log/whm/domlogs/alice/example.com-access.log" combined');
    expect(renderRedirects([{ from: '/a.b', to: 'https://t/', type: 'permanent', matchWww: true, keepPath: true }])).toEqual(['  RedirectMatch 301 "^/a\\.b/?(.*)$" "https://t/$1"']);
  });

  it('redirectHttps adds a mod_rewrite block to the plain vhost only, keyed on the scheme Apache can see', () => {
    const ssl = { cert: '/etc/ssl/whm/example.com/cert.pem', key: '/etc/ssl/whm/example.com/key.pem', fullchain: '/etc/ssl/whm/example.com/fullchain.pem' };
    const direct = renderVhost({ ...VHOST, ssl, redirectHttps: true, redirects: [{ from: '/old', to: 'https://x.org/landing', type: '302', matchWww: true, keepPath: false }] });
    const [plain, tls] = direct.split('<IfModule ssl_module>');
    expect(plain).toContain([
      '  # Redirect HTTP to HTTPS (Apache Configuration: web.force_https)',
      '  <IfModule mod_rewrite.c>',
      '    RewriteEngine On',
      '    RewriteCond %{HTTPS} off',
      '    RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/',
      '    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]',
      '  </IfModule>',
    ].join('\n'));
    expect(plain).not.toContain('X-Forwarded-Proto');
    // The redirect precedes the domain forwarding and the Application Manager include, and the TLS block has none of it.
    expect(plain.indexOf('RewriteRule ^ https://')).toBeLessThan(plain.indexOf('RedirectMatch 302'));
    expect(plain.indexOf('RewriteRule ^ https://')).toBeLessThan(plain.indexOf('IncludeOptional'));
    expect(tls).not.toContain('RewriteEngine');
    expect(tls).not.toContain('RewriteCond');
    expect(parseVhostMeta(direct)).toMatchObject({ ssl: true, redirectHttps: true });
    // Behind nginx Apache never terminates TLS itself: the forwarded scheme decides.
    const proxied = renderVhost({ ...VHOST, bind: '127.0.0.1', port: 8080, sslPort: null, ssl, redirectHttps: true });
    expect(proxied).toContain('    RewriteCond %{HTTP:X-Forwarded-Proto} !=https');
    expect(proxied).not.toContain('%{HTTPS} off');
    expect(proxied).toContain('    RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/');
    expect(proxied.match(/RewriteEngine On/g)).toHaveLength(1);
    expect(parseVhostMeta(proxied)).toMatchObject({ bind: '127.0.0.1', ssl: false, redirectHttps: true });
    // Off by default and when unset: the block never appears.
    expect(renderVhost({ ...VHOST, ssl })).not.toContain('RewriteEngine');
    expect(renderVhost({ ...VHOST, ssl, redirectHttps: false })).not.toContain('mod_rewrite');
    expect(parseVhostMeta(renderVhost({ ...VHOST, ssl }))).toMatchObject({ redirectHttps: false });
    expect(renderHttpsRedirect('::1')).toContain('    RewriteCond %{HTTP:X-Forwarded-Proto} !=https');
    expect(renderHttpsRedirect(null)[3]).toBe('    RewriteCond %{HTTPS} off');
  });

  it('a bind address replaces the account IPs so proxied requests to 127.0.0.1:8080 match; a null sslPort drops the TLS block', () => {
    const ssl = { cert: '/etc/ssl/whm/example.com/cert.pem', key: '/etc/ssl/whm/example.com/key.pem' };
    const proxied = renderVhost({ ...VHOST, ipv6: '2001:db8::5', bind: '127.0.0.1', port: 8080, sslPort: null, ssl });
    expect(proxied).toContain('<VirtualHost 127.0.0.1:8080>');
    expect(proxied.match(/^<VirtualHost .*$/gm)).toEqual(['<VirtualHost 127.0.0.1:8080>']);
    expect(proxied).not.toContain('SSLEngine');
    expect(proxied).toContain('TLS is terminated by the reverse proxy');
    expect(parseVhostMeta(proxied)).toMatchObject({ bind: '127.0.0.1', ssl: false });
    const v6 = renderVhost({ ...VHOST, bind: '::1', port: 8080, sslPort: 8443, ssl });
    expect(v6).toContain('<VirtualHost [::1]:8080>');
    expect(v6).toContain('<VirtualHost [::1]:8443>');
    expect(v6).toContain('SSLEngine on');
    // The renderer refuses, rather than rewrites, anything that would break out of a quoted directive.
    expect(() => renderVhost({ ...VHOST, docroot: '/home/alice/pub"lic' })).toThrow(OpError);
    expect(() => renderVhost({ ...VHOST, docroot: '/home/alice/x\nServerAlias evil' })).toThrow(OpError);
    expect(() => renderVhost({ ...VHOST, ssl: { cert: '/etc/ssl/whm/c pem', key: ssl.key } })).toThrow(OpError);
  });

  it('per-domain log directories are created root-owned and symlinks or foreign ownership are refused', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-domlogs-'));
    try {
      const dir = ensureRootLogDir(path.join(base, 'nested', 'alice'), process.getgid());
      const st = fs.statSync(dir);
      expect(st.isDirectory()).toBe(true);
      expect(st.mode & 0o777).toBe(0o750);
      expect(fs.statSync(path.join(base, 'nested')).mode & 0o777).toBe(0o755);
      expect(ensureRootLogDir(dir, process.getgid())).toBe(dir);
      fs.symlinkSync('/etc', path.join(base, 'link'));
      expect(() => ensureRootLogDir(path.join(base, 'link'), 0)).toThrow(/not a directory/);
      fs.writeFileSync(path.join(base, 'file'), '');
      expect(() => ensureRootLogDir(path.join(base, 'file'), 0)).toThrow(/not a directory/);
      if (process.getuid() === 0) {
        fs.mkdirSync(path.join(base, 'tenant'));
        fs.chownSync(path.join(base, 'tenant'), 65534, 65534);
        expect(() => ensureRootLogDir(path.join(base, 'tenant'), 0)).toThrow(/not owned by root/);
      }
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('renders the global include with MPM block, mod_status and custom directives', () => {
    const text = renderGlobalInclude({ timeout: 120, keepAlive: false, maxKeepAliveRequests: 50, keepAliveTimeout: 3, serverTokens: 'Prod', serverSignature: 'Off', traceEnable: 'off', hostnameLookups: 'Off', directoryIndex: ['index.php', 'index.html'], fileETag: 'None', limitRequestBody: 0, serverStatus: true, mpm: { module: 'event', startServers: 2, minSpareThreads: 25, maxSpareThreads: 75, threadsPerChild: 25, maxRequestWorkers: 150, maxConnectionsPerChild: 0, minSpareServers: 5, maxSpareServers: 10 }, customDirectives: 'ServerName panel.example.com' });
    expect(text).toContain('Timeout 120');
    expect(text).toContain('KeepAlive Off');
    expect(text).toContain('DirectoryIndex index.php index.html');
    expect(text).toContain('<IfModule mpm_event_module>');
    expect(text).toContain('  ThreadsPerChild 25');
    expect(text).not.toContain('MinSpareServers');
    expect(text).toContain('SetHandler server-status');
    expect(text).toContain('Require local');
    expect(text).toContain('ServerName panel.example.com');
    const prefork = renderGlobalInclude({ mpm: { module: 'prefork', minSpareServers: 5, maxSpareServers: 10, threadsPerChild: 25 } });
    expect(prefork).toContain('<IfModule mpm_prefork_module>');
    expect(prefork).toContain('MinSpareServers 5');
    expect(prefork).not.toContain('ThreadsPerChild');
  });

  it('renders PHP-FPM pools per pm mode', () => {
    const base = { user: 'alice', version: '8.3', pm: 'ondemand', maxChildren: 10, processIdleTimeout: 10, maxRequests: 500, memoryLimit: '256M', uploadMaxFilesize: '64M', postMaxSize: '64M', maxExecutionTime: 120 };
    const text = renderPhpPool(base, { listenOwner: 'www-data', socket: '/run/php/php8.3-fpm-alice.sock', homeDir: '/home/alice' });
    expect(text).toContain('[alice]');
    expect(text).toContain('listen = /run/php/php8.3-fpm-alice.sock');
    expect(text).toContain('listen.owner = www-data');
    expect(text).toContain('pm = ondemand');
    expect(text).toContain('pm.process_idle_timeout = 10s');
    expect(text).toContain('php_admin_value[memory_limit] = 256M');
    expect(text).toContain('php_admin_value[error_log] = /home/alice/logs/php-error.log');
    expect(text).toContain('env[TMPDIR] = /home/alice/tmp');
    const dyn = renderPhpPool({ ...base, pm: 'dynamic', openBasedir: ['/home/alice', '/tmp'] }, { listenOwner: 'apache', socket: '/run/php-fpm/x.sock', homeDir: '/home/alice' });
    expect(dyn).toContain('pm.start_servers = 2');
    expect(dyn).toContain('pm.min_spare_servers = 2');
    expect(dyn).toContain('pm.max_spare_servers = 4');
    expect(dyn).toContain('php_admin_value[open_basedir] = /home/alice:/tmp');
    expect(dyn).not.toContain('process_idle_timeout');
  });

  it('renders logrotate policies with a fixed postrotate vocabulary', () => {
    const text = renderLogrotate({ name: 'accounts', paths: ['/home/*/logs/*.log'], frequency: 'daily', rotate: 14, compress: true, delaycompress: true, missingok: true, notifempty: true, dateext: false, copytruncate: false, maxSize: '100M', su: { user: 'root', group: 'root' }, postrotate: 'apache-reload', sharedscripts: true });
    expect(text).toMatch(/^# Managed by WHM panel/);
    expect(text).toContain('/home/*/logs/*.log {');
    expect(text).toContain('    su root root');
    expect(text).toContain('    daily');
    expect(text).toContain('    rotate 14');
    expect(text).toContain('    maxsize 100M');
    expect(text).toContain('    delaycompress');
    expect(text).toContain('    sharedscripts');
    expect(text).toContain('systemctl reload apache2.service');
    const plain = renderLogrotate({ name: 'panel', paths: ['/var/log/whm/*.log'], frequency: 'weekly', rotate: 4, compress: false, delaycompress: false, missingok: true, notifempty: false, dateext: true, copytruncate: true, postrotate: 'none', sharedscripts: true });
    expect(plain).toContain('    nocompress');
    expect(plain).toContain('    copytruncate');
    expect(plain).toContain('    dateext');
    expect(plain).not.toContain('postrotate');
    // Stanzas: one block per tenant directory, each rotated as its owner; the root block keeps the Apache reload.
    const multi = renderLogrotate({ name: 'accounts', paths: ['/var/log/whm/domlogs/*/*.log', '/home/alice/logs/*.log'], frequency: 'daily', rotate: 14, compress: true, delaycompress: true, missingok: true, notifempty: true, dateext: false, copytruncate: false, su: { user: 'root', group: 'root' }, postrotate: 'apache-reload', sharedscripts: true, stanzas: [{ paths: ['/var/log/whm/domlogs/*/*.log'], su: { user: 'root', group: 'root' }, postrotate: 'apache-reload' }, { paths: ['/home/alice/logs/*.log'], su: { user: 'alice', group: 'alice' }, postrotate: 'none' }] });
    expect(multi.match(/\{$/gm)).toHaveLength(2);
    expect(multi).toContain('/var/log/whm/domlogs/*/*.log {\n    su root root\n    daily');
    expect(multi).toContain('/home/alice/logs/*.log {\n    su alice alice\n    daily');
    expect(multi).not.toContain('/var/log/whm/domlogs/*/*.log /home/alice/logs/*.log {');
    expect(multi.match(/systemctl reload apache2\.service/g)).toHaveLength(1);
    expect(multi.indexOf('systemctl reload apache2.service')).toBeLessThan(multi.indexOf('/home/alice/logs/*.log {'));
  });

  it('parses the Exim version and compiled-in feature list from exim -bV', () => {
    const light = 'Exim version 4.96 #2 built 10-Mar-2023 11:10:44\nCopyright (c) University of Cambridge, 1995 - 2018\nSupport for: crypteq iconv() IPv6 PAM Perl GnuTLS move_frozen_messages Content_Scanning DANE DKIM DNSSEC Event OCSP PRDR SOCKS TCP_Fast_Open\nLookups (built-in): lsearch wildlsearch nwildlsearch iplsearch cdb dbm dbmjz dbmnz dnsdb dsearch nis nis0 passwd\n';
    expect(parseEximVersion(light)).toEqual({ version: '4.96', features: ['crypteq', 'iconv()', 'IPv6', 'PAM', 'Perl', 'GnuTLS', 'move_frozen_messages', 'Content_Scanning', 'DANE', 'DKIM', 'DNSSEC', 'Event', 'OCSP', 'PRDR', 'SOCKS', 'TCP_Fast_Open'] });
    expect(parseEximVersion(light).features).not.toContain('SPF');
    expect(parseEximVersion('Exim version 4.97 #2\nSupport for: crypteq DKIM DMARC SPF\n').features).toContain('SPF');
    expect(parseEximVersion('garbage')).toEqual({ version: null, features: null });
    expect(parseEximVersion('')).toEqual({ version: null, features: null });
  });

  it('ftp renderers: pure-ftpd keys, proftpd fragment, vsftpd key=value merge', () => {
    const s = { passivePortMin: 50000, passivePortMax: 50100, passiveAddress: '203.0.113.5', tls: 'required', maxClients: 50, maxPerIp: 8, anonymous: false, idleTimeoutMinutes: 15, chroot: true };
    expect(pureFtpdSettings(s)).toEqual({ PassivePortRange: '50000 50100', ForcePassiveIP: '203.0.113.5', TLS: '2', MaxClientsNumber: '50', MaxClientsPerIP: '8', NoAnonymous: 'yes', MaxIdleTime: '15', ChrootEveryone: 'yes' });
    const pro = renderProftpd(s);
    expect(pro).toContain('PassivePorts 50000 50100');
    expect(pro).toContain('MasqueradeAddress 203.0.113.5');
    expect(pro).toContain('MaxClientsPerHost 8');
    expect(pro).toContain('TimeoutIdle 900');
    expect(pro).toContain('DefaultRoot ~');
    expect(pro).toContain('TLSRequired on');
    const vs = vsftpdSettings(s);
    expect(vs).toMatchObject({ pasv_min_port: 50000, pasv_max_port: 50100, pasv_address: '203.0.113.5', ssl_enable: 'YES', force_local_logins_ssl: 'YES', max_clients: 50, max_per_ip: 8, anonymous_enable: 'NO', idle_session_timeout: 900, chroot_local_user: 'YES', local_enable: 'YES' });
    const merged = mergeKeyValueFile('listen=YES\nanonymous_enable=YES\n#pasv_min_port=1\nlocal_umask=022\n', vs);
    expect(merged).toContain('listen=YES');
    expect(merged).toContain('local_umask=022');
    expect(merged.match(/^anonymous_enable=/gm)).toHaveLength(1);
    expect(merged).toContain('anonymous_enable=NO');
    expect(merged).not.toContain('#pasv_min_port=1');
    expect(merged).toContain('# Managed by WHM panel (FTP Server Configuration)');
    const pureConf = mergeKeyValueFile('ChrootEveryone no\nVerboseLog yes\n', pureFtpdSettings(s), { sep: ' ' });
    expect(pureConf).toContain('VerboseLog yes');
    expect(pureConf).toContain('ChrootEveryone yes');
    expect(pureConf.match(/^ChrootEveryone/gm)).toHaveLength(1);
    expect(ftpSettingsFrom('vsftpd', { pasv_min_port: '50000', pasv_max_port: '50100', ssl_enable: 'YES', force_local_logins_ssl: 'NO', anonymous_enable: 'NO', idle_session_timeout: '600', chroot_local_user: 'YES' })).toMatchObject({ passivePortMin: 50000, passivePortMax: 50100, tls: 'optional', anonymous: false, idleTimeoutMinutes: 10, chroot: true });
    expect(ftpSettingsFrom('pure-ftpd', { PassivePortRange: '30000 35000', TLS: '1', NoAnonymous: 'yes', MaxIdleTime: '15' })).toMatchObject({ passivePortMin: 30000, passivePortMax: 35000, tls: 'optional', anonymous: false, idleTimeoutMinutes: 15 });
    expect(ftpSettingsFrom('proftpd', { PassivePorts: '49152 65534', TLSEngine: 'on', TLSRequired: 'on', TimeoutIdle: '900', DefaultRoot: '~' })).toMatchObject({ passivePortMin: 49152, tls: 'required', idleTimeoutMinutes: 15, chroot: true });
  });

  it('parses apache -V/-M, mod_status ?auto, doveconf -n and rewrites Listen lines', () => {
    expect(parseApacheVersion('Server version: Apache/2.4.58 (Ubuntu)\nServer built:   2024-04-03T12:00:00\nServer MPM:     event\nArchitecture:   64-bit\n')).toEqual({ version: 'Apache/2.4.58 (Ubuntu)', built: '2024-04-03T12:00:00', mpm: 'event', architecture: '64-bit' });
    expect(parseModules('Loaded Modules:\n core_module (static)\n mpm_event_module (shared)\n status_module (shared)\n')).toEqual([{ name: 'core', type: 'static' }, { name: 'mpm_event', type: 'shared' }, { name: 'status', type: 'shared' }]);
    const st = parseServerStatus('ServerVersion: Apache/2.4.58 (Ubuntu)\nServerMPM: event\nServerUptimeSeconds: 3600\nTotal Accesses: 1200\nTotal kBytes: 4096\nReqPerSec: .333333\nBusyWorkers: 3\nIdleWorkers: 47\nScoreboard: ___W..\n');
    expect(st).toMatchObject({ mpm: 'event', uptimeSeconds: 3600, totalAccesses: 1200, totalKBytes: 4096, busyWorkers: 3, idleWorkers: 47, scoreboard: '___W..' });
    expect(st.requestsPerSecond).toBeCloseTo(0.3333, 3);
    expect(parseDoveconf('# 2.3.21: /etc/dovecot/dovecot.conf\nprotocols = imap pop3 lmtp\nssl = required\nprotocol imap {\n  mail_max_userip_connections = 20\n}\nmail_location = maildir:~/mail\n')).toEqual({ protocols: 'imap pop3 lmtp', ssl: 'required', mail_location: 'maildir:~/mail' });
    const ports = rewriteListen('Listen 80\n\n<IfModule ssl_module>\n\tListen 443\n</IfModule>\n', { http: 8080, https: 8443 });
    expect(ports).toContain('#Listen 80');
    expect(ports).toContain('#\tListen 443');
    expect(ports).toContain('\nListen 8080');
    expect(ports).toContain('  Listen 8443');
    expect(rewriteListen(ports, { http: 80, https: 443 }).match(/^Listen 80$/gm)).toHaveLength(1);
    // Behind nginx: pinned to loopback and no HTTPS listener at all.
    const bound = rewriteListen('Listen 80\n<IfModule ssl_module>\n\tListen 443\n</IfModule>\n', { http: 8080, https: null, bind: '127.0.0.1' });
    expect(bound).toContain('\nListen 127.0.0.1:8080\n');
    expect(bound).not.toMatch(/^\s*Listen 443/m);
    expect(bound).not.toMatch(/^\s*Listen 8443/m);
    expect(bound).toContain('#Listen 80');
    expect(rewriteListen('', { http: 8080, https: 8443, bind: '::1' })).toContain('  Listen [::1]:8443');
    expect(rewriteListen(bound, { http: 80, https: 443 })).toMatch(/^Listen 80$/m);
  });

  it('exim layout follows dc_use_split_config: fragments when split, a localmacros block when unsplit (the Debian default), a manual include on RHEL', () => {
    const split = eximLayout(hostIo({ dirs: ['/etc/exim4', '/etc/exim4/conf.d'], files: { '/etc/exim4/update-exim4.conf.conf': "dc_use_split_config='true'\n" }, binaries: ['exim4', 'update-exim4.conf'] }));
    expect(split).toMatchObject({ installed: true, flavor: 'debian', splitConfig: true, mainConf: null, updateConf: true, macroFile: '/etc/exim4/exim4.conf.localmacros', emailAclFile: '/etc/exim4/whm/acl-email-filters.conf', rcptAclSource: '/etc/exim4/conf.d/acl/30_exim4-config_check_rcpt', sentinel: EXIM_SENTINEL_MACRO });
    expect(split.slots.main).toEqual({ path: '/etc/exim4/conf.d/main/001_whm_service_config', hookable: true, block: null });
    expect(split.slots.acl_rcpt).toMatchObject({ path: '/etc/exim4/whm/acl-rcpt-local.conf', hookable: true, macro: 'CHECK_RCPT_LOCAL_ACL_FILE', includes: '/etc/exim4/whm/acl-email-filters.conf' });
    // conf.d exists on every Debian host but is ignored unless split config is on: the main slot must not be a fragment there.
    for (const conf of ["dc_use_split_config='false'\n", '']) {
      const unsplit = eximLayout(hostIo({ dirs: ['/etc/exim4', '/etc/exim4/conf.d'], files: { '/etc/exim4/update-exim4.conf.conf': conf }, binaries: ['exim4'] }));
      expect(unsplit).toMatchObject({ flavor: 'debian', splitConfig: false, mainConf: '/etc/exim4/exim4.conf.template', rcptAclSource: '/etc/exim4/exim4.conf.template' });
      expect(unsplit.slots.main.path).toBe('/etc/exim4/exim4.conf.localmacros');
      expect(unsplit.slots.main.hookable).toBe(true);
      expect(unsplit.slots.main.block).toMatch(/^# BEGIN WHM panel \(Service Configuration/);
      expect(unsplit.slots.acl_rcpt).toMatchObject({ path: '/etc/exim4/whm/acl-rcpt-local.conf', macro: 'CHECK_RCPT_LOCAL_ACL_FILE' });
    }
    const rhel = eximLayout(hostIo({ dirs: ['/etc/exim'], files: { '/etc/exim/exim.conf': '' }, binaries: ['exim'] }));
    expect(rhel).toMatchObject({ flavor: 'rhel', splitConfig: false, mainConf: '/etc/exim/exim.conf', macroFile: null, emailAclFile: '/etc/exim/whm/acl-email-filters.conf' });
    expect(rhel.slots.main).toEqual({ path: '/etc/exim/whm/service_config.conf', hookable: false, block: null });
    expect(rhel.slots.acl_rcpt).toMatchObject({ path: '/etc/exim/whm/acl-rcpt-local.conf', hookable: false, macro: null });
    expect(eximLayout(hostIo({}))).toBeNull();
  });

  it('the unsplit main slot is a managed block that leaves the admin\'s and the other categories\' localmacros lines alone', () => {
    const admin = "MAIN_TLS_ENABLE = true\n# BEGIN WHM panel (Email filters) - managed block, edits inside are overwritten\nsqlite_dbfile = /var/lib/whm/greylist/greylist.db\n# END WHM panel (Email filters)\n";
    const once = mergeEximBlock(admin, 'WHM_SERVICE_CONFIG = 1\nsmtp_accept_max = 100');
    expect(once.startsWith(admin)).toBe(true);
    expect(readEximBlock(once)).toBe('WHM_SERVICE_CONFIG = 1\nsmtp_accept_max = 100\n');
    const twice = mergeEximBlock(once, 'WHM_SERVICE_CONFIG = 1\nsmtp_accept_max = 50');
    expect(twice.match(/BEGIN WHM panel \(Service Configuration/g)).toHaveLength(1);
    expect(twice).toContain('smtp_accept_max = 50');
    expect(twice).not.toContain('smtp_accept_max = 100');
    expect(twice).toContain('sqlite_dbfile = /var/lib/whm/greylist/greylist.db');
    expect(stripEximBlock(twice)).toBe(admin);
    expect(readEximBlock(admin)).toBeNull();
    expect(stripEximBlock(null)).toBe('');
    expect(mergeEximBlock(null, 'x')).toMatch(/^# BEGIN WHM panel \(Service Configuration: Exim main options\)[^\n]*\nx\n# END WHM panel \(Service Configuration: Exim main options\)\n$/);
    expect(eximTlsLibrary(['crypteq', 'GnuTLS', 'DKIM'])).toBe('gnutls');
    expect(eximTlsLibrary(['TLS=GnuTLS'])).toBe('gnutls');
    expect(eximTlsLibrary(['OpenSSL'])).toBe('openssl');
    expect(eximTlsLibrary(null)).toBeNull();
  });

  it('per-account logrotate stanzas take the real primary group from /etc/group', () => {
    const passwd = 'root:x:0:0:root:/root:/bin/bash\nalice:x:30001:30050::/home/alice:/bin/bash\nbob:x:30002:30002::/home/bob:/bin/sh\neve:x:30003:30099::/home/eve:/bin/sh\n';
    const group = 'root:x:0:\nhosting:x:30050:\nbob:x:30002:\nBad Group:x:30099:\n';
    expect(primaryGroupName('alice', { passwd, group })).toBe('hosting');
    expect(primaryGroupName('bob', { passwd, group })).toBe('bob');
    // An unknown or unrenderable group name falls back to the caller's value.
    expect(primaryGroupName('eve', { passwd, group })).toBeNull();
    expect(primaryGroupName('nobody', { passwd, group })).toBeNull();
    expect(primaryGroupName('alice', { passwd: null, group: null })).toBeNull();
  });

  it('exim hints name only the manual steps a host still needs', () => {
    const split = { splitConfig: true, mainConf: null, macroFile: '/etc/exim4/exim4.conf.localmacros', rcptAclSource: '/etc/exim4/conf.d/acl/30_exim4-config_check_rcpt', slots: { main: { path: '/etc/exim4/conf.d/main/001_whm_service_config', hookable: true }, acl_rcpt: { path: '/etc/exim4/whm/acl-rcpt-local.conf', hookable: true }, acl_data: { path: '/etc/exim4/whm/acl_data_whm.conf', hookable: true } } };
    const live = { main: { ...split.slots.main, exists: true, hooked: true, claimedBy: null }, acl_rcpt: { ...split.slots.acl_rcpt, hooked: true, claimedBy: null }, acl_data: { ...split.slots.acl_data, hooked: true, claimedBy: null } };
    expect(hintsFor(split, live)).toEqual([]);
    // Hookable but not yet written: the next save defines the macro itself, so no manual step.
    expect(hintsFor(split, { ...live, acl_rcpt: { ...live.acl_rcpt, hooked: false } })).toEqual([]);
    expect(hintsFor(split, { ...live, main: { ...live.main, exists: false, hooked: false } })).toEqual([]);
    // Written but absent from the generated configuration: the layout/mode is off.
    const stale = hintsFor(split, { ...live, main: { ...live.main, hooked: false } });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/dc_use_split_config/);
    const claimed = hintsFor(split, { ...live, acl_rcpt: { ...live.acl_rcpt, hooked: false, claimedBy: '/etc/exim4/whm/acl_rcpt.conf' } });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatch(/CHECK_RCPT_LOCAL_ACL_FILE already points at \/etc\/exim4\/whm\/acl_rcpt\.conf/);
    expect(claimed[0]).toMatch(/Save "Filter Incoming Emails by Country"/);
    expect(claimed[0]).toMatch(/30_exim4-config_check_rcpt/);
    expect(claimed[0]).toContain('.include /etc/exim4/whm/acl-rcpt-local.conf');
    const rhel = { splitConfig: false, mainConf: '/etc/exim/exim.conf', rcptAclSource: '/etc/exim/exim.conf', slots: { main: { path: '/etc/exim/whm/service_config.conf', hookable: false }, acl_rcpt: { path: '/etc/exim/whm/acl-rcpt-local.conf', hookable: false }, acl_data: { path: '/etc/exim/whm/acl_data_whm.conf', hookable: false } } };
    const none = hintsFor(rhel, { main: { ...rhel.slots.main, hooked: false }, acl_rcpt: { ...rhel.slots.acl_rcpt, hooked: false }, acl_data: { ...rhel.slots.acl_data, hooked: false } });
    expect(none).toHaveLength(3);
    expect(none[1]).toContain('.include /etc/exim/whm/acl-rcpt-local.conf');
    expect(none[1]).toContain('/etc/exim/exim.conf');
  });

  it('role table covers ftp and dns daemons with package names per manager', () => {
    expect(SERVICE_ROLES.ftp.map((c) => c.name)).toEqual(['pure-ftpd', 'proftpd', 'vsftpd']);
    expect(SERVICE_ROLES.dns.map((c) => c.name)).toEqual(['bind', 'powerdns']);
    for (const c of [...SERVICE_ROLES.ftp, ...SERVICE_ROLES.dns]) expect(c.packages).toMatchObject({ apt: expect.any(String), dnf: expect.any(String) });
  });

  it('detection ops answer without a daemon instead of throwing', async () => {
    const d = await runOp('web.detect', {}, ctx);
    expect(typeof d.apache.installed).toBe('boolean');
    expect(Array.isArray(d.php.versions)).toBe(true);
    expect(Array.isArray(d.ftp.daemons)).toBe(true);
    const s = await runOp('web.service.detect', { role: 'ftp' }, ctx);
    expect(s.candidates.map((c) => c.name)).toEqual(['pure-ftpd', 'proftpd', 'vsftpd']);
    const l = await runOp('web.logrotate.list', {}, ctx);
    expect(l.dir).toBe('/etc/logrotate.d');
    const v = await runOp('web.vhost.list', {}, ctx);
    expect(Array.isArray(v.vhosts)).toBe(true);
    const e = await runOp('web.exim.detect', {}, ctx);
    expect(typeof e.installed).toBe('boolean');
  });
});

// Mocks the binaries a host has and what each answers; everything else runs
// unchanged.
async function withBinaries(binaries, answer, fn) {
  const { hasBinary } = await import('../src/exec.js');
  const actual = await vi.importActual('../src/exec.js');
  hasBinary.mockImplementation((name) => binaries.includes(name));
  exec.mockClear();
  exec.mockImplementation(async (bin, argv) => ({ code: 0, stdout: '', stderr: '', bin, argv, ...(answer(bin, argv) || {}) }));
  try { await fn(() => exec.mock.calls.map(([bin, argv]) => [bin, ...argv])); } finally { hasBinary.mockImplementation(actual.hasBinary); exec.mockImplementation(actual.exec); }
}

describe('web.ports.set on the RHEL layout silences the Listen of every conf.d drop-in (mod_ssl ssl.conf)', () => {
  const SSL_CONF = 'Listen 443 https\n\nSSLPassPhraseDialog exec:/usr/libexec/httpd-ssl-pass-dialog\n<VirtualHost _default_:443>\nSSLEngine on\n</VirtualHost>\n';
  const HTTPD_CONF = 'ServerRoot "/etc/httpd"\nListen 80\nInclude conf.modules.d/*.conf\nIncludeOptional conf.d/*.conf\n';
  const WELCOME = '<LocationMatch "^/+$">\n    Options -Indexes\n</LocationMatch>\n';

  function fakeHttpd() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-httpd-'));
    fs.mkdirSync(path.join(root, 'conf'));
    fs.mkdirSync(path.join(root, 'conf.d'));
    fs.writeFileSync(path.join(root, 'conf', 'httpd.conf'), HTTPD_CONF);
    fs.writeFileSync(path.join(root, 'conf.d', 'ssl.conf'), SSL_CONF);
    fs.writeFileSync(path.join(root, 'conf.d', 'welcome.conf'), WELCOME);
    fs.writeFileSync(path.join(root, 'conf.d', 'README'), 'Listen 9999 would be ignored: not a .conf\n');
    const apache = { flavor: 'rhel', root, bin: 'httpd', confD: path.join(root, 'conf.d'), units: ['httpd'], a2tools: false };
    return { root, apache, tctx: createContext({ allowedRoots: [root] }), read: (f) => fs.readFileSync(path.join(root, f), 'utf8') };
  }

  it('finds only .conf drop-ins that carry a top-level Listen', () => {
    const { root } = fakeHttpd();
    try {
      expect(listenDropIns(path.join(root, 'conf.d'))).toEqual([path.join(root, 'conf.d', 'ssl.conf')]);
      expect(listenDropIns(path.join(root, 'missing'))).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('comments the drop-in Listen alongside httpd.conf so nginx can take 443, and applying it twice is stable', async () => {
    const { root, apache, tctx, read } = fakeHttpd();
    try {
      await withBinaries(['httpd', 'systemctl'], (bin, argv) => (bin === 'httpd' && argv[0] === '-t' ? { stderr: 'Syntax OK\n' } : {}), async (calls) => {
        const result = await applyListen(apache, { http: 8080, https: null, bind: '127.0.0.1' }, tctx);
        expect(result).toMatchObject({ path: path.join(root, 'conf', 'httpd.conf'), dropIns: [path.join(root, 'conf.d', 'ssl.conf')], validated: true, http: 8080, https: null });
        expect(read('conf/httpd.conf')).toContain('#Listen 80');
        expect(read('conf/httpd.conf')).toContain('\nListen 127.0.0.1:8080\n');
        expect(read('conf.d/ssl.conf')).toContain('#Listen 443 https');
        expect(read('conf.d/ssl.conf')).not.toMatch(/^\s*Listen /m);
        expect(read('conf.d/ssl.conf')).toContain('<VirtualHost _default_:443>');
        expect(read('conf.d/welcome.conf')).toBe(WELCOME);
        expect(calls()).toContainEqual(['httpd', '-t']);
        const again = await applyListen(apache, { http: 80, https: 443 }, tctx);
        expect(again.dropIns).toEqual([]);
        expect(read('conf/httpd.conf').match(/^Listen 80$/gm)).toHaveLength(1);
        expect(read('conf.d/ssl.conf')).toContain('#Listen 443 https');
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('restores httpd.conf and every drop-in when httpd -t rejects the change', async () => {
    const { root, apache, tctx, read } = fakeHttpd();
    try {
      await withBinaries(['httpd', 'systemctl'], (bin, argv) => (bin === 'httpd' && argv[0] === '-t' ? { code: 1, stderr: 'AH00072: make_sock: could not bind to address 127.0.0.1:8443\n' } : {}), async () => {
        const err = await opError(applyListen(apache, { http: 8080, https: 8443, bind: '127.0.0.1' }, tctx));
        expect(err.code).toBe('config_invalid');
        expect(err.message).toMatch(/files were restored/);
        expect(read('conf/httpd.conf')).toBe(HTTPD_CONF);
        expect(read('conf.d/ssl.conf')).toBe(SSL_CONF);
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('debian touches ports.conf only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-apache2-'));
    try {
      fs.writeFileSync(path.join(root, 'ports.conf'), 'Listen 80\n<IfModule ssl_module>\n\tListen 443\n</IfModule>\n');
      const apache = { flavor: 'debian', root, bin: 'apache2ctl', units: ['apache2'], a2tools: true };
      await withBinaries(['apache2ctl', 'systemctl'], () => ({}), async () => {
        const result = await applyListen(apache, { http: 8080, https: 8443 }, createContext({ allowedRoots: [root] }));
        expect(result).toMatchObject({ path: path.join(root, 'ports.conf'), dropIns: [] });
        expect(fs.readFileSync(path.join(root, 'ports.conf'), 'utf8')).toContain('\nListen 8080\n');
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('SELinux: vhost and pool writes label the account trees and switch the httpd homedir booleans on', () => {
  function fakeHome() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-selinux-'));
    const home = path.join(base, 'alice');
    for (const d of ['public_html', 'tmp', 'logs', 'addon.example']) fs.mkdirSync(path.join(home, d), { recursive: true });
    return { base, home };
  }

  it('selinuxRules: one generic rule per standard tree, a specific one for anything else, domlogs as httpd_log_t', () => {
    const rules = selinuxRules({ home: '/home/alice', contentDirs: ['/home/alice/public_html', '/home/alice/tmp', '/home/alice/addon.example', '/home/alice/logs'], logDirs: [`${DOMLOGS_ROOT}/alice`] });
    expect(rules.map((r) => [r.spec, r.type])).toEqual([
      ['/home/[^/]+/public_html(/.*)?', 'httpd_sys_rw_content_t'],
      ['/home/[^/]+/tmp(/.*)?', 'httpd_sys_rw_content_t'],
      ['/home/alice/addon\\.example(/.*)?', 'httpd_sys_rw_content_t'],
      ['/home/[^/]+/logs(/.*)?', 'httpd_sys_rw_content_t'],
      ['/var/log/whm/domlogs(/.*)?', 'httpd_log_t'],
    ]);
    expect(selinuxRules({ home: '/root', contentDirs: ['/root/public_html'] })[0].spec).toBe('/root/public_html(/.*)?');
    expect(selinuxRules({ home: null, contentDirs: ['/srv/www/x'], logDirs: ['/var/log/custom'] }).map((r) => r.spec)).toEqual(['/srv/www/x(/.*)?', '/var/log/custom(/.*)?']);
    expect(selinuxRules({ home: '/home/alice', contentDirs: ['/home/alice/tmp', '/home/alice/tmp', null] })).toHaveLength(1);
  });

  it('does nothing when SELinux is absent or disabled', async () => {
    await withBinaries(['stat'], () => ({}), async (calls) => {
      expect(await ensureSelinuxWebAccess({ home: '/home/alice', docroot: '/home/alice/public_html' })).toEqual({ mode: null, applied: false });
      expect(calls()).toEqual([]);
    });
    await withBinaries(['getenforce', 'semanage', 'setsebool', 'restorecon'], (bin) => (bin === 'getenforce' ? { stdout: 'Disabled\n' } : {}), async (calls) => {
      expect(await ensureSelinuxWebAccess({ home: '/home/alice', docroot: '/home/alice/public_html' })).toEqual({ mode: 'disabled', applied: false });
      expect(calls()).toEqual([['getenforce']]);
    });
  });

  it('enforcing: turns only the booleans that are off on, adds the fcontext rules once, tolerates "already defined" and relabels the unlabelled trees', async () => {
    const { base, home } = fakeHome();
    const docroot = path.join(home, 'public_html');
    const logDir = `${DOMLOGS_ROOT}/alice`;
    const generic = `${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+`;
    try {
      await withBinaries(['getenforce', 'getsebool', 'setsebool', 'semanage', 'restorecon', 'chcon', 'stat'], (bin, argv) => {
        if (bin === 'getenforce') return { stdout: 'Enforcing\n' };
        if (bin === 'getsebool') return { stdout: 'httpd_enable_homedirs --> off\nhttpd_read_user_content --> off\nhttpd_can_network_connect --> on\nhttpd_can_sendmail --> on\n' };
        if (bin === 'semanage' && argv[4] === `${generic}/tmp(/.*)?`) return { code: 1, stderr: `ValueError: File context for ${argv[4]} already defined\n` };
        if (bin === 'stat') return { stdout: argv[2] === docroot ? 'unconfined_u:object_r:httpd_sys_rw_content_t:s0\n' : 'unconfined_u:object_r:user_home_t:s0\n' };
        return {};
      }, async (calls) => {
        const result = await ensureSelinuxWebAccess({ home, docroot, logDir });
        expect(result).toMatchObject({ mode: 'enforcing', applied: true, persistent: true, booleans: ['httpd_enable_homedirs', 'httpd_read_user_content'], warnings: [] });
        expect(result.rules).toEqual([`${generic}/public_html(/.*)?`, `${generic}/logs(/.*)?`, '/var/log/whm/domlogs(/.*)?']);
        expect(result.relabelled).toEqual([path.join(home, 'tmp'), path.join(home, 'logs')]);
        const c = calls();
        expect(c).toContainEqual(['setsebool', '-P', 'httpd_enable_homedirs=on', 'httpd_read_user_content=on']);
        expect(c).toContainEqual(['semanage', 'fcontext', '-a', '-t', 'httpd_sys_rw_content_t', `${generic}/public_html(/.*)?`]);
        expect(c).toContainEqual(['semanage', 'fcontext', '-a', '-t', 'httpd_log_t', '/var/log/whm/domlogs(/.*)?']);
        expect(c).toContainEqual(['restorecon', '-R', path.join(home, 'tmp')]);
        expect(c).not.toContainEqual(['restorecon', '-R', docroot]);
        expect(c.some(([bin]) => bin === 'chcon')).toBe(false);
        expect(c.some(([bin, , dir]) => bin === 'restorecon' && dir === logDir)).toBe(false);

        exec.mockClear();
        const again = await ensureSelinuxWebAccess({ home, docroot, logDir });
        expect(again).toMatchObject({ booleans: ['httpd_enable_homedirs', 'httpd_read_user_content'], rules: [], warnings: [] });
        expect(calls().some(([bin]) => bin === 'semanage')).toBe(false);
      });
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('permissive without semanage: chcon labels the trees and the result warns that the labels are not persistent', async () => {
    const { base, home } = fakeHome();
    const docroot = path.join(home, 'addon.example');
    try {
      await withBinaries(['getenforce', 'getsebool', 'setsebool', 'restorecon', 'chcon', 'stat'], (bin, argv) => {
        if (bin === 'getenforce') return { stdout: 'Permissive\n' };
        if (bin === 'getsebool') return { stdout: 'httpd_enable_homedirs --> on\nhttpd_read_user_content --> on\nhttpd_can_network_connect --> on\nhttpd_can_sendmail --> on\n' };
        if (bin === 'stat') return { stdout: 'unconfined_u:object_r:user_home_t:s0\n' };
        if (bin === 'chcon' && argv[3] === path.join(home, 'logs')) return { code: 1, stderr: 'chcon: failed to change context\n' };
        return {};
      }, async (calls) => {
        const result = await ensureSelinuxWebAccess({ home, docroot, tmpDir: path.join(home, 'tmp'), errorLog: path.join(home, 'logs', 'php-error.log') });
        expect(result).toMatchObject({ mode: 'permissive', applied: true, persistent: false, booleans: [], rules: [], relabelled: [docroot, path.join(home, 'tmp')] });
        expect(result.warnings.some((w) => /semanage is missing/.test(w))).toBe(true);
        expect(result.warnings.some((w) => /chcon.*failed to change context/.test(w))).toBe(true);
        const c = calls();
        expect(c).toContainEqual(['chcon', '-R', '-t', 'httpd_sys_rw_content_t', docroot]);
        expect(c.some(([bin]) => bin === 'semanage' || bin === 'setsebool' || bin === 'restorecon')).toBe(false);
      });
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

describe('unitState reports every UnitFileState that starts at boot as enabled, like svc.status', () => {
  const show = (state) => `ActiveState=active\nSubState=running\nUnitFileState=${state}\nLoadState=loaded\nMainPID=42\nNRestarts=0\n`;

  it('generated, indirect, enabled-runtime and alias units are enabled; disabled, masked and unknown are not', async () => {
    for (const state of ['enabled', 'enabled-runtime', 'static', 'indirect', 'generated', 'alias']) {
      await withBinaries(['systemctl'], (bin, argv) => (argv[0] === 'show' ? { stdout: show(state) } : {}), async (calls) => {
        expect(await unitState('pure-ftpd'), state).toMatchObject({ unit: 'pure-ftpd', present: true, active: true, enabled: true, unitFileState: state, pid: 42 });
        expect(calls()).toEqual([['systemctl', 'show', 'pure-ftpd.service', '--no-pager', '--property=ActiveState,SubState,UnitFileState,LoadState,MainPID,NRestarts']]);
      });
    }
    for (const state of ['disabled', 'masked', 'masked-runtime', 'linked', 'transient', 'bad', '']) {
      await withBinaries(['systemctl'], (bin, argv) => (argv[0] === 'show' ? { stdout: show(state) } : {}), async () => {
        const r = await unitState('pure-ftpd');
        expect(r.enabled, JSON.stringify(state)).toBe(false);
        expect(r.unitFileState).toBe(state || null);
      });
    }
    await withBinaries(['systemctl'], () => ({ stdout: 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n' }), async () => {
      expect(await unitState('nope')).toMatchObject({ present: false, active: false, enabled: false, unitFileState: null });
    });
    await withBinaries([], () => ({}), async (calls) => {
      expect(await unitState('pure-ftpd')).toEqual({ unit: 'pure-ftpd', present: false, active: false, state: null, enabled: null });
      expect(calls()).toEqual([]);
    });
  });
});

// Account vhosts allow .htaccess only Options=Indexes,MultiViews,SymLinksIfOwnerMatch,IncludesNOEXEC;
// the audit finds the lines Apache refuses under that list and heals the FollowSymLinks ones.
describe('web.htaccess.audit', () => {
  const passwd = (name) => { const l = (fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((x) => x.startsWith(`${name}:`)) || '').split(':'); return l[2] ? { name, uid: Number(l[2]), gid: Number(l[3]) } : null; };
  const asRoot = process.getuid() === 0;
  const owner = (asRoot && passwd('nobody')) || { name: os.userInfo().username, uid: process.getuid(), gid: process.getgid() };
  const DRUPAL = 'Options -Indexes\nOptions +FollowSymLinks\r\nOptions All -Indexes\n';

  function tree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-htaccess-'));
    const docroot = path.join(root, 'public_html');
    fs.mkdirSync(path.join(docroot, 'drupal', 'sites'), { recursive: true });
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.writeFileSync(path.join(docroot, '.htaccess'), '# WordPress\nOptions -Indexes\n<IfModule mod_rewrite.c>\nRewriteEngine On\n</IfModule>\n', { mode: 0o644 });
    fs.writeFileSync(path.join(docroot, 'drupal', '.htaccess'), DRUPAL);
    fs.chmodSync(path.join(docroot, 'drupal', '.htaccess'), 0o664);
    fs.writeFileSync(path.join(docroot, 'drupal', 'sites', '.htaccess'), 'Options -ExecCGI +Includes\n');
    fs.writeFileSync(path.join(root, 'elsewhere', '.htaccess'), 'Options +FollowSymLinks\n');
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(docroot, 'linked'));
    fs.symlinkSync(path.join(root, 'elsewhere', '.htaccess'), path.join(docroot, 'drupal', 'sites', 'link.htaccess'));
    if (asRoot) for (const f of ['', 'drupal', 'drupal/sites', '.htaccess', 'drupal/.htaccess', 'drupal/sites/.htaccess']) fs.chownSync(path.join(docroot, f), owner.uid, owner.gid);
    return { root, docroot, ctx: createContext({ allowedRoots: [root] }) };
  }

  it('rewrites FollowSymLinks and lists what Apache still refuses, line by line', () => {
    expect(HTACCESS_OPTIONS).toEqual(['Indexes', 'MultiViews', 'SymLinksIfOwnerMatch', 'IncludesNOEXEC']);
    const r = reconcileHtaccessOptions('# Options All\nOptions -Indexes +FollowSymLinks\n  options +FollowSymlinks\r\nOptions All -Indexes\nOptions -ExecCGI +Includes\nOptions None\nOptions +MultiViews +IncludesNOEXEC Indexes\nOptionsX FollowSymLinks\n');
    expect(r.text).toBe('# Options All\nOptions -Indexes +SymLinksIfOwnerMatch\n  options +SymLinksIfOwnerMatch\r\nOptions All -Indexes\nOptions -ExecCGI +Includes\nOptions None\nOptions +MultiViews +IncludesNOEXEC Indexes\nOptionsX FollowSymLinks\n');
    expect(r.rewritten).toBe(2);
    expect(r.before).toEqual([{ line: 2, tokens: ['FollowSymLinks'] }, { line: 3, tokens: ['FollowSymlinks'] }, { line: 4, tokens: ['All'] }, { line: 5, tokens: ['ExecCGI', 'Includes'] }]);
    expect(r.after).toEqual([{ line: 4, tokens: ['All'] }, { line: 5, tokens: ['ExecCGI', 'Includes'] }]);
    expect(reconcileHtaccessOptions('RewriteEngine On\n')).toEqual({ text: 'RewriteEngine On\n', rewritten: 0, before: [], after: [] });
  });

  it('rejects loose arguments and roots outside the allowed locations', async () => {
    for (const args of [{}, { roots: [] }, { roots: ['home/x'] }, { roots: ['/home/../etc'] }, { roots: ['/home/x'], fix: true }, { roots: ['/home/x'], username: 'Bad User' }, { roots: ['/home/x'], maxFiles: 0 }, { roots: ['/home/x'], extra: 1 }]) {
      expect((await opError(runOp('web.htaccess.audit', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect((await opError(runOp('web.htaccess.audit', { roots: ['/usr/share/doc'] }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('web.htaccess.audit', { roots: ['/home/alice/public_html'], username: 'no-such-user-xyz', fix: true }, ctx))).code).toBe('not_found');
  });

  it('audits without touching files and never walks through a link', async () => {
    const { root, docroot, ctx: c } = tree();
    const r = await runOp('web.htaccess.audit', { roots: [docroot, path.join(root, 'missing'), path.join(docroot, 'linked')] }, c);
    expect(r).toMatchObject({ fix: false, scanned: 3, rewritten: [], truncated: false, skipped: [] });
    expect(r.skippedRoots).toEqual([path.join(root, 'missing'), path.join(docroot, 'linked')]);
    expect(r.unsupported).toEqual([
      { file: path.join(docroot, 'drupal', '.htaccess'), line: 2, tokens: ['FollowSymLinks'] },
      { file: path.join(docroot, 'drupal', '.htaccess'), line: 3, tokens: ['All'] },
      { file: path.join(docroot, 'drupal', 'sites', '.htaccess'), line: 1, tokens: ['ExecCGI', 'Includes'] },
    ]);
    expect(fs.readFileSync(path.join(docroot, 'drupal', '.htaccess'), 'utf8')).toBe(DRUPAL);
  });

  it('with fix rewrites the account\'s own files in place and reports the rest', async () => {
    const { root, docroot, ctx: c } = tree();
    const r = await runOp('web.htaccess.audit', { roots: [docroot], username: owner.name, fix: true }, c);
    expect(r).toMatchObject({ fix: true, username: owner.name, scanned: 3, rewritten: [{ file: path.join(docroot, 'drupal', '.htaccess'), lines: 1 }], skipped: [] });
    expect(r.unsupported).toEqual([
      { file: path.join(docroot, 'drupal', '.htaccess'), line: 3, tokens: ['All'] },
      { file: path.join(docroot, 'drupal', 'sites', '.htaccess'), line: 1, tokens: ['ExecCGI', 'Includes'] },
    ]);
    const st = fs.statSync(path.join(docroot, 'drupal', '.htaccess'));
    expect(fs.readFileSync(path.join(docroot, 'drupal', '.htaccess'), 'utf8')).toBe('Options -Indexes\nOptions +SymLinksIfOwnerMatch\r\nOptions All -Indexes\n');
    expect([st.uid, st.mode & 0o777]).toEqual([owner.uid, 0o664]);
    expect(fs.readFileSync(path.join(root, 'elsewhere', '.htaccess'), 'utf8')).toBe('Options +FollowSymLinks\n');
    // A .htaccess given as a root is audited on its own; a second pass finds nothing left to rewrite.
    const again = await runOp('web.htaccess.audit', { roots: [path.join(docroot, 'drupal', '.htaccess')], username: owner.name, fix: true }, c);
    expect(again).toMatchObject({ scanned: 1, rewritten: [], unsupported: [{ line: 3, tokens: ['All'] }] });
  });

  it.skipIf(!asRoot)('never rewrites a file the account does not own', async () => {
    const { docroot, ctx: c } = tree();
    fs.mkdirSync(path.join(docroot, 'other'));
    fs.writeFileSync(path.join(docroot, 'other', '.htaccess'), 'Options +FollowSymLinks\n');
    const r = await runOp('web.htaccess.audit', { roots: [path.join(docroot, 'other')], username: owner.name, fix: true }, c);
    expect(r).toMatchObject({ scanned: 1, rewritten: [], skipped: [{ file: path.join(docroot, 'other', '.htaccess'), reason: 'owner' }] });
    expect(r.unsupported).toEqual([{ file: path.join(docroot, 'other', '.htaccess'), line: 1, tokens: ['FollowSymLinks'] }]);
    expect(fs.readFileSync(path.join(docroot, 'other', '.htaccess'), 'utf8')).toBe('Options +FollowSymLinks\n');
    expect((await opError(runOp('web.htaccess.audit', { roots: [docroot], username: 'root', fix: true }, c))).code).toBe('refused');
  });
});

describe('default (catch-all) virtual host: landing page for the bare address and unmatched names', () => {
  const BASE = { hostname: 'panel.example.com', docroot: '/var/www/whm-default', user: 'www-data', addresses: ['203.0.113.5', '2001:db8::5'] };
  const HOST_SSL = { cert: '/etc/ssl/whm/panel.example.com/cert.pem', key: '/etc/ssl/whm/panel.example.com/key.pem', fullchain: '/etc/ssl/whm/panel.example.com/fullchain.pem', source: 'hostname' };

  it('renders _default_ plus every tenant address on both ports, the hostname certificate on 443 and never a PHP handler', () => {
    const text = renderDefaultVhost({ ...BASE, ssl: HOST_SSL });
    expect(text).toMatch(/^# Managed by WHM panel \(default virtual host/);
    expect(text).toContain('<VirtualHost _default_:80 203.0.113.5:80 [2001:db8::5]:80>');
    expect(text).toContain('<VirtualHost _default_:443 203.0.113.5:443 [2001:db8::5]:443>');
    expect(text.match(/ServerName default\.invalid/g)).toHaveLength(2);
    expect(text).toContain('ServerAdmin webmaster@panel.example.com');
    expect(text.match(/DocumentRoot "\/var\/www\/whm-default"/g)).toHaveLength(2);
    expect(text).toContain('CustomLog "/var/log/whm/domlogs/www-data/default-access.log" combined');
    expect(text).toContain('ErrorLog "/var/log/whm/domlogs/www-data/default-ssl-error.log"');
    expect(text).toContain('<IfModule ssl_module>');
    expect(text).toContain('SSLEngine on');
    expect(text).toContain('SSLCertificateFile "/etc/ssl/whm/panel.example.com/fullchain.pem"');
    expect(text).toContain('SSLCertificateKeyFile "/etc/ssl/whm/panel.example.com/key.pem"');
    expect(text).toContain('AllowOverride None');
    expect(text).not.toMatch(/SetHandler|proxy_fcgi|RewriteEngine|IncludeOptional|FollowSymLinks/);
    expect(parseDefaultVhostMeta(text)).toMatchObject({ hostname: 'panel.example.com', docroot: '/var/www/whm-default', addresses: ['203.0.113.5', '2001:db8::5'], port: 80, sslPort: 443, ssl: true, sslSource: 'hostname' });
    // cert + chain without a fullchain file
    const chained = renderDefaultVhost({ ...BASE, ssl: { cert: '/etc/ssl/whm/x/cert.pem', key: '/etc/ssl/whm/x/key.pem', chain: '/etc/ssl/whm/x/chain.pem' } });
    expect(chained).toContain('SSLCertificateFile "/etc/ssl/whm/x/cert.pem"');
    expect(chained).toContain('SSLCertificateChainFile "/etc/ssl/whm/x/chain.pem"');
  });

  it('without a certificate pair only the HTTP block is rendered; behind the proxy it binds to the loopback port only', () => {
    const plain = renderDefaultVhost({ ...BASE, ssl: null });
    expect(plain).toContain('<VirtualHost _default_:80 203.0.113.5:80 [2001:db8::5]:80>');
    expect(plain).not.toContain('SSLEngine');
    expect(plain).not.toContain('_default_:443');
    expect(plain).toContain('# No certificate pair is available for HTTPS');
    expect(parseDefaultVhostMeta(plain)).toMatchObject({ ssl: false, sslSource: null });
    const proxied = renderDefaultVhost({ ...BASE, bind: '127.0.0.1', port: 8080, sslPort: null, ssl: HOST_SSL });
    expect(proxied).toContain('<VirtualHost _default_:8080 127.0.0.1:8080>');
    expect(proxied).not.toContain('203.0.113.5');
    expect(proxied).not.toContain('SSLEngine');
    expect(proxied).not.toContain('No certificate pair');
    expect(parseDefaultVhostMeta(proxied)).toMatchObject({ addresses: ['127.0.0.1'], port: 8080, sslPort: null, ssl: false });
    expect(renderDefaultVhost({ ...BASE, addresses: [] })).toContain('<VirtualHost _default_:80>');
    expect(() => renderDefaultVhost({ ...BASE, docroot: '/var/www/x y' })).toThrow(OpError);
  });

  it('the op schema rejects injection, traversal and foreign values', async () => {
    exec.mockClear();
    const bad = [
      { ...BASE, hostname: 'a;b.com' }, { ...BASE, hostname: '-x' }, { ...BASE, docroot: 'relative' }, { ...BASE, docroot: '/var/www/../etc' }, { ...BASE, docroot: '/var/www/x\nServerAlias evil' },
      { ...BASE, user: 'www data' }, { ...BASE, user: 'Root' }, { ...BASE, addresses: ['203.0.113.5; id'] }, { ...BASE, addresses: ['not-an-ip'] }, { ...BASE, bind: '1.2.3.4.5' },
      { ...BASE, port: 0 }, { ...BASE, port: '80' }, { ...BASE, sslPort: 70000 }, { ...BASE, ssl: { cert: '/etc/ssl/whm/c.pem' } }, { ...BASE, ssl: { cert: 'c.pem', key: '/etc/ssl/whm/k.pem' } },
      { ...BASE, logDir: '/var/log/whm/../../etc' }, { ...BASE, serverAdmin: 'nope' }, { ...BASE, extra: true },
    ];
    for (const args of bad) expect((await opError(runOp('web.default_vhost.write', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    expect((await opError(runOp('web.default_vhost.remove', { reload: 'yes' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  // The catch-all must load before every tenant vhost whatever the tenant is
  // called: `0-0.com.conf`, `0.io.conf` and `00.net.conf` all sort before a
  // digit-led name, so the order is structural (Debian: conf-enabled, which
  // apache2.conf includes before sites-enabled) or a name below every
  // character a domain may start with (RHEL: '+').
  const TENANT_FILES = ['0-0.com.conf', '0.io.conf', '00.net.conf', '0a.org.conf', 'a.com.conf'];

  it('the catch-all cannot be out-sorted by a tenant file: conf-enabled on Debian, a "+" name in conf.d on RHEL', () => {
    const debian = { flavor: 'debian', sitesAvailable: '/etc/apache2/sites-available', sitesEnabled: '/etc/apache2/sites-enabled', confAvailable: '/etc/apache2/conf-available', confEnabled: '/etc/apache2/conf-enabled' };
    expect(defaultVhostFile(debian)).toEqual({ file: '/etc/apache2/conf-available/000-whm-default.conf', link: '/etc/apache2/conf-enabled/000-whm-default.conf', name: '000-whm-default' });
    const rhel = { flavor: 'rhel', confD: '/etc/httpd/conf.d' };
    expect(defaultVhostFile(rhel)).toEqual({ file: '/etc/httpd/conf.d/+whm-default.conf', link: null, name: '+whm-default' });
    const rhelName = `${DEFAULT_VHOST_NAMES.rhel}.conf`;
    for (const tenant of [...TENANT_FILES, 'ssl.conf', 'welcome.conf']) expect(Buffer.compare(Buffer.from(rhelName), Buffer.from(tenant)), tenant).toBe(-1);
    expect([...TENANT_FILES, 'ssl.conf', rhelName].sort()[0]).toBe(rhelName);
    // The old Debian name would lose to those tenants in sites-enabled; it no longer lives there.
    expect(['000-whm-default.conf', ...TENANT_FILES].sort()[0]).toBe('0-0.com.conf');
  });

  function fakeApache2() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-default-vhost-'));
    for (const d of ['sites-available', 'sites-enabled', 'conf-available', 'conf-enabled', 'logs', 'landing', 'ssl']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, 'sites-available', '000-default.conf'), '<VirtualHost *:80>\n  DocumentRoot /var/www/html\n</VirtualHost>\n');
    fs.symlinkSync('../sites-available/000-default.conf', path.join(root, 'sites-enabled', '000-default.conf'));
    for (const f of TENANT_FILES) { fs.writeFileSync(path.join(root, 'sites-available', f), '<VirtualHost *:80>\n</VirtualHost>\n'); fs.symlinkSync(`../sites-available/${f}`, path.join(root, 'sites-enabled', f)); }
    fs.writeFileSync(path.join(root, 'landing', 'index.html'), '<h1>landing</h1>');
    const apache = { flavor: 'debian', root, bin: 'apache2ctl', sitesAvailable: path.join(root, 'sites-available'), sitesEnabled: path.join(root, 'sites-enabled'), confAvailable: path.join(root, 'conf-available'), confEnabled: path.join(root, 'conf-enabled'), units: ['apache2'], a2tools: true };
    const tctx = createContext({ allowedRoots: [root] });
    const args = { ...BASE, docroot: path.join(root, 'landing'), logDir: path.join(root, 'logs') };
    return { root, apache, tctx, args, lexists: (f) => { try { fs.lstatSync(path.join(root, f)); return true; } catch { return false; } } };
  }

  it('debian: writes conf-available/000-whm-default.conf + its conf-enabled link (ahead of every site), drops a legacy sites-enabled copy, disables the stock 000-default site with a2dissite, validates and reports the certificate source', async () => {
    const { root, apache, tctx, args, lexists: has } = fakeApache2();
    const hostCert = { cert: path.join(root, 'ssl', 'cert.pem'), key: path.join(root, 'ssl', 'key.pem'), fullchain: path.join(root, 'ssl', 'fullchain.pem') };
    for (const f of Object.values(hostCert)) fs.writeFileSync(f, 'pem');
    // A catch-all written by an earlier panel as a site, plus a foreign file of the same name that is left alone.
    fs.writeFileSync(path.join(root, 'sites-available', '000-whm-default.conf'), '# Managed by WHM panel\n# whm-default-vhost {}\n<VirtualHost _default_:80>\n</VirtualHost>\n');
    fs.symlinkSync('../sites-available/000-whm-default.conf', path.join(root, 'sites-enabled', '000-whm-default.conf'));
    try {
      await withBinaries(['apache2ctl', 'a2dissite', 'a2ensite', 'systemctl'], (bin, argv) => {
        if (bin === 'a2dissite') { fs.unlinkSync(path.join(root, 'sites-enabled', `${argv[1]}.conf`)); return {}; }
        if (bin === 'apache2ctl' && argv[0] === '-t') return { stderr: 'Syntax OK\n' };
        return {};
      }, async (calls) => {
        const r = await writeDefaultVhost(apache, { ...args, ssl: hostCert }, tctx);
        expect(r).toMatchObject({ name: '000-whm-default', path: path.join(root, 'conf-available', '000-whm-default.conf'), link: path.join(root, 'conf-enabled', '000-whm-default.conf'), validated: true, addresses: ['203.0.113.5', '2001:db8::5'], stockSite: { disabled: true, site: '000-default', via: 'a2dissite' }, legacy: { path: path.join(root, 'sites-available', '000-whm-default.conf'), removed: true } });
        expect(r.ssl).toEqual({ cert: hostCert.fullchain, key: hostCert.key, source: 'hostname', generated: false });
        expect(calls()).toContainEqual(['a2dissite', '-q', '000-default']);
        expect(calls()).toContainEqual(['apache2ctl', '-t']);
        expect(calls().some(([bin]) => bin === 'openssl')).toBe(false);
        expect(has('sites-enabled/000-default.conf')).toBe(false);
        expect(has('sites-available/000-whm-default.conf')).toBe(false);
        expect(has('sites-enabled/000-whm-default.conf')).toBe(false);
        expect(fs.readlinkSync(path.join(root, 'conf-enabled', '000-whm-default.conf'))).toBe('../conf-available/000-whm-default.conf');
        const text = fs.readFileSync(r.path, 'utf8');
        expect(text).toContain(`DocumentRoot "${path.join(root, 'landing')}"`);
        expect(text).toContain(`SSLCertificateFile "${hostCert.fullchain}"`);
        expect(text).toContain(`CustomLog "${path.join(root, 'logs')}/default-access.log" combined`);
        // Nothing of ours is in sites-enabled, where the tenants out-sort the old name.
        expect(fs.readdirSync(path.join(root, 'sites-enabled')).sort()).toEqual([...TENANT_FILES].sort());
        expect(fs.readdirSync(path.join(root, 'conf-enabled'))).toEqual(['000-whm-default.conf']);
        // Second write: the stock site is already off, no legacy copy, nothing else changes.
        const again = await writeDefaultVhost(apache, { ...args, ssl: hostCert }, tctx);
        expect(again.stockSite).toEqual({ disabled: false, site: '000-default' });
        expect(again.legacy).toBeNull();
        expect(calls().filter(([bin]) => bin === 'a2dissite')).toHaveLength(1);
        // Removal takes the file and the link and validates.
        const removed = await removeDefaultVhost(apache, tctx);
        expect(removed).toMatchObject({ path: r.path, removed: true, validated: true });
        expect(has('conf-available/000-whm-default.conf')).toBe(false);
        expect(has('conf-enabled/000-whm-default.conf')).toBe(false);
        expect(await removeDefaultVhost(apache, tctx)).toMatchObject({ removed: false });
        // A legacy site copy alone is removed by the remove op too; a file without the panel mark is never touched.
        fs.writeFileSync(path.join(root, 'sites-available', '000-whm-default.conf'), '# whm-default-vhost {}\n');
        expect(await removeDefaultVhost(apache, tctx)).toMatchObject({ removed: true, legacy: { removed: true } });
        fs.writeFileSync(path.join(root, 'sites-available', '000-whm-default.conf'), '<VirtualHost *:80>\n</VirtualHost>\n');
        expect(await removeDefaultVhost(apache, tctx)).toMatchObject({ removed: false, legacy: null });
        expect(has('sites-available/000-whm-default.conf')).toBe(true);
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('falls back to the panel pair, then generates a self-signed pair when the hostname bundle is missing; a rejected configtest restores everything including the stock site', async () => {
    const { root, apache, tctx, args, lexists: has } = fakeApache2();
    try {
      await withBinaries(['apache2ctl', 'a2dissite', 'a2ensite', 'openssl', 'systemctl'], (bin, argv) => {
        if (bin === 'a2dissite') { fs.unlinkSync(path.join(root, 'sites-enabled', `${argv[1]}.conf`)); return {}; }
        if (bin === 'a2ensite') { fs.symlinkSync(`../sites-available/${argv[1]}.conf`, path.join(root, 'sites-enabled', `${argv[1]}.conf`)); return {}; }
        if (bin === 'openssl') { const key = argv[argv.indexOf('-keyout') + 1]; const cert = argv[argv.indexOf('-out') + 1]; fs.mkdirSync(path.dirname(key), { recursive: true }); fs.writeFileSync(key, 'k'); fs.writeFileSync(cert, 'c'); return {}; }
        if (bin === 'apache2ctl' && argv[0] === '-t') return fs.existsSync(path.join(root, 'reject')) ? { code: 1, stderr: 'AH00526: Syntax error\n' } : { stderr: 'Syntax OK\n' };
        return {};
      }, async (calls) => {
        // The hostname bundle names files that do not exist: the first controlled pair that exists takes over, generated when nothing else exists.
        const panel = { source: 'panel', cert: path.join(root, 'tls', 'cert.pem'), key: path.join(root, 'tls', 'key.pem') };
        const generated = { source: 'generated', cert: path.join(root, 'default-ssl', 'cert.pem'), key: path.join(root, 'default-ssl', 'key.pem') };
        const fallbacks = [{ source: 'apache-service', cert: path.join(root, 'svc', 'fullchain.pem'), key: path.join(root, 'svc', 'key.pem') }, panel, generated];
        expect(DEFAULT_SSL_FALLBACKS.map((c) => c.source)).toEqual(['apache-service', 'panel', 'generated']);
        const missing = { cert: path.join(root, 'ssl', 'missing.pem'), key: path.join(root, 'ssl', 'missing.key') };
        const r = await writeDefaultVhost(apache, { ...args, ssl: missing }, tctx, { fallbacks });
        expect(r.ssl).toMatchObject({ cert: generated.cert, key: generated.key, source: 'generated', generated: true });
        const gen = calls().find(([bin]) => bin === 'openssl');
        expect(gen.slice(1)).toEqual(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', generated.key, '-out', generated.cert, '-days', '3650', '-subj', '/CN=panel.example.com']);
        expect(fs.statSync(generated.key).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(r.path, 'utf8')).toContain(`SSLCertificateFile "${generated.cert}"`);
        expect(has('sites-enabled/000-default.conf')).toBe(false);
        // The generated pair is reused, and the panel pair wins over it once it exists.
        const again = await writeDefaultVhost(apache, { ...args, ssl: missing }, tctx, { fallbacks });
        expect(again.ssl).toMatchObject({ source: 'generated', generated: false });
        expect(calls().filter(([bin]) => bin === 'openssl')).toHaveLength(1);
        fs.mkdirSync(path.dirname(panel.cert)); fs.writeFileSync(panel.cert, 'c'); fs.writeFileSync(panel.key, 'k');
        const withPanel = await writeDefaultVhost(apache, { ...args, ssl: null }, tctx, { fallbacks });
        expect(withPanel.ssl).toMatchObject({ cert: panel.cert, key: panel.key, source: 'panel' });
        expect(fs.readFileSync(r.path, 'utf8')).toContain(`SSLCertificateKeyFile "${panel.key}"`);
        // Rollback: a rejected configtest puts the previous file back and re-enables the stock site it disabled.
        fs.symlinkSync('../sites-available/000-default.conf', path.join(root, 'sites-enabled', '000-default.conf'));
        const before = fs.readFileSync(r.path, 'utf8');
        fs.writeFileSync(path.join(root, 'reject'), '');
        const err = await opError(writeDefaultVhost(apache, { ...args, addresses: ['198.51.100.9'], ssl: null }, tctx, { fallbacks }));
        expect(err.code).toBe('config_invalid');
        expect(fs.readFileSync(r.path, 'utf8')).toBe(before);
        expect(has('sites-enabled/000-default.conf')).toBe(true);
        expect(calls()).toContainEqual(['a2ensite', '-q', '000-default']);
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rhel: a conf.d/+whm-default.conf without a link, sorted ahead of every tenant file, ssl.conf and welcome.conf', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-default-httpd-'));
    try {
      for (const d of ['conf.d', 'logs', 'landing']) fs.mkdirSync(path.join(root, d), { recursive: true });
      fs.writeFileSync(path.join(root, 'conf.d', 'ssl.conf'), '<VirtualHost _default_:443>\n</VirtualHost>\n');
      fs.writeFileSync(path.join(root, 'conf.d', 'welcome.conf'), '<LocationMatch "^/+$">\n</LocationMatch>\n');
      for (const f of TENANT_FILES) fs.writeFileSync(path.join(root, 'conf.d', f), '<VirtualHost *:80>\n</VirtualHost>\n');
      const apache = { flavor: 'rhel', root, bin: 'httpd', confD: path.join(root, 'conf.d'), units: ['httpd'], a2tools: false };
      const tctx = createContext({ allowedRoots: [root] });
      await withBinaries(['httpd', 'systemctl'], (bin, argv) => (bin === 'httpd' && argv[0] === '-t' ? { stderr: 'Syntax OK\n' } : {}), async (calls) => {
        const r = await writeDefaultVhost(apache, { ...BASE, docroot: path.join(root, 'landing'), logDir: path.join(root, 'logs'), sslPort: null }, tctx);
        expect(r).toMatchObject({ name: '+whm-default', path: path.join(root, 'conf.d', '+whm-default.conf'), link: null, ssl: null, stockSite: { disabled: false, site: null }, legacy: null });
        expect(fs.readdirSync(path.join(root, 'conf.d')).sort()).toEqual(['+whm-default.conf', '0-0.com.conf', '0.io.conf', '00.net.conf', '0a.org.conf', 'a.com.conf', 'ssl.conf', 'welcome.conf']);
        expect(calls().some(([bin]) => bin === 'a2dissite')).toBe(false);
        expect(defaultVhostFile(apache)).toEqual({ file: path.join(root, 'conf.d', '+whm-default.conf'), link: null, name: '+whm-default' });
        expect(await removeDefaultVhost(apache, tctx)).toMatchObject({ removed: true, legacy: null });
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('web.docroot.ensure / remove run inside the account home as the account', () => {
  const ARGS = { username: 'alice', docroot: '/home/alice/public_html/addon.example' };

  it('schemas refuse traversal, foreign users and reserved values before anything runs', async () => {
    exec.mockClear();
    const bad = [
      { ...ARGS, username: 'Alice' }, { ...ARGS, username: 'root;id' }, { ...ARGS, docroot: 'public_html/x' }, { ...ARGS, docroot: '/home/alice/../bob/public_html' }, { ...ARGS, docroot: '/home/alice/x y' },
      { ...ARGS, group: 'www data' }, { ...ARGS, index: 'a\0b' }, { ...ARGS, mode: '0777' },
    ];
    for (const args of bad) expect((await opError(runOp('web.docroot.ensure', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    expect((await opError(runOp('web.docroot.remove', { ...ARGS, recursive: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.docroot.remove', { username: 'alice', docroot: '/home/alice/../etc' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a user that does not exist, a system user, a path outside the home, the home itself and reserved directories, before running anything', async () => {
    exec.mockClear();
    expect((await opError(runOp('web.docroot.ensure', { username: 'nosuchuser0', docroot: '/home/nosuchuser0/site' }, ctx))).code).toBe('not_found');
    // The index page takes a rendered template as large as the template editor accepts (512 KiB); the schema passes it through to the user lookup.
    expect((await opError(runOp('web.docroot.ensure', { username: 'nosuchuser0', docroot: '/home/nosuchuser0/site', index: 'x'.repeat(512 * 1024) }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('web.docroot.ensure', { username: 'nosuchuser0', docroot: '/home/nosuchuser0/site', index: 'x'.repeat(512 * 1024 + 1) }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.docroot.ensure', { username: 'root', docroot: '/home/root/site' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('web.docroot.remove', { username: 'root', docroot: '/root/x' }, ctx))).code).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-docroot-'));
    try {
      const home = path.join(base, 'alice');
      fs.mkdirSync(path.join(home, 'public_html'), { recursive: true });
      const tctx = createContext({ allowedRoots: [base] });
      const { passwdHome: ph, assertUnderHome: under } = await import('../src/ops/web.js');
      expect(typeof ph).toBe('function');
      expect(() => under(home, path.join(base, 'bob', 'site'))).toThrow(OpError);
      fs.symlinkSync('/etc', path.join(home, 'linked'));
      expect(() => under(home, path.join(home, 'linked', 'site'))).toThrow(OpError);
      expect(under(home, path.join(home, 'public_html', 'addon.example'))).toBe(path.join(home, 'public_html', 'addon.example'));
      void tctx;
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

describe('phpLayout lists a versioned FPM tree only while its binary exists', () => {
  it('drops a pool.d a hand removal left behind and keeps it with requireBinary: false', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-php-layout-'));
    for (const v of ['8.1', '8.3']) fs.mkdirSync(path.join(root, 'php', v, 'fpm', 'pool.d'), { recursive: true });
    fs.mkdirSync(path.join(root, 'php', '8.2', 'cli'), { recursive: true });
    for (const d of ['php74', 'php82', 'notphp']) fs.mkdirSync(path.join(root, 'remi', d, 'php-fpm.d'), { recursive: true });
    const previous = { php: process.env.WHM_PHP_ETC_ROOT, remi: process.env.WHM_REMI_ETC_ROOT };
    process.env.WHM_PHP_ETC_ROOT = path.join(root, 'php');
    process.env.WHM_REMI_ETC_ROOT = path.join(root, 'remi');
    try {
      await withBinaries(['php-fpm8.3', '/opt/remi/php82/root/usr/sbin/php-fpm'], () => ({}), async () => {
        const strict = phpLayout().versions.filter((v) => v.flavor !== 'rhel');
        expect(strict.map((v) => [v.version, v.flavor, v.bin, v.poolDir])).toEqual([
          ['8.2', 'remi', '/opt/remi/php82/root/usr/sbin/php-fpm', path.join(root, 'remi', 'php82', 'php-fpm.d')],
          ['8.3', 'debian', 'php-fpm8.3', path.join(root, 'php', '8.3', 'fpm', 'pool.d')],
        ]);
        const lenient = phpLayout({ requireBinary: false }).versions.filter((v) => v.flavor !== 'rhel');
        expect(lenient.map((v) => [v.version, v.bin])).toEqual([['7.4', null], ['8.1', null], ['8.2', '/opt/remi/php82/root/usr/sbin/php-fpm'], ['8.3', 'php-fpm8.3']]);
        // The pool write refuses the orphaned tree like a version that was never installed.
        expect((await opError(runOp('web.phpfpm.pool.write', { user: 'root', version: '8.1' }, ctx))).code).toBe('capability_missing');
      });
      await withBinaries([], () => ({}), async () => {
        expect(phpLayout().versions.filter((v) => v.flavor !== 'rhel')).toEqual([]);
        expect(phpLayout().installed).toBe(fs.existsSync('/etc/php-fpm.d'));
      });
    } finally {
      if (previous.php === undefined) delete process.env.WHM_PHP_ETC_ROOT; else process.env.WHM_PHP_ETC_ROOT = previous.php;
      if (previous.remi === undefined) delete process.env.WHM_REMI_ETC_ROOT; else process.env.WHM_REMI_ETC_ROOT = previous.remi;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
