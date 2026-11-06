import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY, visibleCategories } = await import('../src/panel/nav.js');
const { default: Installers } = await import('../src/pages/panel/software/installers.jsx');
const { default: WordPress, hostState, jobStreamPath } = await import('../src/pages/panel/software/wordpress.jsx');
const { INSTALLER_CATALOG, INSTALLER_BY_ID, DEFAULT_INSTALLER, installerPath, visibleInstallers, resolveInstaller, appSlice } = await import('../src/pages/panel/software/parts/catalog.js');
const { registryKeysFrom } = await import('../src/panel/registry.js');
const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: {}, features: {}, limits: {}, contactEmail: 'owner@demo.example.com', domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctxFor = (hasFeature = () => true) => ({ me, loading: false, error: null, reload: () => {}, hasFeature });
const fn = PANEL_FUNCTION_BY_KEY['panel:software/installers'];
const render = (el, path, ctx = ctxFor()) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });
const meta = (over = {}) => ({ total: 0, requirements: { php: true, phpMysql: true, unzip: true, asUser: true }, canInstall: true, hint: null, sites: [{ domain: 'demo.example.com', type: 'main', docroot: 'public_html' }], prefix: 'demo_', ...over });
const catalog = (over = {}) => [{ id: 'joomla', name: 'Joomla', finish: 'cli', version: '5.3.1', canInstall: true, hint: null, ...over.joomla }, { id: 'drupal', name: 'Drupal', finish: 'web', version: '11.2.0', canInstall: true, hint: null, ...over.drupal }];
const joomlaRow = { app: 'joomla', name: 'Joomla', id: 'c1d2e3f4a5b60718', path: 'public_html/shop', domain: 'demo.example.com', under: 'shop', url: 'https://demo.example.com/shop', adminUrl: 'https://demo.example.com/shop/administrator/', version: '5.3.1', database: 'demo_joomla', dbUser: 'demo_joomla', dbHost: 'localhost', isDocroot: false, databaseOwned: true, installUrl: null, configured: true };
const drupalRow = { app: 'drupal', name: 'Drupal', id: 'd1d2e3f4a5b60718', path: 'public_html/cms', domain: 'demo.example.com', under: 'cms', url: 'https://demo.example.com/cms', adminUrl: 'https://demo.example.com/cms/user/login', installUrl: 'https://demo.example.com/cms/core/install.php', version: '11.2.0', database: 'demo_drupal', dbUser: 'demo_drupal', dbHost: 'localhost', isDocroot: false, databaseOwned: true, configured: true };

