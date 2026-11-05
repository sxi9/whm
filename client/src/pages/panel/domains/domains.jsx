import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelMe } from '../../../panel/hooks/usePanel.js';
import { useT } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { useDomains, typeLabel, isParked, allowedText, VhostPill, SslPill, DocrootCode } from './parts/shared.jsx';

const FILTERS = [['all', 'All'], ['main', 'Main'], ['addon', 'Addon'], ['sub', 'Subdomains'], ['parked', 'Parked']];
const PAGE_OF = { addon: '/panel/domains/addon-domains', sub: '/panel/domains/subdomains', parked: '/panel/domains/parked-domains', alias: '/panel/domains/parked-domains' };

export { allowedText };

export function filterDomains(rows, filter, q) {
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => (filter === 'all' || (filter === 'parked' ? isParked(r) : r.type === filter)) && (!needle || r.domain.includes(needle) || (r.docroot || '').toLowerCase().includes(needle)));
}

export default function Domains({ fn }) {
  const { t } = useT();
  const { me, hasFeature } = usePanelMe();
  const navigate = useNavigate();
  const { rows, counts, limits, error, loading, refetch } = useDomains();
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const homeDir = me?.account?.homeDir;
  const visible = useMemo(() => filterDomains(rows, filter, q), [rows, filter, q]);
  const can = (key) => !hasFeature || hasFeature(key);
  const manageLabel = { addon: t('panel.domains.manage_addons', 'Manage addon domains'), sub: t('panel.domains.manage_subdomains', 'Manage subdomains'), parked: t('panel.domains.manage_parked', 'Manage parked domains'), alias: t('panel.domains.manage_parked', 'Manage parked domains') };

  const columns = [
    { key: 'domain', label: t('panel.domains.col_domain', 'Domain'), render: (r) => <><strong>{r.domain}</strong>{isParked(r) && <div className="muted" style={{ fontSize: 12.5 }}>{fill(t('panel.domains.shows_target', 'Shows {domain}'), { domain: me?.account?.domain })}</div>}</> },
    { key: 'type', label: t('panel.domains.col_type', 'Type'), render: (r) => <StatusPill status={r.type === 'main' ? 'ok' : 'info'}>{typeLabel(r.type)}</StatusPill> },
    { key: 'docroot', label: t('panel.domains.col_docroot', 'Document root'), render: (r) => <DocrootCode docroot={r.docroot} homeDir={homeDir} /> },
    { key: 'vhost', label: t('panel.domains.col_web_server', 'Web server'), render: (r) => <VhostPill vhost={r.vhost} /> },
    { key: 'ssl', label: t('panel.domains.col_ssl', 'SSL'), render: (r) => <SslPill ssl={r.ssl} /> },
    { key: 'phpVersion', label: t('panel.domains.col_php', 'PHP'), render: (r) => r.phpVersion || <span className="muted">{t('panel.domains.php_default', 'Default')}</span> },
    { key: 'createdAt', label: t('panel.domains.col_added', 'Added'), render: (r) => formatDate(r.createdAt) },
  ];

  return (
    <PanelPage fn={fn} actions={(
      <>
        {can('addondomains') && <Link className="btn" to="/panel/domains/addon-domains"><Plus size={16} /> {t('panel.domains.addon_domain', 'Addon domain')}</Link>}
        {can('subdomains') && <Link className="btn" to="/panel/domains/subdomains"><Plus size={16} /> {t('panel.domains.subdomain', 'Subdomain')}</Link>}
        {can('parkeddomains') && <Link className="btn" to="/panel/domains/parked-domains"><Plus size={16} /> {t('panel.domains.parked_domain', 'Parked domain')}</Link>}
      </>
    )}>
      {counts && (
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <div className="stat"><div className="label">{t('panel.domains.addon_domains', 'Addon domains')}</div><div className="value">{counts.addon}</div><div className="muted">{allowedText(limits?.max_addons)}</div></div>
          <div className="stat"><div className="label">{t('panel.domains.subdomains', 'Subdomains')}</div><div className="value">{counts.sub}</div><div className="muted">{allowedText(limits?.max_subdomains)}</div></div>
          <div className="stat"><div className="label">{t('panel.domains.parked_domains', 'Parked domains')}</div><div className="value">{counts.parked}</div><div className="muted">{allowedText(limits?.max_parked)}</div></div>
        </div>
      )}
      <Card title={t('panel.domains.list_title', 'Domains on this account')} subtitle={`${me?.account?.domain ? `${fill(t('panel.domains.is_main', '{domain} is the main domain.'), { domain: me.account.domain })} ` : ''}${t('panel.domains.list_help', 'Where each name is served from, and whether the web server and SSL are in place.')}`} padded={false}>
        <PanelCapabilityState error={error} onRetry={refetch} />
        <div id="panel-domains-list" role="tabpanel" aria-labelledby={`panel-domains-tab-${filter}`}>
        <DataTable
          columns={columns} rows={visible} loading={loading} error={error && error.status !== 501 ? error : null}
          emptyText={q || filter !== 'all' ? t('panel.domains.empty_filter', 'No domains match this filter') : t('panel.domains.empty', 'Your main domain appears here once the account is provisioned')}
          searchable q={q} onSearch={setQ} searchPlaceholder={t('panel.domains.search', 'Search domains…')}
          toolbar={(
            <div className="segmented" role="tablist" aria-label={t('panel.domains.filter_label', 'Filter by type')}>
              {FILTERS.map(([key, label]) => <button key={key} id={`panel-domains-tab-${key}`} type="button" role="tab" aria-selected={filter === key} aria-controls="panel-domains-list" tabIndex={filter === key ? 0 : -1} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)} onKeyDown={(e) => { const i = FILTERS.findIndex(([k]) => k === key); const next = e.key === 'ArrowRight' ? FILTERS[(i + 1) % FILTERS.length] : e.key === 'ArrowLeft' ? FILTERS[(i - 1 + FILTERS.length) % FILTERS.length] : null; if (next) { e.preventDefault(); setFilter(next[0]); document.getElementById(`panel-domains-tab-${next[0]}`)?.focus(); } }}>{t(`panel.domains.filter_${key}`, label)}</button>)}
            </div>
          )}
          rowKey={(r) => r.domain}
          rowActions={(r) => [
            { label: t('panel.domains.dns_records', 'DNS records'), primary: true, onClick: () => navigate(`/panel/dns/zone-editor?zone=${encodeURIComponent(r.domain)}`) },
            can('redirects') && { label: t('panel.domains.redirect', 'Redirect'), onClick: () => navigate(`/panel/domains/redirects?domain=${encodeURIComponent(r.domain)}`) },
            PAGE_OF[r.type] && { label: manageLabel[r.type], onClick: () => navigate(PAGE_OF[r.type]) },
          ]}
        />
        </div>
      </Card>
    </PanelPage>
  );
}
