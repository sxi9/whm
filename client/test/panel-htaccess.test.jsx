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
const { PANEL_FUNCTION_BY_KEY, PANEL_CATEGORY_BY_SLUG } = await import('../src/panel/nav.js');
const { PANEL_ICONS } = await import('../src/panel/icons.js');
const { default: IpBlocker, ipProblem, describeEntry } = await import('../src/pages/panel/security/ip-blocker.jsx');
const { default: DirectoryPrivacy, userProblem, REALM_RE } = await import('../src/pages/panel/files/directory-privacy.jsx');
const { default: Indexes, INDEX_OPTIONS, indexLabel } = await import('../src/pages/panel/files/indexes.jsx');
const { default: ErrorPages, pageState, CODE_HELP } = await import('../src/pages/panel/advanced/error-pages.jsx');
const { folderFromParams, DEFAULT_FOLDER } = await import('../src/pages/panel/files/parts/FolderPicker.jsx');
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

describe('nav entries of the .htaccess family', () => {
  it('are registered with their plan features, pages and group icon', () => {
    expect(fn('security/ip-blocker')).toMatchObject({ feature: 'ipblocker', path: '/panel/security/ip-blocker' });
    expect(fn('files/directory-privacy')).toMatchObject({ feature: 'dirprivacy', path: '/panel/files/directory-privacy' });
    expect(fn('files/indexes')).toMatchObject({ feature: 'indexmanager', path: '/panel/files/indexes' });
    expect(fn('advanced/error-pages')).toMatchObject({ feature: 'errpgs', path: '/panel/advanced/error-pages' });
    expect(PANEL_CATEGORY_BY_SLUG.advanced.icon).toBe('Wrench');
    expect(PANEL_ICONS.Wrench).toBeTruthy();
    for (const key of ['panel:security/ip-blocker', 'panel:files/directory-privacy', 'panel:files/indexes', 'panel:advanced/error-pages']) expect(PANEL_PAGE_REGISTRY[key], key).toBeTruthy();
  });
});

describe('IP blocker page', () => {
  it('lists blocked entries with their kind and the add form', () => {
    fixtures.responses.clear();
    set('/panel/security/ip-blocker', { data: { path: 'public_html', domain: 'demo.example.com', denyIps: ['203.0.113.9', '10.0.0.0/8', '2001:db8::/32'], max: 500 } });
    const html = render(h(IpBlocker, { fn: fn('security/ip-blocker') }), fn('security/ip-blocker').path);
    expect(html).toContain('<h1>IP blocker</h1>');
    expect(html).toContain('id="ip-entry"');
    expect(html).toContain('<code>203.0.113.9</code>');
    expect(html).toContain('IPv4 range · /8');
    expect(html).toContain('IPv6 range · /32');
    expect(html).toContain('3 of 500 entries');
    expect(html).toContain('>Unblock<');
    expect(html).toContain('public_html/.htaccess');
  });

  it('renders the plan state and the capability state', () => {
    fixtures.responses.clear();
    set('/panel/security/ip-blocker', { error: disabled });
    expect(render(h(IpBlocker, { fn: fn('security/ip-blocker') }), fn('security/ip-blocker').path)).toContain('Not included in your plan');
    set('/panel/security/ip-blocker', { error: { status: 501, code: 'capability_missing', message: 'setpriv is not installed on this server' } });
    const html = render(h(IpBlocker, { fn: fn('security/ip-blocker') }), fn('security/ip-blocker').path);
    expect(html).toContain('Not available on this server');
    expect(html).toMatch(/id="ip-entry"[^>]*disabled=""/);
  });

  it('ipProblem and describeEntry check the shape of an entry', () => {
    expect(ipProblem('203.0.113.9')).toBe(null);
    expect(ipProblem('203.0.113.0/24')).toBe(null);
    expect(ipProblem('2001:db8::/32')).toBe(null);
    expect(ipProblem('203.0.113.0/33')).toMatch(/between 0 and 32/);
    expect(ipProblem('example.com')).toMatch(/IPv4 or IPv6/);
    expect(ipProblem('1.2.3.4/8/9')).toMatch(/one range/);
    expect(ipProblem('1.2.3.4 ; rm -rf /')).toMatch(/IPv4 or IPv6/);
    expect(describeEntry('1.2.3.4')).toBe('One IPv4 address');
    expect(describeEntry('fe80::1')).toBe('One IPv6 address');
    expect(describeEntry('10.0.0.0/8')).toBe('IPv4 range · /8');
  });
});

