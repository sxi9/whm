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
const { default: OptimizeWebsite, MODES, TYPE_GROUPS, modeLabel, modeOf } = await import('../src/pages/panel/advanced/optimize-website.jsx');
const { default: HotlinkProtection, DEFAULT_EXTENSIONS, EXTENSION_GROUPS, normalizeHost, hostProblem, redirectProblem } = await import('../src/pages/panel/advanced/hotlink-protection.jsx');
const { PANEL_PAGE_REGISTRY } = await import('../src/panel/registry.js');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: {}, features: {}, limits: {}, domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctxFor = (over = {}) => ({ me: { ...me, ...over }, loading: false, error: null, reload: () => {}, hasFeature: () => true });
const fn = (key) => PANEL_FUNCTION_BY_KEY[`panel:${key}`];
const render = (el, path, ctx = ctxFor()) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });
const disabled = { status: 403, code: 'feature_disabled', message: 'Your hosting package does not include it' };
const ALL_TYPES = TYPE_GROUPS.flatMap(([, list]) => list);
const ALL_EXTS = EXTENSION_GROUPS.flatMap(([, list]) => list);

describe('nav entries of Optimize website and Hotlink protection', () => {
  it('sit in the Advanced group with their plan features and registered pages', () => {
    expect(fn('advanced/optimize-website')).toMatchObject({ feature: 'optimizews', path: '/panel/advanced/optimize-website', label: 'Optimize website' });
    expect(fn('advanced/hotlink-protection')).toMatchObject({ feature: 'hotlink', path: '/panel/advanced/hotlink-protection', label: 'Hotlink protection' });
    expect(PANEL_CATEGORY_BY_SLUG.advanced.functions.map((f) => f.slug)).toEqual(expect.arrayContaining(['error-pages', 'optimize-website', 'hotlink-protection']));
    for (const key of ['panel:advanced/optimize-website', 'panel:advanced/hotlink-protection']) expect(PANEL_PAGE_REGISTRY[key], key).toBeTruthy();
    const without = visibleCategories({ optimizews: false, hotlink: false }).find((c) => c.slug === 'advanced');
    expect(without.functions.map((f) => f.slug)).not.toContain('optimize-website');
    expect(without.functions.map((f) => f.slug)).not.toContain('hotlink-protection');
    expect(visibleCategories({}).find((c) => c.slug === 'advanced').functions.map((f) => f.slug)).toContain('hotlink-protection');
  });
});

describe('Optimize website page', () => {
  const path = '/panel/advanced/optimize?path=public_html';

  it('shows the folder, the current mode and the three choices', () => {
    fixtures.responses.clear();
    set(path, { data: { path: 'public_html', domain: 'demo.example.com', mode: 'all', types: ALL_TYPES, available: ALL_TYPES, managed: true } });
    const html = render(h(OptimizeWebsite, { fn: fn('advanced/optimize-website') }), fn('advanced/optimize-website').path);
    expect(html).toContain('<h1>Optimize website</h1>');
    expect(html).toContain('<code>~/public_html</code>');
    expect(html).toContain('demo.example.com');
    expect(html).toContain('Compress all content');
    expect(html).toContain('Compress the selected types');
    expect(html).toContain('Disabled');
    expect(html).toContain('AddOutputFilterByType DEFLATE');
    expect(html).toMatch(/name="optimize"[^>]*checked=""/);
    expect(html).not.toContain('type="checkbox"');
  });

  it('lists the content types grouped when the mode is custom', () => {
    fixtures.responses.clear();
    set(path, { data: { path: 'public_html', domain: 'demo.example.com', mode: 'custom', types: ['text/html', 'text/css'], available: ALL_TYPES, managed: true } });
    const html = render(h(OptimizeWebsite, { fn: fn('advanced/optimize-website') }), fn('advanced/optimize-website').path);
    expect(html).toContain('2 content types');
    expect(html).toContain('Pages and feeds');
    expect(html).toContain('Fonts');
    expect(html).toContain('<code>font/woff2</code>');
    expect((html.match(/type="checkbox"/g) || []).length).toBe(ALL_TYPES.length);
    expect((html.match(/type="checkbox" checked=""/g) || []).length).toBe(2);
  });

  it('renders the plan state and the capability state', () => {
    fixtures.responses.clear();
    set(path, { error: disabled });
    expect(render(h(OptimizeWebsite, { fn: fn('advanced/optimize-website') }), fn('advanced/optimize-website').path)).toContain('Not included in your plan');
    set(path, { error: { status: 501, code: 'capability_missing', message: 'setpriv is not installed on this server' } });
    expect(render(h(OptimizeWebsite, { fn: fn('advanced/optimize-website') }), fn('advanced/optimize-website').path)).toContain('Not available on this server');
  });

  it('helpers: modes, labels and the mode derived from a type list', () => {
    expect(MODES).toEqual(['off', 'all', 'custom']);
    expect(modeLabel('all')).toBe('Compress all content');
    expect(modeLabel('nope')).toBe('Disabled');
    expect(modeOf([], ALL_TYPES)).toBe('off');
    expect(modeOf(ALL_TYPES, ALL_TYPES)).toBe('all');
    expect(modeOf(['text/html'], ALL_TYPES)).toBe('custom');
    expect(new Set(ALL_TYPES).size).toBe(ALL_TYPES.length);
  });
});

