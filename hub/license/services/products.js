import { HttpError, notFound, conflict } from '../../shared/errors.js';
import { json, newId } from '../../shared/db.js';

export const EDITIONS = ['trial', 'solo', 'pro', 'reseller', 'enterprise'];
export const FEATURE_FLAGS = ['api', 'transfers', 'clusters', 'multi_server', 'marketplace_free', 'marketplace_paid', 'white_label', 'autossl_wildcard', 'sso', 'terminal', 'priority_support', 'custom_branding_builder'];
export const LIMIT_KEYS = ['max_accounts', 'max_resellers', 'max_domains_per_account', 'max_activations', 'grace_days'];

export function createProductsService(ctx) {
  const db = ctx.dbs.license;
  const stmts = {
    all: db.prepare('SELECT * FROM products ORDER BY rank, sku'),
    bySku: db.prepare('SELECT * FROM products WHERE sku = ?'),
    byId: db.prepare('SELECT * FROM products WHERE id = ?'),
    insert: db.prepare(`INSERT INTO products (id, sku, name, edition, rank, term, term_days, limits_json, features_json, price_cents, currency, active)
      VALUES (@id, @sku, @name, @edition, @rank, @term, @term_days, @limits_json, @features_json, @price_cents, @currency, @active)`),
    update: db.prepare(`UPDATE products SET name = @name, edition = @edition, rank = @rank, term = @term, term_days = @term_days, limits_json = @limits_json,
      features_json = @features_json, price_cents = @price_cents, currency = @currency, active = @active WHERE sku = @sku`),
  };

  function shape(row) {
    if (!row) return null;
    return { ...row, active: !!row.active, limits: json.parse(row.limits_json, {}), features: json.parse(row.features_json, {}), limits_json: undefined, features_json: undefined };
  }

  function normalizeFlags(features = {}) {
    return Object.fromEntries(FEATURE_FLAGS.map((f) => [f, features[f] === true]));
  }
  function normalizeLimits(limits = {}) {
    const out = {};
    for (const k of LIMIT_KEYS) out[k] = Number.isInteger(limits[k]) ? limits[k] : k === 'grace_days' ? ctx.config.license.default_grace_days : k === 'max_activations' ? 1 : -1;
    return out;
  }

  return {
    list: () => stmts.all.all().map(shape),
    get(sku) {
      const row = shape(stmts.bySku.get(sku));
      if (!row) throw notFound(`Product "${sku}"`);
      return row;
    },
    getById: (id) => shape(stmts.byId.get(id)),
    create(input) {
      if (stmts.bySku.get(input.sku)) throw conflict(`Product "${input.sku}" already exists`);
      if (!EDITIONS.includes(input.edition)) throw new HttpError(422, 'validation_failed', 'Unknown edition');
      const row = {
        id: newId('prd', ctx.clock.now()), sku: input.sku, name: input.name, edition: input.edition, rank: input.rank,
        term: input.term, term_days: input.term_days ?? null, limits_json: JSON.stringify(normalizeLimits(input.limits)),
        features_json: JSON.stringify(normalizeFlags(input.features)), price_cents: input.price_cents ?? 0, currency: input.currency || 'USD', active: input.active === false ? 0 : 1,
      };
      stmts.insert.run(row);
      return this.get(input.sku);
    },
    update(sku, patch) {
      const current = this.get(sku);
      const next = {
        sku, name: patch.name ?? current.name, edition: patch.edition ?? current.edition, rank: patch.rank ?? current.rank, term: patch.term ?? current.term,
        term_days: patch.term_days === undefined ? current.term_days : patch.term_days,
        limits_json: JSON.stringify(normalizeLimits({ ...current.limits, ...(patch.limits || {}) })),
        features_json: JSON.stringify(normalizeFlags({ ...current.features, ...(patch.features || {}) })),
        price_cents: patch.price_cents ?? current.price_cents, currency: patch.currency ?? current.currency, active: patch.active === undefined ? (current.active ? 1 : 0) : patch.active ? 1 : 0,
      };
      stmts.update.run(next);
      return this.get(sku);
    },
    // The entitlement snapshot a license copies at issue time.
    snapshot(sku) {
      const p = this.get(sku);
      if (!p.active) throw new HttpError(422, 'product_inactive', `Product "${sku}" is not sold any more`);
      const limits = normalizeLimits(p.limits);
      return { product_id: p.id, sku: p.sku, edition: p.edition, rank: p.rank, term: p.term, term_days: p.term_days, limits, features: normalizeFlags(p.features), max_activations: limits.max_activations, grace_days: limits.grace_days };
    },
    normalizeFlags,
    normalizeLimits,
  };
}
