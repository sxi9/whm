'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMockHost, validateManifest, BACKUP_COMPONENTS, PermissionError, ValidationError, ConflictError } = require(path.join(__dirname, '..', '..', '..', 'sdk'));
const manifest = require('../plugin.json');
const mod = require('../main');

const NOW = Date.UTC(2026, 0, 1); // Thursday
const H = 3600e3;
const DAY = 86400e3;
const accounts = [
  { username: 'alice', domain: 'alice.test', package: 'gold' },
  { username: 'bob', domain: 'bob.test', package: 'silver', owner: 'resell1' },
  { username: 'carol', domain: 'carol.test', package: 'gold' },
];
const packages = [{ name: 'gold', disk_mb: 1 }, { name: 'silver', disk_mb: 1 }];
const destinations = [{ id: 'offsite', name: 'Offsite S3', kind: 's3' }, { id: 'nas', name: 'Office NAS', kind: 'sftp' }];

function host(opts = {}) {
  return createMockHost({ manifest, accounts, packages, destinations, now: NOW, ...opts });
}
async function loaded(opts) {
  const h = host(opts);
  assert.deepEqual(await h.load(mod), { ok: true }, JSON.stringify(h.state.lastError));
  return h;
}
// A host whose job handlers run the plugin's code against a ctx with patched
// ctx.api.backups methods (no load(): a loaded module's handlers take precedence).
function spy(settings, patch) {
  const h = host({ settings });
  const wrap = (fn) => async (job, c) => fn(job, { ...c, api: { ...c.api, backups: { ...c.api.backups, ...patch(c) } } });
  for (const name of ['run', 'prune', 'restore']) h.registerJob(name, wrap(mod.jobs[name]));
  return h;
}
const runs = (h, kind) => h.ctx.store.collection('runs').find(kind ? { kind } : {}, { sort: { startedAt: 1 } });
const artefacts = (h, q = {}) => h.ctx.store.collection('artefacts').find(q, { sort: { createdAt: 1 } });

// ---------------------------------------------------------------- manifest

test('manifest: valid, the exact permission set of the build plan, settings and pages as specified', () => {
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  assert.equal(manifest.id, 'net.whm.automated-backup');
  assert.deepEqual([...manifest.permissions].sort(), ['accounts:read', 'api:routes', 'backups:read', 'backups:restore', 'backups:write', 'contacts:notify', 'jobs', 'packages:read', 'schedule', 'settings:own', 'store:own', 'ui:sidebar']);
  const keys = manifest.settings.fields.map((f) => f.key);
  assert.deepEqual(keys, ['scope', 'packages', 'accounts', 'include', 'verify', 'encrypt', 'schedule', 'retention_daily', 'retention_weekly', 'retention_monthly', 'destinations', 'notify_on', 'max_parallel', 'lock_ttl_minutes']);
  const include = manifest.settings.fields.find((f) => f.key === 'include');
  assert.deepEqual(include.options.map((o) => o.value), [...BACKUP_COMPONENTS]);
  assert.equal(manifest.settings.fields.find((f) => f.key === 'schedule').type, 'cron');
  assert.equal(manifest.settings.fields.find((f) => f.key === 'schedule').default, undefined, 'unscheduled until the operator sets it');
  assert.deepEqual(manifest.cron, [{ name: 'scheduled-run', job: 'run', schedule: 'setting:schedule', params: { source: 'cron' } }]);
  assert.deepEqual(Object.keys(manifest.jobs), ['run', 'prune', 'restore']);
  assert.equal(manifest.jobs.restore.cancellable, false);
  assert.deepEqual(manifest.ui.pages.map((p) => [p.route, p.kind]), [['/settings', 'settings'], ['/history', 'table'], ['/destinations', 'table'], ['/artefacts', 'table'], ['/locks', 'table'], ['/run-now', 'action'], ['/restore', 'form']]);
  assert.deepEqual(manifest.ui.sidebar, [{ category: 'Backup', label: 'Automated Backup', route: '/history', icon: 'archive' }]);
  assert.deepEqual(manifest.ui.pages.find((p) => p.route === '/restore').fields.map((f) => f.key), ['artefactId', 'account', 'confirmToken']);
});

// ---------------------------------------------------------------- schedule

