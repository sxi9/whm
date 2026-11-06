import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user', totpEnabled: false }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY, PANEL_CATEGORY_BY_SLUG, visibleCategories } = await import('../src/panel/nav.js');
const { registryKeysFrom } = await import('../src/panel/registry.js');
const { DEFAULT_FEATURES } = await import('../../server/src/db/seed.js');
const { default: TerminalPage, wsUrl, shellDisabledError, closeReason, statusTone, CLOSE_CODES, WS_PATH } = await import('../src/pages/panel/advanced/terminal.jsx');

React.useLayoutEffect = React.useEffect;

const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
const me = {
  user: { id: 7, username: 'demo', role: 'user', totpEnabled: false, mustChangePassword: false },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', shell: '/bin/bash', package: 'starter', plan: { has_shell: true }, features: {}, limits: {}, domains: [{ domain: 'demo.example.com', type: 'main' }], forcePasswordChange: false },
  usage: {}, counts: {}, actingAs: null, policy: { require2fa: false, passwordSynced: true }, hostname: 'srv1.example', csrfToken: 't',
};
const ctxFor = (over = {}) => ({ me: { ...me, ...over }, loading: false, error: null, reload: () => {}, hasFeature: () => true });
const fn = PANEL_FUNCTION_BY_KEY['panel:advanced/terminal'];
const render = (el, ctx = ctxFor()) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [fn.path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));

describe('Terminal page', () => {
  it('is in the nav under Advanced with its feature flag, page file, seed default and i18n keys', () => {
    expect(fn).toMatchObject({ slug: 'terminal', categorySlug: 'advanced', feature: 'terminal', path: '/panel/advanced/terminal', phase: 4 });
    expect(PANEL_CATEGORY_BY_SLUG.advanced.functions.map((f) => f.slug)).toEqual(['error-pages', 'optimize-website', 'hotlink-protection', 'terminal']);
    expect(registryKeysFrom(['../pages/panel/advanced/terminal.jsx'])).toEqual(['panel:advanced/terminal']);
    expect(en['panel.advanced/terminal.label']).toBe('Terminal');
    expect(en['panel.advanced/terminal.description']).toBe(fn.description);
    expect(DEFAULT_FEATURES.terminal).toBe(true);
    expect(visibleCategories({ terminal: false }).find((c) => c.slug === 'advanced').functions.map((f) => f.slug)).not.toContain('terminal');
    for (const k of ['panel.terminal.no_shell', 'panel.terminal.reconnect', 'panel.terminal.disconnect', 'panel.terminal.paste_hint', 'panel.terminal.closed_logout', 'panel.terminal.limits', 'panel.terminal.status_connected']) expect(en[k], k).toBeTruthy();
    expect(WS_PATH).toBe('/api/panel/terminal/ws');
  });

  it('helpers build the socket URL, detect a plan without shell and word close codes', () => {
    expect(wsUrl({ protocol: 'https:', host: 'panel.example:2083' }, 'a b')).toBe('wss://panel.example:2083/api/panel/terminal/ws?token=a%20b');
    expect(wsUrl({ protocol: 'http:', host: 'localhost:2082' }, 'tok')).toBe('ws://localhost:2082/api/panel/terminal/ws?token=tok');
    expect(shellDisabledError(me)).toBeNull();
    expect(shellDisabledError(null)).toBeNull();
    const err = shellDisabledError({ account: { plan: { has_shell: false } } });
    expect(err).toMatchObject({ status: 501, code: 'shell_disabled' });
    expect(err.message).toMatch(/not included in your plan/);
    expect(closeReason(CLOSE_CODES.loggedOut)).toMatch(/session ended/);
    expect(closeReason(CLOSE_CODES.busy)).toMatch(/another tab/);
    expect(closeReason(CLOSE_CODES.ended)).toMatch(/shell has ended/);
    expect(closeReason(1000)).toMatch(/shell has ended/);
    expect(closeReason(CLOSE_CODES.forbidden)).toMatch(/refused/);
    expect(closeReason(1006)).toBe('The connection was lost (code 1006).');
    expect(statusTone('connected')).toBe('ok');
    expect(statusTone('connecting')).toBe('warn');
    expect(statusTone('error')).toBe('error');
    expect(statusTone('closed')).toBe('unknown');
  });

  it('renders the shell card with the reconnect button and the copy/paste hint when the plan grants shell', () => {
    const html = render(h(TerminalPage, { fn }));
    expect(html).toContain('Terminal');
    expect(html).toContain('Reconnect');
    expect(html).toContain('Disconnect');
    expect(html).toContain('Ctrl+Shift+C');
    expect(html).toContain('terminal-host');
    expect(html).toContain('No shell is open.');
    expect(html).toContain('15 minutes');
    expect(html).not.toContain('Not included in your plan');
  });

  it('shows the "not included in your plan" state, and no shell card, when the plan has no shell', () => {
    const html = render(h(TerminalPage, { fn }), ctxFor({ account: { ...me.account, plan: { has_shell: false } } }));
    expect(html).toContain('Not included in your plan');
    expect(html).toContain('Shell access is not included in your plan');
    expect(html).not.toContain('terminal-host');
    expect(html).not.toContain('Reconnect');
  });
});
