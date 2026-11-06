import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { appNameFor, aliasFor, WEBDISK_PACKAGES, PROXY_MODULES, JOB_INSTALL } from '../src/services/panel-webdisk.js';

// An Apache host with the Web Disk ops in memory: htpasswd files, units,
// drop-ins, modules and the rclone package are recorded so the account routes
// are checked end to end through the real /api/panel session flow.
const APACHE = { flavor: 'debian', root: '/etc/apache2', bin: 'apache2ctl', sitesAvailable: '/etc/apache2/sites-available', units: ['apache2'], installed: true, version: 'Apache/2.4.58', mpm: 'event', modules: [{ name: 'proxy', type: 'shared' }], unit: { unit: 'apache2', present: true, active: true, state: 'active', subState: 'running', enabled: true, pid: 100, restarts: 0 } };
const HOST_STATUS = () => ({ installed: true, flavor: 'debian', path: '/etc/apache2/sites-available/keel-host.conf', link: '/etc/apache2/sites-enabled/keel-host.conf', exists: true, managed: true, enabled: true, hostname: 'panel.example.com', meta: { hostname: 'panel.example.com', ssl: true }, ssl: true, certificate: { present: true }, docroot: '/var/www/keel-host', docrootExists: true, phpSocket: null, appsDir: '/etc/apache2/keel-host.d', apps: [] });

const state = { rclone: false, htpasswd: new Map(), units: new Map(), apps: new Map(), modules: new Set(['proxy']), busyPorts: new Set(), startFails: false };
const fail = (code, message) => Object.assign(new Error(message), { agentError: true, code, details: {} });
const show = (username) => {
  const unit = `keel-webdisk-${username}`;
  const u = state.units.get(unit);
  if (!u) return { unit, installed: false, active: false, state: 'absent', subState: null, enabled: false, pid: null, startedAt: null, memoryBytes: null, restarts: 0, result: null };
  return { unit, installed: true, active: u.active, state: u.active ? 'active' : 'failed', subState: u.active ? 'running' : 'failed', enabled: true, pid: u.active ? 4242 : null, startedAt: u.active ? '2026-11-06T10:00:00Z' : null, memoryBytes: null, restarts: 0, result: u.active ? 'success' : 'exit-code' };
};

