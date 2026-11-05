// Pseudo-locale pass for page group 3 (databases, security, logs, usage, software,
// advanced) and the panel shell: every page renders with a t() that answers the key,
// so any English sentence left in the markup is a string that escaped the catalogue.
import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user', totpEnabled: false }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (p) => ({ data: null, meta: null, error: null, loading: Boolean(p), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(p) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));
vi.mock('../src/i18n/useT.js', () => {
  const t = (key) => key;
  return { useT: () => ({ t, locale: 'xx', loaded: true, enabled: ['xx'], defaultLocale: 'en', reload: () => {} }), translate: t, preferredLocale: () => 'xx', setPreferredLocale: async () => ({}), adoptUserLocale: () => false, loadActiveLocale: async () => ({}) };
});

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { PanelHome } = await import('../src/panel/PanelHome.jsx');
const { PanelTopBar } = await import('../src/panel/PanelTopBar.jsx');
const { PanelPageHeader, PanelFunctionPage, PanelNotFoundPage, PanelCapabilityState, FeatureDisabledState, PendingPill } = await import('../src/panel/PanelPage.jsx');
const { default: Databases } = await import('../src/pages/panel/databases/databases.jsx');
const { default: DbUsers } = await import('../src/pages/panel/databases/users.jsx');
const { default: RemoteHosts } = await import('../src/pages/panel/databases/remote-hosts.jsx');
const { default: PhpMyAdmin } = await import('../src/pages/panel/databases/phpmyadmin.jsx');
const { GrantsModal } = await import('../src/pages/panel/databases/parts/GrantsEditor.jsx');
const { default: Password } = await import('../src/pages/panel/security/password.jsx');
const { default: TwoFactor } = await import('../src/pages/panel/security/two-factor.jsx');
const { default: SshKeys } = await import('../src/pages/panel/security/ssh-keys.jsx');
const { default: Sessions } = await import('../src/pages/panel/security/sessions.jsx');
const { default: Tokens } = await import('../src/pages/panel/security/tokens.jsx');
const { default: IpBlocker } = await import('../src/pages/panel/security/ip-blocker.jsx');
const { default: AccessLogs } = await import('../src/pages/panel/logs/access-logs.jsx');
const { default: Bandwidth } = await import('../src/pages/panel/logs/bandwidth.jsx');
const { default: Visitors } = await import('../src/pages/panel/logs/visitors.jsx');
const { default: Usage } = await import('../src/pages/panel/usage/usage.jsx');
const { JobProgress } = await import('../src/pages/panel/usage/parts/JobProgress.jsx');
const { default: WordPress } = await import('../src/pages/panel/software/wordpress.jsx');
const { default: ErrorPages } = await import('../src/pages/panel/advanced/error-pages.jsx');

React.useLayoutEffect = React.useEffect;

const ROOT = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/en.json'), 'utf8'));

