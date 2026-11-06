import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { renderUnit, quoteEnv, parseShow, parseListening, parseUnitMeta, interpreterFor, unitName, unitFile, APP_NAME_RE, APP_REL_RE, ENV_KEY_RE, RESERVED_ENV, APPS_DIR } from '../src/ops/apps.js';
import { renderVhost, renderProxies, PROXY_PATH_RE, PROXY_MODULES } from '../src/ops/web.js';

// exec and hasBinary are spied so no systemctl, journalctl, ss, npm or pip
// ever runs from a test; ops with side effects are checked up to the point
// where the schema or the path check refuses them.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary), resolveBinary: vi.fn(mod.resolveBinary) };
});
const { exec, hasBinary, resolveBinary } = await import('../src/exec.js');

const ctx = createContext();
const ok = (stdout = '', code = 0) => Promise.resolve({ code, stdout, stderr: '' });

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

const APP = { username: 'alice', name: 'probe-app', type: 'node', dir: 'apps/probe-app', entry: 'server.js', runtime: '22', port: 31000, env: { GREETING: 'hello world', QUOTED: 'say "hi" \\ back' }, home: '/home/alice', gid: 1001, execBin: '/opt/keel/node/22/bin/node' };

beforeEach(() => { exec.mockReset(); hasBinary.mockReset(); resolveBinary.mockReset(); hasBinary.mockReturnValue(true); });

describe('apps op catalog', () => {
  it('registers the unit, deps and port ops with the right destructive flags', () => {
    for (const name of ['apps.unit.write', 'apps.unit.remove', 'apps.unit.control', 'apps.unit.status', 'apps.unit.logs', 'apps.deps.install', 'apps.port.free']) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('apps.unit.remove').destructive).toBe(true);
    expect(catalog.get('apps.unit.control').destructive).toBe(true);
    expect(catalog.get('apps.unit.status').destructive).toBe(false);
    expect(catalog.get('apps.port.free').destructive).toBe(false);
    expect(catalog.has('web.modules.status')).toBe(true);
    expect(catalog.has('web.modules.enable')).toBe(true);
    expect(unitName('alice', 'probe-app')).toBe('keel-app-alice.probe-app');
    expect(unitFile('alice', 'probe-app')).toBe(`${APPS_DIR}/alice/keel-app-alice.probe-app.service`);
    expect(APPS_DIR).toBe('/etc/whm/apps');
    expect(ctx.allowedRoots).toContain('/etc/whm/apps');
    expect(ctx.allowedRoots).not.toContain('/etc/systemd/system');
  });
});

