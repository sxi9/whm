import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createTestApp } from './support/app.js';
import { validateVariables, sanitizeCss, VARIABLE_CATALOG, MAX_CSS_BYTES } from '../src/services/themes.js';

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
const auditCount = (action) => app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n;

beforeAll(async () => {
  app = await createTestApp();
  csrf = await app.login();
  const r = await app.createUser('resell1', 'reseller');
  reseller = request.agent(app.ctx.app);
  resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
  const u = await app.createUser('plainuser', 'user');
  plainUser = request.agent(app.ctx.app);
  plainCsrf = (await plainUser.post('/api/auth/login').send({ username: u.username, password: u.password })).body.data.csrfToken;
  await post('/api/packages', { name: 'starter', disk_mb: 1024 }).expect(201);
}, 30_000);

afterAll(async () => { await app?.close(); });

describe('pure helpers', () => {
  it('accepts catalog tokens with safe values and rejects everything else', () => {
    const ok = validateVariables({ primary: '#1B8FC9', bg: 'rgb(10, 20, 30)', 'ok-soft': 'hsla(120deg, 40%, 50%, 0.5)', radius: '4px', text: '' , 'text-muted': null });
    expect(ok.ok).toBe(true);
    expect(ok.variables).toEqual({ primary: '#1B8FC9', bg: 'rgb(10, 20, 30)', 'ok-soft': 'hsla(120deg, 40%, 50%, 0.5)', radius: '4px' });
    const bad = validateVariables({ primary: 'url(x)', radius: '4em', font: 'x', 'not-a-token': '#fff', bg: '#fff; background: red' });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.errors).sort()).toEqual(['bg', 'font', 'not-a-token', 'primary', 'radius']);
    expect(Object.keys(VARIABLE_CATALOG)).toContain('chrome-active');
  });

  it('refuses CSS that imports, scripts or fetches remote resources', () => {
    expect(sanitizeCss('.topbar { background: #000 } .brand-mark { background: url("data:image/png;base64,AAAA") }').ok).toBe(true);
    expect(sanitizeCss('.x { background: url(/logo.png) }').ok).toBe(true);
    for (const css of ['@import url(https://evil.example/x.css);', '.x { background: url(https://evil.example/x.png) }', '.x { background: url(//evil.example/x.png) }', '.x { width: expression(alert(1)) }', '.x { behavior: url(x.htc) }', '</style><script>1</script>', '.x { color: red', '.x { color: red }}', '.x { a: "\u0007" }']) {
      expect(sanitizeCss(css).ok, css).toBe(false);
    }
    expect(sanitizeCss('a'.repeat(MAX_CSS_BYTES + 1)).errors[0]).toMatch(/exceeds/);
  });
});

describe('GET /api/themes', () => {
  it('lists the built-in themes with defaults in meta', async () => {
    const res = await get('/api/themes').expect(200);
    const slugs = res.body.data.map((t) => t.slug);
    expect(slugs).toEqual(expect.arrayContaining(['jupiter', 'jupiter-dark', 'high-contrast']));
    expect(res.body.meta).toMatchObject({ default: 'jupiter', accountDefault: 'jupiter', allowUserOverride: true });
    expect(res.body.meta.variables.primary.kind).toBe('color');
    const jupiter = res.body.data.find((t) => t.slug === 'jupiter');
    expect(jupiter).toMatchObject({ builtin: true, enabled: true, isDefault: true, isAccountDefault: true, hasCss: false });
    expect(jupiter.usage.packages).toBe(2);
  });
  it('filters by q and is readable by resellers', async () => {
    const res = await reseller.get('/api/themes?q=contrast').expect(200);
    expect(res.body.data.map((t) => t.slug)).toEqual(['high-contrast']);
    expect(res.body.data[0].variables.text).toBe('#000000');
    await reseller.get('/api/themes/variables').expect(200);
  });
  it('rejects the user role on management reads', async () => {
    await plainUser.get('/api/themes').expect(403);
    await plainUser.get('/api/themes/jupiter').expect(403);
  });
  it('rejects malformed slugs', async () => {
    await get('/api/themes/..%2Fetc').expect(422);
    await get('/api/themes/Not%20Valid').expect(422);
    await get('/api/themes/missing').expect(404);
  });
});

