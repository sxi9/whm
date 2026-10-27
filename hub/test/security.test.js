import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { authenticator } from 'otplib';
import { bootHub } from './support.js';
import { redact } from '../shared/audit.js';
import { canonicalize } from '../shared/canonical.js';
import { parseSignatureHeader } from '../shared/keys.js';

let h;
before(async () => { h = await bootHub(); });
after(() => h.close());

// otplib verifies with window 0 against the real clock: a code minted just
// before a 30 s step boundary is rejected once bcrypt (cost 12) has pushed the
// check into the next step, so every TOTP sequence starts with time to spare.
function freshTotpStep() {
  const left = 30_000 - (Date.now() % 30_000);
  return left < 15_000 ? new Promise((resolve) => setTimeout(resolve, left + 50)) : Promise.resolve();
}

test('zod rejects malformed fingerprints, keys, hostnames, usage and unknown fields on the panel API', async () => {
  const good = h.fp('z');
  const cases = [
    [{ key: 'WHM-ABCD', ...good }, 'key'],
    [{ key: 'WHM-ABCD-ABCD-ABCD-AB;D', ...good }, 'key'],
    [{ key: 'WHM-ABCD-ABCD-ABCD-ABCD', fingerprint: 'md5:abc', fp_components: good.fp_components }, 'fingerprint'],
    [{ key: 'WHM-ABCD-ABCD-ABCD-ABCD', fingerprint: good.fingerprint, fp_components: { ...good.fp_components, mac: 'not-hex' } }, 'fp_components.mac'],
    [{ key: 'WHM-ABCD-ABCD-ABCD-ABCD', fingerprint: good.fingerprint, fp_components: { ...good.fp_components, raw_mac: 'aa:bb' } }, 'fp_components'],
    [{ key: 'WHM-ABCD-ABCD-ABCD-ABCD', ...good, hostname: 'bad host;rm -rf' }, 'hostname'],
    [{ key: 'WHM-ABCD-ABCD-ABCD-ABCD', ...good, extra: 1 }, '_'],
  ];
  for (const [body, field] of cases) {
    const res = await h.panel('/v1/activate', { ...body, hostname: body.hostname ?? 'srv.example.test', panel_version: '1.0.0' });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'validation_failed');
    assert.ok(res.body.error.fields[field], `${field} in ${JSON.stringify(res.body.error.fields)}`);
    assert.equal(res.body.meta.nonce, res.whmNonce, 'validation errors are signed and echo the nonce');
  }
  const bad = await h.panel('/v1/checkin', { token: 'nope', ...good, panel_version: '1.0.0' });
  assert.equal(bad.status, 422);
  const usage = await h.panel('/v1/checkin', { token: `WHMT1.${'a'.repeat(40)}.${'b'.repeat(86)}`, ...good, panel_version: '1.0.0', usage: { accounts: -1 } });
  assert.equal(usage.status, 422);
  const plugins = await h.panel('/v1/checkin', { token: `WHMT1.${'a'.repeat(40)}.${'b'.repeat(86)}`, ...good, panel_version: '1.0.0', usage: { plugins: [{ id: 'x', version: '1', name: 'leak' }] } });
  assert.equal(plugins.status, 422, 'plugin usage carries ids and versions only');
  const noJson = await h.http.post('/v1/activate').set('Content-Type', 'application/json').send('{bad');
  assert.equal(noJson.status, 400);
  assert.equal(noJson.body.error.code, 'bad_json');
  assert.equal(noJson.headers['x-whm-signature'], undefined, 'without a nonce there is nothing to bind the answer to');
  // a panel request (nonce present) with a body that does not parse is answered signed, like every other error (§16.6)
  const n = h.nonce();
  const signedBad = await h.http.post('/v1/activate').set('Content-Type', 'application/json').set('X-WHM-Nonce', n).set('X-WHM-Timestamp', String(h.ts())).send('{bad');
  assert.equal(signedBad.status, 400);
  assert.equal(signedBad.body.error.code, 'bad_json');
  assert.equal(signedBad.body.meta.nonce, n);
  const sig = parseSignatureHeader(signedBad.headers['x-whm-signature']);
  assert.ok(sig && h.ctx.keys.verify(canonicalize(signedBad.body), sig.sig, { kid: sig.kid, purpose: 'license', encoding: 'base64url' }), 'bad_json is signed');
  const loginBad = await h.http.post('/v1/portal/login').set('Content-Type', 'application/json').send('{bad');
  assert.equal(loginBad.body.error.code, 'bad_json', 'unsigned routes keep their plain 400');
  // oversized or malformed nonces are refused before anything is stored
  const before = h.ctx.nonce.size();
  const huge = await h.panel('/v1/activate', { key: 'WHM-ABCD-ABCD-ABCD-ABCD', ...good, hostname: 'srv.example.test', panel_version: '1.0.0' }, { nonceOverride: 'n'.repeat(4096) });
  assert.equal(huge.status, 400);
  assert.equal(huge.body.error.code, 'invalid_nonce');
  const odd = await h.panel('/v1/activate', { key: 'WHM-ABCD-ABCD-ABCD-ABCD', ...good, hostname: 'srv.example.test', panel_version: '1.0.0' }, { nonceOverride: 'n_with spaces and $$$$$' });
  assert.equal(odd.body.error.code, 'invalid_nonce');
  assert.equal(h.ctx.nonce.size(), before, 'nothing inserted into the nonces table');
  const { loadConfig } = await import('../src/config.js');
  assert.throws(() => loadConfig({ file: '/nonexistent/hub.conf', env: {}, overrides: { license: { nonce_ttl_s: 60, max_skew_s: 300 } } }), /nonce_ttl_s/);
  assert.equal(loadConfig({ file: '/nonexistent/hub.conf', env: {}, overrides: { license: { nonce_ttl_s: 600, max_skew_s: 300 } } }).license.nonce_ttl_s, 600);
});

