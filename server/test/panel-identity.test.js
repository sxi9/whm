import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createTestApp } from './support/app.js';

const migration = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations', '033_panel.sql');

describe('Customer panel identity', () => {
  let app;
  let csrf;
  const db = () => app.ctx.db;
  const root = {
    post: (p, body = {}) => app.http.post(p).set('X-CSRF-Token', csrf).send(body),
    del: (p) => app.http.delete(p).set('X-CSRF-Token', csrf),
    get: (p) => app.http.get(p),
  };
  const link = (username) => db().prepare('SELECT au.* FROM account_users au JOIN users u ON u.id = au.user_id WHERE u.username = ?').get(username);
  const userRow = (username) => db().prepare('SELECT * FROM users WHERE username = ?').get(username);
  const auditRows = (action, target) => db().prepare('SELECT * FROM audit_log WHERE action = ? AND target = ?').all(action, target);

  beforeAll(async () => {
    app = await createTestApp();
    csrf = await app.login();
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('migration 033 is idempotent and seeds the panel settings', () => {
    const sql = fs.readFileSync(migration, 'utf8');
    expect(() => db().exec(sql)).not.toThrow();
    expect(() => db().exec(sql)).not.toThrow();
    expect(app.ctx.settings.get('panel.enabled')).toBe(true);
    expect(app.ctx.settings.get('panel.login_as_ttl_minutes')).toBe(60);
    expect(app.ctx.settings.get('panel.login_as_acl')).toBe('login-as');
    expect(app.ctx.settings.get('panel.upload_chunk_bytes')).toBe(1310720);
    const keys = db().prepare("SELECT key FROM settings WHERE key LIKE 'panel.%'").all().map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['panel.enabled', 'panel.require_2fa_for_users', 'panel.login_as_ttl_minutes', 'panel.login_as_acl', 'panel.webmail_url', 'panel.upload_chunk_bytes']));
  });

  it('account.created links a role-user login with no password yet', async () => {
    await root.post('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    const user = userRow('alice');
    expect(user).toMatchObject({ role: 'user', email: 'alice@alice.com', password_hash: null, suspended: 0 });
    const row = link('alice');
    expect(row.account_id).toBe(db().prepare('SELECT id FROM accounts WHERE username = ?').get('alice').id);
    expect(row.password_synced_at).toBeNull();
    expect(auditRows('panel.user.create', 'alice')).toHaveLength(1);
    // Nothing can log in against a NULL hash.
    const res = await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'alice', password: 'anything-at-all' });
    expect(res.status).toBe(401);
    await root.post('/api/accounts', { username: 'bob', domain: 'bob.com', contactEmail: 'bob@bob.com' }).expect(201);
    expect(link('bob')).toBeTruthy();
  });

  it('ensureUser is idempotent and the backfill links accounts created without the event', async () => {
    const again = app.ctx.panel.ensureUser('alice', null);
    expect(again).toMatchObject({ created: false, adopted: false, linked: true });
    expect(db().prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'alice'").get().n).toBe(1);
    db().prepare("INSERT INTO accounts (username, domain, owner_id, package_name, contact_email, home_dir) VALUES ('legacy', 'legacy.com', 1, 'default', 'legacy@legacy.com', '/home/legacy')").run();
    expect(userRow('legacy')).toBeUndefined();
    const result = app.ctx.panel.backfill();
    expect(result).toMatchObject({ created: 1, adopted: 0 });
    expect(userRow('legacy')).toMatchObject({ role: 'user', email: 'legacy@legacy.com', password_hash: null });
    expect(link('legacy')).toBeTruthy();
    expect(app.ctx.panel.backfill()).toMatchObject({ created: 0, adopted: 0 });
  });

  it('the boot backfill adopts a demoted reseller row with the account username, keeping its login', async () => {
    const hash = await app.ctx.crypto.hashPassword('Demoted-Passw0rd!');
    db().prepare("INSERT INTO users (username, role, password_hash, email) VALUES ('dave', 'user', ?, 'dave@dave.com')").run(hash);
    db().prepare("INSERT INTO accounts (username, domain, owner_id, package_name, home_dir) VALUES ('dave', 'dave.com', 1, 'default', '/home/dave')").run();
    // A demoted reseller whose row was suspended at reset time stays suspended after adoption.
    db().prepare("INSERT INTO users (username, role, password_hash, suspended) VALUES ('dora', 'user', ?, 1)").run(hash);
    db().prepare("INSERT INTO accounts (username, domain, owner_id, package_name, home_dir) VALUES ('dora', 'dora.com', 1, 'default', '/home/dora')").run();
    expect(app.ctx.panel.backfill()).toMatchObject({ created: 0, adopted: 2 });
    expect(link('dave')).toMatchObject({ user_id: userRow('dave').id });
    expect(db().prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'dave'").get().n).toBe(1);
    expect(JSON.parse(auditRows('panel.user.adopt', 'dave')[0].args_redacted)).toMatchObject({ credentialsKept: true, by: 'boot' });
    expect(userRow('dave').password_hash).toBe(hash);
    expect(userRow('dora')).toMatchObject({ suspended: 1, password_hash: hash });
    // The adopted login keeps its password and can open the panel.
    const http = request.agent(app.ctx.app);
    await http.post('/api/auth/login').send({ username: 'dave', password: 'Demoted-Passw0rd!' }).expect(200);
    const me = await http.get('/api/panel/me').expect(200);
    expect(me.body.data.account.username).toBe('dave');
    await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'dora', password: 'Demoted-Passw0rd!' }).expect(401);
  });

  it('never links an administrator login that shares the account username', async () => {
    const reseller = await app.createUser('resell1', 'reseller');
    await root.post('/api/accounts', { username: 'resell1', domain: 'resell1.com', owner: 'resell1' }).expect(201);
    expect(userRow('resell1')).toMatchObject({ id: reseller.id, role: 'reseller' });
    expect(link('resell1')).toBeUndefined();
    expect(app.ctx.panel.ensureUser('resell1', null)).toMatchObject({ linked: false, reason: 'username_is_admin' });
    await root.post('/api/panel/admin/accounts/resell1/user').expect(409);
    await root.post('/api/panel/admin/accounts/nobody/user').expect(404);
  });

  it('the admin password endpoint writes the host first and then the panel hash', async () => {
    const res = await root.post('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!' }).expect(200);
    expect(res.body.data).toEqual({ username: 'alice', synced: true });
    const op = app.agent.callsTo('user.set_password');
    expect(op).toHaveLength(1);
    expect(op[0].args).toEqual({ username: 'alice', password: 'Alice-Passw0rd!' });
    const user = userRow('alice');
    expect(user.password_hash).toMatch(/^\$2[aby]\$/);
    expect(user.password_changed_at).toBeTruthy();
    expect(link('alice').password_synced_at).toBeTruthy();
    expect(auditRows('panel.password.admin_set', 'alice')).toHaveLength(1);
    expect(auditRows('account.password', 'alice')).toHaveLength(1);
    await root.post('/api/panel/admin/accounts/alice/password', { password: 'short' }).expect(422);
    await root.post('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!', extra: 1 }).expect(422);
  });

  it('login as the account user works once a password is synced', async () => {
    const http = request.agent(app.ctx.app);
    const res = await http.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ username: 'alice', role: 'user' });
    const me = await http.get('/api/panel/me').expect(200);
    expect(me.body.data.account).toMatchObject({ username: 'alice', domain: 'alice.com', package: 'default', suspended: false });
    expect(me.body.data.policy.passwordSynced).toBe(true);
    expect(me.body.data.actingAs).toBeNull();
  });

  it('a refused termination by a foreign reseller never touches the account user\'s sessions', async () => {
    const alice = request.agent(app.ctx.app);
    await alice.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' }).expect(200);
    const aliceId = userRow('alice').id;
    const before = db().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(aliceId).n;
    expect(before).toBeGreaterThan(0);
    const r = request.agent(app.ctx.app);
    const login = await r.post('/api/auth/login').send({ username: 'resell1', password: 'Test-Passw0rd!1' }).expect(200);
    for (let i = 0; i < 3; i++) {
      const res = await r.delete('/api/accounts/alice').set('X-CSRF-Token', login.body.data.csrfToken).expect(403);
      expect(res.body.error.code).toBe('forbidden');
    }
    expect(app.agent.callsTo('user.delete')).toHaveLength(0);
    expect(db().prepare('SELECT COUNT(*) AS n FROM accounts WHERE username = ?').get('alice').n).toBe(1);
    expect(db().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(aliceId).n).toBe(before);
    expect((await alice.get('/api/panel/me').expect(200)).body.data.account.username).toBe('alice');
  });

  it('adoption on account creation strips an orphan login\'s credentials and never un-suspends it', async () => {
    const hash = await app.ctx.crypto.hashPassword('Old-Passw0rd!!');
    const secret = app.ctx.crypto.encrypt('JBSWY3DPEHPK3PXP');
    db().prepare("INSERT INTO users (username, role, password_hash, totp_secret_enc, totp_enabled, suspended) VALUES ('victim', 'user', ?, ?, 1, 0)").run(hash, secret);
    db().prepare("INSERT INTO users (username, role, password_hash, suspended) VALUES ('sleeper', 'user', ?, 1)").run(hash);
    db().prepare("INSERT INTO sessions (sid, user_id, data, expires_at) VALUES ('victim-sid', (SELECT id FROM users WHERE username = 'victim'), '{}', ?)").run(Date.now() + 3_600_000);
    const r = request.agent(app.ctx.app);
    const login = await r.post('/api/auth/login').send({ username: 'resell1', password: 'Test-Passw0rd!1' }).expect(200);
    const rPost = (p, body) => r.post(p).set('X-CSRF-Token', login.body.data.csrfToken).send(body);
    await rPost('/api/accounts', { username: 'victim', domain: 'victim.com' }).expect(201);
    await rPost('/api/accounts', { username: 'sleeper', domain: 'sleeper.com' }).expect(201);
    expect(link('victim')).toBeTruthy();
    expect(userRow('victim')).toMatchObject({ role: 'user', password_hash: null, totp_secret_enc: null, totp_enabled: 0, suspended: 0 });
    expect(userRow('sleeper')).toMatchObject({ password_hash: null, suspended: 1 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM sessions WHERE sid = 'victim-sid'").get().n).toBe(0);
    expect(JSON.parse(auditRows('panel.user.adopt', 'victim')[0].args_redacted)).toMatchObject({ credentialsKept: false, by: 'resell1' });
    await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'victim', password: 'Old-Passw0rd!!' }).expect(401);
    await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'sleeper', password: 'Old-Passw0rd!!' }).expect(401);
    // The owner sets a password through the admin endpoint; the suspended login stays suspended until the account itself is unsuspended.
    await rPost('/api/panel/admin/accounts/sleeper/password', { password: 'Sleeper-Passw0rd!' }).expect(200);
    expect(userRow('sleeper').suspended).toBe(1);
    await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'sleeper', password: 'Sleeper-Passw0rd!' }).expect(401);
  });

  it('adoption through the admin endpoint replaces the credentials and aligns suspension with the account', async () => {
    const hash = await app.ctx.crypto.hashPassword('Frank-Old-Passw0rd!');
    db().prepare("INSERT INTO users (username, role, password_hash, suspended) VALUES ('frank', 'user', ?, 1)").run(hash);
    db().prepare("INSERT INTO accounts (username, domain, owner_id, package_name, home_dir, uid, gid) VALUES ('frank', 'frank.com', 1, 'default', '/home/frank', 30011, 30011)").run();
    const res = await root.post('/api/panel/admin/accounts/frank/user', { password: 'Frank-Passw0rd!!' }).expect(201);
    expect(res.body.data).toMatchObject({ adopted: true, linked: true, passwordSynced: true, credentialsKept: false });
    expect(userRow('frank').suspended).toBe(0);
    expect(JSON.parse(auditRows('panel.user.adopt', 'frank')[0].args_redacted)).toMatchObject({ credentialsKept: false, by: 'root' });
    await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'frank', password: 'Frank-Old-Passw0rd!' }).expect(401);
    await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'frank', password: 'Frank-Passw0rd!!' }).expect(200);
  });

  it('syncPassword only writes the hash (the caller already set the Linux side)', async () => {
    const before = userRow('bob');
    expect(before.password_hash).toBeNull();
    const r = await app.ctx.panel.syncPassword('bob', 'Bob-Passw0rd!!');
    expect(r).toMatchObject({ synced: true, userId: before.id });
    expect(app.agent.callsTo('user.set_password')).toHaveLength(0);
    expect(userRow('bob').password_hash).toMatch(/^\$2[aby]\$/);
    expect(link('bob').password_synced_at).toBeTruthy();
    expect(await app.ctx.crypto.verifyPassword('Bob-Passw0rd!!', userRow('bob').password_hash)).toBe(true);
    await expect(app.ctx.panel.syncPassword('ghost', 'Ghost-Passw0rd!')).rejects.toMatchObject({ status: 404 });
    expect(await app.ctx.panel.syncPassword('resell1', 'Resell-Passw0rd!')).toMatchObject({ synced: false, reason: 'username_is_admin' });
  });

  it('reports link status and creates the user on demand with an optional password', async () => {
    const status = await root.get('/api/panel/admin/accounts/bob/user').expect(200);
    expect(status.body.data).toMatchObject({ username: 'bob', linked: true, passwordSet: true, totpEnabled: false, warnings: [] });
    db().prepare("INSERT INTO accounts (username, domain, owner_id, package_name, home_dir, uid, gid) VALUES ('erin', 'erin.com', 1, 'default', '/home/erin', 30010, 30010)").run();
    const unlinked = await root.get('/api/panel/admin/accounts/erin/user').expect(200);
    expect(unlinked.body.data).toMatchObject({ linked: false, passwordSet: false, userId: null });
    const created = await root.post('/api/panel/admin/accounts/erin/user', { password: 'Erin-Passw0rd!!' }).expect(201);
    expect(created.body.data).toMatchObject({ created: true, linked: true, passwordSynced: true });
    expect(app.agent.callsTo('user.set_password').map((c) => c.args.username)).toEqual(['erin']);
    const after = await root.get('/api/panel/admin/accounts/erin/user').expect(200);
    expect(after.body.data).toMatchObject({ linked: true, passwordSet: true, warnings: [] });
    // A second call without a password is a no-op that reports the existing link.
    const again = await root.post('/api/panel/admin/accounts/erin/user').expect(201);
    expect(again.body.data).toMatchObject({ created: false, linked: true, passwordSynced: false });
    // A link whose hash was never synced is flagged for the WHM page.
    expect((await root.get('/api/panel/admin/accounts/legacy/user').expect(200)).body.data.warnings).toEqual(['password_not_synced', 'no_password']);
  });

  it('suspension flips the login row and destroys its sessions; unsuspension restores it', async () => {
    const http = request.agent(app.ctx.app);
    await http.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' }).expect(200);
    await http.get('/api/panel/me').expect(200);
    await root.post('/api/accounts/alice/suspend', { reason: 'nonpayment' }).expect(200);
    expect(userRow('alice').suspended).toBe(1);
    expect(db().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userRow('alice').id).n).toBe(0);
    await http.get('/api/panel/me').expect(401);
    const login = await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' });
    expect(login.status).toBe(401);
    await root.post('/api/accounts/alice/unsuspend').expect(200);
    expect(userRow('alice').suspended).toBe(0);
    await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' }).expect(200);
  });

  it('termination removes the link, the login row and its sessions', async () => {
    const http = request.agent(app.ctx.app);
    await http.post('/api/auth/login').send({ username: 'bob', password: 'Bob-Passw0rd!!' }).expect(200);
    const bobId = userRow('bob').id;
    await root.del('/api/accounts/bob').expect(200);
    expect(db().prepare('SELECT COUNT(*) AS n FROM accounts WHERE username = ?').get('bob').n).toBe(0);
    expect(db().prepare('SELECT COUNT(*) AS n FROM account_users WHERE user_id = ?').get(bobId).n).toBe(0);
    expect(userRow('bob')).toBeUndefined();
    expect(db().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(bobId).n).toBe(0);
    expect(auditRows('panel.user.remove', 'bob')).toHaveLength(1);
    await http.get('/api/panel/me').expect(401);
  });

  describe('panel-side password change (§2.2)', () => {
    const fakeReq = (user, extra = {}) => {
      const entries = [];
      return { user, ip: '127.0.0.1', auth: { via: 'session' }, session: null, audit: (e) => entries.push(e), entries, ...extra };
    };

    it('verifies the current password, writes the host first, both stores, and logs out everywhere', async () => {
      const user = userRow('alice');
      const http = request.agent(app.ctx.app);
      await http.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' }).expect(200);
      const req = fakeReq(user);
      const scope = app.ctx.panel.scope(req);
      expect(scope).toMatchObject({ username: 'alice', mode: 'user', actingAs: null, ownerPrincipal: { username: 'root', role: 'root' } });
      await expect(app.ctx.panel.changePassword(scope, { currentPassword: 'wrong-password', newPassword: 'Alice-NewPassw0rd!' }, req)).rejects.toMatchObject({ status: 401 });
      expect(app.agent.callsTo('user.set_password')).toHaveLength(0);
      const r = await app.ctx.panel.changePassword(scope, { currentPassword: 'Alice-Passw0rd!', newPassword: 'Alice-NewPassw0rd!' }, req);
      expect(r).toMatchObject({ changed: true, host: { applied: true } });
      expect(app.agent.callsTo('user.set_password')[0].args).toEqual({ username: 'alice', password: 'Alice-NewPassw0rd!' });
      expect(await app.ctx.crypto.verifyPassword('Alice-NewPassw0rd!', userRow('alice').password_hash)).toBe(true);
      expect(link('alice').password_synced_at).toBeTruthy();
      expect(db().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id).n).toBe(0);
      expect(req.entries.find((e) => e.action === 'panel.password.change')).toMatchObject({ target: 'alice', args: { host: { applied: true } } });
      await http.get('/api/panel/me').expect(401);
      await request.agent(app.ctx.app).post('/api/auth/login').send({ username: 'alice', password: 'Alice-NewPassw0rd!' }).expect(200);
    });

    it('changePasswordForUser runs the same flow for core\'s forced-change path and ignores non-account logins', async () => {
      const user = userRow('alice');
      db().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(user.id);
      const req = fakeReq({ ...user, must_change_password: 1 });
      // `force` only counts when the row really is flagged, and never for another login.
      await expect(app.ctx.panel.changePasswordForUser(user.id, { currentPassword: 'wrong', newPassword: 'Alice-Forced-Passw0rd!', force: false }, req)).rejects.toMatchObject({ status: 401 });
      const r = await app.ctx.panel.changePasswordForUser(user.id, { newPassword: 'Alice-Forced-Passw0rd!', force: true }, req);
      expect(r).toMatchObject({ changed: true, host: { applied: true } });
      expect(app.agent.callsTo('user.set_password').map((c) => c.args)).toEqual([{ username: 'alice', password: 'Alice-Forced-Passw0rd!' }]);
      expect(userRow('alice').must_change_password).toBe(0);
      expect(await app.ctx.crypto.verifyPassword('Alice-Forced-Passw0rd!', userRow('alice').password_hash)).toBe(true);
      expect(link('alice').password_synced_at).toBeTruthy();
      expect(req.entries.find((e) => e.action === 'panel.password.change')).toMatchObject({ target: 'alice', args: { forced: true } });
      await expect(app.ctx.panel.changePasswordForUser(user.id, { newPassword: 'Alice-NewPassw0rd!', force: true }, req)).rejects.toMatchObject({ status: 401 });
      expect(await app.ctx.panel.changePasswordForUser(1, { newPassword: 'Root-Passw0rd!!!', force: true }, req)).toBeNull();
      expect(app.ctx.panel.linkForUser(1)).toBeNull();
      await app.ctx.panel.changePasswordForUser(user.id, { currentPassword: 'Alice-Forced-Passw0rd!', newPassword: 'Alice-NewPassw0rd!' }, req);
    });

    // Integrator seam (routes/auth.js is shared): POST /api/auth/password must delegate to
    // ctx.panel.changePasswordForUser for a linked login, otherwise the forced-change path
    // rotates only users.password_hash and the Linux password keeps the old value.
    it.todo('POST /api/auth/password with must_change_password=1 writes both stores for an account user');

    it('clears the account-level forced change and refuses a weak password when the policy says so', async () => {
      db().prepare("UPDATE accounts SET force_password_change = 1 WHERE username = 'alice'").run();
      const req = fakeReq(userRow('alice'));
      const scope = app.ctx.panel.scope(req);
      expect(scope.account.force_password_change).toBe(true);
      const original = app.ctx.security?.passwordStrength;
      if (app.ctx.security) app.ctx.security.passwordStrength = (pw) => ({ score: pw.length, minimum: 100, ok: false });
      try {
        await expect(app.ctx.panel.changePassword(scope, { currentPassword: 'Alice-NewPassw0rd!', newPassword: 'Alice-Weak-Passw0rd' }, req)).rejects.toMatchObject({ status: 422 });
      } finally { if (app.ctx.security) app.ctx.security.passwordStrength = original; }
      await app.ctx.panel.changePassword(scope, { currentPassword: 'Alice-NewPassw0rd!', newPassword: 'Alice-Passw0rd!' }, req);
      expect(db().prepare("SELECT force_password_change FROM accounts WHERE username = 'alice'").get().force_password_change).toBe(0);
    });
  });
});
