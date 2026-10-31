import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { sshChecks, sshKeyLoginBlocked, ITEMS, SSH_HARDENING } from '../src/services/hardening.js';

const BIN_FULL = { sshd: true, 'ssh-keygen': true, iptables: true, nft: true, 'fail2ban-client': true, 'apt-get': true, exim4: true, dovecot: true, 'pure-ftpd': true, named: true, apache2ctl: true };

let app;
let csrf;
let reseller;
let resellerCsrf;
const mutate = (client, method, url, body, token) => client[method](url).set('X-CSRF-Token', token).send(body);
const post = (url, body = {}) => mutate(app.http, 'post', url, body, csrf);
const get = (url) => app.http.get(url);
const auditRows = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

const sshdGet = (effective = {}, managed = {}) => () => ({ installed: true, source: 'sshd -T', effective: { passwordauthentication: 'yes', permitrootlogin: 'yes', port: '22', maxauthtries: '6', logingracetime: '120', x11forwarding: 'yes', ...effective }, managed, managedPath: '/etc/ssh/sshd_config.d/00-whm.conf', legacyPath: null, includeActive: true, configPresent: true, shadowed: [] });
const fwStatus = (over = {}) => () => ({ backend: 'iptables', applied: false, chainPresent: false, policy: 'ACCEPT', hooked: false, families: {}, sshdPorts: [22], sshdSocket: null, hubUnit: false, hubPorts: [], conflicts: { firewalld: false, ufw: false }, tcp: [], udp: [], ...over });

async function provision(installed) {
  app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, installed ? Boolean(BIN_FULL[n]) : false])));
  app.agent.set('svc.list_units', () => (installed ? ['ssh', 'fail2ban', 'exim4'] : []));
  await app.ctx.capabilities.refresh();
}

beforeAll(async () => {
  const agent = createMockAgent({
    'hardening.jails.status': () => ({ installed: true, configured: false, path: '/etc/fail2ban/jail.d/whm.local', filterPath: '/etc/fail2ban/filter.d/whm-panel.conf', running: true, unitEnabled: true, jails: [], bannedTotal: 0 }),
    'hardening.jails.apply': (args) => ({ path: '/etc/fail2ban/jail.d/whm.local', filterPath: '/etc/fail2ban/filter.d/whm-panel.conf', jails: args.jails, validated: true, enabled: true, reloaded: true, status: { installed: true, configured: true, running: true, jails: args.jails.map((name) => ({ name, enabled: true, running: true, currentlyBanned: 0, bannedIps: [] })), bannedTotal: 0 } }),
    'hardening.jails.revert': () => ({ jail: 'removed', filter: 'removed', reloaded: true }),
    'hardening.jails.unban': ({ jail, ip }) => ({ jail, ip, released: true, output: '1' }),
    'hardening.updates.status': () => ({ family: 'debian', installed: true, configured: false, active: false, timerEnabled: false, packages: ['unattended-upgrades'], files: ['/etc/apt/apt.conf.d/20auto-upgrades', '/etc/apt/apt.conf.d/52whm-unattended-upgrades'] }),
    'hardening.updates.apply': () => ({ family: 'debian', files: ['/etc/apt/apt.conf.d/20auto-upgrades', '/etc/apt/apt.conf.d/52whm-unattended-upgrades'], validated: true, timers: { 'apt-daily.timer': true, 'apt-daily-upgrade.timer': true } }),
    'hardening.updates.revert': () => ({ family: 'debian', policy: 'removed', periodic: 'removed' }),
    'hardening.sysctl.status': () => ({ path: '/etc/sysctl.d/90-whm-hardening.conf', configured: false, effective: false, applied: false, checked: 19, mismatched: [{ key: 'net.ipv4.tcp_syncookies', expected: '1', current: '0' }], unavailable: [] }),
    'hardening.sysctl.apply': () => ({ path: '/etc/sysctl.d/90-whm-hardening.conf', previous: { 'net.ipv4.tcp_syncookies': '0', 'net.ipv4.conf.all.rp_filter': '2' }, validated: true }),
    'hardening.sysctl.revert': ({ restore }) => ({ path: '/etc/sysctl.d/90-whm-hardening.conf', file: 'removed', restored: Object.keys(restore) }),
    'hardening.firewall.status': fwStatus(),
    'hardening.firewall.apply': ({ tcp, udp, sshPorts }) => ({ backend: 'iptables', previousPolicy: 'ACCEPT', tcp: tcp.map(String), udp: udp.map(String), sshPorts, status: { applied: true } }),
    'hardening.firewall.revert': ({ restorePolicy }) => ({ backend: 'iptables', restorePolicy, status: { applied: false } }),
    'sec.sshd.get': sshdGet(),
    'sec.sshd.set': ({ settings }) => ({ path: '/etc/ssh/sshd_config.d/00-whm.conf', settings, includeAdded: false, migratedLegacy: false, reloaded: true, unit: 'ssh', shadowed: [] }),
    'sec.ssh_keys.list': () => ({ dir: '/root/.ssh', keys: [], authorized: [], keygenAvailable: true }),
    'sec.firewall.detect': () => ({ backend: 'iptables', available: { iptables: true, nft: true }, blockChain: 'WHM_BLOCK', chainExists: false }),
    'sec.firewall.list': () => ({ backend: 'iptables', entries: [] }),
    'sec.smtp_restrict.get': () => ({ backend: 'iptables', enabled: false, families: { ipv4: false, ipv6: false }, unprotected: ['ipv4', 'ipv6'], groups: ['mail'] }),
    'sec.fork_bomb.get': () => ({ supported: true, enabled: false }),
    'sec.compiler_access.get': () => ({ installed: false, allowed: true, binaries: [] }),
    'sec.scan.filesystem': () => ({ root: '/home', scanned: true, worldWritable: [], sensitive: [] }),
    'sec.modsec.detect': () => ({ installed: false }),
    'sec.userdir.get': () => ({ installed: false, enabled: false }),
  });
  app = await createTestApp({ agent });
  csrf = await app.login();
  const r = await app.createUser('resell1', 'reseller');
  reseller = request.agent(app.ctx.app);
  resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
  await provision(true);
}, 30_000);

