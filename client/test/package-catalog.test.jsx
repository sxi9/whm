import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY, FUNCTIONS } from '../src/nav.js';
import { catalogEntries } from '../../server/src/lib/package-catalog.js';

const auth = { user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {}, ready: true };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

// useApi fetches in an effect, which static rendering never runs; canned data
// per path prefix lets each render show one server state.
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

const { PackageCatalog, CatalogEntryCard, SearchResults, installDistroHref, catalogEntryState, canInstallEntry, variantLabel, INSTALL_DISTRO_PATH } = await import('../src/pages/software/PackageCatalog.jsx');
const { default: InstallDistroPackages } = await import('../src/pages/fn/software/install-distro-packages.jsx');
const { StaticCatalog, catalogHref } = await import('../src/pages/fn/server-configuration/whm-marketplace.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el, initialEntries) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter initialEntries={initialEntries}>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

const pkg = (name, extra = {}) => ({ name, installed: false, version: null, offered: true, candidate: '1.0-1', ...extra });
const entry = (key, category, extra = {}) => ({ key, label: key, description: `${key} description`, category, recommended: false, stack: null, capability: null, requires: null, configure: null, packages: [pkg(key)], installed: false, partial: false, offered: true, missing: [], php: null, ...extra });
const APACHE = entry('apache', 'web', { label: 'Apache HTTP Server', recommended: true, configure: '/service-configuration/apache-configuration', packages: [pkg('apache2', { installed: true, version: '2.4.58' })], installed: true });
const NGINX = entry('nginx', 'web', { label: 'NGINX (reverse proxy)', configure: '/software/nginx-manager' });
const REDIS = entry('redis', 'databases', { label: 'Redis server', recommended: true, packages: [pkg('redis-server')] });
const NETDATA = entry('netdata', 'monitoring', { label: 'Netdata', requires: 'Needs the EPEL repository.', packages: [pkg('netdata', { offered: false, candidate: null })], offered: false, missing: ['netdata'] });
const ARCHIVERS = entry('archivers', 'tools', { label: 'Archive tools', packages: [pkg('zip', { installed: true, version: '3.0' }), pkg('unzip')], partial: true });
const PHP_REDIS = entry('php-redis', 'php', { label: 'Redis client', recommended: true, packages: [pkg('php8.3-redis'), pkg('php8.2-redis', { installed: true, version: '6.0.2' })], partial: true, php: { unversioned: false, versions: [{ id: '8.3', label: 'PHP 8.3', name: 'php8.3-redis', installed: false, version: null, offered: true, candidate: '1.0-1' }, { id: '8.2', label: 'PHP 8.2', name: 'php8.2-redis', installed: true, version: '6.0.2', offered: true, candidate: null }] } });
const CATALOG = {
  manager: 'apt', family: 'debian', phpVersions: [{ id: '8.3', label: 'PHP 8.3', layout: 'debian' }, { id: '8.2', label: 'PHP 8.2', layout: 'debian' }], installedTotal: 812, offersKnown: true, offersAt: Date.now(), entries: 6, total: 6,
  groups: [
    { key: 'web', label: 'Web', description: 'The web server.', entries: [APACHE, NGINX] },
    { key: 'php', label: 'PHP extensions', description: 'Per installed PHP version.', entries: [PHP_REDIS] },
    { key: 'databases', label: 'Databases', description: 'Database servers and caches.', entries: [REDIS] },
    { key: 'tools', label: 'Tools', description: 'Archivers and media libraries.', entries: [ARCHIVERS] },
    { key: 'monitoring', label: 'Monitoring', description: 'Observation.', entries: [NETDATA] },
  ],
};
const SEARCH = {
  manager: 'apt', q: 'redis', all: false, total: 9, shown: 3, collapsed: 6, hidden: 0, more: false, truncated: 0,
  results: [
    { name: 'redis', summary: 'Persistent key-value database', installed: false, installedVersion: null, variantCount: 5, variants: [
      { name: 'redis-doc', summary: 'docs', kind: 'doc', installed: false, installedVersion: null },
      { name: 'php8.3-redis', summary: 'php binding', kind: 'php binding', installed: true, installedVersion: '6.0.2' },
      { name: 'python3-redis', summary: 'python binding', kind: 'python3 binding', installed: false, installedVersion: null },
      { name: 'redis:i386', summary: 'i386', kind: 'arch', installed: false, installedVersion: null },
      { name: 'libhiredis-dev', summary: 'headers', kind: 'dev', installed: false, installedVersion: null },
    ] },
    { name: 'redis-server', summary: 'server', installed: true, installedVersion: '7:7.0.15-1', variantCount: 0, variants: [] },
    { name: 'redis-tools', summary: 'tools', installed: false, installedVersion: null, variantCount: 1, variants: [{ name: 'redis-tools:i386', summary: 'tools', kind: 'arch', installed: false, installedVersion: null }] },
  ],
};
const fn = FUNCTION_BY_KEY['software/install-distro-packages'];

describe('deep links', () => {
  it('builds the Install Distro Packages URL for an entry, a search, or both', () => {
    expect(INSTALL_DISTRO_PATH).toBe(fn.path);
    expect(installDistroHref()).toBe('/software/install-distro-packages');
    expect(installDistroHref({ entry: 'redis' })).toBe('/software/install-distro-packages?entry=redis');
    expect(installDistroHref({ q: 'redis-server' })).toBe('/software/install-distro-packages?q=redis-server');
    expect(installDistroHref({ entry: 'php-redis', q: 'php redis' })).toBe('/software/install-distro-packages?entry=php-redis&q=php+redis');
  });

  it('the WHM Marketplace "Add" button lands on the catalog entry with the first host package as the fallback search', () => {
    expect(catalogHref({ id: 'redis', packagesForHost: ['redis-server'], packages: { apt: ['redis-server'] } })).toBe('/software/install-distro-packages?entry=redis&q=redis-server');
    expect(catalogHref({ id: 'roundcube', packagesForHost: [], packages: { apt: ['roundcube'] } })).toBe('/software/install-distro-packages?entry=roundcube&q=roundcube');
    expect(catalogHref({ id: 'thing' })).toBe('/software/install-distro-packages?entry=thing&q=thing');
    responses.clear();
    const base = { vendor: 'x', category: 'Databases', description: 'd', price: 'Free', installed: false, installPath: '/software/install-distro-packages', configure: null, docs: null };
    responses.set('/server-config/marketplace', { data: { total: 2, categories: ['Databases'], packageManager: 'apt', items: [
      { ...base, id: 'redis', name: 'Redis', packagesForHost: ['redis-server'] },
      { ...base, id: 'roundcube', name: 'Roundcube', packagesForHost: [] },
    ] } });
    const html = render(<StaticCatalog />);
    expect(html).toContain('data-testid="catalog-link-redis"');
    expect(html).toContain('href="/software/install-distro-packages?entry=redis&amp;q=redis-server"');
    expect(html).toContain('href="/software/install-distro-packages?entry=roundcube&amp;q=roundcube"');
    expect(html).toContain('>Open in catalog<');
    expect(html).toContain('>Add<');
    expect(html).not.toContain('?q=redis"');
  });

  it('every catalog entry that offers Configure points at a page nav.js routes', () => {
    const paths = new Set(FUNCTIONS.map((f) => f.path));
    for (const e of catalogEntries()) if (e.configure) expect(paths.has(e.configure), `${e.key} → ${e.configure}`).toBe(true);
  });
});

describe('catalog entry state', () => {
  it('derives the pill and whether Install makes sense', () => {
    expect(catalogEntryState(APACHE)).toEqual({ status: 'installed', label: 'installed' });
    expect(catalogEntryState(REDIS)).toEqual({ status: 'not-installed', label: 'available' });
    expect(catalogEntryState(NETDATA)).toEqual({ status: 'not-installed', label: 'not offered' });
    expect(catalogEntryState(ARCHIVERS)).toEqual({ status: 'warning', label: '1 of 2 installed' });
    expect(catalogEntryState({ ...REDIS, offered: null })).toEqual({ status: 'unknown', label: 'not installed' });
    expect(catalogEntryState({ ...ARCHIVERS, partial: false, offered: false, missing: ['unzip'] })).toEqual({ status: 'not-installed', label: 'partly offered' });
    expect(canInstallEntry(APACHE)).toBe(false);
    expect(canInstallEntry(REDIS)).toBe(true);
    expect(canInstallEntry(NETDATA)).toBe(false);
    expect(canInstallEntry({ ...REDIS, offered: null })).toBe(true);
    expect(variantLabel('dev')).toBe('development files');
    expect(variantLabel('php binding')).toBe('php binding');
    expect(variantLabel(undefined)).toBe('variant');
  });
});

describe('PackageCatalog', () => {
  it('renders the groups as sections of cards with Install buttons, installed badges and Configure links', () => {
    const html = render(<PackageCatalog data={CATALOG} onInstall={() => {}} />);
    for (const g of ['web', 'php', 'databases', 'tools', 'monitoring']) expect(html).toContain(`data-testid="catalog-group-${g}"`);
    expect(html).toContain('1 / 2 installed');
    expect(html).toContain('data-testid="catalog-apache"');
    expect(html).toContain('>installed<');
    expect(html).toContain('href="/service-configuration/apache-configuration"');
    expect(html).toContain('recommended');
    // NGINX is not installed: Install, no Configure.
    expect(html).toContain('data-testid="catalog-nginx"');
    expect(html).not.toContain('href="/software/nginx-manager"');
    expect(html).toContain('>Install<');
    expect(html).toContain('>Install the rest<');
    expect(html).toContain('1 of 2 installed');
    // Not offered: the reason, the struck-through name and no Install button for that card.
    const netdata = html.slice(html.indexOf('data-testid="catalog-netdata"'), html.indexOf('</section>', html.indexOf('data-testid="catalog-netdata"')));
    expect(netdata).toContain('>not offered<');
    expect(netdata).toContain('Not offered by the configured repositories: netdata.');
    expect(netdata).toContain('Needs the EPEL repository.');
    expect(netdata).toContain('line-through');
    expect(netdata).not.toContain('>Install<');
    // PHP extension: one line per installed version, Install only where it is missing.
    const phpRedis = html.slice(html.indexOf('data-testid="catalog-php-redis"'), html.indexOf('</section>', html.indexOf('data-testid="catalog-php-redis"')));
    expect(phpRedis).toContain('>Install for PHP 8.3<');
    expect(phpRedis).not.toContain('>Install for PHP 8.2<');
    expect(phpRedis).toContain('>6.0.2<');
    expect(phpRedis).toContain('>Install for the rest<');
  });

  it('highlights the entry a deep link named, filters by text and hides what is installed on request', () => {
    const highlighted = render(<PackageCatalog data={CATALOG} highlight="redis" />);
    expect(highlighted).toContain('id="pkg-redis"');
    expect(highlighted).toMatch(/data-testid="catalog-redis" class="card catalog-entry is-highlighted"/);
    expect(highlighted).not.toMatch(/data-testid="catalog-apache" class="card catalog-entry is-highlighted"/);
    const filtered = render(<PackageCatalog data={CATALOG} filter="redis" />);
    expect(filtered).toContain('data-testid="catalog-redis"');
    expect(filtered).toContain('data-testid="catalog-php-redis"');
    expect(filtered).not.toContain('data-testid="catalog-apache"');
    expect(filtered).not.toContain('data-testid="catalog-group-monitoring"');
    const missing = render(<PackageCatalog data={CATALOG} onlyMissing />);
    expect(missing).not.toContain('data-testid="catalog-apache"');
    expect(missing).toContain('data-testid="catalog-nginx"');
    expect(render(<PackageCatalog data={CATALOG} filter="nothing-like-this" />)).toContain('Nothing in the catalog matches');
    expect(render(<PackageCatalog data={null} loading />)).toContain('Reading the package list');
  });

  it('a single card renders without a group', () => {
    const html = render(<CatalogEntryCard entry={REDIS} />);
    expect(html).toContain('Redis server');
    expect(html).toContain('<code');
    expect(html).toContain('redis-server');
  });
});

describe('SearchResults', () => {
  it('shows one row per piece of software with a "Show N more variants" control and the "Show everything" switch', () => {
    const html = render(<SearchResults data={SEARCH} />);
    expect(html).toContain('3 packages, 6 variants folded underneath · 9 matching names in the repositories');
    expect(html).toContain('data-testid="variants-redis"');
    expect(html).toContain('Show 5 more variants');
    expect(html).toContain('data-testid="variants-redis-tools"');
    expect(html).toContain('Show 1 more variant<');
    expect(html).not.toContain('data-testid="variants-redis-server"');
    // Variants stay folded until the control is used.
    expect(html).not.toContain('python3-redis');
    expect(html).not.toContain('class="pill pill-muted" style="margin-left:6px">documentation');
    expect(html).toContain('Show everything');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
    expect(html).toContain('>7:7.0.15-1<');
    expect((html.match(/>Install</g) || []).length).toBe(2);
    expect((html.match(/>Remove</g) || []).length).toBe(1);
  });

  it('describes the raw list when "Show everything" is on, and the cut when the cap hit', () => {
    const all = { ...SEARCH, all: true, total: 240, shown: 60, collapsed: 0, hidden: 180, more: true, truncated: 180, results: SEARCH.results.map((r) => ({ ...r, variants: [], variantCount: 0 })) };
    const html = render(<SearchResults data={all} showAll />);
    expect(html).toContain('60 of 240 matching package names (the first 60; narrow the search for the rest)');
    expect(html).toContain('checked=""');
    expect(html).not.toContain('more variant');
    const capped = render(<SearchResults data={{ ...SEARCH, more: true, truncated: 12, hidden: 12, total: 21 }} />);
    expect(capped).toContain('12 more not shown');
    const nothing = render(<SearchResults data={{ ...SEARCH, results: [], total: 0, shown: 0, collapsed: 0 }} />);
    expect(nothing).toContain('Nothing in the repositories matches &quot;redis&quot;');
    expect(nothing).not.toContain('Show everything');
  });
});

describe('Install Distro Packages page', () => {
  const detect = { manager: 'apt', family: 'debian', binary: 'apt-get', rpm: false, rebootRequired: false, capability: true, rpmCapability: false };

  it('opens on the curated catalog, with the repository search as a secondary tab', () => {
    responses.clear();
    responses.set('/software/pkg/detect', { data: detect });
    responses.set('/software/pkg/catalog', { data: CATALOG });
    responses.set('/software/pkg/recent', { data: [] });
    const html = render(<InstallDistroPackages fn={fn} />, ['/software/install-distro-packages']);
    expect(html).toContain('aria-selected="true" class="btn btn-sm btn-primary">Catalog');
    expect(html).toContain('>Search repositories<');
    expect(html).toContain('>Installed packages<');
    expect(html).toContain('data-testid="catalog-group-web"');
    expect(html).toContain('data-testid="catalog-redis"');
    expect(html).toContain('Debian/Ubuntu');
    expect(html).toContain('PHP 8.3, 8.2');
    expect(html).toContain('Re-check repositories');
    expect(html).toContain('Not in the list? Search the repositories under');
    expect(html).toContain('APT (Debian/Ubuntu)');
    expect(html).not.toContain('data-testid="search-summary"');
  });

  it('a deep link to a catalog entry highlights it; a search deep link opens the search tab with deduped results', () => {
    responses.clear();
    responses.set('/software/pkg/detect', { data: detect });
    responses.set('/software/pkg/catalog', { data: CATALOG });
    responses.set('/software/pkg/recent', { data: [] });
    responses.set('/software/pkg/search?q=redis&limit=60', { data: SEARCH });
    const linked = render(<InstallDistroPackages fn={fn} />, ['/software/install-distro-packages?entry=redis']);
    expect(linked).toMatch(/data-testid="catalog-redis" class="card catalog-entry is-highlighted"/);
    expect(linked).toContain('aria-selected="true" class="btn btn-sm btn-primary">Catalog');
    const searched = render(<InstallDistroPackages fn={fn} />, ['/software/install-distro-packages?q=redis']);
    expect(searched).toContain('aria-selected="true" class="btn btn-sm btn-primary">Search repositories');
    expect(searched).toContain('value="redis"');
    expect(searched).toContain('data-testid="search-summary"');
    expect(searched).toContain('Show 5 more variants');
    expect(searched).toContain('Show everything');
    expect(searched).not.toContain('data-testid="catalog-group-web"');
  });

  it('says so when the host has no package manager and renders the catalog error without crashing', () => {
    responses.clear();
    responses.set('/software/pkg/detect', { data: { ...detect, manager: null, family: null, capability: false } });
    responses.set('/software/pkg/catalog', { error: { message: 'No supported package manager (apt-get, dnf or yum) was found on this server', code: 'capability_missing', capability: 'pkg' } });
    responses.set('/software/pkg/recent', { data: [] });
    const html = render(<InstallDistroPackages fn={fn} />, ['/software/install-distro-packages']);
    expect(html).toContain('No supported package manager');
    expect(html).toContain('no package manager');
    expect(html).not.toContain('data-testid="catalog-group-web"');
  });
});
