import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { compareVersions, pickBasic, BASIC_DIRECTIVES, EA4_CATALOG } from '../src/services/software.js';

const BIN_FULL = { 'apt-get': true, 'dpkg-query': true, php: true, 'php-fpm': true, nginx: true, perl: true, cpan: true, gem: true, pip3: true, apache2ctl: true, systemctl: true };
const PHP = { id: '8.3', label: 'PHP 8.3', binary: '/usr/bin/php8.3', layout: 'debian', version: '8.3.6', iniPath: '/etc/php/8.3/fpm/php.ini', iniPaths: { fpm: '/etc/php/8.3/fpm/php.ini', cli: '/etc/php/8.3/cli/php.ini' }, poolDir: '/etc/php/8.3/fpm/pool.d', fpmUnit: 'php8.3-fpm', isDefault: true, fpmActive: true, fpmInstalled: true };
const PHP82 = { ...PHP, id: '8.2', label: 'PHP 8.2', binary: '/usr/bin/php8.2', version: '8.2.20', iniPath: '/etc/php/8.2/fpm/php.ini', fpmUnit: 'php8.2-fpm', isDefault: false, fpmActive: false };
const INI = '[PHP]\nmemory_limit = 128M\nupload_max_filesize = 2M\n;display_errors = On\n';
let installedPkgs = [{ name: 'apache2', version: '2.4.58', arch: 'amd64', summary: 'Apache HTTP Server' }, { name: 'php-fpm', version: '8.3', arch: 'all', summary: 'FPM' }, { name: 'curl', version: '8.5.0', arch: 'amd64', summary: 'cli' }, { name: 'libapache2-mod-evasive', version: '1.1', arch: 'amd64', summary: 'evasive' }];
let nginxState = { installed: true, active: true, proxyConfigured: false, content: null };
let rpmPresent = false;

let app;
let csrf;
let reseller;
let resellerCsrf;
let updateServer;
let updateUrl;
const mutate = (client, method, url, body, token) => client[method](url).set('X-CSRF-Token', token).send(body);
const put = (url, body) => mutate(app.http, 'put', url, body, csrf);
const post = (url, body = {}) => mutate(app.http, 'post', url, body, csrf);
const del = (url) => mutate(app.http, 'delete', url, undefined, csrf);
const get = (url) => app.http.get(url);

async function provision(installed, extra = {}) {
  app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, installed ? Boolean({ ...BIN_FULL, ...extra }[n]) : Boolean(extra[n])])));
  await app.ctx.capabilities.refresh();
}

beforeAll(async () => {
  const agent = createMockAgent({
    'pkg.detect': () => ({ manager: 'apt', family: 'debian', binary: 'apt-get', rpm: rpmPresent, rebootRequired: false }),
    'pkg.list_installed': ({ q, prefix }) => {
      let list = installedPkgs;
      if (q) list = list.filter((p) => p.name.includes(q));
      if (prefix) list = list.filter((p) => prefix.some((pre) => p.name === pre || p.name.startsWith(pre)));
      return { manager: 'apt', total: installedPkgs.length, packages: list };
    },
    'pkg.search': ({ q, limit }) => ({ manager: 'apt', q, results: [{ name: q, summary: `the ${q} package`, installed: installedPkgs.some((p) => p.name === q), installedVersion: null }, { name: `lib${q}`, summary: 'library', installed: false, installedVersion: null }].slice(0, limit) }),
    'pkg.info': ({ name }) => ({ manager: 'apt', name, installed: null, candidate: '1.0', summary: 'info', section: 'web', homepage: null, size: null }),
    'pkg.install': ({ packages }) => { installedPkgs = [...installedPkgs, ...packages.filter((p) => !installedPkgs.some((i) => i.name === p)).map((name) => ({ name, version: '1.0', arch: 'amd64', summary: 'installed by test' }))]; return { manager: 'apt', packages, output: [`Setting up ${packages.join(' ')}`] }; },
    'pkg.remove': ({ packages, purge }) => { installedPkgs = installedPkgs.filter((p) => !packages.includes(p.name)); return { manager: 'apt', packages, purge, output: [`Removing ${packages.join(' ')}`] }; },
    'pkg.update_index': () => ({ manager: 'apt', output: ['Hit:1 http://archive.ubuntu.com noble InRelease'] }),
    'pkg.upgradable': () => ({ manager: 'apt', count: 2, security: 1, packages: [{ name: 'libssl3', current: '3.0.1', candidate: '3.0.2', repo: 'noble-security', security: true }, { name: 'vim', current: '9.0', candidate: '9.1', repo: 'noble-updates', security: false }], rebootRequired: false }),
    'pkg.upgrade': ({ dist, autoremove, packages }) => ({ manager: 'apt', output: [`upgraded ${packages ? packages.join(' ') : 'all'} dist=${dist}`], autoremoveOutput: autoremove ? ['autoremove done'] : [], rebootRequired: true }),
    'pkg.rebuild_rpmdb': () => ({ rebuilt: true, packagesBefore: 400, packagesAfter: 400, output: ['rebuilt'] }),
    'pkg.remove_simulate': ({ packages }) => { const present = packages.filter((p) => installedPkgs.some((i) => i.name === p)); const collateral = present.includes('apache2-utils') ? [{ name: 'apache2', version: '2.4.58', section: 'dependent' }] : []; return { manager: 'apt', requested: packages, present, remove: [...present, ...collateral.map((c) => c.name)], collateral, output: [] }; },
    'pkg.reboot_required': () => ({ rebootRequired: false }),
    'pkg.rpm_count': () => ({ packages: 401 }),
    'pkg.module.detect': () => ({ present: { perl: true, cpan: true, cpanm: false, php: true, pecl: false, pear: false, ruby: true, gem: true, python3: true, pip3: true, pip: false }, versions: { perl: '5.38', php: '8.3.6', ruby: '3.3', python3: '3.12' }, perl: 'cpan', pip: 'pip3' }),
    'pkg.perl.list': () => ({ modules: [{ name: 'DBI', version: '1.643' }] }),
    'pkg.perl.install': ({ modules }) => ({ installer: 'cpan', modules, output: [`installed ${modules.join(' ')}`] }),
    'pkg.gem.list': () => ({ gems: [{ name: 'rake', version: '13.1.0', versions: ['13.1.0'] }] }),
    'pkg.gem.install': ({ gem, version }) => ({ installer: 'gem', gem, version: version ?? null, output: [`Successfully installed ${gem}`] }),
    'pkg.pip.list': () => ({ packages: [{ name: 'requests', version: '2.32.0' }] }),
    'pkg.pip.install': ({ package: name }) => ({ installer: 'pip3', package: name, output: [`Successfully installed ${name}`] }),
    'pkg.pecl.list': () => ({ extensions: [] }),
    'pkg.pecl.install': ({ extension }) => ({ installer: 'pecl', extension, output: ['Build complete.'], iniHint: `extension=${extension}.so` }),
    'pkg.php.versions': () => ({ versions: [PHP, PHP82], defaultId: '8.3', defaultBinary: '/usr/bin/php8.3' }),
    'pkg.php.default.set': ({ version }) => ({ version, binary: `/usr/bin/php${version}`, tool: 'update-alternatives' }),
    'pkg.php.ini.read': ({ version, sapi }) => { if (!['8.3', '8.2'].includes(version)) throw Object.assign(new Error(`PHP version "${version}" is not installed on this server`), { agentError: true, code: 'not_found', details: {} }); return { version, path: sapi ? `/etc/php/${version}/${sapi}/php.ini` : `/etc/php/${version}/fpm/php.ini`, sapis: PHP.iniPaths, content: INI, directives: { memory_limit: '128M', upload_max_filesize: '2M' } }; },
    'pkg.php.ini.write': ({ version, directives, content }) => ({ version, path: `/etc/php/${version}/fpm/php.ini`, bytes: 100, directives: { memory_limit: directives?.memory_limit ?? '128M', ...(content ? { from: 'content' } : {}) }, fpmUnit: `php${version}-fpm` }),
    'pkg.php.userini.read': ({ docroot }) => ({ docroot, path: `${docroot}/.user.ini`, exists: false, content: '', directives: {} }),
    'pkg.php.userini.write': ({ docroot, directives, content }) => ({ docroot, path: `${docroot}/.user.ini`, bytes: 10, directives: directives ?? { raw: content } }),
    'pkg.phpfpm.pools': () => ({ pools: [{ version: '8.3', fpmUnit: 'php8.3-fpm', name: 'www', file: '/etc/php/8.3/fpm/pool.d/www.conf', user: 'www-data', listen: '/run/php/php8.3-fpm.sock', pm: 'dynamic', maxChildren: 5 }] }),
    'pkg.nginx.status': ({ includeContent }) => ({ installed: nginxState.installed, version: '1.24.0', active: nginxState.active, configPath: '/etc/nginx/conf.d/whm-proxy.conf', proxyConfigured: nginxState.proxyConfigured, proxy: nginxState.proxyConfigured ? { version: 1, apachePort: 8080, cache: false, domains: 2 } : null, content: includeContent ? nginxState.content : undefined }),
    'pkg.nginx.configtest': () => ({ ok: true, output: 'nginx: configuration file /etc/nginx/nginx.conf test is successful' }),
    'pkg.nginx.proxy.write': ({ domains, apachePort, cache }) => { nginxState.proxyConfigured = true; nginxState.content = `# whm-proxy: version=1 apache_port=${apachePort} cache=${cache ? 'on' : 'off'} domains=${domains.length}`; return { path: '/etc/nginx/conf.d/whm-proxy.conf', bytes: 500, domains: domains.length, sslDomains: domains.filter((d) => d.ssl).length, skipped: 0, configtest: { ok: true, output: 'ok' } }; },
    'pkg.nginx.proxy.remove': () => { const removed = nginxState.proxyConfigured; nginxState.proxyConfigured = false; nginxState.content = null; return { path: '/etc/nginx/conf.d/whm-proxy.conf', removed, configtest: { ok: true, output: 'ok' } }; },
    'svc.reload': ({ unit }) => ({ unit, verb: 'reload', output: '' }),
    'svc.restart': ({ unit }) => ({ unit, verb: 'restart', output: '' }),
    'svc.start': ({ unit }) => ({ unit, verb: 'start', output: '' }),
    'svc.stop': ({ unit }) => ({ unit, verb: 'stop', output: '' }),
    'svc.enable': ({ unit }) => ({ unit, verb: 'enable', output: '' }),
  });
  app = await createTestApp({ agent });
  app.ctx.jobs.start();
  app.ctx.software.runs.pollMs = 10;
  app.ctx.software.runs.maxPollMs = 20;
  csrf = await app.login();
  const r = await app.createUser('resell1', 'reseller');
  reseller = request.agent(app.ctx.app);
  resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
  await post('/api/accounts', { username: 'alice', domain: 'alice.com', owner: 'resell1' }).expect(201);
  await post('/api/accounts', { username: 'bob', domain: 'bob.com' }).expect(201);
  await provision(true);

  updateServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/latest.json') return res.end(JSON.stringify({ tiers: { stable: { version: '9.9.0', url: 'https://example.com/whm-9.9.0.tar.gz', notes: 'Big release' }, edge: { version: '10.0.0-beta.1' } } }));
    if (req.url === '/broken.json') return res.end('{"nope": true}');
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((resolve) => updateServer.listen(0, '127.0.0.1', resolve));
  updateUrl = `http://127.0.0.1:${updateServer.address().port}`;
}, 30_000);

