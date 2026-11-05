import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createTestApp, createMockAgent } from './support/app.js';
import { parseCidr, ipOrCidr, toApacheBcrypt, htpasswdId, dirPath } from '../src/services/panel-htaccess.js';

// The mock agent keeps one structured block per directory and one htpasswd
// file per id, the way the real ops do on disk; a probe of a directory named
// "broken" answers 500 so the rollback path can be driven from the API.
function hostAgent(state) {
  const notFound = (p) => Object.assign(new Error(`${p} does not exist`), { agentError: true, code: 'not_found', details: {} });
  const pathNotAllowed = (p) => Object.assign(new Error(`${p} is not inside public_html`), { agentError: true, code: 'path_not_allowed', details: {} });
  const guard = (p) => { if (!/^\/home\/[a-z]+\/public_html(\/|$)/.test(p)) throw pathNotAllowed(p); };
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['setpriv', 'runuser', 'useradd', 'usermod', 'userdel', 'chpasswd'].includes(n)])),
    'web.detect': () => ({ apache: { runUser: 'www-data' } }),
    'files.htaccess.get': ({ path }) => { guard(path); const b = state.blocks.get(path); return { path: `${path}/.htaccess`, rel: path.replace(/^\/home\/[a-z]+\//, ''), exists: Boolean(b), managed: Boolean(b), spec: b ?? null, foreign: 0, size: b ? 100 : 0 }; },
    'files.htaccess.set': ({ path, block, probe }) => {
      guard(path);
      const result = probe ? { status: probe.url.includes('/broken/') ? 500 : block?.auth ? 401 : 200, location: null, error: null } : null;
      if (result?.status === 500) throw Object.assign(new Error('The web server answered 500 with the new .htaccess; the previous content was restored'), { agentError: true, code: 'config_invalid', details: { probe: result } });
      if (block) state.blocks.set(path, block); else state.blocks.delete(path);
      return { path: `${path}/.htaccess`, changed: true, removed: !block, created: false, bytes: 100, probe: result };
    },
    'files.htaccess.probe': ({ url }) => ({ url, status: url.includes('/broken/') ? 500 : 200, location: null, error: null }),
    'files.htpasswd.get': ({ id }) => { const f = state.htpasswd.get(id); return { path: `/home/alice/.keel/htpasswd/${id}`, exists: Boolean(f), entries: f ?? [], ignored: 0 }; },
    'files.htpasswd.set': ({ id, entries, group }) => { state.htpasswd.set(id, entries); return { path: `/home/alice/.keel/htpasswd/${id}`, users: entries.map((e) => e.user), mode: group ? '0640' : '0644', group: group ?? null }; },
    'files.errorpages.list': ({ docroot }) => { guard(docroot); return { docroot, dir: `${docroot}/errors`, pages: ['400', '401', '403', '404', '500', '503'].map((code) => { const f = state.pages.get(`${docroot}/errors/${code}.html`); return { code, exists: Boolean(f), managed: Boolean(f?.managed), title: f?.title ?? '', message: f?.message ?? '', size: f ? 200 : 0 }; }) }; },
    'files.errorpages.write': ({ docroot, code, title, message }) => { guard(docroot); state.pages.set(`${docroot}/errors/${code}.html`, { managed: true, title, message }); return { path: `${docroot}/errors/${code}.html`, rel: `public_html/errors/${code}.html`, bytes: 200, url: `/errors/${code}.html` }; },
    'files.remove': ({ paths }) => { for (const p of paths) { if (!state.pages.has(p)) throw notFound(p); state.pages.delete(p); } return { removed: paths }; },
  });
}

