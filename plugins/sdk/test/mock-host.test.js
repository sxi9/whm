'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockHost } = require('../mock-host');
const V = require('../validate-manifest');
const { PermissionError, ValidationError, NotFoundError, ConflictError, PathError, LifecycleError } = require('../errors');
const { fullManifest, minimalManifest, fullModule } = require('./fixtures');

const NOW = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00Z
const accounts = [
  { username: 'alice', domain: 'alice.test', owner: 'root' },
  { username: 'bob', domain: 'bob.test', owner: 'resellerx', suspended: true },
];
const destinations = [{ id: 'dest1', name: 'offsite', kind: 's3' }];

function mk(opts = {}) {
  return createMockHost({ manifest: fullManifest(), accounts, destinations, now: NOW, services: { apache2: { active: true, pid: 42 } }, ...opts });
}

const rejectsPermission = async (fn, scope) => {
  await assert.rejects(fn, (err) => err instanceof PermissionError && err.code === 'PERMISSION_DENIED' && err.status === 403 && err.scope === scope);
};

// ---------------------------------------------------------------- construction

test('createMockHost validates the manifest and exposes a frozen ctx with every namespace', () => {
  assert.throws(() => createMockHost({ manifest: { id: 'bad' } }), ValidationError);
  const host = mk();
  const { ctx } = host;
  for (const ns of ['plugin', 'log', 'settings', 'store', 'api', 'agent', 'jobs', 'schedule', 'events', 'http', 'ui', 'crypto', 'fs', 'net', 'i18n', 'errors', 'now']) {
    assert.ok(ctx[ns] !== undefined, `ctx.${ns} missing`);
  }
  assert.ok(Object.isFrozen(ctx));
  assert.equal(ctx.plugin.id, 'net.example.hello');
  assert.equal(ctx.plugin.version, '1.2.3');
  assert.equal(ctx.plugin.dataDir, '/var/lib/whm/plugins/net.example.hello');
  assert.equal(ctx.plugin.dir, '/opt/whm/plugins/net.example.hello');
  assert.equal(ctx.plugin.isolation, 'in-process');
  assert.equal(ctx.now(), NOW);
  assert.equal(ctx.http.baseUrl, '/api/plugins/net.example.hello');
  assert.equal(ctx.errors.PermissionError, PermissionError);
});

test('clock is deterministic and injectable', async () => {
  const host = mk({ now: '2030-05-05T00:00:00Z' });
  assert.equal(host.ctx.now(), Date.UTC(2030, 4, 5));
  await host.advance(1500);
  assert.equal(host.ctx.now(), Date.UTC(2030, 4, 5) + 1500);
  host.ctx.log.info('hi');
  assert.equal(host.state.logs[0].ts, Date.UTC(2030, 4, 5) + 1500);
});

// ---------------------------------------------------------------- permission gate

test('permission gate: every gated ctx method throws PermissionError when the scope is not declared', async () => {
  const host = createMockHost({ manifest: minimalManifest({ jobs: undefined }), accounts, destinations, now: NOW });
  const { ctx } = host;
  const cases = [
    ['accounts:read', () => ctx.api.accounts.list()],
    ['accounts:read', () => ctx.api.accounts.get('alice')],
    ['accounts:write', () => ctx.api.accounts.suspend('alice', { reason: 'x' })],
    ['accounts:write', () => ctx.api.accounts.unsuspend('bob')],
    ['packages:read', () => ctx.api.packages.list()],
    ['dns:read', () => ctx.api.dns.zones.list()],
    ['dns:read', () => ctx.api.dns.zones.get('alice.test')],
    ['backups:write', () => ctx.api.backups.create({ account: 'alice' })],
    ['backups:restore', () => ctx.api.backups.restore({ artefactId: 'x', account: 'alice', confirmToken: 't' })],
    ['backups:read', () => ctx.api.backups.list()],
    ['backups:write', () => ctx.api.backups.delete('x')],
    ['backups:read', () => ctx.api.backups.destinations.list()],
    ['backups:write', () => ctx.api.backups.upload({ artefactId: 'x', destinationId: 'dest1' })],
    ['backups:read', () => ctx.api.backups.verify('x')],
    ['system:read', () => ctx.api.services.status('apache2')],
    ['system:read', () => ctx.api.system.info()],
    ['contacts:notify', () => ctx.api.contacts.notify({ event: 'net.example.minimal.x', subject: 's', body: 'b' })],
    ['audit:write', () => ctx.api.audit.record({ action: 'x' })],
    ['agent:op:svc.status', () => ctx.agent.op('svc.status', { name: 'apache2' })],
    ['jobs', () => ctx.jobs.run('nightly', {})],
    ['jobs', () => ctx.jobs.progress('j', 1)],
    ['jobs', () => ctx.jobs.status('j')],
    ['jobs', () => ctx.jobs.cancel('j')],
    ['schedule', () => ctx.schedule.cron('@daily', 'nightly')],
    ['schedule', () => ctx.schedule.unschedule('nightly')],
    ['schedule', () => ctx.schedule.list()],
    ['events:emit', () => ctx.events.emit('net.example.minimal.x', {})],
    ['api:routes', async () => ctx.http.get('/x', () => {})],
    ['api:routes', async () => ctx.http.post('/x', () => {})],
    ['api:routes', async () => ctx.http.put('/x', () => {})],
    ['api:routes', async () => ctx.http.patch('/x', () => {})],
    ['api:routes', async () => ctx.http.delete('/x', () => {})],
    ['ui:sidebar', () => ctx.ui.registerPage({ route: '/p', title: 'P', kind: 'markdown', content: 'x' })],
    ['crypto:own', () => ctx.crypto.encrypt('x')],
    ['crypto:own', () => ctx.crypto.decrypt('whm1:AAAA')],
    ['crypto:own', async () => ctx.crypto.randomToken(16)],
    ['crypto:own', async () => ctx.crypto.sha256('x')],
    ['fs:own', () => ctx.fs.readFile('a.txt')],
    ['fs:own', () => ctx.fs.writeFile('a.txt', 'x')],
    ['fs:own', () => ctx.fs.list('.')],
    ['fs:own', () => ctx.fs.remove('a.txt')],
    ['fs:own', () => ctx.fs.exists('a.txt')],
    ['fs:own', () => ctx.fs.mkdir('d')],
    ['settings:own', () => ctx.settings.get('x')],
    ['settings:own', () => ctx.settings.getAll()],
    ['settings:own', () => ctx.settings.set('x', 1)],
    ['store:own', () => ctx.store.get('k')],
    ['store:own', () => ctx.store.set('k', 1)],
    ['store:own', () => ctx.store.delete('k')],
    ['store:own', () => ctx.store.keys()],
    ['store:own', () => ctx.store.collection('c').insert({})],
    ['store:own', () => ctx.store.collection('c').find()],
    ['store:own', () => ctx.store.collection('c').findOne({})],
    ['store:own', () => ctx.store.collection('c').update({}, {})],
    ['store:own', () => ctx.store.collection('c').remove({})],
    ['store:own', () => ctx.store.collection('c').count()],
    ['net:outbound:api.example.net', () => ctx.net.fetch('https://api.example.net/v1')],
  ];
  for (const [scope, fn] of cases) await rejectsPermission(fn, scope);
  assert.deepEqual(host.deniedPermissions(), [...new Set(cases.map((c) => c[0]))].sort());
  assert.equal(host.state.permissionDenials.length, cases.length);
  // ungated: log, now, plugin, i18n, events.on/off
  host.ctx.log.debug('ok');
  assert.equal(typeof host.ctx.i18n.t('k'), 'string');
  const off = host.ctx.events.on('login.failed', () => {});
  assert.equal(off(), true);
});

