import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError, runOp } from './registry.js';

// Mail op family: Exim queue control, mainlog analytics, routing tests, panel
// notifications, managed ACL/config includes (validated with exim -bV and rolled
// back when Exim rejects them), SpamAssassin daemon options, DKIM key install,
// and mailbox maintenance (permissions, doveadm conversion).

const MANAGED = '# Managed by WHM panel';

// ---------------------------------------------------------------- helpers ---

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function writeAtomic(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exists(file)) fs.copyFileSync(file, `${file}.whm-bak`);
  const tmp = `${file}.whm-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function restore(file, previous) {
  if (previous == null) { try { fs.unlinkSync(file); } catch { /* already gone */ } } else fs.writeFileSync(file, previous);
}

function passwdEntry(name) {
  const line = (readText('/etc/passwd') || '').split('\n').find((l) => l.startsWith(`${name}:`));
  return line ? { name, uid: Number(line.split(':')[2]), gid: Number(line.split(':')[3]), home: line.split(':')[5] } : null;
}

function groupEntry(name) {
  const line = (readText('/etc/group') || '').split('\n').find((l) => l.startsWith(`${name}:`));
  return line ? { name, gid: Number(line.split(':')[2]) } : null;
}

async function reloadUnit(candidates, verb = 'reload-or-restart') {
  if (!hasBinary('systemctl')) return { reloaded: false, unit: null };
  for (const unit of candidates) {
    const { code } = await exec('systemctl', [verb, `${unit}.service`], { allowFailure: true, timeoutMs: 120_000 });
    if (code === 0) return { reloaded: true, unit };
  }
  return { reloaded: false, unit: null };
}

// Debian's update-exim4.conf.conf is a sourced shell fragment of KEY='value'
// lines; dc_use_split_config decides whether conf.d/ is read at all.
export function parseUpdateExim4Conf(text) {
  const out = {};
  for (const raw of (text || '').split('\n')) {
    const m = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function versionAtLeast(version, [major, minor]) {
  const m = String(version || '').match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor);
}

// Where Exim lives on this host. Debian ships split config under /etc/exim4 and
// the exim4 binary; RHEL/cPanel-style hosts use /etc/exim(.conf) and exim.
export function eximLayout() {
  const bin = ['exim4', 'exim'].find(hasBinary) || null;
  let flavor = null;
  if (exists('/etc/exim4')) flavor = 'debian';
  else if (exists('/etc/exim') || exists('/etc/exim.conf')) flavor = 'rhel';
  const confDir = flavor === 'debian' ? '/etc/exim4' : flavor === 'rhel' ? '/etc/exim' : null;
  const mainlog = ['/var/log/exim4/mainlog', '/var/log/exim_mainlog', '/var/log/exim/main.log', '/var/log/exim/mainlog'].find(exists) || (flavor === 'debian' ? '/var/log/exim4/mainlog' : '/var/log/exim/main.log');
  const rejectlog = ['/var/log/exim4/rejectlog', '/var/log/exim_rejectlog', '/var/log/exim/reject.log'].find(exists) || null;
  const spoolDir = ['/var/spool/exim4', '/var/spool/exim'].find(exists) || null;
  const runUser = ['Debian-exim', 'exim', 'mail', 'mailnull'].map(passwdEntry).find(Boolean) || null;
  const whmDir = confDir ? `${confDir}/whm` : null;
  const debianConf = flavor === 'debian' ? parseUpdateExim4Conf(readText('/etc/exim4/update-exim4.conf.conf')) : {};
  // dc_other_hostnames / dc_relay_domains would be shadowed by our macros, so
  // they are merged into them (items are ';' or ':' separated).
  const debianList = (value) => String(value || '').split(/[;:]/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9.*@_+-]+$/.test(s));
  return {
    installed: Boolean(bin), bin, flavor, confDir, mainlog, rejectlog, spoolDir, whmDir,
    aclFile: whmDir ? `${whmDir}/acl_rcpt.conf` : null,
    // Debian pulls a file into acl_check_rcpt through the CHECK_RCPT_LOCAL_ACL_FILE
    // macro. update-exim4.conf prepends exim4.conf.localmacros to the generated
    // config in both split and unsplit mode, so the macro lives there; conf.d/ is
    // only read when dc_use_split_config='true'. Other layouts need a manual .include.
    includeMode: flavor === 'debian' ? 'debian-macro' : flavor === 'rhel' ? 'manual' : null,
    macroFile: flavor === 'debian' ? '/etc/exim4/exim4.conf.localmacros' : null,
    legacyMacroFile: flavor === 'debian' ? '/etc/exim4/conf.d/main/000_whm_macros' : null,
    // Main-section options (sqlite_dbfile) for layouts without a macro hook.
    mainFile: flavor === 'rhel' && whmDir ? `${whmDir}/main.conf` : null,
    splitConfig: flavor === 'debian' ? debianConf.dc_use_split_config === 'true' : false,
    updateConf: hasBinary('update-exim4.conf'),
    runUser: runUser?.name || null,
    units: flavor === 'debian' ? ['exim4', 'exim'] : ['exim', 'exim4'],
    dkimDir: whmDir ? `${whmDir}/dkim` : null,
    localDomainsFile: whmDir ? `${whmDir}/local_domains.lst` : null,
    relayDomainsFile: whmDir ? `${whmDir}/relay_domains.lst` : null,
    otherHostnames: debianList(debianConf.dc_other_hostnames),
    debianRelayDomains: debianList(debianConf.dc_relay_domains),
  };
}

function requireExim() {
  const layout = eximLayout();
  if (!layout.installed) throw new OpError('capability_missing', 'Exim is not installed on this server (no exim/exim4 binary found)');
  return layout;
}

export function spamdLayout() {
  const file = ['/etc/default/spamd', '/etc/default/spamassassin', '/etc/sysconfig/spamassassin'].find(exists) || null;
  const bin = ['spamd', 'spamassassin'].find(hasBinary) || null;
  return { installed: Boolean(bin), bin, configFile: file || (exists('/etc/sysconfig') ? '/etc/sysconfig/spamassassin' : '/etc/default/spamassassin'), units: ['spamd', 'spamassassin'], localCf: ['/etc/spamassassin/local.cf', '/etc/mail/spamassassin/local.cf'].find(exists) || null };
}

const messageId = z.string().regex(/^[A-Za-z0-9]{6}-[A-Za-z0-9]{6,11}-[A-Za-z0-9]{2,4}$/, 'Exim message id');
const messageIds = z.array(messageId).min(1).max(500);
// Addresses end up in Exim's argv: a local part may not start with "-" even
// behind "--", so an option-shaped value is never handed to the binary.
const emailAddress = z.string().max(254).regex(/^[A-Za-z0-9_][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/, 'Email address');
const includeName = z.string().regex(/^[a-z][a-z0-9_-]{0,47}(\.(conf|txt|lst))$/, 'lowercase name with .conf/.txt/.lst extension');
const dkimSelector = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i);
const singleLine = (max) => z.string().max(max).regex(/^[^\n\r\0]*$/, 'Single line');
// Paths rendered verbatim into files that root daemons parse (Exim's main
// section, spamd's EnvironmentFile): plain path characters only, no dot-only
// segments, so a value can never close a quote or start a new line/option.
const pathSegments = '(?:\\/(?!\\.{1,2}(?:\\/|$))[A-Za-z0-9._-]+)+';
const configPath = z.string().max(255).regex(new RegExp(`^${pathSegments}\\/?$`), 'Absolute path made of letters, digits, ".", "_" and "-"');
const greylistDbPath = z.string().max(255).regex(new RegExp(`^\\/var\\/lib\\/whm${pathSegments}$`), 'Must live under /var/lib/whm/');

// --------------------------------------------------------------- detection ---

async function eximVersion(layout) {
  const { code, stdout } = await exec(layout.bin, ['-bV'], { allowFailure: true, timeoutMs: 30_000 });
  const version = stdout.match(/Exim version (\S+)/)?.[1] || null;
  const lookups = (stdout.match(/^Lookups[^:]*:\s*(.+)$/m)?.[1] || '').split(/\s+/).filter(Boolean);
  const configFile = stdout.match(/Configuration file is (\S+)/)?.[1] || stdout.match(/Configuration file search path is (\S+)/)?.[1] || null;
  return { ok: code === 0, version, lookups, configFile, output: stdout.trim().split('\n').slice(0, 40).join('\n') };
}

defineOp('mail.detect', {
  description: 'Exim/Dovecot/SpamAssassin layout on this host: binaries, config dirs, logs, include mode, lookup support',
  run: async () => {
    const layout = eximLayout();
    const version = layout.installed ? await eximVersion(layout) : { ok: false, version: null, lookups: [], configFile: null };
    let spamdInfo = null;
    const spamd = spamdLayout();
    if (spamd.installed) spamdInfo = { bin: spamd.bin, configFile: spamd.configFile, configExists: exists(spamd.configFile), localCf: spamd.localCf };
    return {
      ...layout,
      version: version.version, configFile: version.configFile, lookups: version.lookups, configOk: version.ok,
      sqliteLookup: version.lookups.some((l) => /sqlite/i.test(l)),
      greylistd: hasBinary('greylistd') && exists('/var/run/greylistd/socket') ? 'running' : hasBinary('greylistd') ? 'installed' : null,
      sqlite3: hasBinary('sqlite3'),
      dovecot: { installed: hasBinary('dovecot'), doveadm: hasBinary('doveadm') },
      spamd: { installed: spamd.installed, ...(spamdInfo || {}) },
      mainlogExists: exists(layout.mainlog),
    };
  },
});

// ------------------------------------------------------------------- queue ---

// `exim -bp` prints one block per message: an age/size/id/sender line (with a
// "*** frozen ***" marker) followed by indented recipient lines; delivered
// recipients are prefixed with "D".
export function parseEximQueue(stdout) {
  const messages = [];
  let current = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) { if (current) { messages.push(current); current = null; } continue; }
    const head = line.match(/^\s*(\S+)\s+(\S+)\s+([A-Za-z0-9]{6}-[A-Za-z0-9]{6,11}-[A-Za-z0-9]{2,4})\s+<([^>]*)>(.*)$/);
    if (head) {
      if (current) messages.push(current);
      const [, age, size, id, sender, rest] = head;
      current = { id, age, ageSeconds: ageToSeconds(age), size, sizeBytes: sizeToBytes(size), sender: sender || '<>', frozen: /\*\*\* frozen \*\*\*/.test(rest), recipients: [] };
      continue;
    }
    if (current) {
      const rcpt = line.trim().match(/^(D)?\s*(\S+@\S+|\S+)$/);
      if (rcpt) current.recipients.push({ address: rcpt[2], delivered: rcpt[1] === 'D' });
    }
  }
  if (current) messages.push(current);
  return messages;
}

export function ageToSeconds(age) {
  const m = String(age).match(/^(\d+)([smhdw])$/);
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2]];
}

export function sizeToBytes(size) {
  const m = String(size).match(/^([\d.]+)([KMG]?)$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2]]);
}

defineOp('mail.queue.list', {
  description: 'Messages waiting in the Exim queue (exim -bp) as structured rows',
  schema: z.object({ limit: z.number().int().min(1).max(50_000).default(5000) }).strict(),
  run: async ({ limit }) => {
    const layout = requireExim();
    const { stdout } = await exec(layout.bin, ['-bp'], { timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024 });
    const all = parseEximQueue(stdout);
    return { total: all.length, frozen: all.filter((m) => m.frozen).length, messages: all.slice(0, limit), truncated: all.length > limit };
  },
});

defineOp('mail.queue.message', {
  description: 'Headers, body excerpt and delivery log of one queued message (exim -Mvh/-Mvb/-Mvl)',
  schema: z.object({ id: messageId, bodyBytes: z.number().int().min(0).max(1024 * 1024).default(64 * 1024) }).strict(),
  run: async ({ id, bodyBytes }) => {
    const layout = requireExim();
    const headers = await exec(layout.bin, ['-Mvh', id], { allowFailure: true, timeoutMs: 30_000 });
    if (headers.code !== 0) throw new OpError('not_found', `Message ${id} is not in the queue`);
    const body = bodyBytes > 0 ? await exec(layout.bin, ['-Mvb', id], { allowFailure: true, timeoutMs: 30_000, maxBuffer: 32 * 1024 * 1024 }) : { stdout: '' };
    const log = await exec(layout.bin, ['-Mvl', id], { allowFailure: true, timeoutMs: 30_000 });
    const parsed = {};
    for (const line of headers.stdout.split('\n')) {
      const m = line.match(/^\d+[A-Z*]?\s+([A-Za-z-]+):\s*(.*)$/);
      if (m) parsed[m[1].toLowerCase()] = m[2];
    }
    return { id, headers: headers.stdout, parsedHeaders: parsed, subject: parsed.subject || null, from: parsed.from || null, to: parsed.to || null, body: body.stdout.slice(0, bodyBytes), bodyTruncated: body.stdout.length > bodyBytes, log: log.stdout };
  },
});

async function queueAction(flag, ids, { destructive = false } = {}) {
  const layout = requireExim();
  const { code, stdout, stderr } = await exec(layout.bin, [flag, ...ids], { allowFailure: true, timeoutMs: 600_000 });
  const output = `${stdout}${stderr}`.trim();
  const perId = ids.map((id) => {
    const line = output.split('\n').find((l) => l.includes(id));
    const failed = line ? /not found|failed|error|has not been/i.test(line) : code !== 0 && ids.length === 1;
    return { id, ok: !failed, detail: line || null };
  });
  return { flag, ids, ok: perId.every((r) => r.ok), results: perId, output, destructive };
}

defineOp('mail.queue.remove', { description: 'Delete messages from the queue (exim -Mrm)', destructive: true, schema: z.object({ ids: messageIds }).strict(), run: ({ ids }) => queueAction('-Mrm', ids, { destructive: true }) });
defineOp('mail.queue.deliver', { description: 'Force a delivery attempt now (exim -M)', schema: z.object({ ids: messageIds }).strict(), run: ({ ids }) => queueAction('-M', ids) });
defineOp('mail.queue.freeze', { description: 'Freeze messages so they are not retried (exim -Mf)', schema: z.object({ ids: messageIds }).strict(), run: ({ ids }) => queueAction('-Mf', ids) });
defineOp('mail.queue.thaw', { description: 'Thaw frozen messages (exim -Mt)', schema: z.object({ ids: messageIds }).strict(), run: ({ ids }) => queueAction('-Mt', ids) });

defineOp('mail.queue.flush', {
  description: 'Run the queue now (exim -qf; -qff also retries frozen messages)',
  schema: z.object({ force: z.boolean().default(false) }).strict(),
  run: async ({ force }) => {
    const layout = requireExim();
    const { code, stdout, stderr } = await exec(layout.bin, [force ? '-qff' : '-qf', '-v'], { allowFailure: true, timeoutMs: 900_000, maxBuffer: 64 * 1024 * 1024 });
    const output = `${stdout}${stderr}`;
    return { force, ok: code === 0, delivered: (output.match(/ => /g) || []).length, deferred: (output.match(/ == /g) || []).length, failed: (output.match(/ \*\* /g) || []).length, output: output.slice(-20_000) };
  },
});

// ----------------------------------------------------------------- mainlog ---

// One mainlog line → { ts, id, event, address, fields, text }. Events: '<=' arrival,
// '=>' delivery, '->' additional recipient, '**' failure, '==' deferral,
// 'Completed', 'rejected' and everything else as 'other'.
export function parseMainlogLine(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?(?: [+-]\d{4})?) (?:\[\d+\] )?(?:([A-Za-z0-9]{6}-[A-Za-z0-9]{6,11}-[A-Za-z0-9]{2,4}) )?(.*)$/);
  if (!m) return null;
  const [, ts, id, rest] = m;
  const ev = rest.match(/^(<=|=>|->|\*\*|==|Completed)(?:\s+(.*))?$/s);
  const fields = {};
  let address = null;
  let text = rest;
  let event = 'other';
  if (ev) {
    event = ev[1];
    text = ev[2] || '';
    if (event !== 'Completed') {
      const first = text.match(/^(\S+)\s*(.*)$/s);
      if (first) { address = first[1]; text = first[2]; }
      if (address === '<>' || address === ':blackhole:') address = address === '<>' ? '<>' : ':blackhole:';
    }
  } else if (/ rejected (RCPT|connection|EHLO|HELO|after|MAIL)/.test(rest) || /SMTP connection from .* lost/.test(rest)) {
    event = 'rejected';
  }
  // key=value tokens; values may be quoted with escaped quotes or bracketed hosts.
  const tokenRe = /(?:^|\s)([A-Z][A-Za-z]{0,2})=("(?:[^"\\]|\\.)*"|\S+(?:\s+\[[^\]]*\](?::\d+)?)?)/g;
  let t;
  while ((t = tokenRe.exec(text)) !== null) {
    let value = t[2];
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    else value = value.replace(/:$/, '');
    fields[t[1]] = value;
  }
  if (address && /^</.test(address) && address !== '<>') address = address.replace(/^<|>$/g, '');
  return { ts, id: id || null, event, address, fields, text: text.trim(), raw: line };
}

// Groups parsed lines per message id so a report shows each recipient's outcome.
export function aggregateMainlog(lines, { sinceMs = 0 } = {}) {
  const messages = new Map();
  const rejects = [];
  for (const raw of lines) {
    if (!raw) continue;
    const e = parseMainlogLine(raw);
    if (!e) continue;
    const when = Date.parse(e.ts.replace(' ', 'T').replace(/ ([+-]\d{4})$/, '$1'));
    if (sinceMs && when && when < sinceMs) continue;
    if (e.event === 'rejected') { rejects.push({ ts: e.ts, host: e.fields.H || null, sender: e.fields.F || null, text: e.text.slice(0, 300) }); continue; }
    if (!e.id) continue;
    let msg = messages.get(e.id);
    if (!msg) { msg = { id: e.id, arrivedAt: null, completedAt: null, sender: null, host: null, auth: null, authUser: null, protocol: null, size: null, subject: null, recipients: [] }; messages.set(e.id, msg); }
    if (e.event === '<=') {
      msg.arrivedAt = e.ts; msg.sender = e.address; msg.host = e.fields.H || null; msg.protocol = e.fields.P || null;
      msg.size = Number(e.fields.S) || null; msg.subject = e.fields.T || null;
      if (e.fields.A) { msg.auth = e.fields.A; msg.authUser = e.fields.A.split(':').slice(1).join(':') || e.fields.A; }
      if (!msg.authUser && e.fields.U) msg.authUser = `local:${e.fields.U}`;
    } else if (e.event === '=>' || e.event === '->') {
      msg.recipients.push({ address: e.address, status: 'delivered', at: e.ts, router: e.fields.R || null, transport: e.fields.T || null, host: e.fields.H || null, detail: e.fields.C || null });
    } else if (e.event === '**') {
      msg.recipients.push({ address: e.address, status: 'failed', at: e.ts, router: e.fields.R || null, transport: e.fields.T || null, host: e.fields.H || null, detail: e.text.replace(/^.*?:\s*/, '').slice(0, 500) || null });
    } else if (e.event === '==') {
      msg.recipients.push({ address: e.address, status: 'deferred', at: e.ts, router: e.fields.R || null, transport: e.fields.T || null, host: e.fields.H || null, detail: e.text.replace(/^.*?defer/, 'defer').slice(0, 500) || null });
    } else if (e.event === 'Completed') {
      msg.completedAt = e.ts;
    }
  }
  return { messages: [...messages.values()], rejects };
}

export function summarizeMail(messages, rejects) {
  const totals = { messages: messages.length, received: 0, delivered: 0, failed: 0, deferred: 0, rejected: rejects.length, bytes: 0, authenticated: 0 };
  const senders = new Map();
  const relayers = new Map();
  const byHour = new Map();
  const domains = new Map();
  const hosts = new Map();
  for (const m of messages) {
    if (m.arrivedAt) { totals.received++; totals.bytes += m.size || 0; }
    if (m.authUser) totals.authenticated++;
    const hour = m.arrivedAt ? m.arrivedAt.slice(0, 13) : null;
    if (hour) { const h = byHour.get(hour) || { hour, received: 0, delivered: 0, failed: 0, deferred: 0 }; h.received++; byHour.set(hour, h); }
    const key = m.authUser || m.sender || '<>';
    const s = senders.get(key) || { sender: key, authenticated: Boolean(m.authUser), messages: 0, delivered: 0, failed: 0, deferred: 0, bytes: 0, recipients: 0, firstSeen: m.arrivedAt, lastSeen: m.arrivedAt, hosts: new Set() };
    s.messages++; s.bytes += m.size || 0; s.recipients += m.recipients.length;
    if (m.arrivedAt) { if (!s.firstSeen || m.arrivedAt < s.firstSeen) s.firstSeen = m.arrivedAt; if (!s.lastSeen || m.arrivedAt > s.lastSeen) s.lastSeen = m.arrivedAt; }
    if (m.host) s.hosts.add(m.host);
    if (m.host) hosts.set(m.host, (hosts.get(m.host) || 0) + 1);
    for (const r of m.recipients) {
      totals[r.status]++;
      s[r.status]++;
      if (hour) byHour.get(hour)[r.status]++;
      const dom = (r.address || '').split('@')[1]?.toLowerCase();
      if (dom) { const d = domains.get(dom) || { domain: dom, delivered: 0, failed: 0, deferred: 0 }; d[r.status]++; domains.set(dom, d); }
    }
    senders.set(key, s);
    if (m.authUser) {
      const r = relayers.get(m.authUser) || { user: m.authUser, mechanism: (m.auth || '').split(':')[0] || null, messages: 0, recipients: 0, bytes: 0, delivered: 0, failed: 0, deferred: 0, firstSeen: m.arrivedAt, lastSeen: m.arrivedAt, hosts: new Set(), senders: new Set() };
      r.messages++; r.recipients += m.recipients.length; r.bytes += m.size || 0;
      for (const x of m.recipients) r[x.status]++;
      if (m.arrivedAt) { if (!r.firstSeen || m.arrivedAt < r.firstSeen) r.firstSeen = m.arrivedAt; if (!r.lastSeen || m.arrivedAt > r.lastSeen) r.lastSeen = m.arrivedAt; }
      if (m.host) r.hosts.add(m.host);
      if (m.sender) r.senders.add(m.sender);
      relayers.set(m.authUser, r);
    }
  }
  const shape = (x) => ({ ...x, hosts: [...x.hosts].slice(0, 20), ...(x.senders ? { senders: [...x.senders].slice(0, 20) } : {}) });
  return {
    totals,
    senders: [...senders.values()].map(shape).sort((a, b) => b.messages - a.messages),
    relayers: [...relayers.values()].map(shape).sort((a, b) => b.messages - a.messages),
    byHour: [...byHour.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
    topDomains: [...domains.values()].sort((a, b) => (b.delivered + b.failed + b.deferred) - (a.delivered + a.failed + a.deferred)).slice(0, 25),
    topHosts: [...hosts.entries()].map(([host, messages]) => ({ host, messages })).sort((a, b) => b.messages - a.messages).slice(0, 25),
  };
}

function readMainlogTail(layout, maxBytes) {
  const file = layout.mainlog;
  if (!exists(file)) return { file, exists: false, lines: [], truncated: false, size: 0 };
  const size = fs.statSync(file).size;
  const length = Math.min(size, maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    if (size > length) lines.shift();
    return { file, exists: true, lines, truncated: size > length, size };
  } finally { fs.closeSync(fd); }
}

const logWindow = z.object({ sinceHours: z.number().min(0).max(24 * 366).default(24), maxBytes: z.number().int().min(1024).max(256 * 1024 * 1024).default(32 * 1024 * 1024) });

defineOp('mail.log.report', {
  description: 'Per-message delivery outcomes from the Exim mainlog, filtered by sender/recipient/window',
  schema: logWindow.extend({ sender: z.string().max(254).optional(), recipient: z.string().max(254).optional(), limit: z.number().int().min(1).max(20_000).default(2000) }).strict(),
  run: async ({ sinceHours, maxBytes, sender, recipient, limit }, ctx) => {
    const layout = requireExim();
    ctx.assertAllowedPath(layout.mainlog, 'read');
    const tail = readMainlogTail(layout, maxBytes);
    const sinceMs = sinceHours ? Date.now() - sinceHours * 3600_000 : 0;
    const { messages, rejects } = aggregateMainlog(tail.lines, { sinceMs });
    const s = sender?.toLowerCase(); const r = recipient?.toLowerCase();
    let list = messages.filter((m) => (!s || (m.sender || '').toLowerCase().includes(s) || (m.authUser || '').toLowerCase().includes(s)) && (!r || m.recipients.some((x) => (x.address || '').toLowerCase().includes(r))));
    list.sort((a, b) => (b.arrivedAt || '').localeCompare(a.arrivedAt || ''));
    const total = list.length;
    list = list.slice(0, limit);
    return { file: tail.file, logExists: tail.exists, logTruncated: tail.truncated, logBytes: tail.size, sinceHours, total, messages: list, rejects: rejects.slice(-200) };
  },
});

defineOp('mail.log.stats', {
  description: 'Aggregated mail statistics (totals, senders, authenticated relayers, hourly volume, top domains) from the mainlog',
  schema: logWindow.strict(),
  run: async ({ sinceHours, maxBytes }, ctx) => {
    const layout = requireExim();
    ctx.assertAllowedPath(layout.mainlog, 'read');
    const tail = readMainlogTail(layout, maxBytes);
    const sinceMs = sinceHours ? Date.now() - sinceHours * 3600_000 : 0;
    const { messages, rejects } = aggregateMainlog(tail.lines, { sinceMs });
    return { file: tail.file, logExists: tail.exists, logTruncated: tail.truncated, logBytes: tail.size, sinceHours, ...summarizeMail(messages, rejects) };
  },
});

// ------------------------------------------------------- routing / sending ---

export function parseAddressTest(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean);
  const routes = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\S+)\s*(?:->\s*(\S+))?\s*$/);
    const r = line.match(/router = (\S+), transport = (\S+)/);
    if (r) { if (routes.length) Object.assign(routes[routes.length - 1], { router: r[1], transport: r[2] }); else routes.push({ address: null, router: r[1], transport: r[2] }); } else if (m && !/^\s/.test(line)) routes.push({ address: m[1], target: m[2] || null, router: null, transport: null });
    else if (/is undeliverable|cannot be resolved|Unrouteable|unrouteable|failed to verify/i.test(line)) routes.push({ address: null, error: line.trim() });
  }
  return routes;
}

defineOp('mail.test_delivery', {
  description: 'Show how Exim would route an address (exim -bt) and verify it (exim -bv)',
  schema: z.object({ address: emailAddress }).strict(),
  run: async ({ address }) => {
    const layout = requireExim();
    // "--" ends option parsing so the address can never be read as an option.
    const route = await exec(layout.bin, ['-bt', '--', address], { allowFailure: true, timeoutMs: 60_000 });
    const verify = await exec(layout.bin, ['-bv', '--', address], { allowFailure: true, timeoutMs: 60_000 });
    const output = `${route.stdout}${route.stderr}`.trim();
    return { address, routable: route.code === 0, routes: parseAddressTest(output), output, verify: { ok: verify.code === 0, output: `${verify.stdout}${verify.stderr}`.trim() } };
  },
});

defineOp('mail.sendmail', {
  description: 'Hand a message to Exim for delivery (panel notifications); recipients are passed as argv after --',
  schema: z.object({
    from: emailAddress,
    to: z.array(emailAddress).min(1).max(100),
    subject: singleLine(998),
    text: z.string().max(2 * 1024 * 1024),
    headers: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/), singleLine(998)).optional(),
  }).strict(),
  run: async ({ from, to, subject, text, headers = {} }) => {
    const layout = requireExim();
    const lines = [`From: ${from}`, `To: ${to.join(', ')}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'X-Mailer: WHM panel'];
    for (const [k, v] of Object.entries(headers)) if (!/^(from|to|subject|date|content-type|mime-version)$/i.test(k)) lines.push(`${k}: ${v}`);
    const message = `${lines.join('\r\n')}\r\n\r\n${text.replace(/\r?\n/g, '\r\n')}\r\n`;
    const { code, stdout, stderr } = await exec(layout.bin, ['-i', '-f', from, '--', ...to], { input: message, allowFailure: true, timeoutMs: 120_000 });
    if (code !== 0) throw new OpError('send_failed', `Exim did not accept the message: ${(stderr || stdout).trim().split('\n').pop() || `exit ${code}`}`, { output: `${stdout}${stderr}`.slice(-4000) });
    return { from, to, accepted: true, bytes: Buffer.byteLength(message) };
  },
});

