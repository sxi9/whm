import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { errorHandler, notFoundHandler } from '../src/middleware/error.js';
import { HttpError } from '../src/lib/errors.js';
import { register } from '../src/routes/panel/databases.js';
import { ensurePrefixed, effectiveLimit, SYSTEM_ROOT } from '../src/services/panel-databases.js';

// A MariaDB-like host: databases, users (per host) and grants live in memory
// so the panel's bookkeeping and the delegate's are checked end to end.
function mysqlAgent() {
  const state = { databases: new Map([['mysql', { system: true }]]), users: new Map([['root@localhost', {}]]), grants: new Map(), dumps: [], imports: [] };
  const hostsOf = (user) => [...state.users.keys()].filter((k) => k.startsWith(`${user}@`)).map((k) => k.split('@')[1]);
  const fail = (code, message) => Object.assign(new Error(message), { agentError: true, code, details: {} });
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['mysql', 'mysqld', 'mysqlcheck', 'mysqldump', 'systemctl', 'useradd', 'usermod', 'userdel'].includes(n)])),
    'svc.list_units': () => ['mariadb'],
    'db.databases.list': () => [...state.databases].map(([name, d]) => ({ name, charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', sizeBytes: 4096, tables: 2, system: d.system })),
    'db.database.create': ({ name, charset, collation }) => { if (state.databases.has(name)) throw fail('exists', `database ${name} exists`); state.databases.set(name, { system: false }); return { name, charset, collation }; },
    'db.database.drop': ({ name }) => { state.databases.delete(name); return { name, dropped: true }; },
    'db.users.list': () => [...state.users.keys()].map((k) => { const [user, host] = k.split('@'); return { user, host, plugin: 'mysql_native_password', system: user === 'root' }; }),
    'db.user.create': ({ user, hosts }) => { for (const h of hosts) state.users.set(`${user}@${h}`, {}); return { user, hosts }; },
    'db.user.drop': ({ user, hosts }) => { for (const h of hosts || hostsOf(user)) { state.users.delete(`${user}@${h}`); state.grants.delete(`${user}@${h}`); } return { user, dropped: hosts || hostsOf(user), missing: [] }; },
    'db.user.set_password': ({ user }) => ({ user, hosts: hostsOf(user) }),
    'db.user.add_host': ({ user, toHost }) => { state.users.set(`${user}@${toHost}`, {}); return { user, host: toHost, created: true, grants: 0 }; },
    'db.grants.list': ({ user, host }) => ({ user, host, raw: [], grants: [...(state.grants.get(`${user}@${host}`) || new Map())].map(([database, privileges]) => ({ database, table: '*', privileges })) }),
    'db.grant': ({ user, database, privileges, hosts }) => { for (const h of hosts) { const g = state.grants.get(`${user}@${h}`) || new Map(); g.set(database, privileges); state.grants.set(`${user}@${h}`, g); } return { user, database, privileges, hosts }; },
    'db.revoke': ({ user, database, hosts }) => { for (const h of hosts) state.grants.get(`${user}@${h}`)?.delete(database); return { user, database, hosts, revoked: true }; },
    'db.check': ({ action, databases }) => ({ action, databases, exitCode: 0, results: databases.map((d) => ({ table: `${d}.t`, status: 'ok', messages: [] })), summary: { tables: databases.length, ok: databases.length, repaired: 0, warnings: 0, errors: 0 }, stderr: '' }),
    'db.dump': ({ path, databases }) => { state.dumps.push({ path, databases }); return { path, sizeBytes: 2048, databases }; },
    // Published under the hostname site (P0-5); the distro's global alias is already disabled.
    'db.phpmyadmin.detect': () => ({ installed: true, dir: '/usr/share/phpmyadmin', version: '5.2.1', configFile: '/etc/phpmyadmin/config.inc.php', webConfigs: [{ path: '/etc/apache2/conf-available/phpmyadmin.conf', enabled: false, server: 'apache', urlPath: '/phpmyadmin', global: true }], urlPath: '/phpmyadmin', php: true, candidates: [], dbConfigured: true, globalAlias: { enabled: false, path: '/etc/apache2/conf-available/phpmyadmin.conf', urlPath: null, a2disconf: false }, published: { path: '/etc/apache2/keel-host.d/phpmyadmin.conf', managed: true, alias: '/phpmyadmin', root: '/usr/share/phpmyadmin', php: true }, packageHint: 'apt-get install phpmyadmin' }),
    'fs.mkdir': ({ path }) => ({ path }),
    'fs.chown': ({ path }) => ({ path }),
    'fs.chmod': ({ path }) => ({ path }),
    'fs.remove': ({ path }) => ({ path, removed: true }),
    'files.mkdir': ({ path }) => ({ path }),
    // As on the real agent: files.copy only takes sources inside the home, and
    // backup.dump.import only sources inside the account's own staging directory.
    'files.copy': ({ username, from, to }) => { for (const p of [from, to]) if (!p.startsWith(`/home/${username}/`)) throw fail('path_not_allowed', `${p} is not inside the home directory /home/${username}`); return { from, to }; },
    'backup.dump.import': ({ username, from, to }) => {
      if (!from.startsWith(`/var/lib/whm/panel/dumps/${username}/`) || from.split('/').length !== 8) throw fail('path_not_allowed', `${from} is not inside the dump staging directory of ${username}`);
      if (!to.startsWith(`/home/${username}/`)) throw fail('path_not_allowed', `${to} is not inside the home directory /home/${username}`);
      state.imports.push({ username, from, to });
      return { from, to, username, sizeBytes: 2048 };
    },
  };
  const agent = createMockAgent(ops);
  agent.state = state;
  agent.ops = ops;
  return agent;
}

// The §3.1 scope shape, resolved from the X-Panel-Account header (U0's
// panelScope middleware does this from the session once it lands).
function stubPanel(ctx) {
  ctx.panel = {
    async scope(req) {
      const username = req.get('x-panel-account');
      if (!username) throw new HttpError(403, 'no_account', 'No hosting account is linked to this login');
      const row = ctx.db.prepare('SELECT * FROM accounts WHERE username = ?').get(username);
      if (!row) throw new HttpError(403, 'no_account', 'No hosting account is linked to this login');
      const account = ctx.accounts.get(username, { id: null, username: 'test', role: 'root' });
      const owner = ctx.db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(row.owner_id);
      return { account, accountId: account.id, username, mode: 'user', actor: req.user, actingAs: null, owner, ownerPrincipal: { id: owner.id, username: owner.username, role: owner.role }, limits: {}, features: account.plan?.features || {} };
    },
  };
}

async function panelApp(app, registerFn) {
  const api = express();
  api.use(express.json({ limit: '2mb' }));
  api.use((req, _res, next) => {
    req.user = { id: 0, username: req.get('x-panel-account') || 'nobody', role: 'user' };
    if (req.get('x-token-scopes')) req.auth = { via: 'token', scopes: req.get('x-token-scopes').split(',') };
    req.audit = (entry) => app.ctx.auditRecord(req, entry);
    next();
  });
  const mount = await registerFn(app.ctx);
  api.use(`/api/panel${mount.path}`, mount.router);
  api.use(notFoundHandler);
  api.use(errorHandler(app.ctx.logger));
  return request(api);
}

function setPlan(app, username, patch) {
  const row = app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username);
  const plan = JSON.parse(row.plan_snapshot_json || '{}');
  const next = typeof patch === 'function' ? patch(plan) : { ...plan, ...patch };
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(next), username);
}

