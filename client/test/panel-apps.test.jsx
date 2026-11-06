import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user', totpEnabled: false }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY, PANEL_CATEGORY_BY_SLUG } = await import('../src/panel/nav.js');
const { registryKeysFrom } = await import('../src/panel/registry.js');
const { DEFAULT_FEATURES } = await import('../../server/src/db/seed.js');
const { default: Apps, jobStreamPath, statusTone, parseEnv, envText, formProblems, runtimeOptions, APP_TYPES } = await import('../src/pages/panel/software/apps.jsx');

React.useLayoutEffect = React.useEffect;

const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
const me = {
  user: { id: 7, username: 'demo', role: 'user', totpEnabled: false, mustChangePassword: false },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', shell: '/bin/bash', package: 'starter', plan: {}, features: {}, limits: {}, domains: [{ domain: 'demo.example.com', type: 'main' }, { domain: 'shop.demo.example.com', type: 'sub' }], forcePasswordChange: false },
  usage: {}, counts: {}, actingAs: null, policy: { require2fa: false, passwordSynced: true }, hostname: 'srv1.example', csrfToken: 't',
};
const ctxFor = (over = {}) => ({ me: { ...me, ...over }, loading: false, error: null, reload: () => {}, hasFeature: () => true });
const fn = PANEL_FUNCTION_BY_KEY['panel:software/apps'];
const render = (el, ctx = ctxFor()) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [fn.path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });
const runtimes = { node: [{ id: '20', label: 'Node.js v20.20.2 (Keel build)', keel: true }, { id: 'system', label: 'Node.js v22.14.0 (system)', keel: false }], python: [{ id: '3.12', label: 'Python 3.12.3', keel: false }, { id: 'system', label: 'Python 3 (system default)', keel: false }], portRange: { min: 31000, max: 31999 } };
const app = { id: 1, name: 'probe-app', type: 'node', dir: 'apps/probe-app', entry: 'server.js', runtime: '20', port: 31000, domain: 'demo.example.com', mount: '/probe-app', websocket: true, env: { GREETING: 'hello' }, status: 'running', error: null, unit: 'keel-app-demo.probe-app', url: 'https://demo.example.com/probe-app/', service: { state: 'active', pid: 4242, memoryBytes: 12_345_678, restarts: 0 } };

