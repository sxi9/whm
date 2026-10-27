import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button } from '../../components/Form.jsx';
import { api } from '../../api/client.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { useAction } from '../../hooks/useAction.js';
import { FormModal } from '../../widgets/index.jsx';

const CUSTOMER_FIELDS = [
  { key: 'name', label: 'Name', required: true },
  { key: 'email', label: 'E-mail', type: 'email', required: true },
  { key: 'company', label: 'Company' },
  { key: 'country', label: 'Country (ISO-2)' },
  { key: 'external_ref', label: 'External reference', help: 'Billing system id (Stripe cus_…, WHMCS client id)' },
];

// Shared by the vendor (/admin, every customer) and reseller (/reseller, own
// customers) portals; `licensesLink` builds the per-customer license filter.
export function CustomerTable({ base, licensesLink, initialQ = '' }) {
  const list = useListQuery(`${base}/customers`, {});
  const { run } = useAction();
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const columns = [
    { key: 'name', label: 'Name', sortable: true, render: (r) => <><strong>{r.name}</strong>{r.company && <span className="muted"> · {r.company}</span>}</> },
    { key: 'email', label: 'E-mail', sortable: true },
    { key: 'country', label: 'Country' },
    { key: 'external_ref', label: 'External ref' },
    { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
    { key: 'created_at', label: 'Since', sortable: true, render: (r) => formatDate(r.created_at) },
    { key: 'licenses', label: 'Licenses', render: (r) => <Link to={licensesLink(r)}>view</Link> },
  ];
  return (
    <>
      <DataTable columns={columns} {...list.tableProps} q={list.tableProps.q || initialQ} searchable searchPlaceholder="Name, e-mail, company, external ref" emptyText="No customers"
        toolbar={<Button variant="primary" size="sm" onClick={() => setCreating(true)}>New customer</Button>}
        rowActions={(r) => [
          { label: 'Edit', primary: true, onClick: () => setEditing(r) },
          r.status === 'active' ? { label: 'Suspend', danger: true, onClick: () => run(() => api.patch(`${base}/customers/${r.id}`, { status: 'suspended' }), { success: 'Customer suspended', then: list.refetch }) } : { label: 'Reactivate', onClick: () => run(() => api.patch(`${base}/customers/${r.id}`, { status: 'active' }), { success: 'Customer active', then: list.refetch }) },
        ]} />
      <FormModal open={creating} title="New customer" fields={CUSTOMER_FIELDS} onClose={() => setCreating(false)} submitLabel="Create"
        onSubmit={async (d) => { await api.post(`${base}/customers`, Object.fromEntries(Object.entries(d).filter(([, v]) => v))); list.refetch(); }} />
      <FormModal open={Boolean(editing)} title={`Edit ${editing?.name || ''}`} fields={CUSTOMER_FIELDS.filter((f) => f.key !== 'email')} initial={editing || {}} onClose={() => setEditing(null)} key={editing?.id || 'none'}
        onSubmit={async (d) => { await api.patch(`${base}/customers/${editing.id}`, { name: d.name, company: d.company || undefined, country: d.country || undefined, external_ref: d.external_ref || undefined }); list.refetch(); }} />
    </>
  );
}

export default function Customers() {
  const [params] = useSearchParams();
  return (
    <>
      <PageHeader title="Customers" description="Every customer across the vendor and its resellers." home="/admin" />
      <Card padded={false}><CustomerTable base="/admin" initialQ={params.get('q') || ''} licensesLink={(r) => `/admin/licenses?q=${encodeURIComponent(r.email)}`} /></Card>
    </>
  );
}
