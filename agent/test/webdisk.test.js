import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { renderUnit, parseUnitMeta, unitName, unitFile, baseUrl, WEBDISK_LOGIN_RE, UNIT_PREFIX, HTPASSWD_REL, CACHE_REL } from '../src/ops/webdisk.js';
import { parseShow, installUnit, removeUnit, MANAGED_PREFIX } from '../src/ops/unit-helpers.js';
import { renderHostProxyApp } from '../src/ops/web.js';
import { parseShow as appsParseShow, renderUnit as renderAppUnit, APPS_DIR } from '../src/ops/apps.js';

// exec, hasBinary and resolveBinary are spied so no systemctl, rclone, mkdir,
// chmod or dd ever runs from a test; ops with side effects are checked up to
// the point where the schema, the account lookup or the path check refuses them.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary), resolveBinary: vi.fn(mod.resolveBinary) };
});
const { exec, hasBinary, resolveBinary } = await import('../src/exec.js');

const ctx = createContext();
const ok = (stdout = '', code = 0) => Promise.resolve({ code, stdout, stderr: '' });
const HASH = `$2b$12$${'C6UzMDM.H6dfI/f/IKcEeO5Sh1k1k7Mx.Y1R8z0q0Qm1l2n3o4p5q'.slice(0, 53).padEnd(53, 'x')}`;

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

beforeEach(() => { exec.mockReset(); hasBinary.mockReset(); resolveBinary.mockReset(); hasBinary.mockReturnValue(true); resolveBinary.mockImplementation((n) => `/usr/bin/${n}`); });

