import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { bootHub, DAY } from './support.js';
import { KIDS } from './fixtures/index.js';

let h;
before(async () => { h = await bootHub(); });
after(() => h.close());

test('happy path: a signed 200 with token, activation_id, interval and messages; the row stores hashes only', async () => {
  const { license, key } = h.issue('whm-pro-annual');
  const server = h.fp('happy');
  const res = await h.activate(key, server);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.signatureKid, KIDS.licenseA);
  const { data } = res.body;
  assert.match(data.activation_id, /^act_/);
  assert.equal(data.checkin_interval_hours, 12);
  assert.deepEqual(data.messages, []);
  const v = h.ctx.licenses.verifyToken(data.token);
  assert.equal(v.ok, true);
  assert.equal(v.payload.lid, license.id);
  assert.equal(v.payload.aid, data.activation_id);
  assert.equal(v.payload.fp, server.fingerprint);
  const row = h.ctx.activations.get(data.activation_id);
  assert.equal(row.status, 'active');
  assert.equal(row.hostname, 'srv.example.test');
  assert.deepEqual(row.fp_components, server.fp_components);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'license.activate' AND target = ?").get(license.id).n, 1);
});

test('re-activating the same server reuses the activation; a replaced NIC updates the fingerprint', async () => {
  const { key } = h.issue('whm-solo-annual');
  const server = h.fp('reuse');
  const first = await h.activate(key, server);
  const again = await h.activate(key, server);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.activation_id, first.body.data.activation_id);
  const drifted = { fp_components: { ...server.fp_components, mac: 'a'.repeat(64) } };
  drifted.fingerprint = 'sha256:' + 'b'.repeat(64);
  const third = await h.activate(key, drifted);
  assert.equal(third.status, 200);
  assert.equal(third.body.data.activation_id, first.body.data.activation_id);
  assert.equal(third.body.data.messages[0].code, 'fingerprint_updated');
  const row = h.ctx.activations.get(first.body.data.activation_id);
  assert.equal(row.drift_events, 1);
  assert.equal(row.fingerprint, drifted.fingerprint);
});

test('activation_limit answers 409 with the current activations list, signed', async () => {
  const { key } = h.issue('whm-solo-annual');
  const first = await h.activate(key, h.fp('one'));
  const res = await h.activate(key, h.fp('two'));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'activation_limit');
  assert.equal(res.body.error.message, '1 of 1 activations in use');
  assert.equal(res.body.error.activations.length, 1);
  assert.equal(res.body.error.activations[0].id, first.body.data.activation_id);
  assert.equal(res.body.error.activations[0].hostname, 'srv.example.test');
  assert.ok(res.body.error.activations[0].last_checkin);
  assert.equal(res.body.meta.nonce, res.whmNonce);
});

test('a 31-day-stale activation is reclaimed by a new server and the transfer webhook is queued', async () => {
  const { license, key } = h.issue('whm-solo-annual');
  h.db.prepare('INSERT INTO webhook_endpoints (id, owner_type, owner_id, url, secret_enc, events_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run('whk_RECLAIM000000001', 'vendor', 'vnd_default', 'https://hooks.example.test/x', h.ctx.crypto.encrypt('s'), '["license.transferred"]', new Date().toISOString());
  const old = await h.activate(key, h.fp('old'));
  h.advance(31 * DAY);
  const res = await h.activate(key, h.fp('new'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.notEqual(res.body.data.activation_id, old.body.data.activation_id);
  assert.equal(res.body.data.messages[0].code, 'activation_reclaimed');
  assert.equal(h.ctx.activations.get(old.body.data.activation_id).status, 'reclaimed');
  const delivery = h.db.prepare("SELECT payload_json FROM webhook_deliveries WHERE event = 'license.transferred'").get();
  assert.ok(delivery);
  const payload = JSON.parse(delivery.payload_json);
  assert.equal(payload.data.license_id, license.id);
  assert.equal(payload.data.reason, 'reclaimed');
  h.advance(-31 * DAY);
});

test('a 29-day-stale activation is not reclaimed', async () => {
  const { key } = h.issue('whm-solo-annual');
  await h.activate(key, h.fp('old29'));
  h.advance(29 * DAY);
  const res = await h.activate(key, h.fp('new29'));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'activation_limit');
  h.advance(-29 * DAY);
});

test('more than 3 activations per 30 days are blocked until the vendor lifts the limit', async () => {
  const { license, key } = h.issue('whm-reseller-annual-5');
  for (let i = 0; i < 3; i++) assert.equal((await h.activate(key, h.fp(`s${i}`))).status, 200);
  const fourth = await h.activate(key, h.fp('s3'));
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.error.code, 'reactivation_limit');
  const lift = await h.admin('post', `/v1/admin/licenses/${license.id}/lift-reactivation-limit`).send({ days: 3 });
  assert.equal(lift.status, 200);
  assert.equal((await h.activate(key, h.fp('s3'))).status, 200);
  h.advance(31 * DAY);
  assert.equal((await h.activate(key, h.fp('s4'))).status, 200, 'the window slides');
  h.advance(-31 * DAY);
});

test('nonce replay and timestamp skew are rejected with signed errors', async () => {
  const { key } = h.issue();
  const nonce = h.nonce();
  const first = await h.activate(key, h.fp('nonce'), {}, { nonceOverride: nonce });
  const replay = await h.panel('/v1/activate', { key, ...h.fp('nonce'), hostname: 'srv.example.test', panel_version: '1.0.0' }, { nonceOverride: nonce });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error.code, 'nonce_replay');
  assert.equal(replay.body.meta.nonce, nonce);
  const skewed = await h.panel('/v1/activate', { key, ...h.fp('skew'), hostname: 'srv.example.test', panel_version: '1.0.0' }, { tsOverride: h.ts() - 301 });
  assert.equal(skewed.status, 400);
  assert.equal(skewed.body.error.code, 'clock_skew');
  const future = await h.panel('/v1/activate', { key, ...h.fp('skew2'), hostname: 'srv.example.test', panel_version: '1.0.0' }, { tsOverride: h.ts() + 301 });
  assert.equal(future.body.error.code, 'clock_skew');
  const edge = await h.panel('/v1/activate', { key, ...h.fp('nonce'), hostname: 'srv.example.test', panel_version: '1.0.0' }, { tsOverride: h.ts() - 300 });
  assert.equal(edge.status, 200, 'exactly 300 s is accepted');
});

