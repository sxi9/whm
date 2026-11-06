import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

const fixtures = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const f = path ? fixtures[path] || null : null;
    return { data: f?.data ?? null, meta: f?.meta ?? null, error: f?.error ?? null, loading: Boolean(path) && !f, refetch: () => {}, setData: () => {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { registryKeysFrom } = await import('../src/panel/registry.js');
const { DEFAULT_FEATURES } = await import('../../server/src/db/seed.js');
const { default: Calendars, davState, SetPasswordForm, LoginsTable, ClientSetup, CollectionsCard } = await import('../src/pages/panel/email/calendars.jsx');
const { DavCard, davState: adminState } = await import('../src/pages/service-config/DavCard.jsx');
const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));

React.useLayoutEffect = React.useEffect;

const me = { user: { id: 7, username: 'demo', role: 'user' }, account: { username: 'demo', domain: 'demo.example.com', features: {}, limits: {} }, usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't' };
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:email/calendars'];
const render = (el, path = fn.path) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));

const urls = (login) => ({ principal: `https://srv1.example/dav/${encodeURIComponent(login)}/`, caldav: `https://srv1.example/dav/${encodeURIComponent(login)}/`, carddav: `https://srv1.example/dav/${encodeURIComponent(login)}/`, discovery: 'https://srv1.example/dav/' });
const ready = {
  available: { installed: true, active: true, published: true, url: 'https://srv1.example/dav/', error: null }, serverUrl: 'https://srv1.example/dav/', hostname: 'srv1.example', passwordMinLength: 8,
  logins: [
    { login: 'demo@demo.example.com', kind: 'account', subuserId: null, hasPassword: true, passwordSetAt: '2026-11-06T10:00:00Z', urls: urls('demo@demo.example.com') },
    { login: 'sam@demo.example.com', kind: 'subuser', subuserId: 3, hasPassword: false, passwordSetAt: null, urls: urls('sam@demo.example.com') },
  ],
};

describe('Calendars and contacts nav entry', () => {
  it('is a gated Email function with a discovered page, a seeded feature and en.json strings', () => {
    expect(fn).toMatchObject({ slug: 'calendars', categorySlug: 'email', feature: 'caldav', path: '/panel/email/calendars' });
    expect(registryKeysFrom(['../pages/panel/email/calendars.jsx'])).toEqual(['panel:email/calendars']);
    expect(DEFAULT_FEATURES.caldav).toBe(true);
    expect(en['panel.email/calendars.label']).toBe(fn.label);
    expect(en['panel.email/calendars.description']).toBe(fn.description);
    for (const k of ['panel.email.calendars.set_password', 'panel.email.calendars.client_ios', 'panel.email.calendars.remove_title', 'panel.email.calendars.no_collections']) expect(typeof en[k]).toBe('string');
  });
});

describe('davState', () => {
  const t = (k, f) => f;
  it('tells the customer what is missing', () => {
    expect(davState(null, t)).toBeNull();
    expect(davState({ available: { installed: false } }, t)).toMatchObject({ status: 'not-installed', label: 'Not available' });
    expect(davState({ available: { installed: true, published: false }, serverUrl: null }, t)).toMatchObject({ status: 'pending', label: 'Not published' });
    expect(davState({ available: { installed: true, published: true, active: false }, serverUrl: 'https://x/dav/' }, t)).toMatchObject({ status: 'failed', label: 'Stopped' });
    expect(davState(ready, t)).toEqual({ status: 'active', label: 'Ready', detail: null });
  });
});

