import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { authenticator } from 'otplib';
import { bootstrap } from '../src/index.js';
import { AgentError } from '../src/lib/agent-client.js';

const ADMIN_PASSWORD = 'Test-Passw0rd!1';
const RESELLER_PASSWORD = 'Reseller-Pass1!';
const ACCOUNT_PASSWORD = 'Secret-Pass-123';

// Stands in for whm-agentd: records every op, answers with canned results and
// can be told to fail a specific op once.
function createMockAgent() {
  const failures = new Map();
  const canned = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, false])),
    'svc.list_units': () => [],
    'sys.info': () => ({
      hostname: 'test-host',
      os: { name: 'Test Linux 1.0', id: 'testlinux', version: '1.0', kernel: '6.0.0-test', arch: 'x64' },
      uptimeSeconds: 12345,
      loadAverage: [0.1, 0.2, 0.3],
      cpu: { count: 2, model: 'Test CPU', speedMHz: 2000 },
      memory: { totalBytes: 8e9, freeBytes: 4e9, availableBytes: 5e9, buffersBytes: 1e8, cachedBytes: 1e9, swapTotalBytes: 0, swapFreeBytes: 0 },
      disks: [],
      interfaces: [{ name: 'eth0', addresses: [{ address: '10.0.0.5', family: 'IPv4', netmask: '255.255.255.0' }] }],
      node: process.version,
      agentPid: process.pid,
      agentUid: 0,
    }),
    'user.create': ({ username, homeDir, shell }) => ({ username, uid: 30001, gid: 30001, home: homeDir, shell, gecos: '' }),
    'svc.status': ({ unit }) => ({ unit, installed: true, active: true, state: 'active', subState: 'running', enabled: true, pid: 4242, memoryBytes: 1024, restarts: 0 }),
  };
  const agent = {
    mode: 'mock',
    calls: [],
    names: () => agent.calls.map((c) => c.name),
    failOnce(name, err) { failures.set(name, err); },
    reset() { agent.calls.length = 0; failures.clear(); },
    async op(name, args = {}) {
      agent.calls.push({ name, args });
      if (failures.has(name)) {
        const err = failures.get(name);
        failures.delete(name);
        throw err;
      }
      return canned[name] ? canned[name](args) : {};
    },
    async ping() { return { pong: true, mode: 'mock' }; },
    async catalog() { return []; },
  };
  return agent;
}

// otplib verifies with a zero-step window, so avoid generating a code in the
// last moments of a 30-second step.
async function freshCode(secret) {
  if (authenticator.timeRemaining() < 3) await new Promise((r) => setTimeout(r, (authenticator.timeRemaining() + 0.5) * 1000));
  return authenticator.generate(secret);
}

let tmp;
let ctx;
let agent;
let root;
let csrf;

const login = (client, username, password) => client.post('/api/auth/login').send({ username, password });
const mutate = (client, method, url, body, token) => client[method](url).set('X-CSRF-Token', token).send(body);

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-api-'));
  agent = createMockAgent();
  ctx = await bootstrap({ dataDir: tmp, dbPath: path.join(tmp, 'whm.db'), adminPassword: ADMIN_PASSWORD, logLevel: 'silent', mode: 'monolithic', agent });
  root = request.agent(ctx.app);
}, 30_000);

afterAll(() => {
  ctx?.jobs.stop();
  ctx?.scheduler.stop();
  ctx?.sessionStore.close();
  ctx?.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('bootstrap', () => {
  it('seeds the root administrator and detects capabilities through the agent', () => {
    expect(ctx.db.prepare("SELECT username, role, must_change_password FROM users WHERE role = 'root'").get()).toEqual({ username: 'root', role: 'root', must_change_password: 0 });
    expect(fs.existsSync(path.join(tmp, 'master.key'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'initial-admin-password.txt'))).toBe(false);
    expect(agent.names()).toEqual(['sys.binaries', 'svc.list_units']);
    expect(ctx.capabilities.has('quota')).toBe(false);
    expect(ctx.capabilities.unitFor('httpd')).toBeNull();
  });
});

describe('public endpoints and the auth gate', () => {
  it('GET /api/health is public', async () => {
    const res = await root.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true, mode: 'monolithic' });
    expect(typeof res.body.data.version).toBe('string');
  });

  it('GET /api/system/status requires authentication', async () => {
    const res = await root.get('/api/system/status');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(res.body.data).toBeUndefined();
  });
});

