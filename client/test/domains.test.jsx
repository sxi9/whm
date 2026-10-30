import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));

const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const r = path ? [...responses.entries()].find(([k]) => path.startsWith(k))?.[1] ?? null : null;
    return { data: r?.data ?? null, meta: null, error: r?.error ?? null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { DomainsPanel, defaultDocroot, DomainSteps, domainTypeLabel } = await import('../src/pages/accounts/DomainsPanel.jsx');
const { AccountSummary } = await import('../src/pages/accounts/AccountDetails.jsx');
const sslPage = await import('../src/pages/fn/ssl-tls/manage-ssl-hosts.jsx');
const ManageSslHosts = sslPage.default;
const { ServerHostnameCard, ServicePills } = sslPage;

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

const listing = {
  username: 'alice', domain: 'alice.com', home: '/home/alice', suspended: false, systemUser: true,
  domains: [
    { id: 1, domain: 'alice.com', type: 'main', docroot: '/home/alice/public_html', ssl: { id: 3, installed: 1, state: 'installed', issuer: 'CN=R3', notAfter: '2027-01-01T00:00:00.000Z', daysRemaining: 400, expired: false, autossl: true, selfSigned: false }, zone: true, vhost: { status: 'applied', error: null } },
    { id: 2, domain: 'blog.example', type: 'addon', docroot: '/home/alice/public_html/blog.example', ssl: null, zone: true, vhost: { status: 'pending', error: null } },
    { id: 3, domain: 'shop.alice.com', type: 'sub', docroot: '/home/alice/public_html/shop', ssl: { id: 4, installed: 2, state: 'pending', issuer: 'CN=R3', notAfter: '2026-11-10T00:00:00.000Z', daysRemaining: 10, expired: false, autossl: true, selfSigned: false }, zone: false, vhost: { status: 'applied', error: null } },
    { id: 4, domain: 'parked.example', type: 'parked', docroot: '/home/alice/public_html', ssl: null, zone: true, vhost: null },
  ],
  limits: { addon: { used: 1, max: 5 }, sub: { used: 1, max: null }, parked: { used: 1, max: 1 } },
  capabilities: { apache: true, bind: true, acme: true, dns: true, ssl: true, autossl: true },
};

describe('Domains panel on the account details page', () => {
  it('lists every domain with type, document root, SSL, zone and vhost state, the limits and the add form', () => {
    responses.clear();
    responses.set('/account-functions/domains/alice', { data: listing });
    const html = render(<DomainsPanel username="alice" />);
    expect(html).toContain('<h3');
    expect(html).toContain('Domains');
    for (const d of ['alice.com', 'blog.example', 'shop.alice.com', 'parked.example']) expect(html).toContain(`<code>${d}</code>`);
    expect(html).toContain('Main domain');
    expect(html).toContain('Addon');
    expect(html).toContain('Subdomain');
    expect(html).toContain('Parked');
    expect(html).toContain('/home/alice/public_html/blog.example');
    expect(html).toContain('400d · AutoSSL');
    expect(html).toContain('pending · AutoSSL');
    expect(html).toContain('none');
    expect(html).toContain('in parent zone');
    expect(html).toContain('pending');
    expect(html).toContain('Addon domains: <strong>1 of 5</strong>');
    expect(html).toContain('Subdomains: <strong>1</strong>');
    expect(html).toContain('Parked: <strong>1 of 1</strong>');
    expect(html).toContain('Parked (alias) domain (limit reached)');
    expect(html).toContain('Add domain');
    expect(html).toContain('Document root');
    expect(html).toContain('/home/alice/public_html/…');
    expect(html).toContain('Issue an AutoSSL certificate');
    expect(html).toContain('AutoSSL is enabled');
    expect(html).toContain('/ssl-tls/manage-autossl');
    expect(html).toContain('/dns-functions/park-a-domain?account=alice');
    // The main domain has no Remove action; the others do.
    expect(html.match(/>Remove</g)).toHaveLength(3);
    expect(render(<DomainsPanel username="" />)).not.toContain('domains-panel');
  });

  it('warns about a missing Linux user and a suspended account, and mounts under the account summary', () => {
    responses.clear();
    responses.set('/account-functions/domains/bob', { data: { ...listing, username: 'bob', domain: 'bob.com', home: '/home/bob', systemUser: false, suspended: true, domains: [listing.domains[0]], capabilities: { ...listing.capabilities, autossl: false } } });
    const html = render(<DomainsPanel username="bob" />);
    expect(html).toContain('no Linux user');
    expect(html).toContain('account suspended');
    expect(html).toContain('AutoSSL is disabled');
    const summary = render(<AccountSummary account={{ username: 'bob', owner: 'root', home_dir: '/home/bob', suspended: true, disk_used_mb: 1, disk_quota_mb: 10, bandwidth_used_mb: 0, bandwidth_limit_mb: null, created_at: '2026-10-30T00:00:00.000Z' }} />);
    expect(summary).toContain('Domains');
    expect(summary).toContain('Add domain');
    expect(render(<AccountSummary account={{ username: 'bob', owner: 'root' }} domains={false} />)).not.toContain('Add domain');
  });

  it('computes the default document root the way the server does and renders the step outcome', () => {
    expect(defaultDocroot('/home/alice', 'blog.example', 'addon')).toBe('/home/alice/public_html/blog.example');
    expect(defaultDocroot('/home/alice', 'shop.alice.com', 'sub', ['alice.com', 'blog.example'])).toBe('/home/alice/public_html/shop');
    expect(defaultDocroot('/home/alice', 'a.b.blog.example', 'sub', ['alice.com', 'blog.example'])).toBe('/home/alice/public_html/a.b');
    expect(defaultDocroot('/home/alice', 'x.other.com', 'sub', ['alice.com'])).toBe('/home/alice/public_html/x.other.com');
    expect(defaultDocroot('/home/alice', 'parked.example', 'parked')).toBe('/home/alice/public_html');
    expect(domainTypeLabel('sub')).toBe('Subdomain');
    const steps = renderToStaticMarkup(<DomainSteps steps={{ docroot: { status: 'applied', detail: '/home/alice/public_html/blog.example created (alice:www-data 0750), index page written' }, web: { status: 'pending', detail: 'Apache is not installed' }, ssl: { status: 'skipped', detail: 'does not resolve to this server yet' } }} />);
    expect(steps).toContain('Document root');
    expect(steps).toContain('index page written');
    expect(steps).toContain('Virtual host');
    expect(steps).toContain('Apache is not installed');
    expect(steps).toContain('AutoSSL');
    expect(steps).toContain('skipped');
  });
});

describe('Manage SSL Hosts: the server hostname row', () => {
  const fn = FUNCTION_BY_KEY['ssl-tls/manage-ssl-hosts'] || { key: 'ssl-tls/manage-ssl-hosts', label: 'Manage SSL Hosts' };
  const server = {
    hostname: 'panel.example.com', valid: true, docroot: '/var/www/whm-default',
    certificate: { id: 9, domain: 'panel.example.com', account: null, subject: 'CN=panel.example.com', issuer: "CN=R3,O=Let's Encrypt", notAfter: '2027-01-01T00:00:00.000Z', daysRemaining: 400, expired: false, state: 'installed', installed: 1, autossl: true, selfSigned: false },
    services: [
      { service: 'panel', hasCertificate: true, coversHostname: true, selfSigned: false, daysRemaining: 400, expired: false },
      { service: 'exim', hasCertificate: true, coversHostname: false, selfSigned: true, daysRemaining: 300, expired: false },
      { service: 'dovecot', hasCertificate: false, coversHostname: null, selfSigned: null, daysRemaining: null, expired: null },
      { service: 'ftp', hasCertificate: true, coversHostname: true, selfSigned: false, daysRemaining: 400, expired: false },
    ],
    renewal: { schedule: 'hostname-certificate-renew', cron: '47 3 * * *', enabled: true, nextRunAt: '2026-10-31T03:47:00.000Z', lastRunAt: null, renewDays: 30 },
    autossl: { provider: 'certbot', enabled: true, lastEntry: { runId: 4, trigger: 'manual', action: 'issued', message: 'R3 until 2027-01-01 (applied)', finishedAt: '2026-10-30T10:00:00.000Z' } },
    landing: { status: 'applied', ssl: true, docroot: '/var/www/whm-default', error: null },
    reissue: { path: '/networking/hostname/certificate', available: true },
  };
  const hosts = { hosts: [
    { id: 9, domain: 'panel.example.com', account: null, hostname: true, issuer: "CN=R3,O=Let's Encrypt", notAfter: '2027-01-01T00:00:00.000Z', daysRemaining: 400, autossl: true, state: 'installed', selfSigned: false, files: { present: true, hasKey: true } },
    { id: 2, domain: 'alice.com', account: 'alice', hostname: false, issuer: 'CN=R3', notAfter: '2027-01-01T00:00:00.000Z', daysRemaining: 300, autossl: true, state: 'installed', selfSigned: false, files: { present: true, hasKey: true } },
  ], bundleRoot: '/etc/ssl/whm', bundlesListed: true, webLinked: true };

  it('root sees the hostname card with certificate, services, renewal, AutoSSL run, landing page and the Reissue / Download actions', () => {
    responses.clear();
    responses.set('/ssl/hosts', { data: { ...hosts, serverHostname: server } });
    const html = render(<ManageSslHosts fn={fn} />);
    expect(html).toContain('Server hostname');
    expect(html).toContain('<code>panel.example.com</code>');
    expect(html).toContain('issued by R3');
    expect(html).toContain('Panel (2087): installed · 400d');
    expect(html).toContain('Exim (SMTP): other name · 300d');
    expect(html).toContain('Dovecot (IMAP/POP3): none');
    expect(html).toContain('FTP: installed · 400d');
    expect(html).toContain('47 3 * * *');
    expect(html).toContain('renews within 30 days of expiry');
    expect(html).toContain('certbot');
    expect(html).toContain('last run: issued — R3 until 2027-01-01 (applied)');
    expect(html).toContain('/var/www/whm-default · HTTPS');
    expect(html).toContain('Reissue');
    expect(html).toContain('Download');
    // The hostname's own row in the table is labelled instead of showing an account.
    expect(html).toContain('server hostname');
    expect(html).toContain('<code>alice.com</code>');
  });

  it('without a hostname row (reseller) the page is unchanged; an unqualified hostname points at Change Hostname; no certificate yet says so', () => {
    responses.clear();
    responses.set('/ssl/hosts', { data: { ...hosts, serverHostname: null } });
    const html = render(<ManageSslHosts fn={fn} />);
    expect(html).not.toContain('Server hostname');
    expect(html).toContain('Installed certificates');
    const invalid = render(<ServerHostnameCard server={{ hostname: 'localhost', valid: false, certificate: null, services: [], renewal: null, autossl: null, landing: null }} />);
    expect(invalid).toContain('No fully qualified hostname is set (localhost)');
    expect(invalid).toContain('/networking-setup/change-hostname');
    const none = render(<ServerHostnameCard server={{ ...server, certificate: null, services: server.services.map((s) => ({ ...s, hasCertificate: false })), autossl: { provider: 'disabled', enabled: false, lastEntry: null }, landing: null }} />);
    expect(none).toContain('none installed yet');
    expect(none).toContain('enable AutoSSL, then Reissue');
    expect(none).not.toContain('>Download<');
    expect(none).toContain('no hostname virtual host yet');
    expect(renderToStaticMarkup(<ServicePills services={[]} />)).toContain('—');
  });
});
