import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, SESSIONS } from './support.jsx';
import { fixtureFor } from './fixtures.js';

// Fix round 3: the vendor dashboard and the Reports bars read the real
// hub/license/services/reports.js shapes ({ edition, active }, { day, created })
// and the §16.9 impersonate-reseller flow is wired end to end in the SPA.
const auth = { value: SESSIONS.vendor, impersonate: vi.fn(async () => ({ reseller_id: 'rs_acme01', reseller_name: 'Acme Resell', expires_at: '2026-10-27T12:15:00Z' })), endImpersonation: vi.fn(async () => {}) };
vi.mock('../src/auth/AuthContext.jsx', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ session: auth.value, ready: true, area: real.areaOf(auth.value), stepUp: vi.fn(), refresh: vi.fn(), logout: vi.fn(), markTotpEnabled: vi.fn(), impersonate: auth.impersonate, endImpersonation: auth.endImpersonation }) };
});
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => (path && enabled ? { ...fixtureFor(path), loading: false, error: null, refetch: () => {} } : { data: null, meta: null, loading: false, error: null, refetch: () => {} }),
}));

const { default: Dashboard, activationTotals } = await import('../src/pages/admin/Dashboard.jsx');
const { default: Reports } = await import('../src/pages/admin/Reports.jsx');
const { MiniBars } = await import('../src/widgets/index.jsx');
const { default: Resellers, ResellerDrawer, canImpersonate } = await import('../src/pages/admin/Resellers.jsx');
const { Shell, impersonationText } = await import('../src/shell/Shell.jsx');
const { impersonationOf, areaOf } = await import('../src/auth/AuthContext.jsx');

describe('vendor dashboard reads reports.dashboard() as the hub returns it', () => {
  it('sums activations_by_edition over `active` and lists each edition', () => {
    expect(activationTotals([{ edition: 'pro', active: 12 }, { edition: 'solo', active: 30 }])).toEqual({ total: 42, hint: 'pro: 12 · solo: 30' });
    // the old `n` shape is not silently accepted as a count
    expect(activationTotals([{ edition: 'pro', n: 12 }])).toEqual({ total: 0, hint: 'pro: 0' });
    expect(activationTotals(undefined)).toEqual({ total: 0, hint: 'none yet' });
  });
  it('renders the fixture (real shape) with the counts and no undefined', () => {
    const html = render(<Dashboard />, { url: '/admin' });
    expect(html).toContain('pro: 12 · solo: 30');
    expect(html).toContain('>42<');
    // check-ins per hour keep the { hour, n } shape
    expect(html).toContain('title="2026-10-26T12: 55"');
    expect(html).not.toMatch(/\bundefined\b/);
  });
});

describe('Reports › Activations over time reads { day, created }', () => {
  it('MiniBars takes the value key from the caller and the Reports page passes created/day', () => {
    expect(render(<MiniBars points={[{ day: '2026-10-25', created: 2 }, { day: '2026-10-26', created: 5 }]} valueKey="created" labelKey="day" />)).toContain('title="2026-10-26: 5"');
    const html = render(<Reports />, { url: '/admin/reports' });
    expect(html).toContain('title="2026-10-25: 2"');
    expect(html).toContain('title="2026-10-26: 5"');
    expect(html).toContain('<th>active</th>');
    expect(html).not.toMatch(/\bundefined\b/);
  });
});

