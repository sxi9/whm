import dns from 'node:dns/promises';
import net from 'node:net';
import { isPublicAddress } from './security-center.js';

// Provider adapters: how the panel talks to a marketplace provider. Each adapter
// declares the credentials it needs (configFields), how to prove they work (test)
// and, when the vendor exposes a catalog, how to pull products (listProducts).
// Adapters never touch the host; they only make outbound HTTPS calls through
// io.request, which tests replace.

const NAME_RE = /^[A-Za-z0-9 ._()&/-]{1,80}$/;
const PRODUCT_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_PRODUCTS = 50;

// Operator-supplied provider URLs are contacted server-side: https only, no
// redirects (one could steer the panel at internal services), hosts that resolve
// to non-public addresses are refused and the body is capped.
export async function safeRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 10_000, maxBytes = 512 * 1024, lookup = (host) => dns.lookup(host, { all: true }) } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('only https:// URLs are contacted');
  if (u.username || u.password) throw new Error('credentials in the URL are not allowed; use the adapter fields');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses = net.isIP(host) ? [host] : [];
  if (!addresses.length) { try { addresses = (await lookup(host)).map((a) => a.address); } catch { addresses = []; } }
  const internal = addresses.find((a) => !isPublicAddress(a));
  if (internal) throw new Error(`${host} resolves to a non-public address (${internal}); the panel only contacts public providers`);
  const res = await fetch(u.href, { method, body, redirect: 'manual', headers: { Accept: 'application/json', 'User-Agent': 'whm-panel-market/1.0', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status >= 300 && res.status < 400) throw new Error(`HTTP ${res.status} redirect to ${res.headers?.get?.('location') || 'another location'} was not followed`);
  let text = '';
  if (method !== 'HEAD') {
    if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) throw new Error(`the response exceeds ${maxBytes} bytes`);
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks).toString('utf8');
    } else text = await res.text();
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, contentType: res.headers?.get?.('content-type') || null, text, json };
}

const describeError = (err) => (err?.name === 'TimeoutError' ? 'timed out' : err?.message || String(err));
const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
const joinUrl = (base, p) => `${String(base).replace(/\/+$/, '')}/${String(p || '').replace(/^\/+/, '')}`;

// Normalises a vendor catalog into the shape SSL/TLS expects; anything that is not
// a product with a safe id is dropped rather than stored.
export function normalizeProducts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const id = String(x.id ?? x.sku ?? x.code ?? '');
    if (!PRODUCT_ID_RE.test(id)) continue;
    const name = typeof x.name === 'string' && NAME_RE.test(x.name) ? x.name : id;
    const price = x.price == null || x.price === '' ? null : Number(x.price);
    const currency = typeof x.currency === 'string' && /^[A-Z]{3}$/.test(x.currency) ? x.currency : 'USD';
    const termMonths = Number.isInteger(Number(x.termMonths ?? x.term)) && Number(x.termMonths ?? x.term) >= 1 && Number(x.termMonths ?? x.term) <= 120 ? Number(x.termMonths ?? x.term) : 12;
    out.push({ id, name, price: Number.isFinite(price) && price >= 0 ? Math.round(price * 100) / 100 : null, currency, termMonths, wildcard: Boolean(x.wildcard) || /wildcard/i.test(name) });
    if (out.length >= MAX_PRODUCTS) break;
  }
  return out;
}

const authHeaders = (config) => (config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {});

