import net from 'node:net';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// Track DNS for the account panel (P2-7): two read-only probes that run on
// this server with a pinned argv each. The name or host is the only caller
// input and it is schema-checked before it reaches execFile, so nothing is
// ever interpreted as an option or by a shell.

export const LOOKUP_TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'SOA', 'PTR'];
export const LOOKUP_TIMEOUT_MS = 15_000;
export const TRACE_TIMEOUT_MS = 60_000;
export const TRACE_MAX_HOPS = 20;

// A hostname (the agent regex already refuses a leading "-", spaces, "/" and
// upper case) or a literal address: an IPv4 matches the hostname regex, an
// IPv6 needs its own branch.
const target = z.union([arg.hostname, arg.ipv6], { error: 'Must be a hostname or an IP address' })
  .refine((v) => v !== 'localhost' && (!net.isIP(v) || isPublicAddress(v)), { message: 'Only public addresses can be looked up or traced' });

// Mirror of the server route check (services/panel-dns-track.js): a literal
// target must be a public address, never this host's loopback, a private,
// link-local (cloud metadata) or multicast range, so a direct op call gets
// the same answer as the route.
function v6Groups(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const g = t.length ? t : h;
  if (g.length && g[g.length - 1].includes('.')) {
    const v4 = g.pop().split('.').map(Number);
    g.push(((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
  }
  const fill = ip.includes('::') ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16));
}
function isPublicV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}
export function isPublicAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPublicV4(ip);
  if (v !== 6) return false;
  const g = v6Groups(ip.toLowerCase());
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return false;
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) return false;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  return true;
}

const trim = (s) => String(s ?? '').trim();

// `dig +short` prints one answer per line (an MX line is "10 mail.example.",
// a TXT line keeps its quotes); a servfail or timeout leaves stdout empty
// and puts ";; ..." diagnostics on stdout too.
export function parseDigShort(stdout) {
  const answers = [];
  const notes = [];
  for (const raw of String(stdout ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith(';;')) notes.push(line.replace(/^;;\s*/, '').trim());
    else answers.push(line.trim());
  }
  return { answers, notes };
}

// traceroute -n prints "traceroute to host (ip), N hops max, M byte packets"
// then one line per hop: " 3  198.51.100.1  1.234 ms  1.100 ms  0.980 ms";
// a probe that timed out is "*", and a hop that changes address mid-line
// repeats the new address before its times. Lines that fit none of this are
// kept out of the hop list but left in `output`.
export function parseTraceroute(stdout) {
  const hops = [];
  let header = null;
  let target = null;
  for (const raw of String(stdout ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const head = line.match(/^traceroute to (\S+) \((\S+)\)/);
    if (head) { header = line; target = head[2]; continue; }
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const hop = { hop: Number(m[1]), addresses: [], rtts: [], timeouts: 0 };
    for (const tok of m[2].trim().split(/\s+/)) {
      if (tok === '*') hop.timeouts += 1;
      else if (tok === 'ms') continue;
      else if (/^[0-9]+(\.[0-9]+)?$/.test(tok)) hop.rtts.push(Number(tok));
      else if (net.isIP(tok) && !hop.addresses.includes(tok)) hop.addresses.push(tok);
      // "!H", "!N" and similar annotations are left out of the structured
      // answer; the raw line stays in `output`.
    }
    hop.address = hop.addresses[0] ?? null;
    hops.push(hop);
  }
  const last = hops[hops.length - 1];
  const reached = Boolean(target && last && last.addresses.includes(target));
  return { header, target, hops, reached };
}

defineOp('dns.lookup', {
  description: 'Look up one record type of a name with dig +short (account panel Track DNS)',
  schema: z.object({
    name: target,
    type: z.enum(LOOKUP_TYPES).default('A'),
  }).strict(),
  timeoutMs: LOOKUP_TIMEOUT_MS,
  run: async ({ name, type }) => {
    if (!hasBinary('dig')) throw new OpError('capability_missing', 'dig is not installed on this server (dnsutils / bind-utils package)', { package: 'dnsutils' });
    // A reverse lookup of a literal address goes through -x so dig builds the
    // in-addr.arpa / ip6.arpa name itself; "-x" is a pinned literal, the
    // address follows it and can never start with "-".
    const argv = ['+short', '+time=3', '+tries=1'];
    if (type === 'PTR' && net.isIP(name)) argv.push('-x', name);
    else argv.push(name, type);
    const r = await exec('dig', argv, { allowFailure: true, timeoutMs: LOOKUP_TIMEOUT_MS });
    const { answers, notes } = parseDigShort(r.stdout);
    let error = null;
    if (r.code !== 0) error = notes.find((n) => /timed out|no servers could be reached/i.test(n)) ? 'timeout' : 'failed';
    return { name, type, answers, notes, error, exitCode: r.code, output: r.stdout.slice(-4000) };
  },
});

defineOp('dns.trace', {
  description: 'Trace the route from this server to a host (traceroute -n, 20 hops, 2 s per probe)',
  schema: z.object({ host: target }).strict(),
  timeoutMs: TRACE_TIMEOUT_MS,
  run: async ({ host }) => {
    if (!hasBinary('traceroute')) throw new OpError('capability_missing', 'traceroute is not installed on this server (traceroute package)', { package: 'traceroute' });
    let r;
    try {
      r = await exec('traceroute', ['-n', '-w', '2', '-m', String(TRACE_MAX_HOPS), host], { allowFailure: true, timeoutMs: TRACE_TIMEOUT_MS });
    } catch (err) {
      if (err.code === 'timeout') return { host, header: null, target: null, hops: [], reached: false, error: 'timeout', exitCode: null, output: trim(err.details?.stderr).slice(-4000) };
      throw err;
    }
    const parsed = parseTraceroute(r.stdout);
    let error = null;
    if (r.code !== 0) error = /unknown host|name or service not known|temporary failure in name resolution|cannot resolve/i.test(r.stderr) ? 'unknown_host' : 'failed';
    return { host, ...parsed, error, exitCode: r.code, output: `${r.stdout}${r.stderr ? `\n${trim(r.stderr)}` : ''}`.slice(-8000) };
  },
});
