import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

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
const { PANEL_FUNCTION_BY_KEY, PANEL_FUNCTIONS } = await import('../src/panel/nav.js');
const { registryKeysFrom } = await import('../src/panel/registry.js');
const Filters = await import('../src/pages/panel/email/filters.jsx');
const GlobalFilters = await import('../src/pages/panel/email/global-filters.jsx');
const Parts = await import('../src/pages/panel/email/parts/Filters.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', features: { emailfilters: true }, limits: {}, domains: [{ domain: 'demo.example.com', type: 'main' }] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = (slug) => PANEL_FUNCTION_BY_KEY[`panel:email/${slug}`];
const render = (el, path = '/panel/email/filters') => renderToStaticMarkup(
  h(ToastProvider, null, h(ConfirmProvider, null, h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, el))))),
);
const page = (Mod, slug, path = `/panel/email/${slug}`) => render(h(Mod.default, { fn: fn(slug) }), path);
const withFixtures = (entries, run) => { fixtures.clear(); for (const [k, v] of Object.entries(entries)) fixtures.set(k, v); try { return run(); } finally { fixtures.clear(); } };

const featureOff = { status: 403, code: 'feature_disabled', message: 'Your hosting package does not include "emailfilters"' };
const noSieve = { status: 501, code: 'capability_missing', capability: 'sieve', message: 'sievec (dovecot-sieve) is required.' };

const mailboxes = [{ id: 1, address: 'info@demo.example.com', localPart: 'info', domain: 'demo.example.com', quotaMb: 1024, suspended: false, usage: null }];
const filters = [
  { id: 11, scope: 'mailbox', mailboxId: 1, name: 'Test to Junk', position: 1, enabled: true, rules: { matchAll: true, match: [{ header: 'subject', op: 'contains', value: '[test]' }], actions: [{ type: 'fileinto', folder: 'Junk' }, { type: 'stop' }] } },
  { id: 12, scope: 'mailbox', mailboxId: 1, name: 'Boss', position: 2, enabled: false, rules: { matchAll: false, match: [{ header: 'from', op: 'is', value: 'boss@x.com' }, { header: 'custom', name: 'x-priority', op: 'matches', value: '1*' }], actions: [{ type: 'redirect', address: 'me@y.com' }] } },
];
const meta = { scope: 'mailbox', mailbox: { id: 1, address: 'info@demo.example.com' }, max: 100, folders: ['INBOX', 'Junk', 'Trash'], sieve: { available: true }, script: '# Keel\nrequire ["fileinto"];\n' };

describe('registry and nav', () => {
  it('both filter functions have a page file and the emailfilters feature', () => {
    const keys = registryKeysFrom(['filters', 'global-filters'].map((s) => `../pages/panel/email/${s}.jsx`));
    for (const slug of ['filters', 'global-filters']) {
      expect(keys).toContain(fn(slug).key);
      expect(fn(slug).feature).toBe('emailfilters');
    }
    expect(PANEL_FUNCTIONS.filter((f) => f.feature === 'emailfilters')).toHaveLength(2);
  });
});

describe('Email filters (per mailbox)', () => {
  it('asks for a mailbox first, then lists the filters of the chosen one in order with their state', () => {
    const picker = withFixtures({ '/email/accounts': { data: mailboxes, meta: {} } }, () => page(Filters, 'filters'));
    expect(picker).toContain('<h1>Email filters</h1>');
    expect(picker).toContain('Choose a mailbox');
    expect(picker).toContain('info@demo.example.com');
    expect(picker).not.toContain('Create filter');
    const html = withFixtures({ '/email/accounts': { data: mailboxes, meta: {} }, '/email/filters': { data: filters, meta } }, () => page(Filters, 'filters', '/panel/email/filters?mailbox=1'));
    expect(html).toContain('Create filter');
    expect(html).toContain('Test to Junk');
    expect(html).toContain('Subject contains &quot;[test]&quot; → deliver to Junk, stop');
    expect(html).toContain('From is exactly &quot;boss@x.com&quot; or x-priority matches (* and ? wildcards) &quot;1*&quot; → redirect to me@y.com');
    expect(html).toContain('>Enabled<');
    expect(html).toContain('>Disabled<');
    expect(html).toContain('Generated script');
    expect(html).toContain('1 of 2 filters enabled, 100 allowed');
    expect(html.indexOf('Test to Junk')).toBeLessThan(html.indexOf('Boss'));
  });

  it('renders the empty, no-mailbox, 403 and 501 states and the Sieve-missing note', () => {
    expect(withFixtures({ '/email/accounts': { data: [], meta: {} } }, () => page(Filters, 'filters'))).toContain('Create a mailbox under Email accounts first');
    expect(withFixtures({ '/email/accounts': { data: mailboxes, meta: {} }, '/email/filters': { data: [], meta } }, () => page(Filters, 'filters', '/panel/email/filters?mailbox=1'))).toContain('No filters yet');
    expect(withFixtures({ '/email/accounts': { error: featureOff } }, () => page(Filters, 'filters'))).toContain('Not included in your plan');
    expect(withFixtures({ '/email/accounts': { data: mailboxes, meta: {} }, '/email/filters': { error: featureOff } }, () => page(Filters, 'filters', '/panel/email/filters?mailbox=1'))).toContain('Not included in your plan');
    expect(withFixtures({ '/email/accounts': { data: mailboxes, meta: {} }, '/email/filters': { error: noSieve } }, () => page(Filters, 'filters', '/panel/email/filters?mailbox=1'))).toContain('Not available on this server');
    expect(withFixtures({ '/email/accounts': { data: mailboxes, meta: {} }, '/email/filters': { data: [], meta: { ...meta, sieve: { available: false } } } }, () => page(Filters, 'filters', '/panel/email/filters?mailbox=1'))).toContain('dovecot-sieve');
  });
});

