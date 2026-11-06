import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Star, Search, ExternalLink, RefreshCw, ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useCollapsedSections } from '../hooks/useCollapsedSections.js';
import { Card, StatusPill, Loading, formatMb, formatDate } from '../components/Common.jsx';
import { ErrorBanner } from '../components/Form.jsx';
import { useT } from '../i18n/useT.js';
import { fill, untranslated } from '../i18n/fill.js';
import { PANEL_BASE, PANEL_FUNCTION_BY_KEY, panelId, searchPanelFunctions, visibleCategories } from './nav.js';
import { panelIconFor, panelColorFor } from './icons.js';
import { percentOf, usePanelApi, usePanelFavorites, usePanelMe } from './hooks/usePanel.js';
import { usePanelPlugins, withPluginEntries, searchPluginEntries } from './hooks/usePanelPlugins.js';
import { Meter, siteUrl } from './Meter.jsx';

const SECTIONS_KEY = 'keel.panel.home.sections';
const FAVORITES_KEY = '__favorites';

const GREETINGS = { good_night: 'Good night', good_morning: 'Good morning', good_afternoon: 'Good afternoon', good_evening: 'Good evening' };

export function greetingKeyFor(hour) {
  return hour < 5 ? 'good_night' : hour < 12 ? 'good_morning' : hour < 18 ? 'good_afternoon' : 'good_evening';
}

const METER_LABELS = { disk: 'Disk', bandwidth: 'Bandwidth this month', mailboxes: 'Mailboxes', databases: 'Databases', addons: 'Addon domains', subdomains: 'Subdomains', ftp: 'FTP accounts' };

// Usage meters from /me (always present) refined by /usage (object limits, inodes).
export function usageMeters(me, usage, t = untranslated) {
  const u = me?.usage || {};
  const counts = usage?.counts || me?.counts || {};
  const limits = usage?.limits || me?.account?.limits || {};
  // Server convention (assertLimit): null is unlimited, 0 means the plan does not include the object.
  const unlimited = (v) => v == null;
  const row = (key, used, limit, format = (v) => (v == null ? '—' : String(v))) => ({
    key, label: t(`panel.home.meter_${key}`, METER_LABELS[key]), used, limit: unlimited(limit) ? null : limit, percent: unlimited(limit) || limit === 0 ? null : percentOf(used, limit),
    text: unlimited(limit) ? fill(t('panel.home.meter_unlimited', '{used} · unlimited'), { used: format(used) }) : limit === 0 ? t('panel.shell.feature_disabled_title', 'Not included in your plan') : fill(t('panel.home.meter_of', '{used} of {limit}'), { used: format(used), limit: format(limit) }),
  });
  return [
    row('disk', usage?.disk?.usedMb ?? u.diskUsedMb ?? 0, usage?.disk?.quotaMb ?? u.diskQuotaMb, formatMb),
    row('bandwidth', usage?.bandwidth?.usedMb ?? u.bandwidthUsedMb ?? 0, usage?.bandwidth?.limitMb ?? u.bandwidthLimitMb, formatMb),
    row('mailboxes', counts.mailboxes, limits.max_email),
    row('databases', counts.databases, limits.max_sql),
    row('addons', counts.addons, limits.max_addons),
    row('subdomains', counts.subdomains, limits.max_subdomains),
    row('ftp', counts.ftp, limits.max_ftp),
  ].filter((m) => m.used != null);
}

export function UsageMeters({ me, usage }) {
  const { t } = useT();
  const meters = usageMeters(me, usage, t);
  return (
    <div className="stat-grid panel-meters">
      {meters.map((m) => (
        <div className="stat" key={m.key} data-meter={m.key}>
          <div className="label">{m.label}</div>
          <div className="value" style={{ fontSize: 17 }}>{m.text}</div>
          <Meter percent={m.percent} label={m.label} text={m.text} name={m.key} />
        </div>
      ))}
    </div>
  );
}

