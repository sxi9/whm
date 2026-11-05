import { createContext, createElement, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client.js';
import { PANEL_BASE } from '../nav.js';

// Plugin pages for the account panel (contract §53): GET /api/panel/plugins/ui
// lists, per enabled plugin, the pages whose audience is 'panel'. They are
// fetched once per panel session (PanelLayout) and appended to the Software
// group as function-like entries, so the sidebar, the home grid and search see
// them without nav.js changing. Routes live under /panel/plugins/<id>/<route>.

export const PANEL_PLUGIN_GROUP = 'software';
export const PANEL_PLUGINS_PATH = `${PANEL_BASE}/plugins`;
export const PanelPluginContext = createContext({ plugins: [], entries: [], loading: false, error: null, reload: () => {} });

export function panelPluginPath(plugin, page) {
  const id = typeof plugin === 'string' ? plugin : plugin.id;
  const route = page.route === '/' ? '' : page.route;
  return `${PANEL_PLUGINS_PATH}/${id}${route}`;
}

// The shape panel/nav.js functions have, so ToolCard, the sidebar and favorites
// render them unchanged; `panelId()` of the key is the key itself, so t() falls
// back to the plugin's own title and description.
export function panelPluginEntry(plugin, page) {
  return {
    key: `panel-plugin:${plugin.id}:${page.route}`, label: page.title, description: page.description || `${plugin.name} ${plugin.version}`,
    path: panelPluginPath(plugin, page), icon: page.icon || null, category: 'Software', categorySlug: PANEL_PLUGIN_GROUP, pluginId: plugin.id, plugin: true, phase: 1,
  };
}

export function panelPluginEntries(plugins) {
  return (plugins || []).flatMap((p) => (p.pages || []).map((page) => panelPluginEntry(p, page)));
}

// Appends the plugin entries to their group; a plan that hides the whole
// Software group (or the `plugins` feature) shows none.
export function withPluginEntries(categories, entries) {
  if (!entries?.length) return categories;
  return categories.map((c) => (c.slug === PANEL_PLUGIN_GROUP ? { ...c, functions: [...c.functions, ...entries] } : c));
}

export function searchPluginEntries(entries, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return entries;
  const terms = q.split(/\s+/);
  return entries.filter((f) => terms.every((t) => `${f.label} ${f.category} ${f.description}`.toLowerCase().includes(t)));
}

export function PanelPluginProvider({ children, enabled = true }) {
  const [state, setState] = useState({ plugins: [], loading: Boolean(enabled), error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) { setState({ plugins: [], loading: false, error: null }); return undefined; }
    let alive = true;
    api.get('/panel/plugins/ui')
      .then((res) => { if (alive) setState({ plugins: res.data || [], loading: false, error: null }); })
      .catch((error) => { if (alive) setState({ plugins: [], loading: false, error }); });
    return () => { alive = false; };
  }, [enabled, tick]);
  const value = useMemo(() => ({ ...state, entries: panelPluginEntries(state.plugins), reload: () => setTick((t) => t + 1) }), [state]);
  return createElement(PanelPluginContext.Provider, { value }, children);
}

export function usePanelPlugins() {
  return useContext(PanelPluginContext);
}
