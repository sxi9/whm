import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { packageFromFiles } from './support/tar.js';
import { canonicalize } from '../src/lib/canonical.js';
import { loadCommonJs, REPO_ROOT } from '../src/lib/plugin-sdk.js';
import { INSTALL_JOB, UPDATE_JOB, REVOCATIONS_JOB, UPDATE_CHECK_JOB, REVOCATIONS_SCHEDULE, UPDATE_CHECK_SCHEDULE, SCHEDULES_SETTING } from '../src/services/marketplace-client.js';
import { MAX_RESPONSE_BYTES } from '../src/services/license.js';
import { MAX_PACKAGE_BYTES } from '../src/services/plugins.js';

// §18.10 "Panel client": the hub is a recorded-fixture mock behind
// ctx.license.transport; nothing here opens a socket.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');
const HUB_FIXTURES = path.join(FIXTURES, 'hub');
const HUB_KEYS = path.resolve(here, '..', '..', 'hub', 'test', 'fixtures', 'keys');
const KEYS_FILE = path.join(FIXTURES, 'license-keys.test.json');
const LICENSE_KID = '8456a2be';
const PLUGIN_KID_A = 'bdee6a71';
const PLUGIN_KID_B = '742aaf57';
const DAY = 86400;
const HUB = 'https://hub.test';
const fixtures = loadCommonJs(path.join(REPO_ROOT, 'plugins', 'sdk', 'test', 'fixtures.js'));
const pack = loadCommonJs(path.join(REPO_ROOT, 'plugins', 'sdk', 'pack.js'));
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(HUB_FIXTURES, name), 'utf8'));
const privOf = (kid) => crypto.createPrivateKey(fs.readFileSync(path.join(HUB_KEYS, `${kid}.ed25519`), 'utf8'));
const privPemOf = (kid) => fs.readFileSync(path.join(HUB_KEYS, `${kid}.ed25519`), 'utf8');
const pubOf = (kid) => fs.readFileSync(path.join(HUB_KEYS, `${kid}.pub`), 'utf8');
const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const FP = { machine_id: h('mid'), mac: h('mac'), disk: h('disk') };
const fpOf = (c) => `sha256:${h(`whmfp1|${c.machine_id}|${c.mac}|${c.disk}`)}`;
const LIMITS = { max_accounts: -1, max_resellers: 5, max_activations: 1, max_domains_per_account: -1 };
const FEATURES = { api: true, transfers: true, marketplace_free: true, marketplace_paid: true, clusters: false, white_label: false, terminal: false };

const MAIN = "module.exports = { async activate(ctx) { ctx.log.info('up'); }, async deactivate() {} };\n";
function files(manifest) {
  return { 'plugin.json': JSON.stringify(manifest), 'main.js': MAIN };
}
function signFiles(f, kid) {
  const lines = Object.keys(f).sort().map((n) => `${n} ${sha256(f[n])}`);
  const digest = crypto.createHash('sha256').update(lines.join('\n')).digest();
  return { ...f, 'SIGNATURE.json': JSON.stringify({ kid, alg: 'ed25519', sig: crypto.sign(null, digest, privOf(kid)).toString('base64') }) };
}
const signedPackage = (manifest, kid = PLUGIN_KID_A) => packageFromFiles(signFiles(files(manifest), kid));
const unsignedPackage = (manifest) => packageFromFiles(files(manifest));

