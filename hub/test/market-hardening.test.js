import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootMarket, totpCode, buildPackage, manifestFor, SAMPLE_ID } from './market-support.js';
import { verifySignatureHeader } from '../shared/webhooks.js';
import { MARKET_SCHEDULES } from '../marketplace/jobs.js';

let h;
before(async () => { h = await bootMarket({ fetch: async () => ({ status: 503, text: () => '' }) }); });
after(() => h.close());

test('market:* api keys are minted through POST /v1/admin/api-keys and gate the admin routes per scope', async () => {
  const minter = h.asKey(h.createApiKey({ scopes: ['admin:write', 'market:*'] }));
  const review = await minter('post', '/v1/admin/api-keys').send({ name: 'reviewer', scopes: ['market:review', 'market:read'] });
  assert.equal(review.status, 201, JSON.stringify(review.body));
  assert.deepEqual(review.body.data.scopes, ['market:review', 'market:read']);
  const readOnly = await minter('post', '/v1/admin/api-keys').send({ name: 'ro', scopes: ['market:read'] });
  assert.equal(readOnly.status, 201);
  assert.equal((await minter('post', '/v1/admin/api-keys').send({ name: 'x', scopes: ['market:bogus'] })).status, 422);
  // a key never grants more than its creator holds
  const limited = h.asKey(h.createApiKey({ scopes: ['admin:write', 'market:read'] }));
  assert.equal((await limited('post', '/v1/admin/api-keys').send({ name: 'x', scopes: ['market:review'] })).body.error.code, 'insufficient_scope');

  const dev = await h.developer({ namespaces: ['test.scopes'] });
  assert.equal((await h.createListing(dev, 'test.scopes.p')).status, 201);
  const up = await dev.upload('test.scopes.p', buildPackage({ manifest: manifestFor('test.scopes.p'), signWith: dev.pem }));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const asReview = h.asKey(review.body.data.key);
  const asRead = h.asKey(readOnly.body.data.key);
  assert.equal((await asRead('get', '/v1/admin/market/reviews')).status, 200);
  assert.equal((await asRead('post', `/v1/admin/market/reviews/${up.body.data.review_id}/approve`).send({})).body.error.code, 'insufficient_scope');
  const approved = await asReview('post', `/v1/admin/market/reviews/${up.body.data.review_id}/approve`).send({});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  // jobs: market:review runs the queue jobs but not the billing or re-sign ones
  assert.equal((await asReview('post', '/v1/admin/market/jobs/scan-queue/run')).status, 200);
  assert.equal((await asReview('post', '/v1/admin/market/jobs/payouts-close/run')).body.error.code, 'insufficient_scope');
  assert.equal((await asReview('post', '/v1/admin/market/jobs/resign-packages/run')).body.error.code, 'insufficient_scope');
  assert.equal((await h.asKey(h.createApiKey({ scopes: ['market:billing'] }))('post', '/v1/admin/market/jobs/payouts-close/run')).status, 200);
  assert.equal((await h.admin('post', '/v1/admin/market/jobs/resign-packages/run')).status, 200);
  assert.equal((await h.asKey(h.createApiKey({ ownerType: 'reseller', ownerId: 'rsl_x', scopes: ['market:*'] }))('get', '/v1/admin/market/reviews')).status, 403, 'reseller keys never reach the vendor admin API');
});

