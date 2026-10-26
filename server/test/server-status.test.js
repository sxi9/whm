import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { parseScoreboard, pickTopProcesses, throughputBetween, dayKey } from '../src/services/server-status.js';

const SCOREBOARD = 'WW__K.....R_';
const APACHE_UNIT = { unit: 'apache2', installed: true, active: true, state: 'active', subState: 'running', enabled: true, pid: 100, memoryBytes: 1024, restarts: 0 };
const PROCS = [
  { pid: 1, ppid: 0, user: 'root', cpuPercent: 0.1, memPercent: 0.2, rssBytes: 1024 * 1024, vszBytes: 0, elapsedSeconds: 1000, state: 'S', command: 'systemd', args: '' },
  { pid: 200, ppid: 1, user: 'www-data', cpuPercent: 45.5, memPercent: 3.1, rssBytes: 50 * 1024 * 1024, vszBytes: 0, elapsedSeconds: 500, state: 'R', command: 'apache2', args: '-k start' },
  { pid: 201, ppid: 1, user: 'www-data', cpuPercent: 10, memPercent: 2.5, rssBytes: 40 * 1024 * 1024, vszBytes: 0, elapsedSeconds: 500, state: 'S', command: 'apache2', args: '-k start' },
  { pid: 300, ppid: 1, user: 'mysql', cpuPercent: 0.5, memPercent: 40, rssBytes: 900 * 1024 * 1024, vszBytes: 0, elapsedSeconds: 9000, state: 'S', command: 'mariadbd', args: '' },
  { pid: 400, ppid: 1, user: 'alice', cpuPercent: 5, memPercent: 1, rssBytes: 8 * 1024 * 1024, vszBytes: 0, elapsedSeconds: 10, state: 'R', command: 'php-fpm8.3', args: 'pool alice' },
];

describe('server-status helpers', () => {
  it('parses an Apache scoreboard into per-state counts', () => {
    const sb = parseScoreboard(SCOREBOARD);
    expect(sb.total).toBe(12);
    expect(sb.open).toBe(5);
    expect(sb.used).toBe(7);
    expect(Object.fromEntries(sb.states.map((s) => [s.key, s.count]))).toMatchObject({ sending: 2, waiting: 3, keepalive: 1, reading: 1, open: 5, starting: 0 });
    expect(parseScoreboard('')).toMatchObject({ total: 0, used: 0 });
    expect(parseScoreboard('W?').other).toBe(1);
  });

  it('picks top-N by CPU and by memory without duplicates', () => {
    const picked = pickTopProcesses(PROCS, 2);
    expect(picked.map((p) => p.pid).sort()).toEqual([200, 201, 300]);
    expect(pickTopProcesses([], 5)).toEqual([]);
  });

  it('derives recent throughput between two probes and rejects counter resets', () => {
    expect(throughputBetween({ at: 0, totalAccesses: 100, totalKBytes: 10 }, { at: 10_000, totalAccesses: 150, totalKBytes: 20 })).toEqual({ windowSeconds: 10, requestsPerSecond: 5, bytesPerSecond: 1024 });
    expect(throughputBetween({ at: 0, totalAccesses: 100 }, { at: 10_000, totalAccesses: 50 })).toBeNull();
    expect(throughputBetween(null, { at: 1, totalAccesses: 1 })).toBeNull();
    expect(dayKey(new Date('2026-10-26T23:59:59Z'))).toBe('2026-10-26');
  });
});

