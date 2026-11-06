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
const { default: WebDisk, webdiskState, SetPasswordForm, ClientSetup, jobStreamPath } = await import('../src/pages/panel/files/webdisk.jsx');
const { WebDisksCard } = await import('../src/pages/fn/service-configuration/cpanel-web-disk-configuration.jsx');
const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
const pageSource = readFileSync(new URL('../src/pages/panel/files/webdisk.jsx', import.meta.url), 'utf8');

React.useLayoutEffect = React.useEffect;

const me = { user: { id: 7, username: 'demo', role: 'user' }, account: { username: 'demo', domain: 'demo.example.com', features: {}, limits: {} }, usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't' };
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:files/webdisk'];
const render = (el, path = fn.path) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));

const base = { login: 'demo', port: 31000, serverUrl: 'https://srv1.example/webdisk/demo/', hostname: 'srv1.example', fqdn: true, available: { rclone: true, apache: true, published: true }, passwordMinLength: 8, packages: ['rclone'], pending: false, recentJobs: [], error: null };
const off = { ...base, enabled: false, hasPassword: false, passwordSetAt: null, status: 'disabled', unit: null, available: { rclone: false, apache: true, published: false } };
const on = { ...base, enabled: true, hasPassword: true, passwordSetAt: '2026-11-06T10:00:00Z', status: 'active', unit: { unit: 'keel-webdisk-demo', installed: true, active: true, state: 'active', pid: 4242, restarts: 0 } };
const clients = { serverUrl: base.serverUrl, hostname: 'srv1.example', login: 'demo', port: 443, clients: [{ id: 'windows', url: base.serverUrl, unc: '\\\\srv1.example@SSL\\webdisk\\demo' }, { id: 'macos', url: base.serverUrl }, { id: 'ios', url: base.serverUrl }, { id: 'android', url: base.serverUrl }, { id: 'linux', url: base.serverUrl, gvfs: 'davs://srv1.example/webdisk/demo/', davfs: base.serverUrl }] };

