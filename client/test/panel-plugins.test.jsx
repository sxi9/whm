import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { readFileSync } from 'node:fs';

// Plugin pages in the account panel (contract §53): the provider's entries land
// in the Software group, the Software › Plugins page lists them, and
// /panel/plugins/:id/* renders a page with the panel's own endpoints.

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, hostname: 'srv1.example', refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (p) => ({ data: null, meta: null, error: null, loading: Boolean(p), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(p) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PanelPluginContext, panelPluginEntries, panelPluginPath, withPluginEntries, searchPluginEntries, PANEL_PLUGIN_GROUP } = await import('../src/panel/hooks/usePanelPlugins.js');
const { PanelPluginPage, PANEL_PAGE_KINDS } = await import('../src/panel/PanelPluginPage.jsx');
const { PanelSidebar } = await import('../src/panel/PanelSidebar.jsx');
const { panelRoutes } = await import('../src/panel/routes.jsx');
const { PANEL_FUNCTION_BY_KEY, visibleCategories } = await import('../src/panel/nav.js');
const { PANEL_PAGE_REGISTRY } = await import('../src/panel/registry.js');
const { default: PluginsPage } = await import('../src/pages/panel/software/plugins.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', features: {}, limits: {}, domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const plugin = {
  id: 'net.whm.sample-notes', name: 'Sample Notes', version: '1.1.0',
  pages: [
    { route: '/my-notes', title: 'Notes about my account', kind: 'table', audience: 'panel', source: '/my-notes', description: 'Notes your hosting provider attached to this account.', columns: [{ key: 'title', label: 'Title' }], origin: 'manifest' },
    { route: '/help', title: 'Help', kind: 'markdown', audience: 'panel', content: '# Help\n\nRead **this**.', origin: 'runtime' },
    { route: '/embed', title: 'Embed', kind: 'html', audience: 'panel', file: 'pages/widget.html', origin: 'manifest' },
  ],
};
const pluginCtx = (over = {}) => ({ plugins: [plugin], entries: panelPluginEntries([plugin]), loading: false, error: null, reload: () => {}, ...over });
const fn = PANEL_FUNCTION_BY_KEY['panel:software/plugins'];

const render = (el, path = '/panel', pc = pluginCtx()) => renderToStaticMarkup(
  h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(PanelPluginContext.Provider, { value: pc }, h(ToastProvider, null, h(ConfirmProvider, null, el)))))),
);
const renderRoute = (path, pc) => render(h(Routes, null, h(Route, { path: 'panel/plugins/:pluginId/*', element: h(PanelPluginPage) })), path, pc);

describe('nav entry, feature flag and i18n', () => {
  it('Software › Plugins is a nav function gated by the plugins feature with a registered page and en.json keys', () => {
    expect(fn).toMatchObject({ feature: 'plugins', path: '/panel/software/plugins', categorySlug: 'software' });
    expect(PANEL_PAGE_REGISTRY['panel:software/plugins']).toBeTruthy();
    expect(visibleCategories({ plugins: false }).find((c) => c.slug === 'software').functions.map((f) => f.slug)).not.toContain('plugins');
    const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
    expect(en['panel.software/plugins.label']).toBe('Plugins');
    for (const k of ['panel.plugins.empty_title', 'panel.plugins.intro', 'panel.plugins.not_found_title', 'panel.plugins.unsupported']) expect(typeof en[k]).toBe('string');
    expect(JSON.parse(readFileSync(new URL('../../server/src/db/seed.js', import.meta.url), 'utf8').match(/plugins: (true|false)/)[1])).toBe(true);
  });

  it('routes.jsx serves /panel/plugins/:pluginId/* before the catch-all', () => {
    const children = panelRoutes[0].children;
    expect(children.at(-2).path).toBe('plugins/:pluginId/*');
    expect(children.at(-1).path).toBe('*');
  });
});

describe('usePanelPlugins helpers', () => {
  it('turns panel pages into Software-group entries with panel paths', () => {
    const entries = panelPluginEntries([plugin]);
    expect(entries.map((e) => [e.key, e.path, e.categorySlug, e.label])).toEqual([
      ['panel-plugin:net.whm.sample-notes:/my-notes', '/panel/plugins/net.whm.sample-notes/my-notes', PANEL_PLUGIN_GROUP, 'Notes about my account'],
      ['panel-plugin:net.whm.sample-notes:/help', '/panel/plugins/net.whm.sample-notes/help', PANEL_PLUGIN_GROUP, 'Help'],
      ['panel-plugin:net.whm.sample-notes:/embed', '/panel/plugins/net.whm.sample-notes/embed', PANEL_PLUGIN_GROUP, 'Embed'],
    ]);
    expect(entries[1].description).toBe('Sample Notes 1.1.0');
    expect(panelPluginPath(plugin, { route: '/' })).toBe('/panel/plugins/net.whm.sample-notes');
    const merged = withPluginEntries(visibleCategories({}), entries);
    expect(merged.find((c) => c.slug === 'software').functions.map((f) => f.label)).toEqual(['WordPress', 'Plugins', 'Application manager', 'Notes about my account', 'Help', 'Embed']);
    expect(withPluginEntries(visibleCategories({}), [])).toEqual(visibleCategories({}));
    expect(searchPluginEntries(entries, 'notes account').map((e) => e.label)).toEqual(['Notes about my account']);
    expect(searchPluginEntries(entries, '')).toHaveLength(3);
    expect(PANEL_PAGE_KINDS).toEqual(['table', 'form', 'markdown', 'html']);
  });
});

