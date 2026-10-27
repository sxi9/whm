import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, SESSIONS } from './support.jsx';
import { fixtureFor, PAYOUT, ID_DOCUMENT } from './fixtures.js';

// Fix round 1 (U3): portal Security page, reseller SKUs, ID-document viewer,
// payout statements, scheduler shape, audit filter, developer sessions and the
// reseller brand. Pages render through react-dom/server against the fixtures;
// flows that need a DOM are covered as the pure functions the pages call.
const auth = { value: SESSIONS.vendor, markTotpEnabled: vi.fn(), refresh: vi.fn() };
vi.mock('../src/auth/AuthContext.jsx', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ session: auth.value, ready: true, area: real.areaOf(auth.value), stepUp: vi.fn(), refresh: auth.refresh, logout: vi.fn(), markTotpEnabled: auth.markTotpEnabled }) };
});
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!path || !enabled) return { data: null, meta: null, loading: false, error: null, refetch: () => {} };
    try { return { ...fixtureFor(path), loading: false, error: null, refetch: () => {} }; } catch (err) { return { data: null, meta: null, loading: false, error: Object.assign(err, { status: 404, code: 'not_found' }), refetch: () => {} }; }
  },
}));

const { default: PortalSecurity, PortalTotpPanel } = await import('../src/pages/admin/Security.jsx');
const { skuField, IssueLicenseModal } = await import('../src/pages/admin/Licenses.jsx');
const { issuableEditions, issuableProducts, KNOWN_SKUS } = await import('../src/pages/reseller/Licenses.jsx');
const { idDocumentOf, documentDataUrl, DocumentViewer } = await import('../src/pages/admin/VerificationQueue.jsx');
const { statementSummary, StatementModal } = await import('../src/pages/admin/Payouts.jsx');
const { SchedulesPanel } = await import('../src/pages/admin/Integrations.jsx');
const { auditActionFilter, ACTION_FILTER_RE } = await import('../src/pages/admin/Audit.jsx');
const { brandOf } = await import('../src/auth/AuthContext.jsx');
const { FormModal } = await import('../src/widgets/index.jsx');

describe('portal Security page (vendor + reseller)', () => {
  it('offers TOTP enrolment and warns while 2FA is off', () => {
    auth.value = SESSIONS.support;
    const html = render(<PortalSecurity home="/admin" />);
    expect(html).toContain('Start enrolment');
    expect(html).toContain('Two-factor authentication is off');
    expect(html).toContain('Change password');
    expect(html).not.toContain('Disable 2FA');
    expect(html).toContain('href="/admin"');
    auth.value = SESSIONS.vendor;
  });

  it('offers disable / replace-secret once enabled, for resellers too', () => {
    auth.value = SESSIONS.reseller;
    const html = render(<PortalSecurity home="/reseller" />);
    expect(html).toContain('Disable 2FA');
    expect(html).toContain('Replace secret');
    expect(html).not.toContain('Two-factor authentication is off');
    expect(html).toContain('href="/reseller"');
    expect(render(<PortalTotpPanel />)).toContain('id="portal-totp-code"');
    auth.value = SESSIONS.vendor;
  });
});

describe('reseller SKUs come from a catalog or a free SKU input, never a synthesized name', () => {
  it('issuable editions ignore trial and exhausted quotas', () => {
    expect(issuableEditions({ solo: 98, pro: 0, reseller: -1, trial: -1, enterprise: 0 })).toEqual(['solo', 'reseller']);
    expect(issuableEditions(null)).toEqual([]);
  });

  it('filters the hub catalog to active products of issuable editions', () => {
    const catalog = fixtureFor('/reseller/products').data;
    const out = issuableProducts({ solo: 98, pro: 50, reseller: 5, enterprise: 0 }, catalog);
    expect(out.products.map((p) => p.sku)).toEqual(['whm-pro-annual', 'whm-solo-monthly']);
    expect(out.suggestions).toEqual([]);
    const field = skuField({ products: out.products, suggestions: out.suggestions, withTerm: true });
    expect(field.type).toBe('select');
    expect(field.options.map((o) => o.value)).toEqual(['whm-pro-annual', 'whm-solo-monthly']);
    expect(field.options[0].label).toBe('Pro (annual) (pro, annual)');
  });

  it('falls back to a SKU input with the seeded SKUs as suggestions when the hub has no catalog route', () => {
    const out = issuableProducts({ solo: 98, pro: 50, reseller: 5, enterprise: 0 }, null);
    expect(out.products).toBe(null);
    expect(out.suggestions).toEqual([...KNOWN_SKUS.solo, ...KNOWN_SKUS.pro, ...KNOWN_SKUS.reseller]);
    expect(out.suggestions).not.toContain('whm-reseller-annual');
    const field = skuField({ products: out.products, suggestions: out.suggestions });
    expect(field.type).toBeUndefined();
    expect(field.required).toBe(true);
    expect(field.suggestions).toContain('whm-reseller-annual-5');
    const html = render(<FormModal open title="t" fields={[field]} onClose={() => {}} onSubmit={() => {}} />);
    expect(html).toContain('list="sku-suggestions"');
    expect(html).toContain('<datalist id="sku-suggestions">');
    expect(html).toContain('value="whm-reseller-annual-5"');
    const issue = render(<IssueLicenseModal reseller open base="/reseller" products={null} skuSuggestions={out.suggestions} onClose={() => {}} onIssued={() => {}} />);
    expect(issue).toContain('Product SKU');
    expect(issue).not.toContain('<select');
  });

  it('an empty catalog also falls back rather than offering no product', () => {
    const out = issuableProducts({ enterprise: 1 }, []);
    expect(out.products).toBe(null);
    expect(out.suggestions).toEqual(['whm-enterprise']);
  });
});

