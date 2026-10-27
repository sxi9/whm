import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { StepUpModal } from './StepUpModal.jsx';

// One SPA, two session kinds. Portal sessions (vendor_* and reseller_* roles,
// cookie whmhub.sid) drive /admin and /reseller; developer sessions (cookie
// whmdev.sid) drive /dev. Each has its own CSRF token and step-up endpoint.
const AuthContext = createContext(null);

export const AREA_ROLES = {
  admin: ['vendor_admin', 'vendor_support'],
  reseller: ['reseller_admin', 'reseller_staff'],
};

export function areaOf(session) {
  if (!session) return null;
  if (session.kind === 'developer') return 'dev';
  const role = session.user?.role || '';
  if (AREA_ROLES.admin.includes(role)) return 'admin';
  if (AREA_ROLES.reseller.includes(role)) return 'reseller';
  return null;
}

export function homeOf(session) {
  const area = areaOf(session);
  return area ? `/${area}` : '/login';
}

export function loginPathFor(area) {
  return area === 'dev' ? '/dev/login' : '/login';
}

export function stepUpPathFor(session) {
  return session?.kind === 'developer' ? '/dev/2fa/stepup' : '/portal/stepup';
}

// Reseller users carry their tenant's white-label brand (resellers.brand_json:
// name, logo_url, support_url) in /portal/me and /portal/login as
// `reseller: { id, name, brand }` (build-plan contract row); absent → defaults.
// Only an absolute https URL may become an href/src in the portals; anything
// else (javascript:, data:, relative) renders as plain text.
export function safeUrl(u) {
  return typeof u === 'string' && /^https:\/\/[^\s/?#]+/i.test(u) ? u : null;
}

export function brandOf(data) {
  const brand = data?.reseller?.brand || data?.brand || null;
  if (!brand || typeof brand !== 'object') return null;
  return { name: typeof brand.name === 'string' && brand.name.trim() ? brand.name.trim() : data?.reseller?.name || null, logo_url: safeUrl(brand.logo_url), support_url: safeUrl(brand.support_url) };
}

// §16.9: while a vendor_admin impersonates a reseller, /portal/me reports the
// effective reseller_admin identity in `user` and the window in
// `impersonating: { reseller_id, by, expires_at }`; the SPA routes on the
// effective role and the Shell shows the banner with the End action.
export function impersonationOf(data) {
  const imp = data?.impersonating;
  if (!imp || typeof imp !== 'object' || typeof imp.reseller_id !== 'string') return null;
  return { reseller_id: imp.reseller_id, by: imp.by || null, expires_at: imp.expires_at || null, reseller_name: data?.reseller?.name || null };
}

function portalSession(data) {
  return { kind: 'portal', user: data.user, totpVerifiedAt: data.totp_verified_at || null, totpEnabled: !!data.user?.totp_enabled, brand: data.user?.reseller_id ? brandOf(data) : null, impersonating: impersonationOf(data) };
}
function developerSession(data) {
  return { kind: 'developer', developer: data.developer, scopes: data.scopes || ['*'], totpVerifiedAt: data.totp_verified_at || null, totpEnabled: !!data.developer?.totp_enabled };
}

export function AuthProvider({ children, initialPath = typeof window !== 'undefined' ? window.location.pathname : '/' }) {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [stepUpRequest, setStepUpRequest] = useState(null);
  const sessionRef = useRef(null);
  sessionRef.current = session;

  const refresh = useCallback(async () => {
    const preferDev = initialPath.startsWith('/dev');
    const tryPortal = async () => { const { data } = await api.get('/portal/me'); api.setCsrfToken(data.csrfToken); return portalSession(data); };
    const tryDev = async () => { const { data } = await api.get('/dev/me'); api.setCsrfToken(data.csrfToken); return developerSession(data); };
    const order = preferDev ? [tryDev, tryPortal] : [tryPortal, tryDev];
    for (const attempt of order) {
      try { const s = await attempt(); setSession(s); setReady(true); return s; } catch { /* next */ }
    }
    setSession(null);
    api.setCsrfToken(null);
    setReady(true);
    return null;
  }, [initialPath]);

  useEffect(() => {
    api.setUnauthorizedHandler(() => { setSession(null); api.setCsrfToken(null); });
    api.setStepUpHandler((err, info) => new Promise((resolve) => {
      if (!sessionRef.current) { resolve(false); return; }
      setStepUpRequest({ err, info, resolve });
    }));
    refresh();
  }, [refresh]);

  const value = useMemo(() => ({
    session, ready, refresh,
    area: areaOf(session),
    async loginPortal({ email, password, totp }) {
      const { data } = await api.post('/portal/login', totp ? { email, password, totp } : { email, password });
      api.setCsrfToken(data.csrfToken);
      const s = portalSession(data);
      setSession(s);
      return s;
    },
    async loginDeveloper({ email, password, totp }) {
      const { data } = await api.post('/dev/login', totp ? { email, password, totp } : { email, password });
      api.setCsrfToken(data.csrfToken);
      const s = developerSession(data);
      setSession(s);
      return s;
    },
    async logout() {
      const path = session?.kind === 'developer' ? '/dev/logout' : '/portal/logout';
      try { await api.post(path); } finally { setSession(null); api.setCsrfToken(null); }
    },
    // Fresh TOTP confirmation; the modal and the Security pages call this.
    async stepUp(totp) {
      const { data } = await api.post(stepUpPathFor(session), { totp });
      setSession((s) => (s ? { ...s, totpVerifiedAt: data.totp_verified_at || Date.now() } : s));
      return data;
    },
    // §16.9 impersonate-reseller: the hub rebinds this vendor_admin session to
    // the reseller tenant for 15 minutes; the session is re-read so the SPA
    // routes on the effective reseller_admin role. end() restores the admin.
    async impersonate(resellerId) {
      const { data } = await api.post(`/admin/resellers/${encodeURIComponent(resellerId)}/impersonate`, {});
      await refresh();
      return data;
    },
    async endImpersonation() {
      try { await api.post('/portal/impersonate/end', {}); } finally { await refresh(); }
    },
    markTotpEnabled(enabled) {
      setSession((s) => (s ? { ...s, totpEnabled: enabled, totpVerifiedAt: enabled ? Date.now() : null } : s));
    },
  }), [session, ready, refresh]);

  const finishStepUp = (ok) => { stepUpRequest?.resolve(ok); setStepUpRequest(null); };
  return (
    <AuthContext.Provider value={value}>
      {children}
      <StepUpModal open={Boolean(stepUpRequest)} request={stepUpRequest} session={session} stepUp={value.stepUp} onDone={() => finishStepUp(true)} onCancel={() => finishStepUp(false)} />
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
