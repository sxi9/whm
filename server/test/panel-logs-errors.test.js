import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { ERROR_LOG, domainOfLog } from '../src/services/panel-logs.js';

const MAIN = 'l1\nl2\nl3\nl4\nl5\n';
const SHOP = 'shop-a\nshop-b\n';
const CONTENT = {
  '/var/log/whm/domlogs/alice/alice.com-error_log': MAIN,
  '/var/log/whm/domlogs/alice/shop.alice.com-error.log': SHOP,
};
const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-02T00:00:00.000Z';
const LOGS = {
  '/var/log/whm/domlogs/alice': [
    { name: 'alice.com-access_log', size: 10, mtime: T0 },
    { name: 'alice.com-error_log', size: MAIN.length, mtime: T0 },
    { name: 'alice.com-error_log.1', size: 10, mtime: T0 },
    { name: 'alice.com-ssl_error_log', size: 0, mtime: T0 },
    { name: 'shop.alice.com-error.log', size: SHOP.length, mtime: T1 },
    { name: 'other.com-error_log', size: 10, mtime: T0 },
  ],
  '/home/alice/logs': [{ name: 'custom-error.log', size: 10, mtime: T0 }],
};

function errorsAgent() {
  return createMockAgent({
    'acct.list_logs': ({ path }) => ({ path, entries: LOGS[path] || [], skipped: [] }),
    'acct.read_range': ({ path, offset, length }) => {
      const buf = Buffer.from(CONTENT[path] || '');
      const slice = buf.subarray(offset, Math.min(buf.length, offset + length));
      const listed = Object.entries(LOGS).flatMap(([dir, entries]) => entries.map((e) => [`${dir}/${e.name}`, e])).find(([p]) => p === path)?.[1];
      return { path, size: buf.length, offset, length: slice.length, data: slice.toString('base64'), eof: offset + slice.length >= buf.length, mtime: listed?.mtime ?? T0 };
    },
  });
}

async function panelLogin(app, username, password = 'Panel-Passw0rd!1') {
  const hash = await app.ctx.crypto.hashPassword(password);
  app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  const http = request.agent(app.ctx.app);
  const res = await http.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`panel login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { get: (p) => http.get(`/api/panel${p}`) };
}

function setFeature(app, username, key, enabled) {
  const plan = JSON.parse(app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username).plan_snapshot_json || '{}');
  plan.features = { ...(plan.features || {}), [key]: enabled };
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(plan), username);
}

describe('Customer panel: errors page (P2-5)', () => {
  let app;
  let alice;
  let bob;

  beforeAll(async () => {
    app = await createTestApp({ agent: errorsAgent() });
    const csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', provision: { dns: false, mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', provision: { dns: false, mail: false } }).expect(201);
    const aliceId = app.ctx.db.prepare('SELECT id FROM accounts WHERE username = ?', ).get('alice').id;
    app.ctx.db.prepare("INSERT OR IGNORE INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'shop.alice.com', 'sub', '/home/alice/public_html/shop')").run(aliceId);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
  }, 30000);
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('matches live error logs only', () => {
    for (const name of ['alice.com-error_log', 'alice.com-ssl_error_log', 'alice.com-error.log', 'alice.com.error.log', 'alice.com-ssl-error.log', 'custom-error.log']) expect(ERROR_LOG.test(name), name).toBe(true);
    for (const name of ['alice.com-access_log', 'alice.com-error_log.1', 'alice.com-error.log.gz', 'alice.com-bytes_log', 'error', 'errors.log']) expect(ERROR_LOG.test(name), name).toBe(false);
    expect(domainOfLog('shop.alice.com-error.log', ['alice.com', 'shop.alice.com'])).toBe('shop.alice.com');
    expect(domainOfLog('custom-error.log', ['alice.com'])).toBe(null);
  });

  it('returns the newest lines of every own error log, newest file first', async () => {
    const res = await alice.get('/logs/errors').expect(200);
    const data = res.body.data;
    expect(data).toMatchObject({ lines: 300, domain: null, domains: ['alice.com', 'shop.alice.com'], apache: false, nginx: false });
    expect(data.files.map((f) => f.name)).toEqual(['shop.alice.com-error.log', 'alice.com-error_log', 'alice.com-ssl_error_log', 'custom-error.log']);
    const main = data.files.find((f) => f.name === 'alice.com-error_log');
    expect(main).toMatchObject({ kind: 'apache', domain: 'alice.com', location: 'server', size: MAIN.length, truncated: false, lines: ['l5', 'l4', 'l3', 'l2', 'l1'] });
    expect(data.files.find((f) => f.name === 'shop.alice.com-error.log')).toMatchObject({ domain: 'shop.alice.com', lines: ['shop-b', 'shop-a'] });
    expect(data.files.find((f) => f.name === 'alice.com-ssl_error_log')).toMatchObject({ size: 0, lines: [], truncated: false });
    expect(data.files.find((f) => f.name === 'custom-error.log')).toMatchObject({ domain: null, location: 'home' });
    expect(data.files.every((f) => !('path' in f) && !('dir' in f))).toBe(true);
    const reads = app.agent.callsTo('acct.read_range');
    expect(reads.map((c) => c.args.path).sort()).toEqual(['/home/alice/logs/custom-error.log', '/var/log/whm/domlogs/alice/alice.com-error_log', '/var/log/whm/domlogs/alice/shop.alice.com-error.log']);
    expect(reads.every((c) => c.args.owner === 'alice')).toBe(true);
    expect(app.agent.callsTo('acct.list_logs').map((c) => c.args.path)).not.toContain('/var/log/whm/domlogs/bob');
  });

  it('caps the lines, marks the file as truncated and filters by domain', async () => {
    const res = await alice.get('/logs/errors?lines=2&domain=alice.com').expect(200);
    expect(res.body.data.lines).toBe(2);
    expect(res.body.data.domain).toBe('alice.com');
    expect(res.body.data.files.map((f) => f.name)).toEqual(['alice.com-error_log', 'alice.com-ssl_error_log']);
    expect(res.body.data.files[0]).toMatchObject({ lines: ['l5', 'l4'], truncated: true });
    expect(app.agent.callsTo('acct.read_range')).toHaveLength(1);
    expect((await alice.get('/logs/errors?domain=bob.com')).status).toBe(404);
    expect((await alice.get('/logs/errors?lines=0')).status).toBe(422);
    expect((await alice.get('/logs/errors?lines=5000')).status).toBe(422);
    expect((await alice.get('/logs/errors?domain=../x')).status).toBe(422);
  });

  it('never shows another account\'s logs and is gated by the errlog feature', async () => {
    const other = await bob.get('/logs/errors').expect(200);
    expect(other.body.data.files).toEqual([]);
    setFeature(app, 'alice', 'errlog', false);
    const res = await alice.get('/logs/errors');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('feature_disabled');
    setFeature(app, 'alice', 'errlog', true);
    setFeature(app, 'alice', 'rawlog', false);
    expect((await alice.get('/logs/errors')).status).toBe(200);
    setFeature(app, 'alice', 'rawlog', true);
  });
});
