import { HttpError, notFound } from '../lib/errors.js';
import { auditArgs } from './panel-domains.js';

export const PANEL_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'];
const PROTECTED_TYPES = new Set(['NS', 'SOA']);

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
  };
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const requireDns = () => { if (!ctx.dns) throw new HttpError(503, 'service_unavailable', 'The DNS category is not loaded'); return ctx.dns; };

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

  return {
    resolveZone,

    zones(scope) {
      return { zones: stmts.zones.all(scope.accountId).map(shapeZone), types: PANEL_RECORD_TYPES };
    },

    async zone(scope, name) {
      const row = resolveZone(scope, name);
      const full = await requireDns().getZone(row.domain, scope.ownerPrincipal);
      const out = { ...full };
      delete out.soa;
      return { ...out, domain: row.domain, records: (full.records || []).filter((r) => !PROTECTED_TYPES.has(r.type)), types: PANEL_RECORD_TYPES };
    },

    async addRecord(scope, name, input, req) {
      const row = resolveZone(scope, name);
      const result = await requireDns().addRecord(row.domain, input, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.dns.record.add', target: scope.username, args: auditArgs(scope, { zone: row.domain, name: input.name, type: input.type, value: input.value }) });
      return result;
    },

    async updateRecord(scope, name, id, input, req) {
      const row = resolveZone(scope, name);
      assertEditableRecord(row, id);
      const result = await requireDns().updateRecord(row.domain, id, input, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.dns.record.update', target: scope.username, args: auditArgs(scope, { zone: row.domain, id, ...input }) });
      return result;
    },

    async deleteRecord(scope, name, id, req) {
      const row = resolveZone(scope, name);
      const rec = assertEditableRecord(row, id);
      const result = await requireDns().deleteRecord(row.domain, id, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.dns.record.delete', target: scope.username, args: auditArgs(scope, { zone: row.domain, id, type: rec.type, name: rec.name }) });
      return result;
    },

    async emailStatus(scope, name) {
      const row = resolveZone(scope, name);
      return requireDns().emailStatus(row.domain, scope.ownerPrincipal);
    },
  };
}