describe('login', () => {
  it('rejects a wrong password', async () => {
    const res = await login(root, 'root', 'not-the-password');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects an invalid body with field errors', async () => {
    const res = await root.post('/api/auth/login').send({ username: 'Root' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.fields.username).toHaveLength(1);
    expect(res.body.error.fields.password).toHaveLength(1);
  });

  it('establishes a session for the right password', async () => {
    const res = await login(root, 'root', ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ username: 'root', role: 'root', mustChangePassword: false, totpEnabled: false });
    expect(res.body.data.requires2fa).toBeUndefined();
    expect(typeof res.body.data.csrfToken).toBe('string');
    expect(res.headers['set-cookie'].join(';')).toMatch(/whm\.sid=.*HttpOnly/);
    expect(res.headers['set-cookie'].join(';')).toMatch(/SameSite=Strict/);
    csrf = res.body.data.csrfToken;
  });

  it('GET /api/auth/me reflects the session', async () => {
    const res = await root.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.data.user.username).toBe('root');
    expect(res.body.data.csrfToken).toBe(csrf);
    expect(typeof res.body.data.hostname).toBe('string');
  });

  it('GET /api/system/status works once authenticated', async () => {
    const res = await root.get('/api/system/status');
    expect(res.status).toBe(200);
    expect(res.body.data.panel).toMatchObject({ name: 'WHM', mode: 'monolithic', node: process.version });
    expect(res.body.data.server.hostname).toBe('test-host');
    expect(res.body.data.mainIp).toBe('10.0.0.5');
    expect(res.body.data.counts).toMatchObject({ accounts: 0, suspended: 0, resellers: 0, domains: 0 });
    expect(res.body.data.capabilities.quota).toBe(false);
    expect(res.body.data.services.length).toBeGreaterThan(0);
    expect(res.body.data.services.every((s) => s.state === 'not-installed')).toBe(true);
  });

  it('unknown API routes return a JSON 404', async () => {
    const res = await root.get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('CSRF', () => {
  it('rejects a mutation without X-CSRF-Token', async () => {
    const res = await root.post('/api/packages').send({ name: 'csrf-test' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_failed');
    expect(ctx.db.prepare('SELECT 1 FROM packages WHERE name = ?').get('csrf-test')).toBeUndefined();
  });

  it('rejects a wrong token', async () => {
    const res = await mutate(root, 'post', '/api/packages', { name: 'csrf-test' }, 'x'.repeat(csrf.length));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_failed');
  });

  it('accepts the token issued at login', async () => {
    const res = await mutate(root, 'post', '/api/system/capabilities/refresh', {}, csrf);
    expect(res.status).toBe(200);
    expect(res.body.data.capabilities.quota.installed).toBe(false);
  });
});

describe('RBAC', () => {
  let reseller;
  let resellerCsrf;

  beforeAll(async () => {
    const hash = await ctx.crypto.hashPassword(RESELLER_PASSWORD);
    ctx.db.prepare("INSERT INTO users (username, role, password_hash) VALUES (?, 'reseller', ?)").run('resell1', hash);
    reseller = request.agent(ctx.app);
    const res = await login(reseller, 'resell1', RESELLER_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('reseller');
    resellerCsrf = res.body.data.csrfToken;
  }, 20_000);

  it('denies root-only routes to a reseller', async () => {
    const settings = await reseller.get('/api/system/settings');
    expect(settings.status).toBe(403);
    expect(settings.body.error.code).toBe('forbidden');
    const audit = await reseller.get('/api/system/audit');
    expect(audit.status).toBe(403);
    const fl = await mutate(reseller, 'post', '/api/packages/feature-lists', { name: 'rs', features: {} }, resellerCsrf);
    expect(fl.status).toBe(403);
  });

  it('lets root create accounts owned by a reseller or by root', async () => {
    const owned = await mutate(root, 'post', '/api/accounts', { username: 'rsacct', domain: 'rsacct.example.com', owner: 'resell1' }, csrf);
    expect(owned.status).toBe(201);
    expect(owned.body.data.owner).toBe('resell1');
    const mine = await mutate(root, 'post', '/api/accounts', { username: 'rootacct', domain: 'rootacct.example.com' }, csrf);
    expect(mine.status).toBe(201);
    expect(mine.body.data.owner).toBe('root');
    const ghost = await mutate(root, 'post', '/api/accounts', { username: 'ghostacct', domain: 'ghost.example.com', owner: 'nobody-here' }, csrf);
    expect(ghost.status).toBe(404);
  });

  it('filters account lists and reads by ownership', async () => {
    const all = await root.get('/api/accounts');
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(2);
    expect(all.body.data.map((a) => a.username).sort()).toEqual(['rootacct', 'rsacct']);

    const own = await reseller.get('/api/accounts');
    expect(own.status).toBe(200);
    expect(own.body.meta.total).toBe(1);
    expect(own.body.data[0].username).toBe('rsacct');

    const visible = await reseller.get('/api/accounts/rsacct');
    expect(visible.status).toBe(200);
    const hidden = await reseller.get('/api/accounts/rootacct');
    expect(hidden.status).toBe(403);
    expect(hidden.body.error.code).toBe('forbidden');
    const hiddenAction = await mutate(reseller, 'post', '/api/accounts/rootacct/suspend', {}, resellerCsrf);
    expect(hiddenAction.status).toBe(403);
  });

  it('ignores an owner override from a reseller', async () => {
    const res = await mutate(reseller, 'post', '/api/accounts', { username: 'rsacct2', domain: 'rsacct2.example.com', owner: 'root' }, resellerCsrf);
    expect(res.status).toBe(201);
    expect(res.body.data.owner).toBe('resell1');
    expect((await root.get('/api/accounts')).body.meta.total).toBe(3);
    expect((await reseller.get('/api/accounts')).body.meta.total).toBe(2);
  });
});

describe('packages', () => {
  it('creates and reads a package', async () => {
    const res = await mutate(root, 'post', '/api/packages', { name: 'starter', disk_mb: 2048, bandwidth_mb: 20480, max_domains: 3, has_shell: true }, csrf);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'starter', disk_mb: 2048, bandwidth_mb: 20480, max_domains: 3, has_shell: true, cgi: true, theme: 'jupiter', accounts: 0, feature_list: null, owner_id: null });

    const got = await root.get('/api/packages/starter');
    expect(got.status).toBe(200);
    expect(got.body.data.name).toBe('starter');

    const dup = await mutate(root, 'post', '/api/packages', { name: 'starter' }, csrf);
    expect(dup.status).toBe(409);
    const bad = await mutate(root, 'post', '/api/packages', { name: 'starter', disk_mb: -1 }, csrf);
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields.disk_mb).toHaveLength(1);
  });

  it('lists with pagination meta and a q filter', async () => {
    const all = await root.get('/api/packages');
    expect(all.status).toBe(200);
    expect(all.body.meta).toMatchObject({ page: 1, pageSize: 50 });
    expect(all.body.meta.total).toBeGreaterThanOrEqual(2);
    expect(all.body.data.map((p) => p.name)).toContain('default');

    const filtered = await root.get('/api/packages?q=start');
    expect(filtered.body.meta.total).toBe(1);
    expect(filtered.body.data[0].name).toBe('starter');
    expect(filtered.body.data[0].accounts).toBe(0);
  });

  it('updates limits and renames', async () => {
    const res = await mutate(root, 'put', '/api/packages/starter', { newName: 'starter-v2', disk_mb: 4096, feature_list: 'default' }, csrf);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'starter-v2', disk_mb: 4096, bandwidth_mb: 20480, has_shell: true, feature_list: 'default' });
    expect((await root.get('/api/packages/starter')).status).toBe(404);
    expect((await root.get('/api/packages/starter-v2')).body.data.disk_mb).toBe(4096);

    const clash = await mutate(root, 'put', '/api/packages/starter-v2', { newName: 'default' }, csrf);
    expect(clash.status).toBe(409);
    const missingFl = await mutate(root, 'put', '/api/packages/starter-v2', { feature_list: 'nope' }, csrf);
    expect(missingFl.status).toBe(404);
  });

  it('manages feature lists and protects the built-in ones', async () => {
    const list = await root.get('/api/packages/feature-lists');
    expect(list.status).toBe(200);
    expect(list.body.data.map((f) => f.name)).toEqual(expect.arrayContaining(['default', 'disabled']));
    expect(list.body.data.find((f) => f.name === 'default').features.mysql).toBe(true);

    const created = await mutate(root, 'post', '/api/packages/feature-lists', { name: 'custom', features: { mysql: true, ssh: false } }, csrf);
    expect(created.status).toBe(200);
    expect(created.body.data).toEqual({ name: 'custom', features: { mysql: true, ssh: false } });
    expect((await mutate(root, 'post', '/api/packages/feature-lists', { name: 'custom', features: {} }, csrf)).status).toBe(409);
    expect((await mutate(root, 'post', '/api/packages/feature-lists', { name: 'custom', features: { mysql: 'yes' } }, csrf)).status).toBe(422);

    const updated = await mutate(root, 'put', '/api/packages/feature-lists/custom', { features: { mysql: false } }, csrf);
    expect(updated.status).toBe(200);
    expect((await root.get('/api/packages/feature-lists/custom')).body.data.features).toEqual({ mysql: false });

    for (const builtIn of ['default', 'disabled']) {
      const res = await mutate(root, 'delete', `/api/packages/feature-lists/${builtIn}`, undefined, csrf);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
    }

    const inUsePkg = await mutate(root, 'post', '/api/packages', { name: 'tmp-pkg', feature_list: 'custom' }, csrf);
    expect(inUsePkg.status).toBe(201);
    expect(inUsePkg.body.data.feature_list).toBe('custom');
    expect((await mutate(root, 'delete', '/api/packages/feature-lists/custom', undefined, csrf)).status).toBe(409);

    expect((await mutate(root, 'delete', '/api/packages/tmp-pkg', undefined, csrf)).body.data).toEqual({ deleted: true });
    const removed = await mutate(root, 'delete', '/api/packages/feature-lists/custom', undefined, csrf);
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ deleted: true });
    expect((await root.get('/api/packages/feature-lists/custom')).status).toBe(404);
  });

  it('refuses to delete a package in use and deletes an unused one', async () => {
    const inUse = await mutate(root, 'delete', '/api/packages/default', undefined, csrf);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.message).toMatch(/in use/);
    expect((await root.get('/api/packages/default')).body.data.accounts).toBe(3);

    expect((await mutate(root, 'post', '/api/packages', { name: 'unused' }, csrf)).status).toBe(201);
    const removed = await mutate(root, 'delete', '/api/packages/unused', undefined, csrf);
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ deleted: true });
    expect((await root.get('/api/packages/unused')).status).toBe(404);
    expect((await mutate(root, 'delete', '/api/packages/unused', undefined, csrf)).status).toBe(404);
  });
});

