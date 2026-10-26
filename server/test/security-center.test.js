import nodeCrypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { passwordStrength, ipInCidr, verifyIdToken, checkDiscoveryDocument } from '../src/services/security-center.js';

const BIN_FULL = { sshd: true, 'ssh-keygen': true, iptables: true, nft: true, apache2ctl: true, 'apt-get': true };
const MODSEC_DETECT = () => ({ installed: true, flavor: 'debian', baseDir: '/etc/modsecurity', mainConf: '/etc/modsecurity/modsecurity.conf', configConf: '/etc/apache2/conf-enabled/zz-whm-modsec-10-config.conf', vendorsDir: '/etc/modsecurity/whm-vendors', errorLog: '/var/log/apache2/error.log', apache: { flavor: 'debian' }, moduleLoaded: true });

let app;
let csrf;
let reseller;
let resellerCsrf;
const mutate = (client, method, url, body, token) => client[method](url).set('X-CSRF-Token', token).send(body);
const put = (url, body) => mutate(app.http, 'put', url, body, csrf);
const post = (url, body = {}) => mutate(app.http, 'post', url, body, csrf);
const del = (url) => mutate(app.http, 'delete', url, undefined, csrf);
const get = (url) => app.http.get(url);

// Flip the detected capabilities between "bare dev box" and "fully provisioned host".
async function provision(installed) {
  app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, installed ? Boolean(BIN_FULL[n]) : false])));
  app.agent.set('svc.list_units', () => (installed ? ['apache2', 'ssh'] : []));
  await app.ctx.capabilities.refresh();
}