afterAll(async () => { await app?.close(); });

beforeEach(() => { app.agent.calls.length = 0; });

describe('module registration', () => {
  it('attaches ctx.hardening, the fail2ban capability and the reconcile job, with nothing queued on a fresh install', () => {
    expect(typeof app.ctx.hardening.status).toBe('function');
    expect(app.ctx.jobs.types()).toContain('hardening.reconcile');
    expect(app.ctx.jobs.list({ type: 'hardening.reconcile' })).toEqual([]);
    expect(app.ctx.capabilities.snapshot().capabilities.fail2ban).toMatchObject({ installed: true });
  });

  it('is root-only', async () => {
    expect((await reseller.get('/api/security/hardening')).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/security/hardening/sysctl/apply', {}, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/security/hardening/fail2ban/unban', { jail: 'sshd', ip: '203.0.113.5' }, resellerCsrf)).status).toBe(403);
  });
});

describe('sshChecks', () => {
  it('accepts stricter values than the targets and rejects the defaults', () => {
    expect(sshChecks({})).toEqual({ PermitRootLogin: false, MaxAuthTries: false, LoginGraceTime: false, X11Forwarding: true });
    expect(sshChecks({ permitrootlogin: 'no', maxauthtries: '3', logingracetime: '20', x11forwarding: 'no' })).toEqual({ PermitRootLogin: true, MaxAuthTries: true, LoginGraceTime: true, X11Forwarding: true });
    expect(sshChecks({ permitrootlogin: 'without-password', maxauthtries: '4', logingracetime: '30' })).toMatchObject({ PermitRootLogin: true, MaxAuthTries: true, LoginGraceTime: true });
    expect(sshChecks({ permitrootlogin: 'prohibit-password', maxauthtries: '5' }).MaxAuthTries).toBe(false);
  });
});

