import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY, PANEL_FUNCTIONS, visibleCategories } = await import('../src/panel/nav.js');
const { registryKeysFrom } = await import('../src/panel/registry.js');
const { default: TrackDns, LookupResult, TraceResult, isTarget, LOOKUP_TYPES } = await import('../src/pages/panel/dns/track.jsx');

React.useLayoutEffect = React.useEffect;

const me = { user: { id: 7, username: 'demo', role: 'user' }, account: { username: 'demo', domain: 'demo.example.com', features: {}, limits: {} }, usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't' };
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:dns/track'];
const render = (el, path = fn.path) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));

const trace = {
  host: 'example.com', target: '93.184.216.34', reached: true, error: null, output: '',
  hops: [
    { hop: 1, address: '10.0.0.1', addresses: ['10.0.0.1'], rtts: [0.412, 0.398, 0.371], timeouts: 0 },
    { hop: 2, address: null, addresses: [], rtts: [], timeouts: 3 },
    { hop: 3, address: '93.184.216.34', addresses: ['93.184.216.34', '93.184.216.35'], rtts: [112.4, 110.9], timeouts: 1 },
  ],
};

describe('Track DNS nav entry', () => {
  it('is a gated DNS function with a discovered page, en.json strings', () => {
    expect(fn).toMatchObject({ slug: 'track', categorySlug: 'dns', feature: 'traceroute', path: '/panel/dns/track', label: 'Track DNS' });
    expect(registryKeysFrom(['../pages/panel/dns/track.jsx'])).toEqual(['panel:dns/track']);
    expect(PANEL_FUNCTIONS.filter((f) => f.slug === 'track' && f.categorySlug === 'dns')).toHaveLength(1);
    expect(visibleCategories({ traceroute: false }).find((c) => c.slug === 'dns').functions.some((f) => f.slug === 'track')).toBe(false);
    const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
    expect(en['panel.dns/track.label']).toBe('Track DNS');
    expect(en['panel.dns/track.description']).toBe(fn.description);
    for (const key of ['lookup_title', 'trace_title', 'lookup', 'trace', 'col_hop', 'col_address', 'col_rtt', 'lookup_empty', 'trace_reached', 'trace_not_reached', 'trace_unknown_host', 'trace_timeout']) {
      expect(typeof en[`panel.dnstrack.${key}`], key).toBe('string');
    }
    expect(LOOKUP_TYPES).toEqual(['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'SOA', 'PTR']);
  });
});

describe('Track DNS page', () => {
  it('renders both forms with the account domain filled in and every record type offered', () => {
    const html = render(h(TrackDns, { fn }));
    expect(html).toContain('Track DNS');
    expect(html).toContain('Domain lookup');
    expect(html).toContain('Trace route');
    expect(html).toContain('id="dnstrack-name"');
    expect(html).toContain('value="demo.example.com"');
    expect(html).toContain('id="dnstrack-host"');
    for (const type of LOOKUP_TYPES) expect(html).toContain(`<option value="${type}"`);
    expect(html).toContain('Look up');
    expect(html).toContain('>Trace<');
    expect(html).not.toContain('data-lookup=');
    expect(html).not.toContain('data-trace=');
  });

  it('isTarget accepts hostnames and addresses and refuses options and shell tokens', () => {
    for (const ok of ['example.com', 'www.example.co.uk', '203.0.113.9', '2001:db8::1', 'Example.COM']) expect(isTarget(ok), ok).toBe(true);
    for (const bad of ['', 'localhost', '-x', '--help', '+trace', 'a;b.com', 'a b.com', '$(id).com', 'example.com/x', 'x'.repeat(254)]) expect(isTarget(bad), bad).toBe(false);
  });

  it('lists lookup answers one per row and explains an empty or timed-out answer', () => {
    const full = render(h(LookupResult, { result: { name: 'example.com', type: 'MX', answers: ['10 mail.example.com.', '20 mx2.example.com.'], notes: [], error: null } }));
    expect(full).toContain('data-lookup="example.com"');
    expect(full).toContain('10 mail.example.com.');
    expect(full).toContain('20 mx2.example.com.');
    expect(full.match(/<tr>/g)).toHaveLength(3);
    const empty = render(h(LookupResult, { result: { name: 'example.com', type: 'AAAA', answers: [], notes: [], error: null } }));
    expect(empty).toContain('AAAA records of example.com');
    expect(empty).toContain('No records of this type were found.');
    const timeout = render(h(LookupResult, { result: { name: 'example.com', type: 'A', answers: [], notes: ['no servers could be reached'], error: 'timeout' } }));
    expect(timeout).toContain('No name server answered in time.');
  });

  it('shows the hop table with timeouts, several addresses per hop and the reached state', () => {
    const html = render(h(TraceResult, { result: trace }));
    expect(html).toContain('data-trace="example.com"');
    expect(html).toContain('Reached 93.184.216.34 in 3 hops.');
    expect(html).toContain('pill-ok');
    expect(html).toContain('10.0.0.1');
    expect(html).toContain('0.4 ms');
    expect(html).toContain('no reply');
    expect(html).toContain('***');
    expect(html).toContain('93.184.216.35');
    expect(html).toContain('112 ms');
    const partial = render(h(TraceResult, { result: { ...trace, reached: false, hops: trace.hops.slice(0, 2) } }));
    expect(partial).toContain('93.184.216.34 was not reached within 2 hops.');
    expect(partial).toContain('pill-warn');
    expect(render(h(TraceResult, { result: { host: 'nope.invalid', target: null, hops: [], reached: false, error: 'unknown_host' } }))).toContain('nope.invalid could not be resolved.');
    expect(render(h(TraceResult, { result: { host: 'x.example', target: null, hops: [], reached: false, error: 'timeout' } }))).toContain('did not finish within 60 seconds');
  });
});
