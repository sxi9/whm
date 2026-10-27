import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootMarket, totpCode, buildPackage, manifestFor } from './market-support.js';

let h;
before(async () => { h = await bootMarket(); });
after(() => h.close());

test('11 failed logins lock the account (audit + mail); the lock expires', async () => {
  const dev = await h.developer({ key: null, loggedIn: false });
  const ip = '198.51.100.7';
  let last;
  for (let i = 0; i < 10; i++) {
    last = await h.http.post('/v1/dev/login').set('X-Forwarded-For', ip).send({ email: dev.email, password: 'wrong-password-123' });
  }
  assert.ok([401, 423].includes(last.status), `attempt 10 → ${last.status}`);
  const locked = await h.http.post('/v1/dev/login').set('X-Forwarded-For', ip).send({ email: dev.email, password: dev.password, totp: totpCode(dev.secret) });
  assert.equal(locked.status, 423, JSON.stringify(locked.body));
  assert.equal(locked.body.error.code, 'account_locked');
  assert.ok(dev.row().locked_until);
  assert.ok(h.mdb.prepare("SELECT 1 FROM audit_log WHERE action = 'developer.security.lockout' AND target = ?").get(dev.id));
  assert.ok(h.sent.some((s) => s.to === dev.email && s.template === 'dev.security_event' && /lockout/.test(s.message)));
  h.advance(16 * 60_000);
  const again = await h.http.post('/v1/dev/login').set('X-Forwarded-For', ip).send({ email: dev.email, password: dev.password, totp: totpCode(dev.secret) });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  // a login from a new address writes a security event + mail
  const newIp = await request.agent(h.ctx.app).post('/v1/dev/login').set('X-Forwarded-For', '198.51.100.99').send({ email: dev.email, password: dev.password, totp: totpCode(dev.secret) });
  assert.equal(newIp.status, 200);
  assert.ok(h.sent.some((s) => s.to === dev.email && /new address/.test(s.message)));
});

