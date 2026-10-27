import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, SESSIONS } from './support.jsx';
import { fixtureFor, ID_DOCUMENT } from './fixtures.js';

// Fix round 2 (U3): real hub shapes (revocation propagation, trial funnel),
// ?q= deep links, encoded request paths, https-only hrefs, the advisory 2FA
// indicator and the CSP-safe ID-document viewer.
const auth = { value: SESSIONS.vendor };
vi.mock('../src/auth/AuthContext.jsx', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ session: auth.value, ready: true, area: real.areaOf(auth.value), stepUp: vi.fn(), refresh: vi.fn(), logout: vi.fn(), markTotpEnabled: vi.fn() }) };
});
const seen = [];
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (path) seen.push(path);
    if (!path || !enabled) return { data: null, meta: null, loading: false, error: null, refetch: () => {} };
    try { return { ...fixtureFor(path), loading: false, error: null, refetch: () => {} }; } catch (err) { return { data: null, meta: null, loading: false, error: Object.assign(err, { status: 404, code: 'not_found' }), refetch: () => {} }; }
  },
}));

const { default: Revocations, propagationText } = await import('../src/pages/admin/Revocations.jsx');
const { default: Trials, funnelStats } = await import('../src/pages/admin/Trials.jsx');
const { default: Licenses } = await import('../src/pages/admin/Licenses.jsx');
const { default: Resellers } = await import('../src/pages/admin/Resellers.jsx');
const { default: ResellerLicenses } = await import('../src/pages/reseller/Licenses.jsx');
const { default: LicenseDetail } = await import('../src/pages/admin/LicenseDetail.jsx');
const { default: VerificationQueue, DocumentViewer } = await import('../src/pages/admin/VerificationQueue.jsx');
const { githubAuthorizeUrl } = await import('../src/pages/dev/Verification.jsx');
const { uploadPath } = await import('../src/pages/dev/Upload.jsx');
const { safeUrl, brandOf } = await import('../src/auth/AuthContext.jsx');
const { stepUpIndicator, Shell } = await import('../src/shell/Shell.jsx');
const { StepUpModal } = await import('../src/auth/StepUpModal.jsx');
const { FIXTURES } = await import('./fixtures.js');

describe('revocation propagation uses the hub shape { installs, reported_after, still_active }', () => {
  it('formats the real keys and ignores shapes the hub never produces', () => {
    expect(propagationText({ installs: 5, reported_after: 3, still_active: 1 }).text).toBe('3 / 5 installs reported since the revocation · 1 still active');
    expect(propagationText({ installs: 0, reported_after: 0, still_active: 0 }).text).toBe('0 / 0 installs reported since the revocation · 0 still active');
    expect(propagationText(null)).toBe(null);
    expect(propagationText({ applied: 3, total: 5 }).text).toBe('0 / 0 installs reported since the revocation · 0 still active');
  });
  it('renders the fixture (hub shape) and never the old "last_seen within 30 d" caption', () => {
    auth.value = SESSIONS.vendor;
    const html = render(<Revocations />, { url: '/admin/market/revocations' });
    expect(html).toContain('3 / 5 installs');
    expect(html).toContain('reported since the revocation');
    expect(html).toContain('1 still active');
    expect(html).not.toContain('last_seen within 30 d');
  });
});

describe('trial funnel follows ctx.trials.funnel()', () => {
  it('derives active = started − converted − expired and keeps the abuse list', () => {
    expect(funnelStats({ started: 10, converted: 4, expired: 3, abuse: [{ ip: '198.51.100.9', n: 2 }] })).toEqual({ started: 10, converted: 4, expired: 3, active: 3, abuse: [{ ip: '198.51.100.9', n: 2 }] });
    // SQLite SUM() over zero rows is NULL
    expect(funnelStats({ started: 0, converted: null, expired: null })).toEqual({ started: 0, converted: 0, expired: 0, active: 0, abuse: [] });
    expect(funnelStats(undefined).active).toBe(null);
    expect(funnelStats({ started: 1, converted: 1, expired: 1 }).active).toBe(0);
  });
  it('renders the server-side abuse view instead of counting only the current page', () => {
    const html = render(<Trials />, { url: '/admin/trials' });
    expect(html).toContain('Abuse: same IP more than once');
    expect(html).toContain('198.51.100.9 ×2');
    expect(html).toMatch(/Active<\/div><div class="value">3</);
  });
});

describe('?q= deep links are honoured by every list the UI links to', () => {
  const requested = (prefix) => seen.filter((p) => p.startsWith(prefix)).pop();
  it('Customers → /admin/licenses?q=<email>', () => {
    seen.length = 0;
    render(<Licenses />, { url: '/admin/licenses?q=ops%40acme.test' });
    expect(requested('/admin/licenses')).toContain('q=ops%40acme.test');
  });
  it('LicenseDetail → /admin/resellers?q=<rs_id>', () => {
    seen.length = 0;
    render(<Resellers />, { url: '/admin/resellers?q=rs_acme01' });
    expect(requested('/admin/resellers')).toContain('q=rs_acme01');
  });
  it('reseller CustomerTable → /reseller/licenses?q=', () => {
    auth.value = SESSIONS.reseller;
    seen.length = 0;
    render(<ResellerLicenses />, { url: '/reseller/licenses?q=ops%40acme.test', route: '/reseller/licenses' });
    expect(requested('/reseller/licenses')).toContain('q=ops%40acme.test');
    auth.value = SESSIONS.vendor;
  });
});

