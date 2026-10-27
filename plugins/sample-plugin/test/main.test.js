'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMockHost, validateManifest, PermissionError, ValidationError, ConflictError, PAGE_KINDS, SETTING_TYPES } = require('../../sdk');
const manifest = require('../plugin.json');
const mod = require('../main');

const NOW = Date.UTC(2026, 0, 1); // Thursday 2026-01-01T00:00:00Z
const H = 3600e3;
const locales = { en: require('../locales/en.json'), de: require('../locales/de.json') };
const accounts = [
  { username: 'alice', domain: 'alice.test', owner: 'root' },
  { username: 'bob', domain: 'bob.test', owner: 'resell1' },
  { username: 'carol', domain: 'carol.test', owner: 'resell1' },
];
const reseller = { id: 2, username: 'resell1', role: 'reseller' };
const plainUser = { id: 3, username: 'alice', role: 'user' };

function host(opts = {}) {
  return createMockHost({ manifest, accounts, locales, now: NOW, ...opts });
}
async function loaded(opts) {
  const h = host(opts);
  const r = await h.load(mod);
  assert.deepEqual(r, { ok: true }, JSON.stringify(h.state.lastError));
  return h;
}
const post = (h, p, body, user) => h.callRoute('POST', p, { body, user });

// ---------------------------------------------------------------- manifest

test('manifest is valid and declares one of every extension point', () => {
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  assert.equal(manifest.id, 'net.whm.sample-notes');
  assert.deepEqual([...new Set(manifest.settings.fields.map((f) => f.type))].sort(), [...SETTING_TYPES].sort(), 'every settings field type');
  assert.deepEqual(manifest.ui.pages.map((p) => p.kind).sort(), [...PAGE_KINDS].sort(), 'every page kind');
  assert.deepEqual(manifest.hooks.map((h) => `${h.stage}:${h.event}`), ['pre:account.created', 'post:account.created', 'post:account.terminated']);
  assert.equal(manifest.jobs.digest.cancellable, true);
  assert.equal(manifest.jobs.housekeeping.cancellable, false);
  assert.deepEqual(manifest.cron.map((c) => c.schedule), ['setting:digestSchedule', '30 3 * * *']);
  assert.ok(manifest.permissions.includes('net:outbound:hooks.example.net'));
  assert.deepEqual(manifest.i18n, { default: 'en', dir: 'locales' });
  for (const f of ['pages/about.md', 'pages/widget.html', 'locales/en.json', 'locales/de.json', 'README.md']) assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f);
});

// ---------------------------------------------------------------- lifecycle

test('load activates: runtime page, exports dir, installedAt, both schedules; deactivate stops everything', async () => {
  const h = await loaded();
  assert.equal(h.state.lifecycle, 'running');
  assert.equal((await h.ctx.store.get('installedAt')), NOW);
  await h.ctx.fs.writeFile('exports/.keep', '');
  assert.equal(await h.ctx.fs.exists('exports'), true);
  const runtimePage = h.state.pages.find((p) => p.route === '/schedules');
  assert.deepEqual([runtimePage.kind, runtimePage.source], ['markdown', 'runtime']);
  assert.match(runtimePage.content, /daily-digest.*0 8 \* \* \*/);
  assert.equal(h.state.pages.length, 7);
  const sched = await h.ctx.schedule.list();
  assert.deepEqual(sched.map((s) => [s.name, s.expr, s.source]), [['daily-digest', '0 8 * * *', 'manifest'], ['nightly-housekeeping', '30 3 * * *', 'manifest']]);
  assert.equal(sched[0].nextRunAt, NOW + 8 * H);
  assert.equal(sched[1].nextRunAt, NOW + 3.5 * H);
  assert.ok(h.state.logs.some((l) => l.msg === 'activated' && l.fields.version === '1.1.0'));
  await h.unload();
  assert.equal(h.state.lifecycle, 'stopped');
  assert.equal(h.state.cron.length, 0);
  assert.ok(h.state.logs.some((l) => l.msg === 'deactivated'));
});

