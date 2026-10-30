import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { authenticator } from 'otplib';
import { bootHub } from './support.js';
import { KIDS } from './fixtures/index.js';

const require = createRequire(import.meta.url);
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const pack = require(path.join(REPO, 'plugins/sdk/pack.js'));
export const sdk = require(path.join(REPO, 'plugins/sdk/index.js'));
export const SAMPLE_DIR = path.join(REPO, 'plugins/sample-plugin');
export const FIXTURES = path.join(SAMPLE_DIR, 'test/fixtures');
export const GOLDEN = () => fs.readFileSync(path.join(FIXTURES, 'sample-notes-signed.whmplugin'));
export const DEV_PEM = fs.readFileSync(path.join(FIXTURES, 'dev.pem'), 'utf8');
export const DEV_PUB = fs.readFileSync(path.join(FIXTURES, 'dev.pub'), 'utf8');
export const DEV_KID = pack.kidOf(DEV_PUB);
export const SAMPLE_MANIFEST = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'plugin.json'), 'utf8'));
export const SAMPLE_ID = SAMPLE_MANIFEST.id;

export const justify = (manifest) => Object.fromEntries((manifest.permissions || []).map((s) => [s, `Needed so the plugin can ${s} as documented in the README`]));
export const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');

// Builds a .whmplugin from { manifest, files, signWith (PEM) | null, wrapper }.
export function buildPackage({ manifest, files = {}, signWith = DEV_PEM, kid = null, wrapper = null, extraSignatureFile = null }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-mk-build-'));
  const root = wrapper ? path.join(tmp, wrapper) : tmp;
  fs.mkdirSync(root, { recursive: true });
  const all = { 'plugin.json': JSON.stringify(manifest, null, 2), 'main.js': 'module.exports = { activate() {} };\n', ...files };
  for (const [rel, content] of Object.entries(all)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (signWith) {
    const sig = pack.sign(pack.packageDigest(root, { exclude: [...pack.SIGNATURE_FILES] }), signWith);
    pack.writeSignature(root, pack.DEV_SIGNATURE_FILE, { kid: kid || pack.kidOf(signWith), sig });
  }
  if (extraSignatureFile) fs.writeFileSync(path.join(root, pack.SIGNATURE_FILE), JSON.stringify(extraSignatureFile));
  const buf = wrapper ? tarDirectory(tmp) : pack.packDirectory(tmp, { exclude: [] });
  fs.rmSync(tmp, { recursive: true, force: true });
  return buf;
}

// Minimal ustar writer for shapes pack.js refuses to produce (wrapper directories, links, absolute names).
export function tarEntries(entries) {
  const blocks = [];
  for (const e of entries) {
    const hdr = Buffer.alloc(512, 0);
    hdr.write(e.name, 0, 100); hdr.write('0000644\0', 100, 8); hdr.write('0000000\0', 108, 8); hdr.write('0000000\0', 116, 8);
    const data = Buffer.from(e.data || ''); hdr.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12); hdr.write('00000000000\0', 136, 12); hdr.write('        ', 148, 8); hdr.write(e.type || '0', 156, 1); hdr.write('ustar\0', 257, 6); hdr.write('00', 263, 2);
    if (e.link) hdr.write(e.link, 157, 100);
    let sum = 0; for (let i = 0; i < 512; i++) sum += hdr[i];
    hdr.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(hdr);
    if (data.length) { const b = Buffer.alloc(Math.ceil(data.length / 512) * 512); data.copy(b); blocks.push(b); }
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}
function tarDirectory(dir) {
  const entries = [];
  const walk = (d, rel) => { for (const ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const r = rel ? `${rel}/${ent.name}` : ent.name; if (ent.isDirectory()) walk(path.join(d, ent.name), r); else entries.push({ name: r, data: fs.readFileSync(path.join(d, ent.name)) }); } };
  walk(dir, '');
  return tarEntries(entries);
}

export function manifestFor(id, extra = {}) {
  return { id, name: extra.name || id.split('.').pop(), version: '1.0.0', description: 'A test plugin for the marketplace suite.', author: { name: 'Test' }, license: 'MIT', engines: { whm: '^1.0.0' }, main: 'main.js', permissions: [], ...extra };
}

// Developer TOTP checks run on the hub clock (frozen in tests, moved by
// h.advance), so codes are minted against it: a bcrypt round can no longer
// straddle a 30-second step and the production window (the current step only)
// stays in force. A code is accepted once per account (RFC 6238 §5.2), so a
// test that presents a second code within a step first calls h.nextTotpStep();
// d.login() and d.stepUp() do that themselves when the helper already spent
// the current step for that account, and not otherwise, so the clock stays
// where a test put it.
export const TOTP_STEP_MS = 30_000;
// The clocks of the markets booted by this file that are still open: the
// bare totpCode() follows the newest one, so a temporary hub a test boots and
// closes never leaves its clock behind; market.totpCode is bound to its hub.
const openClocks = [];
const hubNow = () => (openClocks.length ? openClocks[openClocks.length - 1]() : Date.now());
export function totpCode(secret, now = hubNow) {
  return authenticator.clone({ epoch: now() }).generate(secret);
}

// A marketplace hub: bootHub + developer/admin helpers.
export async function bootMarket({ config = {}, ...rest } = {}) {
  const defaults = { review: { require_two_reviewers_for_high_risk: false }, rate_limits: { upload: { max: 1000 } } };
  const mk = config.marketplace || {};
  const h = await bootHub({ config: { ...config, marketplace: { ...defaults, ...mk, review: { ...defaults.review, ...(mk.review || {}) }, rate_limits: { ...defaults.rate_limits, ...(mk.rate_limits || {}) } } }, ...rest });
  const { ctx } = h;
  const m = ctx.marketplace;
  const market = { ...h, m, mdb: m.db, sent: ctx.mailer.sent };
  const clockNow = () => ctx.clock.now();
  openClocks.push(clockNow);
  market.totpCode = (secret) => totpCode(secret, clockNow);
  market.nextTotpStep = () => h.advance(TOTP_STEP_MS);
  market.close = async () => { const i = openClocks.lastIndexOf(clockNow); if (i !== -1) openClocks.splice(i, 1); await h.close(); };
  let n = 0;

  // Developer with e-mail verified, TOTP enabled, logged in and stepped up.
  market.developer = async function developer({ email, name, verified = true, totp = true, namespaces = [], key = 'fresh', loggedIn = true } = {}) {
    n++;
    const mail = email || `dev${n}-${crypto.randomBytes(3).toString('hex')}@example.test`;
    const password = 'Correct-Horse-Battery-9';
    const reg = await m.developers.register({ email: mail, password, display_name: name || `Dev ${n}` }, { ip: `203.0.${(n >> 8) & 255}.${n & 255}` });
    m.developers.verifyEmail(reg._token);
    const row = m.developers.get(reg.id);
    let secret = null;
    if (totp) {
      // Enabled on the row rather than through totpConfirm: the fixture spends
      // one code per step, and that is the login below.
      secret = m.developers.totpStart(row).secret;
      m.db.prepare('UPDATE developers SET totp_enabled = 1 WHERE id = ?').run(reg.id);
    }
    const agent = request.agent(ctx.app);
    let csrf = null;
    let spentStep = null;
    const currentStep = () => Math.floor(clockNow() / TOTP_STEP_MS);
    const freshCode = () => {
      if (spentStep !== null && currentStep() <= spentStep) market.nextTotpStep();
      spentStep = currentStep();
      return market.totpCode(secret);
    };
    const login = async () => {
      const res = await agent.post('/v1/dev/login').send({ email: mail, password, ...(secret ? { totp: freshCode() } : {}) });
      if (res.status !== 200) throw new Error(`developer login failed: ${res.status} ${JSON.stringify(res.body)}`);
      csrf = res.body.data.csrfToken;
      return res;
    };
    if (loggedIn) await login();
    const d = {
      id: reg.id, email: mail, password, secret, agent, csrf, pem: key && key !== 'fresh' ? key : pack.generateKeyPair().privateKeyPem,
      get: (url) => agent.get(url),
      post: (url, body = {}) => agent.post(url).set('X-CSRF-Token', csrf || '').send(body),
      patch: (url, body = {}) => agent.patch(url).set('X-CSRF-Token', csrf || '').send(body),
      del: (url) => agent.delete(url).set('X-CSRF-Token', csrf || ''),
      upload: (pluginId, buf, { channel = 'stable', justifications, changelog } = {}) => {
        let req = agent.post(`/v1/dev/plugins/${pluginId}/versions?channel=${channel}`).set('X-CSRF-Token', csrf || '').set('Content-Type', 'application/gzip');
        if (justifications) req = req.set('X-WHM-Justifications', b64(justifications));
        if (changelog) req = req.set('X-WHM-Changelog', b64(changelog));
        return req.send(buf);
      },
      stepUp: () => d.post('/v1/dev/2fa/stepup', { totp: freshCode() }),
      row: () => m.developers.get(reg.id),
      // Re-authenticates after the clock moved past the session TTL.
      login: async () => { const res = await login(); d.csrf = csrf; return res; },
    };
    for (const ns of namespaces) m.developers.reassignNamespace(ns, reg.id, { by: 'test', ip: null });
    if (verified) m.developers.approve(reg.id, { by: 'test', ip: null });
    if (key) { const kr = await market.registerKey(d, d.pem); if (kr.status !== 201) throw new Error(`key registration failed ${kr.status} ${JSON.stringify(kr.body)}`); }
    return d;
  };
  market.registerKey = async function registerKey(d, pem, { label = 'ci' } = {}) {
    const ch = await d.post('/v1/dev/keys');
    if (ch.status !== 201) throw new Error(`challenge failed: ${ch.status} ${JSON.stringify(ch.body)}`);
    const challenge = ch.body.data.challenge;
    const sig = crypto.sign(null, Buffer.from(challenge, 'base64url'), crypto.createPrivateKey(pem)).toString('base64');
    const res = await d.post(`/v1/dev/keys/${challenge}`, { public_key_pem: pack.publicPem(pem), label, sig });
    return res;
  };
  // Listing + golden upload for the sample plugin under net.whm.
  market.sampleDeveloper = async (opts = {}) => market.developer({ namespaces: ['net.whm'], key: DEV_PEM, ...opts });
  market.createListing = (d, id, extra = {}) => d.post('/v1/dev/plugins', { id, name: extra.name || id, summary: 'test listing', ...extra });
  market.adminStepUp = () => null;
  // Admin step-up is not needed for API keys; the admin helper from bootHub is a vendor api key.
  market.approveReview = async (reviewId, { key = h.adminKey } = {}) => h.asKey(key)('post', `/v1/admin/market/reviews/${reviewId}/approve`).send({});
  market.publish = (d, pluginId, version, body = {}) => d.post(`/v1/dev/plugins/${pluginId}/versions/${version}/publish`, body);
  market.submitSample = async function submitSample({ d, publish = true, justifications = justify(SAMPLE_MANIFEST) } = {}) {
    const dev = d || await market.sampleDeveloper();
    const listing = await market.createListing(dev, SAMPLE_ID, { name: 'Sample Notes' });
    if (listing.status !== 201) throw new Error(`listing failed ${listing.status} ${JSON.stringify(listing.body)}`);
    const up = await dev.upload(SAMPLE_ID, GOLDEN(), { justifications });
    if (up.status !== 201) throw new Error(`upload failed ${up.status} ${JSON.stringify(up.body)}`);
    const reviewId = up.body.data.review_id;
    const approved = await market.approveReview(reviewId);
    if (approved.status !== 200) throw new Error(`approve failed ${approved.status} ${JSON.stringify(approved.body)}`);
    let published = null;
    if (publish) {
      published = await market.publish(dev, SAMPLE_ID, SAMPLE_MANIFEST.version);
      if (published.status !== 200) throw new Error(`publish failed ${published.status} ${JSON.stringify(published.body)}`);
    }
    return { dev, version: up.body.data, review: approved.body.data, published: published?.body.data };
  };
  // A license with an active activation; returns the token and helpers.
  market.panelLicense = async function panelLicense(sku = 'whm-pro-annual', extra = {}) {
    const { license, key } = h.issue(sku, extra);
    const server = h.fp();
    const a = await h.activate(key, server);
    if (a.status !== 200) throw new Error(`activate failed ${a.status} ${JSON.stringify(a.body)}`);
    const lic = { license, key, server, token: a.body.data.token, activationId: a.body.data.activation_id };
    // check-ins refresh the token (7-day TTL) so tests that advance the clock keep a valid one
    lic.checkin = async (body = {}) => {
      const res = await h.panel('/v1/checkin', { token: lic.token, ...server, panel_version: '1.0.0', ...body }, { skipVerify: true });
      if (res.body?.data?.token) lic.token = res.body.data.token;
      return res;
    };
    return lic;
  };
  market.download = (body, opts) => h.panel('/v1/market/download', body, opts);
  market.fetchPackage = async (url) => {
    const u = new URL(url);
    return h.http.get(`${u.pathname}${u.search}`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
  };
  market.marketKey = (scopes) => h.createApiKey({ scopes });
  return market;
}

export { KIDS };
