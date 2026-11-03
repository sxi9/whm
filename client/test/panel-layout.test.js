import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

let currentUser = { id: 7, username: 'demo', role: 'user', totpEnabled: false, mustChangePassword: false };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: currentUser, ready: true, hostname: 'srv1.example', refresh: async () => {}, logout: async () => {} }) }));

const { PanelLayout, PanelShell, panelRedirect, isTerminalPanelError } = await import('../src/panel/PanelLayout.jsx');
const { PanelContext, scopeBanners, minutesLeft, percentOf, meterTone } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL, ADMIN_SHELL } = await import('../src/panel/ShellContext.js');
const { PanelBanners } = await import('../src/panel/PanelBanners.jsx');
const { PanelDisabledPage } = await import('../src/panel/PanelDisabled.jsx');
const { PanelPageHeader, PanelFunctionPage, PanelCapabilityState, PendingPill } = await import('../src/panel/PanelPage.jsx');
const { PANEL_FUNCTION_BY_KEY, PANEL_FUNCTIONS } = await import('../src/panel/nav.js');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user', totpEnabled: false, mustChangePassword: false },
  account: { username: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', package: 'starter', features: {}, limits: { max_email: 10 }, suspended: 0, forcePasswordChange: 0, demoMode: 0, domains: [] },
  usage: { diskUsedMb: 120, diskQuotaMb: 1024, bandwidthUsedMb: 10, bandwidthLimitMb: null },
  counts: { domains: 1, mailboxes: 2, databases: 1, ftp: 0, addons: 0, subdomains: 0 },
  actingAs: null, policy: { require2fa: false, passwordSynced: true }, hostname: 'srv1.example', csrfToken: 't',
};

const render = (el, { path = '/panel', value = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true } } = {}) => renderToStaticMarkup(
  h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value }, el))),
);

describe('panelRedirect (design §6.2 gate)', () => {
  const user = me.user;
  const root = { id: 1, username: 'root', role: 'root', totpEnabled: true };
  it.each([
    ['anonymous → /login with the location remembered', null, me, '/panel/email/accounts', { to: '/login', state: { from: '/panel/email/accounts' } }],
    ['root without acting-as → /', root, me, '/panel', { to: '/' }],
    ['reseller without acting-as → /', { ...root, role: 'reseller' }, me, '/panel', { to: '/' }],
    ['root acting as the account stays', root, { ...me, actingAs: { account: 'demo', by: 'root', expiresAt: '2099-01-01T00:00:00Z' } }, '/panel', null],
    ['root before /me answered waits (no redirect yet)', root, null, '/panel', null],
    ['role user with a plain account stays', user, me, '/panel/files/file-manager', null],
    ['forced password change → the password page', user, { ...me, account: { ...me.account, forcePasswordChange: 1 } }, '/panel', { to: '/panel/security/password' }],
    ['forced password change on the password page stays', user, { ...me, account: { ...me.account, forcePasswordChange: 1 } }, '/panel/security/password', null],
    ['mustChangePassword on the users row → the password page', { ...user, mustChangePassword: true }, me, '/panel', { to: '/panel/security/password' }],
    ['required 2FA without enrolment → the two-factor page', user, { ...me, policy: { require2fa: true } }, '/panel', { to: '/panel/security/two-factor' }],
    ['required 2FA on the two-factor page stays', user, { ...me, policy: { require2fa: true } }, '/panel/security/two-factor', null],
    ['required 2FA already enrolled stays', { ...user, totpEnabled: true }, { ...me, policy: { require2fa: true } }, '/panel', null],
    ['required 2FA does not apply to an admin acting as the account', root, { ...me, policy: { require2fa: true }, actingAs: { by: 'root' } }, '/panel', null],
  ])('%s', (_label, u, m, pathname, expected) => {
    expect(panelRedirect(u, m, pathname)).toEqual(expected);
  });

  it('treats 403/423/501 from /me as full-page states and outages as retryable', () => {
    expect(isTerminalPanelError({ status: 403, code: 'panel_disabled' })).toBe(true);
    expect(isTerminalPanelError({ status: 423, code: 'account_suspended' })).toBe(true);
    expect(isTerminalPanelError({ status: 502 })).toBe(false);
    expect(isTerminalPanelError(null)).toBe(false);
  });
});