describe('webdisk op catalog', () => {
  it('registers the unit and htpasswd ops with the right destructive flags, next to the apps ops they share helpers with', () => {
    for (const name of ['webdisk.unit.write', 'webdisk.unit.remove', 'webdisk.unit.control', 'webdisk.unit.status', 'webdisk.htpasswd.set', 'webdisk.htpasswd.remove']) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('webdisk.unit.remove').destructive).toBe(true);
    expect(catalog.get('webdisk.unit.control').destructive).toBe(true);
    expect(catalog.get('webdisk.htpasswd.remove').destructive).toBe(true);
    expect(catalog.get('webdisk.unit.status').destructive).toBe(false);
    expect(catalog.get('webdisk.htpasswd.set').destructive).toBe(false);
    for (const name of ['apps.unit.write', 'apps.unit.remove', 'apps.unit.control', 'apps.unit.status']) expect(catalog.has(name), name).toBe(true);
    expect(unitName('alice')).toBe('keel-webdisk-alice');
    expect(unitFile('alice')).toBe(`${APPS_DIR}/alice/keel-webdisk-alice.service`);
    expect(baseUrl('alice')).toBe('/webdisk/alice');
    expect(UNIT_PREFIX).toBe('keel-webdisk');
    expect(HTPASSWD_REL).toBe('.keel/webdisk.htpasswd');
    expect(ctx.allowedRoots).toContain('/etc/whm/apps');
    expect(ctx.allowedRoots).not.toContain('/etc/systemd/system');
    expect(appsParseShow).toBe(parseShow);
  });
  it('no op module imports lib.js (unit-helpers.js included)', () => {
    for (const f of ['webdisk.js', 'unit-helpers.js', 'apps.js']) expect(fs.readFileSync(new URL(`../src/ops/${f}`, import.meta.url), 'utf8')).not.toMatch(/from\s+['"]\.\.\/lib\.js['"]/);
  });
});

describe('unit template', () => {
  const args = { username: 'alice', port: 31000, home: '/home/alice', gid: 1001, rclone: '/usr/bin/rclone' };
  it('renders a hardened unit that runs rclone serve webdav as the account on loopback with its base URL and htpasswd', () => {
    const text = renderUnit(args);
    const lines = text.split('\n');
    expect(lines[0].startsWith(MANAGED_PREFIX)).toBe(true);
    expect(parseUnitMeta(text)).toEqual({ username: 'alice', port: 31000, baseUrl: '/webdisk/alice' });
    for (const l of ['[Unit]', '[Service]', '[Install]', 'User=alice', 'Group=1001', 'WorkingDirectory=/home/alice', 'Environment="HOME=/home/alice"', 'Restart=on-failure', 'NoNewPrivileges=true', 'ProtectSystem=strict',
      'ReadWritePaths=/home/alice', 'PrivateTmp=true', 'ProtectKernelTunables=true', 'RestrictSUIDSGID=true', 'SyslogIdentifier=keel-webdisk-alice', 'WantedBy=multi-user.target']) expect(lines, l).toContain(l);
    const exec = lines.find((l) => l.startsWith('ExecStart='));
    expect(exec).toBe(`ExecStart=/usr/bin/rclone serve webdav /home/alice --addr 127.0.0.1:31000 --baseurl /webdisk/alice --htpasswd /home/alice/${HTPASSWD_REL} --config /dev/null --cache-dir /home/alice/${CACHE_REL} --vfs-cache-mode writes --dir-cache-time 5s --umask 022 --log-level NOTICE --exclude /.ssh/** --exclude /.keel/**`);
    expect(text).not.toMatch(/\bsh\b|bash|-c |0\.0\.0\.0|\[::\]/);
    expect(text).not.toContain('--user ');
    expect(text).not.toContain('--pass');
    expect(renderAppUnit({ username: 'alice', name: 'x', type: 'node', dir: 'apps/x', entry: 'server.js', runtime: '22', port: 31001, home: '/home/alice', gid: 1001, execBin: '/usr/bin/node' }).startsWith(MANAGED_PREFIX)).toBe(true);
  });
  it('parseUnitMeta ignores foreign or broken marker lines', () => {
    expect(parseUnitMeta('# whm-app {"username":"alice"}\n')).toBeNull();
    expect(parseUnitMeta('# whm-webdisk {broken\n')).toBeNull();
    expect(parseUnitMeta('')).toBeNull();
  });
});

describe('hostname-site proxy drop-in for Web Disk', () => {
  it('keeps the prefix on the way upstream and preserves the Host header when asked', () => {
    const spec = { name: 'webdisk-alice', alias: '/webdisk/alice', access: 'all', allowFrom: [], options: ['None'], allowOverride: 'None', denyDirs: [], php: false, proxy: { port: 31000, scriptName: '/webdisk/alice', path: '/webdisk/alice', preserveHost: true } };
    const text = renderHostProxyApp(spec, '/webdisk/alice', { name: spec.name, alias: spec.alias, root: null, php: false });
    expect(text).toContain('ProxyPass "/webdisk/alice/" "http://127.0.0.1:31000/webdisk/alice/" retry=0');
    expect(text).toContain('ProxyPassReverse "/webdisk/alice/" "http://127.0.0.1:31000/webdisk/alice/"');
    expect(text).toContain('RedirectMatch 301 "^/webdisk/alice$" "/webdisk/alice/"');
    expect(text).toContain('    ProxyPreserveHost On');
    expect(text).toContain('RequestHeader set X-Script-Name "/webdisk/alice"');
    expect(text.indexOf('ProxyPreserveHost On')).toBeGreaterThan(text.indexOf('<Location "/webdisk/alice/">'));
    expect(JSON.parse(text.split('\n')[1].slice(text.split('\n')[1].indexOf('{'))).proxy).toEqual({ port: 31000, scriptName: '/webdisk/alice', target: 'http://127.0.0.1:31000/webdisk/alice/' });
    // Radicale's form is unchanged: no path, no Host preservation.
    const dav = renderHostProxyApp({ ...spec, name: 'dav', alias: '/dav', proxy: { port: 5232, scriptName: '/dav', preserveHost: false } }, '/dav', { name: 'dav', alias: '/dav', root: null, php: false });
    expect(dav).toContain('ProxyPass "/dav/" "http://127.0.0.1:5232/" retry=0');
    expect(dav).not.toContain('ProxyPreserveHost');
  });
  it('the host app schema accepts the new proxy fields and refuses bad ones', async () => {
    hasBinary.mockReturnValue(false);
    const base = { name: 'webdisk-alice', alias: '/webdisk/alice', php: false, options: ['None'] };
    for (const proxy of [{ port: 31000, path: 'webdisk/alice' }, { port: 31000, path: '/../x' }, { port: 31000, preserveHost: 'yes' }, { port: 31000, extra: 1 }, { port: 80 }]) {
      const err = await opError(runOp('web.host.app.write', { ...base, proxy }, ctx));
      expect(err.code, JSON.stringify(proxy)).toBe('invalid_args');
    }
    // A well-formed spec gets past the schema and stops at the missing Apache.
    const err = await opError(runOp('web.host.app.write', { ...base, proxy: { port: 31000, scriptName: '/webdisk/alice', path: '/webdisk/alice', preserveHost: true } }, ctx));
    expect(err.code).not.toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('webdisk schemas refuse injection before anything runs', () => {
  it('ports, logins, hashes, actions and unknown fields', async () => {
    for (const over of [{ port: 80 }, { port: 70000 }, { port: '31000' }, { port: 31000, extra: 1 }, { username: 'root; id' }, { username: 'Alice' }, {}]) {
      const err = await opError(runOp('webdisk.unit.write', { username: 'alice', ...over }, ctx));
      expect(err.code, JSON.stringify(over)).toBe('invalid_args');
    }
    for (const over of [{ login: '' }, { login: 'alice:x' }, { login: 'alice\nroot' }, { login: 'Alice' }, { login: 'a b' }, { hash: 'plain-password' }, { hash: '$1$abc' }, { hash: `${HASH}\nroot:x` }, { hash: HASH.slice(0, -1) }, { extra: 1 }]) {
      const err = await opError(runOp('webdisk.htpasswd.set', { username: 'alice', login: 'alice', hash: HASH, ...over }, ctx));
      expect(err.code, JSON.stringify(over)).toBe('invalid_args');
    }
    for (const args of [{ username: 'alice', action: 'kill' }, { username: 'alice', action: 'start', extra: 1 }, { username: '../x', action: 'start' }, { username: 'alice' }]) expect((await opError(runOp('webdisk.unit.control', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    for (const args of [{ username: 'alice', extra: 1 }, {}, { username: 'a b' }]) {
      expect((await opError(runOp('webdisk.unit.remove', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
      expect((await opError(runOp('webdisk.unit.status', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
      expect((await opError(runOp('webdisk.htpasswd.remove', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
    // A one-character account name (arg.username allows it) is a valid login.
    for (const v of ['alice', 'a1', 'my.user_1-x', 'x', 'x'.repeat(64)]) expect(WEBDISK_LOGIN_RE.test(v), v).toBe(true);
    for (const v of ['', 'alice:x', 'Alice', 'a b', 'a\nb', '-alice', '.alice', 'x'.repeat(65)]) expect(WEBDISK_LOGIN_RE.test(v), v).toBe(false);
  });
  it('an unknown or system account is refused before any file is read or anything runs', async () => {
    for (const username of ['no-such-user-xyz', 'root', 'www-data']) {
      for (const [op, args] of [['webdisk.unit.write', { username, port: 31000 }], ['webdisk.htpasswd.set', { username, login: 'alice', hash: HASH }], ['webdisk.htpasswd.remove', { username }], ['webdisk.unit.status', { username }]]) {
        const err = await opError(runOp(op, args, ctx));
        expect(['not_found', 'refused'], `${op} ${username}`).toContain(err.code);
      }
    }
    expect(exec).not.toHaveBeenCalled();
  });
  it('the unit file must sit under an allowed root; rclone missing is a capability error', async () => {
    const closed = createContext({ allowedRoots: ['/home'] });
    const err = await opError(runOp('webdisk.unit.remove', { username: 'alice' }, closed));
    expect(err.code).toBe('path_not_allowed');
    resolveBinary.mockReturnValue(null);
    const missing = await opError(runOp('webdisk.unit.write', { username: 'alice', port: 31000 }, ctx));
    expect(missing.code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('shared unit machinery (unit-helpers.js)', () => {
  it('parseShow maps systemctl show output', () => {
    expect(parseShow('LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=linked\nMainPID=7\nNRestarts=2\nMemoryCurrent=1024\n')).toMatchObject({ installed: true, active: true, state: 'active', enabled: true, pid: 7, restarts: 2, memoryBytes: 1024 });
    expect(parseShow('LoadState=not-found\nActiveState=inactive\n')).toMatchObject({ installed: false, active: false, state: 'absent', enabled: false, pid: null });
  });
  it('installUnit writes the file 0600, links it once, enables and restarts; removeUnit refuses a foreign file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-webdisk-'));
    const file = path.join(dir, 'alice', 'keel-webdisk-alice.service');
    exec.mockImplementation((bin, argv) => (argv[0] === 'show' ? ok('LoadState=loaded\nActiveState=active\nUnitFileState=linked\nMainPID=9\n') : ok()));
    const r = await installUnit({ unit: 'keel-webdisk-alice', file, content: renderUnit({ username: 'alice', port: 31000, home: '/home/alice', gid: 1001, rclone: '/usr/bin/rclone' }) });
    expect(r).toMatchObject({ unit: 'keel-webdisk-alice', path: file, started: true, startError: null, status: { active: true, pid: 9 } });
    expect(fs.readFileSync(file, 'utf8').startsWith(MANAGED_PREFIX)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const argv = exec.mock.calls.map((c) => `${c[0]} ${c[1].join(' ')}`);
    expect(argv).toContain(`systemctl link ${file}`);
    expect(argv).toContain('systemctl enable keel-webdisk-alice.service');
    expect(argv).toContain('systemctl restart keel-webdisk-alice.service');
    expect(fs.readdirSync(path.dirname(file)).some((n) => n.includes('.whm-tmp-'))).toBe(false);
    fs.writeFileSync(file, '[Unit]\nDescription=hand written\n');
    const err = await opError(removeUnit({ unit: 'keel-webdisk-alice', file }));
    expect(err.code).toBe('refused');
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