describe('accounts', () => {
  it('provisions a system user and home tree through the agent in order', async () => {
    agent.reset();
    const res = await mutate(root, 'post', '/api/accounts', { username: 'web01', domain: 'Web01.Example.com', password: ACCOUNT_PASSWORD, contactEmail: 'owner@example.com' }, csrf);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      username: 'web01', domain: 'web01.example.com', owner: 'root', package_name: 'default', uid: 30001, gid: 30001, home_dir: '/home/web01',
      shell: '/usr/sbin/nologin', suspended: false, systemUser: true, contact_email: 'owner@example.com', disk_quota_mb: 10240,
    });
    expect(res.body.data.plan.disk_mb).toBe(10240);
    expect(res.body.data.plan_snapshot_json).toBeUndefined();
    expect(res.body.data.domains).toEqual([expect.objectContaining({ domain: 'web01.example.com', type: 'main', docroot: '/home/web01/public_html' })]);
    expect(res.body.data.provisioning.systemUser).toBe(true);

    expect(agent.names()).toEqual(['user.create', 'fs.mkdir', 'fs.mkdir', 'fs.mkdir', 'fs.mkdir', 'fs.mkdir', 'fs.mkdir', 'fs.write_file', 'user.set_password']);
    expect(agent.calls[0].args).toEqual({ username: 'web01', homeDir: '/home/web01', shell: '/usr/sbin/nologin', comment: 'WHM account web01.example.com' });
    expect(agent.calls.slice(1, 7).map((c) => c.args.path)).toEqual(['public_html', 'mail', 'etc', 'tmp', 'logs', 'ssl'].map((s) => `/home/web01/${s}`));
    expect(agent.calls.slice(1, 7).map((c) => c.args.mode)).toEqual(['0750', '0700', '0700', '0700', '0700', '0700']);
    expect(agent.calls.slice(1, 7).every((c) => c.args.owner === 'web01')).toBe(true);
    expect(agent.calls[7].args).toMatchObject({ path: '/home/web01/public_html/index.html', owner: 'web01', mode: '0644', backup: false });
    expect(agent.calls[7].args.content).toContain('web01.example.com');
    expect(agent.calls[8].args).toEqual({ username: 'web01', password: ACCOUNT_PASSWORD });
  });

  it('skips the password op when no password is given', async () => {
    agent.reset();
    const res = await mutate(root, 'post', '/api/accounts', { username: 'nopass', domain: 'nopass.example.com', package: 'starter-v2' }, csrf);
    expect(res.status).toBe(201);
    expect(res.body.data.shell).toBe('/bin/bash');
    expect(res.body.data.package_name).toBe('starter-v2');
    expect(agent.names()).not.toContain('user.set_password');
    expect(agent.names().filter((n) => n === 'fs.mkdir')).toHaveLength(6);
    expect((await mutate(root, 'delete', '/api/accounts/nopass', undefined, csrf)).status).toBe(200);
  });

  it('rejects duplicates, reserved names and unknown packages', async () => {
    const dupUser = await mutate(root, 'post', '/api/accounts', { username: 'web01', domain: 'other.example.com' }, csrf);
    expect(dupUser.status).toBe(409);
    expect(dupUser.body.error.code).toBe('conflict');
    const dupDomain = await mutate(root, 'post', '/api/accounts', { username: 'web02', domain: 'web01.example.com' }, csrf);
    expect(dupDomain.status).toBe(409);
    const reserved = await mutate(root, 'post', '/api/accounts', { username: 'root', domain: 'root.example.com' }, csrf);
    expect(reserved.status).toBe(400);
    expect(reserved.body.error.code).toBe('bad_request');
    const noPkg = await mutate(root, 'post', '/api/accounts', { username: 'web03', domain: 'web03.example.com', package: 'missing' }, csrf);
    expect(noPkg.status).toBe(404);
    const invalid = await mutate(root, 'post', '/api/accounts', { username: '-r', domain: 'nope', password: 'short' }, csrf);
    expect(invalid.status).toBe(422);
    expect(Object.keys(invalid.body.error.fields).sort()).toEqual(['domain', 'password', 'username']);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n).toBe(4);
  });

  it('suspends and unsuspends through user.lock / user.unlock', async () => {
    agent.reset();
    const suspended = await mutate(root, 'post', '/api/accounts/web01/suspend', { reason: 'nonpayment' }, csrf);
    expect(suspended.status).toBe(200);
    expect(suspended.body.data).toMatchObject({ username: 'web01', suspended: true, suspend_reason: 'nonpayment' });
    expect(suspended.body.data.suspended_at).toBeTruthy();
    expect(agent.calls).toEqual([{ name: 'user.lock', args: { username: 'web01' } }]);

    const again = await mutate(root, 'post', '/api/accounts/web01/suspend', {}, csrf);
    expect(again.status).toBe(409);
    expect((await root.get('/api/accounts?suspended=true')).body.data.map((a) => a.username)).toEqual(['web01']);

    agent.reset();
    const unsuspended = await mutate(root, 'post', '/api/accounts/web01/unsuspend', undefined, csrf);
    expect(unsuspended.status).toBe(200);
    expect(unsuspended.body.data).toMatchObject({ suspended: false, suspend_reason: null, suspended_at: null });
    expect(agent.calls).toEqual([{ name: 'user.unlock', args: { username: 'web01' } }]);
    expect((await mutate(root, 'post', '/api/accounts/web01/unsuspend', undefined, csrf)).status).toBe(409);
  });

  it('changes the package and updates the plan snapshot and shell', async () => {
    agent.reset();
    const res = await mutate(root, 'patch', '/api/accounts/web01', { package: 'starter-v2', contactEmail: 'new@example.com' }, csrf);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ package_name: 'starter-v2', disk_quota_mb: 4096, bandwidth_limit_mb: 20480, shell: '/bin/bash', contact_email: 'new@example.com' });
    expect(res.body.data.plan).toMatchObject({ disk_mb: 4096, has_shell: true });
    expect(agent.calls).toEqual([{ name: 'user.set_shell', args: { username: 'web01', shell: '/bin/bash' } }]);
    expect((await root.get('/api/packages/starter-v2')).body.data.accounts).toBe(1);

    const unknown = await mutate(root, 'patch', '/api/accounts/web01', { package: 'missing' }, csrf);
    expect(unknown.status).toBe(404);
    const extra = await mutate(root, 'patch', '/api/accounts/web01', { bogus: 1 }, csrf);
    expect(extra.status).toBe(422);
  });

  it('sets the password through user.set_password', async () => {
    agent.reset();
    const res = await mutate(root, 'post', '/api/accounts/web01/password', { password: 'New-Secret-456' }, csrf);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ username: 'web01' });
    expect(agent.calls).toEqual([{ name: 'user.set_password', args: { username: 'web01', password: 'New-Secret-456' } }]);
    expect((await mutate(root, 'post', '/api/accounts/web01/password', { password: 'short' }, csrf)).status).toBe(422);
  });

  it('lists domains for an account', async () => {
    const res = await root.get('/api/accounts/web01/domains');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ domain: 'web01.example.com', type: 'main' })]);
  });

  it('terminates through user.delete and then 404s', async () => {
    agent.reset();
    const res = await mutate(root, 'delete', '/api/accounts/web01', undefined, csrf);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ username: 'web01', domain: 'web01.example.com', terminated: true });
    expect(agent.calls).toEqual([{ name: 'user.delete', args: { username: 'web01', removeHome: true } }]);
    expect((await root.get('/api/accounts/web01')).status).toBe(404);
    expect((await mutate(root, 'delete', '/api/accounts/web01', undefined, csrf)).status).toBe(404);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM account_domains WHERE domain = ?').get('web01.example.com').n).toBe(0);
  });
});

