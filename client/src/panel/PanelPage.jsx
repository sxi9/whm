import { Link } from 'react-router-dom';
import { Star, Hammer, AlertTriangle, PackageX } from 'lucide-react';
import { Card, EmptyState } from '../components/Common.jsx';
import { useT } from '../i18n/useT.js';
import { useShell } from './ShellContext.js';
import { usePanelFavorites } from './hooks/usePanel.js';
import { panelId } from './nav.js';

// The page chrome for /panel pages: the admin PageHeader's DOM and classes, but
// breadcrumbs go to the panel home, labels resolve under the `panel.` i18n prefix
// and the star pins to the panel's own favorites key. Once the integrator makes
// components/Common.jsx's PageHeader read ShellContext this becomes an alias.
export function PanelPageHeader({ fn, title, description, actions, children }) {
  const shell = useShell();
  const { isFavorite, toggle } = usePanelFavorites();
  const { t } = useT();
  const id = fn ? panelId(fn) : null;
  const heading = title || (fn && t(`${shell.i18nPrefix}.${id}.label`, fn.label));
  const text = description || (fn && t(`${shell.i18nPrefix}.${id}.description`, fn.description));
  return (
    <header className="page-header">
      <div className="page-header-main">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link to={shell.home}>{t('panel.common.home', 'Home')}</Link>
          {fn && <><span>›</span><span>{t(`${shell.categoryPrefix}.${fn.categorySlug}`, fn.category)}</span></>}
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

// Wrapper every panel page starts with: header + content.
export function PanelPage({ fn, title, description, actions, children }) {
  return (
    <>
      <PanelPageHeader fn={fn} title={title} description={description} actions={actions} />
      {children}
    </>
  );
}

// 501 from the API: the daemon behind this screen is not installed on the server.
// Customers cannot install anything, so the prompt tells them whom to ask.
export function PanelCapabilityState({ error, onRetry }) {
  if (!error) return null;
  if (error.status !== 501 && error.code !== 'capability_missing' && error.code !== 'binary_not_found') return null;
  return (
    <EmptyState icon={PackageX} title="Not available on this server">
      <p>{error.message || 'The service behind this screen is not installed.'}</p>
      <p className="muted">Ask your hosting provider to enable it. Everything else in the account panel keeps working.</p>
      {onRetry && <p><button className="btn btn-sm" onClick={onRetry}>Re-check</button></p>}
    </EmptyState>
  );
}

// A mutation answered `applied:false, reason:'capability_missing'` (dev hosts): the
// record is saved, the host-side change waits for the daemon.
export function PendingPill({ result }) {
  if (!result || result.applied !== false) return null;
  return <span className="pill pill-info" title={result.reason || 'pending'}>Pending</span>;
}

// Feature gate for a page (plan feature off → 403 feature_disabled from the API).
export function FeatureDisabledState({ fn }) {
  return (
    <Card>
      <EmptyState icon={AlertTriangle} title="Not included in your plan">
        <p>{fn ? `${fn.label} is not part of the hosting plan on this account.` : 'This feature is not part of the hosting plan on this account.'}</p>
        <p className="muted">Ask your hosting provider about upgrading the plan.</p>
        <p><Link to="/panel">Back to the dashboard</Link></p>
      </EmptyState>
    </Card>
  );
}

// Every function in panel/nav.js routes here until its page exists under pages/panel/.
export function PanelFunctionPage({ fn }) {
  return (
    <PanelPage fn={fn}>
      <Card>
        <EmptyState icon={Hammer} title="This screen is on its way">
          <p>{fn.description}</p>
          <p className="muted">It is already in the navigation and search; its interface lands with the next panel build.</p>
          <p><Link to="/panel">Back to the dashboard</Link></p>
        </EmptyState>
      </Card>
    </PanelPage>
  );
}

export function PanelNotFoundPage() {
  return (
    <PanelPage title="Page not found">
      <Card><EmptyState title="Nothing is at this address"><p>Check the link, or use the search above to find what you were looking for.</p><p><Link to="/panel">Back to the dashboard</Link></p></EmptyState></Card>
    </PanelPage>
  );
}
