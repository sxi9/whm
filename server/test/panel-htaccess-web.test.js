import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { DEFLATE_TYPES, HOTLINK_EXTENSIONS, DEFAULT_HOTLINK_EXTENSIONS, bareHost, redirectLoops, HOTLINK_REDIRECT } from '../src/services/panel-htaccess.js';
import { DEFAULT_FEATURES } from '../src/db/seed.js';

// Optimize website and hotlink protection over the mock agent of the
// .htaccess family: one structured block per directory, probe 500 for a
// directory named "broken".
function hostAgent(state) {
  const guard = (p) => { if (!/^\/home\/[a-z]+\/public_html(\/|$)/.test(p)) throw Object.assign(new Error(`${p} is not inside public_html`), { agentError: true, code: 'path_not_allowed', details: {} }); };
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['setpriv', 'runuser', 'useradd', 'usermod', 'userdel', 'chpasswd'].includes(n)])),
    'web.detect': () => ({ apache: { runUser: 'www-data' } }),
    'files.htaccess.get': ({ path }) => { guard(path); const b = state.blocks.get(path); return { path: `${path}/.htaccess`, rel: path.replace(/^\/home\/[a-z]+\//, ''), exists: Boolean(b), managed: Boolean(b), spec: b ?? null, foreign: 0, size: b ? 100 : 0 }; },
    'files.htaccess.set': ({ path, block, probe }) => {
      guard(path);
      const result = probe ? { status: probe.url.includes('/broken/') ? 500 : 200, location: null, error: null } : null;
      if (result?.status === 500) throw Object.assign(new Error('500 with the new .htaccess; restored'), { agentError: true, code: 'config_invalid', details: { probe: result } });
      if (block) state.blocks.set(path, block); else state.blocks.delete(path);
      return { path: `${path}/.htaccess`, changed: true, removed: !block, created: false, bytes: 100, probe: result };
    },
  });
}

describe('panel-htaccess web helpers', () => {
  it('bareHost strips www. and lowercases, redirectLoops spots a protected target, the feature is seeded', () => {
    expect(bareHost(' WWW.Example.COM ')).toBe('example.com');
    expect(bareHost('cdn.example.com')).toBe('cdn.example.com');
    expect(redirectLoops('https://example.com/x.PNG', ['png'])).toBe(true);
    expect(redirectLoops('https://example.com/x.html', ['png'])).toBe(false);
    expect(HOTLINK_REDIRECT.test('https://example.com/$1')).toBe(false);
    expect(DEFAULT_FEATURES).toMatchObject({ optimizews: true, hotlink: true });
    expect(DEFAULT_HOTLINK_EXTENSIONS.every((e) => HOTLINK_EXTENSIONS.includes(e))).toBe(true);
  });
});