describe('installer catalog shape', () => {
  it('lists WordPress, Joomla and Drupal with one API segment each and a plan feature', () => {
    expect(INSTALLER_CATALOG.map((a) => a.id)).toEqual(['wordpress', 'joomla', 'drupal']);
    for (const a of INSTALLER_CATALOG) {
      expect(a.id).toMatch(/^[a-z]+$/);
      expect(a.label).toBeTruthy();
      expect(a.vendor).toMatch(/\./);
      expect(a.configFile).toBeTruthy();
      expect(['panel', 'web']).toContain(a.setup);
      expect(typeof a.feature).toBe('string');
    }
    expect(INSTALLER_BY_ID.wordpress.cli).toBe('wpcli');
    expect(INSTALLER_BY_ID.joomla.cli).toBe(null);
    expect(INSTALLER_BY_ID.drupal.setup).toBe('web');
    expect(DEFAULT_INSTALLER).toBe('wordpress');
    expect(installerPath('wordpress')).toBe('/panel/software/installers');
    expect(installerPath('joomla')).toBe('/panel/software/installers?app=joomla');
    expect(jobStreamPath(3, 'drupal')).toBe('/panel/software/installers/jobs/3/stream');
    expect(INSTALLER_BY_ID.joomla.api.list).toBe('/software/installers');
    expect(INSTALLER_BY_ID.joomla.api.install).toBe('/software/installers/joomla');
    expect(INSTALLER_BY_ID.joomla.api.remove('ab')).toBe('/software/installers/ab');
    expect(INSTALLER_BY_ID.joomla.api.update).toBe(null);
    expect(INSTALLER_BY_ID.wordpress.api.update('ab')).toBe('/software/wordpress/ab/update');
    expect(INSTALLER_BY_ID.drupal.fields).toEqual([]);
    expect(INSTALLER_BY_ID.joomla.passwordMin).toBe(12);
    expect(jobStreamPath(3)).toBe('/panel/software/wordpress/jobs/3/stream');
  });

  it('follows the plan features per app', () => {
    expect(visibleInstallers().map((a) => a.id)).toEqual(['wordpress', 'joomla', 'drupal']);
    expect(visibleInstallers((f) => f !== 'wordpress').map((a) => a.id)).toEqual(['joomla', 'drupal']);
    expect(visibleInstallers((f) => f !== 'installers').map((a) => a.id)).toEqual(['wordpress']);
    expect(resolveInstaller('joomla', () => true).id).toBe('joomla');
    expect(resolveInstaller('nope', () => true).id).toBe('wordpress');
    expect(resolveInstaller('joomla', (f) => f !== 'installers').id).toBe('joomla');
  });

  it('hostState answers per app: only an app with a CLI can update from the panel; a shared list answers per catalog entry', () => {
    const m = meta({ requirements: { wpcli: true, php: true, phpMysql: true, unzip: true, asUser: true } });
    expect(hostState(m, INSTALLER_BY_ID.wordpress)).toMatchObject({ canInstall: true, canUpdate: true, method: 'cli' });
    expect(hostState(m, INSTALLER_BY_ID.joomla)).toMatchObject({ canInstall: true, canUpdate: false, method: 'web' });
    expect(hostState(null, INSTALLER_BY_ID.drupal)).toEqual({ canInstall: false, canUpdate: false, hint: null, version: null, method: 'web' });
    const sharedMeta = meta({ catalog: catalog({ drupal: { canInstall: false, hint: 'Drupal 11.2.0 needs PHP 8.3 or newer on the server (it has 8.1)' } }) });
    expect(hostState(sharedMeta, INSTALLER_BY_ID.joomla)).toMatchObject({ canInstall: true, hint: null, version: '5.3.1' });
    expect(hostState(sharedMeta, INSTALLER_BY_ID.drupal)).toMatchObject({ canInstall: false, hint: 'Drupal 11.2.0 needs PHP 8.3 or newer on the server (it has 8.1)', version: '11.2.0' });
    expect(appSlice(INSTALLER_BY_ID.joomla, [joomlaRow, drupalRow], sharedMeta).rows).toEqual([joomlaRow]);
    expect(appSlice(INSTALLER_BY_ID.wordpress, [{ id: 'x' }], m).rows).toEqual([{ id: 'x' }]);
  });
});

describe('nav entry and catalogue strings', () => {
  it('is a gated Software function with a discovered page and consolidated en.json strings', () => {
    expect(fn).toMatchObject({ feature: 'installers', path: '/panel/software/installers', categorySlug: 'software' });
    expect(registryKeysFrom(['../pages/panel/software/installers.jsx', '../pages/panel/software/wordpress.jsx', '../pages/panel/software/parts/catalog.js'])).toEqual(['panel:software/installers', 'panel:software/wordpress']);
    expect(en['panel.software/installers.label']).toBe('Installers');
    expect(visibleCategories({ wordpress: false, plugins: false, applicationmanager: false }).some((c) => c.slug === 'software')).toBe(true);
    for (const key of ['panel.software.install_title', 'panel.software.sites_title', 'panel.software.sites_empty', 'panel.software.cannot_install', 'panel.software.remove_button', 'panel.software.method_web', 'panel.software.method_cli', 'panel.software.update_needs_cli', 'panel.software.updates_need_cli']) expect(en[key]).toMatch(/\{(app|cli|vendor|config)\}/);
    for (const key of ['panel.software.method_wpcli', 'panel.software.update_needs_wpcli', 'panel.software.updates_need_wpcli']) expect(en[key]).toBeUndefined();
    const appSpecific = Object.entries(en).filter(([k, v]) => k.startsWith('panel.software.') && /WordPress|Joomla|Drupal/.test(v));
    expect(appSpecific).toEqual([]);
  });
});

