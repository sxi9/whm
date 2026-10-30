import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { renderEximMain, renderEximRcptAcl, renderEximDataAcl, renderEximTls, renderDovecot, dovecotSupportsCipherSuites, tlsPolicyFrom, eximTlsLibrary, phpVersionId, eximSupport, DEFAULTS } from '../src/services/service-configuration.js';

const FULL_BINS = { apache2ctl: true, 'php-fpm': true, php: true, exim4: true, dovecot: true, doveadm: true, 'pure-ftpd': true, named: true, logrotate: true, openssl: true, systemctl: true };
const unit = (name, active = true) => ({ unit: name, present: true, active, state: active ? 'active' : 'inactive', subState: active ? 'running' : 'dead', enabled: true, pid: 100, restarts: 0 });
const APACHE = { flavor: 'debian', root: '/etc/apache2', bin: 'apache2ctl', sitesAvailable: '/etc/apache2/sites-available', globalInclude: '/etc/apache2/conf-available/whm.conf', units: ['apache2'], installed: true, version: 'Apache/2.4.58', mpm: 'event', modules: [{ name: 'status', type: 'shared' }, { name: 'proxy_fcgi', type: 'shared' }], unit: unit('apache2') };
const PHP = { installed: true, versions: [{ version: '8.1', flavor: 'debian', poolDir: '/etc/php/8.1/fpm/pool.d', bin: 'php-fpm8.1', units: ['php8.1-fpm'] }, { version: '8.3', flavor: 'debian', poolDir: '/etc/php/8.3/fpm/pool.d', bin: 'php-fpm8.3', units: ['php8.3-fpm'] }] };
// A Debian split-config host where a stale Email fallback macro still owns CHECK_RCPT_LOCAL_ACL_FILE.
const EMAIL_ACL = '/etc/exim4/whm/acl-email-filters.conf';
const CHAIN = '/etc/exim4/whm/acl-rcpt-local.conf';
const EXIM_LAYOUT = { installed: true, bin: 'exim4', flavor: 'debian', confDir: '/etc/exim4', whmDir: '/etc/exim4/whm', splitConfig: true, mainConf: null, macroFile: '/etc/exim4/exim4.conf.localmacros', rcptAclSource: '/etc/exim4/conf.d/acl/30_exim4-config_check_rcpt', emailAclFile: EMAIL_ACL, sentinel: 'WHM_SERVICE_CONFIG', units: ['exim4'], version: '4.97', features: ['crypteq', 'GnuTLS', 'DKIM', 'SPF'], support: { spf: true, dkim: true, dmarc: false, tls: 'gnutls' }, unit: unit('exim4'), slots: { main: { path: '/etc/exim4/conf.d/main/001_whm_service_config', hookable: true, block: null, exists: false, hooked: true, claimedBy: null, content: null }, acl_rcpt: { path: CHAIN, hookable: true, macro: 'CHECK_RCPT_LOCAL_ACL_FILE', includes: EMAIL_ACL, exists: false, hooked: false, claimedBy: '/etc/exim4/whm/acl_rcpt.conf', includesEmailFilters: false, content: null }, acl_data: { path: '/etc/exim4/whm/acl_data_whm.conf', hookable: true, macro: 'CHECK_DATA_LOCAL_ACL_FILE', exists: false, hooked: false, claimedBy: null, content: null } }, hints: [`CHECK_RCPT_LOCAL_ACL_FILE already points at /etc/exim4/whm/acl_rcpt.conf, so the RCPT ACL chain in ${CHAIN} (the panel's protections plus the Email filters) is not loaded. Save "Filter Incoming Emails by Country" (Email) once so it hands the hook over to this chain, or remove that definition from /etc/exim4/exim4.conf.localmacros; alternatively add ".include ${CHAIN}" inside acl_check_rcpt (before the final accept) in /etc/exim4/conf.d/acl/30_exim4-config_check_rcpt.`] };
// The Debian default: unsplit, main options as a managed block in localmacros.
const EXIM_UNSPLIT = { ...EXIM_LAYOUT, splitConfig: false, mainConf: '/etc/exim4/exim4.conf.template', rcptAclSource: '/etc/exim4/exim4.conf.template', slots: { ...EXIM_LAYOUT.slots, main: { ...EXIM_LAYOUT.slots.main, path: '/etc/exim4/exim4.conf.localmacros', block: '# BEGIN WHM panel (Service Configuration: Exim main options) - managed block, edits inside are overwritten' } } };
const ftpCandidates = (active = 'pure-ftpd') => [
  { name: 'pure-ftpd', label: 'Pure-FTPd', binaries: ['pure-ftpd'], units: ['pure-ftpd'], packages: { apt: 'pure-ftpd', dnf: 'pure-ftpd' }, installed: true, unitName: 'pure-ftpd', unit: unit('pure-ftpd', active === 'pure-ftpd') },
  { name: 'proftpd', label: 'ProFTPD', binaries: ['proftpd'], units: ['proftpd'], packages: { apt: 'proftpd-core', dnf: 'proftpd' }, installed: false, unitName: null, unit: { unit: null, present: false, active: false } },
  { name: 'vsftpd', label: 'vsftpd', binaries: ['vsftpd'], units: ['vsftpd'], packages: { apt: 'vsftpd', dnf: 'vsftpd' }, installed: true, unitName: 'vsftpd', unit: unit('vsftpd', active === 'vsftpd') },
];
const dnsCandidates = () => [
  { name: 'bind', label: 'BIND (named)', binaries: ['named'], units: ['named', 'bind9'], packages: { apt: 'bind9', dnf: 'bind' }, installed: true, unitName: 'named', unit: unit('named') },
  { name: 'powerdns', label: 'PowerDNS Authoritative Server', binaries: ['pdns_server'], units: ['pdns'], packages: { apt: 'pdns-server', dnf: 'pdns' }, installed: false, unitName: null, unit: { unit: null, present: false, active: false } },
];
const VHOST_WRITE = ({ domain, ssl, sslPort, phpVersion, redirects, logDir, bind }) => ({ domain, path: `/etc/apache2/sites-available/${domain}.conf`, link: `/etc/apache2/sites-enabled/${domain}.conf`, logDir, validated: true, bytes: 500, ssl: Boolean(ssl && sslPort), bind: bind ?? null, phpVersion: phpVersion ?? null, redirects: redirects?.length ?? 0, reloaded: true, unit: 'apache2' });
// The agent's catch-all answer: the hostname bundle when one was passed, else the panel listener's pair.
const DEFAULT_VHOST_WRITE = (args) => ({ name: '000-whm-default', path: '/etc/apache2/sites-available/000-whm-default.conf', link: '/etc/apache2/sites-enabled/000-whm-default.conf', logDir: args.logDir, validated: true, bytes: 900, ssl: args.sslPort == null ? null : args.ssl ? { cert: args.ssl.fullchain || args.ssl.cert, key: args.ssl.key, source: 'hostname', generated: false } : { cert: '/etc/whm/tls/cert.pem', key: '/etc/whm/tls/key.pem', source: 'panel', generated: false }, addresses: args.bind ? [args.bind] : args.addresses, stockSite: { disabled: true, site: '000-default', via: 'a2dissite' }, reloaded: true, unit: 'apache2' });
const CERT = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49\n-----END PRIVATE KEY-----\n';

let app;
let csrf;
let reseller;
let resellerCsrf;
const mutate = (client, method, url, body, token) => client[method](url).set('X-CSRF-Token', token).send(body);
const put = (url, body) => mutate(app.http, 'put', url, body, csrf);
const post = (url, body = {}) => mutate(app.http, 'post', url, body, csrf);
const get = (url) => app.http.get(url);

async function provision(installed, extra = {}) {
  app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, installed ? Boolean({ ...FULL_BINS, ...extra }[n]) : false])));
  await app.ctx.capabilities.refresh();
}

function detectWith(installed) {
  return () => (installed
    ? { apache: APACHE, nginx: { installed: false }, php: PHP, ftp: { daemons: [{ name: 'pure-ftpd', unit: unit('pure-ftpd') }] }, dovecot: { installed: true, unit: unit('dovecot') }, exim: EXIM_LAYOUT, systemd: true, logrotate: true }
    : { apache: { installed: false }, nginx: { installed: false }, php: { installed: false, versions: [] }, ftp: { daemons: [] }, dovecot: { installed: false }, exim: { installed: false }, systemd: true, logrotate: false });
}

beforeAll(async () => {
  const agent = createMockAgent({
    'web.detect': detectWith(true),
    'web.status': () => ({ installed: true, flavor: 'debian', bin: 'apache2ctl', version: 'Apache/2.4.58', mpm: 'event', modules: APACHE.modules, unit: unit('apache2'), serverStatus: { busyWorkers: 2, idleWorkers: 48, requestsPerSecond: 1.5, totalKBytes: 1024, uptimeSeconds: 600 }, statusModule: true, managedVhosts: 1, globalInclude: { path: APACHE.globalInclude, exists: true, enabled: true } }),
    'web.global.read': () => ({ installed: true, path: APACHE.globalInclude, exists: true, enabled: true, content: 'Timeout 300\n' }),
    'web.global.write': ({ directives, dryRun }) => (dryRun ? { dryRun: true, ok: !/Broken/.test(directives.customDirectives || ''), output: /Broken/.test(directives.customDirectives || '') ? 'AH00526: Syntax error on line 3: Invalid command Broken' : 'Syntax OK', path: APACHE.globalInclude } : { dryRun: false, path: APACHE.globalInclude, validated: true, linked: true, bytes: 100, reloaded: true, unit: 'apache2' }),
    'web.mpm.set': ({ module }) => ({ module, changed: true, previous: 'event', reloaded: true, unit: 'apache2', verb: 'restart' }),
    'web.configtest': () => ({ bin: 'apache2ctl', ok: true, output: 'Syntax OK' }),
    'web.reload': () => ({ validated: true, reloaded: true, unit: 'apache2' }),
    'web.restart': () => ({ validated: true, reloaded: true, unit: 'apache2', verb: 'restart' }),
    'web.vhost.write': VHOST_WRITE,
    'web.vhost.remove': ({ domain }) => ({ domain, removed: true, validated: true, reloaded: true }),
    'web.default_vhost.write': DEFAULT_VHOST_WRITE,
    'web.default_vhost.remove': () => ({ path: '/etc/apache2/sites-available/000-whm-default.conf', removed: true, validated: true, reloaded: true, unit: 'apache2' }),
    'web.vhost.list': () => ({ installed: true, dir: APACHE.sitesAvailable, vhosts: [{ domain: 'legacy.example.net', path: '/etc/apache2/sites-available/legacy.example.net.conf', enabled: true, meta: { domain: 'legacy.example.net', user: 'legacy', docroot: '/home/legacy/public_html', aliases: [], ssl: false } }] }),
    'web.vhost.read': ({ domain }) => ({ domain, path: `/etc/apache2/sites-available/${domain}.conf`, exists: true, managed: true, enabled: true, meta: { domain }, content: `<VirtualHost *:80>\n  ServerName ${domain}\n</VirtualHost>\n` }),
    'web.ports.set': ({ http, https, bind }) => ({ path: '/etc/apache2/ports.conf', http, https, bind: bind ?? null, validated: true, reloaded: true, unit: 'apache2' }),
    'web.phpfpm.detect': () => PHP,
    'web.phpfpm.pool.write': ({ user, version }) => ({ user, version, path: `/etc/php/${version}/fpm/pool.d/whm-${user}.conf`, socket: `/run/php/php${version}-fpm-${user}.sock`, validated: true, bytes: 300, reloaded: true, unit: `php${version}-fpm` }),
    'web.phpfpm.pool.remove': ({ user, version }) => ({ user, version, removed: true, reloaded: true }),
    'web.logrotate.list': () => ({ dir: '/etc/logrotate.d', logrotate: true, policies: [{ name: 'panel', path: '/etc/logrotate.d/whm-panel', size: 120 }], dirExists: true }),
    'web.logrotate.read': ({ name }) => ({ name, path: `/etc/logrotate.d/whm-${name}`, exists: name === 'panel', content: name === 'panel' ? '/var/log/whm/*.log {\n  daily\n}\n' : null, logrotate: true }),
    'web.logrotate.write': ({ name, paths }) => ({ name, path: `/etc/logrotate.d/whm-${name}`, validated: true, output: `reading config file whm-${name}`, content: `${paths.join(' ')} {}`, bytes: 50 }),
    'web.logrotate.remove': ({ name }) => ({ name, path: `/etc/logrotate.d/whm-${name}`, removed: true }),
    'web.logrotate.run': ({ name, force }) => ({ name, force, ok: true, output: `rotating pattern: /var/log/whm/*.log ${force ? 'forced' : 'after 1 days'}` }),
    'web.dovecot.detect': () => ({ installed: true, bin: 'dovecot', confDir: '/etc/dovecot', include: { path: '/etc/dovecot/conf.d/97-whm-mailserver.conf', exists: false, content: null }, version: '2.3.21', configOk: true, effective: { protocols: 'imap pop3 lmtp', ssl: 'yes', mail_location: 'maildir:~/Maildir' }, unit: unit('dovecot') }),
    'web.dovecot.include.write': ({ content }) => ({ path: '/etc/dovecot/conf.d/97-whm-mailserver.conf', validated: true, bytes: content.length, reloaded: true, unit: 'dovecot' }),
    'web.exim.detect': () => EXIM_LAYOUT,
    'web.exim.include.write': ({ slot, content }) => ({ slot, path: EXIM_LAYOUT.slots[slot].path, block: EXIM_LAYOUT.slots[slot].block ?? null, validated: true, hooked: slot !== 'acl_rcpt', claimedBy: EXIM_LAYOUT.slots[slot].claimedBy, bytes: content.length, version: '4.97', reloaded: slot === 'main', unit: 'exim4' }),
    'web.service.detect': ({ role }) => (role === 'ftp' ? { role, candidates: ftpCandidates(), active: ['pure-ftpd'], enabled: ['pure-ftpd'], current: 'pure-ftpd', packageManager: 'apt-get' } : { role, candidates: dnsCandidates(), active: ['bind'], enabled: ['bind'], current: 'bind', packageManager: 'apt-get' }),
    'web.service.select': ({ role, server }) => ({ role, server, steps: [{ unit: role === 'ftp' ? 'pure-ftpd' : 'named', action: 'disable --now', ok: true, error: null }, ...(server !== 'disabled' ? [{ unit: server === 'vsftpd' ? 'vsftpd' : server === 'bind' ? 'named' : server, action: 'enable --now', ok: true, error: null }] : [])], candidates: role === 'ftp' ? ftpCandidates(server) : dnsCandidates() }),
    'web.ftp.config.read': ({ server }) => ({ server, path: '/etc/pure-ftpd/conf/', unit: unit('pure-ftpd'), settings: { passivePortMin: 30000, passivePortMax: 35000, tls: 'optional' }, raw: { PassivePortRange: '30000 35000', TLS: '1' } }),
    'web.ftp.config.write': ({ server, settings }) => ({ server, written: server === 'pure-ftpd' ? ['/etc/pure-ftpd/conf/PassivePortRange', '/etc/pure-ftpd/conf/TLS'] : ['/etc/vsftpd.conf'], validated: null, settings, reloaded: true, unit: server, verb: 'restart' }),
    'ssl.service_cert.status': () => ({ exim: { service: 'exim', daemonPresent: true, hasCertificate: true, paths: { dir: '/etc/ssl/whm/service/exim' }, certificate: { subjectText: 'CN=mail.example.com', issuerText: 'CN=mail.example.com', notAfter: '2027-01-01T00:00:00.000Z', daysRemaining: 400, selfSigned: true, expired: false } } }),
    'ssl.service_cert.install': ({ service }) => ({ service, paths: { dir: `/etc/ssl/whm/service/${service}` }, applied: ['/etc/dovecot/conf.d/90-whm-ssl-cert.conf'], reload: { reloaded: true, unit: 'dovecot' }, certificate: { subjectText: 'CN=mail.example.com', issuerText: 'CN=R3', notAfter: '2027-01-01T00:00:00.000Z', selfSigned: false } }),
    'ssl.key.matches': () => ({ matches: true }),
    'ssl.selfsigned.generate': ({ subject, days }) => ({ certPem: CERT, keyPem: KEY, certificate: { subjectText: `CN=${subject.CN}`, issuerText: `CN=${subject.CN}`, selfSigned: true, days } }),
    'ssl.cert.inspect': () => ({ subjectText: 'CN=mail.example.com', issuerText: 'CN=R3', notAfter: '2027-01-01T00:00:00.000Z', notBefore: '2026-01-01T00:00:00.000Z', sans: [], commonName: 'mail.example.com' }),
  });
  app = await createTestApp({ agent });
  csrf = await app.login();
  const r = await app.createUser('resell1', 'reseller');
  reseller = request.agent(app.ctx.app);
  resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
  app.ctx.db.prepare("INSERT INTO accounts (username, domain, owner_id, home_dir, uid, gid, ip, plan_snapshot_json) VALUES ('alice', 'example.com', 1, '/home/alice', 30001, 30001, '203.0.113.5', '{\"php_version\":\"ea-php83\"}')").run();
  const aliceId = app.ctx.db.prepare("SELECT id FROM accounts WHERE username = 'alice'").get().id;
  app.ctx.db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'example.com', 'main', '/home/alice/public_html')").run(aliceId);
  app.ctx.db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'parked.example.net', 'parked', NULL)").run(aliceId);
  app.ctx.db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'shop.example.com', 'sub', '/home/alice/public_html/shop')").run(aliceId);
  app.ctx.db.prepare("INSERT INTO accounts (username, domain, owner_id, home_dir) VALUES ('bob', 'bob.example.org', 1, '/home/bob')").run();
  app.ctx.settings.set('basic.hostname', 'panel.example.com');
  await provision(true);
}, 30_000);

