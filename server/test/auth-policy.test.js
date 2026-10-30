import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { createTestApp } from './support/app.js';

// Login/session policy (Security Center › Configure Security Policies) is
// enforced by the core auth layer; these tests drive it through the API.
let app;
const PASSWORD = 'Test-Passw0rd!1';
const POLICY_KEYS = ['security.policy.verified_ip_login', 'security.policy.password_max_age_days', 'security.2fa.required_for_root', 'security.policy.require_2fa_for_resellers', 'security.policy.session_timeout_minutes', 'security.policy.disallow_concurrent_sessions', 'security.policy.api_tokens_require_2fa'];

// Every test logs in from the same address; the per-address login limiter
// (config.loginRateLimit, exercised in api.test.js) is lifted so adding a test
// cannot turn the later ones into 429s.
beforeAll(async () => { app = await createTestApp({ overrides: { loginRateLimit: { windowMs: 15 * 60 * 1000, max: 1000 } } }); });
afterAll(async () => { await app.close(); });
beforeEach(() => {
  app.ctx.settings.setMany(Object.fromEntries(POLICY_KEYS.map((k) => [k, k.includes('days') || k.includes('minutes') ? 0 : false])));
  app.ctx.db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, must_change_password = 0, password_changed_at = NULL, last_login_ip = NULL').run();
  app.ctx.db.prepare('DELETE FROM sessions').run();
  app.ctx.db.prepare('DELETE FROM totp_guard').run();
  app.ctx.db.prepare('DELETE FROM login_attempts').run();
});

const fresh = () => request.agent(app.ctx.app);
async function loginWith(agent, username = 'root', password = PASSWORD) {
  const res = await agent.post('/api/auth/login').send({ username, password });
  return res;
}

