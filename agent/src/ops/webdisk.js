import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { accountPath, assertManaged, asUser, failureOf, lstatOrNull } from './as-user.js';
import { appsDir, MANAGED_PREFIX, requireSystemd, unitStatus, installUnit, removeUnit, controlUnit } from './unit-helpers.js';
import { stagedWrite } from './files.js';
import { BCRYPT_RE } from './dav.js';

// Web Disk (contract §71): one `rclone serve webdav` per account, run as the
// account by a hardened unit (keel-webdisk-<username>, rendered here from a
// fixed template into /etc/whm/apps/<username>/ and linked into systemd like
// the Application Manager units), bound to loopback and reached through the
// hostname site's reverse proxy at /webdisk/<username>/. The htpasswd file
// lives in the account's own home (0600, written as the account) and holds
// the bcrypt hash the panel made; the plain password never reaches this process.

export const UNIT_PREFIX = 'keel-webdisk';
export const URL_PREFIX = '/webdisk';
export const KEEL_DIR = '.keel';
export const HTPASSWD_REL = `${KEEL_DIR}/webdisk.htpasswd`;
export const CACHE_REL = `${KEEL_DIR}/webdisk-cache`;
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;
// The login is the account's own name (unique by construction); the pattern
// keeps ":" (the htpasswd separator), whitespace and control characters out.
export const WEBDISK_LOGIN_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MANAGED = `${MANAGED_PREFIX} (Web Disk). Edit through the panel; manual changes are overwritten.`;

export const unitName = (username) => `${UNIT_PREFIX}-${username}`;
export const unitFile = (username) => path.join(appsDir(), username, `${unitName(username)}.service`);
export const baseUrl = (username) => `${URL_PREFIX}/${username}`;

const port = z.number().int().min(PORT_MIN).max(PORT_MAX);
const login = z.string().regex(WEBDISK_LOGIN_RE, 'Web Disk login');
const hash = z.string().regex(BCRYPT_RE, 'bcrypt hash');
const ref = z.object({ username: arg.username }).strict();

function rcloneBinary() {
  const bin = resolveBinary('rclone');
  if (!bin) throw new OpError('capability_missing', 'rclone is not installed on this server; install the rclone package first');
  return bin;
}