describe('sshKeyLoginBlocked', () => {
  const ok = { pubkeyauthentication: 'yes', authenticationmethods: 'any', authorizedkeysfile: '.ssh/authorized_keys .ssh/authorized_keys2' };
  it('passes only when sshd would actually accept a key from /root/.ssh/authorized_keys', () => {
    expect(sshKeyLoginBlocked(ok, 1)).toBeNull();
    expect(sshKeyLoginBlocked({}, 1)).toBeNull();
    expect(sshKeyLoginBlocked(ok, 0)).toMatch(/no authorized SSH key/);
    expect(sshKeyLoginBlocked({ ...ok, pubkeyauthentication: 'no' }, 1)).toMatch(/PubkeyAuthentication is off/);
    expect(sshKeyLoginBlocked({ ...ok, pubkeyauthentication: 'No' }, 1)).toMatch(/PubkeyAuthentication is off/);
    expect(sshKeyLoginBlocked({ ...ok, authenticationmethods: 'password' }, 1)).toMatch(/AuthenticationMethods/);
    expect(sshKeyLoginBlocked({ ...ok, authenticationmethods: 'password,publickey' }, 1)).toMatch(/AuthenticationMethods/);
    expect(sshKeyLoginBlocked({ ...ok, authenticationmethods: 'publickey,keyboard-interactive' }, 1)).toMatch(/AuthenticationMethods/);
    expect(sshKeyLoginBlocked({ ...ok, authenticationmethods: 'publickey,password publickey' }, 1)).toBeNull();
    expect(sshKeyLoginBlocked({ ...ok, authenticationmethods: 'publickey' }, 1)).toBeNull();
    expect(sshKeyLoginBlocked({ ...ok, authorizedkeysfile: '/etc/ssh/authorized_keys/%u' }, 1)).toMatch(/AuthorizedKeysFile/);
    expect(sshKeyLoginBlocked({ ...ok, authorizedkeysfile: 'none' }, 1)).toMatch(/AuthorizedKeysFile/);
    expect(sshKeyLoginBlocked({ ...ok, authorizedkeysfile: '/etc/ssh/authorized_keys/%u %h/.ssh/authorized_keys' }, 1)).toBeNull();
    expect(sshKeyLoginBlocked({ ...ok, authorizedkeysfile: '/root/.ssh/authorized_keys' }, 1)).toBeNull();
  });
});

describe('GET /security/hardening aggregates one row per item with a live status', () => {
  it('lists the five items in catalogue order with status, reason and desired flag', async () => {
    const res = await get('/api/security/hardening');
    expect(res.status).toBe(200);
    const items = res.body.data.items;
    expect(items.map((i) => i.id)).toEqual(ITEMS.map((i) => i.id));
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.fail2ban).toMatchObject({ status: 'not_applied', desired: false, capability: 'fail2ban' });
    expect(byId.fail2ban.detail.reason).toMatch(/not written/);
    expect(byId['auto-updates']).toMatchObject({ status: 'not_applied', detail: { family: 'debian', installed: true } });
    expect(byId.ssh).toMatchObject({ status: 'not_applied' });
    expect(byId.ssh.detail.failing).toEqual(['PermitRootLogin', 'MaxAuthTries', 'LoginGraceTime', 'X11Forwarding']);
    expect(byId.ssh.detail.blocked).toMatch(/no authorized SSH key/);
    expect(byId.sysctl).toMatchObject({ status: 'not_applied' });
    expect(byId.sysctl.detail.mismatched).toHaveLength(1);
    expect(byId.firewall).toMatchObject({ status: 'not_applied', detail: { backend: 'iptables', sshdPorts: [22] } });
  });

  it('reports not_applicable for items whose subsystem is absent and keeps the rest', async () => {
    app.agent.set('hardening.updates.status', () => ({ family: null, installed: false, configured: false, active: null, timerEnabled: null, packages: [], files: [] }));
    app.agent.set('hardening.sysctl.status', () => ({ path: '/etc/sysctl.d/90-whm-hardening.conf', configured: false, effective: false, applied: false, checked: 0, mismatched: [], unavailable: ['net.ipv4.tcp_syncookies'] }));
    app.agent.set('hardening.firewall.status', fwStatus({ conflicts: { firewalld: true, ufw: false } }));
    const byId = Object.fromEntries((await get('/api/security/hardening')).body.data.items.map((i) => [i.id, i]));
    expect(byId['auto-updates'].status).toBe('not_applicable');
    expect(byId.sysctl.status).toBe('not_applicable');
    expect(byId.firewall.status).toBe('not_applicable');
    expect(byId.firewall.detail.reason).toMatch(/firewalld/);
    app.agent.reset('hardening.updates.status'); app.agent.reset('hardening.sysctl.status'); app.agent.reset('hardening.firewall.status');
    app.agent.set('hardening.updates.status', () => ({ family: 'debian', installed: true, configured: false, active: false, timerEnabled: false, packages: ['unattended-upgrades'], files: [] }));
    app.agent.set('hardening.sysctl.status', () => ({ path: '/etc/sysctl.d/90-whm-hardening.conf', configured: false, effective: false, applied: false, checked: 19, mismatched: [{ key: 'net.ipv4.tcp_syncookies', expected: '1', current: '0' }], unavailable: [] }));
    app.agent.set('hardening.firewall.status', fwStatus());
  });

  it('a failing probe never hides the other items', async () => {
    app.agent.fail('hardening.sysctl.status', 'command_failed', 'sysctl exploded');
    const byId = Object.fromEntries((await get('/api/security/hardening')).body.data.items.map((i) => [i.id, i]));
    expect(byId.sysctl).toMatchObject({ status: 'unknown', detail: { reason: 'sysctl exploded' } });
    expect(byId.fail2ban.status).toBe('not_applied');
    app.agent.set('hardening.sysctl.status', () => ({ path: '/etc/sysctl.d/90-whm-hardening.conf', configured: false, effective: false, applied: false, checked: 19, mismatched: [{ key: 'net.ipv4.tcp_syncookies', expected: '1', current: '0' }], unavailable: [] }));
  });

  it('a missing daemon is reported as installable instead of failing the page', async () => {
    app.agent.set('hardening.jails.status', () => ({ installed: false, configured: false, running: null, jails: [], bannedTotal: 0 }));
    const byId = Object.fromEntries((await get('/api/security/hardening')).body.data.items.map((i) => [i.id, i]));
    expect(byId.fail2ban).toMatchObject({ status: 'not_applied', detail: { installable: true } });
    expect(byId.fail2ban.detail.reason).toMatch(/not installed/);
    const res = await post('/api/security/hardening/fail2ban/apply');
    expect(res.status).toBe(501);
    expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'fail2ban' });
    app.agent.set('hardening.jails.status', () => ({ installed: true, configured: false, path: '/etc/fail2ban/jail.d/whm.local', filterPath: '/etc/fail2ban/filter.d/whm-panel.conf', running: true, unitEnabled: true, jails: [], bannedTotal: 0 }));
  });
});

