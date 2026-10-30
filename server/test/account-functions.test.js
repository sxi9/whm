import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { renderTemplateBody, DEFAULT_TEMPLATES, HOME_ROOTS, domainLogFile, isStockTemplate } from '../src/services/account-functions.js';

// A host with the account tooling installed: users, quota, rsync and Exim exist,
// Apache/BIND/NGINX do not, so the web/dns steps stay "pending" while the ops
// this category owns (quota, shell, logs, rearrange) run against the mock.
const BINS = { useradd: true, usermod: true, userdel: true, chpasswd: true, setquota: true, repquota: true, quotacheck: true, rsync: true, exim4: true, systemctl: true };
const LOG_A = 'alice.com-access.log';
const LOG_B = 'alice.com-error.log.1';
const LOG_BYTES = Buffer.from('GET / 200\n'.repeat(400));
const file = (name, size = 10) => ({ name, type: 'file', size, mtime: '2026-10-01T00:00:00.000Z', mode: '640' });
// /var/log/nginx holds the distribution logs shared by every site plus
// per-domain files; the names are chosen so substring matching would leak.
const NGINX_FILES = ['access.log', 'access.log.1', 'error.log', 'alice.com-access.log', 'alice.com.error.log.1', 'myalice.com-access.log', 'myalice.com-error.log'].map((n) => file(n));
const notFound = (path) => Object.assign(new Error(`ENOENT: ${path}`), { agentError: true, code: 'op_failed' });
// What the agent's symlink-safe listing answers per directory (acct.list_logs
// only ever returns regular files, so the "notes.txt"/"sub" entries of a real
// domlogs tree never reach the panel).
const LOG_DIRS = {
  '/var/log/whm/domlogs/alice': [{ name: LOG_A, size: LOG_BYTES.length, mtime: '2026-10-01T00:00:00.000Z', uid: 0 }, { name: LOG_B, size: 10, mtime: '2026-09-01T00:00:00.000Z', uid: 0 }, { name: 'notes.txt', size: 1, mtime: null, uid: 0 }],
  '/home/alice/logs': [{ name: 'php-error.log', size: 5, mtime: '2026-10-02T00:00:00.000Z', uid: 30001 }],
  '/var/log/nginx': NGINX_FILES.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime, uid: 0 })),
};
const LIST_LOGS = ({ path }) => { if (LOG_DIRS[path]) return { path, entries: LOG_DIRS[path], skipped: [] }; throw notFound(path); };
const FS_LIST = ({ path }) => { if (path === '/home2/alice') return { path, entries: [] }; throw notFound(path); };

function hostAgent() {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n])])),
    'sys.disk.usage': () => [{ filesystem: '/dev/sda1', sizeBytes: 1e11, usedBytes: 2e10, availableBytes: 8e10, usedPercent: 20, mountpoint: '/' }, { filesystem: '/dev/sdb1', sizeBytes: 5e11, usedBytes: 1e10, availableBytes: 4.9e11, usedPercent: 2, mountpoint: '/home2' }],
    'user.set_shell': ({ username, shell }) => ({ username, shell }),
    'user.set_quota': (args) => args,
    'user.quota_report': ({ filesystem }) => ({ available: true, users: [{ username: 'alice', usedMb: 120, softMb: 10240, hardMb: 10752 }], filesystem }),
    'fs.list': FS_LIST,
    'acct.list_logs': LIST_LOGS,
    'acct.archive_logs': ({ archiveDir, label }) => ({ dest: `${archiveDir}/${label}`, pruned: ['2020-01'] }),
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

describe('log file matching', () => {
  it('claims only files named after the whole domain, never substrings or the shared logs', () => {
    const alice = domainLogFile('alice.com');
    expect(NGINX_FILES.map((f) => f.name).filter((n) => alice.test(n))).toEqual(['alice.com-access.log', 'alice.com.error.log.1']);
    expect(NGINX_FILES.map((f) => f.name).filter((n) => domainLogFile('le.com').test(n))).toEqual([]);
    expect(NGINX_FILES.map((f) => f.name).filter((n) => domainLogFile('access.log').test(n))).toEqual([]);
    expect(domainLogFile('a.b').test('a.b-access_log')).toBe(true);
    expect(domainLogFile('a.b').test('axb-access_log')).toBe(false);
  });
});

