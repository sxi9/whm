import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import {
  renderVhost, parseVhostMeta, renderRedirects, renderGlobalInclude, renderPhpPool, renderLogrotate, mergeKeyValueFile, renderProftpd, vsftpdSettings, pureFtpdSettings,
  ftpSettingsFrom, parseServerStatus, parseApacheVersion, parseModules, parseDoveconf, rewriteListen, apacheLayout, eximLayout, phpLayout, SERVICE_ROLES, hintsFor, ensureRootLogDir, confPath, parseEximVersion,
  mergeEximBlock, readEximBlock, stripEximBlock, eximTlsLibrary, primaryGroupName, EXIM_SENTINEL_MACRO, renderHttpsRedirect,
} from '../src/ops/web.js';

// Fake host for the layout detection: which paths exist, what they contain, which binaries resolve.
function hostIo({ files = {}, dirs = [], binaries = [] }) {
  return { exists: (p) => dirs.includes(p) || p in files, readText: (p) => (p in files ? files[p] : null), hasBinary: (b) => binaries.includes(b) };
}

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
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
    for (const [name, args] of [['web.configtest', {}], ['web.vhost.write', VHOST], ['web.global.write', { directives: { timeout: 30 } }], ['web.mpm.set', { module: 'event' }]]) {
      expect((await opError(runOp(name, args, ctx))).code, name).toBe('capability_missing');
    }
    if (!eximLayout()?.installed) expect((await opError(runOp('web.exim.include.write', { slot: 'main', content: 'x' }, ctx))).code).toBe('capability_missing');
    if (!phpLayout().versions.some((v) => v.version === '7.0')) expect((await opError(runOp('web.phpfpm.pool.write', { user: 'root', version: '7.0' }, ctx))).code).toBe('capability_missing');
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
