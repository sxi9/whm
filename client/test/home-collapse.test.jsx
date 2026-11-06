import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CATEGORIES } from '../src/nav.js';

// The node test environment has no localStorage: a map-backed stand-in lets the
// hook read a persisted state and lets the tests inspect what it would write.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: () => ({ data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { HomePage } = await import('../src/pages/Home.jsx');
const { Sidebar } = await import('../src/components/Sidebar.jsx');
const { readSections, writeSections, isSectionOpen, collapsedAll, expandedAll } = await import('../src/hooks/useCollapsedSections.js');

React.useLayoutEffect = React.useEffect;

const KEY = 'whm.home.sections';
const slugs = CATEGORIES.map((c) => c.slug);
const first = slugs[0];
const render = (el, path = '/') => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter initialEntries={[path]}>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

beforeEach(() => store.clear());

describe('Home tool sections', () => {
  it('render every category open by default with an expanded, keyboard-operable header', () => {
    const html = render(<HomePage />);
    for (const slug of slugs) {
      expect(html).toContain(`aria-controls="tools-${slug}"`);
      expect(html).toContain(`id="tools-${slug}" class="tool-grid"`);
    }
    expect(html).not.toContain('aria-expanded="false"');
    expect(html).not.toContain('class="tool-section collapsed"');
    expect(html).toContain('<button type="button" class="tool-section-head"');
    expect(html).toContain('Collapse all');
    expect(html).toContain('Expand all');
    expect(html).toContain(`href="${CATEGORIES[0].functions[0].path}"`);
  });

  it('a collapsed slug hides its tiles and reports aria-expanded="false"', () => {
    writeSections(KEY, { [first]: false });
    const html = render(<HomePage />);
    const section = html.slice(html.indexOf(`aria-controls="tools-${first}"`) - 200, html.indexOf(`id="tools-${first}"`) + 60);
    expect(section).toContain('aria-expanded="false"');
    expect(section).toContain('class="tool-section-head"');
    expect(html).toContain(`id="tools-${first}" class="tool-grid" hidden=""`);
    expect(html).not.toContain(`href="${CATEGORIES[0].functions[0].path}"`);
    // The other categories stay open.
    expect(html).toContain(`href="${CATEGORIES[1].functions[0].path}"`);
    expect((html.match(/aria-expanded="false"/g) || []).length).toBe(1);
  });

  it('a stored entry that is not a boolean counts as the default', () => {
    writeSections(KEY, { [first]: 'no' });
    expect(render(<HomePage />)).not.toContain('aria-expanded="false"');
    store.set(KEY, 'not json');
    expect(readSections(KEY)).toEqual({});
    store.set(KEY, '[1,2]');
    expect(readSections(KEY)).toEqual({});
  });

  it('Collapse all persists { slug: false } for every slug, Expand all clears the key', () => {
    const collapsed = collapsedAll(slugs);
    expect(Object.keys(collapsed)).toEqual(slugs);
    expect(Object.values(collapsed).every((v) => v === false)).toBe(true);
    writeSections(KEY, collapsed);
    expect(JSON.parse(store.get(KEY))).toEqual(Object.fromEntries(slugs.map((s) => [s, false])));
    const html = render(<HomePage />);
    expect((html.match(/aria-expanded="false"/g) || []).length).toBe(slugs.length);
    expect(html).not.toContain('class="tool-card"');

    const expanded = expandedAll(slugs);
    expect(expanded).toEqual({});
    writeSections(KEY, expanded);
    expect(store.get(KEY)).toBe('{}');
    expect(render(<HomePage />)).not.toContain('aria-expanded="false"');
  });

  it('isSectionOpen honours the per-surface default (home open, sidebar closed)', () => {
    expect(isSectionOpen({}, 'x')).toBe(true);
    expect(isSectionOpen({}, 'x', false)).toBe(false);
    expect(isSectionOpen({ x: false }, 'x')).toBe(false);
    expect(isSectionOpen({ x: true }, 'x', false)).toBe(true);
    expect(expandedAll(['a', 'b'], false)).toEqual({ a: true, b: true });
  });

  it('the Favorites card carries the same chevron and collapses on its stored flag', () => {
    store.set('whm.favorites', JSON.stringify([CATEGORIES[0].functions[0].key]));
    let html = render(<HomePage />);
    expect(html).toContain('aria-controls="tools-favorites"');
    expect(html).toContain('aria-label="Collapse Favorites"');
    writeSections(KEY, { __favorites: false });
    html = render(<HomePage />);
    expect(html).toContain('aria-label="Expand Favorites"');
    expect(html).toContain('id="tools-favorites" class="tool-grid" hidden=""');
  });
});

describe('Sidebar categories', () => {
  it('stay closed by default, open from the stored flag, and offer Expand all / Collapse all', () => {
    let html = render(<Sidebar collapsed={false} onToggle={() => {}} />);
    expect(html).toContain('Expand all');
    expect(html).toContain('Collapse all');
    expect(html).not.toContain('nav-category open');
    writeSections('whm.sidebar.open', { [first]: true });
    html = render(<Sidebar collapsed={false} onToggle={() => {}} />);
    expect(html).toContain('nav-category open');
    expect(html).toContain(`href="${CATEGORIES[0].functions[0].path}"`);
    expect(html).not.toContain(`href="${CATEGORIES[1].functions[0].path}"`);
  });

  it('a category the user closed stays closed on its own route until the next navigation', () => {
    // Static rendering runs no effects: the stored "closed" flag is what the first paint shows.
    writeSections('whm.sidebar.open', { [first]: false });
    const html = render(<Sidebar collapsed={false} onToggle={() => {}} />, CATEGORIES[0].functions[0].path);
    expect(html).not.toContain('nav-category open');
  });
});