afterAll(async () => { await app?.close(); });

describe('module registration', () => {
  it('attaches ctx.web with the cross-category helpers, the ftp alias, capabilities and the sync job', () => {
    for (const fn of ['applySsl', 'removeSsl', 'setRedirects', 'ensureVhost', 'syncAccount', 'removeAccount', 'addAlias', 'removeAlias', 'setAccountIpv6', 'replaceIp', 'setPhpVersion', 'writePhpPool', 'setListenPorts', 'reload', 'restart', 'configtest', 'detect', 'status']) expect(typeof app.ctx.web[fn], fn).toBe('function');
    expect(typeof app.ctx.ftp.setPassiveAddress).toBe('function');
    expect(app.ctx.jobs.types()).toContain('web.vhosts.sync');
    expect(app.ctx.capabilities.has('logrotate')).toBe(true);
    expect(app.ctx.capabilities.snapshot().capabilities.powerdns).toBeDefined();
  });

  it('every route is root-only (403 for resellers)', async () => {
    for (const url of ['/api/service-config/status', '/api/service-config/apache', '/api/service-config/apache/vhosts', '/api/service-config/logrotate', '/api/service-config/webdisk', '/api/service-config/webservices', '/api/service-config/exim', '/api/service-config/mailserver', '/api/service-config/ftp', '/api/service-config/nameserver', '/api/service-config/service-certs']) {
      const res = await reseller.get(url);
      expect(res.status, url).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
    expect((await mutate(reseller, 'put', '/api/service-config/apache', { timeout: 10 }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/service-config/exim', { rblEnabled: false }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/service-config/ftp/server', { server: 'vsftpd' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/service-config/service-certs/exim/self-signed', {}, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/service-config/apache/restart', {}, resellerCsrf)).status).toBe(403);
  });

  it('GET /status summarises every daemon', async () => {
    const res = await get('/api/service-config/status').expect(200);
    expect(res.body.data).toMatchObject({ apache: { installed: true, flavor: 'debian', mpm: 'event' }, exim: { installed: true }, dovecot: { installed: true }, ftp: { installed: true, selected: 'pure-ftpd' }, dns: { bind: true, selected: 'bind' }, logrotate: { installed: true }, openssl: true });
  });
});

describe('Apache Configuration', () => {
  it('reads settings, status, include and vhost summary', async () => {
    const res = await get('/api/service-config/apache').expect(200);
    expect(res.body.data.installed).toBe(true);
    expect(res.body.data.settings).toMatchObject({ timeout: 300, mpm: { module: 'event' } });
    expect(res.body.data.status.serverStatus.busyWorkers).toBe(2);
    expect(res.body.data.include.path).toBe(APACHE.globalInclude);
    expect(res.body.data.php.versions.map((v) => v.version)).toEqual(['8.1', '8.3']);
  });

  it('validates the body (422) and rejects unknown keys', async () => {
    expect((await put('/api/service-config/apache', { timeout: 0 })).status).toBe(422);
    expect((await put('/api/service-config/apache', { serverTokens: 'Prod; rm -rf /' })).status).toBe(422);
    expect((await put('/api/service-config/apache', { directoryIndex: ['../x'] })).status).toBe(422);
    expect((await put('/api/service-config/apache', { mpm: { module: 'itk' } })).status).toBe(422);
    expect((await put('/api/service-config/apache', { bogus: 1 })).status).toBe(422);
    const spare = await put('/api/service-config/apache', { mpm: { minSpareThreads: 100, maxSpareThreads: 10 } });
    expect(spare.status).toBe(422);
    expect(spare.body.error.fields.mpm).toBeDefined();
  });

  it('saves, dry-runs the include, switches the MPM, writes the include and audits', async () => {
    app.agent.reset('web.global.write'); app.agent.set('web.global.write', ({ directives, dryRun }) => (dryRun ? { dryRun: true, ok: !/Broken/.test(directives.customDirectives || ''), output: /Broken/.test(directives.customDirectives || '') ? 'AH00526: Syntax error on line 3: Invalid command Broken' : 'Syntax OK', path: APACHE.globalInclude } : { dryRun: false, path: APACHE.globalInclude, validated: true, linked: true, bytes: 100, reloaded: true, unit: 'apache2' }));
    const before = app.agent.calls.length;
    const res = await put('/api/service-config/apache', { timeout: 120, serverTokens: 'Prod', customDirectives: 'ServerName panel.example.com', mpm: { module: 'prefork', minSpareServers: 2, maxSpareServers: 8 } }).expect(200);
    expect(res.body.data.settings).toMatchObject({ timeout: 120, mpm: { module: 'prefork', minSpareServers: 2 } });
    expect(res.body.data.applied.include.path).toBe(APACHE.globalInclude);
    expect(res.body.data.applied.mpm).toMatchObject({ module: 'prefork', changed: true });
    expect(res.body.data.lastApply.ok).toBe(true);
    // Order: dry run of the new include, then the MPM restart, then the real write.
    const order = app.agent.calls.slice(before).filter((c) => ['web.global.write', 'web.mpm.set'].includes(c.name)).map((c) => (c.name === 'web.global.write' ? (c.args.dryRun ? 'dry' : 'write') : 'mpm'));
    expect(order).toEqual(['dry', 'mpm', 'write']);
    const write = app.agent.callsTo('web.global.write').pop();
    expect(write.args.directives).toMatchObject({ timeout: 120, customDirectives: 'ServerName panel.example.com', mpm: { module: 'prefork' } });
    expect(write.args.directives.serverAdmin).toBeUndefined();
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'apache.config.update'").get().n).toBeGreaterThan(0);
    // A rejected directive stops before the MPM is touched and leaves the host as it was.
    const mpmCalls = app.agent.callsTo('web.mpm.set').length;
    const bad = await put('/api/service-config/apache', { customDirectives: 'Broken directive', mpm: { module: 'event' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/Syntax error/);
    expect(app.agent.callsTo('web.mpm.set').length).toBe(mpmCalls);
    expect((await get('/api/service-config/apache')).body.data.lastApply.ok).toBe(false);
    await put('/api/service-config/apache', { customDirectives: 'ServerName panel.example.com', mpm: { module: 'event' } }).expect(200);
  });

  it('asks mod_status on the address Apache really listens on', async () => {
    await app.ctx.web.setListenPorts({ http: 8080, https: null, bind: '127.0.0.1' }, null);
    try {
      await get('/api/service-config/apache').expect(200);
      expect(app.agent.callsTo('web.status').pop().args).toEqual({ port: 8080, bind: '127.0.0.1' });
    } finally { await app.ctx.web.setListenPorts({ http: 80, https: 443 }, null); }
    await get('/api/service-config/apache').expect(200);
    expect(app.agent.callsTo('web.status').pop().args).toEqual({ port: 80, bind: null });
  });

  it('configtest dry-runs the include and reports rejections without saving', async () => {
    const ok = await post('/api/service-config/apache/configtest', { customDirectives: 'ServerName x.example.com' }).expect(200);
    expect(ok.body.data).toMatchObject({ dryRun: true, ok: true });
    const bad = await post('/api/service-config/apache/configtest', { customDirectives: 'Broken directive' }).expect(200);
    expect(bad.body.data.ok).toBe(false);
    expect(bad.body.data.output).toMatch(/Syntax error/);
    expect((await get('/api/service-config/apache')).body.data.settings.customDirectives).toBe('ServerName panel.example.com');
  });

  it('reload/restart and the vhost listing/read/sync endpoints', async () => {
    expect((await post('/api/service-config/apache/reload')).body.data.reloaded).toBe(true);
    expect((await post('/api/service-config/apache/restart')).body.data.verb).toBe('restart');
    const sync = await post('/api/service-config/apache/vhosts/sync', { username: 'alice' }).expect(200);
    expect(sync.body.data).toMatchObject({ username: 'alice', applied: true, phpVersion: '8.3' });
    expect(sync.body.data.vhosts.map((v) => v.domain).sort()).toEqual(['example.com', 'shop.example.com']);
    const main = app.agent.callsTo('web.vhost.write').find((c) => c.args.domain === 'example.com');
    // Apache logs go to a root-owned tree, never into the account's home; only the PHP-FPM error log (written as the account) stays there.
    expect(main.args).toMatchObject({ user: 'alice', docroot: '/home/alice/public_html', aliases: ['parked.example.net'], ip: '203.0.113.5', phpVersion: '8.3', logDir: '/var/log/whm/domlogs/alice', port: 80, sslPort: 443, meta: { type: 'main', account: 'alice' } });
    expect(main.args.bind).toBeUndefined();
    expect(app.agent.callsTo('web.phpfpm.pool.write').pop().args).toMatchObject({ user: 'alice', version: '8.3', errorLog: '/home/alice/logs/php-error.log' });
    const list = await get('/api/service-config/apache/vhosts').expect(200);
    expect(list.body.data.find((v) => v.domain === 'example.com')).toMatchObject({ status: 'applied', username: 'alice', type: 'main' });
    expect(list.body.data.find((v) => v.domain === 'legacy.example.net')).toMatchObject({ status: 'unmanaged' });
    const read = await get('/api/service-config/apache/vhosts/example.com');
    expect(read.body, JSON.stringify(read.body)).toMatchObject({ data: { domain: 'example.com' } });
    expect(read.body.data.content).toContain('ServerName example.com');
    expect((await get('/api/service-config/apache/vhosts/bad;domain')).status).toBe(422);
    const all = await post('/api/service-config/apache/vhosts/sync', {}).expect(202);
    app.ctx.jobs.start();
    const job = await waitForJob(app.ctx, all.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ accounts: 2, applied: 2 });
  });
});

describe('cross-category helpers on ctx.web', () => {
  it('applySsl / removeSsl re-render the vhost with certificate paths and keep the spec', async () => {
    const paths = { cert: '/etc/ssl/whm/example.com/cert.pem', key: '/etc/ssl/whm/example.com/key.pem', chain: '/etc/ssl/whm/example.com/chain.pem', fullchain: '/etc/ssl/whm/example.com/fullchain.pem' };
    const r = await app.ctx.web.applySsl('example.com', paths, null);
    expect(r).toMatchObject({ domain: 'example.com', applied: true, ssl: true });
    expect(app.agent.callsTo('web.vhost.write').pop().args.ssl).toEqual(paths);
    expect(app.ctx.web.vhostFor('example.com').ssl).toEqual(paths);
    await app.ctx.web.removeSsl('example.com', null);
    expect(app.ctx.web.vhostFor('example.com').ssl).toBeNull();
    await expect(app.ctx.web.applySsl('nobody.example', paths, null)).rejects.toMatchObject({ status: 404 });
  });

  it('redirectHttps goes only to vhosts with a certificate while web.force_https (default on) is set; setForceHttps re-renders them', async () => {
    const paths = { cert: '/etc/ssl/whm/example.com/cert.pem', key: '/etc/ssl/whm/example.com/key.pem' };
    expect(app.ctx.web.forceHttps()).toBe(true);
    await app.ctx.web.applySsl('example.com', paths, null);
    expect(app.agent.callsTo('web.vhost.write').pop().args.redirectHttps).toBe(true);
    await app.ctx.web.syncAccount('alice', null);
    const synced = app.agent.callsTo('web.vhost.write').slice(-2);
    expect(Object.fromEntries(synced.map((c) => [c.args.domain, c.args.redirectHttps]))).toEqual({ 'example.com': true, 'shop.example.com': false });
    app.ctx.settings.set('web.force_https', false);
    await app.ctx.web.syncAccount('alice', null);
    expect(app.agent.callsTo('web.vhost.write').slice(-2).every((c) => c.args.redirectHttps === false)).toBe(true);
    const on = await app.ctx.web.apache.setForceHttps(true, null);
    expect(on).toMatchObject({ forceHttps: true, vhosts: 1, written: 1, failed: [], applied: true });
    expect(app.agent.callsTo('web.vhost.write').pop().args).toMatchObject({ domain: 'example.com', redirectHttps: true, reload: false });
    expect(app.agent.callsTo('web.reload').length).toBeGreaterThan(0);
    const page = (await get('/api/service-config/apache')).body.data;
    expect(page).toMatchObject({ forceHttps: true, rewriteModule: false, landingDocroot: '/var/www/whm-default' });
    expect((await get('/api/service-config/status')).body.data.forceHttps).toBe(true);
    await app.ctx.web.removeSsl('example.com', null);
    expect(app.agent.callsTo('web.vhost.write').pop().args.redirectHttps).toBe(false);
  });

  it('ensureHostnameVhost renders the server vhost with the branded landing page and keeps it out of the account counts', async () => {
    const previousHostname = app.ctx.settings.get('basic.hostname');
    app.ctx.settings.setMany({ 'basic.hostname': 'panel.example.com', 'basic.main_ip': '203.0.113.5' });
    try {
    const r = await app.ctx.web.ensureHostnameVhost(null);
    expect(r).toMatchObject({ hostname: 'panel.example.com', applied: true, docroot: '/var/www/whm-default', landingPage: true });
    const write = app.agent.callsTo('web.vhost.write').pop().args;
    expect(write).toMatchObject({ domain: 'panel.example.com', user: 'www-data', docroot: '/var/www/whm-default', ip: '203.0.113.5', logDir: '/var/log/whm/domlogs/www-data', redirectHttps: false, aliases: [], meta: { type: 'server', account: 'www-data' } });
    expect(write.phpVersion).toBeUndefined();
    expect(write.ssl).toBeUndefined();
    const page = app.agent.callsTo('fs.write_file').find((c) => c.args.path === '/var/www/whm-default/index.html');
    expect(page.args).toMatchObject({ owner: 'root', mode: '0644', backup: false });
    expect(page.args.content).toContain('Ready to launch');
    expect(page.args.content).toContain('panel.example.com');
    expect(page.args.content).toContain('Hostingsignal Panel');
    expect(app.ctx.web.vhostFor('panel.example.com')).toMatchObject({ type: 'server', username: 'www-data', accountId: null, status: 'applied', phpVersion: null });
    const apache = (await get('/api/service-config/apache')).body.data;
    expect(apache.hostnameVhost).toMatchObject({ domain: 'panel.example.com', type: 'server', status: 'applied' });
    const accounts = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM web_vhosts WHERE type != 'server'").get().n;
    expect(apache.vhosts.total).toBe(accounts);
    expect((await get('/api/service-config/status')).body.data.vhosts).toBe(accounts);
    expect((await get('/api/service-config/apache/vhosts')).body.data.find((v) => v.domain === 'panel.example.com')).toMatchObject({ type: 'server', status: 'applied' });
    // A hostname change replaces the previous server vhost; hosted and unqualified names are refused.
    const moved = await app.ctx.web.ensureHostnameVhost(null, { hostname: 'Host2.example.com' });
    expect(moved).toMatchObject({ hostname: 'host2.example.com', applied: true });
    expect(app.agent.callsTo('web.vhost.remove').pop().args).toMatchObject({ domain: 'panel.example.com', reload: false });
    expect(app.ctx.web.vhostFor('panel.example.com')).toBeNull();
    expect(app.ctx.db.prepare("SELECT domain FROM web_vhosts WHERE type = 'server'").all()).toEqual([{ domain: 'host2.example.com' }]);
    expect(await app.ctx.web.ensureHostnameVhost(null, { hostname: 'example.com' })).toMatchObject({ applied: false, reason: 'hosted_domain' });
    expect(await app.ctx.web.ensureHostnameVhost(null, { hostname: 'localhost' })).toMatchObject({ applied: false, reason: 'invalid_hostname' });
    expect(app.ctx.db.prepare("SELECT domain FROM web_vhosts WHERE type = 'server'").all()).toEqual([{ domain: 'host2.example.com' }]);
    // An installed bundle for the hostname is used (and triggers the redirect); a bundle whose files are gone falls back to plain HTTP.
    const originalSsl = app.ctx.ssl;
    app.ctx.ssl = { ...originalSsl, certForDomain: (d) => (d === 'host2.example.com' ? { installed: 1 } : null) };
    try {
      const withCert = await app.ctx.web.ensureHostnameVhost(null, { hostname: 'host2.example.com' });
      expect(withCert).toMatchObject({ applied: true, ssl: true });
      expect(app.agent.callsTo('web.vhost.write').pop().args).toMatchObject({ ssl: { cert: '/etc/ssl/whm/host2.example.com/cert.pem', key: '/etc/ssl/whm/host2.example.com/key.pem', fullchain: '/etc/ssl/whm/host2.example.com/fullchain.pem' }, redirectHttps: true });
      expect(app.ctx.web.vhostFor('host2.example.com').ssl).toMatchObject({ cert: '/etc/ssl/whm/host2.example.com/cert.pem' });
      app.agent.set('web.vhost.write', (args) => { if (args.ssl) throw Object.assign(new Error('Certificate file does not exist'), { agentError: true, code: 'not_found', details: {} }); return VHOST_WRITE(args); });
      const fallback = await app.ctx.web.ensureHostnameVhost(null, { hostname: 'host2.example.com' });
      expect(fallback).toMatchObject({ applied: true, ssl: false });
      expect(app.agent.callsTo('web.vhost.write').pop().args.ssl).toBeUndefined();
      expect(app.ctx.web.vhostFor('host2.example.com')).toMatchObject({ ssl: null, status: 'applied' });
    } finally { app.ctx.ssl = originalSsl; app.agent.set('web.vhost.write', VHOST_WRITE); }
    // Boot: the panel.started event re-renders the hostname vhost.
    app.ctx.settings.set('basic.hostname', 'host2.example.com');
    app.agent.calls.length = 0;
    await app.ctx.events.emit('panel.started', {});
    expect(app.agent.callsTo('web.vhost.write').map((c) => c.args.domain)).toEqual(['host2.example.com']);
    // The sync-all job covers it too and reports it apart from the accounts.
    const all = await post('/api/service-config/apache/vhosts/sync', {}).expect(202);
    const job = await waitForJob(app.ctx, all.body.data.job.id);
    expect(job.result).toMatchObject({ accounts: 2, hostname: { hostname: 'host2.example.com', applied: true } });
    } finally {
      app.ctx.db.prepare("DELETE FROM web_vhosts WHERE type = 'server'").run();
      app.ctx.settings.setMany({ 'basic.hostname': previousHostname, 'basic.main_ip': '' });
      app.agent.set('web.vhost.write', VHOST_WRITE);
    }
  });

  it('the catch-all default vhost is written after the hostname vhost: every tenant address, both ports, the hostname certificate when installed, the stock site disabled', async () => {
    const previousHostname = app.ctx.settings.get('basic.hostname');
    const previousPorts = app.ctx.settings.get('service_config.apache_ports', null);
    app.ctx.settings.setMany({ 'basic.hostname': 'panel.example.com', 'basic.main_ip': '203.0.113.5', 'basic.main_ipv6': '2001:db8::5' });
    const originalSsl = app.ctx.ssl;
    try {
      app.agent.calls.length = 0;
      const r = await app.ctx.web.ensureHostnameVhost(null);
      expect(r).toMatchObject({ hostname: 'panel.example.com', applied: true });
      expect(r.defaultVhost).toMatchObject({ hostname: 'panel.example.com', applied: true, docroot: '/var/www/whm-default', path: '/etc/apache2/sites-available/000-whm-default.conf', ssl: { source: 'panel' }, stockSite: { disabled: true, site: '000-default', via: 'a2dissite' }, reload: { reloaded: true, unit: 'apache2' } });
      const names = app.agent.calls.map((c) => c.name);
      expect(names.indexOf('web.default_vhost.write')).toBeGreaterThan(names.indexOf('web.vhost.write'));
      const write = app.agent.callsTo('web.default_vhost.write').pop().args;
      expect(write).toMatchObject({ hostname: 'panel.example.com', docroot: '/var/www/whm-default', user: 'www-data', port: 80, sslPort: 443, logDir: '/var/log/whm/domlogs/www-data', reload: true });
      expect(write.addresses).toEqual(expect.arrayContaining(['203.0.113.5', '2001:db8::5']));
      expect(write.addresses.every((a) => /^[0-9a-f.:]+$/i.test(a))).toBe(true);
      expect(write.ssl).toBeUndefined();
      expect(write.bind).toBeUndefined();
      const page = (await get('/api/service-config/apache')).body.data;
      expect(page.defaultVhost).toMatchObject({ ok: true, summary: { hostname: 'panel.example.com', path: '/etc/apache2/sites-available/000-whm-default.conf', ssl: { source: 'panel' }, stockSite: { disabled: true } } });
      expect((await get('/api/service-config/status')).body.data.applies.default_vhost).toMatchObject({ ok: true });
      // The hostname's installed bundle is handed over for port 443.
      app.ctx.ssl = { ...originalSsl, certForDomain: (d) => (d === 'panel.example.com' ? { installed: 1 } : null) };
      const withCert = await app.ctx.web.ensureHostnameVhost(null);
      expect(withCert.defaultVhost.ssl).toMatchObject({ cert: '/etc/ssl/whm/panel.example.com/fullchain.pem', key: '/etc/ssl/whm/panel.example.com/key.pem', source: 'hostname' });
      expect(app.agent.callsTo('web.default_vhost.write').pop().args.ssl).toEqual({ cert: '/etc/ssl/whm/panel.example.com/cert.pem', key: '/etc/ssl/whm/panel.example.com/key.pem', chain: '/etc/ssl/whm/panel.example.com/chain.pem', fullchain: '/etc/ssl/whm/panel.example.com/fullchain.pem' });
      // Installing / removing the hostname certificate through the SSL hook refreshes the catch-all too.
      app.agent.calls.length = 0;
      const applied = await app.ctx.web.applySsl('panel.example.com', { cert: '/etc/ssl/whm/panel.example.com/cert.pem', key: '/etc/ssl/whm/panel.example.com/key.pem' }, null);
      expect(applied.defaultVhost).toMatchObject({ applied: true, ssl: { source: 'hostname' } });
      expect(app.agent.callsTo('web.default_vhost.write')).toHaveLength(1);
      app.ctx.ssl = originalSsl;
      const removed = await app.ctx.web.removeSsl('panel.example.com', null);
      expect(removed.defaultVhost).toMatchObject({ applied: true, ssl: { source: 'panel' } });
      // An account domain's certificate does not touch it.
      app.agent.calls.length = 0;
      await app.ctx.web.applySsl('example.com', { cert: '/etc/ssl/whm/example.com/cert.pem', key: '/etc/ssl/whm/example.com/key.pem' }, null);
      expect(app.agent.callsTo('web.default_vhost.write')).toHaveLength(0);
      await app.ctx.web.removeSsl('example.com', null);
      // Behind the reverse proxy: the loopback bind and no HTTPS listener.
      app.ctx.settings.set('service_config.apache_ports', { http: 8080, https: null, bind: '127.0.0.1' });
      const proxied = await app.ctx.web.ensureDefaultVhost(null);
      expect(app.agent.callsTo('web.default_vhost.write').pop().args).toMatchObject({ bind: '127.0.0.1', port: 8080, sslPort: null });
      expect(proxied).toMatchObject({ applied: true, ssl: null, addresses: ['127.0.0.1'] });
      app.ctx.settings.set('service_config.apache_ports', previousPorts);
      // An unqualified hostname still gets the landing page and the catch-all (the hostname vhost itself is refused).
      app.agent.calls.length = 0;
      const local = await app.ctx.web.ensureHostnameVhost(null, { hostname: 'localhost' });
      expect(local).toMatchObject({ applied: false, reason: 'invalid_hostname', landingPage: true, defaultVhost: { applied: true, hostname: 'localhost' } });
      expect(app.agent.callsTo('fs.write_file').map((c) => c.args.path)).toEqual(['/var/www/whm-default/index.html']);
      expect(app.agent.callsTo('web.vhost.write')).toHaveLength(0);
      expect(app.agent.callsTo('web.default_vhost.write').pop().args.hostname).toBe('localhost');
      // A rejected write is reported, never thrown, and recorded for the Apache page.
      app.agent.fail('web.default_vhost.write', 'config_invalid', 'Apache rejected the default virtual host');
      const failed = await app.ctx.web.ensureHostnameVhost(null);
      expect(failed).toMatchObject({ applied: true, defaultVhost: { applied: false, reason: 'config_invalid', error: 'Apache rejected the default virtual host' } });
      expect((await get('/api/service-config/apache')).body.data.defaultVhost).toMatchObject({ ok: false, error: 'Apache rejected the default virtual host' });
      app.agent.set('web.default_vhost.write', DEFAULT_VHOST_WRITE);
      // Removal goes through the agent and is recorded.
      app.agent.calls.length = 0;
      expect(await app.ctx.web.removeDefaultVhost(null)).toMatchObject({ removed: true, path: '/etc/apache2/sites-available/000-whm-default.conf', reload: { reloaded: true } });
      expect(app.agent.callsTo('web.default_vhost.remove')).toHaveLength(1);
      expect((await get('/api/service-config/apache')).body.data.defaultVhost).toMatchObject({ ok: true, summary: { removed: true } });
    } finally {
      app.ctx.ssl = originalSsl;
      app.ctx.db.prepare("DELETE FROM web_vhosts WHERE type = 'server'").run();
      app.ctx.settings.setMany({ 'basic.hostname': previousHostname, 'basic.main_ip': '', 'basic.main_ipv6': '' });
      app.ctx.settings.set('service_config.apache_ports', previousPorts);
      app.agent.set('web.default_vhost.write', DEFAULT_VHOST_WRITE);
    }
  });

  it('removeDomain deletes one addon/sub vhost (file and row) and refuses the main domain and the hostname', async () => {
    const previousHostname = app.ctx.settings.get('basic.hostname');
    app.ctx.settings.setMany({ 'basic.hostname': 'panel.example.com', 'basic.main_ip': '203.0.113.5' });
    try {
      expect((await app.ctx.web.ensureVhost('alice', null)).applied).toBe(true);
      expect(await app.ctx.web.ensureHostnameVhost(null)).toMatchObject({ applied: true });
      expect(app.ctx.web.vhostFor('shop.example.com')).toMatchObject({ type: 'sub', username: 'alice' });
      app.agent.calls.length = 0;
      const r = await app.ctx.web.removeDomain('shop.example.com', null);
      expect(r).toEqual({ domain: 'shop.example.com', removed: true, recorded: true, applied: true });
      expect(app.agent.callsTo('web.vhost.remove').map((c) => c.args)).toEqual([{ domain: 'shop.example.com', reload: true }]);
      expect(app.ctx.web.vhostFor('shop.example.com')).toBeNull();
      expect(app.ctx.web.vhostFor('example.com')).toMatchObject({ type: 'main' });
      await expect(app.ctx.web.removeDomain('example.com', null)).rejects.toMatchObject({ status: 409 });
      await expect(app.ctx.web.removeDomain('panel.example.com', null)).rejects.toMatchObject({ status: 409 });
      expect(app.ctx.web.vhostFor('panel.example.com')).toMatchObject({ type: 'server' });
      // A domain with no row only tries the file.
      expect(await app.ctx.web.removeDomain('nothing.example.org', null)).toMatchObject({ removed: true, recorded: false });
      // The next account sync brings the sub domain back from account_domains.
      expect((await app.ctx.web.ensureVhost('alice', null)).applied).toBe(true);
      expect(app.ctx.web.vhostFor('shop.example.com')).toMatchObject({ type: 'sub' });
    } finally {
      app.ctx.db.prepare("DELETE FROM web_vhosts WHERE type = 'server'").run();
      app.ctx.settings.setMany({ 'basic.hostname': previousHostname, 'basic.main_ip': '' });
    }
  });

  it('the server hostname and www.<hostname> can never become an account vhost, and another owner\'s row is never inherited', async () => {
    const db = app.ctx.db;
    const previousHostname = app.ctx.settings.get('basic.hostname');
    app.ctx.settings.setMany({ 'basic.hostname': 'panel.example.com', 'basic.main_ip': '203.0.113.5' });
    let srvId = null;
    try {
      expect(await app.ctx.web.ensureHostnameVhost(null)).toMatchObject({ hostname: 'panel.example.com', applied: true });
      expect(app.ctx.web.isServerName('PANEL.example.com')).toBe(true);
      expect(app.ctx.web.isServerName('www.panel.example.com')).toBe(true);
      expect(app.ctx.web.isServerName('example.com')).toBe(false);
      // An account whose main domain is the hostname (account_domains alone does not stop it) gets no vhost: 409, server row untouched.
      srvId = Number(db.prepare("INSERT INTO accounts (username, domain, owner_id, home_dir, uid, gid, ip, plan_snapshot_json) VALUES ('srv', 'panel.example.com', 1, '/home/srv', 30002, 30002, '203.0.113.5', '{}')").run().lastInsertRowid);
      db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'panel.example.com', 'main', '/home/srv/public_html')").run(srvId);
      app.agent.calls.length = 0;
      await expect(app.ctx.web.ensureVhost('srv', null)).rejects.toMatchObject({ status: 409, code: 'conflict' });
      expect(app.agent.callsTo('web.vhost.write')).toEqual([]);
      expect(app.agent.callsTo('web.phpfpm.pool.write')).toEqual([]);
      expect(app.ctx.web.vhostFor('panel.example.com')).toMatchObject({ type: 'server', username: 'www-data', accountId: null, docroot: '/var/www/whm-default', status: 'applied' });
      expect(db.prepare("SELECT COUNT(*) AS n FROM web_vhosts WHERE username = 'srv'").get().n).toBe(0);
      // www.<hostname> as an alias or an addon domain of another account is refused the same way.
      await expect(app.ctx.web.addAlias({ username: 'alice', alias: 'www.panel.example.com' }, null)).rejects.toMatchObject({ status: 409 });
      expect(app.ctx.web.vhostFor('example.com').aliases).not.toContain('www.panel.example.com');
      const aliceId = db.prepare("SELECT id FROM accounts WHERE username = 'alice'").get().id;
      db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'www.panel.example.com', 'addon', '/home/alice/public_html/www')").run(aliceId);
      try {
        await expect(app.ctx.web.ensureVhost('alice', null)).rejects.toMatchObject({ status: 409 });
        expect(app.ctx.web.vhostFor('www.panel.example.com')).toBeNull();
      } finally { db.prepare("DELETE FROM account_domains WHERE domain = 'www.panel.example.com'").run(); }
      // A stale 'server' row for a domain that is no longer the hostname is still never taken over by an account.
      db.prepare("DELETE FROM account_domains WHERE account_id = ?").run(srvId);
      db.prepare("UPDATE accounts SET domain = 'srv.example.net' WHERE id = ?").run(srvId);
      db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'srv.example.net', 'main', '/home/srv/public_html')").run(srvId);
      db.prepare("INSERT INTO web_vhosts (domain, account_id, username, type, docroot, aliases_json, redirects_json, custom_directives, status) VALUES ('srv.example.net', NULL, 'www-data', 'server', '/var/www/whm-default', '[]', '[]', '', 'applied')").run();
      await expect(app.ctx.web.ensureVhost('srv', null)).rejects.toMatchObject({ status: 409 });
      db.prepare("DELETE FROM web_vhosts WHERE domain = 'srv.example.net'").run();
      // A row another owner wrote for bob's domain is treated as absent: its certificate and directives are not inherited.
      db.prepare(`INSERT INTO web_vhosts (domain, account_id, username, type, docroot, aliases_json, redirects_json, ssl_json, custom_directives, ipv6, status) VALUES ('bob.example.org', NULL, 'mallory', 'main', '/home/mallory/public_html', '[]', '[]', '{"cert":"/etc/ssl/whm/panel.example.com/cert.pem","key":"/etc/ssl/whm/panel.example.com/key.pem"}', 'Header set X-Owned 1', '2001:db8::7', 'applied')
        ON CONFLICT (domain) DO UPDATE SET username = excluded.username, type = excluded.type, docroot = excluded.docroot, ssl_json = excluded.ssl_json, custom_directives = excluded.custom_directives, ipv6 = excluded.ipv6`).run();
      app.agent.calls.length = 0;
      const bob = await app.ctx.web.ensureVhost('bob', null);
      expect(bob.applied).toBe(true);
      const write = app.agent.callsTo('web.vhost.write').find((c) => c.args.domain === 'bob.example.org').args;
      expect(write).toMatchObject({ user: 'bob', docroot: '/home/bob/public_html', customDirectives: '', redirectHttps: false });
      expect(write.ssl).toBeUndefined();
      expect(write.ipv6).toBeUndefined();
      expect(app.ctx.web.vhostFor('bob.example.org')).toMatchObject({ username: 'bob', ssl: null, customDirectives: '', ipv6: null });
    } finally {
      if (srvId != null) { db.prepare('DELETE FROM account_domains WHERE account_id = ?').run(srvId); db.prepare('DELETE FROM accounts WHERE id = ?').run(srvId); }
      db.prepare("DELETE FROM web_vhosts WHERE username IN ('srv', 'mallory') OR type = 'server'").run();
      app.ctx.settings.setMany({ 'basic.hostname': previousHostname, 'basic.main_ip': '' });
    }
  });

  it('setRedirects, addAlias/removeAlias, setAccountIpv6, replaceIp, setPhpVersion and setListenPorts', async () => {
    await app.ctx.web.setRedirects('example.com', [{ from: '/', to: 'https://new.example.com', type: '301', matchWww: true, keepPath: true }], null);
    expect(app.agent.callsTo('web.vhost.write').pop().args.redirects).toEqual([{ from: '/', to: 'https://new.example.com', type: '301', matchWww: true, keepPath: true }]);
    const audits = [];
    const req = { audit: (e) => audits.push(e) };
    await app.ctx.web.addAlias({ username: 'alice', domain: 'example.com', alias: 'alias.example.org' }, req);
    expect(app.ctx.web.vhostFor('example.com').aliases).toContain('alias.example.org');
    await app.ctx.web.removeAlias({ username: 'alice', alias: 'alias.example.org' }, req);
    expect(app.ctx.web.vhostFor('example.com').aliases).not.toContain('alias.example.org');
    expect(audits.map((a) => a.action)).toEqual(['web.alias.add', 'web.alias.remove']);
    expect(audits[0]).toMatchObject({ target: 'example.com', args: { alias: 'alias.example.org', username: 'alice' } });
    // Multi-vhost changes write every file without a reload and reload Apache once at the end.
    const mark = app.agent.calls.length;
    const v6 = await app.ctx.web.setAccountIpv6('alice', '2001:db8::10', null);
    expect(v6.vhosts.length).toBe(2);
    expect(app.agent.callsTo('web.vhost.write').pop().args.ipv6).toBe('2001:db8::10');
    const since = app.agent.calls.slice(mark);
    expect(since.filter((c) => c.name === 'web.vhost.write').every((c) => c.args.reload === false)).toBe(true);
    expect(since.filter((c) => c.name === 'web.reload')).toHaveLength(1);
    const moved = await app.ctx.web.replaceIp('203.0.113.5', '203.0.113.9', {}, null);
    expect(moved.updated).toBe(2);
    expect(app.ctx.web.vhostFor('shop.example.com').ip).toBe('203.0.113.9');
    await app.ctx.web.setPhpVersion('example.com', 'ea-php81', null, { reload: false });
    expect(app.agent.callsTo('web.phpfpm.pool.write').pop().args.version).toBe('8.1');
    expect(app.agent.callsTo('web.vhost.write').pop().args).toMatchObject({ domain: 'example.com', reload: false });
    expect(app.ctx.web.vhostFor('example.com').phpVersion).toBe('8.1');
    await app.ctx.web.setPhpVersion('example.com', 'ea-php81', null);
    expect(app.agent.callsTo('web.vhost.write').pop().args.reload).toBe(true);
    await expect(app.ctx.web.setPhpVersion('example.com', 'ea-php56', null)).rejects.toMatchObject({ status: 501, capability: 'php' });
    await expect(app.ctx.web.writePhpPool('nobody', '8.3', {}, null)).rejects.toMatchObject({ status: 404 });
    const ports = await app.ctx.web.setListenPorts({ http: 8080, https: 8443 }, null);
    expect(ports.http).toBe(8080);
    expect(ports.vhosts).toBeGreaterThanOrEqual(2);
    expect(app.agent.callsTo('web.vhost.write').pop().args).toMatchObject({ port: 8080, sslPort: 8443 });
    await app.ctx.web.setListenPorts({ http: 80, https: 443 }, null);
  });

  it('a per-domain PHP version survives the account sync, with one pool per version in use', async () => {
    expect(app.ctx.web.vhostFor('example.com').phpVersion).toBe('8.1');
    const r = await app.ctx.web.ensureVhost('alice', null);
    expect(r).toMatchObject({ username: 'alice', applied: true, phpVersion: '8.3', phpVersions: { 'example.com': '8.1', 'shop.example.com': '8.3' } });
    expect(app.ctx.web.vhostFor('example.com').phpVersion).toBe('8.1');
    expect(app.ctx.web.vhostFor('shop.example.com').phpVersion).toBe('8.3');
    expect(app.agent.callsTo('web.vhost.write').find((c) => c.args.domain === 'example.com' && c.args.phpVersion === '8.1')).toBeTruthy();
    expect(app.ctx.db.prepare("SELECT version FROM web_php_pools WHERE username = 'alice' ORDER BY version").all().map((p) => p.version)).toEqual(['8.1', '8.3']);
    expect((await get('/api/service-config/apache')).body.data.pools.filter((p) => p.username === 'alice').map((p) => p.version)).toEqual(['8.1', '8.3']);
    await app.ctx.web.setPhpVersion('example.com', '8.3', null);
    await app.ctx.web.ensureVhost('alice', null);
    expect(app.agent.callsTo('web.phpfpm.pool.remove').pop().args).toEqual({ user: 'alice', version: '8.1' });
    expect(app.ctx.db.prepare("SELECT version FROM web_php_pools WHERE username = 'alice'").all().map((p) => p.version)).toEqual(['8.3']);
  });

  it('setListenPorts with a bind address pins Listen and every vhost to it and releases 443 when https is null', async () => {
    const r = await app.ctx.web.setListenPorts({ http: 8080, https: null, bind: '127.0.0.1' }, null);
    expect(r).toMatchObject({ http: 8080, https: null, bind: '127.0.0.1' });
    expect(app.agent.callsTo('web.ports.set').pop().args).toEqual({ http: 8080, https: null, bind: '127.0.0.1' });
    expect(app.agent.callsTo('web.vhost.write').pop().args).toMatchObject({ port: 8080, sslPort: null, bind: '127.0.0.1' });
    expect((await get('/api/service-config/apache')).body.data.ports).toEqual({ http: 8080, https: null, bind: '127.0.0.1' });
    await app.ctx.web.setListenPorts({ http: 80, https: 443 }, null);
    expect(app.agent.callsTo('web.ports.set').pop().args).toEqual({ http: 80, https: 443, bind: null });
    expect(app.agent.callsTo('web.vhost.write').pop().args.bind).toBeUndefined();
  });

  it('ensureVhost for a fresh account and removeAccount clean-up', async () => {
    const r = await app.ctx.web.ensureVhost('bob', null);
    expect(r).toMatchObject({ username: 'bob', applied: true });
    expect(app.ctx.web.vhostFor('bob.example.org')).toMatchObject({ docroot: '/home/bob/public_html', status: 'applied' });
    const removed = await app.ctx.web.removeAccount('bob', null);
    expect(removed.removed).toEqual(['bob.example.org']);
    expect(app.ctx.web.vhostFor('bob.example.org')).toBeNull();
    expect(app.agent.callsTo('web.vhost.remove').pop().args.domain).toBe('bob.example.org');
  });

  it('a rejected vhost in the middle of a batch still gets the validated ones reloaded', async () => {
    const original = app.agent.callsTo('web.vhost.write').length >= 0;
    expect(original).toBe(true);
    app.agent.set('web.vhost.write', ({ domain, logDir, bind }) => { if (domain === 'shop.example.com') throw Object.assign(new Error('Apache rejected the new configuration'), { agentError: true, code: 'config_invalid', details: {} }); return { domain, path: `/etc/apache2/sites-available/${domain}.conf`, logDir, validated: true, bytes: 500, bind: bind ?? null, reloaded: false, unit: null }; });
    try {
      const mark = app.agent.calls.length;
      const r = await app.ctx.web.ensureVhost('alice', null);
      expect(r.vhosts.find((v) => v.domain === 'example.com').applied).toBe(true);
      expect(r.vhosts.find((v) => v.domain === 'shop.example.com')).toMatchObject({ applied: false, reason: 'config_invalid' });
      expect(app.agent.calls.slice(mark).filter((c) => c.name === 'web.reload')).toHaveLength(1);
      expect(r.reload.reloaded).toBe(true);
    } finally {
      app.agent.set('web.vhost.write', ({ domain, ssl, sslPort, phpVersion, redirects, logDir, bind }) => ({ domain, path: `/etc/apache2/sites-available/${domain}.conf`, link: `/etc/apache2/sites-enabled/${domain}.conf`, logDir, validated: true, bytes: 500, ssl: Boolean(ssl && sslPort), bind: bind ?? null, phpVersion: phpVersion ?? null, redirects: redirects?.length ?? 0, reloaded: true, unit: 'apache2' }));
      await app.ctx.web.ensureVhost('alice', null);
    }
  });

  it('an Apache host without any PHP-FPM tree writes the vhost but marks it failed (php_missing) instead of applied', async () => {
    app.agent.set('web.detect', () => ({ ...detectWith(true)(), php: { installed: false, versions: [] } }));
    try {
      await app.ctx.web.detect(true);
      const r = await app.ctx.web.ensureVhost('bob', null);
      expect(r).toMatchObject({ username: 'bob', applied: false, reason: 'php_missing', phpVersion: null });
      expect(r.vhosts[0]).toMatchObject({ domain: 'bob.example.org', applied: false, reason: 'php_missing' });
      expect(app.agent.callsTo('web.vhost.write').pop().args.phpVersion).toBeUndefined();
      expect(app.ctx.web.vhostFor('bob.example.org')).toMatchObject({ status: 'failed' });
      expect(app.ctx.web.vhostFor('bob.example.org').error).toMatch(/PHP-FPM is not installed/);
    } finally {
      app.agent.set('web.detect', detectWith(true));
      await app.ctx.web.detect(true);
      await app.ctx.web.removeAccount('bob', null);
    }
  });

  it('a failing PHP-FPM pool never strips the PHP handler from a vhost: it keeps the handler, is marked failed and the sync reports applied:false', async () => {
    expect(app.ctx.web.vhostFor('shop.example.com').phpVersion).toBe('8.3');
    app.ctx.db.prepare("UPDATE web_php_pools SET status = 'pending' WHERE username = 'alice'").run();
    app.agent.fail('web.phpfpm.pool.write', 'config_invalid', 'PHP-FPM rejected the pool; the previous file was restored: [pool other] user not found');
    const before = app.agent.callsTo('web.vhost.write').length;
    try {
      const r = await app.ctx.web.ensureVhost('alice', null);
      expect(r.applied).toBe(false);
      expect(r.poolErrors['8.3']).toMatch(/rejected the pool/);
      expect(r.vhosts.map((v) => v.reason)).toEqual(['php_pool_failed', 'php_pool_failed']);
      const writes = app.agent.callsTo('web.vhost.write').slice(before);
      expect(writes.length).toBe(2);
      for (const w of writes) expect(w.args.phpVersion, w.args.domain).toBe('8.3');
      expect(app.ctx.web.vhostFor('shop.example.com')).toMatchObject({ status: 'failed', phpVersion: '8.3' });
      expect(app.ctx.web.vhostFor('shop.example.com').error).toMatch(/PHP-FPM 8\.3 pool/);
      expect(app.ctx.db.prepare("SELECT status FROM web_php_pools WHERE username = 'alice' AND version = '8.3'").get().status).toBe('failed');
    } finally { app.agent.reset('web.phpfpm.pool.write'); app.agent.set('web.phpfpm.pool.write', ({ user, version }) => ({ user, version, path: `/etc/php/${version}/fpm/pool.d/whm-${user}.conf`, socket: `/run/php/php${version}-fpm-${user}.sock`, validated: true, bytes: 300, reloaded: true, unit: `php${version}-fpm` })); }
    const again = await app.ctx.web.ensureVhost('alice', null);
    expect(again.applied).toBe(true);
    expect(app.ctx.web.vhostFor('shop.example.com').status).toBe('applied');
  });

  it('a RHEL host with the single stock /etc/php-fpm.d tree ("system") gets a pool and a handler end to end', async () => {
    app.ctx.db.prepare("INSERT INTO accounts (username, domain, owner_id, home_dir, plan_snapshot_json) VALUES ('carol', 'carol.example.net', 1, '/home/carol', '{\"php_version\":\"ea-php83\"}')").run();
    const rhel = { ...APACHE, flavor: 'rhel', root: '/etc/httpd', bin: 'httpd', confD: '/etc/httpd/conf.d', globalInclude: '/etc/httpd/conf.d/whm.conf', units: ['httpd'] };
    const systemPhp = { installed: true, versions: [{ version: 'system', flavor: 'rhel', poolDir: '/etc/php-fpm.d', bin: 'php-fpm', units: ['php-fpm'], socketDir: '/run/php-fpm', listenOwner: 'apache' }] };
    app.agent.set('web.detect', () => ({ ...detectWith(true)(), apache: rhel, php: systemPhp }));
    try {
      await app.ctx.web.detect(true);
      expect(phpVersionId('system')).toBe('system');
      const r = await app.ctx.web.ensureVhost('carol', null);
      expect(r).toMatchObject({ username: 'carol', applied: true, phpVersion: 'system', phpVersions: { 'carol.example.net': 'system' } });
      expect(app.agent.callsTo('web.phpfpm.pool.write').pop().args).toMatchObject({ user: 'carol', version: 'system' });
      expect(app.agent.callsTo('web.vhost.write').pop().args).toMatchObject({ domain: 'carol.example.net', phpVersion: 'system' });
      expect(app.ctx.db.prepare("SELECT version, status FROM web_php_pools WHERE username = 'carol'").all()).toEqual([{ version: 'system', status: 'applied' }]);
      expect(app.ctx.web.vhostFor('carol.example.net')).toMatchObject({ phpVersion: 'system', status: 'applied' });
      // The admin can pin it as the default and choose it per domain.
      expect((await put('/api/service-config/apache', { defaultPhpVersion: 'system' })).status).toBe(200);
      await app.ctx.web.setPhpVersion('carol.example.net', 'system', null);
      expect(app.ctx.web.vhostFor('carol.example.net').phpVersion).toBe('system');
      await expect(app.ctx.web.setPhpVersion('carol.example.net', 'sys;tem', null)).rejects.toMatchObject({ status: 400 });
    } finally {
      await put('/api/service-config/apache', { defaultPhpVersion: null });
      await app.ctx.web.removeAccount('carol', null);
      app.ctx.db.prepare("DELETE FROM accounts WHERE username = 'carol'").run();
      app.agent.set('web.detect', detectWith(true));
      await app.ctx.web.detect(true);
    }
  });
});

