import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, Search, Star, Home, X, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import { Brand } from '../components/Brand.jsx';
import { useT } from '../i18n/useT.js';
import { PANEL_BASE, PANEL_FUNCTION_BY_KEY, panelId, searchPanelFunctions, visibleCategories } from './nav.js';
import { panelIconFor, panelColorFor } from './icons.js';
import { usePanelFavorites, usePanelMe } from './hooks/usePanel.js';

const OPEN_KEY = 'whm.panel.sidebar.open';

function readOpen() {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); } catch { return {}; }
}

// Groups from panel/nav.js filtered by the account's plan features, with the same
// chrome as the admin sidebar (coloured icon tiles, counts, favorites, filter).
export function PanelSidebar({ collapsed, onToggle }) {
  const location = useLocation();
  const { t } = useT();
  const { me } = usePanelMe();
  const features = me?.account?.features;
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(readOpen);
  const { favorites } = usePanelFavorites();
  const categories = useMemo(() => visibleCategories(features), [features]);

  useEffect(() => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch { /* storage unavailable */ } }, [open]);
  useEffect(() => {
    const cat = categories.find((c) => location.pathname.startsWith(`${PANEL_BASE}/${c.slug}/`));
    if (cat && !open[cat.slug]) setOpen((o) => ({ ...o, [cat.slug]: true }));
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useMemo(() => (filter.trim() ? new Set(searchPanelFunctions(filter, features).map((f) => f.key)) : null), [filter, features]);
  const favoriteFns = favorites.map((k) => PANEL_FUNCTION_BY_KEY[k]).filter(Boolean);
  const label = (fn) => t(`panel.${panelId(fn)}.label`, fn.label);

  return (
    <aside className={`sidebar panel-sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand"><Brand to={PANEL_BASE} /></div>
      <div className="sidebar-search">
        <Search size={16} />
        <input placeholder={t('panel.shell.search', 'Search')} value={filter} onChange={(e) => setFilter(e.target.value)} id="panel-sidebar-search" aria-label={t('panel.shell.search_tools', 'Search tools')} />
        {filter && <button className="icon-button" onClick={() => setFilter('')} aria-label={t('common.clear', 'Clear')}><X size={14} /></button>}
      </div>
      <nav className="sidebar-nav" aria-label={t('panel.shell.tools', 'Tools')}>
        <NavLink to={PANEL_BASE} end className={({ isActive }) => `nav-home ${isActive ? 'active' : ''}`}><Home size={16} /> <span>{t('panel.common.home', 'Home')}</span></NavLink>

        {!matches && favoriteFns.length > 0 && (
          <div className="nav-category open">
            <button className="nav-category-head" onClick={() => setOpen((o) => ({ ...o, __favorites: !o.__favorites }))}>
              {open.__favorites === false ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <span className="nav-tile" style={{ '--tile': '#ff9f0a' }}><Star size={14} strokeWidth={2.25} /></span> <span>{t('panel.shell.favorites', 'Favorites')}</span><span className="count">{favoriteFns.length}</span>
            </button>
            {open.__favorites !== false && (
              <ul>{favoriteFns.map((f) => <li key={f.key}><NavLink to={f.path} className={({ isActive }) => (isActive ? 'active' : '')}>{label(f)}</NavLink></li>)}</ul>
            )}
          </div>
        )}

        {categories.map((cat) => {
          const Icon = panelIconFor(cat.icon);
          const fns = matches ? cat.functions.filter((f) => matches.has(f.key)) : cat.functions;
          if (matches && fns.length === 0) return null;
          const isOpen = matches ? true : Boolean(open[cat.slug]);
          return (
            <div key={cat.slug} className={`nav-category ${isOpen ? 'open' : ''}`} data-group={cat.slug}>
              <button className="nav-category-head" onClick={() => setOpen((o) => ({ ...o, [cat.slug]: !o[cat.slug] }))} aria-expanded={isOpen}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="nav-tile" style={{ '--tile': panelColorFor(cat.slug) }}><Icon size={14} strokeWidth={2.25} /></span>
                <span>{t(`panel-category.${cat.slug}`, cat.label)}</span>
                <span className="count">{fns.length}</span>
              </button>
              {isOpen && (
                <ul>
                  {fns.map((f) => (
                    <li key={f.key}><NavLink to={f.path} className={({ isActive }) => (isActive ? 'active' : '')}>{label(f)}</NavLink></li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {matches && matches.size === 0 && <div className="nav-empty">{t('panel.shell.no_matches', 'Nothing matches')} “{filter}”.</div>}
      </nav>
      {onToggle && (
        <button className="sidebar-collapse" onClick={onToggle} aria-label={collapsed ? t('panel.shell.expand_sidebar', 'Expand sidebar') : t('panel.shell.collapse_sidebar', 'Collapse sidebar')}>
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      )}
    </aside>
  );
}
