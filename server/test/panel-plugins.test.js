import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from './support/app.js';
import { loadCommonJs, REPO_ROOT } from '../src/lib/plugin-sdk.js';
import { HOST_API_VERSION } from '../src/services/plugins.js';

// Plugin pages in the account panel (contract §53): the panel catalog carries
// only audience 'panel' pages, page files follow the same filter, and a plugin
// route called through /api/panel/plugins/<id>/… runs with the account pinned
// as req.panel and only when it lists the 'user' role.

const fixtures = loadCommonJs(path.join(REPO_ROOT, 'plugins', 'sdk', 'test', 'fixtures.js'));
const ID = 'net.example.panelpages';

const MAIN_JS = `'use strict';
module.exports = {
  async activate(ctx) {
    await ctx.ui.registerPage({ route: '/runtime-panel', title: 'Runtime panel page', kind: 'markdown', content: '# runtime', audience: 'panel' });
    await ctx.ui.registerPage({ route: '/runtime-admin', title: 'Runtime admin page', kind: 'markdown', content: '# admin' });
  },
  routes(router) {
    router.get('/mine', { roles: ['user'] }, async (req, res) => res.json({ panel: req.panel, user: req.user }));
    router.post('/mine', { roles: ['user', 'root'] }, async (req, res) => res.status(201).json({ account: req.panel ? req.panel.username : null, body: req.body }));
    router.get('/admin-only', async (req, res) => res.json({ user: req.user, panel: req.panel || null }));
    router.get('/everyone', { roles: ['root', 'reseller', 'user'] }, async (req, res) => res.json({ panel: req.panel || null, role: req.user.role }));
  },
};
`;

function manifest() {
  return fixtures.minimalManifest({
    id: ID, name: 'Panel Pages', version: '1.0.0', permissions: ['ui:sidebar', 'api:routes'],
    ui: {
      sidebar: [{ category: 'Plugins', label: 'Admin table', route: '/', icon: 'table' }],
      pages: [
        { route: '/', title: 'Admin table', kind: 'table', source: '/admin-only' },
        { route: '/mine', title: 'My rows', kind: 'table', source: '/mine', audience: 'panel', description: 'Rows of this account' },
        { route: '/help', title: 'Help', kind: 'markdown', file: 'pages/help.md', audience: 'panel' },
        { route: '/internal', title: 'Internal', kind: 'markdown', file: 'pages/internal.md' },
        { route: '/embed', title: 'Embed', kind: 'html', file: 'pages/embed.html', audience: 'panel' },
      ],
    },
  });
}

function writePlugin(dir) {
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest(), null, 2));
  fs.writeFileSync(path.join(dir, 'main.js'), MAIN_JS);
  fs.writeFileSync(path.join(dir, 'pages', 'help.md'), '# Help\n\nFor account holders.\n');
  fs.writeFileSync(path.join(dir, 'pages', 'internal.md'), '# Internal\n\nRoot only.\n');
  fs.writeFileSync(path.join(dir, 'pages', 'embed.html'), '<p>embed</p>');
  return dir;
}

