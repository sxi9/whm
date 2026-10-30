import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';

// Core /system routes: the settings endpoint refuses values the owning
// consumer cannot use, and the process list accepts the owner names ps prints.
let app;
let csrf;
const PASSWORD = 'Test-Passw0rd!1';
const put = (url, body) => app.http.put(url).set('X-CSRF-Token', csrf).send(body);
const get = (url) => app.http.get(url);

beforeAll(async () => {
  const agent = createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['ps', 'renice'].includes(n)])),
    'sys.processes': ({ user }) => [{ pid: 777, ppid: 1, user: user || 'root', cpuPercent: 0, memPercent: 0.1, rssBytes: 1024, vszBytes: 2048, elapsedSeconds: 10, state: 'S', command: 'exim4', args: '-bd -q30m' }],
  });
  app = await createTestApp({ agent, overrides: { loginRateLimit: { windowMs: 15 * 60 * 1000, max: 1000 } } });
  await app.ctx.capabilities.refresh();
  csrf = await app.login();
}, 30_000);
afterAll(async () => { await app?.close(); });

describe('PUT /system/settings', () => {
  const CPHULK = ['security.cphulk.max_failures_per_ip', 'security.cphulk.lockout_minutes'];
  beforeEach(() => { app.ctx.settings.setMany({ [CPHULK[0]]: 15, [CPHULK[1]]: 30, 'tweak.max_emails_per_hour': 0 }); });

  it('refuses a cleared or out-of-range cPHulk threshold with a field error and stores nothing', async () => {
    const cleared = await put('/api/system/settings', { [CPHULK[0]]: null, 'tweak.max_emails_per_hour': 7 });
    expect(cleared.status).toBe(422);
    expect(cleared.body.error.code).toBe('validation_failed');
    expect(cleared.body.error.fields[CPHULK[0]]).toHaveLength(1);
    expect(cleared.body.error.fields['tweak.max_emails_per_hour']).toBeUndefined();
    expect(app.ctx.settings.get(CPHULK[0])).toBe(15);
    expect(app.ctx.settings.get('tweak.max_emails_per_hour')).toBe(0);

    for (const bad of [0, -1, 1.5, '30', true]) {
      const res = await put('/api/system/settings', { [CPHULK[1]]: bad });
      expect(res.status, String(bad)).toBe(422);
      expect(res.body.error.fields[CPHULK[1]], String(bad)).toHaveLength(1);
    }
    expect(app.ctx.settings.get(CPHULK[1])).toBe(30);
  });

  it('stores values the registry accepts, and keys it does not know as sent', async () => {
    const ok = await put('/api/system/settings', { [CPHULK[0]]: 3, [CPHULK[1]]: 10, 'analytics.enabled': true, 'web.force_https': false });
    expect(ok.status).toBe(200);
    expect(ok.body.data[CPHULK[0]]).toBe(3);
    expect(app.ctx.settings.get(CPHULK[1])).toBe(10);
    expect(app.ctx.settings.get('analytics.enabled')).toBe(true);
    expect(app.ctx.settings.get('web.force_https')).toBe(false);
    // A nullable registry entry still takes null ("use the default").
    expect((await put('/api/system/settings', { 'security.password.strength.ftp': null })).status).toBe(200);
    expect((await put('/api/system/settings', { 'basic.home_root': '/home/' })).status).toBe(422);
    expect((await put('/api/system/settings', { 'backup.schedule': 'every day' })).status).toBe(422);
  });
});

describe('PATCH /system/schedules/:name', () => {
  const patch = (url, body) => app.http.patch(url).set('X-CSRF-Token', csrf).send(body);

  it('answers an out-of-range cron with a field error and an unknown schedule with 404', async () => {
    const row = app.ctx.scheduler.list()[0];
    expect(row).toBeTruthy();
    for (const bad of ['0 0 * * 8', '60 * * * *', '0 25 * * *']) {
      const res = await patch(`/api/system/schedules/${row.name}`, { cron: bad });
      expect(res.status, bad).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.fields.cron, bad).toHaveLength(1);
    }
    expect(app.ctx.scheduler.list().find((r) => r.name === row.name).cron).toBe(row.cron);

    const missing = await patch('/api/system/schedules/does-not-exist', { enabled: false });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
    expect(missing.body.data).toBeUndefined();

    const ok = await patch(`/api/system/schedules/${row.name}`, { cron: row.cron });
    expect(ok.status).toBe(200);
    expect(ok.body.data.name).toBe(row.name);
  });
});

describe('cPHulk with unusable stored thresholds', () => {
  beforeEach(() => {
    app.ctx.db.prepare('DELETE FROM cphulk_blocks').run();
    app.ctx.db.prepare('DELETE FROM login_attempts').run();
    app.ctx.settings.set('security.cphulk.enabled', true);
  });
  afterAll(() => { app.ctx.settings.setMany({ 'security.cphulk.max_failures_per_ip': 15, 'security.cphulk.lockout_minutes': 30 }); });

  it('falls back to the shipped defaults instead of blocking after one failure or forever', async () => {
    app.ctx.settings.setMany({ 'security.cphulk.max_failures_per_ip': null, 'security.cphulk.lockout_minutes': null });
    const client = request.agent(app.ctx.app);
    expect((await client.post('/api/auth/login').send({ username: 'root', password: 'wrong-password-1' })).status).toBe(401);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM cphulk_blocks').get().n).toBe(0);
    expect((await client.post('/api/auth/login').send({ username: 'root', password: PASSWORD })).status).toBe(200);

    app.ctx.settings.setMany({ 'security.cphulk.max_failures_per_ip': 2, 'security.cphulk.lockout_minutes': null });
    app.ctx.db.prepare('DELETE FROM login_attempts').run();
    const other = request.agent(app.ctx.app);
    for (let i = 0; i < 2; i++) expect((await other.post('/api/auth/login').send({ username: 'root', password: 'wrong-password-2' })).status).toBe(401);
    const block = app.ctx.db.prepare('SELECT expires_at FROM cphulk_blocks ORDER BY id DESC LIMIT 1').get();
    expect(block).toBeTruthy();
    expect(block.expires_at).not.toBeNull();
    expect((await other.post('/api/auth/login').send({ username: 'root', password: PASSWORD })).status).toBe(429);
  });
});

describe('process list owner filter', () => {
  it('accepts the owner names ps prints on both process routes', async () => {
    for (const base of ['/api/system', '/api/system-health']) {
      for (const user of ['Debian-exim', '_apt', 'systemd+', 'www-data', '1000', 'machine$']) {
        const res = await get(`${base}/processes?user=${encodeURIComponent(user)}`);
        expect(res.status, `${base} ${user}`).toBe(200);
        expect(res.body.data[0].user).toBe(user);
        expect(app.agent.callsTo('sys.processes').at(-1).args.user).toBe(user);
      }
      for (const bad of ['-r', '--help', 'a b', 'root;id', 'a/b', 'a'.repeat(33)]) {
        expect((await get(`${base}/processes?user=${encodeURIComponent(bad)}`)).status, `${base} ${bad}`).toBe(422);
      }
    }
  });
});
