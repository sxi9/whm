import { createContext, createElement, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { CATEGORIES, searchFunctions } from '../nav.js';
import { useAuth } from '../auth/AuthContext.jsx';

// Enabled plugins add sidebar entries at runtime. They are fetched once per
// page load from GET /api/plugins/ui and merged into the categories nav.js
// defines (by label; an unknown category lands under "Plugins"), so the sidebar,
// the Tools grid and search all see them without nav.js ever changing.

const FALLBACK_CATEGORY = 'Plugins';
export const PluginNavContext = createContext({ plugins: [], entries: [], loading: false, error: null, reload: () => {} });

export function pluginEntries(plugins) {
  const out = [];
  for (const p of plugins || []) {
    for (const s of p.sidebar || []) {
      const cat = CATEGORIES.find((c) => c.label === s.category) || CATEGORIES.find((c) => c.label === FALLBACK_CATEGORY);
      const page = (p.pages || []).find((pg) => pg.route === s.route);
      const route = s.route === '/' ? '' : s.route;
      out.push({
        key: `plugin:${p.id}:${s.route}`, label: s.label, description: page?.description || `${p.name} plugin`, icon: s.icon || null,
        path: `/plugins/${p.id}${route}`, category: cat?.label || FALLBACK_CATEGORY, categorySlug: cat?.slug || 'plugins', pluginId: p.id, plugin: true, phase: null,
      });
    }
  }
  return out;
}

export function PluginNavProvider({ children, enabled = true }) {
  const [state, setState] = useState({ plugins: [], loading: Boolean(enabled), error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    api.get('/plugins/ui')
      .then((res) => { if (alive) setState({ plugins: res.data || [], loading: false, error: null }); })
      .catch((error) => { if (alive) setState({ plugins: [], loading: false, error }); });
    return () => { alive = false; };
  }, [enabled, tick]);
  const value = useMemo(() => ({ ...state, entries: pluginEntries(state.plugins), reload: () => setTick((t) => t + 1) }), [state]);
  return createElement(PluginNavContext.Provider, { value }, children);
}

export function usePluginNav() {
  return useContext(PluginNavContext);
}

// The active Server Profile (Server Configuration) hides whole categories from the shell;
// their routes stay reachable by URL, as in WHM.
export function useHiddenCategories() {
  const { user } = useAuth();
  return user?.profile?.hiddenCategories || [];
}

export function mergeCategories(categories, entries, hidden = []) {
  const visible = hidden.length ? categories.filter((cat) => !hidden.includes(cat.slug)) : categories;
  if (!entries.length) return visible;
  return visible.map((cat) => {
    const extra = entries.filter((e) => e.categorySlug === cat.slug);
    return extra.length ? { ...cat, functions: [...cat.functions, ...extra] } : cat;
  });
}

// nav.js categories minus the profile-hidden ones, with the plugin entries appended to their category.
export function useMergedCategories() {
  const { entries } = usePluginNav();
  const hidden = useHiddenCategories();
  return useMemo(() => mergeCategories(CATEGORIES, entries, hidden), [entries, hidden]);
}

export function searchEntries(entries, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return entries;
  const terms = q.split(/\s+/);
  return entries.filter((f) => {
    const hay = `${f.label} ${f.category} ${f.description}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

// searchFunctions() plus the plugin entries, for the top bar and the sidebar filter.
export function useSearch() {
  const { entries } = usePluginNav();
  const hidden = useHiddenCategories();
  return useMemo(() => (query) => [...searchFunctions(query), ...searchEntries(entries, query)].filter((f) => !hidden.includes(f.categorySlug)), [entries, hidden]);
}
