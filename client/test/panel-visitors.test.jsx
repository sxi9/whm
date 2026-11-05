import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY, visibleCategories } = await import('../src/panel/nav.js');
const { default: Visitors, reportHref, pickDomain, generateState } = await import('../src/pages/panel/logs/visitors.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: {}, features: { webstats: true }, limits: {}, domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:logs/visitors'];
const render = (el, path) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });

const summary = {
  version: 1, domain: 'demo.example.com', generatedAt: '2026-11-05T01:50:00.000Z', period: { start: '04/Nov/2026', end: '05/Nov/2026' },
  totals: { requests: 222, validRequests: 222, failedRequests: 0, visitors: 60, files: 15, notFound: 75, referrers: 5, bandwidth: 1088699, logBytes: 36264 },
  days: [{ label: '20261105', date: '2026-11-05', hits: 22, visitors: 5, bytes: 88699 }, { label: '20261104', date: '2026-11-04', hits: 200, visitors: 55, bytes: 1000000 }],
  pages: [{ label: '/', hits: 74, visitors: 46, bytes: 724513 }, { label: '/about', hits: 10, visitors: 4, bytes: 100 }],
  staticFiles: [], notFound: [{ label: '/favicon.ico', hits: 11, visitors: 0, bytes: 26340 }],
  referrers: [{ label: 'example.org', hits: 11, visitors: 3, bytes: 31536 }], countries: [],
  statusCodes: [{ label: '2xx Success', hits: 111, visitors: 60, bytes: 820950 }], browsers: [], os: [],
};
const data = {
  goaccess: { installed: true, version: '1.9.4' }, cooldownSeconds: 600, schedule: '50 1 * * *',
  domains: [
    { domain: 'demo.example.com', type: 'main', available: true, generatedAt: '2026-11-05T01:50:00.000Z', error: null, running: null, cooldownUntil: null, summary },
    { domain: 'shop.demo.example.com', type: 'sub', available: false, generatedAt: null, error: null, running: { id: 9, status: 'running' }, cooldownUntil: null, summary: null },
  ],
};

describe('Visitors page', () => {
  it('is a Logs function gated by webstats', () => {
    expect(fn).toMatchObject({ label: 'Visitors', path: '/panel/logs/visitors', feature: 'webstats', categorySlug: 'logs' });
    expect(visibleCategories({ webstats: false }).find((c) => c.slug === 'logs').functions.map((f) => f.slug)).not.toContain('visitors');
  });

  it('renders the stat tiles, top lists, daily table and the domain table', () => {
    fixtures.responses.clear();
    set('/panel/logs/stats', { data });
    const html = render(h(Visitors, { fn }), fn.path);
    expect(html).toContain('<h1>Visitors</h1>');
    expect(html).toContain('GoAccess 1.9.4');
    expect(html).toContain('id="visitors-domain"');
    expect(html).toContain('shop.demo.example.com (no report yet)');
    expect(html).toContain('Unique visitors');
    expect(html).toContain('>60<');
    expect(html).toContain('>222<');
    expect(html).toContain('1.04 MB');
    expect(html).toContain('04/Nov/2026 – 05/Nov/2026');
    expect(html).toContain('Top pages');
    expect(html).toContain('<code class="small">/about</code>');
    expect(html).toContain('Referring sites');
    expect(html).toContain('example.org');
    expect(html).toContain('Not found');
    expect(html).toContain('/favicon.ico');
    expect(html).toContain('Responses');
    expect(html).toContain('2xx Success');
    expect(html).toContain('Visitors per day');
    expect(html).toContain('2026-11-04');
    expect(html).toContain('Generate again');
    expect(html).toContain('Open full report');
    expect(html).toContain('href="/api/panel/logs/stats/demo.example.com/report"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('All domains');
    expect(html).toContain('pill pill-ok">Ready');
    expect(html).toContain('pill pill-info">Generating');
    expect(html).toContain('>Show<');
  });

  it('shows the empty state for a domain without a report and the capability, plan and 503 states', () => {
    fixtures.responses.clear();
    set('/panel/logs/stats', { data: { ...data, domains: [{ domain: 'demo.example.com', type: 'main', available: false, generatedAt: null, error: null, running: null, cooldownUntil: null, summary: null }] } });
    const empty = render(h(Visitors, { fn }), fn.path);
    expect(empty).toContain('No report yet for demo.example.com');
    expect(empty).toContain('Generate now');
    expect(empty).toContain('No report to open');
    expect(empty).not.toContain('Unique visitors');
    set('/panel/logs/stats', { error: { status: 501, code: 'capability_missing', message: 'GoAccess is not installed on this server' } });
    const missing = render(h(Visitors, { fn }), fn.path);
    expect(missing).toContain('Not available on this server');
    expect(missing).toContain('GoAccess is not installed on this server');
    set('/panel/logs/stats', { error: { status: 403, code: 'feature_disabled', message: 'off' } });
    expect(render(h(Visitors, { fn }), fn.path)).toContain('Not included in your plan');
    set('/panel/logs/stats', { error: { status: 503, code: 'service_unavailable', message: 'The Account Functions category is not loaded' } });
    expect(render(h(Visitors, { fn }), fn.path)).toContain('Temporarily unavailable');
    fixtures.responses.clear();
    expect(render(h(Visitors, { fn }), fn.path)).toContain('Loading…');
  });

  it('helpers: reportHref, pickDomain, generateState', () => {
    expect(reportHref('a b.example')).toBe('/api/panel/logs/stats/a%20b.example/report');
    expect(pickDomain(data.domains, 'shop.demo.example.com')).toBe('shop.demo.example.com');
    expect(pickDomain([data.domains[1], data.domains[0]], '')).toBe('demo.example.com');
    expect(pickDomain([data.domains[1]], 'nope')).toBe('shop.demo.example.com');
    expect(pickDomain([], '')).toBe('');
    expect(generateState(null)).toEqual({ disabled: true, label: 'Generate now' });
    expect(generateState(data.domains[0])).toEqual({ disabled: false, label: 'Generate again' });
    expect(generateState(data.domains[1])).toEqual({ disabled: true, label: 'Generating…' });
    expect(generateState({ running: { status: 'queued' } })).toEqual({ disabled: true, label: 'Queued' });
    const soon = new Date(Date.now() + 60_000).toISOString();
    expect(generateState({ available: false, cooldownUntil: soon }).disabled).toBe(true);
    expect(generateState({ available: false, cooldownUntil: soon }).label).toMatch(/^Again at /);
    expect(generateState({ available: false, cooldownUntil: new Date(Date.now() - 1000).toISOString() })).toEqual({ disabled: false, label: 'Generate now' });
  });
});