test('without a schedule nothing is scheduled; setting one binds the cron and advancing the clock runs the job for every account', async () => {
  const h = await loaded();
  assert.deepEqual(await h.ctx.schedule.list(), []);
  await h.ctx.settings.set('schedule', '0 2 * * *');
  const [s] = await h.ctx.schedule.list();
  assert.deepEqual([s.name, s.expr, s.nextRunAt], ['scheduled-run', '0 2 * * *', NOW + 2 * H]);
  await h.advance(2 * H);
  assert.deepEqual(h.state.jobs.map((j) => [j.name, j.trigger, j.status, j.params.source]), [['run', 'cron:scheduled-run', 'done', 'cron']]);
  assert.deepEqual(h.state.backupsCreated.map((b) => b.account).sort(), ['alice', 'bob', 'carol']);
  assert.deepEqual(h.state.backupsCreated[0].include, [...BACKUP_COMPONENTS]);
  assert.equal(h.state.backupsCreated[0].encrypted, false);
  assert.equal(h.state.verifications.length, 3, 'verify is on by default');
  const [run] = await runs(h, 'run');
  assert.deepEqual([run.source, run.status, run.accounts, run.ok, run.failed, run.skipped, run.warnings], ['cron', 'ok', 3, 3, 0, 0, 0]);
  assert.equal(run.jobId, h.state.jobs[0].id);
  assert.equal(h.state.notifications.length, 0, 'notify_on = failure stays quiet on success');
  await h.ctx.settings.set('schedule', '');
  assert.deepEqual(await h.ctx.schedule.list(), []);
  await h.advance(DAY);
  assert.equal(h.state.jobs.length, 1, 'cleared schedule: no further runs');
  const help = h.state.pages.find((p) => p.source === 'runtime');
  assert.deepEqual([help.route, help.kind], ['/help', 'markdown']);
  assert.match(help.content, /last \*\*7\*\* days/);
});

// ---------------------------------------------------------------- scope

test('scope selects by packages or usernames and reports unknown names as warnings; an explicit accounts param overrides', async () => {
  const h = await loaded({ settings: { scope: 'packages', packages: 'gold\nplatinum\n' } });
  let r = await h.runJob('run', { source: 'manual' });
  assert.equal(r.status, 'done');
  assert.deepEqual(h.state.backupsCreated.map((b) => b.account), ['alice', 'carol']);
  assert.deepEqual(r.result.warnings, [{ code: 'unknown_package', package: 'platinum', message: 'package "platinum" does not exist' }]);
  await h.ctx.settings.set('scope', 'accounts');
  await h.ctx.settings.set('accounts', 'bob\r\nghost\nbob');
  r = await h.runJob('run', { source: 'manual' });
  assert.deepEqual(h.state.backupsCreated.slice(2).map((b) => b.account), ['bob']);
  assert.deepEqual(r.result.warnings.map((w) => w.code), ['unknown_account']);
  r = await h.runJob('run', { source: 'api', accounts: ['carol', 'nobody'] });
  assert.deepEqual(h.state.backupsCreated.slice(3).map((b) => b.account), ['carol']);
  assert.deepEqual(r.result.warnings.map((w) => [w.code, w.account]), [['unknown_account', 'nobody']]);
  await assert.rejects(h.ctx.settings.set('accounts', 'Not A User'), ValidationError);
  await assert.rejects(h.ctx.settings.set('packages', 'bad name'), ValidationError);
  await h.ctx.settings.set('accounts', 'alice\r\nbob\n\ncarol\n');
  await h.ctx.settings.set('packages', 'gold\nsilver');
  await h.ctx.settings.set('destinations', 'offsite\nnas\n');
  assert.deepEqual(mod.__test.lines(await h.ctx.settings.get('accounts')), ['alice', 'bob', 'carol']);
});

