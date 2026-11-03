import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { eximBaseLayout } from './exim-layout.js';
import { assertManaged } from './as-user.js';
import { SHADOW_HASH } from './transfer.js';

// Virtual mailboxes for the customer panel. The agent owns a handful of data
// files that Dovecot (passwd-file passdb/userdb) and Exim (lsearch lookups in
// the whm_* routers service-configuration renders) read at auth/delivery time:
//   /etc/dovecot/whm/passwd/<domain>            0640 root:dovecot
//   <eximConfDir>/whm/aliases/<domain>           forwarders (local: target, target)
//   <eximConfDir>/whm/domainfwd.lst              domain: target-domain
//   <eximConfDir>/whm/autoresponders/<domain>/<local> (body) + <local>.conf (lsearch headers)
//   <eximConfDir>/whm/spam_users.lst             domain: user=… enabled=0|1 threshold=… autodelete=0|1
//   /var/lib/whm/autoreply/<local>@<domain>.db   Exim autoreply "once" databases
// The grammar of every file is the one service-configuration's whm_* fragments
// read (renderEximVirtualRouters/Transports, renderEximSpamAcl); agent/test
// keeps the two in parity.
// Every value that lands in one of those files is validated here against the
// field grammar of that file (no ':' in a passwd field, no newline anywhere, no
// Exim expansion or pipe/file syntax in a redirect target), so a value that got
// past the API can still never become a second field, a second line or an
// expansion. The uid/gid/home behind a mailbox always come from /etc/passwd.

export const DOVECOT_PASSWD_DIR = '/etc/dovecot/whm/passwd';
export const AUTOREPLY_DB_DIR = '/var/lib/whm/autoreply';
export const MANAGED = '# Keel (customer panel mail) - managed file, edits are overwritten';

