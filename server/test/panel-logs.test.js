import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';

const CONTENT = 'first line\nsecond line\nthird line\n';
const LOGS = {
  '/var/log/whm/domlogs/alice': [
    { name: 'alice.com-access_log', size: CONTENT.length, mtime: '2026-11-01T00:00:00.000Z' },
    { name: 'alice.com-error_log', size: 10, mtime: '2026-11-01T00:00:00.000Z' },
    { name: 'other.com-access_log', size: 10, mtime: '2026-11-01T00:00:00.000Z' },
    { name: 'alice.com-bytes_log', size: 0, mtime: '2026-11-01T00:00:00.000Z' },
  ],
  '/home/alice/logs': [{ name: 'custom.log', size: 10, mtime: '2026-11-01T00:00:00.000Z' }, { name: 'nginx-x.log', size: 10, mtime: '2026-11-01T00:00:00.000Z' }],
  '/var/log/whm/domlogs/bob': [{ name: 'bob.com-access_log', size: 10, mtime: '2026-11-01T00:00:00.000Z' }],
};

function logsAgent() {
  return createMockAgent({
    'acct.list_logs': ({ path }) => ({ path, entries: LOGS[path] || [], skipped: [] }),
    'acct.read_range': ({ path, offset, length }) => {
      const buf = Buffer.from(CONTENT);
      const slice = buf.subarray(offset, Math.min(buf.length, offset + length));
      return { path, size: buf.length, offset, length: slice.length, data: slice.toString('base64'), eof: offset + slice.length >= buf.length, mtime: '2026-11-01T00:00:00.000Z' };
    },
  });
}

