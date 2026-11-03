import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { errorHandler, notFoundHandler } from '../src/middleware/error.js';
import { HttpError } from '../src/lib/errors.js';
import { register } from '../src/routes/panel/usage.js';
import { DU_CACHE_MS, REFRESH_INTERVAL_MS } from '../src/services/panel-usage.js';

// A host where repquota and the files.du op (run as the account) answer from
// canned numbers; the quota capability is toggled through sys.binaries.
function usageAgent() {
  const state = { quota: false, duCalls: 0 };
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['systemctl', 'useradd', 'usermod', 'userdel', ...(state.quota ? ['repquota', 'quotacheck', 'quotaon', 'setquota', 'edquota'] : [])].includes(n)])),
    'user.quota_report': () => ({ available: true, users: [{ username: 'alice', usedMb: 321, softMb: 1000, hardMb: 1024, inodes: 4321, inodeHard: 100000 }, { username: 'bob', usedMb: 999, softMb: 0, hardMb: 0, inodes: 1, inodeHard: 0 }] }),
    'files.du': ({ username, path }) => { state.duCalls += 1; return { username, path, totalKb: 2048, entries: [{ path: `${path}/public_html`, kb: 1500 }, { path: `${path}/mail`, kb: 548 }] }; },
    'fs.du': ({ path }) => ({ path, bytes: 50 * 1048576 }),
  };
  const agent = createMockAgent(ops);
  agent.state = state;
  return agent;
}

function stubPanel(ctx) {
  ctx.panel = {
    async scope(req) {
      const username = req.get('x-panel-account');
      const row = username && ctx.db.prepare('SELECT * FROM accounts WHERE username = ?').get(username);
      if (!row) throw new HttpError(403, 'no_account', 'No hosting account is linked to this login');
      const account = ctx.accounts.get(username, { id: null, username: 'test', role: 'root' });
      const owner = ctx.db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(row.owner_id);
      return { account, accountId: account.id, username, mode: 'user', actor: req.user, actingAs: null, owner, ownerPrincipal: { id: owner.id, username: owner.username, role: owner.role }, limits: { max_ftp: 20 }, features: account.plan?.features || {} };
    },
  };
}

async function panelApp(app, registerFn) {
  const api = express();
  api.use(express.json({ limit: '2mb' }));
  api.use((req, _res, next) => {
    req.user = { id: 0, username: req.get('x-panel-account') || 'nobody', role: 'user' };
    if (req.get('x-token-scopes')) req.auth = { via: 'token', scopes: req.get('x-token-scopes').split(',') };
    req.audit = (entry) => app.ctx.auditRecord(req, entry);
    next();
  });
  const mount = await registerFn(app.ctx);
  api.use(`/api/panel${mount.path}`, mount.router);
  api.use(notFoundHandler);
  api.use(errorHandler(app.ctx.logger));
  return request(api);
}

