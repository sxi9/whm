import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Menu, LogOut, ShieldCheck, KeyRound } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { NAV_BY_AREA, AREA_LABELS } from './nav.js';

// Portal chrome: top bar, area sidebar, content outlet. The step-up modal is
// mounted by AuthProvider, so pages only see the retried request succeed.
export function Shell({ area }) {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const identity = session?.kind === 'developer' ? session.developer?.email : session?.user?.email;
  const role = session?.kind === 'developer' ? session.developer?.status : session?.user?.role;
  const reseller = session?.kind === 'portal' && session.user?.reseller_id ? session.brand || {} : null;
  const brand = reseller ? reseller.name || 'Reseller portal' : 'WHM Hub';
  const stepUpFresh = session?.totpVerifiedAt && Date.now() - new Date(session.totpVerifiedAt).getTime() < 5 * 60_000;

  return (
    <div className={`app ${mobileOpen ? 'mobile-open' : ''}`}>
      <header className="topbar">
        <button className="icon-button topbar-menu" onClick={() => setMobileOpen((o) => !o)} aria-label="Menu"><Menu size={20} /></button>
        <div className="brand">{reseller?.logo_url ? <img src={reseller.logo_url} alt="" className="brand-logo" style={{ height: 20, width: 'auto' }} /> : <ShieldCheck size={18} />} <strong>{brand}</strong> <span className="brand-sub muted">{AREA_LABELS[area]}</span></div>
        <div className="topbar-right">
          {session?.kind !== 'developer' && <span className="topbar-host" title="Two-factor step-up status"><KeyRound size={12} /> {session?.totpEnabled ? (stepUpFresh ? '2FA confirmed' : '2FA armed') : 'no 2FA'}</span>}
          <span className="topbar-host">{identity} · {role}</span>
          <button className="icon-button" onClick={async () => { await logout(); navigate(area === 'dev' ? '/dev/login' : '/login'); }} aria-label="Sign out" title="Sign out"><LogOut size={18} /></button>
        </div>
      </header>
      <div className="app-body">
        {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} />}
        <aside className="sidebar">
          <nav className="sidebar-nav" aria-label="Portal navigation">
            {(NAV_BY_AREA[area] || []).map((group) => (
              <div className="nav-category" key={group.title}>
                <div className="nav-category-head"><span>{group.title}</span></div>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.to}><NavLink to={item.to} end={item.end} onClick={() => setMobileOpen(false)} className={({ isActive }) => (isActive ? 'active' : '')}>{item.label}</NavLink></li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
        <main className="content"><Outlet /></main>
      </div>
      <footer className="app-footer"><span>{reseller ? brand : 'whm-hub'} · {AREA_LABELS[area]}</span><span className="muted">{reseller?.support_url ? <a href={reseller.support_url} target="_blank" rel="noreferrer noopener">Support</a> : 'Every mutation is audited'}</span></footer>
    </div>
  );
}
