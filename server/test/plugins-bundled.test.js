import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestApp, waitForJob } from './support/app.js';
import { BUNDLED_PLUGINS, BUNDLED_DIR } from '../src/services/plugins-bundled.js';

// The fourth bundled plugin (Phase 5 U6): Automated Backup has no function page
// (fnKey null); its ui:sidebar pages under Backup carry its UI.
const AB = 'net.whm.automated-backup';

describe('bundled plugin: Automated Backup installs at boot', () => {
  let app;
  let csrf;
  const post = (url, body = {}) => app.http.post(url).set('X-CSRF-Token', csrf).send(body);
  const put = (url, body = {}) => app.http.put(url).set('X-CSRF-Token', csrf).send(body);
  const get = (url) => app.http.get(url);

  beforeAll(async () => {
    app = await createTestApp({ overrides: { bundledPlugins: true } });
    csrf = await app.login();
    await post('/api/accounts', { username: 'alice', domain: 'alice.com' }).expect(201);
    app.ctx.jobs.start();
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  it('is the fourth BUNDLED_PLUGINS entry with fnKey null and ships a valid package', async () => {
    const def = BUNDLED_PLUGINS.find((p) => p.id === AB);
    expect(def).toEqual({ id: AB, fnKey: null, label: 'Automated Backup', roles: ['root'] });
    expect(fs.existsSync(path.join(BUNDLED_DIR, AB, 'main.js'))).toBe(true);
    expect(app.ctx.plugins.isLive(AB)).toBe(true);
    expect(app.ctx.db.prepare('SELECT action, installed_version FROM bundled_plugins WHERE id = ?').get(AB)).toEqual({ action: 'installed', installed_version: '1.0.0' });
    const row = app.ctx.plugins.get(AB);
    expect(row).toMatchObject({ id: AB, state: 'enabled', source: 'bundled', signed: false, version: '1.0.0' });
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'plugin.install' AND target = ?").get(AB).n).toBe(1);
  });

  it('GET /api/bundled-plugins tolerates fnKey null and reports the plugin pages', async () => {
    const one = (await get(`/api/bundled-plugins/${AB}`).expect(200)).body.data;
    expect(one).toMatchObject({ id: AB, label: 'Automated Backup', fnKey: null, state: 'enabled', enabled: true, installedVersion: '1.0.0', roles: ['root'], canUse: true });
    expect(one.pages.map((p) => p.route).sort()).toEqual(['/artefacts', '/destinations', '/help', '/history', '/locks', '/restore', '/run-now', '/settings']);
    const ui = (await get('/api/plugins/ui').expect(200)).body.data.find((p) => p.id === AB);
    expect(ui.sidebar).toEqual([{ category: 'Backup', label: 'Automated Backup', route: '/history', icon: 'archive' }]);
    expect(ui.pages.find((p) => p.route === '/artefacts')).toMatchObject({ kind: 'table', source: '/artefacts', origin: 'manifest' });
    expect(ui.pages.find((p) => p.route === '/restore')).toMatchObject({ kind: 'form', source: '/restore', origin: 'manifest' });
    expect(ui.pages.find((p) => p.route === '/help')).toMatchObject({ kind: 'markdown', origin: 'runtime' });
  });

  it('serves its routes to root only and is unscheduled until the cron setting is set', async () => {
    const status = await get(`/api/plugins/${AB}/status`).expect(200);
    expect(status.body.data).toMatchObject({ scope: 'all', scheduled: false, schedule: null, nextRunAt: null, lastRun: null, locks: 0, archives: 0, destinations: [] });
    expect((await get(`/api/plugins/${AB}/runs`).expect(200)).body.data).toEqual([]);
    expect((await get(`/api/plugins/${AB}/destinations`).expect(200)).body.data).toEqual([]);
    expect(app.ctx.scheduler.listPrefix(`plugin:${AB}:`)).toEqual([]);
    await put(`/api/plugins/manage/${AB}/settings`, { schedule: '0 2 * * *', destinations: 'offsite\nnope' }).expect(200);
    expect(app.ctx.scheduler.listPrefix(`plugin:${AB}:`).map((r) => [r.name, r.cron])).toEqual([[`plugin:${AB}:scheduled-run`, '0 2 * * *']]);
    expect((await get(`/api/plugins/${AB}/status`).expect(200)).body.data).toMatchObject({ scheduled: true, schedule: '0 2 * * *', destinations: ['offsite', 'nope'] });
    expect((await put(`/api/plugins/manage/${AB}/settings`, { accounts: 'Not Valid' })).status).toBe(422);
    await put(`/api/plugins/manage/${AB}/settings`, { schedule: '' }).expect(200);
    expect(app.ctx.scheduler.listPrefix(`plugin:${AB}:`)).toEqual([]);
    const reseller = await app.createUser('resell9', 'reseller');
    const r = (await import('supertest')).default.agent(app.ctx.app);
    await r.post('/api/auth/login').send({ username: reseller.username, password: reseller.password }).expect(200);
    await r.get(`/api/plugins/${AB}/runs`).expect(403);
  });

  it('a job started from a plugin route is owned by the request principal, so a reseller can follow it', async () => {
    const reseller = await app.createUser('resell1', 'reseller');
    await post('/api/accounts', { username: 'racct1', domain: 'racct1.com', owner: 'resell1' }).expect(201);
    app.agent.set('web.wp.discover', () => ({ installs: [] }));
    const r = (await import('supertest')).default.agent(app.ctx.app);
    const login = await r.post('/api/auth/login').send({ username: reseller.username, password: reseller.password }).expect(200);
    const res = await r.post('/api/plugins/net.whm.wp-toolkit/discover').set('X-CSRF-Token', login.body.data.csrfToken).send({ background: true }).expect(202);
    const id = Number(res.body.data.jobId);
    expect(app.ctx.jobs.get(id)).toMatchObject({ type: 'plugin:net.whm.wp-toolkit:discover', created_by: reseller.id, params: { trigger: 'manual', params: { usernames: ['racct1'] } } });
    expect((await r.get(`/api/system/jobs/${id}`).expect(200)).body.data).toMatchObject({ id, created_by: reseller.id });
    expect((await r.get('/api/system/jobs').expect(200)).body.data.map((j) => j.id)).toContain(id);
    expect((await waitForJob(app.ctx, id, 15_000)).status).toBe('done');
  }, 30_000);

  it('a run job on the real host records warnings for unknown accounts and destinations and leaves no locks', async () => {
    await put(`/api/plugins/manage/${AB}/settings`, { scope: 'accounts', accounts: 'ghost', destinations: 'nope' }).expect(200);
    const res = await post(`/api/plugins/manage/${AB}/jobs/run`, { params: { source: 'manual' } }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id, 15_000);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ status: 'ok', accounts: 0, ok: 0, failed: 0, pruned: 0 });
    expect(job.result.warnings.map((w) => w.code).sort()).toEqual(['unknown_account', 'unknown_destination']);
    const runs = (await get(`/api/plugins/${AB}/runs`).expect(200)).body.data;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'run', source: 'manual', status: 'ok', accounts: 0, warnings: 2 });
    expect((await get(`/api/plugins/${AB}/locks`).expect(200)).body.data).toEqual([]);
  }, 30_000);

  it('restore tokens come from the manage API and a restore of an unknown archive fails the job and is recorded', async () => {
    const tok = await post(`/api/plugins/manage/${AB}/restore-token`, { artefactId: '1', account: 'alice' }).expect(200);
    expect(tok.body.data.token).toMatch(/^[0-9a-f]{32}$/);
    const bad = await post(`/api/plugins/${AB}/restore`, { artefactId: 'x y', account: 'alice', confirmToken: 'short' });
    expect(bad.status).toBe(400);
    const res = await post(`/api/plugins/${AB}/restore`, { artefactId: '1', account: 'alice', confirmToken: tok.body.data.token }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id, 15_000);
    expect(job.status).toBe('failed');
    const restores = (await get(`/api/plugins/${AB}/runs?kind=restore`).expect(200)).body.data;
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatchObject({ kind: 'restore', status: 'failed', account: 'alice', artefactId: '1' });
    expect(restores[0].results[0].error.code).toBeTruthy();
  }, 30_000);
});
