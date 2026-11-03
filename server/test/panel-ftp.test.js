import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { errorHandler, notFoundHandler } from '../src/middleware/error.js';
import { HttpError } from '../src/lib/errors.js';
import { register } from '../src/routes/panel/ftp.js';
import { loginFor, resolveUnderHome, filezillaXml } from '../src/services/panel-ftp.js';

// A host whose FTP daemon is switchable between pure-ftpd, proftpd and vsftpd;
// virtual-user support per daemon is a flag the tests flip. Every ftp.* op
// records its input and answers like the real agent would, nothing runs.
function ftpAgent() {
  const state = { daemon: 'pure-ftpd', virtual: { 'pure-ftpd': true, proftpd: true }, users: new Map(), fail: null };
  const failWith = (code, message) => Object.assign(new Error(message), { agentError: true, code, details: {} });
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['pure-pw', 'ftpasswd', 'pure-ftpd', 'systemctl', 'useradd', 'usermod', 'userdel'].includes(n)])),
    'svc.list_units': () => [state.daemon],
    'web.service.detect': () => ({ role: 'ftp', candidates: ['pure-ftpd', 'proftpd', 'vsftpd'].map((name) => ({ name, installed: name === state.daemon, unitName: name === state.daemon ? name : null, unit: { active: name === state.daemon, enabled: name === state.daemon } })), active: [state.daemon], enabled: [state.daemon], current: state.daemon, packageManager: 'apt-get' }),
    'web.ftp.config.read': ({ server }) => ({ server, path: `/etc/${server}`, unit: { active: true }, settings: { tls: 'optional' }, raw: {} }),
    'ftp.virtual.status': ({ daemon }) => (daemon === 'vsftpd' ? { daemon, supported: false, enabled: false, hint: 'system users only' } : { daemon, supported: true, enabled: Boolean(state.virtual[daemon]), configured: Boolean(state.virtual[daemon]), passwdFile: `/etc/${daemon}/passwd`, hint: state.virtual[daemon] ? null : 'Enable PureDB' }),
    'ftp.user.add': (args) => { if (state.fail === 'add') throw failWith('command_failed', 'pure-pw: disk full'); if (state.users.has(args.login)) throw failWith('exists', 'exists'); state.users.set(args.login, args); return { daemon: args.daemon, login: args.login, username: args.username, uid: 30001, gid: 30001, dir: args.dir, quotaMb: args.quotaMb }; },
    'ftp.user.passwd': ({ login }) => { if (!state.users.has(login)) throw failWith('not_found', 'no such login'); return { login, changed: true }; },
    'ftp.user.set_quota': ({ daemon, login, quotaMb }) => { if (daemon !== 'pure-ftpd') throw failWith('unsupported', 'no quota on proftpd'); state.users.get(login).quotaMb = quotaMb; return { login, quotaMb }; },
    'ftp.user.remove': ({ login }) => ({ login, removed: state.users.delete(login) }),
    'ftp.sync': ({ daemon }) => ({ daemon, synced: true }),
    'files.mkdir': ({ path }) => ({ path }),
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
      return { account, accountId: account.id, username, mode: 'user', actor: req.user, actingAs: null, owner, ownerPrincipal: { id: owner.id, username: owner.username, role: owner.role }, limits: {}, features: account.plan?.features || {} };
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

function setPlan(app, username, patch) {
  const row = app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username);
  const plan = JSON.parse(row.plan_snapshot_json || '{}');
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(typeof patch === 'function' ? patch(plan) : { ...plan, ...patch }), username);
}