describe('Application manager page', () => {
  it('is in the nav under Software with its feature flag, page file, seed default and i18n keys', () => {
    expect(fn).toMatchObject({ slug: 'apps', categorySlug: 'software', feature: 'applicationmanager', path: '/panel/software/apps', phase: 3 });
    expect(PANEL_CATEGORY_BY_SLUG.software.functions.map((f) => f.slug)).toEqual(['wordpress', 'installers', 'plugins', 'apps']);
    expect(registryKeysFrom(['../pages/panel/software/apps.jsx'])).toEqual(['panel:software/apps']);
    expect(en['panel.software/apps.label']).toBe('Application manager');
    expect(en['panel.software/apps.description']).toBe(fn.description);
    expect(DEFAULT_FEATURES.applicationmanager).toBe(true);
    expect(jobStreamPath(12)).toBe('/panel/apps/jobs/12/stream');
    expect(APP_TYPES).toEqual(['node', 'python']);
    for (const k of ['panel.apps.create_title', 'panel.apps.status_running', 'panel.apps.start_done', 'panel.apps.remove_message', 'panel.apps.env_reserved']) expect(en[k], k).toBeTruthy();
  });

  it('helpers map statuses, parse variables and check the form', () => {
    expect(statusTone('running')).toBe('ok');
    expect(statusTone('failed')).toBe('error');
    expect(statusTone('stopped')).toBe('unknown');
    expect(statusTone('pending')).toBe('warn');
    expect(parseEnv('A=1\n# note\n\nB_2=x=y')).toEqual({ env: { A: '1', B_2: 'x=y' } });
    expect(parseEnv('lower=1').error).toMatch(/not KEY=value/);
    expect(parseEnv('PORT=80').error).toMatch(/set by the panel/);
    expect(parseEnv(`X=${'x'.repeat(1025)}`).error).toMatch(/1024/);
    expect(parseEnv(Array.from({ length: 65 }, (_, i) => `K${i}=v`).join('\n')).error).toMatch(/64/);
    expect(envText({ A: '1', B: 'two' })).toBe('A=1\nB=two');
    const good = { name: 'probe-app', dir: 'apps/probe-app', entry: 'server.js', mount: '/probe-app', envText: 'A=1' };
    expect(formProblems(good)).toEqual({});
    expect(Object.keys(formProblems({ ...good, name: 'X' }))).toEqual(['name']);
    expect(Object.keys(formProblems({ ...good, dir: '../x' }))).toEqual(['dir']);
    expect(Object.keys(formProblems({ ...good, entry: 'a b' }))).toEqual(['entry']);
    expect(Object.keys(formProblems({ ...good, mount: '/a b' }))).toEqual(['mount']);
    expect(Object.keys(formProblems({ ...good, mount: '/../x' }))).toEqual(['mount']);
    expect(Object.keys(formProblems({ ...good, envText: 'bad' }))).toEqual(['env']);
    expect(formProblems({ ...good, mount: '' })).toEqual({});
    expect(runtimeOptions(runtimes, 'node').map((o) => o.value)).toEqual(['20', 'system']);
    expect(runtimeOptions(runtimes, 'python').map((o) => o.value)).toEqual(['3.12', 'system']);
    expect(runtimeOptions(null, 'node')).toEqual([{ value: 'system', label: 'System default' }]);
  });

  it('renders the create form, the runtime picker and the app table with status pills', () => {
    fixtures.responses.clear();
    set('/panel/apps', { data: [app, { ...app, id: 2, name: 'py-app', type: 'python', runtime: '3.12', entry: 'app.py', dir: 'apps/py', port: 31002, mount: '/', url: 'https://demo.example.com/', status: 'failed', error: 'unit failed (exit-code)', service: { state: 'failed', pid: null } }], meta: { total: 2, sites: [{ domain: 'demo.example.com', type: 'main' }, { domain: 'shop.demo.example.com', type: 'sub' }], portRange: { min: 31000, max: 31999 }, apache: true, limit: null } });
    set('/panel/apps/runtimes', { data: runtimes });
    const html = render(h(Apps, { fn }));
    expect(html).toContain('<h1>Application manager</h1>');
    expect(html).toContain('Add an application');
    for (const id of ['app-name', 'app-type', 'app-dir', 'app-entry', 'app-runtime', 'app-domain', 'app-mount', 'app-env']) expect(html, id).toContain(`id="${id}"`);
    expect(html).toContain('Node.js v20.20.2 (Keel build)');
    expect(html).toContain('shop.demo.example.com');
    expect(html).toContain('Ports are assigned from 31000–31999');
    expect(html).toContain('probe-app');
    expect(html).toContain('apps/probe-app/server.js');
    expect(html).toContain('href="https://demo.example.com/probe-app/"');
    expect(html).toContain('port 31000');
    expect(html).toContain('Running');
    expect(html).toContain('PID 4242, 11.8 MB');
    expect(html).toContain('Failed');
    expect(html).toContain('unit failed (exit-code)');
    expect(html).toContain('2 application(s)');
    expect(html).not.toContain('Loading…');
  });

  it('shows the empty state and the Apache note', () => {
    fixtures.responses.clear();
    set('/panel/apps', { data: [], meta: { total: 0, sites: [], portRange: { min: 31000, max: 31999 }, apache: false, limit: null } });
    set('/panel/apps/runtimes', { data: { node: [], python: [], portRange: { min: 31000, max: 31999 } } });
    const html = render(h(Apps, { fn }));
    expect(html).toContain('No application yet');
    expect(html).toContain('Applications cannot be published on this server yet');
    expect(html).toContain('System default');
  });

  it('renders the feature-disabled and the capability states', () => {
    fixtures.responses.clear();
    set('/panel/apps', { error: { status: 403, code: 'feature_disabled', message: 'off' } });
    expect(render(h(Apps, { fn }))).toContain('Not included in your plan');
    fixtures.responses.clear();
    set('/panel/apps', { error: { status: 501, code: 'capability_missing', message: 'Apache is not installed on this server' } });
    const html = render(h(Apps, { fn }));
    expect(html).toContain('Apache is not installed');
    expect(html).toContain('Your applications appear here once the server is ready.');
  });

  it('leaves no English outside the catalogue (pseudo-locale)', async () => {
    vi.doMock('../src/i18n/useT.js', () => {
      const t = (key) => key;
      return { useT: () => ({ t, locale: 'xx', loaded: true, enabled: ['xx'], defaultLocale: 'en', reload: () => {} }), translate: t, preferredLocale: () => 'xx', setPreferredLocale: async () => ({}), adoptUserLocale: () => false, loadActiveLocale: async () => ({}) };
    });
    vi.resetModules();
    const { default: Page } = await import('../src/pages/panel/software/apps.jsx');
    const { PanelContext: PC } = await import('../src/panel/hooks/usePanel.js');
    const { ShellContext: SC, PANEL_SHELL: PS } = await import('../src/panel/ShellContext.js');
    const { ToastProvider: TP } = await import('../src/components/Toast.jsx');
    const { ConfirmProvider: CP } = await import('../src/components/Modal.jsx');
    fixtures.responses.clear();
    set('/panel/apps', { data: [app], meta: { total: 1, sites: [{ domain: 'demo.example.com', type: 'main' }], portRange: { min: 31000, max: 31999 }, apache: true } });
    set('/panel/apps/runtimes', { data: runtimes });
    const html = renderToStaticMarkup(h(MemoryRouter, { initialEntries: [fn.path] }, h(SC.Provider, { value: PS }, h(PC.Provider, { value: ctxFor() }, h(TP, null, h(CP, null, h(Page, { fn })))))));
    const text = html.replace(/<[^>]+>/g, ' ');
    for (const word of ['Add an application', 'Folder', 'Start file', 'Your applications', 'Running', 'Remove', 'Refresh']) expect(text, word).not.toContain(word);
    expect(text).toContain('panel.apps.create_title');
    expect(text.toLowerCase()).toContain('panel.apps.status_running');
    vi.doUnmock('../src/i18n/useT.js');
    vi.resetModules();
  });
});
