import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { safeRequest, normalizeProducts, isPublicProviderAddress, licenseKeyPrefix, LICENSE_KEY_RE, ADAPTERS, CREATABLE_ADAPTERS } from '../src/services/market-adapters.js';
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
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
// Stands in for https.request: records the options the socket layer would get and
// answers with a scripted response (or never, to exercise the timeout).
function fakeHttps({ status = 200, headers = {}, chunks = [], hang = false } = {}, seen = []) {
  return (options, onResponse) => {
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    req.end = (payload) => {
      seen.push({ options, payload });
      if (hang) return;
      const res = new PassThrough();
      res.statusCode = status;
      res.headers = headers;
      process.nextTick(() => { onResponse(res); for (const c of chunks) res.write(c); res.end(); });
    };
    return req;
  };
}

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
    await expect(safeRequest('https://vendor.example/', { lookup: async () => { throw new Error('ENOTFOUND'); } })).rejects.toThrow(/could not be resolved/);
    await expect(safeRequest('https://127.0.0.1/')).rejects.toThrow(/non-public/);
    await expect(safeRequest('https://[::1]/')).rejects.toThrow(/non-public/);
  });
  it('judges IPv6 addresses that embed an IPv4 address by that address, in every spelling', async () => {
    // The URL parser rewrites ::ffff:127.0.0.1 to the hex form the shared guard does not recognise.
    expect(new URL('https://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');
    for (const url of ['https://[::ffff:7f00:1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:c0a8:101]/', 'https://[::7f00:1]/', 'https://[64:ff9b::7f00:1]/', 'https://[64:ff9b::10.0.0.1]/', 'https://[64:ff9b:1::1]/', 'https://[2002:7f00:1::1]/', 'https://[2002:a00:1::]/', 'https://[fd00::1]/', 'https://[fe80::1]/']) {
      await expect(safeRequest(url), url).rejects.toThrow(/non-public/);
    }
    await expect(safeRequest('https://vendor.example/', { lookup: async () => [{ address: '::ffff:a9fe:a9fe', family: 6 }] })).rejects.toThrow(/non-public/);
    expect(isPublicProviderAddress('::ffff:5db8:d822')).toBe(true);
    expect(isPublicProviderAddress('64:ff9b::5db8:d822')).toBe(true);
    expect(isPublicProviderAddress('2002:5db8:d822::1')).toBe(true);
    expect(isPublicProviderAddress('2606:4700::6810:84e5')).toBe(true);
    expect(isPublicProviderAddress('93.184.216.34')).toBe(true);
    expect(isPublicProviderAddress('not-an-address')).toBe(false);
    expect(isPublicProviderAddress('::')).toBe(false);
  });
  it('pins the socket to the vetted addresses and keeps the host name for TLS', async () => {
    const seen = [];
    const res = await safeRequest('https://vendor.example/v1/x?y=1', { lookup: publicLookup, request: fakeHttps({ headers: { 'content-type': 'application/json' }, chunks: ['{"a":', '1}'] }, seen), headers: { Authorization: 'Bearer k' } });
    expect(res).toEqual({ status: 200, ok: true, contentType: 'application/json', text: '{"a":1}', json: { a: 1 } });
    const { options } = seen[0];
    expect(options).toMatchObject({ protocol: 'https:', hostname: 'vendor.example', port: 443, path: '/v1/x?y=1', method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer k', 'User-Agent': 'whm-panel-market/1.0' } });
    // net.connect resolves through the request's own lookup, which only answers with the checked addresses.
    await expect(new Promise((resolve) => options.lookup('vendor.example', { all: true }, (err, list) => resolve([err, list])))).resolves.toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
    await expect(new Promise((resolve) => options.lookup('vendor.example', {}, (err, a, f) => resolve([err, a, f])))).resolves.toEqual([null, '93.184.216.34', 4]);
    await expect(new Promise((resolve) => options.lookup('vendor.example', (err, a, f) => resolve([err, a, f])))).resolves.toEqual([null, '93.184.216.34', 4]);
    const head = await safeRequest('https://vendor.example:8443/', { method: 'HEAD', lookup: publicLookup, request: fakeHttps({ status: 204 }) });
    expect(head).toMatchObject({ status: 204, ok: true, text: '', json: null });
    const posted = [];
    await safeRequest('https://vendor.example/', { method: 'POST', body: '{"x":1}', lookup: publicLookup, request: fakeHttps({ status: 201 }, posted) });
    expect(posted[0].options.headers['Content-Length']).toBe(7);
    expect(posted[0].payload.toString()).toBe('{"x":1}');
    const notJson = await safeRequest('https://vendor.example/', { lookup: publicLookup, request: fakeHttps({ status: 503, chunks: ['<html>'] }) });
    expect(notJson).toMatchObject({ status: 503, ok: false, text: '<html>', json: null });
  });
  it('refuses redirects, caps the body and times out', async () => {
    await expect(safeRequest('https://vendor.example/', { lookup: publicLookup, request: fakeHttps({ status: 302, headers: { location: 'https://169.254.169.254/latest/' } }) })).rejects.toThrow(/HTTP 302 redirect to https:\/\/169\.254\.169\.254\/latest\/ was not followed/);
    await expect(safeRequest('https://vendor.example/', { lookup: publicLookup, request: fakeHttps({ status: 301 }) })).rejects.toThrow(/redirect to another location/);
    await expect(safeRequest('https://vendor.example/', { maxBytes: 20, lookup: publicLookup, request: fakeHttps({ chunks: ['x'.repeat(8), 'x'.repeat(8), 'x'.repeat(8)] }) })).rejects.toThrow(/exceeds 20 bytes/);
    expect(await safeRequest('https://vendor.example/', { maxBytes: 24, lookup: publicLookup, request: fakeHttps({ chunks: ['x'.repeat(8), 'x'.repeat(8), 'x'.repeat(8)] }) })).toMatchObject({ text: 'x'.repeat(24) });
    const seen = [];
    const err = await safeRequest('https://vendor.example/', { timeoutMs: 20, lookup: publicLookup, request: fakeHttps({ hang: true }, seen) }).catch((e) => e);
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toMatch(/20 ms/);
  });
  it('knows the license key format and its display prefix', () => {
    expect(LICENSE_KEY_RE.test('WHM-7K3Q-M2DF-9XA1-P0R6')).toBe(true);
    expect(LICENSE_KEY_RE.test('whm7k3qm2df9xa1p0r6')).toBe(true);
    expect(LICENSE_KEY_RE.test('WHM-7K3Q-M2DF-9XA1-P0RI')).toBe(false);
    expect(LICENSE_KEY_RE.test('LIC-123')).toBe(false);
    expect(licenseKeyPrefix('whm-7k3q-m2df-9xa1-p0r6')).toBe('WHM-7K3Q');
    expect(licenseKeyPrefix('7K3QM2DF9XA1P0R6')).toBe('WHM-7K3Q');
    expect(licenseKeyPrefix('')).toBeNull();
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
    expect(CREATABLE_ADAPTERS).toEqual(['manual', 'rest']);
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
  it('paginates, filters and sorts like every list endpoint', async () => {
    const all = await get('/api/market/providers').expect(200);
    expect(all.body.meta).toEqual({ page: 1, pageSize: 50, total: all.body.data.length });
    expect(all.body.data.length).toBeGreaterThanOrEqual(4);
    const second = await get('/api/market/providers?pageSize=2&page=2').expect(200);
    expect(second.body.meta).toEqual({ page: 2, pageSize: 2, total: all.body.meta.total });
    expect(second.body.data.map((p) => p.name)).toEqual(all.body.data.slice(2, 4).map((p) => p.name));
    expect((await get('/api/market/providers?q=CPANEL').expect(200)).body.data.map((p) => p.name)).toEqual(['cpstore']);
    expect((await get('/api/market/providers?q=acme').expect(200)).body).toMatchObject({ data: [expect.objectContaining({ name: 'acme.sh' })], meta: { total: 1 } });
    const sorted = (await get('/api/market/providers?sort=name&dir=desc').expect(200)).body.data.map((p) => p.name);
    expect(sorted).toEqual([...sorted].sort().reverse());
    expect((await get('/api/market/providers?page=0')).status).toBe(422);
    expect((await get('/api/market/providers?sort=Name')).status).toBe(422);
  });
  it('filters by type, validates the query and hides configuration from resellers', async () => {
    expect((await get('/api/market/providers?type=plugin').expect(200)).body.data.map((p) => p.name)).toEqual(['whm-hub']);
    expect((await get('/api/market/providers?type=nope')).status).toBe(422);
    const res = await reseller.get('/api/market/providers').expect(200);
    const cpstore = res.body.data.find((p) => p.name === 'cpstore');
    expect(cpstore.config).toBeUndefined();
    expect(cpstore.secretsSet).toBeUndefined();
    expect(cpstore.orders).toBeNull();
    // Wholesale economics stay with root: resellers get resale prices only.
    for (const p of res.body.data) {
      expect(p.commissionPercent, p.name).toBeUndefined();
      expect(p.lastTest, p.name).toBeUndefined();
      expect(p.missing, p.name).toBeUndefined();
      for (const x of p.products) expect(Object.keys(x).sort()).toEqual(['currency', 'id', 'name', 'price', 'termMonths', 'wildcard']);
    }
    const single = await reseller.get('/api/market/providers/cpstore').expect(200);
    expect(single.body.data.commissionPercent).toBeUndefined();
    expect(single.body.data.products[0].basePrice).toBeUndefined();
    expect((await reseller.get('/api/market/providers/certbot').expect(200)).body.data).toMatchObject({ readOnly: true, manageAt: '/ssl-tls/manage-autossl' });
    expect((await reseller.get('/api/market/providers/certbot')).body.data.commissionPercent).toBeUndefined();
    expect((await plainUser.get('/api/market/providers')).status).toBe(403);
    expect((await reseller.get('/api/market/adapters')).status).toBe(403);
    const adapters = await get('/api/market/adapters').expect(200);
    expect(adapters.body.data.find((a) => a.id === 'rest')).toMatchObject({ types: ['ssl'], hasProducts: true, readOnly: false });
    expect(adapters.body.data.find((a) => a.id === 'acme').readOnly).toBe(true);
    expect(adapters.body.data.find((a) => a.id === 'hub')).toMatchObject({ singleton: true, readOnly: false, types: ['plugin'] });
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
    // The hub is a built-in singleton: a second hub row would never be read by ctx.market.hub().
    const hub = await post('/api/market/providers', { ...body, name: 'hub2', type: 'plugin', adapter: 'hub', url: 'https://hub2.example' });
    expect(hub.status).toBe(409);
    expect(hub.body.error.message).toMatch(/whm-hub/);
    expect((await post('/api/market/providers', { ...body, name: 'hub2', type: 'plugin', adapter: 'manual', products: [{ id: 'x', name: 'x' }] })).status).toBe(422);
    expect((await post('/api/market/providers', { ...body, name: 'certbot' })).status).toBe(409);
    expect((await post('/api/market/providers', { ...body, name: 'cpstore' })).status).toBe(409);
    expect((await post('/api/market/providers', { ...body, config: { nope: 'x' } })).status).toBe(422);
  });
  it('creates the provider with marked-up products and mirrors it for SSL/TLS', async () => {
    const res = await post('/api/market/providers', { name: 'vendor', displayName: 'Vendor SSL', type: 'ssl', adapter: 'rest', commissionPercent: 10, products: [{ id: 'dv', name: 'DV 1 year', price: 9.99, currency: 'USD', termMonths: 12 }] }).expect(201);
    expect(res.body.data).toMatchObject({ name: 'vendor', enabled: false, configured: false, missing: ['apiBase', 'apiKey'], commissionPercent: 10, hasProducts: true });
    expect(res.body.data.products[0]).toMatchObject({ id: 'dv', basePrice: 9.99, price: 10.99 });
    expect(sslSetting().find((p) => p.name === 'vendor').products[0].price).toBe(10.99);
    const asReseller = (await reseller.get('/api/market/providers/vendor').expect(200)).body.data;
    expect(asReseller.products[0]).toEqual({ id: 'dv', name: 'DV 1 year', price: 10.99, currency: 'USD', termMonths: 12, wildcard: false });
    expect(asReseller.commissionPercent).toBeUndefined();
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
    app.ctx.market.transport.request = async (url, opts) => ({ status: opts.method === 'HEAD' && url === 'https://store.cpanel.net' ? 200 : 500, ok: opts.method === 'HEAD' && url === 'https://store.cpanel.net', json: null, text: '' });
    expect((await post('/api/market/providers/cpstore/test').expect(200)).body.data.result).toMatchObject({ ok: true, message: 'store.cpanel.net answered HTTP 200' });
    // Only a 2xx proves the URL: a vendor portal answering 403/404 is a failed test with the status in the message.
    for (const [status, hint] of [[403, /refused the request/], [404, /check the URL/], [500, /not healthy/]]) {
      app.ctx.market.transport.request = async () => ({ status, ok: false, json: null, text: '' });
      const r = (await post('/api/market/providers/cpstore/test').expect(200)).body.data;
      expect(r.result, String(status)).toMatchObject({ ok: false, message: expect.stringMatching(new RegExp(`HTTP ${status}`)) });
      expect(r.result.message).toMatch(hint);
      expect(r.provider.lastTest.ok).toBe(false);
    }
    expect((await put('/api/market/providers/cpstore', { url: null })).status).toBe(422);
    await post('/api/market/providers/cpstore/disable').expect(200);
    expect((await put('/api/market/providers/cpstore', { url: null }).expect(200)).body.data.url).toBeNull();
    expect((await post('/api/market/providers/cpstore/enable')).status).toBe(422);
    await put('/api/market/providers/cpstore/config', { url: 'https://store.cpanel.net', config: { accountEmail: 'ops@example.com' } }).expect(200);
    expect((await get('/api/market/providers/cpstore').expect(200)).body.data.config.accountEmail).toBe('ops@example.com');
  });
  it('configures the plugin hub and exposes it to the marketplace client', async () => {
    expect(app.ctx.market.hub()).toEqual({ enabled: false, url: null });
    expect((await post('/api/market/providers/whm-hub/enable')).status).toBe(422);
    expect((await put('/api/market/providers/whm-hub/config', { url: 'https://hub.example.com', config: { apiKey: 'x' } })).status).toBe(422);
    // The license key is entered under Basic Setup → License only (§18.6): the adapter no longer has the field.
    const badKey = await put('/api/market/providers/whm-hub/config', { url: 'https://hub.example.com', config: { licenseKey: 'whm-7k3q-m2df-9xa1-p0r6' } });
    expect(badKey.status).toBe(422);
    expect(badKey.body.error.fields.licenseKey[0]).toMatch(/Unknown field/);
    expect(app.ctx.market.adapters().find((a) => a.id === 'hub').configFields).toEqual([]);
    // Without a license the probe reads the public signing-key list (docs/design/license-server.md §16.5).
    await put('/api/market/providers/whm-hub/config', { url: 'https://hub.example.com/', config: {} }).expect(200);
    const seen = [];
    app.ctx.market.transport.request = async (url, opts) => { seen.push({ url, opts }); return { status: 200, ok: true, json: { keys: [{ kid: 'a91f3c2e', status: 'active' }] }, text: '' }; };
    expect((await post('/api/market/providers/whm-hub/test').expect(200)).body.data.result).toMatchObject({ ok: true, message: 'Hub hub.example.com is reachable (1 signing key published); activate a license under Basic Setup → License to check its status' });
    expect(seen[0].url).toBe('https://hub.example.com/v1/keys');
    expect(seen[0].opts?.headers?.Authorization).toBeUndefined();
    app.ctx.market.transport.request = async () => ({ status: 200, ok: true, json: { name: 'something else' }, text: '' });
    expect((await post('/api/market/providers/whm-hub/test').expect(200)).body.data.result).toMatchObject({ ok: false, message: expect.stringMatching(/not like a license hub/) });
    const res = await put('/api/market/providers/whm-hub/config', { url: 'https://hub.example.com/', config: {} }).expect(200);
    expect(res.body.data).toMatchObject({ url: 'https://hub.example.com/', configured: true, secretsSet: [] });
    await post('/api/market/providers/whm-hub/enable').expect(200);
    expect(app.ctx.market.hub()).toEqual({ enabled: true, url: 'https://hub.example.com/' });
    expect(app.ctx.market.enabledProviders('plugin').map((p) => p.name)).toEqual(['whm-hub']);
    // With a license the probe is the public status lookup by the key prefix ctx.license holds: the key itself never leaves the panel.
    const realLicense = app.ctx.license;
    app.ctx.license = { ...realLicense, get: () => ({ ...realLicense.get(), keyPrefix: 'WHM-7K3Q' }) };
    seen.length = 0;
    app.ctx.market.transport.request = async (url, opts) => { seen.push({ url, opts }); return { status: 200, ok: true, json: { data: { valid: true, status: 'active', edition: 'pro', expires_at: '2027-10-27' } }, text: '' }; };
    const test = await post('/api/market/providers/whm-hub/test').expect(200);
    expect(test.body.data.result).toMatchObject({ ok: true, message: 'hub.example.com: license WHM-7K3Q is active (pro), expires 2027-10-27', details: { prefix: 'WHM-7K3Q', licenseStatus: 'active' } });
    expect(seen[0].url).toBe('https://hub.example.com/v1/status/WHM-7K3Q');
    expect(JSON.stringify(seen)).not.toMatch(/m2df/i);
    app.ctx.market.transport.request = async () => ({ status: 200, ok: true, json: { data: { valid: false, status: 'revoked', edition: 'pro' } }, text: '' });
    expect((await post('/api/market/providers/whm-hub/test').expect(200)).body.data.result).toMatchObject({ ok: false, message: 'hub.example.com: license WHM-7K3Q is revoked (pro)' });
    app.ctx.market.transport.request = async () => ({ status: 404, ok: false, json: { error: { code: 'not_found' } }, text: '' });
    expect((await post('/api/market/providers/whm-hub/test').expect(200)).body.data.result).toMatchObject({ ok: false, message: 'hub.example.com does not know license WHM-7K3Q' });
    app.ctx.license = realLicense;
    // Plugin rows have no product list of their own: the catalog comes from the hub.
    const products = await put('/api/market/providers/whm-hub', { products: [{ id: 'x', name: 'x' }] });
    expect(products.status).toBe(422);
    expect(products.body.error.fields.products).toBeDefined();
    expect((await put('/api/market/providers/whm-hub', { displayName: 'WHM Marketplace' }).expect(200)).body.data.products).toEqual([]);
    expect(sslSetting().map((p) => p.name)).toEqual(['cpstore']);
  });
  it('adopts providers the legacy market.providers setting knows and the table does not', async () => {
    const before = sslSetting();
    app.ctx.settings.set('market.providers', [
      { name: 'legacy', displayName: 'Legacy <Vendor>', enabled: true, url: 'https://legacy.example', products: [{ id: 'dv', name: 'DV', price: 4, termMonths: 12 }, { id: 'bad id' }] },
      { name: 'nourl', displayName: 'No URL', enabled: true, url: 'http://plain.example' },
      { name: 'cpstore', displayName: 'Replaced?', enabled: true },
      { name: 'certbot', enabled: true }, { name: 'bad name' }, 'junk', null,
    ]);
    expect(app.ctx.market.adoptLegacySetting()).toEqual(['legacy', 'nourl']);
    app.ctx.market.syncSettings();
    expect(app.ctx.market.adoptLegacySetting()).toEqual([]);
    const legacy = (await get('/api/market/providers/legacy').expect(200)).body.data;
    expect(legacy).toMatchObject({ type: 'ssl', adapter: 'manual', builtin: false, enabled: true, url: 'https://legacy.example', displayName: 'Legacy Vendor', commissionPercent: 0 });
    expect(legacy.products.map((p) => p.id)).toEqual(['dv']);
    expect((await get('/api/market/providers/nourl').expect(200)).body.data).toMatchObject({ enabled: false, url: null, configured: false });
    expect((await get('/api/market/providers/cpstore').expect(200)).body.data.displayName).toBe('cPanel Store');
    expect(sslSetting().map((p) => p.name).sort()).toEqual(['cpstore', 'legacy', 'nourl']);
    await del('/api/market/providers/legacy').expect(200);
    await del('/api/market/providers/nourl').expect(200);
    expect(sslSetting()).toEqual(before);
    app.ctx.settings.set('market.providers', 'not a list');
    expect(app.ctx.market.adoptLegacySetting()).toEqual([]);
    app.ctx.market.syncSettings();
    expect(sslSetting()).toEqual(before);
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
