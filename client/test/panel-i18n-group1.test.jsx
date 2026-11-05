// Pseudo-locale pass for page group 1 (overview, domains, dns, ssl, files): every
// page and dialog renders with a t() that answers the key, and no English sentence
// may remain in text nodes or in title/placeholder/aria-label attributes. Strings
// the shared kit renders (components/, panel/) are the kit's own i18n work and are
// listed in KIT_STRINGS so this test stays about the group's pages.
import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const f = path ? fixtures.responses.get(path) || fixtures.responses.get(path.split('?')[0]) || null : null;
    return { data: f?.data ?? null, meta: f?.meta ?? null, error: f?.error ?? null, loading: Boolean(path) && !f, refetch: () => {}, setData: () => {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));
vi.mock('../src/i18n/useT.js', () => {
  const t = (key) => key;
  return {
    useT: () => ({ t, locale: 'xx', loaded: true, enabled: [], defaultLocale: 'en', reload: () => {} }),
    translate: t,
    preferredLocale: () => null,
    setPreferredLocale: async () => {},
    adoptUserLocale: () => false,
    loadActiveLocale: async () => ({}),
  };
});

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const en = (await import('../src/i18n/en.json')).default;
const { default: AccountDetails } = await import('../src/pages/panel/overview/account.jsx');
const { default: Preferences } = await import('../src/pages/panel/overview/preferences.jsx');
const { default: Domains } = await import('../src/pages/panel/domains/domains.jsx');
const { default: AddonDomains, AddonForm } = await import('../src/pages/panel/domains/addon-domains.jsx');
const { default: Subdomains, SubdomainForm } = await import('../src/pages/panel/domains/subdomains.jsx');
const { default: ParkedDomains, ParkedForm } = await import('../src/pages/panel/domains/parked-domains.jsx');
const { default: Redirects, RedirectForm } = await import('../src/pages/panel/domains/redirects.jsx');
const { LimitNotice, RemoveDomainModal, RequestError: DomainRequestError } = await import('../src/pages/panel/domains/parts/shared.jsx');
const { default: ZoneEditor, RecordForm, RECORD_TYPES } = await import('../src/pages/panel/dns/zone-editor.jsx');
const { default: SslStatus } = await import('../src/pages/panel/ssl/status.jsx');
const { default: InstallCertificate } = await import('../src/pages/panel/ssl/install.jsx');
const { default: Certificates } = await import('../src/pages/panel/ssl/certificates.jsx');
const { JobProgress: SslJobProgress, CertificateSummary } = await import('../src/pages/panel/ssl/parts/Shared.jsx');
const { default: FileManager } = await import('../src/pages/panel/files/file-manager.jsx');
const { default: DiskUsage } = await import('../src/pages/panel/files/disk-usage.jsx');
const { default: DirectoryPrivacy } = await import('../src/pages/panel/files/directory-privacy.jsx');
const { default: Indexes } = await import('../src/pages/panel/files/indexes.jsx');
const { CompressModal, ExtractModal } = await import('../src/pages/panel/files/parts/ArchiveModals.jsx');
const { PermissionsModal } = await import('../src/pages/panel/files/parts/PermissionsModal.jsx');
const { UploadModal } = await import('../src/pages/panel/files/parts/UploadModal.jsx');
const { FileEditor } = await import('../src/pages/panel/files/parts/FileEditor.jsx');

React.useLayoutEffect = React.useEffect;

