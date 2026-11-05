import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

const fixtures = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (p) => {
    const f = p ? fixtures[p] || fixtures[p.split('?')[0]] || null : null;
    return { data: f?.data ?? null, meta: f?.meta ?? null, error: f?.error ?? null, loading: Boolean(p) && !f, refetch: () => {}, setData: () => {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { Meter, sslLive, siteUrl } = await import('../src/panel/Meter.jsx');
const { PanelCapabilityState, isPlanSettingError, isCapabilityError, PLAN_SETTING_CODES } = await import('../src/panel/PanelPage.jsx');
const { PanelTopBar } = await import('../src/panel/PanelTopBar.jsx');
const { DomainsList } = await import('../src/panel/PanelHome.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { default: Domains } = await import('../src/pages/panel/domains/domains.jsx');
const { Stat } = await import('../src/pages/panel/usage/usage.jsx');
const { QuotaMeter } = await import('../src/pages/panel/email/accounts.jsx');

React.useLayoutEffect = React.useEffect;

const account = { username: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', homeDir: '/home/demo', features: {}, limits: {}, domains: [{ domain: 'demo.example.com', type: 'main', docroot: '/home/demo/public_html' }, { domain: 'shop.demo.example.com', type: 'sub', docroot: '/home/demo/public_html/shop' }] };
const me = { user: { id: 7, username: 'demo', role: 'user' }, account, usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't' };
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const render = (el, p = '/panel') => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [p] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const withFixtures = (f, fn) => { for (const k of Object.keys(fixtures)) delete fixtures[k]; Object.assign(fixtures, f); return fn(); };

describe('plan-setting errors read as "not included in your plan" by code (contract §59)', () => {
  it('maps 501 shell_disabled and the other plan codes, keeps real 501s as capability errors', () => {
    const shell = { status: 501, code: 'shell_disabled', message: 'This account has no shell access, so SSH keys cannot be used' };
    expect(isPlanSettingError(shell)).toBe(true);
    expect(isCapabilityError(shell)).toBe(false);
    expect(isCapabilityError({ status: 501, code: 'capability_missing' })).toBe(true);
    expect(isCapabilityError({ status: 503, code: 'binary_not_found' })).toBe(true);
    expect(isPlanSettingError({ status: 403, code: 'feature_disabled' })).toBe(true);
    expect(isPlanSettingError(null)).toBe(false);
    expect(PLAN_SETTING_CODES).toContain('shell_disabled');
    const html = render(h(PanelCapabilityState, { error: shell, onRetry: () => {} }));
    expect(html).toContain('Not included in your plan');
    expect(html).toContain('no shell access');
    expect(html).toContain('upgrading the plan');
    expect(html).not.toContain('Not available on this server');
    expect(html).not.toContain('Re-check');
    const cap = render(h(PanelCapabilityState, { error: { status: 501, code: 'capability_missing', message: 'crontab is missing' }, onRetry: () => {} }));
    expect(cap).toContain('Not available on this server');
    expect(cap).toContain('Re-check');
  });
});

describe('Meter', () => {
  it('is a progressbar with the percentage as value and the figure as value text', () => {
    const html = renderToStaticMarkup(h(Meter, { percent: 80.4, label: 'Disk', text: '823 MB of 1.00 GB', name: 'disk' }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="80"');
    expect(html).toContain('aria-valuetext="823 MB of 1.00 GB"');
    expect(html).toContain('aria-label="Disk: 823 MB of 1.00 GB"');
    expect(html).toContain('data-meter="disk"');
    expect(html).toContain('class="meter warn"');
    expect(html).toContain('width:80.4%');
    expect(html).not.toContain('aria-hidden');
  });

  it('clamps out-of-range values and hides a bar without a percentage', () => {
    expect(renderToStaticMarkup(h(Meter, { percent: 140, label: 'Disk', text: 'over' }))).toContain('aria-valuenow="100"');
    expect(renderToStaticMarkup(h(Meter, { percent: 140, label: 'Disk', text: 'over' }))).toContain('width:100%');
    const hidden = renderToStaticMarkup(h(Meter, { percent: null, label: 'Bandwidth', text: '10 MB · unlimited' }));
    expect(hidden).toContain('role="progressbar"');
    expect(hidden).toContain('aria-hidden="true"');
    expect(hidden).not.toContain('aria-valuenow');
    expect(hidden).toContain('width:0%');
  });

  it('backs the Usage page tiles and the mailbox quota meters', () => {
    const stat = render(h(Stat, { name: 'disk', label: 'Disk', value: '512 MB', sub: 'of 1.00 GB', used: 512, limit: 1024 }));
    expect(stat).toContain('role="progressbar"');
    expect(stat).toContain('aria-valuenow="50"');
    expect(stat).toContain('aria-label="Disk: 512 MB of 1.00 GB"');
    const quota = render(h(QuotaMeter, { row: { address: 'info@demo.example.com', quotaMb: 1024, usage: { bytes: 900 * 1024 * 1024, messages: 3 } } }));
    expect(quota).toContain('role="progressbar"');
    expect(quota).toContain('aria-valuenow="88"');
    expect(quota).toContain('aria-label="info@demo.example.com: 900 MB of 1.00 GB"');
    expect(quota).toContain('class="meter warn"');
  });
});

describe('user menu', () => {
  it('declares the popup on its button and closes on Escape and on a click outside', () => {
    const html = render(h(PanelTopBar, { onMenu: () => {} }));
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-controls="panel-user-menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Account menu"');
    expect(html).not.toContain('onMouseLeave');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel', 'PanelTopBar.jsx'), 'utf8');
    expect(src).toContain('role="menu" id="panel-user-menu" aria-labelledby="panel-user-menu-button"');
    expect((src.match(/role="menuitem"/g) || []).length).toBe(5);
    expect(src).toContain("e.key === 'Escape'");
    expect(src).toContain("document.addEventListener('mousedown', onPointer)");
    expect(src).toContain('!menuRef.current.contains(e.target)');
    expect(src).not.toContain('onMouseLeave');
  });
});

describe('domain tabs', () => {
  it('point at the list with aria-controls and keep one tab in the tab order', () => {
    const rows = [{ id: 1, domain: 'demo.example.com', type: 'main', docroot: '/home/demo/public_html', vhost: null, ssl: null }];
    const html = withFixtures({ '/domains': { data: rows, meta: { counts: { addon: 0, sub: 0, parked: 0 }, limits: {} } } }, () => render(h(Domains, { fn: PANEL_FUNCTION_BY_KEY['panel:domains/domains'] }), '/panel/domains/domains'));
    expect(html).toContain('role="tablist" aria-label="Filter by type"');
    expect((html.match(/aria-controls="panel-domains-list"/g) || []).length).toBe(5);
    expect(html).toContain('id="panel-domains-tab-all"');
    expect(html).toContain('id="panel-domains-list" role="tabpanel" aria-labelledby="panel-domains-tab-all"');
    expect((html.match(/tabindex="0"/g) || []).length).toBeGreaterThanOrEqual(1);
    expect((html.match(/tabindex="-1"/g) || []).length).toBe(4);
  });
});

describe('https home links', () => {
  it('decide from the ssl entry of GET /api/panel/domains', () => {
    expect(sslLive(null)).toBe(false);
    expect(sslLive({ installed: false, state: 'stored' })).toBe(false);
    expect(sslLive({ installed: true, state: 'installed', daysRemaining: 58 })).toBe(true);
    expect(sslLive({ installed: true, state: 'installed', daysRemaining: 0 })).toBe(false);
    expect(sslLive({ installed: true, state: 'installed', daysRemaining: null })).toBe(true);
    expect(sslLive({ installed: true, state: 'installed', expired: true })).toBe(false);
    expect(siteUrl('demo.example.com', { installed: true, state: 'installed', daysRemaining: 10 })).toBe('https://demo.example.com');
    expect(siteUrl('demo.example.com', null)).toBe('http://demo.example.com');
  });

  it('render https for the secured domain and http for the rest', () => {
    const html = render(h(DomainsList, { account, ssl: { 'demo.example.com': { installed: true, state: 'installed', daysRemaining: 58 }, 'shop.demo.example.com': null } }));
    expect(html).toContain('href="https://demo.example.com"');
    expect(html).toContain('href="http://shop.demo.example.com"');
    expect(render(h(DomainsList, { account }))).toContain('href="http://demo.example.com"');
  });
});
