import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { safeRequest, normalizeProducts, ADAPTERS } from '../src/services/market-adapters.js';
import { resalePrice } from '../src/services/market.js';

let app;
let csrf;
let reseller;
let plainUser;
let plainCsrf;

const mutate = (client, method, url, body, token) => client[method](url).set('X-CSRF-Token', token).send(body);
const put = (url, body) => mutate(app.http, 'put', url, body, csrf);
const post = (url, body = {}) => mutate(app.http, 'post', url, body, csrf);
const del = (url) => mutate(app.http, 'delete', url, undefined, csrf);
const get = (url) => app.http.get(url);
const auditCount = (action) => app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n;
const sslSetting = () => app.ctx.settings.get('market.providers');

beforeAll(async () => {
  app = await createTestApp();
  csrf = await app.login();
  const r = await app.createUser('resell1', 'reseller');
  reseller = request.agent(app.ctx.app);
  await reseller.post('/api/auth/login').send({ username: r.username, password: r.password });
  const u = await app.createUser('plainuser', 'user');
  plainUser = request.agent(app.ctx.app);
  plainCsrf = (await plainUser.post('/api/auth/login').send({ username: u.username, password: u.password })).body.data.csrfToken;
}, 30_000);

afterAll(async () => { await app?.close(); });

describe('pure helpers', () => {
  it('safeRequest refuses plain http, embedded credentials and non-public hosts', async () => {
    await expect(safeRequest('http://vendor.example/')).rejects.toThrow(/https/);
    await expect(safeRequest('https://user:pw@vendor.example/')).rejects.toThrow(/credentials/);
    await expect(safeRequest('https://vendor.example/', { lookup: async () => [{ address: '10.0.0.8' }] })).rejects.toThrow(/non-public/);
    await expect(safeRequest('https://127.0.0.1/')).rejects.toThrow(/non-public/);
    await expect(safeRequest('https://[::1]/')).rejects.toThrow(/non-public/);
  });
  it('normalizeProducts drops unsafe entries and derives wildcard', () => {
    const out = normalizeProducts([
      { id: 'dv', name: 'Domain Validated', price: '9.999', currency: 'EUR', termMonths: 12 },
      { id: 'wc', name: 'Wildcard DV', price: 99 },
      { id: 'bad id', name: 'x' }, { id: '../x' }, null, 'str', { sku: 'ov-2y', name: 'OV <b>', term: 24, currency: 'usd' },
    ]);
    expect(out).toEqual([
      { id: 'dv', name: 'Domain Validated', price: 10, currency: 'EUR', termMonths: 12, wildcard: false },
      { id: 'wc', name: 'Wildcard DV', price: 99, currency: 'USD', termMonths: 12, wildcard: true },
      { id: 'ov-2y', name: 'ov-2y', price: null, currency: 'USD', termMonths: 24, wildcard: false },
    ]);
    expect(resalePrice(9.99, 10)).toBe(10.99);
    expect(resalePrice(null, 10)).toBeNull();
    expect(Object.keys(ADAPTERS).sort()).toEqual(['acme', 'hub', 'manual', 'rest']);
  });
});

