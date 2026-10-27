import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, SESSIONS } from './support.jsx';
import { fixtureFor } from './fixtures.js';

// Every page is rendered against a scripted useApi (and the real
// useListQuery on top of it) with the session the area needs.
const auth = { value: SESSIONS.vendor };
vi.mock('../src/auth/AuthContext.jsx', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ session: auth.value, ready: true, area: real.areaOf(auth.value), stepUp: vi.fn(), refresh: vi.fn(), logout: vi.fn(), markTotpEnabled: vi.fn() }) };
});
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => (path && enabled ? { ...fixtureFor(path), loading: false, error: null, refetch: () => {} } : { data: null, meta: null, loading: false, error: null, refetch: () => {} }),
}));

const pages = import.meta.glob('../src/pages/**/*.jsx', { eager: true });
const page = (name) => pages[`../src/pages/${name}.jsx`].default;

// [page, url, route pattern (for params), session, expected strings]
const CASES = [
  ['admin/Dashboard', '/admin', null, 'vendor', ['Verification queue', 'Re-sign backlog', 'pro: 12', 'Review queue', '$580.00']],
  ['admin/Licenses', '/admin/licenses?status=active', null, 'vendor', ['WHM-7K3Q', 'ops@acme.test', 'Issue license', 'Bulk issue', '1 / 1']],
  ['admin/LicenseDetail', '/admin/licenses/lic_01HUBTEST01', '/admin/licenses/:id', 'vendor', ['License WHM-7K3Q', 'srv1.acme.test', 'Deactivate', 'Lift re-activation limit', 'net.whm.sample-notes@1.0.0', 'marketplace_paid', 'Revoke', 'Re-key']],
  ['admin/Customers', '/admin/customers', null, 'vendor', ['Acme GmbH', 'ops@acme.test', 'New customer']],
  ['admin/Resellers', '/admin/resellers', null, 'vendor', ['Acme Resell', 'New reseller', 'solo: 2']],
  ['admin/Products', '/admin/products', null, 'vendor', ['whm-pro-annual', '$299.00', 'unlimited', 'marketplace_paid', 'New product']],
  ['admin/Trials', '/admin/trials', null, 'vendor', ['WHM-TR1A', '×2', 'Convert', 'Started']],
  ['admin/Integrations', '/admin/integrations', null, 'vendor', ['whk_abcdefgh', 'Create API key', 'Signing-key rotation', 'Outbound webhooks']],
  ['admin/Reports', '/admin/reports', null, 'vendor', ['Active activations by edition', 'export.csv?table=licenses', 'Panel versions']],
  ['admin/Audit', '/admin/audit', null, 'vendor', ['license.issue', 'portal:usr_vendor', 'Marketplace']],
  ['admin/SigningKeys', '/admin/signing-keys', null, 'vendor', ['a91f3c2e', '7b2d4e10', '0c1d2e3f', 'Activate', 'Re-sign backlog', 'Run re-sign job now', 'New plugin key']],
  ['admin/VerificationQueue', '/admin/market/verifications', null, 'vendor', ['Acme Hosting', 'net.acme', 'passed', 'Approve', 'Reject', 'Request more evidence', '1 rejection(s) in 90 d', '3f9a1c77']],
  ['admin/Developers', '/admin/market/developers/dev_01ABC', '/admin/market/developers/:id', 'vendor', ['Acme Hosting', 'Suspend', 'Trigger re-verification', 'Revenue share (70%)', 'login_new_ip', 'developer.verify']],
  ['admin/ReviewQueue', '/admin/market/reviews', null, 'vendor', ['Cache Boost', '2.1.0', 'high', '1 / 2', 'Acme Hosting']],
  ['admin/ReviewDetail', '/admin/market/reviews/rev_01ABC', '/admin/market/reviews/:id', 'vendor', ['Two reviewers required', 'net:outbound:api.acme.test (new)', 'no justification given', 'undeclared_fetch', 'Approve &amp; sign', 'Request changes', 'Reject', 'portal:usr_sup']],
  ['admin/Catalog', '/admin/market/catalog/net.acme.cache-boost', '/admin/market/catalog/:id', 'vendor', ['Cache Boost', 'featured', 'Takedown', 'Publish', 'Performance', 'enterprise']],
  ['admin/Revocations', '/admin/market/revocations', null, 'vendor', ['net.evil.miner', 'critical', '3 / 5 installs', 'Emergency kill-switch']],
  ['admin/Entitlements', '/admin/market/entitlements', null, 'vendor', ['net.acme.cache-boost', 'one_time', 'Grant entitlement', 'Purchases']],
  ['admin/Payouts', '/admin/market/payouts', null, 'vendor', ['$385.70', 'pending', 'Close period', 'Approve']],
  ['admin/ReviewModeration', '/admin/market/plugin-reviews', null, 'vendor', ['Solid', 'burst flag', 'Publish', 'Hide', '★★★★☆']],
  ['reseller/Dashboard', '/reseller', null, 'reseller', ['solo licenses left', '98', 'WHM-7K3Q', '$120.00', 'rs@acme.test']],
  ['reseller/Licenses', '/reseller/licenses/lic_01HUBTEST01', '/reseller/licenses/:id', 'reseller', ['Issue license', 'WHM-7K3Q', 'srv1.acme.test', 'Renew', 'Deactivate']],
  ['reseller/Customers', '/reseller/customers', null, 'reseller', ['My customers', 'ops@acme.test']],
  ['reseller/Activations', '/reseller/activations', null, 'reseller', ['Show servers', 'WHM-7K3Q', '1 / 1']],
  ['reseller/ApiKeys', '/reseller/api-keys', null, 'reseller', ['Create API key', 'No API keys', 'Webhooks']],
  ['reseller/Statement', '/reseller/statement', null, 'reseller', ['$120.00', '2026-10', 'WHM-7K3Q', '$60.00']],
  ['dev/Register', '/dev/register', null, null, ['Register as a developer', 'Create account', 'display name']],
  ['dev/VerifyEmail', '/dev/verify-email', null, null, ['E-mail verification', 'needs the']],
  ['dev/Profile', '/dev', null, 'developer', ['Acme Hosting', 'Verified — you can publish', 'Change e-mail', 'Payout details', 'net.acme']],
  ['dev/Security', '/dev/security', null, 'developer', ['Two-factor authentication', 'Disable 2FA', 'Sign out everywhere', 'this session']],
  ['dev/Verification', '/dev/verification', null, 'developer', ['net.acme', 'acme.test', 'Claim', 'Re-check', 'whm-dev-verify=whm-dev-abc123']],
  ['dev/Keys', '/dev/keys', null, 'developer', ['3f9a1c77', 'Request a challenge', 'Revoke']],
  ['dev/Plugins', '/dev/plugins', null, 'developer', ['Cache Boost', 'net.acme.cache-boost', '29.00 USD one-time', 'New listing']],
  ['dev/PluginEdit', '/dev/plugins/net.acme.cache-boost', '/dev/plugins/:id', 'developer', ['Cache Boost', 'Save listing &amp; pricing', 'icon #0', 'Upload version', 'value="2900"']],
  ['dev/Versions', '/dev/plugins/net.acme.cache-boost/versions', '/dev/plugins/:id/versions', 'developer', ['2.1.0', '2.0.0', 'in_review', 'published', 'Yank', '0 rejects · 1 flags']],
  ['dev/VersionDetail', '/dev/plugins/net.acme.cache-boost/versions/2.1.0', '/dev/plugins/:id/versions/:v', 'developer', ['Changes requested', 'undeclared_permission', 'main.js:88', 'store:own', 'At least 20 characters', 'keeps cache statistics per account']],
  ['dev/Upload', '/dev/plugins/net.acme.cache-boost/upload', '/dev/plugins/:id/upload', 'developer', ['Upload a version', 'net.acme.cache-boost', 'X-WHM', 'Permission justifications'.slice(0, 10)]],
  ['dev/Stats', '/dev/plugins/net.acme.cache-boost/stats', '/dev/plugins/:id/stats', 'developer', ['Install count', '120', 'enabled: 100', '$40.60', 'Downloads per day']],
  ['dev/Payouts', '/dev/payouts', null, 'developer', ['$385.70', 'statement.csv', 'pending', 'No payout details on file']],
  ['dev/ApiKeys', '/dev/api-keys', null, 'developer', ['github-actions', 'version:upload', 'Create key', 'X-Dev-Api-Key']],
  ['dev/Webhooks', '/dev/webhooks', null, 'developer', ['https://ci.acme.test/hook', 'version.published', 'Add webhook']],
];

