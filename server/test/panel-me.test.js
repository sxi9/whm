import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createTestApp } from './support/app.js';

const migration = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations', '034d_panel-preferences.sql');

async function panelLogin(app, username, password = 'Panel-Passw0rd!1') {
  const hash = await app.ctx.crypto.hashPassword(password);
  app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  const http = request.agent(app.ctx.app);
  const res = await http.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`panel login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  return {
    http, csrf,
    get: (p) => http.get(`/api/panel${p}`),
    put: (p, body = {}) => http.put(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    post: (p, body = {}) => http.post(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
  };
}

describe('Customer panel: preferences and the 2FA policy (P1-8, P1-9)', () => {
  let app;
  let csrf;
  let alice;
  const db = () => app.ctx.db;
  const row = (sql, ...args) => db().prepare(sql).get(...args);
  const audits = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
  const sent = [];

  beforeAll(async () => {
    app = await createTestApp();
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com', ip: '203.0.113.5' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6' }).expect(201);
    app.ctx.contacts = { ...app.ctx.contacts, sendMail: async (msg) => { sent.push(msg); return { queued: true }; } };
    alice = await panelLogin(app, 'alice');
  });
  afterAll(() => app.close());
  beforeEach(() => { sent.length = 0; });

  it('migration 034d re-runs its table statement and adds users.locale', () => {
    const sql = fs.readFileSync(migration, 'utf8');
    expect(() => db().exec(sql.split('\n').filter((l) => !/^ALTER TABLE/.test(l)).join('\n'))).not.toThrow();
    expect(db().prepare('PRAGMA table_info(users)').all().map((c) => c.name)).toContain('locale');
    expect(db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'panel_account_prefs'").get()).toBeTruthy();
  });

  it('GET /me carries the preferences block with defaults and the enabled locales', async () => {
    const me = await alice.get('/me').expect(200);
    expect(me.body.data.preferences).toMatchObject({ email: 'alice@alice.com', email2: null, notify: { quota: true, bandwidth: true, passwordChange: true }, locale: null, defaultLocale: 'en' });
    expect(me.body.data.preferences.locales).toEqual(expect.arrayContaining([{ code: 'en', name: 'English' }]));
    expect(me.body.data.user.locale).toBeNull();
  });

  it('PUT /me/contact needs the current password: missing is 422 with the field, wrong is 401, nothing changes', async () => {
    const missing = await alice.put('/me/contact', { email: 'thief@example.net' });
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields).toHaveProperty('currentPassword');
    const wrong = await alice.put('/me/contact', { email: 'thief@example.net', currentPassword: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(row('SELECT contact_email FROM accounts WHERE username = ?', 'alice').contact_email).toBe('alice@alice.com');
    expect(audits('panel.me.contact')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('PUT /me/contact writes accounts.contact_email, mirrors users.email, stores the switches, audits and tells the previous address', async () => {
    const res = await alice.put('/me/contact', { email: 'owner@example.org', email2: 'backup@example.org', notify: { quota: false }, currentPassword: 'Panel-Passw0rd!1' }).expect(200);
    expect(res.body.data).toMatchObject({ email: 'owner@example.org', email2: 'backup@example.org', notify: { quota: false, bandwidth: true, passwordChange: true } });
    expect(row('SELECT contact_email FROM accounts WHERE username = ?', 'alice').contact_email).toBe('owner@example.org');
    expect(row('SELECT email FROM users WHERE username = ?', 'alice').email).toBe('owner@example.org');
    expect(row('SELECT * FROM panel_account_prefs WHERE account_id = (SELECT id FROM accounts WHERE username = ?)', 'alice')).toMatchObject({ email2: 'backup@example.org', notify_quota: 0, notify_bandwidth: 1, notify_password_change: 1 });
    const a = audits('panel.me.contact');
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0].args_redacted)).toMatchObject({ email: 'owner@example.org', previousEmail: 'alice@alice.com', notify: { quota: false } });
    expect(a[0].args_redacted).not.toContain('Panel-Passw0rd!1');
    // The address that stopped being the recovery address is told, detached.
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'alice@alice.com', subject: '[Keel] Contact address changed for alice' });
    expect(sent[0].body).toContain('owner@example.org');
    // Switches not mentioned keep their value; an empty second address clears it; an unchanged address sends no notice.
    const again = await alice.put('/me/contact', { email: 'owner@example.org', email2: '', notify: { passwordChange: false }, currentPassword: 'Panel-Passw0rd!1' }).expect(200);
    expect(again.body.data).toMatchObject({ email2: null, notify: { quota: false, bandwidth: true, passwordChange: false } });
    expect(sent).toHaveLength(1);
    expect(app.ctx.panel.preferences.notifyFor('alice')).toEqual({ to: ['owner@example.org'], notify: { quota: false, bandwidth: true, passwordChange: false } });
    expect(app.ctx.panel.preferences.notifyFor('nobody')).toBeNull();
  });

  it('refuses malformed contact bodies and tokens', async () => {
    for (const body of [{}, { email: 'not-an-address' }, { email: 'a@b.co', email2: 'nope' }, { email: 'a@b.co', notify: { quota: 'yes' } }, { email: 'a@b.co', notify: { other: true } }, { email: 'a@b.co', extra: 1 }, { email: 'a@b.co', currentPassword: '' }]) {
      const res = await alice.put('/me/contact', { currentPassword: 'Panel-Passw0rd!1', ...body });
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    const token = await alice.post('/tokens', { name: 'script', scopes: ['panel:read'] }).expect(201);
    const viaToken = await request(app.ctx.app).put('/api/panel/me/contact').set('Authorization', `Bearer ${token.body.data.token}`).send({ email: 'x@y.co', currentPassword: 'Panel-Passw0rd!1' });
    expect(viaToken.status).toBe(403);
    expect(viaToken.body.error.code).toBe('session_required');
    expect(row('SELECT contact_email FROM accounts WHERE username = ?', 'alice').contact_email).toBe('owner@example.org');
  });

  it('PUT /me/locale stores an enabled locale on the login, refuses unknown ones and clears with null', async () => {
    const bad = await alice.put('/me/locale', { locale: 'xx' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields).toHaveProperty('locale');
    expect((await alice.put('/me/locale', { locale: 'Bad Code' })).status).toBe(422);
    const ok = await alice.put('/me/locale', { locale: 'en' }).expect(200);
    expect(ok.body.data.locale).toBe('en');
    expect(row('SELECT locale FROM users WHERE username = ?', 'alice').locale).toBe('en');
    expect((await alice.get('/me').expect(200)).body.data.user.locale).toBe('en');
    expect(audits('panel.me.locale')).toHaveLength(1);
    const cleared = await alice.put('/me/locale', { locale: null }).expect(200);
    expect(cleared.body.data.locale).toBeNull();
    expect(row('SELECT locale FROM users WHERE username = ?', 'alice').locale).toBeNull();
  });

  it('never writes the administrator\'s locale while logged in as the account; the contact address is still the account\'s', async () => {
    await app.http.post('/api/panel/admin/login-as/alice').set('X-CSRF-Token', csrf).expect(200);
    try {
      const locale = await app.http.put('/api/panel/me/locale').set('X-CSRF-Token', csrf).send({ locale: 'en' });
      expect(locale.status).toBe(403);
      expect(locale.body.error.code).toBe('not_while_impersonating');
      expect(row("SELECT locale FROM users WHERE username = 'root'").locale).toBeNull();
      // No account password while acting: the administrator authenticated to the console already.
      const contact = await app.http.put('/api/panel/me/contact').set('X-CSRF-Token', csrf).send({ email: 'admin-set@example.org' }).expect(200);
      expect(contact.body.data.email).toBe('admin-set@example.org');
      const a = audits('panel.me.contact').at(-1);
      expect(JSON.parse(a.args_redacted)).toMatchObject({ actingAs: 'alice', by: 'root' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sent.map((m) => m.to)).toEqual(['owner@example.org']);
    } finally {
      await app.http.post('/api/panel/admin/logout-as').set('X-CSRF-Token', csrf).expect(200);
    }
  });

  it('mails the contact addresses after a password change only when the switch is on', async () => {
    await alice.put('/me/contact', { email: 'owner@example.org', email2: 'backup@example.org', notify: { passwordChange: true }, currentPassword: 'Panel-Passw0rd!1' }).expect(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.map((m) => m.to)).toEqual(['admin-set@example.org']);
    sent.length = 0;
    await alice.post('/security/password', { currentPassword: 'Panel-Passw0rd!1', newPassword: 'An0ther-Str0ng!pw' }).expect(200);
    expect(sent.map((m) => m.to).sort()).toEqual(['backup@example.org', 'owner@example.org']);
    expect(sent[0].subject).toMatch(/Password changed for alice/);
    alice = await panelLogin(app, 'alice');
    await alice.put('/me/contact', { email: 'owner@example.org', notify: { passwordChange: false }, currentPassword: 'Panel-Passw0rd!1' }).expect(200);
    await alice.post('/security/password', { currentPassword: 'Panel-Passw0rd!1', newPassword: 'Yet-An0ther-Str0ng!pw' }).expect(200);
    expect(sent).toHaveLength(2);
    alice = await panelLogin(app, 'alice');
  });

  describe('the panel 2FA policy lives in the service', () => {
    afterAll(() => app.ctx.settings.set('panel.require_2fa_for_users', false));

    it('assertTwoFactor is the one check: /me and the enrolment routes stay open, everything else answers two_factor_required', async () => {
      app.ctx.settings.set('panel.require_2fa_for_users', true);
      const user = row("SELECT * FROM users WHERE username = 'alice'");
      expect(() => app.ctx.panel.assertTwoFactor(user, '/me')).not.toThrow();
      expect(() => app.ctx.panel.assertTwoFactor(user, '/security/two-factor/enroll')).not.toThrow();
      expect(() => app.ctx.panel.assertTwoFactor(user, '/me/contact')).toThrow(expect.objectContaining({ code: 'two_factor_required' }));
      expect(() => app.ctx.panel.assertTwoFactor(user)).toThrow(expect.objectContaining({ code: 'two_factor_required' }));
      expect(() => app.ctx.panel.assertTwoFactor({ ...user, totp_enabled: 1 })).not.toThrow();
      expect(() => app.ctx.panel.assertTwoFactor({ ...user, role: 'reseller' })).not.toThrow();
      await alice.get('/me').expect(200);
      await alice.get('/security/two-factor').expect(200);
      const blocked = await alice.put('/me/contact', { email: 'owner@example.org', currentPassword: 'Panel-Passw0rd!1' });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('two_factor_required');
      // The core password route reaches the same check through the seam.
      const core = await alice.http.post('/api/auth/password').set('X-CSRF-Token', alice.csrf).send({ currentPassword: 'Panel-Passw0rd!1', newPassword: 'Yet-An0ther-Str0ng!pw2' });
      expect(core.status).toBe(403);
      expect(core.body.error.code).toBe('two_factor_required');
      app.ctx.settings.set('panel.require_2fa_for_users', false);
      await alice.put('/me/contact', { email: 'owner@example.org', currentPassword: 'Panel-Passw0rd!1' }).expect(200);
    });

    it('the admin settings answer how many linked logins have no authenticator', async () => {
      const res = await app.http.get('/api/panel/admin/settings').expect(200);
      expect(res.body.data).toMatchObject({ linkedUsers: 2, usersWithoutTotp: 2 });
      db().prepare("UPDATE users SET totp_enabled = 1 WHERE username = 'bob'").run();
      expect((await app.http.get('/api/panel/admin/settings').expect(200)).body.data).toMatchObject({ linkedUsers: 2, usersWithoutTotp: 1 });
      db().prepare("UPDATE users SET totp_enabled = 0 WHERE username = 'bob'").run();
    });

    it('Security Advisor lists the account-panel policy line', async () => {
      app.ctx.settings.set('panel.require_2fa_for_users', false);
      let findings = (await app.ctx.security.advisor.scan('test')).findings;
      let line = findings.find((f) => f.id === 'panel.2fa.policy');
      expect(line).toMatchObject({ grade: 'info', title: 'Account panel users: two-factor optional (2 linked users without an authenticator)' });
      app.ctx.settings.set('panel.require_2fa_for_users', true);
      findings = (await app.ctx.security.advisor.scan('test')).findings;
      line = findings.find((f) => f.id === 'panel.2fa.policy');
      expect(line).toMatchObject({ grade: 'ok', title: 'Account panel users: two-factor required (2 linked users without an authenticator)' });
    });
  });
});