describe('theme CRUD', () => {
  it('creates a copy of a built-in theme with overrides', async () => {
    const res = await post('/api/themes', { slug: 'acme', name: 'ACME Hosting', copyFrom: 'high-contrast', variables: { primary: '#ff6600', 'primary-hover': '#cc5200' } }).expect(201);
    expect(res.body.data).toMatchObject({ slug: 'acme', name: 'ACME Hosting', base: 'light', builtin: false, copiedFrom: 'high-contrast', css: '' });
    expect(res.body.data.variables).toMatchObject({ primary: '#ff6600', text: '#000000' });
    expect(auditCount('themes.create')).toBe(1);
    await post('/api/themes', { slug: 'acme' }).expect(409);
  });
  it('validates create bodies', async () => {
    const bad = await post('/api/themes', { slug: 'bad', variables: { primary: 'javascript:alert(1)' } }).expect(422);
    expect(bad.body.error.fields.primary).toBeTruthy();
    await post('/api/themes', { slug: 'a;b' }).expect(422);
    await post('/api/themes', { slug: 'ok', base: 'sepia' }).expect(422);
    await post('/api/themes', { slug: 'ok', extra: 1 }).expect(422);
    await post('/api/themes', { slug: 'ok', copyFrom: 'nope' }).expect(404);
  });
  it('updates name, base, variables and enabled', async () => {
    const res = await put('/api/themes/acme', { name: 'ACME Dark', base: 'dark', variables: { primary: '#ff6600', text: '' } }).expect(200);
    expect(res.body.data).toMatchObject({ name: 'ACME Dark', base: 'dark' });
    expect(res.body.data.variables).toEqual({ primary: '#ff6600' });
    await put('/api/themes/acme', {}).expect(422);
    await put('/api/themes/acme', { variables: { bogus: '#fff' } }).expect(422);
    expect(auditCount('themes.update')).toBe(1);
  });
  it('refuses to edit or delete built-in themes', async () => {
    await put('/api/themes/jupiter', { name: 'x' }).expect(409);
    await del('/api/themes/jupiter').expect(409);
    await put('/api/themes/jupiter/css', { css: '.x{}' }).expect(409);
  });
  it('is root-only for mutations', async () => {
    await mutate(reseller, 'post', '/api/themes', { slug: 'r1' }, resellerCsrf).expect(403);
    await mutate(reseller, 'put', '/api/themes/acme', { name: 'x' }, resellerCsrf).expect(403);
    await mutate(reseller, 'delete', '/api/themes/acme', undefined, resellerCsrf).expect(403);
    await mutate(reseller, 'put', '/api/themes/config', { default: 'acme' }, resellerCsrf).expect(403);
    await mutate(plainUser, 'put', '/api/themes/acme/css', { css: '' }, plainCsrf).expect(403);
  });
});

describe('CSS overrides', () => {
  it('stores a sanitised override under the data dir and serves it with the theme', async () => {
    const css = '.brand-mark { background: #ff6600; }\n';
    const res = await put('/api/themes/acme/css', { css }).expect(200);
    expect(res.body.data).toMatchObject({ hasCss: true, cssBytes: css.length, css });
    const file = path.join(app.dir, 'themes', 'acme.css');
    expect(fs.readFileSync(file, 'utf8')).toBe(css);
    expect(auditCount('themes.css.upload')).toBe(1);
    const rejected = await put('/api/themes/acme/css', { css: '@import url(https://x.example/a.css);' }).expect(422);
    expect(rejected.body.error.fields.css[0]).toMatch(/@import/);
    expect(fs.readFileSync(file, 'utf8')).toBe(css);
    await put('/api/themes/acme/css', { css: 1 }).expect(422);
  });
  it('copies the override when a theme is copied and removes it on clear', async () => {
    const copy = await post('/api/themes', { slug: 'acme2', copyFrom: 'acme' }).expect(201);
    expect(copy.body.data).toMatchObject({ hasCss: true, base: 'dark', name: 'ACME Dark (copy)' });
    expect(fs.existsSync(path.join(app.dir, 'themes', 'acme2.css'))).toBe(true);
    const cleared = await del('/api/themes/acme2/css').expect(200);
    expect(cleared.body.data).toMatchObject({ hasCss: false, cssBytes: 0, css: '' });
    expect(fs.existsSync(path.join(app.dir, 'themes', 'acme2.css'))).toBe(false);
  });
});

