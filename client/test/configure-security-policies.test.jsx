import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

// The keys services/security-center.js policy() reads, plus the password floor.
const settings = {
  'security.2fa.required_for_root': true,
  'security.policy.require_2fa_for_resellers': false,
  'security.policy.api_tokens_require_2fa': true,
  'security.policy.verified_ip_login': true,
  'security.policy.session_timeout_minutes': 15,
  'security.policy.disallow_concurrent_sessions': true,
  'security.policy.password_max_age_days': 90,
  'security.min_password_strength': 65,
};

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: path.startsWith('/system/settings?prefix=security.') ? settings : null, meta: null, error: null, loading: false, refetch() {}, setData() {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { default: ConfigureSecurityPolicies } = await import('../src/pages/fn/security-center/configure-security-policies.jsx');
const { CATEGORIES } = await import('../src/nav.js');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);
const fn = CATEGORIES.find((c) => c.slug === 'security-center').functions.find((f) => f.slug === 'configure-security-policies');

describe('Configure Security Policies', () => {
  it('describes what each policy does instead of calling them unenforced', () => {
    const html = render(<ConfigureSecurityPolicies fn={fn} />);
    expect(html).not.toMatch(/not enforced/i);
    expect(html).not.toMatch(/does not harden/i);
    expect(html).not.toMatch(/stored (only|for the authentication layer)/i);
    expect(html).not.toContain('WHM_SESSION_TTL');
    expect(html).toContain('signs out every other browser session');
    expect(html).toContain('ended on its next request');
    expect(html).toContain('refused (401)');
    expect(html).toContain('login.new_ip');
    expect(html).toContain('The login itself is not blocked');
    expect(html).toContain('must change it at the next login');
    expect(html).toContain('enrolment page');
    for (const label of ['Require two-factor authentication for root', 'Require two-factor authentication for resellers', 'Idle session timeout (minutes)', 'One active session per user', 'Maximum password age (days)']) expect(html).toContain(label);
  });
});
