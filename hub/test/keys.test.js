import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bootHub, HOUR } from './support.js';
import { KIDS, pubOf, privOf } from './fixtures/index.js';
import { kidOf, parseSignatureHeader } from '../shared/keys.js';

let h;
before(async () => { h = await bootHub(); });
after(() => h.close());

test('kid is the first 8 hex of sha256(raw 32-byte public key), for PEM strings and KeyObjects', () => {
  const pem = pubOf(KIDS.licenseA);
  const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  assert.equal(der.length, 44);
  assert.equal(kidOf(pem), crypto.createHash('sha256').update(der.subarray(12)).digest('hex').slice(0, 8));
  assert.equal(kidOf(pem), KIDS.licenseA);
  assert.equal(kidOf(crypto.createPrivateKey(privOf(KIDS.pluginA))), KIDS.pluginA);
  assert.throws(() => kidOf(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey), /Ed25519/);
});

test('active(purpose), byKid and listPublic: retired keys are never listed', () => {
  assert.equal(h.ctx.keys.active('license').kid, KIDS.licenseA);
  assert.equal(h.ctx.keys.active('plugin').kid, KIDS.pluginA);
  assert.equal(h.ctx.keys.byKid(KIDS.pluginB).status, 'pending');
  assert.equal(h.ctx.keys.byKid('00000000'), null);
  assert.ok(!('privateKey' in h.ctx.keys.byKid(KIDS.licenseA)), 'byKid never exposes the private half');
  assert.deepEqual(h.ctx.keys.listPublic('plugin').map((k) => [k.kid, k.status]).sort(), [[KIDS.pluginA, 'active'], [KIDS.pluginB, 'pending']].sort());
  h.ctx.keys.setStatus(KIDS.pluginB, 'retired');
  assert.deepEqual(h.ctx.keys.listPublic('plugin').map((k) => k.kid), [KIDS.pluginA]);
  assert.equal(h.ctx.keys.byKid(KIDS.pluginB).status, 'retired', 'byKid still answers for retired keys');
  h.ctx.keys.setStatus(KIDS.pluginB, 'pending');
  assert.throws(() => h.ctx.keys.listPublic('other'), /purpose/);
  assert.ok(h.ctx.keys.listPublic('license').every((k) => k.pub.startsWith('-----BEGIN PUBLIC KEY-----')));
});

