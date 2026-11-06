import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { renderRadicaleConfig, parseConfigMeta, parseUsers, renderUsers, upsertUser, removeUser, parseProps, DAV_LOGIN_RE, BCRYPT_RE } from '../src/ops/dav.js';
import { renderHostApp, parseHostMeta, HOST_PROXY_MODULES } from '../src/ops/web.js';
import { RADICALE, RADICALE_ROOTS } from '../src/managed-paths.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});
const { exec } = await import('../src/exec.js');

const ctx = createContext();
const opError = (p) => p.then(() => null, (e) => e);
const HASH = '$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW';

describe('dav.* op family', () => {
  it('registers the five ops with the right destructive flags', () => {
    for (const name of ['dav.status', 'dav.install', 'dav.user.set', 'dav.user.remove', 'dav.collections']) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('dav.user.remove').destructive).toBe(true);
    expect(catalog.get('dav.user.set').destructive).toBe(false);
    expect(catalog.get('dav.collections').destructive).toBe(false);
  });

  it('renders a pinned loopback configuration from constants only', () => {
    const text = renderRadicaleConfig();
    expect(text.startsWith('# Managed by Keel (Calendars and Contacts)')).toBe(true);
    expect(parseConfigMeta(text)).toEqual({ host: '127.0.0.1', port: 5232, users: '/etc/radicale/users', storage: '/var/lib/radicale/collections' });
    expect(text).toContain('[server]\nhosts = 127.0.0.1:5232\n');
    expect(text).toContain('[auth]\ntype = htpasswd\nhtpasswd_filename = /etc/radicale/users\nhtpasswd_encryption = bcrypt\n');
    expect(text).toContain('[rights]\ntype = owner_only\n');
    expect(text).toContain('[storage]\ntype = multifilesystem\nfilesystem_folder = /var/lib/radicale/collections\n');
    expect(text).not.toMatch(/0\.0\.0\.0|\[::\]/);
    expect(parseConfigMeta('hosts = 0.0.0.0:5232')).toBeNull();
    expect(RADICALE_ROOTS).toEqual(['/etc/radicale', '/var/lib/radicale']);
    expect(ctx.allowedRoots).toEqual(expect.arrayContaining(RADICALE_ROOTS));
    expect(RADICALE.packages).toEqual(['radicale', 'python3-bcrypt']);
  });

  it('edits the htpasswd text without touching foreign lines', () => {
    const text = '# comment\nalice@a.example:$2y$12$x\n\nbob@b.example:$2y$12$y\n';
    expect(parseUsers(text)).toEqual([{ raw: '# comment' }, { login: 'alice@a.example', hash: '$2y$12$x' }, { login: 'bob@b.example', hash: '$2y$12$y' }]);
    expect(renderUsers(parseUsers(text))).toBe('# comment\nalice@a.example:$2y$12$x\nbob@b.example:$2y$12$y\n');
    expect(upsertUser(text, 'alice@a.example', HASH)).toBe(`# comment\nalice@a.example:${HASH}\nbob@b.example:$2y$12$y\n`);
    expect(upsertUser('', 'carol@c.example', HASH)).toBe(`carol@c.example:${HASH}\n`);
    expect(removeUser(text, 'bob@b.example')).toEqual({ content: '# comment\nalice@a.example:$2y$12$x\n', removed: true });
    expect(removeUser(text, 'nobody@a.example')).toEqual({ content: '# comment\nalice@a.example:$2y$12$x\nbob@b.example:$2y$12$y\n', removed: false });
  });

  it('accepts only address logins and real bcrypt hashes', () => {
    for (const ok of ['alice@example.com', 'a.b-c_d@sub.example.co.uk', 'testuser@testuser.hostingsignal.in']) expect(DAV_LOGIN_RE.test(ok), ok).toBe(true);
    for (const bad of ['alice', 'alice@localhost', 'Alice@Example.com', 'alice:x@example.com', 'alice@example.com\nbob:x', '.alice@example.com', 'alice@-example.com', 'a@b', '', ' alice@example.com', 'alice@example.com/..', `${'a'.repeat(65)}@example.com`]) expect(DAV_LOGIN_RE.test(bad), bad).toBe(false);
    expect(BCRYPT_RE.test(HASH)).toBe(true);
    for (const bad of ['', 'secret', '$1$abc', '$2a$12$short', `${HASH}\n`, HASH.replace('$2a$', '$2z$'), `${HASH}x`, 'plain:text']) expect(BCRYPT_RE.test(bad), bad).toBe(false);
  });

  it('refuses every injection into the user ops before anything runs', async () => {
    exec.mockClear();
    const bad = [
      {}, { login: 'alice' }, { login: 'alice@example.com' }, { login: 'alice@example.com', hash: 'secret' }, { login: 'alice@example.com', hash: `${HASH}\nroot:${HASH}` },
      { login: 'alice:x@example.com', hash: HASH }, { login: '../alice@example.com', hash: HASH }, { login: 'alice@example.com', hash: HASH, password: 'x' }, { login: 'ALICE@EXAMPLE.COM', hash: HASH },
    ];
    for (const args of bad) expect((await opError(runOp('dav.user.set', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    for (const args of [{}, { login: 'alice' }, { login: 'alice@example.com', force: true }, { login: 'a/../b@example.com' }]) expect((await opError(runOp('dav.user.remove', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    for (const args of [{}, { login: '../../etc' }, { login: 'alice@example.com', path: '/etc' }]) expect((await opError(runOp('dav.collections', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    expect((await opError(runOp('dav.install', { packages: ['x'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('dav.status', { lint: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('dav.collections answers exists:false for an unknown login without running a program', async () => {
    exec.mockClear();
    const r = await runOp('dav.collections', { login: 'nobody-here@example.invalid' }, ctx);
    expect(r).toMatchObject({ login: 'nobody-here@example.invalid', exists: false, collections: [] });
    expect(r.path).toBe('/var/lib/radicale/collections/collection-root/nobody-here@example.invalid');
    expect(exec).not.toHaveBeenCalled();
  });

  it('parses Radicale collection props defensively', () => {
    expect(parseProps('{"tag":"VCALENDAR","D:displayname":"Work","ICAL:calendar-color":"#ff0000"}')).toEqual({ tag: 'VCALENDAR', displayName: 'Work', description: null, color: '#ff0000' });
    expect(parseProps('{"tag":"VADDRESSBOOK","CR:addressbook-description":"people"}')).toMatchObject({ tag: 'VADDRESSBOOK', description: 'people' });
    expect(parseProps('not json')).toEqual({ tag: null, displayName: null, description: null, color: null });
    expect(parseProps('{"tag":["x"]}').tag).toBeNull();
  });

  it('dav.status reports a stable shape and the install op needs the package', async () => {
    const s = await runOp('dav.status', {}, ctx);
    expect(Object.keys(s).sort()).toEqual(['bcrypt', 'config', 'installed', 'listen', 'packages', 'storage', 'unit', 'users', 'version']);
    expect(s.listen).toEqual({ host: '127.0.0.1', port: 5232 });
    expect(s.config.path).toBe('/etc/radicale/config');
    expect(s.users.path).toBe('/etc/radicale/users');
    if (!s.installed) {
      const err = await opError(runOp('dav.install', {}, ctx));
      expect(err).toBeInstanceOf(OpError);
      expect(err.code).toBe('capability_missing');
    }
  });
});

describe('web.host.app.write { proxy } (the /dav publication)', () => {
  const PROXY = { name: 'dav', alias: '/dav', php: false, proxy: { port: 5232, scriptName: '/dav' }, access: 'all', allowFrom: [], options: ['None'], allowOverride: 'None', denyDirs: [] };

  it('renders a loopback ProxyPass with X-Script-Name and no directory', () => {
    const text = renderHostApp(PROXY);
    expect(text.startsWith('# Managed by Keel (server hostname site: application "dav", reverse proxy)')).toBe(true);
    expect(parseHostMeta(text, '# keel-host-app ')).toMatchObject({ name: 'dav', alias: '/dav', root: null, php: false, phpSocket: null, proxy: { port: 5232, scriptName: '/dav', target: 'http://127.0.0.1:5232/' } });
    expect(text).toContain('RedirectMatch 301 "^/dav$" "/dav/"');
    expect(text).toContain('<IfModule proxy_http_module>\n  ProxyRequests Off\n  ProxyPass "/dav/" "http://127.0.0.1:5232/" retry=0\n  ProxyPassReverse "/dav/" "http://127.0.0.1:5232/"');
    expect(text).toContain('<Location "/dav/">\n    Require all granted\n    <IfModule headers_module>\n      RequestHeader set X-Script-Name "/dav"');
    expect(text).not.toContain('Alias ');
    expect(text).not.toContain('<Directory');
    expect(text).not.toContain('SetHandler');
    // The script name defaults to the alias; access variants apply inside the Location.
    const local = renderHostApp({ ...PROXY, alias: '/cal/', proxy: { port: 5232 }, access: 'local' });
    expect(local).toContain('ProxyPass "/cal/" "http://127.0.0.1:5232/"');
    expect(local).toContain('RequestHeader set X-Script-Name "/cal"');
    expect(local).toContain('    Require local\n');
    expect(HOST_PROXY_MODULES).toEqual(['proxy', 'proxy_http', 'headers']);
  });

  it('refuses a proxy spec that also names a root, a privileged port or anything off-loopback', async () => {
    exec.mockClear();
    const bad = [
      { ...PROXY, root: '/var/www' }, { name: 'dav', alias: '/dav' }, { ...PROXY, proxy: { port: 80 } }, { ...PROXY, proxy: { port: 70000 } }, { ...PROXY, proxy: { port: '5232' } },
      { ...PROXY, proxy: { port: 5232, host: '10.0.0.1' } }, { ...PROXY, proxy: { port: 5232, target: 'http://evil/' } }, { ...PROXY, proxy: { port: 5232, scriptName: 'dav' } }, { ...PROXY, proxy: { port: 5232, scriptName: '/dav"\nProxyPass / http://evil/' } },
    ];
    for (const args of bad) expect((await opError(runOp('web.host.app.write', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });
});
