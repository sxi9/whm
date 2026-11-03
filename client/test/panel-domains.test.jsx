import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

const fixtures = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const f = path ? fixtures[path] || fixtures[path.split('?')[0]] || null : null;
    return { data: f?.data ?? null, meta: f?.meta ?? null, error: f?.error ?? null, loading: Boolean(path) && !f, refetch: () => {}, setData: () => {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { default: Domains, filterDomains, allowedText } = await import('../src/pages/panel/domains/domains.jsx');
const { default: AddonDomains, AddonForm } = await import('../src/pages/panel/domains/addon-domains.jsx');
const { default: Subdomains, SubdomainForm } = await import('../src/pages/panel/domains/subdomains.jsx');
const { default: ParkedDomains, ParkedForm } = await import('../src/pages/panel/domains/parked-domains.jsx');
const { default: Redirects, RedirectsTable, RedirectForm, RedirectStatus } = await import('../src/pages/panel/domains/redirects.jsx');
const { limitReached, usageText, LimitNotice, RequestError, DocrootCode, VhostPill, SslPill, RemoveDomainModal } = await import('../src/pages/panel/domains/parts/shared.jsx');

React.useLayoutEffect = React.useEffect;

const account = { username: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', homeDir: '/home/demo', features: { addondomains: true, subdomains: true, parkeddomains: true, redirects: true }, limits: {} };
const me = { user: { id: 7, username: 'demo', role: 'user' }, account, usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't' };
const ctxFor = (features = account.features) => ({ me: { ...me, account: { ...account, features } }, loading: false, error: null, reload: () => {}, hasFeature: (k) => features[k] !== false });

const rows = [
  { id: 1, domain: 'demo.example.com', type: 'main', docroot: '/home/demo/public_html', phpVersion: '8.3', createdAt: '2026-11-01 10:00:00', vhost: { status: 'active', error: null, ip: '203.0.113.10', ipv6: null, aliases: ['www.demo.example.com'] }, ssl: { installed: true, state: 'installed', issuer: "Let's Encrypt", notAfter: '2027-01-01', daysRemaining: 58, autossl: true, selfSigned: false } },
  { id: 2, domain: 'second.example.org', type: 'addon', docroot: '/home/demo/public_html/second.example.org', phpVersion: null, createdAt: '2026-11-02 10:00:00', vhost: { status: 'pending', error: 'Apache is not installed', ip: null, ipv6: null, aliases: [] }, ssl: null },
  { id: 3, domain: 'shop.demo.example.com', type: 'sub', docroot: '/home/demo/public_html/shop', phpVersion: null, createdAt: '2026-11-02 11:00:00', vhost: null, ssl: null },
  { id: 4, domain: 'demo-alias.net', type: 'parked', docroot: '/home/demo/public_html', phpVersion: null, createdAt: '2026-11-02 12:00:00', vhost: { status: 'failed', error: 'config_invalid' }, ssl: null },
];
const listFixture = { data: rows, meta: { counts: { main: 1, addon: 1, sub: 1, parked: 1 }, limits: { max_addons: 2, max_subdomains: null, max_parked: 1 } } };

const render = (el, path = '/panel', ctx = ctxFor()) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const page = (key, ctx) => { const fn = PANEL_FUNCTION_BY_KEY[key]; return render(h({ 'panel:domains/domains': Domains, 'panel:domains/addon-domains': AddonDomains, 'panel:domains/subdomains': Subdomains, 'panel:domains/parked-domains': ParkedDomains, 'panel:domains/redirects': Redirects }[key], { fn }), fn.path, ctx); };

describe('shared parts', () => {
  it('limits: null is unlimited, 0 is a closed door, counts compare against the plan', () => {
    expect(limitReached(3, null)).toBe(false);
    expect(limitReached(0, 0)).toBe(true);
    expect(limitReached(1, 2)).toBe(false);
    expect(limitReached(2, 2)).toBe(true);
    expect(usageText(1, 2, 'addon domains')).toBe('1 of 2 addon domains');
    expect(usageText(4, null, 'subdomains')).toContain('no plan limit');
    expect(allowedText(null)).toBe('no plan limit');
    expect(allowedText(5)).toBe('of 5 allowed');
    const closed = renderToStaticMarkup(h(LimitNotice, { count: 0, limit: 0, noun: 'addon domains' }));
    expect(closed).toContain('Your plan does not include addon domains');
    expect(closed).toContain('plan that includes them');
    expect(renderToStaticMarkup(h(LimitNotice, { count: 2, limit: 2, noun: 'subdomains' }))).toContain('All 2 subdomains of your plan are in use');
    expect(renderToStaticMarkup(h(LimitNotice, { count: 1, limit: 2, noun: 'subdomains' }))).toBe('');
  });

  it('request errors: limits and capability get their own states, field errors stay on the fields', () => {
    expect(renderToStaticMarkup(h(RequestError, { error: { status: 409, code: 'limit_reached', message: "This account's plan allows 0 addon domain(s)" } }))).toContain('Plan limit reached');
    const cap = render(h(RequestError, { error: { status: 501, code: 'capability_missing', message: 'BIND is not installed' } }));
    expect(cap).toContain('Not available on this server');
    expect(cap).toContain('BIND is not installed');
    expect(renderToStaticMarkup(h(RequestError, { error: { status: 422, code: 'validation_failed', message: 'x', fields: { domain: ['bad'] } } }))).toBe('');
    expect(renderToStaticMarkup(h(RequestError, { error: { status: 409, code: 'exists', message: 'already hosted' } }))).toContain('already hosted');
  });

  it('pills and paths read as the customer sees them', () => {
    expect(renderToStaticMarkup(h(DocrootCode, { docroot: '/home/demo/public_html/shop', homeDir: '/home/demo' }))).toContain('~/public_html/shop');
    expect(renderToStaticMarkup(h(DocrootCode, { docroot: '/srv/www', homeDir: '/home/demo' }))).toContain('/srv/www');
    expect(renderToStaticMarkup(h(VhostPill, { vhost: { status: 'pending', error: 'Apache is not installed' } }))).toContain('Pending');
    expect(renderToStaticMarkup(h(VhostPill, { vhost: { status: 'pending', error: 'Apache is not installed' } }))).toContain('title="Apache is not installed"');
    expect(renderToStaticMarkup(h(VhostPill, { vhost: null }))).toContain('—');
    expect(renderToStaticMarkup(h(SslPill, { ssl: rows[0].ssl }))).toContain('Valid · 58 d');
    expect(renderToStaticMarkup(h(SslPill, { ssl: { ...rows[0].ssl, daysRemaining: 3 } }))).toContain('pill-warn');
    expect(renderToStaticMarkup(h(SslPill, { ssl: null }))).toContain('None');
  });

  it('the removal dialog lists its options with their defaults', () => {
    const html = renderToStaticMarkup(h(RemoveDomainModal, { open: true, domain: 'second.example.org', onClose: () => {}, onConfirm: async () => {}, options: [{ key: 'removeZone', label: 'Delete its DNS zone', default: true }, { key: 'removeDocroot', label: 'Delete the document root', default: false }] }));
    expect(html).toContain('Remove second.example.org?');
    expect(html).toContain('Delete its DNS zone');
    expect(html).toContain('Delete the document root');
    expect(html).toMatch(/checked="" ?\/?>/);
  });
});

describe('Domains overview', () => {
  it('shows counts with plan limits, every domain with its type, docroot, web server and SSL state', () => {
    fixtures['/panel/domains'] = listFixture;
    const html = page('panel:domains/domains');
    expect(html).toContain('<h1>Domains</h1>');
    expect(html).toContain('of 2 allowed');
    expect(html).toContain('no plan limit');
    expect(html).toContain('second.example.org');
    expect(html).toContain('shop.demo.example.com');
    expect(html).toContain('demo-alias.net');
    expect(html).toContain('Shows demo.example.com');
    expect(html).toContain('~/public_html/shop');
    expect(html).toContain('Main domain');
    expect(html).toContain('Addon domain');
    expect(html).toContain('Serving');
    expect(html).toContain('Pending');
    expect(html).toContain('Valid · 58 d');
    expect(html).toContain('DNS records');
    expect(html).toContain('href="/panel/domains/addon-domains"');
    expect(html).toContain('href="/panel/domains/parked-domains"');
    expect(html).toContain('role="tablist"');
  });

  it('hides the add links of features the plan turned off', () => {
    fixtures['/panel/domains'] = listFixture;
    const html = page('panel:domains/domains', ctxFor({ addondomains: false, parkeddomains: false, redirects: false }));
    expect(html).not.toContain('href="/panel/domains/addon-domains"');
    expect(html).toContain('href="/panel/domains/subdomains"');
    expect(html).not.toContain('Redirect<');
  });

  it('filterDomains narrows by type and text', () => {
    expect(filterDomains(rows, 'all', '').length).toBe(4);
    expect(filterDomains(rows, 'parked', '').map((r) => r.domain)).toEqual(['demo-alias.net']);
    expect(filterDomains(rows, 'sub', '').map((r) => r.domain)).toEqual(['shop.demo.example.com']);
    expect(filterDomains(rows, 'all', 'SECOND').map((r) => r.domain)).toEqual(['second.example.org']);
    expect(filterDomains(rows, 'all', 'public_html/shop').map((r) => r.domain)).toEqual(['shop.demo.example.com']);
  });
});

describe('Addon domains', () => {
  it('lists addon rows only, the usage line and the add button; the limit notice when the plan is full', () => {
    fixtures['/panel/domains'] = listFixture;
    const html = page('panel:domains/addon-domains');
    expect(html).toContain('<h1>Addon domains</h1>');
    expect(html).toContain('second.example.org');
    expect(html).not.toContain('shop.demo.example.com');
    expect(html).toContain('1 of 2 addon domains');
    expect(html).toContain('Add addon domain');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('Remove');
    fixtures['/panel/domains'] = { ...listFixture, meta: { ...listFixture.meta, limits: { ...listFixture.meta.limits, max_addons: 1 } } };
    const full = page('panel:domains/addon-domains');
    expect(full).toContain('All 1 addon domains of your plan are in use');
    expect(full).toContain('disabled=""');
  });

  it('renders the empty state, the plan-disabled state and the 403 from the API', () => {
    fixtures['/panel/domains'] = { data: [rows[0]], meta: { counts: { main: 1, addon: 0, sub: 0, parked: 0 }, limits: { max_addons: null, max_subdomains: null, max_parked: null } } };
    expect(page('panel:domains/addon-domains')).toContain('No addon domains yet');
    expect(page('panel:domains/addon-domains', ctxFor({ addondomains: false }))).toContain('Not included in your plan');
    fixtures['/panel/domains'] = { error: { status: 403, code: 'feature_disabled', message: 'The "addondomains" feature is not enabled for this account' } };
    const html = page('panel:domains/addon-domains');
    expect(html).toContain('Not included in your plan');
    expect(html).toContain('Addon domains is not part of the hosting plan');
    expect(html).toContain('href="/panel"');
  });

  it('shows the capability state on a 501 and keeps the page chrome', () => {
    fixtures['/panel/domains'] = { error: { status: 501, code: 'capability_missing', message: 'Apache is not installed on this server' } };
    const html = page('panel:domains/addon-domains');
    expect(html).toContain('Not available on this server');
    expect(html).toContain('Apache is not installed on this server');
    expect(html).toContain('<h1>Addon domains</h1>');
  });

  it('the add form has domain, document root and the zone toggle', () => {
    const html = render(h(AddonForm, { open: true, onClose: () => {}, onCreated: () => {} }));
    expect(html).toContain('Add an addon domain');
    expect(html).toContain('placeholder="example.org"');
    expect(html).toContain('Document root');
    expect(html).toContain('Create a DNS zone');
    expect(html).toContain('form="addon-form"');
  });
});

describe('Subdomains', () => {
  it('lists subdomain rows, offers main and addon domains as parents, and gates on the plan', () => {
    fixtures['/panel/domains'] = listFixture;
    const html = page('panel:domains/subdomains');
    expect(html).toContain('<h1>Subdomains</h1>');
    expect(html).toContain('shop.demo.example.com');
    expect(html).not.toContain('second.example.org<');
    expect(html).toContain('Add subdomain');
    expect(html).toContain('subdomains · no plan limit');
    const form = render(h(SubdomainForm, { open: true, parents: ['demo.example.com', 'second.example.org'], onClose: () => {}, onCreated: () => {} }));
    expect(form).toContain('<option value="demo.example.com" selected="">');
    expect(form).toContain('<option value="second.example.org">');
    expect(form).toContain('placeholder="shop"');
    expect(page('panel:domains/subdomains', ctxFor({ subdomains: false }))).toContain('Not included in your plan');
    fixtures['/panel/domains'] = { data: [rows[0]], meta: { counts: { main: 1, addon: 0, sub: 0, parked: 0 }, limits: { max_subdomains: 10 } } };
    expect(page('panel:domains/subdomains')).toContain('No subdomains yet');
  });
});

describe('Parked domains', () => {
  it('lists parked rows pointing at the main domain, with the limit notice and the park form', () => {
    fixtures['/panel/domains'] = listFixture;
    const html = page('panel:domains/parked-domains');
    expect(html).toContain('<h1>Parked domains</h1>');
    expect(html).toContain('demo-alias.net');
    expect(html).toContain('All 1 parked domains of your plan are in use');
    expect(html).toContain('Failed');
    expect(html).toContain('Park a domain');
    const form = render(h(ParkedForm, { open: true, target: 'demo.example.com', onClose: () => {}, onCreated: () => {} }));
    expect(form).toContain('shows the same site as demo.example.com');
    expect(form).toContain('Create a DNS zone');
    expect(page('panel:domains/parked-domains', ctxFor({ parkeddomains: false }))).toContain('Not included in your plan');
    fixtures['/panel/domains'] = { error: { status: 501, code: 'capability_missing', message: 'BIND is not installed' } };
    expect(page('panel:domains/parked-domains')).toContain('Not available on this server');
  });
});

describe('Redirects', () => {
  const redirect = { domain: 'second.example.org', targetUrl: 'https://www.example.org/', type: 'permanent', matchWww: true, keepPath: false, status: 'pending', lastError: 'Apache is not installed', updatedAt: '2026-11-03 10:00:00' };

  it('the page renders its chrome, the domains and the add button', () => {
    fixtures['/panel/domains'] = listFixture;
    const html = page('panel:domains/redirects');
    expect(html).toContain('<h1>Redirects</h1>');
    expect(html).toContain('Add redirect');
    expect(html).toContain('Only domains with a redirect');
    expect(html).toContain('demo.example.com');
    expect(page('panel:domains/redirects', ctxFor({ redirects: false }))).toContain('Not included in your plan');
  });

  it('the table shows target, type, options and status per domain; rows without one offer to add', () => {
    const html = render(h(RedirectsTable, { rows: [{ domain: 'demo.example.com', redirect: null }, { domain: 'second.example.org', redirect }], onEdit: () => {}, onRemove: () => {} }));
    expect(html).toContain('No redirect');
    expect(html).toContain('href="https://www.example.org/"');
    expect(html).toContain('Permanent (301)');
    expect(html).toContain('www');
    expect(html).toContain('Pending');
    expect(html).toContain('title="Apache is not installed"');
    expect(html).toContain('Add redirect');
    expect(html).toContain('Edit');
    expect(renderToStaticMarkup(h(RedirectStatus, { redirect: { ...redirect, status: 'applied' } }))).toContain('Active');
    expect(renderToStaticMarkup(h(RedirectStatus, { redirect: { ...redirect, status: 'failed' } }))).toContain('pill-bad');
  });

  it('the form preselects a domain and carries the existing redirect into edit mode', () => {
    const add = render(h(RedirectForm, { open: true, domains: ['demo.example.com', 'second.example.org'], domain: 'second.example.org', initial: null, onClose: () => {}, onSaved: () => {} }));
    expect(add).toContain('Add a redirect');
    expect(add).toContain('<option value="second.example.org" selected="">');
    expect(add).toContain('Also redirect www.second.example.org');
    const edit = render(h(RedirectForm, { open: true, domains: ['second.example.org'], initial: redirect, onClose: () => {}, onSaved: () => {} }));
    expect(edit).toContain('Edit the redirect of second.example.org');
    expect(edit).toContain('value="https://www.example.org/"');
    expect(edit).toContain('Save redirect');
    expect(edit).toContain('disabled=""');
  });
});