describe('Web Disk nav entry', () => {
  it('is a gated Files function with a discovered page, a seeded feature and en.json strings for every key the page uses', () => {
    expect(fn).toMatchObject({ slug: 'webdisk', categorySlug: 'files', feature: 'webdisk', path: '/panel/files/webdisk' });
    expect(registryKeysFrom(['../pages/panel/files/webdisk.jsx'])).toEqual(['panel:files/webdisk']);
    expect(DEFAULT_FEATURES.webdisk).toBe(true);
    expect(en['panel.files/webdisk.label']).toBe(fn.label);
    expect(en['panel.files/webdisk.description']).toBe(fn.description);
    const used = new Set([...pageSource.matchAll(/t\('(panel\.webdisk\.[a-z_]+)'/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(40);
    for (const k of used) expect(typeof en[k], k).toBe('string');
    expect(jobStreamPath(12)).toBe('/panel/webdisk/jobs/12/stream');
  });
});

describe('webdiskState', () => {
  const t = (k, f) => f;
  it('tells the customer what is missing or wrong', () => {
    expect(webdiskState(null, t)).toBeNull();
    expect(webdiskState({ ...off, available: { apache: false } }, t)).toMatchObject({ status: 'not-installed', label: 'Not available' });
    expect(webdiskState({ ...off, fqdn: false, serverUrl: null }, t)).toMatchObject({ status: 'pending', label: 'No address yet' });
    expect(webdiskState({ ...off, pending: true }, t)).toMatchObject({ status: 'pending', label: 'Starting' });
    expect(webdiskState(off, t)).toMatchObject({ status: 'stopped', label: 'Off', detail: 'Set a Web Disk password below, then switch Web Disk on.' });
    expect(webdiskState({ ...off, hasPassword: true }, t)).toEqual({ status: 'stopped', label: 'Off', detail: null });
    expect(webdiskState({ ...on, status: 'failed', error: 'exit-code', unit: { ...on.unit, active: false } }, t)).toMatchObject({ status: 'failed', label: 'Not running', detail: expect.stringContaining('exit-code') });
    expect(webdiskState(on, t)).toEqual({ status: 'active', label: 'On', detail: null });
  });
});

describe('Web Disk page', () => {
  it('renders the status card with a disabled switch, the password form and no client card while off without a password', () => {
    fixtures['/panel/webdisk'] = { data: off };
    fixtures['/panel/webdisk/clients'] = { data: clients };
    const html = render(h(WebDisk, { fn }));
    expect(html).toContain('Web Disk');
    expect(html).toContain('>Off<');
    expect(html).toContain('https://srv1.example/webdisk/demo/');
    expect(html).toContain('Set a Web Disk password below, then switch Web Disk on.');
    expect(html).toMatch(/<input type="checkbox"[^>]*disabled/);
    expect(html).toContain('Set Web Disk password');
    expect(html).toContain('id="webdisk-password"');
    expect(html).toContain('value="demo"');
    expect(html).toContain('Connect your devices');
    expect(html).toContain('\\\\srv1.example@SSL\\webdisk\\demo');
    expect(html).toContain('davs://srv1.example/webdisk/demo/');
    for (const id of ['windows', 'macos', 'ios', 'android', 'linux']) expect(html).toContain(`data-client="${id}"`);
  });
  it('shows the running service and an enabled switch when on', () => {
    fixtures['/panel/webdisk'] = { data: on };
    const html = render(h(WebDisk, { fn }));
    expect(html).toContain('>On<');
    expect(html).toContain('keel-webdisk-demo · PID 4242');
    expect(html).toContain('Set on ');
    expect(html).toMatch(/<input type="checkbox" checked=""(?! disabled)/);
    expect(html).toContain('the service restarts with the new password');
  });
  it('explains a host without Apache and renders the feature-disabled state', () => {
    fixtures['/panel/webdisk'] = { data: { ...off, available: { apache: false, rclone: false, published: false } } };
    const html = render(h(WebDisk, { fn }));
    expect(html).toContain('Not available');
    expect(html).toContain('which is not installed');
    expect(html).not.toContain('id="webdisk-password"');
    fixtures['/panel/webdisk'] = { error: { status: 403, code: 'feature_disabled', message: 'nope' } };
    expect(render(h(WebDisk, { fn }))).toContain('Not included in your plan');
    fixtures['/panel/webdisk'] = { error: { status: 501, code: 'capability_missing', message: 'Apache is not installed' } };
    expect(render(h(WebDisk, { fn }))).toContain('Apache is not installed');
  });
  it('the pieces render on their own', () => {
    expect(render(h(SetPasswordForm, { login: 'demo', enabled: false }))).toContain('Set Web Disk password');
    const setup = render(h(ClientSetup, { clients }));
    expect(setup).toContain('Map network drive');
    expect(setup).toContain('Connect to Server (⌘K)');
    expect(setup).toContain('davfs2');
    expect(renderToStaticMarkup(h(ClientSetup, { clients: null, t: (k, f) => f }))).toBe('');
  });
});

describe('admin Web Disk card', () => {
  it('lists the accounts with their state and address', () => {
    const html = renderToStaticMarkup(h(WebDisksCard, { hostname: 'srv1.example', apache: true, disks: [
      { username: 'bob', domain: 'bob.com', login: 'bob', enabled: true, port: 31000, status: 'active', error: null, hasPassword: true, url: 'https://srv1.example/webdisk/bob/', updatedAt: '2026-11-06T10:00:00Z' },
      { username: 'carol', domain: 'carol.org', login: 'carol', enabled: false, port: 31002, status: 'disabled', error: null, hasPassword: true, url: 'https://srv1.example/webdisk/carol/', updatedAt: null },
      { username: 'dave', domain: 'dave.net', login: 'dave', enabled: true, port: 31003, status: 'failed', error: 'exit-code', hasPassword: true, url: 'https://srv1.example/webdisk/dave/', updatedAt: null },
    ] }));
    expect(html).toContain('<code>bob</code>');
    expect(html).toContain('>On<');
    expect(html).toContain('>Off<');
    expect(html).toContain('>Not running<');
    expect(html).toContain('exit-code');
    expect(html).toContain('https://srv1.example/webdisk/carol/');
    expect(html).toContain('/webdisk/&lt;account&gt;/');
    expect(renderToStaticMarkup(h(WebDisksCard, { hostname: null, apache: false, disks: [] }))).toContain('Apache is not installed');
  });
});