describe('cPanel Log Rotation Configuration', () => {
  it('reads policies with previews and writes/removes the managed files on save', async () => {
    const res = await get('/api/service-config/logrotate').expect(200);
    expect(res.body.data.installed).toBe(true);
    expect(res.body.data.policies.map((p) => p.name)).toEqual(['panel', 'accounts', 'webserver']);
    const accounts = res.body.data.policies.find((p) => p.name === 'accounts');
    // Root only rotates the root-owned domlogs tree; every tenant-owned /home/<user>/logs gets its own `su <user>` stanza.
    expect(accounts.perAccount).toBe(true);
    expect(accounts.preview).toMatchObject({ paths: expect.arrayContaining(['/var/log/whm/domlogs/*/*.log', '/home/alice/logs/*.log']), su: { user: 'root', group: 'root' }, postrotate: 'apache-reload' });
    expect(accounts.preview.paths).not.toContain('/home/*/logs/*.log');
    expect(accounts.preview.stanzas[0]).toEqual({ paths: ['/var/log/whm/domlogs/*/*.log'], su: { user: 'root', group: 'root' }, postrotate: 'apache-reload' });
    expect(accounts.preview.stanzas).toContainEqual({ paths: ['/home/alice/logs/*.log'], su: { user: 'alice', group: 'alice' }, postrotate: 'none' });
    expect(accounts.preview.stanzas.filter((s) => s.su.user === 'root')).toHaveLength(1);
    const save = await put('/api/service-config/logrotate', { frequency: 'weekly', rotate: 8, maxSize: '200M', webServerLogs: false, postrotateWeb: false }).expect(200);
    expect(save.body.data.settings).toMatchObject({ frequency: 'weekly', rotate: 8, maxSize: '200M' });
    const writes = app.agent.callsTo('web.logrotate.write');
    expect(writes.map((w) => w.args.name).sort()).toEqual(['accounts', 'panel']);
    expect(writes.find((w) => w.args.name === 'accounts').args).toMatchObject({ frequency: 'weekly', rotate: 8, maxSize: '200M', postrotate: 'none' });
    expect(writes.find((w) => w.args.name === 'accounts').args.stanzas.find((s) => s.su.user === 'alice')).toEqual({ paths: ['/home/alice/logs/*.log'], su: { user: 'alice', group: 'alice' }, postrotate: 'none' });
    expect(writes.find((w) => w.args.name === 'panel').args.stanzas).toBeUndefined();
    expect(app.agent.callsTo('web.logrotate.remove').map((w) => w.args.name)).toContain('webserver');
    expect((await put('/api/service-config/logrotate', { maxSize: '10 MB' })).status).toBe(422);
    expect((await put('/api/service-config/logrotate', { frequency: 'always' })).status).toBe(422);
  });

  it('leaves out web server logs the distribution already rotates, and writes nothing when none remain', async () => {
    app.agent.set('web.logrotate.list', () => ({ dir: '/etc/logrotate.d', logrotate: true, policies: [], dirExists: true, distribution: { apache2: '/etc/logrotate.d/apache2' } }));
    try {
      const res = await get('/api/service-config/logrotate').expect(200);
      const web = res.body.data.policies.find((p) => p.name === 'webserver');
      expect(web.paths).toEqual(['/var/log/httpd/*log', '/var/log/nginx/*.log']);
      expect(web.coveredBy).toEqual(['/etc/logrotate.d/apache2']);
      await put('/api/service-config/logrotate', { webServerLogs: true }).expect(200);
      expect(app.agent.callsTo('web.logrotate.write').filter((w) => w.args.name === 'webserver').pop().args.paths).toEqual(['/var/log/httpd/*log', '/var/log/nginx/*.log']);
      app.agent.set('web.logrotate.list', () => ({ dir: '/etc/logrotate.d', logrotate: true, policies: [], dirExists: true, distribution: { apache2: '/etc/logrotate.d/apache2', httpd: '/etc/logrotate.d/httpd', nginx: '/etc/logrotate.d/nginx' } }));
      const webWrites = app.agent.callsTo('web.logrotate.write').filter((w) => w.args.name === 'webserver').length;
      const all = await put('/api/service-config/logrotate', { rotate: 9 }).expect(200);
      expect(app.agent.callsTo('web.logrotate.write').filter((w) => w.args.name === 'webserver').length).toBe(webWrites);
      expect(app.agent.callsTo('web.logrotate.remove').pop().args.name).toBe('webserver');
      expect(all.body.data.applied.webserver.note).toMatch(/already rotated by/);
    } finally {
      app.agent.set('web.logrotate.list', () => ({ dir: '/etc/logrotate.d', logrotate: true, policies: [{ name: 'panel', path: '/etc/logrotate.d/whm-panel', size: 120 }], dirExists: true }));
      await put('/api/service-config/logrotate', { webServerLogs: false }).expect(200);
    }
  });

  it('runs a policy now', async () => {
    const res = await post('/api/service-config/logrotate/panel/run', { force: true }).expect(200);
    expect(res.body.data).toMatchObject({ name: 'panel', force: true, ok: true });
    expect((await post('/api/service-config/logrotate/cron/run', {})).status).toBe(422);
  });
});

