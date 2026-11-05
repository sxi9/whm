import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

// GET fixtures keyed by the path usePanelApi asks for (query string ignored).
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
const { registryKeysFrom } = await import('../src/panel/registry.js');
const Accounts = await import('../src/pages/panel/email/accounts.jsx');
const Forwarders = await import('../src/pages/panel/email/forwarders.jsx');
const DefaultAddress = await import('../src/pages/panel/email/default-address.jsx');
const Autoresponders = await import('../src/pages/panel/email/autoresponders.jsx');
const Spam = await import('../src/pages/panel/email/spam.jsx');
const Deliverability = await import('../src/pages/panel/email/deliverability.jsx');
const Webmail = await import('../src/pages/panel/email/webmail.jsx');
const Usage = await import('../src/pages/panel/email/usage.jsx');
const Shared = await import('../src/pages/panel/email/parts/Shared.jsx');

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
const page = (Mod, slug) => render(h(Mod.default, { fn: fn(slug) }), `/panel/email/${slug}`);
const withFixtures = (entries, run) => { fixtures.clear(); for (const [k, v] of Object.entries(entries)) fixtures.set(k, v); try { return run(); } finally { fixtures.clear(); } };

const featureOff = { status: 403, code: 'feature_disabled', message: 'Your hosting package does not include "emailaccts"' };
const noDaemon = { status: 501, code: 'capability_missing', capability: 'exim', message: 'Exim is not installed on this server.' };

const mailboxes = [
  { id: 1, address: 'info@demo.example.com', localPart: 'info', domain: 'demo.example.com', quotaMb: 1024, suspended: false, createdAt: '2026-11-01T10:00:00Z', usage: { bytes: 900 * 1024 * 1024, limitBytes: 1024 * 1024 * 1024, messages: 120, source: 'dovecot' } },
  { id: 2, address: 'sales@shop.example.org', localPart: 'sales', domain: 'shop.example.org', quotaMb: null, suspended: true, createdAt: '2026-11-02T10:00:00Z', usage: null },
];

describe('registry', () => {
  it('every Email function has a page file', () => {
    const keys = registryKeysFrom(['accounts', 'forwarders', 'default-address', 'autoresponders', 'spam', 'deliverability', 'webmail', 'usage'].map((s) => `../pages/panel/email/${s}.jsx`));
    for (const slug of ['accounts', 'forwarders', 'default-address', 'autoresponders', 'spam', 'deliverability', 'webmail', 'usage']) expect(keys).toContain(fn(slug).key);
  });
});

