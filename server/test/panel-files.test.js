import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { relPath, UPLOAD_TTL_MS, DOWNLOAD_CHUNK_BYTES, MAX_CHUNK_BYTES, createGate, sshWriteAllowed } from '../src/services/panel-files.js';

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
  file('/home/alice/site.zip', 'zipdata');
  dir('/home/bob'); file('/home/bob/secret.txt', 'bob only'); file('/home/bob/b.zip', 'zipdata');
  // When set, the mock's archive / chunk_read answers wait on it so jobs and
  // downloads can be observed while they are in flight.
  return { tree, dir, file, block: null, readBlock: null };
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
    'files.chunk_read': async ({ path, offset, length }) => {
      if (fs.readBlock) await fs.readBlock;
      const e = fs.tree.get(path);
      const slice = e.content.subarray(offset, offset + Math.min(length, 5));
      return { path, size: e.content.length, offset, length: slice.length, data: slice.toString('base64'), eof: offset + slice.length >= e.content.length };
    },
    'files.write': ({ path, content, mode }) => { const existed = fs.tree.has(path); fs.file(path, content); return { path, bytes: Buffer.byteLength(content), mode: mode ?? '0644', created: !existed }; },
    // dd semantics: the file is truncated to the offset unless notrunc, then the
    // chunk lands at the offset (a sparse gap stays zero-filled).
    'files.chunk_write': ({ path, data, offset = 0, truncate }) => {
      const buf = Buffer.from(data, 'base64');
      const prev = fs.tree.get(path)?.content ?? Buffer.alloc(0);
      const base = truncate ? prev.subarray(0, Math.min(prev.length, offset)) : prev;
      const out = Buffer.alloc(Math.max(base.length, offset + buf.length));
      base.copy(out); buf.copy(out, offset);
      fs.file(path, out);
      return { path, bytes: buf.length, size: out.length, truncated: truncate };
    },
    'files.mkdir': ({ path, mode }) => { fs.dir(path); return { path, mode }; },
    'files.move': ({ from, to }) => { const e = fs.tree.get(from); fs.tree.delete(from); fs.tree.set(to, e); return { from, to }; },
    'files.copy': ({ from, to }) => { fs.tree.set(to, fs.tree.get(from)); return { from, to }; },
    'files.remove': ({ paths }) => { for (const p of paths) fs.tree.delete(p); return { removed: paths }; },
    'files.chmod': ({ path, mode, recursive }) => ({ path, mode, recursive }),
    'files.du': ({ path, depth }) => ({ path, depth, totalKb: 1234, entries: [{ path: 'public_html', kb: 1000 }], partial: false }),
    'files.archive': async ({ dest, format, paths }) => { if (fs.block) await fs.block; fs.file(dest, 'zipdata'); return { dest, format, members: paths.length, size: 7 }; },
    'files.extract': ({ archive, dest }) => ({ archive, dest, format: 'zip', warnings: [] }),
  });
}

describe('createGate', () => {
  it('bounds work per key and overall, serves waiters in arrival order and refuses a key with too many waiters', async () => {
    const gate = createGate({ perKey: () => 2, total: () => 3, maxWaiting: () => 2 });
    const running = new Map();
    let peak = 0;
    const peakPer = new Map();
    const order = [];
    const releases = [];
    const task = (key, name) => gate.run(key, async () => {
      order.push(name);
      running.set(key, (running.get(key) ?? 0) + 1);
      peak = Math.max(peak, [...running.values()].reduce((a, b) => a + b, 0));
      peakPer.set(key, Math.max(peakPer.get(key) ?? 0, running.get(key)));
      await new Promise((r) => releases.push(r));
      running.set(key, running.get(key) - 1);
    });
    const all = [task(1, 'a1'), task(1, 'a2'), task(1, 'a3'), task(2, 'b1'), task(2, 'b2'), task(1, 'a4')];
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['a1', 'a2', 'b1']);
    expect(gate.stats()).toMatchObject({ active: 3, waiting: 3 });
    await expect(gate.run(1, async () => 'never')).rejects.toMatchObject({ status: 409, code: 'busy' });
    while (releases.length) { releases.shift()(); await new Promise((r) => setImmediate(r)); }
    await Promise.all(all);
    expect(order).toEqual(['a1', 'a2', 'b1', 'a3', 'b2', 'a4']);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peakPer.get(1)).toBeLessThanOrEqual(2);
    expect(gate.stats()).toEqual({ active: 0, waiting: 0, keys: {} });
    await expect(gate.run(1, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(gate.stats().active).toBe(0);
  });
});