test('permission gate: declared scopes work and are tracked so tests can prove declared == used', async () => {
  const host = mk();
  await host.load(fullModule());
  const { ctx } = host;
  await ctx.api.accounts.list();
  await ctx.api.accounts.suspend('alice', { reason: 'abuse' });
  await ctx.api.packages.list();
  await ctx.api.dns.zones.list();
  const art = await ctx.api.backups.create({ account: 'alice' });
  await ctx.api.backups.list();
  const token = host.issueRestoreToken(art.id, 'alice');
  await ctx.api.backups.restore({ artefactId: art.id, account: 'alice', confirmToken: token });
  await ctx.settings.get('greeting');
  await ctx.store.set('k', 1);
  await ctx.schedule.list();
  await ctx.jobs.status(await ctx.jobs.run('nightly'));
  await ctx.events.emit('net.example.hello.ping', {});
  await ctx.ui.registerPage({ route: '/extra', title: 'Extra', kind: 'markdown', content: 'x' }).catch(() => {}); // sealed after load → LifecycleError, but the gate ran first
  await ctx.api.contacts.notify({ event: 'net.example.hello.alert', subject: 's', body: 'b' });
  await ctx.api.system.info();
  await ctx.api.audit.record({ action: 'did.thing' });
  ctx.crypto.sha256('x');
  await ctx.fs.exists('x');
  await ctx.agent.op('svc.status', { name: 'apache2' });
  await ctx.net.fetch('https://api.example.net/');
  await ctx.net.fetch('https://eu.storage.example.net:8443/bucket');
  assert.deepEqual(host.unusedPermissions(), []);
  assert.deepEqual(host.deniedPermissions(), []);
});

test('grant()/revoke() toggle scopes at runtime', async () => {
  const host = createMockHost({ manifest: minimalManifest(), accounts, now: NOW });
  await rejectsPermission(() => host.ctx.api.accounts.get('alice'), 'accounts:read');
  host.grant('accounts:read');
  assert.equal((await host.ctx.api.accounts.get('alice')).username, 'alice');
  host.revoke('accounts:read');
  await rejectsPermission(() => host.ctx.api.accounts.get('alice'), 'accounts:read');
  assert.throws(() => host.grant('bogus:scope'), ValidationError);
});

// ---------------------------------------------------------------- log

test('ctx.log is structured and redacts secret-looking fields', () => {
  const host = mk();
  host.ctx.log.warn('careful', { password: 'x', apiToken: 'y', user: 'alice' });
  const entry = host.state.logs.at(-1);
  assert.equal(entry.level, 'warn');
  assert.equal(entry.plugin, 'net.example.hello');
  assert.deepEqual(entry.fields, { password: '[REDACTED]', apiToken: '[REDACTED]', user: 'alice' });
  assert.throws(() => host.ctx.log.info(42), ValidationError);
});

// ---------------------------------------------------------------- settings