describe('Email accounts', () => {
  it('lists mailboxes with quota meters, the plan meter and the create action', () => {
    const html = withFixtures({ '/email/accounts': { data: mailboxes, meta: { page: 1, pageSize: 25, total: 2, used: 2, limits: { max_email: 10 }, domains: ['demo.example.com', 'shop.example.org'], defaultQuotaMb: 1024 } } }, () => page(Accounts, 'accounts'));
    expect(html).toContain('<h1>Email accounts</h1>');
    expect(html).toContain('info@demo.example.com');
    expect(html).toContain('2 of 10');
    expect(html).toContain('900 MB of 1.00 GB');
    expect(html).toContain('meter warn');
    expect(html).toContain('120 messages');
    expect(html).toContain('Unlimited');
    expect(html).toContain('Suspended');
    expect(html).toContain('Create mailbox');
    expect(html).toContain('Search addresses');
    expect(html).toContain('Filter by domain');
    expect(html).toContain('1–2 of 2');
  });

  it('shows the empty state and disables creation at the plan limit', () => {
    const empty = withFixtures({ '/email/accounts': { data: [], meta: { page: 1, pageSize: 25, total: 0, used: 0, limits: { max_email: 10 }, domains: ['demo.example.com'], defaultQuotaMb: 512 } } }, () => page(Accounts, 'accounts'));
    expect(empty).toContain('No mailboxes yet');
    expect(empty).toContain('512 MB');
    const full = withFixtures({ '/email/accounts': { data: mailboxes, meta: { page: 1, pageSize: 25, total: 2, used: 2, limits: { max_email: 2 }, domains: ['demo.example.com'], defaultQuotaMb: 512 } } }, () => page(Accounts, 'accounts'));
    expect(full).toContain('Plan limit reached');
    expect(full).toMatch(/<button[^>]*disabled[^>]*>[^<]*<svg[\s\S]*?Create mailbox/);
  });

  it('treats max_email 0 as "not included" and disables creation (assertLimit refuses at 0); null stays unlimited', () => {
    const none = withFixtures({ '/email/accounts': { data: [], meta: { page: 1, pageSize: 25, total: 0, used: 0, limits: { max_email: 0 }, domains: ['demo.example.com'], defaultQuotaMb: 512 } } }, () => page(Accounts, 'accounts'));
    expect(none).toContain('Mailboxes are not included in your plan');
    expect(none).toContain('Not included in your plan');
    expect(none).not.toContain('Plan limit reached');
    expect(none).not.toContain('0 of 0');
    expect(none).toMatch(/<button[^>]*disabled[^>]*>[^<]*<svg[\s\S]*?Create mailbox/);
    const unlimited = withFixtures({ '/email/accounts': { data: mailboxes, meta: { page: 1, pageSize: 25, total: 2, used: 2, limits: { max_email: null }, domains: ['demo.example.com'], defaultQuotaMb: 512 } } }, () => page(Accounts, 'accounts'));
    expect(unlimited).not.toContain('not included');
    expect(unlimited).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*<svg[\s\S]*?Create mailbox/);
  });

  it('renders the 403 and 501 states', () => {
    const off = withFixtures({ '/email/accounts': { error: featureOff } }, () => page(Accounts, 'accounts'));
    expect(off).toContain('Not included in your plan');
    expect(off).not.toContain('Create mailbox');
    const missing = withFixtures({ '/email/accounts': { error: noDaemon } }, () => page(Accounts, 'accounts'));
    expect(missing).toContain('Not available on this server');
    expect(missing).toContain('Exim is not installed');
    expect(missing).toContain('Re-check');
  });

  it('create form has address, password and quota; connection settings list IMAP, POP3 and SMTP', () => {
    const form = render(h(Accounts.CreateMailboxForm, { domains: ['demo.example.com', 'shop.example.org'], defaultQuotaMb: 1024, onSubmit() {}, onCancel() {}, busy: false, error: { message: 'Invalid', fields: { localPart: ['Local part: lowercase letters'] } } }));
    expect(form).toContain('aria-label="Local part"');
    expect(form).toContain('shop.example.org');
    expect(form).toContain('type="password"');
    expect(form).toContain('Storage quota');
    expect(form).toContain('Local part: lowercase letters');
    const settings = render(h(Accounts.ClientSettings, { settings: { address: 'info@demo.example.com', username: 'info@demo.example.com', hostname: 'srv1.example', imap: { host: 'srv1.example', port: 993, ssl: true, alternative: { port: 143, starttls: true, plainAllowed: false } }, pop3: null, smtp: { host: 'srv1.example', port: 465, ssl: true, alternative: { port: 587, starttls: true }, auth: 'password', submissionPorts: true, ports: { enabled: true, port465: true, port587: true } }, certificate: { dovecot: { name: 'srv1.example', sans: ['srv1.example'], issuer: "Let's Encrypt", selfSigned: false, notAfter: '2027-01-01T00:00:00Z', matchesHostname: true }, exim: null }, webmail: 'https://srv1.example/webmail/' } }));
    expect(settings).toContain('993');
    expect(settings).toContain('587 with STARTTLS or 465 with TLS');
    expect(settings).toContain('IMAP');
    expect(settings).toContain('Open webmail');
    expect(settings).toContain('Required — same username and password');
    expect(settings).toContain('issued by Let&#x27;s Encrypt');
    expect(settings).not.toContain('Sending is not enabled yet');
    expect(settings).not.toContain('Only port 25 is open');
    expect(Accounts.usageOf(mailboxes[1]).text).toBe('Unlimited');
    expect(Accounts.usageOf({ quotaMb: 10, usage: null }).text).toBe('Up to 10.0 MB');
  });

  it('the Connect sheet tells the truth: no AUTH while the wiring is not live, port 25 only without submission ports, 587 alone without TLS, a mismatched certificate', () => {
    const base = { address: 'info@demo.example.com', username: 'info@demo.example.com', hostname: 'srv1.example', imap: { host: 'srv1.example', port: 993, ssl: true, alternative: { port: 143, starttls: true, plainAllowed: false } }, pop3: null, webmail: null };
    const notLive = render(h(Accounts.ClientSettings, { settings: { ...base, smtp: { host: 'srv1.example', port: 25, ssl: false, starttls: true, alternative: null, auth: null, submissionPorts: false, ports: { enabled: false, port465: false, port587: false } }, certificate: { dovecot: null, exim: null } } }));
    expect(notLive).toContain('Sending is not enabled yet — ask your provider');
    expect(notLive).toContain('Not enabled yet');
    expect(notLive).not.toContain('Required — same username and password');
    expect(notLive).toContain('Only port 25 is open for sending');
    expect(notLive).toContain('>25 with STARTTLS<');
    expect(notLive).not.toContain('587 with STARTTLS');
    expect(notLive).toContain('port <strong>25</strong> (STARTTLS)');
    expect(notLive).toContain('certificate could not be read');
    const starttlsOnly = render(h(Accounts.ClientSettings, { settings: { ...base, smtp: { host: 'srv1.example', port: 587, ssl: false, starttls: true, alternative: null, auth: 'password', submissionPorts: true, ports: { enabled: true, port465: false, port587: true } }, certificate: { dovecot: { name: 'other.example', sans: [], issuer: null, selfSigned: true, notAfter: null, matchesHostname: false }, exim: null } } }));
    expect(starttlsOnly).toContain('>587 with STARTTLS<');
    expect(starttlsOnly).not.toContain('465');
    expect(starttlsOnly).not.toContain('Only port 25');
    expect(starttlsOnly).toContain('Required — same username and password');
    expect(starttlsOnly).toContain('other.example (self-signed)');
    expect(starttlsOnly).toContain('does not name srv1.example');
    expect(Accounts.smtpPortsText({ port: 465, submissionPorts: true })).toEqual(['587 with STARTTLS', '465 with TLS']);
    expect(Accounts.smtpPortsText({ port: 25, submissionPorts: false })).toEqual(['25 with STARTTLS']);
  });

  it('shows the wiring warning in the empty state and the server password rule in the forms', () => {
    const warn = { code: 'virtual_mail_not_live', message: 'Exim/Dovecot are not yet wired' };
    const empty = withFixtures({ '/email/accounts': { data: [], meta: { page: 1, pageSize: 25, total: 0, used: 0, limits: { max_email: 10 }, domains: ['demo.example.com'], defaultQuotaMb: 512, passwordPolicy: { context: 'email', minLength: 8, minStrength: 65 }, warnings: [warn] } } }, () => page(Accounts, 'accounts'));
    expect(empty).toContain('No mailboxes yet');
    expect(empty).toContain('Mailboxes are not served yet');
    expect(empty).toContain('A mailbox you create is saved');
    const rows = withFixtures({ '/email/accounts': { data: mailboxes, meta: { page: 1, pageSize: 25, total: 2, used: 2, limits: { max_email: 10 }, domains: ['demo.example.com'], defaultQuotaMb: 512, warnings: [{ code: 'virtual_mail_disabled', message: 'off' }] } } }, () => page(Accounts, 'accounts'));
    expect(rows).toContain('Mailboxes are switched off on this server');
    expect(rows).toContain('Your mailboxes are saved');
    const quiet = withFixtures({ '/email/accounts': { data: [], meta: { page: 1, pageSize: 25, total: 0, used: 0, limits: { max_email: 10 }, domains: ['demo.example.com'], defaultQuotaMb: 512, warnings: [] } } }, () => page(Accounts, 'accounts'));
    expect(quiet).not.toContain('not served yet');
    expect(Accounts.passwordHelp(null)).toBe('At least 8 characters; use the generator for a strong one.');
    expect(Accounts.passwordHelp({ minLength: 8, minStrength: 65 })).toContain('strength of 65 out of 100');
    const form = render(h(Accounts.CreateMailboxForm, { domains: ['demo.example.com'], defaultQuotaMb: 1024, passwordPolicy: { minLength: 8, minStrength: 65 }, onSubmit() {}, onCancel() {}, busy: false, error: null }));
    expect(form).toContain('At least 8 characters and a strength of 65 out of 100');
    const change = render(h(Accounts.PasswordForm, { address: 'info@demo.example.com', passwordPolicy: { minLength: 8, minStrength: 40 }, onSubmit() {}, onCancel() {}, busy: false, error: null }));
    expect(change).toContain('strength of 40 out of 100');
  });
});

