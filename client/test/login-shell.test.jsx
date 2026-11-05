import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: null, ready: true, refresh: async () => {}, login: async () => ({}), verify2fa: async () => ({}) }) }));

// The branding mock decides which listener the page believes it is served by.
const brandingState = { shell: 'admin' };
vi.mock('../src/pages/cpanel/branding.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, useBranding: () => ({ ...mod.DEFAULT_BRANDING, ...brandingState }) };
});

const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!enabled || !path) return { data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
    const hit = [...responses.entries()].find(([k]) => path.startsWith(k));
    return { data: hit ? hit[1] : null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { LoginPage, WrongPortBanner } = await import('../src/pages/Login.jsx');
const { ApiError } = await import('../src/api/client.js');
const { landingFor, homePathFor } = await import('../src/auth/home.js');
const { AccountPanelSettingsCard } = await import('../src/pages/fn/cpanel/customization.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el, initialEntries = ['/login']) => renderToStaticMarkup(
  <ToastProvider><ConfirmProvider><MemoryRouter initialEntries={initialEntries}>{el}</MemoryRouter></ConfirmProvider></ToastProvider>,
);

describe('Login page per shell', () => {
  it('says "Account panel" on the panel listener and the tagline on the admin one', () => {
    brandingState.shell = 'admin';
    const admin = render(<LoginPage />);
    expect(admin).toContain('Hosting control panel');
    expect(admin).not.toContain('Account panel');
    brandingState.shell = 'panel';
    const panel = render(<LoginPage />);
    expect(panel).toContain('Keel · Account panel');
    expect(panel).toContain('Sign in to your account');
    expect(panel).not.toContain('Hosting control panel');
  });

  it('lands on /panel for every role on the panel shell, admin home otherwise', () => {
    expect(homePathFor({ role: 'root' }, 'panel')).toBe('/panel');
    expect(homePathFor({ role: 'reseller' }, 'panel')).toBe('/panel');
    expect(homePathFor({ role: 'user' }, 'panel')).toBe('/panel');
    expect(homePathFor({ role: 'root' }, 'admin')).toBe('/');
    expect(landingFor({ role: 'root' }, '/packages/add-a-package', 'panel')).toBe('/panel');
    expect(landingFor({ role: 'user' }, '/panel/email/accounts', 'panel')).toBe('/panel/email/accounts');
    expect(landingFor({ role: 'root' }, '/packages/add-a-package', 'admin')).toBe('/packages/add-a-package');
    expect(landingFor({ role: 'root' }, '/packages/add-a-package')).toBe('/packages/add-a-package');
  });

  it('a wrong_port error carries the admin URL and renders it as a link', () => {
    const err = new ApiError(403, { error: { code: 'wrong_port', message: 'Administrators and resellers sign in on port 2087', adminUrl: 'https://nova.example.com:2087/login' } });
    expect(err.code).toBe('wrong_port');
    expect(err.adminUrl).toBe('https://nova.example.com:2087/login');
    const html = renderToStaticMarkup(<WrongPortBanner error={err} />);
    expect(html).toContain('Administrators and resellers sign in on port 2087');
    expect(html).toContain('href="https://nova.example.com:2087/login"');
    expect(html).toContain('Go to the administration sign-in');
    const unsafe = renderToStaticMarkup(<WrongPortBanner error={new ApiError(403, { error: { code: 'wrong_port', message: 'x', adminUrl: 'javascript:alert(1)' } })} />);
    expect(unsafe).not.toContain('href=');
  });

  it('after an external login refused on the panel shell (?error=wrong_port) shows the message and the admin link from the branding, never from the query string', () => {
    brandingState.shell = 'panel';
    brandingState.adminUrl = 'https://nova.example.com:2087/login';
    const url = '/login?error=wrong_port&message=Administrators%20and%20resellers%20sign%20in%20on%20port%202087&adminUrl=https%3A%2F%2Fevil.example%2Flogin';
    const html = render(<LoginPage />, [url]);
    expect(html).toContain('Administrators and resellers sign in on port 2087');
    expect(html).not.toContain('Sign-in failed.');
    expect(html).toContain('href="https://nova.example.com:2087/login"');
    expect(html).toContain('Go to the administration sign-in');
    expect(html).not.toContain('evil.example');
    const bare = render(<LoginPage />, ['/login?error=wrong_port']);
    expect(bare).toContain('Administrators and resellers sign in on the administration port.');
    expect(bare).toContain('href="https://nova.example.com:2087/login"');
    delete brandingState.adminUrl;
    const noLink = render(<LoginPage />, [url]);
    expect(noLink).toContain('Administrators and resellers sign in on port 2087');
    expect(noLink).not.toContain('Go to the administration sign-in');
    brandingState.shell = 'admin';
  });
});

describe('Admin › Account panel settings', () => {
  it('shows the account sign-in URL when the session carries panelUrl', () => {
    responses.set('/panel/admin/settings', { enabled: true, require2faForUsers: false, loginAsTtlMinutes: 60, loginAsAcl: 'login-as', webmailUrl: '' });
    responses.set('/auth/me', { user: { id: 1, role: 'root' }, shell: 'admin', panelUrl: 'https://nova.example.com:2083/' });
    const html = render(<AccountPanelSettingsCard />, ['/cpanel/customization']);
    expect(html).toContain('Account sign-in URL');
    expect(html).toContain('href="https://nova.example.com:2083/"');
    responses.delete('/auth/me');
    const without = render(<AccountPanelSettingsCard />, ['/cpanel/customization']);
    expect(without).not.toContain('Account sign-in URL');
  });
});
