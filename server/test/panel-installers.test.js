import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { installIdOf } from '../src/services/panel-software.js';
import { APPS, APP_IDS, JOB_INSTALL, INSTALL_HINT, randomTablePrefix, phpSatisfies } from '../src/services/panel-installers.js';

// A MariaDB-like host plus the web.app.* ops: databases, users and the trees
// found under the home live in memory, so the install jobs (Joomla through
// its CLI installer, Drupal through settings.php + the web installer link),
// their compensation and the removal are checked end to end through the real
// /api/panel session flow.
const PINS = {
  joomla: { name: 'Joomla', version: '6.2.0', url: 'https://github.com/joomla/joomla-cms/releases/download/6.2.0/Joomla_6.2.0-Stable-Full_Package.zip', sha256: 'e'.repeat(64), bytes: 34921686, format: 'zip', requires: { php: '8.3' } },
  drupal: { name: 'Drupal', version: '11.4.11', url: 'https://ftp.drupal.org/files/projects/drupal-11.4.11.tar.gz', sha256: 'f'.repeat(64), bytes: 23215761, format: 'tar', requires: { php: '8.3' } },
};
function hostAgent() {
  const state = { databases: new Map([['mysql', { system: true }]]), users: new Map([['root@localhost', {}]]), grants: new Map(), installs: new Map(), requirements: { php: true, phpVersion: '8.5.1', phpMysql: true, unzip: true, tar: true, asUser: true }, failAt: null, passwords: {}, stdin: null };
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
    'web.app.catalog': () => ({ apps: PINS }),
    'web.app.requirements': () => ({ ...state.requirements }),
    'web.app.discover': ({ usernames }) => ({ installs: [...state.installs.values()].filter((i) => usernames.includes(i.username)), missing: [] }),
    'web.app.fetch': ({ username, path, app }) => {
      guard(username, path);
      if (state.failAt === 'fetch') throw fail('checksum_mismatch', 'The downloaded Joomla 6.2.0 archive does not match its published SHA-256', { cleanup: `removed ${path}` });
      state.installs.set(path, { username, home: `/home/${username}`, app, path, version: PINS[app].version, dbName: null, dbUser: null, dbHost: null, dbPrefix: null, relative: path.replace(`/home/${username}/`, ''), configured: false, pendingInstaller: true });
      return { path, app, bytes: PINS[app].bytes, sha256: PINS[app].sha256, members: 13000, version: PINS[app].version, topLevel: ['index.php'] };
    },
    'web.app.joomla.install': ({ username, path, url, adminPassword, dbName, dbUser, dbPassword, dbHost, dbPrefix }) => {
      guard(username, path);
      if (state.failAt === 'joomla') throw fail('command_failed', "Joomla's installer did not finish: Could not connect to MySQL");
      const i = state.installs.get(path);
      if (!i || i.app !== 'joomla') throw fail('not_found', `${path} does not hold an unpacked Joomla tree`);
      Object.assign(i, { dbName, dbUser, dbHost, dbPrefix, configured: true, pendingInstaller: false, adminPassword, dbPassword });
      return { path, url, adminUrl: `${url}/administrator/`, version: '6.2.0', warning: null };
    },
    'web.app.drupal.configure': ({ username, path, dbName, dbUser, dbPassword, dbHost, dbPrefix, trustedHosts }) => {
      guard(username, path);
      const i = state.installs.get(path);
      if (!i || i.app !== 'drupal') throw fail('not_found', `${path} does not hold an unpacked Drupal tree`);
      Object.assign(i, { dbName, dbUser, dbHost, dbPrefix, configured: true, dbPassword, trustedHosts });
      return { path: `${path}/sites/default/settings.php`, mode: '0640', linted: true, syncDir: 'sites/default/files/config_x/sync', installPath: 'core/install.php', version: '11.4.11' };
    },
    'web.app.remove': ({ username, path, app, mode }) => {
      guard(username, path);
      const i = state.installs.get(path);
      if (!i || i.app !== app) throw fail('not_found', `${path} does not hold a ${app} installation`);
      state.installs.delete(path);
      return { path, app, mode, removed: mode === 'tree' ? [path.replace(`/home/${username}/`, '')] : ['public_html/index.php', 'public_html/administrator'] };
    },
  };
  const agent = createMockAgent(ops);
  agent.state = state;
  return agent;
}

