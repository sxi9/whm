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
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { registryKeysFrom } = await import('../src/panel/registry.js');
const { default: VirusScanner, scopeLabel, databaseAgeText, scanOutcome, jobStreamPath, SCOPES } = await import('../src/pages/panel/security/virus-scanner.jsx');

React.useLayoutEffect = React.useEffect;

const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
const me = {
  user: { id: 7, username: 'demo', role: 'user', totpEnabled: false, mustChangePassword: false },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', shell: '/bin/bash', package: 'starter', plan: {}, features: {}, limits: {}, domains: [], forcePasswordChange: false },
  usage: {}, counts: {}, actingAs: null, policy: { require2fa: false, passwordSynced: true }, hostname: 'srv1.example', csrfToken: 't',
};
const ctxFor = (over = {}) => ({ me: { ...me, ...over }, loading: false, error: null, reload: () => {}, hasFeature: () => true });
const fn = PANEL_FUNCTION_BY_KEY['panel:security/virus-scanner'];
const render = (el, ctx = ctxFor()) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [fn.path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });
const scanner = { installed: true, version: '1.4.3', signatures: 27600, databaseAgeSec: 2 * 86400 };

describe('Virus scanner page', () => {
  it('is in the nav under Security with its feature flag, page file and i18n keys', () => {
    expect(fn).toMatchObject({ slug: 'virus-scanner', categorySlug: 'security', feature: 'virusscan', path: '/panel/security/virus-scanner' });
    expect(registryKeysFrom(['../pages/panel/security/virus-scanner.jsx'])).toEqual(['panel:security/virus-scanner']);
    expect(en['panel.security/virus-scanner.label']).toBe('Virus scanner');
    expect(en['panel.security/virus-scanner.description']).toBe(fn.description);
    expect(jobStreamPath(12)).toBe('/panel/virus-scanner/scans/12/stream');
    expect(SCOPES).toEqual(['home', 'mail', 'public_html']);
  });

  it('helpers describe scopes, database age and outcomes', () => {
    expect(scopeLabel('public_html')).toBe('Websites (public_html/)');
    expect(scopeLabel('mail')).toBe('Mail (mail/)');
    expect(scopeLabel('home')).toBe('Entire home directory');
    expect(databaseAgeText(null)).toMatch(/unknown/);
    expect(databaseAgeText(600)).toMatch(/within the hour/);
    expect(databaseAgeText(5 * 3600)).toBe('signatures updated 5 h ago');
    expect(databaseAgeText(3 * 86400)).toBe('signatures updated 3 days ago');
    expect(scanOutcome(null)).toEqual({ tone: 'unknown', text: 'never scanned' });
    expect(scanOutcome({ status: 'failed' })).toEqual({ tone: 'error', text: 'failed' });
    expect(scanOutcome({ status: 'done', result: { infected: [] } })).toEqual({ tone: 'ok', text: 'clean' });
    expect(scanOutcome({ status: 'done', result: { infected: [{}, {}] } })).toEqual({ tone: 'error', text: '2 infected' });
  });

  it('renders the scope choice, the engine line and the history with results', () => {
    fixtures.responses.clear();
    set('/panel/virus-scanner', { data: {
      scanner, scopes: [], active: null,
      history: [
        { id: 3, status: 'done', params: { scope: 'public_html' }, finishedAt: '2026-11-06T10:00:00Z', result: { infected: [{ file: 'public_html/eicar.txt', signature: 'Win.Test.EICAR_HDB-1' }], errors: [], durationMs: 4200 } },
        { id: 2, status: 'done', params: { scope: 'mail' }, finishedAt: '2026-11-05T10:00:00Z', result: { infected: [], errors: [], durationMs: 900 } },
        { id: 1, status: 'failed', params: { scope: 'home' }, error: 'timeout', finishedAt: '2026-11-04T10:00:00Z', result: null },
      ],
    } });
    const html = render(h(VirusScanner, { fn }));
    expect(html).toContain('<h1>Virus scanner</h1>');
    expect(html).toContain('id="virus-scope"');
    expect(html).toContain('Websites (public_html/)');
    expect(html).toContain('ClamAV 1.4.3');
    expect(html).toContain('signatures updated 2 days ago');
    expect(html).toContain('Scan now');
    expect(html).toContain('1 infected');
    expect(html).toContain('Clean');
    expect(html).toContain('Failed');
    expect(html).toContain('4 s');
    expect(html).not.toContain('not installed on this server');
  });

  it('says so when the engine is missing and disables the scan button', () => {
    fixtures.responses.clear();
    set('/panel/virus-scanner', { data: { scanner: { installed: false, version: null, signatures: null, databaseAgeSec: null }, scopes: [], active: null, history: [] } });
    const html = render(h(VirusScanner, { fn }));
    expect(html).toContain('The virus scanner is not installed on this server.');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain('No scan has run yet.');
  });

  it('renders the capability state on a 501 and the feature state on feature_disabled', () => {
    fixtures.responses.clear();
    set('/panel/virus-scanner', { error: { status: 501, code: 'capability_missing', message: 'The virus scanner (ClamAV) is not installed on this server' } });
    let html = render(h(VirusScanner, { fn }));
    expect(html).toContain('Not available on this server');
    set('/panel/virus-scanner', { error: { status: 403, code: 'feature_disabled', message: 'nope' } });
    html = render(h(VirusScanner, { fn }));
    expect(html).toContain('Not included in your plan');
  });

  it('offers to follow a running scan instead of starting another', () => {
    fixtures.responses.clear();
    set('/panel/virus-scanner', { data: { scanner, scopes: [], active: { id: 9, status: 'running', params: { scope: 'home', rel: '.' } }, history: [] } });
    const html = render(h(VirusScanner, { fn }));
    expect(html).toContain('A scan is already running.');
    expect(html).toContain('Follow it');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});