describe('GET /api/market/providers', () => {
  it('lists stored providers plus the ACME clients reflected from AutoSSL', async () => {
    const res = await get('/api/market/providers').expect(200);
    const names = res.body.data.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['cpstore', 'whm-hub', 'certbot', 'acme.sh']));
    const cpstore = res.body.data.find((p) => p.name === 'cpstore');
    expect(cpstore).toMatchObject({ type: 'ssl', adapter: 'manual', builtin: true, enabled: false, configured: true, url: 'https://store.cpanel.net', commissionPercent: 0, orders: 0 });
    expect(cpstore.products.map((p) => p.id)).toEqual(['dv', 'ov', 'wildcard']);
    expect(cpstore.config).toEqual({ accountEmail: null, customerId: null });
    const hub = res.body.data.find((p) => p.name === 'whm-hub');
    expect(hub).toMatchObject({ type: 'plugin', adapter: 'hub', builtin: true, enabled: false, configured: false, missing: ['url'], secretsSet: [] });
    const certbot = res.body.data.find((p) => p.name === 'certbot');
    expect(certbot).toMatchObject({ readOnly: true, adapter: 'acme', installed: false, enabled: false, manageAt: '/ssl-tls/manage-autossl' });
  });
  it('filters by type, validates the query and hides configuration from resellers', async () => {
    expect((await get('/api/market/providers?type=plugin').expect(200)).body.data.map((p) => p.name)).toEqual(['whm-hub']);
    expect((await get('/api/market/providers?type=nope')).status).toBe(422);
    const res = await reseller.get('/api/market/providers').expect(200);
    const cpstore = res.body.data.find((p) => p.name === 'cpstore');
    expect(cpstore.config).toBeUndefined();
    expect(cpstore.secretsSet).toBeUndefined();
    expect(cpstore.orders).toBeNull();
    expect((await plainUser.get('/api/market/providers')).status).toBe(403);
    expect((await reseller.get('/api/market/adapters')).status).toBe(403);
    const adapters = await get('/api/market/adapters').expect(200);
    expect(adapters.body.data.find((a) => a.id === 'rest')).toMatchObject({ types: ['ssl'], hasProducts: true, readOnly: false });
    expect(adapters.body.data.find((a) => a.id === 'acme').readOnly).toBe(true);
  });
  it('gets single providers, including ACME rows', async () => {
    expect((await get('/api/market/providers/acme.sh').expect(200)).body.data).toMatchObject({ readOnly: true, installed: false });
    expect((await get('/api/market/providers/cpstore').expect(200)).body.data.name).toBe('cpstore');
    expect((await get('/api/market/providers/missing')).status).toBe(404);
    expect((await get('/api/market/providers/bad%3Bname')).status).toBe(422);
  });
  it('mirrors SSL providers into the setting SSL/TLS reads at boot', async () => {
    const setting = sslSetting();
    expect(setting.map((p) => p.name)).toEqual(['cpstore']);
    expect(setting[0].products.find((p) => p.id === 'wildcard').wildcard).toBe(true);
    expect((await get('/api/ssl/market/providers').expect(200)).body.data[0]).toMatchObject({ name: 'cpstore', enabled: false });
  });
});

