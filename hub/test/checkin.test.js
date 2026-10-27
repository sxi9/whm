import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { bootHub, tamperSignature, DAY, HOUR } from './support.js';
import { KIDS } from './fixtures/index.js';

let h;
before(async () => { h = await bootHub(); });
after(() => h.close());

const checkin = (token, server, extra = {}) => h.panel('/v1/checkin', { token, ...server, panel_version: '1.0.1', ...extra });

test('a check-in returns a fresh token, status, license summary and records usage incl. plugins', async () => {
  const { license, key } = h.issue('whm-pro-annual');
  const server = h.fp('c1');
  const a = await h.activate(key, server);
  h.advance(HOUR);
  const res = await checkin(a.body.data.token, server, { usage: { accounts: 41, resellers: 2, domains: 97, plugins: [{ id: 'net.whm.sample-notes', version: '1.0.0', state: 'enabled' }] } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { data } = res.body;
  assert.notEqual(data.token, a.body.data.token);
  assert.equal(data.status, 'active');
  assert.equal(data.revoked, false);
  assert.equal(data.license.edition, 'pro');
  assert.ok(data.license.days_left > 300);
  const v = h.ctx.licenses.verifyToken(data.token);
  assert.ok(v.payload.iat > h.ctx.licenses.verifyToken(a.body.data.token).payload.iat);
  const row = h.db.prepare('SELECT * FROM checkins WHERE license_id = ? ORDER BY id DESC').get(license.id);
  assert.equal(row.accounts_used, 41);
  assert.equal(row.resellers_used, 2);
  assert.equal(row.domains_used, 97);
  assert.deepEqual(JSON.parse(row.usage_json).plugins, [{ id: 'net.whm.sample-notes', version: '1.0.0', state: 'enabled' }]);
  assert.equal(row.result, 'ok');
  assert.equal(row.panel_version, '1.0.1');
  assert.deepEqual(h.ctx.licenses.lastUsage(license.id).accounts, 41);
});

test('checkin hooks receive activation, license and usage (active activations only)', async () => {
  const seen = [];
  h.ctx.hooks.checkin.push((e) => seen.push(e));
  const { key } = h.issue();
  const server = h.fp('hook');
  const a = await h.activate(key, server);
  await checkin(a.body.data.token, server, { usage: { accounts: 1, plugins: [{ id: 'x.y.z', version: '2.0.0' }] } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].activation.id, a.body.data.activation_id);
  assert.equal(seen[0].activation.status, 'active');
  assert.deepEqual(seen[0].usage.plugins, [{ id: 'x.y.z', version: '2.0.0' }]);
  await h.panel('/v1/deactivate', { token: a.body.data.token });
  await checkin(a.body.data.token, server);
  assert.equal(seen.length, 1, 'no hook for a deactivated activation');
  h.ctx.hooks.checkin.length = 0;
});

test('status transitions: active → grace → expired, suspended, revoked (403)', async () => {
  const { license, key } = h.issue('whm-solo-monthly');
  const server = h.fp('st');
  const a = await h.activate(key, server);
  let token = a.body.data.token;
  const exp = new Date(license.expires_at).getTime();
  h.clock.t = exp + DAY;
  let res = await checkin(token, server);
  assert.equal(res.body.data.status, 'grace');
  assert.equal(h.ctx.licenses.verifyToken(res.body.data.token).payload.status, 'grace');
  assert.ok(res.body.data.messages.some((m) => m.code === 'grace'));
  token = res.body.data.token;
  h.clock.t = exp + 8 * DAY;
  res = await checkin(token, server);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'expired');
  assert.equal(h.ctx.licenses.verifyToken(res.body.data.token).payload.status, 'expired');
  assert.equal(h.db.prepare('SELECT result FROM checkins WHERE license_id = ? ORDER BY id DESC').get(license.id).result, 'expired');
  token = res.body.data.token;
  h.ctx.licenses.renew(license.id, { term_months: 1 });
  res = await checkin(token, server);
  assert.equal(res.body.data.status, 'active');
  token = res.body.data.token;
  h.ctx.licenses.suspend(license.id, { reason: 'invoice overdue' });
  res = await checkin(token, server);
  assert.equal(res.body.data.status, 'suspended');
  token = res.body.data.token;
  h.ctx.licenses.unsuspend(license.id);
  res = await checkin(token, server);
  assert.equal(res.body.data.status, 'active');
  token = res.body.data.token;
  h.ctx.licenses.revoke(license.id, { reason: 'chargeback' });
  res = await checkin(token, server);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'revoked');
  assert.match(res.body.error.message, /chargeback/);
  assert.ok(res.body.error.revoked_at);
  assert.equal(res.body.meta.nonce, res.whmNonce);
});

