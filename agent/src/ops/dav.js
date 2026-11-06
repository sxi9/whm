import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineOp, OpError } from './registry.js';
import { exec, hasBinary } from '../exec.js';
import { RADICALE } from '../managed-paths.js';

// CalDAV/CardDAV through the distribution's Radicale: a system service bound to
// loopback, authenticated from one panel-owned htpasswd file (bcrypt hashes
// made by the panel; the plain password never reaches this process), one
// collection tree per login (rights = owner_only). The panel publishes it as
// /dav/ under the hostname site through web.host.app.write { proxy }.

const MANAGED = '# Managed by Keel';
const MARK = '# keel-radicale ';
const MAX_USERS = 64 * 1024;
const MAX_READ = 1024 * 1024;

// A DAV login is an address: the mailbox or sub-user form local@domain. The
// local part admits ".", "_" and "-" only inside; ":" (the htpasswd separator),
// whitespace and control characters can never reach the file.
export const DAV_LOGIN_RE = /^(?=.{3,254}$)[a-z0-9][a-z0-9._-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// A bcrypt hash exactly as bcrypt/bcryptjs print it; nothing else is written.
export const BCRYPT_RE = /^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;
const login = z.string().regex(DAV_LOGIN_RE, 'DAV login (local@domain)');
const hash = z.string().regex(BCRYPT_RE, 'bcrypt hash');

export function renderRadicaleConfig(r = RADICALE) {
  const meta = { host: r.host, port: r.port, users: r.users, storage: r.storage };
  return [
    `${MANAGED} (Calendars and Contacts). Edit through the panel; manual changes are overwritten.`,
    `${MARK}${JSON.stringify(meta)}`,
    '',
    '[server]',
    `hosts = ${r.host}:${r.port}`,
    'max_connections = 20',
    'max_content_length = 100000000',
    'timeout = 30',
    '',
    '[auth]',
    'type = htpasswd',
    `htpasswd_filename = ${r.users}`,
    'htpasswd_encryption = bcrypt',
    'delay = 1',
    '',
    '[rights]',
    'type = owner_only',
    '',
    '[storage]',
    'type = multifilesystem',
    `filesystem_folder = ${r.storage}`,
    '',
    '[web]',
    'type = internal',
    '',
    '[logging]',
    'level = warning',
    'mask_passwords = True',
    '',
  ].join('\n');
}

export function parseConfigMeta(text) {
  const line = String(text || '').split('\n').find((l) => l.startsWith(MARK));
  if (!line) return null;
  try { return JSON.parse(line.slice(MARK.length)); } catch { return null; }
}

// htpasswd lines are "login:hash"; anything that is not one is kept verbatim
// (comments, blanks) so a hand-added line survives a panel write.
export function parseUsers(text) {
  return String(text || '').split('\n').filter((l) => l.trim()).map((l) => {
    const i = l.indexOf(':');
    return i > 0 && !l.startsWith('#') ? { login: l.slice(0, i), hash: l.slice(i + 1) } : { raw: l };
  });
}

export function renderUsers(entries) {
  return entries.map((e) => (e.raw != null ? e.raw : `${e.login}:${e.hash}`)).join('\n') + (entries.length ? '\n' : '');
}

export function upsertUser(text, who, value) {
  const entries = parseUsers(text);
  const found = entries.find((e) => e.login === who);
  if (found) found.hash = value; else entries.push({ login: who, hash: value });
  return renderUsers(entries);
}

export function removeUser(text, who) {
  const entries = parseUsers(text);
  const kept = entries.filter((e) => e.login !== who);
  return { content: renderUsers(kept), removed: kept.length !== entries.length };
}

function readText(file, max = MAX_READ) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > max) throw new OpError('refused', `${file} is larger than ${max} bytes`);
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch (err) {
    if (err instanceof OpError) throw err;
    return null;
  } finally { if (fd != null) fs.closeSync(fd); }
}

function groupId(name) {
  try {
    const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.startsWith(`${name}:`));
    return line ? Number(line.split(':')[2]) : null;
  } catch { return null; }
}