describe('Indexes page', () => {
  it('reads the folder from ?path=, shows the current rule and the three choices', () => {
    fixtures.responses.clear();
    set('/panel/files/indexes?path=public_html%2Fdownloads', { data: { path: 'public_html/downloads', domain: 'demo.example.com', indexes: 'off', managed: true } });
    const html = render(h(Indexes, { fn: fn('files/indexes') }), '/panel/files/indexes?path=public_html/downloads');
    expect(html).toContain('<h1>Indexes</h1>');
    expect(html).toContain('value="public_html/downloads"');
    expect(html).toContain('~/public_html/downloads');
    expect(html).toContain('No indexing');
    expect(html).toContain('Show the file list');
    expect(html).toContain('Server default');
    expect(html).toContain('href="/panel/files/file-manager?path=public_html%2Fdownloads"');
    expect(html).toContain('<input type="radio" name="indexes" checked=""/><span><strong>No indexing</strong>');
  });

  it('defaults to public_html and explains a 422', () => {
    fixtures.responses.clear();
    set('/panel/files/indexes?path=public_html', { error: { status: 422, code: 'validation_error', message: 'Request validation failed', fields: { path: ['The folder must be inside one of your document roots'] } } });
    const html = render(h(Indexes, { fn: fn('files/indexes') }), fn('files/indexes').path);
    expect(html).toContain('Choose a folder inside <code>public_html</code>');
    expect(folderFromParams(new URLSearchParams(''))).toBe(DEFAULT_FOLDER);
    expect(folderFromParams(new URLSearchParams('path=../etc'))).toBe(DEFAULT_FOLDER);
    expect(folderFromParams(new URLSearchParams('path=public_html/a/'))).toBe('public_html/a');
    expect(INDEX_OPTIONS.map((o) => o.value)).toEqual(['inherit', 'off', 'on']);
    expect(indexLabel('on')).toBe('Show the file list');
  });

  it('renders the plan state when the feature is off', () => {
    fixtures.responses.clear();
    set('/panel/files/indexes?path=public_html', { error: disabled });
    expect(render(h(Indexes, { fn: fn('files/indexes') }), fn('files/indexes').path)).toContain('Not included in your plan');
  });
});

describe('Directory privacy page', () => {
  it('shows the protection state, the users and the add-user form', () => {
    fixtures.responses.clear();
    set('/panel/files/privacy?path=public_html%2Fprivate', { data: { path: 'public_html/private', domain: 'demo.example.com', protected: true, realm: 'Members only', users: ['alice', 'bob'], max: 200, managed: true } });
    const html = render(h(DirectoryPrivacy, { fn: fn('files/directory-privacy') }), '/panel/files/directory-privacy?path=public_html/private');
    expect(html).toContain('<h1>Directory privacy</h1>');
    expect(html).toContain('Password required');
    expect(html).toMatch(/id="dp-realm"[^>]*value="Members only"/);
    expect(html).toContain('<code>alice</code>');
    expect(html).toContain('<code>bob</code>');
    expect(html).toContain('2 of 200 users');
    expect(html).toContain('id="dp-user"');
    expect(html).toContain('id="dp-password"');
    expect(html).toMatch(/autoComplete="new-password"/i);
    expect(html).toContain('>Remove<');
    expect(html).toContain('.keel/htpasswd/');
  });

  it('shows an open folder with the realm field disabled until protection is on', () => {
    fixtures.responses.clear();
    set('/panel/files/privacy?path=public_html', { data: { path: 'public_html', domain: 'demo.example.com', protected: false, realm: 'Restricted area', users: [], max: 200, managed: false } });
    const html = render(h(DirectoryPrivacy, { fn: fn('files/directory-privacy') }), fn('files/directory-privacy').path);
    expect(html).toContain('Open to everyone');
    expect(html).toMatch(/id="dp-realm"[^>]*disabled=""/);
    expect(html).toContain('No users yet');
  });

  it('userProblem and REALM_RE guard the inputs', () => {
    expect(userProblem('alice', 'longenough')).toBe(null);
    expect(userProblem('al ice', 'longenough')).toHaveProperty('user');
    expect(userProblem('alice:x', 'longenough')).toHaveProperty('user');
    expect(userProblem('alice', 'short')).toHaveProperty('password');
    expect(REALM_RE.test('Members only')).toBe(true);
    expect(REALM_RE.test('Say "hi"')).toBe(false);
    expect(REALM_RE.test('two\nlines')).toBe(false);
    expect(REALM_RE.test('back\\slash')).toBe(false);
  });
});