test('ctx.settings: defaults, schema validation, onChange, unknown keys', async () => {
  const host = mk({ settings: { retries: 5 } });
  const { ctx } = host;
  assert.equal(await ctx.settings.get('greeting'), 'hello');
  assert.equal(await ctx.settings.get('retries'), 5);
  assert.equal(await ctx.settings.get('apiKey'), undefined);
  const all = await ctx.settings.getAll();
  assert.equal(all.mode, 'fast');
  const changes = [];
  const off = ctx.settings.onChange((k, v, prev) => changes.push([k, v, prev]));
  assert.equal(await ctx.settings.set('retries', 7), 7);
  await assert.rejects(ctx.settings.set('retries', 99), ValidationError);
  await assert.rejects(ctx.settings.set('retries', 'seven'), ValidationError);
  await assert.rejects(ctx.settings.set('mode', 'turbo'), ValidationError);
  await assert.rejects(ctx.settings.set('schedule', 'whenever'), ValidationError);
  await assert.rejects(ctx.settings.get('nope'), ValidationError);
  await ctx.settings.set('apiKey', 'secret');
  assert.deepEqual(changes, [['retries', 7, 5], ['apiKey', 'secret', undefined]]);
  off();
  await ctx.settings.set('notes', null);
  assert.equal(changes.length, 2);
  assert.throws(() => createMockHost({ manifest: fullManifest(), settings: { retries: 'x' } }), ValidationError);
});

// ---------------------------------------------------------------- store

test('ctx.store: key/value and collections, isolated and inspectable', async () => {
  const host = mk();
  const { ctx } = host;
  assert.equal(await ctx.store.get('missing'), undefined);
  await ctx.store.set('a', { n: 1 });
  await ctx.store.set('b', [1, 2]);
  assert.deepEqual(await ctx.store.get('a'), { n: 1 });
  assert.deepEqual(await ctx.store.keys(), ['a', 'b']);
  assert.deepEqual(await ctx.store.keys('b'), ['b']);
  assert.equal(await ctx.store.delete('a'), true);
  assert.equal(await ctx.store.delete('a'), false);
  await assert.rejects(ctx.store.set('', 1), ValidationError);
  await assert.rejects(ctx.store.set('u', undefined), ValidationError);
  assert.deepEqual(host.state.store.kv, { b: [1, 2] });

  const runs = ctx.store.collection('runs');
  const r1 = await runs.insert({ account: 'alice', size: 10 });
  const r2 = await runs.insert({ account: 'bob', size: 20 });
  await runs.insert({ account: 'alice', size: 30 });
  assert.equal(r1.id, 'doc_0001');
  assert.equal(r1.createdAt, NOW);
  assert.equal(await runs.count(), 3);
  assert.equal(await runs.count({ account: 'alice' }), 2);
  assert.deepEqual((await runs.find({ size: { $gte: 20 } }, { sort: { size: -1 } })).map((d) => d.size), [30, 20]);
  assert.deepEqual((await runs.find({}, { limit: 1, offset: 1, sort: { size: 1 } })).map((d) => d.size), [20]);
  assert.deepEqual((await runs.find({ account: { $in: ['bob'] } })).map((d) => d.id), [r2.id]);
  assert.equal((await runs.findOne({ account: 'bob' })).size, 20);
  assert.equal(await runs.findOne({ account: 'carol' }), null);
  assert.equal(await runs.update({ account: 'alice' }, { size: 99, id: 'hack' }), 2);
  assert.equal((await runs.findOne({ id: r1.id })).size, 99);
  assert.equal(await runs.remove({ account: 'bob' }), 1);
  assert.equal(await runs.count(), 2);
  await assert.rejects(runs.insert({ id: r1.id }), ConflictError);
  await assert.rejects(runs.find({ size: { $weird: 1 } }), ValidationError);
  assert.throws(() => ctx.store.collection('Bad Name'), ValidationError);
  assert.equal(host.state.store.collections.runs.length, 2);
});

// ---------------------------------------------------------------- api

test('ctx.api.accounts / packages / dns / services / system', async () => {
  const host = mk({ zones: [{ domain: 'alice.test', account: 'alice', serial: 1, records: [{ name: '@', type: 'A', value: '203.0.113.10' }] }] });
  const { ctx } = host;
  const all = await ctx.api.accounts.list();
  assert.equal(all.meta.total, 2);
  assert.equal((await ctx.api.accounts.list({ suspended: true })).data[0].username, 'bob');
  assert.equal((await ctx.api.accounts.list({ owner: 'root' })).data.length, 1);
  assert.equal((await ctx.api.accounts.list({ page: 2, pageSize: 1 })).data[0].username, 'bob');
  await assert.rejects(ctx.api.accounts.get('carol'), NotFoundError);
  await ctx.api.accounts.suspend('alice', { reason: 'spam' });
  assert.equal((await ctx.api.accounts.get('alice')).suspended, true);
  await assert.rejects(ctx.api.accounts.suspend('alice'), ConflictError);
  await ctx.api.accounts.unsuspend('alice');
  assert.deepEqual(host.state.suspensions.map((s) => s.action), ['suspend', 'unsuspend']);
  assert.equal((await ctx.api.packages.list())[0].name, 'default');
  assert.equal((await ctx.api.dns.zones.list())[0].records, undefined);
  assert.equal((await ctx.api.dns.zones.get('alice.test')).records.length, 1);
  await assert.rejects(ctx.api.dns.zones.get('nope.test'), NotFoundError);
  assert.deepEqual(await ctx.api.services.status('apache2'), { name: 'apache2', active: true, enabled: true, pid: 42, since: null });
  await assert.rejects(ctx.api.services.status('named'), NotFoundError);
  const info = await ctx.api.system.info();
  assert.equal(info.panelVersion, '1.0.0');
  assert.ok(info.hostname);
});

