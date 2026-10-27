import { HttpError, notFound } from '../../shared/errors.js';
import { newId, json, paginate } from '../../shared/db.js';

const PAID = { stripe: ['invoice.paid', 'invoice.payment_succeeded', 'checkout.session.completed'], whmcs: ['InvoicePaid'], paddle: ['transaction.completed', 'subscription.payment_succeeded'] };
const REFUND = { stripe: { 'charge.refunded': 'refunded', 'charge.dispute.created': 'chargeback' }, whmcs: { InvoiceRefunded: 'refunded', Chargeback: 'chargeback' }, paddle: { 'transaction.refunded': 'refunded', 'adjustment.created': 'chargeback' } };
const MAGIC_TTL_MS = 15 * 60_000;

function amountOf(source, payload) {
  if (source === 'stripe') { const o = payload?.data?.object || {}; return { cents: Number(o.amount_paid ?? o.amount_total ?? o.amount ?? 0), currency: String(o.currency || 'usd').toUpperCase(), tax: Number(o.tax ?? o.total_details?.amount_tax ?? 0) }; }
  if (source === 'whmcs') return { cents: Math.round(Number(payload?.amount || 0) * 100), currency: String(payload?.currency || 'USD').toUpperCase(), tax: Math.round(Number(payload?.tax || 0) * 100) };
  const d = payload?.data || {};
  return { cents: Number(d.details?.totals?.total ?? d.amount ?? 0), currency: String(d.currency_code || d.currency || 'USD').toUpperCase(), tax: Number(d.details?.totals?.tax ?? 0) };
}

