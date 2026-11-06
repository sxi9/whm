import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { compareVersions, pickBasic, BASIC_DIRECTIVES, EA4_CATALOG } from '../src/services/software.js';
import { RUNTIMES, TOOLS, PHP_BUILD_DEPS, PHP_SOURCE_MINORS, resolveInstall, reposFor, detectedVersion } from '../src/services/software-runtimes.js';

const BIN_FULL = { 'apt-get': true, 'dpkg-query': true, php: true, 'php-fpm': true, nginx: true, perl: true, cpan: true, gem: true, pip3: true, apache2ctl: true, systemctl: true };
const PHP = { id: '8.3', label: 'PHP 8.3', binary: '/usr/bin/php8.3', layout: 'debian', version: '8.3.6', iniPath: '/etc/php/8.3/fpm/php.ini', iniPaths: { fpm: '/etc/php/8.3/fpm/php.ini', cli: '/etc/php/8.3/cli/php.ini' }, poolDir: '/etc/php/8.3/fpm/pool.d', fpmUnit: 'php8.3-fpm', isDefault: true, fpmActive: true, fpmInstalled: true };
const PHP82 = { ...PHP, id: '8.2', label: 'PHP 8.2', binary: '/usr/bin/php8.2', version: '8.2.20', iniPath: '/etc/php/8.2/fpm/php.ini', fpmUnit: 'php8.2-fpm', isDefault: false, fpmActive: false };
const INI = '[PHP]\nmemory_limit = 128M\nupload_max_filesize = 2M\n;display_errors = On\n';
let installedPkgs = [{ name: 'apache2', version: '2.4.58', arch: 'amd64', summary: 'Apache HTTP Server' }, { name: 'php-fpm', version: '8.3', arch: 'all', summary: 'FPM' }, { name: 'curl', version: '8.5.0', arch: 'amd64', summary: 'cli' }, { name: 'libapache2-mod-evasive', version: '1.1', arch: 'amd64', summary: 'evasive' }];
let nginxState = { installed: true, active: true, proxyConfigured: false, content: null };
let rpmPresent = false;
// One-click installs: repo state per enum key, Node.js builds under /opt/keel/node, PHP CLI default.
let repoState = { php: 'added', python: 'unsupported', epel: 'present' };
let nodeVersions = [{ major: 22, version: 'v22.11.0', path: '/opt/keel/node/22', bin: '/opt/keel/node/22/bin/node' }];
let phpCliDefault = '8.3';
// PHP minors built from source (agent pkg.php.build.finish) under /opt/keel/php/<minor>.
let keelBuilds = [];
const keelVersion = (minor) => ({ id: minor, label: `PHP ${minor} (Keel build)`, binary: `/opt/keel/php/${minor}/bin/php`, layout: 'keel', source: true, version: `${minor}.33`, iniPath: `/opt/keel/php/${minor}/lib/php.ini`, iniPaths: { php: `/opt/keel/php/${minor}/lib/php.ini` }, poolDir: `/opt/keel/php/${minor}/etc/php-fpm.d`, fpmUnit: `keel-php${minor}-fpm`, packagePrefix: null, isDefault: false, fpmActive: true, fpmInstalled: true });
const detectRuntimes = () => ({
  os: { id: 'ubuntu', idLike: ['debian'], versionId: '26.04', codename: 'resolute', family: 'debian' },
  php: [...[...new Set(installedPkgs.map((p) => /^php(\d\.\d)-fpm$/.exec(p.name)?.[1]).filter(Boolean)), '8.3', '8.2'].map((id) => ({ id, version: `${id}.6` })), ...keelBuilds.map((minor) => ({ id: minor, version: `${minor}.33`, layout: 'keel', source: true }))],
  node: { system: { version: 'v22.11.0', path: '/usr/bin/node' }, versions: nodeVersions },
  python: [{ minor: '3.12', version: '3.12.3', bin: '/usr/bin/python3.12' }, ...(installedPkgs.some((p) => p.name === 'python3.11') ? [{ minor: '3.11', version: '3.11.9', bin: '/usr/bin/python3.11' }] : [])],
  ruby: installedPkgs.some((p) => p.name === 'ruby-full') ? '3.3.0' : null, go: null, composer: null, perl: '5.38.2',
});

let app;
let csrf;
let reseller;
let resellerCsrf;
let updateServer;
let updateUrl;
const feedRequests = [];
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
    'pkg.search': ({ q, limit }) => { const term = Array.isArray(q) ? q.join('-') : q; return { manager: 'apt', q: Array.isArray(q) ? q.join(' ') : q, results: [{ name: term, summary: `the ${term} package`, installed: installedPkgs.some((p) => p.name === term), installedVersion: null }, { name: `lib${term}`, summary: 'library', installed: false, installedVersion: null }].slice(0, limit) }; },
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
    'pkg.php.versions': () => ({ versions: [PHP, PHP82], defaultId: phpCliDefault, defaultBinary: `/usr/bin/php${phpCliDefault}` }),
    'pkg.php.default.set': ({ version }) => { phpCliDefault = version; return { version, binary: `/usr/bin/php${version}`, tool: 'update-alternatives' }; },
    'pkg.os.release': () => detectRuntimes().os,
    'pkg.repo.status': ({ repo }) => ({ repo, family: 'debian', present: repoState[repo] === 'present', supported: repoState[repo] !== 'unsupported', detail: repoState[repo] === 'unsupported' ? `no ${repo} repository for Ubuntu 26.04 resolute` : `ppa for ${repo}` }),
    'pkg.repo.ensure': ({ repo }) => ({ repo, family: 'debian', action: repoState[repo] ?? 'present', detail: repoState[repo] === 'unsupported' ? 'Debian ships one Python version; deadsnakes is Ubuntu only' : `ppa for ${repo}` }),
    'pkg.node.list': () => ({ system: { version: 'v22.11.0', path: '/usr/bin/node' }, versions: nodeVersions }),
    'pkg.node.install': ({ major }) => { const entry = { major, version: `v${major}.0.0`, path: `/opt/keel/node/${major}`, bin: `/opt/keel/node/${major}/bin/node`, symlinks: [`/usr/local/bin/node${major}`, `/usr/local/bin/npm${major}`, `/usr/local/bin/npx${major}`] }; nodeVersions = [...nodeVersions.filter((n) => n.major !== major), entry]; return { ...entry, output: [`Node.js ${entry.version} installed under ${entry.path}`] }; },
    'pkg.node.remove': ({ major }) => { nodeVersions = nodeVersions.filter((n) => n.major !== major); return { major, removed: true, symlinks: [`/usr/local/bin/node${major}`] }; },
    'pkg.runtime.detect': () => detectRuntimes(),
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
    'svc.start': ({ unit }) => { if (unit === 'nginx') nginxState.active = true; return { unit, verb: 'start', output: '' }; },
    'svc.stop': ({ unit }) => { if (unit === 'nginx') nginxState.active = false; return { unit, verb: 'stop', output: '' }; },
    'svc.enable': ({ unit }) => ({ unit, verb: 'enable', output: '' }),
    'svc.disable': ({ unit }) => ({ unit, verb: 'disable', output: '' }),
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
    feedRequests.push({ url: req.url, authorization: req.headers.authorization ?? null });
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
  it('attaches ctx.software (+ the ctx.pkg alias) with its jobs, schedules and capabilities', () => {
    expect(typeof app.ctx.software.pkg.ensureInstalled).toBe('function');
    expect(app.ctx.pkg).toBe(app.ctx.software.pkg);
    expect(typeof app.ctx.software.php.versionForDomain).toBe('function');
    expect(typeof app.ctx.software.nginx.sync).toBe('function');
    expect(typeof app.ctx.software.update.status).toBe('function');
    for (const t of ['software.pkg.install', 'software.pkg.remove', 'software.system.update', 'software.update.check', 'software.perl.install', 'software.module.install', 'software.nginx.install', 'software.nginx.sync', 'software.rpmdb.rebuild', 'software.php.resync', 'software.php.apply', 'software.ea4.build', 'software.runtime.install', 'software.runtime.remove']) expect(app.ctx.jobs.types()).toContain(t);
    expect(typeof app.ctx.software.runtimes.catalog).toBe('function');
    expect(app.ctx.scheduler.list().find((s) => s.name === 'os-update-check')?.cron).toBe('41 5 * * *');
    // Hourly, and paused at boot because the proxy is off: no skipped job rows pile up.
    expect(app.ctx.scheduler.list().find((s) => s.name === 'nginx-proxy-sync')).toMatchObject({ cron: '23 * * * *', job_type: 'software.nginx.sync', enabled: 0 });
    expect(app.ctx.capabilities.has('pkg')).toBe(true);
    expect(app.ctx.capabilities.has('rpm')).toBe(false);
  });

  it('migrates the old 10-minute proxy-sync schedule to hourly at boot without touching operator tuning', async () => {
    const { register } = await import('../src/routes/categories/software.js');
    const fake = (cron, enabled = 1) => {
      const rows = [{ name: 'nginx-proxy-sync', cron, enabled, job_type: 'software.nginx.sync', params_json: '{}' }];
      const updates = [];
      return { rows, updates, scheduler: { ensure: () => {}, list: () => rows, update: (name, patch) => { updates.push([name, patch]); Object.assign(rows[0], patch.cron ? { cron: patch.cron } : {}, patch.enabled != null ? { enabled: patch.enabled ? 1 : 0 } : {}); return rows[0]; } } };
    };
    const legacy = fake('*/10 * * * *');
    await register({ ...app.ctx, scheduler: legacy.scheduler, jobs: { register: () => {} }, capabilities: { ...app.ctx.capabilities, register: () => {} } });
    expect(legacy.rows[0]).toMatchObject({ cron: '23 * * * *', enabled: 0 });
    const tuned = fake('5 */2 * * *');
    await register({ ...app.ctx, scheduler: tuned.scheduler, jobs: { register: () => {} }, capabilities: { ...app.ctx.capabilities, register: () => {} } });
    expect(tuned.rows[0].cron).toBe('5 */2 * * *');
    expect(tuned.updates.every(([, patch]) => patch.cron === undefined)).toBe(true);
  });

  it('server-wide functions are root only', async () => {
    for (const url of ['/api/software/pkg/detect', '/api/software/pkg/installed', '/api/software/pkg/search?q=curl', '/api/software/update/status', '/api/software/rpmdb', '/api/software/perl/modules', '/api/software/modules/installers', '/api/software/panel/update', '/api/software/php/pools', '/api/software/php/ini/8.3', '/api/software/nginx', '/api/software/ea4/profiles', '/api/software/runtimes', '/api/software/runtimes/recent']) {
      expect((await reseller.get(url)).status, url).toBe(403);
    }
    expect((await mutate(reseller, 'post', '/api/software/pkg/install', { packages: ['nginx'] }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/software/runtimes/install', { runtime: 'php', version: '8.4' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/software/runtimes/remove', { runtime: 'nodejs', version: '22' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/software/update/run', {}, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/software/php/default', { version: '8.2' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/software/php/ini/8.3', { directives: { memory_limit: '1G' } }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/software/nginx', { enabled: true }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/software/ea4/profiles/1/build', {}, resellerCsrf)).status).toBe(403);
  });

  it('resellers get only the PHP version dropdown, never binaries, ini paths or the module scan', async () => {
    app.agent.calls.length = 0;
    const res = await reseller.get('/api/software/php/versions?modules=true');
    expect(res.status).toBe(200);
    // Resellers get the advisory badge data (no binaries or paths); both fixture versions predate the October 2026 fixes.
    expect(res.body.data.versions).toEqual([{ id: '8.3', label: 'PHP 8.3', version: '8.3.6', isDefault: true, advisories: [expect.objectContaining({ id: 'CVE-2026-109619', fixedIn: '8.3.36' })] }, { id: '8.2', label: 'PHP 8.2', version: '8.2.20', isDefault: false, advisories: [expect.objectContaining({ id: 'CVE-2026-109619', fixedIn: '8.2.35' })] }]);
    expect(res.body.data.effectiveDefault).toBe('8.3');
    expect(JSON.stringify(res.body.data)).not.toMatch(/iniPath|poolDir|fpmUnit|binary/);
    expect(app.agent.callsTo('pkg.php.versions').pop().args).toEqual({ modules: false });
    const root = await get('/api/software/php/versions?modules=true');
    expect(root.body.data.versions[0]).toMatchObject({ binary: '/usr/bin/php8.3', iniPath: '/etc/php/8.3/fpm/php.ini', fpmUnit: 'php8.3-fpm' });
    expect(app.agent.callsTo('pkg.php.versions').pop().args).toEqual({ modules: true });
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
    for (const q of ['php;%20mysql', 'php%20$(id)', 'php%20-r', 'a%20b%20c%20d%20e', '%20', 'php%0Amysql']) expect((await get(`/api/software/pkg/search?q=${q}`)).status, q).toBe(422);
    expect(app.agent.callsTo('pkg.search')).toHaveLength(0);
    expect((await get('/api/software/pkg/info/-r')).status).toBe(422);
    expect((await post('/api/software/update/run', { packages: ['$(id)'] })).status).toBe(422);
    expect((await put('/api/software/update/auto', { autoApply: 'yes' })).status).toBe(422);
    expect((await post('/api/software/perl/install', { modules: ['Foo::-Bar'] })).status).toBe(422);
    expect((await post('/api/software/perl/install', { modules: [] })).status).toBe(422);
    expect((await post('/api/software/modules/gem/install', { name: 'a b' })).status).toBe(422);
    expect((await post('/api/software/modules/gem/install', { name: 'rails', version: '-1' })).status).toBe(422);
    // Names the agent's per-installer schemas would refuse are a 422 with a field message, not a failed job.
    for (const [kind, name] of [['pecl', 'Redis'], ['pecl', 'redis.io'], ['pecl', 'redis--'], ['pear', 'Mail-1.0'], ['pear', 'pear/Mail'], ['pear', 'foo.bar'], ['gem', 'a b'], ['pip', '-r']]) {
      const res = await post(`/api/software/modules/${kind}/install`, { name });
      expect(res.status, `${kind} ${name}`).toBe(422);
      expect(res.body.error.fields?.name?.[0] ?? res.body.error.message, `${kind} ${name}`).toMatch(/name|Letters/);
    }
    expect(app.agent.callsTo('pkg.pecl.install')).toHaveLength(0);
    expect(app.agent.callsTo('pkg.pear.install')).toHaveLength(0);
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
    expect(app.agent.callsTo('pkg.search').at(-1).args).toEqual({ q: ['curl'], limit: 100 });
    const words = await get('/api/software/pkg/search?q=%20php%20%20mysql%20&limit=5');
    expect(words.status).toBe(200);
    expect(app.agent.callsTo('pkg.search').at(-1).args).toEqual({ q: ['php', 'mysql'], limit: 5 });
    expect(words.body.data.q).toBe('php mysql');
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

  it('re-detects capabilities after a package install and before refusing a module list', async () => {
    await provision(true, { gem: false });
    expect((await get('/api/software/modules/gem')).status).toBe(501);
    expect((await post('/api/software/modules/gem/install', { name: 'rails' })).status).toBe(501);
    // The ruby package lands and the binary appears; the panel must notice without waiting for the periodic re-detection.
    app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BIN_FULL[n])])));
    const before = app.agent.callsTo('sys.binaries').length;
    const res = await post('/api/software/pkg/install', { packages: ['ruby'] });
    expect(res.status).toBe(202);
    expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('done');
    expect(app.agent.callsTo('sys.binaries').length).toBeGreaterThan(before);
    expect((await get('/api/software/modules/gem')).status).toBe(200);
    expect((await get('/api/software/modules/installers')).body.data.capabilities.gem).toBe(true);
  });

  it('re-detects once before a 501 when the installer arrived outside the panel', async () => {
    await provision(true, { gem: false });
    expect((await get('/api/software/modules/gem')).status).toBe(501);
    app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BIN_FULL[n])])));
    // Still 501 while the snapshot is fresh: concurrent cards must not each trigger a detection.
    const detections = app.agent.callsTo('sys.binaries').length;
    expect((await get('/api/software/modules/gem')).status).toBe(501);
    expect(app.agent.callsTo('sys.binaries').length).toBe(detections);
    app.ctx.capabilities.snapshot().at -= 60 * 1000;
    expect((await get('/api/software/modules/gem')).status).toBe(200);
    expect((await post('/api/software/modules/gem/install', { name: 'rails' })).status).toBe(202);
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

