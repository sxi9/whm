import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// BIND ships in two layouts: Debian/Ubuntu (/etc/bind, named.conf.local) and
// RHEL/Fedora (/etc/named.conf, /var/named). The panel owns one include file in
// each and keeps every zone it manages inside that file, between markers, so an
// operator's hand-written zones are never touched.
// optionsConf is the file holding the single `options { }` block named allows.
const LAYOUTS = [
  { flavor: 'debian', confDir: '/etc/bind', mainConf: '/etc/bind/named.conf.local', optionsConf: '/etc/bind/named.conf.options', includeFile: '/etc/bind/named.conf.whm', zoneDir: '/etc/bind/zones', unit: 'bind9' },
  { flavor: 'rhel', confDir: '/etc', mainConf: '/etc/named.conf', optionsConf: '/etc/named.conf', includeFile: '/etc/named.whm.conf', zoneDir: '/var/named', unit: 'named' },
];
const BINARIES = ['named', 'rndc', 'named-checkzone', 'named-checkconf', 'dnssec-keygen', 'dnssec-signzone', 'dnssec-dsfromkey'];
const TMP_DIR = '/tmp/whm';

export function detectLayout() {
  const found = LAYOUTS.find((l) => fs.existsSync(l.mainConf)) || LAYOUTS.find((l) => fs.existsSync(l.zoneDir)) || null;
  const binaries = Object.fromEntries(BINARIES.map((b) => [b, hasBinary(b)]));
  return { installed: Boolean(found) && binaries.named, flavor: found?.flavor ?? null, ...(found || {}), binaries };
}

function requireLayout() {
  const layout = detectLayout();
  if (!layout.flavor) throw new OpError('capability_missing', 'BIND is not installed on this server (no /etc/bind or /etc/named.conf)');
  return layout;
}

const zoneFile = (layout, domain) => path.join(layout.zoneDir, `${domain}.db`);
const keyDir = (layout, domain) => path.join(layout.zoneDir, 'keys', domain);
const marker = (domain, end = false) => `// ${end ? 'END' : 'BEGIN'} whm zone ${domain}`;
const HEADER = '// Managed by WHM panel. Do not edit: the panel rewrites this file when zones change.\n';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function stanza(domain, file, allowTransfer = []) {
  const xfer = allowTransfer.length ? allowTransfer.map((ip) => `${ip};`).join(' ') : 'none;';
  return [marker(domain), `zone "${domain}" {`, '    type master;', `    file "${file}";`, `    allow-transfer { ${xfer} };`, '    notify yes;', '};', marker(domain, true), ''].join('\n');
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
}

// The replacement keeps the owner, group and mode of the file it replaces
// (named.conf is root:named 0640 on RHEL; zone files belong to bind/named).
function writeAtomic(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.whm-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  let existing = null;
  try { existing = fs.statSync(file); } catch { /* new file */ }
  fs.writeFileSync(tmp, content, { mode: existing ? existing.mode & 0o7777 : mode });
  if (existing) { try { fs.chownSync(tmp, existing.uid, existing.gid); } catch { /* not root: keep the writer's ownership */ } }
  fs.renameSync(tmp, file);
}