test('step-up required for key add, namespace claim, API-key creation and publish; API keys without TOTP → 403', async () => {
  const dev = await h.developer({ key: null, namespaces: ['test.stepup'] });
  h.advance(6 * 60_000);
  for (const [method, url, body] of [['post', '/v1/dev/keys', {}], ['post', '/v1/dev/namespaces', { ns: 'test.stepup2' }], ['post', '/v1/dev/api-keys', { name: 'ci', scopes: ['plugin:read'] }]]) {
    const res = await dev[method](url, body);
    assert.equal(res.status, 403, `${url}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, 'totp_stepup_required');
  }
  assert.equal((await dev.stepUp()).status, 200);
  assert.equal((await dev.post('/v1/dev/keys')).status, 201);
  const key = await dev.post('/v1/dev/api-keys', { name: 'ci', scopes: ['plugin:read', 'version:upload', 'version:publish'] });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  assert.match(key.body.data.key, /^whd_/);
  // API keys: scoped reads work, † routes are closed, publish is allowed with version:publish.
  const viaKey = (m, url) => h.http[m](url).set('X-Dev-Api-Key', key.body.data.key);
  assert.equal((await viaKey('get', '/v1/dev/plugins')).status, 200);
  assert.equal((await viaKey('get', '/v1/dev/api-keys')).body.error.code, 'portal_session_required', 'account management is closed to API keys');
  assert.equal((await viaKey('post', '/v1/dev/keys').send({})).body.error.code, 'portal_session_required');
  assert.equal((await viaKey('post', '/v1/dev/api-keys').send({ name: 'x', scopes: ['plugin:read'] })).body.error.code, 'portal_session_required');
  assert.equal((await viaKey('post', '/v1/dev/webhooks').send({ url: 'https://dev.example.test/h' })).body.error.code, 'insufficient_scope');
  assert.equal((await h.http.get('/v1/dev/plugins').set('X-Dev-Api-Key', 'whd_nope')).status, 401);
  // publish through the API key with version:publish
  await h.registerKey(dev, dev.pem);
  assert.equal((await h.createListing(dev, 'test.stepup.p')).status, 201);
  const up = await viaKey('post', '/v1/dev/plugins/test.stepup.p/versions?channel=stable').set('Content-Type', 'application/gzip').send(buildPackage({ manifest: manifestFor('test.stepup.p'), signWith: dev.pem }));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal((await h.approveReview(up.body.data.review_id)).status, 200);
  h.advance(6 * 60_000);
  const sessionPublish = await h.publish(dev, 'test.stepup.p', '1.0.0');
  assert.equal(sessionPublish.body.error.code, 'totp_stepup_required', 'session publish needs a fresh step-up');
  const keyPublish = await viaKey('post', '/v1/dev/plugins/test.stepup.p/versions/1.0.0/publish').send({});
  assert.equal(keyPublish.status, 200, JSON.stringify(keyPublish.body));
  // Without TOTP, API keys cannot be created at all.
  const plain = await h.developer({ key: null, totp: false });
  const noTotp = await plain.post('/v1/dev/api-keys', { name: 'x', scopes: ['plugin:read'] });
  assert.equal(noTotp.status, 403);
  assert.equal(noTotp.body.error.code, 'totp_required');
});

test('disabling TOTP revokes API keys; a password change invalidates every session and API key', async () => {
  const dev = await h.developer({ key: null });
  const key = (await dev.post('/v1/dev/api-keys', { name: 'ci', scopes: ['plugin:read'] })).body.data.key;
  assert.equal((await h.http.get('/v1/dev/me').set('X-Dev-Api-Key', key)).status, 200);
  const off = await dev.post('/v1/dev/2fa/disable', { code: totpCode(dev.secret) });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.api_keys_revoked, 1);
  assert.equal((await h.http.get('/v1/dev/me').set('X-Dev-Api-Key', key)).status, 401);
  // re-enable, mint a key and a second session, then change the password
  const start = await dev.post('/v1/dev/2fa/start');
  assert.equal((await dev.post('/v1/dev/2fa/confirm', { code: totpCode(start.body.data.secret) })).status, 200);
  const key2 = (await dev.post('/v1/dev/api-keys', { name: 'ci2', scopes: ['plugin:read'] })).body.data.key;
  const second = request.agent(h.ctx.app);
  assert.equal((await second.post('/v1/dev/login').send({ email: dev.email, password: dev.password, totp: totpCode(start.body.data.secret) })).status, 200);
  const change = await dev.post('/v1/dev/password/change', { current_password: dev.password, password: 'Another-Strong-Passw0rd' });
  assert.equal(change.status, 200, JSON.stringify(change.body));
  assert.equal((await second.get('/v1/dev/me')).status, 401, 'other sessions invalidated');
  assert.equal((await dev.get('/v1/dev/me')).status, 401, 'own session invalidated');
  assert.equal((await h.http.get('/v1/dev/me').set('X-Dev-Api-Key', key2)).status, 401, 'API keys invalidated');
  assert.ok(h.sent.some((s) => s.to === dev.email && /password_changed/.test(s.message)));
});

test('password reset: 202 always, single-use token, 15-minute TTL, TOTP required when enabled', async () => {
  const dev = await h.developer({ key: null });
  assert.equal((await h.http.post('/v1/dev/password/reset').send({ email: 'nobody@example.test' })).status, 202);
  const before = h.sent.length;
  assert.equal((await h.http.post('/v1/dev/password/reset').send({ email: dev.email })).status, 202);
  const mail = h.sent.slice(before).find((s) => s.template === 'dev.password_reset');
  const token = /reset\/([A-Za-z0-9_-]+)/.exec(mail.message)[1];
  const noTotp = await h.http.post(`/v1/dev/password/reset/${token}`).send({ password: 'Fresh-Passw0rd-Again' });
  assert.equal(noTotp.body.error.code, 'invalid_totp');
  const ok = await h.http.post(`/v1/dev/password/reset/${token}`).send({ password: 'Fresh-Passw0rd-Again', totp: totpCode(dev.secret) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const reuse = await h.http.post(`/v1/dev/password/reset/${token}`).send({ password: 'Fresh-Passw0rd-Again', totp: totpCode(dev.secret) });
  assert.equal(reuse.status, 410);
  assert.equal((await h.http.post('/v1/dev/password/reset').send({ email: dev.email })).status, 202);
  const mail2 = h.sent.slice(-1)[0];
  const token2 = /reset\/([A-Za-z0-9_-]+)/.exec(mail2.message)[1];
  h.advance(16 * 60_000);
  const expired = await h.http.post(`/v1/dev/password/reset/${token2}`).send({ password: 'Fresh-Passw0rd-Again2', totp: totpCode(dev.secret) });
  assert.equal(expired.status, 410);
  assert.equal((await request.agent(h.ctx.app).post('/v1/dev/login').send({ email: dev.email, password: 'Fresh-Passw0rd-Again', totp: totpCode(dev.secret) })).status, 200);
});

test('developer API keys never reach account, verification, key or session management, whatever their scopes', async () => {
  const dev = await h.developer({ key: null, namespaces: ['test.keyscope'] });
  const key = (await dev.post('/v1/dev/api-keys', { name: 'stats', scopes: ['stats:read'] })).body.data.key;
  const viaKey = (m, url) => h.http[m](url).set('X-Dev-Api-Key', key);
  const closed = [
    ['patch', '/v1/dev/profile', { display_name: 'Hijacked' }],
    ['get', '/v1/dev/profile'],
    ['post', '/v1/dev/verification', { method: 'dns_txt', ns: 'test.keyscope' }],
    ['post', '/v1/dev/verification/dvr_000000/recheck', {}],
    ['get', '/v1/dev/verification'],
    ['get', '/v1/dev/verification/github/start?id=dvr_000000'],
    ['get', '/v1/dev/namespaces'],
    ['get', '/v1/dev/keys'],
    ['get', '/v1/dev/api-keys'],
    ['delete', '/v1/dev/api-keys/dky_000000'],
    ['get', '/v1/dev/sessions'],
    ['delete', '/v1/dev/sessions'],
    ['post', '/v1/dev/logout', {}],
    ['post', '/v1/dev/2fa/start', {}],
    ['post', '/v1/dev/2fa/confirm', { code: '000000' }],
    ['post', '/v1/dev/2fa/disable', { code: '000000' }],
    ['post', '/v1/dev/2fa/stepup', { totp: '000000' }],
    ['post', '/v1/dev/password/change', { current_password: dev.password, password: 'Another-Strong-Passw0rd' }],
  ];
  for (const [method, url, body] of closed) {
    const res = body === undefined ? await viaKey(method, url) : await viaKey(method, url).send(body);
    assert.equal(res.status, 403, `${method} ${url}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, 'portal_session_required', `${method} ${url}`);
  }
  assert.notEqual(dev.row().display_name, 'Hijacked', 'profile untouched');
  assert.equal(dev.row().totp_enabled, 1, 'TOTP still enabled');
  assert.equal((await h.http.get('/v1/dev/me').set('X-Dev-Api-Key', key)).status, 200, 'the key itself still works');
  assert.equal((await viaKey('get', '/v1/dev/plugins')).body.error.code, 'insufficient_scope', 'scoped routes still check scopes');
  // a TOTP code sent to 2fa/confirm or 2fa/disable is redacted in the request audit
  const off = await dev.post('/v1/dev/2fa/disable', { code: totpCode(dev.secret) });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const fresh = await dev.post('/v1/dev/2fa/start');
  const code = totpCode(fresh.body.data.secret);
  assert.equal((await dev.post('/v1/dev/2fa/confirm', { code })).status, 200);
  for (const action of ['POST /v1/dev/2fa/confirm', 'POST /v1/dev/2fa/disable']) {
    const row = h.db.prepare('SELECT args_redacted FROM audit_log WHERE action = ? ORDER BY id DESC').get(action);
    assert.ok(row, action);
    assert.match(row.args_redacted, /"code":"\[redacted\]"/, `${action}: ${row.args_redacted}`);
  }
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%' || ? || '%'").get(`"${code}"`).n, 0);
});

test('a malformed cookie never breaks the developer routes', async () => {
  const bad = (m, url) => h.http[m](url).set('Cookie', 'whmdev.sid=%E0; other=%ZZ');
  assert.equal((await bad('get', '/v1/dev/me')).status, 401);
  assert.equal((await bad('post', '/v1/dev/password/reset').send({ email: 'nobody@example.test' })).status, 202);
});