describe('Forwarders', () => {
  const list = { data: [{ id: 3, domain: 'demo.example.com', localPart: 'sales', address: 'sales@demo.example.com', destination: 'team@example.org', catchAll: false, createdAt: '2026-11-01T10:00:00Z' }, { id: 4, domain: 'demo.example.com', localPart: 'old', address: 'old@demo.example.com', destination: ':fail:', catchAll: false, createdAt: '2026-11-01T10:00:00Z' }], meta: { total: 2, domains: ['demo.example.com', 'shop.example.org'], maxPerDomain: 200 } };
  it('lists forwarders and one domain-forwarder row per domain', () => {
    const html = withFixtures({ '/email/forwarders': list, '/email/domains/demo.example.com/forward': { data: { domain: 'demo.example.com', targetDomain: 'example.org', configured: true, updatedAt: '2026-11-02T10:00:00Z' } }, '/email/domains/shop.example.org/forward': { data: { domain: 'shop.example.org', targetDomain: null, configured: false, updatedAt: null } } }, () => page(Forwarders, 'forwarders'));
    expect(html).toContain('<h1>Forwarders</h1>');
    expect(html).toContain('sales@demo.example.com');
    expect(html).toContain('team@example.org');
    expect(html).toContain('Rejected with an error');
    expect(html).toContain('up to 200 per domain');
    expect(html).toContain('Domain forwarders');
    expect(html).toContain('Not forwarding');
    expect(html).toContain('Forward domain');
    expect(html).toContain('>Change<');
    expect(html).toContain('>Stop<');
    expect(html).toContain('href="/panel/email/default-address"');
  });
  it('403 and 501, the form and destination text', () => {
    expect(withFixtures({ '/email/forwarders': { error: featureOff } }, () => page(Forwarders, 'forwarders'))).toContain('Not included in your plan');
    expect(withFixtures({ '/email/forwarders': { error: noDaemon } }, () => page(Forwarders, 'forwarders'))).toContain('Not available on this server');
    const form = render(h(Forwarders.ForwarderForm, { domains: ['demo.example.com'], onSubmit() {}, onCancel() {}, busy: false, error: null }));
    expect(form).toContain('Forward to another address');
    expect(form).toContain('Discard silently');
    expect(form).toContain('type="email"');
    expect(Forwarders.destinationText(':blackhole:')).toBe('Discarded silently');
    expect(Forwarders.destinationText('a@b.co')).toBe('a@b.co');
  });
});