describe('sshWriteAllowed', () => {
  it('mirrors the SSH-key gate: ssh feature, shell access, a session login and no impersonation', () => {
    const scope = { accountId: 1, username: 'a', mode: 'user', features: {}, account: { plan: { has_shell: true } } };
    expect(sshWriteAllowed(scope, { auth: { via: 'session' } })).toBe(true);
    expect(sshWriteAllowed(scope, {})).toBe(true);
    expect(sshWriteAllowed({ ...scope, features: { ssh: false } }, {})).toBe(false);
    expect(sshWriteAllowed({ ...scope, account: { plan: { has_shell: false } } }, {})).toBe(false);
    expect(sshWriteAllowed({ ...scope, account: { plan: {} } }, {})).toBe(false);
    expect(sshWriteAllowed(scope, { auth: { via: 'token' } })).toBe(false);
    expect(sshWriteAllowed({ ...scope, mode: 'acting', actingAs: { by: 1 } }, {})).toBe(false);
    expect(sshWriteAllowed(null, {})).toBe(false);
  });
});

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
      expect(root.body.data.entries.map((e) => e.name).sort()).toEqual(['.ssh', 'notes.txt', 'public_html', 'site.zip']);
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
      expect(app.agent.callsTo('files.write')[0].args).toEqual({ username: 'alice', path: '/home/alice/public_html/new.txt', content: 'hello', mode: '0600', protectSshDir: true });
      expect(lastAudit('panel.files.write')).toMatchObject({ principal: 'alice', role: 'user', target: 'alice' });
      expect(JSON.parse(lastAudit('panel.files.write').args_redacted)).toMatchObject({ path: 'public_html/new.txt', bytes: 5 });
      expect((await put('/write', { path: 'x', content: 'y', mode: '0778' })).status).toBe(422);
    });

    it('creates, renames, copies, chmods and deletes with the agent receiving absolute paths only', async () => {
      expect((await post('/mkdir', { path: 'public_html/img' })).status).toBe(201);
      expect(app.agent.callsTo('files.mkdir')[0].args).toEqual({ username: 'alice', path: '/home/alice/public_html/img', mode: '0755', protectSshDir: true });
      expect((await post('/rename', { from: 'public_html/new.txt', to: 'public_html/img/new.txt' })).status).toBe(200);
      expect(app.agent.callsTo('files.move')[0].args).toEqual({ username: 'alice', from: '/home/alice/public_html/new.txt', to: '/home/alice/public_html/img/new.txt', overwrite: false, protectSshDir: true });
      expect((await post('/copy', { from: 'notes.txt', to: 'notes2.txt' })).status).toBe(200);
      expect((await post('/chmod', { path: 'notes2.txt', mode: '0600', recursive: true })).status).toBe(200);
      expect(app.agent.callsTo('files.chmod')[0].args).toEqual({ username: 'alice', path: '/home/alice/notes2.txt', mode: '0600', recursive: true, protectSshDir: true });
      const rm = await del('', { paths: ['notes2.txt', 'public_html/img'] });
      expect(rm.status).toBe(200);
      expect(app.agent.callsTo('files.remove')[0].args).toEqual({ username: 'alice', paths: ['/home/alice/notes2.txt', '/home/alice/public_html/img'], protectSshDir: true });
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
    // Raw octet-stream chunks by index (§57); the pinned chunk size is lowered
    // through the setting so a short file spans several chunks.
    const chunk = (id, index, bytes) => alice.put(`/api/panel/files/uploads/${id}/chunks/${index}`).set('X-CSRF-Token', aliceCsrf).set('Content-Type', 'application/octet-stream').send(Buffer.from(bytes));
    const setChunkBytes = (n) => app.ctx.settings.setMany({ 'panel.upload_chunk_bytes': n });
    afterAll(() => setChunkBytes(null));

    it('pins the chunk size per upload, clamped between 1 KiB and the raw ceiling', async () => {
      const begin = await post('/uploads', { path: 'public_html', name: 'upload.txt', size: 10 });
      expect(begin.status).toBe(201);
      const { id } = begin.body.data;
      expect(begin.body.data).toMatchObject({ path: 'public_html/upload.txt', received: 0, chunkBytes: 1310720, chunkCount: 1, receivedChunks: [] });
      setChunkBytes(4);
      expect((await get(`/uploads/${id}`)).body.data.chunkBytes).toBe(1310720);
      await post(`/uploads/${id}/abort`).expect(200);
      expect((await post('/uploads', { path: 'public_html', name: 'upload.txt', size: 3000 })).body.data).toMatchObject({ chunkBytes: 1024, chunkCount: 3 });
      setChunkBytes(64 * 1024 * 1024);
      expect((await post('/uploads', { path: 'public_html', name: 'upload2.txt', size: 10 })).body.data.chunkBytes).toBe(MAX_CHUNK_BYTES);
      setChunkBytes(null);
      for (const u of [...app.ctx.panelFiles._uploads.values()]) await post(`/uploads/${u.id}/abort`);
    });

    it('spans several chunks, written at their offsets, in any order and idempotently', async () => {
      setChunkBytes(1024);
      const size = 2500;
      const bytes = Buffer.alloc(size, 0); for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
      const begin = await post('/uploads', { path: 'public_html', name: 'big.bin', size });
      const { id } = begin.body.data;
      expect(begin.body.data).toMatchObject({ chunkBytes: 1024, chunkCount: 3, receivedChunks: [] });
      const part = (i) => bytes.subarray(i * 1024, Math.min(size, (i + 1) * 1024));
      expect((await chunk(id, 2, part(2))).body.data).toMatchObject({ received: 452, chunks: 1, receivedChunks: [2] });
      expect((await chunk(id, 0, part(0))).body.data).toMatchObject({ received: 1476, receivedChunks: [0, 2] });
      // A retried chunk is written again but counted once; the wrong length is refused.
      expect((await chunk(id, 0, part(0))).body.data).toMatchObject({ received: 1476, chunks: 2, receivedChunks: [0, 2] });
      expect((await chunk(id, 1, part(1).subarray(0, 100))).status).toBe(422);
      expect((await chunk(id, 3, part(2))).status).toBe(422);
      expect((await chunk(id, 1, Buffer.alloc(0))).status).toBe(422);
      const fin0 = await post(`/uploads/${id}/finish`);
      expect(fin0.status).toBe(422);
      expect(fin0.body.error.fields.data[0]).toContain('missing: 1');
      expect((await get(`/uploads/${id}`)).body.data).toMatchObject({ receivedChunks: [0, 2], chunkCount: 3 });
      expect((await chunk(id, 1, part(1))).body.data).toMatchObject({ received: size, receivedChunks: [0, 1, 2] });
      const writes = app.agent.callsTo('files.chunk_write');
      expect(writes.map((w) => [w.args.offset, w.args.truncate])).toEqual([[2048, true], [0, false], [0, false], [1024, false]]);
      expect(writes.every((w) => w.args.path === '/home/alice/public_html/big.bin' && w.args.protectSshDir === true)).toBe(true);
      const auto = app.ctx.db.prepare("SELECT args_redacted, target FROM audit_log WHERE action LIKE 'PUT /api/panel/files/uploads/%' ORDER BY id DESC LIMIT 1").get();
      expect(auto.args_redacted).toBeNull();
      expect(auto.target).toBe(`${id}/1`);
      expect(lastAudit('panel.files.upload')).toBeUndefined();
      const fin = await post(`/uploads/${id}/finish`);
      expect(fin.status).toBe(200);
      expect(fin.body.data).toEqual({ id, path: 'public_html/big.bin', bytes: size });
      expect(JSON.parse(lastAudit('panel.files.upload').args_redacted)).toMatchObject({ path: 'public_html/big.bin', bytes: size, chunks: 3 });
      expect(fs.tree.get('/home/alice/public_html/big.bin').content.equals(bytes)).toBe(true);
      expect((await get(`/uploads/${id}`)).status).toBe(404);
      setChunkBytes(null);
    });

    it('truncates once even when two chunks are in flight at the same time', async () => {
      setChunkBytes(1024);
      const size = 2048;
      const bytes = Buffer.alloc(size, 0); for (let i = 0; i < size; i += 1) bytes[i] = (i * 7) % 251;
      const { id } = (await post('/uploads', { path: 'public_html', name: 'race.bin', size })).body.data;
      const [a, b] = await Promise.all([chunk(id, 0, bytes.subarray(0, 1024)), chunk(id, 1, bytes.subarray(1024))]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const flags = app.agent.callsTo('files.chunk_write').map((w) => w.args.truncate);
      expect(flags.filter(Boolean)).toHaveLength(1);
      expect(flags[0]).toBe(true);
      await post(`/uploads/${id}/finish`).expect(200);
      expect(fs.tree.get('/home/alice/public_html/race.bin').content.equals(bytes)).toBe(true);
      setChunkBytes(null);
    });

    it('takes only an octet-stream body within the pinned ceiling', async () => {
      const b = await post('/uploads', { path: '', name: 'raw.bin', size: 3 });
      const { id } = b.body.data;
      expect((await put(`/uploads/${id}/chunks/0`, { data: 'YWJj' })).status).toBe(415);
      expect((await alice.put(`/api/panel/files/uploads/${id}/chunks/0`).set('X-CSRF-Token', aliceCsrf).set('Content-Type', 'text/plain').send('abc')).status).toBe(415);
      expect((await chunk(id, -1, 'abc')).status).toBe(422);
      expect((await chunk(id, 'x', 'abc')).status).toBe(422);
      const big = await alice.put(`/api/panel/files/uploads/${id}/chunks/0`).set('X-CSRF-Token', aliceCsrf).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(MAX_CHUNK_BYTES + 1));
      expect(big.status).toBe(413);
      expect(app.agent.callsTo('files.chunk_write')).toHaveLength(0);
      expect((await chunk(id, 0, 'abc')).body.data).toMatchObject({ received: 3, receivedChunks: [0] });
      expect((await post(`/uploads/${id}/finish`)).status).toBe(200);
    });

    it('refuses an incomplete finish, an existing target without overwrite, a missing directory and bad names', async () => {
      fs.file('/home/alice/public_html/upload.txt', 'old');
      expect((await post('/uploads', { path: 'public_html', name: 'upload.txt', size: 3 })).status).toBe(409);
      expect((await post('/uploads', { path: 'public_html', name: 'upload.txt', size: 3, overwrite: true })).status).toBe(201);
      expect((await post('/uploads', { path: 'nowhere', name: 'a.txt', size: 3 })).status).toBe(404);
      expect((await post('/uploads', { path: 'notes.txt', name: 'a.txt', size: 3 })).status).toBe(422);
      for (const name of ['..', '.', 'a/b', '', 'x'.repeat(256), 'a\nb']) expect((await post('/uploads', { path: '', name, size: 3 })).status, name).toBe(422);
      const b = await post('/uploads', { path: '', name: 'half.txt', size: 4 });
      expect((await chunk(b.body.data.id, 0, 'ab')).status).toBe(422);
      const fin = await post(`/uploads/${b.body.data.id}/finish`);
      expect(fin.status).toBe(422);
      expect(app.agent.callsTo('files.chunk_write')).toHaveLength(0);
      const abort = await post(`/uploads/${b.body.data.id}/abort`);
      expect(abort.body.data.aborted).toBe(true);
      // Nothing was written, so nothing is removed; a started upload is.
      expect(app.agent.callsTo('files.remove')).toHaveLength(0);
      const c = await post('/uploads', { path: '', name: 'half.txt', size: 4 });
      await chunk(c.body.data.id, 0, 'abcd').expect(200);
      await post(`/uploads/${c.body.data.id}/abort`).expect(200);
      expect(app.agent.callsTo('files.remove').at(-1).args).toEqual({ username: 'alice', paths: ['/home/alice/half.txt'], protectSshDir: true });
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
        expect((await app.http.put(`/api/panel/files/uploads/${c.body.data.id}/chunks/0`).set('X-CSRF-Token', rootCsrf).set('Content-Type', 'application/octet-stream').send(Buffer.from('abcd'))).status).toBe(404);
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
      expect(app.agent.callsTo('files.archive')[0].args).toEqual({ username: 'alice', paths: ['/home/alice/public_html', '/home/alice/notes.txt'], dest: '/home/alice/backup.zip', format: 'zip', protectSshDir: true });
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
      expect(app.agent.callsTo('files.extract')[0].args).toEqual({ username: 'alice', archive: '/home/alice/backup.zip', dest: '/home/alice/restored', allowSshDir: false });
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

  describe('.ssh is reserved for the SSH-key feature', () => {
    const setPlan = (username, key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.${key}', json(?)) WHERE username = ?`).run(JSON.stringify(value), username);
    const attempts = () => [
      ['put', '/write', { path: '.ssh/authorized_keys', content: 'ssh-ed25519 AAAA x\n', mode: '0600' }],
      ['post', '/mkdir', { path: '.ssh', mode: '0700' }],
      ['post', '/mkdir', { path: '.ssh/sub' }],
      ['post', '/rename', { from: 'notes.txt', to: '.ssh/authorized_keys' }],
      ['post', '/rename', { from: '.ssh', to: 'ssh-old' }],
      ['post', '/copy', { from: 'notes.txt', to: '.ssh/authorized_keys' }],
      ['post', '/chmod', { path: '.ssh', mode: '0777' }],
      ['delete', '', { paths: ['notes.txt', '.ssh'] }],
      ['post', '/uploads', { path: '.ssh', name: 'authorized_keys', size: 3 }],
      ['post', '/uploads', { path: '', name: '.ssh', size: 3 }],
      ['post', '/archive', { paths: ['notes.txt'], dest: '.ssh/a.zip', format: 'zip' }],
      ['post', '/extract', { archive: 'site.zip', dest: '.ssh' }],
    ];

    it('refuses every write into .ssh for an account without shell access, before the agent is called', async () => {
      for (const [method, p, body] of attempts()) {
        const res = await ({ get, put, post, delete: del })[method](p, body);
        expect(res.status, `${method} ${p} ${JSON.stringify(body)}`).toBe(403);
        expect(res.body.error.code).toBe('ssh_managed');
      }
      expect(app.agent.calls.filter((c) => c.name.startsWith('files.'))).toHaveLength(0);
      expect((await get('/list?path=.ssh')).status).toBe(200);
      expect((await put('/write', { path: 'public_html/.ssh/x', content: 'not the home .ssh' })).status).toBe(200);
      expect((await put('/write', { path: '.sshx', content: 'different name' })).status).toBe(200);
      expect(app.agent.callsTo('files.write').map((c) => c.args.path)).toEqual(['/home/alice/public_html/.ssh/x', '/home/alice/.sshx']);
    });

    it('extracts into the home with .ssh members refused by the agent, and lets the agent allow them only when the request could write .ssh itself', async () => {
      let res = await post('/extract', { archive: 'site.zip', dest: '' });
      expect(res.status).toBe(202);
      expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('done');
      expect(app.agent.callsTo('files.extract').at(-1).args).toEqual({ username: 'alice', archive: '/home/alice/site.zip', dest: '/home/alice', allowSshDir: false });
      setPlan('alice', 'has_shell', true);
      setPlan('alice', 'features.ssh', true);
      try {
        res = await post('/extract', { archive: 'site.zip', dest: 'again' });
        expect(res.status).toBe(202);
        await waitForJob(app.ctx, res.body.data.job.id);
        expect(app.agent.callsTo('files.extract').at(-1).args.allowSshDir).toBe(true);
        expect((await put('/write', { path: '.ssh/config', content: 'Host x\n' })).status).toBe(200);
        expect(app.agent.callsTo('files.write').at(-1).args.path).toBe('/home/alice/.ssh/config');
        setPlan('alice', 'features.ssh', false);
        expect((await put('/write', { path: '.ssh/config', content: 'Host y\n' })).body.error.code).toBe('ssh_managed');
        setPlan('alice', 'features.ssh', true);
      } finally { setPlan('alice', 'has_shell', false); setPlan('alice', 'features.ssh', true); }
    });

    it('tells the agent to refuse a write that really lands in .ssh through a link (protectSshDir) unless this request may write .ssh', async () => {
      // 'lnk/.ssh/authorized_keys' passes the lexical gate; the agent resolves the
      // real path and refuses it while protectSshDir is set.
      fs.dir('/home/alice/lnk');
      fs.file('/home/alice/scratch.txt', 'scratch');
      expect((await put('/write', { path: 'lnk/.ssh/authorized_keys', content: 'ssh-ed25519 AAAA x\n', mode: '0600' })).status).toBe(200);
      expect(app.agent.callsTo('files.write').at(-1).args).toMatchObject({ path: '/home/alice/lnk/.ssh/authorized_keys', protectSshDir: true });
      const u = await post('/uploads', { path: 'lnk', name: 'keys', size: 3 });
      expect(u.status).toBe(201);
      await alice.put(`/api/panel/files/uploads/${u.body.data.id}/chunks/0`).set('X-CSRF-Token', aliceCsrf).set('Content-Type', 'application/octet-stream').send(Buffer.from('abc')).expect(200);
      expect(app.agent.callsTo('files.chunk_write').at(-1).args).toMatchObject({ path: '/home/alice/lnk/keys', protectSshDir: true });
      for (const [method, p, body] of [['post', '/mkdir', { path: 'lnk/.ssh' }], ['post', '/rename', { from: 'scratch.txt', to: 'lnk/k' }], ['post', '/copy', { from: 'lnk/k', to: 'lnk/k2' }], ['post', '/chmod', { path: 'lnk', mode: '0700' }], ['delete', '', { paths: ['lnk/k'] }], ['post', '/archive', { paths: ['lnk/k2'], dest: 'lnk/a.zip', format: 'zip' }]]) {
        const res = await (method === 'delete' ? del(p, body) : post(p, body));
        expect([200, 201, 202], `${method} ${p}`).toContain(res.status);
      }
      for (const name of ['files.mkdir', 'files.move', 'files.copy', 'files.chmod', 'files.remove']) expect(app.agent.callsTo(name).at(-1).args.protectSshDir, name).toBe(true);
      await waitForJob(app.ctx, (await get('/jobs')).body.data[0].id);
      expect(app.agent.callsTo('files.archive').at(-1).args.protectSshDir).toBe(true);
      setPlan('alice', 'has_shell', true);
      try {
        expect((await put('/write', { path: 'lnk/.ssh/authorized_keys', content: 'ok\n' })).status).toBe(200);
        expect(app.agent.callsTo('files.write').at(-1).args.protectSshDir).toBe(false);
        expect((await post('/mkdir', { path: 'lnk/.ssh2' })).status).toBe(201);
        expect(app.agent.callsTo('files.mkdir').at(-1).args.protectSshDir).toBe(false);
      } finally { setPlan('alice', 'has_shell', false); }
    });

    it('is refused over an API token and while an admin acts as the account even when the plan allows ssh', async () => {
      setPlan('alice', 'has_shell', true);
      try {
        const minted = (await alice.post('/api/panel/tokens').set('X-CSRF-Token', aliceCsrf).send({ name: 'files', scopes: ['panel:files'] })).body.data.token;
        const bearer = request(app.ctx.app);
        expect((await bearer.put('/api/panel/files/write').set('Authorization', `Bearer ${minted}`).send({ path: 'public_html/ok.txt', content: 'x' })).status).toBe(200);
        const viaToken = await bearer.put('/api/panel/files/write').set('Authorization', `Bearer ${minted}`).send({ path: '.ssh/authorized_keys', content: 'ssh-ed25519 AAAA x\n' });
        expect(viaToken.status).toBe(403);
        expect(viaToken.body.error.code).toBe('ssh_managed');
        const tokenExtract = await bearer.post('/api/panel/files/extract').set('Authorization', `Bearer ${minted}`).send({ archive: 'site.zip', dest: '' });
        expect(tokenExtract.status).toBe(202);
        await waitForJob(app.ctx, tokenExtract.body.data.job.id);
        expect(app.agent.callsTo('files.extract').at(-1).args.allowSshDir).toBe(false);
        await rootPost('/api/panel/admin/login-as/alice').expect(200);
        try {
          const acting = await rootPost('/api/panel/files/mkdir', { path: '.ssh', mode: '0700' });
          expect(acting.status).toBe(403);
          expect(acting.body.error.code).toBe('ssh_managed');
          const actingExtract = await rootPost('/api/panel/files/extract', { archive: 'site.zip', dest: 'x' });
          expect(actingExtract.status).toBe(202);
          await waitForJob(app.ctx, actingExtract.body.data.job.id);
          expect(app.agent.callsTo('files.extract').at(-1).args.allowSshDir).toBe(false);
        } finally { await rootPost('/api/panel/admin/logout-as').expect(200); }
        expect(app.agent.callsTo('files.write').map((c) => c.args.path)).toEqual(['/home/alice/public_html/ok.txt']);
        expect(app.agent.callsTo('files.mkdir')).toHaveLength(0);
      } finally { setPlan('alice', 'has_shell', false); }
    });
  });

  describe('job caps and the account job reader', () => {
    const setting = (k, v) => app.ctx.settings.set(k, v);
    const release = () => { const r = fs.release; fs.block = null; fs.release = null; r?.(); };
    const hold = () => { fs.block = new Promise((r) => { fs.release = r; }); };
    const poll = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('condition not met'); await new Promise((r) => setTimeout(r, 20)); } };

    it('caps queued + running jobs per account, reuses an identical request and answers 409 busy beyond the cap', async () => {
      setting('panel.files.max_active_jobs_per_account', 2);
      hold();
      try {
        const a1 = await post('/archive', { paths: ['notes.txt'], dest: 'cap1.zip', format: 'zip' });
        const a2 = await post('/archive', { paths: ['notes.txt'], dest: 'cap2.tar.gz', format: 'tar.gz' });
        expect([a1.status, a2.status]).toEqual([202, 202]);
        expect(a1.body.data.reused).toBe(false);
        const a3 = await post('/archive', { paths: ['notes.txt'], dest: 'cap3.zip', format: 'zip' });
        expect(a3.status).toBe(409);
        expect(a3.body.error.code).toBe('busy');
        const x = await post('/extract', { archive: 'site.zip', dest: 'cap-x' });
        expect(x.status).toBe(409);
        const again = await post('/archive', { paths: ['public_html'], dest: 'cap1.zip', format: 'zip' });
        expect(again.status).toBe(202);
        expect(again.body.data).toMatchObject({ job: { id: a1.body.data.job.id }, reused: true });
        expect(app.agent.callsTo('files.archive').length).toBeLessThanOrEqual(2);
        // Another account is not held back by alice's queue.
        await rootPost('/api/panel/admin/login-as/bob').expect(200);
        try { expect((await rootPost('/api/panel/files/archive', { paths: ['secret.txt'], dest: 'bob1.zip', format: 'zip' })).status).toBe(202); } finally { await rootPost('/api/panel/admin/logout-as').expect(200); }
        release();
        for (const id of [a1.body.data.job.id, a2.body.data.job.id]) expect((await waitForJob(app.ctx, id)).status).toBe('done');
        await poll(() => app.ctx.jobs.list({ status: 'running' }).length === 0 && app.ctx.jobs.list({ status: 'queued' }).length === 0);
        expect((await post('/archive', { paths: ['notes.txt'], dest: 'cap3.zip', format: 'zip' })).status).toBe(202);
      } finally { release(); setting('panel.files.max_active_jobs_per_account', 3); }
    });

    it('caps the files jobs of the whole server', async () => {
      await poll(() => app.ctx.jobs.list({ status: 'running' }).length === 0 && app.ctx.jobs.list({ status: 'queued' }).length === 0);
      setting('panel.files.max_active_jobs', 1);
      hold();
      try {
        const a = await post('/archive', { paths: ['notes.txt'], dest: 'global1.zip', format: 'zip' });
        expect(a.status).toBe(202);
        await rootPost('/api/panel/admin/login-as/bob').expect(200);
        try {
          const b = await rootPost('/api/panel/files/archive', { paths: ['secret.txt'], dest: 'bob-global.zip', format: 'zip' });
          expect(b.status).toBe(409);
          expect(b.body.error.code).toBe('busy');
        } finally { await rootPost('/api/panel/admin/logout-as').expect(200); }
        release();
        expect((await waitForJob(app.ctx, a.body.data.job.id)).status).toBe('done');
      } finally { release(); setting('panel.files.max_active_jobs', 24); }
    });

    it('lets the account read and stream its own jobs only, without the absolute paths the agent received', async () => {
      await poll(() => app.ctx.jobs.list({ status: 'running' }).length === 0 && app.ctx.jobs.list({ status: 'queued' }).length === 0);
      const mine = await get('/jobs');
      expect(mine.status).toBe(200);
      expect(mine.body.data.length).toBeGreaterThan(0);
      expect(mine.body.data.every((j) => ['panel.files.archive', 'panel.files.extract'].includes(j.type))).toBe(true);
      expect(JSON.stringify(mine.body.data)).not.toContain('/home/');
      const one = await get(`/jobs/${mine.body.data[0].id}`);
      expect(one.status).toBe(200);
      expect(one.body.data).toMatchObject({ id: mine.body.data[0].id, status: 'done', logs: expect.any(Array), params: { username: 'alice' } });
      expect(one.body.data.params.op).toBeUndefined();
      const stream = await get(`/jobs/${mine.body.data[0].id}/stream`).buffer(true).parse((r, cb) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => cb(null, t)); });
      expect(stream.status).toBe(200);
      expect(stream.headers['content-type']).toMatch(/text\/event-stream/);
      expect(stream.body).toContain('"type":"snapshot"');
      const bobsJob = app.ctx.jobs.list({ type: 'panel.files.archive', limit: 200 }).find((j) => j.params.username === 'bob');
      expect(bobsJob).toBeTruthy();
      expect((await get(`/jobs/${bobsJob.id}`)).status).toBe(404);
      expect((await get(`/jobs/${bobsJob.id}/stream`)).status).toBe(404);
      expect((await get('/jobs/999999')).status).toBe(404);
      expect((await get('/jobs/abc')).status).toBe(422);
      expect((await carolHttp.get('/api/panel/files/jobs')).status).toBe(403);
      expect((await app.http.get(`/api/panel/files/jobs/${mine.body.data[0].id}`)).status).toBe(403);
    });
  });

  describe('agent ops in flight per account', () => {
    const setting = (k, v) => app.ctx.settings.set(k, v);
    const poll = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('condition not met'); await new Promise((r) => setTimeout(r, 10)); } };
    // superagent sends only once a request is awaited, so each download is started explicitly.
    const download = () => get('/download?path=notes.txt').buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); }).then((r) => r);

    it('reads downloads in ranges no larger than 2 MiB', () => {
      expect(DOWNLOAD_CHUNK_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024);
    });

    it('lets at most N ops of one account reach the agent at once, queues the next request and refuses a flood', async () => {
      setting('panel.files.max_inflight_per_account', 1);
      setting('panel.files.max_waiting_per_account', 1);
      let release;
      fs.readBlock = new Promise((r) => { release = r; });
      try {
        const first = download();
        await poll(() => app.agent.callsTo('files.chunk_read').length === 1);
        const second = download();
        await poll(() => app.ctx.panelFiles._inflight.stats().waiting === 1);
        expect(app.agent.callsTo('files.chunk_read')).toHaveLength(1);
        const third = await get('/list');
        expect(third.status).toBe(409);
        expect(third.body.error.code).toBe('busy');
        expect(app.ctx.panelFiles._inflight.stats()).toMatchObject({ active: 1, waiting: 1 });
        fs.readBlock = null;
        release();
        const [a, b] = await Promise.all([first, second]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.body.toString()).toBe('abcdefghijklmnopqrstuvwxyz0123456789');
        expect(b.body.toString()).toBe('abcdefghijklmnopqrstuvwxyz0123456789');
        expect(app.ctx.panelFiles._inflight.stats()).toEqual({ active: 0, waiting: 0, keys: {} });
      } finally { fs.readBlock = null; release?.(); setting('panel.files.max_inflight_per_account', 2); setting('panel.files.max_waiting_per_account', 64); }
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
