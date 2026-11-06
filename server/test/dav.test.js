import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { DAV_LOGIN_RE, DAV_PACKAGES } from '../src/services/dav.js';

const BINS = { apache2ctl: true, systemctl: true, radicale: true };
const unit = (name, active = true) => ({ unit: name, present: true, active, state: active ? 'active' : 'inactive', subState: active ? 'running' : 'dead', enabled: true, pid: 100, restarts: 0 });
const APACHE = { flavor: 'debian', root: '/etc/apache2', bin: 'apache2ctl', sitesAvailable: '/etc/apache2/sites-available', units: ['apache2'], installed: true, version: 'Apache/2.4.58', mpm: 'event', modules: [{ name: 'proxy', type: 'shared' }], unit: unit('apache2') };
const HOST_STATUS = () => ({ installed: true, flavor: 'debian', path: '/etc/apache2/sites-available/keel-host.conf', link: '/etc/apache2/sites-enabled/keel-host.conf', exists: true, managed: true, enabled: true, hostname: 'panel.example.com', meta: { hostname: 'panel.example.com', ssl: true }, ssl: true, certificate: { present: true }, docroot: '/var/www/keel-host', docrootExists: true, phpSocket: null, appsDir: '/etc/apache2/keel-host.d', apps: [] });

const state = { installed: false, published: false, users: new Map(), modulesLoaded: ['proxy'], unitActive: true };
const davStatus = () => ({
  installed: state.installed, version: state.installed ? '3.6.0' : null, bcrypt: state.installed ? true : null, listen: { host: '127.0.0.1', port: 5232 }, packages: DAV_PACKAGES,
  config: { path: '/etc/radicale/config', exists: state.installed, managed: state.installed, inSync: state.installed, meta: null },
  users: { path: '/etc/radicale/users', exists: state.users.size > 0, count: state.users.size },
  storage: { path: '/var/lib/radicale/collections', exists: state.installed },
  unit: state.installed ? { name: 'radicale', present: true, active: state.unitActive, enabled: true, pid: 4242 } : { name: 'radicale', present: false, active: null, enabled: null },
});

function davAgent() {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n]) && (n !== 'radicale' || state.installed)])),
    'web.detect': () => ({ apache: APACHE, nginx: { installed: false }, php: { installed: false, versions: [] }, ftp: { daemons: [] }, dovecot: { installed: false }, exim: { installed: false }, systemd: true, logrotate: false }),
    'web.host.status': HOST_STATUS,
    'web.host.ensure': ({ hostname, reload = true }) => ({ hostname, path: '/etc/apache2/sites-available/keel-host.conf', appsDir: '/etc/apache2/keel-host.d', ssl: true, changed: false, validated: true, reloaded: reload, warnings: [] }),
    'web.host.app.write': ({ name, alias, proxy, reload = true }) => { state.published = true; return { name, alias, root: null, path: `/etc/apache2/keel-host.d/${name}.conf`, phpSocket: null, vhostPresent: true, changed: true, validated: true, reloaded: reload, unit: 'apache2', warnings: [], proxy }; },
    'web.host.app.remove': ({ name }) => { state.published = false; return { name, path: `/etc/apache2/keel-host.d/${name}.conf`, removed: true, validated: true, reloaded: true, unit: 'apache2' }; },
    'web.host.app.list': () => ({ installed: true, appsDir: '/etc/apache2/keel-host.d', vhostPresent: true, apps: state.published ? [{ name: 'dav', path: '/etc/apache2/keel-host.d/dav.conf', managed: true, alias: '/dav', root: null, php: false, meta: { proxy: { port: 5232, scriptName: '/dav', target: 'http://127.0.0.1:5232/' } }, mtime: '2026-11-06T00:00:00.000Z' }] : [] }),
    'web.host.app.probe': ({ alias }) => ({ alias, url: `https://panel.example.com${alias}/`, status: 200, ok: true, error: null, phpFatal: null }),
    'web.modules.status': ({ modules }) => ({ flavor: 'debian', a2tools: true, modules: Object.fromEntries(modules.map((m) => [m, state.modulesLoaded.includes(m)])), missing: modules.filter((m) => !state.modulesLoaded.includes(m)) }),
    'web.modules.enable': ({ modules }) => { state.modulesLoaded.push(...modules); return { enabled: modules, alreadyLoaded: [], validated: true, reloaded: false, unit: null }; },
    'pkg.detect': () => ({ manager: 'apt', family: 'debian', binary: 'apt-get', rpm: false, rebootRequired: false }),
    'pkg.install': ({ packages }) => { state.installed = true; return { manager: 'apt', packages, output: [`Setting up ${packages.join(' ')}`] }; },
    'dav.status': davStatus,
    'dav.install': () => {
      if (!state.installed) { const err = new Error('Radicale is not installed'); err.code = 'capability_missing'; throw err; }
      return { config: { path: '/etc/radicale/config', changed: true }, users: { path: '/etc/radicale/users' }, storage: { path: '/var/lib/radicale/collections', created: false }, unit: { name: 'radicale', present: true, active: true, enabled: true, restarted: true }, listen: { host: '127.0.0.1', port: 5232 } };
    },
    'dav.user.set': ({ login, hash }) => { const existed = state.users.has(login); state.users.set(login, hash); return { login, path: '/etc/radicale/users', created: !existed, replaced: existed }; },
    'dav.user.remove': ({ login }) => ({ login, path: '/etc/radicale/users', removed: state.users.delete(login) }),
    'dav.collections': ({ login }) => (state.users.has(login) ? { login, path: `/var/lib/radicale/collections/collection-root/${login}`, exists: true, collections: [{ name: 'work', kind: 'calendar', tag: 'VCALENDAR', displayName: 'Work', description: null, color: '#ff0000', items: 3, updatedAt: '2026-11-06T10:00:00.000Z' }] } : { login, path: `/var/lib/radicale/collections/collection-root/${login}`, exists: false, collections: [] }),
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
    del: (p) => http.delete(`/api/panel${p}`).set('X-CSRF-Token', csrf),
  };
}

