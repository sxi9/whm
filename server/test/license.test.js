import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestApp, createMockAgent } from './support/app.js';
import { bootstrap } from '../src/index.js';
import { canonicalize, canonicalString } from '../src/lib/canonical.js';
import { loadLicenseKeys, kidOf, normalizeLicenseKey, fingerprintDrift, fingerprintMismatch, decodeToken, createLicenseService } from '../src/services/license.js';
import { featureGates, degradedAllow, isAllowedWhileDegraded, gatedFeatureFor, DEGRADED_ACTION } from '../src/middleware/license.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');
const HUB_KEYS = path.resolve(here, '..', '..', 'hub', 'test', 'fixtures', 'keys');
const KEYS_FILE = path.join(FIXTURES, 'license-keys.test.json');
const LICENSE_KID = '8456a2be';
const LICENSE_KID_B = '4619cf0e';
const PLUGIN_KID_A = 'bdee6a71';
const PLUGIN_KID_B = '742aaf57';
const DAY = 86400;
const HUB = 'https://hub.test';
const ISSUER = 'https://issuer.test';
const privOf = (kid) => crypto.createPrivateKey(fs.readFileSync(path.join(HUB_KEYS, `${kid}.ed25519`), 'utf8'));
const pubOf = (kid) => fs.readFileSync(path.join(HUB_KEYS, `${kid}.pub`), 'utf8');
const h = (s) => crypto.createHash('sha256').update(s).digest('hex');

const FP = { machine_id: h('mid'), mac: h('mac'), disk: h('disk') };
const fpOf = (c) => `sha256:${h(`whmfp1|${c.machine_id}|${c.mac}|${c.disk}`)}`;
const fingerprintOp = (components = FP) => () => ({ version: 'whmfp1', fingerprint: fpOf(components), components, available: { machine_id: true, mac: true, disk: true } });

const LIMITS = { max_accounts: -1, max_resellers: 5, max_activations: 1, max_domains_per_account: -1 };
const FEATURES = { api: true, transfers: true, marketplace_paid: true, clusters: false, white_label: false, terminal: false };

// A stand-in for the hub: signs every answer with a fixture LICENSE key, echoes
// the nonce and mints tokens the way hub/license/services/licenses.js does.
function createMockHub({ kid = LICENSE_KID, now = () => Date.now(), issuer = ISSUER, license = {}, pluginKeys, revocationsHeadTs = 1700000000 } = {}) {
  const priv = privOf(kid);
  const calls = [];
  const hub = {
    calls, now, kid,
    license: { ed: 'pro', rank: 30, lim: LIMITS, feat: FEATURES, lexpDays: 365, grace: 7, status: 'active', ...license },
    activationId: 'act_test0001', messages: [], revocationsHeadTs,
    pluginKeys: pluginKeys ?? [{ kid: PLUGIN_KID_A, pub: pubOf(PLUGIN_KID_A), status: 'active' }, { kid: PLUGIN_KID_B, pub: pubOf(PLUGIN_KID_B), status: 'retiring' }],
    handlers: {},
    tamper: null,
    mintToken({ fp, status, kid: tokenKid = kid, nonce, ttlS = 7 * DAY, overrides = {} } = {}) {
      const iat = Math.floor(now() / 1000);
      const lexp = iat + hub.license.lexpDays * DAY;
      const st = status ?? hub.license.status;
      const payload = {
        v: 1, iss: issuer, kid: tokenKid, lid: 'lic_test', aid: hub.activationId, cid: 'cus_test', ed: hub.license.ed, rank: hub.license.rank, lim: hub.license.lim, feat: hub.license.feat,
        fp, iat, nbf: iat - 300, exp: Math.min(iat + ttlS, lexp + hub.license.grace * DAY), lexp, grace: hub.license.grace, nonce: nonce || `n_${crypto.randomBytes(6).toString('hex')}`, status: st, ...overrides,
      };
      const bytes = canonicalize(payload);
      const sig = crypto.sign(null, bytes, privOf(tokenKid)).toString('base64url');
      return `WHMT1.${bytes.toString('base64url')}.${sig}`;
    },
    answer(body, { status = 200, data, error, nonce }) {
      const out = { ...(data ? { data } : {}), ...(error ? { error } : {}), meta: { nonce: nonce === undefined ? body.nonce : nonce } };
      const sig = crypto.sign(null, canonicalize(out), priv).toString('base64url');
      const res = { status, headers: { 'x-whm-signature': `kid=${kid},sig=${sig}` }, body: Buffer.from(JSON.stringify(out)) };
      return hub.tamper ? hub.tamper(res, out) : res;
    },
    extras() { return { plugin_signing_keys: hub.pluginKeys, revocations_head_ts: hub.revocationsHeadTs }; },
    transport: {
      async request(url, { method, body, headers }) {
        const parsed = JSON.parse(body.toString('utf8'));
        const u = new URL(url);
        calls.push({ url, method, headers, body: parsed });
        if (headers['X-WHM-Nonce'] !== parsed.nonce || String(parsed.ts) !== headers['X-WHM-Timestamp']) return hub.answer(parsed, { status: 400, error: { code: 'nonce_mismatch', message: 'header/body mismatch' } });
        const handler = hub.handlers[u.pathname];
        if (handler) return handler(parsed, hub);
        if (u.pathname === '/v1/activate' || u.pathname === '/v1/transfers') {
          return hub.answer(parsed, { data: { ...hub.extras(), token: hub.mintToken({ fp: parsed.fingerprint }), activation_id: hub.activationId, checkin_interval_hours: 12, messages: hub.messages, status: hub.license.status } });
        }
        if (u.pathname === '/v1/checkin') {
          return hub.answer(parsed, { data: { ...hub.extras(), token: hub.mintToken({ fp: parsed.fingerprint }), activation_id: hub.activationId, status: hub.license.status, revoked: false, license: { edition: hub.license.ed, expires_at: new Date((Math.floor(now() / 1000) + hub.license.lexpDays * DAY) * 1000).toISOString(), days_left: hub.license.lexpDays }, messages: hub.messages } });
        }
        if (u.pathname === '/v1/trial') {
          return hub.answer(parsed, { status: 201, data: { ...hub.extras(), key: 'WHM-TR1A-2B3C-4D5E-6F7G', token: hub.mintToken({ fp: parsed.fingerprint, overrides: { ed: 'trial', rank: 0, lim: { ...LIMITS, max_accounts: 5, max_resellers: 0 }, feat: { marketplace_free: true } } }), expires_at: new Date(now() + 14 * DAY * 1000).toISOString(), activation_id: hub.activationId, messages: [] } });
        }
        if (u.pathname === '/v1/deactivate') return hub.answer(parsed, { data: { deactivated: true } });
        return hub.answer(parsed, { status: 404, error: { code: 'not_found', message: `no route ${u.pathname}` } });
      },
    },
  };
  return hub;
}