export const ADAPTERS = {
  // Orders are recorded in the panel; the operator submits the CSR at the vendor
  // and pastes the issued certificate back (what Purchase and Install does today).
  manual: {
    id: 'manual',
    label: 'Manual order (CSR submitted at the vendor site)',
    types: ['ssl'],
    configFields: [
      { key: 'accountEmail', label: 'Vendor account e-mail', required: false, secret: false, help: 'Shown next to recorded orders as a reminder of which account to use.' },
      { key: 'customerId', label: 'Customer or reseller ID', required: false, secret: false },
    ],
    requiresUrl: true,
    async test(provider, _config, io) {
      if (!provider.url) return { ok: false, message: 'Set the vendor URL first' };
      try {
        const res = await io.request(provider.url, { method: 'HEAD', headers: { Accept: '*/*' } });
        return { ok: res.status < 500, message: `${hostOf(provider.url)} answered HTTP ${res.status}`, details: { status: res.status } };
      } catch (err) { return { ok: false, message: `${hostOf(provider.url)}: ${describeError(err)}` }; }
    },
  },
  // Commercial vendors with a JSON API authenticated by a bearer token.
  rest: {
    id: 'rest',
    label: 'REST API vendor (bearer token)',
    types: ['ssl'],
    configFields: [
      { key: 'apiBase', label: 'API base URL', required: true, secret: false, kind: 'url', help: 'https://api.vendor.example/v1' },
      { key: 'apiKey', label: 'API key', required: true, secret: true },
      { key: 'statusPath', label: 'Status endpoint', required: false, secret: false, kind: 'path', help: 'Relative to the base URL; default /status. Must answer 2xx with JSON.' },
      { key: 'productsPath', label: 'Products endpoint', required: false, secret: false, kind: 'path', help: 'Optional. A JSON array (or { products: [...] }) of { id, name, price, currency, termMonths, wildcard }.' },
    ],
    requiresUrl: false,
    async test(_provider, config, io) {
      const url = joinUrl(config.apiBase, config.statusPath || '/status');
      try {
        const res = await io.request(url, { headers: authHeaders(config) });
        if (res.status === 401 || res.status === 403) return { ok: false, message: `${hostOf(url)} rejected the API key (HTTP ${res.status})`, details: { status: res.status } };
        if (!res.ok) return { ok: false, message: `${hostOf(url)} answered HTTP ${res.status}`, details: { status: res.status } };
        if (res.json === null) return { ok: false, message: `${hostOf(url)} answered HTTP ${res.status} but not with JSON`, details: { status: res.status } };
        return { ok: true, message: `${hostOf(url)} answered HTTP ${res.status} with JSON`, details: { status: res.status } };
      } catch (err) { return { ok: false, message: `${hostOf(url)}: ${describeError(err)}` }; }
    },
    async listProducts(_provider, config, io) {
      if (!config.productsPath) return null;
      const url = joinUrl(config.apiBase, config.productsPath);
      const res = await io.request(url, { headers: authHeaders(config) });
      if (!res.ok) throw new Error(`${hostOf(url)} answered HTTP ${res.status}`);
      const list = Array.isArray(res.json) ? res.json : Array.isArray(res.json?.products) ? res.json.products : Array.isArray(res.json?.data) ? res.json.data : null;
      if (!list) throw new Error(`${hostOf(url)} did not return a product list`);
      return normalizeProducts(list);
    },
  },
  // Reflected from SSL/TLS → Manage AutoSSL; never stored or configured here.
  acme: {
    id: 'acme',
    label: "ACME client (Let's Encrypt)",
    types: ['ssl'],
    configFields: [],
    readOnly: true,
    requiresUrl: false,
  },
  // The plugin marketplace hub (Phase 5). Only the hub URL and an optional license
  // key live here; the Plugins category reads them through ctx.market.hub().
  hub: {
    id: 'hub',
    label: 'WHM plugin marketplace hub',
    types: ['plugin'],
    configFields: [
      { key: 'licenseKey', label: 'License key', required: false, secret: true, help: 'Issued by the license server; sent as a bearer token.' },
    ],
    requiresUrl: true,
    async test(provider, config, io) {
      if (!provider.url) return { ok: false, message: 'Set the hub URL first' };
      const url = joinUrl(provider.url, '/api/v1/status');
      try {
        const res = await io.request(url, { headers: config.licenseKey ? { Authorization: `Bearer ${config.licenseKey}` } : {} });
        if (res.status === 401 || res.status === 403) return { ok: false, message: `${hostOf(url)} rejected the license key (HTTP ${res.status})`, details: { status: res.status } };
        if (!res.ok || res.json === null) return { ok: false, message: `${hostOf(url)} answered HTTP ${res.status}${res.json === null ? ' without JSON' : ''}`, details: { status: res.status } };
        const name = typeof res.json.name === 'string' ? res.json.name.slice(0, 80) : null;
        const version = typeof res.json.version === 'string' ? res.json.version.slice(0, 40) : null;
        return { ok: true, message: `Hub ${name || hostOf(url)}${version ? ` v${version}` : ''} is reachable`, details: { status: res.status, name, version } };
      } catch (err) { return { ok: false, message: `${hostOf(url)}: ${describeError(err)}` }; }
    },
  },
};

export const ADAPTER_IDS = Object.keys(ADAPTERS);
export const CREATABLE_ADAPTERS = ADAPTER_IDS.filter((id) => !ADAPTERS[id].readOnly);

export function adapterCatalog() {
  return ADAPTER_IDS.map((id) => {
    const a = ADAPTERS[id];
    return { id, label: a.label, types: a.types, readOnly: Boolean(a.readOnly), requiresUrl: Boolean(a.requiresUrl), configFields: a.configFields, hasProducts: typeof a.listProducts === 'function' };
  });
}
