// Zone-file rendering and parsing shared by the DNS service: the database is the
// source of truth for records; the file on disk is always re-rendered from it, and
// files found on disk (or raw edits) are parsed back into records.

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA', 'PTR'];
const HOST_RE = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.?$/i;
const LABEL_RE = /^(\*|(\*\.)?[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*)$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(:[0-9a-f]{1,4}){1,6}|:((:[0-9a-f]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?\d)?\d)\.){3}(25[0-5]|(2[0-4]|1?\d)?\d))$/i;

export class ZoneError extends Error {
  constructor(message, fields) {
    super(message);
    this.fields = fields;
  }
}

export function nextSerial(current = 0) {
  const d = new Date();
  const today = Number(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`) * 100;
  const cur = Number(current) || 0;
  return cur >= today ? cur + 1 : today + 1;
}

export function parseTtl(text) {
  if (text == null) return null;
  const s = String(text).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^(\d+[smhdw])+$/.test(s)) return null;
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+)([smhdw])/g)) total += Number(n) * mult[u];
  return total;
}

// Absolute (trailing-dot) form of a name as it appears in a zone for `domain`.
export function absoluteName(name, domain) {
  const n = String(name).trim().toLowerCase();
  if (n === '@' || n === '') return `${domain}.`;
  if (n.endsWith('.')) return n;
  return `${n}.${domain}.`;
}

// Zone-relative form ('@' for the apex). Names outside the zone stay absolute.
export function relativeName(name, domain) {
  const abs = absoluteName(name, domain);
  if (abs === `${domain}.`) return '@';
  if (abs.endsWith(`.${domain}.`)) return abs.slice(0, -(domain.length + 2));
  return abs;
}

export function quoteTxt(value) {
  const chunks = [];
  const s = String(value);
  for (let i = 0; i < Math.max(1, s.length); i += 255) chunks.push(`"${s.slice(i, i + 255).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return chunks.join(' ');
}

export function renderTemplate(body, vars) {
  return String(body).replace(/%([a-z0-9_]+)%/gi, (m, key) => (vars[key] != null ? String(vars[key]) : m));
}

// Validates and normalises a record for storage. Hostname-valued RDATA (CNAME,
// NS, MX, PTR, SRV targets) is stored absolute with a trailing dot so rendering
// never depends on $ORIGIN.
export function normalizeRecord(input, domain) {
  const fields = {};
  const fail = (k, msg) => { (fields[k] ||= []).push(msg); };
  const type = String(input.type || '').toUpperCase();
  if (!RECORD_TYPES.includes(type)) fail('type', `Type must be one of ${RECORD_TYPES.join(', ')}`);
  let name = String(input.name ?? '@').trim().toLowerCase();
  if (name === '' || name === domain || name === `${domain}.`) name = '@';
  if (name !== '@') {
    if (name.endsWith('.')) {
      if (!name.endsWith(`.${domain}.`)) fail('name', `Name must be inside the zone ${domain}`);
      else name = name.slice(0, -(domain.length + 2));
    } else if (name.endsWith(`.${domain}`)) name = name.slice(0, -(domain.length + 1));
    if (!LABEL_RE.test(name) || name.length > 200) fail('name', 'Must be @, a wildcard, or labels of letters, digits, "_" and "-"');
  }
  let ttl = input.ttl === '' || input.ttl == null ? null : parseTtl(input.ttl);
  if (input.ttl != null && input.ttl !== '' && (ttl == null || ttl < 0 || ttl > 2147483647)) fail('ttl', 'TTL must be seconds (or 1h/1d) between 0 and 2147483647');
  let priority = input.priority == null || input.priority === '' ? null : Number(input.priority);
  let value = String(input.value ?? '').trim();
  const host = (v, key = 'value') => {
    const h = v.trim().toLowerCase();
    if (h === '@') return `${domain}.`;
    if (!HOST_RE.test(h)) { fail(key, 'Must be a valid hostname'); return h; }
    return h.endsWith('.') ? h : `${h}.`;
  };
  switch (type) {
    case 'A': if (!IPV4_RE.test(value)) fail('value', 'Must be an IPv4 address'); break;
    case 'AAAA': if (!IPV6_RE.test(value)) fail('value', 'Must be an IPv6 address'); value = value.toLowerCase(); break;
    case 'CNAME': case 'NS': case 'PTR': value = host(value); break;
    case 'MX':
      if (priority == null || !Number.isInteger(priority) || priority < 0 || priority > 65535) fail('priority', 'MX priority must be 0–65535');
      value = host(value);
      break;
    case 'SRV': {
      if (priority == null || !Number.isInteger(priority) || priority < 0 || priority > 65535) fail('priority', 'SRV priority must be 0–65535');
      if (name === '@' || !/^_[a-z0-9-]+\._(tcp|udp|tls|sctp)(\..+)?$/.test(name)) fail('name', 'SRV names look like _service._proto (e.g. _sip._tcp)');
      const m = value.match(/^(\d+)\s+(\d+)\s+(\S+)$/);
      if (!m) fail('value', 'SRV value is "weight port target" (e.g. 10 5060 sip.example.com)');
      else {
        if (Number(m[1]) > 65535) fail('value', 'SRV weight must be 0–65535');
        if (Number(m[2]) > 65535) fail('value', 'SRV port must be 0–65535');
        value = `${Number(m[1])} ${Number(m[2])} ${host(m[3])}`;
      }
      break;
    }
    case 'TXT':
      if (value.length === 0 || value.length > 4096 || /[\0-\x1f\x7f]/.test(value)) fail('value', 'TXT must be 1–4096 printable characters (no tabs, line breaks or control characters)');
      break;
    case 'CAA': {
      const m = value.match(/^(\d{1,3})\s+(issue|issuewild|iodef)\s+"?([^"]*)"?$/i);
      if (!m || Number(m[1]) > 255) fail('value', 'CAA value is "flags tag value" (e.g. 0 issue letsencrypt.org)');
      else value = `${Number(m[1])} ${m[2].toLowerCase()} ${m[3].trim()}`;
      break;
    }
    default: break;
  }
  if (!['MX', 'SRV'].includes(type)) priority = null;
  if (Object.keys(fields).length) throw new ZoneError('Record validation failed', fields);
  return { name, type, ttl, priority, value };
}

