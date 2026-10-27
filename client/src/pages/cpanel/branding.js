import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';

// Branding from GET /api/branding (cPanel › Customization): company name, colours,
// help links, login notice and the logo/favicon descriptors. The endpoint is
// public, so the login page reads it before a session exists; a cached copy only
// avoids a flash of defaults while the request is in flight.

const CACHE_KEY = 'whm.branding';
const STYLE_ID = 'whm-branding-css';
const EVENT = 'whm:branding-changed';
export const DEFAULT_BRANDING = { companyName: 'WHM', tagline: 'WebHost Manager', primaryColor: '', chromeColor: '', helpUrl: '', docsUrl: '', supportUrl: '', loginNotice: '', footerText: '', logo: null, favicon: null };

let current = null;
let inflight = null;

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
  if (inflight) return inflight;
  inflight = api.get('/branding').then(({ data }) => {
    const branding = { ...DEFAULT_BRANDING, ...data };
    cache(branding);
    applyBranding(branding);
    window.dispatchEvent(new Event(EVENT));
    return branding;
  }).finally(() => { inflight = null; });
  return inflight;
}

export function notifyBrandingChanged() { refreshBranding().catch(() => {}); }

// Current branding for components. The first subscriber on a page load fetches
// the server's copy (no session needed); every subscriber re-renders when it
// changes.
let loadedOnce = false;
export function useBranding() {
  const [branding, setBranding] = useState(() => cachedBranding() || DEFAULT_BRANDING);
  useEffect(() => {
    applyBranding(cachedBranding());
    const onChange = () => setBranding(cachedBranding() || DEFAULT_BRANDING);
    window.addEventListener(EVENT, onChange);
    if (!loadedOnce) { loadedOnce = true; refreshBranding().catch(() => { loadedOnce = false; }); }
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return branding;
}

// Mounted once in the shell: re-reads the server's copy whenever a session
// starts, so a change made from another browser shows up at the next login.
export function useBrandingLoader(userId) {
  useEffect(() => { applyBranding(cachedBranding()); }, []);
  useEffect(() => {
    if (!userId) return;
    refreshBranding().catch(() => { /* the cached or default branding stays */ });
  }, [userId]);
}

export function logoSrc(branding) {
  return branding?.logo?.url || null;
}
