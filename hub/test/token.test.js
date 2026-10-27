import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { bootHub, tamperSignature, DAY } from './support.js';
import { KIDS } from './fixtures/index.js';
import { drift, driftPct } from '../shared/fingerprint.js';
import { canonicalize } from '../shared/canonical.js';

let h;
before(async () => { h = await bootHub(); });
after(() => h.close());

test('sign/verify round-trip carries every §16.4 field and the active license kid', () => {
  const { license } = h.issue('whm-pro-annual');
  const activation = { id: 'act_TEST000000000001', fingerprint: h.fp().fingerprint };
  const { token, payload } = h.ctx.licenses.issueToken({ license, activation });
  assert.match(token, /^WHMT1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
  for (const k of ['v', 'iss', 'kid', 'lid', 'aid', 'cid', 'ed', 'rank', 'lim', 'feat', 'fp', 'iat', 'nbf', 'exp', 'lexp', 'grace', 'nonce', 'status']) assert.ok(k in payload, k);
  assert.equal(payload.kid, KIDS.licenseA);
  assert.equal(payload.iss, 'https://hub.test');
  assert.equal(payload.nbf, payload.iat - 300);
  assert.equal(payload.exp, payload.iat + 168 * 3600);
  assert.equal(payload.status, 'active');
  assert.equal(payload.lim.max_resellers, 5);
  assert.equal(payload.feat.marketplace_paid, true);
  const v = h.ctx.licenses.verifyToken(token);
  assert.equal(v.ok, true);
  assert.deepEqual(v.payload, payload);
});

test('exp is min(iat + ttl, lexp + grace); an expired license still gets a verifiable token with status expired', () => {
  const { license } = h.issue('whm-solo-monthly');
  h.db.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').run(new Date(h.clock.t - 2 * DAY).toISOString(), license.id);
  const lic = h.ctx.licenses.get(license.id);
  const act = { id: 'act_TEST000000000002', fingerprint: 'sha256:' + '0'.repeat(64) };
  const { payload } = h.ctx.licenses.issueToken({ license: lic, activation: act });
  assert.equal(payload.status, 'grace');
  assert.equal(payload.exp, payload.lexp + lic.grace_days * 86400);
  assert.ok(payload.exp < payload.iat + 168 * 3600);
  h.db.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').run(new Date(h.clock.t - 30 * DAY).toISOString(), license.id);
  const { token, payload: expired } = h.ctx.licenses.issueToken({ license: h.ctx.licenses.get(license.id), activation: act });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.exp, expired.iat + 168 * 3600);
  assert.equal(h.ctx.licenses.verifyToken(token).ok, true);
});

test('a tampered payload, wrong kid, bad signature and malformed token are refused', () => {
  const { license } = h.issue();
  const { token } = h.ctx.licenses.issueToken({ license, activation: { id: 'act_TEST000000000003', fingerprint: 'sha256:' + '1'.repeat(64) } });
  const [p, payload, sig] = token.split('.');
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const verify = (t) => h.ctx.licenses.verifyToken(t);
  // Non-canonical re-serialisation is caught before the signature is checked.
  assert.equal(verify(`${p}.${Buffer.from(JSON.stringify({ zz: 1, ...obj })).toString('base64url')}.${sig}`).reason, 'not_canonical');
  assert.equal(verify(`${p}.${Buffer.from(JSON.stringify(obj, null, 1)).toString('base64url')}.${sig}`).reason, 'not_canonical');
  // Canonical but edited payload: the signature no longer matches.
  assert.equal(verify(`${p}.${canonicalize({ ...obj, ed: 'enterprise' }).toString('base64url')}.${sig}`).reason, 'bad_signature');
  assert.equal(verify(`${p}.${canonicalize({ ...obj, kid: 'deadbeef' }).toString('base64url')}.${sig}`).reason, 'unknown_kid');
  assert.equal(verify(`${p}.${canonicalize({ ...obj, kid: KIDS.pluginA }).toString('base64url')}.${sig}`).reason, 'unknown_kid', 'a plugin kid never verifies a token');
  assert.equal(verify(tamperSignature(token)).reason, 'bad_signature');
  assert.notEqual(tamperSignature(token), token);
  assert.equal(verify(`${p}.${payload}.${sig}x`).reason, 'malformed');
  assert.equal(verify(`WHMT0.${payload}.${sig}`).reason, 'malformed');
  assert.equal(verify('garbage').reason, 'malformed');
  assert.equal(verify(42).reason, 'malformed');
  assert.equal(verify(`${p}.${Buffer.from('{"v":1}').toString('base64url')}.${sig}`).reason, 'malformed');
});

