import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { retentionClassFor, planPrune, publicDestinationConfig } from '../src/services/backup.js';

// A mock agent that behaves like a host with tar/gzip/curl: archives are kept
// in an in-memory "disk" keyed by path, destinations in a per-kind store, so
// the service's bookkeeping (rows, uploads, pruning, restores) is checked end
// to end without touching the filesystem.
function backupAgent({ binaries = ['tar', 'gzip', 'curl', 'systemctl', 'useradd', 'usermod', 'userdel', 'chpasswd'] } = {}) {
  const disk = new Map();
  const remote = new Map();
  let counter = 0;
  const name = (username) => { counter += 1; return `backup-10.26.2026_02-00-${String(counter).padStart(2, '0')}_${username}.tar.gz`; };
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, binaries.includes(n)])),
    'fs.mkdir': ({ path }) => { if (path.startsWith('/root')) throw Object.assign(new Error(`Path "${path}" is outside the locations the agent may write`), { agentError: true, code: 'path_not_allowed', details: {} }); return { path }; },
    'fs.stat': ({ path }) => (disk.has(path) ? { path, exists: true, isDirectory: false, size: disk.get(path).sizeBytes } : path === '/backup' ? { path, exists: true, isDirectory: true, mode: '700' } : { path, exists: false }),
    'backup.account.archive': ({ username, dest, databases = [], dnsZones = [], metadata, include }) => {
      if (username === 'brokenuser') throw Object.assign(new Error('tar: /home/brokenuser: Cannot open: Permission denied'), { agentError: true, code: 'command_failed', details: {} });
      const file = `${dest}/${name(username)}`;
      const sha256 = 'a'.repeat(64);
      disk.set(file, { sizeBytes: 4096 + databases.length, sha256, metadata, dnsZones, databases, username });
      return { path: file, name: file.split('/').pop(), top: file.split('/').pop().replace('.tar.gz', ''), sizeBytes: 4096 + databases.length, sha256, sha256File: `${file}.sha256`, components: { home: { included: include.home }, mysql: databases.map((d) => ({ database: d })), users: 0, dnszones: dnsZones.map((z) => z.domain), metadata: Boolean(metadata) }, warnings: [], durationMs: 5 };
    },
    'backup.archive.list': ({ dir }) => ({ dir, exists: true, archives: [...disk].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, a]) => ({ name: p.split('/').pop(), path: p, username: a.username, sizeBytes: a.sizeBytes, mtime: '2026-10-25T02:00:00.000Z', sha256: a.sha256 })) }),
    'backup.archive.verify': ({ archive, sha256 }) => { const a = disk.get(archive); if (!a) throw Object.assign(new Error(`${archive} does not exist`), { agentError: true, code: 'not_found', details: {} }); return { path: archive, sha256: a.sha256, expected: sha256 ?? null, ok: sha256 ? a.sha256 === sha256 : null, sizeBytes: a.sizeBytes }; },
    'backup.archive.info': ({ archive }) => { const a = disk.get(archive); if (!a) throw Object.assign(new Error('missing'), { agentError: true, code: 'not_found', details: {} }); return { path: archive, top: 'x', username: a.username, sizeBytes: a.sizeBytes, info: { version: 1, createdAt: '2026-10-25T02:00:00.000Z' }, metadata: a.metadata ?? null, components: { home: true, mysql: a.databases.map((d) => ({ database: d, file: `mysql/${d}.sql` })), users: false, dnszones: a.dnsZones.map((z) => z.domain) } }; },
    'backup.archive.inspect': ({ archive, prefix }) => ({ path: archive, top: 'x', prefix, total: 2, truncated: false, entries: [{ name: 'public_html', path: `${prefix}/public_html`, type: 'dir', size: 120, files: 3, mtime: '2026-10-25 02:00' }, { name: '.bashrc', path: `${prefix}/.bashrc`, type: 'file', size: 220, files: 1, mtime: '2026-10-25 02:00' }] }),
    'backup.archive.extract': ({ archive, dest }) => { const a = disk.get(archive); return { path: archive, top: 'x', stagingDir: dest, username: a.username, info: {}, metadata: a.metadata ?? null, mysql: a.databases.map((d) => ({ database: d, file: `${dest}/mysql/${d}.sql`, sizeBytes: 10 })), users: a.databases.length ? { users: [{ user: `${a.username}_app`, host: 'localhost', plugin: 'mysql_native_password', hashHex: '2A41', grants: [`GRANT ALL PRIVILEGES ON \`${a.databases[0]}\`.* TO '${a.username}_app'@'localhost'`] }] } : null, dnszones: a.dnsZones.map((z) => ({ domain: z.domain, file: `${dest}/dnszones/${z.domain}.db`, body: z.body })), missing: [] }; },
    'backup.files.restore': ({ archive, username, homeDir, paths }) => ({ archive, homeDir, username, restored: paths.length ? paths.filter((p) => p !== 'missing.txt') : ['.'], missing: paths.filter((p) => p === 'missing.txt'), overwrite: true, warnings: [] }),
    'backup.db.import': ({ file, database }) => ({ file, database: database ?? null, sizeBytes: 10, warnings: [] }),
    'backup.db.restore_users': ({ users }) => ({ engine: 'mariadb', created: users.map((u) => `${u.user}@${u.host}`), skipped: [], errors: [] }),
    'backup.archive.remove': ({ archive }) => ({ path: archive, removed: disk.delete(archive) }),
    'backup.staging.remove': ({ dir }) => ({ dir, removed: true }),
    'backup.destination.test': ({ config }) => (config.kind === 'ftp' && config.host === 'down.example.com' ? { ok: false, message: 'test upload: failed to connect', code: 'destination_failed', ms: 3 } : { ok: true, message: `probe ok on ${config.kind}`, ms: 3 }),
    'backup.destination.upload': ({ config, file }) => { if (config.kind === 'ftp' && config.host === 'down.example.com') throw Object.assign(new Error('upload to ftp: failed to connect'), { agentError: true, code: 'destination_failed', details: {} }); const n = file.split('/').pop(); remote.set(`${config.kind}:${n}`, disk.get(file)); return { kind: config.kind, name: n, remotePath: config.kind === 's3' ? `s3://${config.bucket}/${n}` : `${config.kind}://${config.host}/${n}`, sizeBytes: 4096, ms: 2 }; },
    'backup.destination.download': ({ config, remoteName, dest }) => { const a = remote.get(`${config.kind}:${remoteName}`); if (!a) throw Object.assign(new Error('download: not there'), { agentError: true, code: 'destination_failed', details: {} }); disk.set(`${dest}/${remoteName}`, a); return { path: `${dest}/${remoteName}`, name: remoteName, sizeBytes: a.sizeBytes, sha256: a.sha256, ms: 2 }; },
    'backup.destination.list': ({ config }) => ({ kind: config.kind, archives: [...remote].filter(([k]) => k.startsWith(`${config.kind}:`)).map(([k, a]) => ({ name: k.split(':')[1], sizeBytes: a.sizeBytes, mtime: null, username: a.username })) }),
    'backup.destination.remove': ({ config, remoteName }) => ({ kind: config.kind, name: remoteName, removed: remote.delete(`${config.kind}:${remoteName}`) }),
    'user.get': ({ username }) => null,
    'user.delete': ({ username }) => ({ username, existed: true }),
  };
  const agent = createMockAgent(ops);
  agent.disk = disk;
  agent.remote = remote;
  return agent;
}

