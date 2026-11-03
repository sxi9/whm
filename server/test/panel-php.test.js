import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';

const VERSIONS = { versions: [{ id: 'ea-php83', label: 'PHP 8.3', version: '8.3.4', binary: '/opt/php83/bin/php', iniPath: '/opt/php83/etc/php.ini' }, { id: 'ea-php74', label: 'PHP 7.4', version: '7.4.33', binary: '/opt/php74/bin/php', iniPath: '/opt/php74/etc/php.ini' }], defaultId: 'ea-php83' };

function phpAgent() {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['php', 'php-fpm'].includes(n)])),
    'pkg.php.versions': () => VERSIONS,
    'pkg.detect': () => ({ family: 'debian', php: { versions: [] } }),
    'pkg.php.userini.read': ({ docroot }) => ({ path: `${docroot}/.user.ini`, exists: true, directives: { memory_limit: '128M' }, content: 'memory_limit=128M\n' }),
    'pkg.php.userini.write': ({ docroot, directives }) => ({ path: `${docroot}/.user.ini`, directives: { memory_limit: '128M', ...directives } }),
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
  };
}

function setPlan(app, username, patch) {
  const plan = JSON.parse(app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username).plan_snapshot_json || '{}');
  const next = typeof patch === 'function' ? patch(plan) : { ...plan, ...patch };
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(next), username);
}

describe('Customer panel: PHP', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  const db = () => app.ctx.db;
  const row = (sql, ...args) => db().prepare(sql).get(...args);
  const names = () => app.agent.calls.map((c) => c.name);

  beforeAll(async () => {
    app = await createTestApp({ agent: phpAgent() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', provision: { dns: false, mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', provision: { dns: false, mail: false } }).expect(201);
    const aliceId = row('SELECT id FROM accounts WHERE username = ?', 'alice').id;
    db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'blog.alice.com', 'sub', '/home/alice/public_html/blog')").run(aliceId);
    db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'park.alice.example', 'parked', '/home/alice/public_html')").run(aliceId);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('offers the installed versions as a plain dropdown, never the root payload', async () => {
    const res = await alice.get('/php/versions').expect(200);
    expect(res.body.data.versions.map((v) => v.id)).toEqual(['ea-php83', 'ea-php74']);
    expect(res.body.data.versions[0]).not.toHaveProperty('binary');
    expect(res.body.data.versions[0]).not.toHaveProperty('iniPath');
    expect(res.body.data).toMatchObject({ defaultId: 'ea-php83', restricted: false });
  });

  it('restricts the choice to plan.php_versions when the package lists any', async () => {
    setPlan(app, 'alice', { php_versions: ['ea-php83'] });
    const res = await alice.get('/php/versions').expect(200);
    expect(res.body.data.versions.map((v) => v.id)).toEqual(['ea-php83']);
    expect(res.body.data.restricted).toBe(true);
    const put = await alice.put('/php/domains/alice.com', { version: 'ea-php74' });
    expect(put.status).toBe(422);
    expect(row('SELECT php_version FROM account_domains WHERE domain = ?', 'alice.com').php_version).toBeNull();
    setPlan(app, 'alice', (plan) => { const next = { ...plan }; delete next.php_versions; return next; });
  });

  it('lists the account\'s web hostnames only', async () => {
    const res = await alice.get('/php/domains').expect(200);
    expect(res.body.data.domains.map((d) => d.domain).sort()).toEqual(['alice.com', 'blog.alice.com', 'park.alice.example'].sort());
    expect(res.body.data.domains.every((d) => !('account' in d))).toBe(true);
    const other = await bob.get('/php/domains').expect(200);
    expect(other.body.data.domains.map((d) => d.domain)).toEqual(['bob.com']);
  });

  it('sets a version on own web hostnames and refuses foreign, parked or unknown ones', async () => {
    const res = await alice.put('/php/domains/blog.alice.com', { version: 'ea-php74' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ domain: 'blog.alice.com', phpVersion: 'ea-php74' });
    expect(row('SELECT php_version FROM account_domains WHERE domain = ?', 'blog.alice.com').php_version).toBe('ea-php74');
    expect(row("SELECT 1 AS x FROM audit_log WHERE action = 'panel.php.version' AND target = 'alice'")).toBeTruthy();
    expect((await alice.put('/php/domains/bob.com', { version: 'ea-php74' })).status).toBe(404);
    expect((await bob.put('/php/domains/alice.com', { version: 'ea-php74' })).status).toBe(404);
    expect((await alice.put('/php/domains/park.alice.example', { version: 'ea-php74' })).status).toBe(404);
    expect((await alice.put('/php/domains/alice.com', { version: 'ea-php99' })).status).toBe(422);
    expect((await alice.put('/php/domains/alice.com', { version: '../x' })).status).toBe(422);
    expect(row('SELECT php_version FROM account_domains WHERE domain = ?', 'bob.com').php_version).toBeNull();
    const inherit = await alice.put('/php/domains/blog.alice.com', { version: null }).expect(200);
    expect(inherit.body.data.phpVersion).toBeNull();
    expect(row('SELECT php_version FROM account_domains WHERE domain = ?', 'blog.alice.com').php_version).toBeNull();
  });

  it('reads and writes .user.ini through the owner-enforced delegate', async () => {
    const read = await alice.get('/php/domains/alice.com/ini').expect(200);
    expect(read.body.data).toMatchObject({ domain: 'alice.com', directives: { memory_limit: '128M' } });
    expect(app.agent.callsTo('pkg.php.userini.read')[0].args).toEqual({ docroot: '/home/alice/public_html', owner: 'alice' });
    const write = await alice.put('/php/domains/alice.com/ini', { directives: { upload_max_filesize: '64M', display_errors: null } });
    expect(write.status, JSON.stringify(write.body)).toBe(200);
    expect(app.agent.callsTo('pkg.php.userini.write')[0].args).toMatchObject({ docroot: '/home/alice/public_html', owner: 'alice', directives: { upload_max_filesize: '64M', display_errors: null } });
    expect((await alice.put('/php/domains/alice.com/ini', { directives: { 'bad key': '1' } })).status).toBe(422);
    expect((await alice.put('/php/domains/alice.com/ini', { directives: { memory_limit: '1\n2' } })).status).toBe(422);
    expect((await alice.put('/php/domains/alice.com/ini', { content: 'x' })).status).toBe(422);
    expect((await alice.get('/php/domains/bob.com/ini')).status).toBe(404);
    expect((await bob.put('/php/domains/alice.com/ini', { directives: { memory_limit: '1G' } })).status).toBe(404);
    expect(app.agent.callsTo('pkg.php.userini.write')).toHaveLength(1);
  });

  it('is gated by the phpversion feature', async () => {
    setPlan(app, 'alice', (plan) => ({ ...plan, features: { ...(plan.features || {}), phpversion: false } }));
    for (const [method, path] of [['get', '/php/versions'], ['get', '/php/domains'], ['put', '/php/domains/alice.com']]) {
      const res = await alice[method](path, { version: 'ea-php74' });
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('feature_disabled');
    }
    setPlan(app, 'alice', (plan) => ({ ...plan, features: { ...(plan.features || {}), phpversion: true } }));
  });
});