describe('/api/panel/plugins', () => {
  let app;
  let rootCsrf;
  let alice;
  let aliceCsrf;
  let tmp;
  const rootPost = (url, body) => app.http.post(url).set('X-CSRF-Token', rootCsrf).send(body);
  const get = (url) => alice.get(`/api/panel/plugins${url}`);
  const post = (url, body) => alice.post(`/api/panel/plugins${url}`).set('X-CSRF-Token', aliceCsrf).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    rootCsrf = await app.login();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-panel-plugins-'));
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/accounts', { username: 'bob', domain: 'bob.com', contactEmail: 'bob@bob.com' }).expect(201);
    await rootPost('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!' }).expect(200);
    const http = request.agent(app.ctx.app);
    const res = await http.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' });
    expect(res.status).toBe(200);
    alice = http;
    aliceCsrf = res.body.data.csrfToken;
    const dir = writePlugin(path.join(app.dir, 'src', ID));
    // Installed through the host directly: the route's absPath rule refuses a
    // Windows temp path, and the install itself is plugin-host.test.js's subject.
    const root = app.ctx.db.prepare("SELECT id, username, role FROM users WHERE username = 'root'").get();
    await app.ctx.plugins.install({ dir, source: 'path' }, { user: root });
    await rootPost(`/api/plugins/manage/${ID}/enable`, {}).expect(200);
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serves host API 1.1.0 and keeps a 1.0 manifest valid (pages default to the admin audience)', async () => {
    expect(HOST_API_VERSION).toBe('1.1.0');
    const detail = (await app.http.get(`/api/plugins/manage/${ID}`)).body.data;
    expect(detail.state).toBe('enabled');
  });

  it('lists only the panel pages for the account, without sidebar entries', async () => {
    const res = await get('/ui').expect(200);
    expect(res.body.data).toHaveLength(1);
    const p = res.body.data[0];
    expect(p).toEqual({ id: ID, name: 'Panel Pages', version: '1.0.0', pages: expect.any(Array) });
    expect(p.pages.map((pg) => [pg.route, pg.origin])).toEqual([['/mine', 'manifest'], ['/help', 'manifest'], ['/embed', 'manifest'], ['/runtime-panel', 'runtime']]);
    expect(p.pages.every((pg) => pg.audience === 'panel')).toBe(true);
    expect(p.pages.find((pg) => pg.route === '/mine')).toMatchObject({ kind: 'table', source: '/mine', description: 'Rows of this account' });
  });

  it('keeps the admin catalog to admin pages and the sidebar', async () => {
    const res = await app.http.get('/api/plugins/ui').expect(200);
    const p = res.body.data.find((x) => x.id === ID);
    expect(p.sidebar).toEqual([{ category: 'Plugins', label: 'Admin table', route: '/', icon: 'table' }]);
    expect(p.pages.map((pg) => pg.route).sort()).toEqual(['/', '/internal', '/runtime-admin']);
    expect(p.pages.some((pg) => pg.audience === 'panel')).toBe(false);
  });

  it('serves panel page files and answers 404 for an admin page file through the panel (and vice versa)', async () => {
    const help = await get(`/ui/${ID}/file?path=pages/help.md`).expect(200);
    expect(help.body.data).toEqual({ kind: 'markdown', content: '# Help\n\nFor account holders.\n' });
    expect((await get(`/ui/${ID}/file?path=pages/embed.html`)).body.data.kind).toBe('html');
    expect((await get(`/ui/${ID}/file?path=pages/internal.md`)).status).toBe(404);
    expect((await get(`/ui/${ID}/file?path=../plugin.json`)).status).toBe(422);
    expect((await app.http.get(`/api/plugins/ui/${ID}/file?path=pages/help.md`)).status).toBe(404);
    expect((await app.http.get(`/api/plugins/ui/${ID}/file?path=pages/internal.md`)).status).toBe(200);
    expect((await get('/ui/net.example.nothere/file?path=pages/help.md')).status).toBe(404);
  });

  it('dispatches a user route with the account pinned as req.panel', async () => {
    const res = await get(`/${ID}/mine`).expect(200);
    expect(res.body.data.panel).toEqual({ username: 'alice', accountId: expect.any(Number), domain: 'alice.com', mode: 'user', actingAs: null });
    expect(res.body.data.user).toEqual({ id: expect.any(Number), username: 'alice', role: 'user' });
    const created = await post(`/${ID}/mine`, { a: 1 }).expect(201);
    expect(created.body.data).toEqual({ account: 'alice', body: { a: 1 } });
    expect((await get(`/${ID}/everyone`)).body.data).toEqual({ panel: expect.objectContaining({ username: 'alice' }), role: 'user' });
  });

  it('never reaches an admin-only route through the panel, nor a user route through the admin path', async () => {
    const admin = await get(`/${ID}/admin-only`);
    expect(admin.status).toBe(403);
    expect(admin.body.error.code).toBe('FORBIDDEN');
    expect((await get(`/${ID}/nope`)).status).toBe(404);
    expect((await get('/net.example.nothere/mine')).status).toBe(404);
    // the admin path refuses a role-user principal outright, so req.panel is never missing on a 'user' route
    const direct = await alice.get(`/api/plugins/${ID}/mine`);
    expect(direct.status).toBe(403);
    expect(direct.body.error.code).toBe('FORBIDDEN');
    // root through the admin path still gets no panel scope
    expect((await app.http.get(`/api/plugins/${ID}/everyone`)).body.data).toEqual({ panel: null, role: 'root' });
    expect((await app.http.get(`/api/plugins/${ID}/admin-only`)).body.data.panel).toBeNull();
  });

  it('an administrator logged in as the account goes through the same scope, and only user routes', async () => {
    await rootPost('/api/panel/admin/login-as/bob', {}).expect(200);
    const res = await app.http.get(`/api/panel/plugins/${ID}/mine`).expect(200);
    expect(res.body.data.panel).toMatchObject({ username: 'bob', mode: 'acting', actingAs: { by: 'root' } });
    expect(res.body.data.user.role).toBe('root');
    expect((await app.http.get(`/api/panel/plugins/${ID}/admin-only`)).status).toBe(403);
    await rootPost('/api/panel/admin/logout-as', {}).expect(200);
    expect((await app.http.get(`/api/panel/plugins/${ID}/mine`)).status).toBe(403);
  });

  it('is gated by the plugins plan feature and by the plugin being enabled', async () => {
    const db = app.ctx.db;
    expect(JSON.parse(db.prepare("SELECT features_json FROM feature_lists WHERE name = 'default'").get().features_json).plugins).toBe(true);
    db.prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.plugins', json('false')) WHERE username = 'alice'`).run();
    try {
      const gated = await get('/ui');
      expect(gated.status).toBe(403);
      expect(gated.body.error.code).toBe('feature_disabled');
      expect((await get(`/${ID}/mine`)).status).toBe(403);
    } finally { db.prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.plugins', json('true')) WHERE username = 'alice'`).run(); }
    await get('/ui').expect(200);
    await rootPost(`/api/plugins/manage/${ID}/disable`, {}).expect(200);
    expect((await get('/ui')).body.data).toEqual([]);
    expect((await get(`/${ID}/mine`)).status).toBe(404);
    await rootPost(`/api/plugins/manage/${ID}/enable`, {}).expect(200);
  });
});