afterAll(async () => { updateServer?.close(); await app?.close(); });

describe('pure helpers', () => {
  it('compareVersions orders semver-ish strings', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('2.0.1', '2.0.0')).toBe(1);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(1);
  });
  it('pickBasic selects the basic directive set', () => {
    const basic = pickBasic({ memory_limit: '1G', unrelated: 'x' });
    expect(basic.memory_limit).toBe('1G');
    expect(basic.unrelated).toBeUndefined();
    expect(Object.keys(basic)).toHaveLength(BASIC_DIRECTIVES.length);
    expect(EA4_CATALOG.debian.Apache).toContain('apache2');
  });
});

describe('module registration and RBAC', () => {
  it('attaches ctx.software with its jobs, schedule and capabilities', () => {
    expect(typeof app.ctx.software.pkg.ensureInstalled).toBe('function');
    expect(typeof app.ctx.software.php.versionForDomain).toBe('function');
    expect(typeof app.ctx.software.nginx.sync).toBe('function');
    for (const t of ['software.pkg.install', 'software.pkg.remove', 'software.system.update', 'software.update.check', 'software.perl.install', 'software.module.install', 'software.nginx.install', 'software.nginx.sync', 'software.rpmdb.rebuild', 'software.php.resync', 'software.php.apply', 'software.ea4.build']) expect(app.ctx.jobs.types()).toContain(t);
    expect(app.ctx.scheduler.list().find((s) => s.name === 'os-update-check')?.cron).toBe('41 5 * * *');
    expect(app.ctx.scheduler.list().find((s) => s.name === 'nginx-proxy-sync')).toMatchObject({ cron: '*/10 * * * *', job_type: 'software.nginx.sync' });
    expect(app.ctx.capabilities.has('pkg')).toBe(true);
    expect(app.ctx.capabilities.has('rpm')).toBe(false);
  });

  it('server-wide functions are root only', async () => {
    for (const url of ['/api/software/pkg/detect', '/api/software/pkg/installed', '/api/software/pkg/search?q=curl', '/api/software/update/status', '/api/software/rpmdb', '/api/software/perl/modules', '/api/software/modules/installers', '/api/software/panel/update', '/api/software/php/pools', '/api/software/php/ini/8.3', '/api/software/nginx', '/api/software/ea4/profiles']) {
      expect((await reseller.get(url)).status, url).toBe(403);
    }
    expect((await mutate(reseller, 'post', '/api/software/pkg/install', { packages: ['nginx'] }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/software/update/run', {}, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/software/php/default', { version: '8.2' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/software/php/ini/8.3', { directives: { memory_limit: '1G' } }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/software/nginx', { enabled: true }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/software/ea4/profiles/1/build', {}, resellerCsrf)).status).toBe(403);
  });

  it('resellers see and change only their own domains', async () => {
    const list = await reseller.get('/api/software/php/domains');
    expect(list.status).toBe(200);
    expect(list.body.data.domains.map((d) => d.domain)).toEqual(['alice.com']);
    expect((await reseller.get('/api/software/php/ini/domain/bob.com')).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/software/php/domains', { domains: ['bob.com'], version: '8.2' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/software/php/ini/domain/bob.com', { directives: { memory_limit: '1G' } }, resellerCsrf)).status).toBe(403);
    expect((await reseller.get('/api/software/php/ini/domain/nobody.example.org')).status).toBe(404);
    const ok = await mutate(reseller, 'put', '/api/software/php/domains', { domains: ['alice.com'], version: '8.2' }, resellerCsrf);
    expect(ok.status).toBe(200);
    expect(ok.body.data.results[0]).toMatchObject({ domain: 'alice.com', phpVersion: '8.2' });
    expect(ok.body.data.results[0].web).toMatch(/^(recorded|applied|failed: )/);
    const ini = await mutate(reseller, 'put', '/api/software/php/ini/domain/alice.com', { directives: { memory_limit: '1G' } }, resellerCsrf);
    expect(ini.status).toBe(200);
    expect(ini.body.data.path).toBe('/home/alice/public_html/.user.ini');
    expect(app.agent.callsTo('pkg.php.userini.write').pop().args).toMatchObject({ docroot: '/home/alice/public_html', owner: 'alice' });
  });
});

describe('validation (422)', () => {
  it('rejects malformed package, module and version names before any agent call', async () => {
    app.agent.calls.length = 0;
    for (const body of [{ packages: ['-r'] }, { packages: ['a;b'] }, { packages: ['../x'] }, { packages: [] }, { packages: 'nginx' }, { packages: ['nginx'], extra: 1 }]) {
      expect((await post('/api/software/pkg/install', body)).status, JSON.stringify(body)).toBe(422);
      expect((await post('/api/software/pkg/remove', body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await get('/api/software/pkg/search?q=a;b')).status).toBe(422);
    expect((await get('/api/software/pkg/search')).status).toBe(422);
    expect((await get('/api/software/pkg/info/-r')).status).toBe(422);
    expect((await post('/api/software/update/run', { packages: ['$(id)'] })).status).toBe(422);
    expect((await put('/api/software/update/auto', { autoApply: 'yes' })).status).toBe(422);
    expect((await post('/api/software/perl/install', { modules: ['Foo::-Bar'] })).status).toBe(422);
    expect((await post('/api/software/perl/install', { modules: [] })).status).toBe(422);
    expect((await post('/api/software/modules/gem/install', { name: 'a b' })).status).toBe(422);
    expect((await post('/api/software/modules/gem/install', { name: 'rails', version: '-1' })).status).toBe(422);
    expect((await post('/api/software/modules/npm/install', { name: 'x' })).status).toBe(422);
    expect((await get('/api/software/modules/npm')).status).toBe(422);
    expect((await put('/api/software/panel/update/settings', { url: 'ftp://x' })).status).toBe(422);
    expect((await put('/api/software/panel/update/settings', { tier: 'nightly' })).status).toBe(422);
    expect((await put('/api/software/php/default', { version: 'PHP 8.3' })).status).toBe(422);
    expect((await put('/api/software/php/domains', { domains: ['bob.com'] })).status).toBe(422);
    expect((await put('/api/software/php/domains', { domains: ['-d'], version: '8.3' })).status).toBe(422);
    expect((await put('/api/software/php/ini/8.3', {})).status).toBe(422);
    expect((await put('/api/software/php/ini/8.3', { directives: { 'memory_limit;x': '1' } })).status).toBe(422);
    expect((await put('/api/software/php/ini/8.3', { directives: { memory_limit: 'a\nb' } })).status).toBe(422);
    expect((await get('/api/software/php/ini/8.3?sapi=cgi')).status).toBe(422);
    expect((await put('/api/software/nginx', { apachePort: 0 })).status).toBe(422);
    expect((await put('/api/software/nginx', { cacheTtl: '10 m' })).status).toBe(422);
    expect((await post('/api/software/nginx/kill')).status).toBe(422);
    expect((await post('/api/software/ea4/profiles', { name: 'x;y', packages: { debian: [], rhel: [] } })).status).toBe(422);
    expect((await post('/api/software/ea4/profiles', { name: 'ok', packages: { debian: ['-r'], rhel: [] } })).status).toBe(422);
    expect((await get('/api/software/ea4/profiles/abc')).status).toBe(422);
    expect(app.agent.calls.filter((c) => c.name.startsWith('pkg.') && !['pkg.detect', 'pkg.php.versions'].includes(c.name))).toHaveLength(0);
  });

  it('refuses a PHP version that is not installed and Apache on port 80 behind the proxy', async () => {
    expect((await put('/api/software/php/default', { version: '7.4' })).status).toBe(422);
    expect((await put('/api/software/php/domains', { domains: ['bob.com'], version: '7.4' })).status).toBe(422);
    expect((await put('/api/software/nginx', { enabled: true, apachePort: 80 })).status).toBe(422);
    expect((await put('/api/software/nginx', { enabled: true, apacheSslPort: 443 })).status).toBe(422);
    expect((await put('/api/software/nginx', { enabled: true, apachePort: 8080, apacheSslPort: 8080 })).status).toBe(422);
    expect((await put('/api/software/nginx', { apacheSslPort: 0 })).status).toBe(422);
  });
});

describe('capability degradation (501)', () => {
  it('reports capability_missing for every daemon-backed function when nothing is installed', async () => {
    await provision(false);
    const checks = [
      ['get', '/api/software/pkg/installed', undefined, 'pkg'], ['get', '/api/software/pkg/search?q=curl', undefined, 'pkg'], ['post', '/api/software/pkg/install', { packages: ['curl'] }, 'pkg'],
      ['post', '/api/software/pkg/update-index', {}, 'pkg'], ['get', '/api/software/update/status', undefined, 'pkg'], ['post', '/api/software/update/run', {}, 'pkg'],
      ['post', '/api/software/rpmdb/rebuild', {}, 'rpm'], ['get', '/api/software/perl/modules', undefined, 'perl'], ['post', '/api/software/perl/install', { modules: ['DBI'] }, 'perl'],
      ['get', '/api/software/modules/gem', undefined, 'gem'], ['post', '/api/software/modules/pip/install', { name: 'requests' }, 'pip'],
      ['get', '/api/software/php/versions', undefined, 'php'], ['put', '/api/software/php/default', { version: '8.3' }, 'php'], ['get', '/api/software/php/ini/8.3', undefined, 'php'], ['get', '/api/software/php/pools', undefined, 'php'],
      ['put', '/api/software/nginx', { enabled: true }, 'nginx'], ['post', '/api/software/nginx/sync', {}, 'nginx'], ['post', '/api/software/nginx/configtest', {}, 'nginx'], ['post', '/api/software/nginx/reload', {}, 'nginx'],
      ['get', '/api/software/ea4/installed', undefined, 'pkg'], ['get', '/api/software/ea4/profiles/1/diff', undefined, 'pkg'], ['post', '/api/software/ea4/profiles/1/build', {}, 'pkg'],
    ];
    for (const [method, url, body, cap] of checks) {
      const res = method === 'get' ? await get(url) : await mutate(app.http, method, url, body, csrf);
      expect(res.status, url).toBe(501);
      expect(res.body.error.code, url).toBe('capability_missing');
      expect(res.body.error.capability, url).toBe(cap);
    }
    // Status pages never fail; they describe what is missing so the UI can offer the install.
    const detect = await get('/api/software/pkg/detect');
    expect(detect.status).toBe(200);
    expect(detect.body.data.capability).toBe(false);
    const nginx = await get('/api/software/nginx');
    expect(nginx.status).toBe(200);
    expect(nginx.body.data.capability).toBe(false);
    const rpm = await get('/api/software/rpmdb');
    expect(rpm.body.data.supported).toBe(false);
    const installers = await get('/api/software/modules/installers');
    expect(installers.body.data.capabilities.gem).toBe(false);
    const profiles = await get('/api/software/ea4/profiles');
    expect(profiles.status).toBe(200);
    expect(profiles.body.data.family).toBeNull();
    await provision(true);
  });

  it('perl modules also need a CPAN client, and the rpm rebuild works once rpm exists', async () => {
    await provision(true, { cpan: false, cpanm: false });
    const res = await post('/api/software/perl/install', { modules: ['DBI'] });
    expect(res.status).toBe(501);
    expect(res.body.error.capability).toBe('cpan');
    rpmPresent = true;
    await provision(true, { rpm: true });
    expect((await get('/api/software/rpmdb')).body.data.supported).toBe(true);
    const rebuilt = await post('/api/software/rpmdb/rebuild');
    expect(rebuilt.status).toBe(202);
    const job = await waitForJob(app.ctx, rebuilt.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ rebuilt: true, packagesBefore: 400, packagesAfter: 400 });
    expect(app.agent.callsTo('pkg.rebuild_rpmdb').pop().args).toEqual({ wait: false });
    expect((await get('/api/software/rpmdb')).body.data.lastRun.id).toBe(job.id);
    rpmPresent = false;
    await provision(true);
  });
});

describe('Install Distro Packages', () => {
  it('detects, lists, searches and shows package info', async () => {
    const detect = await get('/api/software/pkg/detect');
    expect(detect.body.data).toMatchObject({ manager: 'apt', family: 'debian', capability: true });
    const installed = await get('/api/software/pkg/installed?q=apache&pageSize=10');
    expect(installed.status).toBe(200);
    expect(installed.body.data.map((p) => p.name)).toEqual(['apache2', 'libapache2-mod-evasive']);
    expect(installed.body.meta).toMatchObject({ page: 1, pageSize: 10, total: 2, manager: 'apt' });
    const search = await get('/api/software/pkg/search?q=curl');
    expect(search.body.data.results[0]).toMatchObject({ name: 'curl', installed: true });
    const info = await get('/api/software/pkg/info/curl');
    expect(info.body.data).toMatchObject({ name: 'curl', candidate: '1.0' });
  });

  it('installs, removes and refreshes the index as jobs with a live log', async () => {
    const res = await post('/api/software/pkg/install', { packages: ['imagemagick', 'ghostscript'] });
    expect(res.status).toBe(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result.packages).toEqual(['imagemagick', 'ghostscript']);
    expect(job.logs.some((l) => l.line.includes('Setting up imagemagick'))).toBe(true);
    expect(installedPkgs.some((p) => p.name === 'imagemagick')).toBe(true);
    const rm = await post('/api/software/pkg/remove', { packages: ['ghostscript'], purge: true });
    expect(rm.status).toBe(202);
    expect((await waitForJob(app.ctx, rm.body.data.job.id)).status).toBe('done');
    expect(app.agent.callsTo('pkg.remove').pop().args).toEqual({ packages: ['ghostscript'], purge: true, wait: false });
    const idx = await post('/api/software/pkg/update-index');
    expect(idx.status).toBe(202);
    expect((await waitForJob(app.ctx, idx.body.data.job.id)).status).toBe('done');
    const recent = await get('/api/software/pkg/recent');
    expect(recent.body.data.length).toBeGreaterThanOrEqual(3);
    const audit = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'software.pkg.install'").get().n;
    expect(audit).toBeGreaterThanOrEqual(1);
  });

  it('polls a detached installer run, streams its log and fails the job on a non-zero exit', async () => {
    // A real agent answers wait:false with a run id; the job then polls pkg.run.status.
    const base = { id: 'abc123-0123456789ab', kind: 'install', bin: '/usr/bin/apt-get', pid: 4242, startedAt: new Date().toISOString(), timeoutMs: 60_000, logPath: '/var/lib/whm/pkg-runs/abc123-0123456789ab.log' };
    const polls = [
      { ...base, status: 'running', output: ['Reading package lists...', 'Unpacking ffmpeg'], offset: 40, done: false },
      { ...base, status: 'running', output: [], offset: 40, done: false },
      { ...base, status: 'finished', code: 0, output: ['Setting up ffmpeg'], offset: 60, done: true },
    ];
    app.agent.set('pkg.install', ({ packages }) => ({ manager: 'apt', packages, background: true, run: { ...base, status: 'running' } }));
    app.agent.set('pkg.run.status', ({ id }) => { expect(id).toBe(base.id); return polls.shift(); });
    try {
      const res = await post('/api/software/pkg/install', { packages: ['ffmpeg'] });
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.logs.map((l) => l.line)).toEqual(expect.arrayContaining(['Reading package lists...', 'Unpacking ffmpeg', 'Setting up ffmpeg']));
      expect(job.logs.some((l) => /running detached on the host \(pid 4242/.test(l.line))).toBe(true);
      expect(app.agent.callsTo('pkg.run.status').map((c) => c.args.offset)).toEqual([0, 40, 40]);
      expect(app.agent.callsTo('pkg.install').pop().args).toEqual({ packages: ['ffmpeg'], noRecommends: false, wait: false });

      polls.push({ ...base, status: 'finished', code: 100, output: ['E: Unable to locate package nothing-here'], offset: 50, done: true });
      const failed = await waitForJob(app.ctx, (await post('/api/software/pkg/install', { packages: ['nothing-here'] })).body.data.job.id);
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/exited with status 100: E: Unable to locate package nothing-here/);

      polls.push({ ...base, status: 'lost', error: 'the installer is no longer running but its exit status was not recorded (agent restarted?)', output: [], offset: 0, done: true });
      const lost = await waitForJob(app.ctx, (await post('/api/software/pkg/install', { packages: ['curl'] })).body.data.job.id);
      expect(lost.status).toBe('failed');
      expect(lost.error).toMatch(/exit status was not recorded/);

      polls.push({ ...base, status: 'timeout', error: 'did not finish within 45 minutes and was terminated', output: [], offset: 0, done: true });
      const timedOut = await waitForJob(app.ctx, (await post('/api/software/pkg/install', { packages: ['curl'] })).body.data.job.id);
      expect(timedOut.error).toMatch(/45 minutes/);
    } finally {
      app.agent.set('pkg.install', ({ packages }) => { installedPkgs = [...installedPkgs, ...packages.filter((p) => !installedPkgs.some((i) => i.name === p)).map((name) => ({ name, version: '1.0', arch: 'amd64', summary: 'installed by test' }))]; return { manager: 'apt', packages, output: [`Setting up ${packages.join(' ')}`] }; });
      app.agent.set('pkg.run.status', undefined);
    }
  });

  it('a system update in the background runs autoremove as its own step and asks about the reboot afterwards', async () => {
    const base = { id: 'upg001-0123456789ab', kind: 'upgrade', bin: '/usr/bin/apt-get', pid: 77, startedAt: new Date().toISOString(), timeoutMs: 60_000, logPath: '/var/lib/whm/pkg-runs/upg001-0123456789ab.log' };
    const statuses = [];
    app.agent.set('pkg.upgrade', ({ autoremove }) => { statuses.push({ ...base, status: 'finished', code: 0, output: ['upgraded in background'], offset: 10, done: true }); return { manager: 'apt', background: true, run: { ...base, status: 'running' }, autoremovePending: autoremove }; });
    app.agent.set('pkg.autoremove', () => { statuses.push({ ...base, id: 'arm001-0123456789ab', status: 'finished', code: 0, output: ['autoremoved'], offset: 5, done: true }); return { manager: 'apt', background: true, run: { ...base, id: 'arm001-0123456789ab', status: 'running' } }; });
    app.agent.set('pkg.run.status', () => statuses.shift());
    app.agent.set('pkg.reboot_required', () => ({ rebootRequired: true }));
    try {
      const run = await post('/api/software/update/run', { autoremove: true, refreshIndex: false });
      const job = await waitForJob(app.ctx, run.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ upgraded: 2, rebootRequired: true });
      expect(job.logs.map((l) => l.line)).toEqual(expect.arrayContaining(['upgraded in background', 'autoremoved']));
      expect(app.agent.callsTo('pkg.autoremove')).toHaveLength(1);
      expect(app.agent.callsTo('pkg.reboot_required')).toHaveLength(1);
    } finally {
      app.agent.set('pkg.upgrade', ({ dist, autoremove, packages }) => ({ manager: 'apt', output: [`upgraded ${packages ? packages.join(' ') : 'all'} dist=${dist}`], autoremoveOutput: autoremove ? ['autoremove done'] : [], rebootRequired: true }));
      app.agent.set('pkg.run.status', undefined);
      app.agent.set('pkg.reboot_required', () => ({ rebootRequired: false }));
    }
  });

  it('ensureInstalled only queues what is missing', async () => {
    const r1 = await app.ctx.software.pkg.ensureInstalled(['curl', 'apache2']);
    expect(r1).toEqual({ missing: [], job: null });
    const r2 = await app.ctx.software.pkg.ensureInstalled(['curl', 'bind9'], { user: { id: 1 } });
    expect(r2.missing).toEqual(['bind9']);
    expect((await waitForJob(app.ctx, r2.job.id)).status).toBe('done');
  });
});

describe('System Update', () => {
  it('shows pending updates and runs the upgrade job', async () => {
    const status = await get('/api/software/update/status');
    expect(status.body.data).toMatchObject({ count: 2, security: 1, autoApply: false });
    const run = await post('/api/software/update/run', { autoremove: true });
    expect(run.status).toBe(202);
    const job = await waitForJob(app.ctx, run.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ upgraded: 2, rebootRequired: true });
    expect(job.logs.some((l) => l.line.includes('libssl3') && l.line.includes('[security]'))).toBe(true);
    expect(job.logs.some((l) => l.level === 'warn' && /reboot/i.test(l.line))).toBe(true);
    expect(app.agent.callsTo('pkg.update_index').length).toBeGreaterThanOrEqual(1);
    expect(app.agent.callsTo('pkg.upgrade').pop().args).toMatchObject({ dist: true, autoremove: true });
    const partial = await post('/api/software/update/run', { packages: ['vim'], refreshIndex: false });
    expect((await waitForJob(app.ctx, partial.body.data.job.id)).status).toBe('done');
    expect(app.agent.callsTo('pkg.upgrade').pop().args.packages).toEqual(['vim']);
    expect((await put('/api/software/update/auto', { autoApply: true })).body.data.autoApply).toBe(true);
    expect((await get('/api/software/update/status')).body.data.autoApply).toBe(true);
  });

  it('the nightly check records pending counts and queues the upgrade when auto-apply is on', async () => {
    const check = app.ctx.jobs.enqueue('software.update.check', {});
    const job = await waitForJob(app.ctx, check.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ count: 2, security: 1 });
    expect(job.result.autoJobId).toBeTruthy();
    expect((await waitForJob(app.ctx, job.result.autoJobId)).status).toBe('done');
    // The queued upgrade ran and reset the pending count it had just recorded.
    expect(app.ctx.settings.get('software.updates.last_check')).toMatchObject({ count: 0 });
    await put('/api/software/update/auto', { autoApply: false });
  });
});

