import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY, CATEGORIES } from '../src/nav.js';

const auth = { user: { id: 1, username: 'root', role: 'root' } };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

// Static rendering never runs effects: useApi answers from a path-keyed table.
const apiData = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: apiData[path]?.data ?? null, meta: apiData[path]?.meta ?? null, error: null, loading: !apiData[path], refetch: () => {}, setData: () => {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { ChatWorkspace, ConversationList, MessageList, Composer, groupByDay, listPath, conversationPath, conversationLabel, describeParty, MESSAGE_MAX_CHARS } = await import('../src/pages/support/ChatWorkspace.jsx');
const { default: AccountConversationsPage } = await import('../src/pages/fn/support/account-conversations.jsx');
const { AccountSummary, AccountManager } = await import('../src/pages/accounts/AccountDetails.jsx');
const { default: CreateAccount } = await import('../src/pages/accounts/CreateAccount.jsx');
const { default: ModifyAccount } = await import('../src/pages/accounts/ModifyAccount.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el, entries = ['/support/account-conversations']) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter initialEntries={entries}>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

const rows = [
  { account: { id: 1, username: 'alice', domain: 'alice.example', owner: 'resell1', suspended: false, manager: { username: 'resell1', role: 'reseller', email: 'r1@example.com' } }, conversation: { id: 1, subject: 'Mail delivery', status: 'open', lastMessageAt: '2026-10-29 10:00:00', messageCount: 3, unread: 2, lastPreview: 'Still broken.', lastAuthor: 'alice' } },
  { account: { id: 2, username: 'bob', domain: 'bob.example', owner: 'root', suspended: true, manager: null }, conversation: { id: 2, subject: null, status: 'closed', lastMessageAt: '2026-10-28 09:00:00', messageCount: 1, unread: 0, lastPreview: 'Welcome.', lastAuthor: 'root' } },
  { account: { id: 3, username: 'carol', domain: 'carol.example', owner: 'root', suspended: false, manager: { username: 'root', role: 'root', email: null } }, conversation: null },
];

describe('Account Conversations', () => {
  it('is the fourth Support function and registered as a page', () => {
    const fn = FUNCTION_BY_KEY['support/account-conversations'];
    expect(fn).toMatchObject({ label: 'Account Conversations', categorySlug: 'support', phase: 2 });
    expect(CATEGORIES.find((c) => c.slug === 'support').functions).toHaveLength(4);
    const html = render(<AccountConversationsPage fn={fn} />);
    expect(html).toContain('Account Conversations');
    expect(html).toContain('One thread per hosting account');
  });

  it('renders the list with unread badges, closed pills, managers and the empty thread prompt', () => {
    apiData[listPath('')] = { data: rows, meta: { page: 1, pageSize: 200, total: 3, viewerSide: 'manager' } };
    const html = render(<ChatWorkspace />);
    expect(html).toContain('alice.example');
    expect(html).toContain('title="2 unread"');
    expect(html).toContain('manager resell1');
    expect(html).toContain('alice: Still broken.');
    expect(html).toContain('closed');
    expect(html).toContain('no messages');
    expect(html).toContain('Select a conversation');
    expect(html).toContain('Filter by user, domain, owner or subject');
    delete apiData[listPath('')];
  });

  it('shows the hosted-account view with the manager line and no filter box', () => {
    auth.user = { id: 7, username: 'alice', role: 'user' };
    apiData[listPath('')] = { data: [rows[0]], meta: { page: 1, pageSize: 200, total: 1, viewerSide: 'account' } };
    const html = render(<ChatWorkspace />);
    expect(html).toContain('Account manager: <strong>resell1</strong>');
    expect(html).toContain('r1@example.com');
    expect(html).not.toContain('Filter by user');
    expect(html).not.toContain('manager resell1');
    const page = render(<AccountConversationsPage fn={FUNCTION_BY_KEY['support/account-conversations']} />);
    expect(page).toContain('My support');
    auth.user = { id: 1, username: 'root', role: 'root' };
    delete apiData[listPath('')];
  });

  it('lays messages out by day and side, and the composer counts characters', () => {
    const messages = [
      { id: 1, author: 'root', authorRole: 'root', side: 'manager', body: 'Hello <b>there</b>', createdAt: '2026-10-28 09:00:00' },
      { id: 2, author: 'alice', authorRole: 'user', side: 'account', body: 'Hi\nSecond line', createdAt: '2026-10-28 10:00:00' },
      { id: 3, author: 'resell1', authorRole: 'reseller', side: 'manager', body: 'Fixed.', createdAt: '2026-10-29 08:00:00' },
    ];
    expect(groupByDay(messages).map((g) => [g.day, g.messages.length])).toEqual([['2026-10-28', 2], ['2026-10-29', 1]]);
    expect(groupByDay([])).toEqual([]);
    const html = render(<MessageList messages={messages} viewerSide="manager" />);
    expect(html).toContain('2026-10-28');
    expect(html).toContain('&lt;b&gt;there&lt;/b&gt;');
    expect(html).toContain('justify-content:flex-end');
    expect(html).toContain('justify-content:flex-start');
    expect(html).toContain('· account ·');
    expect(render(<MessageList messages={[]} viewerSide="account" />)).toContain('No messages yet');
    const composer = render(<Composer onSend={() => {}} status="closed" />);
    expect(composer).toContain(`${MESSAGE_MAX_CHARS.toLocaleString()} characters left`);
    expect(composer).toContain('sending a message reopens it');
    expect(composer).toContain('disabled=""');
  });

  it('helpers build paths and labels', () => {
    expect(listPath('bob')).toBe('/support/chat?q=bob&pageSize=200');
    expect(listPath('')).toBe('/support/chat?pageSize=200');
    expect(conversationPath('al ice')).toBe('/support/account-conversations?account=al%20ice');
    expect(conversationLabel(rows[0])).toBe('Mail delivery');
    expect(conversationLabel(rows[1])).toBe('Support for bob.example');
    expect(describeParty('manager', 'manager')).toBe('you');
    expect(describeParty('manager', 'account')).toBe('your account manager');
    expect(describeParty('account', 'manager')).toBe('the account');
  });

  it('ConversationList marks the selected row', () => {
    const html = render(<ConversationList rows={rows} selected="bob" onSelect={() => {}} q="" onSearch={() => {}} viewerSide="manager" />);
    expect(html).toContain('aria-selected="true"');
    expect((html.match(/aria-selected="false"/g) || []).length).toBe(2);
    const empty = render(<ConversationList rows={[]} selected="" onSelect={() => {}} q="" onSearch={() => {}} viewerSide="account" />);
    expect(empty).toContain('No hosting account is linked to this login');
  });

  it('account details show the manager with a link to the conversation', () => {
    const account = { username: 'alice', domain: 'alice.example', owner: 'resell1', manager: 'resell1', manager_role: 'reseller', manager_email: 'r1@example.com', suspended: false, home_dir: '/home/alice', disk_used_mb: 10, disk_quota_mb: 100, bandwidth_used_mb: 1, bandwidth_limit_mb: 50, created_at: '2026-10-01 00:00:00' };
    const html = render(<AccountSummary account={account} />);
    expect(html).toContain('Account manager');
    expect(html).toContain('<strong>resell1</strong>');
    expect(html).toContain('r1@example.com');
    expect(html).toContain('href="/support/account-conversations?account=alice"');
    expect(render(<AccountManager account={{ ...account, manager: null }} />)).toContain('No manager assigned');
    expect(render(<AccountSummary account={null} />)).not.toContain('class="kv"');
  });

  it('the account forms carry the manager selector fed by /accounts/managers', () => {
    apiData['/accounts/managers'] = { data: [{ username: 'root', role: 'root', email: null }, { username: 'resell1', role: 'reseller', email: 'r1@example.com' }] };
    apiData['/packages?pageSize=500'] = { data: [{ name: 'default' }] };
    const create = render(<CreateAccount fn={FUNCTION_BY_KEY['account-functions/create-a-new-account']} />);
    expect(create).toContain('Managed by');
    expect(create).toContain('Default: you (root)');
    expect(create).toContain('resell1 (reseller, r1@example.com)');
    const modify = render(<ModifyAccount fn={FUNCTION_BY_KEY['account-functions/modify-an-account']} />);
    expect(modify).toContain('Modify an Account');
    delete apiData['/accounts/managers'];
    delete apiData['/packages?pageSize=500'];
  });
});
