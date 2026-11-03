import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, ChevronDown, LogOut, KeyRound, ShieldCheck, Menu, LifeBuoy, UserRound } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useBranding } from '../pages/cpanel/branding.js';
import { Brand } from '../components/Brand.jsx';
import { useT } from '../i18n/useT.js';
import { PANEL_BASE, PANEL_PATHS, panelId, searchPanelFunctions } from './nav.js';
import { usePanelMe } from './hooks/usePanel.js';

// Search over the panel functions (Alt /), the account chip, and the user menu
// (password, two-factor, help links, sign out). No audit-log link, no bell: a
// customer has neither.
export function PanelTopBar({ onMenu }) {
  const { user, logout } = useAuth();
  const { me } = usePanelMe();
  const branding = useBranding();
  const navigate = useNavigate();
  const { t } = useT();
  const [q, setQ] = useState('');
  const [openMenu, setOpenMenu] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef(null);
  const results = q.trim() ? searchPanelFunctions(q, me?.account?.features).slice(0, 8) : [];

  useEffect(() => {
    const onKey = (e) => { if (e.altKey && e.key === '/') { e.preventDefault(); inputRef.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const go = (fn) => { if (fn) { navigate(fn.path); setQ(''); setHighlight(0); } };
  const account = me?.account;
  const shownName = account?.username || user?.username;

  return (
    <header className="topbar panel-topbar">
      <button className="icon-button topbar-menu" onClick={onMenu} aria-label={t('panel.shell.toggle_navigation', 'Toggle navigation')}><Menu size={20} /></button>
      <Brand to={PANEL_BASE} withText={false} />
      <div className="topbar-search" role="search">
        <Search size={16} />
        <input ref={inputRef} value={q} placeholder={t('panel.shell.search_tools', 'Search tools')} onChange={(e) => { setQ(e.target.value); setHighlight(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, results.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
            if (e.key === 'Enter') go(results[highlight]);
            if (e.key === 'Escape') setQ('');
          }} aria-label={t('panel.shell.search_tools', 'Search tools')} />
        {!q && <kbd>Alt /</kbd>}
        {results.length > 0 && (
          <ul className="search-results" role="listbox">
            {results.map((f, i) => (
              <li key={f.key} role="option" aria-selected={i === highlight} className={i === highlight ? 'active' : ''} onMouseDown={() => go(f)}>
                <span>{t(`panel.${panelId(f)}.label`, f.label)}</span><small>{t(`panel-category.${f.categorySlug}`, f.category)}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="topbar-right">
        {account?.domain && <Link to={`${PANEL_BASE}/overview/account`} className="topbar-host" title={t('panel.shell.account', 'Account')}>{account.domain}</Link>}
        <div className="menu" onMouseLeave={() => setOpenMenu(false)}>
          <button className="user-menu" onClick={() => setOpenMenu((o) => !o)} aria-haspopup="menu" aria-expanded={openMenu}>
            <span className="avatar">{shownName?.[0]?.toUpperCase()}</span>
            <span className="user-name">{shownName}</span>
            <ChevronDown size={14} />
          </button>
          {openMenu && (
            <div className="menu-items right" role="menu">
              <div className="menu-meta"><strong>{shownName}</strong><small>{me?.actingAs ? t('panel.shell.acting_as_short', 'viewed by {by}').replace('{by}', me.actingAs.by || '') : (account?.package || t('panel.shell.account', 'Account'))}</small></div>
              <Link className="menu-item" to={`${PANEL_BASE}/overview/account`} onClick={() => setOpenMenu(false)}><UserRound size={14} /> {t('panel.overview/account.label', 'Account details')}</Link>
              {!me?.actingAs && <Link className="menu-item" to={PANEL_PATHS.password} onClick={() => setOpenMenu(false)}><KeyRound size={14} /> {t('panel.shell.change_password', 'Change password')}</Link>}
              {!me?.actingAs && <Link className="menu-item" to={PANEL_PATHS.twoFactor} onClick={() => setOpenMenu(false)}><ShieldCheck size={14} /> {t('panel.security/two-factor.label', 'Two-factor authentication')}</Link>}
              {[[t('panel.shell.help', 'Help'), branding.helpUrl], [t('panel.shell.documentation', 'Documentation'), branding.docsUrl], [t('panel.shell.support', 'Support'), branding.supportUrl]].filter(([, url]) => url).map(([label, url]) => (
                <a key={label} className="menu-item" href={url} target="_blank" rel="noopener noreferrer"><LifeBuoy size={14} /> {label}</a>
              ))}
              <button className="menu-item" onClick={() => logout().then(() => navigate('/login'))}><LogOut size={14} /> {t('panel.shell.sign_out', 'Sign out')}</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
