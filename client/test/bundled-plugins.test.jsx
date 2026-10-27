import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { PluginNavContext, pluginEntries } from '../src/hooks/usePluginNav.js';
import { CATEGORIES } from '../src/nav.js';
import ServerMonitoring from '../src/pages/fn/plugins/server-monitoring.jsx';
import ImunifyAv from '../src/pages/fn/plugins/imunifyav.jsx';
import WpToolkit from '../src/pages/fn/plugins/wp-toolkit.jsx';
import { Sparkline } from '../src/pages/plugins/ServerMonitoring.jsx';
import { formatRate } from '../src/pages/plugins/BundledPlugin.jsx';

// The bundled-plugin status call decides whether the root-only Settings tab shows.
let statusData = null;
vi.mock('../src/hooks/useApi.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, useApi: (path, opts) => (typeof path === 'string' && path.startsWith('/bundled-plugins/')) ? { data: statusData, meta: null, error: null, loading: false, refetch() {} } : mod.useApi(path, opts) };
});

React.useLayoutEffect = React.useEffect;

const fns = Object.fromEntries(CATEGORIES.find((c) => c.slug === 'plugins').functions.map((f) => [f.slug, f]));
const plugin = (id, name) => ({ id, name, version: '1.0.0', sidebar: [], pages: [{ route: '/settings', title: 'Settings', kind: 'settings', source: 'manifest' }] });

function render(Page, fn, plugins) {
  const value = { plugins, entries: pluginEntries(plugins), loading: false, error: null, reload() {} };
  return renderToStaticMarkup(
    <MemoryRouter><PluginNavContext.Provider value={value}><ToastProvider><ConfirmProvider><Page fn={fn} /></ConfirmProvider></ToastProvider></PluginNavContext.Provider></MemoryRouter>,
  );
}

describe('Plugins category pages', () => {
  it('render the overview shell with tabs when the plugin is enabled', () => {
    statusData = null;
    const mon = render(ServerMonitoring, fns['server-monitoring'], [plugin('net.whm.server-monitoring', 'Server Monitoring')]);
    expect(mon).toContain('Server Monitoring');
    expect(mon).toContain('Overview');
    expect(mon).not.toContain('>Settings<');
    expect(mon).toContain('Sample now');
    statusData = { state: 'enabled', canManage: true };
    expect(render(ServerMonitoring, fns['server-monitoring'], [plugin('net.whm.server-monitoring', 'Server Monitoring')])).toContain('Settings');
    statusData = null;
    const av = render(ImunifyAv, fns.imunifyav, [plugin('net.whm.imunifyav', 'ImunifyAV')]);
    expect(av).toContain('Malicious files');
    expect(av).toContain('Quarantine');
    const wp = render(WpToolkit, fns['wp-toolkit'], [plugin('net.whm.wp-toolkit', 'WP Toolkit')]);
    expect(wp).toContain('Discover sites');
    expect(wp).toContain('WordPress sites');
  });

  it('show the enable prompt (with Manage Plugins link) when the plugin is not enabled', () => {
    for (const [Page, fn] of [[ServerMonitoring, fns['server-monitoring']], [ImunifyAv, fns.imunifyav], [WpToolkit, fns['wp-toolkit']]]) {
      const html = render(Page, fn, []);
      expect(html).toContain(fn.label);
      expect(html).toContain('/cpanel/manage-plugins');
      expect(html).not.toContain('Overview');
    }
  });

  it('sparklines draw one path per series, the threshold rule and a table-safe empty state', () => {
    const from = 0; const to = 3600e3;
    const points = Array.from({ length: 10 }, (_, i) => ({ ts: i * 360e3, v: i % 3 === 0 ? null : i }));
    const html = renderToStaticMarkup(<Sparkline label="x" series={[{ key: 'a', label: 'a', points }, { key: 'b', label: 'b', points }]} threshold={5} from={from} to={to} />);
    expect(html.match(/<path /g)).toHaveLength(2);
    expect(html).toContain('alert at 5');
    expect(html).toContain('<svg');
    expect(renderToStaticMarkup(<Sparkline label="x" series={[{ key: 'a', label: 'a', points: [] }]} from={from} to={to} />)).toContain('No samples');
    expect(formatRate(2048)).toBe('2.0 KB/s');
    expect(formatRate(null)).toBe('—');
  });
});
