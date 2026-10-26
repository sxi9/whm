import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { parseAccessLog, slugify, currentPeriod } from '../src/services/account-information.js';

const line = (day, month, year, bytes, status = 200) => `203.0.113.7 - - [${String(day).padStart(2, '0')}/${month}/${year}:10:00:00 +0000] "GET /index.html HTTP/1.1" ${status} ${bytes} "-" "curl/8"\n`;
const [year, monthNum] = currentPeriod().split('-');
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = MONTH_NAMES[Number(monthNum) - 1];

describe('access log parsing', () => {
  it('sums bytes per month over complete lines only', () => {
    const content = line(1, 'Jan', 2026, 100) + line(2, 'Jan', 2026, '-') + line(3, 'Feb', 2026, 50, 404) + 'garbage line\n' + '203.0.113.7 - - [04/Feb/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 9';
    const r = parseAccessLog(content);
    expect(r.periods).toEqual({ '2026-01': 100, '2026-02': 50 });
    expect(r.lines).toBe(4);
    expect(r.requests).toBe(3);
    expect(r.consumedBytes).toBe(Buffer.byteLength(content) - Buffer.byteLength('203.0.113.7 - - [04/Feb/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 9'));
    expect(parseAccessLog('')).toEqual({ periods: {}, lines: 0, requests: 0, consumedBytes: 0 });
  });

  it('slugifies enhancement names', () => {
    expect(slugify('Extra Mailboxes (50)')).toBe('extra-mailboxes-50');
    expect(slugify('--CDN--')).toBe('cdn');
  });
});