test('the textarea patterns are linear and bounded: a long run of valid characters followed by a typo is rejected instantly', async () => {
  const h = await loaded();
  const t0 = process.hrtime.bigint();
  for (const [key, valid] of [['packages', 'pkg-name'], ['accounts', 'abcdefgh'], ['destinations', 'dest_01']]) {
    const field = manifest.settings.fields.find((f) => f.key === key);
    assert.equal(field.maxLength, 16384, key);
    await assert.rejects(h.ctx.settings.set(key, 'a'.repeat(5000) + ' '), ValidationError, key);
    await assert.rejects(h.ctx.settings.set(key, `${valid}\n`.repeat(1500) + '!'), ValidationError, key);
    await assert.rejects(h.ctx.settings.set(key, `${valid}\n`.repeat(3000)), ValidationError, `${key} beyond maxLength`);
    await h.ctx.settings.set(key, `${valid}\n`.repeat(100));
  }
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000, 'pattern validation must be linear');
});

// ---------------------------------------------------------------- locks

test('locks: a live lock skips the account with a warning, an expired lock is taken over, locks are released after the run and the routes list/release them', async () => {
  const h = await loaded({ settings: { lock_ttl_minutes: 30 } });
  await h.ctx.store.set('lock:alice', { jobId: 'job_old', acquiredAt: NOW - 10 * 60e3, expiresAt: NOW + 10 * 60e3 });
  await h.ctx.store.set('lock:bob', { jobId: 'job_stale', acquiredAt: NOW - 3 * H, expiresAt: NOW - H });
  const locks = await h.callRoute('GET', '/locks');
  assert.deepEqual(locks.body.data.map((l) => [l.account, l.expired]), [['alice', false], ['bob', true]]);
  const r = await h.runJob('run', { source: 'manual' });
  assert.equal(r.status, 'done');
  assert.deepEqual(r.result.warnings.map((w) => [w.code, w.account]), [['locked', 'alice'], ['lock_expired', 'bob']]);
  assert.deepEqual(h.state.backupsCreated.map((b) => b.account).sort(), ['bob', 'carol']);
  assert.deepEqual([r.result.ok, r.result.skipped, r.result.status], [2, 1, 'ok']);
  assert.deepEqual(await h.ctx.store.keys('lock:'), ['lock:alice'], 'only the foreign live lock remains');
  const run = (await runs(h, 'run'))[0];
  assert.deepEqual(run.results.find((x) => x.account === 'alice').status, 'skipped');
  // release route
  assert.equal((await h.callRoute('POST', '/locks/ghost/release')).status, 404);
  assert.equal((await h.callRoute('POST', '/locks/Bad%20Name/release')).status, 400);
  const rel = await h.callRoute('POST', '/locks/alice/release');
  assert.deepEqual(rel.body.data, { released: 'alice', jobId: 'job_old', wasExpired: false });
  assert.deepEqual(await h.ctx.store.keys('lock:'), []);
  assert.equal((await h.callRoute('GET', '/locks', { user: { id: 2, username: 'r', role: 'reseller' } })).status, 403);
  // a lock is held while the account is being backed up, with the configured TTL
  let seen = null;
  const spyHost = spy({ lock_ttl_minutes: 45, scope: 'accounts', accounts: 'alice' }, (c) => ({ async create(args) { seen = await c.store.get('lock:alice'); return c.api.backups.create(args); } }));
  await spyHost.runJob('run', { source: 'manual' });
  assert.ok(seen && seen.expiresAt === NOW + 45 * 60e3 && typeof seen.jobId === 'string');
  assert.equal(await spyHost.ctx.store.get('lock:alice'), undefined);
});

test('two runs started at the same time (cron plus a manual POST /run) back up an account once: the second sees the lock', async () => {
  const h = spy({ scope: 'accounts', accounts: 'alice', max_parallel: 2 }, (c) => ({ async create(args) { await new Promise((r) => setTimeout(r, 5)); return c.api.backups.create(args); } }));
  const [a, b] = await Promise.all([h.ctx.jobs.run('run', { source: 'cron' }), h.ctx.jobs.run('run', { source: 'api' })]);
  await h.flush();
  assert.deepEqual([(await h.ctx.jobs.status(a)).status, (await h.ctx.jobs.status(b)).status], ['done', 'done']);
  assert.equal(h.state.backupsCreated.length, 1, 'the account was backed up exactly once');
  const all = await runs(h, 'run');
  assert.deepEqual(all.map((r) => r.ok + r.skipped), [1, 1]);
  assert.equal(all.filter((r) => r.warningList.some((w) => w.code === 'locked')).length, 1, 'one run reports the lock');
  assert.deepEqual(await h.ctx.store.keys('lock:'), []);
});

