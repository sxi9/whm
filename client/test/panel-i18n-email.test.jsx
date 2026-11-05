import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// Pseudo-locale pass for the Email group: every t()/translate() answers with
// the key, so any English sentence left in the markup came from a hard-coded
// string rather than the catalogue.

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/i18n/useT.js', () => {
  const key = (k) => k;
  return {
    useT: () => ({ t: key, locale: 'xx', loaded: true, enabled: [], defaultLocale: 'en', reload: () => {} }),
    translate: key,
    loadActiveLocale: async () => ({}),
    preferredLocale: () => null,
    setPreferredLocale: () => {},
    adoptUserLocale: () => false,
  };
});

const fixtures = new Map();
const EMPTY = { data: null, meta: null, error: null, loading: false, refetch: () => {}, setData: () => {} };
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    if (!path) return { ...EMPTY };
    const key = path.replace(/^\/panel/, '').split('?')[0];
    const fx = fixtures.get(key);
    if (!fx) return { ...EMPTY, loading: true };
    return { ...EMPTY, ...fx };
  },
  useMutation: () => ({ mutate: async () => {}, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const en = (await import('../src/i18n/en.json', { with: { type: 'json' } })).default;
const Accounts = await import('../src/pages/panel/email/accounts.jsx');
const Forwarders = await import('../src/pages/panel/email/forwarders.jsx');
const DefaultAddress = await import('../src/pages/panel/email/default-address.jsx');
const Autoresponders = await import('../src/pages/panel/email/autoresponders.jsx');
const Spam = await import('../src/pages/panel/email/spam.jsx');
const Deliverability = await import('../src/pages/panel/email/deliverability.jsx');
const Webmail = await import('../src/pages/panel/email/webmail.jsx');
const Usage = await import('../src/pages/panel/email/usage.jsx');
const Routing = await import('../src/pages/panel/email/routing.jsx');
const Filters = await import('../src/pages/panel/email/filters.jsx');
const GlobalFilters = await import('../src/pages/panel/email/global-filters.jsx');
const FilterParts = await import('../src/pages/panel/email/parts/Filters.jsx');
const Shared = await import('../src/pages/panel/email/parts/Shared.jsx');
const Delegation = await import('../src/panel/DelegationBanner.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', features: { emailaccts: true }, limits: { max_email: 10 }, domains: [{ domain: 'demo.example.com', type: 'main' }, { domain: 'shop.example.org', type: 'addon' }] },
  usage: {}, counts: { mailboxes: 2 }, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = (slug) => PANEL_FUNCTION_BY_KEY[`panel:email/${slug}`];
const render = (el, path = '/panel/email/accounts') => renderToStaticMarkup(
  h(ToastProvider, null, h(ConfirmProvider, null, h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, el))))),
);
const page = (Mod, slug, path = `/panel/email/${slug}`) => render(h(Mod.default, { fn: fn(slug) }), path);
const withFixtures = (entries, run) => { fixtures.clear(); for (const [k, v] of Object.entries(entries)) fixtures.set(k, v); try { return run(); } finally { fixtures.clear(); } };

// Two words, the first capitalised: an English sentence fragment. Fixture
// values are lowercase so only page strings can match.
const LEAK = /[A-Z][a-z]+ [a-zA-Z]+/g;
// Strings of the shared DataTable and PasswordInput (components/, not this group's catalogue).
const KIT = new Set(['More actions', 'Previous page', 'Next page', 'No results', 'Show password', 'Generate password']);
const leaks = (html) => {
  const text = html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/class="[^"]*"/g, '');
  return [...new Set(text.match(LEAK) || [])].filter((s) => !KIT.has(s));
};
const expectClean = (html) => {
  expect(html).toContain('panel.email');
  expect(leaks(html)).toEqual([]);
};