describe('backup helpers', () => {
  it('classifies retention by calendar position and only for retained classes', () => {
    const r = { daily: 7, weekly: 4, monthly: 3 };
    expect(retentionClassFor('2026-11-01T02:00:00Z', r)).toBe('monthly');
    expect(retentionClassFor('2026-10-25T02:00:00Z', r)).toBe('weekly');
    expect(retentionClassFor('2026-10-26T02:00:00Z', r)).toBe('daily');
    expect(retentionClassFor('2026-11-01T02:00:00Z', { ...r, monthly: 0 })).toBe('weekly');
    expect(retentionClassFor('2026-10-25T02:00:00Z', { ...r, weekly: 0 })).toBe('daily');
  });

  it('plans pruning per class, newest first, never touching pinned backups', () => {
    const rows = [1, 2, 3, 4].map((i) => ({ id: i, retention_class: 'daily', pinned: i === 1, created_at: `2026-10-2${i} 02:00:00` }));
    rows.push({ id: 9, retention_class: 'weekly', pinned: 0, created_at: '2026-10-19 02:00:00' });
    const remove = planPrune(rows, { daily: 2, weekly: 0, monthly: 3 });
    expect(remove.map((r) => r.id).sort()).toEqual([2, 9]);
  });

  it('hides secrets in the public destination view', () => {
    expect(publicDestinationConfig({ host: 'h', password: 'p', secretKey: '', privateKey: 'k' })).toEqual({ host: 'h', has_password: true, has_secret_key: false, has_private_key: true });
  });
});