test('ctx.api.backups: full artefact lifecycle, restore requires an admin confirm token', async () => {
  const host = mk();
  const { ctx } = host;
  const art = await ctx.api.backups.create({ account: 'alice', include: ['home', 'db'], compression: 'zstd', encrypt: true });
  assert.match(art.id, /^bk_/);
  assert.equal(art.account, 'alice');
  assert.match(art.path, /\.tar\.zst\.enc$/);
  assert.match(art.sha256, /^[0-9a-f]{64}$/);
  assert.equal(art.createdAt, NOW);
  assert.ok(art.size > 0);
  await assert.rejects(ctx.api.backups.create({ account: 'carol' }), NotFoundError);
  await assert.rejects(ctx.api.backups.create({ account: 'alice', include: ['kernel'] }), ValidationError);
  await assert.rejects(ctx.api.backups.create({ account: 'alice', compression: 'rar' }), ValidationError);
  assert.equal((await ctx.api.backups.list()).length, 1);
  assert.equal((await ctx.api.backups.list({ account: 'bob' })).length, 0);
  assert.deepEqual(await ctx.api.backups.destinations.list(), [{ id: 'dest1', name: 'offsite', kind: 's3' }]);
  const up = await ctx.api.backups.upload({ artefactId: art.id, destinationId: 'dest1' });
  assert.equal(up.ok, true);
  assert.equal(up.sha256, art.sha256);
  assert.equal(up.remotePath, `s3://offsite/alice/${art.id}.tar.zst.enc`);
  await assert.rejects(ctx.api.backups.upload({ artefactId: art.id, destinationId: 'nope' }), NotFoundError);
  const ver = await ctx.api.backups.verify(art.id);
  assert.deepEqual(ver, { ok: true, sha256: art.sha256, size: art.size, verifiedAt: NOW });
  // restore: a plugin cannot mint its own token
  await assert.rejects(ctx.api.backups.restore({ artefactId: art.id, account: 'alice', confirmToken: 'forged' }), PermissionError);
  const token = host.issueRestoreToken(art.id, 'alice');
  await assert.rejects(ctx.api.backups.restore({ artefactId: art.id, account: 'bob', confirmToken: token }), PermissionError);
  const r = await ctx.api.backups.restore({ artefactId: art.id, account: 'alice', confirmToken: token });
  assert.equal(r.ok, true);
  assert.match(r.jobId, /^hostjob_/);
  await assert.rejects(ctx.api.backups.restore({ artefactId: art.id, account: 'alice', confirmToken: token }), PermissionError); // single use
  const expired = host.issueRestoreToken(art.id, 'alice', { ttlMs: 1000 });
  await host.advance(2000);
  await assert.rejects(ctx.api.backups.restore({ artefactId: art.id, account: 'alice', confirmToken: expired }), PermissionError);
  assert.deepEqual(await ctx.api.backups.delete(art.id), { ok: true });
  await assert.rejects(ctx.api.backups.verify(art.id), NotFoundError);
  assert.equal(host.state.backups.length, 0);
  assert.equal(host.state.backupsCreated.length, 1);
  assert.equal(host.state.backupsDeleted.length, 1);
  assert.equal(host.state.uploads.length, 1);
  assert.equal(host.state.restores.length, 1);
  assert.equal(host.state.verifications.length, 1);
});

test('ctx.api.contacts.notify and ctx.api.audit.record are recorded and namespaced', async () => {
  const host = mk();
  const { ctx } = host;
  await ctx.api.contacts.notify({ event: 'net.example.hello.backup_failed', subject: 'Backup failed', body: 'x', severity: 'critical' });
  assert.equal(host.state.notifications[0].severity, 'critical');
  await assert.rejects(ctx.api.contacts.notify({ event: 'backup.failed', subject: 's', body: 'b' }), ValidationError);
  await assert.rejects(ctx.api.contacts.notify({ event: 'net.example.hello.x', subject: 's', body: 'b', severity: 'meh' }), ValidationError);
  const { id } = await ctx.api.audit.record({ action: 'backup.run', target: 'alice', details: { password: 'x', n: 1 } });
  assert.match(id, /^audit_/);
  assert.equal(host.state.audit[0].action, 'plugin:net.example.hello:backup.run');
  assert.equal(host.state.audit[0].principal, 'plugin:net.example.hello');
  assert.deepEqual(host.state.audit[0].details, { password: '[REDACTED]', n: 1 });
  await assert.rejects(ctx.api.audit.record({ action: 'Bad Action' }), ValidationError);
});

// ---------------------------------------------------------------- agent

test('ctx.agent.op is gated per op and records calls; responders are configurable', async () => {
  const host = mk({ agentOps: { 'svc.status': (args) => ({ active: args.name === 'apache2' }) } });
  const r = await host.ctx.agent.op('svc.status', { name: 'apache2' });
  assert.deepEqual(r, { active: true });
  await rejectsPermission(() => host.ctx.agent.op('svc.restart', { name: 'apache2' }), 'agent:op:svc.restart');
  await assert.rejects(host.ctx.agent.op('rm -rf /'), ValidationError);
  await assert.rejects(host.ctx.agent.op('svc.status', 'apache2'), ValidationError);
  assert.deepEqual(host.state.agentOps, [{ op: 'svc.status', args: { name: 'apache2' }, result: { active: true }, ts: NOW }]);
});

// ---------------------------------------------------------------- jobs

test('ctx.jobs: run / progress / status / cancel with declared handlers', async () => {
  const spy = {};
  const host = mk();
  assert.deepEqual(await host.load(fullModule(spy)), { ok: true });
  const { ctx } = host;
  const id = await ctx.jobs.run('nightly', { source: 'test' });
  assert.match(id, /^job_/);
  await host.flush();
  const st = await ctx.jobs.status(id);
  assert.equal(st.status, 'done');
  assert.equal(st.progress, 100);
  assert.equal(st.message, 'halfway');
  assert.deepEqual(st.result, { ran: true, at: NOW });
  assert.deepEqual(st.params, { source: 'test' });
  assert.equal(st.trigger, 'manual');
  assert.ok(spy.calls.includes('job:nightly:{"source":"test"}'));
  assert.equal(await ctx.store.get('lastRun'), NOW);
  assert.equal(host.state.jobs[0].log[0].msg, 'halfway');
  await assert.rejects(ctx.jobs.run('undeclared'), ValidationError);
  await assert.rejects(ctx.jobs.status('job_9999'), NotFoundError);
  await assert.rejects(ctx.jobs.progress(id, 150), ValidationError);
  assert.equal(await ctx.jobs.cancel(id), false); // already done
});

