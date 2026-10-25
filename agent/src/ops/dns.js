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
const LAYOUTS = [
  { flavor: 'debian', confDir: '/etc/bind', mainConf: '/etc/bind/named.conf.local', includeFile: '/etc/bind/named.conf.whm', zoneDir: '/etc/bind/zones', unit: 'bind9' },
  { flavor: 'rhel', confDir: '/etc', mainConf: '/etc/named.conf', includeFile: '/etc/named.whm.conf', zoneDir: '/var/named', unit: 'named' },
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

function writeAtomic(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.whm-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

export function stripStanza(text, domain) {
  const re = new RegExp(`${escapeRe(marker(domain))}\\n[\\s\\S]*?${escapeRe(marker(domain, true))}\\n?`, 'g');
  return text.replace(re, '');
}

// Puts (or replaces) the zone's stanza in the managed include file and makes
// sure the main configuration includes that file exactly once.
function ensureStanza(layout, domain, file, allowTransfer, ctx) {
  ctx.assertAllowedPath(layout.includeFile, 'write');
  ctx.assertAllowedPath(layout.mainConf, 'write');
  const current = readText(layout.includeFile);
  const stanzaAdded = !current.includes(marker(domain));
  const body = stripStanza(current.replace(HEADER, ''), domain).trim();
  const next = `${HEADER}${body ? `${body}\n` : ''}${stanza(domain, file, allowTransfer)}`;
  if (next !== current) writeAtomic(layout.includeFile, next);
  const mainConf = readText(layout.mainConf);
  const includeLine = `include "${layout.includeFile}";`;
  const includeAdded = !mainConf.includes(includeLine);
  if (includeAdded) writeAtomic(layout.mainConf, `${mainConf.trimEnd()}\n${includeLine}\n`.replace(/^\n+/, ''));
  return { stanzaAdded, includeAdded };
}

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
    for (const d of managed) zones.set(d, { domain: d, path: zoneFile(layout, d), managed: true, exists: fs.existsSync(zoneFile(layout, d)) });
    if (fs.existsSync(layout.zoneDir)) {
      for (const f of fs.readdirSync(layout.zoneDir)) {
        const m = f.match(/^([a-z0-9.-]+)\.db$/);
        if (m && !zones.has(m[1])) zones.set(m[1], { domain: m[1], path: path.join(layout.zoneDir, f), managed: false, exists: true });
      }
    }
    return { installed: layout.installed, zones: [...zones.values()].sort((a, b) => a.domain.localeCompare(b.domain)) };
  },
});

defineOp('dns.zone.read', {
  description: 'Read a zone file from the zone directory',
  schema: z.object({ domain: arg.domain }).strict(),
  run: async ({ domain }, ctx) => {
    const layout = requireLayout();
    const file = ctx.assertAllowedPath(zoneFile(layout, domain), 'read');
    if (!fs.existsSync(file)) return { domain, path: file, exists: false, body: null };
    return { domain, path: file, exists: true, body: fs.readFileSync(file, 'utf8') };
  },
});

defineOp('dns.zone.write', {
  description: 'Write a zone file atomically and register the zone in the panel-managed named include',
  schema: z.object({
    domain: arg.domain,
    body: arg.text,
    allowTransfer: allowTransferSchema,
    // When the zone is DNSSEC-signed, named must load the .signed output instead.
    signed: z.boolean().default(false),
  }).strict(),
  run: async ({ domain, body, allowTransfer, signed }, ctx) => {
    const layout = requireLayout();
    const file = ctx.assertAllowedPath(zoneFile(layout, domain), 'write');
    const existed = fs.existsSync(file);
    if (existed) fs.copyFileSync(file, `${file}.whm-bak`);
    writeAtomic(file, body.endsWith('\n') ? body : `${body}\n`);
    chownToNamed(file);
    const { stanzaAdded, includeAdded } = ensureStanza(layout, domain, signed ? `${file}.signed` : file, allowTransfer, ctx);
    return { domain, path: file, bytes: Buffer.byteLength(body), existed, stanzaAdded, includeAdded };
  },
});

defineOp('dns.zone.remove', {
  description: 'Delete a zone file (plus signed output, journal and keys) and drop its stanza from the include',
  destructive: true,
  schema: z.object({ domain: arg.domain }).strict(),
  run: async ({ domain }, ctx) => {
    const layout = requireLayout();
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
    return { domain, removed, stanzaRemoved };
  },
});

async function runCheck(bin, argv) {
  const { code, stdout, stderr } = await exec(bin, argv, { allowFailure: true, timeoutMs: 30_000 });
  return { ok: code === 0, output: `${stdout}${stderr}`.trim() };
}

defineOp('dns.checkzone', {
  description: 'Validate zone syntax with named-checkzone (given text, or the file on disk)',
  schema: z.object({ domain: arg.domain, body: arg.text.optional() }).strict(),
  run: async ({ domain, body }, ctx) => {
    if (!hasBinary('named-checkzone')) throw new OpError('capability_missing', 'named-checkzone is not installed (bind9-utils / bind-utils)');
    let file;
    let tmp = null;
    if (body != null) {
      tmp = ctx.assertAllowedPath(path.join(TMP_DIR, `dns-check-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`), 'write');
      fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      file = tmp;
    } else {
      file = ctx.assertAllowedPath(zoneFile(requireLayout(), domain), 'read');
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
  description: 'Reload named (one zone or everything) via rndc, falling back to systemctl reload',
  schema: z.object({ domain: arg.domain.optional() }).strict(),
  run: async ({ domain }) => {
    const layout = requireLayout();
    if (hasBinary('rndc')) {
      const argv = domain ? ['reload', domain] : ['reload'];
      const { code, stdout, stderr } = await exec('rndc', argv, { allowFailure: true, timeoutMs: 60_000 });
      if (code === 0) return { method: 'rndc', domain: domain ?? null, output: `${stdout}${stderr}`.trim() };
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

defineOp('dns.dnssec.sign', {
  description: 'Sign a zone file with its keys (dnssec-signzone) producing <zone>.db.signed',
  schema: z.object({ domain: arg.domain }).strict(),
  timeoutMs: 300_000,
  run: async ({ domain }, ctx) => {
    const layout = requireLayout();
    if (!hasBinary('dnssec-signzone')) throw new OpError('capability_missing', 'dnssec-signzone is not installed (bind9-utils / bind-utils)');
    const file = ctx.assertAllowedPath(zoneFile(layout, domain), 'read');
    const dir = ctx.assertAllowedPath(keyDir(layout, domain), 'read');
    if (!fs.existsSync(file)) throw new OpError('not_found', `Zone file for ${domain} does not exist`);
    if (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => f.endsWith('.private'))) throw new OpError('not_found', `No DNSSEC keys for ${domain}; generate them first`);
    const { stdout, stderr } = await exec('dnssec-signzone', ['-S', '-K', dir, '-o', domain, '-N', 'unixtime', '-t', '-f', `${file}.signed`, file], { timeoutMs: 300_000 });
    chownToNamed(`${file}.signed`);
    return { domain, signedPath: `${file}.signed`, output: `${stdout}${stderr}`.trim().split('\n').slice(-12).join('\n') };
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

function readSystemResolvers() {
  try {
    const out = [...fs.readFileSync('/etc/resolv.conf', 'utf8').matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]).filter((ip) => !/^127\./.test(ip) && ip !== '::1');
    return out.length ? out : ['1.1.1.1', '8.8.8.8'];
  } catch { return ['1.1.1.1', '8.8.8.8']; }
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
