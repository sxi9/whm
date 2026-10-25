import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, Search, Star, Home, ChevronsDownUp, ChevronsUpDown, X, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import { CATEGORIES, searchFunctions, FUNCTION_BY_KEY } from '../nav.js';
import { useFavorites } from '../hooks/useFavorites.js';
import { iconFor } from '../icons.js';

export function Sidebar({ collapsed, onToggle }) {
  const location = useLocation();
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(() => {
    try { return JSON.parse(localStorage.getItem('whm.sidebar.open') || '{}'); } catch { return {}; }
  });
  const { favorites } = useFavorites();

  useEffect(() => { try { localStorage.setItem('whm.sidebar.open', JSON.stringify(open)); } catch { /* ignore */ } }, [open]);

  // Expand the category of the current page so the active item is visible.
  useEffect(() => {
    const cat = CATEGORIES.find((c) => location.pathname.startsWith(`/${c.slug}/`));
    if (cat && !open[cat.slug]) setOpen((o) => ({ ...o, [cat.slug]: true }));
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useMemo(() => (filter.trim() ? new Set(searchFunctions(filter).map((f) => f.key)) : null), [filter]);
  const setAll = (value) => setOpen(Object.fromEntries(CATEGORIES.map((c) => [c.slug, value])));
  const favoriteFns = favorites.map((k) => FUNCTION_BY_KEY[k]).filter(Boolean);

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-search">
        <Search size={16} />
        <input placeholder="Search (Alt + /)" value={filter} onChange={(e) => setFilter(e.target.value)} id="sidebar-search" aria-label="Search functions" />
        {filter && <button className="icon-button" onClick={() => setFilter('')} aria-label="Clear search"><X size={14} /></button>}
      </div>
      <div className="sidebar-tools">
        <button className="link-button" onClick={() => setAll(true)} title="Expand all"><ChevronsUpDown size={14} /> Expand all</button>
        <button className="link-button" onClick={() => setAll(false)} title="Collapse all"><ChevronsDownUp size={14} /> Collapse all</button>
      </div>
      <nav className="sidebar-nav" aria-label="WHM functions">
        <NavLink to="/" end className={({ isActive }) => `nav-home ${isActive ? 'active' : ''}`}><Home size={16} /> <span>Home</span></NavLink>

        {!matches && favoriteFns.length > 0 && (
          <div className="nav-category">
            <button className="nav-category-head" onClick={() => setOpen((o) => ({ ...o, __favorites: !o.__favorites }))}>
              {open.__favorites === false ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <Star size={16} /> <span>Favorites</span><span className="count">{favoriteFns.length}</span>
            </button>
            {open.__favorites !== false && (
              <ul>{favoriteFns.map((f) => <li key={f.key}><NavLink to={f.path} className={({ isActive }) => (isActive ? 'active' : '')}>{f.label}</NavLink></li>)}</ul>
            )}
          </div>
        )}

        {CATEGORIES.map((cat) => {
          const Icon = iconFor(cat.icon);
          const fns = matches ? cat.functions.filter((f) => matches.has(f.key)) : cat.functions;
          if (matches && fns.length === 0) return null;
          const isOpen = matches ? true : Boolean(open[cat.slug]);
          return (
            <div key={cat.slug} className={`nav-category ${isOpen ? 'open' : ''}`}>
              <button className="nav-category-head" onClick={() => setOpen((o) => ({ ...o, [cat.slug]: !o[cat.slug] }))} aria-expanded={isOpen}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Icon size={16} />
                <span>{cat.label}</span>
                <span className="count">{fns.length}</span>
              </button>
              {isOpen && (
                <ul>
                  {fns.map((f) => (
                    <li key={f.key}><NavLink to={f.path} className={({ isActive }) => (isActive ? 'active' : '')}>{f.label}</NavLink></li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {matches && matches.size === 0 && <div className="nav-empty">No functions match “{filter}”.</div>}
      </nav>
      <button className="sidebar-collapse" onClick={onToggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
    </aside>
  );
}
