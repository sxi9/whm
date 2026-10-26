import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { renderTemplateBody, DEFAULT_TEMPLATES, HOME_ROOTS } from '../src/services/account-functions.js';

// A host with the account tooling installed: users, quota, rsync and Exim exist,
// Apache/BIND/NGINX do not, so the web/dns steps stay "pending" while the ops
// this category owns (quota, shell, logs, rearrange) run against the mock.
const BINS = { useradd: true, usermod: true, userdel: true, chpasswd: true, setquota: true, repquota: true, quotacheck: true, rsync: true, exim4: true, systemctl: true };
const LOG_A = 'alice.com-access.log';
const LOG_B = 'alice.com-error.log.1';
const LOG_BYTES = Buffer.from('GET / 200\n'.repeat(400));

function hostAgent() {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n])])),
    'sys.disk.usage': () => [{ filesystem: '/dev/sda1', sizeBytes: 1e11, usedBytes: 2e10, availableBytes: 8e10, usedPercent: 20, mountpoint: '/' }, { filesystem: '/dev/sdb1', sizeBytes: 5e11, usedBytes: 1e10, availableBytes: 4.9e11, usedPercent: 2, mountpoint: '/home2' }],
    'user.set_shell': ({ username, shell }) => ({ username, shell }),
    'user.set_quota': (args) => args,
    'user.quota_report': ({ filesystem }) => ({ available: true, users: [{ username: 'alice', usedMb: 120, softMb: 10240, hardMb: 10752 }], filesystem }),
    'fs.list': ({ path }) => {
      if (path === '/var/log/whm/domlogs/alice') return { path, entries: [{ name: LOG_A, type: 'file', size: LOG_BYTES.length, mtime: '2026-10-01T00:00:00.000Z', mode: '640' }, { name: LOG_B, type: 'file', size: 10, mtime: '2026-09-01T00:00:00.000Z', mode: '640' }, { name: 'notes.txt', type: 'file', size: 1, mtime: null, mode: '644' }, { name: 'sub', type: 'dir', size: null, mtime: null, mode: '755' }] };
      if (path === '/home/alice/logs') return { path, entries: [{ name: 'php-error.log', type: 'file', size: 5, mtime: '2026-10-02T00:00:00.000Z', mode: '600' }] };
      if (path === '/home2/alice') return { path, entries: [] };
      const err = Object.assign(new Error(`ENOENT: ${path}`), { agentError: true, code: 'op_failed' });
      throw err;
    },
    'acct.read_range': ({ path, offset, length }) => {
      const slice = LOG_BYTES.subarray(offset, offset + length);
      return { path, size: LOG_BYTES.length, offset, length: slice.length, data: slice.toString('base64'), eof: offset + slice.length >= LOG_BYTES.length };
    },
    'fs.stat': ({ path }) => ({ path, exists: ['/home', '/home2', '/home/alice', '/var/log/whm/domlogs/alice'].includes(path), isDirectory: true, uid: 0 }),
    'fs.du': ({ path }) => ({ path, bytes: 4096 }),
    'fs.copy_tree': ({ from, to }) => ({ from, to }),
    'fs.remove': ({ path }) => ({ path }),
    'fs.mkdir': ({ path }) => ({ path }),
    'fs.chown': ({ path }) => ({ path }),
    'fs.write_file': ({ path, content }) => ({ path, bytes: Buffer.byteLength(content) }),
    'acct.set_home': ({ username, homeDir }) => ({ username, home: homeDir, uid: 30001, previousHome: '/home/alice' }),
    'mail.sendmail': ({ from, to }) => ({ from, to, accepted: true, bytes: 100 }),
  });
}