describe('custom providers (REST adapter)', () => {
  it('validates creation and refuses it for non-root', async () => {
    const body = { name: 'vendor', displayName: 'Vendor SSL', type: 'ssl', adapter: 'rest' };
    expect((await mutate(reseller, 'post', '/api/market/providers', body, (await reseller.post('/api/auth/login').send({ username: 'resell1', password: 'Test-Passw0rd!1' })).body.data.csrfToken)).status).toBe(403);
    expect((await mutate(plainUser, 'post', '/api/market/providers', body, plainCsrf)).status).toBe(403);
    for (const bad of [{ ...body, name: '-r' }, { ...body, name: 'a;b' }, { ...body, name: '../x' }, { ...body, adapter: 'acme' }, { ...body, adapter: 'shell' }, { ...body, url: 'http://vendor.example' }, { ...body, commissionPercent: 101 }, { ...body, products: [{ id: 'a b', name: 'x' }] }, { ...body, extra: 1 }]) {
      expect((await post('/api/market/providers', bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await post('/api/market/providers', { ...body, type: 'plugin' })).status).toBe(422);
    expect((await post('/api/market/providers', { ...body, name: 'certbot' })).status).toBe(409);
    expect((await post('/api/market/providers', { ...body, name: 'cpstore' })).status).toBe(409);
    expect((await post('/api/market/providers', { ...body, config: { nope: 'x' } })).status).toBe(422);
  });
  it('creates the provider with marked-up products and mirrors it for SSL/TLS', async () => {
    const res = await post('/api/market/providers', { name: 'vendor', displayName: 'Vendor SSL', type: 'ssl', adapter: 'rest', commissionPercent: 10, products: [{ id: 'dv', name: 'DV 1 year', price: 9.99, currency: 'USD', termMonths: 12 }] }).expect(201);
    expect(res.body.data).toMatchObject({ name: 'vendor', enabled: false, configured: false, missing: ['apiBase', 'apiKey'], commissionPercent: 10, hasProducts: true });
    expect(res.body.data.products[0]).toMatchObject({ id: 'dv', basePrice: 9.99, price: 10.99 });
    expect(sslSetting().find((p) => p.name === 'vendor').products[0].price).toBe(10.99);
    expect(auditCount('market.provider.create')).toBe(1);
  });
  it('refuses to enable before it is configured', async () => {
    const res = await post('/api/market/providers/vendor/enable');
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fields).sort()).toEqual(['apiBase', 'apiKey']);
  });
  it('validates and stores the configuration encrypted, never echoing secrets', async () => {
    expect((await put('/api/market/providers/vendor/config', { config: { apiBase: 'http://api.vendor.example' } })).status).toBe(422);
    expect((await put('/api/market/providers/vendor/config', { config: { statusPath: 'status?x=1' } })).status).toBe(422);
    expect((await put('/api/market/providers/vendor/config', { config: { licenseKey: 'x' } })).status).toBe(422);
    expect((await put('/api/market/providers/vendor/config', { config: { apiKey: 'a'.repeat(3000) } })).status).toBe(422);
    const res = await put('/api/market/providers/vendor/config', { config: { apiBase: 'https://api.vendor.example/v1', apiKey: 'sk-secret-123' } }).expect(200);
    expect(res.body.data).toMatchObject({ configured: true, config: { apiBase: 'https://api.vendor.example/v1', apiKey: null }, secretsSet: ['apiKey'] });
    const row = app.ctx.db.prepare('SELECT config_enc FROM market_providers WHERE name = ?').get('vendor');
    expect(row.config_enc).toMatch(/^v1:/);
    expect(row.config_enc).not.toContain('sk-secret-123');
    expect(app.ctx.market.credentials('vendor')).toEqual({ apiBase: 'https://api.vendor.example/v1', apiKey: 'sk-secret-123' });
    const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'market.provider.configure' ORDER BY id DESC").get();
    expect(audit.args_redacted).not.toContain('sk-secret-123');
    // Blank secret keeps the stored value; other fields are replaced.
    const again = await put('/api/market/providers/vendor/config', { config: { apiKey: '', statusPath: '/health' } }).expect(200);
    expect(again.body.data.secretsSet).toEqual(['apiKey']);
    expect(again.body.data.config.statusPath).toBe('/health');
  });
  it('enables the provider and SSL/TLS sees it', async () => {
    const res = await post('/api/market/providers/vendor/enable').expect(200);
    expect(res.body.data.enabled).toBe(true);
    expect((await get('/api/ssl/market/providers').expect(200)).body.data.find((p) => p.name === 'vendor')).toMatchObject({ enabled: true, products: [expect.objectContaining({ id: 'dv', price: 10.99 })] });
    expect(auditCount('market.provider.enable')).toBe(1);
    // An enabled provider cannot lose its credentials.
    expect((await put('/api/market/providers/vendor/config', { config: { apiKey: null } })).status).toBe(422);
  });
  it('tests the vendor API through the adapter with the stored key', async () => {
    const seen = [];
    app.ctx.market.transport.request = async (url, opts) => { seen.push({ url, opts }); return { status: 200, ok: true, json: { ok: true }, text: '{"ok":true}' }; };
    const res = await post('/api/market/providers/vendor/test').expect(200);
    expect(res.body.data.result).toMatchObject({ ok: true });
    expect(res.body.data.provider.lastTest).toMatchObject({ ok: true });
    expect(seen[0].url).toBe('https://api.vendor.example/v1/health');
    expect(seen[0].opts.headers.Authorization).toBe('Bearer sk-secret-123');
    app.ctx.market.transport.request = async () => ({ status: 401, ok: false, json: null, text: '' });
    const bad = await post('/api/market/providers/vendor/test').expect(200);
    expect(bad.body.data.result).toMatchObject({ ok: false, message: expect.stringMatching(/rejected the API key/) });
    expect((await get('/api/market/providers/vendor').expect(200)).body.data.lastTest.ok).toBe(false);
    app.ctx.market.transport.request = async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); };
    expect((await post('/api/market/providers/vendor/test').expect(200)).body.data.result.message).toMatch(/timed out/);
    expect(auditCount('market.provider.test')).toBe(3);
  });
  it('synchronises products from the vendor catalog', async () => {
    expect((await post('/api/market/providers/vendor/products/sync')).status).toBe(422);
    await put('/api/market/providers/vendor/config', { config: { productsPath: '/products' } }).expect(200);
    app.ctx.market.transport.request = async (url) => ({ status: 200, ok: true, json: url.endsWith('/products') ? { products: [{ id: 'ev', name: 'Extended Validation', price: 199, currency: 'EUR', termMonths: 12 }, { id: 'bad id' }] } : {}, text: '' });
    const res = await post('/api/market/providers/vendor/products/sync').expect(200);
    expect(res.body.data.products).toEqual([{ id: 'ev', name: 'Extended Validation', basePrice: 199, price: 218.9, currency: 'EUR', termMonths: 12, wildcard: false }]);
    expect(sslSetting().find((p) => p.name === 'vendor').products.map((p) => p.id)).toEqual(['ev']);
    app.ctx.market.transport.request = async () => ({ status: 200, ok: true, json: { nope: true }, text: '' });
    expect((await post('/api/market/providers/vendor/products/sync')).status).toBe(422);
    expect((await post('/api/market/providers/cpstore/products/sync')).status).toBe(422);
  });
  it('updates identity fields and keeps the mirror in sync', async () => {
    expect((await put('/api/market/providers/vendor', {})).status).toBe(422);
    expect((await put('/api/market/providers/vendor', { displayName: 'a<b' })).status).toBe(422);
    const res = await put('/api/market/providers/vendor', { displayName: 'Vendor SSL Ltd', commissionPercent: 0, products: [{ id: 'dv', name: 'DV', price: 5 }] }).expect(200);
    expect(res.body.data).toMatchObject({ displayName: 'Vendor SSL Ltd', commissionPercent: 0 });
    expect(res.body.data.products[0].price).toBe(5);
    expect(sslSetting().find((p) => p.name === 'vendor')).toMatchObject({ displayName: 'Vendor SSL Ltd', enabled: true });
    expect((await put('/api/market/providers/certbot', { displayName: 'x' })).status).toBe(422);
  });
  it('disables and deletes custom providers only', async () => {
    expect((await del('/api/market/providers/cpstore')).status).toBe(409);
    expect((await del('/api/market/providers/certbot')).status).toBe(422);
    expect((await post('/api/market/providers/vendor/disable').expect(200)).body.data.enabled).toBe(false);
    expect((await del('/api/market/providers/vendor').expect(200)).body.data).toMatchObject({ name: 'vendor', removed: true });
    expect((await get('/api/market/providers/vendor')).status).toBe(404);
    expect(sslSetting().map((p) => p.name)).toEqual(['cpstore']);
    expect(auditCount('market.provider.delete')).toBe(1);
  });
});

