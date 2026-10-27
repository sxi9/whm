import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Select } from '../../components/Form.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { Stat, StatGrid, FormModal, SecretOnce } from '../../widgets/index.jsx';

// Trial funnel + abuse view: the list joins trials with their license; the
// same ip / email_hash appearing more than once is the key-sharing signal.
export default function Trials() {
  const [converted, setConverted] = useState('');
  const list = useListQuery('/admin/trials', { filters: { converted } });
  // The trials route also returns a top-level `funnel`; the dashboard report carries the same numbers through { data }.
  const summary = useApi('/admin/reports/dashboard');
  const f = summary.data?.trial_funnel || {};
  const products = useApi('/admin/products');
  const [convert, setConvert] = useState(null);
  const [converted1, setConverted1] = useState(null);
  const rows = list.rows;
  const ipCounts = rows.reduce((m, r) => { m[r.ip] = (m[r.ip] || 0) + 1; return m; }, {});
  const emailCounts = rows.reduce((m, r) => { m[r.email_hash] = (m[r.email_hash] || 0) + 1; return m; }, {});
  const columns = [
    { key: 'key_prefix', label: 'Trial key', render: (r) => <Link to={`/admin/licenses/${r.license_id}`}><code>{r.key_prefix}-…</code></Link> },
    { key: 'license_status', label: 'Status', render: (r) => <StatusPill status={r.license_status} /> },
    { key: 'started_at', label: 'Started', sortable: true, render: (r) => formatDate(r.started_at) },
    { key: 'expires_at', label: 'Expires', render: (r) => formatDate(r.expires_at) },
    { key: 'converted_at', label: 'Converted', render: (r) => (r.converted_at ? <Link to={`/admin/licenses/${r.converted_license_id}`}>{formatDate(r.converted_at)}</Link> : <span className="muted">no</span>) },
    { key: 'ip', label: 'IP', render: (r) => <>{r.ip} {ipCounts[r.ip] > 1 && <span className="pill pill-warn">×{ipCounts[r.ip]}</span>}</> },
    { key: 'email_hash', label: 'E-mail hash', render: (r) => <>{String(r.email_hash || '').slice(0, 12)}… {emailCounts[r.email_hash] > 1 && <span className="pill pill-warn">×{emailCounts[r.email_hash]}</span>}</> },
  ];
  return (
    <>
      <PageHeader title="Trials" description="Funnel and abuse view. One trial per fingerprint and per e-mail." home="/admin" />
      <StatGrid>
        <Stat label="Started" value={f.started} /><Stat label="Converted" value={f.converted} /><Stat label="Expired" value={f.expired} /><Stat label="Active" value={f.active} />
      </StatGrid>
      <Card padded={false}>
        <div className="filter-row" style={{ padding: '12px 16px 0' }}><Select value={converted} onChange={setConverted} options={[{ value: 'true', label: 'Converted' }, { value: 'false', label: 'Not converted' }]} placeholder="All trials" /></div>
        <DataTable columns={columns} {...list.tableProps} emptyText="No trials" rowActions={(r) => [!r.converted_at && { label: 'Convert', primary: true, onClick: () => setConvert(r) }]} />
      </Card>
      <FormModal open={Boolean(convert)} title="Convert trial to a paid license" fields={[{ key: 'sku', label: 'Product', type: 'select', options: (products.data || []).filter((p) => p.edition !== 'trial').map((p) => ({ value: p.sku, label: `${p.name} (${p.edition})` })), required: true }, { key: 'term_months', label: 'Term (months)', type: 'number', min: 1, max: 120 }]} onClose={() => setConvert(null)} submitLabel="Convert"
        onSubmit={async (d) => { const { data } = await api.post(`/admin/trials/${convert.id}/convert`, { sku: d.sku, ...(d.term_months ? { term_months: Number(d.term_months) } : {}) }); setConverted1(data); list.refetch(); }} />
      {converted1 && <Card title="Converted"><SecretOnce label={`License ${converted1.license_id}`} value={converted1.key}>The activation carries over; the panel receives the new edition at its next check-in without re-entering a key.</SecretOnce></Card>}
    </>
  );
}