// Temp file beside the target, mode and group set before the rename; a symlink
// or a non-regular file in the way is refused, never followed.
function writeAtomic(file, content, { mode, gid = null } = {}) {
  let st = null;
  try { st = fs.lstatSync(file); } catch { st = null; }
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new OpError('refused', `${file} is not a regular file`);
  const tmp = `${file}.whm-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  if (gid != null) fs.chownSync(tmp, 0, gid);
  fs.renameSync(tmp, file);
}

function ensureUsersFile(ctx) {
  const dir = ctx.assertAllowedPath(RADICALE.usersDir, 'write');
  const file = ctx.assertAllowedPath(RADICALE.users, 'write');
  const gid = groupId(RADICALE.group);
  if (gid == null) throw new OpError('capability_missing', `The "${RADICALE.group}" group does not exist; install the radicale package first`);
  // The package's own directory: the radicale user must traverse it (it cannot traverse /etc/whm, 0750 root:whmpanel).
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  let st = null;
  try { st = fs.lstatSync(file); } catch { st = null; }
  if (!st) writeAtomic(file, '', { mode: 0o640, gid });
  else {
    if (st.isSymbolicLink() || !st.isFile()) throw new OpError('refused', `${file} is not a regular file`);
    if ((st.mode & 0o7777) !== 0o640 || st.uid !== 0 || st.gid !== gid) { fs.chmodSync(file, 0o640); fs.chownSync(file, 0, gid); }
  }
  return { file, gid };
}

async function unitState() {
  if (!hasBinary('systemctl')) return { name: RADICALE.unit, present: false, active: null, enabled: null };
  const r = await exec('systemctl', ['show', `${RADICALE.unit}.service`, '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID'], { allowFailure: true, timeoutMs: 15_000 });
  const kv = Object.fromEntries(r.stdout.split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  const present = kv.LoadState === 'loaded';
  return { name: RADICALE.unit, present, active: present ? kv.ActiveState === 'active' : null, state: kv.ActiveState || null, subState: kv.SubState || null, enabled: present ? ['enabled', 'static'].includes(kv.UnitFileState) : null, pid: Number(kv.MainPID) || null };
}

async function radicaleVersion() {
  if (!hasBinary('radicale')) return null;
  const r = await exec('radicale', ['--version'], { allowFailure: true, timeoutMs: 20_000 });
  const m = `${r.stdout}${r.stderr}`.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

async function bcryptAvailable() {
  if (!hasBinary('python3')) return false;
  const r = await exec('python3', ['-I', '-c', 'import bcrypt'], { allowFailure: true, timeoutMs: 20_000 });
  return r.code === 0;
}

function userCount(ctx) {
  let file;
  try { file = ctx.assertAllowedPath(RADICALE.users, 'read'); } catch { return { exists: false, count: 0 }; }
  const text = readText(file, MAX_USERS);
  if (text == null) return { exists: false, count: 0 };
  return { exists: true, count: parseUsers(text).filter((e) => e.login).length };
}

async function status(ctx) {
  const installed = hasBinary('radicale');
  const configFile = ctx.assertAllowedPath(RADICALE.config, 'read');
  const text = readText(configFile);
  const expected = renderRadicaleConfig();
  const unit = installed ? await unitState() : { name: RADICALE.unit, present: false, active: null, enabled: null };
  return {
    installed, version: installed ? await radicaleVersion() : null, bcrypt: installed ? await bcryptAvailable() : null,
    listen: { host: RADICALE.host, port: RADICALE.port }, packages: RADICALE.packages,
    config: { path: configFile, exists: text != null, managed: text != null && text.includes(MARK), inSync: text === expected, meta: parseConfigMeta(text) },
    users: { path: RADICALE.users, ...userCount(ctx) },
    storage: { path: RADICALE.storage, exists: (() => { try { return fs.statSync(RADICALE.storage).isDirectory(); } catch { return false; } })() },
    unit,
  };
}

defineOp('dav.status', {
  description: 'Radicale (CalDAV/CardDAV) on this host: package, version, python bcrypt, managed config state, htpasswd user count, storage and unit',
  run: async (_a, ctx) => status(ctx),
});

// Package installation is the Software category's job (pkg.install); this op
// renders the configuration, prepares the htpasswd file and enables the unit.
defineOp('dav.install', {
  description: 'Configure the installed Radicale for the panel: managed /etc/radicale/config (loopback, htpasswd bcrypt, owner_only rights), the 0640 root:radicale users file, the collections directory, and enable + (re)start the unit',
  timeoutMs: 120_000,
  schema: z.object({ restart: z.boolean().default(true) }).strict(),
  run: async ({ restart }, ctx) => {
    if (!hasBinary('radicale')) throw new OpError('capability_missing', `Radicale is not installed on this server; install the ${RADICALE.packages.join(' and ')} packages first`);
    const gid = groupId(RADICALE.group);
    if (gid == null) throw new OpError('capability_missing', `The "${RADICALE.group}" group does not exist; the radicale package did not install cleanly`);
    const configFile = ctx.assertAllowedPath(RADICALE.config, 'write');
    fs.mkdirSync(ctx.assertAllowedPath(RADICALE.configDir, 'write'), { recursive: true, mode: 0o755 });
    const previous = readText(configFile);
    const content = renderRadicaleConfig();
    let changed = false;
    if (previous !== content) {
      // The distribution's file is kept once beside the managed one, never overwritten again.
      if (previous != null && !previous.includes(MARK) && !fs.existsSync(`${configFile}.keel-orig`)) fs.copyFileSync(configFile, `${configFile}.keel-orig`);
      writeAtomic(configFile, content, { mode: 0o640, gid });
      changed = true;
    } else { fs.chmodSync(configFile, 0o640); fs.chownSync(configFile, 0, gid); }
    const users = ensureUsersFile(ctx);
    const storage = ctx.assertAllowedPath(RADICALE.storage, 'write');
    const storageCreated = !fs.existsSync(storage);
    fs.mkdirSync(storage, { recursive: true, mode: 0o750 });
    const st = fs.statSync(storage);
    const uid = (() => { try { const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${RADICALE.user}:`)); return line ? Number(line.split(':')[2]) : null; } catch { return null; } })();
    if (uid != null && (st.uid !== uid || st.gid !== gid)) fs.chownSync(storage, uid, gid);
    if (!hasBinary('systemctl')) return { config: { path: configFile, changed }, users: { path: users.file }, storage: { path: storage, created: storageCreated }, unit: { name: RADICALE.unit, present: false, enabled: false, restarted: false } };
    await exec('systemctl', ['enable', '--now', `${RADICALE.unit}.service`], { timeoutMs: 60_000 });
    let restarted = false;
    if (restart && changed) { await exec('systemctl', ['restart', `${RADICALE.unit}.service`], { timeoutMs: 60_000 }); restarted = true; }
    const unit = await unitState();
    if (!unit.active) {
      const j = await exec('journalctl', ['-u', `${RADICALE.unit}.service`, '-n', '20', '--no-pager'], { allowFailure: true, timeoutMs: 15_000 });
      throw new OpError('command_failed', `${RADICALE.unit}.service is not running after the configuration was written`, { output: `${j.stdout}${j.stderr}`.slice(-4000) });
    }
    return { config: { path: configFile, changed, backup: `${configFile}.keel-orig` }, users: { path: users.file }, storage: { path: storage, created: storageCreated }, unit: { ...unit, restarted }, listen: { host: RADICALE.host, port: RADICALE.port } };
  },
});

