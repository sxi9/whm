import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: () => ({ data: null, meta: null, error: null, loading: false, refetch: () => {}, setData: () => {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { PANEL_FUNCTION_BY_KEY, PANEL_CATEGORY_BY_SLUG } = await import('../src/panel/nav.js');
const { registryKeysFrom } = await import('../src/panel/registry.js');
const { default: Preferences, validateContact, draftFrom, NOTIFICATIONS } = await import('../src/pages/panel/overview/preferences.jsx');
const { adoptUserLocale, preferredLocale } = await import('../src/i18n/useT.js');

React.useLayoutEffect = React.useEffect;

const fn = PANEL_FUNCTION_BY_KEY['panel:overview/preferences'];
const me = {
  user: { id: 7, username: 'demo', email: 'owner@demo.example.com', role: 'user', totpEnabled: false, locale: null },
  account: { username: 'demo', domain: 'demo.example.com', contactEmail: 'owner@demo.example.com', features: {}, limits: {}, domains: [] },
  preferences: { email: 'owner@demo.example.com', email2: 'backup@example.org', notify: { quota: true, bandwidth: false, passwordChange: true }, locale: null, locales: [{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' }], defaultLocale: 'en' },
  usage: {}, counts: {}, actingAs: null, policy: { require2fa: false, passwordSynced: true }, hostname: 'srv1.example', csrfToken: 't',
};
const render = (over = {}) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [fn.path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: { me: { ...me, ...over }, loading: false, error: null, reload: () => {}, hasFeature: () => true } }, h(ToastProvider, null, h(Preferences, { fn }))))));

describe('Preferences page', () => {
  it('is a function of the Overview group with a registry page and i18n keys', async () => {
    expect(fn).toMatchObject({ slug: 'preferences', path: '/panel/overview/preferences', categorySlug: 'overview' });
    expect(PANEL_CATEGORY_BY_SLUG.overview.functions.map((f) => f.slug)).toEqual(['dashboard', 'account', 'preferences']);
    expect(registryKeysFrom(['../pages/panel/overview/preferences.jsx'])).toContain(fn.key);
    const en = (await import('../src/i18n/en.json')).default;
    expect(en['panel.overview/preferences.label']).toBe('Preferences');
  });

  it('renders the contact form from /me preferences, the three notification switches and the language select', () => {
    const html = render();
    expect(html).toContain('<h1>Preferences</h1>');
    expect(html).toMatch(/id="pref-email"[^>]*value="owner@demo.example.com"/);
    expect(html).toMatch(/id="pref-email2"[^>]*value="backup@example.org"/);
    expect(html).toContain('Disk quota');
    expect(html).toContain('Bandwidth');
    expect(html).toContain('Password changes');
    expect((html.match(/type="checkbox" checked=""/g) || []).length).toBe(2);
    // The addresses are the recovery addresses: the form asks for the current password.
    expect(html).toMatch(/<input[^>]*type="password"[^>]*id="pref-current-password"|<input[^>]*id="pref-current-password"[^>]*type="password"/);
    expect(html).toContain('Server default (en)');
    expect(html).toContain('<option value="es">Español (es)</option>');
    expect(html).toContain('Save language');
    expect(NOTIFICATIONS.map(([k]) => k)).toEqual(['quota', 'bandwidth', 'passwordChange']);
  });

  it('shows the language read-only while an administrator is logged in as the account', () => {
    const html = render({ actingAs: { account: 'demo', by: 'root', expiresAt: new Date(Date.now() + 600000).toISOString() } });
    expect(html).not.toContain('id="pref-locale"');
    expect(html).toContain('not changed while logged in as the account');
    expect(html).toContain('id="pref-email"');
    // The administrator authenticated to the console already: no account password is asked.
    expect(html).not.toContain('id="pref-current-password"');
  });

  it('validateContact and draftFrom are pure', () => {
    expect(validateContact({ email: 'nope', email2: '' }).fields.email[0]).toMatch(/valid email/);
    expect(validateContact({ email: 'a@b.co', email2: 'x' }).fields.email2[0]).toMatch(/valid email/);
    expect(validateContact({ email: 'a@b.co', email2: 'A@B.CO' }).fields.email2[0]).toMatch(/differ/);
    expect(validateContact({ email: 'a@b.co', email2: '' })).toBeNull();
    expect(draftFrom(null)).toEqual({ email: '', email2: '', notify: { quota: true, bandwidth: true, passwordChange: true }, currentPassword: '' });
    expect(draftFrom(me.preferences).notify.bandwidth).toBe(false);
  });

  it('adoptUserLocale only acts on a stored code that differs from the browser preference', () => {
    expect(adoptUserLocale(null)).toBe(false);
    expect(adoptUserLocale('')).toBe(false);
    expect(adoptUserLocale(preferredLocale() || 'xx')).toBe(preferredLocale() == null);
  });
});
