import { useState } from 'react';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Select, Toggle } from '../../components/Form.jsx';
import { api } from '../../api/client.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { useAction } from '../../hooks/useAction.js';

// Customer reviews stay pending until moderated; bursts from one ip_hash or
// customer are flagged (§18.4).
export default function ReviewModeration() {
  const [status, setStatus] = useState('pending');
  const [flagged, setFlagged] = useState(false);
  const list = useListQuery('/admin/market/plugin-reviews', { filters: { status, ...(flagged ? { flagged: 'true' } : {}) } });
  const { run } = useAction();
  const columns = [
    { key: 'created_at', label: 'Posted', sortable: true, render: (r) => formatDate(r.created_at) },
    { key: 'plugin_id', label: 'Plugin', render: (r) => <code>{r.plugin_id}</code> },
    { key: 'rating', label: 'Rating', sortable: true, render: (r) => `${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}` },
    { key: 'title', label: 'Review', render: (r) => <><strong>{r.title}</strong>{r.flagged ? <span className="pill pill-warn" style={{ marginLeft: 6 }}>burst flag</span> : null}<br /><span className="muted">{String(r.body || '').slice(0, 240)}</span>{r.developer_reply && <><br /><em>Developer: {r.developer_reply}</em></>}</> },
    { key: 'customer_id', label: 'Customer', render: (r) => <code className="small">{r.customer_id}</code> },
    { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
  ];
  return (
    <>
      <PageHeader title="Review moderation" description="Publish or hide customer reviews. Only non-trial licenses with a 7-day-old install may post; one review per customer per plugin." home="/admin" />
      <Card padded={false}>
        <div className="filter-row" style={{ padding: '12px 16px 0' }}>
          <Select value={status} onChange={setStatus} options={['pending', 'published', 'hidden']} placeholder="Any status" />
          <Toggle checked={flagged} onChange={setFlagged} label="Only burst-flagged" />
        </div>
        <DataTable columns={columns} {...list.tableProps} emptyText="Nothing to moderate" rowActions={(r) => [
          r.status !== 'published' && { label: 'Publish', primary: true, onClick: () => run(() => api.post(`/admin/market/plugin-reviews/${r.id}/publish`), { success: 'Published', then: list.refetch }) },
          r.status !== 'hidden' && { label: 'Hide', danger: true, primary: true, onClick: () => run(() => api.post(`/admin/market/plugin-reviews/${r.id}/hide`), { success: 'Hidden', then: list.refetch }) },
        ]} />
      </Card>
    </>
  );
}