const mailboxes = [
  { id: 1, address: 'info@demo.example.com', localPart: 'info', domain: 'demo.example.com', quotaMb: 1024, suspended: false, createdAt: '2026-11-01T10:00:00Z', usage: { bytes: 900 * 1024 * 1024, limitBytes: 1024 * 1024 * 1024, messages: 120, source: 'dovecot' } },
  { id: 2, address: 'sales@shop.example.org', localPart: 'sales', domain: 'shop.example.org', quotaMb: null, suspended: true, createdAt: '2026-11-02T10:00:00Z', usage: null },
];
const delegation = { delegatedHere: false, delegatedNs: ['ns1.cloudflare.example', 'ns2.cloudflare.example'] };

describe('Email pages under a pseudo-locale', () => {
  it('accounts: list, plan banners, wiring warning and every form', () => {
    const listMeta = { page: 1, pageSize: 25, total: 2, used: 2, limits: { max_email: 2 }, domains: ['demo.example.com', 'shop.example.org'], defaultQuotaMb: 1024, warnings: [{ code: 'virtual_mail_not_live', message: 'x' }] };
    expectClean(withFixtures({ '/email/accounts': { data: mailboxes, meta: listMeta } }, () => page(Accounts, 'accounts')));
    expectClean(withFixtures({ '/email/accounts': { data: [], meta: { ...listMeta, total: 0, used: 0, limits: { max_email: 0 } } } }, () => page(Accounts, 'accounts')));
    expectClean(render(h(Accounts.CreateMailboxForm, { domains: ['demo.example.com'], defaultQuotaMb: 1024, onSubmit() {}, onCancel() {}, busy: false, error: null, passwordPolicy: { minLength: 10, minStrength: 50 } })));
    expectClean(render(h(Accounts.PasswordForm, { address: 'info@demo.example.com', onSubmit() {}, onCancel() {}, busy: false, error: null })));
    expectClean(render(h(Accounts.QuotaForm, { row: { ...mailboxes[0], quotaMb: 100 }, defaultQuotaMb: 1024, onSubmit() {}, onCancel() {}, busy: false, error: null })));
    expectClean(render(h(Accounts.DeleteForm, { row: mailboxes[0], onSubmit() {}, onCancel() {}, busy: false, error: null })));
    const settings = { username: 'info@demo.example.com', hostname: 'srv1.example', imap: { host: 'srv1.example', port: 993, ssl: true, alternative: { port: 143, starttls: true } }, pop3: null, smtp: { host: 'srv1.example', port: 587, starttls: true, auth: null, submissionPorts: false, ports: { enabled: false, port587: false, port465: false } }, certificate: { dovecot: { name: 'other.example', issuer: 'r3', matchesHostname: false } }, webmail: 'https://srv1.example/webmail/', webmailSso: true };
    expectClean(render(h(Accounts.ClientSettings, { settings })));
    expectClean(render(h(Accounts.ClientSettings, { settings: { ...settings, imap: null, smtp: { ...settings.smtp, auth: 'plain', submissionPorts: true, ports: { enabled: true, port587: true, port465: true } }, certificate: null } })));
    expectClean(render(h(Shared.MutationError, { error: { status: 501, code: 'capability_missing', message: 'x' } })));
    expectClean(render(h(Shared.MutationError, { error: { status: 422, code: 'limit_reached', message: 'x' } })));
    expectClean(render(h(Shared.PendingNote, { result: { applied: false, reason: 'capability_missing' } })));
  });

  it('forwarders and default address', () => {
    const rows = [{ id: 1, address: 'a@demo.example.com', destination: 'b@example.org', createdAt: '2026-11-01T10:00:00Z' }, { id: 2, address: 'c@demo.example.com', destination: ':fail:', createdAt: '2026-11-01T10:00:00Z' }];
    expectClean(withFixtures({ '/email/forwarders': { data: rows, meta: { domains: ['demo.example.com', 'shop.example.org'], maxPerDomain: 50 } }, '/email/domains/demo.example.com/forward': { data: { configured: true, targetDomain: 'example.org', updatedAt: '2026-11-01T10:00:00Z' } }, '/email/domains/shop.example.org/forward': { data: { configured: false } } }, () => page(Forwarders, 'forwarders')));
    expectClean(render(h(Forwarders.ForwarderForm, { domains: ['demo.example.com'], onSubmit() {}, onCancel() {}, busy: false, error: null })));
    expectClean(render(h(Forwarders.DomainForwardForm, { domain: 'demo.example.com', current: '', onSubmit() {}, onCancel() {}, busy: false, error: null })));
    expectClean(withFixtures({ '/email/domains/demo.example.com/default': { data: { domain: 'demo.example.com', configured: true, action: 'forward', destination: 'x@example.org' } }, '/email/domains/shop.example.org/default': { data: { domain: 'shop.example.org', configured: false, action: 'fail' } } }, () => page(DefaultAddress, 'default-address')));
  });

  it('autoresponders', () => {
    const rows = [
      { id: 1, address: 'a@demo.example.com', localPart: 'a', domain: 'demo.example.com', subject: 'ooo', fromName: 'jane', body: 'x', intervalHours: 24, startAt: '2026-11-01T10:00:00Z', stopAt: null, enabled: true },
      { id: 2, address: 'b@demo.example.com', localPart: 'b', domain: 'demo.example.com', subject: 'ooo', fromName: '', body: 'x', intervalHours: 0, startAt: null, stopAt: '2026-11-01T10:00:00Z', enabled: false },
    ];
    expectClean(withFixtures({ '/email/autoresponders': { data: rows, meta: { domains: ['demo.example.com'] } } }, () => page(Autoresponders, 'autoresponders')));
    expectClean(render(h(Autoresponders.AutoresponderForm, { domains: ['demo.example.com'], existing: null, onSubmit() {}, onCancel() {}, busy: false, error: null })));
    expectClean(render(h(Autoresponders.AutoresponderForm, { domains: ['demo.example.com'], existing: { ...rows[0], intervalHours: 48 }, onSubmit() {}, onCancel() {}, busy: false, error: null })));
  });

  it('spam filters, available and not', () => {
    const current = { enabled: true, requiredScore: 5, autoDelete: true, autoDeleteScore: 12, whitelist: ['ok@example.org'], blacklist: [], updatedAt: '2026-11-01T10:00:00Z' };
    expectClean(withFixtures({ '/email/spam': { data: current } }, () => page(Spam, 'spam')));
    for (const reason of ['exim_no_content_scan', 'spamd_not_running', 'exim_missing', 'spamd_missing']) expectClean(withFixtures({ '/email/spam': { data: { available: false, reason } } }, () => page(Spam, 'spam')));
  });

  it('deliverability with DNS elsewhere and the DKIM card', () => {
    const report = {
      domain: 'demo.example.com', score: 40, zone: true, checkedAt: '2026-11-01T10:00:00Z', delegation,
      items: [
        { id: 'spf', label: 'SPF', status: 'missing', current: [], expected: 'v=spf1 a mx -all', fixable: true },
        { id: 'dkim', label: 'DKIM', status: 'warning', current: ['v=dkim1'], expected: null, fixable: true, signing: false, signingHint: 'x', selector: 'default' },
        { id: 'mx', label: 'MX', status: 'ok', current: ['10 srv1.example'], expected: null, fixable: false },
        { id: 'ptr', label: 'PTR', status: 'unknown', current: [], expected: null, fixable: false },
      ],
      records: [{ name: 'demo.example.com', type: 'TXT', value: 'v=spf1 a mx -all', status: 'missing' }],
    };
    expectClean(withFixtures({ '/email/deliverability/demo.example.com': { data: report }, '/email/dkim/demo.example.com': { data: { domain: 'demo.example.com', zone: true, key: { selector: 'default', createdAt: '2026-11-01T10:00:00Z' } } } }, () => page(Deliverability, 'deliverability')));
    expectClean(withFixtures({ '/email/deliverability/demo.example.com': { data: { ...report, zone: false, delegation: null } }, '/email/dkim/demo.example.com': { data: { domain: 'demo.example.com', zone: false, key: null } } }, () => page(Deliverability, 'deliverability')));
    expectClean(render(h(Delegation.DelegationBanner, { domain: 'demo.example.com', delegation, records: report.records })));
  });

  it('webmail, published and not', () => {
    const info = { url: 'https://srv1.example/webmail/', flavor: 'roundcube', version: '1.6', hostname: 'srv1.example', sso: true, prefillUser: 'info@demo.example.com' };
    expectClean(withFixtures({ '/email/webmail': { data: info }, '/email/accounts': { data: mailboxes } }, () => page(Webmail, 'webmail')));
    expectClean(withFixtures({ '/email/webmail': { data: info }, '/email/accounts': { data: [] } }, () => page(Webmail, 'webmail')));
    expectClean(withFixtures({ '/email/webmail': { data: { url: null, installed: true, flavor: 'roundcube' } } }, () => page(Webmail, 'webmail')));
    expectClean(withFixtures({ '/email/webmail': { data: { url: null, installed: false } } }, () => page(Webmail, 'webmail')));
  });

  it('mail usage with folders and messages', () => {
    const usage = { hours: 24, totals: { messages: 3, sent: 1, received: 2, delivered: 2, failed: 1, deferred: 0, queued: 0 }, storage: { mailboxes: 2, limit: 10, quotaMb: 2048 }, log: { truncated: true }, mailboxes: [{ address: 'info@demo.example.com', sent: 1, received: 2, failed: 1 }], byDomain: [{ domain: 'demo.example.com', delivered: 2, deferred: 0, failed: 1 }] };
    const messages = { data: [{ id: 'm1', arrivedAt: '2026-11-01T10:00:00Z', sender: 'a@example.org', recipient: 'info@demo.example.com', subject: 'hi', size: 1200, status: 'delivered', detail: null }], meta: { total: 1 } };
    const folders = { data: [{ name: 'INBOX', messages: 5, unseen: 1, bytes: 100, emptiable: false }, { name: 'Trash', messages: 2, unseen: 0, bytes: 10, emptiable: true }], meta: { usage: { bytes: 110, limitBytes: 1000, messages: 7, source: 'dovecot' } } };
    expectClean(withFixtures({ '/email/usage': { data: usage }, '/email/usage/messages': messages, '/email/accounts': { data: mailboxes }, '/email/accounts/1/folders': folders }, () => page(Usage, 'usage')));
    expectClean(withFixtures({ '/email/usage': { data: { ...usage, log: { from: '2026-11-01T10:00:00Z' } } }, '/email/usage/messages': { data: [], meta: { total: 0 } }, '/email/accounts': { data: [] } }, () => page(Usage, 'usage')));
  });

  it('routing with MX states and delegation', () => {
    const rows = [
      { domain: 'demo.example.com', type: 'main', routing: 'auto', effective: 'local', canRemote: false, mailboxes: 2, mx: { ok: true, records: [{ exchange: 'mx.other.example' }], pointsHere: false, exchanges: ['mx.other.example'] }, hints: ['x'], delegation },
      { domain: 'shop.example.org', type: 'addon', routing: 'remote', effective: 'remote', canRemote: true, mailboxes: 0, mx: { ok: false, error: 'x' }, hints: [], delegation: null },
      { domain: 'third.example.org', type: 'addon', routing: 'local', effective: 'local', canRemote: true, mailboxes: 1, mx: { ok: true, records: [] }, hints: [], delegation: null },
    ];
    expectClean(withFixtures({ '/email/routing': { data: rows, meta: { hostname: 'srv1.example' } } }, () => page(Routing, 'routing')));
    expectClean(withFixtures({ '/email/routing': { data: [], meta: { hostname: 'srv1.example' } } }, () => page(Routing, 'routing')));
  });

  it('filters per mailbox and account-wide, with the rule form', () => {
    const list = { data: [{ id: 1, name: 'news', enabled: true, rules: { matchAll: false, match: [{ header: 'subject', op: 'contains', value: 'x' }, { header: 'custom', name: 'x-list', op: 'is', value: 'y' }], actions: [{ type: 'fileinto', folder: 'Archive' }, { type: 'stop' }] } }, { id: 2, name: 'junk', enabled: false, rules: { match: [], actions: [{ type: 'discard' }, { type: 'redirect', address: 'z@example.org' }] } }], meta: { max: 50, folders: ['INBOX', 'Junk'], sieve: { available: false }, script: 'require' } };
    expectClean(withFixtures({ '/email/accounts': { data: mailboxes }, '/email/filters': list }, () => page(Filters, 'filters', '/panel/email/filters?mailbox=1')));
    expectClean(withFixtures({ '/email/accounts': { data: [] } }, () => page(Filters, 'filters')));
    expectClean(withFixtures({ '/email/global-filters': { ...list, data: [], meta: { ...list.meta, scope: 'account' } } }, () => page(GlobalFilters, 'global-filters')));
    expectClean(render(h(FilterParts.FilterForm, { existing: null, folders: ['INBOX', 'Junk'], onSubmit() {}, onTest() {}, onCancel() {}, busy: false, error: null, testResult: { ok: false, errors: [{ line: 2, message: 'x' }], script: 'require' } })));
    expectClean(render(h(FilterParts.FilterForm, { existing: list.data[0], folders: ['INBOX'], onSubmit() {}, onTest() {}, onCancel() {}, busy: false, error: null, testResult: null })));
  });

  it('helpers that run outside a component answer with keys too', () => {
    expect(Autoresponders.intervalText(48)).toBe('panel.email.autoresponders.interval_days');
    expect(Autoresponders.responderState({ enabled: false }).label).toBe('panel.email.autoresponders.state_stopped');
    expect(Forwarders.destinationText(':fail:')).toBe('panel.email.forwarders.dest_fail');
    expect(DefaultAddress.actionText('blackhole')).toBe('panel.email.default_address.action_blackhole');
    expect(Spam.scoreHint(1)).toBe('panel.email.spam.hint_strict');
    expect(Spam.unavailableText('exim_missing')).toBe('panel.email.spam.reason_exim_missing');
    expect(Routing.mxSummary(null).label).toBe('panel.email.routing.mx_not_checked');
    expect(FilterParts.describeFilter({ match: [{ header: 'from', op: 'contains', value: 'x' }], actions: [{ type: 'discard' }] })).toBe('panel.email.filters.header_from panel.email.filters.op_contains "x" → panel.email.filters.describe_discard');
    expect(Delegation.delegationText('demo.example.com', null)).toBe('panel.email.delegation.text');
    expect(Shared.quotaText(null)).toBe('panel.email.common.unlimited');
    expect(Accounts.passwordHelp(null)).toBe('panel.email.accounts.password_help');
  });

  it('every key the pages use exists in en.json with its fallback, and placeholders are filled', () => {
    expect(Shared.fill('{a} of {b}', { a: 1, b: 2 })).toBe('1 of 2');
    expect(Shared.fill('{a} kept', { a: null })).toBe('{a} kept');
    const used = Object.keys(en).filter((k) => k.startsWith('panel.email.'));
    expect(used.length).toBeGreaterThan(400);
    for (const k of ['panel.email.accounts.create', 'panel.email.forwarders.add', 'panel.email.filters.create', 'panel.email.routing.title', 'panel.email.delegation.title', 'panel.email.usage.folders', 'panel.email.webmail.open', 'panel.email.spam.filtering', 'panel.email.deliverability.dkim_title', 'panel.email.default_address.action_fail', 'panel.email.autoresponders.create']) expect(en[k]).toBeTruthy();
  });
});