test('ctx.jobs: failures, cancellation and non-cancellable jobs', async () => {
  const host = mk();
  let release;
  const gateP = new Promise((r) => { release = r; });
  host.registerJob('nightly', async (job) => {
    job.progress(10, 'waiting');
    await gateP;
    if (job.signal.aborted) throw new Error('aborted');
    return 'done';
  });
  host.registerJob('locked', async () => { throw new ValidationError('bad input'); });
  const { ctx } = host;
  const id = await ctx.jobs.run('nightly');
  assert.equal((await ctx.jobs.status(id)).status, 'running');
  assert.equal(await ctx.jobs.cancel(id), true);
  release();
  await host.flush();
  assert.equal((await ctx.jobs.status(id)).status, 'cancelled');
  const failed = await host.runJob('locked');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, { code: 'VALIDATION_ERROR', message: 'bad input' });
  host.registerJob('locked', () => new Promise(() => {}));
  const lockedId = await ctx.jobs.run('locked');
  await assert.rejects(ctx.jobs.cancel(lockedId), ConflictError);
  assert.throws(() => host.registerJob('nope', () => {}), ValidationError);
});

// ---------------------------------------------------------------- schedule / cron

test('manifest cron (including setting-referenced schedules) is registered on load and runs on advance()', async () => {
  const spy = {};
  const host = mk();
  await host.load(fullModule(spy));
  const list = await host.ctx.schedule.list();
  assert.equal(list.length, 1, 'disabled entry is skipped');
  assert.equal(list[0].name, 'nightly-run');
  assert.equal(list[0].expr, '0 2 * * *');
  assert.equal(list[0].source, 'manifest');
  assert.equal(list[0].nextRunAt, Date.UTC(2026, 0, 1, 2));
  await host.advance(60 * 60 * 1000);
  assert.equal(host.state.jobs.length, 0);
  await host.advance(2 * 60 * 60 * 1000);
  assert.equal(host.state.jobs.length, 1);
  assert.equal(host.state.jobs[0].trigger, 'cron:nightly-run');
  assert.deepEqual(host.state.jobs[0].params, { source: 'cron' });
  assert.equal(host.state.jobs[0].startedAt, Date.UTC(2026, 0, 1, 2), 'job ran at its scheduled instant');
  assert.equal(host.ctx.now(), NOW + 3 * 60 * 60 * 1000);
  await host.advance(3 * 24 * 60 * 60 * 1000);
  assert.equal(host.state.jobs.length, 4);
  // changing the referenced setting rebinds the schedule
  await host.ctx.settings.set('schedule', '*/30 * * * *');
  const rebound = await host.ctx.schedule.list();
  assert.equal(rebound[0].expr, '*/30 * * * *');
  await host.advance(60 * 60 * 1000);
  assert.equal(host.state.jobs.length, 6);
});

test('ctx.schedule.cron / unschedule at runtime', async () => {
  const host = mk();
  host.registerJob('nightly', async () => 'ok');
  const { ctx } = host;
  const s = await ctx.schedule.cron('*/10 * * * *', 'nightly', { via: 'runtime' });
  assert.equal(s.nextRunAt, NOW + 10 * 60 * 1000);
  assert.equal(host.state.cron.length, 1);
  await assert.rejects(ctx.schedule.cron('@daily', 'nightly'), ConflictError);
  await assert.rejects(ctx.schedule.cron('bogus', 'locked'), ValidationError);
  await assert.rejects(ctx.schedule.cron('@daily', 'undeclared'), ValidationError);
  await host.advance(35 * 60 * 1000);
  assert.equal(host.state.jobs.length, 3);
  assert.deepEqual(host.state.jobs.map((j) => j.startedAt), [NOW + 600000, NOW + 1200000, NOW + 1800000]);
  assert.equal(await ctx.schedule.unschedule('nightly'), true);
  assert.equal(await ctx.schedule.unschedule('nightly'), false);
  await host.advance(60 * 60 * 1000);
  assert.equal(host.state.jobs.length, 3);
});

// ---------------------------------------------------------------- hooks / events

test('fire() delivers manifest hooks and runtime subscriptions; pre hooks can cancel with the right scope', async () => {
  const spy = {};
  const host = mk();
  await host.load(fullModule(spy));
  const seen = [];
  const off = host.ctx.events.on('account.created', (evt) => seen.push(evt.payload.username));
  const r1 = await host.fire('account.created', { username: 'carol' });
  assert.deepEqual(r1, { event: 'account.created', stage: 'post', delivered: 2, cancelled: false, reason: null, errors: [] });
  assert.ok(spy.calls.includes('post:account.created:carol'));
  assert.deepEqual(seen, ['carol']);
  const r2 = await host.fire('account.created', { username: 'blocked' }, { stage: 'pre' });
  assert.equal(r2.cancelled, true);
  assert.equal(r2.reason, 'username is blocked');
  const r3 = await host.fire('account.created', { username: 'dave' }, { stage: 'pre' });
  assert.equal(r3.cancelled, false);
  assert.equal(r3.delivered, 1);
  off();
  await host.fire('account.created', { username: 'erin' });
  assert.deepEqual(seen, ['carol']);
  await assert.rejects(host.fire('nope.event', {}), ValidationError);
  await assert.rejects(host.fire('backup.completed', {}, { stage: 'pre' }), ValidationError);
  assert.equal(host.state.hookDeliveries.length, 4);
  // payload is frozen for handlers
  host.ctx.events.on('login.failed', (evt) => { assert.throws(() => { evt.payload.username = 'x'; }); });
  await host.fire('login.failed', { username: 'root', ip: '1.2.3.4' });
});