test('an expired-but-valid-signature token can still check in; a forged one cannot', async () => {
  const { key } = h.issue('whm-pro-annual');
  const server = h.fp('old-token');
  const a = await h.activate(key, server);
  h.advance(10 * DAY);
  const res = await checkin(a.body.data.token, server);
  assert.equal(res.status, 200, 'the hub re-evaluates from the database');
  const forged = await checkin(tamperSignature(a.body.data.token), server);
  assert.equal(forged.status, 401);
  assert.equal(forged.body.error.code, 'invalid_token');
  h.advance(-10 * DAY);
});

test('fingerprint drift ≤ 0.5 updates the stored components; > 0.5 is a 409 with the activations list', async () => {
  const { key } = h.issue('whm-pro-annual');
  const server = h.fp('drift');
  const a = await h.activate(key, server);
  const newDisk = { fingerprint: 'sha256:' + 'c'.repeat(64), fp_components: { ...server.fp_components, disk: 'c'.repeat(64) } };
  let res = await checkin(a.body.data.token, newDisk);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.messages[0].code, 'fingerprint_updated');
  const row = h.ctx.activations.get(a.body.data.activation_id);
  assert.equal(row.drift_events, 1);
  assert.equal(row.fingerprint, newDisk.fingerprint);
  assert.equal(h.ctx.licenses.verifyToken(res.body.data.token).payload.fp, newDisk.fingerprint);
  const cloned = h.fp('clone');
  res = await checkin(res.body.data.token, cloned);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'fingerprint_mismatch');
  assert.equal(res.body.error.drift_pct, 100);
  assert.equal(res.body.error.activations[0].id, a.body.data.activation_id);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'activation.fingerprint_mismatch'").get().n, 1);
});

test('a partial clone (fractional drift 0.8 / 0.7) is a signed 409 that carries drift_pct as an integer', async () => {
  const { key } = h.issue('whm-pro-annual');
  const server = h.fp('partial');
  const a = await h.activate(key, server);
  // machine-id + NIC changed, disk kept: drift 0.8 → 80 %
  const partial = { fingerprint: 'sha256:' + 'd'.repeat(64), fp_components: { ...server.fp_components, machine_id: 'a'.repeat(64), mac: 'b'.repeat(64) } };
  // h.panel() throws unless X-WHM-Signature is present and verifies over the body
  const res = await checkin(a.body.data.token, partial);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'fingerprint_mismatch');
  assert.equal(res.body.error.drift_pct, 80);
  assert.equal(res.signatureKid, KIDS.licenseA);
  assert.equal('drift' in res.body.error, false, 'the fractional score is never emitted');
  // machine-id + disk changed: drift 0.7 → 70 %
  const other = { fingerprint: 'sha256:' + 'e'.repeat(64), fp_components: { ...server.fp_components, machine_id: 'a'.repeat(64), disk: 'c'.repeat(64) } };
  const res2 = await checkin(a.body.data.token, other);
  assert.equal(res2.status, 409);
  assert.equal(res2.body.error.drift_pct, 70);
  const audit = h.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'activation.fingerprint_mismatch' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(audit.args_redacted).drift_pct, 70);
  assert.equal(h.ctx.activations.get(a.body.data.activation_id).fingerprint, server.fingerprint, 'nothing was updated');
});

test('the signed wrapper fails closed: an unsignable body becomes a signed 500, never an unsigned 4xx', async () => {
  const { key } = h.issue('whm-pro-annual');
  const server = h.fp('unsignable');
  const a = await h.activate(key, server);
  const original = h.ctx.activations.checkin;
  h.ctx.activations.checkin = () => { throw Object.assign(new Error('partial clone'), { status: 409, code: 'fingerprint_mismatch', extra: { drift: 0.8 } }); };
  try {
    const res = await checkin(a.body.data.token, server);
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'signing_failed');
    assert.equal(res.body.meta.nonce, res.whmNonce);
    assert.equal(res.signatureKid, KIDS.licenseA, 'the 500 itself is signed');
  } finally { h.ctx.activations.checkin = original; }
  assert.equal((await checkin(a.body.data.token, server)).status, 200, 'the real service answers again');
});