describe('rollback', () => {
  it('compensates with user.delete and leaves no account row when provisioning fails', async () => {
    agent.reset();
    agent.failOnce('fs.mkdir', new AgentError('command_failed', '"mkdir" exited with status 1: disk full'));
    const res = await mutate(root, 'post', '/api/accounts', { username: 'rollback1', domain: 'rollback1.example.com', password: ACCOUNT_PASSWORD }, csrf);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe('command_failed');
    expect(agent.names()).toEqual(['user.create', 'fs.mkdir', 'user.delete']);
    expect(agent.calls[2].args).toEqual({ username: 'rollback1', removeHome: true });
    expect(ctx.db.prepare('SELECT 1 FROM accounts WHERE username = ?').get('rollback1')).toBeUndefined();
    expect(ctx.db.prepare('SELECT 1 FROM account_domains WHERE domain = ?').get('rollback1.example.com')).toBeUndefined();
    expect((await root.get('/api/accounts/rollback1')).status).toBe(404);
  });

  it('does not roll back a system user it never created', async () => {
    agent.reset();
    agent.failOnce('user.create', new AgentError('exists', 'Linux user "rollback2" already exists'));
    const res = await mutate(root, 'post', '/api/accounts', { username: 'rollback2', domain: 'rollback2.example.com' }, csrf);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('exists');
    expect(agent.names()).toEqual(['user.create']);
    expect(ctx.db.prepare('SELECT 1 FROM accounts WHERE username = ?').get('rollback2')).toBeUndefined();
  });
});