test('cancelling a pre hook without the cancel scope is a PermissionError; handler errors never cancel', async () => {
  const manifest = fullManifest({ permissions: fullManifest().permissions.filter((p) => p !== 'accounts:write') });
  const host = createMockHost({ manifest, accounts, now: NOW });
  await host.load(fullModule());
  const r = await host.fire('account.created', { username: 'blocked' }, { stage: 'pre' });
  assert.equal(r.cancelled, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, 'PERMISSION_DENIED');
  assert.deepEqual(host.deniedPermissions(), ['accounts:write']);
  host.ctx.events.on('service.restarted', (evt) => evt.cancel('no'), { stage: 'pre' });
  const r2 = await host.fire('service.restarted', { service: 'apache2' }, { stage: 'pre' });
  assert.equal(r2.cancelled, false);
  assert.equal(r2.errors[0].code, 'HOOK_NOT_CANCELLABLE');
  host.ctx.events.on('login.failed', () => { throw new Error('oops'); });
  const r3 = await host.fire('login.failed', {});
  assert.equal(r3.errors[0].message, 'oops');
  assert.ok(host.state.logs.some((l) => l.level === 'error' && /hook handler/.test(l.msg)));
});

test('ctx.events.emit only within the plugin namespace; on() validates events/stages', async () => {
  const host = mk();
  const { ctx } = host;
  const got = [];
  ctx.events.on('net.example.hello.greeted', (evt) => got.push(evt.payload));
  const r = await ctx.events.emit('net.example.hello.greeted', { who: 'alice' });
  assert.deepEqual(r, { delivered: 1 });
  assert.deepEqual(got, [{ who: 'alice' }]);
  assert.deepEqual(host.state.emitted, [{ event: 'net.example.hello.greeted', payload: { who: 'alice' }, ts: NOW }]);
  await assert.rejects(ctx.events.emit('net.example.other.greeted', {}), PermissionError);
  await assert.rejects(ctx.events.emit('account.created', {}), ValidationError);
  await assert.rejects(ctx.events.emit('net.example.hello.greeted', 'x'), ValidationError);
  assert.throws(() => ctx.events.on('whatever', () => {}), ValidationError);
  assert.throws(() => ctx.events.on('backup.completed', () => {}, { stage: 'pre' }), ValidationError);
  assert.throws(() => ctx.events.on('net.example.hello.x', () => {}, { stage: 'pre' }), ValidationError);
  assert.throws(() => ctx.events.on('login.failed', 'nope'), ValidationError);
  assert.equal(ctx.events.off('login.failed', () => {}), false);
});

// ---------------------------------------------------------------- http routes