describe('panel-installers helpers', () => {
  it('describes the catalog shape and the helpers', () => {
    expect(APP_IDS).toEqual(['joomla', 'drupal']);
    expect(APPS.joomla).toMatchObject({ dbBase: 'joomla', finish: 'cli', adminPath: 'administrator/', passwordMin: 12 });
    expect(APPS.drupal).toMatchObject({ dbBase: 'drupal', finish: 'web', installPath: 'core/install.php', fields: [] });
    expect(JOB_INSTALL).toBe('panel.app.install');
    expect(INSTALL_HINT).toMatch(/php-mysql/);
    for (let i = 0; i < 20; i++) expect(randomTablePrefix()).toMatch(/^[a-z][a-z0-9]{4}_$/);
    expect(phpSatisfies('8.5.1', '8.3')).toBe(true);
    expect(phpSatisfies('8.3.0', '8.3')).toBe(true);
    expect(phpSatisfies('8.2.29', '8.3')).toBe(false);
    expect(phpSatisfies('7.4.33', '8.3')).toBe(false);
    expect(phpSatisfies(null, '8.3')).toBe(true);
  });
});

describe('/api/panel/software/installers', () => {
  let app;
  let alice;
  let aliceCsrf;
  let rootCsrf;
  const db = () => app.ctx.db;
  const state = () => app.agent.state;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', rootCsrf).send(body);
  const audits = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC').all(action);
  const get = (p) => alice.get(`/api/panel/software/installers${p}`);
  const post = (p, body = {}) => alice.post(`/api/panel/software/installers${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const del = (p) => alice.delete(`/api/panel/software/installers${p}`).set('X-CSRF-Token', aliceCsrf);
  const setPlan = (key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.${key}', json(?)) WHERE username = 'alice'`).run(JSON.stringify(value));
  const calls = (name) => app.agent.calls.filter((c) => c.name === name);
  const CMS = '/home/alice/public_html/cms';
  const joomla = { domain: 'alice.com', path: 'cms', title: 'Alice writes', adminUser: 'alice.editor', adminEmail: 'alice@alice.com' };

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
  beforeEach(() => { app.agent.calls.length = 0; state().failAt = null; state().requirements = { php: true, phpVersion: '8.5.1', phpMysql: true, unzip: true, tar: true, asUser: true }; });

  it('lists the catalog with the pinned releases, the host requirements and the account sites', async () => {
    const res = await get('').expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ canInstall: true, prefix: 'alice_', requirements: { phpVersion: '8.5.1', phpMysql: true } });
    expect(res.body.meta.sites).toEqual([{ domain: 'alice.com', type: 'main', docroot: 'public_html' }, { domain: 'shop.alice.com', type: 'sub', docroot: 'public_html/shop' }]);
    const cat = res.body.meta.catalog;
    expect(cat.map((c) => c.id)).toEqual(['joomla', 'drupal']);
    expect(cat[0]).toMatchObject({ name: 'Joomla', version: '6.2.0', finish: 'cli', fields: ['title', 'adminUser', 'adminEmail', 'adminPassword'], passwordMin: 12, available: true, supported: true, canInstall: true, hint: null, sha256: 'e'.repeat(64) });
    expect(cat[0].url.startsWith('https://')).toBe(true);
    expect(cat[1]).toMatchObject({ name: 'Drupal', version: '11.4.11', finish: 'web', installPath: 'core/install.php', canInstall: true });
  });

  it('marks an app unsupported when the host PHP is older than the release needs', async () => {
    state().requirements = { php: true, phpVersion: '8.2.20', phpMysql: true, unzip: true, tar: true, asUser: true };
    const res = await get('').expect(200);
    expect(res.body.meta.canInstall).toBe(true);
    expect(res.body.meta.catalog[0]).toMatchObject({ supported: false, canInstall: false });
    expect(res.body.meta.catalog[0].hint).toMatch(/PHP 8\.3/);
    const refused = await post('/joomla', joomla);
    expect(refused.status).toBe(501);
    expect(calls('db.database.create')).toHaveLength(0);
  });

  it('validates the app, the body, the domain and the folder before anything is created', async () => {
    expect((await post('/wordpress', joomla)).status).toBe(422);
    expect((await post('/joomla', { ...joomla, path: '../etc' })).status).toBe(422);
    expect((await post('/joomla', { ...joomla, path: '/cms' })).status).toBe(422);
    expect((await post('/joomla', { ...joomla, adminUser: 'ad min' })).status).toBe(422);
    expect((await post('/joomla', { ...joomla, adminEmail: 'nope' })).status).toBe(422);
    expect((await post('/joomla', { ...joomla, title: 'a\nb' })).status).toBe(422);
    expect((await post('/joomla', { ...joomla, extra: 1 })).status).toBe(422);
    // Joomla needs a title, an administrator and a 12-character password.
    const missing = await post('/joomla', { domain: 'alice.com', path: 'cms' });
    expect(missing.status).toBe(422);
    expect(Object.keys(missing.body.error.fields).sort()).toEqual(['adminEmail', 'adminUser', 'title']);
    const short = await post('/joomla', { ...joomla, adminPassword: 'Ten-chars!' });
    expect(short.status).toBe(422);
    expect(short.body.error.fields.adminPassword[0]).toMatch(/12/);
    const foreign = await post('/joomla', { ...joomla, domain: 'bob.com' });
    expect(foreign.status).toBe(404);
    expect(calls('db.database.create')).toHaveLength(0);
    expect(db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'panel.app.install'").get().n).toBe(0);
  });

  it('answers 501 with the install hint when the host lacks php-mysql, unzip or tar', async () => {
    state().requirements = { php: true, phpVersion: '8.5.1', phpMysql: true, unzip: true, tar: false, asUser: true };
    const res = await post('/drupal', { domain: 'alice.com', path: 'd' });
    expect(res.status).toBe(501);
    expect(res.body.error.message).toContain('php-mysql');
    expect(calls('db.database.create')).toHaveLength(0);
  });

  it('refuses when the plan has no database left, before any database or job exists', async () => {
    setPlan('max_sql', 0);
    try {
      const res = await post('/joomla', joomla);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('limit_reached');
      expect(calls('db.database.create')).toHaveLength(0);
      expect(calls('web.app.fetch')).toHaveLength(0);
    } finally { setPlan('max_sql', null); }
  });

  it("installs Joomla through fetch → joomla.install as the account, with a generated password shown once and a random table prefix", async () => {
    const res = await post('/joomla', joomla);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ app: 'joomla', name: 'Joomla', version: '6.2.0', domain: 'alice.com', path: 'public_html/cms', url: 'http://alice.com/cms', adminUrl: 'http://alice.com/cms/administrator/', installUrl: null, database: 'alice_joomla', dbUser: 'alice_joomla', finish: 'cli', generatedPassword: true });
    expect(res.body.data.adminPassword).toMatch(/^.{20}$/);
    expect(res.body.data.id).toBe(installIdOf(CMS));
    const jobId = res.body.data.job.id;
    const job = await waitForJob(app.ctx, jobId);
    expect(job.status, JSON.stringify(job)).toBe('done');
    expect(job.result).toMatchObject({ app: 'joomla', url: 'http://alice.com/cms', adminUrl: 'http://alice.com/cms/administrator/', version: '6.2.0', database: 'alice_joomla', finish: 'cli', installUrl: null });
    expect(calls('db.database.create')[0].args.name).toBe('alice_joomla');
    expect(calls('db.user.create')[0].args).toMatchObject({ user: 'alice_joomla', hosts: ['localhost'] });
    expect(calls('web.app.fetch')[0].args).toEqual({ username: 'alice', path: CMS, app: 'joomla' });
    const ins = calls('web.app.joomla.install')[0].args;
    expect(ins).toMatchObject({ username: 'alice', path: CMS, url: 'http://alice.com/cms', title: 'Alice writes', adminUser: 'alice.editor', adminEmail: 'alice@alice.com', dbName: 'alice_joomla', dbUser: 'alice_joomla', dbHost: 'localhost' });
    expect(ins.dbPrefix).toMatch(/^[a-z][a-z0-9]{4}_$/);
    expect(ins.dbPassword).toBe(state().passwords.alice_joomla);
    expect(ins.adminPassword).toBe(res.body.data.adminPassword);
    // Secrets stay encrypted in the job record and never reach the account's job view or the audit.
    const raw = db().prepare('SELECT params_json FROM jobs WHERE id = ?').get(jobId).params_json;
    expect(raw).not.toContain(res.body.data.adminPassword);
    expect(raw).not.toContain(state().passwords.alice_joomla);
    const seen = await get(`/jobs/${jobId}`).expect(200);
    expect(seen.body.data.params.adminPasswordEnc).toBeUndefined();
    expect(seen.body.data.params.dbPasswordEnc).toBeUndefined();
    expect(seen.body.data.params).toMatchObject({ app: 'joomla', domain: 'alice.com', rel: 'public_html/cms' });
    expect(audits('panel.app.install')[0]).toMatchObject({ principal: 'alice', target: 'alice' });
    expect(String(audits('panel.app.install')[0].args_redacted)).not.toContain(res.body.data.adminPassword);
    expect(audits('panel.app.install.done')).toHaveLength(1);
    const list = await get('').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: installIdOf(CMS), app: 'joomla', name: 'Joomla', path: 'public_html/cms', domain: 'alice.com', under: 'cms', version: '6.2.0', database: 'alice_joomla', databaseOwned: true, configured: true, isDocroot: false, installUrl: null });
    expect(list.body.data[0].abs).toBeUndefined();
    expect((await post('/joomla', joomla)).status).toBe(409);
    expect((await post('/drupal', { domain: 'alice.com', path: 'cms' })).status).toBe(409);
    const dbs = await alice.get('/api/panel/databases').expect(200);
    expect(dbs.body.data.map((d) => d.name)).toContain('alice_joomla');
  });

  it("another account's job is 404 and the stream answers the snapshot", async () => {
    const jobId = db().prepare("SELECT id FROM jobs WHERE type = 'panel.app.install' ORDER BY id DESC LIMIT 1").get().id;
    await rootPost('/api/panel/admin/accounts/bob/password', { password: 'Bob-Passw0rd!!' }).expect(200);
    const bob = request.agent(app.ctx.app);
    await bob.post('/api/auth/login').send({ username: 'bob', password: 'Bob-Passw0rd!!' }).expect(200);
    expect((await bob.get(`/api/panel/software/installers/jobs/${jobId}`)).status).toBe(404);
    const stream = await get(`/jobs/${jobId}/stream`).buffer(true).parse((res, cb) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => cb(null, s)); });
    expect(stream.status).toBe(200);
    expect(stream.body).toContain('"type":"snapshot"');
    expect(stream.body).not.toContain('PasswordEnc');
  });

  it('installs Drupal by writing settings.php and handing over to its web installer, without an administrator form', async () => {
    const res = await post('/drupal', { domain: 'shop.alice.com', path: '' });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ app: 'drupal', version: '11.4.11', path: 'public_html/shop', url: 'http://shop.alice.com', installUrl: 'http://shop.alice.com/core/install.php', adminUrl: 'http://shop.alice.com/user/login', database: 'alice_drupal', dbUser: 'alice_drupal', finish: 'web' });
    expect(res.body.data.adminPassword).toBeUndefined();
    expect(res.body.data.generatedPassword).toBeUndefined();
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status, JSON.stringify(job)).toBe('done');
    expect(job.result).toMatchObject({ app: 'drupal', installUrl: 'http://shop.alice.com/core/install.php', version: '11.4.11', finish: 'web' });
    expect(job.result.note).toContain('core/install.php');
    const cfg = calls('web.app.drupal.configure')[0].args;
    expect(cfg).toMatchObject({ username: 'alice', path: '/home/alice/public_html/shop', dbName: 'alice_drupal', dbUser: 'alice_drupal', dbHost: 'localhost', dbPrefix: '', trustedHosts: ['shop.alice.com', 'www.shop.alice.com'] });
    expect(cfg.dbPassword).toBe(state().passwords.alice_drupal);
    expect(calls('web.app.joomla.install')).toHaveLength(0);
    const list = await get('').expect(200);
    const row = list.body.data.find((r) => r.app === 'drupal');
    expect(row).toMatchObject({ path: 'public_html/shop', isDocroot: true, database: 'alice_drupal', databaseOwned: true, installUrl: 'http://shop.alice.com/core/install.php' });
  });

  it('takes the next free database name, and a failed install drops the files, the user and the database again', async () => {
    state().failAt = 'joomla';
    const res = await post('/joomla', { ...joomla, path: 'news', adminPassword: 'Chosen-Passw0rd!' });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ database: 'alice_joomla2', dbUser: 'alice_joomla2', generatedPassword: false, path: 'public_html/news' });
    expect(res.body.data.adminPassword).toBeUndefined();
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('Could not connect');
    expect(calls('web.app.remove')[0].args).toEqual({ username: 'alice', path: '/home/alice/public_html/news', app: 'joomla', mode: 'tree' });
    expect(calls('db.user.drop')[0].args.user).toBe('alice_joomla2');
    expect(calls('db.database.drop')[0].args.name).toBe('alice_joomla2');
    expect(state().databases.has('alice_joomla2')).toBe(false);
    expect(audits('panel.app.install.failed')).toHaveLength(1);
    expect((await get('')).body.data).toHaveLength(2);
    // A checksum failure inside fetch: the agent cleaned up itself, the database still goes, the names are free again.
    state().failAt = 'fetch';
    const again = await post('/joomla', { ...joomla, path: 'news' });
    expect(again.body.data.database).toBe('alice_joomla2');
    const j2 = await waitForJob(app.ctx, again.body.data.job.id);
    expect(j2.status).toBe('failed');
    expect(j2.error).toMatch(/SHA-256/);
    expect(calls('web.app.remove')).toHaveLength(1);
    expect(calls('db.database.drop').at(-1).args.name).toBe('alice_joomla2');
  });

  it('removes an installation, with its database only when asked and owned, and never without confirm', async () => {
    const id = installIdOf(CMS);
    expect((await del(`/${id}`)).status).toBe(422);
    expect((await del(`/${id}?confirm=yes`)).status).toBe(422);
    const kept = await del(`/${id}?confirm=true`);
    expect(kept.status).toBe(200);
    expect(kept.body.data).toMatchObject({ app: 'joomla', removed: true, database: null, databaseKept: 'alice_joomla' });
    expect(calls('web.app.remove')[0].args).toEqual({ username: 'alice', path: CMS, app: 'joomla', mode: 'tree' });
    expect(state().databases.has('alice_joomla')).toBe(true);
    // A foreign database named in the configuration is left alone even with database=true.
    state().installs.set('/home/alice/public_html/old', { username: 'alice', home: '/home/alice', app: 'joomla', path: '/home/alice/public_html/old', version: '5.4.0', dbName: 'bob_joomla', dbUser: 'bob_joomla', dbHost: 'localhost', dbPrefix: 'jos_', relative: 'public_html/old', configured: true, pendingInstaller: false });
    const foreign = await del(`/${installIdOf('/home/alice/public_html/old')}?confirm=true&database=true`);
    expect(foreign.status).toBe(200);
    expect(foreign.body.data).toMatchObject({ removed: true, database: null });
    expect(calls('db.database.drop')).toHaveLength(0);
    const shop = await del(`/${installIdOf('/home/alice/public_html/shop')}?confirm=true&database=true`);
    expect(shop.status).toBe(200);
    expect(shop.body.data).toMatchObject({ app: 'drupal', removed: true, database: 'alice_drupal', dbUser: 'alice_drupal' });
    expect(calls('web.app.remove').at(-1).args).toEqual({ username: 'alice', path: '/home/alice/public_html/shop', app: 'drupal', mode: 'entries' });
    expect(calls('db.user.drop').at(-1).args.user).toBe('alice_drupal');
    expect(calls('db.database.drop').at(-1).args.name).toBe('alice_drupal');
    expect(audits('panel.app.remove')).toHaveLength(3);
    expect((await get('')).body.data).toEqual([]);
    expect((await del(`/${id}?confirm=true`)).status).toBe(404);
  });

  it('is gated by the plan feature, and WordPress keeps its own routes', async () => {
    db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.installers', json('false')) WHERE username = 'alice'`).run();
    try {
      const res = await get('');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('feature_disabled');
      expect((await post('/joomla', joomla)).status).toBe(403);
    } finally { db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.installers', json('true')) WHERE username = 'alice'`).run(); }
    expect((await alice.get('/api/panel/software/wordpress')).status).not.toBe(404);
  });
});
