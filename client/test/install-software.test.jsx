import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const fixtures = vi.hoisted(() => ({ responses: new Map(), posts: [] }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));
vi.mock('../src/api/client.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { ...mod.api, post: async (path, body) => { fixtures.posts.push([path, body]); return { data: { job: { id: 42 } } }; } } };
});

const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { FUNCTION_BY_KEY } = await import('../src/nav.js');
const { default: InstallSoftware, readDeepLink, TABS } = await import('../src/pages/fn/software/install-distro-packages.jsx');
const { default: ModuleInstallers, installerPackages } = await import('../src/pages/fn/software/module-installers.jsx');
const { default: MultiPhpManager, removeBlocker, removalExtras, removeConfirm, toggleOffered, updateState, phpUpdateBody, phpUpdateMessage, phpUpdateDanger, phpRemovePackagesBody, checkForUpdates, PhpUpdateCell } = await import('../src/pages/fn/software/multiphp-manager.jsx');
const { ApiError } = await import('../src/api/client.js');
const { generatorPackages } = await import('../src/pages/fn/server-configuration/statistics-software-configuration.jsx');
const { quotaPackages } = await import('../src/pages/fn/server-configuration/initial-quota-setup.jsx');
const { InstallPackages, installPackagesBody, normalizePackages } = await import('../src/components/InstallPackages.jsx');
const { CapabilityNotice } = await import('../src/components/Common.jsx');
const { RuntimeInstaller, runtimeInstallBody, toolInstallBody, sourceBuildMessage } = await import('../src/pages/software/Shared.jsx');
const { ToolingNotice, toolPackages } = await import('../src/pages/transfers/Shared.jsx');
const { bindPackages } = await import('../src/pages/clusters/DnsCluster.jsx');
const { iprouteQuery, Iproute2Notice } = await import('../src/pages/ip/Shared.jsx');
const { default: PhpMyAdminAdmin } = await import('../src/pages/fn/database-services/phpmyadmin.jsx');

React.useLayoutEffect = React.useEffect;

const render = (el, path = '/software/install-distro-packages') => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ToastProvider, null, h(ConfirmProvider, null, el))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });
const fn = FUNCTION_BY_KEY['software/install-distro-packages'];

const catalog = {
  family: 'debian', os: { id: 'ubuntu', versionId: '24.04' }, manager: 'apt', capability: true,
  runtimes: [
    { key: 'php', label: 'PHP', single: false, versions: [
      { id: '8.4', label: 'PHP 8.4', installed: false, version: null, packages: ['php8.4-fpm', 'php8.4-cli'], repo: 'php', note: null, method: 'package' },
      { id: '8.3', label: 'PHP 8.3', installed: true, version: '8.3.19', packages: ['php8.3-fpm', 'php8.3-cli'], repo: 'php', note: null, method: 'package' },
      { id: '8.2', label: 'PHP 8.2', installed: false, version: null, packages: [], repo: 'php', note: 'Built from the official php.net source into /opt/keel/php/8.2 (about 15 minutes); packages from ppa:ondrej/php are not available for ubuntu 26.04', method: 'source', state: 'available' },
      { id: '8.1', label: 'PHP 8.1 (Keel build)', installed: true, version: '8.1.33', packages: [], repo: 'php', note: null, method: 'source', source: true, state: 'installed' },
    ] },
    { key: 'nodejs', label: 'Node.js', single: false, versions: [{ id: '22', label: 'Node.js 22', installed: true, version: 'v22.14.0', packages: [], repo: null, note: 'installed under /opt/keel/node/22' }] },
    { key: 'ruby', label: 'Ruby', single: true, versions: [{ id: 'ruby', label: 'Ruby', installed: false, version: null, packages: ['ruby-full'], repo: null, note: null }] },
  ],
  tools: [{ key: 'git', label: 'Git', packages: ['git'], installed: true }, { key: 'imagemagick', label: 'ImageMagick', packages: ['imagemagick'], installed: false }],
};
const detect = { manager: 'apt', family: 'debian', capability: true, rebootRequired: false };

describe('nav entry', () => {
  it('keeps the install-distro-packages slug under the Install Software label', () => {
    expect(fn).toMatchObject({ label: 'Install Software', path: '/software/install-distro-packages' });
    expect(fn.description).toContain('One-click PHP, Node.js, Python');
  });
});