describe('defaults, preferences and the active theme', () => {
  it('serves the default to every role', async () => {
    const res = await plainUser.get('/api/themes/active').expect(200);
    expect(res.body.data).toMatchObject({ slug: 'jupiter', base: 'light', source: 'default', preference: null, variables: {}, css: '' });
  });
  it('configures the panel and account defaults', async () => {
    const res = await put('/api/themes/config', { default: 'acme', accountDefault: 'high-contrast', allowUserOverride: false }).expect(200);
    expect(res.body.data).toEqual({ default: 'acme', accountDefault: 'high-contrast', accountDefaultApplied: false, allowUserOverride: false });
    expect(app.ctx.themes.defaultSlug()).toBe('acme');
    expect(app.ctx.themes.accountDefault()).toBe('high-contrast');
    const active = await reseller.get('/api/themes/active').expect(200);
    expect(active.body.data).toMatchObject({ slug: 'acme', base: 'dark', css: '.brand-mark { background: #ff6600; }\n' });
    expect(active.body.data.variables.primary).toBe('#ff6600');
    await put('/api/themes/config', { default: 'nope' }).expect(422);
    await put('/api/themes/config', {}).expect(422);
    expect(auditCount('themes.configure')).toBe(1);
  });
  it('blocks user overrides while disabled, except for root', async () => {
    await mutate(plainUser, 'put', '/api/themes/preference', { theme: 'jupiter-dark' }, plainCsrf).expect(403);
    const root = await put('/api/themes/preference', { theme: 'jupiter-dark' }).expect(200);
    expect(root.body.data).toMatchObject({ slug: 'jupiter-dark', source: 'user', preference: 'jupiter-dark' });
    await put('/api/themes/config', { allowUserOverride: true }).expect(200);
    const user = await mutate(plainUser, 'put', '/api/themes/preference', { theme: 'high-contrast' }, plainCsrf).expect(200);
    expect(user.body.data).toMatchObject({ slug: 'high-contrast', source: 'user' });
    expect((await plainUser.get('/api/themes/active').expect(200)).body.data.slug).toBe('high-contrast');
    await mutate(plainUser, 'put', '/api/themes/preference', { theme: 'missing' }, plainCsrf).expect(404);
    await mutate(plainUser, 'put', '/api/themes/preference', { theme: 'a;b' }, plainCsrf).expect(422);
    const cleared = await mutate(plainUser, 'put', '/api/themes/preference', { theme: null }, plainCsrf).expect(200);
    expect(cleared.body.data).toMatchObject({ slug: 'acme', source: 'default', preference: null });
    expect(auditCount('themes.preference')).toBe(3);
  });
  it('cannot disable or delete a theme that is a default', async () => {
    await put('/api/themes/acme', { enabled: false }).expect(409);
    await del('/api/themes/acme').expect(409);
    await put('/api/themes/config', { default: 'jupiter', accountDefault: 'jupiter' }).expect(200);
  });
  it('disabling a theme drops user preferences pointing at it and hides it from active', async () => {
    await put('/api/themes/preference', { theme: 'acme2' }).expect(200);
    await put('/api/themes/acme2', { enabled: false }).expect(200);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM theme_user_prefs WHERE theme = ?').get('acme2').n).toBe(0);
    expect((await get('/api/themes/active').expect(200)).body.data.slug).toBe('jupiter');
    await put('/api/themes/preference', { theme: 'acme2' }).expect(422);
    await put('/api/themes/config', { default: 'acme2' }).expect(422);
    expect(app.ctx.themes.slugs()).not.toContain('acme2');
  });
});