describe('fail2ban', () => {
  it('apply picks the jails for the daemons this host runs, records the state and writes an audit row', async () => {
    const res = await post('/api/security/hardening/fail2ban/apply', { bantimeSeconds: 7200 });
    expect(res.status).toBe(200);
    const call = app.agent.callsTo('hardening.jails.apply')[0];
    expect(call.args.jails).toEqual(expect.arrayContaining(['whm-panel', 'sshd', 'exim', 'dovecot', 'pure-ftpd', 'apache-auth', 'apache-badbots']));
    expect(call.args.jails).not.toContain('proftpd');
    expect(call.args).toMatchObject({ bantime: 7200, findtime: 600, maxretry: 5, panelPorts: [2086, 2087] });
    // The applying address is exempted (panel jail only) in its plain IPv4 form, never as ::ffff:a.b.c.d.
    expect(call.args.ignoreIps).toEqual(['127.0.0.1']);
    expect(app.ctx.hardening.desired('fail2ban')).toBe(true);
    expect(app.ctx.settings.get('security.hardening.fail2ban.bantime_seconds')).toBe(7200);
    const rows = auditRows('security.hardening.apply').filter((r) => r.target === 'fail2ban');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].args_redacted)).toMatchObject({ bantime: 7200, ignoreIps: ['127.0.0.1'] });
  });

  it('an explicit ignoreIps list replaces the applying address and is validated as IP/CIDR', async () => {
    const res = await post('/api/security/hardening/fail2ban/apply', { ignoreIps: ['203.0.113.0/24', '2001:DB8::5', '203.0.113.0/24'] });
    expect(res.status).toBe(200);
    expect(app.agent.callsTo('hardening.jails.apply')[0].args.ignoreIps).toEqual(['203.0.113.0/24', '2001:db8::5']);
    expect((await post('/api/security/hardening/fail2ban/apply', { ignoreIps: [] })).status).toBe(200);
    expect(app.agent.callsTo('hardening.jails.apply')[1].args.ignoreIps).toEqual([]);
    for (const bad of [['example.com'], ['203.0.113.5/33'], ['1.2.3.4 -j ACCEPT'], 'not-a-list']) expect((await post('/api/security/hardening/fail2ban/apply', { ignoreIps: bad })).status, JSON.stringify(bad)).toBe(422);
    expect(app.agent.callsTo('hardening.jails.apply')).toHaveLength(2);
  });

  it('rejects jails outside the catalogue and bad ban times before the agent is called', async () => {
    expect((await post('/api/security/hardening/fail2ban/apply', { jails: ['sshd; rm -rf /'] })).status).toBe(422);
    expect((await post('/api/security/hardening/fail2ban/apply', { bantimeSeconds: 1 })).status).toBe(422);
    expect((await post('/api/security/hardening/fail2ban/apply', { extra: true })).status).toBe(422);
    expect(app.agent.callsTo('hardening.jails.apply')).toHaveLength(0);
  });

  it('unban validates the jail and the address, then audits', async () => {
    expect((await post('/api/security/hardening/fail2ban/unban', { jail: 'nope', ip: '203.0.113.5' })).status).toBe(422);
    expect((await post('/api/security/hardening/fail2ban/unban', { jail: 'sshd', ip: '203.0.113.5/24' })).status).toBe(422);
    expect((await post('/api/security/hardening/fail2ban/unban', { jail: 'sshd', ip: '-s 1.2.3.4' })).status).toBe(422);
    const res = await post('/api/security/hardening/fail2ban/unban', { jail: 'sshd', ip: '203.0.113.5' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ jail: 'sshd', ip: '203.0.113.5', released: true });
    expect(auditRows('security.hardening.fail2ban.unban')).toHaveLength(1);
  });

  it('revert removes the jails and clears the desired flag', async () => {
    const res = await post('/api/security/hardening/fail2ban/revert');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ item: 'fail2ban', jail: 'removed' });
    expect(app.ctx.hardening.desired('fail2ban')).toBe(false);
    expect(auditRows('security.hardening.revert').some((r) => r.target === 'fail2ban')).toBe(true);
  });
});

