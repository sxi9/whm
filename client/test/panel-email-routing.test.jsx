import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

const fixtures = new Map();
const EMPTY = { data: null, meta: null, error: null, loading: false, refetch: () => {}, setData: () => {} };
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    if (!path) return { ...EMPTY };
    const fx = fixtures.get(path.replace(/^\/panel/, '').split('?')[0]);
    if (!fx) return { ...EMPTY, loading: true };
    return { ...EMPTY, ...fx };
  },
  useMutation: () => ({ mutate: async () => {}, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { registryKeysFrom } = await import('../src/panel/registry.js');
const Routing = await import('../src/pages/panel/email/routing.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', features: {}, limits: {}, domains: [{ domain: 'demo.example.com', type: 'main' }, { domain: 'shop.example.org', type: 'addon' }] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:email/routing'];
const render = (el) => renderToStaticMarkup(h(ToastProvider, null, h(ConfirmProvider, null, h(MemoryRouter, { initialEntries: ['/panel/email/routing'] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, el))))));
const withFixtures = (entries, run) => { fixtures.clear(); for (const [k, v] of Object.entries(entries)) fixtures.set(k, v); try { return run(); } finally { fixtures.clear(); } };

const rows = [
  { domain: 'demo.example.com', type: 'main', routing: 'local', effective: 'local', mailboxes: 2, canRemote: false, mx: { ok: true, pointsHere: true, exchanges: ['mail.demo.example.com'], records: [{ exchange: 'mail.demo.example.com', priority: 10 }] }, delegation: { delegatedHere: true, delegatedNs: ['ns1.srv1.example'] }, hints: [] },
  { domain: 'shop.example.org', type: 'addon', routing: 'remote', effective: 'remote', mailboxes: 0, canRemote: true, mx: { ok: true, pointsHere: false, exchanges: ['aspmx.l.google.com'], records: [{ exchange: 'aspmx.l.google.com', priority: 1 }] }, delegation: { delegatedHere: false, delegatedNs: ['ns1.cloudflare.com'] }, hints: [] },
  { domain: 'new.example.net', type: 'addon', routing: 'auto', effective: 'local', mailboxes: 0, canRemote: true, mx: { ok: true, pointsHere: null, exchanges: [], records: [] }, delegation: null, hints: ['The MX records of new.example.net point at another server (unresolved), so mail from the internet does not arrive here; fix the MX record or set the routing to remote.'] },
  { domain: 'blog.example.org', type: 'addon', routing: 'auto', effective: 'local', mailboxes: 0, canRemote: true, mx: { ok: true, pointsHere: false, exchanges: ['mx.elsewhere.example'], records: [{ exchange: 'mx.elsewhere.example', priority: 10 }] }, delegation: { delegatedHere: false, delegatedNs: ['ns1.cloudflare.com'] }, hints: [] },
];

describe('Account panel › Email › Email routing', () => {
  it('is wired: nav entry, page registered under its key', () => {
    expect(fn).toMatchObject({ slug: 'routing', path: '/panel/email/routing', label: 'Email routing' });
    expect(registryKeysFrom(['../pages/panel/email/routing.jsx'])).toEqual(['panel:email/routing']);
  });

  it('shows one row per domain with the routing select, the effective side, the public MX and the delegation banner', () => {
    const html = withFixtures({ '/email/routing': { data: rows, meta: { hostname: 'srv1.example', values: ['auto', 'local', 'remote'] } } }, () => render(h(Routing.default, { fn })));
    expect(html).toContain('demo.example.com');
    expect(html).toContain('2 mailboxes');
    expect(html).toContain('aria-label="Routing for demo.example.com"');
    // remote is offered only to domains without mailboxes
    expect(html).toContain('Remote mail exchanger (another server) — not while mailboxes exist');
    expect(html).toContain('<option value="remote" disabled="">');
    expect(html).toContain('Points here');
    expect(html).toContain('Points elsewhere');
    expect(html).toContain('aspmx.l.google.com');
    expect(html).toContain('No MX record');
    expect(html).toContain('>Remote</span>');
    expect(html).toContain('>Local</span>');
    expect(html).toContain('data-delegation="shop.example.org"');
    expect(html).toContain('ns1.cloudflare.com');
    expect(html).not.toContain('data-delegation="demo.example.com"');
    // A domain delivered here whose MX points elsewhere gets the record to copy; a remote one does not.
    const plain = html.replace(/<!-- -->/g, '');
    expect(plain).toContain('blog.example.org MX 10 srv1.example');
    expect(plain).not.toContain('shop.example.org MX 10 srv1.example');
    expect(html).toContain('fix the MX record or set the routing to remote');
    expect(html).toContain('>Re-check MX</button>');
    expect((html.match(/>Save</g) || []).length).toBe(4);
  });

  it('renders the empty state, the loading state and a 501 without crashing', () => {
    expect(withFixtures({ '/email/routing': { data: [], meta: { hostname: 'srv1.example' } } }, () => render(h(Routing.default, { fn })))).toContain('No domains on this account yet');
    expect(withFixtures({}, () => render(h(Routing.default, { fn })))).toContain('Loading');
    const html = withFixtures({ '/email/routing': { data: null, error: { status: 501, code: 'capability_missing', capability: 'exim', message: 'Exim is not installed on this server.' } } }, () => render(h(Routing.default, { fn })));
    expect(html).toContain('Exim is not installed');
  });

  it('summarises MX lookups', () => {
    expect(Routing.mxSummary(null)).toMatchObject({ status: 'unknown', label: 'Not checked' });
    expect(Routing.mxSummary({ ok: false, error: 'ENOTFOUND', records: [] })).toMatchObject({ status: 'warning', label: 'Lookup failed', detail: 'ENOTFOUND' });
    expect(Routing.mxSummary({ ok: true, records: [], exchanges: [] }, 'srv1.example').detail).toContain('srv1.example');
    expect(Routing.mxSummary({ ok: true, records: [{ exchange: 'mx.a', priority: 1 }], exchanges: ['mx.a'], pointsHere: true })).toMatchObject({ status: 'ok', label: 'Points here', detail: 'mx.a' });
    expect(Routing.mxSummary({ ok: true, records: [{ exchange: 'mx.a', priority: 1 }], exchanges: ['mx.a', 'mx.b'], pointsHere: false })).toMatchObject({ status: 'warning', detail: 'mx.a, mx.b' });
    expect(Routing.mxRecords({ domain: 'd.example', hostname: 'srv1.example', effective: 'local', mx: { records: [], pointsHere: null } })).toEqual([{ name: 'd.example', type: 'MX', value: '10 srv1.example' }]);
    expect(Routing.mxRecords({ domain: 'd.example', effective: 'local', mx: { records: [{}], pointsHere: true } })).toEqual([]);
    expect(Routing.mxRecords({ domain: 'd.example', effective: 'remote', mx: { records: [], pointsHere: false } })).toEqual([]);
  });
});
