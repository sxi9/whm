import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { renderUserPrefs, auditArgs, limitOf } from '../src/services/panel-email.js';

const HASH = '$6$zbsfcWrdKw0VR0wa$A0rw1A7d4PBa2YN/z1nATzFjoYngcI/Kpt3Ih5IWolea1/ANnjhx8YxtNUdCS5bDEjG80Yb.rvLa4CkZj2/pR1';
const PRESENT = new Set(['exim4', 'exim', 'dovecot', 'doveadm', 'openssl', 'spamd', 'spamassassin', 'setpriv', 'runuser', 'named', 'rndc', 'named-checkzone']);

// A host with Exim + Dovecot + SpamAssassin: every vmail/files op answers through
// the mock so the panel's call order and arguments can be asserted.
const OVERRIDES = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, PRESENT.has(n)])),
    'vmail.hash': () => ({ hash: HASH, scheme: 'SHA512-CRYPT', tool: 'openssl' }),
    'vmail.passwd.set': ({ domain, localPart }) => ({ domain, localPart, replaced: false }),
    'vmail.passwd.remove': ({ domain, localPart }) => ({ domain, localPart, removed: true }),
    'vmail.quota.get': ({ user }) => ({ user, bytes: 4096, limitBytes: 1073741824, messages: 3 }),
    'vmail.aliases.write': ({ domain, entries }) => ({ domain, entries: entries.length }),
    'vmail.aliases.remove': ({ domain }) => ({ domain, removed: true }),
    'vmail.domainfwd.write': ({ entries }) => ({ entries: entries.length }),
    'vmail.autoresponder.write': ({ domain, localPart }) => ({ domain, localPart }),
    'vmail.autoresponder.remove': ({ domain, localPart }) => ({ domain, localPart, removed: true }),
    'vmail.spam_users.write': ({ entries }) => ({ entries: entries.length }),
    'vmail.render.check': () => ({ dovecot: { installed: true, configOk: true }, exim: { installed: true, configOk: true }, routerHooked: false, transportHooked: false, authHooked: true, hint: 'apply' }),
    'web.webmail.detect': () => ({ installed: true, flavor: 'roundcube', path: '/var/lib/roundcube', version: '1.6.6', configured: true, apacheAlias: '/roundcube' }),
    'files.mkdir': ({ path }) => ({ path }),
    'files.write': ({ path }) => ({ path }),
    'files.remove': ({ paths }) => ({ removed: paths }),
    'files.du': () => ({ totalKb: 12, entries: [] }),
    'mail.config.include.write': () => ({ domainListsHooked: true, path: '/etc/exim4/whm/x.lst' }),
    'mail.detect': () => ({ installed: true, flavor: 'debian', dovecot: { installed: true, doveadm: true }, spamd: { installed: true } }),
    'dns.layout': () => ({ installed: true, flavor: 'debian', zoneDir: '/etc/bind/zones', includeFile: '/etc/bind/named.conf.whm' }),
    'dns.zone.list': () => ({ installed: true, zones: [] }),
    'dns.zone.read': ({ domain }) => ({ domain, exists: false, body: null }),
    'dns.checkzone': ({ domain }) => ({ domain, ok: true, output: '', serial: 1 }),
    'dns.zone.write': ({ domain }) => ({ domain, path: `/etc/bind/zones/${domain}.db`, stanzaAdded: true, includeAdded: false }),
    'dns.reload': ({ domain }) => ({ method: 'rndc', domain: domain ?? null, output: '' }),
};
const hostAgent = () => createMockAgent(OVERRIDES);
// The mock's reset() falls back to its own defaults (nothing installed), so the
// host overrides are re-applied between tests instead.
const restoreAgent = (agent) => { for (const [name, handler] of Object.entries(OVERRIDES)) agent.set(name, handler); agent.calls.length = 0; };

