import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
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
