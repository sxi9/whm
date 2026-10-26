import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { exec, hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// IP Functions op family: list / add / remove addresses with iproute2, detect the
// default route, and persist panel-managed addresses so they survive a reboot
// (a JSON inventory under /etc/whm plus a systemd oneshot that re-adds them).
// Address arithmetic lives in the API (services/ip-math.js); the agent only
// touches the host.

export const IPS_FILE = '/etc/whm/ips.json';
export const UNIT_FILE = '/etc/systemd/system/whm-ips.service';

const prefix = z.number().int().min(0).max(128);
// Binding a /0 would install a default on-link route; removal still accepts any
// prefix so a mis-bound address can be taken off again.
const bindPrefix = prefix.min(1);
// Stricter than arg.iface: an interface name never starts with "-" (argv option) or ".".
const iface = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,14}$/);
// Linux alias labels must start with the interface name; the panel appends a
// short suffix. IFNAMSIZ limits the whole label to 15 characters.
const labelSuffix = z.string().regex(/^[a-z0-9_-]{1,8}$/);

function familyOf(address) {
  return address.includes(':') ? 6 : 4;
}

function assertPrefixFitsFamily(address, pfx) {
  if (familyOf(address) === 4 && pfx > 32) throw new OpError('invalid_args', 'IPv4 prefixes cannot exceed /32', { fields: { prefix: ['max 32 for IPv4'] } });
}

function fullLabel(iface, suffix) {
  const label = `${iface}:${suffix}`;
  if (label.length > 15) throw new OpError('invalid_args', 'Interface alias label exceeds 15 characters', { fields: { label: ['too long'] } });
  return label;
}

export function prefixToNetmask(pfx) {
  // A 32-bit shift is a no-op in JS, so /0 is special-cased.
  const bits = pfx === 0 ? 0 : (0xffffffff << (32 - pfx)) >>> 0;
  return [24, 16, 8, 0].map((s) => ((bits >>> s) & 255)).join('.');
}

export function netmaskToPrefix(mask) {
  if (/^\d{1,3}$/.test(mask)) { const n = Number(mask); return n <= 32 ? n : null; }
  const parts = mask.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  const bits = parts.map((p) => p.toString(2).padStart(8, '0')).join('');
  if (!/^1*0*$/.test(bits)) return null;
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
}

export function parseIpAddrJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new OpError('parse_failed', 'Could not parse `ip -j addr` output'); }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((link) => ({
    name: link.ifname,
    index: link.ifindex ?? null,
    state: link.operstate ?? null,
    up: Array.isArray(link.flags) ? link.flags.includes('UP') : null,
    loopback: Array.isArray(link.flags) ? link.flags.includes('LOOPBACK') : link.ifname === 'lo',
    mac: link.address ?? null,
    mtu: link.mtu ?? null,
    addresses: (link.addr_info || []).filter((a) => a.family === 'inet' || a.family === 'inet6').map((a) => ({
      address: a.local,
      family: a.family === 'inet' ? 4 : 6,
      prefix: a.prefixlen ?? null,
      netmask: a.family === 'inet' && a.prefixlen != null ? prefixToNetmask(a.prefixlen) : null,
      scope: a.scope ?? null,
      label: a.label ?? null,
      dynamic: Boolean(a.dynamic),
      temporary: Boolean(a.temporary),
      deprecated: Boolean(a.deprecated),
      secondary: Boolean(a.secondary),
    })),
  })).filter((l) => l.name);
}

function interfacesFromOs() {
  return Object.entries(os.networkInterfaces()).map(([name, addrs]) => ({
    name, index: null, state: null, up: null, loopback: (addrs || []).some((a) => a.internal), mac: addrs?.[0]?.mac ?? null, mtu: null,
    addresses: (addrs || []).map((a) => {
      const family = a.family === 'IPv6' || a.family === 6 ? 6 : 4;
      const pfx = a.cidr ? Number(a.cidr.split('/')[1]) : family === 4 ? netmaskToPrefix(a.netmask) : null;
      return { address: a.address, family, prefix: pfx, netmask: family === 4 ? a.netmask : null, scope: a.internal ? 'host' : a.scopeid ? 'link' : 'global', label: null, dynamic: false, temporary: false, deprecated: false, secondary: false };
    }),
  }));
}

