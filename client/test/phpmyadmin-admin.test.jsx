import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const fixtures = vi.hoisted(() => ({ responses: new Map(), role: 'root', table: {} }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: fixtures.role }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));
vi.mock('../src/api/client.js', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }, queryString: () => '' }));
// The row menu only renders its items once opened, so the table hands its
// rowActions back for the test to call.
vi.mock('../src/components/DataTable.jsx', () => ({
  DataTable: (props) => { fixtures.table.rowActions = props.rowActions; return h('table', null); },
  useTableState: () => ({ state: { page: 1, pageSize: 50, q: '', sort: 'username', dir: 'asc' }, setPage: () => {}, setSearch: () => {}, setSort: () => {}, set: () => {} }),
}));

const { api } = await import('../src/api/client.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { FUNCTION_BY_KEY } = await import('../src/nav.js');
const { default: PhpMyAdmin, openPhpMyAdminAs } = await import('../src/pages/fn/database-services/phpmyadmin.jsx');
const { AccountsTable } = await import('../src/pages/accounts/AccountsTable.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(h(ToastProvider, null, h(ConfirmProvider, null, h(MemoryRouter, null, el))));
const fn = FUNCTION_BY_KEY['database-services/phpmyadmin'];

const detected = { installed: true, version: '5.2.1', dir: '/usr/share/phpmyadmin', configFile: '/etc/phpmyadmin/config.inc.php', urlPath: '/phpmyadmin', url: 'https://panel.example.com/phpmyadmin/', php: true, featureEnabled: true, urlOverride: '', hostname: 'panel.example.com', webConfigs: [] };

beforeEach(() => {
  api.post.mockReset();
  fixtures.role = 'root';
  fixtures.responses.clear();
  fixtures.responses.set('/accounts?pageSize=500&sort=username', { data: [{ username: 'alice', domain: 'alice.com', owner: 'root' }], loading: false });
});

describe('Database Services › phpMyAdmin (administration shell)', () => {
  it('with single sign-on on, root gets the all-databases button and the open-as-account picker', () => {
    fixtures.responses.set('/databases/phpmyadmin', { data: { ...detected, sso: true }, loading: false });
    const html = render(h(PhpMyAdmin, { fn }));
    expect(html).toContain(fn.label);
    expect(html).toContain('Open phpMyAdmin (all databases)');
    expect(html).toContain('data-open-all="1"');
    expect(html).toContain('Open as an account');
    expect(html).toContain('data-open-as="1"');
    expect(html).toContain('alice — alice.com');
    expect(html).toContain('links open signed in');
    expect(html).not.toContain('Single sign-on is off');
  });

  it('with single sign-on off, the plain link stays and root is told which switch to turn on', () => {
    fixtures.responses.set('/databases/phpmyadmin', { data: { ...detected, sso: false }, loading: false });
    const html = render(h(PhpMyAdmin, { fn }));
    expect(html).toContain('href="https://panel.example.com/phpmyadmin/"');
    expect(html).toContain('Open phpMyAdmin</a>');
    expect(html).not.toContain('all databases');
    expect(html).not.toContain('Open as an account');
    expect(html).toContain('Single sign-on is off');
    expect(html).toContain('/cpanel/customization');
    expect(html).toContain('URL override');
  });

  it('a reseller never sees the administrator button, only the plain link and the account picker', () => {
    fixtures.role = 'reseller';
    fixtures.responses.set('/databases/phpmyadmin', { data: { installed: true, version: '5.2.1', url: 'https://panel.example.com/phpmyadmin/', php: true, featureEnabled: true, sso: true }, loading: false });
    const html = render(h(PhpMyAdmin, { fn }));
    expect(html).not.toContain('all databases');
    expect(html).toContain('Open phpMyAdmin</a>');
    expect(html).toContain('Open as an account');
    expect(html).not.toContain('URL override');
  });

  it('openPhpMyAdminAs posts the account (or nothing) and navigates the window it opened first; it closes it on failure', async () => {
    api.post.mockResolvedValueOnce({ data: { url: 'https://panel.example.com/keel/pma-signon.php?_keel=tok1', user: 'keel_pma_admin', account: null, grantOption: true } });
    const opened = [];
    const w = { close: vi.fn() };
    const r = await openPhpMyAdminAs({ open: (url, win) => opened.push([url, win]), win: () => w });
    expect(api.post).toHaveBeenCalledWith('/databases/phpmyadmin/open', {});
    expect(opened).toEqual([['https://panel.example.com/keel/pma-signon.php?_keel=tok1', w]]);
    expect(r.user).toBe('keel_pma_admin');
    api.post.mockResolvedValueOnce({ data: { url: 'https://panel.example.com/keel/pma-signon.php?_keel=tok2', user: 'alice_pma', account: 'alice' } });
    await openPhpMyAdminAs({ account: 'alice', open: (url, win) => opened.push([url, win]), win: () => w });
    expect(api.post).toHaveBeenLastCalledWith('/databases/phpmyadmin/open', { account: 'alice' });
    expect(opened[1][0]).toContain('_keel=tok2');
    expect(w.close).not.toHaveBeenCalled();
    api.post.mockRejectedValueOnce(Object.assign(new Error('phpMyAdmin single sign-on is switched off'), { status: 409 }));
    await expect(openPhpMyAdminAs({ account: 'alice', open: () => { throw new Error('must not navigate'); }, win: () => w })).rejects.toThrow('switched off');
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it('List Accounts has a phpMyAdmin row action that opens the account\'s own sign-on in a new tab', async () => {
    fixtures.responses.set('/accounts', { data: [{ username: 'alice', domain: 'alice.com', owner: 'root', suspended: 0 }], meta: { total: 1 }, loading: false });
    render(h(AccountsTable, {}));
    const actions = fixtures.table.rowActions({ username: 'alice', domain: 'alice.com', suspended: 0 });
    const labels = actions.map((a) => a.label);
    expect(labels).toContain('phpMyAdmin');
    expect(labels.indexOf('phpMyAdmin')).toBe(labels.indexOf('Log in as') + 1);
    const popup = { close: vi.fn() };
    const previous = globalThis.window;
    globalThis.window = { open: vi.fn(() => popup), location: { assign: vi.fn() } };
    try {
      api.post.mockResolvedValueOnce({ data: { url: 'https://panel.example.com/keel/pma-signon.php?_keel=tok3', user: 'alice_pma', account: 'alice' } });
      await actions.find((a) => a.label === 'phpMyAdmin').onClick();
      expect(api.post).toHaveBeenCalledWith('/databases/phpmyadmin/open', { account: 'alice' });
      expect(globalThis.window.open).toHaveBeenCalledWith('about:blank', '_blank');
      expect(popup.location).toBe('https://panel.example.com/keel/pma-signon.php?_keel=tok3');
      expect(popup.opener).toBeNull();
      expect(globalThis.window.location.assign).not.toHaveBeenCalled();
    } finally { globalThis.window = previous; }
  });

  it('opens the popup without the noopener feature (which makes window.open return null) and never navigates the shell while a popup exists', async () => {
    const previous = globalThis.window;
    // A browser per the HTML spec: a `noopener` feature returns null, a plain open returns the handle.
    const popup = { close: vi.fn(), opener: {} };
    globalThis.window = { open: vi.fn((url, target, features) => (features ? null : popup)), location: { assign: vi.fn() } };
    try {
      api.post.mockResolvedValueOnce({ data: { url: 'https://panel.example.com/keel/pma-signon.php?_keel=tok4', user: 'keel_pma_admin', account: null } });
      await openPhpMyAdminAs();
      expect(globalThis.window.open).toHaveBeenCalledTimes(1);
      expect(globalThis.window.open.mock.calls[0]).toHaveLength(2);
      expect(popup.opener).toBeNull();
      expect(popup.location).toBe('https://panel.example.com/keel/pma-signon.php?_keel=tok4');
      expect(globalThis.window.location.assign).not.toHaveBeenCalled();
      // A failed request closes the popup, and the shell still stays where it is.
      api.post.mockRejectedValueOnce(Object.assign(new Error('switched off'), { status: 409 }));
      await expect(openPhpMyAdminAs({ account: 'alice' })).rejects.toThrow('switched off');
      expect(popup.close).toHaveBeenCalledTimes(1);
      expect(globalThis.window.location.assign).not.toHaveBeenCalled();
      // Only a blocked popup (no handle at all) falls back to navigating the shell.
      globalThis.window.open = vi.fn(() => null);
      api.post.mockResolvedValueOnce({ data: { url: 'https://panel.example.com/keel/pma-signon.php?_keel=tok5', user: 'alice_pma', account: 'alice' } });
      await openPhpMyAdminAs({ account: 'alice' });
      expect(globalThis.window.location.assign).toHaveBeenCalledWith('https://panel.example.com/keel/pma-signon.php?_keel=tok5');
    } finally { globalThis.window = previous; }
  });
});
