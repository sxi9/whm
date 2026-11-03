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
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { default: AccessLogs, downloadHref } = await import('../src/pages/panel/logs/access-logs.jsx');
const { default: Bandwidth, limitText, monthRows, peakOf } = await import('../src/pages/panel/logs/bandwidth.jsx');
const { periodLabel, currentPeriod, filesForDomain, domainOfFile } = await import('../src/pages/panel/logs/parts/shared.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: {}, features: { rawlog: true }, limits: { bandwidth_mb: 10240 }, domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fnLogs = PANEL_FUNCTION_BY_KEY['panel:logs/access-logs'];
const fnBw = PANEL_FUNCTION_BY_KEY['panel:logs/bandwidth'];
const render = (el, path) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });

const listing = { kind: 'apache', domains: ['demo.example.com', 'shop.demo.example.com'], files: [
  { name: 'demo.example.com', size: 51200, mtime: '2026-11-03T08:00:00Z', location: 'server' },
  { name: 'demo.example.com-ssl_log', size: 2048, mtime: '2026-11-03T08:00:00Z', location: 'server' },
  { name: 'shop.demo.example.com-Oct-2026.gz', size: 900000, mtime: '2026-11-01T00:00:00Z', location: 'home' },
], warnings: [], apache: true, nginx: false };
const retention = { archiveLogs: true, removeOldArchives: false, retainMonths: 3, lastArchivedAt: '2026-11-01 00:05:00', archiveDir: '/home/demo/logs' };

describe('Access logs page', () => {
  it('renders the pickers, the tail, the retention toggles and the file table', () => {
    fixtures.responses.clear();
    set('/panel/logs?kind=apache', { data: listing });
    set('/panel/logs/retention', { data: retention });
    set('/panel/logs/tail?kind=apache&file=demo.example.com&bytes=65536', { data: { file: 'demo.example.com', size: 51200, offset: 0, length: 51200, truncated: false, content: '1.2.3.4 - - [03/Nov/2026] "GET / HTTP/1.1" 200 512\n', mtime: '2026-11-03T08:00:00Z' } });
    const html = render(h(AccessLogs, { fn: fnLogs }), fnLogs.path);
    expect(html).toContain('<h1>Access logs</h1>');
    expect(html).toContain('id="logs-kind"');
    expect(html).toContain('NGINX (not installed)');
    expect(html).toContain('id="logs-domain"');
    expect(html).toContain('shop.demo.example.com');
    expect(html).toContain('id="logs-file"');
    expect(html).toContain('Refresh every 5 seconds');
    expect(html).toContain('href="/api/panel/logs/download?kind=apache&amp;file=demo.example.com"');
    expect(html).toContain('Tail of demo.example.com');
    expect(html).toContain('<pre class="log">1.2.3.4');
    expect(html).toContain('Log retention');
    expect(html).toContain('Archive logs monthly');
    expect(html).toContain('<code>/home/demo/logs</code>');
    expect(html).toContain('3 files for all domains');
    expect(html).toContain('Your logs folder');
    expect(html).toContain('879 KB');
    expect(html).toContain('>View<');
  });

  it('renders the capability state on 501 and keeps the pickers', () => {
    fixtures.responses.clear();
    set('/panel/logs?kind=apache', { error: { status: 501, code: 'capability_missing', message: 'Apache is not installed on this server' } });
    set('/panel/logs/retention', { error: { status: 501, code: 'capability_missing', message: 'Apache is not installed on this server' } });
    const html = render(h(AccessLogs, { fn: fnLogs }), fnLogs.path);
    expect(html).toContain('Not available on this server');
    expect(html).toContain('Apache is not installed on this server');
    expect(html).toContain('id="logs-kind"');
    expect(html).toContain('once the web server is available');
  });

  it('renders the plan state on 403 feature_disabled', () => {
    fixtures.responses.clear();
    set('/panel/logs?kind=apache', { error: { status: 403, code: 'feature_disabled', message: 'off' } });
    const html = render(h(AccessLogs, { fn: fnLogs }), fnLogs.path);
    expect(html).toContain('Not included in your plan');
    expect(html).toContain('Access logs is not part of the hosting plan');
  });

  it('shows the empty state when no file exists', () => {
    fixtures.responses.clear();
    set('/panel/logs?kind=apache', { data: { ...listing, files: [], warnings: ['/var/log/apache2/domlogs/demo was skipped: refused'] } });
    set('/panel/logs/retention', { data: retention });
    const html = render(h(AccessLogs, { fn: fnLogs }), fnLogs.path);
    expect(html).toContain('Some log locations were skipped');
    expect(html).toContain('Nothing selected');
    expect(html).toContain('No log files exist yet');
    expect(html).toContain('No log files yet');
  });

  it('helpers: downloadHref, filesForDomain, domainOfFile, periodLabel, currentPeriod', () => {
    expect(downloadHref('nginx', 'a b')).toBe('/api/panel/logs/download?kind=nginx&file=a%20b');
    expect(filesForDomain(listing.files, 'shop.demo.example.com').map((f) => f.name)).toEqual(['shop.demo.example.com-Oct-2026.gz']);
    expect(filesForDomain(listing.files, '').length).toBe(3);
    expect(domainOfFile('shop.demo.example.com-ssl_log', listing.domains)).toBe('shop.demo.example.com');
    expect(domainOfFile('other', listing.domains)).toBe(null);
    expect(periodLabel('2026-11')).toMatch(/November 2026/);
    expect(currentPeriod(new Date(2026, 0, 5))).toBe('2026-01');
  });
});