describe('Calendars and Contacts (P4-3)', () => {
  let app;
  let csrf;
  let bob;
  let carol;
  const audits = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
  const post = (url, body = {}) => app.http.post(url).set('X-CSRF-Token', csrf).send(body);

  beforeAll(async () => {
    app = await createTestApp({ agent: davAgent() });
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

  it('exports a login pattern that cannot smuggle htpasswd lines', () => {
    expect(DAV_LOGIN_RE.test('bob@bob.com')).toBe(true);
    for (const bad of ['bob', 'bob:x@bob.com', 'bob@bob.com\nroot:x', 'Bob@bob.com', 'bob@localhost']) expect(DAV_LOGIN_RE.test(bad), bad).toBe(false);
  });

  describe('admin card (GET/POST/DELETE /api/service-config/dav)', () => {
    it('reports not installed with the packages the Install button needs, and refuses to publish', async () => {
      const res = await app.http.get('/api/service-config/dav').expect(200);
      expect(res.body.data).toMatchObject({ installed: false, packages: ['radicale', 'python3-bcrypt'], apache: true, fqdn: true, hostname: 'panel.example.com', published: null, url: null, serverUrl: 'https://panel.example.com/dav/', listen: { host: '127.0.0.1', port: 5232 } });
      expect(res.body.data.http).toBeNull();
      const pub = await post('/api/service-config/dav/publish').expect(501);
      expect(pub.body.error.code).toBe('capability_missing');
    });

    it('is root only', async () => {
      const reseller = await app.createUser('rs-dav', 'reseller');
      const http = request.agent(app.ctx.app);
      const login = await http.post('/api/auth/login').send({ username: reseller.username, password: reseller.password });
      expect(login.status).toBe(200);
      await http.get('/api/service-config/dav').expect(403);
      await http.post('/api/service-config/dav/install').set('X-CSRF-Token', login.body.data.csrfToken).send({}).expect(403);
    });

    it('the account panel answers 501 while Radicale is missing but still lists the login', async () => {
      const res = await bob.get('/email/calendars').expect(200);
      expect(res.body.data.available).toMatchObject({ installed: false, published: false, url: null });
      expect(res.body.data.logins).toEqual([expect.objectContaining({ login: 'bob@bob.com', kind: 'account', subuserId: null, hasPassword: false })]);
      const set = await bob.put('/email/calendars/bob@bob.com/password', { password: 'Calendar-Passw0rd!' }).expect(501);
      expect(set.body.error.code).toBe('capability_missing');
      expect(app.agent.callsTo('dav.user.set')).toHaveLength(0);
    });

    it('Install runs the job: packages → configuration → publication, audited', async () => {
      const res = await post('/api/service-config/dav/install').expect(202);
      expect(res.body.data).toMatchObject({ pending: true, packages: ['radicale', 'python3-bcrypt'] });
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status, JSON.stringify(job.logs)).toBe('done');
      expect(job.result).toMatchObject({ installed: true, config: { changed: true }, unit: { active: true }, published: { url: 'https://panel.example.com/dav/', changed: true } });
      expect(app.agent.callsTo('pkg.install').pop().args).toEqual({ packages: ['radicale', 'python3-bcrypt'], noRecommends: true });
      const write = app.agent.callsTo('web.host.app.write').pop().args;
      expect(write).toEqual({ name: 'dav', alias: '/dav', php: false, proxy: { port: 5232, scriptName: '/dav' }, options: ['None'], reload: true });
      expect(write.root).toBeUndefined();
      // The missing proxy modules were enabled before the drop-in was written (reload deferred to the publish).
      expect(app.agent.callsTo('web.modules.enable').pop().args).toEqual({ modules: ['proxy_http', 'headers'], reload: false });
      expect(audits('dav.install')).toHaveLength(1);
      expect(audits('dav.publish').pop()).toMatchObject({ target: 'https://panel.example.com/dav/' });
      const status = await app.http.get('/api/service-config/dav').expect(200);
      expect(status.body.data).toMatchObject({ installed: true, version: '3.6.0', bcrypt: true, published: { alias: '/dav', managed: true, url: 'https://panel.example.com/dav/', proxy: { port: 5232 } }, url: 'https://panel.example.com/dav/', http: { status: 200, ok: true }, warning: null, modules: { missing: [] }, lastApply: { ok: true } });
      expect(status.body.data.unit).toMatchObject({ name: 'radicale', active: true });
    });

    it('Publish again and Unpublish', async () => {
      const pub = await post('/api/service-config/dav/publish', { reload: true }).expect(200);
      expect(pub.body.data).toMatchObject({ alias: '/dav', url: 'https://panel.example.com/dav/', http: { ok: true }, warning: null });
      await post('/api/service-config/dav/publish', { reload: 'yes' }).expect(422);
      const gone = await app.http.delete('/api/service-config/dav').set('X-CSRF-Token', csrf).expect(200);
      expect(gone.body.data).toMatchObject({ name: 'dav', removed: true });
      expect(audits('dav.unpublish')).toHaveLength(1);
      expect((await app.http.get('/api/service-config/dav').expect(200)).body.data.published).toBeNull();
      await post('/api/service-config/dav/publish').expect(200);
    });
  });

  describe('account panel (/api/panel/email/calendars)', () => {
    it('lists the server address and the account login with client URLs', async () => {
      const res = await bob.get('/email/calendars').expect(200);
      expect(res.body.data).toMatchObject({ available: { installed: true, active: true, published: true, url: 'https://panel.example.com/dav/' }, serverUrl: 'https://panel.example.com/dav/', hostname: 'panel.example.com', passwordMinLength: 8 });
      expect(res.body.data.logins).toEqual([{ login: 'bob@bob.com', kind: 'account', subuserId: null, hasPassword: false, passwordSetAt: null, urls: { principal: 'https://panel.example.com/dav/bob%40bob.com/', caldav: 'https://panel.example.com/dav/bob%40bob.com/', carddav: 'https://panel.example.com/dav/bob%40bob.com/', discovery: 'https://panel.example.com/dav/' } }]);
    });

    it('sets a DAV password: bcrypt hashed by the panel, only the hash reaches the agent, row + audit', async () => {
      const res = await bob.put('/email/calendars/bob@bob.com/password', { password: 'Calendar-Passw0rd!' }).expect(200);
      expect(res.body.data).toMatchObject({ login: 'bob@bob.com', kind: 'account', hasPassword: true, created: true });
      const call = app.agent.callsTo('dav.user.set').pop().args;
      expect(call.login).toBe('bob@bob.com');
      expect(call.hash).toMatch(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
      expect(call.hash).not.toContain('Calendar-Passw0rd');
      expect(await app.ctx.crypto.verifyPassword('Calendar-Passw0rd!', call.hash)).toBe(true);
      expect(JSON.stringify(app.agent.callsTo('dav.user.set'))).not.toContain('Calendar-Passw0rd');
      const row = app.ctx.db.prepare('SELECT * FROM panel_dav_logins WHERE login = ?').get('bob@bob.com');
      expect(row).toMatchObject({ login: 'bob@bob.com', subuser_id: null });
      const audit = audits('panel.dav.password.set').pop();
      expect(audit).toMatchObject({ target: 'bob' });
      expect(JSON.stringify(audit)).not.toContain('Calendar-Passw0rd');
      expect(JSON.stringify(audit)).not.toContain('$2');
      const listed = await bob.get('/email/calendars').expect(200);
      expect(listed.body.data.logins[0]).toMatchObject({ hasPassword: true });
      expect(listed.body.data.logins[0].passwordSetAt).toBeTruthy();
      // Setting again replaces the line.
      const again = await bob.put('/email/calendars/bob@bob.com/password', { password: 'Other-Passw0rd!!' }).expect(200);
      expect(again.body.data).toMatchObject({ created: false });
      expect(app.agent.callsTo('dav.user.set').pop().args.hash).not.toBe(call.hash);
    });

    it('validates the password and the login shape', async () => {
      await bob.put('/email/calendars/bob@bob.com/password', { password: 'short' }).expect(422);
      await bob.put('/email/calendars/bob@bob.com/password', { password: 'Calendar-Passw0rd!', extra: 1 }).expect(422);
      await bob.put('/email/calendars/bob/password', { password: 'Calendar-Passw0rd!' }).expect(422);
      await bob.put(`/email/calendars/${encodeURIComponent('bob:x@bob.com')}/password`, { password: 'Calendar-Passw0rd!' }).expect(422);
    });

    it('a login of another account, or any address that is not a listed login, is 404 and never reaches the agent', async () => {
      const before = app.agent.callsTo('dav.user.set').length;
      await carol.put('/email/calendars/bob@bob.com/password', { password: 'Calendar-Passw0rd!' }).expect(404);
      await bob.put('/email/calendars/alice@bob.com/password', { password: 'Calendar-Passw0rd!' }).expect(404);
      await carol.del('/email/calendars/bob@bob.com/password').expect(404);
      await carol.get('/email/calendars/bob@bob.com/collections').expect(404);
      expect(app.agent.callsTo('dav.user.set')).toHaveLength(before);
      expect(app.ctx.db.prepare('SELECT account_id FROM panel_dav_logins WHERE login = ?').get('bob@bob.com').account_id).toBe(app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get('bob').id);
    });

    it('lists the collections of a login read-only', async () => {
      const res = await bob.get('/email/calendars/bob@bob.com/collections').expect(200);
      expect(res.body.data).toMatchObject({ login: 'bob@bob.com', exists: true, collections: [{ name: 'work', kind: 'calendar', displayName: 'Work', items: 3 }] });
      const none = await carol.get('/email/calendars/carol@carol.org/collections').expect(200);
      expect(none.body.data).toMatchObject({ login: 'carol@carol.org', exists: false, collections: [] });
    });

    it('removes the password (row and htpasswd line), audited; the collections stay', async () => {
      const res = await bob.del('/email/calendars/bob@bob.com/password').expect(200);
      expect(res.body.data).toMatchObject({ login: 'bob@bob.com', hasPassword: false, removed: true });
      expect(app.agent.callsTo('dav.user.remove').pop().args).toEqual({ login: 'bob@bob.com' });
      expect(app.ctx.db.prepare('SELECT * FROM panel_dav_logins WHERE login = ?').get('bob@bob.com')).toBeUndefined();
      expect(audits('panel.dav.password.remove')).toHaveLength(1);
      expect((await bob.get('/email/calendars').expect(200)).body.data.logins[0].hasPassword).toBe(false);
      expect(state.users.has('bob@bob.com')).toBe(false);
    });

    it('sub-users with the dav service on become logins; the table may be absent', async () => {
      const accountId = app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get('bob').id;
      const had = ctxHasSubusers(app.ctx);
      if (!had) app.ctx.db.exec("CREATE TABLE IF NOT EXISTS panel_subusers (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, username TEXT NOT NULL, domain TEXT NOT NULL, full_name TEXT NOT NULL DEFAULT '', contact_email TEXT, services_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (username, domain))");
      app.ctx.db.prepare('INSERT INTO panel_subusers (account_id, username, domain, services_json) VALUES (?, ?, ?, ?)').run(accountId, 'sam', 'bob.com', JSON.stringify({ email: { enabled: false }, ftp: { enabled: false }, dav: { enabled: true } }));
      app.ctx.db.prepare('INSERT INTO panel_subusers (account_id, username, domain, services_json) VALUES (?, ?, ?, ?)').run(accountId, 'off', 'bob.com', JSON.stringify({ dav: { enabled: false } }));
      const res = await bob.get('/email/calendars').expect(200);
      expect(res.body.data.logins.map((l) => [l.login, l.kind])).toEqual([['bob@bob.com', 'account'], ['sam@bob.com', 'subuser']]);
      const set = await bob.put('/email/calendars/sam@bob.com/password', { password: 'Sub-Passw0rd!!!' }).expect(200);
      expect(set.body.data).toMatchObject({ login: 'sam@bob.com', kind: 'subuser', hasPassword: true });
      expect(app.ctx.db.prepare('SELECT subuser_id FROM panel_dav_logins WHERE login = ?').get('sam@bob.com').subuser_id).toBeTruthy();
      await carol.put('/email/calendars/sam@bob.com/password', { password: 'Sub-Passw0rd!!!' }).expect(404);
      await bob.del('/email/calendars/sam@bob.com/password').expect(200);
      app.ctx.db.prepare('DELETE FROM panel_subusers WHERE account_id = ?').run(accountId);
    });

    it('API tokens may read but never set a DAV password; the feature flag gates the page', async () => {
      const tok = await bob.post('/security/tokens', { name: 'dav-test', scopes: ['panel:read', 'panel:email'] });
      if (tok.status === 201 && tok.body.data?.token) {
        const token = tok.body.data.token;
        await request(app.ctx.app).get('/api/panel/email/calendars').set('Authorization', `Bearer ${token}`).expect(200);
        const denied = await request(app.ctx.app).put('/api/panel/email/calendars/bob@bob.com/password').set('Authorization', `Bearer ${token}`).send({ password: 'Calendar-Passw0rd!' }).expect(403);
        expect(denied.body.error.code).toBe('session_required');
      }
      const accountId = app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get('bob').id;
      const snap = app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE id = ?').get(accountId).plan_snapshot_json;
      const plan = JSON.parse(snap || '{}');
      app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE id = ?').run(JSON.stringify({ ...plan, features: { ...(plan.features || {}), caldav: false } }), accountId);
      const off = await bob.get('/email/calendars').expect(403);
      expect(off.body.error.code).toBe('feature_disabled');
      app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE id = ?').run(snap, accountId);
      await bob.get('/email/calendars').expect(200);
    });

    it('a stopped daemon is reported, not hidden', async () => {
      state.unitActive = false;
      const res = await bob.get('/email/calendars').expect(200);
      expect(res.body.data.available).toMatchObject({ installed: true, active: false, published: true });
      state.unitActive = true;
    });

    it('terminating the account removes every DAV login of the account from the htpasswd file before the rows cascade', async () => {
      await carol.put('/email/calendars/carol@carol.org/password', { password: 'Carol-Passw0rd!!' }).expect(200);
      expect(state.users.has('carol@carol.org')).toBe(true);
      const accountId = app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get('carol').id;
      app.agent.calls.length = 0;
      await app.http.delete('/api/accounts/carol').set('X-CSRF-Token', csrf).expect(200);
      expect(app.agent.callsTo('dav.user.remove').map((c) => c.args)).toEqual([{ login: 'carol@carol.org' }]);
      expect(state.users.has('carol@carol.org')).toBe(false);
      expect(app.ctx.db.prepare('SELECT * FROM panel_dav_logins WHERE account_id = ?').all(accountId)).toEqual([]);
      const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.terminate' ORDER BY id DESC LIMIT 1").get();
      expect(JSON.parse(audit.args_redacted).cleanup.dav).toEqual({ logins: [{ login: 'carol@carol.org', removed: true }] });
    });
  });
});

function ctxHasSubusers(ctx) {
  return Boolean(ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'panel_subusers'").get());
}