describe('Hotlink protection page', () => {
  const path = '/panel/advanced/hotlink';
  const data = { path: 'public_html', domain: 'demo.example.com', enabled: true, hosts: ['partner.example'], extensions: ['jpg', 'png'], allowBlank: true, redirect: 'https://demo.example.com/no.html', domains: ['demo.example.com', 'blog.demo.example.com'], available: ALL_EXTS, defaults: DEFAULT_EXTENSIONS, max: 100, managed: true };

  it('shows the state, the own domains, the extra hosts, the protected types and the redirect', () => {
    fixtures.responses.clear();
    set(path, { data });
    const html = render(h(HotlinkProtection, { fn: fn('advanced/hotlink-protection') }), fn('advanced/hotlink-protection').path);
    expect(html).toContain('<h1>Hotlink protection</h1>');
    expect(html).toContain('>On<');
    expect(html).toMatch(/<code[^>]*>demo\.example\.com<\/code>/);
    expect(html).toMatch(/<code[^>]*>blog\.demo\.example\.com<\/code>/);
    expect(html).toContain('<code>partner.example</code>');
    expect(html).toContain('aria-label="Remove partner.example"');
    expect(html).toContain('id="hl-host"');
    expect(html).toContain('Allow direct requests');
    expect(html).toContain('Protected file types');
    expect(html).toContain('<code>.webp</code>');
    expect((html.match(/type="checkbox" checked=""/g) || []).length).toBe(2 + 2);
    expect(html).toContain('value="https://demo.example.com/no.html"');
    expect(html).toContain('RewriteCond %{HTTP_REFERER}');
  });

  it('renders the off state with the form disabled, the plan state and the capability state', () => {
    fixtures.responses.clear();
    set(path, { data: { ...data, enabled: false, hosts: [], extensions: DEFAULT_EXTENSIONS, redirect: null } });
    const html = render(h(HotlinkProtection, { fn: fn('advanced/hotlink-protection') }), fn('advanced/hotlink-protection').path);
    expect(html).toContain('>Off<');
    expect(html).toMatch(/id="hl-host"[^>]*disabled=""/);
    expect(html).toMatch(/id="hl-redirect"[^>]*disabled=""/);
    set(path, { error: disabled });
    expect(render(h(HotlinkProtection, { fn: fn('advanced/hotlink-protection') }), fn('advanced/hotlink-protection').path)).toContain('Not included in your plan');
    set(path, { error: { status: 501, code: 'capability_missing', message: 'setpriv is not installed on this server' } });
    expect(render(h(HotlinkProtection, { fn: fn('advanced/hotlink-protection') }), fn('advanced/hotlink-protection').path)).toContain('Not available on this server');
  });

  it('helpers: hosts are normalised, redirects are checked for shape and loops', () => {
    expect(normalizeHost(' https://WWW.Partner.Example/path ')).toBe('partner.example');
    expect(hostProblem('partner.example')).toBe(null);
    expect(hostProblem('')).toBe(null);
    expect(hostProblem('partner')).toMatch(/hostname/);
    expect(hostProblem('exa mple.com')).toMatch(/hostname/);
    expect(redirectProblem('', ['jpg'])).toBe(null);
    expect(redirectProblem('https://example.com/no.html', ['jpg'])).toBe(null);
    expect(redirectProblem('/no.html', ['jpg'])).toMatch(/http/);
    expect(redirectProblem('https://example.com/$1', ['jpg'])).toMatch(/http/);
    expect(redirectProblem('https://example.com/a b', ['jpg'])).toMatch(/http/);
    expect(redirectProblem('https://example.com/x.JPG', ['jpg'])).toMatch(/blocked too/);
    expect(DEFAULT_EXTENSIONS.every((e) => ALL_EXTS.includes(e))).toBe(true);
    expect(ALL_EXTS).not.toContain('php');
  });
});
