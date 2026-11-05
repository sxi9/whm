import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { installIdOf, wpPath, JOB_INSTALL, JOB_UPDATE, INSTALL_HINT } from '../src/services/panel-software.js';

// A MariaDB-like host plus the WordPress ops: databases, users and the
// installs found under the home live in memory, so the install job, its
// compensation and the removal are checked end to end through the real
// /api/panel session flow (panelScope, the auto-mounted sub-router).
function hostAgent() {
  const state = { databases: new Map([['mysql', { system: true }]]), users: new Map([['root@localhost', {}]]), grants: new Map(), installs: new Map(), requirements: { wpcli: false, php: true, phpMysql: true, unzip: true, asUser: true }, failAt: null, passwords: {} };
  const hostsOf = (user) => [...state.users.keys()].filter((k) => k.startsWith(`${user}@`)).map((k) => k.split('@')[1]);
  const fail = (code, message, details = {}) => Object.assign(new Error(message), { agentError: true, code, details });
  const guard = (username, p) => { if (!p.startsWith(`/home/${username}/`)) throw fail('path_not_allowed', `${p} is not inside the home directory /home/${username}`); };
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['mysql', 'mysqld', 'mysqlcheck', 'mysqldump', 'systemctl', 'useradd', 'usermod', 'userdel', 'setpriv', 'runuser'].includes(n)])),
    'svc.list_units': () => ['mariadb'],
    'web.detect': () => ({ apache: { runUser: 'www-data' } }),
    'db.databases.list': () => [...state.databases].map(([name, d]) => ({ name, charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', sizeBytes: 4096, tables: 2, system: d.system })),
    'db.database.create': ({ name, charset, collation }) => { if (state.databases.has(name)) throw fail('exists', `database ${name} exists`); state.databases.set(name, { system: false }); return { name, charset, collation }; },
    'db.database.drop': ({ name }) => { state.databases.delete(name); return { name, dropped: true }; },
    'db.users.list': () => [...state.users.keys()].map((k) => { const [user, host] = k.split('@'); return { user, host, plugin: 'mysql_native_password', system: user === 'root' }; }),
    'db.user.create': ({ user, hosts, password }) => { state.passwords[user] = password; for (const h of hosts) state.users.set(`${user}@${h}`, {}); return { user, hosts }; },
    'db.user.drop': ({ user, hosts }) => { for (const h of hosts || hostsOf(user)) { state.users.delete(`${user}@${h}`); state.grants.delete(`${user}@${h}`); } return { user, dropped: hosts || hostsOf(user), missing: [] }; },
    'db.grants.list': ({ user, host }) => ({ user, host, raw: [], grants: [...(state.grants.get(`${user}@${host}`) || new Map())].map(([database, privileges]) => ({ database, table: '*', privileges })) }),
    'db.grant': ({ user, database, privileges, hosts }) => { for (const h of hosts) { const g = state.grants.get(`${user}@${h}`) || new Map(); g.set(database, privileges); state.grants.set(`${user}@${h}`, g); } return { user, database, privileges, hosts }; },
    'db.revoke': ({ user, database, hosts }) => { for (const h of hosts) state.grants.get(`${user}@${h}`)?.delete(database); return { user, database, hosts, revoked: true }; },
    'web.wp.requirements': () => ({ ...state.requirements }),
    'web.wp.discover': ({ usernames }) => ({ installs: [...state.installs.values()].filter((i) => usernames.includes(i.username)), missing: [] }),
    'web.wp.fetch': ({ username, path }) => {
      guard(username, path);
      if (state.failAt === 'fetch') throw fail('download_failed', 'Download failed: HTTP 503', { cleanup: `removed ${path}` });
      state.installs.set(path, { username, home: `/home/${username}`, path, version: '6.9', dbName: null, dbUser: null, dbHost: null, tablePrefix: null, relative: path.replace(`/home/${username}/`, ''), configured: false });
      return { path, bytes: 37_000_000, sha1: 'b552c39cd95d89895b4e7a55af53a03687aff4f6', members: 2200, version: '6.9' };
    },
    'web.wp.configure': ({ username, path, dbName, dbUser, dbPassword, dbHost, tablePrefix }) => {
      guard(username, path);
      const i = state.installs.get(path);
      if (!i) throw fail('not_found', `${path} does not hold an unpacked WordPress tree`);
      Object.assign(i, { dbName, dbUser, dbHost, tablePrefix, configured: true, dbPassword });
      return { path: `${path}/wp-config.php`, mode: '0600', linted: true, tablePrefix };
    },
    'web.wp.webinstall': ({ username, path, url, adminPassword }) => {
      guard(username, path);
      if (state.failAt === 'webinstall') throw fail('command_failed', 'the WordPress installer answered 500: Error establishing a database connection');
      const i = state.installs.get(path);
      i.adminPassword = adminPassword;
      return { url, status: 200, installed: true, adminUrl: `${url}/wp-admin/`, version: '6.9' };
    },
    'web.wp.install': ({ username, path, url, dbName, dbUser, dbHost, tablePrefix }) => {
      guard(username, path);
      state.installs.set(path, { username, home: `/home/${username}`, path, version: '6.9', dbName, dbUser, dbHost, tablePrefix, relative: path.replace(`/home/${username}/`, '') });
      return { path, url, version: '6.9', theme: { name: 'twentytwentyfive' }, steps: ['download', 'config', 'install', 'theme'], warning: null };
    },
    'web.wp.update': ({ username, path, kind }) => { guard(username, path); return { kind, name: null, all: false, output: 'Success: WordPress updated successfully.', databaseUpdated: true }; },
    'web.wp.remove': ({ username, path, mode }) => {
      guard(username, path);
      if (!state.installs.has(path)) throw fail('not_found', `${path} does not hold a WordPress installation`);
      state.installs.delete(path);
      return { path, mode, removed: mode === 'tree' ? [path.replace(`/home/${username}/`, '')] : ['public_html/wp-admin', 'public_html/wp-config.php'] };
    },
  };
  const agent = createMockAgent(ops);
  agent.state = state;
  return agent;
}

describe('panel-software helpers', () => {
  it('pins install paths and derives stable ids', () => {
    for (const ok of ['blog', 'sites/one', 'a.b_c-d/e']) expect(wpPath.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '/blog', '-x', '../x', 'a/../b', 'a/./b', 'a//b', 'blog post', 'x\0y', 'x'.repeat(201)]) expect(wpPath.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(installIdOf('/home/alice/public_html/blog')).toMatch(/^[a-f0-9]{16}$/);
    expect(installIdOf('/home/alice/public_html/blog')).toBe(installIdOf('/home/alice/public_html/blog'));
    expect(installIdOf('/home/alice/public_html/blog')).not.toBe(installIdOf('/home/alice/public_html'));
    expect(JOB_INSTALL).toBe('panel.wp.install');
    expect(INSTALL_HINT).toMatch(/wp-cli/i);
  });
});

describe('/api/panel/software/wordpress', () => {
  let app;
  let alice;
  let aliceCsrf;
  let rootCsrf;
  const db = () => app.ctx.db;
  const state = () => app.agent.state;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', rootCsrf).send(body);
  const audits = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC').all(action);
  const get = (p) => alice.get(`/api/panel/software${p}`);
  const post = (p, body = {}) => alice.post(`/api/panel/software${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const del = (p) => alice.delete(`/api/panel/software${p}`).set('X-CSRF-Token', aliceCsrf);
  const setPlan = (key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.${key}', json(?)) WHERE username = 'alice'`).run(JSON.stringify(value));
  const calls = (name) => app.agent.calls.filter((c) => c.name === name);
  const BLOG = '/home/alice/public_html/blog';
  const install = { domain: 'alice.com', path: 'blog', title: 'Alice writes', adminUser: 'alice.editor', adminEmail: 'alice@alice.com' };

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    rootCsrf = await app.login();
    app.ctx.jobs.start();
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/accounts', { username: 'bob', domain: 'bob.com', contactEmail: 'bob@bob.com' }).expect(201);
    await rootPost('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!' }).expect(200);
    const http = request.agent(app.ctx.app);
    const res = await http.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' });
    expect(res.status).toBe(200);
    alice = http;
    aliceCsrf = res.body.data.csrfToken;
    db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES ((SELECT id FROM accounts WHERE username = 'alice'), 'shop.alice.com', 'sub', '/home/alice/public_html/shop')").run();
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; state().failAt = null; state().requirements = { wpcli: false, php: true, phpMysql: true, unzip: true, asUser: true }; });

  it('lists nothing at first, with the host requirements and the account sites', async () => {
    const res = await get('/wordpress').expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ canInstall: true, updates: false, prefix: 'alice_', requirements: { wpcli: false, phpMysql: true } });
    expect(res.body.meta.sites).toEqual([{ domain: 'alice.com', type: 'main', docroot: 'public_html' }, { domain: 'shop.alice.com', type: 'sub', docroot: 'public_html/shop' }]);
  });

  it('validates the body, the domain and the folder before anything is created', async () => {
    expect((await post('/wordpress', { ...install, path: '../etc' })).status).toBe(422);
    expect((await post('/wordpress', { ...install, path: '/blog' })).status).toBe(422);
    expect((await post('/wordpress', { ...install, adminUser: 'ad min' })).status).toBe(422);
    expect((await post('/wordpress', { ...install, adminEmail: 'nope' })).status).toBe(422);
    expect((await post('/wordpress', { ...install, title: 'a\nb' })).status).toBe(422);
    expect((await post('/wordpress', { ...install, adminPassword: 'short' })).status).toBe(422);
    expect((await post('/wordpress', { ...install, extra: 1 })).status).toBe(422);
    const foreign = await post('/wordpress', { ...install, domain: 'bob.com' });
    expect(foreign.status).toBe(404);
    expect(calls('db.database.create')).toHaveLength(0);
    expect(db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'panel.wp.install'").get().n).toBe(0);
  });

  it('answers 501 with the install hint when the host can neither run WP-CLI nor php-mysql + unzip', async () => {
    state().requirements = { wpcli: false, php: true, phpMysql: false, unzip: true, asUser: true };
    const res = await post('/wordpress', install);
    expect(res.status).toBe(501);
    expect(res.body.error.message).toContain('WP-CLI');
    expect(calls('db.database.create')).toHaveLength(0);
  });

  it('refuses when the plan has no database left, before any database or job exists', async () => {
    setPlan('max_sql', 0);
    try {
      const res = await post('/wordpress', install);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('limit_reached');
      expect(calls('db.database.create')).toHaveLength(0);
      expect(calls('web.wp.fetch')).toHaveLength(0);
    } finally { setPlan('max_sql', null); }
  });

  it('installs through fetch → configure → webinstall as the account, with a generated password shown once', async () => {
    const res = await post('/wordpress', install);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ domain: 'alice.com', path: 'public_html/blog', url: 'http://alice.com/blog', adminUrl: 'http://alice.com/blog/wp-admin/', database: 'alice_wp', dbUser: 'alice_wp', method: 'web', generatedPassword: true });
    expect(res.body.data.adminPassword).toMatch(/^.{20}$/);
    expect(res.body.data.id).toBe(installIdOf(BLOG));
    const jobId = res.body.data.job.id;
    const job = await waitForJob(app.ctx, jobId);
    expect(job.status, JSON.stringify(job)).toBe('done');
    expect(job.result).toMatchObject({ url: 'http://alice.com/blog', version: '6.9', database: 'alice_wp', method: 'web' });
    expect(calls('db.database.create')[0].args.name).toBe('alice_wp');
    expect(calls('db.user.create')[0].args).toMatchObject({ user: 'alice_wp', hosts: ['localhost'] });
    expect(calls('web.wp.fetch')[0].args).toEqual({ username: 'alice', path: BLOG });
    const cfg = calls('web.wp.configure')[0].args;
    expect(cfg).toMatchObject({ username: 'alice', path: BLOG, dbName: 'alice_wp', dbUser: 'alice_wp', dbHost: 'localhost', tablePrefix: 'wp_' });
    expect(cfg.dbPassword).toBe(state().passwords.alice_wp);
    const web = calls('web.wp.webinstall')[0].args;
    expect(web).toMatchObject({ username: 'alice', path: BLOG, url: 'http://alice.com/blog', title: 'Alice writes', adminUser: 'alice.editor', adminEmail: 'alice@alice.com', locale: 'en_US' });
    expect(web.adminPassword).toBe(res.body.data.adminPassword);
    // Secrets stay encrypted in the job record and never reach the account's job view.
    const raw = db().prepare('SELECT params_json FROM jobs WHERE id = ?').get(jobId).params_json;
    expect(raw).not.toContain(res.body.data.adminPassword);
    expect(raw).not.toContain(state().passwords.alice_wp);
    const seen = await get(`/wordpress/jobs/${jobId}`).expect(200);
    expect(seen.body.data.params.adminPasswordEnc).toBeUndefined();
    expect(seen.body.data.params.dbPasswordEnc).toBeUndefined();
    expect(seen.body.data.params).toMatchObject({ domain: 'alice.com', rel: 'public_html/blog', method: 'web' });
    expect(audits('panel.wp.install')[0]).toMatchObject({ principal: 'alice', target: 'alice' });
    expect(String(audits('panel.wp.install')[0].args_redacted)).not.toContain(res.body.data.adminPassword);
    expect(audits('panel.wp.install.done')).toHaveLength(1);
    const list = await get('/wordpress').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: installIdOf(BLOG), path: 'public_html/blog', domain: 'alice.com', under: 'blog', version: '6.9', database: 'alice_wp', databaseOwned: true, isDocroot: false });
    expect(list.body.data[0].abs).toBeUndefined();
    expect((await post('/wordpress', install)).status).toBe(409);
    const dbs = await alice.get('/api/panel/databases').expect(200);
    expect(dbs.body.data.map((d) => d.name)).toContain('alice_wp');
  });

  it("another account's job is 404 and the stream answers the snapshot", async () => {
    const jobId = db().prepare("SELECT id FROM jobs WHERE type = 'panel.wp.install' ORDER BY id DESC LIMIT 1").get().id;
    await rootPost('/api/panel/admin/accounts/bob/password', { password: 'Bob-Passw0rd!!' }).expect(200);
    const bob = request.agent(app.ctx.app);
    await bob.post('/api/auth/login').send({ username: 'bob', password: 'Bob-Passw0rd!!' }).expect(200);
    expect((await bob.get(`/api/panel/software/wordpress/jobs/${jobId}`)).status).toBe(404);
    const stream = await get(`/wordpress/jobs/${jobId}/stream`).buffer(true).parse((res, cb) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => cb(null, s)); });
    expect(stream.status).toBe(200);
    expect(stream.body).toContain('"type":"snapshot"');
    expect(stream.body).not.toContain('PasswordEnc');
  });

  it('takes the next free database name, and a failed install drops the files, the user and the database again', async () => {
    state().failAt = 'webinstall';
    const res = await post('/wordpress', { ...install, domain: 'shop.alice.com', path: '', adminPassword: 'Chosen-Passw0rd!' });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ database: 'alice_wp2', dbUser: 'alice_wp2', generatedPassword: false, path: 'public_html/shop', url: 'http://shop.alice.com' });
    expect(res.body.data.adminPassword).toBeUndefined();
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('database connection');
    expect(calls('web.wp.remove')[0].args).toEqual({ username: 'alice', path: '/home/alice/public_html/shop', mode: 'entries' });
    expect(calls('db.user.drop')[0].args.user).toBe('alice_wp2');
    expect(calls('db.database.drop')[0].args.name).toBe('alice_wp2');
    expect(state().databases.has('alice_wp2')).toBe(false);
    expect(db().prepare("SELECT COUNT(*) AS n FROM databases WHERE name = 'alice_wp2'").get().n).toBe(0);
    expect(audits('panel.wp.install.failed')).toHaveLength(1);
    expect((await get('/wordpress')).body.data).toHaveLength(1);
    // The names are free again: the retry gets alice_wp2 back.
    state().failAt = 'fetch';
    const again = await post('/wordpress', { ...install, domain: 'shop.alice.com', path: '' });
    expect(again.body.data.database).toBe('alice_wp2');
    const j2 = await waitForJob(app.ctx, again.body.data.job.id);
    expect(j2.status).toBe('failed');
    // The agent reported its own cleanup, so no remove op is needed; the database still goes.
    expect(calls('web.wp.remove')).toHaveLength(1);
    expect(calls('db.database.drop').at(-1).args.name).toBe('alice_wp2');
  });

  it('updates only with WP-CLI, through a job of the account', async () => {
    const id = installIdOf(BLOG);
    const missing = await post(`/wordpress/${id}/update`, {});
    expect(missing.status).toBe(501);
    expect(missing.body.error.message).toMatch(/WP-CLI/);
    state().requirements = { wpcli: true, php: true, phpMysql: true, unzip: true, asUser: true };
    const res = await post(`/wordpress/${id}/update`, {});
    expect(res.status).toBe(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.type).toBe(JOB_UPDATE);
    expect(calls('web.wp.update')[0].args).toEqual({ username: 'alice', path: BLOG, kind: 'core' });
    expect(job.result).toMatchObject({ path: 'public_html/blog', fromVersion: '6.9', databaseUpdated: true });
    expect(audits('panel.wp.update')).toHaveLength(1);
    expect(audits('panel.wp.update.done')).toHaveLength(1);
    expect((await post('/wordpress/0000000000000000/update', {})).status).toBe(404);
    expect((await post('/wordpress/not-an-id/update', {})).status).toBe(422);
  });

  it('with WP-CLI the install goes through web.wp.install in one step', async () => {
    state().requirements = { wpcli: true, php: true, phpMysql: true, unzip: true, asUser: true };
    const res = await post('/wordpress', { ...install, path: 'news', adminPassword: 'Chosen-Passw0rd!' });
    expect(res.status).toBe(202);
    expect(res.body.data.method).toBe('wpcli');
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    const args = calls('web.wp.install')[0].args;
    expect(args).toMatchObject({ username: 'alice', path: '/home/alice/public_html/news', url: 'http://alice.com/news', dbName: 'alice_wp2', dbUser: 'alice_wp2', dbHost: 'localhost', tablePrefix: 'wp_', locale: 'en_US', adminPassword: 'Chosen-Passw0rd!' });
    expect(calls('web.wp.fetch')).toHaveLength(0);
  });

  it('removes an installation, with its database only when asked and owned, and never without confirm', async () => {
    const id = installIdOf('/home/alice/public_html/news');
    expect((await del(`/wordpress/${id}`)).status).toBe(422);
    expect((await del(`/wordpress/${id}?confirm=yes`)).status).toBe(422);
    const kept = await del(`/wordpress/${id}?confirm=true`);
    expect(kept.status).toBe(200);
    expect(kept.body.data).toMatchObject({ removed: true, database: null, databaseKept: 'alice_wp2' });
    expect(calls('web.wp.remove')[0].args).toEqual({ username: 'alice', path: '/home/alice/public_html/news', mode: 'tree' });
    expect(state().databases.has('alice_wp2')).toBe(true);
    // A foreign database named in wp-config.php is left alone even with database=true.
    state().installs.set('/home/alice/public_html/shop', { username: 'alice', home: '/home/alice', path: '/home/alice/public_html/shop', version: '6.8', dbName: 'bob_wp', dbUser: 'bob_wp', dbHost: 'localhost', tablePrefix: 'wp_', relative: 'public_html/shop' });
    const foreign = await del(`/wordpress/${installIdOf('/home/alice/public_html/shop')}?confirm=true&database=true`);
    expect(foreign.status).toBe(200);
    expect(foreign.body.data).toMatchObject({ removed: true, database: null });
    expect(calls('db.database.drop')).toHaveLength(0);
    const blog = await del(`/wordpress/${installIdOf(BLOG)}?confirm=true&database=true`);
    expect(blog.status).toBe(200);
    expect(blog.body.data).toMatchObject({ removed: true, database: 'alice_wp', dbUser: 'alice_wp' });
    expect(calls('db.user.drop').at(-1).args.user).toBe('alice_wp');
    expect(calls('db.database.drop').at(-1).args.name).toBe('alice_wp');
    expect(audits('panel.wp.remove')).toHaveLength(3);
    expect((await get('/wordpress')).body.data).toEqual([]);
    expect((await del(`/wordpress/${installIdOf(BLOG)}?confirm=true`)).status).toBe(404);
  });

  it('is gated by the plan feature', async () => {
    db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.wordpress', json('false')) WHERE username = 'alice'`).run();
    try {
      const res = await get('/wordpress');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('feature_disabled');
      expect((await post('/wordpress', install)).status).toBe(403);
    } finally { db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.wordpress', json('true')) WHERE username = 'alice'`).run(); }
  });
});
