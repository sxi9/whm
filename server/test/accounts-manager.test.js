import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from './support/app.js';
import { migrate } from '../src/db/index.js';

// accounts.manager_user_id: who manages an account for support (U7).
describe('account manager assignment', () => {
  let app;
  let csrf;
  let resellerHttp;
  let resellerCsrf;

  beforeAll(async () => {
    app = await createTestApp();
    csrf = await app.login();
    await app.createUser('resell1', 'reseller');
    await app.createUser('resell2', 'reseller');
    await app.createUser('joe', 'user');
    resellerHttp = app.http;
    // A second cookie jar for the reseller session.
    const { default: request } = await import('supertest');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: 'Test-Passw0rd!1' });
    expect(res.status).toBe(200);
    resellerCsrf = res.body.data.csrfToken;
  });
  afterAll(() => app.close());

  it('defaults the manager to the creator and records it in the audit row', async () => {
    const res = await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.example' }).expect(201);
    expect(res.body.data.manager).toBe('root');
    expect(res.body.data.manager_role).toBe('root');
    const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.create' AND target = 'alice'").get();
    expect(JSON.parse(audit.args_redacted).manager).toBe(1);
  });

  it('root may assign any root or reseller user; users and unknown names are rejected', async () => {
    const res = await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.example', owner: 'resell1', manager: 'resell2' }).expect(201);
    expect(res.body.data).toMatchObject({ owner: 'resell1', manager: 'resell2', manager_role: 'reseller' });
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.example', manager: 'joe' }).expect(404);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.example', manager: 'nobody-here' }).expect(404);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.example', manager: 'Bad Name' }).expect(422);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE username = 'carol'").get().n).toBe(0);
  });

  it('a reseller may name itself or root, never another reseller', async () => {
    await resellerHttp.post('/api/accounts').set('X-CSRF-Token', resellerCsrf).send({ username: 'dave', domain: 'dave.example', manager: 'resell2' }).expect(403);
    const own = await resellerHttp.post('/api/accounts').set('X-CSRF-Token', resellerCsrf).send({ username: 'dave', domain: 'dave.example' }).expect(201);
    expect(own.body.data).toMatchObject({ owner: 'resell1', manager: 'resell1' });
    const toRoot = await resellerHttp.post('/api/accounts').set('X-CSRF-Token', resellerCsrf).send({ username: 'erin', domain: 'erin.example', manager: 'root' }).expect(201);
    expect(toRoot.body.data.manager).toBe('root');
  });

  it('modify changes or clears the manager with the same rules', async () => {
    const changed = await app.http.patch('/api/accounts/alice').set('X-CSRF-Token', csrf).send({ manager: 'resell1' }).expect(200);
    expect(changed.body.data.manager).toBe('resell1');
    await app.http.patch('/api/accounts/alice').set('X-CSRF-Token', csrf).send({ manager: 'joe' }).expect(404);
    await resellerHttp.patch('/api/accounts/dave').set('X-CSRF-Token', resellerCsrf).send({ manager: 'resell2' }).expect(403);
    const cleared = await app.http.patch('/api/accounts/alice').set('X-CSRF-Token', csrf).send({ manager: null }).expect(200);
    expect(cleared.body.data.manager).toBeNull();
    expect(cleared.body.data.manager_user_id).toBeNull();
    const back = await app.http.patch('/api/accounts/alice').set('X-CSRF-Token', csrf).send({ manager: 'resell1' }).expect(200);
    expect(back.body.data.manager).toBe('resell1');
  });

  it('lists carry the manager, filter and sort by it', async () => {
    const all = await app.http.get('/api/accounts?sort=manager&dir=asc').expect(200);
    expect(all.body.data.map((a) => [a.username, a.manager])).toEqual(expect.arrayContaining([['alice', 'resell1'], ['bob', 'resell2'], ['dave', 'resell1'], ['erin', 'root']]));
    const filtered = await app.http.get('/api/accounts?manager=resell1').expect(200);
    expect(filtered.body.data.map((a) => a.username).sort()).toEqual(['alice', 'dave']);
    expect(filtered.body.meta.total).toBe(2);
    const searched = await app.http.get('/api/accounts?q=resell2').expect(200);
    expect(searched.body.data.map((a) => a.username)).toEqual(['bob']);
    const detail = await app.http.get('/api/accounts/bob').expect(200);
    expect(detail.body.data).toMatchObject({ manager: 'resell2', manager_role: 'reseller' });
  });

  it('offers the manager candidates the caller may pick', async () => {
    const root = await app.http.get('/api/accounts/managers').expect(200);
    expect(root.body.data.map((m) => m.username)).toEqual(['root', 'resell1', 'resell2']);
    expect(root.body.data[0]).toMatchObject({ role: 'root' });
    const reseller = await resellerHttp.get('/api/accounts/managers').expect(200);
    expect(reseller.body.data.map((m) => m.username)).toEqual(['root', 'resell1']);
  });

  it('the upgrade backfill names the owner as manager of accounts that had none', async () => {
    const BACKFILL = '034b_support-chat-manager-backfill.sql';
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'gina', domain: 'gina.example', owner: 'resell1', manager: 'root' }).expect(201);
    // An account that existed before the column arrived: no manager at all.
    app.ctx.db.prepare("UPDATE accounts SET manager_user_id = NULL WHERE username = 'gina'").run();
    app.ctx.db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(BACKFILL);
    migrate(app.ctx.db);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?').get(BACKFILL).n).toBe(1);
    const res = await app.http.get('/api/accounts/gina').expect(200);
    expect(res.body.data).toMatchObject({ owner: 'resell1', manager: 'resell1', manager_role: 'reseller' });
    // Accounts that already had a manager keep it.
    expect((await app.http.get('/api/accounts/bob').expect(200)).body.data.manager).toBe('resell2');
    expect((await app.http.get('/api/accounts/erin').expect(200)).body.data.manager).toBe('root');
    migrate(app.ctx.db);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?').get(BACKFILL).n).toBe(1);
  });

  it('a deleted manager leaves the account unmanaged instead of blocking the delete', async () => {
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'frank', domain: 'frank.example', manager: 'resell2' }).expect(201);
    app.ctx.db.prepare("DELETE FROM users WHERE username = 'resell2'").run();
    const res = await app.http.get('/api/accounts/frank').expect(200);
    expect(res.body.data.manager).toBeNull();
  });
});