describe('Optimize website and hotlink protection API', () => {
  let app;
  let state;
  let alice;
  let aliceCsrf;
  let rootCsrf;
  const db = () => app.ctx.db;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', rootCsrf).send(body);
  const lastAudit = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
  const get = (p) => alice.get(`/api/panel${p}`);
  const put = (p, body = {}) => alice.put(`/api/panel${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const setFeature = (key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.${key}', json(?)) WHERE username = 'alice'`).run(JSON.stringify(value));
  const calls = (name) => app.agent.calls.filter((c) => c.name === name);
  const MAIN = '/home/alice/public_html';

  beforeAll(async () => {
    state = { blocks: new Map() };
    app = await createTestApp({ agent: hostAgent(state) });
    rootCsrf = await app.login();
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!' }).expect(200);
    const http = request.agent(app.ctx.app);
    const res = await http.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' });
    expect(res.status).toBe(200);
    alice = http;
    aliceCsrf = res.body.data.csrfToken;
    const acct = "(SELECT id FROM accounts WHERE username = 'alice')";
    db().prepare(`INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (${acct}, 'blog.alice.com', 'sub', '/home/alice/public_html/blog')`).run();
    db().prepare(`INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (${acct}, 'www.alias.example', 'parked', NULL)`).run();
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  describe('optimize website', () => {
    it('starts off, compresses everything or a chosen subset in a folder, audits and probes', async () => {
      let res = await get('/advanced/optimize');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ path: 'public_html', domain: 'alice.com', mode: 'off', types: [], available: DEFLATE_TYPES, managed: false });
      res = await put('/advanced/optimize', { path: '', mode: 'all' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ path: 'public_html', mode: 'all', types: DEFLATE_TYPES, probe: { status: 200 } });
      expect(calls('files.htaccess.set').at(-1).args).toMatchObject({ username: 'alice', path: MAIN, block: { deflate: { types: DEFLATE_TYPES }, hotlink: null, denyIps: [], indexes: 'inherit' }, probe: { url: 'http://alice.com/' } });
      expect(lastAudit('panel.optimize.set')).toMatchObject({ principal: 'alice', target: 'alice' });
      expect((await get('/advanced/optimize')).body.data).toMatchObject({ mode: 'all', managed: true });
      res = await put('/advanced/optimize', { path: 'public_html/blog', mode: 'custom', types: ['text/css', 'text/html', 'text/html'] });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ path: 'public_html/blog', domain: 'blog.alice.com', mode: 'custom', types: ['text/html', 'text/css'] });
      expect(calls('files.htaccess.set').at(-1).args).toMatchObject({ path: `${MAIN}/blog`, block: { deflate: { types: ['text/html', 'text/css'] } }, probe: { url: 'http://blog.alice.com/' } });
      expect((await get('/advanced/optimize?path=public_html/blog')).body.data.mode).toBe('custom');
      res = await put('/advanced/optimize', { path: 'public_html/blog', mode: 'off' });
      expect(res.body.data.mode).toBe('off');
      expect(state.blocks.has(`${MAIN}/blog`)).toBe(false);
      await put('/advanced/optimize', { path: '', mode: 'off' }).expect(200);
      expect(state.blocks.has(MAIN)).toBe(false);
    });

    it('validates the body, keeps the other directives of the block and surfaces a rollback', async () => {
      for (const bad of [{ mode: 'all', path: 'mail' }, { mode: 'all', path: '../etc' }, { mode: 'gzip' }, { mode: 'custom', types: ['application/x-httpd-php'] }, { mode: 'custom', types: [] }, { mode: 'custom' }, { mode: 'all', extra: 1 }, { mode: 'all', types: 'text/html' }]) {
        expect((await put('/advanced/optimize', bad)).status, JSON.stringify(bad)).toBe(422);
      }
      state.blocks.set(MAIN, { denyIps: ['203.0.113.9'], errorDocuments: {}, indexes: 'off', auth: null });
      await put('/advanced/optimize', { mode: 'all' }).expect(200);
      expect(state.blocks.get(MAIN)).toMatchObject({ denyIps: ['203.0.113.9'], indexes: 'off', deflate: { types: DEFLATE_TYPES }, hotlink: null });
      await put('/advanced/optimize', { mode: 'off' }).expect(200);
      expect(state.blocks.get(MAIN)).toMatchObject({ denyIps: ['203.0.113.9'], deflate: null });
      state.blocks.delete(MAIN);
      const res = await put('/advanced/optimize', { path: 'public_html/broken', mode: 'all' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('config_invalid');
    });

    it('is gated by the optimizews feature and needs no file manager', async () => {
      setFeature('optimizews', false);
      try { expect((await get('/advanced/optimize')).body.error.code).toBe('feature_disabled'); expect((await put('/advanced/optimize', { mode: 'all' })).status).toBe(403); } finally { setFeature('optimizews', true); }
      setFeature('filemanager', false);
      try { expect((await get('/advanced/optimize')).status).toBe(200); } finally { setFeature('filemanager', true); }
    });
  });

  describe('hotlink protection', () => {
    it('always allows the account\'s own domains, adds extra hosts without www., pins the extensions and the redirect', async () => {
      let res = await get('/advanced/hotlink');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ path: 'public_html', domain: 'alice.com', enabled: false, hosts: [], extensions: DEFAULT_HOTLINK_EXTENSIONS, allowBlank: true, redirect: null, domains: ['alice.com', 'alias.example', 'blog.alice.com'], available: HOTLINK_EXTENSIONS, max: 100 });
      res = await put('/advanced/hotlink', { enabled: true, hosts: ['WWW.Partner.example', 'partner.example', 'alice.com'], extensions: ['png', 'jpg'], allowBlank: false, redirect: 'https://alice.com/hotlink.html' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ enabled: true, hosts: ['partner.example'], extensions: ['jpg', 'png'], allowBlank: false, redirect: 'https://alice.com/hotlink.html', domains: ['alice.com', 'alias.example', 'blog.alice.com'], probe: { status: 200 } });
      const set = calls('files.htaccess.set').at(-1).args;
      expect(set).toMatchObject({ username: 'alice', path: MAIN, probe: { url: 'http://alice.com/' } });
      expect(set.block.hotlink).toEqual({ hosts: ['alice.com', 'alias.example', 'blog.alice.com', 'partner.example'], extensions: ['jpg', 'png'], allowBlank: false, redirect: 'https://alice.com/hotlink.html' });
      expect(set.block.deflate).toBe(null);
      expect(lastAudit('panel.hotlink.set')).toMatchObject({ principal: 'alice', target: 'alice' });
      res = await get('/advanced/hotlink');
      expect(res.body.data).toMatchObject({ enabled: true, hosts: ['partner.example'], extensions: ['jpg', 'png'], allowBlank: false, managed: true });
      res = await put('/advanced/hotlink', { enabled: true });
      expect(res.status).toBe(200);
      expect(calls('files.htaccess.set').at(-1).args.block.hotlink).toEqual({ hosts: ['alice.com', 'alias.example', 'blog.alice.com'], extensions: DEFAULT_HOTLINK_EXTENSIONS, allowBlank: true, redirect: null });
      res = await put('/advanced/hotlink', { enabled: false });
      expect(res.body.data).toMatchObject({ enabled: false, hosts: [] });
      expect(state.blocks.has(MAIN)).toBe(false);
    });

    it('validates hosts, extensions and the redirect target (no loops, no rewrite expansions)', async () => {
      const ok = { enabled: true, extensions: ['png'] };
      for (const bad of [
        { ...ok, hosts: ['not a host'] }, { ...ok, hosts: ['example'] }, { ...ok, hosts: ['exa$mple.com'] }, { ...ok, hosts: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`) },
        { ...ok, extensions: ['php'] }, { ...ok, extensions: [] }, { ...ok, extensions: 'png' },
        { ...ok, redirect: '/local.html' }, { ...ok, redirect: 'https://alice.com/x.png' }, { ...ok, redirect: 'https://alice.com/$1' }, { ...ok, redirect: 'https://alice.com/%{REQUEST_URI}' }, { ...ok, redirect: 'https://alice.com/a b' }, { ...ok, redirect: 'javascript:alert(1)' },
        { ...ok, allowBlank: 'no' }, { ...ok, extra: true }, { hosts: [] },
      ]) {
        expect((await put('/advanced/hotlink', bad)).status, JSON.stringify(bad).slice(0, 100)).toBe(422);
      }
      expect(state.blocks.has(MAIN)).toBe(false);
      const res = await put('/advanced/hotlink', { enabled: true, hosts: Array.from({ length: 97 }, (_, i) => `h${i}.example.com`) });
      expect(res.status).toBe(200);
      expect(calls('files.htaccess.set').at(-1).args.block.hotlink.hosts).toHaveLength(100);
      expect((await put('/advanced/hotlink', { enabled: true, hosts: Array.from({ length: 98 }, (_, i) => `h${i}.example.com`) })).status).toBe(422);
      await put('/advanced/hotlink', { enabled: false }).expect(200);
    });

    it('is gated by the hotlink feature and cannot be changed with a token', async () => {
      setFeature('hotlink', false);
      try { expect((await get('/advanced/hotlink')).body.error.code).toBe('feature_disabled'); } finally { setFeature('hotlink', true); }
      const token = await alice.post('/api/panel/tokens').set('X-CSRF-Token', aliceCsrf).send({ name: 'cli3', scopes: ['panel:read', 'panel:files'] });
      expect(token.status).toBe(201);
      const bearer = request(app.ctx.app);
      expect((await bearer.get('/api/panel/advanced/hotlink').set('Authorization', `Bearer ${token.body.data.token}`)).status).toBe(200);
      expect((await bearer.put('/api/panel/advanced/hotlink').set('Authorization', `Bearer ${token.body.data.token}`).send({ enabled: true })).status).toBe(403);
      expect((await bearer.put('/api/panel/advanced/optimize').set('Authorization', `Bearer ${token.body.data.token}`).send({ mode: 'all' })).status).toBe(403);
    });
  });
});