describe('every portal page renders against the mocked API', () => {
  it('covers all 41 page modules', () => {
    const names = Object.keys(pages).map((k) => k.replace('../src/pages/', '').replace('.jsx', ''));
    const covered = new Set(CASES.map((c) => c[0]));
    for (const n of names) expect(covered.has(n), `missing case for ${n}`).toBe(true);
    expect(names).toHaveLength(41);
  });

  for (const [name, url, route, session, expected] of CASES) {
    it(`${name} renders ${url}`, () => {
      auth.value = session ? SESSIONS[session] : null;
      const Page = page(name);
      const html = render(<Page />, { url, route });
      for (const text of expected) expect(html, `${name} should contain "${text}"`).toContain(text);
      expect(html).not.toContain('[object Object]');
      expect(html).not.toMatch(/\bundefined\b/);
      auth.value = SESSIONS.vendor;
    });
  }

  it('Upload page helpers encode headers the hub decodes', async () => {
    const { encodeHeader, parseJustifications } = await import('../src/pages/dev/Upload.jsx');
    expect(Buffer.from(encodeHeader('- faster'), 'base64').toString('utf8')).toBe('- faster');
    expect(JSON.parse(Buffer.from(encodeHeader({ a: 'ü' }), 'base64').toString('utf8'))).toEqual({ a: 'ü' });
    expect(parseJustifications('store:own: keeps notes per account\nnet:outbound:api.acme.test = fetches rates\nnot a scope line')).toEqual({ 'store:own': 'keeps notes per account', 'net:outbound:api.acme.test': 'fetches rates' });
  });

  it('Verification page derives the domain of a namespace per §18.2', async () => {
    const { domainOfNamespace } = await import('../src/pages/dev/Verification.jsx');
    expect(domainOfNamespace('net.acme')).toBe('acme.net');
    expect(domainOfNamespace('Net.Acme.Plugins')).toBe('plugins.acme.net');
  });

  it('developer status hints follow the §18.2 state machine', async () => {
    const { statusHint } = await import('../src/pages/dev/Profile.jsx');
    expect(statusHint({ email_verified: false })).toMatch(/Verify your e-mail/);
    expect(statusHint({ email_verified: true, totp_enabled: false })).toMatch(/two-factor/);
    expect(statusHint({ email_verified: true, totp_enabled: true, namespaces: [] })).toMatch(/Claim a namespace/);
    expect(statusHint({ email_verified: true, totp_enabled: true, namespaces: ['net.acme'], status: 'pending', verified_at: null })).toMatch(/Waiting for the vendor/);
    expect(statusHint({ email_verified: true, totp_enabled: true, namespaces: ['net.acme'], status: 'pending', verified_at: 'x' })).toMatch(/Re-verification pending/);
    expect(statusHint({ email_verified: true, totp_enabled: true, namespaces: ['net.acme'], status: 'verified', verified_at: 'x' })).toMatch(/can publish/);
  });
});
