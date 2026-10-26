import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, waitForJob } from './support/app.js';
import { createTarGz, packageFromFiles } from './support/tar.js';
import { loadCommonJs, REPO_ROOT } from '../src/lib/plugin-sdk.js';
import { HOST_API_VERSION, PASSWORD_MASK } from '../src/services/plugins.js';

const fixtures = loadCommonJs(path.join(REPO_ROOT, 'plugins', 'sdk', 'test', 'fixtures.js'));
const ID = 'net.example.hello';
const BASE = `/api/plugins/${ID}`;

const MAIN_JS = `'use strict';
const sdk = require('whm/plugins/sdk');
const helper = require('./lib/helper');
const calls = [];
module.exports = {
  calls,
  async activate(ctx) { calls.push('activate'); module.exports.ctx = ctx; ctx.log.info('activated', { version: ctx.plugin.version, apiKey: 'hunter2' }); },
  async deactivate() { calls.push('deactivate'); },
  async migrate(ctx, from) { calls.push('migrate:' + from); },
  hooks: {
    async beforeAccountCreated(evt) { calls.push('pre:' + evt.name + ':' + evt.payload.username); if (evt.payload.username === 'blocked') evt.cancel('username is blocked'); },
    async afterAccountCreated(evt) { calls.push('post:' + evt.name + ':' + evt.payload.username + ':' + evt.principal); },
    async onBackupCompleted(evt) { calls.push('post:' + evt.name + ':' + evt.payload.account); },
  },
  jobs: {
    async nightly(job, ctx) {
      calls.push('job:nightly:' + JSON.stringify(job.params));
      if (job.params.fail) throw new sdk.PluginError('nightly failed on purpose', { code: job.params.fail, status: 500 });
      job.progress(50, 'halfway');
      job.log('working');
      await ctx.store.set('lastRun', ctx.now());
      if (job.params.sleep) await new Promise((resolve) => { const t = setTimeout(resolve, job.params.sleep); job.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }); });
      if (job.cancelled) return { cancelled: true };
      return { ran: true, at: ctx.now(), helper: helper.answer };
    },
    async locked(job) { calls.push('job:locked'); await new Promise((r) => setTimeout(r, job.params.sleep || 0)); return null; },
  },
  routes(router) {
    router.get('/items', async (req, res) => res.json([{ id: 1 }]));
    router.get('/items/:id', async (req, res) => res.json({ id: req.params.id, q: req.query.q, user: req.user.username }));
    router.post('/items', { roles: ['root', 'reseller'] }, async (req, res) => res.status(201).json(req.body));
    router.get('/boom', async () => { throw new Error('kaboom'); });
    router.get('/missing', async () => { throw new sdk.NotFoundError('item', 'x'); });
    router.get('/text', async (req, res) => res.set('X-Plugin', 'yes').send('plain'));
    router.post('/call', async (req, res) => {
      const ctx = module.exports.ctx;
      const fn = req.body.method.split('.').reduce((o, k) => o[k], ctx);
      res.json(await fn(...(req.body.args || [])));
    });
  },
};
`;

function writePlugin(dir, manifest, { main = MAIN_JS, extra = {} } = {}) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'main.js'), main);
  fs.writeFileSync(path.join(dir, 'lib', 'helper.js'), "module.exports = { answer: 42 };\n");
  fs.writeFileSync(path.join(dir, 'locales', 'en.json'), JSON.stringify({ greeting: 'Hello {name}' }));
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

function packageFiles(manifest, main = MAIN_JS) {
  return { 'plugin.json': JSON.stringify(manifest), 'main.js': main, 'lib/helper.js': "module.exports = { answer: 42 };\n" };
}

function signFiles(files, privateKey, kid) {
  const lines = Object.keys(files).sort().map((f) => `${f} ${crypto.createHash('sha256').update(files[f]).digest('hex')}`);
  const digest = crypto.createHash('sha256').update(lines.join('\n')).digest();
  return { ...files, 'SIGNATURE.json': JSON.stringify({ kid, alg: 'ed25519', sig: crypto.sign(null, digest, privateKey).toString('base64') }) };
}

let app;
let csrf;
let tmp;
const post = (url, body) => app.http.post(url).set('X-CSRF-Token', csrf).send(body);
const put = (url, body) => app.http.put(url).set('X-CSRF-Token', csrf).send(body);
const del = (url) => app.http.delete(url).set('X-CSRF-Token', csrf);
const get = (url) => app.http.get(url);
const installRaw = (buf) => app.http.post('/api/plugins/manage/install').set('X-CSRF-Token', csrf).set('Content-Type', 'application/gzip').send(buf);
const pluginCtx = () => app.ctx.plugins.entry(ID).ctx;
const pluginModule = () => app.ctx.plugins.entry(ID).module;