describe('Web Disk and Web Services settings', () => {
  it('round-trip with validation', async () => {
    expect((await get('/api/service-config/webdisk')).body.data.settings).toMatchObject({ port: 2077, sslPort: 2078 });
    const saved = await put('/api/service-config/webdisk', { requireSsl: false, maxUploadMb: 512, allowedAccounts: 'shell' }).expect(200);
    expect(saved.body.data.settings).toMatchObject({ requireSsl: false, maxUploadMb: 512, allowedAccounts: 'shell', port: 2077 });
    expect((await put('/api/service-config/webdisk', { port: 2078 })).status).toBe(422);
    expect((await put('/api/service-config/webdisk', { allowedAccounts: 'everyone' })).status).toBe(422);
    const ws = await put('/api/service-config/webservices', { rateLimitPerMinute: 1200, allowedOrigins: ['https://panel.example.com'] }).expect(200);
    expect(ws.body.data.settings).toMatchObject({ rateLimitPerMinute: 1200, allowedOrigins: ['https://panel.example.com'] });
    expect((await put('/api/service-config/webservices', { allowedOrigins: ['javascript:alert(1)'] })).status).toBe(422);
    expect((await put('/api/service-config/webservices', { tokenLifetimeMinutes: 1 })).status).toBe(422);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('webdisk.config.update', 'webservices.config.update')").get().n).toBe(2);
    // Nothing consumes these yet; the API says so instead of pretending.
    expect(saved.body.data.live).toBe(false);
    expect(ws.body.data.live).toBe(false);
    expect((await get('/api/service-config/webdisk')).body.data.live).toBe(false);
    expect((await get('/api/service-config/webservices')).body.data.live).toBe(false);
  });
});