describe('Perl modules and module installers', () => {
  it('lists and installs Perl modules', async () => {
    expect((await get('/api/software/perl/modules')).body.data.modules[0].name).toBe('DBI');
    const res = await post('/api/software/perl/install', { modules: ['DBD::mysql', 'JSON::XS'], notest: false });
    expect(res.status).toBe(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(app.agent.callsTo('pkg.perl.install').pop().args).toEqual({ modules: ['DBD::mysql', 'JSON::XS'], notest: false, wait: false });
  });

  it('detects installers and installs with gem, pip and pecl', async () => {
    const inst = await get('/api/software/modules/installers');
    expect(inst.body.data.present.gem).toBe(true);
    expect(inst.body.data.capabilities).toMatchObject({ gem: true, pip: true, pecl: false });
    expect((await get('/api/software/modules/gem')).body.data.items[0].name).toBe('rake');
    expect((await get('/api/software/modules/pip')).body.data.items[0].name).toBe('requests');
    const gem = await post('/api/software/modules/gem/install', { name: 'rails', version: '7.1.0' });
    expect(gem.status).toBe(202);
    expect((await waitForJob(app.ctx, gem.body.data.job.id)).status).toBe('done');
    expect(app.agent.callsTo('pkg.gem.install').pop().args).toEqual({ gem: 'rails', version: '7.1.0', wait: false });
    const pip = await post('/api/software/modules/pip/install', { name: 'requests' });
    expect((await waitForJob(app.ctx, pip.body.data.job.id)).status).toBe('done');
    expect(app.agent.callsTo('pkg.pip.install').pop().args).toEqual({ package: 'requests', wait: false });
    expect((await post('/api/software/modules/pecl/install', { name: 'redis' })).status).toBe(501);
    await provision(true, { pecl: true });
    const pecl = await post('/api/software/modules/pecl/install', { name: 'redis' });
    expect(pecl.status).toBe(202);
    const job = await waitForJob(app.ctx, pecl.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.logs.some((l) => l.line.includes('extension=redis.so'))).toBe(true);
    await provision(true);
  });
});

describe('Update Server Software', () => {
  it('reports the panel version and instructions, and checks a configured update feed', async () => {
    const status = await get('/api/software/panel/update');
    expect(status.body.data.currentVersion).toBe(app.ctx.version);
    expect(status.body.data.selfUpdate.supported).toBe(false);
    expect(status.body.data.instructions.length).toBeGreaterThan(2);
    expect((await post('/api/software/panel/update/check')).status).toBe(422);
    const saved = await put('/api/software/panel/update/settings', { url: `${updateUrl}/latest.json`, tier: 'stable' });
    expect(saved.body.data.updateUrl).toBe(`${updateUrl}/latest.json`);
    const checked = await post('/api/software/panel/update/check');
    expect(checked.status).toBe(200);
    expect(checked.body.data.latest).toMatchObject({ version: '9.9.0', url: 'https://example.com/whm-9.9.0.tar.gz', notes: 'Big release' });
    expect(checked.body.data.updateAvailable).toBe(true);
    await put('/api/software/panel/update/settings', { tier: 'edge' });
    expect((await post('/api/software/panel/update/check')).body.data.latest.version).toBe('10.0.0-beta.1');
    await put('/api/software/panel/update/settings', { url: `${updateUrl}/broken.json`, tier: 'stable' });
    const broken = await post('/api/software/panel/update/check');
    expect(broken.body.data.lastCheck.ok).toBe(false);
    expect(broken.body.data.lastCheck.error).toMatch(/version/);
    await put('/api/software/panel/update/settings', { url: `${updateUrl}/missing.json` });
    expect((await post('/api/software/panel/update/check')).body.data.lastCheck.error).toMatch(/404/);
  });
});

describe('MultiPHP Manager', () => {
  it('lists versions, sets the system default and per-domain versions', async () => {
    const versions = await get('/api/software/php/versions');
    expect(versions.body.data.versions.map((v) => v.id)).toEqual(['8.3', '8.2']);
    expect(versions.body.data.effectiveDefault).toBe('8.3');
    const def = await put('/api/software/php/default', { version: '8.2' });
    expect([200, 202]).toContain(def.status);
    expect(def.body.data).toMatchObject({ version: '8.2', cli: { applied: true, tool: 'update-alternatives' } });
    expect(['queued', 'applied', 'skipped', 'pinned', 'not-loaded']).toContain(def.body.data.web.state);
    expect(def.status).toBe(def.body.data.job ? 202 : 200);
    if (def.body.data.job) expect((await waitForJob(app.ctx, def.body.data.job.id)).status).toMatch(/done|failed/);
    expect((await get('/api/software/php/versions')).body.data.effectiveDefault).toBe('8.2');
    const domains = await get('/api/software/php/domains');
    const bob = domains.body.data.domains.find((d) => d.domain === 'bob.com');
    expect(bob).toMatchObject({ account: 'bob', type: 'main', phpVersion: null, effective: '8.2', inherited: true });
    const set = await put('/api/software/php/domains', { domains: ['bob.com'], version: '8.3' });
    expect(set.status).toBe(200);
    expect(set.body.data.results[0]).toMatchObject({ domain: 'bob.com', phpVersion: '8.3' });
    expect(set.body.data.results[0].web).toMatch(/^(recorded|applied|failed: )/);
    expect(app.ctx.software.php.versionForDomain('bob.com')).toMatchObject({ phpVersion: '8.3', effective: '8.3', inherited: false });
    const after = (await get('/api/software/php/domains?account=bob')).body.data.domains;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ phpVersion: '8.3', inherited: false });
    const inherit = await put('/api/software/php/domains', { domains: ['bob.com'], version: null });
    expect(inherit.body.data.results[0].phpVersion).toBeNull();
    expect(app.ctx.software.php.versionForDomain('bob.com').inherited).toBe(true);
    expect(app.ctx.software.php.versionForDomain('nobody.example')).toBeNull();
    const pools = await get('/api/software/php/pools?version=8.3');
    expect(pools.body.data.pools[0].name).toBe('www');
  });

  it('applies a single domain inline and a batch through a job when the web category is present', async () => {
    const calls = [];
    const prevWeb = app.ctx.web;
    app.ctx.web = { setPhpVersion: async (domain, version, req, opts) => { calls.push([domain, version, opts?.reload]); } };
    try {
      const single = await put('/api/software/php/domains', { domains: ['alice.com'], version: '8.3' });
      expect(single.status).toBe(200);
      expect(single.body.data.results[0].web).toBe('applied');
      expect(single.body.data.job).toBeNull();
      expect(calls).toEqual([['alice.com', '8.3', undefined]]);
      calls.length = 0;
      const batch = await put('/api/software/php/domains', { domains: ['alice.com', 'bob.com'], version: '8.3' });
      expect(batch.status).toBe(202);
      expect(batch.body.data.results.map((r) => r.web)).toEqual(['queued', 'queued']);
      // Recorded before the job runs, so the list already shows the new version.
      expect(app.ctx.software.php.versionForDomain('bob.com')).toMatchObject({ phpVersion: '8.3', inherited: false });
      const job = await waitForJob(app.ctx, batch.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ version: '8.3', applied: 2, failed: [], state: 'applied' });
      // Apache is asked to reload only after the last domain of the batch.
      expect(calls).toEqual([['alice.com', '8.3', false], ['bob.com', '8.3', true]]);
      expect(job.logs.some((l) => l.line === 'bob.com: 8.3 applied')).toBe(true);
      app.ctx.web = undefined;
      const recorded = await put('/api/software/php/domains', { domains: ['alice.com', 'bob.com'], version: '8.2' });
      expect(recorded.status).toBe(200);
      expect(recorded.body.data.results.every((r) => r.web === 'recorded')).toBe(true);
      await put('/api/software/php/domains', { domains: ['alice.com', 'bob.com'], version: null });
    } finally { app.ctx.web = prevWeb; }
  });

  it('a batch is refused as a whole when one domain belongs to another reseller', async () => {
    const before = app.ctx.software.php.versionForDomain('alice.com');
    expect((await mutate(reseller, 'put', '/api/software/php/domains', { domains: ['alice.com', 'bob.com'], version: '8.2' }, resellerCsrf)).status).toBe(403);
    expect(app.ctx.software.php.versionForDomain('alice.com')).toEqual(before);
  });

  it('re-pins every inherited domain through a job when the system default changes', async () => {
    const calls = [];
    const prevWeb = app.ctx.web;
    let pinned = null;
    app.ctx.web = { setPhpVersion: async (domain, version) => { if (domain === 'alice.com') throw new Error('vhost missing'); calls.push([domain, version]); }, apache: { settings: () => ({ defaultPhpVersion: pinned }) } };
    try {
      await put('/api/software/php/domains', { domains: ['bob.com'], version: null });
      await put('/api/software/php/domains', { domains: ['alice.com'], version: '8.2' });
      calls.length = 0;
      const res = await put('/api/software/php/default', { version: '8.3' });
      expect(res.status).toBe(202);
      expect(res.body.data.web).toMatchObject({ state: 'queued', domains: 1 });
      expect(res.body.data.job.type).toBe('software.php.resync');
      // The default is already persisted while the vhosts are being rewritten.
      expect(app.ctx.settings.get('php.default_version')).toBe('8.3');
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ version: '8.3', applied: 1, failed: [], state: 'applied' });
      expect(calls).toEqual([['bob.com', '8.3']]);
      await put('/api/software/php/domains', { domains: ['alice.com'], version: null });
      const partial = await put('/api/software/php/default', { version: '8.2' });
      expect(partial.status).toBe(202);
      const partialJob = await waitForJob(app.ctx, partial.body.data.job.id);
      expect(partialJob.status).toBe('done');
      expect(partialJob.result).toMatchObject({ state: 'partial', applied: 1, failed: [{ domain: 'alice.com', error: 'vhost missing' }] });
      expect(partialJob.logs.some((l) => l.level === 'error' && l.line === 'alice.com: vhost missing')).toBe(true);
      pinned = '8.3';
      const pin = await put('/api/software/php/default', { version: '8.3' });
      expect(pin.status).toBe(200);
      expect(pin.body.data.web.state).toBe('pinned');
      expect(pin.body.data.web.detail).toMatch(/Apache Configuration/);
      expect(pin.body.data.job).toBeNull();
      app.ctx.web = undefined;
      const unloaded = await put('/api/software/php/default', { version: '8.3' });
      expect(unloaded.status).toBe(200);
      expect(unloaded.body.data.web.state).toBe('not-loaded');
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'software.php.default'").get().n).toBeGreaterThanOrEqual(4);
    } finally { app.ctx.web = prevWeb; }
  });
});