// `ssl` maps a domain to its `ssl` entry from GET /api/panel/domains: a live
// certificate turns the site link into https.
export function DomainsList({ account, ssl = {} }) {
  const { t } = useT();
  const domains = account?.domains || [];
  const main = account?.domain;
  const rows = [main && !domains.some((d) => d.domain === main && d.type === 'main') ? { domain: main, type: 'main', docroot: null } : null, ...domains].filter(Boolean);
  if (!rows.length) return <p className="muted">{t('panel.home.no_domains', 'No domains on this account yet.')}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>{t('panel.home.col_domain', 'Domain')}</th><th>{t('panel.home.col_type', 'Type')}</th><th>{t('panel.home.col_docroot', 'Document root')}</th></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={`${d.type}:${d.domain}`}>
              <td><a href={siteUrl(d.domain, ssl[d.domain])} target="_blank" rel="noopener noreferrer">{d.domain} <ExternalLink size={12} aria-hidden="true" /></a></td>
              <td><StatusPill status={d.type === 'main' ? 'ok' : 'info'}>{t(`panel.home.domain_type_${d.type}`, d.type)}</StatusPill></td>
              <td className="muted">{d.docroot || (d.type === 'main' ? `${account?.homeDir || ''}/public_html` : '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolCard({ fn, favorite, onToggle, label, description }) {
  const { t } = useT();
  return (
    <div className="tool-card">
      <Link to={fn.path} className="tool-link">
        <strong>{label}</strong>
        <small>{description}</small>
      </Link>
      <button className={`icon-button favorite ${favorite ? 'active' : ''}`} onClick={onToggle} aria-label={favorite ? t('panel.home.unpin', 'Unpin') : t('panel.home.pin', 'Pin to favorites')}>
        <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}

// Quick links: the operator's app shortcuts, news and webmail (GET /overview/quick-links;
// webmailUrl there is the operator's setting or the webmail published under the hostname site).
export function QuickLinks({ links, webmailUrl = null }) {
  const { t } = useT();
  const apps = links?.apps || [];
  const news = links?.news || [];
  const webmail = links?.webmailUrl || webmailUrl;
  if (!apps.length && !news.length && !webmail) return null;
  return (
    <>
      {news.map((n, i) => (
        <div key={n.id || i} className="banner banner-info"><div><strong>{n.title || n.subject || t('panel.home.news', 'News')}</strong>{(n.body || n.text) && <p>{n.body || n.text}</p>}</div></div>
      ))}
      {(apps.length > 0 || webmail) && (
        <ul className="list-plain row-actions quick-links">
          {webmail && <li><a className="btn btn-sm" href={webmail} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> {t('panel.email/webmail.label', 'Webmail')}</a></li>}
          {apps.map((a, i) => <li key={a.id || a.name || i}><a className="btn btn-sm" href={a.url || a.href} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> {a.displayname || a.label || a.name}</a></li>)}
        </ul>
      )}
    </>
  );
}

// The /panel index: large-title greeting, usage meters, domains, quick links and
// the tool grid of every group the plan includes. pages/panel/overview/dashboard.jsx
// renders the same body under a regular page header.
export function PanelHome({ header = null }) {
  const { user } = useAuth();
  const { me, hasFeature } = usePanelMe();
  const { t } = useT();
  const usageReq = usePanelApi('/usage');
  const linksReq = usePanelApi('/overview/quick-links');
  const domainsReq = usePanelApi('/domains');
  const sslByDomain = useMemo(() => Object.fromEntries((Array.isArray(domainsReq.data) ? domainsReq.data : []).map((d) => [d.domain, d.ssl || null])), [domainsReq.data]);
  const { favorites, toggle } = usePanelFavorites();
  const sections = useCollapsedSections(SECTIONS_KEY);
  const [q, setQ] = useState('');
  const features = me?.account?.features;
  const { entries: pluginEntries } = usePanelPlugins();
  const categories = useMemo(() => withPluginEntries(visibleCategories(features), pluginEntries), [features, pluginEntries]);
  const matches = useMemo(() => (q.trim() ? new Set([...searchPanelFunctions(q, features), ...searchPluginEntries(pluginEntries, q)].map((f) => f.key)) : null), [q, features, pluginEntries]);
  const favoriteFns = favorites.map((k) => PANEL_FUNCTION_BY_KEY[k] || pluginEntries.find((e) => e.key === k)).filter(Boolean);
  const account = me?.account;
  const label = (fn) => t(`panel.${panelId(fn)}.label`, fn.label);
  const description = (fn) => t(`panel.${panelId(fn)}.description`, fn.description);
  const greetingKey = greetingKeyFor(new Date().getHours());
  const greeting = t(`panel.home.${greetingKey}`, GREETINGS[greetingKey]);
  const favoritesOpen = sections.isOpen(FAVORITES_KEY);
  const slugs = categories.map((c) => c.slug);

  return (
    <div className="panel-home">
      {header ?? (
      <div className="home-hero">
        <div>
          <h1>{greeting}, {account?.username || user?.username}</h1>
          <p className="muted">{account ? [account.domain, account.package && fill(t('panel.home.plan_name', '{package} plan'), { package: account.package }), me.hostname && fill(t('panel.home.on_host', 'on {hostname}'), { hostname: me.hostname })].filter(Boolean).join(' · ') : t('common.loading', 'Loading…')}</p>
        </div>
        <div className="page-header-actions">
          <Link className="btn btn-sm" to={`${PANEL_BASE}/overview/account`}>{t('panel.overview/account.label', 'Account details')}</Link>
        </div>
      </div>
      )}

      <QuickLinks links={linksReq.data} />

      <div className="home">
        <div className="home-main">
          <Card title={t('panel.home.usage', 'Usage')} subtitle={usageReq.data?.disk?.lastRefresh ? fill(t('panel.home.disk_measured', 'Disk measured {date}'), { date: formatDate(usageReq.data.disk.lastRefresh) }) : undefined}
            actions={<Link className="link-button" to={`${PANEL_BASE}/usage/usage`}><RefreshCw size={14} /> {t('panel.home.details', 'Details')}</Link>}>
            <ErrorBanner error={usageReq.error && usageReq.error.status !== 501 ? usageReq.error : null} onRetry={usageReq.refetch} />
            {me ? <UsageMeters me={me} usage={usageReq.data} /> : <Loading text={t('common.loading', 'Loading…')} />}
          </Card>

          {favoriteFns.length > 0 && !matches && (
            <Card title={t('panel.shell.favorites', 'Favorites')} subtitle={t('panel.home.pinned', 'Your pinned tools')} className={favoritesOpen ? '' : 'collapsed'} actions={(
              <button type="button" className="icon-button section-toggle" onClick={() => sections.toggle(FAVORITES_KEY)} aria-expanded={favoritesOpen} aria-controls="panel-tools-favorites" aria-label={favoritesOpen ? t('panel.home.collapse_section', 'Collapse section') : t('panel.home.expand_section', 'Expand section')}>
                <ChevronDown size={16} />
              </button>
            )}>
              <div id="panel-tools-favorites" className="tool-grid" hidden={!favoritesOpen}>
                {favoritesOpen && favoriteFns.map((f) => <ToolCard key={f.key} fn={f} favorite onToggle={() => toggle(f.key)} label={label(f)} description={description(f)} />)}
              </div>
            </Card>
          )}

          <Card title={t('panel.shell.tools', 'Tools')} actions={(
            <>
              <button type="button" className="link-button" onClick={() => sections.expandAll(slugs)}><ChevronsUpDown size={14} /> {t('panel.home.expand_all', 'Expand all')}</button>
              <button type="button" className="link-button" onClick={() => sections.collapseAll(slugs)}><ChevronsDownUp size={14} /> {t('panel.home.collapse_all', 'Collapse all')}</button>
              <div className="search inline">
                <Search size={16} />
                <input className="input" placeholder={t('panel.home.filter_tools', 'Filter tools…')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('panel.home.filter_tools', 'Filter tools…')} />
              </div>
            </>
          )}>
            {categories.map((cat) => {
              const fns = matches ? cat.functions.filter((f) => matches.has(f.key)) : cat.functions;
              if (!fns.length) return null;
              const Icon = panelIconFor(cat.icon);
              // A filter keeps every matching group open so hits are never hidden.
              const open = matches ? true : sections.isOpen(cat.slug);
              const gridId = `panel-tools-${cat.slug}`;
              return (
                <section key={cat.slug} className={`tool-section ${open ? '' : 'collapsed'}`} data-group={cat.slug}>
                  <h3>
                    <button type="button" className="tool-section-head" onClick={() => sections.toggle(cat.slug)} aria-expanded={open} aria-controls={gridId} disabled={Boolean(matches)}>
                      <ChevronDown size={16} aria-hidden="true" />
                      <span className="nav-tile" style={{ '--tile': panelColorFor(cat.slug) }}><Icon size={14} strokeWidth={2.25} /></span>
                      <span>{t(`panel-category.${cat.slug}`, cat.label)}</span>
                      <span className="count">{fns.length}</span>
                    </button>
                  </h3>
                  <div id={gridId} className="tool-grid" hidden={!open}>
                    {open && fns.map((f) => <ToolCard key={f.key} fn={f} favorite={favorites.includes(f.key)} onToggle={() => toggle(f.key)} label={label(f)} description={description(f)} />)}
                  </div>
                </section>
              );
            })}
            {matches && matches.size === 0 && <p className="muted">{t('panel.shell.no_matches', 'Nothing matches')} “{q}”.</p>}
          </Card>
        </div>

        <aside className="home-side">
          <Card title={t('panel.home.domains', 'Domains')} actions={hasFeature('addondomains') ? <Link className="link-button" to={`${PANEL_BASE}/domains/domains`}>{t('panel.home.manage', 'Manage')}</Link> : null} padded={false}>
            <DomainsList account={account} ssl={sslByDomain} />
          </Card>
          <Card title={t('panel.home.account', 'Account')}>
            <dl className="kv">
              <div><dt>{t('panel.account.username', 'Username')}</dt><dd>{account?.username}</dd></div>
              <div><dt>{t('panel.account.main_domain', 'Main domain')}</dt><dd>{account?.domain}</dd></div>
              <div><dt>{t('panel.account.ip', 'IP address')}</dt><dd>{account?.ip || '—'}</dd></div>
              <div><dt>{t('panel.account.package', 'Plan')}</dt><dd>{account?.package || '—'}</dd></div>
              <div><dt>{t('panel.account.server', 'Server')}</dt><dd>{me?.hostname || '—'}</dd></div>
              <div><dt>{t('panel.account.status', 'Status')}</dt><dd><StatusPill status={account?.suspended ? 'suspended' : 'active'}>{account?.suspended ? t('panel.home.status_suspended', 'suspended') : t('panel.home.status_active', 'active')}</StatusPill></dd></div>
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}