test('sign() enforces purpose, status and encoding; verify() mirrors it', () => {
  const bytes = Buffer.from('package digest or canonical body');
  assert.throws(() => h.ctx.keys.sign(bytes, { kid: KIDS.licenseA, purpose: 'plugin' }), (e) => e.code === 'key_purpose_mismatch');
  assert.throws(() => h.ctx.keys.sign(bytes, { kid: KIDS.pluginA, purpose: 'license' }), (e) => e.code === 'key_purpose_mismatch');
  assert.throws(() => h.ctx.keys.sign(bytes, { kid: 'deadbeef', purpose: 'license' }), (e) => e.code === 'unknown_kid');
  assert.throws(() => h.ctx.keys.sign(bytes, { purpose: 'nope' }), (e) => e.code === 'invalid_key_purpose');
  assert.throws(() => h.ctx.keys.sign(bytes, { kid: KIDS.licenseA, purpose: 'license', encoding: 'hex' }), (e) => e.code === 'invalid_encoding');
  const b64 = h.ctx.keys.sign(bytes, { kid: KIDS.pluginA, purpose: 'plugin', encoding: 'base64' });
  const url = h.ctx.keys.sign(bytes, { kid: KIDS.pluginA, purpose: 'plugin', encoding: 'base64url' });
  const raw = crypto.sign(null, bytes, crypto.createPrivateKey(privOf(KIDS.pluginA)));
  assert.equal(b64, raw.toString('base64'), 'standard base64 with padding, exact string');
  assert.equal(b64.length, 88);
  assert.ok(b64.endsWith('=='));
  assert.equal(url, raw.toString('base64url'));
  assert.equal(url.length, 86);
  assert.equal(h.ctx.keys.sign(bytes, { purpose: 'plugin' }), b64, 'default encoding for plugin is base64');
  assert.equal(h.ctx.keys.sign(bytes, { purpose: 'license' }), crypto.sign(null, bytes, crypto.createPrivateKey(privOf(KIDS.licenseA))).toString('base64url'), 'default for license is base64url');
  assert.equal(crypto.verify(null, bytes, crypto.createPublicKey(pubOf(KIDS.pluginA)), Buffer.from(b64, 'base64')), true, 'what the host decodes');
  assert.equal(h.ctx.keys.verify(bytes, b64, { kid: KIDS.pluginA, purpose: 'plugin', encoding: 'base64' }), true);
  assert.equal(h.ctx.keys.verify(bytes, b64, { kid: KIDS.pluginA, purpose: 'license', encoding: 'base64' }), false, 'cross-purpose verify is false');
  assert.equal(h.ctx.keys.verify(bytes, b64, { kid: KIDS.pluginA, purpose: 'plugin', encoding: 'base64url' }), false, 'wrong alphabet');
  assert.equal(h.ctx.keys.verify(Buffer.from('other'), b64, { kid: KIDS.pluginA, purpose: 'plugin', encoding: 'base64' }), false);
  assert.equal(h.ctx.keys.verify(bytes, b64, { kid: 'deadbeef', purpose: 'plugin', encoding: 'base64' }), false);
  h.ctx.keys.setStatus(KIDS.pluginA, 'retired');
  assert.throws(() => h.ctx.keys.sign(bytes, { kid: KIDS.pluginA, purpose: 'plugin' }), (e) => e.code === 'key_retired');
  assert.equal(h.ctx.keys.verify(bytes, b64, { kid: KIDS.pluginA, purpose: 'plugin', encoding: 'base64' }), false);
  h.ctx.keys.setStatus(KIDS.pluginA, 'active');
  const pending = h.ctx.keys.sign(bytes, { kid: KIDS.pluginB, purpose: 'plugin' });
  assert.equal(h.ctx.keys.verify(bytes, pending, { kid: KIDS.pluginB, purpose: 'plugin' }), true, 'pending/retiring keys sign and verify');
});

test('signResponse signs the canonical body with the active license key only', () => {
  const headers = {};
  const res = { set: (k, v) => { headers[k] = v; } };
  const body = { data: { a: 1 }, meta: { nonce: 'n_1' } };
  h.ctx.keys.signResponse(res, body);
  const sig = parseSignatureHeader(headers['X-WHM-Signature']);
  assert.equal(sig.kid, KIDS.licenseA);
  assert.equal(h.ctx.licenses.verifySigned(Buffer.from('{"data":{"a":1},"meta":{"nonce":"n_1"}}'), headers['X-WHM-Signature']), true);
  assert.equal(parseSignatureHeader('kid=zz,sig=x'), null);
});

