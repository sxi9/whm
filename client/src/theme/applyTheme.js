// Applies a theme from GET /api/themes/active to the document: the colour scheme via
// data-theme (removed for scheme "auto" so tokens.css follows prefers-color-scheme, as the
// stock theme does), token overrides as inline custom properties on <html> (they win over
// tokens.css), and the uploaded CSS override in a dedicated <style>. The last applied
// theme is cached so the login screen paints with it before any request completes.

const CACHE_KEY = 'whm.theme.active';
const STYLE_ID = 'whm-theme-css';
const EVENT = 'whm:theme-changed';
let applied = [];

export function applyTheme(theme) {
  const root = document.documentElement;
  const scheme = theme?.scheme || theme?.base;
  if (scheme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = scheme === 'dark' ? 'dark' : 'light';
  for (const key of applied) root.style.removeProperty(`--${key}`);
  applied = [];
  for (const [key, value] of Object.entries(theme?.variables || {})) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(key) || typeof value !== 'string') continue;
    root.style.setProperty(`--${key}`, value);
    applied.push(key);
  }
  let style = document.getElementById(STYLE_ID);
  if (!style) { style = document.createElement('style'); style.id = STYLE_ID; document.head.appendChild(style); }
  style.textContent = theme?.css || '';
}

export function cacheTheme(theme) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ slug: theme.slug, base: theme.base, scheme: theme.scheme || theme.base, variables: theme.variables || {}, css: theme.css || '' })); } catch { /* storage unavailable */ }
}

export function cachedTheme() {
  try { const raw = localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// Pages that change themes call this so the shell re-fetches the active theme.
export function notifyThemeChanged() { window.dispatchEvent(new Event(EVENT)); }
export function onThemeChanged(fn) { window.addEventListener(EVENT, fn); return () => window.removeEventListener(EVENT, fn); }
