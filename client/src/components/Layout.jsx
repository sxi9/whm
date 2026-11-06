import { Suspense, useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { TopBar } from './TopBar.jsx';
import { Sidebar } from './Sidebar.jsx';
import { SidebarExpand, SIDEBAR_ID } from './SidebarExpand.jsx';
import { Loading } from './Common.jsx';
import { PluginNavProvider } from '../hooks/usePluginNav.js';
import { useBranding, useBrandingLoader } from '../pages/cpanel/branding.js';
import { LicenseBanner } from '../pages/server-configuration/LicenseTab.jsx';
import { RevocationBanner } from './RevocationBanner.jsx';

export function Layout() {
  const { user, ready } = useAuth();
  const location = useLocation();
  const branding = useBranding();
  useBrandingLoader(user?.id ?? null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('whm.sidebar.collapsed') === '1');
  const [mobileOpen, setMobileOpen] = useState(false);
  // The control the user activates unmounts with the toggle, so focus moves to its counterpart.
  const refocus = useRef(false);
  const setSidebar = (next) => { refocus.current = true; setCollapsed(next); };

  useEffect(() => { localStorage.setItem('whm.sidebar.collapsed', collapsed ? '1' : '0'); }, [collapsed]);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    document.querySelector(collapsed ? '.sidebar-expand' : `#${SIDEBAR_ID} .sidebar-collapse`)?.focus();
  }, [collapsed]);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  if (!ready) return <div className="app-loading"><Loading text="Starting…" /></div>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (user.role === 'user') return <Navigate to="/panel" replace />;
  if (user.mustChangePassword && location.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  if (user.mustEnroll2fa && !['/security-center/two-factor-authentication', '/change-password'].includes(location.pathname)) {
    return <Navigate to="/security-center/two-factor-authentication" replace />;
  }

  return (
    <PluginNavProvider enabled={!user.mustChangePassword && !user.mustEnroll2fa}>
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
      <Sidebar collapsed={collapsed} onToggle={() => setSidebar(!collapsed)} />
      {collapsed && <SidebarExpand onClick={() => setSidebar(false)} />}
      {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} />}
      <div className="app-main">
        <TopBar onMenu={() => setMobileOpen((o) => !o)} sidebarCollapsed={collapsed} onShowSidebar={() => setSidebar(false)} />
        <main className="content" id="main">
          <LicenseBanner license={user.license} />
          <RevocationBanner />
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </main>
        <footer className="app-footer">
          <span>{branding.footerText || `${branding.companyName} · ${branding.tagline}`}</span>
          <span>Signed in as {user.username} · {user.role}</span>
        </footer>
      </div>
    </div>
    </PluginNavProvider>
  );
}