describe('Calendars page', () => {
  it('renders the server card, the password form, the logins table and the client steps', () => {
    fixtures['/panel/email/calendars'] = { data: ready };
    const html = render(h(Calendars, { fn }));
    expect(html).toContain('Calendar server');
    expect(html).toContain('>Ready<');
    expect(html).toContain('href="https://srv1.example/dav/"');
    expect(html).toContain('Open web page');
    expect(html).toContain('Set a DAV password');
    expect(html).toContain('value="demo@demo.example.com"');
    expect(html).toContain('>sam@demo.example.com — no password yet</option>');
    expect(html).toContain('<code>demo@demo.example.com</code>');
    expect(html).toContain('>This account<');
    expect(html).toContain('>Sub-user<');
    expect(html).toContain('>Password set<');
    expect(html).toContain('>No password<');
    expect(html).toContain('Collections');
    expect(html).toContain('https://srv1.example/dav/demo%40demo.example.com/');
    expect(html).toContain('Thunderbird');
    expect(html).toContain('iPhone and iPad');
    expect(html).toContain('DAVx');
    expect(html).toContain('<code>srv1.example</code>');
    delete fixtures['/panel/email/calendars'];
  });

  it('explains an uninstalled server without offering a password form', () => {
    fixtures['/panel/email/calendars'] = { data: { ...ready, available: { installed: false, active: false, published: false, url: null }, serverUrl: null, logins: ready.logins.map((l) => ({ ...l, hasPassword: false })) } };
    const html = render(h(Calendars, { fn }));
    expect(html).toContain('>Not available<');
    expect(html).toContain('Ask your hosting provider to enable Calendars and Contacts');
    expect(html).not.toContain('Set a DAV password');
    expect(html).toContain('Not published yet');
    delete fixtures['/panel/email/calendars'];
  });

  it('feature off renders the plan state, 501 the capability state', () => {
    fixtures['/panel/email/calendars'] = { error: { status: 403, code: 'feature_disabled', message: 'Your hosting package does not include "caldav"' } };
    expect(render(h(Calendars, { fn }))).toContain('Not included in your plan');
    fixtures['/panel/email/calendars'] = { error: { status: 501, code: 'capability_missing', message: 'Radicale is not installed' } };
    expect(render(h(Calendars, { fn }))).toContain('Radicale is not installed');
    delete fixtures['/panel/email/calendars'];
  });

  it('the password form disables submit until a login and 8 characters are there', () => {
    const html = render(h(SetPasswordForm, { logins: ready.logins }));
    expect(html).toContain('Set DAV password');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('separate from the mailbox and panel passwords');
  });

  it('the logins table offers Remove only for a login with a password', () => {
    const html = render(h(LoginsTable, { logins: ready.logins }));
    expect((html.match(/ Remove<\/button>/g) || []).length).toBe(1);
    expect(html).toContain('2026');
  });

  it('collections card lists calendars and address books, and the empty states', () => {
    fixtures['/panel/email/calendars/demo%40demo.example.com/collections'] = { data: { login: 'demo@demo.example.com', exists: true, collections: [{ name: 'a1b2', kind: 'calendar', displayName: 'Work', items: 3, updatedAt: '2026-11-06T10:00:00Z' }, { name: 'c3d4', kind: 'addressbook', displayName: null, items: 0, updatedAt: null }] } };
    const html = render(h(CollectionsCard, { login: 'demo@demo.example.com', onClose: () => {} }));
    expect(html).toContain('Collections of demo@demo.example.com');
    expect(html).toContain('Work');
    expect(html).toContain('>Calendar<');
    expect(html).toContain('>Address book<');
    expect(html).toContain('<code>c3d4</code>');
    fixtures['/panel/email/calendars/demo%40demo.example.com/collections'] = { data: { login: 'demo@demo.example.com', exists: false, collections: [] } };
    expect(render(h(CollectionsCard, { login: 'demo@demo.example.com', onClose: () => {} }))).toContain('has not connected to the calendar server yet');
    delete fixtures['/panel/email/calendars/demo%40demo.example.com/collections'];
    expect(render(h(CollectionsCard, { login: null }))).not.toContain('Collections of');
  });

  it('client setup falls back to a placeholder login', () => {
    const html = render(h(ClientSetup, { serverUrl: 'https://srv1.example/dav/', login: null, hostname: 'srv1.example' }));
    expect(html).toContain('name@example.com');
    expect(html).toContain('https://srv1.example/dav/name%40example.com/');
  });
});

