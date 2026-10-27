import https from 'node:https';
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
// docs/design/license-server.md §16.4: WHM-XXXX-XXXX-XXXX-XXXX, Crockford base32
// (no I, L, O, U), case-insensitive, dashes optional.
export const LICENSE_KEY_RE = /^(?:WHM-?)?(?:[0-9A-HJKMNP-TV-Z]{4}-?){3}[0-9A-HJKMNP-TV-Z]{4}$/i;
export const licenseKeyPrefix = (key) => {
  const raw = String(key || '').toUpperCase().replace(/^WHM-?/, '').replace(/-/g, '');
  return raw.length >= 4 ? `WHM-${raw.slice(0, 4)}` : null;
};

function expandIPv6(addr) {
  let a = String(addr).toLowerCase().replace(/%.*$/, '');
  const dotted = a.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) a = `${dotted[1]}${((Number(dotted[2]) << 8) | Number(dotted[3])).toString(16)}:${((Number(dotted[4]) << 8) | Number(dotted[5])).toString(16)}`;
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || head.length + tail.length + fill !== 8) return null;
  const nums = [...head, ...Array(fill).fill('0'), ...tail].map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

// IPv6 addresses that embed an IPv4 address are judged by that address, in every
// spelling: IPv4-mapped (::ffff:a.b.c.d, which the URL parser rewrites to
// ::ffff:hex:hex), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4
// (2002::/16). The shared isPublicAddress only recognises the dotted mapped form.
export function isPublicProviderAddress(addr) {
  const family = net.isIP(addr);
  if (family === 4) return isPublicAddress(addr);
  if (family !== 6) return false;
  const h = expandIPv6(addr);
  if (!h) return false;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && (h[5] === 0 || h[5] === 0xffff)) return isPublicAddress(v4(h[6], h[7]));
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    if (h[2] === 1) return false;
    if (h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) return isPublicAddress(v4(h[6], h[7]));
  }
  if (h[0] === 0x2002) return isPublicAddress(v4(h[1], h[2]));
  return isPublicAddress(addr);
}

// Operator-supplied provider URLs are contacted server-side: https only, no
// redirects (one could steer the panel at internal services), hosts that resolve
// to non-public addresses are refused and the body is capped. The addresses that
// passed the check are the only ones the socket may connect to: the request's
// own resolver answers from that list, so a name that re-resolves to an internal
// address between the check and the connect (DNS rebinding) is never reached.
export async function safeRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 10_000, maxBytes = 512 * 1024, lookup = (host) => dns.lookup(host, { all: true }), request = https.request } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('only https:// URLs are contacted');
  if (u.username || u.password) throw new Error('credentials in the URL are not allowed; use the adapter fields');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses = net.isIP(host) ? [host] : [];
  if (!addresses.length) { try { addresses = (await lookup(host)).map((a) => a.address).filter((a) => net.isIP(a)); } catch { addresses = []; } }
  if (!addresses.length) throw new Error(`${host} could not be resolved`);
  const internal = addresses.find((a) => !isPublicProviderAddress(a));
  if (internal) throw new Error(`${host} resolves to a non-public address (${internal}); the panel only contacts public providers`);
  return performRequest({ u, host, addresses, method, body, timeoutMs, maxBytes, request, headers: { Accept: 'application/json', 'User-Agent': 'whm-panel-market/1.0', ...headers } });
}