describe('automatic updates', () => {
  it('applies through the agent and records the family', async () => {
    const res = await post('/api/security/hardening/auto-updates/apply');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ item: 'auto-updates', family: 'debian', validated: true });
    expect(app.ctx.hardening.desired('auto-updates')).toBe(true);
    expect((await post('/api/security/hardening/auto-updates/revert')).status).toBe(200);
    expect(app.ctx.hardening.desired('auto-updates')).toBe(false);
  });

  it('queues a package install (202) when unattended-upgrades is missing', async () => {
    app.agent.set('hardening.updates.status', () => ({ family: 'debian', installed: false, configured: false, active: null, timerEnabled: null, packages: ['unattended-upgrades'], files: [] }));
    const res = await post('/api/security/hardening/auto-updates/apply');
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ item: 'auto-updates', installing: ['unattended-upgrades'] });
    expect(res.body.data.job.type).toBe('software.pkg.install');
    expect(app.ctx.jobs.get(res.body.data.job.id).params.packages).toEqual(['unattended-upgrades']);
    expect(app.ctx.hardening.desired('auto-updates')).toBe(false);
    app.agent.set('hardening.updates.status', () => ({ family: 'debian', installed: true, configured: false, active: false, timerEnabled: false, packages: ['unattended-upgrades'], files: [] }));
  });
});