async function listInterfaces() {
  if (!hasBinary('ip')) return { source: 'os', interfaces: interfacesFromOs() };
  const { code, stdout, stderr } = await exec('ip', ['-j', 'addr', 'show'], { allowFailure: true });
  // Older iproute2 (CentOS 7's 4.11) has no -j; the OS view still answers so
  // callers can tell "bound" from "unknown".
  if (code !== 0) return { source: 'os', interfaces: interfacesFromOs(), fallback: stderr.trim().split('\n').pop() || `ip exited ${code}` };
  try {
    return { source: 'iproute2', interfaces: parseIpAddrJson(stdout) };
  } catch (err) {
    return { source: 'os', interfaces: interfacesFromOs(), fallback: err.message };
  }
}

export function parseRouteJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  const r = Array.isArray(parsed) ? parsed.find((x) => x.dst === 'default') || parsed[0] : null;
  if (!r) return null;
  return { gateway: r.gateway ?? null, dev: r.dev ?? null, prefsrc: r.prefsrc ?? null, metric: r.metric ?? null };
}

// /proc/net/route lists hex little-endian IPv4 routes; used when iproute2 is absent.
function defaultRouteFromProc() {
  try {
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const [iface, dest, gw] = line.trim().split(/\s+/);
      if (dest !== '00000000' || !gw) continue;
      const g = Buffer.from(gw, 'hex');
      return { gateway: `${g[3]}.${g[2]}.${g[1]}.${g[0]}`, dev: iface, prefsrc: null, metric: null };
    }
  } catch { /* no procfs */ }
  return null;
}

async function defaultRoutes() {
  if (!hasBinary('ip')) return { source: 'proc', ipv4: defaultRouteFromProc(), ipv6: null };
  const v4 = await exec('ip', ['-j', '-4', 'route', 'show', 'default'], { allowFailure: true });
  const v6 = await exec('ip', ['-j', '-6', 'route', 'show', 'default'], { allowFailure: true });
  return { source: 'iproute2', ipv4: v4.code === 0 ? parseRouteJson(v4.stdout) : null, ipv6: v6.code === 0 ? parseRouteJson(v6.stdout) : null };
}

function requireIp() {
  if (!hasBinary('ip')) throw new OpError('capability_missing', 'iproute2 (`ip`) is not installed on this server; install the iproute2 package to manage addresses');
}

defineOp('net.ip.list', {
  description: 'Network interfaces and their IPv4/IPv6 addresses (ip -j addr, falls back to the OS view)',
  run: listInterfaces,
});

defineOp('net.route.default', {
  description: 'Default IPv4/IPv6 routes: gateway, device and preferred source address',
  run: defaultRoutes,
});

defineOp('net.ip.add', {
  description: 'Bind an address to an interface (ip addr add <addr>/<prefix> dev <iface> [label])',
  schema: z.object({ address: arg.ip, prefix: bindPrefix, iface, label: labelSuffix.optional() }).strict(),
  run: async ({ address, prefix: pfx, iface, label }) => {
    requireIp();
    assertPrefixFitsFamily(address, pfx);
    const argv = ['addr', 'add', `${address}/${pfx}`, 'dev', iface];
    if (label && familyOf(address) === 4) argv.push('label', fullLabel(iface, label));
    const { code, stderr } = await exec('ip', argv, { allowFailure: true });
    if (code === 0) return { address, prefix: pfx, iface, label: label ? fullLabel(iface, label) : null, added: true, existed: false };
    if (/File exists|RTNETLINK answers: File exists/i.test(stderr)) return { address, prefix: pfx, iface, label: null, added: false, existed: true };
    if (/Cannot find device/i.test(stderr)) throw new OpError('not_found', `Interface "${iface}" does not exist`, { stderr: stderr.trim() });
    throw new OpError('command_failed', `ip addr add failed: ${stderr.trim().split('\n').pop() || `exit ${code}`}`, { stderr: stderr.trim() });
  },
});

