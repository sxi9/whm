import { HttpError, notFound, unprocessable } from '../lib/errors.js';
import { constantTimeEqual } from '../lib/crypto.js';
import { accountPanelUrl } from '../middleware/shell.js';
import { auditArgs } from './panel-domains.js';
import { fields } from '../lib/validate.js';

export const DDNS_TYPES = ['A', 'AAAA'];
export const DDNS_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const DDNS_MAX_TOKENS = 20;

const nowIso = () => new Date().toISOString();

// Strips the "::ffff:" prefix Node puts on IPv4 peers of a dual-stack socket.
export const normalizeIp = (v) => {
  const s = String(v ?? '').trim();
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : s;
};

export const ipMatchesType = (ip, type) => (type === 'A' ? fields.ipv4.safeParse(ip).success : type === 'AAAA' ? fields.ipv6.safeParse(ip).success : false);

// Dynamic DNS (design §P2-8): a per-record token lets a router or a cron line
// move one A/AAAA record of the account's own zone to the caller's address
// without a session. Tokens are random, stored hashed, compared constant-time,
// never listed again after creation; the write goes through ctx.panelDns so
// the zone-editor rules (ownership, protected types, publish) apply unchanged.
export function createPanelDdnsService(ctx) {
  const { db, crypto, config } = ctx;
  const stmts = {
    list: db.prepare(`SELECT t.id, t.label, t.last_ip, t.last_used_at, t.updates, t.created_at, t.record_id, z.domain, r.name, r.type, r.value
      FROM panel_ddns_tokens t JOIN dns_zones z ON z.id = t.zone_id JOIN dns_records r ON r.id = t.record_id
      WHERE t.account_id = ? ORDER BY z.domain, r.name, t.id`),
    count: db.prepare('SELECT COUNT(*) AS n FROM panel_ddns_tokens WHERE account_id = ?'),
    byId: db.prepare('SELECT id, record_id FROM panel_ddns_tokens WHERE id = ? AND account_id = ?'),
    byHash: db.prepare(`SELECT t.id, t.token_hash, t.account_id, t.zone_id, t.record_id, z.domain, r.name, r.type, r.value, a.username, a.suspended, a.owner_id,
        u.username AS owner_username, u.role AS owner_role
      FROM panel_ddns_tokens t JOIN dns_zones z ON z.id = t.zone_id JOIN dns_records r ON r.id = t.record_id
      JOIN accounts a ON a.id = t.account_id LEFT JOIN users u ON u.id = a.owner_id WHERE t.token_hash = ?`),
    record: db.prepare('SELECT id, name, type, value FROM dns_records WHERE id = ? AND zone_id = ?'),
    candidates: db.prepare("SELECT id, name, type, value FROM dns_records WHERE zone_id = ? AND type IN ('A', 'AAAA') ORDER BY name, type"),
    insert: db.prepare('INSERT INTO panel_ddns_tokens (account_id, zone_id, record_id, label, token_hash) VALUES (?, ?, ?, ?, ?)'),
    remove: db.prepare('DELETE FROM panel_ddns_tokens WHERE id = ? AND account_id = ?'),
    touch: db.prepare('UPDATE panel_ddns_tokens SET last_ip = ?, last_used_at = ?, updates = updates + 1 WHERE id = ?'),
  };
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const panelDns = () => { if (!ctx.panelDns) throw new HttpError(503, 'service_unavailable', 'The DNS category is not loaded'); return ctx.panelDns; };
  const requireDns = () => { if (!ctx.dns) throw new HttpError(503, 'service_unavailable', 'The DNS category is not loaded'); return ctx.dns; };
  const baseUrl = () => `${accountPanelUrl(config, ctx.settings?.get?.('basic.hostname') || 'localhost')}/api/panel/dns/ddns`;
  const fqdn = (name, domain) => (name === '@' ? domain : `${name}.${domain}`);

  const shape = (r) => ({
    id: r.id, label: r.label ?? null, zone: r.domain, recordId: r.record_id, name: r.name, host: fqdn(r.name, r.domain), type: r.type, value: r.value,
    lastIp: r.last_ip ?? null, lastUsedAt: r.last_used_at ?? null, updates: r.updates ?? 0, createdAt: r.created_at ?? null,
  });

  return {
    baseUrl,

    // Tokens of the account plus, per zone, the A/AAAA records a token can be
    // minted for and the delegation (the page disables zones served elsewhere).
    async list(scope) {
      const tokens = stmts.list.all(scope.accountId).map(shape);
      const { zones } = await panelDns().zones(scope);
      const out = zones.map((z) => ({ domain: z.domain, delegation: z.delegation ?? null, records: stmts.candidates.all(z.id).map((r) => ({ ...r, host: fqdn(r.name, z.domain) })) }));
      return { tokens, zones: out, baseUrl: baseUrl(), max: DDNS_MAX_TOKENS };
    },

    async create(scope, { domain, recordId, label }, req) {
      const zone = panelDns().resolveZone(scope, domain);
      const rec = stmts.record.get(recordId, zone.id);
      if (!rec) throw notFound('Record');
      if (!DDNS_TYPES.includes(rec.type)) throw unprocessable('Dynamic DNS works on A and AAAA records only', { recordId: `${rec.type} records cannot be updated dynamically` });
      const delegation = await panelDns().delegationOrNull(zone.domain);
      if (delegation?.delegatedHere === false) throw new HttpError(422, 'not_delegated', `DNS for ${zone.domain} is managed elsewhere; a dynamic DNS update here would not be published`);
      if (stmts.count.get(scope.accountId).n >= DDNS_MAX_TOKENS) throw new HttpError(409, 'limit_reached', `At most ${DDNS_MAX_TOKENS} dynamic DNS tokens per account`);
      const token = crypto.randomToken(32);
      const id = Number(stmts.insert.run(scope.accountId, zone.id, rec.id, label || null, crypto.hashToken(token)).lastInsertRowid);
      audit(req, { action: 'panel.dns.ddns.create', target: scope.username, args: auditArgs(scope, { zone: zone.domain, record: fqdn(rec.name, zone.domain), type: rec.type, label: label || null }) });
      const row = stmts.list.all(scope.accountId).find((r) => r.id === id);
      // The plain token leaves the server exactly once, in this answer.
      return { token: shape(row), secret: token, url: `${baseUrl()}/${token}`, delegation };
    },

    revoke(scope, id, req) {
      const row = stmts.byId.get(id, scope.accountId);
      if (!row) throw notFound('Token');
      stmts.remove.run(id, scope.accountId);
      audit(req, { action: 'panel.dns.ddns.revoke', target: scope.username, args: auditArgs(scope, { id }) });
      return { revoked: true, id: Number(id) };
    },

    // The public call. A missing, revoked or malformed token is 404 either way;
    // the address comes from ?ip= or, absent that, from the caller's socket.
    async update(token, { ip } = {}, req) {
      const unknown = () => new HttpError(404, 'token_unknown', 'This dynamic DNS token is unknown or was revoked');
      if (!DDNS_TOKEN_RE.test(String(token ?? ''))) throw unknown();
      const hash = crypto.hashToken(token);
      const row = stmts.byHash.get(hash);
      if (!row || !constantTimeEqual(row.token_hash, hash)) throw unknown();
      if (row.suspended) throw new HttpError(423, 'account_suspended', 'This account is suspended');
      const address = normalizeIp(ip ?? req?.ip);
      if (!ipMatchesType(address, row.type)) {
        throw unprocessable(`Not a valid ${row.type === 'A' ? 'IPv4' : 'IPv6'} address for an ${row.type} record`, { ip: `Must be an ${row.type === 'A' ? 'IPv4' : 'IPv6'} address` });
      }
      const owner = row.owner_username ? { id: row.owner_id, username: row.owner_username, role: row.owner_role } : { id: row.owner_id, username: null, role: 'reseller' };
      const host = fqdn(row.name, row.domain);
      let result = { changed: false, serial: null, applied: null };
      if (row.value !== address) {
        const r = await requireDns().updateRecord(row.domain, row.record_id, { value: address }, owner, req);
        result = { changed: true, serial: r.serial ?? null, applied: r.applied ?? null };
      }
      stmts.touch.run(address, nowIso(), row.id);
      audit(req, { action: 'panel.dns.ddns.update', target: row.username, args: { zone: row.domain, record: host, type: row.type, ip: address, changed: result.changed, from: req?.ip ?? null } });
      return { zone: row.domain, host, type: row.type, ip: address, ...result };
    },
  };
}