// Strings of components outside pages/panel/<group> (shared kit and shell).
const KIT_STRINGS = [
  'Not available on this server', 'Ask your hosting provider to enable it. Everything else in the account panel keeps working.', 'The service behind this screen is not installed.',
  'Not included in your plan', 'is not part of the hosting plan on this account.', 'Ask your hosting provider about upgrading the plan.', 'Back to the dashboard',
  'Select all', 'More actions', 'No results', 'Nothing to show', 'Previous page', 'Next page', 'Select row', 'Loading…', 'Retry', 'Close', 'Cancel',
  'Add to favorites', 'Remove from favorites', 'Favorite', 'Something went wrong', 'Search…', 'Sort by', 'Show password', 'Hide password',
  'Managed elsewhere', 'Public DNS for', 'is managed at', 'Add these records there', 'not published from here', 'Delegated here',
  'Generate password', /\bSelect [^\n"]+/g,
];

const me = {
  user: { id: 7, username: 'demo', email: 'owner@demo.example.com', role: 'user', totpEnabled: false, locale: null },
  account: {
    username: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', package: 'starter', contactEmail: 'owner@demo.example.com', homeDir: '/home/demo', shell: '/usr/sbin/nologin',
    createdAt: '2026-11-01T00:00:00Z', features: { cron: false, filemanager: true, addondomains: true, subdomains: true, parkeddomains: true, redirects: true }, limits: { disk_mb: 1024, bandwidth_mb: null, max_email: 10, max_sql: 0, max_addons: 2 },
    suspended: 0, forcePasswordChange: 0, demoMode: 1, domains: [{ domain: 'demo.example.com', type: 'main', docroot: '/home/demo/public_html' }, { domain: 'shop.demo.example.com', type: 'sub', docroot: '/home/demo/public_html/shop' }],
  },
  preferences: { email: 'owner@demo.example.com', email2: '', notify: { quota: true, bandwidth: false, passwordChange: true }, locale: null, locales: [{ code: 'en', name: 'english' }], defaultLocale: 'en' },
  usage: { diskUsedMb: 512, diskQuotaMb: 1024, bandwidthUsedMb: 10, bandwidthLimitMb: null },
  counts: { domains: 1, subdomains: 1, addons: 0, parked: 0, mailboxes: 9, forwarders: 0, databases: 3, ftp: 0 },
  actingAs: null, policy: { require2fa: true, passwordSynced: false }, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: (k) => me.account.features[k] !== false };
const render = (el, path = '/panel') => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const fn = (key) => PANEL_FUNCTION_BY_KEY[`panel:${key}`];
const set = (path, value) => fixtures.responses.set(path, value);

const soon = new Date(Date.now() + 20 * 86_400_000).toISOString();
const cert = { id: 3, domain: 'demo.example.com', state: 'installed', installed: 1, issuer: 'CN=R11', notBefore: '2026-10-01T00:00:00Z', notAfter: soon, daysRemaining: 20, expired: false, autossl: true, selfSigned: false, commonName: 'demo.example.com', issuerCommonName: 'R11', sans: ['www.demo.example.com'], keyAlgorithm: 'RSA', keyBits: 2048, fingerprintSha256: 'ab:cd' };
const domainRows = [
  { id: 1, domain: 'demo.example.com', type: 'main', docroot: '/home/demo/public_html', phpVersion: null, createdAt: '2026-11-01 10:00:00', vhost: { status: 'active', error: null }, ssl: { installed: true, state: 'installed', issuer: 'R11', daysRemaining: 3 }, delegation: { delegatedHere: false, provider: 'cloudflare', nameservers: ['ns1.example'] } },
  { id: 2, domain: 'second.example.org', type: 'addon', docroot: '/home/demo/public_html/second.example.org', createdAt: '2026-11-02 10:00:00', vhost: { status: 'pending', error: 'apache missing' }, ssl: null },
  { id: 3, domain: 'shop.demo.example.com', type: 'sub', docroot: '/home/demo/public_html/shop', createdAt: '2026-11-02 11:00:00', vhost: null, ssl: null },
  { id: 4, domain: 'demo-alias.net', type: 'parked', docroot: '/home/demo/public_html', createdAt: '2026-11-02 12:00:00', vhost: { status: 'failed', error: 'config_invalid' }, ssl: { installed: false, state: 'pending' } },
];

function seed() {
  fixtures.responses.clear();
  set('/panel/domains', { data: domainRows, meta: { counts: { main: 1, addon: 1, sub: 1, parked: 1 }, limits: { max_addons: 1, max_subdomains: null, max_parked: 0 } } });
  set('/panel/dns/zones', { data: { zones: [{ id: 2, domain: 'demo.example.com', serial: 2026110301, ttl: 14400, type: 'master', dnssecEnabled: true, updatedAt: '2026-11-03 21:18:42', records: 2, sync: [{ cluster: 'ns-cluster', status: 'synced' }] }, { id: 3, domain: 'second.example.org', serial: 1, ttl: 3600, records: 0, sync: [] }], types: RECORD_TYPES } });
  set('/panel/dns/zones/demo.example.com', { data: { id: 2, domain: 'demo.example.com', serial: 2026110301, ttl: 14400, published: false, records: [{ id: 13, name: '@', type: 'A', ttl: null, priority: null, value: '127.0.0.1' }, { id: 17, name: '@', type: 'MX', ttl: null, priority: 10, value: 'mail.demo.example.com.' }], types: RECORD_TYPES, delegation: { delegatedHere: null } } });
  set('/panel/ssl/domains', { data: { domains: [{ domain: 'demo.example.com', type: 'main', certificate: cert, autossl: { status: 'done', action: 'issued', message: 'ok', finishedAt: '2026-11-01T02:00:00Z' } }, { domain: 'shop.demo.example.com', type: 'sub', certificate: null, autossl: null }], autossl: { provider: 'acme.sh', enabled: true, includeWww: true }, webLinked: true } });
  set('/panel/ssl/certs', { data: [{ id: 5, domain: 'shop.demo.example.com', state: 'stored', hasCert: true, hasKey: true, hasCsr: false, hasChain: true, selfSigned: true, notAfter: soon, daysRemaining: 20, createdAt: '2026-11-02 10:00:00', autossl: false }, { id: 6, domain: 'demo.example.com', state: 'stored', hasCert: false, hasKey: true, hasCsr: true, hasChain: false, createdAt: '2026-11-03 10:00:00' }], meta: { page: 1, pageSize: 25, total: 2 } });
  set('/panel/ssl/certs/storage', { data: { items: [], counts: { key: 2, csr: 1, cert: 1 } } });
  set('/panel/files/list', { data: { path: 'public_html', entries: [{ name: 'assets', type: 'dir', size: 4096, mtime: '2026-11-01T10:00:00.000Z', mode: '0755' }, { name: '.htaccess', type: 'file', size: 231, mtime: '2026-10-30T08:00:00.000Z', mode: '0644' }, { name: 'site.tar.gz', type: 'file', size: 5 * 1024 * 1024, mtime: '2026-11-02T12:30:00.000Z', mode: '0600' }, { name: 'www', type: 'symlink', size: 11, mtime: '2026-10-01T00:00:00.000Z', mode: '0777' }], total: 9000, truncated: true } });
  set('/panel/files/du', { data: { path: '.', depth: 2, totalKb: 1000, entries: [{ path: 'public_html', kb: 600 }, { path: 'public_html/assets', kb: 200 }, { path: 'mail', kb: 250 }], partial: true, measuredAt: '2026-11-03T10:00:00.000Z', cached: true } });
  set('/panel/files/privacy', { data: { path: 'public_html/private', domain: 'demo.example.com', protected: true, realm: 'members', users: ['alice'], max: 200, managed: true } });
  set('/panel/files/indexes', { data: { path: 'public_html', domain: 'demo.example.com', indexes: 'inherit', managed: false } });
}

// Text nodes plus the attributes a visitor reads, with the kit's strings removed.
function visibleText(html) {
  const attrs = [...html.matchAll(/\b(?:title|placeholder|aria-label)="([^"]*)"/g)].map((m) => m[1]);
  const text = html.replace(/<style[^]*?<\/style>/g, ' ').replace(/<[^>]+>/g, '\n');
  let out = [text, ...attrs].join('\n').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const s of KIT_STRINGS) out = typeof s === 'string' ? out.split(s).join(' ') : out.replace(s, ' ');
  return out;
}

