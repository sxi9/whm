import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { bootstrap } from '../../src/index.js';

// A stand-in for whm-agentd: records every op call and answers with canned
// results, so API tests never touch the host. Override per test with set()/fail().
export function createMockAgent(overrides = {}) {
  const calls = [];
  const defaults = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, false])),
    'svc.list_units': () => [],
    'svc.resolve': () => ({ unit: null }),
    'svc.status': ({ unit }) => ({ unit, installed: true, active: true, state: 'active', subState: 'running', enabled: true, pid: 4242, memoryBytes: 1024, restarts: 0 }),
    'sys.info': () => ({
      hostname: 'test.example.com',
      os: { name: 'Test Linux 1.0', id: 'test', version: '1.0', kernel: '6.0.0', arch: 'x64' },
      uptimeSeconds: 3600, loadAverage: [0.1, 0.2, 0.3],
      cpu: { count: 2, model: 'Test CPU', speedMHz: 2000 },
      memory: { totalBytes: 8e9, freeBytes: 4e9, availableBytes: 6e9, buffersBytes: 1e8, cachedBytes: 1e9, swapTotalBytes: 0, swapFreeBytes: 0 },
      disks: [{ filesystem: '/dev/sda1', sizeBytes: 1e11, usedBytes: 2e10, availableBytes: 8e10, usedPercent: 20, mountpoint: '/' }],
      interfaces: [{ name: 'eth0', addresses: [{ address: '10.0.0.5', family: 'IPv4', netmask: '255.255.255.0' }] }],
      node: process.version, agentPid: 1, agentUid: 0,
    }),
    'sys.disk.usage': () => [{ filesystem: '/dev/sda1', sizeBytes: 1e11, usedBytes: 2e10, availableBytes: 8e10, usedPercent: 20, mountpoint: '/' }],
    'sys.processes': () => [{ pid: 1, ppid: 0, user: 'root', cpuPercent: 0, memPercent: 0.1, rssBytes: 1024, vszBytes: 2048, elapsedSeconds: 10, state: 'S', command: 'init', args: '' }],
    'user.get': () => null,
    'user.create': ({ username, homeDir, shell }) => ({ username, uid: 30001, gid: 30001, home: homeDir, shell }),
  };
  const canned = { ...defaults, ...overrides };
  const agent = {
    mode: 'mock',
    calls,
    async op(name, args = {}) {
      calls.push({ name, args });
      const handler = canned[name];
      if (handler instanceof Error) throw handler;
      if (typeof handler === 'function') return handler(args);
      return handler ?? {};
    },
    async ping() { return { pong: true, ops: Object.keys(canned).length, mode: 'mock' }; },
    async catalog() { return Object.keys(canned).map((name) => ({ name, description: 'mock', destructive: false })); },
    // Make an op answer with a value (or function of args).
    set(name, result) { canned[name] = result; },
    // Make an op fail like the real agent would (err.agentError + code).
    fail(name, code = 'command_failed', message = `mock failure for ${name}`) {
      canned[name] = Object.assign(new Error(message), { agentError: true, code, details: {} });
    },
    reset(name) { if (name) canned[name] = defaults[name]; else Object.assign(canned, defaults); calls.length = 0; },
    callsTo: (name) => calls.filter((c) => c.name === name),
  };
  return agent;
}

// Boots the real app against a temp SQLite DB with the mock agent. Returns a
// supertest agent that keeps cookies, plus login() which returns the CSRF token.
export async function createTestApp({ agent, overrides } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-test-'));
  const mockAgent = agent || createMockAgent();
  const ctx = await bootstrap({
    dataDir: dir, dbPath: path.join(dir, 'whm.db'), adminPassword: 'Test-Passw0rd!1',
    logLevel: 'silent', mode: 'monolithic', agent: mockAgent, ...overrides,
  });
  const http = request.agent(ctx.app);

  async function login(username = 'root', password = 'Test-Passw0rd!1') {
    const res = await http.post('/api/auth/login').send({ username, password });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data.csrfToken;
  }

  // Creates a reseller (or user) directly in the DB for RBAC tests.
  async function createUser(username, role = 'reseller', password = 'Test-Passw0rd!1') {
    const hash = await ctx.crypto.hashPassword(password);
    const { lastInsertRowid } = ctx.db.prepare('INSERT INTO users (username, role, password_hash) VALUES (?, ?, ?)').run(username, role, hash);
    return { id: Number(lastInsertRowid), username, role, password };
  }

  async function close() {
    ctx.jobs.stop();
    ctx.scheduler.stop();
    ctx.sessionStore.close();
    ctx.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { ctx, http, agent: mockAgent, login, createUser, close, dir };
}

// Polls a job until it leaves queued/running (jobs.start() must have been called).
export async function waitForJob(ctx, id, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const job = ctx.jobs.get(id);
    if (!['queued', 'running'].includes(job.status)) return job;
    if (Date.now() - started > timeoutMs) throw new Error(`job ${id} still ${job.status} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