describe('panel ftp helpers', () => {
  it('derives logins per daemon and pins directories under the home', () => {
    const account = { username: 'alice', domain: 'alice.com' };
    expect(loginFor('pure-ftpd', 'shop', account)).toBe('shop@alice.com');
    expect(loginFor('proftpd', 'shop', account)).toBe('shop_alice');
    expect(resolveUnderHome('/home/alice', 'public_html/shop')).toBe('/home/alice/public_html/shop');
    expect(resolveUnderHome('/home/alice', '/public_html')).toBe('/home/alice/public_html');
    expect(resolveUnderHome('/home/alice', '.')).toBe('/home/alice');
    expect(() => resolveUnderHome('/home/alice', '../bob')).toThrow(/inside the account home/);
    expect(() => resolveUnderHome('/home/alice', 'x/../../bob')).toThrow(/inside the account home/);
  });

  it('renders a FileZilla import without any password and with escaped fields', () => {
    const xml = filezillaXml({ name: 'a <b>', host: 'ftp.alice.com', port: 21, login: 'shop@alice.com', protocol: 'ftp', encryption: 'required' });
    expect(xml).toContain('<User>shop@alice.com</User>');
    expect(xml).toContain('<Name>a &lt;b&gt;</Name>');
    expect(xml).toContain('<Encryption>4</Encryption>');
    expect(xml).not.toMatch(/<Pass>|password/i);
  });
});

