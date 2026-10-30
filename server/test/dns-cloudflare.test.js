import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { fromCloudflareRecord, toCloudflareRecord, remoteKey, diffRecords, unquoteTxt, canonicalIpv6, CLOUDFLARE_API } from '../src/services/dns-cloudflare.js';

const TOKEN = 'cf_test_token_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BOB_ZONE = '0123456789abcdef0123456789abcdef';
const ALICE_ZONE = 'fedcba9876543210fedcba9876543210';

function bindAgent() {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['named', 'rndc', 'named-checkzone', 'named-checkconf', 'dnssec-keygen', 'dnssec-signzone'].includes(n)])),
    'dns.layout': () => ({ installed: true, flavor: 'debian', zoneDir: '/etc/bind/zones', includeFile: '/etc/bind/named.conf.whm' }),
    'dns.zone.list': () => ({ installed: true, zones: [] }),
    'dns.zone.read': ({ domain }) => ({ domain, exists: false, body: null }),
    'dns.checkzone': ({ domain }) => ({ domain, ok: true, output: '', serial: 1 }),
    'dns.zone.write': ({ domain }) => ({ domain, path: `/etc/bind/zones/${domain}.db`, stanzaAdded: true, includeAdded: false }),
    'dns.zone.remove': ({ domain }) => ({ domain, removed: [], stanzaRemoved: true }),
    'dns.reload': ({ domain }) => ({ method: 'rndc', domain: domain ?? null, output: '' }),
    'dns.resolve': ({ name, type }) => ({ name, type, servers: [], answers: [], error: 'ENOTFOUND' }),
  });
}

// An in-memory Cloudflare v4 API behind a fetch() stub: records every call,
// checks the bearer token and lets a test inject failures for the next calls.
function fakeCloudflare() {
  const state = {
    zones: [
      { id: BOB_ZONE, name: 'bob.com', status: 'active', paused: false, type: 'full', name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], account: { id: 'acct1', name: 'Hostingsignal' }, plan: { name: 'Free Website' } },
      { id: ALICE_ZONE, name: 'alice.com', status: 'pending', paused: false, type: 'full', name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], account: { id: 'acct1', name: 'Hostingsignal' }, plan: { name: 'Free Website' } },
    ],
    records: { [BOB_ZONE]: [], [ALICE_ZONE]: [] },
    calls: [],
    failNext: [],
    // Milliseconds the next record listing is held before answering.
    delayNextListing: 0,
  };
  let nextId = 1;
  const reply = (status, payload, headers = {}) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
  const ok = (result, extra = {}) => reply(200, { success: true, errors: [], messages: [], result, ...extra });
  const fail = (status, code, message, headers) => reply(status, { success: false, errors: [{ code, message }], messages: [], result: null }, headers);
  const paged = (list, u) => {
    const perPage = Number(u.searchParams.get('per_page')) || 20;
    const page = Number(u.searchParams.get('page')) || 1;
    const slice = list.slice((page - 1) * perPage, page * perPage);
    return ok(slice, { result_info: { page, per_page: perPage, total_pages: Math.max(1, Math.ceil(list.length / perPage)), count: slice.length, total_count: list.length } });
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ method, path: u.pathname + u.search, body, auth: init.headers?.Authorization ?? null });
    if (state.failNext.length) {
      const f = state.failNext.shift();
      if (f instanceof Error) throw f;
      return fail(f.status, f.code, f.message, f.retryAfter ? { 'retry-after': String(f.retryAfter) } : {});
    }
    if (!u.href.startsWith(CLOUDFLARE_API)) return fail(404, 7000, 'No route');
    if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return fail(401, 10000, 'Authentication error');
    const path = u.pathname.slice('/client/v4'.length);
    if (path === '/user/tokens/verify') return ok({ id: 'tok1', status: 'active' });
    if (path === '/zones') {
      const name = u.searchParams.get('name');
      return paged(state.zones.filter((z) => !name || z.name === name), u);
    }
    let m = path.match(/^\/zones\/([a-f0-9]{32})$/);
    if (m) { const z = state.zones.find((x) => x.id === m[1]); return z ? ok(z) : fail(404, 7003, 'Could not route to /zones'); }
    m = path.match(/^\/zones\/([a-f0-9]{32})\/dns_records(?:\/([^/]+))?$/);
    if (m) {
      const list = (state.records[m[1]] ||= []);
      if (!m[2] && method === 'GET') {
        if (state.delayNextListing) { const ms = state.delayNextListing; state.delayNextListing = 0; await new Promise((r) => setTimeout(r, ms)); }
        return paged(list, u);
      }
      if (!m[2] && method === 'POST') { const rec = { id: `r${nextId++}`, proxied: false, ...body }; list.push(rec); return ok(rec); }
      const idx = list.findIndex((r) => r.id === m[2]);
      if (idx < 0) return fail(404, 81044, 'Record does not exist.');
      if (method === 'PATCH') { list[idx] = { ...list[idx], ...body }; return ok(list[idx]); }
      if (method === 'DELETE') { const [rec] = list.splice(idx, 1); return ok({ id: rec.id }); }
    }
    return fail(404, 7000, 'No route');
  };
  return { state, fetch };
}

