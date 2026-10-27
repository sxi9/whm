import { Link } from 'react-router-dom';
import { AlertTriangle, Download, Info } from 'lucide-react';

// Hub copy: no favourites or i18n (panel-only hooks). `crumbs` is a list of
// { to, label } rendered before the page title; `home` is the area root.
export function PageHeader({ fn, title, description, actions, children, crumbs = [], home = '/' }) {
  const heading = title || fn?.label;
  const text = description || fn?.description;
  return (
    <header className="page-header">
      <div className="page-header-main">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link to={home}>Home</Link>
          {crumbs.map((c) => <span key={c.label}><span>›</span> {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}</span>)}
          {heading && <><span>›</span><span className="current">{heading}</span></>}
        </nav>
        <div className="page-title-row">
          <h1>{heading}</h1>
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
    active: 'ok', running: 'ok', done: 'ok', enabled: 'ok', ok: 'ok', up: 'ok', installed: 'ok', verified: 'ok', published: 'ok', approved: 'ok', paid: 'ok', passed: 'ok', listed: 'ok', delivered: 'ok',
    inactive: 'warn', stopped: 'warn', queued: 'info', pending: 'info', suspended: 'warn', warning: 'warn', degraded: 'warn', grace: 'warn', retiring: 'warn', in_review: 'info', scanning: 'info', uploaded: 'info',
    changes_requested: 'warn', held: 'warn', high: 'warn', retrying: 'warn', yanked: 'warn', unlisted: 'muted', beta: 'info', info: 'info',
    failed: 'bad', error: 'bad', down: 'bad', revoked: 'bad', rejected: 'bad', expired: 'bad', scan_failed: 'bad', critical: 'bad', blocked: 'bad', refunded: 'bad', chargeback: 'bad', locked: 'bad', removed: 'bad',
    unknown: 'muted', 'not-installed': 'muted', disabled: 'muted', cancelled: 'muted', retired: 'muted', draft: 'muted', deactivated: 'muted', reclaimed: 'muted', closed: 'muted', normal: 'muted', stable: 'ok',
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

// Shown when the hub says a feature is not configured (501), e.g. GitHub OAuth.
export function CapabilityNotice({ error, onRetry }) {
  if (!error) return null;
  if (error.code !== 'capability_missing' && error.status !== 501) return null;
  return (
    <div className="banner banner-warning">
      <AlertTriangle size={18} />
      <div>
        <strong>Not configured on this hub</strong>
        <p>{error.message}</p>
        <p className="muted">Ask the hub operator to enable it in /etc/whm-hub/hub.conf.</p>
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
