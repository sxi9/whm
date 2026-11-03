import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { PanelHome, usageMeters, UsageMeters, DomainsList, QuickLinks } = await import('../src/panel/PanelHome.jsx');
const { default: Dashboard } = await import('../src/pages/panel/overview/dashboard.jsx');
const { default: AccountDetails, limitText, featureRows } = await import('../src/pages/panel/overview/account.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', email: 'owner@demo.example.com', role: 'user', totpEnabled: false },
  account: {
    username: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', package: 'starter', contactEmail: 'owner@demo.example.com', homeDir: '/home/demo', shell: '/usr/sbin/nologin',
    createdAt: '2026-11-01T00:00:00Z', features: { cron: false, filemanager: true }, limits: { disk_mb: 1024, bandwidth_mb: null, max_email: 10, max_sql: 0, max_ftp: -1, max_addons: 2 },
    suspended: 0, forcePasswordChange: 0, demoMode: 0,
    domains: [{ domain: 'demo.example.com', type: 'main', docroot: '/home/demo/public_html' }, { domain: 'shop.demo.example.com', type: 'sub', docroot: '/home/demo/public_html/shop' }],
  },
  usage: { diskUsedMb: 512, diskQuotaMb: 1024, bandwidthUsedMb: 10, bandwidthLimitMb: null },
  counts: { domains: 1, subdomains: 1, addons: 0, parked: 0, mailboxes: 9, forwarders: 0, databases: 3, ftp: 0 },
  actingAs: null, policy: { require2fa: false, passwordSynced: true }, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: (k) => me.account.features[k] !== false };
const render = (el, path = '/panel') => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, el))));

describe('usage meters', () => {
  it('pair used/limit per object and treat null, 0 and -1 as unlimited', () => {
    const meters = usageMeters(me, null);
    const byKey = Object.fromEntries(meters.map((m) => [m.key, m]));
    expect(byKey.disk).toMatchObject({ percent: 50, text: '512 MB of 1.00 GB' });
    expect(byKey.bandwidth.percent).toBe(null);
    expect(byKey.bandwidth.text).toContain('unlimited');
    expect(byKey.mailboxes).toMatchObject({ used: 9, limit: 10, percent: 90, text: '9 of 10' });
    expect(byKey.databases.percent).toBe(null);
    expect(byKey.ftp.percent).toBe(null);
    expect(byKey.addons).toMatchObject({ percent: 0, text: '0 of 2' });
    const refined = usageMeters(me, { disk: { usedMb: 1000, quotaMb: 1024 }, counts: me.counts, limits: { max_email: 20 } });
    expect(Object.fromEntries(refined.map((m) => [m.key, m])).disk.percent).toBe(98);
    expect(Object.fromEntries(refined.map((m) => [m.key, m])).mailboxes.text).toBe('9 of 20');
  });

  it('render as stat tiles with a tone on the meter', () => {
    const html = render(h(UsageMeters, { me, usage: null }));
    expect(html).toContain('data-meter="disk"');
    expect(html).toContain('meter warn');
    expect(html).toContain('width:50%');
    expect(html).toContain('Mailboxes');
  });
});