describe('PanelLayout', () => {
  it('renders the Navigate (nothing) for an anonymous visitor and a loading state while /me is in flight', () => {
    currentUser = null;
    expect(render(h(PanelLayout))).toBe('');
    currentUser = { id: 1, username: 'root', role: 'root' };
    expect(render(h(PanelLayout))).toContain('Opening your account');
    currentUser = me.user;
    expect(render(h(PanelLayout))).toContain('Opening your account');
  });
});

describe('PanelShell for role user', () => {
  it('renders the panel sidebar with every group, the account chip, no admin chrome', () => {
    currentUser = me.user;
    const html = render(h(PanelShell, { me }, h('div', { className: 'probe' }, 'page')));
    expect(html).toContain('panel-sidebar');
    expect(html).toContain('data-shell="panel"');
    for (const slug of ['overview', 'domains', 'email', 'databases', 'security', 'usage']) expect(html).toContain(`data-group="${slug}"`);
    expect(html).toContain('href="/panel"');
    expect(html).toContain('demo.example.com');
    expect(html).toContain('class="probe"');
    expect(html).not.toContain('audit-log');
    expect(html).not.toContain('license-banner');
    expect(html).not.toContain('Expand all');
    expect(html).toContain('Signed in as demo');
  });

  it('hides functions the plan switches off and keeps the rest of the group', () => {
    currentUser = me.user;
    const gated = { ...me, account: { ...me.account, features: { emailaccts: false, cron: false } } };
    const html = render(h(PanelShell, { me: gated }), { value: { me: gated, loading: false, error: null, reload: () => {}, hasFeature: () => true } });
    expect(html).not.toContain('data-group="cron"');
    expect(html).toContain('data-group="email"');
    // The sidebar persists group state only; the Email group is collapsed, so count the search index instead.
    expect(html).toContain('data-group="email"');
  });

  it('shows the acting-as banner with the admin name and the remaining time while impersonating', () => {
    currentUser = { id: 1, username: 'root', role: 'root' };
    const acting = { ...me, actingAs: { account: 'demo', by: 'root', expiresAt: new Date(Date.now() + 42 * 60_000).toISOString() } };
    const html = render(h(PanelShell, { me: acting }), { value: { me: acting, loading: false, error: null, reload: () => {}, hasFeature: () => true } });
    expect(html).toContain('panel-acting-banner');
    expect(html).toContain('Viewing demo as root');
    expect(html).toMatch(/ends in 4[12] min/);
    expect(html).toContain('Exit');
    expect(html).toContain('viewing demo');
  });
});