describe('§16.9 impersonate-reseller in the SPA', () => {
  const me = { user: { id: 'usr_vendor', email: 'root@vendor.test', role: 'reseller_admin', reseller_id: 'rs_acme01', totp_enabled: true }, totp_verified_at: Date.now(), csrfToken: 'x', impersonating: { reseller_id: 'rs_acme01', by: 'usr_vendor', expires_at: '2026-10-27T12:15:00Z' }, reseller: { id: 'rs_acme01', name: 'Acme Resell', brand: {} } };
  it('impersonationOf reads /portal/me and the effective role routes to the reseller area', () => {
    expect(impersonationOf(me)).toEqual({ reseller_id: 'rs_acme01', by: 'usr_vendor', expires_at: '2026-10-27T12:15:00Z', reseller_name: 'Acme Resell' });
    expect(impersonationOf({ user: me.user })).toBeNull();
    expect(impersonationOf({ impersonating: 'rs_acme01' })).toBeNull();
    expect(areaOf({ kind: 'portal', user: me.user })).toBe('reseller');
  });
  it('only an active vendor_admin portal session that is not already impersonating gets the button', () => {
    const active = { id: 'rs_acme01', status: 'active' };
    expect(canImpersonate(SESSIONS.vendor, active)).toBe(true);
    expect(canImpersonate(SESSIONS.support, active)).toBe(false);
    expect(canImpersonate(SESSIONS.reseller, active)).toBe(false);
    expect(canImpersonate({ ...SESSIONS.vendor, impersonating: impersonationOf(me) }, active)).toBe(false);
    expect(canImpersonate(SESSIONS.vendor, { id: 'rs_acme01', status: 'suspended' })).toBe(false);
  });
  it('the Resellers drawer offers Impersonate to a vendor_admin and hides it from vendor_support', () => {
    auth.value = SESSIONS.vendor;
    const html = render(<ResellerDrawer id="rs_acme01" onClose={() => {}} />, { url: '/admin/resellers' });
    expect(html).toContain('>Impersonate</button>');
    expect(html).toContain('Acme Resell');
    auth.value = SESSIONS.support;
    expect(render(<ResellerDrawer id="rs_acme01" onClose={() => {}} />, { url: '/admin/resellers' })).not.toContain('Impersonate');
    auth.value = SESSIONS.vendor;
    expect(render(<Resellers />, { url: '/admin/resellers' })).not.toMatch(/\bundefined\b/);
  });
  it('the handler posts to the hub route and re-reads the session; the End action calls /portal/impersonate/end', async () => {
    // AuthContext.impersonate(): POST /admin/resellers/:id/impersonate then refresh()
    const { createApiClient } = await import('../src/api/client.js');
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url: String(url), method: init?.method }); return new Response(JSON.stringify({ data: { reseller_id: 'rs_acme01', expires_at: '2026-10-27T12:15:00Z' } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const api = createApiClient({ fetchImpl });
    api.setCsrfToken('tok');
    await api.post('/admin/resellers/rs%20x/impersonate', {});
    await api.post('/portal/impersonate/end', {});
    expect(calls.map((c) => c.url)).toEqual(['/v1/admin/resellers/rs%20x/impersonate', '/v1/portal/impersonate/end']);
    expect(calls.every((c) => c.method === 'POST')).toBe(true);
  });
  it('the Shell shows the banner with the remaining window and an End button while impersonating', () => {
    const now = Date.parse('2026-10-27T12:03:00Z');
    expect(impersonationText({ impersonating: impersonationOf(me) }, now)).toBe('Impersonating Acme Resell · 12 min left');
    expect(impersonationText({ impersonating: { reseller_id: 'rs_acme01', expires_at: '2026-10-27T11:00:00Z' } }, now)).toBe('Impersonating rs_acme01 · window expired');
    expect(impersonationText({ impersonating: { reseller_id: 'rs_acme01' } }, now)).toBe('Impersonating rs_acme01');
    expect(impersonationText(SESSIONS.vendor)).toBeNull();
    auth.value = { kind: 'portal', user: me.user, totpEnabled: true, totpVerifiedAt: Date.now(), brand: { name: 'Acme Resell' }, impersonating: impersonationOf(me) };
    const html = render(<Shell area="reseller" />, { url: '/reseller' });
    expect(html).toContain('class="impersonation-banner"');
    expect(html).toContain('Impersonating Acme Resell');
    expect(html).toContain('End impersonation');
    auth.value = SESSIONS.vendor;
    expect(render(<Shell area="admin" />, { url: '/admin' })).not.toContain('impersonation-banner');
  });
});