describe('ssh', () => {
  it('refuses to restrict root login while root has no authorized key', async () => {
    const res = await post('/api/security/hardening/ssh/apply');
    expect(res.status).toBe(422);
    expect(res.body.error.fields.authorizedKeys).toBeDefined();
    expect(app.agent.callsTo('sec.sshd.set')).toHaveLength(0);
  });

  it('applies the four settings once a key is authorized, never loosening a stricter value, and revert restores the previous managed values', async () => {
    app.agent.set('sec.ssh_keys.list', () => ({ dir: '/root/.ssh', keys: [], authorized: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }], keygenAvailable: true }));
    app.agent.set('sec.sshd.get', sshdGet({ permitrootlogin: 'no', maxauthtries: '3' }, { PermitRootLogin: 'no', MaxAuthTries: '3' }));
    const res = await post('/api/security/hardening/ssh/apply');
    expect(res.status).toBe(200);
    const call = app.agent.callsTo('sec.sshd.set')[0];
    expect(call.args.settings).toEqual({ PermitRootLogin: 'no', MaxAuthTries: 3, LoginGraceTime: SSH_HARDENING.LoginGraceTime, X11Forwarding: 'no' });
    expect(app.ctx.hardening.state('ssh')).toMatchObject({ desired: true, previous: { PermitRootLogin: 'no', MaxAuthTries: '3', LoginGraceTime: null, X11Forwarding: null } });
    app.agent.calls.length = 0;
    const revert = await post('/api/security/hardening/ssh/revert');
    expect(revert.status).toBe(200);
    expect(app.agent.callsTo('sec.sshd.set')[0].args.settings).toEqual({ PermitRootLogin: 'no', MaxAuthTries: 3, LoginGraceTime: null, X11Forwarding: null });
    expect(app.ctx.hardening.desired('ssh')).toBe(false);
    app.agent.set('sec.sshd.get', sshdGet());
    app.agent.set('sec.ssh_keys.list', () => ({ dir: '/root/.ssh', keys: [], authorized: [], keygenAvailable: true }));
  });

  it('refuses while sshd would not accept root\'s key, and reports it as blocked in the status', async () => {
    app.agent.set('sec.ssh_keys.list', () => ({ dir: '/root/.ssh', keys: [], authorized: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }], keygenAvailable: true }));
    for (const [effective, pattern] of [
      [{ pubkeyauthentication: 'no' }, /PubkeyAuthentication is off/],
      [{ authenticationmethods: 'password' }, /AuthenticationMethods/],
      [{ authorizedkeysfile: '/etc/ssh/authorized_keys/%u' }, /AuthorizedKeysFile/],
    ]) {
      app.agent.set('sec.sshd.get', sshdGet(effective));
      app.agent.calls.length = 0;
      const res = await post('/api/security/hardening/ssh/apply');
      expect(res.status, JSON.stringify(effective)).toBe(422);
      expect(res.body.error.fields.authorizedKeys[0]).toMatch(pattern);
      expect(app.agent.callsTo('sec.sshd.set')).toHaveLength(0);
      const byId = Object.fromEntries((await get('/api/security/hardening')).body.data.items.map((i) => [i.id, i]));
      expect(byId.ssh.detail.blocked).toMatch(pattern);
      expect(byId.ssh.detail.authorizedKeys).toBe(1);
    }
    app.agent.set('sec.sshd.get', sshdGet({ pubkeyauthentication: 'yes', authorizedkeysfile: '%h/.ssh/authorized_keys' }));
    expect((await get('/api/security/hardening')).body.data.items.find((i) => i.id === 'ssh').detail.blocked).toBeNull();
    app.agent.set('sec.sshd.get', sshdGet());
    app.agent.set('sec.ssh_keys.list', () => ({ dir: '/root/.ssh', keys: [], authorized: [], keygenAvailable: true }));
  });

  it('keeps forced-commands-only, which prohibit-password would loosen', async () => {
    app.agent.set('sec.ssh_keys.list', () => ({ dir: '/root/.ssh', keys: [], authorized: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }], keygenAvailable: true }));
    app.agent.set('sec.sshd.get', sshdGet({ permitrootlogin: 'forced-commands-only' }));
    expect((await post('/api/security/hardening/ssh/apply')).status).toBe(200);
    expect(app.agent.callsTo('sec.sshd.set')[0].args.settings.PermitRootLogin).toBe('forced-commands-only');
    app.agent.calls.length = 0;
    app.agent.set('sec.sshd.get', sshdGet({ permitrootlogin: 'without-password' }));
    expect((await post('/api/security/hardening/ssh/apply')).status).toBe(200);
    expect(app.agent.callsTo('sec.sshd.set')[0].args.settings.PermitRootLogin).toBe('prohibit-password');
    await post('/api/security/hardening/ssh/revert');
    app.agent.set('sec.sshd.get', sshdGet());
    app.agent.set('sec.ssh_keys.list', () => ({ dir: '/root/.ssh', keys: [], authorized: [], keygenAvailable: true }));
  });

  it('is not applicable without sshd', async () => {
    await provision(false);
    const byId = Object.fromEntries((await get('/api/security/hardening')).body.data.items.map((i) => [i.id, i]));
    expect(byId.ssh.status).toBe('not_applicable');
    expect((await post('/api/security/hardening/ssh/apply')).status).toBe(501);
    await provision(true);
  });
});

describe('sysctl', () => {
  it('apply stores the previous kernel values and revert sends them back', async () => {
    const res = await post('/api/security/hardening/sysctl/apply');
    expect(res.status).toBe(200);
    expect(app.ctx.hardening.state('sysctl').previous).toEqual({ 'net.ipv4.tcp_syncookies': '0', 'net.ipv4.conf.all.rp_filter': '2' });
    const revert = await post('/api/security/hardening/sysctl/revert');
    expect(revert.status).toBe(200);
    expect(app.agent.callsTo('hardening.sysctl.revert')[0].args.restore).toEqual({ 'net.ipv4.tcp_syncookies': '0', 'net.ipv4.conf.all.rp_filter': '2' });
    expect(revert.body.data.restored).toEqual(['net.ipv4.tcp_syncookies', 'net.ipv4.conf.all.rp_filter']);
  });
});