test('ctx.http router + callRoute: params, query, body, roles, envelopes, error mapping', async () => {
  const host = mk();
  await host.load(fullModule());
  assert.deepEqual(host.state.routes.map((r) => `${r.method} ${r.path}`), ['GET /items', 'GET /items/:id', 'POST /items', 'GET /boom', 'GET /missing']);
  assert.deepEqual(host.state.routes[2].roles, ['root', 'reseller']);
  const list = await host.callRoute('GET', '/items');
  assert.deepEqual(list, { status: 200, body: { data: [{ id: 1 }] }, headers: {} });
  const one = await host.callRoute('get', '/items/42', { query: { q: 'x' } });
  assert.deepEqual(one.body, { data: { id: '42', q: 'x' } });
  const created = await host.callRoute('POST', '/items', { body: { name: 'n' }, user: { id: 2, username: 'res', role: 'reseller' } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { data: { name: 'n' } });
  const forbidden = await host.callRoute('GET', '/items', { user: { id: 2, username: 'res', role: 'reseller' } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'FORBIDDEN');
  const missing = await host.callRoute('GET', '/nowhere');
  assert.equal(missing.status, 404);
  const boom = await host.callRoute('GET', '/boom');
  assert.equal(boom.status, 500);
  assert.deepEqual(boom.body, { error: { code: 'INTERNAL', message: 'plugin route failed' } });
  const nf = await host.callRoute('GET', '/missing');
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, 'NOT_FOUND');
  // registration is closed after activation
  assert.throws(() => host.ctx.http.get('/late', () => {}), LifecycleError);
});

test('router validation: bad paths, duplicate routes, bad roles, res helpers', async () => {
  const host = mk();
  const { ctx } = host;
  ctx.http.get('/a', async (req, res) => res.set('X-Thing', '1').status(202).send('accepted'));
  ctx.http.get('/err', async (req, res) => res.error('TEAPOT', 'short and stout', 418));
  ctx.http.get('/none', async () => {});
  assert.throws(() => ctx.http.get('/a', () => {}), ConflictError);
  assert.throws(() => ctx.http.get('no-slash', () => {}), ValidationError);
  assert.throws(() => ctx.http.get('/b', 'nope'), ValidationError);
  assert.throws(() => ctx.http.get('/b', { roles: ['admin'] }, () => {}), ValidationError);
  const a = await host.callRoute('GET', '/a');
  assert.deepEqual(a, { status: 202, body: 'accepted', headers: { 'x-thing': '1' } });
  const e = await host.callRoute('GET', '/err');
  assert.deepEqual(e, { status: 418, body: { error: { code: 'TEAPOT', message: 'short and stout' } }, headers: {} });
  assert.equal((await host.callRoute('GET', '/none')).status, 204);
});

// ---------------------------------------------------------------- ui

test('ctx.ui.registerPage validates descriptors; manifest pages registered on load', async () => {
  const host = mk();
  await host.ctx.ui.registerPage({ route: '/about', title: 'About', kind: 'markdown', content: '# hi' });
  await assert.rejects(host.ctx.ui.registerPage({ route: '/about', title: 'Dup', kind: 'markdown', content: 'x' }), ConflictError);
  await assert.rejects(host.ctx.ui.registerPage({ route: '/bad', title: 'Bad', kind: 'table' }), ValidationError);
  await assert.rejects(host.ctx.ui.registerPage({ route: '/act', title: 'Act', kind: 'action', job: 'nope' }), ValidationError);
  await host.load(fullModule());
  assert.deepEqual(host.state.pages.map((p) => `${p.source}:${p.route}`), ['runtime:/about', 'manifest:/', 'manifest:/settings', 'manifest:/run']);
  await assert.rejects(host.ctx.ui.registerPage({ route: '/late', title: 'L', kind: 'markdown', content: 'x' }), LifecycleError);
});

// ---------------------------------------------------------------- crypto

test('ctx.crypto: encrypt/decrypt roundtrip with a plugin-scoped key, sha256, randomToken', async () => {
  const host = mk();
  const { ctx } = host;
  const ct = await ctx.crypto.encrypt('s3cret');
  assert.match(ct, /^whm1:[A-Za-z0-9+/=]+$/);
  assert.equal(await ctx.crypto.decrypt(ct), 's3cret');
  assert.notEqual(await ctx.crypto.encrypt('s3cret'), ct, 'random IV');
  await assert.rejects(ctx.crypto.decrypt('nope'), ValidationError);
  await assert.rejects(ctx.crypto.decrypt(`whm1:${Buffer.alloc(40, 1).toString('base64')}`), ValidationError);
  await assert.rejects(ctx.crypto.encrypt(42), ValidationError);
  // another plugin cannot decrypt this plugin's ciphertext
  const other = createMockHost({ manifest: fullManifest({ id: 'net.example.other' }), now: NOW });
  await assert.rejects(other.ctx.crypto.decrypt(ct), ValidationError);
  assert.equal(ctx.crypto.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(ctx.crypto.sha256(Buffer.from('abc')), ctx.crypto.sha256('abc'));
  assert.match(ctx.crypto.randomToken(16), /^[0-9a-f]{32}$/);
  assert.match(ctx.crypto.randomToken(), /^[0-9a-f]{64}$/);
  assert.throws(() => ctx.crypto.randomToken(2), ValidationError);
});

// ---------------------------------------------------------------- fs

test('ctx.fs is sandboxed to the data dir and rejects traversal', async () => {
  const host = mk();
  const { ctx } = host;
  await ctx.fs.writeFile('state/run.json', '{"n":1}');
  await ctx.fs.writeFile('blob.bin', Buffer.from([1, 2, 3]));
  assert.equal(await ctx.fs.readFile('state/run.json'), '{"n":1}');
  assert.deepEqual(await ctx.fs.readFile('blob.bin', { encoding: null }), Buffer.from([1, 2, 3]));
  assert.equal(await ctx.fs.exists('state'), true);
  assert.equal(await ctx.fs.exists('nope'), false);
  assert.equal(await ctx.fs.exists('.'), true);
  assert.deepEqual((await ctx.fs.list('.')).map((e) => `${e.type}:${e.name}`), ['file:blob.bin', 'dir:state']);
  assert.deepEqual((await ctx.fs.list('state')).map((e) => e.name), ['run.json']);
  await ctx.fs.mkdir('new');
  for (const bad of ['../etc/passwd', '/etc/passwd', 'state/../../x', 'a\0b', 'a\\b', '', 42]) {
    await assert.rejects(ctx.fs.readFile(bad), PathError, String(bad));
    await assert.rejects(ctx.fs.writeFile(bad, 'x'), PathError, String(bad));
    await assert.rejects(ctx.fs.exists(bad), PathError, String(bad));
    await assert.rejects(ctx.fs.remove(bad), PathError, String(bad));
    await assert.rejects(ctx.fs.mkdir(bad), PathError, String(bad));
  }
  assert.equal(await ctx.fs.readFile('state/../blob.bin', { encoding: 'hex' }), '010203', 'normalised but contained paths are fine');
  await assert.rejects(ctx.fs.readFile('missing.txt'), NotFoundError);
  await assert.rejects(ctx.fs.list('missing'), NotFoundError);
  await assert.rejects(ctx.fs.writeFile('state', 'x'), PathError);
  await assert.rejects(ctx.fs.writeFile('.', 'x'), PathError);
  await assert.rejects(ctx.fs.remove('state'), PathError);
  assert.equal(await ctx.fs.remove('state', { recursive: true }), true);
  assert.equal(await ctx.fs.remove('state'), false);
  assert.equal(await ctx.fs.remove('blob.bin'), true);
  assert.deepEqual(host.state.fs, {});
});

// ---------------------------------------------------------------- net

test('ctx.net.fetch enforces https and declared net:outbound hosts', async () => {
  const calls = [];
  const host = mk({ fetch: async (url, init) => { calls.push([url, init && init.method]); return { ok: true, status: 201, headers: {}, text: async () => 'hi', json: async () => ({ hi: 1 }) }; } });
  const { ctx } = host;
  const r = await ctx.net.fetch('https://api.example.net/v1/ping', { method: 'POST', body: '{}' });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { hi: 1 });
  assert.deepEqual(calls, [['https://api.example.net/v1/ping', 'POST']]);
  assert.equal(host.state.requests[0].method, 'POST');
  await ctx.net.fetch('https://eu.storage.example.net:8443/b');
  await rejectsPermission(() => ctx.net.fetch('https://eu.storage.example.net/b'), 'net:outbound:eu.storage.example.net');
  await rejectsPermission(() => ctx.net.fetch('https://evil.example.org/'), 'net:outbound:evil.example.org');
  await assert.rejects(ctx.net.fetch('http://api.example.net/'), ValidationError);
  await assert.rejects(ctx.net.fetch('not a url'), ValidationError);
});

// ---------------------------------------------------------------- i18n

test('ctx.i18n.t resolves keys with fallback and interpolation', () => {
  const host = mk({ locale: 'de', locales: { en: { hello: 'Hello {name}', only_en: 'EN' }, de: { hello: 'Hallo {name}' } } });
  assert.equal(host.ctx.i18n.locale(), 'de');
  assert.equal(host.ctx.i18n.t('hello', { name: 'Bob' }), 'Hallo Bob');
  assert.equal(host.ctx.i18n.t('only_en'), 'EN');
  assert.equal(host.ctx.i18n.t('missing.key'), 'missing.key');
  assert.equal(host.ctx.i18n.t('hello', { name: 'Al' }, 'en'), 'Hello Al');
  assert.equal(host.ctx.i18n.t('hello'), 'Hallo {name}');
});

// ---------------------------------------------------------------- lifecycle

test('load(): activate throwing marks the plugin errored (not running)', async () => {
  const host = mk();
  const mod = fullModule();
  mod.activate = async () => { throw new Error('boom at start'); };
  const r = await host.load(mod);
  assert.equal(r.ok, false);
  assert.equal(r.error.message, 'boom at start');
  assert.equal(host.state.lifecycle, 'errored');
  assert.deepEqual(host.state.lastError, { code: 'ACTIVATE_FAILED', message: 'boom at start' });
  assert.ok(host.state.logs.some((l) => l.level === 'error' && l.msg === 'plugin activation failed'));
});

test('load(): verifies engines compatibility and exported handlers before activating', async () => {
  const incompatible = mk({ hostVersion: '2.0.0' });
  const r1 = await incompatible.load(fullModule());
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'INCOMPATIBLE_HOST');
  assert.equal(incompatible.state.lifecycle, 'errored');
  const lenient = mk({ hostVersion: '2.0.0', strictEngines: false });
  assert.equal((await lenient.load(fullModule())).ok, true);

  const missingHook = mk();
  const mod = fullModule();
  delete mod.hooks.onBackupCompleted;
  const r2 = await missingHook.load(mod);
  assert.equal(r2.ok, false);
  assert.match(r2.error.message, /onBackupCompleted/);

  const missingJob = mk();
  const mod2 = fullModule();
  delete mod2.jobs.locked;
  assert.match((await missingJob.load(mod2)).error.message, /job "locked"/);

  const badExport = mk();
  const mod3 = fullModule();
  mod3.activate = 'nope';
  assert.match((await badExport.load(mod3)).error.message, /activate must be a function/);
  assert.equal((await mk().load(null)).ok, false);
});

