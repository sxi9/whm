import zlib from 'node:zlib';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { collectRoutes, buildOpenApi, createTarGz, parseAppConfig, renderAppConfig, indexSections, extractSection, mountPathOf, utcStamp, PanelEvents } from '../src/services/development.js';

let app;
let csrf;
let reseller;
let resellerCsrf;
let resellerUser;
const hookRuns = [];
let scripts = [
  { name: 'notify', path: '/usr/local/whm/hooks/notify', exists: true, size: 120, mode: '0700', uid: 0, mtime: '2026-10-25T00:00:00.000Z', runnable: true, problems: [] },
  { name: 'fail-hook', path: '/usr/local/whm/hooks/fail-hook', exists: true, size: 80, mode: '0700', uid: 0, mtime: '2026-10-25T00:00:00.000Z', runnable: true, problems: [] },
  { name: 'loose', path: '/usr/local/whm/hooks/loose', exists: true, size: 10, mode: '0777', uid: 1000, mtime: '2026-10-25T00:00:00.000Z', runnable: false, problems: ['is owned by uid 1000, not root', 'is writable by group or others (mode 0777)'] },
];
let hooksDirExists = true;

const mutate = (client, method, url, body, token) => client[method](url).set('X-CSRF-Token', token).send(body);
const post = (url, body = {}) => mutate(app.http, 'post', url, body, csrf);
const put = (url, body = {}) => mutate(app.http, 'put', url, body, csrf);
const patch = (url, body = {}) => mutate(app.http, 'patch', url, body, csrf);
const del = (url) => mutate(app.http, 'delete', url, undefined, csrf);
const get = (url) => app.http.get(url);

beforeAll(async () => {
  const agent = createMockAgent({
    'hook.list': () => ({ dir: '/usr/local/whm/hooks', exists: hooksDirExists, scripts: hooksDirExists ? scripts : [] }),
    'hook.run': ({ name, event, stage, payload }) => {
      hookRuns.push({ name, event, stage, payload: JSON.parse(payload) });
      if (name === 'fail-hook') return { name, event, stage, exitCode: 2, ok: false, durationMs: 5, stdout: '', stderr: 'quota exceeded for this reseller\n' };
      return { name, event, stage, exitCode: 0, ok: true, durationMs: 3, stdout: `handled ${event}\n`, stderr: '' };
    },
    'fs.read_file': ({ path }) => ({ path, content: '#!/bin/sh\ncat >/dev/null\nexit 0\n', size: 30 }),
    'fs.write_file': ({ path, content }) => ({ path, bytes: Buffer.byteLength(content) }),
    'fs.remove': ({ path }) => ({ path }),
    'fs.mkdir': ({ path }) => ({ path }),
  });
  app = await createTestApp({ agent });
  app.ctx.jobs.start();
  csrf = await app.login();
  resellerUser = await app.createUser('devresell', 'reseller');
  reseller = request.agent(app.ctx.app);
  resellerCsrf = (await reseller.post('/api/auth/login').send({ username: resellerUser.username, password: resellerUser.password })).body.data.csrfToken;
}, 30_000);

afterAll(async () => { await app?.close(); });

