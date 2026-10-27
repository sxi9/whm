import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp } from './registry.js';

// §16.5: three stable identifiers, each hashed separately so no raw value ever
// leaves the server; the panel sends the hashes to the license hub, which only
// compares them. A component the host cannot provide hashes a constant so the
// fingerprint stays deterministic across runs.
export const FP_VERSION = 'whmfp1';
const MISSING = 'missing';

export const h = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export function combine(components) {
  const digest = crypto.createHash('sha256').update(`${FP_VERSION}|${components.machine_id}|${components.mac}|${components.disk}`).digest('hex');
  return `sha256:${digest}`;
}

function readFirst(files) {
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function machineId() {
  return readFirst(['/etc/machine-id', '/var/lib/dbus/machine-id']);
}

export function parseDefaultRouteDev(stdout) {
  try {
    const routes = JSON.parse(stdout);
    const dev = routes.find((r) => r && typeof r.dev === 'string')?.dev;
    return dev && /^[a-zA-Z0-9._-]{1,15}$/.test(dev) ? dev : null;
  } catch { return null; }
}

export function parseLinkMac(stdout) {
  try {
    const links = JSON.parse(stdout);
    const mac = links.find((l) => l && typeof l.address === 'string')?.address;
    return mac && /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(mac) && !/^(00:){5}00$/.test(mac) ? mac.toLowerCase() : null;
  } catch { return null; }
}

async function defaultRouteMac() {
  if (!hasBinary('ip')) return null;
  const route = await exec('ip', ['-j', '-4', 'route', 'show', 'default'], { allowFailure: true });
  let dev = route.code === 0 ? parseDefaultRouteDev(route.stdout) : null;
  if (!dev) {
    const v6 = await exec('ip', ['-j', '-6', 'route', 'show', 'default'], { allowFailure: true });
    dev = v6.code === 0 ? parseDefaultRouteDev(v6.stdout) : null;
  }
  if (!dev) return null;
  const link = await exec('ip', ['-j', 'link', 'show', 'dev', dev], { allowFailure: true });
  if (link.code !== 0) return null;
  const mac = parseLinkMac(link.stdout);
  if (mac) return mac;
  return readFirst([`/sys/class/net/${dev}/address`]);
}

export function parseFindmntUuid(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const fsys = parsed?.filesystems?.[0];
    const uuid = fsys?.uuid || null;
    return uuid && /^[A-Za-z0-9-]{4,64}$/.test(uuid) ? uuid : null;
  } catch { return null; }
}

async function rootDiskId() {
  if (hasBinary('findmnt')) {
    const { code, stdout } = await exec('findmnt', ['-J', '-o', 'UUID', '/'], { allowFailure: true });
    if (code === 0) {
      const uuid = parseFindmntUuid(stdout);
      if (uuid) return uuid;
    }
  }
  try {
    const ids = fs.readdirSync('/dev/disk/by-id').filter((n) => !n.includes('-part')).sort();
    if (ids.length) return ids.join(',');
  } catch { /* no udev tree (container) */ }
  return null;
}

defineOp('sys.fingerprint', {
  description: 'Server fingerprint for licensing: separate SHA-256 hashes of the machine id, the default-route MAC and the root filesystem UUID; raw values are never returned',
  schema: z.object({}).strict(),
  run: async () => {
    const mid = machineId();
    const mac = await defaultRouteMac();
    const disk = await rootDiskId();
    const components = { machine_id: h(mid ?? MISSING), mac: h(mac ?? MISSING), disk: h(disk ?? MISSING) };
    return {
      version: FP_VERSION,
      fingerprint: combine(components),
      components,
      available: { machine_id: mid != null, mac: mac != null, disk: disk != null },
    };
  },
});