// ---------------------------------------------------------------- destinations

test('destinations: uploads go to every configured known destination and are recorded; unknown ids are warnings and skipped; the page lists them', async () => {
  const h = await loaded({ settings: { destinations: 'offsite\nnope\nnas', scope: 'accounts', accounts: 'alice' } });
  const page = await h.callRoute('GET', '/destinations');
  assert.deepEqual(page.body.data, [{ id: 'offsite', name: 'Offsite S3', kind: 's3', selected: true }, { id: 'nas', name: 'Office NAS', kind: 'sftp', selected: true }]);
  const r = await h.runJob('run', { source: 'manual' });
  assert.equal(r.status, 'done');
  assert.deepEqual(r.result.warnings, [{ code: 'unknown_destination', destinationId: 'nope', message: 'destination "nope" is not configured; skipped' }]);
  const bk = h.state.backupsCreated[0].id;
  assert.deepEqual(h.state.uploads.map((u) => [u.artefactId, u.destinationId]), [[bk, 'offsite'], [bk, 'nas']]);
  const [a] = await artefacts(h);
  assert.deepEqual(a.remote.map((x) => [x.destinationId, x.state, x.sha256 === a.sha256]), [['offsite', 'uploaded', true], ['nas', 'uploaded', true]]);
  assert.match(a.remote[0].remotePath, /^s3:\/\/Offsite S3\/alice\//);
  const [run] = await runs(h, 'run');
  assert.deepEqual(run.destinations, ['offsite', 'nas']);
  assert.deepEqual(run.results[0].remote.map((x) => x.destinationId), ['offsite', 'nas']);
  // an upload failure is a warning on an otherwise successful account
  const failing = spy({ destinations: 'nas', scope: 'accounts', accounts: 'alice' }, () => ({ async upload() { throw new Error('connection refused'); } }));
  const r2 = await failing.runJob('run', { source: 'manual' });
  assert.deepEqual([r2.result.status, r2.result.ok], ['ok', 1]);
  assert.deepEqual(r2.result.warnings.map((w) => w.code), ['upload_failed']);
});

// ---------------------------------------------------------------- retention

test('retention keeps the newest archive per day/week/month bucket and deletes only local artefacts (mock backupsDeleted); remote copies are recorded as retained', async () => {
  const { retentionPlan, isoWeekKey } = mod.__test;
  assert.equal(isoWeekKey(Date.UTC(2026, 0, 1)), '2026-W01');
  assert.equal(isoWeekKey(Date.UTC(2025, 11, 29)), '2026-W01');
  assert.equal(isoWeekKey(Date.UTC(2025, 11, 28)), '2025-W52');
  // 40 daily archives, two per day on some days; keep 3 daily, 2 weekly, 1 monthly
  const items = [];
  for (let d = 0; d < 40; d++) {
    items.push({ artefactId: `a${d}`, createdAt: NOW - d * DAY + 2 * H });
    if (d % 7 === 0) items.push({ artefactId: `b${d}`, createdAt: NOW - d * DAY + 1 * H });
  }
  const plan = retentionPlan(items, { daily: 3, weekly: 2, monthly: 1 });
  // daily: 2026-01-01 (a0), 12-31 (a1), 12-30 (a2); weekly: W01 → a0, W52 (ends Sun 12-28) → a4; monthly: 2026-01 → a0
  assert.deepEqual([...plan.keep].sort(), ['a0', 'a1', 'a2', 'a4']);
  assert.equal(isoWeekKey(Date.UTC(2025, 11, 28) + 2 * H), '2025-W52');
  assert.ok(!plan.keep.has('b0'), 'the older archive of a day is not the bucket representative');
  assert.deepEqual(retentionPlan(items, { daily: 0, weekly: 0, monthly: 0 }).keep.size, 0);
  assert.equal(retentionPlan([], { daily: 1 }).drop.length, 0);

  const h = await loaded({ settings: { retention_daily: 2, retention_weekly: 1, retention_monthly: 1, destinations: 'offsite', scope: 'accounts', accounts: 'alice' } });
  // host-initiated archive: in the history, never pruned
  await h.fire('backup.completed', { jobId: 'hostjob_1', account: 'alice', artefact: { id: 'host_1', path: '/var/lib/whm/backups/alice/host_1.tar.gz', size: 5, sha256: 'h1', createdAt: NOW - 10 * DAY } });
  for (let i = 0; i < 5; i++) { await h.runJob('run', { source: 'manual' }); await h.advance(DAY); }
  // runs on Jan 1..5: daily keeps Jan 5 + Jan 4, weekly keeps Jan 5 (W02), monthly keeps Jan 5 → bk 1..3 pruned
  const docs = await artefacts(h, { createdBy: 'plugin' });
  assert.deepEqual(docs.map((d) => d.local), ['deleted', 'deleted', 'deleted', 'present', 'present']);
  const ids = h.state.backupsCreated.map((b) => b.id);
  assert.deepEqual(h.state.backupsDeleted.map((b) => b.id), ids.slice(0, 3));
  assert.deepEqual(h.state.backups.map((b) => b.id), ids.slice(3));
  assert.equal(h.state.uploads.length, 5, 'no remote copy is ever removed: the API has no such call');
  assert.deepEqual(docs[0].remote, [{ destinationId: 'offsite', remotePath: `s3://Offsite S3/alice/${ids[0]}.tar.gz`, sha256: docs[0].sha256, state: 'retained' }]);
  const hostDoc = (await artefacts(h, { createdBy: 'host' }))[0];
  assert.deepEqual([hostDoc.artefactId, hostDoc.local], ['host_1', 'present']);
  const lastRun = (await runs(h, 'run')).pop();
  assert.deepEqual(lastRun.prune, { deleted: 1, errors: 0, retained_remote: 1 });
  // the prune job alone
  await h.ctx.settings.set('retention_daily', 1);
  await h.ctx.settings.set('retention_weekly', 0);
  await h.ctx.settings.set('retention_monthly', 0);
  const pr = await h.runJob('prune', { source: 'manual' });
  assert.deepEqual(pr.result.deleted.map((d) => [d.artefactId, d.remote, d.destinations]), [[ids[3], 'retained', ['offsite']]]);
  assert.deepEqual(h.state.backups.map((b) => b.id), [ids[4]]);
  const pruneRun = (await runs(h, 'prune'))[0];
  assert.deepEqual([pruneRun.status, pruneRun.ok, pruneRun.results[0].remote], ['ok', 1, 'retained']);
  // an artefact already gone from the host is treated as deleted, not an error
  h.state.backups = [];
  await h.ctx.settings.set('retention_daily', 0);
  const pr2 = await h.runJob('prune', { source: 'manual' });
  assert.deepEqual([pr2.result.deleted.length, pr2.result.errors.length], [1, 0]);
});

// ---------------------------------------------------------------- encrypt

test('encrypt:true: the host answers UNSUPPORTED, the archive is written unencrypted and the run carries the warning', async () => {
  const h = await loaded({ settings: { encrypt: true, scope: 'accounts', accounts: 'alice' } });
  const r = await h.runJob('run', { source: 'manual' });
  assert.equal(r.status, 'done');
  assert.deepEqual([r.result.ok, r.result.status], [1, 'ok']);
  assert.deepEqual(r.result.warnings.map((w) => [w.code, w.account]), [['encrypt_unsupported', 'alice']]);
  assert.match(r.result.warnings[0].message, /unencrypted/);
  assert.deepEqual(h.state.backupsCreated.map((b) => b.encrypted), [false]);
  const [run] = await runs(h, 'run');
  assert.equal(run.warnings, 1);
  assert.equal(run.warningList[0].code, 'encrypt_unsupported');
});

// ---------------------------------------------------------------- failures + notifications

test('a failing account makes the run partial, notifies on failure (critical) and the success/both/never modes behave', async () => {
  const h = spy({ scope: 'accounts', accounts: 'alice\nbob' }, (c) => ({ async create(args) { if (args.account === 'bob') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return c.api.backups.create(args); } }));
  const r = await h.runJob('run', { source: 'manual' });
  assert.equal(r.status, 'done', 'one failed account does not fail the job');
  assert.deepEqual([r.result.status, r.result.ok, r.result.failed], ['partial', 1, 1]);
  assert.equal(h.state.notifications.length, 1);
  assert.deepEqual([h.state.notifications[0].event, h.state.notifications[0].severity], ['net.whm.automated-backup.run_failed', 'critical']);
  assert.match(h.state.notifications[0].body, /bob \(disk full\)/);
  const [run] = await runs(h, 'run');
  assert.deepEqual(run.results.find((x) => x.account === 'bob').error, { code: 'ENOSPC', message: 'disk full' });
  assert.deepEqual(await h.ctx.store.keys('lock:'), [], 'the lock of the failed account is released');
  assert.ok(h.state.logs.some((l) => l.level === 'error' && l.msg === 'account backup failed'));
  // verify failure
  const v = spy({ scope: 'accounts', accounts: 'alice' }, (c) => ({ async verify(id) { const x = await c.api.backups.verify(id); return { ...x, sha256: 'different' }; } }));
  const vr = await v.runJob('run', { source: 'manual' });
  assert.deepEqual([vr.result.status, vr.result.failed], ['failed', 1]);
  assert.equal((await runs(v, 'run'))[0].results[0].error.code, 'VERIFY_FAILED');
  // notify modes on success
  for (const [mode, expected] of [['never', 0], ['failure', 0], ['success', 1], ['both', 1]]) {
    const s = await loaded({ settings: { notify_on: mode, scope: 'accounts', accounts: 'alice' } });
    await s.runJob('run', { source: 'manual' });
    assert.equal(s.state.notifications.length, expected, mode);
    if (expected) assert.equal(s.state.notifications[0].event, 'net.whm.automated-backup.run_ok');
  }
  const n = spy({ notify_on: 'success', scope: 'accounts', accounts: 'alice' }, () => ({ async create() { throw new Error('nope'); } }));
  await n.runJob('run', { source: 'manual' });
  assert.equal(n.state.notifications.length, 0, 'notify_on = success stays quiet on failure');
});

// ---------------------------------------------------------------- cancellation + parallelism

test('cancelling a run stops before the next account and max_parallel bounds concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  let firstStarted;
  const started = new Promise((r) => { firstStarted = r; });
  const slowCreate = (c) => ({ async create(args) { inFlight++; peak = Math.max(peak, inFlight); firstStarted(); await new Promise((r) => setTimeout(r, 5)); inFlight--; return c.api.backups.create(args); } });
  const h = spy({ max_parallel: 1 }, slowCreate);
  const id = await h.ctx.jobs.run('run', { source: 'manual' });
  await started;
  assert.equal(await h.ctx.jobs.cancel(id), true);
  await h.flush();
  assert.equal((await h.ctx.jobs.status(id)).status, 'cancelled');
  assert.ok(h.state.backupsCreated.length < 3, 'remaining accounts were not backed up');
  assert.deepEqual(await h.ctx.store.keys('lock:'), []);
  const [run] = await runs(h, 'run');
  assert.equal(run.status, 'cancelled');
  assert.ok(run.results.some((x) => x.status === 'skipped' && x.error.code === 'JOB_CANCELLED'));
  assert.equal(peak, 1);
  const p = spy({ max_parallel: 3 }, slowCreate);
  inFlight = 0; peak = 0;
  await p.runJob('run', { source: 'manual' });
  assert.equal(peak, 3);
  await assert.rejects(h.ctx.jobs.cancel(await h.ctx.jobs.run('restore', { artefactId: 'x', account: 'alice', confirmRef: 'nope' })), ConflictError);
  await h.flush();
});

