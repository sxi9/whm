import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { authenticator } from 'otplib';
import { bootHub } from './support.js';

let h; let r1; let r2; let k1; let k2;
before(async () => {
  h = await bootHub();
  r1 = (await h.admin('post', '/v1/admin/resellers').send({ name: 'Reseller One', email: 'one@reseller.test', quota: { solo: 2, pro: 1, trial: -1 }, pricing: { solo: { annual: 6000, monthly: 600 }, pro: { annual: 18000 } } })).body.data;
  r2 = (await h.admin('post', '/v1/admin/resellers').send({ name: 'Reseller Two', email: 'two@reseller.test', quota: { solo: 5 } })).body.data;
  k1 = h.createApiKey({ ownerType: 'reseller', ownerId: r1.id, scopes: ['license:read', 'license:issue', 'license:renew', 'license:revoke', 'customer:write', 'webhook:write'] });
  k2 = h.createApiKey({ ownerType: 'reseller', ownerId: r2.id, scopes: ['license:read', 'license:issue'] });
});
after(() => h.close());

const as = (k) => (m, u) => h.http[m](u).set('Authorization', `Bearer ${k}`);

test('issuance consumes quota, meta.quota_left is returned and quota_exceeded is 409', async () => {
  const a = await as(k1)('post', '/v1/reseller/licenses').send({ sku: 'whm-solo-annual', customer: { email: 'c1@r1.test', name: 'C1' }, term_months: 12 });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.meta.quota_left.solo, 1);
  const b = await as(k1)('post', '/v1/reseller/licenses').send({ sku: 'whm-solo-annual', customer: { email: 'c2@r1.test' } });
  assert.equal(b.body.meta.quota_left.solo, 0);
  const c = await as(k1)('post', '/v1/reseller/licenses').send({ sku: 'whm-solo-monthly', customer: { email: 'c3@r1.test' } });
  assert.equal(c.status, 409);
  assert.equal(c.body.error.code, 'quota_exceeded');
  const unlimited = await as(k1)('post', '/v1/reseller/licenses').send({ sku: 'whm-trial', customer: { email: 'c4@r1.test' } });
  assert.equal(unlimited.status, 201, 'trial quota -1 = unlimited');
  const quota = await as(k1)('get', '/v1/reseller/quota');
  assert.equal(quota.body.data.quota_left.solo, 0);
  assert.equal(quota.body.data.quota_left.trial, -1);
  assert.equal(quota.body.data.issued.solo, 2);
});

test('bulk issue respects quota up front and runs as a job', async () => {
  const customer = (await as(k2)('post', '/v1/reseller/customers').send({ name: 'Bulk', email: 'bulk@r2.test' }));
  assert.equal(customer.status, 403, 'customer:write scope missing');
  const cust = h.ctx.customers.create({ name: 'Bulk', email: 'bulk@r2.test', reseller_id: r2.id });
  const tooMany = await as(k2)('post', '/v1/reseller/licenses/bulk').send({ sku: 'whm-solo-annual', count: 6, customer_id: cust.id });
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.body.error.code, 'quota_exceeded');
  const ok = await as(k2)('post', '/v1/reseller/licenses/bulk').send({ sku: 'whm-solo-annual', count: 3, customer_id: cust.id });
  assert.equal(ok.status, 202);
  await h.ctx.jobs.settle();
  const job = await as(k2)('get', `/v1/reseller/jobs/${ok.body.data.job.id}`);
  assert.equal(job.body.data.status, 'done');
  assert.equal(job.body.data.result.licenses.length, 3);
  assert.equal(h.ctx.resellers.quotaLeft(r2.id).solo, 2);
  const foreign = await as(k1)('get', `/v1/reseller/jobs/${ok.body.data.job.id}`);
  assert.equal(foreign.status, 404);
});