// The unit text. The daemon runs as the account with no new privileges, sees
// the file system read-only except the home, keeps its VFS write cache inside
// the home (quota-counted) and never reads a configuration file. ~/.ssh and
// ~/.keel are hidden from the share (rclone anchors a leading "/" to the served
// root): the panel's ssh_managed policy and the htpasswd file the daemon
// authenticates against must not be reachable over WebDAV.
export function renderUnit({ username, port: p, home, gid, rclone }) {
  const lines = [
    MANAGED,
    `# whm-webdisk ${JSON.stringify({ username, port: p, baseUrl: baseUrl(username) })}`,
    '[Unit]',
    `Description=Keel Web Disk (${username})`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${username}`,
    `Group=${gid != null ? gid : username}`,
    `WorkingDirectory=${home}`,
    `Environment="HOME=${home}"`,
    `ExecStart=${rclone} serve webdav ${home} --addr 127.0.0.1:${p} --baseurl ${baseUrl(username)} --htpasswd ${path.posix.join(home, HTPASSWD_REL)} --config /dev/null --cache-dir ${path.posix.join(home, CACHE_REL)} --vfs-cache-mode writes --dir-cache-time 5s --umask 022 --log-level NOTICE --exclude /.ssh/** --exclude /.keel/**`,
    'Restart=on-failure',
    'RestartSec=3',
    'TimeoutStopSec=20',
    'NoNewPrivileges=true',
    'ProtectSystem=strict',
    `ReadWritePaths=${home}`,
    'PrivateTmp=true',
    'ProtectKernelTunables=true',
    'ProtectControlGroups=true',
    'RestrictSUIDSGID=true',
    'StandardOutput=journal',
    'StandardError=journal',
    `SyslogIdentifier=${unitName(username)}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ];
  return `${lines.join('\n')}\n`;
}

export function parseUnitMeta(text) {
  const line = (text || '').split('\n').find((l) => l.startsWith('# whm-webdisk '));
  if (!line) return null;
  try { return JSON.parse(line.slice('# whm-webdisk '.length)); } catch { return null; }
}

// The htpasswd file of the account, pinned under its home through symlinks.
function htpasswdOf(username, ctx, mode) {
  const info = assertManaged(username);
  const file = accountPath(username, path.join(path.resolve(info.home), HTPASSWD_REL), ctx, mode);
  const st = lstatOrNull(file.real);
  return { ...file, exists: Boolean(st && st.isFile()) };
}

defineOp('webdisk.unit.write', {
  description: 'Render the Web Disk unit of an account (rclone serve webdav as the account on a loopback port) under /etc/whm/apps, link it into systemd, enable it and (re)start it',
  timeoutMs: 180_000,
  schema: z.object({ username: arg.username, port }).strict(),
  run: async ({ username, port: p }, ctx) => {
    requireSystemd();
    const rclone = rcloneBinary();
    const h = htpasswdOf(username, ctx, 'read');
    if (!h.exists) throw new OpError('not_found', `${username} has no Web Disk password yet; set one before enabling Web Disk`);
    const file = ctx.assertAllowedPath(unitFile(username), 'write');
    const content = renderUnit({ username, port: p, home: h.home, gid: h.info.gid, rclone });
    const r = await installUnit({ unit: unitName(username), file, content });
    return { ...r, port: p, baseUrl: baseUrl(username), rclone };
  },
});

defineOp('webdisk.unit.remove', {
  description: 'Stop, disable and unlink the Web Disk unit of an account and delete its file under /etc/whm/apps',
  destructive: true,
  timeoutMs: 120_000,
  schema: ref,
  run: async ({ username }, ctx) => {
    requireSystemd();
    const file = ctx.assertAllowedPath(unitFile(username), 'write');
    return removeUnit({ unit: unitName(username), file });
  },
});

defineOp('webdisk.unit.control', {
  description: 'Start, stop or restart the Web Disk unit of an account',
  destructive: true,
  timeoutMs: 120_000,
  schema: ref.extend({ action: z.enum(['start', 'stop', 'restart']) }).strict(),
  run: async ({ username, action }) => controlUnit(unitName(username), action),
});

defineOp('webdisk.unit.status', {
  description: 'State of the Web Disk unit of an account, whether its htpasswd file exists and whether rclone is installed',
  schema: ref,
  run: async ({ username }, ctx) => {
    const unit = unitName(username);
    const file = ctx.assertAllowedPath(unitFile(username), 'read');
    let meta = null;
    try { meta = parseUnitMeta(fs.readFileSync(file, 'utf8')); } catch { meta = null; }
    const h = htpasswdOf(username, ctx, 'read');
    const status = hasBinary('systemctl') ? await unitStatus(unit) : { unit, installed: false, active: false, state: 'absent' };
    return { ...status, path: file, port: meta?.port ?? null, baseUrl: baseUrl(username), htpasswd: { path: h.target, exists: h.exists }, rclone: { installed: Boolean(resolveBinary('rclone')) } };
  },
});

defineOp('webdisk.htpasswd.set', {
  description: 'Write the Web Disk htpasswd file of an account (one login, a bcrypt hash made by the panel) as the account: ~/.keel 0700, the file 0600',
  schema: z.object({ username: arg.username, login, hash }).strict(),
  run: async ({ username, login: who, hash: value }, ctx) => {
    const h = htpasswdOf(username, ctx, 'write');
    const dir = path.posix.join(h.home, KEEL_DIR);
    const mk = await asUser(h.info, 'mkdir', ['-p', '-m', '700', '--', dir], { allowFailure: true, timeoutMs: 30_000 });
    if (mk.code !== 0) throw failureOf(mk, `create ${KEEL_DIR}`);
    const ch = await asUser(h.info, 'chmod', ['--', '700', dir], { allowFailure: true, timeoutMs: 30_000 });
    if (ch.code !== 0) throw failureOf(ch, `chmod 700 ${KEEL_DIR}`);
    await stagedWrite(h.info, h.home, h.target, `${who}:${value}\n`, '600');
    return { login: who, path: h.target, created: !h.exists, replaced: h.exists };
  },
});

defineOp('webdisk.htpasswd.remove', {
  description: 'Delete the Web Disk htpasswd file of an account as the account',
  destructive: true,
  schema: ref,
  run: async ({ username }, ctx) => {
    const h = htpasswdOf(username, ctx, 'write');
    if (!h.exists) return { path: h.target, removed: false };
    const rm = await asUser(h.info, 'rm', ['-f', '--', h.target], { allowFailure: true, timeoutMs: 30_000 });
    if (rm.code !== 0) throw failureOf(rm, `remove ${HTPASSWD_REL}`);
    return { path: h.target, removed: true };
  },
});
