import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import { createTestApp, waitForJob } from './support/app.js';
import { parseChangelog, sniffImage, compareVersions, parseRelease } from '../src/services/cpanel.js';

let app;
let csrf;
let reseller;
let resellerCsrf;
let plainUser;
let plainCsrf;

const mutate = (client, method, url, body, token) => client[method](url).set('X-CSRF-Token', token).send(body);
const put = (url, body) => mutate(app.http, 'put', url, body, csrf);
const post = (url, body = {}) => mutate(app.http, 'post', url, body, csrf);
const del = (url) => mutate(app.http, 'delete', url, undefined, csrf);
const get = (url) => app.http.get(url);
const upload = (url, buffer, type = 'application/octet-stream') => app.http.post(url).set('X-CSRF-Token', csrf).set('Content-Type', type).send(buffer);
const auditRows = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC').all(action);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0)]);
const SAFE_SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#1b8fc9"/></svg>');
const EVIL_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>1</script></svg>');

beforeAll(async () => {
  app = await createTestApp();
  csrf = await app.login();
  const r = await app.createUser('resell1', 'reseller');
  reseller = request.agent(app.ctx.app);
  resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
  const u = await app.createUser('plainuser', 'user');
  plainUser = request.agent(app.ctx.app);
  plainCsrf = (await plainUser.post('/api/auth/login').send({ username: u.username, password: u.password })).body.data.csrfToken;
}, 30_000);

afterAll(async () => { await app?.close(); });

describe('pure helpers', () => {
  it('parses Keep-a-Changelog markdown into releases with sections', () => {
    const md = '# Changelog\n\nIntro.\n\n## [Unreleased]\n\n### Added\n- thing one\n  continued\n\n## [1.2.0] - 2026-10-26\n\n### Fixed\n- bug\n- other bug\n\n## 1.1.0 (2026-10-01)\n\nFree text.\n';
    const parsed = parseChangelog(md);
    expect(parsed.intro).toContain('Intro.');
    expect(parsed.releases.map((r) => r.version)).toEqual(['unreleased', '1.2.0', '1.1.0']);
    expect(parsed.releases[0].unreleased).toBe(true);
    expect(parsed.releases[0].sections[0]).toEqual({ name: 'Added', items: ['thing one continued'] });
    expect(parsed.releases[1]).toMatchObject({ date: '2026-10-26', unreleased: false });
    expect(parsed.releases[1].sections[0].items).toEqual(['bug', 'other bug']);
    expect(parsed.releases[2].date).toBe('2026-10-01');
    expect(parseChangelog('').releases).toEqual([]);
  });

  it('sniffs image bytes and flags unsafe SVG', () => {
    expect(sniffImage(PNG)).toEqual({ mime: 'image/png', ext: 'png' });
    expect(sniffImage(JPEG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(sniffImage(Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(8)]))).toEqual({ mime: 'image/x-icon', ext: 'ico' });
    expect(sniffImage(SAFE_SVG)).toEqual({ mime: 'image/svg+xml', ext: 'svg' });
    expect(sniffImage(EVIL_SVG).unsafe).toBe(true);
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>')).unsafe).toBe(true);
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>')).unsafe).toBe(true);
    expect(sniffImage(Buffer.from('<html><script>1</script></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a' + 'x'.repeat(10)))).toEqual({ mime: 'image/gif', ext: 'gif' });
  });

  it('compares versions and parses release feeds', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('2.0.0', '2.0.0-rc.1')).toBe(1);
    expect(compareVersions('0.1.0', '0.0.9')).toBe(1);
    const rel = parseRelease({ tiers: { stable: { version: 'v1.5.0', url: 'https://dl.example/whm-1.5.0.tar.gz', sha256: 'A'.repeat(64), signature: 'x'.repeat(88), keyId: 'release-2026', notes: 'n', publishedAt: '2026-10-26T00:00:00Z' } } }, 'stable');
    expect(rel).toMatchObject({ version: '1.5.0', sha256: 'a'.repeat(64), keyId: 'release-2026', tier: 'stable' });
    expect(parseRelease({ version: '1.0.0', url: 'http://insecure.example/x.tgz', sha256: 'nothex' }, 'stable')).toMatchObject({ version: '1.0.0', url: null, sha256: null });
    expect(() => parseRelease({ nope: true }, 'stable')).toThrow(/version/);
  });
});

describe('Change Log', () => {
  it('renders CHANGELOG.md for root and resellers, not for users', async () => {
    const res = await get('/api/cpanel/changelog').expect(200);
    expect(res.body.data.exists).toBe(true);
    expect(res.body.data.version).toBe(app.ctx.version);
    expect(res.body.data.releases.length).toBeGreaterThan(1);
    expect(res.body.data.releases[0].unreleased).toBe(true);
    expect(res.body.data.markdown).toContain('# Changelog');
    await reseller.get('/api/cpanel/changelog').expect(200);
    await plainUser.get('/api/cpanel/changelog').expect(403);
    await request(app.ctx.app).get('/api/cpanel/changelog').expect(401);
  });
});

