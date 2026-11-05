import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
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
    'vmail.passwd.purge': ({ domain }) => ({ domain, removed: true, users: [] }),
    'vmail.quota.get': ({ user }) => ({ user, bytes: 4096, limitBytes: 1073741824, messages: 3 }),
    'vmail.aliases.write': ({ domain, entries }) => ({ domain, entries: entries.length }),
    'vmail.aliases.remove': ({ domain }) => ({ domain, removed: true }),
    'vmail.domainfwd.write': ({ entries }) => ({ entries: entries.length }),
    'vmail.autoresponder.write': ({ domain, localPart }) => ({ domain, localPart }),
    'vmail.autoresponder.remove': ({ domain, localPart }) => ({ domain, localPart, removed: true }),
    'vmail.spam_users.write': ({ entries }) => ({ entries: entries.length }),
    'vmail.render.check': () => ({ dovecot: { installed: true, configOk: true }, exim: { installed: true, configOk: true }, routerHooked: false, transportHooked: false, authHooked: true, hint: 'apply' }),
    'web.webmail.detect': () => ({ installed: true, flavor: 'roundcube', path: '/var/lib/roundcube', root: '/var/lib/roundcube/public_html', version: '1.6.6', configured: true, apacheAlias: '/webmail', published: { alias: '/webmail', file: '/etc/apache2/keel-host.d/webmail.conf', managed: true, source: 'keel-host' }, globalAlias: null, config: { path: '/etc/roundcube/config.inc.php', exists: true, ok: null, managed: null } }),
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

    it('never runs the root-level virtual-mail apply from a customer request (invalid body, feature off, acting-as)', async () => {
      const before = app.ctx.settings.get('service_config.virtual_mail', null);
      const original = app.ctx.web.applyVirtualMail;
      const seen = [];
      app.ctx.web.applyVirtualMail = async (...a) => { seen.push(a); return { applied: true }; };
      try {
        expect((await alice.post('/email/accounts', {})).status).toBe(422);
        setFeature(app, 'alice', 'emailaccts', false);
        expect((await alice.post('/email/accounts', { localPart: 'x', domain: 'alice.com', password: 'Str0ng-Passw0rd!' })).status).toBe(403);
        setFeature(app, 'alice', 'emailaccts', true);
        expect((await alice.put('/email/accounts/1/password', { password: 'Str0ng-Passw0rd!' })).status).toBe(404);
        expect((await alice.patch('/email/accounts/1', { suspended: true })).status).toBe(404);
      } finally { app.ctx.web.applyVirtualMail = original; }
      expect(seen).toEqual([]);
      expect(names().filter((n) => n.startsWith('web.') || n.startsWith('vmail.') || n.startsWith('mail.'))).toEqual([]);
      expect(app.ctx.settings.get('service_config.virtual_mail', null)).toEqual(before);
      expect(rows("SELECT id FROM audit_log WHERE action LIKE 'virtual_mail.%'")).toEqual([]);
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
      // The wiring was never applied on this host: the customer is told, and the apply is queued as a panel job, not run here.
      expect(res.body.meta.warnings.map((w) => w.code)).toEqual(['virtual_mail_not_live']);
      expect(app.ctx.jobs.list({ type: 'panel.virtual_mail.ensure' }).filter((j) => j.status === 'queued')).toHaveLength(1);
      expect(names().filter((n) => n.startsWith('web.'))).toEqual([]);
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
      expect(res.body.meta.warnings.map((w) => w.code)).toEqual(['routing_not_applied', 'virtual_mail_not_live']);
      // A second create while the first apply is still queued does not queue another.
      expect(app.ctx.jobs.list({ type: 'panel.virtual_mail.ensure' }).filter((j) => j.status === 'queued')).toHaveLength(1);
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
      // Only what Exim really listens on: port 25 with STARTTLS until the operator enables the submission ports, and no AUTH until the wiring is live.
      expect(res.body.data).toMatchObject({ username: 'info@alice.com', imap: { port: 993, ssl: true }, pop3: { port: 995 }, smtp: { port: 25, ssl: false, starttls: true, alternative: null, auth: null, submissionPorts: false, ports: { enabled: false, port465: false, port587: false } } });
      expect(res.body.data.hostname).toBeTruthy();
      // The sheet carries the wiring state, the password rule and the service certificate (none installed here).
      expect(res.body.data.virtualMailLive).toBe(false);
      expect(res.body.data.warnings.map((w) => w.code)).toEqual(['virtual_mail_not_live']);
      expect(res.body.data.passwordPolicy).toEqual({ context: 'email', minLength: 8, minStrength: expect.any(Number) });
      expect(res.body.data.certificate).toEqual({ dovecot: null, exim: null });
      const exim = app.ctx.settings.get('service_config.exim', null);
      app.ctx.settings.set('service_config.exim', { ...(exim || {}), submissionPorts: true, tls: null });
      try {
        // Submission ports without the Exim TLS preset: 587/STARTTLS only, 465 is not listening.
        expect((await alice.get(`/email/accounts/${id}/client-settings`).expect(200)).body.data.smtp).toMatchObject({ port: 587, ssl: false, starttls: true, alternative: null, submissionPorts: true, ports: { enabled: true, port465: false, port587: true } });
        app.ctx.settings.set('service_config.exim', { ...(exim || {}), submissionPorts: true, tls: { minProtocol: 'TLSv1.2', protocols: ['TLSv1.2', 'TLSv1.3'], cipherList: '', cipherSuites: '', preferServerCiphers: false } });
        expect((await alice.get(`/email/accounts/${id}/client-settings`).expect(200)).body.data.smtp).toMatchObject({ port: 465, ssl: true, alternative: { port: 587, starttls: true }, submissionPorts: true, ports: { enabled: true, port465: true, port587: true } });
      } finally { app.ctx.settings.set('service_config.exim', exim); }
    });

    it('names the hostname certificate the mail daemons present and flags a name mismatch', async () => {
      const id = row("SELECT id FROM mail_accounts WHERE local_part = 'info'").id;
      const host = app.ctx.settings.get('basic.hostname');
      const cert = (cn, sans) => ({ daemonPresent: true, hasCertificate: true, paths: {}, certificate: { commonName: cn, sans, issuerOrganization: "Let's Encrypt", issuerCommonName: 'R11', selfSigned: false, notAfter: '2027-01-01T00:00:00.000Z' } });
      const original = app.ctx.ssl.serviceCertStatus;
      app.ctx.ssl.serviceCertStatus = async () => [{ service: 'dovecot', ...cert(host, [host]) }, { service: 'exim', ...cert('other.example', ['other.example']) }];
      try {
        // A fresh service is memoised per minute: force it by calling through a new service instance.
        const { createPanelEmailService } = await import('../src/services/panel-email.js');
        const fresh = createPanelEmailService(app.ctx);
        const scope = app.ctx.panel.scope({ user: app.ctx.db.prepare("SELECT * FROM users WHERE username = 'alice'").get(), panel: null });
        const data = await fresh.accounts.clientSettings(scope, id);
        expect(data.certificate.dovecot).toMatchObject({ name: host, issuer: "Let's Encrypt", selfSigned: false, matchesHostname: true });
        expect(data.certificate.exim).toMatchObject({ name: 'other.example', matchesHostname: false });
      } finally { app.ctx.ssl.serviceCertStatus = original; }
    });

    it('lists the wiring warning and the password policy even before the first mailbox exists', async () => {
      const res = await bob.get('/email/accounts').expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.warnings.map((w) => w.code)).toEqual(['virtual_mail_not_live']);
      expect(res.body.meta.passwordPolicy).toEqual({ context: 'email', minLength: 8, minStrength: expect.any(Number) });
      // The policy follows Security Center's email context, then the server-wide minimum.
      const before = app.ctx.settings.get('security.password.strength.email', null);
      app.ctx.settings.set('security.password.strength.email', 90);
      try { expect((await bob.get('/email/accounts').expect(200)).body.meta.passwordPolicy.minStrength).toBe(90); } finally { app.ctx.settings.set('security.password.strength.email', before); }
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
      expect(app.agent.callsTo('vmail.autoresponder.write')[0].args).toEqual({ domain: 'alice.com', localPart: 'away', fromName: 'Alice', subject: 'Out of office', body: 'Back soon', charset: 'utf-8', intervalHours: 12, startAt: '2026-01-01T00:00:00Z', enabled: true });
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
      // The availability probe runs before anything is written.
      expect(names()).toEqual(['web.exim.detect', 'mail.spamd.config.read', 'web.exim.detect', 'mail.spamd.config.read', 'files.mkdir', 'files.write', 'vmail.spam_users.write']);
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

    it('reports available:false and refuses saves on a light Exim build (501) or a stopped spamd (422)', async () => {
      const heavy = { installed: true, flavor: 'debian', version: '4.97', features: ['DKIM', 'SPF', 'Content_Scanning'], slots: {} };
      app.agent.set('web.exim.detect', () => ({ ...heavy, features: ['DKIM', 'SPF'] }));
      try {
        // A save re-probes the host before anything is written; the read that follows reuses that answer.
        const light = await alice.put('/email/spam', { requiredScore: 6 });
        expect(light.status).toBe(501);
        expect(light.body.error.message).toMatch(/content scanning/);
        expect(names()).not.toContain('files.write');
        expect(row('SELECT required_score FROM mail_spam_settings WHERE account_id = ?', accountId('alice')).required_score).toBe(4.5);
        const get = await alice.get('/email/spam').expect(200);
        expect(get.body.data).toMatchObject({ available: false, reason: 'exim_no_content_scan', requiredScore: 4.5, exim: { installed: true, contentScan: false, version: '4.97' } });
        expect(get.body.data.detail).toMatch(/exim4-daemon-heavy/);
        // The advisor seam counts the accounts whose saved settings depend on it.
        expect(await app.ctx.panelEmail.spamStatus()).toMatchObject({ available: false, reason: 'exim_no_content_scan', configuredAccounts: 1 });
        const scan = await app.http.post('/api/security/advisor/scan').set('X-CSRF-Token', csrf);
        expect(scan.status, JSON.stringify(scan.body)).toBe(200);
        expect(scan.body.data.findings.find((f) => f.id === 'panel.spam.scanning')).toMatchObject({ grade: 'warning', title: expect.stringMatching(/no content scanning while 1 account has spam settings/), fix: { path: '/service-configuration/exim-configuration-manager' } });

        app.agent.set('web.exim.detect', () => heavy);
        app.agent.set('mail.spamd.config.read', () => ({ installed: true, unit: { name: 'spamd', active: 'inactive', enabled: 'enabled' } }));
        const stopped = await alice.put('/email/spam', { requiredScore: 6 });
        expect(stopped.status).toBe(422);
        expect(stopped.body.error.code).toBe('spamd_not_running');
        expect((await alice.get('/email/spam').expect(200)).body.data).toMatchObject({ available: false, reason: 'spamd_not_running', spamd: { installed: true, active: false, unit: { name: 'spamd' } } });
        expect(scan.status).toBe(200);
        const again = await app.http.post('/api/security/advisor/scan').set('X-CSRF-Token', csrf);
        expect(again.body.data.findings.find((f) => f.id === 'panel.spam.scanning')).toMatchObject({ grade: 'warning', fix: { path: '/email/spamd-startup-configuration' } });

        app.agent.set('mail.spamd.config.read', () => ({ installed: true, unit: { name: 'spamd', active: 'active', enabled: 'enabled' } }));
        expect((await alice.put('/email/spam', { requiredScore: 6 })).status).toBe(200);
        expect((await alice.get('/email/spam').expect(200)).body.data).toMatchObject({ available: true, reason: null, requiredScore: 6, exim: { contentScan: true }, spamd: { active: true } });
        expect((await app.http.post('/api/security/advisor/scan').set('X-CSRF-Token', csrf)).body.data.findings.find((f) => f.id === 'panel.spam.scanning')).toMatchObject({ grade: 'ok' });
        await alice.put('/email/spam', { requiredScore: 4.5 }).expect(200);
      } finally { app.agent.reset('web.exim.detect'); app.agent.reset('mail.spamd.config.read'); await app.ctx.web.spamScanning({ fresh: true }); }
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

    it('hands the SPF/DKIM/DMARC records back to copy instead of writing BIND when public DNS is elsewhere', async () => {
      const originals = { check: app.ctx.mail.deliverability.check, fix: app.ctx.mail.deliverability.fix };
      const report = { domain: 'alice.com', zone: true, score: 20, items: [
        { id: 'spf', label: 'SPF', status: 'missing', current: [], expected: 'v=spf1 +mx ~all', fixable: true },
        { id: 'dkim', label: 'DKIM', selector: 'default', status: 'missing', current: [], expected: null, fixable: true },
        { id: 'dmarc', label: 'DMARC', status: 'ok', current: ['v=DMARC1; p=none'], expected: 'v=DMARC1; p=none; rua=mailto:postmaster@alice.com', fixable: true },
      ] };
      let fixCalls = 0;
      app.ctx.mail.deliverability.check = async () => report;
      app.ctx.mail.deliverability.fix = async () => { fixCalls += 1; return { domain: 'alice.com', results: {}, status: report }; };
      app.agent.set('dns.resolve', ({ name, type }) => ({ name, type, servers: [], answers: type === 'NS' && name === 'alice.com' ? ['ns1.cloud.example.'] : type === 'A' && name === 'ns1.cloud.example' ? ['198.51.100.9'] : [], error: null }));
      try {
        await app.ctx.panelDns.delegation('alice.com', { fresh: true });
        const check = await alice.get('/email/deliverability/alice.com').expect(200);
        expect(check.body.data.delegation).toMatchObject({ delegatedHere: false, delegatedNs: ['ns1.cloud.example'] });
        expect(check.body.data.records).toEqual([
          { id: 'spf', name: 'alice.com', type: 'TXT', value: 'v=spf1 +mx ~all', status: 'missing' },
          { id: 'dmarc', name: '_dmarc.alice.com', type: 'TXT', value: 'v=DMARC1; p=none; rua=mailto:postmaster@alice.com', status: 'ok' },
        ]);
        app.agent.calls.length = 0;
        const fix = await alice.post('/email/deliverability/alice.com/fix', { items: ['spf', 'dkim'] });
        expect(fix.status, JSON.stringify(fix.body)).toBe(200);
        expect(fix.body.data).toMatchObject({ applied: false, reason: 'not_delegated', results: { spf: { ok: true, applied: false, reason: 'not_delegated', record: { name: 'alice.com', type: 'TXT', value: 'v=spf1 +mx ~all' } }, dkim: { ok: false } } });
        expect(fix.body.data.results.dkim.error).toMatch(/Generate the DKIM key first/);
        expect(fixCalls).toBe(0);
        expect(names()).not.toContain('dns.zone.write');
        expect(row("SELECT args_redacted FROM audit_log WHERE action = 'panel.email.deliverability.fix' AND target = 'alice' ORDER BY id DESC LIMIT 1").args_redacted).toContain('"written":false');
        // Delegated here: the delegate writes the zone as before.
        app.agent.set('dns.resolve', ({ name, type }) => ({ name, type, servers: [], answers: type === 'NS' && name === 'alice.com' ? ['ns1.here.example.'] : type === 'A' && name === 'ns1.here.example' ? ['203.0.113.5'] : [], error: null }));
        await app.ctx.panelDns.delegation('alice.com', { fresh: true });
        const here = await alice.post('/email/deliverability/alice.com/fix', { items: ['spf'] }).expect(200);
        expect(here.body.data).toMatchObject({ applied: true, delegation: { delegatedHere: true } });
        expect(fixCalls).toBe(1);
      } finally {
        app.ctx.mail.deliverability.check = originals.check;
        app.ctx.mail.deliverability.fix = originals.fix;
        app.agent.reset('dns.resolve');
        await app.ctx.panelDns.delegation('alice.com', { fresh: true });
      }
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

    it('webmail link from the alias published under the FQDN hostname site or the panel setting, prefilled with one of the account\'s mailboxes; the home quick link follows it', async () => {
      const previousHost = app.ctx.settings.get('basic.hostname');
      app.ctx.settings.set('basic.hostname', 'Nova.Example.test');
      try {
        const res = await alice.get('/email/webmail?user=info@alice.com').expect(200);
        expect(res.body.data).toMatchObject({ installed: true, flavor: 'roundcube', version: '1.6.6', url: 'https://nova.example.test/webmail/', alias: '/webmail', published: true, configuredUrl: null, prefillUser: 'info@alice.com' });
        const foreign = await alice.get('/email/webmail?user=info@bob.com').expect(200);
        expect(foreign.body.data.prefillUser).toBe('info@alice.com');
        expect((await alice.get('/overview/quick-links').expect(200)).body.data.webmailUrl).toBe('https://nova.example.test/webmail/');
        app.ctx.settings.set('panel.webmail_url', 'https://mail.example.test/');
        expect((await alice.get('/email/webmail').expect(200)).body.data).toMatchObject({ url: 'https://mail.example.test/', configuredUrl: 'https://mail.example.test/', published: false });
        expect((await alice.get('/overview/quick-links').expect(200)).body.data.webmailUrl).toBe('https://mail.example.test/');
        app.ctx.settings.set('panel.webmail_url', '');
        // A bare hostname cannot carry the site; the raw setting is still the only name to offer.
        app.ctx.settings.set('basic.hostname', 'nova');
        expect((await alice.get('/email/webmail').expect(200)).body.data.url).toBe('https://nova/webmail/');
      } finally { app.ctx.settings.set('panel.webmail_url', ''); app.ctx.settings.set('basic.hostname', previousHost); }
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

    it('reports the S4 wiring as advisor findings and applies the seam idempotently, as the panel, from boot code only', async () => {
      const findings = await app.ctx.panelEmail.advisorFindings();
      expect(findings.map((f) => [f.id, f.grade])).toEqual([['panel.mail.router', 'warning'], ['panel.mail.auth', 'ok']]);
      const before = app.ctx.settings.get('service_config.virtual_mail', null);
      const original = app.ctx.web.applyVirtualMail;
      const seen = [];
      app.ctx.web.applyVirtualMail = async (input, req) => { seen.push([input, req]); return { enabled: input.enabled, rendered: true }; };
      try {
        app.ctx.settings.set('panel.enabled', false);
        expect(await app.ctx.panelEmail.ensureVirtualMail({ user: { username: 'alice' } }, { force: true })).toMatchObject({ applied: false, reason: expect.stringMatching(/panel\.enabled/) });
        app.ctx.settings.set('panel.enabled', true);
        app.ctx.settings.set('service_config.virtual_mail', { enabled: false, spamdAddress: '127.0.0.1 783' });
        expect(await app.ctx.panelEmail.ensureVirtualMail(null, { force: true })).toMatchObject({ applied: false, reason: expect.stringMatching(/Service Configuration/) });
        expect(seen).toEqual([]);
        app.ctx.settings.set('service_config.virtual_mail', null);
        expect(await app.ctx.panelEmail.ensureVirtualMail({ user: { username: 'alice' } }, { force: true })).toMatchObject({ applied: true, enabled: true, rendered: true });
        expect(await app.ctx.panelEmail.ensureVirtualMail(null)).toMatchObject({ applied: true });
        expect(seen).toEqual([[{ enabled: true }, null]]);
        app.ctx.web.applyVirtualMail = async () => { seen.push('fail'); throw new Error('exim -bV failed'); };
        expect(await app.ctx.panelEmail.ensureVirtualMail(null, { force: true })).toMatchObject({ applied: false, reason: 'exim -bV failed' });
        expect(await app.ctx.panelEmail.ensureVirtualMail(null)).toMatchObject({ applied: false, reason: 'exim -bV failed' });
        expect(await app.ctx.panelEmail.ensureVirtualMail(null)).toMatchObject({ applied: false });
        expect(seen.filter((s) => s === 'fail')).toHaveLength(1);
        app.ctx.web.applyVirtualMail = undefined;
        expect(await app.ctx.panelEmail.ensureVirtualMail(null, { force: true })).toMatchObject({ applied: false });
      } finally { app.ctx.web.applyVirtualMail = original; app.ctx.settings.set('service_config.virtual_mail', before); }
    });

    it('runs the apply as the panel job queued at boot / by a mailbox create, and stops warning once the wiring is live', async () => {
      expect(app.ctx.jobs.types()).toContain('panel.virtual_mail.ensure');
      const original = app.ctx.web.applyVirtualMail;
      const seen = [];
      app.ctx.web.applyVirtualMail = async (input, req) => { seen.push([input, req]); return { enabled: true, applied: true, live: false, lastApply: { ok: false, error: 'written, but Exim does not load /etc/exim4/whm/router_whm_virtual_mail.conf' }, manualIncludes: [{ slot: 'router', line: '.include_if_exists /etc/exim4/whm/router_whm_virtual_mail.conf' }] }; };
      const queued = app.ctx.jobs.list({ type: 'panel.virtual_mail.ensure' }).find((j) => j.status === 'queued');
      expect(queued).toBeTruthy();
      try {
        app.ctx.jobs.start();
        // The job queued by the create above runs as the panel; the memoised failure of the previous test is still inside its backoff, so it is a no-op.
        expect((await waitForJob(app.ctx, queued.id)).status).toBe('done');
        expect(seen).toEqual([]);
        const forced = app.ctx.jobs.enqueue('panel.virtual_mail.ensure', { trigger: 'boot', force: true });
        const done = await waitForJob(app.ctx, forced.id);
        expect(done.status).toBe('done');
        expect(done.result).toMatchObject({ applied: true, live: false, manualIncludes: [{ slot: 'router' }] });
        expect(seen).toEqual([[{ enabled: true }, null]]);
        expect(app.ctx.panelEmail.virtualMailLive()).toBe(false);
        // Not live and inside the backoff: a create still warns but queues nothing new.
        const res = await alice.post('/email/accounts', { localPart: 'later', domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.meta.warnings.map((w) => w.code)).toEqual(['virtual_mail_not_live']);
        expect(app.ctx.jobs.list({ type: 'panel.virtual_mail.ensure' }).filter((j) => ['queued', 'running'].includes(j.status))).toHaveLength(0);
        expect((await alice.get('/email/accounts').expect(200)).body.meta.warnings.map((w) => w.code)).toEqual(['virtual_mail_not_live']);
        await alice.del(`/email/accounts/${res.body.data.id}`).expect(200);
        // The admin apply made it live (service-configuration records the outcome): no warning, no job.
        app.ctx.web.applyVirtualMail = async () => ({ enabled: true, applied: true, live: true });
        expect(await app.ctx.panelEmail.ensureVirtualMail(null, { force: true })).toMatchObject({ applied: true, live: true });
        expect(app.ctx.panelEmail.virtualMailLive()).toBe(true);
        const ok = await alice.post('/email/accounts', { localPart: 'live', domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.meta.warnings).toEqual([]);
        expect(app.ctx.jobs.list({ type: 'panel.virtual_mail.ensure' }).filter((j) => ['queued', 'running'].includes(j.status))).toHaveLength(0);
        expect((await alice.get(`/email/accounts/${ok.body.data.id}/client-settings`).expect(200)).body.data.smtp.auth).toBe('password');
        await alice.del(`/email/accounts/${ok.body.data.id}`).expect(200);
      } finally { app.ctx.jobs.stop(); app.ctx.web.applyVirtualMail = original; }
    });

    it('the boot request queues nothing without the panel, without both daemons, or while an apply is already queued', async () => {
      const { jobs, settings, panelEmail } = app.ctx;
      const pending = () => jobs.list({ type: 'panel.virtual_mail.ensure' }).filter((j) => ['queued', 'running'].includes(j.status));
      for (const j of pending()) jobs.cancel(j.id);
      settings.set('panel.enabled', false);
      try { expect(panelEmail.requestVirtualMail('boot')).toBeNull(); } finally { settings.set('panel.enabled', true); }
      expect(pending()).toHaveLength(0);
      app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, PRESENT.has(n) && n !== 'dovecot'])));
      await app.ctx.capabilities.refresh();
      try { expect(panelEmail.requestVirtualMail('boot')).toBeNull(); } finally { restoreAgent(app.agent); await app.ctx.capabilities.refresh(); }
      expect(pending()).toHaveLength(0);
      // Panel on, both daemons present, memo live from the previous test: exactly one job, tagged with its trigger, and none while it waits.
      const job = panelEmail.requestVirtualMail('boot');
      expect(job).toMatchObject({ type: 'panel.virtual_mail.ensure', status: 'queued', params: { trigger: 'boot' } });
      expect(panelEmail.requestVirtualMail('boot')).toBeNull();
      expect(pending()).toHaveLength(1);
      jobs.cancel(job.id);
    });

    it('warns the customer when the operator switched virtual mail off, without touching it', async () => {
      const before = app.ctx.settings.get('service_config.virtual_mail', null);
      app.ctx.settings.set('service_config.virtual_mail', { enabled: false, spamdAddress: '127.0.0.1 783' });
      try {
        const res = await alice.post('/email/accounts', { localPart: 'warned', domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.meta.warnings.map((w) => w.code)).toEqual(['virtual_mail_disabled']);
        expect(app.ctx.settings.get('service_config.virtual_mail', null)).toEqual({ enabled: false, spamdAddress: '127.0.0.1 783' });
        expect(names().filter((n) => n.startsWith('web.'))).toEqual([]);
        await alice.del(`/email/accounts/${res.body.data.id}`).expect(200);
      } finally { app.ctx.settings.set('service_config.virtual_mail', before); }
    });
  });

  describe('domains leaving an account', () => {
    const D = 'shop.alice.com';
    const vmailOps = () => names().filter((n) => n.startsWith('vmail.') || n.startsWith('files.'));
    const rehome = (domain, from, to) => {
      db().prepare('DELETE FROM account_domains WHERE domain = ? AND account_id = ?').run(domain, accountId(from));
      db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, ?, 'addon', ?)").run(accountId(to), domain, `/home/${to}/public_html/shop`);
    };

    it('caps autoresponders per domain', async () => {
      app.ctx.settings.set('panel.mail.max_autoresponders_per_domain', 1);
      try {
        const first = await alice.post('/email/autoresponders', { address: `one@${D}`, subject: 'x', body: 'b' });
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        const second = await alice.post('/email/autoresponders', { address: `two@${D}`, subject: 'x', body: 'b' });
        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe('limit_reached');
        expect(app.agent.callsTo('vmail.autoresponder.write')).toHaveLength(1);
        expect((await alice.get('/email/autoresponders').expect(200)).body.meta.maxPerDomain).toBe(1);
        await alice.del(`/email/autoresponders/${first.body.data.id}`).expect(200);
      } finally { app.ctx.settings.set('panel.mail.max_autoresponders_per_domain', 50); }
    });

    it('refuses to write next to a previous owner\'s leftovers (409 domain_stale) until root releases them', async () => {
      db().prepare("INSERT INTO mail_forwarders (account_id, domain, local_part, destination) VALUES (?, ?, 'old', 'a@attacker.example')").run(accountId('bob'), D);
      try {
        for (const call of [
          () => alice.post('/email/accounts', { localPart: 'ceo', domain: D, password: 'Str0ng-Passw0rd!' }),
          () => alice.post('/email/forwarders', { domain: D, localPart: 'x', destination: 'x@example.org' }),
          () => alice.put(`/email/domains/${D}/default`, { action: 'blackhole' }),
          () => alice.put(`/email/domains/${D}/forward`, { targetDomain: 'example.org' }),
          () => alice.post('/email/autoresponders', { address: `x@${D}`, subject: 'x', body: 'b' }),
        ]) {
          const res = await call();
          expect(res.status).toBe(409);
          expect(res.body.error.code).toBe('domain_stale');
        }
        expect(vmailOps()).toEqual([]);
        expect((await alice.get(`/email/forwarders?domain=${D}`).expect(200)).body.data).toEqual([]);
        const released = await app.ctx.panelEmail.releaseDomain(D, accountId('bob'), null, { username: 'bob' });
        expect(released).toMatchObject({ released: true, rows: { forwarders: 1 } });
      } finally { db().prepare('DELETE FROM mail_forwarders WHERE domain = ? AND account_id = ?').run(D, accountId('bob')); }
      expect(row('SELECT id FROM mail_forwarders WHERE domain = ?', D)).toBeUndefined();
      expect((await alice.put(`/email/domains/${D}/forward`, { targetDomain: 'example.org' })).status).toBe(200);
      await alice.del(`/email/domains/${D}/forward`).expect(200);
    });

    it('by-id mutations are 404 once the row\'s domain left the account, and never render its files', async () => {
      const fwd = await alice.post('/email/forwarders', { domain: D, localPart: 'sales', destination: 'sales@example.org' });
      expect(fwd.status, JSON.stringify(fwd.body)).toBe(201);
      const ar = await alice.post('/email/autoresponders', { address: `away@${D}`, subject: 'Away', body: 'b' });
      expect(ar.status, JSON.stringify(ar.body)).toBe(201);
      const mb = await alice.post('/email/accounts', { localPart: 'ceo', domain: D, password: 'Str0ng-Passw0rd!' });
      expect(mb.status, JSON.stringify(mb.body)).toBe(201);
      rehome(D, 'alice', 'bob');
      app.agent.calls.length = 0;
      try {
        for (const call of [
          () => alice.del(`/email/forwarders/${fwd.body.data.id}`),
          () => alice.put(`/email/autoresponders/${ar.body.data.id}`, { subject: 'hijack' }),
          () => alice.del(`/email/autoresponders/${ar.body.data.id}`),
          () => alice.put(`/email/accounts/${mb.body.data.id}/password`, { password: 'Another-Passw0rd!' }),
          () => alice.put(`/email/accounts/${mb.body.data.id}/quota`, { quotaMb: 1 }),
          () => alice.patch(`/email/accounts/${mb.body.data.id}`, { suspended: true }),
          () => alice.del(`/email/accounts/${mb.body.data.id}?removeMail=true`),
          () => alice.get(`/email/accounts/${mb.body.data.id}`),
        ]) {
          const res = await call();
          expect(res.status).toBe(404);
        }
        expect(vmailOps()).toEqual([]);
        expect(row('SELECT id FROM mail_forwarders WHERE id = ?', fwd.body.data.id)).toBeTruthy();
        expect((await bob.put(`/email/domains/${D}/forward`, { targetDomain: 'example.org' })).body.error.code).toBe('domain_stale');
      } finally { rehome(D, 'bob', 'alice'); }
    });

    it('releaseDomain empties the host state and the rows so the next owner starts clean', async () => {
      await alice.put(`/email/domains/${D}/default`, { action: 'forward', destination: 'catch@attacker.example' }).expect(200);
      await alice.put(`/email/domains/${D}/forward`, { targetDomain: 'attacker.example' }).expect(200);
      expect(rows('SELECT id FROM mail_forwarders WHERE domain = ?', D)).toHaveLength(2);
      app.agent.calls.length = 0;
      app.agent.fail('vmail.passwd.purge', 'command_failed', 'disk full');
      const kept = await app.ctx.panelEmail.releaseDomain(D, accountId('alice'), null, { username: 'alice' });
      expect(kept).toMatchObject({ released: false, rows: null, errors: [{ op: 'vmail.passwd.purge' }] });
      expect(rows('SELECT id FROM mail_forwarders WHERE domain = ?', D)).toHaveLength(2);
      expect(row('SELECT id FROM mail_autoresponders WHERE domain = ?', D)).toBeTruthy();
      expect(names()).not.toContain('vmail.aliases.remove');
      restoreAgent(app.agent);

      const released = await app.ctx.panelEmail.releaseDomain(D, accountId('alice'), null, { username: 'alice' });
      expect(released).toMatchObject({ released: true, autoresponders: 1, passwdPurged: true, aliases: true, domainForward: true, rows: { forwarders: 2, domainForward: 1, autoresponders: 1, mailDomain: 1 } });
      expect(app.agent.callsTo('vmail.autoresponder.remove').map((c) => c.args)).toEqual([{ domain: D, localPart: 'away' }]);
      expect(app.agent.callsTo('vmail.passwd.purge').map((c) => c.args)).toEqual([{ domain: D }]);
      expect(app.agent.callsTo('vmail.aliases.remove').map((c) => c.args)).toEqual([{ domain: D }]);
      expect(app.agent.callsTo('vmail.domainfwd.write').pop().args).toEqual({ entries: [] });
      expect(app.agent.callsTo('vmail.spam_users.write')).toHaveLength(1);
      for (const table of ['mail_forwarders', 'mail_domain_forwarders', 'mail_autoresponders', 'mail_domains']) expect(rows(`SELECT * FROM ${table} WHERE domain = ?`, D), table).toEqual([]);
      expect(rows("SELECT * FROM mail_accounts WHERE local_part = 'ceo'")).toEqual([]);
      expect(rows("SELECT target FROM audit_log WHERE action = 'panel.email.domain.release' ORDER BY id").map((r) => r.target)).toEqual(['bob', 'alice', 'alice']);
      expect(await app.ctx.panelEmail.releaseDomain(D, accountId('alice'), null)).toMatchObject({ released: true, rows: { forwarders: 0, domainForward: 0, autoresponders: 0, mailDomain: 0 } });

      rehome(D, 'alice', 'bob');
      app.agent.calls.length = 0;
      try {
        const fwd = await bob.put(`/email/domains/${D}/forward`, { targetDomain: 'bob.example' });
        expect(fwd.status, JSON.stringify(fwd.body)).toBe(200);
        expect(app.agent.callsTo('vmail.domainfwd.write').pop().args).toEqual({ entries: [{ domain: D, target: 'bob.example' }] });
        const f = await bob.post('/email/forwarders', { domain: D, localPart: 'hello', destination: 'hello@bob.example' });
        expect(f.status, JSON.stringify(f.body)).toBe(201);
        expect(app.agent.callsTo('vmail.aliases.write').pop().args).toEqual({ domain: D, entries: [{ localPart: 'hello', targets: ['hello@bob.example'] }] });
        const mb = await bob.post('/email/accounts', { localPart: 'ceo', domain: D, password: 'Str0ng-Passw0rd!' });
        expect(mb.status, JSON.stringify(mb.body)).toBe(201);
        expect(row('SELECT account_id FROM mail_domains WHERE domain = ?', D).account_id).toBe(accountId('bob'));
        expect(app.agent.callsTo('vmail.passwd.set').pop().args).toMatchObject({ domain: D, localPart: 'ceo', username: 'bob' });
        expect(await app.ctx.panelEmail.releaseDomain(D, accountId('bob'), null, { username: 'bob' })).toMatchObject({ released: true, rows: { forwarders: 1, domainForward: 1, mailDomain: 1 } });
      } finally { rehome(D, 'bob', 'alice'); }
    });

    it('terminating an account releases every domain after the cascade', async () => {
      await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.com', ip: '203.0.113.7', provision: { mail: false } }).expect(201);
      db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'blog.carol.com', 'sub', '/home/carol/public_html/blog')").run(accountId('carol'));
      const carol = await panelLogin(app, 'carol');
      expect((await carol.post('/email/accounts', { localPart: 'me', domain: 'carol.com', password: 'Str0ng-Passw0rd!' })).status).toBe(201);
      expect((await carol.put('/email/domains/carol.com/forward', { targetDomain: 'attacker.example' })).status).toBe(200);
      expect((await carol.post('/email/autoresponders', { address: 'me@blog.carol.com', subject: 'x', body: 'b' })).status).toBe(201);
      expect((await carol.post('/email/forwarders', { domain: 'blog.carol.com', localPart: 'x', destination: 'x@attacker.example' })).status).toBe(201);
      app.agent.calls.length = 0;
      await app.http.delete('/api/accounts/carol').set('X-CSRF-Token', csrf).expect(200);
      await vi.waitFor(() => expect(app.agent.callsTo('vmail.passwd.purge').map((c) => c.args.domain).sort()).toEqual(['blog.carol.com', 'carol.com']), { timeout: 5000 });
      expect(app.agent.callsTo('vmail.autoresponder.remove').map((c) => c.args)).toEqual([{ domain: 'blog.carol.com', localPart: 'me' }]);
      expect(app.agent.callsTo('vmail.aliases.remove').map((c) => c.args.domain).sort()).toEqual(['blog.carol.com', 'carol.com']);
      expect(app.agent.callsTo('vmail.domainfwd.write').pop().args).toEqual({ entries: [] });
      expect(rows("SELECT target FROM audit_log WHERE action = 'panel.email.domain.release' AND target = 'carol'")).toHaveLength(2);
      for (const table of ['mail_forwarders', 'mail_domain_forwarders', 'mail_autoresponders', 'mail_domains']) expect(rows(`SELECT * FROM ${table} WHERE domain LIKE '%carol.com'`), table).toEqual([]);
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

describe('Customer panel: email routing (P1-4)', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  const db = () => app.ctx.db;
  const row = (sql, ...args) => db().prepare(sql).get(...args);
  const accountId = (username) => row('SELECT id FROM accounts WHERE username = ?', username).id;
  // Public DNS as the page would see it: alice.com's MX lands on this server, shop.alice.com's elsewhere.
  const resolver = {
    resolveMx: async (domain) => (domain === 'alice.com' ? [{ exchange: 'mail.alice.com', priority: 10 }] : domain === 'shop.alice.com' ? [{ exchange: 'aspmx.l.google.com', priority: 1 }, { exchange: 'alt1.aspmx.l.google.com', priority: 5 }] : []),
    resolve4: async (name) => (name === 'mail.alice.com' ? ['203.0.113.5'] : name.endsWith('google.com') ? ['142.250.0.27'] : []),
    resolveTxt: async () => [], reverse: async () => [],
  };

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', ip: '203.0.113.5', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    db().prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'shop.alice.com', 'sub', '/home/alice/public_html/shop')").run(accountId('alice'));
    app.ctx.settings.set('basic.main_ip', '203.0.113.5');
    app.ctx.mail.deliverability.useResolver(resolver);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
  });
  afterAll(() => { app.ctx.mail?.deliverability?.useResolver(null); app.close(); });
  beforeEach(() => restoreAgent(app.agent));

  it('lists every domain of the account with its routing, the public MX and whether it points here', async () => {
    const res = await alice.get('/email/routing').expect(200);
    expect(res.body.meta).toMatchObject({ hostname: expect.any(String), values: ['auto', 'local', 'remote'] });
    expect(res.body.data.map((r) => r.domain)).toEqual(['alice.com', 'shop.alice.com']);
    const [main, shop] = res.body.data;
    expect(main).toMatchObject({ type: 'main', routing: 'auto', effective: 'local', mailboxes: 0, canRemote: true, mx: { ok: true, pointsHere: true, exchanges: ['mail.alice.com'], records: [{ exchange: 'mail.alice.com', priority: 10 }] }, hints: [] });
    expect(shop).toMatchObject({ type: 'sub', routing: 'auto', effective: 'local', mx: { ok: true, pointsHere: false, exchanges: ['aspmx.l.google.com', 'alt1.aspmx.l.google.com'] } });
    expect(shop.hints[0]).toMatch(/MX records of shop\.alice\.com point at another server/);
    expect(shop).toHaveProperty('delegation');
    expect(app.agent.calls.map((c) => c.name)).not.toContain('mail.test_delivery');
    expect((await alice.get('/email/domains/shop.alice.com/routing').expect(200)).body.data.domain).toBe('shop.alice.com');
  });

  it('only the account\'s own domains: a foreign domain is 404, never 403', async () => {
    expect((await bob.get('/email/domains/alice.com/routing')).status).toBe(404);
    expect((await bob.put('/email/domains/alice.com/routing', { routing: 'remote' })).status).toBe(404);
    expect((await alice.get('/email/domains/nope.example/routing')).status).toBe(404);
    expect(row('SELECT * FROM mail_domains WHERE domain = ?', 'alice.com')).toBeUndefined();
  });

  it('PUT routing claims the mail domain, writes the Exim lists through the Email category and reports applied/remote', async () => {
    const res = await alice.put('/email/domains/shop.alice.com/routing', { routing: 'remote' }).expect(200);
    expect(res.body.data).toMatchObject({ domain: 'shop.alice.com', routing: 'remote', effective: 'remote', applied: true, mailboxes: 0 });
    expect(res.body.data.hints).toEqual([]);
    expect(row('SELECT * FROM mail_domains WHERE domain = ?', 'shop.alice.com')).toMatchObject({ account_id: accountId('alice'), routing: 'remote' });
    const writes = app.agent.callsTo('mail.config.include.write');
    expect(writes.map((w) => w.args.name)).toEqual(['local_domains.lst', 'relay_domains.lst']);
    expect(writes[0].args.content).not.toContain('shop.alice.com');
    expect(writes[0].args.content).toContain('alice.com\n');
    expect(row("SELECT * FROM audit_log WHERE action = 'panel.email.routing.set' ORDER BY id DESC LIMIT 1")).toMatchObject({ principal: 'alice', target: 'alice' });
    // Back to local: the domain is listed again and the MX-elsewhere hint returns.
    const back = await alice.put('/email/domains/shop.alice.com/routing', { routing: 'local' }).expect(200);
    expect(back.body.data).toMatchObject({ routing: 'local', effective: 'local', applied: true });
    expect(back.body.data.hints[0]).toMatch(/point at another server/);
    expect(app.agent.callsTo('mail.config.include.write').filter((w) => w.args.name === 'local_domains.lst').pop().args.content).toContain('shop.alice.com');
  });

  it('Exim not reading the lists is reported as applied:false with the hint, not as a failure', async () => {
    app.agent.set('mail.config.include.write', () => ({ domainListsHooked: false, domainListsDetail: 'local_domains list does not read the file', hint: 'run update-exim4.conf', path: '/etc/exim4/whm/x.lst' }));
    const res = await alice.put('/email/domains/alice.com/routing', { routing: 'local' }).expect(200);
    expect(res.body.data).toMatchObject({ routing: 'local', applied: false, hint: 'run update-exim4.conf' });
    expect(res.body.data.reason).toMatch(/does not read the panel's domain lists/);
    expect(row('SELECT routing FROM mail_domains WHERE domain = ?', 'alice.com').routing).toBe('local');
  });

  it('refuses remote while mailboxes exist (409), refuses mailboxes on a remote domain (409), validates the value', async () => {
    expect((await alice.put('/email/domains/alice.com/routing', { routing: 'backup' })).status).toBe(422);
    expect((await alice.put('/email/domains/alice.com/routing', { routing: 'remote', force: true })).status).toBe(422);
    const created = await alice.post('/email/accounts', { localPart: 'info', domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
    expect(created.status).toBe(201);
    const refused = await alice.put('/email/domains/alice.com/routing', { routing: 'remote' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('mailboxes_exist');
    expect((await alice.get('/email/domains/alice.com/routing').expect(200)).body.data).toMatchObject({ mailboxes: 1, canRemote: false, routing: 'local' });
    // An explicitly remote domain never flips back silently: the mailbox is refused before anything is written.
    await alice.put('/email/domains/shop.alice.com/routing', { routing: 'remote' }).expect(200);
    app.agent.calls.length = 0;
    const blocked = await alice.post('/email/accounts', { localPart: 'sales', domain: 'shop.alice.com', password: 'Str0ng-Passw0rd!' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('routing_remote');
    expect(app.agent.calls.map((c) => c.name).filter((n) => /^(vmail|files)\./.test(n))).toEqual([]);
    expect(row('SELECT routing FROM mail_domains WHERE domain = ?', 'shop.alice.com').routing).toBe('remote');
    await alice.put('/email/domains/shop.alice.com/routing', { routing: 'auto' }).expect(200);
    expect((await alice.post('/email/accounts', { localPart: 'sales', domain: 'shop.alice.com', password: 'Str0ng-Passw0rd!' })).status).toBe(201);
    expect(row('SELECT routing FROM mail_domains WHERE domain = ?', 'shop.alice.com').routing).toBe('local');
  });
});

describe('Customer panel: delivery tracking and mailbox folders (P1-12)', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  let mailboxId;
  const db = () => app.ctx.db;
  const calls = (name) => app.agent.calls.filter((c) => c.name === name);
  const report = [
    { key: '1:0', id: 'A1', arrivedAt: '2026-11-03T10:00:00Z', sender: 'info@alice.com', recipient: 'x@example.org', status: 'delivered', subject: 'Invoice 42', size: 2048 },
    { key: '2:0', id: 'A2', arrivedAt: '2026-11-03T10:01:00Z', sender: 'y@example.org', recipient: 'info@alice.com', status: 'delivered', subject: 'Re: hello' },
    { key: '3:0', id: 'A3', arrivedAt: '2026-11-03T10:02:00Z', sender: 'z@notalice.com', recipient: 'q@notexample.com', status: 'failed', subject: 'Invoice 42' },
    { key: '4:0', id: 'A4', arrivedAt: '2026-11-03T10:03:00Z', sender: 'bob@bob.com', recipient: 'w@example.org', status: 'failed' },
    { key: '5:0', id: 'A5', arrivedAt: '2026-11-03T10:04:00Z', sender: 'info@alice.com', recipient: 'nope@example.org', status: 'failed', detail: 'Unrouteable address' },
    { key: '6:0', id: 'A6', arrivedAt: '2026-11-03T10:05:00Z', sender: 'news@example.org', recipient: 'info@alice.com', status: 'deferred', detail: 'Quota exceeded' },
  ];

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', ip: '203.0.113.5', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
    app.ctx.mail.reports.delivery = async () => ({ data: report, meta: { logFrom: null, logTruncated: false, logExists: true } });
    const created = await alice.post('/email/accounts', { localPart: 'info', domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    mailboxId = created.body.data.id;
  });
  afterAll(() => app.close());
  beforeEach(() => {
    restoreAgent(app.agent);
    app.agent.set('vmail.mailbox.status', ({ user }) => ({ user, folders: [{ name: 'INBOX', messages: 12, bytes: 40960, unseen: 3 }, { name: 'Trash', messages: 4, bytes: 2048, unseen: 0 }, { name: 'Archive.2025', messages: 100, bytes: 1048576, unseen: 0 }] }));
    app.agent.set('vmail.mailbox.expunge', ({ user, folder, olderThanDays }) => ({ user, folder, olderThanDays: olderThanDays ?? null, before: 4, after: 0, removed: 4 }));
  });

  it('GET /email/usage/messages pages the account rows and filters by status and text', async () => {
    const all = await alice.get('/email/usage/messages?sinceHours=48').expect(200);
    expect(all.body.data.map((r) => r.id)).toEqual(['A1', 'A2', 'A5', 'A6']);
    expect(all.body.meta).toMatchObject({ page: 1, pageSize: 25, total: 4, hours: 48, q: null, status: null, log: { exists: true } });
    const failed = await alice.get('/email/usage/messages?status=failed').expect(200);
    expect(failed.body.data.map((r) => r.id)).toEqual(['A5']);
    expect(failed.body.data[0]).toMatchObject({ detail: 'Unrouteable address', recipient: 'nope@example.org' });
    const text = await alice.get('/email/usage/messages?q=invoice').expect(200);
    expect(text.body.data.map((r) => r.id)).toEqual(['A1']);
    const byDetail = await alice.get('/email/usage/messages?q=quota').expect(200);
    expect(byDetail.body.data.map((r) => r.id)).toEqual(['A6']);
    const paged = await alice.get('/email/usage/messages?pageSize=2&page=2').expect(200);
    expect(paged.body.data.map((r) => r.id)).toEqual(['A5', 'A6']);
    expect(paged.body.meta).toMatchObject({ page: 2, pageSize: 2, total: 4 });
    const bobs = await bob.get('/email/usage/messages').expect(200);
    expect(bobs.body.data.map((r) => r.id)).toEqual(['A4']);
    for (const q of ['status=lost', 'pageSize=0', 'pageSize=101', 'page=0', 'sinceHours=169']) expect((await alice.get(`/email/usage/messages?${q}`)).status, q).toBe(422);
  });

  it('lists the folders of an owned mailbox through vmail.mailbox.status, marking Trash and Junk', async () => {
    const res = await alice.get(`/email/accounts/${mailboxId}/folders`).expect(200);
    expect(res.body.data).toEqual([
      { name: 'INBOX', messages: 12, bytes: 40960, unseen: 3, emptiable: false },
      { name: 'Trash', messages: 4, bytes: 2048, unseen: 0, emptiable: true },
      { name: 'Archive.2025', messages: 100, bytes: 1048576, unseen: 0, emptiable: false },
    ]);
    expect(res.body.meta).toMatchObject({ mailbox: { id: mailboxId, address: 'info@alice.com' }, usage: { source: 'dovecot' }, minOlderThanDays: 7 });
    expect(calls('vmail.mailbox.status').map((c) => c.args)).toEqual([{ user: 'info@alice.com' }]);
    expect((await bob.get(`/email/accounts/${mailboxId}/folders`)).status).toBe(404);
    expect((await alice.get('/email/accounts/999999/folders')).status).toBe(404);
  });

  it('empties Trash outright, needs olderThanDays >= 7 for any other folder, and audits', async () => {
    const trash = await alice.post(`/email/accounts/${mailboxId}/folders/Trash/empty`, {}).expect(200);
    expect(trash.body.data).toMatchObject({ mailbox: { address: 'info@alice.com' }, folder: 'Trash', olderThanDays: null, removed: 4 });
    expect(calls('vmail.mailbox.expunge').map((c) => c.args)).toEqual([{ user: 'info@alice.com', folder: 'Trash' }]);
    const refused = await alice.post(`/email/accounts/${mailboxId}/folders/INBOX/empty`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields).toHaveProperty('olderThanDays');
    expect((await alice.post(`/email/accounts/${mailboxId}/folders/INBOX/empty`, { olderThanDays: 6 })).status).toBe(422);
    expect((await alice.post(`/email/accounts/${mailboxId}/folders/INBOX/empty`, { olderThanDays: 30, extra: true })).status).toBe(422);
    expect(calls('vmail.mailbox.expunge')).toHaveLength(1);
    const old = await alice.post(`/email/accounts/${mailboxId}/folders/Archive.2025/empty`, { olderThanDays: 30 }).expect(200);
    expect(old.body.data).toMatchObject({ folder: 'Archive.2025', olderThanDays: 30 });
    expect(calls('vmail.mailbox.expunge').at(-1).args).toEqual({ user: 'info@alice.com', folder: 'Archive.2025', olderThanDays: 30 });
    for (const folder of ['..', '.hidden', 'a%2Fb', 'INBOX.', 'a..b', 'x"y', 'a*']) {
      const res = await alice.post(`/email/accounts/${mailboxId}/folders/${encodeURIComponent(folder)}/empty`, { olderThanDays: 30 });
      expect([404, 422], folder).toContain(res.status);
    }
    expect(calls('vmail.mailbox.expunge')).toHaveLength(2);
    expect((await bob.post(`/email/accounts/${mailboxId}/folders/Trash/empty`, {})).status).toBe(404);
    const audit = db().prepare("SELECT * FROM audit_log WHERE action = 'panel.email.folder.empty' ORDER BY id").all();
    expect(audit).toHaveLength(2);
    expect(JSON.parse(audit[0].args_redacted)).toMatchObject({ mailbox: 'info@alice.com', folder: 'Trash', olderThanDays: null, removed: 4 });
  });

  it('answers 501 for folders without Dovecot and 404 for a folder the mailbox does not have', async () => {
    app.agent.fail('vmail.mailbox.expunge', 'not_found', 'Folder Gone does not exist');
    expect((await alice.post(`/email/accounts/${mailboxId}/folders/Gone/empty`, { olderThanDays: 30 })).status).toBe(404);
    app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, n !== 'doveadm' && n !== 'dovecot' && PRESENT.has(n)])));
    await app.ctx.capabilities.refresh();
    try {
      const res = await alice.get(`/email/accounts/${mailboxId}/folders`);
      expect(res.status).toBe(501);
      expect((await alice.post(`/email/accounts/${mailboxId}/folders/Trash/empty`, {})).status).toBe(501);
    } finally {
      restoreAgent(app.agent);
      await app.ctx.capabilities.refresh();
    }
  });
});