describe('audit log', () => {
  it('records semantic entries and redacts secrets from request bodies', async () => {
    const res = await root.get('/api/system/audit?pageSize=500');
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBeGreaterThan(10);
    const entries = res.body.data;

    const created = entries.filter((e) => e.action === 'account.create');
    expect(created.map((e) => e.target)).toEqual(expect.arrayContaining(['web01', 'rsacct', 'rootacct']));
    expect(created.every((e) => e.principal && e.role && e.result === 'ok')).toBe(true);
    expect(JSON.parse(created.find((e) => e.target === 'web01').args_redacted)).toMatchObject({ domain: 'web01.example.com', package: 'default' });

    const posts = entries.filter((e) => e.action === 'POST /api/accounts');
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const entry of posts) {
      expect(entry.args_redacted).not.toContain(ACCOUNT_PASSWORD);
      expect(entry.args_redacted).not.toContain('New-Secret-456');
    }
    const withPassword = posts.find((e) => e.args_redacted.includes('"username":"web01"') && e.args_redacted.includes('"password"'));
    expect(withPassword.args_redacted).toContain('[redacted]');
    expect(JSON.parse(withPassword.args_redacted).password).toBe('[redacted]');
    expect(withPassword.principal).toBe('root');

    const passwordChange = entries.find((e) => e.action === 'POST /api/accounts/:username/password');
    expect(passwordChange.target).toBe('web01');
    expect(passwordChange.args_redacted).toContain('[redacted]');
    expect(passwordChange.args_redacted).not.toContain('New-Secret-456');

    const failed = entries.find((e) => e.action === 'POST /api/accounts' && e.args_redacted.includes('rollback1'));
    expect(failed.result).toBe('error:500');
    expect(failed.args_redacted).not.toContain(ACCOUNT_PASSWORD);
    const denied = entries.find((e) => e.action === 'POST /api/accounts/:username/suspend' && e.result === 'error:403');
    expect(denied).toMatchObject({ principal: 'resell1', role: 'reseller', target: 'rootacct' });
    const notFound = entries.find((e) => e.action === 'POST /api/accounts' && e.args_redacted.includes('ghostacct'));
    expect(notFound.result).toBe('error:404');
    expect(entries.find((e) => e.action === 'DELETE /api/packages/:name' && e.target === 'default')).toMatchObject({ result: 'error:409' });
    expect(entries.find((e) => e.action === 'DELETE /api/packages/:name' && e.target === 'unused' && e.result === 'ok')).toBeTruthy();
    expect(entries.some((e) => e.action === 'account.terminate' && e.target === 'web01')).toBe(true);
    expect(entries.some((e) => e.action === 'account.suspend' && e.target === 'web01')).toBe(true);
    expect(entries.some((e) => e.action === 'auth.login' && e.target === 'root')).toBe(true);
  });

  it('filters by action prefix and principal', async () => {
    const byAction = await root.get('/api/system/audit?action=account.&pageSize=100');
    expect(byAction.body.data.length).toBeGreaterThan(0);
    expect(byAction.body.data.every((e) => e.action.startsWith('account.'))).toBe(true);
    const byPrincipal = await root.get('/api/system/audit?principal=resell1&pageSize=100');
    expect(byPrincipal.body.data.length).toBeGreaterThan(0);
    expect(byPrincipal.body.data.every((e) => e.principal === 'resell1')).toBe(true);
    const logins = await root.get('/api/system/audit/logins');
    expect(logins.status).toBe(200);
    expect(logins.body.data.some((l) => l.username === 'root' && l.ok === 0)).toBe(true);
  });
});

