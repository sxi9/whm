import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { normalizeServices, SUBUSER_NAME, DEFAULT_SERVICES } from '../src/services/panel-users.js';

const HASH = '$6$zbsfcWrdKw0VR0wa$A0rw1A7d4PBa2YN/z1nATzFjoYngcI/Kpt3Ih5IWolea1/ANnjhx8YxtNUdCS5bDEjG80Yb.rvLa4CkZj2/pR1';
const PRESENT = new Set(['exim4', 'exim', 'dovecot', 'doveadm', 'openssl', 'setpriv', 'runuser', 'pure-pw', 'ftpasswd', 'pure-ftpd', 'systemctl']);

// A host with Dovecot (virtual mail) and pure-ftpd with PureDB: the mailbox and
// FTP ops record their calls and keep a tiny state so "exists"/"not_found"
// answer like the real agent, nothing runs.
function hostAgent() {
  const state = { ftpUsers: new Map(), passwd: new Map(), dav: new Set(), fail: null };
  const failWith = (code, message) => Object.assign(new Error(message), { agentError: true, code, details: {} });
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, PRESENT.has(n)])),
    'vmail.hash': () => ({ hash: HASH, scheme: 'SHA512-CRYPT', tool: 'openssl' }),
    'vmail.passwd.set': ({ domain, localPart }) => { state.passwd.set(`${localPart}@${domain}`, true); return { domain, localPart, replaced: false }; },
    'vmail.passwd.remove': ({ domain, localPart }) => ({ domain, localPart, removed: state.passwd.delete(`${localPart}@${domain}`) }),
    'vmail.passwd.purge': ({ domain }) => ({ domain, removed: true, users: [] }),
    'vmail.quota.get': ({ user }) => ({ user, bytes: 0, limitBytes: null, messages: 0 }),
    'vmail.aliases.write': ({ domain, entries }) => ({ domain, entries: entries.length }),
    'vmail.aliases.remove': ({ domain }) => ({ domain, removed: true }),
    'vmail.domainfwd.write': ({ entries }) => ({ entries: entries.length }),
    'vmail.sieve.remove': () => ({ removed: false }),
    'vmail.render.check': () => ({ dovecot: { installed: true, configOk: true }, exim: { installed: true, configOk: true }, routerHooked: true, transportHooked: true, authHooked: true, hint: null }),
    'mail.config.include.write': () => ({ domainListsHooked: true, path: '/etc/exim4/whm/x.lst' }),
    'mail.detect': () => ({ installed: true, flavor: 'debian', dovecot: { installed: true, doveadm: true }, spamd: { installed: false } }),
    'files.mkdir': ({ path }) => ({ path }),
    'files.write': ({ path }) => ({ path }),
    'files.remove': ({ paths }) => ({ removed: paths }),
    'files.du': () => ({ totalKb: 0, entries: [] }),
    'svc.list_units': () => ['pure-ftpd'],
    'web.service.detect': () => ({ role: 'ftp', candidates: ['pure-ftpd', 'proftpd', 'vsftpd'].map((name) => ({ name, installed: name === 'pure-ftpd', unitName: name === 'pure-ftpd' ? name : null, unit: { active: name === 'pure-ftpd', enabled: name === 'pure-ftpd' } })), active: ['pure-ftpd'], enabled: ['pure-ftpd'], current: 'pure-ftpd', packageManager: 'apt-get' }),
    'web.ftp.config.read': ({ server }) => ({ server, path: `/etc/${server}`, unit: { active: true }, settings: { tls: 'optional' }, raw: {} }),
    'ftp.virtual.status': ({ daemon }) => ({ daemon, supported: true, enabled: true, configured: true, passwdFile: `/etc/${daemon}/passwd`, hint: null }),
    'ftp.user.add': (args) => { if (state.fail === 'ftp.add') throw failWith('command_failed', 'pure-pw: disk full'); if (state.ftpUsers.has(args.login)) throw failWith('exists', 'exists'); state.ftpUsers.set(args.login, args); return { daemon: args.daemon, login: args.login, username: args.username, uid: 30001, gid: 30001, dir: args.dir, quotaMb: args.quotaMb }; },
    'ftp.user.passwd': ({ login }) => { if (!state.ftpUsers.has(login)) throw failWith('not_found', 'no such login'); return { login, changed: true }; },
    'ftp.user.remove': ({ login }) => ({ login, removed: state.ftpUsers.delete(login) }),
    'ftp.sync': ({ daemon }) => ({ daemon, synced: true }),
    'dav.user.remove': ({ login }) => ({ login, path: '/etc/whm/radicale/users', removed: state.dav.delete(login) }),
  };
  const agent = createMockAgent(ops);
  agent.state = state;
  agent.ops = ops;
  return agent;
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
    post: (p, body = {}) => http.post(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    put: (p, body = {}) => http.put(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    del: (p) => http.delete(`/api/panel${p}`).set('X-CSRF-Token', csrf),
  };
}