const RDATA = {
  TXT: (v) => quoteTxt(v),
  CAA: (v) => { const [flags, tag, ...rest] = v.split(/\s+/); return `${flags} ${tag} "${rest.join(' ')}"`; },
};

export function renderRecordLine(rec, domain, defaultTtl) {
  const owner = rec.name === '@' ? '@' : rec.name;
  const ttl = rec.ttl != null && rec.ttl !== defaultTtl ? String(rec.ttl) : '';
  const prio = rec.priority != null ? `${rec.priority} ` : '';
  const rdata = RDATA[rec.type] ? RDATA[rec.type](rec.value) : rec.value;
  return `${owner.padEnd(24)}${ttl.padEnd(8)}IN  ${rec.type.padEnd(6)}${prio}${rdata}`;
}

export function parseSoaValue(value, domain) {
  const parts = String(value || '').trim().split(/\s+/);
  const primary = parts[0] && parts[0] !== '' ? parts[0] : `ns1.${domain}.`;
  const hostmaster = parts[1] || `hostmaster.${domain}.`;
  const [refresh = 3600, retry = 1800, expire = 1209600, minimum = 86400] = parts.slice(2).map(Number);
  return { primary, hostmaster, refresh, retry, expire, minimum };
}

export function soaValue({ primary, hostmaster, refresh, retry, expire, minimum }) {
  return `${primary} ${hostmaster} ${refresh} ${retry} ${expire} ${minimum}`;
}

