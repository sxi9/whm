import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockAgent } from './support/app.js';
import { ownsRow } from '../src/middleware/rbac.js';
import { ACL_KEYS, EXPLICIT_ACLS } from '../src/services/resellers.js';
import { DEFAULT_FEATURES } from '../src/db/seed.js';
import { renderDovecotVirtualAuth, renderEximVirtualRouters, renderEximVirtualTransports, renderEximVirtualAuths, renderEximDataAcl, renderEximMain, renderEximSpamAcl, dovecotIsV24, DEFAULTS, SPAMD_ADDRESS_RE } from '../src/services/service-configuration.js';

// The integration seams the customer panel relies on (contracts §33–§40),
// exercised through the owning categories' services with the mock agent.

const FULL_BINS = { apache2ctl: true, 'php-fpm': true, php: true, exim4: true, 'update-exim4.conf': true, dovecot: true, doveadm: true, 'pure-ftpd': true, named: true, logrotate: true, openssl: true, systemctl: true };
const unit = (name, active = true) => ({ unit: name, present: true, active, state: active ? 'active' : 'inactive', subState: active ? 'running' : 'dead', enabled: true, pid: 100, restarts: 0 });
const WHM = '/etc/exim4/whm';
const VMAIL = { passwdDir: '/etc/dovecot/whm/passwd', aliasesDir: `${WHM}/aliases`, domainForward: `${WHM}/domainfwd.lst`, autorespondersDir: `${WHM}/autoresponders`, spamUsers: `${WHM}/spam_users.lst`, autoreplyOnceDir: '/var/lib/whm/autoreply', dovecotBaseDir: '/var/run/dovecot' };
const slot = (path, extra = {}) => ({ path, hookable: true, block: null, exists: false, hooked: true, claimedBy: null, content: null, ...extra });
function eximLayout(overrides = {}) {
  return {
    installed: true, bin: 'exim4', flavor: 'debian', confDir: '/etc/exim4', whmDir: WHM, splitConfig: true, mainConf: null, macroFile: '/etc/exim4/exim4.conf.localmacros', emailAclFile: `${WHM}/acl-email-filters.conf`, sentinel: 'WHM_SERVICE_CONFIG', units: ['exim4'],
    user: 'Debian-exim', group: 'Debian-exim', vmail: VMAIL, version: '4.97', features: ['crypteq', 'GnuTLS', 'DKIM', 'SPF', 'Content_Scanning'], support: { spf: true, dkim: true, dmarc: false, tls: 'gnutls', contentScan: true }, unit: unit('exim4'), hints: [],
    slots: {
      main: slot('/etc/exim4/conf.d/main/001_whm_service_config'),
      acl_rcpt: slot(`${WHM}/acl-rcpt-local.conf`, { macro: 'CHECK_RCPT_LOCAL_ACL_FILE', includes: `${WHM}/acl-email-filters.conf`, includesEmailFilters: true }),
      acl_data: slot(`${WHM}/acl_data_whm.conf`, { macro: 'CHECK_DATA_LOCAL_ACL_FILE' }),
      router: slot('/etc/exim4/conf.d/router/350_whm_virtual_mail', { probe: { list: 'router_list', name: 'whm_virtual_user' }, section: 'routers', hooked: false, precedes: null }),
      transport: slot('/etc/exim4/conf.d/transport/30_whm_virtual_mail', { probe: { list: 'transport_list', name: 'whm_dovecot_lmtp' }, section: 'transports', hooked: false }),
      auth: slot('/etc/exim4/conf.d/auth/25_whm_dovecot', { probe: { list: 'authenticator_list', name: 'dovecot_plain' }, section: 'authenticators', hooked: false }),
    },
    ...overrides,
  };
}
function dovecotDetect(overrides = {}) {
  const inc = (name) => ({ path: `/etc/dovecot/conf.d/${name}`, exists: false, content: null });
  return { installed: true, bin: 'dovecot', confDir: '/etc/dovecot', dropinDir: '/etc/dovecot/conf.d', include: inc('97-whm-mailserver.conf'), includes: { mailserver: inc('97-whm-mailserver.conf'), virtualAuth: inc('98-whm-virtual-auth.conf') }, passwdDir: '/etc/dovecot/whm/passwd', baseDir: '/var/run/dovecot', passwdDirExists: false, version: '2.3.21', configOk: true, effective: { protocols: 'imap pop3 lmtp' }, unit: unit('dovecot'), ...overrides };
}
const ftpCandidates = (current = 'pure-ftpd') => [
  { name: 'pure-ftpd', label: 'Pure-FTPd', binaries: ['pure-ftpd'], units: ['pure-ftpd'], packages: { apt: 'pure-ftpd', dnf: 'pure-ftpd' }, installed: true, unitName: 'pure-ftpd', unit: unit('pure-ftpd', current === 'pure-ftpd') },
  { name: 'proftpd', label: 'ProFTPD', binaries: ['proftpd'], units: ['proftpd'], packages: { apt: 'proftpd-core', dnf: 'proftpd' }, installed: false, unitName: null, unit: { unit: null, present: false, active: false } },
  { name: 'vsftpd', label: 'vsftpd', binaries: ['vsftpd'], units: ['vsftpd'], packages: { apt: 'vsftpd', dnf: 'vsftpd' }, installed: true, unitName: 'vsftpd', unit: unit('vsftpd', current === 'vsftpd') },
];

