import { Suspense, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { Loading } from '../components/Common.jsx';
import { useBranding, useBrandingLoader } from '../pages/cpanel/branding.js';
import { useT } from '../i18n/useT.js';
import { ShellContext, PANEL_SHELL } from './ShellContext.js';
import { PanelContext, usePanelMeLoader } from './hooks/usePanel.js';
import { PanelSidebar } from './PanelSidebar.jsx';
import { PanelTopBar } from './PanelTopBar.jsx';
import { PanelBanners } from './PanelBanners.jsx';
import { PanelDisabledPage } from './PanelDisabled.jsx';
import { PANEL_PATHS } from './nav.js';

const COLLAPSED_KEY = 'whm.panel.sidebar.collapsed';
const ADMIN_PASSWORD_PATH = '/change-password';
const PASSWORD_PATHS = [PANEL_PATHS.password, PANEL_PATHS.changePassword];
const TWO_FACTOR_PATHS = [...PASSWORD_PATHS, PANEL_PATHS.twoFactor];

// Where the shell must send this session instead of rendering `pathname`, or null
// (design §6.2). Pure, so test/panel-layout.test.js can table it.
export function panelRedirect(user, me, pathname) {
  if (!user) return { to: '/login', state: { from: pathname } };
  if (user.role !== 'user' && me && !me.actingAs) return { to: '/' };
  // users.must_change_password belongs to the principal's own row: an admin changes it on the
  // admin route, and the panel's password endpoint refuses an impersonating admin anyway.
  if (user.mustChangePassword && user.role !== 'user') return { to: ADMIN_PASSWORD_PATH };
  if (!me) return null;
  // The server closes the force_password_change gate only for mode 'user' (routes/categories/panel.js).
  const forced = Boolean(me.account?.forcePasswordChange) && !me.actingAs;
  if ((forced || user.mustChangePassword) && !PASSWORD_PATHS.includes(pathname)) return { to: PANEL_PATHS.password };
  if (me.policy?.require2fa && !user.totpEnabled && !me.actingAs && !TWO_FACTOR_PATHS.includes(pathname)) return { to: PANEL_PATHS.twoFactor };
  return null;
}

// /me refusals that replace the shell with a full-page notice rather than a redirect.
export function isTerminalPanelError(error) {
  return Boolean(error) && (error.status === 403 || error.status === 423 || error.status === 501);
}

// The shell proper: sidebar, top bar, banners, routed page. Pure given `me`.
export function PanelShell({ me, children }) {
  const { user } = useAuth();
  const location = useLocation();
  const branding = useBranding();
  const { t } = useT();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; } });
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* storage unavailable */ } }, [collapsed]);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  return (
    <div className={`app panel-app ${collapsed ? 'sidebar-collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`} data-shell="panel">
      <PanelSidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} />}
      <div className="app-main">
        <PanelTopBar onMenu={() => setMobileOpen((o) => !o)} />
        <main className="content" id="main">
          <PanelBanners />
          <Suspense fallback={<Loading />}>
            {children ?? <Outlet />}
          </Suspense>
        </main>
        <footer className="app-footer">
          <span>{branding.footerText || `${branding.companyName} · ${branding.tagline}`}</span>
          <span>{t('panel.shell.signed_in_as', 'Signed in as {user}').replace('{user}', me?.actingAs ? `${me.actingAs.by} (${t('panel.shell.viewing', 'viewing')} ${me.account?.username})` : (user?.username || ''))}</span>
        </footer>
      </div>
    </div>
  );
}

// Auth gate + ShellContext + PanelContext for every /panel route (design §6.2):
// no PluginNavProvider, no license or revocation banners, no audit-log link.
export function PanelLayout() {
  const { user, ready } = useAuth();
  const location = useLocation();
  useBrandingLoader(user?.id ?? null);
  const loader = usePanelMeLoader(Boolean(ready && user));
  const { me, loading, error } = loader;

  if (!ready) return <div className="app-loading"><Loading text="Starting…" /></div>;
  const redirect = panelRedirect(user, me, location.pathname);
  if (redirect) return <Navigate to={redirect.to} state={redirect.state} replace />;
  if (!me && isTerminalPanelError(error)) return <PanelDisabledPage error={error} onRetry={loader.reload} />;
  if (!me && loading) return <div className="app-loading"><Loading text="Opening your account…" /></div>;
  if (!me) return <PanelDisabledPage error={error || { code: 'unavailable', message: 'The panel API did not answer.' }} onRetry={loader.reload} />;

  return (
    <ShellContext.Provider value={PANEL_SHELL}>
      <PanelContext.Provider value={loader}>
        <PanelShell me={me} />
      </PanelContext.Provider>
    </ShellContext.Provider>
  );
}
