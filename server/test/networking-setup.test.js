import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { validateHostname, updateHostsFile, parseHosts, parseResolvConf, renderResolvedDropIn, detectResolverManager, HOSTS_PATH, RESOLVED_DROPIN } from '../src/services/networking-setup.js';
import { CapabilityError } from '../src/lib/errors.js';

const DEBIAN_HOSTS = `127.0.0.1\tlocalhost
127.0.1.1\told.example.com old

# The following lines are desirable for IPv6 capable hosts
::1     ip6-localhost ip6-loopback
fe00::0 ip6-localnet
`;

const CENTOS_HOSTS = `127.0.0.1   localhost localhost.localdomain localhost4 localhost4.localdomain4
::1         localhost localhost.localdomain localhost6 localhost6.localdomain6
`;

describe('hostname helpers', () => {
  it('accepts fully qualified hostnames and normalises them', () => {
    expect(validateHostname('Host.Example.COM.')).toMatchObject({ ok: true, hostname: 'host.example.com', problems: [] });
    expect(validateHostname('srv1.sub.example.co.uk').ok).toBe(true);
  });

  it('rejects bare domains, www, reserved and malformed names', () => {
    const problem = (h) => validateHostname(h).problems.join(' | ');
    expect(problem('example.com')).toMatch(/three labels/);
    expect(problem('www.host.example.com')).toMatch(/www/);
    expect(problem('localhost')).toMatch(/reserved|three labels/);
    expect(problem('host.example.local')).toMatch(/not resolvable/);
    expect(problem('-bad.example.com')).toMatch(/Labels/);
    expect(problem('a.b.10')).toMatch(/IP address/);
    expect(problem('')).toMatch(/required/);
    expect(problem(`${'a'.repeat(64)}.example.com`)).toMatch(/63/);
    expect(problem('localhost.example.com')).toMatch(/short name "localhost" is reserved/);
    expect(problem('ip6-localhost.example.com')).toMatch(/reserved/);
    expect(validateHostname('localhost-1.example.com').ok).toBe(true);
  });

  it('never drops loopback names from /etc/hosts (RHEL layout, previous hostname localhost.localdomain)', () => {
    const r = updateHostsFile(CENTOS_HOSTS, { ip: '10.0.0.5', hostname: 'new.example.com', previous: 'localhost.localdomain' });
    const lines = parseHosts(r.content).filter((l) => l.ip);
    expect(lines.find((l) => l.ip === '127.0.0.1').names).toEqual(['localhost', 'localhost.localdomain', 'localhost4', 'localhost4.localdomain4']);
    expect(lines.find((l) => l.ip === '::1').names).toEqual(['localhost', 'localhost.localdomain', 'localhost6', 'localhost6.localdomain6']);
    expect(lines.find((l) => l.ip === '10.0.0.5').names).toEqual(['new.example.com', 'new']);
  });

  it('never drops loopback names when the previous hostname was "localhost" (Debian/cloud images)', () => {
    const r = updateHostsFile('127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n', { ip: '10.0.0.5', hostname: 'new.example.com', previous: 'localhost' });
    const lines = parseHosts(r.content).filter((l) => l.ip);
    expect(lines.map((l) => [l.ip, l.names])).toEqual([['127.0.0.1', ['localhost']], ['::1', ['localhost', 'ip6-localhost', 'ip6-loopback']], ['10.0.0.5', ['new.example.com', 'new']]]);
  });

  it('keeps localhost even when the new short name would be a reserved name', () => {
    const r = updateHostsFile(CENTOS_HOSTS, { ip: '10.0.0.5', hostname: 'localhost.example.com', previous: 'old.example.com' });
    const lines = parseHosts(r.content).filter((l) => l.ip);
    expect(lines.find((l) => l.ip === '127.0.0.1').names).toEqual(['localhost', 'localhost.localdomain', 'localhost4', 'localhost4.localdomain4']);
    expect(lines.find((l) => l.ip === '::1').names).toContain('localhost');
    expect(lines.find((l) => l.ip === '10.0.0.5').names).toEqual(['localhost.example.com']);
    expect(r.entry.names).toEqual(['localhost.example.com']);
  });

  it('rewrites /etc/hosts: drops the old name, maps the new FQDN and short name to the main IP', () => {
    const r = updateHostsFile(DEBIAN_HOSTS, { ip: '10.0.0.5', hostname: 'new.example.com', previous: 'old.example.com' });
    expect(r.changed).toBe(true);
    expect(r.entry).toEqual({ ip: '10.0.0.5', names: ['new.example.com', 'new'] });
    const lines = parseHosts(r.content).filter((l) => l.ip);
    expect(lines.find((l) => l.ip === '10.0.0.5').names).toEqual(['new.example.com', 'new']);
    expect(lines.find((l) => l.ip === '127.0.1.1')).toBeUndefined();
    expect(lines.find((l) => l.ip === '127.0.0.1').names).toEqual(['localhost']);
    expect(lines.find((l) => l.ip === '::1').names).toEqual(['ip6-localhost', 'ip6-loopback']);
    expect(r.content).toContain('# The following lines are desirable');
    expect(r.content.endsWith('\n')).toBe(true);
    const again = updateHostsFile(r.content, { ip: '10.0.0.5', hostname: 'new.example.com', previous: 'new.example.com' });
    expect(again.changed).toBe(false);
  });

  it('prepends the hostname to an existing line for the IP and keeps other names', () => {
    const r = updateHostsFile('10.0.0.5 db.internal cache\n', { ip: '10.0.0.5', hostname: 'host.example.com' });
    expect(parseHosts(r.content).filter((l) => l.ip)[0].names).toEqual(['host.example.com', 'host', 'db.internal', 'cache']);
    const v6 = updateHostsFile('', { ip: '10.0.0.5', ipv6: '2001:db8::5', hostname: 'host.example.com' });
    expect(parseHosts(v6.content).filter((l) => l.ip).map((l) => l.ip)).toEqual(['10.0.0.5', '2001:db8::5']);
  });

  it('parses resolv.conf and detects who manages it', () => {
    const parsed = parseResolvConf('# generated\nsearch example.com corp\nnameserver 8.8.8.8\nnameserver 8.8.4.4 # google\noptions timeout:2 attempts:3\n');
    expect(parsed).toMatchObject({ nameservers: ['8.8.8.8', '8.8.4.4'], search: ['example.com', 'corp'], options: ['timeout:2', 'attempts:3'], managedBy: 'file' });
    expect(detectResolverManager('# This is /run/systemd/resolve/stub-resolv.conf\nnameserver 127.0.0.53\n')).toBe('systemd-resolved');
    expect(parseResolvConf('nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n')).toMatchObject({ nameservers: ['127.0.0.53'], search: [], options: ['edns0', 'trust-ad'] });
    expect(parseResolvConf('search . example.com\n').search).toEqual(['example.com']);
    expect(detectResolverManager('# Generated by NetworkManager\nnameserver 1.1.1.1\n')).toBe('networkmanager');
    expect(detectResolverManager('# Managed by WHM panel (Resolver Configuration)\nnameserver 1.1.1.1\n')).toBe('whm');
    expect(renderResolvedDropIn({ nameservers: ['1.1.1.1', '1.0.0.1'], search: ['example.com'] })).toBe('# Managed by WHM panel (Resolver Configuration); edit there, not here.\n[Resolve]\nDNS=1.1.1.1 1.0.0.1\nDomains=example.com\n');
  });
});