describe('package assignment', () => {
  it('lists packages with their effective theme', async () => {
    const res = await get('/api/themes/packages').expect(200);
    expect(res.body.data.map((p) => p.name)).toEqual(['default', 'starter']);
    expect(res.body.data[1]).toEqual({ id: expect.any(Number), name: 'starter', theme: 'jupiter', accounts: 0, themeKnown: true, effective: 'jupiter', owned: true });
  });
  it('reports whether core applies the account default to new accounts', async () => {
    // Until packages.snapshot() routes the theme through resolveForPackage (integration-contracts §22)
    // the account default is stored but not applied, and the API must say so.
    expect(app.ctx.themes.accountDefaultApplied()).toBe(false);
    expect((await get('/api/themes').expect(200)).body.meta.accountDefaultApplied).toBe(false);
    expect(app.ctx.packages.snapshot('starter').theme).toBe('jupiter');
    const original = app.ctx.packages.snapshot;
    app.ctx.packages.snapshot = (name) => { const plan = original(name); return { ...plan, theme: app.ctx.themes.resolveForPackage({ theme: plan.theme }) }; };
    try {
      expect(app.ctx.themes.accountDefaultApplied()).toBe(true);
      expect((await get('/api/themes').expect(200)).body.meta.accountDefaultApplied).toBe(true);
      await app.ctx.db.prepare('UPDATE packages SET theme = ? WHERE name = ?').run('acme2', 'starter');
      expect(app.ctx.packages.snapshot('starter').theme).toBe('jupiter');
    } finally {
      app.ctx.packages.snapshot = original;
      await app.ctx.db.prepare('UPDATE packages SET theme = ? WHERE name = ?').run('jupiter', 'starter');
    }
    expect(app.ctx.themes.accountDefaultApplied()).toBe(false);
  });
  it('assigns a theme to a package through the packages service', async () => {
    const res = await put('/api/themes/packages/starter', { theme: 'acme' }).expect(200);
    expect(res.body.data).toEqual({ name: 'starter', theme: 'acme', accounts: 0 });
    expect(app.ctx.packages.get('starter', { role: 'root' }).theme).toBe('acme');
    expect(app.ctx.themes.resolveForPackage({ theme: 'acme' })).toBe('acme');
    expect(app.ctx.themes.resolveForPackage({ theme: 'acme2' })).toBe('jupiter');
    expect(auditCount('themes.package')).toBe(1);
    await put('/api/themes/packages/starter', { theme: 'acme2' }).expect(422);
    await put('/api/themes/packages/starter', { theme: 'missing' }).expect(404);
    await put('/api/themes/packages/missing', { theme: 'jupiter' }).expect(404);
    await put('/api/themes/packages/starter', { theme: '../x' }).expect(422);
  });
  it('resellers may read shared packages but only retheme the ones they own', async () => {
    const before = app.ctx.packages.get('starter', { role: 'root' }).theme;
    const denied = await mutate(reseller, 'put', '/api/themes/packages/starter', { theme: 'jupiter-dark' }, resellerCsrf).expect(403);
    expect(denied.body.error.message).toMatch(/owner/);
    expect(app.ctx.packages.get('starter', { role: 'root' }).theme).toBe(before);
    await mutate(reseller, 'post', '/api/packages', { name: 'resellerplan', disk_mb: 512 }, resellerCsrf).expect(201);
    const own = await mutate(reseller, 'put', '/api/themes/packages/resellerplan', { theme: 'jupiter-dark' }, resellerCsrf).expect(200);
    expect(own.body.data).toEqual({ name: 'resellerplan', theme: 'jupiter-dark', accounts: 0 });
    const list = (await reseller.get('/api/themes/packages').expect(200)).body.data;
    expect(list.map((p) => [p.name, p.owned])).toEqual([['default', false], ['resellerplan', true], ['starter', false]]);
    await mutate(app.http, 'delete', '/api/packages/resellerplan', undefined, csrf).expect(200);
    await mutate(plainUser, 'get', '/api/themes/packages', undefined, plainCsrf).expect(403);
  });
  it('refuses to delete a theme a package still uses, then deletes once freed', async () => {
    await put('/api/themes/packages/starter', { theme: 'acme' }).expect(200);
    await del('/api/themes/acme').expect(409);
    await put('/api/themes/packages/starter', { theme: 'jupiter' }).expect(200);
    const res = await del('/api/themes/acme').expect(200);
    expect(res.body.data).toEqual({ slug: 'acme', deleted: true });
    expect(fs.existsSync(path.join(app.dir, 'themes', 'acme.css'))).toBe(false);
    await get('/api/themes/acme').expect(404);
    expect(auditCount('themes.delete')).toBe(1);
  });
});
