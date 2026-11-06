import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import fs from 'node:fs';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { PanelHome } = await import('../src/panel/PanelHome.jsx');
const { PanelSidebar } = await import('../src/panel/PanelSidebar.jsx');
const { visibleCategories } = await import('../src/panel/nav.js');
const { writeSections } = await import('../src/hooks/useCollapsedSections.js');

React.useLayoutEffect = React.useEffect;

const KEY = 'keel.panel.home.sections';
const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', package: 'starter', homeDir: '/home/demo', features: { cron: false }, limits: {}, domains: [], suspended: 0 },
  usage: { diskUsedMb: 1, diskQuotaMb: 10 }, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: (k) => me.account.features[k] !== false };
const render = (el, path = '/panel') => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, el))));
const groups = visibleCategories(me.account.features);
const first = groups[0];

beforeEach(() => store.clear());

describe('PanelHome sections', () => {
  it('render open by default with translated Collapse all / Expand all actions', () => {
    const html = render(h(PanelHome));
    expect(html).not.toContain('aria-expanded="false"');
    expect(html).toContain('Collapse all');
    expect(html).toContain('Expand all');
    expect(html).toContain(`aria-controls="panel-tools-${first.slug}"`);
    expect(html).toContain(`href="${first.functions[0].path}"`);
  });

  it('a collapsed group hides its tiles under aria-expanded="false" and the rest stay open', () => {
    writeSections(KEY, { [first.slug]: false });
    const html = render(h(PanelHome));
    expect((html.match(/aria-expanded="false"/g) || []).length).toBe(1);
    expect(html).toContain(`id="panel-tools-${first.slug}" class="tool-grid" hidden=""`);
    expect(html).not.toContain(`href="${first.functions[0].path}"`);
    expect(html).toContain(`href="${groups[1].functions[0].path}"`);
    expect(html).toContain(`data-group="${first.slug}"`);
  });

  it('every panel.home key the sections use exists in en.json', () => {
    const en = JSON.parse(fs.readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
    for (const k of ['panel.home.collapse_all', 'panel.home.expand_all', 'panel.home.collapse_section', 'panel.home.expand_section']) expect(en[k], k).toBeTruthy();
  });
});

describe('PanelSidebar', () => {
  it('offers Expand all / Collapse all and opens a group from the stored flag only', () => {
    let html = render(h(PanelSidebar, { collapsed: false, onToggle: () => {} }));
    expect(html).toContain('Expand all');
    expect(html).toContain('Collapse all');
    expect(html).not.toContain('nav-category open');
    writeSections('whm.panel.sidebar.open', { [first.slug]: true });
    html = render(h(PanelSidebar, { collapsed: false, onToggle: () => {} }));
    expect(html).toContain('nav-category open');
    expect(html).toContain(`href="${first.functions[0].path}"`);
  });
});
