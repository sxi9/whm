import { Link } from 'react-router-dom';
import { Star, Hammer, AlertTriangle, PackageX } from 'lucide-react';
import { Card, EmptyState } from '../components/Common.jsx';
import { useT } from '../i18n/useT.js';
import { fill } from '../i18n/fill.js';
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
  // A category landing page is named after its category ("Domains › Domains"): one crumb is enough.
  const categoryLabel = fn ? t(`${shell.categoryPrefix}.${fn.categorySlug}`, fn.category) : null;
  return (
    <header className="page-header">
      <div className="page-header-main">
        <nav className="breadcrumbs" aria-label={t('panel.shell.breadcrumb', 'Breadcrumb')}>
          <Link to={shell.home}>{t('panel.common.home', 'Home')}</Link>
          {fn && categoryLabel !== heading && <><span>›</span><span>{categoryLabel}</span></>}
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

// Error codes that describe a setting of the hosting plan rather than a missing
// daemon: the server answers them with 501 (shell access) or 403 (feature list),
// but for the customer they all mean "not included in your plan".
export const PLAN_SETTING_CODES = ['shell_disabled', 'feature_disabled', 'plan_disabled'];
export const isPlanSettingError = (error) => Boolean(error) && PLAN_SETTING_CODES.includes(error.code);
export const isCapabilityError = (error) => Boolean(error) && !isPlanSettingError(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');

// 501 from the API: the daemon behind this screen is not installed on the server.
// Customers cannot install anything, so the prompt tells them whom to ask. A plan
// setting (`shell_disabled` and the other PLAN_SETTING_CODES) is worded as such.
// `card` gives the state its own surface when it is the whole page body; inside
// a card body, a form or a modal the bare state is the right one.
export function PanelCapabilityState({ error, onRetry, card = false }) {
  const { t } = useT();
  if (!error) return null;
  let state = null;
  if (isPlanSettingError(error)) {
    state = (
      <EmptyState icon={AlertTriangle} title={t('panel.shell.feature_disabled_title', 'Not included in your plan')}>
        <p>{error.message || t('panel.shell.feature_disabled_generic', 'This feature is not part of the hosting plan on this account.')}</p>
        <p className="muted">{t('panel.shell.feature_disabled_help', 'Ask your hosting provider about upgrading the plan.')}</p>
      </EmptyState>
    );
  } else if (isCapabilityError(error)) {
    state = (
      <EmptyState icon={PackageX} title={t('panel.shell.capability_title', 'Not available on this server')}>
        <p>{error.message || t('panel.shell.capability_text', 'The service behind this screen is not installed.')}</p>
        <p className="muted">{t('panel.shell.capability_help', 'Ask your hosting provider to enable it. Everything else in the account panel keeps working.')}</p>
        {onRetry && <p><button className="btn btn-sm" onClick={onRetry}>{t('panel.shell.recheck', 'Re-check')}</button></p>}
      </EmptyState>
    );
  }
  if (!state) return null;
  return card ? <Card>{state}</Card> : state;
}

// A mutation answered `applied:false, reason:'capability_missing'` (dev hosts): the
// record is saved, the host-side change waits for the daemon.
export function PendingPill({ result }) {
  const { t } = useT();
  if (!result || result.applied !== false) return null;
  return <span className="pill pill-info" title={result.reason || 'pending'}>{t('panel.shell.pending', 'Pending')}</span>;
}

// Feature gate for a page (plan feature off → 403 feature_disabled from the API).
export function FeatureDisabledState({ fn }) {
  const { t } = useT();
  const label = fn && t(`panel.${panelId(fn)}.label`, fn.label);
  return (
    <Card>
      <EmptyState icon={AlertTriangle} title={t('panel.shell.feature_disabled_title', 'Not included in your plan')}>
        <p>{fn ? fill(t('panel.shell.feature_disabled_text', '{feature} is not part of the hosting plan on this account.'), { feature: label }) : t('panel.shell.feature_disabled_generic', 'This feature is not part of the hosting plan on this account.')}</p>
        <p className="muted">{t('panel.shell.feature_disabled_help', 'Ask your hosting provider about upgrading the plan.')}</p>
        <p><Link to="/panel">{t('panel.shell.back_to_dashboard', 'Back to the dashboard')}</Link></p>
      </EmptyState>
    </Card>
  );
}

// Every function in panel/nav.js routes here until its page exists under pages/panel/.
export function PanelFunctionPage({ fn }) {
  const { t } = useT();
  return (
    <PanelPage fn={fn}>
      <Card>
        <EmptyState icon={Hammer} title={t('panel.shell.placeholder_title', 'This screen is on its way')}>
          <p>{t(`panel.${panelId(fn)}.description`, fn.description)}</p>
          <p className="muted">{t('panel.shell.placeholder_text', 'It is already in the navigation and search; its interface lands with the next panel build.')}</p>
          <p><Link to="/panel">{t('panel.shell.back_to_dashboard', 'Back to the dashboard')}</Link></p>
        </EmptyState>
      </Card>
    </PanelPage>
  );
}

export function PanelNotFoundPage() {
  const { t } = useT();
  return (
    <PanelPage title={t('panel.shell.not_found_title', 'Page not found')}>
      <Card><EmptyState title={t('panel.shell.not_found_heading', 'Nothing is at this address')}><p>{t('panel.shell.not_found_text', 'Check the link, or use the search above to find what you were looking for.')}</p><p><Link to="/panel">{t('panel.shell.back_to_dashboard', 'Back to the dashboard')}</Link></p></EmptyState></Card>
    </PanelPage>
  );
}
