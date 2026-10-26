import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { CapabilityError } from '../src/lib/errors.js';
import { canonical, parseCidr, enumerateRange, nextFreeInCidr, netmaskToPrefix, prefixToNetmask, cidrContains, bigIntToIpv6, ipv6ToBigInt } from '../src/services/ip-math.js';

// A mock agent that behaves like a host with iproute2: eth0 carries a main IPv4
// and an IPv6, `ip addr add/del` mutate an in-memory table and every call is
// recorded for assertions.
function netAgent() {
  const system = new Map([
    ['203.0.113.10', { family: 4, prefix: 24, iface: 'eth0' }],
    ['2001:db8:ffff::10', { family: 6, prefix: 64, iface: 'eth0' }],
  ]);
  const list = () => ({
    source: 'iproute2',
    interfaces: [
      { name: 'lo', index: 1, state: 'UNKNOWN', up: true, loopback: true, mac: null, mtu: 65536, addresses: [{ address: '127.0.0.1', family: 4, prefix: 8, netmask: '255.0.0.0', scope: 'host', label: 'lo' }] },
      { name: 'eth0', index: 2, state: 'UP', up: true, loopback: false, mac: '02:42:ac:11:00:02', mtu: 1500, addresses: [
        ...[...system].map(([address, s]) => ({ address, family: s.family, prefix: s.prefix, netmask: s.family === 4 ? prefixToNetmask(s.prefix) : null, scope: 'global', label: s.label ?? null, dynamic: Boolean(s.dynamic), temporary: Boolean(s.temporary), deprecated: false })),
        { address: 'fe80::42:acff:fe11:2', family: 6, prefix: 64, netmask: null, scope: 'link', label: null },
      ] },
    ],
  });
  const agent = createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['ip', 'systemctl'].includes(n)])),
    'net.ip.list': list,
    'net.route.default': () => ({ source: 'iproute2', ipv4: { gateway: '203.0.113.1', dev: 'eth0', prefsrc: '203.0.113.10', metric: 100 }, ipv6: { gateway: 'fe80::1', dev: 'eth0', prefsrc: null, metric: 1024 } }),
    'net.ip.add': ({ address, prefix, iface, label }) => {
      const existed = system.has(address);
      if (!existed) system.set(address, { family: address.includes(':') ? 6 : 4, prefix, iface, label: label ? `${iface}:${label}` : null });
      return { address, prefix, iface, label: label ? `${iface}:${label}` : null, added: !existed, existed };
    },
    'net.ip.del': ({ address, prefix, iface }) => {
      if (address === '203.0.113.10') throw Object.assign(new Error('default route source'), { agentError: true, code: 'refused' });
      const existed = system.delete(address);
      return { address, prefix, iface, removed: existed, existed };
    },
    'net.persist.read': () => ({ path: '/etc/whm/ips.json', exists: false, addresses: [], unitExists: false }),
    'net.persist.write': ({ addresses }) => ({ path: '/etc/whm/ips.json', unitPath: '/etc/systemd/system/whm-ips.service', count: addresses.length, daemonReloaded: true, enabled: true, systemd: true }),
  });
  agent.system = system;
  agent.list = list;
  return agent;
}

