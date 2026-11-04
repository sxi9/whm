import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { createTestApp } from './support/app.js';

// Console-side recovery for account logins: POST /api/panel/admin/accounts/:username/2fa/reset.
describe('Panel admin: 2FA reset', () => {
  let app;
  let root;
  const db = () => app.ctx.db;
  const userRow = (username) => db().prepare('SELECT * FROM users WHERE username = ?').get(username);
  const auditRows = (action, target) => db().prepare('SELECT * FROM audit_log WHERE action = ? AND target = ? ORDER BY id').all(action, target);

  async function enrol(agent, csrf) {
    const { body } = await agent.post('/api/auth/2fa/enroll').set('X-CSRF-Token', csrf).send({}).expect(200);
    await agent.post('/api/auth/2fa/confirm').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(body.data.secret) }).expect(200);
    return body.data.secret;
  }

  beforeAll(async () => {
    app = await createTestApp();
    const csrf = await app.login();
    root = { post: (p, body = {}) => app.http.post(p).set('X-CSRF-Token', csrf).send(body), get: (p) => app.http.get(p) };
    await root.post('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await root.post('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!' }).expect(200);
    await root.post('/api/accounts', { username: 'carol', domain: 'carol.com' }).expect(201);
  });
  afterAll(() => app.close());

  it('clears the authenticator of the account login, ends its sessions and audits panel.admin.2fa.reset', async () => {
    const alice = request.agent(app.ctx.app);
    const login = await alice.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' }).expect(200);
    const secret = await enrol(alice, login.body.data.csrfToken);
    expect(userRow('alice').totp_enabled).toBe(1);
    expect((await root.get('/api/panel/admin/accounts/alice/user').expect(200)).body.data.totpEnabled).toBe(true);
    // The second factor is now asked at login.
    const pending = await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' }).expect(200);
    expect(pending.body.data.requires2fa).toBe(true);

    const res = await root.post('/api/panel/admin/accounts/alice/2fa/reset').expect(200);
    expect(res.body.data).toEqual({ username: 'alice', totpEnabled: false, wasEnabled: true, enrollmentRequired: false });
    const row = userRow('alice');
    expect(row.totp_enabled).toBe(0);
    expect(row.totp_secret_enc).toBeNull();
    expect(row.password_hash).toBeTruthy();
    await alice.get('/api/panel/me').expect(401);
    const rows = auditRows('panel.admin.2fa.reset', 'alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].principal).toBe('root');
    expect(JSON.parse(rows[0].args_redacted)).toMatchObject({ userId: row.id, wasEnabled: true });
    expect(JSON.stringify(rows)).not.toContain(secret);

    // Password alone signs in again; the stale code is worthless.
    const back = await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' }).expect(200);
    expect(back.body.data.requires2fa).toBeUndefined();
    expect(back.body.data.user.totpEnabled).toBe(false);

    // Idempotent, and it says so.
    expect((await root.post('/api/panel/admin/accounts/alice/2fa/reset').expect(200)).body.data.wasEnabled).toBe(false);
  });

  it('reports the panel 2FA policy so the console can say the customer must enrol again', async () => {
    const csrf = (await app.http.get('/api/auth/csrf')).body.data.csrfToken;
    await app.http.put('/api/panel/admin/settings').set('X-CSRF-Token', csrf).send({ require2faForUsers: true }).expect(200);
    expect((await root.post('/api/panel/admin/accounts/alice/2fa/reset').expect(200)).body.data.enrollmentRequired).toBe(true);
    await app.http.put('/api/panel/admin/settings').set('X-CSRF-Token', csrf).send({ require2faForUsers: false }).expect(200);
  });

  it('is refused for unknown accounts, foreign resellers and account users; a reseller may reset its own accounts', async () => {
    await root.post('/api/panel/admin/accounts/nobody/2fa/reset').expect(404);
    await root.post('/api/panel/admin/accounts/carol/2fa/reset').expect(200);

    const reseller = await app.createUser('resell1', 'reseller');
    const r = request.agent(app.ctx.app);
    const rl = await r.post('/api/auth/login').send({ username: 'resell1', password: reseller.password }).expect(200);
    const rPost = (p) => r.post(p).set('X-CSRF-Token', rl.body.data.csrfToken).send({});
    await rPost('/api/panel/admin/accounts/alice/2fa/reset').expect(403);
    await root.post('/api/accounts', { username: 'dave', domain: 'dave.com', owner: 'resell1' }).expect(201);
    expect((await rPost('/api/panel/admin/accounts/dave/2fa/reset').expect(200)).body.data.username).toBe('dave');
    expect(auditRows('panel.admin.2fa.reset', 'dave')[0].principal).toBe('resell1');

    const alice = request.agent(app.ctx.app);
    const al = await alice.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' }).expect(200);
    await alice.post('/api/panel/admin/accounts/alice/2fa/reset').set('X-CSRF-Token', al.body.data.csrfToken).send({}).expect(403);
  });
});
