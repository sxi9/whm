import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { matchProcess, GENERIC_SNIFFERS } from '../src/services/system-health.js';

const proc = (pid, user, command, args = '', extra = {}) => ({ pid, ppid: 1, user, cpuPercent: 1.5, memPercent: 0.2, rssBytes: 1024, vszBytes: 2048, elapsedSeconds: 60, state: 'S', command, args, ...extra });

describe('matchProcess', () => {
  const patterns = ['BitchX', 'bnc', 'eggdrop', 'generic-sniffers', 'guardservices', 'ircd', 'psyBNC', 'ptlink', 'services'];
  it('matches by command name case-insensitively and by argv[0] basename', () => {
    expect(matchProcess(proc(1, 'u', 'bitchx'), patterns)).toBe('BitchX');
    expect(matchProcess(proc(1, 'u', 'psybnc', './psybnc -c conf'), patterns)).toBe('psyBNC');
    expect(matchProcess(proc(1, 'u', 'perl', '/home/u/.x/eggdrop eggdrop.conf'), patterns)).toBe('eggdrop');
    expect(matchProcess(proc(1, 'u', '-bash', '-bash'), patterns)).toBeNull();
    expect(matchProcess(proc(1, 'u', 'sshd:', 'sshd: u@pts/0'), patterns)).toBeNull();
    expect(matchProcess(proc(1, 'u', 'ircd-hybrid'), patterns)).toBeNull();
    expect(matchProcess(proc(1, 'u', 'node', '/usr/bin/node server.js'), patterns)).toBeNull();
  });
  it('expands generic-sniffers and handles the 15-character comm truncation', () => {
    for (const s of GENERIC_SNIFFERS) expect(matchProcess(proc(1, 'u', s), patterns)).toBe('generic-sniffers');
    expect(matchProcess(proc(1, 'u', 'tcpdump'), ['bnc'])).toBeNull();
    expect(matchProcess(proc(1, 'u', 'verylongprocess', ''), ['verylongprocessname'])).toBe('verylongprocessname');
    expect(matchProcess(proc(1, 'u', 'verylongproces', ''), ['verylongprocessname'])).toBeNull();
    expect(matchProcess(proc(1, 'u', '', ''), patterns)).toBeNull();
  });
});

