import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, createMockAgent } from './support/app.js';

// Service Manager / dashboard on a Debian-family host whose PHP-FPM unit is a
// branch newer than any seeded candidate (php8.5-fpm).
let app;
let csrf;

beforeAll(async () => {
  const agent = createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['php', 'apache2ctl', 'systemctl'].includes(n)])),
    'svc.list_units': () => ['apache2', 'php8.5-fpm', 'phpsessionclean', 'ssh'],
    'svc.restart': ({ unit }) => ({ unit, verb: 'restart', output: '' }),
  });
  app = await createTestApp({ agent });
  csrf = await app.login();
});

afterAll(async () => { await app?.close(); });

describe('php-fpm unit discovery', () => {
  it('seeds the newer PHP branches as candidates', () => {
    const row = app.ctx.db.prepare("SELECT unit_candidates FROM services WHERE name = 'php-fpm'").get();
    expect(JSON.parse(row.unit_candidates)).toEqual(expect.arrayContaining(['php8.5-fpm', 'php8.4-fpm', 'php8.3-fpm']));
  });

  it('reports php8.5-fpm as the installed unit in the Service Manager and on the dashboard', async () => {
    const list = await app.http.get('/api/system/services');
    expect(list.status).toBe(200);
    const php = list.body.data.find((s) => s.name === 'php-fpm');
    expect(php).toMatchObject({ unit: 'php8.5-fpm', installed: true, active: true, state: 'active' });
    expect(list.body.data.find((s) => s.name === 'httpd')).toMatchObject({ unit: 'apache2', installed: true });
    expect(list.body.data.find((s) => s.name === 'named')).toMatchObject({ unit: null, installed: false, state: 'not-installed' });

    const status = await app.http.get('/api/system/status');
    expect(status.status).toBe(200);
    expect(status.body.data.services.find((s) => s.name === 'php-fpm')).toMatchObject({ unit: 'php8.5-fpm', installed: true, active: true });
  });

  it('runs service actions against the discovered unit', async () => {
    const res = await app.http.post('/api/system/services/php-fpm/restart').set('X-CSRF-Token', csrf).send({});
    expect(res.status).toBe(200);
    expect(app.agent.callsTo('svc.restart').pop().args).toEqual({ unit: 'php8.5-fpm' });
  });

  it('falls back to the newest branch when the seeded list is stale', async () => {
    app.ctx.db.prepare("UPDATE services SET unit_candidates = '[\"php-fpm\",\"php8.3-fpm\"]' WHERE name = 'php-fpm'").run();
    app.agent.set('svc.list_units', () => ['apache2', 'php8.4-fpm', 'php8.6-fpm', 'php8.5-fpm']);
    await app.ctx.capabilities.refresh();
    const php = (await app.http.get('/api/system/services')).body.data.find((s) => s.name === 'php-fpm');
    expect(php).toMatchObject({ unit: 'php8.6-fpm', installed: true, candidates: ['php-fpm', 'php8.3-fpm'] });
  });
});
