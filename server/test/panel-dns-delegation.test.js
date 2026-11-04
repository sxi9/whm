import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';

// Public DNS as the resolver sees it: alice.com is delegated to a third party,
// bob.com to a nameserver that resolves to this host, nobody.example is not
// registered and deep names carry no NS of their own (walk-up to the parent).
const PUBLIC = {
  'alice.com': { NS: ['betty.ns.cloud.example.', 'roman.ns.cloud.example.'] },
  'betty.ns.cloud.example': { A: ['198.51.100.1'] },
  'roman.ns.cloud.example': { A: ['198.51.100.2'] },
  'bob.com': { NS: ['ns1.srv.example.'] },
  'ns1.srv.example': { A: ['203.0.113.6'] },
  'carol.net': { NS: ['ns1.test.example.com.'] },
};
function resolveMock({ name, type }) {
  const rec = PUBLIC[name]?.[type];
  if (rec) return { name, type, servers: ['192.0.2.53'], answers: rec, error: null };
  return { name, type, servers: ['192.0.2.53'], answers: [], error: PUBLIC[name] ? 'ENODATA' : 'ENOTFOUND' };
}

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
    'dns.resolve': resolveMock,
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
  };
}

describe('Customer panel: DNS delegation awareness', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  const names = () => app.agent.calls.map((c) => c.name);

  beforeAll(async () => {
    app = await createTestApp({ agent: bindAgent() });
    csrf = await app.login();
    app.ctx.settings.set('basic.hostname', 'test.example.com');
    app.ctx.settings.set('basic.nameservers', ['ns1.test.example.com', 'ns2.test.example.com']);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', ip: '203.0.113.5', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('reports a zone delegated to another provider as not published from here', async () => {
    const res = await alice.get('/dns/zones').expect(200);
    const [zone] = res.body.data.zones;
    expect(zone.domain).toBe('alice.com');
    expect(zone.delegation).toMatchObject({ delegatedHere: false, checkedDomain: 'alice.com', delegatedNs: ['betty.ns.cloud.example', 'roman.ns.cloud.example'], error: null });
    expect(zone.delegation.nameservers.map((n) => n.here)).toEqual([false, false]);
    expect(typeof zone.delegation.checkedAt).toBe('string');
    const full = await alice.get('/dns/zones/alice.com').expect(200);
    expect(full.body.data.delegation.delegatedHere).toBe(false);
    const ns = app.agent.callsTo('dns.resolve').map((c) => c.args);
    expect(ns.every((a) => a.timeoutMs === 3000)).toBe(true);
  });

  it('recognises a nameserver that resolves to one of this server\'s addresses', async () => {
    const res = await bob.get('/dns/zones').expect(200);
    expect(res.body.data.zones[0].delegation).toMatchObject({ delegatedHere: true, delegatedNs: ['ns1.srv.example'] });
  });

  it('walks up to the parent that carries the NS set and keeps the answer for ten minutes', async () => {
    const deep = await app.ctx.panelDns.delegation('blog.shop.alice.com');
    expect(deep).toMatchObject({ domain: 'blog.shop.alice.com', checkedDomain: 'alice.com', delegatedHere: false });
    expect(app.agent.callsTo('dns.resolve').filter((c) => c.args.type === 'NS').map((c) => c.args.name)).toEqual(['blog.shop.alice.com', 'shop.alice.com', 'alice.com']);
    app.agent.calls.length = 0;
    const again = await app.ctx.panelDns.delegation('alice.com');
    expect(again.delegatedHere).toBe(false);
    expect(names()).not.toContain('dns.resolve');
    const fresh = await app.ctx.panelDns.delegation('alice.com', { fresh: true });
    expect(names()).toContain('dns.resolve');
    expect(fresh.checkedAt >= again.checkedAt).toBe(true);
  });

  it('answers "unknown" (null) for an unregistered name instead of a false alarm', async () => {
    const none = await app.ctx.panelDns.delegation('nobody.example');
    expect(none).toMatchObject({ delegatedHere: null, delegatedNs: [], error: 'ENOTFOUND' });
    app.agent.fail('dns.resolve', 'agent_unavailable', 'no agent');
    try {
      const down = await app.ctx.panelDns.delegation('other.example');
      expect(down.delegatedHere).toBeNull();
      expect(await app.ctx.panelDns.delegationOrNull('other.example')).toMatchObject({ delegatedHere: null });
    } finally { app.agent.set('dns.resolve', resolveMock); }
  });

  it('counts one of this server\'s own nameserver names as "here" when it cannot be resolved', async () => {
    const d = await app.ctx.panelDns.delegation('carol.net');
    expect(d).toMatchObject({ delegatedHere: true, delegatedNs: ['ns1.test.example.com'] });
  });

  it('carries the delegation on the domains list and on record writes', async () => {
    const list = await alice.get('/domains').expect(200);
    expect(list.body.data[0]).toMatchObject({ domain: 'alice.com', delegation: { delegatedHere: false } });
    const add = await alice.post('/dns/zones/alice.com/records', { name: 'app', type: 'A', value: '203.0.113.7' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.data.delegation.delegatedHere).toBe(false);
    expect(names()).toContain('dns.zone.write');
  });
});
