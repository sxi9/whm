import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import request from 'supertest';
import { bootstrap } from '../src/index.js';
import { canonicalize } from '../shared/canonical.js';
import { parseSignatureHeader } from '../shared/keys.js';
import { composite } from '../shared/fingerprint.js';
import { newId } from '../shared/db.js';
import { KIDS, pubOf, copyKeys } from './fixtures/index.js';

export const KEY_OPTS = { licenseA: KIDS.licenseA, pluginA: KIDS.pluginA };

// Boots a hub against a temp directory with the fixture keys installed:
// license-a and plugin-a active, license-b and plugin-b pending.
export async function bootHub({ config = {}, now, fetch, webhookFetch, keys = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-hub-test-'));
  const keysDir = copyKeys(path.join(dir, 'keys'));
  const clock = { t: now ?? Date.now() };
  const ctx = await bootstrap({
    dbDir: dir,
    now: () => clock.t,
    fetch,
    webhookFetch,
    logger: pino({ level: 'silent' }),
    config: deepMerge({
      log_level: 'silent',
      public_url: 'https://hub.test',
      keys: { dir: keysDir, active_kid: { license: KIDS.licenseA, plugin: KIDS.pluginA } },
      license: {
        mail: { transport: 'none' }, backup_dir: null,
        billing: { stripe: { secret: 'whsec_test' }, whmcs: { secret: 'whmcs_test' }, paddle: { secret: 'pdl_test' } },
        rate_limits: { activate: { max: 1000, windowMs: 3600_000 }, checkin: { max: 1000, windowMs: 3600_000 }, trial: { max: 1000, windowMs: 3600_000 }, recover: { max: 1000, windowMs: 3600_000 }, reseller: { max: 10000, windowMs: 3600_000 }, admin: { max: 10000, windowMs: 3600_000 }, portal_login: { max: 100, windowMs: 60_000 }, public: { max: 10000, windowMs: 3600_000 } },
      },
    }, config),
  });
  if (keys) {
    ctx.keys.register({ purpose: 'license', publicPem: pubOf(KIDS.licenseA), status: 'active', activatedAt: new Date(clock.t - 100 * 86_400_000).toISOString() });
    ctx.keys.register({ purpose: 'license', publicPem: pubOf(KIDS.licenseB), status: 'pending' });
    ctx.keys.register({ purpose: 'plugin', publicPem: pubOf(KIDS.pluginA), status: 'active', activatedAt: new Date(clock.t - 100 * 86_400_000).toISOString() });
    ctx.keys.register({ purpose: 'plugin', publicPem: pubOf(KIDS.pluginB), status: 'pending' });
  }
  const http = request(ctx.app);
  const db = ctx.dbs.license;

  function createApiKey({ ownerType = 'vendor', ownerId = 'vnd_default', scopes = ['admin:*', 'report:read', 'billing:webhook'], name = 'test' } = {}) {
    const secret = `whk_${ctx.crypto.randomToken(30)}`;
    const id = newId('key', clock.t);
    db.prepare('INSERT INTO api_keys (id, owner_type, owner_id, name, key_hash, key_prefix, scopes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerType, ownerId, name, ctx.crypto.hashToken(secret), secret.slice(0, 12), JSON.stringify(scopes), new Date(clock.t).toISOString());
    return secret;
  }
  const adminKey = createApiKey();
  const admin = (method, url) => http[method](url).set('Authorization', `Bearer ${adminKey}`);
  const asKey = (key) => (method, url) => http[method](url).set('Authorization', `Bearer ${key}`);

  let counter = 0;
  const fp = (seed = `srv-${++counter}-${crypto.randomBytes(4).toString('hex')}`) => {
    const h = (s) => crypto.createHash('sha256').update(`${seed}|${s}`).digest('hex');
    const components = { machine_id: h('machine'), mac: h('mac'), disk: h('disk') };
    return { fingerprint: composite(components), fp_components: components };
  };
  const nonce = () => `n_${crypto.randomBytes(12).toString('hex')}`;
  const ts = () => Math.floor(clock.t / 1000);

  // Signed panel request: adds nonce/ts (headers + body) and checks the response signature + nonce echo.
  async function panel(url, body, { skipVerify = false, nonceOverride, tsOverride } = {}) {
    const n = nonceOverride ?? nonce();
    const t = tsOverride ?? ts();
    const res = await http.post(url).set('X-WHM-Nonce', n).set('X-WHM-Timestamp', String(t)).send({ ...body, nonce: n, ts: t });
    res.whmNonce = n;
    if (!skipVerify) {
      const sig = parseSignatureHeader(res.headers['x-whm-signature']);
      if (!sig) throw new Error(`unsigned response ${res.status} ${JSON.stringify(res.body)}`);
      const ok = ctx.keys.verify(canonicalize(res.body), sig.sig, { kid: sig.kid, purpose: 'license', encoding: 'base64url' });
      if (!ok) throw new Error('response signature does not verify');
      if (res.body.meta?.nonce !== n) throw new Error('response did not echo the nonce');
      res.signatureKid = sig.kid;
    }
    return res;
  }

  function issue(sku = 'whm-pro-annual', extra = {}) {
    return ctx.licenses.issue({ sku, customer: { email: `c${++counter}@example.test`, name: 'Customer' }, ...extra }, { actor: { principal: 'test', ip: '127.0.0.1' } });
  }

  async function activate(key, server = fp(), extra = {}) {
    return panel('/v1/activate', { key, ...server, hostname: 'srv.example.test', panel_version: '1.0.0', os: 'ubuntu-24.04', ...extra });
  }

  return {
    ctx, http, db, dir, clock, adminKey, admin, asKey, createApiKey, fp, nonce, ts, panel, issue, activate,
    advance: (ms) => { clock.t += ms; return clock.t; },
    close: async () => { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(extra)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  return out;
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