describe('Error pages page', () => {
  it('lists the six responses of the chosen domain with their state and actions', () => {
    fixtures.responses.clear();
    set('/panel/domains', { data: [{ domain: 'demo.example.com', type: 'main' }, { domain: 'blog.demo.example.com', type: 'sub' }, { domain: 'alias.example', type: 'parked' }] });
    set('/panel/advanced/error-pages?domain=demo.example.com', { data: { domain: 'demo.example.com', docroot: 'public_html', pages: [
      { code: '400', label: 'Bad request', exists: false, managed: false, title: '', message: '', active: false },
      { code: '401', label: 'Authorisation required', exists: false, managed: false, title: '', message: '', active: false },
      { code: '403', label: 'Forbidden', exists: true, managed: false, title: '', message: '', active: false },
      { code: '404', label: 'Not found', exists: true, managed: true, title: 'Lost?', message: 'Try the home page.', active: true },
      { code: '500', label: 'Internal server error', exists: true, managed: false, title: '', message: '', active: true },
      { code: '503', label: 'Service unavailable', exists: false, managed: false, title: '', message: '', active: false },
    ] } });
    const html = render(h(ErrorPages, { fn: fn('advanced/error-pages') }), '/panel/advanced/error-pages?domain=demo.example.com');
    expect(html).toContain('<h1>Error pages</h1>');
    expect(html).toContain('<option value="demo.example.com" selected="">demo.example.com</option>');
    expect(html).toContain('blog.demo.example.com (subdomain)');
    expect(html).not.toContain('alias.example');
    expect(html).toContain('~/public_html/errors/');
    expect(html).toContain('Custom page');
    expect(html).toContain('Your own file');
    expect(html).toContain('File present, not used');
    expect(html).toContain('Lost?');
    expect(html).toContain('>Create<');
    expect(html).toContain('>Edit<');
    expect(html).toContain('aria-label="More actions"');
    expect((html.match(/aria-label="More actions"/g) || []).length).toBe(3);
    expect(Object.keys(CODE_HELP)).toEqual(['400', '401', '403', '404', '500', '503']);
  });

  it('pageState maps the file and ErrorDocument flags', () => {
    expect(pageState({ exists: false, active: false, managed: false })).toMatchObject({ label: 'Server default' });
    expect(pageState({ exists: true, active: true, managed: true })).toMatchObject({ status: 'ok', label: 'Custom page' });
    expect(pageState({ exists: true, active: true, managed: false })).toMatchObject({ label: 'Your own file' });
    expect(pageState({ exists: true, active: false, managed: false })).toMatchObject({ status: 'pending' });
  });

  it('renders the plan state when the feature is off', () => {
    fixtures.responses.clear();
    set('/panel/domains', { data: [{ domain: 'demo.example.com', type: 'main' }] });
    set('/panel/advanced/error-pages?domain=demo.example.com', { error: disabled });
    expect(render(h(ErrorPages, { fn: fn('advanced/error-pages') }), '/panel/advanced/error-pages?domain=demo.example.com')).toContain('Not included in your plan');
  });
});
