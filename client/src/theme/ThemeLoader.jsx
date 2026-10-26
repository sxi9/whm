import { useEffect } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { applyTheme, cacheTheme, cachedTheme, onThemeChanged } from './applyTheme.js';

// Paints the cached theme immediately, then applies the server's active theme once a
// session exists and whenever a Themes page reports a change.
export function ThemeLoader() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  useEffect(() => { const cached = cachedTheme(); if (cached) applyTheme(cached); }, []);

  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    const load = async () => {
      try {
        const { data } = await api.get('/themes/active');
        if (!alive || !data) return;
        applyTheme(data);
        cacheTheme(data);
      } catch { /* the cached or built-in theme stays in place */ }
    };
    load();
    const off = onThemeChanged(load);
    return () => { alive = false; off(); };
  }, [userId]);

  return null;
}