describe('Account Information API', () => {
  let app;
  let csrf;
  let resellerHttp;
  let resellerCsrf;
  const files = {};
  let quotaInstalled = false;
  let quotaUsers = [];

  beforeAll(async () => {
    const agent = createMockAgent({
      'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, quotaInstalled && ['repquota', 'setquota'].includes(n)])),
      'fs.list': ({ path }) => {
        const entries = Object.entries(files).filter(([p]) => p.startsWith(`${path}/`)).map(([p, content]) => ({ name: p.slice(path.length + 1), type: 'file', size: Buffer.byteLength(content), mtime: null, mode: '644' }));
        if (!entries.length) throw Object.assign(new Error(`ENOENT: ${path}`), { agentError: true, code: 'op_failed' });
        return { path, entries };
      },
      'sys.read_file': ({ path, maxBytes, tail }) => {
        const buf = Buffer.from(files[path] ?? '');
        const length = Math.min(buf.length, maxBytes);
        const position = tail ? buf.length - length : 0;
        return { path, size: buf.length, truncated: buf.length > length, content: buf.subarray(position, position + length).toString('utf8') };
      },
      'fs.du': ({ path }) => ({ path, bytes: path.endsWith('/alice') ? 1500 * 1048576 : 10 * 1048576 }),
      'user.quota_report': () => ({ available: quotaInstalled, users: quotaUsers }),
      'user.lock': ({ username }) => ({ username, locked: true }),
    });
    app = await createTestApp({ agent });
    app.ctx.jobs.start();
    csrf = await app.login();
    const reseller = await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', owner: 'resell1' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com' }).expect(201);
    const db = app.ctx.db;
    const alice = db.prepare('SELECT id FROM accounts WHERE username = ?').get('alice').id;
    const bob = db.prepare('SELECT id FROM accounts WHERE username = ?').get('bob').id;
    const ins = db.prepare('INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, ?, ?, ?)');
    ins.run(alice, 'shop.alice.com', 'sub', '/home/alice/public_html/shop');
    ins.run(alice, 'alice-store.net', 'addon', '/home/alice/public_html/store');
    ins.run(alice, 'blog.alice-store.net', 'sub', '/home/alice/public_html/store/blog');
    ins.run(alice, 'alice.org', 'parked', '/home/alice/public_html');
    ins.run(bob, 'bob.net', 'alias', '/home/bob/public_html');
    ins.run(bob, 'mail.bob.com', 'sub', '/home/bob/public_html/mail');
    db.prepare('UPDATE accounts SET disk_quota_mb = 1000, bandwidth_limit_mb = 100 WHERE username = ?').run('alice');
    db.prepare('UPDATE accounts SET disk_quota_mb = 500, bandwidth_limit_mb = NULL WHERE username = ?').run('bob');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  const get = (path) => app.http.get(`/api/account-info${path}`);
  const post = (path, body = {}) => app.http.post(`/api/account-info${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body = {}) => app.http.put(`/api/account-info${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/account-info${path}`).set('X-CSRF-Token', csrf);
  const rget = (path) => resellerHttp.get(`/api/account-info${path}`);
  const rpost = (path, body = {}) => resellerHttp.post(`/api/account-info${path}`).set('X-CSRF-Token', resellerCsrf).send(body);
  const rput = (path, body = {}) => resellerHttp.put(`/api/account-info${path}`).set('X-CSRF-Token', resellerCsrf).send(body);

  describe('domain lists', () => {
    it('lists parked (alias) domains with their account and owner', async () => {
      const res = await get('/domains?type=parked').expect(200);
      expect(res.body.meta).toMatchObject({ total: 2, type: 'parked' });
      expect(res.body.data.map((d) => d.domain)).toEqual(['alice.org', 'bob.net']);
      expect(res.body.data[0]).toMatchObject({ type: 'parked', username: 'alice', owner: 'resell1', account_domain: 'alice.com', parent: 'alice.com', docroot: '/home/alice/public_html', suspended: false });
    });

    it('lists subdomains and resolves the addon domain they hang off', async () => {
      const res = await get('/domains?type=sub&sort=domain').expect(200);
      expect(res.body.meta.total).toBe(3);
      const byName = Object.fromEntries(res.body.data.map((d) => [d.domain, d]));
      expect(byName['blog.alice-store.net'].parent).toBe('alice-store.net');
      expect(byName['shop.alice.com'].parent).toBe('alice.com');
      expect(byName['mail.bob.com']).toMatchObject({ username: 'bob', parent: 'bob.com' });
    });

    it('searches and filters by account', async () => {
      expect((await get('/domains?type=sub&q=store').expect(200)).body.data.map((d) => d.domain)).toEqual(['blog.alice-store.net']);
      expect((await get('/domains?type=all&account=bob').expect(200)).body.meta.total).toBe(3);
      expect((await get('/domains?type=sub&q=bob').expect(200)).body.data.map((d) => d.domain)).toEqual(['mail.bob.com']);
    });

    it('limits resellers to their own accounts', async () => {
      const res = await rget('/domains?type=all').expect(200);
      expect(res.body.data.every((d) => d.username === 'alice')).toBe(true);
      expect(res.body.meta.total).toBe(5);
    });

    it('rejects bad query values', async () => {
      await get('/domains?type=weird').expect(422);
      await get('/domains?account=Bad;User').expect(422);
    });
  });

  describe('accounts over quota', () => {
    it('refreshes disk usage with du when quotas are not installed and lists exceeders', async () => {
      const res = await post('/quota/refresh').expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ source: 'du', measured: 2, over: ['alice'] });
      expect(app.agent.callsTo('fs.du').map((c) => c.args.path).sort()).toEqual(['/home/alice', '/home/bob']);
      expect(app.agent.callsTo('user.quota_report')).toHaveLength(0);

      const list = await get('/quota').expect(200);
      expect(list.body.meta).toMatchObject({ total: 1, scope: 'over', quota: { installed: false, source: 'du' } });
      expect(list.body.meta.quota.lastRefresh).toBeTruthy();
      expect(list.body.data[0]).toMatchObject({ username: 'alice', disk_used_mb: 1500, disk_quota_mb: 1000, percent: 150, over: true, warn: true });
      const all = await get('/quota?scope=all&sort=username&dir=asc').expect(200);
      expect(all.body.data.map((a) => [a.username, a.disk_used_mb, a.percent])).toEqual([['alice', 1500, 150], ['bob', 10, 2]]);
      expect((await get('/quota?scope=warn').expect(200)).body.meta.total).toBe(1);
    });

    it('reports 501 for the system quota report when quota tools are missing', async () => {
      const res = await get('/quota/report').expect(501);
      expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'quota' });
      expect(res.body.error.message).toMatch(/not installed/);
    });

    it('prefers repquota figures once quotas are installed', async () => {
      quotaInstalled = true;
      quotaUsers = [{ username: 'alice', usedMb: 900, softMb: 1000, hardMb: 1050 }, { username: 'bob', usedMb: 600, softMb: 500, hardMb: 525 }, { username: 'sysuser', usedMb: 1, softMb: 0, hardMb: 0 }];
      await app.ctx.capabilities.refresh();
      try {
        const report = await get('/quota/report').expect(200);
        expect(report.body.data.filesystem).toBe('/');
        expect(report.body.data.users.find((u) => u.username === 'bob')).toMatchObject({ managed: true, domain: 'bob.com', over: true });
        expect(report.body.data.users.find((u) => u.username === 'sysuser')).toMatchObject({ managed: false, over: false });

        const res = await post('/quota/refresh').expect(202);
        const job = await waitForJob(app.ctx, res.body.data.job.id);
        expect(job.result).toMatchObject({ source: 'repquota', over: ['bob'] });
        expect(app.agent.callsTo('fs.du')).toHaveLength(0);
        const list = await get('/quota').expect(200);
        expect(list.body.data.map((a) => a.username)).toEqual(['bob']);
        expect(list.body.meta.quota.installed).toBe(true);
      } finally {
        quotaInstalled = false;
        quotaUsers = [];
        await app.ctx.capabilities.refresh();
      }
    });

    it('is root-only for refresh and report, reseller-scoped for the list', async () => {
      await rpost('/quota/refresh').expect(403);
      await rget('/quota/report').expect(403);
      const res = await rget('/quota?scope=all').expect(200);
      expect(res.body.data.map((a) => a.username)).toEqual(['alice']);
      await get('/quota?scope=nope').expect(422);
    });
  });

  describe('bandwidth usage', () => {
    const aliceLog = '/var/log/whm/domlogs/alice/alice.com-access.log';
    const aliceSsl = '/var/log/whm/domlogs/alice/alice.com-ssl-access.log';
    const bobLog = '/var/log/whm/domlogs/bob/bob.com-access.log';

    it('parses access logs into monthly totals and only re-reads appended bytes', async () => {
      files[aliceLog] = line(1, monthName, year, 40 * 1048576) + line(2, monthName, year, 20 * 1048576) + line(3, 'Jan', 2020, 999);
      files[aliceSsl] = line(1, monthName, year, 5 * 1048576);
      files[bobLog] = line(1, monthName, year, 1024) + '203.0.113.7 - - [02/';
      let res = await post('/bandwidth/collect').expect(202);
      let job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ files: 3, requests: 5, exceeded: [], suspended: [] });
      expect(app.agent.callsTo('sys.read_file')).toHaveLength(3);

      const list = await get('/bandwidth').expect(200);
      expect(list.body.meta).toMatchObject({ period: currentPeriod(), total: 2, suspendOnExceed: false });
      expect(list.body.meta.periods).toContain('2020-01');
      expect(list.body.meta.totalBytes).toBe(65 * 1048576 + 1024);
      const alice = list.body.data.find((a) => a.username === 'alice');
      expect(alice).toMatchObject({ usedMb: 65, bandwidth_limit_mb: 100, percent: 65, over: false, warn: false });
      expect(list.body.data.find((a) => a.username === 'bob')).toMatchObject({ usedMb: 0, bytes: 1024, percent: null, over: false });
      expect((await get('/bandwidth?period=2020-01').expect(200)).body.data.find((a) => a.username === 'alice').bytes).toBe(999);

      // Append: the partial line from before is now complete and a new one arrives.
      files[bobLog] += `${monthName}/${year}:11:00:00 +0000] "GET /b HTTP/1.1" 200 2048 "-" "x"\n` + line(3, monthName, year, 4096);
      files[aliceLog] += line(5, monthName, year, 20 * 1048576);
      app.agent.calls.length = 0;
      res = await post('/bandwidth/collect').expect(202);
      job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result).toMatchObject({ files: 2, requests: 3, exceeded: [] });
      const reads = app.agent.callsTo('sys.read_file');
      expect(reads.map((c) => c.args.path).sort()).toEqual([bobLog, aliceLog].sort());
      expect(reads.find((c) => c.args.path === aliceLog).args.maxBytes).toBe(Buffer.byteLength(line(5, monthName, year, 20 * 1048576)));
      const after = await get('/bandwidth').expect(200);
      expect(after.body.data.find((a) => a.username === 'alice')).toMatchObject({ usedMb: 85, warn: true, over: false });
      expect(after.body.data.find((a) => a.username === 'bob').bytes).toBe(1024 + 2048 + 4096);
      expect(app.ctx.db.prepare('SELECT bandwidth_used_mb FROM accounts WHERE username = ?').get('alice').bandwidth_used_mb).toBe(85);
    });

    it('starts over after log rotation', async () => {
      files[bobLog] = line(9, monthName, year, 100);
      const res = await post('/bandwidth/collect').expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.logs.some((l) => /rotated/.test(l.line))).toBe(true);
      expect((await get('/bandwidth').expect(200)).body.data.find((a) => a.username === 'bob').bytes).toBe(1024 + 2048 + 4096 + 100);
    });

    it('returns a per-account monthly history with the limit', async () => {
      const res = await get('/bandwidth/alice?months=3').expect(200);
      expect(res.body.data).toMatchObject({ username: 'alice', domain: 'alice.com', owner: 'resell1', limitMb: 100 });
      expect(res.body.data.months).toHaveLength(3);
      expect(res.body.data.months.at(-1)).toMatchObject({ period: currentPeriod(), usedMb: 85, percent: 85 });
      expect(res.body.data.sources.map((s) => s.path).sort()).toEqual([aliceLog, aliceSsl].sort());
      await get('/bandwidth/alice?months=99').expect(422);
      await get('/bandwidth/nobody').expect(404);
      await rget('/bandwidth/bob').expect(404);
      await rget('/bandwidth/alice').expect(200);
    });

    it('suspends exceeders only when the setting is on and audits it as system', async () => {
      await put('/bandwidth/settings', { suspendOnExceed: 'yes' }).expect(422);
      await rput('/bandwidth/settings', { suspendOnExceed: true }).expect(403);
      let settings = await get('/bandwidth/settings').expect(200);
      expect(settings.body.data.settings).toMatchObject({ suspendOnExceed: false, warnPercent: 80 });
      expect(settings.body.data.logsRoot).toBe('/var/log/whm/domlogs');

      files[aliceLog] += line(6, monthName, year, 30 * 1048576);
      let res = await post('/bandwidth/collect').expect(202);
      let job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result).toMatchObject({ exceeded: ['alice'], suspended: [] });
      expect(app.ctx.db.prepare('SELECT suspended FROM accounts WHERE username = ?').get('alice').suspended).toBe(0);
      expect((await get('/bandwidth?scope=over').expect(200)).body.data.map((a) => a.username)).toEqual(['alice']);

      settings = await put('/bandwidth/settings', { suspendOnExceed: true, suspendReason: 'Over the monthly transfer limit' }).expect(200);
      expect(settings.body.data.settings.suspendOnExceed).toBe(true);
      res = await post('/bandwidth/collect').expect(202);
      job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result).toMatchObject({ exceeded: ['alice'], suspended: ['alice'] });
      const row = app.ctx.db.prepare('SELECT suspended, suspend_reason FROM accounts WHERE username = ?').get('alice');
      expect(row).toEqual({ suspended: 1, suspend_reason: 'Over the monthly transfer limit' });
      expect(app.agent.callsTo('user.lock').map((c) => c.args.username)).toEqual(['alice']);
      const audit = app.ctx.db.prepare("SELECT principal, action, target FROM audit_log WHERE action = 'account.suspend' AND principal = 'system'").all();
      expect(audit).toEqual([{ principal: 'system', action: 'account.suspend', target: 'alice' }]);

      // Already suspended accounts are left alone on the next run.
      res = await post('/bandwidth/collect').expect(202);
      job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result.suspended).toEqual([]);
      await put('/bandwidth/settings', { suspendOnExceed: false }).expect(200);
      await app.http.post('/api/accounts/alice/unsuspend').set('X-CSRF-Token', csrf).expect(200);
    });

    it('resets counters for the current month or everything', async () => {
      await rpost('/bandwidth/bob/reset').expect(404);
      await post('/bandwidth/alice/reset', { period: 'nope' }).expect(422);
      const res = await rpost('/bandwidth/alice/reset').expect(200);
      expect(res.body.data).toMatchObject({ username: 'alice', all: false, period: currentPeriod() });
      expect((await get('/bandwidth').expect(200)).body.data.find((a) => a.username === 'alice').bytes).toBe(0);
      expect((await get('/bandwidth?period=2020-01').expect(200)).body.data.find((a) => a.username === 'alice').bytes).toBe(999);
      await post('/bandwidth/alice/reset', { all: true }).expect(200);
      expect((await get('/bandwidth?period=2020-01').expect(200)).body.data.find((a) => a.username === 'alice').bytes).toBe(0);
      await rpost('/bandwidth/collect').expect(403);
      await get('/bandwidth?period=2026-13').expect(422);
    });

    it('keeps the hourly collection and 6-hourly disk scan schedules registered', () => {
      const names = app.ctx.scheduler.list().map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(['account-bandwidth', 'account-disk-usage']));
    });
  });

  describe('enhancements', () => {
    it('creates, lists, updates and deletes enhancements (root only)', async () => {
      await rpost('/enhancements', { name: 'Nope' }).expect(403);
      await post('/enhancements', { name: '' }).expect(422);
      await post('/enhancements', { name: 'Bad limits', limits: { 'Max-Thing': 1 } }).expect(422);
      await post('/enhancements', { name: 'Bad id', id: '../x' }).expect(422);
      const created = await post('/enhancements', { name: 'Extra Mailboxes (50)', description: 'Fifty more mailboxes', limits: { max_email: 50, priority_support: true } }).expect(201);
      expect(created.body.data).toMatchObject({ id: 'extra-mailboxes-50', name: 'Extra Mailboxes (50)', limits: { max_email: 50, priority_support: true }, enabled: true, assigned: 0 });
      await post('/enhancements', { name: 'Extra Mailboxes (50)' }).expect(409);
      await post('/enhancements', { name: 'Other', id: 'extra-mailboxes-50' }).expect(409);
      await post('/enhancements', { name: 'CDN', id: 'cdn', limits: { cdn: true, max_db: 2 } }).expect(201);

      const list = await rget('/enhancements').expect(200);
      expect(list.body.data.map((e) => e.id)).toEqual(['cdn', 'extra-mailboxes-50']);
      const upd = await put('/enhancements/cdn', { description: 'Edge caching', limits: { cdn: true, max_db: 5 } }).expect(200);
      expect(upd.body.data).toMatchObject({ description: 'Edge caching', limits: { max_db: 5 } });
      await put('/enhancements/cdn', { name: 'Extra Mailboxes (50)' }).expect(409);
      await put('/enhancements/missing', { name: 'x' }).expect(404);
      await rput('/enhancements/cdn', { name: 'x' }).expect(403);
    });

    it('assigns enhancements to accounts with ownership checks and merges limits', async () => {
      await rput('/accounts/bob/enhancements', { enhancements: ['cdn'] }).expect(404);
      await put('/accounts/alice/enhancements', { enhancements: ['nope'] }).expect(404);
      await put('/accounts/alice/enhancements', { enhancements: 'cdn' }).expect(422);
      const set = await rput('/accounts/alice/enhancements', { enhancements: ['cdn', 'extra-mailboxes-50'] }).expect(200);
      expect(set.body.data.map((e) => e.id)).toEqual(['cdn', 'extra-mailboxes-50']);
      expect(set.body.data[0].assigned_by).toBe('resell1');
      await post('/accounts/alice/enhancements/cdn').expect(409);
      const bobAdd = await post('/accounts/bob/enhancements/cdn').expect(201);
      expect(bobAdd.body.data.map((e) => e.id)).toEqual(['cdn']);

      const accounts = await get('/enhancements/cdn/accounts').expect(200);
      expect(accounts.body.data.map((a) => a.username)).toEqual(['alice', 'bob']);
      expect((await rget('/enhancements/cdn/accounts').expect(200)).body.data.map((a) => a.username)).toEqual(['alice']);
      expect((await get('/enhancements/cdn').expect(200)).body.data.assigned).toBe(2);

      await post('/enhancements', { name: 'Bigger DB', id: 'bigger-db', limits: { max_db: 10, cdn: false } }).expect(201);
      await post('/accounts/alice/enhancements/bigger-db').expect(201);
      const effective = await get('/accounts/alice/enhancements/effective').expect(200);
      expect(effective.body.data).toEqual({ cdn: true, max_db: 10, max_email: 50, priority_support: true });
      await put('/enhancements/bigger-db', { enabled: false }).expect(200);
      expect((await get('/accounts/alice/enhancements/effective').expect(200)).body.data.max_db).toBe(5);

      const removed = await del('/accounts/alice/enhancements/bigger-db').expect(200);
      expect(removed.body.data.map((e) => e.id)).toEqual(['cdn', 'extra-mailboxes-50']);
      await del('/accounts/alice/enhancements/bigger-db').expect(404);
      expect(app.ctx.accountInfo.enhancements.forAccount('alice', { role: 'root' }).map((e) => e.id)).toEqual(['cdn', 'extra-mailboxes-50']);
    });

    it('deleting an enhancement unassigns it everywhere', async () => {
      await resellerHttp.delete('/api/account-info/enhancements/cdn').set('X-CSRF-Token', resellerCsrf).expect(403);
      const res = await del('/enhancements/cdn').expect(200);
      expect(res.body.data).toMatchObject({ id: 'cdn', deleted: true, unassignedFrom: 2 });
      expect((await get('/accounts/bob/enhancements').expect(200)).body.data).toEqual([]);
      await del('/enhancements/cdn').expect(404);
      const audit = app.ctx.db.prepare("SELECT action, target FROM audit_log WHERE action LIKE 'enhancement.%' ORDER BY id").all();
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['enhancement.create', 'enhancement.update', 'enhancement.assign', 'enhancement.unassign', 'enhancement.delete']));
    });
  });

  it('summarises the category for the overview card', async () => {
    const res = await get('/overview').expect(200);
    expect(res.body.data).toMatchObject({ accounts: 2, suspended: 0, domains: { main: 2, sub: 3, parked: 1, alias: 1, addon: 1 } });
    expect((await rget('/overview').expect(200)).body.data.accounts).toBe(1);
  });
});
