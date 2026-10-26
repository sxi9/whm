import { Link } from 'react-router-dom';
import { Star, AlertTriangle, Download, Info } from 'lucide-react';
import { useFavorites } from '../hooks/useFavorites.js';
import { useT } from '../i18n/useT.js';

export function PageHeader({ fn, title, description, actions, children }) {
  const { isFavorite, toggle } = useFavorites();
  const { t } = useT();
  const heading = title || (fn && t(`fn.${fn.key}.label`, fn.label));
  const text = description || (fn && t(`fn.${fn.key}.description`, fn.description));
  return (
    <header className="page-header">
      <div className="page-header-main">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link to="/">{t('common.home', 'Home')}</Link>
          {fn && <><span>›</span><span>{t(`category.${fn.categorySlug}`, fn.category)}</span></>}
          {heading && <><span>›</span><span className="current">{heading}</span></>}
        </nav>
        <div className="page-title-row">
          <h1>{heading}</h1>
          {fn && (
            <button className={`icon-button favorite ${isFavorite(fn.key) ? 'active' : ''}`} onClick={() => toggle(fn.key)} aria-label={isFavorite(fn.key) ? t('common.remove_from_favorites', 'Remove from favorites') : t('common.add_to_favorites', 'Add to favorites')} title={t('common.favorite', 'Favorite')}>
              <Star size={18} fill={isFavorite(fn.key) ? 'currentColor' : 'none'} />
            </button>
          )}
        </div>
        {text && <p className="page-description">{text}</p>}
        {children}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, subtitle, actions, children, className = '', padded = true }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function StatusPill({ status, children }) {
  const map = {
    active: 'ok', running: 'ok', done: 'ok', enabled: 'ok', ok: 'ok', up: 'ok', installed: 'ok',
    inactive: 'warn', stopped: 'warn', queued: 'info', pending: 'info', suspended: 'warn', warning: 'warn', degraded: 'warn',
    failed: 'bad', error: 'bad', down: 'bad', unknown: 'muted', 'not-installed': 'muted', disabled: 'muted', cancelled: 'muted',
  };
  const tone = map[String(status).toLowerCase()] || 'muted';
  return <span className={`pill pill-${tone}`}>{children ?? status}</span>;
}

export function Loading({ text = 'Loading…' }) {
  return <div className="loading"><span className="spinner" /> {text}</div>;
}

export function EmptyState({ title, children, icon: Icon = Info }) {
  return (
    <div className="empty-state">
      <Icon size={28} />
      <h3>{title}</h3>
      {children && <div>{children}</div>}
    </div>
  );
}

// Shown when the API says the feature's daemon is missing on this host.
export function CapabilityNotice({ error, onRetry }) {
  if (!error) return null;
  if (error.code !== 'capability_missing' && error.code !== 'binary_not_found' && error.status !== 501) return null;
  return (
    <div className="banner banner-warning">
      <AlertTriangle size={18} />
      <div>
        <strong>Service not installed</strong>
        <p>{error.message}</p>
        <p className="muted">Install the required software on this server (for example via <Link to="/software/install-distro-packages">Install Distro Packages</Link>) and refresh. The rest of the panel keeps working.</p>
      </div>
      {onRetry && <button className="btn btn-sm" onClick={onRetry}>Re-check</button>}
    </div>
  );
}

export function KeyValue({ items }) {
  return (
    <dl className="kv">
      {items.filter(Boolean).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v ?? <span className="muted">—</span>}</dd></div>)}
    </dl>
  );
}

export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let v = Number(bytes);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatMb(mb) {
  if (mb == null) return 'Unlimited';
  return formatBytes(mb * 1024 * 1024);
}

export function formatDuration(seconds) {
  if (seconds == null) return '—';
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(/^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(' ', 'T') + 'Z' : value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

export function DownloadLink({ href, children }) {
  return <a className="btn btn-sm" href={href} download><Download size={14} />{children}</a>;
}
