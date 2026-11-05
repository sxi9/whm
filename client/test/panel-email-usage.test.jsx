import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

// GET fixtures keyed by the path usePanelApi asks for (query string ignored); the
// query strings are recorded so the filter → request mapping can be asserted.
const fixtures = new Map();
const requested = [];
const EMPTY = { data: null, meta: null, error: null, loading: false, refetch: () => {}, setData: () => {} };
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    if (!path) return { ...EMPTY };
    requested.push(path);
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
const Usage = await import('../src/pages/panel/email/usage.jsx');

React.useLayoutEffect = React.useEffect;

const fn = PANEL_FUNCTION_BY_KEY['panel:email/usage'];
const me = { user: { id: 7, username: 'demo', role: 'user' }, account: { username: 'demo', domain: 'demo.example.com', features: {}, limits: {}, domains: [] }, usage: {}, counts: { mailboxes: 2 }, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't' };
const render = (ctx = {}) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [fn.path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: { me: { ...me, ...ctx }, loading: false, error: null, reload: () => {}, hasFeature: () => true } }, h(ToastProvider, null, h(ConfirmProvider, null, h(Usage.default, { fn })))))));
const withFixtures = (entries, run) => { fixtures.clear(); requested.length = 0; for (const [k, v] of Object.entries(entries)) fixtures.set(k, v); try { return run(); } finally { fixtures.clear(); } };

const usage = {
  hours: 24, domains: ['demo.example.com'], totals: { messages: 12, sent: 7, received: 5, delivered: 10, failed: 1, deferred: 1, queued: 0 },
  byDomain: [], mailboxes: [{ address: 'info@demo.example.com', sent: 7, received: 5, failed: 1 }],
  storage: { mailboxes: 2, quotaMb: 2048, limit: 10 }, log: { from: null, truncated: false, exists: true },
};
const messages = {
  data: [
    { id: 'm1', key: '1:0', arrivedAt: '2026-11-03T09:00:00Z', sender: 'info@demo.example.com', recipient: 'x@example.org', status: 'delivered', subject: 'Hello', size: 2048, detail: null },
    { id: 'm2', key: '2:0', arrivedAt: '2026-11-03T09:05:00Z', sender: 'info@demo.example.com', recipient: 'y@example.org', status: 'failed', subject: null, size: null, detail: 'Unrouteable address' },
  ],
  meta: { page: 1, pageSize: 25, total: 60, hours: 24, q: null, status: null, log: { exists: true } },
};
const mailboxes = [{ id: 1, address: 'info@demo.example.com' }, { id: 2, address: 'sales@demo.example.com' }];
const folders = {
  data: [{ name: 'INBOX', messages: 12, bytes: 40960, unseen: 3, emptiable: false }, { name: 'Trash', messages: 4, bytes: 2048, unseen: 0, emptiable: true }, { name: 'Junk', messages: 0, bytes: 0, unseen: 0, emptiable: true }],
  meta: { mailbox: { id: 1, address: 'info@demo.example.com' }, usage: { bytes: 43008, limitBytes: 1073741824, messages: 16, source: 'dovecot' }, minOlderThanDays: 7 },
};

describe('Mail usage: delivery tracking', () => {
  it('asks /email/usage/messages with the window and page size, and renders search, status filter and pager', () => {
    const html = withFixtures({ '/email/usage': { data: usage }, '/email/usage/messages': messages, '/email/accounts': { data: mailboxes }, '/email/accounts/1/folders': folders }, () => render());
    expect(requested).toContain('/panel/email/usage/messages?sinceHours=24&page=1&pageSize=25');
    expect(html).toContain('placeholder="Address, subject or message id…"');
    expect(html).toContain('aria-label="Status"');
    expect(html).toContain('<option value="failed">Failed</option>');
    expect(html).toContain('1–25 of 60');
    expect(html).toContain('Page 1 of 3');
    expect(html).toContain('Unrouteable address');
    expect(html).toContain('2.00 KB');
    expect(html).not.toContain('Recent messages');
  });

  it('messagesQuery maps the filter state to the query string', () => {
    expect(Usage.messagesQuery({ hours: '72', q: 'invoice 42', status: 'failed', page: 3 })).toBe('/email/usage/messages?sinceHours=72&page=3&pageSize=25&q=invoice+42&status=failed');
    expect(Usage.messagesQuery({ hours: 24, q: '', status: '', page: 1 })).toBe('/email/usage/messages?sinceHours=24&page=1&pageSize=25');
    expect(Usage.STATUSES.map((s) => s.value)).toEqual(['', 'delivered', 'failed', 'deferred', 'rejected', 'queued', 'completed']);
  });
});

describe('Mail usage: folders per mailbox', () => {
  it('lists the folders of the selected mailbox with Empty for Trash/Junk and "Delete old mail" otherwise', () => {
    const html = withFixtures({ '/email/usage': { data: usage }, '/email/usage/messages': messages, '/email/accounts': { data: mailboxes }, '/email/accounts/1/folders': folders }, () => render());
    expect(requested).toContain('/panel/email/accounts/1/folders');
    expect(html).toContain('aria-label="Mailbox"');
    expect(html).toContain('<option value="2">sales@demo.example.com</option>');
    expect(html).toContain('<code>INBOX</code>');
    expect(html).toContain('<code>Trash</code>');
    expect(html).toContain('40.0 KB');
    expect(html).toContain('42.0 KB of 1.00 GB used, 16 messages');
    expect((html.match(/>Empty</g) || []).length).toBe(2);
    expect((html.match(/>Delete old mail</g) || []).length).toBe(1);
    // Junk is empty: its button is disabled; INBOX and Trash hold mail.
    expect(html).toMatch(/disabled=""[^>]*>[^<]*<svg[^>]*>(?:(?!<\/button>).)*Empty<\/button>/);
    expect(Usage.EMPTIABLE).toEqual(['Trash', 'Junk']);
    expect(Usage.MIN_OLDER_THAN_DAYS).toBe(7);
  });

  it('disables emptying while logged in as the account and shows the empty state without mailboxes', () => {
    let html = withFixtures({ '/email/usage': { data: usage }, '/email/usage/messages': messages, '/email/accounts': { data: mailboxes }, '/email/accounts/1/folders': folders }, () => render({ actingAs: { account: 'demo', by: 'root', expiresAt: new Date(Date.now() + 60000).toISOString() } }));
    expect((html.match(/disabled=""/g) || []).length).toBeGreaterThanOrEqual(3);
    html = withFixtures({ '/email/usage': { data: usage }, '/email/usage/messages': messages, '/email/accounts': { data: [] } }, () => render());
    expect(html).toContain('No mailboxes yet');
    expect(html).not.toContain('aria-label="Mailbox"');
  });

  it('shows the capability state for folders when Dovecot is missing', () => {
    const noDaemon = { status: 501, code: 'capability_missing', message: 'Dovecot is not installed on this server, so mailbox folders cannot be read' };
    const html = withFixtures({ '/email/usage': { data: usage }, '/email/usage/messages': messages, '/email/accounts': { data: mailboxes }, '/email/accounts/1/folders': { error: noDaemon } }, () => render());
    expect(html).toContain('Not available on this server');
    expect(html).toContain('Folders');
  });
});
