import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, hostname: 'srv1.example', refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (p) => ({ data: null, meta: null, error: null, loading: Boolean(p), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(p) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { PanelTopBar } = await import('../src/panel/PanelTopBar.jsx');
const { QuickLinks } = await import('../src/panel/PanelHome.jsx');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { RowActions } = await import('../src/components/DataTable.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { default: FileManager } = await import('../src/pages/panel/files/file-manager.jsx');

React.useLayoutEffect = React.useEffect;

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'theme', 'base.css'), 'utf8');
const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', package: 'starter', features: { filemanager: true }, limits: {}, domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const render = (el, entry = '/panel') => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [entry] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));

// The phone block is the last @media (max-width: 640px) section of base.css.
const phoneBlock = css.slice(css.lastIndexOf('@media (max-width: 640px)'));
const rule = (block, selector) => {
  const m = block.match(new RegExp(`(?:^|[\\n;}])\\s*${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
};

describe('phone layout rules (plan P1-11)', () => {
  it('adds a max-width 640px section after the desktop rules without renaming desktop classes', () => {
    expect(phoneBlock.startsWith('@media (max-width: 640px)')).toBe(true);
    // Desktop rules keep their values: the phone block only adds overrides.
    expect(css).toContain('.page-header-actions { display: flex; gap: 8px; flex: none; }');
    expect(css).toContain('.search .input { width: 280px; }');
    expect(css).toContain('.kv > div { display: flex; justify-content: space-between;');
    expect(css).toContain('.home-hero { display: flex; align-items: flex-end; justify-content: space-between;');
    expect(css).toContain('.table-wrap { overflow-x: auto; }');
  });

  it('stacks the page header and wraps its actions', () => {
    expect(rule(phoneBlock, '.page-header, .home-hero')).toContain('flex-direction: column');
    expect(rule(phoneBlock, '.page-header-actions')).toContain('flex-wrap: wrap');
  });

  it('makes the search input fluid and the key/value rows single column', () => {
    expect(rule(phoneBlock, '.search .input, .search.inline .input')).toMatch(/width: auto; flex: 1/);
    expect(rule(phoneBlock, '.kv > div')).toContain('flex-direction: column');
    expect(rule(phoneBlock, '.kv dd')).toContain('text-align: left');
  });

  it('keeps the top bar inside the viewport and scrolls tables sideways', () => {
    expect(rule(phoneBlock, '.user-menu .user-name')).toBe('display: none;');
    expect(rule(phoneBlock, '.topbar-search')).toContain('min-width: 0');
    expect(rule(phoneBlock, '.table-wrap')).toContain('overflow-x: auto');
    expect(rule(phoneBlock, '.home')).toContain('minmax(0, 1fr)');
  });

  it('hides the keyboard hint on coarse pointers and on phones', () => {
    expect(css).toContain('@media (pointer: coarse) { .kbd-hint { display: none; } }');
    expect(rule(phoneBlock, '.kbd-hint')).toBe('display: none;');
  });

  it('swaps the file-manager action rows for the compact menu only below 640px', () => {
    expect(css).toContain('.fm-actions-full { display: contents; }');
    expect(css).toContain('.fm-actions-compact { display: none; }');
    expect(rule(phoneBlock, '.fm-actions-full')).toBe('display: none;');
    expect(rule(phoneBlock, '.fm-actions-compact')).toBe('display: contents;');
    expect(css).toContain('.fm-path-go { width: 300px;');
    expect(rule(phoneBlock, '.fm-path-go')).toBe('width: 100%;');
  });
});

describe('top bar keyboard hint', () => {
  it('carries the kbd-hint class so a media query can hide it; the Alt / handler stays', () => {
    const html = render(h(PanelTopBar, { onMenu: () => {} }));
    expect(html).toContain('<kbd class="kbd-hint">Alt /</kbd>');
    expect(html).toContain('class="user-menu"');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel', 'PanelTopBar.jsx'), 'utf8');
    expect(src).toContain("e.altKey && e.key === '/'");
  });
});

describe('home quick links', () => {
  it('wrap through the shared .quick-links class instead of an inline style', () => {
    const html = renderToStaticMarkup(h(MemoryRouter, null, h(QuickLinks, { links: { apps: [{ id: 'a', name: 'App one', url: 'https://example.com/a' }], news: [] }, webmailUrl: 'https://host.example/webmail/' })));
    expect(html).toContain('<ul class="list-plain row-actions quick-links">');
    expect(html).not.toContain('flex-wrap:wrap');
    expect(html).toContain('Webmail');
    expect(html).toContain('App one');
  });
});

describe('file manager on a phone', () => {
  const fmFn = PANEL_FUNCTION_BY_KEY['panel:files/file-manager'];
  const entries = [
    { name: 'public_html', type: 'dir', size: 4096, mtime: '2026-11-01T10:00:00.000Z', mode: '0750', owner: 'demo' },
    { name: 'notes.txt', type: 'file', size: 120, mtime: '2026-11-03T09:15:00.000Z', mode: '0644', owner: 'demo' },
  ];

  it('renders the full header actions and a compact More menu from the shared kit', () => {
    fixtures.responses.clear();
    fixtures.responses.set('/panel/files/list?path=&limit=10000', { loading: false, data: { path: '.', entries, total: 2, truncated: false } });
    const html = render(h(FileManager, { fn: fmFn }), fmFn.path);
    const header = html.slice(html.indexOf('class="page-header-actions"'), html.indexOf('<section class="card'));
    expect(header).toContain('<span class="fm-actions-full">');
    expect(header).toContain('<span class="fm-actions-compact">');
    expect(header).toContain('New file');
    expect(header).toContain('New folder');
    expect(header).toContain('Upload');
    expect(header).toContain('aria-label="More actions"');
    expect(html).toContain('<form class="fm-path-form">');
    expect(html).toContain('class="input-group fm-path-go"');
    expect(html).not.toContain('width:300px');
  });

  it('RowActions is exported so pages can collapse action rows into the kit menu', () => {
    const html = renderToStaticMarkup(h(RowActions, { actions: [{ label: 'Upload', primary: true, onClick: () => {} }, { label: 'New file', onClick: () => {} }] }));
    expect(html).toContain('class="row-actions"');
    expect(html).toContain('Upload');
    expect(html).toContain('aria-label="More actions"');
  });
});
