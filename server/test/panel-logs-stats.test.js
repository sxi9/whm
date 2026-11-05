import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { STATS_JOB, STATS_SCHEDULE, STATS_COOLDOWN_SETTING, statsPaths } from '../src/services/panel-logs.js';

const agentError = (code, message) => Object.assign(new Error(message), { agentError: true, code, details: {} });
const HTML = `<!DOCTYPE html><html><head><title>report</title></head><body><script>document.title='x'</script>${'x'.repeat(3000)}</body></html>`;

function summaryFor(domain, extra = {}) {
  return {
    version: 1, domain, generatedAt: '2026-11-05T01:50:00.000Z', logFiles: [`/var/log/whm/domlogs/alice/${domain}-access.log`],
    period: { start: '04/Nov/2026', end: '05/Nov/2026' },
    totals: { requests: 222, validRequests: 222, failedRequests: 0, visitors: 60, files: 15, notFound: 75, referrers: 5, bandwidth: 1088699, logBytes: 36264 },
    days: [{ label: '20261105', date: '2026-11-05', hits: 22, visitors: 5, bytes: 1000 }],
    pages: [{ label: '/', hits: 74, visitors: 46, bytes: 724513 }], staticFiles: [], notFound: [{ label: '/favicon.ico', hits: 11, visitors: 0, bytes: 26340 }],
    referrers: [{ label: 'example.org', hits: 11, visitors: 3, bytes: 31536 }], countries: [], statusCodes: [], browsers: [], os: [],
    ...extra,
  };
}

// The agent's view of the account homes: summaries and reports keyed by path.
const files = new Map();
const runs = [];

const HANDLERS = {
    'stats.goaccess.detect': () => ({ installed: true, bin: '/usr/bin/goaccess', version: '1.9.4', packages: { apt: ['goaccess'] }, statsDir: '.keel/stats' }),
    'stats.goaccess.run': ({ username, domain }) => {
      runs.push({ username, domain });
      if (domain === 'empty.alice.com') return { domain, username, skipped: true, reason: 'no_log' };
      const home = `/home/${username}`;
      const summary = summaryFor(domain, { generatedAt: new Date().toISOString() });
      files.set(`${username}:${home}/.keel/stats/${domain}.summary.json`, JSON.stringify(summary));
      files.set(`${username}:${home}/.keel/stats/${domain}.html`, HTML);
      return { domain, username, skipped: false, html: `${home}/.keel/stats/${domain}.html`, summary: `${home}/.keel/stats/${domain}.summary.json`, generatedAt: summary.generatedAt, totals: summary.totals };
    },
    'files.read': ({ username, path, maxBytes }) => {
      const content = files.get(`${username}:${path}`);
      if (content == null) throw agentError('not_found', `${path} does not exist`);
      return { path, size: content.length, bytes: Math.min(content.length, maxBytes), truncated: content.length > maxBytes, binary: false, content: content.slice(0, maxBytes), mtime: '2026-11-05T01:50:00.000Z', mode: '0640' };
    },
    'files.chunk_read': ({ username, path, offset, length }) => {
      const content = files.get(`${username}:${path}`);
      if (content == null) throw agentError('not_found', `${path} does not exist`);
      const buf = Buffer.from(content);
      const slice = buf.subarray(offset, Math.min(buf.length, offset + length));
      return { path, size: buf.length, offset, length: slice.length, data: slice.toString('base64'), eof: offset + slice.length >= buf.length, mtime: '2026-11-05T01:50:00.000Z' };
    },
};
const statsAgent = () => createMockAgent(HANDLERS);