// zone: { domain, ttl, serial }; records: SOA (optional) + resource records.
export function renderZone(zone, records, { generatedBy = 'WHM panel' } = {}) {
  const domain = zone.domain;
  const soaRec = records.find((r) => r.type === 'SOA');
  const soa = parseSoaValue(soaRec?.value, domain);
  const lines = [
    `; Zone file for ${domain}. Generated by ${generatedBy}; edit with DNS Zone Manager, not by hand.`,
    `$ORIGIN ${domain}.`,
    `$TTL ${zone.ttl}`,
    `@${''.padEnd(23)}${(soaRec?.ttl != null && soaRec.ttl !== zone.ttl ? String(soaRec.ttl) : '').padEnd(8)}IN  SOA   ${soa.primary} ${soa.hostmaster} (`,
    `${''.padEnd(40)}${zone.serial}  ; serial`,
    `${''.padEnd(40)}${soa.refresh}  ; refresh`,
    `${''.padEnd(40)}${soa.retry}  ; retry`,
    `${''.padEnd(40)}${soa.expire}  ; expire`,
    `${''.padEnd(40)}${soa.minimum} )  ; minimum`,
    '',
  ];
  const order = { NS: 0, A: 1, AAAA: 2, MX: 3, CNAME: 4, TXT: 5, SRV: 6, CAA: 7, PTR: 8 };
  const rrs = records.filter((r) => r.type !== 'SOA');
  const sorted = [...rrs].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || (a.line_index ?? 0) - (b.line_index ?? 0) || (a.id ?? 0) - (b.id ?? 0));
  let lastType = null;
  for (const rec of sorted) {
    if (lastType && lastType !== rec.type) lines.push('');
    lines.push(renderRecordLine(rec, domain, zone.ttl));
    lastType = rec.type;
  }
  return `${lines.join('\n')}\n`;
}

// Splits zone text into logical entries, honouring quotes, ";" comments and
// "( ... )" continuation. Each entry: { tokens: [{ text, quoted }], indented, line }.
export function tokenizeZone(text) {
  const entries = [];
  let tokens = [];
  let current = '';
  let quoted = false;
  let inQuote = false;
  let depth = 0;
  let line = 1;
  let entryLine = 1;
  let indented = /^[ \t]/.test(text);
  let atLineStart = true;
  const flushToken = () => { if (current.length || quoted) tokens.push({ text: current, quoted }); current = ''; quoted = false; };
  const flushEntry = () => { flushToken(); if (tokens.length) entries.push({ tokens, indented, line: entryLine }); tokens = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '\\' && i + 1 < text.length) { current += text[++i]; continue; }
      if (ch === '"') { inQuote = false; flushToken(); continue; }
      if (ch === '\n') line++;
      current += ch;
      continue;
    }
    if (ch === '"') { flushToken(); inQuote = true; quoted = true; atLineStart = false; continue; }
    if (ch === ';') { while (i < text.length && text[i] !== '\n') i++; i--; continue; }
    if (ch === '(') { flushToken(); depth++; atLineStart = false; continue; }
    if (ch === ')') { flushToken(); depth = Math.max(0, depth - 1); continue; }
    if (ch === '\n') {
      line++;
      flushToken();
      if (depth === 0) { flushEntry(); entryLine = line; indented = /^[ \t]/.test(text.slice(i + 1, i + 2)); }
      atLineStart = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { flushToken(); continue; }
    atLineStart = false;
    current += ch;
  }
  flushEntry();
  return entries;
}