test('load() with fromVersion runs migrate() before activate(); unload() runs deactivate() and clears schedules', async () => {
  const spy = {};
  const host = mk();
  const r = await host.load(fullModule(spy), { fromVersion: '1.1.0' });
  assert.equal(r.ok, true);
  assert.deepEqual(spy.calls.slice(0, 2), ['migrate:1.1.0', 'activate']);
  assert.deepEqual(host.state.migrations, [{ from: '1.1.0', to: '1.2.3', ts: NOW }]);
  assert.equal(host.state.lifecycle, 'running');
  assert.equal(host.state.cron.length, 1);
  await host.unload();
  assert.ok(spy.calls.includes('deactivate'));
  assert.equal(host.state.lifecycle, 'stopped');
  assert.equal(host.state.cron.length, 0);
  await assert.rejects(mk().unload(), LifecycleError);
  assert.equal((await mk().load(fullModule(), { fromVersion: 'old' })).error.code, 'VALIDATION_ERROR');
});

test('a plugin that only declares what it uses passes the declared == used check end to end', async () => {
  const manifest = minimalManifest({
    permissions: ['store:own', 'jobs', 'schedule', 'contacts:notify'],
    jobs: { tick: { label: 'Tick' } },
    cron: [{ name: 'tick', job: 'tick', schedule: '*/5 * * * *' }],
  });
  const host = createMockHost({ manifest, now: NOW });
  await host.load({
    async activate(ctx) { await ctx.store.set('boots', ((await ctx.store.get('boots')) || 0) + 1); },
    jobs: {
      async tick(job, ctx) {
        const n = ((await ctx.store.get('ticks')) || 0) + 1;
        await ctx.store.set('ticks', n);
        if (n === 2) await ctx.api.contacts.notify({ event: 'net.example.minimal.two_ticks', subject: 'two', body: 'ticks', severity: 'info' });
        await ctx.schedule.list();
        return n;
      },
    },
  });
  await host.advance(10 * 60 * 1000);
  assert.equal(host.state.store.kv.ticks, 2);
  assert.equal(host.state.notifications.length, 1);
  assert.deepEqual(host.unusedPermissions(), ['jobs']); // nothing called ctx.jobs.* directly
  assert.deepEqual(host.deniedPermissions(), []);
  assert.deepEqual(Object.keys(V.PERMISSIONS).filter((s) => host.granted().includes(s)), ['store:own', 'schedule', 'jobs', 'contacts:notify']);
});