describe('Cloudflare record mapping', () => {
  const D = 'example.com';

  it('unquotes TXT content as Cloudflare returns it', () => {
    expect(unquoteTxt('"v=spf1 include:_spf.example.com ~all"')).toBe('v=spf1 include:_spf.example.com ~all');
    expect(unquoteTxt('"abc" "def"')).toBe('abcdef');
    expect(unquoteTxt('"say \\"hi\\" \\\\ ok"')).toBe('say "hi" \\ ok');
    expect(unquoteTxt('plain text')).toBe('plain text');
  });

  it('maps every supported type from Cloudflare into the panel shape', () => {
    const map = (r) => fromCloudflareRecord(r, D);
    expect(map({ type: 'A', name: 'example.com', content: '203.0.113.9', ttl: 1 }).record).toEqual({ name: '@', type: 'A', ttl: null, priority: null, value: '203.0.113.9' });
    expect(map({ type: 'AAAA', name: 'www.example.com', content: '2001:DB8::1', ttl: 300 }).record).toEqual({ name: 'www', type: 'AAAA', ttl: 300, priority: null, value: '2001:db8::1' });
    expect(map({ type: 'AAAA', name: 'www.example.com', content: '2001:DB8:0:0:0:0:0:7', ttl: 1 }).record).toMatchObject({ value: '2001:db8::7' });
    expect(map({ type: 'CNAME', name: 'blog.example.com', content: 'example.com', ttl: 1 }).record).toMatchObject({ name: 'blog', type: 'CNAME', value: 'example.com.' });
    expect(map({ type: 'MX', name: 'example.com', content: 'mail.example.com', priority: 10, ttl: 1 }).record).toMatchObject({ name: '@', type: 'MX', priority: 10, value: 'mail.example.com.' });
    expect(map({ type: 'TXT', name: 'example.com', content: '"v=spf1 +mx ~all"', ttl: 1 }).record).toMatchObject({ name: '@', type: 'TXT', value: 'v=spf1 +mx ~all' });
    expect(map({ type: 'SRV', name: '_sip._tcp.example.com', content: '5 5060 sip.example.com', data: { priority: 10, weight: 5, port: 5060, target: 'sip.example.com' }, ttl: 1 }).record).toEqual({ name: '_sip._tcp', type: 'SRV', ttl: null, priority: 10, value: '5 5060 sip.example.com.' });
    expect(map({ type: 'SRV', name: '_sip._tcp.example.com', content: '10 5 5060 sip.example.com', ttl: 1 }).record).toMatchObject({ priority: 10, value: '5 5060 sip.example.com.' });
    expect(map({ type: 'CAA', name: 'example.com', content: '0 issue "letsencrypt.org"', data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' }, ttl: 1 }).record).toMatchObject({ name: '@', type: 'CAA', value: '0 issue letsencrypt.org' });
    expect(map({ type: 'CAA', name: 'example.com', content: '128 iodef "mailto:sec@example.com"', ttl: 1 }).record).toMatchObject({ value: '128 iodef mailto:sec@example.com' });
    expect(map({ type: 'NS', name: 'sub.example.com', content: 'ns1.other.net', ttl: 1 }).record).toMatchObject({ name: 'sub', type: 'NS', value: 'ns1.other.net.' });
    expect(map({ type: 'NS', name: 'example.com', content: 'ada.ns.cloudflare.com', ttl: 1 }).skipped).toMatch(/apex NS/);
    expect(map({ type: 'HTTPS', name: 'example.com', content: '1 . alpn="h2"', ttl: 1 }).skipped).toMatch(/not supported/);
    expect(map({ type: 'A', name: 'www.other.com', content: '203.0.113.9', ttl: 1 }).skipped).toMatch(/outside/);
    expect(map({ type: 'A', name: 'www.example.com', content: 'not-an-ip', ttl: 1 }).skipped).toMatch(/IPv4/);
  });

  it('maps panel records to Cloudflare payloads with ttl auto = 1', () => {
    const to = (r) => toCloudflareRecord(r, D);
    expect(to({ name: '@', type: 'A', ttl: null, value: '203.0.113.9' })).toMatchObject({ key: 'A|example.com|203.0.113.9', payload: { type: 'A', name: 'example.com', content: '203.0.113.9', ttl: 1 }, clamped: false });
    expect(to({ name: 'www', type: 'A', ttl: 30, value: '203.0.113.9' })).toMatchObject({ ttl: 60, clamped: true });
    expect(to({ name: '@', type: 'MX', ttl: 3600, priority: 10, value: 'mail.example.com.' })).toMatchObject({ key: 'MX|example.com|mail.example.com', payload: { content: 'mail.example.com', priority: 10, ttl: 3600 }, priority: 10 });
    expect(to({ name: '_sip._tcp', type: 'SRV', ttl: null, priority: 10, value: '5 5060 sip.example.com.' }).payload).toEqual({ type: 'SRV', name: '_sip._tcp.example.com', ttl: 1, data: { priority: 10, weight: 5, port: 5060, target: 'sip.example.com' } });
    expect(to({ name: '@', type: 'CAA', ttl: null, value: '0 issue letsencrypt.org' }).payload).toEqual({ type: 'CAA', name: 'example.com', ttl: 1, data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' } });
    expect(to({ name: '@', type: 'TXT', ttl: null, value: 'v=spf1 +mx ~all' }).payload.content).toBe('v=spf1 +mx ~all');
  });

  it('canonicalises IPv6 addresses on both sides so an expanded panel value pairs with the compressed remote one', () => {
    expect(canonicalIpv6('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(canonicalIpv6('2001:db8::1')).toBe('2001:db8::1');
    expect(canonicalIpv6('not-an-ip')).toBe('not-an-ip');
    const to = toCloudflareRecord({ name: 'www', type: 'AAAA', ttl: null, value: '2001:db8:0:0:0:0:0:1' }, D);
    expect(to).toMatchObject({ key: 'AAAA|www.example.com|2001:db8::1', payload: { type: 'AAAA', name: 'www.example.com', content: '2001:db8::1', ttl: 1 } });
    const diff = diffRecords([{ name: 'www', type: 'AAAA', ttl: null, value: '2001:db8:0:0:0:0:0:1' }], [{ id: 'r1', type: 'AAAA', name: 'www.example.com', content: '2001:db8::1', ttl: 1 }], D);
    expect(diff).toMatchObject({ unchanged: 1, creates: [], updates: [], deletes: [] });
  });

  it('never compares or sends the TTL of a proxied record: Cloudflare pins it to Auto', () => {
    const remote = [{ id: 'r1', type: 'A', name: 'example.com', content: '203.0.113.9', ttl: 1, proxied: true }];
    const diff = diffRecords([{ name: '@', type: 'A', ttl: 3600, value: '203.0.113.9' }], remote, D);
    expect(diff).toMatchObject({ unchanged: 1, updates: [], creates: [], deletes: [], proxiedTtl: ['A example.com (ttl 3600)'] });
    const plain = diffRecords([{ name: '@', type: 'A', ttl: 3600, value: '203.0.113.9' }], [{ ...remote[0], proxied: false }], D);
    expect(plain.updates.map((u) => [u.remote.id, u.ttl, u.payload.ttl])).toEqual([['r1', 3600, 3600]]);
    expect(plain.proxiedTtl).toEqual([]);
  });

  it('computes a minimal diff by (type, name, content) and leaves unmanaged types alone', () => {
    const desired = [
      { name: '@', type: 'A', ttl: null, value: '203.0.113.9' },
      { name: 'www', type: 'A', ttl: 300, value: '203.0.113.9' },
      { name: '@', type: 'MX', ttl: null, priority: 20, value: 'mail.example.com.' },
      { name: '@', type: 'TXT', ttl: null, value: 'v=spf1 +mx ~all' },
      { name: 'new', type: 'CNAME', ttl: null, value: 'example.com.' },
    ];
    const remote = [
      { id: 'r1', type: 'A', name: 'example.com', content: '203.0.113.9', ttl: 1, proxied: true },
      { id: 'r2', type: 'A', name: 'www.example.com', content: '203.0.113.9', ttl: 1, proxied: true },
      { id: 'r3', type: 'MX', name: 'example.com', content: 'mail.example.com', priority: 10, ttl: 1 },
      { id: 'r4', type: 'TXT', name: 'example.com', content: '"v=spf1 +mx ~all"', ttl: 1 },
      { id: 'r5', type: 'A', name: 'old.example.com', content: '198.51.100.1', ttl: 1 },
      { id: 'r6', type: 'HTTPS', name: 'example.com', content: '1 . alpn="h2"', ttl: 1 },
    ];
    const diff = diffRecords(desired, remote, D);
    // r2 is proxied: its explicit panel TTL is ignored rather than re-pushed forever.
    expect(diff.unchanged).toBe(3);
    expect(diff.creates.map((c) => c.key)).toEqual(['CNAME|new.example.com|example.com']);
    expect(diff.updates.map((u) => [u.remote.id, u.ttl, u.priority])).toEqual([['r3', 1, 20]]);
    expect(diff.deletes.map((r) => r.id)).toEqual(['r5']);
    expect(diff.proxiedTtl).toEqual(['A www.example.com (ttl 300)']);
  });
});

describe('Cloudflare DNS API', () => {
  let app;
  let csrf;
  let resellerHttp;
  let resellerCsrf;
  let resellerId;
  let cf;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    app = await createTestApp({ agent: bindAgent() });
    delete app.ctx.web;
    csrf = await app.login();
    const reseller = await app.createUser('resell1', 'reseller');
    resellerId = reseller.id;
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', owner: 'resell1', provision: { dns: false, mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', provision: { dns: false, mail: false } }).expect(201);
    await app.http.post('/api/dns/zones').set('X-CSRF-Token', csrf).send({ domain: 'bob.com', ip: '203.0.113.9' }).expect(201);
    await app.http.post('/api/dns/zones').set('X-CSRF-Token', csrf).send({ domain: 'alice.com', ip: '203.0.113.10' }).expect(201);
    const { default: request } = await import('supertest');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
    app.ctx.settings.set('dns.cloudflare.retry_backoff_ms', [1, 1]);
    app.ctx.jobs.start();
  });
  afterAll(async () => { globalThis.fetch = realFetch; await app.close(); });
  // One fake account for the whole run: the tests build on each other's state.
  beforeAll(() => { cf = fakeCloudflare(); globalThis.fetch = cf.fetch; });
  beforeEach(() => { cf.state.calls.length = 0; cf.state.failNext.length = 0; delete app.ctx.web; });

  const post = (path, body = {}) => app.http.post(`/api/dns${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body) => app.http.put(`/api/dns${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/dns${path}`).set('X-CSRF-Token', csrf);
  const get = (path) => app.http.get(`/api/dns${path}`);
  const rpost = (path, body = {}) => resellerHttp.post(`/api/dns${path}`).set('X-CSRF-Token', resellerCsrf).send(body);
  const zoneRow = (domain) => app.ctx.db.prepare('SELECT * FROM dns_zones WHERE domain = ?').get(domain);
  const auditRows = () => app.ctx.db.prepare('SELECT action, target, args_redacted FROM audit_log').all();

  it('reports an unconfigured integration and refuses zone actions until a token exists', async () => {
    expect((await get('/cloudflare/status').expect(200)).body.data).toMatchObject({ configured: false, linked: [] });
    const res = await post('/zones/bob.com/cloudflare/link').expect(409);
    expect(res.body.error.code).toBe('cloudflare_not_configured');
    await get('/cloudflare/zones').expect(409);
  });

  it('verifies the token with Cloudflare before storing it, and never echoes it', async () => {
    const bad = await put('/cloudflare/token', { apiToken: 'wrong_token_ABCDEFGHIJKLMNOPQRSTUVWXYZ' }).expect(422);
    expect(bad.body.error.fields.apiToken).toBeTruthy();
    expect(bad.body.error.message).toMatch(/Authentication error/);
    expect((await get('/cloudflare/status').expect(200)).body.data.configured).toBe(false);
    await put('/cloudflare/token', { apiToken: 'short' }).expect(422);

    const start = cf.state.calls.length;
    const res = await put('/cloudflare/token', { apiToken: TOKEN }).expect(200);
    expect(res.body.data).toMatchObject({ configured: true, tokenId: 'tok1', accountId: 'acct1', accountName: 'Hostingsignal' });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    const calls = cf.state.calls.slice(start);
    expect(calls.map((c) => c.path)).toEqual(expect.arrayContaining(['/client/v4/user/tokens/verify', '/client/v4/zones?per_page=50&page=1']));
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    const row = app.ctx.db.prepare('SELECT * FROM dns_cloudflare_settings').get();
    expect(row.api_token_enc).toMatch(/^v1:/);
    expect(row.api_token_enc).not.toContain(TOKEN);
    expect(JSON.stringify(auditRows())).not.toContain(TOKEN);
    expect(auditRows().some((r) => r.action === 'dns.cloudflare.configure')).toBe(true);

    const status = await get('/cloudflare/status').expect(200);
    expect(JSON.stringify(status.body)).not.toContain(TOKEN);
    const mine = await resellerHttp.get('/api/dns/cloudflare/status').expect(200);
    expect(mine.body.data).toMatchObject({ configured: true });
    expect(mine.body.data.tokenId).toBeUndefined();
  });

  it('lists the account zones for root only, cached for a minute', async () => {
    const res = await get('/cloudflare/zones').expect(200);
    expect(res.body.data.map((z) => [z.name, z.linkedDomain, z.localZone])).toEqual([['bob.com', null, true], ['alice.com', null, true]]);
    const before = cf.state.calls.length;
    await get('/cloudflare/zones').expect(200);
    expect(cf.state.calls.length).toBe(before);
    await get('/cloudflare/zones?refresh=true').expect(200);
    expect(cf.state.calls.length).toBe(before + 1);
    await resellerHttp.get('/api/dns/cloudflare/zones').expect(403);
    await resellerHttp.put('/api/dns/cloudflare/token').set('X-CSRF-Token', resellerCsrf).send({ apiToken: TOKEN }).expect(403);
  });

  it('does not seed the zone cache from a partial first page', async () => {
    const extra = Array.from({ length: 60 }, (_, i) => ({ id: `${'f'.repeat(24)}${i.toString(16).padStart(8, '0')}`, name: `zone${i}.example`, status: 'active', paused: false, type: 'full', name_servers: [], account: { id: 'acct1', name: 'Hostingsignal' }, plan: { name: 'Free Website' } }));
    cf.state.zones.push(...extra);
    try {
      await put('/cloudflare/token', { apiToken: TOKEN }).expect(200);
      const start = cf.state.calls.length;
      const res = await get('/cloudflare/zones').expect(200);
      expect(res.body.data).toHaveLength(62);
      expect(cf.state.calls.slice(start).map((c) => c.path)).toEqual(['/client/v4/zones?per_page=50&page=1', '/client/v4/zones?per_page=50&page=2']);
    } finally {
      cf.state.zones.splice(2);
      await get('/cloudflare/zones?refresh=true').expect(200);
    }
    expect((await get('/cloudflare/zones').expect(200)).body.data).toHaveLength(2);
  });

  it('links a zone to its Cloudflare zone (root only): a reseller cannot link a zone root did not assign, but imports and pushes one root linked on their account', async () => {
    await rpost('/zones/bob.com/cloudflare/link').expect(403);
    // alice.com belongs to the reseller, yet the Cloudflare account is root's: linking is root's decision.
    await rpost('/zones/alice.com/cloudflare/link').expect(403);
    expect(zoneRow('bob.com').provider).toBe('bind');
    expect(zoneRow('alice.com').provider).toBe('bind');
    expect(auditRows().filter((r) => r.action === 'dns.cloudflare.link')).toEqual([]);
    const res = await post('/zones/bob.com/cloudflare/link').expect(200);
    expect(res.body.data).toMatchObject({ domain: 'bob.com', provider: 'cloudflare', cloudflareZoneId: BOB_ZONE, status: 'linked', remote: { name: 'bob.com', status: 'active' } });
    expect((await get('/zones/bob.com').expect(200)).body.data).toMatchObject({ provider: 'cloudflare', cloudflare_zone_id: BOB_ZONE });
    await post('/zones/alice.com/cloudflare/link', { cloudflareZoneId: BOB_ZONE }).expect(422);
    await post('/zones/alice.com/cloudflare/link', { cloudflareZoneId: 'nothex' }).expect(422);
    const mine = await post('/zones/alice.com/cloudflare/link').expect(200);
    expect(mine.body.data).toMatchObject({ provider: 'cloudflare', cloudflareZoneId: ALICE_ZONE });

    // Root linked it on the reseller's account: the reseller now follows, pushes and imports it, nothing more.
    const status = await resellerHttp.get('/api/dns/zones/alice.com/cloudflare').expect(200);
    expect(status.body.data).toMatchObject({ provider: 'cloudflare', cloudflareZoneId: ALICE_ZONE, canLink: false });
    expect((await resellerHttp.get('/api/dns/cloudflare/status').expect(200)).body.data.linked.map((z) => z.domain)).toEqual(['alice.com']);
    const pushed = await rpost('/zones/alice.com/cloudflare/push').expect(202);
    expect(pushed.body.data.job).toEqual({ id: expect.any(Number), status: expect.any(String), reused: false });
    const job = await waitForJob(app.ctx, pushed.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.created_by).toBe(resellerId);
    expect(cf.state.records[ALICE_ZONE].length).toBeGreaterThan(0);
    await resellerHttp.get(`/api/system/jobs/${job.id}`).expect(200);
    expect((await resellerHttp.post('/api/dns/zones/alice.com/cloudflare/import').set('X-CSRF-Token', resellerCsrf).expect(200)).body.data).toMatchObject({ status: 'ok' });
    await rpost('/zones/alice.com/cloudflare/unlink').expect(403);
    expect(zoneRow('alice.com').provider).toBe('cloudflare');
    await rpost('/zones/bob.com/cloudflare/push').expect(403);

    await post('/zones/alice.com/cloudflare/unlink').expect(200);
    expect(zoneRow('alice.com')).toMatchObject({ provider: 'bind', cloudflare_zone_id: null });
    cf.state.zones = cf.state.zones.filter((z) => z.name !== 'alice.com');
    await get('/cloudflare/zones?refresh=true').expect(200);
    await post('/zones/alice.com/cloudflare/link').expect(404);
    expect(auditRows().filter((r) => r.action === 'dns.cloudflare.link').map((r) => r.target)).toEqual(['bob.com', 'alice.com']);
    expect((await get('/cloudflare/status').expect(200)).body.data.linked.map((z) => z.domain)).toEqual(['bob.com']);
  });

  it('imports remote records into the zone, keeping the SOA and apex NS and skipping what BIND cannot hold', async () => {
    cf.state.records[BOB_ZONE] = [
      { id: 'c1', type: 'NS', name: 'bob.com', content: 'ada.ns.cloudflare.com', ttl: 1 },
      { id: 'c2', type: 'A', name: 'bob.com', content: '198.51.100.7', ttl: 1, proxied: true },
      { id: 'c3', type: 'AAAA', name: 'www.bob.com', content: '2001:db8::7', ttl: 600 },
      { id: 'c4', type: 'MX', name: 'bob.com', content: 'mx1.mailhost.net', priority: 5, ttl: 1 },
      { id: 'c5', type: 'TXT', name: 'bob.com', content: '"v=spf1 include:_spf.mailhost.net ~all"', ttl: 1 },
      { id: 'c6', type: 'SRV', name: '_sip._tcp.bob.com', content: '5 5060 sip.bob.com', data: { priority: 10, weight: 5, port: 5060, target: 'sip.bob.com' }, ttl: 1 },
      { id: 'c7', type: 'CAA', name: 'bob.com', content: '0 issue "letsencrypt.org"', data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' }, ttl: 1 },
      { id: 'c8', type: 'HTTPS', name: 'bob.com', content: '1 . alpn="h2"', ttl: 1 },
      { id: 'c9', type: 'CNAME', name: 'bob.com', content: 'target.example.net', ttl: 1 },
    ];
    const before = zoneRow('bob.com');
    const res = await post('/zones/bob.com/cloudflare/import').expect(200);
    expect(res.body.data).toMatchObject({ remote: 9, imported: 6, skipped: 3, status: 'ok', applied: true });
    expect(res.body.data.skippedRecords.map((s) => s.type).sort()).toEqual(['CNAME', 'HTTPS', 'NS']);
    const zone = (await get('/zones/bob.com').expect(200)).body.data;
    const find = (type, name = '@') => zone.records.find((r) => r.type === type && r.name === name);
    expect(zone.records.filter((r) => r.type === 'NS' && r.name === '@').length).toBeGreaterThan(0);
    expect(zone.records.filter((r) => r.type === 'NS' && r.name === '@').every((r) => !r.value.includes('cloudflare'))).toBe(true);
    expect(find('A')).toMatchObject({ value: '198.51.100.7', ttl: null });
    expect(find('AAAA', 'www')).toMatchObject({ value: '2001:db8::7', ttl: 600 });
    expect(find('MX')).toMatchObject({ value: 'mx1.mailhost.net.', priority: 5 });
    expect(find('TXT')).toMatchObject({ value: 'v=spf1 include:_spf.mailhost.net ~all' });
    expect(find('SRV', '_sip._tcp')).toMatchObject({ value: '5 5060 sip.bob.com.', priority: 10 });
    expect(find('CAA')).toMatchObject({ value: '0 issue letsencrypt.org' });
    expect(zone.soa.primary).toBeTruthy();
    expect(zone.serial).toBeGreaterThan(before.serial);
    expect(app.agent.callsTo('dns.zone.write').length).toBeGreaterThan(0);
    expect(app.ctx.jobs.list({ type: 'dns.cloudflare.push' }).filter((j) => j.params.domain === 'bob.com')).toEqual([]);
    expect(zoneRow('bob.com')).toMatchObject({ cloudflare_status: 'ok', cloudflare_last_error: null });
    expect(zoneRow('bob.com').cloudflare_synced_at).toBeTruthy();
    await rpost('/zones/bob.com/cloudflare/import').expect(403);
    await post('/zones/alice.com/cloudflare/import').expect(409);
  });

  it('mirrors every zone change to Cloudflare through a job with a minimal diff', async () => {
    cf.state.records[BOB_ZONE] = [
      { id: 'c2', type: 'A', name: 'bob.com', content: '198.51.100.7', ttl: 1, proxied: true },
      { id: 'c3', type: 'AAAA', name: 'www.bob.com', content: '2001:db8::7', ttl: 600, proxied: false },
      { id: 'c4', type: 'MX', name: 'bob.com', content: 'mx1.mailhost.net', priority: 5, ttl: 1 },
      { id: 'c5', type: 'TXT', name: 'bob.com', content: '"v=spf1 include:_spf.mailhost.net ~all"', ttl: 1 },
      { id: 'c6', type: 'SRV', name: '_sip._tcp.bob.com', content: '5 5060 sip.bob.com', data: { priority: 10, weight: 5, port: 5060, target: 'sip.bob.com' }, ttl: 1 },
      { id: 'c7', type: 'CAA', name: 'bob.com', content: '0 issue "letsencrypt.org"', data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' }, ttl: 1 },
      { id: 'c8', type: 'HTTPS', name: 'bob.com', content: '1 . alpn="h2"', ttl: 1 },
      { id: 'c10', type: 'A', name: 'stale.bob.com', content: '198.51.100.99', ttl: 1 },
    ];
    const added = await post('/zones/bob.com/records', { name: 'shop', type: 'CNAME', value: 'shops.example.net' }).expect(201);
    expect(added.body.data.mirror).toMatchObject({ provider: 'cloudflare' });
    const job = await waitForJob(app.ctx, added.body.data.mirror.jobId);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ created: 1, deleted: 1, updated: 0, unchanged: 6 });
    const remote = cf.state.records[BOB_ZONE];
    expect(remote.find((r) => r.type === 'CNAME' && r.name === 'shop.bob.com')).toMatchObject({ content: 'shops.example.net', ttl: 1, proxied: false });
    expect(remote.find((r) => r.id === 'c10')).toBeUndefined();
    expect(remote.find((r) => r.id === 'c8')).toBeTruthy();
    expect(zoneRow('bob.com')).toMatchObject({ cloudflare_status: 'ok', cloudflare_last_error: null });

    // A TTL change updates a DNS-only record in place and keeps its proxied flag.
    const records = (await get('/zones/bob.com').expect(200)).body.data.records;
    const wwwAAAA = records.find((r) => r.type === 'AAAA' && r.name === 'www');
    const updated = await put(`/zones/bob.com/records/${wwwAAAA.id}`, { ttl: 3600 }).expect(200);
    const job2 = await waitForJob(app.ctx, updated.body.data.mirror.jobId);
    expect(job2.result).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    expect(remote.find((r) => r.id === 'c3')).toMatchObject({ ttl: 3600, proxied: false, content: '2001:db8::7' });
    const patch = cf.state.calls.find((c) => c.method === 'PATCH');
    expect(patch.body).toMatchObject({ type: 'AAAA', name: 'www.bob.com', content: '2001:db8::7', ttl: 3600, proxied: false });

    // A proxied (orange-cloud) record keeps Cloudflare's Auto TTL: the panel's TTL is noted once, never re-pushed.
    const apexA = records.find((r) => r.type === 'A' && r.name === '@');
    cf.state.calls.length = 0;
    const proxied = await put(`/zones/bob.com/records/${apexA.id}`, { ttl: 7200 }).expect(200);
    const job2b = await waitForJob(app.ctx, proxied.body.data.mirror.jobId);
    expect(job2b.result).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 7 });
    expect(cf.state.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(remote.find((r) => r.id === 'c2')).toMatchObject({ ttl: 1, proxied: true });
    expect(job2b.logs.some((l) => /proxied records keep Cloudflare's Auto TTL.*A bob\.com \(ttl 7200\)/.test(l.line))).toBe(true);

    // Deleting the record removes it remotely; a manual push afterwards changes nothing.
    const shop = (await get('/zones/bob.com').expect(200)).body.data.records.find((r) => r.name === 'shop');
    const removed = await del(`/zones/bob.com/records/${shop.id}`).expect(200);
    await waitForJob(app.ctx, removed.body.data.mirror.jobId);
    expect(remote.find((r) => r.name === 'shop.bob.com')).toBeUndefined();
    const manual = await post('/zones/bob.com/cloudflare/push').expect(202);
    expect(manual.body.data.job).toEqual({ id: expect.any(Number), status: expect.any(String), reused: false });
    expect(manual.body.data.job.logs).toBeUndefined();
    const job3 = await waitForJob(app.ctx, manual.body.data.job.id);
    expect(job3.result).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    await rpost('/zones/bob.com/cloudflare/push').expect(403);
    expect(auditRows().filter((r) => r.action === 'dns.cloudflare.push').length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(auditRows())).not.toContain(TOKEN);
  });

  it('retries a failed push and records the last error on the zone', async () => {
    cf.state.failNext = [{ status: 503, code: 10000, message: 'temporarily unavailable' }, new TypeError('fetch failed')];
    const manual = await post('/zones/bob.com/cloudflare/push').expect(202);
    const job = await waitForJob(app.ctx, manual.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.logs.filter((l) => /attempt \d failed/.test(l.line)).length).toBe(2);
    expect(zoneRow('bob.com')).toMatchObject({ cloudflare_status: 'ok', cloudflare_last_error: null });

    app.ctx.settings.set('dns.cloudflare.push_attempts', 2);
    cf.state.failNext = [{ status: 429, code: 10000, message: 'rate limited' }, { status: 502, code: 1000, message: 'origin unreachable' }];
    const failing = await post('/zones/bob.com/cloudflare/push').expect(202);
    const failed = await waitForJob(app.ctx, failing.body.data.job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/origin unreachable/);
    expect(zoneRow('bob.com')).toMatchObject({ cloudflare_status: 'failed', cloudflare_last_error: 'Cloudflare: origin unreachable' });
    const status = await get('/zones/bob.com/cloudflare').expect(200);
    expect(status.body.data).toMatchObject({ provider: 'cloudflare', status: 'failed', lastError: 'Cloudflare: origin unreachable', configured: true });
    expect(status.body.data.log.slice(0, 2).map((l) => [l.action, l.status, l.attempt])).toEqual([['push', 'failed', 2], ['push', 'failed', 1]]);
    expect((await get('/cloudflare/status').expect(200)).body.data.failed).toBe(1);
    app.ctx.settings.set('dns.cloudflare.push_attempts', 3);
  });

  it('does not retry a deterministic Cloudflare answer (401/403/404/400) and fails after one attempt', async () => {
    cf.state.failNext = [{ status: 403, code: 9109, message: 'Unauthorized to access requested resource' }];
    const syncRows = () => app.ctx.db.prepare("SELECT COUNT(*) AS n FROM dns_cloudflare_sync WHERE domain = 'bob.com' AND action = 'push' AND status = 'failed'").get().n;
    const before = syncRows();
    const manual = await post('/zones/bob.com/cloudflare/push').expect(202);
    const job = await waitForJob(app.ctx, manual.body.data.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Unauthorized/);
    expect(job.logs.filter((l) => /attempt \d failed/.test(l.line)).map((l) => l.line)).toEqual([expect.stringMatching(/attempt 1 failed: .*not retried/)]);
    expect(syncRows()).toBe(before + 1);
    expect(cf.state.calls.filter((c) => c.path.includes('/dns_records'))).toHaveLength(1);
  });

  it("re-queues a rate-limited push as a new job instead of sleeping Cloudflare's Retry-After in a worker slot", async () => {
    cf.state.failNext = [{ status: 429, code: 10000, message: 'rate limited', retryAfter: 1 }];
    const manual = await post('/zones/bob.com/cloudflare/push').expect(202);
    const first = await waitForJob(app.ctx, manual.body.data.job.id);
    expect(first.status).toBe('failed');
    expect(first.error).toMatch(/rate limited — retry scheduled in 1 s/);
    expect(first.logs.some((l) => /attempt 2 of 3 runs in 1 s as a new job \(worker slot released\)/.test(l.line))).toBe(true);
    expect(app.ctx.jobs.runningCount()).toBe(0);
    const pending = (await get('/zones/bob.com/cloudflare').expect(200)).body.data;
    expect(pending).toMatchObject({ status: 'failed', pendingRetry: { attempt: 2 } });
    let retry = null;
    for (let i = 0; i < 60 && !retry; i++) {
      await new Promise((r) => setTimeout(r, 50));
      retry = app.ctx.jobs.list({ type: 'dns.cloudflare.push' }).find((j) => j.params.retryOf === first.id) ?? null;
    }
    expect(retry).toBeTruthy();
    expect(retry.params).toMatchObject({ domain: 'bob.com', attempt: 2, retryOf: first.id });
    expect(retry.created_by).toBe(first.created_by);
    const done = await waitForJob(app.ctx, retry.id);
    expect(done.status).toBe('done');
    expect(done.logs[0].line).toMatch(new RegExp(`retry 2 .*continuing job ${first.id}`));
    expect(app.ctx.db.prepare("SELECT attempt FROM dns_cloudflare_sync WHERE job_id = ? AND status = 'ok'").get(retry.id)).toEqual({ attempt: 2 });
    expect((await get('/zones/bob.com/cloudflare').expect(200)).body.data).toMatchObject({ status: 'ok', lastError: null, pendingRetry: null });
  });

  it('coalesces queued pushes for the same zone, but never hands one principal another\'s job', async () => {
    app.ctx.jobs.stop();
    const first = await post('/zones/bob.com/records', { name: 'a1', type: 'A', value: '198.51.100.21' }).expect(201);
    const second = await post('/zones/bob.com/records', { name: 'a2', type: 'A', value: '198.51.100.22' }).expect(201);
    expect(second.body.data.mirror.jobId).toBe(first.body.data.mirror.jobId);
    expect(zoneRow('bob.com').cloudflare_status).toBe('pending');
    // Root's queued job is not reused for a different principal: the jobs API would hide it from them.
    const other = app.ctx.dnsCloudflare.enqueuePush('bob.com', { reason: 'manual push by someone else', userId: resellerId });
    expect(other).toMatchObject({ reused: false });
    expect(other.id).not.toBe(first.body.data.mirror.jobId);
    expect(app.ctx.jobs.get(other.id).created_by).toBe(resellerId);
    expect(app.ctx.dnsCloudflare.enqueuePush('bob.com', { userId: resellerId })).toEqual({ id: other.id, reused: true });
    app.ctx.jobs.start();
    const job = await waitForJob(app.ctx, first.body.data.mirror.jobId);
    expect(job.result.created).toBe(2);
    expect((await waitForJob(app.ctx, other.id)).result).toMatchObject({ created: 0, deleted: 0 });
    expect(cf.state.records[BOB_ZONE].filter((r) => ['a1.bob.com', 'a2.bob.com'].includes(r.name)).length).toBe(2);
  });

  it('serialises pushes of one zone so a later edit never races an earlier listing', async () => {
    const remoteKeys = () => cf.state.records[BOB_ZONE].map((r) => remoteKey(r, 'bob.com')).filter(Boolean).sort();
    const panelKeys = async () => (await get('/zones/bob.com').expect(200)).body.data.records
      .filter((r) => r.type !== 'SOA' && !(r.type === 'NS' && r.name === '@'))
      .map((r) => toCloudflareRecord(r, 'bob.com').key).sort();
    // Job A's record listing is held while the record is deleted again; job B must wait for A.
    cf.state.delayNextListing = 300;
    const added = await post('/zones/bob.com/records', { name: 'racy', type: 'A', value: '198.51.100.44' }).expect(201);
    const jobA = added.body.data.mirror.jobId;
    const racy = (await get('/zones/bob.com').expect(200)).body.data.records.find((r) => r.name === 'racy');
    const removed = await del(`/zones/bob.com/records/${racy.id}`).expect(200);
    const jobB = removed.body.data.mirror.jobId;
    expect(jobB).not.toBe(jobA);
    expect(app.ctx.jobs.get(jobA).status).toBe('running');
    const a = await waitForJob(app.ctx, jobA);
    const b = await waitForJob(app.ctx, jobB);
    expect(a.status).toBe('done');
    expect(b.status).toBe('done');
    expect(a.result).toMatchObject({ created: 1 });
    expect(b.result).toMatchObject({ created: 0, deleted: 1 });
    expect(cf.state.records[BOB_ZONE].find((r) => r.name === 'racy.bob.com')).toBeUndefined();
    expect(remoteKeys()).toEqual(await panelKeys());
    expect(zoneRow('bob.com')).toMatchObject({ cloudflare_status: 'ok', cloudflare_last_error: null });
  });

  it('unlinks a zone (remote records untouched) and removes the token', async () => {
    const remoteBefore = cf.state.records[BOB_ZONE].length;
    const res = await post('/zones/bob.com/cloudflare/unlink').expect(200);
    expect(res.body.data).toMatchObject({ provider: 'bind', cloudflareZoneId: null });
    expect(cf.state.records[BOB_ZONE].length).toBe(remoteBefore);
    const added = await post('/zones/bob.com/records', { name: 'plain', type: 'A', value: '198.51.100.30' }).expect(201);
    expect(added.body.data.mirror).toBeNull();
    await post('/zones/bob.com/cloudflare/unlink').expect(409);
    await resellerHttp.delete('/api/dns/cloudflare/token').set('X-CSRF-Token', resellerCsrf).expect(403);
    expect((await del('/cloudflare/token').expect(200)).body.data).toMatchObject({ removed: true, configured: false });
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM dns_cloudflare_settings').get().n).toBe(0);
    expect(JSON.stringify(auditRows())).not.toContain(TOKEN);
  });
});

describe('Cloudflare zones on a host without BIND', () => {
  it('in production a linked zone stays editable and is pushed; an unlinked one still answers 501', async () => {
    const realFetch = globalThis.fetch;
    const cf = fakeCloudflare();
    globalThis.fetch = cf.fetch;
    const app = await createTestApp({ overrides: { env: 'production' } });
    try {
      const csrf = await app.login();
      app.ctx.settings.set('dns.cloudflare.retry_backoff_ms', [1, 1]);
      await app.http.put('/api/dns/cloudflare/token').set('X-CSRF-Token', csrf).send({ apiToken: TOKEN }).expect(200);
      // Zones cannot be created without BIND in production; seed one as an earlier BIND host would have.
      for (const domain of ['bob.com', 'alice.com']) {
        const { lastInsertRowid } = app.ctx.db.prepare('INSERT INTO dns_zones (domain, serial, ttl, type) VALUES (?, 2026010101, 14400, ?)').run(domain, 'master');
        app.ctx.db.prepare('INSERT INTO dns_records (zone_id, name, type, ttl, priority, value, line_index) VALUES (?, ?, ?, NULL, NULL, ?, ?)').run(lastInsertRowid, '@', 'SOA', `ns1.${domain}. hostmaster.${domain}. 3600 1800 1209600 86400`, 0);
        app.ctx.db.prepare('INSERT INTO dns_records (zone_id, name, type, ttl, priority, value, line_index) VALUES (?, ?, ?, NULL, NULL, ?, ?)').run(lastInsertRowid, '@', 'NS', `ns1.${domain}.`, 1);
      }
      await app.http.post('/api/dns/zones/bob.com/cloudflare/link').set('X-CSRF-Token', csrf).send({}).expect(200);
      const blocked = await app.http.post('/api/dns/zones/alice.com/records').set('X-CSRF-Token', csrf).send({ name: 'www', type: 'A', value: '203.0.113.5' }).expect(501);
      expect(blocked.body.error.code).toBe('capability_missing');
      app.ctx.jobs.start();
      const res = await app.http.post('/api/dns/zones/bob.com/records').set('X-CSRF-Token', csrf).send({ name: 'www', type: 'A', value: '203.0.113.5' }).expect(201);
      expect(res.body.data).toMatchObject({ applied: false, reason: 'capability_missing', mirror: { provider: 'cloudflare' } });
      const job = await waitForJob(app.ctx, res.body.data.mirror.jobId);
      expect(job.status).toBe('done');
      expect(cf.state.records[BOB_ZONE].map((r) => [r.type, r.name, r.content])).toEqual([['A', 'www.bob.com', '203.0.113.5']]);
      expect(app.agent.callsTo('dns.zone.write')).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
      await app.close();
    }
  });
});