describe('verification queue ID document', () => {
  it('picks the id_document verification row (dvf_…), not the developer id', () => {
    const rows = fixtureFor('/admin/market/verifications?status=pending').data[0].verifications;
    expect(idDocumentOf(rows).id).toBe('dvf_02DOC');
    expect(idDocumentOf(rows).id).not.toMatch(/^dev_/);
    expect(idDocumentOf([{ method: 'dns_txt' }])).toBe(null);
    expect(idDocumentOf([{ id: 'dvf_x', method: 'id_document', has_document: false }])).toBe(null);
    expect(idDocumentOf(null)).toBe(null);
  });

  it('renders the JSON envelope as a data: URL of the returned content type', () => {
    expect(documentDataUrl({ content_type: 'image/png', data: 'aGVsbG8=' })).toBe('data:image/png;base64,aGVsbG8=');
    expect(documentDataUrl({ data: 'aGVsbG8=' })).toBe('data:application/octet-stream;base64,aGVsbG8=');
    expect(documentDataUrl(null)).toBe(null);
    const html = render(<DocumentViewer verification={ID_DOCUMENT} open onClose={() => {}} />);
    expect(html).toContain('Load document');
    expect(html).toContain('developer.verification.document_view');
    expect(html).not.toContain('/v1/admin/market/verifications/dev_');
  });
});

describe('payout statement', () => {
  it('summarises the inline statement instead of opening a non-existent route', () => {
    const out = statementSummary(PAYOUT);
    expect(out.purchases).toEqual(['pur_01ABC', 'pur_02ABC']);
    expect(out.refunds).toEqual(['pur_03ABC']);
    expect(out.items.find(([k]) => k === 'Net')[1]).toBe('$385.70');
    const html = render(<StatementModal payout={PAYOUT} onClose={() => {}} />);
    expect(html).toContain('Statement pay_01ABC');
    expect(html).toContain('pur_03ABC');
    expect(html).toContain('Paid purchases (2)');
    expect(html).toContain('Refunded purchases (1)');
    expect(statementSummary(null).purchases).toEqual([]);
    expect(render(<StatementModal payout={null} onClose={() => {}} />)).not.toContain('modal');
  });
});

describe('schedules panel reads the scheduler.list() shape', () => {
  it('shows lastRunAt, runs, lastResult and lastError', () => {
    const html = render(<SchedulesPanel />);
    expect(html).toContain('expire-licenses');
    expect(html).toContain('{&quot;expired&quot;:0}');
    expect(html).toContain('ENOTFOUND acme.test');
    expect(html).toContain('<td>12</td>');
    expect(html).toContain('never');
    expect(html).not.toContain('undefined');
  });
});

describe('audit action filter', () => {
  it('only sends values the hub schema accepts, lower-cased', () => {
    expect(auditActionFilter('License.')).toBe('license.');
    expect(auditActionFilter('  review.approve ')).toBe('review.approve');
    expect(auditActionFilter('l')).toBe('');
    expect(auditActionFilter('license-issue')).toBe('');
    expect(auditActionFilter('x'.repeat(61))).toBe('');
    expect(auditActionFilter('')).toBe('');
    expect(ACTION_FILTER_RE.source).toBe('^[a-z_.]{2,60}$');
  });
});

describe('reseller brand from /portal/me', () => {
  it('accepts name/logo/support from reseller.brand and ignores non-https URLs', () => {
    expect(brandOf({ user: { reseller_id: 'rs_1' }, reseller: { id: 'rs_1', name: 'Acme Resell', brand: { name: 'Acme Licenses', logo_url: 'https://acme.test/l.png', support_url: 'javascript:alert(1)' } } }))
      .toEqual({ name: 'Acme Licenses', logo_url: 'https://acme.test/l.png', support_url: null });
    expect(brandOf({ reseller: { name: 'Acme Resell', brand: {} } })).toEqual({ name: 'Acme Resell', logo_url: null, support_url: null });
    expect(brandOf({ user: {} })).toBe(null);
    expect(brandOf({ brand: 'nope' })).toBe(null);
  });
});
