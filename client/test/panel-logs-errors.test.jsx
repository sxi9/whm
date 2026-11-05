import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY, PANEL_PAGE_REGISTRY_KEYS } = await import('../src/panel/nav.js').then(async (nav) => ({ ...nav, PANEL_PAGE_REGISTRY_KEYS: Object.keys((await import('../src/panel/registry.js')).PANEL_PAGE_REGISTRY) }));
const { default: Errors, errorsPath } = await import('../src/pages/panel/logs/errors.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', plan: {}, features: { errlog: true }, limits: {}, domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:logs/errors'];
const render = (el, path) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });

const payload = {
  lines: 300, domain: null, domains: ['demo.example.com', 'shop.demo.example.com'], warnings: [], apache: true, nginx: false,
  files: [
    { name: 'shop.demo.example.com-error.log', kind: 'apache', domain: 'shop.demo.example.com', location: 'server', size: 2048, mtime: '2026-11-03T09:00:00Z', truncated: true, lines: ['[Tue Nov 03 09:00:00 2026] [php:error] newest', '[Tue Nov 03 08:59:00 2026] [php:error] older'] },
    { name: 'demo.example.com-error.log', kind: 'apache', domain: 'demo.example.com', location: 'server', size: 0, mtime: '2026-11-01T00:00:00Z', truncated: false, lines: [] },
  ],
};

describe('Errors page', () => {
  it('is a gated Logs function with a discovered page and en.json strings', () => {
    expect(fn).toMatchObject({ label: 'Errors', path: '/panel/logs/errors', feature: 'errlog', categorySlug: 'logs' });
    expect(PANEL_PAGE_REGISTRY_KEYS).toContain('panel:logs/errors');
    const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
    expect(en['panel.logs/errors.label']).toBe('Errors');
    expect(en['panel.logs/errors.description']).toBe(fn.description);
    expect(en['panel.logs.errors_last_lines']).toBe('Last {count} lines');
    expect(errorsPath('300', '')).toBe('/logs/errors?lines=300');
    expect(errorsPath('100', 'shop.demo.example.com')).toBe('/logs/errors?lines=100&domain=shop.demo.example.com');
  });

  it('renders one card per error log with the newest line first', () => {
    fixtures.responses.clear();
    set('/panel/logs/errors?lines=300', { data: payload });
    const html = render(h(Errors, { fn }), fn.path);
    expect(html).toContain('<h1>Errors</h1>');
    expect(html).toContain('id="errors-domain"');
    expect(html).toContain('shop.demo.example.com</option>');
    expect(html).toContain('id="errors-lines"');
    expect(html).toContain('Last 1000 lines');
    expect(html).toContain('Refresh every 10 seconds');
    expect(html).toContain('shop.demo.example.com-error.log');
    expect(html.indexOf('newest')).toBeLessThan(html.indexOf('older'));
    expect(html).toContain('<pre class="log">[Tue Nov 03 09:00:00 2026] [php:error] newest');
    expect(html).toContain('2 lines · older lines not shown');
    expect(html).toContain('shop.demo.example.com · Apache · Web server · 2.00 KB');
    expect(html).toContain('This log is empty');
    expect(html).toContain('Nothing has gone wrong on this domain');
    expect(html).not.toContain('No error logs yet');
  });

  it('shows the empty states, the capability state and the plan state', () => {
    fixtures.responses.clear();
    set('/panel/logs/errors?lines=300', { data: { ...payload, files: [] } });
    let html = render(h(Errors, { fn }), fn.path);
    expect(html).toContain('No error logs yet');
    expect(html).toContain('such as a missing page or a PHP error');
    set('/panel/logs/errors?lines=300', { data: { ...payload, files: [], apache: false, nginx: false, warnings: ['/var/log/whm/domlogs/demo was skipped: refused'] } });
    html = render(h(Errors, { fn }), fn.path);
    expect(html).toContain('No web server logs on this server');
    expect(html).toContain('Some log locations were skipped');
    set('/panel/logs/errors?lines=300', { error: { status: 501, code: 'capability_missing', message: 'Apache is not installed on this server' } });
    html = render(h(Errors, { fn }), fn.path);
    expect(html).toContain('Not available on this server');
    expect(html).toContain('id="errors-domain"');
    expect(html).not.toContain('No error logs yet');
    set('/panel/logs/errors?lines=300', { error: { status: 403, code: 'feature_disabled', message: 'off' } });
    html = render(h(Errors, { fn }), fn.path);
    expect(html).toContain('Not included in your plan');
    expect(html).toContain('Errors is not part of the hosting plan');
  });
});