describe('Networking Setup API', () => {
  let app;
  let csrf;
  let reseller;
  let resellerCsrf;
  let hostnamectl = true;
  let hostname = 'old.example.com';
  let files = {};
  let resolvConf = 'nameserver 8.8.8.8\nnameserver 8.8.4.4\noptions timeout:2\n';
  let resolverAnswers = {};
  let restarted = [];
  let resolvedActive = false;
  let resolvFile = { exists: true, isSymlink: false, isRegular: true, target: null, managedByResolved: false };
  const STUB = '/run/systemd/resolve/stub-resolv.conf';
  const renderResolv = (nameservers, search) => ['# Managed by WHM panel (Resolver Configuration)', ...(search.length ? [`search ${search.join(' ')}`] : []), ...nameservers.map((n) => `nameserver ${n}`)].join('\n') + '\n';

  const post = (url, body = {}) => app.http.post(url).set('X-CSRF-Token', csrf).send(body);
  const put = (url, body) => app.http.put(url).set('X-CSRF-Token', csrf).send(body);
  const get = (url) => app.http.get(url);
  const auditRows = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
  const agentFail = (code, message) => Object.assign(new Error(message), { agentError: true, code, details: {} });

  beforeAll(async () => {
    const agent = createMockAgent({
      'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, n === 'systemctl' || (hostnamectl && n === 'hostnamectl')])),
      'sys.info': () => ({ hostname, interfaces: [{ name: 'lo', addresses: [{ address: '127.0.0.1', family: 'IPv4' }] }, { name: 'eth0', addresses: [{ address: '10.0.0.5', family: 'IPv4', netmask: '255.255.255.0' }] }], os: {}, memory: {}, cpu: {}, disks: [], loadAverage: [0, 0, 0], uptimeSeconds: 1 }),
      'sys.hostname.set': ({ hostname: h }) => { hostname = h; return { hostname: h }; },
      'fs.read_file': ({ path }) => { if (!(path in files)) throw agentFail('op_failed', `ENOENT: no such file or directory, stat '${path}'`); return { path, content: files[path], size: files[path].length }; },
      'fs.write_file': ({ path, content }) => { files[path] = content; return { path, bytes: content.length }; },
      'sys.resolvers.get': () => ({ nameservers: parseResolvConf(resolvConf).nameservers, raw: resolvConf }),
      'resolver.inspect': () => ({ path: '/etc/resolv.conf', ...resolvFile }),
      'resolver.write_static': ({ nameservers, search }) => {
        const replacedSymlink = resolvFile.isSymlink;
        const previousTarget = resolvFile.target;
        resolvConf = renderResolv(nameservers, search);
        resolvFile = { exists: true, isSymlink: false, isRegular: true, target: null, managedByResolved: false };
        return { path: '/etc/resolv.conf', nameservers, search, replacedSymlink, previousTarget, isRegular: true, isSymlink: false };
      },
      'svc.status': ({ unit }) => ({ unit, installed: unit === 'systemd-resolved', active: unit === 'systemd-resolved' && resolvedActive, state: 'active' }),
      'svc.restart': ({ unit }) => { restarted.push(unit); return { unit, verb: 'restart', output: '' }; },
      'dns.resolve': ({ name, servers }) => {
        const key = `${servers?.[0] ?? 'system'}|${name}`;
        const answer = resolverAnswers[key] ?? resolverAnswers[servers?.[0] ?? 'system'];
        if (answer instanceof Error) throw answer;
        return { name, type: 'A', servers: servers ?? ['8.8.8.8'], answers: answer ?? [], error: answer?.length ? null : 'ETIMEOUT' };
      },
    });
    app = await createTestApp({ agent });
    csrf = await app.login();
    const r = await app.createUser('resell1', 'reseller');
    reseller = request.agent(app.ctx.app);
    resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com' }).expect(201);
  }, 30_000);

  afterAll(async () => { await app?.close(); });

  beforeEach(async () => {
    hostnamectl = true;
    hostname = 'old.example.com';
    files = { [HOSTS_PATH]: DEBIAN_HOSTS };
    resolvConf = 'nameserver 8.8.8.8\nnameserver 8.8.4.4\noptions timeout:2\n';
    resolverAnswers = { '8.8.8.8': ['93.184.216.34'], '8.8.4.4': ['93.184.216.34'], '1.1.1.1': ['93.184.216.34'], '1.0.0.1': [], system: ['10.0.0.5'] };
    restarted = [];
    resolvedActive = false;
    resolvFile = { exists: true, isSymlink: false, isRegular: true, target: null, managedByResolved: false };
    app.ctx.settings.setMany({ 'basic.hostname': 'old.example.com', 'basic.main_ip': '10.0.0.5', 'dns.resolvers': [] });
    await app.ctx.capabilities.refresh();
    app.agent.calls.length = 0;
  });

  it('registers the module: service on ctx and capabilities', () => {
    expect(typeof app.ctx.networking.setHostname).toBe('function');
    expect(typeof app.ctx.networking.setResolvers).toBe('function');
    expect(app.ctx.capabilities.snapshot().capabilities.hostnamectl).toMatchObject({ installed: true });
    expect(app.ctx.capabilities.snapshot().capabilities.resolvectl).toMatchObject({ installed: false });
  });

  // -------------------------------------------------------------- hostname
  it('GET /hostname reports the live hostname, panel setting, /etc/hosts entry and DNS status', async () => {
    const { data } = (await get('/api/networking/hostname').expect(200)).body;
    expect(data).toMatchObject({ current: 'old.example.com', configured: 'old.example.com', inSync: true, ip: '10.0.0.5', configuredIp: '10.0.0.5', detectedIp: '10.0.0.5' });
    expect(data.validation.ok).toBe(true);
    expect(data.hosts).toMatchObject({ path: HOSTS_PATH, exists: true, entry: { ip: '127.0.1.1', names: ['old.example.com', 'old'] }, ok: true });
    expect(data.capability).toEqual({ hostnamectl: true, dns: true });
    expect(data.dns).toMatchObject({ available: true });
    expect(data.defaults).toEqual({ updateHosts: true, addDnsRecord: true });
    expect(data.lastChange).toBeNull();
  });

  it('GET /hostname degrades when /etc/hosts is unreadable and sys.info fails', async () => {
    delete files[HOSTS_PATH];
    const { data } = (await get('/api/networking/hostname').expect(200)).body;
    expect(data.hosts).toMatchObject({ exists: false, entry: null, ok: false });
    app.agent.fail('sys.info', 'agent_unavailable', 'agent down');
    const res = await get('/api/networking/hostname').expect(200);
    expect(res.body.data.current).toBeNull();
    expect(res.body.data.validation.ok).toBe(false);
    app.agent.reset('sys.info');
    app.agent.set('sys.info', () => ({ hostname, interfaces: [{ name: 'eth0', addresses: [{ address: '10.0.0.5', family: 'IPv4' }] }] }));
  });

  it('POST /hostname/preview shows the resulting /etc/hosts without touching anything', async () => {
    const { data } = (await post('/api/networking/hostname/preview', { hostname: 'New.Example.COM' }).expect(200)).body;
    expect(data).toMatchObject({ hostname: 'new.example.com', ip: '10.0.0.5', changed: true, previous: 'old.example.com', conflict: null, before: DEBIAN_HOSTS });
    expect(data.after).toContain('10.0.0.5\tnew.example.com new');
    expect(data.after).not.toContain('old.example.com');
    expect(files[HOSTS_PATH]).toBe(DEBIAN_HOSTS);
    expect(app.agent.callsTo('sys.hostname.set')).toHaveLength(0);
    expect(app.agent.callsTo('fs.write_file')).toHaveLength(0);
    const alias = (await post('/api/networking/hostname/preview', { hostname: 'host.alice.com' }).expect(200)).body.data;
    expect(alias.conflict).toBeNull();
  });

  it('POST /hostname/preview rejects a bare domain with field errors', async () => {
    const res = await post('/api/networking/hostname/preview', { hostname: 'example.com' }).expect(422);
    expect(res.body.error.fields.hostname[0]).toMatch(/three labels/);
    await post('/api/networking/hostname/preview', { hostname: 'bad host' }).expect(422);
    await post('/api/networking/hostname/preview', { hostname: 'host.example.com', ip: 'not-an-ip' }).expect(422);
  });

  it('POST /hostname sets the host name, rewrites /etc/hosts, updates the setting, records and audits', async () => {
    app.ctx.settings.set('basic.main_ip', '');
    const res = await post('/api/networking/hostname', { hostname: 'new.example.com', addDnsRecord: false }).expect(200);
    const { data } = res.body;
    expect(data).toMatchObject({ ok: true, hostname: 'new.example.com', previous: 'old.example.com', ip: '10.0.0.5', restartHint: ['exim', 'imap', 'httpd'] });
    expect(data.steps.map((s) => [s.step, s.ok])).toEqual([['hostname', true], ['hosts', true], ['settings', true], ['certs', true]]);
    expect(data.steps.find((s) => s.step === 'certs')).toMatchObject({ reissued: [], manual: [], failed: [] });
    expect(app.agent.callsTo('sys.hostname.set')[0].args).toEqual({ hostname: 'new.example.com' });
    const write = app.agent.callsTo('fs.write_file')[0];
    expect(write.args).toMatchObject({ path: HOSTS_PATH, backup: true, mode: '0644', owner: 'root' });
    expect(write.args.content).toContain('10.0.0.5\tnew.example.com new');
    expect(write.args.content).not.toContain('old.example.com');
    expect(write.args.content).toContain('127.0.0.1\tlocalhost');
    expect(hostname).toBe('new.example.com');
    expect(app.ctx.settings.get('basic.hostname')).toBe('new.example.com');
    const audit = auditRows('networking.hostname.set');
    expect(audit).toHaveLength(1);
    expect(audit[0].target).toBe('new.example.com');
    expect(JSON.parse(audit[0].args_redacted)).toMatchObject({ previous: 'old.example.com', ip: '10.0.0.5', updateHosts: true, addDnsRecord: false, reissueSelfSigned: true });
    const history = (await get('/api/networking/history?kind=hostname').expect(200)).body.data;
    expect(history[0]).toMatchObject({ kind: 'hostname', principal: 'root', before: { hostname: 'old.example.com' }, after: { hostname: 'new.example.com', ip: '10.0.0.5' } });
    const status = (await get('/api/networking/hostname').expect(200)).body.data;
    expect(status).toMatchObject({ current: 'new.example.com', configured: 'new.example.com', inSync: true });
    expect(status.hosts.entry).toEqual({ ip: '10.0.0.5', names: ['new.example.com', 'new'] });
    expect(status.lastChange.after.hostname).toBe('new.example.com');
  });

  it('POST /hostname honours an explicit IP, skips /etc/hosts on request and keeps going when the hosts write fails', async () => {
    const skip = (await post('/api/networking/hostname', { hostname: 'a.example.com', ip: '192.0.2.9', updateHosts: false }).expect(200)).body.data;
    expect(skip.ip).toBe('192.0.2.9');
    expect(skip.steps.find((s) => s.step === 'hosts')).toMatchObject({ ok: true, skipped: true });
    expect(app.agent.callsTo('fs.write_file')).toHaveLength(0);
    app.agent.fail('fs.write_file', 'path_not_allowed', 'nope');
    const failed = (await post('/api/networking/hostname', { hostname: 'b.example.com' }).expect(200)).body.data;
    expect(failed.ok).toBe(false);
    expect(failed.steps.find((s) => s.step === 'hosts')).toMatchObject({ ok: false, code: 'path_not_allowed' });
    expect(app.ctx.settings.get('basic.hostname')).toBe('b.example.com');
    app.agent.set('fs.write_file', ({ path, content }) => { files[path] = content; return { path, bytes: content.length }; });
  });

  it('POST /hostname re-issues self-signed service certificates that name the old host and reports CA-issued ones', async () => {
    const cert = (cn, sans, selfSigned) => ({ hasCertificate: true, certificate: { commonName: cn, sans, selfSigned } });
    const listed = { services: [
      { service: 'exim', ...cert('old.example.com', ['old.example.com', 'mail.example.com'], true) },
      { service: 'dovecot', ...cert('old.example.com', ['old.example.com'], false) },
      { service: 'apache', ...cert('f.example.com', ['f.example.com'], true) },
      { service: 'ftp', hasCertificate: false, certificate: null },
      { service: 'panel', ...cert('panel', ['old.example.com', 'f.example.com'], true) },
    ] };
    const resets = [];
    const original = app.ctx.web.certs;
    app.ctx.web.certs = { list: async () => listed, reset: async (service, opts, req) => { resets.push({ service, hasReq: Boolean(req) }); return { service, selfSigned: true }; } };
    try {
      const { data } = (await post('/api/networking/hostname', { hostname: 'f.example.com' }).expect(200)).body;
      expect(data.ok).toBe(true);
      const certs = data.steps.find((s) => s.step === 'certs');
      expect(certs).toMatchObject({ ok: true, reissued: ['exim'], manual: ['dovecot'], failed: [] });
      expect(certs.detail).toMatch(/re-issued self-signed certificate for exim/);
      expect(certs.detail).toMatch(/dovecot: certificate names another host/);
      expect(resets).toEqual([{ service: 'exim', hasReq: true }]);

      resets.length = 0;
      const off = (await post('/api/networking/hostname', { hostname: 'g.example.com', reissueServiceCerts: false }).expect(200)).body.data;
      expect(off.steps.find((s) => s.step === 'certs')).toMatchObject({ ok: true, reissued: [], manual: ['exim', 'dovecot', 'apache', 'panel'] });
      expect(resets).toEqual([]);

      app.ctx.web.certs = { list: async () => listed, reset: async () => { throw new CapabilityError('ssl', 'openssl is not installed'); } };
      const failed = (await post('/api/networking/hostname', { hostname: 'h.example.com' }).expect(200)).body.data;
      expect(failed.ok).toBe(false);
      expect(failed.steps.find((s) => s.step === 'certs')).toMatchObject({ ok: false, code: 'capability_missing', capability: 'ssl', reissued: [], manual: ['dovecot'] });
      expect(failed.steps.find((s) => s.step === 'certs').failed.map((f) => f.service)).toEqual(['exim', 'apache', 'panel']);
      expect(hostname).toBe('h.example.com');
    } finally { app.ctx.web.certs = original; }
    app.ctx.web = Object.assign({}, app.ctx.web, { certs: undefined });
    try {
      const { data } = (await post('/api/networking/hostname', { hostname: 'i.example.com' }).expect(200)).body;
      expect(data.steps.find((s) => s.step === 'certs')).toMatchObject({ ok: true, skipped: true });
    } finally { app.ctx.web = Object.assign(app.ctx.web, { certs: original }); }
  });

  it('POST /hostname adds the A record through DNS Functions (zone created, publish pending without BIND)', async () => {
    const { data } = (await post('/api/networking/hostname', { hostname: 'c.example.com', addDnsRecord: true }).expect(200)).body;
    expect(data.ok).toBe(true);
    expect(data.steps.find((s) => s.step === 'dns')).toMatchObject({ ok: true, zone: 'example.com', createdZone: 'example.com' });
    const zone = app.ctx.db.prepare('SELECT id FROM dns_zones WHERE domain = ?').get('example.com');
    expect(zone).toBeTruthy();
    expect(app.ctx.db.prepare("SELECT value FROM dns_records WHERE zone_id = ? AND name = 'c' AND type = 'A'").get(zone.id)).toEqual({ value: '10.0.0.5' });
    expect(auditRows('dns.hostname.a')).toHaveLength(1);
  });

  it('POST /hostname reports a DNS failure (missing BIND) as a failed step while the hostname is still changed', async () => {
    const original = app.ctx.dns.ensureHostnameA;
    const calls = [];
    app.ctx.dns.ensureHostnameA = async (input, user, req) => { calls.push({ input, user: user?.username, hasReq: Boolean(req) }); throw new CapabilityError('bind', 'BIND (named) is not installed'); };
    try {
      const { data } = (await post('/api/networking/hostname', { hostname: 'd.example.com', addDnsRecord: true }).expect(200)).body;
      expect(data.ok).toBe(false);
      expect(data.steps.find((s) => s.step === 'dns')).toMatchObject({ ok: false, code: 'capability_missing', capability: 'bind' });
      expect(data.steps.find((s) => s.step === 'hostname').ok).toBe(true);
      expect(hostname).toBe('d.example.com');
      expect(calls).toEqual([{ input: { ip: '10.0.0.5' }, user: 'root', hasReq: true }]);
    } finally { app.ctx.dns.ensureHostnameA = original; }
    app.ctx.dns = Object.assign({}, app.ctx.dns, { ensureHostnameA: undefined });
    try {
      const { data } = (await post('/api/networking/hostname', { hostname: 'e.example.com', addDnsRecord: true }).expect(200)).body;
      expect(data.steps.find((s) => s.step === 'dns')).toMatchObject({ ok: false, skipped: true });
    } finally { app.ctx.dns = Object.assign(app.ctx.dns, { ensureHostnameA: original }); }
  });

  it('POST /hostname validates: 422 for bad names/unknown fields, 409 for a hosted domain', async () => {
    for (const body of [{ hostname: 'example.com' }, { hostname: 'www.host.example.com' }, { hostname: 'localhost' }, { hostname: 'localhost.example.com' }, { hostname: 'host.example.com', bogus: true }, { hostname: 'host.example.com', ip: '1.2.3' }, { hostname: 'host.example.com', reissueServiceCerts: 'yes' }, {}]) {
      const res = await post('/api/networking/hostname', body).expect(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
    app.ctx.db.prepare("INSERT INTO account_domains (account_id, domain, type) VALUES ((SELECT id FROM accounts WHERE username = 'alice'), 'host.alice.com', 'sub')").run();
    const conflict = await post('/api/networking/hostname', { hostname: 'host.alice.com' }).expect(409);
    expect(conflict.body.error.message).toMatch(/alice/);
    expect(app.agent.callsTo('sys.hostname.set')).toHaveLength(0);
    expect(hostname).toBe('old.example.com');
  });

  it('POST /hostname answers 501 when hostnamectl is missing and changes nothing', async () => {
    hostnamectl = false;
    await app.ctx.capabilities.refresh();
    const res = await post('/api/networking/hostname', { hostname: 'new.example.com' }).expect(501);
    expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'hostnamectl' });
    expect(app.agent.callsTo('sys.hostname.set')).toHaveLength(0);
    expect(app.ctx.settings.get('basic.hostname')).toBe('old.example.com');
    await expect(app.ctx.networking.setHostname({ hostname: 'x.example.com' }, null)).rejects.toBeInstanceOf(CapabilityError);
    const status = (await get('/api/networking/hostname').expect(200)).body.data;
    expect(status.capability.hostnamectl).toBe(false);
  });

  // ------------------------------------------------------------- resolvers
  it('GET /resolvers parses resolv.conf and reports the write target', async () => {
    const { data } = (await get('/api/networking/resolvers').expect(200)).body;
    expect(data).toMatchObject({ path: '/etc/resolv.conf', nameservers: ['8.8.8.8', '8.8.4.4'], search: [], options: ['timeout:2'], managedBy: 'file', target: 'file', writePath: '/etc/resolv.conf', resolved: { installed: true, active: false }, dropIn: null, file: { isSymlink: false, isRegular: true }, takeOverAllowed: true });
    expect(data.panel).toEqual({ resolvers: [], search: [] });
    expect(data.presets.map((p) => p.nameservers[0])).toEqual(['1.1.1.1', '8.8.8.8', '9.9.9.9', '127.0.0.1']);
    expect(data.max).toBe(4);
  });

  it('PUT /resolvers writes /etc/resolv.conf, syncs the panel resolvers, tests, records and audits', async () => {
    const res = await put('/api/networking/resolvers', { nameservers: ['1.1.1.1', '1.0.0.1'], search: ['Example.com'] }).expect(200);
    const { data } = res.body;
    expect(data).toMatchObject({ target: 'file', path: '/etc/resolv.conf', nameservers: ['1.1.1.1', '1.0.0.1'], search: ['example.com'], restarted: null, applied: true, replacedSymlink: false, appliedToDns: true, notes: [], managedBy: 'whm' });
    expect(app.agent.callsTo('resolver.write_static')[0].args).toEqual({ nameservers: ['1.1.1.1', '1.0.0.1'], search: ['example.com'] });
    expect(app.agent.callsTo('sys.resolvers.set')).toHaveLength(0);
    expect(resolvConf).toContain('nameserver 1.1.1.1');
    expect(app.ctx.settings.get('dns.resolvers')).toEqual(['1.1.1.1', '1.0.0.1']);
    expect(app.ctx.settings.get('networking.resolvers.search')).toEqual(['example.com']);
    expect(data.test.servers.map((s) => [s.server, s.ok])).toEqual([['1.1.1.1', true], ['1.0.0.1', false]]);
    expect(data.test.healthy).toBe(1);
    const audit = auditRows('networking.resolvers.set');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].args_redacted)).toMatchObject({ nameservers: ['1.1.1.1', '1.0.0.1'], target: 'file', applied: true });
    const history = (await get('/api/networking/history?kind=resolvers').expect(200)).body.data;
    expect(history[0]).toMatchObject({ kind: 'resolvers', before: { nameservers: ['8.8.8.8', '8.8.4.4'] }, after: { nameservers: ['1.1.1.1', '1.0.0.1'], search: ['example.com'] }, detail: 'file' });
    const status = (await get('/api/networking/resolvers').expect(200)).body.data;
    expect(status.nameservers).toEqual(['1.1.1.1', '1.0.0.1']);
    expect(status.search).toEqual(['example.com']);
    expect(status.panel.resolvers).toEqual(['1.1.1.1', '1.0.0.1']);
    expect(status.lastChange.after.nameservers).toEqual(['1.1.1.1', '1.0.0.1']);
  });

  it('PUT /resolvers can leave the panel resolver setting alone and skip the test', async () => {
    const { data } = (await put('/api/networking/resolvers', { nameservers: ['9.9.9.9'], applyToDns: false, test: false }).expect(200)).body;
    expect(data.test).toBeUndefined();
    expect(data.appliedToDns).toBe(false);
    expect(app.ctx.settings.get('dns.resolvers')).toEqual([]);
    expect(app.agent.callsTo('dns.resolve')).toHaveLength(0);
  });

  it('PUT /resolvers on a systemd-resolved host writes the drop-in and restarts the service', async () => {
    resolvConf = '# This is /run/systemd/resolve/stub-resolv.conf\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n';
    resolvedActive = true;
    resolvFile = { exists: true, isSymlink: true, isRegular: false, target: STUB, managedByResolved: true };
    const before = (await get('/api/networking/resolvers').expect(200)).body.data;
    expect(before).toMatchObject({ managedBy: 'systemd-resolved', target: 'resolved', writePath: RESOLVED_DROPIN, resolved: { active: true }, search: [], file: { isSymlink: true, target: STUB }, takeOverAllowed: false });
    const { data } = (await put('/api/networking/resolvers', { nameservers: ['1.1.1.1', '2606:4700:4700::1111'], test: false }).expect(200)).body;
    expect(data).toMatchObject({ target: 'resolved', path: RESOLVED_DROPIN, restarted: true, applied: null });
    expect(files[RESOLVED_DROPIN]).toBe('# Managed by WHM panel (Resolver Configuration); edit there, not here.\n[Resolve]\nDNS=1.1.1.1 2606:4700:4700::1111\n');
    expect(restarted).toEqual(['systemd-resolved']);
    expect(app.agent.callsTo('sys.resolvers.set')).toHaveLength(0);
    const after = (await get('/api/networking/resolvers').expect(200)).body.data;
    expect(after.dropIn).toEqual({ path: RESOLVED_DROPIN, content: files[RESOLVED_DROPIN] });

    app.agent.fail('svc.restart', 'command_failed', 'unit failed');
    const partial = (await put('/api/networking/resolvers', { nameservers: ['9.9.9.9'], test: false }).expect(200)).body.data;
    expect(partial.restarted).toBe(false);
    expect(partial.notes[0]).toMatch(/systemctl restart systemd-resolved/);
    app.agent.set('svc.restart', ({ unit }) => { restarted.push(unit); return { unit, verb: 'restart', output: '' }; });

    expect((await get('/api/networking/history?kind=resolvers').expect(200)).body.data[0].before).toEqual({ nameservers: ['127.0.0.53'], search: [] });
  });

  it('PUT /resolvers mode=file refuses while systemd-resolved runs, then replaces the stub symlink once it is stopped', async () => {
    resolvConf = '# This is /run/systemd/resolve/stub-resolv.conf\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n';
    resolvedActive = true;
    resolvFile = { exists: true, isSymlink: true, isRegular: false, target: STUB, managedByResolved: true };
    const refused = await put('/api/networking/resolvers', { nameservers: ['9.9.9.9'], mode: 'file', test: false }).expect(422);
    expect(refused.body.error.message).toMatch(/systemctl disable --now systemd-resolved/);
    expect(refused.body.error.fields.mode[0]).toMatch(/stopped/);
    expect(app.agent.callsTo('resolver.write_static')).toHaveLength(0);
    expect(app.agent.callsTo('fs.write_file')).toHaveLength(0);
    expect(resolvFile.isSymlink).toBe(true);

    // The unit is stopped but the package's symlink is still in place: the file contents alone do not reveal that.
    resolvedActive = false;
    resolvConf = 'nameserver 127.0.0.53\n';
    const status = (await get('/api/networking/resolvers').expect(200)).body.data;
    expect(status).toMatchObject({ managedBy: 'systemd-resolved', takeOverAllowed: true, file: { isSymlink: true } });
    const takeover = (await put('/api/networking/resolvers', { nameservers: ['9.9.9.9'], search: ['.', 'example.com'].filter((s) => s !== '.'), mode: 'file', test: false }).expect(200)).body.data;
    expect(takeover).toMatchObject({ target: 'file', path: '/etc/resolv.conf', applied: true, replacedSymlink: true, managedBy: 'whm', file: { isSymlink: false, isRegular: true } });
    expect(takeover.notes[0]).toMatch(new RegExp(`symlink to ${STUB}`));
    expect(takeover.notes[1]).toMatch(/keep it disabled/);
    expect(app.agent.callsTo('resolver.write_static')[0].args).toEqual({ nameservers: ['9.9.9.9'], search: ['example.com'] });
    expect(app.agent.callsTo('sys.resolvers.set')).toHaveLength(0);
    expect(resolvFile.isSymlink).toBe(false);
    expect(resolvConf).toBe('# Managed by WHM panel (Resolver Configuration)\nsearch example.com\nnameserver 9.9.9.9\n');
    expect(JSON.parse(auditRows('networking.resolvers.set').at(-1).args_redacted)).toMatchObject({ target: 'file', applied: true, replacedSymlink: true });

    // A write that leaves a symlink behind (e.g. the op was answered by an older agent) is not reported as applied.
    app.agent.set('resolver.write_static', ({ nameservers, search }) => { resolvConf = renderResolv(nameservers, search); resolvFile = { exists: true, isSymlink: true, isRegular: false, target: STUB, managedByResolved: true }; return { nameservers, search, replacedSymlink: false, isRegular: false, isSymlink: true }; });
    const stale = (await put('/api/networking/resolvers', { nameservers: ['1.1.1.1'], mode: 'file', test: false }).expect(200)).body.data;
    expect(stale.applied).toBe(false);
    expect(stale.notes.at(-1)).toMatch(/still a symlink/);
  });

  it('PUT /resolvers validates: bad IPs, too many, duplicates, bad search domains, unknown fields', async () => {
    for (const body of [
      { nameservers: [] }, { nameservers: ['not-an-ip'] }, { nameservers: ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5'] },
      { nameservers: ['1.1.1.1', '1.1.1.1'] }, { nameservers: ['0.0.0.0'] }, { nameservers: ['1.1.1.1'], search: ['bad domain'] },
      { nameservers: ['1.1.1.1'], mode: 'magic' }, { nameservers: ['1.1.1.1'], extra: 1 }, {},
    ]) {
      const res = await put('/api/networking/resolvers', body).expect(422);
      expect(res.body.error.code, JSON.stringify(body)).toMatch(/validation_failed/);
    }
    expect(app.agent.callsTo('resolver.write_static')).toHaveLength(0);
    expect(app.agent.callsTo('fs.write_file')).toHaveLength(0);
  });

  it('POST /resolvers/test resolves each name against each server separately and times it', async () => {
    resolverAnswers['1.0.0.1|example.com'] = ['93.184.216.34'];
    resolverAnswers['1.0.0.1|cpanel.net'] = Object.assign(new Error('timeout'), { agentError: true, code: 'timeout', details: {} });
    const { data } = (await post('/api/networking/resolvers/test', { nameservers: ['1.1.1.1', '1.0.0.1'], names: ['example.com', 'cpanel.net'] }).expect(200)).body;
    expect(data.names).toEqual(['example.com', 'cpanel.net']);
    expect(data.servers).toHaveLength(2);
    expect(data.servers[0]).toMatchObject({ server: '1.1.1.1', ok: true, reachable: true });
    expect(data.servers[0].lookups.map((l) => l.name)).toEqual(['example.com', 'cpanel.net']);
    expect(typeof data.servers[0].avgMs).toBe('number');
    expect(data.servers[1]).toMatchObject({ server: '1.0.0.1', ok: false, reachable: true });
    expect(data.servers[1].lookups[1]).toMatchObject({ ok: false, error: 'timeout' });
    expect(data.healthy).toBe(1);
    for (const c of app.agent.callsTo('dns.resolve')) expect(c.args.servers).toHaveLength(1);
  });

  it('POST /resolvers/test defaults to the system resolvers and the hostname; 400 when none exist', async () => {
    const { data } = (await post('/api/networking/resolvers/test', {}).expect(200)).body;
    expect(data.servers.map((s) => s.server)).toEqual(['8.8.8.8', '8.8.4.4']);
    expect(data.names).toEqual(['old.example.com', 'example.com', 'cpanel.net']);
    await post('/api/networking/resolvers/test', { names: [] }).expect(422);
    resolvConf = '# empty\n';
    await post('/api/networking/resolvers/test', {}).expect(400);
  });

  it('GET /history filters by kind and validates the query', async () => {
    const all = (await get('/api/networking/history').expect(200)).body.data;
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((c) => c.kind))).toEqual(new Set(['hostname', 'resolvers']));
    await get('/api/networking/history?kind=other').expect(422);
    await get('/api/networking/history?limit=0').expect(422);
  });

  it('refuses resellers on every route', async () => {
    await reseller.get('/api/networking/hostname').expect(403);
    await reseller.post('/api/networking/hostname/preview').set('X-CSRF-Token', resellerCsrf).send({ hostname: 'x.example.com' }).expect(403);
    await reseller.post('/api/networking/hostname').set('X-CSRF-Token', resellerCsrf).send({ hostname: 'x.example.com' }).expect(403);
    await reseller.get('/api/networking/resolvers').expect(403);
    await reseller.put('/api/networking/resolvers').set('X-CSRF-Token', resellerCsrf).send({ nameservers: ['1.1.1.1'] }).expect(403);
    await reseller.post('/api/networking/resolvers/test').set('X-CSRF-Token', resellerCsrf).send({}).expect(403);
    await reseller.get('/api/networking/history').expect(403);
    expect(app.agent.callsTo('sys.hostname.set')).toHaveLength(0);
    expect(app.agent.callsTo('resolver.write_static')).toHaveLength(0);
  });
});
