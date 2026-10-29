import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { bootstrap } from '../src/index.js';

// A reseller may follow the jobs it started; every other principal's job (its
// params, result and log lines) must be invisible to it, in the list, the
// detail and the SSE stream. Root keeps seeing everything.
const ADMIN_PASSWORD = 'Test-Passw0rd!1';
const RESELLER_PASSWORD = 'Reseller-Pass1!';

const mockAgent = {
  mode: 'mock',
  async op(name, args = {}) {
    if (name === 'sys.binaries') return Object.fromEntries(args.names.map((n) => [n, false]));
    if (name === 'svc.list_units') return [];
    return {};
  },
  async ping() { return { pong: true, mode: 'mock' }; },
  async catalog() { return []; },
};

let tmp;
let ctx;
let root;
let reseller;
let rootJob;
let resellerJob;
let resellerId;

const login = (client, username, password) => client.post('/api/auth/login').send({ username, password });
const settled = async (client, id) => {
  let body;
  for (let i = 0; i < 50; i++) {
    const res = await client.get(`/api/system/jobs/${id}`);
    body = res.body.data;
    if (res.status !== 200 || ['done', 'failed', 'cancelled'].includes(body?.status)) return res;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${id} did not settle`);
};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-jobs-own-'));
  ctx = await bootstrap({ dataDir: tmp, dbPath: path.join(tmp, 'whm.db'), adminPassword: ADMIN_PASSWORD, logLevel: 'silent', mode: 'monolithic', agent: mockAgent });
  root = request.agent(ctx.app);
  expect((await login(root, 'root', ADMIN_PASSWORD)).status).toBe(200);
  const hash = await ctx.crypto.hashPassword(RESELLER_PASSWORD);
  resellerId = Number(ctx.db.prepare("INSERT INTO users (username, role, password_hash) VALUES (?, 'reseller', ?)").run('resell1', hash).lastInsertRowid);
  reseller = request.agent(ctx.app);
  expect((await login(reseller, 'resell1', RESELLER_PASSWORD)).status).toBe(200);
  ctx.jobs.register('test.secret', async (c) => { c.log(`secret for ${c.params.who}`); return { token: `t-${c.params.who}` }; });
  ctx.jobs.start();
  const rootId = ctx.db.prepare("SELECT id FROM users WHERE username = 'root'").get().id;
  rootJob = ctx.jobs.enqueue('test.secret', { who: 'root' }, { userId: rootId });
  resellerJob = ctx.jobs.enqueue('test.secret', { who: 'reseller' }, { userId: resellerId });
}, 30_000);

afterAll(() => {
  ctx?.jobs.stop();
  ctx?.scheduler.stop();
  ctx?.sessionStore.close();
  ctx?.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('job visibility by principal', () => {
  it('root reads both jobs', async () => {
    expect((await settled(root, rootJob.id)).body.data.result).toEqual({ token: 't-root' });
    expect((await settled(root, resellerJob.id)).body.data.result).toEqual({ token: 't-reseller' });
    const ids = (await root.get('/api/system/jobs?type=test.secret')).body.data.map((j) => j.id);
    expect(ids).toEqual(expect.arrayContaining([rootJob.id, resellerJob.id]));
  });

  it('a reseller sees only the job it started', async () => {
    const own = await settled(reseller, resellerJob.id);
    expect(own.status).toBe(200);
    expect(own.body.data.result).toEqual({ token: 't-reseller' });
    expect(own.body.data.logs.map((l) => l.line)).toContain('secret for reseller');
    const other = await reseller.get(`/api/system/jobs/${rootJob.id}`);
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('not_found');
    const list = await reseller.get('/api/system/jobs?type=test.secret');
    expect(list.status).toBe(200);
    expect(list.body.data.map((j) => j.id)).toEqual([resellerJob.id]);
    expect(list.body.data.every((j) => j.created_by === resellerId)).toBe(true);
  }, 10_000);

  it('the SSE stream of another principal\'s job is refused, its own streams', async () => {
    await settled(root, rootJob.id);
    const denied = await reseller.get(`/api/system/jobs/${rootJob.id}/stream`);
    expect(denied.status).toBe(404);
    expect(denied.text).not.toContain('t-root');
    const own = await reseller.get(`/api/system/jobs/${resellerJob.id}/stream`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toMatch(/text\/event-stream/);
    expect(own.text).toContain('"type":"snapshot"');
    expect(own.text).toContain('t-reseller');
  }, 10_000);

  it('newer ownerless and root jobs never push a reseller\'s job out of the list window', async () => {
    const rootId = ctx.db.prepare("SELECT id FROM users WHERE username = 'root'").get().id;
    for (let i = 0; i < 120; i++) ctx.jobs.enqueue('test.secret', { who: `other-${i}` }, { userId: i % 2 ? rootId : null });
    const list = await reseller.get('/api/system/jobs?type=test.secret&limit=100');
    expect(list.status).toBe(200);
    expect(list.body.data.map((j) => j.id)).toEqual([resellerJob.id]);
    const all = await root.get('/api/system/jobs?type=test.secret&limit=100');
    expect(all.body.data).toHaveLength(100);
    expect(all.body.data.map((j) => j.id)).not.toContain(resellerJob.id);
  }, 20_000);
});