describe('Bandwidth page', () => {
  const now = currentPeriod();
  const data = { domain: 'demo.example.com', limitMb: 10240, months: [
    { period: '2026-09', bytes: 1024 * 1024 * 1500, usedMb: 1500, percent: 15 },
    { period: '2026-10', bytes: 1024 * 1024 * 9000, usedMb: 9000, percent: 88 },
    { period: now, bytes: 1024 * 1024 * 512, usedMb: 512, percent: 5 },
  ], sources: [{ path: '/var/log/apache2/domlogs/demo/demo.example.com', bytes: 123456, lastSeenAt: '2026-11-03T08:00:00Z' }] };

  it('renders the stat tiles, the monthly table with meters and the sources', () => {
    fixtures.responses.clear();
    set('/panel/logs/bandwidth?months=12', { data });
    const html = render(h(Bandwidth, { fn: fnBw }), fnBw.path);
    expect(html).toContain('<h1>Bandwidth</h1>');
    expect(html).toContain('Monthly limit');
    expect(html).toContain('10.0 GB');
    expect(html).toContain('512 MB');
    expect(html).toContain('5% of 10.0 GB');
    expect(html).toContain('Busiest month shown');
    expect(html).toContain('8.79 GB');
    expect(html).toContain('id="bw-months"');
    expect(html).toContain('Of the monthly limit');
    expect(html).toContain('width:88%');
    expect(html).toContain('meter warn');
    expect(html).toContain('September 2026');
    expect(html).toContain('How traffic is counted');
    expect(html).toContain('/var/log/apache2/domlogs/demo/demo.example.com');
    expect(html).toContain('121 KB processed');
  });

  it('handles unlimited plans and empty histories', () => {
    fixtures.responses.clear();
    set('/panel/logs/bandwidth?months=12', { data: { ...data, limitMb: null, months: [], sources: [] } });
    const html = render(h(Bandwidth, { fn: fnBw }), fnBw.path);
    expect(html).toContain('Unlimited');
    expect(html).toContain('No monthly limit in this plan');
    expect(html).toContain('No traffic recorded yet');
    expect(html).toContain('No logs read yet');
  });

  it('renders 501, 503 and 403 states', () => {
    fixtures.responses.clear();
    set('/panel/logs/bandwidth?months=12', { error: { status: 501, code: 'capability_missing', message: 'no web server' } });
    expect(render(h(Bandwidth, { fn: fnBw }), fnBw.path)).toContain('Not available on this server');
    set('/panel/logs/bandwidth?months=12', { error: { status: 503, code: 'service_unavailable', message: 'The Account Information category is not loaded' } });
    expect(render(h(Bandwidth, { fn: fnBw }), fnBw.path)).toContain('Temporarily unavailable');
    set('/panel/logs/bandwidth?months=12', { error: { status: 403, code: 'feature_disabled', message: 'off' } });
    expect(render(h(Bandwidth, { fn: fnBw }), fnBw.path)).toContain('Not included in your plan');
  });

  it('helpers: limitText, monthRows, peakOf', () => {
    expect(limitText(null)).toBe('Unlimited');
    expect(limitText(0)).toBe('Unlimited');
    expect(limitText(1024)).toBe('1.00 GB');
    expect(monthRows(data.months)[0].period).toBe(now);
    expect(peakOf(data.months)).toBe(1024 * 1024 * 9000);
  });
});