// A temp file for text the API supplied: created exclusively (no symlink can
// be followed) in a directory that must be ours and private.
function privateTempFile(dir, prefix, content) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o022) !== 0) throw new OpError('refused', `${dir} must be a directory owned by the agent and not group/world writable`);
  const file = path.join(dir, `${prefix}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); }
  return file;
}

export function stripStanza(text, domain) {
  const re = new RegExp(`${escapeRe(marker(domain))}\\n[\\s\\S]*?${escapeRe(marker(domain, true))}\\n?`, 'g');
  return text.replace(re, '');
}

// The file named actually loads: Debian's named.conf includes named.conf.local.
const rootConf = (layout) => (layout.flavor === 'debian' ? '/etc/bind/named.conf' : layout.mainConf);

export function currentStanza(text, domain) {
  const m = text.match(new RegExp(`${escapeRe(marker(domain))}\\n[\\s\\S]*?${escapeRe(marker(domain, true))}\\n?`));
  return m ? m[0] : null;
}

// Pulls `options { directory }` and every zone stanza (name, type, file) out of
// named.conf text. Blocks are matched by brace depth so stanzas inside views
// and nested lists (allow-transfer { ... }) do not confuse the scan.
export function parseNamedConf(text) {
  const src = String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*(\/\/|#).*$/gm, '');
  const zones = [];
  let directory = null;
  const re = /\b(zone|options)\b\s*(?:"([^"]*)"|'([^']*)')?\s*(?:IN|CH|HS)?\s*\{/gi;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; }
    const body = src.slice(re.lastIndex, depth ? src.length : i - 1);
    re.lastIndex = i;
    if (m[1].toLowerCase() === 'options') { directory = body.match(/\bdirectory\s+"([^"]*)"/)?.[1] ?? directory; continue; }
    if (m[2] == null && m[3] == null) continue;
    zones.push({
      domain: (m[2] ?? m[3]).toLowerCase().replace(/(.)\.$/, '$1'),
      type: body.match(/\btype\s+([a-z-]+)\s*;/i)?.[1].toLowerCase() ?? null,
      file: body.match(/\bfile\s+"([^"]*)"/)?.[1] ?? null,
    });
  }
  return { directory, zones };
}

// A relative `file` in a zone stanza is relative to options { directory }.
const DEFAULT_DIRECTORY = { debian: '/var/cache/bind', rhel: '/var/named' };
export function resolveZonePath(file, directory, layout) {
  if (!file) return null;
  if (path.isAbsolute(file)) return path.normalize(file);
  return path.join(directory || DEFAULT_DIRECTORY[layout.flavor] || layout.zoneDir, file);
}

// Every zone named loads. named-checkconf -p expands every include; when it is
// unavailable (or the config is already broken) the configuration files next
// to the main one are scanned textually, skipping the panel's own include.
export async function namedZones(layout, ctx) {
  const root = rootConf(layout);
  if (hasBinary('named-checkconf') && fs.existsSync(root)) {
    const { code, stdout } = await exec('named-checkconf', ['-p', root], { allowFailure: true, timeoutMs: 30_000 });
    if (code === 0) return { ...parseNamedConf(stdout), source: 'checkconf' };
  }
  const candidates = new Set([layout.mainConf, root]);
  for (const dir of [layout.confDir, path.join(layout.confDir, 'named'), path.join(layout.confDir, 'named.conf.d')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/^named(\..+)?\.(conf|zones|local|options)$/.test(f)) candidates.add(path.join(dir, f));
  }
  const zones = [];
  let directory = null;
  for (const f of candidates) {
    if (f === layout.includeFile || !fs.existsSync(f)) continue;
    try { ctx.assertAllowedPath(f, 'read'); } catch { continue; }
    const parsed = parseNamedConf(readText(f));
    directory ??= parsed.directory;
    zones.push(...parsed.zones);
  }
  return { directory, zones, source: 'scan' };
}

// A zone the operator declared by hand (outside the panel include) must not be
// declared again: named refuses a configuration with a duplicate zone. The
// panel then maintains the file that stanza names, which need not be the
// panel's own <zoneDir>/<domain>.db. Returns { external, type, file }.
export async function declaredElsewhere(layout, domain, ctx) {
  const conf = await namedZones(layout, ctx);
  const own = new Set([zoneFile(layout, domain), `${zoneFile(layout, domain)}.signed`]);
  let matches = conf.zones.filter((z) => z.domain === domain).map((z) => ({ ...z, file: resolveZonePath(z.file, conf.directory, layout) }));
  if (conf.source === 'checkconf' && readText(layout.includeFile).includes(marker(domain))) {
    // The expanded config contains the panel's own stanza: drop that one copy.
    const idx = matches.findIndex((z) => own.has(z.file));
    matches = matches.filter((_, i) => i !== (idx >= 0 ? idx : 0));
  }
  if (!matches.length) return { external: false, type: null, file: null };
  return { external: true, type: matches[0].type, file: matches[0].file };
}

// Where the panel reads and writes a zone's master file: its own path, unless
// an external stanza points named at another file.
async function locateZone(layout, domain, ctx) {
  const own = zoneFile(layout, domain);
  const ext = await declaredElsewhere(layout, domain, ctx);
  if (!ext.external) return { file: own, external: false, type: null };
  if (ext.type && !['master', 'primary'].includes(ext.type)) throw new OpError('zone_external', `${domain} is declared in named.conf outside the panel include as a "${ext.type}" zone; the panel can only maintain primary zones. Remove that stanza to let the panel manage the zone.`, { file: ext.file, type: ext.type });
  if (!ext.file) throw new OpError('zone_external', `${domain} is declared in named.conf outside the panel include without a file statement; remove that stanza to let the panel manage the zone.`, { file: null, type: ext.type });
  return { file: ext.file, external: true, type: ext.type };
}

// Puts (or replaces) the zone's stanza in the managed include file and makes
// sure the main configuration includes that file exactly once. Reports whether
// the stanza text changed: named only re-reads a zone's options on reconfig.
function ensureStanza(layout, domain, file, allowTransfer, ctx) {
  ctx.assertAllowedPath(layout.includeFile, 'write');
  ctx.assertAllowedPath(layout.mainConf, 'write');
  const current = readText(layout.includeFile);
  const previous = currentStanza(current, domain);
  const fresh = stanza(domain, file, allowTransfer);
  const stanzaAdded = previous == null;
  const stanzaChanged = previous != null && previous !== fresh;
  const body = stripStanza(current.replace(HEADER, ''), domain).trim();
  const next = `${HEADER}${body ? `${body}\n` : ''}${fresh}`;
  if (next !== current) writeAtomic(layout.includeFile, next);
  const mainConf = readText(layout.mainConf);
  const includeLine = `include "${layout.includeFile}";`;
  const includeAdded = !mainConf.includes(includeLine);
  if (includeAdded) writeAtomic(layout.mainConf, `${mainConf.trimEnd()}\n${includeLine}\n`.replace(/^\n+/, ''));
  return { stanzaAdded, stanzaChanged, includeAdded };
}

// Zone text comes from the API, which the agent does not trust: $INCLUDE would
// make root named-checkzone open any file and $GENERATE expands unbounded.
export const zoneBody = arg.text.refine((t) => !/^\s*\$(INCLUDE|GENERATE)\b/im.test(t), 'Zone text may not use $INCLUDE or $GENERATE');

function chownToNamed(file) {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => /^(named|bind):/.test(l));
    if (!line) return;
    const [, , uid, gid] = line.split(':');
    fs.chownSync(file, Number(uid), Number(gid));
  } catch { /* leave root-owned; BIND only reads master zones */ }
}

const allowTransferSchema = z.array(arg.ip).max(32).default([]);

defineOp('dns.layout', {
  description: 'Detect the BIND installation: flavor, config paths, zone directory and which tools exist',
  run: async () => detectLayout(),
});

defineOp('dns.zone.list', {
  description: 'Zones managed by the panel (from the include file) plus zone files present in the zone directory',
  run: async (_args, ctx) => {
    const layout = detectLayout();
    if (!layout.flavor) return { installed: false, zones: [] };
    ctx.assertAllowedPath(layout.includeFile, 'read');
    const managed = new Set([...readText(layout.includeFile).matchAll(/^\/\/ BEGIN whm zone (\S+)$/gm)].map((m) => m[1]));
    const zones = new Map();
    for (const d of managed) zones.set(d, { domain: d, path: zoneFile(layout, d), managed: true, external: false, exists: fs.existsSync(zoneFile(layout, d)) });
    // Primary zones the operator declared by hand, wherever their file lives.
    const conf = await namedZones(layout, ctx);
    for (const z of conf.zones) {
      if (zones.has(z.domain) || !['master', 'primary'].includes(z.type) || !/^[a-z0-9.-]+$/.test(z.domain)) continue;
      const file = resolveZonePath(z.file, conf.directory, layout);
      if (file) zones.set(z.domain, { domain: z.domain, path: file, managed: false, external: true, exists: fs.existsSync(file) });
    }
    if (fs.existsSync(layout.zoneDir)) {
      for (const f of fs.readdirSync(layout.zoneDir)) {
        const m = f.match(/^([a-z0-9.-]+)\.db$/);
        if (m && !zones.has(m[1])) zones.set(m[1], { domain: m[1], path: path.join(layout.zoneDir, f), managed: false, external: false, exists: true });
      }
    }
    return { installed: layout.installed, zones: [...zones.values()].sort((a, b) => a.domain.localeCompare(b.domain)) };
  },
});

defineOp('dns.zone.read', {
  description: 'Read the master file of a zone (the panel path, or the file an external named.conf stanza names)',
  schema: z.object({ domain: arg.domain }).strict(),
  run: async ({ domain }, ctx) => {
    const layout = requireLayout();
    const located = await locateZone(layout, domain, ctx);
    const file = ctx.assertAllowedPath(located.file, 'read');
    if (!fs.existsSync(file)) return { domain, path: file, external: located.external, exists: false, body: null };
    return { domain, path: file, external: located.external, exists: true, body: fs.readFileSync(file, 'utf8') };
  },
});

defineOp('dns.zone.write', {
  description: 'Write a zone file atomically, register the zone in the panel-managed named include (or write the file an external stanza names) and verify the configuration with named-checkconf, reverting on failure',
  schema: z.object({
    domain: arg.domain,
    body: zoneBody,
    allowTransfer: allowTransferSchema,
    // When the zone is DNSSEC-signed, named must load the .signed output instead.
    signed: z.boolean().default(false),
  }).strict(),
  run: async ({ domain, body, allowTransfer, signed }, ctx) => {
    const layout = requireLayout();
    ctx.assertAllowedPath(layout.includeFile, 'write');
    ctx.assertAllowedPath(layout.mainConf, 'write');
    const located = await locateZone(layout, domain, ctx);
    const { external } = located;
    let file;
    try {
      file = ctx.assertAllowedPath(located.file, 'write');
    } catch (err) {
      if (!external || err.code !== 'path_not_allowed') throw err;
      throw new OpError('zone_external', `${domain} is declared in named.conf outside the panel include with file "${located.file}", which the agent may not write. Move the zone into the panel-managed include (or point the stanza at ${zoneFile(layout, domain)}) so panel edits reach named.`, { file: located.file, type: located.type });
    }
    const previous = { include: readText(layout.includeFile), main: readText(layout.mainConf), includeExisted: fs.existsSync(layout.includeFile) };
    const existed = fs.existsSync(file);
    if (existed) fs.copyFileSync(file, `${file}.whm-bak`);
    writeAtomic(file, body.endsWith('\n') ? body : `${body}\n`);
    chownToNamed(file);
    const stanzaState = external ? { stanzaAdded: false, stanzaChanged: false, includeAdded: false } : ensureStanza(layout, domain, signed ? `${file}.signed` : file, allowTransfer, ctx);
    let checkconf = null;
    if (hasBinary('named-checkconf') && fs.existsSync(rootConf(layout))) {
      checkconf = await runCheck('named-checkconf', [rootConf(layout)]);
      if (!checkconf.ok) {
        if (previous.includeExisted) writeAtomic(layout.includeFile, previous.include); else fs.rmSync(layout.includeFile, { force: true });
        if (stanzaState.includeAdded) writeAtomic(layout.mainConf, previous.main);
        if (existed) fs.copyFileSync(`${file}.whm-bak`, file); else fs.rmSync(file, { force: true });
        throw new OpError('config_invalid', `named-checkconf rejected the configuration; the zone was not written: ${checkconf.output}`, { output: checkconf.output });
      }
    }
    return { domain, path: file, bytes: Buffer.byteLength(body), existed, external, ...stanzaState, checkconf };
  },
});

// A zone the operator declared by hand keeps being served by named whatever
// the panel deletes, so removing it is refused until that stanza is gone.
export async function removeZone(layout, domain, ctx) {
  const located = await locateZone(layout, domain, ctx);
  if (located.external) throw new OpError('zone_external', `${domain} is declared in named.conf outside the panel include (file "${located.file}"); named would keep serving it. Remove that stanza (or move it into ${layout.includeFile}) and reload named, then delete the zone again.`, { file: located.file, type: located.type });
  const file = ctx.assertAllowedPath(zoneFile(layout, domain), 'write');
  const removed = [];
  for (const f of [file, `${file}.whm-bak`, `${file}.signed`, `${file}.jnl`, `${file}.signed.jnl`]) {
    if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(f); }
  }
  const keys = ctx.assertAllowedPath(keyDir(layout, domain), 'write');
  if (fs.existsSync(keys)) { fs.rmSync(keys, { recursive: true, force: true }); removed.push(keys); }
  ctx.assertAllowedPath(layout.includeFile, 'write');
  const current = readText(layout.includeFile);
  const stanzaRemoved = current.includes(marker(domain));
  if (stanzaRemoved) writeAtomic(layout.includeFile, stripStanza(current, domain).replace(/\n{3,}/g, '\n\n'));
  return { domain, removed, stanzaRemoved, external: false };
}

defineOp('dns.zone.remove', {
  description: 'Delete a zone file (plus signed output, journal and keys) and drop its stanza from the include; refuses zones declared outside the panel include',
  destructive: true,
  schema: z.object({ domain: arg.domain }).strict(),
  run: async ({ domain }, ctx) => removeZone(requireLayout(), domain, ctx),
});

// The panel's source-address directives live in a marked block inside the one
// `options { }` statement named allows, so they never collide with a second
// options block. Returns the new file text, or the same text when unchanged.
const OPTIONS_BEGIN = '    // BEGIN whm options';
const OPTIONS_END = '    // END whm options';
export function optionsDirectives({ ipv4 = null, ipv6 = null } = {}) {
  const lines = [];
  if (ipv4) lines.push(`query-source address ${ipv4};`, `notify-source ${ipv4};`, `transfer-source ${ipv4};`);
  if (ipv6) lines.push(`query-source-v6 address ${ipv6};`, `notify-source-v6 ${ipv6};`, `transfer-source-v6 ${ipv6};`);
  return lines;
}

export function spliceOptionsBlock(text, directives) {
  const block = directives.length ? `${OPTIONS_BEGIN}\n${directives.map((d) => `    ${d}`).join('\n')}\n${OPTIONS_END}\n` : '';
  const managed = new RegExp(`[ \\t]*${escapeRe(OPTIONS_BEGIN.trim())}\\n[\\s\\S]*?[ \\t]*${escapeRe(OPTIONS_END.trim())}\\n?`);
  if (managed.test(text)) return text.replace(managed, block);
  if (!block) return text;
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length)).replace(/^[ \t]*(\/\/|#).*$/gm, (c) => ' '.repeat(c.length));
  const open = stripped.match(/\boptions\s*\{/);
  if (!open) throw new OpError('config_invalid', 'No options { } block was found in the named configuration; add one before setting source addresses');
  let depth = 1;
  let i = open.index + open[0].length;
  for (; i < stripped.length && depth; i++) { if (stripped[i] === '{') depth++; else if (stripped[i] === '}') depth--; }
  if (depth) throw new OpError('config_invalid', 'The options { } block in the named configuration is not closed');
  const close = i - 1;
  const before = text.slice(0, close).replace(/[ \t]*$/, '');
  return `${before}${before.endsWith('\n') ? '' : '\n'}${block}${text.slice(close)}`;
}

defineOp('dns.options.write', {
  description: 'Set the source addresses named uses for queries, notifies and transfers (query-source / notify-source / transfer-source) inside its options block, verified with named-checkconf and reverted on failure',
  schema: z.object({ ipv4: arg.ipv4.nullable().optional(), ipv6: arg.ipv6.nullable().optional() }).strict(),
  run: async ({ ipv4, ipv6 }, ctx) => {
    const layout = requireLayout();
    const file = ctx.assertAllowedPath(layout.optionsConf, 'write');
    if (!fs.existsSync(file)) throw new OpError('not_found', `${file} does not exist; the named options block could not be found`);
    const previous = fs.readFileSync(file, 'utf8');
    const directives = optionsDirectives({ ipv4, ipv6 });
    const next = spliceOptionsBlock(previous, directives);
    if (next === previous) return { file, changed: false, directives, checkconf: null };
    writeAtomic(file, next);
    let checkconf = null;
    if (hasBinary('named-checkconf') && fs.existsSync(rootConf(layout))) {
      checkconf = await runCheck('named-checkconf', [rootConf(layout)]);
      if (!checkconf.ok) {
        writeAtomic(file, previous);
        throw new OpError('config_invalid', `named-checkconf rejected the configuration; the source addresses were not applied: ${checkconf.output}`, { output: checkconf.output });
      }
    }
    return { file, changed: true, directives, checkconf };
  },
});

async function runCheck(bin, argv) {
  const { code, stdout, stderr } = await exec(bin, argv, { allowFailure: true, timeoutMs: 30_000 });
  return { ok: code === 0, output: `${stdout}${stderr}`.trim() };
}

defineOp('dns.checkzone', {
  description: 'Validate zone syntax with named-checkzone (given text, or the file on disk)',
  schema: z.object({ domain: arg.domain, body: zoneBody.optional() }).strict(),
  run: async ({ domain, body }, ctx) => {
    if (!hasBinary('named-checkzone')) throw new OpError('capability_missing', 'named-checkzone is not installed (bind9-utils / bind-utils)');
    let file;
    let tmp = null;
    if (body != null) {
      ctx.assertAllowedPath(TMP_DIR, 'write');
      tmp = privateTempFile(TMP_DIR, 'dns-check', body);
      file = tmp;
    } else {
      const layout = requireLayout();
      file = ctx.assertAllowedPath((await locateZone(layout, domain, ctx)).file, 'read');
      if (!fs.existsSync(file)) throw new OpError('not_found', `Zone file for ${domain} does not exist`);
    }
    try {
      const result = await runCheck('named-checkzone', ['-i', 'local', '-k', 'fail', '-n', 'fail', domain, file]);
      const serial = result.output.match(/loaded serial (\d+)/)?.[1];
      return { domain, ...result, serial: serial ? Number(serial) : null };
    } finally {
      if (tmp) fs.rmSync(tmp, { force: true });
    }
  },
});

defineOp('dns.checkconf', {
  description: 'Validate the whole named configuration with named-checkconf',
  run: async (_args, ctx) => {
    const layout = requireLayout();
    if (!hasBinary('named-checkconf')) throw new OpError('capability_missing', 'named-checkconf is not installed');
    const main = layout.flavor === 'debian' ? '/etc/bind/named.conf' : layout.mainConf;
    ctx.assertAllowedPath(main, 'read');
    return runCheck('named-checkconf', ['-z', main]).then((r) => ({ ...r, file: main }));
  },
});

defineOp('dns.reload', {
  description: 'Reload named (one zone or everything) via rndc, falling back to systemctl reload; reconfig first when a zone stanza changed',
  schema: z.object({
    domain: arg.domain.optional(),
    // `rndc reload <zone>` only re-reads zone data; a changed stanza (file,
    // allow-transfer) is picked up by `rndc reconfig` alone.
    reconfig: z.boolean().default(false),
  }).strict(),
  run: async ({ domain, reconfig }) => {
    const layout = requireLayout();
    if (hasBinary('rndc')) {
      let reconfigured = false;
      if (reconfig) {
        const r = await exec('rndc', ['reconfig'], { allowFailure: true, timeoutMs: 60_000 });
        if (r.code !== 0 && !hasBinary('systemctl')) throw new OpError('command_failed', `rndc reconfig failed: ${r.stderr.trim() || r.stdout.trim()}`);
        reconfigured = r.code === 0;
      }
      const argv = domain ? ['reload', domain] : ['reload'];
      const { code, stdout, stderr } = await exec('rndc', argv, { allowFailure: true, timeoutMs: 60_000 });
      if (code === 0) return { method: reconfigured ? 'rndc reconfig+reload' : 'rndc', domain: domain ?? null, reconfigured, output: `${stdout}${stderr}`.trim() };
      // A zone named has not loaded yet needs a full reconfig to pick up the new stanza.
      if (domain && /not found|no matching zone/i.test(stderr)) {
        const r = await exec('rndc', ['reconfig'], { allowFailure: true, timeoutMs: 60_000 });
        if (r.code === 0) return { method: 'rndc reconfig', domain, output: `${r.stdout}${r.stderr}`.trim() };
      }
      if (!hasBinary('systemctl')) throw new OpError('command_failed', `rndc reload failed: ${stderr.trim() || stdout.trim()}`);
    }
    if (!hasBinary('systemctl')) throw new OpError('capability_missing', 'Neither rndc nor systemctl is available to reload BIND');
    for (const unit of [layout.unit, 'named', 'bind9']) {
      const { code, stderr } = await exec('systemctl', ['reload-or-restart', `${unit}.service`], { allowFailure: true, timeoutMs: 120_000 });
      if (code === 0) return { method: 'systemctl', unit, domain: domain ?? null, output: stderr.trim() };
    }
    throw new OpError('command_failed', 'Could not reload BIND with rndc or systemctl');
  },
});

defineOp('dns.dnssec.keygen', {
  description: 'Generate a KSK and ZSK for a zone (dnssec-keygen) and return the DNSKEY/DS records',
  schema: z.object({
    domain: arg.domain,
    algorithm: z.enum(['ECDSAP256SHA256', 'ECDSAP384SHA384', 'RSASHA256', 'ED25519']).default('ECDSAP256SHA256'),
    bits: z.number().int().min(1024).max(4096).optional(),
  }).strict(),
  timeoutMs: 300_000,
  run: async ({ domain, algorithm, bits }, ctx) => {
    const layout = requireLayout();
    if (!hasBinary('dnssec-keygen')) throw new OpError('capability_missing', 'dnssec-keygen is not installed (bind9-utils / bind-utils)');
    const dir = ctx.assertAllowedPath(keyDir(layout, domain), 'write');
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    const keys = {};
    for (const kind of ['KSK', 'ZSK']) {
      const argv = ['-a', algorithm, '-K', dir, '-n', 'ZONE'];
      if (algorithm === 'RSASHA256') argv.push('-b', String(bits || (kind === 'KSK' ? 2048 : 1024)));
      if (kind === 'KSK') argv.push('-f', 'KSK');
      argv.push(domain);
      const { stdout } = await exec('dnssec-keygen', argv, { timeoutMs: 300_000 });
      const name = stdout.trim().split('\n').pop();
      const keyFile = path.join(dir, `${name}.key`);
      keys[kind.toLowerCase()] = { name, record: readText(keyFile).split('\n').filter((l) => l && !l.startsWith(';')).join('\n') };
    }
    let ds = [];
    if (hasBinary('dnssec-dsfromkey')) {
      const { stdout } = await exec('dnssec-dsfromkey', ['-a', 'SHA-256', path.join(dir, `${keys.ksk.name}.key`)], { allowFailure: true });
      ds = stdout.trim().split('\n').filter(Boolean);
    }
    return { domain, algorithm, keyDir: dir, ...keys, ds };
  },
});

// `-N keep`: the signed zone carries the YYYYMMDDnn serial the panel rendered
// (and tracks in its database). unixtime/increment would publish a different
// serial, so secondaries that transferred the unsigned zone could fall behind.
export const signzoneArgv = (dir, domain, file, signedPath) => ['-S', '-K', dir, '-o', domain, '-N', 'keep', '-t', '-f', signedPath, file];

defineOp('dns.dnssec.sign', {
  description: 'Sign a zone file with its keys (dnssec-signzone, keeping the serial of the unsigned file) producing <zone>.db.signed',
  schema: z.object({ domain: arg.domain }).strict(),
  timeoutMs: 300_000,
  run: async ({ domain }, ctx) => {
    const layout = requireLayout();
    if (!hasBinary('dnssec-signzone')) throw new OpError('capability_missing', 'dnssec-signzone is not installed (bind9-utils / bind-utils)');
    const file = ctx.assertAllowedPath(zoneFile(layout, domain), 'read');
    const dir = ctx.assertAllowedPath(keyDir(layout, domain), 'read');
    if (!fs.existsSync(file)) throw new OpError('not_found', `Zone file for ${domain} does not exist`);
    if (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => f.endsWith('.private'))) throw new OpError('not_found', `No DNSSEC keys for ${domain}; generate them first`);
    const signedPath = `${file}.signed`;
    const { stdout, stderr } = await exec('dnssec-signzone', signzoneArgv(dir, domain, file, signedPath), { timeoutMs: 300_000 });
    chownToNamed(signedPath);
    return { domain, signedPath, serial: signedSerial(signedPath), output: `${stdout}${stderr}`.trim().split('\n').slice(-12).join('\n') };
  },
});

function signedSerial(signedPath) {
  const m = readText(signedPath).match(/\bIN\s+SOA\s+\S+\s+\S+\s*\(?\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

const keyRecord = (file) => readText(file).split('\n').filter((l) => l && !l.startsWith(';')).join('\n');

defineOp('dns.dnssec.status', {
  description: 'Report the DNSSEC keys of a zone (DNSKEY records, DS from the KSK via dnssec-dsfromkey) and the age of its signed output',
  schema: z.object({ domain: arg.domain }).strict(),
  run: async ({ domain }, ctx) => {
    const layout = requireLayout();
    const file = ctx.assertAllowedPath(zoneFile(layout, domain), 'read');
    const dir = ctx.assertAllowedPath(keyDir(layout, domain), 'read');
    const keys = { ksk: null, zsk: null };
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((n) => /^K.+\.key$/.test(n)).sort()) {
        const record = keyRecord(path.join(dir, f));
        // Flags 257 = KSK (SEP bit), 256 = ZSK.
        keys[/\bDNSKEY\s+257\b/.test(record) ? 'ksk' : 'zsk'] = { name: f.replace(/\.key$/, ''), file: path.join(dir, f), record };
      }
    }
    let ds = [];
    if (keys.ksk && hasBinary('dnssec-dsfromkey')) {
      const { code, stdout } = await exec('dnssec-dsfromkey', ['-a', 'SHA-256', keys.ksk.file], { allowFailure: true });
      if (code === 0) ds = stdout.trim().split('\n').filter(Boolean);
    }
    const signedPath = `${file}.signed`;
    const signedStat = fs.existsSync(signedPath) ? fs.statSync(signedPath) : null;
    const zoneStat = fs.existsSync(file) ? fs.statSync(file) : null;
    const signed = signedStat
      ? { exists: true, path: signedPath, ageSeconds: Math.round((Date.now() - signedStat.mtimeMs) / 1000), stale: Boolean(zoneStat && signedStat.mtimeMs < zoneStat.mtimeMs), serial: signedSerial(signedPath) }
      : { exists: false, path: signedPath, ageSeconds: null, stale: true, serial: null };
    return { domain, keyDir: dir, hasKeys: Boolean(keys.ksk && keys.zsk), ksk: keys.ksk, zsk: keys.zsk, ds, signed };
  },
});

defineOp('dns.dnssec.remove', {
  description: 'Remove DNSSEC keys and the signed zone output for a zone',
  destructive: true,
  schema: z.object({ domain: arg.domain }).strict(),
  run: async ({ domain }, ctx) => {
    const layout = requireLayout();
    const file = ctx.assertAllowedPath(zoneFile(layout, domain), 'write');
    const dir = ctx.assertAllowedPath(keyDir(layout, domain), 'write');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${file}.signed`, { force: true });
    fs.rmSync(`${file}.signed.jnl`, { force: true });
    return { domain, removed: true };
  },
});