// Parses a master file into { ttl, serial, records: [...], errors: [...] }.
// Records come back in the storage shape used by normalizeRecord().
export function parseZone(text, domain) {
  const errors = [];
  let origin = `${domain}.`;
  let ttl = null;
  let serial = null;
  let prevOwner = origin;
  const records = [];
  const toAbs = (n) => (n === '@' ? origin : n.endsWith('.') ? n.toLowerCase() : `${n.toLowerCase()}.${origin}`);
  for (const entry of tokenizeZone(text)) {
    const toks = entry.tokens.map((t) => t.text);
    const first = toks[0];
    if (first === '$ORIGIN') { origin = toks[1]?.endsWith('.') ? toks[1].toLowerCase() : `${toks[1]}.${origin}`; continue; }
    if (first === '$TTL') { const t = parseTtl(toks[1]); if (t == null) errors.push(`line ${entry.line}: bad $TTL`); else ttl = t; continue; }
    if (first === '$INCLUDE' || first === '$GENERATE') { errors.push(`line ${entry.line}: ${first} is not supported by the zone manager`); continue; }
    let idx = 0;
    let owner;
    if (entry.indented || entry.tokens[0]?.quoted) owner = prevOwner;
    else owner = toAbs(toks[idx++]);
    prevOwner = owner;
    let rttl = null;
    while (idx < toks.length) {
      const t = toks[idx];
      if (/^(IN|CH|HS)$/i.test(t)) { idx++; continue; }
      const p = parseTtl(t);
      if (p != null && !/^[A-Z]+$/i.test(t)) { rttl = p; idx++; continue; }
      break;
    }
    const type = String(toks[idx++] || '').toUpperCase();
    const rdata = entry.tokens.slice(idx);
    const plain = rdata.map((t) => t.text);
    if (!type) { errors.push(`line ${entry.line}: missing record type`); continue; }
    const name = (() => {
      if (owner === origin && origin === `${domain}.`) return '@';
      if (owner.endsWith(`.${domain}.`)) return owner.slice(0, -(domain.length + 2));
      if (owner === `${domain}.`) return '@';
      return owner;
    })();
    const absHost = (v) => (v === '@' ? origin : v?.endsWith('.') ? v.toLowerCase() : `${String(v).toLowerCase()}.${origin}`);
    try {
      switch (type) {
        case 'SOA': {
          if (plain.length < 7) { errors.push(`line ${entry.line}: SOA needs primary, hostmaster and 5 numbers`); break; }
          serial = Number(plain[2]);
          records.push({ name: '@', type: 'SOA', ttl: rttl, priority: null, value: soaValue({ primary: absHost(plain[0]), hostmaster: absHost(plain[1]), refresh: parseTtl(plain[3]), retry: parseTtl(plain[4]), expire: parseTtl(plain[5]), minimum: parseTtl(plain[6]) }) });
          break;
        }
        case 'MX': records.push(normalizeRecord({ name, type, ttl: rttl, priority: Number(plain[0]), value: absHost(plain[1]) }, domain)); break;
        case 'SRV': records.push(normalizeRecord({ name, type, ttl: rttl, priority: Number(plain[0]), value: `${plain[1]} ${plain[2]} ${absHost(plain[3])}` }, domain)); break;
        case 'CNAME': case 'NS': case 'PTR': records.push(normalizeRecord({ name, type, ttl: rttl, value: absHost(plain[0]) }, domain)); break;
        case 'TXT': case 'SPF': records.push(normalizeRecord({ name, type: 'TXT', ttl: rttl, value: rdata.map((t) => t.text).join('') }, domain)); break;
        case 'CAA': records.push(normalizeRecord({ name, type, ttl: rttl, value: plain.join(' ') }, domain)); break;
        case 'A': case 'AAAA': records.push(normalizeRecord({ name, type, ttl: rttl, value: plain[0] }, domain)); break;
        default: errors.push(`line ${entry.line}: record type ${type} is not supported by the zone manager`);
      }
    } catch (err) {
      errors.push(`line ${entry.line}: ${Object.entries(err.fields || {}).map(([k, v]) => `${k}: ${v.join('; ')}`).join(', ') || err.message}`);
    }
  }
  return { ttl, serial, records, errors };
}

// A CNAME may not share its owner name with any other record (RFC 1034 §3.6.2).
export function checkConflicts(records, candidate, excludeId = null) {
  const sameName = records.filter((r) => r.name === candidate.name && r.id !== excludeId && r.type !== 'SOA');
  if (candidate.type === 'CNAME' && sameName.length) return `A CNAME cannot coexist with other records at "${candidate.name}"`;
  if (candidate.type !== 'CNAME' && sameName.some((r) => r.type === 'CNAME')) return `"${candidate.name}" already has a CNAME; remove it first`;
  if (candidate.type === 'CNAME' && candidate.name === '@') return 'A CNAME at the zone apex is not allowed';
  return null;
}
