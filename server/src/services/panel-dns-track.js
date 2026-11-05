import net from 'node:net';
import { HttpError, CapabilityError } from '../lib/errors.js';
import { assertFeature } from './panel-domains.js';

// Track DNS for the account panel (P2-7): two read-only probes run on this
// server by the agent — `dns.lookup` (dig +short, pinned record types) and
// `dns.trace` (traceroute -n, 20 hops). Nothing is written and nothing is
// scoped to the account's own zones: any public name may be looked up, as in
// cPanel. One trace at a time per account keeps a looping client from
// holding several 60-second probes open. Feature `traceroute`.

export const FEATURE = 'traceroute';

// A probe target must be a public address: the host must not be used to map
// its own loopback, private, link-local (cloud metadata) or multicast ranges.
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
export const LOOKUP_TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'SOA', 'PTR'];
export const TRACE_TIMEOUT_MS = 60_000;
// The agent reports which program is missing; the panel turns that into the
// capability the operator installs.
const PACKAGE_CAPABILITY = { dnsutils: 'dnsutils', traceroute: 'traceroute' };

export function createPanelDnsTrackService(ctx) {
  const tracing = new Map();

  function requireScope(scope) {
    if (!scope?.username || !scope.accountId) throw new HttpError(403, 'panel_scope_required', 'No hosting account is bound to this session');
    assertFeature(scope, FEATURE);
  }

  const mapError = (err, fallback) => {
    if (err?.agentError && (err.code === 'capability_missing' || err.code === 'binary_not_found')) {
      return new CapabilityError(PACKAGE_CAPABILITY[err.details?.package] || fallback, err.message);
    }
    return err;
  };

  async function lookup(scope, { name, type = 'A' }, req) {
    requireScope(scope);
    let r;
    try {
      r = await ctx.agent.op('dns.lookup', { name, type }, { req });
    } catch (err) { throw mapError(err, 'dnsutils'); }
    return {
      name, type,
      answers: Array.isArray(r?.answers) ? r.answers.map(String) : [],
      notes: Array.isArray(r?.notes) ? r.notes.map(String) : [],
      error: r?.error ?? null,
      checkedAt: new Date().toISOString(),
    };
  }

  async function trace(scope, { host }, req) {
    requireScope(scope);
    if (tracing.has(scope.accountId)) throw new HttpError(409, 'busy', 'A trace is already running for this account; wait for it to finish');
    tracing.set(scope.accountId, Date.now());
    let r;
    try {
      r = await ctx.agent.op('dns.trace', { host }, { req, timeoutMs: TRACE_TIMEOUT_MS + 5000 });
    } catch (err) {
      throw mapError(err, 'traceroute');
    } finally {
      tracing.delete(scope.accountId);
    }
    const hops = Array.isArray(r?.hops) ? r.hops : [];
    return {
      host,
      target: r?.target ?? null,
      hops: hops.map((h) => ({ hop: Number(h.hop), address: h.address ?? null, addresses: Array.isArray(h.addresses) ? h.addresses : [], rtts: Array.isArray(h.rtts) ? h.rtts : [], timeouts: Number(h.timeouts) || 0 })),
      reached: Boolean(r?.reached),
      error: r?.error ?? null,
      output: typeof r?.output === 'string' ? r.output : '',
      checkedAt: new Date().toISOString(),
    };
  }

  return { lookup, trace, FEATURE, LOOKUP_TYPES };
}
