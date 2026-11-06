import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, Search, Star, Home, ChevronsDownUp, ChevronsUpDown, X, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import { FUNCTION_BY_KEY } from '../nav.js';
import { useMergedCategories, useSearch } from '../hooks/usePluginNav.js';
import { useFavorites } from '../hooks/useFavorites.js';
import { useCollapsedSections } from '../hooks/useCollapsedSections.js';
import { iconFor, colorFor } from '../icons.js';
import { Brand } from './Brand.jsx';

const FAVORITES_KEY = '__favorites';

export function Sidebar({ collapsed, onToggle }) {
  const location = useLocation();
  const [filter, setFilter] = useState('');
  const sections = useCollapsedSections('whm.sidebar.open', { defaultOpen: false });
  const { favorites } = useFavorites();
  const CATEGORIES = useMergedCategories();
  const searchFunctions = useSearch();

  // Open the category of the current page once per navigation so the active item is
  // visible; the user may close it again afterwards.
  useEffect(() => {
    const cat = CATEGORIES.find((c) => location.pathname.startsWith(`/${c.slug}/`));
    if (cat) sections.setOpen(cat.slug, true);
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useMemo(() => (filter.trim() ? new Set(searchFunctions(filter).map((f) => f.key)) : null), [filter, searchFunctions]);
  const slugs = CATEGORIES.map((c) => c.slug);
  const favoriteFns = favorites.map((k) => FUNCTION_BY_KEY[k]).filter(Boolean);
  const favoritesOpen = sections.sections[FAVORITES_KEY] !== false;

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand"><Brand /></div>
      <div className="sidebar-search">
        <Search size={16} />
        <input placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} id="sidebar-search" aria-label="Search functions" />
        {filter && <button className="icon-button" onClick={() => setFilter('')} aria-label="Clear search"><X size={14} /></button>}
      </div>
      <div className="sidebar-tools">
        <button className="link-button" onClick={() => sections.expandAll(slugs)} title="Expand all"><ChevronsUpDown size={14} /> Expand all</button>
        <button className="link-button" onClick={() => sections.collapseAll(slugs)} title="Collapse all"><ChevronsDownUp size={14} /> Collapse all</button>
      </div>
      <nav className="sidebar-nav" aria-label="Functions">
        <NavLink to="/" end className={({ isActive }) => `nav-home ${isActive ? 'active' : ''}`}><Home size={16} /> <span>Home</span></NavLink>

        {!matches && favoriteFns.length > 0 && (
          <div className="nav-category">
            <button className="nav-category-head" onClick={() => sections.setOpen(FAVORITES_KEY, !favoritesOpen)} aria-expanded={favoritesOpen}>
              {favoritesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="nav-tile" style={{ '--tile': '#ff9f0a' }}><Star size={14} strokeWidth={2.25} /></span> <span>Favorites</span><span className="count">{favoriteFns.length}</span>
            </button>
            {favoritesOpen && (
              <ul>{favoriteFns.map((f) => <li key={f.key}><NavLink to={f.path} className={({ isActive }) => (isActive ? 'active' : '')}>{f.label}</NavLink></li>)}</ul>
            )}
          </div>
        )}

        {CATEGORIES.map((cat) => {
          const Icon = iconFor(cat.icon);
          const fns = matches ? cat.functions.filter((f) => matches.has(f.key)) : cat.functions;
          if (matches && fns.length === 0) return null;
          const isOpen = matches ? true : sections.isOpen(cat.slug);
          return (
            <div key={cat.slug} className={`nav-category ${isOpen ? 'open' : ''}`}>
              <button className="nav-category-head" onClick={() => sections.toggle(cat.slug)} aria-expanded={isOpen}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="nav-tile" style={{ '--tile': colorFor(cat.slug) }}><Icon size={14} strokeWidth={2.25} /></span>
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