defineOp('net.ip.del', {
  description: 'Remove an address from an interface (ip addr del); refuses the default route source',
  destructive: true,
  schema: z.object({ address: arg.ip, prefix, iface }).strict(),
  run: async ({ address, prefix: pfx, iface }) => {
    requireIp();
    assertPrefixFitsFamily(address, pfx);
    const routes = await defaultRoutes();
    if (routes.ipv4?.prefsrc === address || routes.ipv6?.prefsrc === address) {
      throw new OpError('refused', `${address} is the source address of the default route; removing it would cut the server off`);
    }
    const { code, stderr } = await exec('ip', ['addr', 'del', `${address}/${pfx}`, 'dev', iface], { allowFailure: true });
    if (code === 0) return { address, prefix: pfx, iface, removed: true, existed: true };
    if (/Cannot assign requested address|No such file|not found|does not exist/i.test(stderr)) return { address, prefix: pfx, iface, removed: false, existed: false };
    throw new OpError('command_failed', `ip addr del failed: ${stderr.trim().split('\n').pop() || `exit ${code}`}`, { stderr: stderr.trim() });
  },
});

const persistedAddress = z.object({ address: arg.ip, prefix: bindPrefix, iface, label: labelSuffix.optional() }).strict();

export function renderUnit(addresses, ipBin = '/sbin/ip') {
  const lines = [
    '# Managed by WHM panel (IP Functions). Edit through the panel; manual changes are overwritten.',
    '[Unit]',
    'Description=WHM panel: re-add managed IP addresses at boot',
    'After=network.target',
    'Before=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
  ];
  for (const a of addresses) {
    const label = a.label && familyOf(a.address) === 4 ? ` label ${a.iface}:${a.label}` : '';
    // "-" tells systemd to keep going when an address is already present.
    lines.push(`ExecStart=-${ipBin} addr add ${a.address}/${a.prefix} dev ${a.iface}${label}`);
  }
  lines.push('', '[Install]', 'WantedBy=multi-user.target', '');
  return lines.join('\n');
}

function writeAtomic(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.whm-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

defineOp('net.persist.read', {
  description: 'Read the panel\'s persisted address inventory (/etc/whm/ips.json)',
  run: async (_args, ctx) => {
    ctx.assertAllowedPath(IPS_FILE, 'read');
    try {
      const parsed = JSON.parse(fs.readFileSync(IPS_FILE, 'utf8'));
      return { path: IPS_FILE, exists: true, addresses: Array.isArray(parsed?.addresses) ? parsed.addresses : [], unitExists: fs.existsSync(UNIT_FILE) };
    } catch (err) {
      if (err.code === 'ENOENT') return { path: IPS_FILE, exists: false, addresses: [], unitExists: fs.existsSync(UNIT_FILE) };
      throw new OpError('parse_failed', `Could not read ${IPS_FILE}: ${err.message}`);
    }
  },
});

defineOp('net.persist.write', {
  description: 'Persist managed addresses: write /etc/whm/ips.json and the whm-ips.service oneshot, then daemon-reload + enable',
  schema: z.object({ addresses: z.array(persistedAddress).max(4096) }).strict(),
  timeoutMs: 120_000,
  run: async ({ addresses }, ctx) => {
    ctx.assertAllowedPath(IPS_FILE, 'write');
    ctx.assertAllowedPath(UNIT_FILE, 'write');
    for (const a of addresses) assertPrefixFitsFamily(a.address, a.prefix);
    writeAtomic(IPS_FILE, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), addresses }, null, 2)}\n`, 0o600);
    const ipBin = resolveBinary('ip') || '/sbin/ip';
    writeAtomic(UNIT_FILE, renderUnit(addresses, ipBin));
    const result = { path: IPS_FILE, unitPath: UNIT_FILE, count: addresses.length, daemonReloaded: false, enabled: false, systemd: hasBinary('systemctl') };
    if (result.systemd) {
      const reload = await exec('systemctl', ['daemon-reload'], { allowFailure: true, timeoutMs: 60_000 });
      result.daemonReloaded = reload.code === 0;
      const enable = await exec('systemctl', ['enable', 'whm-ips.service'], { allowFailure: true, timeoutMs: 60_000 });
      result.enabled = enable.code === 0;
      if (!result.enabled) result.enableError = enable.stderr.trim().split('\n').pop() || null;
    }
    return result;
  },
});
