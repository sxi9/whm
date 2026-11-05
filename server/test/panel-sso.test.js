import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { SSO_TOKEN_RE, isLoopbackRequest } from '../src/services/panel-sso.js';
import { ssoEndpoint } from '../src/lib/sso-endpoint.js';
import { renderDovecotVirtualAuth, renderDovecotMasterPassdb, WEBMAIL_SSO } from '../src/services/service-configuration.js';

const HASH = '$6$zbsfcWrdKw0VR0wa$A0rw1A7d4PBa2YN/z1nATzFjoYngcI/Kpt3Ih5IWolea1/ANnjhx8YxtNUdCS5bDEjG80Yb.rvLa4CkZj2/pR1';
const PRESENT = new Set(['exim4', 'exim', 'dovecot', 'doveadm', 'openssl', 'setpriv', 'runuser', 'apache2', 'apachectl', 'php']);
const DETECTED = { installed: true, flavor: 'roundcube', path: '/var/lib/roundcube', root: '/var/lib/roundcube/public_html', version: '1.6.11', configured: true, apacheAlias: '/webmail', published: { alias: '/webmail', file: '/etc/apache2/keel-host.d/webmail.conf', managed: true, source: 'keel-host' }, globalAlias: null, config: { path: '/etc/roundcube/config.inc.php', exists: true, ok: null, managed: { imapHost: 'ssl://nova.example.com:993', smtpHost: 'tls://nova.example.com:587', productName: 'Keel', plugins: ['keel_sso'] } }, plugins: { dir: '/var/lib/roundcube/plugins', keel: ['keel_sso'] } };
const OVERRIDES = {
  'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, PRESENT.has(n)])),
  'vmail.hash': () => ({ hash: HASH, scheme: 'SHA512-CRYPT', tool: 'openssl' }),
  'vmail.passwd.set': ({ domain, localPart }) => ({ domain, localPart, replaced: false }),
  'vmail.passwd.remove': ({ domain, localPart }) => ({ domain, localPart, removed: true }),
  'vmail.master.write': ({ user }) => ({ user, path: '/etc/dovecot/whm/master-users', changed: true }),
  'vmail.master.remove': () => ({ path: '/etc/dovecot/whm/master-users', removed: true }),
  'vmail.render.check': () => ({ dovecot: { installed: true, configOk: true }, exim: { installed: true, configOk: true }, routerHooked: true, transportHooked: true, authHooked: true, hint: null }),
  'web.webmail.detect': () => DETECTED,
  'web.webmail.plugin.install': ({ source }) => ({ name: 'keel_sso', source, path: '/var/lib/roundcube/plugins/keel_sso', files: ['keel_sso.php', 'composer.json'] }),
  'web.webmail.config.write': (a) => ({ path: '/etc/roundcube/config.inc.php', changed: true, validated: true, values: { imapHost: `ssl://${a.hostname}:993`, smtpHost: `tls://${a.hostname}:587`, productName: a.productName, plugins: a.plugins } }),
  'web.dovecot.detect': () => ({ installed: true, version: '2.4.2', includes: { virtualAuth: { path: '/etc/dovecot/conf.d/98-whm-virtual-auth.conf', exists: true, content: 'passwd_file_path = /etc/dovecot/whm/master-users' } } }),
  'files.mkdir': ({ path }) => ({ path }),
  'files.write': ({ path }) => ({ path }),
  'files.remove': ({ paths }) => ({ removed: paths }),
  'mail.detect': () => ({ installed: true, flavor: 'debian', dovecot: { installed: true, doveadm: true }, spamd: { installed: false } }),
};

