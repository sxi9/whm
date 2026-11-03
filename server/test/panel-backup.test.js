import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { errorHandler, notFoundHandler } from '../src/middleware/error.js';
import { HttpError } from '../src/lib/errors.js';
import { register } from '../src/routes/panel/backups.js';
import { uploadFileName, verifyTimeoutMs, RANGE_BYTES, UPLOAD_TTL_MS, DEFAULTS, MAINTAIN_JOB, MAINTAIN_SCHEDULE } from '../src/services/panel-backup.js';

// A host with tar: archives live in an in-memory disk keyed by path so the
// panel's rows, the range download loop and the upload → register flow are
// checked end to end. backup.account.archive and backup.archive.info can be
// held open to test the one-job-per-account and one-verification rules.
function backupAgent() {
  const disk = new Map();
  const state = { hold: null, holdInfo: null, counter: 0, infoFor: null };
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
    'backup.archive.info': async ({ archive }) => { if (state.holdInfo) await state.holdInfo; const a = disk.get(archive); if (!a) throw fail('not_found', `${archive} does not exist`); const username = userOf(archive); return state.infoFor ? state.infoFor(archive, a) : { path: archive, top: 'x', username, sizeBytes: a.content.length, info: { version: 1, createdAt: '2026-10-25T02:00:00.000Z' }, metadata: a.metadata ?? null, components: { home: true, mysql: [], users: false, dnszones: [] } }; },
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

const MiB = 1024 * 1024;

describe('panel backup helpers', () => {
  it('names uploads after the account so the archive can only claim that account', () => {
    const d = new Date(2026, 9, 26, 2, 5, 9);
    expect(uploadFileName('alice', 'whatever-bob.tar.gz', d)).toBe('backup-10.26.2026_02-05-09_alice.tar.gz');
    expect(uploadFileName('alice', 'site.tgz', d)).toBe('backup-10.26.2026_02-05-09_alice.tar.gz');
    expect(uploadFileName('alice', 'site.tar', d)).toBe('backup-10.26.2026_02-05-09_alice.tar');
    expect(RANGE_BYTES).toBe(8 * 1024 * 1024);
  });

  it('bounds the root-side verification wait by the archive size', () => {
    expect(verifyTimeoutMs(0)).toBe(60_000);
    expect(verifyTimeoutMs(4 * MiB)).toBe(61_000);
    expect(verifyTimeoutMs(10 * 1024 * MiB)).toBe(30 * 60_000);
    expect(verifyTimeoutMs(10 * 1024 * 1024 * MiB)).toBe(30 * 60_000);
    expect(DEFAULTS['panel.backup.max_archives']).toBe(3);
    expect(UPLOAD_TTL_MS).toBe(6 * 3600_000);
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
  const accountId = (username) => app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get(username).id;
  // supertest requests are lazy; this sends one now and resolves with the response whatever its status.
  const started = (req) => new Promise((resolve, reject) => req.end((err, res) => (res ? resolve(res) : reject(err))));
  const panelRows = (username) => app.ctx.db.prepare("SELECT * FROM backups WHERE account_name = ? AND retention_class = 'panel' ORDER BY id").all(username);
  const upload = async (content, user = 'alice', name = `cpmove-${user}.tar.gz`) => {
    const begin = await post('/uploads', { name, size: content.length }, user).expect(201);
    await put(`/uploads/${begin.body.data.id}/chunks`, { data: content.toString('base64') }, user).expect(200);
    return begin.body.data;
  };
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
  afterAll(() => { vi.useRealTimers(); return app.close(); });
  beforeEach(() => { app.agent.calls.length = 0; app.agent.state.infoFor = null; app.agent.state.holdInfo = null; });

  it('registers the maintenance job and its schedule', () => {
    expect(app.ctx.jobs.types()).toContain(MAINTAIN_JOB);
    expect(app.ctx.scheduler.list().find((s) => s.name === MAINTAIN_SCHEDULE.name)).toMatchObject({ job_type: MAINTAIN_JOB, cron: MAINTAIN_SCHEDULE.cron });
  });

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
    expect(res.body.meta).toMatchObject({ total: 1, running: null, kinds: ['home', 'full'], limits: { maxArchives: 3, archives: 0, usedMb: 0, maxUploadMb: 10240 } });
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
    expect(listing.body.meta.limits.archives).toBe(1);
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

  it('fails the generate job closed when the owner is gone or changed, never falling back to a root principal', async () => {
    const alice = app.ctx.db.prepare("SELECT id, owner_id FROM accounts WHERE username = 'alice'").get();
    const rootId = app.ctx.db.prepare("SELECT id FROM users WHERE username = 'root'").get().id;
    const fake = (ownerId) => ({ params: { username: 'alice', accountId: alice.id, kind: 'home', ownerId, actor: 'alice' }, log() {}, progress() {} });
    await expect(app.ctx.panelBackup.runGenerate(fake(null))).rejects.toThrow(/owner .* no longer exists/);
    await expect(app.ctx.panelBackup.runGenerate(fake(987654))).rejects.toThrow(/owner .* no longer exists/);
    expect(rootId).not.toBe(alice.owner_id);
    await expect(app.ctx.panelBackup.runGenerate(fake(rootId))).rejects.toThrow(/changed owner/);
    expect(app.agent.callsTo('backup.account.archive')).toHaveLength(0);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'backup.account' AND principal = 'panel'").get().n).toBe(0);
    // The queued job carries the owner and a deleted owner row fails it at run time.
    await app.createUser('resell2', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.com', owner: 'resell2' }).expect(201);
    app.ctx.jobs.stop();
    const queued = await post('/', { kind: 'home' }, 'carol').expect(202);
    expect(app.ctx.jobs.get(queued.body.data.job.id).params.ownerId).toBe(app.ctx.db.prepare("SELECT id FROM users WHERE username = 'resell2'").get().id);
    app.ctx.db.prepare("UPDATE accounts SET owner_id = ? WHERE username = 'carol'").run(rootId);
    app.ctx.jobs.start();
    const job = await waitForJob(app.ctx, queued.body.data.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/changed owner/);
    expect(app.agent.callsTo('backup.account.archive')).toHaveLength(0);
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

  it('keeps .ssh out of a restore unless the request could write it directly (the file-manager gate)', async () => {
    const row = app.ctx.db.prepare("SELECT id FROM backups WHERE account_name = 'alice' AND retention_class = 'panel' ORDER BY id DESC LIMIT 1").get();
    // No shell access: .ssh (and the whole home, which contains it) cannot be named, over a session or a token.
    for (const paths of [['.ssh/authorized_keys'], ['.ssh'], ['.ssh/'], ['public_html', '.ssh/id_ed25519'], ['.']]) {
      const res = await post(`/${row.id}/restore`, { paths, overwrite: true });
      expect(res.status, JSON.stringify(paths)).toBe(403);
      expect(res.body.error.code).toBe('ssh_managed');
    }
    expect((await post(`/${row.id}/restore`, { paths: ['.ssh/authorized_keys'] }).set('X-Token-Scopes', 'panel:backups')).body.error.code).toBe('ssh_managed');
    expect(app.agent.callsTo('backup.files.restore')).toHaveLength(0);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backup_restores WHERE account_name = 'alice'").get().n).toBe(0);
    // Shell access + ssh feature + session login: .ssh may be restored and the agent is told so.
    setPlan(app, 'alice', (plan) => ({ ...plan, has_shell: true, features: { ...(plan.features || {}), ssh: true } }));
    try {
      const viaToken = await post(`/${row.id}/restore`, { paths: ['.ssh/authorized_keys'] }).set('X-Token-Scopes', 'panel:backups');
      expect(viaToken.status).toBe(403);
      const ok = await post(`/${row.id}/restore`, { paths: ['.ssh/authorized_keys'] }).expect(202);
      const job = await waitForJob(app.ctx, ok.body.data.job.id);
      expect(job.status, `${job.error}`).toBe('done');
      expect(app.agent.callsTo('backup.files.restore').at(-1).args).toMatchObject({ username: 'alice', paths: ['.ssh/authorized_keys'], excludeSshDir: false });
      const plain = await post(`/${row.id}/restore`, { paths: ['public_html'] }).set('X-Token-Scopes', 'panel:backups').expect(202);
      await waitForJob(app.ctx, plain.body.data.job.id);
      expect(app.agent.callsTo('backup.files.restore').at(-1).args).toMatchObject({ paths: ['public_html'], excludeSshDir: true });
    } finally {
      setPlan(app, 'alice', (plan) => ({ ...plan, has_shell: false }));
      app.ctx.db.prepare("DELETE FROM backup_restores WHERE account_name = 'alice'").run();
    }
  });

  it('restores files only (never a whole account) with relative paths', async () => {
    const row = app.ctx.db.prepare("SELECT id FROM backups WHERE account_name = 'alice' AND retention_class = 'panel' ORDER BY id DESC LIMIT 1").get();
    for (const paths of [[], ['../etc'], ['/etc/passwd'], ['-rf'], ['a\nb']]) await post(`/${row.id}/restore`, { paths }).expect(422);
    await post(`/${row.id}/restore`, { paths: ['public_html'], kind: 'account' }).expect(422);
    const res = await post(`/${row.id}/restore`, { paths: ['public_html', 'mail/alice.com'], overwrite: true }).expect(202);
    const restore = app.ctx.db.prepare('SELECT * FROM backup_restores WHERE id = ?').get(res.body.data.restore.id);
    expect(restore).toMatchObject({ kind: 'files', account_name: 'alice', started_by: 'resell1' });
    expect(JSON.parse(restore.options_json)).toEqual({ paths: ['public_html', 'mail/alice.com'], overwrite: true, excludeSshDir: true });
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status, `${job.error} ${JSON.stringify(job.logs)}`).toBe('done');
    expect(app.agent.callsTo('backup.files.restore')[0].args).toMatchObject({ username: 'alice', paths: ['public_html', 'mail/alice.com'], excludeSshDir: true });
    const restores = await get('/restores').expect(200);
    expect(restores.body.data.map((r) => r.kind)).toEqual(['files']);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backup_restores WHERE kind = 'account'").get().n).toBe(0);
  });

  it('uploads in chunks: the in-flight upload is a backups row, an early finish discards it, a complete one registers it', async () => {
    const content = Buffer.from('uploaded-archive-bytes-'.repeat(2));
    const begin = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: content.length }).expect(201);
    expect(begin.body.data).toMatchObject({ name: 'cpmove-alice.tar.gz', size: content.length, received: 0 });
    const id = begin.body.data.id;
    const inflight = app.ctx.db.prepare('SELECT * FROM backups WHERE id = ?').get(begin.body.data.backupId);
    expect(inflight).toMatchObject({ account_name: 'alice', account_id: accountId('alice'), status: 'uploading', retention_class: 'panel', type: 'import', size: content.length, sha256: null });
    const listed = (await get('/').expect(200)).body.data.find((b) => b.id === inflight.id);
    expect(listed).toMatchObject({ status: 'uploading', downloadable: false, kind: 'upload' });
    await get(`/${inflight.id}/download`).expect(409);
    await get(`/${inflight.id}/browse`).expect(409);
    await put(`/uploads/${id}/chunks`, { data: content.subarray(0, 20).toString('base64') }).expect(200);
    await get(`/uploads/${id}`, 'bob').expect(404);
    await put(`/uploads/${id}/chunks`, { data: content.subarray(20).toString('base64') }, 'bob').expect(404);
    await put(`/uploads/${id}/chunks`, { data: Buffer.from('x'.repeat(40)).toString('base64') }).expect(422);
    const early = await post(`/uploads/${id}/finish`).expect(422);
    expect(early.body.error.message).toMatch(/discarded/);
    expect(app.agent.callsTo('backup.archive.remove').map((c) => c.args.archive)).toEqual([inflight.path]);
    expect(app.agent.disk.has(inflight.path)).toBe(false);
    expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(inflight.id)).toBeFalsy();
    await get(`/uploads/${id}`).expect(404);
    await put(`/uploads/${id}/chunks`, { data: content.subarray(20).toString('base64') }).expect(404);
    expect(app.agent.callsTo('backup.archive.info')).toHaveLength(0);

    const again = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: content.length }).expect(201);
    await put(`/uploads/${again.body.data.id}/chunks`, { data: content.subarray(0, 20).toString('base64') }).expect(200);
    await put(`/uploads/${again.body.data.id}/chunks`, { data: content.subarray(20).toString('base64') }).expect(200);
    const fin = await post(`/uploads/${again.body.data.id}/finish`).expect(201);
    expect(fin.body.data).toMatchObject({ id: again.body.data.backupId, account: 'alice', type: 'import', status: 'done', retention_class: 'panel', panelOwned: true, downloadable: true, kind: 'upload' });
    expect(fin.body.data.name).toMatch(/^backup-\d{2}\.\d{2}\.\d{4}_\d{2}-\d{2}-\d{2}_alice\.tar\.gz$/);
    const appends = app.agent.callsTo('transfer.upload.append');
    expect(appends.slice(-2).map((c) => c.args.truncate)).toEqual([true, false]);
    expect(appends.every((c) => c.args.path.startsWith('/backup/') && c.args.path.endsWith('_alice.tar.gz'))).toBe(true);
    const row = app.ctx.db.prepare('SELECT * FROM backups WHERE id = ?').get(fin.body.data.id);
    expect(row).toMatchObject({ account_name: 'alice', retention_class: 'panel', type: 'import', status: 'done', size: content.length, sha256: 'b'.repeat(64) });
    expect(JSON.parse(row.components_json)).toMatchObject({ uploaded: true, originalName: 'cpmove-alice.tar.gz' });
    expect(Buffer.compare(app.agent.disk.get(row.path).content, content)).toBe(0);
    await get(`/uploads/${again.body.data.id}`).expect(404);
    const info = app.agent.callsTo('backup.archive.info');
    expect(info).toHaveLength(1);
    for (const name of ['../x.tar.gz', '.hidden.tar.gz', 'x.zip', 'a b.tar.gz', '']) await post('/uploads', { name, size: 10 }).expect(422);
  });

  it('rejects an uploaded archive that belongs to another account and removes the file', async () => {
    app.agent.state.infoFor = (archive, a) => ({ path: archive, top: 'x', username: 'alice', sizeBytes: a.content.length, info: { version: 1 }, metadata: { account: { username: 'bob' } }, components: { home: true } });
    const content = Buffer.from('bobs-archive');
    const begin = await upload(content, 'alice', 'cpmove-bob.tar.gz');
    const res = await post(`/uploads/${begin.id}/finish`).expect(422);
    expect(res.body.error.code).toBe('wrong_account');
    const removed = app.agent.callsTo('backup.archive.remove');
    expect(removed).toHaveLength(1);
    expect(app.agent.disk.has(removed[0].args.archive)).toBe(false);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backups WHERE type = 'import'").get().n).toBe(1);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backups WHERE path = ?").get(removed[0].args.archive).n).toBe(0);
    // A wrong account is the customer's mistake, not a hostile archive: no cooldown.
    const aborted = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: 5 }).expect(201);
    await put(`/uploads/${aborted.body.data.id}/chunks`, { data: Buffer.from('abc').toString('base64') }).expect(200);
    await post(`/uploads/${aborted.body.data.id}/abort`).expect(200);
    expect(app.agent.callsTo('backup.archive.remove')).toHaveLength(2);
    expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(aborted.body.data.backupId)).toBeFalsy();
  });

  it('caps panel archives per account and their bytes before any file is touched', async () => {
    const used = panelRows('alice');
    expect(used.map((r) => r.status)).toEqual(['done', 'done']);
    app.ctx.settings.set('panel.backup.max_archives', 2);
    try {
      const gen = await post('/', { kind: 'full' }).expect(409);
      expect(gen.body.error.code).toBe('limit_reached');
      const up = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: 10 }).expect(409);
      expect(up.body.error.code).toBe('limit_reached');
      expect(app.agent.calls.filter((c) => ['fs.mkdir', 'transfer.upload.append', 'backup.account.archive'].includes(c.name))).toHaveLength(0);
      expect(app.ctx.jobs.list({ type: 'panel.backup.generate', status: 'queued' })).toHaveLength(0);
      expect((await get('/').expect(200)).body.meta.limits).toMatchObject({ maxArchives: 2, archives: 2 });
      // bob (one panel archive) is unaffected by alice's count.
      await post('/uploads', { name: 'cpmove-bob.tar.gz', size: 10 }, 'bob').expect(201).then((r) => post(`/uploads/${r.body.data.id}/abort`, {}, 'bob').expect(200));
    } finally { app.ctx.settings.set('panel.backup.max_archives', 3); }

    // Byte budget: the account disk quota bounds what panel archives may hold.
    app.ctx.db.prepare("UPDATE accounts SET disk_quota_mb = 1, disk_used_mb = 2 WHERE username = 'alice'").run();
    app.agent.calls.length = 0;
    try {
      const big = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: 2 * MiB }).expect(422);
      expect(big.body.error.fields.size).toBeDefined();
      app.ctx.db.prepare('UPDATE backups SET size = ? WHERE id = ?').run(900 * 1024, used[1].id);
      const over = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: 200 * 1024 }).expect(409);
      expect(over.body.error.code).toBe('limit_reached');
      const gen = await post('/', { kind: 'home' }).expect(409);
      expect(gen.body.error.code).toBe('limit_reached');
      expect(app.agent.calls.filter((c) => ['fs.mkdir', 'transfer.upload.append', 'backup.account.archive'].includes(c.name))).toHaveLength(0);
      expect((await get('/').expect(200)).body.meta.limits).toMatchObject({ totalMb: 1, usedMb: 1 });
      app.ctx.settings.set('panel.backup.max_total_mb', 5);
      expect((await get('/').expect(200)).body.meta.limits.totalMb).toBe(5);
      await post('/uploads', { name: 'cpmove-alice.tar.gz', size: 200 * 1024 }).expect(201).then((r) => post(`/uploads/${r.body.data.id}/abort`).expect(200));
    } finally {
      app.ctx.settings.set('panel.backup.max_total_mb', null);
      app.ctx.db.prepare('UPDATE backups SET size = ? WHERE id = ?').run(used[1].size, used[1].id);
      app.ctx.db.prepare("UPDATE accounts SET disk_quota_mb = NULL, disk_used_mb = 0 WHERE username = 'alice'").run();
    }

    // Per-upload ceiling and one open upload per account.
    app.ctx.settings.set('panel.backup.max_upload_mb', 1);
    try {
      const big = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: MiB + 1 }).expect(422);
      expect(big.body.error.fields.size).toBeDefined();
    } finally { app.ctx.settings.set('panel.backup.max_upload_mb', DEFAULTS['panel.backup.max_upload_mb']); }
    const open = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: 10 }).expect(201);
    const second = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: 10 }).expect(409);
    expect(second.body.error.code).toBe('busy');
    await post(`/uploads/${open.body.data.id}/abort`).expect(200);
  });

  it('serialises chunks of one upload and discards it when the file on disk drifts from what was sent', async () => {
    const content = Buffer.from('abcdefghij');
    const begin = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: content.length }).expect(201);
    const id = begin.body.data.id;
    const file = app.ctx.db.prepare('SELECT path FROM backups WHERE id = ?').get(begin.body.data.backupId).path;
    let release;
    const hold = new Promise((r) => { release = r; });
    app.agent.set('transfer.upload.append', async (args) => { await hold; return { path: args.path, bytes: 5, size: 5 }; });
    try {
      const first = started(put(`/uploads/${id}/chunks`, { data: content.subarray(0, 5).toString('base64') }));
      await new Promise((r) => setTimeout(r, 20));
      const parallel = await put(`/uploads/${id}/chunks`, { data: content.subarray(5).toString('base64') }).expect(409);
      expect(parallel.body.error.code).toBe('busy');
      release();
      const done = await first;
      expect(done.status).toBe(200);
      expect(done.body.data.received).toBe(5);
    } finally { app.agent.set('transfer.upload.append', (args) => ({ path: args.path, bytes: 99, size: 99 })); }
    const drift = await put(`/uploads/${id}/chunks`, { data: content.subarray(5).toString('base64') }).expect(422);
    expect(drift.body.error.message).toMatch(/no longer matches/);
    expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(begin.body.data.backupId)).toBeFalsy();
    expect(app.agent.callsTo('backup.archive.remove').map((c) => c.args.archive)).toEqual([file]);
    await get(`/uploads/${id}`).expect(404);
    const disk = app.agent.disk;
    app.agent.set('transfer.upload.append', ({ path, data, truncate }) => { const buf = Buffer.from(data, 'base64'); const prev = truncate || !disk.has(path) ? Buffer.alloc(0) : disk.get(path).content; disk.set(path, { content: Buffer.concat([prev, buf]) }); return { path, bytes: buf.length, size: disk.get(path).content.length }; });
  });

  it('deletes only panel-owned rows, including an in-flight upload', async () => {
    const forbidden = await del(`/${systemRowId}`).expect(403);
    expect(forbidden.body.error.code).toBe('not_deletable');
    const row = app.ctx.db.prepare("SELECT id, path FROM backups WHERE account_name = 'alice' AND type = 'import' AND status = 'done' ORDER BY id DESC LIMIT 1").get();
    const res = await del(`/${row.id}`).expect(200);
    expect(res.body.data).toMatchObject({ id: row.id, deleted: true });
    expect(app.agent.callsTo('backup.archive.remove')[0].args.archive).toBe(row.path);
    expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(row.id)).toBeFalsy();
    expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(systemRowId)).toBeTruthy();
    const open = await upload(Buffer.from('abc'));
    await del(`/${open.backupId}`).expect(200);
    expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(open.backupId)).toBeFalsy();
    expect(app.agent.callsTo('backup.archive.remove')).toHaveLength(2);
    await get(`/uploads/${open.id}`).expect(404);
  });

  it('removes expired upload sessions and uploads orphaned by a restart, files included', async () => {
    const stale = await upload(Buffer.from('stale-bytes'));
    const path = app.ctx.db.prepare('SELECT path FROM backups WHERE id = ?').get(stale.backupId).path;
    expect(app.agent.disk.has(path)).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + UPLOAD_TTL_MS + 60_000);
      // Any account's next upload sweeps what expired.
      const bobs = await post('/uploads', { name: 'cpmove-bob.tar.gz', size: 3 }, 'bob').expect(201);
      await post(`/uploads/${bobs.body.data.id}/abort`, {}, 'bob').expect(200);
    } finally { vi.useRealTimers(); }
    expect(app.agent.disk.has(path)).toBe(false);
    expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(stale.backupId)).toBeFalsy();
    await get(`/uploads/${stale.id}`).expect(404);
    expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'panel.backup.upload.expire' AND target = 'alice'").get()).toBeTruthy();

    // A row left 'uploading' by a previous process (no session in memory) goes at boot.
    const orphanPath = '/backup/backup-10.30.2026_01-02-03_alice.tar.gz';
    app.agent.disk.set(orphanPath, { content: Buffer.from('orphan'), username: 'alice' });
    const { lastInsertRowid } = app.ctx.db.prepare("INSERT INTO backups (account_id, account_name, type, path, size, status, retention_class, components_json, local_present) VALUES (?, 'alice', 'import', ?, 6, 'uploading', 'panel', '{\"uploaded\":true}', 1)").run(accountId('alice'), orphanPath);
    const swept = await app.ctx.panelBackup.sweep({ all: true });
    expect(swept).toEqual([{ id: Number(lastInsertRowid), path: orphanPath, account: 'alice', removed: true }]);
    expect(app.agent.disk.has(orphanPath)).toBe(false);
    expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(lastInsertRowid)).toBeFalsy();
    // Boot registration schedules exactly that sweep.
    app.agent.disk.set(orphanPath, { content: Buffer.from('orphan'), username: 'alice' });
    app.ctx.db.prepare("INSERT INTO backups (account_id, account_name, type, path, size, status, retention_class, components_json, local_present) VALUES (?, 'alice', 'import', ?, 6, 'uploading', 'panel', '{}', 1)").run(accountId('alice'), orphanPath);
    await register(app.ctx);
    await new Promise((r) => setImmediate(() => setTimeout(r, 20)));
    expect(app.agent.disk.has(orphanPath)).toBe(false);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backups WHERE status = 'uploading'").get().n).toBe(0);
  });

  it('prunes panel archives beyond the per-account cap, oldest first, leaving system backups alone', async () => {
    const extra = app.ctx.db.prepare("INSERT INTO backups (account_id, account_name, type, path, size, sha256, status, retention_class, components_json, local_present, created_at) VALUES (?, 'alice', 'full', ?, 9, ?, 'done', 'panel', '{\"include\":{\"dbs\":true}}', 1, ?)");
    const older = Number(extra.run(accountId('alice'), '/backup/backup-10.01.2026_02-00-00_alice.tar.gz', 'e'.repeat(64), '2026-10-01 02:00:00').lastInsertRowid);
    const newer = Number(extra.run(accountId('alice'), '/backup/backup-10.02.2026_02-00-00_alice.tar.gz', 'f'.repeat(64), '2026-10-02 02:00:00').lastInsertRowid);
    for (const p of ['/backup/backup-10.01.2026_02-00-00_alice.tar.gz', '/backup/backup-10.02.2026_02-00-00_alice.tar.gz']) app.agent.disk.set(p, { content: Buffer.from('x'), username: 'alice' });
    expect(panelRows('alice')).toHaveLength(3);
    app.ctx.settings.set('panel.backup.max_archives', 1);
    try {
      const { swept, pruned } = await app.ctx.panelBackup.maintain({ log() {} });
      expect(swept).toEqual([]);
      expect(pruned.map((p) => p.id)).toEqual([older, newer]);
      expect(panelRows('alice')).toHaveLength(1);
      expect(app.agent.disk.has('/backup/backup-10.01.2026_02-00-00_alice.tar.gz')).toBe(false);
      expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(systemRowId)).toBeTruthy();
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backups WHERE account_name = 'bob'").get().n).toBe(2);
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'panel.backup.prune' AND target = 'alice'").get().n).toBe(2);
      const job = app.ctx.jobs.enqueue(MAINTAIN_JOB, {});
      expect((await waitForJob(app.ctx, job.id)).status).toBe('done');
    } finally { app.ctx.settings.set('panel.backup.max_archives', 3); }
  });

  it('bounds the root-side verification: one at a time, sized wait, and a cooldown after a hostile archive', async () => {
    let release;
    app.agent.state.holdInfo = new Promise((r) => { release = r; });
    const alice = await upload(Buffer.from('alice-archive'));
    const bob = await upload(Buffer.from('bob-archive'), 'bob');
    const pending = started(post(`/uploads/${alice.id}/finish`));
    await new Promise((r) => setTimeout(r, 30));
    const busy = await post(`/uploads/${bob.id}/finish`, {}, 'bob').expect(409);
    expect(busy.body.error.code).toBe('busy');
    await get(`/uploads/${bob.id}`, 'bob').expect(200);
    release();
    app.agent.state.holdInfo = null;
    const finished = await pending;
    expect(finished.status, JSON.stringify(finished.body)).toBe(201);
    expect(finished.body.data.status).toBe('done');
    await post(`/uploads/${bob.id}/finish`, {}, 'bob').expect(201);
    const infoCalls = app.agent.calls.filter((c) => c.name === 'backup.archive.info');
    expect(infoCalls).toHaveLength(2);
    expect(app.agent.callsTo('backup.archive.verify')).toHaveLength(2);
    for (const r of [...panelRows('alice'), ...panelRows('bob')].filter((x) => x.type === 'import')) await del(`/${r.id}`, r.account_name).expect(200);

    // A verification that fails (a crafted archive, a tar timeout) discards the file and closes uploads for a while.
    app.agent.state.infoFor = () => { throw Object.assign(new Error('tar: archive is not sane'), { agentError: true, code: 'command_failed', details: {} }); };
    const hostile = await upload(Buffer.from('bomb'));
    await post(`/uploads/${hostile.id}/finish`).expect(500);
    expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(hostile.backupId)).toBeFalsy();
    expect(app.agent.callsTo('backup.archive.remove').map((c) => c.args.archive)).toContain(app.agent.calls.find((c) => c.name === 'backup.archive.info' && c.args.archive.includes('_alice.')).args.archive);
    const cooled = await post('/uploads', { name: 'cpmove-alice.tar.gz', size: 4 }).expect(429);
    expect(cooled.body.error.code).toBe('verify_cooldown');
    await post('/uploads', { name: 'cpmove-bob.tar.gz', size: 4 }, 'bob').expect(201).then((r) => post(`/uploads/${r.body.data.id}/abort`, {}, 'bob').expect(200));
    expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'panel.backup.upload' AND result = 'error' AND target = 'alice' AND args_redacted LIKE '%verify_failed%'").get()).toBeTruthy();
    app.agent.state.infoFor = null;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + DEFAULTS['panel.backup.verify_cooldown_minutes'] * 60_000 + 1000);
      await post('/uploads', { name: 'cpmove-alice.tar.gz', size: 4 }).expect(201).then((r) => post(`/uploads/${r.body.data.id}/abort`).expect(200));
    } finally { vi.useRealTimers(); }
  });
});