function performRequest({ u, host, addresses, method, headers, body, timeoutMs, maxBytes, request }) {
  const vetted = addresses.map((address) => ({ address, family: net.isIP(address) }));
  const pinnedLookup = (_hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (options?.all) callback(null, vetted); else callback(null, vetted[0].address, vetted[0].family);
  };
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const fail = (err) => done(reject, err);
    const req = request({
      protocol: 'https:', hostname: host, port: u.port || 443, path: `${u.pathname}${u.search}`, method,
      headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) }, lookup: pinnedLookup,
    }, (res) => {
      const status = Number(res.statusCode) || 0;
      const contentType = res.headers?.['content-type'] || null;
      if (status >= 300 && status < 400) {
        res.resume?.();
        fail(new Error(`HTTP ${status} redirect to ${res.headers?.location || 'another location'} was not followed`));
        req.destroy?.();
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) { fail(new Error(`the response exceeds ${maxBytes} bytes`)); req.destroy?.(); return; }
        chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        done(resolve, { status, ok: status >= 200 && status < 300, contentType, text, json });
      });
    });
    timer = setTimeout(() => {
      const err = Object.assign(new Error(`no complete response within ${timeoutMs} ms`), { name: 'TimeoutError' });
      fail(err);
      req.destroy?.(err);
    }, timeoutMs);
    req.on('error', fail);
    req.end(payload || undefined);
  });
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
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

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
      const host = hostOf(provider.url);
      try {
        const res = await io.request(provider.url, { method: 'HEAD', headers: { Accept: '*/*' } });
        if (res.ok) return { ok: true, message: `${host} answered HTTP ${res.status}`, details: { status: res.status } };
        const hint = res.status === 404 ? 'check the URL' : res.status === 401 || res.status === 403 ? 'the site refused the request; check the URL or whether the vendor blocks automated requests' : 'the site is not healthy';
        return { ok: false, message: `${host} answered HTTP ${res.status}: ${hint}`, details: { status: res.status } };
      } catch (err) { return { ok: false, message: `${host}: ${describeError(err)}` }; }
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
  // The plugin marketplace hub (Phase 5): a single built-in row (whm-hub) that
  // the Plugins category will read through ctx.market.hub(). The probe follows
  // docs/design/license-server.md §16.5: both routes are public, so the license
  // key itself is never sent, only its display prefix.
  hub: {
    id: 'hub',
    label: 'WHM plugin marketplace hub',
    types: ['plugin'],
    singleton: true,
    configFields: [
      { key: 'licenseKey', label: 'License key', required: false, secret: true, kind: 'licenseKey', help: 'WHM-XXXX-XXXX-XXXX-XXXX, issued by the license server. Only its first group is sent when testing.' },
    ],
    requiresUrl: true,
    async test(provider, config, io) {
      if (!provider.url) return { ok: false, message: 'Set the hub URL first' };
      const prefix = config.licenseKey ? licenseKeyPrefix(config.licenseKey) : null;
      const url = joinUrl(provider.url, prefix ? `/v1/status/${prefix}` : '/v1/keys');
      const host = hostOf(url);
      try {
        const res = await io.request(url);
        if (prefix && res.status === 404) return { ok: false, message: `${host} does not know license ${prefix}`, details: { status: res.status, prefix } };
        if (!res.ok || res.json === null || typeof res.json !== 'object') return { ok: false, message: `${host} answered HTTP ${res.status}${res.json === null ? ' without JSON' : ''}`, details: { status: res.status } };
        const data = res.json.data && typeof res.json.data === 'object' ? res.json.data : res.json;
        if (prefix) {
          const licenseStatus = str(data.status, 20);
          const edition = str(data.edition, 40);
          const expiresAt = str(data.expires_at ?? data.expiresAt, 40);
          const valid = data.valid === undefined ? licenseStatus === null || ['active', 'grace'].includes(licenseStatus) : Boolean(data.valid);
          const message = `${host}: license ${prefix} is ${licenseStatus || (valid ? 'valid' : 'not valid')}${edition ? ` (${edition})` : ''}${expiresAt ? `, expires ${expiresAt}` : ''}`;
          return { ok: valid, message, details: { status: res.status, prefix, licenseStatus, edition, expiresAt, valid } };
        }
        const keys = Array.isArray(data.keys) ? data.keys.length : null;
        if (keys === null) return { ok: false, message: `${host} answered HTTP ${res.status} but not like a license hub (no signing keys published)`, details: { status: res.status } };
        return { ok: true, message: `Hub ${host} is reachable (${keys} signing key${keys === 1 ? '' : 's'} published); add a license key to check its status`, details: { status: res.status, keys } };
      } catch (err) { return { ok: false, message: `${host}: ${describeError(err)}` }; }
    },
  },
};

export const ADAPTER_IDS = Object.keys(ADAPTERS);
// Adapters an operator can add providers with: read-only ones are reflected from
// elsewhere, singleton ones ship as a built-in row.
export const CREATABLE_ADAPTERS = ADAPTER_IDS.filter((id) => !ADAPTERS[id].readOnly && !ADAPTERS[id].singleton);

export function adapterCatalog() {
  return ADAPTER_IDS.map((id) => {
    const a = ADAPTERS[id];
    return { id, label: a.label, types: a.types, readOnly: Boolean(a.readOnly), singleton: Boolean(a.singleton), requiresUrl: Boolean(a.requiresUrl), configFields: a.configFields, hasProducts: typeof a.listProducts === 'function' };
  });
}
