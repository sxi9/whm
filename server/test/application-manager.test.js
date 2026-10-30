import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { PRESETS, resolvePreset, guessPreset, selectNodeReleases, validateStart } from '../src/services/application-manager.js';

const BIN_FULL = { apache2ctl: true, systemctl: true, node: true, python3: true, git: true, setfacl: true };
const SYSTEM_NODE = { version: '22.4.0', bin: '/usr/bin/node', source: 'system', path: '/usr/bin' };
const SYSTEM_PY = { version: '3.12.3', bin: '/usr/bin/python3', source: 'system', venv: true };
const SECRET = 'postgres://api:SecretPw1@db.internal/api';
let managedNode = [];
let systemPython = [SYSTEM_PY];
const stepFailures = new Set();
const prepareFailures = new Set();
const emptyRoots = new Set();
const stepGates = new Map();
const UNIT_WRITE = ({ id }) => ({ id, unit: `whm-app-${id}`, path: `/etc/whm/apps/whm-app-${id}.service`, envPath: `/etc/whm/apps/${id}.env` });
const GIT_FAILED = () => Object.assign(new Error('fatal: could not read Username for https://github.com: terminal prompts disabled'), { agentError: true, code: 'git_failed', details: {} });

let app;
let csrf;
let r1;
let r1Http;
let r1Csrf;
let r2Http;
let r2Csrf;
let indexServer;
let indexUrl;
let indexStatus = 200;
const mutate = (client, method, url, body, token) => client[method](url).set('X-CSRF-Token', token).send(body);
const post = (url, body = {}) => mutate(app.http, 'post', url, body, csrf);
const put = (url, body = {}) => mutate(app.http, 'put', url, body, csrf);
const del = (url) => mutate(app.http, 'delete', url, undefined, csrf);
const get = (url) => app.http.get(url);
const opsSince = (n) => app.agent.calls.slice(n).filter((c) => /^(app|svc|web)\./.test(c.name));
const names = (calls) => calls.map((c) => c.name);
const row = (id) => app.ctx.db.prepare('SELECT * FROM apps WHERE id = ?').get(id);

async function provision(installed, extra = {}) {
  app.agent.set('sys.binaries', ({ names: list }) => Object.fromEntries(list.map((n) => [n, installed ? Boolean({ ...BIN_FULL, ...extra }[n]) : Boolean(extra[n])])));
  await app.ctx.capabilities.refresh();
}

beforeAll(async () => {
  const agent = createMockAgent({
    'app.runtime.detect': () => ({ node: [SYSTEM_NODE, ...managedNode], python: systemPython, git: { installed: true, version: '2.43.0' }, arch: 'x64' }),
    'app.runtime.node.install': ({ version }) => { const e = { version, bin: `/opt/whm/runtimes/node/${version}/bin/node`, path: `/opt/whm/runtimes/node/${version}`, source: 'managed', npm: `/opt/whm/runtimes/node/${version}/bin/npm` }; managedNode.push(e); return e; },
    'app.runtime.node.remove': ({ version }) => { managedNode = managedNode.filter((m) => m.version !== version); return { version, removed: true }; },
    'app.inspect': ({ root }) => ({ root, exists: true, empty: emptyRoots.has(root), files: ['package.json', 'server.js', 'package-lock.json'], packageJson: { name: 'demo', scripts: { start: 'next start', build: 'next build' }, dependencies: ['next', 'react', 'react-dom'] }, requirements: null, angularProjects: [], hints: { preset: null, outputDir: null, startEntry: 'server.js', lockfile: 'package-lock.json' } }),
    'app.prepare': ({ root, source, scaffold }) => {
      if (prepareFailures.has(root)) throw GIT_FAILED();
      return { root, cloned: Boolean(source), scaffolded: scaffold ? ['package.json', 'server.js'] : [] };
    },
    'app.pull': ({ root }) => ({ root, head: 'abcdef1234567890abcdef1234567890abcdef12' }),
    'app.step': async ({ step, root }) => {
      if (stepGates.has(root)) await stepGates.get(root);
      if (stepFailures.has(root)) throw Object.assign(new Error('npm ERR! missing script: build'), { agentError: true, code: 'build_failed', details: { output: ['npm ERR! missing script: build'] } });
      return { step, code: 0, durationMs: 1200, output: [`${step} ok`] };
    },
    'app.unit.write': UNIT_WRITE,
    'app.unit.remove': ({ id }) => ({ id, removed: true }),
    'app.proxy.write': ({ domain, apps }) => ({ domain, path: `/etc/apache2/whm-apps/${domain}.conf`, apps: apps.length, removed: apps.length === 0, modules: { enabled: [], missing: [] }, reloaded: true }),
    'app.static.expose': ({ dir }) => ({ dir, method: 'acl', chain: ['/home/alice', '/home/alice/public_html'] }),
    'app.purge': ({ root }) => ({ root, removed: true }),
    'web.detect': () => ({ apache: { installed: true, flavor: 'debian', root: '/etc/apache2', runUser: 'www-data' } }),
    'svc.start': ({ unit }) => ({ unit, verb: 'start', output: '' }),
    'svc.stop': ({ unit }) => ({ unit, verb: 'stop', output: '' }),
    'svc.restart': ({ unit }) => ({ unit, verb: 'restart', output: '' }),
    'svc.enable': ({ unit }) => ({ unit, verb: 'enable', output: '' }),
    'svc.journal': ({ unit, lines }) => ({ unit, lines: [`${unit}: listening on 127.0.0.1`, `${unit}: ready`].slice(0, lines) }),
  });
  app = await createTestApp({ agent });
  csrf = await app.login();
  r1 = await app.createUser('resell1', 'reseller');
  r1Http = request.agent(app.ctx.app);
  r1Csrf = (await r1Http.post('/api/auth/login').send({ username: r1.username, password: r1.password })).body.data.csrfToken;
  const r2 = await app.createUser('resell2', 'reseller');
  r2Http = request.agent(app.ctx.app);
  r2Csrf = (await r2Http.post('/api/auth/login').send({ username: r2.username, password: r2.password })).body.data.csrfToken;
  const db = app.ctx.db;
  db.prepare("INSERT INTO accounts (username, domain, owner_id, home_dir, uid, gid) VALUES ('alice', 'example.com', 1, '/home/alice', 30001, 30001)").run();
  const aliceId = db.prepare("SELECT id FROM accounts WHERE username = 'alice'").get().id;
  db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'example.com', 'main', '/home/alice/public_html')").run(aliceId);
  db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'shop.example.com', 'sub', '/home/alice/public_html/shop')").run(aliceId);
  db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'parked.example.net', 'parked', NULL)").run(aliceId);
  db.prepare("INSERT INTO accounts (username, domain, owner_id, home_dir) VALUES ('bob', 'bob.example.org', ?, '/home/bob')").run(r1.id);
  db.prepare("INSERT INTO accounts (username, domain, owner_id, home_dir) VALUES ('carol', 'carol.example.net', ?, '/home/carol')").run(r2.id);
  indexServer = http.createServer((req, res) => {
    res.statusCode = indexStatus;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(indexStatus === 200 ? [
      { version: 'v23.1.0', date: '2024-10-24', files: ['linux-x64', 'linux-arm64', 'osx-arm64-tar'], lts: false },
      { version: 'v22.11.0', date: '2024-10-29', files: ['linux-x64', 'linux-arm64'], lts: 'Jod' },
      { version: 'v22.10.0', date: '2024-10-16', files: ['linux-x64'], lts: false },
      { version: 'v21.7.3', date: '2024-04-03', files: ['linux-x64'], lts: false },
      { version: 'v20.18.0', date: '2024-10-03', files: ['linux-x64', 'linux-arm64'], lts: 'Iron' },
      { version: 'v20.17.0', date: '2024-08-21', files: ['linux-x64'], lts: 'Iron' },
      { version: 'v18.20.4', date: '2024-07-08', files: ['linux-x64'], lts: 'Hydrogen' },
      { version: 'v0.10.48', date: '2016-10-18', files: ['linux-x86', 'linux-x64'], lts: false },
    ] : { error: 'nope' }));
  });
  await new Promise((resolve) => indexServer.listen(0, '127.0.0.1', resolve));
  indexUrl = `http://127.0.0.1:${indexServer.address().port}/index.json`;
  app.ctx.jobs.start();
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => indexServer.close(resolve));
  await app.close();
});