async function bootPanel({ enforce = true, hubUrl = HUB, agent, overrides = {}, hub } = {}) {
  const mockAgent = agent || createMockAgent({ 'sys.fingerprint': fingerprintOp() });
  const app = await createTestApp({ agent: mockAgent, overrides: { licenseEnforce: enforce, licenseHubUrl: hubUrl, licenseKeysFile: KEYS_FILE, ...overrides } });
  const h2 = hub || createMockHub();
  app.ctx.license.transport = h2.transport;
  app.ctx.license.clock.now = () => h2.now();
  app.hub = h2;
  app.csrf = await app.login();
  app.post = (url, body = {}) => app.http.post(url).set('X-CSRF-Token', app.csrf).send(body);
  app.put = (url, body = {}) => app.http.put(url).set('X-CSRF-Token', app.csrf).send(body);
  return app;
}

const auditRows = (ctx, action) => ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
const eventRows = (ctx, event) => ctx.db.prepare('SELECT * FROM license_events WHERE event = ? ORDER BY id').all(event);

describe('canonical JSON parity', () => {
  it('matches the golden vectors shared with the hub and is byte-identical to hub/shared/canonical.js', () => {
    const vectors = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'canonical-vectors.json'), 'utf8'));
    expect(vectors.vectors.length).toBeGreaterThan(5);
    for (const v of vectors.vectors) {
      expect(canonicalString(v.value), v.name).toBe(v.canonical);
      expect(canonicalize(v.value).equals(Buffer.from(v.canonical, 'utf8')), v.name).toBe(true);
    }
    const hubCopy = path.resolve(here, '..', '..', 'hub', 'shared', 'canonical.js');
    if (fs.existsSync(hubCopy)) expect(fs.readFileSync(path.resolve(here, '..', 'src', 'lib', 'canonical.js'), 'utf8')).toBe(fs.readFileSync(hubCopy, 'utf8'));
    expect(() => canonicalize({ a: 1.5 })).toThrow();
    expect(canonicalString({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
  });
});

describe('pinned license keys and offline token verification', () => {
  it('loads the fixture keys, derives kids from the raw key and keeps the shipped file well-formed', () => {
    const keys = loadLicenseKeys(KEYS_FILE);
    expect(keys.map((k) => k.kid)).toEqual([LICENSE_KID, LICENSE_KID_B, expect.stringMatching(/^[0-9a-f]{8}$/)]);
    expect(keys[2].notAfter.getTime()).toBeLessThan(Date.now());
    expect(kidOf(pubOf(LICENSE_KID))).toBe(LICENSE_KID);
    const shipped = loadLicenseKeys(path.resolve(here, '..', 'src', 'services', 'license-keys.json'));
    expect(shipped.length).toBeGreaterThanOrEqual(2);
    for (const k of shipped) expect(k.kid).toMatch(/^[0-9a-f]{8}$/);
    expect(loadLicenseKeys('/nonexistent/keys.json')).toEqual([]);
  });

  it('verifies tokens: round-trip, tamper, unknown/retired kid, skew boundaries, drift', async () => {
    const app = await bootPanel();
    try {
      const { license } = app.ctx;
      const hub = app.hub;
      const t0 = Date.now();
      hub.now = () => t0;
      const good = hub.mintToken({ fp: fpOf(FP) });
      expect(license.verifyToken(good)).toMatchObject({ ok: true });
      expect(license.verifyToken(good.replace(/\.[^.]+$/, '.' + 'A'.repeat(86)))).toMatchObject({ ok: false, reason: 'bad_signature' });
      const { payload } = decodeToken(good);
      const tampered = `WHMT1.${Buffer.from(JSON.stringify({ ...payload, ed: 'enterprise' })).toString('base64url')}.${good.split('.')[2]}`;
      expect(license.verifyToken(tampered).ok).toBe(false);
      const unknownKid = `WHMT1.${canonicalize({ ...payload, kid: 'deadbeef' }).toString('base64url')}.${good.split('.')[2]}`;
      expect(license.verifyToken(unknownKid)).toMatchObject({ ok: false, reason: 'unknown_kid' });
      const retired = loadLicenseKeys(KEYS_FILE)[2].kid;
      expect(license.verifyToken(`WHMT1.${canonicalize({ ...payload, kid: retired }).toString('base64url')}.${good.split('.')[2]}`)).toMatchObject({ ok: false, reason: 'retired_kid' });
      expect(license.verifyToken(hub.mintToken({ fp: fpOf(FP), kid: LICENSE_KID_B }))).toMatchObject({ ok: true });
      expect(license.verifyToken(good, { at: (payload.nbf - 299) * 1000 }).ok).toBe(true);
      expect(license.verifyToken(good, { at: (payload.nbf - 301) * 1000 })).toMatchObject({ ok: false, reason: 'not_yet_valid' });
      expect(license.verifyToken(good, { at: (payload.exp + 299) * 1000 })).toMatchObject({ ok: true, expired: false });
      expect(license.verifyToken(good, { at: (payload.exp + 301) * 1000 })).toMatchObject({ ok: true, expired: true });
      expect(license.verifyToken('WHMT1.nope.nope')).toMatchObject({ ok: false, reason: 'malformed' });
      expect(fingerprintDrift(FP, { ...FP, mac: h('x') })).toBe(0.3);
      expect(fingerprintDrift(FP, { ...FP, mac: h('x'), disk: h('y') })).toBe(0.5);
      expect(fingerprintDrift(FP, { ...FP, machine_id: h('x'), mac: h('y') })).toBe(0.8);
      // offline binding: NIC + disk (0.5) is tolerated, a machine-id change alone never is
      expect(fingerprintMismatch(FP, { ...FP, mac: h('x'), disk: h('y') })).toBe(false);
      expect(fingerprintMismatch(FP, { ...FP, machine_id: h('x') })).toBe(true);
      expect(fingerprintMismatch(null, FP)).toBe(true);
      expect(normalizeLicenseKey('whm-7k3q m2df-9xa1-p0r6')).toBe('WHM-7K3Q-M2DF-9XA1-P0R6');
      expect(normalizeLicenseKey('WHM-7K3Q-M2DF-9XA1-P0RU')).toBe(null);
    } finally { await app.close(); }
  });
});

