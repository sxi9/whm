import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

const auth = { user: { id: 1, username: 'root', role: 'root' } };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ ...auth, refresh: async () => {} }) }));

const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const r = [...responses.entries()].find(([k]) => path?.startsWith(k))?.[1] ?? null;
    return { data: r?.data ?? null, meta: null, error: r?.error ?? null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { CloudflareZoneCard, CloudflareSetupCard } = await import('../src/pages/dns/CloudflarePanel.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(
  <ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>,
);
const zone = (over = {}) => ({ domain: 'alice.com', account: 'alice', provider: 'bind', cloudflareZoneId: null, status: null, syncedAt: null, lastError: null, configured: true, canLink: true, pendingRetry: null, log: [], ...over });

describe('Cloudflare zone card', () => {
  it('offers Link only to root (canLink from the API), and explains the rule to a reseller', () => {
    responses.set('/dns/zones/alice.com/cloudflare', { data: zone() });
    const root = render(<CloudflareZoneCard domain="alice.com" />);
    expect(root).toContain('Link to Cloudflare');
    responses.set('/dns/zones/alice.com/cloudflare', { data: zone({ canLink: false }) });
    const reseller = render(<CloudflareZoneCard domain="alice.com" />);
    expect(reseller).not.toContain('Link to Cloudflare');
    expect(reseller).toContain('done by the root administrator');
  });

  it('lets a reseller import and push a zone root linked for them, but never unlink it', () => {
    const linked = zone({ provider: 'cloudflare', cloudflareZoneId: 'fedcba9876543210fedcba9876543210', status: 'ok', canLink: false });
    responses.set('/dns/zones/alice.com/cloudflare', { data: linked });
    const html = render(<CloudflareZoneCard domain="alice.com" />);
    expect(html).toContain('Import from Cloudflare');
    expect(html).toContain('Push to Cloudflare');
    expect(html).not.toContain('>Unlink<');
    responses.set('/dns/zones/alice.com/cloudflare', { data: { ...linked, canLink: true } });
    expect(render(<CloudflareZoneCard domain="alice.com" />)).toContain('>Unlink<');
  });

  it('shows a scheduled retry with its attempt number and the last error', () => {
    responses.set('/dns/zones/alice.com/cloudflare', { data: zone({ provider: 'cloudflare', cloudflareZoneId: 'fedcba9876543210fedcba9876543210', status: 'failed', lastError: 'Cloudflare: rate limited', pendingRetry: { at: '2026-10-30T03:20:00.000Z', attempt: 2 } }) });
    const html = render(<CloudflareZoneCard domain="alice.com" />);
    expect(html).toContain('Retry scheduled');
    expect(html).toContain('Attempt 2 runs at');
    expect(html).toContain('Cloudflare: rate limited');
  });

  it('tells a reseller that root links zones instead of inviting them to link', () => {
    auth.user = { id: 7, username: 'resell1', role: 'reseller' };
    responses.set('/dns/cloudflare/status', { data: { configured: true, verifiedAt: null, linked: [], failed: 0 } });
    const html = render(<CloudflareSetupCard />);
    expect(html).toContain('ask root to link a zone');
    expect(html).not.toContain('Replace token');
  });
});