describe('firewall baseline', () => {
  it('the plan lists panel, SSH, web, mail, DNS and FTP ports with their reasons', async () => {
    const res = await get('/api/security/hardening/firewall/plan');
    expect(res.status).toBe(200);
    const plan = res.body.data;
    expect(plan.sshPorts).toEqual([22]);
    const tcp = Object.fromEntries(plan.tcp.map((e) => [typeof e.port === 'number' ? e.port : `${e.port.from}-${e.port.to}`, e.reasons]));
    expect(tcp[2086]).toEqual(['panel']); expect(tcp[2087]).toEqual(['panel']);
    expect(tcp[22]).toEqual(['ssh']);
    expect(tcp[80]).toEqual(['web']); expect(tcp[443]).toEqual(['web']);
    expect(tcp[25]).toEqual(['mail (smtp)']); expect(tcp[993]).toEqual(['mail (imap/pop3)']);
    expect(tcp[53]).toEqual(['dns']); expect(plan.udp.map((e) => e.port)).toEqual([53]);
    expect(tcp[21]).toEqual(['ftp']); expect(tcp['49152-65534']).toEqual(['ftp passive']);
    expect(tcp[7443]).toBeUndefined();
    expect(plan.sshSource).toBe('listening');
    // The DHCPv6 client rule is shown but never sent as a port.
    expect(plan.builtin).toEqual([{ port: 546, proto: 'udp', reasons: ['dhcpv6 client'], scope: 'IPv6 link-local, from port 547' }]);
  });

  it('opens DNS for a PowerDNS host as it does for BIND', async () => {
    app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, n === 'named' ? false : n === 'pdns_server' ? true : Boolean(BIN_FULL[n])])));
    await app.ctx.capabilities.refresh();
    expect(app.ctx.capabilities.has('bind')).toBe(false);
    expect(app.ctx.capabilities.has('powerdns')).toBe(true);
    const plan = (await get('/api/security/hardening/firewall/plan')).body.data;
    expect(plan.tcp.find((e) => e.port === 53).reasons).toEqual(['dns']);
    expect(plan.udp.map((e) => e.port)).toEqual([53]);
    await provision(true);
  });

  it('takes the hub port from its live listener and the SSH ports from the socket unit when that is what holds them', async () => {
    app.agent.set('hardening.firewall.status', fwStatus({ hubUnit: true, hubPorts: [8443], sshdPorts: [2222], sshdSocket: 'ssh.socket' }));
    const plan = (await get('/api/security/hardening/firewall/plan')).body.data;
    const tcp = Object.fromEntries(plan.tcp.map((e) => [e.port, e.reasons]));
    expect(tcp[8443]).toEqual(['license hub']);
    expect(tcp[7443]).toBeUndefined();
    expect(plan).toMatchObject({ sshPorts: [2222], sshSource: 'ssh.socket' });
    expect(tcp[2222]).toEqual(['ssh']);
    expect(tcp[22]).toBeUndefined();
    app.agent.set('hardening.firewall.status', fwStatus({ hubUnit: true, hubPorts: [] }));
    expect(Object.fromEntries((await get('/api/security/hardening/firewall/plan')).body.data.tcp.map((e) => [e.port, e.reasons]))[7443]).toEqual(['license hub']);
    app.agent.set('hardening.firewall.status', fwStatus());
  });

  it('refuses to apply without the SSH port confirmation, with a wrong port, and never calls the agent', async () => {
    const none = await post('/api/security/hardening/firewall/apply', {});
    expect(none.status).toBe(422);
    expect(none.body.error.fields.confirmSshPort).toBeDefined();
    const wrong = await post('/api/security/hardening/firewall/apply', { confirmSshPort: 2222 });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.message).toMatch(/listening on port 22, not 2222/);
    expect((await post('/api/security/hardening/firewall/apply', { confirmSshPort: 22, extraTcp: [70000] })).status).toBe(422);
    expect(app.agent.callsTo('hardening.firewall.apply')).toHaveLength(0);
  });

  it('refuses when sshd listens on a port the plan would not open', async () => {
    app.agent.set('hardening.firewall.status', fwStatus({ sshdPorts: [22, 2222] }));
    const res = await post('/api/security/hardening/firewall/apply', { confirmSshPort: 22 });
    // Both listening ports are in the plan by construction, so the apply goes through with both.
    expect(res.status).toBe(200);
    expect(app.agent.callsTo('hardening.firewall.apply')[0].args.sshPorts).toEqual([22, 2222]);
    expect(app.agent.callsTo('hardening.firewall.apply')[0].args.tcp).toEqual(expect.arrayContaining([22, 2222]));
    app.agent.set('hardening.firewall.status', fwStatus());
    await post('/api/security/hardening/firewall/revert');
  });

  it('applies with the confirmed port, hands the agent the plan, records the previous policy and reverts with it', async () => {
    const res = await post('/api/security/hardening/firewall/apply', { confirmSshPort: 22, extraTcp: [8443], extraUdp: [1194] });
    expect(res.status).toBe(200);
    const call = app.agent.callsTo('hardening.firewall.apply')[0];
    expect(call.args.sshPorts).toEqual([22]);
    expect(call.args.tcp).toEqual(expect.arrayContaining([2086, 2087, 22, 80, 443, 25, 21, 8443, { from: 49152, to: 65534 }]));
    expect(call.args.udp).toEqual([53, 1194]);
    expect(app.ctx.hardening.state('firewall')).toMatchObject({ desired: true, previous: { policy: 'ACCEPT' }, params: { extraTcp: [8443], extraUdp: [1194] } });
    expect(auditRows('security.hardening.apply').some((r) => r.target === 'firewall')).toBe(true);
    const revert = await post('/api/security/hardening/firewall/revert');
    expect(revert.status).toBe(200);
    expect(app.agent.callsTo('hardening.firewall.revert')[0].args).toEqual({ restorePolicy: 'ACCEPT' });
    expect(app.ctx.hardening.desired('firewall')).toBe(false);
  });

  it('refuses while firewalld or ufw own the policy', async () => {
    app.agent.set('hardening.firewall.status', fwStatus({ conflicts: { firewalld: false, ufw: true } }));
    const res = await post('/api/security/hardening/firewall/apply', { confirmSshPort: 22 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/ufw is active/);
    app.agent.set('hardening.firewall.status', fwStatus());
  });

  it('reconcile re-applies the baseline when it was left on and the kernel lost it, keeping the stored extras', async () => {
    await post('/api/security/hardening/firewall/apply', { confirmSshPort: 22, extraTcp: [8443] });
    app.agent.calls.length = 0;
    const out = await app.ctx.hardening.reconcile({ log() {} });
    expect(out.firewall).toMatchObject({ desired: true, reapplied: true, backend: 'iptables' });
    expect(app.agent.callsTo('hardening.firewall.apply')[0].args.tcp).toContain(8443);
    app.agent.set('hardening.firewall.status', fwStatus({ applied: true, policy: 'DROP', chainPresent: true, hooked: true }));
    expect((await app.ctx.hardening.reconcile()).firewall).toMatchObject({ desired: true, reapplied: false, applied: true });
    app.agent.set('hardening.firewall.status', fwStatus());
    await post('/api/security/hardening/firewall/revert');
    expect((await app.ctx.hardening.reconcile()).firewall).toEqual({ desired: false });
  });

  it('a desired baseline queues the reconcile job at boot', async () => {
    await post('/api/security/hardening/firewall/apply', { confirmSshPort: 22 });
    const second = await createTestApp({ agent: app.agent, overrides: { dbPath: `${app.dir}/whm.db`, dataDir: app.dir } });
    try {
      expect(second.ctx.jobs.list({ type: 'hardening.reconcile' }).length).toBeGreaterThan(0);
    } finally {
      second.ctx.jobs.stop(); second.ctx.scheduler.stop(); second.ctx.sessionStore.close(); second.ctx.db.close();
    }
    await post('/api/security/hardening/firewall/revert');
  });
});

describe('Security Advisor integration', () => {
  it('grades every item that is not applied and marks applied ones ok', async () => {
    await post('/api/security/hardening/sysctl/apply');
    app.agent.set('hardening.sysctl.status', () => ({ path: '/etc/sysctl.d/90-whm-hardening.conf', configured: true, effective: true, applied: true, checked: 19, mismatched: [], unavailable: [] }));
    const run = (await post('/api/security/advisor/scan')).body.data;
    const byId = Object.fromEntries(run.findings.filter((f) => f.id.startsWith('hardening.')).map((f) => [f.id, f]));
    expect(byId['hardening.sysctl']).toMatchObject({ grade: 'ok' });
    expect(byId['hardening.fail2ban']).toMatchObject({ grade: 'warning', fix: { path: '/security-center/security-advisor#hardening' } });
    expect(byId['hardening.ssh'].detail).toMatch(/no authorized SSH key/);
    expect(byId['hardening.firewall'].grade).toBe('warning');
    expect(byId['hardening.auto-updates'].grade).toBe('warning');
    await post('/api/security/hardening/sysctl/revert');
  });
});