const RR_TYPES = ['A', 'AAAA', 'NS', 'MX', 'TXT', 'CNAME', 'SOA', 'SRV', 'CAA', 'PTR'];

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const nameserverLines = (text) => [...String(text).matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]);
const isLoopback = (ip) => /^127\./.test(ip) || ip === '::1';

// The host's own resolvers come first: real upstreams from resolv.conf, else
// the upstreams systemd-resolved learned (its stub 127.0.0.53 is all that
// /etc/resolv.conf lists on Debian/Ubuntu), else the stub itself. Public
// resolvers are only a last resort when nothing is configured.
export function chooseResolvers(resolvText, systemdUpstreamText = '') {
  const configured = nameserverLines(resolvText);
  const direct = configured.filter((ip) => !isLoopback(ip));
  if (direct.length) return direct;
  const upstream = nameserverLines(systemdUpstreamText).filter((ip) => !isLoopback(ip));
  if (upstream.length) return upstream;
  if (configured.length) return configured;
  return PUBLIC_RESOLVERS;
}

function readSystemResolvers() {
  try {
    return chooseResolvers(readText('/etc/resolv.conf'), readText('/run/systemd/resolve/resolv.conf')).slice(0, 8);
  } catch { return PUBLIC_RESOLVERS; }
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

defineOp('dns.resolve', {
  description: 'Resolve a name against explicit nameservers (node resolver; no external binary)',
  schema: z.object({
    name: arg.hostname,
    type: z.enum(RR_TYPES).default('A'),
    servers: z.array(arg.ip).max(8).optional(),
    timeoutMs: z.number().int().min(200).max(30_000).default(4000),
  }).strict(),
  run: async ({ name, type, servers, timeoutMs }) => {
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    const useServers = servers?.length ? servers : readSystemResolvers();
    resolver.setServers(useServers);
    try {
      const raw = await withTimeout(resolver.resolve(name, type), timeoutMs + 500);
      const answers = (Array.isArray(raw) ? raw : [raw]).map((a) => {
        if (typeof a === 'string') return a;
        if (Array.isArray(a)) return a.join('');
        return a;
      });
      return { name, type, servers: useServers, answers, error: null };
    } catch (err) {
      return { name, type, servers: useServers, answers: [], error: err.code || 'EFAIL' };
    }
  },
});