describe('Default address', () => {
  it('renders one card per domain with the three actions and the current state', () => {
    const html = withFixtures({ '/email/domains/demo.example.com/default': { data: { domain: 'demo.example.com', action: 'forward', destination: 'catch@demo.example.com', configured: true, id: 9 } }, '/email/domains/shop.example.org/default': { data: { domain: 'shop.example.org', action: 'fail', destination: null, configured: false } } }, () => page(DefaultAddress, 'default-address'));
    expect(html).toContain('<h1>Default address</h1>');
    expect(html).toContain('<h2>demo.example.com</h2>');
    expect(html).toContain('<h2>shop.example.org</h2>');
    expect(html).toContain('Unknown addresses are delivered to catch@demo.example.com');
    expect(html).toContain('Not set · rejects with an error');
    expect(html).toContain('Reject with an error');
    expect(html).toContain('Discard silently');
    expect(html).toContain('Forward to an address');
    expect(html).toContain('value="catch@demo.example.com"');
  });
  it('403 and 501', () => {
    const off = withFixtures({ '/email/domains/demo.example.com/default': { error: featureOff }, '/email/domains/shop.example.org/default': { error: featureOff } }, () => page(DefaultAddress, 'default-address'));
    expect(off).toContain('Not included in your plan');
    expect(off).not.toContain('<h2>demo.example.com</h2>');
    expect(withFixtures({ '/email/domains/demo.example.com/default': { error: noDaemon }, '/email/domains/shop.example.org/default': { error: noDaemon } }, () => page(DefaultAddress, 'default-address'))).toContain('Not available on this server');
    expect(DefaultAddress.actionText('blackhole')).toBe('Discard silently');
  });
});