describe('Exim Configuration Manager', () => {
  it('renders Debian macros versus RHEL raw options, RCPT and DATA ACL fragments', () => {
    const s = DEFAULTS.exim;
    const deb = renderEximMain(s, EXIM_LAYOUT);
    expect(deb).toContain('.ifndef CHECK_RCPT_IP_DNSBLS\nCHECK_RCPT_IP_DNSBLS = zen.spamhaus.org : bl.spamcop.net\n.endif');
    expect(deb).toContain('MESSAGE_SIZE_LIMIT = 50M');
    // Debian's CHECK_RCPT_SPF is a hard `deny spf = fail`, so it only appears when rejection is wanted.
    expect(deb).not.toContain('CHECK_RCPT_SPF');
    expect(renderEximMain({ ...s, spfReject: true }, EXIM_LAYOUT)).toContain('CHECK_RCPT_SPF = true');
    expect(renderEximMain({ ...s, spfVerify: false, spfReject: true }, EXIM_LAYOUT)).not.toContain('CHECK_RCPT_SPF');
    // CHECK_MAIL_HELO_ISSUED no longer exists in Debian's check_mail ACL; HELO is enforced in the RCPT fragment instead.
    expect(deb).not.toContain('CHECK_MAIL_HELO_ISSUED');
    expect(deb).toContain(`.ifndef CHECK_RCPT_LOCAL_ACL_FILE\nCHECK_RCPT_LOCAL_ACL_FILE = ${CHAIN}\n.endif`);
    expect(deb).toContain(`CHECK_DATA_LOCAL_ACL_FILE = ${EXIM_LAYOUT.slots.acl_data.path}`);
    expect(deb).toContain('smtp_accept_max = 100');
    expect(deb).toContain('smtp_ratelimit_mail = 10,1s,1.5,30s');
    expect(deb).toContain('smtp_max_unknown_commands = 3');
    expect(deb).toContain('MAIN_LOG_SELECTOR = +smtp_connection +subject +tls_cipher');
    expect(deb).not.toContain('auth_advertise_hosts');
    // The sentinel the agent checks with `exim -bP macro` leads every layout's main slot.
    expect(deb.split('\n')[1]).toBe('WHM_SERVICE_CONFIG = 1');
    // Unsplit Debian (the default) renders the same macros: they go into a localmacros block, read in both modes.
    const unsplit = renderEximMain(s, EXIM_UNSPLIT);
    expect(unsplit).toContain(`CHECK_RCPT_LOCAL_ACL_FILE = ${CHAIN}`);
    expect(unsplit).toContain('MESSAGE_SIZE_LIMIT = 50M');
    expect(unsplit).not.toContain('message_size_limit =');
    expect(unsplit.replace(/^# .*\n/gm, '')).toBe(deb.replace(/^# .*\n/gm, ''));
    const rhel = renderEximMain(s, { flavor: 'rhel', splitConfig: false, slots: EXIM_LAYOUT.slots });
    expect(rhel).toContain('WHM_SERVICE_CONFIG = 1');
    expect(rhel).toContain('message_size_limit = 50M');
    expect(rhel).toContain('auth_advertise_hosts = ${if eq{$tls_in_cipher}{}{}{*}}');
    expect(rhel).toContain('log_selector = +smtp_connection +subject +tls_cipher');
    expect(rhel).not.toContain('.ifndef');
    expect(rhel).not.toContain('helo_verify_hosts');
    expect(rhel).not.toContain('tls_require_ciphers');
    // The RCPT chain carries the real deny rules on every layout (Debian's macros only warn) and ends with the Email filters include.
    const acl = renderEximRcptAcl(s, undefined, EXIM_LAYOUT);
    expect(acl.trimEnd().split('\n').pop()).toBe(`.include_if_exists ${EMAIL_ACL}`);
    expect(renderEximRcptAcl(s).trimEnd().split('\n').pop()).toBe('.include_if_exists /etc/exim/whm/acl-email-filters.conf');
    expect(renderEximRcptAcl({ ...s, requireHelo: false, rblEnabled: false, verifySender: false, spfVerify: false, dictionaryAttackProtection: false }, undefined, EXIM_LAYOUT)).toContain(`No RCPT protections are enabled.\n# Email filters`);
    expect(acl).toContain('drop    condition = ${if > {$rcpt_fail_count}{4}}');
    expect(acl).toContain('        delay = 10s');
    expect(acl).toContain('deny\n        !authenticated = *\n        !hosts = <; ; 127.0.0.1 ; ::1\n        dnslists = zen.spamhaus.org : bl.spamcop.net');
    expect(acl).toContain('condition = ${if def:sender_helo_name{no}{yes}}');
    expect(acl).toContain('!verify = sender');
    expect(acl).not.toContain('reverse_host_lookup');
    expect(renderEximRcptAcl({ ...s, reverseDnsRequired: true })).toContain('deny\n        !authenticated = *\n        !hosts = <; ; 127.0.0.1 ; ::1\n        !verify = reverse_host_lookup');
    expect(renderEximRcptAcl({ ...s, domainRblEnabled: true })).toContain('dnslists = dbl.spamhaus.org/$sender_address_domain');
    // `::1` in a colon-separated list is '' + ':1' (a host-name pattern that forces a PTR lookup and can defer the deny).
    for (const out of [acl, renderEximRcptAcl({ ...s, reverseDnsRequired: true, domainRblEnabled: true, spfReject: true })]) {
      expect(out).toContain('!hosts = <;');
      expect(out).not.toMatch(/hosts = : /);
      expect(out).not.toMatch(/: ::1/);
    }
    expect(acl).toContain('spf = fail : softfail');
    expect(acl).not.toContain('        spf = fail\n');
    const reject = renderEximRcptAcl({ ...s, spfReject: true });
    expect(reject).toContain('        spf = fail\n        message = SPF check failed');
    expect(reject).toContain('        spf = softfail\n        add_header');
    expect(renderEximRcptAcl({ ...s, requireHelo: false, rblEnabled: false, verifySender: false, spfVerify: false, dictionaryAttackProtection: false })).toContain('No RCPT protections are enabled');
    const data = renderEximDataAcl({ ...s, dkimReject: true });
    expect(data).toContain('dkim_status = fail');
    expect(data).toContain('deny    !authenticated = *');
    // $dkim_cur_signer only exists in acl_smtp_dkim; the DATA ACL has the signer list.
    expect(data).toContain('$dkim_signers');
    expect(data).not.toContain('$dkim_cur_signer');
    expect(renderEximDataAcl({ ...s, dkimVerify: false })).toContain('DKIM verification is disabled');
  });

  it('renders the TLS policy handed over by SSL/TLS Configuration per TLS library', () => {
    const tls = tlsPolicyFrom({ minProtocol: 'TLSv1.2', protocols: ['TLSv1.2', 'TLSv1.3'], cipherList: 'ECDHE-RSA-AES256-GCM-SHA384', cipherSuites: 'TLS_AES_256_GCM_SHA384', preferServerCiphers: true });
    expect(tls).toEqual({ minProtocol: 'TLSv1.2', protocols: ['TLSv1.2', 'TLSv1.3'], cipherList: 'ECDHE-RSA-AES256-GCM-SHA384', cipherSuites: 'TLS_AES_256_GCM_SHA384', preferServerCiphers: true });
    expect(tlsPolicyFrom({ minProtocol: 'TLSv1.3' }).protocols).toEqual(['TLSv1.3']);
    expect(tlsPolicyFrom(null)).toBeNull();
    expect(() => tlsPolicyFrom({ minProtocol: 'SSLv3' })).toThrow(/minProtocol/);
    expect(eximTlsLibrary(EXIM_LAYOUT)).toBe('gnutls');
    expect(eximTlsLibrary({ flavor: 'rhel', features: ['OpenSSL', 'DKIM'] })).toBe('openssl');
    expect(eximTlsLibrary({ flavor: 'rhel', features: null })).toBe('openssl');
    expect(eximTlsLibrary({ flavor: 'debian', features: null })).toBe('gnutls');
    expect(renderEximTls(tls, 'gnutls').join('\n')).toContain('tls_require_ciphers = NORMAL:-VERS-ALL:+VERS-TLS1.2:+VERS-TLS1.3:%SERVER_PRECEDENCE');
    expect(renderEximTls(tls, 'gnutls').join('\n')).not.toContain('ECDHE');
    const openssl = renderEximTls(tls, 'openssl').join('\n');
    expect(openssl).toContain('tls_require_ciphers = ECDHE-RSA-AES256-GCM-SHA384');
    expect(openssl).toContain('openssl_options = +no_sslv2 +no_sslv3 +no_tlsv1 +no_tlsv1_1 +single_dh_use +no_ticket +cipher_server_preference');
    const main = renderEximMain({ ...DEFAULTS.exim, tls }, EXIM_LAYOUT);
    expect(main).toContain('tls_require_ciphers = NORMAL:-VERS-ALL:+VERS-TLS1.2:+VERS-TLS1.3:%SERVER_PRECEDENCE');
    expect(renderEximMain(DEFAULTS.exim, EXIM_LAYOUT)).not.toContain('tls_require_ciphers');
  });

  it('leaves the spf conditions out on an Exim built without SPF (exim4-daemon-light) so the config stays valid', () => {
    const s = DEFAULTS.exim;
    const light = { ...EXIM_LAYOUT, features: ['crypteq', 'iconv()', 'IPv6', 'GnuTLS', 'DKIM', 'DNSSEC'], support: { spf: false, dkim: true, dmarc: false } };
    const heavy = { ...EXIM_LAYOUT, features: ['crypteq', 'DKIM', 'SPF', 'DMARC'], support: { spf: true, dkim: true, dmarc: true } };
    expect(eximSupport(light)).toEqual({ spf: false, dkim: true });
    expect(eximSupport(heavy)).toEqual({ spf: true, dkim: true });
    expect(eximSupport(EXIM_LAYOUT)).toEqual({ spf: true, dkim: true });
    expect(eximSupport(null)).toEqual({ spf: true, dkim: true });
    const acl = renderEximRcptAcl({ ...s, spfReject: true }, eximSupport(light));
    expect(acl).not.toMatch(/^\s+spf = /m);
    expect(acl).toContain('no SPF support (exim4-daemon-light)');
    expect(acl).toContain('dnslists = zen.spamhaus.org');
    expect(renderEximRcptAcl({ ...s, spfReject: true }, eximSupport(heavy))).toContain('        spf = fail\n');
    const main = renderEximMain({ ...s, spfReject: true }, light, eximSupport(light));
    expect(main).not.toContain('CHECK_RCPT_SPF');
    expect(main).toContain('exim4-daemon-heavy');
    expect(renderEximMain({ ...s, spfReject: true }, heavy, eximSupport(heavy))).toContain('CHECK_RCPT_SPF = true');
    expect(renderEximDataAcl(s, { spf: true, dkim: false })).not.toContain('dkim_status');
  });

  it('reads layout + preview and applies the three slots on save; an unincluded RCPT fragment is not reported as a successful apply', async () => {
    const res = await get('/api/service-config/exim').expect(200);
    expect(res.body.data.installed).toBe(true);
    expect(res.body.data.layout.slots.main.path).toBe(EXIM_LAYOUT.slots.main.path);
    expect(Object.keys(res.body.data.preview)).toEqual(['main', 'acl_rcpt', 'acl_data']);
    expect(res.body.data.support).toEqual({ spf: true, dkim: true, tls: 'gnutls' });
    expect(res.body.data.chain).toEqual({ path: CHAIN, emailAclFile: EMAIL_ACL, includesEmailFilters: false, hooked: false, claimedBy: '/etc/exim4/whm/acl_rcpt.conf' });
    expect(res.body.data.inactive).toEqual(['acl_rcpt']);
    const save = await put('/api/service-config/exim', { rbls: ['zen.spamhaus.org'], maxMessageSizeMb: 25, dictionaryAttackProtection: true, rcptFailLimit: 6, logSelector: ['+subject'] }).expect(200);
    expect(save.body.data.settings).toMatchObject({ rbls: ['zen.spamhaus.org'], maxMessageSizeMb: 25, rcptFailLimit: 6 });
    const writes = app.agent.callsTo('web.exim.include.write');
    expect(writes.map((w) => w.args.slot)).toEqual(['acl_data', 'acl_rcpt', 'main']);
    expect(writes[2].args.content).toContain('MESSAGE_SIZE_LIMIT = 25M');
    expect(writes[2].args.content).toContain('CHECK_RCPT_IP_DNSBLS = zen.spamhaus.org\n');
    expect(writes[2].args.reload).toBe(true);
    expect(writes[0].args.reload).toBe(false);
    expect(writes[1].args.content).toContain('{$rcpt_fail_count}{6}');
    expect(writes[1].args.content).toContain('dnslists = zen.spamhaus.org\n');
    expect(writes[1].args.content.trimEnd()).toMatch(new RegExp(`\\.include_if_exists ${EMAIL_ACL}$`));
    expect(save.body.data.hints).toHaveLength(1);
    expect(save.body.data.hints[0]).toMatch(/CHECK_RCPT_LOCAL_ACL_FILE already points at \/etc\/exim4\/whm\/acl_rcpt\.conf/);
    expect(save.body.data.applied.acl_rcpt).toMatchObject({ hooked: false, claimedBy: '/etc/exim4/whm/acl_rcpt.conf', applied: false });
    expect(save.body.data.applied.main).toMatchObject({ hooked: true, applied: true });
    expect(save.body.data).toMatchObject({ live: false, inactive: ['acl_rcpt'] });
    expect(save.body.data.lastApply.ok).toBe(false);
    expect(save.body.data.lastApply.error).toMatch(/does not include \/etc\/exim4\/whm\/acl-rcpt-local\.conf \(CHECK_RCPT_LOCAL_ACL_FILE is used by \/etc\/exim4\/whm\/acl_rcpt\.conf\)/);
    expect((await get('/api/service-config/exim')).body.data.lastApply.ok).toBe(false);
  });

  it('ensureEximAclChain (Email hook) renders the chain + macro when missing, is a no-op once complete, and needs Exim', async () => {
    // The layout above says the chain was never written: the hook applies the saved policy.
    const before = app.agent.callsTo('web.exim.include.write').length;
    const created = await app.ctx.web.ensureEximAclChain();
    expect(created).toMatchObject({ created: true, path: CHAIN, emailAclFile: EMAIL_ACL, claimedBy: '/etc/exim4/whm/acl_rcpt.conf', live: false });
    const writes = app.agent.callsTo('web.exim.include.write').slice(before);
    expect(writes.map((w) => w.args.slot)).toEqual(['acl_data', 'acl_rcpt', 'main']);
    expect(writes[1].args.content).toContain(`.include_if_exists ${EMAIL_ACL}`);
    expect(writes[2].args.content).toContain(`CHECK_RCPT_LOCAL_ACL_FILE = ${CHAIN}`);
    // Once the chain and the macro exist nothing is rewritten.
    const complete = { ...EXIM_LAYOUT, slots: { ...EXIM_LAYOUT.slots, main: { ...EXIM_LAYOUT.slots.main, exists: true }, acl_rcpt: { ...EXIM_LAYOUT.slots.acl_rcpt, exists: true, hooked: true, claimedBy: null, includesEmailFilters: true, content: `# chain\n.include_if_exists ${EMAIL_ACL}\n` } } };
    app.agent.set('web.exim.detect', () => complete);
    try {
      const again = await app.ctx.web.ensureEximAclChain();
      expect(again).toEqual({ created: false, path: CHAIN, emailAclFile: EMAIL_ACL, hooked: true, claimedBy: null });
      expect(app.agent.callsTo('web.exim.include.write').length).toBe(before + 3);
    } finally { app.agent.set('web.exim.detect', () => EXIM_LAYOUT); }
    app.agent.set('web.exim.detect', () => ({ installed: false }));
    try { await expect(app.ctx.web.ensureEximAclChain()).rejects.toMatchObject({ status: 501, capability: 'exim' }); } finally { app.agent.set('web.exim.detect', () => EXIM_LAYOUT); }
  });

  it('applyEximTls (SSL/TLS Configuration hook) stores the preset and renders it into the main slot for the detected TLS library', async () => {
    const r = await app.ctx.web.applyEximTls({ minProtocol: 'TLSv1.2', protocols: ['TLSv1.2', 'TLSv1.3'], cipherList: 'ECDHE-RSA-AES256-GCM-SHA384', cipherSuites: '', preferServerCiphers: true }, null);
    expect(r).toMatchObject({ path: EXIM_LAYOUT.slots.main.path, validated: true, library: 'gnutls', reload: { reloaded: true, unit: 'exim4' } });
    const main = app.agent.callsTo('web.exim.include.write').filter((w) => w.args.slot === 'main').pop().args.content;
    expect(main).toContain('tls_require_ciphers = NORMAL:-VERS-ALL:+VERS-TLS1.2:+VERS-TLS1.3:%SERVER_PRECEDENCE');
    expect(main).not.toContain('ECDHE-RSA');
    expect((await get('/api/service-config/exim')).body.data.settings.tls).toEqual({ minProtocol: 'TLSv1.2', protocols: ['TLSv1.2', 'TLSv1.3'], cipherList: 'ECDHE-RSA-AES256-GCM-SHA384', cipherSuites: '', preferServerCiphers: true });
    expect((await get('/api/service-config/exim')).body.data.preview.main).toContain('tls_require_ciphers');
    // The policy survives an ordinary save and can be dropped through the API.
    await put('/api/service-config/exim', { maxMessageSizeMb: 30 }).expect(200);
    expect(app.agent.callsTo('web.exim.include.write').filter((w) => w.args.slot === 'main').pop().args.content).toContain('tls_require_ciphers');
    expect((await put('/api/service-config/exim', { tls: { minProtocol: 'SSLv3' } })).status).toBe(422);
    await put('/api/service-config/exim', { tls: null }).expect(200);
    expect(app.agent.callsTo('web.exim.include.write').filter((w) => w.args.slot === 'main').pop().args.content).not.toContain('tls_require_ciphers');
  });

  it('reports ok once every required fragment is included, and warns when SPF is not compiled in', async () => {
    const hookedLayout = { ...EXIM_LAYOUT, features: ['DKIM', 'DNSSEC'], support: { spf: false, dkim: true, dmarc: false }, slots: { ...EXIM_LAYOUT.slots, acl_rcpt: { ...EXIM_LAYOUT.slots.acl_rcpt, hooked: true, claimedBy: null }, acl_data: { ...EXIM_LAYOUT.slots.acl_data, hooked: true } }, hints: [] };
    app.agent.set('web.exim.detect', () => hookedLayout);
    app.agent.set('web.exim.include.write', ({ slot, content }) => ({ slot, path: hookedLayout.slots[slot].path, validated: true, hooked: true, claimedBy: null, bytes: content.length, version: '4.97', features: hookedLayout.features, reloaded: slot === 'main', unit: 'exim4' }));
    try {
      const res = await get('/api/service-config/exim').expect(200);
      expect(res.body.data.support).toMatchObject({ spf: false, dkim: true });
      expect(res.body.data.warnings).toHaveLength(1);
      expect(res.body.data.warnings[0]).toMatch(/exim4-daemon-heavy/);
      expect(res.body.data.preview.acl_rcpt).not.toMatch(/^\s+spf = /m);
      const save = await put('/api/service-config/exim', { spfReject: true }).expect(200);
      expect(save.body.data).toMatchObject({ live: true, inactive: [] });
      expect(save.body.data.lastApply.ok).toBe(true);
      expect(save.body.data.warnings[0]).toMatch(/SPF is not compiled/);
      const rcpt = app.agent.callsTo('web.exim.include.write').filter((w) => w.args.slot === 'acl_rcpt').pop().args.content;
      expect(rcpt).not.toMatch(/^\s+spf = /m);
      expect(app.agent.callsTo('web.exim.include.write').filter((w) => w.args.slot === 'main').pop().args.content).not.toContain('CHECK_RCPT_SPF');
    } finally {
      app.agent.set('web.exim.detect', () => EXIM_LAYOUT);
      app.agent.set('web.exim.include.write', ({ slot, content }) => ({ slot, path: EXIM_LAYOUT.slots[slot].path, validated: true, hooked: slot !== 'acl_rcpt', claimedBy: EXIM_LAYOUT.slots[slot].claimedBy, bytes: content.length, version: '4.97', reloaded: slot === 'main', unit: 'exim4' }));
      await put('/api/service-config/exim', { spfReject: false });
    }
  });

  it('validates the schema', async () => {
    expect((await put('/api/service-config/exim', { rbls: ['zen.spamhaus.org; rm'] })).status).toBe(422);
    expect((await put('/api/service-config/exim', { rblEnabled: true, rbls: [] })).status).toBe(422);
    expect((await put('/api/service-config/exim', { logSelector: ['subject'] })).status).toBe(422);
    expect((await put('/api/service-config/exim', { maxMessageSizeMb: 0 })).status).toBe(422);
    expect((await put('/api/service-config/exim', { ratelimitMailThreshold: 100, ratelimitRcptThreshold: 5 })).status).toBe(422);
  });
});

describe('Mailserver Configuration', () => {
  it('renders Dovecot settings and applies them', () => {
    const text = renderDovecot(DEFAULTS.mailserver);
    expect(text).toContain('protocols = imap pop3 lmtp');
    expect(text).toContain('ssl = required');
    expect(text).toContain('ssl_min_protocol = TLSv1.2');
    expect(text).toContain('mail_max_userip_connections = 20');
    expect(text).toContain('protocol pop3 {\n  mail_max_userip_connections = 10');
    expect(text).toContain('mail_location = maildir:~/mail');
    expect(renderDovecot({ ...DEFAULTS.mailserver, protocols: ['imap'] })).not.toContain('protocol pop3');
    // This file owns the cipher directives (ssl-tls only writes certificate paths, to 90-whm-ssl-cert.conf).
    expect(text).toContain('ssl_prefer_server_ciphers = no');
    expect(text).not.toContain('ssl_cipher_list');
    expect(text).not.toContain('ssl_cert');
    const ciphers = { ...DEFAULTS.mailserver, sslCipherList: 'ECDHE-RSA-AES256-GCM-SHA384', sslCipherSuites: 'TLS_AES_256_GCM_SHA384', sslPreferServerCiphers: true };
    const modern = renderDovecot(ciphers, { version: '2.3.21' });
    expect(modern).toContain('ssl_cipher_list = ECDHE-RSA-AES256-GCM-SHA384');
    expect(modern).toContain('ssl_cipher_suites = TLS_AES_256_GCM_SHA384');
    expect(modern).toContain('ssl_prefer_server_ciphers = yes');
    // ssl_cipher_suites only exists from 2.3.15; an older Dovecot would reject the file.
    expect(renderDovecot(ciphers, { version: '2.3.4' })).not.toContain('ssl_cipher_suites');
    expect(renderDovecot(ciphers)).not.toContain('ssl_cipher_suites');
    expect([dovecotSupportsCipherSuites('2.3.15'), dovecotSupportsCipherSuites('2.4.0'), dovecotSupportsCipherSuites('2.3.14'), dovecotSupportsCipherSuites(null)]).toEqual([true, true, false, false]);
  });

  it('applyMailserverTls (SSL/TLS Configuration hook) stores the preset here and re-renders the file', async () => {
    const r = await app.ctx.web.applyMailserverTls({ minProtocol: 'TLSv1.3', protocols: ['TLSv1.3'], cipherList: 'ECDHE-ECDSA-AES128-GCM-SHA256', cipherSuites: 'TLS_AES_128_GCM_SHA256', preferServerCiphers: false }, null);
    expect(r).toMatchObject({ path: '/etc/dovecot/conf.d/97-whm-mailserver.conf', validated: true, reload: { reloaded: true, unit: 'dovecot' } });
    const content = app.agent.callsTo('web.dovecot.include.write').pop().args.content;
    expect(content).toContain('ssl_min_protocol = TLSv1.3');
    expect(content).toContain('ssl_cipher_list = ECDHE-ECDSA-AES128-GCM-SHA256');
    expect(content).toContain('ssl_cipher_suites = TLS_AES_128_GCM_SHA256');
    expect(content).toContain('ssl_prefer_server_ciphers = no');
    expect((await get('/api/service-config/mailserver')).body.data.settings).toMatchObject({ sslMinProtocol: 'TLSv1.3', sslCipherList: 'ECDHE-ECDSA-AES128-GCM-SHA256', sslCipherSuites: 'TLS_AES_128_GCM_SHA256', sslPreferServerCiphers: false });
    expect((await put('/api/service-config/mailserver', { sslCipherList: 'ECDHE RSA; rm' })).status).toBe(422);
    await put('/api/service-config/mailserver', { sslMinProtocol: 'TLSv1.2', sslCipherList: '', sslCipherSuites: '' }).expect(200);
  });

  it('GET/PUT with validation and reload', async () => {
    const res = await get('/api/service-config/mailserver').expect(200);
    expect(res.body.data).toMatchObject({ installed: true, detect: { version: '2.3.21', effective: { protocols: 'imap pop3 lmtp' } } });
    expect(res.body.data.preview).toContain('protocols = imap pop3 lmtp');
    const save = await put('/api/service-config/mailserver', { protocols: ['imap', 'lmtp'], ssl: 'required', disablePlaintextAuth: false, maxUserIpConnections: 40 }).expect(200);
    expect(save.body.data.settings).toMatchObject({ protocols: ['imap', 'lmtp'], disablePlaintextAuth: true, maxUserIpConnections: 40 });
    expect(app.agent.callsTo('web.dovecot.include.write').pop().args.content).toContain('protocols = imap lmtp');
    expect(save.body.data.applied.reloaded).toBe(true);
    expect((await put('/api/service-config/mailserver', { protocols: [] })).status).toBe(422);
    expect((await put('/api/service-config/mailserver', { protocols: ['smtp'] })).status).toBe(422);
    expect((await put('/api/service-config/mailserver', { mailLocation: 'maildir:~/mail; rm -rf /' })).status).toBe(422);
    expect((await put('/api/service-config/mailserver', { loginGreeting: 'a\nb' })).status).toBe(422);
  });
});

describe('FTP Server Selection', () => {
  it('reports candidates, the active daemon and its effective config', async () => {
    const res = await get('/api/service-config/ftp').expect(200);
    expect(res.body.data).toMatchObject({ installed: true, selected: 'pure-ftpd', active: 'pure-ftpd', pkgAvailable: true });
    expect(res.body.data.detect.candidates.map((c) => c.name)).toEqual(['pure-ftpd', 'proftpd', 'vsftpd']);
    expect(res.body.data.config.settings.passivePortMin).toBe(30000);
  });

  it('switches daemons (disable others, enable chosen, push settings) and records the choice', async () => {
    const res = await put('/api/service-config/ftp/server', { server: 'vsftpd' }).expect(200);
    expect(res.body.data.server).toBe('vsftpd');
    expect(res.body.data.steps.map((s) => s.action)).toEqual(['disable --now', 'enable --now']);
    expect(app.agent.callsTo('web.service.select').pop().args).toEqual({ role: 'ftp', server: 'vsftpd' });
    expect(app.agent.callsTo('web.ftp.config.write').pop().args).toMatchObject({ server: 'vsftpd', settings: { passivePortMin: 49152, tls: 'optional' } });
    expect(app.ctx.settings.get('service_config.ftp_server')).toBe('vsftpd');
    expect((await put('/api/service-config/ftp/server', { server: 'wu-ftpd' })).status).toBe(422);
    const off = await put('/api/service-config/ftp/server', { server: 'disabled' }).expect(200);
    expect(off.body.data.config).toBeNull();
    await put('/api/service-config/ftp/server', { server: 'pure-ftpd' }).expect(200);
  });

  it('a daemon that is not installed answers 501, or queues an install job through the Software category', async () => {
    const res = await put('/api/service-config/ftp/server', { server: 'proftpd' });
    expect(res.status).toBe(501);
    expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'ftp' });
    const hadSoftware = app.ctx.software;
    const calls = [];
    app.ctx.software = { pkg: { install: async (names, user) => { calls.push({ names, user: user?.username }); return { job: { id: 4242 } }; } } };
    try {
      const queued = await put('/api/service-config/ftp/server', { server: 'proftpd', install: true }).expect(202);
      expect(queued.body.data).toMatchObject({ job: { id: 4242 }, package: 'proftpd-core', pending: true });
      expect(calls).toEqual([{ names: ['proftpd-core'], user: 'root' }]);
    } finally { app.ctx.software = hadSoftware; }
  });

  it('settings are validated and written to the active daemon', async () => {
    const save = await put('/api/service-config/ftp/settings', { passivePortMin: 50000, passivePortMax: 50100, tls: 'required', passiveAddress: '203.0.113.5' }).expect(200);
    expect(save.body.data.settings).toMatchObject({ passivePortMin: 50000, tls: 'required' });
    expect(save.body.data).toMatchObject({ live: true, lastApply: { ok: true } });
    expect(app.agent.callsTo('web.ftp.config.write').pop().args).toMatchObject({ server: 'pure-ftpd', settings: { passivePortMin: 50000, passivePortMax: 50100, tls: 'required', passiveAddress: '203.0.113.5' } });
    expect((await put('/api/service-config/ftp/settings', { passivePortMin: 60000, passivePortMax: 50000 })).status).toBe(422);
    expect((await put('/api/service-config/ftp/settings', { passiveAddress: '1.2.3.4\nx' })).status).toBe(422);
    await app.ctx.ftp.setPassiveAddress({ ipv4: '203.0.113.7' }, null);
    expect(app.agent.callsTo('web.ftp.config.write').pop().args.settings.passiveAddress).toBe('203.0.113.7');
  });

  it('saving daemon settings while FTP is disabled says so (422) instead of claiming nothing is installed', async () => {
    app.agent.set('web.service.detect', ({ role }) => (role === 'ftp' ? { role, candidates: ftpCandidates(null), active: [], enabled: [], current: null, packageManager: 'apt-get' } : { role, candidates: dnsCandidates(), active: ['bind'], enabled: ['bind'], current: 'bind', packageManager: 'apt-get' }));
    app.ctx.settings.set('service_config.ftp_server', 'disabled');
    try {
      const res = await put('/api/service-config/ftp/settings', { maxClients: 20 });
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/FTP is disabled under FTP Server Selection/);
      expect((await get('/api/service-config/ftp')).body.data.settings.maxClients).toBe(20);
    } finally {
      app.ctx.settings.set('service_config.ftp_server', 'pure-ftpd');
      app.agent.set('web.service.detect', ({ role }) => (role === 'ftp' ? { role, candidates: ftpCandidates(), active: ['pure-ftpd'], enabled: ['pure-ftpd'], current: 'pure-ftpd', packageManager: 'apt-get' } : { role, candidates: dnsCandidates(), active: ['bind'], enabled: ['bind'], current: 'bind', packageManager: 'apt-get' }));
      await put('/api/service-config/ftp/settings', { maxClients: 50 }).expect(200);
    }
  });

  it('a daemon that did not come back after the write is not recorded as applied', async () => {
    app.agent.set('web.ftp.config.write', ({ server }) => ({ server, written: ['/etc/pure-ftpd/conf/TLS'], validated: false, reloaded: false, unit: 'pure-ftpd', verb: 'restart', error: 'Job for pure-ftpd.service failed' }));
    try {
      const res = await put('/api/service-config/ftp/settings', { tls: 'optional' }).expect(200);
      expect(res.body.data.live).toBe(false);
      expect(res.body.data.lastApply.ok).toBe(false);
      expect(res.body.data.lastApply.error).toMatch(/rejected the configuration/);
      app.agent.set('web.ftp.config.write', ({ server }) => ({ server, written: ['/etc/pure-ftpd/conf/TLS'], validated: null, reloaded: false, unit: null, error: 'no systemd unit found' }));
      const none = await put('/api/service-config/ftp/settings', { tls: 'required' }).expect(200);
      expect(none.body.data.lastApply).toMatchObject({ ok: false, error: expect.stringMatching(/not restarted/) });
      app.agent.fail('web.ftp.config.write', 'config_invalid', 'pure-ftpd failed to start with the new settings; the previous configuration was restored: exit 1');
      const bad = await put('/api/service-config/ftp/settings', { tls: 'off' });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect((await get('/api/service-config/ftp')).body.data.lastApply).toMatchObject({ ok: false, error: expect.stringMatching(/previous configuration was restored/) });
      // Selecting a daemon whose settings push fails is not "ok" either.
      const sel = await put('/api/service-config/ftp/server', { server: 'vsftpd' }).expect(200);
      expect(sel.body.data.config.error).toMatch(/failed to start/);
      expect((await get('/api/service-config/ftp')).body.data.lastApply.ok).toBe(false);
    } finally {
      app.agent.set('web.ftp.config.write', ({ server, settings }) => ({ server, written: server === 'pure-ftpd' ? ['/etc/pure-ftpd/conf/PassivePortRange', '/etc/pure-ftpd/conf/TLS'] : ['/etc/vsftpd.conf'], validated: null, settings, reloaded: true, unit: server, verb: 'restart' }));
      await put('/api/service-config/ftp/server', { server: 'pure-ftpd' }).expect(200);
    }
    expect((await get('/api/service-config/ftp')).body.data.lastApply.ok).toBe(true);
  });
});