const ENGLISH = /\b[A-Z][a-z]+ [a-z]+\b/;

function leaks(html) {
  const text = visibleText(html);
  return text.split('\n').map((l) => l.trim()).filter((l) => ENGLISH.test(l));
}

const pages = {
  'overview/account': () => render(h(AccountDetails, { fn: fn('overview/account') }), '/panel/overview/account'),
  'overview/preferences': () => render(h(Preferences, { fn: fn('overview/preferences') }), '/panel/overview/preferences'),
  'domains/domains': () => render(h(Domains, { fn: fn('domains/domains') }), '/panel/domains/domains'),
  'domains/addon-domains': () => render(h(AddonDomains, { fn: fn('domains/addon-domains') }), '/panel/domains/addon-domains'),
  'domains/subdomains': () => render(h(Subdomains, { fn: fn('domains/subdomains') }), '/panel/domains/subdomains'),
  'domains/parked-domains': () => render(h(ParkedDomains, { fn: fn('domains/parked-domains') }), '/panel/domains/parked-domains'),
  'domains/redirects': () => render(h(Redirects, { fn: fn('domains/redirects') }), '/panel/domains/redirects'),
  'dns/zone-editor': () => render(h(ZoneEditor, { fn: fn('dns/zone-editor') }), '/panel/dns/zone-editor'),
  'ssl/status': () => render(h(SslStatus, { fn: fn('ssl/status') }), '/panel/ssl/status'),
  'ssl/install': () => render(h(InstallCertificate, { fn: fn('ssl/install') }), '/panel/ssl/install?domain=shop.demo.example.com&certId=5'),
  'ssl/certificates': () => render(h(Certificates, { fn: fn('ssl/certificates') }), '/panel/ssl/certificates'),
  'files/file-manager': () => render(h(FileManager, { fn: fn('files/file-manager') }), '/panel/files/file-manager?path=public_html'),
  'files/disk-usage': () => render(h(DiskUsage, { fn: fn('files/disk-usage') }), '/panel/files/disk-usage?depth=2'),
  'files/directory-privacy': () => render(h(DirectoryPrivacy, { fn: fn('files/directory-privacy') }), '/panel/files/directory-privacy?path=public_html/private'),
  'files/indexes': () => render(h(Indexes, { fn: fn('files/indexes') }), '/panel/files/indexes'),
};

