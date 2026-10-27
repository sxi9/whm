import { HttpError, notFound } from '../../shared/errors.js';
import { newId, json, paginate } from '../../shared/db.js';

const DAY_MS = 86_400_000;

// Paid plugins are entitlements on a panel license (§18.5): per license,
// following transfers; one trial per license per plugin.
export function createEntitlementsService(m) {
  const { ctx, db } = m;
  const stmts = {
    active: db.prepare("SELECT * FROM entitlements WHERE license_id = ? AND plugin_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1"),
    any: db.prepare('SELECT * FROM entitlements WHERE license_id = ? AND plugin_id = ? ORDER BY created_at DESC LIMIT 1'),
    trial: db.prepare("SELECT 1 FROM entitlements WHERE license_id = ? AND plugin_id = ? AND kind = 'trial'"),
    insert: db.prepare(`INSERT INTO entitlements (id, license_id, customer_id, plugin_id, kind, status, starts_at, expires_at, purchase_id, source, created_at, updated_at)
      VALUES (@id, @license_id, @customer_id, @plugin_id, @kind, 'active', @starts_at, @expires_at, @purchase_id, @source, @now, @now)`),
    byId: db.prepare('SELECT * FROM entitlements WHERE id = ?'),
    setStatus: db.prepare('UPDATE entitlements SET status = ?, updated_at = ? WHERE id = ?'),
    byPurchase: db.prepare('SELECT id FROM entitlements WHERE purchase_id = ?'),
    expire: db.prepare("UPDATE entitlements SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?"),
  };

  const svc = {
    check(license, plugin) {
      const pricing = json.parse(plugin.pricing_json, { model: 'free' });
      if (pricing.model === 'free') return { ok: true, kind: 'free', status: 'active' };
      if (json.parse(plugin.bundled_editions_json, []).includes(license.edition)) return { ok: true, kind: 'one_time', status: 'active', source: 'admin' };
      const row = stmts.active.get(license.id, plugin.id, m.nowIso());
      if (row) return { ok: true, kind: row.kind, status: row.status, id: row.id };
      const last = stmts.any.get(license.id, plugin.id);
      return { ok: false, kind: last?.kind || null, status: last?.status || null };
    },
    grant({ license_id, plugin_id, kind, source, expires_at = null, customer_id = null, purchase_id = null }, { by = 'system', ip = null } = {}) {
      const license = ctx.licenses.getRaw(license_id);
      if (!license) throw notFound('License');
      m.submissions.get(plugin_id);
      const id = newId('ent', m.now());
      stmts.insert.run({ id, license_id, customer_id: customer_id || license.customer_id, plugin_id, kind, starts_at: m.nowIso(), expires_at, purchase_id, source, now: m.nowIso() });
      m.audit({ principal: by, role: by.startsWith('billing:') ? 'billing' : 'vendor', ip, action: 'entitlement.grant', target: id, args: { license_id, plugin_id, kind, source, expires_at }, result: 'ok' });
      return stmts.byId.get(id);
    },
    cancel(id, { by, ip, status = 'cancelled' } = {}) {
      const row = stmts.byId.get(id);
      if (!row) throw notFound('Entitlement');
      stmts.setStatus.run(status, m.nowIso(), id);
      m.audit({ principal: by, role: 'vendor', ip, action: `entitlement.${status}`, target: id, args: null, result: 'ok' });
      return stmts.byId.get(id);
    },
    refundPurchase(purchaseId, { by, ip } = {}) {
      for (const e of stmts.byPurchase.all(purchaseId)) stmts.setStatus.run('refunded', m.nowIso(), e.id);
      m.audit({ principal: by, role: 'billing', ip, action: 'entitlement.refunded', target: purchaseId, args: null, result: 'ok' });
    },
    startTrial(license, plugin, { by = 'system' } = {}) {
      const pricing = json.parse(plugin.pricing_json, {});
      if (pricing.model !== 'subscription' || !pricing.trial_days) throw new HttpError(422, 'no_trial', 'This plugin has no trial');
      if (stmts.trial.get(license.id, plugin.id)) throw new HttpError(409, 'trial_exists', 'A trial entitlement was already used on this license');
      return svc.grant({ license_id: license.id, plugin_id: plugin.id, kind: 'trial', source: 'trial', expires_at: m.nowIso(m.now() + pricing.trial_days * DAY_MS) }, { by });
    },
    list(query = {}) {
      const where = []; const params = {};
      if (query.license_prefix) {
        const ids = ctx.licenses.findByPrefix(query.license_prefix).map((l) => l.id);
        where.push(`license_id IN (${ids.map((_, i) => `@l${i}`).join(',') || "''"})`);
        ids.forEach((id, i) => { params[`l${i}`] = id; });
      }
      if (query.plugin_id) { where.push('plugin_id = @plugin'); params.plugin = query.plugin_id; }
      if (query.status) { where.push('status = @status'); params.status = query.status; }
      return paginate(db, { from: 'entitlements', where, params, sortable: { created_at: 'created_at', expires_at: 'expires_at' }, defaultSort: 'created_at', query: { dir: 'desc', ...query } });
    },
    expireDue: () => ({ expired: stmts.expire.run(m.nowIso(), m.nowIso()).changes }),
  };
  return svc;
}