// The hub: signs every answer with the fixture LICENSE key, echoes the nonce,
// mints tokens, and serves the recorded catalog plus whatever packages a test
// publishes.
function createMockHub({ now = () => Date.now(), features = FEATURES, edition = 'pro' } = {}) {
  const priv = privOf(LICENSE_KID);
  const calls = [];
  const hub = {
    calls, now, features, edition, revocationsHeadTs: 0, messages: [],
    packages: new Map(), downloads: new Map(), revocations: readFixture('revocations.json').data.slice(0, 0), feedNow: null, feedHeadTs: null, updates: readFixture('updates.json').data,
    publish(id, { version, buffer, kid = PLUGIN_KID_A, channel = 'stable', pricing = { model: 'free' } }) {
      const list = hub.packages.get(id) || [];
      list.push({ version, buffer, sha256: sha256(buffer), bytes: buffer.length, kid, channel, pricing });
      hub.packages.set(id, list);
    },
    mintToken({ fp, nonce } = {}) {
      const iat = Math.floor(now() / 1000);
      const payload = { v: 1, iss: HUB, kid: LICENSE_KID, lid: 'lic_test', aid: 'act_test0001', cid: 'cus_test', ed: edition, rank: 30, lim: LIMITS, feat: hub.features, fp, iat, nbf: iat - 300, exp: iat + 7 * DAY, lexp: iat + 365 * DAY, grace: 7, nonce: nonce || `n_${crypto.randomBytes(6).toString('hex')}`, status: 'active' };
      const bytes = canonicalize(payload);
      return `WHMT1.${bytes.toString('base64url')}.${crypto.sign(null, bytes, priv).toString('base64url')}`;
    },
    answer(body, { status = 200, data, error, meta = {}, nonce } = {}) {
      const out = { ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}), meta: { ...meta, nonce: nonce === undefined ? body.nonce : nonce } };
      const sig = crypto.sign(null, canonicalize(out), priv).toString('base64url');
      return { status, headers: { 'x-whm-signature': `kid=${LICENSE_KID},sig=${sig}` }, body: Buffer.from(JSON.stringify(out)) };
    },
    plain(status, obj) { return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(obj)) }; },
    extras() { return { plugin_signing_keys: [{ kid: PLUGIN_KID_A, pub: pubOf(PLUGIN_KID_A), status: 'active' }, { kid: PLUGIN_KID_B, pub: pubOf(PLUGIN_KID_B), status: 'retiring' }], revocations_head_ts: hub.revocationsHeadTs }; },
    get(u) {
      const p = u.pathname;
      if (p === '/v1/market/catalog') {
        const cat = readFixture('catalog.json');
        const q = (u.searchParams.get('q') || '').toLowerCase();
        const category = u.searchParams.get('category');
        const data = cat.data.filter((e) => (!q || e.name.toLowerCase().includes(q) || e.id.includes(q)) && (!category || e.category.slug === category));
        return hub.plain(200, { data, meta: { ...cat.meta, total: data.length } });
      }
      if (p === '/v1/market/categories') return hub.plain(200, readFixture('categories.json'));
      const detail = /^\/v1\/market\/plugins\/([^/]+)$/.exec(p);
      if (detail) {
        const id = decodeURIComponent(detail[1]);
        const published = hub.packages.get(id);
        const entry = readFixture('catalog.json').data.find((e) => e.id === id) || (published && { id, name: id, slug: id, summary: 'test package', developer: { slug: 'test', display_name: 'Test', verified: true }, category: null, pricing: published[0].pricing, latest: { version: published.at(-1).version, channel: 'stable' }, install_count: 0, rating_avg: null, rating_count: 0, featured: false, icon_url: null });
        if (!entry) return hub.plain(404, { error: { code: 'not_found', message: 'Plugin not found' } });
        const extra = readFixture('plugin-detail.json')[id] || { permissions: [], compatibility: null, changelog: [], reviews: [], screenshots: [], bundled_editions: [] };
        const versions = (hub.packages.get(id) || []).map((v) => ({ version: v.version, channel: v.channel, published_at: '2026-10-20T10:00:00Z', engines_whm: '>=1.0.0', package_sha256: v.sha256, package_bytes: v.bytes, permissions: [], kid: v.kid }));
        return hub.plain(200, { data: { ...entry, ...extra, versions: { stable: versions[versions.length - 1] || null, beta: null, all: versions } } });
      }
      const versions = /^\/v1\/market\/plugins\/([^/]+)\/versions$/.exec(p);
      if (versions) return hub.plain(200, { data: (hub.packages.get(decodeURIComponent(versions[1])) || []).map((v) => ({ version: v.version, channel: v.channel, published_at: '2026-10-20T10:00:00Z', engines_whm: '>=1.0.0', package_sha256: v.sha256, package_bytes: v.bytes, permissions: [], kid: v.kid })) });
      const dl = /^\/v1\/market\/packages\/(dl_[A-Za-z0-9]+)$/.exec(p);
      if (dl) {
        const d = hub.downloads.get(dl[1]);
        if (!d || d.fetched) return hub.plain(410, { error: { code: 'download_consumed', message: 'already fetched' } });
        if (u.searchParams.get('sig') !== d.sig) return hub.plain(403, { error: { code: 'download_sig_invalid', message: 'bad signature' } });
        d.fetched = true;
        return { status: 200, headers: { 'content-type': 'application/gzip' }, body: hub.tamperPackage ? hub.tamperPackage(d.pkg.buffer) : d.pkg.buffer };
      }
      return hub.plain(404, { error: { code: 'not_found', message: `no route ${p}` } });
    },
    post(u, parsed) {
      const p = u.pathname;
      if (p === '/v1/activate') return hub.answer(parsed, { data: { ...hub.extras(), token: hub.mintToken({ fp: parsed.fingerprint }), activation_id: 'act_test0001', checkin_interval_hours: 12, messages: hub.messages, status: 'active' } });
      if (p === '/v1/checkin') return hub.answer(parsed, { data: { ...hub.extras(), token: hub.mintToken({ fp: parsed.fingerprint }), activation_id: 'act_test0001', status: 'active', revoked: false, license: { edition, expires_at: new Date(now() + 365 * DAY * 1000).toISOString(), days_left: 365 }, messages: hub.messages } });
      if (p === '/v1/deactivate') return hub.answer(parsed, { data: { deactivated: true } });
      if (p === '/v1/market/download') {
        if (!/^WHMT1\./.test(parsed.token || '')) return hub.answer(parsed, { status: 401, error: { code: 'token_invalid', message: 'no token' } });
        if (!parsed.fingerprint) return hub.answer(parsed, { status: 422, error: { code: 'validation_failed', message: 'fingerprint is required' } });
        const list = hub.packages.get(parsed.plugin_id) || [];
        const pkg = parsed.version ? list.find((v) => v.version === parsed.version) : list[list.length - 1];
        if (!pkg) return hub.answer(parsed, { status: 404, error: { code: 'not_found', message: 'Published version not found' } });
        if (pkg.pricing.model !== 'free' && hub.features.marketplace_paid !== true) return hub.answer(parsed, { status: 403, error: { code: 'feature_required', message: 'paid plugins need marketplace_paid', feature: 'marketplace_paid' } });
        if (pkg.pricing.model !== 'free' && !hub.entitled) return hub.answer(parsed, { status: 402, error: { code: 'entitlement_required', message: `${parsed.plugin_id} is a paid plugin`, pricing: pkg.pricing, buy_url: `${HUB}/buy` } });
        const id = `dl_${crypto.randomBytes(9).toString('hex').toUpperCase().slice(0, 18)}`;
        const exp = Math.floor(now() / 1000) + 900;
        const sig = crypto.createHmac('sha256', 'download-hmac').update(`${id}|act_test0001|${exp}`).digest('base64url');
        hub.downloads.set(id, { pkg, sig, fetched: false });
        const url = `${hub.downloadBase || HUB}/v1/market/packages/${id}?exp=${exp}&sig=${sig}`;
        return hub.answer(parsed, { data: { url, sha256: hub.wrongSha ? sha256('nope') : pkg.sha256, bytes: pkg.bytes, kid: pkg.kid, version: pkg.version, plugin_id: parsed.plugin_id, expires_at: new Date(exp * 1000).toISOString(), entitlement: { kind: 'free', status: 'active' } } });
      }
      if (p === '/v1/market/updates') {
        const ids = new Set((parsed.installed || []).map((i) => i.id));
        return hub.answer(parsed, { data: hub.updates.filter((u2) => ids.has(u2.id) || !u2.known), meta: { now: Math.floor(now() / 1000) } });
      }
      if (p === '/v1/market/revocations') {
        const rows = hub.revocations.filter((r) => r.ts > (parsed.since || 0));
        const head = hub.revocations.reduce((m, r) => Math.max(m, r.ts), 0);
        return hub.answer(parsed, { data: rows, meta: { now: hub.feedNow ?? Math.floor(now() / 1000), head_ts: hub.feedHeadTs ?? head } });
      }
      const review = /^\/v1\/market\/plugins\/([^/]+)\/reviews$/.exec(p);
      if (review) return hub.answer(parsed, { status: 201, data: { id: 'rev_new', status: 'pending', plugin_id: decodeURIComponent(review[1]), rating: parsed.rating } });
      return hub.answer(parsed, { status: 404, error: { code: 'not_found', message: `no route ${p}` } });
    },
    transport: {
      async request(url, { method = 'POST', body, headers = {} } = {}) {
        const u = new URL(url);
        const parsed = body ? JSON.parse(body.toString('utf8')) : null;
        calls.push({ url, method, headers, body: parsed });
        if (method === 'GET') return hub.get(u);
        if (headers['X-WHM-Nonce'] !== parsed.nonce || String(parsed.ts) !== headers['X-WHM-Timestamp']) return hub.answer(parsed, { status: 400, error: { code: 'nonce_mismatch', message: 'header/body mismatch' } });
        const res = hub.post(u, parsed);
        return hub.tamper ? hub.tamper(res) : res;
      },
    },
  };
  return hub;
}

let app;
let hub;
let tmp;
let csrf;
let realTransport;
const post = (url, body = {}) => app.http.post(url).set('X-CSRF-Token', csrf).send(body);
const put = (url, body = {}) => app.http.put(url).set('X-CSRF-Token', csrf).send(body);
const del = (url) => app.http.delete(url).set('X-CSRF-Token', csrf);
const get = (url) => app.http.get(url);
const installRaw = (buf) => app.http.post('/api/plugins/manage/install').set('X-CSRF-Token', csrf).set('Content-Type', 'application/gzip').send(buf);
const audits = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
const installRow = (id) => app.ctx.db.prepare('SELECT * FROM marketplace_installs WHERE plugin_id = ?').get(id);
const stateRow = () => app.ctx.db.prepare('SELECT * FROM marketplace_state').get();
const schedulesEnabled = () => [REVOCATIONS_SCHEDULE, UPDATE_CHECK_SCHEDULE].map((name) => app.ctx.scheduler.list().find((s) => s.name === name)?.enabled);
const pluginRow = (id) => app.ctx.db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
const runJob = async (res) => { expect(res.status, JSON.stringify(res.body)).toBe(202); return waitForJob(app.ctx, res.body.data.job.id, 15_000); };
const notified = [];