let app;
let csrf;
let reseller;
let alice;
let bob;
let eximState;
let dovecotState;
let ftpCurrent = 'pure-ftpd';
let ftpVirtual = false;
const entries = [];
const req = { audit: (e) => entries.push(e), user: { id: 1, username: 'root', role: 'root' } };
const ROOT = { id: 1, username: 'root', role: 'root' };
const written = {};

function agent() {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(FULL_BINS[n])])),
    'web.detect': () => ({ apache: { installed: true, flavor: 'debian', bin: 'apache2ctl', units: ['apache2'] }, nginx: { installed: false }, php: { installed: true, versions: [{ version: '8.3', flavor: 'debian', poolDir: '/etc/php/8.3/fpm/pool.d', units: ['php8.3-fpm'] }] }, ftp: { daemons: [] }, dovecot: { installed: true }, exim: { installed: true }, systemd: true, logrotate: true }),
    'web.vhost.write': ({ domain }) => ({ domain, path: `/etc/apache2/sites-available/${domain}.conf`, validated: true, reloaded: false }),
    'web.vhost.remove': ({ domain }) => ({ domain, path: `/etc/apache2/sites-available/${domain}.conf`, removed: true, validated: true, reloaded: true, unit: 'apache2' }),
    'web.phpfpm.pool.write': ({ user, version }) => ({ path: `/etc/php/${version}/fpm/pool.d/${user}.conf`, socket: `/run/php/php${version}-fpm-${user}.sock`, reloaded: true }),
    'web.reload': () => ({ reloaded: true, unit: 'apache2' }),
    'web.exim.detect': () => eximState,
    'web.exim.include.write': ({ slot: s, content, reload }) => { written[s] = content; eximState.slots[s] = { ...eximState.slots[s], exists: true, content, hooked: true, ...(s === 'router' ? { precedes: true } : {}) }; return { slot: s, path: eximState.slots[s].path, validated: true, hooked: true, claimedBy: null, ...(s === 'router' ? { precedes: true } : {}), bytes: content.length, version: '4.97', features: eximState.features, reloaded: reload, unit: 'exim4' }; },
    'web.exim.include.remove': ({ slot: s }) => { const existed = Boolean(eximState.slots[s].exists); eximState.slots[s] = { ...eximState.slots[s], exists: false, content: null, hooked: false }; delete written[s]; return { slot: s, path: eximState.slots[s].path, removed: existed, reloaded: existed, unit: 'exim4' }; },
    'web.dovecot.detect': () => dovecotState,
    'web.dovecot.include.write': ({ name, content, reload }) => { const key = name === '98-whm-virtual-auth.conf' ? 'virtualAuth' : 'mailserver'; dovecotState.includes[key] = { ...dovecotState.includes[key], exists: true, content }; if (key === 'virtualAuth') dovecotState.passwdDirExists = true; return { name, path: dovecotState.includes[key].path, validated: true, bytes: content.length, reloaded: reload, unit: 'dovecot' }; },
    'web.dovecot.include.remove': ({ name }) => { const key = name === '98-whm-virtual-auth.conf' ? 'virtualAuth' : 'mailserver'; const existed = dovecotState.includes[key].exists; dovecotState.includes[key] = { ...dovecotState.includes[key], exists: false, content: null }; return { name, path: dovecotState.includes[key].path, removed: existed, reloaded: existed, unit: 'dovecot' }; },
    'vmail.passwd.rekey': ({ dryRun }) => ({ format: 'legacy', dryRun: Boolean(dryRun), dir: VMAIL.passwdDir, files: [{ domain: 'alice.com', path: `${VMAIL.passwdDir}/alice.com`, changed: 1 }], changed: 1 }),
    'web.vmail.prepare': ({ enabled }) => ({ enabled, eximUser: 'Debian-exim', eximGroup: 'Debian-exim', dovecotGroupMember: enabled, changed: true, dirs: enabled ? [VMAIL.passwdDir, VMAIL.aliasesDir, VMAIL.autorespondersDir, VMAIL.autoreplyOnceDir] : [], passwdDir: VMAIL.passwdDir, authSocket: '/var/run/dovecot/auth-client', lmtpSocket: '/var/run/dovecot/lmtp' }),
    'web.service.detect': ({ role }) => ({ role, candidates: ftpCandidates(ftpCurrent), active: [ftpCurrent], enabled: [ftpCurrent], current: ftpCurrent, packageManager: 'apt-get' }),
    'web.ftp.config.read': ({ server }) => ({ server, path: '/etc/pure-ftpd/conf/', unit: unit(server), settings: {}, raw: {} }),
    'web.ftp.config.write': ({ server, settings }) => { ftpVirtual = Boolean(settings?.virtualUsers); return { server, written: ['/etc/pure-ftpd/conf/PureDB'], validated: null, settings, reloaded: true, unit: server, verb: 'restart' }; },
    'ftp.virtual.status': ({ daemon }) => (daemon === 'vsftpd' ? { daemon, supported: false, enabled: false } : { daemon, supported: true, configured: ftpVirtual, enabled: ftpVirtual, passwdFile: '/etc/pure-ftpd/pureftpd.passwd' }),
  });
}

async function account(username, domain, extra = {}) {
  const res = await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username, domain, provision: { dns: false, mail: false, web: false }, ...extra }).expect(201);
  return app.ctx.db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) || res.body.data;
}
const audits = (action) => entries.filter((e) => e.action === action);
const asUser = (acct) => ({ id: 70000 + acct.id, username: acct.username, role: 'user', accountId: acct.id });

