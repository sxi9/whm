import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

let responses = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const r = (path && responses[path.split('?')[0]]) || {};
    return { data: r.data ?? null, meta: r.meta ?? null, error: r.error ?? null, loading: Boolean(path) && !r.data && !r.error, refetch: () => {}, setData: () => {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { default: Usage, scanAge, ageLabel, ScanSourceNote, SCAN_STALE_MS, SCAN_OLD_MS } = await import('../src/pages/panel/usage/usage.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', features: {}, limits: {}, suspended: 0, forcePasswordChange: 0, demoMode: 0, domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:usage/usage'];
const render = (el) => renderToStaticMarkup(
  <ToastProvider><ConfirmProvider><MemoryRouter initialEntries={[fn.path]}><ShellContext.Provider value={PANEL_SHELL}><PanelContext.Provider value={ctx}>{el}</PanelContext.Provider></ShellContext.Provider></MemoryRouter></ConfirmProvider></ToastProvider>,
);

const NOW = Date.parse('2026-11-06T12:00:00Z');
const base = {
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', home: '/home/demo' },
  disk: { usedMb: 512, quotaMb: 1024, percent: 50, source: 'scan', inodes: null, inodeLimit: null, lastRefresh: null, breakdown: null },
  bandwidth: { usedMb: 0, limitMb: null, percent: null, months: [] },
  counts: {}, limits: {}, objects: [],
  refresh: { lastRequestedAt: null, intervalMs: 600000 },
};

describe('scanAge', () => {
  it('is null without a timestamp or with an unparsable one', () => {
    expect(scanAge(null, NOW)).toBeNull();
    expect(scanAge('', NOW)).toBeNull();
    expect(scanAge('yesterday', NOW)).toBeNull();
  });
  it('reads ISO and SQLite timestamps as UTC and never goes negative', () => {
    expect(scanAge('2026-11-06T11:30:00Z', NOW)).toEqual({ ms: 30 * 60000, tone: 'ok' });
    expect(scanAge('2026-11-06 11:30:00', NOW)).toEqual({ ms: 30 * 60000, tone: 'ok' });
    expect(scanAge('2026-11-06T13:00:00Z', NOW).ms).toBe(0);
  });
  it('turns warn after a day and bad after a week', () => {
    expect(scanAge(new Date(NOW - SCAN_STALE_MS + 1000).toISOString(), NOW).tone).toBe('ok');
    expect(scanAge(new Date(NOW - SCAN_STALE_MS).toISOString(), NOW).tone).toBe('warn');
    expect(scanAge(new Date(NOW - SCAN_OLD_MS).toISOString(), NOW).tone).toBe('bad');
  });
});

describe('ageLabel', () => {
  it('picks the coarsest whole unit', () => {
    expect(ageLabel(20000)).toBe('just now');
    expect(ageLabel(5 * 60000)).toBe('5 minutes ago');
    expect(ageLabel(3 * 3600000 + 59 * 60000)).toBe('3 hours ago');
    expect(ageLabel(2 * 86400000 + 3600000)).toBe('2 days ago');
  });
});

describe('ScanSourceNote', () => {
  it('renders nothing when the figures come from repquota', () => {
    expect(renderToStaticMarkup(<ScanSourceNote disk={{ source: 'repquota', lastRefresh: '2026-11-06T11:00:00Z' }} now={NOW} />)).toBe('');
  });
  it('is an info banner with the age and the date for a fresh scan', () => {
    const html = renderToStaticMarkup(<ScanSourceNote disk={{ source: 'scan', lastRefresh: '2026-11-06T09:00:00Z' }} now={NOW} />);
    expect(html).toContain('banner banner-info');
    expect(html).toContain('role="status"');
    expect(html).toContain('data-scan-source="ok"');
    expect(html).toContain('<strong>Disk figures are from a scan 3 hours ago</strong>');
    expect(html).toContain('files added or removed since then are not counted');
    expect(html).not.toContain('Refresh figures');
  });
  it('warns with the refresh hint when the scan is older than a day', () => {
    const html = renderToStaticMarkup(<ScanSourceNote disk={{ source: 'scan', lastRefresh: '2026-11-01T09:00:00Z' }} now={NOW} />);
    expect(html).toContain('banner banner-warning');
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-scan-source="warn"');
    expect(html).toContain('Disk figures are from a scan 5 days ago');
    expect(html).toContain('Use &quot;Refresh figures&quot; for a current number.');
  });
  it('warns that nothing was measured when there was never a scan', () => {
    const html = renderToStaticMarkup(<ScanSourceNote disk={{ source: 'scan', lastRefresh: null }} now={NOW} />);
    expect(html).toContain('data-scan-source="never"');
    expect(html).toContain('Disk figures have not been measured yet');
    expect(html).toContain('not a measurement');
  });
});

describe('Usage page scan note', () => {
  it('shows the note above the meters and the age under the disk tile when figures come from the scan', () => {
    const lastRefresh = new Date(Date.now() - 2 * 3600000).toISOString();
    responses = { '/panel/usage': { data: { ...base, disk: { ...base.disk, lastRefresh } } } };
    const html = render(<Usage fn={fn} />);
    expect(html).toMatch(/data-scan-source="ok"[^]*data-stat="disk"/);
    expect(html).toContain('Disk figures are from a scan 2 hours ago');
    expect(html).toContain('From the last scan, 2 hours ago');
  });
  it('keeps the quota wording and no note when repquota answers', () => {
    responses = { '/panel/usage': { data: { ...base, disk: { ...base.disk, source: 'repquota', lastRefresh: '2026-11-03T02:00:00Z' } } } };
    const html = render(<Usage fn={fn} />);
    expect(html).not.toContain('data-scan-source');
    expect(html).toContain('From the file system quota');
    expect(html).not.toContain('From the last scan');
  });
});