function hostAgent() {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['setpriv', 'runuser', 'systemctl', 'useradd', 'usermod', 'userdel', 'apache2ctl', 'ss'].includes(n) || (n === 'rclone' && state.rclone)])),
    'svc.list_units': () => ['apache2'],
    'web.detect': () => ({ apache: APACHE, nginx: { installed: false }, php: { installed: false, versions: [] }, ftp: { daemons: [] }, dovecot: { installed: false }, exim: { installed: false }, systemd: true, logrotate: false }),
    'web.host.status': HOST_STATUS,
    'web.host.ensure': ({ hostname, reload = true }) => ({ hostname, path: '/etc/apache2/sites-available/keel-host.conf', appsDir: '/etc/apache2/keel-host.d', ssl: true, changed: false, validated: true, reloaded: reload, warnings: [] }),
    'web.host.app.write': (a) => { state.apps.set(a.name, a); return { name: a.name, alias: a.alias, root: null, path: `/etc/apache2/keel-host.d/${a.name}.conf`, phpSocket: null, vhostPresent: true, changed: true, validated: true, reloaded: a.reload !== false, unit: 'apache2', warnings: [] }; },
    'web.host.app.remove': ({ name }) => ({ name, path: `/etc/apache2/keel-host.d/${name}.conf`, removed: state.apps.delete(name), validated: true, reloaded: true, unit: 'apache2' }),
    'web.host.app.list': () => ({ installed: true, appsDir: '/etc/apache2/keel-host.d', vhostPresent: true, apps: [...state.apps.values()].map((a) => ({ name: a.name, path: `/etc/apache2/keel-host.d/${a.name}.conf`, managed: true, alias: a.alias, root: null, php: false, meta: { proxy: a.proxy }, mtime: '2026-11-06T00:00:00.000Z' })) }),
    'web.modules.status': ({ modules }) => ({ flavor: 'debian', a2tools: true, modules: Object.fromEntries(modules.map((m) => [m, state.modules.has(m)])), missing: modules.filter((m) => !state.modules.has(m)) }),
    'web.modules.enable': ({ modules }) => { for (const m of modules) state.modules.add(m); return { enabled: modules, alreadyLoaded: [], validated: true, reloaded: false, unit: null }; },
    'pkg.detect': () => ({ manager: 'apt', family: 'debian', binary: 'apt-get', rpm: false, rebootRequired: false }),
    'pkg.install': ({ packages }) => { if (packages.includes('rclone')) state.rclone = true; return { manager: 'apt', packages, output: [`Setting up ${packages.join(' ')}`] }; },
    'apps.port.free': ({ port }) => ({ port, free: !state.busyPorts.has(port), checked: true }),
    'webdisk.htpasswd.set': ({ username, login, hash }) => { const existed = state.htpasswd.has(username); state.htpasswd.set(username, `${login}:${hash}`); return { login, path: `/home/${username}/.keel/webdisk.htpasswd`, created: !existed, replaced: existed }; },
    'webdisk.htpasswd.remove': ({ username }) => ({ path: `/home/${username}/.keel/webdisk.htpasswd`, removed: state.htpasswd.delete(username) }),
    'webdisk.unit.write': ({ username, port }) => {
      if (!state.rclone) throw fail('capability_missing', 'rclone is not installed on this server');
      if (!state.htpasswd.has(username)) throw fail('not_found', `${username} has no Web Disk password yet`);
      const unit = `keel-webdisk-${username}`;
      state.units.set(unit, { active: !state.startFails, port });
      return { unit, path: `/etc/whm/apps/${username}/${unit}.service`, bytes: 900, started: !state.startFails, startError: state.startFails ? 'exit-code' : null, status: show(username), port, baseUrl: `/webdisk/${username}`, rclone: '/usr/bin/rclone' };
    },
    'webdisk.unit.remove': ({ username }) => { const unit = `keel-webdisk-${username}`; return { unit, path: `/etc/whm/apps/${username}/${unit}.service`, removed: state.units.delete(unit) }; },
    'webdisk.unit.control': ({ username, action }) => { const u = state.units.get(`keel-webdisk-${username}`); if (!u) throw fail('not_found', 'not installed'); u.active = action !== 'stop'; return { unit: `keel-webdisk-${username}`, action, status: show(username) }; },
    'webdisk.unit.status': ({ username }) => ({ ...show(username), path: `/etc/whm/apps/${username}/keel-webdisk-${username}.service`, port: state.units.get(`keel-webdisk-${username}`)?.port ?? null, baseUrl: `/webdisk/${username}`, htpasswd: { path: `/home/${username}/.keel/webdisk.htpasswd`, exists: state.htpasswd.has(username) }, rclone: { installed: state.rclone } }),
  });
}

