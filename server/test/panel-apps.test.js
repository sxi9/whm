import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { portRange, normalizeMount, DEFAULT_PORT_RANGE, JOB_DEPS, PROXY_MODULES } from '../src/services/panel-apps.js';

// An Apache host with the Application Manager ops in memory: units written,
// modules enabled, ports probed and proxies rendered are all recorded so the
// routes are checked end to end through the real /api/panel session flow.
function hostAgent() {
  const state = { units: new Map(), modules: new Set(['core', 'ssl']), busyPorts: new Set(), files: new Set(['/home/alice/apps/probe-app/server.js', '/home/alice/apps/py/app.py', '/home/alice/apps/py/requirements.txt', '/home/bob/apps/bob-app/server.js']), apache: true, depsFail: false, onWrite: null };
  const fail = (code, message, details = {}) => Object.assign(new Error(message), { agentError: true, code, details });
  const guard = (username, p) => { if (!p.startsWith(`/home/${username}/`)) throw fail('path_not_allowed', `${p} is not inside the home directory /home/${username}`); };
  const show = (unit) => {
    const u = state.units.get(unit);
    if (!u) return { unit, installed: false, active: false, state: 'absent', subState: null, enabled: false, pid: null, startedAt: null, memoryBytes: null, restarts: 0, result: null };
    return { unit, installed: true, active: u.active, state: u.active ? 'active' : u.failed ? 'failed' : 'inactive', subState: u.active ? 'running' : 'dead', enabled: true, pid: u.active ? 4242 : null, startedAt: u.active ? '2026-11-06T10:00:00Z' : null, memoryBytes: u.active ? 12_345_678 : null, restarts: 0, result: u.failed ? 'exit-code' : 'success' };
  };
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['setpriv', 'runuser', 'systemctl', 'useradd', 'usermod', 'userdel', ...(state.apache ? ['apache2ctl'] : [])].includes(n)])),
    'svc.list_units': () => (state.apache ? ['apache2'] : []),
    'web.detect': () => ({ apache: state.apache ? { installed: true, flavor: 'debian', runUser: 'www-data', modules: [...state.modules].map((name) => ({ name, type: 'shared' })) } : { installed: false }, nginx: { installed: false }, php: { installed: false, versions: [] }, ftp: { daemons: [] }, dovecot: { installed: false }, exim: { installed: false }, systemd: true, logrotate: false }),
    'web.vhost.write': ({ domain, proxies, reload }) => ({ domain, path: `/etc/apache2/sites-available/${domain}.conf`, link: `/etc/apache2/sites-enabled/${domain}.conf`, validated: true, bytes: 500, proxies: proxies?.length ?? 0, reloaded: reload !== false, unit: 'apache2' }),
    'web.reload': () => ({ validated: true, reloaded: true, unit: 'apache2' }),
    'web.modules.status': ({ modules }) => ({ flavor: 'debian', a2tools: true, modules: Object.fromEntries(modules.map((m) => [m, state.modules.has(m)])), missing: modules.filter((m) => !state.modules.has(m)) }),
    'web.modules.enable': ({ modules }) => { for (const m of modules) state.modules.add(m); return { enabled: modules, alreadyLoaded: [], validated: true, reloaded: true, unit: 'apache2' }; },
    'pkg.runtime.detect': () => ({ os: { id: 'ubuntu' }, php: [], node: { system: { version: 'v22.14.0', path: '/usr/bin/node' }, versions: [{ major: 20, version: 'v20.20.2', path: '/opt/keel/node/20', bin: '/opt/keel/node/20/bin/node' }] }, python: [{ minor: '3.12', version: '3.12.3', bin: '/usr/bin/python3.12' }] }),
    'apps.port.free': ({ port }) => ({ port, free: !state.busyPorts.has(port), checked: true }),
    'apps.unit.write': (a) => {
      const dir = `/home/${a.username}/${a.dir}`;
      guard(a.username, `${dir}/`);
      if (!state.files.has(`${dir}/${a.entry}`)) throw fail('not_found', `${a.dir}/${a.entry} does not exist; upload the application first`);
      const unit = `keel-app-${a.username}.${a.name}`;
      state.units.set(unit, { ...a, active: true, failed: false });
      if (state.onWrite) state.onWrite(a);
      return { unit, path: `/etc/whm/apps/${a.username}/${a.name}.service`, bytes: 900, interpreter: a.type === 'node' ? '/usr/bin/node' : '/usr/bin/python3', venv: false, started: true, startError: null, status: show(unit) };
    },
    'apps.unit.remove': ({ username, name }) => { const unit = `keel-app-${username}.${name}`; const existed = state.units.delete(unit); return { unit, path: `/etc/whm/apps/${username}/${name}.service`, removed: existed }; },
    'apps.unit.control': ({ username, name, action }) => {
      const unit = `keel-app-${username}.${name}`;
      const u = state.units.get(unit);
      if (!u) throw fail('not_found', `${unit} is not installed`);
      u.active = action !== 'stop';
      return { unit, action, status: show(unit) };
    },
    'apps.unit.status': ({ username, name }) => show(`keel-app-${username}.${name}`),
    'apps.unit.logs': ({ username, name, lines }) => ({ unit: `keel-app-${username}.${name}`, lines: [`listening on 31000 (${lines})`, 'GET / 200'] }),
    'apps.deps.install': ({ username, dir, type }) => {
      guard(username, `/home/${username}/${dir}/`);
      if (state.depsFail) throw fail('command_failed', 'npm install: ERR! code E404');
      return type === 'node' ? { dir, type, steps: [{ step: 'npm install', command: 'npm install --omit=dev', code: 0, output: 'added 12 packages' }] } : { dir, type, steps: [{ step: 'python -m venv', command: 'python3.12 -m venv .venv', code: 0, output: '' }, { step: 'pip install', command: 'python -m pip install -r requirements.txt', code: 0, output: 'Successfully installed flask' }] };
    },
  };
  const agent = createMockAgent(ops);
  agent.state = state;
  return agent;
}