describe('System Health API', () => {
  let app;
  let csrf;
  let reseller;
  let resellerCsrf;
  let psInstalled = true;
  let processes = [];
  let signalled = [];
  let notifications = [];

  const post = (url, body = {}) => app.http.post(url).set('X-CSRF-Token', csrf).send(body);
  const put = (url, body) => app.http.put(url).set('X-CSRF-Token', csrf).send(body);
  const patch = (url, body) => app.http.patch(url).set('X-CSRF-Token', csrf).send(body);
  const del = (url) => app.http.delete(url).set('X-CSRF-Token', csrf);
  const get = (url) => app.http.get(url);
  const auditRows = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

  beforeAll(async () => {
    const agent = createMockAgent({
      'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, psInstalled && ['ps', 'renice'].includes(n)])),
      'sys.processes': ({ limit }) => processes.slice(0, limit),
      'sys.process.signal': ({ pid, signal }) => {
        signalled.push({ pid, signal });
        if (pid === 666) throw Object.assign(new Error(`No process with PID ${pid}`), { agentError: true, code: 'not_found', details: {} });
        if (pid === 777) throw Object.assign(new Error('Operation not permitted'), { agentError: true, code: 'signal_failed', details: {} });
        return { pid, signal };
      },
      'sys.process.renice': ({ pid, niceness }) => ({ pid, niceness }),
    });
    app = await createTestApp({ agent });
    csrf = await app.login();
    const r = await app.createUser('resell1', 'reseller');
    reseller = request.agent(app.ctx.app);
    resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com' }).expect(201);
    app.ctx.contacts = { notify: async (n) => { notifications.push(n); return { sent: true }; } };
  }, 30_000);

  afterAll(async () => { await app?.close(); });

  beforeEach(async () => {
    psInstalled = true;
    await app.ctx.capabilities.refresh();
    signalled = [];
    notifications = [];
    processes = [
      proc(1, 'root', 'systemd', '/sbin/init'),
      proc(900, 'root', 'ircd', '/usr/sbin/ircd'),
      proc(1001, 'alice', 'eggdrop', './eggdrop -m eggdrop.conf'),
      proc(1002, 'alice', 'php-fpm', 'php-fpm: pool alice'),
      proc(1003, 'bob', 'psybnc', '/home/bob/.p/psybnc'),
      proc(1004, 'bob', 'BitchX', '/home/bob/bin/BitchX -n bob'),
      proc(1005, 'www-data', 'apache2', '/usr/sbin/apache2 -k start'),
      proc(1006, 'carol', 'tcpdump', 'tcpdump -i eth0'),
      proc(1007, 'bob', 'perl', '/usr/bin/perl /home/bob/BitchX'),
    ];
  });

  it('registers the module: service on ctx, capability, job type and schedule', () => {
    expect(typeof app.ctx.systemHealth.scan).toBe('function');
    expect(app.ctx.jobs.types()).toContain('system-health.bpk.scan');
    const schedule = app.ctx.scheduler.list().find((s) => s.name === 'system-health-bpk');
    expect(schedule).toMatchObject({ cron: '*/10 * * * *', job_type: 'system-health.bpk.scan', enabled: 1 });
    expect(app.ctx.capabilities.snapshot().capabilities.procps).toMatchObject({ installed: true });
  });

  it('GET /bpk returns config, the seeded classic list, schedule and stats', async () => {
    const res = await get('/api/system-health/bpk').expect(200);
    const { data } = res.body;
    expect(data.config).toEqual({ enabled: true, signal: 'SIGKILL', notify: true, scope: 'non-root', exemptUsers: [], retentionDays: 90 });
    expect(data.patterns.map((p) => p.name)).toEqual(['BitchX', 'bnc', 'eggdrop', 'generic-sniffers', 'guardservices', 'ircd', 'psyBNC', 'ptlink', 'services']);
    expect(data.patterns.every((p) => p.builtin && p.enabled)).toBe(true);
    expect(data.schedule).toMatchObject({ name: 'system-health-bpk', cron: '*/10 * * * *', enabled: true });
    expect(data.capability).toEqual({ procps: true, notifications: true });
    expect(data.stats).toEqual({ total: 0, last24h: 0, failed: 0 });
    expect(data.signals).toContain('SIGKILL');
  });

  it('GET /bpk/matches previews matches for non-root users only, without signalling', async () => {
    const res = await get('/api/system-health/bpk/matches').expect(200);
    expect(res.body.data.scanned).toBe(9);
    expect(res.body.data.matches.map((m) => [m.pid, m.pattern])).toEqual([[1001, 'eggdrop'], [1003, 'psyBNC'], [1004, 'BitchX'], [1006, 'generic-sniffers']]);
    expect(signalled).toEqual([]);
    expect(app.agent.callsTo('sys.processes').at(-1).args).toEqual({ sort: 'pid', limit: 5000 });
  });

  it('POST /bpk/scan kills every match, logs the kills, notifies and audits', async () => {
    const res = await post('/api/system-health/bpk/scan', {}).expect(200);
    const { run, kills } = res.body.data;
    expect(run).toMatchObject({ trigger: 'manual', principal: 'root', dry_run: false, scanned: 9, matched: 4, killed: 4, failed: 0, notified: true, error: null });
    expect(kills.map((k) => k.pid)).toEqual([1001, 1003, 1004, 1006]);
    expect(signalled).toEqual([1001, 1003, 1004, 1006].map((pid) => ({ pid, signal: 'SIGKILL' })));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ event: 'bpk.killed', severity: 'warning' });
    expect(notifications[0].subject).toContain('4 process(es)');
    expect(notifications[0].body).toContain('pid 1003 (bob) psybnc');
    const log = await get('/api/system-health/bpk/kills').expect(200);
    expect(log.body.meta.total).toBe(4);
    expect(log.body.data[0]).toMatchObject({ user: 'carol', command: 'tcpdump', pattern: 'generic-sniffers', signal: 'SIGKILL', result: 'killed' });
    const audit = auditRows('system_health.bpk.scan');
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(audit.at(-1).args_redacted)).toMatchObject({ trigger: 'manual', killed: 4, pids: [1001, 1003, 1004, 1006] });
    const overview = await get('/api/system-health/bpk').expect(200);
    expect(overview.body.data.stats).toMatchObject({ total: 4, last24h: 4 });
    expect(overview.body.data.lastRun.id).toBe(run.id);
  });

  it('records processes that vanished or refused the signal without aborting the run', async () => {
    processes.push(proc(666, 'dave', 'bnc'), proc(777, 'erin', 'ircd'));
    const res = await post('/api/system-health/bpk/scan', {}).expect(200);
    expect(res.body.data.run).toMatchObject({ matched: 6, killed: 4, failed: 1 });
    const byPid = Object.fromEntries(res.body.data.kills.map((k) => [k.pid, k]));
    expect(byPid[666]).toMatchObject({ result: 'gone' });
    expect(byPid[777]).toMatchObject({ result: 'failed', error: 'Operation not permitted' });
    expect(notifications[0].body).toContain('FAILED pid 777');
    expect(notifications[0].body).not.toContain('pid 666');
    const failed = await get('/api/system-health/bpk/kills?result=failed&user=erin').expect(200);
    expect(failed.body.data.map((k) => k.pid)).toEqual([777]);
  });

  it('dry run logs would-kill entries and signals nothing', async () => {
    const res = await post('/api/system-health/bpk/scan', { dryRun: true }).expect(200);
    expect(res.body.data.run).toMatchObject({ dry_run: true, matched: 4, killed: 0 });
    expect(res.body.data.kills.every((k) => k.result === 'would-kill')).toBe(true);
    expect(signalled).toEqual([]);
    expect(notifications).toEqual([]);
    expect((await get('/api/system-health/bpk/kills?result=would-kill').expect(200)).body.meta.total).toBe(4);
  });

  it('honours scope, exempt users and signal from the configuration', async () => {
    await put('/api/system-health/bpk/config', { scope: 'accounts', signal: 'SIGTERM' }).expect(200);
    let res = await get('/api/system-health/bpk/matches').expect(200);
    expect(res.body.data.matches.map((m) => m.pid)).toEqual([1001]);
    await put('/api/system-health/bpk/config', { scope: 'non-root', exemptUsers: ['bob', 'carol'] }).expect(200);
    res = await get('/api/system-health/bpk/matches').expect(200);
    expect(res.body.data.matches.map((m) => m.pid)).toEqual([1001]);
    await post('/api/system-health/bpk/scan', {}).expect(200);
    expect(signalled).toEqual([{ pid: 1001, signal: 'SIGTERM' }]);
    const cfg = (await put('/api/system-health/bpk/config', { exemptUsers: [], signal: 'SIGKILL' }).expect(200)).body.data;
    expect(cfg).toMatchObject({ scope: 'non-root', exemptUsers: [], signal: 'SIGKILL' });
    expect(auditRows('system_health.bpk.configure').length).toBeGreaterThanOrEqual(3);
  });

  it('toggling enabled pauses and resumes the schedule', async () => {
    await put('/api/system-health/bpk/config', { enabled: false }).expect(200);
    expect(app.ctx.scheduler.list().find((s) => s.name === 'system-health-bpk').enabled).toBe(0);
    await put('/api/system-health/bpk/config', { enabled: true }).expect(200);
    expect(app.ctx.scheduler.list().find((s) => s.name === 'system-health-bpk').enabled).toBe(1);
  });

  it('manages the disallowed list: add, toggle, rename, conflict, protect built-ins, remove', async () => {
    const added = await post('/api/system-health/bpk/patterns', { name: 'minerd', note: 'crypto miner' }).expect(201);
    expect(added.body.data).toMatchObject({ name: 'minerd', note: 'crypto miner', enabled: true, builtin: false });
    await post('/api/system-health/bpk/patterns', { name: 'MINERD' }).expect(409);
    await post('/api/system-health/bpk/patterns', { name: 'eggdrop' }).expect(409);
    processes.push(proc(2001, 'alice', 'minerd', '/tmp/.x/minerd -o stratum'));
    expect((await get('/api/system-health/bpk/matches')).body.data.matches.some((m) => m.pid === 2001)).toBe(true);
    const id = added.body.data.id;
    expect((await patch(`/api/system-health/bpk/patterns/${id}`, { enabled: false }).expect(200)).body.data.enabled).toBe(false);
    expect((await get('/api/system-health/bpk/matches')).body.data.matches.some((m) => m.pid === 2001)).toBe(false);
    expect((await patch(`/api/system-health/bpk/patterns/${id}`, { name: 'xmrig', enabled: true }).expect(200)).body.data.name).toBe('xmrig');
    const eggdrop = (await get('/api/system-health/bpk/patterns').expect(200)).body.data.find((p) => p.name === 'eggdrop');
    await patch(`/api/system-health/bpk/patterns/${eggdrop.id}`, { name: 'other' }).expect(400);
    await del(`/api/system-health/bpk/patterns/${eggdrop.id}`).expect(400);
    expect((await patch(`/api/system-health/bpk/patterns/${eggdrop.id}`, { enabled: false }).expect(200)).body.data.enabled).toBe(false);
    expect((await get('/api/system-health/bpk/matches')).body.data.matches.map((m) => m.pid)).not.toContain(1001);
    await patch(`/api/system-health/bpk/patterns/${eggdrop.id}`, { enabled: true }).expect(200);
    expect((await del(`/api/system-health/bpk/patterns/${id}`).expect(200)).body.data).toEqual({ removed: true, name: 'xmrig' });
    await del(`/api/system-health/bpk/patterns/${id}`).expect(404);
    expect(auditRows('system_health.bpk.pattern.add')).toHaveLength(1);
    expect(auditRows('system_health.bpk.pattern.remove')).toHaveLength(1);
  });

  it('kills a single previewed match and refuses PIDs that are not matches', async () => {
    const res = await post('/api/system-health/bpk/matches/1003/kill').expect(200);
    expect(res.body.data).toMatchObject({ pid: 1003, user: 'bob', pattern: 'psyBNC', result: 'killed' });
    expect(signalled).toEqual([{ pid: 1003, signal: 'SIGKILL' }]);
    await post('/api/system-health/bpk/matches/1002/kill').expect(404);
    await post('/api/system-health/bpk/matches/900/kill').expect(404);
    expect(signalled).toHaveLength(1);
    expect(auditRows('system_health.bpk.kill')).toHaveLength(1);
  });

  it('runs the scheduled job through the job queue and skips it while disabled', async () => {
    app.ctx.jobs.start();
    try {
      let job = await waitForJob(app.ctx, app.ctx.jobs.enqueue('system-health.bpk.scan').id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ scanned: 9, matched: 4, killed: 4 });
      expect(signalled).toHaveLength(4);
      const runs = (await get('/api/system-health/bpk/runs?limit=5').expect(200)).body.data;
      expect(runs[0]).toMatchObject({ trigger: 'scheduled', killed: 4, notified: true });
      signalled = [];
      await put('/api/system-health/bpk/config', { enabled: false }).expect(200);
      job = await waitForJob(app.ctx, app.ctx.jobs.enqueue('system-health.bpk.scan').id);
      expect(job.result).toEqual({ skipped: 'disabled' });
      expect(signalled).toEqual([]);
      await put('/api/system-health/bpk/config', { enabled: true }).expect(200);
    } finally { app.ctx.jobs.stop(); }
  });

  it('lists, searches, sorts and clears the kill log', async () => {
    const res = await get('/api/system-health/bpk/kills?q=psybnc&sort=pid&dir=asc&pageSize=2').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((k) => k.command === 'psybnc')).toBe(true);
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 2 });
    const cleared = await del('/api/system-health/bpk/kills').expect(200);
    expect(cleared.body.data.removed).toBeGreaterThan(0);
    expect((await get('/api/system-health/bpk/kills').expect(200)).body.meta.total).toBe(0);
    expect(auditRows('system_health.bpk.log.clear')).toHaveLength(1);
  });

  it('serves disk usage with per-account consumption and the process endpoints', async () => {
    const disk = await get('/api/system-health/disk').expect(200);
    expect(disk.body.data.filesystems[0]).toMatchObject({ mountpoint: '/', usedPercent: 20 });
    expect(disk.body.data.accounts.map((a) => a.username)).toEqual(['alice']);
    expect(disk.body.data.accounts[0]).toMatchObject({ domain: 'alice.com', owner: 'root', diskUsedMb: 0 });
    const procs = await get('/api/system-health/processes?sort=mem&limit=3').expect(200);
    expect(procs.body.data).toHaveLength(3);
    expect(app.agent.callsTo('sys.processes').at(-1).args).toEqual({ sort: 'mem', limit: 3 });
    await post('/api/system-health/processes/1002/signal', { signal: 'SIGTERM' }).expect(200);
    expect(signalled).toEqual([{ pid: 1002, signal: 'SIGTERM' }]);
    const renice = await post('/api/system-health/processes/1002/renice', { niceness: 5 }).expect(200);
    expect(renice.body.data).toEqual({ pid: 1002, niceness: 5 });
    expect(auditRows('process.renice').length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid input with 422', async () => {
    await post('/api/system-health/bpk/patterns', { name: '-rf' }).expect(422);
    await post('/api/system-health/bpk/patterns', { name: 'a;b' }).expect(422);
    await post('/api/system-health/bpk/patterns', { name: '../etc' }).expect(422);
    await post('/api/system-health/bpk/patterns', { name: 'ok', extra: 1 }).expect(422);
    await post('/api/system-health/bpk/patterns', {}).expect(422);
    await patch('/api/system-health/bpk/patterns/1', {}).expect(422);
    await patch('/api/system-health/bpk/patterns/abc', { enabled: true }).expect(422);
    await put('/api/system-health/bpk/config', {}).expect(422);
    await put('/api/system-health/bpk/config', { signal: 'SIGFOO' }).expect(422);
    await put('/api/system-health/bpk/config', { scope: 'everyone' }).expect(422);
    await put('/api/system-health/bpk/config', { exemptUsers: ['Root'] }).expect(422);
    await put('/api/system-health/bpk/config', { retentionDays: 0 }).expect(422);
    await post('/api/system-health/bpk/scan', { dryRun: 'yes' }).expect(422);
    await post('/api/system-health/bpk/matches/0/kill').expect(422);
    await get('/api/system-health/bpk/kills?result=nope').expect(422);
    await get('/api/system-health/bpk/kills?user=../x').expect(422);
    await get('/api/system-health/processes?sort=name').expect(422);
    await post('/api/system-health/processes/1002/signal', { signal: 'SIGUSR1' }).expect(422);
    await post('/api/system-health/processes/1002/renice', { niceness: 50 }).expect(422);
    expect(signalled).toEqual([]);
  });

  it('is root-only: resellers get 403 everywhere', async () => {
    const rget = (url) => reseller.get(url);
    const rpost = (url, body = {}) => reseller.post(url).set('X-CSRF-Token', resellerCsrf).send(body);
    for (const url of ['/api/system-health/bpk', '/api/system-health/bpk/patterns', '/api/system-health/bpk/matches', '/api/system-health/bpk/kills', '/api/system-health/bpk/runs', '/api/system-health/disk', '/api/system-health/processes']) {
      expect((await rget(url)).status, url).toBe(403);
    }
    expect((await rpost('/api/system-health/bpk/scan')).status).toBe(403);
    expect((await rpost('/api/system-health/bpk/patterns', { name: 'x' })).status).toBe(403);
    expect((await rpost('/api/system-health/bpk/matches/1001/kill')).status).toBe(403);
    expect((await reseller.put('/api/system-health/bpk/config').set('X-CSRF-Token', resellerCsrf).send({ enabled: false })).status).toBe(403);
    expect((await reseller.delete('/api/system-health/bpk/kills').set('X-CSRF-Token', resellerCsrf)).status).toBe(403);
    expect(signalled).toEqual([]);
  });

  it('degrades to 501 capability_missing without ps, and the scheduled job skips', async () => {
    psInstalled = false;
    await app.ctx.capabilities.refresh();
    const overview = await get('/api/system-health/bpk').expect(200);
    expect(overview.body.data.capability.procps).toBe(false);
    for (const [method, url] of [['get', '/api/system-health/bpk/matches'], ['post', '/api/system-health/bpk/scan'], ['post', '/api/system-health/bpk/matches/1001/kill'], ['get', '/api/system-health/processes']]) {
      const res = method === 'get' ? await get(url) : await post(url, {});
      expect(res.status, url).toBe(501);
      expect(res.body.error.code).toBe('capability_missing');
      expect(res.body.error.message).toMatch(/procps/);
    }
    const run = (await get('/api/system-health/bpk/runs?limit=1').expect(200)).body.data[0];
    expect(run).toMatchObject({ trigger: 'manual', error: expect.stringMatching(/procps/) });
    expect(signalled).toEqual([]);
    app.ctx.jobs.start();
    try {
      const job = await waitForJob(app.ctx, app.ctx.jobs.enqueue('system-health.bpk.scan').id);
      expect(job.status).toBe('done');
      expect(job.result).toEqual({ skipped: 'procps_missing' });
    } finally { app.ctx.jobs.stop(); }
    expect((await get('/api/system-health/disk').expect(200)).body.data.filesystems).toHaveLength(1);
  });
});