beforeAll(async () => {
  app = await createTestApp();
  app.ctx.jobs.start();
  csrf = await app.login();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-plugin-'));
});
afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('install', () => {
  it('installs from an unpacked directory and reports the unsigned warning', async () => {
    const dir = writePlugin(path.join(tmp, 'hello'), fixtures.fullManifest());
    const res = await post('/api/plugins/manage/install', { dir });
    expect(res.status).toBe(201);
    expect(res.body.data.warnings).toEqual(['unsigned', 'in-process']);
    expect(res.body.data.plugin).toMatchObject({ id: ID, name: 'Hello Plugin', version: '1.2.3', state: 'installed', signed: false, signer: null, source: 'path' });
    expect(fs.existsSync(path.join(app.ctx.config.pluginsDir, ID, 'main.js'))).toBe(true);
    expect(fs.existsSync(path.join(app.ctx.config.pluginsDir, '.staging'))).toBe(true);
    expect(fs.readdirSync(path.join(app.ctx.config.pluginsDir, '.staging'))).toEqual([]);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'plugin.install'").get().n).toBe(1);
  });

  it('installs from a generated .whmplugin tar (wrapper directory stripped) and upgrades in place', async () => {
    const manifest = fixtures.fullManifest({ id: 'net.example.packed', name: 'Packed', version: '2.0.0', ui: undefined, cron: undefined, hooks: undefined });
    const buf = packageFromFiles(packageFiles(manifest), { wrapper: 'net.example.packed-2.0.0' });
    const res = await installRaw(buf);
    expect(res.status).toBe(201);
    expect(res.body.data.plugin).toMatchObject({ id: 'net.example.packed', version: '2.0.0', source: 'upload' });
    const again = await installRaw(packageFromFiles(packageFiles({ ...manifest, version: '2.1.0' })));
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({ previousVersion: '2.0.0', plugin: { version: '2.1.0' } });
    expect(fs.existsSync(path.join(app.ctx.config.pluginsDir, 'net.example.packed.previous'))).toBe(false);
    expect(fs.readdirSync(path.join(app.ctx.config.pluginsDir, '.staging'))).toEqual([]);
  });

  it('never touches a sibling plugin whose id ends in ".previous" while upgrading', async () => {
    const sibling = writePlugin(path.join(tmp, 'sibling'), fixtures.minimalManifest({ id: `${ID}.previous` }));
    expect((await post('/api/plugins/manage/install', { dir: sibling })).status).toBe(201);
    const marker = path.join(app.ctx.config.pluginsDir, `${ID}.previous`, 'plugin.json');
    expect(fs.existsSync(marker)).toBe(true);
    const again = await post('/api/plugins/manage/install', { dir: writePlugin(path.join(tmp, 'hello'), fixtures.fullManifest()) });
    expect(again.status).toBe(201);
    expect(again.body.data.previousVersion).toBe('1.2.3');
    expect(fs.existsSync(marker)).toBe(true);
    expect((await get(`/api/plugins/manage/${ID}.previous`)).status).toBe(200);
    expect((await del(`/api/plugins/manage/${ID}.previous?purge=true`)).status).toBe(200);
    expect(fs.existsSync(path.join(app.ctx.config.pluginsDir, ID, 'main.js'))).toBe(true);
  });

  it('rejects an invalid manifest with the SDK error list and an incompatible engines range', async () => {
    const bad = await installRaw(packageFromFiles(packageFiles({ ...fixtures.minimalManifest(), id: 'bad', permissions: ['nope'] })));
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_manifest');
    expect(bad.body.error.fields.map((e) => e.path)).toEqual(expect.arrayContaining(['id', 'permissions[0]']));
    const incompatible = await installRaw(packageFromFiles(packageFiles(fixtures.minimalManifest({ engines: { whm: '^9.0.0' } }))));
    expect(incompatible.status).toBe(422);
    expect(incompatible.body.error.code).toBe('incompatible_host');
    const noJson = await installRaw(packageFromFiles({ 'main.js': 'module.exports = {}' }));
    expect(noJson.status).toBe(422);
    expect(noJson.body.error.code).toBe('invalid_manifest');
    const notGzip = await installRaw(Buffer.from('definitely not a tarball'));
    expect(notGzip.status).toBe(422);
    expect(notGzip.body.error.code).toBe('invalid_package');
  });

  it('refuses tar entries with ../, absolute names, symlinks and devices', async () => {
    const m = JSON.stringify(fixtures.minimalManifest());
    const cases = [
      [{ name: '../escape.js', data: 'x' }, /\.\./],
      [{ name: '/etc/cron.d/evil', data: 'x' }, /absolute/],
      [{ name: 'link', type: 'symlink', linkname: '/etc/passwd' }, /symbolic link/],
      [{ name: 'dev', type: 'char', linkname: '' }, /character device/],
    ];
    for (const [entry, re] of cases) {
      const res = await installRaw(createTarGz([{ name: 'plugin.json', data: m }, { name: 'main.js', data: 'module.exports = {};' }, entry]));
      expect(res.status, entry.name).toBe(422);
      expect(res.body.error.code).toBe('invalid_package');
      expect(res.body.error.message).toMatch(re);
    }
  });

  it('validates the JSON install bodies and the path allow-list', async () => {
    expect((await post('/api/plugins/manage/install', { nope: 1 })).status).toBe(422);
    const outside = await post('/api/plugins/manage/install', { path: '/etc/hostname' });
    expect(outside.status).toBe(403);
    expect(outside.body.error.code).toBe('path_not_allowed');
    const outsideDir = await post('/api/plugins/manage/install', { dir: '/etc' });
    expect(outsideDir.status).toBe(403);
    expect(outsideDir.body.error.code).toBe('path_not_allowed');
    const file = path.join(tmp, 'pkg.whmplugin');
    fs.writeFileSync(file, packageFromFiles(packageFiles(fixtures.minimalManifest({ id: 'net.example.frompath' }))));
    const ok = await post('/api/plugins/manage/install', { path: file });
    expect(ok.status).toBe(201);
    expect(ok.body.data.plugin).toMatchObject({ id: 'net.example.frompath', source: 'path' });
  });

  it('is root only', async () => {
    const reseller = await app.createUser('resell1', 'reseller');
    const http = request.agent(app.ctx.app);
    const login = await http.post('/api/auth/login').send({ username: reseller.username, password: reseller.password });
    expect(login.status).toBe(200);
    expect((await http.get('/api/plugins/manage')).status).toBe(403);
    expect((await http.get('/api/plugins/ui')).status).toBe(200);
  });
});