describe('unit template', () => {
  it('renders a hardened unit that runs as the account with the panel-set environment', () => {
    const text = renderUnit(APP);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^# Managed by Keel/);
    expect(parseUnitMeta(text)).toEqual({ username: 'alice', name: 'probe-app', type: 'node', dir: 'apps/probe-app', entry: 'server.js', runtime: '22', port: 31000, venv: false });
    for (const l of ['[Unit]', '[Service]', '[Install]', 'User=alice', 'Group=1001', 'WorkingDirectory=/home/alice/apps/probe-app', 'Environment="PORT=31000"', 'Environment="HOME=/home/alice"', 'Environment="NODE_ENV=production"',
      'Environment="GREETING=hello world"', 'Environment="QUOTED=say \\"hi\\" \\\\ back"', 'ExecStart=/opt/keel/node/22/bin/node /home/alice/apps/probe-app/server.js', 'Restart=on-failure', 'NoNewPrivileges=true', 'ProtectSystem=strict',
      'ReadWritePaths=/home/alice', 'PrivateTmp=true', 'SyslogIdentifier=keel-app-alice.probe-app', 'WantedBy=multi-user.target']) expect(lines, l).toContain(l);
    expect(text).toContain('Environment="PATH=/opt/keel/node/22/bin:/usr/local/bin:/usr/bin:/bin"');
    expect(text).not.toContain('MemoryMax');
    expect(text).not.toMatch(/\bsh\b|bash|-c /);
    expect(renderUnit({ ...APP, memoryMax: '256M' })).toContain('MemoryMax=256M');
  });
  it('starts a Python app through its venv when one exists, else through the interpreter', () => {
    const py = { ...APP, type: 'python', runtime: '3.12', entry: 'app.py', execBin: '/usr/bin/python3.12' };
    expect(renderUnit({ ...py, venv: true })).toContain('ExecStart=/home/alice/apps/probe-app/.venv/bin/python /home/alice/apps/probe-app/app.py');
    expect(renderUnit(py)).toContain('ExecStart=/usr/bin/python3.12 /home/alice/apps/probe-app/app.py');
    expect(renderUnit(py)).not.toContain('NODE_ENV');
  });
  it('quotes environment values the way systemd reads them', () => {
    expect(quoteEnv('A', 'plain')).toBe('"A=plain"');
    expect(quoteEnv('A', 'with "quotes"')).toBe('"A=with \\"quotes\\""');
    expect(quoteEnv('A', 'back\\slash')).toBe('"A=back\\\\slash"');
    // systemd expands %-specifiers inside Environment=; a literal % is doubled.
    expect(quoteEnv('A', '$HOME %i')).toBe('"A=$HOME %%i"');
    expect(quoteEnv('RATE', '50%')).toBe('"RATE=50%%"');
    expect(renderUnit({ ...APP, env: { TPL: '%d of %h' } })).toContain('Environment="TPL=%%d of %%h"');
  });
  it('keeps the unit and its directory readable by root only', () => {
    const src = fs.readFileSync(new URL('../src/ops/apps.js', import.meta.url), 'utf8');
    expect(src).toMatch(/function writeAtomic\(file, content, mode = 0o600\)/);
    expect(src).toMatch(/mkdirSync\(path\.dirname\(file\), \{ recursive: true, mode: 0o700 \}\)/);
    expect(src).not.toMatch(/0o644|0o755/);
  });
  it('parses systemctl show and ss output', () => {
    const s = parseShow('LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=linked\nMainPID=4242\nMemoryCurrent=1048576\nNRestarts=2\nResult=success\n');
    expect(s).toMatchObject({ installed: true, active: true, state: 'active', subState: 'running', enabled: true, pid: 4242, memoryBytes: 1048576, restarts: 2 });
    expect(parseShow('LoadState=not-found\nActiveState=inactive\n')).toMatchObject({ installed: false, active: false, state: 'absent', pid: null });
    expect(parseShow('LoadState=loaded\nActiveState=failed\nResult=exit-code\nMemoryCurrent=[not set]\n')).toMatchObject({ state: 'failed', result: 'exit-code', memoryBytes: null });
    const ports = parseListening('State  Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0      128    0.0.0.0:22       0.0.0.0:*\nLISTEN 0      511    127.0.0.1:31000  0.0.0.0:*\nLISTEN 0      511    [::]:31001       [::]:*\nESTAB  0      0      10.0.0.5:22      10.0.0.9:51234\n');
    expect([...ports].sort()).toEqual([22, 31000, 31001]);
  });
});

describe('interpreters', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-apps-')); process.env.WHM_NODE_DIR = tmp; });
  afterEach(() => { delete process.env.WHM_NODE_DIR; fs.rmSync(tmp, { recursive: true, force: true }); });
  it('resolves a Keel Node.js build, the system node and python minors; missing ones are refused', () => {
    fs.mkdirSync(path.join(tmp, '22', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '22', 'bin', 'node'), '');
    expect(interpreterFor('node', '22')).toEqual({ bin: path.join(tmp, '22', 'bin', 'node'), npm: path.join(tmp, '22', 'bin', 'npm'), binDir: path.join(tmp, '22', 'bin') });
    expect(() => interpreterFor('node', '20')).toThrow(/not installed/);
    resolveBinary.mockImplementation((n) => ({ node: '/usr/bin/node', npm: '/usr/bin/npm', 'python3.12': '/usr/bin/python3.12' }[n] || null));
    expect(interpreterFor('node', 'system')).toEqual({ bin: '/usr/bin/node', npm: '/usr/bin/npm', binDir: '/usr/bin' });
    expect(interpreterFor('python', '3.12')).toEqual({ bin: '/usr/bin/python3.12', binDir: '/usr/bin' });
    expect(() => interpreterFor('python', '3.9')).toThrow(/not installed/);
    expect(() => interpreterFor('python', 'system')).toThrow(/not installed/);
  });
});