async function enableHubRow(url = `${HUB}/`) {
  await put('/api/market/providers/whm-hub/config', { url, config: {} }).expect(200);
  await post('/api/market/providers/whm-hub/enable').expect(200);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-market-'));
  hub = createMockHub();
  const agent = createMockAgent({ 'sys.fingerprint': () => ({ version: 'whmfp1', fingerprint: fpOf(FP), components: FP, available: { machine_id: true, mac: true, disk: true } }) });
  app = await createTestApp({ agent, overrides: { licenseEnforce: true, licenseHubUrl: HUB, licenseKeysFile: KEYS_FILE } });
  // The license API belongs to the panel owner (requireSuperadmin): the suite's root is made the super admin.
  app.ctx.db.prepare("UPDATE users SET superadmin = 1 WHERE username = 'root'").run();
  realTransport = app.ctx.license.transport;
  app.ctx.license.transport = hub.transport;
  app.ctx.license.clock.now = () => hub.now();
  app.ctx.jobs.start();
  csrf = await app.login();
  const realNotify = app.ctx.contacts.notify;
  app.ctx.contacts.notify = (event, payload, req) => { notified.push({ event, payload }); return realNotify(event, payload, req); };
  hub.publish('net.example.minimal', { version: '1.0.0', buffer: signedPackage(fixtures.minimalManifest({ id: 'net.example.minimal', version: '1.0.0' })) });
  hub.publish('net.example.scoped', { version: '1.0.0', buffer: signedPackage(fixtures.minimalManifest({ id: 'net.example.scoped', name: 'Scoped', version: '1.0.0', permissions: ['accounts:read', 'store:own'] })) });
  hub.publish('net.example.scoped', { version: '1.0.1', buffer: signedPackage(fixtures.minimalManifest({ id: 'net.example.scoped', name: 'Scoped', version: '1.0.1', permissions: ['accounts:read', 'store:own', 'contacts:notify'] })) });
  hub.publish('net.example.paid', { version: '2.1.0', buffer: signedPackage(fixtures.minimalManifest({ id: 'net.example.paid', name: 'Paid', version: '2.1.0', permissions: ['settings:own'] })), pricing: { model: 'one_time', amount_cents: 4900, currency: 'USD' } });
});
afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('hub identity', () => {
  it('reports the marketplace disabled while the whm-hub row is off and keeps the static catalog reachable', async () => {
    const status = (await get('/api/marketplace/status').expect(200)).body.data;
    expect(status).toMatchObject({ enabled: false, hubMismatch: false, hubUrl: HUB, licenseStatus: 'unlicensed', hubKids: [], pendingUpdates: [], developerMode: false });
    expect((await get('/api/marketplace/catalog')).status).toBe(422);
    expect((await get('/api/marketplace/catalog')).body.error.code).toBe('marketplace_disabled');
    // Unlicensed + enforce: the license gate locks every mutation before the marketplace client sees it.
    const locked = await post('/api/marketplace/install', { pluginId: 'net.example.minimal' });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('license_degraded');
    expect(() => app.ctx.marketplace.requireHub()).toThrow(expect.objectContaining({ code: 'marketplace_disabled' }));
    expect((await get('/api/server-config/marketplace').expect(200)).body.data.items.length).toBeGreaterThan(0);
    const schedules = app.ctx.scheduler.list().filter((s) => [REVOCATIONS_SCHEDULE, UPDATE_CHECK_SCHEDULE].includes(s.name));
    expect(schedules.map((s) => s.enabled)).toEqual([0, 0]);
    expect(hub.calls.filter((c) => c.url.startsWith('http://'))).toEqual([]);
  });

  it('activates the license, pins the hub plugin keys and refuses a provider row on another origin (hub_mismatch)', async () => {
    const act = await post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect(app.ctx.license.pluginSigningKids()).toEqual([PLUGIN_KID_B, PLUGIN_KID_A].sort());
    expect(fs.existsSync(path.join(app.dir, 'plugin-keys', `${PLUGIN_KID_A}.pub`))).toBe(true);
    await enableHubRow('https://other.test/');
    const status = (await get('/api/marketplace/status').expect(200)).body.data;
    expect(status).toMatchObject({ enabled: true, url: 'https://other.test/', hubUrl: HUB, hubMismatch: true, licenseStatus: 'active', hubKids: [PLUGIN_KID_B, PLUGIN_KID_A].sort(), hasToken: true });
    const res = await post('/api/marketplace/install', { pluginId: 'net.example.minimal' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('hub_mismatch');
    expect((await get('/api/marketplace/catalog')).body.error.code).toBe('hub_mismatch');
    expect(hub.calls.filter((c) => c.url.includes('other.test'))).toEqual([]);
    const schedules = app.ctx.scheduler.list().filter((s) => [REVOCATIONS_SCHEDULE, UPDATE_CHECK_SCHEDULE].includes(s.name));
    expect(schedules.map((s) => s.enabled)).toEqual([0, 0]);
  });

  it('serves the hub catalog through the license transport once the origins match, annotated with local state', async () => {
    // Re-pointing the row at the license hub is enough: the Market service calls onHubChanged().
    await put('/api/market/providers/whm-hub/config', { url: `${HUB}/`, config: {} }).expect(200);
    expect(schedulesEnabled()).toEqual([1, 1]);
    expect(app.ctx.settings.get(SCHEDULES_SETTING)).toBe(true);
    const status = (await get('/api/marketplace/status').expect(200)).body.data;
    expect(status).toMatchObject({ enabled: true, hubMismatch: false });
    const cat = await get('/api/marketplace/catalog?q=scoped').expect(200);
    expect(cat.body.data.map((e) => e.id)).toEqual(['net.example.scoped']);
    expect(cat.body.data[0].installed).toBeNull();
    expect(cat.body.meta).toMatchObject({ page: 1, total: 1 });
    expect((await get('/api/marketplace/catalog?category=developer-tools').expect(200)).body.data.map((e) => e.id)).toEqual(['net.example.minimal', 'net.whm.sample-notes']);
    expect((await get('/api/marketplace/categories').expect(200)).body.data.map((c) => c.slug)).toContain('security');
    const detail = (await get('/api/marketplace/plugins/net.example.scoped').expect(200)).body.data;
    expect(detail.permissions.map((p) => p.scope)).toEqual(['accounts:read', 'store:own']);
    expect(detail.permissions[0].justification).toMatch(/report/);
    expect(detail.versions.all.map((v) => v.version)).toEqual(['1.0.0', '1.0.1']);
    expect((await get('/api/marketplace/plugins/net.example.scoped/versions').expect(200)).body.data).toHaveLength(2);
    expect((await get('/api/marketplace/plugins/net.example.nothere')).status).toBe(404);
    const gets = hub.calls.filter((c) => c.method === 'GET');
    expect(gets.length).toBeGreaterThan(3);
    for (const c of gets) { expect(c.url.startsWith(`${HUB}/v1/market/`)).toBe(true); expect(c.headers.Authorization).toBeUndefined(); }
    expect(hub.calls.filter((c) => c.url.startsWith('http://'))).toEqual([]);
    expect((await get('/api/marketplace/catalog?category=BAD!')).status).toBe(422);
  });

  it('switches the schedules from the Market service hook on every whm-hub row change and never from a read', async () => {
    // An operator's own toggle survives reads: status and catalog are pure.
    app.ctx.scheduler.update(REVOCATIONS_SCHEDULE, { enabled: false });
    const settingsBefore = app.ctx.settings.get(SCHEDULES_SETTING);
    await get('/api/marketplace/status').expect(200);
    await get('/api/marketplace/catalog').expect(200);
    await get('/api/marketplace/categories').expect(200);
    await get('/api/marketplace/plugins/net.example.scoped').expect(200);
    expect(schedulesEnabled()).toEqual([0, 1]);
    expect(app.ctx.settings.get(SCHEDULES_SETTING)).toBe(settingsBefore);
    // Disabling the row switches both off immediately, with no marketplace call in between.
    await post('/api/market/providers/whm-hub/disable').expect(200);
    expect(schedulesEnabled()).toEqual([0, 0]);
    expect(app.ctx.settings.get(SCHEDULES_SETTING)).toBe(false);
    expect((await get('/api/marketplace/catalog')).status).toBe(422);
    expect(schedulesEnabled()).toEqual([0, 0]);
    // Enabling flips both on without a subsequent catalog read.
    await post('/api/market/providers/whm-hub/enable').expect(200);
    expect(schedulesEnabled()).toEqual([1, 1]);
    expect(app.ctx.settings.get(SCHEDULES_SETTING)).toBe(true);
    // Re-pointing the row off the license origin (hub_mismatch) switches them off; back on restores them.
    await put('/api/market/providers/whm-hub/config', { url: 'https://other.test/', config: {} }).expect(200);
    expect(schedulesEnabled()).toEqual([0, 0]);
    await put('/api/market/providers/whm-hub', { url: `${HUB}/` }).expect(200);
    expect(schedulesEnabled()).toEqual([1, 1]);
    const cron = app.ctx.scheduler.list().find((s) => s.name === REVOCATIONS_SCHEDULE).cron;
    app.ctx.marketplace.boot();
    expect(app.ctx.scheduler.list().find((s) => s.name === REVOCATIONS_SCHEDULE).cron).toBe(cron);
    expect(schedulesEnabled()).toEqual([1, 1]);
  });
});

describe('install flow', () => {
  it('downloads through hub.request, checks the sha256 and signature, consents against the installed manifest and enables', async () => {
    const job = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.minimal' }));
    expect(job.status, job.error).toBe('done');
    expect(job.result).toMatchObject({ status: 'installed', pluginId: 'net.example.minimal', version: '1.0.0', enabled: true });
    const plugin = (await get('/api/plugins/manage/net.example.minimal').expect(200)).body.data;
    expect(plugin).toMatchObject({ state: 'enabled', signed: true, signer: PLUGIN_KID_A, source: 'marketplace', version: '1.0.0' });
    expect(installRow('net.example.minimal')).toMatchObject({ version: '1.0.0', consent_state: 'consented', consented_by: 'root', hub_kid: PLUGIN_KID_A, package_sha256: hub.packages.get('net.example.minimal')[0].sha256 });
    expect(fs.existsSync(path.join(app.ctx.marketplace.cacheDir, 'net.example.minimal-1.0.0.whmplugin'))).toBe(false);
    const dl = hub.calls.find((c) => c.url === `${HUB}/v1/market/download`);
    expect(dl.body).toMatchObject({ plugin_id: 'net.example.minimal', token: expect.stringMatching(/^WHMT1\./), fingerprint: fpOf(FP), host_api: '1.0.0', channel: 'stable' });
    expect(dl.headers['X-WHM-Nonce']).toBe(dl.body.nonce);
    expect(audits('plugin.marketplace.install').at(-1)).toMatchObject({ principal: 'root', target: 'net.example.minimal' });
    expect(JSON.parse(audits('plugin.marketplace.install').at(-1).args_redacted)).toMatchObject({ consent: 'consented', kid: PLUGIN_KID_A });
    const cat = (await get('/api/marketplace/catalog?q=minimal').expect(200)).body.data[0];
    expect(cat.installed).toMatchObject({ version: '1.0.0', state: 'enabled', marketplace: true, consentState: 'consented' });
    expect((await get('/api/marketplace/installs').expect(200)).body.data.map((r) => r.pluginId)).toEqual(['net.example.minimal']);
  });

  it('holds a plugin whose installed manifest asks for more than the request consented to (pending_consent, disabled) until POST /consent', async () => {
    const job = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.scoped', version: '1.0.0', consent: { permissions: ['store:own'] } }));
    expect(job.status, job.error).toBe('done');
    expect(job.result).toEqual({ status: 'pending_consent', pluginId: 'net.example.scoped', version: '1.0.0', required: ['accounts:read', 'store:own'], added: ['accounts:read', 'store:own'], justifications: { 'accounts:read': 'The report lists every account and its package.', 'store:own': 'Caches the last report.' } });
    expect(pluginRow('net.example.scoped').state).toBe('installed');
    expect(app.ctx.plugins.isLive('net.example.scoped')).toBe(false);
    expect(installRow('net.example.scoped')).toMatchObject({ consent_state: 'pending', consented_by: null, was_enabled: 1 });
    const incomplete = await post('/api/marketplace/consent/net.example.scoped', { permissions: ['store:own'] });
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.error).toMatchObject({ code: 'consent_incomplete', fields: { permissions: ['accounts:read'] } });
    expect(pluginRow('net.example.scoped').state).toBe('installed');
    const ok = await post('/api/marketplace/consent/net.example.scoped', { permissions: ['accounts:read', 'store:own', 'extra:ignored'] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.plugin.state).toBe('enabled');
    expect(ok.body.data.install).toMatchObject({ consentState: 'consented', consentedBy: 'root', consentedPermissions: ['accounts:read', 'extra:ignored', 'store:own'] });
    expect(installRow('net.example.scoped')).toMatchObject({ consent_state: 'consented', consented_by: 'root' });
    expect(audits('plugin.consent').at(-1)).toMatchObject({ principal: 'root', target: 'net.example.scoped' });
    expect((await post('/api/marketplace/consent/net.example.nothere', { permissions: [] })).status).toBe(404);
  });

  it('refuses unsigned, foreign-key and tampered packages even with plugins.require_signature off', async () => {
    expect(app.ctx.settings.get('plugins.require_signature')).toBe(false);
    hub.publish('net.example.unsigned', { version: '1.0.0', buffer: unsignedPackage(fixtures.minimalManifest({ id: 'net.example.unsigned', version: '1.0.0' })) });
    const unsigned = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.unsigned' }));
    expect(unsigned.status).toBe('failed');
    expect(unsigned.error_code).toBe('unsigned_package');
    expect(pluginRow('net.example.unsigned')).toBeUndefined();

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const strangerFiles = files(fixtures.minimalManifest({ id: 'net.example.stranger', version: '1.0.0' }));
    const lines = Object.keys(strangerFiles).sort().map((n) => `${n} ${sha256(strangerFiles[n])}`);
    const digest = crypto.createHash('sha256').update(lines.join('\n')).digest();
    fs.writeFileSync(path.join(app.dir, 'plugin-keys', 'operator.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
    hub.publish('net.example.stranger', { version: '1.0.0', kid: 'operator', buffer: packageFromFiles({ ...strangerFiles, 'SIGNATURE.json': JSON.stringify({ kid: 'operator', alg: 'ed25519', sig: crypto.sign(null, digest, privateKey).toString('base64') }) }) });
    const stranger = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.stranger' }));
    expect(stranger.status).toBe('failed');
    expect(stranger.error_code).toBe('untrusted_signer');
    expect(pluginRow('net.example.stranger')).toBeUndefined();

    hub.wrongSha = true;
    hub.publish('net.example.shamismatch', { version: '1.0.0', buffer: signedPackage(fixtures.minimalManifest({ id: 'net.example.shamismatch', version: '1.0.0' })) });
    const sha = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.shamismatch' }));
    hub.wrongSha = false;
    expect(sha.status).toBe('failed');
    expect(sha.error_code).toBe('sha256_mismatch');
    expect(pluginRow('net.example.shamismatch')).toBeUndefined();
    expect(fs.readdirSync(app.ctx.marketplace.cacheDir)).toEqual([]);

    hub.tamperPackage = (buf) => Buffer.concat([buf, Buffer.from('x')]);
    const tampered = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.shamismatch' }));
    hub.tamperPackage = null;
    expect(tampered.status).toBe('failed');
    expect(tampered.error_code).toBe('sha256_mismatch');
  });

  it('refuses a downgrade unless allowDowngrade and never offers a sideloaded or bundled id for update', async () => {
    hub.publish('net.example.minimal', { version: '0.9.0', buffer: signedPackage(fixtures.minimalManifest({ id: 'net.example.minimal', version: '0.9.0' })) });
    const fetches = () => hub.calls.filter((c) => c.url.includes('/v1/market/packages/')).length;
    const n0 = fetches();
    const refused = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.minimal', version: '0.9.0' }));
    expect(refused.status).toBe('failed');
    expect(refused.error_code).toBe('downgrade_refused');
    expect(pluginRow('net.example.minimal').version).toBe('1.0.0');
    expect(fetches()).toBe(n0);
    const allowed = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.minimal', version: '0.9.0', allowDowngrade: true }));
    expect(allowed.status, allowed.error).toBe('done');
    expect(allowed.result).toMatchObject({ status: 'installed', version: '0.9.0' });
    expect(pluginRow('net.example.minimal')).toMatchObject({ version: '0.9.0', state: 'enabled' });
    const back = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.minimal', version: '1.0.0' }));
    expect(back.result).toMatchObject({ status: 'installed', version: '1.0.0' });
    app.ctx.settings.set('plugins.developer_mode', true);
    expect((await installRaw(unsignedPackage(fixtures.minimalManifest({ id: 'net.example.sideload', version: '1.0.0' })))).status).toBe(201);
    app.ctx.settings.set('plugins.developer_mode', false);
    expect((await post('/api/marketplace/update/net.example.sideload')).body.error.code).toBe('not_marketplace');
    expect((await post('/api/marketplace/install', { pluginId: 'net.example.sideload' })).body.error.code).toBe('not_marketplace');
    expect((await post('/api/marketplace/update/net.whm.server-monitoring')).body.error.code).toBe('not_marketplace');
    expect((await post('/api/marketplace/install', { pluginId: 'bad id' })).status).toBe(422);
  });

  it('stops an update that adds scopes at pending_consent with the plugin disabled, re-enables on consent and clears the pending update', async () => {
    const check = await post('/api/marketplace/updates/check');
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body.data).toEqual([{ id: 'net.example.scoped', current: '1.0.0', latest: '1.0.1', channel: 'stable', security: false, changelogUrl: 'https://hub.test/v1/market/plugins/net.example.scoped/versions' }]);
    const sent = hub.calls.find((c) => c.url === `${HUB}/v1/market/updates`).body;
    expect(sent.installed.map((i) => i.id).sort()).toEqual(['net.example.minimal', 'net.example.scoped']);
    expect(sent.installed.every((i) => Object.keys(i).sort().join() === 'id,version')).toBe(true);
    expect(notified.filter((n) => n.event === 'plugin.update_available')).toHaveLength(1);
    expect(audits('plugin.update_available')).toHaveLength(1);
    expect((await get('/api/marketplace/updates').expect(200)).body.data.pending).toHaveLength(1);
    expect((await get('/api/marketplace/status').expect(200)).body.data.pendingUpdates[0].latest).toBe('1.0.1');
    expect((await post('/api/marketplace/updates/check').expect(200)).body.data).toHaveLength(1);
    expect(notified.filter((n) => n.event === 'plugin.update_available')).toHaveLength(1);

    expect(pluginRow('net.example.scoped').state).toBe('enabled');
    const job = await runJob(await post('/api/marketplace/update/net.example.scoped'));
    expect(job.type).toBe(UPDATE_JOB);
    expect(job.status, job.error).toBe('done');
    expect(job.result).toMatchObject({ status: 'pending_consent', pluginId: 'net.example.scoped', version: '1.0.1', required: ['accounts:read', 'contacts:notify', 'store:own'], added: ['contacts:notify'] });
    expect(pluginRow('net.example.scoped')).toMatchObject({ version: '1.0.1', state: 'disabled' });
    expect(app.ctx.plugins.isLive('net.example.scoped')).toBe(false);
    expect(installRow('net.example.scoped')).toMatchObject({ version: '1.0.1', consent_state: 'pending', was_enabled: 1, consented_by: 'root' });
    expect((await get('/api/marketplace/updates').expect(200)).body.data.pending).toEqual([]);
    const ok = await post('/api/marketplace/consent/net.example.scoped', { permissions: ['accounts:read', 'contacts:notify', 'store:own'] });
    expect(ok.status).toBe(200);
    expect(pluginRow('net.example.scoped').state).toBe('enabled');
    expect(app.ctx.plugins.isLive('net.example.scoped')).toBe(true);
    expect(installRow('net.example.scoped')).toMatchObject({ consent_state: 'consented', was_enabled: 0 });
    const again = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.scoped', version: '1.0.1' }));
    expect(again.result).toMatchObject({ status: 'installed', enabled: true });
    expect(pluginRow('net.example.scoped').state).toBe('enabled');
  });

  it('applies requireFeature(marketplace_paid) to paid plugins only', async () => {
    const free = await post('/api/marketplace/install', { pluginId: 'net.example.minimal' });
    expect(free.status).toBe(202);
    await waitForJob(app.ctx, free.body.data.job.id, 15_000);
    hub.features = { ...FEATURES, marketplace_paid: false };
    await post('/api/license/checkin').expect(200);
    expect(app.ctx.license.hasFeature('marketplace_paid')).toBe(false);
    const paid = await post('/api/marketplace/install', { pluginId: 'net.example.paid' });
    expect(paid.status).toBe(403);
    expect(paid.body.error).toMatchObject({ code: 'feature_required', fields: { feature: ['marketplace_paid'] } });
    expect((await post('/api/marketplace/install', { pluginId: 'net.example.minimal' })).status).toBe(202);
    hub.features = FEATURES;
    await post('/api/license/checkin').expect(200);
    const entitlement = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.paid', consent: { permissions: ['settings:own'] } }));
    expect(entitlement.status).toBe('failed');
    expect(entitlement.error_code).toBe('entitlement_required');
    hub.entitled = true;
    const bought = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.paid', consent: { permissions: ['settings:own'] } }));
    expect(bought.result).toMatchObject({ status: 'installed', version: '2.1.0' });
  });

  it('installs the signed sample plugin fixture end to end', async () => {
    const src = path.join(REPO_ROOT, 'plugins', 'sample-plugin');
    const dir = path.join(tmp, 'sample-notes');
    fs.cpSync(src, dir, { recursive: true, filter: (p) => !/\/(test|node_modules|dist)(\/|$)/.test(p) && !p.endsWith('.whmplugin') });
    pack.writeSignature(dir, 'SIGNATURE.json', { kid: PLUGIN_KID_A, sig: pack.sign(pack.packageDigest(dir), privPemOf(PLUGIN_KID_A)) });
    const buffer = pack.packDirectory(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    hub.publish('net.whm.sample-notes', { version: manifest.version, buffer });
    const job = await runJob(await post('/api/marketplace/install', { pluginId: 'net.whm.sample-notes', consent: { permissions: manifest.permissions } }));
    expect(job.status, job.error).toBe('done');
    expect(job.result).toMatchObject({ status: 'installed', pluginId: 'net.whm.sample-notes', version: manifest.version, enabled: true });
    const plugin = (await get('/api/plugins/manage/net.whm.sample-notes').expect(200)).body.data;
    expect(plugin).toMatchObject({ state: 'enabled', signed: true, signer: PLUGIN_KID_A, source: 'marketplace' });
    expect((await get('/api/plugins/net.whm.sample-notes/notes').expect(200)).body).toBeDefined();
    const un = await del('/api/marketplace/net.whm.sample-notes?purge=true');
    expect(un.status).toBe(200);
    expect(un.body.data).toMatchObject({ uninstalled: true, purged: true });
    expect(pluginRow('net.whm.sample-notes')).toBeUndefined();
    expect(installRow('net.whm.sample-notes')).toBeUndefined();
    expect(audits('plugin.marketplace.uninstall').at(-1).target).toBe('net.whm.sample-notes');
    expect((await del('/api/marketplace/net.whm.sample-notes')).status).toBe(404);
  });

  it('forgets a marketplace install removed through the host route and treats the next install as a first install', async () => {
    expect(installRow('net.example.minimal')).toBeTruthy();
    await del('/api/plugins/manage/net.example.minimal?purge=true').expect(200);
    expect(pluginRow('net.example.minimal')).toBeUndefined();
    expect(installRow('net.example.minimal')).toBeUndefined();
    expect((await get('/api/marketplace/installs').expect(200)).body.data.map((r) => r.pluginId)).not.toContain('net.example.minimal');
    expect((await get('/api/marketplace/catalog?q=minimal').expect(200)).body.data[0].installed).toBeNull();
    // A stale row with no plugin behind it never turns a fresh install into a held, disabled update.
    app.ctx.db.prepare("INSERT INTO marketplace_installs (plugin_id, version, channel, consented_permissions_json, consent_state, was_enabled) VALUES ('net.example.minimal', '0.0.1', 'stable', '[]', 'consented', 0)").run();
    const job = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.minimal', version: '1.0.0' }));
    expect(job.status, job.error).toBe('done');
    expect(job.result).toMatchObject({ status: 'installed', version: '1.0.0', enabled: true });
    expect(pluginRow('net.example.minimal')).toMatchObject({ state: 'enabled', source: 'marketplace' });
    expect(installRow('net.example.minimal')).toMatchObject({ version: '1.0.0', consent_state: 'consented', consented_by: 'root' });
    expect(JSON.parse(audits('plugin.marketplace.install').at(-1).args_redacted)).toMatchObject({ previousVersion: null, enabled: true });
  });

  it('refuses a package that declares another plugin id before it touches the plugin installed under that id, and re-checks the install source inside the job', async () => {
    app.ctx.settings.set('plugins.developer_mode', true);
    expect((await installRaw(unsignedPackage(fixtures.minimalManifest({ id: 'net.example.victim', version: '1.0.0' })))).status).toBe(201);
    app.ctx.settings.set('plugins.developer_mode', false);
    await post('/api/plugins/manage/net.example.victim/enable').expect(200);
    expect(pluginRow('net.example.victim')).toMatchObject({ version: '1.0.0', state: 'enabled', source: 'upload' });
    const installAudits = audits('plugin.install').length;
    hub.publish('net.example.alias', { version: '1.0.1', buffer: signedPackage(fixtures.minimalManifest({ id: 'net.example.victim', version: '1.0.1' })) });
    const kept = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.alias' }));
    expect(kept.status).toBe('failed');
    expect(kept.error_code).toBe('plugin_id_mismatch');
    // The host refused before the directory swap: the sideloaded plugin is untouched and still live.
    expect(pluginRow('net.example.victim')).toMatchObject({ version: '1.0.0', state: 'enabled', source: 'upload', signed: 0 });
    expect(app.ctx.plugins.isLive('net.example.victim')).toBe(true);
    expect(installRow('net.example.alias')).toBeUndefined();
    expect(installRow('net.example.victim')).toBeUndefined();
    expect(audits('plugin.install').length).toBe(installAudits);
    hub.publish('net.example.alias2', { version: '1.0.0', buffer: signedPackage(fixtures.minimalManifest({ id: 'net.example.ghost', version: '1.0.0' })) });
    const removed = await runJob(await post('/api/marketplace/install', { pluginId: 'net.example.alias2' }));
    expect(removed.error_code).toBe('plugin_id_mismatch');
    expect(pluginRow('net.example.ghost')).toBeUndefined();
    expect(fs.existsSync(path.join(app.ctx.config.pluginsDir, 'net.example.ghost'))).toBe(false);
    await del('/api/plugins/manage/net.example.victim?purge=true').expect(200);
    // A job queued for a sideloaded id (the plugin appeared between enqueue and run) is refused by the job itself.
    const sideloaded = app.ctx.jobs.enqueue(INSTALL_JOB, { pluginId: 'net.example.sideload', username: 'root' });
    const refused = await waitForJob(app.ctx, sideloaded.id, 15_000);
    expect(refused.status).toBe('failed');
    expect(refused.error_code).toBe('not_marketplace');
    expect(hub.calls.filter((c) => c.url === `${HUB}/v1/market/download` && c.body.plugin_id === 'net.example.sideload')).toEqual([]);
  });

  it('posts reviews through the signed route and lets resellers browse but not manage', async () => {
    const review = await post('/api/marketplace/plugins/net.example.minimal/reviews', { rating: 5, title: 'Great', body: 'Small and sharp.' });
    expect(review.status).toBe(201);
    expect(review.body.data).toMatchObject({ id: 'rev_new', status: 'pending' });
    expect(hub.calls.at(-1).body).toMatchObject({ rating: 5, token: expect.stringMatching(/^WHMT1\./) });
    expect((await post('/api/marketplace/plugins/net.example.minimal/reviews', { rating: 9 })).status).toBe(422);
    const reseller = await app.createUser('resell1', 'reseller');
    const other = (await import('supertest')).default.agent(app.ctx.app);
    const login = await other.post('/api/auth/login').send({ username: reseller.username, password: reseller.password });
    expect(login.status).toBe(200);
    const rcsrf = login.body.data.csrfToken;
    const rstatus = await other.get('/api/marketplace/status');
    expect(rstatus.status).toBe(200);
    expect(Object.keys(rstatus.body.data).sort()).toEqual(['enabled', 'hostVersion', 'hubMismatch', 'hubUrl', 'licenseDegraded', 'licenseStatus', 'url']);
    expect(rstatus.body.data).toMatchObject({ enabled: true, hubMismatch: false, hubUrl: HUB, licenseStatus: 'active' });
    const rcat = await other.get('/api/marketplace/catalog?q=minimal');
    expect(rcat.status).toBe(200);
    expect(rcat.body.data[0].installed).toEqual({ state: 'enabled' });
    const rdetail = await other.get('/api/marketplace/plugins/net.example.minimal');
    expect(rdetail.status).toBe(200);
    expect(rdetail.body.data.installed).toEqual({ state: 'enabled' });
    expect((await get('/api/marketplace/plugins/net.example.minimal').expect(200)).body.data.installed).toMatchObject({ version: '1.0.0', marketplace: true, consentState: 'consented' });
    expect((await other.get('/api/marketplace/plugins/net.example.nothere')).status).toBe(404);
    expect((await other.get('/api/marketplace/installs')).status).toBe(403);
    expect((await other.post('/api/marketplace/install').set('X-CSRF-Token', rcsrf).send({ pluginId: 'net.example.minimal' })).status).toBe(403);
    expect((await other.post('/api/marketplace/consent/net.example.minimal').set('X-CSRF-Token', rcsrf).send({ permissions: [] })).status).toBe(403);
    expect((await other.delete('/api/marketplace/net.example.minimal').set('X-CSRF-Token', rcsrf)).status).toBe(403);
  });
});

describe('revocations', () => {
  const feed = readFixture('revocations.json').data;
  const HEAD = Math.max(...feed.map((r) => r.ts));

  it('refuses a stale, replayed or stripped feed and audits it', async () => {
    hub.revocations = feed;
    hub.feedNow = Math.floor(hub.now() / 1000) - 1000;
    const stale = await post('/api/marketplace/revocations/poll');
    expect(stale.status).toBe(502);
    expect(stale.body.error.code).toBe('hub_feed_stale');
    hub.feedNow = null;
    hub.feedHeadTs = -1;
    expect((await post('/api/marketplace/revocations/poll')).body.error.code).toBe('hub_feed_stale');
    hub.feedHeadTs = null;
    expect(audits('marketplace.feed_stale')).toHaveLength(2);
    expect(app.ctx.db.prepare('SELECT fail_count FROM marketplace_state').get().fail_count).toBe(2);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM marketplace_revocations').get().n).toBe(0);
    expect(pluginRow('net.example.scoped').state).toBe('enabled');
    hub.tamper = (res) => ({ ...res, body: Buffer.from(res.body.toString('utf8').replace('"warning"', '"info"')) });
    expect((await post('/api/marketplace/revocations/poll')).body.error.code).toBe('hub_signature_invalid');
    hub.tamper = null;
  });

  it('applies the feed: disables a same-id path install signed by a hub kid, only disables an unsigned sideload on a critical uninstall row, and uninstalls the hub-signed marketplace install', async () => {
    await del('/api/marketplace/net.example.minimal?purge=true').expect(200);
    const sideload = await installRaw(unsignedPackage(fixtures.minimalManifest({ id: 'net.example.minimal', version: '1.0.0' })));
    expect(sideload.status, JSON.stringify(sideload.body)).toBe(422);
    expect(sideload.body.error.message).toMatch(/plugins\.developer_mode/);
    app.ctx.settings.set('plugins.developer_mode', true);
    expect((await installRaw(unsignedPackage(fixtures.minimalManifest({ id: 'net.example.minimal', version: '1.0.0' })))).status).toBe(201);
    app.ctx.settings.set('plugins.developer_mode', false);
    await post('/api/plugins/manage/net.example.minimal/enable').expect(200);
    const signedPath = path.join(tmp, 'scoped-copy.whmplugin');
    fs.writeFileSync(signedPath, hub.packages.get('net.example.scoped')[1].buffer);
    // A hub-signed package through the sideload route is accepted without developer mode and recorded as `path`.
    const pathInstall = await post('/api/plugins/manage/install', { path: signedPath });
    expect(pathInstall.status, JSON.stringify(pathInstall.body)).toBe(201);
    expect(pathInstall.body.data.plugin).toMatchObject({ source: 'path', signed: true, signer: PLUGIN_KID_A, state: 'enabled' });
    await del('/api/marketplace/net.example.scoped').expect(200);
    expect(pluginRow('net.example.scoped')).toBeUndefined();
    expect((await post('/api/plugins/manage/install', { path: signedPath })).status).toBe(201);
    await post('/api/plugins/manage/net.example.scoped/enable').expect(200);
    expect(pluginRow('net.example.scoped')).toMatchObject({ source: 'path', signer: PLUGIN_KID_A, state: 'enabled' });

    const t0 = hub.now();
    const before = notified.length;
    expect(pluginRow('net.example.paid')).toMatchObject({ source: 'marketplace', signer: PLUGIN_KID_A, version: '2.1.0', state: 'enabled' });
    const res = await post('/api/marketplace/revocations/poll');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.received).toBe(3);
    expect(res.body.data.applied.map((a) => [a.id, a.action, a.appliedTo.map((t) => `${t.id}:${t.source}:${t.action}`)])).toEqual([
      ['rvk_01SCOPED', 'disable', ['net.example.scoped:path:disable']],
      ['rvk_02MINIMAL', 'uninstall', ['net.example.minimal:upload:disable']],
      ['rvk_03PAID', 'uninstall', ['net.example.paid:marketplace:uninstall']],
    ]);
    expect(pluginRow('net.example.scoped').state).toBe('disabled');
    // The operator's unsigned sideload is disabled, never removed on the hub's say-so.
    expect(pluginRow('net.example.minimal')).toMatchObject({ source: 'upload', state: 'disabled', version: '1.0.0' });
    expect(app.ctx.plugins.isLive('net.example.minimal')).toBe(false);
    expect(pluginRow('net.example.paid')).toBeUndefined();
    expect(installRow('net.example.paid')).toBeUndefined();
    expect(app.ctx.plugins.isLive('net.example.scoped')).toBe(false);
    const state = stateRow();
    expect(state).toMatchObject({ last_revocation_ts: HEAD, revocations_head_ts: HEAD, fail_count: 0 });
    expect(state.last_revocation_now).toBeGreaterThanOrEqual(Math.floor(t0 / 1000) - 1);
    expect(audits('plugin.revoked').map((a) => a.target)).toEqual(['net.example.scoped', 'net.example.minimal', 'net.example.paid']);
    expect(JSON.parse(audits('plugin.revoked')[1].args_redacted).appliedTo[0]).toMatchObject({ id: 'net.example.minimal', action: 'disable', hubSigned: false });
    expect(notified.slice(before).filter((n) => n.event === 'plugin.revoked')).toHaveLength(3);
    const banner = (await get('/api/marketplace/revocations?unacknowledged=true').expect(200)).body.data;
    expect(banner.map((r) => r.id)).toEqual(['rvk_03PAID', 'rvk_02MINIMAL', 'rvk_01SCOPED']);
    expect(banner[2]).toMatchObject({ pluginId: 'net.example.scoped', severity: 'warning', action: 'disable', reason: 'leaks the account list to a third party', acknowledgedAt: null });
    expect((await get('/api/marketplace/status').expect(200)).body.data).toMatchObject({ unacknowledgedRevocations: 3, lastRevocationTs: HEAD });
    // The same feed again is a no-op (rows are keyed by id; since = last ts).
    expect((await post('/api/marketplace/revocations/poll').expect(200)).body.data).toMatchObject({ received: 0, applied: [] });
    expect(hub.calls.at(-1).body.since).toBe(HEAD);
    // A replay of an older `now` is refused once a newer feed was accepted.
    hub.feedNow = state.last_revocation_now - 10;
    expect((await post('/api/marketplace/revocations/poll')).body.error.code).toBe('hub_feed_stale');
    hub.feedNow = null;
  });

  it('refuses to re-enable a revoked plugin until root acknowledges the notice or developer mode is on', async () => {
    const refused = await post('/api/plugins/manage/net.example.scoped/enable');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'plugin_revoked', fields: { revocation: ['rvk_01SCOPED'] } });
    await expect(app.ctx.plugins.enable('net.example.scoped')).rejects.toMatchObject({ code: 'plugin_revoked' });
    expect(pluginRow('net.example.scoped').state).toBe('disabled');
    app.ctx.settings.set('plugins.developer_mode', true);
    expect((await post('/api/plugins/manage/net.example.scoped/enable')).status).toBe(200);
    await post('/api/plugins/manage/net.example.scoped/disable').expect(200);
    app.ctx.settings.set('plugins.developer_mode', false);
    expect((await post('/api/plugins/manage/net.example.scoped/enable')).status).toBe(409);
    const ack = await post('/api/marketplace/revocations/rvk_01SCOPED/ack');
    expect(ack.status).toBe(200);
    expect(ack.body.data).toMatchObject({ id: 'rvk_01SCOPED', acknowledgedBy: 'root' });
    expect(audits('marketplace.revocation.ack')).toHaveLength(1);
    expect((await post('/api/plugins/manage/net.example.scoped/enable')).status).toBe(200);
    expect((await get('/api/marketplace/revocations?unacknowledged=true').expect(200)).body.data.map((r) => r.id)).toEqual(['rvk_03PAID', 'rvk_02MINIMAL']);
    expect((await post('/api/marketplace/revocations/nope/ack')).status).toBe(404);
    expect((await get('/api/marketplace/revocations').expect(200)).body.data).toHaveLength(3);
  });

  it('queues a poll on the check-in message plugin_revocations_pending and when the signed head advances', async () => {
    const countJobs = () => app.ctx.jobs.list({ type: REVOCATIONS_JOB, limit: 100 }).length;
    const n0 = countJobs();
    hub.messages = [{ level: 'critical', code: 'plugin_revocations_pending', text: 'pull the feed', data: { plugin_id: 'net.example.scoped', head_ts: HEAD } }];
    await post('/api/license/checkin').expect(200);
    expect(countJobs()).toBe(n0 + 1);
    hub.messages = [];
    hub.revocationsHeadTs = HEAD + 5;
    hub.feedHeadTs = HEAD + 5;
    await post('/api/license/checkin').expect(200);
    expect(countJobs()).toBe(n0 + 2);
    // The signed head is pinned as the feed floor as soon as the check-in lands.
    expect(stateRow().revocations_head_ts).toBe(HEAD + 5);
    hub.revocationsHeadTs = HEAD;
    await post('/api/license/checkin').expect(200);
    expect(countJobs()).toBe(n0 + 2);
    expect(stateRow().revocations_head_ts).toBe(HEAD + 5);
    const last = app.ctx.jobs.list({ type: REVOCATIONS_JOB, limit: 1 })[0];
    const done = await waitForJob(app.ctx, last.id, 15_000);
    expect(done.status, done.error).toBe('done');
    expect(done.result).toMatchObject({ headTs: HEAD + 5 });
  });

  it('refuses a feed whose head is behind the head the hub signed at check-in (stripped feed)', async () => {
    const before = audits('marketplace.feed_stale').length;
    hub.revocationsHeadTs = HEAD + 10;
    hub.feedHeadTs = HEAD;
    await post('/api/license/checkin').expect(200);
    expect(app.ctx.license.get().revocationsHeadTs).toBe(HEAD + 10);
    expect(stateRow().revocations_head_ts).toBe(HEAD + 10);
    const queued = app.ctx.jobs.list({ type: REVOCATIONS_JOB, limit: 1 })[0];
    const job = await waitForJob(app.ctx, queued.id, 15_000);
    expect(job.status).toBe('failed');
    expect(job.error_code).toBe('hub_feed_stale');
    const manual = await post('/api/marketplace/revocations/poll');
    expect(manual.status).toBe(502);
    expect(manual.body.error.code).toBe('hub_feed_stale');
    expect(manual.body.error.message).toMatch(/stripped feed/);
    expect(audits('marketplace.feed_stale')).toHaveLength(before + 2);
    expect(JSON.parse(audits('marketplace.feed_stale').at(-1).args_redacted)).toMatchObject({ headTs: HEAD, storedHeadTs: HEAD + 10 });
    expect(stateRow().fail_count).toBe(2);
    // The floor is also taken straight from the license cache (the boot path), not only from the stored row.
    app.ctx.db.prepare('UPDATE marketplace_state SET revocations_head_ts = 0').run();
    expect((await post('/api/marketplace/revocations/poll')).body.error.code).toBe('hub_feed_stale');
    expect(stateRow()).toMatchObject({ revocations_head_ts: HEAD + 10, fail_count: 3 });
    hub.feedHeadTs = HEAD + 10;
    expect((await post('/api/marketplace/revocations/poll').expect(200)).body.data).toMatchObject({ received: 0, applied: [], headTs: HEAD + 10 });
    expect(stateRow()).toMatchObject({ revocations_head_ts: HEAD + 10, fail_count: 0 });
  });
});

describe('degraded license and install sources', () => {
  it('answers 423 license_degraded on install/update while browsing keeps working', async () => {
    await post('/api/license/deactivate', {}).expect(200);
    expect(app.ctx.license.isDegraded()).toBe(true);
    const res = await post('/api/marketplace/install', { pluginId: 'net.example.minimal' });
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('license_degraded');
    expect((await post('/api/marketplace/update/net.example.scoped')).status).toBe(423);
    expect((await post('/api/plugins/manage/install', { path: '/tmp/none.whmplugin' })).status).toBe(423);
    expect((await get('/api/marketplace/status').expect(200)).body.data).toMatchObject({ enabled: true, licenseStatus: 'unlicensed', licenseDegraded: true });
    expect((await get('/api/marketplace/catalog').expect(200)).body.data.length).toBeGreaterThan(0);
    expect((await post('/api/marketplace/revocations/poll')).status).toBe(423);
    expect(await app.ctx.marketplace.pollRevocations()).toMatchObject({ skipped: 'no_token' });
    // The scheduled update check is skipped on a degraded license, never recorded as a failure.
    const check = await waitForJob(app.ctx, app.ctx.jobs.enqueue(UPDATE_CHECK_JOB, {}).id, 15_000);
    expect(check.status, check.error).toBe('done');
    expect(check.result).toEqual({ skipped: 'license_degraded' });
    await post('/api/license/key', { key: 'WHM-7K3Q-M2DF-9XA1-P0R6' }).expect(200);
    expect((await post('/api/marketplace/install', { pluginId: 'net.example.minimal' })).body.error.code).toBe('not_marketplace');
    await del('/api/plugins/manage/net.example.minimal?purge=true').expect(200);
    expect((await post('/api/marketplace/install', { pluginId: 'net.example.minimal' })).status).toBe(202);
  });

  it('never calls the license transport over http:// and keeps every call on the license hub origin', () => {
    expect(hub.calls.length).toBeGreaterThan(20);
    for (const c of hub.calls) expect(c.url.startsWith(`${HUB}/`)).toBe(true);
  });

  it('removes the download cache file after every install attempt', () => {
    expect(fs.existsSync(app.ctx.marketplace.cacheDir)).toBe(true);
    expect(fs.readdirSync(app.ctx.marketplace.cacheDir)).toEqual([]);
  });

  it('registers both job types and the two schedules', () => {
    expect(app.ctx.jobs.types()).toEqual(expect.arrayContaining([INSTALL_JOB, UPDATE_JOB, REVOCATIONS_JOB, 'marketplace.update-check']));
    expect(app.ctx.scheduler.list().map((s) => s.name)).toEqual(expect.arrayContaining([REVOCATIONS_SCHEDULE, UPDATE_CHECK_SCHEDULE]));
  });
});

// The real license transport (only https.request is stubbed): a package download
// may be 20 MiB while signed JSON answers keep the 1 MiB default (§18.6).
describe('license transport size limit', () => {
  function stubHttps(bytes, { chunk = 256 * 1024 } = {}) {
    const seen = [];
    const spy = vi.spyOn(https, 'request').mockImplementation((u, options, cb) => {
      seen.push({ url: u.href, options });
      const req = new EventEmitter();
      req.write = () => true;
      req.destroy = (err) => { if (req.destroyed) return; req.destroyed = true; if (err) req.emit('error', err); };
      req.end = () => setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { 'content-type': 'application/gzip' };
        cb(res);
        let sent = 0;
        const tick = () => {
          if (req.destroyed) return;
          if (sent >= bytes) { res.emit('end'); return; }
          const n = Math.min(chunk, bytes - sent);
          res.emit('data', Buffer.alloc(n, 1));
          sent += n;
          setImmediate(tick);
        };
        tick();
      });
      return req;
    });
    return { spy, seen };
  }
  afterAll(() => vi.restoreAllMocks());

  it('caps signed JSON answers at 1 MiB by default and honours maxBytes for package downloads', async () => {
    const url = `${HUB}/v1/market/packages/dl_TEST?exp=1&sig=x`;
    const over = MAX_RESPONSE_BYTES + 1;
    let stub = stubHttps(over);
    await expect(realTransport.request(url, { method: 'GET' })).rejects.toThrow(/too large/);
    expect(stub.seen[0].options).toMatchObject({ method: 'GET', timeout: 30_000, rejectUnauthorized: true });
    stub.spy.mockRestore();
    stub = stubHttps(over);
    const ok = await realTransport.request(url, { method: 'GET', timeoutMs: 60_000, maxBytes: MAX_PACKAGE_BYTES });
    expect(ok.status).toBe(200);
    expect(ok.body.length).toBe(over);
    expect(stub.seen[0].options.timeout).toBe(60_000);
    stub.spy.mockRestore();
    stub = stubHttps(MAX_PACKAGE_BYTES + 1);
    await expect(realTransport.request(url, { method: 'GET', maxBytes: MAX_PACKAGE_BYTES })).rejects.toThrow(/too large/);
    stub.spy.mockRestore();
    stub = stubHttps(MAX_PACKAGE_BYTES);
    expect((await realTransport.request(url, { method: 'GET', maxBytes: MAX_PACKAGE_BYTES })).body.length).toBe(MAX_PACKAGE_BYTES);
    stub.spy.mockRestore();
    const plain = stubHttps(10);
    await expect(realTransport.request('http://hub.test/v1/market/packages/x', { method: 'GET', maxBytes: MAX_PACKAGE_BYTES })).rejects.toThrow(/https/);
    expect(plain.seen).toEqual([]);
  });
});
