import http from 'node:http';
import { z } from 'zod';
import { defineOp, arg } from './registry.js';

// Apache mod_status worker table. The machine-readable /server-status?auto
// report (web.status) only carries counters and the scoreboard string; the
// per-slot rows (which vhost/request each worker is serving) exist only in
// the HTML report, and only while ExtendedStatus is On. Nothing here touches
// the host beyond a loopback HTTP GET.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  });
}

const cellText = (html) => decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const cells = (row, tag) => [...row.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'))].map((m) => cellText(m[1]));
const num = (v) => { const s = String(v ?? '').trim(); return s === '' || s === '-' || Number.isNaN(Number(s)) ? null : Number(s); };

// mod_status header labels → row fields. The column set differs between
// Apache versions (Protocol since 2.4.18, Dur since 2.4.34) so cells are
// mapped by header, never by position.
const COLUMNS = {
  srv: { key: 'srv', label: 'Srv', title: 'Child server number - generation' },
  pid: { key: 'pid', label: 'PID', title: 'OS process ID' },
  acc: { key: 'acc', label: 'Acc', title: 'Accesses this connection / this child / this slot' },
  m: { key: 'mode', label: 'M', title: 'Mode of operation' },
  cpu: { key: 'cpuSeconds', label: 'CPU', title: 'CPU usage, number of seconds' },
  ss: { key: 'secondsSinceRequest', label: 'SS', title: 'Seconds since beginning of most recent request' },
  req: { key: 'requestMs', label: 'Req', title: 'Milliseconds required to process most recent request' },
  dur: { key: 'durationMs', label: 'Dur', title: 'Sum of milliseconds required to process all requests' },
  conn: { key: 'connKBytes', label: 'Conn', title: 'Kilobytes transferred this connection' },
  child: { key: 'childMBytes', label: 'Child', title: 'Megabytes transferred this child' },
  slot: { key: 'slotMBytes', label: 'Slot', title: 'Total megabytes transferred this slot' },
  client: { key: 'client', label: 'Client', title: 'Client address' },
  protocol: { key: 'protocol', label: 'Protocol', title: 'Protocol of the request' },
  vhost: { key: 'vhost', label: 'VHost', title: 'Virtual host serving the request' },
  request: { key: 'request', label: 'Request', title: 'Request line' },
};

function shapeRow(headers, values) {
  const w = { srv: null, slot: null, generation: null, pid: null, acc: null, mode: null, cpuSeconds: null, secondsSinceRequest: null, requestMs: null, durationMs: null, connKBytes: null, childMBytes: null, slotMBytes: null, client: null, protocol: null, vhost: null, request: null, extra: {} };
  headers.forEach((h, i) => {
    const v = values[i];
    if (v === undefined) return;
    const col = COLUMNS[h.toLowerCase()];
    if (!col) { w.extra[h] = v; return; }
    switch (col.key) {
      case 'srv': {
        w.srv = v;
        const m = v.match(/^(\d+)-(\d+)$/);
        if (m) { w.slot = Number(m[1]); w.generation = Number(m[2]); }
        break;
      }
      case 'pid': w.pid = num(v); break;
      case 'acc': {
        const parts = v.split('/').map(num);
        w.acc = { connection: parts[0] ?? null, child: parts[1] ?? null, slot: parts[2] ?? null };
        break;
      }
      case 'mode': w.mode = v.slice(0, 1) || null; break;
      case 'client': case 'protocol': case 'vhost': case 'request': w[col.key] = v === '' ? null : v.slice(0, 2048); break;
      default: w[col.key] = num(v);
    }
  });
  return w;
}

// Finds the table whose header row starts with Srv/PID and turns each <tr>
// into one worker. Returns null when the report carries no worker table
// (ExtendedStatus Off, or not a mod_status page at all).
export function parseWorkerTable(html) {
  const text = String(html || '');
  for (const table of text.matchAll(/<table[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const rows = [...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((m) => m[1]);
    const headerRow = rows.find((r) => /<th[\s>]/i.test(r));
    if (!headerRow) continue;
    const headers = cells(headerRow, 'th');
    if (!/^srv$/i.test(headers[0] || '') || !headers.some((h) => /^pid$/i.test(h))) continue;
    const workers = rows.filter((r) => /<td[\s>]/i.test(r)).map((r) => shapeRow(headers, cells(r, 'td'))).filter((w) => w.srv != null);
    const columns = headers.map((h) => ({ header: h, ...(COLUMNS[h.toLowerCase()] || { key: null, label: h, title: null }) }));
    return { columns, workers };
  }
  return null;
}

export function parseStatusPage(html) {
  const text = String(html || '');
  const isStatus = /Apache Server Status|<title>Apache Status<\/title>|Scoreboard Key/i.test(text);
  if (!isStatus) return { statusPage: false, extended: null, table: null };
  const table = parseWorkerTable(text);
  // "ExtendedStatus Off" is not printed; the table only appears with it On.
  return { statusPage: true, extended: table != null, table };
}

// A full worker table for the largest MPM pools is well under 1 MB; anything
// streaming past the cap, or past the hard deadline, is cut off and whatever
// was read is parsed. `timeout` alone only covers socket idleness.
export const MAX_BODY_BYTES = 1024 * 1024;

export function fetchStatusHtml({ host, port }, { timeoutMs = 3000, deadlineMs = 10_000, maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let body = '';
    let response = null;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(deadline); resolve(value); };
    const cut = () => { finish(response ? { statusCode: response.statusCode, body, truncated: true } : null); req.destroy(); };
    const deadline = setTimeout(cut, deadlineMs);
    const req = http.get({ host, port, path: '/server-status', headers: { Host: 'localhost' }, timeout: timeoutMs }, (res) => {
      response = res;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length >= maxBytes) { body = body.slice(0, maxBytes); cut(); }
      });
      res.on('end', () => finish({ statusCode: res.statusCode, body, truncated: false }));
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

defineOp('modstatus.workers', {
  description: 'Per-worker request table from the Apache mod_status HTML report (/server-status on the given port/bind address); requires ExtendedStatus On',
  schema: z.object({ port: z.number().int().min(1).max(65535).default(80), bind: arg.ip.nullable().default(null) }).strict(),
  run: async ({ port, bind }) => {
    const probe = { host: bind || '127.0.0.1', port };
    const res = await fetchStatusHtml(probe);
    if (!res) return { probe, reachable: false, statusPage: false, extended: null, columns: [], workers: [] };
    const parsed = res.statusCode === 200 ? parseStatusPage(res.body) : { statusPage: false, extended: null, table: null };
    return { probe, reachable: true, httpStatus: res.statusCode, truncated: Boolean(res.truncated), statusPage: parsed.statusPage, extended: parsed.extended, columns: parsed.table?.columns || [], workers: parsed.table?.workers || [] };
  },
});