describe('panel-htaccess helpers', () => {
  it('parseCidr / ipOrCidr accept addresses and ranges and refuse everything else', () => {
    expect(parseCidr('203.0.113.9')).toEqual({ ip: '203.0.113.9', bits: null, family: 4 });
    expect(parseCidr('10.0.0.0/8')).toEqual({ ip: '10.0.0.0', bits: 8, family: 4 });
    expect(parseCidr('2001:db8::/32')).toMatchObject({ bits: 32, family: 6 });
    for (const bad of ['1.2.3.4/33', '2001:db8::/129', 'fe80::1%eth0', 'example.com', '1.2.3.4 all granted', '1.2.3.4\n', '', '1.2.3']) expect(parseCidr(bad), bad).toBe(null);
    expect(ipOrCidr.safeParse(' 203.0.113.0/24 ').data).toBe('203.0.113.0/24');
    expect(ipOrCidr.safeParse('x').success).toBe(false);
  });

  it('toApacheBcrypt rewrites the prefix of an equivalent hash and htpasswdId is stable', () => {
    const h = bcrypt.hashSync('secret', 4);
    expect(h.startsWith('$2a$') || h.startsWith('$2b$')).toBe(true);
    const apache = toApacheBcrypt(h);
    expect(apache.startsWith('$2y$')).toBe(true);
    expect(bcrypt.compareSync('secret', apache.replace(/^\$2y\$/, '$2a$'))).toBe(true);
    expect(toApacheBcrypt('$2y$10$x')).toBe('$2y$10$x');
    expect(htpasswdId('public_html/private')).toMatch(/^[a-f0-9]{16}$/);
    expect(htpasswdId('public_html/private')).toBe(htpasswdId('public_html/private'));
    expect(htpasswdId('public_html/other')).not.toBe(htpasswdId('public_html/private'));
    for (const bad of ['/etc', '../x', 'a/../b', '-x', 'a\nb']) expect(dirPath.safeParse(bad).success, bad).toBe(false);
    expect(dirPath.safeParse(undefined).data).toBe('');
  });
});

