import fs from 'node:fs';
import { z } from 'zod';
import { defineOp, arg, OpError } from './registry.js';
import { exec, hasBinary } from '../exec.js';

// Networking Setup owns these: /etc/resolv.conf on a systemd-resolved host is a
// symlink into /run/systemd/resolve (tmpfs), so a plain write follows the link
// and is lost on the next resolved change or reboot. Taking the file over means
// removing the link and putting a regular file in its place.
export const RESOLV_CONF = '/etc/resolv.conf';
export const RESOLVED_RUN_DIR = '/run/systemd/resolve/';
// The backup and the rename-source are fixed siblings of RESOLV_CONF. The
// allowed root is the file itself, so assertAllowedPath cannot cover them; no
// argument ever reaches these names, which is why they are exempt from it.
export const RESOLV_BACKUP = `${RESOLV_CONF}.whm-bak`;
export const resolvTmpPath = () => `${RESOLV_CONF}.whm-tmp-${process.pid}`;

export function inspectResolvConf(p = RESOLV_CONF) {
  let st;
  try { st = fs.lstatSync(p); } catch (err) {
    if (err.code === 'ENOENT') return { path: p, exists: false, isSymlink: false, isRegular: false, target: null, managedByResolved: false };
    throw err;
  }
  const isSymlink = st.isSymbolicLink();
  let target = null;
  if (isSymlink) { try { target = fs.readlinkSync(p); } catch { target = null; } }
  return { path: p, exists: true, isSymlink, isRegular: st.isFile(), target, managedByResolved: Boolean(target && target.includes(RESOLVED_RUN_DIR.slice(0, -1))) };
}

export function renderResolvConf({ nameservers, search = [] }) {
  const lines = ['# Managed by WHM panel (Resolver Configuration)'];
  if (search.length) lines.push(`search ${search.join(' ')}`);
  for (const ns of nameservers) lines.push(`nameserver ${ns}`);
  return lines.join('\n') + '\n';
}

const IP_TOKEN = /^[0-9a-f.:]+(?:%[a-z0-9]+)?(?:#[a-z0-9.-]+)?$/i;
const cleanServer = (token) => token.replace(/[%#].*$/, '');

// `resolvectl dns` prints one line per scope ("Global: 1.1.1.1 1.0.0.1",
// "Link 2 (eth0): 10.0.0.1"); the older `systemd-resolve --status` prints
// "DNS Servers: a" followed by indented continuation lines inside per-link
// sections. Both are reduced to { global, links, servers }.
export function parseResolvectlDns(text) {
  const global = [];
  const links = [];
  let current = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const scope = line.match(/^(Global|Link\s+(\d+)\s+\(([^)]+)\)):\s*(.*)$/);
    if (scope) {
      const servers = scope[4].split(/\s+/).filter((t) => t && IP_TOKEN.test(t)).map(cleanServer);
      if (scope[1] === 'Global') { global.push(...servers); current = null; } else { current = { index: Number(scope[2]), name: scope[3], servers }; links.push(current); }
      continue;
    }
    const legacyLink = line.match(/^Link\s+(\d+)\s+\(([^)]+)\)\s*$/);
    if (legacyLink) { current = { index: Number(legacyLink[1]), name: legacyLink[2], servers: [] }; links.push(current); continue; }
    if (/^Global\s*$/.test(line)) { current = null; continue; }
    const legacyServers = line.match(/^\s*DNS Servers:\s*(.*)$/);
    if (legacyServers) {
      const servers = legacyServers[1].split(/\s+/).filter((t) => t && IP_TOKEN.test(t)).map(cleanServer);
      (current ? current.servers : global).push(...servers);
      continue;
    }
    // Continuation lines of a legacy "DNS Servers:" list hold one address each.
    if (/^\s+\S+\s*$/.test(raw)) {
      const token = raw.trim();
      if (IP_TOKEN.test(token) && /\d|:/.test(token)) (current ? current.servers : global).push(cleanServer(token));
    }
  }
  const servers = [...new Set([...global, ...links.flatMap((l) => l.servers)])];
  return { global: [...new Set(global)], links, servers };
}

defineOp('resolver.inspect', {
  description: 'Whether /etc/resolv.conf is a regular file or a symlink (and where it points)',
  run: async (_args, ctx) => {
    ctx.assertAllowedPath(RESOLV_CONF, 'read');
    return inspectResolvConf();
  },
});

defineOp('resolver.upstream', {
  description: 'The upstream DNS servers systemd-resolved forwards to (resolvectl dns)',
  run: async () => {
    if (hasBinary('resolvectl')) {
      const { stdout } = await exec('resolvectl', ['dns'], { timeoutMs: 10_000 });
      return { source: 'resolvectl', ...parseResolvectlDns(stdout) };
    }
    if (hasBinary('systemd-resolve')) {
      const { stdout } = await exec('systemd-resolve', ['--status', '--no-pager'], { timeoutMs: 10_000 });
      return { source: 'systemd-resolve', ...parseResolvectlDns(stdout) };
    }
    throw new OpError('binary_not_found', 'resolvectl is not installed on this server', { bin: 'resolvectl' });
  },
});

defineOp('resolver.write_static', {
  description: 'Replace /etc/resolv.conf (a symlink included) with a regular, panel-managed file',
  schema: z.object({ nameservers: z.array(arg.ip).min(1).max(4), search: z.array(arg.hostname).max(6).default([]) }).strict(),
  destructive: true,
  run: async ({ nameservers, search }, ctx) => {
    ctx.assertAllowedPath(RESOLV_CONF, 'write');
    const before = inspectResolvConf();
    let previousContent = null;
    if (before.exists) {
      try { previousContent = fs.readFileSync(RESOLV_CONF, 'utf8'); } catch { previousContent = null; }
      if (previousContent != null) fs.writeFileSync(RESOLV_BACKUP, previousContent, { mode: 0o644 });
      if (before.isSymlink) fs.unlinkSync(RESOLV_CONF);
    }
    const tmp = resolvTmpPath();
    fs.writeFileSync(tmp, renderResolvConf({ nameservers, search }), { mode: 0o644 });
    fs.renameSync(tmp, RESOLV_CONF);
    const after = inspectResolvConf();
    return { path: RESOLV_CONF, nameservers, search, replacedSymlink: before.isSymlink, previousTarget: before.target, backup: previousContent != null ? RESOLV_BACKUP : null, isRegular: after.isRegular, isSymlink: after.isSymlink };
  },
});
