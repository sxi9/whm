import fs from 'node:fs';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// Server Contacts: the system alias file that decides where root's mail goes
// (Edit System Mail Preferences). Only the "root:" entry is managed; every
// other alias the admin wrote is kept byte for byte.

export const ALIASES_FILE = '/etc/aliases';
const MANAGED_MARK = '# root alias managed by WHM panel (Edit System Mail Preferences)';

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

// Rewrites (or appends) the root entry and drops its continuation lines; an
// empty target list removes the entry so root's mail stays in the local mailbox.
export function renderRootAlias(text, targets) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping && /^\s/.test(line)) continue;
    skipping = false;
    if (line === MANAGED_MARK) continue;
    if (/^root\s*:/.test(line)) { skipping = true; continue; }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  if (targets.length) out.push(MANAGED_MARK, `root: ${targets.join(', ')}`);
  return `${out.join('\n')}\n`;
}

// Which tool turns the text file into what the MTA reads: Postfix/Sendmail
// need newaliases; Exim's system_aliases router reads /etc/aliases directly.
function rebuildTool() {
  if (hasBinary('newaliases')) return 'newaliases';
  if (hasBinary('exim') || hasBinary('exim4')) return 'exim';
  return null;
}

defineOp('contacts.aliases.read', {
  description: 'Read /etc/aliases: where root mail is forwarded and every other alias',
  run: async (_args, ctx) => {
    ctx.assertAllowedPath(ALIASES_FILE, 'read');
    const text = readText(ALIASES_FILE);
    const entries = parseAliases(text);
    return {
      path: ALIASES_FILE,
      exists: text != null,
      root: entries.filter((e) => e.name === 'root').flatMap((e) => e.targets),
      managed: (text || '').includes(MANAGED_MARK),
      entries,
      raw: (text || '').slice(0, 64 * 1024),
      rebuildTool: rebuildTool(),
    };
  },
});

defineOp('contacts.aliases.set_root', {
  description: 'Forward root mail to the given accounts/addresses in /etc/aliases and rebuild the alias database (newaliases) when the MTA needs it',
  schema: z.object({ targets: z.array(aliasTarget).max(20) }).strict(),
  run: async ({ targets }, ctx) => {
    ctx.assertAllowedPath(ALIASES_FILE, 'write');
    const previous = readText(ALIASES_FILE);
    if (previous != null) fs.copyFileSync(ALIASES_FILE, `${ALIASES_FILE}.whm-bak`);
    const tmp = `${ALIASES_FILE}.whm-tmp-${process.pid}`;
    fs.writeFileSync(tmp, renderRootAlias(previous, targets), { mode: 0o644 });
    fs.renameSync(tmp, ALIASES_FILE);
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
    return { path: ALIASES_FILE, root: targets, rebuild };
  },
});