test('row scoping: a reseller cannot read, modify or deactivate another reseller\'s license or customer', async () => {
  const mine = (await as(k1)('get', '/v1/reseller/licenses')).body;
  assert.ok(mine.data.length >= 3 && mine.data.every((l) => l.reseller_id === r1.id));
  const theirs = (await as(k2)('get', '/v1/reseller/licenses')).body.data;
  assert.ok(theirs.every((l) => l.reseller_id === r2.id));
  const foreignId = theirs[0].id;
  assert.equal((await as(k1)('get', `/v1/reseller/licenses/${foreignId}`)).status, 404);
  assert.equal((await as(k1)('post', `/v1/reseller/licenses/${foreignId}/renew`).send({ term_months: 1 })).status, 404);
  assert.equal((await as(k1)('post', `/v1/reseller/licenses/${foreignId}/revoke`).send({ reason: 'x' })).status, 404);
  assert.equal((await as(k1)('get', `/v1/reseller/licenses/${foreignId}/activations`)).status, 404);
  const foreignCustomer = h.ctx.licenses.get(foreignId).customer_id;
  assert.equal((await as(k1)('get', `/v1/reseller/customers/${foreignCustomer}`)).status, 404);
  assert.equal((await as(k1)('patch', `/v1/reseller/customers/${foreignCustomer}`).send({ name: 'hijack' })).status, 404);
  const reuse = await as(k1)('post', '/v1/reseller/licenses').send({ sku: 'whm-trial', customer: { email: 'bulk@r2.test' } });
  assert.equal(reuse.status, 403);
  assert.equal(reuse.body.error.code, 'customer_not_owned');
  assert.equal(h.ctx.licenses.get(foreignId).status, 'active', 'nothing changed');
});

test('API-key scope matrix', async () => {
  const lic = (await as(k1)('get', '/v1/reseller/licenses')).body.data.find((l) => l.edition === 'solo');
  const readOnly = h.createApiKey({ ownerType: 'reseller', ownerId: r1.id, scopes: ['license:read'] });
  const cases = [
    ['get', '/v1/reseller/licenses', {}, readOnly, 200],
    ['post', '/v1/reseller/licenses', { sku: 'whm-trial', customer: { email: 'scope@r1.test' } }, readOnly, 403],
    ['post', `/v1/reseller/licenses/${lic.id}/renew`, { term_months: 1 }, readOnly, 403],
    ['post', `/v1/reseller/licenses/${lic.id}/suspend`, { reason: 'x' }, readOnly, 403],
    ['get', '/v1/reseller/customers', {}, readOnly, 200],
    ['post', '/v1/reseller/customers', { name: 'x', email: 'scope2@r1.test' }, readOnly, 403],
    ['get', '/v1/reseller/webhooks', {}, readOnly, 403],
    ['post', `/v1/reseller/licenses/${lic.id}/renew`, { term_months: 1 }, k1, 200],
    ['post', '/v1/reseller/customers', { name: 'x', email: 'scope3@r1.test' }, k1, 201],
    ['get', '/v1/reseller/webhooks', {}, k1, 200],
    ['get', '/v1/reseller/api-keys', {}, readOnly, 403],
    ['get', '/v1/reseller/api-keys', {}, k1, 200],
  ];
  for (const [m, u, body, key, status] of cases) {
    const res = await as(key)(m, u).send(body);
    assert.equal(res.status, status, `${m} ${u} with ${key === readOnly ? 'license:read' : 'full'} → ${res.status} ${JSON.stringify(res.body)}`);
    if (status === 403) assert.equal(res.body.error.code, 'insufficient_scope');
  }
  const vendorKeyOnResellerApi = await h.admin('get', '/v1/reseller/licenses');
  assert.equal(vendorKeyOnResellerApi.status, 403);
  assert.equal(vendorKeyOnResellerApi.body.error.code, 'wrong_owner_type');
  const resellerKeyOnAdminApi = await as(k1)('get', '/v1/admin/licenses');
  assert.equal(resellerKeyOnAdminApi.status, 403);
  assert.equal((await h.http.get('/v1/reseller/licenses')).status, 401);
  assert.equal((await h.http.get('/v1/reseller/licenses').set('Authorization', 'Bearer whk_nope')).status, 401);
});

test('reseller suspend/revoke/rekey/activations within scope', async () => {
  const issued = await as(k1)('post', '/v1/reseller/licenses').send({ sku: 'whm-trial', customer: { email: 'life@r1.test' } });
  const id = issued.body.data.license_id;
  const act = await h.activate(issued.body.data.key, h.fp('rs'));
  const acts = await as(k1)('get', `/v1/reseller/licenses/${id}/activations`);
  assert.equal(acts.body.data.length, 1);
  const deact = await as(k1)('post', `/v1/reseller/licenses/${id}/activations/${act.body.data.activation_id}/deactivate`).send({ reason: 'customer request' });
  assert.equal(deact.status, 200);
  assert.equal(deact.body.data.deactivated, true);
  assert.equal((await as(k1)('post', `/v1/reseller/licenses/${id}/suspend`).send({ reason: 'x' })).body.data.status, 'suspended');
  assert.equal((await as(k1)('post', `/v1/reseller/licenses/${id}/unsuspend`).send({})).body.data.status, 'active');
  const rekey = await as(k1)('post', `/v1/reseller/licenses/${id}/rekey`).send({});
  assert.match(rekey.body.data.key, /^WHM-/);
  assert.equal((await as(k1)('post', `/v1/reseller/licenses/${id}/revoke`).send({ reason: 'fraud' })).body.data.status, 'revoked');
});