async function panelLogin(app, username, password = 'Panel-Passw0rd!1') {
  const hash = await app.ctx.crypto.hashPassword(password);
  app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  const http = request.agent(app.ctx.app);
  const res = await http.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`panel login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  return {
    get: (p) => http.get(`/api/panel${p}`),
    post: (p, body = {}) => http.post(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
  };
}

function setFeature(app, username, key, enabled) {
  const plan = JSON.parse(app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username).plan_snapshot_json || '{}');
  plan.features = { ...(plan.features || {}), [key]: enabled };
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(plan), username);
}

describe('Customer panel: Visitors (GoAccess statistics)', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  const db = () => app.ctx.db;
  const row = (sql, ...args) => db().prepare(sql).get(...args);

  beforeAll(async () => {
    app = await createTestApp({ agent: statsAgent() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', provision: { dns: false, mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', provision: { dns: false, mail: false } }).expect(201);
    const aliceId = row('SELECT id FROM accounts WHERE username = ?', 'alice').id;
    db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'shop.alice.com', 'sub', '/home/alice/public_html/shop')").run(aliceId);
    db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'empty.alice.com', 'addon', '/home/alice/empty')").run(aliceId);
    db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'parked.alice.com', 'parked', '/home/alice/public_html')").run(aliceId);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
    app.ctx.jobs.start();
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; runs.length = 0; app.ctx.settings.set(STATS_COOLDOWN_SETTING, 600); });

  it('registers the job and the nightly schedule', () => {
    expect(app.ctx.jobs.types()).toContain(STATS_JOB);
    const schedule = app.ctx.scheduler.list().find((s) => s.name === STATS_SCHEDULE.name);
    expect(schedule).toMatchObject({ job_type: STATS_JOB, cron: STATS_SCHEDULE.cron });
  });

  it('summarises every web domain of the account from its own stats directory (no report yet)', async () => {
    const res = await alice.get('/logs/stats').expect(200);
    expect(res.body.data.goaccess).toEqual({ installed: true, version: '1.9.4' });
    expect(res.body.data.cooldownSeconds).toBe(600);
    expect(res.body.data.domains.map((d) => d.domain)).toEqual(['alice.com', 'empty.alice.com', 'shop.alice.com']);
    expect(res.body.data.domains[0]).toMatchObject({ domain: 'alice.com', type: 'main', available: false, generatedAt: null, running: null, cooldownUntil: null, summary: null, error: null });
    const reads = app.agent.callsTo('files.read');
    expect(reads.map((c) => c.args)).toEqual(expect.arrayContaining([{ username: 'alice', path: '/home/alice/.keel/stats/alice.com.summary.json', maxBytes: 1024 * 1024 }]));
    expect(reads.every((c) => c.args.username === 'alice' && c.args.path.startsWith('/home/alice/.keel/stats/'))).toBe(true);
    expect(statsPaths('/home/alice', 'alice.com')).toEqual({ html: '/home/alice/.keel/stats/alice.com.html', summary: '/home/alice/.keel/stats/alice.com.summary.json' });
  });

  it('answers 501 when goaccess is not installed', async () => {
    app.agent.set('stats.goaccess.detect', () => ({ installed: false, bin: null, version: null, packages: { apt: ['goaccess'] } }));
    try {
      const res = await alice.get('/logs/stats');
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('capability_missing');
      expect((await alice.post('/logs/stats/alice.com/generate')).status).toBe(501);
      expect(runs).toEqual([]);
    } finally { app.agent.set('stats.goaccess.detect', HANDLERS['stats.goaccess.detect']); }
    expect((await alice.get('/logs/stats')).status).toBe(200);
  });

  it('"Generate now" queues one job for an own domain, runs the agent op as the account and audits', async () => {
    const res = await alice.post('/logs/stats/alice.com/generate').expect(202);
    expect(res.body.data).toMatchObject({ job: { id: expect.any(Number) }, domain: 'alice.com' });
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.params).toMatchObject({ username: 'alice', domain: 'alice.com' });
    expect(job.result).toMatchObject({ accounts: 1, generated: 1, skipped: 0, failed: 0 });
    expect(runs).toEqual([{ username: 'alice', domain: 'alice.com' }]);
    expect(app.agent.callsTo('stats.goaccess.run')[0].args).toEqual({ username: 'alice', domain: 'alice.com' });
    expect(row("SELECT 1 AS x FROM audit_log WHERE action = 'panel.stats.generate' AND target = 'alice'")).toBeTruthy();
    const summary = await alice.get('/logs/stats').expect(200);
    const main = summary.body.data.domains.find((d) => d.domain === 'alice.com');
    expect(main).toMatchObject({ available: true, running: null, summary: { totals: { visitors: 60, requests: 222 }, pages: [{ label: '/' }] } });
    expect(main.generatedAt).toBeTruthy();
    expect(main.cooldownUntil).toBeTruthy();
    expect(main.summary).not.toHaveProperty('logFiles');
  });

  it('rate-limits repeat requests per domain and refuses a second job while one runs', async () => {
    const again = await alice.post('/logs/stats/alice.com/generate');
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('generate_cooldown');
    expect(again.body.error.fields?.retryAfterSeconds ?? again.body.error.retryAfterSeconds ?? 1).toBeGreaterThan(0);
    expect(runs).toEqual([]);
    app.ctx.settings.set(STATS_COOLDOWN_SETTING, 0);
    // Hold the next run so a second request of the account sees it in flight.
    let release;
    app.agent.set('stats.goaccess.run', ({ username, domain }) => new Promise((resolve) => { release = () => resolve({ domain, username, skipped: true, reason: 'no_log' }); }));
    const first = await alice.post('/logs/stats/shop.alice.com/generate').expect(202);
    await new Promise((r) => setTimeout(r, 80));
    const busy = await alice.post('/logs/stats/alice.com/generate');
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('busy');
    const during = await alice.get('/logs/stats').expect(200);
    expect(during.body.data.domains.find((d) => d.domain === 'shop.alice.com').running).toMatchObject({ id: first.body.data.job.id });
    release();
    expect((await waitForJob(app.ctx, first.body.data.job.id)).status).toBe('done');
    app.agent.set('stats.goaccess.run', HANDLERS['stats.goaccess.run']);
  });

  it('only knows the account\'s own web domains', async () => {
    app.ctx.settings.set(STATS_COOLDOWN_SETTING, 0);
    for (const domain of ['bob.com', 'parked.alice.com', 'nobody.example']) {
      const res = await alice.post(`/logs/stats/${domain}/generate`);
      expect(res.status, domain).toBe(404);
      expect((await alice.get(`/logs/stats/${domain}/report`)).status, domain).toBe(404);
    }
    expect((await alice.post('/logs/stats/bad%20domain/generate')).status).toBe(422);
    expect((await bob.get('/logs/stats/alice.com/report')).status).toBe(404);
    expect(runs).toEqual([]);
    expect(app.agent.callsTo('files.chunk_read')).toEqual([]);
  });

  it('streams the HTML report as the account with a sandbox CSP and frame headers', async () => {
    const res = await alice.get('/logs/stats/alice.com/report').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
    expect(res.headers['content-security-policy']).toBe("sandbox allow-scripts; frame-ancestors 'self'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(HTML)));
    expect(res.text).toBe(HTML);
    const reads = app.agent.callsTo('files.chunk_read');
    expect(reads[0].args).toMatchObject({ username: 'alice', path: '/home/alice/.keel/stats/alice.com.html', offset: 0 });
    expect((await alice.get('/logs/stats/shop.alice.com/report')).status).toBe(404);
  });

  it('the nightly run covers every active account with the feature and skips empty logs', async () => {
    app.agent.calls.length = 0;
    setFeature(app, 'bob', 'webstats', false);
    const job = app.ctx.jobs.enqueue(STATS_JOB, {});
    const done = await waitForJob(app.ctx, job.id);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ accounts: 1, generated: 2, skipped: 1, failed: 0 });
    expect(runs.map((r) => `${r.username}/${r.domain}`).sort()).toEqual(['alice/alice.com', 'alice/empty.alice.com', 'alice/shop.alice.com']);
    setFeature(app, 'bob', 'webstats', true);
    db().prepare("UPDATE accounts SET suspended = 1 WHERE username = 'bob'").run();
    runs.length = 0;
    const second = await waitForJob(app.ctx, app.ctx.jobs.enqueue(STATS_JOB, {}).id);
    expect(second.result.accounts).toBe(1);
    expect(runs.some((r) => r.username === 'bob')).toBe(false);
    db().prepare("UPDATE accounts SET suspended = 0 WHERE username = 'bob'").run();
    // A failing domain is logged and the run carries on; a missing goaccess stops it.
    app.agent.set('stats.goaccess.run', ({ username, domain }) => { runs.push({ username, domain }); if (domain === 'shop.alice.com') throw agentError('command_failed', 'goaccess exploded'); return { domain, username, skipped: true, reason: 'no_log' }; });
    const third = await waitForJob(app.ctx, app.ctx.jobs.enqueue(STATS_JOB, {}).id);
    expect(third.status).toBe('done');
    expect(third.result).toMatchObject({ failed: 1, accounts: 2 });
    app.agent.fail('stats.goaccess.run', 'capability_missing', 'goaccess is not installed');
    const fourth = await waitForJob(app.ctx, app.ctx.jobs.enqueue(STATS_JOB, {}).id);
    expect(fourth.status).toBe('done');
    expect(fourth.result.skipped).toBe('goaccess_missing');
    app.agent.set('stats.goaccess.run', HANDLERS['stats.goaccess.run']);
    // A host without GoAccess at all: the scheduled run ends at the detection, walking no account and logging no error.
    app.agent.set('stats.goaccess.detect', () => ({ installed: false, bin: null, version: null, packages: { apt: ['goaccess'] }, statsDir: '.keel/stats' }));
    runs.length = 0;
    app.agent.calls.length = 0;
    const fifth = await waitForJob(app.ctx, app.ctx.jobs.enqueue(STATS_JOB, {}).id);
    expect(fifth.status).toBe('done');
    expect(fifth.result).toMatchObject({ accounts: 0, skipped: 'goaccess_missing' });
    expect(runs).toEqual([]);
    expect(app.agent.callsTo('stats.goaccess.run')).toEqual([]);
    expect(db().prepare('SELECT level FROM job_logs WHERE job_id = ?').all(fifth.id).map((l) => l.level)).not.toContain('error');
    app.agent.set('stats.goaccess.detect', HANDLERS['stats.goaccess.detect']);
    // A disabled account panel skips the run as well.
    app.ctx.settings.set('panel.enabled', false);
    try {
      const sixth = await waitForJob(app.ctx, app.ctx.jobs.enqueue(STATS_JOB, {}).id);
      expect(sixth.result).toMatchObject({ accounts: 0, skipped: 'panel_disabled' });
      expect(app.agent.callsTo('stats.goaccess.detect')).toHaveLength(1);
    } finally { app.ctx.settings.set('panel.enabled', true); }
  });

  it('is gated by the webstats feature', async () => {
    setFeature(app, 'alice', 'webstats', false);
    try {
      for (const [method, path] of [['get', '/logs/stats'], ['post', '/logs/stats/alice.com/generate'], ['get', '/logs/stats/alice.com/report']]) {
        const res = await alice[method](path);
        expect(res.status, path).toBe(403);
        expect(res.body.error.code).toBe('feature_disabled');
      }
    } finally { setFeature(app, 'alice', 'webstats', true); }
    expect(runs).toEqual([]);
    expect(app.agent.callsTo('files.read')).toEqual([]);
  });
});