test('usage above the edition limits is recorded as over_limit with a warning', async () => {
  const { license, key } = h.issue('whm-solo-annual');
  const server = h.fp('over');
  const a = await h.activate(key, server);
  const res = await checkin(a.body.data.token, server, { usage: { accounts: 30, resellers: 0, domains: 1 } });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.messages.some((m) => m.code === 'over_limit'));
  assert.equal(h.db.prepare('SELECT result FROM checkins WHERE license_id = ? ORDER BY id DESC').get(license.id).result, 'over_limit');
});

test('queued messages are delivered once per activation; pushMessage({ all }) reaches every panel', async () => {
  const one = h.issue(); const two = h.issue();
  const s1 = h.fp('m1'); const s2 = h.fp('m2');
  const a1 = await h.activate(one.key, s1); const a2 = await h.activate(two.key, s2);
  h.ctx.activations.pushMessage({ licenseId: one.license.id }, { level: 'warning', code: 'renewal_due', text: 'Renew soon' });
  h.ctx.activations.pushMessage({ all: true }, { level: 'critical', code: 'plugin_revocations_pending', text: 'Poll revocations', data: { head_ts: 123 } });
  const r1 = await checkin(a1.body.data.token, s1);
  const codes1 = r1.body.data.messages.map((m) => m.code);
  assert.ok(codes1.includes('renewal_due') && codes1.includes('plugin_revocations_pending'));
  assert.deepEqual(r1.body.data.messages.find((m) => m.code === 'plugin_revocations_pending').data, { head_ts: 123 });
  const r2 = await checkin(a2.body.data.token, s2);
  const codes2 = r2.body.data.messages.map((m) => m.code);
  assert.ok(!codes2.includes('renewal_due') && codes2.includes('plugin_revocations_pending'));
  const r1b = await checkin(r1.body.data.token, s1);
  assert.ok(!r1b.body.data.messages.some((m) => ['renewal_due', 'plugin_revocations_pending'].includes(m.code)), 'delivered once');
  assert.throws(() => h.ctx.activations.pushMessage({}, { code: 'x', text: 'y' }), /licenseId or all/);
});

test('a key rotation marks the next check-in as rotated and signs with the new kid', async () => {
  const { license, key } = h.issue();
  const server = h.fp('rot');
  const a = await h.activate(key, server);
  h.ctx.signingKeys.activate(KIDS.licenseB);
  const res = await checkin(a.body.data.token, server);
  assert.equal(res.status, 200);
  assert.equal(res.signatureKid, KIDS.licenseB);
  assert.equal(h.ctx.licenses.verifyToken(res.body.data.token).payload.kid, KIDS.licenseB);
  assert.equal(h.db.prepare('SELECT result FROM checkins WHERE license_id = ? ORDER BY id DESC').get(license.id).result, 'rotated');
  h.ctx.signingKeys.activate(KIDS.licenseA);
});

test('activationExtras are merged inside the signed check-in body', async () => {
  h.ctx.hooks.activationExtras.push(() => ({ plugin_signing_keys: h.ctx.keys.listPublic('plugin'), revocations_head_ts: 42 }));
  const { key } = h.issue();
  const server = h.fp('ex');
  const a = await h.activate(key, server);
  const res = await checkin(a.body.data.token, server);
  assert.equal(res.body.data.revocations_head_ts, 42);
  assert.ok(res.body.data.plugin_signing_keys.every((k) => k.pub.includes('BEGIN PUBLIC KEY')));
  h.ctx.hooks.activationExtras.length = 0;
});

