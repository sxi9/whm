import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { relPath, UPLOAD_TTL_MS } from '../src/services/panel-files.js';

// A tiny fake home tree the mock agent answers from. Paths are absolute, as the
// service sends them; the mock records every call for the assertions.
function fakeFs() {
  const tree = new Map();
  const dir = (p) => tree.set(p, { type: 'dir', mode: '0755' });
  const file = (p, content) => tree.set(p, { type: 'file', mode: '0644', content: Buffer.from(content) });
  dir('/home/alice'); dir('/home/alice/public_html'); dir('/home/alice/.ssh');
  file('/home/alice/public_html/index.html', '<h1>alice</h1>\n');
  file('/home/alice/public_html/logo.bin', Buffer.from([0x89, 0x50, 0x00, 0x47]));
  file('/home/alice/notes.txt', 'abcdefghijklmnopqrstuvwxyz0123456789');
  dir('/home/bob'); file('/home/bob/secret.txt', 'bob only');
  return { tree, dir, file };
}

const BINS = { setpriv: true, runuser: true, zip: true, unzip: true, tar: true, gzip: true, useradd: true, usermod: true, userdel: true, chpasswd: true };

function hostAgent(fs) {
  const stat = (p) => {
    const e = fs.tree.get(p);
    if (!e) return { path: p, exists: false };
    return { path: p, exists: true, name: p.split('/').pop(), type: e.type, size: e.content?.length ?? 4096, mtime: '2026-11-01T00:00:00.000Z', mode: e.mode, owner: 'alice', group: 'alice', links: 1 };
  };
  const notFound = (p) => Object.assign(new Error(`${p} does not exist`), { agentError: true, code: 'not_found', details: {} });
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n])])),
    'files.stat': ({ path }) => stat(path),
    'files.list': ({ path, limit }) => {
      if (!fs.tree.has(path)) throw notFound(path);
      const entries = [...fs.tree.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/')).map((k) => ({ ...stat(k), name: k.slice(path.length + 1) }));
      return { path, entries: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit };
    },
    'files.read': ({ path, maxBytes }) => {
      const e = fs.tree.get(path);
      if (!e) throw notFound(path);
      const binary = e.content.includes(0);
      return { path, size: e.content.length, bytes: Math.min(maxBytes, e.content.length), truncated: e.content.length > maxBytes, binary, content: binary ? null : e.content.subarray(0, maxBytes).toString(), mtime: 'x', mode: e.mode };
    },
    // Answers at most 5 bytes per call so a download must loop until eof.
    'files.chunk_read': ({ path, offset, length }) => {
      const e = fs.tree.get(path);
      const slice = e.content.subarray(offset, offset + Math.min(length, 5));
      return { path, size: e.content.length, offset, length: slice.length, data: slice.toString('base64'), eof: offset + slice.length >= e.content.length };
    },
    'files.write': ({ path, content, mode }) => { const existed = fs.tree.has(path); fs.file(path, content); return { path, bytes: Buffer.byteLength(content), mode: mode ?? '0644', created: !existed }; },
    'files.chunk_write': ({ path, data, truncate }) => {
      const buf = Buffer.from(data, 'base64');
      const prev = !truncate && fs.tree.get(path)?.content ? fs.tree.get(path).content : Buffer.alloc(0);
      fs.file(path, Buffer.concat([prev, buf]));
      return { path, bytes: buf.length, size: fs.tree.get(path).content.length, truncated: truncate };
    },
    'files.mkdir': ({ path, mode }) => { fs.dir(path); return { path, mode }; },
    'files.move': ({ from, to }) => { const e = fs.tree.get(from); fs.tree.delete(from); fs.tree.set(to, e); return { from, to }; },
    'files.copy': ({ from, to }) => { fs.tree.set(to, fs.tree.get(from)); return { from, to }; },
    'files.remove': ({ paths }) => { for (const p of paths) fs.tree.delete(p); return { removed: paths }; },
    'files.chmod': ({ path, mode, recursive }) => ({ path, mode, recursive }),
    'files.du': ({ path, depth }) => ({ path, depth, totalKb: 1234, entries: [{ path: 'public_html', kb: 1000 }], partial: false }),
    'files.archive': ({ dest, format, paths }) => { fs.file(dest, 'zipdata'); return { dest, format, members: paths.length, size: 7 }; },
    'files.extract': ({ archive, dest }) => ({ archive, dest, format: 'zip', warnings: [] }),
  });
}

