import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { ACL_GROUPS, ACL_KEYS } from '../src/services/resellers.js';

// A host with user tooling but no Exim: emailing resellers must answer 501
// until the mail server is installed; everything else is DB-backed.
function hostAgent({ exim = false } = {}) {
  const bins = { useradd: true, usermod: true, userdel: true, chpasswd: true, systemctl: true, exim4: exim };
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(bins[n])])),
    'mail.sendmail': ({ from, to }) => ({ from, to, accepted: true }),
  });
}

describe('ACL catalog', () => {
  it('has unique keys grouped like WHM and includes root access', () => {
    expect(new Set(ACL_KEYS).size).toBe(ACL_KEYS.length);
    expect(ACL_GROUPS.map((g) => g.key)).toContain('root');
    expect(ACL_KEYS).toContain('all');
    expect(ACL_KEYS).toContain('create-acct');
  });
});

describe('Resellers API', () => {
  let app;
  let csrf;
  let reseller;
  let resellerHttp;
  let resellerCsrf;

  const post = (path, body = {}) => app.http.post(`/api/resellers${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body = {}) => app.http.put(`/api/resellers${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/resellers${path}`).set('X-CSRF-Token', csrf);
  const get = (path) => app.http.get(`/api/resellers${path}`);
  const rget = (path) => resellerHttp.get(`/api/resellers${path}`);
  const rpost = (path, body = {}) => resellerHttp.post(`/api/resellers${path}`).set('X-CSRF-Token', resellerCsrf).send(body);
  const rput = (path, body = {}) => resellerHttp.put(`/api/resellers${path}`).set('X-CSRF-Token', resellerCsrf).send(body);

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    csrf = await app.login();
    reseller = await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', owner: 'resell1', contactEmail: 'bob@bob.com' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.com', contactEmail: 'carol@carol.com' }).expect(201);
    app.ctx.db.prepare('INSERT INTO ip_addresses (address, family, netmask, interface, is_main) VALUES (?, 4, ?, ?, ?)').run('203.0.113.10', '255.255.255.0', 'eth0', 1);
    app.ctx.db.prepare('INSERT INTO ip_addresses (address, family, netmask, interface, is_main) VALUES (?, 4, ?, ?, ?)').run('203.0.113.11', '255.255.255.0', 'eth0', 0);
    app.ctx.db.prepare('INSERT INTO ip_addresses (address, family, netmask, interface, is_main) VALUES (?, 4, ?, ?, ?)').run('203.0.113.12', '255.255.255.0', 'eth0', 0);
    app.ctx.db.prepare('INSERT INTO ip_addresses (address, family, netmask, interface, is_main, reserved) VALUES (?, 4, ?, ?, 0, 1)').run('203.0.113.13', '255.255.255.0', 'eth0');
    app.ctx.settings.set('basic.shared_ip', '203.0.113.10');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
    app.ctx.jobs.start();
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  describe('Reseller Center', () => {
    it('serves the catalog (ACL groups, presets, packages, addresses, candidates)', async () => {
      const res = await get('/catalog').expect(200);
      expect(res.body.data.aclGroups.map((g) => g.key)).toEqual(ACL_GROUPS.map((g) => g.key));
      expect(res.body.data.aclLists.map((l) => l.name)).toEqual(expect.arrayContaining(['standard', 'minimal']));
      expect(res.body.data.packages.length).toBeGreaterThan(0);
      expect(res.body.data.addresses.map((a) => a.address)).toEqual(['203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.13']);
      expect(res.body.data.candidateAccounts.map((a) => a.username)).toEqual(['alice', 'bob', 'carol']);
      expect(res.body.data.owners.map((o) => o.username)).toEqual(['root', 'resell1']);
      expect(res.body.data.mail.available).toBe(false);
    });

    it('creates a reseller from an existing account, taking ownership and a generated password', async () => {
      const res = await post('/', { username: 'alice', fromAccount: true, maxAccounts: 5, maxDiskMb: 20480, aclList: 'standard' }).expect(201);
      expect(res.body.data).toMatchObject({ username: 'alice', role: 'reseller', email: 'alice@alice.com', configured: true, suspended: false, account: { username: 'alice', domain: 'alice.com' } });
      expect(res.body.data.limits).toMatchObject({ max_accounts: 5, max_disk_mb: 20480, max_bandwidth_mb: null, allowed_packages: [] });
      expect(res.body.data.acls).toContain('create-acct');
      expect(res.body.data.initialPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(res.body.data.usage.accounts).toBe(1);
      const acct = app.ctx.db.prepare('SELECT owner_id FROM accounts WHERE username = ?').get('alice');
      expect(acct.owner_id).toBe(res.body.data.id);
      expect(app.ctx.db.prepare('SELECT must_change_password FROM users WHERE username = ?').get('alice').must_change_password).toBe(1);
      expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'reseller.create' AND target = 'alice'").get()).toBeTruthy();
    });

    it('creates a standalone reseller with explicit ACLs and refuses duplicates and root', async () => {
      const res = await post('/', { username: 'standalone', password: 'Stand-Alone-1!', email: 'sa@example.com', acls: ['list-accts', 'create-acct'] }).expect(201);
      expect(res.body.data.acls).toEqual(['create-acct', 'list-accts']);
      expect(res.body.data.initialPassword).toBeUndefined();
      expect(res.body.data.account).toBeNull();
      await post('/', { username: 'standalone', password: 'Stand-Alone-1!' }).expect(409);
      await post('/', { username: 'root', password: 'Stand-Alone-1!' }).expect(400);
      await post('/', { username: 'nobody-here' }).expect(422);
      await post('/', { username: 'ghost', fromAccount: true }).expect(404);
      await post('/', { username: 'x', password: 'Stand-Alone-1!', acls: ['not-an-acl'] }).expect(422);
      await post('/', { username: 'x', password: 'Stand-Alone-1!', extra: 1 }).expect(422);
      const login = await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'standalone', password: 'Stand-Alone-1!' });
      expect(login.status).toBe(200);
      expect(login.body.data.user.role).toBe('reseller');
    });

    it('lists resellers with usage and lets a reseller read only itself', async () => {
      const res = await get('/?sort=username').expect(200);
      expect(res.body.data.map((r) => r.username)).toEqual(['alice', 'resell1', 'standalone']);
      expect(res.body.data.find((r) => r.username === 'resell1')).toMatchObject({ configured: false, usage: { accounts: 1 }, acl_count: 0 });
      const mine = await rget('/resell1').expect(200);
      expect(mine.body.data.username).toBe('resell1');
      await rget('/alice').expect(403);
      await rget('/').expect(403);
      await rget('/catalog').expect(403);
      await get('/nobody').expect(404);
    });

    it('updates limits, packages, nameservers and shared IP', async () => {
      const res = await put('/resell1', { maxAccounts: 2, maxDiskMb: 4096, oversellDisk: false, allowedPackages: ['default'], nameservers: ['ns1.resell1.com', 'ns2.resell1.com'], ownsNameservers: true, sharedIp: '203.0.113.11', notes: 'test' }).expect(200);
      expect(res.body.data.limits).toMatchObject({ max_accounts: 2, max_disk_mb: 4096, allowed_packages: ['default'], nameservers: ['ns1.resell1.com', 'ns2.resell1.com'], owns_nameservers: true, shared_ip: '203.0.113.11', notes: 'test' });
      expect(res.body.data.configured).toBe(true);
      await put('/resell1', { allowedPackages: ['no-such-package'] }).expect(422);
      await put('/resell1', { sharedIp: '198.51.100.1' }).expect(422);
      await put('/resell1', { maxAccounts: -1 }).expect(422);
      await rput('/resell1', { maxAccounts: 100 }).expect(403);
    });
  });

  describe('Edit Reseller Nameservers and Privileges', () => {
    it('sets ACLs from a list or explicitly and manages saved ACL lists', async () => {
      const res = await put('/resell1/privileges', { aclList: 'minimal', nameservers: ['ns1.resell1.com'] }).expect(200);
      expect(res.body.data.acls).toEqual(['acct-summary', 'list-accts', 'passwd', 'show-bandwidth', 'status']);
      expect(res.body.data.limits.nameservers).toEqual(['ns1.resell1.com']);
      const explicit = await put('/resell1/privileges', { acls: ['list-accts', 'create-acct', 'viewglobalpackages', 'list-accts'] }).expect(200);
      expect(explicit.body.data.acls).toEqual(['create-acct', 'list-accts', 'viewglobalpackages']);
      await put('/resell1/privileges', { aclList: 'missing-list' }).expect(404);
      await put('/resell1/privileges', { acls: ['rm -rf'] }).expect(422);
      const saved = await put('/acl-lists/support', { acls: ['list-accts', 'passwd'] }).expect(200);
      expect(saved.body.data).toMatchObject({ name: 'support', acls: ['list-accts', 'passwd'], builtin: false });
      await put('/acl-lists/standard', { acls: ['list-accts'] }).expect(409);
      expect((await get('/acl-lists').expect(200)).body.data.map((l) => l.name)).toContain('support');
      await del('/acl-lists/standard').expect(409);
      await del('/acl-lists/support').expect(200);
      await del('/acl-lists/support').expect(404);
      await put('/acl-lists/Bad Name', { acls: [] }).expect(422);
      expect(app.ctx.resellers.hasAcl({ id: reseller.id, role: 'reseller' }, 'create-acct')).toBe(true);
      expect(app.ctx.resellers.hasAcl({ id: reseller.id, role: 'reseller' }, 'kill-acct')).toBe(false);
      expect(app.ctx.resellers.hasAcl({ id: 1, role: 'root' }, 'kill-acct')).toBe(true);
    });
  });

  describe('reseller limits in account creation', () => {
    const create = (body) => resellerHttp.post('/api/accounts').set('X-CSRF-Token', resellerCsrf).send(body);

    it('enforces max accounts, disk, allowed packages and IP delegation', async () => {
      // resell1: max 2 accounts, 4096 MB disk, package list ['default'], owns bob already.
      const pkg = await app.http.post('/api/packages').set('X-CSRF-Token', csrf).send({ name: 'big', disk_mb: 8192 }).expect(201);
      expect(pkg.status).toBe(201);
      const tooBig = await create({ username: 'dave', domain: 'dave.com', package: 'big' });
      expect(tooBig.status).toBe(403);
      expect(tooBig.body.error.message).toMatch(/not available/);
      await put('/resell1', { allowedPackages: [] }).expect(200);
      const overDisk = await create({ username: 'dave', domain: 'dave.com', package: 'big' });
      expect(overDisk.status).toBe(409);
      expect(overDisk.body.error).toMatchObject({ code: 'reseller_limit' });
      expect(overDisk.body.error.message).toMatch(/over your reseller limit of 4096 MB/);
      await put('/resell1', { maxDiskMb: null }).expect(200);
      const badIp = await create({ username: 'dave', domain: 'dave.com', ip: '203.0.113.12' });
      expect(badIp.status).toBe(403);
      expect(badIp.body.error.message).toMatch(/not delegated/);
      const ok = await create({ username: 'dave', domain: 'dave.com' });
      expect(ok.status).toBe(201);
      // The reseller's shared IP is the default when none is given.
      expect(ok.body.data.ip).toBe('203.0.113.11');
      const full = await create({ username: 'erin', domain: 'erin.com' });
      expect(full.status).toBe(409);
      expect(full.body.error.message).toMatch(/limit of 2 account/);
    });

    it('blocks creation without the create-acct ACL and while privileges are suspended', async () => {
      await put('/resell1', { maxAccounts: null }).expect(200);
      await put('/resell1/privileges', { acls: ['list-accts'] }).expect(200);
      const denied = await create({ username: 'erin', domain: 'erin.com' });
      expect(denied.status).toBe(403);
      expect(denied.body.error.message).toMatch(/creating accounts/);
      await put('/resell1/privileges', { acls: ['list-accts', 'create-acct', 'viewglobalpackages'] }).expect(200);
      await post('/resell1/suspend', { reason: 'unpaid' }).expect(200);
      await post('/resell1/suspend').expect(409);
      // Suspension ends the reseller's sessions: the next request is unauthenticated
      // (a mutation first trips CSRF on the fresh session, a read is a plain 401).
      expect([401, 403]).toContain((await create({ username: 'erin', domain: 'erin.com' })).status);
      await rget('/resell1').expect(401);
      expect(app.ctx.resellers.createPolicy).toBeTypeOf('function');
      expect(() => app.ctx.resellers.createPolicy({ id: reseller.id, role: 'reseller' }, { pkgName: 'default', plan: {} })).toThrow(/suspended/);
      expect(app.ctx.db.prepare('SELECT suspended FROM users WHERE id = ?').get(reseller.id).suspended).toBe(1);
      expect(app.ctx.db.prepare('SELECT suspended FROM accounts WHERE username = ?').get('bob').suspended).toBe(0);
      const detail = await get('/resell1').expect(200);
      expect(detail.body.data).toMatchObject({ suspended: true, suspended_reason: 'unpaid' });
      await post('/resell1/unsuspend').expect(200);
      await post('/resell1/unsuspend').expect(409);
      expect(app.ctx.db.prepare('SELECT suspended FROM users WHERE id = ?').get(reseller.id).suspended).toBe(0);
      const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password }).expect(200);
      resellerCsrf = res.body.data.csrfToken;
    });
  });

  describe('IP delegation and shared IP', () => {
    it('delegates free addresses only, once, and reports them', async () => {
      const res = await put('/resell1/ips', { addresses: ['203.0.113.12'] }).expect(200);
      expect(res.body.data).toMatchObject({ delegated: ['203.0.113.12'], added: ['203.0.113.12'], removed: [] });
      await put('/resell1/ips', { addresses: ['203.0.113.10'] }).expect(400);
      await put('/resell1/ips', { addresses: ['203.0.113.13'] }).expect(409);
      await put('/resell1/ips', { addresses: ['198.51.100.9'] }).expect(422);
      await put('/resell1/ips', { addresses: ['not-an-ip'] }).expect(422);
      const other = await put('/alice/ips', { addresses: ['203.0.113.12'] });
      expect(other.status).toBe(409);
      expect(other.body.error.message).toMatch(/resell1/);
      const view = await rget('/resell1/ips').expect(200);
      expect(view.body.data.delegated).toEqual(['203.0.113.12']);
      expect(view.body.data.addresses.find((a) => a.address === '203.0.113.10')).toMatchObject({ is_main: true, delegatable: false, server_shared: true });
      expect(view.body.data.addresses.find((a) => a.address === '203.0.113.12')).toMatchObject({ delegated: true, delegatable: true });
      await rget('/alice/ips').expect(403);
      await rput('/resell1/ips', { addresses: [] }).expect(403);
      expect(app.ctx.resellers.delegatedAddresses(reseller.id).map((a) => a.address)).toEqual(['203.0.113.12']);
      const cleared = await put('/resell1/ips', { addresses: [] }).expect(200);
      expect(cleared.body.data.removed).toEqual(['203.0.113.12']);
    });

    it('sets and clears the reseller shared IP', async () => {
      const res = await put('/resell1/shared-ip', { sharedIp: '203.0.113.12' }).expect(200);
      expect(res.body.data).toMatchObject({ shared_ip: '203.0.113.12', effective_shared_ip: '203.0.113.12' });
      const none = await put('/resell1/shared-ip', { sharedIp: null }).expect(200);
      expect(none.body.data).toMatchObject({ shared_ip: null, effective_shared_ip: '203.0.113.10' });
      await put('/resell1/shared-ip', { sharedIp: '198.51.100.1' }).expect(422);
      await put('/resell1/shared-ip', {}).expect(422);
      await rput('/resell1/shared-ip', { sharedIp: null }).expect(403);
    });
  });

  describe('ownership', () => {
    it('moves one account and warns when the new owner is over its limits', async () => {
      await put('/alice', { maxAccounts: 1 }).expect(200);
      const res = await put('/ownership/carol', { owner: 'alice' }).expect(200);
      expect(res.body.data).toMatchObject({ username: 'carol', previous_owner: 'root', owner: 'alice' });
      expect(res.body.data.warnings[0]).toMatch(/over the limit of 1/);
      await put('/ownership/carol', { owner: 'alice' }).expect(409);
      await put('/ownership/carol', { owner: 'nobody' }).expect(404);
      await put('/ownership/ghost', { owner: 'root' }).expect(404);
      await rput('/ownership/carol', { owner: 'resell1' }).expect(403);
      expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'account.owner.change' AND target = 'carol'").get()).toBeTruthy();
      await put('/alice', { maxAccounts: null }).expect(200);
    });

    it('moves many accounts and reports per-account results', async () => {
      const res = await post('/ownership', { usernames: ['carol', 'dave', 'ghost'], owner: 'root' }).expect(200);
      expect(res.body.data).toMatchObject({ owner: 'root', changed: 2, failed: 1 });
      expect(res.body.data.results.find((r) => r.username === 'ghost')).toMatchObject({ changed: false, code: 'not_found' });
      await post('/ownership', { usernames: [], owner: 'root' }).expect(422);
      await post('/ownership', { usernames: ['carol'], owner: 'nobody' }).expect(404);
      const shown = await get('/resell1/accounts').expect(200);
      expect(shown.body.data.map((a) => a.username)).toEqual(['bob']);
      expect(shown.body.meta).toMatchObject({ total: 1, reseller: 'resell1' });
    });
  });

  describe('Show Reseller Accounts / usage', () => {
    it('lists a reseller\'s accounts with pagination and scopes it to the reseller itself', async () => {
      await put('/ownership/dave', { owner: 'resell1' }).expect(200);
      const res = await get('/resell1/accounts?sort=username&dir=desc&pageSize=1').expect(200);
      expect(res.body.data.map((a) => a.username)).toEqual(['dave']);
      expect(res.body.meta.total).toBe(2);
      const q = await get('/resell1/accounts?q=bob').expect(200);
      expect(q.body.data).toHaveLength(1);
      await get('/resell1/accounts?sort=DROP').expect(422);
      expect((await rget('/resell1/accounts').expect(200)).body.data).toHaveLength(2);
      await rget('/alice/accounts').expect(403);
    });

    it('reports usage per reseller and for everyone', async () => {
      app.ctx.db.prepare('UPDATE accounts SET disk_used_mb = 300, bandwidth_used_mb = 50 WHERE username = ?').run('bob');
      await put('/resell1', { maxDiskMb: 4096, maxBandwidthMb: 1000 }).expect(200);
      const res = await get('/resell1/usage').expect(200);
      expect(res.body.data.usage).toMatchObject({ accounts: 2, disk_used_mb: 300, bandwidth_used_mb: 50 });
      expect(res.body.data.limits).toMatchObject({ max_disk_mb: 4096, max_bandwidth_mb: 1000 });
      expect(res.body.data.accounts.find((a) => a.username === 'bob')).toMatchObject({ disk_used_mb: 300, suspended: false });
      const all = await get('/usage').expect(200);
      expect(all.body.data.map((r) => r.username).sort()).toEqual(['alice', 'resell1', 'standalone']);
      await app.http.post('/api/accounts/bob/suspend').set('X-CSRF-Token', csrf).send({ reason: 'test' }).expect(200);
      expect((await get('/resell1/usage').expect(200)).body.data.usage.suspended).toBe(1);
      await app.http.post('/api/accounts/bob/unsuspend').set('X-CSRF-Token', csrf).expect(200);
      await rget('/resell1/usage').expect(200);
      await rget('/alice/usage').expect(403);
      await rget('/usage').expect(403);
    });
  });

  describe('Email All Resellers', () => {
    it('answers 501 without Exim and lists recipients', async () => {
      const who = await get('/email/recipients').expect(200);
      expect(who.body.data.recipients.map((r) => r.username).sort()).toEqual(['alice', 'standalone']);
      expect(who.body.data.withoutEmail).toBe(1);
      const res = await post('/email', { subject: 'Hello', text: 'Hi {{username}}' });
      expect(res.status).toBe(501);
      expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'exim' });
      await post('/email', { subject: '', text: 'x' }).expect(422);
      await post('/email', { subject: 'multi\nline', text: 'x' }).expect(422);
      await rpost('/email', { subject: 'Hello', text: 'x' }).expect(403);
    });

    it('sends through the mail server once Exim is present', async () => {
      app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, ['useradd', 'usermod', 'userdel', 'chpasswd', 'systemctl', 'exim4'].includes(n)])));
      await app.ctx.capabilities.refresh();
      app.ctx.settings.set('mail.notification_from', 'whm@test.example.com');
      try {
        const res = await post('/email', { subject: 'Maintenance on {{hostname}}', text: 'Hello {{username}}, you own {{accounts}} account(s).' }).expect(202);
        expect(res.body.data.recipients).toBe(2);
        const job = await waitForJob(app.ctx, res.body.data.job.id);
        expect(job.status).toBe('done');
        expect(job.result.sent.sort()).toEqual(['alice', 'standalone']);
        const calls = app.agent.callsTo('mail.sendmail');
        expect(calls).toHaveLength(2);
        expect(calls.find((c) => c.args.to[0] === 'alice@alice.com').args.text).toContain('Hello alice, you own 1 account(s).');
      } finally {
        app.agent.reset('sys.binaries');
        app.agent.set('sys.binaries', hostAgent().op ? ({ names }) => Object.fromEntries(names.map((n) => [n, ['useradd', 'usermod', 'userdel', 'chpasswd', 'systemctl'].includes(n)])) : undefined);
        await app.ctx.capabilities.refresh();
      }
    });
  });

  describe('Reset Resellers', () => {
    it('strips privileges, moves accounts to root and keeps the login', async () => {
      await put('/resell1/ips', { addresses: ['203.0.113.12'] }).expect(200);
      const res = await post('/reset', { usernames: ['resell1', 'carol', 'ghost'] }).expect(200);
      expect(res.body.data.moved_to).toBe('root');
      // carol is a hosting account, not a panel user, so it is "missing" like ghost.
      expect(res.body.data.missing).toEqual(['carol', 'ghost']);
      expect(res.body.data.results.find((r) => r.username === 'resell1')).toMatchObject({ reset: true, accounts_moved: ['bob', 'dave'], ips_released: ['203.0.113.12'] });
      expect(res.body.data.results).toHaveLength(1);
      const user = app.ctx.db.prepare('SELECT role FROM users WHERE id = ?').get(reseller.id);
      expect(user.role).toBe('user');
      expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE owner_id = ?').get(reseller.id).n).toBe(0);
      expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM reseller_acls WHERE reseller_id = ?').get(reseller.id).n).toBe(0);
      expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM reseller_limits WHERE reseller_id = ?').get(reseller.id).n).toBe(0);
      expect(app.ctx.db.prepare('SELECT delegated_to FROM ip_addresses WHERE address = ?').get('203.0.113.12').delegated_to).toBeNull();
      await get('/resell1').expect(404);
      await post('/reset', {}).expect(422);
      // The reset user's sessions are gone (a mutation trips CSRF first, a read is 401).
      expect([401, 403]).toContain((await rpost('/reset', { all: true })).status);
      await rget('/resell1').expect(401);
      // A reset user can be promoted again, keeping its password.
      const again = await post('/', { username: 'resell1', acls: ['list-accts'] }).expect(201);
      expect(again.body.data.initialPassword).toBeUndefined();
      const all = await post('/reset', { all: true }).expect(200);
      expect(all.body.data.results.filter((r) => r.reset).map((r) => r.username).sort()).toEqual(['alice', 'resell1', 'standalone']);
      expect((await get('/').expect(200)).body.data).toEqual([]);
    });
  });
});