const dialogs = {
  AddonForm: () => render(h(AddonForm, { open: true, onClose: () => {}, onCreated: () => {}, createZoneDefault: false, mainDomain: domainRows[0] })),
  SubdomainForm: () => render(h(SubdomainForm, { open: true, parents: ['demo.example.com'], delegations: { 'demo.example.com': domainRows[0].delegation }, onClose: () => {}, onCreated: () => {} })),
  ParkedForm: () => render(h(ParkedForm, { open: true, target: 'demo.example.com', onClose: () => {}, onCreated: () => {} })),
  RedirectForm: () => render(h(RedirectForm, { open: true, domains: ['demo.example.com'], initial: { domain: 'demo.example.com', targetUrl: 'https://x.example/', type: 'temporary', matchWww: true, keepPath: true }, onClose: () => {}, onSaved: () => {} })),
  RemoveDomainModal: () => render(h(RemoveDomainModal, { open: true, domain: 'second.example.org', onClose: () => {}, onConfirm: async () => {}, options: [] })),
  LimitNotice: () => render(h(LimitNotice, { count: 0, limit: 0, noun: 'x' })) + render(h(LimitNotice, { count: 2, limit: 2, noun: 'x' })),
  DomainRequestError: () => render(h(DomainRequestError, { error: { status: 409, code: 'limit_reached', message: 'server message' } })),
  RecordForm: () => ['A', 'MX', 'SRV', 'CAA', 'TXT', 'CNAME'].map((type) => render(h(RecordForm, { zone: { domain: 'demo.example.com', ttl: 14400 }, initial: { id: 1, name: 'x', type, ttl: null, priority: 1, value: type === 'SRV' ? '1 2 h' : type === 'CAA' ? '0 iodef mailto:a@b.c' : 'v' }, types: RECORD_TYPES, onClose: () => {}, onSaved: () => {} }))).join(''),
  SslJobProgress: () => render(h(SslJobProgress, { jobId: 1, onFinished: () => {} })),
  CertificateSummary: () => render(h(CertificateSummary, { certificate: { ...cert, selfSigned: true }, chain: { ok: false, error: null } })),
  CompressModal: () => render(h(CompressModal, { paths: ['a', 'b'], dir: 'public_html', onClose: () => {} })),
  ExtractModal: () => render(h(ExtractModal, { archive: 'site.tar.gz', onClose: () => {} })),
  PermissionsModal: () => render(h(PermissionsModal, { entry: { name: 'assets', type: 'dir', mode: '0755' }, path: 'assets', onClose: () => {} })),
  UploadModal: () => render(h(UploadModal, { open: true, dir: '', onClose: () => {} })),
  FileEditor: () => render(h(FileEditor, { open: true, path: 'notes.txt', onClose: () => {} })),
};

describe('page group 1 under a pseudo-locale', () => {
  for (const [name, make] of Object.entries(pages)) {
    it(`${name} shows keys, not English`, () => {
      seed();
      const html = make();
      expect(html).toContain(`panel.${name}.label`);
      expect(leaks(html)).toEqual([]);
    });
  }
  for (const [name, make] of Object.entries(dialogs)) {
    it(`${name} shows keys, not English`, () => {
      seed();
      expect(leaks(make())).toEqual([]);
    });
  }

  it('every group key the pages ask for exists in en.json with its English fallback', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../src/pages/panel');
    const sources = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.jsx?$/.test(e.name)) sources.push(fs.readFileSync(p, 'utf8')); } };
    for (const g of ['overview', 'domains', 'dns', 'ssl', 'files']) walk(path.join(root, g));
    const STR = "'((?:[^'\\\\]|\\\\.)*)'";
    const re = new RegExp(`\\b(?:t|translate)\\(\\s*${STR}\\s*,\\s*${STR}`, 'g');
    const missing = [];
    let seen = 0;
    for (const src of sources) {
      for (const m of src.matchAll(re)) {
        if (!/^panel\.(overview|domains|dns|ssl|files)\./.test(m[1])) continue;
        seen += 1;
        if (en[m[1]] !== m[2].replace(/\\'/g, "'")) missing.push(m[1]);
      }
    }
    expect(seen).toBeGreaterThan(500);
    expect(missing).toEqual([]);
    for (const key of ['panel.domains.filter_all', 'panel.domains.type_sub', 'panel.ssl.kind_csr', 'panel.files.index_on_help', 'panel.files.perm_x', 'panel.files.who_others', 'panel.overview.notify_quota_help', 'panel.files.n_items_one', 'panel.files.n_items_other']) expect(en[key], key).toBeTruthy();
  });
});
