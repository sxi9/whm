import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button } from '../../components/Form.jsx';
import { useApi } from '../../hooks/useApi.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { limitLabel } from '../../widgets/index.jsx';
import { ActivationsTable } from '../admin/LicenseDetail.jsx';

// The reseller API has no cross-license activation list; servers are shown
// per license (GET /reseller/licenses/:id/activations) on demand.
function LicenseServers({ licenseId }) {
  const { data, loading, refetch } = useApi(`/reseller/licenses/${licenseId}/activations`);
  if (loading && !data) return <p className="muted">Loading servers…</p>;
  return <ActivationsTable activations={data} base="/reseller" licenseId={licenseId} onChanged={refetch} />;
}

export default function ResellerActivations() {
  const list = useListQuery('/reseller/licenses', { filters: { status: 'active' } });
  const [open, setOpen] = useState(null);
  const columns = [
    { key: 'key_prefix', label: 'License', render: (l) => <Link to={`/reseller/licenses/${l.id}`}><code>{l.key_prefix}-…</code></Link> },
    { key: 'edition', label: 'Edition' },
    { key: 'customer_email', label: 'Customer' },
    { key: 'active_activations', label: 'Servers', render: (l) => `${l.active_activations ?? 0} / ${limitLabel(l.max_activations)}` },
    { key: 'status', label: 'Status', render: (l) => <StatusPill status={l.status} /> },
    { key: 'expires_at', label: 'Expires', render: (l) => formatDate(l.expires_at) },
  ];
  return (
    <>
      <PageHeader title="Activations" description="Servers bound to your licenses. Deactivate a server to free its slot; it enters degraded mode at its next check-in." home="/reseller" />
      <Card padded={false}>
        <DataTable columns={columns} {...list.tableProps} searchable searchPlaceholder="Key prefix, hostname, IP" emptyText="No active licenses" rowActions={(l) => [{ label: open === l.id ? 'Hide servers' : 'Show servers', primary: true, onClick: () => setOpen(open === l.id ? null : l.id) }]} />
      </Card>
      {open && <Card title="Servers" actions={<Button size="sm" onClick={() => setOpen(null)}>Close</Button>}><LicenseServers licenseId={open} /></Card>}
    </>
  );
}
