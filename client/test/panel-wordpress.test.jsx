import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

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
const { PANEL_FUNCTION_BY_KEY, PANEL_CATEGORY_BY_SLUG, visibleCategories } = await import('../src/panel/nav.js');
const { PANEL_ICONS, panelColorFor } = await import('../src/panel/icons.js');
const { default: WordPress, pathProblem, siteLabel, hostState, jobStreamPath } = await import('../src/pages/panel/software/wordpress.jsx');
const { PANEL_PAGE_REGISTRY } = await import('../src/panel/registry.js');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: {}, features: {}, limits: {}, contactEmail: 'owner@demo.example.com', domains: [{ domain: 'blog.demo.example.com', type: 'sub', docroot: '/home/demo/public_html/blog' }] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctxFor = (over = {}) => ({ me: { ...me, ...over }, loading: false, error: null, reload: () => {}, hasFeature: () => true });
const fn = PANEL_FUNCTION_BY_KEY['panel:software/wordpress'];
const render = (el, path, ctx = ctxFor()) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });
const ready = { wpcli: false, php: true, phpMysql: true, unzip: true, asUser: true, canInstall: true, hint: null };
const meta = (requirements = ready) => ({ total: 1, requirements, canInstall: requirements.canInstall, hint: requirements.hint, updates: requirements.wpcli, sites: [{ domain: 'demo.example.com', type: 'main', docroot: 'public_html' }, { domain: 'blog.demo.example.com', type: 'sub', docroot: 'public_html/blog' }], prefix: 'demo_' });
const rows = [
  { id: 'a1b2c3d4e5f60718', path: 'public_html/blog', domain: 'demo.example.com', under: 'blog', url: 'https://demo.example.com/blog', adminUrl: 'https://demo.example.com/blog/wp-admin/', version: '6.9', database: 'demo_wp', dbUser: 'demo_wp', dbHost: 'localhost', tablePrefix: 'wp_', isDocroot: false, databaseOwned: true },
  { id: '0f0e0d0c0b0a0908', path: 'public_html', domain: 'demo.example.com', under: '', url: 'http://demo.example.com', adminUrl: 'http://demo.example.com/wp-admin/', version: null, database: 'other_db', dbUser: 'other_u', dbHost: 'localhost', tablePrefix: 'wp_', isDocroot: true, databaseOwned: false },
];

describe('nav entry of the Software group', () => {
  it('is registered with its plan feature, page, icon and colour', () => {
    expect(fn).toMatchObject({ feature: 'wordpress', path: '/panel/software/wordpress', categorySlug: 'software' });
    expect(PANEL_CATEGORY_BY_SLUG.software.icon).toBe('Package');
    expect(PANEL_ICONS.Package).toBeTruthy();
    expect(panelColorFor('software')).not.toBe(panelColorFor('nothing'));
    expect(PANEL_PAGE_REGISTRY['panel:software/wordpress']).toBeTruthy();
    expect(visibleCategories({ wordpress: false }).some((c) => c.slug === 'software')).toBe(false);
    expect(visibleCategories({}).some((c) => c.slug === 'software')).toBe(true);
    expect(jobStreamPath(12)).toBe('/panel/software/wordpress/jobs/12/stream');
  });
});

describe('WordPress page', () => {
  it('renders the install form with the account domains and the installs table', () => {
    fixtures.responses.clear();
    set('/panel/software/wordpress', { data: rows, meta: meta() });
    const html = render(h(WordPress, { fn }), fn.path);
    expect(html).toContain('<h1>WordPress</h1>');
    expect(html).toContain('id="wp-domain"');
    expect(html).toContain('demo.example.com (main domain)</option>');
    expect(html).toContain('<option value="blog.demo.example.com">blog.demo.example.com (subdomain)</option>');
    expect(html).toContain('id="wp-path"');
    expect(html).toContain('value="owner@demo.example.com"');
    expect(html).toContain('Generate one for me');
    expect(html).toContain('Downloaded from wordpress.org');
    expect(html).toContain('demo.example.com/blog</a>');
    expect(html).toContain('<code>6.9</code>');
    expect(html).toContain('<code>demo_wp</code>');
    expect(html).toContain('not one of this account&#x27;s databases');
    expect(html).toContain('>Open admin<');
    expect(html).toContain('update from each site');
    expect(html).toContain('>Incomplete<');
  });

  it('says what the host is missing and disables the form; with WP-CLI it offers updates', () => {
    fixtures.responses.clear();
    set('/panel/software/wordpress', { data: [], meta: meta({ ...ready, php: false, phpMysql: null, canInstall: false, hint: 'Install WP-CLI or php-mysql and unzip' }) });
    let html = render(h(WordPress, { fn }), fn.path);
    expect(html).toContain('cannot be installed on this server yet');
    expect(html).toContain('Install WP-CLI or php-mysql and unzip');
    expect(html).toMatch(/id="wp-title"[^>]*disabled=""/);
    expect(html).toContain('No WordPress installation found');
    set('/panel/software/wordpress', { data: rows.slice(0, 1), meta: meta({ ...ready, wpcli: true }) });
    html = render(h(WordPress, { fn }), fn.path);
    expect(html).toContain('Installed with WP-CLI');
    expect(html).not.toContain('needs WP-CLI');
    expect(html).not.toContain('update from each site');
  });

  it('renders the plan state and the capability state', () => {
    fixtures.responses.clear();
    set('/panel/software/wordpress', { error: { status: 403, code: 'feature_disabled', message: 'Your hosting package does not include it' } });
    expect(render(h(WordPress, { fn }), fn.path)).toContain('Not included in your plan');
    set('/panel/software/wordpress', { error: { status: 501, code: 'capability_missing', message: 'setpriv is not installed on this server' } });
    const html = render(h(WordPress, { fn }), fn.path);
    expect(html).toContain('Not available on this server');
    expect(html).toContain('setpriv is not installed on this server');
  });

  it('pathProblem, siteLabel and hostState check shapes without the server', () => {
    expect(pathProblem('')).toBe(null);
    expect(pathProblem('blog')).toBe(null);
    expect(pathProblem('/blog/')).toBe(null);
    expect(pathProblem('sites/one_two.three-4')).toBe(null);
    expect(pathProblem('../etc')).toMatch(/cannot contain|letters/);
    expect(pathProblem('a/../b')).toMatch(/cannot contain/);
    expect(pathProblem('a/./b')).toMatch(/cannot contain/);
    expect(pathProblem('blog post')).toMatch(/letters/);
    expect(pathProblem('x'.repeat(201))).toMatch(/200/);
    expect(siteLabel(rows[0])).toBe('demo.example.com/blog');
    expect(siteLabel(rows[1])).toBe('demo.example.com');
    expect(hostState(null)).toEqual({ canInstall: false, canUpdate: false, hint: null, method: 'web' });
    expect(hostState(meta({ ...ready, wpcli: true }))).toMatchObject({ canInstall: true, canUpdate: true, method: 'wpcli' });
    expect(hostState(meta({ ...ready, unzip: false, canInstall: false, hint: 'x' }))).toMatchObject({ canInstall: false, canUpdate: false, hint: 'x' });
  });
});