describe('session policy', () => {
  it('expires an idle session after the configured timeout', async () => {
    app.ctx.settings.set('security.policy.session_timeout_minutes', 5);
    const agent = fresh();
    expect((await loginWith(agent)).status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    const sid = app.ctx.db.prepare('SELECT sid FROM sessions ORDER BY rowid DESC LIMIT 1').get().sid;
    app.ctx.db.prepare("UPDATE sessions SET data = json_set(data, '$.lastActivity', ?) WHERE sid = ?").run(Date.now() - 6 * 60_000, sid);
    const expired = await agent.get('/api/auth/me');
    expect(expired.status).toBe(401);
    expect(expired.body.error.message).toMatch(/expired/);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('keeps sessions alive while they are used', async () => {
    app.ctx.settings.set('security.policy.session_timeout_minutes', 5);
    const agent = fresh();
    await loginWith(agent);
    const sid = app.ctx.db.prepare('SELECT sid FROM sessions ORDER BY rowid DESC LIMIT 1').get().sid;
    app.ctx.db.prepare("UPDATE sessions SET data = json_set(data, '$.lastActivity', ?) WHERE sid = ?").run(Date.now() - 4 * 60_000, sid);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    const after = JSON.parse(app.ctx.db.prepare('SELECT data FROM sessions WHERE sid = ?').get(sid).data).lastActivity;
    expect(Date.now() - after).toBeLessThan(5_000);
  });

  it('logs the previous session out when concurrent sessions are disallowed', async () => {
    const a = fresh();
    const b = fresh();
    await loginWith(a);
    await loginWith(b);
    expect((await a.get('/api/auth/me')).status).toBe(200);
    app.ctx.settings.set('security.policy.disallow_concurrent_sessions', true);
    const c = fresh();
    expect((await loginWith(c)).status).toBe(200);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(401);
    expect((await b.get('/api/auth/me')).status).toBe(401);
  });
});

describe('password age', () => {
  it('forces a password change when the password is older than the maximum age', async () => {
    app.ctx.settings.set('security.policy.password_max_age_days', 30);
    app.ctx.db.prepare("UPDATE users SET password_changed_at = datetime('now', '-31 days') WHERE username = 'root'").run();
    const agent = fresh();
    const res = await loginWith(agent);
    expect(res.status).toBe(200);
    expect(res.body.data.user.mustChangePassword).toBe(true);
    expect((await agent.get('/api/system/status')).status).toBe(403);
    const change = await agent.post('/api/auth/password').set('X-CSRF-Token', res.body.data.csrfToken).send({ newPassword: 'Another-Passw0rd!2' });
    expect(change.status).toBe(200);
    expect(change.body.data.user.mustChangePassword).toBe(false);
    const row = app.ctx.db.prepare("SELECT password_changed_at FROM users WHERE username = 'root'").get();
    expect(row.password_changed_at).toBeTruthy();
    expect(Date.now() - new Date(row.password_changed_at.replace(' ', 'T') + 'Z').getTime()).toBeLessThan(60_000);
    // restore the known password for the other tests
    app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(await app.ctx.crypto.hashPassword(PASSWORD), 'root');
  });

  it('uses the creation time when no change was ever recorded', async () => {
    app.ctx.settings.set('security.policy.password_max_age_days', 30);
    const res = await loginWith(fresh());
    expect(res.body.data.user.mustChangePassword).toBe(false);
  });
});

describe('required two-factor authentication', () => {
  it('gates root until an authenticator is enrolled, then lifts the gate', async () => {
    app.ctx.settings.set('security.2fa.required_for_root', true);
    const agent = fresh();
    const res = await loginWith(agent);
    expect(res.status).toBe(200);
    expect(res.body.data.mustEnroll2fa).toBe(true);
    const csrf = res.body.data.csrfToken;
    const blocked = await agent.get('/api/system/status');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('two_factor_required');
    expect((await agent.get('/api/auth/me')).body.data.mustEnroll2fa).toBe(true);
    const enroll = await agent.post('/api/auth/2fa/enroll').set('X-CSRF-Token', csrf);
    expect(enroll.status).toBe(200);
    const code = authenticator.generate(enroll.body.data.secret);
    expect((await agent.post('/api/auth/2fa/confirm').set('X-CSRF-Token', csrf).send({ code })).status).toBe(200);
    expect((await agent.get('/api/auth/me')).body.data.mustEnroll2fa).toBe(false);
    expect((await agent.get('/api/system/status')).status).toBe(200);
    // The policy also refuses to disable it again.
    const disable = await agent.post('/api/auth/2fa/disable').set('X-CSRF-Token', csrf);
    expect(disable.status).toBe(403);
  });

  it('applies the reseller rule only to resellers', async () => {
    app.ctx.settings.set('security.policy.require_2fa_for_resellers', true);
    const reseller = await app.createUser('policyres', 'reseller');
    const r = fresh();
    expect((await loginWith(r, reseller.username)).body.data.mustEnroll2fa).toBe(true);
    expect((await loginWith(fresh())).body.data.mustEnroll2fa).toBe(false);
  });

  it('refuses API tokens of users without 2FA when the policy demands it', async () => {
    const token = app.ctx.crypto.randomToken();
    const root = app.ctx.db.prepare("SELECT id FROM users WHERE username = 'root'").get();
    app.ctx.db.prepare("INSERT INTO api_tokens (user_id, name, token_hash, scopes) VALUES (?, 'policy-test', ?, '[]')").run(root.id, app.ctx.crypto.hashToken(token));
    expect((await request(app.ctx.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    app.ctx.settings.set('security.policy.api_tokens_require_2fa', true);
    const refused = await request(app.ctx.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(refused.status).toBe(401);
    expect(refused.body.error.message).toMatch(/two-factor/);
    app.ctx.db.prepare("UPDATE users SET totp_enabled = 1, totp_secret_enc = ? WHERE id = ?").run(app.ctx.crypto.encrypt(authenticator.generateSecret()), root.id);
    expect((await request(app.ctx.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    app.ctx.db.prepare("DELETE FROM api_tokens WHERE name = 'policy-test'").run();
  });
});

describe('two-factor enrolment never replaces or disables an active factor', () => {
  const totpRow = () => app.ctx.db.prepare("SELECT totp_secret_enc, totp_pending_secret_enc, totp_enabled FROM users WHERE username = 'root'").get();

  async function enrolRoot() {
    const agent = fresh();
    const res = await loginWith(agent);
    expect(res.status).toBe(200);
    const csrf = res.body.data.csrfToken;
    const enroll = await agent.post('/api/auth/2fa/enroll').set('X-CSRF-Token', csrf);
    expect(enroll.status).toBe(200);
    // An enrolment in progress arms nothing: the active secret stays untouched
    // and a login in between is not asked for a code.
    expect(totpRow()).toMatchObject({ totp_enabled: 0, totp_secret_enc: null });
    expect(totpRow().totp_pending_secret_enc).toBeTruthy();
    expect((await loginWith(fresh())).body.data.requires2fa).toBeUndefined();
    const confirm = await agent.post('/api/auth/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(enroll.body.data.secret) });
    expect(confirm.status).toBe(200);
    expect(totpRow()).toMatchObject({ totp_enabled: 1, totp_pending_secret_enc: null });
    expect(app.ctx.crypto.decrypt(totpRow().totp_secret_enc)).toBe(enroll.body.data.secret);
    return { agent, csrf, secret: enroll.body.data.secret };
  }

  it('refuses to start or confirm another enrolment while one is enabled', async () => {
    app.ctx.settings.set('security.2fa.required_for_root', true);
    const { agent, csrf, secret } = await enrolRoot();
    const before = totpRow();
    const again = await agent.post('/api/auth/2fa/enroll').set('X-CSRF-Token', csrf);
    expect(again.status).toBe(409);
    expect(again.body.data?.secret).toBeUndefined();
    expect(totpRow()).toEqual(before);
    const confirm = await agent.post('/api/auth/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(secret) });
    expect(confirm.status).toBe(409);
    expect(totpRow()).toEqual(before);
    // The authenticator that was set up still logs the user in.
    const next = fresh();
    expect((await loginWith(next)).body.data).toEqual({ requires2fa: true });
    expect((await next.post('/api/auth/2fa').send({ code: authenticator.generate(secret) })).status).toBe(200);
  });

  it('disabling with the current code clears the factor and allows a fresh enrolment', async () => {
    const { agent, csrf, secret } = await enrolRoot();
    const disable = await agent.post('/api/auth/2fa/disable').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(secret) });
    expect(disable.status).toBe(200);
    expect(totpRow()).toEqual({ totp_enabled: 0, totp_secret_enc: null, totp_pending_secret_enc: null });
    expect((await agent.post('/api/auth/2fa/enroll').set('X-CSRF-Token', csrf)).status).toBe(200);
  });

  it('refuses credential changes from an API token, whatever its scopes', async () => {
    const { secret } = await enrolRoot();
    const before = totpRow();
    const token = app.ctx.crypto.randomToken();
    const root = app.ctx.db.prepare("SELECT id FROM users WHERE username = 'root'").get();
    app.ctx.db.prepare(`INSERT INTO api_tokens (user_id, name, token_hash, scopes) VALUES (?, 'enrol-test', ?, '["*"]')`).run(root.id, app.ctx.crypto.hashToken(token));
    const calls = [
      ['/api/auth/2fa/enroll', undefined],
      ['/api/auth/2fa/confirm', { code: authenticator.generate(secret) }],
      ['/api/auth/2fa/disable', { code: authenticator.generate(secret) }],
      ['/api/auth/2fa/disable', { password: PASSWORD }],
      ['/api/auth/password', { currentPassword: PASSWORD, newPassword: 'Another-Passw0rd!2' }],
    ];
    for (const [path, body] of calls) {
      const res = await request(app.ctx.app).post(path).set('Authorization', `Bearer ${token}`).send(body);
      expect(res.status, path).toBe(403);
      expect(res.body.error.message, path).toMatch(/API token/);
    }
    expect(totpRow()).toEqual(before);
    // The token itself still works and the password is unchanged.
    expect((await request(app.ctx.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await loginWith(fresh())).body.data).toEqual({ requires2fa: true });
    app.ctx.db.prepare("DELETE FROM api_tokens WHERE name = 'enrol-test'").run();
  });
});

describe('super admin flag', () => {
  it('reports users.superadmin on /me and on the login answer, false until whm-cli grants it', async () => {
    const agent = fresh();
    const login = await loginWith(agent);
    expect(login.body.data.user.superadmin).toBe(false);
    let me = await agent.get('/api/auth/me');
    expect(me.body.data.superadmin).toBe(false);
    expect(me.body.data.user.superadmin).toBe(false);
    app.ctx.db.prepare("UPDATE users SET superadmin = 1 WHERE username = 'root'").run();
    try {
      me = await agent.get('/api/auth/me');
      expect(me.body.data.superadmin).toBe(true);
      expect(me.body.data.user.superadmin).toBe(true);
      expect(app.ctx.auth.isSuperadmin({ id: me.body.data.user.id, role: 'root' })).toBe(true);
      // Only a root user can be the super admin, whatever the column says.
      const reseller = await app.createUser('superres', 'reseller');
      app.ctx.db.prepare('UPDATE users SET superadmin = 1 WHERE id = ?').run(reseller.id);
      expect(app.ctx.auth.isSuperadmin({ id: reseller.id, role: 'reseller' })).toBe(false);
      const r = fresh();
      expect((await loginWith(r, reseller.username)).body.data.user.superadmin).toBe(false);
    } finally {
      app.ctx.db.prepare('UPDATE users SET superadmin = 0').run();
      app.ctx.db.prepare("DELETE FROM users WHERE username = 'superres'").run();
    }
  });
});

describe('verified-IP login', () => {
  it('flags a login from an address not used in the last 90 days', async () => {
    app.ctx.settings.set('security.policy.verified_ip_login', true);
    app.ctx.db.prepare("UPDATE users SET last_login_ip = '203.0.113.9' WHERE username = 'root'").run();
    const res = await loginWith(fresh());
    expect(res.status).toBe(200);
    expect(res.body.data.newIp).toBe(true);
    const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'auth.login' ORDER BY id DESC LIMIT 1").get();
    expect(audit.args_redacted).toContain('"newIp":true');
    // The same address is now known.
    expect((await loginWith(fresh())).body.data.newIp).toBe(false);
  });
});

describe('external (OpenID Connect) login', () => {
  const name = 'corp';
  beforeAll(() => {
    app.ctx.security.externalAuth.create({ name, displayName: 'Corp SSO', issuerUrl: 'https://idp.example', clientId: 'whm-client', clientSecret: 'shh' });
    app.ctx.db.prepare('UPDATE external_auth_providers SET discovery_json = ? WHERE name = ?').run(JSON.stringify({ issuer: 'https://idp.example', authorizationEndpoint: 'https://idp.example/authorize', tokenEndpoint: 'https://idp.example/token', jwksUri: 'https://idp.example/jwks' }), name);
  });
  const exchangeOk = (subject = 'sub-123', email = 'alice@example.com') => { app.ctx.security.externalAuth.exchangeCode = async () => ({ claims: { sub: subject }, subject, email, tokens: {} }); };
  const stateFrom = (location) => new URL(location).searchParams.get('state');

  it('lists enabled, discovered providers for the login page', async () => {
    const res = await request(app.ctx.app).get('/api/auth/external');
    expect(res.body.data.providers).toEqual([{ name, displayName: 'Corp SSO' }]);
  });

  it('redirects to the provider with state and nonce, and rejects a callback with the wrong state', async () => {
    const agent = fresh();
    const start = await agent.get(`/api/auth/external/${name}/start`);
    expect(start.status).toBe(302);
    const url = new URL(start.headers.location);
    expect(url.origin + url.pathname).toBe('https://idp.example/authorize');
    expect(url.searchParams.get('client_id')).toBe('whm-client');
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/auth\/external\/corp\/callback$/);
    expect(url.searchParams.get('state')).toHaveLength(32);
    expect(url.searchParams.get('nonce')).toHaveLength(32);
    // The state lives in the session and the callback is a top-level
    // navigation arriving from the provider's site: a browser sends a Lax
    // cookie there but withholds a Strict one (supertest attaches either).
    expect((start.headers['set-cookie'] || []).join(';')).toMatch(/whm\.sid=.*SameSite=Lax/);
    exchangeOk();
    const bad = await agent.get(`/api/auth/external/${name}/callback?code=abc&state=wrong`);
    expect(bad.status).toBe(302);
    expect(bad.headers.location).toBe('/login?error=external_state');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('sends an unknown identity back to the login page, links it while logged in, then logs in with it', async () => {
    exchangeOk();
    const visitor = fresh();
    const start = await visitor.get(`/api/auth/external/${name}/start`);
    const cb = await visitor.get(`/api/auth/external/${name}/callback?code=abc&state=${stateFrom(start.headers.location)}`);
    expect(cb.headers.location).toBe('/login?error=external_not_linked&provider=corp');

    const owner = fresh();
    await loginWith(owner);
    const linkStart = await owner.get(`/api/auth/external/${name}/start?link=1`);
    expect(linkStart.status).toBe(302);
    const linked = await owner.get(`/api/auth/external/${name}/callback?code=abc&state=${stateFrom(linkStart.headers.location)}`);
    expect(linked.headers.location).toBe('/security-center/manage-external-authentications?linked=1');
    expect(app.ctx.security.externalAuth.findLinkedUser(name, 'sub-123')).toBeTruthy();

    const later = fresh();
    const again = await later.get(`/api/auth/external/${name}/start`);
    const done = await later.get(`/api/auth/external/${name}/callback?code=abc&state=${stateFrom(again.headers.location)}`);
    expect(done.headers.location).toBe('/');
    const me = await later.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.username).toBe('root');
    const audit = app.ctx.db.prepare("SELECT target FROM audit_log WHERE action = 'auth.login.external' ORDER BY id DESC LIMIT 1").get();
    expect(audit.target).toBe('root');
  });

  it('still asks for the authenticator code when the linked user has 2FA', async () => {
    exchangeOk();
    const secret = authenticator.generateSecret();
    app.ctx.db.prepare("UPDATE users SET totp_enabled = 1, totp_secret_enc = ? WHERE username = 'root'").run(app.ctx.crypto.encrypt(secret));
    const agent = fresh();
    const start = await agent.get(`/api/auth/external/${name}/start`);
    const cb = await agent.get(`/api/auth/external/${name}/callback?code=abc&state=${stateFrom(start.headers.location)}`);
    expect(cb.headers.location).toBe('/login?stage=2fa');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    const verify = await agent.post('/api/auth/2fa').send({ code: authenticator.generate(secret) });
    expect(verify.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });

  it('requires a login before linking', async () => {
    const res = await request(app.ctx.app).get(`/api/auth/external/${name}/start?link=1`);
    expect(res.status).toBe(401);
  });

  it('refuses to link an identity from an API token, a confined cluster token included', async () => {
    const insert = app.ctx.db.prepare("INSERT INTO api_tokens (user_id, name, token_hash, scopes, prefix) VALUES ((SELECT id FROM users WHERE username = 'root'), ?, ?, ?, ?)");
    const cluster = `whm_${app.ctx.crypto.randomToken(24)}`;
    insert.run('peer', app.ctx.crypto.hashToken(cluster), JSON.stringify(['clustering:dns']), cluster.slice(0, 12));
    const full = `whm_${app.ctx.crypto.randomToken(24)}`;
    insert.run('full', app.ctx.crypto.hashToken(full), '[]', full.slice(0, 12));
    exchangeOk('sub-attacker', 'attacker@example.com');
    for (const token of [cluster, full]) {
      const attacker = fresh();
      const start = await attacker.get(`/api/auth/external/${name}/start?link=1`).set('Authorization', `Bearer ${token}`);
      expect(start.status).toBe(403);
      const cb = await attacker.get(`/api/auth/external/${name}/callback?code=abc&state=anything`).set('Authorization', `Bearer ${token}`);
      expect(cb.headers.location).toBe('/login?error=external_state');
    }
    // A link started in a session cannot be completed by a token for the same user either.
    const owner = fresh();
    await loginWith(owner);
    const linkStart = await owner.get(`/api/auth/external/${name}/start?link=1`);
    expect(linkStart.status).toBe(302);
    const forged = await owner.get(`/api/auth/external/${name}/callback?code=abc&state=${stateFrom(linkStart.headers.location)}`).set('Authorization', `Bearer ${cluster}`);
    expect(forged.headers.location).toBe('/login?error=external_state');
    expect(app.ctx.security.externalAuth.findLinkedUser(name, 'sub-attacker')).toBeFalsy();
    // The token still cannot reach anything outside its scope.
    const me = await request(app.ctx.app).get('/api/auth/me').set('Authorization', `Bearer ${cluster}`);
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('scope_confined');
  });
});
