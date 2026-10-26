import fs from 'node:fs';
import { z } from 'zod';
import { defineOp, arg } from './registry.js';

// Networking Setup owns these: /etc/resolv.conf on a systemd-resolved host is a
// symlink into /run/systemd/resolve (tmpfs), so a plain write follows the link
// and is lost on the next resolved change or reboot. Taking the file over means
// removing the link and putting a regular file in its place.
export const RESOLV_CONF = '/etc/resolv.conf';
export const RESOLVED_RUN_DIR = '/run/systemd/resolve/';

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

defineOp('resolver.inspect', {
  description: 'Whether /etc/resolv.conf is a regular file or a symlink (and where it points)',
  run: async (_args, ctx) => {
    ctx.assertAllowedPath(RESOLV_CONF, 'read');
    return inspectResolvConf();
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
      if (previousContent != null) fs.writeFileSync(`${RESOLV_CONF}.whm-bak`, previousContent, { mode: 0o644 });
      if (before.isSymlink) fs.unlinkSync(RESOLV_CONF);
    }
    const tmp = `${RESOLV_CONF}.whm-tmp-${process.pid}`;
    fs.writeFileSync(tmp, renderResolvConf({ nameservers, search }), { mode: 0o644 });
    fs.renameSync(tmp, RESOLV_CONF);
    const after = inspectResolvConf();
    return { path: RESOLV_CONF, nameservers, search, replacedSymlink: before.isSymlink, previousTarget: before.target, isRegular: after.isRegular, isSymlink: after.isSymlink };
  },
});