beforeAll(async () => {
  app = await createTestApp({ agent: agent() });
  csrf = await app.login();
  reseller = await app.createUser('resell1', 'reseller');
  alice = await account('alice', 'alice.com', { owner: 'resell1' });
  bob = await account('bob', 'bob.com');
  await app.ctx.capabilities.refresh();
});
afterAll(() => app.close());
beforeEach(() => { entries.length = 0; app.agent.calls.length = 0; eximState = eximLayout(); dovecotState = dovecotDetect(); for (const k of Object.keys(written)) delete written[k]; ftpCurrent = 'pure-ftpd'; });

describe('S2: ownership checks accept a role-user principal only for its own account_id', () => {
  it('ownsRow: root everything, reseller by owner_id, user by account_id and nothing else', () => {
    const row = { owner_id: reseller.id, account_id: alice.id };
    expect(ownsRow(ROOT, row)).toBe(true);
    expect(ownsRow({ id: reseller.id, role: 'reseller' }, row)).toBe(true);
    expect(ownsRow({ id: 99, role: 'reseller' }, row)).toBe(false);
    expect(ownsRow(asUser(alice), row)).toBe(true);
    expect(ownsRow(asUser(bob), row)).toBe(false);
    // A role-user principal never wins through owner_id, username or a missing pin.
    expect(ownsRow({ id: reseller.id, role: 'user' }, row)).toBe(false);
    expect(ownsRow({ id: reseller.id, username: 'alice', role: 'user' }, row)).toBe(false);
    expect(ownsRow({ id: 5, role: 'user', accountId: null }, { owner_id: 5, account_id: null })).toBe(false);
    expect(ownsRow(asUser(alice), { owner_id: reseller.id, id: alice.id }, { accountId: alice.id })).toBe(true);
    expect(ownsRow(null, row)).toBe(false);
    expect(ownsRow(asUser(alice), null)).toBe(false);
  });

  it('dns-functions, ssl-tls, software, account-functions and email all take the pinned account and refuse a foreign one', async () => {
    const { ctx } = app;
    const me = asUser(alice);
    const other = asUser(bob);
    const resellerUser = { id: reseller.id, username: 'resell1', role: 'reseller' };
    const not403 = async (p) => { try { await p; } catch (err) { expect(err.status, err.message).not.toBe(403); } };
    const is403 = async (p) => { try { await p; } catch (err) { expect(err.status, err.message).toBe(403); return; } throw new Error('expected 403'); };
    await ctx.dns.ensureZoneForDomain('alice.com', { ip: '203.0.113.5', accountId: alice.id }, req);
    await not403(ctx.dns.getZone('alice.com', me));
    await is403(ctx.dns.getZone('alice.com', other));
    await not403(ctx.dns.getZone('alice.com', resellerUser));
    await is403(ctx.dns.getZone('alice.com', { id: 999, role: 'reseller' }));
    await not403(ctx.ssl.hosts.get('alice.com', me));
    await is403(ctx.ssl.hosts.get('alice.com', other));
    await not403(ctx.software.ini.readDomain('alice.com', me));
    await is403(ctx.software.ini.readDomain('alice.com', other));
    expect(ctx.accountFunctions.logRetention.get('alice', me).username).toBe('alice');
    expect(() => ctx.accountFunctions.logRetention.get('alice', other)).toThrow(/another reseller/);
    expect(() => ctx.accountFunctions.logRetention.get('alice', resellerUser)).not.toThrow();
    await not403(ctx.mail.deliverability.fix('alice.com', [], me, req));
    await is403(ctx.mail.deliverability.fix('alice.com', [], other, req));
    // Reseller and root behaviour is unchanged: a reseller still sees only its own accounts' rows.
    await is403(ctx.mail.deliverability.fix('bob.com', [], resellerUser, req));
    await not403(ctx.mail.deliverability.fix('bob.com', [], ROOT, req));
    await is403(ctx.software.ini.readDomain('bob.com', resellerUser));
  });
});

describe('S3: ctx.mail.ensureMailDomain', () => {
  it('creates an auto-routed row for the account, is idempotent, claims an unowned row and refuses another account\'s', () => {
    const { ctx } = app;
    const first = ctx.mail.ensureMailDomain('alice.com', alice.id, req);
    expect(first).toEqual({ domain: 'alice.com', accountId: alice.id, routing: 'auto', created: true, claimed: false });
    expect(ctx.mail.ensureMailDomain('alice.com', alice.id, req)).toMatchObject({ created: false, claimed: false, routing: 'auto' });
    expect(() => ctx.mail.ensureMailDomain('alice.com', bob.id, req)).toThrow(/belongs to another account/);
    expect(app.ctx.db.prepare('SELECT account_id, routing FROM mail_domains WHERE domain = ?').get('alice.com')).toEqual({ account_id: alice.id, routing: 'auto' });
    app.ctx.db.prepare("INSERT INTO mail_domains (domain, account_id, routing) VALUES ('orphan.test', NULL, 'local')").run();
    expect(ctx.mail.ensureMailDomain('orphan.test', bob.id, req)).toEqual({ domain: 'orphan.test', accountId: bob.id, routing: 'local', created: false, claimed: true });
    expect(() => ctx.mail.ensureMailDomain('orphan.test', alice.id, req)).toThrow(/another account/);
    expect(() => ctx.mail.ensureMailDomain('x.test', 424242, req)).toThrow(/Account not found/);
    expect(() => ctx.mail.ensureMailDomain('x.test', 'alice', req)).toThrow(/account id/);
    expect(audits('mail.domain.ensure').map((e) => [e.target, e.args.created])).toEqual([['alice.com', true], ['orphan.test', false]]);
  });
});

