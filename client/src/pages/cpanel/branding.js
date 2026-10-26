import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';

// Branding from GET /api/branding (cPanel › Customization): company name, colours,
// help links, login notice and the logo descriptor. The shell loads it once a
// session exists and caches it, so the public login page paints with the last
// known branding without a request (the API is behind authentication).

const CACHE_KEY = 'whm.branding';
const STYLE_ID = 'whm-branding-css';
const EVENT = 'whm:branding-changed';
export const DEFAULT_BRANDING = { companyName: 'WHM', tagline: 'WebHost Manager', primaryColor: '', chromeColor: '', helpUrl: '', docsUrl: '', supportUrl: '', loginNotice: '', footerText: '', logo: null, favicon: null };

let current = null;

export function cachedBranding() {
  if (current) return current;
  try { const raw = localStorage.getItem(CACHE_KEY); current = raw ? { ...DEFAULT_BRANDING, ...JSON.parse(raw) } : null; } catch { current = null; }
  return current;
}

function cache(branding) {
  current = branding;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(branding)); } catch { /* storage unavailable */ }
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// Colours go into a stylesheet rule, so a theme's inline token overrides
// (ThemeLoader) still win when an operator sets both.
export function applyBranding(branding) {
  if (!branding) return;
  const rules = [];
  if (HEX.test(branding.primaryColor || '')) rules.push(`--primary: ${branding.primaryColor}; --primary-hover: ${branding.primaryColor}; --chrome-active: ${branding.primaryColor};`);
  if (HEX.test(branding.chromeColor || '')) rules.push(`--chrome: ${branding.chromeColor}; --chrome-2: ${branding.chromeColor};`);
  let style = document.getElementById(STYLE_ID);
  if (!style) { style = document.createElement('style'); style.id = STYLE_ID; document.head.appendChild(style); }
  style.textContent = rules.length ? `:root { ${rules.join(' ')} }` : '';
  if (branding.companyName) document.title = branding.companyName === 'WHM' ? 'WHM' : `${branding.companyName} · WHM`;
  let link = document.querySelector('link[rel="icon"][data-branding]');
  if (branding.favicon?.url) {
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; link.dataset.branding = '1'; document.head.appendChild(link); }
    link.href = branding.favicon.url;
  } else if (link) link.remove();
}

export async function refreshBranding() {
  const { data } = await api.get('/branding');
  const branding = { ...DEFAULT_BRANDING, ...data };
  cache(branding);
  applyBranding(branding);
  window.dispatchEvent(new Event(EVENT));
  return branding;
}

export function notifyBrandingChanged() { refreshBranding().catch(() => {}); }

// Current branding for components; re-renders when the shell refreshes it.
export function useBranding() {
  const [branding, setBranding] = useState(() => cachedBranding() || DEFAULT_BRANDING);
  useEffect(() => {
    applyBranding(cachedBranding());
    const onChange = () => setBranding(cachedBranding() || DEFAULT_BRANDING);
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return branding;
}

// Mounted once in the shell: paints the cached branding immediately and loads
// the server's copy whenever a session starts.
export function useBrandingLoader(userId) {
  useEffect(() => { applyBranding(cachedBranding()); }, []);
  useEffect(() => {
    if (!userId) return;
    refreshBranding().catch(() => { /* the cached or default branding stays */ });
  }, [userId]);
}

export function logoSrc(branding) {
  return branding?.logo?.dataUrl || branding?.logo?.url || null;
}
