import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { errorHandler, notFoundHandler } from '../src/middleware/error.js';
import { HttpError } from '../src/lib/errors.js';
import { register } from '../src/routes/panel/backups.js';
import { uploadFileName, RANGE_BYTES } from '../src/services/panel-backup.js';

// A host with tar: archives live in an in-memory disk keyed by path so the
// panel's rows, the range download loop and the upload → register flow are
// checked end to end. backup.account.archive can be held open to test the
// one-running-job-per-account rule.
function backupAgent() {
  const disk = new Map();
  const state = { hold: null, counter: 0, infoFor: null };
  const fail = (code, message) => Object.assign(new Error(message), { agentError: true, code, details: {} });
  const nameFor = (username) => { state.counter += 1; return `backup-10.26.2026_02-00-${String(state.counter).padStart(2, '0')}_${username}.tar.gz`; };
  const userOf = (p) => (p.match(/(?:backup-[\d.]+_[\d-]+_|cpmove-)?([a-z][a-z0-9_-]{0,31})\.tar(?:\.gz)?$/) || [])[1] || null;
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['tar', 'gzip', 'systemctl', 'useradd', 'usermod', 'userdel'].includes(n)])),
    'fs.mkdir': ({ path }) => ({ path }),
    'fs.stat': ({ path }) => (disk.has(path) ? { path, exists: true, isDirectory: false, size: disk.get(path).content.length } : { path, exists: false }),
    'backup.account.archive': async ({ username, dest, include }) => {
      if (state.hold) await state.hold;
      const file = `${dest}/${nameFor(username)}`;
      const content = Buffer.from(`archive-of-${username}-${state.counter}-`.repeat(3));
      disk.set(file, { content, username, include });
      return { path: file, name: file.split('/').pop(), top: 'x', sizeBytes: content.length, sha256: 'a'.repeat(64), sha256File: `${file}.sha256`, components: { home: { included: include.home }, mysql: [], users: 0, dnszones: [], metadata: true }, warnings: [], durationMs: 1 };
    },
    'backup.archive.info': ({ archive }) => { const a = disk.get(archive); if (!a) throw fail('not_found', `${archive} does not exist`); const username = userOf(archive); return state.infoFor ? state.infoFor(archive, a) : { path: archive, top: 'x', username, sizeBytes: a.content.length, info: { version: 1, createdAt: '2026-10-25T02:00:00.000Z' }, metadata: a.metadata ?? null, components: { home: true, mysql: [], users: false, dnszones: [] } }; },
    'backup.archive.verify': ({ archive, sha256 }) => { const a = disk.get(archive); if (!a) throw fail('not_found', 'missing'); return { path: archive, sha256: sha256 ?? 'b'.repeat(64), expected: sha256 ?? null, ok: sha256 ? true : null, sizeBytes: a.content.length }; },
    'backup.archive.inspect': ({ archive, prefix }) => ({ path: archive, top: 'x', prefix, total: 1, truncated: false, entries: [{ name: 'public_html', path: `${prefix}/public_html`, type: 'dir', size: 10, files: 1, mtime: '2026-10-25 02:00' }] }),
    'backup.archive.read_range': ({ archive, offset, length }) => {
      const a = disk.get(archive); if (!a) throw fail('not_found', 'missing');
      const want = Math.min(length, 7, Math.max(0, a.content.length - offset));
      const data = a.content.subarray(offset, offset + want);
      return { path: archive, size: a.content.length, offset, length: data.length, data: data.toString('base64'), eof: offset + data.length >= a.content.length, mtime: '2026-10-25T02:00:00.000Z' };
    },
    'backup.archive.remove': ({ archive }) => ({ path: archive, removed: disk.delete(archive) }),
    'backup.files.restore': ({ archive, username, homeDir, paths }) => ({ archive, homeDir, username, restored: paths, missing: [], overwrite: true, warnings: [] }),
    'transfer.upload.append': ({ path, data, truncate }) => { const buf = Buffer.from(data, 'base64'); const prev = truncate || !disk.has(path) ? Buffer.alloc(0) : disk.get(path).content; disk.set(path, { content: Buffer.concat([prev, buf]), username: userOf(path) }); return { path, bytes: buf.length, size: disk.get(path).content.length }; },
  };
  const agent = createMockAgent(ops);
  agent.disk = disk;
  agent.state = state;
  return agent;
}