test('header/body nonce and timestamp must match', async () => {
  const { key } = h.issue();
  const n = h.nonce();
  const body = { key, ...h.fp('hdr'), hostname: 'srv.example.test', panel_version: '1.0.0', nonce: n, ts: h.ts() };
  const noHeader = await h.http.post('/v1/activate').send(body);
  assert.equal(noHeader.status, 400);
  assert.equal(noHeader.body.error.code, 'nonce_mismatch');
  assert.ok(noHeader.headers['x-whm-signature'], 'even that error is signed');
  const wrongTs = await h.http.post('/v1/activate').set('X-WHM-Nonce', n).set('X-WHM-Timestamp', String(body.ts + 1)).send(body);
  assert.equal(wrongTs.body.error.code, 'timestamp_mismatch');
});

test('unknown, revoked, suspended, expired and not-yet-started licenses are refused', async () => {
  const unknown = await h.activate('WHM-AAAA-AAAA-AAAA-AAAA', h.fp('u'));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'invalid_key');
  const rev = h.issue(); h.ctx.licenses.revoke(rev.license.id, { reason: 'x' });
  assert.equal((await h.activate(rev.key, h.fp('r'))).body.error.code, 'revoked');
  const sus = h.issue(); h.ctx.licenses.suspend(sus.license.id, { reason: 'x' });
  assert.equal((await h.activate(sus.key, h.fp('s'))).body.error.code, 'suspended');
  const exp = h.issue(); h.db.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').run(new Date(h.clock.t - 30 * DAY).toISOString(), exp.license.id);
  assert.equal((await h.activate(exp.key, h.fp('e'))).body.error.code, 'expired');
  const grace = h.issue(); h.db.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').run(new Date(h.clock.t - 2 * DAY).toISOString(), grace.license.id);
  const g = await h.activate(grace.key, h.fp('g'));
  assert.equal(g.status, 200, 'grace still activates');
  assert.equal(g.body.data.status, 'grace');
  const pending = h.issue('whm-pro-annual', { starts_at: new Date(h.clock.t + 5 * DAY).toISOString() });
  assert.equal((await h.activate(pending.key, h.fp('p'))).body.error.code, 'not_started');
});

test('deactivate by token frees the slot; transfer moves the license atomically', async () => {
  const { key } = h.issue('whm-solo-annual');
  const a = await h.activate(key, h.fp('d1'));
  const d = await h.panel('/v1/deactivate', { token: a.body.data.token, reason: 'migrating' });
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.data, { deactivated: true, status: 'deactivated' });
  const b = await h.activate(key, h.fp('d2'));
  assert.equal(b.status, 200);
  const t = await h.panel('/v1/transfers', { key, from_activation: b.body.data.activation_id, ...h.fp('d3'), hostname: 'new.example.test', panel_version: '1.0.0' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.data.transferred_from, b.body.data.activation_id);
  assert.equal(h.ctx.activations.get(b.body.data.activation_id).status, 'transferred');
  assert.equal(h.ctx.activations.get(t.body.data.activation_id).status, 'active');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM transfers WHERE from_activation_id = ?').get(b.body.data.activation_id).n, 1);
  const old = await h.panel('/v1/checkin', { token: b.body.data.token, ...h.fp('d2'), panel_version: '1.0.0' });
  assert.equal(old.status, 403);
  assert.equal(old.body.error.code, 'deactivated');
});

test('activationExtras hooks are merged inside the signed body', async () => {
  h.ctx.hooks.activationExtras.push((activation) => ({ plugin_signing_keys: h.ctx.keys.listPublic('plugin'), revocations_head_ts: 0, seen_activation: activation.id }));
  const { key } = h.issue();
  const res = await h.activate(key, h.fp('extras'));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.seen_activation, res.body.data.activation_id);
  assert.equal(res.body.data.revocations_head_ts, 0);
  assert.deepEqual(res.body.data.plugin_signing_keys.map((k) => k.kid).sort(), [KIDS.pluginA, KIDS.pluginB].sort());
  h.ctx.hooks.activationExtras.length = 0;
});