describe('Customization (branding)', () => {
  it('serves defaults to every signed-in role from both mounts', async () => {
    const res = await get('/api/branding').expect(200);
    expect(res.body.data).toMatchObject({ companyName: 'WHM', tagline: 'WebHost Manager', logo: null, favicon: null });
    expect(res.body.data.links).toEqual({ help: '', docs: '', support: '' });
    const r2 = await plainUser.get('/api/cpanel/branding').expect(200);
    expect(r2.body.data.companyName).toBe('WHM');
    await get('/api/branding/logo').expect(404);
  });

  it('updates text settings with validation, root only, audited', async () => {
    const res = await put('/api/cpanel/branding', { companyName: 'Acme Hosting', primaryColor: '#1b8fc9', helpUrl: 'https://help.acme.example/', loginNotice: 'Authorised staff only.', footerText: 'Acme Hosting Ltd' }).expect(200);
    expect(res.body.data).toMatchObject({ companyName: 'Acme Hosting', primaryColor: '#1b8fc9', helpUrl: 'https://help.acme.example/', loginNotice: 'Authorised staff only.' });
    expect(app.ctx.settings.get('branding.company_name')).toBe('Acme Hosting');
    expect(auditRows('branding.update')[0]).toBeTruthy();
    for (const body of [{ primaryColor: 'red; background: url(x)' }, { helpUrl: 'javascript:alert(1)' }, { companyName: '<b>x</b>' }, {}, { unknown: 1 }, { loginNotice: 'x'.repeat(2001) }]) {
      const bad = await put('/api/cpanel/branding', body);
      expect(bad.status, JSON.stringify(body)).toBe(422);
    }
    await mutate(reseller, 'put', '/api/cpanel/branding', { companyName: 'Hijack' }, resellerCsrf).expect(403);
    await mutate(plainUser, 'put', '/api/cpanel/branding', { companyName: 'Hijack' }, plainCsrf).expect(403);
  });

  it('stores an uploaded logo, serves it back with caching headers and inlines small ones', async () => {
    const res = await upload('/api/cpanel/branding/logo', PNG, 'image/png').expect(201);
    expect(res.body.data).toMatchObject({ mime: 'image/png', size: PNG.length });
    expect(res.body.data.url).toMatch(/^\/api\/branding\/logo\?v=[0-9a-f]{12}$/);
    expect(fs.existsSync(path.join(app.dir, 'branding', 'logo.png'))).toBe(true);
    const img = await get('/api/branding/logo').expect(200);
    expect(img.headers['content-type']).toMatch(/image\/png/);
    expect(img.headers['cache-control']).toBe('private, max-age=86400');
    expect(img.headers['content-security-policy']).toContain("default-src 'none'");
    expect(Buffer.from(img.body).equals(PNG)).toBe(true);
    await get('/api/branding/logo').set('If-None-Match', img.headers.etag).expect(304);
    const branding = await get('/api/branding').expect(200);
    expect(branding.body.data.logo.dataUrl).toMatch(/^data:image\/png;base64,/);
    await plainUser.get('/api/cpanel/branding/logo').expect(200);
    await request(app.ctx.app).get('/api/branding/logo').expect(401);
    // Replacing with another format removes the old file.
    await upload('/api/cpanel/branding/logo', SAFE_SVG, 'image/svg+xml').expect(201);
    expect(fs.existsSync(path.join(app.dir, 'branding', 'logo.png'))).toBe(false);
    expect(fs.existsSync(path.join(app.dir, 'branding', 'logo.svg'))).toBe(true);
    expect(auditRows('branding.logo.upload')).toHaveLength(2);
  });

  it('refuses unsafe, oversized, non-image and wrong-kind uploads', async () => {
    await upload('/api/cpanel/branding/logo', EVIL_SVG, 'image/svg+xml').expect(422);
    await upload('/api/cpanel/branding/logo', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png').expect(422);
    await upload('/api/cpanel/branding/logo', Buffer.alloc(0), 'image/png').expect(422);
    const big = await upload('/api/cpanel/branding/logo', Buffer.concat([PNG, Buffer.alloc(600 * 1024)]), 'image/png');
    expect(big.status).toBe(413);
    await upload('/api/cpanel/branding/favicon', JPEG, 'image/jpeg').expect(422);
    await upload('/api/cpanel/branding/banner', PNG, 'image/png').expect(422);
    await reseller.post('/api/cpanel/branding/logo').set('X-CSRF-Token', resellerCsrf).set('Content-Type', 'image/png').send(PNG).expect(403);
  });

  it('removes images', async () => {
    await upload('/api/cpanel/branding/favicon', PNG, 'image/png').expect(201);
    await get('/api/branding/favicon').expect(200);
    await del('/api/cpanel/branding/favicon').expect(200);
    await get('/api/branding/favicon').expect(404);
    await del('/api/cpanel/branding/favicon').expect(404);
    await del('/api/cpanel/branding/logo').expect(200);
    expect((await get('/api/branding')).body.data.logo).toBeNull();
    await mutate(reseller, 'delete', '/api/cpanel/branding/logo', undefined, resellerCsrf).expect(403);
  });
});

describe('Modify cPanel & WHM News', () => {
  let rootOnly;
  let forAll;
  let scheduled;

  it('creates items with validation, root only', async () => {
    rootOnly = (await post('/api/cpanel/news', { title: 'Maintenance tonight', body: '**Disks** will be swapped at 02:00.', audience: 'root', severity: 'warning' }).expect(201)).body.data;
    expect(rootOnly).toMatchObject({ title: 'Maintenance tonight', audience: 'root', severity: 'warning', enabled: true, status: 'active', createdBy: 'root' });
    forAll = (await post('/api/cpanel/news', { title: 'Welcome', body: 'Hello everyone', audience: 'all' }).expect(201)).body.data;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    scheduled = (await post('/api/cpanel/news', { title: 'Later', audience: 'resellers', startsAt: future }).expect(201)).body.data;
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.startsAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    for (const body of [{ title: '' }, { title: 'x', audience: 'everyone' }, { title: 'x', startsAt: 'yesterday' }, { title: 'x', startsAt: '2026-01-02T00:00:00Z', endsAt: '2026-01-01T00:00:00Z' }, { title: 'x', extra: 1 }]) {
      expect((await post('/api/cpanel/news', body)).status, JSON.stringify(body)).toBe(422);
    }
    await mutate(reseller, 'post', '/api/cpanel/news', { title: 'nope' }, resellerCsrf).expect(403);
    await reseller.get('/api/cpanel/news').expect(403);
    expect(auditRows('news.create')).toHaveLength(3);
  });

  it('lists everything for root and filters by status', async () => {
    const res = await get('/api/cpanel/news').expect(200);
    expect(res.body.meta.total).toBe(3);
    expect((await get('/api/cpanel/news?status=scheduled')).body.data.map((n) => n.id)).toEqual([scheduled.id]);
    expect((await get('/api/cpanel/news?q=Welcome')).body.data).toHaveLength(1);
    expect((await get(`/api/cpanel/news/${forAll.id}`)).body.data.body).toBe('Hello everyone');
    await get('/api/cpanel/news/999999').expect(404);
  });

  it('shows only active items for the right audience', async () => {
    const rootView = (await get('/api/cpanel/news/active').expect(200)).body.data.map((n) => n.id);
    expect(rootView).toEqual([rootOnly.id, forAll.id]);
    const resellerView = (await reseller.get('/api/cpanel/news/active').expect(200)).body.data.map((n) => n.id);
    expect(resellerView).toEqual([forAll.id]);
    const userView = (await plainUser.get('/api/cpanel/news/active').expect(200)).body.data.map((n) => n.id);
    expect(userView).toEqual([forAll.id]);
    const now = new Date().toISOString();
    await put(`/api/cpanel/news/${scheduled.id}`, { startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(200);
    expect((await reseller.get('/api/cpanel/news/active')).body.data.map((n) => n.id)).toEqual([scheduled.id, forAll.id]);
    expect((await plainUser.get('/api/cpanel/news/active')).body.data.map((n) => n.id)).toEqual([forAll.id]);
    expect(now).toBeTruthy();
  });

  it('updates, disables and deletes items', async () => {
    const upd = (await put(`/api/cpanel/news/${forAll.id}`, { title: 'Welcome!', enabled: false }).expect(200)).body.data;
    expect(upd).toMatchObject({ title: 'Welcome!', enabled: false, status: 'disabled', body: 'Hello everyone' });
    expect((await plainUser.get('/api/cpanel/news/active')).body.data).toEqual([]);
    await put(`/api/cpanel/news/${forAll.id}`, {}).expect(422);
    await put('/api/cpanel/news/999999', { title: 'x' }).expect(404);
    await mutate(reseller, 'put', `/api/cpanel/news/${forAll.id}`, { title: 'x' }, resellerCsrf).expect(403);
    await del(`/api/cpanel/news/${rootOnly.id}`).expect(200);
    await del(`/api/cpanel/news/${rootOnly.id}`).expect(404);
    expect((await get('/api/cpanel/news')).body.meta.total).toBe(2);
    expect(auditRows('news.delete')[0].target).toBe(String(rootOnly.id));
  });

  it('keeps the stored window untouched by a toggle whatever the process time zone is', async () => {
    const savedTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const created = (await post('/api/cpanel/news', { title: 'Window', startsAt: '2026-10-26T12:00:00Z', endsAt: '2026-10-27T12:00:00Z' }).expect(201)).body.data;
      expect(created.startsAt).toBe('2026-10-26 12:00:00');
      expect(created.endsAt).toBe('2026-10-27 12:00:00');
      for (let i = 0; i < 3; i++) await put(`/api/cpanel/news/${created.id}`, { enabled: i % 2 === 0 }).expect(200);
      const after = (await get(`/api/cpanel/news/${created.id}`).expect(200)).body.data;
      expect(after).toMatchObject({ startsAt: '2026-10-26 12:00:00', endsAt: '2026-10-27 12:00:00', enabled: true });
      const moved = (await put(`/api/cpanel/news/${created.id}`, { endsAt: '2026-10-28T00:30:00+02:00' }).expect(200)).body.data;
      expect(moved).toMatchObject({ startsAt: '2026-10-26 12:00:00', endsAt: '2026-10-27 22:30:00' });
      await del(`/api/cpanel/news/${created.id}`).expect(200);
    } finally {
      if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
    }
  });
});

describe('Reset a Mailman Password', () => {
  afterEach(() => { app.agent.reset('cpanel.mailman.lists'); app.agent.reset('cpanel.mailman.change_pw'); app.agent.reset('cpanel.mailman.detect'); app.agent.reset('cpanel.mailman.site_password'); });

  it('raises the capability prompt when Mailman is missing', async () => {
    app.agent.fail('cpanel.mailman.lists', 'capability_missing', 'Mailman is not installed on this server');
    const res = await get('/api/cpanel/mailman/lists').expect(501);
    expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'mailman' });
    app.agent.fail('cpanel.mailman.change_pw', 'binary_not_found', 'change_pw is missing');
    const r2 = await post('/api/cpanel/mailman/lists/announce/password', { password: 'Str0ng-list-pass' }).expect(501);
    expect(r2.body.error.capability).toBe('mailman');
  });

  it('lists mailing lists and resets a list password through the agent', async () => {
    app.agent.set('cpanel.mailman.lists', () => ({ flavor: 'mailman2', lists: [{ name: 'announce', description: 'Announcements' }, { name: 'dev', description: '' }] }));
    const res = await get('/api/cpanel/mailman/lists').expect(200);
    expect(res.body.data).toMatchObject({ flavor: 'mailman2', canResetPassword: true });
    expect(res.body.data.lists.map((l) => l.name)).toEqual(['announce', 'dev']);
    app.agent.set('cpanel.mailman.change_pw', ({ list }) => ({ list, changed: true }));
    await post('/api/cpanel/mailman/lists/Announce/password', { password: 'Str0ng-list-pass' }).expect(200);
    const call = app.agent.callsTo('cpanel.mailman.change_pw')[0];
    expect(call.args).toEqual({ list: 'announce', password: 'Str0ng-list-pass' });
    const audit = auditRows('mailman.password.reset')[0];
    expect(audit.target).toBe('announce');
    expect(JSON.stringify(auditRows('POST /api/cpanel/mailman/lists/:list/password').concat(audit))).not.toContain('Str0ng-list-pass');
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%Str0ng-list-pass%'").get().n).toBe(0);
  });

  it('never echoes the password when the Mailman tool fails', async () => {
    const argvLeak = (code) => Object.assign(new Error(`"change_pw" exited with status 1: Bad password Str0ng-list-pass`), { agentError: true, code, details: { bin: '/usr/lib/mailman/bin/change_pw', argv: ['--quiet', '--listname', 'announce', '--password', 'Str0ng-list-pass'], stderr: 'Bad password Str0ng-list-pass' } });
    app.agent.set('cpanel.mailman.change_pw', argvLeak('command_failed'));
    const res = await post('/api/cpanel/mailman/lists/announce/password', { password: 'Str0ng-list-pass' }).expect(500);
    expect(res.body.error.code).toBe('command_failed');
    expect(res.body.error.details ?? {}).toEqual({});
    app.agent.set('cpanel.mailman.change_pw', argvLeak('timeout'));
    const t = await post('/api/cpanel/mailman/lists/announce/password', { password: 'Str0ng-list-pass' }).expect(503);
    expect(t.body.error.details ?? {}).toEqual({});
    app.agent.set('cpanel.mailman.site_password', Object.assign(new Error('mmsitepass exited with status 2'), { agentError: true, code: 'command_failed', details: { argv: ['-c', 'Str0ng-site-pass'] } }));
    const sp = await post('/api/cpanel/mailman/site-password', { password: 'Str0ng-site-pass', creator: true }).expect(500);
    expect(JSON.stringify(sp.body)).not.toContain('Str0ng-site-pass');
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%Str0ng-%' OR result LIKE '%Str0ng-%'").get().n).toBe(0);
  });

  it('validates list names and passwords before the agent sees them', async () => {
    app.agent.set('cpanel.mailman.change_pw', () => ({ changed: true }));
    for (const [list, password] of [['a;b', 'Str0ng-list-pass'], ['../x', 'Str0ng-list-pass'], ['announce', '-rf'], ['announce', 'short'], ['announce', 'has\nnewline-ok'], ['-l', 'Str0ng-list-pass']]) {
      const res = await post(`/api/cpanel/mailman/lists/${encodeURIComponent(list)}/password`, { password });
      expect(res.status, `${list} / ${password}`).toBe(422);
    }
    expect(app.agent.callsTo('cpanel.mailman.change_pw')).toHaveLength(0);
    await mutate(reseller, 'post', '/api/cpanel/mailman/lists/announce/password', { password: 'Str0ng-list-pass' }, resellerCsrf).expect(403);
    await reseller.get('/api/cpanel/mailman/lists').expect(403);
  });

  it('reports Mailman 3 as unable to reset per-list passwords and sets the site password', async () => {
    app.agent.set('cpanel.mailman.lists', () => ({ flavor: 'mailman3', lists: [{ name: 'news', description: '' }] }));
    expect((await get('/api/cpanel/mailman/lists')).body.data.canResetPassword).toBe(false);
    app.agent.fail('cpanel.mailman.change_pw', 'unsupported', 'Mailman 3 has no per-list administrator password');
    await post('/api/cpanel/mailman/lists/news/password', { password: 'Str0ng-list-pass' }).expect(422);
    app.agent.set('cpanel.mailman.site_password', ({ creator }) => ({ changed: true, scope: creator ? 'creator' : 'site' }));
    expect((await post('/api/cpanel/mailman/site-password', { password: 'Str0ng-site-pass', creator: true }).expect(200)).body.data.scope).toBe('creator');
    expect(auditRows('mailman.site_password.set')[0]).toBeTruthy();
    app.agent.set('cpanel.mailman.detect', () => ({ installed: true, flavor: 'mailman2', binDir: '/usr/lib/mailman/bin' }));
    expect((await get('/api/cpanel/mailman').expect(200)).body.data.flavor).toBe('mailman2');
  });
});

