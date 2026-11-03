import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';

// A host with BIND: zones are written and reloaded through the mock, so the
// panel's "zone first, then docroot, then row" order can be asserted on calls.
function hostAgent() {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['named', 'rndc', 'named-checkzone', 'named-checkconf'].includes(n)])),
    'dns.layout': () => ({ installed: true, flavor: 'debian', zoneDir: '/etc/bind/zones', includeFile: '/etc/bind/named.conf.whm' }),
    'dns.zone.list': () => ({ installed: true, zones: [] }),
    'dns.zone.read': ({ domain }) => ({ domain, exists: false, body: null }),
    'dns.checkzone': ({ domain }) => ({ domain, ok: true, output: '', serial: 1 }),
    'dns.zone.write': ({ domain }) => ({ domain, path: `/etc/bind/zones/${domain}.db`, stanzaAdded: true, includeAdded: false }),
    'dns.zone.remove': ({ domain }) => ({ domain, removed: [`/etc/bind/zones/${domain}.db`], stanzaRemoved: true }),
    'dns.reload': ({ domain }) => ({ method: 'rndc', domain: domain ?? null, output: '' }),
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
    http, csrf,
    get: (p) => http.get(`/api/panel${p}`),
    post: (p, body = {}) => http.post(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    put: (p, body = {}) => http.put(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    del: (p) => http.delete(`/api/panel${p}`).set('X-CSRF-Token', csrf),
  };
}

function setPlan(app, username, patch) {
  const row = app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username);
  const plan = JSON.parse(row.plan_snapshot_json || '{}');
  const next = typeof patch === 'function' ? patch(plan) : { ...plan, ...patch };
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(next), username);
  return next;
}

const setFeature = (app, username, key, enabled) => setPlan(app, username, (plan) => ({ ...plan, features: { ...(plan.features || {}), [key]: enabled } }));

