import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import {
  appId, unitName, envKey, envValue, argToken, basePath, nodeVersion, scriptName, pipPackage, moduleSpec, gitUrl, gitRef, unitPath,
  renderUnit, renderEnvFile, renderAppsInclude, modulesFor, supportsUpgradeWebsocket, apacheVersionNumber,
  detectHints, parsePackageJson, parseRequirements, parseAngularProjects, stepEnv, SCAFFOLDS, assertRuntimeBin, assertExecBin,
} from '../src/ops/app.js';
import { apacheLayout } from '../src/ops/web.js';

// Application Manager agent family. exec is spied with the real implementation
// behind it so every refusal is proven to happen before a program runs; the
// ops that act as the account user are exercised against a fake runuser. The
// managed account comes from a synthetic /etc/passwd entry whose home lives
// under /tmp/whm (an allowed root), so no real home is ever touched.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary } = await import('../src/exec.js');
const realExec = exec.getMockImplementation();
const realHasBinary = hasBinary.getMockImplementation();

const ctx = createContext();
const TMP_ROOT = '/tmp/whm';
const USER = 'whmapptest';
const myUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const UID = myUid === 0 ? 4242 : myUid;
// Ownership checks need directories owned by the test account: root can chown,
// a regular developer account owns what it creates; anything else skips them.
const canOwn = myUid === 0 || myUid >= 1000;
let base;
let home;
let runtimes;
let appsDir;
let tmpRootExisted;

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

const own = (p) => { if (myUid === 0) fs.lchownSync(p, UID, UID); return p; };
function mkOwned(p) {
  const parts = [];
  for (let cur = p; cur !== home && cur !== path.dirname(cur); cur = path.dirname(cur)) parts.unshift(cur);
  for (const dir of parts) { if (!fs.existsSync(dir)) { fs.mkdirSync(dir); own(dir); } }
  return p;
}
function writeOwned(file, content) {
  mkOwned(path.dirname(file));
  fs.writeFileSync(file, content);
  return own(file);
}
const okResult = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr, bin: 'runuser', argv: [] });
const restore = () => {
  exec.mockReset();
  exec.mockImplementation(realExec);
  hasBinary.mockReset();
  hasBinary.mockImplementation(realHasBinary);
};
function fakeUser(handler) {
  exec.mockImplementation(async (bin, argv, opts) => {
    expect(bin).toBe('runuser');
    expect(argv.slice(0, 3)).toEqual(['-u', USER, '--']);
    return (await handler(argv.slice(3), opts)) ?? okResult();
  });
}
const calls = () => exec.mock.calls.map(([bin, argv, opts]) => ({ bin, argv, opts }));