describe('activation, hub.request and hubUrl()', () => {
  it('activates through a signed answer, stores the key encrypted, pins keys and exposes the /api/license shape', async () => {
    const app = await bootPanel();
    try {
      const { ctx, hub } = app;
      expect(ctx.license.hubUrl()).toBe(HUB);
      expect(ctx.license.get().status).toBe('unlicensed');
      const res = await app.post('/api/license/key', { key: 'whm-7k3q-m2df-9xa1-p0r6' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'active', edition: 'pro', editionLabel: 'Pro', rank: 30, keyPrefix: 'WHM-7K3Q', activationId: 'act_test0001', hubUrl: ISSUER, hasKey: true, failCount: 0, enforce: true, degraded: false });
      expect(res.body.data.limits).toEqual(LIMITS);
      expect(res.body.data.features).toEqual(FEATURES);
      expect(res.body.data.pluginSigningKids).toEqual([PLUGIN_KID_B, PLUGIN_KID_A].sort());
      expect(res.body.data.revocationsHeadTs).toBe(1700000000);
      expect(res.body.data.daysLeft).toBe(365);
      expect(hub.calls[0].url).toBe(`${HUB}/v1/activate`);
      expect(hub.calls[0].body).toMatchObject({ key: 'WHM-7K3Q-M2DF-9XA1-P0R6', fingerprint: fpOf(FP), fp_components: FP, panel_version: expect.any(String), nonce: expect.stringMatching(/^n_[0-9a-f]{32}$/), ts: expect.any(Number) });
      expect(hub.calls[0].headers['Content-Type']).toBe('application/json');
      const row = ctx.db.prepare('SELECT * FROM license_state').get();
      expect(row.key_enc).toMatch(/^v1:/);
      expect(ctx.crypto.decrypt(row.key_enc)).toBe('WHM-7K3Q-M2DF-9XA1-P0R6');
      expect(row.token).toMatch(/^WHMT1\./);
      expect(JSON.stringify(row)).not.toContain('WHM-7K3Q-M2DF');
      expect(ctx.license.token()).toBe(row.token);
      expect(ctx.license.hubUrl()).toBe(ISSUER);

      const get = await app.http.get('/api/license');
      expect(get.status).toBe(200);
      for (const k of ['status', 'edition', 'rank', 'limits', 'features', 'activationId', 'keyPrefix', 'hubUrl', 'lexp', 'exp', 'lastCheckinAt', 'nextCheckinAt', 'failCount', 'messages', 'events', 'pinnedKeys', 'pluginSigningKids', 'daysLeft']) expect(get.body.data, k).toHaveProperty(k);
      expect(get.body.data.pinnedKeys.map((k) => k.kid)).toContain(LICENSE_KID);
      expect(JSON.stringify(get.body)).not.toContain('WHM-7K3Q-M2DF');
      expect(auditRows(ctx, 'license.activate')).toHaveLength(1);
      expect(auditRows(ctx, 'license.activated')).toHaveLength(1);
      expect(JSON.stringify(auditRows(ctx, 'POST /api/license/key'))).toContain('[redacted]');
      expect(JSON.stringify(auditRows(ctx, 'POST /api/license/key'))).not.toContain('7K3Q-M2DF');

      // check-ins go to the issuer named in the token, not the bootstrap URL
      const ci = await app.post('/api/license/checkin');
      expect(ci.status).toBe(200);
      expect(ci.body.data.ok).toBe(true);
      expect(hub.calls[1].url).toBe(`${ISSUER}/v1/checkin`);
      expect(hub.calls[1].body).toMatchObject({ token: expect.stringMatching(/^WHMT1\./), usage: { accounts: 0, resellers: 0, domains: 0, plugins: expect.any(Array) } });
      const sched = ctx.scheduler.list().find((s) => s.name === 'license.checkin');
      expect(sched).toBeTruthy();
      expect(sched.enabled).toBe(1);
      expect(sched.job_type).toBe('license.checkin');
      // the cron follows the jittered next_checkin_at (local time) at the hub's interval
      let next = new Date(ctx.license.get().nextCheckinAt);
      const tolerance = 20 * 60 * 1000 + 1000;
      expect(Math.abs(next.getTime() - (hub.now() + 12 * 3600 * 1000))).toBeLessThanOrEqual(tolerance);
      expect(sched.cron).toBe(`${next.getMinutes()} ${[next.getHours(), (next.getHours() + 12) % 24].sort((a, b) => a - b).join(',')} * * *`);
      expect(ctx.license.get().checkinIntervalHours).toBe(12);

      // the hub's checkin_interval_hours wins over the config default
      hub.handlers['/v1/checkin'] = (body) => hub.answer(body, { data: { ...hub.extras(), token: hub.mintToken({ fp: body.fingerprint }), activation_id: hub.activationId, status: 'active', checkin_interval_hours: 6, messages: [] } });
      expect((await app.post('/api/license/checkin')).body.data.ok).toBe(true);
      expect(ctx.license.get().checkinIntervalHours).toBe(6);
      next = new Date(ctx.license.get().nextCheckinAt);
      expect(Math.abs(next.getTime() - (hub.now() + 6 * 3600 * 1000))).toBeLessThanOrEqual(tolerance);
      const sched6 = ctx.scheduler.list().find((s) => s.name === 'license.checkin');
      expect(sched6.cron.split(' ')[0]).toBe(String(next.getMinutes()));
      expect(sched6.cron.split(' ')[1].split(',').map(Number)).toEqual([0, 6, 12, 18].map((o) => (next.getHours() + o) % 24).sort((a, b) => a - b));
      delete hub.handlers['/v1/checkin'];
      expect((await app.post('/api/license/checkin')).body.data.ok).toBe(true);
      expect(ctx.license.get().checkinIntervalHours).toBe(12);
      const me = await app.http.get('/api/auth/me');
      expect(me.body.data.license).toMatchObject({ status: 'active', edition: 'pro', daysLeft: 365, enforce: true, degraded: false });
      const status = await app.http.get('/api/system/status');
      expect(status.body.data.license).toMatchObject({ status: 'active', edition: 'pro', activations: '1/1' });
    } finally { await app.close(); }
  });

  it('rejects a tampered signature, a wrong nonce echo, an unknown kid, a plugin-key signature and an http:// hub', async () => {
    const app = await bootPanel();
    try {
      const { hub, ctx } = app;
      hub.tamper = (res) => ({ ...res, body: Buffer.from(res.body.toString('utf8').replace('"activation_id":"act_test0001"', '"activation_id":"act_evil0001"')) });
      let res = await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' });
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('hub_signature_invalid');
      expect(ctx.license.get().status).toBe('unlicensed');

      hub.tamper = (res) => ({ ...res, headers: { 'x-whm-signature': res.headers['x-whm-signature'].replace(/kid=[0-9a-f]{8}/, 'kid=deadbeef') } });
      res = await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' });
      expect(res.body.error.code).toBe('hub_signature_invalid');

      hub.tamper = (res, out) => {
        const sig = crypto.sign(null, canonicalize(out), privOf(PLUGIN_KID_A)).toString('base64url');
        return { ...res, headers: { 'x-whm-signature': `kid=${PLUGIN_KID_A},sig=${sig}` } };
      };
      res = await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' });
      expect(res.body.error.code).toBe('hub_signature_invalid');

      hub.tamper = null;
      hub.handlers['/v1/activate'] = (body, h2) => h2.answer(body, { data: { token: h2.mintToken({ fp: body.fingerprint }), activation_id: 'act_x', messages: [] }, nonce: 'n_replayed_nonce_value_0000' });
      res = await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' });
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('hub_nonce_mismatch');

      // a signed answer whose token is for another server is refused too
      hub.handlers['/v1/activate'] = (body, h2) => h2.answer(body, { data: { token: h2.mintToken({ fp: fpOf({ ...FP, machine_id: h('other'), mac: h('other') }) }), activation_id: 'act_x', messages: [] } });
      res = await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' });
      expect(res.body.error.code).toBe('hub_token_invalid');
      delete hub.handlers['/v1/activate'];

      expect(ctx.license.verifySigned(Buffer.from('{"a":1}'), 'kid=8456a2be,sig=AAAA')).toBe(false);
      const body = { data: { x: 1 }, meta: { nonce: 'n' } };
      const sig = crypto.sign(null, canonicalize(body), privOf(LICENSE_KID)).toString('base64url');
      expect(ctx.license.verifySigned(Buffer.from(JSON.stringify({ meta: body.meta, data: body.data })), `kid=${LICENSE_KID},sig=${sig}`)).toBe(true);
      expect(ctx.license.verifySigned(Buffer.from(JSON.stringify({ ...body, data: { x: 2 } })), `kid=${LICENSE_KID},sig=${sig}`)).toBe(false);

      // the hub being down is a 503 that changes nothing
      hub.transport.request = async () => { throw new Error('ECONNREFUSED'); };
      res = await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('hub_unreachable');
    } finally { await app.close(); }

    const insecure = await bootPanel({ hubUrl: 'http://hub.test' });
    try {
      const spy = vi.spyOn(insecure.hub.transport, 'request');
      const res = await insecure.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('hub_url_insecure');
      expect(spy).not.toHaveBeenCalled();
    } finally { await insecure.close(); }

    const unconfigured = await bootPanel({ hubUrl: null });
    try {
      const res = await unconfigured.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('hub_not_configured');
    } finally { await unconfigured.close(); }
  });

  it('surfaces activation_limit with the hub activations list, validates the key and supports transfer', async () => {
    const app = await bootPanel();
    try {
      const { hub } = app;
      hub.handlers['/v1/activate'] = (body, h2) => h2.answer(body, { status: 409, error: { code: 'activation_limit', message: '1 of 1 activations in use', activations: [{ id: 'act_old', hostname: 'old.acme.example', last_checkin: '2026-10-20T07:11:00Z' }] } });
      let res = await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('activation_limit');
      expect(res.body.error.fields.activations[0].hostname).toBe('old.acme.example');
      const acts = await app.http.get('/api/license/activations');
      expect(acts.body.data.others[0]).toMatchObject({ id: 'act_old', hostname: 'old.acme.example' });
      res = await app.post('/api/license/key', { key: 'not a key' });
      expect(res.status).toBe(422);
      res = await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6', transferFrom: 'act_old' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(hub.calls.at(-1).url).toBe(`${HUB}/v1/transfers`);
      expect(hub.calls.at(-1).body.from_activation).toBe('act_old');
      expect(res.body.data.status).toBe('active');
      expect((await app.http.get('/api/license/activations')).body.data.current).toMatchObject({ id: 'act_test0001', current: true });
    } finally { await app.close(); }
  });

  it('starts a trial, deactivates and re-activates with the stored key', async () => {
    const app = await bootPanel();
    try {
      const { hub, ctx } = app;
      let res = await app.post('/api/license/trial', { email: 'ops@acme.example' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'active', edition: 'trial', keyPrefix: 'WHM-TR1A', hasKey: true });
      expect(hub.calls.at(-1).body).toMatchObject({ email: 'ops@acme.example', fingerprint: fpOf(FP) });
      res = await app.post('/api/license/trial', { email: 'ops@acme.example' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('already_licensed');
      res = await app.post('/api/license/deactivate', { reason: 'migrating' });
      expect(res.status).toBe(200);
      expect(res.body.data.license).toMatchObject({ status: 'unlicensed', hasKey: true, activationId: null });
      expect(hub.calls.at(-1).url).toBe(`${ISSUER}/v1/deactivate`);
      expect(hub.calls.at(-1).body).toMatchObject({ token: expect.stringMatching(/^WHMT1\./), reason: 'migrating' });
      expect(ctx.scheduler.list().find((s) => s.name === 'license.checkin').enabled).toBe(0);
      expect(auditRows(ctx, 'license.deactivated')).toHaveLength(1);
      res = await app.post('/api/license/deactivate', {});
      expect(res.status).toBe(409);
      res = await app.post('/api/license/key', {});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(hub.calls.at(-1).body.key).toBe('WHM-TR1A-2B3C-4D5E-6F7G');
      expect(res.body.data.status).toBe('active');
    } finally { await app.close(); }
  });
});

describe('state machine and events', () => {
  it('stays active through hub outages, then grace, then degraded on the clock alone (no agent op)', async () => {
    const app = await bootPanel();
    try {
      const { hub, ctx, agent } = app;
      const t0 = Date.now();
      hub.now = () => t0;
      expect((await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' })).status).toBe(200);
      const notify = vi.fn(async () => ({ sent: 0 }));
      ctx.contacts = { ...(ctx.contacts || {}), notify };
      const seen = [];
      ctx.license.on('status_changed', (e) => seen.push(e));

      hub.transport.request = async () => { throw new Error('ETIMEDOUT'); };
      let ci = await app.post('/api/license/checkin');
      expect(ci.body.data).toMatchObject({ ok: false, code: 'hub_unreachable', failCount: 1, status: 'active' });
      ci = await app.post('/api/license/checkin');
      ci = await app.post('/api/license/checkin');
      expect(ci.body.data.failCount).toBe(3);
      expect(notify).toHaveBeenCalledWith('license.checkin_failed', expect.objectContaining({ severity: 'warning' }));
      expect(auditRows(ctx, 'license.checkin_failed')).toHaveLength(3);
      expect(ctx.license.get().status).toBe('active');

      agent.calls.length = 0;
      hub.now = () => t0 + (6 * DAY) * 1000;
      expect(ctx.license.get().status).toBe('active');
      hub.now = () => t0 + (7 * DAY + 400) * 1000;
      expect(ctx.license.get().status).toBe('grace');
      expect(ctx.license.isDegraded()).toBe(false);
      expect((await app.http.get('/api/auth/me')).body.data.license).toMatchObject({ status: 'grace', degraded: false });
      expect((await app.post('/api/packages', { name: 'grace-pkg' })).status).toBe(201);
      hub.now = () => t0 + (14 * DAY + 400) * 1000;
      expect(ctx.license.get().status).toBe('degraded');
      expect(ctx.license.isDegraded()).toBe(true);
      expect(ctx.license.get().reason).toBe('grace_elapsed');
      expect(seen.map((e) => `${e.from}>${e.to}`)).toEqual(['active>grace', 'grace>degraded']);
      expect(eventRows(ctx, 'license.grace_started')).toHaveLength(1);
      expect(eventRows(ctx, 'license.degraded')).toHaveLength(1);
      expect(auditRows(ctx, 'license.grace_started')).toHaveLength(1);
      expect(auditRows(ctx, 'license.degraded')).toHaveLength(1);
      expect(notify).toHaveBeenCalledWith('license.grace_started', expect.objectContaining({ severity: 'warning' }));
      expect(notify).toHaveBeenCalledWith('license.degraded', expect.objectContaining({ severity: 'error' }));
      expect(agent.calls).toEqual([]);
      expect(ctx.db.prepare('SELECT status FROM license_state').get().status).toBe('degraded');

      // a fresh signed check-in brings it back
      hub.transport.request = createMockHub({ now: hub.now }).transport.request;
      ci = await app.post('/api/license/checkin');
      expect(ci.body.data).toMatchObject({ ok: true, status: 'active' });
      expect(seen.at(-1)).toMatchObject({ from: 'degraded', to: 'active' });
      expect(auditRows(ctx, 'license.activated').length).toBe(2);
    } finally { await app.close(); }
  });

  it('honours revoked, deactivated and fingerprint_mismatch check-in answers and delivers messages', async () => {
    const app = await bootPanel();
    try {
      const { hub, ctx } = app;
      expect((await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' })).status).toBe(200);
      const messages = [];
      ctx.license.on('message', (m) => messages.push(m));
      hub.messages = [{ level: 'warning', code: 'fingerprint_updated', text: 'NIC replaced' }, { level: 'info', code: 'plugin_revocations_pending', text: 'poll' }];
      hub.revocationsHeadTs = 1700000500;
      let ci = await app.post('/api/license/checkin');
      expect(ci.body.data.ok).toBe(true);
      expect(messages.map((m) => m.code)).toEqual(expect.arrayContaining(['revocations_head_ts', 'fingerprint_updated', 'plugin_revocations_pending']));
      expect(messages.find((m) => m.code === 'revocations_head_ts').value).toBe(1700000500);
      expect(ctx.license.get().revocationsHeadTs).toBe(1700000500);
      expect(ctx.license.get().messages.map((m) => m.code)).toEqual(['fingerprint_updated', 'plugin_revocations_pending']);
      expect(auditRows(ctx, 'license.fingerprint_changed')).toHaveLength(1);
      hub.messages = [];

      // drift travels as an integer percent (the hub cannot sign a float); a partial clone is 80 %
      hub.handlers['/v1/checkin'] = (body, h2) => h2.answer(body, { status: 409, error: { code: 'fingerprint_mismatch', message: 'cloned', drift_pct: 80, activations: [{ id: 'act_test0001', hostname: 'srv', last_checkin: null }] } });
      ci = await app.post('/api/license/checkin');
      expect(ci.body.data).toMatchObject({ ok: false, code: 'fingerprint_mismatch', status: 'degraded' });
      expect(ctx.license.get().reason).toBe('fingerprint_mismatch');
      expect(ctx.license.get().hubDriftPct).toBe(80);
      expect(ctx.license.get().knownActivations).toEqual([{ id: 'act_test0001', hostname: 'srv', last_checkin: null }]);
      expect((await app.post('/api/accounts', { username: 'blocked', domain: 'blocked.example', password: 'Str0ng-Passw0rd!' })).status).toBe(423);

      delete hub.handlers['/v1/checkin'];
      ci = await app.post('/api/license/checkin');
      expect(ci.body.data).toMatchObject({ ok: true, status: 'active' });
      expect(ctx.license.get().hubDriftPct).toBe(null);
      // an out-of-range drift field is ignored rather than persisted
      hub.handlers['/v1/checkin'] = (body, h2) => h2.answer(body, { status: 409, error: { code: 'fingerprint_mismatch', message: 'cloned', drift_pct: 180 } });
      await app.post('/api/license/checkin');
      expect(ctx.license.get().reason).toBe('fingerprint_mismatch');
      expect(ctx.license.get().hubDriftPct).toBe(null);
      delete hub.handlers['/v1/checkin'];
      await app.post('/api/license/checkin');

      hub.handlers['/v1/checkin'] = (body, h2) => h2.answer(body, { status: 403, error: { code: 'deactivated', message: 'transferred' } });
      ci = await app.post('/api/license/checkin');
      expect(ci.body.data).toMatchObject({ ok: false, code: 'deactivated', status: 'degraded' });
      delete hub.handlers['/v1/checkin'];
      await app.post('/api/license/checkin');

      hub.handlers['/v1/checkin'] = (body, h2) => h2.answer(body, { status: 403, error: { code: 'revoked', message: 'License revoked: chargeback', revoked_at: '2026-10-26T00:00:00Z' } });
      ci = await app.post('/api/license/checkin');
      expect(ci.body.data).toMatchObject({ ok: false, code: 'revoked', status: 'revoked' });
      expect(ctx.license.get().status).toBe('revoked');
      expect(eventRows(ctx, 'license.revoked')).toHaveLength(1);
      expect((await app.post('/api/packages', { name: 'nope' })).status).toBe(423);
      expect((await app.http.get('/api/system/status')).body.data.license.status).toBe('revoked');

      // the hub flips it to suspended/expired through token status
      hub.handlers['/v1/checkin'] = (body, h2) => h2.answer(body, { data: { token: h2.mintToken({ fp: body.fingerprint, status: 'suspended' }), activation_id: h2.activationId, status: 'suspended', messages: [] } });
      ci = await app.post('/api/license/checkin');
      expect(ci.body.data).toMatchObject({ ok: true, status: 'suspended' });
      expect(eventRows(ctx, 'license.suspended')).toHaveLength(1);
      hub.handlers['/v1/checkin'] = (body, h2) => h2.answer(body, { data: { token: h2.mintToken({ fp: body.fingerprint, status: 'expired' }), activation_id: h2.activationId, status: 'expired', messages: [] } });
      ci = await app.post('/api/license/checkin');
      expect(ci.body.data).toMatchObject({ ok: true, status: 'expired' });
      expect(eventRows(ctx, 'license.expired')).toHaveLength(1);
    } finally { await app.close(); }
  });

  it('notifies license.expiring once per threshold', async () => {
    const hub = createMockHub({ license: { lexpDays: 10 } });
    const app = await bootPanel({ hub });
    try {
      const notify = vi.fn(async () => ({ sent: 0 }));
      app.ctx.contacts = { notify };
      expect((await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' })).status).toBe(200);
      await app.post('/api/license/checkin');
      const expiring = notify.mock.calls.filter((c) => c[0] === 'license.expiring');
      expect(expiring).toHaveLength(1);
      expect(expiring[0][1].data.daysLeft).toBe(10);
      expect(eventRows(app.ctx, 'license.expiring')).toHaveLength(1);
    } finally { await app.close(); }
  });

  it('verifies the stored token offline at boot: valid → active, past grace → degraded, cloned server → degraded, NIC change tolerated', async () => {
    const app = await bootPanel();
    const dir = app.dir;
    const t0 = Date.now();
    app.hub.now = () => t0;
    try {
      expect((await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' })).status).toBe(200);
    } finally { app.ctx.jobs.stop(); app.ctx.scheduler.stop(); app.ctx.sessionStore.close(); app.ctx.db.close(); }

    const reboot = async (agent, now) => bootstrap({ dataDir: dir, dbPath: path.join(dir, 'whm.db'), adminPassword: 'Test-Passw0rd!1', logLevel: 'silent', mode: 'monolithic', agent, licenseEnforce: true, licenseHubUrl: HUB, licenseKeysFile: KEYS_FILE, licenseNow: now });
    const closeCtx = (ctx) => { ctx.jobs.stop(); ctx.scheduler.stop(); ctx.sessionStore.close(); ctx.db.close(); };

    let ctx = await reboot(createMockAgent({ 'sys.fingerprint': fingerprintOp() }), () => t0 + 60_000);
    expect(ctx.license.get()).toMatchObject({ status: 'active', edition: 'pro', activationId: 'act_test0001' });
    expect(ctx.license.hubUrl()).toBe(ISSUER);
    expect(ctx.agent.calls.filter((c) => /^(user|fs|dns|web|mail|db|acct)\./.test(c.name))).toEqual([]);
    closeCtx(ctx);

    ctx = await reboot(createMockAgent({ 'sys.fingerprint': fingerprintOp({ ...FP, mac: h('new-nic') }) }), () => t0 + 60_000);
    expect(ctx.license.get().status).toBe('active');
    closeCtx(ctx);

    ctx = await reboot(createMockAgent({ 'sys.fingerprint': fingerprintOp({ ...FP, machine_id: h('cloned'), mac: h('cloned') }) }), () => t0 + 60_000);
    expect(ctx.license.get()).toMatchObject({ status: 'degraded', reason: 'fingerprint_mismatch' });
    closeCtx(ctx);

    ctx = await reboot(createMockAgent({ 'sys.fingerprint': fingerprintOp() }), () => t0 + 60_000);
    expect(ctx.license.get().status).toBe('active');
    closeCtx(ctx);

    // a machine-id change alone (same NIC and disk: a restored image) is a mismatch offline, and the hub is asked to arbitrate
    ctx = await reboot(createMockAgent({ 'sys.fingerprint': fingerprintOp({ ...FP, machine_id: h('reinstalled') }) }), () => t0 + 60_000);
    expect(ctx.license.get()).toMatchObject({ status: 'degraded', reason: 'fingerprint_mismatch' });
    expect(ctx.jobs.list({ type: 'license.checkin' }).some((j) => j.params?.reason === 'fingerprint_mismatch')).toBe(true);
    closeCtx(ctx);

    ctx = await reboot(createMockAgent({ 'sys.fingerprint': fingerprintOp() }), () => t0 + 60_000);
    expect(ctx.license.get().status).toBe('active');
    closeCtx(ctx);

    ctx = await reboot(createMockAgent({ 'sys.fingerprint': fingerprintOp() }), () => t0 + (15 * DAY) * 1000);
    expect(ctx.license.get()).toMatchObject({ status: 'degraded', reason: 'grace_elapsed' });
    expect(ctx.jobs.list({ type: 'license.checkin' }).length).toBeGreaterThan(0);
    closeCtx(ctx);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('queues a transition found at boot until the Contact Manager exists, then delivers it once', async () => {
    const app = await bootPanel();
    try {
      const { ctx } = app;
      const t0 = Date.now();
      app.hub.now = () => t0;
      expect((await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' })).status).toBe(200);
      // boot() runs before the categories register ctx.contacts: the grace → degraded transition must not be lost
      const bare = { ...ctx, contacts: undefined, config: { ...ctx.config, licenseNow: () => t0 + 15 * DAY * 1000 } };
      const svc = createLicenseService(bare);
      expect((await svc.boot()).status).toBe('degraded');
      expect(eventRows(ctx, 'license.degraded').length).toBeGreaterThan(0);
      const notify = vi.fn(async () => ({ sent: 1 }));
      expect(svc.flushNotifications()).toBe(0);
      bare.contacts = { notify };
      expect(svc.flushNotifications()).toBe(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toBe('license.degraded');
      expect(notify.mock.calls[0][1]).toMatchObject({ severity: 'error', subject: expect.stringContaining('degraded'), data: { from: 'active', to: 'degraded', reason: 'grace_elapsed' } });
      expect(svc.flushNotifications()).toBe(0);
      svc.get();
      expect(notify).toHaveBeenCalledTimes(1);
      // bootstrap() flushes once the app exists
      expect(typeof ctx.license.flushNotifications).toBe('function');
    } finally { await app.close(); }
  });

  it('never lets an unverifiable stored token steer the hub URL or report entitlements', async () => {
    const app = await bootPanel();
    try {
      const { ctx, hub } = app;
      expect((await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' })).status).toBe(200);
      expect(ctx.license.hubUrl()).toBe(ISSUER);
      expect(ctx.license.get()).toMatchObject({ tokenVerified: true, edition: 'pro' });
      // a row written straight into the DB, signed by a key the release does not pin
      const rogue = hub.mintToken({ fp: fpOf(FP), kid: PLUGIN_KID_A, overrides: { iss: 'https://rogue.example', feat: { ...FEATURES, terminal: true }, ed: 'enterprise' } });
      ctx.db.prepare("UPDATE license_state SET token = ?, status = 'active' WHERE id = 1").run(rogue);
      ctx.license._reload();
      expect(ctx.license.hubUrl()).toBe(HUB);
      const l = ctx.license.get();
      expect(l).toMatchObject({ status: 'degraded', reason: 'unknown_kid', tokenVerified: false, hasToken: true, edition: null, editionLabel: null, rank: null, limits: {}, features: {}, lexp: null, daysLeft: null, hubUrl: HUB });
      expect(ctx.license.hasFeature('terminal')).toBe(false);
      expect(ctx.license.hasFeature('api')).toBe(false);
      expect((await app.http.get('/api/license')).body.data).toMatchObject({ tokenVerified: false, features: {} });
      // the next check-in goes to the bootstrap hub, which re-issues a verifiable token
      expect((await app.post('/api/license/checkin')).body.data.ok).toBe(true);
      expect(hub.calls.at(-1).url).toBe(`${HUB}/v1/checkin`);
      expect(ctx.license.get()).toMatchObject({ status: 'active', tokenVerified: true, hubUrl: ISSUER });
    } finally { await app.close(); }
  });
});

describe('degraded gate, feature gates and capacity', () => {
  it('exposes the concrete lists and matches them as documented', () => {
    expect(Object.keys(featureGates)).toEqual(['ALL /transfers', 'ALL /clusters', 'ALL /dns/zones/import', 'ALL /server-config/terminal', 'POST /development/tokens', 'PUT /themes/config', 'POST /marketplace/install', 'POST /marketplace/update/:id']);
    expect(degradedAllow).toContain('POST /accounts/:username/unsuspend');
    expect(isAllowedWhileDegraded('POST', '/auth/logout')).toBe(true);
    expect(isAllowedWhileDegraded('POST', '/license/key')).toBe(true);
    expect(isAllowedWhileDegraded('POST', '/system/services/httpd/restart')).toBe(true);
    expect(isAllowedWhileDegraded('POST', '/system/services/httpd/stop')).toBe(false);
    expect(isAllowedWhileDegraded('DELETE', '/backup/destinations/3')).toBe(true);
    expect(isAllowedWhileDegraded('POST', '/accounts/bob/unsuspend')).toBe(true);
    expect(isAllowedWhileDegraded('POST', '/accounts/bob/suspend')).toBe(false);
    expect(isAllowedWhileDegraded('POST', '/accounts')).toBe(false);
    expect(isAllowedWhileDegraded('POST', '/backupx')).toBe(false);
    expect(gatedFeatureFor('GET', '/transfers/sessions')).toBe('transfers');
    expect(gatedFeatureFor('POST', '/dns/zones/import')).toBe('clusters');
    expect(gatedFeatureFor('POST', '/dns/zones')).toBe(null);
    expect(gatedFeatureFor('POST', '/development/tokens')).toBe('api');
    expect(gatedFeatureFor('GET', '/development/tokens')).toBe(null);
    expect(gatedFeatureFor('POST', '/development/tokens/3/expire')).toBe(null);
    expect(gatedFeatureFor('PUT', '/themes/config')).toBe('white_label');
    expect(gatedFeatureFor('POST', '/marketplace/install')).toBe(null);
    expect(gatedFeatureFor('POST', '/server-config/terminal/abc/input')).toBe('terminal');
    // Express routes case-insensitively, so the rules must match the same way
    expect(gatedFeatureFor('POST', '/Transfers/sessions')).toBe('transfers');
    expect(gatedFeatureFor('post', '/development/Tokens')).toBe('api');
    expect(gatedFeatureFor('PUT', '/THEMES/CONFIG')).toBe('white_label');
    expect(gatedFeatureFor('POST', '/DNS/Zones/Import')).toBe('clusters');
    expect(isAllowedWhileDegraded('POST', '/License/Key')).toBe(true);
    expect(isAllowedWhileDegraded('POST', '/Accounts/bob/Unsuspend')).toBe(true);
    expect(isAllowedWhileDegraded('POST', '/Accounts')).toBe(false);
  });

  it('answers 423 to every other mutation while unlicensed, lets GETs and the rescue routes through', async () => {
    const app = await bootPanel();
    try {
      const { ctx } = app;
      const blocked = [
        () => app.post('/api/accounts', { username: 'alice', domain: 'alice.example', password: 'Str0ng-Passw0rd!' }),
        () => app.put('/api/packages/default', { diskMb: 100 }),
        () => app.post('/api/dns/zones', { domain: 'zone.example' }),
        () => app.http.post('/api/plugins/manage/install').set('X-CSRF-Token', app.csrf).set('Content-Type', 'application/octet-stream').send(Buffer.from('x')),
        () => app.post('/api/packages', { name: 'blocked' }),
        () => app.post('/api/system/services/httpd/stop'),
      ];
      for (const send of blocked) {
        const res = await send();
        expect(res.status).toBe(423);
        expect(res.body.error).toMatchObject({ code: 'license_degraded', status: 'unlicensed', action: DEGRADED_ACTION });
        expect(res.body.error.message).toContain('keep running');
      }
      for (const url of ['/api/system/status', '/api/accounts', '/api/packages', '/api/plugins/ui', '/api/license', '/api/auth/me', '/api/system/services', '/api/transfers/sessions', '/api/clusters/peers', '/api/development/tokens']) {
        const res = await app.http.get(url);
        expect(res.status, url).toBe(200);
      }
      // without a license there are no entitlements to judge by: feature-gated prefixes degrade like everything else
      for (const url of ['/api/transfers/sessions', '/api/Transfers/sessions', '/api/development/tokens', '/api/dns/zones/import']) {
        const res = await app.post(url, {});
        expect(res.status, url).toBe(423);
        expect(res.body.error.code, url).toBe('license_degraded');
      }
      const allowed = [
        ['/api/system/services/httpd/restart', () => app.post('/api/system/services/httpd/restart')],
        ['/api/system/services/httpd/start', () => app.post('/api/system/services/httpd/start')],
        ['/api/system/services/httpd/reload', () => app.post('/api/system/services/httpd/reload')],
        ['/api/backup/destinations', () => app.post('/api/backup/destinations', {})],
        ['/api/accounts/nobody/unsuspend', () => app.post('/api/accounts/nobody/unsuspend')],
        ['/api/license/checkin', () => app.post('/api/license/checkin')],
        ['/api/auth/password', () => app.post('/api/auth/password', { newPassword: 'short' })],
      ];
      for (const [url, send] of allowed) {
        const res = await send();
        expect(res.status, url).not.toBe(423);
      }
      expect(ctx.agent.calls.filter((c) => /^(user|fs|dns|web|mail|db|acct)\./.test(c.name))).toEqual([]);
      // the audit middleware still records the refused mutation
      expect(auditRows(ctx, 'POST /api/accounts').at(-1).result).toBe('error:423');
    } finally { await app.close(); }
  });

  it('is inert when enforcement is off (development default)', async () => {
    const app = await bootPanel({ enforce: false });
    try {
      expect(app.ctx.license.enforce()).toBe(false);
      expect((await app.post('/api/packages', { name: 'dev-pkg' })).status).toBe(201);
      expect((await app.http.get('/api/auth/me')).body.data.license).toMatchObject({ status: 'unlicensed', enforce: false });
      expect(app.ctx.license.get().degraded).toBe(true);
    } finally { await app.close(); }
  });

  it('gates features by flag and reports capacity limits with the designed messages', async () => {
    const hub = createMockHub({ license: { ed: 'solo', rank: 10, lim: { max_accounts: 0, max_resellers: 0, max_activations: 1, max_domains_per_account: -1 }, feat: { api: false, transfers: false, clusters: false, white_label: false, terminal: false, marketplace_free: true } } });
    const app = await bootPanel({ hub });
    try {
      const { ctx } = app;
      expect((await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' })).status).toBe(200);
      let res = await app.post('/api/development/tokens', { name: 'x', scopes: ['*'] });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'feature_required', fields: { feature: ['api'] } });
      expect(res.body.error.message).toContain('Solo license does not include "api"');
      expect((await app.http.get('/api/development/tokens')).status).toBe(200);
      res = await app.put('/api/themes/config', {});
      expect(res.status).toBe(403);
      expect(res.body.error.fields.feature).toEqual(['white_label']);
      res = await app.post('/api/dns/zones/import', { domain: 'x.example', body: '' });
      expect(res.status).toBe(403);
      expect(res.body.error.fields.feature).toEqual(['clusters']);
      expect((await app.http.get('/api/transfers/sessions')).status).toBe(403);
      // mixed-case paths reach the same routers and meet the same gate
      for (const [send, feature] of [[() => app.post('/api/Transfers/sessions', {}), 'transfers'], [() => app.post('/api/development/Tokens', { name: 'x', scopes: ['*'] }), 'api'], [() => app.put('/api/Themes/config', {}), 'white_label'], [() => app.post('/api/Server-config/terminal', {}), 'terminal']]) {
        res = await send();
        expect(res.status, feature).toBe(403);
        expect(res.body.error, feature).toMatchObject({ code: 'feature_required', fields: { feature: [feature] } });
      }
      expect(ctx.license.hasFeature('marketplace_free')).toBe(true);
      expect(ctx.license.hasFeature('api')).toBe(false);

      res = await app.post('/api/accounts', { username: 'alice', domain: 'alice.example', password: 'Str0ng-Passw0rd!' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'license_limit', fields: { limit: 0, used: 0 } });
      expect(res.body.error.message).toBe('Your Solo license allows 0 hosting accounts (0 in use). Upgrade to Pro to add more.');
      expect(ctx.agent.callsTo('user.create')).toEqual([]);
      await expect(ctx.resellers.create({ username: 'res1', password: 'Str0ng-Passw0rd!', acls: [] }, { id: 1, username: 'root', role: 'root' }, null)).rejects.toMatchObject({ code: 'license_limit', limit: 0, used: 0 });

      // requireFeature as a reusable middleware
      const mw = ctx.license.requireFeature('transfers');
      const next = vi.fn();
      mw({}, {}, next);
      expect(next.mock.calls[0][0]).toMatchObject({ status: 403, code: 'feature_required' });

      // an upgrade arrives at the next check-in
      hub.license.feat = { ...hub.license.feat, api: true };
      hub.license.lim = { ...hub.license.lim, max_accounts: 25 };
      await app.post('/api/license/checkin');
      expect((await app.post('/api/development/tokens', { name: 'x', scopes: ['*'] })).status).not.toBe(403);
      expect(ctx.license.get().limits.max_accounts).toBe(25);
    } finally { await app.close(); }
  });
});

describe('plugin signing key pinning', () => {
  it('writes, keeps retiring, removes dropped kids, never overwrites an operator file and audits the conflict', async () => {
    const app = await bootPanel();
    try {
      const { ctx, hub } = app;
      const keysDir = path.join(app.dir, 'plugin-keys');
      fs.mkdirSync(keysDir, { recursive: true });
      const operatorPem = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
      fs.writeFileSync(path.join(keysDir, `${PLUGIN_KID_B}.pub`), operatorPem);
      const notify = vi.fn(async () => ({ sent: 0 }));
      ctx.contacts = { notify };
      const changes = [];
      ctx.license.on('keys_changed', (e) => changes.push(e));
      hub.pluginKeys = [...hub.pluginKeys, { kid: 'ffffffff', pub: pubOf(PLUGIN_KID_A), status: 'active' }, { kid: LICENSE_KID, pub: pubOf(LICENSE_KID), status: 'active' }];

      expect((await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' })).status).toBe(200);
      expect(fs.readFileSync(path.join(keysDir, `${PLUGIN_KID_A}.pub`), 'utf8')).toBe(pubOf(PLUGIN_KID_A));
      expect((fs.statSync(path.join(keysDir, `${PLUGIN_KID_A}.pub`)).mode & 0o777).toString(8)).toBe('640');
      expect(fs.readFileSync(path.join(keysDir, `${PLUGIN_KID_B}.pub`), 'utf8')).toBe(operatorPem);
      expect(fs.existsSync(path.join(keysDir, 'ffffffff.pub'))).toBe(false);
      expect(fs.existsSync(path.join(keysDir, `${LICENSE_KID}.pub`))).toBe(false);
      expect(ctx.license.pluginSigningKids()).toEqual([PLUGIN_KID_A]);
      expect(ctx.license.get().conflictKids).toEqual([PLUGIN_KID_B, LICENSE_KID].sort());
      expect(auditRows(ctx, 'license.plugin_key_conflict').map((r) => JSON.parse(r.args_redacted).kid).sort()).toEqual([PLUGIN_KID_B, LICENSE_KID].sort());
      expect(notify.mock.calls.filter((c) => c[0] === 'license.plugin_key_conflict')).toHaveLength(2);
      expect(changes).toHaveLength(1);

      // operator removes their file: the hub key is pinned at the next check-in; a second check-in changes nothing
      fs.unlinkSync(path.join(keysDir, `${PLUGIN_KID_B}.pub`));
      hub.pluginKeys = [{ kid: PLUGIN_KID_A, pub: pubOf(PLUGIN_KID_A), status: 'active' }, { kid: PLUGIN_KID_B, pub: pubOf(PLUGIN_KID_B), status: 'retiring' }];
      await app.post('/api/license/checkin');
      expect(ctx.license.pluginSigningKids()).toEqual([PLUGIN_KID_A, PLUGIN_KID_B].sort());
      expect(fs.readFileSync(path.join(keysDir, `${PLUGIN_KID_B}.pub`), 'utf8')).toBe(pubOf(PLUGIN_KID_B));
      const n = changes.length;
      await app.post('/api/license/checkin');
      expect(changes).toHaveLength(n);

      // pending keys are written but not trusted yet; a dropped kid is removed only when we wrote it
      hub.pluginKeys = [{ kid: PLUGIN_KID_A, pub: pubOf(PLUGIN_KID_A), status: 'pending' }];
      await app.post('/api/license/checkin');
      expect(fs.existsSync(path.join(keysDir, `${PLUGIN_KID_A}.pub`))).toBe(true);
      expect(fs.existsSync(path.join(keysDir, `${PLUGIN_KID_B}.pub`))).toBe(false);
      expect(ctx.license.pluginSigningKids()).toEqual([]);
      fs.writeFileSync(path.join(keysDir, `${PLUGIN_KID_A}.pub`), operatorPem);
      hub.pluginKeys = [];
      await app.post('/api/license/checkin');
      expect(fs.readFileSync(path.join(keysDir, `${PLUGIN_KID_A}.pub`), 'utf8')).toBe(operatorPem);
      expect(ctx.license.get().pluginSigningKids).toEqual([]);
    } finally { await app.close(); }
  });
});

describe('plugin signing key ownership', () => {
  it('trusts an operator-installed key identical to the hub key but never removes it when the hub drops the kid', async () => {
    const app = await bootPanel();
    try {
      const { ctx, hub } = app;
      const keysDir = path.join(app.dir, 'plugin-keys');
      fs.mkdirSync(keysDir, { recursive: true });
      const fileB = path.join(keysDir, `${PLUGIN_KID_B}.pub`);
      fs.writeFileSync(fileB, pubOf(PLUGIN_KID_B), { mode: 0o644 });
      expect((await app.post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' })).status).toBe(200);
      expect(ctx.license.pluginSigningKids()).toEqual([PLUGIN_KID_A, PLUGIN_KID_B].sort());
      expect(ctx.license.get().conflictKids).toEqual([]);
      expect((fs.statSync(fileB).mode & 0o777).toString(8)).toBe('644');
      expect(JSON.parse(ctx.db.prepare('SELECT payload_json FROM license_state WHERE id = 1').get().payload_json).pluginKeys[PLUGIN_KID_B]).toMatchObject({ operator: true });

      hub.pluginKeys = [{ kid: PLUGIN_KID_A, pub: pubOf(PLUGIN_KID_A), status: 'active' }];
      await app.post('/api/license/checkin');
      expect(ctx.license.pluginSigningKids()).toEqual([PLUGIN_KID_A]);
      expect(fs.readFileSync(fileB, 'utf8')).toBe(pubOf(PLUGIN_KID_B));

      // ours is removed when dropped; the operator's file still stays
      hub.pluginKeys = [];
      await app.post('/api/license/checkin');
      expect(fs.existsSync(path.join(keysDir, `${PLUGIN_KID_A}.pub`))).toBe(false);
      expect(fs.existsSync(fileB)).toBe(true);
      expect(ctx.license.pluginSigningKids()).toEqual([]);

      // listed again: trusted again, still the operator's
      hub.pluginKeys = [{ kid: PLUGIN_KID_B, pub: pubOf(PLUGIN_KID_B), status: 'active' }];
      await app.post('/api/license/checkin');
      expect(ctx.license.pluginSigningKids()).toEqual([PLUGIN_KID_B]);
      hub.pluginKeys = [];
      await app.post('/api/license/checkin');
      expect(fs.existsSync(fileB)).toBe(true);
    } finally { await app.close(); }
  });
});

describe('service construction', () => {
  it('registers the check-in job and reports its pinned kids', async () => {
    const app = await bootPanel();
    try {
      expect(app.ctx.jobs.types()).toContain('license.checkin');
      expect(app.ctx.license.keys().map((k) => k.kid)).toContain(LICENSE_KID);
      expect(typeof createLicenseService).toBe('function');
      const job = await app.ctx.jobs.enqueue('license.checkin', {});
      expect(job).toBeTruthy();
    } finally { await app.close(); }
  });
});