describe('/api/panel/ftp', () => {
  let app;
  let api;
  let csrf;
  const as = (user) => ({ 'X-Panel-Account': user });
  const get = (p, user = 'alice') => api.get(`/api/panel/ftp${p}`).set(as(user));
  const post = (p, body = {}, user = 'alice') => api.post(`/api/panel/ftp${p}`).set(as(user)).send(body);
  const put = (p, body = {}, user = 'alice') => api.put(`/api/panel/ftp${p}`).set(as(user)).send(body);
  const del = (p, user = 'alice') => api.delete(`/api/panel/ftp${p}`).set(as(user));
  const good = { login: 'shop', password: 'S3cret-pass!', dir: 'public_html/shop', quotaMb: 500 };

  beforeAll(async () => {
    app = await createTestApp({ agent: ftpAgent() });
    csrf = await app.login();
    await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', owner: 'resell1' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com' }).expect(201);
    stubPanel(app.ctx);
    api = await panelApp(app, register);
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; app.agent.state.fail = null; });

  it('refuses without a pinned account, the panel service or the token scope', async () => {
    expect((await api.get('/api/panel/ftp/accounts').expect(403)).body.error.code).toBe('no_account');
    const panel = app.ctx.panel;
    delete app.ctx.panel;
    try { expect((await get('/accounts').expect(403)).body.error.code).toBe('panel_scope_required'); } finally { app.ctx.panel = panel; }
    await get('/accounts').set('X-Token-Scopes', 'panel:read').expect(403);
    await get('/accounts').set('X-Token-Scopes', 'panel:files').expect(200);
  });

  it('lists the daemon, support state and the read-only main login', async () => {
    const res = await get('/accounts').expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ daemon: 'pure-ftpd', supported: true, supportedDaemon: true, virtualUsersEnabled: true, mainLogin: 'alice', port: 21, protocol: 'ftp', quota: { max: 10, used: 0, remaining: 10 } });
    expect(res.body.meta.host).toBeTruthy();
  });

  it('creates a pure-ftpd login <name>@<domain> with the directory pinned under the home and the password only in the op input', async () => {
    const res = await post('/accounts', good).expect(201);
    expect(res.body.data).toMatchObject({ name: 'shop', login: 'shop@alice.com', daemon: 'pure-ftpd', dir: '/home/alice/public_html/shop', quotaMb: 500 });
    expect(res.body.data).not.toHaveProperty('password');
    const names = app.agent.calls.map((c) => c.name).filter((n) => !['sys.binaries', 'web.service.detect', 'web.ftp.config.read', 'ftp.virtual.status', 'svc.list_units'].includes(n));
    expect(names).toEqual(['files.mkdir', 'ftp.user.add', 'ftp.sync']);
    expect(app.agent.callsTo('files.mkdir')[0].args).toEqual({ username: 'alice', path: '/home/alice/public_html/shop', mode: '0755' });
    const add = app.agent.callsTo('ftp.user.add')[0].args;
    expect(add).toEqual({ daemon: 'pure-ftpd', login: 'shop@alice.com', password: 'S3cret-pass!', username: 'alice', dir: '/home/alice/public_html/shop', quotaMb: 500 });
    for (const key of ['uid', 'gid', 'home']) expect(add).not.toHaveProperty(key);
    const audit = app.ctx.db.prepare("SELECT target, args_redacted FROM audit_log WHERE action = 'panel.ftp.create' ORDER BY id DESC LIMIT 1").get();
    expect(audit.target).toBe('alice');
    expect(audit.args_redacted).not.toContain('S3cret');
    expect(JSON.parse(audit.args_redacted)).toMatchObject({ login: 'shop@alice.com', dir: 'public_html/shop' });
    const row = app.ctx.db.prepare('SELECT * FROM ftp_accounts WHERE login = ?').get('shop@alice.com');
    expect(row).toMatchObject({ name: 'shop', daemon: 'pure-ftpd', quota_mb: 500 });
  });

  it('rejects traversal, absolute escapes, bad logins and weak bodies before any op runs', async () => {
    for (const dir of ['../bob', 'public_html/../../bob', '-rf', 'a\0b', 'x'.repeat(513)]) {
      const res = await post('/accounts', { ...good, login: 'esc', dir }).expect(422);
      expect(res.body.error.fields.dir, dir).toBeDefined();
    }
    for (const login of ['Shop', '-x', 'a b', 'a@b', 'a:b', '', 'x'.repeat(33)]) {
      const res = await post('/accounts', { ...good, login }).expect(422);
      expect(res.body.error.fields.login, login).toBeDefined();
    }
    await post('/accounts', { ...good, login: 'x', password: 'short' }).expect(422);
    await post('/accounts', { ...good, login: 'x', uid: 0 }).expect(422);
    expect(app.agent.callsTo('ftp.user.add')).toHaveLength(0);
    const abs = await post('/accounts', { ...good, login: 'abs', dir: '/etc/passwd' }).expect(201);
    expect(abs.body.data.dir).toBe('/home/alice/etc/passwd');
    await del(`/accounts/${abs.body.data.id}`).expect(200);
  });

  it('enforces max_ftp (409 limit_reached), duplicate names (409) and the ftpaccts feature (403)', async () => {
    setPlan(app, 'alice', { max_ftp: 1 });
    try {
      const res = await post('/accounts', { ...good, login: 'second' }).expect(409);
      expect(res.body.error.code).toBe('limit_reached');
    } finally { setPlan(app, 'alice', { max_ftp: 10 }); }
    expect((await post('/accounts', good).expect(409)).body.error.code).toBe('conflict');
    expect(app.agent.callsTo('ftp.user.add')).toHaveLength(0);
    setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), ftpaccts: false } }));
    try {
      expect((await get('/accounts').expect(403)).body.error.code).toBe('feature_disabled');
      expect((await post('/accounts', { ...good, login: 'gated' }).expect(403)).body.error.code).toBe('feature_disabled');
    } finally { setPlan(app, 'alice', (p) => ({ ...p, features: { ...(p.features || {}), ftpaccts: true } })); }
  });

  it('keeps every account to its own rows', async () => {
    const bob = await post('/accounts', { ...good, login: 'shop' }, 'bob').expect(201);
    expect(bob.body.data.login).toBe('shop@bob.com');
    const list = await get('/accounts').expect(200);
    expect(list.body.data.map((a) => a.login)).toEqual(['shop@alice.com']);
    await put(`/accounts/${bob.body.data.id}/password`, { password: 'An0ther-pass!' }).expect(404);
    await put(`/accounts/${bob.body.data.id}/quota`, { quotaMb: 1 }).expect(404);
    await get(`/accounts/${bob.body.data.id}/client-config`).expect(404);
    await del(`/accounts/${bob.body.data.id}`).expect(404);
    expect(app.agent.callsTo('ftp.user.passwd')).toHaveLength(0);
    expect(app.agent.callsTo('ftp.user.remove')).toHaveLength(0);
    expect(app.ctx.db.prepare('SELECT 1 FROM ftp_accounts WHERE id = ?').get(bob.body.data.id)).toBeTruthy();
    await del(`/accounts/${bob.body.data.id}`, 'bob').expect(200);
  });

  it('changes passwords and quotas, produces client settings, and removes logins', async () => {
    const row = app.ctx.db.prepare("SELECT id FROM ftp_accounts WHERE login = 'shop@alice.com'").get();
    await put(`/accounts/${row.id}/password`, { password: 'An0ther-pass!' }).expect(200);
    expect(app.agent.callsTo('ftp.user.passwd')[0].args).toEqual({ daemon: 'pure-ftpd', login: 'shop@alice.com', password: 'An0ther-pass!' });
    const quota = await put(`/accounts/${row.id}/quota`, { quotaMb: null }).expect(200);
    expect(quota.body.data.quotaMb).toBeNull();
    expect(app.agent.callsTo('ftp.user.set_quota')[0].args).toEqual({ daemon: 'pure-ftpd', login: 'shop@alice.com', quotaMb: null });
    const cfg = await get(`/accounts/${row.id}/client-config`).expect(200);
    expect(cfg.body.data).toMatchObject({ login: 'shop@alice.com', port: 21, protocol: 'ftp', dir: '/home/alice/public_html/shop' });
    expect(cfg.body.data.filezilla).toContain('<User>shop@alice.com</User>');
    expect(JSON.stringify(cfg.body)).not.toMatch(/An0ther/);
    const removed = await del(`/accounts/${row.id}`).expect(200);
    expect(removed.body.data).toMatchObject({ login: 'shop@alice.com', removed: true });
    expect(app.agent.callsTo('ftp.user.remove')[0].args).toEqual({ daemon: 'pure-ftpd', login: 'shop@alice.com' });
    expect(app.ctx.db.prepare('SELECT 1 FROM ftp_accounts WHERE id = ?').get(row.id)).toBeFalsy();
  });

  it('leaves no row behind when the daemon refuses the login', async () => {
    app.agent.state.fail = 'add';
    await post('/accounts', { ...good, login: 'broken' }).expect(500);
    expect(app.ctx.db.prepare("SELECT 1 FROM ftp_accounts WHERE name = 'broken'").get()).toBeFalsy();
  });

  it('switches to proftpd logins <name>_<account> and drops the quota there', async () => {
    app.agent.state.daemon = 'proftpd';
    try {
      const res = await post('/accounts', { ...good, login: 'pro' }).expect(201);
      expect(res.body.data).toMatchObject({ login: 'pro_alice', daemon: 'proftpd', quotaMb: null });
      expect(app.agent.callsTo('ftp.user.add')[0].args).toMatchObject({ daemon: 'proftpd', login: 'pro_alice', quotaMb: null });
      const q = await put(`/accounts/${res.body.data.id}/quota`, { quotaMb: 5 }).expect(422);
      expect(q.body.error.code).toBe('unsupported');
      await del(`/accounts/${res.body.data.id}`).expect(200);
    } finally { app.agent.state.daemon = 'pure-ftpd'; }
  });

  it('reports vsftpd as unsupported and answers 501 on create', async () => {
    app.agent.state.daemon = 'vsftpd';
    try {
      const list = await get('/accounts').expect(200);
      expect(list.body.meta).toMatchObject({ daemon: 'vsftpd', supported: false, supportedDaemon: false });
      const res = await post('/accounts', { ...good, login: 'vs' }).expect(501);
      expect(res.body.error.code).toBe('capability_missing');
      expect(app.agent.callsTo('ftp.user.add')).toHaveLength(0);
    } finally { app.agent.state.daemon = 'pure-ftpd'; }
  });

  it('asks service-configuration to enable virtual users (seam S5) and fails closed when it cannot', async () => {
    app.agent.state.virtual['pure-ftpd'] = false;
    const enable = vi.fn(async () => { app.agent.state.virtual['pure-ftpd'] = true; });
    const ftp = app.ctx.web.ftp;
    try {
      const off = await get('/accounts').expect(200);
      expect(off.body.meta).toMatchObject({ supported: false, virtualUsersEnabled: false, canEnable: false });
      expect((await post('/accounts', { ...good, login: 'novirt' }).expect(501)).body.error.code).toBe('capability_missing');
      ftp.enableVirtualUsers = enable;
      const res = await post('/accounts', { ...good, login: 'virt' }).expect(201);
      expect(enable).toHaveBeenCalledTimes(1);
      expect(res.body.data.login).toBe('virt@alice.com');
      await del(`/accounts/${res.body.data.id}`).expect(200);
    } finally { delete ftp.enableVirtualUsers; app.agent.state.virtual['pure-ftpd'] = true; }
  });
});