describe('S8: ctx.ssl.autossl.lastEntryFor', () => {
  it('returns the newest run entry for a hostname or null', () => {
    const { db, ssl } = app.ctx;
    expect(ssl.autossl.lastEntryFor('alice.com')).toBeNull();
    const insert = db.prepare("INSERT INTO ssl_autossl_runs (trigger, provider, status, finished_at, summary_json, entries_json) VALUES (?, 'acme.sh', 'done', datetime('now'), '{}', ?)");
    insert.run('scheduled', JSON.stringify([{ domain: 'alice.com', account: 'alice', action: 'issue', message: 'issued' }]));
    const second = Number(insert.run('manual', JSON.stringify([{ domain: 'alice.com', account: 'alice', action: 'skip', message: 'valid for 60 more days' }, { domain: 'bob.com', action: 'fail', message: 'dns' }])).lastInsertRowid);
    expect(ssl.autossl.lastEntryFor('alice.com')).toMatchObject({ runId: second, trigger: 'manual', provider: 'acme.sh', status: 'done', action: 'skip', message: 'valid for 60 more days' });
    expect(ssl.autossl.lastEntryFor('bob.com')).toMatchObject({ runId: second, action: 'fail' });
    expect(ssl.autossl.lastEntryFor('nobody.test')).toBeNull();
    db.prepare('DELETE FROM ssl_autossl_runs').run();
  });
});

describe('S10: reseller ACL "login-as"', () => {
  it('is in the catalogue, off until granted explicitly, root always allowed', async () => {
    const { resellers } = app.ctx;
    expect(ACL_KEYS).toContain('login-as');
    expect(EXPLICIT_ACLS.has('login-as')).toBe(true);
    const r = { id: reseller.id, username: 'resell1', role: 'reseller' };
    // Unconfigured reseller: everything by ownership except the explicit privileges.
    expect(resellers.hasAcl(r, 'passwd')).toBe(true);
    expect(resellers.hasAcl(r, 'login-as')).toBe(false);
    expect(() => resellers.assertAcl(r, 'login-as')).toThrow(/Log in to Account Panels/);
    expect(resellers.hasAcl(ROOT, 'login-as')).toBe(true);
    const put = (path, body) => app.http.put(`/api/resellers${path}`).set('X-CSRF-Token', csrf).send(body);
    await put('/resell1/privileges', { acls: ['list-accts', 'passwd'] }).expect(200);
    expect(resellers.hasAcl(r, 'login-as')).toBe(false);
    await put('/resell1/privileges', { acls: ['list-accts', 'login-as'] }).expect(200);
    expect(resellers.hasAcl(r, 'login-as')).toBe(true);
    await put('/resell1/privileges', { acls: ['all'] }).expect(200);
    expect(resellers.hasAcl(r, 'login-as')).toBe(true);
    await put('/resell1/privileges', { acls: [] }).expect(200);
    expect(resellers.hasAcl(r, 'login-as')).toBe(false);
    expect(resellers.hasAcl({ id: 5, role: 'user', accountId: alice.id }, 'login-as')).toBe(false);
  });
});

describe('S11: package feature keys the panel gates on', () => {
  it('all exist in DEFAULT_FEATURES', () => {
    for (const key of ['filemanager', 'emailaccts', 'forwarders', 'autoresponders', 'defaultaddress', 'spamassassin', 'mysql', 'postgres', 'phpmyadmin', 'addondomains', 'subdomains', 'parkeddomains', 'redirects', 'cron', 'ftpaccts', 'sslmanager', 'autossl', 'backup', 'phpversion', 'errlog', 'rawlog', 'passwordchange', 'ssh', 'api']) {
      expect(DEFAULT_FEATURES, key).toHaveProperty(key);
    }
  });
});

describe('S6: WHM password changes reach the panel after the host change', () => {
  it('accounts.setPassword and accounts.create call ctx.panel.syncPassword, and tolerate its absence or failure', async () => {
    const { ctx } = app;
    const saved = ctx.panel;
    const calls = [];
    try {
      ctx.panel = { syncPassword: async (u, p) => { calls.push([u, p]); return { synced: true }; } };
      await ctx.accounts.setPassword('bob', 'New-Passw0rd!2', ROOT, req);
      expect(calls).toEqual([['bob', 'New-Passw0rd!2']]);
      const ops = app.agent.calls.map((c) => c.name);
      expect(ops.indexOf('user.set_password')).toBeGreaterThanOrEqual(0);
      await account('carol', 'carol.com', { password: 'Carol-Passw0rd!3' });
      expect(calls.at(-1)).toEqual(['carol', 'Carol-Passw0rd!3']);
      expect(app.agent.calls.findIndex((c) => c.name === 'user.set_password' && c.args.username === 'carol')).toBeGreaterThanOrEqual(0);
      await account('dave', 'dave.com');
      expect(calls.filter(([u]) => u === 'dave')).toEqual([]);
      ctx.panel = { syncPassword: async () => { throw new Error('no link yet'); } };
      await expect(ctx.accounts.setPassword('bob', 'Third-Passw0rd!4', ROOT, req)).resolves.toMatchObject({ username: 'bob' });
      delete ctx.panel;
      await expect(ctx.accounts.setPassword('bob', 'Fourth-Passw0rd!5', ROOT, req)).resolves.toMatchObject({ username: 'bob' });
    } finally { if (saved) ctx.panel = saved; else delete ctx.panel; }
  });
});