describe('MultiPHP INI Editor', () => {
  it('reads and writes a version php.ini in basic and editor mode, reloading FPM', async () => {
    expect((await get('/api/software/php/ini/directives')).body.data.length).toBe(BASIC_DIRECTIVES.length);
    const read = await get('/api/software/php/ini/8.3');
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ path: '/etc/php/8.3/fpm/php.ini', content: INI });
    expect(read.body.data.basic.memory_limit).toBe('128M');
    expect(read.body.data.basic.display_errors).toBeNull();
    expect((await get('/api/software/php/ini/8.3?sapi=cli')).body.data.path).toBe('/etc/php/8.3/cli/php.ini');
    expect((await get('/api/software/php/ini/7.4')).status).toBe(404);
    const basic = await put('/api/software/php/ini/8.3', { directives: { memory_limit: '512M', display_errors: null } });
    expect(basic.status).toBe(200);
    expect(basic.body.data.basic.memory_limit).toBe('512M');
    expect(basic.body.data.reload).toMatchObject({ attempted: true, ok: true, unit: 'php8.3-fpm' });
    expect(app.agent.callsTo('pkg.php.ini.write').pop().args).toEqual({ version: '8.3', directives: { memory_limit: '512M', display_errors: null } });
    const editor = await put('/api/software/php/ini/8.2', { content: '[PHP]\nmemory_limit = 1G\n', reloadFpm: false });
    expect(editor.status).toBe(200);
    expect(editor.body.data.reload).toEqual({ attempted: false });
    app.agent.fail('svc.reload', 'command_failed', 'unit not found');
    const failed = await put('/api/software/php/ini/8.3', { directives: { memory_limit: '256M' } });
    expect(failed.status).toBe(200);
    expect(failed.body.data.reload).toMatchObject({ attempted: true, ok: false });
    app.agent.reset('svc.reload');
    app.agent.set('svc.reload', ({ unit }) => ({ unit, verb: 'reload', output: '' }));
  });

  it('reads and writes a domain .user.ini as root', async () => {
    const read = await get('/api/software/php/ini/domain/bob.com');
    expect(read.body.data).toMatchObject({ domain: 'bob.com', account: 'bob', path: '/home/bob/public_html/.user.ini', exists: false });
    expect(app.agent.callsTo('pkg.php.userini.read').pop().args).toEqual({ docroot: '/home/bob/public_html', owner: 'bob' });
    const write = await put('/api/software/php/ini/domain/bob.com', { content: 'memory_limit = 64M\n' });
    expect(write.status).toBe(200);
    expect(app.agent.callsTo('pkg.php.userini.write').pop().args).toMatchObject({ docroot: '/home/bob/public_html', owner: 'bob', content: 'memory_limit = 64M\n' });
    expect((await get('/api/software/php/ini/domain/nobody.example.org')).status).toBe(404);
  });
});