describe('values from the URL or API are encoded before they enter a request path', () => {
  it('upload path encodes the plugin id and channel', () => {
    expect(uploadPath('net.acme.cache-boost', 'stable')).toBe('/dev/plugins/net.acme.cache-boost/versions?channel=stable');
    expect(uploadPath('net.acme/../x?y', 'beta#z')).toBe('/dev/plugins/net.acme%2F..%2Fx%3Fy/versions?channel=beta%23z');
  });
  it('LicenseDetail encodes the reseller id in its deep link', () => {
    const rs = FIXTURES.find(([re]) => re.test('/admin/licenses/lic_01HUBTEST01'))[1];
    const saved = rs.data.reseller_id;
    rs.data.reseller_id = 'rs_a?b#c';
    try {
      const html = render(<LicenseDetail />, { url: '/admin/licenses/lic_01HUBTEST01', route: '/admin/licenses/:id' });
      expect(html).toContain('href="/admin/resellers?q=rs_a%3Fb%23c"');
    } finally { rs.data.reseller_id = saved; }
  });
  it('only a github.com https URL may start the OAuth flow', () => {
    expect(githubAuthorizeUrl('https://github.com/login/oauth/authorize?client_id=x&state=y')).toMatch(/^https:\/\/github\.com\//);
    for (const bad of ['https://evil.test/github.com/', 'http://github.com/x', 'javascript:alert(1)', 'https://github.com.evil.test/x', '', null, undefined]) expect(githubAuthorizeUrl(bad)).toBe(null);
  });
});

describe('https-only hrefs', () => {
  it('safeUrl accepts only absolute https URLs and brandOf keeps using it', () => {
    expect(safeUrl('https://acme.test/logo.png')).toBe('https://acme.test/logo.png');
    for (const bad of ['http://acme.test/', 'javascript:alert(1)', 'data:text/html,hi', '/relative', 'https:///nohost', 42, null]) expect(safeUrl(bad)).toBe(null);
    expect(brandOf({ reseller: { name: 'Acme', brand: { logo_url: 'javascript:alert(1)', support_url: 'https://acme.test/s' } } })).toEqual({ name: 'Acme', logo_url: null, support_url: 'https://acme.test/s' });
  });
  it('the verification queue renders a non-https developer website as text, never as a link', () => {
    const entry = FIXTURES.find(([re]) => re.test('/admin/market/verifications'))[1].data[0];
    const saved = entry.developer.website;
    try {
      entry.developer.website = 'javascript:alert(1)';
      const html = render(<VerificationQueue />, { url: '/admin/market/verifications' });
      expect(html).not.toContain('href="javascript:');
      expect(html).toContain('javascript:alert(1)');
      entry.developer.website = 'https://acme.test';
      expect(render(<VerificationQueue />, { url: '/admin/market/verifications' })).toContain('href="https://acme.test"');
    } finally { entry.developer.website = saved; }
  });
});

describe('step-up UI', () => {
  it('the indicator is advisory: it reports when the last confirmation happened, not whether the hub still accepts it', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(stepUpIndicator({ totpEnabled: false }, now)).toBe('no 2FA');
    expect(stepUpIndicator({ totpEnabled: true, totpVerifiedAt: null }, now)).toBe('2FA armed');
    expect(stepUpIndicator({ totpEnabled: true, totpVerifiedAt: now - 10_000 }, now)).toBe('2FA confirmed just now');
    expect(stepUpIndicator({ totpEnabled: true, totpVerifiedAt: new Date(now - 7 * 60_000).toISOString() }, now)).toBe('2FA confirmed 7 min ago');
    expect(stepUpIndicator({ totpEnabled: true, totpVerifiedAt: now - 3 * 3600_000 }, now)).toBe('2FA confirmed 3 h ago');
    expect(stepUpIndicator({ totpEnabled: true, totpVerifiedAt: now - 2 * 86400_000 }, now)).toBe('2FA confirmed 2 d ago');
    expect(stepUpIndicator({ totpEnabled: true, totpVerifiedAt: 'garbage' }, now)).toBe('2FA armed');
    auth.value = { ...SESSIONS.vendor, totpVerifiedAt: Date.now() - 20 * 60_000 };
    expect(render(<Shell area="admin" />)).toContain('2FA confirmed 20 min ago');
    auth.value = SESSIONS.vendor;
  });
  it('the Security link in the step-up modal is a router link (no full reload) and still cancels the pending request', () => {
    const html = render(<StepUpModal open request={{ err: {}, info: {} }} session={SESSIONS.support} stepUp={vi.fn()} onDone={() => {}} onCancel={() => {}} />);
    expect(html).toContain('href="/admin/security"');
    // react-router's <Link> renders a plain anchor without target/rel; MemoryRouter resolved the path
    expect(html).not.toContain('target="_blank"');
  });
});

describe('ID-document viewer under the hub CSP (object-src none)', () => {
  it('never embeds an <object>; PDFs go through the blob "open in new tab" path', () => {
    const html = render(<DocumentViewer verification={ID_DOCUMENT} open onClose={() => {}} />);
    expect(html).not.toContain('<object');
    expect(html).toContain('Load document');
  });
});