test('reseller invoices (wholesale statement) and admin quota editing', async () => {
  const inv = await as(k1)('get', '/v1/reseller/invoices');
  assert.equal(inv.status, 200);
  assert.ok(inv.body.data.total_cents >= 12000, `solo annual ×2 at 6000 wholesale: ${inv.body.data.total_cents}`);
  assert.ok(inv.body.data.lines.every((l) => !('key' in l)));
  const put = await h.admin('put', `/v1/admin/resellers/${r1.id}/quota`).send({ quota: { solo: 10, pro: 1, trial: -1 } });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.quota.solo, 10);
  assert.equal((await as(k1)('get', '/v1/reseller/quota')).body.data.quota_left.solo, 8);
  const statement = await h.admin('get', `/v1/admin/resellers/${r1.id}/statement`);
  assert.equal(statement.body.data.reseller_id, r1.id);
  const report = await h.admin('get', '/v1/admin/reports/resellers');
  assert.ok(report.body.data.find((r) => r.id === r1.id).quota_left.solo === 8);
});

test('a reseller portal user hits the reseller API through a session, scoped to its reseller', async () => {
  await h.ctx.portalUsers.create({ email: 'staff@reseller.test', password: 'Reseller-Pass-1', role: 'reseller_staff', reseller_id: r1.id });
  const agent = (await import('supertest')).default.agent(h.ctx.app);
  const login = await agent.post('/v1/portal/login').send({ email: 'staff@reseller.test', password: 'Reseller-Pass-1' });
  assert.equal(login.status, 200);
  const csrf = login.body.data.csrfToken;
  const list = await agent.get('/v1/reseller/licenses');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.every((l) => l.reseller_id === r1.id));
  const lic = list.body.data.find((l) => l.status === 'active');
  const noCsrf = await agent.post(`/v1/reseller/licenses/${lic.id}/renew`).send({ term_months: 1 });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error.code, 'csrf_failed');
  const revoke = await agent.post(`/v1/reseller/licenses/${lic.id}/revoke`).set('X-CSRF-Token', csrf).send({ reason: 'x' });
  assert.equal(revoke.status, 403, 'reseller_staff has no license:revoke');
  assert.equal((await agent.get('/v1/admin/licenses')).status, 403);
});

test('§16.7 scopes: /v1/reseller/api-keys is gated by webhook:write and a key never grants scopes its creator lacks', async () => {
  const { RESELLER_SCOPES } = await import('../shared/auth.js');
  assert.deepEqual(RESELLER_SCOPES, ['license:read', 'license:issue', 'license:renew', 'license:revoke', 'customer:write', 'webhook:write']);
  const integration = h.createApiKey({ ownerType: 'reseller', ownerId: r1.id, scopes: ['webhook:write'] });
  const escalate = await as(integration)('post', '/v1/reseller/api-keys').send({ name: 'more', scopes: ['license:revoke', 'license:issue'] });
  assert.equal(escalate.status, 403);
  assert.equal(escalate.body.error.code, 'insufficient_scope');
  assert.match(escalate.body.error.message, /license:revoke/);
  const same = await as(integration)('post', '/v1/reseller/api-keys').send({ name: 'same', scopes: ['webhook:write'] });
  assert.equal(same.status, 201);
  assert.match(same.body.data.key, /^whk_/);
  const unknownScope = await as(k1)('post', '/v1/reseller/api-keys').send({ name: 'x', scopes: ['apikey:write'] });
  assert.equal(unknownScope.status, 422, 'apikey:write is not a reseller scope');
  const vendorScope = await as(k1)('post', '/v1/reseller/api-keys').send({ name: 'x', scopes: ['admin:*'] });
  assert.equal(vendorScope.status, 422);
  const sub = await as(k1)('post', '/v1/reseller/api-keys').send({ name: 'sub', scopes: ['license:read', 'license:issue'] });
  assert.equal(sub.status, 201, 'k1 holds both');
  const vendorRo = h.createApiKey({ scopes: ['admin:write'] });
  const vendorEscalate = await h.asKey(vendorRo)('post', '/v1/admin/api-keys').send({ name: 'x', scopes: ['admin:*'] });
  assert.equal(vendorEscalate.status, 403);
  assert.equal((await h.asKey(vendorRo)('post', '/v1/admin/api-keys').send({ name: 'x', scopes: ['admin:write'] })).status, 201);
});