describe('NGINX Manager', () => {
  it('reports status, enables the proxy with cache, syncs, controls and disables it', async () => {
    // Without the web category the panel tells the operator to move Apache by hand.
    const prevWeb = app.ctx.web;
    app.ctx.web = undefined;
    try {
    const status = await get('/api/software/nginx');
    expect(status.body.data).toMatchObject({ installed: true, capability: true, proxyConfigured: false, settings: { enabled: false, apachePort: 8080 }, webLinked: false });
    expect(status.body.data.domains).toBe(2);
    const enabled = await put('/api/software/nginx', { enabled: true, cache: true, apachePort: 8081, cacheTtl: '1h' });
    expect(enabled.status).toBe(200);
    expect(enabled.body.data.settings).toMatchObject({ enabled: true, cache: true, apachePort: 8081, cacheTtl: '1h' });
    expect(enabled.body.data.apache.state).toBe('manual');
    expect(enabled.body.data.proxy).toMatchObject({ domains: 2, sslDomains: 0 });
    expect(enabled.body.data.proxy.unit).toMatchObject({ ok: true, verb: 'reload' });
    const written = app.agent.callsTo('pkg.nginx.proxy.write').pop().args;
    expect(written).toMatchObject({ apachePort: 8081, cache: true, cacheTtl: '1h' });
    expect(written.domains.map((d) => d.domain).sort()).toEqual(['alice.com', 'bob.com']);
    expect((await get('/api/software/nginx')).body.data).toMatchObject({ proxyConfigured: true, settings: { enabled: true } });
    expect((await get('/api/software/nginx/config')).body.data.content).toContain('apache_port=8081');
    const sync = await post('/api/software/nginx/sync');
    expect(sync.status).toBe(200);
    expect(sync.body.data.domains).toBe(2);
    expect((await post('/api/software/nginx/configtest')).body.data.ok).toBe(true);
    expect((await post('/api/software/nginx/restart')).body.data).toMatchObject({ ok: true, verb: 'restart' });
    app.agent.fail('svc.reload', 'command_failed', 'boom');
    expect((await post('/api/software/nginx/reload')).status).toBe(400);
    app.agent.set('svc.reload', ({ unit }) => ({ unit, verb: 'reload', output: '' }));
    const disabled = await put('/api/software/nginx', { enabled: false });
    expect(disabled.body.data.settings.enabled).toBe(false);
    expect(disabled.body.data.proxy.removed).toBe(true);
    expect((await get('/api/software/nginx')).body.data.proxyConfigured).toBe(false);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'software.nginx.configure'").get().n).toBe(2);
    } finally { app.ctx.web = prevWeb; }
  });

  // Same contract as service-configuration's setListenPorts({ http, https, bind }):
  // it records the ports it applied under service_config.apache_ports.
  const fakeWeb = (ports) => ({ setListenPorts: async ({ http, https = 443, bind = null, ...rest }) => { if (Object.keys(rest).length) throw new Error(`unexpected keys ${Object.keys(rest)}`); ports.push({ http, https, bind }); app.ctx.settings.set('service_config.apache_ports', { http, https, bind }); } });

  it('renders HTTPS blocks with www/parked names from installed certificates and pins Apache to loopback when ctx.ssl / ctx.web exist', async () => {
    const ports = [];
    const prev = { ssl: app.ctx.ssl, web: app.ctx.web };
    app.ctx.ssl = { certForDomain: (d) => (['bob.com', 'own.net'].includes(d) ? { state: 'installed', installed: 1 } : null), bundlePaths: (d) => ({ fullchain: `/etc/ssl/whm/${d}/fullchain.pem`, key: `/etc/ssl/whm/${d}/key.pem` }) };
    app.ctx.web = fakeWeb(ports);
    const bob = app.ctx.db.prepare("SELECT id FROM accounts WHERE username = 'bob'").get().id;
    app.ctx.db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'parked.org', 'parked', NULL), (?, 'own.net', 'alias', NULL), (?, 'shop.bob.com', 'sub', '/home/bob/public_html/shop'), (?, 'off.bob.com', 'parked', NULL)").run(bob, bob, bob, bob);
    try {
      const res = await put('/api/software/nginx', { enabled: true, cache: false, apacheSslPort: 8444 });
      expect(res.status).toBe(200);
      expect(res.body.data.apache.state).toBe('applied');
      expect(res.body.data.apache.detail).toMatch(/127\.0\.0\.1 only/);
      expect(ports).toEqual([{ http: 8081, https: 8444, bind: '127.0.0.1' }]);
      const written = app.agent.callsTo('pkg.nginx.proxy.write').pop().args;
      const byDomain = Object.fromEntries(written.domains.map((d) => [d.domain, d]));
      expect(Object.keys(byDomain).sort()).toEqual(['alice.com', 'bob.com', 'own.net', 'shop.bob.com']);
      // The main vhost answers to www. and the account's parked/alias names; a parked domain with its own certificate gets its own block.
      expect(byDomain['bob.com']).toEqual({ domain: 'bob.com', aliases: ['www.bob.com', 'off.bob.com', 'parked.org'], ssl: { cert: '/etc/ssl/whm/bob.com/fullchain.pem', key: '/etc/ssl/whm/bob.com/key.pem' } });
      expect(byDomain['own.net']).toMatchObject({ aliases: ['www.own.net'], ssl: { cert: '/etc/ssl/whm/own.net/fullchain.pem' } });
      expect(byDomain['shop.bob.com']).toEqual({ domain: 'shop.bob.com', aliases: ['www.shop.bob.com'] });
      expect(byDomain['alice.com']).toEqual({ domain: 'alice.com', aliases: ['www.alice.com'] });
      const status = (await get('/api/software/nginx')).body.data;
      expect(status).toMatchObject({ backendBind: '127.0.0.1', backendExposed: false, stale: false, sslDomains: 2, domains: 4 });
      // Re-saving with the same ports does not restart Apache again.
      expect((await put('/api/software/nginx', { cache: true })).body.data.apache.state).toBe('unchanged');
      expect(ports).toHaveLength(1);
      await put('/api/software/nginx', { enabled: false });
      expect(ports[1]).toEqual({ http: 80, https: 443, bind: null });
      expect((await get('/api/software/nginx')).body.data.backendBind).toBe('all-interfaces');
    } finally { app.ctx.ssl = prev.ssl; app.ctx.web = prev.web; app.ctx.db.prepare("DELETE FROM account_domains WHERE domain IN ('parked.org', 'own.net', 'shop.bob.com', 'off.bob.com')").run(); }
  });

  it('re-pins an Apache still on all interfaces when the proxy settings are re-saved', async () => {
    const ports = [];
    const prevWeb = app.ctx.web;
    app.ctx.web = fakeWeb(ports);
    try {
      await put('/api/software/nginx', { enabled: false });
      ports.length = 0;
      await put('/api/software/nginx', { enabled: true });
      expect(ports).toEqual([{ http: 8081, https: 8444, bind: '127.0.0.1' }]);
      // An older panel left Apache on 0.0.0.0:8081; status says so and the next save fixes it.
      app.ctx.settings.set('service_config.apache_ports', { http: 8081, https: 8444, bind: null });
      expect((await get('/api/software/nginx')).body.data).toMatchObject({ backendBind: 'all-interfaces', backendExposed: true });
      expect((await put('/api/software/nginx', { cache: false })).body.data.apache.state).toBe('applied');
      expect(ports).toHaveLength(2);
      expect(ports[1].bind).toBe('127.0.0.1');
      await put('/api/software/nginx', { enabled: false });
    } finally { app.ctx.web = prevWeb; }
  });

  it('flags a rendered proxy that no longer matches the domains or certificates, and the scheduled sync re-renders it', async () => {
    const prevSsl = app.ctx.ssl;
    const prevWeb = app.ctx.web;
    app.ctx.web = undefined;
    app.ctx.ssl = { certForDomain: () => null, bundlePaths: (d) => ({ fullchain: `/etc/ssl/whm/${d}/fullchain.pem`, key: `/etc/ssl/whm/${d}/key.pem` }) };
    try {
      await put('/api/software/nginx', { enabled: false });
      // Disabled: the sync is a no-op for other categories and the job skips.
      expect(await app.ctx.software.nginx.sync(null)).toEqual({ skipped: true, reason: 'proxy disabled' });
      expect((await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.nginx.sync', {}).id)).result).toMatchObject({ skipped: true, reason: 'proxy disabled' });
      await put('/api/software/nginx', { enabled: true });
      expect((await get('/api/software/nginx')).body.data.stale).toBe(false);
      const current = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.nginx.sync', {}).id);
      expect(current.result).toMatchObject({ skipped: true, reason: 'current' });
      // SSL/TLS installs a certificate: the rendered config is now out of date.
      app.ctx.ssl.certForDomain = (d) => (d === 'alice.com' ? { state: 'installed', installed: 1 } : null);
      expect((await get('/api/software/nginx')).body.data).toMatchObject({ stale: true, sslDomains: 1 });
      app.agent.calls.length = 0;
      const synced = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.nginx.sync', {}).id);
      expect(synced.status).toBe('done');
      expect(synced.result).toMatchObject({ skipped: false, domains: 2, sslDomains: 1, unit: { ok: true, verb: 'reload' } });
      expect(app.agent.callsTo('pkg.nginx.proxy.write').pop().args.domains.find((d) => d.domain === 'alice.com').ssl.cert).toBe('/etc/ssl/whm/alice.com/fullchain.pem');
      expect((await get('/api/software/nginx')).body.data.stale).toBe(false);
      // Accounts creates a domain: same thing, and the inline sync other categories call fixes it.
      await post('/api/accounts', { username: 'carol', domain: 'carol.com' }).expect(201);
      expect((await get('/api/software/nginx')).body.data).toMatchObject({ stale: true, domains: 3 });
      const inline = await app.ctx.software.nginx.sync(null);
      expect(inline).toMatchObject({ domains: 3, unit: { ok: true } });
      expect((await get('/api/software/nginx')).body.data.stale).toBe(false);
      // A missing managed file counts as stale too.
      nginxState.proxyConfigured = false;
      expect((await get('/api/software/nginx')).body.data.stale).toBe(true);
      const rewritten = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.nginx.sync', {}).id);
      expect(rewritten.result.skipped).toBe(false);
      await put('/api/software/nginx', { enabled: false });
    } finally { app.ctx.ssl = prevSsl; app.ctx.web = prevWeb; app.ctx.db.prepare("DELETE FROM accounts WHERE username = 'carol'").run(); }
  });

  it('validates the proxy before touching Apache and rolls everything back when nginx cannot start', async () => {
    const ports = [];
    const prevWeb = app.ctx.web;
    app.ctx.web = { setListenPorts: async ({ http, https }) => { ports.push({ http, https }); } };
    const order = () => app.agent.calls.map((c) => c.name).filter((n) => ['pkg.nginx.proxy.write', 'pkg.nginx.proxy.remove', 'svc.start', 'svc.reload'].includes(n));
    try {
      app.agent.fail('pkg.nginx.proxy.write', 'config_invalid', 'nginx -t rejected the generated configuration');
      app.agent.calls.length = 0;
      const invalid = await put('/api/software/nginx', { enabled: true });
      expect(invalid.status).toBe(500);
      expect(invalid.body.error.message).toMatch(/nginx -t/);
      expect(ports).toEqual([]);
      expect(order()).toEqual(['pkg.nginx.proxy.write']);
      expect((await get('/api/software/nginx')).body.data.settings.enabled).toBe(false);
      app.agent.set('pkg.nginx.proxy.write', ({ domains, apachePort, cache }) => { nginxState.proxyConfigured = true; nginxState.content = `# whm-proxy: version=1 apache_port=${apachePort} cache=${cache ? 'on' : 'off'} domains=${domains.length}`; return { path: '/etc/nginx/conf.d/whm-proxy.conf', bytes: 500, domains: domains.length, sslDomains: 0, skipped: 0, configtest: { ok: true, output: 'ok' } }; });

      nginxState.active = false;
      app.agent.fail('svc.start', 'command_failed', 'bind() to 0.0.0.0:80 failed');
      app.agent.calls.length = 0;
      const down = await put('/api/software/nginx', { enabled: true, apacheSslPort: 8443 });
      expect(down.status).toBe(400);
      expect(down.body.error.message).toMatch(/rolled back/);
      expect(ports).toEqual([{ http: 8081, https: 8443 }, { http: 80, https: 443 }]);
      expect(order()).toEqual(['pkg.nginx.proxy.write', 'svc.start', 'pkg.nginx.proxy.remove']);
      const status = await get('/api/software/nginx');
      expect(status.body.data.settings.enabled).toBe(false);
      expect(status.body.data.proxyConfigured).toBe(false);
      app.agent.set('svc.start', ({ unit }) => ({ unit, verb: 'start', output: '' }));

      ports.length = 0;
      app.ctx.web = { setListenPorts: async () => { throw new Error('Apache rejected the new ports'); } };
      app.agent.calls.length = 0;
      const apacheDown = await put('/api/software/nginx', { enabled: true });
      expect(apacheDown.status).toBe(400);
      expect(apacheDown.body.error.message).toMatch(/not enabled/);
      expect(order()).toEqual(['pkg.nginx.proxy.write', 'pkg.nginx.proxy.remove']);
      expect((await get('/api/software/nginx')).body.data).toMatchObject({ proxyConfigured: false, settings: { enabled: false } });

      // Without the web category nginx failing to start is reported, not rolled back: nothing of ours moved Apache.
      app.ctx.web = undefined;
      app.agent.fail('svc.start', 'command_failed', 'bind() to 0.0.0.0:80 failed');
      const manual = await put('/api/software/nginx', { enabled: true });
      expect(manual.status).toBe(200);
      expect(manual.body.data.apache.state).toBe('manual');
      expect(manual.body.data.proxy.unit).toMatchObject({ ok: false, verb: 'start' });
      expect(manual.body.data.proxy.unit.hint).toMatch(/Apache Configuration/);
      expect((await get('/api/software/nginx')).body.data.settings.enabled).toBe(true);
      app.agent.set('svc.start', ({ unit }) => ({ unit, verb: 'start', output: '' }));
      nginxState.active = true;
      await put('/api/software/nginx', { enabled: false });
    } finally { app.ctx.web = prevWeb; }
  });

  it('installs nginx as a job when it is missing', async () => {
    nginxState = { installed: false, active: null, proxyConfigured: false, content: null };
    await provision(true, { nginx: false });
    expect((await get('/api/software/nginx')).body.data).toMatchObject({ installed: false, capability: false });
    expect((await put('/api/software/nginx', { enabled: true })).status).toBe(501);
    const res = await post('/api/software/nginx/install');
    expect(res.status).toBe(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(app.agent.callsTo('pkg.install').pop().args.packages).toEqual(['nginx']);
    expect(app.agent.callsTo('svc.enable').pop().args.unit).toBe('nginx');
    nginxState = { installed: true, active: true, proxyConfigured: false, content: null };
    await provision(true);
  });
});

describe('EasyApache 4', () => {
  it('seeds stock profiles, previews a diff and builds a profile as a job', async () => {
    const list = await get('/api/software/ea4/profiles');
    expect(list.body.data.family).toBe('debian');
    const names = list.body.data.profiles.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Default', 'Minimal', 'All PHP options', 'Hardened']));
    expect(list.body.data.profiles.every((p) => p.stock)).toBe(true);
    expect((await get('/api/software/ea4/catalog')).body.data.rhel.Apache).toContain('httpd');
    const installed = await get('/api/software/ea4/installed');
    expect(installed.body.data.packages.map((p) => p.name)).toEqual(expect.arrayContaining(['apache2', 'php-fpm', 'libapache2-mod-evasive']));
    expect(installed.body.data.packages.map((p) => p.name)).not.toContain('curl');
    const minimal = list.body.data.profiles.find((p) => p.name === 'Minimal');
    const diff = await get(`/api/software/ea4/profiles/${minimal.id}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.body.data.unchanged).toEqual(expect.arrayContaining(['apache2', 'php-fpm']));
    expect(diff.body.data.install).toEqual(expect.arrayContaining(['php-cli', 'php-common', 'php-opcache']));
    expect(diff.body.data.remove).toContain('libapache2-mod-evasive');
    expect(diff.body.data.remove).not.toContain('curl');
    expect(diff.body.data.collateral).toEqual([]);
    expect(diff.body.data.simulationError).toBeNull();
    const build = await post(`/api/software/ea4/profiles/${minimal.id}/build`, { removeExtras: true });
    expect(build.status).toBe(202);
    const job = await waitForJob(app.ctx, build.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result.installed).toEqual(expect.arrayContaining(['php-cli', 'apache2-utils']));
    expect(job.result.removed).toEqual(['libapache2-mod-evasive']);
    expect(app.agent.callsTo('pkg.remove').pop().args.packages).toEqual(['libapache2-mod-evasive']);
    // Simulated before anything changes and again after the install step.
    expect(app.agent.callsTo('pkg.remove_simulate').slice(-2).map((c) => c.args)).toEqual([{ packages: ['libapache2-mod-evasive'] }, { packages: ['libapache2-mod-evasive'] }]);
    expect((await get('/api/software/ea4/profiles')).body.data.profiles.find((p) => p.id === minimal.id).active).toBe(true);
    const again = await get(`/api/software/ea4/profiles/${minimal.id}/diff`);
    expect(again.body.data.install).toEqual([]);
    expect((await get('/api/software/ea4/builds')).body.data[0].type).toBe('software.ea4.build');
  });

  it('refuses to remove profile extras when the package manager would take unrelated packages with them', async () => {
    // apache2 depends on apache2-utils on Debian: a profile that omits the
    // utilities would lose Apache itself to "remove extras".
    const created = await post('/api/software/ea4/profiles', { name: 'No utils', packages: { debian: ['apache2', 'php-fpm', 'php-cli', 'php-common', 'php-opcache'], rhel: ['httpd'] } });
    expect(created.status).toBe(201);
    const diff = await get(`/api/software/ea4/profiles/${created.body.data.id}/diff`);
    expect(diff.body.data.remove).toEqual(['apache2-utils']);
    expect(diff.body.data.collateral).toEqual([{ name: 'apache2', version: '2.4.58', section: 'dependent' }]);
    app.agent.calls.length = 0;
    const refused = await waitForJob(app.ctx, (await post(`/api/software/ea4/profiles/${created.body.data.id}/build`, { removeExtras: true })).body.data.job.id);
    expect(refused.status).toBe('failed');
    expect(refused.error).toMatch(/would also remove apache2;/);
    expect(app.agent.callsTo('pkg.remove')).toHaveLength(0);
    expect(app.agent.callsTo('pkg.install')).toHaveLength(0);
    expect(installedPkgs.some((p) => p.name === 'apache2')).toBe(true);
    // Without removeExtras nothing is removed and the build goes through.
    const kept = await waitForJob(app.ctx, (await post(`/api/software/ea4/profiles/${created.body.data.id}/build`, {})).body.data.job.id);
    expect(kept.status).toBe('done');
    expect(kept.result.removed).toEqual([]);
    // Explicitly accepting the dependents removes them, logged as a warning.
    const accepted = await waitForJob(app.ctx, (await post(`/api/software/ea4/profiles/${created.body.data.id}/build`, { removeExtras: true, removeDependents: true })).body.data.job.id);
    expect(accepted.status).toBe('done');
    expect(accepted.result.removed).toEqual(['apache2-utils', 'apache2']);
    expect(accepted.logs.some((l) => l.level === 'warn' && /dependent packages removed as well: apache2/.test(l.line))).toBe(true);
    expect(app.agent.callsTo('pkg.remove').pop().args.packages).toEqual(['apache2-utils']);
    // A simulation failure stops the removal step rather than guessing.
    installedPkgs.push({ name: 'apache2', version: '2.4.58', arch: 'amd64', summary: 'Apache HTTP Server' }, { name: 'apache2-utils', version: '2.4.58', arch: 'amd64', summary: 'utils' });
    app.agent.fail('pkg.remove_simulate', 'command_failed', 'apt-get could not simulate the removal: lock held');
    expect((await get(`/api/software/ea4/profiles/${created.body.data.id}/diff`)).body.data).toMatchObject({ collateral: null, simulationError: expect.stringMatching(/lock held/) });
    const blocked = await waitForJob(app.ctx, (await post(`/api/software/ea4/profiles/${created.body.data.id}/build`, { removeExtras: true, removeDependents: true })).body.data.job.id);
    expect(blocked.status).toBe('failed');
    expect(blocked.error).toMatch(/could not simulate the removal/);
    app.agent.reset('pkg.remove_simulate');
    app.agent.set('pkg.remove_simulate', ({ packages }) => { const present = packages.filter((p) => installedPkgs.some((i) => i.name === p)); const collateral = present.includes('apache2-utils') ? [{ name: 'apache2', version: '2.4.58', section: 'dependent' }] : []; return { manager: 'apt', requested: packages, present, remove: [...present, ...collateral.map((c) => c.name)], collateral, output: [] }; });
    expect((await post(`/api/software/ea4/profiles/${created.body.data.id}/build`, { removeExtras: 'yes' })).status).toBe(422);
    await del(`/api/software/ea4/profiles/${created.body.data.id}`);
  });

  it('manages custom profiles and protects stock ones', async () => {
    const created = await post('/api/software/ea4/profiles', { name: 'My stack', description: 'custom', packages: { debian: ['apache2', 'php-redis', 'php-redis'], rhel: ['httpd'] } });
    expect(created.status).toBe(201);
    expect(created.body.data.packages.debian).toEqual(['apache2', 'php-redis']);
    expect((await post('/api/software/ea4/profiles', { name: 'My stack', packages: { debian: [], rhel: [] } })).status).toBe(409);
    const updated = await put(`/api/software/ea4/profiles/${created.body.data.id}`, { packages: { debian: ['apache2'], rhel: [] } });
    expect(updated.body.data.packages.debian).toEqual(['apache2']);
    const stock = (await get('/api/software/ea4/profiles')).body.data.profiles.find((p) => p.stock);
    expect((await put(`/api/software/ea4/profiles/${stock.id}`, { description: 'x' })).status).toBe(409);
    expect((await del(`/api/software/ea4/profiles/${stock.id}`)).status).toBe(409);
    const copy = await post(`/api/software/ea4/profiles/${stock.id}/copy`, { name: 'Default custom' });
    expect(copy.status).toBe(201);
    expect(copy.body.data.stock).toBe(false);
    expect(copy.body.data.packages.debian).toEqual(stock.packages.debian);
    expect((await del(`/api/software/ea4/profiles/${copy.body.data.id}`)).body.data.deleted).toBe(true);
    expect((await get(`/api/software/ea4/profiles/${copy.body.data.id}`)).status).toBe(404);
    expect((await del(`/api/software/ea4/profiles/${created.body.data.id}`)).status).toBe(200);
  });
});