describe('enable + routes', () => {
  it('enables the plugin, activates the module and serves its routes with role enforcement', async () => {
    const res = await post(`/api/plugins/manage/${ID}/enable`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'enabled', lastError: null });
    expect(pluginModule().calls).toContain('activate');
    expect(pluginCtx().plugin).toMatchObject({ id: ID, version: '1.2.3', hostVersion: HOST_API_VERSION, isolation: 'in-process', dir: path.join(app.ctx.config.pluginsDir, ID), dataDir: path.join(app.ctx.config.pluginDataDir, ID) });

    const items = await get(`${BASE}/items`);
    expect(items.status).toBe(200);
    expect(items.body).toEqual({ data: [{ id: 1 }] });
    const one = await get(`${BASE}/items/7?q=x`);
    expect(one.body.data).toEqual({ id: '7', q: 'x', user: 'root' });
    const created = await post(`${BASE}/items`, { hello: 'world' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ data: { hello: 'world' } });
    const text = await get(`${BASE}/text`);
    expect(text.status).toBe(200);
    expect(text.text).toBe('plain');
    expect(text.headers['x-plugin']).toBe('yes');

    const boom = await get(`${BASE}/boom`);
    expect(boom.status).toBe(500);
    expect(boom.body.error).toEqual({ code: 'INTERNAL', message: 'plugin route failed' });
    const missing = await get(`${BASE}/missing`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: 'NOT_FOUND', details: { resource: 'item', id: 'x' } });
    const unknown = await get(`${BASE}/nope`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
    expect((await get('/api/plugins/net.example.notinstalled/items')).status).toBe(404);
    expect((await get('/api/plugins/manage/net.example.notinstalled')).status).toBe(404);

    const resellerHttp = request.agent(app.ctx.app);
    await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: 'Test-Passw0rd!1' });
    const rc = (await resellerHttp.get('/api/auth/me')).body.data.csrfToken;
    expect((await resellerHttp.get(`${BASE}/items`)).status).toBe(403);
    expect((await resellerHttp.post(`${BASE}/items`).set('X-CSRF-Token', rc).send({ a: 1 })).status).toBe(201);
    const user = await app.createUser('plainuser', 'user');
    const userHttp = request.agent(app.ctx.app);
    await userHttp.post('/api/auth/login').send({ username: user.username, password: user.password });
    const uc = (await userHttp.get('/api/auth/me')).body.data.csrfToken;
    const forbidden = await userHttp.post(`${BASE}/items`).set('X-CSRF-Token', uc).send({ a: 1 });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
    expect((await request(app.ctx.app).get(`${BASE}/items`)).status).toBe(401);
  });

  it('lists the plugin for the UI with its sidebar and pages, and the detail view', async () => {
    const ui = await get('/api/plugins/ui');
    expect(ui.body.data).toEqual([{ id: ID, name: 'Hello Plugin', version: '1.2.3', sidebar: [{ category: 'Plugins', label: 'Hello', route: '/', icon: 'hand' }], pages: expect.arrayContaining([expect.objectContaining({ route: '/settings', kind: 'settings', source: 'manifest' })]) }]);
    const detail = await get(`/api/plugins/manage/${ID}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ id: ID, state: 'enabled', requireSignature: false, manifest: { id: ID } });
    expect(detail.body.data.routes).toEqual(expect.arrayContaining([{ method: 'POST', path: '/items', roles: ['root', 'reseller'] }]));
    expect(detail.body.data.logs.find((l) => l.msg === 'activated')).toMatchObject({ level: 'info', fields: { version: '1.2.3', apiKey: '[REDACTED]' } });
    expect(detail.body.data.permissionsUsed).toContain('api:routes');
  });

  it('requires relative modules to stay inside the plugin and allow-lists built-ins', async () => {
    const dir = writePlugin(path.join(tmp, 'escape'), fixtures.minimalManifest({ id: 'net.example.escape' }), { main: "const fs = require('fs'); module.exports = {};" });
    await post('/api/plugins/manage/install', { dir });
    const res = await post('/api/plugins/manage/net.example.escape/enable');
    expect(res.body.data.state).toBe('errored');
    expect(res.body.data.lastError).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('require:fs') });
    fs.writeFileSync(path.join(dir, 'main.js'), "const c = require('node:crypto'); const p = require('path'); module.exports = { async activate(ctx) { await ctx.store.set('ok', typeof c.createHash === 'function' && typeof p.join === 'function'); } };");
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(fixtures.minimalManifest({ id: 'net.example.escape', permissions: ['store:own'] })));
    await post('/api/plugins/manage/install', { dir });
    const ok = await post('/api/plugins/manage/net.example.escape/enable');
    expect(ok.body.data.state).toBe('enabled');
    expect(app.ctx.db.prepare("SELECT value_json FROM plugin_store WHERE plugin_id = 'net.example.escape' AND key = 'ok'").get().value_json).toBe('true');
    await del('/api/plugins/manage/net.example.escape?purge=true');
  });
});

describe('settings', () => {
  it('serves defaults, masks passwords, validates writes and keeps a masked password untouched', async () => {
    const before = await get(`/api/plugins/manage/${ID}/settings`);
    expect(before.body.data.values).toMatchObject({ greeting: 'hello', retries: 3, mode: 'fast', targets: ['a'], enabled: true, schedule: '0 2 * * *' });
    expect(before.body.data.values.apiKey).toBeUndefined();
    const invalid = await put(`/api/plugins/manage/${ID}/settings`, { retries: 99, mode: 'nope', unknown: 1 });
    expect(invalid.status).toBe(422);
    expect(Object.keys(invalid.body.error.fields).sort()).toEqual(['mode', 'retries', 'unknown']);
    const ok = await put(`/api/plugins/manage/${ID}/settings`, { greeting: 'hi', apiKey: 'top-secret', retries: 5 });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ greeting: 'hi', apiKey: PASSWORD_MASK, retries: 5 });
    const stored = app.ctx.db.prepare('SELECT value_json FROM plugin_settings WHERE plugin_id = ? AND key = ?').get(ID, 'apiKey').value_json;
    expect(stored).not.toContain('top-secret');
    expect(await pluginCtx().settings.get('apiKey')).toBe('top-secret');
    await put(`/api/plugins/manage/${ID}/settings`, { apiKey: PASSWORD_MASK, greeting: 'hey' });
    expect(await pluginCtx().settings.get('apiKey')).toBe('top-secret');
    expect(await pluginCtx().settings.get('greeting')).toBe('hey');
  });

  it('mirrors ctx.settings: validation, onChange and unknown keys', async () => {
    const c = pluginCtx();
    const seen = [];
    const off = c.settings.onChange((key, value, previous) => seen.push([key, value, previous]));
    expect(await c.settings.set('retries', 7)).toBe(7);
    expect(seen).toEqual([['retries', 7, 5]]);
    off();
    await expect(c.settings.set('retries', 11)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', fields: [{ path: 'retries', code: 'INVALID_VALUE' }] });
    await expect(c.settings.get('nope')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await c.settings.getAll()).toMatchObject({ retries: 7, greeting: 'hey' });
    expect(await c.settings.set('notes', null)).toBeUndefined();
    expect(() => c.settings.onChange('x')).toThrow(/function/);
  });

  it('rebinds setting-bound cron schedules when the setting changes', async () => {
    const row = () => app.ctx.scheduler.listPrefix(`plugin:${ID}:`).find((r) => r.name === `plugin:${ID}:nightly-run`);
    expect(row()).toMatchObject({ cron: '0 2 * * *', job_type: `plugin:${ID}:nightly`, params: { trigger: 'cron:nightly-run', params: { source: 'cron' } } });
    expect(app.ctx.scheduler.listPrefix(`plugin:${ID}:`).some((r) => r.name === `plugin:${ID}:hourly-ping`)).toBe(false);
    await put(`/api/plugins/manage/${ID}/settings`, { schedule: '30 4 * * 1' });
    expect(row()).toMatchObject({ cron: '30 4 * * 1' });
    await pluginCtx().settings.set('schedule', null);
    expect(row()).toBeUndefined();
    await pluginCtx().settings.set('schedule', '0 2 * * *');
    expect(row()).toMatchObject({ cron: '0 2 * * *' });
  });
});

describe('store', () => {
  it('keeps key/values and collections with the mock query operators', async () => {
    const c = pluginCtx();
    expect(await c.store.get('missing')).toBeUndefined();
    expect(await c.store.set('k1', { a: 1 })).toEqual({ a: 1 });
    await c.store.set('k2', 'two');
    expect(await c.store.keys('k')).toEqual(['k1', 'k2']);
    expect(await c.store.delete('k2')).toBe(true);
    expect(await c.store.delete('k2')).toBe(false);
    await expect(c.store.set('', 1)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(c.store.set('big', 'x'.repeat(1024 * 1024 + 1))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    for (const op of [() => c.store.get('__seq'), () => c.store.set('__seq', 0), () => c.store.delete('__seq')]) await expect(op()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const col = c.store.collection('items');
    const a = await col.insert({ n: 1, tag: 'x' });
    expect(a).toMatchObject({ id: 'doc_0001', n: 1, tag: 'x', createdAt: expect.any(Number), updatedAt: expect.any(Number) });
    await col.insert({ id: 'custom', n: 2, tag: 'y' });
    await col.insert({ n: 3, tag: 'x' });
    await expect(col.insert({ id: 'custom' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await col.find({ tag: 'x' }, { sort: { n: -1 } })).map((d) => d.n)).toEqual([3, 1]);
    expect((await col.find({ n: { $gte: 2 } })).map((d) => d.n)).toEqual([2, 3]);
    expect((await col.find({ n: { $in: [1, 3] } }, { limit: 1, offset: 1 })).map((d) => d.n)).toEqual([3]);
    expect(await col.findOne({ id: 'custom' })).toMatchObject({ n: 2 });
    expect(await col.findOne({ n: 99 })).toBeNull();
    await expect(col.find({ n: { $bogus: 1 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await col.update({ tag: 'x' }, { tag: 'z', id: 'ignored', createdAt: 0 })).toBe(2);
    expect(await col.count({ tag: 'z' })).toBe(2);
    expect((await col.findOne({ id: 'doc_0001' })).createdAt).toBe(a.createdAt);
    expect(await col.remove({ tag: 'z' })).toBe(2);
    expect(await col.count()).toBe(1);
    expect(() => c.store.collection('Bad')).toThrow(/collection name/);
  });
});

describe('jobs, cron and schedule', () => {
  it('runs a declared job via the manage API with progress, log and result', async () => {
    const res = await post(`/api/plugins/manage/${ID}/jobs/nightly`, { params: { x: 1 } });
    expect(res.status).toBe(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job).toMatchObject({ status: 'done', progress: 100, type: `plugin:${ID}:nightly`, result: { ran: true, helper: 42 } });
    expect(job.logs.map((l) => l.line)).toContain('working');
    expect(pluginModule().calls).toContain('job:nightly:{"x":1}');
    expect(await pluginCtx().store.get('lastRun')).toEqual(expect.any(Number));
    const status = await pluginCtx().jobs.status(String(job.id));
    expect(status).toMatchObject({ id: String(job.id), plugin: ID, name: 'nightly', status: 'done', progress: 100, params: { x: 1 }, result: { ran: true, helper: 42 }, error: null, trigger: 'manual', createdAt: expect.any(Number), finishedAt: expect.any(Number) });
    expect(status).not.toHaveProperty('log');
    expect((await post(`/api/plugins/manage/${ID}/jobs/unknown`, {})).status).toBe(404);
  });

  it('mirrors ctx.jobs: run returns a string id, cancel honours cancellable and aborts running jobs', async () => {
    const c = pluginCtx();
    const id = await c.jobs.run('nightly', { sleep: 5000 });
    expect(typeof id).toBe('string');
    for (let i = 0; i < 100 && (await c.jobs.status(id)).status !== 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await c.jobs.status(id)).status).toBe('running');
    expect(await c.jobs.cancel(id)).toBe(true);
    expect(await c.jobs.status(id)).toMatchObject({ status: 'cancelled', finishedAt: expect.any(Number), error: null });
    const done = await waitForJob(app.ctx, Number(id));
    expect(done.status).toBe('cancelled');
    expect((await c.jobs.status(id)).error).toBeNull();
    expect(await c.jobs.cancel(id)).toBe(false);
    const failing = await c.jobs.run('nightly', { fail: 'UPSTREAM_DOWN' });
    await waitForJob(app.ctx, Number(failing));
    expect((await c.jobs.status(failing)).error).toEqual({ code: 'UPSTREAM_DOWN', message: 'nightly failed on purpose' });
    await expect(c.jobs.run('nope')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(c.jobs.status('999999')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const locked = await c.jobs.run('locked', { sleep: 300 });
    for (let i = 0; i < 100 && (await c.jobs.status(locked)).status !== 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    await expect(c.jobs.cancel(locked)).rejects.toMatchObject({ code: 'CONFLICT' });
    await waitForJob(app.ctx, Number(locked));
    await expect(c.jobs.progress(id, 150)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('manages runtime schedules through ctx.schedule', async () => {
    const c = pluginCtx();
    const s = await c.schedule.cron('*/5 * * * *', 'nightly', { source: 'runtime' });
    expect(s).toMatchObject({ id: expect.any(String), jobName: 'nightly', expr: '*/5 * * * *', nextRunAt: expect.any(Number) });
    await expect(c.schedule.cron('0 * * * *', 'nightly')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(c.schedule.cron('bad cron', 'locked')).rejects.toMatchObject({ code: 'INVALID_CRON' });
    await expect(c.schedule.cron('0 * * * *', 'nope')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const list = await c.schedule.list();
    expect(list).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'nightly-run', jobName: 'nightly', source: 'manifest', params: { source: 'cron' } }),
      expect.objectContaining({ name: 'nightly', jobName: 'nightly', source: 'runtime', expr: '*/5 * * * *', params: { source: 'runtime' } }),
    ]));
    expect(await c.schedule.unschedule('nightly')).toBe(true);
    expect(await c.schedule.unschedule('nightly')).toBe(false);
    expect((await c.schedule.list()).map((x) => x.source)).toEqual(['manifest']);
  });
});

describe('hooks and events', () => {
  it('vetoes account creation from a pre hook and delivers post hooks', async () => {
    const blocked = await post('/api/accounts', { username: 'blocked', domain: 'blocked.example.com' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toEqual({ code: 'hook_rejected', message: 'Hello Plugin: username is blocked' });
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE username = 'blocked'").get().n).toBe(0);
    const ok = await post('/api/accounts', { username: 'alice', domain: 'alice.example.com', contactEmail: 'alice@example.com' });
    expect(ok.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(pluginModule().calls).toContain('pre:account.created:alice');
    expect(pluginModule().calls).toContain('post:account.created:alice:root');
  });

  it('subscribes with ctx.events.on and emits namespaced events only', async () => {
    const c = pluginCtx();
    const got = [];
    const off = c.events.on(`${ID}.ping`, (evt) => { got.push(evt.payload); expect(Object.isFrozen(evt.payload)).toBe(true); });
    expect(await c.events.emit(`${ID}.ping`, { n: 1 })).toEqual({ delivered: 1 });
    expect(got).toEqual([{ n: 1 }]);
    expect(off()).toBe(true);
    expect(await c.events.emit(`${ID}.ping`, { n: 2 })).toEqual({ delivered: 0 });
    await expect(c.events.emit('net.example.other.ping', {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(c.events.emit('account.created', {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(() => c.events.on('account.created', () => {}, { stage: 'nope' })).toThrow(/stage/);
    expect(() => c.events.on('ssl.issued', () => {}, { stage: 'pre' })).toThrow(/no "pre" stage/);
    expect(() => c.events.on('bogus', () => {})).toThrow(/unknown event/);
    const thrower = c.events.on('account.suspended', () => { throw new Error('post handler bug'); });
    const sus = await post('/api/accounts/alice/suspend', { reason: 'test' });
    expect(sus.status).toBe(200);
    thrower();
    const logs = await get(`/api/plugins/manage/${ID}/logs?limit=5`);
    expect(logs.body.data.some((l) => /hook handler events.on threw/.test(l.msg))).toBe(true);
  });
});

describe('ctx.api bridge', () => {
  it('reads and writes accounts in the mock shape', async () => {
    const c = pluginCtx();
    const list = await c.api.accounts.list({ pageSize: 10 });
    expect(list.meta).toEqual({ page: 1, pageSize: 10, total: 1 });
    expect(list.data[0]).toMatchObject({ username: 'alice', domain: 'alice.example.com', owner: 'root', suspended: true, suspendReason: 'test', package: 'default', contactEmail: 'alice@example.com', createdAt: expect.any(Number) });
    await expect(c.api.accounts.get('nobody')).rejects.toMatchObject({ code: 'NOT_FOUND', details: { resource: 'account', id: 'nobody' } });
    await expect(c.api.accounts.suspend('alice')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await c.api.accounts.unsuspend('alice')).suspended).toBe(false);
    expect((await c.api.accounts.suspend('alice', { reason: 'late' })).suspendReason).toBe('late');
    expect((await c.api.accounts.list({ suspended: false })).data).toEqual([]);
    await c.api.accounts.unsuspend('alice');
    const audit = app.ctx.db.prepare("SELECT principal, role FROM audit_log WHERE action = 'account.suspend' ORDER BY id DESC LIMIT 1").get();
    expect(audit).toEqual({ principal: `plugin:${ID}`, role: 'plugin' });
    expect((await c.api.packages.list())[0]).toMatchObject({ name: 'default' });
  });

  it('bridges system, services, audit and contacts', async () => {
    const c = pluginCtx();
    const info = await c.api.system.info();
    expect(info).toMatchObject({ hostname: 'test.example.com', os: 'Test Linux 1.0', kernel: '6.0.0', uptimeSec: 3600, load: [0.1, 0.2, 0.3], mem: { totalMb: expect.any(Number) }, panelVersion: HOST_API_VERSION });
    expect(info.disk[0]).toMatchObject({ mount: '/' });
    await expect(c.api.services.status('no-such-service')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const r = await c.api.audit.record({ action: 'cleanup', target: 'alice', details: { files: 3, apiKey: 'x' } });
    expect(r).toEqual({ id: expect.any(String) });
    const row = app.ctx.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(Number(r.id));
    expect(row).toMatchObject({ principal: `plugin:${ID}`, role: 'plugin', action: `plugin:${ID}:cleanup`, target: 'alice' });
    expect(JSON.parse(row.args_redacted)).toEqual({ files: 3, apiKey: '[REDACTED]' });
    await expect(c.api.audit.record({ action: 'Bad Action' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(c.api.contacts.notify({ event: 'other.event', subject: 's', body: 'b' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const n = await c.api.contacts.notify({ event: `${ID}.alert`, subject: 'Hi', body: 'body', severity: 'warning' });
    expect(n).toEqual({ ok: true, delivered: expect.any(Number) });
    expect(await c.agent.op('svc.status', { unit: 'sshd' })).toMatchObject({ unit: 'sshd', active: true });
    await expect(c.agent.op('svc.restart', { unit: 'sshd' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', details: { scope: 'agent:op:svc.restart' } });
  });

  it('gates backups behind the restore token and reports missing services as 503', async () => {
    const c = pluginCtx();
    expect(await c.api.backups.list()).toEqual([]);
    expect(await c.api.backups.destinations.list()).toEqual([]);
    await expect(c.api.backups.delete('999')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(c.api.backups.create({ account: 'alice', include: ['nope'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(c.api.backups.create({ account: 'alice', compression: 'zstd' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(c.api.backups.create({ account: 'alice', encrypt: true })).rejects.toMatchObject({ code: 'UNSUPPORTED', status: 422 });
    app.ctx.db.prepare("INSERT INTO backups (id, account_id, account_name, type, path, size, sha256, status) VALUES (77, (SELECT id FROM accounts WHERE username = 'alice'), 'alice', 'full', '/backup/alice.tar.gz', 10, 'abc', 'done')").run();
    expect((await c.api.backups.list({ account: 'alice' }))[0]).toMatchObject({ id: '77', account: 'alice', path: '/backup/alice.tar.gz', compression: 'gzip', encrypted: false });
    await expect(c.api.backups.restore({ artefactId: '77', account: 'alice', confirmToken: 'nope' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', details: { scope: 'confirm-token' } });
    const tok = await post(`/api/plugins/manage/${ID}/restore-token`, { artefactId: '77', account: 'alice' });
    expect(tok.status).toBe(200);
    expect(tok.body.data).toEqual({ token: expect.any(String), expiresAt: expect.any(String) });
    await expect(c.api.backups.restore({ artefactId: '77', account: 'bob', confirmToken: tok.body.data.token })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const restored = await c.api.backups.restore({ artefactId: '77', account: 'alice', confirmToken: tok.body.data.token });
    expect(restored).toEqual({ ok: true, jobId: expect.any(String) });
    await expect(c.api.backups.restore({ artefactId: '77', account: 'alice', confirmToken: tok.body.data.token })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await waitForJob(app.ctx, Number(restored.jobId)).catch(() => {});
    const saved = app.ctx.backup;
    app.ctx.backup = null;
    await expect(c.api.backups.list()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
    app.ctx.backup = saved;
  });

  it('surfaces a missing permission as 403 from a plugin route', async () => {
    const dir = writePlugin(path.join(tmp, 'gated'), fixtures.minimalManifest({ id: 'net.example.gated', permissions: ['api:routes'] }), {
      main: "module.exports = { routes(r, ctx) { r.get('/accounts', async (req, res) => res.json(await ctx.api.accounts.list())); } };",
    });
    await post('/api/plugins/manage/install', { dir });
    await post('/api/plugins/manage/net.example.gated/enable');
    const res = await get('/api/plugins/net.example.gated/accounts');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { scope: 'accounts:read', method: 'ctx.api.accounts.list', pluginId: 'net.example.gated' } });
    const detail = await get('/api/plugins/manage/net.example.gated');
    expect(detail.body.data.permissionDenials[0]).toMatchObject({ scope: 'accounts:read' });
    await del('/api/plugins/manage/net.example.gated?purge=true');
  });
});

describe('fs, crypto, net, i18n', () => {
  it('sandboxes ctx.fs under the data directory', async () => {
    const c = pluginCtx();
    await expect(c.fs.writeFile('../x', 'a')).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(c.fs.writeFile('/abs', 'a')).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(c.fs.readFile('a\0b')).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await c.fs.mkdir('sub/dir');
    await c.fs.writeFile('sub/dir/a.txt', 'hello');
    expect(await c.fs.readFile('sub/dir/a.txt')).toBe('hello');
    expect(Buffer.isBuffer(await c.fs.readFile('sub/dir/a.txt', { encoding: null }))).toBe(true);
    expect(await c.fs.list('sub')).toEqual([{ name: 'dir', type: 'dir', size: 0, mtime: expect.any(Number) }]);
    expect(await c.fs.exists('sub/dir/a.txt')).toBe(true);
    expect(await c.fs.exists('nope')).toBe(false);
    await expect(c.fs.readFile('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(c.fs.remove('sub')).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(c.fs.writeFile('sub/dir/a.txt/child', 'x')).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(c.fs.mkdir('sub/dir/a.txt/child')).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(c.fs.mkdir('sub/dir/a.txt')).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    fs.symlinkSync('/etc', path.join(c.plugin.dataDir, 'link'));
    await expect(c.fs.readFile('link/hostname')).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    expect(await c.fs.remove('sub', { recursive: true })).toBe(true);
    expect(await c.fs.remove('sub')).toBe(false);
    expect(fs.existsSync(path.join(app.ctx.config.pluginDataDir, ID, 'sub'))).toBe(false);
  });

  it('round-trips ctx.crypto and rejects tampering', async () => {
    const c = pluginCtx();
    const ct = await c.crypto.encrypt('secret');
    expect(ct.startsWith('whm1:')).toBe(true);
    expect(await c.crypto.decrypt(ct)).toBe('secret');
    const flipped = `${ct.slice(0, 20)}${ct[20] === 'A' ? 'B' : 'A'}${ct.slice(21)}`;
    await expect(c.crypto.decrypt(flipped)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(c.crypto.decrypt('v1:nope')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(c.crypto.randomToken(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(() => c.crypto.randomToken(4)).toThrow(/8\.\.1024/);
    expect(c.crypto.sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('allows only granted https hosts for ctx.net.fetch and follows redirects within scope', async () => {
    const c = pluginCtx();
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push([url, init.redirect, init.method, init.body]);
      if (url.startsWith('https://api.example.net/redirect')) return { status: 302, headers: new Map([['location', 'https://evil.example.org/']]) };
      if (url.startsWith('https://api.example.net/hop')) return { status: 301, headers: new Map([['location', '/landed']]) };
      if (url.startsWith('https://api.example.net/see-other')) return { status: 303, headers: new Map([['location', '/landed']]) };
      if (url.startsWith('https://api.example.net/temp')) return { status: 307, headers: new Map([['location', '/landed']]) };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ url }) };
    };
    try {
      await expect(c.net.fetch('http://api.example.net/')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(c.net.fetch('https://evil.example.org/')).rejects.toMatchObject({ code: 'PERMISSION_DENIED', details: { scope: 'net:outbound:evil.example.org' } });
      await expect(c.net.fetch('https://storage.example.net:8443/')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      const ok = await c.net.fetch('https://a.storage.example.net:8443/x');
      expect(await ok.json()).toEqual({ url: 'https://a.storage.example.net:8443/x' });
      await expect(c.net.fetch('https://api.example.net/redirect')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      const hopped = await c.net.fetch('https://api.example.net/hop');
      expect(await hopped.json()).toEqual({ url: 'https://api.example.net/landed' });
      expect(calls.every(([, redirect]) => redirect === 'manual')).toBe(true);
      await c.net.fetch('https://api.example.net/see-other', { method: 'POST', body: 'payload' });
      expect(calls.at(-1)).toEqual(['https://api.example.net/landed', 'manual', 'GET', undefined]);
      await c.net.fetch('https://api.example.net/temp', { method: 'POST', body: 'payload' });
      expect(calls.at(-1)).toEqual(['https://api.example.net/landed', 'manual', 'POST', 'payload']);
      expect(await (await c.net.fetch('https://api.example.net:443/')).json()).toEqual({ url: 'https://api.example.net/' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('translates with the plugin locale files', () => {
    const c = pluginCtx();
    expect(c.i18n.locale()).toBe('en');
    expect(c.i18n.t('greeting', { name: 'Bob' })).toBe('Hello Bob');
    expect(c.i18n.t('unknown.key')).toBe('unknown.key');
    expect(c.i18n.t('greeting', {}, 'fr')).toBe('Hello {name}');
  });

  it('freezes ctx and exposes the SDK error classes', () => {
    const c = pluginCtx();
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.api.backups)).toBe(true);
    expect(typeof c.errors.PluginError).toBe('function');
    expect(typeof c.now()).toBe('number');
    expect(c.http.baseUrl).toBe(`/api/plugins/${ID}`);
    expect(() => c.http.get('/late', async () => {})).toThrow(/routes can only be registered/);
  });
});

describe('review round 1', () => {
  it('evaluates plugin code in a context without process, fetch or eval and hands out a frozen SDK', async () => {
    const main = `'use strict';
const sdk = require('whm/plugins/sdk');
module.exports = {
  routes(r) {
    r.get('/probe', async (req, res) => {
      const probe = {
        process: typeof process, globalProcess: typeof globalThis.process, fetch: typeof fetch, global: typeof global,
        eval: (() => { try { eval('1'); return 'allowed'; } catch (e) { return e.constructor.name; } })(),
        fn: (() => { try { new Function('return 1')(); return 'allowed'; } catch (e) { return e.constructor.name; } })(),
        requireProcess: (() => { try { require('process'); return 'allowed'; } catch (e) { return e.code; } })(),
        requireFs: (() => { try { require('node:fs'); return 'allowed'; } catch (e) { return e.code; } })(),
        patchProto: (() => { try { sdk.PluginError.prototype.toJSON = () => 'patched'; return 'allowed'; } catch (e) { return e.constructor.name; } })(),
        patchExports: (() => { try { sdk.semver.satisfies = () => true; return 'allowed'; } catch (e) { return e.constructor.name; } })(),
        builtins: [typeof Buffer, typeof URL, typeof setTimeout, typeof TextEncoder, typeof require('crypto').createHash],
        frozen: Object.isFrozen(sdk) && Object.isFrozen(sdk.PluginError.prototype),
      };
      console.log('probe ran', probe.eval);
      res.json(probe);
    });
  },
};
`;
    const dir = writePlugin(path.join(tmp, 'probe'), fixtures.minimalManifest({ id: 'net.example.probe', permissions: ['api:routes'] }), { main });
    expect((await post('/api/plugins/manage/install', { dir })).status).toBe(201);
    const enabled = await post('/api/plugins/manage/net.example.probe/enable');
    expect(enabled.body.data.state).toBe('enabled');
    const res = await get('/api/plugins/net.example.probe/probe');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      process: 'undefined', globalProcess: 'undefined', fetch: 'undefined', global: 'undefined', eval: 'EvalError', fn: 'EvalError',
      requireProcess: 'PERMISSION_DENIED', requireFs: 'PERMISSION_DENIED', patchProto: 'TypeError', patchExports: 'TypeError',
      builtins: ['function', 'function', 'function', 'function', 'function'], frozen: true,
    });
    const logs = await get('/api/plugins/manage/net.example.probe/logs?limit=5');
    expect(logs.body.data.some((l) => l.msg === 'probe ran EvalError' && l.level === 'info')).toBe(true);
    const detail = await get('/api/plugins/manage/net.example.probe');
    expect(detail.body.data).toMatchObject({ isolation: 'in-process', warnings: ['in-process', 'unsigned'] });
    await del('/api/plugins/manage/net.example.probe?purge=true');
  });

  it('never writes a password-type setting or a nested secret to the audit log or plugin log', async () => {
    const manifest = fixtures.minimalManifest({ id: 'net.example.secrets', permissions: ['settings:own'], settings: { fields: [{ key: 'smtpAuth', type: 'password', label: 'SMTP auth' }, { key: 'host', type: 'text', label: 'Host' }] } });
    const dir = writePlugin(path.join(tmp, 'secrets'), manifest, { main: 'module.exports = {};' });
    expect((await post('/api/plugins/manage/install', { dir })).status).toBe(201);
    const res = await put('/api/plugins/manage/net.example.secrets/settings', { smtpAuth: 'hunter2-smtp', host: 'mail.example.net' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ smtpAuth: PASSWORD_MASK, host: 'mail.example.net' });
    const rows = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE target = 'net.example.secrets' OR target = 'net.example.secrets/settings' OR action LIKE '%settings%' ORDER BY id DESC LIMIT 5").all();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.args_redacted || '').not.toContain('hunter2-smtp');
    expect(rows.some((r) => (r.args_redacted || '').includes(PASSWORD_MASK) && (r.args_redacted || '').includes('mail.example.net'))).toBe(true);
    await del('/api/plugins/manage/net.example.secrets?purge=true');

    const c = pluginCtx();
    c.log.info('nested', { smtp: { password: 'p4ss', host: 'h' } });
    const logRow = app.ctx.db.prepare('SELECT fields_json FROM plugin_logs WHERE plugin_id = ? ORDER BY id DESC LIMIT 1').get(ID);
    expect(JSON.parse(logRow.fields_json)).toEqual({ smtp: { password: '[REDACTED]', host: 'h' } });
    const r = await c.api.audit.record({ action: 'nested', details: { smtp: { password: 'p4ss' } } });
    expect(JSON.parse(app.ctx.db.prepare('SELECT args_redacted FROM audit_log WHERE id = ?').get(Number(r.id)).args_redacted)).toEqual({ smtp: { password: '[REDACTED]' } });
  });

  it('caps plugin log rows: long messages and oversized fields are truncated', async () => {
    const c = pluginCtx();
    c.log.warn('m'.repeat(10_000), { big: 'y'.repeat(20_000) });
    const row = app.ctx.db.prepare('SELECT msg, fields_json FROM plugin_logs WHERE plugin_id = ? ORDER BY id DESC LIMIT 1').get(ID);
    expect(Buffer.byteLength(row.msg)).toBeLessThanOrEqual(2 * 1024 + 3);
    expect(row.msg.endsWith('…')).toBe(true);
    const fields = JSON.parse(row.fields_json);
    expect(fields.truncated).toBe(true);
    expect(Buffer.byteLength(row.fields_json)).toBeLessThan(9 * 1024);
  });

  it('times out hook handlers that never settle: a pre hook with the cancel scope vetoes, a post hook only logs', async () => {
    const main = `module.exports = { hooks: {
  async slowPre(evt) { if (evt.payload.username === 'stall') await new Promise(() => {}); },
  async slowPost() { await new Promise(() => {}); },
} };`;
    const manifest = fixtures.minimalManifest({ id: 'net.example.slow', permissions: ['accounts:write'], hooks: [{ event: 'account.created', stage: 'pre', handler: 'slowPre' }, { event: 'account.created', handler: 'slowPost' }] });
    const dir = writePlugin(path.join(tmp, 'slow'), manifest, { main });
    expect((await post('/api/plugins/manage/install', { dir })).status).toBe(201);
    expect((await post('/api/plugins/manage/net.example.slow/enable')).body.data.state).toBe('enabled');
    app.ctx.config.pluginHookTimeoutMs = 150;
    try {
      const stalled = await post('/api/accounts', { username: 'stall', domain: 'stall.example.com' });
      expect(stalled.status).toBe(409);
      expect(stalled.body.error).toEqual({ code: 'hook_rejected', message: 'Minimal: hook hooks.slowPre timed out after 150 ms' });
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE username = 'stall'").get().n).toBe(0);
      const started = Date.now();
      const quick = await post('/api/accounts', { username: 'quick', domain: 'quick.example.com' });
      expect(quick.status).toBe(201);
      expect(Date.now() - started).toBeLessThan(2000);
      await new Promise((r) => setTimeout(r, 250));
      const detail = await get('/api/plugins/manage/net.example.slow');
      expect(detail.body.data.hookTimeouts.map((h) => h.handler)).toEqual(['hooks.slowPre', 'hooks.slowPost']);
      expect(detail.body.data.logs.filter((l) => /timed out/.test(l.msg))).toHaveLength(2);
    } finally {
      delete app.ctx.config.pluginHookTimeoutMs;
      await del('/api/plugins/manage/net.example.slow?purge=true');
    }
  });
});

describe('disable, uninstall, boot', () => {
  it('disables: routes 404, schedules gone, running jobs aborted, deactivate called', async () => {
    const c = pluginCtx();
    const id = await c.jobs.run('nightly', { sleep: 5000 });
    for (let i = 0; i < 100 && (await c.jobs.status(id)).status !== 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    const res = await post(`/api/plugins/manage/${ID}/disable`);
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('disabled');
    expect(pluginModule).toThrow();
    expect((await get(`${BASE}/items`)).status).toBe(404);
    expect(app.ctx.scheduler.listPrefix(`plugin:${ID}:`)).toEqual([]);
    expect((await waitForJob(app.ctx, Number(id))).status).toBe('cancelled');
    expect((await get('/api/plugins/ui')).body.data).toEqual([]);
    expect(app.ctx.db.prepare('SELECT state FROM plugins WHERE id = ?').get(ID).state).toBe('disabled');
  });

  it('re-enables with migrate() when the version changed and uninstall purges everything', async () => {
    const [a, b] = await Promise.all([app.ctx.plugins.enable(ID), app.ctx.plugins.enable(ID)]);
    expect(a.state).toBe('enabled');
    expect(b.state).toBe('enabled');
    expect(pluginModule().calls).toEqual(['activate']);
    expect(app.ctx.plugins.entry(ID).subscribers).toHaveLength(3);
    expect(app.ctx.scheduler.listPrefix(`plugin:${ID}:`).filter((r) => r.name === `plugin:${ID}:nightly-run`)).toHaveLength(1);
    const dir = writePlugin(path.join(tmp, 'hello2'), fixtures.fullManifest({ version: '1.3.0' }));
    const up = await post('/api/plugins/manage/install', { dir });
    expect(up.status).toBe(201);
    expect(up.body.data.plugin).toMatchObject({ version: '1.3.0', state: 'enabled' });
    expect(pluginModule().calls).toEqual(['migrate:1.2.3', 'activate']);
    expect(await pluginCtx().settings.get('greeting')).toBe('hey');
    const kept = await del(`/api/plugins/manage/${ID}`);
    expect(kept.status).toBe(200);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM plugin_settings WHERE plugin_id = ?').get(ID).n).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(app.ctx.config.pluginsDir, ID))).toBe(false);
    await post('/api/plugins/manage/install', { dir });
    await post(`/api/plugins/manage/${ID}/enable`);
    const purged = await del(`/api/plugins/manage/${ID}?purge=true`);
    expect(purged.body.data).toEqual({ id: ID, uninstalled: true, purged: true });
    for (const t of ['plugins', 'plugin_settings', 'plugin_store', 'plugin_docs', 'plugin_logs']) {
      const col = t === 'plugins' ? 'id' : 'plugin_id';
      expect(app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).get(ID).n, t).toBe(0);
    }
    expect(fs.existsSync(path.join(app.ctx.config.pluginDataDir, ID))).toBe(false);
    expect(app.ctx.scheduler.listPrefix(`plugin:${ID}:`)).toEqual([]);
    expect((await get(`/api/plugins/manage/${ID}`)).status).toBe(404);
  });

  it('loadAll() marks a plugin whose activate throws as errored and the panel keeps serving', async () => {
    const dir = writePlugin(path.join(tmp, 'broken'), fixtures.minimalManifest({ id: 'net.example.broken' }), { main: "module.exports = { async activate() { throw new Error('nope at boot'); } };" });
    await post('/api/plugins/manage/install', { dir });
    app.ctx.db.prepare("UPDATE plugins SET state = 'enabled' WHERE id = 'net.example.broken'").run();
    await expect(app.ctx.plugins.loadAll()).resolves.toBeInstanceOf(Array);
    const row = app.ctx.db.prepare('SELECT state, last_error FROM plugins WHERE id = ?').get('net.example.broken');
    expect(row.state).toBe('errored');
    expect(JSON.parse(row.last_error)).toEqual({ code: 'ACTIVATE_FAILED', message: 'nope at boot' });
    expect((await get('/api/health')).status).toBe(200);
    expect((await get('/api/plugins/manage')).body.data.find((p) => p.id === 'net.example.broken')).toMatchObject({ state: 'errored', lastError: { message: 'nope at boot' } });
    expect((await get('/api/plugins/net.example.broken/anything')).status).toBe(404);
    await del('/api/plugins/manage/net.example.broken?purge=true');
  });
});

describe('signatures', () => {
  it('verifies Ed25519 signed packages, rejects tampering and enforces require_signature', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const keysDir = path.join(app.ctx.config.dataDir, 'plugin-keys');
    fs.mkdirSync(keysDir, { recursive: true });
    fs.writeFileSync(path.join(keysDir, 'vendor.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
    const manifest = fixtures.minimalManifest({ id: 'net.example.signed' });
    const files = signFiles(packageFiles(manifest), privateKey, 'vendor');
    const ok = await installRaw(packageFromFiles(files));
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ warnings: ['in-process'], plugin: { signed: true, signer: 'vendor' } });

    const tampered = await installRaw(packageFromFiles({ ...files, 'main.js': 'module.exports = { evil: true };' }));
    expect(tampered.status).toBe(422);
    expect(tampered.body.error.code).toBe('invalid_signature');
    const unknownKey = await installRaw(packageFromFiles(signFiles(packageFiles(manifest), privateKey, 'stranger')));
    expect(unknownKey.status).toBe(201);
    expect(unknownKey.body.data.warnings[0]).toBe('unsigned');

    app.ctx.settings.set('plugins.require_signature', true);
    const unsigned = await installRaw(packageFromFiles(packageFiles(fixtures.minimalManifest({ id: 'net.example.unsigned' }))));
    expect(unsigned.status).toBe(422);
    expect(unsigned.body.error.code).toBe('unsigned_package');
    expect((await installRaw(packageFromFiles(signFiles(packageFiles(manifest), privateKey, 'stranger')))).body.error.code).toBe('unsigned_package');
    expect((await installRaw(packageFromFiles(files))).status).toBe(201);
    app.ctx.settings.set('plugins.require_signature', false);
    await del('/api/plugins/manage/net.example.signed?purge=true');
  });
});