describe('presets (pure)', () => {
  it('ships every built-in preset', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['express', 'nestjs', 'nextjs', 'nuxt', 'node-custom', 'react-vite', 'react-cra', 'angular', 'vue', 'svelte', 'static-files', 'flask', 'django', 'fastapi', 'python-custom']);
    for (const p of PRESETS) expect(p).toMatchObject({ id: expect.any(String), label: expect.any(String), kind: expect.stringMatching(/^(node|python|static)$/), detect: { files: expect.any(Array) } });
  });

  it('resolves a preset with user overrides winning', () => {
    expect(resolvePreset('flask')).toMatchObject({ kind: 'python', preset: 'flask', runtimeKind: 'python', start: { mode: 'gunicorn', module: 'app:app', workers: 2 }, build: { install: 'pip', script: null, outputDir: null, extraPackages: [] }, websockets: true, spaFallback: false });
    expect(resolvePreset('react-vite', { build: { outputDir: 'out' }, spaFallback: false })).toMatchObject({ kind: 'static', runtimeKind: 'node', start: null, build: { install: 'npm', script: 'build', outputDir: 'out' }, websockets: false, spaFallback: false });
    expect(resolvePreset('static-files')).toMatchObject({ kind: 'static', runtimeKind: null, build: { install: null, script: null, outputDir: '.' } });
    expect(resolvePreset('static-files', { build: { script: 'build' } })).toMatchObject({ runtimeKind: 'node', build: { install: null, script: 'build' } });
    expect(resolvePreset('react-vite', { build: { install: null } })).toMatchObject({ runtimeKind: 'node', build: { install: null, script: 'build' } });
    expect(resolvePreset('express', { start: { entry: 'app.js' } }).start).toEqual({ mode: 'file', entry: 'app.js' });
    expect(resolvePreset('express', { start: { mode: 'npm-script', script: 'serve' } }).start).toEqual({ mode: 'npm-script', script: 'serve' });
    expect(resolvePreset('node-custom').build).toMatchObject({ script: 'build', optional: true });
    expect(resolvePreset(null, { kind: 'node' })).toMatchObject({ preset: null, start: { mode: 'npm-script', script: 'start' }, build: { install: 'npm' } });
  });

  it('refuses incompatible combinations', () => {
    expect(() => resolvePreset('nope')).toThrow(/Unknown preset/);
    expect(() => resolvePreset('express', { kind: 'python' })).toThrow(/builds node applications/);
    expect(() => resolvePreset(null, {})).toThrow(/Choose a kind/);
    expect(() => resolvePreset(null, { kind: 'node', start: { mode: 'file' } })).toThrow(/needs "entry"/);
    expect(() => resolvePreset('flask', { start: { mode: 'npm-script', script: 'x' } })).toThrow(/not available for python/);
    expect(() => resolvePreset('django', {})).toThrow(/<project>/);
    expect(() => validateStart('node', { mode: 'gunicorn', module: 'a:b' })).toThrow(/not available for node/);
  });

  it('guesses a preset from an inspection', () => {
    expect(guessPreset({ packageJson: { scripts: {}, dependencies: ['vite', 'react'] }, files: ['package.json'] }).preset.id).toBe('react-vite');
    expect(guessPreset({ packageJson: { scripts: {}, dependencies: ['@angular/core'] }, files: [], angularProjects: ['shop'] })).toMatchObject({ preset: { id: 'angular' }, outputDir: 'dist/shop/browser' });
    expect(guessPreset({ packageJson: { scripts: { start: 'node index.js' }, dependencies: ['express'] }, files: ['app.js'] })).toMatchObject({ preset: { id: 'express' }, start: { mode: 'file', entry: 'app.js' } });
    expect(guessPreset({ packageJson: { scripts: { start: 'node x' }, dependencies: ['koa'] }, files: [] }).preset.id).toBe('node-custom');
    expect(guessPreset({ requirements: ['Django', 'psycopg2'], files: ['manage.py'] }).preset.id).toBe('django');
    expect(guessPreset({ requirements: ['fastapi'], files: ['main.py'] }).preset.id).toBe('fastapi');
    expect(guessPreset({ files: ['index.html', 'style.css'] }).preset.id).toBe('static-files');
    expect(guessPreset({ files: [] }).preset).toBeNull();
    expect(guessPreset({ hints: { preset: 'nuxt' }, packageJson: { dependencies: ['express'] } }).preset.id).toBe('nuxt');
  });

  it('selects the current and LTS lines from the nodejs.org index', () => {
    const picked = selectNodeReleases([
      { version: 'v23.1.0', files: ['linux-x64'], lts: false }, { version: 'v22.11.0', files: ['linux-x64'], lts: 'Jod' }, { version: 'v22.10.0', files: ['linux-x64'], lts: false },
      { version: 'v21.7.3', files: ['linux-x64'], lts: false }, { version: 'v20.18.0', files: ['linux-arm64'], lts: 'Iron' }, { version: 'v20.17.0', files: ['linux-x64'], lts: 'Iron' }, { version: 'v0.10.48', files: ['linux-x86'], lts: false }, { version: 'garbage' },
    ]);
    expect(picked.map((r) => [r.version, r.line])).toEqual([['23.1.0', 'current'], ['22.11.0', 'lts'], ['20.18.0', 'lts']]);
  });
});

