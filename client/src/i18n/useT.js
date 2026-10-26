import { useCallback, useEffect, useState } from 'react';

// Tiny i18n: the active locale's strings come from GET /api/locales/active once per
// page load (shared by every component), and t(key, fallback) returns the fallback
// (or the key) for anything untranslated. A viewer can prefer an enabled locale over
// the server default with setPreferredLocale(code); the choice lives in localStorage.

const PREF_KEY = 'whm.locale';
let state = { code: null, strings: {}, loaded: false, enabled: [], default: null };
let inflight = null;
const listeners = new Set();

const notify = () => { for (const fn of listeners) fn(state); };

export function preferredLocale() {
  try { return localStorage.getItem(PREF_KEY) || null; } catch { return null; }
}

export function setPreferredLocale(code) {
  try { if (code) localStorage.setItem(PREF_KEY, code); else localStorage.removeItem(PREF_KEY); } catch { /* storage unavailable */ }
  inflight = null;
  return loadActiveLocale(true);
}

// Uses fetch directly (not api.request) so a 401 on this background call never
// triggers the global sign-out handler.
export function loadActiveLocale(force = false) {
  if (inflight && !force) return inflight;
  const pref = preferredLocale();
  inflight = fetch(`/api/locales/active${pref ? `?code=${encodeURIComponent(pref)}` : ''}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      const d = body?.data;
      state = d ? { code: d.code, strings: d.strings || {}, loaded: true, enabled: d.enabled || [], default: d.default } : { ...state, loaded: true };
      notify();
      return state;
    })
    .catch(() => { state = { ...state, loaded: true }; notify(); return state; });
  return inflight;
}

export function translate(key, fallback) {
  const v = state.strings[key];
  return typeof v === 'string' && v !== '' ? v : fallback ?? key;
}

export function useT() {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    listeners.add(setSnapshot);
    if (!state.loaded) loadActiveLocale();
    return () => { listeners.delete(setSnapshot); };
  }, []);
  const t = useCallback((key, fallback) => {
    const v = snapshot.strings[key];
    return typeof v === 'string' && v !== '' ? v : fallback ?? key;
  }, [snapshot]);
  return { t, locale: snapshot.code, loaded: snapshot.loaded, enabled: snapshot.enabled, defaultLocale: snapshot.default, reload: () => loadActiveLocale(true) };
}
