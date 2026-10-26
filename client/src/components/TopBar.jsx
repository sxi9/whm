import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, Bell, ChevronDown, LogOut, KeyRound, ShieldCheck, ScrollText, Menu } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useSearch } from '../hooks/usePluginNav.js';

export function TopBar({ onMenu }) {
  const { user, hostname, logout } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [openMenu, setOpenMenu] = useState(false);
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
      <button className="icon-button topbar-menu" onClick={onMenu} aria-label="Toggle navigation"><Menu size={20} /></button>
      <Link to="/" className="brand" aria-label="WHM home">
        <span className="brand-mark">WHM</span>
        <span className="brand-sub">WebHost Manager</span>
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
        <button className="icon-button" title="Notifications" aria-label="Notifications"><Bell size={18} /></button>
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
              <button className="menu-item" onClick={() => logout().then(() => navigate('/login'))}><LogOut size={14} /> Log out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