test('migrate(from) backfills tags/category on 1.0.x notes and records the source version', async () => {
  const h = host();
  const notes = h.ctx.store.collection('notes');
  await notes.insert({ id: 'legacy1', title: 'old', body: '' });
  await notes.insert({ id: 'legacy2', title: 'old2', category: 'nope' });
  await notes.insert({ id: 'fresh', title: 'new', category: 'ops', tags: ['x'] });
  assert.deepEqual(await h.load(mod, { fromVersion: '1.0.2' }), { ok: true });
  assert.deepEqual(h.state.migrations, [{ from: '1.0.2', to: '1.1.0', ts: NOW }]);
  assert.deepEqual(await notes.findOne({ id: 'legacy1' }).then((d) => [d.tags, d.category]), [[], 'misc']);
  assert.deepEqual(await notes.findOne({ id: 'legacy2' }).then((d) => [d.tags, d.category]), [[], 'misc']);
  assert.deepEqual(await notes.findOne({ id: 'fresh' }).then((d) => [d.tags, d.category]), [['x'], 'ops']);
  assert.equal(await h.ctx.store.get('migratedFrom'), '1.0.2');
  assert.ok(h.state.logs.some((l) => l.msg === 'migrated' && l.fields.patched === 2));
});

// ---------------------------------------------------------------- settings

test('settings: defaults of every type, validation, password re-encryption and setting-bound cron rebinding', async () => {
  const h = await loaded();
  const all = await h.ctx.settings.getAll();
  assert.deepEqual(all, { title: 'Server notes', maxNotes: 500, sortOrder: 'newest', categories: ['ops', 'billing'], digestEnabled: true, digestSchedule: '0 8 * * *', blockedUsernames: '' });
  await assert.rejects(h.ctx.settings.set('maxNotes', 0), (e) => e instanceof ValidationError);
  await assert.rejects(h.ctx.settings.set('sortOrder', 'sideways'), ValidationError);
  await assert.rejects(h.ctx.settings.set('categories', ['ops', 'ops']), ValidationError);
  await assert.rejects(h.ctx.settings.set('blockedUsernames', 'Not Valid!'), ValidationError);
  await assert.rejects(h.ctx.settings.set('digestSchedule', '99 * * * *'), ValidationError);
  // the password setting is mirrored into the store encrypted with ctx.crypto
  assert.equal(await h.ctx.store.get('webhook:token'), undefined);
  await h.ctx.settings.set('webhookToken', 's3cret');
  const stored = await h.ctx.store.get('webhook:token');
  assert.match(stored, /^whm1:/);
  assert.equal(await h.ctx.crypto.decrypt(stored), 's3cret');
  await h.ctx.settings.set('webhookToken', '');
  assert.equal(await h.ctx.store.get('webhook:token'), undefined);
  assert.ok(h.state.logs.some((l) => l.msg === 'setting changed' && l.fields.setting === 'webhookToken'));
  // clearing the cron setting unschedules the digest; a new expression re-binds it
  await h.ctx.settings.set('digestSchedule', '');
  assert.deepEqual((await h.ctx.schedule.list()).map((s) => s.name), ['nightly-housekeeping']);
  await h.ctx.settings.set('digestSchedule', '0 20 * * *');
  const digest = (await h.ctx.schedule.list()).find((s) => s.name === 'daily-digest');
  assert.equal(digest.expr, '0 20 * * *');
  assert.equal(digest.nextRunAt, NOW + 20 * H);
});

// ---------------------------------------------------------------- hooks