describe('Autoresponders', () => {
  const rows = [
    { id: 1, address: 'info@demo.example.com', domain: 'demo.example.com', localPart: 'info', fromName: 'Info desk', subject: 'Out of office', body: 'Back soon', charset: 'utf-8', intervalHours: 24, startAt: null, stopAt: null, enabled: true },
    { id: 2, address: 'sales@demo.example.com', domain: 'demo.example.com', localPart: 'sales', fromName: '', subject: 'Holidays', body: 'Closed', charset: 'utf-8', intervalHours: 0, startAt: '2099-01-01T00:00:00Z', stopAt: '2099-01-10T00:00:00Z', enabled: true },
    { id: 3, address: 'old@demo.example.com', domain: 'demo.example.com', localPart: 'old', fromName: '', subject: 'Gone', body: 'x', charset: 'utf-8', intervalHours: 48, startAt: null, stopAt: null, enabled: false },
  ];
  it('lists responders with frequency, schedule and state', () => {
    const html = withFixtures({ '/email/autoresponders': { data: rows, meta: { domains: ['demo.example.com'] } } }, () => page(Autoresponders, 'autoresponders'));
    expect(html).toContain('<h1>Autoresponders</h1>');
    expect(html).toContain('Out of office');
    expect(html).toContain('from Info desk');
    expect(html).toContain('Once a day per sender');
    expect(html).toContain('Every message');
    expect(html).toContain('Once every 2 days per sender');
    expect(html).toContain('>Active<');
    expect(html).toContain('Starts ');
    expect(html).toContain('Stopped');
    expect(html).toContain('Create autoresponder');
    expect(html).toContain('>Edit<');
  });
  it('states, form and helpers', () => {
    expect(withFixtures({ '/email/autoresponders': { error: featureOff } }, () => page(Autoresponders, 'autoresponders'))).toContain('Not included in your plan');
    expect(withFixtures({ '/email/autoresponders': { error: noDaemon } }, () => page(Autoresponders, 'autoresponders'))).toContain('Not available on this server');
    expect(withFixtures({ '/email/autoresponders': { data: [], meta: { domains: ['demo.example.com'] } } }, () => page(Autoresponders, 'autoresponders'))).toContain('No autoresponders yet');
    const create = render(h(Autoresponders.AutoresponderForm, { domains: ['demo.example.com'], existing: null, onSubmit() {}, onCancel() {}, busy: false, error: { message: 'Invalid', fields: { subject: ['Required'] } } }));
    expect(create).toContain('aria-label="Local part"');
    expect(create).toContain('type="datetime-local"');
    expect(create).toContain('hours apart');
    expect(create).toContain('Required');
    const edit = render(h(Autoresponders.AutoresponderForm, { domains: ['demo.example.com'], existing: rows[0], onSubmit() {}, onCancel() {}, busy: false, error: null }));
    expect(edit).toContain('readonly');
    expect(edit).toContain('value="Out of office"');
    expect(edit).toContain('Save changes');
    expect(Autoresponders.responderState(rows[2]).status).toBe('stopped');
    expect(Autoresponders.responderState({ enabled: true, stopAt: '2000-01-01T00:00:00Z' }).status).toBe('ended');
    expect(Shared.toLocalInput('bad')).toBe('');
    expect(Shared.fromLocalInput('')).toBe(null);
    expect(Shared.fromLocalInput('2026-11-03T10:30')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('Spam filters', () => {
  const settings = { enabled: true, requiredScore: 5, autoDelete: true, autoDeleteScore: 12, whitelist: ['friend@example.org'], blacklist: ['spammer@example.net'], updatedAt: '2026-11-02T10:00:00Z', configured: true, available: true };
  it('renders the thresholds and both lists', () => {
    const html = withFixtures({ '/email/spam': { data: settings } }, () => page(Spam, 'spam'));
    expect(html).toContain('<h1>Spam filters</h1>');
    expect(html).toContain('Spam threshold');
    expect(html).toContain('value="5"');
    expect(html).toContain('Delete at score');
    expect(html).toContain('value="12"');
    expect(html).toContain('Allow list');
    expect(html).toContain('friend@example.org');
    expect(html).toContain('Block list');
    expect(html).toContain('spammer@example.net');
    expect(html).toContain('1 of 200');
    expect(html).toContain('Last saved');
    expect(html).not.toContain('not available on this server');
    expect(html).toContain('How spam scoring works');
    expect(html).toContain('applies to this account only');
    expect(html).toContain('without content scanning');
    expect(html).not.toContain('nothing to compare against');
  });
  it('explains per-account thresholds and the light Exim build when no scanner runs', () => {
    const light = withFixtures({ '/email/spam': { data: { ...settings, available: false, reason: 'exim_no_content_scan', detail: 'exim4-daemon-light' } } }, () => page(Spam, 'spam'));
    expect(light).toContain('How spam scoring works');
    expect(light).toContain('nothing to compare against');
    expect(light).toContain('cannot be saved here until the scanning build is installed');
    const stopped = withFixtures({ '/email/spam': { data: { ...settings, available: false, reason: 'spamd_not_running' } } }, () => page(Spam, 'spam'));
    expect(stopped).toContain('How spam scoring works');
    expect(stopped).not.toContain('nothing to compare against');
  });
  it('withholds the form with the reason when filtering cannot take effect; 403 and 501', () => {
    const html = withFixtures({ '/email/spam': { data: { ...settings, available: false, reason: 'spamd_missing', detail: null, enabled: false, configured: false, updatedAt: null } } }, () => page(Spam, 'spam'));
    expect(html).toContain('Spam filtering is not available on this server');
    expect(html).toContain('SpamAssassin is not installed');
    expect(html).toContain('Ask your hosting provider');
    expect(html).toContain('Re-check');
    expect(html).not.toContain('Spam threshold');
    const light = withFixtures({ '/email/spam': { data: { ...settings, available: false, reason: 'exim_no_content_scan', detail: 'This Exim build (exim 4.97, exim4-daemon-light) has no content scanning' } } }, () => page(Spam, 'spam'));
    expect(light).toContain('built without content scanning');
    expect(light).toContain('exim4-daemon-light');
    expect(light).not.toContain('Save spam settings');
    expect(withFixtures({ '/email/spam': { data: { ...settings, available: false, reason: 'spamd_not_running' } } }, () => page(Spam, 'spam'))).toContain('daemon is not running');
    expect(Spam.unavailableText('exim_missing')).toMatch(/not installed/);
    expect(withFixtures({ '/email/spam': { error: featureOff } }, () => page(Spam, 'spam'))).toContain('Not included in your plan');
    expect(withFixtures({ '/email/spam': { error: noDaemon } }, () => page(Spam, 'spam'))).toContain('Not available on this server');
    expect(Spam.scoreHint(2)).toMatch(/strict/);
    expect(Spam.scoreHint(5)).toMatch(/Balanced/);
    expect(Spam.scoreHint(15)).toMatch(/lenient/);
  });
});

describe('Deliverability', () => {
  const report = {
    domain: 'demo.example.com', account: 'demo', zone: true, score: 40, checkedAt: '2026-11-03T10:00:00Z',
    items: [
      { id: 'spf', label: 'SPF', status: 'ok', current: ['v=spf1 +mx ~all'], expected: 'v=spf1 +mx ~all', detail: null, fixable: true },
      { id: 'dkim', label: 'DKIM', selector: 'default', status: 'missing', current: [], expected: null, detail: 'No DKIM key has been generated for this domain yet.', fixable: true, signing: null, signingHint: null },
      { id: 'dmarc', label: 'DMARC', status: 'missing', current: [], expected: 'v=DMARC1; p=none; rua=mailto:postmaster@demo.example.com', detail: 'No _dmarc TXT record.', fixable: true },
      { id: 'mx', label: 'MX', status: 'ok', current: ['0 mail.demo.example.com'], expected: null, detail: null, fixable: false },
      { id: 'ptr', label: 'Reverse DNS (PTR)', status: 'missing', current: ['192.0.2.2 → (none)'], expected: '192.0.2.2 → srv1.example', detail: 'An outbound address has no PTR record.', fixable: false },
    ],
  };
  it('shows the score, each check with fix actions, and the DKIM card', () => {
    const html = withFixtures({ '/email/deliverability/demo.example.com': { data: report }, '/email/dkim/demo.example.com': { data: { domain: 'demo.example.com', zone: true, key: null } } }, () => page(Deliverability, 'deliverability'));
    expect(html).toContain('<h1>Deliverability</h1>');
    expect(html).toContain('aria-label="Domain"');
    expect(html).toContain('shop.example.org');
    expect(html).toContain('Deliverability score');
    expect(html).toContain('>40<');
    expect(html).toContain('meter bad');
    expect(html).toContain('2 of 5');
    expect(html).toContain('Fix all (DKIM, DMARC)');
    expect(html).toContain('v=DMARC1; p=none');
    expect(html).toContain('Ask your provider');
    expect(html).toContain('>Missing<');
    expect(html).toContain('DKIM signing key');
    expect(html).toContain('Generate key');
    expect(html).toContain('No key');
    expect(html).toContain('href="/panel/dns/zone-editor"');
  });
  it('hides fixes without a local zone, shows key actions when a key exists, and the 501 state', () => {
    const html = withFixtures({ '/email/deliverability/demo.example.com': { data: { ...report, zone: false } }, '/email/dkim/demo.example.com': { data: { domain: 'demo.example.com', zone: false, key: { selector: 'default', createdAt: '2026-11-01T00:00:00Z' } } } }, () => page(Deliverability, 'deliverability'));
    expect(html).toContain('not hosted on this server');
    expect(html).not.toContain('Fix all');
    expect(html).toContain('Rotate key');
    expect(html).toContain('Remove key');
    expect(html).toContain('Key installed');
    const missing = withFixtures({ '/email/deliverability/demo.example.com': { error: noDaemon }, '/email/dkim/demo.example.com': { error: noDaemon } }, () => page(Deliverability, 'deliverability'));
    expect(missing).toContain('Not available on this server');
    expect(Deliverability.scoreTone(90)).toBe('');
    expect(Deliverability.scoreTone(60)).toBe('warn');
  });
});

describe('Webmail', () => {
  it('links to webmail with a prefilled user and lists mailboxes', () => {
    const info = { installed: true, flavor: 'roundcube', version: '1.6.9', url: 'https://srv1.example/webmail/', configuredUrl: null, prefillUser: 'info@demo.example.com', hostname: 'srv1.example' };
    const html = withFixtures({ '/email/webmail': { data: info }, '/email/accounts': { data: mailboxes, meta: { total: 2 } } }, () => page(Webmail, 'webmail'));
    expect(html).toContain('<h1>Webmail</h1>');
    expect(html).toContain('Open webmail');
    expect(html).toContain('href="https://srv1.example/webmail/?_user=info%40demo.example.com"');
    expect(html).toContain('roundcube 1.6.9');
    expect(html).toContain('Your mailboxes');
    expect(html).toContain('sales%40shop.example.org');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(Webmail.webmailLink({ url: 'https://x/mail', flavor: 'other' }, 'a@b.co')).toBe('https://x/mail');
  });
  it('explains when no webmail is installed; 501', () => {
    const html = withFixtures({ '/email/webmail': { data: { installed: false, flavor: null, version: null, url: null, configuredUrl: null, prefillUser: null, hostname: 'vm' } }, '/email/accounts': { data: [], meta: {} } }, () => page(Webmail, 'webmail'));
    expect(html).toContain('Webmail is not set up on this server');
    expect(html).toContain('href="/panel/email/accounts"');
    expect(withFixtures({ '/email/webmail': { error: noDaemon }, '/email/accounts': { data: [] } }, () => page(Webmail, 'webmail'))).toContain('Not available on this server');
  });
});

describe('Mail usage', () => {
  const usage = {
    hours: 24, domains: ['demo.example.com'], totals: { messages: 12, sent: 7, received: 5, delivered: 10, failed: 1, deferred: 1, queued: 0 },
    byDomain: [{ domain: 'demo.example.com', delivered: 10, failed: 1, deferred: 1 }],
    mailboxes: [{ address: 'info@demo.example.com', sent: 7, received: 5, failed: 1 }],
    recent: [{ id: 'm1', arrivedAt: '2026-11-03T09:00:00Z', sender: 'info@demo.example.com', recipient: 'x@example.org', status: 'delivered', subject: 'Hello', size: 2048, detail: null }, { id: 'm2', arrivedAt: '2026-11-03T09:05:00Z', sender: 'info@demo.example.com', recipient: 'y@example.org', status: 'failed', subject: null, size: null, detail: 'Unrouteable address' }],
    storage: { mailboxes: 2, quotaMb: 2048, limit: 10 }, log: { from: '2026-11-02 00:00:00', truncated: false, exists: true },
  };
  it('renders totals, per-mailbox, per-domain and message tables', () => {
    const messages = { data: usage.recent, meta: { page: 1, pageSize: 25, total: 2 } };
    const html = withFixtures({ '/email/usage': { data: usage }, '/email/usage/messages': messages }, () => page(Usage, 'usage'));
    expect(html).toContain('<h1>Mail usage</h1>');
    expect(html).toContain('aria-label="Time window"');
    expect(html).toContain('Last 7 days');
    expect(html).toContain('>12<');
    expect(html).toContain('dot dot-bad');
    expect(html).toContain('2 of 10');
    expect(html).toContain('2.00 GB allotted');
    expect(html).toContain('Per mailbox');
    expect(html).toContain('Per domain');
    expect(html).toContain('>Messages<');
    expect(html).toContain('Unrouteable address');
    expect(html).toContain('2.00 KB');
    expect(html).toContain('Log entries start');
  });
  it('shows the capability state when Exim is missing', () => {
    const html = withFixtures({ '/email/usage': { error: noDaemon } }, () => page(Usage, 'usage'));
    expect(html).toContain('Not available on this server');
    expect(html).toContain('aria-label="Time window"');
    expect(html).not.toContain('>Messages<');
  });
});

describe('shared parts', () => {
  it('classify errors and render limit and capability banners for mutations', () => {
    expect(Shared.isCapabilityError(noDaemon)).toBe(true);
    expect(Shared.isFeatureDisabled(featureOff)).toBe(true);
    expect(Shared.isFeatureDisabled({ status: 403, code: 'forbidden' })).toBe(false);
    expect(render(h(Shared.MutationError, { error: { status: 409, code: 'limit_reached', message: 'Your hosting package allows at most 10 email' } }))).toContain('Plan limit reached');
    expect(render(h(Shared.MutationError, { error: noDaemon }))).toContain('Not available on this server');
    expect(render(h(Shared.MutationError, { error: { message: 'Boom', fields: { password: ['Too short'] } } }))).toContain('Too short');
    expect(Shared.quotaText(null)).toBe('Unlimited');
    expect(Shared.quotaText(1536)).toBe('1.50 GB');
  });
});
