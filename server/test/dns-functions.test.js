import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { parseZone, renderZone, normalizeRecord, nextSerial, quoteTxt, checkConflicts } from '../src/services/dns-zonefile.js';
import { CapabilityError } from '../src/lib/errors.js';

// A mock agent that behaves like a host with BIND installed: named-checkzone
// passes, writes succeed and every call is recorded for assertions.
function bindAgent() {
  const agent = createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['named', 'rndc', 'named-checkzone', 'named-checkconf', 'dnssec-keygen', 'dnssec-signzone'].includes(n)])),
    'dns.layout': () => ({ installed: true, flavor: 'debian', zoneDir: '/etc/bind/zones', includeFile: '/etc/bind/named.conf.whm' }),
    'dns.zone.list': () => ({ installed: true, zones: [] }),
    'dns.zone.read': ({ domain }) => ({ domain, exists: false, body: null }),
    'dns.checkzone': ({ domain }) => ({ domain, ok: true, output: `zone ${domain}/IN: loaded serial 1`, serial: 1 }),
    'dns.zone.write': ({ domain }) => ({ domain, path: `/etc/bind/zones/${domain}.db`, stanzaAdded: true, includeAdded: false }),
    'dns.zone.remove': ({ domain }) => ({ domain, removed: [`/etc/bind/zones/${domain}.db`], stanzaRemoved: true }),
    'dns.reload': ({ domain }) => ({ method: 'rndc', domain: domain ?? null, output: '' }),
    'dns.resolve': ({ name, type }) => ({ name, type, servers: ['1.1.1.1'], answers: [], error: 'ENOTFOUND' }),
    'dns.dnssec.keygen': ({ domain }) => ({ domain, ksk: { name: 'K1', record: `${domain}. IN DNSKEY 257 3 13 abc` }, zsk: { name: 'K2', record: `${domain}. IN DNSKEY 256 3 13 def` }, ds: [`${domain}. IN DS 1 13 2 00`] }),
    'dns.dnssec.sign': ({ domain }) => ({ domain, signedPath: `/etc/bind/zones/${domain}.db.signed`, serial: null }),
    'dns.dnssec.status': ({ domain }) => ({
      domain, keyDir: `/etc/bind/zones/keys/${domain}`, hasKeys: true,
      ksk: { name: 'K1', file: `/etc/bind/zones/keys/${domain}/K1.key`, record: `${domain}. IN DNSKEY 257 3 13 abc` }, zsk: { name: 'K2', file: `/etc/bind/zones/keys/${domain}/K2.key`, record: `${domain}. IN DNSKEY 256 3 13 def` },
      ds: [`${domain}. IN DS 1 13 2 00`], signed: { exists: true, path: `/etc/bind/zones/${domain}.db.signed`, ageSeconds: 120, stale: false, serial: null },
    }),
    'dns.dnssec.remove': ({ domain }) => ({ domain, removed: true }),
    'dns.options.write': ({ ipv4, ipv6 }) => ({ file: '/etc/bind/named.conf.options', changed: true, directives: [ipv4 ? `query-source address ${ipv4};` : null, ipv6 ? `query-source-v6 address ${ipv6};` : null].filter(Boolean), checkconf: { ok: true, output: '' } }),
  });
  return agent;
}