test('hooks: the pre hook cancels blocked usernames (audited), the post hook writes a welcome note, termination removes an account\'s notes', async () => {
  const h = await loaded({ settings: { blockedUsernames: 'spammer\nevil' } });
  const pre = await h.fire('account.created', { username: 'spammer', domain: 'spam.test' }, { stage: 'pre', principal: 'root' });
  assert.equal(pre.cancelled, true);
  assert.equal(pre.reason, 'Username "spammer" is on the blocked list of Sample Notes.');
  assert.deepEqual(h.state.audit.map((a) => [a.action, a.target]), [['plugin:net.whm.sample-notes:account.blocked', 'spammer']]);
  const ok = await h.fire('account.created', { username: 'alice', domain: 'alice.test' }, { stage: 'pre' });
  assert.deepEqual([ok.cancelled, ok.delivered, ok.errors], [false, 1, []]);
  const postR = await h.fire('account.created', { username: 'alice', domain: 'alice.test' }, { stage: 'post', principal: 'root' });
  assert.deepEqual([postR.delivered, postR.errors], [1, []]);
  const notes = await h.ctx.store.collection('notes').find({});
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].title, notes[0].body, notes[0].account, notes[0].tags], ['Welcome, alice', 'Account alice (alice.test) was created on 2026-01-01.', 'alice', ['welcome']]);
  assert.deepEqual(h.state.emitted.map((e) => e.event), ['net.whm.sample-notes.note_created']);
  await h.fire('account.terminated', { username: 'alice', domain: 'alice.test', keepDns: false });
  assert.equal(await h.ctx.store.collection('notes').count({}), 0);
  // a post hook for an unknown account logs instead of propagating
  const bad = await h.fire('account.created', { username: 'ghost' }, { stage: 'post' });
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].code, 'NOT_FOUND');
});

test('i18n: the German locale drives hook and digest copy, unknown keys fall back to en then the key', async () => {
  const h = await loaded({ locale: 'de' });
  await h.fire('account.created', { username: 'bob', domain: 'bob.test' }, { stage: 'post' });
  const [note] = await h.ctx.store.collection('notes').find({});
  assert.equal(note.title, 'Willkommen, bob');
  assert.equal(h.ctx.i18n.t('nope.key'), 'nope.key');
  assert.equal(h.ctx.i18n.t('digest.subject', { title: 'T', count: 2 }, 'en'), 'T: 2 notes in the last 24 hours');
  const r = await h.runJob('digest', { source: 'manual' });
  assert.equal(r.status, 'done');
  assert.equal(h.state.notifications[0].subject, 'Server notes: 1 Notizen in den letzten 24 Stunden');
});

// ---------------------------------------------------------------- jobs

test('digest job: export file, notification, event, webhook with the stored token (scoped fetch), progress; disabled digest skips cron runs only', async () => {
  const requests = [];
  const h = await loaded({ settings: { webhookToken: 'tok-1', categories: ['ops'] }, fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, status: 202 }; } });
  await post(h, '/notes', { title: 'ops note', category: 'ops' });
  await post(h, '/notes', { title: 'billing note', category: 'billing' });
  await h.advance(2 * H);
  const r = await h.runJob('digest', { source: 'manual' });
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.deepEqual(r.result, { count: 1, file: 'exports/latest-digest.json', webhook: { ok: true, status: 202 } });
  assert.deepEqual(r.log.map((l) => l.pct), [10, 40, 60, 80, 100]);
  const exported = JSON.parse(await h.ctx.fs.readFile('exports/latest-digest.json'));
  assert.deepEqual(exported.notes.map((n) => n.title), ['ops note']);
  assert.equal(h.state.notifications.length, 1);
  assert.deepEqual(h.state.notifications[0], { event: 'net.whm.sample-notes.digest', subject: 'Server notes: 1 notes in the last 24 hours', body: `1 note(s) were added to "Server notes" since ${new Date(NOW - 22 * H).toISOString()}.`, severity: 'info', ts: NOW + 2 * H });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://hooks.example.net/whm-notes');
  assert.equal(requests[0].init.headers.authorization, 'Bearer tok-1');
  assert.equal(JSON.parse(requests[0].init.body).count, 1);
  assert.deepEqual(h.state.requests.map((q) => [q.method, q.url]), [['POST', 'https://hooks.example.net/whm-notes']]);
  assert.ok(h.state.emitted.some((e) => e.event === 'net.whm.sample-notes.digest_sent' && e.payload.webhook === true));
  assert.deepEqual(await h.ctx.store.get('digest:last'), { at: NOW + 2 * H, count: 1, webhook: { ok: true, status: 202 } });
  // a failing webhook is a warning, not a failed job
  h.revoke('net:outbound:hooks.example.net');
  const r2 = await h.runJob('digest', { source: 'manual' });
  assert.equal(r2.status, 'done');
  assert.equal(r2.result.webhook.ok, false);
  assert.ok(h.state.logs.some((l) => l.msg === 'webhook failed'));
  assert.deepEqual(h.deniedPermissions(), ['net:outbound:hooks.example.net']);
  h.grant('net:outbound:hooks.example.net');
  await h.ctx.settings.set('digestEnabled', false);
  assert.deepEqual((await h.runJob('digest', { source: 'cron' })).result, { skipped: true, reason: 'disabled' });
  assert.equal((await h.runJob('digest', { source: 'manual' })).status, 'done', 'manual runs ignore the toggle');
});