describe('PanelHome / dashboard', () => {
  it('greets the account, shows meters, domains, the tool grid of visible groups and the account card', () => {
    const html = render(h(PanelHome));
    expect(html).toContain('panel-home');
    expect(html).toContain('home-hero');
    expect(html).toMatch(/Good (morning|afternoon|evening|night), demo/);
    expect(html).toContain('demo.example.com');
    expect(html).toContain('starter plan');
    expect(html).toContain('shop.demo.example.com');
    expect(html).toContain('data-group="email"');
    expect(html).not.toContain('data-group="cron"');
    expect(html).toContain('href="/panel/files/file-manager"');
    expect(html).toContain('href="/panel/overview/account"');
    expect(html).toContain('href="/panel/usage/usage"');
    expect(html).toContain('203.0.113.10');
    expect(html).not.toContain('No domains on this account yet');
  });

  it('the dashboard page is the same body under a page header', () => {
    const fn = PANEL_FUNCTION_BY_KEY['panel:overview/dashboard'];
    const html = render(h(Dashboard, { fn }), fn.path);
    expect(html).toContain('page-header');
    expect(html).toContain('<h1>Dashboard</h1>');
    expect(html).not.toContain('home-hero');
    expect(html).toContain('data-meter="disk"');
  });

  it('lists the main domain even when the rows do not carry it, and the empty state otherwise', () => {
    expect(render(h(DomainsList, { account: { domain: 'only.example.com', homeDir: '/home/only', domains: [] } }))).toContain('only.example.com');
    expect(render(h(DomainsList, { account: { domain: 'only.example.com', domains: [] } }))).toContain('/public_html');
    expect(render(h(DomainsList, { account: null }))).toContain('No domains on this account yet');
  });

  it('quick links render operator apps, news and the webmail button, nothing when empty', () => {
    expect(render(h(QuickLinks, { links: { apps: [], news: [] }, webmailUrl: '' }))).toBe('');
    const html = render(h(QuickLinks, { links: { apps: [{ name: 'Builder', url: 'https://builder.example' }], news: [{ id: 1, title: 'Maintenance', body: 'Sunday 02:00' }], webmailUrl: 'https://mail.example' } }));
    expect(html).toContain('https://builder.example');
    expect(html).toContain('Maintenance');
    expect(html).toContain('Sunday 02:00');
    expect(html).toContain('https://mail.example');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('Account details page', () => {
  it('shows identity, limits with Unlimited for null/0/-1, feature rows and sign-in facts', () => {
    const fn = PANEL_FUNCTION_BY_KEY['panel:overview/account'];
    const html = render(h(AccountDetails, { fn }), fn.path);
    expect(html).toContain('<h1>Account details</h1>');
    expect(html).toContain('/home/demo');
    expect(html).toContain('owner@demo.example.com');
    expect(html).toContain('srv1.example');
    expect(html).toContain('Disk space');
    expect(html).toContain('1.00 GB');
    expect(html).toContain('Unlimited');
    expect(html).toContain('Included features');
    expect(html).toContain('<code>cron</code>');
    expect(html).toContain('<code>filemanager</code>');
    expect(html).toContain('href="/panel/security/password"');
    expect(html).toContain('href="/panel/security/two-factor"');
    expect(html).toContain('Password in sync');
  });

  it('limitText and featureRows', () => {
    expect(limitText(null)).toBe('Unlimited');
    expect(limitText(0)).toBe('Unlimited');
    expect(limitText(-1)).toBe('Unlimited');
    expect(limitText(5)).toBe('5');
    expect(limitText(2048, (v) => `${v} MB`)).toBe('2048 MB');
    const rows = featureRows({ cron: false, custom_flag: true });
    expect(rows.find((r) => r.key === 'cron')).toMatchObject({ enabled: false, label: 'Cron › Cron jobs' });
    expect(rows.find((r) => r.key === 'filemanager')).toMatchObject({ enabled: true });
    expect(rows.find((r) => r.key === 'custom_flag')).toMatchObject({ enabled: true, label: 'custom_flag' });
    expect(rows.map((r) => r.key)).toEqual([...rows.map((r) => r.key)].sort());
  });

  it('hides the password and two-factor actions while an admin is acting as the account', () => {
    const fn = PANEL_FUNCTION_BY_KEY['panel:overview/account'];
    const acting = { ...ctx, me: { ...me, actingAs: { account: 'demo', by: 'root', expiresAt: '2099-01-01T00:00:00Z' } } };
    const html = renderToStaticMarkup(h(MemoryRouter, { initialEntries: [fn.path] }, h(PanelContext.Provider, { value: acting }, h(AccountDetails, { fn }))));
    expect(html).not.toContain('href="/panel/security/password"');
    expect(html).not.toContain('Password in sync');
  });
});