test('rate limits answer 429 with the envelope: activate per IP+prefix, trial per IP, recover, admin', async () => {
  const limited = await bootHub({ config: { license: { rate_limits: { activate: { max: 2, windowMs: 3600_000 }, trial: { max: 1, windowMs: 3600_000 }, recover: { max: 1, windowMs: 3600_000 }, admin: { max: 3, windowMs: 3600_000 } } } } });
  try {
    const { key } = limited.issue();
    const s = limited.fp('rl');
    assert.equal((await limited.activate(key, s)).status, 200);
    assert.equal((await limited.activate(key, s)).status, 200);
    const third = await limited.activate(key, s);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'rate_limited');
    assert.equal(third.body.meta.nonce, third.whmNonce, '429s are signed and echo the nonce (§16.6)');
    const other = limited.issue();
    assert.equal((await limited.activate(other.key, limited.fp('rl2'))).status, 200, 'another key prefix has its own bucket');
    assert.equal((await limited.panel('/v1/trial', { email: 't1@x.test', ...limited.fp('t1'), hostname: 'a.example', panel_version: '1' })).status, 201);
    const trial429 = await limited.panel('/v1/trial', { email: 't2@x.test', ...limited.fp('t2'), hostname: 'a.example', panel_version: '1' });
    assert.equal(trial429.status, 429);
    assert.equal(trial429.body.meta.nonce, trial429.whmNonce);
    assert.equal((await limited.http.post('/v1/recover').send({ email: 'a@b.test' })).status, 202);
    assert.equal((await limited.http.post('/v1/recover').send({ email: 'a@b.test' })).status, 429);
    for (let i = 0; i < 3; i++) assert.equal((await limited.admin('get', '/v1/admin/products')).status, 200);
    assert.equal((await limited.admin('get', '/v1/admin/products')).status, 429);
  } finally {
    await limited.close();
  }
});

test('20 failed key lookups per hour block the address for 24 h (429 + Retry-After), audited and liftable', async () => {
  const blocky = await bootHub({ config: { license: { lookup_block: { failures: 3, windowMs: 3600_000, blockMs: 86_400_000 } } } });
  try {
    const bad = 'WHM-AAAA-AAAA-AAAA-AAAA';
    for (let i = 0; i < 3; i++) assert.equal((await blocky.activate(bad, blocky.fp(`b${i}`))).status, 404);
    const blocked = await blocky.activate(bad, blocky.fp('b4'));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'blocked');
    assert.ok(Number(blocked.headers['retry-after']) > 80_000);
    const { key } = blocky.issue();
    assert.equal((await blocky.activate(key, blocky.fp('b5'))).status, 429, 'even a good key is blocked from that IP');
    assert.equal((await blocky.panel('/v1/trial', { email: 'b@x.test', ...blocky.fp('b6'), hostname: 'a.example', panel_version: '1' })).status, 429);
    assert.equal(blocky.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ip.block'").get().n, 1);
    const lift = await blocky.admin('post', '/v1/admin/ip-blocks/127.0.0.1/unblock');
    assert.equal(lift.status, 200);
    const ip = blocky.db.prepare('SELECT ip FROM lookup_failures LIMIT 1').get().ip;
    blocky.ctx.licenses.lookupGuard.unblock(ip);
    assert.equal((await blocky.activate(key, blocky.fp('b7'))).status, 200);
    blocky.advance(86_400_000 + 1);
    assert.equal(blocky.ctx.licenses.lookupGuard.prune() >= 3, true);
  } finally {
    await blocky.close();
  }
});