describe('panel-apps helpers', () => {
  it('reads the port pool from the setting and falls back to the default', () => {
    expect(portRange({ get: () => null })).toEqual(DEFAULT_PORT_RANGE);
    expect(portRange({ get: () => [40000, 40100] })).toEqual({ min: 40000, max: 40100 });
    expect(portRange({ get: () => ({ min: 40000, max: 40100 }) })).toEqual({ min: 40000, max: 40100 });
    for (const bad of [[80, 90], [5000, 4000], ['a', 'b'], [31000, 70000], 'x']) expect(portRange({ get: () => bad }), JSON.stringify(bad)).toEqual(DEFAULT_PORT_RANGE);
    expect(normalizeMount('')).toBe('/');
    expect(normalizeMount('/app/')).toBe('/app');
    expect(normalizeMount('app')).toBe('/app');
    expect(JOB_DEPS).toBe('panel.apps.deps');
    expect(PROXY_MODULES).toEqual(['proxy', 'proxy_http', 'proxy_wstunnel', 'rewrite']);
  });
});

describe('/api/panel/apps', () => {
  let app;
  let alice;
  let aliceCsrf;
  let bob;
  let bobCsrf;
  let rootCsrf;
  const db = () => app.ctx.db;
  const state = () => app.agent.state;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', rootCsrf).send(body);
  const audits = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC').all(action);
  const get = (p = '') => alice.get(`/api/panel/apps${p}`);
  const post = (p, body = {}) => alice.post(`/api/panel/apps${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const put = (p, body = {}) => alice.put(`/api/panel/apps${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const del = (p) => alice.delete(`/api/panel/apps${p}`).set('X-CSRF-Token', aliceCsrf);
  const setFeature = (username, key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.${key}', json(?)) WHERE username = ?`).run(JSON.stringify(value), username);
  const setPlan = (key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.${key}', json(?)) WHERE username = 'alice'`).run(JSON.stringify(value));
  const calls = (name) => app.agent.calls.filter((c) => c.name === name);
  const probe = { name: 'probe-app', type: 'node', dir: 'apps/probe-app', entry: 'server.js', runtime: '20', domain: 'alice.com', mount: '/probe-app', env: { NODE_OPTIONS: '--max-old-space-size=128', GREETING: 'hello' } };

  async function loginAs(username, password) {
    await rootPost(`/api/panel/admin/accounts/${username}/password`, { password }).expect(200);
    const http = request.agent(app.ctx.app);
    const res = await http.post('/api/auth/login').send({ username, password });
    expect(res.status).toBe(200);
    return { http, csrf: res.body.data.csrfToken };
  }

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    rootCsrf = await app.login();
    app.ctx.jobs.start();
    // Accounts are provisioned without Apache (no vhost mocks needed); the
    // daemon "appears" afterwards, as it does on a host that installs it later.
    state().apache = false;
    await app.ctx.capabilities.refresh();
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/accounts', { username: 'bob', domain: 'bob.com', contactEmail: 'bob@bob.com' }).expect(201);
    db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES ((SELECT id FROM accounts WHERE username = 'alice'), 'shop.alice.com', 'sub', '/home/alice/public_html/shop')").run();
    state().apache = true;
    await app.ctx.capabilities.refresh();
    ({ http: alice, csrf: aliceCsrf } = await loginAs('alice', 'Alice-Passw0rd!'));
    ({ http: bob, csrf: bobCsrf } = await loginAs('bob', 'Bob-Passw0rd!!'));
  }, 60_000);
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; state().depsFail = false; state().onWrite = null; });

  it('lists nothing at first with the sites, the port pool and the Apache state', async () => {
    const res = await get().expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ total: 0, apache: true, portRange: { min: 31000, max: 31999 }, limit: null });
    expect(res.body.meta.sites).toEqual([{ domain: 'alice.com', type: 'main' }, { domain: 'shop.alice.com', type: 'sub' }]);
  });

  it('offers the runtimes the host has', async () => {
    const res = await get('/runtimes').expect(200);
    expect(res.body.data.node.map((r) => r.id)).toEqual(['20', 'system']);
    expect(res.body.data.node[0]).toMatchObject({ label: 'Node.js v20.20.2 (Keel build)', keel: true });
    expect(res.body.data.python.map((r) => r.id)).toEqual(['3.12', 'system']);
    expect(res.body.data.portRange).toEqual({ min: 31000, max: 31999 });
  });

  it('refuses bad names, paths, runtimes, mounts and variables before the agent is called', async () => {
    const cases = [
      [{ ...probe, name: 'A' }, 'name'], [{ ...probe, name: 'x' }, 'name'], [{ ...probe, name: 'a b' }, 'name'],
      [{ ...probe, dir: '../etc' }, 'dir'], [{ ...probe, dir: 'apps/../../x' }, 'dir'], [{ ...probe, dir: 'a b' }, 'dir'], [{ ...probe, dir: '.' }, 'dir'],
      [{ ...probe, entry: '../server.js' }, 'entry'], [{ ...probe, entry: 'a;b' }, 'entry'],
      [{ ...probe, runtime: 'latest' }, 'runtime'], [{ ...probe, runtime: '3.12' }, 'runtime'], [{ ...probe, type: 'python', runtime: '20' }, 'runtime'],
      [{ ...probe, mount: '/a b' }, 'mount'], [{ ...probe, mount: '/../x' }, 'mount'], [{ ...probe, mount: '/x?y' }, 'mount'],
      [{ ...probe, env: { PORT: '80' } }, 'env'], [{ ...probe, env: { lower: 'x' } }, 'env'], [{ ...probe, env: { '1X': 'x' } }, 'env'], [{ ...probe, env: { X: 'a\nb' } }, 'env'], [{ ...probe, env: { X: 'x'.repeat(1025) } }, 'env'],
    ];
    for (const [body, field] of cases) {
      const res = await post('', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(Object.keys(res.body.error.fields || {}).some((k) => k === field || k.startsWith(`${field}.`)), `${field} ${JSON.stringify(body)}`).toBe(true);
    }
    for (const body of [{ ...probe, type: 'ruby' }, { ...probe, extra: 1 }, { ...probe, dir: '' }]) expect((await post('', body)).status, JSON.stringify(body)).toBe(422);
    expect(calls('apps.unit.write')).toHaveLength(0);
    expect(calls('web.modules.enable')).toHaveLength(0);
  });

  it('answers 404 for a domain that is not the account\'s and for a missing start file', async () => {
    expect((await post('', { ...probe, domain: 'bob.com' })).status).toBe(404);
    expect((await post('', { ...probe, domain: 'nobody.example' })).status).toBe(404);
    const missing = await post('', { ...probe, entry: 'index.js' });
    expect(missing.status).toBe(404);
    // A leading slash is tolerated as "relative to the home": /etc/x is ~/etc/x, which does not exist.
    expect((await post('', { ...probe, dir: '/etc/x' })).status).toBe(404);
    expect(calls('apps.unit.write').every((c) => c.args.dir.startsWith('apps/') || c.args.dir === 'etc/x')).toBe(true);
    expect(db().prepare('SELECT COUNT(*) AS n FROM panel_apps').get().n).toBe(0);
  });

  it('creates the app: unit written as the account, port from the pool, modules enabled once, proxy rendered on the vhost', async () => {
    const res = await post('', probe);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'probe-app', type: 'node', dir: 'apps/probe-app', entry: 'server.js', runtime: '20', port: 31000, domain: 'alice.com', mount: '/probe-app', websocket: true, env: probe.env, status: 'running', unit: 'keel-app-alice.probe-app', url: 'http://alice.com/probe-app/', applied: true, started: true });
    expect(res.body.data.service).toMatchObject({ state: 'active', pid: 4242 });
    const write = calls('apps.unit.write');
    expect(write).toHaveLength(1);
    expect(write[0].args).toEqual({ username: 'alice', name: 'probe-app', type: 'node', dir: 'apps/probe-app', entry: 'server.js', runtime: '20', port: 31000, env: probe.env, memoryMax: null });
    expect(calls('web.modules.status')[0].args.modules).toEqual(['proxy', 'proxy_http', 'proxy_wstunnel', 'rewrite']);
    expect(calls('web.modules.enable')[0].args.modules).toEqual(['proxy', 'proxy_http', 'proxy_wstunnel', 'rewrite']);
    const vhost = calls('web.vhost.write');
    expect(vhost).toHaveLength(1);
    expect(vhost[0].args).toMatchObject({ domain: 'alice.com', user: 'alice', proxies: [{ path: '/probe-app', port: 31000, websocket: true }] });
    const row = db().prepare('SELECT * FROM panel_apps WHERE name = ?').get('probe-app');
    expect(row).toMatchObject({ port: 31000, domain: 'alice.com', mount: '/probe-app', status: 'running', websocket: 1 });
    expect(JSON.parse(db().prepare("SELECT proxies_json FROM web_vhosts WHERE domain = 'alice.com'").get().proxies_json)).toEqual([{ path: '/probe-app', port: 31000, websocket: true }]);
    expect(audits('web.modules.enable')[0]).toBeTruthy();
    expect(audits('panel.apps.create')[0].target).toBe('alice');
    expect(JSON.parse(audits('panel.apps.create')[0].args_json ?? audits('panel.apps.create')[0].args ?? '{}')).not.toHaveProperty('env');
  });

  it('keeps names and mounts unique and skips ports that are taken on the host', async () => {
    expect((await post('', probe)).status).toBe(409);
    expect((await post('', { ...probe, name: 'twin' })).status).toBe(409);
    state().busyPorts.add(31001);
    const res = await post('', { name: 'py-app', type: 'python', dir: 'apps/py', entry: 'app.py', runtime: '3.12', domain: 'shop.alice.com', mount: '/', websocket: false });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ port: 31002, domain: 'shop.alice.com', mount: '/', websocket: false, url: 'http://shop.alice.com/' });
    expect(calls('web.modules.enable')).toHaveLength(0);
    expect(calls('web.vhost.write').pop().args).toMatchObject({ domain: 'shop.alice.com', proxies: [{ path: '/', port: 31002, websocket: false }] });
    expect(calls('apps.unit.write')[0].args.memoryMax).toBeNull();
  });

  it('passes the plan memory limit to the unit', async () => {
    setPlan('app_memory_mb', 256);
    try {
      const res = await put('/1', { env: { GREETING: 'hi' } });
      expect(res.status).toBe(200);
      expect(calls('apps.unit.write')[0].args).toMatchObject({ memoryMax: '256M', env: { GREETING: 'hi' }, port: 31000 });
      expect(res.body.data.env).toEqual({ GREETING: 'hi' });
      expect(calls('web.vhost.write')).toHaveLength(0);
    } finally { setPlan('app_memory_mb', null); }
  });

  it('lists both apps with their live service state and reads one', async () => {
    const res = await get().expect(200);
    expect(res.body.data.map((a) => [a.name, a.status, a.port])).toEqual([['probe-app', 'running', 31000], ['py-app', 'running', 31002]]);
    const one = await get('/1').expect(200);
    expect(one.body.data).toMatchObject({ name: 'probe-app', service: { state: 'active', memoryBytes: 12_345_678 } });
    expect((await get('/999')).status).toBe(404);
    expect((await get('/abc')).status).toBe(422);
  });

  it('refuses to remove a domain while an application is mounted on it', async () => {
    const res = await alice.delete('/api/panel/domains/sub/shop.alice.com').set('X-CSRF-Token', aliceCsrf);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('in_use');
    expect(calls('web.vhost.remove')).toHaveLength(0);
    expect(db().prepare("SELECT COUNT(*) AS n FROM account_domains WHERE domain = 'shop.alice.com'").get().n).toBe(1);
    expect(state().units.has('keel-app-alice.py-app')).toBe(true);
  });

  it('stops, starts and restarts through systemd and reads the logs', async () => {
    const stop = await post('/1/stop', {});
    expect(stop.status).toBe(200);
    expect(stop.body.data.status).toBe('stopped');
    expect(calls('apps.unit.control')[0].args).toEqual({ username: 'alice', name: 'probe-app', action: 'stop' });
    expect((await get('/1')).body.data.status).toBe('stopped');
    expect((await post('/1/start', {})).body.data.status).toBe('running');
    expect((await post('/1/restart', {})).body.data.status).toBe('running');
    expect((await post('/1/reload', {})).status).toBe(404);
    const logs = await get('/1/logs?lines=50').expect(200);
    expect(logs.body.data).toEqual({ id: 1, name: 'probe-app', unit: 'keel-app-alice.probe-app', lines: ['listening on 31000 (50)', 'GET / 200'] });
    expect((await get('/1/logs?lines=5000')).status).toBe(422);
    expect(audits('panel.apps.stop')[0].target).toBe('alice');
  });

  it('moves an app to another path and re-renders both vhosts', async () => {
    expect((await put('/1', {})).status).toBe(422);
    expect((await put('/1', { mount: '/' })).status).toBe(200);
    const writes = calls('web.vhost.write');
    expect(writes.map((w) => [w.args.domain, w.args.proxies])).toEqual([['alice.com', [{ path: '/', port: 31000, websocket: true }]]]);
    expect((await put('/2', { mount: '/', domain: 'alice.com' })).status).toBe(409);
    app.agent.calls.length = 0;
    const moved = await put('/2', { domain: 'alice.com', mount: '/py' });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ domain: 'alice.com', mount: '/py', url: 'http://alice.com/py/' });
    const w2 = calls('web.vhost.write');
    expect(w2.map((w) => w.args.domain)).toEqual(['shop.alice.com', 'alice.com']);
    expect(w2[0].args.proxies).toBeUndefined();
    expect(w2[1].args.proxies).toEqual([{ path: '/', port: 31000, websocket: true }, { path: '/py', port: 31002, websocket: false }]);
    expect((await put('/1', { dir: '../x' })).status).toBe(422);
    expect((await put('/1', { domain: 'bob.com' })).status).toBe(404);
  });

  it('installs dependencies as a job the account can follow', async () => {
    const res = await post('/2/deps', {});
    expect(res.status).toBe(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ id: 2, type: 'python', steps: [{ step: 'python -m venv', code: 0 }, { step: 'pip install', code: 0 }] });
    expect(calls('apps.deps.install')[0].args).toEqual({ username: 'alice', dir: 'apps/py', type: 'python', runtime: '3.12' });
    const view = await get(`/jobs/${job.id}`).expect(200);
    expect(view.body.data.params).not.toHaveProperty('accountId');
    expect(view.body.data.params).toMatchObject({ name: 'py-app' });
    expect((await bob.get(`/api/panel/apps/jobs/${job.id}`)).status).toBe(404);
    state().depsFail = true;
    const bad = await post('/1/deps', {});
    const failed = await waitForJob(app.ctx, bad.body.data.job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/E404/);
  });

  it('keeps accounts apart and honours the feature flag and the session rule', async () => {
    expect((await bob.get('/api/panel/apps/1')).status).toBe(404);
    expect((await bob.post('/api/panel/apps/1/stop').set('X-CSRF-Token', bobCsrf).send({})).status).toBe(404);
    expect((await bob.delete('/api/panel/apps/1?confirm=true').set('X-CSRF-Token', bobCsrf)).status).toBe(404);
    expect((await bob.get('/api/panel/apps')).body.data).toEqual([]);
    setFeature('alice', 'applicationmanager', false);
    try {
      const gated = await get();
      expect(gated.status).toBe(403);
      expect(gated.body.error.code).toBe('feature_disabled');
      expect((await post('', { ...probe, name: 'gated' })).status).toBe(403);
    } finally { setFeature('alice', 'applicationmanager', true); }
    expect(db().prepare('SELECT COUNT(*) AS n FROM panel_apps').get().n).toBe(2);
  });

  it('answers 501 for a new app when Apache is gone, and the plan limit with 409', async () => {
    setPlan('max_apps', 2);
    try {
      const limited = await post('', { ...probe, name: 'third' });
      expect(limited.status).toBe(409);
      expect(limited.body.error.code).toBe('limit_reached');
    } finally { setPlan('max_apps', null); }
    state().apache = false;
    await app.ctx.capabilities.refresh();
    try {
      const res = await post('', { ...probe, name: 'third' });
      expect(res.status).toBe(501);
      expect(db().prepare('SELECT COUNT(*) AS n FROM panel_apps').get().n).toBe(2);
      expect((await get()).body.meta.apache).toBe(false);
    } finally { state().apache = true; await app.ctx.capabilities.refresh(); }
  });

  it('removes the unit and the proxy, leaves the files and the other app alone', async () => {
    expect((await del('/1')).status).toBe(422);
    const res = await del('/1?confirm=true');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 1, name: 'probe-app', removed: true, unitRemoved: true, applied: true, filesKept: 'apps/probe-app' });
    expect(calls('apps.unit.remove')[0].args).toEqual({ username: 'alice', name: 'probe-app' });
    expect(calls('web.vhost.write').pop().args).toMatchObject({ domain: 'alice.com', proxies: [{ path: '/py', port: 31002, websocket: false }] });
    expect(db().prepare('SELECT name FROM panel_apps').all().map((r) => r.name)).toEqual(['py-app']);
    expect(state().units.has('keel-app-alice.probe-app')).toBe(false);
    expect(state().units.has('keel-app-alice.py-app')).toBe(true);
    expect((await get('/1')).status).toBe(404);
    expect(audits('panel.apps.remove')[0].target).toBe('alice');
    // The freed port is handed out again.
    const again = await post('', probe);
    expect(again.status).toBe(201);
    expect(again.body.data.port).toBe(31000);
  });

  it('takes the unit down again when the row loses a race on the port', async () => {
    // Another create lands between the unit write and the insert and takes the same port.
    state().onWrite = (a) => db().prepare("INSERT INTO panel_apps (account_id, name, type, dir, entry, runtime, port, domain, mount) VALUES ((SELECT id FROM accounts WHERE username = 'alice'), 'racer', 'node', 'apps/x', 'server.js', 'system', ?, 'alice.com', '/racer')").run(a.port);
    const res = await post('', { ...probe, name: 'third', mount: '/third' });
    expect(res.status).toBe(409);
    expect(calls('apps.unit.remove').map((c) => c.args)).toEqual([{ username: 'alice', name: 'third' }]);
    expect(state().units.has('keel-app-alice.third')).toBe(false);
    expect(db().prepare("SELECT COUNT(*) AS n FROM panel_apps WHERE name = 'third'").get().n).toBe(0);
    expect(calls('web.vhost.write')).toHaveLength(0);
    db().prepare("DELETE FROM panel_apps WHERE name = 'racer'").run();
  });

  it('terminating an account stops, disables and unlinks its units before the vhosts go', async () => {
    const created = await bob.post('/api/panel/apps').set('X-CSRF-Token', bobCsrf).send({ name: 'bob-app', type: 'node', dir: 'apps/bob-app', entry: 'server.js', runtime: 'system', domain: 'bob.com', mount: '/' });
    expect(created.status).toBe(201);
    expect(state().units.has('keel-app-bob.bob-app')).toBe(true);
    app.agent.calls.length = 0;
    const res = await app.http.delete('/api/accounts/bob').set('X-CSRF-Token', rootCsrf);
    expect(res.status).toBe(200);
    expect(calls('apps.unit.remove').map((c) => c.args)).toEqual([{ username: 'bob', name: 'bob-app' }]);
    expect(state().units.has('keel-app-bob.bob-app')).toBe(false);
    expect(db().prepare("SELECT COUNT(*) AS n FROM panel_apps WHERE domain = 'bob.com'").get().n).toBe(0);
    const audit = db().prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.terminate' ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(audit.args_redacted).cleanup.apps).toEqual({ removed: [{ name: 'bob-app', port: 31003, domain: 'bob.com', unitRemoved: true }] });
    // Alice's apps are untouched.
    expect(state().units.has('keel-app-alice.py-app')).toBe(true);
    expect(db().prepare("SELECT name FROM panel_apps ORDER BY id").all().map((r) => r.name)).toEqual(['py-app', 'probe-app']);
  });
});