beforeAll(async () => {
  const agent = createMockAgent({
    'sec.firewall.detect': () => ({ backend: 'iptables', available: { iptables: true, nft: true }, blockChain: 'WHM_BLOCK', chainExists: true }),
    'sec.firewall.list': () => ({ backend: 'iptables', entries: [{ ip: '203.0.113.9' }] }),
    'sec.firewall.block': ({ ip }) => ({ backend: 'iptables', ip, added: true }),
    'sec.firewall.unblock': ({ ip }) => ({ backend: 'iptables', ip, removed: true }),
    'sec.firewall.flush': () => ({ backend: 'iptables', flushed: true }),
    'sec.smtp_restrict.get': () => ({ backend: 'iptables', enabled: false, families: { ipv4: false, ipv6: false }, unprotected: ['ipv4', 'ipv6'], groups: ['mail'] }),
    'sec.smtp_restrict.set': ({ enabled }) => ({ backend: 'iptables', enabled, families: { ipv4: enabled, ipv6: enabled }, unprotected: enabled ? [] : ['ipv4', 'ipv6'], groups: ['mail'] }),
    'sec.hosts_allow.read': () => ({ allow: '# none', deny: '', supported: true }),
    'sec.hosts_allow.write': ({ rules }) => ({ rules: rules.length, files: ['/etc/hosts.allow', '/etc/hosts.deny'] }),
    'sec.sshd.get': () => ({ installed: true, source: 'sshd -T', effective: { passwordauthentication: 'yes', permitrootlogin: 'yes', port: '22' }, managed: {}, managedPath: '/etc/ssh/sshd_config.d/00-whm.conf', legacyPath: null, includeActive: true, configPresent: true, shadowed: [] }),
    'sec.sshd.set': ({ settings }) => ({ path: '/etc/ssh/sshd_config.d/00-whm.conf', settings, includeAdded: false, migratedLegacy: false, reloaded: true, unit: 'ssh', shadowed: [] }),
    'sec.ssh_keys.list': () => ({ dir: '/root/.ssh', keys: [{ name: 'id_ed25519', type: 'ssh-ed25519', fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', authorized: true, hasPrivateKey: true }], authorized: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', comment: 'root@host' }], keygenAvailable: true }),
    'sec.ssh_keys.add': () => ({ fingerprint: 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', type: 'ssh-ed25519', comment: null }),
    'sec.ssh_keys.generate': ({ name, type, authorize }) => ({ name, type: `ssh-${type}`, fingerprint: 'SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', publicKey: 'ssh-ed25519 AAAA test', privateKeyPath: `/root/.ssh/${name}`, authorized: authorize }),
    'sec.ssh_keys.remove': ({ fingerprint }) => ({ fingerprint, removed: 1 }),
    'sec.ssh_keys.authorize': ({ name }) => ({ name, fingerprint: 'SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' }),
    'sec.ssh_keys.delete_pair': ({ name }) => ({ name, removedFiles: 2, deauthorized: 1 }),
    'sec.ssh_keys.export': ({ name }) => ({ name, privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n-----END OPENSSH PRIVATE KEY-----\n', publicKey: 'ssh-ed25519 AAAA' }),
    'sec.compiler_access.get': () => ({ installed: true, allowed: true, binaries: [{ realPath: '/usr/bin/gcc-13', paths: ['/usr/bin/gcc'], mode: '0755', othersCanExecute: true }] }),
    'sec.compiler_access.set': ({ allow }) => ({ installed: true, allowed: allow, binaries: [{ realPath: '/usr/bin/gcc-13', paths: ['/usr/bin/gcc'], mode: allow ? '0755' : '0750', othersCanExecute: allow }] }),
    'sec.traceroute.get': () => ({ installed: true, allowed: false, binaries: [{ realPath: '/usr/bin/traceroute', paths: ['/usr/bin/traceroute'], mode: '0750', othersCanExecute: false }] }),
    'sec.traceroute.set': ({ enabled }) => ({ installed: true, allowed: enabled, binaries: [] }),
    'sec.fork_bomb.get': () => ({ path: '/etc/security/limits.d/whm-forkbomb.conf', supported: true, enabled: false, maxProcesses: 35, maxOpenFiles: 1024, maxMemoryMb: 512, excludeGroups: ['wheel', 'sudo'] }),
    'sec.fork_bomb.set': (args) => ({ path: '/etc/security/limits.d/whm-forkbomb.conf', ...args }),
    'sec.modsec.detect': MODSEC_DETECT,
    'sec.modsec.get_config': () => ({ base: { SecRuleEngine: 'DetectionOnly' }, managed: {}, effective: { SecRuleEngine: 'DetectionOnly' }, mainConf: '/etc/modsecurity/modsecurity.conf', managedPath: '/etc/apache2/conf-enabled/zz-whm-modsec-10-config.conf' }),
    'sec.modsec.set_config': ({ directives }) => ({ path: '/etc/apache2/conf-enabled/zz-whm-modsec-10-config.conf', directives, unit: 'apache2' }),
    'sec.modsec.list_rules': () => ({ files: [{ file: '/usr/share/modsecurity-crs/rules/a.conf', rules: 2 }], rules: [{ id: 941100, file: '/usr/share/modsecurity-crs/rules/a.conf', msg: 'XSS Attack Detected', severity: 'CRITICAL', phase: 2, vendor: null }, { id: 942100, file: '/usr/share/modsecurity-crs/rules/a.conf', msg: 'SQL Injection Attack', severity: 'CRITICAL', phase: 2, vendor: null }], truncated: false }),
    'sec.modsec.set_disabled': ({ ids }) => ({ path: '/etc/apache2/conf-enabled/zz-whm-modsec-90-disabled.conf', ids, unit: 'apache2' }),
    'sec.modsec.hits': () => ({ file: '/var/log/apache2/error.log', available: true, total: 1, hits: [{ ts: 'Wed Oct 25 10:00:00.000000 2026', client: '203.0.113.5', id: 941100, msg: 'XSS Attack Detected', severity: 'CRITICAL', uri: '/index.php', hostname: 'example.com' }] }),
    'sec.modsec.vendor.install': ({ name }) => ({ name, dir: `/etc/modsecurity/whm-vendors/${name}`, rulesDir: `/etc/modsecurity/whm-vendors/${name}/rules`, bytes: 1000, ruleFiles: 3, rules: 120, setupConf: null }),
    'sec.modsec.vendor.remove': ({ name }) => ({ name, existed: true }),
    'sec.modsec.vendors.apply': ({ vendors }) => ({ path: '/etc/apache2/conf-enabled/zz-whm-modsec-20-vendors.conf', loaded: vendors.filter((v) => v.enabled).map((v) => v.name), unit: 'apache2' }),
    'sec.userdir.get': () => ({ installed: true, flavor: 'debian', path: '/etc/apache2/conf-enabled/zz-whm-userdir.conf', moduleEnabled: false, configured: false, enabled: false, excludeUsers: [] }),
    'sec.userdir.set': ({ enabled, excludeUsers }) => ({ path: '/etc/apache2/conf-enabled/zz-whm-userdir.conf', enabled, excludeUsers, moduleEnabledNow: enabled, unit: 'apache2' }),
    'sec.scan.filesystem': () => ({ root: '/home', scanned: true, worldWritable: ['/home/x/tmp'], sensitive: [{ path: '/etc/shadow', exists: true, mode: '0644', maxMode: '0640', ok: false }] }),
    'svc.reload': ({ unit }) => ({ unit, verb: 'reload', output: '' }),
    'web.reload': () => ({ unit: 'apache2', verb: 'reload', output: '' }),
    'user.list_managed': () => [{ username: 'alice', uid: 1001 }, { username: 'bob', uid: 1002 }],
    'user.groups.members': ({ group }) => (group === 'sudo' ? { group, exists: true, members: ['alice'] } : { group, exists: false, members: [] }),
    'user.groups.set_membership': ({ username, group, member }) => ({ username, group, member }),
  });
  app = await createTestApp({ agent });
  csrf = await app.login();
  const r = await app.createUser('resell1', 'reseller');
  reseller = request.agent(app.ctx.app);
  resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
}, 30_000);

afterAll(async () => { await app?.close(); });

describe('module registration', () => {
  it('attaches ctx.security, jobs and schedules', () => {
    expect(typeof app.ctx.security.policy).toBe('function');
    expect(app.ctx.jobs.types()).toEqual(expect.arrayContaining(['security.cphulk.maintenance', 'security.advisor.scan', 'security.modsec.vendor.install', 'security.firewall.reconcile']));
    // Nothing to restore on a fresh install, so no boot reconcile job is queued.
    expect(app.ctx.jobs.list({ type: 'security.firewall.reconcile' })).toEqual([]);
    expect(app.ctx.scheduler.list().map((s) => s.name)).toEqual(expect.arrayContaining(['security-cphulk-maintenance', 'security-advisor-scan']));
  });

  it('is root-only (RBAC 403 for resellers on every route family)', async () => {
    for (const url of ['/api/security/cphulk', '/api/security/ssh/config', '/api/security/host-access', '/api/security/modsec', '/api/security/advisor', '/api/security/external-auth', '/api/security/wheel']) {
      const res = await reseller.get(url);
      expect(res.status, url).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
    expect((await mutate(reseller, 'put', '/api/security/compilers', { allow: false }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/security/advisor/scan', {}, resellerCsrf)).status).toBe(403);
  });
});

describe('capability degradation on a bare host', () => {
  it('returns 501 capability_missing for sshd, firewall and apache backed functions', async () => {
    await provision(false);
    for (const url of ['/api/security/ssh/config', '/api/security/ssh/keys', '/api/security/modsec']) {
      const res = await get(url);
      expect(res.status, url).toBe(501);
      expect(res.body.error.code).toBe('capability_missing');
      expect(res.body.error.capability).toBeDefined();
    }
    expect((await put('/api/security/smtp-restrictions', { enabled: true })).status).toBe(501);
    expect((await post('/api/security/firewall/block', { ip: '203.0.113.1' })).status).toBe(501);
    expect((await put('/api/security/userdir', { enabled: true })).status).toBe(501);
    expect((await put('/api/security/ssh/config', { settings: { PasswordAuthentication: 'no' } })).status).toBe(501);
    const smtp = await get('/api/security/smtp-restrictions');
    expect(smtp.status).toBe(200);
    expect(smtp.body.data.installed).toBe(false);
    const fw = await get('/api/security/firewall');
    expect(fw.body.data.installed).toBe(false);
    const ud = await get('/api/security/userdir');
    expect(ud.body.data.installed).toBe(false);
  });

  it('reports a missing ModSecurity as 501 even when apache exists', async () => {
    await provision(true);
    app.agent.set('sec.modsec.detect', () => ({ installed: false, flavor: null, apache: { flavor: 'debian' } }));
    const status = await get('/api/security/modsec');
    expect(status.status).toBe(200);
    expect(status.body.data.installed).toBe(false);
    const res = await put('/api/security/modsec/config', { directives: { SecRuleEngine: 'On' } });
    expect(res.status).toBe(501);
    expect(res.body.error.capability).toBe('modsecurity');
    app.agent.set('sec.modsec.detect', MODSEC_DETECT);
    await app.ctx.security.modsec.detect(true);
  });
});

describe('host access control', () => {
  beforeAll(() => provision(true));

  it('stores ordered rules and renders them through the agent', async () => {
    const rules = [{ service: 'sshd', source: '192.0.2.0/24', action: 'allow', comment: 'office' }, { service: 'sshd', source: 'ALL', action: 'deny' }];
    const res = await put('/api/security/host-access', { rules });
    expect(res.status).toBe(200);
    expect(res.body.data.rules.map((r) => [r.service, r.source, r.action, r.position])).toEqual([['sshd', '192.0.2.0/24', 'allow', 0], ['sshd', 'ALL', 'deny', 1]]);
    expect(app.agent.callsTo('sec.hosts_allow.write').at(-1).args.rules).toEqual(rules);
    const list = await get('/api/security/host-access');
    expect(list.body.data.rules).toHaveLength(2);
    expect(list.body.data.services).toContain('sshd');
    expect(list.body.data.files.supported).toBe(true);
  });

  it('rejects injection-shaped sources and services', async () => {
    for (const bad of [{ service: 'sshd; rm', source: 'ALL', action: 'allow' }, { service: 'sshd', source: '1.2.3.4 ALL', action: 'deny' }, { service: 'sshd', source: 'ALL', action: 'drop' }]) {
      const res = await put('/api/security/host-access', { rules: [bad] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });
});

describe('SSH password authorization + root keys', () => {
  beforeAll(() => provision(true));

  it('reads effective sshd config and writes a validated drop-in', async () => {
    const cfg = await get('/api/security/ssh/config');
    expect(cfg.status).toBe(200);
    expect(cfg.body.data.effective.passwordauthentication).toBe('yes');
    expect(cfg.body.data.authorizedKeyCount).toBe(1);
    expect(cfg.body.data.managedPath).toBe('/etc/ssh/sshd_config.d/00-whm.conf');
    const res = await put('/api/security/ssh/config', { settings: { PasswordAuthentication: 'no', PermitRootLogin: 'prohibit-password', MaxAuthTries: 4 } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ reloaded: true, shadowed: [], settings: { PasswordAuthentication: 'no', PermitRootLogin: 'prohibit-password', MaxAuthTries: 4 } });
    expect((await put('/api/security/ssh/config', { settings: { PasswordAuthentication: 'maybe' } })).status).toBe(422);
    expect((await put('/api/security/ssh/config', { settings: { Banner: '/etc/issue' } })).status).toBe(422);
  });

  it('lists, imports, generates, authorizes, exports and deletes keys', async () => {
    const list = await get('/api/security/ssh/keys');
    expect(list.status).toBe(200);
    expect(list.body.data.keys[0].name).toBe('id_ed25519');
    const imported = await post('/api/security/ssh/keys', { publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyDummyDummyDummyDummyDummyDummyDummyDummy comment' });
    expect(imported.status).toBe(200);
    expect(imported.body.data.fingerprint).toMatch(/^SHA256:/);
    expect((await post('/api/security/ssh/keys', { publicKey: 'ssh-rsa AAAA\nssh-rsa BBBB' })).status).toBe(422);
    const gen = await post('/api/security/ssh/keys/generate', { name: 'deploy', type: 'ed25519', authorize: true });
    expect(gen.status).toBe(200);
    expect(gen.body.data).toMatchObject({ name: 'deploy', authorized: true });
    expect(app.agent.callsTo('sec.ssh_keys.generate').at(-1).args).toMatchObject({ name: 'deploy', type: 'ed25519', authorize: true });
    expect((await post('/api/security/ssh/keys/generate', { name: '-rf', type: 'ed25519' })).status).toBe(422);
    expect((await post('/api/security/ssh/keys/generate', { name: '../x', type: 'ed25519' })).status).toBe(422);
    expect((await post('/api/security/ssh/keys/deploy/authorize')).status).toBe(200);
    expect((await post('/api/security/ssh/keys/deauthorize', { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).body.data.removed).toBe(1);
    expect((await post('/api/security/ssh/keys/deauthorize', { fingerprint: 'MD5:xx' })).status).toBe(422);
    const exported = await get('/api/security/ssh/keys/deploy/private');
    expect(exported.body.data.privateKey).toContain('PRIVATE KEY');
    const audit = app.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'security.ssh_keys.export_private' AND target = 'deploy'").get();
    expect(audit).toBeTruthy();
    const removed = await del('/api/security/ssh/keys/deploy?deauthorize=true');
    expect(removed.status).toBe(200);
    expect(app.agent.callsTo('sec.ssh_keys.delete_pair').at(-1).args).toEqual({ name: 'deploy', deauthorize: true });
  });
});

describe('compiler access, traceroute, fork bomb', () => {
  it('toggles compiler and traceroute access through chmod ops', async () => {
    expect((await get('/api/security/compilers')).body.data.allowed).toBe(true);
    const deny = await put('/api/security/compilers', { allow: false });
    expect(deny.status).toBe(200);
    expect(deny.body.data.allowed).toBe(false);
    expect((await put('/api/security/compilers', { allow: 'no' })).status).toBe(422);
    expect((await get('/api/security/traceroute')).body.data.allowed).toBe(false);
    expect((await put('/api/security/traceroute', { enabled: true })).body.data.allowed).toBe(true);
    expect(app.agent.callsTo('sec.traceroute.set').at(-1).args).toEqual({ enabled: true });
  });

  it('writes fork bomb limits and validates them', async () => {
    expect((await get('/api/security/fork-bomb')).body.data.enabled).toBe(false);
    const res = await put('/api/security/fork-bomb', { enabled: true, maxProcesses: 50, excludeGroups: ['wheel'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: true, maxProcesses: 50, excludeGroups: ['wheel'] });
    expect((await put('/api/security/fork-bomb', { enabled: true, maxProcesses: 0 })).status).toBe(422);
    expect((await put('/api/security/fork-bomb', { enabled: true, excludeGroups: ['wheel;sudo'] })).status).toBe(422);
  });
});

describe('cPHulk', () => {
  beforeAll(() => provision(true));

  it('shows settings, stats and updates thresholds', async () => {
    const overview = await get('/api/security/cphulk');
    expect(overview.status).toBe(200);
    expect(overview.body.data.settings).toMatchObject({ enabled: true, maxFailuresPerIp: 15, lockoutMinutes: 30 });
    expect(overview.body.data.stats).toMatchObject({ activeBlocks: 0 });
    const upd = await put('/api/security/cphulk/settings', { maxFailuresPerIp: 5, lockoutMinutes: 60, firewallSync: true });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ maxFailuresPerIp: 5, lockoutMinutes: 60, firewallSync: true });
    expect(app.ctx.settings.get('security.cphulk.max_failures_per_ip')).toBe(5);
    expect((await put('/api/security/cphulk/settings', { lockoutMinutes: 0 })).status).toBe(422);
  });

  it('blocks manually (with firewall sync), lists, unblocks and flushes', async () => {
    const blocked = await post('/api/security/cphulk/blocks', { ip: '198.51.100.7', minutes: 120, reason: 'scanner' });
    expect(blocked.status).toBe(200);
    expect(blocked.body.data).toMatchObject({ ip: '198.51.100.7', reason: 'scanner', firewalled: true });
    expect(app.agent.callsTo('sec.firewall.block').at(-1).args).toEqual({ ip: '198.51.100.7' });
    expect(app.ctx.security.cphulk.isBlocked('198.51.100.7')).toBe(true);
    expect((await post('/api/security/cphulk/blocks', { ip: '198.51.100.7' })).status).toBe(409);
    expect((await post('/api/security/cphulk/blocks', { ip: 'not-an-ip' })).status).toBe(422);
    const list = await get('/api/security/cphulk/blocks');
    expect(list.body.data.map((b) => b.ip)).toContain('198.51.100.7');
    const unblocked = await del(`/api/security/cphulk/blocks/${blocked.body.data.id}`);
    expect(unblocked.status).toBe(200);
    expect(unblocked.body.data).toMatchObject({ ip: '198.51.100.7', unblocked: true, firewalled: true });
    expect(app.ctx.security.cphulk.isBlocked('198.51.100.7')).toBe(false);
    expect((await del('/api/security/cphulk/blocks/999999')).status).toBe(404);
    await post('/api/security/cphulk/blocks', { ip: '198.51.100.8' });
    const flushed = await del('/api/security/cphulk/blocks');
    expect(flushed.body.data).toEqual({ cleared: 1, firewalled: 1 });
    // Only cPHulk's own firewall entries go; the chain is never flushed wholesale.
    expect(app.agent.callsTo('sec.firewall.flush')).toHaveLength(0);
    expect(app.agent.callsTo('sec.firewall.unblock').at(-1).args).toEqual({ ip: '198.51.100.8' });
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM firewall_entries WHERE source = 'cphulk'").get().n).toBe(0);
  });

  it('only accepts CIDR blocks when the firewall drops them, and matches them CIDR-aware', async () => {
    await put('/api/security/cphulk/settings', { firewallSync: false });
    const refused = await post('/api/security/cphulk/blocks', { ip: '198.51.100.0/24' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('validation_failed');
    expect(refused.body.error.message).toMatch(/firewall/);
    expect(app.ctx.security.cphulk.shouldBlock('198.51.100.9')).toBe(false);
    const forced = await post('/api/security/cphulk/blocks', { ip: '198.51.100.0/24', firewall: true, minutes: 10 });
    expect(forced.status).toBe(200);
    expect(forced.body.data.firewalled).toBe(true);
    expect(app.agent.callsTo('sec.firewall.block').at(-1).args).toEqual({ ip: '198.51.100.0/24' });
    expect(app.ctx.security.cphulk.shouldBlock('198.51.100.9')).toBe(true);
    expect(app.ctx.security.cphulk.shouldBlock('198.51.101.9')).toBe(false);
    expect((await del(`/api/security/cphulk/blocks/${forced.body.data.id}`)).status).toBe(200);
    expect(app.ctx.security.cphulk.shouldBlock('198.51.100.9')).toBe(false);
    await put('/api/security/cphulk/settings', { firewallSync: true });
    const synced = await post('/api/security/cphulk/blocks', { ip: '198.51.100.0/24', minutes: 10 });
    expect(synced.status).toBe(200);
    await del(`/api/security/cphulk/blocks/${synced.body.data.id}`);
  });

  it('allowlist entries stop blocks at the database level; denylist entries block permanently', async () => {
    const allow = await post('/api/security/cphulk/lists', { kind: 'allow', ip: '192.0.2.10', comment: 'office' });
    expect(allow.status).toBe(200);
    expect((await post('/api/security/cphulk/lists', { kind: 'allow', ip: '192.0.2.10' })).status).toBe(409);
    // What the login path does after too many failures: the trigger ignores it.
    app.ctx.db.prepare("INSERT INTO cphulk_blocks (ip, reason, expires_at) VALUES (?, 'test', datetime('now', '+30 minutes'))").run('192.0.2.10');
    expect(app.ctx.security.cphulk.isBlocked('192.0.2.10')).toBe(false);
    expect((await post('/api/security/cphulk/blocks', { ip: '192.0.2.10' })).status).toBe(409);
    // An address inside a network that is about to be allowlisted is auto-blocked
    // (what recordFailure does); allowlisting the network releases it at once.
    app.ctx.db.prepare("INSERT INTO cphulk_blocks (ip, reason, expires_at) VALUES (?, 'test', datetime('now', '+30 minutes'))").run('10.1.44.3');
    expect(app.ctx.security.cphulk.shouldBlock('10.1.44.3')).toBe(true);
    const cidr = await post('/api/security/cphulk/lists', { kind: 'allow', ip: '10.1.0.0/16' });
    expect(cidr.status).toBe(200);
    expect(app.ctx.security.cphulk.isAllowlisted('10.1.44.3')).toBe(true);
    expect(app.ctx.security.cphulk.isAllowlisted('10.2.44.3')).toBe(false);
    expect(app.ctx.security.cphulk.shouldBlock('10.1.44.3')).toBe(false);
    expect((await get('/api/security/cphulk/blocks')).body.data.map((b) => b.ip)).not.toContain('10.1.44.3');

    const deny = await post('/api/security/cphulk/lists', { kind: 'deny', ip: '203.0.113.200' });
    expect(deny.status).toBe(200);
    expect(app.ctx.security.cphulk.isBlocked('203.0.113.200')).toBe(true);
    expect((await get('/api/security/cphulk/blocks')).body.data.find((b) => b.ip === '203.0.113.200')).toMatchObject({ permanent: true, reason: 'denylist' });
    const denyNet = await post('/api/security/cphulk/lists', { kind: 'deny', ip: '203.0.114.0/24' });
    expect(denyNet.status).toBe(200);
    expect(app.ctx.security.cphulk.shouldBlock('203.0.114.77')).toBe(true);
    expect((await get('/api/security/cphulk/blocks')).body.data.map((b) => b.ip)).not.toContain('203.0.114.0/24');
    const lists = await get('/api/security/cphulk/lists');
    expect(lists.body.data).toHaveLength(4);
    expect((await del(`/api/security/cphulk/lists/${deny.body.data.id}`)).status).toBe(200);
    expect((await del(`/api/security/cphulk/lists/${denyNet.body.data.id}`)).status).toBe(200);
    expect(app.ctx.security.cphulk.isBlocked('203.0.113.200')).toBe(false);
    expect(app.ctx.security.cphulk.shouldBlock('203.0.114.77')).toBe(false);
    expect((await del('/api/security/cphulk/lists/999')).status).toBe(404);
  });

  it('paginates login history with failure filter and syncs the firewall in maintenance', async () => {
    app.ctx.db.prepare("INSERT INTO login_attempts (ip, username, ok) VALUES ('203.0.113.77', 'root', 0), ('203.0.113.77', 'root', 1)").run();
    const failed = await get('/api/security/cphulk/history?failed=true&q=203.0.113.77');
    expect(failed.status).toBe(200);
    expect(failed.body.meta.total).toBe(1);
    expect(failed.body.data[0]).toMatchObject({ ip: '203.0.113.77', ok: 0 });
    expect((await get('/api/security/cphulk/history?q=203.0.113.77')).body.meta.total).toBe(2);

    app.ctx.db.prepare("INSERT INTO login_attempts (ip, username, ok, created_at) VALUES ('203.0.113.1', 'old', 0, datetime('now', '-400 days'))").run();
    app.agent.calls.length = 0;
    await post('/api/security/cphulk/blocks', { ip: '198.51.100.50', minutes: 30 });
    // A cPHulk entry whose block has since expired is removed; one that reached
    // the chain by other means (203.0.113.9 in the mock chain) is left alone.
    app.ctx.db.prepare("INSERT INTO cphulk_blocks (ip, reason, expires_at) VALUES ('198.51.100.51', 'stale', datetime('now', '-1 hour'))").run();
    app.ctx.db.prepare("INSERT INTO firewall_entries (ip, source) VALUES ('198.51.100.51', 'cphulk')").run();
    app.agent.calls.length = 0;
    const m = await post('/api/security/cphulk/maintenance');
    expect(m.status).toBe(200);
    expect(m.body.data.purgedAttempts).toBeGreaterThanOrEqual(1);
    expect(m.body.data.firewall).toEqual({ backend: 'iptables', added: 1, removed: 0, manual: 0, cphulk: 1, untracked: 1 });
    expect(app.agent.callsTo('sec.firewall.block').map((c) => c.args.ip)).toEqual(['198.51.100.50']);
    expect(app.agent.callsTo('sec.firewall.unblock').map((c) => c.args.ip)).not.toContain('203.0.113.9');
    expect(app.ctx.db.prepare("SELECT ip FROM firewall_entries WHERE source = 'cphulk'").all().map((r) => r.ip)).toEqual(['198.51.100.50']);
    expect(m.body.data.smtp).toEqual({ desired: false, reapplied: false });
  });
});

describe('firewall chain', () => {
  beforeAll(() => provision(true));

  it('lists, blocks and unblocks addresses through the sec.firewall ops', async () => {
    const status = await get('/api/security/firewall');
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ installed: true, backend: 'iptables' });
    expect(status.body.data.entries.find((e) => e.ip === '203.0.113.9')).toEqual({ ip: '203.0.113.9', sources: [], comment: null, persistent: false, active: true });
    const blocked = await post('/api/security/firewall/block', { ip: '203.0.113.44', comment: 'port scan' });
    expect(blocked.status).toBe(200);
    expect(blocked.body.data).toMatchObject({ ip: '203.0.113.44', added: true, source: 'manual', persistent: true });
    expect(app.agent.callsTo('sec.firewall.block').at(-1).args).toEqual({ ip: '203.0.113.44' });
    expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'security.firewall.block' AND target = '203.0.113.44'").get()).toBeTruthy();
    const net = await post('/api/security/firewall/block', { ip: '2001:db8::/32' });
    expect(net.status).toBe(200);
    // Recorded blocks show up even while the live chain (mock) lacks them.
    const listed = (await get('/api/security/firewall')).body.data.entries;
    expect(listed.find((e) => e.ip === '203.0.113.44')).toMatchObject({ sources: ['manual'], comment: 'port scan', active: false, persistent: true });
    const unblocked = await post('/api/security/firewall/unblock', { ip: '203.0.113.44' });
    expect(unblocked.status).toBe(200);
    expect(unblocked.body.data).toMatchObject({ ip: '203.0.113.44', removed: true });
    expect(app.agent.callsTo('sec.firewall.unblock').at(-1).args).toEqual({ ip: '203.0.113.44' });
    expect((await get('/api/security/firewall')).body.data.entries.map((e) => e.ip)).not.toContain('203.0.113.44');
    for (const ip of ['-s', '1.2.3.4;id', '1.2.3.4 -j ACCEPT', 'example.com']) {
      expect((await post('/api/security/firewall/block', { ip })).status, ip).toBe(422);
      expect((await post('/api/security/firewall/unblock', { ip })).status, ip).toBe(422);
    }
    expect((await mutate(reseller, 'post', '/api/security/firewall/block', { ip: '203.0.113.44' }, resellerCsrf)).status).toBe(403);
  });

  it('keeps manual blocks across the hourly sync and restores them when the chain lost them', async () => {
    await put('/api/security/cphulk/settings', { firewallSync: true });
    app.agent.calls.length = 0;
    const m = await post('/api/security/cphulk/maintenance');
    expect(m.status).toBe(200);
    // 2001:db8::/32 was blocked manually above and is missing from the mock chain: re-added, never removed.
    expect(m.body.data.firewall).toMatchObject({ manual: 1, removed: 0, untracked: 1 });
    expect(app.agent.callsTo('sec.firewall.block').map((c) => c.args.ip)).toContain('2001:db8::/32');
    expect(app.agent.callsTo('sec.firewall.unblock').map((c) => c.args.ip)).toEqual([]);
    // Blocking the same address through cPHulk then lifting that block keeps the manual rule.
    const b = await post('/api/security/cphulk/blocks', { ip: '2001:db8::/32', minutes: 5 });
    expect(b.status).toBe(200);
    app.agent.calls.length = 0;
    expect((await del(`/api/security/cphulk/blocks/${b.body.data.id}`)).body.data.firewalled).toBe(false);
    expect(app.agent.callsTo('sec.firewall.unblock')).toHaveLength(0);
    expect(app.ctx.db.prepare('SELECT source FROM firewall_entries WHERE ip = ?').all('2001:db8::/32').map((r) => r.source)).toEqual(['manual']);
    const direct = await post('/api/security/firewall/reconcile');
    expect(direct.status).toBe(200);
    expect(direct.body.data.firewall).toMatchObject({ manual: 1 });
  });

  it('queues a boot-time reconcile job when there is something to restore', async () => {
    const other = await createTestApp({ agent: createMockAgent() });
    try {
      expect(other.ctx.jobs.list({ type: 'security.firewall.reconcile' })).toEqual([]);
      other.ctx.settings.set('security.smtp_restrictions.enabled', true);
      await other.ctx.jobs.stop();
      const again = await createTestApp({ agent: createMockAgent(), overrides: { dataDir: other.dir, dbPath: `${other.dir}/whm.db` } });
      try {
        const queued = again.ctx.jobs.list({ type: 'security.firewall.reconcile' });
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({ status: 'queued', params: { trigger: 'boot' } });
      } finally { again.ctx.jobs.stop(); again.ctx.scheduler.stop(); again.ctx.sessionStore.close(); again.ctx.db.close(); }
    } finally { await other.close(); }
  });

  it('refuses when the detected backend is unsupported', async () => {
    app.agent.set('sec.firewall.detect', () => ({ backend: null, available: { iptables: false, nft: false }, blockChain: 'WHM_BLOCK', chainExists: false }));
    try {
      const res = await post('/api/security/firewall/unblock', { ip: '203.0.113.44' });
      expect(res.status).toBe(501);
      expect(res.body.error.capability).toBe('firewall');
    } finally {
      app.agent.set('sec.firewall.detect', () => ({ backend: 'iptables', available: { iptables: true, nft: true }, blockChain: 'WHM_BLOCK', chainExists: true }));
    }
  });
});

describe('SMTP restrictions, mod_userdir, wheel group', () => {
  beforeAll(() => provision(true));

  it('enables SMTP restrictions through the firewall op and reports both address families', async () => {
    const before = await get('/api/security/smtp-restrictions');
    expect(before.body.data).toMatchObject({ installed: true, enabled: false, desired: false, families: { ipv4: false, ipv6: false } });
    const res = await put('/api/security/smtp-restrictions', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: true, desired: true, groups: ['mail'], families: { ipv4: true, ipv6: true }, unprotected: [] });
    expect((await put('/api/security/smtp-restrictions', {})).status).toBe(422);
  });

  it('persists the switch and re-applies the rules from the maintenance job after they vanish', async () => {
    expect(app.ctx.settings.get('security.smtp_restrictions.enabled')).toBe(true);
    // The mock chain reports the rules as gone (reboot / firewall restart).
    expect((await get('/api/security/smtp-restrictions')).body.data).toMatchObject({ enabled: false, desired: true });
    app.agent.calls.length = 0;
    const m = await post('/api/security/cphulk/maintenance');
    expect(m.body.data.smtp).toMatchObject({ desired: true, reapplied: true, families: { ipv4: true, ipv6: true } });
    expect(app.agent.callsTo('sec.smtp_restrict.set').map((c) => c.args)).toEqual([{ enabled: true }]);
    // Already active: nothing to do.
    app.agent.set('sec.smtp_restrict.get', () => ({ backend: 'iptables', enabled: true, families: { ipv4: true, ipv6: null }, unprotected: ['ipv6'], groups: ['mail'] }));
    app.agent.calls.length = 0;
    expect((await post('/api/security/cphulk/maintenance')).body.data.smtp).toMatchObject({ desired: true, reapplied: false });
    expect(app.agent.callsTo('sec.smtp_restrict.set')).toHaveLength(0);
    app.agent.set('sec.smtp_restrict.get', () => ({ backend: 'iptables', enabled: false, families: { ipv4: false, ipv6: false }, unprotected: ['ipv4', 'ipv6'], groups: ['mail'] }));
    const off = await put('/api/security/smtp-restrictions', { enabled: false });
    expect(off.body.data.desired).toBe(false);
    expect(app.ctx.settings.get('security.smtp_restrictions.enabled')).toBe(false);
    expect((await post('/api/security/cphulk/maintenance')).body.data.smtp).toEqual({ desired: false, reapplied: false });
  });

  it('writes the userdir include and reloads Apache', async () => {
    const res = await put('/api/security/userdir', { enabled: true, excludeUsers: ['alice'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: true, excludeUsers: ['alice'] });
    expect(app.agent.callsTo('sec.userdir.set').at(-1).args).toEqual({ enabled: true, excludeUsers: ['alice'], homeRoot: '/home' });
    // The reload goes through ctx.web.reload (web.reload op) when the Service
    // Configuration category is loaded, and through systemd (svc.reload) otherwise.
    expect(app.agent.callsTo('svc.reload').length + app.agent.callsTo('web.reload').length).toBeGreaterThan(0);
    expect((await put('/api/security/userdir', { enabled: true, excludeUsers: ['Bad User'] })).status).toBe(422);
  });

  it('falls back to systemd when no web category is attached', async () => {
    const prev = app.ctx.web;
    app.ctx.web = undefined;
    app.agent.calls.length = 0;
    try {
      const res = await put('/api/security/userdir', { enabled: false });
      expect(res.status).toBe(200);
      expect(app.agent.callsTo('svc.reload').at(-1).args).toEqual({ unit: 'apache2' });
      expect(app.agent.callsTo('web.reload')).toHaveLength(0);
    } finally { app.ctx.web = prev; }
  });

  it('uses ctx.web.reload when the web category is present', async () => {
    const prev = app.ctx.web;
    const calls = [];
    app.ctx.web = { reload: async () => { calls.push('web'); return { via: 'web' }; } };
    try {
      const res = await put('/api/security/userdir', { enabled: false });
      expect(res.body.data.reload).toEqual({ via: 'web' });
      expect(calls).toEqual(['web']);
    } finally { app.ctx.web = prev; }
  });

  it('manages wheel/sudo membership', async () => {
    const list = await get('/api/security/wheel');
    expect(list.status).toBe(200);
    expect(list.body.data).toMatchObject({ group: 'sudo', exists: true, members: ['alice'] });
    expect(list.body.data.candidates).toContain('bob');
    expect(list.body.data.candidates).not.toContain('alice');
    const add = await post('/api/security/wheel', { username: 'bob' });
    expect(add.status).toBe(200);
    expect(app.agent.callsTo('user.groups.set_membership').at(-1).args).toEqual({ username: 'bob', group: 'sudo', member: true });
    expect((await post('/api/security/wheel', { username: 'alice' })).status).toBe(409);
    expect((await post('/api/security/wheel', { username: 'Bob;' })).status).toBe(422);
    expect((await del('/api/security/wheel/alice')).status).toBe(200);
    expect((await del('/api/security/wheel/nobody-here')).status).toBe(404);
  });
});

describe('ModSecurity', () => {
  beforeAll(async () => { await provision(true); await app.ctx.security.modsec.detect(true); });

  it('reports status and writes engine directives', async () => {
    const status = await get('/api/security/modsec');
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ installed: true, effective: { SecRuleEngine: 'DetectionOnly' } });
    const res = await put('/api/security/modsec/config', { directives: { SecRuleEngine: 'On', SecRequestBodyLimit: 13107200 } });
    expect(res.status).toBe(200);
    expect(res.body.data.directives).toEqual({ SecRuleEngine: 'On', SecRequestBodyLimit: 13107200 });
    expect((await put('/api/security/modsec/config', { directives: { SecRuleEngine: 'Maybe' } })).status).toBe(422);
    expect((await put('/api/security/modsec/config', { directives: { SecAuditLog: '/tmp/x' } })).status).toBe(422);
  });

  it('lists rules with search, disables and re-enables one, shows hits', async () => {
    const rules = await get('/api/security/modsec/rules?q=sql');
    expect(rules.status).toBe(200);
    expect(rules.body.meta.total).toBe(1);
    expect(rules.body.data[0]).toMatchObject({ id: 942100, disabled: false });
    const off = await put('/api/security/modsec/rules/942100', { disabled: true, reason: 'false positive on checkout' });
    expect(off.status).toBe(200);
    expect(off.body.data.ids).toEqual([942100]);
    expect(app.agent.callsTo('sec.modsec.set_disabled').at(-1).args).toEqual({ ids: [942100] });
    expect((await get('/api/security/modsec/rules?disabled=true')).body.data.map((r) => r.id)).toEqual([942100]);
    expect((await get('/api/security/modsec/rules/disabled')).body.data).toEqual([expect.objectContaining({ rule_id: 942100, reason: 'false positive on checkout' })]);
    expect((await put('/api/security/modsec/rules/942100', { disabled: false })).body.data.ids).toEqual([]);
    const hits = await get('/api/security/modsec/hits?limit=10');
    expect(hits.body.data.hits[0]).toMatchObject({ id: 941100, client: '203.0.113.5' });
  });

  it('installs a vendor as a job, lists, toggles and removes it', async () => {
    app.ctx.jobs.start();
    expect((await get('/api/security/modsec/vendors')).body.data).toEqual([]);
    const bad = await post('/api/security/modsec/vendors', { name: 'owasp', url: 'http://example.com/crs.tar.gz' });
    expect(bad.status).toBe(422);
    const res = await post('/api/security/modsec/vendors', { name: 'owasp', url: 'https://example.com/crs.tar.gz' });
    expect(res.status).toBe(202);
    expect(res.body.data.job.type).toBe('security.modsec.vendor.install');
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ name: 'owasp', ruleFiles: 3, applied: { loaded: ['owasp'] } });
    const vendors = await get('/api/security/modsec/vendors');
    expect(vendors.status).toBe(200);
    expect(vendors.body.data).toEqual([expect.objectContaining({ name: 'owasp', url: 'https://example.com/crs.tar.gz', enabled: true })]);
    expect(typeof vendors.body.data[0].enabled).toBe('boolean');
    expect((await post('/api/security/modsec/vendors', { name: 'owasp', url: 'https://example.com/crs.tar.gz' })).status).toBe(409);
    const toggled = await mutate(app.http, 'patch', '/api/security/modsec/vendors/owasp', { enabled: false }, csrf);
    expect(toggled.status).toBe(200);
    expect(toggled.body.data.applied.loaded).toEqual([]);
    expect((await get('/api/security/modsec/vendors')).body.data[0].enabled).toBe(false);
    expect((await post('/api/security/modsec/vendors/owasp/update')).status).toBe(202);
    expect((await del('/api/security/modsec/vendors/owasp')).body.data.removed).toBe(true);
    expect(app.agent.callsTo('sec.modsec.vendor.remove').at(-1).args).toEqual({ name: 'owasp' });
    expect((await del('/api/security/modsec/vendors/owasp')).status).toBe(404);
  }, 15_000);
});

describe('password strength, policies, questions', () => {
  it('scores passwords against the default and per-context minimum', () => {
    expect(passwordStrength('')).toBe(0);
    expect(passwordStrength('password1')).toBe(5);
    expect(passwordStrength('Tr0ub4dor&3xyz')).toBeGreaterThanOrEqual(65);
  });

  it('exposes a checker endpoint and the policy object', async () => {
    const weak = await post('/api/security/password-strength', { password: 'abc', context: 'panel' });
    expect(weak.status).toBe(200);
    expect(weak.body.data).toMatchObject({ ok: false, minimum: 65, context: 'panel' });
    await put('/api/system/settings', { 'security.password.strength.panel': 20 });
    expect((await post('/api/security/password-strength', { password: 'abcdefgh1', context: 'panel' })).body.data).toMatchObject({ minimum: 20, ok: true });
    expect((await post('/api/security/password-strength', { password: 'abc', context: 'bogus' })).status).toBe(422);
    const policy = await get('/api/security/policy');
    expect(policy.body.data).toMatchObject({ verifiedIpLogin: false, passwordMaxAgeDays: 0, require2faForResellers: false });
    expect(app.ctx.settings.get('security.questions.required_count')).toBe(3);
    expect(Array.isArray(app.ctx.settings.get('security.questions.pool'))).toBe(true);
  });
});

describe('external authentications', () => {
  it('creates providers with encrypted secrets, updates, discovers (failure path) and deletes', async () => {
    const created = await post('/api/security/external-auth', { name: 'corp', displayName: 'Corp SSO', issuerUrl: 'https://login.example.com/', clientId: 'whm', clientSecret: 'top-secret-value' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'corp', issuerUrl: 'https://login.example.com', hasClientSecret: true, enabled: true, links: 0 });
    expect(created.body.data.clientSecret).toBeUndefined();
    const row = app.ctx.db.prepare('SELECT client_secret_enc FROM external_auth_providers WHERE name = ?').get('corp');
    expect(row.client_secret_enc).not.toContain('top-secret-value');
    expect(app.ctx.crypto.decrypt(row.client_secret_enc)).toBe('top-secret-value');
    const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'POST /api/security/external-auth' ORDER BY id DESC LIMIT 1").get();
    expect(audit.args_redacted).not.toContain('top-secret-value');
    const list = await get('/api/security/external-auth');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([expect.objectContaining({ name: 'corp', displayName: 'Corp SSO', hasClientSecret: true, enabled: true })]);
    expect(list.body.data[0].clientSecret).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain('top-secret-value');

    expect((await post('/api/security/external-auth', { name: 'corp', displayName: 'Dup', issuerUrl: 'https://x.example.com', clientId: 'a' })).status).toBe(409);
    expect((await post('/api/security/external-auth', { name: 'Bad Name', displayName: 'x', issuerUrl: 'https://x.example.com', clientId: 'a' })).status).toBe(422);
    expect((await post('/api/security/external-auth', { name: 'plain', displayName: 'x', issuerUrl: 'http://x.example.com', clientId: 'a' })).status).toBe(422);

    const updated = await put('/api/security/external-auth/corp', { enabled: false, scopes: 'openid email' });
    expect(updated.body.data).toMatchObject({ enabled: false, scopes: 'openid email' });
    const discover = await post('/api/security/external-auth/corp/discover');
    expect(discover.status).toBe(400);
    expect(discover.body.error.message).toMatch(/discovery failed/);
    expect(() => app.ctx.security.externalAuth.authorizationUrl('corp', { state: 's', redirectUri: 'https://panel/cb' })).toThrow(/disabled/);

    app.ctx.db.prepare("UPDATE external_auth_providers SET enabled = 1, discovery_json = ? WHERE name = 'corp'").run(JSON.stringify({ authorizationEndpoint: 'https://login.example.com/authorize', tokenEndpoint: 'https://login.example.com/token' }));
    const url = new URL(app.ctx.security.externalAuth.authorizationUrl('corp', { state: 'st', nonce: 'n', redirectUri: 'https://panel/cb' }));
    expect(url.origin + url.pathname).toBe('https://login.example.com/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: 'whm', redirect_uri: 'https://panel/cb', scope: 'openid email', state: 'st', nonce: 'n' });
    const link = app.ctx.security.externalAuth.link('corp', { userId: 1, subject: 'sub-1', email: 'root@example.com' });
    expect(link).toMatchObject({ username: 'root', subject: 'sub-1' });
    expect(app.ctx.security.externalAuth.findLinkedUser('corp', 'sub-1').user_id).toBe(1);
    expect((await get('/api/security/external-auth/corp')).body.data.links).toBe(1);

    expect((await del('/api/security/external-auth/corp')).body.data).toEqual({ deleted: true });
    expect((await get('/api/security/external-auth/corp')).status).toBe(404);
  });

  const ISSUER = 'https://login.example.com';
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const now = Math.floor(Date.now() / 1000);
  const baseClaims = { iss: ISSUER, aud: 'whm', sub: 'user-42', email: 'alice@example.com', iat: now, exp: now + 300, nonce: 'n1' };
  const sign = (claims, { alg = 'RS256', header = {} } = {}) => {
    const h = b64({ alg, kid: 'k1', ...header });
    const p = b64(claims);
    const sig = alg === 'HS256' ? nodeCrypto.createHmac('sha256', 'top-secret-value').update(`${h}.${p}`).digest('base64url') : nodeCrypto.sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
    return `${h}.${p}.${sig}`;
  };
  const verify = (claims, opts = {}, signOpts) => verifyIdToken(sign(claims, signOpts), { issuer: ISSUER, clientId: 'whm', nonce: 'n1', jwks: [jwk], ...opts });

  it('verifies id_token signature and claims before trusting them', () => {
    expect(verify(baseClaims)).toMatchObject({ sub: 'user-42', email: 'alice@example.com' });
    expect(() => verify(baseClaims, { jwks: [] })).toThrow(/signature/);
    const { publicKey: otherPub } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => verify(baseClaims, { jwks: [{ ...otherPub.export({ format: 'jwk' }), kid: 'k1' }] })).toThrow(/signature/);
    expect(() => verify(baseClaims, {}, { alg: 'none' })).toThrow(/unsupported alg/);
    expect(() => verify({ ...baseClaims, iss: 'https://evil.example.com' })).toThrow(/issuer/);
    expect(verify({ ...baseClaims, iss: `${ISSUER}/` })).toMatchObject({ sub: 'user-42' });
    expect(() => verify({ ...baseClaims, aud: 'other-client' })).toThrow(/audience/);
    expect(verify({ ...baseClaims, aud: ['whm', 'api'], azp: 'whm' })).toMatchObject({ sub: 'user-42' });
    expect(() => verify({ ...baseClaims, aud: ['whm', 'api'], azp: 'api' })).toThrow(/azp/);
    expect(() => verify({ ...baseClaims, exp: now - 600 })).toThrow(/expired/);
    expect(() => verify({ ...baseClaims, iat: now + 3600 })).toThrow(/future/);
    expect(() => verify({ ...baseClaims, nonce: 'other' })).toThrow(/nonce/);
    expect(() => verify(baseClaims, { nonce: 'n2' })).toThrow(/nonce/);
    expect(() => verify({ ...baseClaims, nonce: undefined })).toThrow(/nonce/);
    expect(() => verify({ ...baseClaims, sub: undefined })).toThrow(/subject/);
    expect(() => verifyIdToken('a.b', { issuer: ISSUER, clientId: 'whm' })).toThrow(/compact JWS/);
    // HMAC tokens are accepted only with the client secret.
    expect(verify(baseClaims, { clientSecret: 'top-secret-value' }, { alg: 'HS256' })).toMatchObject({ sub: 'user-42' });
    expect(() => verify(baseClaims, {}, { alg: 'HS256' })).toThrow(/client secret/);
    expect(() => verify(baseClaims, { clientSecret: 'wrong' }, { alg: 'HS256' })).toThrow(/signature/);
  });

  it('validates discovery documents: issuer, https and host', () => {
    const doc = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, userinfo_endpoint: `${ISSUER}/userinfo`, jwks_uri: `${ISSUER}/jwks` };
    expect(checkDiscoveryDocument(doc, ISSUER)).toMatchObject({ tokenEndpoint: `${ISSUER}/token`, foreignEndpoints: [] });
    expect(() => checkDiscoveryDocument({ ...doc, issuer: 'https://other.example.com' }, ISSUER)).toThrow(/does not match/);
    expect(() => checkDiscoveryDocument({ ...doc, token_endpoint: 'http://login.example.com/token' }, ISSUER)).toThrow(/https/);
    expect(() => checkDiscoveryDocument({ ...doc, authorization_endpoint: undefined }, ISSUER)).toThrow(/lacks/);
    let err;
    try { checkDiscoveryDocument({ ...doc, token_endpoint: 'https://oauth2.example.net/token' }, ISSUER); } catch (e) { err = e; }
    expect(err.status).toBe(400);
    expect(err.fields).toHaveProperty('allowForeignEndpoints');
    expect(checkDiscoveryDocument({ ...doc, token_endpoint: 'https://oauth2.example.net/token' }, ISSUER, { allowForeignEndpoints: true }).foreignEndpoints).toEqual(['tokenEndpoint on oauth2.example.net']);
  });

  it('runs discovery and the code exchange against the provider with full validation', async () => {
    const created = await post('/api/security/external-auth', { name: 'oidc', displayName: 'OIDC', issuerUrl: ISSUER, clientId: 'whm', clientSecret: 'top-secret-value' });
    expect(created.status).toBe(201);
    const doc = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: 'https://oauth2.example.net/token', userinfo_endpoint: `${ISSUER}/userinfo`, jwks_uri: `${ISSUER}/jwks` };
    const responses = {};
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init = {}) => {
      seen.push({ url: String(url), init });
      const body = responses[String(url)];
      if (!body) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    };
    try {
      responses[`${ISSUER}/.well-known/openid-configuration`] = doc;
      const refused = await post('/api/security/external-auth/oidc/discover');
      expect(refused.status).toBe(400);
      expect(refused.body.error.fields).toHaveProperty('allowForeignEndpoints');
      expect((await post('/api/security/external-auth/oidc/discover', { allowForeignEndpoints: 'yes' })).status).toBe(422);
      const ok = await post('/api/security/external-auth/oidc/discover', { allowForeignEndpoints: true });
      expect(ok.status).toBe(200);
      expect(ok.body.data.discovery).toMatchObject({ tokenEndpoint: 'https://oauth2.example.net/token', jwksUri: `${ISSUER}/jwks`, foreignEndpoints: ['tokenEndpoint on oauth2.example.net'] });

      responses['https://oauth2.example.net/token'] = { id_token: sign(baseClaims), access_token: 'at', token_type: 'Bearer', expires_in: 3600 };
      responses[`${ISSUER}/jwks`] = { keys: [jwk] };
      responses[`${ISSUER}/userinfo`] = { sub: 'user-42', name: 'Alice', email: 'alice@example.com', email_verified: true };
      const ex = app.ctx.security.externalAuth;
      const result = await ex.exchangeCode('oidc', { code: 'c0de', redirectUri: 'https://panel/cb', nonce: 'n1' });
      expect(result).toMatchObject({ subject: 'user-42', email: 'alice@example.com', claims: { sub: 'user-42', name: 'Alice', iss: ISSUER } });
      const tokenCall = seen.find((c) => c.url === 'https://oauth2.example.net/token');
      expect(tokenCall.init.headers.Authorization).toBe(`Basic ${Buffer.from('whm:top-secret-value').toString('base64')}`);
      expect(String(tokenCall.init.body)).toContain('grant_type=authorization_code');
      await expect(ex.exchangeCode('oidc', { code: 'c0de', redirectUri: 'https://panel/cb', nonce: 'other' })).rejects.toThrow(/nonce/);
      responses['https://oauth2.example.net/token'] = { id_token: sign({ ...baseClaims, aud: 'someone-else' }), access_token: 'at', token_type: 'Bearer' };
      await expect(ex.exchangeCode('oidc', { code: 'c0de', redirectUri: 'https://panel/cb', nonce: 'n1' })).rejects.toThrow(/audience/);
      responses['https://oauth2.example.net/token'] = { access_token: 'at', token_type: 'Bearer' };
      await expect(ex.exchangeCode('oidc', { code: 'c0de', redirectUri: 'https://panel/cb', nonce: 'n1' })).rejects.toThrow(/no id_token/);
      responses['https://oauth2.example.net/token'] = { id_token: sign(baseClaims), access_token: 'at', token_type: 'Bearer' };
      responses[`${ISSUER}/userinfo`] = { sub: 'user-99' };
      await expect(ex.exchangeCode('oidc', { code: 'c0de', redirectUri: 'https://panel/cb', nonce: 'n1' })).rejects.toThrow(/userinfo subject/);
    } finally {
      globalThis.fetch = realFetch;
      await del('/api/security/external-auth/oidc');
    }
  });
});

describe('security advisor', () => {
  it('runs a graded scan with remediation links and stores the last run', async () => {
    await provision(true);
    expect((await get('/api/security/advisor')).body.data).toBeNull();
    const res = await post('/api/security/advisor/scan');
    expect(res.status).toBe(200);
    const { findings, summary } = res.body.data;
    expect(summary.critical).toBeGreaterThanOrEqual(2);
    expect(findings.find((f) => f.id === 'ssh.password')).toMatchObject({ grade: 'warning', fix: { path: '/security-center/ssh-password-authorization-tweak' } });
    expect(findings.find((f) => f.id === '2fa.root')).toMatchObject({ grade: 'critical' });
    expect(findings.find((f) => f.id === 'fs./etc/shadow')).toMatchObject({ grade: 'critical' });
    expect(findings.find((f) => f.id === 'fs.world_writable')).toMatchObject({ grade: 'warning' });
    expect(findings.find((f) => f.id === 'firewall.present').grade).toBe('ok');
    expect(findings.find((f) => f.id === 'modsec.engine')).toMatchObject({ grade: 'warning', title: 'ModSecurity rule engine is DetectionOnly' });
    expect(findings.find((f) => f.id === 'pkg.updates').grade).toBe('info');
    expect(findings.find((f) => f.id === 'smtp.restricted')).toMatchObject({ grade: 'warning' });
    expect(findings.find((f) => f.id === 'policy.unenforced')).toBeUndefined();
    await put('/api/system/settings', { 'security.policy.verified_ip_login': true, 'security.2fa.required_for_root': true });
    try {
      const again = await post('/api/security/advisor/scan');
      expect(again.body.data.findings.find((f) => f.id === 'policy.unenforced')).toMatchObject({ grade: 'warning', title: '2 login policies are stored but not enforced yet', fix: { path: '/security-center/configure-security-policies' } });
    } finally { await put('/api/system/settings', { 'security.policy.verified_ip_login': false, 'security.2fa.required_for_root': false }); }
    expect(findings.map((f) => f.grade)).toEqual([...findings.map((f) => f.grade)].sort((a, b) => ({ critical: 0, warning: 1, info: 2, ok: 3 })[a] - ({ critical: 0, warning: 1, info: 2, ok: 3 })[b]));
    const last = await get('/api/security/advisor');
    expect(last.body.data.summary).toEqual(summary);
    expect(last.body.data.trigger).toBe('manual');
  });

  it('degrades on a bare host and uses ctx.pkg when a package service exists', async () => {
    await provision(false);
    app.ctx.pkg = { outdated: async () => [{ name: 'openssl' }, { name: 'bash' }] };
    try {
      const res = await post('/api/security/advisor/scan');
      const byId = Object.fromEntries(res.body.data.findings.map((f) => [f.id, f]));
      expect(byId['ssh.installed'].grade).toBe('info');
      expect(byId['firewall.present'].grade).toBe('critical');
      expect(byId['pkg.updates']).toMatchObject({ grade: 'warning', title: '2 package updates available' });
    } finally { delete app.ctx.pkg; }
  });
});

describe('helpers', () => {
  it('ipInCidr handles v4 and v6', () => {
    expect(ipInCidr('10.1.2.3', '10.1.0.0/16')).toBe(true);
    expect(ipInCidr('10.2.2.3', '10.1.0.0/16')).toBe(false);
    expect(ipInCidr('10.1.2.3', '10.1.2.3')).toBe(true);
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipInCidr('10.1.2.3', '2001:db8::/32')).toBe(false);
  });
});
