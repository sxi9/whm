import crypto from 'node:crypto';
import { HttpError } from '../../shared/errors.js';
import { newId, nowIso, paginate } from '../../shared/db.js';

export const SOURCES = ['stripe', 'whmcs', 'paddle'];

// Maps every provider's events onto the three license actions; `suspend`
// takes effect after the paid term's grace period (§16.7).
const ACTIONS = {
  stripe: { 'invoice.paid': 'renew', 'invoice.payment_succeeded': 'renew', 'customer.subscription.deleted': 'suspend', 'charge.refunded': 'revoke', 'charge.dispute.created': 'revoke' },
  whmcs: { InvoicePaid: 'renew', InvoiceCancelled: 'suspend', InvoiceRefunded: 'revoke', Chargeback: 'revoke' },
  paddle: { 'subscription.payment_succeeded': 'renew', 'transaction.completed': 'renew', 'subscription.canceled': 'suspend', 'subscription.deleted': 'suspend', 'transaction.refunded': 'revoke', 'adjustment.created': 'revoke' },
};

function timingEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Provider signature schemes over the raw body.
export function verifyProviderSignature(source, rawBody, headers, secret, { now = Math.floor(Date.now() / 1000), toleranceS = 300 } = {}) {
  if (!secret) return false;
  const h = (name) => headers[name] ?? headers[name.toLowerCase()];
  if (source === 'stripe') {
    const m = /t=(\d+),v1=([0-9a-f]{64})/.exec(String(h('stripe-signature') || ''));
    if (!m || Math.abs(now - Number(m[1])) > toleranceS) return false;
    return timingEqual(crypto.createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest('hex'), m[2]);
  }
  if (source === 'whmcs') {
    const sig = String(h('x-whmcs-signature') || '');
    return /^[0-9a-f]{64}$/.test(sig) && timingEqual(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), sig);
  }
  if (source === 'paddle') {
    const m = /ts=(\d+);h1=([0-9a-f]{64})/.exec(String(h('paddle-signature') || ''));
    if (!m || Math.abs(now - Number(m[1])) > toleranceS) return false;
    return timingEqual(crypto.createHmac('sha256', secret).update(`${m[1]}:${rawBody}`).digest('hex'), m[2]);
  }
  return false;
}

// Normalises a provider payload into { external_id, event_type, external_ref, meta, term_months }.
export function normalizeEvent(source, payload) {
  const str = (v) => (v == null ? null : String(v));
  if (source === 'stripe') {
    const obj = payload?.data?.object || {};
    const meta = { ...(obj.metadata || {}), ...(payload?.data?.object?.subscription_details?.metadata || {}) };
    return { external_id: str(payload?.id), event_type: str(payload?.type), external_ref: str(meta.whm_external_ref || obj.subscription || obj.customer), meta, term_months: meta.whm_term_months ? Number(meta.whm_term_months) : null };
  }
  if (source === 'whmcs') {
    const meta = { ...(payload?.custom || payload?.metadata || {}) };
    return { external_id: str(payload?.id || payload?.event_id || (payload?.invoiceid != null ? `${payload.event}:${payload.invoiceid}` : null)), event_type: str(payload?.event), external_ref: str(meta.whm_external_ref || (payload?.serviceid != null ? `whmcs:${payload.serviceid}` : null)), meta, term_months: meta.whm_term_months ? Number(meta.whm_term_months) : null };
  }
  if (source === 'paddle') {
    const d = payload?.data || {};
    const meta = { ...(d.custom_data || d.passthrough || {}) };
    return { external_id: str(payload?.event_id || payload?.notification_id), event_type: str(payload?.event_type), external_ref: str(meta.whm_external_ref || d.subscription_id || d.id), meta, term_months: meta.whm_term_months ? Number(meta.whm_term_months) : null };
  }
  throw new HttpError(404, 'unknown_source', `Unknown billing source "${source}"`);
}