function setFeature(app, username, key, enabled) {
  const row = app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username);
  const plan = JSON.parse(row.plan_snapshot_json || '{}');
  const next = { ...plan, features: { ...(plan.features || {}), [key]: enabled } };
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(next), username);
}

const PASSWORD = 'Str0ng-Passw0rd!';

describe('panel users helpers', () => {
  it('normalises the services JSON and keeps the dav flag P4-3 reads', () => {
    expect(normalizeServices()).toEqual({ email: { enabled: false, quotaMb: null, mailboxId: null }, ftp: { enabled: false, homeDir: 'public_html', accountId: null }, dav: { enabled: false } });
    expect(normalizeServices({ email: { enabled: true, quotaMb: 100, mailboxId: 4 }, dav: { enabled: true } }).email).toEqual({ enabled: true, quotaMb: 100, mailboxId: 4 });
    expect(DEFAULT_SERVICES.dav).toEqual({ enabled: false });
    for (const ok of ['probe.sub', 'a', 'dev_1', 'x-y']) expect(SUBUSER_NAME.test(ok), ok).toBe(true);
    for (const bad of ['.hidden', '-x', 'A', 'a b', 'a@b', 'a'.repeat(33), '']) expect(SUBUSER_NAME.test(bad), bad).toBe(false);
  });
});