describe('relPath', () => {
  it('accepts plain relative paths and refuses "..", leading "-", NUL, absolute paths and over-long paths', () => {
    for (const p of ['public_html', 'public_html/index.html', 'a/b/c', '.hidden', 'dir/-dash', 'x..y', 'a/..b/c', 'файл.txt', 'with space.txt']) expect(relPath.safeParse(p).success, p).toBe(true);
    for (const p of ['..', '../x', 'a/../b', 'a/..', '-rf', '-', 'a\0b', '/etc/passwd', '/public_html', '', 'x'.repeat(513), 'a\nb', 'a\rb']) expect(relPath.safeParse(p).success, JSON.stringify(p)).toBe(false);
  });
});

describe('Panel files API', () => {
  let app;
  let fs;
  let alice;
  let aliceCsrf;
  let carolHttp;
  let rootCsrf;
  const db = () => app.ctx.db;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', rootCsrf).send(body);
  const setFeature = (username, key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.${key}', json(?)) WHERE username = ?`).run(JSON.stringify(value), username);

  beforeAll(async () => {
    fs = fakeFs();
    app = await createTestApp({ agent: hostAgent(fs) });
    rootCsrf = await app.login();
    await app.createUser('resell1', 'reseller');
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/accounts', { username: 'bob', domain: 'bob.com', owner: 'resell1', contactEmail: 'bob@bob.com' }).expect(201);
    await rootPost('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!' }).expect(200);
    await app.createUser('carol', 'user');
    alice = request.agent(app.ctx.app);
    aliceCsrf = (await alice.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' })).body.data.csrfToken;
    carolHttp = request.agent(app.ctx.app);
    await carolHttp.post('/api/auth/login').send({ username: 'carol', password: 'Test-Passw0rd!1' }).expect(200);
    app.ctx.jobs.start();
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; app.ctx.panelFiles._duCache.clear(); });

  const get = (p) => alice.get(`/api/panel/files${p}`);
  const post = (p, body = {}) => alice.post(`/api/panel/files${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const put = (p, body = {}) => alice.put(`/api/panel/files${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const del = (p, body = {}) => alice.delete(`/api/panel/files${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const lastAudit = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);

  describe('scope and gates', () => {
    it('refuses a user login that is not linked to an account, and an admin without an acting-as context', async () => {
      expect((await carolHttp.get('/api/panel/files/list')).body.error.code).toBe('no_account');
      const res = await app.http.get('/api/panel/files/list');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('panel_scope_required');
      expect(app.agent.callsTo('files.list')).toHaveLength(0);
    });

    it('needs a session', async () => {
      expect((await request(app.ctx.app).get('/api/panel/files/list')).status).toBe(401);
    });

    it('refuses every route when the package disables the file manager', async () => {
      setFeature('alice', 'filemanager', false);
      try {
      for (const [method, p, body] of [['get', '/list'], ['get', '/read?path=notes.txt'], ['put', '/write', { path: 'x', content: 'y' }], ['post', '/mkdir', { path: 'd' }], ['delete', '', { paths: ['x'] }], ['post', '/archive', { paths: ['x'], dest: 'x.zip', format: 'zip' }], ['get', '/du']]) {
        const res = await ({ get, put, post, delete: del })[method](p, body);
        expect(res.status, `${method} ${p}`).toBe(403);
        expect(res.body.error.code).toBe('feature_disabled');
      }
      expect(app.agent.calls.filter((c) => c.name.startsWith('files.'))).toHaveLength(0);
      } finally { setFeature('alice', 'filemanager', true); }
    });

    it('rejects every escape attempt before the agent is called', async () => {
      const bad = ['../bob/secret.txt', '/home/bob/secret.txt', '/etc/passwd', '-rf', 'a/../../bob', 'x'.repeat(513), 'a\u0000b'];
      for (const p of bad) {
        expect((await get(`/read?path=${encodeURIComponent(p)}`)).status, p).toBe(422);
        expect((await put('/write', { path: p, content: 'x' })).status, p).toBe(422);
        expect((await del('', { paths: [p] })).status, p).toBe(422);
        expect((await post('/rename', { from: 'notes.txt', to: p })).status, p).toBe(422);
      }
      expect(app.agent.calls.filter((c) => c.name.startsWith('files.'))).toHaveLength(0);
    });
  });

  describe('browse, read, write', () => {
    it('lists the home root and subdirectories with paths pinned under /home/alice', async () => {
      const root = await get('/list');
      expect(root.status).toBe(200);
      expect(root.body.data.path).toBe('.');
      expect(root.body.data.entries.map((e) => e.name).sort()).toEqual(['.ssh', 'notes.txt', 'public_html']);
      expect(app.agent.callsTo('files.list')[0].args).toEqual({ username: 'alice', path: '/home/alice', limit: 2000 });
      const sub = await get('/list?path=public_html&limit=1');
      expect(sub.body.data).toMatchObject({ path: 'public_html', total: 2, truncated: true });
      expect((await get('/list?limit=10001')).status).toBe(422);
      expect((await get('/list?path=nope')).status).toBe(404);
    });

    it('stats, reads text, refuses binary in the editor and writes through the agent', async () => {
      expect((await get('/stat?path=notes.txt')).body.data).toMatchObject({ path: 'notes.txt', type: 'file', size: 36 });
      expect((await get('/stat?path=missing')).status).toBe(404);
      const read = await get('/read?path=public_html/index.html');
      expect(read.body.data).toMatchObject({ path: 'public_html/index.html', content: '<h1>alice</h1>\n', truncated: false });
      const bin = await get('/read?path=public_html/logo.bin');
      expect(bin.status).toBe(422);
      expect(bin.body.error.code).toBe('binary');
      const w = await put('/write', { path: 'public_html/new.txt', content: 'hello', mode: '0600' });
      expect(w.status).toBe(200);
      expect(app.agent.callsTo('files.write')[0].args).toEqual({ username: 'alice', path: '/home/alice/public_html/new.txt', content: 'hello', mode: '0600' });
      expect(lastAudit('panel.files.write')).toMatchObject({ principal: 'alice', role: 'user', target: 'alice' });
      expect(JSON.parse(lastAudit('panel.files.write').args_redacted)).toMatchObject({ path: 'public_html/new.txt', bytes: 5 });
      expect((await put('/write', { path: 'x', content: 'y', mode: '0778' })).status).toBe(422);
    });

    it('creates, renames, copies, chmods and deletes with the agent receiving absolute paths only', async () => {
      expect((await post('/mkdir', { path: 'public_html/img' })).status).toBe(201);
      expect(app.agent.callsTo('files.mkdir')[0].args).toEqual({ username: 'alice', path: '/home/alice/public_html/img', mode: '0755' });
      expect((await post('/rename', { from: 'public_html/new.txt', to: 'public_html/img/new.txt' })).status).toBe(200);
      expect(app.agent.callsTo('files.move')[0].args).toEqual({ username: 'alice', from: '/home/alice/public_html/new.txt', to: '/home/alice/public_html/img/new.txt', overwrite: false });
      expect((await post('/copy', { from: 'notes.txt', to: 'notes2.txt' })).status).toBe(200);
      expect((await post('/chmod', { path: 'notes2.txt', mode: '0600', recursive: true })).status).toBe(200);
      expect(app.agent.callsTo('files.chmod')[0].args).toEqual({ username: 'alice', path: '/home/alice/notes2.txt', mode: '0600', recursive: true });
      const rm = await del('', { paths: ['notes2.txt', 'public_html/img'] });
      expect(rm.status).toBe(200);
      expect(app.agent.callsTo('files.remove')[0].args).toEqual({ username: 'alice', paths: ['/home/alice/notes2.txt', '/home/alice/public_html/img'] });
      expect(JSON.parse(lastAudit('panel.files.remove').args_redacted).paths).toEqual(['notes2.txt', 'public_html/img']);
      // The home itself is never a target.
      expect((await del('', { paths: ['.'] })).status).toBe(422);
      expect((await post('/rename', { from: '.', to: 'x' })).status).toBe(422);
      expect((await post('/mkdir', { path: '.' })).status).toBe(422);
    });

    it('measures disk usage once per five minutes per path', async () => {
      const a = await get('/du?path=public_html&depth=2');
      expect(a.body.data).toMatchObject({ path: 'public_html', totalKb: 1234, cached: false });
      expect(app.agent.callsTo('files.du')[0].args).toEqual({ username: 'alice', path: '/home/alice/public_html', depth: 2 });
      const b = await get('/du?path=public_html&depth=2');
      expect(b.body.data.cached).toBe(true);
      expect(app.agent.callsTo('files.du')).toHaveLength(1);
      expect((await get('/du?depth=3')).status).toBe(422);
    });
  });

  describe('download', () => {
    it('streams the file as an attachment by looping chunk_read until eof, with Content-Length', async () => {
      const res = await get('/download?path=notes.txt').buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
      expect(res.status).toBe(200);
      expect(res.headers['content-length']).toBe('36');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="notes.txt"/);
      expect(res.body.toString()).toBe('abcdefghijklmnopqrstuvwxyz0123456789');
      const calls = app.agent.callsTo('files.chunk_read');
      expect(calls.length).toBe(8);
      expect(calls[0].args).toMatchObject({ username: 'alice', path: '/home/alice/notes.txt', offset: 0 });
      expect(calls.at(-1).args.offset).toBe(35);
      expect(lastAudit('panel.files.download')).toMatchObject({ target: 'alice' });
    });

    it('refuses directories and missing files', async () => {
      expect((await get('/download?path=public_html')).status).toBe(422);
      expect((await get('/download?path=nope.txt')).status).toBe(404);
    });
  });

  describe('uploads', () => {
    const chunk = (s) => Buffer.from(s).toString('base64');

    it('begins, appends chunks, finishes and audits once', async () => {
      const begin = await post('/uploads', { path: 'public_html', name: 'upload.txt', size: 10 });
      expect(begin.status).toBe(201);
      const { id } = begin.body.data;
      expect(begin.body.data).toMatchObject({ path: 'public_html/upload.txt', received: 0, chunkBytes: 1310720 });
      expect((await put(`/uploads/${id}/chunks`, { data: chunk('hello') })).body.data.received).toBe(5);
      expect((await put(`/uploads/${id}/chunks`, { data: chunk('world') })).body.data.received).toBe(10);
      const writes = app.agent.callsTo('files.chunk_write');
      expect(writes.map((w) => [w.args.path, w.args.truncate])).toEqual([['/home/alice/public_html/upload.txt', true], ['/home/alice/public_html/upload.txt', false]]);
      expect((await put(`/uploads/${id}/chunks`, { data: chunk('!') })).status).toBe(422);
      const auto = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action LIKE 'PUT /api/panel/files/uploads/%' ORDER BY id DESC LIMIT 1").get();
      expect(auto.args_redacted).toBeNull();
      expect(lastAudit('panel.files.upload')).toBeUndefined();
      const fin = await post(`/uploads/${id}/finish`);
      expect(fin.status).toBe(200);
      expect(fin.body.data).toEqual({ id, path: 'public_html/upload.txt', bytes: 10 });
      expect(JSON.parse(lastAudit('panel.files.upload').args_redacted)).toMatchObject({ path: 'public_html/upload.txt', bytes: 10, chunks: 2 });
      expect(fs.tree.get('/home/alice/public_html/upload.txt').content.toString()).toBe('helloworld');
      expect((await get(`/uploads/${id}`)).status).toBe(404);
    });

    it('refuses an incomplete finish, an existing target without overwrite, a missing directory and bad names', async () => {
      expect((await post('/uploads', { path: 'public_html', name: 'upload.txt', size: 3 })).status).toBe(409);
      expect((await post('/uploads', { path: 'public_html', name: 'upload.txt', size: 3, overwrite: true })).status).toBe(201);
      expect((await post('/uploads', { path: 'nowhere', name: 'a.txt', size: 3 })).status).toBe(404);
      expect((await post('/uploads', { path: 'notes.txt', name: 'a.txt', size: 3 })).status).toBe(422);
      for (const name of ['..', '.', 'a/b', '', 'x'.repeat(256), 'a\nb']) expect((await post('/uploads', { path: '', name, size: 3 })).status, name).toBe(422);
      const b = await post('/uploads', { path: '', name: 'half.txt', size: 4 });
      await put(`/uploads/${b.body.data.id}/chunks`, { data: chunk('ab') });
      const fin = await post(`/uploads/${b.body.data.id}/finish`);
      expect(fin.status).toBe(422);
      const abort = await post(`/uploads/${b.body.data.id}/abort`);
      expect(abort.body.data.aborted).toBe(true);
      expect(app.agent.callsTo('files.remove').at(-1).args).toEqual({ username: 'alice', paths: ['/home/alice/half.txt'] });
      expect(lastAudit('panel.files.upload_abort')).toMatchObject({ target: 'alice' });
    });

    it('expires stale uploads and hides them from other accounts', async () => {
      const b = await post('/uploads', { path: '', name: 'stale.txt', size: 4 });
      const u = app.ctx.panelFiles._uploads.get(b.body.data.id);
      u.touched = Date.now() - UPLOAD_TTL_MS - 1000;
      expect((await get(`/uploads/${b.body.data.id}`)).status).toBe(404);
      const c = await post('/uploads', { path: '', name: 'mine.txt', size: 4 });
      await rootPost('/api/panel/admin/login-as/bob').expect(200);
      try {
        expect((await app.http.get(`/api/panel/files/uploads/${c.body.data.id}`)).status).toBe(404);
        expect((await app.http.put(`/api/panel/files/uploads/${c.body.data.id}/chunks`).set('X-CSRF-Token', rootCsrf).send({ data: chunk('ab') })).status).toBe(404);
      } finally { await rootPost('/api/panel/admin/logout-as').expect(200); }
    });
  });

  describe('archive and extract jobs', () => {
    it('queues an archive job that runs files.archive as the account', async () => {
      const res = await post('/archive', { paths: ['public_html', 'notes.txt'], dest: 'backup.zip', format: 'zip' });
      expect(res.status).toBe(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ dest: 'backup.zip', members: 2 });
      expect(app.agent.callsTo('files.archive')[0].args).toEqual({ username: 'alice', paths: ['/home/alice/public_html', '/home/alice/notes.txt'], dest: '/home/alice/backup.zip', format: 'zip' });
      expect(JSON.parse(lastAudit('panel.files.archive').args_redacted)).toMatchObject({ dest: 'backup.zip', paths: 2, format: 'zip' });
      expect((await post('/archive', { paths: ['notes.txt'], dest: 'backup.zip', format: 'zip' })).status).toBe(409);
      expect((await post('/archive', { paths: ['notes.txt'], dest: 'backup.zip', format: 'tar.gz' })).status).toBe(422);
      expect((await post('/archive', { paths: ['.'], dest: 'all.zip', format: 'zip' })).status).toBe(422);
      expect((await post('/archive', { paths: ['notes.txt'], dest: 'x.rar', format: 'rar' })).status).toBe(422);
    });

    it('queues an extract job and refuses unknown archive types and missing archives', async () => {
      const res = await post('/extract', { archive: 'backup.zip', dest: 'restored' });
      expect(res.status).toBe(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(app.agent.callsTo('files.extract')[0].args).toEqual({ username: 'alice', archive: '/home/alice/backup.zip', dest: '/home/alice/restored' });
      expect((await post('/extract', { archive: 'notes.txt', dest: 'x' })).status).toBe(422);
      expect((await post('/extract', { archive: 'missing.zip', dest: 'x' })).status).toBe(404);
    });

    it('reports a missing archiver as a capability gap', async () => {
      BINS.zip = false;
      app.ctx.capabilities.snapshot().at = 0;
      try {
        const res = await post('/archive', { paths: ['notes.txt'], dest: 'again.zip', format: 'zip' });
        expect(res.status).toBe(501);
        expect(res.body.error.code).toBe('capability_missing');
      } finally { BINS.zip = true; app.ctx.capabilities.snapshot().at = 0; }
    });
  });

  describe('acting as the account', () => {
    it('lets root work on the account and records actingAs/by on the audit row', async () => {
      await rootPost('/api/panel/admin/login-as/alice').expect(200);
      const res = await rootPost('/api/panel/files/mkdir', { path: 'from-root' });
      await rootPost('/api/panel/admin/logout-as').expect(200);
      expect(res.status).toBe(201);
      expect(app.agent.callsTo('files.mkdir')[0].args.username).toBe('alice');
      const row = lastAudit('panel.files.mkdir');
      expect(row).toMatchObject({ principal: 'root', role: 'root', target: 'alice' });
      expect(JSON.parse(row.args_redacted)).toMatchObject({ path: 'from-root', actingAs: 'alice', by: 'root' });
    });
  });
});