test('data minimisation: no raw machine-id/MAC/key/token in any stored row or audit line', async () => {
  const rawMachineId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
  const rawMac = '00:1a:2b:3c:4d:5e';
  const { key } = h.issue();
  const server = h.fp('dm');
  const a = await h.activate(key, server);
  await h.panel('/v1/checkin', { token: a.body.data.token, ...server, panel_version: '1.0.0', usage: { accounts: 1 } });
  await h.admin('post', '/v1/admin/licenses').send({ sku: 'whm-trial', customer: { email: 'dm@example.test' }, notes: `machine ${rawMachineId}` });
  const dump = [];
  for (const t of ['licenses', 'activations', 'checkins', 'audit_log', 'webhook_deliveries', 'messages', 'customers']) dump.push(JSON.stringify(h.db.prepare(`SELECT * FROM ${t}`).all()));
  const text = dump.join('\n');
  assert.ok(!text.includes(key), 'clear-text key');
  assert.ok(!text.includes(a.body.data.token), 'token');
  assert.ok(!text.includes(rawMac));
  assert.ok(!JSON.stringify(h.db.prepare('SELECT args_redacted FROM audit_log').all()).includes(server.fp_components.machine_id), 'component hashes are redacted from audit args');
  const redacted = redact({ key: 'WHM-1', token: 'WHMT1.x', fingerprint: 'sha256:x', fp_components: { machine_id: 'x' }, machine_id: 'raw', mac: 'raw', hostname: 'h', nested: { password: 'p' } });
  assert.deepEqual(redacted, { key: '[redacted]', token: '[redacted]', fingerprint: '[redacted]', fp_components: '[redacted]', machine_id: '[redacted]', mac: '[redacted]', hostname: 'h', nested: { password: '[redacted]' } });
});

