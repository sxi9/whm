import { HttpError, notFound, conflict } from '../../shared/errors.js';
import { json, newId, paginate, nowIso } from '../../shared/db.js';
import { EDITIONS } from './products.js';

export function createResellersService(ctx) {
  const db = ctx.dbs.license;
  const stmts = {
    byId: db.prepare('SELECT * FROM resellers WHERE id = ?'),
    byEmail: db.prepare('SELECT * FROM resellers WHERE email = ?'),
    insert: db.prepare(`INSERT INTO resellers (id, name, email, portal_user_id, status, quota_json, pricing_json, issued_json, brand_json, created_at, updated_at)
      VALUES (@id, @name, @email, NULL, 'active', @quota_json, @pricing_json, '{}', @brand_json, @now, @now)`),
    update: db.prepare('UPDATE resellers SET name = @name, status = @status, brand_json = @brand_json, updated_at = @now WHERE id = @id'),
    setQuota: db.prepare('UPDATE resellers SET quota_json = @quota_json, pricing_json = @pricing_json, updated_at = @now WHERE id = @id'),
    setIssued: db.prepare('UPDATE resellers SET issued_json = @issued_json, updated_at = @now WHERE id = @id'),
    portalUsers: db.prepare('SELECT id FROM portal_users WHERE reseller_id = ?'),
    statement: db.prepare(`SELECT l.id, l.key_prefix, l.edition, l.term, l.issued_at, l.status, l.customer_id, substr(l.issued_at, 1, 7) AS month
      FROM licenses l WHERE l.reseller_id = ? ORDER BY l.issued_at`),
  };

  function shape(row) {
    if (!row) return null;
    return { ...row, quota: json.parse(row.quota_json, {}), pricing: json.parse(row.pricing_json, {}), issued: json.parse(row.issued_json, {}), brand: json.parse(row.brand_json, {}), quota_json: undefined, pricing_json: undefined, issued_json: undefined, brand_json: undefined };
  }

  const svc = {
    get(id) {
      const row = shape(stmts.byId.get(id));
      if (!row) throw notFound('Reseller');
      return row;
    },
    list(query = {}) {
      const where = [];
      const params = {};
      if (query.q) { where.push('(email LIKE @q OR name LIKE @q)'); params.q = `%${query.q}%`; }
      const page = paginate(db, { from: 'resellers', where, params, sortable: { created_at: 'created_at', name: 'name' }, defaultSort: 'created_at', query });
      return { ...page, data: page.data.map(shape) };
    },
    create(input) {
      const email = String(input.email).toLowerCase();
      if (stmts.byEmail.get(email)) throw conflict('A reseller with that e-mail already exists', 'reseller_exists');
      const id = newId('rsl', ctx.clock.now());
      stmts.insert.run({ id, name: input.name, email, quota_json: JSON.stringify(input.quota || {}), pricing_json: JSON.stringify(input.pricing || {}), brand_json: JSON.stringify(input.brand || {}), now: nowIso(ctx.clock.now()) });
      return svc.get(id);
    },
    update(id, patch) {
      const row = svc.get(id);
      stmts.update.run({ id, name: patch.name ?? row.name, status: patch.status ?? row.status, brand_json: JSON.stringify(patch.brand ?? row.brand), now: nowIso(ctx.clock.now()) });
      if (patch.status && patch.status !== 'active' && patch.status !== row.status) {
        for (const u of stmts.portalUsers.all(id)) ctx.portalSessionStore?.destroyUserSessions(u.id);
        ctx.audit.record({ principal: 'system', ip: null, action: `reseller.${patch.status}`, target: id, args: null, result: 'ok' });
      }
      return svc.get(id);
    },
    // Suspended or closed resellers lose the API, the portal and issuance.
    assertActive(id) {
      const row = svc.get(id);
      if (row.status !== 'active') throw new HttpError(403, 'reseller_suspended', `This reseller account is ${row.status}`);
      return row;
    },
    setQuota(id, { quota, pricing }) {
      const row = svc.get(id);
      stmts.setQuota.run({ id, quota_json: JSON.stringify(quota ?? row.quota), pricing_json: JSON.stringify(pricing ?? row.pricing), now: nowIso(ctx.clock.now()) });
      return svc.get(id);
    },
    // quota_json: { solo: 100, pro: 50, trial: -1 }; -1 = unlimited; missing = 0.
    quotaLeft(id) {
      const r = svc.get(id);
      const out = {};
      for (const ed of EDITIONS) {
        const q = Number.isInteger(r.quota[ed]) ? r.quota[ed] : 0;
        out[ed] = q < 0 ? -1 : Math.max(0, q - (r.issued[ed] || 0));
      }
      return out;
    },
    assertQuota(id, edition, count = 1) {
      const left = svc.quotaLeft(id)[edition];
      if (left !== -1 && left < count) {
        throw Object.assign(new HttpError(409, 'quota_exceeded', `Your quota for ${edition} licenses is exhausted (${left} left, ${count} requested)`), { extra: { quota_left: svc.quotaLeft(id) } });
      }
    },
    consume(id, edition, count = 1) {
      const r = svc.get(id);
      const issued = { ...r.issued, [edition]: (r.issued[edition] || 0) + count };
      stmts.setIssued.run({ id, issued_json: JSON.stringify(issued), now: nowIso(ctx.clock.now()) });
      return svc.quotaLeft(id);
    },
    // Wholesale statement: every issued license priced from pricing_json[edition][term].
    statement(id) {
      const r = svc.get(id);
      const rows = stmts.statement.all(id).map((l) => {
        const termKey = l.term === 'days' ? 'trial' : l.term;
        const cents = Number(r.pricing?.[l.edition]?.[termKey] ?? 0);
        return { ...l, wholesale_cents: cents };
      });
      const months = {};
      for (const row of rows) {
        months[row.month] ||= { month: row.month, licenses: 0, wholesale_cents: 0 };
        months[row.month].licenses++;
        months[row.month].wholesale_cents += row.wholesale_cents;
      }
      return { reseller_id: id, currency: 'USD', total_cents: rows.reduce((s, x) => s + x.wholesale_cents, 0), months: Object.values(months), lines: rows };
    },
    // Reseller catalog (GET /v1/reseller/products): the active products of
    // every edition this tenant may issue (quota -1 = unlimited, > 0 = capped,
    // missing or 0 = never), priced from its own wholesale pricing_json
    // (null when the vendor has not set a price for that edition/term).
    products(id) {
      const r = svc.get(id);
      const issuable = (edition) => { const q = r.quota?.[edition]; return q === -1 || (Number.isInteger(q) && q > 0); };
      return ctx.products.list().filter((p) => p.active && issuable(p.edition)).map((p) => {
        const termKey = p.term === 'days' ? 'trial' : p.term;
        const wholesale = r.pricing?.[p.edition]?.[termKey];
        return { sku: p.sku, name: p.name, edition: p.edition, rank: p.rank, term: p.term, term_days: p.term_days, limits: p.limits, features: p.features, active: true, price_cents: Number.isInteger(wholesale) ? wholesale : null, currency: p.currency };
      });
    },
    // { resellerId } for reseller principals, null for the vendor.
    scopeOf(principal) {
      return principal?.ownerType === 'reseller' ? { resellerId: principal.ownerId } : null;
    },
  };
  return svc;
}