const me = {
  user: { id: 7, username: 'demo', role: 'user', totpEnabled: false, mustChangePassword: false },
  account: { username: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', homeDir: '/home/demo', shell: '/bin/bash', package: 'starter', plan: { max_sql: 10, bandwidth_mb: 10240 }, contactEmail: 'owner@demo.example.com', features: {}, limits: { max_email: 10 }, suspended: 0, forcePasswordChange: 0, demoMode: 0, domains: [{ domain: 'shop.demo.example.com', type: 'sub', docroot: '/home/demo/public_html/shop' }] },
  usage: { diskUsedMb: 120, diskQuotaMb: 1024, bandwidthUsedMb: 10, bandwidthLimitMb: null }, counts: { domains: 1, mailboxes: 2, databases: 2, ftp: 0, addons: 0, subdomains: 1 },
  actingAs: null, policy: { require2fa: false, passwordSynced: false, apiTokensRequire2fa: true }, hostname: 'srv1.example', csrfToken: 't',
};
const acting = { account: 'demo', by: 'root', expiresAt: new Date(Date.now() + 20 * 60000).toISOString() };
const ctxFor = (over = {}) => ({ me: { ...me, ...over }, loading: false, error: null, reload: () => {}, hasFeature: () => true });
const fn = (key) => PANEL_FUNCTION_BY_KEY[`panel:${key}`];
const render = (el, entry = '/panel', ctx = ctxFor()) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [entry] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (p, value) => fixtures.responses.set(`/panel${p}`, { loading: false, ...value });
const capability = { status: 501, code: 'capability_missing', message: 'daemon missing (server text)' };
const disabled = { status: 403, code: 'feature_disabled', message: 'off' };
const noHome = { status: 409, code: 'no_home', message: 'no home yet (server text)' };

// Strings the shared kit prints itself (components/*, outside this page group);
// the brand link's "<company> home" carries the operator's company name.
const KIT = ['More actions', 'Select all', 'Previous page', 'Next page', 'No results', 'No records to show yet', 'Show password', 'Hide password', 'Generate password', 'Request ID', 'Are you sure?', 'Keel home'];
const decode = (s) => s.replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// Visible text and the spoken attributes, minus code samples; a capitalised word
// followed by a lowercase word is an English sentence, a key never has a space.
export function leaks(html) {
  let s = html.replace(/<(code|pre|kbd)\b[^>]*>[\s\S]*?<\/\1>/g, ' ');
  const texts = [...s.matchAll(/(?:aria-label|placeholder|title)="([^"]*)"/g)].map((m) => m[1]);
  s = s.replace(/<[^>]+>/g, '\n');
  texts.push(...s.split('\n'));
  return [...new Set(texts.map(decode).map((x) => x.trim()).filter((x) => x && !KIT.some((k) => x.includes(k)) && /[A-Z][a-z]+ [a-z]+/.test(x)))];
}

const dbRows = [{ name: 'demo_shop', sizeBytes: 1572864, tables: 12, charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', onServer: true, users: ['demo_app'], created_at: '2026-11-01 10:00:00' }, { name: 'demo_blog', sizeBytes: null, tables: null, charset: null, onServer: null, users: [], created_at: null }];
const dbMeta = { total: 2, engine: 'mysql', engineError: { code: 'timeout', message: 'connection refused (server text)' }, quota: { max: 2, used: 2, remaining: 0 }, prefix: 'demo_' };
const dbUsers = [{ name: 'demo_app', hosts: ['localhost', '203.0.113.5'], grants: [{ database: 'demo_shop', privileges: ['ALL PRIVILEGES'] }, { database: 'demo_blog', privileges: ['SELECT'] }] }, { name: 'demo_ro', hosts: ['localhost'], grants: [] }];
const keys = [{ id: 'a'.repeat(64), fingerprint: 'SHA256:abcdef', type: 'ssh-ed25519', bits: 256, comment: 'laptop', options: '' }, { id: 'b'.repeat(64), fingerprint: 'SHA256:ghijkl', type: 'ssh-rsa', bits: 3072, comment: '', options: 'no-pty' }];
const tokens = [{ id: 1, name: 'deploy script', scopes: ['panel:read', 'panel:files'], prefix: 'k7Yq2mP0', expiresAt: null, lastUsedAt: '2026-11-02 10:00:00', createdAt: '2026-10-01 10:00:00' }, { id: 2, name: 'old backup job', scopes: ['panel:backups'], prefix: 'Zz9aBc12', expiresAt: '2026-01-01T00:00:00Z', lastUsedAt: null, createdAt: '2025-12-01 10:00:00' }];
const listing = { kind: 'apache', domains: ['demo.example.com'], files: [{ name: 'demo.example.com', size: 51200, mtime: '2026-11-03T08:00:00Z', location: 'server' }, { name: 'demo.example.com-Oct-2026.gz', size: 900000, mtime: '2026-11-01T00:00:00Z', location: 'home' }], warnings: ['/var/log/apache2/x skipped (server text)'], apache: true, nginx: false };
const retention = { archiveLogs: true, removeOldArchives: true, retainMonths: 3, lastArchivedAt: '2026-11-01 00:05:00', archiveDir: '/home/demo/logs' };
const bandwidth = { domain: 'demo.example.com', limitMb: 10240, months: [{ period: '2026-10', bytes: 1024 * 1024 * 9000, usedMb: 9000, percent: 88 }], sources: [{ path: '/var/log/apache2/domlogs/demo/demo.example.com', bytes: 123456, lastSeenAt: '2026-11-03T08:00:00Z' }] };
const summary = { domain: 'demo.example.com', period: { start: '04/Nov/2026', end: '05/Nov/2026' }, totals: { requests: 222, validRequests: 222, failedRequests: 0, visitors: 60, files: 15, notFound: 75, referrers: 5, bandwidth: 1088699 }, days: [{ date: '2026-11-05', hits: 22, visitors: 5, bytes: 88699 }], pages: [{ label: '/', hits: 74, visitors: 46, bytes: 724513 }], notFound: [], referrers: [{ label: 'example.org', hits: 11, visitors: 3, bytes: 31536 }], countries: [], statusCodes: [{ label: '2xx success', hits: 111, visitors: 60, bytes: 820950 }] };
const stats = { goaccess: { installed: true, version: '1.9.4' }, domains: [{ domain: 'demo.example.com', type: 'main', available: true, generatedAt: '2026-11-05T01:50:00.000Z', error: null, running: null, cooldownUntil: null, summary }, { domain: 'shop.demo.example.com', type: 'sub', available: false, generatedAt: null, error: 'bad json (server text)', running: { id: 9, status: 'queued' }, cooldownUntil: null, summary: null }] };
const usageData = { account: { username: 'demo', package: 'starter', home: '/home/demo' }, disk: { usedMb: 512, quotaMb: 1024, source: 'repquota', inodes: 12000, inodeLimit: 100000, lastRefresh: '2026-11-03T02:00:00Z', breakdown: { totalKb: 524288, entries: [{ path: 'public_html', kb: 393216 }], at: '2026-11-03T02:05:00Z' } }, bandwidth: { usedMb: 9800, limitMb: 10240, months: [{ period: '2026-11', mb: 9800 }] }, limits: { max_domains: 1, max_email_per_hour: 200, disk_mb: 1024, bandwidth_mb: null, quota_inodes: null }, objects: [{ key: 'addons', used: 0, limit: 0 }, { key: 'subdomains', used: 2, limit: 10 }, { key: 'databases', used: 3, limit: null }], refresh: { lastRequestedAt: '2026-11-03T02:00:00Z' } };
const wpMeta = { total: 2, requirements: { wpcli: false, php: true, phpMysql: true, unzip: true, asUser: true, canInstall: true, hint: null }, canInstall: true, hint: null, sites: [{ domain: 'demo.example.com', type: 'main' }, { domain: 'shop.demo.example.com', type: 'sub' }], prefix: 'demo_' };
const wpRows = [{ id: 'a1b2', path: 'public_html/blog', domain: 'demo.example.com', under: 'blog', url: 'https://demo.example.com/blog', adminUrl: 'https://demo.example.com/blog/wp-admin/', version: '6.9', database: 'demo_wp', isDocroot: false, databaseOwned: true }, { id: 'c3d4', path: 'public_html', domain: 'demo.example.com', under: '', url: 'http://demo.example.com', adminUrl: 'http://demo.example.com/wp-admin/', version: null, database: 'other_db', isDocroot: true, databaseOwned: false }];
const errorPages = { domain: 'demo.example.com', docroot: 'public_html', pages: [{ code: '403', label: 'forbidden (server text)', exists: true, managed: false, title: '', message: '', active: false }, { code: '404', label: 'not found (server text)', exists: true, managed: true, title: 'lost?', message: 'try again', active: true }, { code: '503', label: 'unavailable (server text)', exists: false, managed: false, title: '', message: '', active: false }] };

const cases = [
  ['databases', () => { set('/databases', { data: dbRows, meta: dbMeta }); return [h(Databases, { fn: fn('databases/databases') }), fn('databases/databases').path]; }],
  ['databases 501', () => { set('/databases', { error: capability }); return [h(Databases, { fn: fn('databases/databases') }), fn('databases/databases').path]; }],
  ['database users', () => { set('/databases/users', { data: dbUsers, meta: { engine: 'mysql', prefix: 'demo_' } }); set('/databases', { data: dbRows, meta: dbMeta }); return [h(DbUsers, { fn: fn('databases/users') }), fn('databases/users').path]; }],
  ['database users 501', () => { set('/databases/users', { error: capability }); set('/databases', { error: capability }); return [h(DbUsers, { fn: fn('databases/users') }), fn('databases/users').path]; }],
  ['grants modal', () => { set('/databases/users/demo_app/grants', { data: { grants: dbUsers[0].grants, hosts: ['localhost'] } }); return [h(GrantsModal, { user: dbUsers[0], databases: ['demo_shop', 'demo_blog'], engine: 'mysql', onClose: () => {} }), '/panel']; }],
  ['remote hosts', () => { set('/databases/access-hosts', { data: [{ id: 1, host: '203.0.113.5', scope: 'account', editable: true, created_at: '2026-11-01 10:00:00' }, { id: 2, host: '10.0.0.%', scope: 'global', editable: false, created_at: null }], meta: { engine: 'mysql', supported: true } }); return [h(RemoteHosts, { fn: fn('databases/remote-hosts') }), fn('databases/remote-hosts').path]; }],
  ['remote hosts postgres', () => { set('/databases/access-hosts', { data: [], meta: { engine: 'postgres', supported: false } }); return [h(RemoteHosts, { fn: fn('databases/remote-hosts') }), fn('databases/remote-hosts').path]; }],
  ['phpmyadmin', () => { set('/databases/phpmyadmin', { data: { installed: true, url: 'https://srv1.example/phpmyadmin/', featureEnabled: true, version: '5.2.1', users: ['demo_app'], sso: false } }); return [h(PhpMyAdmin, { fn: fn('databases/phpmyadmin') }), fn('databases/phpmyadmin').path]; }],
  ['phpmyadmin sso', () => { set('/databases/phpmyadmin', { data: { installed: true, url: 'https://srv1.example/phpmyadmin/', featureEnabled: true, version: '5.2.1', users: [], sso: true } }); return [h(PhpMyAdmin, { fn: fn('databases/phpmyadmin') }), fn('databases/phpmyadmin').path]; }],
  ['phpmyadmin missing', () => { set('/databases/phpmyadmin', { data: { installed: false, url: null, featureEnabled: true, version: null, users: [] } }); return [h(PhpMyAdmin, { fn: fn('databases/phpmyadmin') }), fn('databases/phpmyadmin').path]; }],
  ['password', () => [h(Password, { fn: fn('security/password') }), fn('security/password').path, ctxFor({ account: { ...me.account, forcePasswordChange: true } })]],
  ['password acting', () => [h(Password, { fn: fn('security/password') }), fn('security/password').path, ctxFor({ actingAs: acting })]],
  ['two-factor', () => { set('/security/two-factor', { data: { enabled: false, required: true, pendingEnrollment: true } }); return [h(TwoFactor, { fn: fn('security/two-factor') }), fn('security/two-factor').path]; }],
  ['two-factor enabled', () => { set('/security/two-factor', { data: { enabled: true, required: true, pendingEnrollment: false } }); return [h(TwoFactor, { fn: fn('security/two-factor') }), fn('security/two-factor').path]; }],
  ['ssh keys', () => { set('/security/ssh-keys', { data: keys }); return [h(SshKeys, { fn: fn('security/ssh-keys') }), fn('security/ssh-keys').path]; }],
  ['ssh keys no home', () => { set('/security/ssh-keys', { error: noHome }); return [h(SshKeys, { fn: fn('security/ssh-keys') }), fn('security/ssh-keys').path]; }],
  ['sessions', () => { set('/security/sessions', { data: [{ id: 'abc123', expiresAt: new Date(Date.now() + 3 * 3600000).toISOString() }] }); return [h(Sessions, { fn: fn('security/sessions') }), fn('security/sessions').path, ctxFor({ actingAs: acting })]; }],
  ['sessions impersonating', () => { set('/security/sessions', { error: { status: 403, code: 'not_while_impersonating', message: 'refused (server text)' } }); return [h(Sessions, { fn: fn('security/sessions') }), fn('security/sessions').path, ctxFor({ actingAs: acting })]; }],
  ['tokens', () => { set('/tokens', { data: tokens }); return [h(Tokens, { fn: fn('security/tokens') }), fn('security/tokens').path]; }],
  ['tokens empty', () => { set('/tokens', { data: [] }); return [h(Tokens, { fn: fn('security/tokens') }), fn('security/tokens').path, ctxFor({ actingAs: acting })]; }],
  ['ip blocker', () => { set('/security/ip-blocker', { data: { denyIps: ['203.0.113.9', '203.0.113.0/24', '2001:db8::/32'], path: 'public_html', domain: 'demo.example.com', max: 500 } }); return [h(IpBlocker, { fn: fn('security/ip-blocker') }), fn('security/ip-blocker').path]; }],
  ['ip blocker no home', () => { set('/security/ip-blocker', { error: noHome }); return [h(IpBlocker, { fn: fn('security/ip-blocker') }), fn('security/ip-blocker').path]; }],
  ['access logs', () => { set('/logs?kind=apache', { data: listing }); set('/logs/retention', { data: retention }); set('/logs/tail?kind=apache&file=demo.example.com&bytes=65536', { data: { size: 51200, length: 51200, truncated: false, content: '1.2.3.4 - - "GET / HTTP/1.1" 200\n', mtime: '2026-11-03T08:00:00Z' } }); return [h(AccessLogs, { fn: fn('logs/access-logs') }), fn('logs/access-logs').path]; }],
  ['access logs empty', () => { set('/logs?kind=apache', { data: { ...listing, files: [], apache: false } }); set('/logs/retention', { data: { ...retention, retainMonths: 0, lastArchivedAt: null, archiveDir: null } }); return [h(AccessLogs, { fn: fn('logs/access-logs') }), fn('logs/access-logs').path]; }],
  ['bandwidth', () => { set('/logs/bandwidth?months=12', { data: bandwidth }); return [h(Bandwidth, { fn: fn('logs/bandwidth') }), fn('logs/bandwidth').path]; }],
  ['bandwidth unlimited', () => { set('/logs/bandwidth?months=12', { data: { ...bandwidth, limitMb: null, months: [], sources: [] } }); return [h(Bandwidth, { fn: fn('logs/bandwidth') }), fn('logs/bandwidth').path]; }],
  ['bandwidth 503', () => { set('/logs/bandwidth?months=12', { error: { status: 503, code: 'service_unavailable', message: 'not loaded (server text)' } }); return [h(Bandwidth, { fn: fn('logs/bandwidth') }), fn('logs/bandwidth').path]; }],
  ['visitors', () => { set('/logs/stats', { data: stats }); return [h(Visitors, { fn: fn('logs/visitors') }), fn('logs/visitors').path]; }],
  ['visitors no report', () => { set('/logs/stats', { data: { ...stats, domains: [{ domain: 'demo.example.com', type: 'main', available: false, generatedAt: null, error: null, running: null, cooldownUntil: null, summary: null }] } }); return [h(Visitors, { fn: fn('logs/visitors') }), fn('logs/visitors').path]; }],
  ['usage', () => { set('/usage', { data: usageData }); return [h(Usage, { fn: fn('usage/usage') }), fn('usage/usage').path]; }],
  ['usage empty', () => { set('/usage', { data: { ...usageData, disk: { ...usageData.disk, quotaMb: null, inodes: null, source: 'scan', breakdown: null, lastRefresh: null }, bandwidth: { usedMb: 0, limitMb: null, months: [] } } }); return [h(Usage, { fn: fn('usage/usage') }), fn('usage/usage').path]; }],
  ['usage 501', () => { set('/usage', { error: capability }); return [h(Usage, { fn: fn('usage/usage') }), fn('usage/usage').path]; }],
  ['job progress', () => [h(JobProgress, { jobId: 4, onFinished: () => {} }), '/panel']],
  ['wordpress', () => { set('/software/wordpress', { data: wpRows, meta: wpMeta }); return [h(WordPress, { fn: fn('software/wordpress') }), fn('software/wordpress').path]; }],
  ['wordpress blocked', () => { set('/software/wordpress', { data: [], meta: { ...wpMeta, canInstall: false, hint: 'install php-mysql (server text)' } }); return [h(WordPress, { fn: fn('software/wordpress') }), fn('software/wordpress').path]; }],
  ['error pages', () => { set('/domains', { data: [{ domain: 'demo.example.com', type: 'main' }, { domain: 'shop.demo.example.com', type: 'sub' }] }); set('/advanced/error-pages?domain=demo.example.com', { data: errorPages }); return [h(ErrorPages, { fn: fn('advanced/error-pages') }), '/panel/advanced/error-pages?domain=demo.example.com']; }],
  ['error pages no domains', () => { set('/domains', { data: [] }); return [h(ErrorPages, { fn: fn('advanced/error-pages') }), fn('advanced/error-pages').path]; }],
  ['home', () => { set('/usage', { data: usageData }); set('/overview/quick-links', { data: { apps: [{ name: 'builder', url: 'https://builder.example' }], news: [{ id: 1, body: 'maintenance sunday (operator text)' }], webmailUrl: 'https://mail.example' } }); return [h(PanelHome), '/panel']; }],
  ['top bar', () => [h(PanelTopBar, { onMenu: () => {} }), '/panel', ctxFor({ actingAs: acting })]],
  ['page header', () => [h(PanelPageHeader, { fn: fn('email/forwarders') }), '/panel']],
  ['placeholder page', () => [h(PanelFunctionPage, { fn: fn('email/forwarders') }), '/panel']],
  ['not found page', () => [h(PanelNotFoundPage), '/panel']],
  ['capability state', () => [h(PanelCapabilityState, { error: { status: 501, code: 'capability_missing' }, onRetry: () => {} }), '/panel']],
  ['feature disabled state', () => [h(FeatureDisabledState, { fn: fn('databases/databases') }), '/panel']],
  ['feature disabled generic', () => [h(FeatureDisabledState, {}), '/panel']],
  ['pending pill', () => [h(PendingPill, { result: { applied: false, reason: 'capability_missing' } }), '/panel']],
];

describe('pseudo-locale: group 3 pages and the shell render no raw English', () => {
  it.each(cases)('%s', (_name, setup) => {
    fixtures.responses.clear();
    const [el, entry, ctx] = setup();
    const html = render(el, entry, ctx);
    expect(html.length).toBeGreaterThan(0);
    expect(leaks(html)).toEqual([]);
  });

  it('the leak scanner catches an English sentence in text and in aria-label', () => {
    expect(leaks('<p>panel.logs.col_file</p><button aria-label="Open the menu">x</button>')).toEqual(['Open the menu']);
    expect(leaks('<h1>Nothing selected</h1><code>Some code here</code>')).toEqual(['Nothing selected']);
  });

  it('every feature-disabled page of the group renders the shell state without English', () => {
    for (const [key, Page, p] of [['databases/databases', Databases, '/databases'], ['security/ssh-keys', SshKeys, '/security/ssh-keys'], ['logs/visitors', Visitors, '/logs/stats'], ['software/wordpress', WordPress, '/software/wordpress'], ['usage/usage', Usage, '/usage']]) {
      fixtures.responses.clear();
      set(p, { error: disabled });
      const html = render(h(Page, { fn: fn(key) }), fn(key).path);
      expect(html).toContain('panel.shell.feature_disabled_title');
      expect(leaks(html)).toEqual([]);
    }
  });
});

describe('catalogue coverage of the group-3 keys', () => {
  const files = [];
  for (const g of ['databases', 'security', 'logs', 'usage', 'software', 'advanced']) {
    const dir = path.join(ROOT, 'src/pages/panel', g);
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) files.push(...fs.readdirSync(p).map((s) => path.join(p, s)));
      else files.push(p);
    }
  }
  files.push(path.join(ROOT, 'src/panel/PanelPage.jsx'), path.join(ROOT, 'src/panel/PanelHome.jsx'), path.join(ROOT, 'src/panel/PanelTopBar.jsx'));
  const lit = `'((?:[^'\\\\]|\\\\.)*)'`;
  const call = new RegExp(`\\bt\\(\\s*${lit}\\s*,\\s*${lit}\\s*[,)]`, 'g');
  const plural = new RegExp(`\\bplural\\(t,\\s*${lit}\\s*,\\s*[^,]+,\\s*${lit}\\s*,\\s*${lit}\\s*[,)]`, 'g');
  const unescape = (s) => s.replace(/\\(['\\])/g, '$1');

  it('every literal key used by the pages exists in en.json with the same English text', () => {
    const problems = [];
    let count = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const pairs = [];
      for (const m of src.matchAll(call)) pairs.push([unescape(m[1]), unescape(m[2])]);
      for (const m of src.matchAll(plural)) pairs.push([`${unescape(m[1])}_one`, unescape(m[2])], [`${unescape(m[1])}_other`, unescape(m[3])]);
      for (const [key, text] of pairs) {
        count += 1;
        if (!(key in catalog)) problems.push(`${path.relative(ROOT, file)}: missing ${key}`);
        else if (catalog[key] !== text) problems.push(`${path.relative(ROOT, file)}: ${key} differs from en.json`);
      }
    }
    expect(count).toBeGreaterThan(600);
    expect(problems).toEqual([]);
  });

  it('keys built from data at runtime are in en.json too', () => {
    const dynamic = [
      ...['read', 'files', 'email', 'dns', 'databases', 'backups', 'cron'].flatMap((s) => [`panel.security.scope.${s}`, `panel.security.scope.${s}_help`]),
      'panel.logs.location_server', 'panel.logs.location_home',
      ...['400', '401', '403', '404', '500', '503'].map((c) => `panel.advanced.code_help_${c}`),
      ...['addons', 'subdomains', 'parked', 'mailboxes', 'databases', 'ftp'].map((k) => `panel.usage.object_${k}`),
      ...['disk', 'bandwidth', 'mailboxes', 'databases', 'addons', 'subdomains', 'ftp'].map((k) => `panel.home.meter_${k}`),
      ...['main', 'addon', 'sub', 'parked'].map((k) => `panel.home.domain_type_${k}`),
      ...['check', 'repair', 'optimize'].map((k) => `panel.databases.action_${k}`),
      ...['good_night', 'good_morning', 'good_afternoon', 'good_evening'].map((k) => `panel.home.${k}`),
    ];
    expect(dynamic.filter((k) => !(k in catalog))).toEqual([]);
  });
});