describe('Panel .htaccess family API', () => {
  let app;
  let state;
  let alice;
  let aliceCsrf;
  let rootCsrf;
  const db = () => app.ctx.db;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', rootCsrf).send(body);
  const lastAudit = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
  const get = (p) => alice.get(`/api/panel${p}`);
  const post = (p, body = {}) => alice.post(`/api/panel${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const put = (p, body = {}) => alice.put(`/api/panel${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const del = (p) => alice.delete(`/api/panel${p}`).set('X-CSRF-Token', aliceCsrf);
  const setFeature = (key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.${key}', json(?)) WHERE username = 'alice'`).run(JSON.stringify(value));
  const calls = (name) => app.agent.calls.filter((c) => c.name === name);
  const MAIN = '/home/alice/public_html';

  beforeAll(async () => {
    state = { blocks: new Map(), htpasswd: new Map(), pages: new Map() };
    app = await createTestApp({ agent: hostAgent(state) });
    rootCsrf = await app.login();
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!' }).expect(200);
    const http = request.agent(app.ctx.app);
    const res = await http.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' });
    expect(res.status).toBe(200);
    alice = http;
    aliceCsrf = res.body.data.csrfToken;
    db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES ((SELECT id FROM accounts WHERE username = 'alice'), 'blog.alice.com', 'sub', '/home/alice/public_html/blog')").run();
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  describe('IP blocker', () => {
    it('starts empty, adds and removes entries in public_html with a probe, audits, and validates the address', async () => {
      let res = await get('/security/ip-blocker');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ path: 'public_html', domain: 'alice.com', denyIps: [], max: 500 });
      res = await post('/security/ip-blocker', { ip: ' 203.0.113.0/24 ' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ ip: '203.0.113.0/24', denyIps: ['203.0.113.0/24'], probe: { status: 200 } });
      const set = calls('files.htaccess.set').at(-1).args;
      expect(set).toMatchObject({ username: 'alice', path: MAIN, block: { denyIps: ['203.0.113.0/24'], indexes: 'inherit', auth: null }, probe: { url: 'http://alice.com/' } });
      expect(lastAudit('panel.ipblocker.add')).toMatchObject({ principal: 'alice', target: 'alice' });
      expect((await post('/security/ip-blocker', { ip: '203.0.113.0/24' })).status).toBe(409);
      expect((await post('/security/ip-blocker', { ip: 'evil.example' })).status).toBe(422);
      expect((await post('/security/ip-blocker', { ip: '1.2.3.4/40' })).status).toBe(422);
      expect((await post('/security/ip-blocker', { ip: '1.2.3.4', extra: 1 })).status).toBe(422);
      await post('/security/ip-blocker', { ip: '2001:db8::1' }).expect(201);
      expect((await get('/security/ip-blocker')).body.data.denyIps).toEqual(['203.0.113.0/24', '2001:db8::1']);
      res = await del(`/security/ip-blocker?ip=${encodeURIComponent('203.0.113.0/24')}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ removed: true, denyIps: ['2001:db8::1'] });
      expect((await del('/security/ip-blocker?ip=9.9.9.9')).status).toBe(404);
      expect(lastAudit('panel.ipblocker.remove')).toMatchObject({ target: 'alice' });
      await del(`/security/ip-blocker?ip=${encodeURIComponent('2001:db8::1')}`).expect(200);
      expect(state.blocks.has(MAIN)).toBe(false);
    });

    it('is gated by the plan feature and session-only', async () => {
      setFeature('ipblocker', false);
      try {
        const res = await get('/security/ip-blocker');
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('feature_disabled');
      } finally { setFeature('ipblocker', true); }
      const token = await alice.post('/api/panel/tokens').set('X-CSRF-Token', aliceCsrf).send({ name: 'cli', scopes: ['panel:read', 'panel:files'] });
      expect(token.status).toBe(201);
      const bearer = request(app.ctx.app);
      expect((await bearer.get('/api/panel/security/ip-blocker').set('Authorization', `Bearer ${token.body.data.token}`)).status).toBe(200);
      const viaToken = await bearer.post('/api/panel/security/ip-blocker').set('Authorization', `Bearer ${token.body.data.token}`).send({ ip: '1.2.3.4' });
      expect(viaToken.status).toBe(403);
      expect(viaToken.body.error.code).toBe('session_required');
    });
  });

  describe('indexes', () => {
    it('reads and sets the rule for a folder pinned under a document root', async () => {
      let res = await get('/files/indexes');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ path: 'public_html', indexes: 'inherit', managed: false });
      res = await put('/files/indexes', { path: 'public_html/downloads', indexes: 'off' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ path: 'public_html/downloads', indexes: 'off', probe: { status: 200 } });
      expect(calls('files.htaccess.set').at(-1).args).toMatchObject({ path: `${MAIN}/downloads`, block: { indexes: 'off' }, probe: { url: 'http://alice.com/downloads/' } });
      expect(lastAudit('panel.indexes.set')).toMatchObject({ target: 'alice' });
      expect((await get('/files/indexes?path=public_html/downloads')).body.data.indexes).toBe('off');
      res = await put('/files/indexes', { path: 'public_html/blog/pics', indexes: 'on' });
      expect(res.status).toBe(200);
      expect(calls('files.htaccess.set').at(-1).args.probe.url).toBe('http://blog.alice.com/pics/');
      for (const bad of [{ path: 'mail', indexes: 'off' }, { path: '../etc', indexes: 'off' }, { path: '/home/alice/public_html', indexes: 'off' }, { path: 'public_html', indexes: 'maybe' }]) {
        expect((await put('/files/indexes', bad)).status, JSON.stringify(bad)).toBe(422);
      }
      expect((await put('/files/indexes', { path: '', indexes: 'off' })).status).toBe(200);
      expect(calls('files.htaccess.set').at(-1).args.path).toBe(MAIN);
    });

    it('answers 422 config_invalid when the agent rolled the file back after a 500', async () => {
      const res = await put('/files/indexes', { path: 'public_html/broken', indexes: 'on' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('config_invalid');
      expect(state.blocks.has(`${MAIN}/broken`)).toBe(false);
    });

    it('does not need the file manager feature but needs its own', async () => {
      setFeature('filemanager', false);
      try {
        expect((await get('/files/indexes')).status).toBe(200);
        expect((await get('/files/list')).status).toBe(403);
      } finally { setFeature('filemanager', true); }
      setFeature('indexmanager', false);
      try { expect((await get('/files/indexes')).body.error.code).toBe('feature_disabled'); } finally { setFeature('indexmanager', true); }
    });
  });

  describe('directory privacy', () => {
    it('protects a folder with a realm, manages users with Apache bcrypt hashes, and unprotects', async () => {
      const id = htpasswdId('public_html/private');
      let res = await get('/files/privacy?path=public_html/private');
      expect(res.body.data).toMatchObject({ path: 'public_html/private', protected: false, realm: 'Restricted area', users: [] });
      res = await put('/files/privacy', { path: 'public_html/private', enabled: true, realm: 'Members only' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ protected: true, realm: 'Members only', probe: { status: 401 } });
      expect(state.htpasswd.get(id)).toEqual([]);
      expect(calls('files.htpasswd.set').at(-1).args).toMatchObject({ id, entries: [], group: 'www-data' });
      expect(calls('files.htaccess.set').at(-1).args.block.auth).toEqual({ realm: 'Members only', userFile: `/home/alice/.keel/htpasswd/${id}` });
      expect(app.agent.calls.findIndex((c) => c.name === 'files.htpasswd.set')).toBeLessThan(app.agent.calls.findIndex((c) => c.name === 'files.htaccess.set'));
      res = await post('/files/privacy/users', { path: 'public_html/private', user: 'bob', password: 'Bobs-secret-1' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ user: 'bob', users: ['bob'], replaced: false });
      const stored = state.htpasswd.get(id)[0];
      expect(stored.user).toBe('bob');
      expect(stored.hash).toMatch(/^\$2y\$12\$/);
      expect(bcrypt.compareSync('Bobs-secret-1', stored.hash.replace(/^\$2y\$/, '$2a$'))).toBe(true);
      expect(JSON.stringify(lastAudit('panel.dirprivacy.user.add'))).not.toContain('Bobs-secret-1');
      res = await post('/files/privacy/users', { path: 'public_html/private', user: 'bob', password: 'Bobs-secret-2' });
      expect(res.body.data.replaced).toBe(true);
      expect(bcrypt.compareSync('Bobs-secret-2', state.htpasswd.get(id)[0].hash.replace(/^\$2y\$/, '$2a$'))).toBe(true);
      expect((await post('/files/privacy/users', { path: 'public_html/private', user: 'bob:x', password: 'Bobs-secret-2' })).status).toBe(422);
      expect((await post('/files/privacy/users', { path: 'public_html/private', user: 'bob', password: 'short' })).status).toBe(422);
      expect((await put('/files/privacy', { path: 'public_html/private', enabled: true, realm: 'say "hi"' })).status).toBe(422);
      res = await get('/files/privacy?path=public_html/private');
      expect(res.body.data).toMatchObject({ protected: true, realm: 'Members only', users: ['bob'] });
      expect(JSON.stringify(res.body)).not.toContain('$2y$');
      expect((await del(`/files/privacy/users?path=public_html/private&user=nobody`)).status).toBe(404);
      res = await del(`/files/privacy/users?path=public_html/private&user=bob`);
      expect(res.status).toBe(200);
      expect(state.htpasswd.get(id)).toEqual([]);
      res = await put('/files/privacy', { path: 'public_html/private', enabled: false });
      expect(res.body.data.protected).toBe(false);
      expect(state.blocks.has(`${MAIN}/private`)).toBe(false);
      expect(lastAudit('panel.dirprivacy.set')).toMatchObject({ target: 'alice' });
    });

    it('is gated by the plan feature and refuses folders outside the document roots', async () => {
      setFeature('dirprivacy', false);
      try { expect((await get('/files/privacy?path=public_html')).body.error.code).toBe('feature_disabled'); } finally { setFeature('dirprivacy', true); }
      expect((await get('/files/privacy?path=.ssh')).status).toBe(422);
      expect((await put('/files/privacy', { path: 'mail', enabled: true })).status).toBe(422);
    });
  });

  describe('error pages', () => {
    it('lists the codes per domain, writes a page and its ErrorDocument, keeps hand-made files, and removes', async () => {
      let res = await get('/advanced/error-pages?domain=alice.com');
      expect(res.status).toBe(200);
      expect(res.body.data.docroot).toBe('public_html');
      expect(res.body.data.pages.map((p) => p.code)).toEqual(['400', '401', '403', '404', '500', '503']);
      expect(res.body.data.pages[3]).toMatchObject({ code: '404', label: 'Not found', exists: false, active: false, url: '/errors/404.html' });
      res = await put('/advanced/error-pages/404', { domain: 'alice.com', title: 'Lost?', message: 'Try the home page.' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ domain: 'alice.com', code: '404', url: '/errors/404.html', active: true, probe: { status: 200 } });
      expect(calls('files.errorpages.write').at(-1).args).toMatchObject({ username: 'alice', docroot: MAIN, code: '404', title: 'Lost?', message: 'Try the home page.' });
      expect(calls('files.htaccess.set').at(-1).args.block.errorDocuments).toEqual({ 404: '/errors/404.html' });
      expect(lastAudit('panel.errorpages.set')).toMatchObject({ target: 'alice' });
      res = await get('/advanced/error-pages?domain=alice.com');
      expect(res.body.data.pages[3]).toMatchObject({ exists: true, managed: true, title: 'Lost?', message: 'Try the home page.', active: true });
      expect((await put('/advanced/error-pages/418', { domain: 'alice.com' })).status).toBe(422);
      expect((await put('/advanced/error-pages/404', { domain: 'alice.com', title: 'a\nb' })).status).toBe(422);
      expect((await put('/advanced/error-pages/404', { domain: 'nobody.example' })).status).toBe(404);
      expect((await get('/advanced/error-pages?domain=nobody.example')).status).toBe(404);
      res = await put('/advanced/error-pages/500', { domain: 'blog.alice.com' });
      expect(res.status).toBe(200);
      expect(calls('files.errorpages.write').at(-1).args.docroot).toBe(`${MAIN}/blog`);
      expect(calls('files.htaccess.set').at(-1).args).toMatchObject({ path: `${MAIN}/blog`, probe: { url: 'http://blog.alice.com/' } });
      res = await del('/advanced/error-pages/404?domain=alice.com');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ code: '404', active: false, deleted: true });
      expect(state.pages.has(`${MAIN}/errors/404.html`)).toBe(false);
      expect(state.blocks.get(MAIN)?.errorDocuments ?? {}).toEqual({});
      res = await del('/advanced/error-pages/404?domain=alice.com');
      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(false);
      await del('/advanced/error-pages/500?domain=blog.alice.com&deleteFile=false').expect(200);
      expect(state.pages.has(`${MAIN}/blog/errors/500.html`)).toBe(true);
    });

    it('is gated by the plan feature and cannot be changed with a token', async () => {
      setFeature('errpgs', false);
      try { expect((await get('/advanced/error-pages?domain=alice.com')).body.error.code).toBe('feature_disabled'); } finally { setFeature('errpgs', true); }
      const token = await alice.post('/api/panel/tokens').set('X-CSRF-Token', aliceCsrf).send({ name: 'cli2', scopes: ['panel:read', 'panel:files'] });
      const bearer = request(app.ctx.app);
      expect((await bearer.get('/api/panel/advanced/error-pages?domain=alice.com').set('Authorization', `Bearer ${token.body.data.token}`)).status).toBe(200);
      expect((await bearer.put('/api/panel/advanced/error-pages/404').set('Authorization', `Bearer ${token.body.data.token}`).send({ domain: 'alice.com' })).status).toBe(403);
    });
  });

  it('exposes the whole block and a probe for a folder', async () => {
    await put('/files/indexes', { path: 'public_html/x', indexes: 'off' }).expect(200);
    const res = await get('/files/htaccess?path=public_html/x');
    expect(res.body.data).toMatchObject({ path: 'public_html/x', domain: 'alice.com', docroot: 'public_html', managed: true, spec: { indexes: 'off' } });
    const probe = await post('/files/htaccess/probe', { path: 'public_html/x' });
    expect(probe.body.data).toMatchObject({ path: 'public_html/x', url: 'http://alice.com/x/', status: 200 });
    expect((await post('/files/htaccess/probe', { path: 'public_html/broken' })).body.data.status).toBe(500);
  });
});
