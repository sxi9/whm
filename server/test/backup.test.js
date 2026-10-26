import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { retentionClassFor, planPrune, publicDestinationConfig, grantDatabase, rewriteDocroot } from '../src/services/backup.js';

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
    'backup.archive.extract': ({ archive, dest }) => { const a = disk.get(archive); return { path: archive, top: 'x', stagingDir: dest, username: a.username, info: {}, metadata: a.metadata ?? null, mysql: a.databases.map((d) => ({ database: d, file: `${dest}/mysql/${d}.sql`, sizeBytes: 10 })), users: a.databases.length ? { users: [{ user: `${a.username}_app`, host: 'localhost', plugin: 'mysql_native_password', hashHex: '2A41', grants: [`GRANT USAGE ON *.* TO '${a.username}_app'@'localhost'`, `GRANT ALL PRIVILEGES ON \`${a.databases[0]}\`.* TO '${a.username}_app'@'localhost'`, `GRANT SELECT ON \`mysql\`.* TO '${a.username}_app'@'localhost'`, `GRANT ALL PRIVILEGES ON \`someone_else\`.* TO '${a.username}_app'@'localhost'`, `GRANT ALL PRIVILEGES ON \`${a.username}\\_%\`.* TO '${a.username}_app'@'localhost'`] }] } : null, dnszones: a.dnsZones.map((z) => ({ domain: z.domain, file: `${dest}/dnszones/${z.domain}.db`, body: z.body })), missing: [] }; },
    'backup.files.restore': ({ archive, username, homeDir, paths }) => ({ archive, homeDir, username, restored: paths.length ? paths.filter((p) => p !== 'missing.txt') : ['.'], missing: paths.filter((p) => p === 'missing.txt'), overwrite: true, warnings: [] }),
    'backup.db.import': ({ file, database }) => ({ file, database: database ?? null, sizeBytes: 10, warnings: [] }),
    'backup.db.restore_users': ({ users }) => ({ engine: 'mariadb', created: users.map((u) => `${u.user}@${u.host}`), skipped: [], errors: [], dropped: [] }),
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

  it('reads the database a GRANT line names and moves archived docroots under the current home', () => {
    expect(grantDatabase("GRANT ALL PRIVILEGES ON `alice_shop`.* TO 'alice_app'@'localhost'")).toBe('alice_shop');
    expect(grantDatabase("GRANT SELECT, INSERT ON `alice\\_shop`.`orders` TO 'alice_app'@'%'")).toBe('alice_shop');
    expect(grantDatabase("GRANT USAGE ON *.* TO 'alice_app'@'localhost' IDENTIFIED BY PASSWORD '*X'")).toBe('*');
    expect(grantDatabase("GRANT SELECT ON mysql.* TO 'x'@'%'")).toBe('mysql');
    expect(grantDatabase("GRANT PROXY ON ''@'' TO 'x'@'%'")).toBeNull();
    expect(grantDatabase('DROP TABLE x')).toBeNull();
    expect(rewriteDocroot('/home/alice/public_html/shop', '/home/alice', '/home2/alice')).toBe('/home2/alice/public_html/shop');
    expect(rewriteDocroot('/home2/alice/public_html/blog', null, '/srv/home/alice')).toBe('/srv/home/alice/public_html/blog');
    expect(rewriteDocroot('/home/alice', '/home/alice', '/home2/alice')).toBe('/home2/alice');
    expect(rewriteDocroot('public_html', '/home/alice', '/home2/alice')).toBeNull();
    expect(rewriteDocroot(null, '/home/alice', '/home2/alice')).toBeNull();
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
      for (const cron of ['0 2 * * 8', '99 2 * * *', 'a b c d e', '*/0 * * * *']) {
        const bad = await put('/config', { 'backup.schedule': cron }).expect(422);
        expect(bad.body.error.fields['backup.schedule'], cron).toBeDefined();
      }
      expect(app.ctx.settings.get('backup.schedule')).toBe('30 3 * * *');
      expect(app.ctx.db.prepare("SELECT cron FROM schedules WHERE name = 'backup-run'").get().cron).toBe('30 3 * * *');
      await expect(app.ctx.backup.updateConfig({ 'backup.schedule': '0 2 * * 8' }, null)).rejects.toMatchObject({ status: 422 });
      await put('/config', { 'tweak.max_emails_per_hour': 5 }).expect(422);
      await resellerHttp.get('/api/backup/config').expect(403);
      await resellerHttp.put('/api/backup/config').set('X-CSRF-Token', resellerCsrf).send({ 'backup.enabled': true }).expect(403);
    });

    it('status shows resellers the capability only, never the server-wide configuration', async () => {
      const root = await get('/status').expect(200);
      expect(root.body.data).toMatchObject({ capability: { installed: true }, localDir: { path: '/backup' }, totalAccounts: 2 });
      expect(root.body.data).toHaveProperty('destinations');
      expect(root.body.data).toHaveProperty('schedule');
      expect(root.body.data).toHaveProperty('lastRun');
      const res = await resellerHttp.get('/api/backup/status').expect(200);
      expect(res.body.data.capability).toMatchObject({ installed: true, binaries: { tar: true } });
      expect(res.body.data).toMatchObject({ includedAccounts: 1, totalAccounts: 1 });
      for (const key of ['destinations', 'localDir', 'schedule', 'lastRun']) expect(res.body.data, key).not.toHaveProperty(key);
    });
  });

  // dbCredentials() reads Database Services' profile row directly (no accessor
  // is exported yet); the columns it depends on are pinned here.
  it('the db_instances columns backups read for admin credentials exist', () => {
    const columns = new Set(app.ctx.db.prepare('PRAGMA table_info(db_instances)').all().map((c) => c.name));
    for (const c of ['id', 'engine', 'host', 'port', 'admin_user', 'admin_password_enc', 'is_local']) expect(columns.has(c), c).toBe(true);
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
      await post('/destinations', { name: 'bad', config: { kind: 'sftp', host: 'h.example.com', username: 'u', path: '../x', insecure: true } }).expect(422);
      const unpinned = await post('/destinations', { name: 'bad', config: { kind: 'sftp', host: 'h.example.com', username: 'u', password: 'p' } }).expect(422);
      expect(unpinned.body.error.fields['config.hostKeySha256']).toBeDefined();
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

    it('an explicit null removes a stored secret (key → password and back)', async () => {
      const fp = 'A'.repeat(43);
      const created = await post('/destinations', { name: 'sftp-box', enabled: false, config: { kind: 'sftp', host: 'sftp.example.com', username: 'u', password: 'pw', hostKeySha256: fp } }).expect(201);
      const id = created.body.data.id;
      expect(created.body.data.config).toMatchObject({ has_password: true, hostKeySha256: fp });
      expect(created.body.data.config.has_private_key).toBeUndefined();
      const keyed = await put(`/destinations/${id}`, { config: { kind: 'sftp', host: 'sftp.example.com', username: 'u', password: null, privateKey: '-----BEGIN KEY-----', hostKeySha256: fp } }).expect(200);
      expect(keyed.body.data.config).toMatchObject({ has_private_key: true });
      expect(keyed.body.data.config.has_password).toBeUndefined();
      expect(app.ctx.backup.destinationConfig(id)).toEqual({ kind: 'sftp', host: 'sftp.example.com', port: 22, username: 'u', privateKey: '-----BEGIN KEY-----', hostKeySha256: fp, path: '', insecure: false });
      const back = await put(`/destinations/${id}`, { config: { kind: 'sftp', host: 'sftp.example.com', username: 'u', password: 'pw2', privateKey: null, hostKeySha256: fp } }).expect(200);
      expect(back.body.data.config).toMatchObject({ has_password: true });
      expect(back.body.data.config.has_private_key).toBeUndefined();
      expect(app.ctx.backup.destinationConfig(id).privateKey).toBeUndefined();
      await put(`/destinations/${id}`, { config: { kind: 'sftp', host: 'sftp.example.com', username: 'u', privateKey: null } }).expect(422);
      await del(`/destinations/${id}`).expect(200);
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
      expect(b.home_dir).toBe('/home/alice');
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
    it('long-running ops cross the agent socket with a timeout matching their own (split mode never cuts an archive short)', async () => {
      const seen = [];
      const original = app.agent.op;
      app.agent.op = (name, args, opts) => { seen.push({ name, timeoutMs: opts?.timeoutMs ?? null }); return original.call(app.agent, name, args, opts); };
      try {
        const res = await post('/runs', { accounts: ['alice'] }).expect(202);
        expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('done');
      } finally { app.agent.op = original; }
      const by = (name) => seen.filter((c) => c.name === name).map((c) => c.timeoutMs);
      expect(by('backup.account.archive')).toEqual([7_260_000]);
      expect(by('backup.destination.upload')).toEqual([7_260_000, 7_260_000]);
      expect(by('fs.mkdir')).toEqual([null]);
      expect(by('backup.archive.remove').every((t) => t === null)).toBe(true);
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
      expect(overview.body.data[0]).toMatchObject({ backups: expect.any(Number), home_dir: '/home/alice', exists: true });
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
      const bobId = app.ctx.db.prepare("SELECT id FROM accounts WHERE username = 'bob'").get().id;
      app.ctx.db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot, php_version) VALUES (?, 'shop.bob.com', 'sub', '/home/bob/public_html/shop', '8.2'), (?, 'bob-addon.com', 'addon', '/home/bob/public_html/bob-addon.com', NULL), (?, 'bob-parked.com', 'parked', NULL, NULL)").run(bobId, bobId, bobId);
      const run = await post('/runs', { accounts: ['bob'] }).expect(202);
      await waitForJob(app.ctx, run.body.data.job.id);
      const archiveCall = app.agent.callsTo('backup.account.archive').pop();
      expect(archiveCall.args.databases).toEqual(['bob_shop']);
      expect(archiveCall.args.dbUsers).toEqual(['bob_app']);
      expect(archiveCall.args.dnsZones.map((z) => z.domain)).toEqual(['bob.com']);
      expect(archiveCall.args.credentials).toBeUndefined();
      expect(archiveCall.args.metadata.domains.map((d) => [d.domain, d.type])).toEqual([['bob-addon.com', 'addon'], ['bob.com', 'main'], ['bob-parked.com', 'parked'], ['shop.bob.com', 'sub']]);
      const backup = (await get('/backups?account=bob').expect(200)).body.data[0];
      expect(backup.components.mysql).toEqual([{ database: 'bob_shop' }]);
      // The archive was taken from another home root; docroots follow the new home.
      const archived = app.agent.disk.get(backup.path).metadata;
      archived.account.home_dir = '/home2/bob';
      for (const d of archived.domains) if (d.docroot) d.docroot = d.docroot.replace('/home/bob', '/home2/bob');

      await app.http.delete('/api/accounts/bob').set('X-CSRF-Token', csrf).expect(200);
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM account_domains WHERE domain LIKE '%bob%'").get().n).toBe(0);
      expect((await get('/accounts').expect(200)).body.data.find((a) => a.username === 'bob')).toMatchObject({ exists: false });
      // bob-parked.com was taken by someone else in the meantime: it stays theirs.
      const aliceId = app.ctx.db.prepare("SELECT id FROM accounts WHERE username = 'alice'").get().id;
      app.ctx.db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'bob-parked.com', 'addon', '/home/alice/public_html/bob-parked.com')").run(aliceId);
      const vhostCalls = [];
      const web = app.ctx.web;
      app.ctx.web = { ...web, ensureVhost: async (username) => { vhostCalls.push(username); return { username, applied: false, reason: 'php_missing', vhosts: [{ domain: 'bob.com', applied: false, reason: 'php_missing' }, { domain: 'shop.bob.com', applied: false, reason: 'php_missing' }, { domain: 'bob-addon.com', applied: false, reason: 'php_missing' }] }; } };
      let res;
      let job;
      try {
        await post(`/backups/${backup.id}/restore`, { kind: 'account', options: {} }).expect(409);
        res = await post(`/backups/${backup.id}/restore`, { kind: 'account', options: { createAccount: true } }).expect(202);
        job = await waitForJob(app.ctx, res.body.data.job.id);
      } finally { app.ctx.web = web; }
      expect(job.status, JSON.stringify(job)).toBe('done');
      expect(app.ctx.db.prepare("SELECT username, domain FROM accounts WHERE username = 'bob'").get()).toEqual({ username: 'bob', domain: 'bob.com' });
      expect(app.agent.callsTo('backup.archive.extract')[0].args).toMatchObject({ archive: backup.path, dest: expect.stringMatching(/^\/backup\/\.restore-\d+$/) });
      expect(app.agent.callsTo('backup.files.restore')[0].args).toMatchObject({ username: 'bob', paths: [], overwrite: true });
      expect(app.agent.callsTo('backup.db.import')[0].args.file).toMatch(/mysql\/bob_shop\.sql$/);
      const usersCall = app.agent.callsTo('backup.db.restore_users')[0].args;
      expect(usersCall.users[0]).toMatchObject({ user: 'bob_app', host: 'localhost', hashHex: '2A41' });
      expect(usersCall.users[0].grants).toEqual(["GRANT ALL PRIVILEGES ON `bob_shop`.* TO 'bob_app'@'localhost'"]);
      expect(usersCall.allowedDatabases).toEqual(['bob_shop']);
      expect(assigned).toEqual([{ kind: 'database', name: 'bob_shop', account: 'bob' }, { kind: 'user', name: 'bob_app', account: 'bob' }]);
      expect(imported).toEqual(['bob.com']);
      expect(app.agent.callsTo('backup.staging.remove')).toHaveLength(1);
      const restore = await get(`/restores/${res.body.data.restore.id}`).expect(200);
      expect(Object.fromEntries(Object.entries(restore.body.data.summary.steps).map(([k, v]) => [k, v.status]))).toMatchObject({ verify: 'done', account: 'done', domains: 'done', files: 'done', databases: 'done', dns: 'done' });
      expect(restore.body.data.summary.steps.databases.droppedGrants).toHaveLength(4);
      // Every other domain of the account is back, with its docroot under the new home and one vhost sync after the rows.
      const newBobId = app.ctx.db.prepare("SELECT id FROM accounts WHERE username = 'bob'").get().id;
      expect(app.ctx.db.prepare('SELECT domain, type, docroot, php_version FROM account_domains WHERE account_id = ? ORDER BY domain').all(newBobId)).toEqual([
        { domain: 'bob-addon.com', type: 'addon', docroot: '/home/bob/public_html/bob-addon.com', php_version: null },
        { domain: 'bob.com', type: 'main', docroot: '/home/bob/public_html', php_version: null },
        { domain: 'shop.bob.com', type: 'sub', docroot: '/home/bob/public_html/shop', php_version: '8.2' },
      ]);
      expect(vhostCalls.filter((u) => u === 'bob').length).toBeGreaterThanOrEqual(1);
      const domainsStep = restore.body.data.summary.steps.domains;
      expect(domainsStep.domains).toEqual([
        { domain: 'bob-addon.com', type: 'addon', docroot: '/home/bob/public_html/bob-addon.com', status: 'added', vhost: 'php_missing' },
        { domain: 'bob-parked.com', type: 'parked', status: 'skipped', detail: 'now belongs to alice' },
        { domain: 'shop.bob.com', type: 'sub', docroot: '/home/bob/public_html/shop', status: 'added', vhost: 'php_missing' },
      ]);
      expect(domainsStep.web).toEqual({ status: 'done', detail: 'vhosts written (php_missing)' });
      expect(app.ctx.db.prepare("SELECT account_id FROM account_domains WHERE domain = 'bob-parked.com'").get().account_id).toBe(aliceId);
      expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'backup.restore.finish'").get()).toBeTruthy();
      app.ctx.db.prepare("DELETE FROM account_domains WHERE domain = 'bob-parked.com'").run();
    });

    it('restoring into an existing account keeps its domains and only re-adds the missing ones', async () => {
      const backup = (await get('/backups?account=bob').expect(200)).body.data[0];
      const bobId = app.ctx.db.prepare("SELECT id FROM accounts WHERE username = 'bob'").get().id;
      app.ctx.db.prepare("DELETE FROM account_domains WHERE domain = 'bob-addon.com'").run();
      const web = app.ctx.web;
      app.ctx.web = { ...web, ensureVhost: async (username) => ({ username, applied: true, reason: null, vhosts: [{ domain: 'bob.com', applied: true }, { domain: 'shop.bob.com', applied: true }, { domain: 'bob-addon.com', applied: true }] }) };
      let steps;
      try {
        const res = await post(`/backups/${backup.id}/restore`, { kind: 'account', options: { files: false, databases: false, dns: false, mail: false } }).expect(202);
        expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('done');
        steps = (await get(`/restores/${res.body.data.restore.id}`).expect(200)).body.data.summary.steps;
      } finally { app.ctx.web = web; }
      expect(steps.domains).toMatchObject({ status: 'done', web: { status: 'done', detail: 'vhosts written' } });
      expect(steps.domains.domains.map((d) => [d.domain, d.status])).toEqual([['bob-addon.com', 'added'], ['bob-parked.com', 'added'], ['shop.bob.com', 'kept']]);
      expect(app.ctx.db.prepare('SELECT domain FROM account_domains WHERE account_id = ? ORDER BY domain').all(bobId).map((d) => d.domain)).toEqual(['bob-addon.com', 'bob-parked.com', 'bob.com', 'shop.bob.com']);
      expect(app.ctx.db.prepare("SELECT docroot FROM account_domains WHERE domain = 'bob-parked.com'").get().docroot).toBe('/home/bob/public_html');
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
      app.agent.disk.set('/home/alice/cpmove-alice.tar.gz', { sizeBytes: 1, sha256: 'd'.repeat(64), username: 'alice', databases: [], dnsZones: [], metadata: null });
      const home = await post('/archives/import', { path: '/home/alice/cpmove-alice.tar.gz' }).expect(422);
      expect(home.body.error.fields.path).toBeDefined();
      expect(app.agent.callsTo('backup.archive.info').map((c) => c.args.archive)).not.toContain('/home/alice/cpmove-alice.tar.gz');
      await resellerHttp.post('/api/backup/archives/import').set('X-CSRF-Token', resellerCsrf).send({ path: '/backup/cpmove-alice.tar.gz' }).expect(403);
    });

    it('restores a cPanel cpmove archive: per-database dumps without USE land in a schema created first', async () => {
      // cpmove archives carry mysql/<db>.sql dumps with no CREATE DATABASE/USE and
      // no cp/<user>.json the panel can read; the account exists already.
      const entry = app.agent.disk.get('/backup/cpmove-alice.tar.gz');
      entry.metadata = null;
      entry.databases = ['alice_shop'];
      entry.dnsZones = [];
      const previousDatabases = app.ctx.databases;
      app.ctx.databases = {
        activeProfile: () => ({ id: 1, engine: 'mysql', profile_name: 'localhost', is_local: true }),
        forAccount: () => ({ databases: [], users: [], accessHosts: [], quota: {} }),
        clientAddresses: () => ({ ipv4: null, ipv6: null }),
        assign: async (args) => args,
      };
      try {
        const backup = (await get('/backups?account=alice').expect(200)).body.data.find((b) => b.type === 'import');
        expect(backup.path).toBe('/backup/cpmove-alice.tar.gz');
        app.agent.calls.length = 0;
        const res = await post(`/backups/${backup.id}/restore`, { kind: 'account', options: { files: false, dns: false, mail: false } }).expect(202);
        const job = await waitForJob(app.ctx, res.body.data.job.id);
        expect(job.status, JSON.stringify(job)).toBe('done');
        const steps = (await get(`/restores/${res.body.data.restore.id}`).expect(200)).body.data.summary.steps;
        expect(steps.databases).toMatchObject({ status: 'done', imported: ['alice_shop'], errors: [] });
        const imports = app.agent.callsTo('backup.db.import');
        expect(imports).toHaveLength(1);
        expect(imports[0].args).toMatchObject({ database: 'alice_shop', file: expect.stringMatching(/\/mysql\/alice_shop\.sql$/) });
        expect(imports[0].args.credentials).toBeUndefined();
      } finally { app.ctx.databases = previousDatabases; }
    });
  });

  describe('ownership is fixed on the rows, not derived from the current username', () => {
    let resell2Http;
    let resell2Csrf;
    let oldId;

    beforeAll(async () => {
      const resell2 = await app.createUser('resell2', 'reseller');
      const { default: request } = await import('supertest');
      resell2Http = request.agent(app.ctx.app);
      const res = await resell2Http.post('/api/auth/login').send({ username: 'resell2', password: resell2.password });
      resell2Csrf = res.body.data.csrfToken;
    });

    it('a reseller who recreates a terminated account name cannot reach the previous tenant\'s archives', async () => {
      await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'dave', domain: 'dave.com', owner: 'resell1' }).expect(201);
      const run = await post('/runs', { accounts: ['dave'] }).expect(202);
      expect((await waitForJob(app.ctx, run.body.data.job.id)).status).toBe('done');
      const old = app.ctx.db.prepare("SELECT id, owner_id FROM backups WHERE account_name = 'dave'").get();
      oldId = old.id;
      expect(old.owner_id).toBe(reseller.id);
      await app.http.delete('/api/accounts/dave').set('X-CSRF-Token', csrf).expect(200);
      expect(app.ctx.db.prepare('SELECT account_id, owner_id FROM backups WHERE id = ?').get(oldId)).toEqual({ account_id: null, owner_id: reseller.id });
      await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'dave', domain: 'dave.com', owner: 'resell2' }).expect(201);

      const list = await resell2Http.get('/api/backup/backups').expect(200);
      expect(list.body.data).toEqual([]);
      expect((await resell2Http.get('/api/backup/backups?account=dave').expect(200)).body.data).toEqual([]);
      await resell2Http.get(`/api/backup/backups/${oldId}`).expect(403);
      await resell2Http.get(`/api/backup/backups/${oldId}/browse`).expect(403);
      await resell2Http.get(`/api/backup/backups/${oldId}/info`).expect(403);
      await resell2Http.post(`/api/backup/backups/${oldId}/fetch`).set('X-CSRF-Token', resell2Csrf).expect(403);
      await resell2Http.post(`/api/backup/backups/${oldId}/restore`).set('X-CSRF-Token', resell2Csrf).send({ kind: 'files', options: { paths: ['public_html'] } }).expect(403);
      await resell2Http.post(`/api/backup/backups/${oldId}/restore`).set('X-CSRF-Token', resell2Csrf).send({ kind: 'account', options: {} }).expect(403);
      const overview = await resell2Http.get('/api/backup/accounts').expect(200);
      expect(overview.body.data).toEqual([expect.objectContaining({ username: 'dave', backups: 0, lastBackup: null })]);
      expect(app.agent.callsTo('backup.archive.inspect')).toHaveLength(0);
      expect(app.agent.callsTo('backup.files.restore')).toHaveLength(0);

      // The previous owner keeps their data; root sees everything.
      expect((await resellerHttp.get(`/api/backup/backups/${oldId}`).expect(200)).body.data).toMatchObject({ account: 'dave', accountExists: true });
      expect((await get(`/backups/${oldId}`).expect(200)).body.data.account).toBe('dave');
      expect((await get('/accounts').expect(200)).body.data.find((a) => a.username === 'dave').backups).toBe(1);
    });

    it('orphaned archives with a reused name are never pruned by the new account\'s runs and restores stay with their owner', async () => {
      await put('/config', { 'backup.retention_daily': 1, 'backup.retention_weekly': 0, 'backup.retention_monthly': 0 }).expect(200);
      app.ctx.db.prepare("UPDATE backups SET retention_class = 'daily', created_at = '2026-09-01 02:00:00' WHERE id = ?").run(oldId);
      for (let i = 0; i < 2; i++) {
        const run = await resell2Http.post('/api/backup/runs').set('X-CSRF-Token', resell2Csrf).send({ accounts: ['dave'] }).expect(202);
        expect((await waitForJob(app.ctx, run.body.data.job.id)).status).toBe('done');
      }
      const rows = app.ctx.db.prepare("SELECT id, owner_id, account_id FROM backups WHERE account_name = 'dave' ORDER BY id").all();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: oldId, owner_id: reseller.id, account_id: null });
      expect(rows[1].owner_id).toBe(app.ctx.db.prepare("SELECT id FROM users WHERE username = 'resell2'").get().id);
      expect((await resell2Http.get('/api/backup/backups').expect(200)).body.data.map((b) => b.id)).toEqual([rows[1].id]);
      await put('/config', { 'backup.retention_daily': 7, 'backup.retention_weekly': 4, 'backup.retention_monthly': 3 }).expect(200);

      const restore = await resell2Http.post(`/api/backup/backups/${rows[1].id}/restore`).set('X-CSRF-Token', resell2Csrf).send({ kind: 'files', options: { paths: ['public_html'] } }).expect(202);
      expect((await waitForJob(app.ctx, restore.body.data.job.id)).status).toBe('done');
      expect(app.ctx.db.prepare('SELECT owner_id FROM backup_restores WHERE id = ?').get(restore.body.data.restore.id).owner_id).toBe(rows[1].owner_id);
      await resell2Http.get(`/api/backup/restores/${restore.body.data.restore.id}`).expect(200);
      await resellerHttp.get(`/api/backup/restores/${restore.body.data.restore.id}`).expect(403);
      expect((await resellerHttp.get('/api/backup/restores?account=dave').expect(200)).body.data).toEqual([]);
    });

    it('a restore skips databases, users and zones that now belong to another account', async () => {
      await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'erin', domain: 'erin.com', provision: { dns: true } }).expect(201);
      const run = await post('/runs', { accounts: ['erin'] }).expect(202);
      expect((await waitForJob(app.ctx, run.body.data.job.id)).status).toBe('done');
      const archived = app.agent.callsTo('backup.account.archive').pop().args;
      expect(archived.databases).toEqual(['erin_shop']);
      expect(archived.dnsZones.map((z) => z.domain)).toEqual(['erin.com']);
      const backup = (await get('/backups?account=erin').expect(200)).body.data[0];

      const bobId = app.ctx.db.prepare("SELECT id FROM accounts WHERE username = 'bob'").get().id;
      app.ctx.db.prepare('INSERT INTO databases (account_id, name) VALUES (?, ?)').run(bobId, 'erin_shop');
      app.ctx.db.prepare('INSERT INTO db_users (account_id, name) VALUES (?, ?)').run(bobId, 'erin_app');
      app.ctx.db.prepare("UPDATE dns_zones SET account_id = ? WHERE domain = 'erin.com'").run(bobId);
      const imported = [];
      app.ctx.dns.importZone = async ({ domain }) => { imported.push(domain); return { domain }; };
      app.agent.calls.length = 0;
      const res = await post(`/backups/${backup.id}/restore`, { kind: 'account', options: { files: false, mail: false } }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status, JSON.stringify(job)).toBe('done');
      const steps = (await get(`/restores/${res.body.data.restore.id}`).expect(200)).body.data.summary.steps;
      expect(steps.databases).toMatchObject({ status: 'skipped', imported: [], skipped: ['erin_shop (now belongs to bob)', 'user erin_app (now belongs to bob)'] });
      expect(steps.dns).toMatchObject({ status: 'skipped', zones: [], skipped: ['erin.com (now belongs to bob)'] });
      expect(app.agent.callsTo('backup.db.import')).toHaveLength(0);
      expect(app.agent.callsTo('backup.db.restore_users')).toHaveLength(0);
      expect(imported).toEqual([]);

      // Unowned objects and the account's own are restored as before.
      app.ctx.db.prepare("DELETE FROM databases WHERE name = 'erin_shop'").run();
      app.ctx.db.prepare("DELETE FROM db_users WHERE name = 'erin_app'").run();
      app.ctx.db.prepare("UPDATE dns_zones SET account_id = (SELECT id FROM accounts WHERE username = 'erin') WHERE domain = 'erin.com'").run();
      app.agent.calls.length = 0;
      const again = await post(`/backups/${backup.id}/restore`, { kind: 'account', options: { files: false, mail: false } }).expect(202);
      expect((await waitForJob(app.ctx, again.body.data.job.id)).status).toBe('done');
      const steps2 = (await get(`/restores/${again.body.data.restore.id}`).expect(200)).body.data.summary.steps;
      expect(steps2.databases).toMatchObject({ status: 'done', imported: ['erin_shop'], skipped: [] });
      expect(steps2.dns).toMatchObject({ status: 'done', zones: ['erin.com'] });
      expect(app.agent.callsTo('backup.db.import')).toHaveLength(1);
      expect(app.agent.callsTo('backup.db.restore_users')).toHaveLength(1);
      expect(imported).toEqual(['erin.com']);
    });

    it('never restores a system schema named by an archive', async () => {
      const backup = (await get('/backups?account=erin').expect(200)).body.data[0];
      app.agent.disk.get(backup.path).databases = ['mysql', 'erin_shop'];
      app.agent.calls.length = 0;
      const res = await post(`/backups/${backup.id}/restore`, { kind: 'account', options: { files: false, dns: false, mail: false } }).expect(202);
      expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('done');
      const steps = (await get(`/restores/${res.body.data.restore.id}`).expect(200)).body.data.summary.steps;
      expect(steps.databases).toMatchObject({ status: 'done', imported: ['erin_shop'], skipped: ['mysql (system schema)'] });
      expect(app.agent.callsTo('backup.db.import').map((c) => c.args.file)).toEqual([expect.stringMatching(/erin_shop\.sql$/)]);
      // The archived user's grant on the mysql schema never reaches the server; the user itself is recreated.
      const users = app.agent.callsTo('backup.db.restore_users')[0].args;
      expect(users.users[0].grants).toEqual([]);
      expect(users.allowedDatabases).toEqual(['erin_shop']);
      expect(steps.databases.droppedGrants.some((g) => /mysql.*system schema/.test(g))).toBe(true);
      app.agent.disk.get(backup.path).databases = ['erin_shop'];
    });

    it('replays grants only for databases restored into the account: a database that changed hands keeps its new owner', async () => {
      const backup = (await get('/backups?account=erin').expect(200)).body.data[0];
      const bobId = app.ctx.db.prepare("SELECT id FROM accounts WHERE username = 'bob'").get().id;
      app.ctx.db.prepare("DELETE FROM databases WHERE name = 'erin_shop'").run();
      app.ctx.db.prepare("DELETE FROM db_users WHERE name = 'erin_app'").run();
      app.ctx.db.prepare('INSERT INTO databases (account_id, name) VALUES (?, ?)').run(bobId, 'erin_shop');
      app.agent.calls.length = 0;
      const res = await post(`/backups/${backup.id}/restore`, { kind: 'account', options: { files: false, dns: false, mail: false } }).expect(202);
      expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('done');
      const steps = (await get(`/restores/${res.body.data.restore.id}`).expect(200)).body.data.summary.steps;
      expect(steps.databases).toMatchObject({ imported: [], skipped: ['erin_shop (now belongs to bob)'] });
      expect(app.agent.callsTo('backup.db.import')).toHaveLength(0);
      const users = app.agent.callsTo('backup.db.restore_users');
      expect(users).toHaveLength(1);
      expect(users[0].args.users[0]).toMatchObject({ user: 'erin_app', grants: [] });
      expect(users[0].args.allowedDatabases).toEqual([]);
      expect(steps.databases.droppedGrants).toEqual([
        expect.stringMatching(/GRANT USAGE ON \*\.\* .*\(global grant\)$/),
        expect.stringMatching(/`erin_shop`.*\(database not restored for this account\)$/),
        expect.stringMatching(/`mysql`.*\(system schema\)$/),
        expect.stringMatching(/`someone_else`.*\(database not restored for this account\)$/),
        expect.stringMatching(/`erin\\_%`.*\(wildcard database\)$/),
      ]);
      app.ctx.db.prepare("DELETE FROM databases WHERE name = 'erin_shop'").run();
    });

    it('a reseller sees and restores the archives of their own terminated accounts', async () => {
      await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'frank', domain: 'frank.com', owner: 'resell1' }).expect(201);
      const run = await resellerHttp.post('/api/backup/runs').set('X-CSRF-Token', resellerCsrf).send({ accounts: ['frank'] }).expect(202);
      expect((await waitForJob(app.ctx, run.body.data.job.id)).status).toBe('done');
      await app.http.delete('/api/accounts/frank').set('X-CSRF-Token', csrf).expect(200);
      const overview = (await resellerHttp.get('/api/backup/accounts').expect(200)).body.data;
      expect(overview.find((a) => a.username === 'frank')).toMatchObject({ exists: false, backups: 1, home_dir: null });
      // dave now belongs to resell2: not offered to its former owner although the old archive is theirs.
      expect(overview.find((a) => a.username === 'dave')).toBeUndefined();
      const backup = (await resellerHttp.get('/api/backup/backups?account=frank').expect(200)).body.data[0];
      expect(backup).toMatchObject({ account: 'frank', accountExists: false, home_dir: null });
      const res = await resellerHttp.post(`/api/backup/backups/${backup.id}/restore`).set('X-CSRF-Token', resellerCsrf).send({ kind: 'account', options: { createAccount: true, databases: false, dns: false, mail: false } }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status, JSON.stringify(job)).toBe('done');
      expect(app.ctx.db.prepare("SELECT owner_id FROM accounts WHERE username = 'frank'").get().owner_id).toBe(reseller.id);
    });

    it('restore history is filtered before it is limited, so a reseller\'s rows are never pushed out by other tenants', async () => {
      const newest = app.ctx.db.prepare('SELECT owner_id FROM backup_restores ORDER BY id DESC LIMIT 1').get();
      const mine = app.ctx.backup.listRestores({ limit: 1 }, { id: reseller.id, role: 'reseller' });
      expect(mine).toHaveLength(1);
      expect(mine[0].account_name).toBe('frank');
      expect(app.ctx.backup.listRestores({ limit: 1 }, { id: 1, role: 'root' })[0].account_name).toBe('frank');
      expect(newest.owner_id).toBe(reseller.id);
      const older = app.ctx.backup.listRestores({ limit: 1, account: 'alice' }, { id: reseller.id, role: 'reseller' });
      expect(older).toHaveLength(1);
      expect(older[0]).toMatchObject({ account_name: 'alice' });
      expect((await resellerHttp.get('/api/backup/restores?limit=1&account=alice').expect(200)).body.data[0].account_name).toBe('alice');
      expect(app.ctx.backup.listRestores({ limit: 200 }, { id: reseller.id, role: 'reseller' }).every((r) => ['alice', 'frank'].includes(r.account_name))).toBe(true);
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
    await app.http.post('/api/backup/destinations').set('X-CSRF-Token', csrf).send({ name: 'later', config: { kind: 'sftp', host: 'sftp.example.com', username: 'u', password: 'p', path: '~/backups', insecure: true } }).expect(201);
  });
});