describe('Backup API', () => {
  let app;
  let csrf;
  let reseller;
  let resellerHttp;
  let resellerCsrf;
  const get = (p) => app.http.get(`/api/backup${p}`);
  const post = (p, body = {}) => app.http.post(`/api/backup${p}`).set('X-CSRF-Token', csrf).send(body);
  const put = (p, body = {}) => app.http.put(`/api/backup${p}`).set('X-CSRF-Token', csrf).send(body);
  const del = (p) => app.http.delete(`/api/backup${p}`).set('X-CSRF-Token', csrf);

  beforeAll(async () => {
    app = await createTestApp({ agent: backupAgent() });
    csrf = await app.login();
    app.ctx.jobs.start();
    reseller = await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', owner: 'resell1' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', provision: { dns: true } }).expect(201);
    const { default: request } = await import('supertest');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  describe('Backup Configuration', () => {
    it('returns settings, capability and schedule state', async () => {
      const res = await get('/config').expect(200);
      expect(res.body.data.settings['backup.enabled']).toBe(false);
      expect(res.body.data.settings['backup.local_dir']).toBe('/backup');
      expect(res.body.data.status.capability.installed).toBe(true);
      expect(res.body.data.status.schedule).toMatchObject({ name: 'backup-run', job_type: 'backup.run', enabled: 0 });
      expect(res.body.data.status.totalAccounts).toBe(2);
    });

    it('saves settings and keeps the schedule row in step with enabled + cron', async () => {
      const res = await put('/config', { 'backup.enabled': true, 'backup.schedule': '30 3 * * *', 'backup.retention_daily': 2, 'backup.excludes': ['tmp', 'logs/old'] }).expect(200);
      expect(res.body.data.settings['backup.schedule']).toBe('30 3 * * *');
      const row = app.ctx.db.prepare("SELECT cron, enabled FROM schedules WHERE name = 'backup-run'").get();
      expect(row).toEqual({ cron: '30 3 * * *', enabled: 1 });
      expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'backup.config.update'").get()).toBeTruthy();
      await put('/config', { 'backup.enabled': false }).expect(200);
      expect(app.ctx.db.prepare("SELECT enabled FROM schedules WHERE name = 'backup-run'").get().enabled).toBe(0);
    });

    it('creates the local directory through the agent and rejects one outside the allowed roots', async () => {
      await put('/config', { 'backup.local_dir': '/var/backups/whm/' }).expect(200);
      expect(app.agent.callsTo('fs.mkdir').map((c) => c.args.path)).toContain('/var/backups/whm');
      expect(app.ctx.backup.localDir()).toBe('/var/backups/whm');
      const bad = await put('/config', { 'backup.local_dir': '/root/secret' }).expect(422);
      expect(bad.body.error.fields.dir).toBeDefined();
      await put('/config', { 'backup.local_dir': '/backup' }).expect(200);
    });

    it('validates settings (422) and is root-only (403)', async () => {
      const res = await put('/config', { 'backup.schedule': 'every day', 'backup.excludes': ['../etc'] }).expect(422);
      expect(res.body.error.fields['backup.schedule']).toBeDefined();
      expect(res.body.error.fields['backup.excludes.0']).toBeDefined();
      await put('/config', { 'tweak.max_emails_per_hour': 5 }).expect(422);
      await resellerHttp.get('/api/backup/config').expect(403);
      await resellerHttp.put('/api/backup/config').set('X-CSRF-Token', resellerCsrf).send({ 'backup.enabled': true }).expect(403);
    });
  });

  describe('destinations', () => {
    let s3Id;
    let ftpId;

    it('creates destinations with encrypted config and never returns secrets', async () => {
      const s3 = await post('/destinations', { name: 'offsite-s3', config: { kind: 's3', bucket: 'whm-backups', region: 'eu-west-1', accessKey: 'AKIA', secretKey: 'topsecret', prefix: 'panel/' } }).expect(201);
      s3Id = s3.body.data.id;
      expect(s3.body.data).toMatchObject({ name: 'offsite-s3', kind: 's3', enabled: true, config: { bucket: 'whm-backups', region: 'eu-west-1', accessKey: 'AKIA', has_secret_key: true } });
      expect(JSON.stringify(s3.body)).not.toContain('topsecret');
      const row = app.ctx.db.prepare('SELECT config_enc FROM backup_destinations WHERE id = ?').get(s3Id);
      expect(row.config_enc.startsWith('v1:')).toBe(true);
      expect(app.ctx.backup.destinationConfig(s3Id)).toMatchObject({ kind: 's3', secretKey: 'topsecret', bucket: 'whm-backups' });
      const ftp = await post('/destinations', { name: 'ftp-mirror', config: { kind: 'ftp', host: 'down.example.com', username: 'u', password: 'pw', path: 'backups', tls: true } }).expect(201);
      ftpId = ftp.body.data.id;
      await post('/destinations', { name: 'offsite-s3', config: { kind: 's3', bucket: 'x-y-z', accessKey: 'a', secretKey: 'b' } }).expect(409);
    });

    it('validates per kind (422)', async () => {
      const res = await post('/destinations', { name: 'bad', config: { kind: 's3', accessKey: 'a', secretKey: 'b' } }).expect(422);
      expect(res.body.error.fields['config.bucket']).toBeDefined();
      await post('/destinations', { name: 'bad', config: { kind: 'ftp', host: 'h;rm', username: 'u' } }).expect(422);
      await post('/destinations', { name: 'bad', config: { kind: 'sftp', host: 'h.example.com', username: 'u', path: '../x' } }).expect(422);
      await post('/destinations', { name: 'bad', config: { kind: 'gdrive', folder: 'x' } }).expect(422);
      await post('/destinations', { name: 'bad', config: { kind: 'webdav', url: 'ftp://nope' } }).expect(422);
    });

    it('keeps stored secrets when an update leaves them blank', async () => {
      const res = await put(`/destinations/${s3Id}`, { config: { kind: 's3', bucket: 'whm-backups-2', region: 'eu-west-1', accessKey: 'AKIA2', secretKey: '' } }).expect(200);
      expect(res.body.data.config).toMatchObject({ bucket: 'whm-backups-2', accessKey: 'AKIA2', has_secret_key: true });
      expect(app.ctx.backup.destinationConfig(s3Id).secretKey).toBe('topsecret');
      await put(`/destinations/${ftpId}`, { enabled: false }).expect(200);
      expect((await get('/destinations').expect(200)).body.data.find((d) => d.id === ftpId).enabled).toBe(false);
      await put(`/destinations/${ftpId}`, { enabled: true }).expect(200);
    });

    it('tests destinations through the agent and records the outcome', async () => {
      const ok = await post(`/destinations/${s3Id}/test`).expect(200);
      expect(ok.body.data.ok).toBe(true);
      expect(ok.body.data.destination.lastTest).toMatchObject({ ok: true });
      expect(app.agent.callsTo('backup.destination.test')[0].args.config).toMatchObject({ kind: 's3', secretKey: 'topsecret' });
      const bad = await post(`/destinations/${ftpId}/test`).expect(200);
      expect(bad.body.data.ok).toBe(false);
      expect(bad.body.data.destination.lastTest.ok).toBe(false);
      const adhoc = await post('/destinations/test', { config: { kind: 'local', dir: '/var/backups/whm/offsite' } }).expect(200);
      expect(adhoc.body.data.ok).toBe(true);
      await post('/destinations/999/test').expect(404);
    });

    it('is root-only', async () => {
      await resellerHttp.get('/api/backup/destinations').expect(403);
      await resellerHttp.post('/api/backup/destinations').set('X-CSRF-Token', resellerCsrf).send({ name: 'x', config: { kind: 'local', dir: '/backup/x' } }).expect(403);
    });
  });

  describe('Backup User Selection', () => {
    it('lists every account with the effective flag and toggles explicitly', async () => {
      const res = await get('/selection').expect(200);
      expect(res.body.data.map((r) => [r.username, r.enabled, r.explicit])).toEqual([['alice', true, false], ['bob', true, false]]);
      expect(res.body.meta.defaultInclude).toBe(true);
      const off = await put('/selection', { usernames: ['bob', 'ghost'], enabled: false }).expect(200);
      expect(off.body.data).toEqual({ changed: ['bob'], missing: ['ghost'], enabled: false });
      const after = await get('/selection?enabled=false').expect(200);
      expect(after.body.data.map((r) => r.username)).toEqual(['bob']);
      expect(after.body.data[0].explicit).toBe(true);
      expect(app.ctx.backup.includedAccounts()).toEqual(['alice']);
      expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'backup.selection.disable'").get()).toBeTruthy();
    });

    it('follows the default-include setting for accounts without a row', async () => {
      await put('/config', { 'backup.default_include': false }).expect(200);
      expect(app.ctx.backup.includedAccounts()).toEqual([]);
      await put('/selection', { usernames: ['alice'], enabled: true }).expect(200);
      expect(app.ctx.backup.includedAccounts()).toEqual(['alice']);
      await put('/config', { 'backup.default_include': true }).expect(200);
    });

    it('validates and is root-only', async () => {
      await put('/selection', { usernames: ['Bad User'], enabled: true }).expect(422);
      await put('/selection', { usernames: [], enabled: true }).expect(422);
      await resellerHttp.get('/api/backup/selection').expect(403);
      await resellerHttp.put('/api/backup/selection').set('X-CSRF-Token', resellerCsrf).send({ usernames: ['alice'], enabled: false }).expect(403);
    });
  });

  describe('backup runs', () => {
    it('backs up the included accounts as a job, uploads to enabled destinations and records rows', async () => {
      const res = await post('/runs').expect(202);
      expect(res.body.data.job.type).toBe('backup.run');
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ ok: 1, failed: 0 });
      const archive = app.agent.callsTo('backup.account.archive');
      expect(archive).toHaveLength(1);
      expect(archive[0].args).toMatchObject({ username: 'alice', homeDir: '/home/alice', dest: '/backup', include: { home: true, mail: true, dbs: true, dns: true, metadata: true }, excludes: ['tmp', 'logs/old'], compressionLevel: 6, strict: false });
      expect(archive[0].args.metadata.account).toMatchObject({ username: 'alice', domain: 'alice.com', owner: 'resell1' });
      expect(archive[0].args.metadata.domains.map((d) => d.domain)).toEqual(['alice.com']);
      const backups = await get('/backups?account=alice').expect(200);
      expect(backups.body.data).toHaveLength(1);
      const b = backups.body.data[0];
      expect(b).toMatchObject({ account: 'alice', status: 'done', size: 4096, local_present: true, pinned: false, retention_class: expect.any(String) });
      expect(b.uploads.map((u) => [u.destination, u.status])).toEqual([['ftp-mirror', 'failed'], ['offsite-s3', 'done']]);
      expect(b.uploads.find((u) => u.destination === 'offsite-s3').remote_path).toMatch(/^s3:\/\/whm-backups-2\//);
      const run = await get(`/runs/${res.body.data.run.id}`).expect(200);
      expect(run.body.data).toMatchObject({ status: 'done', accounts_ok: 1, accounts_failed: 0, kind: 'manual' });
      expect(run.body.data.summary.accounts[0]).toMatchObject({ username: 'alice', status: 'done', uploads: [{ destination: 'ftp-mirror', ok: false }, { destination: 'offsite-s3', ok: true }] });
      expect((await get('/runs').expect(200)).body.data[0].id).toBe(res.body.data.run.id);
    });

    it('prunes beyond the retention per class and removes files locally and remotely', async () => {
      await put('/config', { 'backup.retention_daily': 1, 'backup.retention_weekly': 0, 'backup.retention_monthly': 0 }).expect(200);
      app.ctx.db.prepare("UPDATE backups SET retention_class = 'daily', created_at = '2026-10-20 02:00:00' WHERE account_name = 'alice'").run();
      const before = app.ctx.db.prepare("SELECT id, path FROM backups WHERE account_name = 'alice'").get();
      const res = await post('/runs', { accounts: ['alice'] }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result.summary.pruned).toBe(1);
      expect(app.agent.callsTo('backup.archive.remove').map((c) => c.args.archive)).toEqual([before.path]);
      expect(app.agent.callsTo('backup.destination.remove')).toHaveLength(1);
      expect(app.ctx.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(before.id)).toBeUndefined();
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backups WHERE account_name = 'alice'").get().n).toBe(1);
      await put('/config', { 'backup.retention_daily': 7, 'backup.retention_weekly': 4, 'backup.retention_monthly': 3 }).expect(200);
    });

    it('records a failed account without aborting the run, and strict mode aborts', async () => {
      await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'brokenuser', domain: 'broken.com' }).expect(201);
      const res = await post('/runs', { accounts: ['brokenuser', 'bob'] }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ ok: 1, failed: 1 });
      const failed = app.ctx.db.prepare("SELECT status, error FROM backups WHERE account_name = 'brokenuser'").get();
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/Permission denied/);
      await put('/config', { 'backup.strict': true }).expect(200);
      const strictRes = await post('/runs', { accounts: ['brokenuser', 'bob'] }).expect(202);
      const strictJob = await waitForJob(app.ctx, strictRes.body.data.job.id);
      expect(strictJob.status).toBe('failed');
      expect(app.agent.callsTo('backup.account.archive').map((c) => c.args.username)).toEqual(['brokenuser', 'bob', 'brokenuser']);
      await put('/config', { 'backup.strict': false }).expect(200);
    });

    it('a scheduled run while backups are disabled is a skipped run, not an error', async () => {
      const result = await app.ctx.backup.runBackupJob({ params: { kind: 'scheduled' }, job: {}, log: () => {}, progress: () => {} });
      expect(result.skipped).toBe(true);
      expect(app.ctx.db.prepare("SELECT status FROM backup_runs ORDER BY id DESC LIMIT 1").get().status).toBe('skipped');
      expect(app.agent.callsTo('backup.account.archive')).toHaveLength(0);
    });

    it('resellers may back up their own accounts only', async () => {
      await resellerHttp.post('/api/backup/runs').set('X-CSRF-Token', resellerCsrf).send({}).expect(403);
      await resellerHttp.post('/api/backup/runs').set('X-CSRF-Token', resellerCsrf).send({ accounts: ['bob'] }).expect(403);
      const res = await resellerHttp.post('/api/backup/runs').set('X-CSRF-Token', resellerCsrf).send({ accounts: ['alice'] }).expect(202);
      expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('done');
      await resellerHttp.get('/api/backup/runs').expect(403);
      await post('/runs', { accounts: ['no such'] }).expect(422);
    });

    it('rescan adopts archives on disk the panel never recorded', async () => {
      app.agent.disk.set('/backup/backup-10.01.2026_02-00-00_bob.tar.gz', { sizeBytes: 999, sha256: 'b'.repeat(64), username: 'bob', databases: [], dnsZones: [] });
      const res = await post('/rescan').expect(200);
      expect(res.body.data.added).toEqual(['backup-10.01.2026_02-00-00_bob.tar.gz']);
      const row = app.ctx.db.prepare("SELECT * FROM backups WHERE path = '/backup/backup-10.01.2026_02-00-00_bob.tar.gz'").get();
      expect(row).toMatchObject({ account_name: 'bob', size: 999, status: 'done', local_present: 1 });
      await resellerHttp.post('/api/backup/rescan').set('X-CSRF-Token', resellerCsrf).send({}).expect(403);
    });
  });

  describe('backups listing, browsing and lifecycle', () => {
    it('lists per role, browses and inspects archives', async () => {
      const all = await get('/backups').expect(200);
      expect(all.body.data.length).toBeGreaterThanOrEqual(3);
      const mine = await resellerHttp.get('/api/backup/backups').expect(200);
      expect(mine.body.data.every((b) => b.account === 'alice')).toBe(true);
      const alice = mine.body.data[0];
      const browse = await resellerHttp.get(`/api/backup/backups/${alice.id}/browse?prefix=homedir`).expect(200);
      expect(browse.body.data.entries.map((e) => e.name)).toEqual(['public_html', '.bashrc']);
      expect(app.agent.callsTo('backup.archive.inspect')[0].args).toMatchObject({ archive: alice.path, prefix: 'homedir' });
      await resellerHttp.get(`/api/backup/backups/${alice.id}/browse?prefix=../etc`).expect(422);
      const info = await get(`/backups/${alice.id}/info`).expect(200);
      expect(info.body.data.components.home).toBe(true);
      const bob = all.body.data.find((b) => b.account === 'bob');
      await resellerHttp.get(`/api/backup/backups/${bob.id}`).expect(403);
      await resellerHttp.get(`/api/backup/backups/${bob.id}/browse`).expect(403);
      const overview = await resellerHttp.get('/api/backup/accounts').expect(200);
      expect(overview.body.data.map((a) => a.username)).toEqual(['alice']);
      expect(overview.body.data[0].backups).toBeGreaterThanOrEqual(1);
    });

    it('pins, refuses to delete pinned backups, then deletes locally and remotely', async () => {
      const bob = (await get('/backups?account=bob').expect(200)).body.data.find((b) => b.uploads.some((u) => u.status === 'done'));
      await put(`/backups/${bob.id}/pin`, { pinned: true }).expect(200);
      await del(`/backups/${bob.id}`).expect(409);
      await put(`/backups/${bob.id}/pin`, { pinned: false }).expect(200);
      const res = await del(`/backups/${bob.id}`).expect(200);
      expect(res.body.data.local).toBe(true);
      expect(res.body.data.remote).toEqual([{ destination: 'offsite-s3', removed: true }]);
      await get(`/backups/${bob.id}`).expect(404);
      await resellerHttp.delete(`/api/backup/backups/1`).set('X-CSRF-Token', resellerCsrf).expect(403);
    });

    it('fetches an archive back from a destination when the local copy is gone', async () => {
      const res = await post('/runs', { accounts: ['bob'] }).expect(202);
      await waitForJob(app.ctx, res.body.data.job.id);
      const bob = (await get('/backups?account=bob').expect(200)).body.data[0];
      app.agent.disk.delete(bob.path);
      await get(`/backups/${bob.id}/browse`).expect(200);
      app.ctx.db.prepare('UPDATE backups SET local_present = 0 WHERE id = ?').run(bob.id);
      await get(`/backups/${bob.id}/browse`).expect(409);
      const fetch = await post(`/backups/${bob.id}/fetch`).expect(202);
      const job = await waitForJob(app.ctx, fetch.body.data.job.id);
      expect(job.status).toBe('done');
      expect(app.agent.callsTo('backup.destination.download')[0].args).toMatchObject({ remoteName: bob.name, dest: '/backup' });
      expect((await get(`/backups/${bob.id}`).expect(200)).body.data.local_present).toBe(true);
    });
  });

  describe('File and Directory Restoration', () => {
    it('restores selected paths into the home with ownership as a job', async () => {
      const alice = (await resellerHttp.get('/api/backup/backups?account=alice').expect(200)).body.data[0];
      const res = await resellerHttp.post(`/api/backup/backups/${alice.id}/restore`).set('X-CSRF-Token', resellerCsrf).send({ kind: 'files', options: { paths: ['public_html/index.html', 'missing.txt'], overwrite: false } }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      const call = app.agent.callsTo('backup.files.restore')[0];
      expect(call.args).toMatchObject({ archive: alice.path, username: 'alice', homeDir: '/home/alice', paths: ['public_html/index.html', 'missing.txt'], overwrite: false });
      expect(app.agent.callsTo('backup.archive.verify')[0].args.sha256).toBe(alice.sha256);
      const restore = await resellerHttp.get(`/api/backup/restores/${res.body.data.restore.id}`).expect(200);
      expect(restore.body.data).toMatchObject({ status: 'done', kind: 'files', account_name: 'alice' });
      expect(restore.body.data.summary.steps.files).toMatchObject({ restored: ['public_html/index.html'], missing: ['missing.txt'] });
      expect((await resellerHttp.get('/api/backup/restores').expect(200)).body.data[0].id).toBe(res.body.data.restore.id);
    });

    it('validates paths and enforces ownership', async () => {
      const alice = (await get('/backups?account=alice').expect(200)).body.data[0];
      await post(`/backups/${alice.id}/restore`, { kind: 'files', options: { paths: ['../../etc/passwd'] } }).expect(422);
      await post(`/backups/${alice.id}/restore`, { kind: 'files', options: { paths: ['-rf'] } }).expect(422);
      await post(`/backups/${alice.id}/restore`, { kind: 'files', options: { paths: [] } }).expect(422);
      await post(`/backups/${alice.id}/restore`, { kind: 'files' }).expect(422);
      const bob = (await get('/backups?account=bob').expect(200)).body.data[0];
      await resellerHttp.post(`/api/backup/backups/${bob.id}/restore`).set('X-CSRF-Token', resellerCsrf).send({ kind: 'files', options: { paths: ['x'] } }).expect(403);
      await resellerHttp.get(`/api/backup/restores?account=bob`).expect(200).then((r) => expect(r.body.data).toEqual([]));
    });
  });

  describe('Backup Restoration', () => {
    it('recreates a terminated account from its archive and restores files, databases, zones and routing', async () => {
      app.ctx.databases = {
        activeProfile: () => ({ id: 1, engine: 'mysql', profile_name: 'localhost', is_local: true }),
        forAccount: (username) => ({ databases: [{ name: `${username}_shop`, users: [`${username}_app`] }], users: [{ name: `${username}_app`, hosts: ['localhost'], grants: [] }], accessHosts: [], quota: {} }),
        clientAddresses: () => ({ ipv4: null, ipv6: null }),
        assign: async (args) => { assigned.push(args); return args; },
      };
      const assigned = [];
      const imported = [];
      app.ctx.dns.importZone = async ({ domain, body }) => { imported.push(domain); return { domain, body }; };
      const run = await post('/runs', { accounts: ['bob'] }).expect(202);
      await waitForJob(app.ctx, run.body.data.job.id);
      const archiveCall = app.agent.callsTo('backup.account.archive').pop();
      expect(archiveCall.args.databases).toEqual(['bob_shop']);
      expect(archiveCall.args.dbUsers).toEqual(['bob_app']);
      expect(archiveCall.args.dnsZones.map((z) => z.domain)).toEqual(['bob.com']);
      expect(archiveCall.args.credentials).toBeUndefined();
      const backup = (await get('/backups?account=bob').expect(200)).body.data[0];
      expect(backup.components.mysql).toEqual([{ database: 'bob_shop' }]);

      await app.http.delete('/api/accounts/bob').set('X-CSRF-Token', csrf).expect(200);
      expect((await get('/accounts').expect(200)).body.data.find((a) => a.username === 'bob')).toMatchObject({ exists: false });
      await post(`/backups/${backup.id}/restore`, { kind: 'account', options: {} }).expect(409);
      const res = await post(`/backups/${backup.id}/restore`, { kind: 'account', options: { createAccount: true } }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status, JSON.stringify(job)).toBe('done');
      expect(app.ctx.db.prepare("SELECT username, domain FROM accounts WHERE username = 'bob'").get()).toEqual({ username: 'bob', domain: 'bob.com' });
      expect(app.agent.callsTo('backup.archive.extract')[0].args).toMatchObject({ archive: backup.path, dest: expect.stringMatching(/^\/backup\/\.restore-\d+$/) });
      expect(app.agent.callsTo('backup.files.restore')[0].args).toMatchObject({ username: 'bob', paths: [], overwrite: true });
      expect(app.agent.callsTo('backup.db.import')[0].args.file).toMatch(/mysql\/bob_shop\.sql$/);
      expect(app.agent.callsTo('backup.db.restore_users')[0].args.users[0]).toMatchObject({ user: 'bob_app', host: 'localhost', hashHex: '2A41' });
      expect(assigned).toEqual([{ kind: 'database', name: 'bob_shop', account: 'bob' }, { kind: 'user', name: 'bob_app', account: 'bob' }]);
      expect(imported).toEqual(['bob.com']);
      expect(app.agent.callsTo('backup.staging.remove')).toHaveLength(1);
      const restore = await get(`/restores/${res.body.data.restore.id}`).expect(200);
      expect(Object.fromEntries(Object.entries(restore.body.data.summary.steps).map(([k, v]) => [k, v.status]))).toMatchObject({ verify: 'done', account: 'done', files: 'done', databases: 'done', dns: 'done' });
      expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'backup.restore.finish'").get()).toBeTruthy();
    });

    it('fails cleanly on a checksum mismatch and leaves the account untouched', async () => {
      const backup = (await get('/backups?account=alice').expect(200)).body.data[0];
      app.ctx.db.prepare('UPDATE backups SET sha256 = ? WHERE id = ?').run('f'.repeat(64), backup.id);
      const res = await post(`/backups/${backup.id}/restore`, { kind: 'account', options: { databases: false } }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/checksum mismatch/);
      expect(app.agent.callsTo('backup.files.restore')).toHaveLength(0);
      expect((await get(`/restores/${res.body.data.restore.id}`).expect(200)).body.data.status).toBe('failed');
      app.ctx.db.prepare('UPDATE backups SET sha256 = ? WHERE id = ?').run('a'.repeat(64), backup.id);
    });

    it('validates the restore body and ownership', async () => {
      const backup = (await get('/backups?account=alice').expect(200)).body.data[0];
      await post(`/backups/${backup.id}/restore`, { kind: 'everything' }).expect(422);
      await post(`/backups/${backup.id}/restore`, { kind: 'account', options: { package: 'bad;pkg' } }).expect(422);
      await post('/backups/99999/restore', { kind: 'account', options: {} }).expect(404);
      const bob = (await get('/backups?account=bob').expect(200)).body.data[0];
      await resellerHttp.post(`/api/backup/backups/${bob.id}/restore`).set('X-CSRF-Token', resellerCsrf).send({ kind: 'account', options: {} }).expect(403);
    });

    it('registers an archive copied onto the server by hand (import)', async () => {
      app.agent.disk.set('/backup/cpmove-alice.tar.gz', { sizeBytes: 777, sha256: 'c'.repeat(64), username: 'alice', databases: [], dnsZones: [], metadata: { account: { username: 'alice', domain: 'alice.com' } } });
      const res = await post('/archives/import', { path: '/backup/cpmove-alice.tar.gz' }).expect(201);
      expect(res.body.data).toMatchObject({ account: 'alice', type: 'import', pinned: true, size: 777, sha256: 'c'.repeat(64) });
      await post('/archives/import', { path: '/backup/cpmove-alice.tar.gz' }).expect(409);
      await post('/archives/import', { path: 'relative.tar.gz' }).expect(422);
      await resellerHttp.post('/api/backup/archives/import').set('X-CSRF-Token', resellerCsrf).send({ path: '/backup/cpmove-alice.tar.gz' }).expect(403);
    });
  });
});

