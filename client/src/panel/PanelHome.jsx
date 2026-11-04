import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Star, Search, ExternalLink, RefreshCw } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { Card, StatusPill, Loading, formatMb, formatDate } from '../components/Common.jsx';
import { ErrorBanner } from '../components/Form.jsx';
import { useT } from '../i18n/useT.js';
import { PANEL_BASE, PANEL_FUNCTION_BY_KEY, panelId, searchPanelFunctions, visibleCategories } from './nav.js';
import { panelIconFor, panelColorFor } from './icons.js';
import { meterTone, percentOf, usePanelApi, usePanelFavorites, usePanelMe } from './hooks/usePanel.js';

function greetingFor(hour) {
  return hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

// Usage meters from /me (always present) refined by /usage (object limits, inodes).
export function usageMeters(me, usage) {
  const u = me?.usage || {};
  const counts = usage?.counts || me?.counts || {};
  const limits = usage?.limits || me?.account?.limits || {};
  // Server convention (assertLimit): null is unlimited, 0 means the plan does not include the object.
  const unlimited = (v) => v == null;
  const row = (key, label, used, limit, format = (v) => (v == null ? '—' : String(v))) => ({
    key, label, used, limit: unlimited(limit) ? null : limit, percent: unlimited(limit) || limit === 0 ? null : percentOf(used, limit),
    text: unlimited(limit) ? `${format(used)} · unlimited` : limit === 0 ? 'Not included in your plan' : `${format(used)} of ${format(limit)}`,
  });
  return [
    row('disk', 'Disk', usage?.disk?.usedMb ?? u.diskUsedMb ?? 0, usage?.disk?.quotaMb ?? u.diskQuotaMb, formatMb),
    row('bandwidth', 'Bandwidth this month', usage?.bandwidth?.usedMb ?? u.bandwidthUsedMb ?? 0, usage?.bandwidth?.limitMb ?? u.bandwidthLimitMb, formatMb),
    row('mailboxes', 'Mailboxes', counts.mailboxes, limits.max_email),
    row('databases', 'Databases', counts.databases, limits.max_sql),
    row('addons', 'Addon domains', counts.addons, limits.max_addons),
    row('subdomains', 'Subdomains', counts.subdomains, limits.max_subdomains),
    row('ftp', 'FTP accounts', counts.ftp, limits.max_ftp),
  ].filter((m) => m.used != null);
}

export function UsageMeters({ me, usage }) {
  const meters = usageMeters(me, usage);
  return (
    <div className="stat-grid panel-meters">
      {meters.map((m) => (
        <div className="stat" key={m.key} data-meter={m.key}>
          <div className="label">{m.label}</div>
          <div className="value" style={{ fontSize: 17 }}>{m.text}</div>
          <div className={`meter ${meterTone(m.percent)}`} aria-hidden={m.percent == null}><span style={{ width: `${m.percent ?? 0}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export function DomainsList({ account }) {
  const domains = account?.domains || [];
  const main = account?.domain;
  const rows = [main && !domains.some((d) => d.domain === main && d.type === 'main') ? { domain: main, type: 'main', docroot: null } : null, ...domains].filter(Boolean);
  if (!rows.length) return <p className="muted">No domains on this account yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Domain</th><th>Type</th><th>Document root</th></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={`${d.type}:${d.domain}`}>
              <td><a href={`http://${d.domain}`} target="_blank" rel="noopener noreferrer">{d.domain} <ExternalLink size={12} /></a></td>
              <td><StatusPill status={d.type === 'main' ? 'ok' : 'info'}>{d.type}</StatusPill></td>
              <td className="muted">{d.docroot || (d.type === 'main' ? `${account?.homeDir || ''}/public_html` : '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolCard({ fn, favorite, onToggle, label, description }) {
  return (
    <div className="tool-card">
      <Link to={fn.path} className="tool-link">
        <strong>{label}</strong>
        <small>{description}</small>
      </Link>
      <button className={`icon-button favorite ${favorite ? 'active' : ''}`} onClick={onToggle} aria-label={favorite ? 'Unpin' : 'Pin to favorites'}>
        <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}

// Quick links: the operator's app shortcuts, news and webmail (GET /overview/quick-links;
// webmailUrl there is the operator's setting or the webmail published under the hostname site).
export function QuickLinks({ links, webmailUrl = null }) {
  const apps = links?.apps || [];
  const news = links?.news || [];
  const webmail = links?.webmailUrl || webmailUrl;
  if (!apps.length && !news.length && !webmail) return null;
  return (
    <>
      {news.map((n, i) => (
        <div key={n.id || i} className="banner banner-info"><div><strong>{n.title || n.subject || 'News'}</strong>{(n.body || n.text) && <p>{n.body || n.text}</p>}</div></div>
      ))}
      {(apps.length > 0 || webmail) && (
        <ul className="list-plain row-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
          {webmail && <li><a className="btn btn-sm" href={webmail} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> Webmail</a></li>}
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
  const { favorites, toggle } = usePanelFavorites();
  const [q, setQ] = useState('');
  const features = me?.account?.features;
  const categories = useMemo(() => visibleCategories(features), [features]);
  const matches = useMemo(() => (q.trim() ? new Set(searchPanelFunctions(q, features).map((f) => f.key)) : null), [q, features]);
  const favoriteFns = favorites.map((k) => PANEL_FUNCTION_BY_KEY[k]).filter(Boolean);
  const account = me?.account;
  const label = (fn) => t(`panel.${panelId(fn)}.label`, fn.label);
  const description = (fn) => t(`panel.${panelId(fn)}.description`, fn.description);
  const greeting = t(`panel.home.${greetingFor(new Date().getHours()).toLowerCase().replace(' ', '_')}`, greetingFor(new Date().getHours()));

  return (
    <div className="panel-home">
      {header ?? (
      <div className="home-hero">
        <div>
          <h1>{greeting}, {account?.username || user?.username}</h1>
          <p className="muted">{account ? [account.domain, account.package && `${account.package} plan`, me.hostname && `on ${me.hostname}`].filter(Boolean).join(' · ') : t('common.loading', 'Loading…')}</p>
        </div>
        <div className="page-header-actions">
          <Link className="btn btn-sm" to={`${PANEL_BASE}/overview/account`}>{t('panel.overview/account.label', 'Account details')}</Link>
        </div>
      </div>
      )}

      <QuickLinks links={linksReq.data} />

      <div className="home">
        <div className="home-main">
          <Card title={t('panel.home.usage', 'Usage')} subtitle={usageReq.data?.disk?.lastRefresh ? `Disk measured ${formatDate(usageReq.data.disk.lastRefresh)}` : undefined}
            actions={<Link className="link-button" to={`${PANEL_BASE}/usage/usage`}><RefreshCw size={14} /> {t('panel.home.details', 'Details')}</Link>}>
            <ErrorBanner error={usageReq.error && usageReq.error.status !== 501 ? usageReq.error : null} onRetry={usageReq.refetch} />
            {me ? <UsageMeters me={me} usage={usageReq.data} /> : <Loading />}
          </Card>

          {favoriteFns.length > 0 && !matches && (
            <Card title={t('panel.shell.favorites', 'Favorites')} subtitle={t('panel.home.pinned', 'Your pinned tools')}>
              <div className="tool-grid">
                {favoriteFns.map((f) => <ToolCard key={f.key} fn={f} favorite onToggle={() => toggle(f.key)} label={label(f)} description={description(f)} />)}
              </div>
            </Card>
          )}

          <Card title={t('panel.shell.tools', 'Tools')} actions={(
            <div className="search inline">
              <Search size={16} />
              <input className="input" placeholder={t('panel.home.filter_tools', 'Filter tools…')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('panel.home.filter_tools', 'Filter tools…')} />
            </div>
          )}>
            {categories.map((cat) => {
              const fns = matches ? cat.functions.filter((f) => matches.has(f.key)) : cat.functions;
              if (!fns.length) return null;
              const Icon = panelIconFor(cat.icon);
              return (
                <section key={cat.slug} className="tool-section" data-group={cat.slug}>
                  <h3><span className="nav-tile" style={{ '--tile': panelColorFor(cat.slug) }}><Icon size={14} strokeWidth={2.25} /></span> {t(`panel-category.${cat.slug}`, cat.label)} <span className="count">{fns.length}</span></h3>
                  <div className="tool-grid">
                    {fns.map((f) => <ToolCard key={f.key} fn={f} favorite={favorites.includes(f.key)} onToggle={() => toggle(f.key)} label={label(f)} description={description(f)} />)}
                  </div>
                </section>
              );
            })}
            {matches && matches.size === 0 && <p className="muted">{t('panel.shell.no_matches', 'Nothing matches')} “{q}”.</p>}
          </Card>
        </div>

        <aside className="home-side">
          <Card title={t('panel.home.domains', 'Domains')} actions={hasFeature('addondomains') ? <Link className="link-button" to={`${PANEL_BASE}/domains/domains`}>{t('panel.home.manage', 'Manage')}</Link> : null} padded={false}>
            <DomainsList account={account} />
          </Card>
          <Card title={t('panel.home.account', 'Account')}>
            <dl className="kv">
              <div><dt>{t('panel.account.username', 'Username')}</dt><dd>{account?.username}</dd></div>
              <div><dt>{t('panel.account.main_domain', 'Main domain')}</dt><dd>{account?.domain}</dd></div>
              <div><dt>{t('panel.account.ip', 'IP address')}</dt><dd>{account?.ip || '—'}</dd></div>
              <div><dt>{t('panel.account.package', 'Plan')}</dt><dd>{account?.package || '—'}</dd></div>
              <div><dt>{t('panel.account.server', 'Server')}</dt><dd>{me?.hostname || '—'}</dd></div>
              <div><dt>{t('panel.account.status', 'Status')}</dt><dd><StatusPill status={account?.suspended ? 'suspended' : 'active'} /></dd></div>
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}
