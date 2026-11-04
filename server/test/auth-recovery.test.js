import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { RESET_TOKEN_TTL_MS } from '../src/services/panel.js';

const migration = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations', '034_panel-recovery.sql');
const TOKEN_RE = /\/login\/reset\/([A-Za-z0-9_-]+)/;

// Mail leaves through ctx.contacts.sendMail; the test app has neither Exim nor
// a relay, so the transport is replaced by a recorder.
function captureMail(app) {
  const mails = [];
  app.ctx.contacts = { ...app.ctx.contacts, sendMail: async (msg) => { mails.push(msg); return { accepted: true, transport: 'test' }; } };
  return mails;
}

// Session-less mutations carry the CSRF token of a fresh cookie session. The
// 202 of a reset request arrives before the token and mail work (detached in
// recovery.request), so `requestReset` waits for that work before returning.
async function publicClient(app) {
  const http = request.agent(app.ctx.app);
  const { body } = await http.get('/api/auth/csrf').expect(200);
  const csrf = body.data.csrfToken;
  const post = (p, data) => http.post(p).set('X-CSRF-Token', csrf).send(data);
  const requestReset = async (data, status = 202) => {
    const res = await post('/api/auth/reset/request', data).expect(status);
    await app.ctx.panel.recovery.pending();
    return res;
  };
  return { http, post, requestReset };
}

