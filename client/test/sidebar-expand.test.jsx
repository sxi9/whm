// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { CATEGORIES } from '../src/nav.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
// useT's locale load and the shell's background calls never resolve here.
globalThis.fetch = () => new Promise(() => {});

let currentUser = { id: 1, username: 'root', role: 'root', ready: true };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: currentUser, ready: true, hostname: 'srv1.example', refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: () => ({ data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));
vi.mock('../src/hooks/usePluginNav.js', () => ({
  PluginNavProvider: ({ children }) => children,
  useMergedCategories: () => CATEGORIES,
  useSearch: () => () => [],
}));
vi.mock('../src/pages/cpanel/branding.js', () => ({
  useBranding: () => ({ companyName: 'Keel', tagline: 'Hosting control panel', helpUrl: '', docsUrl: '', supportUrl: '', footerText: '' }),
  useBrandingLoader: () => {},
  logoSrc: () => null,
}));
vi.mock('../src/api/client.js', () => ({ api: { get: () => new Promise(() => {}), post: () => new Promise(() => {}) }, ApiError: class extends Error {}, queryString: () => '' }));

const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { Layout } = await import('../src/components/Layout.jsx');
const { PanelShell } = await import('../src/panel/PanelLayout.jsx');
const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', features: {}, limits: {}, domains: [], suspended: 0 },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const panelCtx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };

let container; let root;
beforeEach(() => { localStorage.clear(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const render = (el, path = '/') => act(() => root.render(h(ToastProvider, null, h(ConfirmProvider, null, h(MemoryRouter, { initialEntries: [path] }, el)))));
const click = (el) => act(() => el.click());

const shells = [
  ['administration shell', 'whm.sidebar.collapsed', () => { currentUser = { id: 1, username: 'root', role: 'root' }; return h(Layout); }, '/', 'app-sidebar'],
  ['account panel', 'whm.panel.sidebar.collapsed', () => { currentUser = { id: 7, username: 'demo', role: 'user' }; return h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: panelCtx }, h(PanelShell, { me }, h('div', { className: 'probe' })))); }, '/panel', 'panel-sidebar'],
];

describe.each(shells)('%s sidebar collapse', (_name, key, make, path, sidebarId) => {
  it('renders the expand controls outside the aside when collapsed and brings the sidebar back', () => {
    localStorage.setItem(key, '1');
    render(make(), path);
    const aside = container.querySelector('aside.sidebar');
    expect(aside.id).toBe(sidebarId);
    expect(aside.classList.contains('collapsed')).toBe(true);
    // No focusable control is left inside the hidden aside: the collapse button is gone.
    expect(aside.querySelector('.sidebar-collapse')).toBeNull();
    const floating = container.querySelector('.sidebar-expand');
    const inTopBar = container.querySelector('.topbar .topbar-sidebar');
    for (const button of [floating, inTopBar]) {
      expect(button).not.toBeNull();
      expect(aside.contains(button)).toBe(false);
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-controls')).toBe(sidebarId);
      expect(button.getAttribute('aria-label')).toBe('Show sidebar');
    }
    click(inTopBar);
    expect(aside.classList.contains('collapsed')).toBe(false);
    expect(localStorage.getItem(key)).toBe('0');
    expect(container.querySelector('.sidebar-expand')).toBeNull();
    expect(container.querySelector('.topbar .topbar-sidebar')).toBeNull();
    const collapse = aside.querySelector('.sidebar-collapse');
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    expect(collapse.getAttribute('aria-controls')).toBe(sidebarId);
  });

  it('collapses from the button inside the aside and persists the flag', () => {
    render(make(), path);
    const aside = container.querySelector('aside.sidebar');
    expect(aside.classList.contains('collapsed')).toBe(false);
    expect(container.querySelector('.sidebar-expand')).toBeNull();
    // The content keeps its own width while the aside animates.
    expect(aside.querySelector(':scope > .sidebar-inner')).not.toBeNull();
    click(aside.querySelector('.sidebar-collapse'));
    expect(aside.classList.contains('collapsed')).toBe(true);
    expect(localStorage.getItem(key)).toBe('1');
    const floating = container.querySelector('.sidebar-expand');
    expect(floating).not.toBeNull();
    expect(aside.contains(floating)).toBe(false);
    click(floating);
    expect(aside.classList.contains('collapsed')).toBe(false);
    expect(localStorage.getItem(key)).toBe('0');
  });

  it('moves keyboard focus to the counterpart control on every collapse and expand', () => {
    render(make(), path);
    const aside = container.querySelector('aside.sidebar');
    // A stored flag on first render does not steal focus.
    expect(document.activeElement).toBe(document.body);
    click(aside.querySelector('.sidebar-collapse'));
    expect(document.activeElement).toBe(container.querySelector('.sidebar-expand'));
    click(container.querySelector('.sidebar-expand'));
    expect(document.activeElement).toBe(aside.querySelector('.sidebar-collapse'));
    click(aside.querySelector('.sidebar-collapse'));
    click(container.querySelector('.topbar .topbar-sidebar'));
    expect(document.activeElement).toBe(aside.querySelector('.sidebar-collapse'));
  });

  it('stops clipping a category list only once its open transition has settled', () => {
    vi.useFakeTimers();
    try {
      render(make(), path);
      const head = container.querySelector('.nav-category-head');
      const wrapper = container.querySelector(`#${head.getAttribute('aria-controls')}`);
      expect(wrapper.dataset.settled).toBe('false');
      click(head);
      expect(wrapper.dataset.open).toBe('true');
      expect(wrapper.dataset.settled).toBe('false');
      act(() => { vi.advanceTimersByTime(300); });
      expect(wrapper.dataset.settled).toBe('true');
      click(head);
      expect(wrapper.dataset.settled).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('animates a category list through the collapse wrapper and keeps closed lists out of the tab order', () => {
    render(make(), path);
    const head = container.querySelector('.nav-category-head');
    const listId = head.getAttribute('aria-controls');
    const wrapper = container.querySelector(`#${listId}`);
    expect(wrapper.classList.contains('collapse')).toBe(true);
    expect(wrapper.dataset.open).toBe('false');
    expect(wrapper.querySelector('.collapse-inner').getAttribute('inert')).toBe('');
    expect(wrapper.querySelector('ul')).toBeNull();
    click(head);
    expect(wrapper.dataset.open).toBe('true');
    expect(wrapper.querySelector('.collapse-inner').hasAttribute('inert')).toBe(false);
    expect(wrapper.querySelector('ul li a')).not.toBeNull();
    click(head);
    // Still mounted while the close transition runs; inert at once.
    expect(wrapper.dataset.open).toBe('false');
    expect(wrapper.querySelector('.collapse-inner').getAttribute('inert')).toBe('');
    expect(wrapper.querySelector('ul')).not.toBeNull();
  });
});