describe('Backup API without tar on the host', () => {
  let app;
  let csrf;
  beforeAll(async () => {
    app = await createTestApp({ agent: backupAgent({ binaries: ['systemctl', 'useradd'] }) });
    csrf = await app.login();
    app.ctx.jobs.start();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.com' }).expect(201);
  });
  afterAll(() => app.close());

  it('reports the missing capability and answers 501 on archive operations', async () => {
    const status = await app.http.get('/api/backup/status').expect(200);
    expect(status.body.data.capability).toMatchObject({ installed: false, binaries: { tar: false } });
    const res = await app.http.post('/api/backup/runs').set('X-CSRF-Token', csrf).send({ accounts: ['carol'] }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/tar/);
    expect(app.agent.callsTo('backup.account.archive')).toHaveLength(0);
    expect(app.ctx.db.prepare("SELECT status, error FROM backup_runs ORDER BY id DESC LIMIT 1").get()).toMatchObject({ status: 'failed' });
    app.ctx.db.prepare("INSERT INTO backups (account_name, type, path, size, sha256, status, local_present) VALUES ('carol', 'full', '/backup/backup-10.20.2026_02-00-00_carol.tar.gz', 10, ?, 'done', 1)").run('a'.repeat(64));
    const id = app.ctx.db.prepare("SELECT id FROM backups WHERE account_name = 'carol'").get().id;
    const browse = await app.http.get(`/api/backup/backups/${id}/browse`).expect(501);
    expect(browse.body.error).toMatchObject({ code: 'capability_missing', capability: 'backup' });
    await app.http.get(`/api/backup/backups/${id}/info`).expect(501);
    const restore = await app.http.post(`/api/backup/backups/${id}/restore`).set('X-CSRF-Token', csrf).send({ kind: 'files', options: { paths: ['public_html'] } }).expect(202);
    const rjob = await waitForJob(app.ctx, restore.body.data.job.id);
    expect(rjob.status).toBe('failed');
    expect(rjob.error).toMatch(/tar/);
  });

  it('settings and destinations keep working without tar', async () => {
    await app.http.put('/api/backup/config').set('X-CSRF-Token', csrf).send({ 'backup.enabled': true }).expect(200);
    await app.http.post('/api/backup/destinations').set('X-CSRF-Token', csrf).send({ name: 'later', config: { kind: 'sftp', host: 'sftp.example.com', username: 'u', password: 'p', path: '~/backups' } }).expect(201);
  });
});
