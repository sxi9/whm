import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// Forced 2FA for account users as a core policy (P3-3): the switch sits next to
// the root/reseller ones in both admin pages, and the account-panel settings
// card says the core switch exists.
const fixtures = vi.hoisted(() => ({ responses: new Map(), user: { id: 1, username: 'root', role: 'root', totpEnabled: true, mustEnroll2fa: false } }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: fixtures.user, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: false, refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { default: ConfigureSecurityPolicies } = await import('../src/pages/fn/security-center/configure-security-policies.jsx');
const { default: TwoFactor } = await import('../src/pages/security/TwoFactor.jsx');

React.useLayoutEffect = React.useEffect;
const fn = { key: 'security-center/two-factor-authentication', label: 'Two-Factor Authentication', description: '' };
const render = (el) => renderToStaticMarkup(h(MemoryRouter, null, h(ToastProvider, null, h(ConfirmProvider, null, el))));

describe('Forced 2FA for account users (core policy)', () => {
  it('Configure Security Policies lists the users switch next to root and resellers', () => {
    fixtures.responses.set('/system/settings?prefix=security.', { data: { 'security.2fa.required_for_root': false, 'security.policy.require_2fa_for_resellers': false, 'security.2fa.required_for_users': true } });
    const html = render(h(ConfigureSecurityPolicies, { fn: { ...fn, key: 'security-center/configure-security-policies', label: 'Configure Security Policies' } }));
    expect(html).toContain('Require two-factor authentication for root');
    expect(html).toContain('Require two-factor authentication for resellers');
    expect(html).toContain('Require two-factor authentication for account users');
    expect(html).toContain('Panel › Customization');
  });

  it('the Two-Factor Authentication page shows the users switch in the server policy card for root', () => {
    fixtures.responses.set('/system/settings?prefix=security.2fa', { data: { 'security.2fa.required_for_root': true, 'security.2fa.required_for_users': false } });
    const html = render(h(TwoFactor, { fn }));
    expect(html).toContain('Server policy');
    expect(html).toContain('Require two-factor authentication for the root user');
    expect(html).toContain('Require two-factor authentication for account users');
  });
});