// -------------------------------------------------------- managed includes ---

async function validateExim(layout) {
  const { code, stdout, stderr } = await exec(layout.bin, ['-bV'], { allowFailure: true, timeoutMs: 60_000 });
  const output = `${stdout}${stderr}`.trim();
  return { ok: code === 0 && !/configuration error|main option .* unknown|Exim configuration error/i.test(output), output };
}

async function regenerateDebianConfig(layout) {
  if (layout.flavor !== 'debian' || !hasBinary('update-exim4.conf')) return null;
  const { code, stdout, stderr } = await exec('update-exim4.conf', [], { allowFailure: true, timeoutMs: 120_000 });
  return { ok: code === 0, output: `${stdout}${stderr}`.trim() };
}

const BLOCK_BEGIN = '# BEGIN WHM panel (Email filters) - managed block, edits inside are overwritten';
const BLOCK_END = '# END WHM panel (Email filters)';

// Exim string expansions the stock Debian remote_smtp transport signs with
// (DKIM_* macros) and that a RHEL transport can .include as dkim_* options.
// The key file name comes from a dsearch so the (tainted) From: domain never
// reaches the file system directly; a missing key expands to "0" = no signing.
export function dkimExpansions(dkimDir) {
  const domain = '${lc:${domain:$h_from:}}';
  return {
    domain,
    selector: `\${lookup{${domain}}lsearch{${dkimDir}/selectors.lst}{$value}{default}}`,
    privateKey: `\${lookup{${domain}.key}dsearch{${dkimDir}}{${dkimDir}/$value}{0}}`,
    canon: 'relaxed',
  };
}

