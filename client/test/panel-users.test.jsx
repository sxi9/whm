import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (p) => ({ data: null, meta: null, error: null, loading: Boolean(p), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(p) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY, visibleCategories } = await import('../src/panel/nav.js');
const { PANEL_ICONS, panelColorFor } = await import('../src/panel/icons.js');
const { default: UserManager, needsPassword, validateForm, toBody, fromRow, serviceBadges, filterUsers, EMPTY_FORM } = await import('../src/pages/panel/preferences/users.jsx');
const { PANEL_PAGE_REGISTRY } = await import('../src/panel/registry.js');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: {}, features: {}, limits: {}, contactEmail: 'owner@demo.example.com', domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:preferences/users'];
const render = (el, p) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [p] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (p, value) => fixtures.responses.set(p, { loading: false, ...value });
const STRONG = 'Str0ng-Passw0rd!xyz';
const rows = [
  { id: 1, username: 'jane', domain: 'demo.example.com', login: 'jane@demo.example.com', fullName: 'Jane Doe', contactEmail: 'jane@example.org', services: { email: { enabled: true, quotaMb: 256, address: 'jane@demo.example.com', present: true }, ftp: { enabled: true, homeDir: 'public_html/jane', present: false }, dav: { enabled: true, login: 'jane@demo.example.com' } }, createdAt: '2026-11-06T10:00:00.000Z', updatedAt: '2026-11-06T10:00:00.000Z' },
  { id: 2, username: 'bob', domain: 'demo.example.com', login: 'bob@demo.example.com', fullName: '', contactEmail: null, services: { email: { enabled: false, quotaMb: null, address: null, present: null }, ftp: { enabled: false, homeDir: 'public_html', present: null }, dav: { enabled: false, login: null } }, createdAt: '2026-11-06T10:00:00.000Z', updatedAt: '2026-11-06T10:00:00.000Z' },
];
const meta = { total: 2, max: null, domains: ['demo.example.com'], features: { email: true, ftp: true }, defaults: { email: { enabled: false, quotaMb: null }, ftp: { enabled: false, homeDir: 'public_html' }, dav: { enabled: false } } };

describe('nav entry of the Preferences group', () => {
  it('is registered with its plan feature, page, icon and i18n keys', () => {
    expect(fn).toMatchObject({ feature: 'usermanager', path: '/panel/preferences/users', categorySlug: 'preferences', key: 'panel:preferences/users' });
    expect(PANEL_PAGE_REGISTRY['panel:preferences/users']).toBeTruthy();
    expect(PANEL_ICONS.Settings).toBeTruthy();
    expect(panelColorFor('preferences')).toMatch(/^#[0-9a-f]{6}$/);
    expect(visibleCategories({ usermanager: false }).some((c) => c.slug === 'preferences')).toBe(false);
    expect(visibleCategories({}).find((c) => c.slug === 'preferences').functions.map((f) => f.slug)).toEqual(['users']);
    const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/i18n/en.json'), 'utf8'));
    expect(en['panel-category.preferences']).toBe('Preferences');
    expect(en['panel.preferences/users.label']).toBe('User manager');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/pages/panel/preferences/users.jsx'), 'utf8');
    for (const key of src.matchAll(/t\('(panel\.users\.[a-z0-9_]+)'/g)) expect(en[key[1]], key[1]).toBeDefined();
  });
});

describe('form helpers', () => {
  it('needs a password on create, when a service switches on, or when the FTP folder moves', () => {
    expect(needsPassword(null, EMPTY_FORM)).toBe(true);
    expect(needsPassword(rows[1], { ...EMPTY_FORM })).toBe(false);
    expect(needsPassword(rows[1], { ...EMPTY_FORM, email: true })).toBe(true);
    expect(needsPassword(rows[1], { ...EMPTY_FORM, ftp: true })).toBe(true);
    expect(needsPassword(rows[0], fromRow(rows[0]))).toBe(false);
    expect(needsPassword(rows[0], { ...fromRow(rows[0]), homeDir: 'public_html' })).toBe(true);
    expect(needsPassword(rows[0], { ...fromRow(rows[0]), dav: false })).toBe(false);
  });

  it('validates names, domains, contact addresses, folders and the password', () => {
    expect(validateForm({ ...EMPTY_FORM, username: 'Jane', domain: 'demo.example.com', password: STRONG }, null)).toHaveProperty('username');
    expect(validateForm({ ...EMPTY_FORM, username: 'jane', domain: '', password: STRONG }, null)).toHaveProperty('domain');
    expect(validateForm({ ...EMPTY_FORM, username: 'jane', domain: 'demo.example.com', password: STRONG, contactEmail: 'nope' }, null)).toHaveProperty('contactEmail');
    expect(validateForm({ ...EMPTY_FORM, username: 'jane', domain: 'demo.example.com', password: STRONG, ftp: true, homeDir: '../etc' }, null)).toHaveProperty('homeDir');
    expect(validateForm({ ...EMPTY_FORM, username: 'jane', domain: 'demo.example.com', password: 'weak' }, null)).toHaveProperty('password');
    expect(validateForm({ ...EMPTY_FORM, username: 'jane', domain: 'demo.example.com', password: STRONG, ftp: true, homeDir: 'public_html/jane' }, null)).toBeNull();
    expect(validateForm({ ...fromRow(rows[1]), fullName: 'Bob' }, rows[1])).toBeNull();
    expect(validateForm({ ...fromRow(rows[1]), email: true }, rows[1])).toHaveProperty('password');
    expect(validateForm({ ...fromRow(rows[1]), password: 'weak' }, rows[1])).toHaveProperty('password');
  });

  it('builds the create and edit bodies the API expects', () => {
    expect(toBody({ ...EMPTY_FORM, username: 'jane', domain: 'demo.example.com', password: STRONG, fullName: ' Jane ', contactEmail: '', email: true, quotaMb: 100, ftp: true, homeDir: '/public_html/jane' }, null)).toEqual({
      username: 'jane', domain: 'demo.example.com', password: STRONG, fullName: 'Jane', contactEmail: null,
      services: { email: { enabled: true, quotaMb: 100 }, ftp: { enabled: true, homeDir: 'public_html/jane' }, dav: { enabled: false } },
    });
    const edit = toBody({ ...fromRow(rows[0]), ftp: false }, rows[0]);
    expect(edit).toEqual({ fullName: 'Jane Doe', contactEmail: 'jane@example.org', services: { email: { enabled: true, quotaMb: 256 }, ftp: { enabled: false }, dav: { enabled: true } } });
    expect(edit).not.toHaveProperty('password');
    expect(toBody({ ...fromRow(rows[0]), password: STRONG }, rows[0]).password).toBe(STRONG);
  });

  it('derives badges and filters the list', () => {
    expect(serviceBadges(rows[0]).map((b) => [b.key, b.status])).toEqual([['email', 'ok'], ['ftp', 'warning'], ['dav', 'ok']]);
    expect(serviceBadges(rows[1])).toEqual([]);
    expect(filterUsers(rows, 'jane').map((r) => r.id)).toEqual([1]);
    expect(filterUsers(rows, 'example.org').map((r) => r.id)).toEqual([1]);
    expect(filterUsers(rows, '')).toHaveLength(2);
  });
});

describe('page', () => {
  it('lists users with their service badges and the add button', () => {
    set('/panel/users', { data: rows, meta });
    const html = render(h(UserManager, { fn }), '/panel/preferences/users');
    expect(html).toContain('jane@demo.example.com');
    expect(html).toContain('Jane Doe');
    expect(html).toContain('bob@demo.example.com');
    expect(html).toContain('Add user');
    expect(html).toContain('Calendars');
    expect(html).toContain('pill-warn');
    expect(html).not.toContain(STRONG);
  });

  it('renders the empty state, the plan-limit banner and the feature-disabled state', () => {
    set('/panel/users', { data: [], meta: { ...meta, total: 0 } });
    expect(render(h(UserManager, { fn }), '/panel/preferences/users')).toContain('No users yet');
    set('/panel/users', { data: rows, meta: { ...meta, max: 2 } });
    expect(render(h(UserManager, { fn }), '/panel/preferences/users')).toContain('all of them exist');
    set('/panel/users', { data: null, meta: null, error: { status: 403, code: 'feature_disabled', message: 'no' } });
    const html = render(h(UserManager, { fn }), '/panel/preferences/users');
    expect(html).not.toContain('Add user');
    expect(html).not.toContain('jane@demo.example.com');
  });
});