test('every admin mutation needs a TOTP step-up for portal sessions', async () => {
  await h.ctx.portalUsers.create({ email: 'nototp@vendor.test', password: 'Vendor-Pass-123', role: 'vendor_admin' });
  const agent = request.agent(h.ctx.app);
  assert.equal((await agent.post('/v1/portal/login').send({ email: 'nototp@vendor.test', password: 'Vendor-Pass-123' })).status, 200);
  const csrf = (await agent.get('/v1/portal/csrf')).body.data.csrfToken;
  const post = (url, body = {}) => agent.post(url).set('X-CSRF-Token', csrf).send(body);
  assert.equal((await agent.get('/v1/admin/market/plugins')).status, 200, 'reads need no step-up');
  for (const [url, body] of [
    [`/v1/admin/market/plugins/${SAMPLE_ID}/versions/1.0.0/yank`, { reason: 'x' }],
    ['/v1/admin/market/categories', { slug: 'new-cat', name: 'New' }],
    ['/v1/admin/market/jobs/scan-queue/run', {}],
    ['/v1/admin/market/plugin-reviews/prv_000000/hide', {}],
    ['/v1/admin/market/developers/dev_000000/reverify', {}],
    ['/v1/admin/market/verifications/dev_000000/request-evidence', {}],
  ]) {
    const res = await post(url, body);
    assert.equal(res.status, 403, `${url}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, 'totp_required', url);
  }
  const patch = await agent.patch(`/v1/admin/market/plugins/${SAMPLE_ID}`).set('X-CSRF-Token', csrf).send({ bundled_editions: ['pro'] });
  assert.equal(patch.body.error.code, 'totp_required', 'bundled_editions is an entitlement grant');
  assert.equal((await agent.patch('/v1/admin/market/developers/dev_000000').set('X-CSRF-Token', csrf).send({ company: 'x' })).body.error.code, 'totp_required');
});

test('wrong TOTP codes are budgeted per account across step-up, disable, reset and login: the 6th within 15 min is refused', async () => {
  const dev = await h.developer({ key: null });
  const wrong = () => String((Number(totpCode(dev.secret)) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < 5; i++) {
    const res = await dev.post('/v1/dev/2fa/stepup', { totp: wrong() });
    assert.equal(res.body.error.code, 'invalid_totp', `attempt ${i + 1}: ${JSON.stringify(res.body)}`);
  }
  const sixth = await dev.post('/v1/dev/2fa/stepup', { totp: wrong() });
  assert.equal(sixth.status, 429, JSON.stringify(sixth.body));
  assert.equal(sixth.body.error.code, 'totp_rate_limited');
  assert.equal((await dev.post('/v1/dev/2fa/stepup', { totp: totpCode(dev.secret) })).status, 429, 'even the right code waits');
  assert.equal((await dev.post('/v1/dev/2fa/disable', { code: totpCode(dev.secret) })).status, 429, 'disable shares the budget');
  assert.equal(dev.row().failed_logins, 5, 'each wrong code counts as a failed login');
  // the password-reset route shares it too
  assert.equal((await h.http.post('/v1/dev/password/reset').send({ email: dev.email })).status, 202);
  const token = /reset\/([A-Za-z0-9_-]+)/.exec(h.sent.slice(-1)[0].message)[1];
  assert.equal((await h.http.post(`/v1/dev/password/reset/${token}`).send({ password: 'Fresh-Passw0rd-Again', totp: totpCode(dev.secret) })).status, 429);
  assert.equal((await request.agent(h.ctx.app).post('/v1/dev/login').send({ email: dev.email, password: dev.password, totp: totpCode(dev.secret) })).status, 429, 'login too');
  h.advance(16 * 60_000);
  const ok = await dev.post('/v1/dev/2fa/stepup', { totp: totpCode(dev.secret) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // a wrong code at login spends the same budget and the doubling lockout still applies at 10
  for (let i = 0; i < 4; i++) assert.equal((await request.agent(h.ctx.app).post('/v1/dev/login').send({ email: dev.email, password: dev.password, totp: wrong() })).body.error.code, 'invalid_totp');
  assert.equal((await dev.post('/v1/dev/2fa/stepup', { totp: wrong() })).body.error.code, 'invalid_totp');
  assert.equal((await dev.post('/v1/dev/2fa/stepup', { totp: wrong() })).status, 429);
});

test('single-use secrets never reach either audit_log: payout details, ID documents, reset tokens, key challenges, webhook secrets', async () => {
  const dev = await h.developer({ key: null, namespaces: ['test.audit'] });
  const iban = 'DE89370400440532013000';
  const res = await dev.patch('/v1/dev/profile', { payout: { iban, account_holder: 'Dev One', bank: 'Test Bank' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.has_payout, true);
  const leaks = (db) => db.prepare("SELECT action, args_redacted FROM audit_log WHERE args_redacted LIKE '%' || ? || '%' OR args_redacted LIKE '%Dev One%'").all(iban);
  assert.deepEqual(leaks(h.mdb), [], 'marketplace.db');
  assert.deepEqual(leaks(h.db), [], 'license.db');
  const profileRow = h.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'PATCH /v1/dev/profile' ORDER BY id DESC").get();
  assert.match(profileRow.args_redacted, /"payout":"\[redacted\]"/);
  assert.match(h.mdb.prepare("SELECT args_redacted FROM audit_log WHERE action = 'developer.profile.update' ORDER BY id DESC").get().args_redacted, /"payout":"\[redacted\]"/);
  // ID document bytes
  const doc = Buffer.from('this is a passport scan').toString('base64');
  const sub = await dev.post('/v1/dev/verification', { method: 'id_document', document: doc, content_type: 'image/png' });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%' || ? || '%'").get(doc.slice(0, 20)).n, 0);
  assert.match(h.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'POST /v1/dev/verification' ORDER BY id DESC").get().args_redacted, /"document":"\[redacted\]"/);
  assert.equal((await dev.post('/v1/dev/verification', { method: 'id_document', document: doc })).body.error.code, 'document_pending');
  // viewing the document is audited
  assert.equal((await h.admin('get', `/v1/admin/market/verifications/${sub.body.data.id}/document`)).body.data.data, doc);
  assert.ok(h.mdb.prepare("SELECT 1 FROM audit_log WHERE action = 'developer.verification.document_view' AND target = ?").get(sub.body.data.id));
  // key challenge
  const challenge = (await dev.post('/v1/dev/keys')).body.data.challenge;
  assert.equal((await dev.post(`/v1/dev/keys/${challenge}`, { public_key_pem: 'nope', sig: 'AAAA' })).body.error.code, 'invalid_public_key');
  assert.equal((await h.registerKey(dev, dev.pem)).status, 201);
  const keyRows = h.db.prepare("SELECT target FROM audit_log WHERE action LIKE '%/keys/:challenge'").all();
  assert.ok(keyRows.length >= 2);
  assert.ok(keyRows.every((r) => r.target === null || r.target.startsWith('sha256:')), JSON.stringify(keyRows));
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE target = ?").get(challenge).n, 0);
  // webhook secret
  const wh = await dev.post('/v1/dev/webhooks', { url: 'https://dev.example.test/h', events: ['version.published'], secret: 'very-secret-webhook-key-1' });
  assert.equal(wh.status, 201, JSON.stringify(wh.body));
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%very-secret-webhook-key-1%'").get().n, 0);
  // reset token: neither a failed nor a successful attempt leaves the token in the audit target
  assert.equal((await h.http.post('/v1/dev/password/reset').send({ email: dev.email })).status, 202);
  const token = /reset\/([A-Za-z0-9_-]+)/.exec(h.sent.slice(-1)[0].message)[1];
  assert.equal((await h.http.post(`/v1/dev/password/reset/${token}`).send({ password: 'Fresh-Passw0rd-Again' })).body.error.code, 'invalid_totp');
  assert.equal((await h.http.post(`/v1/dev/password/reset/${token}`).send({ password: 'Fresh-Passw0rd-Again', totp: totpCode(dev.secret) })).status, 200);
  const resetRows = h.db.prepare("SELECT target FROM audit_log WHERE action LIKE '%/password/reset/:token'").all();
  assert.ok(resetRows.length >= 2);
  assert.ok(resetRows.every((r) => r.target === null || r.target.startsWith('sha256:')), JSON.stringify(resetRows));
  assert.ok(resetRows.some((r) => r.target?.startsWith('sha256:')), 'the successful call records the hash');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE target = ? OR args_redacted LIKE '%' || ? || '%'").get(token, token).n, 0);
});

test('magic-link tokens are hashed in the request audit', async () => {
  const lic = await h.panelLicense();
  const issued = h.m.billing.issueMagicLink({ customer_id: lic.license.customer_id, plugin_id: null, license_id: lic.license.id }, { ip: '127.0.0.1' });
  const bad = await h.http.post(`/v1/market/magic-links/${issued._token}`).send({ email: 'someone-else@example.test' });
  assert.equal(bad.body.error.code, 'magic_link_email_mismatch');
  const ok = await h.http.post(`/v1/market/magic-links/${issued._token}`).send({ email: h.ctx.customers.get(lic.license.customer_id).email });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE target = ?").get(issued._token).n, 0);
  const rows = h.db.prepare("SELECT target FROM audit_log WHERE action LIKE '%/magic-links/:token'").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.target === null || r.target.startsWith('sha256:')), JSON.stringify(rows));
  assert.ok(rows.some((r) => r.target?.startsWith('sha256:')));
});

test('download descriptors require the activation fingerprint; the package route is rate limited', async () => {
  await h.submitSample();
  const lic = await h.panelLicense();
  const missing = await h.download({ plugin_id: SAMPLE_ID, token: lic.token });
  assert.equal(missing.status, 422, JSON.stringify(missing.body));
  assert.ok(missing.body.error.fields.fingerprint);
  assert.throws(() => h.m.distribution.descriptor({ plugin_id: SAMPLE_ID, token: lic.token }), (e) => e.status === 422);
  assert.equal((await h.download({ plugin_id: SAMPLE_ID, token: lic.token, fingerprint: lic.server.fingerprint })).status, 200);
  const limited = await bootMarket({ config: { license: { rate_limits: { public: { max: 1, windowMs: 3600_000 } } } } });
  try {
    assert.equal((await limited.http.get('/v1/market/packages/dl_000000000000000000?exp=1&sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status, 403);
    assert.equal((await limited.http.get('/v1/market/packages/dl_000000000000000000?exp=1&sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status, 429);
  } finally { await limited.close(); }
});

test('suspension hides unpublished versions instead of rejecting them; reinstating brings them back', async () => {
  const dev = await h.developer({ namespaces: ['test.susp'] });
  assert.equal((await h.createListing(dev, 'test.susp.p')).status, 201);
  const up = await dev.upload('test.susp.p', buildPackage({ manifest: manifestFor('test.susp.p'), signWith: dev.pem }));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const inQueue = async () => (await h.admin('get', '/v1/admin/market/reviews?pageSize=500')).body.data.some((r) => r.id === up.body.data.review_id);
  assert.equal(await inQueue(), true);
  assert.equal((await h.admin('post', `/v1/admin/market/developers/${dev.id}/suspend`).send({ reason: 'policy' })).status, 200);
  assert.equal(h.m.submissions.version('test.susp.p', '1.0.0').status, 'in_review', 'status untouched');
  assert.equal(await inQueue(), false, 'hidden from reviewers');
  const blocked = await dev.upload('test.susp.p', buildPackage({ manifest: manifestFor('test.susp.p', { version: '1.0.1' }), signWith: dev.pem }));
  assert.equal(blocked.body.error.code, 'developer_not_verified', 'publishing pipeline frozen');
  assert.equal((await h.admin('post', `/v1/admin/market/developers/${dev.id}/reinstate`).send({})).body.data.status, 'verified');
  assert.equal(await inQueue(), true);
  assert.equal((await h.approveReview(up.body.data.review_id)).status, 200);
  assert.equal((await h.publish(dev, 'test.susp.p', '1.0.0')).status, 200);
});

test('registration attempts are budgeted per IP before the e-mail lookup, so enumeration is bounded', async () => {
  const ip = '203.0.113.77';
  const reg = (email) => h.http.post('/v1/dev/register').set('X-Forwarded-For', ip).send({ email, password: 'Correct-Horse-Battery-9', display_name: 'Enum Test' });
  assert.equal((await reg('enum-1@example.test')).status, 202);
  assert.equal((await reg('enum-1@example.test')).status, 409, 'the second attempt still says taken');
  for (let i = 2; i < 5; i++) assert.equal((await reg(`enum-${i}@example.test`)).status, 202);
  const sixth = await reg('enum-1@example.test');
  assert.equal(sixth.status, 429, JSON.stringify(sixth.body));
  assert.equal((await reg('enum-new@example.test')).status, 429);
});

test('evidence submissions are limited to 10 per day per developer', async () => {
  const dev = await h.developer({ key: null, namespaces: ['test.evlimit'] });
  let last;
  for (let i = 0; i < 10; i++) {
    last = await dev.post('/v1/dev/verification', { method: 'dns_txt', ns: 'test.evlimit' });
    assert.equal(last.status, 201, `${i}: ${JSON.stringify(last.body)}`);
  }
  const over = await dev.post('/v1/dev/verification', { method: 'dns_txt', ns: 'test.evlimit' });
  assert.equal(over.status, 429);
  h.advance(25 * 3600_000);
  await dev.login();
  assert.equal((await dev.post('/v1/dev/verification', { method: 'dns_txt', ns: 'test.evlimit' })).status, 201);
});

test('developer webhooks: CRUD, deliveries and replay go through the service and are audited', async () => {
  const dev = await h.developer({ key: null });
  const created = await dev.post('/v1/dev/webhooks', { url: 'https://dev.example.test/hook', events: ['version.published', 'version.revoked'] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.data.secret.length >= 32);
  const id = created.body.data.id;
  assert.deepEqual((await dev.get('/v1/dev/webhooks')).body.data.map((w) => [w.id, w.events]), [[id, ['version.published', 'version.revoked']]]);
  const other = await h.developer({ key: null });
  assert.equal((await other.get(`/v1/dev/webhooks/${id}/deliveries`)).status, 404, 'rows are filtered by developer');
  assert.equal((await other.del(`/v1/dev/webhooks/${id}`)).status, 404);
  assert.equal(h.m.webhook(dev.id, 'version.published', { plugin_id: 'x' }), 1);
  const deliveries = await dev.get(`/v1/dev/webhooks/${id}/deliveries`);
  assert.equal(deliveries.body.meta.total, 1);
  const did = deliveries.body.data[0].id;
  h.mdb.prepare("UPDATE developer_webhook_deliveries SET status = 'failed' WHERE id = ?").run(did);
  assert.equal((await dev.post(`/v1/dev/webhooks/${id}/deliveries/${did}/replay`)).body.data.replayed, true);
  assert.equal(h.mdb.prepare('SELECT status FROM developer_webhook_deliveries WHERE id = ?').get(did).status, 'pending');
  assert.equal((await dev.post(`/v1/dev/webhooks/${id}/deliveries/999999/replay`)).status, 404);
  assert.equal((await dev.del(`/v1/dev/webhooks/${id}`)).body.data.deleted, true);
  assert.deepEqual((await dev.get('/v1/dev/webhooks')).body.data, []);
  const actions = h.mdb.prepare("SELECT action FROM audit_log WHERE principal = ? AND action LIKE 'developer.webhook.%' ORDER BY id").all(`developer:${dev.id}`).map((r) => r.action);
  assert.deepEqual(actions, ['developer.webhook.create', 'developer.webhook.replay', 'developer.webhook.delete']);
});

test('every marketplace schedule runs without error', async () => {
  const names = h.ctx.scheduler.list().map((s) => s.name);
  for (const { name } of MARKET_SCHEDULES) {
    assert.ok(names.includes(name), `${name} registered`);
    const out = await h.ctx.scheduler.run(name);
    assert.equal(out.ok, true, `${name}: ${out.error}`);
  }
});

test('the license hub admin rate limiter already covers /v1/admin/market (no second counter)', async () => {
  const limited = await bootMarket({ config: { license: { rate_limits: { admin: { max: 2, windowMs: 3600_000 } } } } });
  try {
    assert.equal((await limited.admin('get', '/v1/admin/market/plugins')).status, 200);
    assert.equal((await limited.admin('get', '/v1/admin/market/plugins')).status, 200, 'the limit is not consumed twice per request');
    const third = await limited.admin('get', '/v1/admin/market/plugins');
    assert.equal(third.status, 429, JSON.stringify(third.body));
    assert.equal((await limited.asKey(limited.createApiKey({ ownerType: 'reseller', ownerId: 'rsl_x', scopes: ['market:*'] }))('get', '/v1/admin/market/plugins')).status, 403);
  } finally { await limited.close(); }
});

test('magic links are limited to 5 per customer per hour', async () => {
  const lic = await h.panelLicense();
  const issue = () => h.panel('/v1/market/magic-links', { token: lic.token }, { skipVerify: true });
  for (let i = 0; i < 5; i++) assert.equal((await issue()).status, 202, `issue ${i + 1}`);
  const sixth = await issue();
  assert.equal(sixth.status, 429, JSON.stringify(sixth.body));
  assert.equal(sixth.body.error.code, 'rate_limited');
  assert.throws(() => h.m.billing.issueMagicLink({ customer_id: lic.license.customer_id }), (e) => e.status === 429);
  h.advance(61 * 60_000);
  await lic.checkin();
  assert.equal((await issue()).status, 202);
});

test('developer-uploaded SVG assets are served sandboxed', async () => {
  const dev = await h.developer({ namespaces: ['test.svg'] });
  assert.equal((await h.createListing(dev, 'test.svg.p')).status, 201);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  const added = await dev.post('/v1/dev/plugins/test.svg.p/assets', { kind: 'icon', content_type: 'image/svg+xml', data: svg });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const url = new URL(added.body.data.url);
  const res = await h.http.get(url.pathname);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/svg\+xml/);
  assert.equal(res.headers['content-security-policy'], "sandbox; default-src 'none'");
  assert.match(res.headers['content-disposition'], /^inline; filename="ast_[^"]+\.svg"$/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('developer webhooks are delivered by the shared webhook-retry schedule with the HMAC header', async () => {
  const calls = [];
  const hub = await bootMarket({ webhookFetch: async (url, init) => { calls.push({ url, init }); return { status: 200, text: () => '' }; } });
  try {
    const dev = await hub.sampleDeveloper();
    const wh = await dev.post('/v1/dev/webhooks', { url: 'https://dev.example.test/hook', events: ['version.published'], secret: 'very-secret-webhook-key-1' });
    assert.equal(wh.status, 201, JSON.stringify(wh.body));
    await hub.submitSample({ d: dev });
    const row = hub.mdb.prepare('SELECT * FROM developer_webhook_deliveries WHERE webhook_id = ?').get(wh.body.data.id);
    assert.ok(row, 'publish queued a delivery');
    assert.equal(row.status, 'pending');
    const out = await hub.ctx.scheduler.run('webhook-retry');
    assert.equal(out.ok, true, out.error);
    assert.equal(out.result.developer.length, 1, JSON.stringify(out.result));
    const delivered = hub.mdb.prepare('SELECT * FROM developer_webhook_deliveries WHERE id = ?').get(row.id);
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.last_code, 200);
    assert.ok(delivered.delivered_at);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://dev.example.test/hook');
    assert.equal(calls[0].init.headers['x-whm-webhook-event'], 'version.published');
    assert.ok(verifySignatureHeader('very-secret-webhook-key-1', calls[0].init.body, calls[0].init.headers['x-whm-webhook-signature'], { now: Math.floor(hub.clock.t / 1000) }), 'HMAC verifies with the developer secret');
    const payload = JSON.parse(calls[0].init.body);
    assert.equal(payload.event, 'version.published');
    assert.equal(payload.data.plugin_id, SAMPLE_ID);
  } finally { await hub.close(); }
});

test('POST /v1/reseller/market/entitlements grants within the wholesale price for the reseller\'s own licenses only', async () => {
  const r1 = (await h.admin('post', '/v1/admin/resellers').send({ name: 'Market Reseller', email: 'market@reseller.test', quota: { pro: 5 } })).body.data;
  const r2 = (await h.admin('post', '/v1/admin/resellers').send({ name: 'Other Reseller', email: 'other@reseller.test', quota: { pro: 5 } })).body.data;
  const k1 = h.asKey(h.createApiKey({ ownerType: 'reseller', ownerId: r1.id, scopes: ['license:read', 'license:issue'] }));
  const kRead = h.asKey(h.createApiKey({ ownerType: 'reseller', ownerId: r1.id, scopes: ['license:read'] }));
  const own = h.issue('whm-pro-annual', { reseller_id: r1.id }).license;
  const foreign = h.issue('whm-pro-annual', { reseller_id: r2.id }).license;
  const body = { license_id: own.id, plugin_id: SAMPLE_ID };
  assert.equal((await kRead('post', '/v1/reseller/market/entitlements').send(body)).body.error.code, 'insufficient_scope');
  assert.equal((await h.admin('post', '/v1/reseller/market/entitlements').send(body)).body.error.code, 'wrong_owner_type', 'vendor keys are refused');
  const noPrice = await k1('post', '/v1/reseller/market/entitlements').send(body);
  assert.equal(noPrice.status, 403, JSON.stringify(noPrice.body));
  assert.equal(noPrice.body.error.code, 'no_wholesale_price');
  // the wholesale price lives in resellers.pricing_json.plugins (§18.5)
  h.db.prepare('UPDATE resellers SET pricing_json = ? WHERE id = ?').run(JSON.stringify({ plugins: { [SAMPLE_ID]: 1500 } }), r1.id);
  assert.equal((await k1('post', '/v1/reseller/market/entitlements').send({ ...body, license_id: foreign.id })).body.error.code, 'not_owned');
  const granted = await k1('post', '/v1/reseller/market/entitlements').send(body);
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  assert.equal(granted.body.data.source, 'reseller');
  assert.equal(granted.body.data.license_id, own.id);
  assert.equal(granted.body.data.status, 'active');
  assert.ok(h.mdb.prepare("SELECT 1 FROM audit_log WHERE action = 'entitlement.reseller_grant' AND target = ? AND role = 'reseller'").get(granted.body.data.id));
  assert.equal((await k1('post', '/v1/reseller/market/entitlements').send({ license_id: 'lic_000000', plugin_id: SAMPLE_ID })).status, 403);
});