describe('Account-wide filters', () => {
  it('lists the account scope with its explanation and states', () => {
    const html = withFixtures({ '/email/global-filters': { data: [filters[0]], meta: { ...meta, scope: 'account', mailbox: null } } }, () => page(GlobalFilters, 'global-filters'));
    expect(html).toContain('<h1>Account-wide filters</h1>');
    expect(html).toContain('before the mailbox');
    expect(html).toContain('Test to Junk');
    expect(withFixtures({ '/email/global-filters': { data: [], meta: { ...meta, scope: 'account', mailbox: null } } }, () => page(GlobalFilters, 'global-filters'))).toContain('run before each mailbox');
    expect(withFixtures({ '/email/global-filters': { error: featureOff } }, () => page(GlobalFilters, 'global-filters'))).toContain('Not included in your plan');
    expect(withFixtures({ '/email/global-filters': { error: noSieve } }, () => page(GlobalFilters, 'global-filters'))).toContain('Not available on this server');
  });
});

describe('rule builder', () => {
  it('renders the builder for a new and an existing filter, with the Test action and compiler feedback', () => {
    const create = render(h(Parts.FilterForm, { existing: null, folders: ['INBOX', 'Junk'], onSubmit() {}, onTest() {}, onCancel() {}, busy: false, error: { message: 'Invalid', fields: { name: ['Required'] } } }));
    expect(create).toContain('aria-label="Filter name"');
    expect(create).toContain('aria-label="Field"');
    expect(create).toContain('aria-label="Operator"');
    expect(create).toContain('aria-label="Value"');
    expect(create).toContain('aria-label="Action"');
    expect(create).toContain('aria-label="Folder"');
    expect(create).toContain('>Test<');
    expect(create).toContain('Create filter');
    expect(create).toContain('Required');
    const edit = render(h(Parts.FilterForm, { existing: filters[1], folders: ['Junk'], onSubmit() {}, onTest() {}, onCancel() {}, busy: false, error: null, testResult: { ok: false, errors: [{ line: 2, message: 'unknown command' }], script: 'if {' } }));
    expect(edit).toContain('value="Boss"');
    expect(edit).toContain('aria-label="Header name"');
    expect(edit).toContain('value="x-priority"');
    expect(edit).toContain('aria-label="Redirect address"');
    expect(edit).toContain('Any condition may match');
    expect(edit).toContain('does not compile');
    expect(edit).toContain('Line 2: unknown command');
    expect(edit).toContain('Save changes');
  });

  it('helpers: payload shape, completeness, descriptions', () => {
    const form = { matchAll: false, match: [{ header: 'custom', name: ' X-Spam ', op: 'contains', value: ' yes ' }, { header: 'subject', op: 'is', value: 'x' }], actions: [{ type: 'fileinto', folder: ' Junk ' }, { type: 'redirect', address: 'a@b.com' }, { type: 'stop', folder: 'ignored' }] };
    expect(Parts.rulesFromForm(form)).toEqual({ matchAll: false, match: [{ header: 'custom', name: 'X-Spam', op: 'contains', value: 'yes' }, { header: 'subject', op: 'is', value: 'x' }], actions: [{ type: 'fileinto', folder: 'Junk' }, { type: 'redirect', address: 'a@b.com' }, { type: 'stop' }] });
    expect(Parts.formComplete(form)).toBe(true);
    expect(Parts.formComplete({ match: [{ header: 'custom', name: '', op: 'contains', value: 'x' }], actions: [{ type: 'stop' }] })).toBe(false);
    expect(Parts.formComplete({ match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'fileinto', folder: '' }] })).toBe(false);
    expect(Parts.formComplete({ match: [], actions: [{ type: 'stop' }] })).toBe(false);
    expect(Parts.describeFilter({ match: [], actions: [] })).toBe('every message → nothing');
    expect(Parts.describeFilter(filters[0].rules)).toBe('Subject contains "[test]" → deliver to Junk, stop');
  });
});