beforeAll(() => {
  tmpRootExisted = fs.existsSync(TMP_ROOT);
  fs.mkdirSync(TMP_ROOT, { recursive: true, mode: 0o700 });
  base = fs.mkdtempSync(`${TMP_ROOT}/app-`);
  home = path.join(base, 'home', USER);
  runtimes = path.join(base, 'runtimes');
  appsDir = path.join(base, 'apps');
  fs.mkdirSync(home, { recursive: true });
  own(home);
  process.env.WHM_RUNTIMES_ROOT = runtimes;
  process.env.WHM_APPS_DIR = appsDir;
  const readFileSync = fs.readFileSync;
  const passwd = `${readFileSync('/etc/passwd', 'utf8').trimEnd()}\n${USER}:x:${UID}:${UID}:WHM app test:${home}:/bin/bash\n`;
  const group = `${readFileSync('/etc/group', 'utf8').trimEnd()}\n${USER}:x:${UID}:\n`;
  vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
    if (p === '/etc/passwd') return passwd;
    if (p === '/etc/group') return group;
    return readFileSync.call(fs, p, ...rest);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  delete process.env.WHM_RUNTIMES_ROOT;
  delete process.env.WHM_APPS_DIR;
  fs.rmSync(base, { recursive: true, force: true });
  if (!tmpRootExisted) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

afterEach(() => restore());

describe('app op catalog', () => {
  it('registers the family with destructive flags and long-operation timeouts', async () => {
    for (const name of ['app.runtime.detect', 'app.runtime.node.install', 'app.runtime.node.remove', 'app.inspect', 'app.prepare', 'app.pull', 'app.step', 'app.unit.write', 'app.unit.remove', 'app.proxy.write', 'app.static.expose', 'app.purge']) expect(catalog.has(name), name).toBe(true);
    for (const name of ['app.runtime.node.remove', 'app.unit.remove', 'app.purge']) expect(catalog.get(name).destructive, name).toBe(true);
    for (const name of ['app.inspect', 'app.step', 'app.unit.write', 'app.proxy.write']) expect(catalog.get(name).destructive, name).toBe(false);
    expect(catalog.get('app.runtime.node.install').timeoutMs).toBe(900_000);
    expect(catalog.get('app.prepare').timeoutMs).toBe(900_000);
    expect(catalog.get('app.pull').timeoutMs).toBe(600_000);
    expect(catalog.get('app.step').timeoutMs).toBe(1_800_000);
    expect(catalog.get('app.purge').timeoutMs).toBe(600_000);
    expect((await opError(runOp('app.shell', { cmd: 'id' }, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('app.unit.start', { id: 1 }, ctx))).code).toBe('unknown_op');
  });
});

describe('shared validators', () => {
  const ok = (schema, v) => expect(schema.safeParse(v).success, JSON.stringify(v)).toBe(true);
  const bad = (schema, v) => expect(schema.safeParse(v).success, JSON.stringify(v)).toBe(false);

  it('appId, unitName, envKey, envValue', () => {
    for (const v of [1, 42, 1_000_000]) ok(appId, v);
    for (const v of [0, -1, 1.5, '1', 1_000_001, null]) bad(appId, v);
    expect(unitName(7)).toBe('whm-app-7');
    for (const v of ['PORT', 'A_1', '_X', 'A'.repeat(64)]) ok(envKey, v);
    for (const v of ['port', '1A', 'A-B', 'A B', '', 'A'.repeat(65), 'A=B']) bad(envKey, v);
    for (const v of ['', 'x y "z" $PATH %d `id` ; | & < >', 'a'.repeat(4096)]) ok(envValue, v);
    for (const v of ['a\nb', 'a\rb', 'a\0b', 'a'.repeat(4097)]) bad(envValue, v);
  });

  it('argToken refuses whitespace, quotes, $, %, ; and shell operators', () => {
    for (const v of ['--port=3000', 'dist/main.js', 'a:b,c+d@e', '-', 'x'.repeat(256)]) ok(argToken, v);
    for (const v of ['a b', '"a"', "'a'", '$HOME', '%i', 'a;b', 'a&b', 'a|b', '<a', 'a>', 'a\\b', '', 'a\tb', 'a\nb', '*', 'a`b`', 'x'.repeat(257), '(a)', '{a}']) bad(argToken, v);
  });

  it('basePath, nodeVersion, scriptName', () => {
    for (const v of ['/', '/api', '/api/', '/a/b-c_d.e', '/v1/x/']) ok(basePath, v);
    for (const v of ['api', '', '/..', '/a/../b', '/a/..', '/./a', '/.', '/a b', '/a;b', '/a%20b', '//a', `/${'a'.repeat(128)}`, '/a?x=1', '/a#b']) bad(basePath, v);
    for (const v of ['20.11.0', '0.0.0', '999.999.999']) ok(nodeVersion, v);
    for (const v of ['v20.11.0', '20.11', '20.11.0-rc1', '1000.0.0', '20.11.0;x', '../20.11.0', '20.11.0/x', '']) bad(nodeVersion, v);
    for (const v of ['build', 'build:prod', 'test.unit', 'a_b']) ok(scriptName, v);
    for (const v of ['-x', '--help', 'a b', 'a;b', 'a$b', '', 'x'.repeat(65), 'a/b']) bad(scriptName, v);
  });

  it('pipPackage and moduleSpec', () => {
    for (const v of ['gunicorn', 'uvicorn[standard]', 'Django==4.2.1', 'a.b-c_d', 'x==1.0.post1', 'pkg[a,b]==2.0+local']) ok(pipPackage, v);
    for (const v of ['-r', '--index-url=x', 'a b', 'a;b', '../x', 'a==', 'gunicorn>=1', 'a/b', '', '.hidden', 'x'.repeat(101), 'a[]', 'a==1;x']) bad(pipPackage, v);
    for (const v of ['app:app', 'myproj.wsgi:application', '_m:_c', 'a1.b2:c3']) ok(moduleSpec, v);
    for (const v of ['app', 'app:', ':app', 'app:a-b', 'a b:c', '1a:b', 'a:b;c', 'a/b:c', 'a:b.c', '']) bad(moduleSpec, v);
  });

  it('gitUrl is https only, without credentials or query; gitRef never starts with -', () => {
    for (const v of ['https://github.com/org/repo.git', 'https://github.com/org/repo', 'https://git.example.com:8443/a/b', 'https://x/a/b/c.git']) ok(gitUrl, v);
    for (const v of ['http://github.com/a/b', 'https://user:pw@github.com/a/b', 'https://user@github.com/a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/b#x', 'ssh://git@x/a', 'git@github.com:a/b.git', 'https://github.com', 'https://github.com/', 'https://github.com/a b', 'file:///etc/passwd', 'https://github.com/a/b;c', `https://x/${'a'.repeat(512)}`, '', 'https://x/a/b$c']) bad(gitUrl, v);
    for (const v of ['main', 'v1.2.3', 'release/2026.10', 'HEAD', 'a'.repeat(128)]) ok(gitRef, v);
    for (const v of ['-x', '--all', 'a b', 'a;b', '', 'a'.repeat(129), 'a$b', 'a:b', 'a~1', 'a^']) bad(gitRef, v);
  });

  it('unitPath is an absolute path with no spaces, quotes, % or ..', () => {
    for (const v of ['/usr/bin/node', '/home/u/apps/a-b_c.d', '/opt/whm/runtimes/node/20.11.0/bin/node']) ok(unitPath, v);
    for (const v of ['relative', '/home/u/a b', '/home/u/a"b', "/home/u/a'b", '/home/u/%i', '/home/u/$x', '/home/u/../etc', '/home/u/a;b', '', '/home/u/a\\b', `/${'a'.repeat(1024)}`]) bad(unitPath, v);
  });
});

describe('schemas refuse injection before anything runs', () => {
  const invalid = async (op, args) => {
    expect((await opError(runOp(op, args, ctx))).code, `${op} ${JSON.stringify(args)}`).toBe('invalid_args');
  };
  const root = () => `${home}/apps/site`;

  it('usernames, paths and unknown keys', async () => {
    exec.mockClear();
    for (const username of ['-u', 'a;b', 'Alice', '../x', '', '$(id)', 'root;x', 'a'.repeat(33)]) {
      await invalid('app.inspect', { username, root: root() });
      await invalid('app.purge', { username, root: root() });
      await invalid('app.static.expose', { username, dir: root(), runUser: 'www-data' });
    }
    for (const p of ['apps/site', `${home}/../etc`, `${home}/apps/..`, `${home}/x\0y`, '']) {
      await invalid('app.inspect', { username: USER, root: p });
      await invalid('app.prepare', { username: USER, root: p });
      await invalid('app.pull', { username: USER, root: p });
      await invalid('app.purge', { username: USER, root: p });
      await invalid('app.step', { username: USER, root: p, step: 'npm-install', runtime: { kind: 'node', bin: '/usr/bin/node' } });
    }
    await invalid('app.inspect', { username: USER, root: root(), extra: 1 });
    await invalid('app.runtime.detect', { verbose: true });
    await invalid('app.unit.remove', { id: 1, force: true });
    await invalid('app.unit.remove', { id: 0 });
    await invalid('app.unit.remove', { id: '1' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('git sources, refs, scaffold templates and names', async () => {
    exec.mockClear();
    for (const url of ['http://github.com/a/b', 'https://user:pw@github.com/a/b', 'https://github.com/a/b?x=1', 'git@github.com:a/b.git', 'file:///etc/passwd', 'https://github.com/a b']) await invalid('app.prepare', { username: USER, root: root(), source: { gitUrl: url } });
    for (const ref of ['-x', '--upload-pack=id', 'a b', 'a;b', '']) {
      await invalid('app.prepare', { username: USER, root: root(), source: { gitUrl: 'https://github.com/a/b', ref } });
      await invalid('app.pull', { username: USER, root: root(), ref });
    }
    for (const scaffold of [{ template: 'rails', name: 'x' }, { template: 'express', name: 'a"b' }, { template: 'express', name: 'a;b' }, { template: 'express', name: 'a\nb' }, { template: 'express', name: '-x' }, { template: 'express', name: '' }, { template: 'express', name: `a${'b'.repeat(64)}` }, { template: 'express' }]) await invalid('app.prepare', { username: USER, root: root(), scaffold });
    await invalid('app.prepare', { username: USER, root: root(), source: { gitUrl: 'https://github.com/a/b' }, scaffold: { template: 'express', name: 'x' } });
    await invalid('app.prepare', { username: USER, root: root(), source: { gitUrl: 'https://github.com/a/b', depth: 5 } });
    expect(exec).not.toHaveBeenCalled();
  });

  it('build steps: step names, runtime binaries, scripts, packages and kind mismatches', async () => {
    exec.mockClear();
    const node = { kind: 'node', bin: '/usr/bin/node' };
    const python = { kind: 'python', bin: '/usr/bin/python3' };
    const step = (extra) => ({ username: USER, root: root(), runtime: node, ...extra });
    await invalid('app.step', step({ step: 'make' }));
    await invalid('app.step', step({ step: 'npm-run' }));
    for (const script of ['-x', 'a b', 'a;b', '']) await invalid('app.step', step({ step: 'npm-run', script }));
    for (const bin of ['/usr/bin/no de', '/usr/bin/%i', 'node', '/usr/bin/node;id', '/usr/bin/../bin/node']) await invalid('app.step', step({ step: 'npm-install', runtime: { kind: 'node', bin } }));
    await invalid('app.step', step({ step: 'npm-install', runtime: { kind: 'perl', bin: '/usr/bin/perl' } }));
    await invalid('app.step', step({ step: 'npm-install', runtime: python }));
    await invalid('app.step', step({ step: 'venv-create', runtime: node }));
    await invalid('app.step', step({ step: 'pip-install', runtime: python, packages: ['-r'] }));
    await invalid('app.step', step({ step: 'pip-install', runtime: python, packages: ['gunicorn; id'] }));
    await invalid('app.step', step({ step: 'pip-install', runtime: python, packages: Array.from({ length: 51 }, (_, i) => `p${i}`) }));
    await invalid('app.step', step({ step: 'npm-install', production: 'yes' }));
    expect(exec).not.toHaveBeenCalled();
  });

  it('unit files: ids, names, ExecStart tokens, env, ports, paths, modes and limits', async () => {
    exec.mockClear();
    const good = { id: 3, username: USER, name: 'Shop API', root: root(), exec: { bin: '/usr/bin/node', args: ['server.js'] }, port: 3000, env: { PORT_OVERRIDE: '1' }, pathDirs: ['/usr/bin'], mode: 'production', limits: { memoryMaxMb: 512, tasksMax: 256, cpuQuotaPercent: 100 } };
    const bad = [
      { id: 0 }, { id: -1 }, { id: 1.5 }, { id: 1_000_001 },
      { name: 'a"b' }, { name: 'a;b' }, { name: '%i' }, { name: '-x' }, { name: '' }, { name: `a${'b'.repeat(64)}` }, { name: 'a\nb' },
      { exec: { bin: '/usr/bin/node', args: ['a b'] } }, { exec: { bin: '/usr/bin/node', args: ['"a"'] } }, { exec: { bin: '/usr/bin/node', args: ['%i'] } }, { exec: { bin: '/usr/bin/node', args: ['$PORT'] } }, { exec: { bin: '/usr/bin/node', args: ['a;b'] } }, { exec: { bin: '/usr/bin/node', args: ['a|b'] } }, { exec: { bin: '/usr/bin/node', args: ['a\\b'] } },
      { exec: { bin: '/usr/bin/no de', args: [] } }, { exec: { bin: '/usr/bin/%n', args: [] } }, { exec: { bin: 'node', args: [] } }, { exec: { bin: '/usr/bin/node', args: Array.from({ length: 33 }, () => 'a') } }, { exec: { bin: '/usr/bin/node', args: ['a'], cwd: '/' } },
      { env: { port: '1' } }, { env: { 'A-B': '1' } }, { env: { A: 'x\ny' } }, { env: { A: 'x\0y' } }, { env: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, 'v'])) }, { env: { A: 1 } },
      { port: 80 }, { port: 70000 }, { port: '3000' }, { port: 1023 },
      { root: `${home}/apps/my site` }, { root: `${home}/apps/%i` }, { root: 'apps/site' }, { root: `${home}/apps/../etc` },
      { pathDirs: ['/usr/%i'] }, { pathDirs: ['relative'] }, { pathDirs: ['/a b'] }, { pathDirs: ['/a', '/b', '/c', '/d', '/e'] },
      { mode: 'test' }, { limits: { memoryMaxMb: 32 } }, { limits: { memoryMaxMb: 65537 } }, { limits: { tasksMax: 0 } }, { limits: { cpuQuotaPercent: 801 } }, { limits: { cpuQuotaPercent: 0 } }, { limits: { nice: 5 } },
      { username: 'root;x' }, { extra: true },
    ];
    for (const b of bad) await invalid('app.unit.write', { ...good, ...b });
    expect(exec).not.toHaveBeenCalled();
  });

  it('proxy includes: domains, base paths, kinds, ports, static directories and uniqueness', async () => {
    exec.mockClear();
    const proxy = { id: 1, kind: 'proxy', basePath: '/', port: 3000, websockets: true, spaFallback: true };
    const statik = { id: 2, kind: 'static', basePath: '/docs', staticDir: `${home}/apps/docs/dist`, websockets: false, spaFallback: true };
    for (const domain of ['Example.com', 'a b', '-x', '', 'a..b', 'x;y']) await invalid('app.proxy.write', { domain, apps: [proxy] });
    for (const bad of [
      { ...proxy, basePath: 'api' }, { ...proxy, basePath: '/a/../b' }, { ...proxy, basePath: '/a b' }, { ...proxy, port: undefined }, { ...proxy, port: 80 }, { ...proxy, kind: 'cgi' },
      { ...statik, staticDir: undefined }, { ...statik, staticDir: `${home}/apps/my dist` }, { ...statik, staticDir: `${home}/apps/x"y` }, { ...statik, staticDir: 'dist' }, { ...statik, staticDir: `${home}/../x` }, { ...statik, id: 0 }, { ...statik, websockets: 'yes' }, { ...statik, extra: 1 },
    ]) await invalid('app.proxy.write', { domain: 'example.com', apps: [bad] });
    await invalid('app.proxy.write', { domain: 'example.com', apps: [proxy, { ...statik, basePath: '/' }] });
    await invalid('app.proxy.write', { domain: 'example.com', apps: [{ ...proxy, basePath: '/api' }, { ...statik, basePath: '/api/' }] });
    await invalid('app.proxy.write', { domain: 'example.com', apps: Array.from({ length: 21 }, (_, i) => ({ ...proxy, id: i + 1, basePath: `/p${i}` })) });
    await invalid('app.proxy.write', { domain: 'example.com', apps: [proxy], reload: 'yes' });
    await invalid('app.proxy.write', { domain: 'example.com' });
    for (const runUser of ['www data', '-x', 'WWW', '', 'a'.repeat(33), 'www;data']) await invalid('app.static.expose', { username: USER, dir: root(), runUser });
    expect(exec).not.toHaveBeenCalled();
  });

  it('runtime versions', async () => {
    exec.mockClear();
    for (const version of ['v20.1.0', '20.1', '20.1.0/x', '../x', '20.1.0;id', '', 20]) {
      await invalid('app.runtime.node.install', { version });
      await invalid('app.runtime.node.remove', { version });
    }
    await invalid('app.runtime.node.install', { version: '20.1.0', force: true });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('managed account and application root checks', () => {
  it('refuses system accounts and unknown users for every account-scoped op without spawning anything', async () => {
    exec.mockClear();
    const ghost = `nouser${crypto.randomBytes(3).toString('hex')}`;
    const cases = [
      ['app.inspect', (u) => ({ username: u, root: `/home/${u}/apps/x` })],
      ['app.prepare', (u) => ({ username: u, root: `/home/${u}/apps/x` })],
      ['app.pull', (u) => ({ username: u, root: `/home/${u}/apps/x` })],
      ['app.step', (u) => ({ username: u, root: `/home/${u}/apps/x`, step: 'npm-install', runtime: { kind: 'node', bin: '/usr/bin/node' } })],
      ['app.unit.write', (u) => ({ username: u, id: 1, name: 'x', root: `/home/${u}/apps/x`, exec: { bin: '/usr/bin/node', args: [] }, port: 3000 })],
      ['app.static.expose', (u) => ({ username: u, dir: `/home/${u}/apps/x`, runUser: 'www-data' })],
      ['app.purge', (u) => ({ username: u, root: `/home/${u}/apps/x` })],
    ];
    for (const [op, args] of cases) {
      expect((await opError(runOp(op, args('root'), ctx))).code, `${op} root`).toBe('refused');
      expect((await opError(runOp(op, args('nobody'), ctx))).code, `${op} nobody`).toBe('refused');
      expect((await opError(runOp(op, args('daemon'), ctx))).code, `${op} daemon`).toBe('refused');
      expect((await opError(runOp(op, args(ghost), ctx))).code, `${op} ghost`).toBe('not_found');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it.skipIf(!canOwn)('pins the root inside the home: outside, the home itself, public_html for server apps, symlinks, foreign ownership', async () => {
    exec.mockClear();
    const real = mkOwned(`${home}/apps/real`);
    mkOwned(`${home}/public_html`);
    fs.symlinkSync(real, `${home}/apps/link`);
    const elsewhere = fs.mkdtempSync(`${TMP_ROOT}/elsewhere-`);
    fs.symlinkSync(elsewhere, `${home}/apps/escape`);
    fs.mkdirSync(`${home}/apps/escape-dir-link`);
    fs.symlinkSync(`${home}/apps/real`, `${home}/apps/escape-dir-link/inner`);
    fs.symlinkSync(elsewhere, `${home}/apps/outside-parent`);
    fs.writeFileSync(`${home}/apps/file`, 'x');
    own(`${home}/apps/file`);
    const foreign = mkOwned(`${home}/apps/foreign`);
    if (myUid === 0) fs.chownSync(foreign, 65534, 65534);
    const code = async (op, args) => (await opError(runOp(op, args, ctx))).code;
    const ops = {
      inspect: (root) => ['app.inspect', { username: USER, root }],
      step: (root) => ['app.step', { username: USER, root, step: 'npm-install', runtime: { kind: 'node', bin: '/usr/bin/node' } }],
      unit: (root) => ['app.unit.write', { username: USER, id: 1, name: 'x', root, exec: { bin: '/usr/bin/node', args: [] }, port: 3000 }],
      purge: (root) => ['app.purge', { username: USER, root }],
      expose: (root) => ['app.static.expose', { username: USER, dir: root, runUser: 'www-data' }],
      pull: (root) => ['app.pull', { username: USER, root }],
      prepare: (root) => ['app.prepare', { username: USER, root }],
    };
    for (const make of Object.values(ops)) {
      expect(await code(...make('/etc/apps/x'))).toBe('path_not_allowed');
      expect(await code(...make('/home/someoneelse/apps/x'))).toBe('refused');
      expect(await code(...make(`${base}/home/other/apps/x`))).toBe('refused');
      expect(await code(...make(home))).toBe('refused');
      expect(await code(...make(`${home}/apps/link`))).toBe('refused');
      expect(await code(...make(`${home}/apps/escape`))).toBe('refused');
      expect(await code(...make(`${home}/apps/outside-parent/app`))).toBe('refused');
      expect(await code(...make(`${home}/apps/file`))).toBe('refused');
      if (myUid === 0) expect(await code(...make(`${home}/apps/foreign`))).toBe('refused');
    }
    // A symlink that stays inside the home is the account's own layout and is
    // accepted as an intermediate component, never as the root itself.
    expect(await code(...ops.purge(`${home}/apps/escape-dir-link/inner`))).toBe('refused');
    for (const key of ['unit', 'purge']) expect(await code(...ops[key](`${home}/public_html`)), key).toBe('refused');
    for (const key of ['step', 'unit', 'expose', 'pull']) expect(await code(...ops[key](`${home}/apps/missing`)), key).toBe('not_found');
    await expect(runOp('app.inspect', { username: USER, root: `${home}/apps/missing` }, ctx)).resolves.toMatchObject({ exists: false, empty: true, files: [], hints: { preset: null } });
    await expect(runOp('app.purge', { username: USER, root: `${home}/apps/missing` }, ctx)).resolves.toEqual({ root: `${home}/apps/missing`, removed: false });
    expect(exec).not.toHaveBeenCalled();
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe('renderers', () => {
  const spec = { id: 12, username: 'alice', group: 'alice', name: 'Shop API', root: '/home/alice/apps/shop', home: '/home/alice', envPath: '/etc/whm/apps/12.env', bin: '/opt/whm/runtimes/node/20.11.0/bin/node', args: ['dist/main.js', '--trace-warnings'], port: 30001, mode: 'production', pathDirs: ['/opt/whm/runtimes/node/20.11.0/bin', '/home/alice/apps/shop/node_modules/.bin'], limits: { memoryMaxMb: 512, tasksMax: 256, cpuQuotaPercent: 100 } };

  it('renderUnit produces the sandboxed per-app unit', () => {
    expect(renderUnit(spec)).toBe([
      '# Managed by WHM panel (application 12: Shop API). Edit through the panel; manual changes are overwritten.',
      '[Unit]',
      'Description=WHM application Shop API (alice)',
      'After=network.target',
      '[Service]',
      'Type=simple',
      'User=alice',
      'Group=alice',
      'WorkingDirectory=/home/alice/apps/shop',
      'EnvironmentFile=/etc/whm/apps/12.env',
      'Environment=PORT=30001 HOST=127.0.0.1 NODE_ENV=production HOME=/home/alice PATH=/opt/whm/runtimes/node/20.11.0/bin:/home/alice/apps/shop/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
      'ExecStart=/opt/whm/runtimes/node/20.11.0/bin/node dist/main.js --trace-warnings',
      'Restart=on-failure',
      'RestartSec=3',
      'TimeoutStopSec=20',
      'KillSignal=SIGTERM',
      'SyslogIdentifier=whm-app-12',
      'MemoryMax=512M',
      'TasksMax=256',
      'CPUQuota=100%',
      'NoNewPrivileges=yes',
      'PrivateTmp=yes',
      'ProtectSystem=full',
      'ProtectKernelTunables=yes',
      'ProtectControlGroups=yes',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n'));
    const noGroup = renderUnit({ ...spec, group: null, pathDirs: [], args: [] });
    expect(noGroup).not.toContain('Group=');
    expect(noGroup).toContain('PATH=/usr/local/bin:/usr/bin:/bin\n');
    expect(noGroup).toContain('ExecStart=/opt/whm/runtimes/node/20.11.0/bin/node\n');
  });

  it('renderEnvFile escapes backslashes and double quotes and nothing else', () => {
    expect(renderEnvFile({ A: 'plain', B: 'say "hi" \\ back', C: '$HOME %d `x` ; | & #', D: '' })).toBe('A="plain"\nB="say \\"hi\\" \\\\ back"\nC="$HOME %d `x` ; | & #"\nD=""\n');
    expect(renderEnvFile({})).toBe('\n');
  });

  it('renderAppsInclude: proxy with websockets on new and old Apache', () => {
    const apps = [{ id: 1, kind: 'proxy', basePath: '/api', port: 3001, websockets: true, spaFallback: false }];
    const fresh = renderAppsInclude('example.com', apps, { apacheVersion: '2.4.58' });
    expect(fresh.startsWith('# Managed by WHM panel (applications for example.com)')).toBe(true);
    expect(fresh).toContain('ProxyPreserveHost On\nRequestHeader set X-Forwarded-Proto "https" env=HTTPS\n');
    expect(fresh).toContain('<Location "/api">\n  ProxyPass "http://127.0.0.1:3001/" retry=0 timeout=120 upgrade=websocket\n  ProxyPassReverse "http://127.0.0.1:3001/"\n</Location>\n');
    expect(fresh).not.toContain('Rewrite');
    const old = renderAppsInclude('example.com', apps, { apacheVersion: '2.4.41' });
    expect(old).toContain('  ProxyPass "http://127.0.0.1:3001/" retry=0 timeout=120\n');
    expect(old).not.toContain('upgrade=');
    expect(old).toContain('RewriteEngine On\nRewriteCond %{HTTP:Upgrade} =websocket [NC]\nRewriteRule ^/api/?(.*)$ ws://127.0.0.1:3001/$1 [P,L]\n');
    const noWs = renderAppsInclude('example.com', [{ ...apps[0], websockets: false }], { apacheVersion: '2.4.41' });
    expect(noWs).not.toContain('Rewrite');
    expect(noWs).not.toContain('upgrade=');
    const rootWs = renderAppsInclude('example.com', [{ ...apps[0], basePath: '/' }], { apacheVersion: null });
    expect(rootWs).toContain('<Location "/">');
    expect(rootWs).toContain('RewriteRule ^/?(.*)$ ws://127.0.0.1:3001/$1 [P,L]');
  });

  it('renderAppsInclude: static root, static sub-path, several apps, empty list', () => {
    const root = renderAppsInclude('example.com', [{ id: 5, kind: 'static', basePath: '/', staticDir: '/home/alice/apps/site/dist', websockets: false, spaFallback: true }], { apacheVersion: '2.4.58' });
    expect(root).toContain('DocumentRoot "/home/alice/apps/site/dist"\n<Directory "/home/alice/apps/site/dist">\n  Options -Indexes +FollowSymLinks\n  AllowOverride None\n  Require all granted\n  FallbackResource "/index.html"\n</Directory>\n');
    expect(root).not.toContain('Alias');
    expect(root).not.toContain('Proxy');
    const sub = renderAppsInclude('example.com', [{ id: 6, kind: 'static', basePath: '/docs/', staticDir: '/home/alice/apps/docs/build', websockets: false, spaFallback: false }], { apacheVersion: '2.4.58' });
    expect(sub).toContain('Alias "/docs" "/home/alice/apps/docs/build"\n<Directory "/home/alice/apps/docs/build">');
    expect(sub).not.toContain('FallbackResource');
    expect(sub).not.toContain('DocumentRoot');
    const many = renderAppsInclude('example.com', [
      { id: 2, kind: 'proxy', basePath: '/api', port: 3002, websockets: false, spaFallback: false },
      { id: 1, kind: 'proxy', basePath: '/', port: 3001, websockets: true, spaFallback: false },
      { id: 3, kind: 'static', basePath: '/docs', staticDir: '/home/alice/apps/docs/dist', websockets: false, spaFallback: true },
    ], { apacheVersion: '2.4.41' });
    expect(many.indexOf('<Location "/">')).toBeLessThan(many.indexOf('<Location "/api">'));
    expect(many).toContain('<Location "/docs">\n  ProxyPass "!"\n</Location>');
    expect(many).toContain('FallbackResource "/docs/index.html"');
    expect(many.match(/ProxyPreserveHost On/g)).toHaveLength(1);
    expect(many.match(/^RewriteEngine On$/gm)).toHaveLength(1);
    expect(many).toContain('ws://127.0.0.1:3001/$1');
    expect(many).not.toContain('ws://127.0.0.1:3002/');
    expect(renderAppsInclude('example.com', [], { apacheVersion: '2.4.58' })).toBeNull();
    expect(() => renderAppsInclude('example.com', [{ id: 1, kind: 'static', basePath: '/', staticDir: '/home/alice/my site', websockets: false, spaFallback: true }])).toThrow(OpError);
    expect(() => renderAppsInclude('example.com', [{ id: 1, kind: 'static', basePath: '/', staticDir: '/home/alice/x"y', websockets: false, spaFallback: true }])).toThrow(/cannot be rendered/);
  });

  it('module requirements follow the rendered directives and the Apache version', () => {
    const proxyWs = [{ id: 1, kind: 'proxy', basePath: '/', port: 3000, websockets: true }];
    expect(modulesFor(proxyWs, '2.4.41')).toEqual({ required: ['proxy', 'proxy_http', 'headers', 'proxy_wstunnel', 'rewrite'], all: ['proxy', 'proxy_http', 'proxy_wstunnel', 'headers', 'rewrite'] });
    expect(modulesFor(proxyWs, '2.4.58').required).toEqual(['proxy', 'proxy_http', 'headers']);
    expect(modulesFor([{ ...proxyWs[0], websockets: false }], null).required).toEqual(['proxy', 'proxy_http', 'headers']);
    expect(modulesFor([{ id: 2, kind: 'static', basePath: '/', spaFallback: false }], '2.4.58')).toEqual({ required: [], all: [] });
    expect(modulesFor([{ id: 2, kind: 'static', basePath: '/docs', spaFallback: true }], '2.4.58')).toEqual({ required: ['alias', 'dir'], all: ['alias', 'dir'] });
    expect(supportsUpgradeWebsocket('2.4.46')).toBe(false);
    expect(supportsUpgradeWebsocket('2.4.47')).toBe(true);
    expect(supportsUpgradeWebsocket('2.5.0')).toBe(true);
    expect(supportsUpgradeWebsocket(null)).toBe(false);
    expect(apacheVersionNumber('Server version: Apache/2.4.58 (Ubuntu)\nServer built:   2024-04-10')).toBe('2.4.58');
    expect(apacheVersionNumber('')).toBeNull();
  });
});

describe('inspection parsers and framework hints', () => {
  it('parsePackageJson, parseRequirements and parseAngularProjects are tolerant of hostile input', () => {
    expect(parsePackageJson('not json')).toBeNull();
    expect(parsePackageJson('[1,2]')).toBeNull();
    expect(parsePackageJson(null)).toBeNull();
    const pkg = parsePackageJson(JSON.stringify({ name: 'shop', main: './src/index.js', scripts: { start: 'node .', build: 'tsc', weird: 5 }, dependencies: { express: '^4', next: '14' }, devDependencies: { vite: '5', express: '^4' } }));
    expect(pkg).toEqual({ name: 'shop', main: './src/index.js', scripts: { start: 'node .', build: 'tsc' }, dependencies: ['express', 'next', 'vite'] });
    expect(parsePackageJson(JSON.stringify({ name: 'x'.repeat(300), scripts: 'nope', dependencies: null })).name).toBeNull();
    expect(parseRequirements('Flask>=2.0 # web\n-r other.txt\n--index-url https://x\nDjango==4.2\nuvicorn[standard]\nzope.interface\n\n# comment\n')).toEqual(['flask', 'django', 'uvicorn', 'zope-interface']);
    expect(parseRequirements(null)).toEqual([]);
    expect(parseAngularProjects(JSON.stringify({ projects: { shop: {}, 'admin-ui': {}, 'bad name': {}, '../x': {} } }))).toEqual(['shop', 'admin-ui']);
    expect(parseAngularProjects('{')).toEqual([]);
    expect(parseAngularProjects(JSON.stringify({ projects: [] }))).toEqual([]);
  });

  it('detectHints maps dependencies, requirements and files to presets', () => {
    const node = (deps, extra = {}) => ({ packageJson: { name: 'x', main: null, scripts: {}, dependencies: deps, ...extra } });
    expect(detectHints({ files: ['package.json', 'package-lock.json'], dirs: ['.next'], ...node(['next', 'react']) })).toEqual({ preset: 'nextjs', outputDir: null, startEntry: null, lockfile: 'package-lock.json', existingOutputDirs: ['.next'] });
    expect(detectHints({ files: ['yarn.lock'], ...node(['nuxt', 'vue']) })).toMatchObject({ preset: 'nuxt', startEntry: '.output/server/index.mjs', lockfile: 'yarn.lock' });
    expect(detectHints(node(['@nestjs/core']))).toMatchObject({ preset: 'nestjs', startEntry: 'dist/main.js' });
    expect(detectHints({ ...node(['@angular/core']), angularProjects: ['shop'] })).toMatchObject({ preset: 'angular', outputDir: 'dist/shop/browser' });
    expect(detectHints(node(['@angular/core']))).toMatchObject({ preset: 'angular', outputDir: null });
    expect(detectHints(node(['react', 'react-scripts']))).toMatchObject({ preset: 'react-cra', outputDir: 'build' });
    expect(detectHints(node(['vue', 'vite']))).toMatchObject({ preset: 'vue', outputDir: 'dist' });
    expect(detectHints(node(['svelte', 'vite']))).toMatchObject({ preset: 'svelte', outputDir: 'build' });
    expect(detectHints({ files: ['pnpm-lock.yaml'], dirs: ['dist'], ...node(['react', 'vite']) })).toMatchObject({ preset: 'react-vite', outputDir: 'dist', lockfile: 'pnpm-lock.yaml', existingOutputDirs: ['dist'] });
    expect(detectHints({ files: ['package.json', 'server.js'], ...node(['express']) })).toMatchObject({ preset: 'express', startEntry: 'server.js' });
    expect(detectHints({ files: ['package.json', 'src'], dirs: ['src'], ...node(['express'], { main: './src/index.js' }) })).toMatchObject({ preset: 'express', startEntry: 'src/index.js' });
    expect(detectHints({ files: ['package.json'], ...node(['express'], { main: '../../etc/passwd' }) })).toMatchObject({ preset: 'express', startEntry: 'server.js' });
    expect(detectHints(node(['fastify'], { scripts: { start: 'node .' } }))).toMatchObject({ preset: 'node-custom' });
    expect(detectHints(node(['lodash']))).toMatchObject({ preset: null });
    expect(detectHints({ files: ['requirements.txt', 'app.py'], requirements: ['flask'] })).toMatchObject({ preset: 'flask', startEntry: 'app:app' });
    expect(detectHints({ files: ['manage.py'], requirements: null })).toMatchObject({ preset: 'django' });
    expect(detectHints({ files: ['requirements.txt'], requirements: ['django', 'gunicorn'] })).toMatchObject({ preset: 'django' });
    expect(detectHints({ files: ['requirements.txt', 'main.py'], requirements: ['fastapi', 'uvicorn'] })).toMatchObject({ preset: 'fastapi', startEntry: 'main:app' });
    expect(detectHints({ files: ['requirements.txt', 'main.py'], requirements: ['numpy'] })).toMatchObject({ preset: 'python-custom', startEntry: 'main.py' });
    expect(detectHints({ files: ['index.html', 'style.css'] })).toMatchObject({ preset: 'static-files', outputDir: '.' });
    expect(detectHints({ files: ['README.md'] })).toMatchObject({ preset: null, outputDir: null, startEntry: null, lockfile: null });
    expect(detectHints()).toEqual({ preset: null, outputDir: null, startEntry: null, lockfile: null, existingOutputDirs: [] });
  });

  it('scaffolds name the app and the panel without ever embedding quotes', () => {
    for (const [template, make] of Object.entries(SCAFFOLDS)) {
      const files = make('My Shop 2.0');
      expect(Object.keys(files).length, template).toBeGreaterThan(0);
      for (const [file, content] of Object.entries(files)) {
        expect(file).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(content.endsWith('\n'), `${template}/${file}`).toBe(true);
      }
      const text = Object.values(files).join('\n');
      expect(text).toContain('My Shop 2.0');
      expect(text).toContain('WHM panel');
    }
    expect(JSON.parse(SCAFFOLDS.express('My Shop 2.0')['package.json'])).toMatchObject({ name: 'my-shop-2-0', private: true, scripts: { start: 'node server.js' } });
    expect(SCAFFOLDS.express('x')['server.js']).toContain('process.env.PORT');
  });
});

describe('app.runtime.detect', () => {
  it('lists managed runtimes under the runtimes root and reports the host toolchain', async () => {
    const dir = path.join(runtimes, 'node', '20.0.0', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\necho v20.0.0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
    fs.mkdirSync(path.join(runtimes, 'node', 'not-a-version'), { recursive: true });
    fs.mkdirSync(path.join(runtimes, 'node', '18.0.0'), { recursive: true });
    try {
      const r = await runOp('app.runtime.detect', {}, ctx);
      expect(r.arch).toBe(process.arch);
      expect(r.runtimesRoot).toBe(runtimes);
      expect(typeof r.git.installed).toBe('boolean');
      expect(Array.isArray(r.python)).toBe(true);
      for (const p of r.python) expect(p).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/), bin: expect.stringMatching(/^\//), source: 'system', venv: expect.any(Boolean) });
      const managed = r.node.filter((n) => n.source === 'managed');
      expect(managed).toEqual([{ version: '20.0.0', bin: path.join(dir, 'node'), source: 'managed', path: path.join(runtimes, 'node', '20.0.0'), npm: path.join(dir, 'npm'), ok: true }]);
      for (const n of r.node.filter((n) => n.source === 'system')) expect(n).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/), bin: expect.stringMatching(/^\//) });
    } finally {
      fs.rmSync(path.join(runtimes, 'node'), { recursive: true, force: true });
    }
  });
});

describe('app.runtime.node.install', () => {
  const version = '20.11.1';
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
  const name = `node-v${version}-linux-${arch}`;
  const dest = () => path.join(runtimes, 'node', version);
  const tmpDirs = () => { try { return fs.readdirSync(path.join(runtimes, '.tmp')); } catch { return []; } };

  function fakeDownloads({ sums, sha = 0, tar = true }) {
    hasBinary.mockImplementation((n) => ['curl', 'sha256sum', 'tar'].includes(n) || realHasBinary(n));
    exec.mockImplementation(async (bin, argv, opts) => {
      const result = { code: 0, stdout: '', stderr: '', bin, argv };
      if (bin === 'curl') {
        const out = argv[argv.indexOf('-o') + 1];
        const url = argv[argv.length - 1];
        if (url.endsWith('/SHASUMS256.txt')) fs.writeFileSync(out, sums);
        else fs.writeFileSync(out, 'not really a tarball');
        return result;
      }
      if (bin === 'sha256sum') { expect(opts.cwd).toMatch(new RegExp(`^${runtimes}/.tmp/[0-9a-f]{16}$`)); return { ...result, code: sha, stderr: sha ? `${name}.tar.xz: FAILED` : '' }; }
      if (bin === 'tar') {
        const dir = argv[argv.indexOf('--directory') + 1];
        if (tar) { fs.mkdirSync(path.join(dir, name, 'bin'), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 }); fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(dir, name, 'bin', 'npm')); }
        return result;
      }
      if (bin === 'chmod') return result;
      throw new Error(`unexpected program ${bin}`);
    });
  }
  const goodSums = () => `${'a'.repeat(64)}  node-v${version}-headers.tar.gz\n${'b'.repeat(64)}  ${name}.tar.xz\n${'c'.repeat(64)}  node-v${version}-win-x64.zip\n`;

  it.skipIf(!arch)('refuses an already installed version before downloading anything', async () => {
    fs.mkdirSync(dest(), { recursive: true });
    exec.mockClear();
    try {
      const err = await opError(runOp('app.runtime.node.install', { version }, ctx));
      expect(err.code).toBe('exists');
      expect(exec).not.toHaveBeenCalled();
    } finally { fs.rmSync(dest(), { recursive: true, force: true }); }
  });

  it.skipIf(!arch)('reports a failed download, a missing checksum line and a checksum mismatch, never extracting and always cleaning up', async () => {
    hasBinary.mockImplementation((n) => ['curl', 'sha256sum', 'tar'].includes(n) || realHasBinary(n));
    exec.mockImplementation(async (bin, argv) => ({ code: bin === 'curl' ? 22 : 0, stdout: '', stderr: 'curl: (22) The requested URL returned error: 404', bin, argv }));
    let err = await opError(runOp('app.runtime.node.install', { version }, ctx));
    expect(err.code).toBe('download_failed');
    expect(err.message).toContain('404');
    expect(tmpDirs()).toEqual([]);
    expect(fs.existsSync(dest())).toBe(false);

    fakeDownloads({ sums: `${'a'.repeat(64)}  node-v${version}-headers.tar.gz\n` });
    exec.mockClear();
    err = await opError(runOp('app.runtime.node.install', { version }, ctx));
    expect(err.code).toBe('checksum_mismatch');
    expect(err.message).toContain(`${name}.tar.xz`);
    expect(calls().map((c) => c.bin)).toEqual(['curl', 'curl']);
    expect(tmpDirs()).toEqual([]);

    fakeDownloads({ sums: goodSums(), sha: 1 });
    exec.mockClear();
    err = await opError(runOp('app.runtime.node.install', { version }, ctx));
    expect(err.code).toBe('checksum_mismatch');
    expect(calls().map((c) => c.bin)).toEqual(['curl', 'curl', 'sha256sum']);
    expect(calls()[2].argv).toEqual(['--check', '--strict', '--ignore-missing', '--quiet', expect.stringMatching(/\/checksum\.sha256$/)]);
    expect(tmpDirs()).toEqual([]);
    expect(fs.existsSync(dest())).toBe(false);

    fakeDownloads({ sums: goodSums(), tar: false });
    exec.mockClear();
    err = await opError(runOp('app.runtime.node.install', { version }, ctx));
    expect(err.code).toBe('download_failed');
    expect(calls().map((c) => c.bin)).toEqual(['curl', 'curl', 'sha256sum', 'tar']);
    expect(tmpDirs()).toEqual([]);
  });

  it.skipIf(!arch)('downloads with a pinned https curl, verifies the one published line, extracts without ownership and installs under the runtimes root', async () => {
    fakeDownloads({ sums: goodSums() });
    exec.mockClear();
    try {
      const r = await runOp('app.runtime.node.install', { version }, ctx);
      expect(r).toEqual({ version, path: dest(), bin: path.join(dest(), 'bin', 'node'), npm: path.join(dest(), 'bin', 'npm') });
      const c = calls();
      expect(c.map((x) => x.bin)).toEqual(['curl', 'curl', 'sha256sum', 'tar', 'chmod']);
      expect(c[0].argv).toEqual(['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '600', '-o', expect.stringMatching(new RegExp(`^${runtimes}/.tmp/[0-9a-f]{16}/${name}\\.tar\\.xz$`)), `https://nodejs.org/dist/v${version}/${name}.tar.xz`]);
      expect(c[1].argv.slice(-1)).toEqual([`https://nodejs.org/dist/v${version}/SHASUMS256.txt`]);
      const tmp = path.dirname(c[0].argv[11]);
      expect(c[3].argv).toEqual(['--extract', '--xz', '--file', path.join(tmp, `${name}.tar.xz`), '--directory', tmp, '--no-same-owner', '--no-same-permissions']);
      expect(c[4].argv).toEqual(['-R', 'u+rwX,go+rX,go-w', '--', path.join(tmp, name)]);
      expect(fs.statSync(path.join(dest(), 'bin', 'node')).isFile()).toBe(true);
      expect(fs.statSync(dest()).mode & 0o777).toBe(0o755);
      expect(tmpDirs()).toEqual([]);
      expect(fs.statSync(path.join(runtimes, '.tmp')).mode & 0o777).toBe(0o700);
      expect((await opError(runOp('app.runtime.node.install', { version }, ctx))).code).toBe('exists');
    } finally { fs.rmSync(dest(), { recursive: true, force: true }); }
  });

  it('app.runtime.node.remove refuses missing or symlinked versions and removes a real one with rm -rf', async () => {
    exec.mockClear();
    expect((await opError(runOp('app.runtime.node.remove', { version: '19.9.9' }, ctx))).code).toBe('not_found');
    const real = path.join(runtimes, 'node', '19.0.0');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, path.join(runtimes, 'node', '19.1.0'));
    fs.writeFileSync(path.join(runtimes, 'node', '19.2.0'), 'x');
    expect((await opError(runOp('app.runtime.node.remove', { version: '19.1.0' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('app.runtime.node.remove', { version: '19.2.0' }, ctx))).code).toBe('refused');
    expect(exec).not.toHaveBeenCalled();
    exec.mockImplementation(async (bin, argv) => { expect(bin).toBe('rm'); expect(argv).toEqual(['-rf', '--', real]); fs.rmSync(real, { recursive: true }); return { code: 0, stdout: '', stderr: '', bin, argv }; });
    await expect(runOp('app.runtime.node.remove', { version: '19.0.0' }, ctx)).resolves.toEqual({ version: '19.0.0', path: real, removed: true });
    expect(exec).toHaveBeenCalledTimes(1);
    fs.rmSync(path.join(runtimes, 'node'), { recursive: true, force: true });
  });
});

describe('app.inspect reads the tree only as the account user', () => {
  const fakeFs = () => fakeUser(async (argv, opts) => {
    expect(opts.env).toMatchObject({ HOME: home });
    if (argv[0] === 'ls') {
      expect(argv).toEqual(['ls', '-1Ap', '--', argv[3]]);
      const names = fs.readdirSync(argv[3], { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).sort();
      return okResult(names.map((n) => `${n}\n`).join(''));
    }
    expect(argv.slice(0, 3)).toEqual(['head', '-c', String(256 * 1024 + 1)]);
    expect(argv[3]).toBe('--');
    return okResult(fs.readFileSync(argv[4], 'utf8').slice(0, 256 * 1024 + 1));
  });

  it.skipIf(!canOwn)('detects a Next.js project with its lockfile and build output', async () => {
    const root = mkOwned(`${home}/apps/shop`);
    writeOwned(`${root}/package.json`, JSON.stringify({ name: 'shop', scripts: { dev: 'next dev', build: 'next build', start: 'next start' }, dependencies: { next: '14.2.0', react: '18' } }));
    writeOwned(`${root}/package-lock.json`, '{}');
    mkOwned(`${root}/.next`);
    fakeFs();
    const r = await runOp('app.inspect', { username: USER, root }, ctx);
    expect(r).toMatchObject({ root, exists: true, empty: false, requirements: null, angularProjects: [] });
    expect(r.files).toEqual(['.next', 'package-lock.json', 'package.json']);
    expect(r.dirs).toEqual(['.next']);
    expect(r.packageJson).toEqual({ name: 'shop', main: null, scripts: { dev: 'next dev', build: 'next build', start: 'next start' }, dependencies: ['next', 'react'] });
    expect(r.hints).toEqual({ preset: 'nextjs', outputDir: null, startEntry: null, lockfile: 'package-lock.json', existingOutputDirs: ['.next'] });
    expect(exec).toHaveBeenCalledTimes(2);
    for (const c of calls()) expect(c.bin).toBe('runuser');
  });

  it.skipIf(!canOwn)('detects a Flask project, an Angular workspace and an empty directory; oversized files are ignored', async () => {
    const flask = mkOwned(`${home}/apps/flaskapp`);
    writeOwned(`${flask}/requirements.txt`, 'Flask==3.0\ngunicorn\n');
    writeOwned(`${flask}/app.py`, 'from flask import Flask\n');
    fakeFs();
    expect((await runOp('app.inspect', { username: USER, root: flask }, ctx))).toMatchObject({ requirements: ['flask', 'gunicorn'], packageJson: null, hints: { preset: 'flask', startEntry: 'app:app' } });

    const ng = mkOwned(`${home}/apps/ng`);
    writeOwned(`${ng}/package.json`, JSON.stringify({ name: 'ng', dependencies: { '@angular/core': '17' } }));
    writeOwned(`${ng}/angular.json`, JSON.stringify({ projects: { portal: {} } }));
    expect((await runOp('app.inspect', { username: USER, root: ng }, ctx))).toMatchObject({ angularProjects: ['portal'], hints: { preset: 'angular', outputDir: 'dist/portal/browser' } });

    const empty = mkOwned(`${home}/apps/empty`);
    expect(await runOp('app.inspect', { username: USER, root: empty }, ctx)).toMatchObject({ exists: true, empty: true, files: [], hints: { preset: null } });

    const huge = mkOwned(`${home}/apps/huge`);
    writeOwned(`${huge}/package.json`, `{"name":"${'x'.repeat(256 * 1024)}"}`);
    expect(await runOp('app.inspect', { username: USER, root: huge }, ctx)).toMatchObject({ packageJson: null, hints: { preset: null } });
  });
});

describe('app.prepare and app.pull act only as the account user', () => {
  it.skipIf(!canOwn)('creates the root, refuses a non-empty one for clone/scaffold and writes scaffold files through tee', async () => {
    const root = `${home}/apps/fresh`;
    const inputs = {};
    fakeUser(async (argv, opts) => {
      expect(opts.env).toMatchObject({ HOME: home });
      if (argv[0] === 'mkdir') { expect(argv).toEqual(['mkdir', '-p', '-m', '0755', '--', root]); mkOwned(root); return; }
      if (argv[0] === 'ls') { expect(argv).toEqual(['ls', '-1A', '--', root]); return okResult(fs.readdirSync(root).join('\n')); }
      if (argv[0] === 'tee') { expect(argv).toEqual(['tee', '--', expect.stringMatching(new RegExp(`^${root}/[a-z.]+$`))]); inputs[path.basename(argv[2])] = opts.input; return; }
      throw new Error(`unexpected ${argv.join(' ')}`);
    });
    await expect(runOp('app.prepare', { username: USER, root }, ctx)).resolves.toEqual({ root, cloned: false, scaffolded: [] });
    expect(calls().map((c) => c.argv[3])).toEqual(['mkdir']);
    exec.mockClear();
    const r = await runOp('app.prepare', { username: USER, root, scaffold: { template: 'express', name: 'Fresh App' } }, ctx);
    expect(r).toEqual({ root, cloned: false, scaffolded: ['package.json', 'server.js'] });
    expect(calls().map((c) => c.argv[3])).toEqual(['mkdir', 'ls', 'tee', 'tee']);
    expect(inputs['server.js']).toContain('Fresh App');
    expect(inputs['server.js']).toContain('WHM panel');
    expect(JSON.parse(inputs['package.json'])).toMatchObject({ name: 'fresh-app' });
    writeOwned(`${root}/index.js`, '');
    exec.mockClear();
    expect((await opError(runOp('app.prepare', { username: USER, root, scaffold: { template: 'flask', name: 'x' } }, ctx))).code).toBe('exists');
    expect((await opError(runOp('app.prepare', { username: USER, root, source: { gitUrl: 'https://github.com/a/b' } }, ctx))).code).toBe('exists');
    expect(calls().map((c) => c.argv[3])).toEqual(['mkdir', 'ls', 'mkdir', 'ls']);
  });

  it.skipIf(!canOwn)('clones with hooks disabled, depth 1 and no terminal prompt, and reports git failures', async () => {
    const root = `${home}/apps/cloned`;
    let fail = false;
    fakeUser(async (argv, opts) => {
      if (argv[0] === 'mkdir') { mkOwned(root); return; }
      if (argv[0] === 'ls') return okResult('');
      expect(argv).toEqual(['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', '--branch', 'release/1.0', '--', 'https://github.com/org/repo.git', root]);
      expect(opts.env).toMatchObject({ HOME: home, GIT_TERMINAL_PROMPT: '0' });
      expect(opts.timeoutMs).toBe(900_000);
      return fail ? { code: 128, stdout: '', stderr: 'Cloning into...\nfatal: Remote branch release/1.0 not found in upstream origin\n', bin: 'runuser', argv } : okResult();
    });
    hasBinary.mockImplementation((n) => n === 'git' || realHasBinary(n));
    await expect(runOp('app.prepare', { username: USER, root, source: { gitUrl: 'https://github.com/org/repo.git', ref: 'release/1.0' } }, ctx)).resolves.toEqual({ root, cloned: true, scaffolded: [] });
    fail = true;
    const err = await opError(runOp('app.prepare', { username: USER, root, source: { gitUrl: 'https://github.com/org/repo.git', ref: 'release/1.0' } }, ctx));
    expect(err.code).toBe('git_failed');
    expect(err.message).toContain('Remote branch release/1.0 not found');
    expect(err.details.output).toEqual(['Cloning into...', 'fatal: Remote branch release/1.0 not found in upstream origin']);
    hasBinary.mockImplementation((n) => (n === 'git' ? false : realHasBinary(n)));
    exec.mockClear();
    expect((await opError(runOp('app.prepare', { username: USER, root, source: { gitUrl: 'https://github.com/org/repo.git' } }, ctx))).code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });

  it.skipIf(!canOwn)('pull fetches depth 1, resets to FETCH_HEAD and returns the new head', async () => {
    const root = mkOwned(`${home}/apps/pulled`);
    hasBinary.mockImplementation((n) => n === 'git' || realHasBinary(n));
    let failFetch = false;
    fakeUser(async (argv, opts) => {
      expect(argv.slice(0, 3)).toEqual(['git', '-c', 'core.hooksPath=/dev/null']);
      expect(opts.cwd).toBe(root);
      expect(opts.env).toMatchObject({ HOME: home, GIT_TERMINAL_PROMPT: '0' });
      if (argv[3] === 'fetch' && failFetch) return { code: 128, stdout: '', stderr: 'fatal: not a git repository', bin: 'runuser', argv };
      if (argv[3] === 'rev-parse') return okResult('0123456789abcdef0123456789abcdef01234567\n');
      return okResult();
    });
    await expect(runOp('app.pull', { username: USER, root, ref: 'main' }, ctx)).resolves.toEqual({ root, head: '0123456789abcdef0123456789abcdef01234567' });
    expect(calls().map((c) => c.argv.slice(6))).toEqual([['fetch', '--depth', '1', 'origin', 'main'], ['reset', '--hard', 'FETCH_HEAD'], ['rev-parse', 'HEAD']]);
    exec.mockClear();
    await runOp('app.pull', { username: USER, root }, ctx);
    expect(calls()[0].argv.slice(6)).toEqual(['fetch', '--depth', '1', 'origin']);
    failFetch = true;
    exec.mockClear();
    expect((await opError(runOp('app.pull', { username: USER, root }, ctx))).code).toBe('git_failed');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('app.step builds the exact argv for each step as the account user', () => {
  const nodeDir = () => path.join(runtimes, 'node', '20.11.0');
  const nodeBin = () => path.join(nodeDir(), 'bin', 'node');
  const npmCli = () => path.join(nodeDir(), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const python = '/usr/bin/python3';
  const havePython = fs.existsSync(python);

  function plantNode() {
    fs.mkdirSync(path.join(nodeDir(), 'bin'), { recursive: true });
    fs.mkdirSync(path.dirname(npmCli()), { recursive: true });
    fs.writeFileSync(nodeBin(), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(npmCli(), '', { mode: 0o755 });
    if (!fs.existsSync(path.join(nodeDir(), 'bin', 'npm'))) fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(nodeDir(), 'bin', 'npm'));
  }
  afterAll(() => fs.rmSync(path.join(runtimes, 'node'), { recursive: true, force: true }));

  it.skipIf(!canOwn)('npm-install (ci with a lockfile, install without, --omit=dev in production) and npm-run', async () => {
    plantNode();
    const root = mkOwned(`${home}/apps/api`);
    writeOwned(`${root}/package-lock.json`, '{}');
    let seen;
    fakeUser(async (argv, opts) => { seen = { argv, opts }; return okResult('added 12 packages\n'); });
    const runtime = { kind: 'node', bin: nodeBin() };
    const r = await runOp('app.step', { username: USER, root, step: 'npm-install', runtime }, ctx);
    expect(r).toMatchObject({ step: 'npm-install', code: 0, output: ['added 12 packages'] });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(seen.argv).toEqual([nodeBin(), npmCli(), 'ci']);
    expect(seen.opts.cwd).toBe(root);
    expect(seen.opts.timeoutMs).toBe(1_800_000);
    expect(seen.opts.env).toEqual(stepEnv(nodeBin(), root, home, false));
    expect(seen.opts.env).toMatchObject({ HOME: home, PATH: `${nodeDir()}/bin:${root}/.venv/bin:/usr/local/bin:/usr/bin:/bin`, NODE_ENV: 'development', CI: '1', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false', PIP_DISABLE_PIP_VERSION_CHECK: '1' });
    await runOp('app.step', { username: USER, root, step: 'npm-install', runtime, production: true }, ctx);
    expect(seen.argv).toEqual([nodeBin(), npmCli(), 'ci', '--omit=dev']);
    expect(seen.opts.env.NODE_ENV).toBe('production');
    fs.unlinkSync(`${root}/package-lock.json`);
    await runOp('app.step', { username: USER, root, step: 'npm-install', runtime }, ctx);
    expect(seen.argv).toEqual([nodeBin(), npmCli(), 'install']);
    await runOp('app.step', { username: USER, root, step: 'npm-run', runtime, script: 'build', production: true }, ctx);
    expect(seen.argv).toEqual([nodeBin(), npmCli(), 'run', '--', 'build']);
    expect(seen.opts.env.NODE_ENV).toBe('production');
  });

  it.skipIf(!canOwn || !havePython)('venv-create falls back without --upgrade-deps, pip-install uses the venv python and needs a venv', async () => {
    const root = mkOwned(`${home}/apps/py`);
    const runtime = { kind: 'python', bin: python };
    const seen = [];
    let oldPython = false;
    fakeUser(async (argv, opts) => {
      seen.push(argv);
      expect(opts.cwd).toBe(root);
      if (oldPython && argv.includes('--upgrade-deps')) return { code: 2, stdout: '', stderr: 'usage: venv [-h]\nvenv: error: unrecognized arguments: --upgrade-deps', bin: 'runuser', argv };
      return okResult();
    });
    await runOp('app.step', { username: USER, root, step: 'venv-create', runtime }, ctx);
    expect(seen).toEqual([[python, '-m', 'venv', '--upgrade-deps', `${root}/.venv`]]);
    seen.length = 0;
    oldPython = true;
    await runOp('app.step', { username: USER, root, step: 'venv-create', runtime }, ctx);
    expect(seen).toEqual([[python, '-m', 'venv', '--upgrade-deps', `${root}/.venv`], [python, '-m', 'venv', `${root}/.venv`]]);
    seen.length = 0;
    expect((await opError(runOp('app.step', { username: USER, root, step: 'pip-install', runtime, packages: ['gunicorn'] }, ctx))).code).toBe('not_found');
    expect(seen).toEqual([]);
    mkOwned(`${root}/.venv/bin`);
    writeOwned(`${root}/.venv/bin/python`, '');
    await expect(runOp('app.step', { username: USER, root, step: 'pip-install', runtime }, ctx)).resolves.toMatchObject({ code: 0, output: [expect.stringMatching(/nothing to install/)] });
    expect(seen).toEqual([]);
    writeOwned(`${root}/requirements.txt`, 'flask\n');
    await runOp('app.step', { username: USER, root, step: 'pip-install', runtime, packages: ['gunicorn==21.2.0', 'uvicorn[standard]'] }, ctx);
    expect(seen).toEqual([[`${root}/.venv/bin/python`, '-m', 'pip', 'install', '-r', 'requirements.txt', 'gunicorn==21.2.0', 'uvicorn[standard]']]);
  });

  it.skipIf(!canOwn)('refuses runtime binaries outside the managed and system locations before spawning anything', async () => {
    plantNode();
    const root = mkOwned(`${home}/apps/api2`);
    writeOwned(`${home}/node`, '#!/bin/sh\n');
    const outside = fs.mkdtempSync(`${TMP_ROOT}/bin-`);
    fs.writeFileSync(`${outside}/node`, '#!/bin/sh\n', { mode: 0o755 });
    exec.mockClear();
    for (const bin of [`${home}/node`, `${outside}/node`, '/usr/bin/perl', '/usr/bin/sh', path.join(nodeDir(), 'bin', 'npm'), `${runtimes}/node/20.11.0/node`, '/usr/bin/python3', '/usr/lib/node']) {
      expect((await opError(runOp('app.step', { username: USER, root, step: 'npm-install', runtime: { kind: 'node', bin } }, ctx))).code, bin).toBe('refused');
    }
    for (const bin of [nodeBin(), '/usr/bin/node', `${outside}/python3`, '/usr/bin/python3.99x']) {
      expect((await opError(runOp('app.step', { username: USER, root, step: 'venv-create', runtime: { kind: 'python', bin } }, ctx))).code, bin).toBe('refused');
    }
    expect((await opError(runOp('app.step', { username: USER, root, step: 'npm-install', runtime: { kind: 'node', bin: `${runtimes}/node/21.0.0/bin/node` } }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('app.step', { username: USER, root, step: 'venv-create', runtime: { kind: 'python', bin: '/usr/local/bin/python3.99' } }, ctx))).code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
    expect(() => assertRuntimeBin({ kind: 'node', bin: `${home}/node` })).toThrow(/not an allowed node runtime/);
    expect(assertRuntimeBin({ kind: 'node', bin: nodeBin() })).toBe(nodeBin());
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it.skipIf(!canOwn)('a failing step is build_failed with the last 400 output lines', async () => {
    plantNode();
    const root = mkOwned(`${home}/apps/api3`);
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
    fakeUser(async (argv) => ({ code: 1, stdout: lines.slice(0, 450).join('\n'), stderr: `${lines.slice(450).join('\n')}\nnpm ERR! code ELIFECYCLE\n`, bin: 'runuser', argv }));
    const err = await opError(runOp('app.step', { username: USER, root, step: 'npm-run', runtime: { kind: 'node', bin: nodeBin() }, script: 'build' }, ctx));
    expect(err.code).toBe('build_failed');
    expect(err.message).toBe('npm-run failed: npm ERR! code ELIFECYCLE');
    expect(err.details.output).toHaveLength(400);
    expect(err.details.output[0]).toBe('line 102');
    expect(err.details.output[399]).toBe('npm ERR! code ELIFECYCLE');
    expect(err.details).toMatchObject({ step: 'npm-run', code: 1 });
  });
});

describe('app.unit.write and app.unit.remove', () => {
  const systemctl = (log) => {
    hasBinary.mockImplementation((n) => n === 'systemctl' || realHasBinary(n));
    exec.mockImplementation(async (bin, argv) => { expect(bin).toBe('systemctl'); log.push(argv); return { code: 0, stdout: '', stderr: '', bin, argv }; });
  };

  it.skipIf(!canOwn)('writes the env file 0600 and the unit 0644, then daemon-reloads and enables by path', async () => {
    const root = mkOwned(`${home}/apps/unit`);
    mkOwned(`${root}/node_modules/.bin`);
    fs.symlinkSync('../next/dist/bin/next', `${root}/node_modules/.bin/next`);
    const nodeBin = path.join(runtimes, 'node', '20.11.0', 'bin', 'node');
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.writeFileSync(nodeBin, '#!/bin/sh\n', { mode: 0o755 });
    const log = [];
    systemctl(log);
    const args = { id: 12, username: USER, name: 'Shop API', root, exec: { bin: nodeBin, args: ['node_modules/.bin/next', 'start', '--port', '30001'] }, port: 30001, env: { DATABASE_URL: 'postgres://u:p@h/db?x="1"', SECRET: 'a\\b' }, pathDirs: [path.dirname(nodeBin), `${root}/node_modules/.bin`], mode: 'production', limits: { memoryMaxMb: 1024, tasksMax: 512, cpuQuotaPercent: 200 } };
    const r = await runOp('app.unit.write', args, ctx);
    expect(r).toEqual({ id: 12, unit: 'whm-app-12', path: `${appsDir}/whm-app-12.service`, envPath: `${appsDir}/12.env` });
    expect(fs.statSync(r.envPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(r.path).mode & 0o777).toBe(0o644);
    expect(fs.statSync(appsDir).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(r.envPath, 'utf8')).toBe('DATABASE_URL="postgres://u:p@h/db?x=\\"1\\""\nSECRET="a\\\\b"\n');
    const unit = fs.readFileSync(r.path, 'utf8');
    expect(unit).toBe(renderUnit({ id: 12, username: USER, group: USER, name: 'Shop API', root, home, envPath: r.envPath, bin: nodeBin, args: args.exec.args, port: 30001, mode: 'production', pathDirs: args.pathDirs, limits: args.limits }));
    expect(unit).toContain(`ExecStart=${nodeBin} node_modules/.bin/next start --port 30001\n`);
    expect(unit).toContain(`Group=${USER}\n`);
    expect(unit).toContain('MemoryMax=1024M\nTasksMax=512\nCPUQuota=200%\n');
    for (const line of unit.split('\n').filter((l) => !l.startsWith('CPUQuota=') && !l.startsWith('#'))) expect(line).not.toMatch(/[%$;"'`|&<>]/);
    expect(log).toEqual([['daemon-reload'], ['enable', r.path]]);
    expect(fs.readdirSync(appsDir).some((n) => n.includes('.whm-tmp-'))).toBe(false);
    // Rewriting replaces the files in place; defaults fill the limits.
    log.length = 0;
    await runOp('app.unit.write', { id: 12, username: USER, name: 'Shop API', root, exec: { bin: `${root}/node_modules/.bin/next`, args: [] }, port: 30001 }, ctx);
    const rewritten = fs.readFileSync(r.path, 'utf8');
    expect(rewritten).toContain(`ExecStart=${root}/node_modules/.bin/next\n`);
    expect(rewritten).toContain('MemoryMax=512M\nTasksMax=256\nCPUQuota=100%\n');
    expect(rewritten).toContain('NODE_ENV=production');
    expect(fs.readFileSync(r.envPath, 'utf8')).toBe('\n');
    expect(log).toEqual([['daemon-reload'], ['enable', r.path]]);
  });

  it.skipIf(!canOwn)('refuses binaries outside the allowed directories, public_html roots and a host without systemd, writing nothing', async () => {
    const root = mkOwned(`${home}/apps/unit2`);
    mkOwned(`${root}/bin`);
    writeOwned(`${root}/bin/run`, '#!/bin/sh\n');
    mkOwned(`${root}/.venv/bin`);
    writeOwned(`${root}/.venv/bin/gunicorn`, '');
    const outside = fs.mkdtempSync(`${TMP_ROOT}/bin-`);
    fs.writeFileSync(`${outside}/node`, '', { mode: 0o755 });
    const log = [];
    systemctl(log);
    const base = { id: 13, username: USER, name: 'x', root, port: 30002 };
    for (const bin of [`${root}/bin/run`, `${outside}/node`, `${home}/node`, '/usr/sbin/nologin', '/etc/whm/apps/x', `${root}/.venv/bin`, `${root}/node_modules/.binx/run`]) {
      expect((await opError(runOp('app.unit.write', { ...base, exec: { bin, args: [] } }, ctx))).code, bin).toBe('refused');
    }
    expect((await opError(runOp('app.unit.write', { ...base, exec: { bin: `${root}/node_modules/.bin/../../bin/run`, args: [] } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('app.unit.write', { ...base, exec: { bin: '/usr/local/bin/definitely-missing-xyz', args: [] } }, ctx))).code).toBe('not_found');
    expect((await opError(runOp('app.unit.write', { ...base, exec: { bin: `${root}/node_modules/.bin/missing`, args: [] } }, ctx))).code).toBe('not_found');
    mkOwned(`${home}/public_html`);
    expect((await opError(runOp('app.unit.write', { ...base, root: `${home}/public_html`, exec: { bin: `${root}/.venv/bin/gunicorn`, args: [] } }, ctx))).code).toBe('refused');
    expect(log).toEqual([]);
    expect(fs.existsSync(`${appsDir}/whm-app-13.service`)).toBe(false);
    expect(fs.existsSync(`${appsDir}/13.env`)).toBe(false);
    expect(() => assertExecBin(`${root}/.venv/bin/gunicorn`, root)).not.toThrow();
    expect(() => assertExecBin(`${root}/bin/run`, root)).toThrow(/outside the directories/);
    hasBinary.mockImplementation((n) => (n === 'systemctl' ? false : realHasBinary(n)));
    expect((await opError(runOp('app.unit.write', { ...base, exec: { bin: `${root}/.venv/bin/gunicorn`, args: ['app:app'] } }, ctx))).code).toBe('capability_missing');
    expect(fs.existsSync(`${appsDir}/13.env`)).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('removes the unit: disable --now, unlink both files, daemon-reload, reset-failed', async () => {
    fs.mkdirSync(appsDir, { recursive: true });
    fs.writeFileSync(`${appsDir}/whm-app-14.service`, '[Unit]\n');
    fs.writeFileSync(`${appsDir}/14.env`, 'A="1"\n');
    const log = [];
    systemctl(log);
    await expect(runOp('app.unit.remove', { id: 14 }, ctx)).resolves.toEqual({ id: 14, unit: 'whm-app-14', removed: true, disabled: true });
    expect(log).toEqual([['disable', '--now', 'whm-app-14.service'], ['daemon-reload'], ['reset-failed', 'whm-app-14.service']]);
    expect(fs.existsSync(`${appsDir}/whm-app-14.service`)).toBe(false);
    expect(fs.existsSync(`${appsDir}/14.env`)).toBe(false);
    log.length = 0;
    exec.mockImplementation(async (bin, argv) => { log.push(argv); return { code: argv[0] === 'disable' ? 1 : 0, stdout: '', stderr: 'Failed to disable unit: Unit file whm-app-14.service does not exist.', bin, argv }; });
    await expect(runOp('app.unit.remove', { id: 14 }, ctx)).resolves.toEqual({ id: 14, unit: 'whm-app-14', removed: false, disabled: false });
    expect(log[0]).toEqual(['disable', '--now', 'whm-app-14.service']);
  });
});

describe('app.proxy.write', () => {
  it('vets static directories before consulting Apache and reports a host without Apache as capability_missing', async () => {
    exec.mockClear();
    const err = await opError(runOp('app.proxy.write', { domain: 'example.com', apps: [{ id: 1, kind: 'static', basePath: '/', staticDir: '/etc/dist' }] }, ctx));
    expect(err.code).toBe('path_not_allowed');
    if (!apacheLayout()?.bin) {
      expect((await opError(runOp('app.proxy.write', { domain: 'example.com', apps: [{ id: 1, kind: 'proxy', basePath: '/', port: 3000 }] }, ctx))).code).toBe('capability_missing');
      expect((await opError(runOp('app.proxy.write', { domain: 'example.com', apps: [] }, ctx))).code).toBe('capability_missing');
    }
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('app.static.expose and app.purge', () => {
  it.skipIf(!canOwn)('grants the web server traversal on the chain and read on the tree, as the account user, with ACLs or modes', async () => {
    const dir = mkOwned(`${home}/apps/site/dist`);
    const seen = [];
    fakeUser(async (argv, opts) => { expect(opts.env).toMatchObject({ HOME: home }); seen.push(argv); });
    hasBinary.mockImplementation((n) => n === 'setfacl' || realHasBinary(n));
    await expect(runOp('app.static.expose', { username: USER, dir, runUser: 'www-data' }, ctx)).resolves.toEqual({ dir, method: 'acl', chain: [home, `${home}/apps`, `${home}/apps/site`], runUser: 'www-data' });
    expect(seen).toEqual([
      ['setfacl', '-m', 'u:www-data:x', '--', home],
      ['setfacl', '-m', 'u:www-data:x', '--', `${home}/apps`],
      ['setfacl', '-m', 'u:www-data:x', '--', `${home}/apps/site`],
      ['setfacl', '-R', '-m', 'u:www-data:rX', '-m', 'd:u:www-data:rX', '--', dir],
    ]);
    seen.length = 0;
    hasBinary.mockImplementation((n) => (n === 'setfacl' ? false : realHasBinary(n)));
    await expect(runOp('app.static.expose', { username: USER, dir, runUser: 'apache' }, ctx)).resolves.toMatchObject({ method: 'mode' });
    expect(seen).toEqual([
      ['chmod', 'o+x', '--', home],
      ['chmod', 'o+x', '--', `${home}/apps`],
      ['chmod', 'o+x', '--', `${home}/apps/site`],
      ['chmod', '-R', 'o+rX', '--', dir],
    ]);
    seen.length = 0;
    const top = mkOwned(`${home}/public_html`);
    await expect(runOp('app.static.expose', { username: USER, dir: top, runUser: 'apache' }, ctx)).resolves.toMatchObject({ chain: [home] });
    expect(seen).toEqual([['chmod', 'o+x', '--', home], ['chmod', '-R', 'o+rX', '--', top]]);
  });

  it.skipIf(!canOwn)('purge removes the root as the account user and never the home or public_html', async () => {
    const root = mkOwned(`${home}/apps/gone`);
    mkOwned(`${home}/public_html`);
    const seen = [];
    fakeUser(async (argv) => { seen.push(argv); });
    await expect(runOp('app.purge', { username: USER, root }, ctx)).resolves.toEqual({ root, removed: true });
    expect(seen).toEqual([['rm', '-rf', '--', root]]);
    seen.length = 0;
    expect((await opError(runOp('app.purge', { username: USER, root: home }, ctx))).code).toBe('refused');
    expect((await opError(runOp('app.purge', { username: USER, root: `${home}/` }, ctx))).code).toBe('refused');
    expect((await opError(runOp('app.purge', { username: USER, root: `${home}/public_html` }, ctx))).code).toBe('refused');
    expect((await opError(runOp('app.purge', { username: USER, root: `${home}/public_html/` }, ctx))).code).toBe('refused');
    expect(seen).toEqual([]);
    await expect(runOp('app.purge', { username: USER, root: `${home}/public_html/old-site` }, ctx)).resolves.toEqual({ root: `${home}/public_html/old-site`, removed: false });
    expect(seen).toEqual([]);
  });
});
