import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { authenticator } from 'otplib';
import { bootHub } from './support.js';
import { acceptedRequestId, TOTP_LIMITED_PATHS } from '../src/app.js';

// Phase 6 hardening of the hub's web layer: headers on a plain-HTTP hub,
// caller-supplied request ids, and TOTP guessing from a logged-in session.
let h;
before(async () => { h = await bootHub({ config: { license: { rate_limits: { portal_login: { max: 3, windowMs: 60_000 } } } } }); });
after(async () => { await h.close(); });

function freshTotpStep() {
  const left = 30_000 - (Date.now() % 30_000);
  return left < 15_000 ? new Promise((resolve) => setTimeout(resolve, left + 50)) : Promise.resolve();
}

test('a hub without TLS sends no upgrade-insecure-requests directive and no HSTS', async () => {
  const res = await h.http.get('/healthz');
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.equal(res.headers['strict-transport-security'], undefined);
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('caller-supplied request ids are kept only when short and plain', () => {
  assert.equal(acceptedRequestId('abc-123.def:4'), 'abc-123.def:4');
  assert.equal(acceptedRequestId('x'.repeat(129)), null);
  assert.equal(acceptedRequestId('with space'), null);
  assert.equal(acceptedRequestId(undefined), null);
});

test('a logged-in portal session cannot guess its way through TOTP step-up or 2FA changes', async () => {
  assert.deepEqual(TOTP_LIMITED_PATHS, ['/v1/portal/stepup', '/v1/portal/2fa', '/v1/portal/password']);
  await freshTotpStep();
  await h.ctx.portalUsers.create({ email: 'stepup@vendor.test', password: 'Vendor-Pass-123', role: 'vendor_admin' });
  const agent = request.agent(h.ctx.app);
  const login = await agent.post('/v1/portal/login').send({ email: 'stepup@vendor.test', password: 'Vendor-Pass-123' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const csrf = login.body.data.csrfToken;
  const enroll = await agent.post('/v1/portal/2fa/enroll').set('X-CSRF-Token', csrf).send({});
  assert.equal(enroll.status, 200);
  const secret = enroll.body.data.secret;
  const confirm = await agent.post('/v1/portal/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(secret) });
  assert.equal(confirm.status, 200, 'successful answers do not count against the budget');
  for (let i = 0; i < 3; i++) {
    const wrong = await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: '000000' });
    assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
  }
  const limited = await agent.post('/v1/portal/stepup').set('X-CSRF-Token', csrf).send({ totp: authenticator.generate(secret) });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  // The same budget covers disabling 2FA and changing the password.
  const disable = await agent.post('/v1/portal/2fa/disable').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(secret) });
  assert.equal(disable.status, 429);
  const pw = await agent.post('/v1/portal/password').set('X-CSRF-Token', csrf).send({ current: 'Vendor-Pass-123', next: 'Vendor-Pass-456' });
  assert.equal(pw.status, 429);
  // Reads and unrelated portal routes are untouched.
  assert.equal((await agent.get('/v1/portal/me')).status, 200);
});