describe('panel databases helpers', () => {
  it('prefixes names once and reads limits with enhancements only raising them', () => {
    expect(ensurePrefixed('alice', 'shop')).toBe('alice_shop');
    expect(ensurePrefixed('alice', 'alice_shop')).toBe('alice_shop');
    expect(effectiveLimit({ account: { plan: { max_db: 2 } }, limits: { max_db: 5 } }, 'max_db')).toBe(5);
    expect(effectiveLimit({ account: { plan: { max_db: 5 } }, limits: { max_db: 2 } }, 'max_db')).toBe(5);
    expect(effectiveLimit({ account: { plan: {} }, limits: { max_db: 2 } }, 'max_db')).toBeNull();
    expect(effectiveLimit({ account: { plan: { max_db: 0 } }, limits: {} }, 'max_db')).toBe(0);
    expect(SYSTEM_ROOT).toMatchObject({ role: 'root', username: 'panel' });
  });
});

describe('/api/panel/databases', () => {
  let app;
  let api;
  let csrf;
  const as = (user) => ({ 'X-Panel-Account': user });
  const get = (p, user = 'alice') => api.get(`/api/panel/databases${p}`).set(as(user));
  const post = (p, body = {}, user = 'alice') => api.post(`/api/panel/databases${p}`).set(as(user)).send(body);
  const put = (p, body = {}, user = 'alice') => api.put(`/api/panel/databases${p}`).set(as(user)).send(body);
  const del = (p, user = 'alice') => api.delete(`/api/panel/databases${p}`).set(as(user));

  beforeAll(async () => {
    app = await createTestApp({ agent: mysqlAgent() });
    csrf = await app.login();
    app.ctx.jobs.start();
    await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', owner: 'resell1' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com' }).expect(201);
    stubPanel(app.ctx);
    api = await panelApp(app, register);
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('refuses requests without a pinned account or without the panel service', async () => {
    const res = await api.get('/api/panel/databases').expect(403);
    expect(res.body.error.code).toBe('no_account');
    const panel = app.ctx.panel;
    delete app.ctx.panel;
    try {
      const r = await api.get('/api/panel/databases').set(as('alice')).expect(403);
      expect(r.body.error.code).toBe('panel_scope_required');
    } finally { app.ctx.panel = panel; }
    const scoped = await api.get('/api/panel/databases').set(as('alice')).set('X-Token-Scopes', 'panel:read').expect(403);
    expect(scoped.body.error.message).toMatch(/panel:databases/);
    await api.get('/api/panel/databases').set(as('alice')).set('X-Token-Scopes', 'panel:databases').expect(200);
  });

  it('creates databases always prefixed, even with db.prefixing=false, and lists only the account', async () => {
    const created = await post('/', { name: 'shop' }).expect(201);
    expect(created.body.data).toMatchObject({ name: 'alice_shop', account: 'alice', quota: { used: 1 } });
    app.ctx.settings.set('db.prefixing', false);
    try {
      const again = await post('/', { name: 'blog' }).expect(201);
      expect(again.body.data.name).toBe('alice_blog');
      const prefixed = await post('/', { name: 'alice_news' }).expect(201);
      expect(prefixed.body.data.name).toBe('alice_news');
    } finally { app.ctx.settings.set('db.prefixing', true); }
    await post('/', { name: 'other' }, 'bob').expect(201);
    const list = await get('/').expect(200);
    expect(list.body.data.map((d) => d.name).sort()).toEqual(['alice_blog', 'alice_news', 'alice_shop']);
    expect(list.body.meta).toMatchObject({ engine: 'mysql', prefix: 'alice_', quota: { used: 3 }, engineError: null });
    expect(list.body.data[0].onServer).toBe(true);
    const createCall = app.agent.callsTo('db.database.create');
    expect(createCall.every((c) => /^(alice|bob)_/.test(c.args.name))).toBe(true);
    const audits = app.ctx.db.prepare("SELECT target, args_redacted FROM audit_log WHERE action = 'panel.db.create' ORDER BY id").all();
    expect(audits.map((a) => a.target)).toEqual(['alice', 'alice', 'alice', 'bob']);
    expect(JSON.parse(audits[2].args_redacted)).toMatchObject({ database: 'alice_news' });
  });

  it('validates names and refuses the plan limit with limit_reached', async () => {
    for (const name of ['Shop', 'my-db', 'a b', '../x', 'x'.repeat(55), '']) {
      const res = await post('/', { name }).expect(422);
      expect(res.body.error.fields.name, name).toBeDefined();
    }
    await post('/', { name: 'shop', owner: 'bob' }).expect(422);
    setPlan(app, 'alice', { max_db: 3 });
    try {
      const res = await post('/', { name: 'fourth' }).expect(409);
      expect(res.body.error.code).toBe('limit_reached');
      expect(app.agent.callsTo('db.database.create')).toHaveLength(0);
    } finally { setPlan(app, 'alice', { max_db: 10 }); }
  });

  it('pre-checks membership for drop, check and dump: another account\'s database is not found', async () => {
    for (const p of ['/bob_other']) {
      expect((await del(p).expect(404)).body.error.code).toBe('not_found');
      expect((await post(`${p}/check`, { action: 'check' }).expect(404)).body.error.code).toBe('not_found');
      expect((await post(`${p}/dump`, {}).expect(404)).body.error.code).toBe('not_found');
    }
    expect(app.agent.callsTo('db.database.drop')).toHaveLength(0);
    expect(app.ctx.db.prepare("SELECT 1 FROM databases WHERE name = 'bob_other'").get()).toBeTruthy();
    const dropped = await del('/alice_news').expect(200);
    expect(dropped.body.data).toMatchObject({ name: 'alice_news', dropped: true });
    expect(app.agent.callsTo('db.database.drop')[0].args.name).toBe('alice_news');
    const check = await post('/alice_shop/check', { action: 'optimize' }).expect(202);
    expect(check.body.data.job.id).toBeTruthy();
    const job = await waitForJob(app.ctx, check.body.data.job.id);
    expect(job.status).toBe('done');
    expect(app.agent.callsTo('db.check')[0].args.databases).toEqual(['alice_shop']);
  });

  it('manages users and grants only within the account', async () => {
    const created = await post('/users', { name: 'app', password: 'S3cret-pass!', databases: ['alice_shop'] }).expect(201);
    expect(created.body.data).toMatchObject({ name: 'alice_app', hosts: ['localhost'], grants: [{ database: 'alice_shop', privileges: ['ALL PRIVILEGES'] }] });
    expect(app.agent.callsTo('db.user.create')[0].args).toMatchObject({ user: 'alice_app', password: 'S3cret-pass!' });
    const foreign = await post('/users', { name: 'spy', password: 'S3cret-pass!', databases: ['bob_other'] }).expect(404);
    expect(foreign.body.error.message).toMatch(/bob_other/);
    expect(app.agent.callsTo('db.user.create')).toHaveLength(1);
    await post('/users', { name: 'bobapp', password: 'S3cret-pass!' }, 'bob').expect(201);
    const users = await get('/users').expect(200);
    expect(users.body.data.map((u) => u.name)).toEqual(['alice_app']);
    await put('/users/bob_bobapp/password', { password: 'An0ther-pass!' }).expect(404);
    await del('/users/bob_bobapp').expect(404);
    await get('/users/bob_bobapp/grants').expect(404);
    await put('/users/bob_bobapp/grants', { grants: [] }).expect(404);
    expect(app.agent.callsTo('db.user.set_password')).toHaveLength(0);
    await put('/users/alice_app/password', { password: 'An0ther-pass!' }).expect(200);
    const cross = await put('/users/alice_app/grants', { grants: [{ database: 'bob_other', privileges: ['SELECT'] }] }).expect(404);
    expect(cross.body.error.message).toMatch(/bob_other/);
    const bad = await put('/users/alice_app/grants', { grants: [{ database: 'alice_shop', privileges: ['FILE'] }] }).expect(422);
    expect(bad.body.error.fields['grants.0.privileges.0']).toBeDefined();
    const set = await put('/users/alice_app/grants', { grants: [{ database: 'alice_blog', privileges: ['SELECT', 'INSERT'] }] }).expect(200);
    expect(set.body.data.grants).toEqual([{ database: 'alice_blog', privileges: ['INSERT', 'SELECT'] }]);
    const grants = await get('/users/alice_app/grants').expect(200);
    expect(grants.body.data.grants.map((g) => g.database)).toEqual(['alice_blog']);
    expect(grants.body.data.privileges).toContain('ALL PRIVILEGES');
    expect(app.ctx.db.prepare("SELECT 1 FROM db_users WHERE name = 'bob_bobapp'").get()).toBeTruthy();
    await del('/users/alice_app').expect(200);
    expect(app.ctx.db.prepare("SELECT 1 FROM db_users WHERE name = 'alice_app'").get()).toBeFalsy();
  });

  it('adds remote hosts pinned to the account and removes only its own rows', async () => {
    await post('/users', { name: 'app', password: 'S3cret-pass!' }).expect(201);
    for (const host of ['localhost', 'bad host', 'x;y', '']) await post('/access-hosts', { host }).expect((r) => expect([400, 422]).toContain(r.status));
    const added = await post('/access-hosts', { host: '203.0.113.9' }).expect(201);
    expect(added.body.data).toMatchObject({ host: '203.0.113.9', scope: 'account', editable: true });
    expect(app.agent.callsTo('db.user.add_host')[0].args).toMatchObject({ user: 'alice_app', toHost: '203.0.113.9' });
    const bobHost = await post('/access-hosts', { host: '198.51.100.7' }, 'bob').expect(201);
    const list = await get('/access-hosts').expect(200);
    expect(list.body.data.map((h) => h.host)).toEqual(['203.0.113.9']);
    expect(list.body.meta.supported).toBe(true);
    await del(`/access-hosts/${bobHost.body.data.id}`).expect(404);
    expect(app.ctx.db.prepare('SELECT 1 FROM db_access_hosts WHERE id = ?').get(bobHost.body.data.id)).toBeTruthy();
    await del(`/access-hosts/${added.body.data.id}`).expect(200);
    expect(app.ctx.db.prepare('SELECT 1 FROM db_access_hosts WHERE id = ?').get(added.body.data.id)).toBeFalsy();
  });

  it('returns a trimmed phpMyAdmin shape (no paths) with the hostname-site address, honouring the feature and setting', async () => {
    const previousHostname = app.ctx.settings.get('basic.hostname');
    app.ctx.settings.set('basic.hostname', 'panel.example.com');
    try {
      const res = await get('/phpmyadmin').expect(200);
      expect(res.body.data).toEqual({ installed: true, url: 'https://panel.example.com/phpmyadmin/', featureEnabled: true, version: '5.2.1', users: ['alice_app'], sso: false });
      for (const key of ['dir', 'configFile', 'webConfigs', 'candidates', 'packageHint', 'published', 'globalAlias']) expect(res.body.data).not.toHaveProperty(key);
      // Not published and no hostname site: the global alias alone is not an address the panel advertises.
      app.agent.set('db.phpmyadmin.detect', () => ({ installed: true, dir: '/usr/share/phpmyadmin', version: '5.2.1', configFile: null, webConfigs: [], urlPath: '/phpmyadmin', php: true, candidates: [], dbConfigured: true, globalAlias: { enabled: true, path: '/etc/apache2/conf-enabled/phpmyadmin.conf', urlPath: '/phpmyadmin', a2disconf: true }, published: null, packageHint: null }));
      try { expect((await get('/phpmyadmin').expect(200)).body.data).toMatchObject({ installed: true, url: null }); } finally { app.agent.set('db.phpmyadmin.detect', app.agent.ops['db.phpmyadmin.detect']); }
      // A bare hostname cannot carry a trusted address either.
      app.ctx.settings.set('basic.hostname', 'nova');
      expect((await get('/phpmyadmin').expect(200)).body.data).toMatchObject({ installed: true, url: null });
    } finally { app.ctx.settings.set('basic.hostname', previousHostname); }
    app.ctx.settings.set('db.phpmyadmin.enabled', false);
    try {
      const off = await get('/phpmyadmin').expect(200);
      expect(off.body.data).toMatchObject({ featureEnabled: false, url: null });
    } finally { app.ctx.settings.set('db.phpmyadmin.enabled', true); }
    setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), phpmyadmin: false } }));
    try { expect((await get('/phpmyadmin').expect(403)).body.error.code).toBe('feature_disabled'); } finally { setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), phpmyadmin: true } })); }
  });

  it('single sign-on into phpMyAdmin: a one-time link for the hidden prefix user, exchanged once over loopback, never for API tokens', async () => {
    const previousHostname = app.ctx.settings.get('basic.hostname');
    app.ctx.settings.set('basic.hostname', 'panel.example.com');
    app.ctx.settings.set('panel.phpmyadmin.sso', true);
    const detect = app.agent.ops['db.phpmyadmin.detect'];
    app.agent.set('db.phpmyadmin.detect', () => ({ ...detect(), signon: { path: '/etc/phpmyadmin/conf.d/keel-signon.php', exists: true, managed: true, confDir: true } }));
    const exchange = (token) => app.http.get(`/api/panel/sso/phpmyadmin/${token}`);
    const audit = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
    try {
      expect((await get('/phpmyadmin').expect(200)).body.data).toMatchObject({ sso: true, users: ['alice_app'] });
      expect((await post('/phpmyadmin/sso', { extra: 1 })).status).toBe(422);
      const res = await post('/phpmyadmin/sso').expect(200);
      const url = new URL(res.body.data.url);
      expect(url.origin + url.pathname).toBe('https://panel.example.com/keel/pma-signon.php');
      const token = url.searchParams.get('_keel');
      expect(token).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
      expect(res.body.data).toMatchObject({ user: 'alice_pma' });
      expect(res.body.data).not.toHaveProperty('password');
      expect(new Date(res.body.data.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
      const row = app.ctx.db.prepare('SELECT * FROM panel_sso_tokens ORDER BY id DESC').get();
      expect(row).toMatchObject({ account: 'alice', kind: 'phpmyadmin', used_at: null, token_hash: app.ctx.crypto.hashToken(token) });
      const password = app.agent.callsTo('db.user.create')[0].args.password;
      expect(row.payload_enc).not.toContain(password);
      expect(JSON.parse(app.ctx.crypto.decrypt(row.payload_enc))).toEqual({ user: 'alice_pma', password, host: 'localhost' });
      expect(app.agent.callsTo('db.user.create')[0].args).toMatchObject({ user: 'alice_pma', hosts: ['localhost'] });
      const owned = app.ctx.db.prepare("SELECT d.name FROM databases d JOIN accounts a ON a.id = d.account_id WHERE a.username = 'alice' ORDER BY d.name").all().map((d) => d.name);
      expect(owned.length).toBeGreaterThan(0);
      expect(app.agent.callsTo('db.grant').map((c) => c.args)).toEqual(owned.map((database) => ({ user: 'alice_pma', database, privileges: ['ALL PRIVILEGES'], hosts: ['localhost'] })));
      expect([...app.agent.state.grants.get('alice_pma@localhost').keys()].sort()).toEqual(owned);
      const a = audit('panel.db.phpmyadmin.sso').pop();
      expect(a).toMatchObject({ target: 'alice' });
      expect(a.args_redacted).not.toContain(password);
      expect(a.args_redacted).not.toContain(token);

      // Exchanged once with the stored payload; replay, wrong kind and garbage are refused.
      const ex = await exchange(token).expect(200);
      expect(ex.body.data).toEqual({ user: 'alice_pma', password, host: 'localhost' });
      expect(app.ctx.db.prepare('SELECT used_at FROM panel_sso_tokens WHERE id = ?').get(row.id).used_at).toBeTruthy();
      expect(JSON.parse(audit('panel.sso.exchange').pop().args_redacted)).toMatchObject({ kind: 'phpmyadmin', subject: 'alice_pma' });
      expect((await exchange(token)).status).toBe(404);
      expect((await app.http.get(`/api/panel/sso/webmail/${token}`)).status).toBe(404);
      expect((await exchange('short')).status).toBe(422);

      // The hidden user never shows in the account's own lists and cannot be touched by name; the name is reserved.
      expect((await get('/users').expect(200)).body.data.map((u) => u.name)).toEqual(['alice_app']);
      expect((await get('/phpmyadmin').expect(200)).body.data.users).toEqual(['alice_app']);
      expect((await del('/users/alice_pma')).status).toBe(404);
      expect((await put('/users/alice_pma/password', { password: 'An0ther-pass!' })).status).toBe(404);
      expect((await post('/users', { name: 'pma', password: 'S3cret-pass!' })).status).toBe(400);

      // A second sign-on drops and recreates the user with a new password; the next exchange returns the new one only.
      app.agent.calls.length = 0;
      const again = new URL((await post('/phpmyadmin/sso').expect(200)).body.data.url).searchParams.get('_keel');
      expect(app.agent.callsTo('db.user.drop')[0].args).toMatchObject({ user: 'alice_pma', hosts: ['localhost'] });
      const rotated = app.agent.callsTo('db.user.create')[0].args.password;
      expect(rotated).not.toBe(password);
      expect(app.agent.callsTo('db.user.set_password')).toEqual([]);
      expect((await exchange(again).expect(200)).body.data.password).toBe(rotated);

      // API tokens, the feature flag, the switch and the exchange after the switch is off.
      expect((await api.post('/api/panel/databases/phpmyadmin/sso').set(as('alice')).set('X-Token-Scopes', 'panel:databases').send({})).status).toBe(403);
      setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), phpmyadmin: false } }));
      try { expect((await post('/phpmyadmin/sso')).status).toBe(403); } finally { setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), phpmyadmin: true } })); }
      const last = new URL((await post('/phpmyadmin/sso').expect(200)).body.data.url).searchParams.get('_keel');
      app.ctx.settings.set('panel.phpmyadmin.sso', false);
      expect((await get('/phpmyadmin').expect(200)).body.data.sso).toBe(false);
      expect((await post('/phpmyadmin/sso')).status).toBe(409);
      expect((await exchange(last)).status).toBe(409);
      for (const r of app.ctx.db.prepare('SELECT args_redacted FROM audit_log').all()) for (const pw of [password, rotated]) expect(String(r.args_redacted || '')).not.toContain(pw);
    } finally {
      app.ctx.settings.set('basic.hostname', previousHostname);
      app.ctx.settings.set('panel.phpmyadmin.sso', false);
      app.agent.set('db.phpmyadmin.detect', detect);
      app.ctx.db.prepare("DELETE FROM db_users WHERE name = 'alice_pma'").run();
      app.agent.state.users.delete('alice_pma@localhost');
    }
  });

  it('a sign-on grants the account\'s own databases only: "bob" never reaches the databases of "bob_shop"', async () => {
    const previousHostname = app.ctx.settings.get('basic.hostname');
    app.ctx.settings.set('basic.hostname', 'panel.example.com');
    app.ctx.settings.set('panel.phpmyadmin.sso', true);
    const detect = app.agent.ops['db.phpmyadmin.detect'];
    app.agent.set('db.phpmyadmin.detect', () => ({ ...detect(), signon: { path: '/etc/phpmyadmin/conf.d/keel-signon.php', exists: true, managed: true, confDir: true } }));
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob_shop', domain: 'bobshop.com' }).expect(201);
    try {
      expect((await post('/', { name: 'data' }, 'bob').expect(201)).body.data.name).toBe('bob_data');
      expect((await post('/', { name: 'site' }, 'bob_shop').expect(201)).body.data.name).toBe('bob_shop_site');
      app.agent.calls.length = 0;
      const res = await post('/phpmyadmin/sso', {}, 'bob').expect(200);
      expect(res.body.data.user).toBe('bob_pma');
      const bobs = app.ctx.db.prepare("SELECT d.name FROM databases d JOIN accounts a ON a.id = d.account_id WHERE a.username = 'bob' ORDER BY d.name").all().map((d) => d.name);
      expect(bobs).toContain('bob_data');
      expect(app.agent.callsTo('db.grant').map((c) => c.args)).toEqual(bobs.map((database) => ({ user: 'bob_pma', database, privileges: ['ALL PRIVILEGES'], hosts: ['localhost'] })));
      expect([...app.agent.state.grants.get('bob_pma@localhost').keys()].sort()).toEqual(bobs);
      expect(app.agent.state.grants.get('bob_shop_pma@localhost')).toBeUndefined();
      for (const c of app.agent.calls) expect(JSON.stringify(c.args)).not.toMatch(/bob_shop|\\\\_%/);
      // The other way round: bob_shop's user holds only bob_shop_site.
      app.agent.calls.length = 0;
      await post('/phpmyadmin/sso', {}, 'bob_shop').expect(200);
      expect(app.agent.callsTo('db.grant').map((c) => c.args.database)).toEqual(['bob_shop_site']);
      expect(JSON.parse(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'db.phpmyadmin.signon' ORDER BY id DESC").get().args_redacted)).toMatchObject({ account: 'bob_shop', databases: ['bob_shop_site'] });
    } finally {
      app.ctx.settings.set('basic.hostname', previousHostname);
      app.ctx.settings.set('panel.phpmyadmin.sso', false);
      app.agent.set('db.phpmyadmin.detect', detect);
      for (const name of ['bob_pma', 'bob_shop_pma']) { app.ctx.db.prepare('DELETE FROM db_users WHERE name = ?').run(name); app.agent.state.users.delete(`${name}@localhost`); }
    }
  });

  it('gates everything on the mysql feature', async () => {
    setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), mysql: false } }));
    try {
      for (const r of [() => get('/'), () => post('/', { name: 'x' }), () => get('/users'), () => get('/access-hosts'), () => del('/alice_shop'), () => post('/alice_shop/dump', {})]) {
        const res = await r().expect(403);
        expect(res.body.error.code).toBe('feature_disabled');
      }
      expect(app.agent.calls.filter((c) => c.name.startsWith('db.'))).toHaveLength(0);
    } finally { setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), mysql: true } })); }
  });

  it('surfaces engine errors in meta instead of failing the list', async () => {
    app.agent.fail('db.databases.list', 'db_unreachable', 'cannot connect');
    try {
      const res = await get('/').expect(200);
      expect(res.body.meta.engineError).toMatchObject({ code: 'db_unreachable' });
      expect(res.body.data.map((d) => d.name)).toEqual(['alice_blog', 'alice_shop']);
      expect(res.body.data[0].onServer).toBeNull();
    } finally { app.agent.reset('db.databases.list'); app.agent.set('db.databases.list', () => [...app.agent.state.databases].map(([name, d]) => ({ name, charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', sizeBytes: 4096, tables: 2, system: d.system }))); }
  });

  it('dumps through a root staging directory and delivers it into the home with backup.dump.import (never files.copy)', async () => {
    const res = await post('/alice_shop/dump', {});
    expect(res.body, JSON.stringify(res.body)).toHaveProperty('data.job.id');
    expect(res.status).toBe(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status, `${job.error} ${JSON.stringify(job.logs)}`).toBe('done');
    expect(job.result.file).toMatch(/^backups\/alice_shop-\d{8}T\d{6}Z\.sql$/);
    const names = app.agent.calls.map((c) => c.name);
    expect(names).toEqual(['fs.mkdir', 'fs.mkdir', 'db.dump', 'files.mkdir', 'backup.dump.import', 'fs.remove']);
    const dump = app.agent.callsTo('db.dump')[0].args;
    expect(dump.path).toMatch(/^\/var\/lib\/whm\/panel\/dumps\/alice\/alice_shop-\d{8}T\d{6}Z\.sql$/);
    expect(dump.databases).toEqual(['alice_shop']);
    expect(app.agent.callsTo('fs.mkdir')[0].args).toMatchObject({ path: '/var/lib/whm/panel/dumps', mode: '0711', owner: 'root' });
    expect(app.agent.callsTo('fs.mkdir')[1].args).toEqual({ path: '/var/lib/whm/panel/dumps/alice', mode: '0700', owner: 'root' });
    expect(app.agent.callsTo('files.mkdir')[0].args).toEqual({ username: 'alice', path: '/home/alice/backups', mode: '0700' });
    const imported = app.agent.callsTo('backup.dump.import')[0].args;
    expect(imported).toEqual({ username: 'alice', from: dump.path, to: `/home/alice/backups/${dump.path.split('/').pop()}` });
    expect(app.agent.callsTo('files.copy')).toHaveLength(0);
    expect(app.agent.callsTo('fs.remove')[0].args.path).toBe(dump.path);
    const audit = app.ctx.db.prepare("SELECT principal FROM audit_log WHERE action = 'panel.db.dump.done' AND target = 'alice' ORDER BY id DESC LIMIT 1").get();
    expect(audit.principal).toBe('resell1');
  });

  it('lets the account follow its own check and dump jobs under /jobs, and nobody else\'s', async () => {
    const sse = (p, user = 'alice') => get(p, user).buffer(true).parse((res, cb) => { let text = ''; res.on('data', (d) => { text += d; }); res.on('end', () => cb(null, text)); });
    const check = await post('/alice_shop/check', { action: 'check' }).expect(202);
    const checkId = check.body.data.job.id;
    await waitForJob(app.ctx, checkId);
    const dump = await post('/alice_shop/dump', {}).expect(202);
    const dumpId = dump.body.data.job.id;
    await waitForJob(app.ctx, dumpId);
    const job = await get(`/jobs/${checkId}`).expect(200);
    expect(job.body.data).toMatchObject({ id: checkId, type: 'db.repair', status: 'done', params: { databases: ['alice_shop'] } });
    expect(job.body.data.params).not.toHaveProperty('profileId');
    expect(job.body.data.logs).toBeInstanceOf(Array);
    const dumped = await get(`/jobs/${dumpId}`).expect(200);
    expect(dumped.body.data).toMatchObject({ type: 'panel.db.dump', status: 'done', params: { database: 'alice_shop' } });
    expect(dumped.body.data.params).not.toHaveProperty('ownerId');
    expect(dumped.body.data.result.file).toMatch(/^backups\//);
    const stream = await sse(`/jobs/${checkId}/stream`).expect(200);
    expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(stream.body).toContain('"type":"snapshot"');
    expect(stream.body).toContain('"type":"db.repair"');
    for (const id of [checkId, dumpId]) {
      expect((await get(`/jobs/${id}`, 'bob')).status, `job ${id}`).toBe(404);
      expect((await sse(`/jobs/${id}/stream`, 'bob')).status, `stream ${id}`).toBe(404);
    }
    expect((await get('/jobs/abc')).status).toBe(422);
    expect((await get('/jobs/999999')).status).toBe(404);
    app.ctx.jobs.register('test.noop', async () => ({ ok: true }));
    const other = app.ctx.jobs.enqueue('test.noop', { databases: ['alice_shop'], accountId: app.ctx.db.prepare("SELECT id FROM accounts WHERE username = 'alice'").get().id });
    await waitForJob(app.ctx, other.id);
    expect((await get(`/jobs/${other.id}`)).status).toBe(404);
    expect((await sse(`/jobs/${other.id}/stream`)).status).toBe(404);
    const live = app.ctx.jobs.enqueue('db.repair', { action: 'check', databases: ['alice_shop', 'bob_other'] }, { userId: null });
    expect((await get(`/jobs/${live.id}`)).status).toBe(404);
    await waitForJob(app.ctx, live.id);
  });

  it('fails the dump job closed when the owner is gone or changed, before mysqldump runs', async () => {
    const alice = app.ctx.db.prepare("SELECT id, owner_id FROM accounts WHERE username = 'alice'").get();
    const rootId = app.ctx.db.prepare("SELECT id FROM users WHERE username = 'root'").get().id;
    const fake = (ownerId) => ({ params: { accountId: alice.id, username: 'alice', database: 'alice_shop', ownerId, actor: 'alice' }, log() {}, progress() {} });
    await expect(app.ctx.panelDatabases.runDump(fake(null))).rejects.toThrow(/owner .* no longer exists/);
    await expect(app.ctx.panelDatabases.runDump(fake(987654))).rejects.toThrow(/owner .* no longer exists/);
    expect(rootId).not.toBe(alice.owner_id);
    await expect(app.ctx.panelDatabases.runDump(fake(rootId))).rejects.toThrow(/changed owner/);
    expect(app.agent.callsTo('db.dump')).toHaveLength(0);
    expect(app.agent.callsTo('backup.dump.import')).toHaveLength(0);
  });

  it('with a PostgreSQL profile hides hosts, requires the postgres feature and refuses access hosts', async () => {
    const { lastInsertRowid } = app.ctx.db.prepare("INSERT INTO db_instances (profile_name, engine, host, port, is_local, is_active) VALUES ('pg', 'postgres', 'localhost', 5432, 1, 0)").run();
    app.ctx.db.prepare('UPDATE db_instances SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END').run(lastInsertRowid);
    try {
      expect((await get('/users').expect(403)).body.error.code).toBe('feature_disabled');
      setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), postgres: true } }));
      const users = await get('/users').expect(200);
      expect(users.body.meta.engine).toBe('postgres');
      expect(users.body.data[0]).toMatchObject({ name: 'alice_app', hosts: [] });
      const hosts = await get('/access-hosts').expect(200);
      expect(hosts.body).toEqual({ data: [], meta: { total: 0, engine: 'postgres', supported: false } });
      expect((await post('/access-hosts', { host: '203.0.113.9' }).expect(422)).body.error.code).toBe('unsupported');
      expect((await post('/alice_shop/dump', {}).expect(501)).body.error.code).toBe('capability_missing');
      const pma = await get('/phpmyadmin').expect(200);
      expect(pma.body.data).toMatchObject({ installed: false, url: null, engine: 'postgres' });
    } finally {
      app.ctx.db.prepare('DELETE FROM db_instances WHERE id = ?').run(lastInsertRowid);
      app.ctx.db.prepare('UPDATE db_instances SET is_active = 1').run();
      setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), postgres: false } }));
    }
  });
});
