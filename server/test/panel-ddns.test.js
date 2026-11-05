import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { normalizeIp, ipMatchesType } from '../src/services/panel-ddns.js';
import { headerToken, DDNS_RATE_LIMIT } from '../src/routes/panel/ddns.js';
import { redactLoggedUrl } from '../src/app.js';

const NS = { 'alice.com': ['betty.ns.cloud.example', 'roman.ns.cloud.example'] };

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
    'dns.resolve': ({ name, type }) => {
      if (type === 'NS' && NS[name]) return { name, type, servers: [], answers: NS[name], error: null };
      if (type === 'A' && name.endsWith('cloud.example')) return { name, type, servers: [], answers: ['198.51.100.9'], error: null };
      return { name, type, servers: [], answers: [], error: 'ENOTFOUND' };
    },
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
    del: (p) => http.delete(`/api/panel${p}`).set('X-CSRF-Token', csrf),
  };
}

describe('Customer panel: dynamic DNS', () => {
  let app;
  let csrf;
  let bob;
  let carol;
  const db = () => app.ctx.db;
  const row = (sql, ...args) => db().prepare(sql).get(...args);
  const anon = () => request(app.ctx.app);
  const recordOf = (domain, name, type) => row('SELECT id, value FROM dns_records WHERE zone_id = (SELECT id FROM dns_zones WHERE domain = ?) AND name = ? AND type = ?', domain, name, type);

  beforeAll(async () => {
    app = await createTestApp({ agent: bindAgent() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.org', ip: '203.0.113.7', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', ip: '203.0.113.5', provision: { mail: false } }).expect(201);
    bob = await panelLogin(app, 'bob');
    carol = await panelLogin(app, 'carol');
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('helpers: socket addresses and record-type checks', () => {
    expect(normalizeIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp(' 2001:db8::1 ')).toBe('2001:db8::1');
    expect(ipMatchesType('203.0.113.9', 'A')).toBe(true);
    expect(ipMatchesType('2001:db8::1', 'A')).toBe(false);
    expect(ipMatchesType('2001:db8::1', 'AAAA')).toBe(true);
    expect(ipMatchesType('999.1.1.1', 'A')).toBe(false);
    expect(ipMatchesType('203.0.113.9; rm -rf /', 'A')).toBe(false);
  });

  it('lists the zones with their A/AAAA candidates and no tokens yet', async () => {
    const res = await bob.get('/dns/ddns').expect(200);
    expect(res.body.data.tokens).toEqual([]);
    expect(res.body.data.zones.map((z) => z.domain)).toEqual(['bob.com']);
    const cands = res.body.data.zones[0].records;
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((r) => ['A', 'AAAA'].includes(r.type))).toBe(true);
    expect(res.body.data.baseUrl).toMatch(/\/api\/panel\/dns\/ddns$/);
    expect(res.body.data.max).toBe(20);
  });

  it('mints a token for an own A record (shown once), refuses other types and foreign zones', async () => {
    const probe = await bob.post('/dns/zones/bob.com/records', { name: 'probe', type: 'A', value: '203.0.113.60' });
    expect(probe.status, JSON.stringify(probe.body)).toBe(201);
    const recordId = probe.body.data.record.id;
    const mx = recordOf('bob.com', '@', 'MX') || recordOf('bob.com', '@', 'NS');
    if (mx) expect((await bob.post('/dns/ddns', { domain: 'bob.com', recordId: mx.id })).status).toBe(422);
    expect((await carol.post('/dns/ddns', { domain: 'bob.com', recordId })).status).toBe(404);
    expect((await bob.post('/dns/ddns', { domain: 'bob.com', recordId, label: 'x'.repeat(65) })).status).toBe(422);
    const res = await bob.post('/dns/ddns', { domain: 'bob.com', recordId, label: 'home router' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.data.url).toBe(`${res.body.data.token ? (await bob.get('/dns/ddns')).body.data.baseUrl : ''}/${res.body.data.secret}`);
    expect(res.body.data.token).toMatchObject({ zone: 'bob.com', host: 'probe.bob.com', type: 'A', value: '203.0.113.60', label: 'home router', updates: 0, lastIp: null });
    const stored = row('SELECT token_hash FROM panel_ddns_tokens WHERE id = ?', res.body.data.token.id);
    expect(stored.token_hash).toBe(app.ctx.crypto.hashToken(res.body.data.secret));
    expect(stored.token_hash).not.toBe(res.body.data.secret);
    const list = await bob.get('/dns/ddns').expect(200);
    expect(list.body.data.tokens).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(res.body.data.secret);
    expect((await carol.get('/dns/ddns')).body.data.tokens).toEqual([]);
    expect(row("SELECT * FROM audit_log WHERE action = 'panel.dns.ddns.create' AND target = 'bob'")).toBeTruthy();
    app.ddns = { secret: res.body.data.secret, id: res.body.data.token.id, recordId };
  });

  it('public update: no session, ip from the query or the socket, 422 on the wrong family, nochg when equal', async () => {
    const { secret, recordId } = app.ddns;
    const bad = await anon().get(`/api/panel/dns/ddns/${secret}?ip=2001:db8::1`);
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields).toHaveProperty('ip');
    expect((await anon().get(`/api/panel/dns/ddns/${secret}?ip=999.1.1.1`)).status).toBe(422);
    expect((await anon().get(`/api/panel/dns/ddns/${secret}?ip=203.0.113.61;id`)).status).toBe(422);
    expect(app.agent.calls.map((c) => c.name)).not.toContain('dns.zone.write');

    const ok = await anon().get(`/api/panel/dns/ddns/${secret}?ip=203.0.113.61`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ zone: 'bob.com', host: 'probe.bob.com', type: 'A', ip: '203.0.113.61', changed: true, applied: true });
    expect(ok.body.data.serial).toBeTruthy();
    expect(app.agent.calls.map((c) => c.name)).toContain('dns.zone.write');
    expect(row('SELECT value FROM dns_records WHERE id = ?', recordId).value).toBe('203.0.113.61');

    app.agent.calls.length = 0;
    const same = await anon().get(`/api/panel/dns/ddns/${secret}?ip=203.0.113.61&format=text`);
    expect(same.status).toBe(200);
    expect(same.headers['content-type']).toMatch(/text\/plain/);
    expect(same.text).toBe('nochg 203.0.113.61\n');
    expect(app.agent.calls.map((c) => c.name)).not.toContain('dns.zone.write');

    // No ?ip=: the socket address (loopback under supertest) is an IPv4 for an A record.
    const socket = await anon().get(`/api/panel/dns/ddns/${secret}`);
    expect(socket.status, JSON.stringify(socket.body)).toBe(200);
    expect(socket.body.data.ip).toBe('127.0.0.1');
    expect(row('SELECT value FROM dns_records WHERE id = ?', recordId).value).toBe('127.0.0.1');

    const t = row('SELECT last_ip, updates FROM panel_ddns_tokens WHERE id = ?', app.ddns.id);
    expect(t).toMatchObject({ last_ip: '127.0.0.1', updates: 3 });
    const listed = (await bob.get('/dns/ddns')).body.data.tokens[0];
    expect(listed).toMatchObject({ lastIp: '127.0.0.1', updates: 3, value: '127.0.0.1' });
    expect(row("SELECT * FROM audit_log WHERE action = 'panel.dns.ddns.update' AND target = 'bob'")).toBeTruthy();
  });

  it('unknown, malformed and revoked tokens are 404; the scoped routes stay behind the session', async () => {
    expect((await anon().get(`/api/panel/dns/ddns/${'A'.repeat(43)}?ip=203.0.113.1`)).status).toBe(404);
    expect((await anon().get('/api/panel/dns/ddns/short?ip=203.0.113.1')).status).toBe(404);
    expect((await anon().get('/api/panel/dns/ddns')).status).toBe(401);
    expect((await anon().post('/api/panel/dns/ddns').send({})).status).not.toBe(201);
    expect((await carol.del(`/dns/ddns/${app.ddns.id}`)).status).toBe(404);
    expect(row('SELECT 1 AS x FROM panel_ddns_tokens WHERE id = ?', app.ddns.id)).toBeTruthy();
    await bob.del(`/dns/ddns/${app.ddns.id}`).expect(200);
    expect(row('SELECT 1 AS x FROM panel_ddns_tokens WHERE id = ?', app.ddns.id)).toBeUndefined();
    expect((await anon().get(`/api/panel/dns/ddns/${app.ddns.secret}?ip=203.0.113.1`)).status).toBe(404);
    expect(row("SELECT * FROM audit_log WHERE action = 'panel.dns.ddns.revoke' AND target = 'bob'")).toBeTruthy();
  });

  it('a token dies with its record', async () => {
    const { recordId } = app.ddns;
    const res = await bob.post('/dns/ddns', { domain: 'bob.com', recordId });
    expect(res.status).toBe(201);
    await bob.del(`/dns/zones/bob.com/records/${recordId}`).expect(200);
    expect(row('SELECT 1 AS x FROM panel_ddns_tokens WHERE id = ?', res.body.data.token.id)).toBeUndefined();
    expect((await anon().get(`/api/panel/dns/ddns/${res.body.data.secret}?ip=203.0.113.1`)).status).toBe(404);
  });

  it('refuses a zone whose public DNS is managed elsewhere and reports it in the listing', async () => {
    const alice = await panelLogin(app, 'alice');
    const list = await alice.get('/dns/ddns').expect(200);
    expect(list.body.data.zones[0].delegation).toMatchObject({ delegatedHere: false, delegatedNs: ['betty.ns.cloud.example', 'roman.ns.cloud.example'] });
    const a = recordOf('alice.com', '@', 'A');
    const res = await alice.post('/dns/ddns', { domain: 'alice.com', recordId: a.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('not_delegated');
    expect(row("SELECT COUNT(*) AS n FROM panel_ddns_tokens WHERE account_id = (SELECT id FROM accounts WHERE username = 'alice')").n).toBe(0);
  });

  it('takes the token from HTTP basic authentication on /update (token as password) and never logs it', async () => {
    const probe = await bob.post('/dns/zones/bob.com/records', { name: 'probe2', type: 'A', value: '203.0.113.70' });
    expect(probe.status, JSON.stringify(probe.body)).toBe(201);
    const minted = await bob.post('/dns/ddns', { domain: 'bob.com', recordId: probe.body.data.record.id });
    expect(minted.status).toBe(201);
    const { secret } = minted.body.data;
    expect(headerToken({ get: () => `Basic ${Buffer.from(`router:${secret}`).toString('base64')}` })).toBe(secret);
    expect(headerToken({ get: () => `Basic ${Buffer.from(secret).toString('base64')}` })).toBe(secret);
    expect(headerToken({ get: () => 'Digest abc' })).toBeNull();
    expect(headerToken({ get: () => undefined })).toBeNull();

    const basic = await anon().get('/api/panel/dns/ddns/update?ip=203.0.113.71').auth('router', secret);
    expect(basic.status, JSON.stringify(basic.body)).toBe(200);
    expect(basic.body.data).toMatchObject({ host: 'probe2.bob.com', ip: '203.0.113.71', changed: true });
    const text = await anon().get('/api/panel/dns/ddns/update?ip=203.0.113.72&format=text').auth('', secret);
    expect(text.status).toBe(200);
    expect(text.text).toBe('good 203.0.113.72\n');
    expect((await anon().get('/api/panel/dns/ddns/update?ip=203.0.113.73')).status).toBe(404);
    expect((await anon().get('/api/panel/dns/ddns/update?ip=203.0.113.73').auth('router', 'B'.repeat(43))).status).toBe(404);
    // A Bearer header is the panel's own API-token credential and is answered by attachUser, never by this route.
    expect((await anon().get('/api/panel/dns/ddns/update?ip=203.0.113.73').set('Authorization', `Bearer ${secret}`)).status).toBe(401);
    // "update" is not a token shape, so the path form cannot be confused with it.
    expect((await anon().get('/api/panel/dns/ddns/update')).status).toBe(404);

    // The request log keeps the prefix and drops the credential (DDNS and the SSO exchange alike).
    expect(redactLoggedUrl(`/api/panel/dns/ddns/${secret}?ip=1.2.3.4`)).toBe('/api/panel/dns/ddns/[redacted]?ip=1.2.3.4');
    expect(redactLoggedUrl(`/api/panel/dns/ddns/${secret}`)).toBe('/api/panel/dns/ddns/[redacted]');
    expect(redactLoggedUrl(`/api/panel/sso/webmail/${'c'.repeat(64)}`)).toBe('/api/panel/sso/webmail/[redacted]');
    expect(redactLoggedUrl('/api/panel/dns/ddns/update?ip=1.2.3.4')).toBe('/api/panel/dns/ddns/update?ip=1.2.3.4');
    expect(redactLoggedUrl('/api/panel/dns/ddns')).toBe('/api/panel/dns/ddns');
    await bob.del(`/dns/ddns/${minted.body.data.token.id}`).expect(200);
  });

  it('a panel:dns API token can list but never mint or revoke an update URL (session_required)', async () => {
    const minted = await bob.post('/tokens', { name: 'cli', scopes: ['panel:dns'] });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const viaToken = (p) => request(app.ctx.app).get(`/api/panel${p}`).set('Authorization', `Bearer ${minted.body.data.token}`);
    expect((await viaToken('/dns/ddns')).status).toBe(200);
    const a = recordOf('bob.com', '@', 'A');
    const create = await request(app.ctx.app).post('/api/panel/dns/ddns').set('Authorization', `Bearer ${minted.body.data.token}`).send({ domain: 'bob.com', recordId: a.id });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('session_required');
    const own = await bob.post('/dns/ddns', { domain: 'bob.com', recordId: a.id });
    expect(own.status).toBe(201);
    const revoke = await request(app.ctx.app).delete(`/api/panel/dns/ddns/${own.body.data.token.id}`).set('Authorization', `Bearer ${minted.body.data.token}`);
    expect(revoke.status).toBe(403);
    expect(revoke.body.error.code).toBe('session_required');
    expect(row('SELECT 1 AS x FROM panel_ddns_tokens WHERE id = ?', own.body.data.token.id)).toBeTruthy();
    await bob.del(`/dns/ddns/${own.body.data.token.id}`).expect(200);
  });

  it('the public limiter never counts the scoped routes: 61 listings from one address all answer 200', async () => {
    for (let i = 0; i <= DDNS_RATE_LIMIT.limit; i += 1) {
      const res = await bob.get('/dns/ddns');
      expect(res.status, `call ${i}`).toBe(200);
    }
  });

  it('is gated by the ddns plan feature', async () => {
    const snapshot = row('SELECT plan_snapshot_json FROM accounts WHERE username = ?', 'bob').plan_snapshot_json;
    const plan = JSON.parse(snapshot || '{}');
    db().prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify({ ...plan, features: { ...(plan.features || {}), ddns: false } }), 'bob');
    try {
      const res = await bob.get('/dns/ddns');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('feature_disabled');
    } finally {
      db().prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(snapshot, 'bob');
    }
  });

  // Last: it spends the public budget of the test address for the rest of the run.
  it('rate-limits the public update per address and leaves the scoped listing untouched', async () => {
    let last = null;
    for (let i = 0; i <= DDNS_RATE_LIMIT.limit; i += 1) {
      last = await anon().get(`/api/panel/dns/ddns/${'A'.repeat(43)}?ip=203.0.113.1`);
      if (last.status === 429) break;
      expect(last.status).toBe(404);
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('rate_limited');
    expect((await anon().get('/api/panel/dns/ddns/update?ip=203.0.113.1').auth('router', 'A'.repeat(43))).status).toBe(429);
    expect((await bob.get('/dns/ddns')).status).toBe(200);
  });
});