describe('template rendering', () => {
  it('substitutes and escapes variables and leaves unknown ones empty', () => {
    expect(renderTemplateBody('<h1>{{domain}}</h1>{{ missing }}', { domain: '<x>&y' })).toBe('<h1>&lt;x&gt;&amp;y</h1>');
    for (const body of Object.values(DEFAULT_TEMPLATES)) expect(renderTemplateBody(body, { domain: 'a.com', hostname: 'h', contact_email: 'r@h', status: '404', status_text: 'Not Found' })).not.toMatch(/\{\{/);
  });
});

describe('Account Functions API', () => {
  let app;
  let csrf;
  let reseller;
  let resellerHttp;
  let resellerCsrf;
  // The web category registers ctx.web at boot; these tests remove it so the
  // provisioning statuses do not depend on which categories are loaded.
  let savedWeb;

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    savedWeb = app.ctx.web;
    delete app.ctx.web;
    csrf = await app.login();
    reseller = await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', owner: 'resell1', contactEmail: 'bob@bob.com' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.com' }).expect(201);
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
    app.ctx.jobs.start();
  });
  afterAll(() => { if (savedWeb) app.ctx.web = savedWeb; return app.close(); });
  beforeEach(() => { app.agent.calls.length = 0; });

  const post = (path, body = {}) => app.http.post(`/api/account-functions${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body = {}) => app.http.put(`/api/account-functions${path}`).set('X-CSRF-Token', csrf).send(body);
  const get = (path) => app.http.get(`/api/account-functions${path}`);
  const rput = (path, body = {}) => resellerHttp.put(`/api/account-functions${path}`).set('X-CSRF-Token', resellerCsrf).send(body);
  const rpost = (path, body = {}) => resellerHttp.post(`/api/account-functions${path}`).set('X-CSRF-Token', resellerCsrf).send(body);
  const rget = (path) => resellerHttp.get(`/api/account-functions${path}`);

  describe('account creation and termination through the categories', () => {
    it('records a provisioning status per step and renders the index template', async () => {
      const res = await post('/x', {}); // warm-up: unknown route is 404, keeps the CSRF cookie fresh
      expect(res.status).toBe(404);
      const created = await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'dave', domain: 'dave.com' }).expect(201);
      const p = created.body.data.provisioning;
      expect(p.systemUser).toBe(true);
      expect(p.web).toBe('skipped');
      expect(['pending', 'applied']).toContain(p.dns);
      // Exim exists on this mock host but does not read the panel's domain lists: a soft failure, recorded and not fatal.
      expect(p.mail).toBe('failed');
      expect(p.steps.mail.detail).toMatch(/domain lists|Exim/);
      expect(p.database).toBe('pending');
      expect(p.steps.dns.detail).toMatch(/BIND|zone/);
      expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM dns_zones WHERE domain = ?').get('dave.com').n).toBe(1);
      const index = app.agent.callsTo('fs.write_file').find((c) => c.args.path === '/home/dave/public_html/index.html');
      expect(index.args.content).toContain('<h1>dave.com</h1>');
      expect(index.args.content).not.toContain('{{');
    });

    it('rolls the account back when a provisioning step fails hard', async () => {
      const dns = app.ctx.dns;
      app.ctx.dns = { ...dns, ensureZoneForDomain: async () => { throw Object.assign(new Error('named exploded'), { agentError: true, code: 'command_failed' }); }, removeZonesForAccount: dns.removeZonesForAccount };
      try {
        const res = await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'erin', domain: 'erin.com' });
        expect(res.status).toBe(500);
        expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE username = ?').get('erin').n).toBe(0);
        expect(app.agent.callsTo('user.delete')).toHaveLength(1);
      } finally { app.ctx.dns = dns; }
    });

    it('terminates through every category and keeps the response shape', async () => {
      const removed = [];
      const web = { removeAccount: async (u) => { removed.push(`web:${u}`); return { username: u, removed: ['dave.com'], pool: false, pools: [] }; } };
      app.ctx.web = web;
      try {
        const res = await app.http.delete('/api/accounts/dave').set('X-CSRF-Token', csrf).expect(200);
        expect(res.body.data).toEqual({ username: 'dave', domain: 'dave.com', terminated: true });
        expect(removed).toEqual(['web:dave']);
        expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM dns_zones WHERE domain = ?').get('dave.com').n).toBe(0);
        expect(app.agent.callsTo('user.delete')).toHaveLength(1);
        const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.terminate' ORDER BY id DESC LIMIT 1").get();
        expect(JSON.parse(audit.args_redacted).cleanup.web.removed).toEqual(['dave.com']);
      } finally { delete app.ctx.web; }
    });
  });

  describe('summary and bulk flags', () => {
    it('lists a summary scoped by ownership', async () => {
      const all = await get('/summary').expect(200);
      expect(all.body.data.map((a) => a.username).sort()).toEqual(['alice', 'bob', 'carol']);
      const own = await rget('/summary').expect(200);
      expect(own.body.data.map((a) => a.username)).toEqual(['bob']);
    });

    it('forces password changes and demo mode in bulk, reporting foreign accounts as missing', async () => {
      const res = await post('/force-password-change', { usernames: ['alice', 'carol', 'ghost'], enabled: true }).expect(200);
      expect(res.body.data).toMatchObject({ enabled: true, changed: ['alice', 'carol'], missing: ['ghost'] });
      const again = await post('/force-password-change', { usernames: ['alice'], enabled: true }).expect(200);
      expect(again.body.data.unchanged).toEqual(['alice']);
      expect((await app.http.get('/api/accounts/alice')).body.data.force_password_change).toBe(true);
      const off = await post('/force-password-change', { all: true, enabled: false }).expect(200);
      expect(off.body.data.changed.sort()).toEqual(['alice', 'carol']);

      const demo = await rpost('/demo-mode', { usernames: ['bob', 'alice'], enabled: true }).expect(200);
      expect(demo.body.data).toMatchObject({ changed: ['bob'], missing: ['alice'] });
      expect((await get('/summary')).body.data.find((a) => a.username === 'bob').demo_mode).toBe(true);
      expect((await post('/demo-mode', { enabled: true })).status).toBe(422);
      expect((await post('/demo-mode', { usernames: ['-r'], enabled: true })).status).toBe(422);
    });
  });

  describe('change site IP', () => {
    it('updates the account, rewrites A records and refuses unknown or same addresses', async () => {
      const ip = app.ctx.ip;
      delete app.ctx.ip;
      try {
        const zone = await app.http.get('/api/dns/zones/alice.com').expect(200);
        const before = zone.body.data.records.filter((r) => r.type === 'A').map((r) => r.value);
        expect(before.length).toBeGreaterThan(0);
        await app.http.put('/api/accounts/alice').set('X-CSRF-Token', csrf).send({ ip: before[0] });
        app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username = ?').run(before[0], 'alice');
        const res = await put('/ip/alice', { ip: '203.0.113.77' }).expect(200);
        expect(res.body.data).toMatchObject({ username: 'alice', previousIp: before[0], ip: '203.0.113.77', web: { applied: false, reason: 'web_category_missing' } });
        expect(res.body.data.dns.some((d) => d.domain === 'alice.com' && d.name)).toBe(true);
        const after = await app.http.get('/api/dns/zones/alice.com').expect(200);
        expect(after.body.data.records.filter((r) => r.type === 'A').every((r) => r.value === '203.0.113.77')).toBe(true);
        expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.77');
        expect((await put('/ip/alice', { ip: '203.0.113.77' })).status).toBe(409);
        expect((await put('/ip/alice', { ip: 'not-an-ip' })).status).toBe(422);
        expect((await rput('/ip/alice', { ip: '203.0.113.78' })).status).toBe(403);
      } finally { if (ip) app.ctx.ip = ip; }
    });

    it('validates against IP Functions when it is loaded', async () => {
      const res = await put('/ip/alice', { ip: '198.51.100.9' });
      expect([200, 422]).toContain(res.status);
      if (res.status === 422) expect(res.body.error.fields.ip).toBeDefined();
    });
  });

  describe('bandwidth', () => {
    it('sets limits, lists exceeders, resets counters and unsuspends exceeders', async () => {
      const set = await put('/bandwidth/alice', { limitMb: 100 }).expect(200);
      expect(set.body.data).toMatchObject({ username: 'alice', bandwidth_limit_mb: 100 });
      app.ctx.db.prepare('UPDATE accounts SET bandwidth_used_mb = 150 WHERE username = ?').run('alice');
      const ex = await get('/bandwidth/exceeders').expect(200);
      expect(ex.body.data.map((a) => a.username)).toEqual(['alice']);
      expect(ex.body.data[0]).toMatchObject({ over_bandwidth: true, bandwidth_percent: 150, suspended_for_bandwidth: false });

      await put('/bandwidth-enforcement', { enabled: true }).expect(200);
      expect(app.ctx.scheduler.list().find((s) => s.name === 'account-bandwidth-enforce').enabled).toBe(1);
      const job = app.ctx.jobs.enqueue('accounts.bandwidth_enforce', {});
      const done = await waitForJob(app.ctx, job.id);
      expect(done.status).toBe('done');
      expect(done.result.suspended).toEqual(['alice']);
      expect((await app.http.get('/api/accounts/alice')).body.data).toMatchObject({ suspended: true, suspend_reason: expect.stringMatching(/^bandwidth/) });

      const un = await post('/bandwidth/unsuspend-exceeders', { all: true, resetCounters: true }).expect(200);
      expect(un.body.data.unsuspended).toEqual(['alice']);
      expect((await app.http.get('/api/accounts/alice')).body.data).toMatchObject({ suspended: false, bandwidth_used_mb: 0 });

      app.ctx.db.prepare('UPDATE accounts SET bandwidth_used_mb = 42 WHERE username = ?').run('carol');
      const reset = await post('/bandwidth/reset', { usernames: ['carol'] }).expect(200);
      expect(reset.body.data.reset).toEqual(['carol']);
      expect((await app.http.get('/api/accounts/carol')).body.data.bandwidth_used_mb).toBe(0);
      await put('/bandwidth-enforcement', { enabled: false }).expect(200);
      expect(app.ctx.scheduler.list().find((s) => s.name === 'account-bandwidth-enforce').enabled).toBe(0);

      expect((await put('/bandwidth/alice', { limitMb: -1 })).status).toBe(422);
      expect((await post('/bandwidth/reset', {})).status).toBe(422);
      expect((await rput('/bandwidth/alice', { limitMb: 5 })).status).toBe(403);
      expect((await resellerHttp.put('/api/account-functions/bandwidth-enforcement').set('X-CSRF-Token', resellerCsrf).send({ enabled: true })).status).toBe(403);
    });
  });

  describe('shell and quota', () => {
    it('changes the shell through usermod and refuses a missing jailshell', async () => {
      const res = await put('/shell/alice', { shell: '/bin/bash' }).expect(200);
      expect(res.body.data).toMatchObject({ shell: '/bin/bash', applied: true });
      expect(app.agent.callsTo('user.set_shell')).toEqual([{ name: 'user.set_shell', args: { username: 'alice', shell: '/bin/bash' } }]);
      const jailed = await put('/shell/alice', { shell: '/usr/local/bin/jailshell' });
      expect(jailed.status).toBe(501);
      expect(jailed.body.error).toMatchObject({ code: 'capability_missing', capability: 'jailshell' });
      expect((await put('/shell/alice', { shell: '/bin/zsh' })).status).toBe(422);
      expect((await rput('/shell/alice', { shell: '/bin/sh' })).status).toBe(403);
    });

    it('applies quotas with setquota on the home filesystem and reports usage', async () => {
      const res = await put('/quota/alice', { diskQuotaMb: 2048 }).expect(200);
      expect(res.body.data).toMatchObject({ disk_quota_mb: 2048, applied: true, filesystem: '/' });
      expect(app.agent.callsTo('user.set_quota')[0].args).toEqual({ username: 'alice', softMb: 2048, hardMb: 2150, filesystem: '/' });
      const unlimited = await put('/quota/alice', { diskQuotaMb: null }).expect(200);
      expect(app.agent.callsTo('user.set_quota')[1].args).toMatchObject({ softMb: 0, hardMb: 0 });
      expect(unlimited.body.data.disk_quota_mb).toBeNull();
      const report = await get('/quota/report').expect(200);
      expect(report.body.data.find((a) => a.username === 'alice').live).toEqual({ usedMb: 120, softMb: 10240, hardMb: 10752 });
      expect((await put('/quota/alice', { diskQuotaMb: 'lots' })).status).toBe(422);
    });

    it('saves the quota and answers 501 when the quota tools are missing', async () => {
      app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n]) && !/quota/.test(n)])));
      await app.ctx.capabilities.refresh();
      try {
        const res = await put('/quota/alice', { diskQuotaMb: 512 });
        expect(res.status).toBe(501);
        expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'quota' });
        expect((await app.http.get('/api/accounts/alice')).body.data.disk_quota_mb).toBe(512);
        expect((await get('/quota/report')).status).toBe(501);
      } finally {
        app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n])])));
        await app.ctx.capabilities.refresh();
      }
    });
  });

  describe('raw log download', () => {
    it('lists log files from the domlogs and home trees and streams one in ranges', async () => {
      const list = await get('/logs/apache/alice').expect(200);
      expect(list.body.data.files.map((f) => f.name)).toEqual([LOG_A, LOG_B, 'php-error.log']);
      const dl = await get(`/logs/apache/alice/download?file=${LOG_A}`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
      expect(dl.status).toBe(200);
      expect(dl.headers['content-disposition']).toBe(`attachment; filename="alice-${LOG_A}"`);
      expect(dl.headers['content-length']).toBe(String(LOG_BYTES.length));
      expect(Buffer.compare(dl.body, LOG_BYTES)).toBe(0);
      expect(app.agent.callsTo('acct.read_range').length).toBeGreaterThanOrEqual(1);
      expect((await get('/logs/apache/alice/download?file=notes.txt')).status).toBe(404);
      expect((await get('/logs/apache/alice/download?file=../passwd')).status).toBe(422);
      expect((await rget(`/logs/apache/alice/download?file=${LOG_A}`)).status).toBe(403);
      expect((await get('/logs/iis/alice')).status).toBe(422);
    });

    it('answers 501 for NGINX logs while NGINX is not installed', async () => {
      const res = await get('/logs/nginx/alice');
      expect(res.status).toBe(501);
      expect(res.body.error.capability).toBe('nginx');
    });
  });

  describe('rearrange an account', () => {
    it('lists partitions and moves the home through rsync, usermod and the panel records', async () => {
      const parts = await get('/rearrange/partitions').expect(200);
      expect(parts.body.data.roots.map((r) => r.root)).toEqual(HOME_ROOTS);
      expect(parts.body.data.roots.find((r) => r.root === '/home2')).toMatchObject({ exists: true, mountpoint: '/home2', filesystem: '/dev/sdb1' });
      const start = await post('/rearrange/alice', { target: '/home2' }).expect(202);
      expect(start.body.data).toMatchObject({ from: '/home/alice', to: '/home2/alice', bytes: 4096 });
      const job = await waitForJob(app.ctx, start.body.data.job.id);
      expect(job.status, job.error).toBe('done');
      expect(app.agent.callsTo('fs.copy_tree').map((c) => c.args)).toEqual([{ from: '/home/alice', to: '/home2/alice' }, { from: '/home/alice', to: '/home2/alice', deleteExtraneous: true }]);
      expect(app.agent.callsTo('acct.set_home')).toEqual([{ name: 'acct.set_home', args: { username: 'alice', homeDir: '/home2/alice' } }]);
      expect(app.agent.callsTo('fs.remove')).toEqual([{ name: 'fs.remove', args: { path: '/home/alice', recursive: true } }]);
      const account = (await app.http.get('/api/accounts/alice')).body.data;
      expect(account.home_dir).toBe('/home2/alice');
      expect(account.domains[0].docroot).toBe('/home2/alice/public_html');
      expect((await post('/rearrange/alice', { target: '/home2' })).status).toBe(409);
      expect((await post('/rearrange/alice', { target: '/opt' })).status).toBe(422);
      expect((await rpost('/rearrange/bob', { target: '/home2' })).status).toBe(403);
    });

    it('answers 501 without rsync', async () => {
      app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n]) && n !== 'rsync'])));
      await app.ctx.capabilities.refresh();
      try {
        const res = await post('/rearrange/carol', { target: '/home2' });
        expect(res.status).toBe(501);
        expect(res.body.error.capability).toBe('rsync');
        expect((await post('/log-retention/archive', {})).status).toBe(501);
      } finally {
        app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n])])));
        await app.ctx.capabilities.refresh();
      }
    });
  });

  describe('web log retention', () => {
    it('stores per-account settings and archives logs into the home through the agent', async () => {
      const defaults = await get('/log-retention/carol').expect(200);
      expect(defaults.body.data).toMatchObject({ archive_logs: false, remove_old_archives: true, retain_months: 3, configured: false });
      const set = await put('/log-retention/alice', { archiveLogs: true, retainMonths: 2 }).expect(200);
      expect(set.body.data).toMatchObject({ archive_logs: true, retain_months: 2, configured: true, archive_dir: '/home2/alice/logs/archive' });
      const list = await get('/log-retention').expect(200);
      expect(list.body.data.accounts.find((a) => a.username === 'alice').archive_logs).toBe(true);
      app.agent.set('fs.list', ({ path }) => (path === '/home2/alice/logs/archive' ? { path, entries: [{ name: '2020-01', type: 'dir' }, { name: '2099-01', type: 'dir' }] } : { path, entries: [] }));
      const run = await post('/log-retention/archive', { username: 'alice' }).expect(202);
      const job = await waitForJob(app.ctx, run.body.data.job.id);
      expect(job.status, job.error).toBe('done');
      expect(job.result.archived).toEqual(['alice']);
      expect(job.result.pruned).toEqual(['alice/2020-01']);
      expect(app.agent.callsTo('fs.copy_tree').at(-1).args).toMatchObject({ from: '/var/log/whm/domlogs/alice', to: expect.stringMatching(/^\/home2\/alice\/logs\/archive\/\d{4}-\d{2}$/) });
      expect(app.agent.callsTo('fs.remove').at(-1).args).toEqual({ path: '/home2/alice/logs/archive/2020-01', recursive: true });
      expect((await get('/log-retention/alice')).body.data.last_archived_at).toBeTruthy();
      expect((await put('/log-retention/alice', { retainMonths: 0 })).status).toBe(422);
      expect((await rput('/log-retention/alice', { archiveLogs: true })).status).toBe(403);
      expect((await rput('/log-retention/bob', { archiveLogs: true })).status).toBe(200);
    });
  });

  describe('web template editor', () => {
    it('lists, previews, saves to /etc/whm/templates and resets templates (root only)', async () => {
      const list = await get('/templates').expect(200);
      expect(list.body.data.templates.map((t) => t.name)).toEqual(['index', 'suspended', 'moved', 'error-4xx']);
      const preview = await post('/templates/error-4xx/preview', { status: '403', status_text: 'Forbidden', domain: 'alice.com' }).expect(200);
      expect(preview.body.data.html).toContain('403 Forbidden');
      expect(preview.body.data.html).toContain('alice.com');
      const custom = '<!doctype html><html><body><h1>Suspended: {{domain}}</h1><p>{{reason}}</p></body></html>';
      const saved = await put('/templates/suspended', { body: custom }).expect(200);
      expect(saved.body.data).toMatchObject({ name: 'suspended', body: custom, written: true });
      expect(app.agent.callsTo('fs.write_file')[0].args).toMatchObject({ path: '/etc/whm/templates/suspended.html', content: custom, owner: 'root' });
      expect((await get('/templates/suspended')).body.data.body).toBe(custom);
      expect((await get('/templates')).body.data.templates.find((t) => t.name === 'suspended').customised).toBe(true);
      expect(app.ctx.accountFunctions.renderTemplate('suspended', { domain: 'x.com', reason: 'late' })).toContain('<h1>Suspended: x.com</h1><p>late</p>');
      const reset = await post('/templates/suspended/reset').expect(200);
      expect(reset.body.data.body).toBe(DEFAULT_TEMPLATES.suspended);
      expect((await put('/templates/suspended', { body: 'just text' })).status).toBe(422);
      expect((await put('/templates/bogus', { body: custom })).status).toBe(422);
      expect((await rget('/templates')).status).toBe(403);
      expect((await rput('/templates/index', { body: custom })).status).toBe(403);
    });
  });

  describe('email all users', () => {
    it('previews recipients, sends through the mail server as a job and needs Exim', async () => {
      const who = await get('/email/recipients?scope=all').expect(200);
      expect(who.body.data).toMatchObject({ total: 3, withoutEmail: 1 });
      expect(who.body.data.recipients.map((r) => r.username).sort()).toEqual(['alice', 'bob']);
      expect((await rget('/email/recipients')).body.data.recipients.map((r) => r.username)).toEqual(['bob']);

      const mail = app.ctx.mail;
      delete app.ctx.mail;
      try {
        const res = await post('/email', { subject: 'Maintenance for {{domain}}', text: 'Hello {{username}}, we reboot tonight.' }).expect(202);
        expect(res.body.data.recipients).toBe(2);
        const job = await waitForJob(app.ctx, res.body.data.job.id);
        expect(job.status, job.error).toBe('done');
        expect(job.result.sent.sort()).toEqual(['alice', 'bob']);
        const sent = app.agent.callsTo('mail.sendmail');
        expect(sent).toHaveLength(2);
        expect(sent.find((c) => c.args.to[0] === 'alice@alice.com').args).toMatchObject({ subject: 'Maintenance for alice.com', text: 'Hello alice, we reboot tonight.' });
      } finally { app.ctx.mail = mail; }

      expect((await post('/email', { subject: 'x\ny', text: 'body' })).status).toBe(422);
      expect((await post('/email', { subject: 'x', text: 'body', scope: 'suspended' })).status).toBe(422);
      expect((await rpost('/email', { subject: 'Reseller note', text: 'hi', owner: 'root' })).status).toBe(202);

      app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n]) && n !== 'exim4'])));
      await app.ctx.capabilities.refresh();
      try {
        const res = await post('/email', { subject: 'x', text: 'body' });
        expect(res.status).toBe(501);
        expect(res.body.error.capability).toBe('exim');
      } finally {
        app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n])])));
        await app.ctx.capabilities.refresh();
      }
    });
  });
});