describe('Install Software (one-click runtimes and tools)', () => {
  it('catalog helpers resolve packages per family and refuse what is not in the catalog', () => {
    expect(resolveInstall({ runtime: 'php', version: '8.4' }, 'debian').packages).toEqual(RUNTIMES.php.debian('8.4'));
    expect(resolveInstall({ runtime: 'php', version: '8.4' }, 'rhel')).toMatchObject({ packages: expect.arrayContaining(['php84-php-fpm', 'php84-php-pecl-imagick']), repos: ['php', 'epel'] });
    expect(resolveInstall({ runtime: 'python', version: '3.11' }, 'debian').repos).toEqual(['python']);
    expect(resolveInstall({ runtime: 'composer' }, 'debian').repos).toEqual([]);
    expect(resolveInstall({ runtime: 'composer' }, 'rhel').repos).toEqual(['epel']);
    expect(resolveInstall({ runtime: 'ruby', version: '9.9' }, 'debian')).toMatchObject({ version: null, packages: ['ruby-full'] });
    expect(resolveInstall({ runtime: 'nodejs', version: '22' }, null)).toMatchObject({ installer: 'node', major: 22, packages: [] });
    expect(resolveInstall({ tool: 'bind' }, 'rhel').packages).toEqual(['bind', 'bind-utils']);
    expect(() => resolveInstall({ runtime: 'php', version: '5.6' }, 'debian')).toThrow(/not in the catalog/);
    expect(() => resolveInstall({ runtime: 'php' }, 'debian')).toThrow(/needs a version/);
    expect(() => resolveInstall({ runtime: 'php', version: '8.4' }, null)).toThrow(/No packages are known/);
    expect(resolveInstall({ runtime: 'php', version: '8.4' }, 'debian', { method: 'source' })).toMatchObject({ installer: 'php-source', minor: '8.4', deps: PHP_BUILD_DEPS.debian, packages: [], repos: [], prefix: '/opt/keel/php/8.4' });
    expect(resolveInstall({ runtime: 'php', version: '8.3' }, 'rhel', { method: 'source' })).toMatchObject({ deps: PHP_BUILD_DEPS.rhel, repos: ['epel', 'crb'] });
    expect(() => resolveInstall({ runtime: 'php', version: '7.4' }, 'rhel', { method: 'source' })).toThrow(/cannot be built from source/);
    expect(PHP_SOURCE_MINORS).toEqual(['8.1', '8.2', '8.3', '8.4', '8.5']);
    expect(PHP_BUILD_DEPS.debian).toEqual(expect.arrayContaining(['build-essential', 'xz-utils', 'libxml2-dev', 'libssl-dev', 'libonig-dev', 'libsodium-dev']));
    expect(PHP_BUILD_DEPS.rhel).toContain('xz');
    expect(() => resolveInstall({ runtime: 'php', version: '8.4' }, null, { method: 'source' })).toThrow(/needs a package manager/);
    expect(() => resolveInstall({ runtime: 'php', version: '5.6' }, 'debian', { method: 'source' })).toThrow(/not in the catalog/);
    expect(() => resolveInstall({ runtime: 'nodejs', version: '22' }, 'debian', { method: 'source' })).not.toThrow();
    expect(() => resolveInstall({ runtime: 'python', version: '3.12' }, 'debian', { method: 'source' })).toThrow(/no source build/);
    expect(detectedVersion('php', '8.4', { php: [{ id: '8.4', version: '8.4.27', layout: 'keel', source: true }] })).toMatchObject({ installed: true, version: '8.4.27', source: true, layout: 'keel' });
    expect(detectedVersion('php', '8.3', { php: [{ id: '8.3', version: '8.3.6' }] }).source).toBe(false);
    expect(() => resolveInstall({ tool: 'nope' }, 'debian')).toThrow(/Unknown tool/);
    expect(reposFor(RUNTIMES.composer, 'debian')).toEqual([]);
    expect(TOOLS.every((t) => Array.isArray(t.debian) && Array.isArray(t.rhel))).toBe(true);
    expect(detectedVersion('php', '8.3', { php: [{ id: 'ea-php83', version: '8.3.1' }] })).toMatchObject({ installed: true, version: '8.3.1' });
    expect(detectedVersion('nodejs', '20', { node: { versions: [{ major: 22 }] } }).installed).toBe(false);
    expect(detectedVersion('go', null, { go: null }).installed).toBe(false);
  });

  it('lists the catalog with installed state from one runtime detection and one package listing', async () => {
    installedPkgs.push({ name: 'git', version: '2.43', arch: 'amd64', summary: 'git' });
    app.agent.calls.length = 0;
    const res = await get('/api/software/runtimes');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ family: 'debian', manager: 'apt', capability: true, os: { id: 'ubuntu', family: 'debian' } });
    expect(d.runtimes.map((r) => r.key)).toEqual(['php', 'nodejs', 'python', 'ruby', 'go', 'composer']);
    const php = d.runtimes.find((r) => r.key === 'php');
    expect(php.versions.map((v) => [v.id, v.installed])).toEqual([['8.5', false], ['8.4', false], ['8.3', true], ['8.2', true], ['8.1', false], ['7.4', false]]);
    expect(php.versions.find((v) => v.id === '8.3')).toMatchObject({ label: 'PHP 8.3', version: '8.3.6', repo: 'php', packages: RUNTIMES.php.debian('8.3'), state: 'installed', method: 'package', source: false });
    expect(php.versions[0].note).toMatch(/ondrej/);
    expect(php.source).toBe(true);
    expect(php.versions[0]).toMatchObject({ state: 'available', method: 'package', repoStatus: { present: false, supported: true } });
    expect(app.agent.callsTo('pkg.repo.status').map((c) => c.args)).toEqual([{ repo: 'php' }]);
    const node = d.runtimes.find((r) => r.key === 'nodejs');
    expect(node.versions.find((v) => v.id === '22')).toMatchObject({ installed: true, version: 'v22.11.0', path: '/opt/keel/node/22', bin: '/usr/local/bin/node22', packages: [], repo: null });
    expect(node.versions.find((v) => v.id === '20')).toMatchObject({ installed: false, bin: '/usr/local/bin/node20' });
    expect(node.versions[0].note).toMatch(/\/opt\/keel\/node/);
    const python = d.runtimes.find((r) => r.key === 'python');
    expect(python.versions.find((v) => v.id === '3.12')).toMatchObject({ installed: true, version: '3.12.3', packages: ['python3.12', 'python3.12-venv', 'python3.12-dev'] });
    expect(python.versions.find((v) => v.id === '3.11').installed).toBe(false);
    expect(d.runtimes.find((r) => r.key === 'ruby')).toMatchObject({ single: true, versions: [{ id: 'ruby', installed: false, packages: ['ruby-full'] }] });
    // composer's EPEL repo is RHEL-only.
    expect(d.runtimes.find((r) => r.key === 'composer').versions[0].repo).toBeNull();
    expect(d.tools.find((t) => t.key === 'git')).toEqual({ key: 'git', label: 'Git', packages: ['git'], installed: true, update: null });
    expect(d.tools.find((t) => t.key === 'bind')).toMatchObject({ packages: ['bind9', 'bind9utils'], installed: false });
    expect(d.tools.find((t) => t.key === 'cpanminus').packages).toEqual(['cpanminus']);
    expect(app.agent.callsTo('pkg.runtime.detect')).toHaveLength(1);
    expect(app.agent.callsTo('pkg.list_installed')).toHaveLength(1);
    expect(app.agent.callsTo('pkg.list_installed')[0].args.prefix).toEqual(expect.arrayContaining(['git', 'bind9', 'clamav-daemon']));
  });

  it('installs a PHP version: repo.ensure -> update_index (only when added) -> pkg.install with the exact list -> CLI default restored', async () => {
    repoState.php = 'added';
    phpCliDefault = '8.3';
    // ondrej's alternatives pick the newest php on install; the panel puts the previous default back.
    app.agent.set('pkg.install', ({ packages }) => { installedPkgs = [...installedPkgs, ...packages.map((name) => ({ name, version: '1.0', arch: 'amd64', summary: 'installed by test' }))]; if (packages.includes('php8.4-fpm')) phpCliDefault = '8.4'; return { manager: 'apt', packages, output: [`Setting up ${packages.join(' ')}`] }; });
    app.agent.calls.length = 0;
    try {
      const res = await post('/api/software/runtimes/install', { runtime: 'php', version: '8.4' });
      expect(res.status).toBe(202);
      expect(res.body.data).toMatchObject({ target: 'php:8.4', job: { type: 'software.runtime.install' } });
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ runtime: 'php', version: '8.4', installed: true, detected: '8.4.6', packages: RUNTIMES.php.debian('8.4') });
      const order = app.agent.calls.map((c) => c.name).filter((n) => ['pkg.repo.ensure', 'pkg.update_index', 'pkg.install', 'pkg.php.default.set', 'pkg.runtime.detect'].includes(n));
      // The request detects what is on the host first (a distro tree or a Keel build is never installed over).
      expect(order).toEqual(['pkg.runtime.detect', 'pkg.repo.ensure', 'pkg.update_index', 'pkg.install', 'pkg.php.default.set', 'pkg.runtime.detect']);
      expect(app.agent.callsTo('pkg.repo.ensure').map((c) => c.args)).toEqual([{ repo: 'php' }]);
      expect(app.agent.callsTo('pkg.install').pop().args).toEqual({ packages: RUNTIMES.php.debian('8.4'), wait: false });
      expect(app.agent.callsTo('pkg.php.default.set').pop().args).toEqual({ version: '8.3' });
      expect(phpCliDefault).toBe('8.3');
      expect(job.logs.some((l) => /switched the php CLI default to 8\.4; restored 8\.3/.test(l.line))).toBe(true);
      expect(job.logs.some((l) => /repository php: added/.test(l.line))).toBe(true);
      expect(app.ctx.db.prepare("SELECT target FROM audit_log WHERE action = 'software.runtime.install' ORDER BY id DESC LIMIT 1").get().target).toBe('php:8.4');
      expect((await get('/api/software/runtimes')).body.data.runtimes.find((r) => r.key === 'php').versions.find((v) => v.id === '8.4')).toMatchObject({ installed: true, version: '8.4.6' });
      const recent = await get('/api/software/runtimes/recent');
      expect(recent.body.data[0]).toMatchObject({ id: job.id, type: 'software.runtime.install' });

      // Repo already present: no index refresh, and an unchanged CLI default is left alone.
      repoState.php = 'present';
      app.agent.calls.length = 0;
      const again = await waitForJob(app.ctx, (await post('/api/software/runtimes/install', { runtime: 'php', version: '8.1' })).body.data.job.id);
      expect(again.status).toBe('done');
      expect(app.agent.callsTo('pkg.update_index')).toHaveLength(0);
      expect(app.agent.callsTo('pkg.php.default.set')).toHaveLength(0);
      expect(app.agent.callsTo('pkg.install').pop().args.packages).toEqual(RUNTIMES.php.debian('8.1'));
    } finally {
      app.agent.set('pkg.install', ({ packages }) => { installedPkgs = [...installedPkgs, ...packages.filter((p) => !installedPkgs.some((i) => i.name === p)).map((name) => ({ name, version: '1.0', arch: 'amd64', summary: 'installed by test' }))]; return { manager: 'apt', packages, output: [`Setting up ${packages.join(' ')}`] }; });
    }
  });

  it('builds a PHP version from source when the repo has no packages: deps -> pkg.php.build (polled) -> finish -> detect', async () => {
    repoState.php = 'unsupported';
    phpCliDefault = '8.3';
    const runLines = ['php-8.5.33.tar.xz: sha256 verified', 'configure: creating ./config.status', 'make[1]: Leaving directory', 'Installing PHP SAPI module: fpm'];
    app.agent.set('pkg.php.build', ({ minor }) => ({ minor, background: true, run: { id: 'run-74', pid: 4242, logPath: '/var/log/whm/runs/run-74.log' } }));
    app.agent.set('pkg.run.status', ({ id, offset }) => ({ id, output: runLines.slice(offset), offset: runLines.length, done: true, status: 'finished', code: 0 }));
    app.agent.set('pkg.php.build.finish', ({ minor }) => { keelBuilds = [...keelBuilds, minor]; return { minor, version: `${minor}.33`, prefix: `/opt/keel/php/${minor}`, binary: `/opt/keel/php/${minor}/bin/php`, unit: `keel-php${minor}-fpm`, active: true, link: `/usr/local/bin/php${minor}` }; });
    app.agent.calls.length = 0;
    try {
      // Explicit packages on a repo without a series is refused before any job; so is a method on a non-PHP runtime.
      const pkgOnly = await post('/api/software/runtimes/install', { runtime: 'php', version: '8.5', method: 'package' });
      expect(pkgOnly.status).toBe(422);
      expect(pkgOnly.body.error.message).toMatch(/not available on this OS/);
      expect(pkgOnly.body.error.fields.method).toEqual(['source']);
      expect((await post('/api/software/runtimes/install', { runtime: 'nodejs', version: '22', method: 'source' })).status).toBe(422);
      expect((await post('/api/software/runtimes/install', { runtime: 'php', version: '8.5', method: 'tarball' })).status).toBe(422);
      // 7.4's last php.net release does not compile on current distributions: no method works, so the row is unsupported.
      const old = await post('/api/software/runtimes/install', { runtime: 'php', version: '7.4' });
      expect(old.status).toBe(422);
      expect(old.body.error.message).toMatch(/cannot be built from source/);
      expect((await post('/api/software/runtimes/install', { runtime: 'php', version: '7.4', method: 'package' })).body.error.fields.method).not.toEqual(['source']);
      expect(app.agent.callsTo('pkg.install')).toHaveLength(0);

      app.agent.calls.length = 0;
      const res = await post('/api/software/runtimes/install', { runtime: 'php', version: '8.5' });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body.data).toMatchObject({ target: 'php:8.5', method: 'source', prefix: '/opt/keel/php/8.5', packages: [], job: { type: 'software.runtime.install' } });
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status, job.error).toBe('done');
      expect(job.result).toMatchObject({ runtime: 'php', version: '8.5', installed: true, method: 'source', detected: '8.5.33', release: '8.5.33', prefix: '/opt/keel/php/8.5', unit: 'keel-php8.5-fpm', link: '/usr/local/bin/php8.5', binary: '/opt/keel/php/8.5/bin/php', packages: [], deps: PHP_BUILD_DEPS.debian });
      const order = app.agent.calls.map((c) => c.name).filter((n) => ['pkg.repo.ensure', 'pkg.update_index', 'pkg.install', 'pkg.php.build', 'pkg.run.status', 'pkg.php.build.finish', 'pkg.php.default.set', 'pkg.runtime.detect'].includes(n));
      expect(order).toEqual(['pkg.runtime.detect', 'pkg.install', 'pkg.php.build', 'pkg.run.status', 'pkg.php.build.finish', 'pkg.runtime.detect']);
      expect(app.agent.callsTo('pkg.install').pop().args).toEqual({ packages: PHP_BUILD_DEPS.debian, wait: false });
      expect(app.agent.callsTo('pkg.php.build').map((c) => c.args)).toEqual([{ minor: '8.5', wait: false }]);
      expect(app.agent.callsTo('pkg.php.build.finish').map((c) => c.args)).toEqual([{ minor: '8.5' }]);
      expect(app.agent.callsTo('pkg.run.status')[0].args).toMatchObject({ id: 'run-74', offset: 0 });
      // The build output streams into the job log; the finish step is logged with the unit and link.
      for (const line of runLines) expect(job.logs.some((l) => l.line === line), line).toBe(true);
      expect(job.logs.some((l) => /build dependencies \(debian\)/.test(l.line))).toBe(true);
      expect(job.logs.some((l) => /PHP 8\.5\.33 installed under \/opt\/keel\/php\/8\.5; unit keel-php8\.5-fpm active; CLI \/usr\/local\/bin\/php8\.5/.test(l.line))).toBe(true);
      expect(phpCliDefault).toBe('8.3');
      const audit = app.ctx.db.prepare("SELECT target, args_redacted AS args FROM audit_log WHERE action = 'software.runtime.install' ORDER BY id DESC LIMIT 1").get();
      expect(audit.target).toBe('php:8.5');
      expect(JSON.parse(audit.args)).toMatchObject({ method: 'source', packages: [] });
      // The runtime catalog shows the build as installed from source.
      const row = (await get('/api/software/runtimes')).body.data.runtimes.find((r) => r.key === 'php').versions.find((v) => v.id === '8.5');
      expect(row).toMatchObject({ installed: true, version: '8.5.33', state: 'installed', method: 'source', source: true, prefix: '/opt/keel/php/8.5' });
    } finally {
      repoState.php = 'present';
      keelBuilds = [];
    }
  });

  it('fails the job when the FPM unit of a finished build does not start', async () => {
    repoState.php = 'unsupported';
    app.agent.set('pkg.php.build', ({ minor }) => ({ minor, background: true, run: { id: 'run-82', pid: 4245, logPath: '/var/log/whm/runs/run-82.log' } }));
    app.agent.set('pkg.run.status', ({ id }) => ({ id, output: [], offset: 0, done: true, status: 'finished', code: 0 }));
    app.agent.set('pkg.php.build.finish', ({ minor }) => ({ minor, version: `${minor}.33`, prefix: `/opt/keel/php/${minor}`, binary: `/opt/keel/php/${minor}/bin/php`, unit: `keel-php${minor}-fpm`, active: false, unitError: 'Job for keel-php8.5-fpm.service failed because the control process exited with error code', link: null, linkConflict: '/usr/local/bin/php8.5 is not a symbolic link' }));
    app.agent.calls.length = 0;
    try {
      const job = await waitForJob(app.ctx, (await post('/api/software/runtimes/install', { runtime: 'php', version: '8.5', method: 'source' })).body.data.job.id);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/PHP 8\.5\.33 built but keel-php8\.5-fpm did not start: Job for keel-php8\.5-fpm\.service failed.*journalctl -u keel-php8\.5-fpm/);
      expect(job.logs.some((l) => l.level === 'warn' && /not a symbolic link/.test(l.line))).toBe(true);
      // Only the request's own detection ran; the failed job never re-detected.
      expect(app.agent.callsTo('pkg.runtime.detect')).toHaveLength(1);
    } finally {
      repoState.php = 'present';
    }
  });

  it('a failed build fails the job with the build output and never registers the unit', async () => {
    repoState.php = 'unsupported';
    const failing = ['checking for libzip... no', 'configure: error: Package requirements (libzip >= 0.11) were not met'];
    app.agent.set('pkg.php.build', ({ minor }) => ({ minor, background: true, run: { id: 'run-81', pid: 4243, logPath: '/var/log/whm/runs/run-81.log' } }));
    app.agent.set('pkg.run.status', ({ id, offset }) => ({ id, output: failing.slice(offset), offset: failing.length, done: true, status: 'finished', code: 2 }));
    app.agent.calls.length = 0;
    try {
      const job = await waitForJob(app.ctx, (await post('/api/software/runtimes/install', { runtime: 'php', version: '8.1', method: 'source' })).body.data.job.id);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/PHP 8\.1 build exited with status 2: configure: error: Package requirements \(libzip/);
      expect(app.agent.callsTo('pkg.php.build.finish')).toHaveLength(0);
      expect(app.agent.callsTo('pkg.runtime.detect')).toHaveLength(1);
      expect(job.logs.some((l) => l.line === failing[1])).toBe(true);
      // An op-level refusal (bad checksum) surfaces the agent's own message.
      app.agent.fail('pkg.php.build', 'checksum_mismatch', 'sha256 mismatch for php-8.1.31.tar.xz');
      app.agent.calls.length = 0;
      const bad = await waitForJob(app.ctx, (await post('/api/software/runtimes/install', { runtime: 'php', version: '8.1', method: 'source' })).body.data.job.id);
      expect(bad.status).toBe('failed');
      expect(bad.error).toMatch(/sha256 mismatch for php-8\.1\.31\.tar\.xz/);
      expect(app.agent.callsTo('pkg.php.build.finish')).toHaveLength(0);
      // A build log longer than the job keeps still ends with its last 40 lines when it fails.
      const long = Array.from({ length: 2100 }, (_, i) => `make line ${i + 1}`);
      app.agent.set('pkg.php.build', ({ minor }) => ({ minor, background: true, run: { id: 'run-long', pid: 4244, logPath: '/var/log/whm/runs/run-long.log' } }));
      app.agent.set('pkg.run.status', ({ id, offset }) => ({ id, output: long.slice(offset), offset: long.length, done: true, status: 'finished', code: 1 }));
      const tail = await waitForJob(app.ctx, (await post('/api/software/runtimes/install', { runtime: 'php', version: '8.1', method: 'source' })).body.data.job.id);
      expect(tail.status).toBe('failed');
      expect(tail.logs.some((l) => /last 40 lines/.test(l.line))).toBe(true);
      expect(tail.logs.filter((l) => l.line === 'make line 2100')).toHaveLength(1);
      expect(tail.logs.some((l) => l.line === 'make line 2050')).toBe(false);
    } finally {
      repoState.php = 'present';
    }
  });

  it('installs and removes a Node.js major through pkg.node.* without touching distro packages', async () => {
    app.agent.calls.length = 0;
    const res = await post('/api/software/runtimes/install', { runtime: 'nodejs', version: '20' });
    expect(res.status).toBe(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ runtime: 'nodejs', version: '20', installed: true, detected: 'v20.0.0', path: '/opt/keel/node/20', symlinks: ['/usr/local/bin/node20', '/usr/local/bin/npm20', '/usr/local/bin/npx20'] });
    expect(app.agent.callsTo('pkg.node.install').map((c) => c.args)).toEqual([{ major: 20, wait: false }]);
    expect(app.agent.callsTo('pkg.install')).toHaveLength(0);
    expect(app.agent.callsTo('pkg.repo.ensure')).toHaveLength(0);
    expect(job.logs.some((l) => l.line.includes('installed under /opt/keel/node/20'))).toBe(true);
    expect((await get('/api/software/runtimes')).body.data.runtimes.find((r) => r.key === 'nodejs').versions.find((v) => v.id === '20')).toMatchObject({ installed: true, version: 'v20.0.0' });
    const rm = await post('/api/software/runtimes/remove', { runtime: 'nodejs', version: '20' });
    expect(rm.status).toBe(202);
    const removed = await waitForJob(app.ctx, rm.body.data.job.id);
    expect(removed.status).toBe('done');
    expect(removed.result).toMatchObject({ runtime: 'nodejs', version: '20', removed: true });
    expect(app.agent.callsTo('pkg.node.remove').pop().args).toEqual({ major: 20 });
    expect((await get('/api/software/runtimes')).body.data.runtimes.find((r) => r.key === 'nodejs').versions.find((v) => v.id === '20').installed).toBe(false);
    expect((await get('/api/software/runtimes/recent')).body.data.map((j) => j.type).slice(0, 2)).toEqual(['software.runtime.remove', 'software.runtime.install']);
  });

  it('fails the job with the repository message when the distribution has no repo for it, installing nothing', async () => {
    app.agent.calls.length = 0;
    const res = await post('/api/software/runtimes/install', { runtime: 'python', version: '3.11' });
    expect(res.status).toBe(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Python 3\.11 cannot be installed on this distribution: Debian ships one Python version/);
    expect(app.agent.callsTo('pkg.install')).toHaveLength(0);
    expect(app.agent.callsTo('pkg.update_index')).toHaveLength(0);
    // A runtime still missing after the installer finished is a failure, not a silent "done".
    app.agent.set('pkg.runtime.detect', () => ({ ...detectRuntimes(), ruby: null }));
    try {
      const ruby = await waitForJob(app.ctx, (await post('/api/software/runtimes/install', { runtime: 'ruby' })).body.data.job.id);
      expect(ruby.status).toBe('failed');
      expect(ruby.error).toMatch(/Ruby is still not detected/);
      expect(app.agent.callsTo('pkg.install').pop().args.packages).toEqual(['ruby-full']);
    } finally { app.agent.set('pkg.runtime.detect', () => detectRuntimes()); }
  });

  it('installs a catalog tool with the host family packages', async () => {
    const res = await post('/api/software/runtimes/install', { tool: 'bind' });
    expect(res.status).toBe(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ tool: 'bind', packages: ['bind9', 'bind9utils'], installed: true });
    expect(app.agent.callsTo('pkg.install').pop().args.packages).toEqual(['bind9', 'bind9utils']);
    expect((await get('/api/software/runtimes')).body.data.tools.find((t) => t.key === 'bind').installed).toBe(true);
    expect(app.ctx.db.prepare("SELECT target FROM audit_log WHERE action = 'software.runtime.install' ORDER BY id DESC LIMIT 1").get().target).toBe('bind');
  });

  it('refuses versions outside the catalog and malformed bodies with 422 before any job', async () => {
    const before = app.ctx.jobs.list({ limit: 500 }).length;
    for (const body of [{ runtime: 'php', version: '5.6' }, { runtime: 'php' }, { runtime: 'nodejs', version: '21' }, { runtime: 'python', version: '2.7' }, { runtime: 'php', version: '8.4', tool: 'git' }, {}, { tool: 'git', version: '1' }, { tool: 'vim' }, { runtime: 'perl' }, { runtime: 'php', version: '8.4;id' }, { runtime: 'php', version: '8.4', extra: true }]) {
      expect((await post('/api/software/runtimes/install', body)).status, JSON.stringify(body)).toBe(422);
    }
    for (const body of [{ runtime: 'php', version: '8.2' }, { runtime: 'nodejs' }, { runtime: 'nodejs', version: '99' }, { runtime: 'nodejs', version: '22', purge: true }]) {
      expect((await post('/api/software/runtimes/remove', body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(app.ctx.jobs.list({ limit: 500 }).length).toBe(before);
    // Single runtimes ignore the version.
    const ruby = await post('/api/software/runtimes/install', { runtime: 'ruby', version: '3.3' });
    expect(ruby.status).toBe(202);
    expect((await waitForJob(app.ctx, ruby.body.data.job.id)).result).toMatchObject({ runtime: 'ruby', version: null, packages: ['ruby-full'] });
  });

  it('the catalog never fails without a package manager, and package installs answer 501 there', async () => {
    await provision(false);
    try {
      const res = await get('/api/software/runtimes');
      expect(res.status).toBe(200);
      expect(res.body.data.capability).toBe(false);
      expect(res.body.data.tools.every((t) => t.installed === null)).toBe(true);
      expect((await post('/api/software/runtimes/install', { runtime: 'php', version: '8.4' })).status).toBe(501);
      expect((await post('/api/software/runtimes/install', { tool: 'git' })).status).toBe(501);
    } finally { await provision(true); }
  });

  it('module installers carry the distro packages that bring each installer', async () => {
    const inst = await get('/api/software/modules/installers');
    expect(inst.body.data.family).toBe('debian');
    expect(inst.body.data.packages).toEqual({ php: ['php-pear', 'php-dev'], perl: ['cpanminus'], ruby: ['ruby-full'], python3: ['python3-pip'] });
  });
});

describe('System Update', () => {
  it('shows pending updates and runs the upgrade job', async () => {
    app.ctx.settings.set('software.updates.last_check', null);
    app.agent.calls.length = 0;
    // No recorded check yet: the first page load runs the simulation once and records it.
    const status = await get('/api/software/update/status');
    expect(status.body.data).toMatchObject({ count: 2, security: 1, autoApply: false, source: 'live', manager: 'apt' });
    expect(status.body.data.packages.map((p) => p.name)).toEqual(['libssl3', 'vim']);
    expect(app.agent.callsTo('pkg.upgradable')).toHaveLength(1);
    // Later page loads serve the recorded check instead of a minutes-long simulation; ?refresh=true runs it again.
    const cached = await get('/api/software/update/status');
    expect(cached.body.data).toMatchObject({ count: 2, security: 1, source: 'cached', checkedAt: status.body.data.checkedAt });
    expect(cached.body.data.packages.map((p) => p.name)).toEqual(['libssl3', 'vim']);
    expect(app.agent.callsTo('pkg.upgradable')).toHaveLength(1);
    expect(app.agent.callsTo('pkg.reboot_required').length).toBeGreaterThanOrEqual(1);
    expect((await get('/api/software/update/status?refresh=true')).body.data.source).toBe('live');
    expect(app.agent.callsTo('pkg.upgradable')).toHaveLength(2);
    expect((await get('/api/software/update/status?refresh=maybe')).status).toBe(422);
    // Programmatic consumers (Security Advisor) get a live answer unless they ask for the cache.
    expect((await app.ctx.software.update.status()).source).toBe('live');
    expect((await app.ctx.software.update.status({ cached: true })).source).toBe('cached');
    const run = await post('/api/software/update/run', { autoremove: true });
    expect(run.status).toBe(202);
    const job = await waitForJob(app.ctx, run.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ upgraded: 2, rebootRequired: true });
    expect(job.logs.some((l) => l.line.includes('libssl3') && l.line.includes('[security]'))).toBe(true);
    expect(job.logs.some((l) => l.level === 'warn' && /reboot/i.test(l.line))).toBe(true);
    expect(app.agent.callsTo('pkg.update_index').length).toBeGreaterThanOrEqual(1);
    expect(app.agent.callsTo('pkg.upgrade').pop().args).toMatchObject({ dist: true, autoremove: true });
    // What is still pending comes from a fresh simulation after the upgrade (the mock still answers 2), never from an assumed zero.
    expect(job.result.stillPending).toBe(2);
    expect(app.ctx.settings.get('software.updates.last_check')).toMatchObject({ count: 2, security: 1, rebootRequired: true });
    const partial = await post('/api/software/update/run', { packages: ['vim'], refreshIndex: false });
    const partialJob = await waitForJob(app.ctx, partial.body.data.job.id);
    expect(partialJob.status).toBe('done');
    expect(partialJob.result).toMatchObject({ upgraded: 1, packages: ['vim'], stillPending: 2 });
    expect(app.agent.callsTo('pkg.upgrade').pop().args.packages).toEqual(['vim']);
    expect((await put('/api/software/update/auto', { autoApply: true })).body.data.autoApply).toBe(true);
    expect((await get('/api/software/update/status')).body.data.autoApply).toBe(true);
  });

  it('the nightly check refreshes the index, records pending counts and queues the upgrade when auto-apply is on', async () => {
    app.agent.calls.length = 0;
    const check = app.ctx.jobs.enqueue('software.update.check', {});
    const job = await waitForJob(app.ctx, check.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ count: 2, security: 1 });
    // Without a refreshed index the simulation only knows what the last apt-get update saw.
    expect(app.agent.calls.filter((c) => ['pkg.update_index', 'pkg.upgradable'].includes(c.name)).map((c) => c.name).slice(0, 2)).toEqual(['pkg.update_index', 'pkg.upgradable']);
    expect(job.result.autoJobId).toBeTruthy();
    expect((await waitForJob(app.ctx, job.result.autoJobId)).status).toBe('done');
    // The queued upgrade ran and re-checked what is still pending afterwards.
    expect(app.ctx.settings.get('software.updates.last_check')).toMatchObject({ count: 2, security: 1 });
    expect(app.ctx.settings.get('software.updates.last_check').packages.map((p) => p.name)).toEqual(['libssl3', 'vim']);
    // An index refresh failure is logged, not fatal.
    app.agent.fail('pkg.update_index', 'command_failed', 'Could not get lock /var/lib/apt/lists/lock');
    const degraded = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.update.check', {}).id);
    expect(degraded.status).toBe('done');
    expect(degraded.logs.some((l) => l.level === 'warn' && /index refresh failed/.test(l.line))).toBe(true);
    app.agent.set('pkg.update_index', () => ({ manager: 'apt', output: ['Hit:1 http://archive.ubuntu.com noble InRelease'] }));
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

  it('never echoes or audits the credentials of a basic-auth feed URL', async () => {
    const secret = updateUrl.replace('http://', 'http://feeduser:s3cretpass@');
    const saved = await put('/api/software/panel/update/settings', { url: `${secret}/latest.json` });
    expect(saved.status).toBe(200);
    expect(saved.body.data.updateUrl).toBe(`${updateUrl}/latest.json`);
    expect(saved.body.data.updateUrlHasCredentials).toBe(true);
    feedRequests.length = 0;
    const checked = await post('/api/software/panel/update/check');
    expect(checked.body.data.latest.version).toBe('9.9.0');
    // fetch() refuses URLs with userinfo, so the credentials travel as a header.
    expect(feedRequests).toEqual([{ url: '/latest.json', authorization: `Basic ${Buffer.from('feeduser:s3cretpass').toString('base64')}` }]);
    expect(JSON.stringify(checked.body.data)).not.toMatch(/s3cretpass|feeduser/);
    expect(JSON.stringify(await get('/api/software/panel/update').then((r) => r.body))).not.toMatch(/s3cretpass/);
    const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action IN ('software.panel.check', 'software.panel.settings')").all().map((r) => r.args_redacted).join('\n');
    expect(audit).toContain(`${updateUrl}/latest.json`);
    expect(audit).not.toMatch(/s3cretpass|feeduser/);
    expect(app.ctx.settings.get('software.update_url')).toBe(`${secret}/latest.json`);
    await put('/api/software/panel/update/settings', { url: `${updateUrl}/latest.json` });
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

describe('PHP Version Manager', () => {
  const REPO_404 = { repo: 'php', family: 'debian', present: false, supported: false, detail: 'ppa:ondrej/php has no packages for Ubuntu 26.04 resolute; the distribution ships its own versions only' };
  const stockVersions = () => ({ versions: [PHP, PHP82], defaultId: phpCliDefault, defaultBinary: `/usr/bin/php${phpCliDefault}` });

  it('registers the removal job and keeps the PHP routes root-only', async () => {
    expect(app.ctx.jobs.types()).toContain('software.php.remove');
    expect((await reseller.get('/api/software/php/catalog')).status).toBe(403);
    expect((await reseller.get('/api/software/php/usage')).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/software/php/offered', { versions: ['8.3'] }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/software/php/remove', { version: '8.2' }, resellerCsrf)).status).toBe(403);
  });

  it('lists every catalog version with its state from one repo probe, appending installed extras', async () => {
    await put('/api/software/php/default', { version: '8.3' });
    await put('/api/software/php/domains', { domains: ['alice.com', 'bob.com'], version: null });
    app.agent.set('pkg.repo.status', () => REPO_404);
    app.agent.set('pkg.php.versions', () => ({ ...stockVersions(), versions: [PHP, PHP82, { id: 'system', label: 'System PHP', binary: '/usr/bin/php', layout: 'unknown', version: '8.6.1', iniPath: null, fpmUnit: 'php-fpm', isDefault: false, fpmActive: null, fpmInstalled: false }] }));
    app.agent.calls.length = 0;
    try {
      const res = await get('/api/software/php/catalog');
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d).toMatchObject({ family: 'debian', manager: 'apt', capability: true, phpCapability: true, effectiveDefault: '8.3', offered: null });
      // No PPA series for this OS: every missing version is still installable, as a php.net source build.
      expect(d.versions.map((v) => [v.id, v.state, v.method])).toEqual([['8.5', 'available', 'source'], ['8.4', 'available', 'source'], ['8.3', 'installed', 'package'], ['8.2', 'installed', 'package'], ['8.1', 'available', 'source'], ['7.4', 'unsupported', null], ['system', 'installed', 'package']]);
      expect(d.versions.find((v) => v.id === '7.4').note).toMatch(/last 7\.4 release does not compile/);
      const v83 = d.versions.find((v) => v.id === '8.3');
      expect(v83).toMatchObject({ catalogVersion: '8.3', label: 'PHP 8.3', installed: true, version: '8.3.6', binary: '/usr/bin/php8.3', fpmUnit: 'php8.3-fpm', fpmActive: true, isDefault: true, isSystemDefault: true, offered: true, domains: 0, repo: 'php', repoStatus: { present: false, supported: false }, source: false, layout: 'debian' });
      expect(v83.packages).toEqual(RUNTIMES.php.debian('8.3'));
      expect(v83.advisories.length).toBeGreaterThan(0);
      const v84 = d.versions.find((v) => v.id === '8.4');
      expect(v84).toMatchObject({ installed: false, offered: false, isSystemDefault: false, domains: 0, binary: null, source: false, prefix: '/opt/keel/php/8.4', packages: [] });
      expect(v84.note).toMatch(/Built from the official php\.net source into \/opt\/keel\/php\/8\.4 \(about 15 minutes\); packages from ppa:ondrej\/php are not available for ubuntu 26\.04/);
      expect(v84.note).toMatch(/no packages for Ubuntu 26.04 resolute/);
      expect(d.versions.find((v) => v.id === 'system')).toMatchObject({ catalogVersion: null, state: 'installed', installed: true, version: '8.6.1', offered: true, packages: [], repo: null, repoStatus: null });
      expect(app.agent.callsTo('pkg.repo.status')).toHaveLength(1);
      expect(app.agent.callsTo('pkg.repo.status')[0].args).toEqual({ repo: 'php' });
      expect(app.agent.callsTo('pkg.php.versions')).toHaveLength(1);
      expect(app.agent.callsTo('pkg.runtime.detect')).toHaveLength(1);
      // A probe that fails (offline) or cannot say still leaves the row installable, from source.
      app.agent.fail('pkg.repo.status', 'command_failed', 'curl: (6) could not resolve host');
      const offline = (await get('/api/software/php/catalog')).body.data;
      expect(offline.versions.find((v) => v.id === '8.4')).toMatchObject({ state: 'available', method: 'source', repoStatus: null });
      expect(offline.versions.find((v) => v.id === '8.3').state).toBe('installed');
      app.agent.set('pkg.repo.status', () => ({ repo: 'php', family: 'debian', present: false, supported: null, detail: 'ppa:ondrej/php could not be checked: probe failed (curl exit 6)' }));
      const unknown = (await get('/api/software/php/catalog')).body.data.versions.find((v) => v.id === '8.4');
      expect(unknown).toMatchObject({ state: 'available', method: 'source', note: expect.stringMatching(/probe failed \(curl exit 6\)/) });
      app.agent.set('pkg.repo.status', () => ({ repo: 'php', family: 'debian', present: true, supported: true, detail: 'ppa:ondrej/php in ondrej.list' }));
      const online = (await get('/api/software/php/catalog')).body.data;
      expect(online.versions.find((v) => v.id === '8.4')).toMatchObject({ state: 'available', method: 'package', packages: RUNTIMES.php.debian('8.4'), note: expect.stringMatching(/ondrej/) });
      expect(online.versions.find((v) => v.id === '8.4').prefix).toBeUndefined();
      // Only a host without any package manager keeps a version unsupported.
      await provision(false);
      try {
        const none = (await get('/api/software/php/catalog')).body.data;
        expect(none.versions.find((v) => v.id === '8.4')).toMatchObject({ state: 'unsupported', method: null, note: expect.stringMatching(/package manager/) });
      } finally { await provision(true); }
    } finally {
      app.agent.set('pkg.php.versions', stockVersions);
      app.agent.set('pkg.repo.status', () => REPO_404);
    }
  });

  it('the offered list is a panel-only filter persisted as a setting and validated against installed versions', async () => {
    const res = await put('/api/software/php/offered', { versions: ['8.3'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ offered: ['8.3'] });
    expect(app.ctx.settings.get('php.offered_versions')).toEqual(['8.3']);
    expect(app.ctx.software.php.offeredVersions()).toEqual(['8.3']);
    const cat = (await get('/api/software/php/catalog')).body.data;
    expect(cat.offered).toEqual(['8.3']);
    expect(cat.versions.filter((v) => v.installed).map((v) => [v.id, v.offered])).toEqual([['8.3', true], ['8.2', false]]);
    // Root and reseller listings are untouched: offering is the account panel's filter.
    expect((await get('/api/software/php/versions')).body.data.versions.map((v) => v.id)).toEqual(['8.3', '8.2']);
    expect((await reseller.get('/api/software/php/versions')).body.data.versions.map((v) => v.id)).toEqual(['8.3', '8.2']);
    const bad = await put('/api/software/php/offered', { versions: ['8.3', '8.4'] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields).toHaveProperty('versions');
    expect((await put('/api/software/php/offered', { versions: ['8.3', 'x;y'] })).status).toBe(422);
    expect((await put('/api/software/php/offered', { versions: ['8.3'], extra: true })).status).toBe(422);
    expect(app.ctx.settings.get('php.offered_versions')).toEqual(['8.3']);
    expect((await put('/api/software/php/offered', { versions: null })).body.data).toEqual({ offered: null });
    expect(app.ctx.software.php.offeredVersions()).toBeNull();
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'software.php.offered'").get().n).toBeGreaterThanOrEqual(2);
  });

  it('counts pinned domains per version and refuses to remove the default, a used version or an unknown one', async () => {
    await put('/api/software/php/domains', { domains: ['bob.com'], version: '8.2' });
    expect((await get('/api/software/php/usage')).body.data).toEqual({ '8.2': 1 });
    expect((await get('/api/software/php/catalog')).body.data.versions.find((v) => v.id === '8.2').domains).toBe(1);
    const def = await post('/api/software/php/remove', { version: '8.3' });
    expect(def.status).toBe(422);
    expect(def.body.error.message).toMatch(/system default/);
    const used = await post('/api/software/php/remove', { version: '8.2' });
    expect(used.status).toBe(422);
    expect(used.body.error.message).toMatch(/1 domain/);
    expect((await post('/api/software/php/remove', { version: '9.9' })).status).toBe(422);
    expect((await post('/api/software/php/remove', { version: 'x;y' })).status).toBe(422);
    expect((await post('/api/software/php/remove', { version: '8.2', purge: true })).status).toBe(422);
    expect(app.agent.callsTo('pkg.php.remove')).toHaveLength(0);
    await put('/api/software/php/domains', { domains: ['bob.com'], version: null });
  });

  it('refuses the CLI default when it differs from the configured default', async () => {
    phpCliDefault = '8.2';
    app.agent.set('pkg.php.versions', () => ({ ...stockVersions(), versions: [PHP, PHP82].map((v) => ({ ...v, isDefault: v.id === phpCliDefault })) }));
    try {
      expect((await get('/api/software/php/catalog')).body.data.versions.find((v) => v.id === '8.2')).toMatchObject({ isDefault: true, isSystemDefault: false });
      const res = await post('/api/software/php/remove', { version: '8.2' });
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/CLI default/);
      expect(res.body.error.fields.version[0]).toMatch(/default first/);
      expect(app.agent.callsTo('pkg.php.remove')).toHaveLength(0);
    } finally { phpCliDefault = '8.3'; app.agent.set('pkg.php.versions', stockVersions); }
  });

  it('refuses the Apache web default, a package default and a rendered vhost version, and the catalog carries the counts', async () => {
    const prevWeb = app.ctx.web;
    let pinned = '8.2'; let vhosts = 2;
    app.ctx.web = { apache: { settings: () => ({ defaultPhpVersion: pinned }) }, vhostsUsingPhp: (version) => (version === '8.2' ? vhosts : 0) };
    try {
      const web = await post('/api/software/php/remove', { version: '8.2' });
      expect(web.status).toBe(422);
      expect(web.body.error.message).toMatch(/Apache Configuration/);
      pinned = null;
      app.ctx.db.prepare("INSERT INTO packages (name, php_version) VALUES ('php82-plan', '8.2')").run();
      const plans = await post('/api/software/php/remove', { version: '8.2' });
      expect(plans.status).toBe(422);
      expect(plans.body.error.message).toMatch(/1 package\(s\)/);
      const cat = (await get('/api/software/php/catalog')).body.data.versions.find((v) => v.id === '8.2');
      expect(cat).toMatchObject({ webDefault: false, plans: 1, vhosts: 2, domains: 0 });
      expect((await get('/api/software/php/catalog')).body.data.versions.find((v) => v.id === '8.4')).toMatchObject({ webDefault: false, plans: 0, vhosts: 0 });
      app.ctx.db.prepare("DELETE FROM packages WHERE name = 'php82-plan'").run();
      const vh = await post('/api/software/php/remove', { version: '8.2' });
      expect(vh.status).toBe(422);
      expect(vh.body.error.message).toMatch(/2 web vhost/);
      vhosts = 0;
      expect(await app.ctx.software.php.removeBlocker('8.2')).toBeNull();
      expect(app.agent.callsTo('pkg.php.remove')).toHaveLength(0);
    } finally { app.ctx.web = prevWeb; }
  });

  it('the removal job re-checks the guards when it runs, not only when the request was accepted', async () => {
    await put('/api/software/php/domains', { domains: ['bob.com'], version: '8.2' });
    app.agent.calls.length = 0;
    const job = { params: { version: '8.2' }, progress() {}, log() {} };
    try {
      await expect(app.ctx.software.php.removeJob(job)).rejects.toThrow(/pinned on 1 domain/);
      expect(app.agent.callsTo('pkg.php.remove')).toHaveLength(0);
    } finally { await put('/api/software/php/domains', { domains: ['bob.com'], version: null }); }
  });

  it('removes a free version through a job: pkg.php.remove, capability refresh, offered list pruned', async () => {
    await put('/api/software/php/offered', { versions: ['8.3', '8.2'] });
    app.agent.set('pkg.php.remove', ({ version, purge }) => ({ version, manager: 'apt', packages: [`php${version}-cli`, `php${version}-fpm`], purge, output: [`Removing php${version}-cli`] }));
    app.agent.calls.length = 0;
    const res = await post('/api/software/php/remove', { version: '8.2' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.data).toMatchObject({ version: '8.2', job: { type: 'software.php.remove' } });
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toEqual({ version: '8.2', packages: ['php8.2-cli', 'php8.2-fpm'], removed: true });
    // The request simulates first (dry), the job removes.
    expect(app.agent.callsTo('pkg.php.remove').map((c) => c.args)).toEqual([{ version: '8.2', dry: true }, { version: '8.2', wait: false }]);
    expect(res.body.data).toMatchObject({ extra: [], forced: false });
    expect(JSON.parse(app.ctx.db.prepare("SELECT args_redacted AS args FROM audit_log WHERE action = 'software.php.remove' AND target = '8.2' ORDER BY id DESC LIMIT 1").get().args)).toMatchObject({ force: false, forced: false, extra: [] });
    const names = app.agent.calls.map((c) => c.name);
    expect(names.indexOf('sys.binaries')).toBeGreaterThan(names.indexOf('pkg.php.remove'));
    expect(app.ctx.software.php.offeredVersions()).toEqual(['8.3']);
    expect(app.ctx.db.prepare("SELECT 1 AS x FROM audit_log WHERE action = 'software.php.remove' AND target = '8.2'").get()).toBeTruthy();
    await put('/api/software/php/offered', { versions: null });
  });

  it('shows an installed Keel build as a source version and removes it through pkg.php.remove', async () => {
    keelBuilds = ['7.4'];
    app.agent.set('pkg.php.versions', () => ({ ...stockVersions(), versions: [PHP, PHP82, keelVersion('7.4')] }));
    app.agent.set('pkg.php.remove', ({ version }) => { keelBuilds = keelBuilds.filter((m) => m !== version); return { version, layout: 'keel', prefix: `/opt/keel/php/${version}`, unit: `keel-php${version}-fpm`, link: `/usr/local/bin/php${version}`, packages: [], removed: true, output: [`removed /opt/keel/php/${version}`] }; });
    app.agent.calls.length = 0;
    try {
      const row = (await get('/api/software/php/catalog')).body.data.versions.find((v) => v.id === '7.4');
      expect(row).toMatchObject({ catalogVersion: '7.4', state: 'installed', installed: true, source: true, layout: 'keel', method: 'source', label: 'PHP 7.4 (Keel build)', version: '7.4.33', binary: '/opt/keel/php/7.4/bin/php', prefix: '/opt/keel/php/7.4', fpmUnit: 'keel-php7.4-fpm', iniPath: '/opt/keel/php/7.4/lib/php.ini', offered: true, packages: [] });
      expect((await get('/api/software/php/versions')).body.data.versions.map((v) => v.id)).toEqual(['8.3', '8.2', '7.4']);
      const res = await post('/api/software/php/remove', { version: '7.4' });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status, job.error).toBe('done');
      expect(job.result).toEqual({ version: '7.4', packages: [], removed: true, layout: 'keel', prefix: '/opt/keel/php/7.4' });
      expect(app.agent.callsTo('pkg.php.remove').map((c) => c.args)).toEqual([{ version: '7.4', dry: true }, { version: '7.4', wait: false }]);
      expect(app.agent.callsTo('pkg.remove')).toHaveLength(0);
      expect(keelBuilds).toEqual([]);
    } finally {
      keelBuilds = [];
      app.agent.set('pkg.php.versions', stockVersions);
    }
  });

  it('refuses a removal the package manager would widen beyond php<ver>-* (roundcube-core, phpmyadmin) unless forced, and audits the force', async () => {
    const removals = [];
    app.agent.set('pkg.php.remove', ({ version, dry, force, purge }) => {
      const extra = ['roundcube-core', 'phpmyadmin'];
      if (dry) return { version, layout: 'debian', manager: 'apt', packages: [`php${version}-cli`, `php${version}-fpm`], purge: Boolean(purge), dry: true, remove: [`php${version}-cli`, `php${version}-fpm`, ...extra], extra, output: ['Remv php8.2-cli', 'Remv roundcube-core', 'Remv phpmyadmin'] };
      if (!force) throw Object.assign(new Error(`Removing PHP ${version} would also remove ${extra.join(', ')}; move what depends on it to another version first, or force the removal`), { agentError: true, code: 'refused', details: { version, extra } });
      removals.push({ version, force });
      return { version, manager: 'apt', packages: [`php${version}-cli`, `php${version}-fpm`], purge: Boolean(purge), forced: true, extra, output: ['Removing roundcube-core'] };
    });
    app.agent.calls.length = 0;
    try {
      const res = await post('/api/software/php/remove', { version: '8.2' });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error.message).toBe('Removing PHP 8.2 would also remove roundcube-core, phpmyadmin — move webmail and phpMyAdmin to another version first, or force the removal');
      expect(res.body.error.fields.version[0]).toMatch(/roundcube-core, phpmyadmin/);
      expect(res.body.error.fields.extra).toEqual(['roundcube-core', 'phpmyadmin']);
      expect(app.agent.callsTo('pkg.php.remove').map((c) => c.args)).toEqual([{ version: '8.2', dry: true }]);
      expect(app.ctx.jobs.list({ limit: 5 }).some((j) => j.type === 'software.php.remove' && j.status === 'queued')).toBe(false);
      expect(app.ctx.software.php.collateralMessage('8.5', ['libapache2-mod-php8.5x', 'roundcube-core'])).toBe('Removing PHP 8.5 would also remove libapache2-mod-php8.5x, roundcube-core — move webmail and whatever else depends on it to another version first, or force the removal');
      expect(app.ctx.software.php.collateralMessage('8.5', ['foo'])).toMatch(/move what depends on it to another version first/);
      // force is a boolean, nothing else; a reseller cannot force either (route is root-only).
      expect((await post('/api/software/php/remove', { version: '8.2', force: 'yes' })).status).toBe(422);
      expect((await mutate(reseller, 'post', '/api/software/php/remove', { version: '8.2', force: true }, resellerCsrf)).status).toBe(403);
      app.agent.calls.length = 0;
      const forced = await post('/api/software/php/remove', { version: '8.2', force: true });
      expect(forced.status, JSON.stringify(forced.body)).toBe(202);
      expect(forced.body.data).toMatchObject({ version: '8.2', extra: ['roundcube-core', 'phpmyadmin'], forced: true, job: { type: 'software.php.remove', params: { version: '8.2', force: true } } });
      const job = await waitForJob(app.ctx, forced.body.data.job.id);
      expect(job.status, job.error).toBe('done');
      expect(job.result).toEqual({ version: '8.2', packages: ['php8.2-cli', 'php8.2-fpm'], removed: true, extra: ['roundcube-core', 'phpmyadmin'], forced: true });
      expect(job.logs.some((l) => l.level === 'warn' && /forced: packages outside PHP 8\.2/.test(l.line))).toBe(true);
      expect(app.agent.callsTo('pkg.php.remove').map((c) => c.args)).toEqual([{ version: '8.2', dry: true }, { version: '8.2', force: true, wait: false }]);
      expect(removals).toEqual([{ version: '8.2', force: true }]);
      const audit = app.ctx.db.prepare("SELECT args_redacted AS args FROM audit_log WHERE action = 'software.php.remove' AND target = '8.2' ORDER BY id DESC LIMIT 1").get();
      expect(JSON.parse(audit.args)).toMatchObject({ force: true, forced: true, extra: ['roundcube-core', 'phpmyadmin'], jobId: job.id });
      // The job re-runs the guard itself: a queued job without force meets the agent's refusal.
      const stale = { params: { version: '8.2' }, progress() {}, log() {}, agent: app.agent };
      await expect(app.ctx.software.php.removeJob(stale)).rejects.toThrow(/would also remove roundcube-core, phpmyadmin/);
    } finally {
      app.agent.reset('pkg.php.remove');
    }
  });

  it('refuses the version the hostname site applications (webmail, phpMyAdmin) run on', async () => {
    let socket = '/run/php/php8.2-fpm.sock';
    let apps = [{ name: 'webmail', alias: '/webmail', root: '/usr/share/roundcube', php: true, managed: true, path: '/etc/apache2/keel-host.d/webmail.conf' }, { name: 'phpmyadmin', alias: '/phpmyadmin', root: '/usr/share/phpmyadmin', php: true, managed: true, path: '/etc/apache2/keel-host.d/phpmyadmin.conf' }];
    app.agent.set('web.host.status', () => ({ installed: true, exists: true, enabled: true, managed: true, hostname: 'nova.example.test', meta: {}, ssl: true, certificate: null, docroot: '/var/www/keel-host', docrootExists: true, phpSocket: socket, appsDir: '/etc/apache2/keel-host.d', apps }));
    app.agent.set('web.host.app.list', () => ({ appsDir: '/etc/apache2/keel-host.d', vhostPresent: true, apps }));
    app.agent.calls.length = 0;
    try {
      expect(typeof app.ctx.web?.hostApps?.list).toBe('function');
      const res = await post('/api/software/php/remove', { version: '8.2' });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error.message).toMatch(/runs the hostname site's webmail and phpMyAdmin/);
      expect(res.body.error.fields.version[0]).toBe('webmail and phpMyAdmin run on this version');
      expect(app.agent.callsTo('pkg.php.remove')).toHaveLength(0);
      // The site renders another version's socket: 8.2 is free again.
      socket = '/run/php/php8.3-fpm.sock';
      expect(await app.ctx.software.php.removeBlocker('8.2')).toBeNull();
      // No socket known: the distribution default is what the host apps run on.
      socket = null;
      expect(await app.ctx.software.php.hostAppsPhpVersion([PHP, PHP82], '8.3')).toBe('8.3');
      expect(await app.ctx.software.php.removeBlocker('8.2')).toBeNull();
      // A static application (php: false) never pins a version; a Remi socket maps through its id.
      socket = '/var/opt/remi/php82/run/php-fpm/www.sock';
      expect(await app.ctx.software.php.hostAppsPhpVersion([{ id: 'php82' }, PHP], '8.3')).toBe('php82');
      apps = [{ name: 'docs', alias: '/docs', root: '/srv/docs', php: false, managed: true, path: '/etc/apache2/keel-host.d/docs.conf' }];
      socket = '/run/php/php8.2-fpm.sock';
      expect(await app.ctx.software.php.hostAppsOn('8.2', [PHP, PHP82], '8.3')).toEqual([]);
      // service-configuration's own helper wins when it exists.
      const prevWeb = app.ctx.web;
      app.ctx.web = { ...prevWeb, hostApps: { ...prevWeb.hostApps, phpVersion: async () => '8.2' } };
      apps = [{ name: 'webmail', alias: '/webmail', root: '/usr/share/roundcube', php: true, managed: true, path: '/etc/apache2/keel-host.d/webmail.conf' }];
      socket = '/run/php/php8.3-fpm.sock';
      try { expect(await app.ctx.software.php.hostAppsOn('8.2', [PHP, PHP82], '8.3')).toEqual(['webmail']); } finally { app.ctx.web = prevWeb; }
      expect(await app.ctx.software.php.hostAppsOn('8.2', [PHP, PHP82], '8.3')).toEqual([]);
    } finally {
      app.agent.reset('web.host.status');
      app.agent.reset('web.host.app.list');
    }
  });

  it('never offers a source build over a distribution tree and never installs over an existing Keel build', async () => {
    // detectedVersion() feeds resolveInstall: 8.2 comes from packages here.
    const fromPackages = { installed: true, id: '8.2', version: '8.2.6', source: false, layout: null };
    const keel = { installed: true, id: '8.1', version: '8.1.33', source: true, layout: 'keel' };
    expect(() => resolveInstall({ runtime: 'php', version: '8.2' }, 'debian', { method: 'source', installed: fromPackages })).toThrow(/PHP 8\.2 is installed from packages; remove those packages first if you want a Keel build/);
    expect(resolveInstall({ runtime: 'php', version: '8.2' }, 'debian', { method: 'package', installed: fromPackages })).toMatchObject({ installer: null, packages: RUNTIMES.php.debian('8.2') });
    expect(() => resolveInstall({ runtime: 'php', version: '8.1' }, 'debian', { method: 'source', installed: keel })).toThrow(/already installed as a Keel build under \/opt\/keel\/php\/8\.1/);
    expect(() => resolveInstall({ runtime: 'php', version: '8.1' }, 'debian', { method: 'package', installed: keel })).toThrow(/already installed as a Keel build/);
    expect(() => resolveInstall({ runtime: 'php', version: '8.1' }, 'debian', { method: 'source', installed: { installed: false, version: null } })).not.toThrow();
    expect(() => resolveInstall({ runtime: 'nodejs', version: '22' }, 'debian', { installed: keel })).not.toThrow();
    repoState.php = 'unsupported';
    keelBuilds = ['8.1'];
    app.agent.set('pkg.php.versions', () => ({ ...stockVersions(), versions: [PHP, PHP82, keelVersion('8.1')] }));
    app.agent.calls.length = 0;
    try {
      // 8.2 is installed from packages and the PPA has no series: a source build may not replace the distro tree.
      const explicit = await post('/api/software/runtimes/install', { runtime: 'php', version: '8.2', method: 'source' });
      expect(explicit.status, JSON.stringify(explicit.body)).toBe(422);
      expect(explicit.body.error.message).toBe('PHP 8.2 is installed from packages; remove those packages first if you want a Keel build');
      expect(explicit.body.error.fields.method).toEqual(['package']);
      const twice = await post('/api/software/runtimes/install', { runtime: 'php', version: '8.1', method: 'source' });
      expect(twice.status).toBe(422);
      expect(twice.body.error.message).toMatch(/PHP 8\.1 is already installed as a Keel build under \/opt\/keel\/php\/8\.1/);
      expect((await post('/api/software/runtimes/install', { runtime: 'php', version: '8.1' })).status).toBe(422);
      expect(app.agent.callsTo('pkg.php.build')).toHaveLength(0);
      expect(app.agent.callsTo('pkg.install')).toHaveLength(0);
      expect(app.ctx.jobs.list({ limit: 5 }).some((j) => j.type === 'software.runtime.install' && j.status === 'queued')).toBe(false);
      // The catalog shows both as installed with their method; neither row is offered as a source build.
      const rows = (await get('/api/software/php/catalog')).body.data.versions;
      expect(rows.find((v) => v.id === '8.2')).toMatchObject({ state: 'installed', method: 'package', source: false });
      expect(rows.find((v) => v.id === '8.1')).toMatchObject({ state: 'installed', method: 'source', source: true });
    } finally {
      repoState.php = 'present';
      keelBuilds = [];
      app.agent.set('pkg.php.versions', stockVersions);
    }
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
    // The schedule fires only while the proxy is on.
    expect(app.ctx.scheduler.list().find((x) => x.name === 'nginx-proxy-sync').enabled).toBe(1);
    const disabled = await put('/api/software/nginx', { enabled: false });
    expect(disabled.body.data.settings.enabled).toBe(false);
    expect(disabled.body.data.proxy.removed).toBe(true);
    // Even by hand, Apache cannot take :80 back while nginx runs the restored stock site, so nginx is stopped and disabled.
    expect(disabled.body.data.proxy.unit).toMatchObject({ ok: true, verb: 'stop', disabledAtBoot: true, holdsPorts: false });
    expect(disabled.body.data.apache.detail).toMatch(/nginx was stopped and disabled/);
    expect(nginxState.active).toBe(false);
    expect(app.ctx.scheduler.list().find((x) => x.name === 'nginx-proxy-sync').enabled).toBe(0);
    expect((await get('/api/software/nginx')).body.data.proxyConfigured).toBe(false);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'software.nginx.configure'").get().n).toBe(2);
    } finally { app.ctx.web = prevWeb; }
  });

  it('disabling releases 80/443 before Apache is moved back: proxy.remove -> svc.stop -> setListenPorts, no reload', async () => {
    const ports = [];
    const prevWeb = app.ctx.web;
    app.ctx.web = fakeWeb(ports);
    const order = () => app.agent.calls.map((c) => c.name).filter((n) => ['pkg.nginx.proxy.remove', 'svc.stop', 'svc.disable', 'svc.reload', 'svc.start', 'web.setListenPorts'].includes(n));
    const fakePorts = async (args) => { app.agent.calls.push({ name: 'web.setListenPorts', args }); };
    try {
      await put('/api/software/nginx', { enabled: true });
      expect(nginxState.active).toBe(true);
      app.ctx.web = { setListenPorts: async (p) => { await fakePorts(p); ports.push(p); app.ctx.settings.set('service_config.apache_ports', p); } };
      app.agent.calls.length = 0;
      const res = await put('/api/software/nginx', { enabled: false });
      expect(res.status).toBe(200);
      expect(order()).toEqual(['pkg.nginx.proxy.remove', 'svc.stop', 'svc.disable', 'web.setListenPorts']);
      expect(ports.pop()).toEqual({ http: 80, https: 443, bind: null });
      expect(res.body.data.apache).toMatchObject({ state: 'applied' });
      expect(res.body.data.apache.detail).toMatch(/nginx was stopped and disabled/);
      expect(res.body.data.proxy.unit).toMatchObject({ ok: true, verb: 'stop', stillActive: false, holdsPorts: false });

      // nginx refuses to stop and is still active: Apache is left on the backend ports rather than restarted into "address already in use".
      await put('/api/software/nginx', { enabled: true });
      app.agent.fail('svc.stop', 'command_failed', 'Job for nginx.service canceled');
      app.agent.calls.length = 0;
      const stuck = await put('/api/software/nginx', { enabled: false });
      expect(stuck.status).toBe(200);
      expect(order()).toEqual(['pkg.nginx.proxy.remove', 'svc.stop']);
      expect(stuck.body.data.apache.state).toBe('skipped');
      expect(stuck.body.data.apache.detail).toMatch(/still holds 80\/443/);
      expect(stuck.body.data.proxy.unit).toMatchObject({ ok: false, verb: 'stop', holdsPorts: true });
      expect(stuck.body.data.proxy.unit.hint).toMatch(/stop it before Apache/);
      expect(stuck.body.data.settings.enabled).toBe(false);
      expect((await get('/api/software/nginx')).body.data.backendBind).toBe('127.0.0.1');
      app.agent.set('svc.stop', ({ unit }) => { if (unit === 'nginx') nginxState.active = false; return { unit, verb: 'stop', output: '' }; });
      // Saving again while nginx still runs keeps Apache where it is; once nginx is down the re-save moves Apache back.
      app.agent.calls.length = 0;
      const stillUp = await put('/api/software/nginx', { enabled: false });
      expect(stillUp.body.data.apache.state).toBe('skipped');
      expect(order()).toEqual([]);
      nginxState.active = false;
      app.agent.calls.length = 0;
      const again = await put('/api/software/nginx', { enabled: false });
      expect(again.body.data.apache.state).toBe('applied');
      expect(order()).toEqual(['web.setListenPorts']);
      expect(ports.pop()).toEqual({ http: 80, https: 443, bind: null });
      expect((await get('/api/software/nginx')).body.data.backendBind).toBe('all-interfaces');
      // With Apache back on 80/443 a further save is a no-op.
      app.agent.calls.length = 0;
      expect((await put('/api/software/nginx', { enabled: false })).body.data.apache.state).toBe('unchanged');
      expect(order()).toEqual([]);
      // ...and the normal path when nginx stops cleanly.
      await put('/api/software/nginx', { enabled: true });
      app.agent.calls.length = 0;
      await put('/api/software/nginx', { enabled: false });
      expect(order()).toEqual(['pkg.nginx.proxy.remove', 'svc.stop', 'svc.disable', 'web.setListenPorts']);
    } finally { app.ctx.web = prevWeb; app.agent.set('svc.stop', ({ unit }) => { if (unit === 'nginx') nginxState.active = false; return { unit, verb: 'stop', output: '' }; }); }
  });

  it('re-enabling after a disable starts and re-enables the unit and the sync time is only recorded once the switch succeeded', async () => {
    const ports = [];
    const prevWeb = app.ctx.web;
    app.ctx.web = fakeWeb(ports);
    try {
      await put('/api/software/nginx', { enabled: false });
      nginxState.active = false;
      app.agent.calls.length = 0;
      const before = app.ctx.settings.get('software.nginx.last_sync');
      app.agent.fail('svc.start', 'command_failed', 'bind() to 0.0.0.0:80 failed');
      expect((await put('/api/software/nginx', { enabled: true })).status).toBe(400);
      // Rolled back: no "last synced" claim for a config that is not in force.
      expect(app.ctx.settings.get('software.nginx.last_sync')).toBe(before);
      app.agent.set('svc.start', ({ unit }) => { if (unit === 'nginx') nginxState.active = true; return { unit, verb: 'start', output: '' }; });
      app.agent.calls.length = 0;
      const ok = await put('/api/software/nginx', { enabled: true });
      expect(ok.status).toBe(200);
      expect(ok.body.data.proxy.unit).toMatchObject({ ok: true, verb: 'start', enabledAtBoot: true });
      expect(app.agent.calls.map((c) => c.name).filter((n) => n.startsWith('svc.'))).toEqual(['svc.start', 'svc.enable']);
      expect(app.ctx.settings.get('software.nginx.last_sync')).not.toBe(before);
      expect(app.ctx.settings.get('software.nginx.last_fingerprint')).toBe(ok.body.data.status.fingerprint);
      await put('/api/software/nginx', { enabled: false });
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
      expect(invalid.status).toBe(422);
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

describe('Critical updates and direct Update buttons (contract §63)', () => {
  const PHP83 = { ...PHP, packagePrefix: 'php8.3-' };
  const PHP82P = { ...PHP82, packagePrefix: 'php8.2-' };
  const KEEL84 = keelVersion('8.4');
  const stock = () => ({ versions: [PHP, PHP82], defaultId: phpCliDefault, defaultBinary: `/usr/bin/php${phpCliDefault}` });
  // A recent check by default: the refresh endpoint re-runs the simulation when the recorded one is older than six hours.
  const pendingCheck = (packages, at = new Date().toISOString()) => app.ctx.settings.set('software.updates.last_check', { at, manager: 'apt', count: packages.length, security: packages.filter((p) => p.security).length, rebootRequired: false, packages, truncated: false });
  const PENDING = [
    { name: 'php8.3-fpm', current: '8.3.6-1', candidate: '8.3.36-1', repo: 'ondrej', security: true },
    { name: 'php8.3-cli', current: '8.3.6-1', candidate: '8.3.36-1', repo: 'ondrej', security: true },
    { name: 'git', current: '2.43.0-1', candidate: '2.43.0-2', repo: 'noble-updates', security: false },
    { name: 'openssl', current: '3.0.13-0ubuntu3.4', candidate: '3.0.13-0ubuntu3.5', repo: 'noble-security', security: true },
    { name: 'libssl3', current: '3.0.13-0ubuntu3.4', candidate: '3.0.13-0ubuntu3.5', repo: 'noble-security', security: true },
    { name: 'vim', current: '9.0', candidate: '9.1', repo: 'noble-updates', security: false },
  ];
  const withVersions = (versions) => app.agent.set('pkg.php.versions', () => ({ versions, defaultId: phpCliDefault, defaultBinary: `/usr/bin/php${phpCliDefault}` }));
  const SHA_A = 'a'.repeat(64);
  const SHA_B = 'b'.repeat(64);

  it('registers both update jobs and keeps the endpoints root-only', async () => {
    expect(app.ctx.jobs.types()).toContain('software.php.update');
    expect(app.ctx.jobs.types()).toContain('software.runtime.update');
    expect((await reseller.get('/api/software/updates/critical')).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/software/updates/critical/refresh', {}, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/software/php/update', { version: '8.3' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/software/runtimes/update', { tool: 'git' }, resellerCsrf)).status).toBe(403);
  });

  it('builds the list from advisories, the cached update check, php.net and nodejs.org releases, sorted by severity, and caches it', async () => {
    pendingCheck(PENDING);
    withVersions([PHP83, PHP82P, KEEL84]);
    nodeVersions = [{ major: 22, version: 'v22.11.0', path: '/opt/keel/node/22', bin: '/opt/keel/node/22/bin/node' }];
    app.agent.set('pkg.php.release', ({ minor }) => ({ minor, version: `${minor}.35`, filename: `php-${minor}.35.tar.xz`, sha256: SHA_A }));
    app.agent.set('pkg.node.release', ({ major }) => ({ major, arch: 'x64', version: `v${major}.14.0`, file: `node-v${major}.14.0-linux-x64.tar.xz`, sha256: SHA_B }));
    app.ctx.settings.set('software.php.releases', null);
    app.ctx.settings.set('software.node.releases', null);
    app.agent.calls.length = 0;
    try {
      const res = await post('/api/software/updates/critical/refresh');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const { items, packagesCheckedAt, releasesCheckedAt, checkedAt } = res.body.data;
      expect(packagesCheckedAt).toBe(app.ctx.settings.get('software.updates.last_check').at);
      expect(typeof checkedAt).toBe('string');
      expect([app.ctx.settings.get('software.php.releases')['8.4'].at, app.ctx.settings.get('software.node.releases')['22'].at]).toContain(releasesCheckedAt);
      // The recorded check is fresh, so the refresh did not simulate again.
      expect(app.agent.callsTo('pkg.upgradable')).toHaveLength(0);
      expect(items.map((i) => [i.kind, i.id, i.severity])).toEqual([
        ['php', '8.2', 'critical'], ['php', '8.3', 'critical'], ['package', 'openssl', 'security'], ['tool', 'git', 'update'], ['runtime', 'nodejs:22', 'update'], ['php', '8.4', 'update'],
      ]);
      const php83 = items[1];
      expect(php83).toMatchObject({ label: 'PHP 8.3', current: '8.3.6', candidate: '8.3.36-1', layout: 'debian', packages: ['php8.3-fpm', 'php8.3-cli'], unit: 'php8.3-fpm', action: { method: 'POST', path: '/software/php/update', body: { version: '8.3' } } });
      expect(php83.reasons[0]).toMatch(/^CVE-2026-109619: .*\(fixed in 8\.3\.36\)$/);
      expect(php83.reasons).toContain('2 package updates pending (security)');
      // Affected, but nothing newer to install: the item stays with no action.
      expect(items[0]).toMatchObject({ label: 'PHP 8.2', current: '8.2.20', candidate: null, action: null });
      expect(items[0].reasons).toHaveLength(1);
      expect(items[2]).toMatchObject({ label: 'OpenSSL', current: '3.0.13-0ubuntu3.4', candidate: '3.0.13-0ubuntu3.5', packages: ['openssl'], action: { path: '/software/update/run', body: { packages: ['openssl'], dist: false, refreshIndex: false } } });
      expect(items[3]).toMatchObject({ label: 'Git', current: '2.43.0-1', candidate: '2.43.0-2', packages: ['git'], action: { path: '/software/runtimes/update', body: { tool: 'git' } } });
      expect(items[4]).toMatchObject({ label: 'Node.js 22', current: 'v22.11.0', candidate: 'v22.14.0', action: { path: '/software/runtimes/update', body: { runtime: 'nodejs', version: '22' } } });
      expect(items[5]).toMatchObject({ label: 'PHP 8.4 (Keel build)', current: '8.4.33', candidate: '8.4.35', layout: 'keel', packages: [], source: 'release', action: { body: { version: '8.4' } }, reasons: ['php.net released 8.4.35'] });
      expect(items.map((i) => i.source)).toEqual([null, 'package', 'package', 'package', 'release', 'release']);
      expect(items.some((i) => i.packages.includes('vim') || i.packages.includes('libssl3'))).toBe(false);
      expect(app.agent.callsTo('pkg.php.release').map((c) => c.args)).toEqual([{ minor: '8.4' }]);
      expect(app.agent.callsTo('pkg.node.release').map((c) => c.args)).toEqual([{ major: 22 }]);
      expect(app.ctx.settings.get('software.php.releases')['8.4']).toMatchObject({ version: '8.4.35', sha256: SHA_A });
      expect(app.ctx.settings.get('software.node.releases')['22']).toMatchObject({ version: 'v22.14.0' });
      // Served from the cache: no agent call at all for a plain GET. A fresh
      // recompute keeps the six-hour release cache; only "Check for updates"
      // (the refresh endpoint) asks php.net / nodejs.org again.
      app.agent.calls.length = 0;
      expect((await get('/api/software/updates/critical')).body.data.items).toHaveLength(6);
      expect(app.agent.calls).toHaveLength(0);
      await app.ctx.software.updates.critical({ fresh: true });
      expect(app.agent.callsTo('pkg.php.release')).toHaveLength(0);
      expect(app.agent.callsTo('pkg.node.release')).toHaveLength(0);
      // A forced lookup within a minute of the last one is served from the cache too (no hammering php.net).
      await post('/api/software/updates/critical/refresh');
      expect(app.agent.callsTo('pkg.php.release')).toHaveLength(0);
      expect(app.agent.callsTo('pkg.node.release')).toHaveLength(0);
      const age = (setting) => app.ctx.settings.set(setting, Object.fromEntries(Object.entries(app.ctx.settings.get(setting)).map(([k, e]) => [k, { ...e, at: new Date(Date.now() - 2 * 60_000).toISOString() }])));
      age('software.php.releases');
      age('software.node.releases');
      await post('/api/software/updates/critical/refresh');
      expect(app.agent.callsTo('pkg.php.release').map((c) => c.args)).toEqual([{ minor: '8.4' }]);
      expect(app.agent.callsTo('pkg.node.release').map((c) => c.args)).toEqual([{ major: 22 }]);
      // Catalog rows carry the same verdict with its source and check time; the catalog itself carries the check times.
      const catalog = (await get('/api/software/php/catalog')).body.data;
      const cat = catalog.versions;
      const list = (await get('/api/software/updates/critical')).body.data;
      expect(catalog.updates).toEqual({ checkedAt: list.checkedAt, packagesCheckedAt: list.packagesCheckedAt, releasesCheckedAt: list.releasesCheckedAt });
      expect(cat.find((v) => v.id === '8.3').update).toEqual({ candidate: '8.3.36-1', severity: 'critical', reasons: php83.reasons, current: '8.3.6', source: 'package', checkedAt: list.packagesCheckedAt });
      expect(cat.find((v) => v.id === '8.4').update).toEqual({ candidate: '8.4.35', severity: 'update', reasons: ['php.net released 8.4.35'], current: '8.4.33', source: 'release', checkedAt: list.releasesCheckedAt });
      expect(cat.find((v) => v.id === '8.2').update).toMatchObject({ candidate: null, severity: 'critical', source: null, checkedAt: list.packagesCheckedAt });
      expect(cat.find((v) => v.id === '8.5').update).toBeNull();
      const rt = (await get('/api/software/runtimes')).body.data;
      expect(rt.updates).toEqual(catalog.updates);
      expect(rt.runtimes.find((r) => r.key === 'php').versions.find((v) => v.id === '8.3').update).toMatchObject({ candidate: '8.3.36-1', source: 'package' });
      expect(rt.tools.find((t) => t.key === 'git').update).toMatchObject({ candidate: '2.43.0-2', severity: 'update' });
      expect(rt.runtimes.find((r) => r.key === 'nodejs').versions.find((v) => v.id === '22').update).toMatchObject({ candidate: 'v22.14.0' });
      expect(rt.tools.find((t) => t.key === 'imagemagick').update).toBeNull();
    } finally {
      app.agent.set('pkg.php.versions', stock);
      app.agent.set('pkg.php.release', () => ({}));
      app.agent.set('pkg.node.release', () => ({}));
    }
  });

  it('never blocks: a failing probe only drops its items, and an empty host answers an empty list', async () => {
    pendingCheck([]);
    app.agent.fail('pkg.node.list', 'command_failed', 'boom');
    app.agent.fail('pkg.php.versions', 'timeout', 'agent timed out');
    try {
      const res = await post('/api/software/updates/critical/refresh');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
    } finally { app.agent.set('pkg.node.list', () => ({ system: { version: 'v22.11.0', path: '/usr/bin/node' }, versions: nodeVersions })); app.agent.set('pkg.php.versions', stock); }
  });

  it('Check for updates re-runs the OS update simulation when the recorded check is older than six hours', async () => {
    pendingCheck(PENDING, '2026-11-01T05:41:00.000Z');
    withVersions([PHP83, PHP82P]);
    app.agent.calls.length = 0;
    try {
      const res = await post('/api/software/updates/critical/refresh');
      expect(res.status).toBe(200);
      expect(app.agent.callsTo('pkg.upgradable')).toHaveLength(1);
      const recorded = app.ctx.settings.get('software.updates.last_check');
      expect(recorded.packages.map((p) => p.name)).toEqual(['libssl3', 'vim']);
      expect(Date.now() - Date.parse(recorded.at)).toBeLessThan(60_000);
      expect(res.body.data.packagesCheckedAt).toBe(recorded.at);
      expect(res.body.data.items.filter((i) => i.kind === 'php').map((i) => [i.id, i.candidate])).toEqual([['8.2', null], ['8.3', null]]);
      expect(res.body.data.items.some((i) => i.kind === 'tool' || i.kind === 'package')).toBe(false);
      const row = (await get('/api/software/php/catalog')).body.data.versions.find((v) => v.id === '8.3');
      expect(row.update).toMatchObject({ candidate: null, source: null, checkedAt: recorded.at });
      // A second check within six hours serves the recorded simulation.
      app.agent.calls.length = 0;
      await post('/api/software/updates/critical/refresh');
      expect(app.agent.callsTo('pkg.upgradable')).toHaveLength(0);
    } finally { app.agent.set('pkg.php.versions', stock); app.ctx.software.updates.invalidate(); }
  });

  it('coalesces concurrent Check for updates runs: one OS simulation and one php.net lookup for both callers', async () => {
    pendingCheck(PENDING, '2026-11-01T05:41:00.000Z');
    withVersions([PHP83, KEEL84]);
    nodeVersions = [];
    app.agent.set('pkg.php.release', ({ minor }) => ({ minor, version: `${minor}.35`, filename: `php-${minor}.35.tar.xz`, sha256: SHA_A }));
    app.ctx.settings.set('software.php.releases', null);
    app.ctx.software.updates.invalidate();
    app.agent.calls.length = 0;
    try {
      const [a, b] = await Promise.all([app.ctx.software.updates.refresh(), app.ctx.software.updates.refresh()]);
      expect(a).toBe(b);
      expect(app.agent.callsTo('pkg.upgradable')).toHaveLength(1);
      expect(app.agent.callsTo('pkg.php.release').map((c) => c.args)).toEqual([{ minor: '8.4' }]);
      expect(a.items.find((i) => i.kind === 'php' && i.id === '8.4')).toMatchObject({ candidate: '8.4.35' });
      // Once settled, the next call is a run of its own again.
      app.ctx.settings.set('software.updates.last_check', { ...app.ctx.settings.get('software.updates.last_check'), at: '2026-11-01T05:41:00.000Z' });
      await app.ctx.software.updates.refresh();
      expect(app.agent.callsTo('pkg.upgradable')).toHaveLength(2);
    } finally { app.agent.set('pkg.php.versions', stock); app.agent.set('pkg.php.release', () => ({})); app.ctx.software.updates.invalidate(); }
  });

  it('attaches update to an Install Software PHP row whose installed id differs from the catalog id (ea4/remi layouts)', async () => {
    const EA83 = { ...PHP, id: 'ea-php83', label: 'ea-php83', binary: '/opt/cpanel/ea-php83/root/usr/bin/php', layout: 'ea4', packagePrefix: 'ea-php83-', fpmUnit: 'ea-php83-php-fpm', iniPath: '/opt/cpanel/ea-php83/root/etc/php.ini' };
    pendingCheck([{ name: 'ea-php83-php-fpm', current: '8.3.6-1', candidate: '8.3.36-1', repo: 'ea4', security: true }]);
    withVersions([EA83]);
    app.agent.set('pkg.runtime.detect', () => ({ ...detectRuntimes(), php: [{ id: 'ea-php83', version: '8.3.6', layout: 'ea4' }] }));
    try {
      const res = await post('/api/software/updates/critical/refresh');
      expect(res.status).toBe(200);
      expect(res.body.data.items.filter((i) => i.kind === 'php').map((i) => i.id)).toEqual(['ea-php83']);
      const row = (await get('/api/software/runtimes')).body.data.runtimes.find((r) => r.key === 'php').versions.find((v) => v.id === '8.3');
      expect(row).toMatchObject({ installed: true, version: '8.3.6', update: { candidate: '8.3.36-1', severity: 'critical' } });
      expect((await get('/api/software/php/catalog')).body.data.versions.find((v) => v.id === 'ea-php83').update).toMatchObject({ candidate: '8.3.36-1' });
    } finally {
      app.agent.set('pkg.runtime.detect', () => detectRuntimes());
      app.agent.set('pkg.php.versions', stock);
      app.ctx.software.updates.invalidate();
    }
  });

  it('refuses a PHP update without a candidate (422) and for a version that is not installed', async () => {
    pendingCheck(PENDING);
    withVersions([PHP83, PHP82P, KEEL84]);
    app.agent.calls.length = 0;
    try {
      const none = await post('/api/software/php/update', { version: '8.2' });
      expect(none.status).toBe(422);
      expect(none.body.error.message).toMatch(/no newer build or package is available yet/);
      expect((await post('/api/software/php/update', { version: '9.9' })).status).toBe(422);
      expect((await post('/api/software/php/update', { version: '9.9' })).body.error.message).toMatch(/not installed/);
      expect((await post('/api/software/php/update', { version: '8.3; rm' })).status).toBe(422);
      expect(app.agent.callsTo('pkg.upgrade')).toHaveLength(0);
      expect(app.agent.callsTo('pkg.php.build')).toHaveLength(0);
      pendingCheck([]);
      const clean = await post('/api/software/php/update', { version: '8.3' });
      expect(clean.status).toBe(422);
      expect(clean.body.error.message).toMatch(/no newer build or package/);
    } finally { app.agent.set('pkg.php.versions', stock); }
  });

  it('updates a packaged version: pkg.upgrade of its pending packages, FPM reload, pending re-check, re-detection, audit', async () => {
    pendingCheck(PENDING);
    withVersions([PHP83, PHP82P, KEEL84]);
    app.agent.calls.length = 0;
    try {
      const res = await post('/api/software/php/update', { version: '8.3' });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body.data).toMatchObject({ version: '8.3', candidate: '8.3.36-1', method: 'package', job: { type: 'software.php.update' } });
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status, job.error).toBe('done');
      expect(job.result).toMatchObject({ version: '8.3', method: 'package', from: '8.3.6', candidate: '8.3.36-1', packages: ['php8.3-fpm', 'php8.3-cli'], restarted: true, updated: true });
      expect(app.agent.callsTo('pkg.upgrade').map((c) => c.args)).toEqual([{ packages: ['php8.3-fpm', 'php8.3-cli'], dist: false, wait: false }]);
      expect(app.agent.callsTo('svc.reload').map((c) => c.args)).toEqual([{ unit: 'php8.3-fpm' }]);
      const names = app.agent.calls.map((c) => c.name);
      expect(names.indexOf('svc.reload')).toBeGreaterThan(names.indexOf('pkg.upgrade'));
      expect(names.indexOf('pkg.upgradable')).toBeGreaterThan(names.indexOf('svc.reload'));
      expect(names.lastIndexOf('pkg.php.versions')).toBeGreaterThan(names.indexOf('pkg.upgradable'));
      expect(app.agent.callsTo('pkg.php.build')).toHaveLength(0);
      expect(app.ctx.db.prepare("SELECT 1 AS x FROM audit_log WHERE action = 'software.php.update' AND target = '8.3'").get()).toBeTruthy();
      // The cached check was replaced by the post-upgrade simulation (the mock reports libssl3 + vim), so the banner no longer lists PHP 8.3 packages.
      expect(app.ctx.settings.get('software.updates.last_check').packages.map((p) => p.name)).toEqual(['libssl3', 'vim']);
      expect((await get('/api/software/updates/critical')).body.data.items.find((i) => i.kind === 'php' && i.id === '8.3')).toMatchObject({ candidate: null });
    } finally { app.agent.set('pkg.php.versions', stock); }
  });

  it('updates a Keel build: pkg.php.build then pkg.php.build.finish, which restarts the registered unit', async () => {
    pendingCheck([]);
    withVersions([PHP83, PHP82P, KEEL84]);
    app.agent.set('pkg.php.release', ({ minor }) => ({ minor, version: `${minor}.35`, filename: `php-${minor}.35.tar.xz`, sha256: SHA_A }));
    app.ctx.settings.set('software.php.releases', null);
    app.agent.set('pkg.php.build', ({ minor }) => ({ minor, version: `${minor}.35`, prefix: `/opt/keel/php/${minor}`, background: false, code: 0, output: [`Building PHP ${minor}.35`] }));
    app.agent.set('pkg.php.build.finish', ({ minor }) => ({ minor, version: `${minor}.35`, prefix: `/opt/keel/php/${minor}`, unit: `keel-php${minor}-fpm`, active: true, restarted: true, link: `/usr/local/bin/php${minor}`, buildDirsRemoved: [] }));
    app.agent.calls.length = 0;
    try {
      const res = await post('/api/software/php/update', { version: '8.4' });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body.data).toMatchObject({ version: '8.4', candidate: '8.4.35', method: 'source' });
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status, job.error).toBe('done');
      expect(job.result).toMatchObject({ version: '8.4', layout: 'keel', method: 'source', from: '8.4.33', candidate: '8.4.35', restarted: true, packages: [] });
      expect(app.agent.callsTo('pkg.php.build').map((c) => c.args)).toEqual([{ minor: '8.4', wait: false }]);
      expect(app.agent.callsTo('pkg.php.build.finish').map((c) => c.args)).toEqual([{ minor: '8.4' }]);
      expect(app.agent.callsTo('pkg.upgrade')).toHaveLength(0);
      expect(app.agent.callsTo('pkg.install')).toHaveLength(0);
      const names = app.agent.calls.map((c) => c.name);
      expect(names.indexOf('pkg.php.build.finish')).toBeGreaterThan(names.indexOf('pkg.php.build'));
      expect(names.indexOf('sys.binaries')).toBeGreaterThan(names.indexOf('pkg.php.build.finish'));
      // A unit that does not come back fails the job.
      app.agent.set('pkg.php.build.finish', ({ minor }) => ({ minor, version: `${minor}.35`, unit: `keel-php${minor}-fpm`, active: false, unitError: 'Job for keel-php8.4-fpm.service failed', restarted: true }));
      const again = await post('/api/software/php/update', { version: '8.4' });
      expect(again.status).toBe(202);
      const failed = await waitForJob(app.ctx, again.body.data.job.id);
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/keel-php8\.4-fpm did not come back/);
    } finally {
      app.agent.set('pkg.php.versions', stock);
      app.agent.set('pkg.php.release', () => ({}));
      app.agent.reset('pkg.php.build'); app.agent.reset('pkg.php.build.finish');
    }
  });

  it('updates runtimes and tools: packages through pkg.upgrade, a Node.js major through a fresh build; refuses PHP and anything not installed', async () => {
    pendingCheck(PENDING);
    nodeVersions = [{ major: 22, version: 'v22.11.0', path: '/opt/keel/node/22', bin: '/opt/keel/node/22/bin/node' }];
    app.agent.calls.length = 0;
    const git = await post('/api/software/runtimes/update', { tool: 'git' });
    expect(git.status, JSON.stringify(git.body)).toBe(202);
    expect(git.body.data).toMatchObject({ target: 'git', packages: ['git'], method: 'package', job: { type: 'software.runtime.update' } });
    let job = await waitForJob(app.ctx, git.body.data.job.id);
    expect(job.status, job.error).toBe('done');
    expect(job.result).toMatchObject({ kind: 'tool', tool: 'git', packages: ['git'], updated: true, method: 'package' });
    expect(app.agent.callsTo('pkg.upgrade').map((c) => c.args)).toEqual([{ packages: ['git'], dist: false, wait: false }]);
    expect(app.agent.callsTo('pkg.upgradable')).toHaveLength(1);
    app.agent.calls.length = 0;
    const node = await post('/api/software/runtimes/update', { runtime: 'nodejs', version: '22' });
    expect(node.status, JSON.stringify(node.body)).toBe(202);
    expect(node.body.data).toMatchObject({ target: 'nodejs:22', method: 'node' });
    job = await waitForJob(app.ctx, node.body.data.job.id);
    expect(job.status, job.error).toBe('done');
    expect(job.result).toMatchObject({ kind: 'runtime', runtime: 'nodejs', version: '22', detected: 'v22.0.0', method: 'node' });
    expect(app.agent.callsTo('pkg.node.install').map((c) => c.args)).toEqual([{ major: 22, wait: false }]);
    expect(app.agent.callsTo('pkg.upgrade')).toHaveLength(0);
    expect(app.ctx.db.prepare("SELECT 1 AS x FROM audit_log WHERE action = 'software.runtime.update' AND target = 'nodejs:22'").get()).toBeTruthy();
    app.agent.calls.length = 0;
    expect((await post('/api/software/runtimes/update', { runtime: 'php', version: '8.3' })).status).toBe(422);
    expect((await post('/api/software/runtimes/update', { runtime: 'nodejs', version: '18' })).status).toBe(422);
    expect((await post('/api/software/runtimes/update', { tool: 'ffmpeg' })).status).toBe(422);
    expect((await post('/api/software/runtimes/update', { tool: 'git', version: '1' })).status).toBe(422);
    expect((await post('/api/software/runtimes/update', { runtime: 'ruby', tool: 'git' })).status).toBe(422);
    expect((await post('/api/software/runtimes/update', {})).status).toBe(422);
    expect(app.agent.callsTo('pkg.upgrade')).toHaveLength(0);
    expect(app.agent.callsTo('pkg.node.install')).toHaveLength(0);
    app.ctx.settings.set('software.updates.last_check', null);
  });
});