describe('sidebar and the Plugins page', () => {
  it('lists the plugin pages in the Software group of the sidebar and finds them through the filter', () => {
    // Groups start collapsed in a static render: the head carries the count
    // (WordPress, Plugins, Application manager + the three plugin pages), the entries are in the merge.
    const html = render(h(PanelSidebar, { collapsed: false }));
    const software = html.slice(html.indexOf('data-group="software"'));
    expect(software.slice(0, software.indexOf('</button>'))).toContain('<span class="count">6</span>');
    const entries = panelPluginEntries([plugin]);
    expect(withPluginEntries(visibleCategories({}), entries).find((c) => c.slug === 'software').functions.some((f) => f.path === '/panel/plugins/net.whm.sample-notes/my-notes')).toBe(true);
  });

  it('the Software › Plugins page lists every page per plugin, and an empty state without plugins', () => {
    const html = render(h(PluginsPage, { fn }), '/panel/software/plugins');
    expect(html).toContain('<h1>Plugins</h1>');
    expect(html).toContain('Sample Notes');
    expect(html).toContain('/panel/plugins/net.whm.sample-notes/help');
    expect(html).toContain('Notes your hosting provider attached to this account.');
    const empty = render(h(PluginsPage, { fn }), '/panel/software/plugins', pluginCtx({ plugins: [], entries: [] }));
    expect(empty).toContain('No plugin pages');
    const failed = render(h(PluginsPage, { fn }), '/panel/software/plugins', pluginCtx({ plugins: [], entries: [], error: { status: 503, message: 'host down' } }));
    expect(failed).toContain('host down');
  });

  it('renders the feature-disabled state when the plan excludes plugins', () => {
    const html = renderToStaticMarkup(h(MemoryRouter, null, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: { ...ctx, hasFeature: (f) => f !== 'plugins' } }, h(PanelPluginContext.Provider, { value: pluginCtx() }, h(PluginsPage, { fn }))))));
    expect(html).toContain('Not included in your plan');
    expect(html).not.toContain('Sample Notes');
  });
});

describe('PanelPluginPage', () => {
  it('renders a table page against /panel/plugins/<id>/<source> with the panel header', () => {
    fixtures.responses.set('/panel/plugins/net.whm.sample-notes/my-notes', { loading: false, data: [{ id: 'n1', title: 'First note' }] });
    const html = renderRoute('/panel/plugins/net.whm.sample-notes/my-notes');
    expect(html).toContain('<h1>Notes about my account</h1>');
    expect(html).toContain('breadcrumbs');
    expect(html).toContain('<table');
    expect(html).toContain('First note');
  });

  it('renders a markdown page from its content and an html page from the panel file endpoint', () => {
    const md = renderRoute('/panel/plugins/net.whm.sample-notes/help');
    expect(md).toContain('<h1>Help</h1>');
    expect(md).toContain('<strong>this</strong>');
    fixtures.responses.set('/panel/plugins/ui/net.whm.sample-notes/file?path=pages%2Fwidget.html', { loading: false, data: { kind: 'html', content: '<b>hi</b>' } });
    const html = renderRoute('/panel/plugins/net.whm.sample-notes/embed');
    expect(html).toContain('sandbox=""');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
  });

  it('lists the pages at the plugin root and answers not-found for unknown plugins, routes and admin-only kinds', () => {
    const root = renderRoute('/panel/plugins/net.whm.sample-notes');
    expect(root).toContain('<h1>Sample Notes</h1>');
    expect(root).toContain('/panel/plugins/net.whm.sample-notes/embed');
    expect(renderRoute('/panel/plugins/net.example.nothere/x')).toContain('No installed plugin has the id net.example.nothere.');
    expect(renderRoute('/panel/plugins/net.whm.sample-notes/nope')).toContain('Plugin page not found');
    const admin = { ...plugin, pages: [{ route: '/settings', title: 'Settings', kind: 'settings' }] };
    expect(renderRoute('/panel/plugins/net.whm.sample-notes/settings', pluginCtx({ plugins: [admin], entries: [] }))).toContain('not available in the account panel');
    expect(renderRoute('/panel/plugins/net.whm.sample-notes/help', pluginCtx({ plugins: [], entries: [], loading: true }))).toContain('Loading');
  });
});