describe('ip-math helpers', () => {
  it('canonicalises IPv6 and converts both ways', () => {
    expect(canonical('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(canonical('::ffff:192.0.2.1')).toBe('::ffff:c000:201');
    expect(bigIntToIpv6(ipv6ToBigInt('2001:db8:0:0:1:0:0:1'))).toBe('2001:db8::1:0:0:1');
    expect(bigIntToIpv6(0n)).toBe('::');
    expect(canonical('10.0.0.1')).toBe('10.0.0.1');
    expect(() => canonical('nope')).toThrow(RangeError);
  });

  it('computes CIDR bounds, membership and free addresses', () => {
    const c = parseCidr('2001:db8:1::/64');
    expect(c).toMatchObject({ family: 6, prefix: 64, first: '2001:db8:1::', last: '2001:db8:1:0:ffff:ffff:ffff:ffff', network: '2001:db8:1::/64' });
    expect(c.size).toBe(2n ** 64n);
    expect(parseCidr('203.0.113.77/24')).toMatchObject({ network: '203.0.113.0/24', first: '203.0.113.0', last: '203.0.113.255' });
    expect(cidrContains('2001:db8:1::/64', '2001:db8:1::abcd')).toBe(true);
    expect(cidrContains('2001:db8:1::/64', '2001:db8:2::1')).toBe(false);
    expect(nextFreeInCidr('2001:db8:1::/64', ['2001:db8:1::1', '2001:db8:1::3'], { count: 3 })).toEqual(['2001:db8:1::2', '2001:db8:1::4', '2001:db8:1::5']);
    expect(() => parseCidr('2001:db8::/129')).toThrow(RangeError);
    expect(() => parseCidr('1.2.3.4/33')).toThrow(RangeError);
  });

  it('enumerates bounded ranges and converts netmasks', () => {
    expect(enumerateRange('203.0.113.1', '203.0.113.3')).toEqual(['203.0.113.1', '203.0.113.2', '203.0.113.3']);
    expect(() => enumerateRange('203.0.113.3', '203.0.113.1')).toThrow(/before/);
    expect(() => enumerateRange('203.0.113.0', '203.0.114.0', { max: 10 })).toThrow(/maximum/);
    expect(() => enumerateRange('203.0.113.1', '2001:db8::1')).toThrow(/same family/);
    expect(netmaskToPrefix('255.255.255.0')).toBe(24);
    expect(netmaskToPrefix('/26')).toBe(26);
    expect(netmaskToPrefix('255.0.255.0')).toBeNull();
    expect(prefixToNetmask(0)).toBe('0.0.0.0');
  });
});

describe('IP Functions API (iproute2 present via mock agent)', () => {
  let app;
  let csrf;
  let reseller;
  let resellerHttp;
  let resellerCsrf;

  const post = (path, body) => app.http.post(`/api/ip${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body) => app.http.put(`/api/ip${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/ip${path}`).set('X-CSRF-Token', csrf);
  const get = (path) => app.http.get(`/api/ip${path}`);

  beforeAll(async () => {
    app = await createTestApp({ agent: netAgent() });
    csrf = await app.login();
    reseller = await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', owner: 'resell1', ip: '203.0.113.10' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.10' }).expect(201);
    const { default: request } = await import('supertest');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('rebuilds the pool from the live interfaces and marks the main IP', async () => {
    const res = await post('/pool/rebuild').expect(200);
    expect(res.body.data).toMatchObject({ main: '203.0.113.10', source: 'iproute2' });
    expect(res.body.data.added.sort()).toEqual(['2001:db8:ffff::10', '203.0.113.10']);
    expect(res.body.data.states).toMatchObject({ main: 1 });
    const pool = await get('/pool').expect(200);
    expect(pool.body.data.find((p) => p.address === '203.0.113.10')).toMatchObject({ state: 'main', on_system: true, in_db: true });
    expect(pool.body.data.find((p) => p.address === '2001:db8:ffff::10').state).toBe('free');
    expect(pool.body.meta.lastRebuild).toBeTruthy();
    expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'ip.pool.rebuild'").get()).toBeTruthy();
  });

  it('lists bound addresses with live state, protection and account counts', async () => {
    const res = await get('/addresses').expect(200);
    const main = res.body.data.find((a) => a.address === '203.0.113.10');
    expect(main).toMatchObject({ family: 4, netmask: '255.255.255.0', prefix: 24, interface: 'eth0', is_main: true, protected: true, bound: true, accounts: 2 });
    expect(res.body.meta).toMatchObject({ mainIp: '203.0.113.10', iproute2: true, source: 'iproute2' });
    expect(res.body.meta.unmanaged).toEqual([]);
    expect((await get('/addresses?family=6').expect(200)).body.data.map((a) => a.address)).toEqual(['2001:db8:ffff::10']);
    await get('/addresses?family=5').expect(422);
    const ifaces = await get('/interfaces').expect(200);
    expect(ifaces.body.data.interfaces.map((i) => i.name)).toEqual(['eth0']);
    expect(ifaces.body.data.suggested.ipv4).toBe('eth0');
  });

  it('adds a single address, labels it, records and persists it', async () => {
    const res = await post('/addresses', { address: '203.0.113.11', netmask: '255.255.255.0' }).expect(201);
    expect(res.body.data.added).toHaveLength(1);
    expect(res.body.data.added[0]).toMatchObject({ address: '203.0.113.11', prefix: 24, netmask: '255.255.255.0', interface: 'eth0', bound: true, alreadyBound: false, is_main: false });
    // The imported secondary IPv6 is persisted too; only the main IP is left out.
    expect(res.body.data.persisted).toMatchObject({ count: 2, enabled: true });
    const add = app.agent.callsTo('net.ip.add')[0].args;
    expect(add).toMatchObject({ address: '203.0.113.11', prefix: 24, iface: 'eth0' });
    expect(add.label).toMatch(/^whm\d+$/);
    const persisted = app.agent.callsTo('net.persist.write')[0].args.addresses;
    expect(persisted).toEqual(expect.arrayContaining([expect.objectContaining({ address: '203.0.113.11', prefix: 24, iface: 'eth0' }), expect.objectContaining({ address: '2001:db8:ffff::10', prefix: 64 })]));
    expect(persisted.map((a) => a.address)).not.toContain('203.0.113.10');
    expect(app.agent.system.has('203.0.113.11')).toBe(true);
    expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'ip.add' AND target = '203.0.113.11'").get()).toBeTruthy();
  });

  it('adds a range, skipping addresses that already exist', async () => {
    const res = await post('/addresses', { address: '203.0.113.20', endAddress: '203.0.113.23', prefix: 24, interface: 'eth0', reserved: true, reservedReason: 'future customer' }).expect(201);
    expect(res.body.data.added.map((a) => a.address)).toEqual(['203.0.113.20', '203.0.113.21', '203.0.113.22', '203.0.113.23']);
    expect(res.body.data.added.every((a) => a.reserved && a.reserved_reason === 'future customer')).toBe(true);
    expect(app.agent.callsTo('net.ip.add')).toHaveLength(4);
    const again = await post('/addresses', { address: '203.0.113.23', endAddress: '203.0.113.24', prefix: 24 }).expect(201);
    expect(again.body.data.added.map((a) => a.address)).toEqual(['203.0.113.24']);
    expect(again.body.data.failed).toEqual([expect.objectContaining({ address: '203.0.113.23', code: 'conflict' })]);
    await post('/addresses', { address: '203.0.113.24' }).expect(409);
  });

  it('validates add input', async () => {
    expect((await post('/addresses', { address: 'not-an-ip' }).expect(422)).body.error.fields.address).toBeDefined();
    await post('/addresses', { address: '203.0.113.30', netmask: '255.0.255.0' }).expect(422);
    await post('/addresses', { address: '203.0.113.30', netmask: '255.255.255.0; rm' }).expect(422);
    await post('/addresses', { address: '203.0.113.30', interface: 'eth0;reboot' }).expect(422);
    expect((await post('/addresses', { address: '203.0.113.30', interface: 'eth9' }).expect(422)).body.error.fields.interface[0]).toMatch(/eth0/);
    await post('/addresses', { address: '203.0.113.30', bogus: 1 }).expect(422);
    expect((await post('/addresses', { address: '203.0.113.30', endAddress: '203.0.113.29' }).expect(422)).body.error.fields.endAddress).toBeDefined();
    await post('/addresses', { address: '10.0.0.0', endAddress: '10.0.2.0' }).expect(422);
    await post('/addresses', { address: '127.0.0.5' }).expect(422);
    await post('/addresses', { address: '203.0.113.30', prefix: 40 }).expect(422);
    expect(app.agent.callsTo('net.ip.add')).toHaveLength(0);
  });

  it('adds an IPv6 address with a /64 default', async () => {
    const res = await post('/addresses', { address: '2001:DB8:FFFF::11' }).expect(201);
    expect(res.body.data.added[0]).toMatchObject({ address: '2001:db8:ffff::11', family: 6, prefix: 64, netmask: '64' });
    expect(app.agent.callsTo('net.ip.add')[0].args).toMatchObject({ address: '2001:db8:ffff::11', prefix: 64, iface: 'eth0' });
    expect(app.agent.callsTo('net.ip.add')[0].args.label).toBeUndefined();
  });

  it('protects the main IP and in-use addresses from deletion', async () => {
    expect((await del('/addresses/203.0.113.10').expect(400)).body.error.message).toMatch(/main IP/);
    app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username = ?').run('203.0.113.24', 'bob');
    const inUse = await del('/addresses/203.0.113.24').expect(409);
    expect(inUse.body.error.message).toMatch(/account bob/);
    app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username = ?').run('203.0.113.10', 'bob');
    app.ctx.settings.set('basic.shared_ip', '203.0.113.21');
    expect((await del('/addresses/203.0.113.21').expect(409)).body.error.message).toMatch(/shared virtual host IP/);
    app.ctx.settings.set('basic.shared_ip', '');
    expect(app.agent.callsTo('net.ip.del')).toHaveLength(0);
    await del('/addresses/not-an-ip').expect(422);
    await del('/addresses/198.51.100.99').expect(404);
  });

  it('deletes a free address from the interface and the inventory', async () => {
    const res = await del('/addresses/203.0.113.24').expect(200);
    expect(res.body.data).toMatchObject({ address: '203.0.113.24', deleted: true, removedFromSystem: true, wasBound: true });
    expect(app.agent.callsTo('net.ip.del')[0].args).toEqual({ address: '203.0.113.24', prefix: 24, iface: 'eth0' });
    expect(app.agent.system.has('203.0.113.24')).toBe(false);
    expect(app.agent.callsTo('net.persist.write')[0].args.addresses.map((a) => a.address)).not.toContain('203.0.113.24');
    await del('/addresses/203.0.113.24').expect(404);
    expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'ip.delete' AND target = '203.0.113.24'").get()).toBeTruthy();
  });

  it('refuses to delete when the host interfaces cannot be read, so nothing drifts', async () => {
    app.agent.fail('net.ip.list', 'timeout', 'agent timed out');
    const res = await del('/addresses/203.0.113.23').expect(503);
    expect(res.body.error).toMatchObject({ code: 'service_unavailable' });
    expect(res.body.error.message).toMatch(/interfaces/);
    app.agent.set('net.ip.list', app.agent.list);
    expect(app.agent.callsTo('net.ip.del')).toHaveLength(0);
    expect(app.agent.callsTo('net.persist.write')).toHaveLength(0);
    expect(app.ctx.db.prepare('SELECT 1 FROM ip_addresses WHERE address = ?').get('203.0.113.23')).toBeTruthy();
    expect(app.agent.system.has('203.0.113.23')).toBe(true);
  });

  it('reports usage per address and scopes it for resellers', async () => {
    app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username = ?').run('203.0.113.11', 'alice');
    const res = await get('/usage').expect(200);
    const byAddr = Object.fromEntries(res.body.data.map((r) => [r.address, r]));
    expect(byAddr['203.0.113.10']).toMatchObject({ status: 'main', account_count: 1 });
    expect(byAddr['203.0.113.11']).toMatchObject({ status: 'shared', account_count: 1 });
    expect(byAddr['203.0.113.11'].accounts[0]).toMatchObject({ username: 'alice', owner: 'resell1' });
    expect(byAddr['203.0.113.20'].status).toBe('reserved');
    expect(byAddr['2001:db8:ffff::10'].status).toBe('free');
    expect(res.body.meta.summary).toMatchObject({ main: 1, reserved: 4, shared: 1 });
    app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username = ?').run('198.51.100.5', 'bob');
    const unknown = (await get('/usage').expect(200)).body.data.find((r) => r.address === '198.51.100.5');
    expect(unknown).toMatchObject({ status: 'unknown', unknown: true, account_count: 1 });
    app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username = ?').run('203.0.113.10', 'bob');
    const mine = await resellerHttp.get('/api/ip/usage').expect(200);
    expect(mine.body.data.map((r) => r.address)).toEqual(['203.0.113.11']);
    expect(mine.body.meta.mainIp).toBeNull();
    app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username = ?').run('203.0.113.10', 'alice');
  });

  it('reserves and releases addresses with protection for main and in-use ones', async () => {
    const list = await get('/reserved').expect(200);
    expect(list.body.data.find((r) => r.address === '203.0.113.10')).toMatchObject({ reservable: false, is_main: true });
    expect(list.body.data.find((r) => r.address === '203.0.113.11')).toMatchObject({ reservable: true, reserved: false });
    const on = await put('/reserved/203.0.113.11', { reserved: true, reason: 'spare' }).expect(200);
    expect(on.body.data).toMatchObject({ reserved: true, reserved_reason: 'spare' });
    expect((await put('/reserved/203.0.113.10', { reserved: true }).expect(400)).body.error.message).toMatch(/main IP/);
    app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username = ?').run('203.0.113.22', 'bob');
    await put('/reserved/203.0.113.22', { reserved: true }).expect(409);
    app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username = ?').run('203.0.113.10', 'bob');
    await put('/reserved/203.0.113.11', { reserved: 'yes' }).expect(422);
    await put('/reserved/198.51.100.1', { reserved: true }).expect(404);
    const bulk = await put('/reserved', { items: [{ address: '203.0.113.11', reserved: false }, { address: '203.0.113.10', reserved: true }] }).expect(200);
    expect(bulk.body.data.results[0]).toMatchObject({ address: '203.0.113.11', ok: true });
    expect(bulk.body.data.results[1]).toMatchObject({ address: '203.0.113.10', ok: false, code: 'bad_request' });
    expect((await get('/reserved')).body.data.find((r) => r.address === '203.0.113.11').reserved).toBe(false);
  });

  it('manages IPv6 ranges with validation, overlap detection and account mapping', async () => {
    expect((await post('/ipv6/ranges', { name: 'customers', range: '203.0.113.0/24' }).expect(422)).body.error.fields.range).toBeDefined();
    await post('/ipv6/ranges', { name: 'customers', range: '2001:db8:1::/64; rm' }).expect(422);
    await post('/ipv6/ranges', { name: 'customers', range: '2001:db8:1::/127' }).expect(422);
    await post('/ipv6/ranges', { name: 'bad name!', range: '2001:db8:1::/64' }).expect(422);
    const created = await post('/ipv6/ranges', { name: 'customers', range: '2001:DB8:1::/64', notes: 'first block' }).expect(201);
    expect(created.body.data).toMatchObject({ name: 'customers', range_cidr: '2001:db8:1::/64', first_address: '2001:db8:1::', last_address: '2001:db8:1:0:ffff:ffff:ffff:ffff', enabled: true, prefix: 64, account_count: 0 });
    await post('/ipv6/ranges', { name: 'customers', range: '2001:db8:2::/64' }).expect(409);
    await post('/ipv6/ranges', { name: 'dupe', range: '2001:db8:1::/64' }).expect(409);
    expect((await post('/ipv6/ranges', { name: 'overlap', range: '2001:db8:1:0:abcd::/80' }).expect(409)).body.error.message).toMatch(/overlaps/);
    const second = await post('/ipv6/ranges', { name: 'resellers', range: '2001:db8:2::/64', enabled: false, interface: 'eth0' }).expect(201);
    const list = await get('/ipv6/ranges').expect(200);
    expect(list.body.data.map((r) => r.name)).toEqual(['customers', 'resellers']);
    const id = created.body.data.id;
    const upd = await put(`/ipv6/ranges/${id}`, { notes: 'renamed block', enabled: false }).expect(200);
    expect(upd.body.data).toMatchObject({ enabled: false, notes: 'renamed block' });
    await put(`/ipv6/ranges/${id}`, { enabled: true }).expect(200);
    await put(`/ipv6/ranges/${id}`, { name: 'resellers' }).expect(409);
    await put(`/ipv6/ranges/${id}`, { range: 'nope' }).expect(422);
    const mapped = await put(`/ipv6/ranges/${id}/accounts`, { accounts: ['alice', 'bob'] }).expect(200);
    expect(mapped.body.data.accounts).toEqual(['alice', 'bob']);
    await put(`/ipv6/ranges/${id}/accounts`, { accounts: ['nobody'] }).expect(404);
    await put(`/ipv6/ranges/${id}/accounts`, { accounts: ['bad user'] }).expect(422);
    const preview = await get(`/ipv6/ranges/${id}/preview?count=3`).expect(200);
    expect(preview.body.data.next).toEqual(['2001:db8:1::1', '2001:db8:1::2', '2001:db8:1::3']);
    await get(`/ipv6/ranges/${id}/preview?count=0`).expect(422);
    await get('/ipv6/ranges/9999').expect(404);
    await del(`/ipv6/ranges/${second.body.data.id}`).expect(200);
    await del(`/ipv6/ranges/${second.body.data.id}`).expect(404);
  });

  it('assigns an IPv6 address from a range, binds it and updates DNS + web', async () => {
    await app.http.post('/api/dns/zones').set('X-CSRF-Token', csrf).send({ domain: 'alice.com' }).expect(201);
    const webCalls = [];
    app.ctx.web = { setAccountIpv6: async (username, address) => { webCalls.push({ username, address }); } };
    const res = await post('/ipv6/assign', { account: 'alice' }).expect(201);
    expect(res.body.data).toMatchObject({ account: 'alice', address: '2001:db8:1::1', range: 'customers', interface: 'eth0', prefix: 64, bound: true, web: 'applied' });
    expect(res.body.data.dns.results).toEqual([{ domain: 'alice.com', status: 'updated' }]);
    expect(app.agent.callsTo('net.ip.add')[0].args).toEqual({ address: '2001:db8:1::1', prefix: 64, iface: 'eth0' });
    expect(webCalls).toEqual([{ username: 'alice', address: '2001:db8:1::1' }]);
    const zone = (await app.http.get('/api/dns/zones/alice.com').expect(200)).body.data;
    expect(zone.records.filter((r) => r.type === 'AAAA').map((r) => `${r.name}=${r.value}`).sort()).toEqual(['@=2001:db8:1::1', 'www=2001:db8:1::1']);
    expect(app.ctx.db.prepare('SELECT dedicated_to FROM ip_addresses WHERE address = ?').get('2001:db8:1::1').dedicated_to).toBeTruthy();
    await post('/ipv6/assign', { account: 'alice' }).expect(409);
    const listed = await get('/ipv6/assignments').expect(200);
    expect(listed.body.data).toEqual([expect.objectContaining({ account: 'alice', address: '2001:db8:1::1', range: 'customers' })]);
    expect(app.ctx.ip.ipv6For(app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get('alice').id)).toBe('2001:db8:1::1');

    const explicit = await post('/ipv6/assign', { account: 'bob', address: '2001:db8:1::beef' }).expect(201);
    expect(explicit.body.data.address).toBe('2001:db8:1::beef');
    expect((await get('/ipv6/ranges').expect(200)).body.data[0]).toMatchObject({ assigned_count: 2 });
    await del('/ipv6/assignments/bob').expect(200);
    await post('/ipv6/assign', { account: 'bob', address: '2001:db8:9::1' }).expect(422);
    await post('/ipv6/assign', { account: 'bob', address: '2001:db8:1::1' }).expect(409);
    await post('/ipv6/assign', { account: 'nobody' }).expect(404);
    await post('/ipv6/assign', { account: 'bob', address: '1.2.3.4' }).expect(422);
    expect((await del('/ipv6/ranges/1').expect(409)).body.error.message).toMatch(/alice/);
    delete app.ctx.web;
  });

  it('lets resellers manage IPv6 for their own accounts only', async () => {
    const assign = (body) => resellerHttp.post('/api/ip/ipv6/assign').set('X-CSRF-Token', resellerCsrf).send(body);
    await assign({ account: 'bob' }).expect(403);
    await resellerHttp.delete('/api/ip/ipv6/assignments/bob').set('X-CSRF-Token', resellerCsrf).expect(403);
    const mine = await resellerHttp.get('/api/ip/ipv6/assignments').expect(200);
    expect(mine.body.data.map((a) => a.account)).toEqual(['alice']);
    const un = await resellerHttp.delete('/api/ip/ipv6/assignments/alice').set('X-CSRF-Token', resellerCsrf).expect(200);
    expect(un.body.data).toMatchObject({ account: 'alice', address: '2001:db8:1::1', removed: true, removedFromSystem: true });
    expect(app.agent.callsTo('net.ip.del')[0].args).toEqual({ address: '2001:db8:1::1', prefix: 64, iface: 'eth0' });
    const zone = (await app.http.get('/api/dns/zones/alice.com').expect(200)).body.data;
    expect(zone.records.filter((r) => r.type === 'AAAA')).toEqual([]);
    const re = await assign({ account: 'alice' }).expect(201);
    expect(re.body.data.address).toBe('2001:db8:1::1');
    await put('/ipv6/ranges/1/accounts', { accounts: ['bob'] }).expect(200);
    await resellerHttp.delete('/api/ip/ipv6/assignments/alice').set('X-CSRF-Token', resellerCsrf).expect(200);
    expect((await assign({ account: 'alice' }).expect(400)).body.error.message).toMatch(/No IPv6 range is assigned/);
    await assign({ account: 'alice', rangeId: 1 }).expect(403);
    await put('/ipv6/ranges/1/accounts', { accounts: ['alice', 'bob'] }).expect(200);
  });

  it('stores remote service source IPs and notifies the owning services', async () => {
    const before = await get('/remote-services').expect(200);
    expect(before.body.data.services.map((s) => s.key)).toEqual(['mail', 'dns', 'mysql', 'ftp', 'panel']);
    expect(before.body.data.candidates.ipv4).toContain('203.0.113.11');
    expect((await put('/remote-services', { mail: { ipv4: '198.51.100.9' } }).expect(422)).body.error.fields['mail.ipv4'][0]).toMatch(/not bound/);
    await put('/remote-services', { mail: { ipv4: '2001:db8:ffff::11' } }).expect(422);
    await put('/remote-services', { mail: { ipv4: '203.0.113.11; x' } }).expect(422);
    await put('/remote-services', { bogus: { ipv4: '203.0.113.11' } }).expect(422);
    const mailCalls = [];
    const savedMail = app.ctx.mail;
    const savedFtp = app.ctx.ftp;
    const savedDb = app.ctx.db_services;
    app.ctx.mail = { setOutboundAddresses: async (addrs) => { mailCalls.push(addrs); } };
    // The FTP service saves the value, then reports that no daemon is installed to apply it to.
    app.ctx.ftp = { setPassiveAddress: async () => { throw new CapabilityError('ftp', 'No FTP daemon is installed on this server'); } };
    app.ctx.db_services = { setClientAddresses: async () => { throw new Error('mysqld refused the new bind address'); } };
    const res = await put('/remote-services', { mail: { ipv4: '203.0.113.11', ipv6: '2001:db8:ffff::11' }, ftp: { ipv4: '203.0.113.20' }, mysql: { ipv4: '203.0.113.11' } }).expect(200);
    expect(res.body.data.applied).toEqual({ mail: 'applied', ftp: 'saved', mysql: 'failed' });
    expect(res.body.data.applyErrors).toEqual({ ftp: expect.stringMatching(/No FTP daemon/), mysql: expect.stringMatching(/mysqld refused/) });
    expect(mailCalls).toEqual([{ ipv4: '203.0.113.11', ipv6: '2001:db8:ffff::11' }]);
    expect(res.body.data.services.find((s) => s.key === 'mail')).toMatchObject({ ipv4: '203.0.113.11', ipv6: '2001:db8:ffff::11' });
    expect(app.ctx.settings.get('ip.remote.ftp_ipv4')).toBe('203.0.113.20');
    expect(app.ctx.settings.get('ip.remote.mysql_ipv4')).toBe('203.0.113.11');
    app.ctx.mail = savedMail;
    app.ctx.ftp = savedFtp;
    app.ctx.db_services = savedDb;
    expect((await del('/addresses/203.0.113.20').expect(409)).body.error.message).toMatch(/FTP/);
    app.ctx.ftp = undefined;
    const cleared = await put('/remote-services', { ftp: { ipv4: '' }, mysql: { ipv4: '' } }).expect(200);
    expect(cleared.body.data.applied.ftp).toBe('saved');
    app.ctx.ftp = savedFtp;
    expect((await get('/remote-services')).body.data.services.find((s) => s.key === 'ftp').ipv4).toBe('');
    expect((await del('/addresses/203.0.113.20').expect(200)).body.data.deleted).toBe(true);
  });

  it('previews an IP migration and refuses broken plans', async () => {
    await app.http.post('/api/dns/zones').set('X-CSRF-Token', csrf).send({ domain: 'bob.com', ip: '203.0.113.11' }).expect(201);
    app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username = ?').run('203.0.113.11', 'bob');
    const preview = await post('/migration/preview', { mappings: [{ from: '203.0.113.11', to: '203.0.113.50' }] }).expect(200);
    const plan = preview.body.data.plan[0];
    expect(plan).toMatchObject({ from: '203.0.113.11', to: '203.0.113.50', accounts: ['bob'], fromBound: true, toBound: false, toKnown: false, isMain: false, issues: [] });
    expect(plan.dns.map((d) => `${d.domain}/${d.name}`).sort()).toEqual(expect.arrayContaining(['bob.com/@', 'bob.com/mail']));
    expect(preview.body.data.totals).toMatchObject({ accounts: 1, newAddressesToBind: 1 });
    expect(preview.body.data.ok).toBe(true);
    const bad = await post('/migration/preview', { mappings: [{ from: '203.0.113.11', to: '2001:db8::5' }, { from: '198.51.100.77', to: '203.0.113.11' }] }).expect(200);
    expect(bad.body.data.ok).toBe(false);
    expect(bad.body.data.plan[0].issues[0]).toMatch(/different IP families/);
    expect(bad.body.data.plan[1].issues).toEqual(expect.arrayContaining([expect.stringMatching(/not known/), expect.stringMatching(/already used/)]));
    expect((await post('/migration', { mappings: [{ from: '203.0.113.11', to: '2001:db8::5' }] }).expect(422)).body.error.fields.mappings[0]).toMatch(/different IP families/);
    await post('/migration', { mappings: [] }).expect(422);
    await post('/migration', { mappings: [{ from: '203.0.113.11', to: '203.0.113.50' }], dryRun: 'yes' }).expect(422);
  });

  it('runs a dry run without changing anything, then the real migration', async () => {
    app.ctx.jobs.start();
    const dry = await post('/migration', { mappings: [{ from: '203.0.113.11', to: '203.0.113.50' }], dryRun: true }).expect(202);
    const dryJob = await waitForJob(app.ctx, dry.body.data.job.id);
    expect(dryJob.status).toBe('done');
    expect(dryJob.result).toMatchObject({ dryRun: true, accounts: 0, bound: 0, failed: 0 });
    expect(app.agent.callsTo('net.ip.add')).toHaveLength(0);
    expect(app.ctx.db.prepare('SELECT ip FROM accounts WHERE username = ?').get('bob').ip).toBe('203.0.113.11');

    const webCalls = [];
    app.ctx.web = { replaceIp: async (from, to, { accounts }) => { webCalls.push({ from, to, accounts }); return { updated: accounts.length }; } };
    const res = await post('/migration', { mappings: [{ from: '203.0.113.11', to: '203.0.113.50' }] }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id, 10000);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ dryRun: false, accounts: 1, bound: 1, failed: 0, vhosts: 1, dnsZones: 2 });
    expect(job.result.dnsRecords).toBeGreaterThanOrEqual(2);
    expect(app.agent.callsTo('net.ip.add')[0].args).toMatchObject({ address: '203.0.113.50', prefix: 24, iface: 'eth0' });
    expect(app.ctx.db.prepare('SELECT ip FROM accounts WHERE username = ?').get('bob').ip).toBe('203.0.113.50');
    const zone = (await app.http.get('/api/dns/zones/bob.com').expect(200)).body.data;
    expect(zone.records.filter((r) => r.type === 'A').every((r) => r.value === '203.0.113.50')).toBe(true);
    expect(zone.records.some((r) => r.type === 'A' && r.name === '@')).toBe(true);
    expect(webCalls).toEqual([{ from: '203.0.113.11', to: '203.0.113.50', accounts: ['bob'] }]);
    const old = app.ctx.db.prepare('SELECT * FROM ip_addresses WHERE address = ?').get('203.0.113.11');
    expect(old).toMatchObject({ reserved: 1, reserved_reason: 'migrated to 203.0.113.50' });
    expect(app.ctx.db.prepare('SELECT 1 FROM ip_addresses WHERE address = ?').get('203.0.113.50')).toBeTruthy();
    const history = await get('/migration/history').expect(200);
    expect(history.body.data).toHaveLength(2);
    expect(history.body.data[0]).toMatchObject({ status: 'done', dryRun: false, mappings: [{ from: '203.0.113.11', to: '203.0.113.50' }] });
    delete app.ctx.web;

    const removing = await post('/migration', { mappings: [{ from: '203.0.113.50', to: '203.0.113.51' }], removeOld: true, updateVhosts: false }).expect(202);
    const removed = await waitForJob(app.ctx, removing.body.data.job.id, 10000);
    expect(removed.result).toMatchObject({ removed: 1, accounts: 1 });
    expect(app.ctx.db.prepare('SELECT 1 FROM ip_addresses WHERE address = ?').get('203.0.113.50')).toBeUndefined();
    expect(app.agent.system.has('203.0.113.50')).toBe(false);
    expect(app.agent.system.has('203.0.113.51')).toBe(true);
    app.ctx.jobs.stop();
  });

  it('migrating the main IP updates Basic Setup and keeps the old address bound', async () => {
    app.ctx.settings.set('basic.main_ip', '203.0.113.10');
    app.ctx.jobs.start();
    const res = await post('/migration', { mappings: [{ from: '203.0.113.10', to: '203.0.113.60' }], updateVhosts: false }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id, 10000);
    expect(job.status).toBe('done');
    expect(job.result.settings).toContain('basic.main_ip');
    expect(app.ctx.settings.get('basic.main_ip')).toBe('203.0.113.60');
    expect(app.ctx.db.prepare('SELECT is_main FROM ip_addresses WHERE address = ?').get('203.0.113.60').is_main).toBe(1);
    expect(app.ctx.db.prepare('SELECT is_main, reserved FROM ip_addresses WHERE address = ?').get('203.0.113.10')).toEqual({ is_main: 0, reserved: 1 });
    expect(app.agent.callsTo('net.ip.del')).toHaveLength(0);
    app.ctx.jobs.stop();
    app.ctx.settings.set('basic.main_ip', '');
  });

  it('exposes allocation helpers for other categories', async () => {
    expect(app.ctx.ip.freeAddresses(4).map((a) => a.address)).not.toContain('203.0.113.23');
    await put('/reserved/203.0.113.23', { reserved: false }).expect(200);
    expect(app.ctx.ip.freeAddresses(4).map((a) => a.address)).toContain('203.0.113.23');
    const bobId = app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get('bob').id;
    const dedicated = app.ctx.ip.allocateDedicated(bobId, null, { address: '203.0.113.23' });
    expect(dedicated).toMatchObject({ address: '203.0.113.23', dedicated_to: 'bob' });
    expect(app.ctx.db.prepare('SELECT ip FROM accounts WHERE id = ?').get(bobId).ip).toBe('203.0.113.23');
    expect(() => app.ctx.ip.allocateDedicated(bobId, null, { address: '203.0.113.23' })).toThrow(/not a free address/);
    expect((await get('/usage').expect(200)).body.data.find((r) => r.address === '203.0.113.23')).toMatchObject({ status: 'dedicated', dedicated_to: 'bob' });
    const released = app.ctx.ip.releaseDedicated(bobId, null);
    expect(released.released).toEqual(['203.0.113.23']);
    expect(await app.ctx.ip.mainIp()).toBe('203.0.113.60');
    expect(app.ctx.ip.isKnown('203.0.113.23')).toBe(true);
    expect(app.ctx.ip.usersOf('203.0.113.23').inUse).toBe(false);
  });

  it('imports DHCP/SLAAC and privacy addresses as unmanaged: never persisted, reserved or handed out', async () => {
    const lease = '203.0.113.200';
    const privacy = '2001:db8:ffff:0:abcd:ef01:2345:6789';
    app.agent.system.set(lease, { family: 4, prefix: 24, iface: 'eth0', dynamic: true });
    app.agent.system.set(privacy, { family: 6, prefix: 64, iface: 'eth0', temporary: true });
    const before = await get('/addresses').expect(200);
    expect(before.body.meta.unmanaged).toEqual(expect.arrayContaining([expect.objectContaining({ address: lease, dynamic: true, volatile: true }), expect.objectContaining({ address: privacy, temporary: true, volatile: true })]));
    const rebuilt = await post('/pool/rebuild').expect(200);
    expect(rebuilt.body.data.unmanaged.sort()).toEqual([privacy, lease].sort());
    expect(rebuilt.body.data.added).toEqual([]);
    expect(rebuilt.body.data.states.unmanaged).toBe(2);
    const persisted = app.agent.callsTo('net.persist.write').at(-1).args.addresses.map((a) => a.address);
    expect(persisted).not.toContain(lease);
    expect(persisted).not.toContain(privacy);
    expect(persisted).toContain('2001:db8:ffff::10');
    const pool = (await get('/pool').expect(200)).body.data;
    expect(pool.find((p) => p.address === lease)).toMatchObject({ state: 'unmanaged', on_system: true, in_db: true });
    const listed = (await get('/addresses').expect(200)).body;
    expect(listed.data.find((a) => a.address === lease)).toMatchObject({ managed: false, bound: true });
    expect(listed.meta.unmanaged).toEqual([]);
    expect(app.ctx.ip.freeAddresses(4).map((a) => a.address)).not.toContain(lease);
    expect((await get('/reserved').expect(200)).body.data.find((r) => r.address === lease).reservable).toBe(false);
    expect((await put(`/reserved/${lease}`, { reserved: true }).expect(400)).body.error.message).toMatch(/dynamic/);
    expect((await get('/usage').expect(200)).body.data.find((r) => r.address === lease).status).toBe('unmanaged');
    expect(() => app.ctx.ip.allocateDedicated(app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get('bob').id, null, { address: lease })).toThrow(/not a free address/);

    // Dropping it from the inventory never touches the interface: the lease belongs to the host.
    app.agent.calls.length = 0;
    const res = await del(`/addresses/${lease}`).expect(200);
    expect(res.body.data).toMatchObject({ deleted: true, managed: false, removedFromSystem: false, wasBound: true });
    expect(app.agent.callsTo('net.ip.del')).toHaveLength(0);
    expect(app.agent.system.has(lease)).toBe(true);
    app.agent.system.delete(lease);

    // A privacy address that rotated away is forgotten on the next rebuild instead of lingering as "missing".
    app.agent.system.delete(privacy);
    const again = await post('/pool/rebuild').expect(200);
    expect(again.body.data.dropped).toEqual([privacy]);
    expect(again.body.data.missing).not.toContain(privacy);
    expect(app.ctx.db.prepare('SELECT 1 FROM ip_addresses WHERE address IN (?, ?)').get(lease, privacy)).toBeUndefined();
  });

  it('migrates an account\'s assigned IPv6 address and keeps the assignment, DNS and dedication in step', async () => {
    const aliceId = app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get('alice').id;
    const assigned = await post('/ipv6/assign', { account: 'alice' }).expect(201);
    const from = assigned.body.data.address;
    const to = '2001:db8:1::77';
    expect(from).toBe('2001:db8:1::1');
    const preview = await post('/migration/preview', { mappings: [{ from, to }] }).expect(200);
    expect(preview.body.data.plan[0]).toMatchObject({ ipv6Account: 'alice', accounts: [], issues: [], isMain: false });
    expect(preview.body.data.plan[0].dns.map((d) => `${d.domain}/${d.name}`).sort()).toEqual(['alice.com/@', 'alice.com/www']);
    expect((await post('/migration/preview', { mappings: [{ from: '2001:db8:ffff::11', to: from }] }).expect(200)).body.data.plan[0].issues).toEqual(expect.arrayContaining([expect.stringMatching(/IPv6 address of alice/)]));

    app.ctx.jobs.start();
    app.agent.calls.length = 0;
    const webCalls = [];
    app.ctx.web = { replaceIp: async (f, t, { accounts }) => { webCalls.push({ f, t, accounts }); return { updated: accounts.length }; } };
    const res = await post('/migration', { mappings: [{ from, to }], removeOld: true }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id, 10000);
    delete app.ctx.web;
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ accounts: 1, bound: 1, removed: 1, failed: 0, vhosts: 1 });
    expect(webCalls).toEqual([{ f: from, t: to, accounts: ['alice'] }]);
    expect(app.agent.callsTo('net.ip.add')[0].args).toMatchObject({ address: to, prefix: 64, iface: 'eth0' });
    expect(app.agent.callsTo('net.ip.del')[0].args).toMatchObject({ address: from, prefix: 64, iface: 'eth0' });
    expect(app.ctx.db.prepare('SELECT address, range_id FROM ipv6_assignments WHERE account_id = ?').get(aliceId)).toEqual({ address: to, range_id: 1 });
    expect(app.ctx.ip.ipv6For(aliceId)).toBe(to);
    expect(app.ctx.db.prepare('SELECT dedicated_to, reserved FROM ip_addresses WHERE address = ?').get(to)).toEqual({ dedicated_to: aliceId, reserved: 0 });
    expect(app.ctx.db.prepare('SELECT 1 FROM ip_addresses WHERE address = ?').get(from)).toBeUndefined();
    expect(app.agent.system.has(from)).toBe(false);
    expect(app.agent.system.has(to)).toBe(true);
    const zone = (await app.http.get('/api/dns/zones/alice.com').expect(200)).body.data;
    expect(zone.records.filter((r) => r.type === 'AAAA').map((r) => `${r.name}=${r.value}`).sort()).toEqual([`@=${to}`, `www=${to}`]);
    expect((await get('/usage').expect(200)).body.data.find((r) => r.address === to)).toMatchObject({ status: 'dedicated', ipv6_account: 'alice' });
    app.ctx.jobs.stop();

    const un = await del('/ipv6/assignments/alice').expect(200);
    expect(un.body.data).toMatchObject({ address: to, removedFromSystem: true });
    expect(app.agent.system.has(to)).toBe(false);
  });

  it('never unbinds the main IP on removeOld, even when only Basic Setup names it and the route has no source', async () => {
    app.agent.set('net.route.default', () => ({ source: 'iproute2', ipv4: { gateway: '203.0.113.1', dev: 'eth0', prefsrc: null, metric: 100 }, ipv6: null }));
    app.ctx.settings.set('basic.main_ip', '203.0.113.21');
    expect(app.ctx.db.prepare('SELECT is_main FROM ip_addresses WHERE address = ?').get('203.0.113.21').is_main).toBe(0);
    const preview = await post('/migration/preview', { mappings: [{ from: '203.0.113.21', to: '203.0.113.61' }] }).expect(200);
    expect(preview.body.data.plan[0]).toMatchObject({ isMain: true, issues: [] });
    expect(preview.body.data.warnings).toEqual([expect.stringMatching(/main IP.*stays bound/)]);

    app.ctx.jobs.start();
    app.agent.calls.length = 0;
    const res = await post('/migration', { mappings: [{ from: '203.0.113.21', to: '203.0.113.61' }], removeOld: true, updateVhosts: false }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id, 10000);
    app.ctx.jobs.stop();
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ removed: 0, bound: 1, failed: 0 });
    expect(job.result.settings).toContain('basic.main_ip');
    expect(app.agent.callsTo('net.ip.del')).toHaveLength(0);
    expect(app.agent.system.has('203.0.113.21')).toBe(true);
    expect(app.ctx.settings.get('basic.main_ip')).toBe('203.0.113.61');
    expect(app.ctx.db.prepare('SELECT is_main, reserved, reserved_reason FROM ip_addresses WHERE address = ?').get('203.0.113.21')).toEqual({ is_main: 0, reserved: 1, reserved_reason: 'migrated to 203.0.113.61' });
    expect(app.ctx.db.prepare('SELECT is_main FROM ip_addresses WHERE address = ?').get('203.0.113.61').is_main).toBe(1);
    expect(await app.ctx.ip.mainIp()).toBe('203.0.113.61');

    app.ctx.settings.set('basic.main_ip', '');
    app.ctx.db.prepare("UPDATE ip_addresses SET is_main = CASE WHEN address = '203.0.113.60' THEN 1 ELSE 0 END").run();
    app.agent.set('net.route.default', () => ({ source: 'iproute2', ipv4: { gateway: '203.0.113.1', dev: 'eth0', prefsrc: '203.0.113.10', metric: 100 }, ipv6: { gateway: 'fe80::1', dev: 'eth0', prefsrc: null, metric: 1024 } }));
  });

  it('keeps every server-wide route root-only', async () => {
    for (const path of ['/addresses', '/interfaces', '/reserved', '/pool', '/ipv6/ranges', '/remote-services', '/migration/history']) await resellerHttp.get(`/api/ip${path}`).expect(403);
    await resellerHttp.post('/api/ip/addresses').set('X-CSRF-Token', resellerCsrf).send({ address: '203.0.113.99' }).expect(403);
    await resellerHttp.delete('/api/ip/addresses/203.0.113.23').set('X-CSRF-Token', resellerCsrf).expect(403);
    await resellerHttp.post('/api/ip/pool/rebuild').set('X-CSRF-Token', resellerCsrf).expect(403);
    await resellerHttp.post('/api/ip/ipv6/ranges').set('X-CSRF-Token', resellerCsrf).send({ name: 'x', range: '2001:db8:5::/64' }).expect(403);
    await resellerHttp.put('/api/ip/remote-services').set('X-CSRF-Token', resellerCsrf).send({}).expect(403);
    await resellerHttp.post('/api/ip/migration/preview').set('X-CSRF-Token', resellerCsrf).send({ mappings: [{ from: '203.0.113.10', to: '203.0.113.11' }] }).expect(403);
    await resellerHttp.post('/api/ip/migration').set('X-CSRF-Token', resellerCsrf).send({ mappings: [{ from: '203.0.113.10', to: '203.0.113.11' }] }).expect(403);
    await app.http.post('/api/ip/addresses').send({ address: '203.0.113.99' }).expect(403);
  });
});

describe('IP Functions API without iproute2', () => {
  let app;
  let csrf;
  beforeAll(async () => {
    app = await createTestApp();
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.com' }).expect(201);
  });
  afterAll(() => app.close());

  it('answers 501 capability_missing for anything that must touch an interface', async () => {
    const add = await app.http.post('/api/ip/addresses').set('X-CSRF-Token', csrf).send({ address: '203.0.113.5' }).expect(501);
    expect(add.body.error).toMatchObject({ code: 'capability_missing', capability: 'iproute2' });
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM ip_addresses').get().n).toBe(0);
    await app.http.post('/api/ip/ipv6/ranges').set('X-CSRF-Token', csrf).send({ name: 'r', range: '2001:db8:7::/64' }).expect(201);
    expect((await app.http.post('/api/ip/ipv6/assign').set('X-CSRF-Token', csrf).send({ account: 'carol' }).expect(501)).body.error.capability).toBe('iproute2');
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM ipv6_assignments').get().n).toBe(0);
    app.ctx.db.prepare("INSERT INTO ip_addresses (address, family, netmask, interface) VALUES ('203.0.113.70', 4, '255.255.255.0', 'eth0')").run();
    const mig = await app.http.post('/api/ip/migration').set('X-CSRF-Token', csrf).send({ mappings: [{ from: '203.0.113.70', to: '203.0.113.71' }] }).expect(501);
    expect(mig.body.error.code).toBe('capability_missing');
  });

  it('still serves inventory, reservations, pool and settings pages', async () => {
    const list = await app.http.get('/api/ip/addresses').expect(200);
    expect(list.body.meta.iproute2).toBe(false);
    expect(list.body.data.find((a) => a.address === '203.0.113.70')).toMatchObject({ bound: false });
    await app.http.get('/api/ip/usage').expect(200);
    await app.http.get('/api/ip/reserved').expect(200);
    await app.http.put('/api/ip/reserved/203.0.113.70').set('X-CSRF-Token', csrf).send({ reserved: true, reason: 'held' }).expect(200);
    const pool = await app.http.post('/api/ip/pool/rebuild').set('X-CSRF-Token', csrf).send().expect(200);
    expect(pool.body.data.missing).toContain('203.0.113.70');
    expect((await app.http.get('/api/ip/pool').expect(200)).body.data.find((p) => p.address === '203.0.113.70')).toMatchObject({ state: 'reserved', on_system: false });
    await app.http.get('/api/ip/remote-services').expect(200);
    await app.http.get('/api/ip/interfaces').expect(200);
    const preview = await app.http.post('/api/ip/migration/preview').set('X-CSRF-Token', csrf).send({ mappings: [{ from: '203.0.113.70', to: '203.0.113.71' }] }).expect(200);
    expect(preview.body.data.iproute2).toBe(false);
    // An address that is not bound anywhere can still be dropped from the inventory.
    await app.http.put('/api/ip/reserved/203.0.113.70').set('X-CSRF-Token', csrf).send({ reserved: false }).expect(200);
    const res = await app.http.delete('/api/ip/addresses/203.0.113.70').set('X-CSRF-Token', csrf).expect(200);
    expect(res.body.data).toMatchObject({ deleted: true, removedFromSystem: false, wasBound: false });
  });
});

describe('IP Functions with the real web service and no Apache', () => {
  let app;
  let csrf;
  const post = (path, body) => app.http.post(`/api/ip${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/ip${path}`).set('X-CSRF-Token', csrf);

  beforeAll(async () => {
    app = await createTestApp({ agent: netAgent() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'dave', domain: 'dave.com', ip: '203.0.113.10' }).expect(201);
    await post('/ipv6/ranges', { name: 'customers', range: '2001:db8:1::/64' }).expect(201);
  });
  afterAll(() => app.close());

  it('reports the vhost change as pending when Apache is missing instead of failed', async () => {
    expect(typeof app.ctx.web?.setAccountIpv6).toBe('function');
    expect(app.ctx.capabilities.has('apache')).toBe(false);
    const res = await post('/ipv6/assign', { account: 'dave' }).expect(201);
    expect(res.body.data).toMatchObject({ account: 'dave', address: '2001:db8:1::1', bound: true, web: 'pending' });
    // The web service persisted the spec; it is applied by the next sync once Apache exists.
    expect(app.ctx.db.prepare('SELECT ipv6, ip FROM web_vhosts WHERE username = ?').get('dave')).toEqual({ ipv6: '2001:db8:1::1', ip: '203.0.113.10' });
    const un = await del('/ipv6/assignments/dave').expect(200);
    expect(un.body.data).toMatchObject({ account: 'dave', removed: true, web: 'pending' });
    expect(app.ctx.db.prepare('SELECT ipv6 FROM web_vhosts WHERE username = ?').get('dave').ipv6).toBeNull();
  });

  it('does not count a missing Apache as a failed migration mapping', async () => {
    app.ctx.jobs.start();
    const res = await post('/migration', { mappings: [{ from: '203.0.113.10', to: '203.0.113.60' }] }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id, 10000);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ dryRun: false, accounts: 1, bound: 1, failed: 0, vhosts: null });
    expect(app.ctx.db.prepare('SELECT ip FROM accounts WHERE username = ?').get('dave').ip).toBe('203.0.113.60');
    expect(app.ctx.db.prepare('SELECT ip FROM web_vhosts WHERE username = ?').get('dave').ip).toBe('203.0.113.60');
    const logs = app.ctx.jobs.get(job.id).logs;
    expect(logs.some((l) => l.level === 'error')).toBe(false);
    expect(logs.some((l) => l.level === 'warn' && /^vhosts: Apache is not installed/.test(l.line))).toBe(true);
  });
});
