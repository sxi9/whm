import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';

const authState = { user: { id: 1, username: 'root', role: 'root' } };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: authState.user, refresh: async () => {} }) }));

// The page reads through useApi; the mock answers by path so each render is a
// deterministic snapshot of one server state.
const responses = new Map();
const requested = [];
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!enabled || !path) return { data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
    requested.push(path);
    const hit = [...responses.entries()].find(([k]) => path.startsWith(k));
    const r = hit ? hit[1] : null;
    return { data: r?.data ?? null, meta: r?.meta ?? null, error: r?.error ?? null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const Customization = (await import('../src/pages/fn/cpanel/customization.jsx')).default;
const { TABS, ACCOUNT_PANEL_HASH, LOGIN_AS_TTL, ttlError, webmailUrlError, loginAsStatus, AccountPanelSettingsCard, LoginAsHistoryCard } = await import('../src/pages/fn/cpanel/customization.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el, { initialEntries } = {}) => renderToStaticMarkup(
  <ToastProvider><ConfirmProvider><MemoryRouter initialEntries={initialEntries}>{el}</MemoryRouter></ConfirmProvider></ToastProvider>,
);

const fn = FUNCTION_BY_KEY['cpanel/customization'];
const branding = { companyName: 'Keel', tagline: 'Hosting control panel', primaryColor: '', chromeColor: '', helpUrl: '', docsUrl: '', supportUrl: '', loginNotice: '', footerText: '', logo: null, favicon: null };
const settings = { enabled: true, require2faForUsers: false, loginAsTtlMinutes: 60, loginAsAcl: 'login-as', webmailUrl: 'https://webmail.example.com/', uploadChunkBytes: 1310720 };
const history = [
  { id: 1, started_at: '2026-11-01T10:00:00Z', expires_at: '2026-11-01T11:00:00Z', ended_at: '2026-11-01T10:20:00Z', ip: '203.0.113.5', actor: 'root', account: 'alice', active: false },
  { id: 2, started_at: '2026-11-02T09:00:00Z', expires_at: '2999-01-01T00:00:00Z', ended_at: null, ip: '203.0.113.6', actor: 'resell1', account: 'bob', active: true },
  { id: 3, started_at: '2026-10-30T09:00:00Z', expires_at: '2026-10-30T10:00:00Z', ended_at: null, ip: '203.0.113.7', actor: 'root', account: 'carol', active: false },
];
responses.set('/cpanel/branding', { data: branding });
responses.set('/panel/admin/settings', { data: settings });
responses.set('/panel/admin/login-as/history', { data: history, meta: { page: 1, pageSize: 25, total: 60 } });

describe('Panel › Customization › Account panel', () => {
  it('is registered in nav.js and opens the Account panel tab on its hash for root', () => {
    expect(fn).toBeTruthy();
    expect(TABS.map((t) => t.value)).toEqual(['branding', 'account-panel']);
    const html = render(<Customization fn={fn} />, { initialEntries: [fn.path] });
    expect(html).toContain('role="tablist"');
    expect(html).toContain('Account panel');
    expect(html).toContain('Company name');
    expect(html).not.toContain('Require 2FA for account users');
    const tab = render(<Customization fn={fn} />, { initialEntries: [`${fn.path}${ACCOUNT_PANEL_HASH}`] });
    expect(tab).toContain('Require 2FA for account users');
    expect(tab).toContain('Log in as history');
    expect(tab).not.toContain('Company name');
  });

  it('hides the Account panel section from resellers', () => {
    authState.user = { id: 2, username: 'resell1', role: 'reseller' };
    requested.length = 0;
    try {
      const html = render(<Customization fn={fn} />, { initialEntries: [`${fn.path}${ACCOUNT_PANEL_HASH}`] });
      expect(html).not.toContain('role="tablist"');
      expect(html).not.toContain('Account panel enabled');
      expect(html).not.toContain('Log in as history');
      expect(html).toContain('Company name');
      expect(requested.some((p) => p.startsWith('/panel/admin/'))).toBe(false);
    } finally {
      authState.user = { id: 1, username: 'root', role: 'root' };
    }
  });

  it('renders the settings from GET /panel/admin/settings with the 5–480 minute bounds', () => {
    const html = render(<AccountPanelSettingsCard />);
    expect(requested).toContain('/panel/admin/settings');
    expect(html).toContain('Account panel enabled');
    expect(html).toContain('Require 2FA for account users');
    expect(html).toContain('type="number"');
    expect(html).toContain(`min="${LOGIN_AS_TTL.min}"`);
    expect(html).toContain(`max="${LOGIN_AS_TTL.max}"`);
    expect(html).toContain('value="60"');
    expect(html).toContain('value="https://webmail.example.com/"');
    expect(html).toContain('<code>login-as</code>');
    expect(html).toContain('>Save<');
    expect(LOGIN_AS_TTL).toEqual({ min: 5, max: 480 });
  });

  it('validates the log-in-as window and the webmail URL like the API does', () => {
    expect(ttlError(5)).toBeNull();
    expect(ttlError(480)).toBeNull();
    expect(ttlError(4)).toMatch(/between 5 and 480/);
    expect(ttlError(481)).toMatch(/between 5 and 480/);
    expect(ttlError(7.5)).toMatch(/whole number/);
    expect(ttlError(null)).toMatch(/minutes/);
    expect(webmailUrlError('')).toBeNull();
    expect(webmailUrlError('https://mail.example.com/')).toBeNull();
    expect(webmailUrlError('ftp://mail.example.com/')).toMatch(/http\(s\)/);
    expect(webmailUrlError('mail.example.com')).toMatch(/http\(s\)/);
  });

  it('lists the login-as history paged by the API with when, admin, account, ended and status', () => {
    const html = render(<LoginAsHistoryCard />);
    const path = requested.find((p) => p.startsWith('/panel/admin/login-as/history'));
    expect(path).toContain('page=1');
    expect(path).toContain('pageSize=25');
    expect(path).toContain('sort=started_at');
    expect(path).toContain('dir=desc');
    for (const h of ['When', 'Admin', 'Account', 'Ended', 'Status']) expect(html).toContain(`<span>${h}`);
    expect(html).toContain('alice');
    expect(html).toContain('resell1');
    expect(html).toContain('carol');
    expect(html).toContain('203.0.113.5');
    expect(html).toContain('>Ended<');
    expect(html).toContain('>Active<');
    expect(html).toContain('>Expired<');
    expect(html).toContain('1–25 of 60');
    expect(html).toContain('Page 1 of 3');
    expect(loginAsStatus(history[0]).label).toBe('Ended');
    expect(loginAsStatus(history[1]).label).toBe('Active');
    expect(loginAsStatus(history[2]).label).toBe('Expired');
  });
});
