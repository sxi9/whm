import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Menu, LogOut, ShieldCheck, KeyRound } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { NAV_BY_AREA, AREA_LABELS } from './nav.js';

// Advisory only: the hub decides freshness with license.stepup_max_age_s,
// which the session does not carry, so the indicator reports when the last
// confirmation happened instead of guessing whether it is still fresh.
export function stepUpIndicator(session, now = Date.now()) {
  if (!session?.totpEnabled) return 'no 2FA';
  const at = session.totpVerifiedAt ? new Date(session.totpVerifiedAt).getTime() : NaN;
  if (!Number.isFinite(at)) return '2FA armed';
  const s = Math.max(0, Math.round((now - at) / 1000));
  const ago = s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
  return `2FA confirmed ${ago}`;
}

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
  const stepUp = stepUpIndicator(session);

  return (
    <div className={`app ${mobileOpen ? 'mobile-open' : ''}`}>
      <header className="topbar">
        <button className="icon-button topbar-menu" onClick={() => setMobileOpen((o) => !o)} aria-label="Menu"><Menu size={20} /></button>
        <div className="brand">{reseller?.logo_url ? <img src={reseller.logo_url} alt="" className="brand-logo" style={{ height: 20, width: 'auto' }} /> : <ShieldCheck size={18} />} <strong>{brand}</strong> <span className="brand-sub muted">{AREA_LABELS[area]}</span></div>
        <div className="topbar-right">
          {session?.kind !== 'developer' && <span className="topbar-host" title="Two-factor step-up status"><KeyRound size={12} /> {stepUp}</span>}
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