// Monetisation (§18.5): the billing hook handles whm_kind = plugin_purchase
// events only, idempotent on external_id; purchases freeze the revenue share;
// magic links are single-use, 15 minutes, bound to the customer e-mail.
export function createMarketBillingService(m) {
  const { ctx, db, cfg } = m;
  const stmts = {
    byExternal: db.prepare('SELECT * FROM purchases WHERE external_id = ?'),
    byId: db.prepare('SELECT * FROM purchases WHERE id = ?'),
    insert: db.prepare(`INSERT INTO purchases (id, customer_id, license_id, plugin_id, developer_id, kind, amount_cents, currency, tax_cents, provider, external_id, status, revenue_share_pct, developer_cents, vendor_cents, paid_at)
      VALUES (@id, @customer_id, @license_id, @plugin_id, @developer_id, @kind, @amount_cents, @currency, @tax_cents, @provider, @external_id, 'paid', @revenue_share_pct, @developer_cents, @vendor_cents, @paid_at)`),
    refund: db.prepare('UPDATE purchases SET status = ?, refunded_at = ? WHERE id = ? AND status = \'paid\''),
    insertMagic: db.prepare('INSERT INTO customer_magic_links (token_hash, customer_id, email, plugin_id, license_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    magic: db.prepare('SELECT * FROM customer_magic_links WHERE token_hash = ?'),
    useMagic: db.prepare('UPDATE customer_magic_links SET used_at = ?, ip_hash = ? WHERE token_hash = ? AND used_at IS NULL'),
  };

  function recordPurchase(source, ev, plugin, license, { cents, currency, tax }) {
    const dev = m.developers.get(plugin.developer_id);
    const pct = dev.revenue_share_pct ?? cfg.revenue_share_pct;
    const pricing = json.parse(plugin.pricing_json, {});
    const developerCents = Math.floor((cents - tax) * pct / 100);
    const id = newId('pur', m.now());
    stmts.insert.run({ id, customer_id: license.customer_id, license_id: license.id, plugin_id: plugin.id, developer_id: dev.id, kind: pricing.model === 'subscription' ? 'subscription' : 'one_time', amount_cents: cents, currency, tax_cents: tax, provider: source, external_id: ev.external_id, revenue_share_pct: pct, developer_cents: developerCents, vendor_cents: cents - tax - developerCents, paid_at: m.nowIso() });
    const expires = pricing.model === 'subscription' ? m.nowIso(m.now() + (pricing.interval === 'year' ? 365 : 30) * 86_400_000 + 3 * 86_400_000) : null;
    const ent = m.entitlements.grant({ license_id: license.id, plugin_id: plugin.id, kind: pricing.model === 'subscription' ? 'subscription' : 'one_time', source: 'checkout', expires_at: expires, purchase_id: id, customer_id: license.customer_id }, { by: `billing:${source}` });
    m.webhook(dev.id, 'purchase.completed', { purchase_id: id, plugin_id: plugin.id, amount_cents: cents, currency, developer_cents: developerCents });
    ctx.metrics?.inc('market_purchases_total', { provider: source });
    return { result: 'purchase', purchase_id: id, entitlement_id: ent.id };
  }

  function chargebackGuard(developerId) {
    const r = db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'chargeback' THEN 1 ELSE 0 END) AS cb FROM purchases WHERE developer_id = ?").get(developerId);
    if (r.n >= 10 && r.cb / r.n > 0.02) {
      const n = db.prepare("UPDATE plugins SET status = 'unlisted', updated_at = ? WHERE developer_id = ? AND status = 'listed' AND json_extract(pricing_json, '$.model') != 'free'").run(m.nowIso(), developerId).changes;
      if (n) m.audit({ principal: 'system', role: 'system', ip: null, action: 'developer.paid_listings_suspended', target: developerId, args: { chargebacks: r.cb, purchases: r.n }, result: 'ok' });
    }
  }

  const svc = {
    // ctx.hooks.billing: fn(source, event, meta) after the license handler.
    hook(source, ev, meta) {
      if (meta?.whm_kind !== 'plugin_purchase') return { skipped: meta?.whm_kind || 'license' };
      const pluginId = meta.whm_plugin_id;
      const plugin = pluginId ? db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId) : null;
      if (!plugin) return { result: 'ignored:no_plugin' };
      const refundStatus = REFUND[source]?.[ev.event_type];
      if (refundStatus) {
        const target = meta.whm_purchase_external_id ? stmts.byExternal.get(meta.whm_purchase_external_id) : db.prepare("SELECT * FROM purchases WHERE plugin_id = ? AND license_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 1").get(plugin.id, meta.whm_license_id || '');
        if (!target) return { result: 'ignored:no_purchase' };
        return svc.refund(target.id, { status: refundStatus, by: `billing:${source}` });
      }
      if (!PAID[source]?.includes(ev.event_type)) return { result: 'ignored:unknown_event' };
      if (stmts.byExternal.get(ev.external_id)) return { result: 'duplicate', duplicate: true };
      const license = meta.whm_license_id ? ctx.licenses.getRaw(meta.whm_license_id) : null;
      if (!license) return { result: 'ignored:no_license' };
      return recordPurchase(source, ev, plugin, license, amountOf(source, ev.payload));
    },
    refund(id, { status = 'refunded', by = 'vendor', ip = null } = {}) {
      const p = stmts.byId.get(id);
      if (!p) throw notFound('Purchase');
      if (!stmts.refund.run(status, m.nowIso(), id).changes) return { result: `already:${p.status}`, purchase_id: id };
      m.entitlements.refundPurchase(id, { by, ip });
      m.audit({ principal: by, role: by.startsWith('billing:') ? 'billing' : 'vendor', ip, action: `purchase.${status}`, target: id, args: { plugin_id: p.plugin_id, license_id: p.license_id }, result: 'ok' });
      m.webhook(p.developer_id, 'purchase.refunded', { purchase_id: id, plugin_id: p.plugin_id, status });
      if (status === 'chargeback') { m.state.set(`abuse:${p.customer_id}`, (m.state.get(`abuse:${p.customer_id}`) || 0) + 1); chargebackGuard(p.developer_id); }
      return { result: status, purchase_id: id };
    },
    buyUrl: (plugin, license) => `${ctx.config.public_url}/buy/${encodeURIComponent(plugin.id)}?license=${encodeURIComponent(license.id)}`,
    listPurchases(query = {}) {
      const where = []; const params = {};
      if (query.plugin_id) { where.push('plugin_id = @plugin'); params.plugin = query.plugin_id; }
      if (query.developer_id) { where.push('developer_id = @dev'); params.dev = query.developer_id; }
      if (query.status) { where.push('status = @status'); params.status = query.status; }
      if (query.license_prefix) {
        const ids = ctx.licenses.findByPrefix(query.license_prefix).map((l) => l.id);
        where.push(`license_id IN (${ids.map((_, i) => `@l${i}`).join(',') || "''"})`);
        ids.forEach((lid, i) => { params[`l${i}`] = lid; });
      }
      return paginate(db, { from: 'purchases', where, params, sortable: { paid_at: 'paid_at', amount_cents: 'amount_cents' }, defaultSort: 'paid_at', query: { dir: 'desc', ...query } });
    },
    // Magic link for the checkout portal: hashed token, single use, 15 min, e-mail bound.
    issueMagicLink({ customer_id, plugin_id = null, license_id = null }, { ip } = {}) {
      const customer = ctx.customers.get(customer_id);
      const token = ctx.crypto.randomToken(32);
      stmts.insertMagic.run(ctx.crypto.hashToken(token), customer.id, customer.email, plugin_id, license_id, m.nowIso(m.now() + MAGIC_TTL_MS), m.nowIso());
      m.mail(customer.email, 'customer.magic_link', { name: customer.name, link: `${ctx.config.public_url}/buy/magic/${token}`, plugin_id });
      m.audit({ principal: `customer:${customer.id}`, role: 'customer', ip, action: 'magic_link.issue', target: customer.id, args: { plugin_id }, result: 'ok' });
      return { accepted: true, expires_in_s: MAGIC_TTL_MS / 1000, _token: token };
    },
    consumeMagicLink(token, { email, ip } = {}) {
      const row = stmts.magic.get(ctx.crypto.hashToken(String(token)));
      if (!row || row.used_at || new Date(row.expires_at).getTime() < m.now()) throw new HttpError(410, 'magic_link_invalid', 'The link is invalid, used or expired');
      if (String(email || '').toLowerCase() !== row.email) throw new HttpError(403, 'magic_link_email_mismatch', 'The link was sent to a different address');
      if (!stmts.useMagic.run(m.nowIso(), m.hashIp(ip), row.token_hash).changes) throw new HttpError(410, 'magic_link_invalid', 'The link was already used');
      m.audit({ principal: `customer:${row.customer_id}`, role: 'customer', ip, action: 'magic_link.consume', target: row.customer_id, args: null, result: 'ok' });
      return { customer_id: row.customer_id, plugin_id: row.plugin_id, license_id: row.license_id };
    },
    // Reseller grants inside the plugin-level wholesale price (resellers.pricing_json.plugins).
    resellerGrant(resellerId, { license_id, plugin_id, expires_at = null }, { by, ip } = {}) {
      const license = ctx.licenses.getRaw(license_id);
      if (!license || license.reseller_id !== resellerId) throw new HttpError(403, 'not_owned', 'That license belongs to another reseller');
      const reseller = ctx.resellers.get(resellerId);
      const plugin = m.submissions.get(plugin_id);
      const wholesale = reseller.pricing?.plugins?.[plugin_id];
      if (wholesale == null) throw new HttpError(403, 'no_wholesale_price', 'No wholesale price is set for this plugin');
      const pricing = json.parse(plugin.pricing_json, {});
      return m.entitlements.grant({ license_id, plugin_id, kind: pricing.model === 'subscription' ? 'subscription' : 'one_time', source: 'reseller', expires_at }, { by, ip });
    },
  };
  return svc;
}