describe('settings', () => {
  it('updates and reads settings by prefix', async () => {
    const put = await mutate(root, 'put', '/api/system/settings', { 'basic.contact_email': 'a@b.co', 'tweak.max_emails_per_hour': 500 }, csrf);
    expect(put.status).toBe(200);
    expect(put.body.data['basic.contact_email']).toBe('a@b.co');
    expect(put.body.data['tweak.max_emails_per_hour']).toBe(500);

    const get = await root.get('/api/system/settings?prefix=basic');
    expect(get.status).toBe(200);
    expect(get.body.data['basic.contact_email']).toBe('a@b.co');
    expect(get.body.data['basic.home_root']).toBe('/home');
    expect(Object.keys(get.body.data).every((k) => k.startsWith('basic.'))).toBe(true);
    expect(get.body.data['tweak.max_emails_per_hour']).toBeUndefined();
    expect(ctx.settings.get('basic.contact_email')).toBe('a@b.co');

    const bad = await mutate(root, 'put', '/api/system/settings', { 'Bad Key': 1 }, csrf);
    expect(bad.status).toBe(422);
  });
});

describe('jobs', () => {
  let job;

  beforeAll(() => {
    ctx.jobs.register('test.echo', async (c) => {
      c.progress(50, 'half');
      c.log('hi');
      return { ok: true, echo: c.params };
    });
    ctx.jobs.start();
    job = ctx.jobs.enqueue('test.echo', { x: 1 });
  });

  it('runs a job and exposes status, result and logs over the API', async () => {
    let data;
    for (let i = 0; i < 30; i++) {
      const res = await root.get(`/api/system/jobs/${job.id}`);
      expect(res.status).toBe(200);
      data = res.body.data;
      if (['done', 'failed', 'cancelled'].includes(data.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(data.status).toBe('done');
    expect(data.progress).toBe(100);
    expect(data.result).toEqual({ ok: true, echo: { x: 1 } });
    expect(data.params).toEqual({ x: 1 });
    expect(data.logs.map((l) => l.line)).toContain('hi');
    expect(data.error).toBeNull();
  }, 10_000);

  it('lists jobs and rejects cancelling a finished one', async () => {
    const list = await root.get('/api/system/jobs?type=test.echo');
    expect(list.status).toBe(200);
    expect(list.body.data.map((j) => j.id)).toContain(job.id);
    expect((await root.get('/api/system/jobs?status=queued')).body.data).toEqual([]);
    expect((await root.get('/api/system/jobs/999999')).status).toBe(404);
    const cancel = await mutate(root, 'post', `/api/system/jobs/${job.id}/cancel`, {}, csrf);
    expect(cancel.status).toBe(400);
  });

  it('streams a snapshot for a finished job', async () => {
    const res = await root.get(`/api/system/jobs/${job.id}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"snapshot"');
    expect(res.text).toContain('"status":"done"');
  });

  it('exposes schedules to root', async () => {
    ctx.scheduler.ensure('test.echo.schedule', '0 3 * * *', 'test.echo', { nightly: true });
    const list = await root.get('/api/system/schedules');
    expect(list.status).toBe(200);
    expect(list.body.data.find((s) => s.name === 'test.echo.schedule')).toMatchObject({ cron: '0 3 * * *', job_type: 'test.echo', enabled: 1, params: { nightly: true } });
    const updated = await mutate(root, 'patch', '/api/system/schedules/test.echo.schedule', { cron: '30 4 * * *', enabled: false }, csrf);
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ cron: '30 4 * * *', enabled: 0 });
    expect((await mutate(root, 'patch', '/api/system/schedules/test.echo.schedule', { cron: 'nope' }, csrf)).status).toBe(422);
  });
});

describe('logout', () => {
  it('destroys the session', async () => {
    const res = await mutate(root, 'post', '/api/auth/logout', undefined, csrf);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ loggedOut: true, username: 'root' });
    const me = await root.get('/api/auth/me');
    expect(me.status).toBe(401);
    expect((await root.get('/api/system/status')).status).toBe(401);
  });
});

describe('two-factor authentication', () => {
  let secret;

  it('enrolls and confirms with a valid code', async () => {
    const session = await login(root, 'root', ADMIN_PASSWORD);
    expect(session.status).toBe(200);
    csrf = session.body.data.csrfToken;

    const enroll = await mutate(root, 'post', '/api/auth/2fa/enroll', undefined, csrf);
    expect(enroll.status).toBe(200);
    secret = enroll.body.data.secret;
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(enroll.body.data.otpauthUrl.startsWith('otpauth://totp/')).toBe(true);
    expect(enroll.body.data.otpauthUrl).toContain(`secret=${secret}`);
    expect((await root.get('/api/auth/me')).body.data.user.totpEnabled).toBe(false);

    const bad = await mutate(root, 'post', '/api/auth/2fa/confirm', { code: '12' }, csrf);
    expect(bad.status).toBe(422);
    const confirm = await mutate(root, 'post', '/api/auth/2fa/confirm', { code: await freshCode(secret) }, csrf);
    expect(confirm.status).toBe(200);
    expect(confirm.body.data).toEqual({ enabled: true });
    expect((await root.get('/api/auth/me')).body.data.user.totpEnabled).toBe(true);
    const stored = ctx.db.prepare('SELECT totp_secret_enc, totp_enabled FROM users WHERE username = ?').get('root');
    expect(stored.totp_enabled).toBe(1);
    expect(stored.totp_secret_enc).not.toContain(secret);
    expect(ctx.crypto.decrypt(stored.totp_secret_enc)).toBe(secret);
  }, 15_000);

  it('requires a code on the next login before the session is established', async () => {
    expect((await mutate(root, 'post', '/api/auth/logout', undefined, csrf)).status).toBe(200);

    const pending = await login(root, 'root', ADMIN_PASSWORD);
    expect(pending.status).toBe(200);
    expect(pending.body.data).toEqual({ requires2fa: true });
    expect((await root.get('/api/auth/me')).status).toBe(401);

    const code = await freshCode(secret);
    const wrongCode = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    const wrong = await root.post('/api/auth/2fa').send({ code: wrongCode });
    expect(wrong.status).toBe(401);
    expect((await root.get('/api/auth/me')).status).toBe(401);

    const verified = await root.post('/api/auth/2fa').send({ code });
    expect(verified.status).toBe(200);
    expect(verified.body.data.user).toMatchObject({ username: 'root', totpEnabled: true });
    expect(typeof verified.body.data.csrfToken).toBe('string');
    csrf = verified.body.data.csrfToken;

    const me = await root.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.username).toBe('root');
    expect((await root.post('/api/auth/2fa').send({ code })).status).toBe(400);
  }, 15_000);

  it('changes the password, invalidates other sessions and keeps 2FA', async () => {
    const other = request.agent(ctx.app);
    expect((await login(other, 'root', ADMIN_PASSWORD)).body.data.requires2fa).toBe(true);
    expect((await other.post('/api/auth/2fa').send({ code: await freshCode(secret) })).status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(200);

    const wrongCurrent = await mutate(root, 'post', '/api/auth/password', { currentPassword: 'nope', newPassword: 'Another-Passw0rd!2' }, csrf);
    expect(wrongCurrent.status).toBe(403);
    const changed = await mutate(root, 'post', '/api/auth/password', { currentPassword: ADMIN_PASSWORD, newPassword: 'Another-Passw0rd!2' }, csrf);
    expect(changed.status).toBe(200);
    expect(changed.body.data.user.username).toBe('root');
    csrf = changed.body.data.csrfToken;
    expect((await root.get('/api/auth/me')).status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);

    expect((await login(other, 'root', ADMIN_PASSWORD)).status).toBe(401);
    expect((await login(other, 'root', 'Another-Passw0rd!2')).body.data).toEqual({ requires2fa: true });

    const disable = await mutate(root, 'post', '/api/auth/2fa/disable', undefined, csrf);
    expect(disable.status).toBe(200);
    expect(disable.body.data).toEqual({ enabled: false });
    expect((await root.get('/api/auth/me')).body.data.user.totpEnabled).toBe(false);
  }, 20_000);
});
