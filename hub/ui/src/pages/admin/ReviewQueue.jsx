import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Select } from '../../components/Form.jsx';
import { useListQuery } from '../../hooks/useListQuery.js';

// Open reviews of versions in_review; high-risk ones need two reviewers when
// review.require_two_reviewers_for_high_risk is set (§18.3).
export default function ReviewQueue() {
  const navigate = useNavigate();
  const [risk, setRisk] = useState('');
  const list = useListQuery('/admin/market/reviews', { filters: { risk } });
  const columns = [
    { key: 'name', label: 'Plugin', render: (r) => <Link to={`/admin/market/reviews/${r.id}`}><strong>{r.name}</strong> <code>{r.plugin_id}</code></Link> },
    { key: 'version', label: 'Version', render: (r) => <>{r.version} <span className="pill pill-muted">{r.channel}</span></> },
    { key: 'risk', label: 'Risk', sortable: true, render: (r) => <StatusPill status={r.risk === 'high' ? 'high' : 'normal'}>{r.risk}</StatusPill> },
    { key: 'flags', label: 'Scan flags', render: (r) => (r.flags ? <span className="pill pill-warn">{r.flags}</span> : <span className="muted">0</span>) },
    { key: 'approvals', label: 'Approvals', render: (r) => `${r.approvals || 0}${r.risk === 'high' ? ' / 2' : ' / 1'}` },
    { key: 'developer_name', label: 'Developer', render: (r) => <>{r.developer_name} <StatusPill status={r.developer_status} /></> },
    { key: 'created_at', label: 'Submitted', sortable: true, render: (r) => formatDate(r.created_at) },
  ];
  return (
    <>
      <PageHeader title="Plugin review queue" description="Scan report, diff since the last published version, permissions with justifications. Approving signs the package with the active plugin key." home="/admin"
        actions={<Select value={risk} onChange={setRisk} options={['normal', 'high']} placeholder="Any risk" />} />
      <Card padded={false}>
        <DataTable columns={columns} {...list.tableProps} emptyText="Nothing waiting for review" rowActions={(r) => [{ label: 'Review', primary: true, onClick: () => navigate(`/admin/market/reviews/${r.id}`) }]} />
      </Card>
    </>
  );
}