test('activationExtras can add keys but never replace token, activation_id, status or messages', async () => {
  h.ctx.hooks.activationExtras.push(() => ({ token: 'WHMT1.forged.sig', activation_id: 'act_forged', status: 'revoked', messages: [{ level: 'error', code: 'injected' }], revocations_head_ts: 7 }));
  try {
    const { key } = h.issue();
    const server = h.fp('ex2');
    const a = await h.activate(key, server);
    assert.equal(a.body.data.revocations_head_ts, 7);
    assert.match(a.body.data.token, /^WHMT1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
    assert.ok(h.ctx.licenses.verifyToken(a.body.data.token).ok, 'the real token survives the hook');
    assert.match(a.body.data.activation_id, /^act_/);
    assert.notEqual(a.body.data.activation_id, 'act_forged');
    assert.equal(a.body.data.status, 'active');
    assert.ok(!a.body.data.messages.some((m) => m.code === 'injected'));
    const res = await checkin(a.body.data.token, server);
    assert.equal(res.body.data.status, 'active');
    assert.equal(res.body.data.activation_id, a.body.data.activation_id);
    assert.equal(res.body.data.revocations_head_ts, 7);
  } finally {
    h.ctx.hooks.activationExtras.length = 0;
  }
});

test('check-ins are rate limited per activation, only for valid tokens, with a signed 429', async () => {
  const limited = await bootHub({ config: { license: { rate_limits: { checkin: { max: 2, windowMs: 3600_000 } } } } });
  try {
    const { key } = limited.issue();
    const server = limited.fp('rl');
    const a = await limited.activate(key, server);
    const c = (t) => limited.panel('/v1/checkin', { token: t, ...server, panel_version: '1.0.0' });
    // a stranger who knows the activation id cannot spend the bucket with forged tokens
    const forged = tamperSignature(a.body.data.token);
    for (let i = 0; i < 5; i++) assert.equal((await c(forged)).status, 401);
    assert.equal((await c(a.body.data.token)).status, 200);
    assert.equal((await c(a.body.data.token)).status, 200);
    const third = await c(a.body.data.token);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'rate_limited');
    assert.equal(third.body.meta.nonce, third.whmNonce, 'the 429 is signed and echoes the nonce');
    assert.ok(Number(third.headers['retry-after']) > 0);
    const other = limited.issue();
    const b = await limited.activate(other.key, limited.fp('rl2'));
    assert.equal((await limited.panel('/v1/checkin', { token: b.body.data.token, ...limited.fp('rl2'), panel_version: '1.0.0' })).status, 200, 'another activation is unaffected');
    limited.advance(3600_000 + 1000);
    assert.equal((await c(a.body.data.token)).status, 200, 'the window slides');
  } finally {
    await limited.close();
  }
});

test('license.checkin_failed fires once per miss episode and re-arms after a successful check-in', async () => {
  const hub = await bootHub();
  try {
    const ep = await hub.admin('post', '/v1/admin/webhooks').send({ url: 'https://alerts.example.test/in', events: ['license.checkin_failed'] });
    assert.equal(ep.status, 201);
    const deliveries = () => hub.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE event = 'license.checkin_failed'").get().n;
    const { license, key } = hub.issue('whm-pro-annual');
    const server = hub.fp('miss');
    const a = await hub.activate(key, server);
    const aid = a.body.data.activation_id;
    const interval = hub.ctx.config.license.checkin_interval_hours * HOUR;
    hub.advance(2 * interval);
    assert.equal((await hub.ctx.scheduler.run('expire-licenses')).result.flagged, 0, 'two misses are not yet an alert');
    hub.advance(interval + 1000);
    assert.equal((await hub.ctx.scheduler.run('expire-licenses')).result.flagged, 1);
    assert.equal(deliveries(), 1);
    assert.ok(hub.ctx.activations.get(aid).checkin_failed_at);
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'activation.checkin_failed'").get().n, 1);
    for (let i = 0; i < 5; i++) { hub.advance(HOUR); await hub.ctx.scheduler.run('expire-licenses'); }
    assert.equal(deliveries(), 1, 'hourly runs do not repeat the alert');
    const back = await checkinOn(hub, a.body.data.token, server);
    assert.equal(back.status, 200);
    assert.equal(hub.ctx.activations.get(aid).checkin_failed_at, null, 'a check-in re-arms the alert');
    hub.advance(3 * interval + 1000);
    assert.equal((await hub.ctx.scheduler.run('expire-licenses')).result.flagged, 1);
    assert.equal(deliveries(), 2);
    const payload = JSON.parse(hub.db.prepare("SELECT payload_json FROM webhook_deliveries WHERE event = 'license.checkin_failed' ORDER BY id DESC").get().payload_json);
    assert.equal(payload.data.activation_id, aid);
    assert.equal(payload.data.license_id, license.id);
    hub.ctx.activations.deactivate(aid, { reason: 'done' });
    hub.advance(3 * interval + 1000);
    assert.equal((await hub.ctx.scheduler.run('expire-licenses')).result.flagged, 0, 'inactive activations are never flagged');
  } finally {
    await hub.close();
  }
});

const checkinOn = (hub, token, server, extra = {}) => hub.panel('/v1/checkin', { token, ...server, panel_version: '1.0.1', ...extra });
