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
const { default: Usage, objectParts, quotaParts, meterFor } = await import('../src/pages/panel/usage/usage.jsx');
const { JobProgress, canStreamJobs } = await import('../src/pages/panel/usage/parts/JobProgress.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', features: {}, limits: {}, suspended: 0, forcePasswordChange: 0, demoMode: 0, domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:usage/usage'];
const render = (el, panel = ctx) => renderToStaticMarkup(
  <ToastProvider><ConfirmProvider><MemoryRouter initialEntries={[fn.path]}><ShellContext.Provider value={PANEL_SHELL}><PanelContext.Provider value={panel}>{el}</PanelContext.Provider></ShellContext.Provider></MemoryRouter></ConfirmProvider></ToastProvider>,
);
const actingCtx = { ...ctx, me: { ...me, user: { id: 1, username: 'root', role: 'root' }, actingAs: { account: 'demo', by: 'root', expiresAt: null } } };

const usageData = {
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', home: '/home/demo' },
  disk: { usedMb: 512, quotaMb: 1024, percent: 50, source: 'repquota', inodes: 12000, inodeLimit: 100000, lastRefresh: '2026-11-03T02:00:00Z', breakdown: { totalKb: 524288, entries: [{ path: 'public_html', kb: 393216 }, { path: 'mail', kb: 131072 }], at: '2026-11-03T02:05:00Z' } },
  bandwidth: { usedMb: 9800, limitMb: 10240, percent: 95.7, months: [{ period: '2026-11', mb: 9800 }, { period: '2026-10', mb: 4900 }] },
  counts: { domains: 1, addons: 0, subdomains: 2, parked: 0, mailboxes: 45, forwarders: 0, autoresponders: 0, databases: 3, dbUsers: 3, ftp: 0, zones: 1 },
  limits: { max_addons: 0, max_subdomains: 10, max_parked: 0, max_domains: 1, max_email: 50, max_sql: null, max_ftp: 10, max_email_per_hour: 200, disk_mb: 1024, bandwidth_mb: 10240, quota_inodes: 100000 },
  objects: [
    { key: 'addons', used: 0, limit: 0, percent: null }, { key: 'subdomains', used: 2, limit: 10, percent: 20 }, { key: 'parked', used: 0, limit: 0, percent: null },
    { key: 'mailboxes', used: 45, limit: 50, percent: 90 }, { key: 'databases', used: 3, limit: null, percent: null }, { key: 'ftp', used: 0, limit: 10, percent: 0 },
  ],
  refresh: { lastRequestedAt: null, intervalMs: 600000 },
};

describe('Usage page', () => {
  it('shows disk, bandwidth and inode meters, the plan counters, breakdown, months and limits', () => {
    responses = { '/panel/usage': { data: usageData } };
    const html = render(<Usage fn={fn} />);
    expect(html).toContain('<h1>Usage</h1>');
    expect(html).toContain('Refresh figures');
    expect(html).toContain('data-stat="disk"');
    expect(html).toContain('<div class="value">512 MB</div><div class="muted small">of 1.00 GB</div>');
    expect(html).toContain('<div class="value">12,000</div><div class="muted small">of 100,000</div>');
    expect(html).toContain('<div class="value">3</div><div class="muted small">unlimited</div>');
    expect(html).toContain('<div class="value">0</div><div class="muted small">none in plan</div>');
    expect(html).not.toContain('font-size');
    expect(html).not.toMatch(/Refresh figures<\/button>[^]*disabled/);
    expect(html).toContain('data-meter="disk"');
    expect(html).toContain('width:50%');
    expect(html).toContain('From the file system quota');
    expect(html).toContain('data-stat="bandwidth"');
    expect(html).toContain('meter bad');
    expect(html).toContain('width:96%');
    expect(html).toContain('data-stat="inodes"');
    expect(html).toContain('<div class="value">12,000</div>');
    expect(html).toContain('What your plan includes');
    expect(html).toContain('Addon domains');
    expect(html).toContain('<div class="value">2</div><div class="muted small">of 10</div>');
    expect(html).toContain('<div class="value">45</div><div class="muted small">of 50</div>');
    expect(html).toContain('meter warn');
    expect(html).toContain('Where the space goes');
    expect(html).toContain('<code>public_html</code>');
    expect(html).toContain('384 MB');
    expect(html).toContain('width:75%');
    expect(html).toContain('<strong>512 MB</strong>');
    expect(html).toContain('href="/panel/files/disk-usage"');
    expect(html).toContain('Bandwidth by month');
    expect(html).toContain('2026-11');
    expect(html).toContain('2026-10');
    expect(html).toContain('9.57 GB');
    expect(html).toContain('Plan limits');
    expect(html).toContain('Outgoing mail per hour');
    expect(html).toContain('200');
    expect(html).toContain('<code>/home/demo</code>');
    expect(html).toContain('Figures last refreshed');
    expect(html).toContain('table-wrap');
  });

  it('shows empty states for the breakdown and months, and unlimited disk and bandwidth', () => {
    responses = { '/panel/usage': { data: { ...usageData, disk: { ...usageData.disk, quotaMb: null, inodes: null, inodeLimit: null, source: 'scan', breakdown: null, lastRefresh: null }, bandwidth: { usedMb: 0, limitMb: null, percent: null, months: [] }, limits: { ...usageData.limits, disk_mb: null, bandwidth_mb: null, max_email_per_hour: null, quota_inodes: null } } } };
    const html = render(<Usage fn={fn} />);
    expect(html).toContain('<div class="value">512 MB</div><div class="muted small">unlimited</div>');
    expect(html).toContain('<div class="value">0 B</div><div class="muted small">unlimited</div>');
    expect(html).toContain('Not measured yet');
    expect(html).not.toContain('From the last scan');
    expect(html).not.toContain('data-stat="inodes"');
    expect(html).toContain('No scan yet');
    expect(html).toContain('No traffic recorded yet');
    expect(html).toContain('Unlimited');
    expect(html).toContain('Not yet');
  });

  it('renders the 403 and 501 states', () => {
    responses = { '/panel/usage': { error: { status: 403, code: 'feature_disabled', message: 'Your hosting package does not include "usage"' } } };
    const off = render(<Usage fn={fn} />);
    expect(off).toContain('Not included in your plan');
    expect(off).not.toContain('data-stat="disk"');
    responses = { '/panel/usage': { error: { status: 501, code: 'capability_missing', message: 'Disk usage is not available', capability: 'quota' } } };
    const missing = render(<Usage fn={fn} />);
    expect(missing).toContain('Not available on this server');
    expect(missing).toContain('Disk usage is not available');
    expect(missing).toMatch(/<section class="card[^"]*"><div class="card-body"><div class="empty-state/);
    expect(missing).toMatch(/<button [^>]*disabled=""[^>]*>[^]*?Refresh figures<\/button>/);
    responses = { '/panel/usage': { error: { status: 502, code: 'agent_unavailable', message: 'The agent is not reachable' } } };
    expect(render(<Usage fn={fn} />)).toContain('The agent is not reachable');
  });

  it('job progress: a customer gets a notice instead of the admin-only job stream, an admin logged in as the account gets the live log', () => {
    expect(canStreamJobs(me)).toBe(false);
    expect(canStreamJobs(actingCtx.me)).toBe(true);
    const customer = render(<JobProgress jobId={4} onFinished={() => {}} message="Disk scan started; the figures update in a minute." />);
    expect(customer).toContain('banner banner-info');
    expect(customer).toContain('Disk scan started; the figures update in a minute.');
    expect(customer).not.toContain('progress-log');
    const admin = render(<JobProgress jobId={4} onFinished={() => {}} />, actingCtx);
    expect(admin).toContain('progress-log');
    expect(admin).not.toContain('banner-info');
  });

  it('objectParts, quotaParts and meterFor treat null as unlimited and 0 as none in plan', () => {
    expect(objectParts({ used: 3, limit: null })).toEqual({ value: '3', sub: 'unlimited' });
    expect(objectParts({ used: 0, limit: 0 })).toEqual({ value: '0', sub: 'none in plan' });
    expect(objectParts({ used: 4, limit: 10 })).toEqual({ value: '4', sub: 'of 10' });
    expect(objectParts({ used: null, limit: 10 })).toEqual({ value: '—', sub: 'of 10' });
    expect(quotaParts(512, 1024, (n) => `${n} MB`)).toEqual({ value: '512 MB', sub: 'of 1024 MB' });
    expect(quotaParts(512, null, (n) => `${n} MB`)).toEqual({ value: '512 MB', sub: 'unlimited' });
    expect(meterFor(4, 10)).toEqual({ percent: 40, tone: '' });
    expect(meterFor(9, 10)).toEqual({ percent: 90, tone: 'warn' });
    expect(meterFor(10, 10)).toEqual({ percent: 100, tone: 'bad' });
    expect(meterFor(5, null)).toEqual({ percent: null, tone: '' });
    expect(meterFor(5, 0)).toEqual({ percent: null, tone: '' });
  });
});