async function panelLogin(app, username, password = 'Panel-Passw0rd!1') {
  const hash = await app.ctx.crypto.hashPassword(password);
  app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  const http = request.agent(app.ctx.app);
  const res = await http.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`panel login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  return {
    get: (p) => http.get(`/api/panel${p}`),
    put: (p, body = {}) => http.put(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
  };
}

function setFeature(app, username, key, enabled) {
  const plan = JSON.parse(app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username).plan_snapshot_json || '{}');
  plan.features = { ...(plan.features || {}), [key]: enabled };
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(plan), username);
}

describe('Customer panel: logs and bandwidth', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  const db = () => app.ctx.db;
  const row = (sql, ...args) => db().prepare(sql).get(...args);
  const names = () => app.agent.calls.map((c) => c.name);

  beforeAll(async () => {
    app = await createTestApp({ agent: logsAgent() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', provision: { dns: false, mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', provision: { dns: false, mail: false } }).expect(201);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('lists the account\'s own log files by name, filtered to its hostnames', async () => {
    const res = await alice.get('/logs?kind=apache').expect(200);
    const files = res.body.data.files;
    expect(files.map((f) => f.name).sort()).toEqual(['alice.com-access_log', 'alice.com-error_log', 'custom.log', 'alice.com-bytes_log'].sort());
    expect(files.find((f) => f.name === 'alice.com-access_log')).toMatchObject({ size: CONTENT.length, location: 'server' });
    expect(files.find((f) => f.name === 'custom.log').location).toBe('home');
    expect(files.every((f) => !('path' in f) && !('dir' in f))).toBe(true);
    const paths = app.agent.callsTo('acct.list_logs').map((c) => c.args.path);
    expect(paths).toEqual(expect.arrayContaining(['/var/log/whm/domlogs/alice', '/home/alice/logs']));
    expect(paths).not.toContain('/var/log/whm/domlogs/bob');
    expect(app.agent.callsTo('acct.list_logs').find((c) => c.args.path === '/home/alice/logs').args.owner).toBe('alice');
  });

  it('tails from the listed path as the account, with offset math from the listed size', async () => {
    const res = await alice.get('/logs/tail?kind=apache&file=alice.com-access_log&bytes=15').expect(200);
    const call = app.agent.callsTo('acct.read_range')[0];
    expect(call.args).toEqual({ path: '/var/log/whm/domlogs/alice/alice.com-access_log', owner: 'alice', offset: CONTENT.length - 15, length: 15 });
    expect(res.body.data).toMatchObject({ file: 'alice.com-access_log', size: CONTENT.length, offset: CONTENT.length - 15, truncated: true, content: 'third line\n' });
    const whole = await alice.get('/logs/tail?kind=apache&file=alice.com-access_log').expect(200);
    expect(whole.body.data.content).toBe(CONTENT);
    expect(whole.body.data.truncated).toBe(false);
    expect(app.agent.callsTo('acct.read_range')[1].args).toMatchObject({ offset: 0, length: CONTENT.length });
    const empty = await alice.get('/logs/tail?kind=apache&file=alice.com-bytes_log').expect(200);
    expect(empty.body.data).toMatchObject({ size: 0, content: '' });
    expect(app.agent.callsTo('acct.read_range')).toHaveLength(2);
  });

  it('only reads names that came from the listing', async () => {
    expect((await alice.get('/logs/tail?kind=apache&file=other.com-access_log')).status).toBe(404);
    expect((await alice.get('/logs/tail?kind=apache&file=bob.com-access_log')).status).toBe(404);
    expect((await alice.get('/logs/tail?kind=apache&file=nginx-x.log')).status).toBe(404);
    for (const file of ['../../etc/passwd', '/etc/passwd', '.hidden', 'a/b', 'x\0y']) {
      const res = await alice.get(`/logs/tail?kind=apache&file=${encodeURIComponent(file)}`);
      expect(res.status, file).toBe(422);
    }
    expect((await alice.get('/logs/tail?kind=apache&file=alice.com-access_log&bytes=2000000')).status).toBe(422);
    expect((await bob.get('/logs/tail?kind=apache&file=alice.com-access_log')).status).toBe(404);
    expect(names()).not.toContain('acct.read_range');
  });

  it('downloads an own file as an attachment and refuses unlisted ones', async () => {
    const res = await alice.get('/logs/download?kind=apache&file=alice.com-access_log').expect(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="alice-alice.com-access_log"/);
    expect(res.text).toBe(CONTENT);
    expect(app.agent.callsTo('acct.read_range')[0].args.path).toBe('/var/log/whm/domlogs/alice/alice.com-access_log');
    expect(row("SELECT 1 AS x FROM audit_log WHERE action = 'panel.logs.download' AND target = 'alice'")).toBeTruthy();
    expect((await alice.get('/logs/download?kind=apache&file=other.com-access_log')).status).toBe(404);
    expect((await bob.get('/logs/download?kind=apache&file=alice.com-access_log')).status).toBe(404);
  });

  it('reports bandwidth history for the account only', async () => {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const aliceId = row('SELECT id FROM accounts WHERE username = ?', 'alice').id;
    const bobId = row('SELECT id FROM accounts WHERE username = ?', 'bob').id;
    db().prepare('INSERT OR REPLACE INTO account_bandwidth (account_id, period, bytes) VALUES (?, ?, ?)').run(aliceId, period, 5 * 1024 * 1024);
    db().prepare('INSERT OR REPLACE INTO account_bandwidth (account_id, period, bytes) VALUES (?, ?, ?)').run(bobId, period, 9 * 1024 * 1024);
    const res = await alice.get('/logs/bandwidth?months=3').expect(200);
    expect(res.body.data.months).toHaveLength(3);
    expect(res.body.data.months.at(-1)).toMatchObject({ period, bytes: 5 * 1024 * 1024 });
    expect(res.body.data).not.toHaveProperty('owner');
    expect(res.body.data).not.toHaveProperty('username');
    expect((await alice.get('/logs/bandwidth?months=99')).status).toBe(422);
  });

  it('reads and updates log retention for the account', async () => {
    const before = await alice.get('/logs/retention').expect(200);
    expect(before.body.data).toMatchObject({ archiveLogs: false, removeOldArchives: true, archiveDir: '/home/alice/logs/archive' });
    expect(before.body.data).not.toHaveProperty('owner');
    const res = await alice.put('/logs/retention', { archiveLogs: true, removeOldArchives: false }).expect(200);
    expect(res.body.data).toMatchObject({ archiveLogs: true, removeOldArchives: false });
    expect((await alice.put('/logs/retention', { retainMonths: 1 })).status).toBe(422);
    expect(row('SELECT archive_logs FROM account_log_retention WHERE account_id = (SELECT id FROM accounts WHERE username = ?)', 'alice').archive_logs).toBe(1);
    expect(row('SELECT 1 AS x FROM account_log_retention WHERE account_id = (SELECT id FROM accounts WHERE username = ?)', 'bob')).toBeUndefined();
  });

  it('is gated by the rawlog and bandwidth features', async () => {
    setFeature(app, 'alice', 'rawlog', false);
    for (const path of ['/logs', '/logs/tail?file=alice.com-access_log', '/logs/download?file=alice.com-access_log', '/logs/retention']) {
      const res = await alice.get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('feature_disabled');
    }
    setFeature(app, 'alice', 'rawlog', true);
    setFeature(app, 'alice', 'bandwidth', false);
    expect((await alice.get('/logs/bandwidth')).body.error.code).toBe('feature_disabled');
    setFeature(app, 'alice', 'bandwidth', true);
    expect(names()).toEqual([]);
  });
});