test('a suspended or closed reseller loses its API keys, portal sessions and issuance until reactivated', async () => {
  const staffKey = h.createApiKey({ ownerType: 'reseller', ownerId: r2.id, scopes: ['license:read', 'license:issue', 'license:renew'] });
  await h.ctx.portalUsers.create({ email: 'admin2@reseller.test', password: 'Reseller-Pass-2', role: 'reseller_admin', reseller_id: r2.id });
  const agent = (await import('supertest')).default.agent(h.ctx.app);
  const login = await agent.post('/v1/portal/login').send({ email: 'admin2@reseller.test', password: 'Reseller-Pass-2' });
  assert.equal(login.status, 200);
  assert.equal((await agent.get('/v1/reseller/licenses')).status, 200);
  assert.equal((await as(staffKey)('get', '/v1/reseller/licenses')).status, 200);
  const lic = (await as(staffKey)('get', '/v1/reseller/licenses')).body.data[0];

  const suspend = await h.admin('patch', `/v1/admin/resellers/${r2.id}`).send({ status: 'suspended' });
  assert.equal(suspend.status, 200);
  assert.equal(suspend.body.data.status, 'suspended');
  for (const [m, u, body] of [['get', '/v1/reseller/licenses'], ['post', '/v1/reseller/licenses', { sku: 'whm-trial', customer: { email: 'sus@r2.test' } }], ['post', `/v1/reseller/licenses/${lic.id}/renew`, { term_months: 1 }], ['get', '/v1/reseller/quota']]) {
    const res = await as(staffKey)(m, u).send(body);
    assert.equal(res.status, 403, `${m} ${u} → ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, 'reseller_suspended');
  }
  assert.equal((await agent.get('/v1/reseller/licenses')).status, 401, 'live portal sessions were destroyed');
  // a session that survived (e.g. created between the status write and the sweep) is refused and dropped
  h.db.prepare("UPDATE resellers SET status = 'active' WHERE id = ?").run(r2.id);
  const agentB = (await import('supertest')).default.agent(h.ctx.app);
  assert.equal((await agentB.post('/v1/portal/login').send({ email: 'admin2@reseller.test', password: 'Reseller-Pass-2' })).status, 200);
  h.db.prepare("UPDATE resellers SET status = 'suspended' WHERE id = ?").run(r2.id);
  const live = await agentB.get('/v1/reseller/licenses');
  assert.equal(live.status, 403);
  assert.equal(live.body.error.code, 'reseller_suspended');
  assert.equal((await agentB.get('/v1/portal/me')).status, 401, 'the session was destroyed on refusal');
  const relogin = await agent.post('/v1/portal/login').send({ email: 'admin2@reseller.test', password: 'Reseller-Pass-2' });
  assert.equal(relogin.status, 403);
  assert.equal(relogin.body.error.code, 'reseller_suspended');
  // the vendor cannot issue on the suspended reseller's behalf either
  const onBehalf = await h.admin('post', '/v1/admin/licenses').send({ sku: 'whm-trial', customer: { email: 'behalf@r2.test' }, reseller_id: r2.id });
  assert.equal(onBehalf.status, 403);
  assert.equal(onBehalf.body.error.code, 'reseller_suspended');
  assert.throws(() => h.ctx.licenses.changeEdition(lic.id, { sku: 'whm-solo-annual' }, { scope: { resellerId: r2.id } }), (e) => e.code === 'reseller_suspended');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reseller.suspended' AND target = ?").get(r2.id).n, 1);

  assert.equal((await h.admin('patch', `/v1/admin/resellers/${r2.id}`).send({ status: 'closed' })).body.data.status, 'closed');
  const closed = await as(staffKey)('get', '/v1/reseller/licenses');
  assert.equal(closed.status, 403);
  assert.match(closed.body.error.message, /closed/);

  assert.equal((await h.admin('patch', `/v1/admin/resellers/${r2.id}`).send({ status: 'active' })).body.data.status, 'active');
  assert.equal((await as(staffKey)('get', '/v1/reseller/licenses')).status, 200);
  assert.equal((await agent.post('/v1/portal/login').send({ email: 'admin2@reseller.test', password: 'Reseller-Pass-2' })).status, 200);
  assert.equal((await h.admin('post', '/v1/admin/licenses').send({ sku: 'whm-trial', customer: { email: 'behalf@r2.test' }, reseller_id: r2.id })).status, 201);
});

test('GET /v1/reseller/products lists only the editions the reseller may issue, priced from its pricing_json', async () => {
  const mine = await as(k1)('get', '/v1/reseller/products');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const bySku = Object.fromEntries(mine.body.data.map((p) => [p.sku, p]));
  assert.deepEqual(Object.keys(bySku).sort(), ['whm-pro-annual', 'whm-pro-monthly', 'whm-solo-annual', 'whm-solo-monthly', 'whm-trial'], 'quota { solo, pro, trial } → those editions only');
  assert.equal(bySku['whm-solo-annual'].price_cents, 6000, 'wholesale annual price');
  assert.equal(bySku['whm-solo-monthly'].price_cents, 600);
  assert.equal(bySku['whm-pro-annual'].price_cents, 18000);
  assert.equal(bySku['whm-pro-monthly'].price_cents, null, 'no wholesale price set for pro/monthly');
  assert.equal(bySku['whm-trial'].price_cents, null);
  assert.equal(bySku['whm-solo-annual'].currency, 'USD');
  assert.equal(bySku['whm-solo-annual'].active, true);
  assert.deepEqual(Object.keys(bySku['whm-solo-annual']).sort(), ['active', 'currency', 'edition', 'features', 'limits', 'name', 'price_cents', 'rank', 'sku', 'term', 'term_days']);
  assert.ok(!mine.body.data.some((p) => p.price_cents != null && !Number.isInteger(p.price_cents)));
  const theirs = await as(k2)('get', '/v1/reseller/products');
  assert.deepEqual(theirs.body.data.map((p) => p.sku).sort(), ['whm-solo-annual', 'whm-solo-monthly']);
  assert.ok(theirs.body.data.every((p) => p.price_cents === null), 'no pricing_json → null prices, never the retail price');
  // an inactive product disappears from the catalog
  await h.admin('put', '/v1/admin/products/whm-solo-monthly').send({ active: false });
  assert.deepEqual((await as(k2)('get', '/v1/reseller/products')).body.data.map((p) => p.sku), ['whm-solo-annual']);
  await h.admin('put', '/v1/admin/products/whm-solo-monthly').send({ active: true });
  assert.equal((await h.admin('get', '/v1/reseller/products')).body.error.code, 'wrong_owner_type', 'vendor keys use /v1/admin/products');
  assert.equal((await h.http.get('/v1/reseller/products')).status, 401);
});

// otplib verifies against the real clock with window 0; start TOTP sequences
// with time to spare in the current 30 s step (see security.test.js).
function freshTotpStep() {
  const left = 30_000 - (Date.now() % 30_000);
  return left < 15_000 ? new Promise((resolve) => setTimeout(resolve, left + 50)) : Promise.resolve();
}

test('POST /v1/admin/resellers/:id/impersonate rebinds a vendor_admin session to the reseller for 15 minutes, audited both ways', async () => {
  await freshTotpStep();
  const admin = await h.ctx.portalUsers.create({ email: 'imp-admin@vendor.test', password: 'Vendor-Pass-123', role: 'vendor_admin' });
  const support = await h.ctx.portalUsers.create({ email: 'imp-support@vendor.test', password: 'Support-Pass-123', role: 'vendor_support' });
  const agent = request.agent(h.ctx.app);
  const login = await agent.post('/v1/portal/login').send({ email: 'imp-admin@vendor.test', password: 'Vendor-Pass-123' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const csrf = login.body.data.csrfToken;
  const post = (url, body = {}) => agent.post(url).set('X-CSRF-Token', csrf).send(body);
  // step-up gate: TOTP must be enabled and fresh
  assert.equal((await post(`/v1/admin/resellers/${r1.id}/impersonate`)).body.error.code, 'totp_required');
  const enroll = await post('/v1/portal/2fa/enroll');
  assert.equal((await post('/v1/portal/2fa/confirm', { code: authenticator.generate(enroll.body.data.secret) })).status, 200);
  // API keys cannot impersonate (no session to rebind) and the reseller must exist and be active
  assert.equal((await h.admin('post', `/v1/admin/resellers/${r1.id}/impersonate`).send({})).body.error.code, 'portal_session_required');
  assert.equal((await post('/v1/admin/resellers/rs_000000000000/impersonate')).status, 404);
  await h.admin('patch', `/v1/admin/resellers/${r2.id}`).send({ status: 'suspended' });
  assert.equal((await post(`/v1/admin/resellers/${r2.id}/impersonate`)).body.error.code, 'reseller_suspended');
  await h.admin('patch', `/v1/admin/resellers/${r2.id}`).send({ status: 'active' });
  assert.equal((await post(`/v1/admin/resellers/${r1.id}/impersonate`, { extra: 1 })).status, 422);

  const started = await post(`/v1/admin/resellers/${r1.id}/impersonate`);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.data.reseller_id, r1.id);
  assert.equal(new Date(started.body.data.expires_at).getTime(), h.clock.t + 15 * 60_000);
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action = 'reseller.impersonate' AND principal = ? AND target = ?").get(`portal:${admin.id}`, r1.id));
  // the session now is reseller_admin of r1: /me says so, the reseller API scopes to r1, the vendor API refuses
  const me = await agent.get('/v1/portal/me');
  assert.equal(me.body.data.user.role, 'reseller_admin');
  assert.equal(me.body.data.user.reseller_id, r1.id);
  assert.equal(me.body.data.user.id, admin.id, 'the vendor identity is kept');
  assert.equal(me.body.data.impersonating.reseller_id, r1.id);
  assert.equal(me.body.data.impersonating.by, admin.id);
  assert.equal(me.body.data.reseller.name, 'Reseller One');
  const licenses = await agent.get('/v1/reseller/licenses');
  assert.equal(licenses.status, 200);
  assert.ok(licenses.body.data.length >= 3 && licenses.body.data.every((l) => l.reseller_id === r1.id));
  assert.equal((await agent.get('/v1/reseller/products')).status, 200);
  assert.equal((await agent.get('/v1/admin/licenses')).body.error.code, 'wrong_owner_type', 'no vendor powers while impersonating');
  assert.equal((await post(`/v1/admin/resellers/${r2.id}/impersonate`)).body.error.code, 'wrong_owner_type');
  // actions taken while impersonating are audited under the admin's identity with the reseller role
  const cust = await post('/v1/reseller/customers', { name: 'Imp Customer', email: 'imp-customer@r1.test' });
  assert.equal(cust.status, 201, JSON.stringify(cust.body));
  assert.equal(h.ctx.customers.get(cust.body.data.id).reseller_id, r1.id, 'row scoped to the impersonated tenant');
  const row = h.db.prepare("SELECT principal, role FROM audit_log WHERE action = 'customer.create' AND target = ?").get(cust.body.data.id);
  assert.deepEqual(row, { principal: `portal:${admin.id}`, role: 'reseller_admin' });
  // ending restores the vendor session
  const ended = await post('/v1/portal/impersonate/end');
  assert.deepEqual(ended.body.data, { ended: true, reseller_id: r1.id });
  assert.equal((await agent.get('/v1/portal/me')).body.data.impersonating, null);
  assert.equal((await agent.get('/v1/portal/me')).body.data.user.role, 'vendor_admin');
  assert.equal((await agent.get('/v1/admin/licenses')).status, 200);
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action = 'reseller.impersonate_end' AND target = ? AND args_redacted LIKE '%ended%'").get(r1.id));
  assert.deepEqual((await post('/v1/portal/impersonate/end')).body.data, { ended: false, reseller_id: null }, 'idempotent');
  // expiry: the rebinding lapses by itself after 15 minutes and is audited as expired
  assert.equal((await post(`/v1/admin/resellers/${r1.id}/impersonate`)).status, 200);
  h.advance(15 * 60_000 + 1);
  assert.equal((await agent.get('/v1/portal/me')).body.data.impersonating, null);
  assert.equal((await agent.get('/v1/admin/licenses')).status, 200);
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action = 'reseller.impersonate_end' AND target = ? AND args_redacted LIKE '%expired%'").get(r1.id));
  // vendor_support cannot impersonate
  const agent2 = request.agent(h.ctx.app);
  const sl = await agent2.post('/v1/portal/login').send({ email: 'imp-support@vendor.test', password: 'Support-Pass-123' });
  assert.equal(sl.status, 200);
  const denied = await agent2.post(`/v1/admin/resellers/${r1.id}/impersonate`).set('X-CSRF-Token', sl.body.data.csrfToken).send({});
  assert.equal(denied.body.error.code, 'insufficient_role');
  void support;
});
