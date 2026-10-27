import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { bootHub, DAY, HOUR } from './support.js';
import { KIDS, pubOf } from './fixtures/index.js';
import { drift } from '../shared/fingerprint.js';

let h;
before(async () => { h = await bootHub(); });
after(() => h.close());

function tamper(token, mutate) {
  const [p, payload, sig] = token.split('.');
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  mutate(obj);
  const { canonicalize } = h.ctx; // not exposed; rebuild manually below
  return `${p}.${Buffer.from(JSON.stringify(obj)).toString('base64url')}.${sig}`;
}

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
  const v = h.ctx.licenses.verifyToken(token);
  assert.equal(v.ok, true);
  assert.deepEqual(v.payload, payload);
});

test('exp is min(iat + ttl, lexp + grace)', () => {
  const { license } = h.issue('whm-solo-monthly');
  h.db.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').run(new Date(h.clock.t + 2 * DAY).toISOString(), license.id);
  const lic = h.ctx.licenses.get(license.id);
  const { payload } = h.ctx.licenses.issueToken({ license: lic, activation: { id: 'act_TEST000000000002', fingerprint: 'sha256:' + '0'.repeat(64) } });
  assert.equal(payload.exp, payload.lexp + lic.grace_days * 86400);
});

test('a tampered payload, wrong kid, bad signature and malformed token are refused', () => {
  const { license } = h.issue();
  const { token } = h.ctx.licenses.issueToken({ license, activation: { id: 'act_TEST000000000003', fingerprint: 'sha256:' + '1'.repeat(64) } });
  const [p, payload, sig] = token.split('.');
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const reencode = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(h.ctx.licenses.verifyToken(`${p}.${reencode({ ...obj, ed: 'enterprise' })}.${sig}`).reason, 'not_canonical');
  const canonical = (o) => Buffer.from(Object.keys(o).sort().reduce((s, k) => s, JSON.stringify(o))).toString('base64url');
  assert.equal(h.ctx.licenses.verifyToken(`${p}.${payload}.${sig.slice(0, -2)}AA`).reason, 'bad_signature');
  assert.equal(h.ctx.licenses.verifyToken(`${p}.${payload}.${sig}x`).reason, 'malformed');
  assert.equal(h.ctx.licenses.verifyToken('WHMT0.' + payload + '.' + sig).reason, 'malformed');
  assert.equal(h.ctx.licenses.verifyToken('garbage').reason, 'malformed');
  assert.equal(h.ctx.licenses.verifyToken(42).reason, 'malformed');
  assert.equal(h.ctx.licenses.verifyToken(`${p}.${Buffer.from('{"v":1}').toString('base64url')}.${sig}`).reason, 'malformed');
  // A payload re-serialised canonically with a foreign kid: unknown kid before signature.
  const withKid = { ...obj, kid: 'deadbeef' };
  const { canonicalize } = awaitImport();
  assert.equal(h.ctx.licenses.verifyToken(`${p}.${canonicalize(withKid).toString('base64url')}.${sig}`).reason, 'unknown_kid');
  void canonical;
});

function awaitImport() { return { canonicalize: (o) => Buffer.from(require_canonical(o)) }; }
function require_canonical(o) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(o));
}

test('a token signed by a retired key is rejected; a retiring key still verifies', async () => {
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
  const act = h.db.prepare('INSERT INTO activations (id, license_id, fingerprint, fp_components_json, first_seen) VALUES (?, ?, ?, ?, ?)');
  act.run('act_TEST000000000006', license.id, a.fingerprint, JSON.stringify(a.fp_components), new Date().toISOString());
  assert.deepEqual(h.ctx.activations.matchFingerprint('act_TEST000000000006', a.fingerprint, a.fp_components), { ok: true, drift: 0 });
  assert.deepEqual(h.ctx.activations.matchFingerprint('act_TEST000000000006', 'sha256:' + '9'.repeat(64), nicAndDisk), { ok: true, drift: 0.5 });
  assert.deepEqual(h.ctx.activations.matchFingerprint('act_TEST000000000006', 'sha256:' + '9'.repeat(64), { ...machine, mac: 'f'.repeat(64) }), { ok: false, drift: 0.8 });
});

test('the panel-side verification of a signed response uses the license key only', async () => {
  const { key } = h.issue();
  const res = await h.activate(key);
  assert.equal(res.status, 200);
  const header = res.headers['x-whm-signature'];
  assert.equal(h.ctx.licenses.verifySigned(Buffer.from(JSON.stringify(res.body)), header), false, 'non-canonical bytes do not verify');
  const { canonicalize } = await import('../shared/canonical.js');
  assert.equal(h.ctx.licenses.verifySigned(canonicalize(res.body), header), true);
  assert.equal(h.ctx.licenses.verifySigned(canonicalize(res.body), header.replace(KIDS.licenseA, KIDS.pluginA)), false);
  void pubOf; void HOUR; void tamper;
});