defineOp('dav.user.set', {
  description: 'Add or replace one login in the Radicale htpasswd file with a bcrypt hash made by the panel (atomic rewrite, 0640 root:radicale)',
  schema: z.object({ login, hash }).strict(),
  run: async ({ login: who, hash: value }, ctx) => {
    const { file, gid } = ensureUsersFile(ctx);
    const text = readText(file, MAX_USERS) ?? '';
    const existed = parseUsers(text).some((e) => e.login === who);
    writeAtomic(file, upsertUser(text, who, value), { mode: 0o640, gid });
    return { login: who, path: file, created: !existed, replaced: existed };
  },
});

defineOp('dav.user.remove', {
  description: 'Remove one login from the Radicale htpasswd file (the collections stay on disk)',
  destructive: true,
  schema: z.object({ login }).strict(),
  run: async ({ login: who }, ctx) => {
    const file = ctx.assertAllowedPath(RADICALE.users, 'write');
    const text = readText(file, MAX_USERS);
    if (text == null) return { login: who, path: file, removed: false };
    const r = removeUser(text, who);
    if (r.removed) writeAtomic(file, r.content, { mode: 0o640, gid: groupId(RADICALE.group) });
    return { login: who, path: file, removed: r.removed };
  },
});

// Radicale's multifilesystem store: collection-root/<login>/<collection>/ with
// a .Radicale.props JSON naming the tag (VCALENDAR / VADDRESSBOOK) and the
// display name; items are the .ics/.vcf files inside.
export function parseProps(text) {
  try {
    const p = JSON.parse(text || '{}');
    return { tag: typeof p.tag === 'string' ? p.tag : null, displayName: typeof p['D:displayname'] === 'string' ? p['D:displayname'] : null, description: typeof p['C:calendar-description'] === 'string' ? p['C:calendar-description'] : (typeof p['CR:addressbook-description'] === 'string' ? p['CR:addressbook-description'] : null), color: typeof p['ICAL:calendar-color'] === 'string' ? p['ICAL:calendar-color'] : null };
  } catch { return { tag: null, displayName: null, description: null, color: null }; }
}

const KIND = { VCALENDAR: 'calendar', VADDRESSBOOK: 'addressbook' };

defineOp('dav.collections', {
  description: 'Read-only listing of one login\'s collections in the Radicale store (kind, display name, item count, last change)',
  schema: z.object({ login }).strict(),
  run: async ({ login: who }, ctx) => {
    const root = ctx.assertAllowedPath(path.join(RADICALE.storage, 'collection-root'), 'read');
    const dir = ctx.assertAllowedPath(path.join(root, who), 'read');
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { login: who, path: dir, exists: false, collections: [] }; }
    const collections = [];
    for (const e of entries.slice(0, 500)) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const cdir = path.join(dir, e.name);
      const props = parseProps(readText(path.join(cdir, '.Radicale.props'), 64 * 1024));
      let items = 0; let mtime = null;
      try {
        for (const f of fs.readdirSync(cdir, { withFileTypes: true })) {
          if (!f.isFile() || f.name.startsWith('.')) continue;
          items++;
          const m = fs.statSync(path.join(cdir, f.name)).mtime;
          if (!mtime || m > mtime) mtime = m;
        }
      } catch { /* unreadable collection: counted as empty */ }
      collections.push({ name: e.name, kind: KIND[props.tag] || 'other', tag: props.tag, displayName: props.displayName, description: props.description, color: props.color, items, updatedAt: mtime ? mtime.toISOString() : null });
    }
    collections.sort((x, y) => x.name.localeCompare(y.name));
    return { login: who, path: dir, exists: true, collections };
  },
});