test('admin API: create (pending) → activate (flips statuses, fires keyActivated) → retire (honours beforeKeyRetire and the retire window)', async () => {
  const activated = [];
  h.ctx.hooks.keyActivated.push((e) => activated.push(e));
  let refuse = false;
  const hookCalls = [];
  // A plain Error carrying status + code (no HttpError import) must still surface as 409 key_in_use.
  h.ctx.hooks.beforeKeyRetire.push(({ kid }) => { hookCalls.push(kid); if (refuse) { const err = new Error('referenced by packages'); err.status = 409; err.code = 'key_in_use'; throw Object.assign(err, { kid }); } });

  const list = await h.admin('get', '/v1/admin/signing-keys?purpose=plugin');
  assert.deepEqual(list.body.data.map((k) => k.kid).sort(), [KIDS.pluginA, KIDS.pluginB].sort());
  assert.ok(list.body.data.every((k) => !('privateKey' in k) && !('private_key' in k)));
  const created = await h.admin('post', '/v1/admin/signing-keys').send({ purpose: 'plugin' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const kid = created.body.data.kid;
  assert.equal(created.body.data.status, 'pending');
  assert.ok(created.body.data.pub.includes('BEGIN PUBLIC KEY'));
  assert.equal(kidOf(created.body.data.pub), kid);
  const file = path.join(h.ctx.keys.dir, `${kid}.ed25519`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(h.ctx.keys.listPublic('plugin').some((k) => k.kid === kid && k.status === 'pending'), 'pending keys are published so panels pin them early');

  const act = await h.admin('post', `/v1/admin/signing-keys/${kid}/activate`).send({});
  assert.equal(act.status, 200, JSON.stringify(act.body));
  assert.equal(act.body.data.status, 'active');
  assert.equal(h.ctx.keys.active('plugin').kid, kid);
  assert.equal(h.ctx.keys.byKid(KIDS.pluginA).status, 'retiring');
  assert.deepEqual(activated, [{ kid, purpose: 'plugin', previousKid: KIDS.pluginA }]);
  assert.equal(h.ctx.keys.active('license').kid, KIDS.licenseA, 'the license key is untouched');
  assert.equal(h.ctx.keys.sign(Buffer.from('x'), { purpose: 'plugin' }).length, 88);

  // retire: the 2× check-in window objects first (the hook is not even consulted)
  const r1 = await h.admin('post', `/v1/admin/signing-keys/${KIDS.pluginA}/retire`).send({});
  assert.equal(r1.status, 409);
  assert.equal(r1.body.error.code, 'key_in_use');
  assert.match(r1.body.error.message, /retry after/);
  assert.equal(hookCalls.length, 0);
  // past the window, the beforeKeyRetire guard refuses on its own
  h.advance(2 * 12 * HOUR + 1000);
  refuse = true;
  const r2 = await h.admin('post', `/v1/admin/signing-keys/${KIDS.pluginA}/retire`).send({});
  assert.equal(r2.status, 409, JSON.stringify(r2.body));
  assert.equal(r2.body.error.code, 'key_in_use');
  assert.equal(r2.body.error.message, 'referenced by packages');
  assert.deepEqual(hookCalls, [KIDS.pluginA]);
  assert.equal(h.ctx.keys.byKid(KIDS.pluginA).status, 'retiring', 'the hook refusal left the key untouched');
  const forced = await h.admin('post', `/v1/admin/signing-keys/${KIDS.pluginA}/retire`).send({ force: true });
  assert.equal(forced.status, 409, 'force skips the window, never the guard');
  assert.equal(hookCalls.length, 2);
  refuse = false;
  const r3 = await h.admin('post', `/v1/admin/signing-keys/${KIDS.pluginA}/retire`).send({});
  assert.equal(r3.status, 200, JSON.stringify(r3.body));
  assert.equal(r3.body.data.status, 'retired');
  assert.equal(hookCalls.length, 3);
  assert.ok(!h.ctx.keys.listPublic('plugin').some((k) => k.kid === KIDS.pluginA));
  assert.equal((await h.admin('post', `/v1/admin/signing-keys/${kid}/retire`).send({})).body.error.code, 'key_in_use', 'the active key cannot be retired');
  assert.equal((await h.admin('post', `/v1/admin/signing-keys/${KIDS.pluginA}/activate`).send({})).body.error.code, 'key_retired');
  const audit = h.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'signing_key.%' ORDER BY id").all().map((r) => r.action);
  assert.deepEqual(audit, ['signing_key.create', 'signing_key.activate', 'signing_key.retire']);
  assert.equal((await h.admin('post', '/v1/admin/signing-keys').send({ purpose: 'rsa' })).status, 422);
  assert.equal((await h.admin('post', '/v1/admin/signing-keys/zzzz/activate').send({})).status, 422);
  h.ctx.hooks.keyActivated.length = 0;
  h.ctx.hooks.beforeKeyRetire.length = 0;
});

test('license key rotation: the retire window is 2× token TTL and GET /v1/keys publishes license keys only', async () => {
  const act = await h.admin('post', `/v1/admin/signing-keys/${KIDS.licenseB}/activate`).send({});
  assert.equal(act.status, 200);
  assert.equal(h.ctx.keys.byKid(KIDS.licenseA).status, 'retiring');
  const keys = await h.http.get('/v1/keys');
  assert.deepEqual(keys.body.data.keys.map((k) => [k.kid, k.status, k.purpose]).sort(), [[KIDS.licenseA, 'retiring', 'license'], [KIDS.licenseB, 'active', 'license']].sort());
  const early = await h.admin('post', `/v1/admin/signing-keys/${KIDS.licenseA}/retire`).send({});
  assert.equal(early.body.error.code, 'key_in_use');
  h.advance(2 * 168 * HOUR + 1000);
  assert.equal((await h.admin('post', `/v1/admin/signing-keys/${KIDS.licenseA}/retire`).send({})).status, 200);
  assert.equal((await h.http.get('/v1/keys')).body.data.keys.length, 1);
  const forced = await h.admin('post', `/v1/admin/signing-keys/${KIDS.licenseB}/retire`).send({ force: true });
  assert.equal(forced.body.error.code, 'key_in_use', 'force never retires the active key');
  h.advance(-2 * 168 * HOUR - 1000);
});

test('keys.active_kid in the config promotes a pending key only when nothing is active; the database wins otherwise', async () => {
  const a = await bootHub({ keys: false, config: { keys: { active_kid: { license: KIDS.licenseB, plugin: KIDS.pluginB } } } });
  try {
    assert.equal(a.ctx.keys.active('license'), null);
    a.ctx.keys.register({ purpose: 'license', publicPem: pubOf(KIDS.licenseA), status: 'pending' });
    a.ctx.keys.register({ purpose: 'license', publicPem: pubOf(KIDS.licenseB), status: 'pending' });
    assert.equal(a.ctx.keys.active('license').kid, KIDS.licenseB, 'config promoted license-b');
    assert.equal(a.ctx.keys.byKid(KIDS.licenseB).status, 'active');
    assert.equal(a.ctx.keys.byKid(KIDS.licenseA).status, 'pending');
    a.ctx.signingKeys.activate(KIDS.licenseA);
    a.ctx.keys.reload();
    assert.equal(a.ctx.keys.active('license').kid, KIDS.licenseA, 'the database status wins over the stale config');
    assert.throws(() => a.ctx.keys.register({ kid: 'deadbeef', purpose: 'plugin', publicPem: pubOf(KIDS.pluginA) }), (e) => e.code === 'kid_mismatch');
    assert.equal(a.ctx.health().ok, false, 'no plugin key → unhealthy');
    assert.equal((await a.http.get('/healthz')).status, 503);
    a.ctx.keys.register({ purpose: 'plugin', publicPem: pubOf(KIDS.pluginA), status: 'active' });
    assert.equal((await a.http.get('/healthz')).status, 200);
  } finally {
    await a.close();
  }
});

test('a key file whose public half does not match its row is ignored (cannot sign)', async () => {
  const a = await bootHub({ keys: false });
  try {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const kid = kidOf(publicKey);
    fs.copyFileSync(path.join(a.ctx.keys.dir, `${KIDS.licenseA}.ed25519`), path.join(a.ctx.keys.dir, `${kid}.ed25519`));
    a.ctx.keys.register({ purpose: 'license', publicPem: publicKey.export({ type: 'spki', format: 'pem' }), status: 'active' });
    assert.equal(a.ctx.keys.byKid(kid).has_private_key, false);
    assert.throws(() => a.ctx.keys.sign(Buffer.from('x'), { kid, purpose: 'license' }), (e) => e.code === 'key_unavailable');
  } finally {
    await a.close();
  }
});