describe('pure helpers', () => {
  it('canonicalises token expiry stamps as UTC with a Z suffix', () => {
    expect(utcStamp('2026-10-25 23:40:00')).toBe('2026-10-25T23:40:00Z');
    expect(utcStamp('2026-10-25T23:40:00.123Z')).toBe('2026-10-25T23:40:00Z');
    expect(utcStamp('2026-10-26T01:40:00+02:00')).toBe('2026-10-25T23:40:00Z');
    expect(utcStamp(Date.UTC(2030, 0, 1))).toBe('2030-01-01T00:00:00Z');
    expect(() => utcStamp('not a date')).toThrow(/validation/);
  });

  it('recovers mount paths from Express layer regexps', () => {
    expect(mountPathOf({ regexp: /^\/api\/?(?=\/|$)/i })).toBe('/api');
    expect(mountPathOf({ regexp: /^\/dns\/?(?=\/|$)/i })).toBe('/dns');
    expect(mountPathOf({ regexp: Object.assign(/^\/?$/i, { fast_slash: true }) })).toBe('');
    expect(mountPathOf({ regexp: /^\/plugins\/(?:([^\/]+?))\/?(?=\/|$)/i, keys: [{ name: 'id' }] })).toBe('/plugins/:id');
  });

  it('builds an OpenAPI 3 document with roles, params and security', () => {
    const spec = buildOpenApi([
      { method: 'GET', path: '/api/accounts', role: 'reseller', auth: true },
      { method: 'POST', path: '/api/accounts/:username/suspend', role: 'reseller', auth: true },
      { method: 'POST', path: '/api/auth/login', role: 'any', auth: false },
    ], { title: 'T', version: '1.0.0', scope: 'whm', hostname: 'h' });
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.paths['/accounts/{username}/suspend'].post.parameters[0]).toMatchObject({ name: 'username', in: 'path', required: true });
    expect(spec.paths['/accounts/{username}/suspend'].post['x-whm-role']).toBe('reseller');
    expect(spec.paths['/accounts/{username}/suspend'].post.security).toBeDefined();
    expect(spec.paths['/auth/login'].post.security).toBeUndefined();
    expect(spec.paths['/accounts'].get.parameters.map((p) => p.name)).toContain('page');
    expect(spec.tags.map((t) => t.name)).toEqual(['accounts', 'auth']);
    expect(spec.components.securitySchemes.bearerToken.scheme).toBe('bearer');
  });

  it('writes a gzip tar that round-trips', () => {
    const tgz = createTarGz([{ path: 'x/plugin.json', content: '{"a":1}' }, { path: 'x/lib/deep/file.js', content: 'ok' }]);
    const raw = zlib.gunzipSync(tgz);
    expect(raw.length % 512).toBe(0);
    expect(raw.subarray(0, 100).toString().replace(/\0+$/, '')).toBe('x/');
    expect(raw.subarray(257, 262).toString()).toBe('ustar');
    expect(raw.toString('latin1')).toContain('{"a":1}');
    expect(raw.toString('latin1')).toContain('x/lib/deep/file.js');
  });

  it('parses and renders cPanel-style AppConfig files', () => {
    const parsed = parseAppConfig('# comment\nname=Billing\nservice=whm\nurl=/cgi/billing/index.cgi\ndisplayname=Billing Portal\nacls=list-accts,create-acct\nfeatures=ssl\n');
    expect(parsed).toMatchObject({ name: 'billing', service: 'whm', url: '/cgi/billing/index.cgi', displayName: 'Billing Portal', acls: ['list-accts', 'create-acct'], features: ['ssl'] });
    const text = renderAppConfig({ name: 'billing', service: 'whm', url: '/x', displayName: 'B', acls: ['all'], features: [], icon: null, description: 'desc' });
    expect(text).toContain('name=billing\nservice=whm\nurl=/x\ndisplayname=B\nacls=all\ndescription=desc\n');
  });

  it('indexes markdown sections and extracts one', () => {
    const md = '# Title\n\n## 1. One\ntext\n```\n## not a heading\n```\n### Sub\nmore\n## 2. Two\nlast\n';
    expect(indexSections(md).map((s) => s.slug)).toEqual(['1-one', 'sub', '2-two']);
    expect(extractSection(md, '1-one')).toBe('## 1. One\ntext\n```\n## not a heading\n```\n### Sub\nmore\n');
    expect(extractSection(md, '2-two')).toBe('## 2. Two\nlast\n');
    expect(extractSection(md, 'nope')).toBeNull();
  });

  it('PanelEvents awaits listeners and lets a pre listener veto', async () => {
    const bus = new PanelEvents();
    const seen = [];
    bus.on('x.y', async (e) => { seen.push(e.stage); });
    bus.onAny(async (e) => { seen.push(`any:${e.event}`); if (e.stage === 'pre' && e.payload.block) throw new Error('vetoed'); });
    const res = await bus.emit('x.y', { a: 1 });
    expect(res.listeners).toBe(2);
    expect(seen).toEqual(['post', 'any:x.y']);
    await expect(bus.emit('x.y', { block: true }, { stage: 'pre' })).rejects.toThrow('vetoed');
    await expect(bus.emit('Bad Event', {})).rejects.toThrow(/Invalid event name/);
    expect(bus.recent[0]).toMatchObject({ event: 'x.y', stage: 'post' });
  });
});