export const LOCAL_PART = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// A forwarding target: a plain address (no "|", "/", "$", "{", ":" or blanks,
// so it can never be read as a pipe, a file, an expansion or an :include:), or
// one of the two Exim special items the panel allows.
export const EMAIL_TARGET = /^(?=.{3,254}$)[A-Za-z0-9][A-Za-z0-9._+=-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export const SPECIAL_TARGETS = [':fail:', ':blackhole:'];
export const EMAIL_ADDRESS = /^(?=.{3,254}$)[a-z0-9][a-z0-9._-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Passwd-file home field: an absolute path made of plain characters, so it can
// never carry a ':' (field separator), a blank (extra-field separator) or a newline.
export const HOME_FIELD = /^\/(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
export const SINGLE_LINE = /^[^\n\r\0]*$/;
export const CHARSET = /^[A-Za-z0-9._-]{1,32}$/;
export const PASSWORD = /^[^\n\r\0]{1,256}$/;

const localPart = z.string().regex(LOCAL_PART, 'Local part: lowercase letters, digits, ".", "_" or "-"; max 64 chars');
const aliasKey = z.union([localPart, z.literal('*')]);
const target = z.string().refine((v) => SPECIAL_TARGETS.includes(v) || EMAIL_TARGET.test(v), 'A forwarding target must be an email address, ":fail:" or ":blackhole:"');
const emailAddress = z.string().regex(EMAIL_ADDRESS, 'Email address');
const hash = z.string().regex(SHADOW_HASH, 'Must be a crypt(3) hash such as $6$…');
const quotaBytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const singleLine = (max) => z.string().max(max).regex(SINGLE_LINE, 'Single line');
const isoDate = z.string().datetime({ offset: true });

// ---------------------------------------------------------------- helpers ---

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function groupGid(name) {
  const line = (readText('/etc/group') || '').split('\n').find((l) => l.startsWith(`${name}:`));
  return line ? Number(line.split(':')[2]) : null;
}

function passwdEntry(name) {
  const line = (readText('/etc/passwd') || '').split('\n').find((l) => l.startsWith(`${name}:`));
  return line ? { name, uid: Number(line.split(':')[2]), gid: Number(line.split(':')[3]) } : null;
}

const ensureNl = (s) => (s.endsWith('\n') ? s : `${s}\n`);

// A directory the agent writes data files into: created (and owned) by root
// with the given mode/group; a symlink or a foreign owner is refused so a
// tenant can never redirect a managed file.
function ensureManagedDir(dir, { mode = 0o755, gid = null, uid = 0 } = {}) {
  let st;
  try { st = fs.lstatSync(dir); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(dir, { recursive: true, mode });
    st = fs.lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new OpError('path_not_allowed', `${dir} is not a directory`);
  if (st.uid !== 0 && st.uid !== uid) throw new OpError('path_not_allowed', `${dir} is owned by uid ${st.uid}; remove it so the agent can create its own`);
  try { fs.chmodSync(dir, mode); if (gid != null || uid !== 0) fs.chownSync(dir, uid, gid ?? st.gid); } catch { /* best effort on hosts without the group */ }
  return dir;
}

// Temp file beside the target, mode/owner set before the rename, previous
// content kept as .whm-bak. Refuses to replace a symlink.
function writeAtomic(file, content, { mode = 0o644, gid = null } = {}) {
  const st = (() => { try { return fs.lstatSync(file); } catch { return null; } })();
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new OpError('path_not_allowed', `${file} is not a regular file`);
  if (st) fs.copyFileSync(file, `${file}.whm-bak`);
  const tmp = `${file}.whm-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  if (gid != null) { try { fs.chownSync(tmp, 0, gid); } catch { /* group missing */ } }
  fs.renameSync(tmp, file);
}

function removeFile(file) {
  const st = (() => { try { return fs.lstatSync(file); } catch { return null; } })();
  if (!st) return false;
  if (st.isSymbolicLink() || !st.isFile()) throw new OpError('path_not_allowed', `${file} is not a regular file`);
  fs.unlinkSync(file);
  try { fs.unlinkSync(`${file}.whm-bak`); } catch { /* none */ }
  return true;
}

export function dovecotPresent() {
  return hasBinary('dovecot') || hasBinary('doveconf') || exists('/etc/dovecot');
}

function requireDovecotDir(ctx) {
  if (!dovecotPresent()) throw new OpError('capability_missing', 'Dovecot is not installed on this server (no dovecot binary and no /etc/dovecot)');
  ctx.assertAllowedPath(DOVECOT_PASSWD_DIR, 'write');
  ensureManagedDir(path.dirname(DOVECOT_PASSWD_DIR), { mode: 0o755 });
  const gid = groupGid('dovecot');
  ensureManagedDir(DOVECOT_PASSWD_DIR, { mode: 0o750, gid });
  return { gid };
}

export function eximWhmDir() {
  const layout = eximBaseLayout();
  if (!layout.confDir) throw new OpError('capability_missing', 'Exim is not installed on this server (neither /etc/exim4 nor /etc/exim exists)');
  return { layout, whmDir: layout.whmDir };
}

export function eximRunUser() {
  return ['Debian-exim', 'exim', 'mail', 'mailnull'].map(passwdEntry).find(Boolean) || null;
}

// --------------------------------------------------------- passwd rendering ---

// One Dovecot passwd-file line. Every field is re-validated here against the
// file grammar, whatever the schema already checked, because this is the last
// step before the bytes land on disk.
export function renderPasswdLine({ localPart: local, hash: h, uid, gid, home, domain, quotaBytes: quota = null, disabled = false }) {
  if (!LOCAL_PART.test(local)) throw new OpError('invalid_args', 'Invalid mailbox local part');
  if (!SHADOW_HASH.test(h) || h.includes(':')) throw new OpError('invalid_args', 'Invalid password hash');
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) throw new OpError('invalid_args', 'Invalid uid/gid');
  if (!HOME_FIELD.test(home)) throw new OpError('invalid_args', `Home directory "${home}" cannot be used in a passwd file`);
  if (!arg.domain.safeParse(domain).success) throw new OpError('invalid_args', 'Invalid domain');
  const extra = [`userdb_mail=maildir:~/mail/${domain}/${local}`];
  if (quota != null && quota > 0) extra.push(`userdb_quota_rule=*:bytes=${quota}`);
  if (disabled) extra.push('nologin=y');
  const line = `${local}:{SHA512-CRYPT}${h}:${uid}:${gid}::${home}::${extra.join(' ')}`;
  if (!SINGLE_LINE.test(line)) throw new OpError('invalid_args', 'Passwd line would span lines');
  return line;
}

export function parsePasswdLine(line) {
  if (!line || line.startsWith('#')) return null;
  const parts = line.split(':');
  if (parts.length < 8) return null;
  const [local, , uid, gid, , home] = parts;
  const extra = parts.slice(7).join(':');
  const fields = Object.fromEntries(extra.split(/\s+/).filter(Boolean).map((kv) => { const i = kv.indexOf('='); return i < 0 ? [kv, true] : [kv.slice(0, i), kv.slice(i + 1)]; }));
  const quota = fields.userdb_quota_rule?.match(/bytes=(\d+)/);
  return { localPart: local, uid: Number(uid), gid: Number(gid), home, quotaBytes: quota ? Number(quota[1]) : null, disabled: fields.nologin === 'y' };
}

export function upsertPasswdText(previous, local, line) {
  const lines = (previous || '').split('\n').filter((l) => l !== '');
  const body = lines.filter((l) => !l.startsWith('#'));
  const idx = body.findIndex((l) => l.split(':')[0] === local);
  if (idx >= 0) body[idx] = line; else body.push(line);
  return `${MANAGED}\n${body.join('\n')}\n`;
}

// A domain's passwd file belongs to exactly one hosting account: every line
// must carry that account's uid. Lines of any other uid are stale (a previous
// owner of the domain) and are dropped before the new line is added, so a
// mailbox of this domain can never stay mapped onto another account's home.
export function dropForeignPasswdLines(previous, uid) {
  const body = (previous || '').split('\n').filter((l) => l !== '' && !l.startsWith('#'));
  const purged = [];
  const kept = body.filter((l) => {
    const parsed = parsePasswdLine(l);
    if (parsed && parsed.uid === uid) return true;
    purged.push({ localPart: l.split(':')[0], uid: parsed?.uid ?? null });
    return false;
  });
  return { text: kept.length ? `${MANAGED}\n${kept.join('\n')}\n` : '', purged };
}

export function removeFromPasswdText(previous, local) {
  const body = (previous || '').split('\n').filter((l) => l !== '' && !l.startsWith('#'));
  const kept = body.filter((l) => l.split(':')[0] !== local);
  return { text: kept.length ? `${MANAGED}\n${kept.join('\n')}\n` : '', removed: kept.length !== body.length, empty: kept.length === 0 };
}

const passwdFile = (domain) => path.join(DOVECOT_PASSWD_DIR, domain);

// ---------------------------------------------------------- alias rendering ---

export function renderAliases(domain, entries) {
  const seen = new Set();
  const lines = [`${MANAGED} (forwarders for ${domain})`];
  for (const { localPart: key, targets } of entries) {
    if (key !== '*' && !LOCAL_PART.test(key)) throw new OpError('invalid_args', `Invalid alias "${key}"`);
    if (seen.has(key)) throw new OpError('invalid_args', `Alias "${key}" listed twice`);
    seen.add(key);
    const rendered = targets.map((t) => {
      if (t === ':fail:') return ':fail: no such address here';
      if (t === ':blackhole:') return ':blackhole:';
      if (!EMAIL_TARGET.test(t)) throw new OpError('invalid_args', `Invalid forwarding target "${t}"`);
      return t.toLowerCase();
    });
    // Exim reads ":fail:"/":blackhole:" only as the whole redirect list.
    if (rendered.length > 1 && rendered.some((t) => t.startsWith(':'))) throw new OpError('invalid_args', `":fail:" and ":blackhole:" cannot be combined with other targets (alias "${key}")`);
    lines.push(`${key}: ${rendered.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderDomainForwards(entries) {
  const seen = new Set();
  const lines = [`${MANAGED} (domain forwarders: domain: target-domain)`];
  for (const { domain, target: t } of entries) {
    if (!arg.domain.safeParse(domain).success || !arg.domain.safeParse(t).success) throw new OpError('invalid_args', 'Invalid domain in forward list');
    if (domain === t) throw new OpError('invalid_args', `${domain} cannot forward to itself`);
    if (seen.has(domain)) throw new OpError('invalid_args', `${domain} listed twice`);
    seen.add(domain);
    lines.push(`${domain}: ${t}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderSpamUsers(entries) {
  const seen = new Set();
  const lines = [`${MANAGED} (spam settings per recipient domain)`];
  for (const e of entries) {
    if (!arg.domain.safeParse(e.domain).success || !arg.username.safeParse(e.username).success) throw new OpError('invalid_args', 'Invalid spam list entry');
    if (!Number.isInteger(e.threshold) || e.threshold < 10 || e.threshold > 200) throw new OpError('invalid_args', 'Spam threshold must be 10..200 (score x10)');
    if (seen.has(e.domain)) throw new OpError('invalid_args', `${e.domain} listed twice`);
    seen.add(e.domain);
    lines.push(`${e.domain}: user=${e.username} enabled=${e.enabled ? 1 : 0} threshold=${e.threshold} autodelete=${e.autoDelete ? 1 : 0}`);
  }
  return `${lines.join('\n')}\n`;
}

// lsearch "key: value" headers for the whm_autoreply router/transport
// (service-configuration): keys from, subject, charset, interval (hours),
// start/stop (epoch seconds), enabled (0|1). A key whose value would be empty
// is left out so the fragment's lookup defaults apply (Exim's numeric
// comparisons fail on an empty string, and an empty "from" would render as
// '"" <address>').
export const AUTORESPONDER_KEYS = ['from', 'subject', 'charset', 'interval', 'start', 'stop', 'enabled'];
export function renderAutoresponderConf({ fromName = '', subject, charset, intervalHours, startAt = null, stopAt = null, enabled = true }) {
  for (const [k, v, max] of [['from', fromName, 128], ['subject', subject, 255]]) {
    if (typeof v !== 'string' || v.length > max || !SINGLE_LINE.test(v)) throw new OpError('invalid_args', `${k} must be a single line of at most ${max} characters`);
  }
  if (!CHARSET.test(charset)) throw new OpError('invalid_args', 'Invalid charset');
  if (!Number.isInteger(intervalHours) || intervalHours < 0 || intervalHours > 720) throw new OpError('invalid_args', 'interval must be 0..720 hours');
  const epoch = (iso) => { const t = Date.parse(iso); if (!Number.isFinite(t)) throw new OpError('invalid_args', 'Invalid date'); return String(Math.floor(t / 1000)); };
  const lines = [MANAGED];
  if (fromName !== '') lines.push(`from: ${fromName}`);
  lines.push(`subject: ${subject}`, `charset: ${charset}`, `interval: ${intervalHours}`);
  if (startAt != null) lines.push(`start: ${epoch(startAt)}`);
  if (stopAt != null) lines.push(`stop: ${epoch(stopAt)}`);
  lines.push(`enabled: ${enabled ? 1 : 0}`);
  return `${lines.join('\n')}\n`;
}

// The Exim autoreply transport's once database for one address (flat under
// AUTOREPLY_DB_DIR, as the transport's `once =` names it); ndbm builds add
// .pag/.dir beside it.
export const autoreplyOnceFiles = (domain, local) => ['', '.pag', '.dir'].map((ext) => path.join(AUTOREPLY_DB_DIR, `${local}@${domain}.db${ext}`));

// ------------------------------------------------------------------- ops ---

defineOp('vmail.hash', {
  description: 'SHA512-CRYPT hash of a mailbox password (openssl passwd -6 or mkpasswd; the password travels on stdin only)',
  schema: z.object({ password: z.string().regex(PASSWORD, 'Password: 1..256 characters, no newline') }).strict(),
  timeoutMs: 30_000,
  run: async ({ password }) => {
    // doveadm pw reads the password from the controlling terminal, not from
    // stdin, so it is not usable from a daemon; openssl and mkpasswd are.
    let r;
    let tool;
    if (hasBinary('openssl')) { tool = 'openssl'; r = await exec('openssl', ['passwd', '-6', '-stdin'], { input: `${password}\n`, timeoutMs: 30_000 }); }
    else if (hasBinary('mkpasswd')) { tool = 'mkpasswd'; r = await exec('mkpasswd', ['-m', 'sha-512', '-s'], { input: `${password}\n`, timeoutMs: 30_000 }); }
    else throw new OpError('capability_missing', 'openssl (or mkpasswd from whois) is required to hash mailbox passwords');
    const out = r.stdout.trim().split('\n')[0] || '';
    if (!SHADOW_HASH.test(out) || !out.startsWith('$6$')) throw new OpError('command_failed', `${tool} did not produce a SHA512-CRYPT hash`);
    return { hash: out, scheme: 'SHA512-CRYPT', tool };
  },
});

const passwdSetSchema = z.object({
  domain: arg.domain,
  localPart,
  hash,
  username: arg.username,
  quotaBytes,
  disabled: z.boolean().default(false),
}).strict();

defineOp('vmail.passwd.set', {
  description: 'Add or replace a mailbox line in the Dovecot passwd-file of a domain; uid/gid/home come from /etc/passwd for the named hosting account',
  schema: passwdSetSchema,
  timeoutMs: 30_000,
  run: async ({ domain, localPart: local, hash: h, username, quotaBytes: quota, disabled }, ctx) => {
    const { gid } = requireDovecotDir(ctx);
    const info = assertManaged(username);
    const home = path.resolve(info.home);
    ctx.assertAllowedPath(home, 'read');
    const file = ctx.assertAllowedPath(passwdFile(domain), 'write');
    const line = renderPasswdLine({ localPart: local, hash: h, uid: info.uid, gid: info.gid, home, domain, quotaBytes: quota, disabled });
    const previous = readText(file);
    const { text: own, purged } = dropForeignPasswdLines(previous, info.uid);
    writeAtomic(file, upsertPasswdText(own, local, line), { mode: 0o640, gid });
    return { domain, localPart: local, path: file, uid: info.uid, gid: info.gid, home, quotaBytes: quota, disabled, replaced: Boolean(own && own.split('\n').some((l) => l.split(':')[0] === local)), purged };
  },
});

defineOp('vmail.passwd.purge', {
  description: 'Delete the whole Dovecot passwd-file of a domain (every mailbox line) when the domain leaves its hosting account',
  schema: z.object({ domain: arg.domain }).strict(),
  destructive: true,
  timeoutMs: 30_000,
  run: async ({ domain }, ctx) => {
    requireDovecotDir(ctx);
    const file = ctx.assertAllowedPath(passwdFile(domain), 'write');
    const users = (readText(file) || '').split('\n').map(parsePasswdLine).filter(Boolean).map((u) => u.localPart);
    return { domain, path: file, removed: removeFile(file), users };
  },
});

defineOp('vmail.passwd.remove', {
  description: 'Remove a mailbox line from the Dovecot passwd-file of a domain (the file is deleted when empty)',
  schema: z.object({ domain: arg.domain, localPart }).strict(),
  destructive: true,
  timeoutMs: 30_000,
  run: async ({ domain, localPart: local }, ctx) => {
    const { gid } = requireDovecotDir(ctx);
    const file = ctx.assertAllowedPath(passwdFile(domain), 'write');
    const previous = readText(file);
    if (previous == null) return { domain, localPart: local, removed: false, fileRemoved: false };
    const { text, removed, empty } = removeFromPasswdText(previous, local);
    if (empty) removeFile(file); else writeAtomic(file, text, { mode: 0o640, gid });
    return { domain, localPart: local, removed, fileRemoved: empty };
  },
});

defineOp('vmail.passwd.list', {
  description: 'Mailboxes in the Dovecot passwd-file of a domain (never the hashes)',
  schema: z.object({ domain: arg.domain }).strict(),
  run: async ({ domain }, ctx) => {
    const file = ctx.assertAllowedPath(passwdFile(domain), 'read');
    const text = readText(file);
    const users = (text || '').split('\n').map(parsePasswdLine).filter(Boolean);
    return { domain, exists: text != null, users };
  },
});

// `doveadm quota get` prints a table: Quota name / Type / Value / Limit / %,
// with STORAGE in kilobytes and "-" for no limit.
export function parseDoveadmQuota(stdout) {
  const out = { bytes: null, limitBytes: null, messages: null, messageLimit: null };
  for (const line of String(stdout || '').split('\n')) {
    const m = line.trim().match(/^(.*?)\s+(STORAGE|MESSAGE)\s+(\d+)\s+(\d+|-)\s+(\d+|-)?\s*$/i);
    if (!m) continue;
    const value = Number(m[3]);
    const limit = m[4] === '-' ? null : Number(m[4]);
    if (m[2].toUpperCase() === 'STORAGE') { out.bytes = value * 1024; out.limitBytes = limit == null ? null : limit * 1024; } else { out.messages = value; out.messageLimit = limit; }
  }
  return out;
}

defineOp('vmail.quota.get', {
  description: 'Mailbox usage and limit through doveadm quota get',
  schema: z.object({ user: emailAddress }).strict(),
  timeoutMs: 60_000,
  run: async ({ user }) => {
    if (!hasBinary('doveadm')) throw new OpError('capability_missing', 'doveadm (Dovecot) is required to read mailbox quotas');
    const r = await exec('doveadm', ['quota', 'get', '-u', user], { allowFailure: true, timeoutMs: 60_000 });
    if (r.code !== 0) {
      const last = (r.stderr || r.stdout).trim().split('\n').pop() || '';
      if (/doesn't exist|not found|unknown user|no such user/i.test(last)) throw new OpError('not_found', `Mailbox ${user} is unknown to Dovecot: ${last}`);
      if (/quota.*not.*enabled|plugin|no quota/i.test(last)) throw new OpError('unsupported', `Dovecot quota is not enabled: ${last}`);
      throw new OpError('command_failed', `doveadm quota get failed: ${last}`);
    }
    return { user, ...parseDoveadmQuota(r.stdout) };
  },
});

const aliasEntry = z.object({ localPart: aliasKey, targets: z.array(target).min(1).max(50) }).strict();

defineOp('vmail.aliases.write', {
  description: 'Render the forwarders of a domain into <eximConfDir>/whm/aliases/<domain> (local: target, target); pipes, files and expansions are never accepted',
  schema: z.object({ domain: arg.domain, entries: z.array(aliasEntry).max(2000) }).strict(),
  timeoutMs: 30_000,
  run: async ({ domain, entries }, ctx) => {
    const { whmDir } = eximWhmDir();
    const dir = ctx.assertAllowedPath(path.join(whmDir, 'aliases'), 'write');
    const file = ctx.assertAllowedPath(path.join(dir, domain), 'write');
    const content = renderAliases(domain, entries);
    ensureManagedDir(path.dirname(dir), { mode: 0o755 });
    ensureManagedDir(dir, { mode: 0o755 });
    writeAtomic(file, content, { mode: 0o644 });
    return { domain, path: file, entries: entries.length, bytes: Buffer.byteLength(content) };
  },
});

defineOp('vmail.aliases.remove', {
  description: 'Delete the forwarders file of a domain',
  schema: z.object({ domain: arg.domain }).strict(),
  destructive: true,
  run: async ({ domain }, ctx) => {
    const { whmDir } = eximWhmDir();
    const file = ctx.assertAllowedPath(path.join(whmDir, 'aliases', domain), 'write');
    return { domain, path: file, removed: removeFile(file) };
  },
});

defineOp('vmail.domainfwd.write', {
  description: 'Full rewrite of <eximConfDir>/whm/domainfwd.lst (domain: target-domain)',
  schema: z.object({ entries: z.array(z.object({ domain: arg.domain, target: arg.domain }).strict()).max(5000) }).strict(),
  timeoutMs: 30_000,
  run: async ({ entries }, ctx) => {
    const { whmDir } = eximWhmDir();
    const file = ctx.assertAllowedPath(path.join(whmDir, 'domainfwd.lst'), 'write');
    const content = renderDomainForwards(entries);
    ensureManagedDir(whmDir, { mode: 0o755 });
    writeAtomic(file, content, { mode: 0o644 });
    return { path: file, entries: entries.length };
  },
});

const autoresponderSchema = z.object({
  domain: arg.domain,
  localPart,
  fromName: singleLine(128).default(''),
  subject: singleLine(255).min(1),
  body: z.string().max(64 * 1024),
  charset: z.string().regex(CHARSET, 'Charset: letters, digits, ".", "_" or "-"').default('utf-8'),
  intervalHours: z.number().int().min(0).max(720).default(24),
  startAt: isoDate.optional(),
  stopAt: isoDate.optional(),
  enabled: z.boolean().default(true),
}).strict();

defineOp('vmail.autoresponder.write', {
  description: 'Write the autoresponder body (<domain>/<local>) and headers (<local>.conf, lsearch key: value) of an address and prepare the Exim autoreply once-database directory',
  schema: autoresponderSchema,
  timeoutMs: 30_000,
  run: async ({ domain, localPart: local, fromName, subject, body, charset, intervalHours, startAt, stopAt, enabled }, ctx) => {
    const { whmDir } = eximWhmDir();
    const root = ctx.assertAllowedPath(path.join(whmDir, 'autoresponders'), 'write');
    const dir = ctx.assertAllowedPath(path.join(root, domain), 'write');
    const conf = ctx.assertAllowedPath(path.join(dir, `${local}.conf`), 'write');
    const text = ctx.assertAllowedPath(path.join(dir, local), 'write');
    const headers = renderAutoresponderConf({ fromName, subject, charset, intervalHours, startAt: startAt ?? null, stopAt: stopAt ?? null, enabled });
    if (body.includes('\0')) throw new OpError('invalid_args', 'The body cannot contain NUL bytes');
    ensureManagedDir(whmDir, { mode: 0o755 });
    ensureManagedDir(root, { mode: 0o755 });
    ensureManagedDir(dir, { mode: 0o755 });
    writeAtomic(text, ensureNl(body), { mode: 0o644 });
    writeAtomic(conf, headers, { mode: 0o644 });
    // The autoreply transport keeps its "once" databases here (one flat file
    // per address), writing as the Exim run user; the directory is
    // root-created so a tenant cannot plant it.
    const onceRoot = ctx.assertAllowedPath(AUTOREPLY_DB_DIR, 'write');
    const runUser = eximRunUser();
    ensureManagedDir(onceRoot, { mode: 0o750, uid: runUser?.uid ?? 0, gid: runUser?.gid ?? null });
    return { domain, localPart: local, conf, body: text, once: autoreplyOnceFiles(domain, local)[0], onceOwner: runUser?.name ?? 'root' };
  },
});

defineOp('vmail.autoresponder.remove', {
  description: 'Remove the autoresponder files and the Exim once-database of an address',
  schema: z.object({ domain: arg.domain, localPart }).strict(),
  destructive: true,
  run: async ({ domain, localPart: local }, ctx) => {
    const { whmDir } = eximWhmDir();
    const dir = path.join(whmDir, 'autoresponders', domain);
    const conf = ctx.assertAllowedPath(path.join(dir, `${local}.conf`), 'write');
    const text = ctx.assertAllowedPath(path.join(dir, local), 'write');
    const removed = [removeFile(conf), removeFile(text)].some(Boolean);
    let onceRemoved = false;
    for (const once of autoreplyOnceFiles(domain, local)) {
      ctx.assertAllowedPath(once, 'write');
      try { if (fs.lstatSync(once).isFile()) { fs.unlinkSync(once); onceRemoved = true; } } catch { /* none */ }
    }
    return { domain, localPart: local, removed, onceRemoved };
  },
});

const spamEntry = z.object({ domain: arg.domain, username: arg.username, enabled: z.boolean(), threshold: z.number().int().min(10).max(200), autoDelete: z.boolean() }).strict();

defineOp('vmail.spam_users.write', {
  description: 'Full rewrite of <eximConfDir>/whm/spam_users.lst (per recipient domain: account, enabled, threshold x10, auto-delete), read by the DATA ACL',
  schema: z.object({ entries: z.array(spamEntry).max(20000) }).strict(),
  timeoutMs: 30_000,
  run: async ({ entries }, ctx) => {
    const { whmDir } = eximWhmDir();
    const file = ctx.assertAllowedPath(path.join(whmDir, 'spam_users.lst'), 'write');
    const content = renderSpamUsers(entries);
    ensureManagedDir(whmDir, { mode: 0o755 });
    writeAtomic(file, content, { mode: 0o644 });
    return { path: file, entries: entries.length };
  },
});

// Names service-configuration gives the slots it renders (seam S4).
export const EXPECTED_EXIM = { router: 'whm_virtual_user', transport: 'whm_dovecot_lmtp', authenticator: 'dovecot_plain' };

async function eximList(bin, what) {
  const r = await exec(bin, ['-bP', what], { allowFailure: true, timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : null;
}

defineOp('vmail.render.check', {
  description: 'Whether Dovecot and Exim accept their configuration and whether the virtual-mail router, LMTP transport and Dovecot authenticator are present',
  schema: z.object({}).strict(),
  timeoutMs: 120_000,
  run: async () => {
    const out = { dovecot: { installed: false, configOk: null, output: null }, exim: { installed: false, configOk: null, output: null }, routerHooked: false, transportHooked: false, authHooked: false, hint: null };
    if (hasBinary('doveconf')) {
      out.dovecot.installed = true;
      const r = await exec('doveconf', ['-n'], { allowFailure: true, timeoutMs: 60_000 });
      out.dovecot.configOk = r.code === 0;
      out.dovecot.output = r.code === 0 ? null : (r.stderr || r.stdout).trim().split('\n').pop() || null;
      out.dovecot.passwdFilePasses = r.code === 0 && r.stdout.includes(DOVECOT_PASSWD_DIR);
    } else if (hasBinary('dovecot')) out.dovecot.installed = true;
    const layout = eximBaseLayout();
    if (layout.installed) {
      out.exim.installed = true;
      const r = await exec(layout.bin, ['-bV'], { allowFailure: true, timeoutMs: 60_000 });
      out.exim.configOk = r.code === 0 && !/configuration error|Exim configuration error/i.test(`${r.stdout}${r.stderr}`);
      out.exim.output = out.exim.configOk ? null : `${r.stdout}${r.stderr}`.trim().split('\n').pop() || null;
      if (out.exim.configOk) {
        const [routers, transports, auths] = await Promise.all([eximList(layout.bin, 'router_list'), eximList(layout.bin, 'transport_list'), eximList(layout.bin, 'authenticator_list')]);
        out.routerHooked = Boolean(routers?.includes(EXPECTED_EXIM.router));
        out.transportHooked = Boolean(transports?.includes(EXPECTED_EXIM.transport));
        out.authHooked = Boolean(auths?.includes(EXPECTED_EXIM.authenticator));
        out.routers = routers || [];
      }
    }
    const missing = [];
    if (!out.dovecot.installed) missing.push('install Dovecot (dovecot-imapd, dovecot-lmtpd) for mailbox storage and IMAP/POP3');
    if (!out.exim.installed) missing.push('install Exim for delivery');
    if (out.exim.installed && out.exim.configOk && !out.routerHooked) missing.push(`Exim has no "${EXPECTED_EXIM.router}" router: apply the virtual-mail configuration from Service Configuration (Exim Configuration Manager)`);
    if (out.exim.installed && out.exim.configOk && !out.authHooked) missing.push(`Exim has no "${EXPECTED_EXIM.authenticator}" authenticator, so mailbox users cannot send through SMTP`);
    out.hint = missing.length ? missing.join('; ') : null;
    return out;
  },
});
