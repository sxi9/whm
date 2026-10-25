import fs from 'node:fs';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

const SYSTEM_USERS = new Set(['root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'nobody', 'systemd-network', 'systemd-resolve', 'messagebus', 'sshd', 'mysql', 'postfix', 'exim', 'exim4', 'named', 'bind', 'dovecot', 'nginx', 'apache', 'whmpanel', 'Debian-exim']);

function getent(username) {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${username}:`));
    if (!line) return null;
    const [name, , uid, gid, gecos, home, shell] = line.split(':');
    return { username: name, uid: Number(uid), gid: Number(gid), gecos, home, shell };
  } catch { return null; }
}

function assertManaged(username) {
  if (SYSTEM_USERS.has(username)) throw new OpError('refused', `"${username}" is a system account and is not managed by the panel`);
  const info = getent(username);
  if (info && info.uid < 1000) throw new OpError('refused', `"${username}" has a system UID (${info.uid}) and is not managed by the panel`);
  return info;
}

defineOp('user.get', {
  description: 'Look up a Linux user',
  schema: z.object({ username: arg.username }).strict(),
  run: async ({ username }) => getent(username),
});

defineOp('user.create', {
  description: 'Create a hosting account Linux user with a home directory',
  schema: z.object({
    username: arg.username,
    homeDir: arg.absPath,
    shell: arg.shell.default('/usr/sbin/nologin'),
    comment: z.string().regex(/^[^:\n]{0,120}$/).optional(),
  }).strict(),
  run: async ({ username, homeDir, shell, comment }, ctx) => {
    if (SYSTEM_USERS.has(username)) throw new OpError('refused', `"${username}" is reserved`);
    if (getent(username)) throw new OpError('exists', `Linux user "${username}" already exists`);
    ctx.assertAllowedPath(homeDir, 'write');
    const argv = ['-m', '-d', homeDir, '-s', shell, '-U'];
    if (comment) argv.push('-c', comment);
    argv.push(username);
    await exec('useradd', argv);
    fs.chmodSync(homeDir, 0o711);
    return getent(username);
  },
});

defineOp('user.delete', {
  description: 'Delete a hosting account Linux user',
  destructive: true,
  timeoutMs: 300_000,
  schema: z.object({ username: arg.username, removeHome: z.boolean().default(true), killProcesses: z.boolean().default(true) }).strict(),
  run: async ({ username, removeHome, killProcesses }) => {
    const info = assertManaged(username);
    if (!info) return { username, existed: false };
    if (killProcesses && hasBinary('pkill')) await exec('pkill', ['-KILL', '-u', username], { allowFailure: true });
    const argv = removeHome ? ['-r', username] : [username];
    await exec('userdel', argv, { timeoutMs: 300_000 });
    return { username, existed: true, removedHome: removeHome };
  },
});

defineOp('user.set_password', {
  description: 'Set a Linux user password',
  schema: z.object({ username: arg.username, password: z.string().min(1).max(256).regex(/^[^\n\0]+$/) }).strict(),
  run: async ({ username, password }) => {
    if (!getent(username)) throw new OpError('not_found', `Linux user "${username}" does not exist`);
    if (username !== 'root') assertManaged(username);
    // chpasswd reads "user:password" from stdin, so the secret never appears in argv.
    await exec('chpasswd', [], { input: `${username}:${password}\n` });
    return { username };
  },
});

defineOp('user.set_shell', {
  description: 'Change a user login shell',
  schema: z.object({ username: arg.username, shell: arg.shell }).strict(),
  run: async ({ username, shell }) => {
    assertManaged(username);
    await exec('usermod', ['-s', shell, username]);
    return getent(username);
  },
});

defineOp('user.lock', {
  description: 'Lock (suspend) a user account',
  schema: z.object({ username: arg.username }).strict(),
  run: async ({ username }) => {
    assertManaged(username);
    await exec('usermod', ['-L', username]);
    return { username, locked: true };
  },
});

defineOp('user.unlock', {
  description: 'Unlock (unsuspend) a user account',
  schema: z.object({ username: arg.username }).strict(),
  run: async ({ username }) => {
    assertManaged(username);
    await exec('usermod', ['-U', username]);
    return { username, locked: false };
  },
});

defineOp('user.set_quota', {
  description: 'Set filesystem disk quota for a user (MB; 0 = unlimited)',
  schema: z.object({
    username: arg.username,
    softMb: z.number().int().min(0).max(1_000_000_000),
    hardMb: z.number().int().min(0).max(1_000_000_000),
    filesystem: arg.absPath.default('/'),
  }).strict(),
  run: async ({ username, softMb, hardMb, filesystem }) => {
    assertManaged(username);
    if (!hasBinary('setquota')) throw new OpError('capability_missing', 'Disk quotas are not installed (quota package missing). Use Initial Quota Setup first.');
    const soft = String(softMb * 1024);
    const hard = String(hardMb * 1024);
    await exec('setquota', ['-u', username, soft, hard, '0', '0', filesystem]);
    return { username, softMb, hardMb, filesystem };
  },
});

defineOp('user.quota_report', {
  description: 'Disk quota usage for all users (repquota)',
  schema: z.object({ filesystem: arg.absPath.default('/') }).strict(),
  run: async ({ filesystem }) => {
    if (!hasBinary('repquota')) return { available: false, users: [] };
    const { stdout } = await exec('repquota', ['-u', '-p', filesystem], { allowFailure: true });
    const users = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(\S+)\s+[-+]{2}\s+(\d+)\s+(\d+)\s+(\d+)/);
      if (m) users.push({ username: m[1], usedMb: Math.round(Number(m[2]) / 1024), softMb: Math.round(Number(m[3]) / 1024), hardMb: Math.round(Number(m[4]) / 1024) });
    }
    return { available: true, users };
  },
});

defineOp('user.list_managed', {
  description: 'Non-system users with their home and shell',
  run: async () => {
    const out = [];
    try {
      for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
        const [username, , uid, gid, , home, shell] = line.split(':');
        if (username && Number(uid) >= 1000 && username !== 'nobody') out.push({ username, uid: Number(uid), gid: Number(gid), home, shell });
      }
    } catch { /* ignore */ }
    return out;
  },
});

defineOp('user.groups.members', {
  description: 'Members of a Unix group (e.g. wheel/sudo)',
  schema: z.object({ group: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/) }).strict(),
  run: async ({ group }) => {
    try {
      const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.startsWith(`${group}:`));
      if (!line) return { group, exists: false, members: [] };
      return { group, exists: true, members: line.split(':')[3]?.split(',').filter(Boolean) || [] };
    } catch { return { group, exists: false, members: [] }; }
  },
});

defineOp('user.groups.set_membership', {
  description: 'Add or remove a user from a group',
  schema: z.object({ username: arg.username, group: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), member: z.boolean() }).strict(),
  run: async ({ username, group, member }) => {
    if (!getent(username)) throw new OpError('not_found', `Linux user "${username}" does not exist`);
    await exec('gpasswd', [member ? '-a' : '-d', username, group]);
    return { username, group, member };
  },
});
