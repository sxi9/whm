import { notFound, conflict, forbidden } from '../../shared/errors.js';
import { newId, paginate, nowIso } from '../../shared/db.js';

export function createCustomersService(ctx) {
  const db = ctx.dbs.license;
  const stmts = {
    byId: db.prepare('SELECT * FROM customers WHERE id = ?'),
    byEmail: db.prepare('SELECT * FROM customers WHERE email = ?'),
    insert: db.prepare(`INSERT INTO customers (id, reseller_id, name, email, company, country, external_ref, status, created_at, updated_at)
      VALUES (@id, @reseller_id, @name, @email, @company, @country, @external_ref, 'active', @now, @now)`),
    update: db.prepare(`UPDATE customers SET name = @name, company = @company, country = @country, external_ref = @external_ref, status = @status, updated_at = @now WHERE id = @id`),
  };

  // Resellers see only their own rows; `scope` is { resellerId } or null (vendor).
  function assertScope(row, scope) {
    if (!row) throw notFound('Customer');
    if (scope?.resellerId && row.reseller_id !== scope.resellerId) throw notFound('Customer');
    return row;
  }

  return {
    get: (id, scope = null) => assertScope(stmts.byId.get(id), scope),
    findByEmail: (email) => stmts.byEmail.get(String(email).toLowerCase()) || null,
    list(query = {}, scope = null) {
      const where = [];
      const params = {};
      if (scope?.resellerId) { where.push('reseller_id = @reseller'); params.reseller = scope.resellerId; }
      if (query.q) { where.push('(email LIKE @q OR name LIKE @q OR company LIKE @q OR external_ref LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.status) { where.push('status = @status'); params.status = query.status; }
      return paginate(db, { from: 'customers', where, params, sortable: { created_at: 'created_at', email: 'email', name: 'name' }, defaultSort: 'created_at', query });
    },
    create(input, scope = null) {
      const email = String(input.email).toLowerCase();
      if (stmts.byEmail.get(email)) throw conflict('A customer with that e-mail already exists', 'customer_exists');
      const id = newId('cus', ctx.clock.now());
      stmts.insert.run({ id, reseller_id: scope?.resellerId || input.reseller_id || null, name: input.name, email, company: input.company || null, country: input.country || null, external_ref: input.external_ref || null, now: nowIso(ctx.clock.now()) });
      return stmts.byId.get(id);
    },
    // Issue flows pass { email, name }: an existing customer is reused when it
    // is visible to the caller, otherwise created under the caller's scope.
    findOrCreate(input, scope = null) {
      const existing = this.findByEmail(input.email);
      if (existing) {
        if (scope?.resellerId && existing.reseller_id !== scope.resellerId) throw forbidden('That customer belongs to another reseller', 'customer_not_owned');
        return existing;
      }
      return this.create({ ...input, name: input.name || input.email }, scope);
    },
    update(id, patch, scope = null) {
      const row = this.get(id, scope);
      stmts.update.run({ id, name: patch.name ?? row.name, company: patch.company === undefined ? row.company : patch.company, country: patch.country === undefined ? row.country : patch.country, external_ref: patch.external_ref === undefined ? row.external_ref : patch.external_ref, status: patch.status ?? row.status, now: nowIso(ctx.clock.now()) });
      return stmts.byId.get(id);
    },
  };
}
