import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { BUNDLED_PLUGINS, BUNDLED_DIR, readBundledManifest } from '../src/services/plugins-bundled.js';

const MON = 'net.whm.server-monitoring';
const AV = 'net.whm.imunifyav';
const WP = 'net.whm.wp-toolkit';

function pluginsAgent(state) {
  const grants = new Map();
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['mysql', 'mysqld', 'systemctl', ...(state.clamav ? ['clamscan'] : []), ...(state.wp ? ['wp', 'runuser'] : [])].includes(n)])),
    'sec.netdev.read': () => ({ ts: Date.now(), interfaces: [{ iface: 'lo', rxBytes: 1, txBytes: 1 }, { iface: 'eth0', rxBytes: state.rx += 6000, txBytes: 500, rxPackets: 1, txPackets: 1 }] }),
    'sec.imunify.detect': () => ({ installed: false, version: null }),
    'sec.clamav.detect': () => (state.clamav ? { installed: true, version: '1.0.5', signatures: 27000, databaseAgeSec: 3600, freshclam: true } : { installed: false }),
    'sec.clamav.scan': ({ usernames }) => ({ targets: usernames.map((u) => `/home/${u}`), infected: usernames[0] === 'bob' ? [{ file: '/home/bob/public_html/evil.php', signature: 'Php.Trojan.Agent-1' }] : [], errors: [], exitCode: 0 }),
    'web.wp.detect': () => { if (state.wp) return { installed: true, version: '2.10.0' }; throw Object.assign(new Error('WP-CLI (wp) is not installed on this server'), { agentError: true, code: 'capability_missing', details: {} }); },
    'web.wp.discover': ({ usernames }) => ({ installs: usernames.filter((u) => u === 'alice').map((u) => ({ username: u, home: `/home/${u}`, path: `/home/${u}/public_html`, relative: 'public_html', version: '6.5.2', dbName: 'alice_wp', tablePrefix: 'wp_' })), missing: [] }),
    'web.wp.inspect': ({ username, path: p }) => ({ username, path: p, version: '6.5.2', siteUrl: 'https://alice.com', coreUpdates: [], plugins: [], themes: [], maintenance: false, admins: [], errors: {} }),
    'web.wp.install': (args) => { state.installs.push(args); return { path: args.path, url: args.url, version: '6.6', steps: ['download', 'config', 'install'] }; },
    'db.detect': () => ({ installed: true, serverInstalled: true, engine: 'mariadb', binaries: { client: 'mysql', server: 'mysqld', runuser: true }, units: ['mariadb'], layout: { flavor: 'debian' }, postgres: { installed: false, dataDirs: [] } }),
    'db.version': () => ({ version: '10.11.6-MariaDB', engine: 'mariadb', major: '10.11.6', port: 3306 }),
    'db.ping': () => ({ ok: true, version: '10.11.6-MariaDB', user: 'root@localhost', ms: 1 }),
    'db.databases.list': () => [],
    'db.users.list': () => state.dbUsers.map((user) => ({ user, host: 'localhost', plugin: 'mysql_native_password', system: false })),
    'db.database.create': ({ name, charset, collation }) => { state.databases.push(name); return { name, charset, collation }; },
    'db.database.drop': ({ name }) => ({ name, dropped: true }),
    'db.user.create': ({ user, hosts }) => { state.dbUsers.push(user); return { user, hosts }; },
    'db.user.drop': ({ user }) => ({ user, dropped: ['localhost'] }),
    'db.grants.list': ({ user, host }) => ({ user, host, raw: [], grants: [...(grants.get(`${user}@${host}`) || new Map())].map(([database, privileges]) => ({ database, table: '*', privileges })) }),
    'db.grant': ({ user, host, database, privileges }) => { const m = grants.get(`${user}@${host}`) || new Map(); m.set(database, privileges); grants.set(`${user}@${host}`, m); return { user, host, database, privileges }; },
    'db.revoke': () => ({ ok: true }),
  });
}