describe('Nameserver Selection', () => {
  it('reads candidates and switches between bind, powerdns and disabled', async () => {
    const res = await get('/api/service-config/nameserver').expect(200);
    expect(res.body.data).toMatchObject({ settings: { server: 'bind', role: 'master' }, active: 'bind', dnsCategory: true });
    const sel = await put('/api/service-config/nameserver', { server: 'bind', role: 'slave' }).expect(200);
    expect(sel.body.data).toMatchObject({ server: 'bind', role: 'slave' });
    expect(app.ctx.settings.get('service_config.nameserver')).toEqual({ server: 'bind', role: 'slave' });
    const missing = await put('/api/service-config/nameserver', { server: 'powerdns' });
    expect(missing.status).toBe(501);
    expect(missing.body.error.capability).toBe('powerdns');
    expect((await put('/api/service-config/nameserver', { server: 'unbound' })).status).toBe(422);
    expect((await put('/api/service-config/nameserver', { server: 'bind', role: 'root' })).status).toBe(422);
    const off = await put('/api/service-config/nameserver', { server: 'disabled' }).expect(200);
    expect(off.body.data.steps.every((s) => s.action === 'disable --now')).toBe(true);
    await put('/api/service-config/nameserver', { server: 'bind' }).expect(200);
  });
});