test('a token signed by a retired key is rejected; a retiring key still verifies', () => {
  const { license } = h.issue();
  const { token, payload } = h.ctx.licenses.issueToken({ license, activation: { id: 'act_TEST000000000004', fingerprint: 'sha256:' + '2'.repeat(64) } });
  assert.equal(payload.kid, KIDS.licenseA);
  h.ctx.keys.setStatus(KIDS.licenseA, 'retiring');
  assert.equal(h.ctx.licenses.verifyToken(token).ok, true);
  h.ctx.keys.setStatus(KIDS.licenseA, 'retired');
  assert.equal(h.ctx.licenses.verifyToken(token).reason, 'retired_kid');
  h.ctx.keys.setStatus(KIDS.licenseA, 'active');
});

test('nbf/exp boundaries honour the 300 s skew', () => {
  const { license } = h.issue();
  const { token, payload } = h.ctx.licenses.issueToken({ license, activation: { id: 'act_TEST000000000005', fingerprint: 'sha256:' + '3'.repeat(64) } });
  const at = (s) => h.ctx.licenses.verifyToken(token, { now: s * 1000 });
  assert.equal(at(payload.nbf - 300).ok, true);
  assert.equal(at(payload.nbf - 301).reason, 'not_yet_valid');
  assert.equal(at(payload.exp + 300).ok, true);
  assert.equal(at(payload.exp + 301).reason, 'expired');
});

test('fingerprint drift: ≤ 0.5 is the same activation, > 0.5 is a different server', () => {
  const a = h.fp('a');
  const nic = { ...a.fp_components, mac: 'f'.repeat(64) };
  const nicAndDisk = { ...nic, disk: 'e'.repeat(64) };
  const machine = { ...a.fp_components, machine_id: 'd'.repeat(64) };
  assert.equal(drift(a.fp_components, a.fp_components), 0);
  assert.equal(drift(a.fp_components, nic), 0.3);
  assert.equal(drift(a.fp_components, nicAndDisk), 0.5);
  assert.equal(drift(a.fp_components, machine), 0.5);
  assert.equal(drift(a.fp_components, { ...machine, mac: 'f'.repeat(64) }), 0.8);
  assert.equal(drift(a.fp_components, {}), 1);
  const { license } = h.issue();
  h.db.prepare('INSERT INTO activations (id, license_id, fingerprint, fp_components_json, first_seen) VALUES (?, ?, ?, ?, ?)')
    .run('act_TEST000000000006', license.id, a.fingerprint, JSON.stringify(a.fp_components), new Date().toISOString());
  assert.deepEqual(h.ctx.activations.matchFingerprint('act_TEST000000000006', a.fingerprint, a.fp_components), { ok: true, drift_pct: 0 });
  assert.deepEqual(h.ctx.activations.matchFingerprint('act_TEST000000000006', 'sha256:' + '9'.repeat(64), nicAndDisk), { ok: true, drift_pct: 50 });
  assert.deepEqual(h.ctx.activations.matchFingerprint('act_TEST000000000006', 'sha256:' + '9'.repeat(64), { ...machine, mac: 'f'.repeat(64) }), { ok: false, drift_pct: 80 });
  assert.equal(driftPct(a.fp_components, nic), 30);
  assert.equal(driftPct(a.fp_components, { ...machine, mac: 'f'.repeat(64) }), 80);
  assert.equal(driftPct(a.fp_components, {}), 100);
});

test('the panel-side verification of a signed response uses the license key only', async () => {
  const { key } = h.issue();
  const res = await h.activate(key);
  assert.equal(res.status, 200);
  const header = res.headers['x-whm-signature'];
  assert.match(header, new RegExp(`^kid=${KIDS.licenseA},sig=[A-Za-z0-9_-]{86}$`));
  assert.equal(h.ctx.licenses.verifySigned(Buffer.from(JSON.stringify(res.body, null, 2)), header), false, 'non-canonical bytes do not verify');
  assert.equal(h.ctx.licenses.verifySigned(canonicalize(res.body), header), true);
  assert.equal(h.ctx.licenses.verifySigned(canonicalize(res.body), header.replace(KIDS.licenseA, KIDS.pluginA)), false);
  assert.equal(h.ctx.licenses.verifySigned(canonicalize({ ...res.body, data: { ...res.body.data, status: 'hacked' } }), header), false);
});