describe('Install Software page', () => {
  it('defaults to the runtimes tab and lists PHP versions with Install / Installed', () => {
    fixtures.responses.clear();
    set('/software/pkg/detect', { data: detect });
    set('/software/pkg/recent', { data: [] });
    set('/software/runtimes/recent', { data: [] });
    set('/software/runtimes', { data: catalog });
    const html = render(h(InstallSoftware, { fn }));
    expect(html).toContain('<h1>Install Software</h1>');
    expect(html).toContain('PHP 8.4');
    expect(html).toContain('PHP 8.3');
    expect(html).not.toContain('PHP PHP');
    expect(html).not.toContain('Node.js Node.js');
    expect(html).toContain('Installed · 8.3.19');
    expect(html).toContain('>Install</button>');
    expect(html).toContain('>Installed</span>');
    expect(html).toContain('/usr/local/bin/node22');
    expect(html).toContain('>Remove</button>');
    expect(html).not.toContain('ImageMagick');
    // Without check times from the catalog every installed PHP row is still being checked.
    expect(html).toContain('<th>Updates</th>');
    expect(html).toContain('>Check for updates</button>');
    expect((html.match(/Checking…/g) || []).length).toBe(2);
  });

  it('shows the update state of every installed PHP row: up to date (packages / php.net), update available, security update', async () => {
    fixtures.responses.clear();
    fixtures.posts.length = 0;
    set('/software/pkg/detect', { data: detect });
    set('/software/pkg/recent', { data: [] });
    set('/software/runtimes/recent', { data: [] });
    const stamp = { checkedAt: '2026-11-06T06:00:00.000Z', packagesCheckedAt: '2026-11-06T05:41:00.000Z', releasesCheckedAt: '2026-11-06T05:50:00.000Z' };
    const php = catalog.runtimes[0];
    const versions = [
      php.versions[0],
      { ...php.versions[1], update: { candidate: '8.3.36-1', severity: 'critical', reasons: ['CVE-2026-109619: PHP2Shell (fixed in 8.3.36)'], current: '8.3.19', source: 'package', checkedAt: stamp.packagesCheckedAt } },
      { id: '8.2', label: 'PHP 8.2', installed: true, version: '8.2.29', packages: ['php8.2-fpm'], repo: 'php', note: null, method: 'package', update: null },
      { ...php.versions[3], update: { candidate: '8.1.34', severity: 'update', reasons: ['php.net released 8.1.34'], current: '8.1.33', source: 'release', checkedAt: stamp.releasesCheckedAt } },
      { id: '8.0', label: 'PHP 8.0 (Keel build)', installed: true, version: '8.0.30', packages: [], repo: 'php', note: null, method: 'source', source: true, state: 'installed', update: null },
    ];
    set('/software/runtimes', { data: { ...catalog, runtimes: [{ ...php, versions }, ...catalog.runtimes.slice(1)], updates: stamp } });
    const html = render(h(InstallSoftware, { fn }));
    expect(html).not.toContain('Checking…');
    expect(html).toContain('>Security update<');
    expect(html).toMatch(/<button type="button" class="btn btn-danger btn-sm[^"]*" title="CVE-2026-109619: PHP2Shell \(fixed in 8\.3\.36\)">Update<\/button>/);
    expect(html).toContain('Update available: <strong>8.1.34</strong>');
    expect(html).toMatch(/<button type="button" class="btn btn-primary btn-sm[^"]*" title="php.net released 8\.1\.34">Update<\/button>/);
    expect((html.match(/>Update<\/button>/g) || []).length).toBe(2);
    expect(html).toContain('Up to date · 8.2.29');
    expect(html).toContain(`Distribution packages · checked ${new Date(stamp.packagesCheckedAt).toLocaleString()}`);
    expect(html).toContain('Up to date · 8.0.30');
    expect(html).toContain(`Latest php.net release · checked ${new Date(stamp.releasesCheckedAt).toLocaleString()}`);
    // A row that is not installed has no update state.
    expect(updateState({ installed: false }, stamp)).toBeNull();
    expect(updateState(versions[2], stamp)).toMatchObject({ kind: 'distro', checkedAt: stamp.packagesCheckedAt });
    expect(updateState(versions[4], stamp)).toMatchObject({ kind: 'latest', checkedAt: stamp.releasesCheckedAt });
    expect(updateState(versions[4], stamp, true)).toMatchObject({ kind: 'checking' });
    expect(updateState(versions[4], null)).toMatchObject({ kind: 'checking' });
    expect(updateState(versions[1], stamp)).toMatchObject({ kind: 'security', candidate: '8.3.36-1' });
    expect(updateState(versions[3], stamp)).toMatchObject({ kind: 'update', candidate: '8.1.34', checkedAt: stamp.releasesCheckedAt });
    expect(updateState({ installed: true, update: { candidate: null, severity: 'critical', reasons: ['CVE-1'] } }, stamp)).toMatchObject({ kind: 'nofix' });
    // No package check / php.net lookup has ever succeeded: no verdict, no fabricated time.
    const unchecked = { checkedAt: '2026-11-06T06:00:00.000Z', packagesCheckedAt: null, releasesCheckedAt: null };
    expect(updateState(versions[2], unchecked)).toEqual({ kind: 'unknown', candidate: null, reasons: [], checkedAt: null });
    expect(updateState(versions[4], unchecked)).toEqual({ kind: 'unknown', candidate: null, reasons: [], checkedAt: null });
    expect(updateState(versions[2], { ...unchecked, releasesCheckedAt: stamp.releasesCheckedAt })).toMatchObject({ kind: 'unknown' });
    expect(updateState(versions[4], { ...unchecked, packagesCheckedAt: stamp.packagesCheckedAt })).toMatchObject({ kind: 'unknown' });
    set('/software/runtimes', { data: { ...catalog, runtimes: [{ ...php, versions: [versions[2], versions[4]] }, ...catalog.runtimes.slice(1)], updates: unchecked } });
    const unverified = render(h(InstallSoftware, { fn }));
    expect(unverified).not.toContain('Up to date');
    expect(unverified).not.toMatch(/(Distribution packages|Latest php\.net release) · checked/);
    expect((unverified.match(/Not checked yet — use Check for updates/g) || []).length).toBe(2);
    // The Update button posts the version alone; the confirm names the method.
    expect(phpUpdateBody(versions[1])).toEqual({ version: '8.3' });
    expect(phpUpdateMessage(versions[1])).toMatch(/^Upgrades the pending php8\.3-\* packages to 8\.3\.36-1 and reloads PHP-FPM\. CVE-2026-109619/);
    expect(phpUpdateMessage(versions[3])).toMatch(/^Rebuilds PHP 8\.1 from the official php\.net 8\.1\.34 source over \/opt\/keel\/php\/8\.1 .* restarts keel-php8\.1-fpm and re-renders every domain on PHP 8\.1 onto it\./);
    // Check for updates posts the refresh, then refetches the catalog.
    let refetched = 0;
    await checkForUpdates(() => { refetched += 1; });
    expect(fixtures.posts).toEqual([['/software/updates/critical/refresh', undefined]]);
    expect(refetched).toBe(1);
  });

  it('opens the search tab with the term from ?tab=search&q=', () => {
    fixtures.responses.clear();
    set('/software/pkg/detect', { data: detect });
    set('/software/pkg/recent', { data: [] });
    set('/software/runtimes/recent', { data: [] });
    set('/software/pkg/search?q=imagemagick&limit=200', { data: { q: 'imagemagick', results: [{ name: 'imagemagick', summary: 'image manipulation programs', installed: false }] } });
    const html = render(h(InstallSoftware, { fn }), '/software/install-distro-packages?tab=search&q=imagemagick');
    expect(html).toContain('value="imagemagick"');
    expect(html).toContain('image manipulation programs');
    expect(html).not.toContain('PHP 8.4');
  });

  it('pre-selects ?install= packages in the search tab without starting a job', () => {
    fixtures.responses.clear();
    fixtures.posts.length = 0;
    set('/software/pkg/detect', { data: detect });
    set('/software/pkg/recent', { data: [] });
    set('/software/runtimes/recent', { data: [] });
    set('/software/pkg/search?q=bind9%20bind9utils&limit=200', { data: { q: 'bind9 bind9utils', results: [] } });
    const html = render(h(InstallSoftware, { fn }), '/software/install-distro-packages?install=bind9,bind9utils');
    expect(html).toContain('Install bind9, bind9utils');
    expect(fixtures.posts).toEqual([]);
    expect(readDeepLink(new URLSearchParams('install=bind9,bind9utils'))).toEqual({ tab: 'search', q: '', install: ['bind9', 'bind9utils'] });
    expect(readDeepLink(new URLSearchParams('install=../x,ok'))).toEqual({ tab: 'search', q: '', install: ['ok'] });
    expect(readDeepLink(new URLSearchParams('tab=bogus'))).toEqual({ tab: 'runtimes', q: '', install: [] });
    expect(TABS).toEqual(['runtimes', 'tools', 'search', 'installed', 'history']);
  });

  it('lists installed runtimes and tools with updates above each tab, with the Update button, from the critical list', () => {
    fixtures.responses.clear();
    set('/software/pkg/detect', { data: detect });
    set('/software/pkg/recent', { data: [] });
    set('/software/runtimes/recent', { data: [] });
    set('/software/runtimes', { data: catalog });
    set('/software/updates/critical', { data: { items: [
      { kind: 'php', id: '8.3', label: 'PHP 8.3', current: '8.3.19', candidate: '8.3.36-1', severity: 'critical', reasons: ['CVE-2026-109619: PHP2Shell'], packages: ['php8.3-fpm'], action: { method: 'POST', path: '/software/php/update', body: { version: '8.3' } } },
      { kind: 'runtime', id: 'nodejs:22', label: 'Node.js 22', current: 'v22.14.0', candidate: 'v22.15.0', severity: 'update', reasons: ['nodejs.org released v22.15.0'], packages: [], action: { method: 'POST', path: '/software/runtimes/update', body: { runtime: 'nodejs', version: '22' } } },
      { kind: 'tool', id: 'git', label: 'Git', current: '2.43.0-1', candidate: '2.43.0-2', severity: 'update', reasons: ['git 2.43.0-1 → 2.43.0-2'], packages: ['git'], action: { method: 'POST', path: '/software/runtimes/update', body: { tool: 'git' } } },
    ] } });
    const runtimes = render(h(InstallSoftware, { fn }));
    expect(runtimes).toContain('Installed runtimes with updates');
    expect(runtimes).toContain('Update to 8.3.36-1');
    expect(runtimes).toContain('Update to v22.15.0');
    expect(runtimes).not.toContain('Update to 2.43.0-2');
    const tools = render(h(InstallSoftware, { fn }), '/software/install-distro-packages?tab=tools');
    expect(tools).toContain('Installed tools with updates');
    expect(tools).toContain('Update to 2.43.0-2');
    expect(tools).not.toContain('Update to 8.3.36-1');
    const search = render(h(InstallSoftware, { fn }), '/software/install-distro-packages?tab=search');
    expect(search).not.toContain('with updates');
  });

  it('shows the tools grid on the tools tab', () => {
    fixtures.responses.clear();
    set('/software/pkg/detect', { data: detect });
    set('/software/pkg/recent', { data: [] });
    set('/software/runtimes/recent', { data: [] });
    set('/software/runtimes', { data: catalog });
    const html = render(h(InstallSoftware, { fn }), '/software/install-distro-packages?tab=tools');
    expect(html).toContain('ImageMagick');
    expect(html).not.toContain('PHP 8.4');
  });
});

