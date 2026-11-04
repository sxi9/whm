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
const { DelegationBanner, DelegationBanners, delegationText, managedAt, notDelegatedHere } = await import('../src/panel/DelegationBanner.jsx');
const { default: ZoneEditor, RECORD_TYPES } = await import('../src/pages/panel/dns/zone-editor.jsx');
const { default: Subdomains, SubdomainForm, DnsRecordResult } = await import('../src/pages/panel/domains/subdomains.jsx');
const { default: AddonDomains, AddonForm, defaultCreateZone } = await import('../src/pages/panel/domains/addon-domains.jsx');
const { default: Deliverability, pendingRecords } = await import('../src/pages/panel/email/deliverability.jsx');
const { default: SslStatus } = await import('../src/pages/panel/ssl/status.jsx');

React.useLayoutEffect = React.useEffect;

const account = { username: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', homeDir: '/home/demo', features: {}, limits: {}, domains: [{ domain: 'demo.example.com', type: 'main' }] };
const me = { user: { id: 7, username: 'demo', role: 'user' }, account, usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't' };
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const render = (el, path = '/panel') => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const page = (key, Comp) => { const fn = PANEL_FUNCTION_BY_KEY[key]; return render(h(Comp, { fn }), fn.path); };

const elsewhere = { domain: 'demo.example.com', checkedDomain: 'demo.example.com', delegatedHere: false, delegatedNs: ['betty.ns.cloud.example', 'roman.ns.cloud.example'], nameservers: [], checkedAt: '2026-11-05T10:00:00Z', error: null };
const here = { ...elsewhere, delegatedHere: true, delegatedNs: ['ns1.srv1.example'] };
const unknown = { ...elsewhere, delegatedHere: null, delegatedNs: [], error: 'ENOTFOUND' };
const BANNER = 'DNS for demo.example.com is managed at betty.ns.cloud.example, roman.ns.cloud.example; records you add here are not published — add them there as well';

const domainRows = (delegation) => [
  { id: 1, domain: 'demo.example.com', type: 'main', docroot: '/home/demo/public_html', phpVersion: null, createdAt: '2026-11-01 10:00:00', vhost: null, ssl: null, delegation },
  { id: 3, domain: 'shop.demo.example.com', type: 'sub', docroot: '/home/demo/public_html/shop', phpVersion: null, createdAt: '2026-11-02 11:00:00', vhost: null, ssl: null, delegation },
];
const listFixture = (delegation) => ({ data: domainRows(delegation), meta: { counts: { main: 1, addon: 0, sub: 1, parked: 0 }, limits: { max_addons: 2, max_subdomains: null, max_parked: 1 } } });

describe('DelegationBanner', () => {
  it('renders only when the public DNS is known to be elsewhere, with the records to copy', () => {
    expect(notDelegatedHere(elsewhere)).toBe(true);
    expect(notDelegatedHere(here)).toBe(false);
    expect(notDelegatedHere(unknown)).toBe(false);
    expect(notDelegatedHere(null)).toBe(false);
    expect(managedAt(unknown)).toBe('another DNS provider');
    expect(delegationText('demo.example.com', elsewhere)).toBe(BANNER);
    const html = renderToStaticMarkup(h(DelegationBanner, { domain: 'demo.example.com', delegation: elsewhere, records: [{ name: 'blog.demo.example.com', type: 'A', value: '203.0.113.10' }] }));
    expect(html).toContain('banner-warning');
    expect(html).toContain(BANNER.replace('—', '—'));
    expect(html).toContain('<code style="word-break:break-all">blog.demo.example.com A 203.0.113.10</code>');
    expect(renderToStaticMarkup(h(DelegationBanner, { domain: 'demo.example.com', delegation: here }))).toBe('');
    expect(renderToStaticMarkup(h(DelegationBanner, { domain: 'demo.example.com', delegation: unknown }))).toBe('');
    const many = renderToStaticMarkup(h(DelegationBanners, { domains: domainRows(elsewhere), recordsFor: (d) => [{ name: d.domain, type: 'A', value: '203.0.113.10' }] }));
    expect(many).toContain('data-delegation="demo.example.com"');
    expect(many).toContain('data-delegation="shop.demo.example.com"');
    expect(many).toContain('shop.demo.example.com A 203.0.113.10');
  });
});

describe('Zone editor with a delegated-away zone', () => {
  const zones = { data: { zones: [{ id: 2, domain: 'demo.example.com', serial: 2026110301, ttl: 14400, type: 'master', dnssecEnabled: false, updatedAt: null, records: 1, sync: [], delegation: elsewhere }], types: RECORD_TYPES } };
  it('shows the persistent banner and the public DNS tile', () => {
    fixtures['/panel/dns/zones'] = zones;
    fixtures['/panel/dns/zones/demo.example.com'] = { data: { id: 2, domain: 'demo.example.com', serial: 2026110301, ttl: 14400, published: false, records: [], types: RECORD_TYPES, delegation: elsewhere } };
    const html = page('panel:dns/zone-editor', ZoneEditor);
    expect(html).toContain(BANNER);
    expect(html).toContain('Managed elsewhere');
    expect(html).not.toContain('Changes are saved, not yet served');
    fixtures['/panel/dns/zones/demo.example.com'] = { data: { id: 2, domain: 'demo.example.com', serial: 2026110301, ttl: 14400, published: true, records: [], types: RECORD_TYPES, delegation: here } };
    fixtures['/panel/dns/zones'] = { data: { ...zones.data, zones: [{ ...zones.data.zones[0], delegation: here }] } };
    const ok = page('panel:dns/zone-editor', ZoneEditor);
    expect(ok).not.toContain('managed at');
    expect(ok).toContain('Delegated here');
  });
});

describe('Domains pages with a delegated-away parent', () => {
  it('subdomains: banner per parent, help on the form, and the record to copy in the create result', () => {
    fixtures['/panel/domains'] = listFixture(elsewhere);
    const html = page('panel:domains/subdomains', Subdomains);
    expect(html).toContain('Subdomains are not published from here');
    expect(html).toContain(BANNER);
    const form = render(h(SubdomainForm, { open: true, parents: ['demo.example.com'], delegations: { 'demo.example.com': elsewhere }, onClose: () => {}, onCreated: () => {} }));
    expect(form).toContain('the A record is shown for you to add there');
    const result = renderToStaticMarkup(h(DnsRecordResult, { dns: { zone: 'demo.example.com', applied: true, delegation: elsewhere, records: [{ name: 'blog.demo.example.com', type: 'A', value: '203.0.113.10' }] } }));
    expect(result).toContain('Add at betty.ns.cloud.example, roman.ns.cloud.example:');
    expect(result).toContain('blog.demo.example.com A 203.0.113.10');
    expect(renderToStaticMarkup(h(DnsRecordResult, { dns: { zone: 'demo.example.com', applied: true, delegation: here } }))).toContain('Added to demo.example.com');
    expect(renderToStaticMarkup(h(DnsRecordResult, { dns: { applied: false, reason: 'no_zone' } }))).toContain('No zone of yours contains this name');
    fixtures['/panel/domains'] = listFixture(here);
    expect(page('panel:domains/subdomains', Subdomains)).not.toContain('managed at');
  });

  it('addon domains: the zone toggle defaults off when the main domain is not delegated here', () => {
    expect(defaultCreateZone(domainRows(elsewhere))).toBe(false);
    expect(defaultCreateZone(domainRows(here))).toBe(true);
    expect(defaultCreateZone(domainRows(unknown))).toBe(true);
    expect(defaultCreateZone([])).toBe(true);
    const off = render(h(AddonForm, { open: true, onClose: () => {}, onCreated: () => {}, createZoneDefault: false, mainDomain: domainRows(elsewhere)[0] }));
    expect(off).toContain('Off because DNS for demo.example.com is managed at betty.ns.cloud.example');
    expect(off).not.toContain('checked=""');
    const on = render(h(AddonForm, { open: true, onClose: () => {}, onCreated: () => {} }));
    expect(on).toContain('Turn off when DNS is hosted elsewhere');
    expect(on).toContain('checked=""');
    fixtures['/panel/domains'] = listFixture(elsewhere);
    expect(page('panel:domains/addon-domains', AddonDomains)).toContain('Add addon domain');
  });
});

describe('Deliverability and SSL status with public DNS elsewhere', () => {
  const report = {
    domain: 'demo.example.com', account: 'demo', zone: true, score: 40, checkedAt: '2026-11-03T10:00:00Z', delegation: elsewhere,
    items: [
      { id: 'spf', label: 'SPF', status: 'missing', current: [], expected: 'v=spf1 +mx ~all', detail: null, fixable: true },
      { id: 'dkim', label: 'DKIM', selector: 'default', status: 'missing', current: [], expected: null, detail: 'No DKIM key has been generated for this domain yet.', fixable: true, signing: null, signingHint: null },
      { id: 'dmarc', label: 'DMARC', status: 'ok', current: ['v=DMARC1; p=none'], expected: 'v=DMARC1; p=none; rua=mailto:postmaster@demo.example.com', detail: null, fixable: true },
    ],
    records: [
      { id: 'spf', name: 'demo.example.com', type: 'TXT', value: 'v=spf1 +mx ~all', status: 'missing' },
      { id: 'dmarc', name: '_dmarc.demo.example.com', type: 'TXT', value: 'v=DMARC1; p=none; rua=mailto:postmaster@demo.example.com', status: 'ok' },
    ],
  };
  it('deliverability lists the records to copy and offers no BIND "Fix"', () => {
    expect(pendingRecords(report).map((r) => r.id)).toEqual(['spf']);
    fixtures['/panel/email/deliverability/demo.example.com'] = { data: report };
    fixtures['/panel/email/dkim/demo.example.com'] = { data: { domain: 'demo.example.com', zone: true, key: null } };
    const html = page('panel:email/deliverability', Deliverability);
    expect(html).toContain('Mail records are not published from here');
    expect(html).toContain(BANNER);
    expect(html).toContain('demo.example.com TXT v=spf1 +mx ~all');
    expect(html).not.toContain('_dmarc.demo.example.com TXT');
    expect(html).not.toContain('Fix all');
    expect(html).not.toContain('>Fix<');
    expect(html).toContain('Copy to betty.ns.cloud.example, roman.ns.cloud.example');
    expect(html).toContain('Prepare record');
    fixtures['/panel/email/deliverability/demo.example.com'] = { data: { ...report, delegation: here } };
    const local = page('panel:email/deliverability', Deliverability);
    expect(local).toContain('Fix all');
    expect(local).not.toContain('managed at');
  });

  it('SSL status warns per hostname with the address records AutoSSL needs', () => {
    fixtures['/panel/ssl/domains'] = { data: { domains: [{ domain: 'demo.example.com', type: 'main', certificate: null, autossl: null }], autossl: { provider: 'acme.sh', enabled: true, includeWww: true }, webLinked: true } };
    fixtures['/panel/domains'] = listFixture(elsewhere);
    const html = page('panel:ssl/status', SslStatus);
    expect(html).toContain('Certificates need the name to resolve to this server');
    expect(html).toContain(BANNER);
    expect(html).toContain('demo.example.com A 203.0.113.10');
    expect(html).toContain('www.demo.example.com A 203.0.113.10');
    expect(html).toContain('shop.demo.example.com A 203.0.113.10');
    expect(html).not.toContain('www.shop.demo.example.com');
    fixtures['/panel/domains'] = listFixture(here);
    expect(page('panel:ssl/status', SslStatus)).not.toContain('managed at');
  });
});