describe('/api/panel/usage', () => {
  let app;
  let api;
  let csrf;
  const as = (user) => ({ 'X-Panel-Account': user });
  const get = (user = 'alice') => api.get('/api/panel/usage').set(as(user));
  const refresh = (user = 'alice') => api.post('/api/panel/usage/refresh').set(as(user)).send({});

  beforeAll(async () => {
    app = await createTestApp({ agent: usageAgent() });
    csrf = await app.login();
    app.ctx.jobs.start();
    await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', owner: 'resell1' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com' }).expect(201);
    const db = app.ctx.db;
    const alice = db.prepare("SELECT id FROM accounts WHERE username = 'alice'").get();
    const bob = db.prepare("SELECT id FROM accounts WHERE username = 'bob'").get();
    db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'shop.alice.com', 'sub', '/home/alice/public_html/shop'), (?, 'alice.net', 'addon', '/home/alice/alice.net'), (?, 'alias.alice.com', 'parked', NULL)").run(alice.id, alice.id, alice.id);
    db.prepare("INSERT INTO databases (account_id, name) VALUES (?, 'alice_shop'), (?, 'alice_blog'), (?, 'bob_x')").run(alice.id, alice.id, bob.id);
    db.prepare("INSERT INTO db_users (account_id, name) VALUES (?, 'alice_app')").run(alice.id);
    db.prepare("INSERT INTO ftp_accounts (account_id, name, login, daemon, dir) VALUES (?, 'shop', 'shop@alice.com', 'pure-ftpd', '/home/alice/public_html'), (?, 'x', 'x@bob.com', 'pure-ftpd', '/home/bob')").run(alice.id, bob.id);
    db.prepare("INSERT INTO mail_domains (account_id, domain) VALUES (?, 'alice.com') ON CONFLICT (domain) DO UPDATE SET account_id = excluded.account_id").run(alice.id);
    const md = db.prepare("SELECT id FROM mail_domains WHERE domain = 'alice.com'").get();
    db.prepare("INSERT INTO mail_accounts (domain_id, local_part) VALUES (?, 'info'), (?, 'sales')").run(md.id, md.id);
    db.prepare("INSERT INTO account_bandwidth (account_id, period, bytes) VALUES (?, '2026-10', 1572864), (?, '2026-09', 524288)").run(alice.id, alice.id);
    db.prepare('UPDATE accounts SET disk_used_mb = 120, disk_quota_mb = 10240, bandwidth_used_mb = 1536, bandwidth_limit_mb = 102400 WHERE id = ?').run(alice.id);
    stubPanel(app.ctx);
    api = await panelApp(app, register);
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('refuses without a pinned account, the panel service or the token scope', async () => {
    expect((await api.get('/api/panel/usage').expect(403)).body.error.code).toBe('no_account');
    const panel = app.ctx.panel;
    delete app.ctx.panel;
    try { expect((await get().expect(403)).body.error.code).toBe('panel_scope_required'); } finally { app.ctx.panel = panel; }
    await get().set('X-Token-Scopes', 'panel:files').expect(403);
    await get().set('X-Token-Scopes', 'panel:read').expect(200);
  });

  it('reports disk, bandwidth, counts and limits of the account only, from the scan when quotas are absent', async () => {
    app.ctx.panelUsage._caches.duCache.clear();
    const res = await get().expect(200);
    const d = res.body.data;
    expect(d.account).toMatchObject({ username: 'alice', domain: 'alice.com', home: '/home/alice' });
    expect(d.disk).toMatchObject({ usedMb: 120, quotaMb: 10240, percent: 1.2, source: 'scan' });
    expect(d.disk.breakdown).toMatchObject({ totalKb: 2048 });
    expect(d.disk.breakdown.entries).toHaveLength(2);
    expect(d.bandwidth).toMatchObject({ usedMb: 1536, limitMb: 102400, percent: 1.5 });
    expect(d.bandwidth.months).toEqual([{ period: '2026-10', mb: 1.5 }, { period: '2026-09', mb: 0.5 }]);
    expect(d.counts).toMatchObject({ domains: 2, addons: 1, subdomains: 1, parked: 1, mailboxes: 2, databases: 2, dbUsers: 1, ftp: 1 });
    expect(d.limits).toMatchObject({ max_addons: 0, max_subdomains: 10, max_parked: 0, max_email: 50, max_sql: 10, max_ftp: 20, disk_mb: 10240, bandwidth_mb: 102400 });
    expect(d.objects.find((o) => o.key === 'ftp')).toEqual({ key: 'ftp', used: 1, limit: 20, percent: 5 });
    expect(d.objects.find((o) => o.key === 'addons')).toEqual({ key: 'addons', used: 1, limit: 0, percent: null });
    expect(app.agent.callsTo('files.du')[0].args).toEqual({ username: 'alice', path: '/home/alice', depth: 1 });
    expect(app.agent.callsTo('user.quota_report')).toHaveLength(0);
    const bob = await get('bob').expect(200);
    expect(bob.body.data.counts).toMatchObject({ domains: 1, databases: 1, ftp: 1, mailboxes: 0 });
    expect(bob.body.data.disk).toMatchObject({ usedMb: 0, quotaMb: 10240 });
  });

  it('caches the du breakdown per account and ignores other users in the quota report', async () => {
    const before = app.agent.state.duCalls;
    await get().expect(200);
    await get().expect(200);
    expect(app.agent.state.duCalls).toBe(before);
    expect(DU_CACHE_MS).toBe(300000);
    app.agent.state.quota = true;
    await app.ctx.capabilities.ensureFresh(0);
    try {
      const res = await get().expect(200);
      expect(res.body.data.disk).toMatchObject({ usedMb: 321, source: 'repquota', inodes: 4321, inodeLimit: 100000 });
      const bob = await get('bob').expect(200);
      expect(bob.body.data.disk).toMatchObject({ usedMb: 999, source: 'repquota' });
      expect(app.agent.callsTo('user.quota_report')).toHaveLength(1);
    } finally { app.agent.state.quota = false; await app.ctx.capabilities.ensureFresh(0); }
  });

  it('refreshes through the server-wide disk job, reusing a running one and rate limiting per account', async () => {
    const first = await refresh().expect(202);
    expect(first.body.data).toMatchObject({ reused: false });
    const jobId = first.body.data.job.id;
    const again = await refresh('bob');
    expect([202, 429]).toContain(again.status);
    if (again.status === 202 && again.body.data.reused) expect(again.body.data.job.id).toBe(jobId);
    const job = await waitForJob(app.ctx, jobId);
    expect(job.type).toBe('account_info.disk_refresh');
    expect(job.status).toBe('done');
    const limited = await refresh().expect(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(REFRESH_INTERVAL_MS).toBe(600000);
    expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'panel.usage.refresh' AND target = 'alice'").get()).toBeTruthy();
    await api.post('/api/panel/usage/refresh').set(as('alice')).send({ all: true }).expect(422);
  });
});