describe('apps schemas refuse injection before anything runs', () => {
  const base = { username: 'alice', name: 'probe-app', type: 'node', dir: 'apps/probe-app', entry: 'server.js', runtime: '22', port: 31000 };
  it('names, paths, runtimes, ports and variables', async () => {
    const bad = [
      { name: 'A' }, { name: 'x' }, { name: 'a b' }, { name: 'a;b' }, { name: 'x'.repeat(33) },
      { dir: '/etc' }, { dir: '../x' }, { dir: 'a/../b' }, { dir: '-x' }, { dir: 'a b' }, { dir: 'a"b' }, { dir: 'a%b' }, { dir: 'x\0y' },
      { entry: '../server.js' }, { entry: 'a;b' }, { entry: 'server.js extra' }, { entry: '$(id)' },
      { runtime: 'latest' }, { runtime: '3.12' }, { runtime: '22.1' }, { type: 'python', runtime: '22' }, { type: 'python', runtime: '3' }, { type: 'ruby' },
      { port: 80 }, { port: 70000 }, { port: '31000' },
      { env: { PORT: '80' } }, { env: { HOME: '/tmp' } }, { env: { lower: 'x' } }, { env: { '1X': 'x' } }, { env: { X: 'a\nb' } }, { env: { X: 'x'.repeat(1025) } }, { env: { X: 1 } },
      { memoryMax: '256' }, { memoryMax: '0M' }, { memoryMax: '1T' }, { username: 'root; id' }, { username: 'Alice' }, { extra: 1 },
    ];
    for (const over of bad) {
      const err = await opError(runOp('apps.unit.write', { ...base, ...over }, ctx));
      expect(err.code, JSON.stringify(over)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
    for (const v of ['probe-app', 'a1', 'my-app-22']) expect(APP_NAME_RE.test(v), v).toBe(true);
    for (const v of ['apps/x', 'x', 'a.b/c_d-e', '.hidden/app']) expect(APP_REL_RE.test(v), v).toBe(true);
    for (const k of ['APP_SECRET', 'X', '_Y1']) expect(ENV_KEY_RE.test(k), k).toBe(true);
    expect([...RESERVED_ENV]).toEqual(['PORT', 'HOME', 'USER', 'LOGNAME', 'PATH']);
  });
  it('control, logs, deps and port args', async () => {
    for (const args of [{ username: 'alice', name: 'probe-app', action: 'kill' }, { username: 'alice', name: 'probe-app', action: 'start', extra: 1 }, { username: 'alice', name: '../x', action: 'start' }]) expect((await opError(runOp('apps.unit.control', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    for (const args of [{ username: 'alice', name: 'probe-app', lines: 0 }, { username: 'alice', name: 'probe-app', lines: 501 }, { username: 'alice', name: 'probe-app', lines: '10' }]) expect((await opError(runOp('apps.unit.logs', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    for (const args of [{ username: 'alice', dir: '../x', type: 'node', runtime: '22' }, { username: 'alice', dir: 'apps/x', type: 'node', runtime: 'latest' }, { username: 'alice', dir: 'apps/x', type: 'node' }]) expect((await opError(runOp('apps.deps.install', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    for (const args of [{ port: 80 }, { port: 'x' }, {}]) expect((await opError(runOp('apps.port.free', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });
  it('an unknown or system account is refused before any file is read', async () => {
    for (const username of ['no-such-user-xyz', 'root', 'www-data']) {
      const err = await opError(runOp('apps.unit.write', { ...base, username }, ctx));
      expect(['not_found', 'refused'], username).toContain(err.code);
    }
    expect(exec).not.toHaveBeenCalled();
  });
  it('the unit file must sit under an allowed root', async () => {
    const closed = createContext({ allowedRoots: ['/home'] });
    const err = await opError(runOp('apps.unit.remove', { username: 'alice', name: 'probe-app' }, closed));
    expect(err.code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('read-only ops', () => {
  it('apps.unit.logs reads the journal of the unit only', async () => {
    exec.mockImplementation(() => ok('started\nGET /probe-app/ 200\n'));
    const r = await runOp('apps.unit.logs', { username: 'alice', name: 'probe-app', lines: 50 }, ctx);
    expect(r).toEqual({ unit: 'keel-app-alice.probe-app', lines: ['started', 'GET /probe-app/ 200'] });
    expect(exec).toHaveBeenCalledWith('journalctl', ['-u', 'keel-app-alice.probe-app.service', '-n', '50', '--no-pager', '-o', 'cat'], expect.objectContaining({ allowFailure: true }));
  });
  it('apps.unit.status maps systemctl show', async () => {
    exec.mockImplementation(() => ok('LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=linked\nMainPID=7\nNRestarts=0\n'));
    const r = await runOp('apps.unit.status', { username: 'alice', name: 'probe-app' }, ctx);
    expect(r).toMatchObject({ unit: 'keel-app-alice.probe-app', installed: true, active: true, pid: 7, enabled: true });
    expect(exec.mock.calls[0][0]).toBe('systemctl');
    expect(exec.mock.calls[0][1].slice(0, 2)).toEqual(['show', 'keel-app-alice.probe-app.service']);
  });
  it('apps.port.free asks ss and reports an unknown state without it', async () => {
    exec.mockImplementation(() => ok('State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 511 127.0.0.1:31000 0.0.0.0:*\n'));
    expect(await runOp('apps.port.free', { port: 31000 }, ctx)).toEqual({ port: 31000, free: false, checked: true });
    expect(await runOp('apps.port.free', { port: 31001 }, ctx)).toEqual({ port: 31001, free: true, checked: true });
    expect(exec).toHaveBeenCalledWith('ss', ['-ltn'], expect.anything());
    hasBinary.mockReturnValue(false);
    expect(await runOp('apps.port.free', { port: 31001 }, ctx)).toEqual({ port: 31001, free: null, checked: false });
  });
});

describe('vhost proxies (web.vhost.write)', () => {
  const VHOST = { domain: 'example.com', aliases: [], docroot: '/home/alice/public_html', user: 'alice', redirects: [], customDirectives: '', meta: {}, port: 80, sslPort: 443, phpVersion: '8.3', ssl: { cert: '/etc/ssl/whm/example.com/cert.pem', key: '/etc/ssl/whm/example.com/key.pem' } };
  it('renders ProxyPass blocks inside proxy_http_module, longest mount first, with the WebSocket rewrite when asked', () => {
    const text = renderVhost({ ...VHOST, proxies: [{ path: '/', port: 31002, websocket: false }, { path: '/probe-app', port: 31000, websocket: true }, { path: '/probe-app/admin', port: 31001, websocket: false }] });
    expect(text).toContain('# whm-vhost ');
    expect(JSON.parse(text.split('\n')[1].slice('# whm-vhost '.length)).proxies).toBe(3);
    const block = text.slice(text.indexOf('# Applications'), text.indexOf('</VirtualHost>'));
    // The ACME exception precedes every mount (mod_proxy takes the first
    // matching ProxyPass) and the rewrite skips /.well-known/, so a root mount
    // never swallows the certbot webroot; the rewrite needs mod_rewrite too.
    const order = ['<IfModule proxy_http_module>', 'ProxyPreserveHost On', 'ProxyPass "/.well-known/acme-challenge/" "!"', '<IfModule proxy_wstunnel_module>', '<IfModule rewrite_module>', 'RewriteEngine On', 'RewriteCond %{REQUEST_URI} !^/\\.well-known/', 'RewriteCond %{HTTP:Upgrade} websocket [NC]', 'RewriteRule "^/probe-app/(.*)$" "ws://127.0.0.1:31000/$1" [P,L]', '</IfModule>', '</IfModule>',
      'RedirectMatch 301 "^/probe-app/admin$" "/probe-app/admin/"', 'ProxyPass "/probe-app/admin/" "http://127.0.0.1:31001/"', 'ProxyPassReverse "/probe-app/admin/" "http://127.0.0.1:31001/"',
      'RedirectMatch 301 "^/probe-app$" "/probe-app/"', 'ProxyPass "/probe-app/" "http://127.0.0.1:31000/"', 'ProxyPass "/" "http://127.0.0.1:31002/"', 'ProxyPassReverse "/" "http://127.0.0.1:31002/"', '</IfModule>'];
    let at = -1;
    for (const needle of order) { const i = block.indexOf(needle, at + 1); expect(i, needle).toBeGreaterThan(at); at = i; }
    expect(block).not.toContain('RedirectMatch 301 "^$"');
    expect(block.indexOf('ProxyPass "/.well-known/acme-challenge/" "!"')).toBeLessThan(block.indexOf('ProxyPass "/" '));
    expect(block.indexOf('RewriteEngine On')).toBeGreaterThan(block.indexOf('<IfModule rewrite_module>'));
    // Both the HTTP and the TLS vhost carry the mounts; the PHP handler stays.
    expect(text.match(/ProxyPass "\/probe-app\/"/g)).toHaveLength(2);
    expect(text).toContain('SetHandler "proxy:unix:');
  });
  it('a vhost without proxies is rendered exactly as before', () => {
    const text = renderVhost({ ...VHOST, proxies: [] });
    expect(text).not.toContain('proxy_http_module');
    expect(text).not.toContain('# Applications');
    expect(renderVhost(VHOST)).toBe(text);
    expect(renderProxies([])).toEqual([]);
    const plain = renderProxies([{ path: '/x', port: 31000, websocket: false }]);
    expect(plain.join('\n')).not.toContain('RewriteEngine On');
    expect(plain.join('\n')).not.toContain('rewrite_module');
    expect(plain.indexOf('    ProxyPass "/.well-known/acme-challenge/" "!"')).toBeLessThan(plain.indexOf('    ProxyPass "/x/" "http://127.0.0.1:31000/"'));
  });
  it('the schema refuses bad mounts, low ports and duplicate paths', async () => {
    hasBinary.mockReturnValue(false);
    const args = { domain: 'example.com', docroot: '/home/alice/public_html', user: 'alice' };
    for (const proxies of [[{ path: 'app', port: 31000 }], [{ path: '/a b', port: 31000 }], [{ path: '/../x', port: 31000 }], [{ path: '/a/..', port: 31000 }], [{ path: '/x?y', port: 31000 }], [{ path: '/x', port: 80 }], [{ path: '/x', port: 31000, websocket: 'yes' }], [{ path: '/x', port: 31000, extra: 1 }], [{ path: '/x', port: 31000 }, { path: '/x/', port: 31001 }]]) {
      const err = await opError(runOp('web.vhost.write', { ...args, proxies }, ctx));
      expect(err.code, JSON.stringify(proxies)).toBe('invalid_args');
    }
    for (const p of ['/', '/app', '/a/b.c-d_e', '/.well-known']) expect(PROXY_PATH_RE.test(p), p).toBe(true);
    for (const p of ['', 'app', '/a b', '/../x', '/./x', '/a/../b', '/x?y', '/x#y', '/x;y']) expect(PROXY_PATH_RE.test(p), p).toBe(false);
  });
  it('web.modules.* accept only the proxy modules, mod_rewrite and mod_headers', async () => {
    for (const modules of [['php8.3'], ['proxy', 'userdir'], ['ssl'], [], ['proxy; id'], 'proxy']) {
      expect((await opError(runOp('web.modules.enable', { modules }, ctx))).code, JSON.stringify(modules)).toBe('invalid_args');
      if (Array.isArray(modules) && modules.length) expect((await opError(runOp('web.modules.status', { modules }, ctx))).code, JSON.stringify(modules)).toBe('invalid_args');
    }
    expect(PROXY_MODULES).toEqual(['proxy', 'proxy_http', 'proxy_wstunnel', 'rewrite']);
    expect(exec).not.toHaveBeenCalled();
  });
});