describe('S1: ctx.web.removeVhost / vhostsForAccount', () => {
  it('removes the file through the agent, then the row, audits, never a main vhost', async () => {
    const { ctx } = app;
    const { db } = ctx;
    db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'shop.alice.com', 'sub', '/home/alice/public_html/shop')").run(alice.id);
    await ctx.web.ensureVhost('alice', req);
    expect(ctx.web.vhostsForAccount('alice').map((v) => [v.domain, v.type])).toEqual([['alice.com', 'main'], ['shop.alice.com', 'sub']]);
    expect(ctx.web.vhostsForAccount('nobody')).toEqual([]);
    app.agent.calls.length = 0;
    const r = await ctx.web.removeVhost('shop.alice.com', req);
    expect(r).toMatchObject({ domain: 'shop.alice.com', username: 'alice', type: 'sub', hadRow: true, removed: true });
    expect(app.agent.callsTo('web.vhost.remove').map((c) => c.args)).toEqual([{ domain: 'shop.alice.com', reload: true }]);
    expect(ctx.web.vhostFor('shop.alice.com')).toBeNull();
    expect(audits('web.vhost.remove')).toEqual([{ action: 'web.vhost.remove', target: 'shop.alice.com', args: { username: 'alice', type: 'sub', removed: true, hadRow: true } }]);
    // Host first: a refused agent op leaves the row.
    db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'blog.alice.com', 'sub', '/home/alice/public_html/blog')").run(alice.id);
    await ctx.web.ensureVhost('alice', req);
    app.agent.fail('web.vhost.remove', 'refused', 'not written by the panel');
    await expect(ctx.web.removeVhost('blog.alice.com', req)).rejects.toMatchObject({ agentError: true, code: 'refused' });
    expect(ctx.web.vhostFor('blog.alice.com')).not.toBeNull();
    app.agent.reset('web.vhost.remove');
    app.agent.set('web.vhost.remove', ({ domain }) => ({ domain, removed: true, validated: true, reloaded: true, unit: 'apache2' }));
    // A domain without a row is still tried on the host (a stale file) and reported.
    expect(await ctx.web.removeVhost('gone.alice.com', req)).toMatchObject({ hadRow: false, removed: true });
    await expect(ctx.web.removeVhost('alice.com', req)).rejects.toMatchObject({ status: 409 });
    expect(ctx.web.vhostFor('alice.com')).not.toBeNull();
    db.prepare("DELETE FROM account_domains WHERE domain IN ('shop.alice.com', 'blog.alice.com')").run();
    db.prepare("DELETE FROM web_vhosts WHERE domain = 'blog.alice.com'").run();
  });
});

describe('S5: ctx.web.ftp.enableVirtualUsers', () => {
  it('turns PureDB/AuthUserFile on through the managed config, keeps it across later applies, refuses vsftpd', async () => {
    const { ctx } = app;
    const r = await ctx.web.ftp.enableVirtualUsers(req);
    expect(r).toMatchObject({ daemon: 'pure-ftpd', enabled: true, live: true });
    expect(app.agent.callsTo('web.ftp.config.write').pop().args).toMatchObject({ server: 'pure-ftpd', settings: { virtualUsers: true, passivePortMin: 49152 } });
    expect(ctx.web.ftp.settings().virtualUsers).toBe(true);
    expect(audits('ftp.virtual_users.enable')).toHaveLength(1);
    // Idempotent: nothing is rewritten the second time.
    const before = app.agent.callsTo('web.ftp.config.write').length;
    expect(await ctx.web.ftp.enableVirtualUsers(req)).toMatchObject({ enabled: true, unchanged: true });
    expect(app.agent.callsTo('web.ftp.config.write').length).toBe(before);
    // A later settings change still carries it.
    await ctx.web.ftp.updateSettings({ maxPerIp: 4 }, req);
    expect(app.agent.callsTo('web.ftp.config.write').pop().args.settings).toMatchObject({ virtualUsers: true, maxPerIp: 4 });
    ftpCurrent = 'vsftpd';
    await expect(ctx.web.ftp.enableVirtualUsers(req)).rejects.toMatchObject({ status: 501, capability: 'ftp-virtual' });
  });
});