async function panelLogin(app, username, password = 'Panel-Passw0rd!1') {
  const hash = await app.ctx.crypto.hashPassword(password);
  app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  const http = request.agent(app.ctx.app);
  const res = await http.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`panel login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  return {
    get: (p) => http.get(`/api/panel${p}`),
    put: (p, body = {}) => http.put(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    post: (p, body = {}) => http.post(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
  };
}

describe('Web Disk (P5-1)', () => {
  let app;
  let csrf;
  let bob;
  let carol;
  const audits = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
  const row = (username) => app.ctx.db.prepare('SELECT w.* FROM panel_webdisk w JOIN accounts a ON a.id = w.account_id WHERE a.username = ?').get(username);

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    csrf = await app.login();
    app.ctx.settings.set('basic.hostname', 'panel.example.com');
    await app.ctx.capabilities.refresh();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.org', ip: '203.0.113.7', provision: { mail: false } }).expect(201);
    bob = await panelLogin(app, 'bob');
    carol = await panelLogin(app, 'carol');
    app.ctx.jobs.start();
  }, 60_000);
  afterAll(() => app?.close());

  it('names the drop-in from the username and falls back to a hashed form that fits the host app grammar', () => {
    expect(appNameFor('bob')).toBe('webdisk-bob');
    expect(aliasFor('bob')).toBe('/webdisk/bob');
    const long = appNameFor('a-very-long-account-name-indeed');
    expect(long).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expect(long).not.toBe(appNameFor('a-very-long-account-name-indeeX'));
    expect(appNameFor('a_b')).toMatch(/^webdisk-a-b-[0-9a-f]{8}$/);
    expect(appNameFor('a-b')).toBe('webdisk-a-b');
    expect(WEBDISK_PACKAGES).toEqual(['rclone']);
    expect(PROXY_MODULES).toEqual(['proxy', 'proxy_http', 'headers']);
  });

  it('reports a disabled Web Disk with the address it will get, and refuses to switch on without a password', async () => {
    const res = await bob.get('/webdisk').expect(200);
    expect(res.body.data).toMatchObject({ enabled: false, login: 'bob', hasPassword: false, status: 'disabled', serverUrl: 'https://panel.example.com/webdisk/bob/', hostname: 'panel.example.com', available: { rclone: false, apache: true, published: false }, passwordMinLength: 8, unit: null, pending: false });
    expect(row('bob')).toBeUndefined();
    const on = await bob.put('/webdisk', { enabled: true }).expect(409);
    expect(on.body.error.code).toBe('password_required');
    expect(app.agent.callsTo('webdisk.unit.write')).toHaveLength(0);
    await bob.put('/webdisk', { enabled: 'yes' }).expect(422);
    await bob.put('/webdisk', { enabled: true, extra: 1 }).expect(422);
  });

  it('sets the password: bcrypt hashed by the panel, only the hash reaches the agent as the account, row + audit', async () => {
    await bob.put('/webdisk/password', { password: 'short' }).expect(422);
    const res = await bob.put('/webdisk/password', { password: 'Disk-Passw0rd!!' }).expect(200);
    expect(res.body.data).toMatchObject({ login: 'bob', hasPassword: true, created: true, restarted: null, serverUrl: 'https://panel.example.com/webdisk/bob/' });
    const call = app.agent.callsTo('webdisk.htpasswd.set').pop().args;
    expect(call).toMatchObject({ username: 'bob', login: 'bob' });
    // $2a$ (bcryptjs) or $2y$ (the normalised $2b$ form): never $2b$, which not every htpasswd reader takes.
    expect(call.hash).toMatch(/^\$2[ay]\$12\$[./A-Za-z0-9]{53}$/);
    expect(await app.ctx.crypto.verifyPassword('Disk-Passw0rd!!', call.hash)).toBe(true);
    expect(JSON.stringify(app.agent.calls)).not.toContain('Disk-Passw0rd');
    expect(row('bob')).toMatchObject({ enabled: 0, port: 31000, login: 'bob', has_password: 1 });
    const audit = audits('panel.webdisk.password.set').pop();
    expect(audit).toMatchObject({ target: 'bob' });
    expect(JSON.stringify(audit)).not.toContain('Disk-Passw0rd');
    expect(JSON.stringify(audit)).not.toContain('$2');
    expect((await bob.get('/webdisk').expect(200)).body.data).toMatchObject({ hasPassword: true, port: 31000, enabled: false });
  });

  it('switching on without rclone runs the install job, then writes the unit and publishes the proxy drop-in', async () => {
    const res = await bob.put('/webdisk', { enabled: true }).expect(202);
    expect(res.body.data).toMatchObject({ pending: true, enabled: false });
    expect(res.body.data.job.id).toBeTruthy();
    // A second switch-on while the job runs is refused; once the job is through it simply enables.
    const again = await bob.put('/webdisk', { enabled: true });
    expect([200, 202, 409]).toContain(again.status);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status, JSON.stringify(job.logs)).toBe('done');
    expect(job.type).toBe(JOB_INSTALL);
    expect(job.result).toMatchObject({ enabled: true, port: 31000, url: 'https://panel.example.com/webdisk/bob/', started: true });
    expect(app.agent.callsTo('pkg.install').pop().args).toEqual({ packages: ['rclone'], noRecommends: true });
    expect(app.agent.callsTo('webdisk.unit.write').pop().args).toEqual({ username: 'bob', port: 31000 });
    const write = app.agent.callsTo('web.host.app.write').pop().args;
    expect(write).toEqual({ name: 'webdisk-bob', alias: '/webdisk/bob', php: false, proxy: { port: 31000, scriptName: '/webdisk/bob', path: '/webdisk/bob', preserveHost: true }, options: ['None'], reload: true });
    expect(app.agent.callsTo('web.modules.enable').pop().args).toEqual({ modules: ['proxy_http', 'headers'], reload: false });
    expect(row('bob')).toMatchObject({ enabled: 1, status: 'active', error: null });
    expect(audits('panel.webdisk.enable').pop()).toMatchObject({ target: 'bob' });
    const status = await bob.get('/webdisk').expect(200);
    expect(status.body.data).toMatchObject({ enabled: true, status: 'active', port: 31000, available: { rclone: true, apache: true, published: true }, unit: { unit: 'keel-webdisk-bob', active: true, pid: 4242 }, pending: false });
    const own = await bob.get(`/webdisk/jobs/${res.body.data.job.id}`).expect(200);
    expect(own.body.data).toMatchObject({ status: 'done' });
    expect(own.body.data.params.ownerId).toBeUndefined();
    await carol.get(`/webdisk/jobs/${res.body.data.job.id}`).expect(404);
  });

  it('a new password restarts the running daemon (rclone reads the file at start)', async () => {
    const res = await bob.put('/webdisk/password', { password: 'Other-Passw0rd!!' }).expect(200);
    expect(res.body.data).toMatchObject({ created: false, restarted: true });
    expect(app.agent.callsTo('webdisk.unit.control').pop().args).toEqual({ username: 'bob', action: 'restart' });
  });

  it('a second account gets the next free port and switches on synchronously once rclone is there', async () => {
    state.busyPorts.add(31001);
    await carol.put('/webdisk/password', { password: 'Carol-Passw0rd!!' }).expect(200);
    const res = await carol.put('/webdisk', { enabled: true }).expect(200);
    expect(res.body.data).toMatchObject({ enabled: true, port: 31002, applied: true, status: 'active', serverUrl: 'https://panel.example.com/webdisk/carol/' });
    expect(app.agent.callsTo('web.host.app.write').pop().args.name).toBe('webdisk-carol');
    expect(app.agent.callsTo('pkg.install')).toHaveLength(1);
    const admin = await app.http.get('/api/service-config/webdisk').expect(200);
    expect(admin.body.data.live).toBe(true);
    expect(admin.body.data.disks.map((d) => [d.username, d.enabled, d.port, d.url])).toEqual([['bob', true, 31000, 'https://panel.example.com/webdisk/bob/'], ['carol', true, 31002, 'https://panel.example.com/webdisk/carol/']]);
  });

  it('switching off unpublishes the drop-in and removes the unit; the port and the password stay', async () => {
    const res = await carol.put('/webdisk', { enabled: false }).expect(200);
    expect(res.body.data).toMatchObject({ enabled: false, status: 'disabled', hasPassword: true, port: 31002 });
    expect(app.agent.callsTo('web.host.app.remove').pop().args).toEqual({ name: 'webdisk-carol' });
    expect(app.agent.callsTo('webdisk.unit.remove').pop().args).toEqual({ username: 'carol' });
    expect(state.units.has('keel-webdisk-carol')).toBe(false);
    expect(state.apps.has('webdisk-carol')).toBe(false);
    expect(audits('panel.webdisk.disable').pop()).toMatchObject({ target: 'carol' });
    // Off again is a no-op that still answers the status.
    await carol.put('/webdisk', { enabled: false }).expect(200);
    const back = await carol.put('/webdisk', { enabled: true }).expect(200);
    expect(back.body.data).toMatchObject({ enabled: true, port: 31002 });
  });

  it('a daemon that does not start leaves the row failed and the drop-in in place', async () => {
    state.startFails = true;
    await carol.put('/webdisk', { enabled: false }).expect(200);
    const res = await carol.put('/webdisk', { enabled: true }).expect(200);
    expect(res.body.data).toMatchObject({ enabled: true, status: 'failed' });
    expect(row('carol')).toMatchObject({ enabled: 1, status: 'failed', error: 'exit-code' });
    state.startFails = false;
    await carol.put('/webdisk', { enabled: false }).expect(200);
  });

  it('client recipes carry the platform addresses', async () => {
    const res = await bob.get('/webdisk/clients').expect(200);
    expect(res.body.data).toMatchObject({ serverUrl: 'https://panel.example.com/webdisk/bob/', hostname: 'panel.example.com', login: 'bob', port: 443 });
    expect(res.body.data.clients.map((c) => c.id)).toEqual(['windows', 'macos', 'ios', 'android', 'linux']);
    expect(res.body.data.clients[0]).toEqual({ id: 'windows', url: 'https://panel.example.com/webdisk/bob/', unc: '\\\\panel.example.com@SSL\\webdisk\\bob' });
    expect(res.body.data.clients[4]).toMatchObject({ id: 'linux', gvfs: 'davs://panel.example.com/webdisk/bob/' });
  });

  it('a panel token may read but not switch or set a password', async () => {
    const created = await bob.post('/security/tokens', { name: 'ro', scopes: ['panel:files'] });
    if (created.status !== 201) return;
    const token = created.body.data.token;
    await request(app.ctx.app).get('/api/panel/webdisk').set('Authorization', `Bearer ${token}`).expect(200);
    const put = await request(app.ctx.app).put('/api/panel/webdisk').set('Authorization', `Bearer ${token}`).send({ enabled: false }).expect(403);
    expect(put.body.error.code).toBe('session_required');
    await request(app.ctx.app).put('/api/panel/webdisk/password').set('Authorization', `Bearer ${token}`).send({ password: 'Disk-Passw0rd!!' }).expect(403);
  });

  it('the Application Manager port picker skips Web Disk ports, even of a disabled disk', async () => {
    // bob holds 31000 (on), 31001 is busy on the host, carol holds 31002 (off).
    expect(row('carol')).toMatchObject({ enabled: 0, port: 31002 });
    expect(await app.ctx.panelApps.pickPort(null)).toBe(31003);
    expect(await app.ctx.panelWebdisk.pickPort(null)).toBe(31003);
  });

  it('switching on re-checks the kept port and moves to a free one when something listens there', async () => {
    state.busyPorts.add(31002);
    const res = await carol.put('/webdisk', { enabled: true }).expect(200);
    expect(res.body.data).toMatchObject({ enabled: true, status: 'active', port: 31003 });
    expect(app.agent.callsTo('webdisk.unit.write').pop().args).toEqual({ username: 'carol', port: 31003 });
    expect(app.agent.callsTo('web.host.app.write').pop().args.proxy.port).toBe(31003);
    expect(JSON.parse(audits('panel.webdisk.port.move').pop().args_redacted)).toMatchObject({ from: 31002, to: 31003 });
    state.busyPorts.delete(31002);
    await carol.put('/webdisk', { enabled: false }).expect(200);
    expect(row('carol')).toMatchObject({ enabled: 0, port: 31003 });
  });

  it('rewrite() renders the unit again after a home move and leaves a disabled disk alone', async () => {
    app.agent.calls.length = 0;
    const r = await app.ctx.panelWebdisk.rewrite('bob', null);
    expect(r).toMatchObject({ enabled: true, rewritten: true, started: true, unit: 'keel-webdisk-bob', port: 31000 });
    expect(app.agent.callsTo('webdisk.unit.write').map((c) => c.args)).toEqual([{ username: 'bob', port: 31000 }]);
    expect(app.agent.callsTo('web.host.app.write')).toHaveLength(0);
    expect(row('bob')).toMatchObject({ enabled: 1, status: 'active' });
    expect(audits('panel.webdisk.rewrite').pop()).toMatchObject({ target: 'bob' });
    expect(await app.ctx.panelWebdisk.rewrite('carol', null)).toEqual({ enabled: false, rewritten: false });
    expect(await app.ctx.panelWebdisk.rewrite('nobody', null)).toEqual({ enabled: false, rewritten: false });
    expect(app.agent.callsTo('webdisk.unit.write')).toHaveLength(1);
  });

  it('terminating the account removes the unit and the drop-in before the row cascades', async () => {
    expect(state.units.has('keel-webdisk-bob')).toBe(true);
    const accountId = app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get('bob').id;
    app.agent.calls.length = 0;
    await app.http.delete('/api/accounts/bob').set('X-CSRF-Token', csrf).expect(200);
    expect(app.agent.callsTo('webdisk.unit.remove').map((c) => c.args)).toEqual([{ username: 'bob' }]);
    expect(app.agent.callsTo('web.host.app.remove').map((c) => c.args)).toEqual([{ name: 'webdisk-bob' }]);
    expect(state.units.has('keel-webdisk-bob')).toBe(false);
    expect(app.ctx.db.prepare('SELECT * FROM panel_webdisk WHERE account_id = ?').all(accountId)).toEqual([]);
    const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.terminate' ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(audit.args_redacted).cleanup.webdisk).toEqual({ login: 'bob', port: 31000, enabled: true, unitRemoved: true, unpublished: true });
    // Carol's disabled row is untouched.
    expect(row('carol')).toMatchObject({ enabled: 0, port: 31003 });
  });
});