test('jobs: digest is cancellable (status cancelled, abort honoured), housekeeping is not and prunes beyond maxNotes', async () => {
  const h = await loaded({ settings: { maxNotes: 3 } });
  let release;
  const gate = new Promise((r) => { release = r; });
  h.registerJob('digest', async (job) => { await gate; return job.signal.aborted ? 'aborted' : 'ran'; });
  const id = await h.ctx.jobs.run('digest', { source: 'manual' });
  assert.equal(await h.ctx.jobs.cancel(id), true);
  release();
  await h.flush();
  assert.equal((await h.ctx.jobs.status(id)).status, 'cancelled');
  for (let i = 0; i < 5; i++) { await post(h, '/notes', { title: `n${i}` }); await h.advance(1000); }
  const hk = await h.ctx.jobs.run('housekeeping');
  await assert.rejects(h.ctx.jobs.cancel(hk), ConflictError);
  await h.flush();
  const st = await h.ctx.jobs.status(hk);
  assert.equal(st.status, 'done');
  assert.deepEqual(st.result, { removed: 2, kept: 3 });
  assert.deepEqual((await h.ctx.store.collection('notes').find({}, { sort: { createdAt: 1 } })).map((n) => n.title), ['n2', 'n3', 'n4']);
  assert.ok(h.state.logs.some((l) => l.msg === 'Removed 2 note(s); 3 remain.'));
});

// ---------------------------------------------------------------- cron

test('cron: the setting-bound digest fires at 08:00 UTC and the fixed housekeeping at 03:30', async () => {
  const h = await loaded();
  await h.advance(3 * H);
  assert.deepEqual(h.state.jobs.map((j) => j.trigger), []);
  await h.advance(1 * H);
  assert.deepEqual(h.state.jobs.map((j) => [j.name, j.trigger, j.status]), [['housekeeping', 'cron:nightly-housekeeping', 'done']]);
  await h.advance(4 * H + 1);
  assert.deepEqual(h.state.jobs.map((j) => [j.name, j.trigger, j.params.source]), [['housekeeping', 'cron:nightly-housekeeping', 'cron'], ['digest', 'cron:daily-digest', 'cron']]);
  assert.equal(h.state.jobs[1].startedAt, NOW + 8 * H);
  await h.advance(24 * H);
  assert.equal(h.state.jobs.length, 4);
});

// ---------------------------------------------------------------- routes

