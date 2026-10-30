import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';

const auth = { user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {}, ready: true };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

// Pages read through useApi; canned answers per path prefix make each render
// one server state (errors included, so the 501 path renders too).
const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!enabled || !path) return { data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
    const hit = [...responses.entries()].find(([k]) => path.startsWith(k));
    const r = hit ? hit[1] : null;
    return { data: r?.data ?? null, meta: r?.meta ?? null, error: r?.error ?? null, loading: !r, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { default: MultiPhpManager, PhpInstallCard, phpRowAction } = await import('../src/pages/fn/software/multiphp-manager.jsx');
const { default: MultiPhpIniEditor } = await import('../src/pages/fn/software/multiphp-ini-editor.jsx');
const { InstallerCard, MODULE_TOOL_PACKAGES } = await import('../src/pages/software/Shared.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

const SOURCE = { key: 'ondrej', label: 'Ondřej Surý PPA (ppa:ondrej/php)', url: 'https://launchpad.net/~ondrej/+archive/ubuntu/php', flavor: 'ubuntu', codename: 'noble', major: null, supported: true, reason: null, configured: false };
const row = (version, extra = {}) => ({ version, id: version, label: `PHP ${version}`, offered: false, installed: false, installedVersion: null, candidate: null, source: null, fpmUnit: `php${version}-fpm`, layout: null, stock: false, isDefault: false, isCliDefault: false, inUse: 0, advisories: [], removable: false, ...extra });
const INSTALLABLE = {
  manager: 'apt', family: 'debian', os: { id: 'ubuntu', name: 'Ubuntu 24.04.1 LTS', versionId: '24.04', codename: 'noble' }, source: SOURCE, stock: '8.3', effectiveDefault: '8.3',
  versions: [
    row('7.4'), row('8.0'),
    row('8.1', { offered: true, candidate: '8.1.31-1', source: 'ondrej' }),
    row('8.2', { offered: true, installed: true, installedVersion: '8.2.20', source: 'ondrej', layout: 'debian', inUse: 2 }),
    row('8.3', { offered: true, installed: true, installedVersion: '8.3.6', source: 'distro', layout: 'debian', stock: true, isDefault: true, isCliDefault: true }),
    row('8.4', { offered: true, installed: true, installedVersion: '8.4.1', source: 'ondrej', layout: 'debian', removable: true }),
    row('8.5'),
  ],
  recent: [{ id: 41, type: 'software.php.install', status: 'done', created_at: '2026-10-30T10:00:00Z', result: { version: '8.4', packages: ['php8.4-fpm'] } }],
};
const VERSIONS = { versions: [{ id: '8.3', label: 'PHP 8.3', version: '8.3.6', binary: '/usr/bin/php8.3', iniPath: '/etc/php/8.3/fpm/php.ini', fpmUnit: 'php8.3-fpm', fpmInstalled: true, fpmActive: true, isDefault: true, advisories: [] }], defaultId: '8.3', effectiveDefault: '8.3', configuredDefault: '8.3' };

describe('PhpInstallCard', () => {
  it('offers Install for available and source-enabling branches, Remove only for spare installed ones, with reasons', () => {
    responses.clear();
    responses.set('/software/php/installable', { data: INSTALLABLE });
    const html = render(<PhpInstallCard />);
    expect(html).toContain('Install a PHP version');
    expect(html).toContain('Ondřej Surý PPA (ppa:ondrej/php) · not enabled yet');
    expect(html).toContain('Ubuntu 24.04.1 LTS (noble) · apt · the distribution&#x27;s own branch is PHP 8.3');
    expect(html).toContain('href="https://launchpad.net/~ondrej/+archive/ubuntu/php"');
    expect(html).toContain('enabled automatically on the first install');
    for (const v of ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5']) expect(html).toContain(`PHP ${v}`);
    expect(html).toContain('available · 8.1.31-1');
    expect(html).toContain('installed · 8.2.20');
    expect(html).toContain('system default');
    expect(html).toContain('distribution');
    expect(html).toContain('used by 2 domains');
    // 8.3 is both defaults: the row says "system default" once, never a second CLI pill.
    expect(html).not.toContain('>CLI<');
    expect(html).toContain('enables Ondřej Surý PPA (ppa:ondrej/php) first');
    expect(html).toContain('not offered');
    expect(html).toContain('Previous PHP installs and removals');
    expect(html).toContain('software.php.install');
    const buttons = html.match(/<button[^>]*>(Install|Remove)<\/button>/g) || [];
    expect(buttons).toHaveLength(7);
    const enabled = buttons.filter((b) => !b.includes('disabled'));
    // 7.4 / 8.0 / 8.5: the PPA is not enabled yet, so Install can still try (it enables the source); 8.1 available; 8.4 spare.
    expect(enabled.filter((b) => b.includes('>Install<'))).toHaveLength(4);
    expect(enabled.filter((b) => b.includes('>Remove<'))).toHaveLength(1);
    expect(buttons.filter((b) => b.includes('disabled') && b.includes('>Remove<'))).toHaveLength(2);
  });

  it('disables Install for branches the enabled source does not carry and explains the row', () => {
    const configured = { ...INSTALLABLE, source: { ...SOURCE, configured: true } };
    expect(phpRowAction(configured.versions[0], configured.source)).toEqual({ kind: 'install', disabled: true, reason: 'not offered by Ondřej Surý PPA (ppa:ondrej/php)' });
    expect(phpRowAction(configured.versions[2], configured.source)).toEqual({ kind: 'install', disabled: false, reason: null });
    expect(phpRowAction(INSTALLABLE.versions[0], SOURCE)).toEqual({ kind: 'install', disabled: false, reason: 'enables Ondřej Surý PPA (ppa:ondrej/php) first' });
    expect(phpRowAction(INSTALLABLE.versions[0], { ...SOURCE, supported: false, configured: false, reason: 'the Debian release codename could not be read' })).toEqual({ kind: 'install', disabled: true, reason: 'the Debian release codename could not be read' });
    expect(phpRowAction(INSTALLABLE.versions[3], SOURCE)).toEqual({ kind: 'remove', disabled: true, reason: 'used by 2 domains' });
    expect(phpRowAction(INSTALLABLE.versions[4], SOURCE)).toEqual({ kind: 'remove', disabled: true, reason: 'system default' });
    expect(phpRowAction({ ...INSTALLABLE.versions[4], isDefault: false }, SOURCE)).toEqual({ kind: 'remove', disabled: true, reason: 'CLI default (/usr/bin/php)' });
    expect(phpRowAction(INSTALLABLE.versions[5], SOURCE)).toEqual({ kind: 'remove', disabled: false, reason: null });
    expect(phpRowAction(row('7.4', { installed: true, id: 'ea-php74', layout: 'ea4' }), SOURCE)).toEqual({ kind: 'remove', disabled: true, reason: 'not a versioned package set' });
    responses.clear();
    responses.set('/software/php/installable', { data: configured });
    const html = render(<PhpInstallCard />);
    expect(html).toContain('ppa:ondrej/php) · enabled');
    expect(html).toContain('not offered by Ondřej Surý PPA');
    expect(html).not.toContain('enabled automatically');
  });

  it('shows the capability prompt when the host has no package manager and a loading line before the answer', () => {
    responses.clear();
    responses.set('/software/php/installable', { error: { status: 501, code: 'capability_missing', capability: 'pkg', message: 'No supported package manager (apt-get, dnf or yum) was found on this server' } });
    const html = render(<PhpInstallCard />);
    expect(html).toContain('Service not installed');
    expect(html).toContain('No supported package manager');
    expect(html).not.toContain('<table');
    responses.clear();
    expect(render(<PhpInstallCard />)).toContain('Asking the package manager which PHP versions it offers');
  });
});

describe('MultiPHP Manager page', () => {
  it('renders the install card for root even when no PHP is installed yet (501 from the versions list)', () => {
    responses.clear();
    responses.set('/software/php/versions', { error: { status: 501, code: 'capability_missing', capability: 'php', message: 'PHP is not installed on this server' } });
    responses.set('/software/php/domains', { data: { systemDefault: { effective: null }, domains: [] }, meta: { total: 0 } });
    responses.set('/software/php/pools', { data: { pools: [] } });
    responses.set('/software/php/installable', { data: { ...INSTALLABLE, effectiveDefault: null, versions: INSTALLABLE.versions.map((v) => row(v.version, { offered: v.offered })) } });
    const html = render(<MultiPhpManager fn={FUNCTION_BY_KEY['software/multiphp-manager']} />);
    expect(html).toContain('PHP is not installed on this server');
    expect(html).toContain('Install PHP');
    expect(html).toContain('Install a PHP version');
    expect((html.match(/>Install<\/button>/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain('>Remove<');
  });

  it('points the empty installed-versions table at the card and keeps the card out of a reseller view', () => {
    responses.clear();
    responses.set('/software/php/versions', { data: { ...VERSIONS, versions: [] } });
    responses.set('/software/php/domains', { data: { systemDefault: { effective: null }, domains: [] }, meta: { total: 0 } });
    responses.set('/software/php/pools', { data: { pools: [] } });
    responses.set('/software/php/installable', { data: INSTALLABLE });
    const html = render(<MultiPhpManager fn={FUNCTION_BY_KEY['software/multiphp-manager']} />);
    expect(html).toContain('Install a version with the card below');
    expect(html).toContain('Install a PHP version');
    auth.user = { id: 2, username: 'resell1', role: 'reseller' };
    try {
      const reseller = render(<MultiPhpManager fn={FUNCTION_BY_KEY['software/multiphp-manager']} />);
      expect(reseller).not.toContain('Install a PHP version');
      expect(reseller).not.toContain('>Install<');
    } finally { auth.user = { id: 1, username: 'root', role: 'root' }; }
  });
});

describe('MultiPHP INI Editor', () => {
  it('offers re-detection and the way to the installer when no version is installed', () => {
    responses.clear();
    responses.set('/software/php/versions', { data: { ...VERSIONS, versions: [] } });
    responses.set('/software/php/domains', { data: { systemDefault: { effective: null }, domains: [] }, meta: { total: 0 } });
    responses.set('/software/php/ini/directives', { data: [] });
    const html = render(<MultiPhpIniEditor fn={FUNCTION_BY_KEY['software/multiphp-ini-editor']} />);
    expect(html).toContain('No PHP version is installed yet.');
    expect(html).toContain('Re-detect versions');
    expect(html).toContain('href="/software/multiphp-manager"');
    expect(html).toContain('Install a PHP version');
  });
});

describe('InstallerCard install path', () => {
  const runner = { jobId: null, busy: false, error: null, start: async () => null, setJobId() {}, finished() {} };
  it('offers to install the missing tool packages for the host family', () => {
    responses.clear();
    responses.set('/software/pkg/detect', { data: { manager: 'apt', family: 'debian', capability: true } });
    const html = render(<InstallerCard title="PHP PECL extensions" kind="pecl" listPath="/software/modules/pecl" installPath="/software/modules/pecl/install" present={false} runner={runner} disabledReason="pecl is not installed." />);
    expect(html).toContain('pecl is not installed.');
    expect(html).toContain('Install php-pear + php-dev');
    expect(html).toContain('background job');
    expect(MODULE_TOOL_PACKAGES.pecl.rhel).toEqual(['php-pear', 'php-devel']);
    expect(MODULE_TOOL_PACKAGES.pip.debian).toEqual(['python3-pip']);
    responses.set('/software/pkg/detect', { data: { manager: 'dnf', family: 'rhel', capability: true } });
    expect(render(<InstallerCard title="Ruby gems" kind="gem" listPath="/software/modules/gem" installPath="/software/modules/gem/install" present={false} runner={runner} />)).toContain('Install ruby');
    expect(render(<InstallerCard title="pip" kind="pip" listPath="/software/modules/pip" installPath="/software/modules/pip/install" present={false} runner={runner} installPackages={['python3-pip', 'python3-venv']} />)).toContain('Install python3-pip + python3-venv');
  });

  it('explains when there is no package manager and shows no button, and stays unchanged when the tool is present', () => {
    responses.clear();
    responses.set('/software/pkg/detect', { data: { manager: null, family: null, capability: false } });
    const html = render(<InstallerCard title="PHP PEAR packages" kind="pear" listPath="/software/modules/pear" installPath="/software/modules/pear/install" present={false} runner={runner} disabledReason="pear is not installed." />);
    expect(html).toContain('No supported package manager');
    expect(html).not.toContain('>Install php-pear');
    responses.set('/software/modules/pear', { data: { kind: 'pear', items: [{ name: 'Mail', version: '1.6.2' }] } });
    const present = render(<InstallerCard title="PHP PEAR packages" kind="pear" listPath="/software/modules/pear" installPath="/software/modules/pear/install" present runner={runner} />);
    expect(present).toContain('Install with pear');
    expect(present).toContain('Mail');
    expect(present).not.toContain('Install php-pear');
  });
});