describe('S4: ctx.web.applyVirtualMail', () => {
  it('renders Dovecot and Exim fragments that read the vmail files and keep the system users first', () => {
    const layout = eximLayout();
    const dc = renderDovecotVirtualAuth({ passwdDir: VMAIL.passwdDir, eximUser: 'Debian-exim', eximGroup: 'Debian-exim', version: '2.3.21' });
    // Lines are keyed by the full address on every version (no username_format), so the lookup key is the login name.
    expect(dc).toContain('args = scheme=SHA512-CRYPT /etc/dovecot/whm/passwd/%d');
    expect(dc).not.toContain('username_format');
    expect(dc).toContain('username_filter = *@*');
    expect(dc.indexOf('passdb {')).toBeLessThan(dc.indexOf('userdb {'));
    expect(dc).toMatch(/passdb \{[^}]*result_success = return-ok[^}]*result_failure = continue/s);
    expect(dc).toContain('unix_listener auth-client');
    expect(dc).toContain('user = Debian-exim');
    expect(dc).toContain('unix_listener lmtp');
    expect(dc).toContain('mail_plugins = $mail_plugins quota');
    expect(renderDovecotVirtualAuth({})).toContain('keep their defaults');
    // Pigeonhole is wired only when asked (the service passes the `sieve` capability): Dovecot checks plugins at
    // delivery time, so an unconditional `sieve` would stop every LMTP delivery on a host without dovecot-sieve.
    expect(dc).not.toMatch(/sieve/i);
    expect(renderDovecotVirtualAuth({ version: '2.3.21', sieve: true })).toContain('protocol lmtp {\n  mail_plugins = $mail_plugins sieve\n}');
    expect(renderDovecotVirtualAuth({ version: '2.3.21', sieve: true })).toContain('sieve_before = ~/mail/sieve-global/keel.sieve');
    expect(renderDovecotVirtualAuth({ version: '2.4.2' })).not.toMatch(/sieve/i);
    expect(renderDovecotVirtualAuth({ version: '2.4.2' })).toContain('protocol lmtp {\n  auth_username_format = %{user | lower}\n}');
    // Dovecot 2.4 (named sections, no args/%n/%d, mail_plugins block, count quota driver), validated with doveconf -n on a 2.4.2 host.
    const dc24 = renderDovecotVirtualAuth({ passwdDir: VMAIL.passwdDir, eximUser: 'Debian-exim', eximGroup: 'Debian-exim', version: '2.4.2', sieve: true });
    expect(dc24).toContain('passdb passwd-file {\n  passwd_file_path = /etc/dovecot/whm/passwd/%{user | domain}\n  default_password_scheme = SHA512-CRYPT');
    expect(dc24).toContain('userdb passwd-file {\n  passwd_file_path = /etc/dovecot/whm/passwd/%{user | domain}');
    expect(dc24).toContain('passdb passwd-file {\n  passwd_file_path = /etc/dovecot/whm/passwd/%{user | domain}\n  default_password_scheme = SHA512-CRYPT\n  username_filter = *@*\n  result_success = return-ok\n  result_failure = continue\n  result_internalfail = continue\n}');
    expect(dc24).toContain('mail_plugins {\n  quota = yes\n}');
    expect(dc24).toContain('quota_driver = count');
    expect(dc24).toContain('protocol imap {\n  mail_plugins {\n    imap_quota = yes');
    // LMTP must look the full address up, or the per-domain passwd file is never found (2.4 default strips the domain).
    expect(dc24).toContain('protocol lmtp {\n  auth_username_format = %{user | lower}\n  mail_plugins {\n    sieve = yes\n  }\n}');
    expect(dc24).toContain('unix_listener auth-client {\n    mode = 0660\n    user = Debian-exim');
    for (const legacy of ['driver = passwd-file', 'args =', 'username_format=%n', '%n', '%d', 'plugin {', '$mail_plugins']) expect(dc24, legacy).not.toContain(legacy);
    expect([dovecotIsV24('2.4.2'), dovecotIsV24('2.4.0'), dovecotIsV24('3.0.0'), dovecotIsV24('2.3.21'), dovecotIsV24(null), dovecotIsV24('')]).toEqual([true, true, true, false, false, false]);
    const routers = renderEximVirtualRouters(layout);
    const names = [...routers.matchAll(/^([a-z_]+):$/gm)].map((m) => m[1]);
    expect(names).toEqual(['whm_domain_forward', 'whm_aliases_copy', 'whm_aliases', 'whm_autoreply', 'whm_virtual_user', 'whm_aliases_default']);
    // Every file name in a lookup comes from a dsearch/lsearch result, never from $domain/$local_part, and every list is guarded by exists{}.
    expect(routers).not.toMatch(/lsearch;[^\n]*\$domain\b/);
    expect(routers).not.toMatch(/\/\$local_part\b/);
    for (const m of routers.matchAll(/^\s+(domains|local_parts) = (.*)$/gm)) expect(m[2], m[0]).toMatch(/^\$\{if exists\{/);
    expect(routers).toContain(`domains = \${if exists{${VMAIL.passwdDir}}{dsearch;${VMAIL.passwdDir}}{}}`);
    // Mailbox lookups use the full address as the lsearch key (the passwd line key), the file name only from $domain_data.
    expect(routers).toContain(`whm_virtual_user:\n  driver = accept\n  domains = \${if exists{${VMAIL.passwdDir}}{dsearch;${VMAIL.passwdDir}}{}}\n  condition = \${if exists{${VMAIL.passwdDir}/$domain_data}{\${lookup{$local_part@$domain_data}lsearch{${VMAIL.passwdDir}/$domain_data}{yes}{no}}}{no}}\n  transport = whm_dovecot_lmtp`);
    expect(routers.match(/lookup\{\$local_part@\$domain_data\}lsearch\{\/etc\/dovecot\/whm\/passwd\/\$domain_data\}/g)).toHaveLength(3);
    expect(routers).not.toMatch(/lookup\{\$local_part\}lsearch\{\/etc\/dovecot/);
    expect(routers).not.toMatch(/local_parts = [^\n]*passwd/);
    expect(routers).toContain('transport = whm_dovecot_lmtp');
    expect(routers).toMatch(/whm_aliases:\n(?:.*\n)*?  forbid_pipe\n  forbid_file/);
    expect(routers).not.toMatch(/allow_pipe|allow_file|\${run/);
    const transports = renderEximVirtualTransports(layout);
    expect(transports).toContain('whm_dovecot_lmtp:\n  driver = lmtp\n  socket = /var/run/dovecot/lmtp');
    expect(transports).toContain('user = Debian-exim');
    expect(transports).toContain(`once = ${VMAIL.autoreplyOnceDir}/$local_part_data@$domain_data.db`);
    const auths = renderEximVirtualAuths(layout, { requireTls: true });
    expect(auths).toContain('dovecot_plain:\n  driver = dovecot\n  public_name = PLAIN\n  server_socket = /var/run/dovecot/auth-client');
    expect(auths).toContain('server_advertise_condition = ${if def:tls_in_cipher}');
    expect(renderEximVirtualAuths(layout, { requireTls: false })).not.toContain('server_advertise_condition');
    const data = renderEximDataAcl(DEFAULTS.exim, { dkim: true, contentScan: true }, { enabled: true }, layout);
    expect(data).toContain(`\${if exists{${VMAIL.spamUsers}}}`);
    expect(data).toContain('spam = ${extract{user}{$acl_m_whm_spam}}:true/defer_ok');
    expect(data).toMatch(/^discard condition/m);
    expect(renderEximDataAcl(DEFAULTS.exim, { dkim: true, contentScan: true }, { enabled: false }, layout)).not.toContain('acl_m_whm_spam');
    expect(renderEximSpamAcl(layout, { contentScan: false }).join('\n')).not.toContain('spam =');
    const main = renderEximMain(DEFAULTS.exim, layout, undefined, { enabled: true, spamdAddress: '127.0.0.1 783' });
    expect(main).toContain('spamd_address = 127.0.0.1 783');
    expect(main).toContain(`CHECK_DATA_LOCAL_ACL_FILE = ${WHM}/acl_data_whm.conf`);
    expect(renderEximMain({ ...DEFAULTS.exim, dkimVerify: false }, layout, undefined, { enabled: true, spamdAddress: '127.0.0.1 783' })).toContain('CHECK_DATA_LOCAL_ACL_FILE');
    expect(renderEximMain({ ...DEFAULTS.exim, dkimVerify: false }, layout, undefined, { enabled: false })).not.toContain('CHECK_DATA_LOCAL_ACL_FILE');
    expect(renderEximMain(DEFAULTS.exim, layout, { spf: true, dkim: true, contentScan: false }, { enabled: true })).not.toContain('spamd_address');
    for (const ok of ['127.0.0.1 783', '/var/run/spamd.sock', 'spamd.internal 783', '[::1] 783']) expect(SPAMD_ADDRESS_RE.test(ok), ok).toBe(true);
    for (const bad of ['127.0.0.1', '127.0.0.1 783; id', 'spamd 783\n', '../x', '']) expect(SPAMD_ADDRESS_RE.test(bad), bad).toBe(false);
  });

  it('writes transport, router, then the exim slots and the Dovecot include, is idempotent, and removes everything on disable', async () => {
    const { ctx } = app;
    const r = await ctx.web.applyVirtualMail({ enabled: true }, req);
    expect(r).toMatchObject({ enabled: true, applied: true, live: true, warnings: [] });
    expect(ctx.web.virtualMail.settings().enabled).toBe(true);
    const names = app.agent.calls.map((c) => c.name).filter((n) => /vmail|include\.(write|remove)/.test(n));
    // Host preparation, then the one-time passwd re-key (pre-upgrade lines keyed by a bare local part), before Dovecot gets the include.
    expect(names.slice(0, 3)).toEqual(['web.vmail.prepare', 'vmail.passwd.rekey', 'web.dovecot.include.write']);
    expect(app.agent.callsTo('vmail.passwd.rekey').map((c) => c.args)).toEqual([{}]);
    expect(r.rekeyed).toMatchObject({ changed: 1, files: [{ domain: 'alice.com', changed: 1 }] });
    const order = app.agent.calls.filter((c) => c.name === 'web.exim.include.write').map((c) => c.args.slot);
    expect(order).toEqual(['transport', 'router', 'acl_data', 'acl_rcpt', 'auth', 'main']);
    expect(app.agent.callsTo('web.exim.include.write').map((c) => c.args.reload)).toEqual([false, false, false, false, false, true]);
    expect(app.agent.callsTo('web.dovecot.include.write').map((c) => c.args.name)).toEqual(['98-whm-virtual-auth.conf']);
    expect(written.router).toContain('whm_virtual_user:');
    expect(written.transport).toContain('whm_dovecot_lmtp:');
    expect(written.auth).toContain('dovecot_plain:');
    expect(written.main).toContain('spamd_address = 127.0.0.1 783');
    expect(written.acl_data).toContain('acl_m_whm_spam');
    expect(audits('virtual_mail.apply')).toHaveLength(1);
    expect(audits('virtual_mail.applied')[0].args).toMatchObject({ enabled: true, live: true });
    expect(ctx.web.virtualMail.settings()).toMatchObject({ enabled: true });
    // Idempotent re-apply (the panel does this at boot): nothing is rewritten, the host preparation runs.
    app.agent.calls.length = 0;
    const again = await ctx.web.applyVirtualMail({ enabled: true }, req);
    expect(again).toMatchObject({ live: true, dovecot: { unchanged: true }, exim: { router: { unchanged: true }, transport: { unchanged: true } } });
    expect(app.agent.callsTo('web.dovecot.include.write')).toEqual([]);
    expect(app.agent.callsTo('web.exim.include.write').map((c) => c.args.slot)).toEqual(['acl_data', 'acl_rcpt', 'auth', 'main']);
    expect(app.agent.callsTo('web.vmail.prepare').map((c) => c.args)).toEqual([{ enabled: true }]);
    const status = await ctx.web.virtualMail.status();
    expect(status).toMatchObject({ enabled: true, installed: true, live: true, exim: { slots: { router: { hooked: true, precedes: true } }, manualIncludes: [] }, dovecot: { include: { exists: true }, version: '2.3.21' }, submissionPorts: { enabled: false, port465: false, port587: false, tls: false } });
    expect(ctx.web.virtualMail.lastApplied()).toMatchObject({ ok: true });
    // The Dovecot fragment follows the detected version.
    dovecotState = dovecotDetect({ version: '2.4.2' });
    const v24 = await ctx.web.applyVirtualMail({ enabled: true }, req);
    expect(v24.live).toBe(true);
    expect(app.agent.callsTo('web.dovecot.include.write').pop().args.content).toContain('passdb passwd-file {');
    dovecotState = dovecotDetect({ includes: { ...dovecotState.includes } });
    // Exim Configuration Manager saves keep the auth fragment in step with requireTlsForAuth.
    await ctx.web.exim.update({ requireTlsForAuth: false }, req);
    expect(written.auth).not.toContain('server_advertise_condition');
    expect(app.agent.callsTo('web.exim.include.write').map((c) => c.args.slot)).toContain('auth');
    // A router loaded after local_user is written but not live.
    app.agent.set('web.exim.include.write', ({ slot: s, content, reload }) => { written[s] = content; eximState.slots[s] = { ...eximState.slots[s], exists: true, content, hooked: true, precedes: s === 'router' ? false : undefined }; return { slot: s, path: eximState.slots[s].path, validated: true, hooked: true, claimedBy: null, precedes: s === 'router' ? false : undefined, reloaded: reload, unit: 'exim4' }; });
    eximState = eximLayout();
    const misordered = await ctx.web.applyVirtualMail({ enabled: true }, req);
    expect(misordered.live).toBe(false);
    expect(misordered.lastApply).toMatchObject({ ok: false, error: expect.stringMatching(/loaded after a local-delivery router/) });
    // Disable: fragments removed, main/data ACL re-rendered without spam, Dovecot include gone, group access revoked.
    app.agent.calls.length = 0;
    const off = await ctx.web.applyVirtualMail({ enabled: false }, req);
    expect(off).toMatchObject({ enabled: false, live: false });
    expect(app.agent.callsTo('web.exim.include.remove').map((c) => c.args.slot)).toEqual(['router', 'transport', 'auth']);
    expect(app.agent.callsTo('web.exim.include.write').map((c) => c.args.slot)).toEqual(['acl_data', 'acl_rcpt', 'main']);
    expect(written.main).not.toContain('spamd_address');
    expect(written.acl_data).not.toContain('acl_m_whm_spam');
    expect(app.agent.callsTo('web.dovecot.include.remove').map((c) => c.args.name)).toEqual(['98-whm-virtual-auth.conf']);
    expect(app.agent.callsTo('web.vmail.prepare').map((c) => c.args)).toEqual([{ enabled: false }]);
    expect(ctx.web.virtualMail.settings().enabled).toBe(false);
  });

  it('a rejected fragment is recorded and surfaces; a missing daemon is a CapabilityError (501) that still saves the switch', async () => {
    const { ctx } = app;
    app.agent.fail('web.dovecot.include.write', 'config_invalid', 'Dovecot rejected the settings; the previous file was restored: unknown setting');
    try {
      await expect(ctx.web.applyVirtualMail({ enabled: true }, req)).rejects.toMatchObject({ agentError: true, code: 'config_invalid' });
      expect(ctx.web.virtualMail.settings().enabled).toBe(true);
      expect((await ctx.web.virtualMail.status()).lastApply).toMatchObject({ ok: false, error: expect.stringMatching(/Dovecot rejected/) });
    } finally { app.agent.reset('web.dovecot.include.write'); }
    app.agent.set('web.dovecot.include.write', ({ name, content, reload }) => ({ name, path: `/etc/dovecot/conf.d/${name}`, validated: true, bytes: content.length, reloaded: reload, unit: 'dovecot' }));
    app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, n === 'dovecot' || n === 'doveadm' ? false : Boolean(FULL_BINS[n])])));
    await ctx.capabilities.refresh();
    try {
      await expect(ctx.web.applyVirtualMail({ enabled: true }, req)).rejects.toMatchObject({ status: 501, capability: 'dovecot' });
      expect(ctx.web.virtualMail.settings().enabled).toBe(true);
      expect(await ctx.web.applyVirtualMail({ enabled: false }, req)).toMatchObject({ enabled: false, applied: false, reason: 'capability_missing', missing: 'dovecot' });
      expect(await ctx.web.virtualMail.status()).toMatchObject({ enabled: false, installed: false, live: false });
    } finally {
      app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(FULL_BINS[n])])));
      await ctx.capabilities.refresh();
    }
  });
});