async function panelLogin(app, username, password = 'Panel-Passw0rd!1') {
  const hash = await app.ctx.crypto.hashPassword(password);
  app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  const http = request.agent(app.ctx.app);
  const res = await http.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`panel login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  return {
    http, csrf,
    get: (p) => http.get(`/api/panel${p}`),
    post: (p, body = {}) => http.post(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    put: (p, body = {}) => http.put(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    patch: (p, body = {}) => http.patch(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    del: (p) => http.delete(`/api/panel${p}`).set('X-CSRF-Token', csrf),
  };
}

function setPlan(app, username, patch) {
  const row = app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username);
  const plan = JSON.parse(row.plan_snapshot_json || '{}');
  const next = typeof patch === 'function' ? patch(plan) : { ...plan, ...patch };
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify(next), username);
  return next;
}
const setFeature = (app, username, key, enabled) => setPlan(app, username, (plan) => ({ ...plan, features: { ...(plan.features || {}), [key]: enabled } }));

describe('Customer panel: email', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  const db = () => app.ctx.db;
  const rows = (sql, ...args) => db().prepare(sql).all(...args);
  const row = (sql, ...args) => db().prepare(sql).get(...args);
  const names = () => app.agent.calls.map((c) => c.name);
  const accountId = (username) => row('SELECT id FROM accounts WHERE username = ?', username).id;

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', ip: '203.0.113.5', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'shop.alice.com', 'sub', '/home/alice/public_html/shop')").run(accountId('alice'));
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
  });
  afterAll(() => app.close());
  beforeEach(() => restoreAgent(app.agent));

  describe('scope and gates', () => {
    it('refuses an admin session without an acting-as context', async () => {
      const res = await app.http.get('/api/panel/email/accounts');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('panel_scope_required');
    });

    it('refuses every email feature the package disables', async () => {
      const cases = [
        ['emailaccts', () => alice.get('/email/accounts')],
        ['emailaccts', () => alice.post('/email/accounts', { localPart: 'x', domain: 'alice.com', password: 'Str0ng-Passw0rd!' })],
        ['forwarders', () => alice.post('/email/forwarders', { domain: 'alice.com', localPart: 'x', destination: 'a@b.com' })],
        ['defaultaddress', () => alice.put('/email/domains/alice.com/default', { action: 'blackhole' })],
        ['autoresponders', () => alice.post('/email/autoresponders', { address: 'x@alice.com', subject: 'Away', body: 'b' })],
        ['spamassassin', () => alice.put('/email/spam', { enabled: true })],
      ];
      for (const [feature, call] of cases) {
        setFeature(app, 'alice', feature, false);
        const res = await call();
        expect(res.status, feature).toBe(403);
        expect(res.body.error.code, feature).toBe('feature_disabled');
        setFeature(app, 'alice', feature, true);
      }
      expect(names().filter((n) => n.startsWith('vmail.') || n.startsWith('files.'))).toEqual([]);
    });

    it('returns 501 capability_missing without Dovecot before any op runs', async () => {
      app.agent.set('sys.binaries', ({ names: ns }) => Object.fromEntries(ns.map((n) => [n, PRESENT.has(n) && !['dovecot', 'doveadm'].includes(n)])));
      await app.ctx.capabilities.refresh();
      app.agent.calls.length = 0;
      const res = await alice.post('/email/accounts', { localPart: 'nope', domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('capability_missing');
      expect(names().filter((n) => n.startsWith('vmail.') || n.startsWith('files.'))).toEqual([]);
      app.agent.set('sys.binaries', OVERRIDES['sys.binaries']);
      await app.ctx.capabilities.refresh();
    });
  });

  describe('mailboxes', () => {
    it('refuses malformed local parts, foreign domains and weak bodies', async () => {
      for (const localPart of ['Info', '.hidden', '-x', 'a:b', 'a b', 'a|b', 'a/b', 'x'.repeat(65), '']) {
        const res = await alice.post('/email/accounts', { localPart, domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
        expect(res.status, localPart).toBe(422);
      }
      const foreign = await alice.post('/email/accounts', { localPart: 'info', domain: 'bob.com', password: 'Str0ng-Passw0rd!' });
      expect(foreign.status).toBe(404);
      const extra = await alice.post('/email/accounts', { localPart: 'info', domain: 'alice.com', password: 'Str0ng-Passw0rd!', uid: 0 });
      expect(extra.status).toBe(422);
      expect(names().filter((n) => n.startsWith('vmail.'))).toEqual([]);
    });

    it('counts max_email itself before touching the host', async () => {
      setPlan(app, 'alice', { max_email: 0 });
      const res = await alice.post('/email/accounts', { localPart: 'info', domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('limit_reached');
      expect(names().filter((n) => n.startsWith('vmail.') || n.startsWith('files.'))).toEqual([]);
      setPlan(app, 'alice', { max_email: 5 });
    });

    it('creates in order: mail domain → hash → maildir as the account → passwd line → row, routing applied', async () => {
      const res = await alice.post('/email/accounts', { localPart: 'info', domain: 'alice.com', password: 'Str0ng-Passw0rd!', quotaMb: 512 });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ address: 'info@alice.com', localPart: 'info', domain: 'alice.com', quotaMb: 512, suspended: false });
      expect(res.body.meta.warnings).toEqual([]);
      const order = names();
      const i = (n) => order.indexOf(n);
      expect(i('vmail.hash')).toBeGreaterThanOrEqual(0);
      expect(i('vmail.hash')).toBeLessThan(i('files.mkdir'));
      expect(i('files.mkdir')).toBeLessThan(i('vmail.passwd.set'));
      expect(app.agent.callsTo('files.mkdir').map((c) => c.args)).toEqual(['', '/cur', '/new', '/tmp'].map((sub) => ({ username: 'alice', path: `/home/alice/mail/alice.com/info${sub}`, mode: '0700' })));
      expect(order).not.toContain('fs.mkdir');
      const set = app.agent.callsTo('vmail.passwd.set')[0].args;
      expect(set).toEqual({ domain: 'alice.com', localPart: 'info', hash: HASH, username: 'alice', quotaBytes: 512 * 1024 * 1024, disabled: false });
      expect(app.agent.callsTo('vmail.hash')[0].args).toEqual({ password: 'Str0ng-Passw0rd!' });
      const md = row('SELECT * FROM mail_domains WHERE domain = ?', 'alice.com');
      expect(md).toMatchObject({ account_id: accountId('alice'), routing: 'local' });
      expect(row('SELECT * FROM mail_accounts WHERE domain_id = ? AND local_part = ?', md.id, 'info')).toMatchObject({ quota_mb: 512, password_hash: HASH, suspended: 0 });
      expect(rows("SELECT * FROM audit_log WHERE action = 'panel.email.account.create' AND target = 'alice'")).toHaveLength(1);
      expect(JSON.parse(rows("SELECT args_redacted FROM audit_log WHERE action = 'panel.email.account.create'")[0].args_redacted)).not.toHaveProperty('password');
    });

    it('surfaces routing_not_applied as a warning, never a failure', async () => {
      app.agent.set('mail.config.include.write', () => ({ domainListsHooked: false, domainListsDetail: 'macro not read', hint: 'add the include' }));
      db().prepare("UPDATE mail_domains SET routing = 'auto' WHERE domain = 'alice.com'").run();
      const res = await alice.post('/email/accounts', { localPart: 'sales', domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.meta.warnings.map((w) => w.code)).toEqual(['routing_not_applied']);
      expect(row('SELECT local_part FROM mail_accounts WHERE local_part = ?', 'sales')).toBeTruthy();
      expect(res.body.data.quotaMb).toBe(1024);
    });

    it('compensates with passwd.remove when the row cannot be inserted', async () => {
      const md = row('SELECT id FROM mail_domains WHERE domain = ?', 'alice.com');
      app.agent.set('vmail.passwd.set', ({ domain, localPart }) => {
        db().prepare("INSERT INTO mail_accounts (domain_id, local_part, quota_mb, password_hash) VALUES (?, ?, 1, 'x')").run(md.id, localPart);
        return { domain, localPart };
      });
      const res = await alice.post('/email/accounts', { localPart: 'race', domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
      expect(res.status).toBe(409);
      expect(names().slice(-1)).toEqual(['vmail.passwd.remove']);
      expect(app.agent.callsTo('vmail.passwd.remove')[0].args).toEqual({ domain: 'alice.com', localPart: 'race' });
      db().prepare("DELETE FROM mail_accounts WHERE local_part = 'race'").run();
    });

    it('refuses the same mailbox twice and a mail domain owned by another account', async () => {
      const dup = await alice.post('/email/accounts', { localPart: 'info', domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
      expect(dup.status).toBe(409);
      db().prepare("INSERT INTO mail_domains (domain, account_id, routing) VALUES ('shop.alice.com', ?, 'auto')").run(accountId('bob'));
      const stolen = await alice.post('/email/accounts', { localPart: 'info', domain: 'shop.alice.com', password: 'Str0ng-Passw0rd!' });
      expect(stolen.status).toBe(409);
      expect(row('SELECT account_id FROM mail_domains WHERE domain = ?', 'shop.alice.com').account_id).toBe(accountId('bob'));
      expect(names().filter((n) => n.startsWith('vmail.') || n.startsWith('files.'))).toEqual([]);
      db().prepare("DELETE FROM mail_domains WHERE domain = 'shop.alice.com'").run();
    });

    it('lists only the account\'s mailboxes with usage from doveadm', async () => {
      const res = await alice.get('/email/accounts').expect(200);
      expect(res.body.data.map((m) => m.address)).toEqual(['info@alice.com', 'sales@alice.com']);
      expect(res.body.data[0].usage).toMatchObject({ bytes: 4096, messages: 3, source: 'dovecot' });
      expect(res.body.meta).toMatchObject({ total: 2, used: 2, limits: { max_email: 5 } });
      expect(app.agent.callsTo('vmail.quota.get').map((c) => c.args.user)).toEqual(['info@alice.com', 'sales@alice.com']);
      const none = await bob.get('/email/accounts').expect(200);
      expect(none.body.data).toEqual([]);
      const filtered = await alice.get('/email/accounts?domain=bob.com');
      expect(filtered.status).toBe(404);
    });

    it('password, quota and suspension rewrite the passwd line with the stored hash; cross-account ids are 404', async () => {
      const id = row("SELECT id FROM mail_accounts WHERE local_part = 'info'").id;
      for (const call of [() => bob.put(`/email/accounts/${id}/password`, { password: 'Another-Passw0rd!' }), () => bob.put(`/email/accounts/${id}/quota`, { quotaMb: 1 }), () => bob.patch(`/email/accounts/${id}`, { suspended: true }), () => bob.del(`/email/accounts/${id}`), () => bob.get(`/email/accounts/${id}/client-settings`)]) {
        const res = await call();
        expect(res.status).toBe(404);
      }
      expect(names().filter((n) => n.startsWith('vmail.'))).toEqual([]);

      app.agent.set('vmail.hash', () => ({ hash: '$6$newsalt$' + 'b'.repeat(86) }));
      const pw = await alice.put(`/email/accounts/${id}/password`, { password: 'Another-Passw0rd!' });
      expect(pw.status, JSON.stringify(pw.body)).toBe(200);
      expect(app.agent.callsTo('vmail.passwd.set')[0].args).toMatchObject({ localPart: 'info', hash: '$6$newsalt$' + 'b'.repeat(86), quotaBytes: 512 * 1024 * 1024, disabled: false });
      expect(row('SELECT password_hash FROM mail_accounts WHERE id = ?', id).password_hash).toBe('$6$newsalt$' + 'b'.repeat(86));

      const q = await alice.put(`/email/accounts/${id}/quota`, { quotaMb: null }).expect(200);
      expect(q.body.data.quotaMb).toBe(null);
      expect(app.agent.callsTo('vmail.passwd.set')[1].args).toMatchObject({ quotaBytes: null, hash: '$6$newsalt$' + 'b'.repeat(86) });

      const s = await alice.patch(`/email/accounts/${id}`, { suspended: true }).expect(200);
      expect(s.body.data.suspended).toBe(true);
      expect(app.agent.callsTo('vmail.passwd.set')[2].args).toMatchObject({ disabled: true });
      expect(row('SELECT suspended FROM mail_accounts WHERE id = ?', id).suspended).toBe(1);
      const bad = await alice.patch(`/email/accounts/${id}`, { suspended: 'yes' });
      expect(bad.status).toBe(422);
    });

    it('client settings come from the mailserver profile and hostname', async () => {
      const id = row("SELECT id FROM mail_accounts WHERE local_part = 'info'").id;
      const res = await alice.get(`/email/accounts/${id}/client-settings`).expect(200);
      expect(res.body.data).toMatchObject({ username: 'info@alice.com', imap: { port: 993, ssl: true }, pop3: { port: 995 }, smtp: { port: 465, alternative: { port: 587, starttls: true } } });
      expect(res.body.data.hostname).toBeTruthy();
    });

    it('deletes the passwd line and the row, removing the maildir only when asked (as the account)', async () => {
      const id = row("SELECT id FROM mail_accounts WHERE local_part = 'sales'").id;
      const res = await alice.del(`/email/accounts/${id}?removeMail=true`).expect(200);
      expect(res.body.data).toMatchObject({ removed: true, mailRemoved: true });
      expect(names()).toEqual(['vmail.passwd.remove', 'files.remove']);
      expect(app.agent.callsTo('files.remove')[0].args).toEqual({ username: 'alice', paths: ['/home/alice/mail/alice.com/sales'] });
      expect(row('SELECT id FROM mail_accounts WHERE id = ?', id)).toBeUndefined();
      const again = await alice.del(`/email/accounts/${id}`);
      expect(again.status).toBe(404);
    });
  });

  describe('forwarders and default address', () => {
    it('refuses pipes, files, includes, expansions and option-shaped destinations', async () => {
      for (const destination of ['|/usr/bin/vacation', '/home/alice/mail/x', ':include:/etc/passwd', '${run{/bin/sh}}', ':defer:', 'a@b', '-a@b.com', 'a@b.com, c@d.com', 'a@b.com\nroot: x', "o'neil@b.com", '']) {
        const res = await alice.post('/email/forwarders', { domain: 'alice.com', localPart: 'fwd', destination });
        expect(res.status, destination).toBe(422);
      }
      expect(names().filter((n) => n.startsWith('vmail.'))).toEqual([]);
    });

    it('inserts the row then renders the domain file with structured entries; foreign domains are 404', async () => {
      const foreign = await alice.post('/email/forwarders', { domain: 'bob.com', localPart: 'x', destination: 'a@b.com' });
      expect(foreign.status).toBe(404);
      const res = await alice.post('/email/forwarders', { domain: 'alice.com', localPart: 'fwd', destination: 'Someone@Example.ORG' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ address: 'fwd@alice.com', destination: 'someone@example.org', catchAll: false });
      await alice.post('/email/forwarders', { domain: 'alice.com', localPart: 'fwd', destination: 'other@example.org' }).expect(201);
      const dup = await alice.post('/email/forwarders', { domain: 'alice.com', localPart: 'fwd', destination: 'other@example.org' });
      expect(dup.status).toBe(409);
      const self = await alice.post('/email/forwarders', { domain: 'alice.com', localPart: 'fwd', destination: 'fwd@alice.com' });
      expect(self.status).toBe(422);
      const last = app.agent.callsTo('vmail.aliases.write').pop().args;
      expect(last).toEqual({ domain: 'alice.com', entries: [{ localPart: 'fwd', targets: ['someone@example.org', 'other@example.org'] }] });
      const list = await alice.get('/email/forwarders?domain=alice.com').expect(200);
      expect(list.body.data).toHaveLength(2);
      expect((await bob.get('/email/forwarders').expect(200)).body.data).toEqual([]);
    });

    it('restores the rows when the host write fails', async () => {
      app.agent.fail('vmail.aliases.write', 'config_invalid', 'exim rejected it');
      const before = rows("SELECT id, destination FROM mail_forwarders WHERE domain = 'alice.com' ORDER BY id");
      const res = await alice.post('/email/forwarders', { domain: 'alice.com', localPart: 'broken', destination: 'x@example.org' });
      expect(res.status).toBe(422);
      expect(rows("SELECT id, destination FROM mail_forwarders WHERE domain = 'alice.com' ORDER BY id")).toEqual(before);
    });

    it('default address: catch-all row rendered as "*", only one per domain', async () => {
      expect((await alice.get('/email/domains/alice.com/default').expect(200)).body.data).toMatchObject({ action: 'fail', configured: false });
      const fwd = await alice.put('/email/domains/alice.com/default', { action: 'forward' });
      expect(fwd.status).toBe(422);
      const set = await alice.put('/email/domains/alice.com/default', { action: 'forward', destination: 'catch@example.org' }).expect(200);
      expect(set.body.data).toMatchObject({ action: 'forward', destination: 'catch@example.org', configured: true });
      await alice.put('/email/domains/alice.com/default', { action: 'blackhole' }).expect(200);
      expect(rows("SELECT destination FROM mail_forwarders WHERE domain = 'alice.com' AND local_part IS NULL")).toEqual([{ destination: ':blackhole:' }]);
      const last = app.agent.callsTo('vmail.aliases.write').pop().args;
      expect(last.entries).toEqual(expect.arrayContaining([{ localPart: '*', targets: [':blackhole:'] }]));
      expect((await alice.get('/email/forwarders').expect(200)).body.data.every((f) => !f.catchAll)).toBe(true);
      const foreign = await bob.put('/email/domains/alice.com/default', { action: 'fail' });
      expect(foreign.status).toBe(404);
    });

    it('deleting a forwarder re-renders, and removes the file once the domain has none', async () => {
      const ids = rows("SELECT id FROM mail_forwarders WHERE domain = 'alice.com' ORDER BY id").map((r) => r.id);
      const foreign = await bob.del(`/email/forwarders/${ids[0]}`);
      expect(foreign.status).toBe(404);
      for (const id of ids) await alice.del(`/email/forwarders/${id}`).expect(200);
      expect(names().slice(-1)).toEqual(['vmail.aliases.remove']);
      expect(rows("SELECT id FROM mail_forwarders WHERE domain = 'alice.com'")).toEqual([]);
    });

    it('domain forwarder: full rewrite of the list, pinned to the account', async () => {
      const self = await alice.put('/email/domains/alice.com/forward', { targetDomain: 'alice.com' });
      expect(self.status).toBe(422);
      const res = await alice.put('/email/domains/alice.com/forward', { targetDomain: 'example.org' }).expect(200);
      expect(res.body.data).toMatchObject({ domain: 'alice.com', targetDomain: 'example.org', configured: true });
      expect(app.agent.callsTo('vmail.domainfwd.write').pop().args).toEqual({ entries: [{ domain: 'alice.com', target: 'example.org' }] });
      const bobView = await bob.get('/email/domains/alice.com/forward');
      expect(bobView.status).toBe(404);
      await alice.del('/email/domains/alice.com/forward').expect(200);
      expect(app.agent.callsTo('vmail.domainfwd.write').pop().args).toEqual({ entries: [] });
      expect((await alice.del('/email/domains/alice.com/forward')).status).toBe(404);
    });
  });

  describe('autoresponders', () => {
    it('headers must be single lines; address must be at an account domain', async () => {
      for (const body of [
        { address: 'away@alice.com', subject: 'Out\nBcc: x', body: 'b' },
        { address: 'away@alice.com', subject: 'Away', fromName: 'A\rB', body: 'b' },
        { address: 'away@alice.com', subject: '', body: 'b' },
        { address: 'away@alice.com', subject: 'Away', body: 'b', charset: 'utf 8' },
        { address: 'away@alice.com', subject: 'Away', body: 'b', intervalHours: 721 },
        { address: 'away@alice.com', subject: 'Away', body: 'b', startAt: 'tomorrow' },
        { address: 'Away@alice.com', subject: 'Away', body: 'b', extra: 1 },
      ]) {
        const res = await alice.post('/email/autoresponders', body);
        expect(res.status, JSON.stringify(body)).toBe(422);
      }
      const foreign = await alice.post('/email/autoresponders', { address: 'away@bob.com', subject: 'Away', body: 'b' });
      expect(foreign.status).toBe(404);
      expect(names().filter((n) => n.startsWith('vmail.'))).toEqual([]);
    });

    it('writes the files first, then the row; update and delete follow the same order', async () => {
      const res = await alice.post('/email/autoresponders', { address: 'away@alice.com', subject: 'Out of office', fromName: 'Alice', body: 'Back soon', intervalHours: 12, startAt: '2026-01-01T00:00:00Z' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ address: 'away@alice.com', subject: 'Out of office', intervalHours: 12, enabled: true });
      expect(app.agent.callsTo('vmail.autoresponder.write')[0].args).toEqual({ domain: 'alice.com', localPart: 'away', fromName: 'Alice', subject: 'Out of office', body: 'Back soon', charset: 'utf-8', intervalHours: 12, startAt: '2026-01-01T00:00:00Z' });
      const id = res.body.data.id;
      const dup = await alice.post('/email/autoresponders', { address: 'away@alice.com', subject: 'x', body: 'b' });
      expect(dup.status).toBe(409);
      const foreign = await bob.put(`/email/autoresponders/${id}`, { subject: 'hijack' });
      expect(foreign.status).toBe(404);
      const off = await alice.put(`/email/autoresponders/${id}`, { enabled: false }).expect(200);
      expect(off.body.data.enabled).toBe(false);
      expect(names().slice(-1)).toEqual(['vmail.autoresponder.remove']);
      const on = await alice.put(`/email/autoresponders/${id}`, { enabled: true, subject: 'Still away' }).expect(200);
      expect(on.body.data).toMatchObject({ enabled: true, subject: 'Still away', intervalHours: 12 });
      expect(app.agent.callsTo('vmail.autoresponder.write').pop().args).toMatchObject({ subject: 'Still away', intervalHours: 12 });
      const empty = await alice.put(`/email/autoresponders/${id}`, {});
      expect(empty.status).toBe(422);
      expect((await bob.get('/email/autoresponders').expect(200)).body.data).toEqual([]);
      await alice.del(`/email/autoresponders/${id}`).expect(200);
      expect(row('SELECT id FROM mail_autoresponders WHERE id = ?', id)).toBeUndefined();
      expect(rows("SELECT action FROM audit_log WHERE action LIKE 'panel.email.autoresponder.%' AND target = 'alice' ORDER BY id").map((r) => r.action)).toEqual(['panel.email.autoresponder.create', 'panel.email.autoresponder.update', 'panel.email.autoresponder.update', 'panel.email.autoresponder.delete']);
    });
  });

  describe('spam settings', () => {
    it('renders user_prefs as the account and the Exim per-domain list', async () => {
      expect((await alice.get('/email/spam').expect(200)).body.data).toMatchObject({ enabled: false, requiredScore: 5, configured: false, available: true });
      const bad = await alice.put('/email/spam', { enabled: true, requiredScore: 5.55 });
      expect(bad.status).toBe(422);
      const badList = await alice.put('/email/spam', { whitelist: ['|cmd@x.com'] });
      expect(badList.status).toBe(422);
      const res = await alice.put('/email/spam', { enabled: true, requiredScore: 4.5, autoDelete: true, autoDeleteScore: 12, whitelist: ['Friend@Example.org'], blacklist: ['spam@evil.test'] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ enabled: true, requiredScore: 4.5, autoDelete: true, autoDeleteScore: 12, whitelist: ['friend@example.org'], blacklist: ['spam@evil.test'], configured: true });
      expect(names()).toEqual(['files.mkdir', 'files.write', 'vmail.spam_users.write']);
      expect(app.agent.callsTo('files.mkdir')[0].args).toEqual({ username: 'alice', path: '/home/alice/.spamassassin', mode: '0700' });
      const write = app.agent.callsTo('files.write')[0].args;
      expect(write).toMatchObject({ username: 'alice', path: '/home/alice/.spamassassin/user_prefs', mode: '0600' });
      expect(write.content.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['required_score 4.5', 'whitelist_from friend@example.org', 'blacklist_from spam@evil.test']);
      expect(app.agent.callsTo('vmail.spam_users.write')[0].args.entries).toEqual(expect.arrayContaining([
        { domain: 'alice.com', username: 'alice', enabled: true, threshold: 45, autoDelete: true },
        { domain: 'shop.alice.com', username: 'alice', enabled: true, threshold: 45, autoDelete: true },
      ]));
      const lower = await alice.put('/email/spam', { autoDeleteScore: 2 });
      expect(lower.status).toBe(422);
    });

    it('rolls the row back when the host write fails and 501s without SpamAssassin', async () => {
      app.agent.fail('vmail.spam_users.write', 'capability_missing', 'no exim');
      const res = await alice.put('/email/spam', { requiredScore: 9 });
      expect(res.status).toBe(501);
      expect(row('SELECT required_score FROM mail_spam_settings WHERE account_id = ?', accountId('alice')).required_score).toBe(4.5);
      app.agent.set('vmail.spam_users.write', OVERRIDES['vmail.spam_users.write']);
      app.agent.set('sys.binaries', ({ names: ns }) => Object.fromEntries(ns.map((n) => [n, PRESENT.has(n) && !['spamd', 'spamassassin'].includes(n)])));
      await app.ctx.capabilities.refresh();
      const missing = await alice.put('/email/spam', { requiredScore: 9 });
      expect(missing.status).toBe(501);
      app.agent.set('sys.binaries', OVERRIDES['sys.binaries']);
      await app.ctx.capabilities.refresh();
    });

    it('renders prefs deterministically', () => {
      expect(renderUserPrefs({ enabled: false, requiredScore: 5, whitelist: [], blacklist: [] })).toContain('required_score 5.0');
      expect(renderUserPrefs({ enabled: true, requiredScore: 3.2, whitelist: ['a@b.c'], blacklist: [] })).toMatch(/\nwhitelist_from a@b\.c\n/);
    });
  });

  describe('deliverability, DKIM, webmail, usage', () => {
    it('delegates deliverability with the owner principal after its own domain check', async () => {
      const seen = [];
      const original = app.ctx.mail.deliverability.check;
      app.ctx.mail.deliverability.check = async (domain, user) => { seen.push({ domain, user }); return { domain, items: [], score: 0 }; };
      try {
        const foreign = await alice.get('/email/deliverability/bob.com');
        expect(foreign.status).toBe(404);
        const res = await alice.get('/email/deliverability/alice.com').expect(200);
        expect(res.body.data.domain).toBe('alice.com');
        expect(seen).toEqual([{ domain: 'alice.com', user: { id: expect.any(Number), username: 'root', role: 'root' } }]);
      } finally { app.ctx.mail.deliverability.check = original; }
    });

    it('DKIM needs the account\'s own zone and delegates with the owner principal', async () => {
      const seen = [];
      const orig = { ensure: app.ctx.dns.ensureDkim, remove: app.ctx.dns.removeDkim };
      app.ctx.dns.ensureDkim = async (domain, input, user) => { seen.push(['ensure', domain, input, user.username]); return { domain, dkim: true }; };
      app.ctx.dns.removeDkim = async (domain, user) => { seen.push(['remove', domain, user.username]); return { domain, dkim: false }; };
      try {
        db().prepare("UPDATE dns_zones SET account_id = ? WHERE domain = 'alice.com'").run(accountId('bob'));
        const notMine = await alice.post('/email/dkim/alice.com', {});
        expect(notMine.status).toBe(404);
        db().prepare("UPDATE dns_zones SET account_id = ? WHERE domain = 'alice.com'").run(accountId('alice'));
        await alice.post('/email/dkim/alice.com', { rotate: true }).expect(200);
        await alice.del('/email/dkim/alice.com').expect(200);
        const foreign = await alice.post('/email/dkim/bob.com', {});
        expect(foreign.status).toBe(404);
        expect(seen).toEqual([['ensure', 'alice.com', { rotate: true }, 'root'], ['remove', 'alice.com', 'root']]);
        expect((await alice.get('/email/dkim/alice.com').expect(200)).body.data).toMatchObject({ domain: 'alice.com', zone: true });
      } finally { app.ctx.dns.ensureDkim = orig.ensure; app.ctx.dns.removeDkim = orig.remove; }
    });

    it('webmail link from detection or the panel setting, prefilled with one of the account\'s mailboxes', async () => {
      const res = await alice.get('/email/webmail?user=info@alice.com').expect(200);
      expect(res.body.data).toMatchObject({ installed: true, flavor: 'roundcube', prefillUser: 'info@alice.com' });
      expect(res.body.data.url).toMatch(/^https:\/\/.+\/roundcube\/$/);
      const foreign = await alice.get('/email/webmail?user=info@bob.com').expect(200);
      expect(foreign.body.data.prefillUser).toBe('info@alice.com');
      app.ctx.settings.set('panel.webmail_url', 'https://mail.example.test/');
      expect((await alice.get('/email/webmail').expect(200)).body.data.url).toBe('https://mail.example.test/');
      app.ctx.settings.set('panel.webmail_url', '');
    });

    it('usage is post-filtered to the account\'s exact domains and mailboxes', async () => {
      const orig = { delivery: app.ctx.mail.reports.delivery, summary: app.ctx.mail.stats.summary };
      app.ctx.mail.reports.delivery = async () => ({ data: [
        { key: '1:0', id: 'A1', arrivedAt: '2026-11-03T10:00:00Z', sender: 'info@alice.com', recipient: 'x@example.org', status: 'delivered' },
        { key: '2:0', id: 'A2', arrivedAt: '2026-11-03T10:01:00Z', sender: 'y@example.org', recipient: 'info@alice.com', status: 'delivered' },
        { key: '3:0', id: 'A3', arrivedAt: '2026-11-03T10:02:00Z', sender: 'z@notalice.com', recipient: 'q@notexample.com', status: 'failed' },
        { key: '4:0', id: 'A4', arrivedAt: '2026-11-03T10:03:00Z', sender: 'bob@bob.com', recipient: 'w@example.org', status: 'failed' },
        { key: '5:0', id: 'A5', arrivedAt: '2026-11-03T10:04:00Z', sender: 'info@alice.com', recipient: 'nope@example.org', status: 'failed' },
      ], meta: { logFrom: null, logTruncated: false, logExists: true } });
      app.ctx.mail.stats.summary = async () => ({ topDomains: [{ domain: 'alice.com', delivered: 1, failed: 0, deferred: 0 }, { domain: 'notexample.com', delivered: 0, failed: 1, deferred: 0 }, { domain: 'bob.com', delivered: 0, failed: 1, deferred: 0 }] });
      try {
        const res = await alice.get('/email/usage?sinceHours=48').expect(200);
        expect(res.body.data.totals).toMatchObject({ messages: 3, sent: 2, received: 1, delivered: 2, failed: 1 });
        expect(res.body.data.recent.map((r) => r.id)).toEqual(['A1', 'A2', 'A5']);
        expect(res.body.data.byDomain.map((d) => d.domain)).toEqual(['alice.com']);
        expect(res.body.data.mailboxes).toEqual([{ address: 'info@alice.com', sent: 2, received: 1, failed: 1 }]);
        expect(res.body.data.hours).toBe(48);
        const tooLong = await alice.get('/email/usage?sinceHours=169');
        expect(tooLong.status).toBe(422);
      } finally { app.ctx.mail.reports.delivery = orig.delivery; app.ctx.mail.stats.summary = orig.summary; }
    });

    it('reports the S4 wiring as advisor findings and applies the seam idempotently', async () => {
      const findings = await app.ctx.panelEmail.advisorFindings();
      expect(findings.map((f) => [f.id, f.grade])).toEqual([['panel.mail.router', 'warning'], ['panel.mail.auth', 'ok']]);
      const real = await app.ctx.panelEmail.ensureVirtualMail(null, { force: true });
      expect(typeof real.applied).toBe('boolean');
      const original = app.ctx.web.applyVirtualMail;
      const seen = [];
      app.ctx.web.applyVirtualMail = async (input) => { seen.push(input); return { enabled: input.enabled, rendered: true }; };
      try {
        expect(await app.ctx.panelEmail.ensureVirtualMail(null, { force: true })).toMatchObject({ applied: true, enabled: true, rendered: true });
        expect(await app.ctx.panelEmail.ensureVirtualMail(null)).toMatchObject({ applied: true });
        expect(seen).toEqual([{ enabled: true }]);
        app.ctx.web.applyVirtualMail = undefined;
        expect(await app.ctx.panelEmail.ensureVirtualMail(null, { force: true })).toMatchObject({ applied: false });
      } finally { app.ctx.web.applyVirtualMail = original; }
    });
  });

  describe('helpers', () => {
    it('auditArgs records the real actor while impersonating; limitOf takes the higher of plan and enhancement', () => {
      const scope = { mode: 'acting', username: 'alice', actingAs: { by: 'root' }, actor: { username: 'root' } };
      expect(auditArgs(scope, { address: 'a@b.c' })).toEqual({ address: 'a@b.c', actingAs: 'alice', by: 'root' });
      expect(auditArgs({ mode: 'user', username: 'alice' }, { x: 1 })).toEqual({ x: 1 });
      expect(limitOf({ account: { plan: { max_email: 5 } }, limits: { max_email: 8 } }, 'max_email')).toBe(8);
      expect(limitOf({ account: { plan: {} }, limits: {} }, 'max_email')).toBe(null);
    });
  });
});