test('routes: roles per route, validation, reseller scoping, 404s, export and the digest trigger', async () => {
  const h = await loaded();
  assert.deepEqual(h.state.routes.map((r) => `${r.method} ${r.path} ${r.roles.join(',')}`), [
    'GET /notes root,reseller', 'POST /notes root,reseller', 'GET /notes/:id root,reseller', 'DELETE /notes/:id root', 'GET /status root', 'GET /schedules root,reseller', 'GET /export root', 'POST /digest root',
  ]);
  assert.equal((await h.callRoute('GET', '/notes', { user: plainUser })).status, 403);
  const bad = await post(h, '/notes', { title: '', category: 'nope' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.details.fields.map((f) => f.path), ['title', 'category']);
  assert.equal((await post(h, '/notes', 'text')).status, 400);
  const created = await post(h, '/notes', { title: 'root note', body: 'hello', category: 'security', account: 'alice', tags: ['a'] });
  assert.equal(created.status, 201);
  assert.deepEqual([created.body.data.title, created.body.data.account, created.body.data.createdBy], ['root note', 'alice', 'root']);
  assert.equal((await post(h, '/notes', { title: 'x', account: 'nobody' })).status, 404);
  // a reseller may only attach notes to its own accounts and only sees those
  assert.equal((await post(h, '/notes', { title: 'not mine', account: 'alice' }, reseller)).status, 409);
  await h.advance(1000);
  assert.equal((await post(h, '/notes', { title: 'bob note', account: 'bob' }, reseller)).status, 201);
  await h.advance(1000);
  await post(h, '/notes', { title: 'unattached' });
  const rootList = await h.callRoute('GET', '/notes');
  assert.deepEqual(rootList.body.data.map((n) => n.title), ['unattached', 'bob note', 'root note']);
  await h.ctx.settings.set('sortOrder', 'oldest');
  assert.deepEqual((await h.callRoute('GET', '/notes')).body.data.map((n) => n.title), ['root note', 'bob note', 'unattached']);
  assert.deepEqual((await h.callRoute('GET', '/notes', { query: { category: 'security' } })).body.data.map((n) => n.title), ['root note']);
  const resellerList = await h.callRoute('GET', '/notes', { user: reseller });
  assert.deepEqual(resellerList.body.data.map((n) => n.title), ['bob note']);
  const one = await h.callRoute('GET', `/notes/${created.body.data.id}`, { user: reseller });
  assert.equal(one.status, 200);
  assert.equal((await h.callRoute('GET', '/notes/doc_9999')).status, 404);
  assert.equal((await h.callRoute('DELETE', `/notes/${created.body.data.id}`, { user: reseller })).status, 403);
  assert.equal((await h.callRoute('DELETE', `/notes/${created.body.data.id}`)).status, 204);
  assert.equal((await h.callRoute('DELETE', `/notes/${created.body.data.id}`)).status, 404);
  assert.equal((await h.callRoute('GET', '/export')).status, 404);
  const trig = await post(h, '/digest', {});
  assert.equal(trig.status, 202);
  assert.match(trig.body.data.job.id, /^job_/);
  await h.flush();
  const exp = await h.callRoute('GET', '/export');
  assert.equal(exp.status, 200);
  assert.equal(exp.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(exp.body).count, 2);
  const status = await h.callRoute('GET', '/status');
  assert.deepEqual([status.body.data.notes, status.body.data.lastDigest.count, status.body.data.exportPresent, status.body.data.schedules.length, status.body.data.webhookConfigured], [2, 2, true, 2, false]);
  const sched = await h.callRoute('GET', '/schedules', { user: reseller });
  assert.deepEqual(sched.body.data.map((s) => s.name), ['daily-digest', 'nightly-housekeeping']);
});

// ---------------------------------------------------------------- permissions

test('every declared permission is exercised and nothing undeclared is needed', async () => {
  const h = await loaded({ settings: { webhookToken: 't', blockedUsernames: 'evil' } });
  await h.fire('account.created', { username: 'evil' }, { stage: 'pre' });
  await h.fire('account.created', { username: 'alice', domain: 'alice.test' }, { stage: 'post' });
  await post(h, '/digest', {});
  await h.flush();
  assert.equal((await h.callRoute('GET', '/status')).status, 200);
  assert.deepEqual(h.unusedPermissions(), []);
  assert.deepEqual(h.deniedPermissions(), []);
  assert.deepEqual(h.state.permissionDenials, []);
  // a copy of the manifest without accounts:write cannot cancel the hook
  const bare = createMockHost({ manifest: { ...manifest, permissions: manifest.permissions.filter((p) => p !== 'accounts:write') }, accounts, locales, now: NOW, settings: { blockedUsernames: 'evil' } });
  assert.deepEqual(await bare.load(mod), { ok: true });
  const r = await bare.fire('account.created', { username: 'evil' }, { stage: 'pre' });
  assert.equal(r.cancelled, false);
  assert.equal(r.errors[0].code, 'PERMISSION_DENIED');
  assert.ok(bare.state.permissionDenials.some((d) => d.scope === 'accounts:write'));
  assert.throws(() => { throw new PermissionError('x', 'y'); }, PermissionError);
});
