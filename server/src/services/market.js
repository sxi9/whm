import { json } from '../db/index.js';
import { notFound, conflict, unprocessable, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';
import { ADAPTERS, CREATABLE_ADAPTERS, LICENSE_KEY_RE, adapterCatalog, normalizeProducts, safeRequest } from './market-adapters.js';

// Market providers. Attached as ctx.market; other categories may call:
//   market.enabledProviders(type)   -> enabled rows of a type ('ssl' | 'plugin') with base prices, no secrets
//   market.credentials(name)        -> decrypted adapter config for a provider (services only)
//   market.hub()                    -> { enabled, url } of the plugin marketplace hub, the single built-in
//                                      'whm-hub' row. Read by ctx.marketplace as its enable switch only: the
//                                      license key and the hub URL the panel trusts are owned by ctx.license.
//   market.sslProviders()           -> the list SSL/TLS reads from the market.providers setting
// The market_providers table is the source of truth; every change to an SSL
// provider is mirrored into the market.providers setting so Purchase and Install
// an SSL Certificate keeps working without reaching into this service. The
// setting's own seed (006_ssl-tls.sql, immutable) predates the table: whatever it
// holds is adopted once at boot and then overwritten from the table.

export const PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const HUB_NAME = 'whm-hub';
const ACME_CLIENTS = [
  { name: 'certbot', displayName: 'certbot (Let\'s Encrypt)' },
  { name: 'acme.sh', displayName: 'acme.sh (Let\'s Encrypt / ZeroSSL)' },
];
const ACME_PRODUCTS = [{ id: 'dv', name: 'Domain Validated (ACME, 90 days)', price: 0, currency: 'USD', termMonths: 3, wildcard: false }];
const MANAGE_AUTOSSL = '/ssl-tls/manage-autossl';
const HTTPS_URL_RE = /^https:\/\/[^\s/$.?#][^\s]*$/i;
const PATH_RE = /^\/[A-Za-z0-9_./-]*$/;
const LIST_SORT = { name: 'name', display_name: 'displayName', type: 'type', adapter: 'adapter', enabled: 'enabled' };

const round2 = (n) => Math.round(Number(n) * 100) / 100;
export const resalePrice = (price, commissionPercent) => (price == null ? null : round2(Number(price) * (1 + Number(commissionPercent || 0) / 100)));

export function createMarketService(ctx) {
  const { db, settings, crypto, logger } = ctx;

  const stmts = {
    all: db.prepare('SELECT * FROM market_providers ORDER BY builtin DESC, type, display_name'),
    byName: db.prepare('SELECT * FROM market_providers WHERE name = ?'),
    insert: db.prepare('INSERT INTO market_providers (name, display_name, type, adapter, builtin, enabled, url, config_enc, commission_percent, products_json) VALUES (@name, @display_name, @type, @adapter, 0, 0, @url, @config_enc, @commission_percent, @products_json)'),
    update: db.prepare(`UPDATE market_providers SET display_name = @display_name, url = @url, commission_percent = @commission_percent, products_json = @products_json, updated_at = datetime('now') WHERE name = @name`),
    setConfig: db.prepare(`UPDATE market_providers SET config_enc = ?, url = ?, updated_at = datetime('now') WHERE name = ?`),
    setEnabled: db.prepare(`UPDATE market_providers SET enabled = ?, updated_at = datetime('now') WHERE name = ?`),
    setProducts: db.prepare(`UPDATE market_providers SET products_json = ?, updated_at = datetime('now') WHERE name = ?`),
    setTest: db.prepare(`UPDATE market_providers SET last_test_at = datetime('now'), last_test_ok = ?, last_test_message = ? WHERE name = ?`),
    remove: db.prepare('DELETE FROM market_providers WHERE name = ?'),
  };

  // Outbound HTTPS goes through here so tests can answer for the vendor.
  const transport = { request: (url, opts) => safeRequest(url, opts) };
  // The hub probe asks for the license key prefix; the key itself lives in ctx.license and never leaves it.
  const io = { request: (url, opts) => transport.request(url, opts), licensePrefix: () => { try { return ctx.license?.get?.().keyPrefix ?? null; } catch { return null; } } };

  const adapterOf = (row) => ADAPTERS[row.adapter] || ADAPTERS.manual;
  const readConfig = (row) => {
    if (!row.config_enc) return {};
    try { return json.parse(crypto.decrypt(row.config_enc), {}) || {}; } catch (err) { logger.warn({ err, provider: row.name }, 'market: provider config could not be decrypted'); return {}; }
  };
  const products = (row) => normalizeProducts(json.parse(row.products_json, []));

  function missingForEnable(row, config) {
    const a = adapterOf(row);
    const fields = {};
    if (a.requiresUrl && !row.url) fields.url = ['Set the provider URL first'];
    for (const f of a.configFields) if (f.required && !config[f.key]) fields[f.key] = [`${f.label} is required`];
    return fields;
  }

  // Resellers only ever see the resale price: vendor prices, the commission,
  // config field names and test results are the operator's business.
  // `wholesale` keeps the economics for other services without exposing config.
  function shape(row, { forRoot = false, wholesale = forRoot, orders = null } = {}) {
    const a = adapterOf(row);
    const config = readConfig(row);
    const visible = {};
    const secretsSet = [];
    for (const f of a.configFields) {
      if (f.secret) { visible[f.key] = null; if (config[f.key]) secretsSet.push(f.key); } else visible[f.key] = config[f.key] ?? null;
    }
    const missing = missingForEnable(row, config);
    const resale = (p) => ({ id: p.id, name: p.name, price: resalePrice(p.price, row.commission_percent), currency: p.currency, termMonths: p.termMonths, wildcard: p.wildcard });
    return {
      name: row.name, displayName: row.display_name, type: row.type, adapter: row.adapter, adapterLabel: a.label,
      builtin: Boolean(row.builtin), readOnly: false, enabled: Boolean(row.enabled), url: row.url || null,
      ...(wholesale ? { commissionPercent: Number(row.commission_percent) || 0 } : {}),
      products: products(row).map((p) => (wholesale ? { ...resale(p), basePrice: p.price } : resale(p))),
      hasProducts: typeof a.listProducts === 'function',
      configured: Object.keys(missing).length === 0,
      ...(forRoot ? {
        missing: Object.keys(missing), config: visible, secretsSet,
        lastTest: row.last_test_at ? { at: row.last_test_at, ok: row.last_test_ok == null ? null : Boolean(row.last_test_ok), message: row.last_test_message } : null,
      } : {}),
      orders: orders == null ? null : orders[row.name] || 0,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // The ACME clients AutoSSL can drive, reflected read-only from SSL/TLS.
  async function acmeRows({ forRoot = false } = {}) {
    const ssl = ctx.ssl?.autossl;
    if (!ssl?.settings || !ssl.detect) return [];
    let current = 'disabled';
    try { current = ssl.settings().provider || 'disabled'; } catch { current = 'disabled'; }
    const detect = await ssl.detect().catch(() => ({ providers: [] }));
    const installed = Array.isArray(detect?.providers) ? detect.providers : [];
    return ACME_CLIENTS.map((c) => ({
      name: c.name, displayName: c.displayName, type: 'ssl', adapter: 'acme', adapterLabel: ADAPTERS.acme.label,
      builtin: true, readOnly: true, enabled: current === c.name, installed: installed.includes(c.name), url: null,
      ...(forRoot ? { commissionPercent: 0, missing: installed.includes(c.name) ? [] : ['installed'], lastTest: null } : {}),
      products: ACME_PRODUCTS, hasProducts: false, configured: installed.includes(c.name),
      manageAt: MANAGE_AUTOSSL, orders: null, createdAt: null, updatedAt: null,
    }));
  }

  const isAcmeName = (name) => ACME_CLIENTS.some((c) => c.name === name);

  function row(name) {
    const r = stmts.byName.get(name);
    if (!r) throw notFound(`Provider "${name}"`);
    return r;
  }

  function orderCounts() {
    const counts = {};
    try {
      for (const o of ctx.ssl?.market?.orders?.({ role: 'root' }) || []) counts[o.provider] = (counts[o.provider] || 0) + 1;
    } catch (err) { logger.warn({ err }, 'market: order counts unavailable'); }
    return counts;
  }

  function sslProviders() {
    return stmts.all.all().filter((r) => r.type === 'ssl').map((r) => ({
      name: r.name, displayName: r.display_name, enabled: Boolean(r.enabled), url: r.url || null, adapter: r.adapter, commissionPercent: Number(r.commission_percent) || 0,
      products: products(r).map((p) => ({ ...p, basePrice: p.price, price: resalePrice(p.price, r.commission_percent) })),
    }));
  }
  function syncSettings() { settings.set('market.providers', sslProviders()); }

  // Entries the legacy market.providers setting has and the table does not were
  // placed there before the table existed; they become manual SSL providers.
  function adoptLegacySetting() {
    const legacy = settings.get('market.providers', []);
    if (!Array.isArray(legacy)) return [];
    const adopted = [];
    for (const p of legacy) {
      if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !PROVIDER_NAME_RE.test(p.name) || isAcmeName(p.name) || stmts.byName.get(p.name)) continue;
      const url = typeof p.url === 'string' && HTTPS_URL_RE.test(p.url) ? p.url : null;
      const displayName = typeof p.displayName === 'string' ? p.displayName.replace(/[\r\n\0<>]/g, '').trim().slice(0, 80) : '';
      stmts.insert.run({ name: p.name, display_name: displayName || p.name, type: 'ssl', adapter: 'manual', url, config_enc: null, commission_percent: 0, products_json: JSON.stringify(normalizeProducts(p.products)) });
      if (p.enabled && url) stmts.setEnabled.run(1, p.name);
      adopted.push(p.name);
    }
    if (adopted.length) logger.info({ providers: adopted }, 'market: adopted providers from the legacy market.providers setting');
    return adopted;
  }

  function validateConfigInput(row, input) {
    const a = adapterOf(row);
    const known = new Map(a.configFields.map((f) => [f.key, f]));
    const errors = {};
    for (const [key, value] of Object.entries(input || {})) {
      const f = known.get(key);
      if (!f) { errors[key] = [`Unknown field for the ${a.label} adapter`]; continue; }
      if (value == null || value === '') continue;
      if (f.kind === 'url' && !HTTPS_URL_RE.test(value)) errors[key] = ['Must be an https:// URL'];
      if (f.kind === 'path' && !PATH_RE.test(value)) errors[key] = ['Must be a path like /v1/products (letters, digits, "/", ".", "_", "-")'];
      if (f.kind === 'licenseKey' && !LICENSE_KEY_RE.test(String(value).trim())) errors[key] = ['License keys look like WHM-XXXX-XXXX-XXXX-XXXX'];
    }
    if (Object.keys(errors).length) throw unprocessable('Provider configuration is invalid', errors);
  }

  const service = {
    transport,
    adapters: () => adapterCatalog(),

    async list({ type, q, page = 1, pageSize = 50, sort, dir = 'asc' } = {}, user) {
      const forRoot = isRoot(user);
      const orders = forRoot ? orderCounts() : null;
      const stored = stmts.all.all().map((r) => shape(r, { forRoot, orders }));
      let all = [...stored, ...(await acmeRows({ forRoot }))].filter((p) => !type || p.type === type);
      if (q) { const needle = q.toLowerCase(); all = all.filter((p) => p.name.toLowerCase().includes(needle) || p.displayName.toLowerCase().includes(needle)); }
      const key = LIST_SORT[sort];
      if (key) all.sort((a, b) => (a[key] === b[key] ? 0 : a[key] > b[key] ? 1 : -1) * (dir === 'desc' ? -1 : 1));
      const total = all.length;
      return { data: all.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, total } };
    },

    async get(name, user) {
      if (isAcmeName(name)) {
        const found = (await acmeRows({ forRoot: isRoot(user) })).find((p) => p.name === name);
        if (!found) throw notFound(`Provider "${name}"`);
        return found;
      }
      return shape(row(name), { forRoot: isRoot(user), orders: isRoot(user) ? orderCounts() : null });
    },

    create({ name, displayName, type, adapter, url, commissionPercent = 0, products: list = [], config = {} }, req) {
      if (isAcmeName(name)) throw conflict(`"${name}" is reserved for the ACME client managed under Manage AutoSSL`);
      if (stmts.byName.get(name)) throw conflict(`Provider "${name}" already exists`);
      if (ADAPTERS[adapter]?.singleton) throw conflict(`The ${ADAPTERS[adapter].label} is built in; configure "${HUB_NAME}" instead of adding another`);
      if (!CREATABLE_ADAPTERS.includes(adapter)) throw unprocessable('Unknown adapter', { adapter: [`Choose one of ${CREATABLE_ADAPTERS.join(', ')}`] });
      const a = ADAPTERS[adapter];
      if (!a.types.includes(type)) throw unprocessable('Adapter and type do not match', { adapter: [`The ${a.label} adapter provides ${a.types.join('/')} providers`] });
      if (type !== 'ssl' && list.length) throw unprocessable('Only SSL providers carry a product list', { products: ['Plugin catalogs come from the hub'] });
      const draft = { name, adapter };
      validateConfigInput(draft, config);
      const clean = Object.fromEntries(Object.entries(config).filter(([, v]) => v != null && v !== ''));
      stmts.insert.run({ name, display_name: displayName, type, adapter, url: url || null, config_enc: Object.keys(clean).length ? crypto.encrypt(JSON.stringify(clean)) : null, commission_percent: round2(commissionPercent), products_json: JSON.stringify(normalizeProducts(list)) });
      if (type === 'ssl') syncSettings();
      req?.audit?.({ action: 'market.provider.create', target: name, args: { type, adapter, url: url || null, commissionPercent, products: normalizeProducts(list).length, configFields: Object.keys(clean) } });
      return shape(stmts.byName.get(name), { forRoot: true });
    },

    update(name, input, req) {
      if (isAcmeName(name)) throw unprocessable(`"${name}" is managed under SSL/TLS → Manage AutoSSL`, { name: ['ACME clients are configured in Manage AutoSSL'] });
      const r = row(name);
      const a = adapterOf(r);
      if (input.products !== undefined && r.type !== 'ssl') throw unprocessable('Only SSL providers carry a product list', { products: ['Plugin catalogs come from the hub; this field is not stored'] });
      const next = {
        name,
        display_name: input.displayName ?? r.display_name,
        url: input.url === undefined ? r.url : input.url,
        commission_percent: input.commissionPercent === undefined ? r.commission_percent : round2(input.commissionPercent),
        products_json: input.products === undefined ? r.products_json : JSON.stringify(normalizeProducts(input.products)),
      };
      if (r.enabled && a.requiresUrl && !next.url) throw unprocessable('An enabled provider needs a URL', { url: ['Disable the provider before clearing its URL'] });
      stmts.update.run(next);
      if (r.type === 'ssl') syncSettings();
      req?.audit?.({ action: 'market.provider.update', target: name, args: { displayName: next.display_name, url: next.url, commissionPercent: next.commission_percent, products: input.products === undefined ? undefined : normalizeProducts(input.products).length } });
      return shape(stmts.byName.get(name), { forRoot: true });
    },

    // Stores credentials encrypted. Secret fields left empty keep their stored
    // value; null clears it. The URL is part of "configure" for adapters that need one.
    configure(name, { url, config = {} }, req) {
      if (isAcmeName(name)) throw unprocessable(`"${name}" is managed under SSL/TLS → Manage AutoSSL`, { name: ['ACME clients are configured in Manage AutoSSL'] });
      const r = row(name);
      const a = adapterOf(r);
      validateConfigInput(r, config);
      const current = readConfig(r);
      const merged = { ...current };
      for (const f of a.configFields) {
        if (!(f.key in config)) continue;
        const v = config[f.key];
        if (v === null) delete merged[f.key];
        else if (v === '' || v === undefined) { if (!f.secret) delete merged[f.key]; }
        else merged[f.key] = String(v);
      }
      const nextUrl = url === undefined ? r.url : url;
      if (r.enabled) {
        const missing = missingForEnable({ ...r, url: nextUrl }, merged);
        if (Object.keys(missing).length) throw unprocessable('An enabled provider must stay fully configured; disable it first', missing);
      }
      stmts.setConfig.run(Object.keys(merged).length ? crypto.encrypt(JSON.stringify(merged)) : null, nextUrl || null, name);
      if (r.type === 'ssl') syncSettings();
      req?.audit?.({ action: 'market.provider.configure', target: name, args: { url: nextUrl || null, fields: Object.keys(config), cleared: Object.keys(config).filter((k) => config[k] === null) } });
      return shape(stmts.byName.get(name), { forRoot: true });
    },

    setEnabled(name, enabled, req) {
      if (isAcmeName(name)) throw unprocessable(`"${name}" is enabled by selecting it as the AutoSSL provider`, { name: ['Open SSL/TLS → Manage AutoSSL to choose the ACME client'] });
      const r = row(name);
      if (enabled) {
        const missing = missingForEnable(r, readConfig(r));
        if (Object.keys(missing).length) throw unprocessable(`Configure "${r.display_name}" before enabling it`, missing);
      }
      stmts.setEnabled.run(enabled ? 1 : 0, name);
      if (r.type === 'ssl') syncSettings();
      req?.audit?.({ action: enabled ? 'market.provider.enable' : 'market.provider.disable', target: name });
      return shape(stmts.byName.get(name), { forRoot: true });
    },

    async test(name, req) {
      if (isAcmeName(name)) {
        const found = (await acmeRows({ forRoot: true })).find((p) => p.name === name);
        if (!found) throw new CapabilityError('acme', `${name} is not available: the SSL/TLS category is not loaded`);
        if (!found.installed) throw new CapabilityError('acme', `${name} is not installed on this server. Install certbot (python3-certbot) or acme.sh, then select it under Manage AutoSSL.`);
        const result = { ok: true, message: `${name} is installed${found.enabled ? ' and selected as the AutoSSL provider' : '; select it under Manage AutoSSL to use it'}` };
        req?.audit?.({ action: 'market.provider.test', target: name, args: { ok: true } });
        return { provider: found, result };
      }
      const r = row(name);
      const a = adapterOf(r);
      const config = readConfig(r);
      const missing = missingForEnable(r, config);
      let result;
      if (Object.keys(missing).length) result = { ok: false, message: `Not configured: ${Object.values(missing).flat().join('; ')}` };
      else if (typeof a.test !== 'function') result = { ok: true, message: 'This adapter has nothing to test' };
      else result = await a.test({ name: r.name, url: r.url, type: r.type }, config, io);
      stmts.setTest.run(result.ok ? 1 : 0, String(result.message || '').slice(0, 500), name);
      req?.audit?.({ action: 'market.provider.test', target: name, args: { ok: result.ok, message: result.message }, result: result.ok ? 'ok' : 'failed' });
      return { provider: shape(stmts.byName.get(name), { forRoot: true }), result };
    },

    async syncProducts(name, req) {
      if (isAcmeName(name)) throw unprocessable('ACME clients have a fixed product', { name: ['Nothing to synchronise'] });
      const r = row(name);
      const a = adapterOf(r);
      if (typeof a.listProducts !== 'function') throw unprocessable(`The ${a.label} adapter has no product catalog; edit the products by hand`, { adapter: ['No catalog endpoint'] });
      const config = readConfig(r);
      const missing = missingForEnable({ ...r, enabled: 1 }, config);
      if (Object.keys(missing).length) throw unprocessable(`Configure "${r.display_name}" first`, missing);
      let list;
      try { list = await a.listProducts({ name: r.name, url: r.url, type: r.type }, config, io); } catch (err) { throw unprocessable(`Product sync failed: ${err.message}`, { productsPath: [err.message] }); }
      if (list === null) throw unprocessable('No products endpoint is configured for this provider', { productsPath: ['Set the products endpoint under Configure'] });
      stmts.setProducts.run(JSON.stringify(list), name);
      if (r.type === 'ssl') syncSettings();
      req?.audit?.({ action: 'market.provider.sync_products', target: name, args: { products: list.length } });
      return shape(stmts.byName.get(name), { forRoot: true });
    },

    remove(name, req) {
      if (isAcmeName(name)) throw unprocessable('ACME clients cannot be removed here', { name: ['Uninstall the client or change the AutoSSL provider instead'] });
      const r = row(name);
      if (r.builtin) throw conflict(`"${r.display_name}" is built in; disable it instead`);
      const orders = orderCounts()[name] || 0;
      stmts.remove.run(name);
      if (r.type === 'ssl') syncSettings();
      req?.audit?.({ action: 'market.provider.delete', target: name, args: { orders } });
      return { name, removed: true, orders };
    },

    // ---- integration surface for other categories ------------------------------
    sslProviders,
    syncSettings,
    adoptLegacySetting,
    enabledProviders(type) { return stmts.all.all().filter((r) => r.enabled && (!type || r.type === type)).map((r) => shape(r, { wholesale: true })); },
    credentials(name) { const r = stmts.byName.get(name); return r ? readConfig(r) : null; },
    // Enable switch and display URL only; a stored licenseKey from older releases is never read again.
    hub() {
      const r = stmts.byName.get(HUB_NAME);
      if (!r) return { enabled: false, url: null };
      return { enabled: Boolean(r.enabled), url: r.url || null };
    },
  };
  return service;
}