describe('Server Status API', () => {
  let app;
  let csrf;
  let resellerHttp;
  let resellerCsrf;
  let apacheInstalled = false;
  let modStatus = true;
  let apacheActive = true;
  let serverStatus = true;
  let procs = PROCS;
  let workersMode = 'extended';
  const WORKER_COLUMNS = ['Srv', 'PID', 'Acc', 'M', 'CPU', 'SS', 'Req', 'Dur', 'Conn', 'Child', 'Slot', 'Client', 'Protocol', 'VHost', 'Request'].map((h) => ({ header: h, key: h.toLowerCase(), label: h, title: h }));
  const WORKERS = [
    { srv: '0-2', slot: 0, generation: 2, pid: 31337, acc: { connection: 0, child: 12, slot: 345 }, mode: 'W', cpuSeconds: 0.53, secondsSinceRequest: 0, requestMs: 125, durationMs: 14450, connKBytes: 3.4, childMBytes: 1.25, slotMBytes: 40.11, client: '203.0.113.9', protocol: 'http/1.1', vhost: 'example.com:80', request: 'GET /wp-admin/index.php HTTP/1.1', extra: {} },
    { srv: '1-2', slot: 1, generation: 2, pid: 31338, acc: { connection: 2, child: 7, slot: 90 }, mode: 'K', cpuSeconds: 0.1, secondsSinceRequest: 3, requestMs: 4, durationMs: 900, connKBytes: 0, childMBytes: 0.3, slotMBytes: 9, client: '198.51.100.4', protocol: 'h2', vhost: 'shop.example.net:443', request: 'GET /index.html HTTP/2.0', extra: {} },
    { srv: '2-2', slot: 2, generation: 2, pid: 31339, acc: { connection: 0, child: 1, slot: 1 }, mode: '_', cpuSeconds: 0, secondsSinceRequest: 40, requestMs: 1, durationMs: 1, connKBytes: 0, childMBytes: 0, slotMBytes: 0, client: '203.0.113.9', protocol: 'http/1.1', vhost: 'example.com:80', request: 'GET /favicon.ico HTTP/1.1', extra: {} },
    { srv: '3-0', slot: 3, generation: 0, pid: null, acc: { connection: 0, child: 0, slot: 0 }, mode: '.', cpuSeconds: 0, secondsSinceRequest: 0, requestMs: 0, durationMs: 0, connKBytes: 0, childMBytes: 0, slotMBytes: 0, client: null, protocol: null, vhost: null, request: null, extra: {} },
  ];

  const workersHandler = ({ port, bind }) => {
    const probe = { host: bind || '127.0.0.1', port };
    if (workersMode === 'down') return { probe, reachable: false, statusPage: false, extended: null, columns: [], workers: [] };
    if (workersMode === 'not_status') return { probe, reachable: true, httpStatus: 404, statusPage: false, extended: null, columns: [], workers: [] };
    if (workersMode === 'basic') return { probe, reachable: true, httpStatus: 200, statusPage: true, extended: false, columns: [], workers: [] };
    return { probe, reachable: true, httpStatus: 200, statusPage: true, extended: true, columns: WORKER_COLUMNS, workers: WORKERS };
  };

  beforeAll(async () => {
    const agent = createMockAgent({
      'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, apacheInstalled && ['apache2ctl', 'systemctl'].includes(n)])),
      'web.status': () => ({
        installed: true, flavor: 'debian', bin: 'apache2ctl', version: 'Apache/2.4.58 (Ubuntu)', built: '2024-01-01', mpm: 'event',
        modules: modStatus ? [{ name: 'status', type: 'shared' }, { name: 'ssl', type: 'shared' }] : [{ name: 'ssl', type: 'shared' }],
        unit: { ...APACHE_UNIT, active: apacheActive }, statusModule: modStatus, managedVhosts: 3, globalInclude: { path: '/etc/apache2/conf-available/whm.conf', exists: true, enabled: true },
        serverStatus: modStatus && apacheActive && serverStatus ? {
          serverVersion: 'Apache/2.4.58 (Ubuntu)', mpm: 'event', uptimeSeconds: 3600, totalAccesses: 12000, totalKBytes: 4096, requestsPerSecond: 3.33, bytesPerSecond: 1165, bytesPerRequest: 349,
          busyWorkers: 3, idleWorkers: 4, cpuLoad: 0.5, scoreboard: SCOREBOARD, load: [0.4, 0.3, 0.2], raw: { ServerVersion: 'Apache/2.4.58 (Ubuntu)', 'Total Accesses': '12000', CPUUser: '1.2', Scoreboard: SCOREBOARD },
        } : null,
      }),
      'sys.processes': () => procs,
      'modstatus.workers': workersHandler,
    });
    app = await createTestApp({ agent });
    app.ctx.jobs.start();
    csrf = await app.login();
    const reseller = await app.createUser('resell1', 'reseller');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  const get = (path) => app.http.get(`/api/server-status${path}`);
  const post = (path, body = {}) => app.http.post(`/api/server-status${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body = {}) => app.http.put(`/api/server-status${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/server-status${path}`).set('X-CSRF-Token', csrf);
  async function provision(installed) {
    apacheInstalled = installed;
    await app.ctx.capabilities.refresh();
  }

  describe('registration', () => {
    it('attaches ctx.serverStatus, the sampler job and its 5-minute schedule', () => {
      expect(app.ctx.serverStatus).toBeDefined();
      expect(app.ctx.jobs.types()).toContain('server_status.process_sample');
      const row = app.ctx.scheduler.list().find((r) => r.name === 'process-log-sampler');
      expect(row).toMatchObject({ cron: '*/5 * * * *', job_type: 'server_status.process_sample', enabled: 1 });
    });
  });

  describe('Apache Status', () => {
    it('returns 501 capability_missing when Apache is not installed', async () => {
      await provision(false);
      const res = await get('/apache').expect(501);
      expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'apache' });
      expect(app.agent.callsTo('web.status')).toHaveLength(0);
      await get('/apache/workers').expect(501);
      expect(app.agent.callsTo('modstatus.workers')).toHaveLength(0);
      await post('/apache/enable-status').expect(501);
    });

    it('is root only', async () => {
      await resellerHttp.get('/api/server-status/apache').expect(403);
      await resellerHttp.get('/api/server-status/apache/workers').expect(403);
      await resellerHttp.post('/api/server-status/apache/enable-status').set('X-CSRF-Token', resellerCsrf).send({}).expect(403);
      await resellerHttp.get('/api/server-status/process-log/days').expect(403);
      await resellerHttp.put('/api/server-status/process-log/settings').set('X-CSRF-Token', resellerCsrf).send({ enabled: false }).expect(403);
      await resellerHttp.post('/api/server-status/process-log/sample').set('X-CSRF-Token', resellerCsrf).send({}).expect(403);
      await resellerHttp.delete('/api/server-status/process-log/day/2026-01-01').set('X-CSRF-Token', resellerCsrf).expect(403);
      expect(app.agent.calls).toHaveLength(0);
    });

    it('renders the worker scoreboard, requests/sec and uptime when mod_status answers', async () => {
      await provision(true);
      const { body } = await get('/apache').expect(200);
      expect(body.data).toMatchObject({ installed: true, flavor: 'debian', version: 'Apache/2.4.58 (Ubuntu)', mpm: 'event', active: true, modStatus: true, reason: null, instructions: null, managedVhosts: 3, probe: { host: '127.0.0.1', port: 80 } });
      expect(body.data.status).toMatchObject({ uptimeSeconds: 3600, totalAccesses: 12000, requestsPerSecond: 3.33, busyWorkers: 3, idleWorkers: 4, extended: true });
      expect(body.data.status.counters.Scoreboard).toBeUndefined();
      expect(body.data.scoreboard).toMatchObject({ total: 12, used: 7, open: 5 });
      expect(body.data.scoreboard.states.find((s) => s.key === 'sending').count).toBe(2);
      expect(body.data.configuredInPanel).toBe(true);
      expect(body.data.canEnableFromPanel).toBe(false);
      expect(app.agent.callsTo('web.status').pop().args).toEqual({ port: 80, bind: null });
    });

    it('probes the ports Apache Configuration set (behind the nginx proxy)', async () => {
      app.ctx.settings.set('service_config.apache_ports', { http: 8080, https: 8443, bind: '127.0.0.1' });
      const { body } = await get('/apache').expect(200);
      expect(app.agent.callsTo('web.status').pop().args).toEqual({ port: 8080, bind: '127.0.0.1' });
      expect(body.data.probe).toEqual({ host: '127.0.0.1', port: 8080 });
      app.ctx.settings.set('service_config.apache_ports', null);
    });

    it('explains how to enable mod_status when it is not loaded', async () => {
      modStatus = false;
      const { body } = await get('/apache').expect(200);
      expect(body.data).toMatchObject({ modStatus: false, reason: 'module_missing', status: null, scoreboard: null });
      expect(body.data.instructions.steps.join(' ')).toContain('a2enmod status');
      modStatus = true;
    });

    it('explains the Location block when the module is loaded but /server-status is unreachable', async () => {
      serverStatus = false;
      const { body } = await get('/apache').expect(200);
      expect(body.data.reason).toBe('unreachable');
      expect(body.data.instructions.title).toContain('127.0.0.1:80/server-status');
      serverStatus = true;
      apacheActive = false;
      const down = await get('/apache').expect(200);
      expect(down.body.data).toMatchObject({ active: false, reason: 'apache_down' });
      apacheActive = true;
    });

    it('offers to enable the status page through Apache Configuration when the panel has it switched off', async () => {
      const updates = [];
      const original = app.ctx.web;
      app.ctx.web = { apache: { settings: () => ({ serverStatus: false }), update: async (input) => { updates.push(input); return { applied: { include: { reloaded: true } }, lastApply: { ok: true } }; } } };
      try {
        const { body } = await get('/apache').expect(200);
        expect(body.data).toMatchObject({ configuredInPanel: false, canEnableFromPanel: true });
        const res = await post('/apache/enable-status').expect(200);
        expect(res.body.data).toMatchObject({ enabled: true, applied: { include: { reloaded: true } } });
        expect(updates).toEqual([{ serverStatus: true }]);
        const audit = app.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'server_status.apache.enable_status'").all();
        expect(audit).toHaveLength(1);
      } finally { app.ctx.web = original; }
    });

    it('lists every mod_status worker slot with its state, vhost and request', async () => {
      await provision(true);
      const { body } = await get('/apache/workers').expect(200);
      expect(app.agent.callsTo('modstatus.workers').pop().args).toEqual({ port: 80, bind: null });
      expect(body.data).toMatchObject({ available: true, reason: null, instructions: null, probe: { host: '127.0.0.1', port: 80 }, summary: { slots: 4, active: 3, open: 1, vhosts: 2, clients: 2 } });
      expect(body.data.columns.map((c) => c.header)).toEqual(['Srv', 'PID', 'Acc', 'M', 'CPU', 'SS', 'Req', 'Dur', 'Conn', 'Child', 'Slot', 'Client', 'Protocol', 'VHost', 'Request']);
      expect(body.data.workers).toHaveLength(4);
      expect(body.data.workers[0]).toMatchObject({ srv: '0-2', pid: 31337, mode: 'W', stateKey: 'sending', stateLabel: 'Sending reply', vhost: 'example.com:80', request: 'GET /wp-admin/index.php HTTP/1.1', acc: { connection: 0, child: 12, slot: 345 } });
      expect(body.data.workers[1]).toMatchObject({ mode: 'K', stateKey: 'keepalive', protocol: 'h2' });
      expect(body.data.workers[3]).toMatchObject({ srv: '3-0', pid: null, mode: '.', stateKey: 'open', vhost: null, request: null });
      expect(body.data.checkedAt).toBeTruthy();
    });

    it('probes the worker table on the ports Apache Configuration set', async () => {
      app.ctx.settings.set('service_config.apache_ports', { http: 8080, https: 8443, bind: '127.0.0.1' });
      try {
        const { body } = await get('/apache/workers').expect(200);
        expect(app.agent.callsTo('modstatus.workers').pop().args).toEqual({ port: 8080, bind: '127.0.0.1' });
        expect(body.data.probe).toEqual({ host: '127.0.0.1', port: 8080 });
      } finally { app.ctx.settings.set('service_config.apache_ports', null); }
    });

    it('explains ExtendedStatus Off and an unreachable status page instead of an empty table', async () => {
      workersMode = 'basic';
      try {
        const basic = await get('/apache/workers').expect(200);
        expect(basic.body.data).toMatchObject({ available: false, reason: 'extended_off', workers: [], summary: { slots: 0, active: 0 } });
        expect(basic.body.data.instructions.title).toBe('ExtendedStatus is Off');
        expect(basic.body.data.instructions.steps.join(' ')).toContain('ExtendedStatus On');
        workersMode = 'down';
        const down = await get('/apache/workers').expect(200);
        expect(down.body.data).toMatchObject({ available: false, reason: 'unreachable', workers: [] });
        expect(down.body.data.instructions.title).toContain('127.0.0.1:80/server-status');
        workersMode = 'not_status';
        const other = await get('/apache/workers').expect(200);
        expect(other.body.data).toMatchObject({ available: false, reason: 'unreachable' });
      } finally { workersMode = 'extended'; }
    });

    it('maps an agent failure on the worker probe to the usual error envelope', async () => {
      app.agent.fail('modstatus.workers', 'agent_unavailable', 'agent down');
      try {
        const res = await get('/apache/workers').expect(503);
        expect(res.body.error.code).toBe('agent_unavailable');
      } finally { app.agent.set('modstatus.workers', workersHandler); }
    });

    it('returns 422 when no Apache Configuration service can write the block', async () => {
      const original = app.ctx.web;
      app.ctx.web = undefined;
      try { await post('/apache/enable-status').expect(422); } finally { app.ctx.web = original; }
    });
  });

  describe('Daily Process Log', () => {
    it('starts with defaults and no recorded days', async () => {
      const { body } = await get('/process-log/days').expect(200);
      expect(body.data.days).toEqual([]);
      expect(body.data.settings).toMatchObject({ enabled: true, topN: 25, retentionDays: 14, schedule: { cron: '*/5 * * * *', enabled: true } });
      const settings = await get('/process-log/settings').expect(200);
      expect(settings.body.data).toMatchObject({ enabled: true, topN: 25, retentionDays: 14, schedule: { name: 'process-log-sampler', cron: '*/5 * * * *', enabled: true } });
      const latest = await get('/process-log/latest').expect(200);
      expect(latest.body.data).toBeNull();
    });

    it('validates settings and toggles the sampler schedule with the feature', async () => {
      await put('/process-log/settings', {}).expect(422);
      await put('/process-log/settings', { topN: 0 }).expect(422);
      await put('/process-log/settings', { retentionDays: 365 }).expect(422);
      await put('/process-log/settings', { bogus: true }).expect(422);
      const off = await put('/process-log/settings', { enabled: false, topN: 2, retentionDays: 7 }).expect(200);
      expect(off.body.data).toMatchObject({ enabled: false, topN: 2, retentionDays: 7, schedule: { enabled: false } });
      expect(app.ctx.scheduler.list().find((r) => r.name === 'process-log-sampler').enabled).toBe(0);
      const on = await put('/process-log/settings', { enabled: true }).expect(200);
      expect(on.body.data.schedule.enabled).toBe(true);
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'server_status.process_log.settings'").get().n).toBe(2);
    });

    it('keeps the setting authoritative over the schedule row without rewriting an aligned row', () => {
      const s = app.ctx.serverStatus.processLog;
      expect(s.alignSchedule()).toEqual({ changed: false, enabled: true });
      app.ctx.scheduler.update('process-log-sampler', { enabled: false });
      expect(s.settings()).toMatchObject({ enabled: true, schedule: { enabled: false } });
      expect(s.alignSchedule()).toEqual({ changed: true, enabled: true });
      expect(app.ctx.scheduler.list().find((r) => r.name === 'process-log-sampler').enabled).toBe(1);
      expect(s.alignSchedule()).toEqual({ changed: false, enabled: true });
    });

    it('records nothing on a scheduled run while the sampler is paused, but still samples on demand', async () => {
      await put('/process-log/settings', { enabled: false }).expect(200);
      try {
        const scheduled = await app.ctx.serverStatus.jobs['server_status.process_sample']({ params: {}, log: () => {} });
        expect(scheduled).toEqual({ skipped: 'paused' });
        expect(app.agent.callsTo('sys.processes')).toHaveLength(0);
        const res = await post('/process-log/sample').expect(202);
        const job = await waitForJob(app.ctx, res.body.data.job.id);
        expect(job.status).toBe('done');
        expect(job.result).toMatchObject({ processes: 5, recorded: 3 });
        const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'server_status.process_log.sample' ORDER BY id DESC LIMIT 1").get();
        expect(audit).toBeTruthy();
        expect(JSON.parse(audit.args_redacted)).toMatchObject({ jobId: res.body.data.job.id });
        await del(`/process-log/day/${dayKey()}`).expect(200);
      } finally { await put('/process-log/settings', { enabled: true }).expect(200); }
    });

    it('samples the top processes on demand as a job and stores them per day', async () => {
      const res = await post('/process-log/sample').expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ processes: 5, recorded: 3, pruned: 0 });
      expect(app.agent.callsTo('sys.processes').pop().args).toEqual({ sort: 'cpu', limit: 5000 });
      const today = dayKey();
      const { body } = await get('/process-log/days').expect(200);
      expect(body.data.days).toHaveLength(1);
      expect(body.data.days[0]).toMatchObject({ day: today, samples: 1, peakLoad1: 0.1 });
      const latest = await get('/process-log/latest').expect(200);
      expect(latest.body.data).toMatchObject({ day: today, processCount: 5, load: [0.1, 0.2, 0.3], memTotalBytes: 8e9, memUsedBytes: 2e9 });
      expect(latest.body.data.entries.map((e) => e.pid)).toEqual([200, 201, 300]);
      expect(latest.body.data.cpuPercent).toBeCloseTo(61.1, 1);
      const detail = await get(`/process-log/samples/${latest.body.data.id}`).expect(200);
      expect(detail.body.data.entries[0]).toMatchObject({ pid: 200, user: 'www-data', command: 'apache2', args: '-k start', cpuPercent: 45.5 });
      await get('/process-log/samples/999999').expect(404);
      await get('/process-log/samples/abc').expect(422);
    });

    it('aggregates a day per process and per user, with an optional user filter and chart series', async () => {
      procs = PROCS.map((p) => (p.pid === 200 ? { ...p, cpuPercent: 20 } : p));
      const res = await post('/process-log/sample').expect(202);
      await waitForJob(app.ctx, res.body.data.job.id);
      procs = PROCS;
      const today = dayKey();
      const { body } = await get(`/process-log/day/${today}`).expect(200);
      expect(body.data).toMatchObject({ date: today, user: null, samples: 2 });
      expect(body.data.series).toHaveLength(2);
      expect(body.data.series[0]).toMatchObject({ load1: 0.1, cpuPercent: expect.any(Number), memTotalBytes: 8e9 });
      const apache = body.data.processes.find((p) => p.command === 'apache2');
      expect(apache).toMatchObject({ user: 'www-data', entries: 4, samples: 2, peakCpu: 45.5 });
      expect(apache.avgCpu).toBeCloseTo(42.75, 2);
      expect(body.data.users.map((u) => u.user)).toEqual(['www-data', 'mysql']);
      expect(body.data.users[0]).toMatchObject({ commands: 1, samples: 2, entries: 4 });
      expect(body.data.users[0].avgCpu).toBeCloseTo(42.75, 2);
      expect(body.data.peak).toMatchObject({ load1: 0.1 });

      const filtered = await get(`/process-log/day/${today}?user=mysql`).expect(200);
      expect(filtered.body.data.user).toBe('mysql');
      expect(filtered.body.data.processes).toHaveLength(1);
      expect(filtered.body.data.processes[0]).toMatchObject({ command: 'mariadbd', peakMem: 40 });
      expect(filtered.body.data.series[0]).toMatchObject({ userCpuPercent: 0.5, userMemPercent: 40, userProcesses: 1 });
      await get(`/process-log/day/${today}?user=a;b`).expect(422);
      await get('/process-log/day/2026-13-01').expect(422);
      const empty = await get('/process-log/day/2000-01-01').expect(200);
      expect(empty.body.data).toMatchObject({ samples: 0, series: [], processes: [], users: [] });
    });

    it('prunes samples older than the retention window on every run', async () => {
      const db = app.ctx.db;
      const { lastInsertRowid } = db.prepare("INSERT INTO process_log_samples (sampled_at, day, process_count) VALUES ('2000-01-01 00:00:00', '2000-01-01', 1)").run();
      db.prepare("INSERT INTO process_log_entries (sample_id, pid, user, command) VALUES (?, 1, 'root', 'old')").run(lastInsertRowid);
      const res = await post('/process-log/sample').expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result.pruned).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM process_log_samples WHERE day = '2000-01-01'").get().n).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM process_log_entries WHERE sample_id = ?').get(lastInsertRowid).n).toBe(0);
    });

    it('still records a sample when sys.info is unavailable', async () => {
      app.agent.fail('sys.info', 'agent_unavailable');
      try {
        const res = await post('/process-log/sample').expect(202);
        const job = await waitForJob(app.ctx, res.body.data.job.id);
        expect(job.status).toBe('done');
        const latest = await get('/process-log/latest').expect(200);
        expect(latest.body.data.load).toEqual([null, null, null]);
      } finally { app.agent.reset('sys.info'); }
    });

    it('purges a day with an audit entry and 404s an empty day', async () => {
      const today = dayKey();
      const before = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM process_log_samples').get().n;
      expect(before).toBeGreaterThan(0);
      await del('/process-log/day/2000-01-01').expect(404);
      await del('/process-log/day/not-a-date').expect(422);
      const res = await del(`/process-log/day/${today}`).expect(200);
      expect(res.body.data).toMatchObject({ date: today, deleted: before });
      expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM process_log_entries').get().n).toBe(0);
      expect(app.ctx.db.prepare("SELECT target FROM audit_log WHERE action = 'server_status.process_log.purge'").get().target).toBe(today);
    });

    it('is enqueued by the scheduler on a 5-minute boundary and skipped while disabled', async () => {
      const db = app.ctx.db;
      db.prepare("UPDATE jobs SET status = 'cancelled' WHERE status = 'queued'").run();
      const countJobs = () => db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'server_status.process_sample'").get().n;
      app.ctx.scheduler.update('process-log-sampler', { cron: '* * * * *' });
      const base = countJobs();
      app.ctx.scheduler.tick();
      expect(countJobs()).toBe(base + 1);
      await put('/process-log/settings', { enabled: false }).expect(200);
      db.prepare("UPDATE schedules SET last_run_at = NULL WHERE name = 'process-log-sampler'").run();
      app.ctx.scheduler.tick();
      expect(countJobs()).toBe(base + 1);
      await put('/process-log/settings', { enabled: true }).expect(200);
      app.ctx.scheduler.update('process-log-sampler', { cron: '*/5 * * * *' });
    });
  });
});