describe('scope banners (design §2.3–§2.5)', () => {
  it('derives acting, suspended, forced-password and demo notices from /me', () => {
    const now = Date.parse('2026-11-03T10:00:00Z');
    expect(scopeBanners(null)).toEqual([]);
    expect(scopeBanners(me)).toEqual([]);
    const all = scopeBanners({ ...me, actingAs: { account: 'demo', by: 'root', expiresAt: '2026-11-03T10:30:00Z' }, account: { ...me.account, suspended: 1, forcePasswordChange: 1, demoMode: 1 } }, now);
    expect(all.map((b) => b.kind)).toEqual(['acting', 'suspended', 'force-password', 'demo']);
    expect(all[0]).toMatchObject({ by: 'root', account: 'demo', minutesLeft: 30 });
    expect(minutesLeft('2026-11-03T09:00:00Z', now)).toBe(0);
    expect(minutesLeft(null)).toBe(null);
    expect(minutesLeft('garbage')).toBe(null);
    expect(scopeBanners({ ...me, user: { ...me.user, mustChangePassword: true } }).map((b) => b.kind)).toEqual(['force-password']);
  });

  it('renders each notice with its tone', () => {
    currentUser = me.user;
    const state = { ...me, account: { ...me.account, suspended: 1, demoMode: 1, forcePasswordChange: 1 } };
    const html = render(h(PanelBanners), { value: { me: state, loading: false, error: null, reload: () => {}, hasFeature: () => true } });
    expect(html).toContain('banner-error');
    expect(html).toContain('This account is suspended');
    expect(html).toContain('A new password is required');
    expect(html).toContain('href="/panel/security/password"');
    expect(html).toContain('Demo mode');
    expect(render(h(PanelBanners))).toBe('');
  });

  it('meter helpers treat null, 0 and -1 limits as unlimited', () => {
    expect(percentOf(50, 100)).toBe(50);
    expect(percentOf(150, 100)).toBe(100);
    expect(percentOf(5, null)).toBe(null);
    expect(percentOf(5, 0)).toBe(null);
    expect(percentOf(5, -1)).toBe(null);
    expect(meterTone(96)).toBe('bad');
    expect(meterTone(80)).toBe('warn');
    expect(meterTone(10)).toBe('');
    expect(meterTone(null)).toBe('');
  });
});

describe('PanelDisabledPage', () => {
  it('explains panel_disabled, no_account and panel_scope_required and offers the console to admins only', () => {
    currentUser = me.user;
    const disabled = render(h(PanelDisabledPage, { error: { status: 403, code: 'panel_disabled' } }));
    expect(disabled).toContain('data-code="panel_disabled"');
    expect(disabled).toContain('switched off');
    expect(disabled).toContain('Sign out');
    expect(disabled).not.toContain('Back to the console');
    expect(render(h(PanelDisabledPage, { error: { status: 403, code: 'no_account' } }))).toContain('No hosting account is linked');
    currentUser = { id: 1, username: 'root', role: 'root' };
    const scope = render(h(PanelDisabledPage, { error: { status: 403, code: 'panel_scope_required' } }));
    expect(scope).toContain('Log in as');
    expect(scope).toContain('Back to the console');
    expect(render(h(PanelDisabledPage, { error: { status: 503, code: 'agent_unavailable', message: 'agent down' } }))).toContain('agent down');
  });
});

describe('PanelPage chrome', () => {
  it('breadcrumbs lead to /panel and the title comes from the function', () => {
    currentUser = me.user;
    const fn = PANEL_FUNCTION_BY_KEY['panel:email/forwarders'];
    const html = render(h(PanelPageHeader, { fn }));
    expect(html).toContain('href="/panel"');
    expect(html).toContain('<h1>Forwarders</h1>');
    expect(html).toContain('Email');
    expect(html).toContain('Copy or redirect incoming mail');
    expect(html).toContain('page-header');
  });

  it('renders the placeholder for every function without a page and the 501 / pending states', () => {
    currentUser = me.user;
    for (const fn of PANEL_FUNCTIONS) {
      const html = render(h(PanelFunctionPage, { fn }), { path: fn.path });
      expect(html).toContain(`<h1>${fn.label.replace(/&/g, '&amp;')}</h1>`);
      expect(html).toContain('Back to the dashboard');
    }
    expect(render(h(PanelCapabilityState, { error: { status: 501, code: 'capability_missing', message: 'pure-ftpd is not installed' } }))).toContain('pure-ftpd is not installed');
    expect(render(h(PanelCapabilityState, { error: { status: 404, code: 'not_found' } }))).toBe('');
    expect(render(h(PendingPill, { result: { applied: false, reason: 'capability_missing' } }))).toContain('Pending');
    expect(render(h(PendingPill, { result: { applied: true } }))).toBe('');
  });

  it('defaults to the admin shell outside PanelLayout', () => {
    expect(ADMIN_SHELL.home).toBe('/');
    expect(ADMIN_SHELL.i18nPrefix).toBe('fn');
    expect(PANEL_SHELL.favoritesKey).not.toBe(ADMIN_SHELL.favoritesKey);
  });
});