test('portal: login with password + TOTP, step-up gate, CSRF, lockout, 2FA enrol/disable, password change kills sessions', async () => {
  await freshTotpStep();
  const admin = await h.ctx.portalUsers.create({ email: 'admin@vendor.test', password: 'Vendor-Pass-123', role: 'vendor_admin' });
  const support = await h.ctx.portalUsers.create({ email: 'support@vendor.test', password: 'Support-Pass-123', role: 'vendor_support' });
  const agent = request.agent(h.ctx.app);
  assert.equal((await agent.get('/v1/portal/me')).status, 401);
  const bad = await agent.post('/v1/portal/login').send({ email: 'admin@vendor.test', password: 'wrong' });
  assert.equal(bad.status, 401);
  const login = await agent.post('/v1/portal/login').send({ email: 'admin@vendor.test', password: 'Vendor-Pass-123' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const csrf = login.body.data.csrfToken;
  assert.equal(login.body.data.user.role, 'vendor_admin');
  assert.equal((await agent.get('/v1/admin/licenses')).status, 200, 'the session reaches the admin API');
  const noCsrf = await agent.post('/v1/admin/customers').send({ name: 'x', email: 'csrf@x.test' });
  assert.equal(noCsrf.body.error.code, 'csrf_failed');
  const withCsrf = await agent.post('/v1/admin/customers').set('X-CSRF-Token', csrf).send({ name: 'x', email: 'csrf@x.test' });
  assert.equal(withCsrf.status, 201);
  const noTotp = await agent.post('/v1/admin/signing-keys').set('X-CSRF-Token', csrf).send({ purpose: 'plugin' });
  assert.equal(noTotp.status, 403);
  assert.equal(noTotp.body.error.code, 'totp_required');
  const enroll = await agent.post('/v1/portal/2fa/enroll').set('X-CSRF-Token', csrf).send({});
  assert.equal(enroll.status, 200);
  assert.match(enroll.body.data.uri, /^otpauth:\/\/totp\//);
  const secret = enroll.body.data.secret;
  assert.equal((await agent.post('/v1/portal/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: '000000' })).body.error.code, 'totp_invalid');
  const confirm = await agent.post('/v1/portal/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(secret) });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.data.totp_enabled, true);
  assert.ok(!h.db.prepare('SELECT totp_secret_enc FROM portal_users WHERE id = ?').get(admin.id).totp_secret_enc.includes(secret), 'TOTP secret is encrypted at rest');
  const fresh = await agent.post('/v1/admin/signing-keys').set('X-CSRF-Token', csrf).send({ purpose: 'plugin' });
  assert.equal(fresh.status, 201, 'enrolment counts as a fresh step-up');
  h.advance(6 * 60_000);
  const stale = await agent.post('/v1/admin/signing-keys').set('X-CSRF-Token', csrf).send({ purpose: 'plugin' });
  assert.equal(stale.status, 403);
  assert.equal(stale.body.error.code, 'totp_stepup_required');
  const stepup = await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: authenticator.generate(secret) });
  assert.equal(stepup.status, 200);
  assert.equal((await agent.post('/v1/admin/signing-keys').set('X-CSRF-Token', csrf).send({ purpose: 'plugin' })).status, 201);
  const apiKey = await agent.post('/v1/admin/api-keys').set('X-CSRF-Token', csrf).send({ name: 'ci', scopes: ['admin:read'] });
  assert.equal(apiKey.status, 201);
  assert.match(apiKey.body.data.key, /^whk_/);
  assert.equal((await h.asKey(apiKey.body.data.key)('get', '/v1/admin/licenses')).status, 200);
  assert.equal((await h.asKey(apiKey.body.data.key)('post', '/v1/admin/customers').send({ name: 'x', email: 'ro@x.test' })).status, 403);
  await agent.delete(`/v1/admin/api-keys/${apiKey.body.data.id}`).set('X-CSRF-Token', csrf);
  assert.equal((await h.asKey(apiKey.body.data.key)('get', '/v1/admin/licenses')).status, 401, 'revoked key');

  // login now requires the TOTP code
  const agent2 = request.agent(h.ctx.app);
  const needs = await agent2.post('/v1/portal/login').send({ email: 'admin@vendor.test', password: 'Vendor-Pass-123' });
  assert.equal(needs.body.error.code, 'totp_required');
  assert.equal((await agent2.post('/v1/portal/login').send({ email: 'admin@vendor.test', password: 'Vendor-Pass-123', totp: '123456' })).status, 401);
  assert.equal((await agent2.post('/v1/portal/login').send({ email: 'admin@vendor.test', password: 'Vendor-Pass-123', totp: authenticator.generate(secret) })).status, 200);

  // portal user management needs a fresh step-up and keeps the role ↔ tenant invariant
  h.advance(6 * 60_000);
  const staleUser = await agent.post('/v1/portal/users').set('X-CSRF-Token', csrf).send({ email: 'new@vendor.test', password: 'New-Pass-12345', role: 'vendor_admin' });
  assert.equal(staleUser.status, 403);
  assert.equal(staleUser.body.error.code, 'totp_stepup_required');
  assert.equal((await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: authenticator.generate(secret) })).status, 200);
  const created = await agent.post('/v1/portal/users').set('X-CSRF-Token', csrf).send({ email: 'new@vendor.test', password: 'New-Pass-12345', role: 'vendor_admin' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const crossTenant = await agent.patch(`/v1/portal/users/${created.body.data.id}`).set('X-CSRF-Token', csrf).send({ role: 'reseller_admin' });
  assert.equal(crossTenant.status, 422, 'a vendor user cannot become a reseller role');
  assert.equal((await agent.patch(`/v1/portal/users/${created.body.data.id}`).set('X-CSRF-Token', csrf).send({ role: 'vendor_support' })).body.data.role, 'vendor_support');
  const rs = h.ctx.resellers.create({ name: 'Tenant', email: 'tenant@reseller.test' });
  const rsUser = await h.ctx.portalUsers.create({ email: 'rs@reseller.test', password: 'Reseller-Pass-12', role: 'reseller_staff', reseller_id: rs.id });
  assert.equal((await agent.patch(`/v1/portal/users/${rsUser.id}`).set('X-CSRF-Token', csrf).send({ role: 'vendor_admin' })).status, 422, 'a reseller user cannot become a vendor role');
  assert.equal((await agent.post(`/v1/portal/users/${created.body.data.id}/reset-password`).set('X-CSRF-Token', csrf).send({ password: 'Reset-Pass-12345' })).status, 200);
  h.advance(6 * 60_000);
  assert.equal((await agent.post(`/v1/portal/users/${created.body.data.id}/reset-password`).set('X-CSRF-Token', csrf).send({ password: 'Reset-Pass-67890' })).body.error.code, 'totp_stepup_required');
  assert.equal((await agent.get('/v1/portal/users')).status, 200, 'listing needs no step-up');

  // support role: read-only
  const agent3 = request.agent(h.ctx.app);
  const sl = await agent3.post('/v1/portal/login').send({ email: 'support@vendor.test', password: 'Support-Pass-123' });
  assert.equal(sl.status, 200);
  assert.equal((await agent3.get('/v1/admin/licenses')).status, 200);
  assert.equal((await agent3.post('/v1/admin/customers').set('X-CSRF-Token', sl.body.data.csrfToken).send({ name: 'x', email: 'sup@x.test' })).body.error.code, 'insufficient_scope');
  assert.equal((await agent3.get('/v1/portal/users')).body.error.code, 'insufficient_role');
  void support;

  // password change destroys every session of the user
  const pw = await agent.post('/v1/portal/password').set('X-CSRF-Token', csrf).send({ current: 'Vendor-Pass-123', next: 'Vendor-Pass-456' });
  assert.equal(pw.status, 200);
  assert.equal((await agent2.get('/v1/portal/me')).status, 401);

  // lockout after 10 failures
  const lockHub = await bootHub({ config: { license: { rate_limits: { portal_login: { max: 100, windowMs: 60_000 } } } } });
  try {
    await lockHub.ctx.portalUsers.create({ email: 'lock@vendor.test', password: 'Lock-Pass-1234', role: 'vendor_admin' });
    for (let i = 0; i < 10; i++) assert.equal((await lockHub.http.post('/v1/portal/login').send({ email: 'lock@vendor.test', password: 'nope' })).status, 401);
    const locked = await lockHub.http.post('/v1/portal/login').send({ email: 'lock@vendor.test', password: 'Lock-Pass-1234' });
    assert.equal(locked.status, 423);
    assert.equal(locked.body.error.code, 'locked');
    lockHub.advance(16 * 60_000);
    assert.equal((await lockHub.http.post('/v1/portal/login').send({ email: 'lock@vendor.test', password: 'Lock-Pass-1234' })).status, 200);
  } finally {
    await lockHub.close();
  }
});

test('admin exports and reports are scope-gated and audited; the loopback app serves metrics', async () => {
  const csv = await h.admin('get', '/v1/admin/export.csv?table=licenses');
  assert.equal(csv.status, 200);
  assert.match(csv.text.split('\r\n')[0], /^id,key_prefix,edition/);
  assert.ok(!csv.text.includes('key_hash'));
  assert.equal((await h.admin('get', '/v1/admin/export.csv?table=audit_log')).status, 422);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export.csv'").get().n, 1);
  const ro = h.createApiKey({ scopes: ['admin:read'] });
  assert.equal((await h.asKey(ro)('get', '/v1/admin/reports/dashboard')).body.error.code, 'insufficient_scope');
  const dash = await h.admin('get', '/v1/admin/reports/dashboard');
  assert.equal(dash.status, 200);
  assert.ok('activations_by_edition' in dash.body.data && 'trial_funnel' in dash.body.data);
  for (const r of ['activations', 'renewals', 'churn', 'resellers', 'versions']) assert.equal((await h.admin('get', `/v1/admin/reports/${r}`)).status, 200, r);
  // spreadsheet formula prefixes are neutralised in every CSV cell
  h.ctx.customers.create({ name: '=HYPERLINK("https://evil.test","x")', email: 'formula@example.test', company: '+1+1', external_ref: '@cmd' });
  const custCsv = (await h.admin('get', '/v1/admin/export.csv?table=customers')).text;
  assert.ok(custCsv.includes(`"'=HYPERLINK(""https://evil.test"",""x"")"`), custCsv);
  assert.ok(custCsv.includes(",'+1+1,") && custCsv.includes(",'@cmd,"), custCsv);
  assert.ok(!/(^|,)=HYPERLINK/m.test(custCsv));
  assert.deepEqual(h.ctx.reports.csv([{ a: '-1', b: 'plain', c: '\tx' }]).split('\r\n')[1], "'-1,plain,'\tx");
  // full database copy: admin:* only, audited, a real SQLite file
  assert.equal((await h.asKey(ro)('get', '/v1/admin/export.db')).body.error.code, 'insufficient_scope');
  assert.equal((await h.asKey(h.createApiKey({ scopes: ['admin:write', 'admin:read'] }))('get', '/v1/admin/export.db')).status, 403, 'admin:write is not admin:*');
  const dbExport = await h.admin('get', '/v1/admin/export.db').buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
  assert.equal(dbExport.status, 200);
  assert.match(dbExport.headers['content-disposition'], /attachment; filename="license-.*\.db"/);
  assert.equal(dbExport.body.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export.db'").get().n, 1);
  const metrics = await request(h.ctx.loopback).get('/metrics');
  assert.equal(metrics.status, 200);
  assert.match(metrics.text, /^replica_lag_seconds 0$/m);
  assert.match(metrics.text, /checkins_total\{result="ok"\} \d+/);
  assert.match(metrics.text, /token_sign_latency_count \d+/);
  assert.match(metrics.text, /activations_active\{edition="pro"\} \d+/);
  assert.equal((await request(h.ctx.loopback).get('/healthz')).status, 200);
  assert.equal((await h.http.get('/v1/nope')).status, 404);
  assert.equal((await h.http.get('/v1/admin/products')).status, 401);
});

test('the scheduler runs every §16.11 job without error and runDue honours cron minutes', async () => {
  const names = h.ctx.scheduler.list().map((s) => s.name).sort();
  assert.deepEqual(names, ['checkin-prune', 'db-backup', 'expire-licenses', 'expiring-reminders', 'nonce-prune', 'stale-activations', 'trial-expiry', 'webhook-retry']);
  for (const name of names) {
    const out = await h.ctx.scheduler.run(name);
    assert.equal(out.ok, true, `${name}: ${out.error}`);
  }
  const at = new Date('2026-10-27T03:45:00Z');
  const due = await h.ctx.scheduler.runDue(at);
  assert.deepEqual(due.map((d) => d.name).sort(), ['checkin-prune']);
  assert.deepEqual(await h.ctx.scheduler.runDue(at), [], 'not twice in the same minute');
  h.advance(11 * 60_000);
  const run = await h.admin('post', '/v1/admin/schedules/nonce-prune/run');
  assert.equal(run.status, 200);
  assert.equal(run.body.data.ok, true);
  assert.equal(h.ctx.nonce.size(), 0, 'nonce-prune after the clock moved past the TTL');
});

test('the portal cookie is Secure by default; cookie_secure: false is the explicit plain-HTTP opt-out', async () => {
  const strict = await bootHub({ config: { cookie_secure: undefined } });
  try {
    await strict.ctx.portalUsers.create({ email: 'sec@vendor.test', password: 'Vendor-Pass-123', role: 'vendor_admin' });
    const agent = request.agent(strict.ctx.app);
    const login = await agent.post('/v1/portal/login').send({ email: 'sec@vendor.test', password: 'Vendor-Pass-123' });
    assert.equal(login.status, 200);
    assert.equal(login.headers['set-cookie'], undefined, 'a Secure cookie is never issued over plain HTTP');
    const proxied = await request.agent(strict.ctx.app).post('/v1/portal/login').set('X-Forwarded-Proto', 'https').send({ email: 'sec@vendor.test', password: 'Vendor-Pass-123' });
    assert.match(proxied.headers['set-cookie'][0], /; Secure/);
    assert.match(proxied.headers['set-cookie'][0], /HttpOnly/);
  } finally {
    await strict.close();
  }
  const login = await request.agent(h.ctx.app).post('/v1/portal/login').send({ email: 'admin@vendor.test', password: 'nope' });
  assert.equal(login.status, 401);
});

test('unknown portal e-mails take the bcrypt path too (no account enumeration by timing)', async () => {
  const time = async (email) => { const t0 = process.hrtime.bigint(); await h.http.post('/v1/portal/login').send({ email, password: 'wrong-password-1' }); return Number(process.hrtime.bigint() - t0) / 1e6; };
  await h.ctx.portalUsers.create({ email: 'known@vendor.test', password: 'Known-Pass-1234', role: 'vendor_support' });
  const known = []; const unknown = [];
  for (let i = 0; i < 3; i++) { known.push(await time('known@vendor.test')); unknown.push(await time('nobody@vendor.test')); }
  const med = (xs) => xs.sort((a, b) => a - b)[1];
  assert.ok(med(unknown) > med(known) * 0.5, `unknown ${med(unknown)}ms vs known ${med(known)}ms`);
});

test('2FA re-enrolment needs the current code and never weakens an enabled account (hijacked session with a lapsed step-up)', async () => {
  await freshTotpStep();
  const owner = await h.ctx.portalUsers.create({ email: 'owner@vendor.test', password: 'Owner-Pass-1234', role: 'vendor_admin' });
  const agent = request.agent(h.ctx.app);
  const login = await agent.post('/v1/portal/login').send({ email: 'owner@vendor.test', password: 'Owner-Pass-1234' });
  const csrf = login.body.data.csrfToken;
  const first = await agent.post('/v1/portal/2fa/enroll').set('X-CSRF-Token', csrf).send({});
  assert.equal(first.status, 200);
  assert.equal(first.body.data.reenrol, false);
  const secret = first.body.data.secret;
  const row = () => h.db.prepare('SELECT totp_enabled, totp_secret_enc, totp_pending_enc FROM portal_users WHERE id = ?').get(owner.id);
  assert.equal(row().totp_enabled, 0);
  assert.equal(row().totp_secret_enc, null, 'an unconfirmed secret is pending, not live');
  assert.equal((await agent.post('/v1/portal/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(secret) })).status, 200);
  assert.equal(row().totp_enabled, 1);
  assert.equal(row().totp_pending_enc, null);
  const liveSecretEnc = row().totp_secret_enc;

  h.advance(6 * 60_000);
  const mint = () => agent.post('/v1/portal/users').set('X-CSRF-Token', csrf).send({ email: 'minted@vendor.test', password: 'Minted-Pass-123', role: 'vendor_admin' });
  assert.equal((await mint()).body.error.code, 'totp_stepup_required');
  const noCode = await agent.post('/v1/portal/2fa/enroll').set('X-CSRF-Token', csrf).send({});
  assert.equal(noCode.status, 403);
  assert.equal(noCode.body.error.code, 'totp_required');
  const wrongCode = await agent.post('/v1/portal/2fa/enroll').set('X-CSRF-Token', csrf).send({ code: '000000' });
  assert.equal(wrongCode.status, 422);
  assert.equal(wrongCode.body.error.code, 'totp_invalid');
  assert.deepEqual(row(), { totp_enabled: 1, totp_secret_enc: liveSecretEnc, totp_pending_enc: null }, 'refused enrolments change nothing');
  assert.equal((await agent.post('/v1/portal/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(secret) })).body.error.code, 'totp_not_enrolled');
  assert.equal((await mint()).body.error.code, 'totp_stepup_required', 'the step-up gate still holds');

  // with the current code the owner may rotate; the live secret stays until the new one is confirmed
  const rotate = await agent.post('/v1/portal/2fa/enroll').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(secret) });
  assert.equal(rotate.status, 200);
  assert.equal(rotate.body.data.reenrol, true);
  assert.notEqual(rotate.body.data.secret, secret);
  assert.deepEqual({ enabled: row().totp_enabled, live: row().totp_secret_enc }, { enabled: 1, live: liveSecretEnc });
  assert.ok(row().totp_pending_enc);
  assert.equal((await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: authenticator.generate(secret) })).status, 200, 'the old secret still works while the new one is pending');
  assert.equal((await agent.post('/v1/portal/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(rotate.body.data.secret) })).status, 200);
  assert.equal(row().totp_pending_enc, null);
  assert.notEqual(row().totp_secret_enc, liveSecretEnc);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'portal.2fa_reenroll' AND target = ?").get(owner.id).n, 1);
  const agent2 = request.agent(h.ctx.app);
  assert.equal((await agent2.post('/v1/portal/login').send({ email: 'owner@vendor.test', password: 'Owner-Pass-1234', totp: authenticator.generate(secret) })).status, 401, 'the old secret is gone');
  assert.equal((await agent2.post('/v1/portal/login').send({ email: 'owner@vendor.test', password: 'Owner-Pass-1234', totp: authenticator.generate(rotate.body.data.secret) })).status, 200);
});
