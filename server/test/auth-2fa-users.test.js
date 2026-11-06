import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { createTestApp } from './support/app.js';

// Forced 2FA for account users as a core login policy (P3-3, contract §66):
// security.2fa.required_for_users flags the session like the root/reseller
// switches, and the panel's own check honours either switch.
const CORE = 'security.2fa.required_for_users';
const PANEL = 'panel.require_2fa_for_users';
const PASSWORD = 'Panel-Passw0rd!1';

async function panelLogin(app, username) {
  const http = request.agent(app.ctx.app);
  const res = await http.post('/api/auth/login').send({ username, password: PASSWORD });
  if (res.status !== 200) throw new Error(`panel login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  return {
    http, csrf, login: res.body.data,
    get: (p) => http.get(`/api/panel${p}`),
    post: (p, body = {}) => http.post(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    put: (p, body = {}) => http.put(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
  };
}

describe('Forced 2FA for account users as a core policy (P3-3)', () => {
  let app;
  let csrf;
  const db = () => app.ctx.db;
  const setCore = (v) => app.http.put('/api/system/settings').set('X-CSRF-Token', csrf).send({ [CORE]: v }).expect(200);
  const clearTotp = (username) => db().prepare('UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0 WHERE username = ?').run(username);

  beforeAll(async () => {
    app = await createTestApp();
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.com', ip: '203.0.113.7' }).expect(201);
    db().prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(await app.ctx.crypto.hashPassword(PASSWORD), 'carol');
  }, 60_000);
  afterAll(async () => {
    app.ctx.settings.setMany({ [CORE]: false, [PANEL]: false });
    await app.close();
  });

  it('is seeded off and readable through the security settings prefix', async () => {
    expect(app.ctx.settings.get(CORE)).toBe(false);
    expect(app.ctx.auth.policy().require2faForUsers).toBe(false);
    const res = await app.http.get('/api/system/settings?prefix=security.2fa.').expect(200);
    expect(res.body.data).toMatchObject({ 'security.2fa.required_for_root': false, [CORE]: false });
  });

  it('a role-user login without an authenticator is not flagged while both switches are off', async () => {
    const carol = await panelLogin(app, 'carol');
    expect(carol.login.mustEnroll2fa).toBe(false);
    const me = await carol.get('/me').expect(200);
    expect(me.body.data.mustEnroll2fa).toBe(false);
    expect(me.body.data.policy.require2fa).toBe(false);
    await carol.get('/domains').expect(200);
  });

  it('turning the core switch on catches an existing session: /me reports mustEnroll2fa, the panel gates everything but the enrolment routes', async () => {
    const carol = await panelLogin(app, 'carol');
    await setCore(true);
    expect(app.ctx.auth.policy().require2faForUsers).toBe(true);
    const me = await carol.get('/me').expect(200);
    expect(me.body.data.mustEnroll2fa).toBe(true);
    expect(me.body.data.policy.require2fa).toBe(true);
    const tf = await carol.get('/security/two-factor').expect(200);
    expect(tf.body.data).toMatchObject({ enabled: false, required: true });
    const blocked = await carol.get('/domains');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('two_factor_required');
    // The core password seam reaches the same check.
    const core = await carol.http.post('/api/auth/password').set('X-CSRF-Token', carol.csrf).send({ currentPassword: PASSWORD, newPassword: 'Yet-An0ther-Str0ng!pw2' });
    expect(core.status).toBe(403);
    expect(core.body.error.code).toBe('two_factor_required');
  });

  it('assertTwoFactor honours the core switch with the panel switch off, and the panel switch alone still works', () => {
    const user = db().prepare("SELECT * FROM users WHERE username = 'carol'").get();
    app.ctx.settings.setMany({ [CORE]: true, [PANEL]: false });
    expect(() => app.ctx.panel.assertTwoFactor(user)).toThrow(expect.objectContaining({ code: 'two_factor_required' }));
    expect(() => app.ctx.panel.assertTwoFactor(user, '/me')).not.toThrow();
    expect(() => app.ctx.panel.assertTwoFactor(user, '/security/two-factor/enroll')).not.toThrow();
    expect(() => app.ctx.panel.assertTwoFactor({ ...user, totp_enabled: 1 })).not.toThrow();
    app.ctx.settings.setMany({ [CORE]: false, [PANEL]: true });
    expect(() => app.ctx.panel.assertTwoFactor(user)).toThrow(expect.objectContaining({ code: 'two_factor_required' }));
    app.ctx.settings.setMany({ [CORE]: false, [PANEL]: false });
    expect(() => app.ctx.panel.assertTwoFactor(user)).not.toThrow();
  });

  it('a fresh login is flagged exactly like root: the session gate opens only /auth/*, /api/panel/me and the panel two-factor routes, and enrolment lifts it', async () => {
    await setCore(true);
    const carol = await panelLogin(app, 'carol');
    expect(carol.login.mustEnroll2fa).toBe(true);
    expect((await carol.http.get('/api/auth/me').expect(200)).body.data.mustEnroll2fa).toBe(true);
    expect((await carol.get('/me').expect(200)).body.data.mustEnroll2fa).toBe(true);
    await carol.get('/security/two-factor').expect(200);
    const blocked = await carol.get('/domains');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('two_factor_required');
    const enroll = await carol.post('/security/two-factor/enroll').expect(200);
    const confirm = await carol.post('/security/two-factor/confirm', { code: authenticator.generate(enroll.body.data.secret) });
    expect(confirm.status).toBe(200);
    expect((await carol.http.get('/api/auth/me').expect(200)).body.data.mustEnroll2fa).toBe(false);
    expect((await carol.get('/me').expect(200)).body.data.mustEnroll2fa).toBe(false);
    await carol.get('/domains').expect(200);
    // Disabling is refused while the policy stands, on both the panel and the core route.
    const panelOff = await carol.post('/security/two-factor/disable', { password: PASSWORD });
    expect(panelOff.status).toBe(403);
    const coreOff = await carol.http.post('/api/auth/2fa/disable').set('X-CSRF-Token', carol.csrf).send({ password: PASSWORD });
    expect(coreOff.status).toBe(403);
    clearTotp('carol');
  });

  it('the admin side states the core switch: panel settings, the 2FA reset answer and the Security Advisor line', async () => {
    await setCore(true);
    const settings = await app.http.get('/api/panel/admin/settings').expect(200);
    expect(settings.body.data).toMatchObject({ require2faForUsers: false, coreRequire2faForUsers: true });
    const reset = await app.http.post('/api/panel/admin/accounts/carol/2fa/reset').set('X-CSRF-Token', csrf).expect(200);
    expect(reset.body.data.enrollmentRequired).toBe(true);
    const findings = (await app.ctx.security.advisor.scan('test')).findings;
    expect(findings.find((f) => f.id === 'panel.2fa.policy')).toMatchObject({ grade: 'ok', title: expect.stringContaining('two-factor required') });
  });

  it('turning the core switch off lifts the gate for the next login', async () => {
    await setCore(false);
    expect(app.ctx.auth.policy().require2faForUsers).toBe(false);
    const carol = await panelLogin(app, 'carol');
    expect(carol.login.mustEnroll2fa).toBe(false);
    expect((await carol.get('/me').expect(200)).body.data.mustEnroll2fa).toBe(false);
    await carol.get('/domains').expect(200);
    expect((await app.http.get('/api/panel/admin/settings').expect(200)).body.data.coreRequire2faForUsers).toBe(false);
  });

  it('never flags administrators or resellers through the users switch', async () => {
    await setCore(true);
    const root = request.agent(app.ctx.app);
    const res = await root.post('/api/auth/login').send({ username: 'root', password: 'Test-Passw0rd!1' });
    expect(res.status).toBe(200);
    expect(res.body.data.mustEnroll2fa).toBe(false);
    await setCore(false);
  });
});