describe('Customer panel: User Manager (/api/panel/users)', () => {
  let app;
  let alice;
  let bob;
  const db = () => app.ctx.db;
  const row = (sql, ...args) => db().prepare(sql).get(...args);
  const rows = (sql, ...args) => db().prepare(sql).all(...args);
  const names = () => app.agent.calls.map((c) => c.name);
  const restore = () => { for (const [name, handler] of Object.entries(app.agent.ops)) app.agent.set(name, handler); app.agent.calls.length = 0; app.agent.state.fail = null; };

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    const csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', ip: '203.0.113.5', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'shop.alice.com', 'sub', '/home/alice/public_html/shop')").run(row('SELECT id FROM accounts WHERE username = ?', 'alice').id);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
  }, 120_000);
  afterAll(() => app.close());
  beforeEach(restore);

  it('runs the migration and lists an empty account with its domains and service availability', async () => {
    expect(row("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'panel_subusers'")).toBeTruthy();
    const res = await alice.get('/users');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ total: 0, max: null, domains: ['alice.com', 'shop.alice.com'], features: { email: true, ftp: true } });
    expect(res.body.meta.defaults.dav).toEqual({ enabled: false });
  });

  it('is gated by the usermanager feature and refuses an admin session without acting-as', async () => {
    setFeature(app, 'alice', 'usermanager', false);
    const res = await alice.get('/users');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('feature_disabled');
    setFeature(app, 'alice', 'usermanager', true);
    const admin = await app.http.get('/api/panel/users');
    expect(admin.status).toBe(403);
  });

  it('validates the body: name, foreign domain, weak password, unknown keys, traversal home', async () => {
    for (const [body, status] of [
      [{ username: 'Bad Name', domain: 'alice.com', password: PASSWORD }, 422],
      [{ username: 'ok', domain: 'alice.com', password: 'short' }, 422],
      [{ username: 'ok', domain: 'alice.com', password: PASSWORD, extra: 1 }, 422],
      [{ username: 'ok', domain: 'alice.com', password: PASSWORD, services: { ftp: { enabled: true, homeDir: '../bob' } } }, 422],
      [{ username: 'ok', domain: 'bob.com', password: PASSWORD }, 404],
    ]) {
      const res = await alice.post('/users', body);
      expect(res.status, JSON.stringify(body)).toBe(status);
    }
    expect(names().filter((n) => n.startsWith('vmail.') || n.startsWith('ftp.user'))).toEqual([]);
  });

  it('creates mailbox + FTP login through the owning services with one password, then the row', async () => {
    const res = await alice.post('/users', { username: 'probe.sub', domain: 'alice.com', password: PASSWORD, fullName: 'Probe Sub', contactEmail: 'Probe@Example.org', services: { email: { enabled: true, quotaMb: 256 }, ftp: { enabled: true, homeDir: 'public_html/probe' } } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ username: 'probe.sub', domain: 'alice.com', login: 'probe.sub@alice.com', fullName: 'Probe Sub', contactEmail: 'probe@example.org' });
    expect(res.body.data.services).toEqual({
      email: { enabled: true, quotaMb: 256, address: 'probe.sub@alice.com', present: true },
      ftp: { enabled: true, homeDir: 'public_html/probe', present: true },
      dav: { enabled: false, login: null },
    });
    const order = names();
    expect(order.indexOf('vmail.passwd.set')).toBeLessThan(order.indexOf('ftp.user.add'));
    expect(app.agent.callsTo('vmail.passwd.set')[0].args).toMatchObject({ domain: 'alice.com', localPart: 'probe.sub', hash: HASH, username: 'alice', quotaBytes: 256 * 1024 * 1024 });
    const add = app.agent.callsTo('ftp.user.add')[0].args;
    expect(add).toMatchObject({ daemon: 'pure-ftpd', login: 'probe.sub@alice.com', password: PASSWORD, username: 'alice', dir: '/home/alice/public_html/probe' });
    const sub = row('SELECT * FROM panel_subusers WHERE username = ? AND domain = ?', 'probe.sub', 'alice.com');
    const services = JSON.parse(sub.services_json);
    expect(services.email.mailboxId).toBe(row('SELECT ma.id FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id WHERE md.domain = ? AND ma.local_part = ?', 'alice.com', 'probe.sub').id);
    expect(services.ftp.accountId).toBe(row('SELECT id FROM ftp_accounts WHERE login = ?', 'probe.sub@alice.com').id);
    expect(sub.services_json).not.toContain(PASSWORD);
    const audits = rows("SELECT args_redacted FROM audit_log WHERE action IN ('panel.users.create', 'panel.email.account.create', 'panel.ftp.create')");
    expect(audits.length).toBe(3);
    for (const a of audits) expect(a.args_redacted).not.toContain(PASSWORD);
    expect(JSON.parse(rows("SELECT args_redacted FROM audit_log WHERE action = 'panel.users.create'")[0].args_redacted)).toEqual({ login: 'probe.sub@alice.com', services: ['email', 'ftp'] });
  });

  it('refuses a duplicate, hides other accounts\' sub-users, and lists with service badges', async () => {
    expect((await alice.post('/users', { username: 'probe.sub', domain: 'alice.com', password: PASSWORD })).status).toBe(409);
    expect((await bob.get('/users')).body.data).toEqual([]);
    const id = row('SELECT id FROM panel_subusers WHERE username = ?', 'probe.sub').id;
    expect((await bob.get(`/users/${id}`)).status).toBe(404);
    expect((await bob.del(`/users/${id}`)).status).toBe(404);
    expect((await bob.put(`/users/${id}/password`, { password: PASSWORD })).status).toBe(404);
    const list = await alice.get('/users');
    expect(list.body.data.map((u) => [u.login, u.services.email.enabled, u.services.ftp.enabled])).toEqual([['probe.sub@alice.com', true, true]]);
  });

  it('changes the password on every enabled service, never logging it', async () => {
    const id = row('SELECT id FROM panel_subusers WHERE username = ?', 'probe.sub').id;
    const res = await alice.put(`/users/${id}/password`, { password: 'An0ther-Passw0rd!' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ id, login: 'probe.sub@alice.com', changed: true, applied: ['email', 'ftp'] });
    expect(names()).toEqual(expect.arrayContaining(['vmail.hash', 'vmail.passwd.set', 'ftp.user.passwd']));
    expect(app.agent.callsTo('ftp.user.passwd')[0].args).toMatchObject({ login: 'probe.sub@alice.com', password: 'An0ther-Passw0rd!' });
    for (const a of rows('SELECT args_redacted FROM audit_log')) expect(a.args_redacted || '').not.toContain('An0ther-Passw0rd!');
    expect((await alice.put(`/users/${id}/password`, { password: 'short' })).status).toBe(422);
  });

  it('disabling FTP removes the login and keeps the mailbox; re-enabling needs the password', async () => {
    const id = row('SELECT id FROM panel_subusers WHERE username = ?', 'probe.sub').id;
    let res = await alice.put(`/users/${id}`, { services: { ftp: { enabled: false } } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta.changed).toEqual(['ftp:off']);
    expect(res.body.data.services.ftp).toEqual({ enabled: false, homeDir: 'public_html/probe', present: null });
    expect(res.body.data.services.email.enabled).toBe(true);
    expect(app.agent.callsTo('ftp.user.remove')[0].args.login).toBe('probe.sub@alice.com');
    expect(row('SELECT id FROM ftp_accounts WHERE login = ?', 'probe.sub@alice.com')).toBeUndefined();
    expect(names()).not.toContain('vmail.passwd.remove');

    res = await alice.put(`/users/${id}`, { services: { ftp: { enabled: true } } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('password_required');
    expect(names()).not.toContain('ftp.user.add');

    res = await alice.put(`/users/${id}`, { services: { ftp: { enabled: true, homeDir: 'public_html' } }, password: PASSWORD, fullName: 'Probe S.' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta.changed).toEqual(['ftp:on', 'password']);
    expect(res.body.data.fullName).toBe('Probe S.');
    expect(res.body.data.services.ftp).toEqual({ enabled: true, homeDir: 'public_html', present: true });
    expect(app.agent.callsTo('ftp.user.add')[0].args).toMatchObject({ login: 'probe.sub@alice.com', dir: '/home/alice/public_html', password: PASSWORD });
    // One password for every service: the mailbox that stayed on takes the password given to enable FTP.
    expect(app.agent.callsTo('vmail.passwd.set')).toHaveLength(1);
    expect(app.agent.callsTo('vmail.passwd.set')[0].args).toMatchObject({ localPart: 'probe.sub', domain: 'alice.com', hash: HASH });
    // The FTP login created just now is not set a second time.
    expect(names()).not.toContain('ftp.user.passwd');
  });

  it('an FTP home change recreates the login with the password and applies it to the mailbox once', async () => {
    const id = row('SELECT id FROM panel_subusers WHERE username = ?', 'probe.sub').id;
    const res = await alice.put(`/users/${id}`, { services: { ftp: { enabled: true, homeDir: 'public_html/probe' } }, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta.changed).toEqual(['ftp:home', 'password']);
    expect(names().filter((n) => n === 'ftp.user.remove')).toHaveLength(1);
    expect(app.agent.callsTo('ftp.user.add')[0].args).toMatchObject({ login: 'probe.sub@alice.com', dir: '/home/alice/public_html/probe', password: PASSWORD });
    expect(names()).not.toContain('ftp.user.passwd');
    expect(app.agent.callsTo('vmail.passwd.set')).toHaveLength(1);
    await alice.put(`/users/${id}`, { services: { ftp: { enabled: true, homeDir: 'public_html' } }, password: PASSWORD }).expect(200);
  });

  it('a mailbox quota edit goes through the mailbox service; dav is a flag only', async () => {
    const id = row('SELECT id FROM panel_subusers WHERE username = ?', 'probe.sub').id;
    const res = await alice.put(`/users/${id}`, { services: { email: { enabled: true, quotaMb: 512 }, dav: { enabled: true } } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta.changed).toEqual(['email:quota', 'dav:on']);
    expect(app.agent.callsTo('vmail.passwd.set')[0].args).toMatchObject({ localPart: 'probe.sub', quotaBytes: 512 * 1024 * 1024, hash: HASH });
    expect(res.body.data.services.dav).toEqual({ enabled: true, login: 'probe.sub@alice.com' });
    expect(app.ctx.panelUsers.davLogins(row('SELECT id FROM accounts WHERE username = ?', 'alice').id)).toEqual([{ id, login: 'probe.sub@alice.com' }]);
  });

  // The DAV password itself is set through P4-3 (dav.test.js); here the login
  // exists as its row + htpasswd line, which must go with the service.
  function giveDavPassword(login, username = 'alice') {
    const accountId = row('SELECT id FROM accounts WHERE username = ?', username).id;
    const sub = row('SELECT id FROM panel_subusers WHERE username = ? AND domain = ?', ...login.split('@'));
    db().prepare('INSERT OR REPLACE INTO panel_dav_logins (account_id, login, subuser_id) VALUES (?, ?, ?)').run(accountId, login, sub.id);
    app.agent.state.dav.add(login);
  }

  it('switching the dav service off removes the DAV login from the htpasswd file and the row, audited', async () => {
    const id = row('SELECT id FROM panel_subusers WHERE username = ?', 'probe.sub').id;
    giveDavPassword('probe.sub@alice.com');
    const res = await alice.put(`/users/${id}`, { services: { dav: { enabled: false } } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta.changed).toEqual(['dav:off']);
    expect(res.body.data.services.dav).toEqual({ enabled: false, login: null });
    expect(app.agent.callsTo('dav.user.remove').map((c) => c.args)).toEqual([{ login: 'probe.sub@alice.com' }]);
    expect(app.agent.state.dav.has('probe.sub@alice.com')).toBe(false);
    expect(row('SELECT * FROM panel_dav_logins WHERE login = ?', 'probe.sub@alice.com')).toBeUndefined();
    expect(JSON.parse(rows("SELECT args_redacted FROM audit_log WHERE action = 'panel.dav.password.remove' ORDER BY id DESC").at(0).args_redacted)).toEqual({ login: 'probe.sub@alice.com', kind: 'subuser', removed: true, reason: 'dav_off' });
    // Back on for the delete case below; a login another account registered is never touched.
    await alice.put(`/users/${id}`, { services: { dav: { enabled: true } } }).expect(200);
    giveDavPassword('probe.sub@alice.com');
    db().prepare('UPDATE panel_dav_logins SET account_id = ? WHERE login = ?').run(row('SELECT id FROM accounts WHERE username = ?', 'bob').id, 'probe.sub@alice.com');
    app.agent.calls.length = 0;
    await alice.put(`/users/${id}`, { services: { dav: { enabled: false } } }).expect(200);
    expect(names()).not.toContain('dav.user.remove');
    expect(row('SELECT * FROM panel_dav_logins WHERE login = ?', 'probe.sub@alice.com')).toBeTruthy();
    db().prepare('DELETE FROM panel_dav_logins WHERE login = ?').run('probe.sub@alice.com');
    await alice.put(`/users/${id}`, { services: { dav: { enabled: true } } }).expect(200);
  });

  it('compensates: an FTP failure on create removes the mailbox it just made', async () => {
    app.agent.state.fail = 'ftp.add';
    const res = await alice.post('/users', { username: 'broken', domain: 'shop.alice.com', password: PASSWORD, services: { email: { enabled: true }, ftp: { enabled: true } } });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const order = names();
    expect(order.indexOf('vmail.passwd.set')).toBeLessThan(order.indexOf('ftp.user.add'));
    expect(order.indexOf('ftp.user.add')).toBeLessThan(order.indexOf('vmail.passwd.remove'));
    expect(row('SELECT id FROM panel_subusers WHERE username = ?', 'broken')).toBeUndefined();
    expect(row('SELECT ma.id FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id WHERE ma.local_part = ?', 'broken')).toBeUndefined();
  });

  it('honours the services\' own feature flags and the max_subusers plan limit', async () => {
    setFeature(app, 'alice', 'ftpaccts', false);
    let res = await alice.post('/users', { username: 'noftp', domain: 'alice.com', password: PASSWORD, services: { ftp: { enabled: true } } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('feature_disabled');
    setFeature(app, 'alice', 'ftpaccts', true);
    const acc = row('SELECT plan_snapshot_json FROM accounts WHERE username = ?', 'alice');
    const plan = JSON.parse(acc.plan_snapshot_json || '{}');
    db().prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify({ ...plan, max_subusers: 1 }), 'alice');
    res = await alice.post('/users', { username: 'second', domain: 'alice.com', password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('limit_reached');
    expect((await alice.get('/users')).body.meta.max).toBe(1);
    db().prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(plan), 'alice');
  });

  it('a sub-user without services is just a row; the password is still checked', async () => {
    const res = await alice.post('/users', { username: 'plain', domain: 'shop.alice.com', password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.services.email).toEqual({ enabled: false, quotaMb: null, address: null, present: null });
    expect(names().filter((n) => n.startsWith('vmail.') || n.startsWith('ftp.'))).toEqual([]);
    expect((await alice.put(`/users/${res.body.data.id}/password`, { password: 'An0ther-Passw0rd!' })).body.data.applied).toEqual([]);
    expect((await alice.del(`/users/${res.body.data.id}`)).body.data).toMatchObject({ removed: true, services: [] });
  });

  it('deleting the sub-user removes the mailbox (with its mail), the FTP login and the DAV login', async () => {
    const id = row('SELECT id FROM panel_subusers WHERE username = ?', 'probe.sub').id;
    giveDavPassword('probe.sub@alice.com');
    const res = await alice.del(`/users/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ id, login: 'probe.sub@alice.com', removed: true, services: ['email', 'ftp', 'dav'] });
    expect(app.agent.callsTo('vmail.passwd.remove')[0].args).toEqual({ domain: 'alice.com', localPart: 'probe.sub' });
    expect(app.agent.callsTo('files.remove')[0].args).toMatchObject({ username: 'alice', paths: ['/home/alice/mail/alice.com/probe.sub'] });
    expect(app.agent.callsTo('ftp.user.remove')[0].args.login).toBe('probe.sub@alice.com');
    expect(app.agent.callsTo('dav.user.remove').map((c) => c.args)).toEqual([{ login: 'probe.sub@alice.com' }]);
    expect(app.agent.state.dav.has('probe.sub@alice.com')).toBe(false);
    expect(row('SELECT * FROM panel_dav_logins WHERE login = ?', 'probe.sub@alice.com')).toBeUndefined();
    expect(JSON.parse(rows("SELECT args_redacted FROM audit_log WHERE action = 'panel.dav.password.remove' ORDER BY id DESC").at(0).args_redacted)).toEqual({ login: 'probe.sub@alice.com', kind: 'subuser', removed: true, reason: 'subuser_removed' });
    expect(row('SELECT id FROM panel_subusers WHERE id = ?', id)).toBeUndefined();
    expect(row('SELECT id FROM ftp_accounts WHERE login = ?', 'probe.sub@alice.com')).toBeUndefined();
    expect(row('SELECT ma.id FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id WHERE ma.local_part = ?', 'probe.sub')).toBeUndefined();
    expect(rows("SELECT * FROM audit_log WHERE action = 'panel.users.delete' AND args_redacted LIKE '%probe.sub@alice.com%'")).toHaveLength(1);
  });

  it('tolerates a service row deleted elsewhere: present:false, delete still succeeds', async () => {
    const created = await alice.post('/users', { username: 'gone', domain: 'alice.com', password: PASSWORD, services: { ftp: { enabled: true } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const ftpId = JSON.parse(row('SELECT services_json FROM panel_subusers WHERE username = ?', 'gone').services_json).ftp.accountId;
    await alice.del(`/ftp/accounts/${ftpId}`).expect(200);
    expect((await alice.get(`/users/${created.body.data.id}`)).body.data.services.ftp).toEqual({ enabled: true, homeDir: 'public_html', present: false });
    const res = await alice.del(`/users/${created.body.data.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.services).toEqual([]);
  });
});