function stubPanel(ctx) {
  ctx.panel = {
    async scope(req) {
      const username = req.get('x-panel-account');
      const row = username && ctx.db.prepare('SELECT * FROM accounts WHERE username = ?').get(username);
      if (!row) throw new HttpError(403, 'no_account', 'No hosting account is linked to this login');
      const account = ctx.accounts.get(username, { id: null, username: 'test', role: 'root' });
      const owner = ctx.db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(row.owner_id);
      return { account, accountId: account.id, username, mode: 'user', actor: req.user, actingAs: null, owner, ownerPrincipal: { id: owner.id, username: owner.username, role: owner.role }, limits: {}, features: account.plan?.features || {} };
    },
  };
}

async function panelApp(app, registerFn) {
  const api = express();
  api.use(express.json({ limit: '2mb' }));
  api.use((req, _res, next) => {
    req.user = { id: 0, username: req.get('x-panel-account') || 'nobody', role: 'user' };
    if (req.get('x-token-scopes')) req.auth = { via: 'token', scopes: req.get('x-token-scopes').split(',') };
    req.audit = (entry) => app.ctx.auditRecord(req, entry);
    next();
  });
  const mount = await registerFn(app.ctx);
  api.use(`/api/panel${mount.path}`, mount.router);
  api.use(notFoundHandler);
  api.use(errorHandler(app.ctx.logger));
  return request(api);
}

function setPlan(app, username, patch) {
  const row = app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username);
  const plan = JSON.parse(row.plan_snapshot_json || '{}');
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(typeof patch === 'function' ? patch(plan) : { ...plan, ...patch }), username);
}

