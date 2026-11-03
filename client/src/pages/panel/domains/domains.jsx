import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelMe } from '../../../panel/hooks/usePanel.js';
import { useDomains, typeLabel, isParked, VhostPill, SslPill, DocrootCode } from './parts/shared.jsx';

const FILTERS = [['all', 'All'], ['main', 'Main'], ['addon', 'Addon'], ['sub', 'Subdomains'], ['parked', 'Parked']];
const PAGE_OF = { addon: '/panel/domains/addon-domains', sub: '/panel/domains/subdomains', parked: '/panel/domains/parked-domains', alias: '/panel/domains/parked-domains' };

export const allowedText = (limit) => (limit == null ? 'no plan limit' : `of ${limit} allowed`);

export function filterDomains(rows, filter, q) {
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => (filter === 'all' || (filter === 'parked' ? isParked(r) : r.type === filter)) && (!needle || r.domain.includes(needle) || (r.docroot || '').toLowerCase().includes(needle)));
}

export default function Domains({ fn }) {
  const { me, hasFeature } = usePanelMe();
  const navigate = useNavigate();
  const { rows, counts, limits, error, loading, refetch } = useDomains();
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const homeDir = me?.account?.homeDir;
  const visible = useMemo(() => filterDomains(rows, filter, q), [rows, filter, q]);
  const can = (key) => !hasFeature || hasFeature(key);

  const columns = [
    { key: 'domain', label: 'Domain', render: (r) => <><strong>{r.domain}</strong>{isParked(r) && <div className="muted" style={{ fontSize: 12.5 }}>Shows {me?.account?.domain}</div>}</> },
    { key: 'type', label: 'Type', render: (r) => <StatusPill status={r.type === 'main' ? 'ok' : 'info'}>{typeLabel(r.type)}</StatusPill> },
    { key: 'docroot', label: 'Document root', render: (r) => <DocrootCode docroot={r.docroot} homeDir={homeDir} /> },
    { key: 'vhost', label: 'Web server', render: (r) => <VhostPill vhost={r.vhost} /> },
    { key: 'ssl', label: 'SSL', render: (r) => <SslPill ssl={r.ssl} /> },
    { key: 'phpVersion', label: 'PHP', render: (r) => r.phpVersion || <span className="muted">Default</span> },
    { key: 'createdAt', label: 'Added', render: (r) => formatDate(r.createdAt) },
  ];

  return (
    <PanelPage fn={fn} actions={(
      <>
        {can('addondomains') && <Link className="btn" to="/panel/domains/addon-domains"><Plus size={16} /> Addon domain</Link>}
        {can('subdomains') && <Link className="btn" to="/panel/domains/subdomains"><Plus size={16} /> Subdomain</Link>}
        {can('parkeddomains') && <Link className="btn" to="/panel/domains/parked-domains"><Plus size={16} /> Parked domain</Link>}
      </>
    )}>
      {counts && (
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <div className="stat"><div className="label">Main domain</div><div className="value">{me?.account?.domain || '—'}</div></div>
          <div className="stat"><div className="label">Addon domains</div><div className="value">{counts.addon}</div><div className="muted">{allowedText(limits?.max_addons)}</div></div>
          <div className="stat"><div className="label">Subdomains</div><div className="value">{counts.sub}</div><div className="muted">{allowedText(limits?.max_subdomains)}</div></div>
          <div className="stat"><div className="label">Parked domains</div><div className="value">{counts.parked}</div><div className="muted">{allowedText(limits?.max_parked)}</div></div>
        </div>
      )}
      <Card title="Domains on this account" subtitle="Where each name is served from, and whether the web server and SSL are in place." padded={false}>
        <PanelCapabilityState error={error} onRetry={refetch} />
        <DataTable
          columns={columns} rows={visible} loading={loading} error={error && error.status !== 501 ? error : null}
          emptyText={q || filter !== 'all' ? 'No domains match this filter' : 'Your main domain appears here once the account is provisioned'}
          searchable q={q} onSearch={setQ} searchPlaceholder="Search domains…"
          toolbar={(
            <div className="segmented" role="tablist">
              {FILTERS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}
            </div>
          )}
          rowKey={(r) => r.domain}
          rowActions={(r) => [
            { label: 'DNS records', primary: true, onClick: () => navigate(`/panel/dns/zone-editor?zone=${encodeURIComponent(r.domain)}`) },
            can('redirects') && { label: 'Redirect', onClick: () => navigate(`/panel/domains/redirects?domain=${encodeURIComponent(r.domain)}`) },
            PAGE_OF[r.type] && { label: `Manage ${typeLabel(r.type).toLowerCase()}s`, onClick: () => navigate(PAGE_OF[r.type]) },
          ]}
        />
      </Card>
    </PanelPage>
  );
}
