import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, Bell, ChevronDown, LogOut, KeyRound, ShieldCheck, ScrollText, Menu as MenuIcon, LifeBuoy } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useSearch } from '../hooks/usePluginNav.js';
import { useBranding } from '../pages/cpanel/branding.js';
import { Brand } from './Brand.jsx';
import { Menu } from './Menu.jsx';

export function TopBar({ onMenu }) {
  const { user, hostname, logout } = useAuth();
  const branding = useBranding();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef(null);
  const searchFunctions = useSearch();
  const results = q.trim() ? searchFunctions(q).slice(0, 8) : [];

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
      <button className="icon-button topbar-menu" onClick={onMenu} aria-label="Toggle navigation"><MenuIcon size={20} /></button>
      <Brand withText={false} />
      <div className="topbar-search" role="search">
        <Search size={16} />
        <input ref={inputRef} value={q} placeholder="Search functions" onChange={(e) => { setQ(e.target.value); setHighlight(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, results.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
            if (e.key === 'Enter') go(results[highlight]);
            if (e.key === 'Escape') setQ('');
          }} aria-label="Search functions" />
        {!q && <kbd>Alt /</kbd>}
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
        <button className="icon-button" title="Notifications" aria-label="Notifications"><Bell size={18} /></button>
        <Menu align="right" header={<><strong>{user?.username}</strong><small>{user?.role}</small></>}
          items={[
            { label: 'Change password', icon: KeyRound, to: '/change-password' },
            { label: 'Two-factor authentication', icon: ShieldCheck, to: '/security-center/two-factor-authentication' },
            ...[['Help', branding.helpUrl], ['Documentation', branding.docsUrl], ['Support', branding.supportUrl]].filter(([, url]) => url).map(([label, url]) => ({ label, icon: LifeBuoy, href: url })),
            { label: 'Log out', icon: LogOut, onClick: () => logout().then(() => navigate('/login')) },
          ]}
          trigger={(props) => (
            <button {...props} className="user-menu" aria-label={`Account menu, ${user?.username ?? ''}`}>
              <span className="avatar" aria-hidden="true">{user?.username?.[0]?.toUpperCase()}</span>
              <span className="user-name">{user?.username}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          )} />
      </div>
    </header>
  );
}