export function createBillingService(ctx) {
  const db = ctx.dbs.license;
  const now = () => ctx.clock.now();
  const stmts = {
    byExternal: db.prepare('SELECT * FROM billing_events WHERE external_id = ?'),
    insert: db.prepare('INSERT INTO billing_events (id, source, event_type, external_id, payload_json, processed_at, result) VALUES (@id, @source, @event_type, @external_id, @payload_json, @processed_at, @result)'),
  };

  function applyLicenseAction(source, ev) {
    const action = ACTIONS[source]?.[ev.event_type];
    if (!action) return { result: 'ignored:unknown_event' };
    if (!ev.external_ref) return { result: 'ignored:no_external_ref' };
    const licenses = ctx.licenses.findByExternalRef(ev.external_ref);
    if (!licenses.length) return { result: 'ignored:no_license', action };
    const actor = { principal: `billing:${source}`, ip: null };
    const ids = [];
    for (const lic of licenses) {
      if (action === 'renew') {
        const months = ev.term_months || (lic.term === 'monthly' ? 1 : 12);
        if (lic.status === 'revoked') continue;
        ctx.licenses.renew(lic.id, { term_months: months }, { actor });
      } else if (action === 'suspend') {
        if (lic.status === 'active' || lic.status === 'expired') ctx.licenses.scheduleSuspension(lic.id, { reason: `${source}:${ev.event_type}` }, { actor });
      } else if (action === 'revoke') {
        if (lic.status !== 'revoked') ctx.licenses.revoke(lic.id, { reason: `${source}:${ev.event_type}` }, { actor });
      }
      ids.push(lic.id);
    }
    return { result: `${action}:${ids.join(',')}`, action, license_ids: ids };
  }

  return {
    SOURCES,
    verifySignature: (source, rawBody, headers) => verifyProviderSignature(source, rawBody, headers, ctx.config.license.billing?.[source]?.secret, { now: Math.floor(now() / 1000) }),
    // Idempotent on external_id. The license handler only processes events
    // whose metadata.whm_kind is 'license' or absent; everything else goes to
    // the billing hooks (the marketplace handles plugin_purchase).
    handle(source, payload) {
      if (!SOURCES.includes(source)) throw new HttpError(404, 'unknown_source', `Unknown billing source "${source}"`);
      const ev = normalizeEvent(source, payload);
      if (!ev.external_id || !ev.event_type) throw new HttpError(422, 'validation_failed', 'Billing event has no id or type');
      const existing = stmts.byExternal.get(ev.external_id);
      if (existing) return { duplicate: true, external_id: ev.external_id, result: existing.result };
      const kind = ev.meta?.whm_kind ?? null;
      let outcome;
      if (kind == null || kind === 'license') {
        try { outcome = applyLicenseAction(source, ev); } catch (err) { outcome = { result: `error:${err.code || err.message}` }; }
      } else {
        outcome = { result: `skipped:${kind}` };
      }
      const hookResults = [];
      for (const fn of ctx.hooks.billing) {
        try { hookResults.push(fn(source, { ...ev, payload }, ev.meta)); } catch (err) { ctx.logger.error({ err, source }, 'billing hook failed'); hookResults.push({ error: err.code || err.message }); }
      }
      stmts.insert.run({ id: newId('bev', now()), source, event_type: ev.event_type, external_id: ev.external_id, payload_json: JSON.stringify(payload).slice(0, 200_000), processed_at: nowIso(now()), result: outcome.result });
      ctx.audit.record({ principal: `billing:${source}`, ip: null, action: 'billing.event', target: ev.external_id, args: { event_type: ev.event_type, external_ref: ev.external_ref, whm_kind: kind }, result: outcome.result });
      return { duplicate: false, external_id: ev.external_id, event_type: ev.event_type, whm_kind: kind, ...outcome, hooks: hookResults.length };
    },
    list: (query = {}) => paginate(db, { select: 'id, source, event_type, external_id, processed_at, result', from: 'billing_events', where: query.source ? ['source = @source'] : [], params: { source: query.source }, sortable: { processed_at: 'processed_at' }, defaultSort: 'processed_at', query: { dir: 'desc', ...query } }),
  };
}
