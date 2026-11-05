import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { listenerPort, loadConfig, disablePanelPortCollisions } from '../src/config.js';
import { panelApiAllowed, panelNavigationAllowed, PANEL_API_ALLOW, PANEL_API_DENY } from '../src/middleware/shell.js';

const PASSWORD = 'Test-Passw0rd!1';
const PANEL_PASSWORD = 'Panel-Passw0rd!1';
// bootstrap() never opens the certificate files, so a placeholder pair flips config.tls on.
const TLS = { tlsCert: '/nonexistent/panel.crt', tlsKey: '/nonexistent/panel.key', tlsPort: 2087, panelPort: 2083 };

const listen = (app) => new Promise((resolve) => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }));
});
const closeAll = (...servers) => Promise.all(servers.map((s) => new Promise((r) => s.close(r))));

describe('account-panel listener (2083/2082) vs administration listener (2087/2086)', () => {
  let app;
  let admin;
  let panel;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await listen(app.ctx.app);
    panel = await listen(app.ctx.app);
    app.ctx.config.panelHttpPort = panel.port;
    app.ctx.config.panelPort = 0;
    const csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com', ip: '203.0.113.5' }).expect(201);
    app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(await app.ctx.crypto.hashPassword(PANEL_PASSWORD), 'alice');
  });
  afterAll(async () => { await closeAll(admin.server, panel.server); await app.close(); });

  it('opens the account panel: GET / on the panel port is a 302 to /panel', async () => {
    const res = await request(panel.url).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/panel');
    expect((await request(panel.url).get('/accounts')).headers.location).toBe('/panel');
    expect((await request(panel.url).get('/login')).status).not.toBe(302);
    expect((await request(panel.url).get('/panel/overview/account')).status).not.toBe(302);
    expect((await request(panel.url).get('/assets/app.js')).status).not.toBe(302);
    expect((await request(admin.url).get('/')).status).not.toBe(302);
  });

  it('serves health and branding on the panel port and names the shell', async () => {
    expect((await request(panel.url).get('/api/health')).status).toBe(200);
    const branding = await request(panel.url).get('/api/branding');
    expect(branding.status).toBe(200);
    expect(branding.body.data.shell).toBe('panel');
    expect(branding.body.data.companyName).toBeTruthy();
    const adminBranding = await request(admin.url).get('/api/branding');
    expect(adminBranding.status).toBe(200);
    expect(adminBranding.body.data.shell).toBe('admin');
  });

  it('refuses the administration API on the panel port with 403 wrong_port', async () => {
    const res = await request(panel.url).get('/api/accounts');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'wrong_port', message: 'The administration API is served on port 2087' } });
    expect((await request(panel.url).get('/api/system/status')).status).toBe(403);
    expect((await request(panel.url).post('/api/accounts').send({})).status).toBe(403);
    expect((await request(panel.url).get('/api/plugins/ui')).status).toBe(403);
    expect((await request(panel.url).get('/api/panelx')).status).toBe(403);
  });

  it('does not sign an administrator in on the panel port: 403 wrong_port with the admin link, no cookie, audited', async () => {
    const before = app.ctx.db.prepare("SELECT last_login_at, last_login_ip FROM users WHERE username = 'root'").get();
    const okBefore = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE username = 'root' AND ok = 1").get().n;
    const failBefore = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE username = 'root' AND ok = 0").get().n;
    const res = await request(panel.url).post('/api/auth/login').set('Host', 'panel.example.com').send({ username: 'root', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('wrong_port');
    expect(res.body.error.message).toBe('Administrators and resellers sign in on port 2087');
    expect(res.body.error.adminUrl).toBe('https://panel.example.com:2087/login');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login.wrong_port'").get().n).toBe(1);
    // The refusal is decided before the login is recorded: no successful
    // attempt (which would pre-approve the address for verified-IP login),
    // no failure (which would feed the brute-force counter), no last_login.
    expect(app.ctx.db.prepare("SELECT last_login_at, last_login_ip FROM users WHERE username = 'root'").get()).toEqual(before);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE username = 'root' AND ok = 1").get().n).toBe(okBefore);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE username = 'root' AND ok = 0").get().n).toBe(failBefore);
    const reseller = await app.createUser('resell', 'reseller');
    const r = await request(panel.url).post('/api/auth/login').send({ username: reseller.username, password: reseller.password });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('wrong_port');
  });

  it('signs an account user in on the panel port and serves the panel API', async () => {
    const agent = request.agent(panel.url);
    const login = await agent.post('/api/auth/login').send({ username: 'alice', password: PANEL_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe('user');
    const me = await agent.get('/api/panel/me');
    expect(me.status).toBe(200);
    expect(me.body.data.account.username).toBe('alice');
    const authMe = await agent.get('/api/auth/me');
    expect(authMe.status).toBe(200);
    expect(authMe.body.data.shell).toBe('panel');
    expect(authMe.body.data.panelUrl).toBeUndefined();
    expect((await agent.get('/api/accounts')).status).toBe(403);
  });

  it('refuses the panel administration API and admin mutations on the panel port even with an admin principal', async () => {
    const login = await request(admin.url).post('/api/auth/login').send({ username: 'root', password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    const csrf = login.body.data.csrfToken;
    const onPanel = (method, url) => request(panel.url)[method](url).set('Cookie', cookie).set('X-CSRF-Token', csrf);
    // The same cookie works on the admin port, where the admin API lives.
    expect((await request(admin.url).get('/api/panel/admin/settings').set('Cookie', cookie)).status).toBe(200);
    const loginAs = await onPanel('post', '/api/panel/admin/login-as/alice').send({});
    expect(loginAs.status).toBe(403);
    expect(loginAs.body.error.code).toBe('wrong_port');
    expect((await onPanel('get', '/api/panel/admin/settings')).status).toBe(403);
    expect((await onPanel('post', '/api/panel/admin/accounts/alice/2fa/reset').send({})).status).toBe(403);
    expect((await onPanel('put', '/api/panel/admin/settings').send({})).status).toBe(403);
    const password = await onPanel('post', '/api/auth/password').send({ currentPassword: PASSWORD, newPassword: 'Other-Passw0rd!2' });
    expect(password.status).toBe(403);
    expect(password.body.error.code).toBe('wrong_port');
    expect((await onPanel('post', '/api/auth/2fa/disable').send({ password: PASSWORD })).status).toBe(403);
    // Reading the session and logging out stay possible there.
    expect((await onPanel('get', '/api/auth/me')).status).toBe(200);
    expect((await onPanel('post', '/api/auth/logout').send({})).status).toBe(200);

    const token = app.ctx.crypto.randomToken();
    const root = app.ctx.db.prepare("SELECT id FROM users WHERE username = 'root'").get();
    app.ctx.db.prepare("INSERT INTO api_tokens (user_id, name, token_hash, scopes) VALUES (?, 'shell-test', ?, '[]')").run(root.id, app.ctx.crypto.hashToken(token));
    const bearer = (method, url) => request(panel.url)[method](url).set('Authorization', `Bearer ${token}`);
    expect((await request(admin.url).get('/api/accounts').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const viaToken = await bearer('post', '/api/panel/admin/login-as/alice').send({});
    expect(viaToken.status).toBe(403);
    expect(viaToken.body.error.code).toBe('wrong_port');
    expect((await bearer('post', '/api/panel/files/mkdir').send({ path: '/x' })).status).toBe(403);
    expect((await bearer('get', '/api/auth/me')).status).toBe(200);
    app.ctx.db.prepare("DELETE FROM api_tokens WHERE name = 'shell-test'").run();
  });

  it('serves the interface strings and the active theme to an account user on the panel port', async () => {
    const agent = request.agent(panel.url);
    expect((await agent.post('/api/auth/login').send({ username: 'alice', password: PANEL_PASSWORD })).status).toBe(200);
    expect((await agent.get('/api/locales/active')).status).toBe(200);
    expect((await agent.get('/api/themes/active')).status).toBe(200);
    expect((await agent.get('/api/locales')).status).toBe(403);
    expect((await agent.get('/api/themes')).status).toBe(403);
  });

  it('keeps the administration port serving every role and every API', async () => {
    const agent = request.agent(admin.url);
    const login = await agent.post('/api/auth/login').send({ username: 'root', password: PASSWORD });
    expect(login.status).toBe(200);
    const me = await agent.get('/api/auth/me');
    expect(me.body.data.shell).toBe('admin');
    expect(me.body.data.panelUrl).toBe(`http://${app.ctx.settings.get('basic.hostname')}:${panel.port}/`);
    expect((await agent.get('/api/accounts')).status).toBe(200);
    const user = await request(admin.url).post('/api/auth/login').send({ username: 'alice', password: PANEL_PASSWORD });
    expect(user.status).toBe(200);
  });
});

describe('plain panel listener with TLS configured', () => {
  let app;
  let admin;
  let panel;

  beforeAll(async () => {
    app = await createTestApp({ overrides: TLS });
    admin = await listen(app.ctx.app);
    panel = await listen(app.ctx.app);
    app.ctx.config.panelHttpPort = panel.port;
  });
  afterAll(async () => { await closeAll(admin.server, panel.server); await app.close(); });

  it('redirects each shell to its own https port', async () => {
    const p = await request(panel.url).get('/panel/overview').set('Host', 'panel.example.com:2082');
    expect(p.status).toBe(301);
    expect(p.headers.location).toBe('https://panel.example.com:2083/panel/overview');
    const a = await request(admin.url).get('/accounts').set('Host', 'panel.example.com:2086');
    expect(a.status).toBe(301);
    expect(a.headers.location).toBe('https://panel.example.com:2087/accounts');
    const api = await request(panel.url).post('/api/auth/login').set('Host', 'panel.example.com').send({ username: 'root', password: PASSWORD });
    expect(api.status).toBe(426);
    expect(api.body.error.message).toBe('Use https on port 2083');
    expect((await request(admin.url).get('/api/auth/csrf').set('Host', 'panel.example.com')).body.error.message).toBe('Use https on port 2087');
    expect((await request(panel.url).get('/api/health').set('Host', 'panel.example.com')).status).toBe(200);
  });
});

describe('listener configuration', () => {
  it('parses the panel ports: 0/off/false/no or junk disables, otherwise a TCP port', () => {
    for (const off of ['0', 'off', 'false', 'no', 'FALSE', '', undefined, null, 'abc', '70000', '-1', '12.5']) expect(listenerPort(off), String(off)).toBe(0);
    expect(listenerPort('2083')).toBe(2083);
    expect(listenerPort(2082)).toBe(2082);
  });

  it('disables a panel port that collides with an administration port instead of turning that listener into the panel shell', () => {
    const base = { port: 2086, tlsPort: 2087 };
    expect(disablePanelPortCollisions({ ...base, panelPort: 2083, panelHttpPort: 2082 })).toEqual([]);
    const tls = { ...base, panelPort: 2087, panelHttpPort: 2082 };
    expect(disablePanelPortCollisions(tls)).toEqual([{ key: 'panelPort', port: 2087, collidesWith: 'tlsPort' }]);
    expect(tls).toMatchObject({ panelPort: 0, panelHttpPort: 2082 });
    const plain = { ...base, panelPort: 2083, panelHttpPort: 2086 };
    expect(disablePanelPortCollisions(plain)).toEqual([{ key: 'panelHttpPort', port: 2086, collidesWith: 'port' }]);
    expect(plain).toMatchObject({ panelPort: 2083, panelHttpPort: 0 });
    const crossed = { ...base, panelPort: 2083, panelHttpPort: 2087 };
    expect(disablePanelPortCollisions(crossed)).toEqual([{ key: 'panelHttpPort', port: 2087, collidesWith: 'tlsPort' }]);
    const same = { ...base, panelPort: 2083, panelHttpPort: 2083 };
    expect(disablePanelPortCollisions(same)).toEqual([{ key: 'panelHttpPort', port: 2083, collidesWith: 'panelPort' }]);
    expect(same).toMatchObject({ panelPort: 2083, panelHttpPort: 0 });

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-ports-'));
    try {
      const cfg = loadConfig({ dataDir, port: 2086, tlsPort: 2087, panelPort: '2087', panelHttpPort: '2086' });
      expect(cfg.panelPort).toBe(0);
      expect(cfg.panelHttpPort).toBe(0);
      expect(cfg.disabledPanelPorts.map((d) => d.key).sort()).toEqual(['panelHttpPort', 'panelPort']);
      const fine = loadConfig({ dataDir, port: 2086, tlsPort: 2087, panelPort: '2083', panelHttpPort: '2082' });
      expect(fine).toMatchObject({ panelPort: 2083, panelHttpPort: 2082, disabledPanelPorts: [] });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('allow-list: exactly what the account-panel SPA calls', () => {
    expect(PANEL_API_ALLOW).toEqual(['/api/health', '/api/auth', '/api/branding', '/api/panel', '/api/locales/active', '/api/themes/active']);
    expect(PANEL_API_DENY).toEqual(['/api/panel/admin']);
    for (const ok of ['/api/health', '/api/auth/login', '/api/auth/me', '/api/auth/reset/request', '/api/auth/external/x/callback', '/api/branding', '/api/branding/logo', '/api/panel/me', '/api/panel/sso/webmail', '/api/panel/files/jobs/1/stream', '/api/locales/active', '/api/themes/active', '/api/panel/administration']) expect(panelApiAllowed(ok), ok).toBe(true);
    for (const no of ['/api/accounts', '/api/system/jobs/1/stream', '/api/plugins/ui', '/api/panelx', '/api/healthz', '/api/authx', '/api', '/api/cpanel/branding', '/api/locales', '/api/themes', '/api/themes/preference', '/api/panel/admin', '/api/panel/admin/login-as/alice', '/api/panel/admin/settings']) expect(panelApiAllowed(no), no).toBe(false);
    for (const nav of ['/panel', '/panel/files', '/login', '/login/reset/abc']) expect(panelNavigationAllowed(nav), nav).toBe(true);
    for (const nav of ['/', '/accounts', '/panelx', '/loginx']) expect(panelNavigationAllowed(nav), nav).toBe(false);
  });
});