// The lines the panel needs in Exim's main section: the Debian ACL hook macro,
// the sqlite_dbfile option greylisting needs on a taint-checking Exim (>= 4.94),
// the local/relay domain lists Email Routing maintains and the DKIM signing
// macros. Debian's template defines MAIN_LOCAL_DOMAINS, MAIN_RELAY_TO_DOMAINS
// and the DKIM_* macros under .ifndef, so our definitions win unless the admin
// already set them in localmacros (then verifyHook reports it).
export function renderManagedBlock(layout, { sqliteDbfile = null, domainLists = false, dkim = false } = {}) {
  const lines = [BLOCK_BEGIN];
  const debian = layout.includeMode === 'debian-macro';
  if (debian) lines.push(`CHECK_RCPT_LOCAL_ACL_FILE = ${layout.aclFile}`);
  if (sqliteDbfile) lines.push(`sqlite_dbfile = ${sqliteDbfile}`);
  if (domainLists) {
    const local = ['@', 'localhost', ...(layout.otherHostnames || []), layout.localDomainsFile];
    const relay = [...(layout.debianRelayDomains || []), layout.relayDomainsFile];
    if (debian) lines.push('.ifndef MAIN_LOCAL_DOMAINS', `MAIN_LOCAL_DOMAINS = ${local.join(':')}`, '.endif', '.ifndef MAIN_RELAY_TO_DOMAINS', `MAIN_RELAY_TO_DOMAINS = ${relay.join(':')}`, '.endif');
    else lines.push(`domainlist local_domains = ${local.join(' : ')}`, `domainlist relay_to_domains = ${relay.join(' : ')}`);
  }
  if (dkim && debian) {
    const e = dkimExpansions(layout.dkimDir);
    lines.push('.ifndef DKIM_PRIVATE_KEY', `DKIM_DOMAIN = ${e.domain}`, `DKIM_SELECTOR = ${e.selector}`, `DKIM_PRIVATE_KEY = ${e.privateKey}`, `DKIM_CANON = ${e.canon}`, '.endif');
  }
  lines.push(BLOCK_END);
  return lines.join('\n');
}