describe('built-in providers', () => {
  it('enables the manual cPanel Store provider and tests its site', async () => {
    const res = await post('/api/market/providers/cpstore/enable').expect(200);
    expect(res.body.data.enabled).toBe(true);
    expect((await get('/api/ssl/market/providers').expect(200)).body.data.find((p) => p.name === 'cpstore').enabled).toBe(true);
    app.ctx.market.transport.request = async (url, opts) => ({ status: opts.method === 'HEAD' && url === 'https://store.cpanel.net' ? 200 : 500, ok: true, json: null, text: '' });
    expect((await post('/api/market/providers/cpstore/test').expect(200)).body.data.result).toMatchObject({ ok: true, message: 'store.cpanel.net answered HTTP 200' });
    expect((await put('/api/market/providers/cpstore', { url: null })).status).toBe(422);
    await post('/api/market/providers/cpstore/disable').expect(200);
    expect((await put('/api/market/providers/cpstore', { url: null }).expect(200)).body.data.url).toBeNull();
    expect((await post('/api/market/providers/cpstore/enable')).status).toBe(422);
    await put('/api/market/providers/cpstore/config', { url: 'https://store.cpanel.net', config: { accountEmail: 'ops@example.com' } }).expect(200);
    expect((await get('/api/market/providers/cpstore').expect(200)).body.data.config.accountEmail).toBe('ops@example.com');
  });
  it('configures the plugin hub and exposes it to the Plugins category', async () => {
    expect(app.ctx.market.hub()).toEqual({ enabled: false, url: null, licenseKey: null });
    expect((await post('/api/market/providers/whm-hub/enable')).status).toBe(422);
    expect((await put('/api/market/providers/whm-hub/config', { url: 'https://hub.example.com', config: { apiKey: 'x' } })).status).toBe(422);
    const res = await put('/api/market/providers/whm-hub/config', { url: 'https://hub.example.com/', config: { licenseKey: 'LIC-123' } }).expect(200);
    expect(res.body.data).toMatchObject({ url: 'https://hub.example.com/', configured: true, secretsSet: ['licenseKey'], config: { licenseKey: null } });
    await post('/api/market/providers/whm-hub/enable').expect(200);
    expect(app.ctx.market.hub()).toEqual({ enabled: true, url: 'https://hub.example.com/', licenseKey: 'LIC-123' });
    expect(app.ctx.market.enabledProviders('plugin').map((p) => p.name)).toEqual(['whm-hub']);
    const seen = [];
    app.ctx.market.transport.request = async (url, opts) => { seen.push({ url, opts }); return { status: 200, ok: true, json: { name: 'WHM Hub', version: '0.1.0' }, text: '' }; };
    const test = await post('/api/market/providers/whm-hub/test').expect(200);
    expect(test.body.data.result).toMatchObject({ ok: true, message: 'Hub WHM Hub v0.1.0 is reachable' });
    expect(seen[0]).toMatchObject({ url: 'https://hub.example.com/api/v1/status', opts: { headers: { Authorization: 'Bearer LIC-123' } } });
    expect(sslSetting().map((p) => p.name)).toEqual(['cpstore']);
  });
  it('reports a missing ACME client as a capability error and reflects AutoSSL otherwise', async () => {
    const missing = await post('/api/market/providers/certbot/test');
    expect(missing.status).toBe(501);
    expect(missing.body.error.code).toBe('capability_missing');
    expect((await post('/api/market/providers/certbot/enable')).status).toBe(422);
    expect((await put('/api/market/providers/certbot/config', { config: {} })).status).toBe(422);
    app.agent.set('ssl.acme.detect', () => ({ certbot: true, acmeSh: null, providers: ['certbot'], provider: 'certbot' }));
    expect((await post('/api/market/providers/certbot/test').expect(200)).body.data.result).toMatchObject({ ok: true });
    expect((await post('/api/market/providers/acme.sh/test')).status).toBe(501);
    app.ctx.settings.set('ssl.autossl.provider', 'certbot');
    const list = await get('/api/market/providers').expect(200);
    expect(list.body.data.find((p) => p.name === 'certbot')).toMatchObject({ installed: true, enabled: true, configured: true });
    expect(list.body.data.find((p) => p.name === 'acme.sh')).toMatchObject({ installed: false, enabled: false });
  });
});
