import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { PluginNavContext } from '../src/hooks/usePluginNav.js';
import { FUNCTION_BY_KEY } from '../src/nav.js';

const authState = { user: { id: 1, username: 'root', role: 'root' } };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: authState.user, refresh: async () => {} }) }));

// Pages read through useApi; the mock answers by path so each render is a
// deterministic snapshot of one server state.
const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!enabled || !path) return { data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
    const hit = [...responses.entries()].find(([k]) => (k instanceof RegExp ? k.test(path) : path.startsWith(k)));
    const r = hit ? hit[1] : null;
    return { data: r?.data ?? null, meta: r?.meta ?? null, error: r?.error ?? null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { MarketplaceTab, MarketplaceDisabledNotice, HubMismatchNotice, MarketplaceUpdatesNotice, PluginDetailDrawer, priceLabel, safeHref } = await import('../src/pages/cpanel/MarketplaceTab.jsx');
const { HomePage } = await import('../src/pages/Home.jsx');
const { ConsentModal, PermissionList, TrustNotice } = await import('../src/pages/cpanel/ConsentModal.jsx');
const { RevocationBanner, describeRevocation } = await import('../src/components/RevocationBanner.jsx');
const ManagePlugins = (await import('../src/pages/fn/cpanel/manage-plugins.jsx')).default;
const { TABS, sourceLabel, DeveloperMode } = await import('../src/pages/fn/cpanel/manage-plugins.jsx');
const WhmMarketplace = (await import('../src/pages/fn/server-configuration/whm-marketplace.jsx')).default;
const MarketProviderManager = (await import('../src/pages/fn/market/market-provider-manager.jsx')).default;

React.useLayoutEffect = React.useEffect;
const nav = { plugins: [], entries: [], loading: false, error: null, reload() {} };
const render = (el, { initialEntries } = {}) => renderToStaticMarkup(
  <PluginNavContext.Provider value={nav}>
    <ToastProvider><ConfirmProvider><MemoryRouter initialEntries={initialEntries}>{el}</MemoryRouter></ConfirmProvider></ToastProvider>
  </PluginNavContext.Provider>,
);

const enabledStatus = { enabled: true, url: 'https://hub.test/', hubUrl: 'https://hub.test', hubMismatch: false, licenseStatus: 'active', licenseDegraded: false, hasToken: true, hubKids: ['bdee6a71', '742aaf57'], pendingUpdates: [], unacknowledgedRevocations: 0, developerMode: false };
const catalog = [
  { id: 'net.example.minimal', name: 'Minimal', summary: 'Smallest valid plugin.', developer: { display_name: 'Example Dev', verified: true }, category: { slug: 'developer-tools', name: 'Developer tools' }, pricing: { model: 'free' }, latest: { version: '1.0.0', engines_whm: '>=1.0.0' }, install_count: 12, rating_avg: 4.5, rating_count: 2, installed: null },
  { id: 'net.example.scoped', name: 'Scoped', summary: 'Reads accounts.', developer: { display_name: 'Example Dev', verified: true }, category: { slug: 'security', name: 'Security' }, pricing: { model: 'one_time', amount_cents: 4900, currency: 'USD' }, latest: { version: '1.0.1' }, install_count: 3, rating_avg: null, rating_count: 0, installed: { version: '1.0.0', state: 'enabled', source: 'marketplace', marketplace: true, consentState: 'consented', update: { id: 'net.example.scoped', current: '1.0.0', latest: '1.0.1' } } },
  { id: 'net.whm.server-monitoring', name: 'Server Monitoring', summary: 'Bundled.', developer: { display_name: 'WHM', verified: true }, category: null, pricing: { model: 'free' }, latest: { version: '1.0.0' }, install_count: 0, rating_count: 0, installed: { version: '1.0.0', state: 'enabled', source: 'bundled', marketplace: false, consentState: null, update: null } },
];
const detail = {
  ...catalog[1], description_md: 'Builds a **report** of every account.', homepage: 'https://example.net/scoped', support_url: null,
  permissions: [{ scope: 'accounts:read', description: 'Read hosting accounts', justification: 'The report lists every account.' }, { scope: 'store:own', description: 'Own store', justification: null }],
  compatibility: { engines_whm: '>=1.0.0', host: '1.0.0', compatible: true },
  versions: { stable: { version: '1.0.1' }, beta: null, all: [{ version: '1.0.1', channel: 'stable', published_at: '2026-10-21T10:00:00Z', engines_whm: '>=1.0.0', package_sha256: 'ab', package_bytes: 2048, kid: 'bdee6a71' }, { version: '1.0.0', channel: 'stable', published_at: '2026-10-20T10:00:00Z', engines_whm: '>=1.0.0', package_sha256: 'cd', package_bytes: 1024, kid: 'bdee6a71' }] },
  changelog: [{ version: '1.0.1', channel: 'stable', changelog_md: 'Adds notifications.' }],
  reviews: [{ id: 'rev_1', rating: 5, title: 'Works', body: 'Does what it says.', created_at: '2026-10-22T00:00:00Z' }],
};

describe('Marketplace tab', () => {
  it('tells root to enable the whm-hub provider while the row is off, and never shows the catalog', () => {
    responses.clear();
    responses.set('/marketplace/status', { data: { ...enabledStatus, enabled: false } });
    responses.set('/marketplace/catalog', { data: catalog });
    const html = render(<MarketplaceTab manage />);
    expect(html).toContain('data-testid="marketplace-disabled"');
    expect(html).toContain('Market Provider Manager');
    expect(html).toContain('Basic Setup → License');
    expect(html).not.toContain('catalog-net.example.minimal');
    expect(render(<MarketplaceDisabledNotice />)).toContain('/market/market-provider-manager');
  });

  it('shows the hub_mismatch notice with both origins and no catalog', () => {
    responses.clear();
    responses.set('/marketplace/status', { data: { ...enabledStatus, url: 'https://other.test/', hubMismatch: true } });
    responses.set('/marketplace/catalog', { data: catalog });
    const html = render(<MarketplaceTab manage />);
    expect(html).toContain('data-testid="hub-mismatch"');
    expect(html).toContain('https://other.test/');
    expect(html).toContain('https://hub.test');
    expect(html).not.toContain('catalog-net.example.minimal');
    expect(render(<HubMismatchNotice status={{ url: 'https://a.test', hubUrl: 'https://b.test' }} />)).toContain('Hub mismatch');
  });

  it('renders the catalog grid with install/update/uninstall for root and read-only for resellers', () => {
    responses.clear();
    responses.set('/marketplace/status', { data: { ...enabledStatus, pendingUpdates: [{ id: 'net.example.scoped', current: '1.0.0', latest: '1.0.1', security: true }] } });
    responses.set('/marketplace/categories', { data: [{ slug: 'security', name: 'Security', count: 1 }] });
    responses.set('/marketplace/catalog', { data: catalog, meta: { page: 1, pageSize: 24, total: 3 } });
    const root = render(<MarketplaceTab manage />);
    expect(root).toContain('catalog-net.example.minimal');
    expect(root).toContain('Install');
    expect(root).toContain('Update to 1.0.1');
    expect(root).toContain('Uninstall');
    expect(root).toContain('Bundled');
    expect(root).toContain('49.00 USD');
    expect(root).toContain('Free');
    expect(root).toContain('Security (1)');
    expect(root).toContain('data-testid="pending-updates"');
    expect(root).toContain('security');
    expect(root).toContain('Check for updates');
    expect(root).toContain('2 signing keys pinned');
    // Resellers get the trimmed status (no hubKids / pendingUpdates) and `installed: { state }` only.
    const { hasToken, hubKids, pendingUpdates, unacknowledgedRevocations, developerMode, ...trimmed } = enabledStatus;
    responses.set('/marketplace/status', { data: trimmed });
    responses.set('/marketplace/catalog', { data: catalog.map((e) => ({ ...e, installed: e.installed ? { state: e.installed.state } : null })), meta: { page: 1, pageSize: 24, total: 3 } });
    const reseller = render(<MarketplaceTab manage={false} />);
    expect(reseller).toContain('catalog-net.example.minimal');
    expect(reseller).not.toContain('signing key');
    expect(reseller).not.toContain('undefined');
    expect(reseller).toContain('>enabled<');
    expect(reseller).toContain('Details');
    expect(reseller).not.toContain('>Install<');
    expect(reseller).not.toContain('Update to 1.0.1');
    expect(reseller).not.toContain('Uninstall');
    expect(reseller).not.toContain('Check for updates');
    expect(reseller).not.toContain('data-testid="pending-updates"');
  });

  it('warns about a degraded license while browsing keeps working', () => {
    responses.clear();
    responses.set('/marketplace/status', { data: { ...enabledStatus, licenseStatus: 'degraded', licenseDegraded: true } });
    responses.set('/marketplace/catalog', { data: catalog });
    const html = render(<MarketplaceTab manage />);
    expect(html).toContain('License degraded');
    expect(html).toContain('catalog-net.example.minimal');
  });

  it('renders the detail drawer with permissions, justifications, versions, changelog and reviews', () => {
    responses.clear();
    responses.set('/marketplace/plugins/net.example.scoped', { data: detail });
    const html = render(<PluginDetailDrawer id="net.example.scoped" manage onClose={() => {}} onInstall={() => {}} onUpdate={() => {}} onUninstall={() => {}} />);
    expect(html).toContain('accounts:read');
    expect(html).toContain('Read hosting accounts (ctx.api.accounts.list / get)');
    expect(html).toContain('The report lists every account.');
    expect(html).toContain('<strong>report</strong>');
    expect(html).toContain('1.0.1');
    expect(html).toContain('bdee6a71');
    expect(html).toContain('Adds notifications.');
    expect(html).toContain('Does what it says.');
    expect(html).toContain('Update to 1.0.1');
    expect(html).toContain('Uninstall and purge');
    expect(html).toContain('Submit review');
    expect(html).toContain('requires WHM &gt;=1.0.0 — compatible');
    const readOnly = render(<PluginDetailDrawer id="net.example.scoped" manage={false} onClose={() => {}} />);
    expect(readOnly).not.toContain('Submit review');
    expect(readOnly).not.toContain('Uninstall and purge');
    expect(priceLabel({ model: 'subscription', amount_cents: 500, currency: 'EUR', interval: 'month' })).toBe('5.00 EUR / month');
    expect(priceLabel(null)).toBe('Free');
    responses.set('/marketplace/plugins/net.example.scoped', { data: { ...detail, homepage: 'javascript:alert(1)', support_url: 'https://example.net/help', installed: { state: 'enabled' } } });
    const unsafe = render(<PluginDetailDrawer id="net.example.scoped" manage={false} onClose={() => {}} />);
    expect(unsafe).not.toContain('href="javascript:');
    expect(unsafe).toContain('javascript:alert(1)');
    expect(unsafe).toContain('href="https://example.net/help"');
    expect(unsafe).toContain('(enabled)');
    expect(unsafe).not.toContain('undefined');
    expect(safeHref('http://example.net')).toBeNull();
    expect(safeHref('https://example.net/x')).toBe('https://example.net/x');
    expect(safeHref('nonsense')).toBeNull();
  });
});

describe('Consent screen', () => {
  it('lists the required scopes with SDK descriptions, developer justifications, the new ones flagged, and the trust notice', () => {
    const html = render(<ConsentModal open pluginId="net.example.scoped" pluginName="Scoped" version="1.0.1" required={['accounts:read', 'contacts:notify', 'store:own']} added={['contacts:notify']} justifications={{ 'accounts:read': 'The report lists every account.' }} onClose={() => {}} onConsented={() => {}} />);
    expect(html).toContain('Scoped 1.0.1: permissions');
    expect(html).toContain('contacts:notify');
    expect(html).toContain('>new<');
    expect(html).toContain('Send notifications through the Contact Manager');
    expect(html).toContain('The report lists every account.');
    expect(html).toContain('held disabled');
    expect(html).toContain('the previous version did not have');
    expect(html).toContain('not a security boundary');
    expect(html).toContain('data-testid="consent-grant"');
    expect(html).toContain('Keep disabled');
    const fresh = render(<ConsentModal open pluginId="net.example.x" required={['agent:op:sys.info']} added={['agent:op:sys.info']} onClose={() => {}} />);
    expect(fresh).toContain('reaches outside the plugin');
    expect(fresh).toContain('until you grant the permissions it declares');
    expect(render(<ConsentModal open={false} pluginId="x" onClose={() => {}} />)).not.toContain('role="dialog"');
    expect(render(<PermissionList scopes={[]} />)).toContain('declares no permissions');
    expect(render(<TrustNotice />)).toContain('Plugins run inside the panel process');
  });
});

describe('Dashboard update notice', () => {
  const pending = [{ id: 'net.example.scoped', current: '1.0.0', latest: '1.0.1', channel: 'stable', security: true, changelogUrl: null }, { id: 'net.example.minimal', current: '1.0.0', latest: '1.1.0', channel: 'stable', security: false, changelogUrl: null }];

  it('tells root about pending marketplace updates on the home dashboard and links to the Marketplace tab', () => {
    responses.clear();
    responses.set('/marketplace/updates', { data: { pending, lastCheckAt: '2026-10-27T04:10:00Z' } });
    const html = render(<MarketplaceUpdatesNotice />);
    expect(html).toContain('data-testid="marketplace-updates-notice"');
    expect(html).toContain('2 marketplace plugin updates available (1 security)');
    expect(html).toContain('net.example.scoped 1.0.0 → 1.0.1');
    expect(html).toContain('href="/cpanel/manage-plugins#marketplace"');
    expect(html).toContain('banner-warning');
    const home = render(<HomePage />);
    expect(home).toContain('data-testid="marketplace-updates-notice"');
    expect(home).toContain('href="/cpanel/manage-plugins#marketplace"');
  });

  it('renders nothing without pending updates or for a reseller', () => {
    responses.clear();
    responses.set('/marketplace/updates', { data: { pending: [], lastCheckAt: null } });
    expect(render(<MarketplaceUpdatesNotice />)).not.toContain('marketplace-updates-notice');
    expect(render(<HomePage />)).not.toContain('marketplace-updates-notice');
    responses.set('/marketplace/updates', { data: { pending, lastCheckAt: null } });
    authState.user = { id: 2, username: 'res', role: 'reseller' };
    expect(render(<MarketplaceUpdatesNotice />)).not.toContain('marketplace-updates-notice');
    expect(render(<HomePage />)).not.toContain('marketplace-updates-notice');
    authState.user = { id: 1, username: 'root', role: 'root' };
  });
});

describe('Revocation banner', () => {
  const rows = [{ id: 'rvk_01', pluginId: 'net.example.scoped', version: null, severity: 'warning', action: 'disable', reason: 'leaks data', ts: 1, appliedTo: [{ id: 'net.example.scoped', version: '1.0.0', source: 'marketplace', signer: 'bdee6a71' }], acknowledgedAt: null }];
  it('shows a red banner per unacknowledged revocation for root with an Acknowledge button', () => {
    responses.clear();
    responses.set('/marketplace/revocations?unacknowledged=true', { data: rows });
    authState.user = { id: 1, username: 'root', role: 'root' };
    const html = render(<RevocationBanner />);
    expect(html).toContain('data-testid="revocation-banner"');
    expect(html).toContain('banner-error');
    expect(html).toContain('Plugin revoked: net.example.scoped');
    expect(html).toContain('leaks data');
    expect(html).toContain('Acknowledge');
    expect(describeRevocation({ ...rows[0], version: '1.0.0', action: 'uninstall', appliedTo: [{ id: 'net.example.scoped', version: '1.0.0', source: 'path' }] })).toBe('net.example.scoped 1.0.0 was revoked by the marketplace (warning) and uninstalled on this server: net.example.scoped 1.0.0 (path). Reason: leaks data.');
  });
  it('renders nothing once acknowledged or for a reseller', () => {
    responses.clear();
    responses.set('/marketplace/revocations?unacknowledged=true', { data: [] });
    expect(render(<RevocationBanner />)).not.toContain('data-testid="revocation-banner"');
    responses.set('/marketplace/revocations?unacknowledged=true', { data: rows });
    authState.user = { id: 2, username: 'res', role: 'reseller' };
    expect(render(<RevocationBanner />)).not.toContain('data-testid="revocation-banner"');
    authState.user = { id: 1, username: 'root', role: 'root' };
  });
});

describe('Manage Plugins and WHM Marketplace integration', () => {
  it('gains a Marketplace tab, the Sideloaded label and the developer-mode switch', () => {
    responses.clear();
    responses.set('/plugins/manage', { data: [
      { id: 'net.example.side', name: 'Side', version: '1.0.0', state: 'installed', permissions: [], signed: false, source: 'upload', installedAt: '2026-10-27T00:00:00Z' },
      { id: 'net.example.mkt', name: 'Mkt', version: '1.0.0', state: 'enabled', permissions: ['store:own'], signed: true, signer: 'bdee6a71', source: 'marketplace', installedAt: '2026-10-27T00:00:00Z' },
    ] });
    responses.set('/system/settings?prefix=plugins.', { data: { 'plugins.require_signature': true, 'plugins.developer_mode': true } });
    responses.set('/marketplace/status', { data: enabledStatus });
    responses.set('/marketplace/catalog', { data: catalog });
    const fn = FUNCTION_BY_KEY['cpanel/manage-plugins'];
    expect(TABS.map((t) => t.value)).toEqual(['installed', 'marketplace']);
    const installed = render(<ManagePlugins fn={fn} />, { initialEntries: [fn.path] });
    expect(installed).toContain('Sideloaded');
    expect(installed).toContain('>Marketplace<');
    expect(installed).toContain('Developer mode (sideloading)');
    expect(installed).toContain('Developer mode is on');
    expect(installed).not.toContain('catalog-net.example.minimal');
    const market = render(<ManagePlugins fn={fn} />, { initialEntries: [`${fn.path}#marketplace`] });
    expect(market).toContain('catalog-net.example.minimal');
    expect(market).not.toContain('Install a plugin');
    expect(sourceLabel('path')).toBe('Sideloaded');
    expect(sourceLabel('bundled')).toBe('Bundled');
    expect(sourceLabel('marketplace')).toBe('Marketplace');
    expect(render(<DeveloperMode enabled={false} marketplaceEnabled onChange={() => {}} />)).not.toContain('Developer mode is on');
  });

  it('WHM Marketplace shows the hub catalog with the static catalog under Distribution packages, or the static catalog alone', () => {
    responses.clear();
    responses.set('/marketplace/status', { data: enabledStatus });
    responses.set('/marketplace/catalog', { data: catalog });
    responses.set('/server-config/marketplace', { data: { items: [{ id: 'nginx', name: 'NGINX', vendor: 'nginx.org', category: 'Web', description: 'Web server', price: 'Free', installed: false, installPath: '/software/install-a-perl-module', packagesForHost: ['nginx'] }], total: 1, categories: ['Web'], packageManager: 'apt' } });
    const fn = FUNCTION_BY_KEY['server-configuration/whm-marketplace'];
    const on = render(<WhmMarketplace fn={fn} />);
    expect(on).toContain('catalog-net.example.minimal');
    expect(on).toContain('Distribution packages');
    expect(on).toContain('NGINX');
    authState.user = { id: 2, username: 'res', role: 'reseller' };
    const reseller = render(<WhmMarketplace fn={fn} />);
    expect(reseller).toContain('catalog-net.example.minimal');
    expect(reseller).not.toContain('>Install<');
    authState.user = { id: 1, username: 'root', role: 'root' };
    responses.set('/marketplace/status', { data: { ...enabledStatus, enabled: false } });
    const off = render(<WhmMarketplace fn={fn} />);
    expect(off).not.toContain('catalog-net.example.minimal');
    expect(off).not.toContain('Distribution packages');
    expect(off).toContain('NGINX');
    expect(off).toContain('data-testid="marketplace-disabled"');
  });

  it('Market Provider Manager points the hub row at the License tab for the key', () => {
    responses.clear();
    responses.set('/market/providers', { data: [{ name: 'whm-hub', displayName: 'WHM Marketplace', type: 'plugin', adapter: 'hub', adapterLabel: 'WHM plugin marketplace hub', builtin: true, enabled: false, configured: false, url: null, products: [], commissionPercent: 0, orders: 0, readOnly: false, hasProducts: false }] });
    responses.set('/market/adapters', { data: [{ id: 'hub', label: 'WHM plugin marketplace hub', types: ['plugin'], singleton: true, configFields: [], requiresUrl: true }] });
    const fn = FUNCTION_BY_KEY['market/market-provider-manager'];
    const html = render(<MarketProviderManager fn={fn} />);
    expect(html).toContain('License key is entered under Basic Setup → License');
    expect(html).toContain('/server-configuration/basic-webhost-manager-setup#license');
  });
});
