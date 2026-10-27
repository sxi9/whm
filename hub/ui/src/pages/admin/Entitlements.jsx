import { useState } from 'react';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, Select, TextInput } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { useAction } from '../../hooks/useAction.js';
import { FormModal, Tabs, money } from '../../widgets/index.jsx';

function EntitlementsTab({ prefix }) {
  const [status, setStatus] = useState('');
  const list = useListQuery('/admin/market/entitlements', { filters: { license_prefix: prefix, status } });
  const { run } = useAction();
  const confirm = useConfirm();
  const [granting, setGranting] = useState(false);
  const columns = [
    { key: 'plugin_id', label: 'Plugin', render: (e) => <code>{e.plugin_id}</code> },
    { key: 'license_id', label: 'License', render: (e) => <code className="small">{e.license_id}</code> },
    { key: 'kind', label: 'Kind' },
    { key: 'status', label: 'Status', render: (e) => <StatusPill status={e.status} /> },
    { key: 'source', label: 'Source' },
    { key: 'starts_at', label: 'Starts', render: (e) => formatDate(e.starts_at) },
    { key: 'expires_at', label: 'Expires', render: (e) => (e.expires_at ? formatDate(e.expires_at) : 'never') },
  ];
  return (
    <>
      <div className="filter-row"><Select value={status} onChange={setStatus} options={['active', 'expired', 'cancelled', 'refunded']} placeholder="Any status" /><Button size="sm" variant="primary" onClick={() => setGranting(true)}>Grant entitlement</Button></div>
      <DataTable dense columns={columns} {...list.tableProps} emptyText="No entitlements" rowActions={(e) => [e.status === 'active' && { label: 'Cancel', danger: true, primary: true, onClick: async () => { if (await confirm({ title: 'Cancel entitlement', message: `${e.plugin_id} on ${e.license_id}: further downloads and updates answer 402.`, danger: true })) run(() => api.post(`/admin/market/entitlements/${e.id}/cancel`), { success: 'Cancelled', then: list.refetch }); } }]} />
      <FormModal open={granting} title="Grant an entitlement (admin source)" fields={[{ key: 'license_id', label: 'License id', required: true, help: 'lic_…' }, { key: 'plugin_id', label: 'Plugin id', required: true }, { key: 'kind', label: 'Kind', type: 'select', options: ['free', 'one_time', 'subscription', 'trial'], required: true }, { key: 'expires_at', label: 'Expires at (ISO, optional)' }]} initial={{ kind: 'one_time' }} onClose={() => setGranting(false)} submitLabel="Grant"
        onSubmit={async (d) => { await api.post('/admin/market/entitlements', { license_id: d.license_id, plugin_id: d.plugin_id, kind: d.kind, ...(d.expires_at ? { expires_at: new Date(d.expires_at).toISOString() } : {}) }); list.refetch(); }} />
    </>
  );
}

function PurchasesTab({ prefix }) {
  const [status, setStatus] = useState('');
  const list = useListQuery('/admin/market/purchases', { filters: { license_prefix: prefix, status } });
  const { run } = useAction();
  const confirm = useConfirm();
  const columns = [
    { key: 'paid_at', label: 'Paid', render: (p) => formatDate(p.paid_at) },
    { key: 'plugin_id', label: 'Plugin', render: (p) => <code>{p.plugin_id}</code> },
    { key: 'license_id', label: 'License', render: (p) => <code className="small">{p.license_id}</code> },
    { key: 'amount_cents', label: 'Amount', render: (p) => money(p.amount_cents, p.currency) },
    { key: 'developer_cents', label: 'Developer / vendor', render: (p) => `${money(p.developer_cents, p.currency)} / ${money(p.vendor_cents, p.currency)} (${p.revenue_share_pct}%)` },
    { key: 'provider', label: 'Provider', render: (p) => <>{p.provider} <code className="small">{p.external_id}</code></> },
    { key: 'status', label: 'Status', render: (p) => <StatusPill status={p.status} /> },
  ];
  return (
    <>
      <div className="filter-row"><Select value={status} onChange={setStatus} options={['paid', 'refunded', 'chargeback', 'cancelled']} placeholder="Any status" /></div>
      <DataTable dense columns={columns} {...list.tableProps} emptyText="No purchases" rowActions={(p) => [p.status === 'paid' && { label: 'Refund', danger: true, primary: true, onClick: async () => { if (await confirm({ title: 'Refund purchase', message: 'Marks the purchase refunded, the entitlement refunded, and claws the developer share back from the next payout.', danger: true })) run(() => api.post(`/admin/market/purchases/${p.id}/refund`, { status: 'refunded' }), { success: 'Refunded', then: list.refetch }); } }]} />
    </>
  );
}

export default function Entitlements() {
  const [tab, setTab] = useState('entitlements');
  const [prefix, setPrefix] = useState('');
  const valid = /^WHM-[0-9A-HJKMNP-TV-Z]{4}$/.test(prefix.toUpperCase());
  return (
    <>
      <PageHeader title="Entitlements & purchases" description="Paid plugins are entitlements on a panel license. Search by license key prefix (WHM-XXXX)." home="/admin" />
      <Card padded={false}>
        <div style={{ padding: '12px 18px 0' }}><Tabs value={tab} onChange={setTab} tabs={[{ value: 'entitlements', label: 'Entitlements' }, { value: 'purchases', label: 'Purchases' }]} /></div>
        <div className="card-body">
          <div className="filter-row"><TextInput value={prefix} onChange={(v) => setPrefix(v.toUpperCase())} placeholder="WHM-7K3Q" style={{ maxWidth: 160 }} />{prefix && !valid && <span className="muted">a prefix looks like WHM-XXXX</span>}</div>
          {tab === 'entitlements' && <EntitlementsTab prefix={valid ? prefix : ''} />}
          {tab === 'purchases' && <PurchasesTab prefix={valid ? prefix : ''} />}
        </div>
      </Card>
    </>
  );
}