// Transport options for layouts without the Debian macros: included once by
// the admin inside the remote_smtp transport.
export function renderDkimTransportFragment(layout) {
  const e = dkimExpansions(layout.dkimDir);
  return `${MANAGED} (DKIM signing). .include this file inside the remote_smtp transport of ${layout.confDir}/exim.conf.\ndkim_domain = ${e.domain}\ndkim_selector = ${e.selector}\ndkim_private_key = ${e.privateKey}\ndkim_canon = ${e.canon}\n`;
}

// What the current managed block carries, so a writer that does not know the
// greylist state (routing lists) keeps the sqlite_dbfile line as it is.
export function readManagedBlock(text) {
  const start = (text || '').indexOf(BLOCK_BEGIN);
  const end = (text || '').indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return { present: false, sqliteDbfile: null };
  const body = text.slice(start, end);
  return { present: true, sqliteDbfile: body.match(/^sqlite_dbfile = (\S+)$/m)?.[1] || null };
}

// Replaces (or appends) the managed block, keeping everything the admin wrote
// around it.
export function mergeManagedBlock(previous, block) {
  const text = previous || '';
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end >= start) {
    const before = text.slice(0, start);
    const after = text.slice(end + BLOCK_END.length).replace(/^\n/, '');
    return `${before}${block}\n${after}`;
  }
  const body = text.replace(/\s+$/, '');
  return `${body ? `${body}\n\n` : ''}${block}\n`;
}

// Did the generated configuration actually pick up the hook? exim -bP reads the
// config the daemon would use, so this also covers an unsplit Debian layout
// that ignores conf.d/ or a RHEL config missing the .include line.
async function verifyDkim(layout) {
  if (!layout.installed) return { hooked: null, detail: 'Exim is not installed' };
  const argv = layout.includeMode === 'debian-macro' ? ['-bP', 'macro', 'DKIM_PRIVATE_KEY'] : ['-bP', 'transport', 'remote_smtp'];
  const { code, stdout, stderr } = await exec(layout.bin, argv, { allowFailure: true, timeoutMs: 30_000 });
  const line = stdout.split('\n').find((l) => /dkim_private_key|DKIM_PRIVATE_KEY/i.test(l)) || '';
  const hooked = code === 0 && line.includes(layout.dkimDir);
  let detail = null;
  if (!hooked) {
    if (code !== 0) detail = `${stdout}${stderr}`.trim().split('\n').pop() || 'DKIM_PRIVATE_KEY is not defined in the generated configuration';
    else if (line) detail = `Exim signs with ${line.trim()}, not with the keys under ${layout.dkimDir}`;
    else detail = layout.includeMode === 'debian-macro' ? 'DKIM_PRIVATE_KEY is not defined in the generated configuration' : `the remote_smtp transport has no dkim_private_key option`;
  }
  return { hooked, detail };
}

async function verifyDomainLists(layout) {
  const out = {};
  for (const [name, file] of [['local_domains', layout.localDomainsFile], ['relay_to_domains', layout.relayDomainsFile]]) {
    const { code, stdout } = await exec(layout.bin, ['-bP', 'domainlist', name], { allowFailure: true, timeoutMs: 30_000 });
    out[name] = code === 0 && stdout.includes(file);
  }
  const hooked = out.local_domains && out.relay_to_domains;
  return { hooked, detail: hooked ? null : `Exim's ${Object.entries(out).filter(([, ok]) => !ok).map(([n]) => n).join(' and ')} list does not read the panel's domain list file` };
}

