import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { isPublicAddress } from '../src/services/panel-dns-track.js';

const TRACE = {
  host: 'example.com', header: 'traceroute to example.com (93.184.216.34), 20 hops max, 60 byte packets', target: '93.184.216.34',
  hops: [
    { hop: 1, address: '10.0.0.1', addresses: ['10.0.0.1'], rtts: [0.4, 0.3, 0.3], timeouts: 0 },
    { hop: 2, address: null, addresses: [], rtts: [], timeouts: 3 },
    { hop: 3, address: '93.184.216.34', addresses: ['93.184.216.34'], rtts: [12.1, 12.0, 11.9], timeouts: 0 },
  ],
  reached: true, error: null, exitCode: 0, output: '',
};

function agentWithTools() {
  return createMockAgent({
    'dns.lookup': ({ name, type }) => (type === 'MX' ? { name, type, answers: ['10 mail.example.com.'], notes: [], error: null, exitCode: 0, output: '' } : { name, type, answers: ['93.184.216.34'], notes: [], error: null, exitCode: 0, output: '' }),
    'dns.trace': ({ host }) => ({ ...TRACE, host }),
  });
}

async function panelLogin(app, username, password = 'Panel-Passw0rd!1') {
  const hash = await app.ctx.crypto.hashPassword(password);
  app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  const http = request.agent(app.ctx.app);
  const res = await http.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`panel login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { get: (p) => http.get(`/api/panel${p}`) };
}

describe('Customer panel: Track DNS', () => {
  let app;
  let csrf;
  let bob;
  const db = () => app.ctx.db;

  beforeAll(async () => {
    app = await createTestApp({ agent: agentWithTools() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    bob = await panelLogin(app, 'bob');
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.reset(); });

  it('seeds the traceroute feature as enabled in the default list', () => {
    const row = db().prepare("SELECT features_json FROM feature_lists WHERE name = 'default'").get();
    expect(JSON.parse(row.features_json).traceroute).toBe(true);
  });

  it('looks a name up through dns.lookup and answers the record list', async () => {
    const res = await bob.get('/dns/track/lookup?name=Example.COM&type=MX').expect(200);
    expect(res.body.data).toMatchObject({ name: 'example.com', type: 'MX', answers: ['10 mail.example.com.'], error: null });
    expect(typeof res.body.data.checkedAt).toBe('string');
    expect(app.agent.callsTo('dns.lookup')).toEqual([{ name: 'dns.lookup', args: { name: 'example.com', type: 'MX' } }]);
    const dflt = await bob.get('/dns/track/lookup?name=example.com').expect(200);
    expect(dflt.body.data.type).toBe('A');
    const v6 = await bob.get('/dns/track/lookup?name=2001:db8::1&type=PTR').expect(200);
    expect(v6.body.data.name).toBe('2001:db8::1');
  });

  it('refuses injection, options, paths and unknown types with 422 before the agent runs', async () => {
    for (const name of ['-x', '--help', '+trace', 'a;b.com', 'a b.com', 'example.com/../x', '$(id).com', 'example.com%0Aid', 'localhost', '']) {
      const res = await bob.get(`/dns/track/lookup?name=${encodeURIComponent(name)}`);
      expect(res.status, JSON.stringify(name)).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.fields.name).toBeDefined();
    }
    expect((await bob.get('/dns/track/lookup?name=example.com&type=ANY')).status).toBe(422);
    expect((await bob.get('/dns/track/lookup?name=example.com&type=AXFR')).status).toBe(422);
    expect((await bob.get('/dns/track/lookup?name=example.com&extra=1')).status).toBe(422);
    for (const host of ['-n', 'a;b.com', 'a b', '$(id).com', '`id`.com', 'example.com|cat']) {
      const res = await bob.get(`/dns/track/trace?host=${encodeURIComponent(host)}`);
      expect(res.status, JSON.stringify(host)).toBe(422);
      expect(res.body.error.fields.host).toBeDefined();
    }
    // Only public addresses: the host is not a probe into its own network.
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fc00::', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
      const trace = await bob.get(`/dns/track/trace?host=${encodeURIComponent(ip)}`);
      expect(trace.status, ip).toBe(422);
      expect(trace.body.error.fields.host[0]).toMatch(/public/);
      expect((await bob.get(`/dns/track/lookup?name=${encodeURIComponent(ip)}&type=PTR`)).status, ip).toBe(422);
    }
    expect(isPublicAddress('203.0.113.9')).toBe(true);
    expect(isPublicAddress('172.32.0.1')).toBe(true);
    expect(isPublicAddress('2001:db8::1')).toBe(true);
    expect(isPublicAddress('::ffff:203.0.113.9')).toBe(true);
    expect(isPublicAddress('example.com')).toBe(false);
    expect(app.agent.callsTo('dns.lookup')).toEqual([]);
    expect(app.agent.callsTo('dns.trace')).toEqual([]);
  });

  it('traces a host through dns.trace and answers the hop list', async () => {
    const res = await bob.get('/dns/track/trace?host=example.com').expect(200);
    expect(res.body.data).toMatchObject({ host: 'example.com', target: '93.184.216.34', reached: true, error: null });
    expect(res.body.data.hops).toHaveLength(3);
    expect(res.body.data.hops[1]).toEqual({ hop: 2, address: null, addresses: [], rtts: [], timeouts: 3 });
    expect(app.agent.callsTo('dns.trace')).toEqual([{ name: 'dns.trace', args: { host: 'example.com' } }]);
    const v6 = await bob.get('/dns/track/trace?host=2001:db8::1').expect(200);
    expect(v6.body.data.host).toBe('2001:db8::1');
  });

  it('runs one trace at a time per account (409 busy)', async () => {
    // Through the service: two HTTP calls of one session are serialised by the
    // session store, so the overlap can only be produced here.
    const scope = { username: 'bob', accountId: db().prepare("SELECT id FROM accounts WHERE username = 'bob'").get().id, features: {} };
    let release = null;
    app.agent.set('dns.trace', ({ host }) => (host === 'example.com' ? new Promise((resolve) => { release = () => resolve({ ...TRACE, host }); }) : { ...TRACE, host }));
    const first = app.ctx.panelDnsTrack.trace(scope, { host: 'example.com' }, null);
    while (!release) await new Promise((r) => setTimeout(r, 5));
    await expect(app.ctx.panelDnsTrack.trace(scope, { host: 'example.org' }, null)).rejects.toMatchObject({ status: 409, code: 'busy' });
    await expect(app.ctx.panelDnsTrack.trace({ ...scope, accountId: scope.accountId + 1, username: 'carol' }, { host: 'example.org' }, null)).resolves.toMatchObject({ host: 'example.org' });
    release();
    expect((await first).host).toBe('example.com');
    await expect(app.ctx.panelDnsTrack.trace(scope, { host: 'example.org' }, null)).resolves.toMatchObject({ host: 'example.org' });
  });

  it('answers 501 with the package as capability when dig or traceroute is missing', async () => {
    app.agent.fail('dns.trace', 'capability_missing', 'traceroute is not installed on this server (traceroute package)');
    const res = await bob.get('/dns/track/trace?host=example.com');
    expect(res.status).toBe(501);
    expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'traceroute' });
    app.agent.fail('dns.lookup', 'binary_not_found', 'Required program "dig" is not installed on this server');
    const l = await bob.get('/dns/track/lookup?name=example.com');
    expect(l.status).toBe(501);
    expect(l.body.error).toMatchObject({ code: 'capability_missing', capability: 'dnsutils' });
  });

  it('passes a structured lookup/trace error through unchanged', async () => {
    app.agent.set('dns.lookup', ({ name, type }) => ({ name, type, answers: [], notes: ['no servers could be reached'], error: 'timeout', exitCode: 9, output: '' }));
    const res = await bob.get('/dns/track/lookup?name=example.com').expect(200);
    expect(res.body.data).toMatchObject({ answers: [], error: 'timeout', notes: ['no servers could be reached'] });
    app.agent.set('dns.trace', ({ host }) => ({ host, header: null, target: null, hops: [], reached: false, error: 'unknown_host', exitCode: 2, output: 'x: Name or service not known' }));
    const t = await bob.get('/dns/track/trace?host=nope.invalid').expect(200);
    expect(t.body.data).toMatchObject({ error: 'unknown_host', hops: [], reached: false });
  });

  it('is gated by the traceroute feature', async () => {
    const setFeature = (value) => db().prepare("UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.traceroute', json(?)) WHERE username = ?").run(JSON.stringify(value), 'bob');
    setFeature(false);
    try {
      const res = await bob.get('/dns/track/lookup?name=example.com');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('feature_disabled');
      expect((await bob.get('/dns/track/trace?host=example.com')).status).toBe(403);
      expect(app.agent.callsTo('dns.lookup')).toEqual([]);
    } finally {
      setFeature(true);
    }
  });

  it('is not reachable without a panel session', async () => {
    expect((await request(app.ctx.app).get('/api/panel/dns/track/lookup?name=example.com')).status).toBe(401);
    expect((await app.http.get('/api/panel/dns/track/lookup?name=example.com')).status).toBe(403);
  });
});
