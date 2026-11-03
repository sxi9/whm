import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PANEL_SHELL } from '../ShellContext.js';
import { featureEnabled } from '../nav.js';

// GET /api/panel/me, loaded once by PanelLayout and shared by every panel page.
// Shape (design §4.1): { user, account, usage, counts, actingAs, policy, hostname, csrfToken }.
export const PanelContext = createContext({ me: null, loading: true, error: null, reload: () => {}, hasFeature: () => true });

export function usePanelMe() {
  return useContext(PanelContext);
}

// Pages call usePanelApi('/domains') for GET /api/panel/domains.
export function usePanelApi(path, opts) {
  return useApi(path ? `/panel${path}` : null, opts);
}

export const panelApi = {
  get: (path) => api.get(`/panel${path}`),
  post: (path, body) => api.post(`/panel${path}`, body),
  put: (path, body) => api.put(`/panel${path}`, body),
  patch: (path, body) => api.patch(`/panel${path}`, body),
  delete: (path) => api.delete(`/panel${path}`),
};

// The /me loader used by PanelLayout. Errors keep their ApiError code so the layout
// can tell panel_disabled / no_account / panel_scope_required apart from outages.
export function usePanelMeLoader(enabled) {
  const [state, setState] = useState({ me: null, loading: Boolean(enabled), error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    api.get('/panel/me')
      .then((res) => {
        if (!alive) return;
        if (res.data?.csrfToken) api.setCsrfToken(res.data.csrfToken);
        setState({ me: res.data, loading: false, error: null });
      })
      .catch((error) => { if (alive) setState({ me: null, loading: false, error }); });
    return () => { alive = false; };
  }, [enabled, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const hasFeature = useCallback((feature) => featureEnabled(state.me?.account?.features, feature), [state.me]);
  return useMemo(() => ({ ...state, reload, hasFeature }), [state, reload, hasFeature]);
}

// Minutes until an ISO timestamp, never negative; null when absent.
export function minutesLeft(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 60_000));
}

// The persistent shell banners for this session (design §2.3–§2.5): acting-as,
// suspended, forced password change, demo mode. Pure given `me`, so tests can
// call it without rendering.
export function scopeBanners(me, now = Date.now()) {
  const out = [];
  if (!me) return out;
  if (me.actingAs) out.push({ kind: 'acting', tone: 'info', account: me.actingAs.account || me.account?.username, by: me.actingAs.by, expiresAt: me.actingAs.expiresAt, minutesLeft: minutesLeft(me.actingAs.expiresAt, now) });
  if (me.account?.suspended) out.push({ kind: 'suspended', tone: 'error' });
  if (me.account?.forcePasswordChange || me.user?.mustChangePassword) out.push({ kind: 'force-password', tone: 'warning' });
  if (me.account?.demoMode) out.push({ kind: 'demo', tone: 'warning' });
  return out;
}

export function useScopeBanner() {
  const { me } = usePanelMe();
  return useMemo(() => scopeBanners(me), [me]);
}

// Favorites for the panel live under their own key so an admin who also uses
// "Log in as" never mixes the two shells' pins.
function readFavorites() {
  try { return JSON.parse(localStorage.getItem(PANEL_SHELL.favoritesKey) || '[]'); } catch { return []; }
}

export function usePanelFavorites() {
  const [favorites, setFavorites] = useState(readFavorites);
  useEffect(() => { try { localStorage.setItem(PANEL_SHELL.favoritesKey, JSON.stringify(favorites)); } catch { /* storage unavailable */ } }, [favorites]);
  const toggle = useCallback((key) => setFavorites((f) => (f.includes(key) ? f.filter((k) => k !== key) : [...f, key])), []);
  const isFavorite = useCallback((key) => favorites.includes(key), [favorites]);
  return { favorites, toggle, isFavorite };
}

// Percent of a used/limit pair; null when unlimited (limit null/0/-1) or unknown.
export function percentOf(used, limit) {
  if (used == null || limit == null || !(limit > 0)) return null;
  return Math.min(100, Math.round((Number(used) / Number(limit)) * 100));
}

export function meterTone(percent) {
  if (percent == null) return '';
  if (percent >= 95) return 'bad';
  if (percent >= 80) return 'warn';
  return '';
}
