import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { compareVersions, pickBasic, BASIC_DIRECTIVES, EA4_CATALOG } from '../src/services/software.js';

const BIN_FULL = { 'apt-get': true, 'dpkg-query': true, php: true, 'php-fpm': true, nginx: true, perl: true, cpan: true, gem: true, pip3: true, apache2ctl: true, systemctl: true };
const PHP = { id: '8.3', label: 'PHP 8.3', binary: '/usr/bin/php8.3', layout: 'debian', version: '8.3.6', iniPath: '/etc/php/8.3/fpm/php.ini', iniPaths: { fpm: '/etc/php/8.3/fpm/php.ini', cli: '/etc/php/8.3/cli/php.ini' }, poolDir: '/etc/php/8.3/fpm/pool.d', fpmUnit: 'php8.3-fpm', isDefault: true, fpmActive: true, fpmInstalled: true };
const PHP82 = { ...PHP, id: '8.2', label: 'PHP 8.2', binary: '/usr/bin/php8.2', version: '8.2.20', iniPath: '/etc/php/8.2/fpm/php.ini', fpmUnit: 'php8.2-fpm', isDefault: false, fpmActive: false };
const INI = '[PHP]\nmemory_limit = 128M\nupload_max_filesize = 2M\n;display_errors = On\n';
let phpVersions = [PHP, PHP82];
// What /usr/bin/php resolves to; a newer branch's install moves it (alternatives auto mode) unless the panel points it back.
let phpDefaultId = '8.3';
// The Ubuntu host's PHP source: nothing but the stock 8.3 (and the installed 8.2) until ppa:ondrej/php is enabled.
const phpSource = { configured: false, host: 'ubuntu' };
const PHP_SOURCE_LABEL = 'Ondřej Surý PPA (ppa:ondrej/php)';
const SURY_LABEL = 'DEB.SURY.ORG (packages.sury.org/php)';
const PHP_HOSTS = {
  ubuntu: { os: { id: 'ubuntu', name: 'Ubuntu 24.04.1 LTS', versionId: '24.04', codename: 'noble' }, source: { key: 'ondrej', label: PHP_SOURCE_LABEL, url: 'https://launchpad.net/~ondrej/+archive/ubuntu/php', flavor: 'ubuntu', codename: 'noble', major: null, supported: true, reason: null }, origin: 'https://ppa.launchpadcontent.net/ondrej/php/ubuntu', steps: [{ step: 'add-apt-repository ppa:ondrej/php', ok: true }] },
  debian: { os: { id: 'debian', name: 'Debian GNU/Linux 12 (bookworm)', versionId: '12', codename: 'bookworm' }, source: { key: 'sury', label: SURY_LABEL, url: 'https://packages.sury.org/php/', flavor: 'debian', codename: 'bookworm', major: null, supported: true, reason: null }, origin: 'https://packages.sury.org/php/', steps: [{ step: 'signing key', ok: true, path: '/etc/apt/keyrings/whm-sury-php.gpg' }, { step: 'sources list', ok: true, path: '/etc/apt/sources.list.d/whm-sury-php.list' }] },
};
let installedPkgs = [{ name: 'apache2', version: '2.4.58', arch: 'amd64', summary: 'Apache HTTP Server' }, { name: 'php-fpm', version: '8.3', arch: 'all', summary: 'FPM' }, { name: 'curl', version: '8.5.0', arch: 'amd64', summary: 'cli' }, { name: 'libapache2-mod-evasive', version: '1.1', arch: 'amd64', summary: 'evasive' }];
let nginxState = { installed: true, active: true, proxyConfigured: false, content: null };
// Names the mocked repositories do not carry (pkg.offers answers offered: false).
const notOffered = new Set(['netdata', 'php8.2-redis']);
// Names another package provides (Remi's php-pecl-redis6 for php-pecl-redis); the agent reports the provider.
const providers = new Map();
const offersHandler = ({ packages }) => ({ manager: 'apt', packages: Object.fromEntries(packages.map((n) => [n, providers.has(n) ? { installed: installedPkgs.find((p) => p.name === providers.get(n))?.version ?? null, candidate: installedPkgs.some((p) => p.name === providers.get(n)) ? null : '2.0-1', origin: null, provider: providers.get(n), offered: true } : notOffered.has(n) ? { installed: null, candidate: null, origin: null, provider: null, offered: false } : { installed: installedPkgs.find((p) => p.name === n)?.version ?? null, candidate: '1.0-1', origin: 'http://archive.ubuntu.com/ubuntu', provider: null, offered: true }])) });
let rpmPresent = false;

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
    'pkg.search': ({ q, limit, all }) => {
      const mark = (name, summary, variants = []) => ({ name, summary, installed: installedPkgs.some((p) => p.name === name), installedVersion: installedPkgs.find((p) => p.name === name)?.version ?? null, variants, variantCount: variants.length });
      const rows = all
        ? [mark(q, `the ${q} package`), mark(`${q}-dev`, 'headers'), mark(`${q}-doc`, 'docs'), mark(`lib${q}`, 'library')]
        : [mark(q, `the ${q} package`, [{ name: `${q}-dev`, summary: 'headers', kind: 'dev', installed: false, installedVersion: null }, { name: `${q}-doc`, summary: 'docs', kind: 'doc', installed: false, installedVersion: null }]), mark(`lib${q}`, 'library')];
      const shown = rows.slice(0, limit);
      const collapsed = shown.reduce((n, r) => n + r.variantCount, 0);
      return { manager: 'apt', q, all: Boolean(all), results: shown, total: 4, shown: shown.length, collapsed, hidden: 4 - shown.length - collapsed, more: rows.length > limit, truncated: rows.length - shown.length };
    },
    'pkg.offers': offersHandler,
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
    'pkg.php.versions': () => ({ versions: phpVersions.map((v) => ({ ...v, isDefault: v.id === phpDefaultId })), defaultId: phpDefaultId, defaultBinary: `/usr/bin/php${phpDefaultId}` }),
    'pkg.php.sources.detect': ({ branches }) => {
      const list = branches?.length ? branches : ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5'];
      const versions = list.map((version) => {
        const installed = phpVersions.find((v) => v.id === version);
        const offered = Boolean(installed) || version === '8.3' || (phpSource.configured && ['8.1', '8.2', '8.4'].includes(version));
        const host = PHP_HOSTS[phpSource.host];
        return { version, id: version, package: `php${version}-fpm`, fpmUnit: `php${version}-fpm`, offered, installed: Boolean(installed), candidate: offered ? `${version}.1-1` : null, installedVersion: installed?.version ?? null, origin: offered ? (version === '8.3' ? 'http://archive.ubuntu.com/ubuntu' : host.origin) : null, source: offered ? (version === '8.3' ? 'distro' : host.source.key) : null };
      });
      const host = PHP_HOSTS[phpSource.host];
      return { manager: 'apt', family: 'debian', os: host.os, source: { ...host.source, configured: phpSource.configured }, stock: '8.3', branches: ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5'], versions };
    },
    'pkg.php.source.enable': ({ source }) => { const host = PHP_HOSTS[phpSource.host]; const already = phpSource.configured; phpSource.configured = true; return { source, label: host.source.label, changed: !already, alreadyConfigured: already, steps: already ? [] : host.steps, output: [`Hit:1 ${host.origin} ${host.os.codename} InRelease`] }; },
    'pkg.php.install': ({ version, extensions }) => {
      if (!phpVersions.some((v) => v.id === version)) phpVersions = [...phpVersions, { ...PHP, id: version, label: `PHP ${version}`, binary: `/usr/bin/php${version}`, version: `${version}.1`, iniPath: `/etc/php/${version}/fpm/php.ini`, poolDir: `/etc/php/${version}/fpm/pool.d`, fpmUnit: `php${version}-fpm`, isDefault: false, fpmActive: false }];
      // php8.4-cli's postinst wins the /usr/bin/php alternative over 8.3 (priority 84 > 83) in auto mode.
      if (compareVersions(version, phpDefaultId) > 0) phpDefaultId = version;
      const wanted = [`php${version}-fpm`, `php${version}-cli`, `php${version}-common`, ...(extensions || []).map((e) => `php${version}-${e}`)];
      const skipped = wanted.filter((n) => n.endsWith('-opcache'));
      return { manager: 'apt', family: 'debian', version, id: version, packages: wanted.filter((n) => !skipped.includes(n)), skipped, alreadyInstalled: [], fpmUnit: `php${version}-fpm`, prefix: `php${version}-`, unit: { unit: `php${version}-fpm`, enabled: null, note: 'enable the unit once the installer has finished' }, output: [`Setting up php${version}-fpm`] };
    },
    'pkg.php.remove': ({ version }) => { phpVersions = phpVersions.filter((v) => v.id !== version); return { manager: 'apt', version, id: version, packages: [`php${version}-fpm`, `php${version}-cli`, `php${version}-common`], purge: false, fpmUnit: `php${version}-fpm`, output: [`Removing php${version}-fpm`] }; },
    'web.phpfpm.detect': () => ({ versions: phpVersions.map((v) => ({ version: v.id, flavor: 'debian', poolDir: v.poolDir, units: [v.fpmUnit] })), installed: phpVersions.length > 0 }),
    'pkg.php.default.set': ({ version }) => { phpDefaultId = version; return { version, binary: `/usr/bin/php${version}`, tool: 'update-alternatives' }; },
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
    for (const t of ['software.pkg.install', 'software.pkg.remove', 'software.system.update', 'software.update.check', 'software.perl.install', 'software.module.install', 'software.nginx.install', 'software.nginx.sync', 'software.rpmdb.rebuild', 'software.php.resync', 'software.php.apply', 'software.php.install', 'software.php.remove', 'software.ea4.build']) expect(app.ctx.jobs.types()).toContain(t);
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
    for (const url of ['/api/software/pkg/detect', '/api/software/pkg/installed', '/api/software/pkg/search?q=curl', '/api/software/pkg/catalog', '/api/software/update/status', '/api/software/rpmdb', '/api/software/perl/modules', '/api/software/modules/installers', '/api/software/panel/update', '/api/software/php/pools', '/api/software/php/ini/8.3', '/api/software/php/installable', '/api/software/nginx', '/api/software/ea4/profiles']) {
      expect((await reseller.get(url)).status, url).toBe(403);
    }
    expect((await mutate(reseller, 'post', '/api/software/php/install', { version: '8.4' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'delete', '/api/software/php/versions/8.2', undefined, resellerCsrf)).status).toBe(403);
    expect(app.agent.callsTo('pkg.php.sources.detect')).toHaveLength(0);
    expect(app.agent.callsTo('pkg.php.remove')).toHaveLength(0);
    expect((await mutate(reseller, 'post', '/api/software/pkg/install', { packages: ['nginx'] }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/software/pkg/catalog/redis/install', {}, resellerCsrf)).status).toBe(403);
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
    expect((await get('/api/software/php/domains?pageSize=501')).status).toBe(422);
    expect((await get('/api/software/php/domains?sort=bogus')).status).toBe(422);
    expect((await get('/api/software/php/domains?pageSize=500&sort=domain')).status).toBe(200);
    expect((await put('/api/software/php/ini/8.3', {})).status).toBe(422);
    expect((await put('/api/software/php/ini/8.3', { directives: { 'memory_limit;x': '1' } })).status).toBe(422);
    expect((await put('/api/software/php/ini/8.3', { directives: { memory_limit: 'a\nb' } })).status).toBe(422);
    expect((await get('/api/software/php/ini/8.3?sapi=cgi')).status).toBe(422);
    for (const body of [{ version: '83' }, { version: 'php8.3' }, { version: '8.3.1' }, { version: '8.3;id' }, { version: 'ea-php83' }, {}, { version: '8.3', extensions: ['curl'] }]) expect((await post('/api/software/php/install', body)).status, JSON.stringify(body)).toBe(422);
    expect((await del('/api/software/php/versions/PHP%208.3')).status).toBe(422);
    expect((await del('/api/software/php/versions/-x')).status).toBe(422);
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
      ['get', '/api/software/pkg/catalog', undefined, 'pkg'], ['post', '/api/software/pkg/catalog/redis/install', {}, 'pkg'],
      ['post', '/api/software/pkg/update-index', {}, 'pkg'], ['get', '/api/software/update/status', undefined, 'pkg'], ['post', '/api/software/update/run', {}, 'pkg'],
      ['post', '/api/software/rpmdb/rebuild', {}, 'rpm'], ['get', '/api/software/perl/modules', undefined, 'perl'], ['post', '/api/software/perl/install', { modules: ['DBI'] }, 'perl'],
      ['get', '/api/software/modules/gem', undefined, 'gem'], ['post', '/api/software/modules/pip/install', { name: 'requests' }, 'pip'],
      ['get', '/api/software/php/versions', undefined, 'php'], ['put', '/api/software/php/default', { version: '8.3' }, 'php'], ['get', '/api/software/php/ini/8.3', undefined, 'php'], ['get', '/api/software/php/pools', undefined, 'php'],
      ['get', '/api/software/php/installable', undefined, 'pkg'], ['post', '/api/software/php/install', { version: '8.4' }, 'pkg'], ['delete', '/api/software/php/versions/8.2', undefined, 'pkg'],
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
    expect(search.body.data.results[0]).toMatchObject({ name: 'curl', installed: true, variantCount: 2 });
    expect(search.body.data.results[0].variants.map((v) => v.name)).toEqual(['curl-dev', 'curl-doc']);
    expect(search.body.data).toMatchObject({ all: false, total: 4, shown: 2, collapsed: 2, hidden: 0, more: false });
    expect(app.agent.callsTo('pkg.search').pop().args).toEqual({ q: 'curl', limit: 60, all: false });
    // "Show everything": the raw ranked list, no folding, with the cap the page asked for.
    const everything = await get('/api/software/pkg/search?q=curl&all=true&limit=3');
    expect(everything.body.data).toMatchObject({ all: true, total: 4, shown: 3, collapsed: 0, hidden: 1, more: true, truncated: 1 });
    expect(everything.body.data.results.map((r) => r.name)).toEqual(['curl', 'curl-dev', 'curl-doc']);
    expect(app.agent.callsTo('pkg.search').pop().args).toEqual({ q: 'curl', limit: 3, all: true });
    expect((await get('/api/software/pkg/search?q=curl&all=maybe')).status).toBe(422);
    expect((await get('/api/software/pkg/search?q=curl&limit=0')).status).toBe(422);
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

describe('Package catalog (Install Distro Packages opens on it)', () => {
  const entry = (body, key) => body.data.groups.flatMap((g) => g.entries).find((e) => e.key === key);

  it('lists the curated groups with installed and offered state per entry and per PHP version', async () => {
    app.agent.calls.length = 0;
    const res = await get('/api/software/pkg/catalog');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ manager: 'apt', family: 'debian', offersKnown: true, installedTotal: installedPkgs.length });
    expect(res.body.data.groups.map((g) => g.key)).toEqual(['web', 'php', 'databases', 'mail', 'security', 'tools', 'monitoring', 'services']);
    expect(res.body.data.entries).toBe(res.body.data.total);
    expect(res.body.data.phpVersions.map((v) => v.id)).toEqual(['8.3', '8.2']);
    const apache = entry(res.body, 'apache');
    expect(apache).toMatchObject({ installed: true, partial: false, offered: true, missing: [], category: 'web', recommended: true, capability: 'apache', configure: '/service-configuration/apache-configuration' });
    expect(apache.packages).toEqual([{ name: 'apache2', installed: true, version: '2.4.58', offered: true, candidate: null, provider: null }]);
    // The PHP runtime is judged by the installed versions' package sets (php8.3-*, php8.2-*), never by the php-fpm meta package the listing carries.
    const php = entry(res.body, 'php');
    expect(php).toMatchObject({ installed: false, partial: false, offered: true, php: null });
    expect(php.packages.map((p) => p.name)).toEqual(expect.arrayContaining(['php8.3-fpm', 'php8.3-cli', 'php8.3-opcache', 'php8.2-fpm', 'php8.2-mysql']));
    expect(php.packages.map((p) => p.name)).not.toContain('php-fpm');
    expect(entry(res.body, 'php-pecl-tools').packages.map((p) => p.name)).toEqual(['php-pear', 'php8.3-dev', 'php8.2-dev']);
    expect(entry(res.body, 'imagemagick')).toMatchObject({ installed: true, packages: [{ name: 'imagemagick', installed: true }] });
    const redis = entry(res.body, 'redis');
    expect(redis).toMatchObject({ installed: false, partial: false, offered: true, missing: [], php: null });
    expect(redis.packages).toEqual([{ name: 'redis-server', installed: false, version: null, offered: true, candidate: '1.0-1', provider: null }]);
    // Not in the repositories: the card says so instead of offering an install that would fail.
    expect(entry(res.body, 'netdata')).toMatchObject({ installed: false, offered: false, missing: ['netdata'] });
    // PHP extensions expand per installed version; 8.2's redis is not offered here, so the entry is partly offered.
    const phpRedis = entry(res.body, 'php-redis');
    expect(phpRedis.packages.map((p) => p.name)).toEqual(['php8.3-redis', 'php8.2-redis']);
    expect(phpRedis.php.unversioned).toBe(false);
    expect(phpRedis.php.versions).toEqual([
      { id: '8.3', label: 'PHP 8.3', name: 'php8.3-redis', installed: false, version: null, offered: true, candidate: '1.0-1', provider: null },
      { id: '8.2', label: 'PHP 8.2', name: 'php8.2-redis', installed: false, version: null, offered: false, candidate: null, provider: null },
    ]);
    expect(phpRedis).toMatchObject({ offered: false, missing: ['php8.2-redis'] });
    // One dpkg listing and one offers batch; the batch never asks about names already installed.
    expect(app.agent.callsTo('pkg.list_installed')).toHaveLength(1);
    const offers = app.agent.callsTo('pkg.offers');
    expect(offers).toHaveLength(1);
    expect(offers[0].args.packages).not.toContain('apache2');
    expect(offers[0].args.packages).toEqual(expect.arrayContaining(['redis-server', 'php8.3-redis', 'netdata']));
  });

  it('follows a MultiPHP host: the runtime card is installed when the versioned set is, partial for a second version, and installs the versioned names', async () => {
    const stack = ['fpm', 'cli', 'common', 'mysql', 'curl', 'gd', 'mbstring', 'xml', 'zip', 'intl', 'bcmath', 'soap', 'opcache'];
    const before = installedPkgs;
    // Sury host after MultiPHP: php8.3-* only, no php-fpm/php-cli meta packages.
    installedPkgs = [...before.filter((p) => p.name !== 'php-fpm'), ...stack.map((s) => ({ name: `php8.3-${s}`, version: '8.3.6-1', arch: 'amd64', summary: 'php' }))];
    phpVersions = [PHP];
    try {
      const one = await get('/api/software/pkg/catalog?refresh=true&group=php');
      expect(entry(one.body, 'php')).toMatchObject({ installed: true, partial: false, offered: true, missing: [] });
      expect(entry(one.body, 'php').packages.map((p) => p.name)).toEqual(stack.map((s) => `php8.3-${s}`));
      expect(entry(one.body, 'php-pecl-tools').packages.map((p) => p.name)).toEqual(['php-pear', 'php8.3-dev']);
      // A second installed version without its set: partial, and Install adds that version's packages, never the meta ones.
      phpVersions = [PHP, PHP82];
      const two = await get('/api/software/pkg/catalog?refresh=true&group=php');
      expect(entry(two.body, 'php')).toMatchObject({ installed: false, partial: true, offered: true });
      const res = await post('/api/software/pkg/catalog/php/install', {});
      expect(res.status).toBe(202);
      expect(res.body.data.packages).toEqual([...stack.map((s) => `php8.3-${s}`), ...stack.map((s) => `php8.2-${s}`)]);
      expect(res.body.data.packages).not.toContain('php-fpm');
      expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('done');
      expect(app.agent.callsTo('pkg.install').pop().args.packages).toEqual(res.body.data.packages);
      expect(entry((await get('/api/software/pkg/catalog?group=php')).body, 'php')).toMatchObject({ installed: true, partial: false });
      expect((await post('/api/software/pkg/catalog/php/install', { phpVersion: '8.3' })).status).toBe(422);
    } finally { installedPkgs = before; phpVersions = [PHP, PHP82]; }
  });

  it('counts a name as installed when the package the agent names as its provider is (Remi php-pecl-redis6 for php-pecl-redis)', async () => {
    const before = installedPkgs;
    providers.set('wkhtmltopdf', 'wkhtmltox');
    try {
      const offered = await get('/api/software/pkg/catalog?refresh=true&group=tools');
      expect(entry(offered.body, 'wkhtmltopdf')).toMatchObject({ installed: false, partial: false, offered: true, missing: [] });
      expect(entry(offered.body, 'wkhtmltopdf').packages).toEqual([{ name: 'wkhtmltopdf', installed: false, version: null, offered: true, candidate: '2.0-1', provider: 'wkhtmltox' }]);
      installedPkgs = [...before, { name: 'wkhtmltox', version: '0.12.6-1', arch: 'amd64', summary: 'provider' }];
      const installed = await get('/api/software/pkg/catalog?refresh=true&group=tools');
      expect(entry(installed.body, 'wkhtmltopdf')).toMatchObject({ installed: true, partial: false, offered: true, missing: [] });
      expect(entry(installed.body, 'wkhtmltopdf').packages).toEqual([{ name: 'wkhtmltopdf', installed: true, version: '0.12.6-1', offered: true, candidate: null, provider: 'wkhtmltox' }]);
      // A provider the host does not carry installs nothing by itself.
      providers.set('ncdu', 'ncdu-ng');
      expect(entry((await get('/api/software/pkg/catalog?refresh=true&group=monitoring')).body, 'ncdu')).toMatchObject({ installed: false, offered: true });
    } finally { installedPkgs = before; providers.clear(); }
  });

  it('filters by group and by text, and refuses other shapes', async () => {
    const mail = await get('/api/software/pkg/catalog?group=mail');
    expect(mail.body.data.groups.map((g) => g.key)).toEqual(['mail']);
    expect(mail.body.data.groups[0].entries.map((e) => e.key)).toEqual(expect.arrayContaining(['exim', 'dovecot', 'spamassassin', 'clamav', 'roundcube']));
    expect(mail.body.data.total).toBeGreaterThan(mail.body.data.entries);
    const redis = await get('/api/software/pkg/catalog?q=redis');
    // Key, label, description and package names of either family count (memcached's description names Redis).
    expect(redis.body.data.groups.flatMap((g) => g.entries).map((e) => e.key).sort()).toEqual(['memcached', 'php-igbinary', 'php-msgpack', 'php-redis', 'redis']);
    expect((await get('/api/software/pkg/catalog?q=nothing-like-this')).body.data.groups).toEqual([]);
    expect((await get('/api/software/pkg/catalog?q=a;b')).status).toBe(422);
    expect((await get('/api/software/pkg/catalog?group=Mail!')).status).toBe(422);
    expect((await get('/api/software/pkg/catalog?refresh=yes')).status).toBe(422);
  });

  it('serves the offered state from a cache until an install, a refresh or a new name invalidates it', async () => {
    app.agent.calls.length = 0;
    await get('/api/software/pkg/catalog');
    await get('/api/software/pkg/catalog?group=tools');
    expect(app.agent.callsTo('pkg.offers')).toHaveLength(0);
    await get('/api/software/pkg/catalog?refresh=true');
    expect(app.agent.callsTo('pkg.offers')).toHaveLength(1);
    const res = await post('/api/software/pkg/catalog/redis/install', {});
    expect(res.status).toBe(202);
    expect((await waitForJob(app.ctx, res.body.data.job.id)).status).toBe('done');
    app.agent.calls.length = 0;
    await get('/api/software/pkg/catalog');
    expect(app.agent.callsTo('pkg.offers')).toHaveLength(1);
  });

  it('installs one entry by key with the family names, as a job with an audit row', async () => {
    const res = await post('/api/software/pkg/catalog/memcached/install', {});
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ key: 'memcached', packages: ['memcached'] });
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ packages: ['memcached'], catalogEntry: 'memcached', skipped: [] });
    expect(app.agent.callsTo('pkg.install').pop().args).toEqual({ packages: ['memcached'], noRecommends: false, wait: false });
    expect(installedPkgs.some((p) => p.name === 'memcached')).toBe(true);
    expect(entry((await get('/api/software/pkg/catalog?group=databases')).body, 'memcached')).toMatchObject({ installed: true });
    const audit = app.ctx.db.prepare("SELECT target, args_redacted FROM audit_log WHERE action = 'software.pkg.catalog.install' ORDER BY id DESC LIMIT 1").get();
    expect(audit.target).toBe('memcached');
    expect(JSON.parse(audit.args_redacted)).toMatchObject({ packages: ['memcached'], family: 'debian', phpVersion: null });
    expect((await post('/api/software/pkg/catalog/no-such-entry/install', {})).status).toBe(404);
    expect((await post('/api/software/pkg/catalog/Bad.Key/install', {})).status).toBe(422);
    expect((await post('/api/software/pkg/catalog/memcached/install', { extra: true })).status).toBe(422);
  });

  it('installs a PHP extension for one version or for every installed version, skipping what the repositories lack', async () => {
    const one = await post('/api/software/pkg/catalog/php-redis/install', { phpVersion: '8.3' });
    expect(one.status).toBe(202);
    expect(one.body.data.packages).toEqual(['php8.3-redis']);
    expect((await waitForJob(app.ctx, one.body.data.job.id)).result).toMatchObject({ packages: ['php8.3-redis'], skipped: [] });
    installedPkgs = installedPkgs.filter((p) => p.name !== 'php8.3-redis');
    const all = await post('/api/software/pkg/catalog/php-redis/install', {});
    expect(all.body.data.packages).toEqual(['php8.3-redis', 'php8.2-redis']);
    const job = await waitForJob(app.ctx, all.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ packages: ['php8.3-redis'], skipped: ['php8.2-redis'] });
    expect(job.logs.some((l) => /php8.2-redis: not offered/.test(l.line))).toBe(true);
    expect(app.agent.callsTo('pkg.install').pop().args.packages).toEqual(['php8.3-redis']);
    expect((await post('/api/software/pkg/catalog/php-redis/install', { phpVersion: '7.0' })).status).toBe(422);
    expect((await post('/api/software/pkg/catalog/redis/install', { phpVersion: '8.3' })).status).toBe(422);
    // Nothing offered at all: the job fails with the names instead of running an installer that cannot succeed.
    notOffered.add('nethogs'); notOffered.add('iftop');
    try {
      const none = await waitForJob(app.ctx, (await post('/api/software/pkg/catalog/iftop-nethogs/install', {})).body.data.job.id);
      expect(none.status).toBe('failed');
      expect(none.error).toMatch(/None of the packages of "iftop-nethogs" is offered/);
    } finally { notOffered.delete('nethogs'); notOffered.delete('iftop'); }
  });

  it('keeps working without PHP (unversioned meta-packages) and when the agent cannot report offers', async () => {
    await provision(true, { php: false, 'php-fpm': false });
    try {
      const res = await get('/api/software/pkg/catalog?q=redis');
      expect(res.body.data.phpVersions).toEqual([]);
      const phpRedis = entry(res.body, 'php-redis');
      expect(phpRedis.packages.map((p) => p.name)).toEqual(['php-redis']);
      expect(phpRedis.php).toEqual({ versions: [], unversioned: true });
    } finally { await provision(true); }
    app.agent.fail('pkg.offers', 'unknown_op', 'Unknown op "pkg.offers"');
    try {
      const res = await get('/api/software/pkg/catalog?refresh=true&group=databases');
      expect(res.status).toBe(200);
      expect(res.body.data.offersKnown).toBe(false);
      expect(entry(res.body, 'postgresql')).toMatchObject({ installed: false, offered: null, missing: [] });
      // The failure is not cached: the next page load asks again once the op answers.
      app.agent.set('pkg.offers', offersHandler);
      app.agent.calls.length = 0;
      expect((await get('/api/software/pkg/catalog?group=databases')).body.data.offersKnown).toBe(true);
      expect(app.agent.callsTo('pkg.offers')).toHaveLength(1);
    } finally { app.agent.set('pkg.offers', offersHandler); }
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

describe('Install a PHP version', () => {
  const reset = () => { phpVersions = [PHP, PHP82]; phpDefaultId = '8.3'; phpSource.configured = false; app.ctx.settings.set('php.default_version', '8.3'); };
  beforeEach(reset);
  afterEach(reset);
  const phpCalls = (from) => app.agent.calls.slice(from).map((c) => c.name).filter((n) => n.startsWith('pkg.php.') || n === 'svc.enable' || n === 'web.phpfpm.detect' || n === 'pkg.detect');

  it('lists the catalog branches with offered, installed, default, usage and removable flags', async () => {
    await put('/api/software/php/domains', { domains: ['bob.com'], version: '8.2' });
    const res = await get('/api/software/php/installable');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ manager: 'apt', family: 'debian', os: { id: 'ubuntu', codename: 'noble' }, source: { key: 'ondrej', label: PHP_SOURCE_LABEL, configured: false, supported: true }, stock: '8.3', effectiveDefault: '8.3' });
    expect(d.versions.map((v) => v.version)).toEqual(['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5']);
    const by = Object.fromEntries(d.versions.map((v) => [v.version, v]));
    // The seeded package and both accounts' plans pin ea-php83, which the web category renders with the 8.3 tree on this host.
    expect(by['8.3']).toMatchObject({ id: '8.3', label: 'PHP 8.3', installed: true, offered: true, isDefault: true, isCliDefault: true, stock: true, inUse: 3, usage: { domains: 0, vhosts: 0, pools: 0, packages: ['default'], accounts: 2, apachePin: false, total: 3 }, inUseDetail: "package 'default', 2 accounts whose plan pins it", removable: false, layout: 'debian', fpmUnit: 'php8.3-fpm', installedVersion: '8.3.6' });
    expect(by['8.2']).toMatchObject({ id: '8.2', installed: true, isDefault: false, isCliDefault: false, inUse: 1, usage: { domains: 1, total: 1 }, inUseDetail: '1 domain', removable: false });
    expect(by['8.4']).toMatchObject({ id: '8.4', label: 'PHP 8.4', installed: false, offered: false, source: null, removable: false, inUse: 0, inUseDetail: null });
    expect(by['8.3'].advisories[0]).toMatchObject({ id: 'CVE-2026-109619' });
    expect(Array.isArray(d.recent)).toBe(true);
    await put('/api/software/php/domains', { domains: ['bob.com'], version: null });
    phpSource.configured = true;
    const again = (await get('/api/software/php/installable')).body.data;
    expect(again.source.configured).toBe(true);
    expect(again.versions.find((v) => v.version === '8.4')).toMatchObject({ offered: true, installed: false, source: 'ondrej', candidate: '8.4.1-1' });
    expect(again.versions.find((v) => v.version === '8.2')).toMatchObject({ inUse: 0, removable: true });
    expect(again.versions.find((v) => v.version === '8.5')).toMatchObject({ offered: false, installed: false });
    // A tree outside the branch catalog is listed read-only.
    phpVersions = [...phpVersions, { ...PHP, id: 'ea-php74', label: 'ea-php74', layout: 'ea4', binary: '/opt/cpanel/ea-php74/root/usr/bin/php', version: '7.4.33', isDefault: false, fpmUnit: 'ea-php74-php-fpm' }];
    const ea = (await get('/api/software/php/installable')).body.data.versions.find((v) => v.id === 'ea-php74');
    expect(ea).toMatchObject({ version: '7.4', installed: true, offered: false, removable: false, layout: 'ea4' });
    // Without any PHP on the host the list still answers: that is when installing one matters most.
    await provision(true, { php: false, 'php-fpm': false });
    phpVersions = [];
    const none = await get('/api/software/php/installable');
    expect(none.status).toBe(200);
    expect(none.body.data.versions.every((v) => !v.installed)).toBe(true);
    expect(none.body.data.effectiveDefault).toBeNull();
    await provision(true);
  });

  it('counts rendered vhosts, PHP-FPM pools, hosting packages, plan snapshots and the Apache pin as usage and refuses the removal naming them', async () => {
    const prevWeb = app.ctx.web;
    const db = app.ctx.db;
    const bobPackage = db.prepare("SELECT package_id FROM accounts WHERE username = 'bob'").get().package_id;
    const usageOf = async (id) => (await get('/api/software/php/installable')).body.data.versions.find((v) => v.id === id);
    const refusal = async (id) => { const res = await del(`/api/software/php/versions/${id}`); expect(res.status).toBe(409); return res.body.error.message; };
    try {
      expect(await usageOf('8.2')).toMatchObject({ inUse: 0, removable: true, inUseDetail: null });
      // A pool the web category wrote, without any domain row naming the version.
      db.prepare("INSERT INTO web_php_pools (username, version, status) VALUES ('bob', '8.2', 'applied')").run();
      expect(await usageOf('8.2')).toMatchObject({ inUse: 1, removable: false, usage: { pools: 1, domains: 0 }, inUseDetail: '1 PHP-FPM pool' });
      expect(await refusal('8.2')).toMatch(/PHP 8\.2 is still used by 1 PHP-FPM pool; move them/);
      db.prepare("DELETE FROM web_php_pools WHERE username = 'bob' AND version = '8.2'").run();
      // A rendered vhost pinned by Modify Account (web_vhosts.php_version, no account_domains row).
      db.prepare("INSERT INTO web_vhosts (domain, username, type, docroot, php_version) VALUES ('pinned.example', 'bob', 'addon', '/home/bob/pinned', '8.2')").run();
      expect(await usageOf('8.2')).toMatchObject({ inUse: 1, removable: false, usage: { vhosts: 1 }, inUseDetail: '1 rendered vhost' });
      // The same site with an explicit domain choice counts once.
      db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot, php_version) VALUES ((SELECT id FROM accounts WHERE username = 'bob'), 'pinned.example', 'addon', '/home/bob/pinned', '8.2')").run();
      expect(await usageOf('8.2')).toMatchObject({ inUse: 1, usage: { domains: 1, vhosts: 0 }, inUseDetail: '1 domain' });
      db.prepare("DELETE FROM account_domains WHERE domain = 'pinned.example'").run();
      db.prepare("DELETE FROM web_vhosts WHERE domain = 'pinned.example'").run();
      // A hosting package pinning the branch in any spelling, and the plan snapshot of an account on it.
      db.prepare("INSERT INTO packages (name, php_version) VALUES ('biz', 'ea-php82')").run();
      expect(await usageOf('8.2')).toMatchObject({ inUse: 1, usage: { packages: ['biz'], accounts: 0 }, inUseDetail: "package 'biz'" });
      db.prepare(`UPDATE accounts SET package_id = (SELECT id FROM packages WHERE name = 'biz'), plan_snapshot_json = json_set(plan_snapshot_json, '$.php_version', 'php82') WHERE username = 'bob'`).run();
      expect(await usageOf('8.2')).toMatchObject({ inUse: 2, usage: { packages: ['biz'], accounts: 1 }, inUseDetail: "package 'biz', 1 account whose plan pins it" });
      expect(await refusal('8.2')).toMatch(/used by package 'biz', 1 account whose plan pins it; move them/);
      db.prepare(`UPDATE accounts SET package_id = ?, plan_snapshot_json = json_set(plan_snapshot_json, '$.php_version', 'ea-php83') WHERE username = 'bob'`).run(bobPackage);
      db.prepare("DELETE FROM packages WHERE name = 'biz'").run();
      // Apache Configuration's web default.
      app.ctx.web = { ...(prevWeb || {}), apache: { settings: () => ({ defaultPhpVersion: '8.2' }) } };
      expect(await usageOf('8.2')).toMatchObject({ inUse: 1, removable: false, usage: { apachePin: true }, inUseDetail: "Apache Configuration's web default" });
      expect(await refusal('8.2')).toMatch(/Apache Configuration's web default/);
      expect(app.agent.callsTo('pkg.php.remove')).toHaveLength(0);
      // The job runs the same check: a pin added while it waited stops it.
      app.ctx.web = prevWeb;
      expect(await usageOf('8.2')).toMatchObject({ inUse: 0, removable: true });
      app.ctx.jobs.stop();
      const res = await del('/api/software/php/versions/8.2');
      expect(res.status).toBe(202);
      db.prepare("INSERT INTO web_php_pools (username, version, status) VALUES ('bob', '8.2', 'applied')").run();
      app.ctx.jobs.start();
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('failed');
      expect(job.error).toBe('PHP 8.2 is now used by 1 PHP-FPM pool; move them to another version first (nothing was removed)');
      expect(app.agent.callsTo('pkg.php.remove')).toHaveLength(0);
    } finally {
      app.ctx.web = prevWeb;
      app.ctx.jobs.start();
      db.prepare("DELETE FROM web_php_pools WHERE username = 'bob' AND version = '8.2'").run();
      db.prepare("DELETE FROM account_domains WHERE domain = 'pinned.example'").run();
      db.prepare("DELETE FROM web_vhosts WHERE domain = 'pinned.example'").run();
      db.prepare(`UPDATE accounts SET package_id = ?, plan_snapshot_json = json_set(plan_snapshot_json, '$.php_version', 'ea-php83') WHERE username = 'bob'`).run(bobPackage);
      db.prepare("DELETE FROM packages WHERE name = 'biz'").run();
    }
  });

  it('refuses a branch outside the catalog before any source is touched, and a second job while the package manager is held', async () => {
    const enables = app.agent.callsTo('pkg.php.source.enable').length;
    const bad = await post('/api/software/php/install', { version: '9.9' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields).toEqual({ version: ['One of 7.4, 8.0, 8.1, 8.2, 8.3, 8.4, 8.5'] });
    // The job honours the catalog the agent reports too (a queued job from before a catalog change).
    const direct = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.php.install', { version: '9.9' }, { userId: null }).id);
    expect(direct.status).toBe('failed');
    expect(direct.error).toMatch(/PHP 9\.9 is not a branch Ondřej Surý PPA .* publishes; nothing was enabled/);
    expect(app.agent.callsTo('pkg.php.source.enable')).toHaveLength(enables);
    expect(phpSource.configured).toBe(false);
    // apt/dnf hold one lock: a queued or running package job refuses a second one at the API.
    app.ctx.jobs.stop();
    const held = app.ctx.jobs.enqueue('software.pkg.update_index', {}, { userId: null });
    try {
      const res = await post('/api/software/php/install', { version: '8.4' });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe(`Job #${held.id} (software.pkg.update_index) is queued and holds the package manager; wait for it to finish`);
      const rm = await del('/api/software/php/versions/8.2');
      expect(rm.status).toBe(409);
      expect(rm.body.error.message).toMatch(/holds the package manager/);
    } finally { app.ctx.jobs.start(); }
    expect((await waitForJob(app.ctx, held.id)).status).toBe('done');
    expect(app.ctx.jobs.list({ type: 'software.php.install', limit: 5 }).filter((j) => j.params.version === '8.4' && j.status === 'queued')).toHaveLength(0);
  });

  it('installs a branch through a job: source enabled on first use, packages, FPM unit, detection refreshed, previous default kept', async () => {
    const detects = app.agent.callsTo('pkg.php.sources.detect').length;
    const dup = await post('/api/software/php/install', { version: '8.3' });
    expect(dup.status).toBe(409);
    expect(app.agent.callsTo('pkg.php.sources.detect')).toHaveLength(detects);
    // The seeded default names a tree this host does not have, so the effective default is only inherited from /usr/bin/php.
    app.ctx.settings.set('php.default_version', 'ea-php83');
    const from = app.agent.calls.length;
    const res = await post('/api/software/php/install', { version: '8.4' });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ version: '8.4', job: { type: 'software.php.install' } });
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toEqual({ version: '8.4', id: '8.4', packages: ['php8.4-fpm', 'php8.4-cli', 'php8.4-common', 'php8.4-mysql', 'php8.4-curl', 'php8.4-gd', 'php8.4-mbstring', 'php8.4-xml', 'php8.4-zip', 'php8.4-intl', 'php8.4-bcmath', 'php8.4-soap'], skipped: ['php8.4-opcache'], fpmUnit: 'php8.4-fpm', unitEnabled: true, source: 'ondrej', sourceEnabled: true, defaultKept: { effectiveDefault: '8.3', pinned: true, cliRestored: true } });
    // Order: already-installed check, the pre-install defaults, source detection, source enabled (not offered yet), re-detected, installed, FPM enabled, php-fpm trees re-read, defaults compared, CLI pointed back.
    expect(phpCalls(from)).toEqual(['pkg.php.versions', 'pkg.detect', 'pkg.php.versions', 'pkg.php.sources.detect', 'pkg.php.source.enable', 'pkg.php.sources.detect', 'pkg.php.install', 'svc.enable', 'web.phpfpm.detect', 'pkg.php.versions', 'pkg.php.default.set']);
    // The install moved /usr/bin/php to 8.4; the job pointed it back and pinned the panel default to the branch that was effective before.
    expect(app.agent.callsTo('pkg.php.default.set').pop().args).toEqual({ version: '8.3' });
    expect(phpDefaultId).toBe('8.3');
    expect(app.ctx.settings.get('php.default_version')).toBe('8.3');
    expect((await get('/api/software/php/versions')).body.data).toMatchObject({ defaultId: '8.3', effectiveDefault: '8.3' });
    expect(job.logs.some((l) => l.line === 'system default pinned to PHP 8.3 (it was only inherited from /usr/bin/php before)')).toBe(true);
    expect(job.logs.some((l) => l.line === '/usr/bin/php moved to PHP 8.4 with the install; pointed back at PHP 8.3')).toBe(true);
    expect(app.agent.callsTo('pkg.php.source.enable').pop().args).toEqual({ source: 'ondrej', wait: false });
    // The extension set is the stack catalog's php component, as suffixes.
    expect(app.agent.callsTo('pkg.php.install').pop().args).toEqual({ version: '8.4', extensions: ['mysql', 'curl', 'gd', 'mbstring', 'xml', 'zip', 'intl', 'bcmath', 'soap', 'opcache'], wait: false });
    expect(app.agent.callsTo('svc.enable').pop().args).toEqual({ unit: 'php8.4-fpm' });
    expect(job.logs.some((l) => l.line.includes('add-apt-repository ppa:ondrej/php: ok'))).toBe(true);
    expect(job.logs.some((l) => l.level === 'warn' && l.line.includes('skipped: php8.4-opcache'))).toBe(true);
    expect((await get('/api/software/php/versions')).body.data.versions.map((v) => v.id)).toEqual(['8.3', '8.2', '8.4']);
    expect((await get('/api/software/php/installable')).body.data.versions.find((v) => v.version === '8.4')).toMatchObject({ installed: true, removable: true });
    expect(app.ctx.db.prepare("SELECT target, args_redacted FROM audit_log WHERE action = 'software.php.install' ORDER BY id DESC").get()).toMatchObject({ target: '8.4' });
    // A configured source that does not carry the branch fails the job without touching the source again.
    const before = app.agent.callsTo('pkg.php.source.enable').length;
    const missing = await post('/api/software/php/install', { version: '8.5' });
    expect(missing.status).toBe(202);
    const failed = await waitForJob(app.ctx, missing.body.data.job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/PHP 8\.5 is not offered by Ondřej Surý PPA/);
    expect(app.agent.callsTo('pkg.php.source.enable')).toHaveLength(before);
    expect(app.agent.callsTo('pkg.php.install').filter((c) => c.args.version === '8.5')).toHaveLength(0);
    // An install that does not move /usr/bin/php (an older branch) changes neither default.
    phpSource.configured = true;
    const sets = app.agent.callsTo('pkg.php.default.set').length;
    const older = await waitForJob(app.ctx, (await post('/api/software/php/install', { version: '8.1' })).body.data.job.id);
    expect(older.status).toBe('done');
    expect(older.result.defaultKept).toEqual({ effectiveDefault: '8.3', pinned: false, cliRestored: false });
    expect(app.agent.callsTo('pkg.php.default.set')).toHaveLength(sets);
  });

  it('enables packages.sury.org on a Debian host the same way (the card offers it, the job writes the keyring and list through the agent)', async () => {
    phpSource.host = 'debian';
    try {
      const card = (await get('/api/software/php/installable')).body.data;
      expect(card).toMatchObject({ os: { id: 'debian', codename: 'bookworm' }, source: { key: 'sury', label: SURY_LABEL, configured: false, supported: true, reason: null } });
      expect(card.versions.find((v) => v.version === '8.1')).toMatchObject({ installed: false, offered: false, source: null });
      const from = app.agent.calls.length;
      const res = await post('/api/software/php/install', { version: '8.1' });
      expect(res.status).toBe(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ version: '8.1', source: 'sury', sourceEnabled: true, fpmUnit: 'php8.1-fpm', unitEnabled: true });
      expect(job.result.packages).toContain('php8.1-fpm');
      expect(phpCalls(from)).toEqual(['pkg.php.versions', 'pkg.detect', 'pkg.php.versions', 'pkg.php.sources.detect', 'pkg.php.source.enable', 'pkg.php.sources.detect', 'pkg.php.install', 'svc.enable', 'web.phpfpm.detect', 'pkg.php.versions']);
      expect(app.agent.callsTo('pkg.php.source.enable').pop().args).toEqual({ source: 'sury', wait: false });
      expect(job.logs.some((l) => l.line.includes('signing key: ok'))).toBe(true);
      expect(job.logs.some((l) => l.line.includes('sources list: ok'))).toBe(true);
      expect((await get('/api/software/php/installable')).body.data).toMatchObject({ source: { key: 'sury', configured: true } });
      expect((await get('/api/software/php/versions')).body.data.versions.map((v) => v.id)).toContain('8.1');
    } finally { phpSource.host = 'ubuntu'; }
  });

  it('removes the source entry again when the detached index refresh fails right after enabling it', async () => {
    const run = { id: 'update_index-0123456789ab', kind: 'update_index', bin: '/usr/bin/apt-get', pid: 777, startedAt: new Date().toISOString(), timeoutMs: 60_000, logPath: '/var/lib/whm/pkg-runs/update_index-0123456789ab.log' };
    let changed = true;
    app.agent.set('pkg.php.source.enable', ({ source }) => ({ source, label: PHP_SOURCE_LABEL, changed, alreadyConfigured: !changed, steps: changed ? [{ step: 'add-apt-repository ppa:ondrej/php', ok: true }] : [], background: true, run }));
    app.agent.set('pkg.run.status', () => ({ ...run, status: 'finished', code: 100, output: ["E: The repository 'https://ppa.launchpadcontent.net/ondrej/php/ubuntu plucky Release' does not have a Release file."], offset: 120, done: true }));
    app.agent.set('pkg.php.source.rollback', ({ source }) => ({ source, label: PHP_SOURCE_LABEL, steps: [{ step: 'add-apt-repository -r ppa:ondrej/php', ok: true }], configured: false }));
    const installs = app.agent.callsTo('pkg.php.install').length;
    try {
      const job = await waitForJob(app.ctx, (await post('/api/software/php/install', { version: '8.4' })).body.data.job.id);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/enable Ondřej Surý PPA .* exited with status 100: E: The repository/);
      expect(app.agent.callsTo('pkg.php.source.rollback').pop().args).toEqual({ source: 'ondrej' });
      expect(job.logs.some((l) => l.level === 'warn' && /the package index could not be refreshed; removing its entry again/.test(l.line))).toBe(true);
      expect(job.logs.some((l) => l.line === 'rollback: add-apt-repository -r ppa:ondrej/php')).toBe(true);
      expect(app.agent.callsTo('pkg.php.install')).toHaveLength(installs);
      // An entry that was already there is never removed for a failed refresh.
      changed = false;
      const rollbacks = app.agent.callsTo('pkg.php.source.rollback').length;
      const again = await waitForJob(app.ctx, (await post('/api/software/php/install', { version: '8.4' })).body.data.job.id);
      expect(again.status).toBe('failed');
      expect(app.agent.callsTo('pkg.php.source.rollback')).toHaveLength(rollbacks);
    } finally {
      app.agent.reset('pkg.php.source.enable');
      app.agent.set('pkg.run.status', undefined);
      app.agent.set('pkg.php.source.rollback', undefined);
    }
  });

  it('refuses to remove the system default, the CLI default and a version domains use; removes the rest through a job', async () => {
    expect((await del('/api/software/php/versions/7.4')).status).toBe(404);
    const def = await del('/api/software/php/versions/8.3');
    expect(def.status).toBe(409);
    expect(def.body.error.message).toMatch(/system default/);
    app.ctx.settings.set('php.default_version', '8.2');
    const cli = await del('/api/software/php/versions/8.3');
    expect(cli.status).toBe(409);
    expect(cli.body.error.message).toMatch(/CLI default/);
    app.ctx.settings.set('php.default_version', '8.3');
    await put('/api/software/php/domains', { domains: ['bob.com'], version: '8.2' });
    const used = await del('/api/software/php/versions/8.2');
    expect(used.status).toBe(409);
    expect(used.body.error.message).toMatch(/1 domain/);
    expect(app.agent.callsTo('pkg.php.remove')).toHaveLength(0);
    phpVersions = [...phpVersions, { ...PHP, id: 'ea-php74', label: 'ea-php74', layout: 'ea4', version: '7.4.33', isDefault: false }];
    expect((await del('/api/software/php/versions/ea-php74')).status).toBe(422);
    await put('/api/software/php/domains', { domains: ['bob.com'], version: null });
    const from = app.agent.calls.length;
    const res = await del('/api/software/php/versions/8.2');
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ id: '8.2', version: '8.2', job: { type: 'software.php.remove' } });
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ id: '8.2', version: '8.2', packages: ['php8.2-fpm', 'php8.2-cli', 'php8.2-common'], fpmUnit: 'php8.2-fpm' });
    // Purged: a plain remove would leave /etc/php/8.2/fpm/pool.d behind as a ghost FPM tree.
    expect(app.agent.callsTo('pkg.php.remove').pop().args).toEqual({ version: '8.2', purge: true, wait: false });
    // The request's guards, the job's re-run of them, the removal, the php-fpm trees re-read.
    expect(phpCalls(from)).toEqual(['pkg.php.versions', 'pkg.php.versions', 'pkg.php.remove', 'web.phpfpm.detect']);
    expect((await get('/api/software/php/versions')).body.data.versions.map((v) => v.id)).toEqual(['8.3', 'ea-php74']);
    expect(app.ctx.db.prepare("SELECT target FROM audit_log WHERE action = 'software.php.remove' ORDER BY id DESC").get()).toMatchObject({ target: '8.2' });
    // The job re-checks usage: a domain moved onto the version between the request and the run stops the removal.
    phpVersions = [PHP, PHP82];
    await put('/api/software/php/domains', { domains: ['bob.com'], version: '8.2' });
    const removes = app.agent.callsTo('pkg.php.remove').length;
    const queued = app.ctx.jobs.enqueue('software.php.remove', { id: '8.2', version: '8.2' }, { userId: null });
    const stopped = await waitForJob(app.ctx, queued.id);
    expect(app.agent.callsTo('pkg.php.remove')).toHaveLength(removes);
    expect(stopped.status).toBe('failed');
    expect(stopped.error).toMatch(/now used by 1 domain/);
    await put('/api/software/php/domains', { domains: ['bob.com'], version: null });
    // ...and the defaults: a system or CLI default set while the job waited in the queue stops it too.
    app.ctx.settings.set('php.default_version', '8.2');
    const defaulted = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.php.remove', { id: '8.2', version: '8.2' }, { userId: null }).id);
    expect(defaulted.status).toBe('failed');
    expect(defaulted.error).toBe('PHP 8.2 is the system default; make another version the default before removing it (nothing was removed)');
    app.ctx.settings.set('php.default_version', '8.3');
    phpDefaultId = '8.2';
    const cliDefault = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.php.remove', { id: '8.2', version: '8.2' }, { userId: null }).id);
    expect(cliDefault.status).toBe('failed');
    expect(cliDefault.error).toMatch(/CLI default.*\(nothing was removed\)/);
    phpDefaultId = '8.3';
    expect(app.agent.callsTo('pkg.php.remove')).toHaveLength(removes);
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

  it('hands the HTTPS catch-all the hostname bundle, else the pair the Apache catch-all vhost resolved, and re-renders when either changes', async () => {
    const prev = { ssl: app.ctx.ssl, web: app.ctx.web, hostname: app.ctx.settings.get('basic.hostname') };
    app.ctx.web = undefined;
    app.ctx.settings.set('basic.hostname', 'host.example.com');
    const certs = new Set();
    app.ctx.ssl = { certForDomain: (d) => (certs.has(d) ? { state: 'installed', installed: 1 } : null), bundlePaths: (d) => ({ cert: `/etc/ssl/whm/${d}/cert.pem`, fullchain: `/etc/ssl/whm/${d}/fullchain.pem`, key: `/etc/ssl/whm/${d}/key.pem` }) };
    const applies = app.ctx.db.prepare("INSERT INTO service_config_applies (component, ok, summary, error, applied_at) VALUES ('default_vhost', ?, ?, NULL, datetime('now')) ON CONFLICT (component) DO UPDATE SET ok = excluded.ok, summary = excluded.summary");
    const lastWrite = () => app.agent.callsTo('pkg.nginx.proxy.write').pop().args;
    const panelPair = { cert: '/etc/whm/tls/cert.pem', key: '/etc/whm/tls/key.pem' };
    try {
      await put('/api/software/nginx', { enabled: false });
      app.ctx.db.prepare("DELETE FROM service_config_applies WHERE component = 'default_vhost'").run();
      // Nothing known: the arg stays away and the agent keeps its reject-handshake block.
      expect((await put('/api/software/nginx', { enabled: true })).status).toBe(200);
      expect(lastWrite()).not.toHaveProperty('defaultServer');
      expect((await get('/api/software/nginx')).body.data).toMatchObject({ defaultServer: null, stale: false });
      // The catch-all vhost resolved the panel listener's pair: the proxy is stale until it carries the same pair.
      applies.run(1, JSON.stringify({ hostname: 'host.example.com', ssl: { ...panelPair, chain: null, fullchain: null, source: 'panel' } }));
      expect((await get('/api/software/nginx')).body.data).toMatchObject({ defaultServer: panelPair, stale: true });
      expect((await post('/api/software/nginx/sync')).status).toBe(200);
      expect(lastWrite().defaultServer).toEqual(panelPair);
      expect((await get('/api/software/nginx')).body.data).toMatchObject({ defaultServer: panelPair, stale: false });
      // A fullchain wins over the leaf; a pair outside the stores the agent reads for it, or a failed apply, is never forwarded.
      applies.run(1, JSON.stringify({ ssl: { cert: '/etc/ssl/whm/service/apache/cert.pem', fullchain: '/etc/ssl/whm/service/apache/fullchain.pem', key: '/etc/ssl/whm/service/apache/key.pem', source: 'apache-service' } }));
      expect((await get('/api/software/nginx')).body.data.defaultServer).toEqual({ cert: '/etc/ssl/whm/service/apache/fullchain.pem', key: '/etc/ssl/whm/service/apache/key.pem' });
      applies.run(1, JSON.stringify({ ssl: { cert: '/etc/ssl/private/snakeoil.pem', key: '/etc/ssl/private/snakeoil.key', source: 'apache-service' } }));
      expect((await get('/api/software/nginx')).body.data.defaultServer).toBeNull();
      applies.run(1, JSON.stringify({ ssl: { cert: '/etc/whm/tls/../whm.conf', key: panelPair.key, source: 'panel' } }));
      expect((await get('/api/software/nginx')).body.data.defaultServer).toBeNull();
      applies.run(0, JSON.stringify({ ssl: { ...panelPair, source: 'panel' } }));
      expect((await get('/api/software/nginx')).body.data.defaultServer).toBeNull();
      applies.run(1, 'null');
      expect((await get('/api/software/nginx')).body.data.defaultServer).toBeNull();
      // The hostname's own installed certificate comes first: its bundle's fullchain and key, picked up by the scheduled sync.
      applies.run(1, JSON.stringify({ ssl: { ...panelPair, source: 'panel' } }));
      certs.add('host.example.com');
      const own = { cert: '/etc/ssl/whm/host.example.com/fullchain.pem', key: '/etc/ssl/whm/host.example.com/key.pem' };
      expect((await get('/api/software/nginx')).body.data).toMatchObject({ defaultServer: own, stale: true });
      const synced = await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.nginx.sync', {}).id);
      expect(synced.result).toMatchObject({ skipped: false });
      expect(lastWrite().defaultServer).toEqual(own);
      expect((await get('/api/software/nginx')).body.data.stale).toBe(false);
      expect((await waitForJob(app.ctx, app.ctx.jobs.enqueue('software.nginx.sync', {}).id)).result).toMatchObject({ skipped: true, reason: 'current' });
      // The hostname certificate goes away: back to the catch-all vhost's pair, and stale again.
      certs.clear();
      expect((await get('/api/software/nginx')).body.data).toMatchObject({ defaultServer: panelPair, stale: true });
      await put('/api/software/nginx', { enabled: false });
    } finally {
      app.ctx.ssl = prev.ssl; app.ctx.web = prev.web;
      app.ctx.settings.set('basic.hostname', prev.hostname ?? '');
      app.ctx.db.prepare("DELETE FROM service_config_applies WHERE component = 'default_vhost'").run();
    }
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