describe('zone file helpers', () => {
  it('bumps serials in YYYYMMDDnn form', () => {
    const s = nextSerial(0);
    expect(String(s)).toMatch(/^\d{10}$/);
    expect(nextSerial(s)).toBe(s + 1);
    expect(nextSerial(2000010199)).toBe(s);
  });

  it('quotes TXT in 255-byte chunks with escapes', () => {
    expect(quoteTxt('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(quoteTxt('x'.repeat(300)).split('" "')).toHaveLength(2);
  });

  it('normalises records and rejects bad ones with field errors', () => {
    expect(normalizeRecord({ name: 'www.example.com.', type: 'a', value: '10.0.0.1' }, 'example.com')).toMatchObject({ name: 'www', type: 'A', value: '10.0.0.1', priority: null });
    expect(normalizeRecord({ name: '@', type: 'MX', priority: 10, value: 'mail.example.com' }, 'example.com').value).toBe('mail.example.com.');
    expect(normalizeRecord({ name: '_sip._tcp', type: 'SRV', priority: 10, value: '5 5060 sip' }, 'example.com').value).toBe('5 5060 sip.');
    expect(normalizeRecord({ name: '@', type: 'CAA', value: '0 issue "letsencrypt.org"' }, 'example.com').value).toBe('0 issue letsencrypt.org');
    for (const bad of [
      { name: '@', type: 'A', value: '999.1.1.1' }, { name: '@', type: 'AAAA', value: '10.0.0.1' }, { name: 'x', type: 'MX', value: 'mail' },
      { name: 'a;b', type: 'A', value: '10.0.0.1' }, { name: 'x', type: 'SRV', priority: 1, value: 'nope' }, { name: '@', type: 'CAA', value: '0 bogus x' },
      { name: 'www.other.com.', type: 'A', value: '10.0.0.1' }, { name: '@', type: 'TXT', value: '' }, { name: '@', type: 'NS', value: 'ns1 ns2' },
    ]) expect(() => normalizeRecord(bad, 'example.com'), JSON.stringify(bad)).toThrow(/validation/i);
  });

  it('round-trips a zone through render and parse', () => {
    const records = [
      { name: '@', type: 'SOA', ttl: null, priority: null, value: 'ns1.example.net. hostmaster.example.com. 3600 1800 1209600 86400' },
      { name: '@', type: 'NS', ttl: null, priority: null, value: 'ns1.example.net.' },
      { name: '@', type: 'A', ttl: 300, priority: null, value: '192.0.2.1' },
      { name: '@', type: 'MX', ttl: null, priority: 10, value: 'mail.example.com.' },
      { name: '@', type: 'TXT', ttl: null, priority: null, value: 'v=spf1 +mx "quoted" ~all' },
      { name: '_sip._tcp', type: 'SRV', ttl: null, priority: 5, value: '10 5060 sip.example.com.' },
      { name: '@', type: 'CAA', ttl: null, priority: null, value: '0 issue letsencrypt.org' },
    ];
    const text = renderZone({ domain: 'example.com', ttl: 14400, serial: 2026010101 }, records);
    const parsed = parseZone(text, 'example.com');
    expect(parsed.errors).toEqual([]);
    expect(parsed.serial).toBe(2026010101);
    expect(parsed.ttl).toBe(14400);
    const key = (r) => `${r.name}|${r.type}|${r.ttl}|${r.priority}|${r.value}`;
    expect(parsed.records.map(key).sort()).toEqual(records.map(key).sort());
  });

  it('flags CNAME conflicts', () => {
    const recs = [{ id: 1, name: 'www', type: 'CNAME', value: 'example.com.' }];
    expect(checkConflicts(recs, { name: 'www', type: 'A' })).toMatch(/CNAME/);
    expect(checkConflicts([], { name: '@', type: 'CNAME' })).toMatch(/apex/);
    expect(checkConflicts(recs, { name: 'mail', type: 'A' })).toBeNull();
  });
});

describe('DNS Functions API (BIND installed via mock agent)', () => {
  let app;
  let csrf;
  let reseller;
  let resellerHttp;
  let resellerCsrf;
  // The web category registers ctx.web at boot; these tests own it so the
  // 'pending' / 'applied' / 'failed' paths do not depend on which other
  // categories are loaded or whether Apache exists on the test host.
  let realWeb;

  beforeAll(async () => {
    app = await createTestApp({ agent: bindAgent() });
    realWeb = app.ctx.web;
    delete app.ctx.web;
    csrf = await app.login();
    reseller = await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', owner: 'resell1', provision: { dns: false, mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', provision: { dns: false, mail: false } }).expect(201);
    const { default: request } = await import('supertest');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
  });
  afterAll(() => { if (realWeb) app.ctx.web = realWeb; return app.close(); });
  beforeEach(() => { app.agent.calls.length = 0; delete app.ctx.web; });

  const post = (path, body) => app.http.post(`/api/dns${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body) => app.http.put(`/api/dns${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/dns${path}`).set('X-CSRF-Token', csrf);
  const get = (path) => app.http.get(`/api/dns${path}`);

  it('creates a zone from the standard template, validates, writes and reloads', async () => {
    const res = await post('/zones', { domain: 'bob.com', ip: '203.0.113.9' }).expect(201);
    expect(res.body.data).toMatchObject({ domain: 'bob.com', account: 'bob', applied: true, reloaded: true, dnssec_enabled: false });
    expect(res.body.data.records.some((r) => r.type === 'A' && r.name === '@' && r.value === '203.0.113.9')).toBe(true);
    expect(res.body.data.records.some((r) => r.type === 'MX' && r.priority === 0)).toBe(true);
    expect(app.agent.callsTo('dns.checkzone')).toHaveLength(1);
    expect(app.agent.callsTo('dns.zone.write')[0].args).toMatchObject({ domain: 'bob.com', signed: false });
    expect(app.agent.callsTo('dns.zone.write')[0].args.body).toContain('$ORIGIN bob.com.');
    expect(app.agent.callsTo('dns.reload')[0].args).toEqual({ domain: 'bob.com', reconfig: true });
    expect(res.body.data.reconfigured).toBe(true);
    expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'dns.zone.create' AND target = 'bob.com'").get()).toBeTruthy();
  });

  it('reloads without reconfig when the stanza is unchanged', async () => {
    app.agent.set('dns.zone.write', ({ domain }) => ({ domain, path: `/etc/bind/zones/${domain}.db`, existed: true, stanzaAdded: false, stanzaChanged: false, includeAdded: false }));
    const res = await post('/zones/bob.com/apply').expect(200);
    expect(res.body.data).toMatchObject({ applied: true, reconfigured: false, external: false });
    expect(app.agent.callsTo('dns.reload')[0].args).toEqual({ domain: 'bob.com', reconfig: false });
    app.agent.reset('dns.zone.write');
  });

  it('refuses duplicates, unknown templates and bad input', async () => {
    await post('/zones', { domain: 'bob.com' }).expect(409);
    await post('/zones', { domain: 'new.example', template: 'nope' }).expect(404);
    expect((await post('/zones', { domain: 'not a domain' }).expect(422)).body.error.fields.domain).toBeDefined();
    await post('/zones', { domain: 'x.com', ip: '1.2.3' }).expect(422);
    await post('/zones', { domain: 'x.com', bogus: 1 }).expect(422);
  });

  it('fails cleanly when named-checkzone rejects the rendered zone and leaves the database untouched', async () => {
    const zoneCount = () => app.ctx.db.prepare('SELECT COUNT(*) AS n FROM dns_zones').get().n;
    const before = zoneCount();
    app.agent.set('dns.checkzone', () => ({ ok: false, output: 'zone x/IN: NS has no address records' }));
    const res = await post('/zones', { domain: 'broken.test' }).expect(422);
    expect(res.body.error.fields.zone[0]).toMatch(/NS has no address/);
    expect(zoneCount()).toBe(before);
    expect(app.ctx.db.prepare('SELECT 1 FROM dns_zones WHERE domain = ?').get('broken.test')).toBeUndefined();
    expect(app.agent.callsTo('dns.zone.write')).toHaveLength(0);

    const zone = app.ctx.db.prepare('SELECT * FROM dns_zones WHERE domain = ?').get('bob.com');
    const records = app.ctx.db.prepare('SELECT * FROM dns_records WHERE zone_id = ? ORDER BY id').all(zone.id);
    await post('/zones/bob.com/records', { name: 'rejected', type: 'A', value: '203.0.113.99' }).expect(422);
    expect(app.ctx.db.prepare('SELECT * FROM dns_zones WHERE domain = ?').get('bob.com')).toEqual(zone);
    expect(app.ctx.db.prepare('SELECT * FROM dns_records WHERE zone_id = ? ORDER BY id').all(zone.id)).toEqual(records);
    await put('/zones/bob.com/ttl', { ttl: 1234 }).expect(422);
    expect(app.ctx.db.prepare('SELECT ttl, serial FROM dns_zones WHERE domain = ?').get('bob.com')).toEqual({ ttl: zone.ttl, serial: zone.serial });
    app.agent.reset('dns.checkzone');
    app.agent.set('dns.checkzone', ({ domain }) => ({ domain, ok: true, output: '' }));
    // The retry is not blocked by a half-created zone.
    await post('/zones', { domain: 'broken.test' }).expect(201);
    await del('/zones/broken.test').expect(200);
  });

  it('rolls back and answers 422 when the agent reports named-checkconf rejected the configuration', async () => {
    const zone = app.ctx.db.prepare('SELECT * FROM dns_zones WHERE domain = ?').get('bob.com');
    const count = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM dns_records WHERE zone_id = ?').get(zone.id).n;
    app.agent.set('dns.zone.write', Object.assign(new Error('named-checkconf rejected the configuration'), { agentError: true, code: 'config_invalid', details: { output: '/etc/bind/named.conf.whm:3: zone \'bob.com\': already exists' } }));
    const res = await post('/zones/bob.com/records', { name: 'dup', type: 'A', value: '203.0.113.98' }).expect(422);
    expect(res.body.error.fields.zone[0]).toMatch(/already exists/);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM dns_records WHERE zone_id = ?').get(zone.id).n).toBe(count);
    expect(app.ctx.db.prepare('SELECT serial FROM dns_zones WHERE id = ?').get(zone.id).serial).toBe(zone.serial);
    app.agent.fail('dns.zone.write', 'internal', 'agent connection lost');
    await post('/zones/bob.com/records', { name: 'dup', type: 'A', value: '203.0.113.98' }).expect(500);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM dns_records WHERE zone_id = ?').get(zone.id).n).toBe(count);
    app.agent.reset('dns.zone.write');
  });

  it('stores a blank TTL as "inherit" rather than 0', async () => {
    for (const ttl of [null, '']) {
      const res = await post('/zones/bob.com/records', { name: `inherit${ttl === null ? 'n' : 'e'}`, type: 'A', value: '203.0.113.42', ttl }).expect(201);
      expect(res.body.data.record.ttl).toBeNull();
      const line = app.agent.callsTo('dns.zone.write').pop().args.body.split('\n').find((l) => l.startsWith(`inherit${ttl === null ? 'n' : 'e'}`));
      expect(line).toMatch(/^inherit[ne]\s+IN\s+A\s+203\.0\.113\.42$/);
      await del(`/zones/bob.com/records/${res.body.data.record.id}`).expect(200);
    }
    const explicit = await post('/zones/bob.com/records', { name: 'explicit0', type: 'A', value: '203.0.113.43', ttl: 0 }).expect(201);
    expect(explicit.body.data.record.ttl).toBe(0);
    expect(app.agent.callsTo('dns.zone.write').pop().args.body).toMatch(/^explicit0\s+0\s+IN\s+A/m);
    const upd = await put(`/zones/bob.com/records/${explicit.body.data.record.id}`, { ttl: null }).expect(200);
    expect(upd.body.data.record.ttl).toBeNull();
    await del(`/zones/bob.com/records/${explicit.body.data.record.id}`).expect(200);
  });

  it('lists zones with pagination and search; resellers only see their own', async () => {
    const all = await get('/zones?pageSize=10').expect(200);
    expect(all.body.meta.total).toBeGreaterThanOrEqual(1);
    expect(all.body.data.find((z) => z.domain === 'bob.com')).toMatchObject({ account: 'bob', published: true });
    expect((await get('/zones?q=bob').expect(200)).body.data.map((z) => z.domain)).toEqual(['bob.com']);
    const mine = await resellerHttp.get('/api/dns/zones').expect(200);
    expect(mine.body.data.map((z) => z.domain)).not.toContain('bob.com');
    await app.http.get('/api/dns/zones?sort=drop;table').expect(422);
  });

  it('full record CRUD with validation, conflicts and serial bumps', async () => {
    const before = (await get('/zones/bob.com').expect(200)).body.data;
    expect(before.soa).toMatchObject({ refresh: 3600, serial: before.serial });
    const add = await post('/zones/bob.com/records', { name: 'shop', type: 'A', value: '203.0.113.10', ttl: 300 }).expect(201);
    expect(add.body.data.record).toMatchObject({ name: 'shop', type: 'A', ttl: 300 });
    expect(add.body.data.serial).toBeGreaterThan(before.serial);
    await post('/zones/bob.com/records', { name: 'shop', type: 'A', value: '203.0.113.10', ttl: 300 }).expect(409);
    await post('/zones/bob.com/records', { name: 'shop', type: 'CNAME', value: 'bob.com' }).expect(409);
    expect((await post('/zones/bob.com/records', { name: '@', type: 'MX', value: 'mail.bob.com' }).expect(422)).body.error.fields.priority).toBeDefined();
    expect((await post('/zones/bob.com/records', { name: 'x', type: 'A', value: '1.2.3.4; rm' }).expect(422)).body.error.fields.value).toBeDefined();
    await post('/zones/bob.com/records', { name: 'x', type: 'HINFO', value: 'x' }).expect(422);
    const srv = await post('/zones/bob.com/records', { name: '_sip._tcp', type: 'SRV', priority: 10, value: '5 5060 sip.bob.com' }).expect(201);
    expect(srv.body.data.record.value).toBe('5 5060 sip.bob.com.');
    const txt = await post('/zones/bob.com/records', { name: '@', type: 'TXT', value: 'hello "world"' }).expect(201);
    expect(app.agent.callsTo('dns.zone.write').pop().args.body).toContain('"hello \\"world\\""');
    const caa = await post('/zones/bob.com/records', { name: '@', type: 'CAA', value: '0 issue letsencrypt.org' }).expect(201);
    expect(app.agent.callsTo('dns.zone.write').pop().args.body).toContain('0 issue "letsencrypt.org"');

    const upd = await put(`/zones/bob.com/records/${add.body.data.record.id}`, { value: '203.0.113.11' }).expect(200);
    expect(upd.body.data.record.value).toBe('203.0.113.11');
    await put(`/zones/bob.com/records/${add.body.data.record.id}`, { value: 'bad' }).expect(422);
    await put('/zones/bob.com/records/999999', { value: '1.1.1.1' }).expect(404);
    await del(`/zones/bob.com/records/${txt.body.data.record.id}`).expect(200);
    await del(`/zones/bob.com/records/${caa.body.data.record.id}`).expect(200);
    await del(`/zones/bob.com/records/${txt.body.data.record.id}`).expect(404);
    const after = (await get('/zones/bob.com').expect(200)).body.data;
    expect(after.records.find((r) => r.id === srv.body.data.record.id)).toBeTruthy();
    expect(after.records.find((r) => r.type === 'TXT' && r.value.startsWith('hello'))).toBeUndefined();
  });

  it('edits the SOA and the zone TTL', async () => {
    const soa = await put('/zones/bob.com/soa', { primary: 'ns1.other.net', refresh: 7200 }).expect(200);
    expect(soa.body.data.soa).toMatchObject({ primary: 'ns1.other.net.', refresh: 7200, retry: 1800 });
    await put('/zones/bob.com/soa', { refresh: -1 }).expect(422);
    const ttl = await put('/zones/bob.com/ttl', { ttl: 600 }).expect(200);
    expect(ttl.body.data).toMatchObject({ ttl: 600, applied: true });
    expect(app.agent.callsTo('dns.zone.write').pop().args.body).toContain('$TTL 600');
    await put('/zones/bob.com/ttl', { ttl: 'abc' }).expect(422);
    const bulk = await post('/zones/ttl', { domains: ['bob.com', 'missing.com'], ttl: 900 }).expect(200);
    expect(bulk.body.data.results[0]).toMatchObject({ domain: 'bob.com', ttl: 900 });
    expect(bulk.body.data.results[1]).toMatchObject({ domain: 'missing.com', code: 'not_found' });
  });

  it('raw zone edit mode validates, replaces records and re-renders', async () => {
    const raw = await get('/zones/bob.com/raw').expect(200);
    expect(raw.body.data.body).toContain('$ORIGIN bob.com.');
    const bad = await post('/zones/bob.com/validate', { body: '$TTL 1h\n@ IN A nope\n' }).expect(200);
    expect(bad.body.data.ok).toBe(false);
    expect(bad.body.data.errors.join(' ')).toMatch(/SOA record missing/);
    await put('/zones/bob.com/raw', { body: '$TTL 1h\n@ IN A nope\n' }).expect(422);
    const text = '$ORIGIN bob.com.\n$TTL 3600\n@ IN SOA ns1.bob.com. hostmaster.bob.com. ( 1 7200 3600 1209600 300 )\n@ IN NS ns1.bob.com.\nns1 IN A 198.51.100.1\n@ IN A 198.51.100.1\n@ IN MX 10 mail.bob.com.\nmail IN A 198.51.100.2\n@ IN TXT "v=spf1 mx -all"\n';
    const saved = await put('/zones/bob.com/raw', { body: text }).expect(200);
    expect(saved.body.data.records.map((r) => r.type).sort()).toEqual(['A', 'A', 'A', 'MX', 'NS', 'TXT']);
    expect(saved.body.data.ttl).toBe(3600);
    expect(saved.body.data.soa.refresh).toBe(7200);
    expect(saved.body.data.serial).toBeGreaterThan(1);
    const applied = await post('/zones/bob.com/apply').expect(200);
    expect(applied.body.data.applied).toBe(true);
  });

  it('enforces reseller ownership on zones and records', async () => {
    await resellerHttp.get('/api/dns/zones/bob.com').expect(403);
    await resellerHttp.post('/api/dns/zones/bob.com/records').set('X-CSRF-Token', resellerCsrf).send({ name: 'x', type: 'A', value: '1.1.1.1' }).expect(403);
    await resellerHttp.post('/api/dns/zones').set('X-CSRF-Token', resellerCsrf).send({ domain: 'unowned.org' }).expect(403);
    const own = await resellerHttp.post('/api/dns/zones').set('X-CSRF-Token', resellerCsrf).send({ domain: 'alice.com' }).expect(201);
    expect(own.body.data.account).toBe('alice');
    await resellerHttp.get('/api/dns/zones/alice.com').expect(200);
    await resellerHttp.put('/api/dns/zones/alice.com/dnssec').set('X-CSRF-Token', resellerCsrf).send({ enabled: true }).expect(403);
    await resellerHttp.get('/api/dns/zones/alice.com/dnssec').expect(403);
    for (const path of ['/templates', '/hostname', '/cleanup', '/sync']) await resellerHttp.get(`/api/dns${path}`).expect(403);
    await resellerHttp.post('/api/dns/email/enable-all').set('X-CSRF-Token', resellerCsrf).send({}).expect(403);
  });

  it('manages zone templates with validation and preview', async () => {
    const list = await get('/templates').expect(200);
    expect(list.body.data.map((t) => t.name)).toEqual(expect.arrayContaining(['standard', 'minimal']));
    await post('/templates', { name: 'bad name!', body: 'x' }).expect(422);
    expect((await post('/templates', { name: 'nosoa', body: '$TTL 1\n@ IN A %ip%\n' }).expect(422)).body.error.fields.body[0]).toMatch(/SOA/);
    const body = '$TTL %ttl%\n@ IN SOA %ns1%. hostmaster.%domain%. ( %serial% 3600 1800 1209600 86400 )\n@ IN NS %ns1%.\n@ IN A %ip%\n';
    await post('/templates', { name: 'custom', body }).expect(201);
    await post('/templates', { name: 'custom', body }).expect(409);
    const preview = await post('/templates/custom/preview', { domain: 'demo.net', ip: '192.0.2.7' }).expect(200);
    expect(preview.body.data.body).toContain('demo.net');
    expect(preview.body.data.body).toContain('192.0.2.7');
    expect(preview.body.data.errors).toEqual([]);
    await put('/templates/custom', { body: `${body}www IN A %ip%\n` }).expect(200);
    expect((await get('/templates/custom').expect(200)).body.data.body).toContain('www IN A');
    const zone = await post('/zones', { domain: 'tpl.example', template: 'custom', ip: '192.0.2.8' }).expect(201);
    expect(zone.body.data.records.filter((r) => r.type === 'A')).toHaveLength(2);
    await del('/templates/standard').expect(400);
    await del('/templates/custom').expect(200);
    await get('/templates/custom').expect(404);
  });

  it('adds an A entry for the hostname, creating the zone when needed', async () => {
    app.ctx.settings.set('basic.hostname', 'panel.hostzone.test');
    app.ctx.settings.set('basic.main_ip', '203.0.113.50');
    const status = await get('/hostname').expect(200);
    expect(status.body.data).toMatchObject({ hostname: 'panel.hostzone.test', ip: '203.0.113.50', zone: null, suggestedZone: 'hostzone.test' });
    expect(status.body.data.resolves).toMatchObject({ matches: false });
    const res = await post('/hostname', {}).expect(200);
    expect(res.body.data).toMatchObject({ zone: 'hostzone.test', recordName: 'panel', createdZone: 'hostzone.test', applied: true });
    const zone = (await get('/zones/hostzone.test').expect(200)).body.data;
    expect(zone.records.find((r) => r.name === 'panel' && r.type === 'A').value).toBe('203.0.113.50');
    const again = await post('/hostname', { ip: '203.0.113.51' }).expect(200);
    expect(again.body.data.createdZone).toBeNull();
    expect((await get('/zones/hostzone.test')).body.data.records.filter((r) => r.name === 'panel')).toHaveLength(1);
    await post('/hostname', { ip: 'nope' }).expect(422);
    expect((await get('/hostname')).body.data.record.value).toBe('203.0.113.51');
  });

  it('generates SPF, DKIM (encrypted key) and DMARC records', async () => {
    const before = (await get('/zones/bob.com/email').expect(200)).body.data;
    expect(before.dkim).toBeNull();
    expect(before.suggestions.spf).toMatch(/^v=spf1 /);
    const spf = await put('/zones/bob.com/email/spf', { value: 'v=spf1 +mx +a ip4:198.51.100.1 -all' }).expect(200);
    expect(spf.body.data.spf.value).toBe('v=spf1 +mx +a ip4:198.51.100.1 -all');
    await put('/zones/bob.com/email/spf', { value: 'v=spf1 include:$(evil) -all' }).expect(422);
    const dkim = await post('/zones/bob.com/email/dkim', { selector: 'mail2026', bits: 1024 }).expect(200);
    expect(dkim.body.data.dkim).toMatchObject({ name: 'mail2026._domainkey', type: 'TXT', selector: 'mail2026' });
    expect(dkim.body.data.dkim.value).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/);
    expect(dkim.body.data.dkimResult.generated).toBe(true);
    const row = app.ctx.db.prepare('SELECT * FROM dkim_keys WHERE domain = ?').get('bob.com');
    expect(row.private_key_enc.startsWith('v1:')).toBe(true);
    expect(app.ctx.dns.getDkimKey('bob.com').privateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
    const same = await post('/zones/bob.com/email/dkim', { selector: 'mail2026' }).expect(200);
    expect(same.body.data.dkimResult.generated).toBe(false);
    const rotated = await post('/zones/bob.com/email/dkim', { selector: 'mail2026', bits: 1024, rotate: true }).expect(200);
    expect(rotated.body.data.dkim.value).not.toBe(dkim.body.data.dkim.value);
    expect((await get('/zones/bob.com').expect(200)).body.data.records.filter((r) => r.name.endsWith('._domainkey'))).toHaveLength(1);
    const dmarc = await put('/zones/bob.com/email/dmarc', { p: 'quarantine', rua: 'dmarc@bob.com', pct: 50, adkim: 's' }).expect(200);
    expect(dmarc.body.data.dmarc.value).toBe('v=DMARC1; p=quarantine; rua=mailto:dmarc@bob.com; pct=50; adkim=s');
    await put('/zones/bob.com/email/dmarc', { value: 'v=DMARC1; p=maybe' }).expect(422);
    await put('/zones/bob.com/email/dmarc', { p: 'bogus' }).expect(422);
    const overview = await get('/email').expect(200);
    expect(overview.body.data.find((z) => z.domain === 'bob.com')).toMatchObject({ spf: true, dkim: true, dmarc: true });
    await del('/zones/bob.com/email/dkim').expect(200);
    expect((await get('/zones/bob.com/email')).body.data.dkim).toBeNull();
    expect(app.ctx.dns.getDkimKey('bob.com')).toBeNull();
  });

  it('enables DKIM/SPF globally as a job', async () => {
    app.ctx.jobs.start();
    const res = await post('/email/enable-all', { dkim: true, spf: true, dmarc: true }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result.total).toBeGreaterThanOrEqual(3);
    expect(job.result.failed).toBe(0);
    for (const z of (await get('/email').expect(200)).body.data) expect(z, z.domain).toMatchObject({ spf: true, dkim: true, dmarc: true });
    expect(app.agent.callsTo('dns.reload').some((c) => Object.keys(c.args).length === 0)).toBe(true);
    await post('/email/enable-all', { dkim: 'yes' }).expect(422);
    app.ctx.jobs.stop();
  });

  it('configures email routing and MX records', async () => {
    const list = await get('/routing').expect(200);
    expect(list.body.data.find((r) => r.domain === 'bob.com').routing).toBe('auto');
    const remote = await put('/routing/bob.com', { routing: 'remote', exchanges: [{ priority: 10, exchange: 'aspmx.l.google.com' }, { priority: 20, exchange: 'alt1.aspmx.l.google.com' }] }).expect(200);
    expect(remote.body.data.mx.map((m) => m.value)).toEqual(['aspmx.l.google.com.', 'alt1.aspmx.l.google.com.']);
    expect(app.ctx.db.prepare('SELECT routing FROM mail_domains WHERE domain = ?').get('bob.com').routing).toBe('remote');
    await put('/routing/bob.com', { routing: 'remote' }).expect(422);
    await put('/routing/bob.com', { routing: 'elsewhere' }).expect(422);
    const backup = await put('/routing/bob.com', { routing: 'backup', exchanges: [{ priority: 10, exchange: 'mx.partner.net' }] }).expect(200);
    expect(backup.body.data.mx.map((m) => `${m.priority} ${m.value}`)).toEqual(['10 mx.partner.net.', '20 mail.bob.com.']);
    const local = await put('/routing/bob.com', { routing: 'local' }).expect(200);
    expect(local.body.data.mx).toHaveLength(1);
    expect(local.body.data.mx[0]).toMatchObject({ priority: 0, value: 'mail.bob.com.' });
    expect((await get('/routing?account=bob').expect(200)).body.data).toHaveLength(1);
    await resellerHttp.put('/api/dns/routing/bob.com').set('X-CSRF-Token', resellerCsrf).send({ routing: 'local' }).expect(403);
  });

  it('reports nameserver health using the resolver op', async () => {
    app.agent.set('dns.resolve', ({ name, type }) => {
      if (type === 'NS' && name === 'bob.com') return { name, type, servers: ['1.1.1.1'], answers: ['ns1.bob.com', 'ns9.elsewhere.net'], error: null };
      if (type === 'A' && name === 'ns1.bob.com') return { name, type, servers: ['1.1.1.1'], answers: ['198.51.100.1'], error: null };
      if (type === 'A' && name === 'bob.com') return { name, type, servers: ['1.1.1.1'], answers: ['198.51.100.1'], error: null };
      return { name, type, servers: ['1.1.1.1'], answers: [], error: 'ENOTFOUND' };
    });
    const res = await get('/nameserver-report?domain=bob.com').expect(200);
    const z = res.body.data.zones[0];
    expect(z.domain).toBe('bob.com');
    expect(z.zoneNs).toEqual(['ns1.bob.com.']);
    expect(z.delegatedNs).toEqual(['ns1.bob.com.', 'ns9.elsewhere.net.']);
    expect(z.status).toBe('error');
    expect(z.issues.map((i) => i.message).join('\n')).toMatch(/ns9\.elsewhere\.net\. is delegated/);
    expect(z.issues.map((i) => i.message).join('\n')).toMatch(/ns9\.elsewhere\.net\. does not resolve/);
    const all = await get('/nameserver-report?limit=2').expect(200);
    expect(all.body.data.zones.length).toBeLessThanOrEqual(2);
    await get('/nameserver-report?limit=0').expect(422);
    await resellerHttp.get('/api/dns/nameserver-report').expect(200);
  });

  it('parks and unparks domains onto accounts', async () => {
    const res = await post('/parked', { domain: 'bob-alias.com', account: 'bob' }).expect(201);
    expect(res.body.data).toMatchObject({ domain: 'bob-alias.com', account: 'bob', target: 'bob.com', web: 'pending' });
    expect(res.body.data.zone).toMatchObject({ domain: 'bob-alias.com', applied: true });
    expect(app.ctx.db.prepare('SELECT type FROM account_domains WHERE domain = ?').get('bob-alias.com').type).toBe('parked');
    await post('/parked', { domain: 'bob-alias.com', account: 'bob' }).expect(409);
    await post('/parked', { domain: 'bob.com', account: 'bob' }).expect(409);
    await post('/parked', { domain: 'x.com', account: 'nobody' }).expect(404);
    await resellerHttp.post('/api/dns/parked').set('X-CSRF-Token', resellerCsrf).send({ domain: 'y.com', account: 'bob' }).expect(403);
    const list = await get('/parked?account=bob').expect(200);
    expect(list.body.data).toEqual([expect.objectContaining({ domain: 'bob-alias.com', has_zone: true })]);
    const un = await del('/parked/bob-alias.com?removeZone=true').expect(200);
    expect(un.body.data).toMatchObject({ unparked: true, zoneRemoved: true, web: 'pending' });
    await get('/zones/bob-alias.com').expect(404);
    await del('/parked/bob-alias.com').expect(404);
  });

  it('parking leaves no row behind when the zone cannot be created, and treats a missing web server as pending', async () => {
    app.agent.set('dns.checkzone', () => ({ ok: false, output: 'bad zone' }));
    await post('/parked', { domain: 'bob-broken.com', account: 'bob' }).expect(422);
    expect(app.ctx.db.prepare('SELECT 1 FROM account_domains WHERE domain = ?').get('bob-broken.com')).toBeUndefined();
    expect(app.ctx.db.prepare('SELECT 1 FROM dns_zones WHERE domain = ?').get('bob-broken.com')).toBeUndefined();
    app.agent.reset('dns.checkzone');
    app.agent.set('dns.checkzone', ({ domain }) => ({ domain, ok: true, output: '' }));

    app.ctx.web = { addAlias: async () => { throw new CapabilityError('apache', 'Apache is not installed on this server'); }, removeAlias: async () => { throw new CapabilityError('apache', 'Apache is not installed on this server'); } };
    const pending = await post('/parked', { domain: 'bob-noapache.com', account: 'bob' }).expect(201);
    expect(pending.body.data).toMatchObject({ web: 'pending', webDetail: 'Apache is not installed on this server' });
    expect((await del('/parked/bob-noapache.com?removeZone=true').expect(200)).body.data.web).toBe('pending');

    const aliases = [];
    app.ctx.web = { addAlias: async (args) => { aliases.push(args); }, removeAlias: async (args) => { aliases.push({ removed: args }); } };
    const applied = await post('/parked', { domain: 'bob-apache.com', account: 'bob' }).expect(201);
    expect(applied.body.data.web).toBe('applied');
    expect(aliases[0]).toMatchObject({ username: 'bob', domain: 'bob.com', alias: 'bob-apache.com' });
    await del('/parked/bob-apache.com?removeZone=true').expect(200);
    expect(aliases[1].removed).toMatchObject({ username: 'bob', alias: 'bob-apache.com', domain: 'bob.com' });

    app.ctx.web = { addAlias: async () => { throw new Error('vhost write failed'); } };
    const failed = await post('/parked', { domain: 'bob-failed.com', account: 'bob' }).expect(201);
    expect(failed.body.data.web).toBe('failed: vhost write failed');
    delete app.ctx.web;
    await del('/parked/bob-failed.com?removeZone=true').expect(200);
  });

  it('finds and removes orphaned zones in a cleanup', async () => {
    await post('/zones', { domain: 'orphan.test' }).expect(201);
    const report = await get('/cleanup').expect(200);
    expect(report.body.data.orphans.map((o) => o.domain)).toContain('orphan.test');
    expect(report.body.data.orphans.map((o) => o.domain)).not.toContain('bob.com');
    expect(report.body.data.orphans.map((o) => o.domain)).not.toContain('hostzone.test');
    const res = await post('/cleanup', { domains: ['orphan.test', 'bob.com'] }).expect(200);
    expect(res.body.data.removed).toEqual([{ domain: 'orphan.test', removed: true }]);
    expect(res.body.data.skipped).toEqual(['bob.com']);
    expect(app.agent.callsTo('dns.zone.remove')).toHaveLength(1);
    await get('/zones/orphan.test').expect(404);
    await post('/cleanup', { all: 'yes' }).expect(422);
  });

  it('stores domain forwarding and applies it through ctx.web when present', async () => {
    const pending = await put('/forwarding/bob.com', { targetUrl: 'https://www.bob.com/' }).expect(200);
    expect(pending.body.data).toMatchObject({ domain: 'bob.com', status: 'pending', type: 'permanent', match_www: true, account: 'bob' });
    await put('/forwarding/bob.com', { targetUrl: 'ftp://x' }).expect(422);
    await put('/forwarding/bob.com', { targetUrl: 'not a url' }).expect(422);
    const calls = [];
    app.ctx.web = { setRedirects: async (domain, redirects) => { calls.push({ domain, redirects }); } };
    const applied = await post('/forwarding/apply').expect(200);
    expect(applied.body.data.results).toEqual([{ domain: 'bob.com', status: 'applied' }]);
    expect(calls[0]).toMatchObject({ domain: 'bob.com', redirects: [{ to: 'https://www.bob.com/', type: 'permanent' }] });
    const direct = await put('/forwarding/bob.com', { targetUrl: 'http://bob.example/', type: 'temporary', matchWww: false }).expect(200);
    expect(direct.body.data).toMatchObject({ status: 'applied', type: 'temporary', match_www: false });
    app.ctx.web = { setRedirects: async () => { throw new Error('vhost reload failed'); } };
    expect((await put('/forwarding/bob.com', { targetUrl: 'http://bob.example/' }).expect(200)).body.data).toMatchObject({ status: 'failed', last_error: 'vhost reload failed' });
    app.ctx.web = { setRedirects: async () => { throw new CapabilityError('apache', 'Apache is not installed on this server'); } };
    expect((await put('/forwarding/bob.com', { targetUrl: 'http://bob.example/' }).expect(200)).body.data).toMatchObject({ status: 'pending', last_error: 'Apache is not installed on this server' });
    expect((await post('/forwarding/apply').expect(200)).body.data.results).toEqual([{ domain: 'bob.com', status: 'pending' }]);
    delete app.ctx.web;
    expect((await get('/forwarding').expect(200)).body.data.map((f) => f.domain)).toEqual(['bob.com']);
    await resellerHttp.put('/api/dns/forwarding/bob.com').set('X-CSRF-Token', resellerCsrf).send({ targetUrl: 'https://x.y/' }).expect(403);
    await del('/forwarding/bob.com').expect(200);
    await del('/forwarding/bob.com').expect(404);
  });

  it('toggles DNSSEC through the agent, signs on publish and reconfigures named when the stanza flips to the signed file', async () => {
    // Behaves like the real op: the stanza changes exactly when `signed` flips.
    const stanzaSigned = {};
    app.agent.set('dns.zone.write', ({ domain, signed }) => {
      const changed = domain in stanzaSigned && stanzaSigned[domain] !== signed;
      stanzaSigned[domain] = signed;
      return { domain, path: `/etc/bind/zones/${domain}.db`, existed: true, external: false, stanzaAdded: false, stanzaChanged: changed, includeAdded: false };
    });
    await post('/zones/bob.com/apply').expect(200);
    const before = await get('/zones/bob.com/dnssec').expect(200);
    expect(before.body.data).toMatchObject({ domain: 'bob.com', dnssec_enabled: false, keys: false, ds: [], dnskey: null });
    expect(app.agent.callsTo('dns.dnssec.status')).toHaveLength(0);
    const on = await put('/zones/bob.com/dnssec', { enabled: true }).expect(200);
    expect(on.body.data).toMatchObject({ dnssec_enabled: true, keys: true, applied: true, reconfigured: true });
    expect(on.body.data.ds).toHaveLength(1);
    expect(app.agent.callsTo('dns.dnssec.keygen')).toHaveLength(1);
    expect(app.agent.callsTo('dns.zone.write').pop().args.signed).toBe(true);
    expect(app.agent.callsTo('dns.dnssec.sign')).toHaveLength(1);
    expect(app.agent.callsTo('dns.dnssec.sign')[0].args).toEqual({ domain: 'bob.com' });
    expect(app.agent.callsTo('dns.reload').pop().args).toEqual({ domain: 'bob.com', reconfig: true });
    // The DS/DNSKEY can be read back any time without touching the keys.
    const status = await get('/zones/bob.com/dnssec').expect(200);
    expect(status.body.data).toMatchObject({ dnssec_enabled: true, keys: true, ds: ['bob.com. IN DS 1 13 2 00'], dnskey: { ksk: 'bob.com. IN DNSKEY 257 3 13 abc', zsk: 'bob.com. IN DNSKEY 256 3 13 def' }, signed: { exists: true, ageSeconds: 120 }, keyDir: '/etc/bind/zones/keys/bob.com' });
    expect(app.agent.callsTo('dns.dnssec.status')).toEqual([{ name: 'dns.dnssec.status', args: { domain: 'bob.com' } }]);
    expect(app.agent.callsTo('dns.dnssec.keygen')).toHaveLength(1);
    app.agent.set('dns.dnssec.status', ({ domain }) => ({ domain, keyDir: `/etc/bind/zones/keys/${domain}`, hasKeys: false, ksk: null, zsk: null, ds: [], signed: { exists: false, path: `/etc/bind/zones/${domain}.db.signed`, ageSeconds: null, stale: true, serial: null } }));
    expect((await get('/zones/bob.com/dnssec').expect(200)).body.data).toMatchObject({ dnssec_enabled: true, keys: false, ds: [], dnskey: null });
    app.agent.reset('dns.dnssec.status'); // reset() also clears the recorded calls
    await get('/zones/nope.example/dnssec').expect(404);
    const rec = await post('/zones/bob.com/records', { name: 'signed', type: 'A', value: '198.51.100.9' }).expect(201);
    expect(rec.body.data.reconfigured).toBe(false);
    expect(app.agent.callsTo('dns.dnssec.sign')).toHaveLength(1);
    expect(app.agent.callsTo('dns.dnssec.keygen')).toHaveLength(0);
    expect(app.agent.callsTo('dns.reload').pop().args).toEqual({ domain: 'bob.com', reconfig: false });
    const off = await put('/zones/bob.com/dnssec', { enabled: false }).expect(200);
    expect(off.body.data).toMatchObject({ dnssec_enabled: false, reconfigured: true });
    expect(app.agent.callsTo('dns.dnssec.remove')).toHaveLength(1);
    app.agent.reset('dns.zone.write');
  });

  it('refuses DNSSEC on a zone declared outside the panel include and rolls the flag back', async () => {
    app.agent.set('dns.zone.write', ({ domain }) => ({ domain, path: `/etc/bind/db.${domain}`, existed: true, external: true, stanzaAdded: false, stanzaChanged: false, includeAdded: false }));
    const applied = await post('/zones/bob.com/apply').expect(200);
    expect(applied.body.data).toMatchObject({ applied: true, external: true, file: '/etc/bind/db.bob.com' });
    const res = await put('/zones/bob.com/dnssec', { enabled: true }).expect(422);
    expect(res.body.error.fields.dnssec[0]).toMatch(/panel-managed include/);
    expect(app.ctx.db.prepare('SELECT dnssec_enabled FROM dns_zones WHERE domain = ?').get('bob.com').dnssec_enabled).toBe(0);
    expect(app.agent.callsTo('dns.dnssec.sign')).toHaveLength(0);
    expect(app.agent.callsTo('dns.dnssec.remove')).toHaveLength(1);
    app.agent.reset('dns.zone.write');
  });

  it('answers 409 and rolls back when the hand-written stanza points named at a file the agent may not write', async () => {
    const zone = app.ctx.db.prepare('SELECT * FROM dns_zones WHERE domain = ?').get('bob.com');
    const count = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM dns_records WHERE zone_id = ?').get(zone.id).n;
    app.agent.set('dns.zone.write', Object.assign(new Error('bob.com is declared in named.conf outside the panel include with file "/srv/dns/bob.com.zone", which the agent may not write. Move the zone into the panel-managed include (or point the stanza at /etc/bind/zones/bob.com.db) so panel edits reach named.'), { agentError: true, code: 'zone_external', details: { file: '/srv/dns/bob.com.zone', type: 'master' } }));
    const res = await post('/zones/bob.com/records', { name: 'ext', type: 'A', value: '203.0.113.77' }).expect(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.message).toMatch(/\/srv\/dns\/bob\.com\.zone/);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM dns_records WHERE zone_id = ?').get(zone.id).n).toBe(count);
    expect(app.ctx.db.prepare('SELECT serial FROM dns_zones WHERE id = ?').get(zone.id).serial).toBe(zone.serial);
    expect(app.agent.callsTo('dns.reload')).toHaveLength(0);
    expect((await post('/zones', { domain: 'secondary.example' }).expect(409)).body.error.code).toBe('conflict');
    expect(app.ctx.db.prepare('SELECT 1 FROM dns_zones WHERE domain = ?').get('secondary.example')).toBeUndefined();
    app.agent.reset('dns.zone.write');
  });

  it('re-signs DNSSEC zones on a schedule through a serial bump and publish, skipping fresh signatures', async () => {
    expect(app.ctx.scheduler.list().find((s) => s.name === 'dns-resign')).toMatchObject({ job_type: 'dns.resign' });
    await put('/zones/bob.com/dnssec', { enabled: true }).expect(200);
    const serialBefore = app.ctx.db.prepare('SELECT serial FROM dns_zones WHERE domain = ?').get('bob.com').serial;
    app.agent.calls.length = 0;
    const status = (ageSeconds, stale = false) => ({ domain }) => ({ domain, keyDir: `/etc/bind/zones/keys/${domain}`, hasKeys: true, ksk: { record: 'k' }, zsk: { record: 'z' }, ds: [], signed: { exists: true, path: `/etc/bind/zones/${domain}.db.signed`, ageSeconds, stale, serial: serialBefore } });
    app.agent.set('dns.dnssec.status', status(8 * 86400));
    app.ctx.jobs.start();
    const job = await waitForJob(app.ctx, app.ctx.jobs.enqueue('dns.resign', {}, {}).id);
    app.ctx.jobs.stop();
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ total: 1, signed: 1, skipped: 0, failed: 0 });
    // The signed zone carries a serial secondaries have not seen: bump, write, sign, reload.
    const serialAfter = app.ctx.db.prepare('SELECT serial FROM dns_zones WHERE domain = ?').get('bob.com').serial;
    expect(serialAfter).toBeGreaterThan(serialBefore);
    expect(app.agent.callsTo('dns.dnssec.status')).toEqual([{ name: 'dns.dnssec.status', args: { domain: 'bob.com' } }]);
    expect(app.agent.callsTo('dns.zone.write')).toHaveLength(1);
    expect(app.agent.callsTo('dns.zone.write')[0].args.body).toContain(`${serialAfter}  ; serial`);
    expect(app.agent.callsTo('dns.dnssec.sign')).toEqual([{ name: 'dns.dnssec.sign', args: { domain: 'bob.com' } }]);
    expect(app.agent.callsTo('dns.reload')).toEqual([{ name: 'dns.reload', args: { domain: 'bob.com', reconfig: false } }]);
    app.agent.calls.length = 0;
    app.agent.set('dns.dnssec.status', status(60));
    app.ctx.jobs.start();
    const again = await waitForJob(app.ctx, app.ctx.jobs.enqueue('dns.resign', {}, {}).id);
    app.ctx.jobs.stop();
    expect(again.result).toMatchObject({ total: 1, signed: 0, skipped: 1 });
    expect(app.agent.callsTo('dns.dnssec.sign')).toHaveLength(0);
    expect(app.ctx.db.prepare('SELECT serial FROM dns_zones WHERE domain = ?').get('bob.com').serial).toBe(serialAfter);
    // Signed output older than the zone file is re-signed regardless of age; a failed publish restores the serial.
    app.agent.set('dns.dnssec.status', status(60, true));
    app.agent.set('dns.checkzone', () => ({ ok: false, output: 'zone bob.com/IN: broken' }));
    app.ctx.jobs.start();
    const failed = await waitForJob(app.ctx, app.ctx.jobs.enqueue('dns.resign', {}, {}).id);
    app.ctx.jobs.stop();
    expect(failed.result).toMatchObject({ total: 1, signed: 0, skipped: 0, failed: 1 });
    expect(app.ctx.db.prepare('SELECT serial FROM dns_zones WHERE domain = ?').get('bob.com').serial).toBe(serialAfter);
    app.agent.reset('dns.checkzone');
    app.agent.set('dns.checkzone', ({ domain }) => ({ domain, ok: true, output: '' }));
    app.agent.reset('dns.dnssec.status');
    await put('/zones/bob.com/dnssec', { enabled: false }).expect(200);
  });

  it('synchronises zones to cluster peers (job) and accepts imports from a master', async () => {
    const status = await get('/sync').expect(200);
    expect(status.body.data.clusters).toEqual([]);
    app.ctx.jobs.start();
    const none = await post('/sync', {}).expect(202);
    expect((await waitForJob(app.ctx, none.body.data.job.id)).result).toMatchObject({ peers: 0 });
    app.ctx.db.prepare("INSERT INTO dns_clusters (name, remote_host, api_token_enc, role) VALUES ('peer1', '127.0.0.1:1', ?, 'sync')").run(app.ctx.crypto.encrypt('tok'));
    const res = await post('/sync', { domains: ['bob.com'] }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id, 20000);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ peers: 1, zones: 1, ok: 0, failed: 1 });
    const after = await get('/sync').expect(200);
    expect(after.body.data.zones).toEqual([expect.objectContaining({ domain: 'bob.com', cluster: 'peer1', status: 'failed' })]);
    app.ctx.jobs.stop();

    const text = app.ctx.dns.renderZoneText('bob.com').replace('bob.com', 'peerzone.net').replace(/bob\.com/g, 'peerzone.net');
    const imported = await post('/zones/import', { domain: 'peerzone.net', body: text, serial: 5 }).expect(200);
    expect(imported.body.data.domain).toBe('peerzone.net');
    expect(imported.body.data.records.length).toBeGreaterThan(0);
    await post('/zones/import', { domain: 'peerzone.net', body: 'garbage' }).expect(422);
  });

  it('imports zone files already on disk into the database', async () => {
    app.agent.set('dns.zone.list', () => ({ installed: true, zones: [{ domain: 'legacy.net', path: '/etc/bind/zones/legacy.net.db', managed: false, exists: true }] }));
    app.agent.set('dns.zone.read', ({ domain }) => ({ domain, exists: true, body: '$TTL 7200\n@ IN SOA ns1.legacy.net. root.legacy.net. ( 2020010105 3600 1800 1209600 86400 )\n@ IN NS ns1.legacy.net.\nns1 IN A 192.0.2.77\n' }));
    const zone = (await get('/zones/legacy.net').expect(200)).body.data;
    expect(zone).toMatchObject({ domain: 'legacy.net', serial: 2020010105, ttl: 7200 });
    expect(zone.records.find((r) => r.name === 'ns1').value).toBe('192.0.2.77');
    const raw = await get('/zones/legacy.net/raw').expect(200);
    expect(raw.body.data.inSync).toBe(false);
    app.agent.reset('dns.zone.list');
    app.agent.reset('dns.zone.read');
  });

  it('deletes a zone and removes it from disk', async () => {
    await del('/zones/tpl.example').expect(200);
    expect(app.agent.callsTo('dns.zone.remove')[0].args).toEqual({ domain: 'tpl.example' });
    await get('/zones/tpl.example').expect(404);
    await del('/zones/tpl.example').expect(404);
  });

  it('refuses to delete a zone named serves from a hand-written stanza and keeps the row', async () => {
    await post('/zones', { domain: 'handwritten.example' }).expect(201);
    app.agent.calls.length = 0;
    app.agent.set('dns.zone.remove', Object.assign(new Error('handwritten.example is declared in named.conf outside the panel include (file "/etc/bind/db.handwritten"); named would keep serving it.'), { agentError: true, code: 'zone_external', details: { file: '/etc/bind/db.handwritten', type: 'master' } }));
    const res = await del('/zones/handwritten.example').expect(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.message).toMatch(/db\.handwritten/);
    expect(app.ctx.db.prepare('SELECT 1 FROM dns_zones WHERE domain = ?').get('handwritten.example')).toBeTruthy();
    expect(app.agent.callsTo('dns.reload')).toHaveLength(0);
    expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'dns.zone.delete' AND target = 'handwritten.example'").get()).toBeUndefined();
    // An op answering external:true (instead of throwing) is treated the same way.
    app.agent.set('dns.zone.remove', ({ domain }) => ({ domain, removed: [], stanzaRemoved: false, external: true }));
    await del('/zones/handwritten.example').expect(409);
    expect(app.ctx.db.prepare('SELECT 1 FROM dns_zones WHERE domain = ?').get('handwritten.example')).toBeTruthy();
    app.agent.reset('dns.zone.remove');
    await del('/zones/handwritten.example').expect(200);
    await get('/zones/handwritten.example').expect(404);
  });

  it('disabling DNSSEC publishes the unsigned zone before removing the keys, and keeps them when the publish fails', async () => {
    await put('/zones/bob.com/dnssec', { enabled: true }).expect(200);
    app.agent.calls.length = 0;
    app.agent.set('dns.checkzone', () => ({ ok: false, output: 'zone bob.com/IN: broken' }));
    await put('/zones/bob.com/dnssec', { enabled: false }).expect(422);
    expect(app.ctx.db.prepare('SELECT dnssec_enabled FROM dns_zones WHERE domain = ?').get('bob.com').dnssec_enabled).toBe(1);
    expect(app.agent.callsTo('dns.dnssec.remove')).toHaveLength(0);
    app.agent.reset('dns.checkzone');
    app.agent.set('dns.checkzone', ({ domain }) => ({ domain, ok: true, output: '' }));
    app.agent.calls.length = 0;
    const off = await put('/zones/bob.com/dnssec', { enabled: false }).expect(200);
    expect(off.body.data.dnssec_enabled).toBe(false);
    const order = app.agent.calls.map((c) => c.name);
    expect(order.indexOf('dns.zone.write')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('dns.dnssec.remove')).toBeGreaterThan(order.indexOf('dns.zone.write'));
    expect(order.indexOf('dns.dnssec.remove')).toBeGreaterThan(order.indexOf('dns.reload'));
    expect(app.agent.callsTo('dns.zone.write').pop().args.signed).toBe(false);
    expect(app.agent.callsTo('dns.dnssec.sign')).toHaveLength(0);
  });

  it('applies the outbound source address to named for Configure Remote Service IPs and exposes the layout', async () => {
    const applied = await app.ctx.dns.setOutboundAddresses({ ipv4: '203.0.113.9', ipv6: null });
    expect(applied).toMatchObject({ applied: true, changed: true, reloaded: true, file: '/etc/bind/named.conf.options' });
    expect(app.agent.callsTo('dns.options.write')[0].args).toEqual({ ipv4: '203.0.113.9', ipv6: null });
    expect(app.agent.callsTo('dns.reload').pop().args).toEqual({ reconfig: true });
    expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'dns.outbound_addresses'").get()).toBeTruthy();
    app.agent.set('dns.options.write', () => ({ file: '/etc/bind/named.conf.options', changed: false, directives: [], checkconf: null }));
    app.agent.calls.length = 0;
    expect(await app.ctx.dns.setOutboundAddresses({ ipv4: null, ipv6: null })).toMatchObject({ applied: true, changed: false, reloaded: false });
    expect(app.agent.callsTo('dns.reload')).toHaveLength(0);
    app.agent.set('dns.options.write', Object.assign(new Error('named-checkconf rejected the configuration'), { agentError: true, code: 'config_invalid', details: {} }));
    await expect(app.ctx.dns.setOutboundAddresses({ ipv4: '203.0.113.9' })).rejects.toMatchObject({ code: 'config_invalid' });
    app.agent.reset('dns.options.write');
    expect(await app.ctx.dns.layout()).toMatchObject({ installed: true, flavor: 'debian' });
  });

  it('accepts provider-style SPF mechanisms and rejects control characters in TXT and DMARC values', async () => {
    for (const value of ['v=spf1 a:mail.example.net include:_spf.google.com ~all', 'v=spf1 mx:%{d}.spf.example.net ptr:example.net exists:%{i}.spf.example.net -all', 'v=spf1 a/24 mx:mx.example.net/24//64 ip4:198.51.100.0/24 ip6:2001:db8::/32 redirect=_spf.example.net']) {
      const res = await put('/zones/bob.com/email/spf', { value }).expect(200);
      expect(res.body.data.spf.value).toBe(value);
    }
    for (const value of ['v=spf1 include:$(evil) -all', 'v=spf1 a:mail;rm -all', 'v=spf1 "quoted" -all', 'v=spf2 mx -all']) await put('/zones/bob.com/email/spf', { value }).expect(422);
    expect((await post('/zones/bob.com/records', { name: 'ctl', type: 'TXT', value: 'line1\nline2' }).expect(422)).body.error.fields.value).toBeDefined();
    expect((await post('/zones/bob.com/records', { name: 'ctl', type: 'TXT', value: 'tab\there' }).expect(422)).body.error.fields.value).toBeDefined();
    expect((await put('/zones/bob.com/email/dmarc', { value: 'v=DMARC1; p=none; rua=mailto:a@b.c\n@ IN A 1.2.3.4' }).expect(422)).body.error.fields.value).toBeDefined();
    expect(app.agent.callsTo('dns.checkzone').length).toBe(3);
  });

  it('reports the effective routing for "auto" and lets resellers validate only their own domains', async () => {
    await put('/routing/bob.com', { routing: 'remote', exchanges: [{ priority: 10, exchange: 'aspmx.l.google.com' }] }).expect(200);
    const auto = await put('/routing/bob.com', { routing: 'auto' }).expect(200);
    expect(auto.body.data).toMatchObject({ routing: 'auto', effective: 'remote' });
    expect((await get('/routing').expect(200)).body.data.find((r) => r.domain === 'bob.com')).toMatchObject({ routing: 'auto', effective: 'remote' });
    await put('/routing/bob.com', { routing: 'backup', exchanges: [{ priority: 10, exchange: 'mx.partner.net' }] }).expect(200);
    expect((await put('/routing/bob.com', { routing: 'auto' }).expect(200)).body.data.effective).toBe('backup');
    await put('/routing/bob.com', { routing: 'local' }).expect(200);
    expect((await put('/routing/bob.com', { routing: 'auto' }).expect(200)).body.data.effective).toBe('local');
    const body = '$TTL 60\n@ IN SOA a. b. 1 1 1 1 1\n@ IN A 10.0.0.1\n';
    await resellerHttp.post('/api/dns/zones/unowned-validate.org/validate').set('X-CSRF-Token', resellerCsrf).send({ body }).expect(403);
    await resellerHttp.post('/api/dns/zones/bob.com/validate').set('X-CSRF-Token', resellerCsrf).send({ body }).expect(403);
    await resellerHttp.post('/api/dns/zones/alice.com/validate').set('X-CSRF-Token', resellerCsrf).send({ body }).expect(200);
    await resellerHttp.post('/api/dns/zones/sub.alice.com/validate').set('X-CSRF-Token', resellerCsrf).send({ body }).expect(200);
    await post('/zones/unowned-validate.org/validate', { body }).expect(200);
  });

  it('the scheduled sync skips zones a peer already acknowledged at the current serial; a manual push resends them', async () => {
    const zone = app.ctx.db.prepare('SELECT * FROM dns_zones WHERE domain = ?').get('bob.com');
    const peer = app.ctx.db.prepare("INSERT INTO dns_clusters (name, remote_host, api_token_enc, role) VALUES ('peer-skip', '127.0.0.1:1', ?, 'write-only')").run(app.ctx.crypto.encrypt('tok'));
    app.ctx.db.prepare("INSERT INTO dns_zone_sync (zone_id, cluster_id, serial, status, message) VALUES (?, ?, ?, 'ok', NULL)").run(zone.id, peer.lastInsertRowid, zone.serial);
    app.ctx.jobs.start();
    const scheduled = await waitForJob(app.ctx, app.ctx.jobs.enqueue('dns.sync', { domains: null, clusterId: Number(peer.lastInsertRowid) }, {}).id, 20000);
    expect(scheduled.result).toMatchObject({ peers: 1, skipped: 1, ok: 0, failed: scheduled.result.zones - 1 });
    const manual = await post('/sync', { clusterId: Number(peer.lastInsertRowid), domains: ['bob.com'] }).expect(202);
    const pushed = await waitForJob(app.ctx, manual.body.data.job.id, 20000);
    expect(pushed.result).toMatchObject({ peers: 1, zones: 1, skipped: 0, failed: 1 });
    app.ctx.jobs.stop();
    app.ctx.db.prepare('DELETE FROM dns_clusters WHERE id = ?').run(peer.lastInsertRowid);
  });

  it('uses the serial a peer pushed as the floor when importing', async () => {
    const text = app.ctx.dns.renderZoneText('bob.com').replace(/bob\.com/g, 'floor.example');
    const imported = await post('/zones/import', { domain: 'floor.example', body: text, serial: 2099123199 }).expect(200);
    expect(imported.body.data.serial).toBe(2099123199);
    await del('/zones/floor.example').expect(200);
  });
});

describe('DNS Functions API without BIND', () => {
  it('in production every publish path answers 501 capability_missing before touching the database', async () => {
    const app = await createTestApp({ overrides: { env: 'production' } });
    const csrf = await app.login();
    const res = await app.http.post('/api/dns/zones').set('X-CSRF-Token', csrf).send({ domain: 'prod.test' }).expect(501);
    expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'bind' });
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM dns_zones').get().n).toBe(0);
    await app.http.post('/api/dns/hostname').set('X-CSRF-Token', csrf).send({}).expect(501);
    await app.http.post('/api/dns/email/enable-all').set('X-CSRF-Token', csrf).send({}).expect(501);
    await app.http.get('/api/dns/templates').expect(200);
    await app.http.get('/api/dns/zones').expect(200);
    await app.close();
  });

  it('in development the panel records zones and reports them unpublished', async () => {
    const app = await createTestApp();
    const csrf = await app.login();
    const res = await app.http.post('/api/dns/zones').set('X-CSRF-Token', csrf).send({ domain: 'dev.test', ip: '10.0.0.1' }).expect(201);
    expect(res.body.data).toMatchObject({ domain: 'dev.test', applied: false, reason: 'capability_missing', published: false });
    expect(app.agent.callsTo('dns.zone.write')).toHaveLength(0);
    const rec = await app.http.post('/api/dns/zones/dev.test/records').set('X-CSRF-Token', csrf).send({ name: 'app', type: 'A', value: '10.0.0.2' }).expect(201);
    expect(rec.body.data.applied).toBe(false);
    const validate = await app.http.post('/api/dns/zones/dev.test/validate').set('X-CSRF-Token', csrf).send({ body: '$TTL 60\n@ IN SOA a. b. 1 1 1 1 1\n@ IN A 10.0.0.1\n' }).expect(200);
    expect(validate.body.data).toMatchObject({ ok: true, checkzone: null });
    const dnssec = await app.http.put('/api/dns/zones/dev.test/dnssec').set('X-CSRF-Token', csrf).send({ enabled: true }).expect(501);
    expect(dnssec.body.error.code).toBe('capability_missing');
    expect((await app.http.get('/api/dns/zones/dev.test/dnssec').expect(200)).body.data).toMatchObject({ dnssec_enabled: false, keys: false, ds: [] });
    // A zone flagged as signed (e.g. the DB came from another host) cannot report its keys without BIND.
    app.ctx.db.prepare('UPDATE dns_zones SET dnssec_enabled = 1 WHERE domain = ?').run('dev.test');
    expect((await app.http.get('/api/dns/zones/dev.test/dnssec').expect(501)).body.error).toMatchObject({ code: 'capability_missing', capability: 'bind' });
    app.ctx.db.prepare('UPDATE dns_zones SET dnssec_enabled = 0 WHERE domain = ?').run('dev.test');
    const cleanup = await app.http.get('/api/dns/cleanup').expect(200);
    expect(cleanup.body.data).toMatchObject({ bindInstalled: false, unmanaged: [] });
    await app.http.delete('/api/dns/zones/dev.test').set('X-CSRF-Token', csrf).expect(200);
    await app.close();
  });
});