describe('Plugins category: bundled ImunifyAV, Server Monitoring and WP Toolkit', () => {
  let app;
  let csrf;
  let resellerHttp;
  let resellerCsrf;
  let userHttp;
  let userCsrf;
  const state = { rx: 0, clamav: false, wp: false, installs: [], databases: [], dbUsers: [] };
  const post = (url, body = {}) => app.http.post(url).set('X-CSRF-Token', csrf).send(body);
  const get = (url) => app.http.get(url);
  const audit = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

  beforeAll(async () => {
    app = await createTestApp({ agent: pluginsAgent(state), overrides: { bundledPlugins: true } });
    csrf = await app.login();
    const reseller = await app.createUser('resell1', 'reseller');
    const user = await app.createUser('plainuser', 'user');
    await post('/api/accounts', { username: 'alice', domain: 'alice.com' }).expect(201);
    await post('/api/accounts', { username: 'bob', domain: 'bob.com', owner: 'resell1' }).expect(201);
    resellerHttp = request.agent(app.ctx.app);
    resellerCsrf = (await resellerHttp.post('/api/auth/login').send({ username: reseller.username, password: reseller.password })).body.data.csrfToken;
    userHttp = request.agent(app.ctx.app);
    userCsrf = (await userHttp.post('/api/auth/login').send({ username: user.username, password: user.password })).body.data.csrfToken;
    app.ctx.jobs.start();
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  describe('boot install', () => {
    it('ships three valid bundled plugins and installs + enables them at boot, idempotently', async () => {
      expect(BUNDLED_PLUGINS.map((p) => p.id)).toEqual([MON, AV, WP]);
      for (const p of BUNDLED_PLUGINS) {
        expect(fs.existsSync(path.join(BUNDLED_DIR, p.id, 'main.js'))).toBe(true);
        expect(readBundledManifest(p.id)).toMatchObject({ id: p.id, main: 'main.js' });
        expect(app.ctx.plugins.isLive(p.id)).toBe(true);
      }
      const rows = app.ctx.db.prepare('SELECT id, action, installed_version FROM bundled_plugins ORDER BY id').all();
      expect(rows.map((r) => r.action)).toEqual(['kept', 'kept', 'kept'].map(() => 'installed'));
      const again = await app.ctx.bundledPlugins.ensureInstalled();
      expect(again.map((r) => r.action)).toEqual(['kept', 'kept', 'kept']);
      expect(app.ctx.scheduler.listPrefix('plugin:').map((r) => r.name).sort()).toEqual([`plugin:${AV}:scheduled-scan`, `plugin:${MON}:sample`, `plugin:${WP}:discover`]);
      expect(audit('plugin.install')).toHaveLength(3);
      expect(audit('plugin.install')[0]).toMatchObject({ principal: 'system', role: 'root' });
    });

    it('a fresh panel without the opt-in keeps the host empty under the test runner', async () => {
      const bare = await createTestApp();
      try {
        expect(bare.ctx.plugins.list()).toEqual([]);
        expect(typeof bare.ctx.bundledPlugins.ensureInstalled).toBe('function');
      } finally { await bare.close(); }
    });
  });

  describe('GET /api/bundled-plugins', () => {
    it('lists state, versions and pages for root and resellers; plain users are refused', async () => {
      const res = await get('/api/bundled-plugins').expect(200);
      expect(res.body.data.map((p) => [p.id, p.state, p.enabled, p.canManage, p.pages.length])).toEqual([[MON, 'enabled', true, true, 2], [AV, 'enabled', true, true, 2], [WP, 'enabled', true, true, 2]]);
      const r = await resellerHttp.get('/api/bundled-plugins').expect(200);
      expect(r.body.data[0].canManage).toBe(false);
      await userHttp.get('/api/bundled-plugins').expect(403);
      const one = await get(`/api/bundled-plugins/${MON}`).expect(200);
      expect(one.body.data).toMatchObject({ id: MON, label: 'Server Monitoring', fnKey: 'plugins/server-monitoring', bundledVersion: '1.0.0', updateAvailable: false });
      await get('/api/bundled-plugins/net.whm.nope').expect(404);
      expect((await get('/api/bundled-plugins/evil;id')).status).toBe(422);
    });

    it('disable / enable / reinstall are root-only, audited and reflected by the host', async () => {
      await resellerHttp.post(`/api/bundled-plugins/${MON}/disable`).set('X-CSRF-Token', resellerCsrf).send({}).expect(403);
      const off = await post(`/api/bundled-plugins/${MON}/disable`).expect(200);
      expect(off.body.data).toMatchObject({ state: 'disabled', enabled: false, pages: [] });
      expect((await get(`/api/plugins/${MON}/status`)).status).toBe(404);
      expect(app.ctx.scheduler.listPrefix(`plugin:${MON}:`)).toEqual([]);
      const on = await post(`/api/bundled-plugins/${MON}/enable`).expect(200);
      expect(on.body.data).toMatchObject({ state: 'enabled', enabled: true });
      expect((await get(`/api/plugins/${MON}/status`)).status).toBe(200);
      const re = await post(`/api/bundled-plugins/${AV}/reinstall`).expect(200);
      expect(re.body.data).toMatchObject({ state: 'enabled', installedVersion: '1.0.0' });
      expect(audit('plugins.bundled.disable')).toHaveLength(1);
      expect(audit('plugins.bundled.enable')).toHaveLength(1);
      expect(audit('plugins.bundled.reinstall')).toHaveLength(1);
      expect(app.ctx.bundledPlugins.record(AV).action).toBe('reinstalled');
    });

    it('enable re-installs a plugin the operator uninstalled from Manage Plugins', async () => {
      await app.http.delete(`/api/plugins/manage/${WP}`).set('X-CSRF-Token', csrf).expect(200);
      expect((await get(`/api/bundled-plugins/${WP}`)).body.data).toMatchObject({ installed: false, state: 'not-installed' });
      const on = await post(`/api/bundled-plugins/${WP}/enable`).expect(200);
      expect(on.body.data).toMatchObject({ installed: true, state: 'enabled' });
    });
  });

  describe('Server Monitoring plugin through the host', () => {
    it('samples the host into the store with network rates, serves metrics and alerts, root only', async () => {
      await app.ctx.plugins.updateSettings(MON, { loadThreshold: 0.05 });
      const first = await post(`/api/plugins/manage/${MON}/jobs/sample`).expect(202);
      expect((await waitForJob(app.ctx, Number(first.body.data.job.id))).status).toBe('done');
      const second = await post(`/api/plugins/${MON}/sample`).expect(202);
      const job = await waitForJob(app.ctx, Number(second.body.data.jobId));
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ load1: 0.1, memPct: 25, diskPct: 20 });
      const metrics = await get(`/api/plugins/${MON}/metrics?range=1h`).expect(200);
      expect(metrics.body.data.points.length).toBe(2);
      expect(metrics.body.data.points[1].rxRate).toBeGreaterThan(0);
      expect(metrics.body.data.thresholds).toMatchObject({ load1: 0.05, memPct: 90 });
      const status = await get(`/api/plugins/${MON}/status`).expect(200);
      expect(status.body.data.sampleCount).toBe(2);
      expect(status.body.data.activeAlerts[0]).toMatchObject({ key: 'load1' });
      const alerts = await get(`/api/plugins/${MON}/alerts`).expect(200);
      expect(alerts.body.data[0]).toMatchObject({ metric: '1-minute load', state: 'active' });
      expect(app.agent.callsTo('sec.netdev.read').length).toBeGreaterThanOrEqual(2);
      expect(audit('plugin.agent.op').filter((r) => r.target === 'sec.netdev.read').length).toBeGreaterThanOrEqual(2);
      await resellerHttp.get(`/api/plugins/${MON}/status`).expect(403);
    });
  });

  describe('ImunifyAV plugin through the host', () => {
    it('reports the missing scanners with vendor instructions and answers 501 on scan', async () => {
      const status = await get(`/api/plugins/${AV}/status`).expect(200);
      expect(status.body.data).toMatchObject({ scanner: null, imunify: { installed: false }, clamav: { installed: false } });
      expect(status.body.data.install.steps.join(' ')).toMatch(/imav-deploy/);
      const scan = await post(`/api/plugins/${AV}/scan`, {});
      expect(scan.status).toBe(501);
      expect(scan.body.error.code).toBe('CAPABILITY_MISSING');
    });

    it('falls back to a ClamAV job over account homes when clamscan exists, records findings and audits', async () => {
      state.clamav = true;
      const scan = await post(`/api/plugins/${AV}/scan`, { usernames: ['alice', 'bob'] }).expect(202);
      expect(scan.body.data.scanner).toBe('clamav');
      const job = await waitForJob(app.ctx, Number(scan.body.data.jobId));
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ accounts: 2, infected: 1 });
      expect(app.agent.callsTo('sec.clamav.scan').map((c) => c.args.usernames[0])).toEqual(['alice', 'bob']);
      const findings = await get(`/api/plugins/${AV}/findings`).expect(200);
      expect(findings.body.data).toHaveLength(1);
      expect(findings.body.data[0]).toMatchObject({ username: 'bob', signature: 'Php.Trojan.Agent-1' });
      const results = await get(`/api/plugins/${AV}/results`).expect(200);
      expect(results.body.data.scanner).toBe('clamav');
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?").get(`plugin:${AV}:scan.clamav`).n).toBe(1);
      state.clamav = false;
    });
  });

  describe('WP Toolkit plugin through the host', () => {
    it('reports the WP-CLI install prompt, discovers sites and limits resellers to their accounts', async () => {
      const status = await get(`/api/plugins/${WP}/status`).expect(200);
      expect(status.body.data.wpcli.installed).toBe(false);
      expect(status.body.data.errors.wpcli).toMatch(/not installed/);
      expect(status.body.data.install.steps[0]).toMatch(/wp-cli\.phar/);
      const d = await post(`/api/plugins/${WP}/discover`, {}).expect(200);
      expect(d.body.data).toMatchObject({ accounts: 2, sites: 1, added: 1 });
      const sites = await get(`/api/plugins/${WP}/sites`).expect(200);
      expect(sites.body.data[0]).toMatchObject({ username: 'alice', path: '/home/alice/public_html', version: '6.5.2' });
      const mine = await resellerHttp.get(`/api/plugins/${WP}/sites`).expect(200);
      expect(mine.body.data).toEqual([]);
      await resellerHttp.get(`/api/plugins/${WP}/sites/${sites.body.data[0].id}`).expect(403);
      state.wp = true;
      const detail = await get(`/api/plugins/${WP}/sites/${sites.body.data[0].id}`).expect(200);
      expect(detail.body.data.inspection.siteUrl).toBe('https://alice.com');
    });

    it('one-click install: validation, ownership, database + user via ctx.databases and the install job', async () => {
      const bad = await post('/api/bundled-plugins/wp-toolkit/install', { username: 'alice', title: 'Blog', adminUser: 'ad min', adminPassword: 'short', dbName: 'Bad Name' });
      expect(bad.status).toBe(422);
      expect(Object.keys(bad.body.error.fields).sort()).toEqual(['adminPassword', 'adminUser', 'dbName']);
      const traversal = await post('/api/bundled-plugins/wp-toolkit/install', { username: 'alice', directory: '../etc', title: 'Blog', adminUser: 'admin', adminPassword: 'Str0ng-Passw0rd!', dbName: 'wp' });
      expect(traversal.status).toBe(400);
      await resellerHttp.post('/api/bundled-plugins/wp-toolkit/install').set('X-CSRF-Token', resellerCsrf).send({ username: 'alice', title: 'Blog', adminUser: 'admin', adminPassword: 'Str0ng-Passw0rd!', dbName: 'wp' }).expect(403);
      await userHttp.post('/api/bundled-plugins/wp-toolkit/install').set('X-CSRF-Token', userCsrf).send({ username: 'alice', title: 'Blog', adminUser: 'admin', adminPassword: 'Str0ng-Passw0rd!', dbName: 'wp' }).expect(403);
      const accounts = await resellerHttp.get('/api/bundled-plugins/wp-toolkit/accounts').expect(200);
      expect(accounts.body.data.map((a) => a.username)).toEqual(['bob']);

      const res = await post('/api/bundled-plugins/wp-toolkit/install', { username: 'alice', directory: 'blog', title: 'Alice Blog', adminUser: 'alice.admin', adminPassword: 'Str0ng-Passw0rd!', dbName: 'wp' }).expect(202);
      expect(res.body.data).toMatchObject({ path: '/home/alice/public_html/blog', url: 'https://alice.com/blog', database: 'alice_wp', dbUser: 'alice_wp' });
      expect(state.databases).toEqual(['alice_wp']);
      expect(state.dbUsers).toEqual(['alice_wp']);
      const job = await waitForJob(app.ctx, Number(res.body.data.job.id));
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ version: '6.6', url: 'https://alice.com/blog' });
      expect(state.installs).toHaveLength(1);
      expect(state.installs[0]).toMatchObject({ username: 'alice', path: '/home/alice/public_html/blog', dbName: 'alice_wp', dbUser: 'alice_wp', adminPassword: 'Str0ng-Passw0rd!' });
      expect(state.installs[0].dbPassword.length).toBeGreaterThanOrEqual(12);
      // Secrets never sit in the jobs table in clear text.
      const row = app.ctx.db.prepare('SELECT params_json FROM jobs WHERE id = ?').get(job.id);
      expect(row.params_json).not.toContain('Str0ng-Passw0rd!');
      expect(JSON.parse(row.params_json).adminPassword).not.toBe('Str0ng-Passw0rd!');
      const a = audit('plugins.wp.install');
      expect(a).toHaveLength(1);
      expect(a[0].args_redacted).not.toContain('Str0ng-Passw0rd!');
      const installs = await get('/api/bundled-plugins/wp-toolkit/installs').expect(200);
      expect(installs.body.data[0]).toMatchObject({ username: 'alice', status: 'done', db_name: 'alice_wp' });
      expect((await resellerHttp.get('/api/bundled-plugins/wp-toolkit/installs')).body.data).toEqual([]);
      const dup = await post('/api/bundled-plugins/wp-toolkit/install', { username: 'alice', directory: 'blog', title: 'Alice Blog', adminUser: 'admin', adminPassword: 'Str0ng-Passw0rd!', dbName: 'wp' });
      expect(dup.status).toBe(409);
    });

    it('a WordPress install fails cleanly when WP-CLI is missing and records the error', async () => {
      state.wp = false;
      app.agent.fail('web.wp.install', 'capability_missing', 'WP-CLI (wp) is not installed on this server');
      const res = await post('/api/bundled-plugins/wp-toolkit/install', { username: 'bob', title: 'Bob', adminUser: 'bob', adminPassword: 'Str0ng-Passw0rd!', dbName: 'site' }).expect(202);
      const job = await waitForJob(app.ctx, Number(res.body.data.job.id));
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/WP-CLI/);
      const row = app.ctx.db.prepare('SELECT status, error FROM wp_installs WHERE id = ?').get(res.body.data.installId);
      expect(row).toMatchObject({ status: 'failed' });
      app.agent.reset('web.wp.install');
    });
  });
});
