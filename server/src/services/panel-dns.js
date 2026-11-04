import { HttpError, notFound } from '../lib/errors.js';
import { auditArgs } from './panel-domains.js';

export const PANEL_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'];
const PROTECTED_TYPES = new Set(['NS', 'SOA']);

export const DELEGATION_TTL_MS = 10 * 60_000;
const DELEGATION_ERROR_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 3000;
const PRIVATE_V4 = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

const normName = (v) => String(v ?? '').trim().toLowerCase().replace(/\.$/, '');

// Zone editor on the account's own zones (design §4.3). NS/SOA/TTL/raw text,
// DNSSEC and templates are never exposed; zones are pinned by
// dns_zones.account_id before ctx.dns sees a name.
export function createPanelDnsService(ctx) {
  const { db } = ctx;
  const stmts = {
    zones: db.prepare('SELECT id, domain, serial, ttl, type, dnssec_enabled, updated_at FROM dns_zones WHERE account_id = ? ORDER BY domain'),
    zone: db.prepare('SELECT id, domain, serial, ttl, type, dnssec_enabled, account_id FROM dns_zones WHERE domain = ? AND account_id = ?'),
    zoneById: db.prepare('SELECT id, domain, serial, ttl, type, dnssec_enabled, account_id FROM dns_zones WHERE id = ? AND account_id = ?'),
    record: db.prepare('SELECT id, type, name FROM dns_records WHERE id = ? AND zone_id = ?'),
    recordCount: db.prepare("SELECT COUNT(*) AS n FROM dns_records WHERE zone_id = ? AND type NOT IN ('SOA', 'NS')"),
    sync: db.prepare('SELECT s.status, s.serial, s.synced_at, c.name AS cluster FROM dns_zone_sync s JOIN dns_clusters c ON c.id = s.cluster_id WHERE s.zone_id = ? ORDER BY c.name'),
    accountIps: db.prepare("SELECT DISTINCT ip FROM accounts WHERE ip IS NOT NULL AND ip <> ''"),
  };
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const requireDns = () => { if (!ctx.dns) throw new HttpError(503, 'service_unavailable', 'The DNS category is not loaded'); return ctx.dns; };
  const setting = (key, fallback) => ctx.settings?.get?.(key, fallback) ?? fallback;

  // A zone name or any name inside one of the account's zones resolves to that
  // zone; a zone of another account (or none) is "not found", never "forbidden".
  function resolveZone(scope, name) {
    const direct = stmts.zone.get(name, scope.accountId);
    if (direct) return direct;
    const containing = ctx.dns?.zoneFor?.(name);
    const row = containing ? stmts.zoneById.get(containing.id, scope.accountId) : null;
    if (!row) throw notFound(`Zone "${name}"`);
    return row;
  }

  function shapeZone(z) {
    let sync = [];
    try { sync = stmts.sync.all(z.id); } catch { sync = []; }
    return { id: z.id, domain: z.domain, serial: z.serial, ttl: z.ttl, type: z.type, dnssecEnabled: Boolean(z.dnssec_enabled), updatedAt: z.updated_at ?? null, records: stmts.recordCount.get(z.id).n, sync };
  }

  const editable = (rec) => rec && !PROTECTED_TYPES.has(rec.type);

  function assertEditableRecord(zone, id) {
    const rec = stmts.record.get(id, zone.id);
    if (!rec) throw notFound('Record');
    if (!editable(rec)) throw new HttpError(422, 'protected_record', `${rec.type} records are managed by the server administrator`);
    return rec;
  }

  // ------------------------------------------------------------ delegation
  // Public DNS may live elsewhere (the live host's zones are at Cloudflare while
  // BIND answers only locally): a record written here is then not published.
  // The public NS set of the domain (or of the nearest parent that has one) is
  // read through the configured resolvers and compared with this host: a
  // nameserver counts as "here" when it resolves to one of this server's
  // addresses, or carries one of this server's own names and cannot be resolved.
  const delegationCache = new Map();
  let hostAddressCache = { at: 0, value: null };

  async function lookup(name, type) {
    const servers = setting('dns.resolvers', []);
    try {
      const r = await ctx.agent.op('dns.resolve', { name, type, servers: Array.isArray(servers) && servers.length ? servers : undefined, timeoutMs: LOOKUP_TIMEOUT_MS });
      return { answers: Array.isArray(r?.answers) ? r.answers.map((a) => String(a)) : [], error: r?.error ?? null };
    } catch (err) { return { answers: [], error: err.code || 'EFAIL' }; }
  }

  async function hostAddresses() {
    if (hostAddressCache.value && Date.now() - hostAddressCache.at < DELEGATION_TTL_MS) return hostAddressCache.value;
    const out = new Set([setting('basic.main_ip', ''), setting('basic.main_ipv6', '')].filter(Boolean));
    for (const r of stmts.accountIps.all()) out.add(r.ip);
    try {
      const info = await ctx.agent.op('sys.info');
      for (const i of info?.interfaces || []) for (const a of i.addresses || []) if (a.address && !(a.family === 'IPv4' && PRIVATE_V4.test(a.address))) out.add(a.address);
    } catch { /* agent unavailable: settings and account addresses decide */ }
    hostAddressCache = { at: Date.now(), value: out };
    return out;
  }

  async function computeDelegation(domain) {
    const labels = domain.split('.');
    let delegatedNs = [];
    let checkedDomain = null;
    let error = null;
    for (let i = 0; i <= labels.length - 2; i += 1) {
      const candidate = labels.slice(i).join('.');
      const r = await lookup(candidate, 'NS');
      if (r.answers.length) { delegatedNs = [...new Set(r.answers.map(normName))].filter(Boolean).sort(); checkedDomain = candidate; error = null; break; }
      error = r.error || 'ENODATA';
      if (!['ENODATA', 'ENOTFOUND', 'NODATA', 'NXDOMAIN'].includes(error)) break;
    }
    const checkedAt = new Date().toISOString();
    if (!delegatedNs.length) return { domain, checkedDomain, delegatedHere: null, delegatedNs: [], nameservers: [], checkedAt, error };
    const localNames = new Set([setting('basic.hostname', ''), ...(setting('basic.nameservers', []) || [])].map(normName).filter(Boolean));
    const addrs = await hostAddresses();
    const nameservers = await Promise.all(delegatedNs.slice(0, 4).map(async (host) => {
      const [a, aaaa] = await Promise.all([lookup(host, 'A'), lookup(host, 'AAAA')]);
      const addresses = [...a.answers, ...aaaa.answers];
      const here = addresses.some((ip) => addrs.has(ip)) || (!addresses.length && localNames.has(host));
      return { host, addresses, here };
    }));
    return { domain, checkedDomain, delegatedHere: nameservers.some((n) => n.here), delegatedNs, nameservers, checkedAt, error: null };
  }

  async function delegation(domain, { fresh = false } = {}) {
    const key = normName(domain);
    if (!key) return null;
    const hit = delegationCache.get(key);
    if (hit && !fresh && Date.now() < hit.expires) return hit.value;
    const value = await computeDelegation(key);
    delegationCache.set(key, { value, expires: Date.now() + (value.delegatedHere === null ? DELEGATION_ERROR_TTL_MS : DELEGATION_TTL_MS) });
    return value;
  }

  // Never lets a resolver problem fail a listing: null means "unknown".
  async function delegationOrNull(domain) {
    try { return await delegation(domain); } catch (err) { ctx.logger?.debug?.({ err, domain }, 'panel: delegation lookup failed'); return null; }
  }

  return {
    resolveZone,
    delegation,
    delegationOrNull,

    async zones(scope) {
      const rows = stmts.zones.all(scope.accountId).map(shapeZone);
      const zones = await Promise.all(rows.map(async (z) => ({ ...z, delegation: await delegationOrNull(z.domain) })));
      return { zones, types: PANEL_RECORD_TYPES };
    },

    async zone(scope, name) {
      const row = resolveZone(scope, name);
      const full = await requireDns().getZone(row.domain, scope.ownerPrincipal);
      const out = { ...full };
      delete out.soa;
      return { ...out, domain: row.domain, records: (full.records || []).filter((r) => !PROTECTED_TYPES.has(r.type)), types: PANEL_RECORD_TYPES, delegation: await delegationOrNull(row.domain) };
    },

    async addRecord(scope, name, input, req) {
      const row = resolveZone(scope, name);
      const result = await requireDns().addRecord(row.domain, input, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.dns.record.add', target: scope.username, args: auditArgs(scope, { zone: row.domain, name: input.name, type: input.type, value: input.value }) });
      return { ...result, delegation: await delegationOrNull(row.domain) };
    },

    async updateRecord(scope, name, id, input, req) {
      const row = resolveZone(scope, name);
      assertEditableRecord(row, id);
      const result = await requireDns().updateRecord(row.domain, id, input, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.dns.record.update', target: scope.username, args: auditArgs(scope, { zone: row.domain, id, ...input }) });
      return { ...result, delegation: await delegationOrNull(row.domain) };
    },

    async deleteRecord(scope, name, id, req) {
      const row = resolveZone(scope, name);
      const rec = assertEditableRecord(row, id);
      const result = await requireDns().deleteRecord(row.domain, id, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.dns.record.delete', target: scope.username, args: auditArgs(scope, { zone: row.domain, id, type: rec.type, name: rec.name }) });
      return { ...result, delegation: await delegationOrNull(row.domain) };
    },

    async emailStatus(scope, name) {
      const row = resolveZone(scope, name);
      return requireDns().emailStatus(row.domain, scope.ownerPrincipal);
    },
  };
}
