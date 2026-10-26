import fs from 'node:fs';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// Server Contacts: the system alias file that decides where mail for the
// system accounts goes (Edit System Mail Preferences). Only the entries of
// MANAGED_USERS are managed; every other alias the admin wrote is kept byte
// for byte.

export const ALIASES_FILE = '/etc/aliases';
// Backups and the temp file for the atomic replace live under the agent's own
// state root rather than beside /etc/aliases, which is the only /etc path the
// policy allows the op to touch.
export const ALIASES_WORKDIR = '/var/lib/whm/contacts';
// WHM manages mail for root, the panel's own service user and nobody (the
// web server user, whose cron and PHP mail lands there).
export const MANAGED_USERS = ['root', 'nobody'];
const managedMark = (user) => `# ${user} alias managed by WHM panel (Edit System Mail Preferences)`;
const MANAGED_MARK = managedMark('root');
const MANAGED_MARK_RE = /^# [a-z]+ alias managed by WHM panel \(Edit System Mail Preferences\)$/;

// A target is a local account or a full address; a local part may not start
// with "-" so nothing option-shaped ever reaches a mail tool's argv.
const aliasTarget = z.union([
  arg.username,
  z.string().max(254).regex(/^[A-Za-z0-9_][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/, 'Email address'),
]);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

// aliases(5): "name: target, target"; a line starting with whitespace continues
// the previous entry; "#" starts a comment.
export function parseAliases(text) {
  const entries = [];
  let current = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\s/.test(line) && current) { current.targets.push(...splitTargets(line)); continue; }
    const m = line.match(/^([^\s:]+)\s*:\s*(.*)$/);
    if (!m) continue;
    current = { name: m[1], targets: splitTargets(m[2]) };
    entries.push(current);
  }
  return entries;
}

function splitTargets(s) {
  return s.split(',').map((t) => t.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

// Rewrites (or appends) one user's entry and drops its continuation lines; an
// empty target list removes the entry so that user's mail stays in the local
// mailbox. Other users' managed entries are left untouched.
export function renderUserAlias(text, user, targets) {
  if (!MANAGED_USERS.includes(user)) throw new OpError('invalid_args', `Aliases for "${user}" are not managed by the panel`);
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let skipping = false;
  const entryRe = new RegExp(`^${user}\\s*:`);
  for (const line of lines) {
    if (skipping && /^\s/.test(line)) continue;
    skipping = false;
    if (line === managedMark(user)) continue;
    if (entryRe.test(line)) { skipping = true; continue; }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  if (targets.length) out.push(managedMark(user), `${user}: ${targets.join(', ')}`);
  return `${out.join('\n')}\n`;
}

export function renderRootAlias(text, targets) {
  return renderUserAlias(text, 'root', targets);
}

// rename(2) only works within one filesystem; when /etc and /var/lib differ
// the content is written in place and fsynced instead.
function replaceFile(target, tmp, content) {
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err.code !== 'EXDEV') throw err;
    const fd = fs.openSync(target, 'w', 0o644);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}

// Which tool turns the text file into what the MTA reads: Postfix/Sendmail
// need newaliases; Exim's system_aliases router reads /etc/aliases directly.
function rebuildTool() {
  if (hasBinary('newaliases')) return 'newaliases';
  if (hasBinary('exim') || hasBinary('exim4')) return 'exim';
  return null;
}

defineOp('contacts.aliases.read', {
  description: 'Read /etc/aliases: where mail for root and nobody is forwarded and every other alias',
  run: async (_args, ctx) => {
    ctx.assertAllowedPath(ALIASES_FILE, 'read');
    const text = readText(ALIASES_FILE);
    const entries = parseAliases(text);
    const forUser = (user) => entries.filter((e) => e.name === user).flatMap((e) => e.targets);
    return {
      path: ALIASES_FILE,
      exists: text != null,
      root: forUser('root'),
      users: Object.fromEntries(MANAGED_USERS.map((u) => [u, forUser(u)])),
      managed: (text || '').split('\n').some((l) => MANAGED_MARK_RE.test(l)),
      entries,
      raw: (text || '').slice(0, 64 * 1024),
      rebuildTool: rebuildTool(),
    };
  },
});

// Exim's own idea of this host: the "@" entry of local_domains, so mail for
// root@<primary_hostname> is always delivered locally through /etc/aliases.
defineOp('contacts.exim.primary_hostname', {
  description: 'Report the primary_hostname Exim uses for local delivery',
  run: async () => {
    const bin = ['exim4', 'exim'].find(hasBinary) || null;
    if (!bin) return { installed: false, hostname: null };
    const { code, stdout } = await exec(bin, ['-bP', 'primary_hostname'], { allowFailure: true, timeoutMs: 15_000 });
    const m = code === 0 ? String(stdout).match(/primary_hostname\s*=\s*([A-Za-z0-9.-]+)/) : null;
    return { installed: true, hostname: m ? m[1].toLowerCase() : null };
  },
});

async function setUserAlias(user, targets, ctx) {
  ctx.assertAllowedPath(ALIASES_FILE, 'write');
  const workdir = ctx.assertAllowedPath(ALIASES_WORKDIR, 'write');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const backup = ctx.assertAllowedPath(`${workdir}/aliases.${stamp}.bak`, 'write');
  const tmp = ctx.assertAllowedPath(`${workdir}/aliases.tmp-${process.pid}`, 'write');
  fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
  const previous = readText(ALIASES_FILE);
  if (previous != null) {
    fs.writeFileSync(backup, previous, { mode: 0o600 });
    for (const stale of fs.readdirSync(workdir).filter((f) => /^aliases\.\d{8}T\d{6}Z\.bak$/.test(f)).sort().slice(0, -10)) fs.rmSync(`${workdir}/${stale}`, { force: true });
  }
  replaceFile(ALIASES_FILE, tmp, renderUserAlias(previous, user, targets));
  const tool = rebuildTool();
  let rebuild = { tool, ran: false, ok: tool === 'exim', output: '' };
  if (tool === 'newaliases') {
    const { code, stdout, stderr } = await exec('newaliases', [], { allowFailure: true, timeoutMs: 60_000 });
    rebuild = { tool, ran: true, ok: code === 0, output: `${stdout}${stderr}`.trim().slice(-2000) };
    if (code !== 0) {
      if (previous == null) fs.unlinkSync(ALIASES_FILE); else fs.writeFileSync(ALIASES_FILE, previous);
      throw new OpError('command_failed', `newaliases rejected the alias file: ${rebuild.output.split('\n').pop() || `exit ${code}`}`, { output: rebuild.output });
    }
  }
  const root = user === 'root' ? targets : parseAliases(readText(ALIASES_FILE)).filter((e) => e.name === 'root').flatMap((e) => e.targets);
  return { path: ALIASES_FILE, user, targets, root, backup: previous != null ? backup : null, rebuild };
}

defineOp('contacts.aliases.set_root', {
  description: 'Forward root mail to the given accounts/addresses in /etc/aliases and rebuild the alias database (newaliases) when the MTA needs it',
  schema: z.object({ targets: z.array(aliasTarget).max(20) }).strict(),
  destructive: true,
  run: ({ targets }, ctx) => setUserAlias('root', targets, ctx),
});

defineOp('contacts.aliases.set', {
  description: 'Forward mail for one of the managed system users (root, nobody) in /etc/aliases and rebuild the alias database when the MTA needs it',
  schema: z.object({ user: z.enum(MANAGED_USERS), targets: z.array(aliasTarget).max(20) }).strict(),
  destructive: true,
  run: ({ user, targets }, ctx) => setUserAlias(user, targets, ctx),
});