describe('RuntimeInstaller', () => {
  it('posts { runtime, version } for a version row, { runtime } for a single runtime and { tool } for a tool', () => {
    expect(runtimeInstallBody('php', '8.4')).toEqual({ runtime: 'php', version: '8.4' });
    expect(runtimeInstallBody('php', '8.4', 'source')).toEqual({ runtime: 'php', version: '8.4', method: 'source' });
    expect(runtimeInstallBody('php', '8.4', 'package')).toEqual({ runtime: 'php', version: '8.4', method: 'package' });
    expect(runtimeInstallBody('php', '8.4', 'bogus')).toEqual({ runtime: 'php', version: '8.4' });
    expect(runtimeInstallBody('ruby', undefined)).toEqual({ runtime: 'ruby' });
    expect(toolInstallBody('imagemagick')).toEqual({ tool: 'imagemagick' });
  });

  it('marks source-built PHP rows and explains the build in the confirm copy', () => {
    fixtures.responses.clear();
    set('/software/runtimes', { data: catalog });
    const html = render(h(RuntimeInstaller, { only: ['php'] }));
    expect(html).toContain('>Source build<');
    expect(html).toContain('>Keel build<');
    expect(html).toContain('PHP 8.1 (Keel build)');
    expect(html).toContain('/opt/keel/php/8.2');
    expect(html).toContain('/opt/keel/php/8.1');
    expect(html).toContain('packages from ppa:ondrej/php are not available');
    expect((html.match(/<button type="button" class="btn btn-primary btn-sm[^"]*">Install<\/button>/g) || []).length).toBe(2);
    expect(html).not.toMatch(/disabled=""[^>]*>Install<\/button>/);
    expect(sourceBuildMessage('8.2')).toContain('php.net');
    expect(sourceBuildMessage('8.2')).toContain('/opt/keel/php/8.2');
    expect(sourceBuildMessage('8.2')).toContain('about 15 minutes');
  });

  it('restricts to the given runtimes and takes a custom title', () => {
    fixtures.responses.clear();
    set('/software/runtimes', { data: catalog });
    const html = render(h(RuntimeInstaller, { only: ['php'], title: 'Install another PHP version' }));
    expect(html).toContain('Install another PHP version');
    expect(html).toContain('PHP 8.4');
    expect(html).not.toContain('Node.js');
    expect(html).not.toContain('ImageMagick');
  });

  it('runs the install through the runtimes endpoint', async () => {
    fixtures.posts.length = 0;
    const { api } = await import('../src/api/client.js');
    await api.post('/software/runtimes/install', runtimeInstallBody('php', '8.4'));
    expect(fixtures.posts).toEqual([['/software/runtimes/install', { runtime: 'php', version: '8.4' }]]);
  });
});

describe('InstallPackages', () => {
  it('normalises package lists and posts exactly those packages', async () => {
    expect(normalizePackages('bind9 bind9utils  bind9')).toEqual(['bind9', 'bind9utils']);
    expect(normalizePackages(['git', '', ' ffmpeg '])).toEqual(['git', 'ffmpeg']);
    expect(installPackagesBody(['php-pear', 'php-dev'])).toEqual({ packages: ['php-pear', 'php-dev'] });
    fixtures.posts.length = 0;
    const { api } = await import('../src/api/client.js');
    await api.post('/software/pkg/install', installPackagesBody('openssh-server'));
    expect(fixtures.posts).toEqual([['/software/pkg/install', { packages: ['openssh-server'] }]]);
  });

  it('renders an Install button naming the packages and nothing for an empty list', () => {
    const html = render(h(InstallPackages, { packages: ['imagemagick', 'ffmpeg'] }));
    expect(html).toContain('Install imagemagick, ffmpeg');
    expect(html).toContain('title="apt/dnf install imagemagick ffmpeg"');
    expect(render(h(InstallPackages, { packages: [] }))).not.toContain('<button');
  });

  it('CapabilityNotice installs in place when packages are known, otherwise links to Install Software', () => {
    const error = { code: 'capability_missing', message: 'BIND is not installed' };
    const withPackages = render(h(CapabilityNotice, { error, packages: 'bind9 bind9utils' }));
    expect(withPackages).toContain('Install bind9, bind9utils');
    expect(withPackages).not.toContain('install-distro-packages');
    const without = render(h(CapabilityNotice, { error }));
    expect(without).toContain('href="/software/install-distro-packages?tab=search"');
    expect(without).toContain('Install Software');
    expect(without).not.toContain('Install Distro Packages');
  });
});

describe('pages that used to link to the package search', () => {
  it('ToolingNotice picks the host-family package out of the "debian / rhel" capability hint', () => {
    expect(toolPackages('openssh-client / openssh-clients', 'debian')).toEqual(['openssh-client']);
    expect(toolPackages('openssh-client / openssh-clients', 'rhel')).toEqual(['openssh-clients']);
    expect(toolPackages('openssh-client / openssh-clients', undefined)).toEqual([]);
    expect(toolPackages('sshpass', undefined)).toEqual(['sshpass']);
    expect(installPackagesBody(toolPackages('openssh-client / openssh-clients', 'debian'))).toEqual({ packages: ['openssh-client'] });
    const caps = { ssh: { installed: false, label: 'OpenSSH client (remote transfers)', packages: 'openssh-client / openssh-clients' } };
    fixtures.responses.clear();
    set('/software/pkg/detect', { data: detect });
    const html = render(h(ToolingNotice, { caps, needs: ['ssh'] }));
    expect(html).toContain('Install OpenSSH client (remote transfers)');
    expect(html).toContain('title="apt/dnf install openssh-client"');
    expect(html).not.toContain('Install openssh-client /');
    fixtures.responses.clear();
    expect(render(h(ToolingNotice, { caps, needs: ['ssh'] }))).not.toContain('<button');
  });

  it('phpMyAdmin installs the bare package name, not the command hint', () => {
    fixtures.responses.clear();
    set('/databases/phpmyadmin', { data: { installed: false, dir: null, version: null, configFile: null, webConfigs: [], urlPath: null, php: true, candidates: ['/usr/share/phpmyadmin'], packageHint: 'apt-get install phpmyadmin', package: 'phpmyadmin' } });
    const html = render(h(PhpMyAdminAdmin, { fn: FUNCTION_BY_KEY['database-services/phpmyadmin'] }), '/database-services/phpmyadmin');
    expect(html).toContain('<code>apt-get install phpmyadmin</code>');
    expect(html).toContain('title="apt/dnf install phpmyadmin"');
    expect(html).not.toContain('install apt-get');
    expect(installPackagesBody(['phpmyadmin'])).toEqual({ packages: ['phpmyadmin'] });
  });

  it('family-dependent install buttons wait for the package-manager detect', () => {
    expect(bindPackages('rhel')).toEqual(['bind', 'bind-utils']);
    expect(iprouteQuery('debian')).toEqual(['iproute2']);
    expect(generatorPackages({ apt: ['awstats'], dnf: ['awstats-rhel'] }, undefined)).toEqual([]);
    fixtures.responses.clear();
    let html = render(h(Iproute2Notice, { meta: { iproute2: false } }));
    expect(html).toContain('iproute2 is not installed');
    expect(html).not.toContain('<button');
    set('/software/pkg/detect', { data: { ...detect, family: 'rhel' } });
    html = render(h(Iproute2Notice, { meta: { iproute2: false } }));
    expect(html).toContain('title="apt/dnf install iproute"');
  });

  it('module-installers renders an Install button with the host-family packages', () => {
    fixtures.responses.clear();
    set('/software/modules/installers', { data: { present: { pecl: false, pear: false, cpanm: true, gem: true, pip3: true }, versions: { perl: '5.38' }, family: 'rhel', packages: { php: ['php-pear', 'php-devel'], perl: ['perl-App-cpanminus'], ruby: ['ruby', 'ruby-devel'], python3: ['python3-pip'] } } });
    const html = render(h(ModuleInstallers, { fn: FUNCTION_BY_KEY['software/module-installers'] }));
    expect(html).toContain('Install php-pear, php-devel');
    expect(html).not.toContain('Install perl-App-cpanminus');
    expect(html).not.toContain('install-distro-packages');
    expect(installerPackages({ packages: { php: [] } }, 'php')).toEqual([]);
    expect(installerPackages(null, 'php')).toEqual([]);
  });

  it('PHP Version Manager lists every catalog version with its state, actions and the offered switch', () => {
    fixtures.responses.clear();
    const row = (o) => ({ installed: false, version: null, binary: null, iniPath: null, fpmInstalled: false, fpmActive: null, fpmUnit: null, isDefault: false, isSystemDefault: false, offered: false, domains: 0, packages: [], repo: 'php', repoStatus: null, advisories: [], note: null, ...o });
    const phpCatalog = {
      family: 'debian', os: { id: 'ubuntu', versionId: '26.04' }, effectiveDefault: '8.3', configuredDefault: '8.3', offered: ['8.3'],
      updates: { checkedAt: '2026-11-06T06:00:00.000Z', packagesCheckedAt: '2026-11-06T05:41:00.000Z', releasesCheckedAt: '2026-11-06T05:50:00.000Z' },
      versions: [
        row({ id: '8.5', label: 'PHP 8.5', state: 'unsupported', repoStatus: { present: false, supported: false, detail: 'ppa:ondrej/php has no packages for Ubuntu resolute' }, note: 'ppa:ondrej/php has no packages for Ubuntu resolute' }),
        row({ id: '8.4', label: 'PHP 8.4', state: 'available', packages: ['php8.4-fpm', 'php8.4-cli'], method: 'package' }),
        row({ id: '8.3', label: 'PHP 8.3', state: 'installed', installed: true, version: '8.3.19', binary: '/usr/bin/php8.3', fpmInstalled: true, fpmActive: true, fpmUnit: 'php8.3-fpm', isDefault: true, isSystemDefault: true, offered: true, domains: 3, method: 'package', update: { candidate: '8.3.36-1', severity: 'critical', reasons: ['CVE-2026-109619: PHP2Shell (fixed in 8.3.36)'] } }),
        row({ id: '8.2', label: 'PHP 8.2', state: 'installed', installed: true, version: '8.2.29', binary: '/usr/bin/php8.2', fpmInstalled: true, fpmActive: false, fpmUnit: 'php8.2-fpm', offered: false, domains: 0, method: 'package', update: { candidate: null, severity: 'critical', reasons: ['CVE-2026-109619: PHP2Shell'] } }),
        row({ id: '8.1', label: 'PHP 8.1', state: 'available', method: 'source', repoStatus: { present: false, supported: false, detail: 'ppa:ondrej/php has no packages for Ubuntu resolute' }, note: 'Built from the official php.net source into /opt/keel/php/8.1 (about 15 minutes); packages from ppa:ondrej/php are not available for ubuntu 26.04' }),
        row({ id: '7.4', label: 'PHP 7.4 (Keel build)', state: 'installed', installed: true, version: '7.4.33', binary: '/opt/keel/php/7.4/bin/php', fpmInstalled: true, fpmActive: true, fpmUnit: 'keel-php7.4-fpm', offered: false, domains: 0, method: 'source', source: true }),
      ],
    };
    set('/software/php/versions', { data: { versions: phpCatalog.versions.filter((v) => v.installed), effectiveDefault: '8.3' } });
    set('/software/php/catalog', { data: phpCatalog });
    set('/software/php/domains', { data: { domains: [], systemDefault: { effective: '8.3' } }, meta: { total: 0 } });
    set('/software/php/pools', { data: { pools: [] } });
    const html = render(h(MultiPhpManager, { fn: FUNCTION_BY_KEY['software/multiphp-manager'] }), '/software/multiphp-manager');
    expect(html).toContain('<h1>PHP Version Manager</h1>');
    expect(html).not.toContain('MultiPHP Manager');
    expect(html).not.toContain('Install another PHP version');
    for (const v of ['PHP 8.5', 'PHP 8.4', 'PHP 8.3', 'PHP 8.2', 'PHP 8.1', 'PHP 7.4 (Keel build)']) expect(html).toContain(`<strong>${v}</strong>`);
    expect(html).toContain('>Not available for this OS<');
    expect(html).toContain('>Available<');
    expect(html).toContain('>Installed<');
    expect(html).toContain('ppa:ondrej/php has no packages for Ubuntu resolute');
    expect(html).toMatch(/<button type="button" class="btn btn-default btn-sm[^"]*" disabled="" title="ppa:ondrej\/php has no packages for Ubuntu resolute">Install<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn btn-default btn-sm[^"]*">Install<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn btn-default btn-sm[^"]*" title="Built from the php.net source into \/opt\/keel\/php\/8.1">Install<\/button>/);
    // Rows keep the grey button: the page's one primary action lives in its header.
    expect(html).not.toMatch(/class="btn btn-primary btn-sm[^"]*"[^>]*>Install<\/button>/);
    expect((html.match(/disabled=""[^>]*>Install<\/button>/g) || []).length).toBe(1);
    expect(html).toContain('>Source build<');
    expect(html).toContain('/opt/keel/php/8.1</code>');
    expect(html).toContain('>Keel build<');
    expect(html).toContain('/opt/keel/php/7.4/bin/php');
    expect(html).toContain('keel-php7.4-fpm');
    expect(html).toContain('Versions marked <em>Source build</em>');
    expect(sourceBuildMessage('8.1')).toContain('official php.net source into /opt/keel/php/8.1');
    expect(html).toMatch(/<button type="button" class="btn btn-danger btn-sm[^"]*" disabled="" title="This is the system default; set another version as default first">Remove<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn btn-danger btn-sm[^"]*">Remove<\/button>/);
    expect(html).toContain('>Set as default</button>');
    // Updates column (contract §63): the row's `update` decides the button; null candidate = nothing to update to yet;
    // no `update` at all = up to date as of the catalog's check times. Check for updates is the header's primary action.
    expect(html).toContain('>Updates</th>');
    expect(html).toContain('>Check for updates</button>');
    expect(html).toContain('>Security update<');
    expect(html).toContain('8.3.36-1');
    expect(html).toMatch(/<button type="button" class="btn btn-danger btn-sm[^"]*" title="CVE-2026-109619: PHP2Shell \(fixed in 8\.3\.36\)">Update<\/button>/);
    expect((html.match(/>Update<\/button>/g) || []).length).toBe(1);
    expect(html).toContain('no fix available yet');
    expect(html).toContain('Up to date · 7.4.33');
    expect(html).toContain('Latest php.net release · checked');
    expect(html).not.toContain('Checking…');
    expect(html).not.toContain('Distribution packages');
    expect(html).toContain('>System default<');
    expect(html).toContain('php8.2-fpm · stopped');
    expect(html).toContain('Offered to accounts');
    expect((html.match(/<input type="checkbox" checked=""/g) || []).length).toBe(1);
    expect((html.match(/<label class="toggle[^"]*"><input type="checkbox"/g) || []).length).toBe(6);
    expect((html.match(/<label class="toggle disabled"><input type="checkbox" disabled=""/g) || []).length).toBe(3);
    expect(html).toContain('>Install first<');
    expect(html).not.toContain('Install Distro Packages');
    expect(removeBlocker({ installed: true, isSystemDefault: false, domains: 2 })).toContain('2 domain(s)');
    expect(removeBlocker({ installed: true, isSystemDefault: false, domains: 0 })).toBeNull();
    expect(removeBlocker({ installed: true, isSystemDefault: false, isDefault: true, domains: 0 })).toContain('CLI default');
    expect(removeBlocker({ installed: true, isSystemDefault: false, domains: 0 }, 1)).toContain('only installed version');
    expect(removeBlocker({ installed: true, isSystemDefault: false, domains: 0, webDefault: true })).toContain('Apache Configuration');
    expect(removeBlocker({ installed: true, isSystemDefault: false, domains: 0, plans: 1 })).toContain('1 package(s)');
    expect(removeBlocker({ installed: true, isSystemDefault: false, domains: 0, vhosts: 3 })).toContain('3 web vhost(s)');
    expect(removeBlocker({ installed: false, isSystemDefault: false, domains: 0 }, 1)).toBeNull();
    expect(toggleOffered(phpCatalog, '8.2', true)).toEqual(['8.3', '8.2']);
    expect(toggleOffered(phpCatalog, '8.3', false)).toEqual([]);
    expect(toggleOffered({ ...phpCatalog, offered: null }, '8.3', false)).toEqual(['8.2', '7.4']);
  });

  it('PHP Version Manager shows the simulated extra packages of a refused removal and offers "Remove anyway"', () => {
    const refused = new ApiError(422, { error: { code: 'validation_failed', message: 'Removing PHP 8.5 would also remove roundcube-core, phpmyadmin — move webmail and phpMyAdmin to another version first, or force the removal', fields: { version: ['Removing it also removes roundcube-core, phpmyadmin'], extra: ['roundcube-core', 'phpmyadmin'] } } });
    expect(removalExtras(refused)).toEqual(['roundcube-core', 'phpmyadmin']);
    expect(removalExtras(new ApiError(422, { error: { code: 'validation_failed', message: 'PHP 8.5 is the system default', fields: { version: ['Change the system default first'] } } }))).toBeNull();
    expect(removalExtras(new ApiError(422, { error: { fields: { extra: [] } } }))).toBeNull();
    expect(removalExtras(new ApiError(500, { error: { fields: { extra: ['x'] } } }))).toBeNull();
    expect(removalExtras(new Error('network'))).toBeNull();
    const v = { id: '8.5', label: 'PHP 8.5', installed: true, source: false };
    const plain = removeConfirm(v);
    expect(plain).toMatchObject({ title: 'Remove PHP 8.5?', confirmLabel: 'Remove', danger: true });
    expect(plain.message).toContain('Removes every php8.5-* package');
    expect(plain.message).toContain('simulated first');
    expect(removeConfirm({ id: '8.4', label: 'PHP 8.4 (Keel build)', source: true }).message).toContain('keel-php8.4-fpm');
    const anyway = removeConfirm(v, ['roundcube-core', 'phpmyadmin']);
    expect(anyway).toMatchObject({ title: 'Remove PHP 8.5 anyway?', confirmLabel: 'Remove anyway', danger: true });
    const html = renderToStaticMarkup(anyway.message);
    expect(html).toContain('<code style="white-space:nowrap">roundcube-core</code>');
    expect(html).toContain('<code style="white-space:nowrap">phpmyadmin</code>');
    expect(html).toContain('webmail and phpMyAdmin on the server hostname site would stop answering');
    expect(html).toContain('audited as forced');
    expect(renderToStaticMarkup(removeConfirm(v, ['libfoo']).message)).not.toContain('hostname site');
  });

  // The live host's case: the distribution's 8.5 (8.5.4) carries an advisory no
  // package fixes while php.net's 8.5 is newer, a build of 8.4 is at php.net's
  // latest, and an 8.3 Keel build shadows its packages.
  it('PHP Version Manager: a resync-only candidate (build: false) that still carries an advisory reads "Move domains to the Keel build", never "Security update", and agrees with its confirm', () => {
    const stamp = { checkedAt: '2026-11-06T06:00:00.000Z', packagesCheckedAt: '2026-11-06T05:41:00.000Z', releasesCheckedAt: '2026-11-06T05:50:00.000Z' };
    const row = { installed: true, id: '8.3', label: 'PHP 8.3 (Keel build)', version: '8.3.30', layout: 'keel', source: true, method: 'source', prefix: '/opt/keel/php/8.3', packagedTwin: { binary: '/usr/bin/php8.3', version: '8.3.6', packagePrefix: 'php8.3-', fpmUnit: 'php8.3-fpm' }, advisories: [{ id: 'CVE-2026-1', title: 'x', grade: 'critical', fixedIn: null }], update: { candidate: '8.3.30', severity: 'security', reasons: ['CVE-2026-1: x', 'the Keel build 8.3.30 shadows the distribution packages 8.3.6; the domains on PHP 8.3 are re-rendered onto it'], current: '8.3.30', source: 'release', method: 'source', build: false, checkedAt: stamp.releasesCheckedAt } };
    const html = renderToStaticMarkup(h(PhpUpdateCell, { row, stamp, checking: false, busy: false, onUpdate: () => {} }));
    expect(html).toContain('Move domains to the Keel build <strong>8.3.30</strong>');
    expect(html).not.toContain('Security update');
    expect(html).not.toContain('from php.net');
    expect(html).toMatch(/<button type="button" class="btn btn-primary btn-sm[^"]*"[^>]*>Update<\/button>/);
    expect(html).not.toContain('btn-danger');
    expect(updateState(row, stamp)).toMatchObject({ kind: 'security', candidate: '8.3.30', method: 'source', build: false });
    expect(phpUpdateMessage(row)).toMatch(/nothing is rebuilt/);
    // The same row with a real rebuild keeps the security wording.
    const rebuild = renderToStaticMarkup(h(PhpUpdateCell, { row: { ...row, update: { ...row.update, candidate: '8.3.31', build: true } }, stamp, checking: false, busy: false, onUpdate: () => {} }));
    expect(rebuild).toContain('>Security update</span><span>8.3.31 from php.net</span>');
    expect(rebuild).toContain('btn-danger');
  });

  it('PHP Version Manager: a packaged version with an advisory no package fixes gets "Security update · x.y.z from php.net"; the badge and the Updates column never contradict', () => {
    fixtures.responses.clear();
    fixtures.posts.length = 0;
    const row = (o) => ({ installed: true, state: 'installed', version: null, binary: null, iniPath: null, fpmInstalled: true, fpmActive: true, fpmUnit: null, isDefault: false, isSystemDefault: false, offered: true, domains: 0, packages: [], repo: 'php', repoStatus: null, advisories: [], note: null, method: 'package', ...o });
    const cve = { id: 'CVE-2026-109619', title: 'PHP2Shell', grade: 'critical', fixedIn: '8.5.12' };
    const stamp = { checkedAt: '2026-11-06T06:00:00.000Z', packagesCheckedAt: '2026-11-06T05:41:00.000Z', releasesCheckedAt: '2026-11-06T05:50:00.000Z' };
    const phpCatalog = {
      family: 'debian', os: { id: 'ubuntu', versionId: '26.04' }, effectiveDefault: '8.5', configuredDefault: '8.5', offered: null, updates: stamp,
      versions: [
        row({ id: '8.5', label: 'PHP 8.5', version: '8.5.4', binary: '/usr/bin/php8.5', fpmUnit: 'php8.5-fpm', isDefault: true, isSystemDefault: true, domains: 2, layout: 'debian', advisories: [cve], update: { candidate: '8.5.12', severity: 'critical', reasons: ['CVE-2026-109619: PHP2Shell (fixed in 8.5.12)', 'php.net released 8.5.12; no distribution package carries a fix, so it is built from source'], current: '8.5.4', source: 'release', method: 'source', build: true, checkedAt: stamp.releasesCheckedAt } }),
        row({ id: '8.4', label: 'PHP 8.4 (Keel build)', version: '8.4.27', binary: '/opt/keel/php/8.4/bin/php', fpmUnit: 'keel-php8.4-fpm', method: 'source', source: true, layout: 'keel', prefix: '/opt/keel/php/8.4', update: null }),
        row({ id: '8.3', label: 'PHP 8.3 (Keel build)', version: '8.3.30', binary: '/opt/keel/php/8.3/bin/php', fpmUnit: 'keel-php8.3-fpm', method: 'source', source: true, layout: 'keel', prefix: '/opt/keel/php/8.3', packagePrefix: 'php8.3-', packagedTwin: { binary: '/usr/bin/php8.3', version: '8.3.6', packagePrefix: 'php8.3-', fpmUnit: 'php8.3-fpm' }, note: 'Distribution packages 8.3.6 remain installed and unused; Remove packages drops them without touching the Keel build.', update: { candidate: '8.3.30', severity: 'update', reasons: ['the Keel build 8.3.30 shadows the distribution packages 8.3.6; the domains on PHP 8.3 are re-rendered onto it'], current: '8.3.30', source: 'release', method: 'source', build: false, checkedAt: stamp.releasesCheckedAt } }),
        row({ id: '8.2', label: 'PHP 8.2', version: '8.2.20', binary: '/usr/bin/php8.2', fpmUnit: 'php8.2-fpm', layout: 'debian', advisories: [{ ...cve, fixedIn: '8.2.35' }], update: { candidate: null, severity: 'critical', reasons: ['CVE-2026-109619: PHP2Shell (fixed in 8.2.35)'], current: '8.2.20', source: null, method: null, build: null, checkedAt: stamp.checkedAt } }),
      ],
    };
    set('/software/php/versions', { data: { versions: phpCatalog.versions, effectiveDefault: '8.5' } });
    set('/software/php/catalog', { data: phpCatalog });
    set('/software/php/domains', { data: { domains: [], systemDefault: { effective: '8.5' } }, meta: { total: 0 } });
    set('/software/php/pools', { data: { pools: [] } });
    const html = render(h(MultiPhpManager, { fn: FUNCTION_BY_KEY['software/multiphp-manager'] }), '/software/multiphp-manager');
    // 8.5: the advisory badge says "update to 8.5.12" and the Updates column offers exactly that, from php.net, in red.
    expect(html).toContain('CVE-2026-109619 · update to 8.5.12');
    expect(html).toContain('>Security update</span><span>8.5.12 from php.net</span>');
    expect(html).toMatch(/<button type="button" class="btn btn-danger btn-sm[^"]*" title="CVE-2026-109619: PHP2Shell \(fixed in 8\.5\.12\)\nphp\.net released 8\.5\.12; no distribution package carries a fix, so it is built from source">Update<\/button>/);
    expect(html).not.toContain('Up to date · 8.5.4');
    // 8.4: a Keel build at php.net's latest is up to date.
    expect(html).toContain('Up to date · 8.4.27');
    // 8.3: a build shadowing packages that was never resynced offers the resync, the row notes the packages and offers Remove packages.
    expect(html).toContain('Move domains to the Keel build <strong>8.3.30</strong>');
    expect(html).toContain('Distribution packages 8.3.6 remain installed and unused (<code class="small">/usr/bin/php8.3</code>).');
    expect(html).toMatch(/<button type="button" class="btn btn-danger btn-sm[^"]*" title="Removes the php8\.3-\* packages; the Keel build stays">Remove packages<\/button>/);
    expect((html.match(/>Remove packages<\/button>/g) || []).length).toBe(1);
    // 8.2: an advisory with nothing newer anywhere is the only row that says "no fix".
    expect(html).toContain('>Advisory</span> <span class="muted small">no fix available yet</span>');
    expect((html.match(/no fix available yet/g) || []).length).toBe(1);
    expect((html.match(/>Update<\/button>/g) || []).length).toBe(2);
    // Each row with an advisory badge carries either an Update or "no fix"; never "Up to date".
    expect(html).not.toMatch(/update to 8\.5\.12[\s\S]{0,1500}Up to date · 8\.5\.4/);
    expect(html).toContain('A packaged version hit by an advisory that no distribution package fixes is updated <em>from php.net</em>');
    // The states as data.
    expect(updateState(phpCatalog.versions[0], stamp)).toMatchObject({ kind: 'security', candidate: '8.5.12', method: 'source', build: true, checkedAt: stamp.releasesCheckedAt });
    expect(updateState(phpCatalog.versions[1], stamp)).toMatchObject({ kind: 'latest', candidate: null });
    expect(updateState(phpCatalog.versions[2], stamp)).toMatchObject({ kind: 'update', candidate: '8.3.30', method: 'source', build: false });
    expect(updateState(phpCatalog.versions[3], stamp)).toMatchObject({ kind: 'nofix', candidate: null, method: null });
    // A release-sourced update on a Keel row without `method` still reads as a source build.
    expect(updateState({ installed: true, source: true, update: { candidate: '8.4.28', severity: 'update', source: 'release' } }, stamp)).toMatchObject({ kind: 'update', method: 'source' });
    expect(phpUpdateDanger({ severity: 'security' })).toBe(true);
    expect(phpUpdateDanger({ severity: 'update' })).toBe(false);
    // Confirm copy: the source build replaces the packaged version for every domain on the minor, takes ~15 minutes, and the packages stay.
    const build = phpUpdateMessage(phpCatalog.versions[0]);
    expect(build).toMatch(/^Builds PHP 8\.5 from the official php\.net 8\.5\.12 source into \/opt\/keel\/php\/8\.5 \(about 15 minutes\) with its own keel-php8\.5-fpm service, then replaces the packaged version for every domain on PHP 8\.5 \(and the hostname site when it runs on it\)/);
    expect(build).toContain('The distribution packages 8.5.4 stay installed and unused; Remove packages drops them afterwards.');
    expect(build).toContain('CVE-2026-109619: PHP2Shell (fixed in 8.5.12)');
    const resync = phpUpdateMessage(phpCatalog.versions[2]);
    expect(resync).toMatch(/^Re-renders every domain on PHP 8\.3 \(and the hostname site when it runs on it\) onto the Keel build 8\.3\.30 under \/opt\/keel\/php\/8\.3; nothing is rebuilt\. The distribution packages 8\.3\.6 stay installed and unused; Remove packages drops them later\./);
    expect(phpUpdateBody(phpCatalog.versions[0])).toEqual({ version: '8.5' });
    // Remove packages: the body names the minor with packages: true; the confirm says the build keeps serving the minor.
    expect(phpRemovePackagesBody(phpCatalog.versions[2])).toEqual({ version: '8.3', packages: true });
    expect(phpRemovePackagesBody(phpCatalog.versions[2], true)).toEqual({ version: '8.3', packages: true, force: true });
    const rm = removeConfirm(phpCatalog.versions[2], null, { packages: true });
    expect(rm.title).toBe('Remove the PHP 8.3 distribution packages?');
    expect(rm.message).toContain('Removes every php8.3-* package (8.3.6); the Keel build under /opt/keel/php/8.3 keeps serving PHP 8.3, so no domain moves.');
    expect(rm.message).toContain('while the hostname site still runs on the packages\' socket');
    expect(removeConfirm(phpCatalog.versions[2], ['roundcube-core'], { packages: true })).toMatchObject({ title: 'Remove the PHP 8.3 distribution packages anyway?', confirmLabel: 'Remove anyway', danger: true });
    // Removing the build itself with packages beside it says the packages take over again.
    expect(removeConfirm(phpCatalog.versions[2]).message).toContain('The distribution packages 8.3.6 stay installed and become the PHP 8.3 of this server again.');
    expect(removeConfirm(phpCatalog.versions[1]).message).not.toContain('become the PHP');
    // Install Software's PHP card renders the same states from the runtime catalog.
    set('/software/pkg/detect', { data: detect });
    set('/software/pkg/recent', { data: [] });
    set('/software/runtimes/recent', { data: [] });
    const rows = phpCatalog.versions.map((v) => ({ id: v.id, label: v.label, installed: true, version: v.version, packages: [], repo: 'php', note: v.note, method: v.method, source: v.source, layout: v.layout, state: 'installed', update: v.update, packagedTwin: v.packagedTwin }));
    set('/software/runtimes', { data: { ...catalog, runtimes: [{ key: 'php', label: 'PHP', single: false, versions: rows }, ...catalog.runtimes.slice(1)], updates: stamp } });
    const card = render(h(InstallSoftware, { fn }));
    expect(card).toContain('>Security update</span><span>8.5.12 from php.net</span>');
    expect(card).toContain('Move domains to the Keel build <strong>8.3.30</strong>');
    expect(card).toContain('no fix available yet');
    expect(card).toContain('Up to date · 8.4.27');
    expect(card).toContain('Distribution packages 8.3.6 remain installed and unused');
  });

  it('picks packages by host family for statistics generators and quota tools', () => {
    expect(generatorPackages({ apt: ['awstats'], dnf: ['awstats-rhel'] }, 'rhel')).toEqual(['awstats-rhel']);
    expect(generatorPackages({ apt: ['awstats'], dnf: ['awstats-rhel'] }, null)).toEqual([]);
    expect(generatorPackages({ apt: ['awstats'], dnf: ['awstats'] }, 'debian')).toEqual(['awstats']);
    expect(generatorPackages({ apt: ['awstats'] }, 'rhel')).toEqual(['awstats']);
    expect(generatorPackages(null, 'debian')).toEqual([]);
    expect(quotaPackages({ packages: ['quota'] })).toEqual(['quota']);
    expect(quotaPackages({ installPackages: ['quota'] })).toEqual(['quota']);
    expect(quotaPackages({})).toEqual([]);
  });
});