async function panelLogin(app, username, password = 'Panel-Passw0rd!1') {
  const hash = await app.ctx.crypto.hashPassword(password);
  app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  const http = request.agent(app.ctx.app);
  const res = await http.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`panel login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  return { http, csrf, get: (p) => http.get(`/api/panel${p}`), post: (p, body = {}) => http.post(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body) };
}

describe('Customer panel: webmail single sign-on (contract §44)', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  const db = () => app.ctx.db;
  const rows = (sql, ...args) => db().prepare(sql).all(...args);
  const audit = (action) => rows('SELECT * FROM audit_log WHERE action = ? ORDER BY id', action);
  const exchange = (token, kind = 'webmail') => request(app.ctx.app).get(`/api/panel/sso/${kind}/${token}`);
  const enableSso = () => { app.ctx.settings.set(WEBMAIL_SSO.settingEnabled, true); app.ctx.settings.set(WEBMAIL_SSO.settingMaster, app.ctx.crypto.encrypt('master-secret-pw')); };

  beforeAll(async () => {
    app = await createTestApp({ agent: createMockAgent(OVERRIDES) });
    csrf = await app.login();
    app.ctx.settings.set('basic.hostname', 'nova.example.com');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', ip: '203.0.113.5', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
    expect((await alice.post('/email/accounts', { localPart: 'info', domain: 'alice.com', password: 'Str0ng-Passw0rd!' })).status).toBe(201);
    expect((await bob.post('/email/accounts', { localPart: 'sales', domain: 'bob.com', password: 'Str0ng-Passw0rd!' })).status).toBe(201);
  });
  afterAll(() => app.close());
  beforeEach(() => { for (const [k, v] of Object.entries(OVERRIDES)) app.agent.set(k, v); app.agent.calls.length = 0; enableSso(); app.ctx.settings.set(WEBMAIL_SSO.settingLoginAs, false); });

  it('reports sso:false until root switches it on, and never for an operator-configured webmail URL', async () => {
    app.ctx.settings.set(WEBMAIL_SSO.settingEnabled, false);
    expect((await alice.get('/email/webmail').expect(200)).body.data).toMatchObject({ url: 'https://nova.example.com/webmail/', sso: false });
    expect((await alice.post('/email/webmail/sso', { mailbox: 'info@alice.com' })).status).toBe(409);
    enableSso();
    expect((await alice.get('/email/webmail').expect(200)).body.data).toMatchObject({ sso: true, prefillUser: 'info@alice.com' });
    app.ctx.settings.set('panel.webmail_url', 'https://mail.elsewhere.example/');
    try {
      expect((await alice.get('/email/webmail').expect(200)).body.data).toMatchObject({ url: 'https://mail.elsewhere.example/', sso: false });
      expect((await alice.post('/email/webmail/sso', { mailbox: 'info@alice.com' })).status).toBe(409);
    } finally { app.ctx.settings.set('panel.webmail_url', ''); }
    expect(rows('SELECT id FROM panel_sso_tokens')).toEqual([]);
  });

  it('mints a 60 s single-use token for an owned mailbox and the loopback exchange answers once with the master login', async () => {
    const res = await alice.post('/email/webmail/sso', { mailbox: 'info@alice.com' }).expect(200);
    const url = new URL(res.body.data.url);
    expect(url.origin + url.pathname).toBe('https://nova.example.com/webmail/');
    const token = url.searchParams.get('_keel');
    expect(token).toMatch(SSO_TOKEN_RE);
    expect(new Date(res.body.data.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    const row = db().prepare('SELECT * FROM panel_sso_tokens ORDER BY id DESC').get();
    expect(row).toMatchObject({ account: 'alice', kind: 'webmail', used_at: null, token_hash: app.ctx.crypto.hashToken(token) });
    expect(row.payload_enc).not.toContain('info@alice.com');
    expect(JSON.parse(app.ctx.crypto.decrypt(row.payload_enc))).toEqual({ mailbox: 'info@alice.com' });
    const a = audit('panel.email.webmail.sso').pop();
    expect(a).toMatchObject({ principal: 'alice', role: 'user', target: 'alice' });
    expect(JSON.parse(a.args_redacted)).toMatchObject({ mailbox: 'info@alice.com' });
    expect(a.args_redacted).not.toContain(token);

    const ex = await exchange(token).expect(200);
    expect(ex.body.data).toEqual({ user: 'info@alice.com*keel-master', password: 'master-secret-pw', host: 'ssl://nova.example.com:993', mailbox: 'info@alice.com' });
    expect(db().prepare('SELECT used_at FROM panel_sso_tokens WHERE id = ?').get(row.id).used_at).toBeTruthy();
    expect(JSON.parse(audit('panel.sso.exchange').pop().args_redacted)).toMatchObject({ kind: 'webmail', subject: 'info@alice.com' });

    // Replay, wrong kind, expiry, garbage.
    expect((await exchange(token)).status).toBe(404);
    expect((await exchange(token).expect(404)).body.error.code).toBe('sso_token_invalid');
    const again = new URL((await alice.post('/email/webmail/sso', { mailbox: 'info@alice.com' }).expect(200)).body.data.url).searchParams.get('_keel');
    expect((await exchange(again, 'phpmyadmin')).status).toBe(404);
    db().prepare("UPDATE panel_sso_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?").run(app.ctx.crypto.hashToken(again));
    expect((await exchange(again)).status).toBe(404);
    expect((await exchange('short')).status).toBe(422);
    expect((await exchange('x'.repeat(43))).status).toBe(404);
    expect((await exchange(again, 'other')).status).toBe(422);
    // The master password never appears in any audit row.
    for (const r of rows('SELECT args_redacted FROM audit_log')) expect(String(r.args_redacted || '')).not.toContain('master-secret-pw');
  });

  it('refuses the exchange from anything but a loopback peer, a forwarded header included', async () => {
    const token = new URL((await alice.post('/email/webmail/sso', { mailbox: 'info@alice.com' }).expect(200)).body.data.url).searchParams.get('_keel');
    for (const headers of [{ 'X-Forwarded-For': '203.0.113.9' }, { 'X-Forwarded-For': '127.0.0.1' }, { 'X-Real-IP': '127.0.0.1' }, { Forwarded: 'for=127.0.0.1' }]) {
      const res = await exchange(token).set(headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.body.error.code).toBe('loopback_only');
    }
    // A refused request never burns the token: it is still exchangeable from loopback.
    expect(db().prepare('SELECT used_at FROM panel_sso_tokens WHERE token_hash = ?').get(app.ctx.crypto.hashToken(token)).used_at).toBeNull();
    expect((await exchange(token)).status).toBe(200);
    const fake = (remote, ip, headers = {}) => ({ socket: { remoteAddress: remote }, ip, headers });
    expect(isLoopbackRequest(fake('127.0.0.1', '127.0.0.1'))).toBe(true);
    expect(isLoopbackRequest(fake('::1', '::1'))).toBe(true);
    expect(isLoopbackRequest(fake('::ffff:127.0.0.1', '::ffff:127.0.0.1'))).toBe(true);
    expect(isLoopbackRequest(fake('10.0.0.5', '10.0.0.5'))).toBe(false);
    expect(isLoopbackRequest(fake('127.0.0.1', '203.0.113.9'))).toBe(false);
    expect(isLoopbackRequest(fake('127.0.0.1', '127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
  });

  it('only the account\'s own, active mailboxes; a session is required', async () => {
    expect((await alice.post('/email/webmail/sso', { mailbox: 'sales@bob.com' })).status).toBe(404);
    expect((await alice.post('/email/webmail/sso', { mailbox: 'nobody@alice.com' })).status).toBe(404);
    expect((await alice.post('/email/webmail/sso', { mailbox: 'not an address' })).status).toBe(422);
    expect((await alice.post('/email/webmail/sso', { mailbox: 'info@alice.com', extra: 1 })).status).toBe(422);
    db().prepare("UPDATE mail_accounts SET suspended = 1 WHERE local_part = 'info'").run();
    try { expect((await alice.post('/email/webmail/sso', { mailbox: 'info@alice.com' })).status).toBe(409); } finally { db().prepare("UPDATE mail_accounts SET suspended = 0 WHERE local_part = 'info'").run(); }
    const tok = (await alice.post('/tokens', { name: 'mail-bot', scopes: ['panel:email'] }).expect(201)).body.data.token;
    const viaToken = await request(app.ctx.app).post('/api/panel/email/webmail/sso').set('Authorization', `Bearer ${tok}`).send({ mailbox: 'info@alice.com' });
    expect(viaToken.status).toBe(403);
    expect(viaToken.body.error.code).toBe('session_required');
    expect(rows("SELECT id FROM panel_sso_tokens WHERE account = 'bob'")).toEqual([]);
  });

  it('is refused while an administrator acts as the account unless panel.login_as_webmail allows it (audited either way)', async () => {
    await app.http.post('/api/panel/admin/login-as/alice').set('X-CSRF-Token', csrf).expect(200);
    try {
      const refused = await app.http.post('/api/panel/email/webmail/sso').set('X-CSRF-Token', csrf).send({ mailbox: 'info@alice.com' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('not_while_impersonating');
      app.ctx.settings.set(WEBMAIL_SSO.settingLoginAs, true);
      const ok = await app.http.post('/api/panel/email/webmail/sso').set('X-CSRF-Token', csrf).send({ mailbox: 'info@alice.com' }).expect(200);
      expect(ok.body.data.url).toContain('?_keel=');
      const a = audit('panel.email.webmail.sso').pop();
      expect(a).toMatchObject({ principal: 'root', role: 'root', target: 'alice' });
      expect(JSON.parse(a.args_redacted)).toMatchObject({ mailbox: 'info@alice.com', actingAs: 'alice', by: 'root' });
    } finally {
      await app.http.post('/api/panel/admin/logout-as').set('X-CSRF-Token', csrf);
    }
  });

  it('root switches it on and off: master user written host-first, password generated once, Dovecot include and plugin refreshed, audited', async () => {
    app.ctx.settings.set(WEBMAIL_SSO.settingEnabled, false);
    app.ctx.settings.set(WEBMAIL_SSO.settingMaster, null);
    app.ctx.settings.set('service_config.virtual_mail', { enabled: true, spamdAddress: '127.0.0.1 783' });
    await app.ctx.capabilities.refresh();
    expect((await alice.get('/api/panel/admin/webmail/sso'.replace('/api/panel', ''))).status).toBe(403);
    const before = (await app.http.get('/api/panel/admin/webmail/sso').expect(200)).body.data;
    expect(before).toMatchObject({ enabled: false, masterUser: 'keel-master', masterFile: '/etc/dovecot/whm/master-users', masterConfigured: false });
    const on = await app.http.put('/api/panel/admin/webmail/sso').set('X-CSRF-Token', csrf).send({ enabled: true }).expect(200);
    expect(on.body.data).toMatchObject({ enabled: true, master: { user: 'keel-master', changed: true }, status: { enabled: true, masterConfigured: true, plugin: { installed: true, loaded: true } } });
    const names = app.agent.calls.map((c) => c.name);
    expect(names.indexOf('vmail.hash')).toBeLessThan(names.indexOf('vmail.master.write'));
    expect(names).toContain('web.webmail.plugin.install');
    const cfg = app.agent.calls.find((c) => c.name === 'web.webmail.config.write');
    // The plugin's exchange address follows the panel's own listener (plain port without TLS, 2087 with it).
    expect(cfg.args).toMatchObject({ hostname: 'nova.example.com', plugins: ['keel_sso'], ssoEndpoint: 'http://127.0.0.1:2086/api/panel/sso/webmail/' });
    expect(ssoEndpoint({ tls: true, tlsPort: 2443, port: 2086 }, 'webmail')).toBe('https://127.0.0.1:2443/api/panel/sso/webmail/');
    expect(ssoEndpoint({ tls: false, tlsPort: 2087, port: 2090 }, 'phpmyadmin')).toBe('http://127.0.0.1:2090/api/panel/sso/phpmyadmin/');
    const dc = app.agent.calls.find((c) => c.name === 'web.dovecot.include.write');
    expect(dc?.args.content).toContain('auth_master_user_separator = *');
    expect(dc?.args.content).toContain('passwd_file_path = /etc/dovecot/whm/master-users');
    const enc = app.ctx.settings.get(WEBMAIL_SSO.settingMaster);
    expect(enc).toMatch(/^v1:/);
    const password = app.ctx.crypto.decrypt(enc);
    expect(app.agent.calls.find((c) => c.name === 'vmail.hash').args.password).toBe(password);
    expect(app.agent.calls.find((c) => c.name === 'web.webmail.config.write').args).not.toHaveProperty('password');
    expect(JSON.stringify(audit('webmail.sso.set').pop().args_redacted)).not.toContain(password);
    // Switching on again keeps the password; the exchange now hands it out.
    app.agent.calls.length = 0;
    await app.http.put('/api/panel/admin/webmail/sso').set('X-CSRF-Token', csrf).send({ enabled: true }).expect(200);
    expect(app.ctx.settings.get(WEBMAIL_SSO.settingMaster)).toBe(enc);
    const token = new URL((await alice.post('/email/webmail/sso', { mailbox: 'info@alice.com' }).expect(200)).body.data.url).searchParams.get('_keel');
    expect((await exchange(token).expect(200)).body.data.password).toBe(password);
    // Off: master file removed, include re-rendered without the master passdb, plugin dropped from the block, tokens refused.
    app.agent.calls.length = 0;
    const off = await app.http.put('/api/panel/admin/webmail/sso').set('X-CSRF-Token', csrf).send({ enabled: false, loginAs: true }).expect(200);
    expect(off.body.data).toMatchObject({ enabled: false, loginAs: true, master: { removed: true } });
    expect(app.agent.calls.map((c) => c.name)).toContain('vmail.master.remove');
    expect(app.agent.calls.find((c) => c.name === 'web.dovecot.include.write')?.args.content).not.toContain('master = yes');
    expect(app.agent.calls.find((c) => c.name === 'web.webmail.config.write').args).not.toHaveProperty('ssoEndpoint');
    expect(app.agent.calls.find((c) => c.name === 'web.webmail.config.write').args.plugins).toEqual([]);
    expect((await alice.post('/email/webmail/sso', { mailbox: 'info@alice.com' })).status).toBe(409);
    const t2 = new URL((await (async () => { enableSso(); return alice.post('/email/webmail/sso', { mailbox: 'info@alice.com' }).expect(200); })()).body.data.url).searchParams.get('_keel');
    app.ctx.settings.set(WEBMAIL_SSO.settingEnabled, false);
    expect((await exchange(t2)).status).toBe(409);
    expect((await app.http.put('/api/panel/admin/webmail/sso').set('X-CSRF-Token', csrf).send({})).status).toBe(422);
    expect((await app.http.get('/api/service-config/webmail').expect(200)).body.data.sso).toMatchObject({ enabled: false, masterUser: 'keel-master' });
  });

  it('phpMyAdmin kind: the encrypted payload comes back exactly once, and only while the switch is on', async () => {
    app.ctx.settings.set('panel.phpmyadmin.sso', true);
    try {
      const payload = { user: 'alice_pma', password: 'r0tated-secret', host: 'localhost' };
      const { token } = app.ctx.panelSso.issue({ kind: 'phpmyadmin', userId: null, account: 'alice', payload });
      const row = db().prepare('SELECT * FROM panel_sso_tokens WHERE token_hash = ?').get(app.ctx.crypto.hashToken(token));
      expect(row).toMatchObject({ kind: 'phpmyadmin', account: 'alice', used_at: null });
      expect(row.payload_enc).not.toContain('r0tated-secret');
      expect((await exchange(token, 'webmail')).status).toBe(404);
      expect((await exchange(token, 'phpmyadmin').expect(200)).body.data).toEqual(payload);
      expect((await exchange(token, 'phpmyadmin')).status).toBe(404);
      expect(JSON.parse(audit('panel.sso.exchange').pop().args_redacted)).toMatchObject({ kind: 'phpmyadmin', subject: 'alice_pma' });
      // A token without a payload (or with the switch off) is refused without handing anything out.
      const bare = app.ctx.panelSso.issue({ kind: 'phpmyadmin', userId: null, account: 'alice', payload: null }).token;
      expect((await exchange(bare, 'phpmyadmin')).status).toBe(404);
      const late = app.ctx.panelSso.issue({ kind: 'phpmyadmin', userId: null, account: 'alice', payload }).token;
      app.ctx.settings.set('panel.phpmyadmin.sso', false);
      expect((await exchange(late, 'phpmyadmin')).status).toBe(409);
      for (const r of rows('SELECT args_redacted FROM audit_log')) expect(String(r.args_redacted || '')).not.toContain('r0tated-secret');
    } finally { app.ctx.settings.set('panel.phpmyadmin.sso', false); }
  });

  it('renders the master passdb before the virtual passdb on both Dovecot syntaxes, only when asked', () => {
    expect(renderDovecotVirtualAuth({ version: '2.4.2' })).not.toContain('master');
    const v24 = renderDovecotVirtualAuth({ version: '2.4.2', masterFile: WEBMAIL_SSO.masterFile });
    expect(v24.indexOf('auth_master_user_separator = *')).toBeLessThan(v24.indexOf('passdb passwd-file {'));
    expect(v24).toContain('passdb master-users {\n  driver = passwd-file\n  master = yes\n  passwd_file_path = /etc/dovecot/whm/master-users\n  result_success = continue\n}');
    const v23 = renderDovecotVirtualAuth({ version: '2.3.21', masterFile: WEBMAIL_SSO.masterFile });
    expect(v23).toContain('passdb {\n  driver = passwd-file\n  args = /etc/dovecot/whm/master-users\n  master = yes\n  result_success = continue\n}');
    expect(v23.indexOf('master = yes')).toBeLessThan(v23.indexOf('args = scheme=SHA512-CRYPT'));
    expect(renderDovecotMasterPassdb(true, '/x')).not.toContain('args =');
  });
});
