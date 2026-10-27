import { HttpError, notFound } from '../../shared/errors.js';
import { newId, json, paginate } from '../../shared/db.js';

function monthRange(now) {
  const d = new Date(now);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  return { period_start: start.toISOString(), period_end: end.toISOString() };
}

// Monthly payouts (§18.5): paid minus clawed-back purchases per developer,
// held under the minimum or while the developer is not verified.
export function createPayoutsService(m) {
  const { db, cfg } = m;
  const stmts = {
    byId: db.prepare('SELECT * FROM payouts WHERE id = ?'),
    exists: db.prepare('SELECT id FROM payouts WHERE developer_id = ? AND period_start = ? AND period_end = ?'),
    insert: db.prepare(`INSERT INTO payouts (id, developer_id, period_start, period_end, gross_cents, refunds_cents, share_pct, net_cents, currency, status, hold_reason, statement_json, created_at)
      VALUES (@id, @developer_id, @period_start, @period_end, @gross_cents, @refunds_cents, @share_pct, @net_cents, @currency, @status, @hold_reason, @statement_json, @created_at)`),
    setStatus: db.prepare('UPDATE payouts SET status = @status, hold_reason = @hold_reason, provider_ref = COALESCE(@provider_ref, provider_ref), paid_at = COALESCE(@paid_at, paid_at) WHERE id = @id'),
    linkPurchases: db.prepare('UPDATE purchases SET payout_id = ? WHERE id = ?'),
  };
  const view = (p) => ({ ...p, statement: json.parse(p.statement_json, {}), statement_json: undefined });

  function transition(id, status, { by, ip, provider_ref = null, hold_reason = null } = {}) {
    const p = stmts.byId.get(id);
    if (!p) throw notFound('Payout');
    const allowed = { approved: ['pending', 'held'], paid: ['approved'], held: ['pending', 'approved'], failed: ['approved'] };
    if (!allowed[status]?.includes(p.status)) throw new HttpError(409, 'invalid_transition', `A ${p.status} payout cannot become ${status}`);
    stmts.setStatus.run({ id, status, hold_reason, provider_ref, paid_at: status === 'paid' ? m.nowIso() : null });
    m.audit({ principal: by, role: 'vendor', ip, action: `payout.${status}`, target: id, args: { provider_ref, hold_reason }, result: 'ok' });
    if (status === 'paid') {
      m.webhook(p.developer_id, 'payout.paid', { payout_id: id, net_cents: p.net_cents, currency: p.currency, provider_ref });
      const dev = m.developers.get(p.developer_id);
      m.mail(dev.email, 'dev.payout_paid', { display_name: dev.display_name, net_cents: p.net_cents, currency: p.currency, period_start: p.period_start, period_end: p.period_end });
    }
    return view(stmts.byId.get(id));
  }

  const svc = {
    view,
    close({ period_start, period_end } = {}, { by = 'system', ip = null } = {}) {
      const range = period_start && period_end ? { period_start, period_end } : monthRange(m.now());
      const paid = db.prepare("SELECT * FROM purchases WHERE status = 'paid' AND paid_at >= ? AND paid_at < ? AND payout_id IS NULL").all(range.period_start, range.period_end);
      const refunded = db.prepare("SELECT * FROM purchases WHERE status IN ('refunded', 'chargeback') AND refunded_at >= ? AND refunded_at < ?").all(range.period_start, range.period_end);
      const byDev = new Map();
      const bucket = (id) => byDev.get(id) || byDev.set(id, { gross: 0, refunds: 0, currency: 'USD', paid: [], refunded: [] }).get(id);
      for (const p of paid) { const b = bucket(p.developer_id); b.gross += p.developer_cents; b.currency = p.currency; b.paid.push(p.id); }
      for (const p of refunded) { const b = bucket(p.developer_id); b.refunds += p.developer_cents; b.refunded.push(p.id); }
      const created = [];
      for (const [developerId, b] of byDev) {
        if (stmts.exists.get(developerId, range.period_start, range.period_end)) continue;
        const dev = m.developers.get(developerId);
        const net = b.gross - b.refunds;
        const hold = dev.status !== 'verified' ? 'developer_not_verified' : net < cfg.payout_min_cents ? 'below_minimum' : null;
        const id = newId('pay', m.now());
        db.transaction(() => {
          stmts.insert.run({ id, developer_id: developerId, ...range, gross_cents: b.gross, refunds_cents: b.refunds, share_pct: dev.revenue_share_pct ?? cfg.revenue_share_pct, net_cents: net, currency: b.currency, status: hold ? 'held' : 'pending', hold_reason: hold, statement_json: JSON.stringify({ purchases: b.paid, refunds: b.refunded }), created_at: m.nowIso() });
          for (const pid of b.paid) stmts.linkPurchases.run(id, pid);
        })();
        m.webhook(developerId, 'payout.closed', { payout_id: id, net_cents: net, status: hold ? 'held' : 'pending' });
        created.push(view(stmts.byId.get(id)));
      }
      m.audit({ principal: by, role: 'vendor', ip, action: 'payout.close', target: null, args: { ...range, created: created.length }, result: 'ok' });
      return { ...range, payouts: created };
    },
    approve: (id, actor) => transition(id, 'approved', actor),
    markPaid: (id, { provider_ref, ...actor }) => transition(id, 'paid', { ...actor, provider_ref }),
    hold: (id, { reason, ...actor }) => transition(id, 'held', { ...actor, hold_reason: reason || 'manual' }),
    list(query = {}) {
      const where = []; const params = {};
      if (query.status) { where.push('status = @status'); params.status = query.status; }
      if (query.developer_id) { where.push('developer_id = @dev'); params.dev = query.developer_id; }
      const page = paginate(db, { from: 'payouts', where, params, sortable: { created_at: 'created_at', net_cents: 'net_cents' }, defaultSort: 'created_at', query: { dir: 'desc', ...query } });
      return { ...page, data: page.data.map(view) };
    },
    forDeveloper: (developerId) => db.prepare('SELECT * FROM payouts WHERE developer_id = ? ORDER BY period_start DESC').all(developerId).map(view),
    get(id, developerId = null) {
      const p = stmts.byId.get(id);
      if (!p || (developerId && p.developer_id !== developerId)) throw notFound('Payout');
      return view(p);
    },
    // The purchases a payout's statement lists (paid ones and the clawed-back refunds).
    statementRows(p) {
      return db.prepare('SELECT id, plugin_id, license_id, kind, amount_cents, tax_cents, currency, status, revenue_share_pct, developer_cents, paid_at, refunded_at FROM purchases WHERE id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)) ORDER BY paid_at').all(JSON.stringify(p.statement.purchases || []), JSON.stringify(p.statement.refunds || []));
    },
    // GET /v1/admin/market/payouts/:id: the row with its developer and purchases.
    statement(id) {
      const p = svc.get(id);
      const dev = m.developers.get(p.developer_id);
      return { ...p, developer_name: dev?.display_name ?? null, developer_email: dev?.email ?? null, purchases: svc.statementRows(p) };
    },
    statementCsv(id, developerId = null) {
      const p = svc.get(id, developerId);
      const rows = svc.statementRows(p);
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['purchase_id', 'plugin_id', 'kind', 'amount_cents', 'tax_cents', 'currency', 'status', 'share_pct', 'developer_cents', 'paid_at', 'refunded_at'];
      return [header.join(','), ...rows.map((r) => [r.id, r.plugin_id, r.kind, r.amount_cents, r.tax_cents, r.currency, r.status, r.revenue_share_pct, r.developer_cents, r.paid_at, r.refunded_at].map(esc).join(','))].join('\n') + '\n';
    },
  };
  return svc;
}