describe('Forgot-password for account users', () => {
  let app;
  let root;
  let mails;
  const db = () => app.ctx.db;
  const auditRows = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
  const tokensFor = (username) => db().prepare('SELECT t.* FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE u.username = ? ORDER BY t.id').all(username);

  beforeAll(async () => {
    // Wide enough for every request and confirm below; the limit itself is tested apart.
    app = await createTestApp({ overrides: { loginRateLimit: { windowMs: 15 * 60_000, max: 200 } } });
    const csrf = await app.login();
    root = { post: (p, body = {}) => app.http.post(p).set('X-CSRF-Token', csrf).send(body), put: (p, body) => app.http.put(p).set('X-CSRF-Token', csrf).send(body) };
    mails = captureMail(app);
    await root.post('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'Alice@Example.com' }).expect(201);
    await root.post('/api/accounts', { username: 'bob', domain: 'bob.com' }).expect(201);
    await root.post('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!' }).expect(200);
  });
  afterAll(() => app.close());
  beforeEach(() => { mails.length = 0; app.agent.calls.length = 0; });

  it('migration 034 is idempotent', () => {
    const sql = fs.readFileSync(migration, 'utf8');
    expect(() => db().exec(sql)).not.toThrow();
    expect(() => db().exec(sql)).not.toThrow();
    expect(db().prepare("SELECT 1 FROM sqlite_master WHERE name = 'password_reset_tokens'").get()).toBeTruthy();
  });

  it('is announced to the login page only while the panel is on and mail can leave', async () => {
    expect((await app.http.get('/api/auth/reset').expect(200)).body.data).toEqual({ enabled: true });
    await root.put('/api/panel/admin/settings', { enabled: false }).expect(200);
    expect((await app.http.get('/api/auth/reset').expect(200)).body.data).toEqual({ enabled: false });
    await root.put('/api/panel/admin/settings', { enabled: true }).expect(200);
    const transport = app.ctx.contacts;
    app.ctx.contacts = { ...transport, sendMail: undefined };
    expect((await app.http.get('/api/auth/reset').expect(200)).body.data).toEqual({ enabled: false });
    app.ctx.contacts = transport;
  });

  it('answers 202 for unknown logins, administrators and accounts without a contact address, and sends nothing', async () => {
    const c = await publicClient(app);
    await c.requestReset({ username: 'nobody' });
    await c.requestReset({ username: 'root' });
    await c.requestReset({ username: 'bob' });
    await c.requestReset({ email: 'stranger@example.com' });
    expect(mails).toHaveLength(0);
    expect(db().prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get().n).toBe(0);
    const rows = auditRows('auth.reset.request');
    expect(rows.map((r) => [r.target, r.result])).toEqual([['nobody', 'skipped'], ['root', 'skipped'], ['bob', 'skipped'], ['stranger@example.com', 'skipped']]);
    expect(JSON.parse(rows[2].args_redacted)).toMatchObject({ via: 'username', sent: false, reason: 'not_eligible' });
    await c.post('/api/auth/reset/request', {}).expect(422);
    await c.post('/api/auth/reset/request', { username: 'alice', email: 'alice@example.com' }).expect(422);
    await c.post('/api/auth/reset/request', { username: 'alice', extra: 1 }).expect(422);
    // No CSRF token, no session: refused like every other mutation.
    await request.agent(app.ctx.app).post('/api/auth/reset/request').send({ username: 'alice' }).expect(403);
  });

  it('mails a single-use link to the contact address and the confirm writes both stores and ends sessions', async () => {
    const alice = request.agent(app.ctx.app);
    await alice.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' }).expect(200);
    await alice.get('/api/panel/me').expect(200);

    const c = await publicClient(app);
    await c.requestReset({ email: 'alice@example.com' });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('Alice@Example.com');
    expect(mails[0].subject).toContain('alice');
    const token = mails[0].body.match(TOKEN_RE)?.[1];
    expect(token).toBeTruthy();
    expect(mails[0].body).toMatch(/https?:\/\/[^/\s]+\/login\/reset\//);
    const stored = tokensFor('alice');
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).toBe(app.ctx.crypto.hashToken(token));
    expect(stored[0].token_hash).not.toBe(token);
    expect(stored[0].used_at).toBeNull();
    expect(new Date(stored[0].expires_at).getTime() - Date.now()).toBeLessThanOrEqual(RESET_TOKEN_TTL_MS);
    const requested = auditRows('auth.reset.request').at(-1);
    expect(requested.result).toBe('ok');
    expect(JSON.parse(requested.args_redacted)).toMatchObject({ via: 'email', sent: true, users: ['alice'] });
    expect(JSON.stringify(auditRows('auth.reset.request')) + JSON.stringify(auditRows('contacts.mail.send'))).not.toContain(token);

    await c.post('/api/auth/reset/confirm', { token, password: 'weak' }).expect(422);
    const ok = await c.post('/api/auth/reset/confirm', { token, password: 'Alice-Reset-Passw0rd!' }).expect(200);
    expect(ok.body.data).toEqual({ username: 'alice', changed: true });
    expect(app.agent.callsTo('user.set_password')).toHaveLength(1);
    expect(app.agent.callsTo('user.set_password')[0].args).toMatchObject({ username: 'alice', password: 'Alice-Reset-Passw0rd!' });
    const link = db().prepare('SELECT au.password_synced_at FROM account_users au JOIN users u ON u.id = au.user_id WHERE u.username = ?').get('alice');
    expect(link.password_synced_at).toBeTruthy();
    expect(tokensFor('alice')[0].used_at).toBeTruthy();
    const confirmed = auditRows('auth.reset.confirm');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].target).toBe('alice');
    expect(JSON.stringify(confirmed)).not.toContain(token);

    // Every session of the login is gone; the new password works, the old one does not.
    await alice.get('/api/panel/me').expect(401);
    await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' }).expect(401);
    await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'alice', password: 'Alice-Reset-Passw0rd!' }).expect(200);

    // Single use.
    const again = await c.post('/api/auth/reset/confirm', { token, password: 'Alice-Other-Passw0rd!' }).expect(400);
    expect(again.body.error.code).toBe('reset_token_invalid');
    expect(app.agent.callsTo('user.set_password')).toHaveLength(1);
  });

  it('answers 202 before the mail transport finishes, for a real login as for an unknown one', async () => {
    const c = await publicClient(app);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const transport = app.ctx.contacts;
    let started = 0;
    app.ctx.contacts = { ...transport, sendMail: async (msg) => { started++; await gate; mails.push(msg); return { accepted: true, transport: 'test' }; } };
    try {
      await c.post('/api/auth/reset/request', { username: 'alice' }).expect(202);
      // The response is back while the transport is still blocked: no token or mail work sits in front of it.
      expect(started).toBe(1);
      expect(mails).toHaveLength(0);
      expect(auditRows('auth.reset.request').at(-1)?.target).not.toBe('alice');
      release();
      await app.ctx.panel.recovery.pending();
      expect(mails).toHaveLength(1);
      expect(JSON.parse(auditRows('auth.reset.request').at(-1).args_redacted)).toMatchObject({ sent: true, users: ['alice'] });
    } finally { app.ctx.contacts = transport; }
  });

  it('keeps the earlier link working and does not count the attempt when the mail cannot leave', async () => {
    const c = await publicClient(app);
    db().prepare('DELETE FROM password_reset_tokens').run();
    await c.requestReset({ username: 'alice' });
    const first = mails[0].body.match(TOKEN_RE)[1];
    const transport = app.ctx.contacts;
    app.ctx.contacts = { ...transport, sendMail: async () => { throw new Error('relay down'); } };
    try {
      await c.requestReset({ username: 'alice' });
      await c.requestReset({ username: 'alice' });
    } finally { app.ctx.contacts = transport; }
    expect(JSON.parse(auditRows('auth.reset.request').at(-1).args_redacted)).toMatchObject({ sent: false, reason: 'mail_failed' });
    // Only the delivered link is stored, still unused; the two failed attempts left no rows behind.
    const rows = tokensFor('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(app.ctx.crypto.hashToken(first));
    expect(rows[0].used_at).toBeNull();
    // Not throttled: the failed attempts did not count, so a third delivered link is still allowed.
    await c.requestReset({ username: 'alice' });
    await c.requestReset({ username: 'alice' });
    expect(mails).toHaveLength(3);
    expect(JSON.parse(auditRows('auth.reset.request').at(-1).args_redacted)).toMatchObject({ sent: true });
    await c.post('/api/auth/reset/confirm', { token: mails[2].body.match(TOKEN_RE)[1], password: 'Alice-Fifth-Passw0rd!' }).expect(200);
    db().prepare('DELETE FROM password_reset_tokens').run();
  });

  it('expired tokens, voided tokens and malformed ones are refused', async () => {
    const c = await publicClient(app);
    await c.requestReset({ username: 'alice' });
    const first = mails[0].body.match(TOKEN_RE)[1];
    await c.requestReset({ username: 'alice' });
    const second = mails[1].body.match(TOKEN_RE)[1];
    // The newer request voided the earlier link.
    expect((await c.post('/api/auth/reset/confirm', { token: first, password: 'Alice-Third-Passw0rd!' }).expect(400)).body.error.code).toBe('reset_token_invalid');
    db().prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 1000).toISOString(), app.ctx.crypto.hashToken(second));
    expect((await c.post('/api/auth/reset/confirm', { token: second, password: 'Alice-Third-Passw0rd!' }).expect(400)).body.error.code).toBe('reset_token_invalid');
    await c.post('/api/auth/reset/confirm', { token: 'short', password: 'Alice-Third-Passw0rd!' }).expect(422);
    await c.post('/api/auth/reset/confirm', { token: 'x'.repeat(43), password: 'Alice-Third-Passw0rd!' }).expect(400);
    expect(app.agent.callsTo('user.set_password')).toHaveLength(0);
  });

  it('skips the mail for a suspended login, a disabled panel and after three requests in an hour', async () => {
    const c = await publicClient(app);
    // Two links were issued for alice within the hour by the test above; the third is the last allowed.
    await c.requestReset({ username: 'alice' });
    expect(mails).toHaveLength(1);
    await c.requestReset({ username: 'alice' });
    expect(mails).toHaveLength(1);
    expect(JSON.parse(auditRows('auth.reset.request').at(-1).args_redacted)).toMatchObject({ sent: false, reason: 'throttled' });
    db().prepare('DELETE FROM password_reset_tokens').run();
    mails.length = 0;

    await root.post('/api/accounts/alice/suspend', { reason: 'test' }).expect(200);
    await c.requestReset({ username: 'alice' });
    expect(mails).toHaveLength(0);
    expect(JSON.parse(auditRows('auth.reset.request').at(-1).args_redacted)).toMatchObject({ sent: false, reason: 'not_eligible' });
    await root.post('/api/accounts/alice/unsuspend').expect(200);

    await root.put('/api/panel/admin/settings', { enabled: false }).expect(200);
    await c.requestReset({ username: 'alice' });
    expect(mails).toHaveLength(0);
    expect(JSON.parse(auditRows('auth.reset.request').at(-1).args_redacted)).toMatchObject({ sent: false, reason: 'panel_disabled' });
    await root.put('/api/panel/admin/settings', { enabled: true }).expect(200);

    // A reset is a lockout path: the 2FA-required policy does not block it.
    await root.put('/api/panel/admin/settings', { require2faForUsers: true }).expect(200);
    await c.requestReset({ username: 'alice' });
    expect(mails).toHaveLength(1);
    const token = mails[0].body.match(TOKEN_RE)[1];
    await c.post('/api/auth/reset/confirm', { token, password: 'Alice-Fourth-Passw0rd!' }).expect(200);
    await root.put('/api/panel/admin/settings', { require2faForUsers: false }).expect(200);
  });
});

describe('Forgot-password rate limit', () => {
  let app;
  beforeAll(async () => { app = await createTestApp({ overrides: { loginRateLimit: { windowMs: 60_000, max: 3 } } }); });
  afterAll(() => app.close());

  it('shares the login limiter settings per address across request and confirm', async () => {
    const c = await publicClient(app);
    await c.post('/api/auth/reset/request', { username: 'nobody' }).expect(202);
    await c.post('/api/auth/reset/request', { username: 'nobody' }).expect(202);
    await c.post('/api/auth/reset/confirm', { token: 'y'.repeat(43), password: 'Some-Passw0rd!!' }).expect(400);
    const limited = await c.post('/api/auth/reset/request', { username: 'nobody' }).expect(429);
    expect(limited.body.error.code).toBe('rate_limited');
    await c.post('/api/auth/reset/confirm', { token: 'y'.repeat(43), password: 'Some-Passw0rd!!' }).expect(429);
  });
});