describe('Service Configuration › Calendars (Radicale) card', () => {
  const base = { installed: false, version: null, bcrypt: null, packages: ['radicale', 'python3-bcrypt'], pkgAvailable: true, listen: { host: '127.0.0.1', port: 5232 }, config: null, users: null, storage: null, unit: null, hostname: 'srv1.example', fqdn: true, apache: true, site: null, published: null, url: null, serverUrl: 'https://srv1.example/dav/', modules: null, http: null, warning: null, lastApply: null, recentJobs: [], error: null };
  const installed = { ...base, installed: true, version: '3.6.0', bcrypt: true, config: { path: '/etc/radicale/config', exists: true, managed: true, inSync: true }, users: { path: '/etc/whm/radicale/users', exists: true, count: 2 }, unit: { name: 'radicale', present: true, active: true, enabled: true } };
  const published = { ...installed, published: { alias: '/dav', file: '/etc/apache2/keel-host.d/dav.conf', managed: true, url: 'https://srv1.example/dav/' }, url: 'https://srv1.example/dav/', modules: { missing: [], loaded: {} }, http: { status: 200, ok: true }, lastApply: { at: '2026-11-06T10:00:00Z', ok: true, summary: {}, error: null } };

  it('states each stage', () => {
    expect(adminState(base)).toMatchObject({ status: 'not-installed', label: 'Not installed' });
    expect(adminState(base).detail).toContain('radicale, python3-bcrypt');
    expect(adminState({ ...installed, config: { ...installed.config, managed: false } })).toMatchObject({ status: 'pending', label: 'Not configured' });
    expect(adminState({ ...installed, unit: { ...installed.unit, active: false } })).toMatchObject({ status: 'failed', label: 'Stopped' });
    expect(adminState({ ...installed, apache: false })).toMatchObject({ label: 'Apache missing' });
    expect(adminState({ ...installed, fqdn: false })).toMatchObject({ label: 'No hostname' });
    expect(adminState(installed)).toMatchObject({ status: 'pending', label: 'Not published' });
    expect(adminState({ ...published, modules: { missing: ['headers'], loaded: {} } })).toMatchObject({ label: 'Apache modules missing' });
    expect(adminState({ ...published, http: { status: 502, ok: false }, warning: 'Published but answering 502' })).toMatchObject({ status: 'failed', label: 'Published but answering 502' });
    expect(adminState({ ...published, bcrypt: false })).toMatchObject({ label: 'Published, bcrypt missing' });
    expect(adminState(published)).toEqual({ status: 'ok', label: 'Published', detail: null });
  });

  it('offers Install first, then Publish, then Unpublish + Publish again', () => {
    fixtures['/service-config/dav'] = { data: base };
    let html = render(h(DavCard));
    expect(html).toContain('Calendars (Radicale)');
    expect(html).toContain('>Install<');
    expect(html).not.toContain('>Publish<');
    expect(html).not.toContain('>Unpublish<');
    fixtures['/service-config/dav'] = { data: installed };
    html = render(h(DavCard));
    expect(html).toContain('>Publish<');
    expect(html).toContain('>Reconfigure<');
    expect(html).toContain('radicale 3.6.0 on 127.0.0.1:5232');
    expect(html).toContain('2 in /etc/whm/radicale/users');
    fixtures['/service-config/dav'] = { data: published };
    html = render(h(DavCard));
    expect(html).toContain('>Unpublish<');
    expect(html).toContain('>Publish again<');
    expect(html).toContain('href="https://srv1.example/dav/"');
    expect(html).toContain('HTTP 200');
    expect(html).toContain('/etc/apache2/keel-host.d/dav.conf');
    delete fixtures['/service-config/dav'];
  });
});
