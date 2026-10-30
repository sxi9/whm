import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { PROFILES, isValidTimezone, timezoneForHost, createTextDecoder } from '../src/services/server-configuration.js';

const TERM_ID = 'a'.repeat(32);
const QUOTA_FS = { device: '/dev/vda1', mountpoint: '/', fstype: 'ext4', mountOptions: ['rw', 'relatime'], supported: true, userQuotaMounted: false, groupQuotaMounted: false, ext4QuotaFeature: false, quotaFiles: { user: false, group: false }, active: { user: null, group: null }, fstab: { lineNo: 2, line: '/dev/vda1 / ext4 defaults 0 1', options: ['defaults'], hasUserQuota: false, hasGroupQuota: false }, proposedFstabLine: '/dev/vda1\t/\text4\tusrquota,grpquota\t0\t1', rebootRequired: false };

describe('server-configuration helpers', () => {
  it('validates IANA timezones', () => {
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });

  it('accepts ICU legacy ids against a host list that only has the current names', () => {
    const host = new Set(['Asia/Kolkata', 'Europe/Kyiv', 'UTC']);
    expect(isValidTimezone('Asia/Calcutta', host)).toBe(true);
    expect(isValidTimezone('Europe/Kiev', host)).toBe(true);
    expect(isValidTimezone('Europe/Berlin', host)).toBe(false);
    expect(timezoneForHost('Asia/Calcutta', host)).toBe('Asia/Kolkata');
    expect(timezoneForHost('Asia/Kolkata', host)).toBe('Asia/Kolkata');
    expect(timezoneForHost('Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('decodes multi-byte output split across chunks', () => {
    const decode = createTextDecoder();
    const bytes = Buffer.from('é');
    expect(decode(bytes.subarray(0, 1))).toBe('');
    expect(decode(bytes.subarray(1), true)).toBe('é');
  });

  it('defines the four WHM profiles with hidden categories', () => {
    expect(Object.keys(PROFILES)).toEqual(['standard', 'dns-only', 'mail-only', 'database-only']);
    expect(PROFILES.standard.hiddenCategories).toEqual([]);
    expect(PROFILES['dns-only'].hiddenCategories).toContain('email');
  });
});

describe('Server Configuration API', () => {
  let app;
  let csrf;
  let resellerHttp;
  let resellerCsrf;
  let installed = { script: false, timedatectl: false, quotacheck: false, quotaon: false, setquota: false, repquota: false };
  let statsInstalled = false;
  let terminalOutput = [];
  let terminalExited = false;
  let terminalCloseReason = null;
  let agentTerminals = [];
  const readTerminal = ({ since }) => {
    const data = Buffer.concat(terminalOutput.map((t) => Buffer.from(t))).subarray(since);
    return { id: TERM_ID, since, offset: since + data.length, data: data.toString('base64'), truncated: false, exited: terminalExited, exitCode: terminalExited ? 0 : null, signal: null, closeReason: terminalCloseReason };
  };
  const writeTerminal = ({ id, data }) => ({ id, bytes: Buffer.byteLength(data) });
  // Like whm-agentd: an empty read long-polls (shortened here) before answering.
  const longPollTerminal = async ({ since, waitMs }) => {
    const r = readTerminal({ since });
    if (!waitMs || r.data || r.exited || r.closeReason) return r;
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 10)));
    return readTerminal({ since });
  };
  const ORPHAN_ID = 'd'.repeat(32);
  let quotaResult = { mountpoint: '/', enabled: true, steps: [{ step: 'quotacheck', ok: true, detail: 'created' }, { step: 'quotaon', ok: true, detail: 'on' }], active: { user: true, group: true } };

  beforeAll(async () => {
    const agent = createMockAgent({
      'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(installed[n])])),
      'sys.time.get': () => ({ now: '2026-10-26T10:00:00.000Z', timezone: 'Etc/UTC', ntp: true, ntpSynchronized: true, rtcLocal: false }),
      'sys.time.set': ({ timezone, ntp }) => ({ timezone, ntp }),
      'quota.status': () => ({ tools: { quotacheck: installed.quotacheck, quotaon: installed.quotaon, quotaoff: Boolean(installed.quotaoff), repquota: installed.repquota, setquota: installed.setquota, mount: true, tune2fs: true }, fstabPath: '/etc/fstab', fstabPresent: true, filesystems: [QUOTA_FS, { ...QUOTA_FS, device: '/dev/vdb1', mountpoint: '/home', userQuotaMounted: true, active: { user: true, group: false } }] }),
      'quota.enable': () => quotaResult,
      'quota.fstab.enable': ({ mountpoint }) => ({ mountpoint, changed: true, previousLine: '/dev/vda1 / ext4 defaults 0 1', line: '/dev/vda1\t/\text4\tdefaults,usrquota,grpquota\t0\t1', backup: '/etc/fstab.whm-bak' }),
      'quota.disable': ({ mountpoint }) => ({ mountpoint, disabled: true, active: { user: false, group: false } }),
      'stats.detect': () => ({ domlogsRoot: '/var/log/whm/domlogs', generators: { awstats: { installed: statsInstalled, bin: statsInstalled ? '/usr/lib/cgi-bin/awstats.pl' : null }, webalizer: { installed: false, bin: null }, analog: { installed: false, bin: null } } }),
      'stats.generate': ({ generator, domain, username }) => (domain === 'nolog.test' ? { generator, domain, skipped: true, reason: 'no_log' } : { generator, domain, username, skipped: false, outputDir: `/var/lib/whm/stats/${username}/${domain}/${generator}` }),
      'terminal.open': ({ shell }) => ({ id: TERM_ID, pid: 4321, shell, exited: false }),
      'terminal.read': longPollTerminal,
      'terminal.write': writeTerminal,
      'terminal.close': ({ id }) => ({ id, existed: true }),
      'terminal.list': () => agentTerminals,
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

  const get = (path) => app.http.get(`/api/server-config${path}`);
  const post = (path, body = {}) => app.http.post(`/api/server-config${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body = {}) => app.http.put(`/api/server-config${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/server-config${path}`).set('X-CSRF-Token', csrf);
  const auditCount = (action) => app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n;
  async function provision(patch) { installed = { ...installed, ...patch }; await app.ctx.capabilities.refresh(); }

  describe('registration', () => {
    it('attaches ctx.serverConfig with its jobs, schedules and capabilities', () => {
      expect(app.ctx.serverConfig).toBeDefined();
      expect(app.ctx.jobs.types()).toEqual(expect.arrayContaining(['server_config.stats.generate', 'server_config.quota.enable']));
      const names = app.ctx.scheduler.list().map((r) => r.name);
      expect(names).toContain('stats-generation');
      // Software owns the only update-check schedule (contract §3).
      expect(names).not.toContain('update-preferences-check');
      expect(app.ctx.jobs.types()).not.toContain('server_config.update.check');
      expect(app.ctx.settings.get('updates.last_check', 'absent')).toBe('absent');
      const caps = app.ctx.capabilities.snapshot().capabilities;
      expect(caps.terminal).toBeDefined();
      expect(Object.keys(caps.quota.binaries)).toEqual(expect.arrayContaining(['quotacheck', 'quotaon', 'quotaoff', 'repquota', 'setquota']));
    });

    it('is root only on every route', async () => {
      const r = (m, p, body) => resellerHttp[m](`/api/server-config${p}`).set('X-CSRF-Token', resellerCsrf).send(body);
      for (const p of ['/profile', '/analytics', '/time', '/quota', '/nodes', '/stats', '/terminal', '/updates', '/marketplace']) await resellerHttp.get(`/api/server-config${p}`).expect(403);
      await r('put', '/profile', { name: 'dns-only' }).expect(403);
      await r('put', '/time', { ntp: true }).expect(403);
      await r('post', '/quota/enable', { mountpoint: '/' }).expect(403);
      await r('post', '/nodes', { name: 'x', hostname: 'a.example.com', token: 'x'.repeat(20) }).expect(403);
      await r('post', '/stats/run', {}).expect(403);
      await r('post', '/terminal', {}).expect(403);
      await r('post', `/terminal/${TERM_ID}/input`, { data: 'id\r' }).expect(403);
      await resellerHttp.get(`/api/server-config/terminal/${TERM_ID}/stream`).expect(403);
      await r('put', '/updates', { tier: 'edge' }).expect(403);
      expect(app.agent.calls).toHaveLength(0);
    });
  });

  describe('Server Profile', () => {
    it('lists profiles with the standard profile active and exposes it in /system/status', async () => {
      const { body } = await get('/profile').expect(200);
      expect(body.data.current).toBe('standard');
      expect(body.data.profiles.map((p) => p.name)).toEqual(['standard', 'dns-only', 'mail-only', 'database-only']);
      const status = await app.http.get('/api/system/status').expect(200);
      expect(status.body.data.profile).toMatchObject({ name: 'standard', hiddenCategories: [] });
    });

    it('switches profile, toggles monitored services and hides categories', async () => {
      await put('/profile', { name: 'nope' }).expect(422);
      const { body } = await put('/profile', { name: 'dns-only' }).expect(200);
      expect(body.data.current).toBe('dns-only');
      const monitored = Object.fromEntries(body.data.services.map((s) => [s.name, s.monitored]));
      expect(monitored.named).toBe(true);
      expect(monitored.httpd).toBe(false);
      expect(monitored.exim).toBe(false);
      expect(body.data.changes.length).toBeGreaterThan(0);
      const status = await app.http.get('/api/system/status').expect(200);
      expect(status.body.data.profile.hiddenCategories).toContain('email');
      // The shell reads the profile from /auth/me to hide those categories.
      expect((await app.http.get('/api/auth/me').expect(200)).body.data.profile.hiddenCategories).toContain('email');
      expect(app.ctx.serverConfig.profile.allows('email')).toBe(false);
      expect(auditCount('server_config.profile.set')).toBe(1);
      const back = await put('/profile', { name: 'standard' }).expect(200);
      expect(Object.fromEntries(back.body.data.services.map((s) => [s.name, s.monitored]))).toMatchObject({ httpd: true, exim: true, nginx: false, mailman: false });
    });
  });

  describe('Configure cPanel Analytics', () => {
    it('reads defaults, validates and assigns a participant id on opt-in', async () => {
      const { body } = await get('/analytics').expect(200);
      expect(body.data).toMatchObject({ enabled: false, participantId: null, shareUsage: true, shareErrors: false });
      await put('/analytics', {}).expect(422);
      await put('/analytics', { enabled: 'yes' }).expect(422);
      const on = await put('/analytics', { enabled: true, shareErrors: true }).expect(200);
      expect(on.body.data.enabled).toBe(true);
      expect(on.body.data.participantId).toMatch(/^[0-9a-f-]{36}$/);
      const first = on.body.data.participantId;
      const rotated = await post('/analytics/rotate-id').expect(200);
      expect(rotated.body.data.participantId).not.toBe(first);
      expect(auditCount('server_config.analytics.update')).toBe(1);
      expect(auditCount('server_config.analytics.rotate_id')).toBe(1);
    });
  });

  describe('Server Time', () => {
    it('returns the clock, NTP state and the timezone list', async () => {
      const { body } = await get('/time').expect(200);
      expect(body.data).toMatchObject({ timezone: 'Etc/UTC', ntp: true, timedatectl: false });
      expect(body.data.timezones).toContain('Europe/Berlin');
    });

    it('refuses changes without timedatectl (501) and validates the timezone', async () => {
      await put('/time', {}).expect(422);
      await put('/time', { timezone: 'Mars/Olympus' }).expect(422);
      await put('/time', { timezone: '../../etc' }).expect(422);
      const res = await put('/time', { timezone: 'Europe/Berlin' }).expect(501);
      expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'timedatectl' });
      expect(app.agent.callsTo('sys.time.set')).toHaveLength(0);
    });

    it('sets timezone and NTP through sys.time.set once timedatectl exists', async () => {
      await provision({ timedatectl: true });
      const { body } = await put('/time', { timezone: 'Europe/Berlin', ntp: false }).expect(200);
      expect(app.agent.callsTo('sys.time.set').pop().args).toEqual({ timezone: 'Europe/Berlin', ntp: false });
      expect(body.data.timedatectl).toBe(true);
      expect(auditCount('server_config.time.set')).toBe(1);
    });

    it('offers the host zone list and hands timedatectl the current name of an ICU legacy id', async () => {
      await provision({ timedatectl: true });
      app.agent.set('sys.time.zones', () => ({ zones: ['Asia/Kolkata', 'Europe/Berlin', 'Etc/UTC'] }));
      const { body } = await get('/time').expect(200);
      expect(body.data.timezoneSource).toBe('host');
      expect(body.data.timezones).toContain('Asia/Kolkata');
      expect(body.data.timezones).not.toContain('Asia/Calcutta');
      await put('/time', { timezone: 'Asia/Calcutta' }).expect(200);
      expect(app.agent.callsTo('sys.time.set').pop().args).toEqual({ timezone: 'Asia/Kolkata' });
      await put('/time', { timezone: 'Europe/London' }).expect(422);
      expect(app.agent.callsTo('sys.time.set').pop().args).toEqual({ timezone: 'Asia/Kolkata' });
    });
  });

  describe('Initial Quota Setup', () => {
    it('describes the filesystems and reports missing tools without failing', async () => {
      const { body } = await get('/quota').expect(200);
      // `enabled` is the kernel state; `enforceable` also needs the tools.
      expect(body.data).toMatchObject({ toolsInstalled: false, homeRoot: '/home', homeFilesystem: '/home', enabled: true, enforceable: false, installPackages: ['quota'] });
      expect(body.data.filesystems.find((f) => f.mountpoint === '/home').holdsHomes).toBe(true);
      expect(body.data.filesystems.find((f) => f.mountpoint === '/').proposedFstabLine).toContain('usrquota');
      expect(await app.ctx.serverConfig.quota.isEnabled()).toBe(false);
      expect(await app.ctx.serverConfig.quota.isEnabled('/home')).toBe(false);
    });

    it('returns 501 for enable/disable while the quota tools are missing and 422 without a package manager', async () => {
      const res = await post('/quota/enable', { mountpoint: '/' }).expect(501);
      expect(res.body.error.capability).toBe('quota');
      await post('/quota/disable', { mountpoint: '/' }).expect(501);
      await post('/quota/enable', { mountpoint: 'relative' }).expect(422);
      await post('/quota/enable', { mountpoint: '/home/../etc' }).expect(422);
      const original = app.ctx.software;
      app.ctx.software = undefined;
      try { await post('/quota/install-tools').expect(422); } finally { app.ctx.software = original; }
    });

    it('needs quotacheck and quotaon to enable even when repquota/setquota satisfy the capability', async () => {
      await provision({ repquota: true, setquota: true });
      expect(app.ctx.capabilities.has('quota')).toBe(true);
      const res = await post('/quota/enable', { mountpoint: '/' }).expect(501);
      expect(res.body.error).toMatchObject({ capability: 'quota' });
      expect(res.body.error.message).toContain('quotacheck');
      expect(app.ctx.jobs.list({ type: 'server_config.quota.enable' })).toHaveLength(0);
      const off = await post('/quota/disable', { mountpoint: '/' }).expect(501);
      expect(off.body.error.message).toContain('quotaoff');
    });

    it('enables quotas as a job, optionally rewriting fstab first', async () => {
      await provision({ quotacheck: true, quotaon: true, quotaoff: true, repquota: true, setquota: true });
      expect((await get('/quota').expect(200)).body.data).toMatchObject({ toolsInstalled: true, enforceable: true });
      expect(await app.ctx.serverConfig.quota.isEnabled()).toBe(true);
      expect(await app.ctx.serverConfig.quota.isEnabled('/')).toBe(false);
      const res = await post('/quota/enable', { mountpoint: '/', updateFstab: true, groupQuota: false }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ enabled: true, fstab: { changed: true } });
      expect(app.agent.callsTo('quota.fstab.enable').pop().args).toEqual({ mountpoint: '/', groupQuota: false });
      expect(app.agent.callsTo('quota.enable').pop().args).toEqual({ mountpoint: '/', groupQuota: false });
      expect(auditCount('server_config.quota.enable')).toBe(1);
      quotaResult = { mountpoint: '/', enabled: false, reason: 'fstab_option_required', steps: [{ step: 'mount-options', ok: false, detail: 'no usrquota' }], fstab: '/dev/vda1\t/\text4\tdefaults,usrquota\t0\t1' };
      const res2 = await post('/quota/enable', { mountpoint: '/' }).expect(202);
      const job2 = await waitForJob(app.ctx, res2.body.data.job.id);
      expect(job2.status).toBe('done');
      expect(job2.result.enabled).toBe(false);
      expect(job2.logs.some((l) => l.line.includes('/etc/fstab'))).toBe(true);
      // An XFS root is mounted from the kernel command line: the log carries the exact boot-loader command.
      const kernelArgs = { method: 'grubby', arg: 'rootflags=uquota,gquota', command: 'grubby --update-kernel=ALL --args=rootflags=uquota,gquota', configured: false };
      quotaResult = { mountpoint: '/', enabled: false, reason: 'kernel_args_required', steps: [{ step: 'kernel-args', ok: false, detail: '/ is mounted by the initramfs' }], fstab: '/dev/vda1\t/\txfs\tdefaults,uquota,gquota\t0\t1', kernelArgs };
      const res3 = await post('/quota/enable', { mountpoint: '/' }).expect(202);
      const job3 = await waitForJob(app.ctx, res3.body.data.job.id);
      expect(job3.status).toBe('done');
      const manual = job3.logs.find((l) => l.level === 'warn' && l.line.includes('kernel command line'));
      expect(manual.line).toContain('Run: grubby --update-kernel=ALL --args=rootflags=uquota,gquota');
      expect(manual.line).toContain('then reboot');
      expect(job3.logs.some((l) => l.line.includes('kernel_args_required'))).toBe(false);
      // Once the boot loader carries the flags, only the reboot is left.
      quotaResult = { ...quotaResult, reason: 'reboot_required', kernelArgs: { ...kernelArgs, configured: true } };
      const job4 = await waitForJob(app.ctx, (await post('/quota/enable', { mountpoint: '/' }).expect(202)).body.data.job.id);
      expect(job4.logs.some((l) => l.level === 'warn' && /already passes rootflags=uquota,gquota .*reboot/.test(l.line))).toBe(true);
      // "Update fstab and enable" applies the kernel arguments itself and says what it changed.
      const fstabOp = app.agent.calls.find((c) => c.name === 'quota.fstab.enable');
      app.agent.set('quota.fstab.enable', ({ mountpoint }) => ({ mountpoint, changed: true, previousLine: '/dev/vda1 / xfs defaults 0 1', line: '/dev/vda1\t/\txfs\tdefaults,uquota,gquota\t0\t1', backup: '/etc/fstab.whm-bak', kernelArgs: { ...kernelArgs, configured: true, applied: true } }));
      try {
        const job5 = await waitForJob(app.ctx, (await post('/quota/enable', { mountpoint: '/', updateFstab: true }).expect(202)).body.data.job.id);
        expect(job5.result.fstab.kernelArgs).toMatchObject({ applied: true, command: kernelArgs.command });
        expect(job5.logs.some((l) => l.line === `boot loader: ${kernelArgs.command}; the kernel passes rootflags=uquota,gquota on the next boot`)).toBe(true);
      } finally {
        app.agent.set('quota.fstab.enable', ({ mountpoint }) => ({ mountpoint, changed: true, previousLine: '/dev/vda1 / ext4 defaults 0 1', line: '/dev/vda1\t/\text4\tdefaults,usrquota,grpquota\t0\t1', backup: '/etc/fstab.whm-bak' }));
        expect(fstabOp).toBeDefined();
      }
      quotaResult = { mountpoint: '/', enabled: true, steps: [], active: { user: true, group: true } };
      const off = await post('/quota/disable', { mountpoint: '/' }).expect(200);
      expect(off.body.data.disabled).toBe(true);
    });

    it('delegates tool installation to the software category when present', async () => {
      const original = app.ctx.software;
      const calls = [];
      app.ctx.software = { pkg: { ensureInstalled: async (names) => { calls.push(names); return { missing: names, job: { id: 99 } }; } } };
      try {
        const res = await post('/quota/install-tools').expect(202);
        expect(res.body.data).toMatchObject({ missing: ['quota'], job: { id: 99 } });
        expect(calls).toEqual([['quota']]);
        app.ctx.software = { pkg: { ensureInstalled: async () => ({ missing: [], job: null }) } };
        const done = await post('/quota/install-tools').expect(200);
        expect(done.body.data).toMatchObject({ missing: [], job: null });
      } finally { app.ctx.software = original; }
    });
  });

  describe('Link Server Nodes', () => {
    let server;
    let port;
    let nodeId;
    let acceptToken = 'remote-token-0123456789abcdef';
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url !== '/api/system/status') { res.writeHead(404); return res.end(); }
        if (req.headers.authorization !== `Bearer ${acceptToken}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Invalid API token' } })); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { hostname: 'node2.example.com', panel: { version: '0.1.0', mode: 'split' }, profile: { name: 'dns-only' }, server: { os: { name: 'Test Linux' } }, capabilities: { bind: true, exim: false }, counts: { accounts: 3 } } }));
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      port = server.address().port;
    });
    afterAll(() => new Promise((r) => server.close(r)));

    it('validates and creates a node, never returning the token', async () => {
      await post('/nodes', { name: 'n1' }).expect(422);
      await post('/nodes', { name: 'n1', hostname: 'bad host', token: acceptToken }).expect(422);
      await post('/nodes', { name: 'n1', hostname: 'node2.example.com', token: 'short' }).expect(422);
      await post('/nodes', { name: 'n1', hostname: 'node2.example.com', token: acceptToken, roles: ['bogus'] }).expect(422);
      const res = await post('/nodes', { name: 'DNS node 2', hostname: '127.0.0.1', port, scheme: 'http', token: acceptToken, roles: ['dns'] }).expect(201);
      expect(res.body.data).toMatchObject({ name: 'DNS node 2', hostname: '127.0.0.1', port, scheme: 'http', hasToken: true, roles: ['dns'], status: 'unknown', enabled: true });
      expect(JSON.stringify(res.body)).not.toContain(acceptToken);
      nodeId = res.body.data.id;
      await post('/nodes', { name: 'DNS node 2', hostname: 'other.example.com', token: acceptToken }).expect(409);
      const row = app.ctx.db.prepare('SELECT api_token_enc FROM server_nodes WHERE id = ?').get(nodeId);
      expect(row.api_token_enc).not.toContain(acceptToken);
      expect(app.ctx.crypto.decrypt(row.api_token_enc)).toBe(acceptToken);
      const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action LIKE 'POST %/server-config/nodes' ORDER BY id DESC LIMIT 1").get();
      expect(audit.args_redacted).toContain('[redacted]');
      expect(audit.args_redacted).not.toContain(acceptToken);
    });

    it('tests the connection against the remote status endpoint', async () => {
      const ok = await post(`/nodes/${nodeId}/test`).expect(200);
      expect(ok.body.data.test.ok).toBe(true);
      expect(ok.body.data).toMatchObject({ status: 'ok', remote: { hostname: 'node2.example.com', version: '0.1.0', profile: 'dns-only', accounts: 3, capabilities: ['bind'] } });
      acceptToken = 'rotated-token-0123456789abcdef';
      const bad = await post(`/nodes/${nodeId}/test`).expect(200);
      expect(bad.body.data.test.ok).toBe(false);
      expect(bad.body.data.status).toBe('error');
      expect(bad.body.data.lastError).toContain('rejected the token');
      await put(`/nodes/${nodeId}`, { token: acceptToken, roles: ['dns', 'backup'], verifyTls: false }).expect(200);
      // A node row echoed back by the UI must be trimmed to its editable keys first.
      const listed = (await get('/nodes').expect(200)).body.data.find((n) => n.id === nodeId);
      const echoed = await put(`/nodes/${nodeId}`, { ...listed, token: '' }).expect(422);
      expect(Object.keys(echoed.body.error.fields)).toContain('_');
      const editable = Object.fromEntries(['name', 'hostname', 'port', 'scheme', 'username', 'verifyTls', 'roles', 'enabled'].map((k) => [k, listed[k]]));
      const saved = await put(`/nodes/${nodeId}`, editable).expect(200);
      expect(saved.body.data).toMatchObject({ id: nodeId, hasToken: true, roles: ['dns', 'backup'] });
      const again = await post(`/nodes/${nodeId}/test`).expect(200);
      expect(again.body.data.test.ok).toBe(true);
      expect(again.body.data.roles).toEqual(['dns', 'backup']);
      await post('/nodes/9999/test').expect(404);
      expect(auditCount('server_config.nodes.test')).toBe(3);
    });

    it('reports a refused connection and removes nodes', async () => {
      const closed = await post('/nodes', { name: 'down', hostname: '127.0.0.1', port: 1, scheme: 'http', token: acceptToken }).expect(201);
      const res = await post(`/nodes/${closed.body.data.id}/test`).expect(200);
      expect(res.body.data.test.ok).toBe(false);
      expect(res.body.data.lastError).toMatch(/refused|ECONNREFUSED|EACCES/);
      await put(`/nodes/${nodeId}`, {}).expect(422);
      await del(`/nodes/${closed.body.data.id}`).expect(200);
      const list = await get('/nodes').expect(200);
      expect(list.body.data.map((n) => n.id)).toEqual([nodeId]);
      await del('/nodes/9999').expect(404);
    });
  });

  describe('Statistics Software Configuration', () => {
    const row = () => app.ctx.scheduler.list().find((r) => r.name === 'stats-generation');

    it('keeps the schedule paused while no enabled generator is installed and resumes once one appears', async () => {
      const { body } = await get('/stats').expect(200);
      expect(body.data).toMatchObject({ generators: { awstats: true, webalizer: false, analog: false }, defaultGenerator: 'awstats', scheduleEnabled: true, schedule: { cron: '17 2 * * *', enabled: false, blockedReason: 'no_generator_installed' } });
      expect(body.data.detect.generators.awstats.installed).toBe(false);
      expect(row().enabled).toBe(0);
      // A paused schedule never enqueues a job that would only log "nothing to do".
      statsInstalled = true;
      const after = await get('/stats').expect(200);
      expect(after.body.data.schedule).toMatchObject({ enabled: true, blockedReason: null });
      expect(row().enabled).toBe(1);
      statsInstalled = false;
      // The boot alignment uses the last probe (no agent call at startup)...
      app.agent.calls.length = 0;
      await app.ctx.serverConfig.stats.alignSchedule();
      expect(app.agent.callsTo('stats.detect')).toHaveLength(0);
      expect(row().enabled).toBe(1);
      // ...while a live sync (page load) probes again.
      await app.ctx.serverConfig.stats.alignSchedule({ live: true });
      expect(row().enabled).toBe(0);
      expect(app.ctx.settings.get('stats.schedule_paused')).toBe('no_generator_installed');
      statsInstalled = true;
      await app.ctx.serverConfig.stats.alignSchedule();
      expect(row().enabled).toBe(0);
      await app.ctx.serverConfig.stats.alignSchedule({ live: true });
      expect(row().enabled).toBe(1);
      expect(app.ctx.settings.get('stats.schedule_paused')).toBeNull();
    });

    it('pauses itself when a scheduled run finds no installed generator', async () => {
      statsInstalled = false;
      app.ctx.scheduler.update('stats-generation', { enabled: true });
      const job = app.ctx.jobs.enqueue('server_config.stats.generate', {});
      const done = await waitForJob(app.ctx, job.id);
      expect(done.status).toBe('done');
      expect(done.result).toMatchObject({ generated: 0, paused: true });
      expect(row().enabled).toBe(0);
      statsInstalled = true;
      await get('/stats').expect(200);
      expect(row().enabled).toBe(1);
    });

    it('leaves a schedule the operator paused in Configure cPanel Cron Jobs alone', async () => {
      await app.http.patch('/api/system/schedules/stats-generation').set('X-CSRF-Token', csrf).send({ enabled: false }).expect(200);
      expect(row().enabled).toBe(0);
      const res = await put('/stats', { allowUserChoice: false }).expect(200);
      expect(res.body.data.schedule).toMatchObject({ enabled: false, blockedReason: null });
      expect(row().enabled).toBe(0);
      await get('/stats').expect(200);
      await app.ctx.serverConfig.stats.alignSchedule();
      expect(row().enabled).toBe(0);
      await app.http.patch('/api/system/schedules/stats-generation').set('X-CSRF-Token', csrf).send({ enabled: true }).expect(200);
      await put('/stats', { allowUserChoice: true }).expect(200);
      expect(row().enabled).toBe(1);
    });

    it('validates settings and disables the schedule when every generator is off', async () => {
      await put('/stats', {}).expect(422);
      await put('/stats', { generators: { awstats: false, analog: true } }).expect(422);
      await put('/stats', { cron: 'not cron' }).expect(422);
      const bad = await put('/stats', { generators: { webalizer: true }, cron: '99 99 * * *' }).expect(422);
      expect(bad.body.error.fields.cron).toBeDefined();
      expect(Boolean(app.ctx.settings.get('stats.generators', {}).webalizer)).toBe(false);
      expect(app.ctx.scheduler.list().find((r) => r.name === 'stats-generation').cron).toBe('17 2 * * *');
      const off = await put('/stats', { generators: { awstats: false, webalizer: true }, defaultGenerator: 'webalizer', cron: '30 3 * * *' }).expect(200);
      // webalizer is on but not installed on this host: paused, not disabled.
      expect(off.body.data.schedule).toMatchObject({ cron: '30 3 * * *', enabled: false, blockedReason: 'no_generator_installed' });
      const none = await put('/stats', { generators: { webalizer: false } }).expect(200);
      expect(none.body.data.schedule).toMatchObject({ enabled: false, blockedReason: 'no_generator_enabled' });
      expect(row().enabled).toBe(0);
      await put('/stats', { enabled: true }).expect(422);
      const back = await put('/stats', { generators: { awstats: true }, defaultGenerator: 'awstats' }).expect(200);
      expect(back.body.data.schedule).toMatchObject({ enabled: true, blockedReason: null });
      expect(auditCount('server_config.stats.update')).toBe(5);
    });

    it('keeps an explicitly disabled schedule off across boots while a generator is on', async () => {
      const off = await put('/stats', { enabled: false }).expect(200);
      expect(off.body.data).toMatchObject({ scheduleEnabled: false, schedule: { enabled: false } });
      await app.ctx.serverConfig.stats.alignSchedule();
      expect(row().enabled).toBe(0);
      await put('/stats', { generators: { webalizer: true } }).expect(200);
      expect(row().enabled).toBe(0);
      const on = await put('/stats', { enabled: true, generators: { webalizer: false } }).expect(200);
      expect(on.body.data).toMatchObject({ scheduleEnabled: true, schedule: { enabled: true } });
      await app.ctx.serverConfig.stats.alignSchedule();
      expect(row().enabled).toBe(1);
      app.ctx.scheduler.update('stats-generation', { enabled: false });
      await app.ctx.serverConfig.stats.alignSchedule();
      expect(row().enabled).toBe(0);
      app.ctx.scheduler.update('stats-generation', { enabled: true });
    });

    it('returns 501 when no enabled generator is installed', async () => {
      statsInstalled = false;
      const res = await post('/stats/run').expect(501);
      expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'stats' });
      await post('/stats/run', { generator: 'nope' }).expect(422);
    });

    it('generates statistics for every domain as a job', async () => {
      statsInstalled = true;
      const db = app.ctx.db;
      const root = db.prepare("SELECT id FROM users WHERE username = 'root'").get();
      db.prepare("INSERT INTO accounts (username, domain, owner_id, home_dir) VALUES ('alice', 'alice.test', ?, '/home/alice')").run(root.id);
      const acct = db.prepare("SELECT id FROM accounts WHERE username = 'alice'").get();
      db.prepare("INSERT INTO account_domains (account_id, domain, type) VALUES (?, 'alice.test', 'main'), (?, 'nolog.test', 'addon')").run(acct.id, acct.id);
      const res = await post('/stats/run').expect(202);
      expect(res.body.data.generators).toEqual(['awstats']);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ domains: 2, generated: 1, skipped: 1, failed: 0 });
      expect(app.agent.callsTo('stats.generate').map((c) => c.args)).toEqual([
        { generator: 'awstats', domain: 'alice.test', username: 'alice' },
        { generator: 'awstats', domain: 'nolog.test', username: 'alice' },
      ]);
      const after = await get('/stats').expect(200);
      expect(after.body.data.lastRun).toMatchObject({ generated: 1 });
      const one = await post('/stats/run', { domain: 'alice.test' }).expect(202);
      const job2 = await waitForJob(app.ctx, one.body.data.job.id);
      expect(job2.result.domains).toBe(1);
      app.agent.fail('stats.generate', 'command_failed', 'awstats blew up');
      const failing = await post('/stats/run', { domain: 'alice.test' }).expect(202);
      const job3 = await waitForJob(app.ctx, failing.body.data.job.id);
      expect(job3.result).toMatchObject({ failed: 1, failures: [{ domain: 'alice.test', error: 'awstats blew up' }] });
      app.agent.reset('stats.generate');
    });
  });

  describe('Terminal', () => {
    it('closes shells the agent still holds for a previous API process', async () => {
      agentTerminals = [{ id: ORPHAN_ID, pid: 777, exited: false, closeReason: null }, { id: 'e'.repeat(32), pid: 778, exited: true, closeReason: null }];
      const list = await get('/terminal').expect(200);
      expect(list.body.data.sessions).toEqual([]);
      expect(app.agent.callsTo('terminal.list')).toHaveLength(1);
      expect(app.agent.callsTo('terminal.close').map((c) => c.args.id)).toEqual([ORPHAN_ID, 'e'.repeat(32)]);
      const rows = app.ctx.db.prepare("SELECT target, args_redacted FROM audit_log WHERE action = 'server_config.terminal.close'").all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ target: ORPHAN_ID });
      expect(rows[0].args_redacted).toContain('orphaned');
      agentTerminals = [];
      await get('/terminal').expect(200);
      expect(app.agent.callsTo('terminal.list')).toHaveLength(1);
      app.ctx.db.prepare("DELETE FROM audit_log WHERE action = 'server_config.terminal.close'").run();
    });

    it('returns 501 while the script utility is missing', async () => {
      const res = await post('/terminal').expect(501);
      expect(res.body.error.capability).toBe('terminal');
      const list = await get('/terminal').expect(200);
      expect(list.body.data).toMatchObject({ sessions: [], installed: false, maxSessions: 3 });
    });

    it('opens a session, accepts input, streams output and closes with audit entries', async () => {
      await provision({ script: true, bash: true });
      await post('/terminal', { shell: '/bin/zsh' }).expect(422);
      const res = await post('/terminal', { shell: '/bin/bash' }).expect(201);
      expect(res.body.data).toMatchObject({ id: TERM_ID, pid: 4321, user: 'root' });
      expect(app.agent.callsTo('terminal.open').pop().args).toEqual({ shell: '/bin/bash', cols: 120, rows: 32, idleMinutes: 15 });
      await post(`/terminal/${TERM_ID}/input`, { data: '' }).expect(422);
      await post(`/terminal/${TERM_ID}/input`, { data: 'bad\0byte' }).expect(422);
      await post(`/terminal/${'b'.repeat(32)}/input`, { data: 'id\r' }).expect(404);
      const typed = await post(`/terminal/${TERM_ID}/input`, { data: 'id\r' }).expect(200);
      expect(typed.body.data.bytes).toBe(3);
      expect(app.agent.callsTo('terminal.write').pop().args).toEqual({ id: TERM_ID, data: 'id\r' });
      await post(`/terminal/${TERM_ID}/input`, { data: 'Hunter2-typed-at-a-prompt\r' }).expect(200);
      const inputRows = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action LIKE 'POST %/terminal/:id/input'").all();
      expect(inputRows.length).toBeGreaterThanOrEqual(2);
      expect(inputRows.at(-1).args_redacted).toBe(JSON.stringify({ bytes: 26 }));
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%Hunter2%' OR args_redacted LIKE '%id\\r%'").get().n).toBe(0);
      const rejected = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action LIKE 'POST %/terminal/:id/input' AND result = 'error:403'").get();
      expect(rejected.args_redacted).toBe(JSON.stringify({ bytes: 3 }));

      terminalOutput = ['root@host:~# id\r\n', 'uid=0(root)\r\n'];
      const events = [];
      const fakeRes = { set() {}, flushHeaders() {}, write(chunk) { const m = String(chunk).match(/^data: (.*)\n\n$/s); if (m) events.push(JSON.parse(m[1])); }, end() { this.ended = true; } };
      const fakeReq = { user: { id: 1, username: 'root', role: 'root' }, on() {} };
      const session = app.ctx.serverConfig.terminal.sessionsForTest().get(TERM_ID);
      fakeReq.user.id = session.user.id;
      app.ctx.serverConfig.terminal.stream(TERM_ID, fakeReq, fakeRes, { pollMs: 10, idlePollMs: 10 });
      await new Promise((r) => setTimeout(r, 80));
      expect(events[0]).toMatchObject({ type: 'open', session: { id: TERM_ID } });
      expect(events.filter((e) => e.type === 'output').map((e) => e.data).join('')).toBe('root@host:~# id\r\nuid=0(root)\r\n');
      // Every read long-polls inside the agent for up to a second.
      expect(app.agent.callsTo('terminal.read').at(-1).args).toEqual({ id: TERM_ID, since: 30, waitMs: 1000 });
      session.lastActivity = Date.now() - 60 * 60_000;
      terminalOutput.push('still running\r\n');
      await new Promise((r) => setTimeout(r, 80));
      expect(Date.now() - session.lastActivity).toBeLessThan(5_000);
      expect(await app.ctx.serverConfig.terminal.sweep()).toEqual([]);
      terminalExited = true;
      await new Promise((r) => setTimeout(r, 80));
      expect(events.at(-1)).toMatchObject({ type: 'exit', code: 0 });
      expect(fakeRes.ended).toBe(true);
      expect(app.ctx.serverConfig.terminal.sessionsForTest().has(TERM_ID)).toBe(false);
      expect(auditCount('server_config.terminal.open')).toBe(1);
      expect(auditCount('server_config.terminal.close')).toBe(1);
      terminalExited = false;
      terminalOutput = [];
    });

    it('refuses another administrator\'s session, limits concurrent sessions and expires idle ones', async () => {
      const open = await post('/terminal').expect(201);
      const sessions = app.ctx.serverConfig.terminal.sessionsForTest();
      const other = { user: { id: 999, username: 'other', role: 'root' } };
      await expect(app.ctx.serverConfig.terminal.write(open.body.data.id, 'x', other)).rejects.toMatchObject({ status: 403 });
      const list = await get('/terminal').expect(200);
      expect(list.body.data.sessions).toHaveLength(1);
      app.ctx.settings.set('terminal.max_sessions', 1);
      await post('/terminal').expect(422);
      app.ctx.settings.set('terminal.max_sessions', 3);
      const session = sessions.get(open.body.data.id);
      session.lastActivity = Date.now() - 60 * 60_000;
      // An attached viewer does not keep an idle shell alive (the agent would end it anyway).
      session.viewers = 1;
      const expired = await app.ctx.serverConfig.terminal.sweep();
      expect(expired).toEqual([open.body.data.id]);
      expect(app.agent.callsTo('terminal.close')).toHaveLength(1);
      expect(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'server_config.terminal.close' ORDER BY id DESC LIMIT 1").get().args_redacted).toContain('idle_timeout');
      const closed = await post('/terminal').expect(201);
      const done = await del(`/terminal/${closed.body.data.id}`).expect(200);
      expect(done.body.data.closed).toBe(true);
      await del(`/terminal/${closed.body.data.id}`).expect(404);
    });

    it('relays output the moment the agent\'s long-poll returns, keeps the heartbeat and stops on close', async () => {
      await post('/terminal').expect(201);
      let wakeRead = null;
      // Like whm-agentd: an empty read waits for the next output, input or waitMs.
      app.agent.set('terminal.read', async ({ since, waitMs }) => {
        const idle = readTerminal({ since });
        if (waitMs && !idle.data && !idle.exited) await new Promise((r) => { wakeRead = r; setTimeout(r, Math.min(waitMs, 300)); });
        return readTerminal({ since });
      });
      app.agent.set('terminal.write', (args) => { wakeRead?.(); return writeTerminal(args); });
      const emit = (text) => { terminalOutput.push(text); wakeRead?.(); };
      const events = [];
      let pings = 0;
      let onClose = null;
      const fakeRes = { set() {}, flushHeaders() {}, write(chunk) { const m = String(chunk).match(/^data: (.*)\n\n$/s); if (m) events.push({ ...JSON.parse(m[1]), at: Date.now() }); else if (String(chunk).startsWith(': ping')) pings++; }, end() { this.ended = true; } };
      const session = app.ctx.serverConfig.terminal.sessionsForTest().get(TERM_ID);
      const fakeReq = { user: { ...session.user }, on(name, fn) { if (name === 'close') onClose = fn; } };
      try {
        app.ctx.serverConfig.terminal.stream(TERM_ID, fakeReq, fakeRes, { heartbeatMs: 20 });
        await new Promise((r) => setTimeout(r, 30));
        expect(session.viewers).toBe(1);
        const reads = app.agent.callsTo('terminal.read').length;
        expect(reads).toBe(1);
        const sentAt = Date.now();
        emit('$ ');
        await new Promise((r) => setTimeout(r, 40));
        const output = events.find((e) => e.type === 'output');
        expect(output.data).toBe('$ ');
        expect(output.at - sentAt).toBeLessThan(30);
        // The next read follows the delivery at once, without an idle sleep.
        expect(app.agent.callsTo('terminal.read').length).toBe(reads + 1);
        expect(app.agent.callsTo('terminal.read').at(-1).args).toMatchObject({ since: 2, waitMs: 1000 });
        emit('one\r\n'); emit('two\r\n');
        await new Promise((r) => setTimeout(r, 40));
        expect(events.filter((e) => e.type === 'output').map((e) => e.data).join('')).toBe('$ one\r\ntwo\r\n');
        // A keystroke wakes the pending read, which answers empty; the next
        // read is issued at once (no idle sleep) so the echo is not held back.
        const readsBeforeKey = app.agent.callsTo('terminal.read').length;
        const outputsBeforeKey = events.filter((e) => e.type === 'output').length;
        const typedAt = Date.now();
        await post(`/terminal/${TERM_ID}/input`, { data: 'l' }).expect(200);
        await new Promise((r) => setTimeout(r, 10));
        expect(app.agent.callsTo('terminal.read').length).toBe(readsBeforeKey + 1);
        expect(events.filter((e) => e.type === 'output')).toHaveLength(outputsBeforeKey);
        const echoedAt = Date.now();
        emit('l');
        await new Promise((r) => setTimeout(r, 20));
        const echo = events.filter((e) => e.type === 'output').at(-1);
        expect(echo.data).toBe('l');
        expect(echo.at - echoedAt).toBeLessThan(30);
        expect(echo.at - typedAt).toBeLessThan(100);
        expect(pings).toBeGreaterThanOrEqual(2);
        onClose();
        expect(fakeRes.ended).toBe(true);
        expect(session.viewers).toBe(0);
        const after = app.agent.callsTo('terminal.read').length;
        emit('late\r\n');
        await new Promise((r) => setTimeout(r, 40));
        expect(app.agent.callsTo('terminal.read').length).toBe(after);
        expect(events.filter((e) => e.type === 'output').map((e) => e.data).join('')).toBe('$ one\r\ntwo\r\nl');
        expect(app.ctx.serverConfig.terminal.sessionsForTest().has(TERM_ID)).toBe(true);
      } finally {
        onClose?.();
        app.agent.set('terminal.read', longPollTerminal);
        app.agent.set('terminal.write', writeTerminal);
        terminalOutput = [];
        await del(`/terminal/${TERM_ID}`).expect(200);
      }
    });

    it('spaces reads under continuous output so a flooding command cannot saturate the viewer', async () => {
      await post('/terminal').expect(201);
      // The shell never stops producing: every read answers at once with 4 KB.
      const chunk = Buffer.from('y\n'.repeat(2048));
      app.agent.set('terminal.read', ({ since }) => ({ id: TERM_ID, since, offset: since + chunk.length, data: chunk.toString('base64'), truncated: false, exited: false, exitCode: null, signal: null, closeReason: null }));
      const events = [];
      let onClose = null;
      const fakeRes = { set() {}, flushHeaders() {}, write(chunk) { const m = String(chunk).match(/^data: (.*)\n\n$/s); if (m) events.push(JSON.parse(m[1])); }, end() { this.ended = true; } };
      const session = app.ctx.serverConfig.terminal.sessionsForTest().get(TERM_ID);
      const fakeReq = { user: { ...session.user }, on(name, fn) { if (name === 'close') onClose = fn; } };
      try {
        app.ctx.serverConfig.terminal.stream(TERM_ID, fakeReq, fakeRes);
        await new Promise((r) => setTimeout(r, 200));
        onClose();
        const outputs = events.filter((e) => e.type === 'output');
        expect(outputs.length).toBeGreaterThanOrEqual(4);
        expect(outputs.length).toBeLessThanOrEqual(16);
        expect(app.agent.callsTo('terminal.read').length - outputs.length).toBeLessThanOrEqual(1);
        expect(outputs.every((e) => e.data === chunk.toString())).toBe(true);
      } finally {
        onClose?.();
        app.agent.set('terminal.read', longPollTerminal);
        await del(`/terminal/${TERM_ID}`).expect(200);
      }
    });

    it('falls back to plain polling when the agent does not know waitMs yet', async () => {
      await post('/terminal').expect(201);
      app.agent.set('terminal.read', ({ since, waitMs }) => {
        if (waitMs !== undefined) throw Object.assign(new Error('Invalid arguments for "terminal.read"'), { agentError: true, code: 'invalid_args', details: { fields: { waitMs: ['Unrecognized key'] } } });
        return readTerminal({ since });
      });
      terminalOutput = ['old agent\r\n'];
      const events = [];
      const fakeRes = { set() {}, flushHeaders() {}, write(chunk) { const m = String(chunk).match(/^data: (.*)\n\n$/s); if (m) events.push(JSON.parse(m[1])); }, end() { this.ended = true; } };
      const session = app.ctx.serverConfig.terminal.sessionsForTest().get(TERM_ID);
      const fakeReq = { user: { ...session.user }, on() {} };
      try {
        app.ctx.serverConfig.terminal.stream(TERM_ID, fakeReq, fakeRes, { idlePollMs: 10 });
        await new Promise((r) => setTimeout(r, 60));
        expect(events.filter((e) => e.type === 'output').map((e) => e.data).join('')).toBe('old agent\r\n');
        expect(events.some((e) => e.type === 'error')).toBe(false);
        const reads = app.agent.callsTo('terminal.read');
        expect(reads[0].args).toMatchObject({ waitMs: 1000 });
        expect(reads.slice(1).every((c) => c.args.waitMs === undefined)).toBe(true);
        expect(reads.length).toBeGreaterThanOrEqual(3);
        terminalExited = true;
        await new Promise((r) => setTimeout(r, 60));
        expect(events.at(-1)).toMatchObject({ type: 'exit', code: 0 });
        expect(fakeRes.ended).toBe(true);
        expect(app.ctx.serverConfig.terminal.sessionsForTest().has(TERM_ID)).toBe(false);
      } finally {
        app.agent.set('terminal.read', longPollTerminal);
        terminalOutput = [];
        terminalExited = false;
      }
    });

    it('reports the agent\'s idle kill as idle_timeout to the viewer and the audit log', async () => {
      await post('/terminal').expect(201);
      const events = [];
      const fakeRes = { set() {}, flushHeaders() {}, write(chunk) { const m = String(chunk).match(/^data: (.*)\n\n$/s); if (m) events.push(JSON.parse(m[1])); }, end() { this.ended = true; } };
      const session = app.ctx.serverConfig.terminal.sessionsForTest().get(TERM_ID);
      const fakeReq = { user: { ...session.user }, on() {} };
      terminalCloseReason = 'idle';
      try {
        app.ctx.serverConfig.terminal.stream(TERM_ID, fakeReq, fakeRes, { pollMs: 10, idlePollMs: 10 });
        await new Promise((r) => setTimeout(r, 80));
        expect(events.at(-1)).toMatchObject({ type: 'exit', reason: 'idle_timeout' });
        expect(events.at(-1).message).toContain('idle');
        expect(fakeRes.ended).toBe(true);
        expect(app.ctx.serverConfig.terminal.sessionsForTest().has(TERM_ID)).toBe(false);
        expect(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'server_config.terminal.close' ORDER BY id DESC LIMIT 1").get().args_redacted).toContain('idle_timeout');
      } finally { terminalCloseReason = null; }
    });
  });

  describe('Update Preferences', () => {
    it('reads the tier and policy, tolerating a missing software category', async () => {
      const original = app.ctx.software;
      app.ctx.software = undefined;
      try {
        const { body } = await get('/updates').expect(200);
        expect(body.data).toMatchObject({ tier: 'stable', auto: true, autoOs: false, softwareAvailable: false, checkAvailable: false, panel: null, os: null, lastCheck: null });
        expect(body.data.tiers.map((t) => t.value)).toEqual(['stable', 'release', 'current', 'edge']);
        // The schedule shown is Software's daily check, not one of our own.
        expect(body.data.schedule).toMatchObject({ name: 'os-update-check', owner: 'software', cron: '41 5 * * *' });
        const res = await post('/updates/check').expect(501);
        expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'pkg' });
      } finally { app.ctx.software = original; }
    });

    it('validates and saves preferences through the Software category', async () => {
      await put('/updates', {}).expect(422);
      await put('/updates', { tier: 'nightly' }).expect(422);
      await put('/updates', { tier: 'edge', cron: '0 6 * * *' }).expect(422);
      await put('/updates', { scheduleEnabled: false }).expect(422);
      expect(app.ctx.settings.get('updates.tier', 'stable')).toBe('stable');
      const { body } = await put('/updates', { tier: 'release', auto: true, autoOs: true, notifyContact: false }).expect(200);
      expect(body.data).toMatchObject({ tier: 'release', auto: true, autoOs: true, notifyContact: false });
      expect(app.ctx.settings.get('updates.tier')).toBe('release');
      expect(app.ctx.settings.get('updates.auto')).toBe(true);
      expect(app.ctx.settings.get('software.updates.auto_os')).toBe(true);
      expect(body.data.panel).toMatchObject({ tier: 'release', autoUpdate: true });
      expect(auditCount('server_config.updates.set')).toBe(1);
      expect(auditCount('software.update.auto')).toBe(1);
      const original = app.ctx.software;
      const calls = [];
      app.ctx.software = { ...original, panel: { ...original.panel, setPreferences: async (prefs) => { calls.push(prefs); } } };
      try {
        await put('/updates', { tier: 'stable', auto: false }).expect(200);
        expect(calls).toEqual([{ tier: 'stable', autoUpdate: false }]);
      } finally { app.ctx.software = original; }
      await put('/updates', { tier: 'stable', auto: false, autoOs: false, notifyContact: true }).expect(200);
    });

    it('"check now" runs Software\'s own update check job and the panel feed', async () => {
      const original = app.ctx.software;
      const originalContacts = app.ctx.contacts;
      const notified = [];
      app.ctx.contacts = { notify: async (event, payload) => { notified.push({ event, payload }); } };
      const panelCheck = [];
      app.ctx.software = { ...original, panel: { ...original.panel, check: async () => { panelCheck.push(1); return { currentVersion: '0.1.0', latest: { version: '0.2.0' }, updateAvailable: true, lastCheck: { at: '2026-10-26T00:00:00.000Z', ok: true, error: null } }; } } };
      app.ctx.jobs.register('software.update.check', async (job) => { job.log('mock check'); return { count: 4, security: 1 }; });
      app.ctx.settings.set('software.update_url', 'https://updates.example.com/feed.json');
      try {
        const res = await post('/updates/check').expect(202);
        expect(res.body.data.panel).toMatchObject({ current: '0.1.0', latest: '0.2.0', updateAvailable: true });
        expect(panelCheck).toHaveLength(1);
        const job = await waitForJob(app.ctx, res.body.data.job.id);
        expect(job.type).toBe('software.update.check');
        expect(job.status).toBe('done');
        await new Promise((r) => setTimeout(r, 30));
        expect(notified.map((n) => n.event)).toEqual(['updates.available', 'updates.available']);
        expect(notified[0].payload.panel).toMatchObject({ updateAvailable: true });
        expect(notified[1].payload.os).toEqual({ count: 4, security: 1 });
        expect(auditCount('server_config.updates.check')).toBe(1);
        expect(app.ctx.jobs.list({ type: 'server_config.update.check' })).toHaveLength(0);
        // Notifications follow the preference and only fire for security updates.
        await put('/updates', { notifyContact: false }).expect(200);
        expect(await app.ctx.serverConfig.updates.afterCheck(1, { count: 2, security: 2 })).toBe(false);
        await put('/updates', { notifyContact: true }).expect(200);
        expect(await app.ctx.serverConfig.updates.afterCheck(1, { count: 2, security: 0 })).toBe(false);
        expect(await app.ctx.serverConfig.updates.afterCheck(1, { skipped: true })).toBe(false);
        expect(await app.ctx.serverConfig.updates.afterCheck(1, { count: 2, security: 2 })).toBe(true);
      } finally { app.ctx.software = original; app.ctx.contacts = originalContacts; app.ctx.settings.set('software.update_url', ''); }
    });
  });

  describe('WHM Marketplace', () => {
    it('lists the static catalog with installed flags and filters', async () => {
      const { body } = await get('/marketplace').expect(200);
      expect(body.data.phase).toBe(5);
      expect(body.data.items.length).toBeGreaterThan(10);
      const awstats = body.data.items.find((i) => i.id === 'awstats');
      expect(awstats).toMatchObject({ installed: false, installPath: '/software/install-distro-packages' });
      expect(body.data.categories).toContain('Security');
      const filtered = await get('/marketplace?category=Statistics&q=web').expect(200);
      expect(filtered.body.data.items.map((i) => i.id)).toEqual(['webalizer']);
      await get('/marketplace?category=Bad;Thing').expect(422);
    });

    it('every configure link in the catalog is a panel function path (the UI shows it on installed add-ons)', async () => {
      const { FUNCTIONS } = await import('../../client/src/nav.js');
      const paths = new Set(FUNCTIONS.map((f) => f.path));
      const { body } = await get('/marketplace').expect(200);
      for (const item of body.data.items) {
        if (item.configure == null) continue;
        expect(paths.has(item.configure.split(/[?#]/)[0]), `${item.id}: ${item.configure}`).toBe(true);
      }
      expect(body.data.items.find((i) => i.id === 'postgresql').configure).toBe('/database-services/manage-database-profiles');
      expect(body.data.items.find((i) => i.id === 'mailman').configure).toBe('/cpanel/reset-a-mailman-password');
      expect(body.data.items.find((i) => i.id === 'roundcube').configure).toBeNull();
    });
  });
});
