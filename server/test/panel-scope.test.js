import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { forbidden } from '../src/lib/errors.js';

// Scope resolution, impersonation and the per-request gates of the customer panel.
describe('Customer panel scope', () => {
  let app;
  let csrf;
  let reseller;
  let resellerHttp;
  let resellerCsrf;
  const sessions = {};
  const db = () => app.ctx.db;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', csrf).send(body);
  const rootPut = (p, body = {}) => app.http.put(p).set('X-CSRF-Token', csrf).send(body);
  const rPost = (p, body = {}) => resellerHttp.post(p).set('X-CSRF-Token', resellerCsrf).send(body);
  const setPassword = (username, password) => rootPost(`/api/panel/admin/accounts/${username}/password`, { password }).expect(200);
  async function loginAs(username, password) {
    const http = request.agent(app.ctx.app);
    const res = await http.post('/api/auth/login').send({ username, password });
    if (res.status !== 200) throw new Error(`login ${username}: ${res.status} ${JSON.stringify(res.body)}`);
    const s = { http, csrf: res.body.data.csrfToken, get: (p) => http.get(p), post: (p, body = {}) => http.post(p).set('X-CSRF-Token', res.body.data.csrfToken).send(body), del: (p) => http.delete(p).set('X-CSRF-Token', res.body.data.csrfToken) };
    sessions[username] = s;
    return s;
  }
  const audit = (action, target) => db().prepare('SELECT * FROM audit_log WHERE action = ? AND target = ? ORDER BY id DESC').all(action, target);
  const activeLoginAs = () => db().prepare('SELECT * FROM panel_login_as WHERE ended_at IS NULL').all();

  beforeAll(async () => {
    app = await createTestApp();
    csrf = await app.login();
    reseller = await app.createUser('resell1', 'reseller');
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/accounts', { username: 'bob', domain: 'bob.com', owner: 'resell1', contactEmail: 'bob@bob.com' }).expect(201);
    await rootPost('/api/accounts', { username: 'carol', domain: 'carol.com', owner: 'resell1' }).expect(201);
    await setPassword('alice', 'Alice-Passw0rd!');
    await setPassword('bob', 'Bob-Passw0rd!!');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  describe('resolution', () => {
    it('refuses an admin without an acting-as context and a user without a link', async () => {
      let res = await app.http.get('/api/panel/me').expect(403);
      expect(res.body.error.code).toBe('panel_scope_required');
      res = await resellerHttp.get('/api/panel/me').expect(403);
      expect(res.body.error.code).toBe('panel_scope_required');
      await app.createUser('orphan', 'user', 'Orphan-Passw0rd!');
      const orphan = await loginAs('orphan', 'Orphan-Passw0rd!');
      res = await orphan.get('/api/panel/me').expect(403);
      expect(res.body.error.code).toBe('no_account');
      res = await orphan.get('/api/panel/tokens').expect(403);
      expect(res.body.error.code).toBe('no_account');
    });

    it('pins exactly one account to a user session and exposes the §4.1 shape', async () => {
      const alice = await loginAs('alice', 'Alice-Passw0rd!');
      const res = await alice.get('/api/panel/me').expect(200);
      const d = res.body.data;
      expect(d.user).toMatchObject({ username: 'alice', role: 'user' });
      expect(d.account).toMatchObject({ username: 'alice', domain: 'alice.com', package: 'default', suspended: false, forcePasswordChange: false, demoMode: false });
      expect(d.account.plan.max_addons).toBeDefined();
      expect(d.account.features).toEqual(expect.any(Object));
      expect(d.account.limits).toEqual(expect.any(Object));
      expect(d.usage).toEqual({ diskUsedMb: 0, diskQuotaMb: 10240, bandwidthUsedMb: 0, bandwidthLimitMb: 102400 });
      expect(d.counts).toEqual({ domains: 1, subdomains: 0, addons: 0, parked: 0, mailboxes: 0, forwarders: 0, databases: 0, ftp: 0 });
      expect(d.actingAs).toBeNull();
      expect(d.policy).toMatchObject({ require2fa: false, passwordSynced: true });
      expect(d.hostname).toBeTruthy();
      expect(d.csrfToken).toBe(alice.csrf);
      // Nothing from another account leaks through, whatever the counts tables hold.
      db().prepare("INSERT INTO account_domains (account_id, domain, type) VALUES ((SELECT id FROM accounts WHERE username = 'bob'), 'shop.bob.com', 'sub')").run();
      expect((await alice.get('/api/panel/me').expect(200)).body.data.counts.subdomains).toBe(0);
      const links = await alice.get('/api/panel/overview/quick-links').expect(200);
      expect(links.body.data).toMatchObject({ apps: [], news: [], webmailUrl: '' });
    });

    it('keeps role user out of every WHM router and the panel admin surface', async () => {
      const alice = sessions.alice;
      for (const p of ['/api/accounts', '/api/accounts/alice', '/api/packages', '/api/system/status', '/api/panel/admin/settings', '/api/panel/admin/accounts/alice/user', '/api/panel/admin/login-as/history', '/api/development/tokens', '/api/dns/zones']) {
        const res = await alice.get(p);
        expect(res.status, p).toBe(403);
      }
      expect((await alice.post('/api/panel/admin/login-as/bob')).status).toBe(403);
      expect((await alice.post('/api/accounts/alice/suspend', {})).status).toBe(403);
    });

    it('answers 423 while the account row is suspended', async () => {
      const alice = sessions.alice;
      db().prepare("UPDATE accounts SET suspended = 1 WHERE username = 'alice'").run();
      const res = await alice.get('/api/panel/me').expect(423);
      expect(res.body.error.code).toBe('account_suspended');
      db().prepare("UPDATE accounts SET suspended = 0 WHERE username = 'alice'").run();
      await alice.get('/api/panel/me').expect(200);
    });
  });

  describe('gates (§2.3)', () => {
    it('demo mode refuses every mutation and allows reads', async () => {
      const alice = sessions.alice;
      db().prepare("UPDATE accounts SET demo_mode = 1 WHERE username = 'alice'").run();
      await alice.get('/api/panel/me').expect(200);
      const res = await alice.post('/api/panel/tokens', { name: 'demo' }).expect(403);
      expect(res.body.error.code).toBe('demo_mode');
      db().prepare("UPDATE accounts SET demo_mode = 0 WHERE username = 'alice'").run();
    });

    it('a forced password change leaves only /me and /security/password open', async () => {
      const alice = sessions.alice;
      db().prepare("UPDATE accounts SET force_password_change = 1 WHERE username = 'alice'").run();
      const me = await alice.get('/api/panel/me').expect(200);
      expect(me.body.data.account.forcePasswordChange).toBe(true);
      const res = await alice.get('/api/panel/overview/quick-links').expect(403);
      expect(res.body.error.code).toBe('password_change_required');
      expect((await alice.get('/api/panel/tokens')).body.error.code).toBe('password_change_required');
      db().prepare("UPDATE accounts SET force_password_change = 0 WHERE username = 'alice'").run();
    });

    it('panel.require_2fa_for_users blocks everything but /me until the user enrols', async () => {
      const alice = sessions.alice;
      app.ctx.settings.set('panel.require_2fa_for_users', true);
      const me = await alice.get('/api/panel/me').expect(200);
      expect(me.body.data.policy.require2fa).toBe(true);
      const res = await alice.get('/api/panel/tokens').expect(403);
      expect(res.body.error.code).toBe('two_factor_required');
      db().prepare("UPDATE users SET totp_enabled = 1 WHERE username = 'alice'").run();
      await alice.get('/api/panel/tokens').expect(200);
      db().prepare("UPDATE users SET totp_enabled = 0 WHERE username = 'alice'").run();
      app.ctx.settings.set('panel.require_2fa_for_users', false);
    });

    it('panel.enabled=false closes the panel except the admin settings (§9.16)', async () => {
      const alice = sessions.alice;
      const upd = await rootPut('/api/panel/admin/settings', { enabled: false }).expect(200);
      expect(upd.body.data.enabled).toBe(false);
      expect((await alice.get('/api/panel/me').expect(403)).body.error.code).toBe('panel_disabled');
      expect((await rootPost('/api/panel/admin/login-as/alice').expect(403)).body.error.code).toBe('panel_disabled');
      expect((await app.http.get('/api/panel/admin/accounts/alice/user').expect(403)).body.error.code).toBe('panel_disabled');
      await app.http.get('/api/panel/admin/settings').expect(200);
      await rootPut('/api/panel/admin/settings', { enabled: true }).expect(200);
      await alice.get('/api/panel/me').expect(200);
      expect(audit('panel.settings.update', 'panel')).toHaveLength(2);
    });

    it('validates the admin settings and keeps them root-only', async () => {
      await rootPut('/api/panel/admin/settings', { loginAsTtlMinutes: 1000 }).expect(422);
      await rootPut('/api/panel/admin/settings', { loginAsTtlMinutes: 1 }).expect(422);
      await rootPut('/api/panel/admin/settings', { webmailUrl: 'ftp://mail.example.com' }).expect(422);
      await rootPut('/api/panel/admin/settings', { webmailUrl: 'javascript:alert(1)' }).expect(422);
      await rootPut('/api/panel/admin/settings', {}).expect(422);
      await rootPut('/api/panel/admin/settings', { unknown: true }).expect(422);
      const ok = await rootPut('/api/panel/admin/settings', { loginAsTtlMinutes: 30, webmailUrl: 'https://webmail.example.com/' }).expect(200);
      expect(ok.body.data).toMatchObject({ enabled: true, loginAsTtlMinutes: 30, webmailUrl: 'https://webmail.example.com/', loginAsAcl: 'login-as', uploadChunkBytes: 1310720 });
      await resellerHttp.get('/api/panel/admin/settings').expect(403);
      await resellerHttp.put('/api/panel/admin/settings').set('X-CSRF-Token', resellerCsrf).send({ enabled: false }).expect(403);
      expect(app.ctx.settings.get('panel.enabled')).toBe(true);
    });
  });

  describe('log in as (§2.4)', () => {
    it('root impersonates any account, time-boxed and audited, and sees the acting-as banner data', async () => {
      const res = await rootPost('/api/panel/admin/login-as/alice').expect(200);
      expect(res.body.data).toMatchObject({ account: { username: 'alice', domain: 'alice.com' }, url: '/panel' });
      const ttlMs = new Date(res.body.data.expiresAt).getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(25 * 60_000);
      expect(ttlMs).toBeLessThanOrEqual(30 * 60_000);
      const me = await app.http.get('/api/panel/me').expect(200);
      expect(me.body.data.user.username).toBe('root');
      expect(me.body.data.account.username).toBe('alice');
      expect(me.body.data.actingAs).toMatchObject({ account: 'alice', by: 'root', expiresAt: res.body.data.expiresAt });
      expect(audit('panel.login_as', 'alice')[0]).toMatchObject({ principal: 'root', role: 'root' });
      expect(JSON.parse(audit('panel.login_as', 'alice')[0].args_redacted)).toMatchObject({ target: 'alice' });
      expect(activeLoginAs()).toHaveLength(1);
    });

    it('refuses identity actions while acting and tags panel audit rows with actingAs/by', async () => {
      const res = await rootPost('/api/panel/tokens', { name: 'while-acting' }).expect(403);
      expect(res.body.error.code).toBe('not_while_impersonating');
      const fake = { user: { id: 1, username: 'root', role: 'root' }, session: { panelActingAs: app.http.jar ? undefined : undefined } };
      const entries = [];
      const actingReq = { ...fake, panel: { mode: 'acting', username: 'alice', actor: { username: 'root' } }, audit: (e) => entries.push(e) };
      app.ctx.panel.audit(actingReq, { action: 'panel.test', target: 'alice', args: { object: 'x' } });
      expect(entries[0]).toEqual({ action: 'panel.test', target: 'alice', args: { object: 'x', actingAs: 'alice', by: 'root' } });
      await expect(app.ctx.panel.changePassword(actingReq.panel, { currentPassword: 'x', newPassword: 'Alice-Passw0rd!' }, actingReq)).rejects.toMatchObject({ code: 'not_while_impersonating' });
      expect(() => app.ctx.panel.sessions(actingReq.panel)).toThrow(/not available while logged in/);
    });

    it('a second login-as replaces the first; logout-as ends it and the panel closes again', async () => {
      const first = activeLoginAs()[0];
      await rootPost('/api/panel/admin/login-as/bob').expect(200);
      expect(db().prepare('SELECT ended_at FROM panel_login_as WHERE id = ?').get(first.id).ended_at).toBeTruthy();
      expect((await app.http.get('/api/panel/me').expect(200)).body.data.account.username).toBe('bob');
      const out = await rootPost('/api/panel/admin/logout-as').expect(200);
      expect(out.body.data).toEqual({ ended: true, username: 'bob' });
      expect(activeLoginAs()).toHaveLength(0);
      expect(audit('panel.logout_as', 'bob')).toHaveLength(1);
      expect((await app.http.get('/api/panel/me').expect(403)).body.error.code).toBe('panel_scope_required');
      expect((await rootPost('/api/panel/admin/logout-as').expect(200)).body.data).toEqual({ ended: false });
    });

    it('expiry ends the impersonation on the next request', async () => {
      await rootPost('/api/panel/admin/login-as/alice').expect(200);
      const row = activeLoginAs()[0];
      db().prepare('UPDATE panel_login_as SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), row.id);
      const res = await app.http.get('/api/panel/me').expect(403);
      expect(res.body.error.code).toBe('login_as_ended');
      expect(db().prepare('SELECT ended_at FROM panel_login_as WHERE id = ?').get(row.id).ended_at).toBeTruthy();
      expect(JSON.parse(audit('panel.login_as.ended', 'alice')[0].args_redacted)).toMatchObject({ reason: 'expired', by: 'root' });
      expect((await app.http.get('/api/panel/me').expect(403)).body.error.code).toBe('panel_scope_required');
    });

    it('a reseller may only act as its own accounts, with the login-as ACL, on unsuspended accounts', async () => {
      expect((await rPost('/api/panel/admin/login-as/alice').expect(403)).body.error.code).toBe('forbidden');
      await rPost('/api/panel/admin/login-as/ghost').expect(404);
      await rootPost('/api/accounts/carol/suspend', { reason: 'test' }).expect(200);
      expect((await rPost('/api/panel/admin/login-as/carol').expect(409)).body.error.code).toBe('account_suspended');
      await rootPost('/api/accounts/carol/unsuspend').expect(200);
      // ACL refusal from the resellers service (seam S10) is a 403 for the reseller, never for root.
      const original = app.ctx.resellers.assertAcl;
      app.ctx.resellers.assertAcl = (user, key) => { if (key === 'login-as' && user.role !== 'root') throw forbidden('Your reseller privileges do not include "login-as"'); };
      try {
        const denied = await rPost('/api/panel/admin/login-as/bob').expect(403);
        expect(denied.body.error.code).toBe('forbidden');
        await rootPost('/api/panel/admin/login-as/bob').expect(200);
        await rootPost('/api/panel/admin/logout-as').expect(200);
      } finally { app.ctx.resellers.assertAcl = original; }
      const ok = await rPost('/api/panel/admin/login-as/bob').expect(200);
      expect(ok.body.data.account.username).toBe('bob');
      const me = await resellerHttp.get('/api/panel/me').expect(200);
      expect(me.body.data.actingAs).toMatchObject({ account: 'bob', by: 'resell1' });
    });

    it('lost ownership or a revoked ACL revokes the impersonation mid-session', async () => {
      db().prepare("UPDATE accounts SET owner_id = 1 WHERE username = 'bob'").run();
      const res = await resellerHttp.get('/api/panel/me').expect(403);
      expect(res.body.error.code).toBe('login_as_ended');
      expect(JSON.parse(audit('panel.login_as.ended', 'bob')[0].args_redacted)).toMatchObject({ reason: 'ownership', by: 'resell1' });
      db().prepare("UPDATE accounts SET owner_id = ? WHERE username = 'bob'").run(reseller.id);
      await rPost('/api/panel/admin/login-as/bob').expect(200);
      const original = app.ctx.resellers.assertAcl;
      app.ctx.resellers.assertAcl = (user) => { if (user.role !== 'root') throw forbidden('revoked'); };
      try {
        expect((await resellerHttp.get('/api/panel/me').expect(403)).body.error.code).toBe('login_as_ended');
      } finally { app.ctx.resellers.assertAcl = original; }
      expect(JSON.parse(audit('panel.login_as.ended', 'bob')[0].args_redacted)).toMatchObject({ reason: 'acl' });
      expect(activeLoginAs()).toHaveLength(0);
    });

    it('suspension of the target ends the impersonation', async () => {
      await rootPost('/api/panel/admin/login-as/alice').expect(200);
      await rootPost('/api/accounts/alice/suspend', { reason: 'test' }).expect(200);
      expect((await app.http.get('/api/panel/me').expect(403)).body.error.code).toBe('login_as_ended');
      await rootPost('/api/accounts/alice/unsuspend').expect(200);
      await setPassword('alice', 'Alice-Passw0rd!');
    });

    it('history lists everything for root and only its own rows for a reseller', async () => {
      const all = await app.http.get('/api/panel/admin/login-as/history').expect(200);
      expect(all.body.meta.total).toBeGreaterThanOrEqual(6);
      expect(new Set(all.body.data.map((r) => r.actor))).toEqual(new Set(['root', 'resell1']));
      expect(all.body.data.every((r) => r.active === false)).toBe(true);
      const own = await resellerHttp.get('/api/panel/admin/login-as/history').expect(200);
      expect(own.body.data.length).toBeGreaterThan(0);
      expect(own.body.data.every((r) => r.actor === 'resell1')).toBe(true);
      await app.http.get('/api/panel/admin/login-as/history?page=0').expect(422);
    });

    it('a browser session is required: an admin API token cannot start an impersonation', async () => {
      const token = app.ctx.crypto.randomToken(32);
      db().prepare("INSERT INTO api_tokens (user_id, name, token_hash, scopes) VALUES (1, 'admin', ?, '[]')").run(app.ctx.crypto.hashToken(token));
      const res = await request(app.ctx.app).post('/api/panel/admin/login-as/alice').set('Authorization', `Bearer ${token}`).expect(403);
      expect(res.body.error.message).toMatch(/browser session/);
      expect(activeLoginAs()).toHaveLength(0);
    });
  });

  describe('API tokens (§3.4)', () => {
    let token;
    it('issues panel-scoped tokens to the account user only', async () => {
      const alice = await loginAs('alice', 'Alice-Passw0rd!');
      const bad = await alice.post('/api/panel/tokens', { name: 'whm', scopes: ['development:read'] }).expect(422);
      expect(Object.keys(bad.body.error.fields)).toEqual(['scopes.0']);
      await alice.post('/api/panel/tokens', { name: 'whm', scopes: ['*'] }).expect(422);
      await alice.post('/api/panel/tokens', { name: 'x', expiresAt: '2000-01-01T00:00:00Z' }).expect(422);
      await alice.post('/api/panel/tokens', { name: 'x', scopes: [], extra: 1 }).expect(422);
      const res = await alice.post('/api/panel/tokens', { name: 'reader', scopes: ['panel:read', 'panel:files'] }).expect(201);
      expect(res.body.data).toMatchObject({ name: 'reader', scopes: ['panel:read', 'panel:files'], expiresAt: null });
      expect(res.body.data.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      token = res.body.data.token;
      const stored = db().prepare('SELECT * FROM api_tokens WHERE id = ?').get(res.body.data.id);
      expect(stored.token_hash).toBe(app.ctx.crypto.hashToken(token));
      expect(stored.user_id).toBe(db().prepare("SELECT id FROM users WHERE username = 'alice'").get().id);
      expect(JSON.parse(audit('panel.token.create', 'alice')[0].args_redacted)).toMatchObject({ name: 'reader' });
      const list = await alice.get('/api/panel/tokens').expect(200);
      expect(list.body.data.map((t) => t.name)).toEqual(['reader']);
      expect(list.body.data[0].token).toBeUndefined();
      // Defaults to panel:read when no scope is given.
      const dflt = await alice.post('/api/panel/tokens', { name: 'default' }).expect(201);
      expect(dflt.body.data.scopes).toEqual(['panel:read']);
    });

    it('a panel token reaches the panel as the account and nothing else', async () => {
      const bearer = (p) => request(app.ctx.app).get(p).set('Authorization', `Bearer ${token}`);
      const me = await bearer('/api/panel/me').expect(200);
      expect(me.body.data.account.username).toBe('alice');
      expect(me.body.data.csrfToken).toBeNull();
      await bearer('/api/auth/me').expect(200);
      for (const p of ['/api/accounts', '/api/development/tokens', '/api/panel/admin/settings', '/api/system/status']) expect((await bearer(p)).status, p).toBe(403);
      const mint = await request(app.ctx.app).post('/api/panel/tokens').set('Authorization', `Bearer ${token}`).send({ name: 'chain' }).expect(403);
      expect(mint.body.error.message).toMatch(/browser session/);
    });

    it('honours apiTokensRequire2fa and the api feature, and only the owner can revoke', async () => {
      const alice = sessions.alice;
      const bob = await loginAs('bob', 'Bob-Passw0rd!!');
      const mine = (await alice.get('/api/panel/tokens').expect(200)).body.data.filter((t) => t.name === 'reader');
      await bob.del(`/api/panel/tokens/${mine[0].id}`).expect(404);
      await bob.get(`/api/panel/tokens/${mine[0].id}`).expect(404);
      expect((await bob.get('/api/panel/tokens').expect(200)).body.data).toEqual([]);
      const policy = app.ctx.auth.policy;
      app.ctx.auth.policy = () => ({ ...policy(), apiTokensRequire2fa: true });
      try {
        expect((await bob.post('/api/panel/tokens', { name: 'needs2fa' }).expect(403)).body.error.code).toBe('two_factor_required');
      } finally { app.ctx.auth.policy = policy; }
      const acct = db().prepare("SELECT plan_snapshot_json FROM accounts WHERE username = 'bob'").get();
      const plan = JSON.parse(acct.plan_snapshot_json);
      db().prepare("UPDATE accounts SET plan_snapshot_json = ? WHERE username = 'bob'").run(JSON.stringify({ ...plan, features: { ...(plan.features || {}), api: false } }));
      expect((await bob.post('/api/panel/tokens', { name: 'noapi' }).expect(403)).body.error.code).toBe('feature_disabled');
      db().prepare("UPDATE accounts SET plan_snapshot_json = ? WHERE username = 'bob'").run(acct.plan_snapshot_json);
      const gone = await alice.del(`/api/panel/tokens/${mine[0].id}`).expect(200);
      expect(gone.body.data).toEqual({ id: mine[0].id, deleted: true });
      await request(app.ctx.app).get('/api/panel/me').set('Authorization', `Bearer ${token}`).expect(401);
      expect(audit('panel.token.revoke', 'alice')).toHaveLength(1);
    });
  });

  describe('scope() service contract (§3.1)', () => {
    it('returns the documented shape with the owner as delegation principal', async () => {
      const bobUser = db().prepare("SELECT * FROM users WHERE username = 'bob'").get();
      const s = app.ctx.panel.scope({ user: bobUser, session: null, auth: { via: 'session' } });
      expect(Object.keys(s).sort()).toEqual(['account', 'accountId', 'actingAs', 'actor', 'features', 'limits', 'mode', 'owner', 'ownerPrincipal', 'username']);
      expect(s).toMatchObject({ username: 'bob', mode: 'user', actingAs: null, ownerPrincipal: { id: reseller.id, username: 'resell1', role: 'reseller' } });
      expect(s.account.plan).toEqual(expect.any(Object));
      expect(s.actor).toBe(bobUser);
      expect(s.accountId).toBe(s.account.id);
      // A session-less admin principal never resolves a scope.
      expect(() => app.ctx.panel.scope({ user: { id: 1, username: 'root', role: 'root' }, session: {}, auth: { via: 'session' } })).toThrow(expect.objectContaining({ code: 'panel_scope_required' }));
      expect(() => app.ctx.panel.scope({ user: null })).toThrow(expect.objectContaining({ status: 401 }));
      // A forged acting-as pointer at another actor's record is refused.
      const row = db().prepare('SELECT id FROM panel_login_as ORDER BY id DESC LIMIT 1').get();
      const forged = { user: { id: reseller.id, username: 'resell1', role: 'reseller' }, session: { panelActingAs: { id: row.id, accountId: 1, username: 'alice' } }, auth: { via: 'session' }, audit() {} };
      expect(() => app.ctx.panel.scope(forged)).toThrow(expect.objectContaining({ code: 'login_as_ended' }));
      expect(forged.session.panelActingAs).toBeUndefined();
    });
  });
});
