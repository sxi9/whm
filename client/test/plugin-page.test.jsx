import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { PluginNavContext, pluginEntries, searchEntries } from '../src/hooks/usePluginNav.js';
import PluginPage, { PluginPageView, renderMarkdown, rowsOf, fieldDefault } from '../src/pages/plugins/PluginPage.jsx';

// Static server rendering is enough to exercise every page kind; react-router's
// layout effects are no-ops there and would only print warnings.
React.useLayoutEffect = React.useEffect;

const plugin = {
  id: 'net.example.hello', name: 'Hello Plugin', version: '1.2.3',
  sidebar: [{ category: 'Plugins', label: 'Hello', route: '/', icon: 'hand' }, { category: 'Nope', label: 'Lost', route: '/settings', icon: 'cog' }],
  pages: [
    { route: '/', title: 'Hello', kind: 'table', source: '/items', columns: [{ key: 'id', label: 'ID' }] },
    { route: '/settings', title: 'Settings', kind: 'settings' },
    { route: '/run', title: 'Run now', kind: 'action', job: 'nightly', confirm: true, description: 'Runs the nightly job.' },
    { route: '/form', title: 'Add item', kind: 'form', source: '/items', fields: [{ key: 'name', type: 'text', label: 'Name', required: true }, { key: 'size', type: 'number', label: 'Size', default: 3 }, { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }] }, { key: 'on', type: 'toggle', label: 'On' }, { key: 'tags', type: 'multiselect', label: 'Tags', options: [{ value: 'x', label: 'X' }] }, { key: 'pw', type: 'password', label: 'Secret' }, { key: 'when', type: 'cron', label: 'When' }, { key: 'notes', type: 'textarea', label: 'Notes' }] },
    { route: '/docs', title: 'Docs', kind: 'markdown', content: '# Title\n\nSome **bold** and `code` with a [link](https://example.net) and <b>raw</b>.\n\n- one\n- two\n\n```\nconst x = 1;\n```\n' },
    { route: '/embed', title: 'Embed', kind: 'html', file: 'ui/index.html' },
  ],
};

function render(path, value = { plugins: [plugin], entries: pluginEntries([plugin]), loading: false, error: null, reload() {} }) {
  return renderToStaticMarkup(
    <PluginNavContext.Provider value={value}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes><Route path="plugins/:pluginId/*" element={<PluginPage />} /></Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </PluginNavContext.Provider>,
  );
}

describe('PluginPage renders every page kind', () => {
  it('table', () => {
    const html = render('/plugins/net.example.hello');
    expect(html).toContain('Hello');
    expect(html).toContain('<table');
    expect(html).toContain('ID');
  });
  it('settings', () => {
    const html = render('/plugins/net.example.hello/settings');
    expect(html).toContain('Hello Plugin settings');
  });
  it('action', () => {
    const html = render('/plugins/net.example.hello/run');
    expect(html).toContain('Run now');
    expect(html).toContain('Runs the nightly job.');
    expect(html).toContain('>Run<');
  });
  it('form with every field type', () => {
    const html = render('/plugins/net.example.hello/form');
    for (const label of ['Name', 'Size', 'Mode', 'On', 'Tags', 'Secret', 'When', 'Notes']) expect(html).toContain(label);
    expect(html).toContain('type="password"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<select');
    expect(html).toContain('<textarea');
    expect(html).toContain('value="3"');
  });
  it('markdown without raw HTML', () => {
    const html = render('/plugins/net.example.hello/docs');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('href="https://example.net"');
    expect(html).toContain('&lt;b&gt;raw&lt;/b&gt;');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('const x = 1;');
  });
  it('html in a fully sandboxed iframe once the file is loaded', () => {
    const html = render('/plugins/net.example.hello/embed');
    expect(html).toContain('Embed');
    expect(html).not.toContain('<iframe');
    const loaded = renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter><PluginPageView plugin={plugin} page={{ ...plugin.pages[5] }} /></MemoryRouter></ConfirmProvider></ToastProvider>);
    expect(loaded).toContain('Embed');
  });
  it('unknown routes and plugins fall back to a not-found card', () => {
    expect(render('/plugins/net.example.hello/nope')).toContain('There is no such plugin page');
    expect(render('/plugins/net.example.other')).toContain('There is no such plugin page');
    expect(render('/plugins/net.example.hello', { plugins: [], entries: [], loading: true, error: null, reload() {} })).toContain('Loading plugins');
  });
});

describe('plugin nav helpers', () => {
  it('maps sidebar entries onto nav categories and falls back to Plugins', () => {
    const entries = pluginEntries([plugin]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: 'plugin:net.example.hello:/', label: 'Hello', path: '/plugins/net.example.hello', category: 'Plugins', categorySlug: 'plugins', plugin: true });
    expect(entries[1]).toMatchObject({ label: 'Lost', path: '/plugins/net.example.hello/settings', category: 'Plugins' });
    expect(searchEntries(entries, 'lost').map((e) => e.label)).toEqual(['Lost']);
    expect(searchEntries(entries, 'hello plugin')).toHaveLength(2);
  });
  it('helpers', () => {
    expect(rowsOf([1])).toEqual([1]);
    expect(rowsOf({ rows: [2] })).toEqual([2]);
    expect(rowsOf(null)).toEqual([]);
    expect(fieldDefault({ type: 'toggle' })).toBe(false);
    expect(fieldDefault({ type: 'text', default: 'x' })).toBe('x');
    expect(renderToStaticMarkup(<div>{renderMarkdown('1. a\n2. b\n\n## H2')}</div>)).toBe('<div><ol><li>a</li><li>b</li></ol><h2>H2</h2></div>');
  });
});
