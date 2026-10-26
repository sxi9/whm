import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { readBootId, REBOOT_MODES } from '../src/services/system-reboot.js';

describe('System Reboot API', () => {
  let app;
  let csrf;
  let reseller;
  let resellerCsrf;
  let systemctlInstalled = true;
  let rebootRequired = false;
  let reboots = [];

  const post = (url, body = {}) => app.http.post(url).set('X-CSRF-Token', csrf).send(body);
  const get = (url) => app.http.get(url);
  const auditRows = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
  const requests = () => app.ctx.db.prepare('SELECT * FROM reboot_requests ORDER BY id').all();
  const clearWork = () => {
    app.ctx.db.prepare("DELETE FROM jobs WHERE status IN ('queued', 'running')").run();
    app.ctx.db.prepare('DELETE FROM transfer_runs').run();
    app.ctx.db.prepare('DELETE FROM backup_runs').run();
  };

  beforeAll(async () => {
    const agent = createMockAgent({
      'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, systemctlInstalled && n === 'systemctl'])),
      'sys.reboot': ({ mode }) => { reboots.push(mode); return { scheduled: true, mode }; },
      'pkg.reboot_required': () => ({ rebootRequired }),
    });
    app = await createTestApp({ agent });
    csrf = await app.login();
    const r = await app.createUser('resell1', 'reseller');
    reseller = request.agent(app.ctx.app);
    resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
  }, 30_000);

  afterAll(async () => { await app?.close(); });

  beforeEach(async () => {
    systemctlInstalled = true;
    rebootRequired = false;
    reboots = [];
    clearWork();
    await app.ctx.capabilities.refresh();
  });

  it('registers the module: service on ctx with both modes', () => {
    expect(REBOOT_MODES).toEqual(['graceful', 'forceful']);
    for (const m of ['preflight', 'reboot', 'graceful', 'forceful', 'history', 'rebootedSinceLastRequest']) expect(typeof app.ctx.systemReboot[m], m).toBe('function');
    expect(app.ctx.capabilities.snapshot().capabilities.systemd).toMatchObject({ installed: true });
  });

  it('GET /preflight reports host facts, capability, idle work and no previous request', async () => {
    const res = await get('/api/system-reboot/preflight').expect(200);
    const { data } = res.body;
    // Basic Setup's hostname setting wins over what sys.info reports.
    expect(data.hostname).toBe(app.ctx.settings.get('basic.hostname') || 'test.example.com');
    expect(data.uptimeSeconds).toBe(3600);
    expect(data.capability).toEqual({ systemd: true, systemctl: true });
    expect(data.rebootRequired).toBe(false);
    expect(data.jobs).toMatchObject({ running: 0, queued: 0, workerActive: 0, items: [] });
    expect(data.transfers).toEqual({ available: true, count: 0, items: [] });
    expect(data.backups).toMatchObject({ available: true, count: 0 });
    expect(data.restores).toMatchObject({ available: true, count: 0 });
    expect(data.warnings).toEqual([]);
    expect(data.activeWork).toBe(false);
    expect(data.lastRequest).toBeNull();
    expect(data.bootId).toBe(readBootId());
  });

  it('GET /preflight counts running/queued jobs, active transfers and backups as warnings', async () => {
    const { db } = app.ctx;
    db.prepare("INSERT INTO jobs (type, status, progress, message, params_json) VALUES ('backup.run', 'running', 40, 'dumping databases', '{}')").run();
    db.prepare("INSERT INTO jobs (type, status, params_json) VALUES ('dns.sync', 'queued', '{}')").run();
    db.prepare("INSERT INTO jobs (type, status, params_json) VALUES ('dns.sync', 'done', '{}')").run();
    db.prepare("INSERT INTO transfer_runs (kind, status, source, requested_by) VALUES ('transfer', 'running', '10.0.0.9', 'root')").run();
    db.prepare("INSERT INTO transfer_runs (kind, status) VALUES ('restore', 'done')").run();
    db.prepare("INSERT INTO backup_runs (status) VALUES ('queued')").run();
    rebootRequired = true;
    const { data } = (await get('/api/system-reboot/preflight').expect(200)).body;
    expect(data.jobs).toMatchObject({ running: 1, queued: 1 });
    expect(data.jobs.items.map((j) => [j.type, j.status])).toEqual([['dns.sync', 'queued'], ['backup.run', 'running']]);
    expect(data.transfers.count).toBe(1);
    expect(data.transfers.items[0]).toMatchObject({ kind: 'transfer', status: 'running', source: '10.0.0.9' });
    expect(data.backups.count).toBe(1);
    expect(data.rebootRequired).toBe(true);
    expect(data.activeWork).toBe(true);
    expect(data.warnings).toEqual([
      '1 job(s) are running and will be interrupted',
      '1 job(s) are queued and will restart after boot',
      '1 account transfer(s) or restore(s) are in progress',
      '1 backup run(s) are in progress',
    ]);
  });

  it('pre-flight survives a missing reboot-required probe and a failing sys.info', async () => {
    app.agent.fail('pkg.reboot_required', 'binary_not_found');
    app.agent.fail('sys.info', 'command_failed');
    try {
      const { data } = (await get('/api/system-reboot/preflight').expect(200)).body;
      expect(data.rebootRequired).toBeNull();
      expect(data.uptimeSeconds).toBeNull();
      expect(data.hostname).toBe(app.ctx.settings.get('basic.hostname') || null);
      expect(data.capability.systemd).toBe(true);
    } finally {
      app.agent.set('pkg.reboot_required', () => ({ rebootRequired }));
      app.agent.reset('sys.info');
    }
  });

  it('POST /graceful runs sys.reboot graceful, records the request and audits it', async () => {
    const res = await post('/api/system-reboot/graceful', { reason: 'kernel update' }).expect(200);
    const { data } = res.body;
    expect(reboots).toEqual(['graceful']);
    expect(app.agent.callsTo('sys.reboot').at(-1).args).toEqual({ mode: 'graceful' });
    expect(data).toMatchObject({ mode: 'graceful', principal: 'root', reason: 'kernel update', status: 'triggered', scheduled: true });
    expect(data.preflight.activeWork).toBe(false);
    expect(data.boot_id).toBe(readBootId());
    const rows = requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'graceful', principal: 'root', reason: 'kernel update', status: 'triggered', error: null });
    expect(JSON.parse(rows[0].preflight_json).hostname).toBe(app.ctx.settings.get('basic.hostname') || 'test.example.com');
    const audit = auditRows('system.reboot');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ principal: 'root', target: 'graceful', result: 'ok' });
    expect(JSON.parse(audit[0].args_redacted)).toMatchObject({ mode: 'graceful', reason: 'kernel update', ignoreActiveWork: false, warnings: [] });
    const pre = (await get('/api/system-reboot/preflight').expect(200)).body.data;
    expect(pre.lastRequest).toMatchObject({ mode: 'graceful', status: 'triggered', completed: false });
    expect(app.ctx.systemReboot.rebootedSinceLastRequest()).toBe(false);
  });

  it('POST /forceful passes mode forceful to the agent', async () => {
    const res = await post('/api/system-reboot/forceful', {}).expect(200);
    expect(reboots).toEqual(['forceful']);
    expect(app.agent.callsTo('sys.reboot').at(-1).args).toEqual({ mode: 'forceful' });
    expect(res.body.data).toMatchObject({ mode: 'forceful', reason: null, status: 'triggered' });
    expect(auditRows('system.reboot').at(-1)).toMatchObject({ target: 'forceful' });
  });

  it('refuses with 409 while work is in progress unless ignoreActiveWork is set', async () => {
    app.ctx.db.prepare("INSERT INTO jobs (type, status, params_json) VALUES ('transfer.run', 'running', '{}')").run();
    const before = requests().length;
    const blocked = await post('/api/system-reboot/graceful', {}).expect(409);
    expect(blocked.body.error.code).toBe('active_work');
    expect(blocked.body.error.message).toMatch(/1 job\(s\) are running/);
    expect(reboots).toEqual([]);
    expect(requests()).toHaveLength(before);
    const ok = await post('/api/system-reboot/forceful', { ignoreActiveWork: true, reason: 'hung' }).expect(200);
    expect(reboots).toEqual(['forceful']);
    expect(ok.body.data.preflight.warnings).toEqual(['1 job(s) are running and will be interrupted']);
    expect(JSON.parse(auditRows('system.reboot').at(-1).args_redacted)).toMatchObject({ ignoreActiveWork: true, warnings: ['1 job(s) are running and will be interrupted'] });
  });

  it('writes the history row and the audit entry before the reboot command runs', async () => {
    const before = requests().length;
    let seen = null;
    app.agent.set('sys.reboot', ({ mode }) => {
      seen = { rows: requests(), audit: auditRows('system.reboot') };
      reboots.push(mode);
      return { scheduled: true, mode };
    });
    try {
      const res = await post('/api/system-reboot/forceful', { reason: 'pre-record' }).expect(200);
      expect(seen.rows).toHaveLength(before + 1);
      expect(seen.rows.at(-1)).toMatchObject({ mode: 'forceful', reason: 'pre-record', status: 'requested', error: null, boot_id: readBootId() });
      expect(seen.rows.at(-1).triggered_at).toBeNull();
      expect(seen.audit.at(-1)).toMatchObject({ principal: 'root', target: 'forceful', result: 'ok' });
      expect(JSON.parse(seen.audit.at(-1).args_redacted)).toMatchObject({ reason: 'pre-record', requestId: seen.rows.at(-1).id });
      expect(res.body.data).toMatchObject({ id: seen.rows.at(-1).id, status: 'triggered' });
      expect(requests().at(-1)).toMatchObject({ id: seen.rows.at(-1).id, status: 'triggered' });
      expect(requests().at(-1).triggered_at).not.toBeNull();
    } finally {
      app.agent.set('sys.reboot', ({ mode }) => { reboots.push(mode); return { scheduled: true, mode }; });
    }
  });

  it('a request whose outcome was never recorded counts as completed once the boot id changes', async () => {
    app.ctx.db.prepare("INSERT INTO reboot_requests (mode, principal, status, boot_id) VALUES ('graceful', 'root', 'requested', 'previous-boot')").run();
    const { data } = (await get('/api/system-reboot/preflight').expect(200)).body;
    expect(data.lastRequest).toMatchObject({ mode: 'graceful', status: 'requested', completed: Boolean(readBootId()) });
    expect(app.ctx.systemReboot.rebootedSinceLastRequest()).toBe(Boolean(readBootId()));
    expect(() => app.ctx.db.prepare("INSERT INTO reboot_requests (mode, status) VALUES ('graceful', 'bogus')").run()).toThrow(/CHECK/);
  });

  it('records a failed request and surfaces the agent error when the reboot command fails', async () => {
    app.agent.fail('sys.reboot', 'command_failed', 'systemctl exited with 1');
    const before = requests().length;
    try {
      const res = await post('/api/system-reboot/graceful', { reason: 'test' }).expect(500);
      expect(res.body.error.message).toMatch(/systemctl exited with 1/);
      expect(requests()).toHaveLength(before + 1);
      const last = requests().at(-1);
      expect(last).toMatchObject({ mode: 'graceful', status: 'failed', error: 'systemctl exited with 1', reason: 'test', triggered_at: null });
      expect(auditRows('system.reboot').at(-2)).toMatchObject({ target: 'graceful', result: 'ok' });
      expect(auditRows('system.reboot').at(-1)).toMatchObject({ target: 'graceful', result: 'error:command_failed' });
      const pre = (await get('/api/system-reboot/preflight').expect(200)).body.data;
      expect(pre.lastRequest).toMatchObject({ status: 'failed', completed: false });
    } finally {
      app.agent.set('sys.reboot', ({ mode }) => { reboots.push(mode); return { scheduled: true, mode }; });
    }
  });

  it('keeps each stored pre-flight snapshot bounded: the previous request is embedded without its own snapshot', async () => {
    app.ctx.db.prepare("INSERT INTO jobs (type, status, params_json) VALUES ('dns.sync', 'queued', '{}')").run();
    const sizes = [];
    for (let i = 0; i < 6; i += 1) {
      const { data } = (await post('/api/system-reboot/graceful', { ignoreActiveWork: true, reason: `round ${i}` }).expect(200)).body;
      expect(data.preflight.lastRequest === null || !('preflight' in data.preflight.lastRequest)).toBe(true);
      sizes.push(requests().at(-1).preflight_json.length);
    }
    const stored = JSON.parse(requests().at(-1).preflight_json);
    expect(stored.lastRequest).toMatchObject({ reason: 'round 4', status: 'triggered' });
    expect(stored.lastRequest).not.toHaveProperty('preflight');
    expect(stored.lastRequest).not.toHaveProperty('preflight_json');
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(200);
    const pre = (await get('/api/system-reboot/preflight').expect(200)).body.data;
    expect(pre.lastRequest).toMatchObject({ reason: 'round 5' });
    expect(pre.lastRequest).not.toHaveProperty('preflight');
    const history = (await get('/api/system-reboot/history?limit=200').expect(200)).body.data;
    for (const row of history) expect(row.preflight.lastRequest?.preflight).toBeUndefined();
  });

  it('GET /history lists requests newest first with the stored pre-flight', async () => {
    const res = await get('/api/system-reboot/history?limit=2').expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBeGreaterThan(res.body.data[1].id);
    expect(res.body.data[0].preflight).toHaveProperty('warnings');
    expect(res.body.data[0]).not.toHaveProperty('preflight_json');
    const all = (await get('/api/system-reboot/history').expect(200)).body.data;
    expect(all.length).toBe(requests().length);
    await get('/api/system-reboot/history?limit=0').expect(422);
    await get('/api/system-reboot/history?limit=abc').expect(422);
  });

  it('rejects invalid input with 422 without touching the agent', async () => {
    const before = app.agent.callsTo('sys.reboot').length;
    await post('/api/system-reboot/soft', {}).expect(422);
    await post('/api/system-reboot/graceful', { mode: 'forceful' }).expect(422);
    await post('/api/system-reboot/graceful', { reason: 'x'.repeat(201) }).expect(422);
    await post('/api/system-reboot/graceful', { reason: 42 }).expect(422);
    await post('/api/system-reboot/graceful', { ignoreActiveWork: 'yes' }).expect(422);
    await post('/api/system-reboot/forceful', { force: true }).expect(422);
    expect(reboots).toEqual([]);
    expect(app.agent.callsTo('sys.reboot')).toHaveLength(before);
  });

  it('is root-only: resellers get 403 everywhere', async () => {
    const before = app.agent.callsTo('sys.reboot').length;
    expect((await reseller.get('/api/system-reboot/preflight')).status).toBe(403);
    expect((await reseller.get('/api/system-reboot/history')).status).toBe(403);
    expect((await reseller.post('/api/system-reboot/graceful').set('X-CSRF-Token', resellerCsrf).send({})).status).toBe(403);
    expect((await reseller.post('/api/system-reboot/forceful').set('X-CSRF-Token', resellerCsrf).send({ ignoreActiveWork: true })).status).toBe(403);
    expect(app.agent.callsTo('sys.reboot')).toHaveLength(before);
    expect(reboots).toEqual([]);
  });

  it('degrades to 501 capability_missing without systemctl and records nothing', async () => {
    systemctlInstalled = false;
    await app.ctx.capabilities.refresh();
    const before = requests().length;
    const pre = await get('/api/system-reboot/preflight').expect(200);
    expect(pre.body.data.capability).toEqual({ systemd: false, systemctl: false });
    for (const mode of REBOOT_MODES) {
      const res = await post(`/api/system-reboot/${mode}`, { ignoreActiveWork: true }).expect(501);
      expect(res.body.error.code).toBe('capability_missing');
      expect(res.body.error.capability).toBe('systemd');
      expect(res.body.error.message).toMatch(/systemctl/);
    }
    expect(reboots).toEqual([]);
    expect(requests()).toHaveLength(before);
  });

  it('maps a binary_not_found agent error to 501 and records the failed attempt', async () => {
    app.agent.fail('sys.reboot', 'binary_not_found', 'Required program "systemctl" is not installed on this server');
    try {
      const res = await post('/api/system-reboot/forceful', {}).expect(501);
      expect(res.body.error.code).toBe('binary_not_found');
      expect(requests().at(-1)).toMatchObject({ mode: 'forceful', status: 'failed' });
    } finally {
      app.agent.set('sys.reboot', ({ mode }) => { reboots.push(mode); return { scheduled: true, mode }; });
    }
  });
});