describe('Manage Service SSL Certificates', () => {
  it('lists per-service status through ctx.ssl when present', async () => {
    const res = await get('/api/service-config/service-certs').expect(200);
    expect(res.body.data.openssl).toBe(true);
    expect(res.body.data.services.map((s) => s.service)).toEqual(['exim', 'dovecot', 'apache', 'ftp', 'panel']);
    expect(res.body.data.services[0]).toMatchObject({ service: 'exim', label: 'Exim (SMTP)', selfSigned: true });
    expect(res.body.data.hostname).toBe('panel.example.com');
  });

  it('installs a pasted certificate and resets a service to self-signed', async () => {
    const res = await post('/api/service-config/service-certs/dovecot', { certPem: CERT, keyPem: KEY }).expect(200);
    expect(res.body.data).toMatchObject({ service: 'dovecot', reload: { reloaded: true } });
    expect(app.ctx.db.prepare("SELECT service FROM ssl_service_certs WHERE service = 'dovecot'").get()).toBeTruthy();
    expect((await post('/api/service-config/service-certs/dovecot', { certPem: 'nope', keyPem: KEY })).status).toBe(422);
    expect((await post('/api/service-config/service-certs/sshd', { certPem: CERT, keyPem: KEY })).status).toBe(422);
    const reset = await post('/api/service-config/service-certs/exim/self-signed', { days: 90 }).expect(200);
    expect(reset.body.data).toMatchObject({ service: 'exim', selfSigned: true, days: 90 });
    const gen = app.agent.callsTo('ssl.selfsigned.generate').pop().args;
    expect(gen.subject.CN).toBe('panel.example.com');
    expect(gen.days).toBe(90);
    expect(gen.sans).toEqual(['panel.example.com', 'www.panel.example.com', 'mail.example.com']);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'service_ssl.reset_self_signed'").get().n).toBe(1);
    // Mixed-case hostnames are lowercased (the agent only accepts lowercase names) and the mail SAN is the parent domain, never the last two labels.
    app.ctx.settings.set('basic.hostname', 'Panel.Example.CO.uk');
    try {
      await post('/api/service-config/service-certs/exim/self-signed', {}).expect(200);
      const uk = app.agent.callsTo('ssl.selfsigned.generate').pop().args;
      expect(uk.subject.CN).toBe('panel.example.co.uk');
      expect(uk.sans).toEqual(['panel.example.co.uk', 'www.panel.example.co.uk', 'mail.example.co.uk']);
      app.ctx.settings.set('basic.hostname', 'example.com');
      await post('/api/service-config/service-certs/exim/self-signed', {}).expect(200);
      expect(app.agent.callsTo('ssl.selfsigned.generate').pop().args.sans).toEqual(['example.com', 'www.example.com']);
    } finally { app.ctx.settings.set('basic.hostname', 'panel.example.com'); }
  });
});