async function verifyHook(layout, { sqliteDbfile = null, domainLists = false, dkim = false } = {}) {
  const result = { hooked: null, sqliteDbfile: null, detail: null, domainListsHooked: null, domainListsDetail: null, dkimHooked: null, dkimDetail: null };
  if (domainLists) { const d = await verifyDomainLists(layout); result.domainListsHooked = d.hooked; result.domainListsDetail = d.detail; }
  if (dkim) { const d = await verifyDkim(layout); result.dkimHooked = d.hooked; result.dkimDetail = d.detail; }
  if (layout.includeMode === 'debian-macro') {
    const { code, stdout, stderr } = await exec(layout.bin, ['-bP', 'macro', 'CHECK_RCPT_LOCAL_ACL_FILE'], { allowFailure: true, timeoutMs: 30_000 });
    result.hooked = code === 0 && stdout.includes(layout.aclFile);
    if (!result.hooked) result.detail = `${stdout}${stderr}`.trim().split('\n').pop() || 'CHECK_RCPT_LOCAL_ACL_FILE is not defined in the generated configuration';
  } else if (layout.includeMode === 'manual') {
    const info = await eximVersion(layout);
    const file = info.configFile && /^\/etc\/exim/.test(info.configFile) ? info.configFile : null;
    const text = file ? readText(file) : null;
    result.hooked = text == null ? null : new RegExp(`^\\s*\\.include\\s+${layout.aclFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text);
    if (result.hooked === false) result.detail = `${file} does not .include ${layout.aclFile}`;
  }
  if (sqliteDbfile) {
    const { code, stdout } = await exec(layout.bin, ['-bP', 'sqlite_dbfile'], { allowFailure: true, timeoutMs: 30_000 });
    result.sqliteDbfile = code === 0 && stdout.includes(sqliteDbfile);
  }
  return result;
}

function hookHint(layout, verify, { sqliteDbfile = null } = {}) {
  const hints = [];
  if (layout.includeMode === 'debian-macro' && verify.hooked === false) hints.push(`Exim did not pick up CHECK_RCPT_LOCAL_ACL_FILE from ${layout.macroFile}. Run update-exim4.conf and reload Exim, or add ".include ${layout.aclFile}" inside acl_check_rcpt (before the final accept) in ${layout.confDir}/exim4.conf.template.`);
  if (layout.includeMode === 'manual' && verify.hooked !== true) hints.push(`Add ".include ${layout.aclFile}" inside acl_check_rcpt (before the final accept) in ${layout.confDir}/exim.conf once; the panel keeps that file current.`);
  if (sqliteDbfile && verify.sqliteDbfile === false) hints.push(layout.includeMode === 'manual' ? `Add ".include ${layout.mainFile}" to the main section of ${layout.confDir}/exim.conf so sqlite_dbfile points at the greylist database.` : `Exim did not pick up sqlite_dbfile from ${layout.macroFile}; greylisting lookups will fail until it does.`);
  if (verify.domainListsHooked === false) hints.push(layout.includeMode === 'manual' ? `Replace the "domainlist local_domains" and "domainlist relay_to_domains" lines in ${layout.confDir}/exim.conf with ".include ${layout.mainFile}" so Email Routing can switch domains between local, remote and backup.` : `Exim did not pick up MAIN_LOCAL_DOMAINS / MAIN_RELAY_TO_DOMAINS from ${layout.macroFile} (${verify.domainListsDetail}); remove any definition of those macros elsewhere, run update-exim4.conf and reload Exim.`);
  if (verify.dkimHooked === false) hints.push(layout.includeMode === 'manual' ? `Add ".include ${layout.dkimDir}/transport.conf" inside the remote_smtp transport of ${layout.confDir}/exim.conf so outbound mail is DKIM-signed.` : `Exim is not signing with the panel's DKIM keys (${verify.dkimDetail}); remove any DKIM_* macros defined elsewhere, run update-exim4.conf and reload Exim.`);
  return hints.length ? hints.join(' ') : null;
}

// Everything the managed block must carry right now: the domain lists once
// Email Routing wrote them, DKIM always (an absent key expands to no signing).
function blockState(layout) {
  return { domainLists: exists(layout.localDomainsFile) || exists(layout.relayDomainsFile), dkim: true };
}

defineOp('mail.config.include.read', {
  description: 'Read a panel-managed Exim include file',
  schema: z.object({ name: includeName }).strict(),
  run: async ({ name }, ctx) => {
    const layout = requireExim();
    const file = path.join(layout.whmDir, name);
    ctx.assertAllowedPath(file, 'read');
    return { path: file, exists: exists(file), content: readText(file) };
  },
});

defineOp('mail.config.include.list', {
  description: 'List panel-managed Exim include files and whether the ACL hook is wired',
  run: async (_args, ctx) => {
    const layout = requireExim();
    ctx.assertAllowedPath(layout.whmDir, 'read');
    let files = [];
    try { files = fs.readdirSync(layout.whmDir).filter((f) => !f.endsWith('.whm-bak') && !f.includes('.whm-tmp-')).sort().map((f) => ({ name: f, size: fs.statSync(path.join(layout.whmDir, f)).size })); } catch { /* no dir yet */ }
    const state = blockState(layout);
    const verify = await verifyHook(layout, state);
    return { dir: layout.whmDir, aclFile: layout.aclFile, includeMode: verify.hooked === false ? 'manual' : layout.includeMode, splitConfig: layout.splitConfig, macroFile: layout.macroFile, hooked: verify.hooked, hookDetail: verify.detail, domainListsHooked: verify.domainListsHooked, dkimHooked: verify.dkimHooked, files, hint: hookHint(layout, verify) };
  },
});

defineOp('mail.config.include.write', {
  description: 'Write a managed Exim include/list file under <confdir>/whm, wire the main-section hooks (ACL include, sqlite_dbfile, domain lists, DKIM macros), validate with exim -bV (rolling back on error), verify they are live and reload Exim',
  // sqliteDbfile: a path sets the option, null removes it, absent keeps whatever the block has.
  schema: z.object({ name: includeName, content: arg.text, reload: z.boolean().default(true), hook: z.boolean().default(true), sqliteDbfile: greylistDbPath.nullable().optional() }).strict(),
  run: async ({ name, content, reload, hook, sqliteDbfile }, ctx) => {
    const layout = requireExim();
    const file = path.join(layout.whmDir, name);
    ctx.assertAllowedPath(file, 'write');
    if (sqliteDbfile) ctx.assertAllowedPath(sqliteDbfile, 'read');
    const previous = readText(file);
    writeAtomic(file, content.endsWith('\n') ? content : `${content}\n`);
    const rollback = [() => restore(file, previous)];
    let hookAdded = false;
    const state = blockState(layout);
    const target = layout.includeMode === 'debian-macro' ? layout.macroFile : layout.mainFile;
    if (sqliteDbfile === undefined) sqliteDbfile = target ? readManagedBlock(readText(target)).sqliteDbfile : null;
    if (hook && layout.includeMode) {
      const block = renderManagedBlock(layout, { sqliteDbfile, ...state });
      ctx.assertAllowedPath(target, 'write');
      const previousBlockFile = readText(target);
      const wanted = layout.includeMode === 'debian-macro' ? mergeManagedBlock(previousBlockFile, block) : `${MANAGED} (Email filters). Main-section options; .include this file from the main section of exim.conf.\n${block}\n`;
      if (previousBlockFile !== wanted) { writeAtomic(target, wanted); rollback.push(() => restore(target, previousBlockFile)); hookAdded = previousBlockFile == null || !previousBlockFile.includes(BLOCK_BEGIN); }
      // Earlier panel versions wrote the macro to conf.d/main, which only an
      // unsplit layout ignores and a split one would now define twice.
      if (layout.legacyMacroFile && exists(layout.legacyMacroFile) && (readText(layout.legacyMacroFile) || '').includes(MANAGED)) {
        ctx.assertAllowedPath(layout.legacyMacroFile, 'write');
        const legacy = readText(layout.legacyMacroFile);
        fs.unlinkSync(layout.legacyMacroFile);
        rollback.push(() => restore(layout.legacyMacroFile, legacy));
      }
      // The hook needs the ACL file to exist even when only a list was written.
      if (!exists(layout.aclFile)) { writeAtomic(layout.aclFile, `${MANAGED} (Email filters). No filters are enabled.\n`); rollback.push(() => restore(layout.aclFile, null)); }
    }
    const regenerated = await regenerateDebianConfig(layout);
    const test = await validateExim(layout);
    if (!test.ok || (regenerated && !regenerated.ok)) {
      for (const undo of rollback.reverse()) undo();
      await regenerateDebianConfig(layout);
      const detail = (regenerated && !regenerated.ok ? regenerated.output : test.output).split('\n').filter(Boolean).pop();
      throw new OpError('config_invalid', `Exim rejected the new configuration; the previous file was restored: ${detail}`, { output: test.output });
    }
    const verify = hook ? await verifyHook(layout, { sqliteDbfile, ...state }) : { hooked: null, sqliteDbfile: null, detail: null, domainListsHooked: null, dkimHooked: null };
    const reloaded = reload ? await reloadUnit(layout.units) : { reloaded: false, unit: null };
    return {
      path: file, bytes: Buffer.byteLength(content), validated: true, hookAdded, regenerated: regenerated?.ok ?? null, ...reloaded,
      includeMode: verify.hooked === false ? 'manual' : layout.includeMode, splitConfig: layout.splitConfig, macroFile: target,
      hooked: verify.hooked, hookDetail: verify.detail, sqliteDbfile: verify.sqliteDbfile,
      domainListsHooked: verify.domainListsHooked, domainListsDetail: verify.domainListsDetail ?? null, dkimHooked: verify.dkimHooked, dkimDetail: verify.dkimDetail ?? null,
      hint: hook ? hookHint(layout, verify, { sqliteDbfile }) : null,
    };
  },
});

defineOp('mail.config.include.remove', {
  description: 'Remove a managed Exim include file and reload',
  destructive: true,
  schema: z.object({ name: includeName }).strict(),
  run: async ({ name }, ctx) => {
    const layout = requireExim();
    const file = path.join(layout.whmDir, name);
    ctx.assertAllowedPath(file, 'write');
    const existed = exists(file);
    if (existed) fs.unlinkSync(file);
    await regenerateDebianConfig(layout);
    const reloaded = await reloadUnit(layout.units);
    return { path: file, existed, ...reloaded };
  },
});

defineOp('mail.reload', {
  description: 'Validate the Exim configuration and reload the daemon',
  run: async () => {
    const layout = requireExim();
    const test = await validateExim(layout);
    if (!test.ok) throw new OpError('config_invalid', `Exim configuration is invalid: ${test.output.split('\n').pop()}`, { output: test.output });
    return { validated: true, ...(await reloadUnit(layout.units)) };
  },
});

// ------------------------------------------------------------ greylisting ---

const GREYLIST_DIR = '/var/lib/whm/greylist';
const GREYLIST_DB = `${GREYLIST_DIR}/greylist.db`;
const GREYLIST_SCHEMA = 'CREATE TABLE IF NOT EXISTS greylist (sender TEXT NOT NULL, recipient TEXT NOT NULL, host TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, passed INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (sender, recipient, host)); CREATE INDEX IF NOT EXISTS idx_greylist_last ON greylist (last_seen);';

// Which greylisting backend the Exim on this host can drive: its own SQLite
// lookup (needs exim built with sqlite + the sqlite3 CLI to create the DB), or
// Debian's greylistd daemon over its socket.
export async function greylistBackend() {
  const layout = eximLayout();
  if (!layout.installed) return { backend: null, reason: 'Exim is not installed' };
  const info = await eximVersion(layout);
  // Exim >= 4.94 taint-checks lookups: the database path must come from the
  // sqlite_dbfile main option, not from the (tainted) query string.
  if (info.lookups.some((l) => /sqlite/i.test(l)) && hasBinary('sqlite3')) return { backend: 'sqlite', dbFile: GREYLIST_DB, runUser: layout.runUser, version: info.version, dbfileOption: versionAtLeast(info.version, [4, 94]) };
  if (hasBinary('greylistd')) return { backend: 'greylistd', socket: '/var/run/greylistd/socket', version: info.version };
  return { backend: null, reason: 'Install greylistd, or an Exim build with SQLite lookups plus the sqlite3 command-line tool' };
}

defineOp('mail.greylist.backend', { description: 'Greylisting backend available to Exim on this host', run: () => greylistBackend() });

// Expands a harmless lookup through the running configuration, which is the
// only way to see runtime expansion errors (taint refusals, unreadable db)
// that exim -bV cannot catch.
defineOp('mail.greylist.selftest', {
  description: 'Expand a read-only SQLite greylist lookup with exim -be to prove the ACL lookups work on this host',
  run: async (_args, ctx) => {
    const layout = requireExim();
    const be = await greylistBackend();
    if (be.backend !== 'sqlite') return { backend: be.backend, ok: null, skipped: true, reason: be.reason || 'the sqlite backend is not in use' };
    ctx.assertAllowedPath(GREYLIST_DB, 'read');
    if (!exists(GREYLIST_DB)) return { backend: 'sqlite', ok: false, form: be.dbfileOption ? 'sqlite_dbfile' : 'inline', output: `${GREYLIST_DB} does not exist` };
    const query = `${be.dbfileOption ? '' : `${GREYLIST_DB} `}SELECT COUNT(*) FROM greylist`;
    const { code, stdout, stderr } = await exec(layout.bin, ['-be', `\${lookup sqlite {${query}}{ok:$value}{fail}}`], { allowFailure: true, timeoutMs: 30_000 });
    const output = `${stdout}${stderr}`.trim();
    return { backend: 'sqlite', form: be.dbfileOption ? 'sqlite_dbfile' : 'inline', ok: code === 0 && /^ok:\d+$/m.test(output), records: Number(output.match(/^ok:(\d+)$/m)?.[1]) || 0, output: output.slice(-2000) };
  },
});

defineOp('mail.greylist.init', {
  description: 'Create the greylist SQLite database Exim writes to (sqlite backend)',
  run: async (_args, ctx) => {
    const layout = requireExim();
    const be = await greylistBackend();
    if (be.backend !== 'sqlite') throw new OpError('capability_missing', be.reason || 'The SQLite greylisting backend is not available on this host');
    ctx.assertAllowedPath(GREYLIST_DB, 'write');
    fs.mkdirSync(GREYLIST_DIR, { recursive: true, mode: 0o770 });
    await exec('sqlite3', [GREYLIST_DB, GREYLIST_SCHEMA], { timeoutMs: 30_000 });
    const user = layout.runUser ? passwdEntry(layout.runUser) : null;
    if (user) { fs.chownSync(GREYLIST_DIR, user.uid, user.gid); fs.chownSync(GREYLIST_DB, user.uid, user.gid); }
    fs.chmodSync(GREYLIST_DIR, 0o770);
    fs.chmodSync(GREYLIST_DB, 0o660);
    return { dbFile: GREYLIST_DB, owner: layout.runUser };
  },
});

defineOp('mail.greylist.triplets', {
  description: 'Current greylist triplets (sqlite backend) or greylistd statistics',
  schema: z.object({ limit: z.number().int().min(1).max(10_000).default(500), q: z.string().max(200).regex(/^[^'\0;]*$/).optional() }).strict(),
  run: async ({ limit, q }, ctx) => {
    requireExim();
    const be = await greylistBackend();
    if (be.backend === 'sqlite') {
      ctx.assertAllowedPath(GREYLIST_DB, 'read');
      if (!exists(GREYLIST_DB)) return { backend: 'sqlite', total: 0, triplets: [] };
      // `q` is embedded as a LIKE literal with quotes forbidden by the schema; the
      // statement itself goes to sqlite3 as a single argv element.
      const where = q ? `WHERE sender LIKE '%${q}%' OR recipient LIKE '%${q}%' OR host LIKE '%${q}%'` : '';
      const count = await exec('sqlite3', ['-readonly', GREYLIST_DB, `SELECT COUNT(*) FROM greylist ${where};`], { timeoutMs: 30_000 });
      const { stdout } = await exec('sqlite3', ['-readonly', '-json', GREYLIST_DB, `SELECT sender, recipient, host, first_seen, last_seen, passed, count FROM greylist ${where} ORDER BY last_seen DESC LIMIT ${limit};`], { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 });
      let rows = [];
      try { rows = stdout.trim() ? JSON.parse(stdout) : []; } catch { rows = []; }
      return { backend: 'sqlite', total: Number(count.stdout.trim()) || 0, triplets: rows.map((r) => ({ ...r, firstSeen: new Date(r.first_seen * 1000).toISOString(), lastSeen: new Date(r.last_seen * 1000).toISOString(), passed: Boolean(r.passed) })) };
    }
    if (be.backend === 'greylistd') {
      const { stdout } = await exec('greylist', ['stats'], { allowFailure: true, timeoutMs: 30_000 }).catch(() => ({ stdout: '' }));
      return { backend: 'greylistd', total: null, triplets: [], stats: stdout.trim() };
    }
    return { backend: null, total: 0, triplets: [], reason: be.reason };
  },
});

defineOp('mail.greylist.purge', {
  description: 'Delete greylist triplets (expired ones by default, or everything)',
  destructive: true,
  schema: z.object({ olderThanDays: z.number().int().min(0).max(3650).default(35), all: z.boolean().default(false) }).strict(),
  run: async ({ olderThanDays, all }, ctx) => {
    requireExim();
    const be = await greylistBackend();
    if (be.backend !== 'sqlite') return { backend: be.backend, deleted: 0, skipped: true };
    ctx.assertAllowedPath(GREYLIST_DB, 'write');
    if (!exists(GREYLIST_DB)) return { backend: 'sqlite', deleted: 0 };
    const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
    const sql = all ? 'DELETE FROM greylist; SELECT changes();' : `DELETE FROM greylist WHERE last_seen < ${cutoff}; SELECT changes();`;
    const { stdout } = await exec('sqlite3', [GREYLIST_DB, sql], { timeoutMs: 60_000 });
    return { backend: 'sqlite', deleted: Number(stdout.trim()) || 0, all };
  },
});

// -------------------------------------------------------------------- DKIM ---

function installedDkimKeys(layout) {
  try {
    return fs.readdirSync(layout.dkimDir).filter((f) => f.endsWith('.key')).map((f) => ({ domain: f.slice(0, -4), selector: (readText(path.join(layout.dkimDir, `${f.slice(0, -4)}.selector`)) || 'default').trim(), path: path.join(layout.dkimDir, f) }));
  } catch { return []; }
}

// selectors.lst is what the DKIM_SELECTOR lsearch reads; transport.conf is the
// fragment a non-Debian layout includes in its remote_smtp transport.
function writeDkimIndex(layout) {
  const keys = installedDkimKeys(layout);
  writeAtomic(path.join(layout.dkimDir, 'selectors.lst'), `${MANAGED} (DKIM selectors): domain: selector\n${keys.map((k) => `${k.domain}: ${k.selector}`).join('\n')}\n`, 0o644);
  writeAtomic(path.join(layout.dkimDir, 'transport.conf'), renderDkimTransportFragment(layout), 0o644);
  return keys;
}

// Installing a key must also make Exim sign with it: the managed block (DKIM
// macros) is (re)written through the ACL include so the usual validate/rollback
// path applies, then the live configuration is checked.
async function ensureDkimHook(layout, ctx) {
  if (!layout.includeMode) return { hooked: null, detail: 'unsupported Exim layout', hint: null };
  const aclContent = readText(layout.aclFile) ?? `${MANAGED} (Email filters). No filters are enabled.\n`;
  let write;
  try { write = await runOp('mail.config.include.write', { name: path.basename(layout.aclFile), content: aclContent, reload: true, hook: true }, ctx); } catch (err) { return { hooked: false, detail: err.message, hint: null }; }
  return { hooked: write.dkimHooked, detail: write.dkimDetail, hint: write.hint };
}

defineOp('mail.dkim.install', {
  description: 'Store a DKIM private key where Exim can read it (<confdir>/whm/dkim/<domain>.key, 0640 root:exim), index its selector and wire the signing hook',
  schema: z.object({ domain: arg.domain, selector: dkimSelector, privateKeyPem: z.string().max(16 * 1024).regex(/^-----BEGIN (RSA |EC |)PRIVATE KEY-----[\s\S]+-----END (RSA |EC |)PRIVATE KEY-----\s*$/, 'PEM private key'), hook: z.boolean().default(true) }).strict(),
  run: async ({ domain, selector, privateKeyPem, hook }, ctx) => {
    const layout = requireExim();
    const file = path.join(layout.dkimDir, `${domain}.key`);
    ctx.assertAllowedPath(file, 'write');
    fs.mkdirSync(layout.dkimDir, { recursive: true, mode: 0o750 });
    writeAtomic(file, privateKeyPem.endsWith('\n') ? privateKeyPem : `${privateKeyPem}\n`, 0o640);
    writeAtomic(path.join(layout.dkimDir, `${domain}.selector`), `${selector}\n`, 0o644);
    const grp = layout.runUser ? groupEntry(layout.runUser) || groupEntry('mail') : null;
    if (grp) { fs.chownSync(file, 0, grp.gid); fs.chownSync(layout.dkimDir, 0, grp.gid); }
    writeDkimIndex(layout);
    const signing = hook ? await ensureDkimHook(layout, ctx) : await verifyDkim(layout);
    return { domain, selector, path: file, selectorPath: path.join(layout.dkimDir, `${domain}.selector`), group: grp?.name || null, signing: signing.hooked, signingDetail: signing.detail, hint: signing.hint ?? null };
  },
});

defineOp('mail.dkim.remove', {
  description: 'Remove an installed DKIM private key',
  destructive: true,
  schema: z.object({ domain: arg.domain }).strict(),
  run: async ({ domain }, ctx) => {
    const layout = requireExim();
    const file = path.join(layout.dkimDir, `${domain}.key`);
    ctx.assertAllowedPath(file, 'write');
    let removed = 0;
    for (const f of [file, path.join(layout.dkimDir, `${domain}.selector`)]) { try { fs.unlinkSync(f); removed++; } catch { /* missing */ } }
    if (exists(layout.dkimDir)) writeDkimIndex(layout);
    return { domain, removed };
  },
});

defineOp('mail.dkim.list', {
  description: 'Domains with a DKIM key installed for Exim and whether the running configuration signs with them',
  run: async (_args, ctx) => {
    const layout = requireExim();
    ctx.assertAllowedPath(layout.dkimDir, 'read');
    const signing = await verifyDkim(layout);
    return { dir: layout.dkimDir, keys: installedDkimKeys(layout), signing: signing.hooked, signingDetail: signing.detail, hint: signing.hooked === false ? hookHint(layout, { dkimHooked: false, dkimDetail: signing.detail }) : null };
  },
});

// ------------------------------------------------------------------- spamd ---

const SPAMD_FLAG_SCHEMA = {
  maxChildren: z.number().int().min(1).max(200).nullable().optional(),
  minChildren: z.number().int().min(1).max(200).nullable().optional(),
  maxConnPerChild: z.number().int().min(1).max(100_000).nullable().optional(),
  timeoutChild: z.number().int().min(1).max(3600).nullable().optional(),
  listenIp: z.string().regex(/^[0-9A-Fa-f.:*]{1,45}$/).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  allowedIps: z.array(z.string().regex(/^[0-9A-Fa-f.:]+(\/\d{1,3})?$/)).max(50).nullable().optional(),
  username: arg.username.or(z.literal('root')).nullable().optional(),
  nice: z.number().int().min(-20).max(19).nullable().optional(),
  createPrefs: z.boolean().nullable().optional(),
  allowTell: z.boolean().nullable().optional(),
  helperHomeDir: configPath.nullable().optional(),
  localOnly: z.boolean().nullable().optional(),
  syslog: z.enum(['mail', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7', 'stderr', 'null']).nullable().optional(),
  maxSpare: z.number().int().min(0).max(200).nullable().optional(),
  minSpare: z.number().int().min(0).max(200).nullable().optional(),
};
const spamdSettings = z.object({ enabled: z.boolean().optional(), cron: z.boolean().optional(), ...SPAMD_FLAG_SCHEMA }).strict();

function shellUnquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export function parseSpamdOptions(optionString) {
  const out = { extra: [] };
  const tokens = (optionString || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (let i = 0; i < tokens.length; i++) {
    const t = shellUnquote(tokens[i]);
    const next = () => shellUnquote(tokens[++i] ?? '');
    const eq = t.match(/^(--[a-z-]+)=(.*)$/);
    const flag = eq ? eq[1] : t;
    const val = () => (eq ? eq[2] : next());
    switch (flag) {
      case '--max-children': case '-m': out.maxChildren = Number(val()); break;
      case '--min-children': out.minChildren = Number(val()); break;
      case '--max-conn-per-child': out.maxConnPerChild = Number(val()); break;
      case '--timeout-child': out.timeoutChild = Number(val()); break;
      case '--listen': case '--listen-ip': case '-i': { const v = val(); const m = v.match(/^(.*?)(?::(\d+))?$/); out.listenIp = m[1] || '*'; if (m[2]) out.port = Number(m[2]); break; }
      case '--port': case '-p': out.port = Number(val()); break;
      case '--allowed-ips': case '-A': out.allowedIps = val().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--username': case '-u': out.username = val(); break;
      case '--nice': out.nice = Number(val()); break;
      case '--create-prefs': case '-c': out.createPrefs = true; break;
      case '--nouser-config': case '-x': out.createPrefs = false; break;
      case '--allow-tell': out.allowTell = true; break;
      case '--helper-home-dir': case '-H': out.helperHomeDir = val(); break;
      case '--local': case '-L': out.localOnly = true; break;
      case '--syslog': case '-s': out.syslog = val(); break;
      case '--max-spare': out.maxSpare = Number(val()); break;
      case '--min-spare': out.minSpare = Number(val()); break;
      default: out.extra.push(t);
    }
  }
  return out;
}

export function renderSpamdOptions(o) {
  const parts = [];
  if (o.maxChildren != null) parts.push(`--max-children=${o.maxChildren}`);
  if (o.minChildren != null) parts.push(`--min-children=${o.minChildren}`);
  if (o.maxSpare != null) parts.push(`--max-spare=${o.maxSpare}`);
  if (o.minSpare != null) parts.push(`--min-spare=${o.minSpare}`);
  if (o.maxConnPerChild != null) parts.push(`--max-conn-per-child=${o.maxConnPerChild}`);
  if (o.timeoutChild != null) parts.push(`--timeout-child=${o.timeoutChild}`);
  if (o.listenIp) parts.push(`--listen=${o.listenIp}${o.port ? `:${o.port}` : ''}`);
  else if (o.port != null) parts.push(`--port=${o.port}`);
  if (o.allowedIps?.length) parts.push(`--allowed-ips=${o.allowedIps.join(',')}`);
  if (o.username) parts.push(`--username=${o.username}`);
  if (o.nice != null) parts.push(`--nice=${o.nice}`);
  if (o.createPrefs === true) parts.push('--create-prefs'); else if (o.createPrefs === false) parts.push('--nouser-config');
  if (o.allowTell) parts.push('--allow-tell');
  if (o.helperHomeDir) parts.push(`--helper-home-dir=${o.helperHomeDir}`);
  if (o.localOnly) parts.push('--local');
  if (o.syslog) parts.push(`--syslog=${o.syslog}`);
  for (const e of o.extra || []) parts.push(e);
  return parts.join(' ');
}

export function parseSpamdDefaults(text) {
  const out = { enabled: null, cron: null, options: '', other: [] };
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Z_]+)=(.*)$/);
    if (!m) { out.other.push(raw); continue; }
    if (m[1] === 'ENABLED') out.enabled = shellUnquote(m[2]) === '1';
    else if (m[1] === 'CRON') out.cron = shellUnquote(m[2]) === '1';
    else if (m[1] === 'OPTIONS' || m[1] === 'SPAMDOPTIONS') out.options = shellUnquote(m[2]);
    else out.other.push(raw);
  }
  return out;
}

export function renderSpamdDefaults({ flavor, enabled, cron, options, other }) {
  const lines = [`${MANAGED} (Spamd Startup Configuration). Edit through the panel; manual changes are overwritten.`];
  if (flavor === 'rhel') lines.push(`SPAMDOPTIONS="${options}"`);
  else {
    if (enabled != null) lines.push(`ENABLED=${enabled ? 1 : 0}`);
    lines.push(`OPTIONS="${options}"`);
    if (cron != null) lines.push(`CRON=${cron ? 1 : 0}`);
  }
  for (const l of other || []) lines.push(l);
  return `${lines.join('\n')}\n`;
}

defineOp('mail.spamd.config.read', {
  description: 'SpamAssassin daemon startup options (/etc/default/spamassassin or /etc/sysconfig/spamassassin) and unit state',
  run: async (_args, ctx) => {
    const layout = spamdLayout();
    ctx.assertAllowedPath(layout.configFile, 'read');
    const text = readText(layout.configFile);
    const parsed = parseSpamdDefaults(text);
    let unit = null;
    if (hasBinary('systemctl')) {
      for (const u of layout.units) {
        const { code, stdout } = await exec('systemctl', ['show', `${u}.service`, '--property=ActiveState,SubState,LoadState,UnitFileState'], { allowFailure: true });
        const kv = Object.fromEntries(stdout.trim().split('\n').map((l) => l.split('=')));
        if (code === 0 && kv.LoadState && kv.LoadState !== 'not-found') { unit = { name: u, active: kv.ActiveState, sub: kv.SubState, enabled: kv.UnitFileState }; break; }
      }
    }
    return { installed: layout.installed, bin: layout.bin, path: layout.configFile, flavor: layout.configFile.startsWith('/etc/sysconfig') ? 'rhel' : 'debian', configExists: text != null, enabled: parsed.enabled, cron: parsed.cron, options: parseSpamdOptions(parsed.options), optionString: parsed.options, raw: text, unit, localCf: layout.localCf };
  },
});

defineOp('mail.spamd.config.write', {
  description: 'Write spamd startup options and restart the daemon',
  schema: z.object({ settings: spamdSettings, restart: z.boolean().default(true) }).strict(),
  run: async ({ settings, restart }, ctx) => {
    const layout = spamdLayout();
    if (!layout.installed) throw new OpError('capability_missing', 'SpamAssassin (spamd) is not installed on this server');
    ctx.assertAllowedPath(layout.configFile, 'write');
    const flavor = layout.configFile.startsWith('/etc/sysconfig') ? 'rhel' : 'debian';
    const current = parseSpamdDefaults(readText(layout.configFile));
    const options = parseSpamdOptions(current.options);
    const { enabled, cron, ...flags } = settings;
    for (const [k, v] of Object.entries(flags)) { if (v === undefined) continue; if (v === null) delete options[k]; else options[k] = v; }
    const next = { flavor, enabled: enabled ?? current.enabled ?? (flavor === 'debian' ? true : null), cron: cron ?? current.cron, options: renderSpamdOptions(options), other: current.other };
    writeAtomic(layout.configFile, renderSpamdDefaults(next));
    let service = { reloaded: false, unit: null };
    if (restart) service = await reloadUnit(layout.units, next.enabled === false ? 'stop' : 'restart');
    return { path: layout.configFile, enabled: next.enabled, cron: next.cron, options, optionString: next.options, ...service };
  },
});

// --------------------------------------------------------------- mailboxes ---

const mailboxFormat = z.enum(['maildir', 'mbox', 'mdbox', 'sdbox']);

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

// These ops run as root inside directories the hosting user controls, so any
// symlink between the home and the target would redirect chown/chmod/mkdir/
// doveadm outside the account. Every existing component below `base` must be a
// real directory (or the final component a real file).
export function assertNoSymlinks(base, target) {
  const rel = path.relative(base, target);
  if (rel === '') return;
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new OpError('path_not_allowed', `${target} is outside ${base}`);
  let current = base;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const st = lstatOrNull(current);
    if (!st) return;
    if (st.isSymbolicLink()) throw new OpError('path_not_allowed', `${current} is a symbolic link; refusing to operate on it as root`);
  }
}

defineOp('mail.mailbox.fix_perms', {
  description: "Repair ownership and permissions of an account's mail tree (user:user, dirs 0700, files 0600) without following symlinks",
  // dirs are direct children of the home: "." or ".." would turn the recursive
  // chown/chmod loose on the home root or on every account under it.
  schema: z.object({ username: arg.username, homeDir: arg.absPath, dirs: z.array(z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/)).min(1).max(10).default(['mail', 'etc']) }).strict(),
  run: async ({ username, homeDir, dirs }, ctx) => {
    ctx.assertAllowedPath(homeDir, 'write');
    const user = passwdEntry(username);
    if (!user) throw new OpError('not_found', `Linux user "${username}" does not exist`);
    const realHome = fs.realpathSync(homeDir);
    const results = [];
    for (const d of dirs) {
      const target = path.join(homeDir, d);
      ctx.assertAllowedPath(target, 'write');
      const before = lstatOrNull(target);
      if (!before) { results.push({ path: target, exists: false }); continue; }
      if (before.isSymbolicLink() || !before.isDirectory()) { results.push({ path: target, exists: true, skipped: before.isSymbolicLink() ? 'symlink' : 'not a directory', entries: 0 }); continue; }
      let real = null;
      try { real = fs.realpathSync(target); } catch { real = null; }
      if (real !== path.join(realHome, d) || path.dirname(real) !== realHome || real === realHome) { results.push({ path: target, exists: true, skipped: 'resolves outside the account home', entries: 0 }); continue; }
      // find -P never follows symlinks; chown -h changes links themselves and
      // -type d/f exclude links from chmod, which would dereference them.
      await exec('find', ['-P', target, '-exec', 'chown', '-h', `${user.uid}:${user.gid}`, '{}', '+'], { timeoutMs: 600_000 });
      await exec('find', ['-P', target, '-type', 'd', '-exec', 'chmod', '0700', '{}', '+'], { timeoutMs: 600_000 });
      await exec('find', ['-P', target, '-type', 'f', '-exec', 'chmod', '0600', '{}', '+'], { timeoutMs: 600_000 });
      const { stdout } = await exec('find', ['-P', target, '-printf', 'x'], { allowFailure: true, timeoutMs: 600_000, maxBuffer: 64 * 1024 * 1024 });
      results.push({ path: target, exists: true, entries: stdout.length, previousOwner: `${before.uid}:${before.gid}`, owner: `${user.uid}:${user.gid}`, ownerChanged: before.uid !== user.uid || before.gid !== user.gid });
    }
    return { username, homeDir, results };
  },
});

defineOp('mail.mailbox.convert', {
  description: 'Convert a mailbox between formats with doveadm sync (one-way into the target location); both paths must stay inside the account home with no symlinks',
  schema: z.object({
    user: emailAddress.or(arg.username),
    homeDir: arg.absPath,
    source: z.object({ format: mailboxFormat, path: arg.absPath }).strict(),
    target: z.object({ format: mailboxFormat, path: arg.absPath }).strict(),
    dryRun: z.boolean().default(false),
  }).strict(),
  run: async ({ user, homeDir, source, target, dryRun }, ctx) => {
    ctx.assertAllowedPath(homeDir, 'read');
    ctx.assertAllowedPath(source.path, 'read');
    ctx.assertAllowedPath(target.path, 'write');
    assertNoSymlinks(homeDir, source.path);
    assertNoSymlinks(homeDir, target.path);
    if (!hasBinary('doveadm')) throw new OpError('capability_missing', 'Dovecot (doveadm) is not installed on this server; mailbox conversion needs dsync');
    if (source.format === target.format && source.path === target.path) throw new OpError('invalid_args', 'Source and target are identical');
    if (!exists(source.path)) throw new OpError('not_found', `${source.path} does not exist`);
    const srcLocation = `${source.format}:${source.path}`;
    const dstLocation = `${target.format}:${target.path}`;
    // Parents created here belong to the account, not root, so Dovecot can write.
    const owner = fs.statSync(homeDir);
    const missing = [];
    for (let p = path.dirname(target.path); p.startsWith(`${homeDir}/`) && !exists(p); p = path.dirname(p)) missing.push(p);
    for (const p of missing.reverse()) { fs.mkdirSync(p, { mode: 0o700 }); fs.chownSync(p, owner.uid, owner.gid); }
    // Dovecot's conversion recipe: the user's mail_location (-o) is the source
    // and the positional location is where dsync writes.
    const argv = ['-o', `mail_location=${srcLocation}`, 'sync', '-1', '-u', user, dstLocation];
    if (dryRun) return { user, source: srcLocation, target: dstLocation, dryRun: true, command: ['doveadm', ...argv] };
    const { code, stdout, stderr } = await exec('doveadm', argv, { allowFailure: true, timeoutMs: 6 * 3600_000, maxBuffer: 64 * 1024 * 1024 });
    if (code !== 0) throw new OpError('convert_failed', `doveadm sync failed: ${(stderr || stdout).trim().split('\n').pop()}`, { output: `${stdout}${stderr}`.slice(-8000) });
    let size = null;
    try { const du = await exec('du', ['-sb', target.path], { allowFailure: true, timeoutMs: 600_000 }); size = Number(du.stdout.split(/\s+/)[0]) || null; } catch { /* optional */ }
    return { user, source: srcLocation, target: dstLocation, dryRun: false, targetBytes: size, output: `${stdout}${stderr}`.slice(-8000) };
  },
});

defineOp('mail.mailbox.inspect', {
  description: "Which mailbox formats exist under an account's home (mail/, Maildir/, mbox files)",
  schema: z.object({ homeDir: arg.absPath }).strict(),
  run: async ({ homeDir }, ctx) => {
    ctx.assertAllowedPath(homeDir, 'read');
    const found = [];
    const probe = (p, format, note) => { if (exists(p)) { let size = null; try { size = fs.statSync(p).size; } catch { /* ignore */ } found.push({ path: p, format, note, size }); } };
    probe(path.join(homeDir, 'mail'), exists(path.join(homeDir, 'mail', 'cur')) ? 'maildir' : 'mixed', 'cPanel-style mail root');
    probe(path.join(homeDir, 'Maildir'), 'maildir', 'Dovecot default Maildir');
    probe(path.join(homeDir, 'mdbox'), 'mdbox', 'Dovecot mdbox');
    probe(path.join(homeDir, 'mbox'), 'mbox', 'Single mbox file');
    probe(path.join(homeDir, 'mail', 'mdbox'), 'mdbox', 'mdbox under mail/');
    let domains = [];
    try { domains = fs.readdirSync(path.join(homeDir, 'mail'), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.includes('.') && !e.name.startsWith('.')).map((e) => e.name); } catch { /* none */ }
    return { homeDir, found, domains };
  },
});
