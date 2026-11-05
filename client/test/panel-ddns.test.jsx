import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

const fixtures = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const f = path ? fixtures[path] || null : null;
    return { data: f?.data ?? null, meta: f?.meta ?? null, error: f?.error ?? null, loading: Boolean(path) && !f, refetch: () => {}, setData: () => {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY, PANEL_FUNCTIONS } = await import('../src/panel/nav.js');
const { registryKeysFrom } = await import('../src/panel/registry.js');
const { default: DynamicDns, CreateTokenForm, CreatedTokenModal, eligibleZones } = await import('../src/pages/panel/dns/dynamic-dns.jsx');

React.useLayoutEffect = React.useEffect;

const me = { user: { id: 7, username: 'demo', role: 'user' }, account: { username: 'demo', domain: 'demo.example.com', features: {}, limits: {} }, usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't' };
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:dns/dynamic-dns'];
const render = (el, path = fn.path) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));

const here = { domain: 'demo.example.com', delegatedHere: true, delegatedNs: ['ns1.srv1.example'], nameservers: [], error: null };
const elsewhere = { domain: 'second.example.org', delegatedHere: false, delegatedNs: ['betty.ns.cloud.example'], nameservers: [], error: null };
const zones = [
  { domain: 'demo.example.com', delegation: here, records: [{ id: 13, name: '@', type: 'A', value: '203.0.113.10', host: 'demo.example.com' }, { id: 21, name: 'home', type: 'AAAA', value: '2001:db8::1', host: 'home.demo.example.com' }] },
  { domain: 'second.example.org', delegation: elsewhere, records: [{ id: 30, name: '@', type: 'A', value: '203.0.113.11', host: 'second.example.org' }] },
];
// The opening tag of the header's create button.
const createButton = (html) => { const m = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?Create update URL/); return m ? m[0].slice(0, m[0].indexOf('>') + 1) : ''; };
const tokens = [{ id: 1, label: 'home router', zone: 'demo.example.com', recordId: 21, name: 'home', host: 'home.demo.example.com', type: 'AAAA', value: '2001:db8::1', lastIp: '2001:db8::1', lastUsedAt: '2026-11-06T10:00:00Z', updates: 4, createdAt: '2026-11-01T10:00:00Z' }];

describe('Dynamic DNS nav entry', () => {
  it('is a gated DNS function with a discovered page and en.json strings', () => {
    expect(fn).toMatchObject({ slug: 'dynamic-dns', categorySlug: 'dns', feature: 'ddns', path: '/panel/dns/dynamic-dns' });
    expect(registryKeysFrom(['../pages/panel/dns/dynamic-dns.jsx'])).toEqual(['panel:dns/dynamic-dns']);
    const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
    expect(en['panel.dns/dynamic-dns.label']).toBe('Dynamic DNS');
    expect(en['panel.ddns.add_token']).toBe('Create update URL');
    expect(PANEL_FUNCTIONS.filter((f) => f.slug === 'dynamic-dns')).toHaveLength(1);
  });
});

describe('Dynamic DNS page', () => {
  it('lists tokens, shows the banner for a zone served elsewhere and offers creation', () => {
    fixtures['/panel/dns/ddns'] = { data: { tokens, zones, baseUrl: 'https://srv1.example:2083/api/panel/dns/ddns', max: 20 } };
    const html = render(h(DynamicDns, { fn }));
    expect(html).toContain('Dynamic DNS');
    expect(html).toContain('home.demo.example.com');
    expect(html).toContain('home router');
    expect(html).toContain('2001:db8::1');
    expect(html).toContain('1 of 20 update URLs used');
    expect(html).toContain('data-delegation="second.example.org"');
    expect(html).toContain('Dynamic DNS is unavailable for this zone');
    expect(html).not.toContain('data-delegation="demo.example.com"');
    expect(createButton(html)).not.toContain('disabled');
  });

  it('disables creation when no zone is usable and shows the empty state', () => {
    fixtures['/panel/dns/ddns'] = { data: { tokens: [], zones: [zones[1]], baseUrl: 'x', max: 20 } };
    const html = render(h(DynamicDns, { fn }));
    expect(html).toContain('No update URLs yet');
    expect(createButton(html)).toContain('disabled');
    expect(eligibleZones(zones).map((z) => z.domain)).toEqual(['demo.example.com']);
  });

  it('the create form lists A/AAAA records of the chosen zone and marks zones served elsewhere', () => {
    const html = render(h(CreateTokenForm, { zones, onClose: () => {}, onCreated: () => {} }));
    expect(html).toContain('Create a dynamic DNS update URL');
    expect(html).toContain('home.demo.example.com  AAAA  2001:db8::1');
    expect(html).toContain('second.example.org — DNS managed elsewhere');
    expect(html).toMatch(/<option[^>]*disabled[^>]*>second\.example\.org/);
    expect(html).not.toContain('second.example.org  A  203.0.113.11');
  });

  it('the created modal shows the URL once with a cron example', () => {
    const url = 'https://srv1.example:2083/api/panel/dns/ddns/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    const html = render(h(CreatedTokenModal, { created: { url, secret: 'x', token: tokens[0] }, onClose: () => {} }));
    expect(html).toContain('not shown again');
    expect(html).toContain(`data-ddns-url`);
    expect(html).toContain(`curl -fsS &#x27;${url}?format=text&#x27;`);
  });
});
