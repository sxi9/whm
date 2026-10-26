import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { parseIpAddrJson, parseRouteJson, renderUnit, prefixToNetmask, netmaskToPrefix, IPS_FILE, UNIT_FILE } from '../src/ops/net.js';

// exec is spied with the real implementation behind it so tests can prove an op
// refused before any program ran. No test here binds, removes or persists an
// address: those ops either fail schema validation or stop at capability_missing.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary } = await import('../src/exec.js');

const ctx = createContext();

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

describe('net op catalog', () => {
  it('registers the family with destructive flags on removals', () => {
    for (const name of ['net.ip.list', 'net.route.default', 'net.ip.add', 'net.ip.del', 'net.persist.read', 'net.persist.write']) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('net.ip.del').destructive).toBe(true);
    expect(catalog.get('net.ip.add').destructive).toBe(false);
    expect(catalog.get('net.persist.write').destructive).toBe(false);
  });

  it('rejects unknown ops in the family', async () => {
    expect((await opError(runOp('net.ip.flush', { iface: 'eth0' }, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('net.exec', {}, ctx))).code).toBe('unknown_op');
  });
});

describe('net schemas reject injection and traversal before anything runs', () => {
  const badAddresses = ['-r', 'a;b', '../etc', '10.0.0.1; rm -rf /', '10.0.0', '999.1.1.1', '10.0.0.1/24', '$(id)', '', 'eth0', '2001:db8::zz'];
  const badIfaces = ['-a', 'eth0;x', '../eth0', 'eth0 eth1', 'a'.repeat(16), '', 'eth0\n'];

  it('net.ip.add refuses bad addresses, interfaces, prefixes and labels', async () => {
    exec.mockClear();
    for (const address of badAddresses) {
      const err = await opError(runOp('net.ip.add', { address, prefix: 24, iface: 'eth0' }, ctx));
      expect(err.code, JSON.stringify(address)).toBe('invalid_args');
      expect(err.details.fields.address).toBeDefined();
    }
    for (const iface of badIfaces) {
      const err = await opError(runOp('net.ip.add', { address: '203.0.113.5', prefix: 24, iface }, ctx));
      expect(err.code, JSON.stringify(iface)).toBe('invalid_args');
      expect(err.details.fields.iface).toBeDefined();
    }
    // 0 included: a /0 bind would install a default on-link route.
    for (const prefix of [-1, 0, 129, '24', 24.5, null]) expect((await opError(runOp('net.ip.add', { address: '203.0.113.5', prefix, iface: 'eth0' }, ctx))).code, String(prefix)).toBe('invalid_args');
    for (const iface of ['-eth0', '.eth0']) expect((await opError(runOp('net.ip.add', { address: '203.0.113.5', prefix: 24, iface }, ctx))).code, iface).toBe('invalid_args');
    for (const label of ['A B', 'x;y', '../', 'toolonglabel', '']) expect((await opError(runOp('net.ip.add', { address: '203.0.113.5', prefix: 24, iface: 'eth0', label }, ctx))).code, label).toBe('invalid_args');
    expect((await opError(runOp('net.ip.add', { address: '203.0.113.5', prefix: 24, iface: 'eth0', extra: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('net.ip.add', { address: '203.0.113.5', iface: 'eth0' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('net.ip.del refuses the same inputs', async () => {
    exec.mockClear();
    for (const address of badAddresses) expect((await opError(runOp('net.ip.del', { address, prefix: 24, iface: 'eth0' }, ctx))).code, address).toBe('invalid_args');
    for (const iface of badIfaces) expect((await opError(runOp('net.ip.del', { address: '203.0.113.5', prefix: 24, iface }, ctx))).code, iface).toBe('invalid_args');
    expect((await opError(runOp('net.ip.del', { address: '203.0.113.5', prefix: 24, iface: 'eth0', force: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('net.persist.write validates every address entry and never writes on bad input', async () => {
    exec.mockClear();
    for (const addresses of [
      [{ address: '-r', prefix: 24, iface: 'eth0' }], [{ address: '203.0.113.5', prefix: 24, iface: 'eth0;reboot' }], [{ address: '203.0.113.5', prefix: 200, iface: 'eth0' }], [{ address: '203.0.113.5', prefix: 0, iface: 'eth0' }],
      [{ address: '203.0.113.5', prefix: 24, iface: 'eth0', label: 'a b' }], [{ address: '203.0.113.5', prefix: 24, iface: 'eth0', path: '/etc/passwd' }], 'eth0', null,
    ]) {
      expect((await opError(runOp('net.persist.write', { addresses }, ctx))).code, JSON.stringify(addresses)).toBe('invalid_args');
    }
    expect((await opError(runOp('net.persist.write', { addresses: [], unit: '/etc/systemd/system/evil.service' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('list and route ops take no arguments', async () => {
    expect((await opError(runOp('net.ip.list', { iface: 'eth0' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('net.route.default', { family: 4 }, ctx))).code).toBe('invalid_args');
  });
});

describe('net ops on this host', () => {
  it('net.ip.list reports interfaces with normalised addresses from whichever source exists', async () => {
    const result = await runOp('net.ip.list', {}, ctx);
    expect(['iproute2', 'os']).toContain(result.source);
    expect(Array.isArray(result.interfaces)).toBe(true);
    for (const iface of result.interfaces) {
      expect(typeof iface.name).toBe('string');
      for (const a of iface.addresses) {
        expect([4, 6]).toContain(a.family);
        expect(typeof a.address).toBe('string');
        if (a.family === 4 && a.prefix != null) expect(a.netmask).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      }
    }
  });

  it('net.ip.list falls back to the OS view when `ip -j` is unsupported or prints no JSON', async () => {
    hasBinary.mockReturnValueOnce(true);
    exec.mockResolvedValueOnce({ code: 255, stdout: '', stderr: 'Option "-j" is unknown, try "ip -help".', bin: '/sbin/ip', argv: [] });
    const old = await runOp('net.ip.list', {}, ctx);
    expect(old.source).toBe('os');
    expect(old.fallback).toMatch(/-j/);
    expect(Array.isArray(old.interfaces)).toBe(true);
    hasBinary.mockReturnValueOnce(true);
    exec.mockResolvedValueOnce({ code: 0, stdout: '1: lo: <LOOPBACK,UP> mtu 65536', stderr: '', bin: '/sbin/ip', argv: [] });
    const text = await runOp('net.ip.list', {}, ctx);
    expect(text.source).toBe('os');
    expect(text.fallback).toMatch(/parse/i);
    expect(exec).toHaveBeenLastCalledWith('ip', ['-j', 'addr', 'show'], expect.objectContaining({ allowFailure: true }));
  });

  it('net.route.default answers with a structured route or null', async () => {
    const routes = await runOp('net.route.default', {}, ctx);
    expect(['iproute2', 'proc']).toContain(routes.source);
    for (const r of [routes.ipv4, routes.ipv6]) if (r) expect(r).toMatchObject({ gateway: expect.anything(), dev: expect.any(String) });
  });

  it('net.persist.read tolerates a missing inventory', async () => {
    const result = await runOp('net.persist.read', {}, ctx);
    expect(result.path).toBe(IPS_FILE);
    expect(Array.isArray(result.addresses)).toBe(true);
    expect(typeof result.exists).toBe('boolean');
  });

  it('add/del stop at capability_missing without running anything when iproute2 is absent', async () => {
    if (hasBinary('ip')) return;
    exec.mockClear();
    expect((await opError(runOp('net.ip.add', { address: '203.0.113.5', prefix: 24, iface: 'eth0' }, ctx))).code).toBe('capability_missing');
    expect((await opError(runOp('net.ip.del', { address: '203.0.113.5', prefix: 24, iface: 'eth0' }, ctx))).code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses IPv4 prefixes over 32 for add and del', async () => {
    const add = await opError(runOp('net.ip.add', { address: '203.0.113.5', prefix: 64, iface: 'eth0' }, ctx));
    expect(['invalid_args', 'capability_missing']).toContain(add.code);
    if (hasBinary('ip')) expect(add.code).toBe('invalid_args');
  });
});

describe('net pure helpers', () => {
  it('parses `ip -j addr` output into families, scopes and labels', () => {
    const sample = JSON.stringify([
      { ifindex: 1, ifname: 'lo', flags: ['LOOPBACK', 'UP'], operstate: 'UNKNOWN', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8, scope: 'host', label: 'lo' }, { family: 'inet6', local: '::1', prefixlen: 128, scope: 'host' }] },
      { ifindex: 2, ifname: 'eth0', flags: ['BROADCAST', 'MULTICAST', 'UP'], operstate: 'UP', address: '02:42:ac:11:00:02', mtu: 1500, addr_info: [
        { family: 'inet', local: '203.0.113.10', prefixlen: 24, broadcast: '203.0.113.255', scope: 'global', label: 'eth0' },
        { family: 'inet', local: '203.0.113.11', prefixlen: 24, scope: 'global', label: 'eth0:whm1', secondary: true },
        { family: 'inet6', local: '2001:db8::10', prefixlen: 64, scope: 'global' },
        { family: 'inet6', local: 'fe80::42:acff:fe11:2', prefixlen: 64, scope: 'link' },
      ] },
    ]);
    const parsed = parseIpAddrJson(sample);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ name: 'lo', loopback: true });
    const eth0 = parsed[1];
    expect(eth0).toMatchObject({ name: 'eth0', up: true, state: 'UP', mac: '02:42:ac:11:00:02', mtu: 1500 });
    expect(eth0.addresses.map((a) => a.address)).toEqual(['203.0.113.10', '203.0.113.11', '2001:db8::10', 'fe80::42:acff:fe11:2']);
    expect(eth0.addresses[0]).toMatchObject({ family: 4, prefix: 24, netmask: '255.255.255.0', scope: 'global', secondary: false });
    expect(eth0.addresses[1]).toMatchObject({ label: 'eth0:whm1', secondary: true });
    expect(eth0.addresses[2]).toMatchObject({ family: 6, prefix: 64, netmask: null, scope: 'global' });
    expect(eth0.addresses[3].scope).toBe('link');
    expect(() => parseIpAddrJson('not json')).toThrow(OpError);
    expect(parseIpAddrJson('{}')).toEqual([]);
  });

  it('parses default routes and prefers the "default" entry', () => {
    expect(parseRouteJson(JSON.stringify([{ dst: 'default', gateway: '203.0.113.1', dev: 'eth0', prefsrc: '203.0.113.10', metric: 100 }]))).toEqual({ gateway: '203.0.113.1', dev: 'eth0', prefsrc: '203.0.113.10', metric: 100 });
    expect(parseRouteJson('[]')).toBeNull();
    expect(parseRouteJson('garbage')).toBeNull();
  });

  it('renders a systemd oneshot that re-adds every address and tolerates "already exists"', () => {
    const unit = renderUnit([{ address: '203.0.113.11', prefix: 24, iface: 'eth0', label: 'whm2' }, { address: '2001:db8::11', prefix: 64, iface: 'eth0', label: 'whm3' }], '/sbin/ip');
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('ExecStart=-/sbin/ip addr add 203.0.113.11/24 dev eth0 label eth0:whm2');
    expect(unit).toContain('ExecStart=-/sbin/ip addr add 2001:db8::11/64 dev eth0\n');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(UNIT_FILE).toBe('/etc/systemd/system/whm-ips.service');
    expect(() => ctx.assertAllowedPath(UNIT_FILE, 'write')).not.toThrow();
    expect(() => ctx.assertAllowedPath('/etc/systemd/system/other.service', 'write')).toThrow(OpError);
  });

  it('converts between prefixes and dotted netmasks', () => {
    expect(prefixToNetmask(24)).toBe('255.255.255.0');
    expect(prefixToNetmask(32)).toBe('255.255.255.255');
    expect(prefixToNetmask(17)).toBe('255.255.128.0');
    expect(prefixToNetmask(0)).toBe('0.0.0.0');
    expect(prefixToNetmask(1)).toBe('128.0.0.0');
    expect(netmaskToPrefix('255.255.255.0')).toBe(24);
    expect(netmaskToPrefix('255.255.255.255')).toBe(32);
    expect(netmaskToPrefix('255.0.255.0')).toBeNull();
    expect(netmaskToPrefix('16')).toBe(16);
    expect(netmaskToPrefix('999')).toBeNull();
    expect(netmaskToPrefix('33')).toBeNull();
  });
});