describe('Installers page', () => {
  it('renders the WordPress tab by default with the tab bar and the WordPress wording', () => {
    fixtures.responses.clear();
    set('/panel/software/wordpress', { data: [], meta: meta() });
    const html = render(h(Installers, { fn }), fn.path);
    expect(html).toContain('<h1>Installers</h1>');
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/id="installer-tab-wordpress"[^>]*aria-selected="true"/);
    expect(html).toMatch(/id="installer-tab-joomla"[^>]*aria-selected="false"/);
    expect(html).toContain('id="installer-tab-drupal"');
    expect(html).toContain('Install WordPress');
    expect(html).toContain('id="wp-domain"');
    expect(html).toContain('Downloaded from wordpress.org');
    expect(html).toContain('No WordPress installation found');
    expect(html).toContain('wp-config.php');
  });

  it('?app=joomla shows the Joomla tab with its own list, wording and no update action', () => {
    fixtures.responses.clear();
    set('/panel/software/installers', { data: [joomlaRow, drupalRow], meta: meta({ total: 2, catalog: catalog() }) });
    const html = render(h(Installers, { fn }), `${fn.path}?app=joomla`);
    expect(html).toMatch(/id="installer-tab-joomla"[^>]*aria-selected="true"/);
    expect(html).toContain('Install Joomla');
    expect(html).toContain('Latest release: 5.3.1.');
    expect(html).toContain('id="joomla-domain"');
    expect(html).toContain('Downloaded from downloads.joomla.org');
    expect(html).toContain('Your Joomla sites');
    expect(html).toContain('demo.example.com/shop</a>');
    expect(html).toContain('<code>5.3.1</code>');
    expect(html).not.toContain('demo.example.com/cms');
    expect(html).toContain('1 found under your document roots');
    expect(html).toContain('Joomla updates itself from its own administration pages.');
    expect(html).toContain('Generate one for me');
    expect(html).not.toContain('needs WP-CLI');
    expect(html).not.toContain('WordPress cannot');
  });

  it('?app=drupal explains the web-installer hand-over; an unknown app falls back to WordPress', () => {
    fixtures.responses.clear();
    set('/panel/software/installers', { data: [joomlaRow, drupalRow], meta: meta({ total: 2, catalog: catalog({ drupal: { canInstall: false, hint: 'Drupal 11.2.0 needs PHP 8.3 or newer on the server (it has 8.1)' } }) }) });
    set('/panel/software/wordpress', { data: [], meta: meta() });
    let html = render(h(Installers, { fn }), `${fn.path}?app=drupal`);
    expect(html).toContain('Install Drupal');
    expect(html).toContain('Latest release: 11.2.0.');
    expect(html).toContain('you finish the setup in the Drupal installer');
    expect(html).toContain('chosen in the Drupal installer');
    expect(html).not.toContain('id="drupal-title"');
    expect(html).not.toContain('id="drupal-admin-user"');
    expect(html).toContain('id="drupal-path"');
    expect(html).toContain('Drupal cannot be installed on this server yet.');
    expect(html).toContain('needs PHP 8.3 or newer');
    expect(html).toMatch(/id="drupal-path"[^>]*disabled=""/);
    expect(html).toContain('demo.example.com/cms</a>');
    expect(html).not.toContain('demo.example.com/shop');
    expect(html).toContain('>Setup pending<');
    expect(html).toContain('>Finish setup<');
    set('/panel/software/installers', { data: [], meta: meta({ catalog: catalog() }) });
    html = render(h(Installers, { fn }), `${fn.path}?app=drupal`);
    expect(html).toContain('No Drupal installation found');
    expect(html).toContain('sites/default/settings.php');
    html = render(h(Installers, { fn }), `${fn.path}?app=nope`);
    expect(html).toContain('Install WordPress');
  });

  it('hides the tabs of apps the plan leaves out and the whole page when the feature is off', () => {
    fixtures.responses.clear();
    set('/panel/software/wordpress', { data: [], meta: meta() });
    let html = render(h(Installers, { fn }), fn.path, ctxFor((f) => f !== 'installers'));
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('Install WordPress');
    set('/panel/software/installers', { data: [], meta: meta({ catalog: catalog() }) });
    html = render(h(Installers, { fn }), fn.path, ctxFor((f) => f !== 'wordpress'));
    expect(html).toContain('Install Joomla');
    expect(html).not.toContain('installer-tab-wordpress');
    set('/panel/software/wordpress', { error: { status: 403, code: 'feature_disabled', message: 'Your hosting package does not include it' } });
    expect(render(h(Installers, { fn }), fn.path)).toContain('Not included in your plan');
  });

  it('the WordPress function is the pinned WordPress tab of the same page', () => {
    fixtures.responses.clear();
    set('/panel/software/wordpress', { data: [], meta: meta() });
    const wp = PANEL_FUNCTION_BY_KEY['panel:software/wordpress'];
    const html = render(h(WordPress, { fn: wp }), wp.path);
    expect(html).toContain('<h1>WordPress</h1>');
    expect(html).toMatch(/id="installer-tab-wordpress"[^>]*aria-selected="true"/);
    expect(html).toContain('id="installer-tab-joomla"');
    expect(html).toContain('Install WordPress');
  });
});