describe('panel backup helpers', () => {
  it('names uploads after the account so the archive can only claim that account', () => {
    const d = new Date(2026, 9, 26, 2, 5, 9);
    expect(uploadFileName('alice', 'whatever-bob.tar.gz', d)).toBe('backup-10.26.2026_02-05-09_alice.tar.gz');
    expect(uploadFileName('alice', 'site.tgz', d)).toBe('backup-10.26.2026_02-05-09_alice.tar.gz');
    expect(uploadFileName('alice', 'site.tar', d)).toBe('backup-10.26.2026_02-05-09_alice.tar');
    expect(RANGE_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('/api/panel/backups', () => {
  let app;
  let api;
  let csrf;
  const as = (user) => ({ 'X-Panel-Account': user });
  const get = (p, user = 'alice') => api.get(`/api/panel/backups${p}`).set(as(user));
  const post = (p, body = {}, user = 'alice') => api.post(`/api/panel/backups${p}`).set(as(user)).send(body);
  const put = (p, body = {}, user = 'alice') => api.put(`/api/panel/backups${p}`).set(as(user)).send(body);
  const del = (p, user = 'alice') => api.delete(`/api/panel/backups${p}`).set(as(user));
  let systemRowId;

  beforeAll(async () => {
    app = await createTestApp({ agent: backupAgent() });
    csrf = await app.login();
    app.ctx.jobs.start();
    await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', owner: 'resell1' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com' }).expect(201);
    stubPanel(app.ctx);
    api = await panelApp(app, register);
    // A scheduled (WHM-side) archive of alice and one of bob, recorded the way backup.js does.
    const alice = app.ctx.db.prepare("SELECT id, owner_id FROM accounts WHERE username = 'alice'").get();
    const bob = app.ctx.db.prepare("SELECT id, owner_id FROM accounts WHERE username = 'bob'").get();
    const ins = app.ctx.db.prepare("INSERT INTO backups (account_id, account_name, owner_id, type, path, size, sha256, status, retention_class, components_json, local_present) VALUES (?, ?, ?, 'full', ?, 10, ?, 'done', 'daily', '{}', 1)");
    systemRowId = Number(ins.run(alice.id, 'alice', alice.owner_id, '/backup/backup-10.20.2026_02-00-00_alice.tar.gz', 'c'.repeat(64)).lastInsertRowid);
    app.agent.disk.set('/backup/backup-10.20.2026_02-00-00_alice.tar.gz', { content: Buffer.from('0123456789'), username: 'alice' });
    ins.run(bob.id, 'bob', bob.owner_id, '/backup/backup-10.20.2026_02-00-00_bob.tar.gz', 'd'.repeat(64));
    app.agent.disk.set('/backup/backup-10.20.2026_02-00-00_bob.tar.gz', { content: Buffer.from('bobbobbob'), username: 'bob' });
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; app.agent.state.infoFor = null; });

  it('refuses without a pinned account, the panel service or the token scope', async () => {
    expect((await api.get('/api/panel/backups').expect(403)).body.error.code).toBe('no_account');
    const panel = app.ctx.panel;
    delete app.ctx.panel;
    try { expect((await get('/').expect(403)).body.error.code).toBe('panel_scope_required'); } finally { app.ctx.panel = panel; }
    await get('/').set('X-Token-Scopes', 'panel:files').expect(403);
    await get('/').set('X-Token-Scopes', 'panel:backups').expect(200);
  });

  it('lists only the account\'s rows and marks WHM-side archives as not downloadable', async () => {
    const res = await get('/').expect(200);
    expect(res.body.data.map((b) => b.account)).toEqual(['alice']);
    expect(res.body.data[0]).toMatchObject({ id: systemRowId, retention_class: 'daily', panelOwned: false, downloadable: false, kind: 'full' });
    expect(res.body.meta).toMatchObject({ total: 1, running: null, kinds: ['home', 'full'] });
    const bobRow = app.ctx.db.prepare("SELECT id FROM backups WHERE account_name = 'bob'").get();
    await get(`/${bobRow.id}`).expect(404);
    await get(`/${bobRow.id}/browse`).expect(404);
    await get(`/${bobRow.id}/download`).expect(404);
    await post(`/${bobRow.id}/restore`, { paths: ['public_html'] }).expect(404);
    await del(`/${bobRow.id}`).expect(404);
    expect(app.agent.callsTo('backup.archive.read_range')).toHaveLength(0);
    expect(app.ctx.db.prepare("SELECT 1 FROM backups WHERE account_name = 'bob'").get()).toBeTruthy();
  });

  it('generates a home backup as a job owned by the account\'s owner, one at a time per account', async () => {
    let release;
    app.agent.state.hold = new Promise((r) => { release = r; });
    const first = await post('/', { kind: 'home' }).expect(202);
    const jobId = first.body.data.job.id;
    const busy = await post('/', { kind: 'full' }).expect(409);
    expect(busy.body.error.code).toBe('busy');
    const listing = await get('/').expect(200);
    expect(listing.body.meta.running).toMatchObject({ id: jobId, kind: 'home' });
    await post('/', { kind: 'home' }, 'bob').expect(202);
    release();
    app.agent.state.hold = null;
    const job = await waitForJob(app.ctx, jobId);
    expect(job.status).toBe('done');
    const archive = app.agent.callsTo('backup.account.archive').find((c) => c.args.username === 'alice').args;
    expect(archive).toMatchObject({ username: 'alice', dest: '/backup', include: { home: true, mail: true, dbs: false, dns: false, metadata: true } });
    const row = app.ctx.db.prepare('SELECT * FROM backups WHERE id = ?').get(job.result.backupId);
    expect(row).toMatchObject({ account_name: 'alice', retention_class: 'panel', status: 'done', local_present: 1 });
    expect(row.owner_id).toBe(app.ctx.db.prepare("SELECT owner_id FROM accounts WHERE username = 'alice'").get().owner_id);
    const audit = app.ctx.db.prepare("SELECT principal FROM audit_log WHERE action = 'backup.account' AND target = 'alice' ORDER BY id DESC LIMIT 1").get();
    expect(audit.principal).toBe('resell1');
    await post('/', { kind: 'account' }).expect(422);
    await post('/', { kind: 'home', destDir: '/etc' }).expect(422);
    setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), backup: false } }));
    try { expect((await post('/', { kind: 'home' }).expect(403)).body.error.code).toBe('feature_disabled'); } finally { setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), backup: true } })); }
  });

  it('shows archive info and browses through the owner principal', async () => {
    const row = app.ctx.db.prepare("SELECT id FROM backups WHERE account_name = 'alice' AND retention_class = 'panel' ORDER BY id DESC LIMIT 1").get();
    const res = await get(`/${row.id}`).expect(200);
    expect(res.body.data).toMatchObject({ id: row.id, panelOwned: true, downloadable: true, kind: 'home' });
    expect(res.body.data.archive).toMatchObject({ username: 'alice' });
    const browse = await get(`/${row.id}/browse?prefix=homedir/public_html`).expect(200);
    expect(browse.body.data.entries[0].name).toBe('public_html');
    await get(`/${row.id}/browse?prefix=../etc`).expect(422);
  });

  it('streams panel archives through the range op and refuses WHM-side ones', async () => {
    const forbidden = await get(`/${systemRowId}/download`).expect(403);
    expect(forbidden.body.error.code).toBe('not_downloadable');
    const row = app.ctx.db.prepare("SELECT id, path FROM backups WHERE account_name = 'alice' AND retention_class = 'panel' ORDER BY id DESC LIMIT 1").get();
    const expected = app.agent.disk.get(row.path).content;
    const res = await get(`/${row.id}/download`).buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
    expect(res.headers['content-length']).toBe(String(expected.length));
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${row.path.split('/').pop()}"`);
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(Buffer.compare(res.body, expected)).toBe(0);
    const ranges = app.agent.callsTo('backup.archive.read_range');
    expect(ranges.length).toBe(Math.ceil(expected.length / 7));
    expect(ranges.every((c) => c.args.archive === row.path && c.args.length <= RANGE_BYTES)).toBe(true);
    expect(ranges.map((c) => c.args.offset)).toEqual(ranges.map((_, i) => i * 7));
    expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'panel.backup.download' AND target = 'alice'").get()).toBeTruthy();
  });

  it('restores files only (never a whole account) with relative paths', async () => {
    const row = app.ctx.db.prepare("SELECT id FROM backups WHERE account_name = 'alice' AND retention_class = 'panel' ORDER BY id DESC LIMIT 1").get();
    for (const paths of [[], ['../etc'], ['/etc/passwd'], ['-rf'], ['a\nb']]) await post(`/${row.id}/restore`, { paths }).expect(422);
    await post(`/${row.id}/restore`, { paths: ['public_html'], kind: 'account' }).expect(422);
    const res = await post(`/${row.id}/restore`, { paths: ['public_html', 'mail/alice.com'], overwrite: true }).expect(202);
    const restore = app.ctx.db.prepare('SELECT * FROM backup_restores WHERE id = ?').get(res.body.data.restore.id);
    expect(restore).toMatchObject({ kind: 'files', account_name: 'alice', started_by: 'resell1' });
    expect(JSON.parse(restore.options_json)).toEqual({ paths: ['public_html', 'mail/alice.com'], overwrite: true });
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status, `${job.error} ${JSON.stringify(job.logs)}`).toBe('done');
    expect(app.agent.callsTo('backup.files.restore')[0].args).toMatchObject({ username: 'alice', paths: ['public_html', 'mail/alice.com'] });
    const restores = await get('/restores').expect(200);
    expect(restores.body.data.map((r) => r.kind)).toEqual(['files']);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backup_restores WHERE kind = 'account'").get().n).toBe(0);
  });

  it('uploads an archive in chunks and registers it under the account only when the archive agrees', async () => {
    const content = Buffer.from('uploaded-archive-bytes-'.repeat(2));
    const begin = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: content.length }).expect(201);
    expect(begin.body.data).toMatchObject({ name: 'cpmove-alice.tar.gz', size: content.length, received: 0 });
    const id = begin.body.data.id;
    await put(`/uploads/${id}/chunks`, { data: content.subarray(0, 20).toString('base64') }).expect(200);
    await get(`/uploads/${id}`, 'bob').expect(404);
    await put(`/uploads/${id}/chunks`, { data: content.subarray(20).toString('base64') }, 'bob').expect(404);
    await put(`/uploads/${id}/chunks`, { data: Buffer.from('x'.repeat(40)).toString('base64') }).expect(422);
    await post(`/uploads/${id}/finish`).expect(422);
    await put(`/uploads/${id}/chunks`, { data: content.subarray(20).toString('base64') }).expect(200);
    const fin = await post(`/uploads/${id}/finish`).expect(201);
    expect(fin.body.data).toMatchObject({ account: 'alice', type: 'import', retention_class: 'panel', panelOwned: true, downloadable: true, kind: 'upload' });
    expect(fin.body.data.name).toMatch(/^backup-\d{2}\.\d{2}\.\d{4}_\d{2}-\d{2}-\d{2}_alice\.tar\.gz$/);
    const appends = app.agent.callsTo('transfer.upload.append');
    expect(appends.map((c) => c.args.truncate)).toEqual([true, false]);
    expect(appends.every((c) => c.args.path.startsWith('/backup/') && c.args.path.endsWith('_alice.tar.gz'))).toBe(true);
    const row = app.ctx.db.prepare('SELECT * FROM backups WHERE id = ?').get(fin.body.data.id);
    expect(row).toMatchObject({ account_name: 'alice', retention_class: 'panel', type: 'import', size: content.length, sha256: 'b'.repeat(64) });
    expect(row.account_id).toBe(app.ctx.db.prepare("SELECT id FROM accounts WHERE username = 'alice'").get().id);
    expect(Buffer.compare(app.agent.disk.get(row.path).content, content)).toBe(0);
    await get(`/uploads/${id}`).expect(404);
    for (const name of ['../x.tar.gz', '.hidden.tar.gz', 'x.zip', 'a b.tar.gz', '']) await post('/uploads', { name, size: 10 }).expect(422);
  });

  it('rejects an uploaded archive that belongs to another account and removes the file', async () => {
    app.agent.state.infoFor = (archive, a) => ({ path: archive, top: 'x', username: 'alice', sizeBytes: a.content.length, info: { version: 1 }, metadata: { account: { username: 'bob' } }, components: { home: true } });
    const content = Buffer.from('bobs-archive');
    const begin = await post('/uploads', { name: 'cpmove-bob.tar.gz', size: content.length }).expect(201);
    await put(`/uploads/${begin.body.data.id}/chunks`, { data: content.toString('base64') }).expect(200);
    const res = await post(`/uploads/${begin.body.data.id}/finish`).expect(422);
    expect(res.body.error.code).toBe('wrong_account');
    const removed = app.agent.callsTo('backup.archive.remove');
    expect(removed).toHaveLength(1);
    expect(app.agent.disk.has(removed[0].args.archive)).toBe(false);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backups WHERE type = 'import'").get().n).toBe(1);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backups WHERE path = ?").get(removed[0].args.archive).n).toBe(0);
    const aborted = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: 5 }).expect(201);
    await put(`/uploads/${aborted.body.data.id}/chunks`, { data: Buffer.from('abc').toString('base64') }).expect(200);
    await post(`/uploads/${aborted.body.data.id}/abort`).expect(200);
    expect(app.agent.callsTo('backup.archive.remove')).toHaveLength(2);
  });

  it('deletes only panel-owned rows', async () => {
    const forbidden = await del(`/${systemRowId}`).expect(403);
    expect(forbidden.body.error.code).toBe('not_deletable');
    const row = app.ctx.db.prepare("SELECT id, path FROM backups WHERE account_name = 'alice' AND type = 'import' ORDER BY id DESC LIMIT 1").get();
    const res = await del(`/${row.id}`).expect(200);
    expect(res.body.data).toMatchObject({ id: row.id, deleted: true });
    expect(app.agent.callsTo('backup.archive.remove')[0].args.archive).toBe(row.path);
    expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(row.id)).toBeFalsy();
    expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(systemRowId)).toBeTruthy();
  });
});