describe('Application Manager API', () => {
  let apiId;
  let apiPort;
  let shopId;
  let flaskId;
  let bobAppId;

  it('refuses to create an application while Apache is missing (501 with the capability)', async () => {
    systemPython = [];
    const res = await post('/api/apps', { username: 'alice', name: 'API', preset: 'express', domain: 'example.com', root: '/home/alice/apps/api' });
    expect(res.status).toBe(501);
    expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'apache' });
    const runtimes = await get('/api/apps/runtimes');
    expect(runtimes.status).toBe(200);
    expect(runtimes.body.data.capabilities).toMatchObject({ apache: false, node: false, python: false });
    systemPython = [SYSTEM_PY];
  });

  it('names the missing runtime when only Node.js is absent', async () => {
    await provision(true, { node: false, nodejs: false });
    const res = await post('/api/apps', { username: 'alice', name: 'API', preset: 'express', domain: 'example.com', root: '/home/alice/apps/api' });
    expect(res.status).toBe(501);
    expect(res.body.error.capability).toBe('node');
    await provision(true);
  });

  it('serves every built-in preset', async () => {
    const res = await get('/api/apps/presets');
    expect(res.status).toBe(200);
    for (const p of PRESETS) expect(res.body.data.map((x) => x.id)).toContain(p.id);
  });

  it('lists the domains an account can publish on', async () => {
    const res = await get('/api/apps/accounts/alice/domains');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ domain: 'example.com', type: 'main', docroot: '/home/alice/public_html' }, { domain: 'shop.example.com', type: 'sub', docroot: '/home/alice/public_html/shop' }]);
    expect((await r2Http.get('/api/apps/accounts/alice/domains')).status).toBe(403);
  });

  it('inspects a directory and suggests a preset', async () => {
    const res = await post('/api/apps/inspect', { username: 'alice', root: '/home/alice/apps/next' });
    expect(res.status).toBe(200);
    expect(res.body.data.suggestion).toMatchObject({ preset: 'nextjs', kind: 'node', lockfile: 'package-lock.json' });
    expect(res.body.data.preset.id).toBe('nextjs');
    expect((await post('/api/apps/inspect', { username: 'alice', root: '/home/bob/apps/next' })).status).toBe(422);
    expect((await post('/api/apps/inspect', { username: 'alice', root: '/home/alice/apps/../../etc' })).status).toBe(422);
    expect((await post('/api/apps/inspect', { username: 'alice', root: '/home/alice/my app' })).status).toBe(422);
  });

  it('validates the create request before touching the host', async () => {
    const base = { username: 'alice', name: 'API', preset: 'express', domain: 'example.com', root: '/home/alice/apps/api' };
    const cases = [
      [{ ...base, domain: 'bob.example.org' }, /does not belong/],
      [{ ...base, domain: 'parked.example.net' }, /does not belong/],
      [{ ...base, root: '/home/bob/apps/api' }, /inside \/home\/alice/],
      [{ ...base, root: '/home/alice' }, /home directory itself/],
      [{ ...base, root: '/home/alice/public_html' }, /public_html/],
      [{ ...base, root: '/home/alice/.ssh/x' }, /hidden/],
      [{ ...base, env: { 'bad-key': 'x' } }, /validation/i],
      [{ ...base, env: { OK: 'line1\nline2' } }, /validation/i],
      [{ ...base, source: { type: 'git', url: 'http://github.com/x/y.git' } }, /validation/i],
      [{ ...base, source: { type: 'git', url: 'https://user:pw@github.com/x/y.git' } }, /validation/i],
      [{ ...base, source: { type: 'git', url: 'https://github.com/x/y.git', ref: '--upload-pack=x' } }, /validation/i],
      [{ ...base, preset: 'nope' }, /Unknown preset/],
      [{ ...base, kind: 'python' }, /builds node/],
      [{ ...base, start: { mode: 'file', entry: '../x.js' } }, /validation/i],
      [{ ...base, start: { mode: 'file', entry: 'a b.js' } }, /validation/i],
      [{ ...base, basePath: 'api' }, /validation/i],
      [{ ...base, name: 'a;b' }, /validation/i],
      [{ ...base, source: { type: 'scaffold', template: 'flask' } }, /goes with/],
      [{ ...base, limits: { memoryMaxMb: 8 } }, /validation/i],
      [{ ...base, limits: { tasksMax: 40000 } }, /validation/i],
      [{ ...base, root: '/home/alice/my app' }, /validation/i],
      [{ ...base, root: "/home/alice/apps/it's" }, /validation/i],
      [{ ...base, root: '/home/alice/apps/100%' }, /validation/i],
      [{ ...base, root: '/home/alice/apps/café' }, /validation/i],
      [{ ...base, basePath: '/.' }, /validation/i],
      [{ ...base, basePath: '/./x' }, /validation/i],
      [{ ...base, basePath: '/x/..' }, /validation/i],
      [{ ...base, start: { mode: 'npm-script', script: '-x' } }, /validation/i],
      [{ ...base, extra: true }, /validation/i],
    ];
    const before = app.agent.calls.length;
    for (const [body, message] of cases) {
      const res = await post('/api/apps', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.message, JSON.stringify(body)).toMatch(message);
    }
    expect(opsSince(before)).toEqual([]);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM apps').get().n).toBe(0);
  });

  it('creates a NestJS app and the deploy job runs prepare → install → build → unit → proxy → start', async () => {
    const before = app.agent.calls.length;
    const res = await post('/api/apps', { username: 'alice', name: 'API', preset: 'nestjs', domain: 'example.com', basePath: '/api/', root: '/home/alice/apps/api', env: { DATABASE_URL: SECRET, LOG_LEVEL: 'info' }, source: { type: 'git', url: 'https://github.com/example/api.git', ref: 'main' } });
    expect(res.status).toBe(202);
    const { app: created, job } = res.body.data;
    apiId = created.id;
    apiPort = created.port;
    expect(created).toMatchObject({ kind: 'node', preset: 'nestjs', basePath: '/api', url: 'https://example.com/api', status: 'created', runtime: { kind: 'node', version: 'system', bin: null }, start: { mode: 'file', entry: 'dist/main.js' }, build: { install: 'npm', script: 'build' }, source: { type: 'git', url: 'https://github.com/example/api.git', ref: 'main' }, env: { DATABASE_URL: SECRET, LOG_LEVEL: 'info' } });
    expect(apiPort).toBeGreaterThanOrEqual(30000);
    expect(apiPort).toBeLessThanOrEqual(39999);
    const done = await waitForJob(app.ctx, job.id);
    expect(done.status, done.error).toBe('done');
    const calls = opsSince(before);
    expect(names(calls)).toEqual(['app.prepare', 'app.runtime.detect', 'app.step', 'app.step', 'app.unit.write', 'app.proxy.write', 'svc.start']);
    expect(calls[0].args).toEqual({ username: 'alice', root: '/home/alice/apps/api', source: { gitUrl: 'https://github.com/example/api.git', ref: 'main' } });
    expect(calls[2].args).toEqual({ username: 'alice', root: '/home/alice/apps/api', step: 'npm-install', runtime: { kind: 'node', bin: '/usr/bin/node' }, production: false });
    expect(calls[3].args).toEqual({ username: 'alice', root: '/home/alice/apps/api', step: 'npm-run', runtime: { kind: 'node', bin: '/usr/bin/node' }, script: 'build', production: true });
    expect(calls[4].args).toEqual({ id: apiId, username: 'alice', name: 'API', root: '/home/alice/apps/api', exec: { bin: '/usr/bin/node', args: ['dist/main.js'] }, port: apiPort, env: { DATABASE_URL: SECRET, LOG_LEVEL: 'info' }, pathDirs: ['/usr/bin', '/home/alice/apps/api/node_modules/.bin'], mode: 'production', limits: { memoryMaxMb: 512, tasksMax: 256, cpuQuotaPercent: 100 } });
    expect(calls[5].args).toEqual({ domain: 'example.com', apps: [{ id: apiId, kind: 'proxy', basePath: '/api', port: apiPort, websockets: true, spaFallback: false }], reload: true, docroot: '/home/alice/public_html' });
    expect(calls[6].args).toEqual({ unit: `whm-app-${apiId}` });
    const shown = await get(`/api/apps/${apiId}`);
    expect(shown.status).toBe(200);
    expect(shown.body.data).toMatchObject({ status: 'running', unit: `whm-app-${apiId}`, proxyPath: '/etc/apache2/whm-apps/example.com.conf', runtime: { bin: '/usr/bin/node' }, lastError: null, live: { active: true } });
    expect(done.logs.map((l) => l.line).join('\n')).toMatch(/Cloned https:\/\/github.com\/example\/api.git \(main\)/);
  });

  it('keeps env values out of every audit row', async () => {
    // Environment maps are redacted as a whole (audit middleware SECRET_KEYS): no key, no value.
    const rows = app.ctx.db.prepare("SELECT action, args_redacted FROM audit_log WHERE args_redacted LIKE '%\"env\"%'").all();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.args_redacted).not.toContain('SecretPw1');
      expect(r.args_redacted).not.toContain('DATABASE_URL');
      const parsed = JSON.parse(r.args_redacted);
      expect(parsed.env ?? parsed.args?.env).toBe('[redacted]');
    }
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%SecretPw1%'").get().n).toBe(0);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'app.create'").get().n).toBe(1);
    expect(app.ctx.db.prepare("SELECT env_enc FROM apps WHERE id = ?").get(apiId).env_enc).toMatch(/^v1:/);
  });

  it('redacts env values in the automatic audit row when validation or RBAC rejects the request before the handler', async () => {
    const base = { username: 'alice', name: 'Leak', preset: 'express', domain: 'example.com', root: '/home/alice/apps/leak', env: { DATABASE_URL: SECRET } };
    const plain = await app.createUser('plainuser', 'user');
    const uHttp = request.agent(app.ctx.app);
    const uCsrf = (await uHttp.post('/api/auth/login').send({ username: plain.username, password: plain.password })).body.data.csrfToken;
    const before = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    expect((await post('/api/apps', { ...base, basePath: 'bad' })).status).toBe(422);
    const badValue = await post('/api/apps', { ...base, basePath: '/leak', env: { DATABASE_URL: `${SECRET}\nextra` } });
    expect(badValue.status).toBe(422);
    expect(badValue.body.error.fields).toHaveProperty('env.DATABASE_URL');
    expect((await post('/api/apps', { ...base, basePath: '/leak', env: `DATABASE_URL=${SECRET}` })).status).toBe(422);
    expect((await put(`/api/apps/${apiId}`, { bogus: true, env: { DATABASE_URL: SECRET } })).status).toBe(422);
    expect((await put(`/api/apps/${apiId}`, { env: { DATABASE_URL: `${SECRET}\nextra` } })).status).toBe(422);
    expect((await mutate(uHttp, 'post', '/api/apps', base, uCsrf)).status).toBe(403);
    expect((await mutate(uHttp, 'put', `/api/apps/${apiId}`, { env: { DATABASE_URL: SECRET } }, uCsrf)).status).toBe(403);
    const rows = app.ctx.db.prepare('SELECT action, args_redacted, result FROM audit_log WHERE id > (SELECT MAX(id) FROM (SELECT id FROM audit_log ORDER BY id LIMIT ?))').all(before);
    expect(rows.filter((r) => /^(POST|PUT) \/api\/apps/.test(r.action)).length).toBe(7);
    for (const r of rows) {
      expect(r.result).toMatch(/^error:4/);
      expect(r.args_redacted).not.toContain('SecretPw1');
      expect(JSON.parse(r.args_redacted).env).toEqual(expect.anything());
    }
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%SecretPw1%'").get().n).toBe(0);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM apps WHERE name = 'Leak'").get().n).toBe(0);
    expect(app.ctx.db.prepare('SELECT name FROM apps WHERE id = ?').get(apiId).name).toBe('API');
  });

  it('builds a static React app, exposes the output and writes a static block without a unit', async () => {
    const before = app.agent.calls.length;
    const res = await post('/api/apps', { username: 'alice', name: 'Shop UI', preset: 'react-vite', domain: 'shop.example.com', root: '/home/alice/public_html/shop/', source: { type: 'upload' } });
    expect(res.status).toBe(202);
    shopId = res.body.data.app.id;
    expect(res.body.data.app).toMatchObject({ kind: 'static', port: null, root: '/home/alice/public_html/shop', runtime: { kind: 'node', version: 'system' }, spaFallback: true, websockets: false, source: { type: 'upload' } });
    const done = await waitForJob(app.ctx, res.body.data.job.id);
    expect(done.status, done.error).toBe('done');
    const calls = opsSince(before);
    expect(names(calls)).toEqual(['app.prepare', 'app.runtime.detect', 'app.step', 'app.step', 'web.detect', 'app.static.expose', 'app.proxy.write']);
    expect(calls[0].args).toEqual({ username: 'alice', root: '/home/alice/public_html/shop' });
    expect(calls[5].args).toEqual({ username: 'alice', dir: '/home/alice/public_html/shop/dist', runUser: 'www-data' });
    expect(calls[6].args).toEqual({ domain: 'shop.example.com', apps: [{ id: shopId, kind: 'static', basePath: '/', staticDir: '/home/alice/public_html/shop/dist', websockets: false, spaFallback: true }], reload: true, docroot: '/home/alice/public_html/shop' });
    expect(row(shopId)).toMatchObject({ status: 'built', unit: null, proxy_path: '/etc/apache2/whm-apps/shop.example.com.conf' });
    expect(JSON.parse(row(shopId).build_json)).toMatchObject({ outputDir: 'dist', resolvedOutputDir: 'dist' });
    expect(done.result).toMatchObject({ status: 'built', staticDir: '/home/alice/public_html/shop/dist' });
    const ctl = await post(`/api/apps/${shopId}/restart`);
    expect(ctl.status).toBe(422);
    expect(ctl.body.error.code).toBe('unsupported');
    const logs = await get(`/api/apps/${shopId}/logs`);
    expect(logs.body.data).toMatchObject({ lines: [], note: expect.stringMatching(/Apache/) });
  });

  it('deploys a Flask scaffold into a venv with gunicorn and shares the domain include', async () => {
    const before = app.agent.calls.length;
    const res = await post('/api/apps', { username: 'alice', name: 'Flask API', domain: 'example.com', basePath: '/py', root: '/home/alice/apps/flask', source: { type: 'scaffold', template: 'flask' }, build: { extraPackages: ['psycopg2-binary==2.9.9'] } });
    expect(res.status).toBe(202);
    flaskId = res.body.data.app.id;
    const flaskPort = res.body.data.app.port;
    expect(res.body.data.app).toMatchObject({ kind: 'python', preset: 'flask', runtime: { kind: 'python', version: 'system' }, start: { mode: 'gunicorn', module: 'app:app', workers: 2 }, source: { type: 'scaffold', template: 'flask' } });
    expect(flaskPort).not.toBe(apiPort);
    const done = await waitForJob(app.ctx, res.body.data.job.id);
    expect(done.status, done.error).toBe('done');
    const calls = opsSince(before);
    // The create request checks for a venv-capable interpreter before the row exists; the job resolves it again.
    expect(names(calls)).toEqual(['app.runtime.detect', 'app.prepare', 'app.runtime.detect', 'app.step', 'app.step', 'app.unit.write', 'app.proxy.write', 'svc.start']);
    expect(calls[1].args).toEqual({ username: 'alice', root: '/home/alice/apps/flask', scaffold: { template: 'flask', name: 'Flask API' } });
    expect(calls[3].args).toEqual({ username: 'alice', root: '/home/alice/apps/flask', step: 'venv-create', runtime: { kind: 'python', bin: '/usr/bin/python3' } });
    expect(calls[4].args).toEqual({ username: 'alice', root: '/home/alice/apps/flask', step: 'pip-install', runtime: { kind: 'python', bin: '/usr/bin/python3' }, packages: ['psycopg2-binary==2.9.9', 'gunicorn'] });
    expect(calls[5].args).toMatchObject({ exec: { bin: '/home/alice/apps/flask/.venv/bin/gunicorn', args: ['app:app', '--bind', `127.0.0.1:${flaskPort}`, '--workers', '2'] }, pathDirs: ['/home/alice/apps/flask/.venv/bin'], env: {} });
    expect(calls[6].args.apps).toEqual([{ id: apiId, kind: 'proxy', basePath: '/api', port: apiPort, websockets: true, spaFallback: false }, { id: flaskId, kind: 'proxy', basePath: '/py', port: flaskPort, websockets: true, spaFallback: false }]);
    expect(row(flaskId)).toMatchObject({ status: 'running', unit: `whm-app-${flaskId}`, runtime_bin: '/usr/bin/python3' });
  });

  it('refuses a Python application at creation while python3-venv is missing (501 with the capability, nothing allocated)', async () => {
    // Fresh Debian/Ubuntu: python3 on PATH, but `import venv, ensurepip` fails until python3-venv is installed.
    systemPython = [{ ...SYSTEM_PY, venv: false }];
    const apps = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM apps').get().n;
    const before = app.agent.calls.length;
    const res = await post('/api/apps', { username: 'alice', name: 'No venv', domain: 'example.com', basePath: '/novenv', root: '/home/alice/apps/novenv', source: { type: 'scaffold', template: 'fastapi' } });
    expect(res.status).toBe(501);
    expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'python', message: expect.stringMatching(/python3-venv/) });
    expect(names(opsSince(before))).toEqual(['app.runtime.detect']);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM apps').get().n).toBe(apps);
    // Switching an existing app to a version without venv support is refused the same way.
    const upd = await put(`/api/apps/${flaskId}`, { runtimeVersion: '3.12' });
    expect(upd.status).toBe(501);
    expect(upd.body.error).toMatchObject({ capability: 'python', message: expect.stringMatching(/3\.12 with venv support/) });
    expect(row(flaskId).runtime_version).toBe('system');
    // Runtime Versions reports Python as missing although python3 is on PATH.
    expect((await get('/api/apps/runtimes')).body.data.capabilities).toMatchObject({ python: false, node: true });
    // A requested version that no interpreter provides names what was found.
    systemPython = [SYSTEM_PY];
    const other = await put(`/api/apps/${flaskId}`, { runtimeVersion: '3.11' });
    expect(other.status).toBe(501);
    expect(other.body.error.message).toMatch(/Python 3\.11 is not installed on this server \(found 3\.12\.3\)/);
    // No interpreter at all.
    systemPython = [];
    const none = await post('/api/apps', { username: 'alice', name: 'No python', domain: 'example.com', basePath: '/nopy', root: '/home/alice/apps/nopy', source: { type: 'scaffold', template: 'flask' } });
    expect(none.status).toBe(501);
    expect(none.body.error).toMatchObject({ capability: 'python', message: expect.stringMatching(/Python 3 is not installed/) });
    expect((await get('/api/apps/runtimes')).body.data.capabilities.python).toBe(false);
    // A Node.js app does not probe the interpreters.
    const nodeBefore = app.agent.calls.length;
    expect((await post('/api/apps', { username: 'alice', name: 'Bad domain', preset: 'express', domain: 'bob.example.org', root: '/home/alice/apps/x' })).status).toBe(422);
    expect(names(opsSince(nodeBefore))).toEqual([]);
    systemPython = [SYSTEM_PY];
    expect((await get('/api/apps/runtimes')).body.data.capabilities.python).toBe(true);
  });

  it('runs uvicorn for FastAPI with the port on the command line', () => {
    expect(resolvePreset('fastapi').start).toEqual({ mode: 'uvicorn', module: 'main:app' });
    const spec = app.ctx.apps.shape(row(flaskId));
    expect(spec.start.mode).toBe('gunicorn');
  });

  it('keeps base paths unique per domain, ports unique and roots disjoint', async () => {
    const dup = await post('/api/apps', { username: 'alice', name: 'Dup', preset: 'express', domain: 'example.com', basePath: '/api', root: '/home/alice/apps/dup' });
    expect(dup.status).toBe(409);
    const overlap = await post('/api/apps', { username: 'alice', name: 'Nested', preset: 'express', domain: 'example.com', basePath: '/nested', root: '/home/alice/apps/api/sub' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.message).toMatch(/overlaps/);
    const ports = app.ctx.db.prepare('SELECT port FROM apps WHERE port IS NOT NULL').all().map((r) => r.port);
    expect(new Set(ports).size).toBe(ports.length);
    for (const p of ports) { expect(p).toBeGreaterThanOrEqual(30000); expect(p).toBeLessThanOrEqual(39999); }
    app.ctx.settings.set('apps.port_range', [30000, 30001]);
    const full = await post('/api/apps', { username: 'alice', name: 'Full', preset: 'express', domain: 'example.com', basePath: '/full', root: '/home/alice/apps/full' });
    expect(full.status).toBe(409);
    expect(full.body.error.message).toMatch(/No free application port/);
    app.ctx.settings.set('apps.port_range', [30000, 39999]);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM apps').get().n).toBe(3);
  });

  it('lists, filters and searches applications', async () => {
    const all = await get('/api/apps?sort=name');
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(3);
    expect(all.body.data.map((a) => a.name)).toEqual(['API', 'Flask API', 'Shop UI']);
    expect(all.body.data[0].env).toEqual({ DATABASE_URL: SECRET, LOG_LEVEL: 'info' });
    expect((await get('/api/apps?kind=static')).body.data.map((a) => a.id)).toEqual([shopId]);
    expect((await get('/api/apps?q=flask')).body.data.map((a) => a.id)).toEqual([flaskId]);
    expect((await get('/api/apps?status=running')).body.meta.total).toBe(2);
    expect((await get('/api/apps?account=bob')).body.meta.total).toBe(0);
  });

  it('controls the service and reads its journal', async () => {
    const before = app.agent.calls.length;
    const stop = await post(`/api/apps/${apiId}/stop`);
    expect(stop.status).toBe(200);
    expect(stop.body.data).toMatchObject({ id: apiId, verb: 'stop', status: 'stopped', live: { active: true } });
    expect(row(apiId).status).toBe('stopped');
    const start = await post(`/api/apps/${apiId}/start`);
    expect(start.status).toBe(200);
    expect(row(apiId).status).toBe('running');
    expect((await post(`/api/apps/${apiId}/restart`)).status).toBe(200);
    expect(names(opsSince(before)).filter((n) => n.startsWith('svc.') && n !== 'svc.status')).toEqual(['svc.stop', 'svc.start', 'svc.restart']);
    expect(opsSince(before)[0].args).toEqual({ unit: `whm-app-${apiId}` });
    expect((await post(`/api/apps/${apiId}/reload`)).status).toBe(422);
    const logs = await get(`/api/apps/${apiId}/logs?lines=1`);
    expect(logs.status).toBe(200);
    expect(logs.body.data).toEqual({ id: apiId, unit: `whm-app-${apiId}`, lines: [`whm-app-${apiId}: listening on 127.0.0.1`] });
    expect(app.agent.callsTo('svc.journal').at(-1).args).toEqual({ unit: `whm-app-${apiId}`, lines: 1 });
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('app.stop', 'app.start', 'app.restart')").get().n).toBe(3);
  });

  it('redeploys from git with a pull and rebuilds without one', async () => {
    let before = app.agent.calls.length;
    const dep = await post(`/api/apps/${apiId}/deploy`);
    expect(dep.status).toBe(202);
    let done = await waitForJob(app.ctx, dep.body.data.job.id);
    expect(done.status, done.error).toBe('done');
    let calls = opsSince(before);
    expect(names(calls)).toEqual(['app.pull', 'app.runtime.detect', 'app.step', 'app.step', 'app.unit.write', 'app.proxy.write', 'svc.restart']);
    expect(calls[0].args).toEqual({ username: 'alice', root: '/home/alice/apps/api', ref: 'main' });
    expect(calls[5].args.apps.map((a) => a.id)).toEqual([apiId, flaskId]);
    expect((await post(`/api/apps/${flaskId}/deploy`)).status).toBe(422);
    before = app.agent.calls.length;
    const rb = await post(`/api/apps/${flaskId}/rebuild`);
    expect(rb.status).toBe(202);
    done = await waitForJob(app.ctx, rb.body.data.job.id);
    expect(done.status, done.error).toBe('done');
    calls = opsSince(before);
    expect(names(calls)).toEqual(['app.runtime.detect', 'app.step', 'app.step', 'app.unit.write', 'app.proxy.write', 'svc.restart']);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('app.deploy', 'app.rebuild')").get().n).toBe(2);
  });

  it('updates env, limits and flags in place, rewriting the unit and the include', async () => {
    const before = app.agent.calls.length;
    const res = await put(`/api/apps/${apiId}`, { env: { NEW_SECRET: 'hunter2-value', LOG_LEVEL: 'debug' }, limits: { memoryMaxMb: 1024 }, websockets: false, name: 'API v2' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'API v2', websockets: false, limits: { memoryMaxMb: 1024 }, env: { NEW_SECRET: 'hunter2-value', LOG_LEVEL: 'debug' }, applied: { unit: true, restarted: true, proxy: true, rebuildRequired: false } });
    const calls = opsSince(before);
    expect(names(calls)).toEqual(['app.unit.write', 'app.proxy.write', 'svc.restart']);
    expect(calls[0].args).toMatchObject({ id: apiId, name: 'API v2', env: { NEW_SECRET: 'hunter2-value', LOG_LEVEL: 'debug' }, limits: { memoryMaxMb: 1024, tasksMax: 256, cpuQuotaPercent: 100 } });
    expect(calls[1].args.apps.find((a) => a.id === apiId).websockets).toBe(false);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%hunter2-value%'").get().n).toBe(0);
    expect(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'app.update'").get().args_redacted).toContain('"env":"[redacted]"');
    const build = await put(`/api/apps/${apiId}`, { build: { script: 'compile' }, start: { entry: 'dist/server.js' } });
    expect(build.status).toBe(200);
    expect(build.body.data).toMatchObject({ start: { mode: 'file', entry: 'dist/server.js' }, build: { script: 'compile' }, applied: { rebuildRequired: true } });
    expect((await put(`/api/apps/${shopId}`, { start: { mode: 'file', entry: 'x.js' } })).status).toBe(422);
    expect((await put(`/api/apps/${apiId}`, { domain: 'other.example.com' })).status).toBe(422);
    expect((await put(`/api/apps/${apiId}`, { runtimeVersion: '3.12' })).status).toBe(422);
  });

  it('persists an update only after the host accepted it', async () => {
    expect((await put(`/api/apps/${apiId}`, { limits: { tasksMax: 40000 } })).status).toBe(422);
    expect((await put(`/api/apps/${apiId}`, { start: { mode: 'npm-script', script: '-x' } })).status).toBe(422);
    const snapshot = row(apiId);
    app.agent.fail('app.unit.write', 'invalid_args', 'limits.tasksMax: Number must be less than or equal to 32768');
    let before = app.agent.calls.length;
    const refused = await put(`/api/apps/${apiId}`, { limits: { tasksMax: 20000 }, env: { NEW_SECRET: 'other' }, websockets: true });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('invalid_args');
    expect(names(opsSince(before))).toEqual(['app.unit.write']);
    expect(row(apiId)).toEqual(snapshot);
    expect(app.ctx.apps.shape(row(apiId)).env).toEqual({ NEW_SECRET: 'hunter2-value', LOG_LEVEL: 'debug' });
    app.agent.set('app.unit.write', UNIT_WRITE);
    app.agent.fail('app.proxy.write', 'config_invalid', 'Syntax error on line 3');
    before = app.agent.calls.length;
    const badInclude = await put(`/api/apps/${apiId}`, { name: 'API v3', websockets: true });
    expect(badInclude.status).toBe(422);
    const calls = opsSince(before);
    expect(names(calls)).toEqual(['app.unit.write', 'app.proxy.write', 'app.unit.write']);
    expect(calls[0].args.name).toBe('API v3');
    expect(calls[2].args.name).toBe('API v2');
    expect(row(apiId)).toEqual(snapshot);
    app.agent.set('app.proxy.write', ({ domain, apps }) => ({ domain, path: `/etc/apache2/whm-apps/${domain}.conf`, apps: apps.length, removed: apps.length === 0, modules: { enabled: [], missing: [] }, reloaded: true }));
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'app.update'").get().n).toBe(2);
  });

  it('marks the app failed when a build step fails', async () => {
    stepFailures.add('/home/alice/apps/broken');
    const res = await post('/api/apps', { username: 'alice', name: 'Broken', preset: 'nextjs', domain: 'example.com', basePath: '/broken', root: '/home/alice/apps/broken', source: { type: 'upload' } });
    expect(res.status).toBe(202);
    const done = await waitForJob(app.ctx, res.body.data.job.id);
    expect(done.status).toBe('failed');
    expect(done.error_code).toBe('build_failed');
    const shown = await get(`/api/apps/${res.body.data.app.id}`);
    expect(shown.body.data).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/missing script/), unit: null, proxyPath: null });
    expect(app.agent.callsTo('app.unit.write').some((c) => c.args.id === res.body.data.app.id)).toBe(false);
    const removed = await del(`/api/apps/${res.body.data.app.id}?deleteFiles=true`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.cleanup).toEqual({ purge: { root: '/home/alice/apps/broken', removed: true } });
    stepFailures.clear();
  });

  it('confines resellers to their own accounts and honours apps.allow_resellers', async () => {
    const res = await mutate(r1Http, 'post', '/api/apps', { username: 'bob', name: 'Bob site', preset: 'express', domain: 'bob.example.org', root: '/home/bob/apps/site', source: { type: 'scaffold', template: 'express' } }, r1Csrf);
    expect(res.status).toBe(202);
    bobAppId = res.body.data.app.id;
    expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('done');
    expect((await mutate(r1Http, 'post', '/api/apps', { username: 'alice', name: 'Nope', preset: 'express', domain: 'example.com', basePath: '/nope', root: '/home/alice/apps/nope' }, r1Csrf)).status).toBe(403);
    expect((await r2Http.get(`/api/apps/${bobAppId}`)).status).toBe(403);
    expect((await mutate(r2Http, 'post', `/api/apps/${bobAppId}/stop`, {}, r2Csrf)).status).toBe(403);
    expect((await mutate(r2Http, 'put', `/api/apps/${bobAppId}`, { name: 'x' }, r2Csrf)).status).toBe(403);
    expect((await mutate(r2Http, 'delete', `/api/apps/${bobAppId}`, undefined, r2Csrf)).status).toBe(403);
    expect((await r2Http.get(`/api/apps/${bobAppId}/logs`)).status).toBe(403);
    expect((await r2Http.get('/api/apps')).body.data).toEqual([]);
    expect((await r1Http.get('/api/apps')).body.data.map((a) => a.id)).toEqual([bobAppId]);
    expect((await get('/api/apps')).body.meta.total).toBe(4);
    expect((await r1Http.get(`/api/apps/${bobAppId}`)).body.data.env).toEqual({});
    app.ctx.settings.set('apps.allow_resellers', false);
    expect((await mutate(r1Http, 'post', `/api/apps/${bobAppId}/stop`, {}, r1Csrf)).status).toBe(403);
    expect((await mutate(r1Http, 'post', '/api/apps', { username: 'bob', name: 'Two', preset: 'express', domain: 'bob.example.org', basePath: '/two', root: '/home/bob/apps/two' }, r1Csrf)).status).toBe(403);
    expect((await r1Http.get(`/api/apps/${bobAppId}`)).status).toBe(200);
    expect((await post(`/api/apps/${bobAppId}/stop`)).status).toBe(200);
    app.ctx.settings.set('apps.allow_resellers', true);
    expect((await mutate(r1Http, 'post', `/api/apps/${bobAppId}/start`, {}, r1Csrf)).status).toBe(200);
    for (const url of ['/api/apps/runtimes/node/available', '/api/apps/templates', '/api/apps/settings']) expect((await r1Http.get(url)).status).toBe(403);
    expect((await mutate(r1Http, 'post', '/api/apps/runtimes/node/install', { version: '20.11.0' }, r1Csrf)).status).toBe(403);
    expect((await r1Http.get('/api/apps/runtimes')).status).toBe(200);
  });

  it('removes an app: stop, unit removal, include rewrite with the remaining apps, optional purge', async () => {
    let before = app.agent.calls.length;
    const res = await del(`/api/apps/${flaskId}?deleteFiles=true`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: flaskId, removed: true, cleanup: { stop: { verb: 'stop' }, unit: { id: flaskId, removed: true }, proxy: { apps: 1, removed: false }, purge: { root: '/home/alice/apps/flask', removed: true } } });
    let calls = opsSince(before);
    expect(names(calls)).toEqual(['svc.stop', 'app.unit.remove', 'app.proxy.write', 'app.purge']);
    expect(calls[0].args).toEqual({ unit: `whm-app-${flaskId}` });
    expect(calls[1].args).toEqual({ id: flaskId });
    expect(calls[2].args).toEqual({ domain: 'example.com', apps: [{ id: apiId, kind: 'proxy', basePath: '/api', port: apiPort, websockets: false, spaFallback: false }], reload: true, docroot: '/home/alice/public_html' });
    expect(calls[3].args).toEqual({ username: 'alice', root: '/home/alice/apps/flask' });
    expect((await get(`/api/apps/${flaskId}`)).status).toBe(404);
    before = app.agent.calls.length;
    const stat = await del(`/api/apps/${shopId}`);
    expect(stat.status).toBe(200);
    calls = opsSince(before);
    expect(names(calls)).toEqual(['app.proxy.write']);
    expect(calls[0].args).toEqual({ domain: 'shop.example.com', apps: [], reload: true, docroot: '/home/alice/public_html/shop' });
    expect(stat.body.data.cleanup.proxy).toMatchObject({ removed: true });
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'app.remove'").get().n).toBe(3);
  });

  it('removes the apps of a terminated account without purging the home', async () => {
    const before = app.agent.calls.length;
    const res = await del('/api/accounts/bob');
    expect(res.status).toBe(200);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM apps WHERE username = 'bob'").get().n).toBe(0);
    const calls = opsSince(before);
    expect(calls.find((c) => c.name === 'app.unit.remove')?.args).toEqual({ id: bobAppId });
    expect(calls.find((c) => c.name === 'app.proxy.write')?.args).toEqual({ domain: 'bob.example.org', apps: [], reload: true, docroot: '/home/bob/public_html' });
    expect(calls.some((c) => c.name === 'app.purge')).toBe(false);
    const terminate = JSON.parse(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.terminate'").get().args_redacted);
    expect(terminate.cleanup.apps.removed).toEqual([bobAppId]);
  });

  it('tolerates a host without systemd or Apache when removing', async () => {
    const res = await post('/api/apps', { username: 'alice', name: 'Temp', preset: 'express', domain: 'example.com', basePath: '/temp', root: '/home/alice/apps/temp', source: { type: 'scaffold', template: 'express' } });
    expect(res.status).toBe(202);
    expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('done');
    await provision(true, { apache2ctl: false, systemctl: false });
    const before = app.agent.calls.length;
    const removed = await del(`/api/apps/${res.body.data.app.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.cleanup).toEqual({ unit: { skipped: expect.stringMatching(/systemd/) }, proxy: { skipped: expect.stringMatching(/Apache/) } });
    expect(opsSince(before)).toEqual([]);
    expect((await get(`/api/apps/${res.body.data.app.id}`)).status).toBe(404);
    await provision(true);
  });
});

describe('Runtime Versions API', () => {
  let oldNodeAppId;

  it('lists detected runtimes with defaults and capabilities', async () => {
    const res = await get('/api/apps/runtimes');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ defaults: { node: 'system', python: 'system' }, git: { installed: true }, arch: 'x64', capabilities: { apache: true, systemd: true, node: true, python: true, git: true, acl: true }, policy: { portRange: [30000, 39999], allowResellers: true, defaultMemoryMb: 512 } });
    expect(res.body.data.node).toEqual([{ ...SYSTEM_NODE, managed: false, missing: false, apps: 1, default: true }]);
    expect(res.body.data.python).toEqual([{ ...SYSTEM_PY, default: true }]);
  });

  it('fetches the available Node.js releases and degrades to an empty list on failure', async () => {
    app.ctx.settings.set('apps.node_index_url', indexUrl);
    indexStatus = 500;
    let res = await get('/api/apps/runtimes/node/available');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ available: [], error: expect.stringMatching(/500/) });
    indexStatus = 200;
    res = await get('/api/apps/runtimes/node/available');
    expect(res.status).toBe(200);
    expect(res.body.data.error).toBeNull();
    expect(res.body.data.available).toEqual([
      { version: '23.1.0', lts: false, date: '2024-10-24', line: 'current', installed: false },
      { version: '22.11.0', lts: 'Jod', date: '2024-10-29', line: 'lts', installed: false },
      { version: '20.18.0', lts: 'Iron', date: '2024-10-03', line: 'lts', installed: false },
      { version: '18.20.4', lts: 'Hydrogen', date: '2024-07-08', line: 'lts', installed: false },
    ]);
  });

  it('installs a managed Node.js version through a job and uses it for an app', async () => {
    expect((await post('/api/apps/runtimes/node/install', { version: '20' })).status).toBe(422);
    const res = await post('/api/apps/runtimes/node/install', { version: '20.11.0' });
    expect(res.status).toBe(202);
    const done = await waitForJob(app.ctx, res.body.data.job.id);
    expect(done.status, done.error).toBe('done');
    expect(done.result).toEqual({ version: '20.11.0', path: '/opt/whm/runtimes/node/20.11.0', bin: '/opt/whm/runtimes/node/20.11.0/bin/node', npm: '/opt/whm/runtimes/node/20.11.0/bin/npm' });
    expect(app.agent.callsTo('app.runtime.node.install').at(-1).args).toEqual({ version: '20.11.0' });
    expect(app.ctx.db.prepare("SELECT * FROM app_runtimes WHERE kind = 'node' AND version = '20.11.0'").get()).toMatchObject({ path: '/opt/whm/runtimes/node/20.11.0', bin: '/opt/whm/runtimes/node/20.11.0/bin/node' });
    expect((await post('/api/apps/runtimes/node/install', { version: '20.11.0' })).status).toBe(409);
    const list = await get('/api/apps/runtimes');
    expect(list.body.data.node.find((n) => n.version === '20.11.0')).toMatchObject({ source: 'managed', managed: true, missing: false, apps: 0, default: false, installedAt: expect.any(String) });
    const before = app.agent.calls.length;
    const created = await post('/api/apps', { username: 'alice', name: 'Old node', preset: 'express', domain: 'example.com', basePath: '/old', root: '/home/alice/apps/old', runtimeVersion: '20.11.0', source: { type: 'scaffold', template: 'express' } });
    expect(created.status).toBe(202);
    oldNodeAppId = created.body.data.app.id;
    expect((await waitForJob(app.ctx, created.body.data.job.id)).status).toBe('done');
    const unit = opsSince(before).find((c) => c.name === 'app.unit.write');
    expect(unit.args).toMatchObject({ exec: { bin: '/opt/whm/runtimes/node/20.11.0/bin/node', args: ['server.js'] }, pathDirs: ['/opt/whm/runtimes/node/20.11.0/bin', '/home/alice/apps/old/node_modules/.bin'] });
    expect(opsSince(before).find((c) => c.name === 'app.step').args).toMatchObject({ step: 'npm-install', runtime: { bin: '/opt/whm/runtimes/node/20.11.0/bin/node' }, production: true });
    expect((await get('/api/apps/runtimes')).body.data.node.find((n) => n.version === '20.11.0').apps).toBe(1);
  });

  it('manages defaults and refuses to remove a runtime in use', async () => {
    expect((await put('/api/apps/runtimes/defaults', { node: '21.0.0' })).status).toBe(422);
    const set = await put('/api/apps/runtimes/defaults', { node: '20.11.0', python: '3.12' });
    expect(set.status).toBe(200);
    expect(set.body.data).toEqual({ node: '20.11.0', python: '3.12' });
    const inUse = await del('/api/apps/runtimes/node/20.11.0');
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.message).toMatch(/Old node/);
    expect((await del(`/api/apps/${oldNodeAppId}`)).status).toBe(200);
    const removed = await del('/api/apps/runtimes/node/20.11.0');
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ version: '20.11.0', removed: true });
    expect(app.agent.callsTo('app.runtime.node.remove').at(-1).args).toEqual({ version: '20.11.0' });
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM app_runtimes").get().n).toBe(0);
    expect((await get('/api/apps/runtimes')).body.data.defaults).toEqual({ node: 'system', python: '3.12' });
    expect((await put('/api/apps/runtimes/defaults', { python: 'system' })).status).toBe(200);
    const policy = await put('/api/apps/settings', { portRange: [31000, 32000], defaultMemoryMb: 256 });
    expect(policy.status).toBe(200);
    expect(policy.body.data).toEqual({ portRange: [31000, 32000], allowResellers: true, defaultMemoryMb: 256 });
    expect((await put('/api/apps/settings', { portRange: [32000, 31000] })).status).toBe(422);
    await put('/api/apps/settings', { portRange: [30000, 39999], defaultMemoryMb: 512 });
  });
});

describe('Application Templates API', () => {
  let templateId;

  it('creates, lists, applies, updates and removes custom templates', async () => {
    const bad = await post('/api/apps/templates', { slug: 'py-npm', name: 'Broken', kind: 'python', preset: { start: { mode: 'npm-script', script: 'x' } } });
    expect(bad.status).toBe(422);
    expect((await post('/api/apps/templates', { slug: 'express', name: 'Clash', kind: 'node', preset: {} })).status).toBe(409);
    const res = await post('/api/apps/templates', { slug: 'company-express', name: 'Company Express', kind: 'node', description: 'Our Express layout', preset: { start: { mode: 'file', entry: 'src/index.js' }, build: { install: 'npm', script: null }, websockets: false, mode: 'development', limits: { memoryMaxMb: 256 }, runtimeVersion: 'system' } });
    expect(res.status).toBe(201);
    templateId = res.body.data.id;
    expect(res.body.data).toMatchObject({ slug: 'company-express', kind: 'node', preset: { start: { mode: 'file', entry: 'src/index.js' }, websockets: false } });
    expect((await post('/api/apps/templates', { slug: 'company-express', name: 'Again', kind: 'node', preset: {} })).status).toBe(409);
    const presets = await get('/api/apps/presets');
    expect(presets.body.data.find((p) => p.id === 'company-express')).toMatchObject({ custom: true, templateId, label: 'Company Express', kind: 'node', install: 'npm', build: null, start: { mode: 'file', entry: 'src/index.js' }, websockets: false, defaults: { mode: 'development', limits: { memoryMaxMb: 256 } } });
    expect((await get('/api/apps/templates')).body.data.map((t) => t.slug)).toEqual(['company-express']);
    const created = await post('/api/apps', { username: 'alice', name: 'From template', preset: 'company-express', domain: 'example.com', basePath: '/tpl', root: '/home/alice/apps/tpl', limits: { cpuQuotaPercent: 50 } });
    expect(created.status).toBe(202);
    expect(created.body.data.app).toMatchObject({ preset: 'company-express', kind: 'node', mode: 'development', websockets: false, start: { mode: 'file', entry: 'src/index.js' }, build: { install: 'npm', script: null }, limits: { memoryMaxMb: 256, tasksMax: 256, cpuQuotaPercent: 50 } });
    expect((await waitForJob(app.ctx, created.body.data.job.id)).status).toBe('done');
    expect(app.agent.callsTo('app.unit.write').at(-1).args).toMatchObject({ exec: { bin: '/usr/bin/node', args: ['src/index.js'] }, mode: 'development', limits: { memoryMaxMb: 256, cpuQuotaPercent: 50 } });
    const upd = await put(`/api/apps/templates/${templateId}`, { name: 'Company Express 2', preset: { start: { mode: 'npm-script', script: 'serve' } } });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ name: 'Company Express 2', preset: { start: { mode: 'npm-script', script: 'serve' } } });
    expect((await mutate(r1Http, 'post', '/api/apps/templates', { slug: 'x', name: 'x', kind: 'node', preset: {} }, r1Csrf)).status).toBe(403);
    expect((await del(`/api/apps/templates/${templateId}`)).status).toBe(200);
    expect((await get(`/api/apps/templates/${templateId}`)).status).toBe(404);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'app.template.%'").get().n).toBe(3);
    expect((await del(`/api/apps/${created.body.data.app.id}`)).status).toBe(200);
  });
});

describe('deploy edge cases', () => {
  it('resolves the Node runtime for a static app that only runs a build script', async () => {
    const before = app.agent.calls.length;
    const res = await post('/api/apps', { username: 'alice', name: 'Docs site', preset: 'static-files', domain: 'example.com', basePath: '/docs', root: '/home/alice/public_html/docs', build: { script: 'build' }, source: { type: 'upload' } });
    expect(res.status).toBe(202);
    const id = res.body.data.app.id;
    expect(res.body.data.app).toMatchObject({ kind: 'static', runtime: { kind: 'node', version: 'system' }, build: { install: null, script: 'build', outputDir: '.' } });
    const done = await waitForJob(app.ctx, res.body.data.job.id);
    expect(done.status, done.error).toBe('done');
    const calls = opsSince(before);
    expect(names(calls)).toEqual(['app.prepare', 'app.runtime.detect', 'app.step', 'web.detect', 'app.static.expose', 'app.proxy.write']);
    expect(calls[2].args).toEqual({ username: 'alice', root: '/home/alice/public_html/docs', step: 'npm-run', runtime: { kind: 'node', bin: '/usr/bin/node' }, script: 'build', production: true });
    expect(row(id)).toMatchObject({ status: 'built', runtime_kind: 'node', runtime_bin: '/usr/bin/node', last_error: null });
    const upd = await put(`/api/apps/${id}`, { build: { install: 'npm' } });
    expect(upd.status).toBe(200);
    expect(row(id).runtime_kind).toBe('node');
    expect((await put(`/api/apps/${id}`, { build: { install: null, script: null } })).status).toBe(200);
    expect(row(id)).toMatchObject({ runtime_kind: null, runtime_bin: null });
    expect((await del(`/api/apps/${id}`)).status).toBe(200);
  });

  it('refuses an update while a deployment runs and writes the unit from the current row', async () => {
    const root = '/home/alice/apps/slow';
    let release;
    stepGates.set(root, new Promise((resolve) => { release = resolve; }));
    const before = app.agent.calls.length;
    const res = await post('/api/apps', { username: 'alice', name: 'Slow', preset: 'express', domain: 'example.com', basePath: '/slow', root, env: { TOKEN_A: 'one' }, source: { type: 'scaffold', template: 'express' } });
    expect(res.status).toBe(202);
    const id = res.body.data.app.id;
    for (let i = 0; i < 100 && !app.agent.callsTo('app.step').some((c) => c.args.root === root); i++) await new Promise((r) => setTimeout(r, 20));
    expect(app.agent.callsTo('app.step').some((c) => c.args.root === root)).toBe(true);
    const blocked = await put(`/api/apps/${id}`, { env: { TOKEN_A: 'two' } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/running/);
    expect((await del(`/api/apps/${id}`)).status).toBe(409);
    expect((await post(`/api/apps/${id}/rebuild`)).status).toBe(409);
    app.ctx.db.prepare('UPDATE apps SET name = ?, env_enc = ? WHERE id = ?').run('Slow renamed', app.ctx.crypto.encrypt(JSON.stringify({ TOKEN_A: 'three' })), id);
    release();
    stepGates.delete(root);
    const done = await waitForJob(app.ctx, res.body.data.job.id);
    expect(done.status, done.error).toBe('done');
    const unit = opsSince(before).find((c) => c.name === 'app.unit.write');
    expect(unit.args).toMatchObject({ id, name: 'Slow renamed', env: { TOKEN_A: 'three' } });
    expect((await put(`/api/apps/${id}`, { env: { TOKEN_A: 'four' } })).status).toBe(200);
    expect((await del(`/api/apps/${id}`)).status).toBe(200);
  });

  it('recovers an app whose initial clone failed: deploy clones an empty root instead of pulling', async () => {
    const root = '/home/alice/apps/private';
    prepareFailures.add(root);
    const res = await post('/api/apps', { username: 'alice', name: 'Private', preset: 'express', domain: 'example.com', basePath: '/private', root, source: { type: 'git', url: 'https://github.com/example/private.git' } });
    expect(res.status).toBe(202);
    const id = res.body.data.app.id;
    const failed = await waitForJob(app.ctx, res.body.data.job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error_code).toBe('git_failed');
    expect(row(id)).toMatchObject({ status: 'failed', unit: null, proxy_path: null, last_error: expect.stringMatching(/terminal prompts disabled/) });
    prepareFailures.delete(root);
    emptyRoots.add(root);
    let before = app.agent.calls.length;
    const retry = await post(`/api/apps/${id}/deploy`);
    expect(retry.status).toBe(202);
    const done = await waitForJob(app.ctx, retry.body.data.job.id);
    expect(done.status, done.error).toBe('done');
    let calls = opsSince(before);
    expect(names(calls)).toEqual(['app.inspect', 'app.prepare', 'app.runtime.detect', 'app.step', 'app.unit.write', 'app.proxy.write', 'svc.start']);
    expect(calls[1].args).toEqual({ username: 'alice', root, source: { gitUrl: 'https://github.com/example/private.git' } });
    expect(row(id)).toMatchObject({ status: 'running', unit: `whm-app-${id}` });
    emptyRoots.delete(root);
    before = app.agent.calls.length;
    const again = await post(`/api/apps/${id}/deploy`);
    expect(again.status).toBe(202);
    expect((await waitForJob(app.ctx, again.body.data.job.id)).status).toBe('done');
    expect(names(opsSince(before))).toEqual(['app.pull', 'app.runtime.detect', 'app.step', 'app.unit.write', 'app.proxy.write', 'svc.restart']);
    expect((await del(`/api/apps/${id}`)).status).toBe(200);
  });

  it('pulls instead of cloning when the clone succeeded but a later step failed, and rebuild keeps the files', async () => {
    const root = '/home/alice/apps/halfway';
    stepFailures.add(root);
    const res = await post('/api/apps', { username: 'alice', name: 'Halfway', preset: 'express', domain: 'example.com', basePath: '/halfway', root, source: { type: 'git', url: 'https://github.com/example/halfway.git', ref: 'v2' } });
    expect(res.status).toBe(202);
    const id = res.body.data.app.id;
    expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('failed');
    stepFailures.delete(root);
    let before = app.agent.calls.length;
    const rb = await post(`/api/apps/${id}/rebuild`);
    expect(rb.status).toBe(202);
    expect((await waitForJob(app.ctx, rb.body.data.job.id)).status).toBe('done');
    let calls = opsSince(before);
    expect(names(calls)).toEqual(['app.inspect', 'app.runtime.detect', 'app.step', 'app.unit.write', 'app.proxy.write', 'svc.start']);
    expect(calls.some((c) => c.name === 'app.pull' || c.name === 'app.prepare')).toBe(false);
    expect((await del(`/api/apps/${id}`)).status).toBe(200);
    stepFailures.add(root);
    const res2 = await post('/api/apps', { username: 'alice', name: 'Halfway 2', preset: 'express', domain: 'example.com', basePath: '/halfway2', root, source: { type: 'git', url: 'https://github.com/example/halfway.git', ref: 'v2' } });
    expect(res2.status).toBe(202);
    const id2 = res2.body.data.app.id;
    expect((await waitForJob(app.ctx, res2.body.data.job.id)).status).toBe('failed');
    stepFailures.delete(root);
    before = app.agent.calls.length;
    const dep = await post(`/api/apps/${id2}/deploy`);
    expect(dep.status).toBe(202);
    expect((await waitForJob(app.ctx, dep.body.data.job.id)).status).toBe('done');
    calls = opsSince(before);
    expect(names(calls)).toEqual(['app.inspect', 'app.pull', 'app.runtime.detect', 'app.step', 'app.unit.write', 'app.proxy.write', 'svc.start']);
    expect(calls[1].args).toEqual({ username: 'alice', root, ref: 'v2' });
    expect((await del(`/api/apps/${id2}`)).status).toBe(200);
  });
});