describe('capability-missing paths (no daemons installed)', () => {
  beforeAll(async () => { app.agent.set('web.detect', detectWith(false)); await provision(false); });
  afterAll(async () => { app.agent.set('web.detect', detectWith(true)); await provision(true); });

  it('GET pages still render with installed:false', async () => {
    expect((await get('/api/service-config/apache').expect(200)).body.data.installed).toBe(false);
    expect((await get('/api/service-config/exim').expect(200)).body.data.installed).toBe(false);
    expect((await get('/api/service-config/mailserver').expect(200)).body.data.installed).toBe(false);
    expect((await get('/api/service-config/logrotate').expect(200)).body.data.installed).toBe(false);
    expect((await get('/api/service-config/ftp').expect(200)).body.data.installed).toBe(false);
    expect((await get('/api/service-config/service-certs').expect(200)).body.data.openssl).toBe(false);
  });

  it('saves settings, then answers 501 capability_missing with the capability name', async () => {
    const checks = [['/api/service-config/apache', { timeout: 60 }, 'apache'], ['/api/service-config/exim', { maxMessageSizeMb: 10 }, 'exim'], ['/api/service-config/mailserver', { maxUserIpConnections: 5 }, 'dovecot'], ['/api/service-config/logrotate', { rotate: 3 }, 'logrotate'], ['/api/service-config/ftp/settings', { maxClients: 5 }, 'ftp']];
    for (const [url, body, cap] of checks) {
      const res = await put(url, body);
      expect(res.status, url).toBe(501);
      expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: cap });
    }
    expect((await get('/api/service-config/apache')).body.data.settings.timeout).toBe(60);
    expect((await get('/api/service-config/exim')).body.data.settings.maxMessageSizeMb).toBe(10);
    expect((await get('/api/service-config/logrotate')).body.data.lastApply).toMatchObject({ ok: false });
    expect((await post('/api/service-config/apache/reload')).status).toBe(501);
    expect((await post('/api/service-config/apache/configtest', {})).status).toBe(501);
    expect((await post('/api/service-config/logrotate/panel/run', {})).status).toBe(501);
    expect((await post('/api/service-config/service-certs/exim/self-signed', {})).status).toBe(501);
  });

  it('ensureVhost stores the spec as pending instead of throwing; live helpers throw CapabilityError', async () => {
    const before = app.ctx.web.vhostFor('example.com').phpVersion;
    expect(before).toBe('8.3');
    const r = await app.ctx.web.ensureVhost('alice', null);
    expect(r).toMatchObject({ username: 'alice', applied: false, reason: 'capability_missing' });
    expect(app.ctx.web.vhostFor('example.com').status).toBe('pending');
    // Nothing is nulled while the daemon is missing.
    expect(app.ctx.web.vhostFor('example.com').phpVersion).toBe(before);
    await expect(app.ctx.web.applySsl('example.com', { cert: '/etc/ssl/whm/example.com/cert.pem', key: '/etc/ssl/whm/example.com/key.pem' }, null)).rejects.toMatchObject({ status: 501, capability: 'apache' });
    await expect(app.ctx.web.setRedirects('example.com', [], null)).rejects.toMatchObject({ status: 501 });
    expect(app.ctx.web.vhostFor('example.com').ssl).toMatchObject({ cert: '/etc/ssl/whm/example.com/cert.pem' });
  });

  it('ensureHostnameVhost stores the server vhost as pending without Apache and still writes the landing page', async () => {
    app.agent.calls.length = 0;
    const r = await app.ctx.web.ensureHostnameVhost(null, { hostname: 'pending.example.com' });
    expect(r).toMatchObject({ hostname: 'pending.example.com', applied: false, reason: 'capability_missing', landingPage: true });
    expect(app.agent.callsTo('web.vhost.write')).toHaveLength(0);
    expect(app.agent.callsTo('fs.write_file').map((c) => c.args.path)).toEqual(['/var/www/whm-default/index.html']);
    expect(app.ctx.web.vhostFor('pending.example.com')).toMatchObject({ type: 'server', status: 'pending', username: 'www-data' });
    // The catch-all is not attempted either; it is recorded as pending for the Apache page.
    expect(r.defaultVhost).toMatchObject({ hostname: 'pending.example.com', applied: false, reason: 'capability_missing' });
    expect(app.agent.callsTo('web.default_vhost.write')).toHaveLength(0);
    expect(await app.ctx.web.removeDefaultVhost(null)).toMatchObject({ removed: false, reason: 'capability_missing' });
    expect(app.ctx.db.prepare("SELECT ok, error FROM service_config_applies WHERE component = 'default_vhost'").get()).toMatchObject({ ok: 0, error: 'Apache is not installed' });
    app.ctx.db.prepare("DELETE FROM web_vhosts WHERE type = 'server'").run();
  });
});

describe('helpers', () => {
  it('phpVersionId normalises package style ids', () => {
    expect(phpVersionId('ea-php83')).toBe('8.3');
    expect(phpVersionId('php74')).toBe('7.4');
    expect(phpVersionId('8.1')).toBe('8.1');
    expect(phpVersionId('system')).toBe('system');
    expect(phpVersionId('php8.3; id')).toBeNull();
    expect(phpVersionId('System')).toBeNull();
    expect(phpVersionId(null)).toBeNull();
  });
});
