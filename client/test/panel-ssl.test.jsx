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
const { default: SslStatus, sslSummary } = await import('../src/pages/panel/ssl/status.jsx');
const { default: InstallCertificate, certificateCandidates } = await import('../src/pages/panel/ssl/install.jsx');
const { default: Certificates, generateBody } = await import('../src/pages/panel/ssl/certificates.jsx');
const { webResult, accountDomains, parseSans, pem } = await import('../src/pages/panel/ssl/parts/Shared.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', features: {}, limits: {}, suspended: 0, forcePasswordChange: 0, demoMode: 0, domains: [{ domain: 'demo.example.com', type: 'main', docroot: '/home/demo/public_html' }, { domain: 'shop.demo.example.com', type: 'sub', docroot: '/home/demo/public_html/shop' }] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fns = { status: PANEL_FUNCTION_BY_KEY['panel:ssl/status'], install: PANEL_FUNCTION_BY_KEY['panel:ssl/install'], certificates: PANEL_FUNCTION_BY_KEY['panel:ssl/certificates'] };
const render = (el, path = '/panel/ssl/status') => renderToStaticMarkup(
  <ToastProvider><ConfirmProvider><MemoryRouter initialEntries={[path]}><ShellContext.Provider value={PANEL_SHELL}><PanelContext.Provider value={ctx}>{el}</PanelContext.Provider></ShellContext.Provider></MemoryRouter></ConfirmProvider></ToastProvider>,
);

const soon = new Date(Date.now() + 20 * 86_400_000).toISOString();
const installed = { id: 3, domain: 'demo.example.com', state: 'installed', installed: 1, subject: 'CN=demo.example.com', issuer: "C=US, O=Let's Encrypt, CN=R11", notBefore: '2026-10-01T00:00:00Z', notAfter: soon, daysRemaining: 20, expired: false, autossl: true, selfSigned: false, files: { present: true } };
const domainsData = {
  domains: [
    { domain: 'demo.example.com', type: 'main', docroot: '/home/demo/public_html', certificate: installed, autossl: { runId: 1, status: 'done', action: 'issued', message: 'ok', finishedAt: '2026-11-01T02:00:00Z' } },
    { domain: 'shop.demo.example.com', type: 'sub', docroot: '/home/demo/public_html/shop', certificate: null, autossl: null },
  ],
  autossl: { provider: 'acme.sh', enabled: true, includeWww: true },
  webLinked: true,
};
const storedCert = { id: 5, domain: 'shop.demo.example.com', accountId: 1, subject: 'CN=shop.demo.example.com', issuer: 'CN=shop.demo.example.com', notAfter: soon, daysRemaining: 20, expired: false, autossl: false, installed: 0, state: 'stored', hasCert: true, hasKey: true, hasCsr: false, hasChain: false, selfSigned: true, createdAt: '2026-11-02 10:00:00' };
const storedCsr = { id: 6, domain: 'demo.example.com', accountId: 1, subject: 'CN=demo.example.com', issuer: null, notAfter: null, daysRemaining: null, expired: null, autossl: false, installed: 0, state: 'stored', hasCert: false, hasKey: true, hasCsr: true, hasChain: false, selfSigned: false, createdAt: '2026-11-03 10:00:00' };
const FEATURE_OFF = { status: 403, code: 'feature_disabled', message: 'Your hosting package does not include "sslmanager"' };
const NO_DAEMON = { status: 501, code: 'capability_missing', message: 'openssl is not installed on this server', capability: 'ssl' };

describe('SSL status', () => {
  it('summarises the domains and lists each with its certificate, issuer, expiry and AutoSSL run', () => {
    responses = { '/panel/ssl/domains': { data: domainsData } };
    const html = render(<SslStatus fn={fns.status} />);
    expect(html).toContain('<h1>SSL status</h1>');
    expect(html).toContain('data-stat="domains"');
    expect(html).toMatch(/data-stat="secured"><div class="label">Secured<\/div><div class="value">1</);
    expect(html).toMatch(/data-stat="expiring"><div class="label">Expiring within 30 days<\/div><div class="value">1</);
    expect(html).toMatch(/data-stat="unsecured"><div class="label">Without a certificate<\/div><div class="value">1</);
    expect(html).toContain('Free certificates are issued automatically');
    expect(html).toContain('acme.sh');
    expect(html).toContain('demo.example.com');
    expect(html).toContain('shop.demo.example.com');
    expect(html).toContain('Let&#x27;s Encrypt');
    expect(html).toContain('20 days');
    expect(html).toContain('>Installed<');
    expect(html).toContain('>None<');
    expect(html).toContain('>Issued<');
    expect(html).toContain('Issue now');
    expect(html).toContain('href="/panel/ssl/install"');
    expect(html).toContain('href="/panel/ssl/certificates"');
    expect(html).toContain('table-wrap');
    expect(html).toContain('Search domains');
  });

  it('explains a disabled AutoSSL and shows the empty state without domains', () => {
    responses = { '/panel/ssl/domains': { data: { domains: [], autossl: { provider: 'disabled', enabled: false, includeWww: true }, webLinked: false } } };
    const html = render(<SslStatus fn={fns.status} />);
    expect(html).toContain('Automatic certificates are not enabled on this server');
    expect(html).toContain('No domains to secure yet');
    expect(html).not.toContain('Issue now');
  });

  it('renders the plan gate on 403 feature_disabled and the capability state on 501', () => {
    responses = { '/panel/ssl/domains': { error: FEATURE_OFF } };
    const off = render(<SslStatus fn={fns.status} />);
    expect(off).toContain('Not included in your plan');
    expect(off).toContain('SSL status is not part of the hosting plan');
    expect(off).not.toContain('data-stat="domains"');
    responses = { '/panel/ssl/domains': { error: NO_DAEMON } };
    const missing = render(<SslStatus fn={fns.status} />);
    expect(missing).toContain('Not available on this server');
    expect(missing).toContain('openssl is not installed');
    expect(missing).toContain('Re-check');
  });

  it('sslSummary counts secured, expiring and unsecured domains', () => {
    expect(sslSummary(domainsData.domains)).toEqual({ domains: 2, secured: 1, expiring: 1, unsecured: 1 });
    expect(sslSummary([{ certificate: { state: 'stored' } }, { certificate: { state: 'installed', expired: true } }])).toEqual({ domains: 2, secured: 0, expiring: 0, unsecured: 2 });
    expect(sslSummary(null)).toEqual({ domains: 0, secured: 0, expiring: 0, unsecured: 0 });
  });
});

describe('Install certificate', () => {
  it('offers the free certificate, the stored and pasted sources and shows the current certificate', () => {
    responses = { '/panel/ssl/domains': { data: domainsData }, '/panel/ssl/certs': { data: [storedCert, storedCsr], meta: { page: 1, pageSize: 200, total: 2 } } };
    const html = render(<InstallCertificate fn={fns.install} />, '/panel/ssl/install?domain=demo.example.com');
    expect(html).toContain('<h1>Install certificate</h1>');
    expect(html).toContain('<option value="demo.example.com"');
    expect(html).toContain('shop.demo.example.com (subdomain)');
    expect(html).toContain('Current certificate');
    expect(html).toContain('Let&#x27;s Encrypt');
    expect(html).toContain('Free certificate');
    expect(html).toContain('Issued by acme.sh');
    expect(html).toContain('Issue now');
    expect(html).toContain('Your own certificate');
    expect(html).toContain('-----BEGIN CERTIFICATE-----');
    expect(html).toContain('-----BEGIN PRIVATE KEY-----');
    expect(html).toContain('Chain / CA bundle');
    expect(html).toContain('>Install certificate</button>');
    expect(html).toContain('Stored certificate');
    expect(html).toContain('href="/panel/ssl/status"');
  });

  it('disables the free certificate when AutoSSL is off and preselects a stored certificate from the query', () => {
    responses = { '/panel/ssl/domains': { data: { ...domainsData, autossl: { provider: 'disabled', enabled: false, includeWww: true } } }, '/panel/ssl/certs': { data: [storedCert], meta: { page: 1, pageSize: 200, total: 1 } } };
    const html = render(<InstallCertificate fn={fns.install} />, '/panel/ssl/install?domain=shop.demo.example.com&certId=5');
    expect(html).toContain('Automatic certificates are not enabled on this server');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*<svg[^]*?Issue now/);
    expect(html).toContain('<option value="5"');
    expect(html).toContain('self-signed');
    expect(html).not.toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('renders the 403 and 501 states', () => {
    responses = { '/panel/ssl/domains': { error: FEATURE_OFF }, '/panel/ssl/certs': { error: FEATURE_OFF } };
    expect(render(<InstallCertificate fn={fns.install} />)).toContain('Not included in your plan');
    responses = { '/panel/ssl/domains': { error: NO_DAEMON }, '/panel/ssl/certs': { data: [] } };
    expect(render(<InstallCertificate fn={fns.install} />)).toContain('Not available on this server');
  });

  it('certificateCandidates matches the exact name or a wildcard one level up', () => {
    const wildcard = { ...storedCert, id: 9, domain: '*.demo.example.com' };
    expect(certificateCandidates([storedCert, storedCsr, wildcard], 'shop.demo.example.com').map((c) => c.id)).toEqual([5, 9]);
    expect(certificateCandidates([storedCert, storedCsr, wildcard], 'demo.example.com').map((c) => c.id)).toEqual([]);
    expect(certificateCandidates([storedCert, storedCsr], '').map((c) => c.id)).toEqual([5]);
  });
});

describe('Certificates', () => {
  it('lists stored items with their contents, counts and actions', () => {
    responses = { '/panel/ssl/certs': { data: [storedCert, storedCsr], meta: { page: 1, pageSize: 25, total: 2 } }, '/panel/ssl/certs/storage': { data: { items: [], counts: { key: 2, csr: 1, cert: 1 } } } };
    const html = render(<Certificates fn={fns.certificates} />, '/panel/ssl/certificates');
    expect(html).toContain('<h1>Certificates</h1>');
    expect(html).toMatch(/data-stat="cert"><div class="label">Certificates<\/div><div class="value">1</);
    expect(html).toMatch(/data-stat="key"><div class="label">Private keys<\/div><div class="value">2</);
    expect(html).toMatch(/data-stat="csr"><div class="label">Signing requests<\/div><div class="value">1</);
    expect(html).toContain('>Certificate<');
    expect(html).toContain('>Private key<');
    expect(html).toContain('>Signing request<');
    expect(html).toContain('Self-signed');
    expect(html).toContain('>Stored<');
    expect(html).toContain('1–2 of 2');
    expect(html).toContain('Generate signing request');
    expect(html).toContain('Self-signed certificate');
    expect(html).toContain(' Upload</button>');
    expect(html).toContain('>Install</button>');
    expect(html).toContain('never downloadable');
    expect(html).toContain('role="tablist"');
  });

  it('shows the empty state when nothing is stored', () => {
    responses = { '/panel/ssl/certs': { data: [], meta: { page: 1, pageSize: 25, total: 0 } }, '/panel/ssl/certs/storage': { data: { items: [], counts: { key: 0, csr: 0, cert: 0 } } } };
    const html = render(<Certificates fn={fns.certificates} />, '/panel/ssl/certificates');
    expect(html).toContain('Nothing stored yet');
    expect(html).toContain('signing request for your certificate authority');
  });

  it('renders the 403 and 501 states', () => {
    responses = { '/panel/ssl/certs': { error: FEATURE_OFF }, '/panel/ssl/certs/storage': { error: FEATURE_OFF } };
    expect(render(<Certificates fn={fns.certificates} />, '/panel/ssl/certificates')).toContain('Not included in your plan');
    responses = { '/panel/ssl/certs': { error: NO_DAEMON }, '/panel/ssl/certs/storage': { error: NO_DAEMON } };
    expect(render(<Certificates fn={fns.certificates} />, '/panel/ssl/certificates')).toContain('Not available on this server');
  });

  it('generateBody builds the API body for a CSR', () => {
    const body = generateBody({ domain: ' *.Demo.example.com ', sans: 'www.demo.example.com, shop.demo.example.com\nwww.demo.example.com', key: { type: 'rsa', bits: '4096', curve: 'prime256v1' }, subject: { O: 'Demo ', OU: '', C: 'DE', L: ' ', ST: '', emailAddress: '' } });
    expect(body).toEqual({ domain: '*.demo.example.com', sans: ['www.demo.example.com', 'shop.demo.example.com'], key: { type: 'rsa', bits: 4096 }, subject: { O: 'Demo', C: 'DE' } });
    expect(generateBody({ domain: 'a.example.com', sans: '', key: { type: 'ec', bits: '2048', curve: 'secp384r1' }, subject: {} }).key).toEqual({ type: 'ec', curve: 'secp384r1' });
  });

  it('shared helpers: web result, account domains, SAN parsing and PEM trailing newline', () => {
    expect(webResult('applied')).toEqual({ applied: true });
    expect(webResult('pending', 'The web server category is not loaded')).toEqual({ applied: false, reason: 'The web server category is not loaded' });
    expect(accountDomains(me).map((d) => d.domain)).toEqual(['demo.example.com', 'shop.demo.example.com']);
    expect(accountDomains({ account: { domain: 'only.example.com', domains: [] } })).toEqual([{ domain: 'only.example.com', type: 'main', docroot: null }]);
    expect(parseSans(' A.example.com,b.example.com\n a.example.com ')).toEqual(['a.example.com', 'b.example.com']);
    expect(pem('  -----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----  ')).toBe('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');
    expect(pem('')).toBe('');
  });
});
