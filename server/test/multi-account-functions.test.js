import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { CapabilityError } from '../src/lib/errors.js';
import { toCsv } from '../src/services/multi-account-functions.js';

// A host with user tooling and quota but no Apache/BIND: the per-account steps
// that need a daemon finish "pending" while the rows and system user change.
const BINS = { useradd: true, usermod: true, userdel: true, chpasswd: true, setquota: true, repquota: true, quotacheck: true, systemctl: true };

function hostAgent() {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n])])),
    'user.set_shell': ({ username, shell }) => ({ username, shell }),
    'user.set_quota': (args) => args,
    'fs.mkdir': ({ path }) => ({ path }),
    'fs.write_file': ({ path, content }) => ({ path, bytes: Buffer.byteLength(content) }),
  });
}

describe('toCsv', () => {
  it('quotes, doubles quotes and neutralises formulas', () => {
    const out = toCsv(['a', 'b'], [['plain', 'has "quote", comma'], ['=SUM(1)', { k: 1 }]]);
    expect(out).toBe('a,b\r\nplain,"has ""quote"", comma"\r\n\'=SUM(1),"{""k"":1}"\r\n');
  });
});

describe('Multi Account Functions API', () => {
  let app;
  let csrf;
  let reseller;
  let resellerHttp;
  let resellerCsrf;

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    csrf = await app.login();
    reseller = await app.createUser('resell1', 'reseller');
    await app.http.post('/api/packages').set('X-CSRF-Token', csrf).send({ name: 'gold', disk_mb: 20480, bandwidth_mb: 204800, has_shell: true, php_version: '8.3' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com', provision: { dns: true } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', owner: 'resell1' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.com', provision: { dns: true } }).expect(201);
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
    app.ctx.jobs.start();
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  const post = (path, body = {}) => app.http.post(`/api/multi-account${path}`).set('X-CSRF-Token', csrf).send(body);
  const get = (path) => app.http.get(`/api/multi-account${path}`);
  const rpost = (path, body = {}) => resellerHttp.post(`/api/multi-account${path}`).set('X-CSRF-Token', resellerCsrf).send(body);
  const rget = (path) => resellerHttp.get(`/api/multi-account${path}`);
  const finished = async (jobId) => { const job = await waitForJob(app.ctx, jobId); expect(job.status).toBe('done'); return job; };

  describe('selection table', () => {
    it('lists visible accounts with filter options and honours filters', async () => {
      const all = await get('/accounts').expect(200);
      expect(all.body.data.map((a) => a.username)).toEqual(['alice', 'bob', 'carol']);
      expect(all.body.meta.filters.owners).toEqual(['resell1', 'root']);
      expect(all.body.meta.maxBatch).toBe(500);
      const filtered = await get('/accounts?owner=resell1').expect(200);
      expect(filtered.body.data.map((a) => a.username)).toEqual(['bob']);
      expect(filtered.body.meta.total).toBe(1);
      const q = await get('/accounts?q=CAROL&sort=domain&dir=desc').expect(200);
      expect(q.body.data.map((a) => a.username)).toEqual(['carol']);
      expect((await get('/accounts?sort=nope')).status).toBe(422);
      expect((await get('/accounts?ip=not-an-ip')).status).toBe(422);
    });

    it('shows resellers only their own accounts', async () => {
      const res = await rget('/accounts').expect(200);
      expect(res.body.data.map((a) => a.username)).toEqual(['bob']);
      expect(res.body.meta.filters.owners).toEqual(['resell1']);
    });

    it('reports which services are available', async () => {
      const res = await get('/capabilities').expect(200);
      expect(res.body.data.web).toMatchObject({ installed: false });
      expect(res.body.data.quota).toMatchObject({ installed: true });
    });
  });

  describe('change multiple sites IP addresses', () => {
    let savedIp;
    beforeAll(() => { savedIp = app.ctx.ip; delete app.ctx.ip; });
    afterAll(() => { if (savedIp) app.ctx.ip = savedIp; });

    it('is root only and validates the body', async () => {
      expect((await rpost('/ip/preview', { changes: [{ username: 'bob', ip: '203.0.113.5' }] })).status).toBe(403);
      expect((await rpost('/ip', { changes: [{ username: 'bob', ip: '203.0.113.5' }] })).status).toBe(403);
      expect((await rget('/ip/addresses')).status).toBe(403);
      expect((await post('/ip/preview', { changes: [] })).status).toBe(422);
      expect((await post('/ip/preview', { changes: [{ username: '-r', ip: '203.0.113.5' }] })).status).toBe(422);
      expect((await post('/ip/preview', { changes: [{ username: 'alice', ip: '203.0.113.5; rm' }] })).status).toBe(422);
      expect((await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.5' }], extra: 1 })).status).toBe(422);
    });

    it('lists candidate addresses from settings when IP Functions is absent', async () => {
      app.ctx.settings.set('basic.main_ip', '203.0.113.10');
      app.ctx.settings.set('basic.shared_ip', '203.0.113.10');
      const res = await get('/ip/addresses').expect(200);
      expect(res.body.data.find((a) => a.address === '203.0.113.10')).toMatchObject({ is_main: true, shared: true, selectable: true });
    });

    it('previews per-account changes, unchanged rows and blocked rows', async () => {
      // The zones were rendered with whatever address was known at creation
      // time; pin zones and accounts to one address so there is something to rewrite.
      app.ctx.db.prepare("UPDATE dns_records SET value = ? WHERE type = 'A'").run('203.0.113.10');
      app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username IN (?, ?)').run('203.0.113.10', 'alice', 'carol');
      const res = await post('/ip/preview', { changes: [{ username: 'alice', ip: '203.0.113.20' }, { username: 'carol', ip: '203.0.113.10' }, { username: 'ghost', ip: '203.0.113.20' }, { username: 'alice', ip: '203.0.113.21' }] }).expect(200);
      const by = Object.fromEntries(res.body.data.items.map((i, n) => [`${i.username}#${n}`, i]));
      expect(by['alice#0']).toMatchObject({ status: 'change', from: '203.0.113.10', to: '203.0.113.20', vhosts: 1, zones: 1 });
      expect(by['alice#0'].records).toBeGreaterThan(0);
      expect(by['carol#1']).toMatchObject({ status: 'unchanged' });
      expect(by['ghost#2']).toMatchObject({ status: 'blocked', issues: ['Account not found or not yours'] });
      expect(by['alice#3'].status).toBe('blocked');
      expect(res.body.data.totals).toMatchObject({ accounts: 4, change: 1, unchanged: 1, blocked: 2 });
      expect(res.body.data.ok).toBe(false);
      expect(res.body.data.warnings.join(' ')).toMatch(/IP Functions is not loaded/);
      expect((await post('/ip', { changes: [{ username: 'ghost', ip: '203.0.113.20' }] })).status).toBe(422);
      expect((await post('/ip', { changes: [{ username: 'carol', ip: '203.0.113.10' }] })).status).toBe(422);
    });

    it('refuses to start when a required daemon is missing', async () => {
      const res = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.20' }], requireDaemons: true });
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('capability_missing');
      expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM multi_account_runs').get().n).toBe(0);
    });

    it('runs the job: rows, A records and vhosts per account, with a downloadable report', async () => {
      const web = app.ctx.web;
      const synced = [];
      const rewrites = [];
      app.ctx.web = { ...web, replaceIp: async (from, to, { accounts }) => { synced.push(accounts[0]); rewrites.push(`${accounts[0]}:${from}->${to}`); throw new CapabilityError('apache'); } };
      try {
        const res = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.20' }, { username: 'carol', ip: '203.0.113.20' }, { username: 'bob', ip: '203.0.113.20' }] }).expect(202);
        expect(res.body.data.run).toMatchObject({ kind: 'change_ip', status: 'queued' });
        const job = await finished(res.body.data.job.id);
        expect(job.result).toMatchObject({ runId: res.body.data.run.id, total: 3, pending: 3, failed: 0 });
        expect(synced.sort()).toEqual(['alice', 'bob', 'carol']);
        // bob never had an address: the shared one is what its vhosts and zones carry.
        expect(rewrites).toContain('bob:203.0.113.10->203.0.113.20');
        for (const u of ['alice', 'carol', 'bob']) expect((await app.http.get(`/api/accounts/${u}`)).body.data.ip).toBe('203.0.113.20');
        const zone = await app.http.get('/api/dns/zones/alice.com').expect(200);
        expect(zone.body.data.records.filter((r) => r.type === 'A').every((r) => r.value === '203.0.113.20')).toBe(true);

        const run = await get(`/runs/${res.body.data.run.id}`).expect(200);
        expect(run.body.data.status).toBe('done');
        expect(run.body.data.totals).toMatchObject({ total: 3, pending: 3 });
        const alice = run.body.data.items.find((i) => i.username === 'alice');
        expect(alice).toMatchObject({ status: 'pending', before: { ip: '203.0.113.10' }, after: { ip: '203.0.113.20' } });
        expect(alice.steps.web.status).toBe('pending');
        expect(alice.steps.dns.some((d) => d.domain === 'alice.com' && d.name)).toBe(true);
        const bob = run.body.data.items.find((i) => i.username === 'bob');
        expect(bob).toMatchObject({ before: { ip: null }, after: { ip: '203.0.113.20' } });
        expect(bob.steps.dns[0]).toMatchObject({ domain: 'bob.com', status: 'pending' });
        const bobZone = await app.http.get('/api/dns/zones/bob.com').expect(200);
        expect(bobZone.body.data.records.filter((r) => r.type === 'A').every((r) => r.value === '203.0.113.20')).toBe(true);

        const csv = await get(`/runs/${res.body.data.run.id}/report?format=csv`).expect(200);
        expect(csv.headers['content-type']).toMatch(/text\/csv/);
        expect(csv.headers['content-disposition']).toMatch(/attachment; filename="multi-account-change_ip-\d+-.*\.csv"/);
        expect(csv.text.split('\r\n')[0]).toBe('run,kind,username,domain,status,detail,before,after,steps,finished_at');
        expect(csv.text).toContain('alice,alice.com,pending');
        const js = await get(`/runs/${res.body.data.run.id}/report?format=json`).expect(200);
        expect(js.headers['content-type']).toMatch(/application\/json/);
        expect(JSON.parse(js.text).items).toHaveLength(3);
        expect((await get(`/runs/${res.body.data.run.id}/report?format=xml`)).status).toBe(422);
        const audit = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('multi_account.ip.start', 'multi_account.ip.result', 'account.ip.change')").get().n;
        expect(audit).toBeGreaterThanOrEqual(5);
      } finally { app.ctx.web = web; }
    });

    it('records a failure per account and continues with the rest', async () => {
      const web = app.ctx.web;
      app.ctx.web = { ...web, replaceIp: async (from, to, { accounts }) => { if (accounts[0] === 'alice') throw Object.assign(new Error('apache exploded'), { agentError: true, code: 'command_failed' }); return { updated: 1, domains: [`${accounts[0]}.com`] }; } };
      try {
        const res = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.30' }, { username: 'carol', ip: '203.0.113.30' }], updateDns: false }).expect(202);
        const job = await finished(res.body.data.job.id);
        expect(job.result).toMatchObject({ total: 2, done: 1, failed: 1 });
        expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.20');
        expect((await app.http.get('/api/accounts/carol')).body.data.ip).toBe('203.0.113.30');
        const run = await get(`/runs/${res.body.data.run.id}`).expect(200);
        expect(run.body.data.items.find((i) => i.username === 'alice')).toMatchObject({ status: 'failed', detail: 'apache exploded', after: { ip: '203.0.113.20' } });
        expect(run.body.data.items.find((i) => i.username === 'alice').steps.ip.status).toBe('rolled_back');
        expect(run.body.data.items.find((i) => i.username === 'carol')).toMatchObject({ status: 'done' });
        expect(run.body.data.items.find((i) => i.username === 'carol').steps.web).toMatchObject({ status: 'applied', detail: expect.stringMatching(/1 vhost\(s\) rewritten \(carol\.com\)/) });
        expect(run.body.data.items.find((i) => i.username === 'carol').steps.dns[0].status).toBe('skipped');
      } finally { app.ctx.web = web; }
    });

    it('rolls the account back when a step reports failure without throwing', async () => {
      const web = app.ctx.web;
      app.ctx.web = { ...web, replaceIp: undefined, ensureVhost: async (u) => ({ username: u, applied: false, reason: 'template_invalid', vhosts: [{ domain: `${u}.com`, applied: false, error: 'bad template' }] }) };
      try {
        const res = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.31' }], updateDns: false }).expect(202);
        const job = await finished(res.body.data.job.id);
        expect(job.result).toMatchObject({ total: 1, failed: 1, done: 0 });
        expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.20');
        const item = (await get(`/runs/${res.body.data.run.id}`)).body.data.items[0];
        expect(item).toMatchObject({ status: 'failed', after: { ip: '203.0.113.20' } });
        expect(item.detail).toMatch(/bad template.*stays on 203\.0\.113\.20/);
        expect(item.steps.ip.status).toBe('rolled_back');
      } finally { app.ctx.web = web; }
    });

    it('keeps the new address when the vhost was written but the PHP handler is missing (ensureVhost fallback)', async () => {
      const web = app.ctx.web;
      const synced = [];
      app.ctx.web = { ...web, replaceIp: undefined, ensureVhost: async (u) => { synced.push(u); return { username: u, applied: false, reason: 'php_missing', reload: { reloaded: true }, vhosts: [{ domain: `${u}.com`, applied: false, reason: 'php_missing', path: '/etc/apache2/sites-available/alice.com.conf', error: 'PHP-FPM is not installed; .php files are served as static content' }] }; } };
      try {
        const res = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.32' }], updateDns: false }).expect(202);
        const job = await finished(res.body.data.job.id);
        expect(job.result).toMatchObject({ total: 1, done: 1, failed: 0 });
        expect(synced).toEqual(['alice']);
        expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.32');
        const item = (await get(`/runs/${res.body.data.run.id}`)).body.data.items[0];
        expect(item).toMatchObject({ status: 'done', after: { ip: '203.0.113.32' } });
        expect(item.steps.ip.status).toBe('applied');
        expect(item.steps.web).toMatchObject({ status: 'applied', detail: expect.stringMatching(/web server reloaded; PHP handler warning: PHP-FPM is not installed/) });
        const pool = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.20' }], updateDns: false }).expect(202);
        app.ctx.web.ensureVhost = async (u) => ({ username: u, applied: false, reason: 'php_pool_failed', vhosts: [{ domain: `${u}.com`, applied: false, reason: 'php_pool_failed', path: '/etc/apache2/sites-available/alice.com.conf', error: 'pool dir unwritable' }] });
        expect((await finished(pool.body.data.job.id)).result).toMatchObject({ done: 1, failed: 0 });
        expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.20');
      } finally { app.ctx.web = web; }
    });

    it('rewrites only the address through replaceIp and puts it back when a later step fails', async () => {
      const web = app.ctx.web;
      const dns = app.ctx.dns;
      const calls = [];
      app.ctx.web = { ...web, replaceIp: async (from, to, { accounts }) => { calls.push(`${accounts.join(',')}:${from}->${to}`); return { updated: 1, domains: ['alice.com'] }; } };
      app.ctx.dns = { ...dns, getZone: async () => { throw new Error('zone store unreadable'); } };
      try {
        const res = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.33' }] }).expect(202);
        const job = await finished(res.body.data.job.id);
        expect(job.result).toMatchObject({ total: 1, failed: 1 });
        expect(calls).toEqual(['alice:203.0.113.20->203.0.113.33', 'alice:203.0.113.33->203.0.113.20']);
        expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.20');
        const item = (await get(`/runs/${res.body.data.run.id}`)).body.data.items[0];
        expect(item).toMatchObject({ status: 'failed', after: { ip: '203.0.113.20' } });
        expect(item.detail).toMatch(/zone store unreadable/);
        expect(item.steps.ip.status).toBe('rolled_back');
        expect(item.steps.web.status).toBe('applied');
      } finally { app.ctx.web = web; app.ctx.dns = dns; }
    });

    it('skips the vhost step when no stored vhost carries the previous address', async () => {
      const web = app.ctx.web;
      app.ctx.web = { ...web, replaceIp: async () => ({ updated: 0, domains: [] }) };
      try {
        const res = await post('/ip', { changes: [{ username: 'carol', ip: '203.0.113.34' }], updateDns: false }).expect(202);
        expect((await finished(res.body.data.job.id)).result).toMatchObject({ done: 1 });
        const item = (await get(`/runs/${res.body.data.run.id}`)).body.data.items[0];
        expect(item.steps.web).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/no stored virtual host used 203\.0\.113\.30/) });
        expect((await app.http.get('/api/accounts/carol')).body.data.ip).toBe('203.0.113.34');
      } finally { app.ctx.web = web; }
    });

    it('refuses IPv6 targets: the vhost renderer and A records need IPv4', async () => {
      expect((await post('/ip/preview', { changes: [{ username: 'alice', ip: '2001:db8::10' }] })).status).toBe(422);
      expect((await post('/ip', { changes: [{ username: 'alice', ip: '2001:db8::10' }] })).status).toBe(422);
      const preview = app.ctx.multiAccount.previewChangeIp({ changes: [{ username: 'alice', ip: '2001:db8::10' }] }, { id: 1, username: 'root', role: 'root' });
      expect(preview.items[0]).toMatchObject({ status: 'blocked' });
      expect(preview.items[0].issues[0]).toMatch(/IPv6/);
      expect(() => app.ctx.multiAccount.startChangeIp({ changes: [{ username: 'alice', ip: '2001:db8::10' }] }, { id: 1, username: 'root', role: 'root' })).toThrow(/problems/);
      const fake = { sharedIp: () => '203.0.113.10', get: () => null, freeAddresses: () => [], all: () => [{ address: '2001:db8::10', family: 6, is_main: false, reserved: false, dedicated_to: null }, { address: '203.0.113.10', family: 4, is_main: true, reserved: false, dedicated_to: null }, { address: '203.0.113.50', family: 4, is_main: false, reserved: false, dedicated_to: 'bob' }, { address: '203.0.113.51', family: 4, is_main: false, reserved: true, dedicated_to: null }] };
      app.ctx.ip = fake;
      try {
        const res = await get('/ip/addresses').expect(200);
        expect(res.body.data.map((a) => a.address)).toEqual(['203.0.113.10', '203.0.113.50', '203.0.113.51']);
        expect(res.body.data.map((a) => a.selectable)).toEqual([true, false, false]);
        expect(res.body.data[1].dedicated_to).toBe('bob');
      } finally { delete app.ctx.ip; }
      expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.20');
    });

    it('fails and rolls back the DNS step on a production host without BIND', async () => {
      app.ctx.db.prepare("UPDATE dns_records SET value = ? WHERE type = 'A' AND zone_id = (SELECT id FROM dns_zones WHERE domain = 'alice.com')").run('203.0.113.20');
      const env = app.ctx.config.env;
      app.ctx.config.env = 'production';
      try {
        const preview = await post('/ip/preview', { changes: [{ username: 'alice', ip: '203.0.113.25' }] }).expect(200);
        expect(preview.body.data.warnings.join(' ')).toMatch(/production server.*rolled back/);
        const res = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.25' }], updateVhosts: false }).expect(202);
        const job = await finished(res.body.data.job.id);
        expect(job.result).toMatchObject({ total: 1, failed: 1, pending: 0 });
        expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.20');
        const zone = await app.http.get('/api/dns/zones/alice.com').expect(200);
        expect(zone.body.data.records.filter((r) => r.type === 'A').every((r) => r.value === '203.0.113.20')).toBe(true);
        const run = await get(`/runs/${res.body.data.run.id}`).expect(200);
        expect(run.body.data.status).toBe('failed');
        const item = run.body.data.items[0];
        expect(item).toMatchObject({ status: 'failed', after: { ip: '203.0.113.20' } });
        expect(item.steps.dns[0]).toMatchObject({ domain: 'alice.com', status: 'failed' });
        expect(item.steps.dns[0].detail).toMatch(/BIND.*not saved/);
      } finally { app.ctx.config.env = env; }
    });

    it('validates addresses and dedication against IP Functions when it is loaded', async () => {
      const fake = {
        sharedIp: () => '203.0.113.10',
        get: (a) => ({ '203.0.113.10': { address: a, reserved: false, dedicated_to: null }, '203.0.113.40': { address: a, reserved: false, dedicated_to: null }, '203.0.113.41': { address: a, reserved: true, reserved_reason: 'kept', dedicated_to: null }, '203.0.113.42': { address: a, reserved: false, dedicated_to: 'bob' } }[a] ?? null),
        freeAddresses: (family) => (family === 4 ? [{ address: '203.0.113.40' }] : []),
        all: () => [], releaseDedicated: () => ({}), allocateDedicated: () => ({}),
      };
      app.ctx.ip = fake;
      try {
        const res = await post('/ip/preview', { changes: [{ username: 'alice', ip: '203.0.113.40' }, { username: 'carol', ip: '203.0.113.40' }, { username: 'bob', ip: '203.0.113.41' }] }).expect(200);
        const [a, c, b] = res.body.data.items;
        expect(a).toMatchObject({ status: 'change', dedicated: true });
        expect(c.issues[0]).toMatch(/becomes dedicated to alice/);
        expect(b.issues[0]).toMatch(/reserved/);
        expect(res.body.data.totals.dedicated).toBe(1);
        const more = await post('/ip/preview', { changes: [{ username: 'alice', ip: '203.0.113.42' }, { username: 'carol', ip: '203.0.113.99' }, { username: 'bob', ip: '203.0.113.42' }] }).expect(200);
        const [a2, c2, b2] = more.body.data.items;
        expect(a2.issues[0]).toMatch(/dedicated to bob/);
        expect(c2.issues[0]).toMatch(/not configured on this server/);
        expect(b2).toMatchObject({ status: 'change', dedicated: false });
        expect(more.body.data.warnings.join(' ')).not.toMatch(/IP Functions is not loaded/);
      } finally { delete app.ctx.ip; }
    });

    it('puts the previous dedication back when allocating the new address throws', async () => {
      const calls = [];
      const fake = {
        sharedIp: () => '203.0.113.10',
        get: (a) => ({ '203.0.113.40': { address: a, reserved: false, dedicated_to: 'alice' }, '203.0.113.41': { address: a, reserved: false, dedicated_to: null } }[a] ?? null),
        freeAddresses: (family) => (family === 4 ? [{ address: '203.0.113.41' }] : []),
        all: () => [{ address: '203.0.113.40', family: 4, dedicated_to: 'alice' }],
        releaseDedicated: (id) => { calls.push('release'); app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE id = ?').run('203.0.113.10', id); return {}; },
        allocateDedicated: (id, req, { address }) => { calls.push(`allocate:${address}`); if (address === '203.0.113.41') throw Object.assign(new Error('203.0.113.41 is not a free address'), { status: 409 }); return {}; },
      };
      app.ctx.ip = fake;
      app.ctx.db.prepare("UPDATE accounts SET ip = '203.0.113.40' WHERE username = 'alice'").run();
      try {
        const res = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.41' }], updateDns: false, updateVhosts: false }).expect(202);
        const job = await finished(res.body.data.job.id);
        expect(job.result).toMatchObject({ total: 1, failed: 1 });
        expect(calls).toEqual(['release', 'allocate:203.0.113.41', 'allocate:203.0.113.40']);
        expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.40');
        const item = (await get(`/runs/${res.body.data.run.id}`)).body.data.items[0];
        expect(item).toMatchObject({ status: 'failed', detail: '203.0.113.41 is not a free address', after: { ip: '203.0.113.40' } });
        expect(item.steps.ip).toMatchObject({ status: 'rolled_back', from: '203.0.113.40', to: '203.0.113.41' });
      } finally { delete app.ctx.ip; app.ctx.db.prepare("UPDATE accounts SET ip = '203.0.113.20' WHERE username = 'alice'").run(); }
    });
  });

  describe('dedication through the real IP Functions service', () => {
    beforeAll(() => {
      app.ctx.settings.set('basic.main_ip', '203.0.113.10');
      app.ctx.settings.set('basic.shared_ip', '203.0.113.10');
      const insert = app.ctx.db.prepare('INSERT OR IGNORE INTO ip_addresses (address, family, netmask, interface, is_main, reserved, managed) VALUES (?, 4, ?, ?, ?, 0, 1)');
      insert.run('203.0.113.10', '255.255.255.0', 'eth0', 1);
      insert.run('203.0.113.11', '255.255.255.0', 'eth0', 0);
      insert.run('203.0.113.12', '255.255.255.0', 'eth0', 0);
      app.ctx.db.prepare('UPDATE accounts SET ip = ? WHERE username IN (?, ?)').run('203.0.113.10', 'alice', 'carol');
    });

    it('dedicates a free address to the account that moves onto it and blocks a second account', async () => {
      expect(app.ctx.ip).toBeDefined();
      const preview = await post('/ip/preview', { changes: [{ username: 'alice', ip: '203.0.113.11' }] }).expect(200);
      expect(preview.body.data.items[0]).toMatchObject({ status: 'change', dedicated: true });
      expect(preview.body.data.totals.dedicated).toBe(1);

      const res = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.11' }], updateDns: false, updateVhosts: false }).expect(202);
      const job = await finished(res.body.data.job.id);
      expect(job.result).toMatchObject({ total: 1, done: 1, failed: 0 });
      expect(app.ctx.ip.get('203.0.113.11').dedicated_to).toBe('alice');
      expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.11');
      const run = await get(`/runs/${res.body.data.run.id}`).expect(200);
      const item = run.body.data.items[0];
      expect(item).toMatchObject({ status: 'done', after: { ip: '203.0.113.11' } });
      expect(item.steps.dedicated).toBe('203.0.113.11');
      const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.ip.change' AND target = 'alice' ORDER BY id DESC LIMIT 1").get();
      expect(JSON.parse(audit.args_redacted).dedicated).toBe('203.0.113.11');
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ip.dedicate' AND target = 'alice'").get().n).toBe(1);

      const second = await post('/ip/preview', { changes: [{ username: 'carol', ip: '203.0.113.11' }] }).expect(200);
      expect(second.body.data.items[0].status).toBe('blocked');
      expect(second.body.data.items[0].issues[0]).toMatch(/dedicated to alice/);
      const refused = await post('/ip', { changes: [{ username: 'carol', ip: '203.0.113.11' }], updateDns: false, updateVhosts: false });
      expect(refused.status).toBe(422);
      expect(refused.body.error.fields.changes[0]).toMatch(/dedicated to alice/);
      expect((await app.http.get('/api/accounts/carol')).body.data.ip).toBe('203.0.113.10');
    });

    it('keeps a dedication when the account stays on its address and releases it when it moves to the shared address', async () => {
      const same = await post('/ip/preview', { changes: [{ username: 'alice', ip: '203.0.113.11' }] }).expect(200);
      expect(same.body.data.items[0].status).toBe('unchanged');
      const res = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.10' }], updateDns: false, updateVhosts: false }).expect(202);
      const job = await finished(res.body.data.job.id);
      expect(job.result).toMatchObject({ total: 1, done: 1 });
      expect(app.ctx.ip.get('203.0.113.11').dedicated_to).toBeNull();
      expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.10');
      const run = await get(`/runs/${res.body.data.run.id}`).expect(200);
      expect(run.body.data.items[0].steps.dedicated).toBeNull();
      expect(app.ctx.ip.freeAddresses(4).map((r) => r.address)).toContain('203.0.113.11');
    });

    it('puts the dedication and the row back when a later step throws', async () => {
      const web = app.ctx.web;
      app.ctx.web = { ...web, replaceIp: async () => { throw Object.assign(new Error('apache exploded'), { agentError: true, code: 'command_failed' }); } };
      try {
        const res = await post('/ip', { changes: [{ username: 'alice', ip: '203.0.113.12' }], updateDns: false }).expect(202);
        const job = await finished(res.body.data.job.id);
        expect(job.result).toMatchObject({ total: 1, failed: 1 });
        expect(app.ctx.ip.get('203.0.113.12').dedicated_to).toBeNull();
        expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.10');
        expect(app.ctx.ip.freeAddresses(4).map((r) => r.address)).toEqual(expect.arrayContaining(['203.0.113.11', '203.0.113.12']));
      } finally { app.ctx.web = web; }
    });

    it('re-checks the inventory when the job runs, so an address claimed after the preview is refused', async () => {
      app.ctx.jobs.stop();
      const aliceId = app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?').get('alice').id;
      try {
        const res = await post('/ip', { changes: [{ username: 'carol', ip: '203.0.113.12' }], updateDns: false, updateVhosts: false }).expect(202);
        app.ctx.jobs.cancel(res.body.data.job.id);
        app.ctx.ip.allocateDedicated(aliceId, null, { address: '203.0.113.12' });
        await app.ctx.multiAccount.runChangeIp({ params: { runId: res.body.data.run.id, userId: 1 }, log() {}, progress() {} });
        const run = await get(`/runs/${res.body.data.run.id}`).expect(200);
        expect(run.body.data.status).toBe('failed');
        expect(run.body.data.items[0].status).toBe('failed');
        expect(run.body.data.items[0].detail).toMatch(/dedicated to alice/);
        expect((await app.http.get('/api/accounts/carol')).body.data.ip).toBe('203.0.113.10');
        expect((await app.http.get('/api/accounts/alice')).body.data.ip).toBe('203.0.113.12');
        expect(app.ctx.ip.get('203.0.113.12').dedicated_to).toBe('alice');
      } finally {
        app.ctx.ip.releaseDedicated(aliceId, null);
        app.ctx.jobs.start();
      }
    });
  });

  describe('job actor', () => {
    it('refuses to run a queued run as root when the starting user no longer exists', async () => {
      app.ctx.jobs.stop();
      try {
        const modify = await rpost('/modify', { usernames: ['bob'], changes: { contactEmail: 'bob@example.net' } }).expect(202);
        app.ctx.jobs.cancel(modify.body.data.job.id);
        const jobCtx = { params: { runId: modify.body.data.run.id, userId: 999999 }, log() {}, progress() {} };
        await expect(app.ctx.multiAccount.runModify(jobCtx)).rejects.toThrow(/no longer exists/);
        const run = await get(`/runs/${modify.body.data.run.id}`).expect(200);
        expect(run.body.data.status).toBe('failed');
        expect(run.body.data.items[0]).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/no longer exists/) });
        expect((await app.http.get('/api/accounts/bob')).body.data.contact_email).not.toBe('bob@example.net');

        const orphan = await post('/ip', { changes: [{ username: 'carol', ip: '203.0.113.12' }], updateDns: false, updateVhosts: false }).expect(202);
        app.ctx.jobs.cancel(orphan.body.data.job.id);
        app.ctx.db.prepare('UPDATE multi_account_runs SET created_by = NULL WHERE id = ?').run(orphan.body.data.run.id);
        await expect(app.ctx.multiAccount.runChangeIp({ params: { runId: orphan.body.data.run.id, userId: null }, log() {}, progress() {} })).rejects.toThrow(/no longer exists/);
        expect((await get(`/runs/${orphan.body.data.run.id}`)).body.data.status).toBe('failed');
        expect((await app.http.get('/api/accounts/carol')).body.data.ip).toBe('203.0.113.10');
        expect(app.ctx.ip.get('203.0.113.12').dedicated_to).toBeNull();
      } finally { app.ctx.jobs.start(); }
    });
  });

  describe('modify / upgrade multiple accounts', () => {
    it('validates the body and enforces ownership', async () => {
      expect((await post('/modify/preview', { usernames: ['alice'], changes: {} })).status).toBe(422);
      expect((await post('/modify/preview', { changes: { package: 'gold' } })).status).toBe(422);
      expect((await post('/modify/preview', { usernames: ['a;b'], changes: { package: 'gold' } })).status).toBe(422);
      expect((await post('/modify/preview', { usernames: ['alice'], changes: { shell: '/bin/zsh' } })).status).toBe(422);
      expect((await post('/modify/preview', { usernames: ['alice'], changes: { package: 'nope' } })).status).toBe(422);
      expect((await post('/modify/preview', { usernames: ['alice'], changes: { owner: 'nobody' } })).status).toBe(422);
      expect((await rpost('/modify/preview', { usernames: ['bob'], changes: { owner: 'root' } })).status).toBe(403);
      const foreign = await rpost('/modify/preview', { usernames: ['alice', 'bob'], changes: { demoMode: true } }).expect(200);
      expect(foreign.body.data.items.find((i) => i.username === 'alice')).toMatchObject({ status: 'blocked' });
      expect(foreign.body.data.items.find((i) => i.username === 'bob')).toMatchObject({ status: 'change' });
      expect((await rpost('/modify', { usernames: ['alice'], changes: { demoMode: true } })).status).toBe(422);
    });

    it('previews the diff per account including package-driven limits', async () => {
      const res = await post('/modify/preview', { all: true, filter: { owner: 'root' }, changes: { package: 'gold', contactEmail: 'ops@example.com' } }).expect(200);
      expect(res.body.data.items.map((i) => i.username)).toEqual(['alice', 'carol']);
      const alice = res.body.data.items[0];
      expect(alice.status).toBe('change');
      const fields = Object.fromEntries(alice.changes.map((c) => [c.field, c]));
      expect(fields.package).toMatchObject({ from: 'default', to: 'gold' });
      expect(fields.diskQuotaMb.to).toBe(20480);
      expect(fields.shell).toMatchObject({ to: '/bin/bash' });
      expect(fields.contactEmail).toMatchObject({ from: 'alice@alice.com', to: 'ops@example.com' });
      expect(fields.phpVersion).toMatchObject({ to: '8.3' });
      expect(res.body.data.totals).toMatchObject({ accounts: 2, change: 2, blocked: 0 });
      expect(res.body.data.ok).toBe(true);
      const same = await post('/modify/preview', { usernames: ['alice'], changes: { contactEmail: 'alice@alice.com' } }).expect(200);
      expect(same.body.data.items[0].status).toBe('unchanged');
      expect((await post('/modify', { usernames: ['alice'], changes: { contactEmail: 'alice@alice.com' } })).status).toBe(422);
    });

    it('refuses with 501 when the package needs Apache and the caller requires installed services', async () => {
      const res = await post('/modify', { usernames: ['alice'], changes: { package: 'gold' }, requireDaemons: true });
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('capability_missing');
    });

    it('applies the changes through ctx.accounts per account and records every step', async () => {
      const web = app.ctx.web;
      const php = [];
      app.ctx.web = { ...web, setPhpVersion: async (domain, version, req, opts) => { php.push(`${domain}:${version}`); expect(opts).toEqual({ reload: false }); throw new CapabilityError('apache'); } };
      try {
        const res = await post('/modify', { usernames: ['alice', 'carol'], changes: { package: 'gold', bandwidthLimitMb: 1000 } }).expect(202);
        expect(res.body.data.run.items).toHaveLength(2);
        const job = await finished(res.body.data.job.id);
        expect(job.result).toMatchObject({ total: 2, pending: 2, failed: 0 });
        expect(php.sort()).toEqual(['alice.com:8.3', 'carol.com:8.3']);
        const alice = (await app.http.get('/api/accounts/alice')).body.data;
        // The package snapshot wins over the explicit bandwidth, as it does in Modify an Account.
        expect(alice).toMatchObject({ package_name: 'gold', disk_quota_mb: 20480, bandwidth_limit_mb: 204800, shell: '/bin/bash' });
        expect(app.agent.callsTo('user.set_quota').map((c) => c.args.username).sort()).toEqual(['alice', 'carol']);
        expect(app.agent.callsTo('user.set_shell')).toHaveLength(2);
        const run = await get(`/runs/${res.body.data.run.id}`).expect(200);
        const item = run.body.data.items.find((i) => i.username === 'alice');
        expect(item).toMatchObject({ status: 'pending', after: { package_name: 'gold', shell: '/bin/bash' } });
        // Outside production mode accounts.modify swallows a failed setquota, so the step is only "recorded".
        expect(item.steps).toMatchObject({ account: { status: 'applied' }, quota: { status: 'recorded' }, php: { status: 'pending' } });
        const csv = await get(`/runs/${res.body.data.run.id}/report`).expect(200);
        expect(csv.text).toContain('modify,alice,alice.com,pending');
      } finally { app.ctx.web = web; }
    });

    it('reloads the web server once after every PHP change in the run', async () => {
      const web = app.ctx.web;
      const php = [];
      let reloads = 0;
      app.ctx.web = { ...web, setPhpVersion: async (domain, version, req, opts) => { php.push(`${domain}:${version}:${opts.reload}`); return { domain }; }, reload: async () => { reloads++; return { reloaded: true }; } };
      app.ctx.db.prepare("UPDATE accounts SET plan_snapshot_json = json_set(COALESCE(plan_snapshot_json, '{}'), '$.php_version', '7.4') WHERE username IN ('alice', 'carol')").run();
      try {
        const preview = await post('/modify/preview', { usernames: ['alice', 'carol'], changes: { package: 'gold' } }).expect(200);
        expect(preview.body.data.items.map((i) => i.php?.from)).toEqual(['7.4', '7.4']);
        const res = await post('/modify', { usernames: ['alice', 'carol'], changes: { package: 'gold' } }).expect(202);
        const job = await finished(res.body.data.job.id);
        expect(job.result).toMatchObject({ total: 2, done: 2 });
        expect(php.sort()).toEqual(['alice.com:8.3:false', 'carol.com:8.3:false']);
        expect(reloads).toBe(1);
        const run = await get(`/runs/${res.body.data.run.id}`).expect(200);
        expect(run.body.data.items.every((i) => i.steps.php.status === 'applied')).toBe(true);
      } finally { app.ctx.web = web; }
    });

    it('re-applies the current package without a PHP change and reports it as a resync', async () => {
      const php = [];
      const web = app.ctx.web;
      app.ctx.web = { ...web, setPhpVersion: async (domain, version) => { php.push(`${domain}:${version}`); return { domain }; } };
      try {
        const preview = await post('/modify/preview', { usernames: ['alice'], changes: { package: 'gold' } }).expect(200);
        const item = preview.body.data.items[0];
        expect(item.status).toBe('change');
        expect(item.changes).toEqual([{ field: 'package', label: 'package (re-apply)', from: 'gold', to: 'gold' }]);
        expect(item.php).toBeNull();
        const res = await post('/modify', { usernames: ['alice'], changes: { package: 'gold' } }).expect(202);
        expect((await finished(res.body.data.job.id)).result).toMatchObject({ total: 1, done: 1 });
        expect(php).toEqual([]);
        expect((await app.http.get('/api/accounts/alice')).body.data.package_name).toBe('gold');
      } finally { app.ctx.web = web; }
    });

    it('lets a reseller modify its own accounts and see only its own runs', async () => {
      const res = await rpost('/modify', { all: true, changes: { demoMode: true, bandwidthLimitMb: null } }).expect(202);
      const job = await finished(res.body.data.job.id);
      expect(job.result).toMatchObject({ total: 1, done: 1 });
      expect((await app.http.get('/api/accounts/bob')).body.data).toMatchObject({ demo_mode: true, bandwidth_limit_mb: null });
      const mine = await rget('/runs').expect(200);
      expect(mine.body.data[0].id).toBe(res.body.data.run.id);
      expect(mine.body.data.every((r) => r.created_by === reseller.id)).toBe(true);
      expect(mine.body.data[0].totals).toMatchObject({ done: 1 });
      const all = await get('/runs?kind=modify').expect(200);
      expect(all.body.data.length).toBeGreaterThan(1);
      const rootRun = all.body.data.find((r) => r.id !== res.body.data.run.id);
      expect((await rget(`/runs/${rootRun.id}`)).status).toBe(403);
      expect((await rget(`/runs/${rootRun.id}/report`)).status).toBe(403);
      expect((await get('/runs/999999')).status).toBe(404);
      expect((await get('/runs?kind=other')).status).toBe(422);
    });

    it('marks a run failed when every account fails and keeps the error per item', async () => {
      const accounts = app.ctx.accounts;
      app.ctx.accounts = { ...accounts, modify: async () => { throw new Error('disk on fire'); } };
      try {
        const res = await post('/modify', { usernames: ['carol'], changes: { demoMode: true } }).expect(202);
        const job = await finished(res.body.data.job.id);
        expect(job.result).toMatchObject({ total: 1, failed: 1 });
        const run = await get(`/runs/${res.body.data.run.id}`).expect(200);
        expect(run.body.data.status).toBe('failed');
        expect(run.body.data.items[0]).toMatchObject({ status: 'failed', detail: 'disk on fire' });
      } finally { app.ctx.accounts = accounts; }
    });
  });

  describe('reseller ACLs', () => {
    const root = { id: 1, username: 'root', role: 'root' };
    const grant = (acls) => app.ctx.resellers.setPrivileges('resell1', { acls }, root, null);
    afterAll(() => grant(['all']));

    it('refuses demo mode, shell access and the account list without the matching privilege', async () => {
      grant(['edit-account']);
      const before = (await app.http.get('/api/accounts/bob')).body.data;
      for (const [res, acl] of [
        [await rpost('/modify/preview', { usernames: ['bob'], changes: { demoMode: false } }), 'Demo Mode'],
        [await rpost('/modify', { usernames: ['bob'], changes: { demoMode: false } }), 'Demo Mode'],
        [await rpost('/modify/preview', { usernames: ['bob'], changes: { shell: '/bin/bash' } }), 'Shell'],
        [await rpost('/modify', { all: true, changes: { shell: '/bin/bash' } }), 'Shell'],
        [await rget('/accounts'), 'List Accounts'],
      ]) {
        expect(res.status, res.body.error?.message).toBe(403);
        expect(res.body.error.message).toMatch(new RegExp(acl, 'i'));
      }
      expect((await app.http.get('/api/accounts/bob')).body.data).toMatchObject({ demo_mode: before.demo_mode, shell: before.shell });
      expect(app.agent.callsTo('user.set_shell')).toEqual([]);
      // Enumerating "all" is the account list; naming the account is not.
      const enumerate = await rpost('/modify/preview', { all: true, changes: { contactEmail: 'bob@example.org' } });
      expect(enumerate.status).toBe(403);
      expect(enumerate.body.error.message).toMatch(/List Accounts/i);
      expect((await rpost('/modify/preview', { usernames: ['bob'], changes: { contactEmail: 'bob@example.org' } })).status).toBe(200);
      grant(['edit-account', 'add-pkg-shell', 'disallow-shell', 'list-accts']);
      const shell = await rpost('/modify', { usernames: ['bob'], changes: { shell: '/bin/bash' } });
      expect(shell.status).toBe(403);
      expect(shell.body.error.message).toMatch(/Disallow Shell/);
      expect((await rpost('/modify/preview', { usernames: ['bob'], changes: { shell: '/usr/sbin/nologin' } })).status).toBe(200);
      expect((await rget('/accounts')).status).toBe(200);
    });

    it('blocks a package that grants a shell the reseller may not give', async () => {
      expect((await app.http.get('/api/accounts/bob')).body.data.shell).toBe('/usr/sbin/nologin');
      grant(['edit-account', 'list-accts', 'disallow-shell']);
      const denied = await rpost('/modify/preview', { usernames: ['bob'], changes: { package: 'gold' } }).expect(200);
      expect(denied.body.data.items[0]).toMatchObject({ status: 'blocked' });
      expect(denied.body.data.items[0].issues[0]).toMatch(/Disallow Shell/);
      expect((await rpost('/modify', { usernames: ['bob'], changes: { package: 'gold' } })).status).toBe(422);
      grant(['edit-account', 'list-accts']);
      const missing = await rpost('/modify/preview', { usernames: ['bob'], changes: { package: 'gold' } }).expect(200);
      expect(missing.body.data.items[0].issues[0]).toMatch(/add-pkg-shell/);
      expect(app.agent.callsTo('user.set_shell')).toEqual([]);
      expect((await app.http.get('/api/accounts/bob')).body.data.shell).toBe('/usr/sbin/nologin');
      grant(['edit-account', 'list-accts', 'add-pkg-shell', 'upgrade-account']);
      const allowed = await rpost('/modify/preview', { usernames: ['bob'], changes: { package: 'gold' } }).expect(200);
      // Only the reseller package list stands in the way now, not the shell privilege.
      expect(allowed.body.data.items[0].issues.join(' ')).not.toMatch(/shell/i);
    });

    it('blocks rows the reseller limits refuse before the run starts', async () => {
      grant(['edit-account', 'list-accts']);
      const preview = await rpost('/modify/preview', { usernames: ['bob'], changes: { diskQuotaMb: 123 } }).expect(200);
      expect(preview.body.data.items[0]).toMatchObject({ status: 'blocked' });
      expect(preview.body.data.items[0].issues[0]).toMatch(/disk quotas/i);
      expect(preview.body.data.totals.blocked).toBe(1);
      const refused = await rpost('/modify', { usernames: ['bob'], changes: { diskQuotaMb: 123 } });
      expect(refused.status).toBe(422);
      expect(refused.body.error.fields.usernames[0]).toMatch(/bob: .*disk quotas/i);
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM multi_account_runs WHERE requested_by = 'resell1' AND params_json LIKE '%123%'").get().n).toBe(0);
      grant(['edit-account', 'list-accts', 'quota']);
      const ok = await rpost('/modify/preview', { usernames: ['bob'], changes: { diskQuotaMb: 123 } }).expect(200);
      expect(ok.body.data.items[0].status).toBe('change');
      const same = await rpost('/modify/preview', { usernames: ['bob'], changes: { contactEmail: null } }).expect(200);
      expect(same.body.data.items[0].issues).toEqual([]);
    });
  });

  describe('retention', () => {
    it('prunes finished runs older than the retention setting', async () => {
      app.ctx.db.prepare("UPDATE multi_account_runs SET finished_at = datetime('now', '-400 days') WHERE id = (SELECT MIN(id) FROM multi_account_runs)").run();
      const before = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM multi_account_runs').get().n;
      const out = app.ctx.multiAccount.cleanup({ log() {} });
      expect(out).toMatchObject({ removed: 1, days: 90 });
      expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM multi_account_runs').get().n).toBe(before - 1);
      expect(app.ctx.scheduler.list().some((s) => s.name === 'multi-account-run-cleanup')).toBe(true);
    });
  });
});