describe('Upgrade to Latest Version', () => {
  const realFetch = globalThis.fetch;
  const archive = Buffer.concat([Buffer.from('release-bytes-'), crypto.randomBytes(2048)]);
  const digest = crypto.createHash('sha256').update(archive).digest();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signature = crypto.sign(null, digest, privateKey).toString('base64');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  let feed;
  // The agent owns the key store; the mock keeps it in memory with the same op contract.
  const keyStore = new Map();
  const keyEntry = (kid, p) => ({ kid, type: 'ed25519', fingerprint: crypto.createHash('sha256').update(crypto.createPublicKey(p).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 32), addedAt: '2026-10-26T00:00:00.000Z', valid: true, pem: p });
  const agentFail = (code, message) => Object.assign(new Error(message), { agentError: true, code, details: {} });
  const stagingDir = () => path.join(app.dir, 'agent-staging');
  let extractImpl;

  beforeAll(() => {
    feed = { version: '9.9.9', url: 'https://dl.example/whm-9.9.9.tar.gz', sha256: digest.toString('hex'), signature, keyId: 'release-2026', notes: 'Big release', publishedAt: '2026-10-26' };
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.startsWith('https://feed.example/')) return new Response(JSON.stringify({ tiers: { stable: feed } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (href === feed.url) return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } });
      return new Response('nope', { status: 404 });
    };
    app.agent.set('cpanel.upgrade.keys', () => ({ dir: '/etc/whm/release-keys', readOnly: false, keys: [...keyStore.values()] }));
    app.agent.set('cpanel.upgrade.key_add', ({ kid, pem: p }) => {
      if (keyStore.has(kid)) throw agentFail('exists', `A key named "${kid}" already exists`);
      keyStore.set(kid, keyEntry(kid, p));
      return keyStore.get(kid);
    });
    app.agent.set('cpanel.upgrade.key_remove', ({ kid }) => {
      if (!keyStore.has(kid)) throw agentFail('not_found', `No trusted key named "${kid}"`);
      keyStore.delete(kid);
      return { kid, removed: true };
    });
    // Stand-in for the agent's own verification: hash the archive it is handed
    // and check the signature against the (mock) key store.
    extractImpl = ({ archive: a, version, sha256, signature: sig, keyId, allowUnverified }) => {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(a)).digest();
      if (sha256 && actual.toString('hex') !== sha256) throw agentFail('checksum_mismatch', 'SHA-256 mismatch');
      let signer = null;
      if (sig) {
        const candidates = [...keyStore.values()].filter((k) => !keyId || k.kid === keyId);
        if (keyStore.size === 0) { if (!allowUnverified) throw agentFail('unverified', 'no trusted key'); }
        else {
          signer = candidates.find((k) => crypto.verify(null, actual, crypto.createPublicKey(k.pem), Buffer.from(sig, 'base64')))?.kid ?? null;
          if (!signer) throw agentFail('invalid_signature', 'The release signature does not verify against any trusted key');
        }
      }
      const stageDir = path.join(stagingDir(), `src-${version}`);
      fs.mkdirSync(stageDir, { recursive: true });
      return { version, stageDir, sourceDir: path.join(stageDir, `whm-${version}`), sha256: actual.toString('hex'), signer, signatureState: signer ? 'verified' : 'unsigned', name: 'whm', packageVersion: version, warnings: signer ? [] : ['No signature verified'] };
    };
    app.agent.set('cpanel.upgrade.extract', extractImpl);
    app.ctx.jobs.start();
  });
  afterAll(() => { globalThis.fetch = realFetch; });

  it('reports status (root only) and explains why a git checkout cannot self-upgrade', async () => {
    const res = await get('/api/cpanel/upgrade').expect(200);
    expect(res.body.data).toMatchObject({ currentVersion: app.ctx.version, updateUrlConfigured: false, canRun: false, latest: null, releaseKeys: [], releaseKeyDir: '/etc/whm/release-keys', releaseKeysReadOnly: false, activeJob: null, last: null });
    expect(res.body.data.reason).toMatch(/git/);
    expect(res.body.data.instructions.length).toBeGreaterThan(1);
    await reseller.get('/api/cpanel/upgrade').expect(403);
    await post('/api/cpanel/upgrade/start', {}).expect(422);
    await get('/api/cpanel/upgrade/log').expect(404);
  });

  it('needs an update URL from Update Preferences, then checks the feed and records the verification material', async () => {
    const none = await post('/api/cpanel/upgrade/check').expect(422);
    expect(none.body.error.fields.url).toBeTruthy();
    app.ctx.settings.set('software.update_url', 'https://user:pw@feed.example/releases.json');
    const res = await post('/api/cpanel/upgrade/check').expect(200);
    expect(res.body.data.updateUrl).toBe('https://feed.example/releases.json');
    expect(res.body.data.latest).toMatchObject({ version: '9.9.9', sha256: feed.sha256, keyId: 'release-2026' });
    expect(res.body.data.updateAvailable).toBe(true);
    expect(res.body.data.verification).toEqual({ sha256: true, signature: true, keyId: 'release-2026', trustedKeys: 0, trustedKey: false, unverifiable: true, keyMissing: false });
    expect(JSON.stringify(auditRows('upgrade.check')[0])).not.toContain('user:pw');
    feed = { ...feed, version: 'garbage' };
    const bad = await post('/api/cpanel/upgrade/check').expect(200);
    expect(bad.body.data.lastCheck.ok).toBe(false);
    expect(bad.body.data.lastCheck.error).toMatch(/version/);
    feed = { ...feed, version: '9.9.9' };
    await post('/api/cpanel/upgrade/check').expect(200);
  });

  it('manages trusted release keys through the agent and never stores them itself', async () => {
    const added = (await post('/api/cpanel/upgrade/keys', { kid: 'release-2026', pem }).expect(201)).body.data;
    expect(added).toMatchObject({ kid: 'release-2026', type: 'ed25519', valid: true });
    expect(added.pem).toBeUndefined();
    expect(app.agent.callsTo('cpanel.upgrade.key_add')[0].args).toEqual({ kid: 'release-2026', pem });
    expect(fs.existsSync(path.join(app.dir, 'release-keys'))).toBe(false);
    await post('/api/cpanel/upgrade/keys', { kid: 'release-2026', pem }).expect(409);
    await post('/api/cpanel/upgrade/keys', { kid: 'bad', pem: '-----BEGIN PUBLIC KEY-----\nnotakey\n-----END PUBLIC KEY-----' }).expect(422);
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
    await post('/api/cpanel/upgrade/keys', { kid: 'rsa', pem: rsa }).expect(422);
    await post('/api/cpanel/upgrade/keys', { kid: '../etc', pem }).expect(422);
    expect(app.agent.callsTo('cpanel.upgrade.key_add')).toHaveLength(2);
    await mutate(reseller, 'post', '/api/cpanel/upgrade/keys', { kid: 'x', pem }, resellerCsrf).expect(403);
    const listed = (await get('/api/cpanel/upgrade/keys').expect(200)).body.data;
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0].pem).toBeUndefined();
    const v = (await get('/api/cpanel/upgrade').expect(200)).body.data.verification;
    expect(v).toMatchObject({ trustedKeys: 1, trustedKey: true, unverifiable: false, keyMissing: false });
    await post('/api/cpanel/upgrade/keys', { kid: 'spare', pem }).expect(201);
    await del('/api/cpanel/upgrade/keys/spare').expect(200);
    await del('/api/cpanel/upgrade/keys/spare').expect(404);
    expect(auditRows('upgrade.key.remove')[0].target).toBe('spare');
    app.agent.set('cpanel.upgrade.key_add', agentFail('refused', 'Release keys are managed on the host'));
    await post('/api/cpanel/upgrade/keys', { kid: 'later', pem }).expect(422);
    app.agent.set('cpanel.upgrade.key_add', ({ kid, pem: p }) => { keyStore.set(kid, keyEntry(kid, p)); return keyStore.get(kid); });
  });

  it('downloads, lets the agent verify and unpack, runs the installer as a job and follows its log', async () => {
    app.ctx.software.panel.installMethod = () => 'install-script';
    const logFiles = [];
    app.agent.set('cpanel.upgrade.run', (args) => {
      expect(args).toEqual({ version: '9.9.9', unit: expect.stringMatching(/^whm-upgrade-\d{14}$/), skipNode: false });
      const logFile = path.join(stagingDir(), `${args.unit}.log`);
      fs.writeFileSync(logFile, '==> Deploying application to /opt/whm\n==> WHM is running\n');
      logFiles.push(logFile);
      return { unit: `${args.unit}.service`, logFile, detached: true, sourceDir: path.join(stagingDir(), 'src-9.9.9', 'whm-9.9.9'), appDir: '/opt/whm' };
    });
    app.agent.set('cpanel.upgrade.unit_status', ({ unit }) => ({ unit, installed: false, state: 'gone', result: null, exitStatus: null }));
    const res = await post('/api/cpanel/upgrade/start', {}).expect(202);
    expect(res.body.data.job.type).toBe('cpanel.upgrade');
    await post('/api/cpanel/upgrade/start', {}).expect(409);
    const job = await waitForJob(app.ctx, res.body.data.job.id, 20_000);
    expect(job.status, JSON.stringify(job)).toBe('done');
    expect(job.result).toMatchObject({ version: '9.9.9', logFile: logFiles[0] });
    const extract = app.agent.callsTo('cpanel.upgrade.extract').at(-1).args;
    expect(extract).toEqual({ archive: path.join(app.dir, 'upgrades', 'whm-9.9.9.tar.gz'), version: '9.9.9', sha256: feed.sha256, signature, keyId: 'release-2026', allowUnverified: false });
    expect(fs.readFileSync(extract.archive).equals(archive)).toBe(true);
    const lines = job.logs.map((l) => l.line);
    expect(lines.some((l) => /SHA-256 checksum matches/.test(l))).toBe(true);
    expect(lines.some((l) => /Signature matches trusted key "release-2026"/.test(l))).toBe(true);
    expect(lines.some((l) => /Agent verified sha256 .* and signature \(key "release-2026"\)/.test(l))).toBe(true);
    expect(lines.some((l) => /WHM is running/.test(l))).toBe(true);
    const status = (await get('/api/cpanel/upgrade').expect(200)).body.data;
    expect(status.last).toMatchObject({ version: '9.9.9', fromVersion: app.ctx.version, status: 'succeeded', by: 'root', signer: 'release-2026' });
    expect(status.last.log).toContain('WHM is running');
    expect((await get('/api/cpanel/upgrade/log').expect(200)).body.data.log).toContain('Deploying');
    expect(auditRows('upgrade.start')[0].target).toBe('9.9.9');
  }, 30_000);

  it('fails the job when the installer unit fails or vanishes without a result', async () => {
    app.agent.set('cpanel.upgrade.run', ({ unit }) => {
      const logFile = path.join(stagingDir(), `${unit}.log`);
      fs.writeFileSync(logFile, '==> Deploying application to /opt/whm\nerror: npm ci failed\n');
      return { unit: `${unit}.service`, logFile, detached: true, sourceDir: path.join(stagingDir(), 'src-9.9.9', 'whm-9.9.9'), appDir: '/opt/whm' };
    });
    // Collected straight away: the unit is gone, the log says the installer died.
    app.agent.set('cpanel.upgrade.unit_status', ({ unit }) => ({ unit, installed: false, state: 'gone', result: null, exitStatus: null }));
    let res = await post('/api/cpanel/upgrade/start', {}).expect(202);
    let job = await waitForJob(app.ctx, res.body.data.job.id, 20_000);
    expect(job.status).toBe('failed');
    expect(job.error_code).toBe('UPGRADE_FAILED');
    expect((await get('/api/cpanel/upgrade').expect(200)).body.data.last.status).toBe('failed');

    // Still loaded in the failed state with an exit status: failed, then reset once read.
    app.agent.set('cpanel.upgrade.unit_status', ({ unit, resetFailed }) => ({ unit, installed: true, state: 'failed', result: 'exit-code', exitStatus: 1, reset: Boolean(resetFailed) }));
    res = await post('/api/cpanel/upgrade/start', {}).expect(202);
    job = await waitForJob(app.ctx, res.body.data.job.id, 20_000);
    expect(job.status).toBe('failed');
    expect(job.error_code).toBe('UPGRADE_FAILED');
    expect(job.error).toMatch(/exit status 1/);
    expect(app.agent.callsTo('cpanel.upgrade.unit_status').some((c) => c.args.resetFailed === true)).toBe(true);
    expect((await get('/api/cpanel/upgrade').expect(200)).body.data.last).toMatchObject({ status: 'failed', exitStatus: 1 });

    // Gone before any terminal line was written: never reported as a success.
    app.agent.set('cpanel.upgrade.run', ({ unit }) => {
      const logFile = path.join(stagingDir(), `${unit}.log`);
      fs.writeFileSync(logFile, '==> Deploying application to /opt/whm\n');
      return { unit: `${unit}.service`, logFile, detached: true, sourceDir: path.join(stagingDir(), 'src-9.9.9', 'whm-9.9.9'), appDir: '/opt/whm' };
    });
    app.agent.set('cpanel.upgrade.unit_status', ({ unit }) => ({ unit, installed: false, state: 'gone', result: null, exitStatus: null }));
    res = await post('/api/cpanel/upgrade/start', {}).expect(202);
    job = await waitForJob(app.ctx, res.body.data.job.id, 20_000);
    expect(job.status).toBe('failed');
    expect(job.error_code).toBe('UPGRADE_UNKNOWN');
    expect((await get('/api/cpanel/upgrade').expect(200)).body.data.last.status).toBe('unknown');
  }, 60_000);

  it('fails on a checksum mismatch or a bad signature even with the override, and refuses unverifiable feeds', async () => {
    feed = { ...feed, sha256: 'b'.repeat(64) };
    await post('/api/cpanel/upgrade/check').expect(200);
    const extractCalls = app.agent.callsTo('cpanel.upgrade.extract').length;
    let res = await post('/api/cpanel/upgrade/start', {}).expect(202);
    let job = await waitForJob(app.ctx, res.body.data.job.id, 20_000);
    expect(job.status).toBe('failed');
    expect(job.error_code).toBe('CHECKSUM_MISMATCH');
    expect(app.agent.callsTo('cpanel.upgrade.extract')).toHaveLength(extractCalls);

    const forged = crypto.sign(null, digest, crypto.generateKeyPairSync('ed25519').privateKey).toString('base64');
    feed = { ...feed, sha256: digest.toString('hex'), signature: forged };
    await post('/api/cpanel/upgrade/check').expect(200);
    for (const allowUnverified of [false, true]) {
      res = await post('/api/cpanel/upgrade/start', { allowUnverified }).expect(202);
      job = await waitForJob(app.ctx, res.body.data.job.id, 20_000);
      expect(job.status, String(allowUnverified)).toBe('failed');
      expect(job.error_code, String(allowUnverified)).toBe('SIGNATURE_INVALID');
    }
    // A feed naming a key that is not trusted here is flagged for the UI.
    feed = { ...feed, signature, keyId: 'release-2027' };
    expect((await post('/api/cpanel/upgrade/check').expect(200)).body.data.verification).toMatchObject({ trustedKey: false, keyMissing: true, unverifiable: false });

    // The agent is the authority: if it rejects the signature the job fails even when the panel's early check passed.
    feed = { ...feed, signature, keyId: 'release-2026' };
    await post('/api/cpanel/upgrade/check').expect(200);
    app.agent.set('cpanel.upgrade.extract', agentFail('invalid_signature', 'The release signature does not verify against any trusted key'));
    res = await post('/api/cpanel/upgrade/start', { allowUnverified: true }).expect(202);
    job = await waitForJob(app.ctx, res.body.data.job.id, 20_000);
    expect(job.status).toBe('failed');
    expect(job.error_code).toBe('SIGNATURE_INVALID');
    app.agent.set('cpanel.upgrade.extract', extractImpl);

    // Keys trusted but the feed is unsigned: refused unless confirmed.
    feed = { version: '9.9.9', url: feed.url, sha256: digest.toString('hex') };
    await post('/api/cpanel/upgrade/check').expect(200);
    expect((await get('/api/cpanel/upgrade').expect(200)).body.data.verification).toMatchObject({ signature: false, unverifiable: true });
    res = await post('/api/cpanel/upgrade/start', {}).expect(202);
    job = await waitForJob(app.ctx, res.body.data.job.id, 20_000);
    expect(job.error_code).toBe('UNSIGNED');

    feed = { version: '9.9.9', url: feed.url };
    await post('/api/cpanel/upgrade/check').expect(200);
    const refused = await post('/api/cpanel/upgrade/start', {}).expect(422);
    expect(refused.body.error.fields.allowUnverified).toBeTruthy();
    feed = { version: '0.0.1', url: feed.url, sha256: digest.toString('hex') };
    await post('/api/cpanel/upgrade/check').expect(200);
    await post('/api/cpanel/upgrade/start', {}).expect(409);
    await post('/api/cpanel/upgrade/start', { allowUnverified: 'yes' }).expect(422);
  }, 60_000);
});
