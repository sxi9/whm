import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, Bell, ChevronDown, LogOut, KeyRound, ShieldCheck, ScrollText, Menu, LifeBuoy } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useSearch } from '../hooks/usePluginNav.js';
import { useBranding, logoSrc } from '../pages/cpanel/branding.js';

// Unread support-chat messages for the bell: polled once a minute while the tab
// is visible, with plain fetch so a background 401 never signs the viewer out.
const UNREAD_POLL_MS = 60_000;
export function useUnreadSupport() {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const res = await fetch('/api/support/chat/unread', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!res.ok) return;
        const body = await res.json();
        if (!stopped) setUnread(Number(body?.data?.total) || 0);
      } catch { /* offline: keep the last count */ }
    };
    poll();
    const timer = setInterval(poll, UNREAD_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  return unread;
}

export const unreadBadge = (n) => (n > 99 ? '99+' : String(n));
const BADGE_STYLE = { position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: 'var(--bad)', color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center' };

export function TopBar({ onMenu }) {
  const { user, hostname, logout } = useAuth();
  const branding = useBranding();
  const logo = logoSrc(branding);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [openMenu, setOpenMenu] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef(null);
  const searchFunctions = useSearch();
  const results = q.trim() ? searchFunctions(q).slice(0, 8) : [];
  const unread = useUnreadSupport();

  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && e.key === '/') { e.preventDefault(); inputRef.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const go = (fn) => { if (fn) { navigate(fn.path); setQ(''); setHighlight(0); } };

  return (
    <header className="topbar">
      <button className="icon-button topbar-menu" onClick={onMenu} aria-label="Toggle navigation"><Menu size={20} /></button>
      <Link to="/" className="brand" aria-label={`${branding.companyName} home`}>
        {logo ? <img src={logo} alt={branding.companyName} style={{ height: 28, maxWidth: 160, objectFit: 'contain', alignSelf: 'center' }} /> : <span className="brand-mark">{branding.companyName === 'WHM' ? 'WHM' : branding.companyName}</span>}
        <span className="brand-sub">{branding.tagline}</span>
      </Link>
      <div className="topbar-search" role="search">
        <Search size={16} />
        <input ref={inputRef} value={q} placeholder="Search functions (Alt + /)" onChange={(e) => { setQ(e.target.value); setHighlight(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, results.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
            if (e.key === 'Enter') go(results[highlight]);
            if (e.key === 'Escape') setQ('');
          }} aria-label="Search functions" />
        {results.length > 0 && (
          <ul className="search-results" role="listbox">
            {results.map((f, i) => (
              <li key={f.key} role="option" aria-selected={i === highlight} className={i === highlight ? 'active' : ''} onMouseDown={() => go(f)}>
                <span>{f.label}</span><small>{f.category}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="topbar-right">
        <span className="topbar-host" title="Server hostname">{hostname}</span>
        <Link to="/audit-log" className="icon-button" title="Audit log" aria-label="Audit log"><ScrollText size={18} /></Link>
        <Link to="/support/account-conversations" className="icon-button" style={{ position: 'relative' }} title={unread ? `${unread} unread support message${unread === 1 ? '' : 's'}` : 'Notifications'} aria-label={unread ? `Notifications: ${unread} unread support messages` : 'Notifications'}>
          <Bell size={18} />
          {unread > 0 && <span className="topbar-badge" aria-hidden="true" style={BADGE_STYLE}>{unreadBadge(unread)}</span>}
        </Link>
        <div className="menu" onMouseLeave={() => setOpenMenu(false)}>
          <button className="user-menu" onClick={() => setOpenMenu((o) => !o)} aria-haspopup="menu" aria-expanded={openMenu}>
            <span className="avatar">{user?.username?.[0]?.toUpperCase()}</span>
            <span className="user-name">{user?.username}</span>
            <ChevronDown size={14} />
          </button>
          {openMenu && (
            <div className="menu-items right" role="menu">
              <div className="menu-meta"><strong>{user?.username}</strong><small>{user?.role}</small></div>
              <Link className="menu-item" to="/change-password" onClick={() => setOpenMenu(false)}><KeyRound size={14} /> Change password</Link>
              <Link className="menu-item" to="/security-center/two-factor-authentication" onClick={() => setOpenMenu(false)}><ShieldCheck size={14} /> Two-factor authentication</Link>
              {[['Help', branding.helpUrl], ['Documentation', branding.docsUrl], ['Support', branding.supportUrl]].filter(([, url]) => url).map(([label, url]) => (
                <a key={label} className="menu-item" href={url} target="_blank" rel="noopener noreferrer"><LifeBuoy size={14} /> {label}</a>
              ))}
              <button className="menu-item" onClick={() => logout().then(() => navigate('/login'))}><LogOut size={14} /> Log out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