describe('module registration and RBAC', () => {
  it('attaches ctx.development, the event bus, job and schedule', () => {
    expect(typeof app.ctx.development.tokens.create).toBe('function');
    expect(typeof app.ctx.development.appconfig.listFor).toBe('function');
    expect(typeof app.ctx.development.openapi.collect).toBe('function');
    expect(app.ctx.events).toBeInstanceOf(PanelEvents);
    expect(typeof app.ctx.events.on).toBe('function');
    expect(typeof app.ctx.events.emit).toBe('function');
    expect(app.ctx.jobs.types()).toContain('development.maintenance');
    expect(app.ctx.scheduler.list().find((s) => s.name === 'development-maintenance')?.cron).toBe('23 3 * * *');
  });

  it('root-only functions refuse resellers', async () => {
    for (const url of ['/api/development/overview', '/api/development/hooks', '/api/development/hooks/events', '/api/development/hooks/scripts', '/api/development/hooks/runs', '/api/development/appconfig', '/api/development/appconfig/acls', '/api/development/plugin-generator/vocabulary']) {
      expect((await reseller.get(url)).status, url).toBe(403);
    }
    expect((await mutate(reseller, 'post', '/api/development/hooks', { event: 'account.created', script: 'notify' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/development/appconfig', { name: 'x', url: '/x' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/development/plugin-generator/generate', {}, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/development/hooks/emit', { event: 'account.created' }, resellerCsrf)).status).toBe(403);
  });

  it('documentation and the API reference are readable by resellers', async () => {
    expect((await reseller.get('/api/development/docs')).status).toBe(200);
    expect((await reseller.get('/api/development/openapi/endpoints?scope=cpanel')).status).toBe(200);
    expect((await reseller.get('/api/development/tokens/scopes')).status).toBe(200);
  });
});

describe('Manage API Tokens', () => {
  let tokenId;
  let secret;

  it('rejects malformed input with 422', async () => {
    for (const body of [{}, { name: 'a;b' }, { name: 'ok', scopes: ['accounts'] }, { name: 'ok', scopes: ['-r'] }, { name: 'ok', scopes: ['accounts:read'] }, { name: 'ok', scopes: ['dns:write'] }, { name: 'ok', expiresInDays: 0 }, { name: 'ok', expiresInDays: 5, expiresAt: '2030-01-01T00:00:00Z' }, { name: 'ok', username: '../root' }, { name: 'ok', extra: 1 }]) {
      expect((await post('/api/development/tokens', body)).status, JSON.stringify(body)).toBe(422);
    }
    // The service rejects unenforced scopes too, so programmatic callers cannot bypass the route schema.
    await expect(app.ctx.development.tokens.create({ name: 'svc', scopes: ['accounts:read'] }, { id: 1, username: 'root', role: 'root' })).rejects.toMatchObject({ status: 422 });
    expect((await get('/api/development/tokens/abc')).status).toBe(422);
    expect((await patch('/api/development/tokens/1', { name: 'x\ny' })).status).toBe(422);
  });

  it('creates a token shown once, lists it and reports usage', async () => {
    const res = await post('/api/development/tokens', { name: 'Billing sync', scopes: ['development:read'], expiresInDays: 30, description: 'read-only' });
    expect(res.status).toBe(201);
    expect(res.body.data.token).toMatch(/^whm_[A-Za-z0-9_-]{40,}$/);
    expect(res.body.data).toMatchObject({ name: 'Billing sync', username: 'root', scopes: ['development:read'], expired: false, prefix: res.body.data.token.slice(0, 12) });
    expect(res.body.data.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(app.ctx.db.prepare('SELECT expires_at FROM api_tokens WHERE id = ?').get(res.body.data.id).expires_at).toBe(res.body.data.expiresAt);
    tokenId = res.body.data.id;
    secret = res.body.data.token;
    const stored = app.ctx.db.prepare('SELECT token_hash FROM api_tokens WHERE id = ?').get(tokenId);
    expect(stored.token_hash).toBe(app.ctx.crypto.hashToken(secret));
    expect(stored.token_hash).not.toContain(secret.slice(4, 20));
    const list = await get('/api/development/tokens?q=Billing');
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0].token).toBeUndefined();
    const one = await get(`/api/development/tokens/${tokenId}`);
    expect(one.body.data.name).toBe('Billing sync');
    const usage = await get(`/api/development/tokens/${tokenId}/usage`);
    expect(usage.body.data.token.id).toBe(tokenId);
    expect(Array.isArray(usage.body.data.activity)).toBe(true);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'development.token.create'").get().n).toBe(1);
    const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'POST /api/development/tokens' ORDER BY id DESC LIMIT 1").get();
    expect(audit.args_redacted).not.toContain(secret);
  });

  it('authenticates Bearer requests and enforces the token scopes', async () => {
    const bare = request(app.ctx.app);
    const ok = await bare.get('/api/development/tokens').set('Authorization', `Bearer ${secret}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.find((t) => t.id === tokenId).lastUsedAt).toBeTruthy();
    const scoped = await bare.post('/api/development/tokens').set('Authorization', `Bearer ${secret}`).send({ name: 'escalate' });
    expect(scoped.status).toBe(403);
    expect(scoped.body.error.message).toMatch(/development:write/);
    expect((await bare.get('/api/development/tokens').set('Authorization', 'Bearer whm_nope')).status).toBe(401);
  });

  it('only advertises scopes that are actually enforced', async () => {
    const res = await get('/api/development/tokens/scopes');
    expect(res.status).toBe(200);
    expect(res.body.data.scopes).toEqual(['*', 'development:read', 'development:write']);
    expect(res.body.data.unrestrictedAreas).toContain('accounts');
    expect(res.body.data.note).toMatch(/full role/);
  });

  it('a token can only mint tokens within its own scopes, for itself and expiring no later', async () => {
    const bare = request(app.ctx.app);
    const viaToken = (body, secretToUse) => bare.post('/api/development/tokens').set('Authorization', `Bearer ${secretToUse}`).send(body);
    const narrow = await post('/api/development/tokens', { name: 'narrow', scopes: ['development:write'], expiresInDays: 2 });
    const narrowSecret = narrow.body.data.token;
    const narrowExpiry = narrow.body.data.expiresAt;
    const escalate = await viaToken({ name: 'child star', scopes: ['*'] }, narrowSecret);
    expect(escalate.status).toBe(403);
    expect(escalate.body.error.message).toMatch(/unrestricted/);
    expect((await viaToken({ name: 'child inherit' }, narrowSecret)).status).toBe(403);
    const widen = await viaToken({ name: 'child read', scopes: ['development:read'] }, narrowSecret);
    expect(widen.status).toBe(403);
    expect(widen.body.error.message).toMatch(/development:read/);
    expect((await viaToken({ name: 'child other user', scopes: ['development:write'], username: 'devresell' }, narrowSecret)).status).toBe(403);
    const capped = await viaToken({ name: 'child capped', scopes: ['development:write'], expiresInDays: 365 }, narrowSecret);
    expect(capped.status).toBe(201);
    expect(capped.body.data).toMatchObject({ scopes: ['development:write'], username: 'root', expiresAt: narrowExpiry });
    const inherit = await viaToken({ name: 'child never', scopes: ['development:write'] }, narrowSecret);
    expect(inherit.status).toBe(201);
    expect(inherit.body.data.expiresAt).toBe(narrowExpiry);
    expect(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'development.token.create' ORDER BY id DESC LIMIT 1").get().args_redacted).toContain(`"issuedBy":"api-token#${narrow.body.data.id}"`);
    // Unrestricted issuers (a "*" token, or a session) may still mint anything.
    const star = await post('/api/development/tokens', { name: 'automation', scopes: ['*'] });
    const child = await viaToken({ name: 'child token', scopes: ['*'] }, star.body.data.token);
    expect(child.status).toBe(201);
    expect(child.body.data.expiresAt).toBeNull();
    for (const id of [capped.body.data.id, inherit.body.data.id, child.body.data.id, star.body.data.id, narrow.body.data.id]) await del(`/api/development/tokens/${id}`);
  });

  it('renames, expires and revokes; resellers only touch their own', async () => {
    expect((await patch(`/api/development/tokens/${tokenId}`, { name: 'Billing sync v2' })).body.data.name).toBe('Billing sync v2');
    const mine = await mutate(reseller, 'post', '/api/development/tokens', { name: 'reseller token' }, resellerCsrf);
    expect(mine.status).toBe(201);
    expect(mine.body.data.username).toBe('devresell');
    expect((await mutate(reseller, 'post', '/api/development/tokens', { name: 'for root', username: 'root' }, resellerCsrf)).status).toBe(403);
    expect((await reseller.get(`/api/development/tokens/${tokenId}`)).status).toBe(403);
    expect((await mutate(reseller, 'delete', `/api/development/tokens/${tokenId}`, undefined, resellerCsrf)).status).toBe(403);
    const listed = await reseller.get('/api/development/tokens');
    expect(listed.body.data.map((t) => t.username)).toEqual(['devresell']);
    const rootSees = await get('/api/development/tokens?user=devresell');
    expect(rootSees.body.data).toHaveLength(1);
    const forOther = await post('/api/development/tokens', { name: 'issued by root', username: 'devresell', expiresInDays: 1 });
    expect(forOther.status).toBe(201);
    expect(forOther.body.data.username).toBe('devresell');
    const expired = await post(`/api/development/tokens/${forOther.body.data.id}/expire`);
    expect(expired.status).toBe(200);
    expect((await request(app.ctx.app).get('/api/development/tokens').set('Authorization', `Bearer ${forOther.body.data.token}`)).status).toBe(401);
    const revoked = await del(`/api/development/tokens/${tokenId}`);
    expect(revoked.body.data).toMatchObject({ revoked: true });
    expect((await request(app.ctx.app).get('/api/development/tokens').set('Authorization', `Bearer ${secret}`)).status).toBe(401);
    expect((await get(`/api/development/tokens/${tokenId}`)).status).toBe(404);
    expect((await mutate(reseller, 'delete', `/api/development/tokens/${mine.body.data.id}`, undefined, resellerCsrf)).status).toBe(200);
    await del(`/api/development/tokens/${forOther.body.data.id}`);
    expect((await post('/api/development/tokens', { name: 'nobody', username: 'ghost' })).status).toBe(404);
  });

  it('expiry takes effect at the same instant on a non-UTC host', async () => {
    const bare = request(app.ctx.app);
    const previousTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // The hazard this guards against: a zone-less stamp is parsed as local time.
      expect(new Date('2026-10-25 23:40:00').toISOString()).not.toBe('2026-10-25T23:40:00.000Z');
      const t = await post('/api/development/tokens', { name: 'tz sensitive', scopes: ['development:read'], expiresInDays: 1 });
      expect(t.status).toBe(201);
      expect((await bare.get('/api/development/tokens').set('Authorization', `Bearer ${t.body.data.token}`)).status).toBe(200);
      const stored = app.ctx.db.prepare('SELECT expires_at FROM api_tokens WHERE id = ?').get(t.body.data.id).expires_at;
      expect(stored).toMatch(/Z$/);
      expect(Math.abs(new Date(stored).getTime() - (Date.now() + 86_400_000))).toBeLessThan(5_000);
      const expired = await post(`/api/development/tokens/${t.body.data.id}/expire`);
      expect(expired.status).toBe(200);
      expect(expired.body.data.expired).toBe(true);
      expect(expired.body.data.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect((await bare.get('/api/development/tokens').set('Authorization', `Bearer ${t.body.data.token}`)).status).toBe(401);
      // A token that expired a few seconds ago (UTC) is also rejected, whatever the host zone.
      const recent = await post('/api/development/tokens', { name: 'just expired', expiresAt: new Date(Date.now() - 5_000).toISOString() });
      expect(recent.status).toBe(201);
      expect(recent.body.data.expired).toBe(true);
      expect((await bare.get('/api/development/tokens').set('Authorization', `Bearer ${recent.body.data.token}`)).status).toBe(401);
      // One that expires soon still works and is counted as active.
      const soon = await post('/api/development/tokens', { name: 'expires soon', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect((await bare.get('/api/development/tokens').set('Authorization', `Bearer ${soon.body.data.token}`)).status).toBe(200);
      const overview = await get('/api/development/overview');
      expect(overview.body.data.tokens.expired).toBeGreaterThanOrEqual(2);
      // Legacy zone-less rows (pre-migration format) are still read as UTC.
      app.ctx.db.prepare("UPDATE api_tokens SET expires_at = strftime('%Y-%m-%d %H:%M:%S', 'now', '-10 seconds') WHERE id = ?").run(soon.body.data.id);
      expect((await get(`/api/development/tokens/${soon.body.data.id}`)).body.data.expired).toBe(true);
      for (const id of [t.body.data.id, recent.body.data.id, soon.body.data.id]) await del(`/api/development/tokens/${id}`);
    } finally {
      if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
    }
  });

  it('the maintenance job removes long-expired tokens', async () => {
    const t = await post('/api/development/tokens', { name: 'ancient' });
    app.ctx.db.prepare("UPDATE api_tokens SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-60 days') WHERE id = ?").run(t.body.data.id);
    const job = await waitForJob(app.ctx, app.ctx.jobs.enqueue('development.maintenance', {}).id);
    expect(job.status).toBe('done');
    expect(job.result.removedExpired).toBeGreaterThanOrEqual(1);
    expect((await get(`/api/development/tokens/${t.body.data.id}`)).status).toBe(404);
  });
});

describe('Manage Hooks', () => {
  let hookId;
  let failId;

  it('lists the event catalog from the plugin SDK', async () => {
    const res = await get('/api/development/hooks/events');
    expect(res.status).toBe(200);
    const created = res.body.data.find((e) => e.name === 'account.created');
    expect(created).toMatchObject({ stages: ['pre', 'post'], cancellable: true });
    expect(res.body.data.find((e) => e.name === 'login.failed').stages).toEqual(['post']);
  });

  it('rejects injection, unknown stages and impossible event/stage pairs', async () => {
    app.agent.calls.length = 0;
    for (const body of [{ event: 'account.created', script: '-rf' }, { event: 'account.created', script: 'a;b' }, { event: 'account.created', script: '../etc/passwd' }, { event: 'account.created', script: 'a/b' }, { event: 'Account.Created', script: 'ok' }, { event: 'account.created', script: 'ok', stage: 'during' }, { event: 'account.created', script: 'ok', timeoutSec: 0 }, { event: 'account.created', script: 'ok', extra: 1 }]) {
      expect((await post('/api/development/hooks', body)).status, JSON.stringify(body)).toBe(422);
    }
    const badStage = await post('/api/development/hooks', { event: 'login.failed', stage: 'pre', script: 'notify' });
    expect(badStage.status).toBe(422);
    expect(badStage.body.error.fields.stage[0]).toMatch(/only fires at: post/);
    expect((await get('/api/development/hooks/scripts/..%2Fetc')).status).toBe(422);
    expect((await put('/api/development/hooks/scripts/notify', { content: 'echo no shebang' })).status).toBe(422);
    expect((await post('/api/development/hooks/emit', { event: 'login.failed', stage: 'pre' })).status).toBe(422);
    expect((await put('/api/development/hooks/settings', { defaultTimeoutSec: 10000 })).status).toBe(422);
    expect(app.agent.calls.filter((c) => c.name.startsWith('hook.') || c.name.startsWith('fs.'))).toHaveLength(0);
  });

  it('creates, updates, toggles and tests a hook', async () => {
    const res = await post('/api/development/hooks', { name: 'Notify billing', event: 'account.created', stage: 'post', script: 'notify', description: 'posts to billing' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Notify billing', event: 'account.created', stage: 'post', script: 'notify', enabled: true, blocking: true, timeoutSec: 30, known: true, cancellable: false });
    hookId = res.body.data.id;
    expect((await get('/api/development/hooks')).body.data.map((h) => h.id)).toContain(hookId);
    const upd = await put(`/api/development/hooks/${hookId}`, { timeoutSec: 60, blocking: false });
    expect(upd.body.data).toMatchObject({ timeoutSec: 60, blocking: false });
    expect((await put(`/api/development/hooks/${hookId}`, { event: 'login.failed', stage: 'pre' })).status).toBe(422);
    const off = await patch(`/api/development/hooks/${hookId}`, { enabled: false });
    expect(off.body.data.enabled).toBe(false);
    expect((await patch(`/api/development/hooks/${hookId}`, { enabled: true })).body.data.enabled).toBe(true);
    hookRuns.length = 0;
    const test = await post(`/api/development/hooks/${hookId}/test`, { payload: { username: 'demo' } });
    expect(test.status).toBe(200);
    expect(test.body.data).toMatchObject({ script: 'notify', status: 'ok', exitCode: 0 });
    expect(hookRuns[0]).toMatchObject({ name: 'notify', event: 'account.created', stage: 'post' });
    expect(hookRuns[0].payload).toMatchObject({ event: 'account.created', test: true, payload: { username: 'demo' }, principal: 'root' });
    expect(app.agent.callsTo('hook.run').pop().args.timeoutMs).toBe(60_000);
    const after = await get(`/api/development/hooks/${hookId}`);
    expect(after.body.data).toMatchObject({ runCount: 1, failCount: 0, lastStatus: 'ok' });
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'development.hook.create'").get().n).toBe(1);
  });

  it('fires for real account operations through ctx.events and a blocking pre hook vetoes', async () => {
    const fail = await post('/api/development/hooks', { name: 'Quota gate', event: 'account.created', stage: 'pre', script: 'fail-hook', blocking: true });
    failId = fail.body.data.id;
    hookRuns.length = 0;
    const blocked = await post('/api/accounts', { username: 'hooked', domain: 'hooked.com' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('hook_rejected');
    expect(blocked.body.error.message).toMatch(/Quota gate.*quota exceeded/);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE username = ?').get('hooked').n).toBe(0);
    expect(hookRuns).toHaveLength(1);
    expect(hookRuns[0]).toMatchObject({ name: 'fail-hook', stage: 'pre' });
    expect(hookRuns[0].payload.payload).toMatchObject({ username: 'hooked', domain: 'hooked.com', owner: 'root' });
    await patch(`/api/development/hooks/${failId}`, { enabled: false });
    hookRuns.length = 0;
    const ok = await post('/api/accounts', { username: 'hooked', domain: 'hooked.com' });
    expect(ok.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(hookRuns.map((h) => `${h.name}:${h.stage}`)).toEqual(['notify:post']);
    expect(hookRuns[0].payload.principal).toBe('root');
    const runs = await get('/api/development/hooks/runs?event=account.created');
    expect(runs.body.meta.total).toBeGreaterThanOrEqual(3);
    expect(runs.body.data[0]).toMatchObject({ event: 'account.created', trigger: 'event' });
    const failedRuns = await get('/api/development/hooks/runs?status=failed');
    expect(failedRuns.body.data[0]).toMatchObject({ hookName: 'Quota gate', exitCode: 2 });
    const recent = await get('/api/development/hooks/recent-events');
    expect(recent.body.data.find((e) => e.event === 'account.created')).toMatchObject({ event: 'account.created', stage: 'post' });
    // Non-blocking pre hooks and hooks that cannot run never veto.
    await put(`/api/development/hooks/${failId}`, { enabled: true, blocking: false });
    expect((await post('/api/accounts', { username: 'hooked2', domain: 'hooked2.com' })).status).toBe(201);
    await put(`/api/development/hooks/${failId}`, { script: 'missing-script', blocking: true });
    app.agent.fail('hook.run', 'not_found', 'Hook "missing-script" is not installed');
    expect((await post('/api/accounts', { username: 'hooked3', domain: 'hooked3.com' })).status).toBe(201);
    expect((await get(`/api/development/hooks/${failId}`)).body.data.lastStatus).toBe('error');
    app.agent.reset('hook.run');
    app.agent.set('hook.run', ({ name, event, stage, payload }) => { hookRuns.push({ name, event, stage, payload: JSON.parse(payload) }); return { name, event, stage, exitCode: 0, ok: true, durationMs: 1, stdout: '', stderr: '' }; });
    await del(`/api/development/hooks/${failId}`);
  });

  it('login and service events reach the bus; emit lets root fire any event', async () => {
    const seen = [];
    const off = app.ctx.events.on('login.failed', (e) => { seen.push(e); });
    await request(app.ctx.app).post('/api/auth/login').send({ username: 'root', password: 'wrong-password-1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen[0].payload).toMatchObject({ username: 'root' });
    off();
    const emitted = await post('/api/development/hooks/emit', { event: 'backup.completed', payload: { jobId: 1 } });
    expect(emitted.status).toBe(200);
    expect(emitted.body.data).toMatchObject({ event: 'backup.completed', stage: 'post' });
    expect(emitted.body.data.listeners).toBeGreaterThanOrEqual(1);
    const settings = await put('/api/development/hooks/settings', { enabled: false });
    expect(settings.body.data.enabled).toBe(false);
    hookRuns.length = 0;
    await post('/api/development/hooks/emit', { event: 'account.created', stage: 'post', payload: {} });
    expect(hookRuns).toHaveLength(0);
    await put('/api/development/hooks/settings', { enabled: true, defaultTimeoutSec: 45 });
    expect((await get('/api/development/hooks/settings')).body.data).toMatchObject({ enabled: true, defaultTimeoutSec: 45, dir: '/usr/local/whm/hooks' });
  });

  it('manages hook scripts through the agent', async () => {
    const list = await get('/api/development/hooks/scripts');
    expect(list.status).toBe(200);
    expect(list.body.data.exists).toBe(true);
    expect(list.body.data.scripts.find((s) => s.name === 'notify')).toMatchObject({ runnable: true, hooks: 1 });
    expect(list.body.data.scripts.find((s) => s.name === 'loose').runnable).toBe(false);
    const read = await get('/api/development/hooks/scripts/notify');
    expect(read.body.data.content).toContain('#!/bin/sh');
    const write = await put('/api/development/hooks/scripts/new-hook', { content: '#!/bin/sh\nexit 0\n' });
    expect(write.status).toBe(200);
    expect(app.agent.callsTo('fs.write_file').pop().args).toMatchObject({ path: '/usr/local/whm/hooks/new-hook', owner: 'root', mode: '0700' });
    const removed = await del('/api/development/hooks/scripts/new-hook');
    expect(removed.body.data).toMatchObject({ deleted: true, hooksReferencing: 0 });
    hooksDirExists = false;
    expect((await get('/api/development/hooks/scripts')).body.data.exists).toBe(false);
    const init = await post('/api/development/hooks/scripts/init');
    expect(init.status).toBe(200);
    expect(app.agent.callsTo('fs.mkdir').pop().args).toMatchObject({ path: '/usr/local/whm/hooks', mode: '0755' });
    hooksDirExists = true;
  });

  it('degrades to capability_missing when the agent lacks the hook ops', async () => {
    app.agent.fail('hook.list', 'unknown_op', 'Operation "hook.list" is not in the agent catalog');
    app.agent.fail('hook.run', 'unknown_op', 'Operation "hook.run" is not in the agent catalog');
    const list = await get('/api/development/hooks/scripts');
    expect(list.status).toBe(501);
    expect(list.body.error.code).toBe('capability_missing');
    expect(list.body.error.capability).toBe('whm-agentd');
    const test = await post(`/api/development/hooks/${hookId}/test`, {});
    expect(test.status).toBe(501);
    const overview = await get('/api/development/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.data.hooks.scripts.code).toBe('capability_missing');
    // Operations still succeed; the hook is recorded as an error instead of blocking.
    expect((await post('/api/accounts', { username: 'hooked4', domain: 'hooked4.com' })).status).toBe(201);
    app.agent.reset('hook.list');
    app.agent.reset('hook.run');
    app.agent.set('hook.list', () => ({ dir: '/usr/local/whm/hooks', exists: true, scripts }));
    app.agent.set('hook.run', ({ name, event, stage }) => ({ name, event, stage, exitCode: 0, ok: true, durationMs: 1, stdout: '', stderr: '' }));
    expect((await del(`/api/development/hooks/${hookId}`)).body.data.deleted).toBe(true);
    expect((await get(`/api/development/hooks/${hookId}`)).status).toBe(404);
  });
});

describe('Apps Managed by AppConfig', () => {
  let appId;

  it('validates registrations', async () => {
    for (const body of [{}, { name: 'Bad Name', url: '/x' }, { name: 'ok', url: 'javascript:alert(1)' }, { name: 'ok', url: 'ftp://x' }, { name: 'ok', url: '/x', service: 'ftp' }, { name: 'ok', url: '/x', acls: ['List Accts'] }, { name: 'ok', url: '/x', icon: 'Bad Icon' }, { name: 'ok', url: '/x', extra: 1 }]) {
      expect((await post('/api/development/appconfig', body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it('registers, updates, exports and unregisters apps', async () => {
    const res = await post('/api/development/appconfig', { name: 'billing_portal', displayName: 'Billing Portal', url: 'https://billing.example.com/whm?user={user}', service: 'whm', acls: ['list-accts', 'create-acct'], description: 'Opens the billing system' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'billing_portal', displayName: 'Billing Portal', service: 'whm', acls: ['list-accts', 'create-acct'], enabled: true, display: true });
    appId = res.body.data.id;
    expect((await post('/api/development/appconfig', { name: 'billing_portal', url: '/dup' })).status).toBe(409);
    const upd = await put(`/api/development/appconfig/${appId}`, { acls: ['all'], icon: 'credit-card' });
    expect(upd.body.data).toMatchObject({ acls: ['all'], icon: 'credit-card' });
    expect((await get('/api/development/appconfig')).body.data).toHaveLength(1);
    const exported = await get(`/api/development/appconfig/${appId}/export`);
    expect(exported.body.data.filename).toBe('billing_portal.conf');
    expect(exported.body.data.content).toContain('name=billing_portal');
    const parsed = await post('/api/development/appconfig/parse', { text: exported.body.data.content });
    expect(parsed.body.data).toMatchObject({ name: 'billing_portal', service: 'whm', acls: ['all'] });
    expect((await get('/api/development/appconfig/acls')).body.data).toContain('list-accts');
    expect((await get('/api/development/appconfig/999')).status).toBe(404);
  });

  it('shows resellers only the apps their ACLs permit', async () => {
    await post('/api/development/appconfig', { name: 'root_tool', url: '/cgi/root', service: 'whm', acls: ['restart'] });
    await post('/api/development/appconfig', { name: 'cp_widget', url: '/cp/widget', service: 'cpanel', acls: ['all'] });
    await post('/api/development/appconfig', { name: 'hidden_app', url: '/hidden', service: 'whm', acls: ['all'], display: false });
    const rootSees = await get('/api/development/appconfig/launch');
    expect(rootSees.body.data.map((a) => a.name).sort()).toEqual(['billing_portal', 'cp_widget', 'root_tool']);
    const resellerSees = await reseller.get('/api/development/appconfig/launch');
    expect(resellerSees.status).toBe(200);
    expect(resellerSees.body.data.map((a) => a.name).sort()).toEqual(['billing_portal', 'cp_widget']);
    app.ctx.db.prepare('INSERT INTO reseller_acls (reseller_id, acl_key, value) VALUES (?, ?, 1)').run(resellerUser.id, 'restart');
    expect((await reseller.get('/api/development/appconfig/launch?service=whm')).body.data.map((a) => a.name).sort()).toEqual(['billing_portal', 'root_tool']);
    expect(app.ctx.development.appconfig.listFor({ id: 0, role: 'user' }, 'cpanel').map((a) => a.name)).toEqual(['cp_widget']);
    const removed = await del(`/api/development/appconfig/${appId}`);
    expect(removed.body.data.deleted).toBe(true);
    expect((await get(`/api/development/appconfig/${appId}`)).status).toBe(404);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'development.appconfig.%'").get().n).toBeGreaterThanOrEqual(6);
  });
});

describe('cPanel Plugin File Generator', () => {
  const input = { id: 'com.example.hello', name: 'Hello Plugin', description: 'Says hello from the sidebar', authorName: 'Dev Team', authorEmail: 'dev@example.com', permissions: ['accounts:read'], hooks: [{ event: 'account.created', stage: 'post' }, { event: 'account.suspended', stage: 'pre' }], withSettings: true, withJob: true, withPage: true };

  it('exposes the SDK vocabulary', async () => {
    const res = await get('/api/development/plugin-generator/vocabulary');
    expect(res.status).toBe(200);
    expect(res.body.data.categories).toContain('Development');
    expect(res.body.data.permissions.find((p) => p.scope === 'accounts:read')).toBeTruthy();
    expect(res.body.data.events.find((e) => e.name === 'account.created').cancellable).toBe(true);
    expect(res.body.data.sdkVersion).toBe('1.0.0');
  });

  it('validates input and previews a manifest the SDK accepts', async () => {
    for (const body of [{ ...input, id: 'hello' }, { ...input, id: 'com.example.Hello' }, { ...input, version: 'v1' }, { ...input, permissions: ['rm -rf /'] }, { ...input, hooks: [{ event: 'x' }] }, { ...input, authorEmail: 'nope' }, {}]) {
      expect((await post('/api/development/plugin-generator/preview', body)).status, JSON.stringify(body)).toBe(422);
    }
    const res = await post('/api/development/plugin-generator/preview', input);
    expect(res.status).toBe(200);
    expect(res.body.data.validation.ok).toBe(true);
    expect(res.body.data.manifest).toMatchObject({ id: 'com.example.hello', main: 'index.js', license: 'MIT' });
    expect(res.body.data.manifest.permissions).toEqual(expect.arrayContaining(['accounts:read', 'settings:own', 'jobs', 'schedule', 'ui:sidebar']));
    expect(res.body.data.manifest.hooks).toEqual([{ event: 'account.created', stage: 'post', handler: 'onAccountCreated' }, { event: 'account.suspended', stage: 'pre', handler: 'onAccountSuspendedPre' }]);
    expect(res.body.data.files.map((f) => f.path)).toEqual(['plugin.json', 'index.js', 'README.md', '.gitignore']);
    expect(res.body.data.files.find((f) => f.path === 'index.js').content).toContain('onAccountSuspendedPre');
    expect(res.body.data.files.find((f) => f.path === 'README.md').content).toContain('`accounts:read`');
    const invalidStage = await post('/api/development/plugin-generator/preview', { ...input, hooks: [{ event: 'login.failed', stage: 'pre' }] });
    expect(invalidStage.body.data.validation.ok).toBe(false);
    expect((await post('/api/development/plugin-generator/generate', { ...input, hooks: [{ event: 'login.failed', stage: 'pre' }] })).status).toBe(422);
  });

  it('generates a downloadable tar.gz containing the skeleton', async () => {
    const res = await post('/api/development/plugin-generator/generate', input);
    expect(res.status).toBe(200);
    expect(res.body.data.filename).toBe('com.example.hello-1.0.0.tar.gz');
    const raw = zlib.gunzipSync(Buffer.from(res.body.data.base64, 'base64')).toString('latin1');
    expect(raw).toContain('com.example.hello/plugin.json');
    expect(raw).toContain('com.example.hello/index.js');
    expect(raw).toContain('"id": "com.example.hello"');
    expect(res.body.data.size).toBeGreaterThan(500);
    const validate = await post('/api/development/plugin-generator/validate', { manifest: res.body.data.manifest });
    expect(validate.body.data.ok).toBe(true);
    expect((await post('/api/development/plugin-generator/validate', { manifest: { id: 'x' } })).body.data.ok).toBe(false);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'development.plugin.generate'").get().n).toBe(1);
  });

  it('reports capability_missing when the SDK is not shipped', async () => {
    app.ctx.development.pluginGen.useSdk(null);
    try {
      for (const [method, url, body] of [['get', '/api/development/plugin-generator/vocabulary'], ['post', '/api/development/plugin-generator/preview', input], ['post', '/api/development/plugin-generator/generate', input]]) {
        const res = method === 'get' ? await get(url) : await post(url, body);
        expect(res.status, url).toBe(501);
        expect(res.body.error.capability).toBe('plugin-sdk');
      }
      // Hooks keep working from the built-in event catalog.
      expect((await get('/api/development/hooks/events')).body.data.find((e) => e.name === 'account.created').stages).toEqual(['pre', 'post']);
      expect((await get('/api/development/overview')).body.data.sdk.available).toBe(false);
    } finally { app.ctx.development.pluginGen.useSdk(); }
    expect((await get('/api/development/plugin-generator/vocabulary')).status).toBe(200);
  });
});

describe('OpenAPI documentation', () => {
  it('walks the live router for the WHM reference', async () => {
    const res = await get('/api/development/openapi.json');
    expect(res.status).toBe(200);
    const spec = res.body.data;
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.title).toBe('WHM API');
    expect(spec.paths['/accounts'].get['x-whm-role']).toBe('reseller');
    expect(spec.paths['/accounts'].post['x-whm-role']).toBe('reseller');
    expect(spec.paths['/system/info'].get['x-whm-role']).toBe('root');
    expect(spec.paths['/auth/login'].post.security).toBeUndefined();
    expect(spec.paths['/development/tokens/{id}'].delete).toBeDefined();
    expect(spec.paths['/development/hooks/{id}/test'].post.parameters[0].name).toBe('id');
    expect(spec.paths['/security/host-access'].get['x-whm-role']).toBe('root');
    const routes = collectRoutes(app.ctx.app);
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.every((r) => r.path.startsWith('/api/'))).toBe(true);
    const endpoints = await get('/api/development/openapi/endpoints');
    expect(endpoints.body.data.total).toBe(routes.length);
    expect(endpoints.body.data.groups.find((g) => g.prefix === '/development').count).toBeGreaterThan(30);
    expect(endpoints.body.data.byMethod.GET).toBeGreaterThan(50);
  });

  it('filters the cPanel reference to account-scoped endpoints', async () => {
    const res = await get('/api/development/openapi.json?scope=cpanel');
    expect(res.body.data.info.title).toBe('cPanel (account) API');
    const ops = Object.values(res.body.data.paths).flatMap((p) => Object.values(p));
    expect(ops.length).toBeGreaterThan(10);
    expect(ops.every((op) => op['x-whm-role'] !== 'root')).toBe(true);
    expect(res.body.data.paths['/accounts']).toBeDefined();
    expect(res.body.data.paths['/system/info']).toBeUndefined();
    expect((await get('/api/development/openapi.json?scope=everything')).status).toBe(422);
  });
});

describe('Developer Documentation', () => {
  it('lists the shipped documents with their sections', async () => {
    const res = await get('/api/development/docs');
    expect(res.status).toBe(200);
    const blueprint = res.body.data.find((d) => d.slug === 'blueprint');
    expect(blueprint).toMatchObject({ available: true, file: 'BLUEPRINT.md', type: 'markdown' });
    expect(blueprint.sections).toBeGreaterThan(10);
    expect(res.body.data.find((d) => d.slug === 'plugin-manifest-schema').type).toBe('json');
  });

  it('returns a whole document or one section', async () => {
    const doc = await get('/api/development/docs/blueprint');
    expect(doc.body.data.content).toContain('## 13. Complete Functionality Specification');
    const section = doc.body.data.sections.find((s) => /api-design/.test(s.slug));
    const part = await get(`/api/development/docs/blueprint?section=${section.slug}`);
    expect(part.body.data.content.startsWith('## 12. API Design')).toBe(true);
    expect(part.body.data.content).not.toContain('## 13.');
    expect((await get('/api/development/docs/blueprint?section=nope-nope')).status).toBe(404);
    expect((await get('/api/development/docs/unknown')).status).toBe(404);
    expect((await get('/api/development/docs/../etc')).status).not.toBe(200);
    const schema = await get('/api/development/docs/plugin-manifest-schema');
    expect(() => JSON.parse(schema.body.data.content)).not.toThrow();
  });

  it('the overview summarises the category', async () => {
    const res = await get('/api/development/overview');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tokens: { total: expect.any(Number) }, hooks: { dir: '/usr/local/whm/hooks' }, api: { specUrl: '/api/development/openapi.json' }, sdk: { available: true } });
    expect(res.body.data.api.endpoints).toBeGreaterThan(100);
    expect(res.body.data.docs).toBeGreaterThanOrEqual(5);
  });
});
