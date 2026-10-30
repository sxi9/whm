import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, waitForJob } from './support/app.js';
import { createTarGz, packageFromFiles } from './support/tar.js';
import { loadCommonJs, REPO_ROOT } from '../src/lib/plugin-sdk.js';
import { HOST_API_VERSION, PASSWORD_MASK, DENIAL_RING_SIZE, LOG_RING_SIZE } from '../src/services/plugins.js';
import { HttpError } from '../src/lib/errors.js';

const fixtures = loadCommonJs(path.join(REPO_ROOT, 'plugins', 'sdk', 'test', 'fixtures.js'));
const ID = 'net.example.hello';
const BASE = `/api/plugins/${ID}`;

const MAIN_JS = `'use strict';
const sdk = require('whm/plugins/sdk');
const helper = require('./lib/helper');
const calls = [];
module.exports = {
  calls,
  async activate(ctx) { calls.push('activate'); module.exports.ctx = ctx; await ctx.ui.registerPage({ route: '/runtime-items', title: 'Runtime items', kind: 'table', source: '/items' }); ctx.log.info('activated', { version: ctx.plugin.version, apiKey: 'hunter2' }); },
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
    router.get('/cookie', async (req, res) => res.set('Set-Cookie', 'whm.sid=stolen').send('x'));
    router.get('/cors', async (req, res) => res.set('Access-Control-Allow-Origin', '*').json({}));
    router.get('/html', async (req, res) => res.set('Content-Type', 'text/html').send('<b>x</b>'));
    router.post('/op', async (req, res) => res.json(await module.exports.ctx.agent.op(req.body.name, req.body.args)));
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
  // The whm-hub row's URL and config belong to the panel owner (users.superadmin): the suite's root is made the owner.
  app.ctx.db.prepare("UPDATE users SET superadmin = 1 WHERE username = 'root'").run();
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
      [{ name: 'lib/a b.js', data: 'x' }, /whitespace/],
      [{ name: 'lib/a\nb.js', data: 'x' }, /whitespace/],
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
    const spaced = writePlugin(path.join(tmp, 'spaced'), fixtures.minimalManifest({ id: 'net.example.spaced' }), { extra: { 'read me.txt': 'x' } });
    const refused = await post('/api/plugins/manage/install', { dir: spaced });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'invalid_package', message: expect.stringMatching(/whitespace/) });
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
    expect(ui.body.data).toEqual([{ id: ID, name: 'Hello Plugin', version: '1.2.3', sidebar: [{ category: 'Plugins', label: 'Hello', route: '/', icon: 'hand' }], pages: expect.arrayContaining([expect.objectContaining({ route: '/settings', kind: 'settings', origin: 'manifest' })]) }]);
    // `origin` says where a page was registered; a table/form page's `source` stays its data route.
    expect(ui.body.data[0].pages.find((p) => p.route === '/')).toEqual({ route: '/', title: 'Hello', kind: 'table', source: '/items', columns: [{ key: 'id', label: 'ID' }], origin: 'manifest' });
    expect(ui.body.data[0].pages.find((p) => p.route === '/runtime-items')).toEqual({ route: '/runtime-items', title: 'Runtime items', kind: 'table', source: '/items', origin: 'runtime' });
    expect(ui.body.data[0].pages.some((p) => p.source === 'manifest' || p.source === 'runtime')).toBe(false);
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
    const inits = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push([url, init.redirect, init.method, init.body]);
      inits.push(init);
      if (url.startsWith('https://api.example.net/redirect')) return { status: 302, headers: new Map([['location', 'https://evil.example.org/']]) };
      if (url.startsWith('https://api.example.net/sibling')) return { status: 302, headers: new Map([['location', 'https://b.storage.example.net:8443/landed']]) };
      if (url.startsWith('https://api.example.net/same')) return { status: 307, headers: new Map([['location', 'https://api.example.net/landed']]) };
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
      // Credentials never follow a redirect to another origin, even one inside the plugin's scopes.
      const cross = await c.net.fetch('https://api.example.net/sibling', { headers: { Authorization: 'Bearer secret', Cookie: 'a=b', 'X-Trace': 't1' } });
      expect(await cross.json()).toEqual({ url: 'https://b.storage.example.net:8443/landed' });
      expect(inits.at(-2).headers).toEqual({ Authorization: 'Bearer secret', Cookie: 'a=b', 'X-Trace': 't1' });
      expect(inits.at(-1).headers).toEqual({ 'X-Trace': 't1' });
      const crossHeaders = await c.net.fetch('https://api.example.net/sibling', { headers: new Headers({ authorization: 'Bearer secret', 'proxy-authorization': 'x', 'x-trace': 't2' }) });
      expect(crossHeaders.status).toBe(200);
      expect([...inits.at(-1).headers.keys()]).toEqual(['x-trace']);
      await c.net.fetch('https://api.example.net/same', { method: 'POST', body: 'p', headers: { Authorization: 'Bearer secret' } });
      expect(inits.at(-1).headers).toEqual({ Authorization: 'Bearer secret' });
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
        builtinFrozen: Object.isFrozen(require('crypto')) && Object.isFrozen(require('node:zlib')) && require('crypto') === require('node:crypto'),
        patchBuiltin: (() => { try { require('crypto').randomBytes = () => 'rigged'; return 'allowed'; } catch (e) { return e.constructor.name; } })(),
        patchZlib: (() => { try { require('zlib').gunzipSync = () => 'rigged'; return 'allowed'; } catch (e) { return e.constructor.name; } })(),
        hash: require('node:crypto').createHash('sha256').update('a').digest('hex').slice(0, 8),
        emitter: (() => { const EE = require('events'); class Sub extends EE {} const e = new Sub(); let got = null; e.on('x', (v) => { got = v; }); e.emit('x', 7); return [got, e instanceof EE, Object.isFrozen(EE), typeof EE.once]; })(),
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
      builtinFrozen: true, patchBuiltin: 'TypeError', patchZlib: 'TypeError', hash: 'ca978112', emitter: [7, true, true, 'function'],
    });
    expect(typeof crypto.randomBytes(4)).toBe('object');
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

describe('review round 2', () => {
  it('audits every ctx.agent.op call with the plugin principal, on success and on failure', async () => {
    const before = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'plugin.agent.op'").get().n;
    const ok = await post(`${BASE}/op`, { name: 'svc.status', args: { unit: 'apache2', token: 'hunter2' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ unit: 'apache2', active: true });
    app.agent.fail('svc.status', 'not_found', 'no such unit');
    try {
      const failed = await post(`${BASE}/op`, { name: 'svc.status', args: { unit: 'nope' } });
      expect(failed.status).toBe(404);
    } finally {
      app.agent.reset('svc.status');
    }
    const denied = await post(`${BASE}/op`, { name: 'user.delete', args: { username: 'alice' } });
    expect(denied.status).toBe(403);
    expect(app.agent.callsTo('user.delete')).toEqual([]);
    const rows = app.ctx.db.prepare("SELECT principal, role, target, args_redacted, result FROM audit_log WHERE action = 'plugin.agent.op' ORDER BY id").all();
    expect(rows).toHaveLength(before + 2);
    expect(rows.at(-2)).toEqual({ principal: `plugin:${ID}`, role: 'plugin', target: 'svc.status', args_redacted: JSON.stringify({ unit: 'apache2', token: '[redacted]' }), result: 'ok' });
    expect(rows.at(-1)).toMatchObject({ principal: `plugin:${ID}`, role: 'plugin', target: 'svc.status', result: 'error:NOT_FOUND' });
  });

  it('audits ctx.api.backups.upload and echoes the requested include list from backups.create', async () => {
    const c = pluginCtx();
    const saved = app.ctx.backup;
    const stub = {
      ...saved,
      archiveAccount: async (account, { include }) => ({ id: 78, account, path: '/backup/alice-78.tar.gz', size: 10, sha256: 'abc', created_at: '2026-01-01 00:00:00', status: 'done', components: { include } }),
      listDestinations: () => [{ id: 5, name: 'offsite', kind: 's3' }],
      destinationConfig: () => ({ kind: 's3', bucket: 'b', secretKey: 'shh' }),
    };
    app.ctx.backup = stub;
    app.ctx.db.prepare('UPDATE backups SET local_present = 1 WHERE id = 77').run();
    app.ctx.db.prepare("INSERT OR IGNORE INTO backup_destinations (id, name, kind) VALUES (5, 'offsite', 's3')").run();
    app.agent.set('backup.destination.upload', () => ({ remotePath: 's3://b/alice-78.tar.gz' }));
    try {
      const created = await c.api.backups.create({ account: 'alice', include: ['home', 'ssl', 'cron'] });
      expect(created).toMatchObject({ id: '78', account: 'alice', include: ['home', 'ssl', 'cron'], compression: 'gzip', encrypted: false });
      const all = await c.api.backups.create({ account: 'alice' });
      expect(all.include).toEqual(['home', 'mail', 'db', 'dns', 'ssl', 'cron']);
      const up = await c.api.backups.upload({ artefactId: '77', destinationId: '5' });
      expect(up).toEqual({ ok: true, remotePath: 's3://b/alice-78.tar.gz', sha256: 'abc' });
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM backup_uploads WHERE backup_id = 77 AND destination_id = 5 AND status = 'done'").get().n).toBe(1);
      const row = app.ctx.db.prepare("SELECT principal, role, target, args_redacted, result FROM audit_log WHERE action = 'plugin.backup.upload' ORDER BY id DESC LIMIT 1").get();
      expect(row).toEqual({ principal: `plugin:${ID}`, role: 'plugin', target: '77->offsite', args_redacted: JSON.stringify({ artefactId: '77', destinationId: '5', file: '/backup/alice.tar.gz', remotePath: 's3://b/alice-78.tar.gz' }), result: 'ok' });
      app.agent.fail('backup.destination.upload', 'command_failed', 'upload broke');
      await expect(c.api.backups.upload({ artefactId: '77', destinationId: '5' })).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
      expect(app.ctx.db.prepare("SELECT result FROM audit_log WHERE action = 'plugin.backup.upload' ORDER BY id DESC LIMIT 1").get().result).toBe('error:COMMAND_FAILED');
    } finally {
      app.ctx.backup = saved;
      app.agent.reset('backup.destination.upload');
    }
  });

  it('keeps manifest hooks out of ctx.events.off', async () => {
    const c = pluginCtx();
    const entry = app.ctx.plugins.entry(ID);
    const n = entry.subscribers.length;
    expect(c.events.off('account.created', pluginModule().hooks.afterAccountCreated)).toBe(false);
    expect(entry.subscribers).toHaveLength(n);
    const fn = async () => {};
    const off = c.events.on('account.created', fn);
    expect(entry.subscribers).toHaveLength(n + 1);
    expect(off()).toBe(true);
    expect(entry.subscribers).toHaveLength(n);
  });

  it('answers 400 for a malformed path parameter and refuses dangerous response headers', async () => {
    const bad = await get(`${BASE}/items/%E0`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
    for (const route of ['cookie', 'cors', 'html']) {
      const res = await get(`${BASE}/${route}`);
      expect(res.status, route).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.headers['set-cookie'] || [])).not.toContain('stolen');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['content-type']).toMatch(/application\/json/);
    }
  });

  it('caps the denial list, counts denials per scope and prunes the log ring per plugin', async () => {
    const c = pluginCtx();
    const scope = 'net:outbound:denied.example.org';
    for (let i = 0; i < DENIAL_RING_SIZE + 10; i++) await expect(c.net.fetch('https://denied.example.org/')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const detail = (await get(`/api/plugins/manage/${ID}`)).body.data;
    expect(detail.permissionDenials).toHaveLength(DENIAL_RING_SIZE);
    expect(detail.permissionDenials.every((d) => d.scope === scope)).toBe(true);
    expect(detail.permissionDenialCounts[scope]).toBe(DENIAL_RING_SIZE + 10);
    for (let i = 0; i < LOG_RING_SIZE + 120; i++) c.log.debug(`line ${i}`);
    // The ring prunes every 50 writes of this plugin, so at most 49 rows wait for the next prune.
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM plugin_logs WHERE plugin_id = ?').get(ID).n).toBeLessThanOrEqual(LOG_RING_SIZE + 49);
  });

  it('times out an activation that never settles: the plugin is errored, rolled back and the panel keeps serving', async () => {
    const main = `module.exports = {
  routes(r) { r.get('/ping', async (req, res) => res.json('pong')); },
  async activate(ctx) { module.exports.ctx = ctx; await new Promise(() => {}); },
};`;
    const manifest = fixtures.minimalManifest({ id: 'net.example.hang', permissions: ['api:routes', 'jobs', 'schedule'], cron: [{ name: 'tick', schedule: '*/5 * * * *', job: 'tick' }], jobs: { tick: { label: 'Tick' } } });
    const dir = writePlugin(path.join(tmp, 'hang'), manifest, { main: `${main}
