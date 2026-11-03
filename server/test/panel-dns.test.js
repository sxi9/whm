import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';

function bindAgent() {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['named', 'rndc', 'named-checkzone', 'named-checkconf'].includes(n)])),
    'dns.layout': () => ({ installed: true, flavor: 'debian', zoneDir: '/etc/bind/zones', includeFile: '/etc/bind/named.conf.whm' }),
    'dns.zone.list': () => ({ installed: true, zones: [] }),
    'dns.zone.read': ({ domain }) => ({ domain, exists: false, body: null }),
    'dns.checkzone': ({ domain }) => ({ domain, ok: true, output: '', serial: 1 }),
    'dns.zone.write': ({ domain }) => ({ domain, path: `/etc/bind/zones/${domain}.db`, stanzaAdded: true, includeAdded: false }),
    'dns.zone.remove': ({ domain }) => ({ domain, removed: [`/etc/bind/zones/${domain}.db`], stanzaRemoved: true }),
    'dns.reload': ({ domain }) => ({ method: 'rndc', domain: domain ?? null, output: '' }),
    'dns.resolve': ({ name, type }) => ({ name, type, servers: [], answers: [], error: 'ENOTFOUND' }),
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
    post: (p, body = {}) => http.post(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    put: (p, body = {}) => http.put(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    del: (p) => http.delete(`/api/panel${p}`).set('X-CSRF-Token', csrf),
  };
}

describe('Customer panel: DNS zone editor', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  const db = () => app.ctx.db;
  const row = (sql, ...args) => db().prepare(sql).get(...args);
  const names = () => app.agent.calls.map((c) => c.name);
  const recordIds = (domain, type) => db().prepare('SELECT id FROM dns_records WHERE zone_id = (SELECT id FROM dns_zones WHERE domain = ?) AND type = ?').all(domain, type).map((r) => r.id);

  beforeAll(async () => {
    app = await createTestApp({ agent: bindAgent() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', ip: '203.0.113.5', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('lists the account\'s zones only, with the editable record types', async () => {
    const res = await alice.get('/dns/zones').expect(200);
    expect(res.body.data.zones.map((z) => z.domain)).toEqual(['alice.com']);
    expect(res.body.data.zones[0]).toMatchObject({ type: 'master', dnssecEnabled: false });
    expect(res.body.data.types).toEqual(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA']);
    expect(row('SELECT account_id FROM dns_zones WHERE domain = ?', 'bob.com')).toBeTruthy();
  });

  it('strips SOA and NS from a zone and resolves a name inside it', async () => {
    const res = await alice.get('/dns/zones/alice.com').expect(200);
    expect(res.body.data.soa).toBeUndefined();
    expect(res.body.data.records.some((r) => ['NS', 'SOA'].includes(r.type))).toBe(false);
    expect(res.body.data.records.some((r) => r.type === 'A')).toBe(true);
    const inner = await alice.get('/dns/zones/www.alice.com').expect(200);
    expect(inner.body.data.domain).toBe('alice.com');
  });

  it('answers not found for another account\'s zone, even by the owner\'s other account', async () => {
    for (const name of ['bob.com', 'www.bob.com', 'nobody.example']) {
      const res = await alice.get(`/dns/zones/${name}`);
      expect(res.status, name).toBe(404);
    }
    const add = await alice.post('/dns/zones/bob.com/records', { name: 'evil', type: 'A', value: '203.0.113.5' });
    expect(add.status).toBe(404);
    expect(names()).not.toContain('dns.zone.write');
    expect((await alice.get('/dns/zones/bob.com/email')).status).toBe(404);
  });

  it('adds, updates and deletes records of the allowed types only', async () => {
    const ns = await alice.post('/dns/zones/alice.com/records', { name: '@', type: 'NS', value: 'ns9.example.' });
    expect(ns.status).toBe(422);
    const ptr = await alice.post('/dns/zones/alice.com/records', { name: '1', type: 'PTR', value: 'alice.com.' });
    expect(ptr.status).toBe(422);
    const add = await alice.post('/dns/zones/alice.com/records', { name: 'app', type: 'A', value: '203.0.113.7', ttl: 300 });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.data.record).toMatchObject({ name: 'app', type: 'A', value: '203.0.113.7', ttl: 300 });
    expect(names()).toContain('dns.zone.write');
    const id = add.body.data.record.id;
    const upd = await alice.put(`/dns/zones/alice.com/records/${id}`, { value: '203.0.113.8' });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.data.record.value).toBe('203.0.113.8');
    const toNs = await alice.put(`/dns/zones/alice.com/records/${id}`, { type: 'NS' });
    expect(toNs.status).toBe(422);
    expect((await bob.put(`/dns/zones/alice.com/records/${id}`, { value: '203.0.113.9' })).status).toBe(404);
    expect((await bob.del(`/dns/zones/alice.com/records/${id}`)).status).toBe(404);
    await alice.del(`/dns/zones/alice.com/records/${id}`).expect(200);
    expect(row('SELECT 1 AS x FROM dns_records WHERE id = ?', id)).toBeUndefined();
    expect(row("SELECT * FROM audit_log WHERE action = 'panel.dns.record.add' AND target = 'alice'")).toBeTruthy();
  });

  it('protects NS and SOA records from edits and deletion', async () => {
    const [nsId] = recordIds('alice.com', 'NS');
    const [soaId] = recordIds('alice.com', 'SOA');
    expect(nsId).toBeTruthy();
    expect(soaId).toBeTruthy();
    for (const id of [nsId, soaId]) {
      const del = await alice.del(`/dns/zones/alice.com/records/${id}`);
      expect(del.status, `delete ${id}`).toBe(422);
      expect(del.body.error.code).toBe('protected_record');
      const put = await alice.put(`/dns/zones/alice.com/records/${id}`, { value: 'ns9.example.' });
      expect(put.status, `update ${id}`).toBe(422);
    }
    expect(names()).not.toContain('dns.zone.write');
    expect(recordIds('alice.com', 'NS')).toContain(nsId);
  });

  it('does not expose TTL, SOA, raw text or DNSSEC endpoints', async () => {
    for (const [method, path] of [['put', '/dns/zones/alice.com/ttl'], ['put', '/dns/zones/alice.com/soa'], ['put', '/dns/zones/alice.com/raw'], ['put', '/dns/zones/alice.com/dnssec'], ['post', '/dns/zones']]) {
      const res = await alice[method](path, { ttl: 60, enabled: true, body: '', domain: 'x.example' });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it('reports the e-mail DNS status of an own zone', async () => {
    const res = await alice.get('/dns/zones/alice.com/email').expect(200);
    expect(res.body.data).toHaveProperty('spf');
    expect(res.body.data).toHaveProperty('dkim');
  });
});