describe('template rendering', () => {
  it('substitutes and escapes variables and leaves unknown ones empty', () => {
    expect(renderTemplateBody('<h1>{{domain}}</h1>{{ missing }}', { domain: '<x>&y' })).toBe('<h1>&lt;x&gt;&amp;y</h1>');
    for (const body of Object.values(DEFAULT_TEMPLATES)) expect(renderTemplateBody(body, { domain: 'a.com', hostname: 'h', contact_email: 'r@h', status: '404', status_text: 'Not Found' })).not.toMatch(/\{\{/);
  });
  it('leaves values untouched for plain-text mail', () => {
    expect(renderTemplateBody("Hi {{username}} <{{email}}> & co", { username: "o'neil", email: 'a@b' }, { escape: false })).toBe("Hi o'neil <a@b> & co");
    expect(renderTemplateBody('{{x}}', { x: '<b>' })).toBe('&lt;b&gt;');
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
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com', provision: { dns: true } }).expect(201);
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
      // WHM parity: the zone and the local mail routing are created unless the caller opts out.
      expect(p.systemUser).toBe(true);
      expect(p.web).toBe('skipped');
      expect(['pending', 'applied']).toContain(p.dns);
      // Exim exists on this mock host but does not read the panel's domain lists: a soft failure, recorded and not fatal.
      expect(p.mail).toBe('failed');
      expect(p.steps.mail.detail).toMatch(/domain lists|Exim/);
      expect(p.database).toBe('pending');
      expect(p.steps.dns.detail).toMatch(/BIND|zone/);
      expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM dns_zones WHERE domain = ?').get('dave.com').n).toBe(1);
      expect(app.ctx.mail.routingLists().local).toContain('dave.com');
      const index = app.agent.callsTo('fs.write_file').find((c) => c.args.path === '/home/dave/public_html/index.html');
      expect(index.args.content).toContain('<h1>Ready to launch</h1>');
      expect(index.args.content).toContain('<p class="domain">dave.com</p>');
      expect(index.args.content).toContain('Hostingsignal Panel');
      expect(index.args.content).not.toContain('{{');
    });

    it('rolls the account back when a provisioning step fails hard', async () => {
      const dns = app.ctx.dns;
      app.ctx.dns = { ...dns, ensureZoneForDomain: async () => { throw Object.assign(new Error('named exploded'), { agentError: true, code: 'command_failed' }); }, removeZonesForAccount: dns.removeZonesForAccount };
      try {
        const res = await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'erin', domain: 'erin.com', provision: { dns: true } });
        expect(res.status).toBe(500);
        expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE username = ?').get('erin').n).toBe(0);
        expect(app.agent.callsTo('user.delete')).toHaveLength(1);
        const plain = await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'erin', domain: 'erin.com', provision: { dns: false, mail: false } }).expect(201);
        expect(plain.body.data.provisioning.steps.dns).toEqual({ status: 'skipped', detail: 'not requested' });
        expect(plain.body.data.provisioning.steps.mail).toEqual({ status: 'skipped', detail: 'not requested' });
        await app.http.delete('/api/accounts/erin').set('X-CSRF-Token', csrf).expect(200);
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
        // The domain leaves Exim's local list and the routing row goes with the account.
        expect(app.ctx.mail.routingLists().local).not.toContain('dave.com');
        expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM mail_domains WHERE domain = ?').get('dave.com').n).toBe(0);
        const listWrites = app.agent.callsTo('mail.config.include.write').map((c) => c.args.content);
        expect(listWrites.length).toBeGreaterThan(0);
        expect(listWrites.at(-2)).not.toMatch(/dave\.com/);
        const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.terminate' ORDER BY id DESC LIMIT 1").get();
        const cleanup = JSON.parse(audit.args_redacted).cleanup;
        expect(cleanup.web.removed).toEqual(['dave.com']);
        expect(cleanup.mail.routing).toEqual([{ domain: 'dave.com', applied: false, detail: expect.stringMatching(/domain lists|Exim/) }]);
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

    it('lets a reseller move an owned account only to the shared or a delegated address', async () => {
      const ip = app.ctx.ip;
      delete app.ctx.ip;
      const shared = app.ctx.settings.get('basic.shared_ip');
      app.ctx.settings.set('basic.shared_ip', '203.0.113.5');
      try {
        const refused = await rput('/ip/bob', { ip: '203.0.113.78' });
        expect(refused.status).toBe(403);
        expect(refused.body.error.message).toMatch(/not delegated/);
        expect((await app.http.get('/api/accounts/bob')).body.data.ip).not.toBe('203.0.113.78');
        const ok = await rput('/ip/bob', { ip: '203.0.113.5' }).expect(200);
        expect(ok.body.data).toMatchObject({ username: 'bob', ip: '203.0.113.5' });
        expect((await put('/ip/bob', { ip: '203.0.113.78' })).status).toBe(200);
      } finally { app.ctx.settings.set('basic.shared_ip', shared ?? ''); if (ip) app.ctx.ip = ip; }
    });

    it('rewrites only the address through web.replaceIp and puts the IP pool back when the rewrite fails', async () => {
      const aliceId = app.ctx.db.prepare('SELECT id, ip FROM accounts WHERE username = ?').get('alice');
      const insert = app.ctx.db.prepare("INSERT INTO ip_addresses (address, family, netmask, interface, is_main, reserved, managed) VALUES (?, 4, '255.255.255.0', 'eth0', 0, 0, 1)");
      insert.run('203.0.113.40'); insert.run('203.0.113.41');
      const dedicatedTo = (address) => app.ctx.db.prepare('SELECT dedicated_to FROM ip_addresses WHERE address = ?').get(address).dedicated_to;
      const calls = [];
      app.ctx.web = { replaceIp: async (from, to, { accounts }) => { calls.push([from, to, accounts]); return { updated: 1, domains: ['alice.com'] }; }, ensureVhost: async () => { throw new Error('ensureVhost must not be used for an address change'); } };
      try {
        const ok = await put('/ip/alice', { ip: '203.0.113.40' }).expect(200);
        expect(ok.body.data).toMatchObject({ ip: '203.0.113.40', dedicated: '203.0.113.40', web: { applied: true, updated: 1, domains: ['alice.com'] } });
        expect(calls).toEqual([[aliceId.ip, '203.0.113.40', ['alice']]]);
        expect(dedicatedTo('203.0.113.40')).toBe(aliceId.id);
        app.ctx.web.replaceIp = async () => { throw new Error('apache: configuration test failed'); };
        const failed = await put('/ip/alice', { ip: '203.0.113.41' });
        expect(failed.status).toBe(500);
        // The account row and the pool agree again: .40 still dedicated, .41 free.
        expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.40');
        expect(dedicatedTo('203.0.113.40')).toBe(aliceId.id);
        expect(dedicatedTo('203.0.113.41')).toBeNull();
        expect(app.ctx.ip.freeAddresses(4).map((r) => r.address)).toContain('203.0.113.41');
      } finally {
        delete app.ctx.web;
        app.ctx.db.prepare("UPDATE accounts SET ip = ? WHERE id = ?").run(aliceId.ip, aliceId.id);
        app.ctx.db.prepare("DELETE FROM ip_addresses WHERE address IN ('203.0.113.40', '203.0.113.41')").run();
      }
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
      await put('/bandwidth/carol', { limitMb: 10 }).expect(200);
      app.ctx.db.prepare('UPDATE accounts SET bandwidth_used_mb = 50 WHERE username = ?').run('carol');
      const ex = await get('/bandwidth/exceeders').expect(200);
      expect(ex.body.data.map((a) => a.username)).toEqual(['alice', 'carol']);
      expect(ex.body.data[0]).toMatchObject({ over_bandwidth: true, bandwidth_percent: 150, suspended_for_bandwidth: false });

      await put('/bandwidth-enforcement', { enabled: true }).expect(200);
      expect(app.ctx.scheduler.list().find((s) => s.name === 'account-bandwidth-enforce').enabled).toBe(1);
      const job = app.ctx.jobs.enqueue('accounts.bandwidth_enforce', {});
      const done = await waitForJob(app.ctx, job.id);
      expect(done.status).toBe('done');
      expect(done.result.suspended).toEqual(['alice', 'carol']);
      expect((await app.http.get('/api/accounts/alice')).body.data).toMatchObject({ suspended: true, suspend_reason: expect.stringMatching(/^bandwidth/) });
      // A scheduler-driven suspension carries no request but is still audited, per account and as a job summary.
      const auto = app.ctx.db.prepare("SELECT principal, target, args_redacted FROM audit_log WHERE action = 'account.suspend' AND target IN ('alice', 'carol') ORDER BY id DESC LIMIT 2").all();
      expect(auto.map((r) => r.target).sort()).toEqual(['alice', 'carol']);
      for (const row of auto) { expect(row.principal).toBeNull(); expect(JSON.parse(row.args_redacted)).toMatchObject({ reason: expect.stringMatching(/^bandwidth/), by: 'scheduler', web: { applied: false, reason: 'web_category_missing' } }); }
      expect(JSON.parse(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.bandwidth.enforce' ORDER BY id DESC LIMIT 1").get().args_redacted)).toMatchObject({ suspended: ['alice', 'carol'], job: job.id });

      // A named selection without an explicit "all" touches only those accounts.
      const un = await post('/bandwidth/unsuspend-exceeders', { usernames: ['alice'], resetCounters: true }).expect(200);
      expect(un.body.data).toMatchObject({ unsuspended: ['alice'], failed: [], skipped: 1 });
      expect((await app.http.get('/api/accounts/alice')).body.data).toMatchObject({ suspended: false, bandwidth_used_mb: 0 });
      expect((await app.http.get('/api/accounts/carol')).body.data).toMatchObject({ suspended: true, bandwidth_used_mb: 50 });
      expect((await post('/bandwidth/unsuspend-exceeders', {})).status).toBe(422);
      expect((await post('/bandwidth/unsuspend-exceeders', { usernames: [] })).status).toBe(422);
      expect((await app.http.get('/api/accounts/carol')).body.data.suspended).toBe(true);
      const rest = await post('/bandwidth/unsuspend-exceeders', { all: true }).expect(200);
      expect(rest.body.data.unsuspended).toEqual(['carol']);
      await put('/bandwidth/carol', { limitMb: null }).expect(200);

      app.ctx.db.prepare('UPDATE accounts SET bandwidth_used_mb = 42 WHERE username = ?').run('carol');
      // The current period's totals are Account Information's: cleared through its resetPeriod hook, never by touching its table.
      const periods = [];
      const info = app.ctx.accountInfo;
      const hadHook = Object.prototype.hasOwnProperty.call(info, 'resetPeriod');
      const savedHook = info.resetPeriod;
      info.resetPeriod = (usernames) => periods.push(usernames);
      try {
        const reset = await post('/bandwidth/reset', { usernames: ['carol'] }).expect(200);
        expect(reset.body.data.reset).toEqual(['carol']);
        expect(periods).toEqual([['carol']]);
      } finally { if (hadHook) info.resetPeriod = savedHook; else delete info.resetPeriod; }
      expect((await app.http.get('/api/accounts/carol')).body.data.bandwidth_used_mb).toBe(0);
      const off = await put('/bandwidth-enforcement', { enabled: false, reason: 'over quota' }).expect(200);
      expect(off.body.data).toMatchObject({ enabled: false, reason: 'bandwidth: over quota' });
      expect(app.ctx.scheduler.list().find((s) => s.name === 'account-bandwidth-enforce').enabled).toBe(0);
      // The setting is the source of truth: a schedule row edited elsewhere is realigned to it.
      app.ctx.scheduler.update('account-bandwidth-enforce', { enabled: true });
      expect(app.ctx.accountFunctions.syncEnforcementSchedule()).toBe(false);
      expect(app.ctx.scheduler.list().find((s) => s.name === 'account-bandwidth-enforce').enabled).toBe(0);
      expect(JSON.parse(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.bandwidth.enforcement' ORDER BY id DESC LIMIT 1").get().args_redacted)).toEqual({ enabled: false, reason: 'over quota' });

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
      expect(list.body.data.warnings).toEqual([]);
      // The server-wide domlogs tree is root's; only the directory inside the home is pinned to the account.
      expect(app.agent.callsTo('acct.list_logs').map((c) => c.args)).toEqual([{ path: '/var/log/whm/domlogs/alice', limit: 5000 }, { path: '/home/alice/logs', limit: 5000, owner: 'alice' }]);
      const dl = await get(`/logs/apache/alice/download?file=${LOG_A}`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
      expect(dl.status).toBe(200);
      expect(dl.headers['content-disposition']).toBe(`attachment; filename="alice-${LOG_A}"`);
      expect(dl.headers['content-length']).toBe(String(LOG_BYTES.length));
      expect(Buffer.compare(dl.body, LOG_BYTES)).toBe(0);
      expect(app.agent.callsTo('acct.read_range').length).toBeGreaterThanOrEqual(1);
      expect(app.agent.callsTo('acct.read_range')[0].args).toEqual({ path: `/var/log/whm/domlogs/alice/${LOG_A}`, offset: 0, length: 1024 * 1024 });
      await get('/logs/apache/alice/download?file=php-error.log').expect(200);
      expect(app.agent.callsTo('acct.read_range').at(-1).args).toMatchObject({ path: '/home/alice/logs/php-error.log', owner: 'alice' });
      expect((await get('/logs/apache/alice/download?file=notes.txt')).status).toBe(404);
      expect((await get('/logs/apache/alice/download?file=../passwd')).status).toBe(422);
      expect((await rget(`/logs/apache/alice/download?file=${LOG_A}`)).status).toBe(403);
      expect((await get('/logs/iis/alice')).status).toBe(422);
    });

    it('cuts the connection instead of hanging when a later range fails or the file shrinks', async () => {
      // 1000-byte answers force several ranges for the 4000-byte log.
      const ranged = (sizeAfterFirst) => ({ path, offset, length }) => {
        if (offset > 0 && sizeAfterFirst === 'error') throw Object.assign(new Error('agent socket closed'), { agentError: true, code: 'agent_unavailable' });
        const size = offset > 0 && sizeAfterFirst != null ? sizeAfterFirst : LOG_BYTES.length;
        const slice = LOG_BYTES.subarray(offset, Math.min(offset + length, offset + 1000, size));
        return { path, size, offset, length: slice.length, data: slice.toString('base64'), eof: offset + slice.length >= size };
      };
      const download = () => get(`/logs/apache/alice/download?file=${LOG_A}`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
      const aborted = async () => { try { const res = await download(); return res.status === 200 && res.body.length === LOG_BYTES.length ? null : new Error(`short body ${res.body.length}`); } catch (err) { return err; } };
      try {
        app.agent.set('acct.read_range', ranged(null));
        expect(await aborted()).toBeNull();
        expect(app.agent.callsTo('acct.read_range').length).toBe(4);
        app.agent.set('acct.read_range', ranged('error'));
        expect(await aborted()).toBeInstanceOf(Error);
        app.agent.set('acct.read_range', ranged(1500));
        expect(await aborted()).toBeInstanceOf(Error);
        const audits = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.log.download.aborted' AND target = 'alice' ORDER BY id DESC LIMIT 2").all().map((r) => JSON.parse(r.args_redacted));
        expect(audits).toHaveLength(2);
        expect(audits.map((a) => a.error).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/agent socket closed/), expect.stringMatching(/changed size|shrank/)]));
      } finally {
        app.agent.set('acct.read_range', ({ path, offset, length }) => { const slice = LOG_BYTES.subarray(offset, offset + length); return { path, size: LOG_BYTES.length, offset, length: slice.length, data: slice.toString('base64'), eof: offset + slice.length >= LOG_BYTES.length }; });
      }
    });

    it('reports a home log directory the agent refused (symlink or foreign owner) instead of serving it', async () => {
      app.agent.set('acct.list_logs', ({ path, owner }) => {
        if (path === '/home/alice/logs') throw Object.assign(new Error(`${path} goes through a symbolic link (/var/log/whm/domlogs/bob); refusing to follow it`), { agentError: true, code: 'refused', details: { owner } });
        return LIST_LOGS({ path });
      });
      try {
        const list = await get('/logs/apache/alice').expect(200);
        expect(list.body.data.files.map((f) => f.name)).toEqual([LOG_A, LOG_B]);
        expect(list.body.data.warnings).toEqual([expect.stringMatching(/^\/home\/alice\/logs was skipped: .*symbolic link/)]);
        expect((await get('/logs/apache/alice/download?file=php-error.log')).status).toBe(404);
      } finally { app.agent.set('acct.list_logs', LIST_LOGS); }
    });

    it('shows each account only the NGINX files named after its own domains', async () => {
      await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'malice', domain: 'myalice.com', owner: 'resell1', provision: { dns: false, mail: false } }).expect(201);
      app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n]) || n === 'nginx'])));
      await app.ctx.capabilities.refresh();
      try {
        const alice = await get('/logs/nginx/alice').expect(200);
        expect(alice.body.data.files.map((f) => f.name)).toEqual(['alice.com-access.log', 'alice.com.error.log.1']);
        const malice = await rget('/logs/nginx/malice').expect(200);
        expect(malice.body.data.files.map((f) => f.name)).toEqual(['myalice.com-access.log', 'myalice.com-error.log']);
        expect((await rget('/logs/nginx/malice/download?file=alice.com-access.log')).status).toBe(404);
        expect((await rget('/logs/nginx/malice/download?file=access.log')).status).toBe(404);
        expect((await rget('/logs/nginx/alice')).status).toBe(403);
      } finally {
        app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n])])));
        await app.ctx.capabilities.refresh();
        await app.http.delete('/api/accounts/malice').set('X-CSRF-Token', csrf).expect(200);
      }
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
      await put('/quota/alice', { diskQuotaMb: 1024 }).expect(200);
      app.agent.calls.length = 0;
      const start = await post('/rearrange/alice', { target: '/home2' }).expect(202);
      expect(start.body.data).toMatchObject({ from: '/home/alice', to: '/home2/alice', bytes: 4096 });
      const job = await waitForJob(app.ctx, start.body.data.job.id);
      expect(job.status, job.error).toBe('done');
      expect(app.agent.callsTo('fs.copy_tree').map((c) => c.args)).toEqual([{ from: '/home/alice', to: '/home2/alice' }, { from: '/home/alice', to: '/home2/alice', deleteExtraneous: true }]);
      expect(app.agent.callsTo('acct.set_home')).toEqual([{ name: 'acct.set_home', args: { username: 'alice', homeDir: '/home2/alice' } }]);
      // /home2 is its own filesystem: the quota is cleared on the old one and set again on the new one.
      expect(app.agent.callsTo('user.set_quota').map((c) => c.args)).toEqual([{ username: 'alice', softMb: 0, hardMb: 0, filesystem: '/' }, { username: 'alice', softMb: 1024, hardMb: 1075, filesystem: '/home2' }]);
      expect(job.result.quota).toEqual({ applied: true, filesystem: '/home2', mb: 1024 });
      expect(app.agent.callsTo('fs.remove')).toEqual([{ name: 'fs.remove', args: { path: '/home/alice', recursive: true } }]);
      // The Linux user is locked before the first copy and unlocked after the old tree is gone.
      const order = app.agent.calls.map((c) => c.name);
      expect(order.indexOf('user.lock')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('user.lock')).toBeLessThan(order.indexOf('fs.copy_tree'));
      expect(order.lastIndexOf('user.unlock')).toBeGreaterThan(order.indexOf('fs.remove'));
      expect(job.result).toMatchObject({ oldTreeRemoved: true, oldHome: null, suspendedDuringMove: true });
      expect(JSON.parse(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.suspend' AND target = 'alice' ORDER BY id DESC LIMIT 1").get().args_redacted).reason).toMatch(/^rearrange/);
      const account = (await app.http.get('/api/accounts/alice')).body.data;
      expect(account).toMatchObject({ home_dir: '/home2/alice', suspended: false });
      expect(account.domains[0].docroot).toBe('/home2/alice/public_html');
      // The quota report looks the moved account up on /home2, with one disk listing for the whole report.
      app.agent.calls.length = 0;
      const report = await get('/quota/report').expect(200);
      expect(report.body.data.find((a) => a.username === 'alice')).toMatchObject({ filesystem: '/home2', live: { usedMb: 120 } });
      expect(report.body.data.find((a) => a.username === 'carol').filesystem).toBe('/');
      expect(app.agent.callsTo('sys.disk.usage')).toHaveLength(1);
      // Modify an Account and Quota Modification now agree on the filesystem of the moved home.
      await app.http.patch('/api/accounts/alice').set('X-CSRF-Token', csrf).send({ diskQuotaMb: 3000 }).expect(200);
      expect(app.agent.callsTo('user.set_quota').at(-1).args).toEqual({ username: 'alice', softMb: 3000, hardMb: 3150, filesystem: '/home2' });
      expect((await put('/quota/alice', { diskQuotaMb: 3000 }).expect(200)).body.data.filesystem).toBe('/home2');
      expect((await post('/rearrange/alice', { target: '/home2' })).status).toBe(409);
      expect((await post('/rearrange/alice', { target: '/opt' })).status).toBe(422);
      expect((await rpost('/rearrange/bob', { target: '/home2' })).status).toBe(403);
    });

    it('keeps the old home when the vhost rewrite fails and suspends the account only for the move', async () => {
      app.ctx.web = { ensureVhost: async () => { throw new Error('apache: configuration test failed'); } };
      try {
        app.agent.calls.length = 0;
        const start = await post('/rearrange/bob', { target: '/home2' }).expect(202);
        const job = await waitForJob(app.ctx, start.body.data.job.id);
        expect(job.status, job.error).toBe('done');
        expect(job.result).toMatchObject({ oldTreeRemoved: false, oldHome: '/home/bob', web: { applied: false, reason: 'apache: configuration test failed' } });
        expect(app.agent.callsTo('fs.remove')).toEqual([]);
        expect(app.agent.callsTo('acct.set_home').map((c) => c.args)).toEqual([{ username: 'bob', homeDir: '/home2/bob' }]);
        expect(app.agent.callsTo('user.lock').map((c) => c.args)).toEqual([{ username: 'bob' }]);
        expect(app.agent.callsTo('user.unlock').map((c) => c.args)).toEqual([{ username: 'bob' }]);
        expect(job.logs.some((l) => /NOT removed/.test(l.line) && l.level === 'error')).toBe(true);
        expect((await app.http.get('/api/accounts/bob')).body.data).toMatchObject({ home_dir: '/home2/bob', suspended: false });
      } finally { delete app.ctx.web; }
    });

    it('restores the previous home and removes the partial copy when usermod fails', async () => {
      app.agent.fail('acct.set_home', 'command_failed', 'usermod: user carol is currently used by process 4242');
      try {
        app.agent.calls.length = 0;
        const start = await post('/rearrange/carol', { target: '/home2' }).expect(202);
        const job = await waitForJob(app.ctx, start.body.data.job.id);
        expect(job.status).toBe('failed');
        expect(job.error).toMatch(/usermod/);
        expect(app.agent.callsTo('fs.remove').map((c) => c.args)).toEqual([{ path: '/home2/carol', recursive: true }]);
        const order = app.agent.calls.map((c) => c.name);
        expect(order.indexOf('user.lock')).toBeLessThan(order.indexOf('fs.copy_tree'));
        expect(order.lastIndexOf('user.unlock')).toBeGreaterThan(order.indexOf('fs.remove'));
        expect((await app.http.get('/api/accounts/carol')).body.data).toMatchObject({ home_dir: '/home/carol', suspended: false });
        expect(app.ctx.db.prepare("SELECT docroot FROM account_domains WHERE domain = 'carol.com'").get().docroot).toBe('/home/carol/public_html');
        expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'account.rearrange.failed' AND target = 'carol'").get().n).toBe(1);
      } finally { app.agent.set('acct.set_home', ({ username, homeDir }) => ({ username, home: homeDir, uid: 30001, previousHome: '/home/carol' })); }
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
      const run = await post('/log-retention/archive', { username: 'alice' }).expect(202);
      const job = await waitForJob(app.ctx, run.body.data.job.id);
      expect(job.status, job.error).toBe('done');
      expect(job.result.archived).toEqual(['alice']);
      expect(job.result.pruned).toEqual(['alice/2020-01']);
      // The copy and the pruning are one agent op that runs as the account; root never writes into the home itself.
      expect(app.agent.callsTo('acct.archive_logs').map((c) => c.args)).toEqual([{ username: 'alice', source: '/var/log/whm/domlogs/alice', archiveDir: '/home2/alice/logs/archive', label: expect.stringMatching(/^\d{4}-\d{2}$/), retainMonths: 2 }]);
      expect(app.agent.callsTo('fs.mkdir')).toEqual([]);
      expect(app.agent.callsTo('fs.copy_tree')).toEqual([]);
      expect(app.agent.callsTo('fs.remove')).toEqual([]);
      expect((await get('/log-retention/alice')).body.data.last_archived_at).toBeTruthy();
      expect((await put('/log-retention/alice', { retainMonths: 0 })).status).toBe(422);
      expect((await rput('/log-retention/alice', { archiveLogs: true })).status).toBe(403);
      expect((await rput('/log-retention/bob', { archiveLogs: true })).status).toBe(200);
      // Archiving every account is server-wide work: resellers must name one of their own.
      expect((await rpost('/log-retention/archive', {})).status).toBe(403);
      expect((await rpost('/log-retention/archive', { username: 'alice' })).status).toBe(403);
      const own = await rpost('/log-retention/archive', { username: 'bob' }).expect(202);
      const ownJob = await waitForJob(app.ctx, own.body.data.job.id);
      expect(ownJob.status, ownJob.error).toBe('done');
      expect(ownJob.result.archived).toEqual([]);
    });
  });

  describe('branded default pages', () => {
    it('renders the index and landing pages with the company branding, the panel URL and an absolute logo', async () => {
      const svc = app.ctx.accountFunctions;
      // The seeded admin-side name (migration 028) is not what visitors see; only an operator's own name is.
      app.ctx.settings.set('basic.hostname', 'panel.example.com');
      expect(app.ctx.settings.get('branding.company_name')).toBe('WHM');
      expect(svc.brandingVars()).toEqual({ company_name: 'Hostingsignal Panel', tagline: '', logo_url: '', panel_url: 'http://panel.example.com:2086' });
      app.ctx.settings.setMany({ 'branding.company_name': '', 'branding.tagline': '' });
      expect(svc.brandingVars()).toEqual({ company_name: 'Hostingsignal Panel', tagline: '', logo_url: '', panel_url: 'http://panel.example.com:2086' });
      // The row migration 012 seeded for "index" is the stock page: the branded default replaces it and it is not "customised".
      expect(app.ctx.db.prepare("SELECT body FROM web_templates WHERE name = 'index'").get().body).toMatch(/no content yet/);
      expect(isStockTemplate('index', app.ctx.db.prepare("SELECT body FROM web_templates WHERE name = 'index'").get().body)).toBe(true);
      expect(isStockTemplate('index', '<html><body>mine</body></html>')).toBe(false);
      expect(isStockTemplate('landing', null)).toBe(true);
      expect((await get('/templates')).body.data.templates.find((t) => t.name === 'index').customised).toBe(false);
      expect((await get('/templates/index')).body.data.body).toBe(DEFAULT_TEMPLATES.index);
      const landing = svc.renderTemplate('landing', { domain: 'panel.example.com' });
      expect(landing).toContain('<h1>Ready to launch</h1>');
      expect(landing).toContain('<span>Hostingsignal Panel</span>');
      expect(landing).toContain('<p class="domain">panel.example.com</p>');
      expect(landing).toContain('<code>public_html</code>');
      expect(landing).toContain('href="http://panel.example.com:2086"');
      expect(landing).toContain('<img src="" alt="">');
      expect(landing).toContain('Hosted on panel.example.com with Hostingsignal Panel. </footer>');
      expect(landing).not.toMatch(/\{\{/);
      app.ctx.settings.setMany({ 'branding.company_name': 'Acme & Sons', 'branding.tagline': 'Hosting <fast>' });
      const index = svc.renderTemplate('index', { domain: 'alice.com', username: 'alice' });
      expect(index).toContain('<title>alice.com — Ready to launch</title>');
      expect(index).toContain('<span>Acme &amp; Sons</span>');
      expect(index).toContain('Hosting &lt;fast&gt;');
      expect(index).toContain('Upload your website to <code>public_html</code>');
      expect(index).not.toContain('Hostingsignal Panel');
      // The logo descriptor from cPanel › Customization becomes an absolute panel URL (the page is served by Apache, not the panel).
      const originalCpanel = app.ctx.cpanel;
      app.ctx.cpanel = { ...originalCpanel, branding: { get: () => ({ companyName: 'Acme & Sons', tagline: 'From branding', logo: { url: '/api/branding/logo?v=abc123' } }) } };
      try {
        expect(svc.brandingVars()).toEqual({ company_name: 'Acme & Sons', tagline: 'From branding', logo_url: 'http://panel.example.com:2086/api/branding/logo?v=abc123', panel_url: 'http://panel.example.com:2086' });
        expect(svc.renderTemplate('landing', { domain: 'panel.example.com' })).toContain('<img src="http://panel.example.com:2086/api/branding/logo?v=abc123" alt="">');
      } finally { app.ctx.cpanel = originalCpanel; }
      const preview = await post('/templates/landing/preview', {}).expect(200);
      expect(preview.body.data.html).toContain('<p class="domain">panel.example.com</p>');
      expect(preview.body.data.html).toContain('Acme &amp; Sons');
      app.ctx.settings.setMany({ 'branding.company_name': 'WHM', 'branding.tagline': 'WebHost Manager' });
    });
  });

  describe('web template editor', () => {
    it('lists, previews, saves to /etc/whm/templates and resets templates (root only)', async () => {
      const list = await get('/templates').expect(200);
      expect(list.body.data.templates.map((t) => t.name)).toEqual(['index', 'landing', 'suspended', 'moved', 'error-4xx']);
      expect(list.body.data.templates.map((t) => t.served)).toEqual([true, true, false, false, false]);
      expect(list.body.data.templates[1].served_by).toMatch(/whm-default/);
      expect(list.body.data.templates[2].served_by).toMatch(/not yet served/);
      expect(list.body.data.variables).toEqual(expect.arrayContaining(['company_name', 'tagline', 'logo_url', 'panel_url']));
      expect(app.ctx.accountFunctions.templatePath('error-4xx')).toBe('/etc/whm/templates/error-4xx.html');
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

    it('saving or resetting the landing template re-renders the hostname page at once', async () => {
      // The real Service Configuration service (no Apache on this host, so the vhost stays pending but the page is written).
      app.ctx.web = savedWeb;
      app.ctx.settings.set('basic.hostname', 'panel.example.com');
      const landingPage = () => app.agent.callsTo('fs.write_file').filter((c) => c.args.path === '/var/www/whm-default/index.html');
      const custom = '<!doctype html><html><body><h1>Welcome to {{hostname}}</h1><p>custom landing</p></body></html>';
      try {
        app.agent.calls.length = 0;
        const saved = await put('/templates/landing', { body: custom }).expect(200);
        expect(saved.body.data).toMatchObject({ name: 'landing', written: true, rendered: { hostname: 'panel.example.com', landingPage: true, applied: false, reason: 'capability_missing' } });
        expect(landingPage()).toHaveLength(1);
        expect(landingPage()[0].args).toMatchObject({ owner: 'root', mode: '0644' });
        expect(landingPage()[0].args.content).toContain('<h1>Welcome to panel.example.com</h1><p>custom landing</p>');
        app.agent.calls.length = 0;
        const reset = await post('/templates/landing/reset').expect(200);
        expect(reset.body.data.rendered).toMatchObject({ hostname: 'panel.example.com', landingPage: true });
        expect(landingPage()[0].args.content).toContain('Ready to launch');
        expect(landingPage()[0].args.content).not.toContain('custom landing');
        // Other templates never touch the hostname page.
        app.agent.calls.length = 0;
        const moved = await put('/templates/moved', { body: custom }).expect(200);
        expect(moved.body.data).not.toHaveProperty('rendered');
        expect(app.agent.callsTo('fs.write_file').map((c) => c.args.path)).toEqual(['/etc/whm/templates/moved.html']);
        await post('/templates/moved/reset').expect(200);
        // Without Service Configuration the save still succeeds and says nothing about the page.
        delete app.ctx.web;
        expect((await put('/templates/landing', { body: custom }).expect(200)).body.data).not.toHaveProperty('rendered');
        await post('/templates/landing/reset').expect(200);
      } finally {
        delete app.ctx.web;
        app.ctx.db.prepare("DELETE FROM web_vhosts WHERE type = 'server'").run();
      }
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
      // A reseller cannot put another sender on the envelope; its own contact address is fine.
      const spoof = await rpost('/email', { subject: 'Reseller note', text: 'hi', from: 'billing@hosting-provider.example' });
      expect(spoof.status).toBe(403);
      expect(spoof.body.error.message).toMatch(/own contact address/);
      app.ctx.db.prepare('UPDATE users SET email = ? WHERE username = ?').run('Resell1@Example.com', 'resell1');
      expect((await rpost('/email', { subject: 'Reseller note', text: 'hi', from: 'resell1@example.com' })).status).toBe(202);
      expect((await post('/email', { subject: 'Root note', text: 'hi', from: 'billing@hosting-provider.example' })).status).toBe(202);

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
  describe('reseller ACLs and limits', () => {
    const root = { id: 1, username: 'root', role: 'root' };
    const grant = (acls) => app.ctx.resellers.setPrivileges('resell1', { acls }, root, null);
    afterAll(() => grant(['all']));

    it('refuses account-scoped changes the reseller was not delegated', async () => {
      grant(['limit-bandwidth']);
      const noEdit = await rput('/ip/bob', { ip: '203.0.113.5' });
      expect(noEdit.status).toBe(403);
      expect(noEdit.body.error.message).toMatch(/Modify Accounts/);
      grant(['edit-account', 'suspend-acct']);
      const before = (await app.http.get('/api/accounts/bob')).body.data;
      for (const [res, acl] of [
        [await rput('/bandwidth/bob', { limitMb: 5 }), 'Limit Bandwidth'],
        [await rpost('/bandwidth/reset', { usernames: ['bob'] }), 'Limit Bandwidth'],
        [await rpost('/bandwidth/unsuspend-exceeders', { all: true }), 'Limit Bandwidth'],
        [await rput('/quota/bob', { diskQuotaMb: 100 }), 'Disk Quotas'],
        [await rpost('/demo-mode', { usernames: ['bob'], enabled: true }), 'Demo Mode'],
        [await rpost('/force-password-change', { usernames: ['bob'], enabled: true }), 'passwd|Password'],
        [await rput('/shell/bob', { shell: '/bin/bash' }), 'Shell'],
      ]) {
        expect(res.status, res.body.error?.message).toBe(403);
        expect(res.body.error.message).toMatch(new RegExp(acl, 'i'));
      }
      expect((await app.http.get('/api/accounts/bob')).body.data).toMatchObject({ demo_mode: before.demo_mode, force_password_change: before.force_password_change, shell: '/usr/sbin/nologin', bandwidth_limit_mb: before.bandwidth_limit_mb, disk_quota_mb: before.disk_quota_mb });
      expect(app.agent.callsTo('user.set_shell')).toEqual([]);
      expect(app.agent.callsTo('user.set_quota')).toEqual([]);
    });

    it('applies them once delegated, keeps "disallow shell" and binds unlimited values to the reseller limits', async () => {
      grant(['edit-account', 'limit-bandwidth', 'quota', 'demo-setup', 'passwd', 'add-pkg-shell', 'disallow-shell']);
      expect((await rput('/bandwidth/bob', { limitMb: 5 })).status).toBe(200);
      expect((await rput('/quota/bob', { diskQuotaMb: 100 })).status).toBe(200);
      expect((await rpost('/demo-mode', { usernames: ['bob'], enabled: false })).status).toBe(200);
      expect((await rput('/shell/bob', { shell: '/usr/sbin/nologin' })).status).toBe(200);
      const shell = await rput('/shell/bob', { shell: '/bin/bash' });
      expect(shell.status).toBe(403);
      expect(shell.body.error.message).toMatch(/Disallow Shell/);
      // A reseller with a bandwidth/disk limit cannot lift an account to unlimited without the matching ACL.
      app.ctx.resellers.update('resell1', { maxDiskMb: 1000, maxBandwidthMb: 1000 }, root, null);
      for (const res of [await rput('/bandwidth/bob', { limitMb: null }), await rput('/quota/bob', { diskQuotaMb: null }), await rput('/bandwidth/bob', { limitMb: 5000 })]) {
        expect(res.status, res.body.error?.message).toBe(409);
        expect(res.body.error.code).toBe('reseller_limit');
      }
      expect((await rput('/quota/bob', { diskQuotaMb: 500 })).status).toBe(200);
      app.ctx.resellers.update('resell1', { maxDiskMb: null, maxBandwidthMb: null }, root, null);
      expect((await rput('/bandwidth/bob', { limitMb: null })).status).toBe(200);
    });
  });

  describe('suspension', () => {
    it('locks the user, hands the web side to the Service Configuration hook and reports what was applied', async () => {
      const calls = [];
      app.ctx.web = { setSuspended: async (username, suspended) => { calls.push([username, suspended]); return { applied: true }; } };
      try {
        const s = await app.http.post('/api/accounts/carol/suspend').set('X-CSRF-Token', csrf).send({ reason: 'abuse' }).expect(200);
        expect(s.body.data).toMatchObject({ suspended: true, web: { applied: true, reason: null } });
        expect(app.agent.callsTo('user.lock').map((c) => c.args)).toEqual([{ username: 'carol' }]);
        const u = await app.http.post('/api/accounts/carol/unsuspend').set('X-CSRF-Token', csrf).send().expect(200);
        expect(u.body.data).toMatchObject({ suspended: false, web: { applied: true } });
        expect(calls).toEqual([['carol', true], ['carol', false]]);
        expect(JSON.parse(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.suspend' AND target = 'carol' ORDER BY id DESC LIMIT 1").get().args_redacted)).toEqual({ reason: 'abuse', web: { applied: true, reason: null } });
      } finally { delete app.ctx.web; }
      // Without the hook the account is still suspended; the response says the sites were not switched.
      const plain = await app.http.post('/api/accounts/carol/suspend').set('X-CSRF-Token', csrf).send({}).expect(200);
      expect(plain.body.data.web).toEqual({ applied: false, reason: 'web_category_missing' });
      app.ctx.web = { ensureVhost: async () => ({ applied: false }) };
      try {
        const u = await app.http.post('/api/accounts/carol/unsuspend').set('X-CSRF-Token', csrf).send().expect(200);
        expect(u.body.data.web).toEqual({ applied: false, reason: 'web_hook_missing' });
      } finally { delete app.ctx.web; }
    });
  });

  describe('domains of an account (addon / sub / parked)', () => {
    const order = [];
    const calls = { web: [], dns: [], ssl: [], mail: [] };
    const certs = new Map();
    const zones = new Map();
    let savedDns;
    let home;
    let ip;
    let savedSsl;
    let savedMail;
    const zoneContaining = (name) => [...zones.keys()].filter((z) => name === z || name.endsWith(`.${z}`)).sort((a, b) => b.length - a.length)[0] || null;
    const stubs = () => {
      app.ctx.web = {
        isServerName: (d) => ['panel.example.com', 'www.panel.example.com'].includes(d),
        vhosts: { sync: async (username) => { order.push('web'); calls.web.push(['sync', username]); return { username, applied: true, vhosts: [{ domain: 'x', applied: true }], reload: { reloaded: true } }; } },
        removeDomain: async (domain) => { order.push('web'); calls.web.push(['remove', domain]); return { domain, removed: true, recorded: true, applied: true }; },
        vhostFor: (domain) => ({ domain, status: 'applied', error: null, path: `/etc/apache2/sites-available/${domain}.conf` }),
        landingDocroot: '/var/www/whm-default',
      };
      app.ctx.dns = {
        zoneFor: (name) => { const z = zoneContaining(name); return z ? { domain: z } : null; },
        ensureZoneForDomain: async (domain, opts) => { order.push('dns'); calls.dns.push(['ensure', domain, opts]); zones.set(domain, opts.accountId); return { domain, applied: true, created: true, serial: 2026103001 }; },
        upsertRecords: async (zone, name, type, values) => { order.push('dns'); calls.dns.push(['upsert', zone, name, type, values]); return { applied: true }; },
        deleteZone: async (domain) => { order.push('dns'); calls.dns.push(['delete', domain]); zones.delete(domain); return { domain, removed: true }; },
        parkDomain: async (input, user) => {
          order.push('dns'); calls.dns.push(['park', input, user.username]);
          const account = app.ctx.db.prepare('SELECT * FROM accounts WHERE username = ?').get(input.account);
          app.ctx.db.prepare('INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, ?, ?, ?)').run(account.id, input.domain, 'parked', `${account.home_dir}/public_html`);
          zones.set(input.domain, account.id);
          return { domain: input.domain, account: input.account, target: account.domain, docroot: `${account.home_dir}/public_html`, zone: { domain: input.domain, applied: true }, web: true, webDetail: null };
        },
        unparkDomain: async (domain, opts, user) => {
          order.push('dns'); calls.dns.push(['unpark', domain, opts, user.username]);
          app.ctx.db.prepare('DELETE FROM account_domains WHERE domain = ?').run(domain);
          zones.delete(domain);
          return { domain, unparked: true, zoneRemoved: true, web: true, webDetail: null };
        },
      };
      app.ctx.ssl = {
        autossl: { settings: () => ({ provider: 'certbot', renewDays: 30 }) },
        certForDomain: (domain) => certs.get(domain) ?? null,
        issueFor: async (domain, user) => { order.push('ssl'); calls.ssl.push(['issue', domain, user.username]); certs.set(domain, { id: 7, installed: 1, state: 'installed', issuer: 'CN=R3', notAfter: '2027-01-01T00:00:00.000Z', daysRemaining: 400, expired: false, autossl: true, selfSigned: false }); return { cert: { id: 7 }, certificate: { issuerCommonName: 'R3', notAfter: '2027-01-01T00:00:00.000Z' }, web: 'applied', renewed: true }; },
        uninstall: async (domain) => { order.push('ssl'); calls.ssl.push(['uninstall', domain]); certs.delete(domain); return { domain, removed: true, web: 'applied' }; },
      };
      app.ctx.mail = { setRouting: async (domain, routing) => { order.push('mail'); calls.mail.push([domain, routing]); return { applied: true, routing }; } };
    };
    const reset = () => { order.length = 0; for (const k of Object.keys(calls)) calls[k].length = 0; app.agent.calls.length = 0; };
    const dnsResolve = (answers) => app.agent.set('dns.resolve', ({ name }) => { order.push('resolve'); return { name, answers, error: null }; });

    beforeAll(() => {
      savedDns = app.ctx.dns; savedSsl = app.ctx.ssl; savedMail = app.ctx.mail;
      // Rearrange moved alice to /home2 earlier in this file; the home is whatever the account row says.
      home = app.ctx.db.prepare('SELECT home_dir FROM accounts WHERE username = ?').get('alice').home_dir;
      // Change Site IP gave alice an address earlier in this file; the zone and the A record use it.
      ip = app.ctx.db.prepare('SELECT ip FROM accounts WHERE username = ?').get('alice').ip || '203.0.113.10';
      stubs();
      app.ctx.settings.setMany({ 'basic.main_ip': '203.0.113.10', 'basic.hostname': 'panel.example.com' });
      app.agent.set('web.docroot.ensure', ({ username, docroot, index }) => { order.push('docroot'); return { username, docroot, created: true, group: 'www-data', mode: '0750', indexWritten: Boolean(index) }; });
      app.agent.set('web.docroot.remove', ({ username, docroot }) => { order.push('files'); return { username, docroot, removed: true }; });
      dnsResolve(['203.0.113.10']);
      zones.set('alice.com', 1); zones.set('bob.com', 2);
    });
    afterAll(() => { app.ctx.dns = savedDns; app.ctx.ssl = savedSsl; app.ctx.mail = savedMail; delete app.ctx.web; app.ctx.settings.setMany({ 'basic.main_ip': '', 'basic.hostname': '' }); app.agent.reset('dns.resolve'); });
    beforeEach(reset);

    it('adds an addon domain: docroot + index as the account first, then the row, vhost, zone, mail and AutoSSL once the name resolves here', async () => {
      const res = await post('/domains/alice', { domain: 'Blog.Example', type: 'addon' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ domain: 'blog.example', type: 'addon', docroot: `${home}/public_html/blog.example`, username: 'alice', parent: null });
      expect(res.body.data.steps).toMatchObject({ docroot: { status: 'applied', created: true, indexWritten: true }, web: { status: 'applied' }, dns: { status: 'applied', zone: 'blog.example', created: true }, mail: { status: 'applied' }, ssl: { status: 'applied', certId: 7 } });
      expect(order).toEqual(['docroot', 'web', 'dns', 'mail', 'resolve', 'ssl']);
      const ensure = app.agent.callsTo('web.docroot.ensure');
      expect(ensure).toHaveLength(1);
      expect(ensure[0].args).toMatchObject({ username: 'alice', docroot: `${home}/public_html/blog.example` });
      expect(ensure[0].args.index).toContain('Ready to launch');
      expect(ensure[0].args.index).toContain('blog.example');
      expect(ensure[0].args.index).toContain('panel.example.com');
      expect(ensure[0].args.group).toBeUndefined();
      expect(calls.web).toEqual([['sync', 'alice']]);
      expect(calls.dns).toEqual([['ensure', 'blog.example', { ip, accountId: expect.any(Number), nameservers: undefined }]]);
      expect(calls.mail).toEqual([['blog.example', 'local']]);
      expect(calls.ssl).toEqual([['issue', 'blog.example', 'root']]);
      expect(app.ctx.db.prepare('SELECT type, docroot FROM account_domains WHERE domain = ?').get('blog.example')).toEqual({ type: 'addon', docroot: `${home}/public_html/blog.example` });
      expect(res.body.data.entry).toMatchObject({ domain: 'blog.example', type: 'addon', ssl: { installed: 1, issuer: 'CN=R3', autossl: true }, zone: true, vhost: { status: 'applied' } });
      const audit = app.ctx.db.prepare("SELECT target, args_redacted FROM audit_log WHERE action = 'account.domain.add' ORDER BY id DESC LIMIT 1").get();
      expect(audit.target).toBe('blog.example');
      expect(JSON.parse(audit.args_redacted)).toMatchObject({ username: 'alice', type: 'addon', steps: { docroot: 'applied', web: 'applied', dns: 'applied', ssl: 'applied' } });
      // Listed with limits and capabilities; resellers cannot read another owner's account.
      const list = await get('/domains/alice').expect(200);
      expect(list.body.data).toMatchObject({ username: 'alice', domain: 'alice.com', home: `${home}`, limits: { addon: { used: 1 }, sub: { used: 0 }, parked: { used: 0 } }, capabilities: { dns: true, ssl: true, autossl: true } });
      expect(list.body.data.domains.map((d) => [d.domain, d.type])).toEqual([['blog.example', 'addon'], ['alice.com', 'main']]);
      expect(list.body.data.domains.find((d) => d.type === 'main').docroot).toBe(`${home}/public_html`);
      expect((await rget('/domains/alice')).status).toBe(403);
    });

    it('a sub domain must sit under one of the account\'s domains; its A record goes into the containing zone and its docroot is the label', async () => {
      const bad = await post('/domains/alice', { domain: 'shop.other.com', type: 'sub' });
      expect(bad.status).toBe(422);
      expect(bad.body.error.fields.domain[0]).toMatch(/subdomain of one of the account/);
      expect(order).toEqual([]);
      const res = await post('/domains/alice', { domain: 'shop.alice.com', type: 'sub' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ type: 'sub', docroot: `${home}/public_html/shop`, parent: 'alice.com', steps: { dns: { status: 'applied', zone: 'alice.com' } } });
      expect(calls.dns).toEqual([['upsert', 'alice.com', 'shop.alice.com', 'A', [{ value: ip }]]]);
      // Under the addon domain too, with a dotted label.
      const deep = await post('/domains/alice', { domain: 'a.b.blog.example', type: 'sub', autossl: false });
      expect(deep.status).toBe(201);
      expect(deep.body.data).toMatchObject({ docroot: `${home}/public_html/a.b`, parent: 'blog.example', steps: { ssl: { status: 'skipped', detail: 'not requested' } } });
      expect(calls.ssl).toEqual([['issue', 'shop.alice.com', 'root']]);
    });

    it('refuses the server hostname, www. names, domains hosted elsewhere, bad document roots and unknown types before touching the host', async () => {
      for (const [body, status, re] of [
        [{ domain: 'panel.example.com', type: 'addon' }, 409, /server hostname/],
        [{ domain: 'www.panel.example.com', type: 'addon' }, 422, /www\./],
        [{ domain: 'www.alice.com', type: 'sub' }, 422, /www\./],
        [{ domain: 'bob.com', type: 'addon' }, 409, /already hosted/],
        [{ domain: 'alice.com', type: 'addon' }, 409, /already hosted/],
        [{ domain: 'x.example', type: 'alias' }, 422, /./],
        [{ domain: 'x.example', type: 'addon', docroot: '/home/bob/public_html/x' }, 422, /inside the account home/],
        [{ domain: 'x.example', type: 'addon', docroot: `${home}/public_html` }, 422, /Reserved|public_html directory/],
        [{ domain: 'x.example', type: 'addon', docroot: `${home}/public_html/x y` }, 422, /./],
        [{ domain: 'x.example', type: 'addon', docroot: `${home}/../bob/x` }, 422, /./],
        [{ domain: 'x.example', type: 'addon', docroot: `${home}/public_html/blog.example` }, 409, /already the document root of blog\.example/],
        [{ domain: 'x.example', type: 'addon', extra: 1 }, 422, /./],
      ]) {
        const res = await post('/domains/alice', body);
        expect(res.status, JSON.stringify(body)).toBe(status);
        expect(res.body.error.message).toMatch(re);
      }
      expect(order).toEqual([]);
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM account_domains WHERE domain = 'x.example'").get().n).toBe(0);
      expect((await post('/domains/nobody', { domain: 'x.example', type: 'addon' })).status).toBe(404);
    });

    it('a refused document root (planted link, reserved directory) stops before anything is recorded', async () => {
      app.agent.fail('web.docroot.ensure', 'refused', `${home}/public_html/evil escapes the home directory through a symbolic link`);
      try {
        const res = await post('/domains/alice', { domain: 'evil.example', type: 'addon' });
        expect(res.status).toBe(422);
        expect(res.body.error.message).toMatch(/symbolic link/);
        expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM account_domains WHERE domain = 'evil.example'").get().n).toBe(0);
        expect(calls.web).toEqual([]);
        expect(calls.dns).toEqual([]);
      } finally { app.agent.set('web.docroot.ensure', ({ username, docroot, index }) => { order.push('docroot'); return { username, docroot, created: true, group: 'www-data', mode: '0750', indexWritten: Boolean(index) }; }); }
    });

    it('AutoSSL is skipped (not failed) while the name resolves elsewhere or AutoSSL is off', async () => {
      dnsResolve(['198.51.100.7']);
      const res = await post('/domains/alice', { domain: 'elsewhere.example', type: 'addon' });
      expect(res.status).toBe(201);
      expect(res.body.data.steps.ssl).toMatchObject({ status: 'skipped', answers: ['198.51.100.7'] });
      expect(res.body.data.steps.ssl.detail).toMatch(/does not resolve to this server yet/);
      expect(calls.ssl).toEqual([]);
      dnsResolve(['203.0.113.10']);
      const settings = app.ctx.ssl.autossl.settings;
      app.ctx.ssl.autossl.settings = () => ({ provider: 'disabled' });
      try {
        const off = await post('/domains/alice', { domain: 'noacme.example', type: 'addon' });
        expect(off.body.data.steps.ssl).toMatchObject({ status: 'skipped' });
        expect(off.body.data.steps.ssl.detail).toMatch(/AutoSSL is disabled/);
      } finally { app.ctx.ssl.autossl.settings = settings; }
      expect(calls.ssl).toEqual([]);
    });

    it('parked domains go through DNS Functions (parkDomain / unparkDomain) and never create a document root', async () => {
      const res = await post('/domains/alice', { domain: 'parked.example', type: 'parked' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ type: 'parked', docroot: `${home}/public_html`, steps: { dns: { status: 'applied' }, web: { status: 'applied' } } });
      expect(calls.dns).toEqual([['park', { domain: 'parked.example', account: 'alice', createZone: true }, 'root']]);
      expect(app.agent.callsTo('web.docroot.ensure')).toEqual([]);
      expect(calls.web).toEqual([]);
      expect(app.ctx.db.prepare('SELECT type FROM account_domains WHERE domain = ?').get('parked.example')).toEqual({ type: 'parked' });
      reset();
      const gone = await app.http.delete('/api/account-functions/domains/alice/parked.example').set('X-CSRF-Token', csrf).expect(200);
      expect(gone.body.data).toMatchObject({ removed: true, type: 'parked', steps: { dns: { status: 'applied' } } });
      expect(calls.dns).toEqual([['unpark', 'parked.example', { removeZone: true }, 'root']]);
      expect(app.ctx.db.prepare('SELECT 1 FROM account_domains WHERE domain = ?').get('parked.example')).toBeUndefined();
    });

    it('removes an addon domain: certificate, vhost, zone, mail routing, the row, then the files as the account only when asked', async () => {
      const kept = await app.http.delete('/api/account-functions/domains/alice/a.b.blog.example').set('X-CSRF-Token', csrf).expect(200);
      expect(kept.body.data).toMatchObject({ removed: true, type: 'sub', steps: { web: { status: 'applied' }, dns: { status: 'applied' }, files: { status: 'skipped' } } });
      expect(calls.dns).toEqual([['upsert', 'blog.example', 'a.b.blog.example', 'A', []]]);
      expect(app.agent.callsTo('web.docroot.remove')).toEqual([]);
      reset();
      const res = await app.http.delete('/api/account-functions/domains/alice/blog.example?deleteFiles=true').set('X-CSRF-Token', csrf).expect(200);
      expect(res.body.data).toMatchObject({ domain: 'blog.example', type: 'addon', removed: true, docroot: `${home}/public_html/blog.example`, steps: { ssl: { status: 'applied' }, web: { status: 'applied' }, dns: { status: 'applied' }, mail: { status: 'applied' }, files: { status: 'applied' } } });
      expect(order).toEqual(['ssl', 'web', 'dns', 'mail', 'files']);
      expect(calls.ssl).toEqual([['uninstall', 'blog.example']]);
      expect(calls.web).toEqual([['remove', 'blog.example']]);
      expect(calls.dns).toEqual([['delete', 'blog.example']]);
      expect(calls.mail).toEqual([['blog.example', 'remote']]);
      expect(app.agent.callsTo('web.docroot.remove').map((c) => c.args)).toEqual([{ username: 'alice', docroot: `${home}/public_html/blog.example` }]);
      expect(app.ctx.db.prepare('SELECT 1 FROM account_domains WHERE domain = ?').get('blog.example')).toBeUndefined();
      expect(JSON.parse(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.domain.remove' AND target = 'blog.example'").get().args_redacted)).toMatchObject({ username: 'alice', deleteFiles: true, steps: { files: 'applied' } });
      // The main domain, a foreign domain and an unknown one are refused.
      expect((await app.http.delete('/api/account-functions/domains/alice/alice.com').set('X-CSRF-Token', csrf)).status).toBe(409);
      expect((await app.http.delete('/api/account-functions/domains/alice/bob.com').set('X-CSRF-Token', csrf)).status).toBe(404);
      expect((await app.http.delete('/api/account-functions/domains/alice/nothing.example').set('X-CSRF-Token', csrf)).status).toBe(404);
    });

    it('resellers manage only their own accounts and stay within the package limits; root does not', async () => {
      expect((await rpost('/domains/alice', { domain: 'r1.example', type: 'addon' })).status).toBe(403);
      app.ctx.db.prepare("UPDATE accounts SET plan_snapshot_json = '{\"max_addons\":1}' WHERE username = 'bob'").run();
      const first = await rpost('/domains/bob', { domain: 'r1.example', type: 'addon' });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(calls.ssl).toEqual([['issue', 'r1.example', 'resell1']]);
      const second = await rpost('/domains/bob', { domain: 'r2.example', type: 'addon' });
      expect(second.status).toBe(403);
      expect(second.body.error.message).toMatch(/allows 1 addon/);
      expect((await post('/domains/bob', { domain: 'r2.example', type: 'addon' })).status).toBe(201);
      const mine = await rget('/domains/bob').expect(200);
      expect(mine.body.data.limits.addon).toEqual({ used: 2, max: 1 });
      expect((await resellerHttp.delete('/api/account-functions/domains/bob/r2.example').set('X-CSRF-Token', resellerCsrf)).status).toBe(200);
      expect((await resellerHttp.delete('/api/account-functions/domains/alice/shop.alice.com').set('X-CSRF-Token', resellerCsrf)).status).toBe(403);
    });
  });

  describe('quota filesystem at creation', () => {
    it('sets the package quota on the filesystem that holds the home, not on /', async () => {
      const homeRoot = app.ctx.settings.get('basic.home_root');
      app.ctx.settings.set('basic.home_root', '/home2');
      try {
        await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'frank', domain: 'frank.com', provision: { dns: false, mail: false } }).expect(201);
        expect(app.agent.callsTo('user.set_quota').map((c) => c.args)).toEqual([{ username: 'frank', softMb: 10240, hardMb: 10752, filesystem: '/home2' }]);
      } finally {
        app.ctx.settings.set('basic.home_root', homeRoot);
        await app.http.delete('/api/accounts/frank').set('X-CSRF-Token', csrf).expect(200);
      }
    });
  });
});