module.exports.jobs = { async tick() { return null; } };` });
    expect((await post('/api/plugins/manage/install', { dir })).status).toBe(201);
    app.ctx.config.pluginActivateTimeoutMs = 200;
    try {
      const started = Date.now();
      const res = await post('/api/plugins/manage/net.example.hang/enable');
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ state: 'errored', lastError: { code: 'ACTIVATE_TIMEOUT' } });
      expect(app.ctx.db.prepare('SELECT state FROM plugins WHERE id = ?').get('net.example.hang').state).toBe('errored');
      expect(app.ctx.scheduler.listPrefix('plugin:net.example.hang:')).toEqual([]);
      expect((await get('/api/plugins/net.example.hang/ping')).status).toBe(404);
      expect((await get('/api/health')).status).toBe(200);
      const entry = app.ctx.plugins.entry('net.example.hang');
      expect(() => entry.ctx.events.on('account.created', async () => {})).toThrow(/active/);
      expect(entry.subscribers).toEqual([]);
      app.ctx.db.prepare("UPDATE plugins SET state = 'enabled' WHERE id = 'net.example.hang'").run();
      await expect(app.ctx.plugins.loadAll()).resolves.toBeInstanceOf(Array);
      expect(JSON.parse(app.ctx.db.prepare('SELECT last_error FROM plugins WHERE id = ?').get('net.example.hang').last_error).code).toBe('ACTIVATE_TIMEOUT');
      expect((await get('/api/plugins/manage')).body.data.find((p) => p.id === 'net.example.hang').state).toBe('errored');
    } finally {
      delete app.ctx.config.pluginActivateTimeoutMs;
      await del('/api/plugins/manage/net.example.hang?purge=true');
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

// Additive host edits for the marketplace client (build plan U5, §18.6).
describe('marketplace policy, developer-mode gate, bundled source and enable guards', () => {
  const kidOf = (publicKey) => crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).digest('hex').slice(0, 8);
  let hubKey;
  let otherKey;
  const SIMPLE_MAIN = "module.exports = { async activate(ctx) { ctx.log.info('up'); }, async deactivate() {} };\n";
  const manifest = (version = '1.0.0') => fixtures.minimalManifest({ id: 'net.example.policy', version });
  const packed = (m, key, kid) => packageFromFiles(key ? signFiles(packageFiles(m, SIMPLE_MAIN), key, kid) : packageFiles(m, SIMPLE_MAIN));
  const install = (buffer, options) => app.ctx.plugins.install({ buffer, source: 'marketplace' }, { user: { id: 1, username: 'root', role: 'root' }, ...options });

  beforeAll(() => {
    hubKey = crypto.generateKeyPairSync('ed25519');
    otherKey = crypto.generateKeyPairSync('ed25519');
    const keysDir = path.join(app.ctx.config.dataDir, 'plugin-keys');
    fs.mkdirSync(keysDir, { recursive: true });
    hubKey.kid = kidOf(hubKey.publicKey);
    otherKey.kid = kidOf(otherKey.publicKey);
    fs.writeFileSync(path.join(keysDir, `${hubKey.kid}.pub`), hubKey.publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(path.join(keysDir, `${otherKey.kid}.pub`), otherKey.publicKey.export({ type: 'spki', format: 'pem' }));
  });

  it('policy.requireSigned refuses unsigned and foreign-signed packages whatever plugins.require_signature says', async () => {
    expect(app.ctx.settings.get('plugins.require_signature')).toBe(false);
    const policy = { requireSigned: true, signers: [hubKey.kid], activate: false };
    await expect(install(packed(manifest()), { policy })).rejects.toMatchObject({ status: 422, code: 'unsigned_package' });
    await expect(install(packed(manifest(), otherKey.privateKey, otherKey.kid), { policy })).rejects.toMatchObject({ status: 422, code: 'untrusted_signer' });
    await expect(install(packed(manifest(), hubKey.privateKey, 'nokey'), { policy })).rejects.toMatchObject({ status: 422, code: 'untrusted_signer' });
    const ok = await install(packed(manifest(), hubKey.privateKey, hubKey.kid), { policy });
    expect(ok).toMatchObject({ wasEnabled: false, previousVersion: null, warnings: ['in-process'], plugin: { id: 'net.example.policy', state: 'installed', signed: true, signer: hubKey.kid, source: 'marketplace' } });
  });

  it('policy.expectedId refuses a package that declares another id before signature checks and the directory swap', async () => {
    const before = app.ctx.plugins.get('net.example.policy');
    expect(before).toMatchObject({ version: '1.0.0', state: 'installed' });
    const policy = { requireSigned: true, signers: [hubKey.kid], activate: false, expectedId: 'net.example.requested' };
    // Unsigned and foreign-signed copies fail on the id first: the check precedes verifySignature().
    await expect(install(packed(manifest('1.1.0')), { policy })).rejects.toMatchObject({ status: 422, code: 'plugin_id_mismatch' });
    await expect(install(packed(manifest('1.1.0'), otherKey.privateKey, otherKey.kid), { policy })).rejects.toMatchObject({ status: 422, code: 'plugin_id_mismatch' });
    await expect(install(packed(manifest('1.1.0'), hubKey.privateKey, hubKey.kid), { policy })).rejects.toMatchObject({ status: 422, code: 'plugin_id_mismatch', message: 'The package declares plugin id net.example.policy, not net.example.requested' });
    expect(app.ctx.plugins.get('net.example.policy')).toMatchObject({ version: '1.0.0', state: 'installed', signer: hubKey.kid });
    expect(() => app.ctx.plugins.get('net.example.requested')).toThrow(expect.objectContaining({ status: 404 }));
    expect(fs.readdirSync(path.join(app.ctx.config.pluginsDir, '.staging')).filter((n) => !n.endsWith('.previous'))).toEqual([]);
    const ok = await install(packed(manifest('1.0.0'), hubKey.privateKey, hubKey.kid), { policy: { ...policy, expectedId: 'net.example.policy' } });
    expect(ok.plugin).toMatchObject({ id: 'net.example.policy', version: '1.0.0' });
  });

  it('policy.activate false leaves an upgraded plugin disabled and reports wasEnabled', async () => {
    await app.ctx.plugins.enable('net.example.policy');
    expect(app.ctx.plugins.get('net.example.policy').state).toBe('enabled');
    const policy = { requireSigned: true, signers: [hubKey.kid], activate: false };
    const up = await install(packed(manifest('1.1.0'), hubKey.privateKey, hubKey.kid), { policy });
    expect(up).toMatchObject({ wasEnabled: true, previousVersion: '1.0.0', plugin: { version: '1.1.0', state: 'disabled' } });
    expect(app.ctx.plugins.isLive('net.example.policy')).toBe(false);
    expect(app.ctx.db.prepare('SELECT state FROM plugins WHERE id = ?').get('net.example.policy').state).toBe('disabled');
    await app.ctx.plugins.enable('net.example.policy');
    const again = await install(packed(manifest('1.2.0'), hubKey.privateKey, hubKey.kid), { policy: { ...policy, activate: true } });
    expect(again).toMatchObject({ wasEnabled: true, plugin: { version: '1.2.0', state: 'enabled' } });
    expect(app.ctx.plugins.isLive('net.example.policy')).toBe(true);
    await del('/api/plugins/manage/net.example.policy?purge=true');
  });

  it('gates sideloads behind plugins.developer_mode while the hub row is enabled; bundled dirs are exempt', async () => {
    await put('/api/market/providers/whm-hub/config', { url: 'https://hub.example.test/', config: {} }).expect(200);
    await post('/api/market/providers/whm-hub/enable').expect(200);
    expect(app.ctx.marketplace.status().enabled).toBe(true);
    expect(app.ctx.settings.get('plugins.developer_mode')).toBe(false);
    const m = fixtures.minimalManifest({ id: 'net.example.sideloaded' });
    const gated = await installRaw(packageFromFiles(packageFiles(m)));
    expect(gated.status).toBe(422);
    expect(gated.body.error).toMatchObject({ code: 'unsigned_package', message: 'enable plugins.developer_mode to sideload while the marketplace is enabled' });
    const unknownKid = await installRaw(packageFromFiles(signFiles(packageFiles(m), otherKey.privateKey, 'unknown')));
    expect(unknownKid.body.error.code).toBe('unsigned_package');
    // A package signed by a trusted key sideloads without developer mode and is recorded as upload.
    const signed = await installRaw(packageFromFiles(signFiles(packageFiles(m), hubKey.privateKey, hubKey.kid)));
    expect(signed.status).toBe(201);
    expect(signed.body.data.plugin).toMatchObject({ source: 'upload', signed: true, signer: hubKey.kid });
    app.ctx.settings.set('plugins.developer_mode', true);
    const allowed = await installRaw(packageFromFiles(packageFiles(m)));
    expect(allowed.status).toBe(201);
    expect(allowed.body.data).toMatchObject({ warnings: ['unsigned', 'in-process'], plugin: { source: 'upload', signed: false } });
    app.ctx.settings.set('plugins.developer_mode', false);
    // Bundled directories ship with the release: exempt from both gates even with require_signature on.
    app.ctx.settings.set('plugins.require_signature', true);
    const bundledDir = path.join(REPO_ROOT, 'plugins', 'bundled', 'net.whm.server-monitoring');
    const bundled = await post('/api/plugins/manage/install', { dir: bundledDir, source: 'bundled' });
    expect(bundled.status, JSON.stringify(bundled.body)).toBe(201);
    expect(bundled.body.data.plugin).toMatchObject({ id: 'net.whm.server-monitoring', source: 'bundled', signed: false });
    // The same claim from a directory outside plugins/bundled is recorded as `path` and gated like any sideload.
    const dir = writePlugin(path.join(tmp, 'fake-bundled'), fixtures.minimalManifest({ id: 'net.example.fakebundled' }));
    const fake = await post('/api/plugins/manage/install', { dir, source: 'bundled' });
    expect(fake.status).toBe(422);
    expect(fake.body.error.code).toBe('unsigned_package');
    app.ctx.settings.set('plugins.require_signature', false);
    app.ctx.settings.set('plugins.developer_mode', true);
    const fakeAllowed = await post('/api/plugins/manage/install', { dir, source: 'bundled' });
    expect(fakeAllowed.status).toBe(201);
    expect(fakeAllowed.body.data.plugin.source).toBe('path');
    app.ctx.settings.set('plugins.developer_mode', false);
    await post('/api/market/providers/whm-hub/disable').expect(200);
    expect((await installRaw(packageFromFiles(packageFiles(fixtures.minimalManifest({ id: 'net.example.sideloaded' }))))).status).toBe(201);
    await del('/api/plugins/manage/net.example.sideloaded?purge=true');
    await del('/api/plugins/manage/net.example.fakebundled?purge=true');
    await del('/api/plugins/manage/net.whm.server-monitoring?purge=true');
  });

  it('runs enable guards before activation and lets a thrown HttpError reach the manage route and programmatic callers', async () => {
    const m = fixtures.minimalManifest({ id: 'net.example.guarded' });
    expect((await installRaw(packageFromFiles(packageFiles(m, SIMPLE_MAIN)))).status).toBe(201);
    expect(Array.isArray(app.ctx.plugins.guards.enable)).toBe(true);
    const seen = [];
    const guard = (id, row) => { seen.push([id, row.state]); if (id === 'net.example.guarded') throw new HttpError(409, 'plugin_revoked', 'revoked by the marketplace'); };
    app.ctx.plugins.guards.enable.push(guard);
    try {
      const res = await post('/api/plugins/manage/net.example.guarded/enable');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('plugin_revoked');
      await expect(app.ctx.plugins.enable('net.example.guarded')).rejects.toMatchObject({ code: 'plugin_revoked' });
      expect(app.ctx.plugins.isLive('net.example.guarded')).toBe(false);
      expect(app.ctx.plugins.get('net.example.guarded').state).toBe('installed');
      expect(seen).toEqual([['net.example.guarded', 'installed'], ['net.example.guarded', 'installed']]);
    } finally {
      app.ctx.plugins.guards.enable.splice(app.ctx.plugins.guards.enable.indexOf(guard), 1);
    }
    expect((await post('/api/plugins/manage/net.example.guarded/enable')).status).toBe(200);
    await del('/api/plugins/manage/net.example.guarded?purge=true');
  });
});
