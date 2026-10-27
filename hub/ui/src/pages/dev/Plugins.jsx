import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button } from '../../components/Form.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { FormModal } from '../../widgets/index.jsx';

export function pricingLabel(p) {
  if (!p || p.model === 'free') return 'free';
  const amount = p.cents != null ? `${(p.cents / 100).toFixed(2)} ${p.currency || ''}` : '';
  return p.model === 'subscription' ? `${amount} / ${p.interval || 'month'}${p.trial_days ? ` (${p.trial_days}-day trial)` : ''}` : `${amount} one-time`;
}

export default function Plugins() {
  const navigate = useNavigate();
  const list = useListQuery('/dev/plugins');
  const namespaces = useApi('/dev/namespaces');
  const [creating, setCreating] = useState(false);
  const ns = (namespaces.data || []).map((n) => n.ns);
  const columns = [
    { key: 'name', label: 'Plugin', sortable: true, render: (p) => <Link to={`/dev/plugins/${p.id}`}><strong>{p.name}</strong><br /><code className="small">{p.id}</code></Link> },
    { key: 'status', label: 'Listing', sortable: true, render: (p) => <StatusPill status={p.status} /> },
    { key: 'pricing', label: 'Pricing', render: (p) => pricingLabel(p.pricing) },
    { key: 'latest_stable_version', label: 'Stable / beta', render: (p) => `${p.latest_stable_version || '—'} / ${p.latest_beta_version || '—'}` },
    { key: 'install_count', label: 'Installs' },
    { key: 'rating_avg', label: 'Rating', render: (p) => (p.rating_count ? `${p.rating_avg} (${p.rating_count})` : '—') },
    { key: 'created_at', label: 'Created', sortable: true, render: (p) => formatDate(p.created_at) },
  ];
  return (
    <>
      <PageHeader title="Plugins" description="Listings you own. Ids must start with one of your claimed namespaces." home="/dev" actions={<Button variant="primary" disabled={!ns.length} onClick={() => setCreating(true)}>New listing</Button>} />
      {!ns.length && <div className="banner banner-warning"><div>Claim a namespace under <Link to="/dev/verification">Verification</Link> before creating a listing.</div></div>}
      <Card padded={false}>
        <DataTable columns={columns} {...list.tableProps} emptyText="No listings yet" rowActions={(p) => [{ label: 'Versions', primary: true, onClick: () => navigate(`/dev/plugins/${p.id}/versions`) }, { label: 'Upload', onClick: () => navigate(`/dev/plugins/${p.id}/upload`) }, { label: 'Stats', onClick: () => navigate(`/dev/plugins/${p.id}/stats`) }]} />
      </Card>
      <FormModal open={creating} title="New listing" fields={[{ key: 'id', label: 'Plugin id', required: true, help: `reverse-DNS, ≥ 3 segments, under ${ns.join(' / ')}` }, { key: 'name', label: 'Name', required: true }, { key: 'summary', label: 'Summary (≤ 200 chars)' }]} onClose={() => setCreating(false)} submitLabel="Create"
        onSubmit={async (d) => { const { data } = await api.post('/dev/plugins', { id: d.id.trim(), name: d.name, ...(d.summary ? { summary: d.summary } : {}) }); navigate(`/dev/plugins/${data.id}`); }} />
    </>
  );
}