// ---------------------------------------------------------------- restore

test('restore: the route parks the token in memory and the job redeems the reference once; bad, used, wrong-account and expired tokens are refused (PERMISSION_DENIED) and recorded; nothing persists the token', async () => {
  const { holdToken, redeemToken, heldTokens, CONFIRM_HOLD_MS } = mod.__test;
  const h = await loaded({ settings: { scope: 'accounts', accounts: 'alice' } });
  await h.runJob('run', { source: 'manual' });
  const artefactId = h.state.backupsCreated[0].id;
  const restore = (body, user) => h.callRoute('POST', '/restore', { body, user });
  const bad = await restore({ artefactId, account: 'alice', confirmToken: 'ffffffffffffffff' });
  assert.equal(bad.status, 202);
  await h.flush();
  const badJob = await h.ctx.jobs.status(bad.body.data.job.id);
  assert.deepEqual([badJob.status, badJob.error.code], ['failed', 'PERMISSION_DENIED']);
  assert.equal(h.state.restores.length, 0);
  assert.equal(h.state.notifications.length, 1);
  assert.match(h.state.notifications[0].subject, /refused/);
  const token = h.issueRestoreToken(artefactId, 'alice', { issuedBy: 'root' });
  const route = await restore({ artefactId, account: 'alice', confirmToken: token });
  assert.equal(route.status, 202);
  await h.flush();
  const ok = await h.ctx.jobs.status(route.body.data.job.id);
  assert.equal(ok.status, 'done', JSON.stringify(ok.error));
  assert.deepEqual(h.state.restores.map((r) => [r.artefactId, r.account, r.confirmedBy]), [[artefactId, 'alice', 'root']]);
  assert.equal(ok.result.hostJobId, h.state.restores[0].jobId);
  // the token itself is never in a job record, the run history or the store
  for (const j of h.state.jobs) assert.ok(!JSON.stringify(j).includes(token), 'job record leaks the token');
  assert.match(ok.params.confirmRef, /^[a-f0-9]{32}$/);
  assert.equal(ok.params.confirmToken, undefined);
  assert.ok(!JSON.stringify(h.state.store).includes(token), 'store leaks the token');
  assert.equal(heldTokens.size, 0, 'redeemed references are dropped');
  // a used token (same token, new reference) and a reused reference are both refused
  const used = await restore({ artefactId, account: 'alice', confirmToken: token });
  await h.flush();
  assert.equal((await h.ctx.jobs.status(used.body.data.job.id)).error.code, 'PERMISSION_DENIED');
  const replay = await h.runJob('restore', { artefactId, account: 'alice', confirmRef: ok.params.confirmRef });
  assert.deepEqual([replay.status, replay.error.code], ['failed', 'PERMISSION_DENIED']);
  assert.match(replay.error.message, /unknown, already redeemed or expired/);
  assert.equal((await h.runJob('restore', { artefactId, account: 'alice' })).error.code, 'PERMISSION_DENIED', 'no reference at all');
  const wrongAccount = h.issueRestoreToken(artefactId, 'bob');
  assert.equal((await h.runJob('restore', { artefactId, account: 'alice', confirmRef: holdToken(wrongAccount, h.ctx.now()) })).status, 'failed');
  const expired = h.issueRestoreToken(artefactId, 'alice', { ttlMs: 1000 });
  const expiredRef = holdToken(expired, h.ctx.now());
  await h.advance(2000);
  assert.equal((await h.runJob('restore', { artefactId, account: 'alice', confirmRef: expiredRef })).status, 'failed');
  // a held reference outlives nothing: it expires with the token's own lifetime and is swept
  const stale = holdToken('stale-token', 0);
  assert.equal(redeemToken(stale, CONFIRM_HOLD_MS), null);
  assert.equal(redeemToken(holdToken('fresh', 0), CONFIRM_HOLD_MS - 1), 'fresh');
  holdToken('sweep', CONFIRM_HOLD_MS * 2);
  assert.ok(![...heldTokens.values()].some((v) => v.token === 'stale-token'), 'expired holds are swept on the next hold');
  heldTokens.clear();
  const history = await runs(h, 'restore');
  assert.deepEqual(history.map((r) => r.status), ['failed', 'ok', 'failed', 'failed', 'failed', 'failed', 'failed']);
  assert.equal(history[0].results[0].error.code, 'PERMISSION_DENIED');
  assert.ok(!JSON.stringify(history).includes(token));
  const invalid = await restore({ artefactId: 'x y', account: 'Bad', confirmToken: 'short' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body.error.details.fields.map((f) => f.path), ['artefactId', 'account', 'confirmToken']);
  assert.equal((await restore({ artefactId, account: 'alice', confirmToken: token }, { id: 2, username: 'r', role: 'reseller' })).status, 403);
});

test('every declared permission is exercised across a package-scoped run, a notification, the API routes and a restore', async () => {
  const h = await loaded({ settings: { scope: 'packages', packages: 'gold', notify_on: 'both', destinations: 'offsite' } });
  const run = await h.callRoute('POST', '/run', {});
  assert.equal(run.status, 202);
  await h.flush();
  assert.equal((await h.ctx.jobs.status(run.body.data.job.id)).status, 'done');
  assert.equal((await h.callRoute('POST', '/run', { body: { accounts: ['x y'] } })).status, 400);
  assert.equal((await h.callRoute('POST', '/prune', {})).status, 202);
  await h.ctx.settings.set('schedule', '0 3 * * *');
  const status = await h.callRoute('GET', '/status');
  assert.deepEqual([status.body.data.scheduled, status.body.data.nextRunAt, status.body.data.lastRun.status, status.body.data.archives, status.body.data.destinations], [true, new Date(NOW + 3 * H).toISOString(), 'ok', 2, ['offsite']]);
  const artefactId = h.state.backupsCreated[0].id;
  const token = h.issueRestoreToken(artefactId, 'alice');
  assert.equal((await h.callRoute('POST', '/restore', { body: { artefactId, account: 'alice', confirmToken: token } })).status, 202);
  await h.flush();
  assert.deepEqual(h.unusedPermissions(), []);
  assert.deepEqual(h.deniedPermissions(), []);
});

// ---------------------------------------------------------------- hooks

test('host-initiated backups appear in the history once, failures too, and a terminated account loses its locks and history', async () => {
  const h = await loaded({ settings: { scope: 'accounts', accounts: 'alice' } });
  await h.runJob('run', { source: 'manual' });
  const own = h.state.backupsCreated[0];
  // the plugin's own archive is not recorded twice when the host fires the event for it
  await h.fire('backup.completed', { jobId: 'hostjob_9', account: 'alice', artefact: { id: own.id, path: own.path, size: own.size, sha256: own.sha256, createdAt: own.createdAt } });
  assert.equal((await artefacts(h)).length, 1);
  await h.fire('backup.completed', { jobId: 'hostjob_2', account: 'bob', artefact: { id: 'host_2', path: '/var/lib/whm/backups/bob/host_2.tar.gz', size: 9, sha256: 'h2', createdAt: NOW } }, { principal: 'root' });
  await h.fire('backup.completed', { jobId: 'hostjob_2', account: 'bob', artefact: { id: 'host_2', path: '/x', size: 9, sha256: 'h2', createdAt: NOW } });
  await h.fire('backup.failed', { jobId: 'hostjob_3', account: 'carol', error: { code: 'ENOSPC', message: 'disk full' } });
  const all = await runs(h);
  assert.deepEqual(all.map((r) => [r.kind, r.status, r.results[0].account]), [['run', 'ok', 'alice'], ['host', 'ok', 'bob'], ['host', 'failed', 'carol']]);
  assert.deepEqual([all[1].source, all[1].hostJobId, all[2].results[0].error.code], ['root', 'hostjob_2', 'ENOSPC']);
  assert.deepEqual((await artefacts(h, { createdBy: 'host' })).map((a) => [a.artefactId, a.account]), [['host_2', 'bob']]);
  const page = await h.callRoute('GET', '/runs', { query: { kind: 'host', limit: '10' } });
  assert.equal(page.body.data.length, 2);
  assert.equal(page.body.data[0].startedAt, new Date(NOW).toISOString());
  // termination
  await h.ctx.store.set('lock:bob', { jobId: 'j', acquiredAt: NOW, expiresAt: NOW + H });
  assert.deepEqual(all.filter((r) => r.kind === 'host').map((r) => r.account), ['bob', 'carol'], 'host runs carry the account at the top level');
  await h.fire('account.terminated', { username: 'bob', domain: 'bob.test', keepDns: false });
  assert.deepEqual(await h.ctx.store.keys('lock:'), []);
  assert.deepEqual((await artefacts(h)).map((a) => a.account), ['alice']);
  assert.deepEqual((await runs(h)).map((r) => [r.kind, r.account || r.results[0].account]), [['run', 'alice'], ['host', 'carol']], 'the host-initiated run rows of the terminated account are dropped');
  assert.ok(h.state.logs.some((l) => l.msg === 'history of a terminated account dropped' && l.fields.runs === 1));
  assert.deepEqual((await h.callRoute('GET', '/artefacts', { query: { account: 'alice' } })).body.data.map((a) => a.artefactId), [own.id]);
  assert.throws(() => { throw new PermissionError('x', 'y'); }, PermissionError);
});
