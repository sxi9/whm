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
  const mtimes = {};
  // Appended to that file right after it is listed, before it is read (the
  // listing/read race on a busy site).
  let growAfterList = null;
  let quotaInstalled = false;
  let quotaUsers = [];

  beforeAll(async () => {
    const agent = createMockAgent({
      'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, quotaInstalled && ['repquota', 'setquota'].includes(n)])),
      'fs.list': ({ path }) => {
        const entries = Object.entries(files).filter(([p]) => p.startsWith(`${path}/`)).map(([p, content]) => ({ name: p.slice(path.length + 1), type: 'file', size: Buffer.byteLength(content), mtime: mtimes[p] ?? null, mode: '644' }));
        if (!entries.length) throw Object.assign(new Error(`ENOENT: ${path}`), { agentError: true, code: 'op_failed' });
        if (growAfterList && growAfterList.path.startsWith(`${path}/`)) { files[growAfterList.path] += growAfterList.content; growAfterList = null; }
        return { path, entries };
      },
      'sys.read_file': ({ path, maxBytes, tail }) => {
        const buf = Buffer.from(files[path] ?? '');
        const length = Math.min(buf.length, maxBytes);
        const position = tail ? buf.length - length : 0;
        return { path, size: buf.length, truncated: buf.length > length, content: buf.subarray(position, position + length).toString('utf8') };
      },
      'acct.read_range': ({ path, offset, length }) => {
        const buf = Buffer.from(files[path] ?? '');
        const want = Math.max(0, Math.min(length, buf.length - offset));
        return { path, size: buf.length, offset, length: want, data: buf.subarray(offset, offset + want).toString('base64'), eof: offset + want >= buf.length, mtime: mtimes[path] ?? null };
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
    let bobBytes = 0;
    let aliceJan2020 = 999;

    it('parses access logs into monthly totals and only re-reads appended bytes', async () => {
      files[aliceLog] = line(1, monthName, year, 40 * 1048576) + line(2, monthName, year, 20 * 1048576) + line(3, 'Jan', 2020, 999);
      files[aliceSsl] = line(1, monthName, year, 5 * 1048576);
      files[bobLog] = line(1, monthName, year, 1024) + '203.0.113.7 - - [02/';
      let res = await post('/bandwidth/collect').expect(202);
      let job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ files: 3, requests: 5, exceeded: [], suspended: [], enforcement: false, recovered: 0, pending: 0 });
      expect(app.agent.callsTo('acct.read_range')).toHaveLength(3);
      expect(app.agent.callsTo('sys.read_file')).toHaveLength(0);

      const list = await get('/bandwidth').expect(200);
      expect(list.body.meta).toMatchObject({ period: currentPeriod(), total: 2, enforcement: { enabled: false } });
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
      const reads = app.agent.callsTo('acct.read_range');
      expect(reads.map((c) => c.args.path).sort()).toEqual([bobLog, aliceLog].sort());
      const aliceRead = reads.find((c) => c.args.path === aliceLog).args;
      expect(aliceRead.length).toBe(Buffer.byteLength(line(5, monthName, year, 20 * 1048576)));
      expect(aliceRead.offset).toBe(Buffer.byteLength(files[aliceLog]) - aliceRead.length);
      const after = await get('/bandwidth').expect(200);
      expect(after.body.data.find((a) => a.username === 'alice')).toMatchObject({ usedMb: 85, warn: true, over: false });
      expect(after.body.data.find((a) => a.username === 'bob').bytes).toBe(1024 + 2048 + 4096);
      expect(app.ctx.db.prepare('SELECT bandwidth_used_mb FROM accounts WHERE username = ?').get('alice').bandwidth_used_mb).toBe(85);
      bobBytes = 1024 + 2048 + 4096;
    });

    it('loses nothing when the file grows between the listing and the read', async () => {
      files[bobLog] += line(4, monthName, year, 300);
      growAfterList = { path: bobLog, content: line(4, monthName, year, 500) + '203.0.113.7 - - [05/' };
      const res = await post('/bandwidth/collect').expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result).toMatchObject({ files: 1, requests: 2, pending: 0 });
      const reads = app.agent.callsTo('acct.read_range').filter((c) => c.args.path === bobLog);
      expect(reads).toHaveLength(2);
      expect(reads[0].args.length).toBe(Buffer.byteLength(line(4, monthName, year, 300)));
      expect(reads[1].args.offset).toBe(reads[0].args.offset + reads[0].args.length);
      bobBytes += 300 + 500;
      expect((await get('/bandwidth').expect(200)).body.data.find((a) => a.username === 'bob').bytes).toBe(bobBytes);
      const source = app.ctx.db.prepare('SELECT bytes_processed, size FROM account_bandwidth_sources WHERE path = ?').get(bobLog);
      expect(source.size).toBe(Buffer.byteLength(files[bobLog]));
      expect(source.bytes_processed).toBe(source.size - Buffer.byteLength('203.0.113.7 - - [05/'));
    });

    it('reads the remainder on the next run when a file outgrows the per-run limit', async () => {
      await put('/bandwidth/settings', { maxLogBytes: 65536 }).expect(200);
      const big = line(6, monthName, year, 10).repeat(Math.ceil(70000 / Buffer.byteLength(line(6, monthName, year, 10))));
      files[bobLog] = files[bobLog].replace('203.0.113.7 - - [05/', '') + big;
      const total = big.split('\n').length - 1;
      let res = await post('/bandwidth/collect').expect(202);
      let job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result.pending).toBeGreaterThan(0);
      expect(job.result.requests).toBeLessThan(total);
      expect(job.logs.some((l) => /still unread/.test(l.line))).toBe(true);
      res = await post('/bandwidth/collect').expect(202);
      job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result.pending).toBe(0);
      bobBytes += total * 10;
      expect((await get('/bandwidth').expect(200)).body.data.find((a) => a.username === 'bob').bytes).toBe(bobBytes);
      await put('/bandwidth/settings', { maxLogBytes: 32 * 1024 * 1024 }).expect(200);
    });

    it('counts the tail of a rotated log from its .1 copy before starting the new file', async () => {
      const unread = line(8, monthName, year, 50);
      // Last run an hour ago, rotation half an hour ago.
      app.ctx.db.prepare("UPDATE account_bandwidth_sources SET last_seen_at = datetime('now', '-1 hour') WHERE path = ?").run(bobLog);
      files[`${bobLog}.1`] = files[bobLog] + unread;
      files[`${bobLog}.2.gz`] = 'not readable';
      mtimes[`${bobLog}.1`] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      files[bobLog] = line(9, monthName, year, 100);
      const res = await post('/bandwidth/collect').expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result).toMatchObject({ recovered: 50, files: 1 });
      expect(job.logs.some((l) => /rotated to bob\.com-access\.log\.1; counted its last/.test(l.line))).toBe(true);
      const tail = app.agent.callsTo('sys.read_file');
      expect(tail).toHaveLength(1);
      expect(tail[0].args).toMatchObject({ path: `${bobLog}.1`, maxBytes: Buffer.byteLength(unread), tail: true });
      const live = app.agent.callsTo('acct.read_range').filter((c) => c.args.path === bobLog);
      expect(live[0].args.offset).toBe(0);
      bobBytes += 50 + 100;
      expect((await get('/bandwidth').expect(200)).body.data.find((a) => a.username === 'bob').bytes).toBe(bobBytes);
      // The copy is not re-read on the next run.
      app.agent.calls.length = 0;
      const again = await waitForJob(app.ctx, (await post('/bandwidth/collect').expect(202)).body.data.job.id);
      expect(again.result.recovered).toBe(0);
      expect(app.agent.callsTo('sys.read_file')).toHaveLength(0);
    });

    it('detects a dateext rotation even when the new file already outgrew the old offset', async () => {
      const oldContent = files[aliceLog];
      const unread = line(10, 'Jan', 2020, 111);
      app.ctx.db.prepare("UPDATE account_bandwidth_sources SET last_seen_at = datetime('now', '-1 hour') WHERE path = ?").run(aliceLog);
      files[`${aliceLog}-20260101`] = oldContent + unread;
      files[`${aliceLog}-20260101.gz`] = 'zipped';
      mtimes[`${aliceLog}-20260101`] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const fresh = line(11, 'Jan', 2020, 222).repeat(Math.ceil(Buffer.byteLength(oldContent) / Buffer.byteLength(line(11, 'Jan', 2020, 222))) + 1);
      files[aliceLog] = fresh;
      expect(Buffer.byteLength(fresh)).toBeGreaterThan(Buffer.byteLength(oldContent));
      const res = await post('/bandwidth/collect').expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result.recovered).toBe(111);
      expect(app.agent.callsTo('sys.read_file')[0].args).toMatchObject({ path: `${aliceLog}-20260101`, maxBytes: Buffer.byteLength(unread) });
      aliceJan2020 += 111 + 222 * (fresh.split('\n').length - 1);
      expect((await get('/bandwidth?period=2020-01').expect(200)).body.data.find((a) => a.username === 'alice').bytes).toBe(aliceJan2020);
      // Current-month totals are untouched: the new file only holds 2020 lines.
      expect((await get('/bandwidth').expect(200)).body.data.find((a) => a.username === 'alice')).toMatchObject({ usedMb: 85 });
    });

    it('starts over with a warning when a log shrank and no readable copy is left', async () => {
      delete files[`${bobLog}.1`];
      files[bobLog] = line(12, monthName, year, 7);
      const res = await post('/bandwidth/collect').expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.logs.some((l) => /no readable copy/.test(l.line) && l.level === 'warn')).toBe(true);
      expect(job.result.recovered).toBe(0);
      bobBytes += 7;
      expect((await get('/bandwidth').expect(200)).body.data.find((a) => a.username === 'bob').bytes).toBe(bobBytes);
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

    it('hands enforcement to Account Functions so its exceeder tools find what the collector suspended', async () => {
      await put('/bandwidth/settings', { warnPercent: 'yes' }).expect(422);
      await put('/bandwidth/settings', { suspendOnExceed: true }).expect(422);
      await put('/bandwidth/settings', { suspendReason: 'nope' }).expect(422);
      await rput('/bandwidth/settings', { warnPercent: 50 }).expect(403);
      let settings = await get('/bandwidth/settings').expect(200);
      expect(settings.body.data.settings).toMatchObject({ warnPercent: 80 });
      expect(settings.body.data.settings).not.toHaveProperty('suspendOnExceed');
      expect(settings.body.data.enforcement).toMatchObject({ enabled: false, managedBy: 'account-functions/limit-bandwidth-usage' });
      expect(settings.body.data.logsRoot).toBe('/var/log/whm/domlogs');
      // A stale enforcement toggle from an older version of this category is ignored.
      app.ctx.settings.set('account_info.bandwidth', { ...app.ctx.settings.get('account_info.bandwidth'), suspendOnExceed: true, suspendReason: 'legacy' });

      files[aliceLog] += line(6, monthName, year, 30 * 1048576);
      let res = await post('/bandwidth/collect').expect(202);
      let job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result).toMatchObject({ exceeded: ['alice'], suspended: [], enforcement: false });
      expect(job.logs.some((l) => /Limit Bandwidth Usage/.test(l.line))).toBe(true);
      expect(app.ctx.db.prepare('SELECT suspended FROM accounts WHERE username = ?').get('alice').suspended).toBe(0);
      expect((await get('/bandwidth?scope=over').expect(200)).body.data.map((a) => a.username)).toEqual(['alice']);

      const af = (path) => app.http.put(`/api/account-functions${path}`).set('X-CSRF-Token', csrf);
      await af('/bandwidth-enforcement').send({ enabled: true, reason: 'Over the monthly transfer limit' }).expect(200);
      settings = await get('/bandwidth/settings').expect(200);
      expect(settings.body.data.enforcement).toMatchObject({ enabled: true, reason: 'bandwidth: Over the monthly transfer limit' });
      expect((await get('/bandwidth').expect(200)).body.meta.enforcement.enabled).toBe(true);
      res = await post('/bandwidth/collect').expect(202);
      job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result).toMatchObject({ exceeded: ['alice'], suspended: ['alice'], enforcement: true });
      const row = app.ctx.db.prepare('SELECT suspended, suspend_reason FROM accounts WHERE username = ?').get('alice');
      expect(row).toEqual({ suspended: 1, suspend_reason: 'bandwidth: Over the monthly transfer limit' });
      expect(app.agent.callsTo('user.lock').map((c) => c.args.username)).toEqual(['alice']);
      const audit = app.ctx.db.prepare("SELECT principal, action, target, args_redacted FROM audit_log WHERE action = 'account.suspend' AND principal = 'system'").all();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ principal: 'system', action: 'account.suspend', target: 'alice' });
      expect(JSON.parse(audit[0].args_redacted)).toMatchObject({ by: 'accounts.bandwidth_enforce', trigger: 'account_info.bandwidth_collect' });

      // Unsuspend Bandwidth Exceeders recognises the suspension.
      const exceeders = await app.http.get('/api/account-functions/bandwidth/exceeders').expect(200);
      expect(exceeders.body.data.map((a) => [a.username, a.suspended_for_bandwidth])).toEqual([['alice', true]]);

      // Already suspended accounts are left alone on the next run.
      res = await post('/bandwidth/collect').expect(202);
      job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.result.suspended).toEqual([]);
      const lifted = await app.http.post('/api/account-functions/bandwidth/unsuspend-exceeders').set('X-CSRF-Token', csrf).send({ usernames: ['alice'] }).expect(200);
      expect(lifted.body.data.unsuspended).toEqual(['alice']);
      expect(app.ctx.db.prepare('SELECT suspended FROM accounts WHERE username = ?').get('alice').suspended).toBe(0);
      await af('/bandwidth-enforcement').send({ enabled: false }).expect(200);
    });

    it('resets counters for the current month or everything', async () => {
      await rpost('/bandwidth/bob/reset').expect(404);
      await post('/bandwidth/alice/reset', { period: 'nope' }).expect(422);
      const res = await rpost('/bandwidth/alice/reset').expect(200);
      expect(res.body.data).toMatchObject({ username: 'alice', all: false, period: currentPeriod() });
      expect((await get('/bandwidth').expect(200)).body.data.find((a) => a.username === 'alice').bytes).toBe(0);
      expect((await get('/bandwidth?period=2020-01').expect(200)).body.data.find((a) => a.username === 'alice').bytes).toBe(aliceJan2020);
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
