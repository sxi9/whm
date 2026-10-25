import fs from 'node:fs';
import os from 'node:os';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

function readMeminfo() {
  const out = {};
  try {
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) out[m[1]] = Number(m[2]) * 1024;
    }
  } catch { /* non-Linux dev host */ }
  return out;
}

function readOsRelease() {
  const out = {};
  try {
    for (const line of fs.readFileSync('/etc/os-release', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* ignore */ }
  return out;
}

export function parseDf(stdout) {
  return stdout.trim().split('\n').slice(1).map((line) => {
    const [filesystem, blocks, used, available, capacity, ...mount] = line.trim().split(/\s+/);
    return {
      filesystem,
      sizeBytes: Number(blocks) * 1024,
      usedBytes: Number(used) * 1024,
      availableBytes: Number(available) * 1024,
      usedPercent: Number(String(capacity).replace('%', '')),
      mountpoint: mount.join(' '),
    };
  }).filter((d) => d.filesystem && !/^(tmpfs|devtmpfs|overlay|squashfs|udev)$/.test(d.filesystem) || d.mountpoint === '/');
}

async function diskUsage() {
  if (!hasBinary('df')) return [];
  const { stdout } = await exec('df', ['-kP', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs'], { allowFailure: true });
  return parseDf(stdout);
}

defineOp('sys.info', {
  description: 'Hostname, OS, kernel, uptime, load, CPU, memory, disks and network interfaces',
  run: async () => {
    const mem = readMeminfo();
    const release = readOsRelease();
    const cpus = os.cpus();
    return {
      hostname: os.hostname(),
      os: { name: release.PRETTY_NAME || `${os.type()} ${os.release()}`, id: release.ID || os.platform(), version: release.VERSION_ID || null, kernel: os.release(), arch: os.arch() },
      uptimeSeconds: Math.floor(os.uptime()),
      loadAverage: os.loadavg(),
      cpu: { count: cpus.length, model: cpus[0]?.model || 'unknown', speedMHz: cpus[0]?.speed || null },
      memory: {
        totalBytes: mem.MemTotal ?? os.totalmem(),
        freeBytes: mem.MemFree ?? os.freemem(),
        availableBytes: mem.MemAvailable ?? os.freemem(),
        buffersBytes: mem.Buffers ?? 0,
        cachedBytes: mem.Cached ?? 0,
        swapTotalBytes: mem.SwapTotal ?? 0,
        swapFreeBytes: mem.SwapFree ?? 0,
      },
      disks: await diskUsage(),
      interfaces: Object.entries(os.networkInterfaces()).map(([name, addrs]) => ({
        name, addresses: (addrs || []).filter((a) => !a.internal).map((a) => ({ address: a.address, family: a.family, netmask: a.netmask })),
      })),
      node: process.version,
      agentPid: process.pid,
      agentUid: typeof process.getuid === 'function' ? process.getuid() : null,
    };
  },
});

defineOp('sys.disk.usage', {
  description: 'Filesystem usage (df)',
  run: diskUsage,
});

const PS_COLUMNS = ['pid', 'ppid', 'user:32', 'pcpu', 'pmem', 'rss', 'vsz', 'etimes', 'stat', 'comm', 'args'];

defineOp('sys.processes', {
  description: 'Running processes with CPU/memory usage',
  schema: z.object({
    sort: z.enum(['cpu', 'mem', 'pid', 'time']).default('cpu'),
    limit: z.number().int().min(1).max(5000).default(500),
    user: arg.username.optional(),
  }).strict(),
  run: async ({ sort, limit, user }) => {
    const sortFlag = { cpu: '-pcpu', mem: '-pmem', pid: 'pid', time: '-etimes' }[sort];
    const argv = ['-eo', PS_COLUMNS.join(','), '--no-headers', '--sort', sortFlag];
    if (user) argv.splice(0, 1, '-u', user, '-o');
    const { stdout } = await exec('ps', argv, { allowFailure: true });
    const rows = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      const [pid, ppid, usr, pcpu, pmem, rss, vsz, etimes, stat, comm] = parts;
      rows.push({
        pid: Number(pid), ppid: Number(ppid), user: usr, cpuPercent: Number(pcpu), memPercent: Number(pmem),
        rssBytes: Number(rss) * 1024, vszBytes: Number(vsz) * 1024, elapsedSeconds: Number(etimes), state: stat, command: comm,
        args: parts.slice(10).join(' ').slice(0, 512),
      });
      if (rows.length >= limit) break;
    }
    return rows;
  },
});

defineOp('sys.process.signal', {
  description: 'Send a signal to a process',
  destructive: true,
  schema: z.object({ pid: arg.pid, signal: arg.signal.default('SIGTERM') }).strict(),
  run: async ({ pid, signal }) => {
    if (pid === 1 || pid === process.pid) throw new OpError('refused', 'Refusing to signal PID 1 or the agent itself');
    try {
      process.kill(pid, signal);
    } catch (err) {
      if (err.code === 'ESRCH') throw new OpError('not_found', `No process with PID ${pid}`);
      throw new OpError('signal_failed', err.message);
    }
    return { pid, signal };
  },
});

defineOp('sys.process.renice', {
  description: 'Change a process priority',
  schema: z.object({ pid: arg.pid, niceness: z.number().int().min(-20).max(19) }).strict(),
  run: async ({ pid, niceness }) => {
    await exec('renice', ['-n', String(niceness), '-p', String(pid)]);
    return { pid, niceness };
  },
});

defineOp('sys.reboot', {
  description: 'Reboot the server (graceful stops services first)',
  destructive: true,
  schema: z.object({ mode: z.enum(['graceful', 'forceful']) }).strict(),
  run: async ({ mode }) => {
    if (mode === 'forceful') {
      // Does not wait for units to stop; equivalent to the WHM "Forceful Server Reboot".
      await exec('systemctl', ['reboot', '--force']);
    } else {
      await exec('systemctl', ['reboot']);
    }
    return { scheduled: true, mode };
  },
});

defineOp('sys.hostname.set', {
  description: 'Set the system hostname',
  schema: z.object({ hostname: arg.hostname }).strict(),
  run: async ({ hostname }) => {
    await exec('hostnamectl', ['set-hostname', hostname]);
    return { hostname };
  },
});

defineOp('sys.time.get', {
  description: 'Current time, timezone and NTP status',
  run: async () => {
    if (!hasBinary('timedatectl')) return { now: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ntp: null };
    const { stdout } = await exec('timedatectl', ['show'], { allowFailure: true });
    const kv = Object.fromEntries(stdout.trim().split('\n').map((l) => l.split('=')));
    return { now: new Date().toISOString(), timezone: kv.Timezone || null, ntp: kv.NTP === 'yes', ntpSynchronized: kv.NTPSynchronized === 'yes', rtcLocal: kv.LocalRTC === 'yes' };
  },
});

defineOp('sys.time.set', {
  description: 'Set timezone and NTP synchronisation',
  schema: z.object({
    timezone: z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/).optional(),
    ntp: z.boolean().optional(),
  }).strict(),
  run: async ({ timezone, ntp }) => {
    if (timezone) await exec('timedatectl', ['set-timezone', timezone]);
    if (ntp != null) await exec('timedatectl', ['set-ntp', ntp ? 'true' : 'false']);
    return { timezone, ntp };
  },
});

defineOp('sys.resolvers.get', {
  description: 'Read /etc/resolv.conf nameservers',
  run: async () => {
    try {
      const text = fs.readFileSync('/etc/resolv.conf', 'utf8');
      return { nameservers: [...text.matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]), raw: text };
    } catch { return { nameservers: [], raw: '' }; }
  },
});

defineOp('sys.resolvers.set', {
  description: 'Write /etc/resolv.conf nameservers',
  schema: z.object({ nameservers: z.array(arg.ip).min(1).max(4), search: z.array(arg.hostname).max(6).default([]) }).strict(),
  run: async ({ nameservers, search }) => {
    const lines = ['# Managed by WHM panel (Resolver Configuration)'];
    if (search.length) lines.push(`search ${search.join(' ')}`);
    for (const ns of nameservers) lines.push(`nameserver ${ns}`);
    fs.writeFileSync('/etc/resolv.conf', lines.join('\n') + '\n');
    return { nameservers, search };
  },
});

defineOp('sys.binaries', {
  description: 'Which of the given programs are installed (capability detection)',
  schema: z.object({ names: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)).min(1).max(100) }).strict(),
  run: async ({ names }) => Object.fromEntries(names.map((n) => [n, hasBinary(n)])),
});

defineOp('sys.read_file', {
  description: 'Read a system file from an allowed location (logs, configs)',
  schema: z.object({ path: arg.absPath, maxBytes: z.number().int().min(1).max(32 * 1024 * 1024).default(1024 * 1024), tail: z.boolean().default(true) }).strict(),
  run: async ({ path: file, maxBytes, tail }, ctx) => {
    ctx.assertAllowedPath(file, 'read');
    const stat = fs.statSync(file);
    const size = stat.size;
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(size, maxBytes);
      const position = tail ? Math.max(0, size - length) : 0;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, position);
      return { path: file, size, truncated: size > length, content: buf.toString('utf8') };
    } finally { fs.closeSync(fd); }
  },
});