describe('Customer panel: domains', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  const db = () => app.ctx.db;
  const rows = (sql, ...args) => db().prepare(sql).all(...args);
  const row = (sql, ...args) => db().prepare(sql).get(...args);
  const names = () => app.agent.calls.map((c) => c.name);

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', ip: '203.0.113.5', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; app.agent.reset('files.mkdir'); });

  it('lists only the account\'s own hostnames with plan counts', async () => {
    const res = await alice.get('/domains').expect(200);
    expect(res.body.data.map((d) => d.domain)).toEqual(['alice.com']);
    expect(res.body.data[0]).toMatchObject({ type: 'main', docroot: '/home/alice/public_html' });
    expect(res.body.meta.counts).toMatchObject({ main: 1, addon: 0, sub: 0, parked: 0 });
    expect(res.body.meta.limits).toHaveProperty('max_addons');
  });

  it('refuses an admin session without an acting-as context', async () => {
    const res = await app.http.get('/api/panel/domains');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('panel_scope_required');
  });

  describe('addon domains', () => {
    it('counts the plan limit itself before touching DNS', async () => {
      setPlan(app, 'alice', { max_addons: 0 });
      const res = await alice.post('/domains/addon', { domain: 'shop.example' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('limit_reached');
      expect(names()).not.toContain('dns.zone.write');
      setPlan(app, 'alice', { max_addons: 5 });
    });

    it('honours the package feature flag', async () => {
      setFeature(app, 'alice', 'addondomains', false);
      const res = await alice.post('/domains/addon', { domain: 'shop.example' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('feature_disabled');
      setFeature(app, 'alice', 'addondomains', true);
    });

    it('creates the zone, the docroot as the account, the row and the vhost in that order', async () => {
      const res = await alice.post('/domains/addon', { domain: 'shop.example' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ domain: 'shop.example', type: 'addon', docroot: '/home/alice/public_html/shop.example', zone: { created: true } });
      expect(Array.isArray(res.body.meta.warnings)).toBe(true);
      const order = names();
      expect(order.indexOf('dns.zone.write')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('dns.zone.write')).toBeLessThan(order.indexOf('files.mkdir'));
      const mkdir = app.agent.callsTo('files.mkdir')[0];
      expect(mkdir.args).toEqual({ username: 'alice', path: '/home/alice/public_html/shop.example', mode: '0750' });
      expect(names()).not.toContain('fs.mkdir');
      const alicee = row('SELECT id, ip FROM accounts WHERE username = ?', 'alice');
      expect(row('SELECT * FROM account_domains WHERE domain = ?', 'shop.example')).toMatchObject({ account_id: alicee.id, type: 'addon', docroot: '/home/alice/public_html/shop.example' });
      expect(row('SELECT account_id FROM dns_zones WHERE domain = ?', 'shop.example')).toMatchObject({ account_id: alicee.id });
      expect(row('SELECT username, type FROM web_vhosts WHERE domain = ?', 'shop.example')).toMatchObject({ username: 'alice', type: 'addon' });
      expect(row('SELECT value FROM dns_records WHERE zone_id = (SELECT id FROM dns_zones WHERE domain = ?) AND type = ? AND name = ?', 'shop.example', 'A', '@')).toMatchObject({ value: '203.0.113.5' });
      expect(rows("SELECT * FROM audit_log WHERE action = 'panel.domains.addon.add' AND target = 'alice'")).toHaveLength(1);
    });

    it('refuses a hostname another account already uses, and its own twice', async () => {
      for (const domain of ['bob.com', 'shop.example', 'alice.com']) {
        const res = await alice.post('/domains/addon', { domain });
        expect(res.status, domain).toBe(409);
        expect(res.body.error.code).toBe('exists');
      }
      expect(names()).not.toContain('dns.zone.write');
    });

    it('refuses a hostname inside another account\'s zone or under another account\'s domain (no DNS/web/mail hijack)', async () => {
      setPlan(app, 'bob', { max_addons: 5, max_parked: 5 });
      setPlan(app, 'alice', { max_addons: 5, max_parked: 5 });
      for (const domain of ['www.alice.com', 'mail.alice.com', 'deep.sub.alice.com']) {
        const res = await bob.post('/domains/addon', { domain: 'x.shop.example' });
        expect(res.status, 'x.shop.example').toBe(409);
        const addon = await bob.post('/domains/addon', { domain });
        expect(addon.status, domain).toBe(409);
        expect(addon.body.error.code).toBe('exists');
      }
      // alice holds the zone shop.example (addon) and bob.com is bob's main domain: bob may not host under alice's, alice not under bob's.
      expect((await alice.post('/domains/addon', { domain: 'www.bob.com' })).status).toBe(409);
      expect((await alice.post('/domains/parked', { domain: 'mail.bob.com' })).body.error.code).toBe('exists');
      expect((await bob.post('/domains/parked', { domain: 'cdn.shop.example' })).body.error.code).toBe('exists');
      // The owner of the namespace may still add names inside it.
      const own = await alice.post('/domains/addon', { domain: 'www.shop.example' });
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      await alice.del('/domains/addon/www.shop.example?removeZone=true').expect(200);
      db().prepare("DELETE FROM audit_log WHERE args_redacted LIKE '%www.shop.example%'").run();
      expect(names().filter((n) => n === 'dns.zone.write')).toHaveLength(1);
      expect(row('SELECT 1 AS x FROM account_domains WHERE domain LIKE ? OR domain LIKE ?', '%.bob.com', '%.alice.com')).toBeUndefined();
      expect(row('SELECT 1 AS x FROM dns_zones WHERE domain IN (?, ?, ?, ?)', 'www.bob.com', 'mail.bob.com', 'www.alice.com', 'mail.alice.com')).toBeUndefined();
      expect(row('SELECT 1 AS x FROM mail_domains WHERE domain LIKE ? OR domain LIKE ?', '%.bob.com', '%.alice.com')).toBeUndefined();
      // The WHM delegate refuses the same for a non-root principal.
      const resellerUser = { id: 999, username: 'resell-x', role: 'reseller' };
      await expect(app.ctx.dns.ensureZoneForDomain('ftp.bob.com', { accountId: row('SELECT id FROM accounts WHERE username = ?', 'alice').id }, { user: resellerUser })).rejects.toMatchObject({ status: 409 });
    });

    it('explains a web server that is not installed in plain words', async () => {
      const res = await alice.post('/domains/addon', { domain: 'copy.example' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.web).toMatchObject({ applied: false, reason: 'capability_missing' });
      expect(res.body.meta.warnings).toContain('The web server is not installed on this server yet; the site is served as soon as it is.');
      expect(res.body.meta.warnings.join(' ')).not.toMatch(/capability_missing|php_missing|php_pool_failed/);
      await alice.del('/domains/addon/copy.example?removeZone=true').expect(200);
    });

    it('pins the document root under the home', async () => {
      for (const docroot of ['../etc', '/etc/passwd', '-rf', 'a/../../b', 'x\0y']) {
        const res = await alice.post('/domains/addon', { domain: 'pin.example', docroot });
        expect(res.status, docroot).toBe(422);
      }
      expect(names()).toEqual([]);
      const ok = await alice.post('/domains/addon', { domain: 'pin.example', docroot: 'sites/pin' }).expect(201);
      expect(ok.body.data.docroot).toBe('/home/alice/public_html/sites/pin');
      await alice.del('/domains/addon/pin.example').expect(200);
    });

    it('removes the zone it created when the docroot or the row fails', async () => {
      app.agent.fail('files.mkdir', 'command_failed', 'disk full');
      const res = await alice.post('/domains/addon', { domain: 'fail.example' });
      expect(res.status).toBe(500);
      expect(row('SELECT 1 AS x FROM account_domains WHERE domain = ?', 'fail.example')).toBeUndefined();
      expect(row('SELECT 1 AS x FROM dns_zones WHERE domain = ?', 'fail.example')).toBeUndefined();
      expect(names()).toContain('dns.zone.remove');
    });

    it('is invisible to another account of the same owner', async () => {
      const list = await bob.get('/domains').expect(200);
      expect(list.body.data.map((d) => d.domain)).toEqual(['bob.com']);
      const res = await bob.del('/domains/addon/shop.example');
      expect(res.status).toBe(404);
      expect(row('SELECT 1 AS x FROM account_domains WHERE domain = ?', 'shop.example')).toBeTruthy();
    });

    it('never removes public_html itself as a docroot', async () => {
      await alice.post('/domains/addon', { domain: 'dot.example', docroot: '.' }).expect(201);
      const res = await alice.del('/domains/addon/dot.example?removeDocroot=true').expect(200);
      expect(res.body.data.docroot).toMatchObject({ removed: false, reason: 'protected' });
      expect(names()).not.toContain('files.remove');
    });

    it('deletes the row, the zone and (on request) the docroot as the account', async () => {
      db().prepare("INSERT INTO mail_forwarders (account_id, domain, local_part, destination) VALUES ((SELECT id FROM accounts WHERE username = 'alice'), 'shop.example', 'sales', 'me@example.org')").run();
      const res = await alice.del('/domains/addon/shop.example?removeDocroot=true&removeZone=true');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ domain: 'shop.example', removed: true, zone: { removed: true }, docroot: { removed: true }, mail: { released: true, errors: [] } });
      expect(res.body.meta.warnings).toEqual([]);
      // Mail leaves with the hostname: host files first, then the rows.
      expect(app.agent.callsTo('vmail.passwd.purge').map((c) => c.args)).toEqual([{ domain: 'shop.example' }]);
      expect(names().indexOf('vmail.passwd.purge')).toBeLessThan(names().indexOf('files.remove'));
      expect(row('SELECT 1 AS x FROM mail_forwarders WHERE domain = ?', 'shop.example')).toBeUndefined();
      expect(row('SELECT 1 AS x FROM mail_domains WHERE domain = ?', 'shop.example')).toBeUndefined();
      expect(rows("SELECT * FROM audit_log WHERE action = 'panel.email.domain.release' AND target = 'alice' AND args_redacted LIKE '%shop.example%'")).toHaveLength(1);
      expect(row('SELECT 1 AS x FROM account_domains WHERE domain = ?', 'shop.example')).toBeUndefined();
      expect(row('SELECT 1 AS x FROM dns_zones WHERE domain = ?', 'shop.example')).toBeUndefined();
      expect(app.agent.callsTo('files.remove')[0].args).toEqual({ username: 'alice', paths: ['/home/alice/public_html/shop.example'] });
      expect(names()).not.toContain('fs.remove');
      expect(rows("SELECT * FROM audit_log WHERE action = 'panel.domains.addon.remove' AND target = 'alice' AND args_redacted LIKE '%shop.example%'")).toHaveLength(1);
    });

    it('a mail release that fails on the host is a warning, and the rows stay for root to release', async () => {
      await alice.post('/domains/addon', { domain: 'mailfail.example' }).expect(201);
      db().prepare("INSERT INTO mail_forwarders (account_id, domain, local_part, destination) VALUES ((SELECT id FROM accounts WHERE username = 'alice'), 'mailfail.example', 'x', 'me@example.org')").run();
      app.agent.fail('vmail.passwd.purge', 'command_failed', 'disk full');
      try {
        const res = await alice.del('/domains/addon/mailfail.example').expect(200);
        expect(res.body.data).toMatchObject({ domain: 'mailfail.example', removed: true, mail: { released: false } });
        expect(res.body.data.mail.errors).toEqual([{ op: 'vmail.passwd.purge', code: 'command_failed', message: 'disk full' }]);
        expect(res.body.meta.warnings).toEqual([expect.stringMatching(/^Mail: .*mailfail\.example.*vmail\.passwd\.purge.*release the domain$/)]);
        expect(row('SELECT 1 AS x FROM account_domains WHERE domain = ?', 'mailfail.example')).toBeUndefined();
        expect(row('SELECT account_id FROM mail_forwarders WHERE domain = ?', 'mailfail.example')).toBeTruthy();
        expect(JSON.parse(rows("SELECT args_redacted FROM audit_log WHERE action = 'panel.domains.addon.remove' AND args_redacted LIKE '%mailfail.example%'")[0].args_redacted)).toMatchObject({ mailReleased: false });
      } finally {
        app.agent.reset('vmail.passwd.purge');
        db().prepare('DELETE FROM mail_forwarders WHERE domain = ?').run('mailfail.example');
      }
    });
  });

  describe('subdomains', () => {
    it('creates <home>/public_html/<label> and the A record in the parent zone', async () => {
      const res = await alice.post('/domains/sub', { label: 'Blog', parent: 'alice.com' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ domain: 'blog.alice.com', type: 'sub', docroot: '/home/alice/public_html/blog', parent: 'alice.com', dns: { zone: 'alice.com', applied: true } });
      expect(app.agent.callsTo('files.mkdir')[0].args).toEqual({ username: 'alice', path: '/home/alice/public_html/blog', mode: '0750' });
      expect(row('SELECT docroot FROM account_domains WHERE domain = ?', 'blog.alice.com')).toEqual({ docroot: '/home/alice/public_html/blog' });
      expect(row('SELECT value FROM dns_records WHERE zone_id = (SELECT id FROM dns_zones WHERE domain = ?) AND type = ? AND name = ?', 'alice.com', 'A', 'blog')).toEqual({ value: '203.0.113.5' });
      expect(row('SELECT type FROM web_vhosts WHERE domain = ?', 'blog.alice.com')).toEqual({ type: 'sub' });
    });

    it('rejects foreign parents, bad labels, the plan limit and the feature flag', async () => {
      expect((await alice.post('/domains/sub', { label: 'x', parent: 'bob.com' })).status).toBe(404);
      expect((await alice.post('/domains/sub', { label: 'x', parent: 'blog.alice.com' })).status).toBe(404);
      for (const label of ['-bad', 'bad-', 'a b', 'x'.repeat(64), 'a.b']) expect((await alice.post('/domains/sub', { label, parent: 'alice.com' })).status, label).toBe(422);
      setPlan(app, 'alice', { max_subdomains: 1 });
      const limited = await alice.post('/domains/sub', { label: 'two', parent: 'alice.com' });
      expect(limited.status).toBe(409);
      expect(limited.body.error.code).toBe('limit_reached');
      setPlan(app, 'alice', { max_subdomains: 10 });
      setFeature(app, 'alice', 'subdomains', false);
      expect((await alice.post('/domains/sub', { label: 'two', parent: 'alice.com' })).body.error.code).toBe('feature_disabled');
      setFeature(app, 'alice', 'subdomains', true);
      expect(names()).toEqual([]);
    });

    it('removes the record and the row; a foreign subdomain is not found', async () => {
      expect((await bob.del('/domains/sub/blog.alice.com')).status).toBe(404);
      db().prepare("INSERT INTO mail_autoresponders (account_id, domain, local_part, subject, body) VALUES ((SELECT id FROM accounts WHERE username = 'alice'), 'blog.alice.com', 'hello', 'Away', 'Back soon')").run();
      const res = await alice.del('/domains/sub/blog.alice.com?removeDocroot=true').expect(200);
      expect(res.body.data).toMatchObject({ domain: 'blog.alice.com', removed: true, docroot: { removed: true }, mail: { released: true } });
      expect(app.agent.callsTo('vmail.autoresponder.remove').map((c) => c.args)).toEqual([{ domain: 'blog.alice.com', localPart: 'hello' }]);
      expect(app.agent.callsTo('vmail.passwd.purge').map((c) => c.args)).toEqual([{ domain: 'blog.alice.com' }]);
      expect(row('SELECT 1 AS x FROM mail_autoresponders WHERE domain = ?', 'blog.alice.com')).toBeUndefined();
      expect(row('SELECT 1 AS x FROM account_domains WHERE domain = ?', 'blog.alice.com')).toBeUndefined();
      expect(row('SELECT 1 AS x FROM dns_records WHERE zone_id = (SELECT id FROM dns_zones WHERE domain = ?) AND name = ?', 'alice.com', 'blog')).toBeUndefined();
    });
  });

  describe('parked domains', () => {
    it('counts max_parked itself (the delegate waives it for root owners)', async () => {
      setPlan(app, 'alice', { max_parked: 0 });
      const res = await alice.post('/domains/parked', { domain: 'park.example' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('limit_reached');
      expect(names()).toEqual([]);
      setPlan(app, 'alice', { max_parked: 3 });
      setFeature(app, 'alice', 'parkeddomains', false);
      expect((await alice.post('/domains/parked', { domain: 'park.example' })).body.error.code).toBe('feature_disabled');
      setFeature(app, 'alice', 'parkeddomains', true);
    });

    it('parks through ctx.dns.parkDomain and unparks only its own', async () => {
      const res = await alice.post('/domains/parked', { domain: 'park.example' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ domain: 'park.example', type: 'parked', target: 'alice.com' });
      expect(row('SELECT type FROM account_domains WHERE domain = ?', 'park.example')).toEqual({ type: 'parked' });
      expect(row('SELECT account_id FROM dns_zones WHERE domain = ?', 'park.example').account_id).toBe(row('SELECT id FROM accounts WHERE username = ?', 'alice').id);
      expect((await alice.post('/domains/parked', { domain: 'bob.com' })).body.error.code).toBe('exists');
      expect((await bob.del('/domains/parked/park.example')).status).toBe(404);
      db().prepare("INSERT INTO mail_domain_forwarders (account_id, domain, target_domain) VALUES ((SELECT id FROM accounts WHERE username = 'alice'), 'park.example', 'alice.com')").run();
      const gone = await alice.del('/domains/parked/park.example?removeZone=true').expect(200);
      expect(gone.body.data).toMatchObject({ removed: true, zoneRemoved: true, mail: { released: true } });
      expect(gone.body.meta.warnings).toEqual([]);
      expect(app.agent.callsTo('vmail.passwd.purge').map((c) => c.args)).toEqual([{ domain: 'park.example' }]);
      expect(row('SELECT 1 AS x FROM mail_domain_forwarders WHERE domain = ?', 'park.example')).toBeUndefined();
      expect(row('SELECT 1 AS x FROM account_domains WHERE domain = ?', 'park.example')).toBeUndefined();
    });
  });

  describe('redirects', () => {
    it('sets, reads and removes a redirect on an own hostname only', async () => {
      expect((await bob.put('/domains/alice.com/redirect', { targetUrl: 'https://example.org/' })).status).toBe(404);
      const set = await alice.put('/domains/alice.com/redirect', { targetUrl: 'https://example.org/', type: 'temporary', keepPath: false });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      expect(set.body.data.redirect).toMatchObject({ domain: 'alice.com', targetUrl: 'https://example.org/', type: 'temporary', keepPath: false, matchWww: true });
      expect(row('SELECT account_id FROM domain_forwarding WHERE domain = ?', 'alice.com').account_id).toBe(row('SELECT id FROM accounts WHERE username = ?', 'alice').id);
      const get = await alice.get('/domains/alice.com/redirect').expect(200);
      expect(get.body.data.redirect.targetUrl).toBe('https://example.org/');
      expect((await alice.put('/domains/alice.com/redirect', { targetUrl: 'ftp://x/' })).status).toBe(422);
      expect((await bob.get('/domains/alice.com/redirect')).status).toBe(404);
      expect((await bob.del('/domains/alice.com/redirect')).status).toBe(404);
      await alice.del('/domains/alice.com/redirect').expect(200);
      expect((await alice.get('/domains/alice.com/redirect')).body.data.redirect).toBeNull();
      setFeature(app, 'alice', 'redirects', false);
      expect((await alice.put('/domains/alice.com/redirect', { targetUrl: 'https://example.org/' })).body.error.code).toBe('feature_disabled');
      setFeature(app, 'alice', 'redirects', true);
    });
  });
});
