import { useState } from 'react';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, Select } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { useAction } from '../../hooks/useAction.js';
import { FormModal, ReasonModal, money } from '../../widgets/index.jsx';

// §18.5 money out: close a period → pending rows → approve → mark paid with
// the provider reference; held when under the minimum or developer not verified.
export default function Payouts() {
  const [status, setStatus] = useState('');
  const list = useListQuery('/admin/market/payouts', { filters: { status } });
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [paying, setPaying] = useState(null);
  const [holding, setHolding] = useState(null);
  const [closing, setClosing] = useState(false);
  const columns = [
    { key: 'developer_id', label: 'Developer', render: (p) => <code className="small">{p.developer_name || p.developer_id}</code> },
    { key: 'period_start', label: 'Period', render: (p) => `${formatDate(p.period_start).slice(0, 10)} → ${formatDate(p.period_end).slice(0, 10)}` },
    { key: 'gross_cents', label: 'Gross', render: (p) => money(p.gross_cents, p.currency) },
    { key: 'refunds_cents', label: 'Refunds', render: (p) => money(p.refunds_cents, p.currency) },
    { key: 'net_cents', label: 'Net', sortable: true, render: (p) => <strong>{money(p.net_cents, p.currency)}</strong> },
    { key: 'share_pct', label: 'Share', render: (p) => `${p.share_pct}%` },
    { key: 'status', label: 'Status', render: (p) => <StatusPill status={p.status} /> },
    { key: 'provider_ref', label: 'Provider ref', render: (p) => p.provider_ref || '—' },
    { key: 'paid_at', label: 'Paid', render: (p) => formatDate(p.paid_at) },
  ];
  return (
    <>
      <PageHeader title="Payouts" description="Monthly developer statements: close the period, approve, pay through Stripe Connect or manual transfer and record the reference." home="/admin"
        actions={<Button variant="primary" disabled={busy} onClick={() => setClosing(true)}>Close period</Button>} />
      <Card padded={false}>
        <div className="filter-row" style={{ padding: '12px 16px 0' }}><Select value={status} onChange={setStatus} options={['pending', 'approved', 'paid', 'failed', 'held']} placeholder="Any status" /></div>
        <DataTable columns={columns} {...list.tableProps} emptyText="No payouts" rowActions={(p) => [
          p.status === 'pending' && { label: 'Approve', primary: true, onClick: async () => { if (await confirm({ title: 'Approve payout', message: `${money(p.net_cents, p.currency)} to ${p.developer_id}` })) run(() => api.post(`/admin/market/payouts/${p.id}/approve`), { success: 'Approved', then: list.refetch }); } },
          p.status === 'approved' && { label: 'Mark paid', primary: true, onClick: () => setPaying(p) },
          ['pending', 'approved'].includes(p.status) && { label: 'Hold', danger: true, onClick: () => setHolding(p) },
          { label: 'Statement', onClick: () => window.open(`/v1/admin/market/payouts/${p.id}`, '_blank') },
        ]} />
      </Card>
      <FormModal open={closing} title="Close a payout period" fields={[{ key: 'period_start', label: 'Period start (ISO, optional)' }, { key: 'period_end', label: 'Period end (ISO, optional)', help: 'Defaults to the previous calendar month' }]} onClose={() => setClosing(false)} submitLabel="Close period"
        onSubmit={async (d) => { await api.post('/admin/market/payouts/close', { ...(d.period_start ? { period_start: new Date(d.period_start).toISOString() } : {}), ...(d.period_end ? { period_end: new Date(d.period_end).toISOString() } : {}) }); list.refetch(); }} />
      <FormModal open={Boolean(paying)} title={`Mark paid: ${paying ? money(paying.net_cents, paying.currency) : ''}`} fields={[{ key: 'provider_ref', label: 'Provider reference (transfer id)', required: true }]} onClose={() => setPaying(null)} submitLabel="Mark paid"
        onSubmit={async (d) => { await api.post(`/admin/market/payouts/${paying.id}/mark-paid`, { provider_ref: d.provider_ref }); list.refetch(); }} />
      <ReasonModal open={Boolean(holding)} title="Hold payout" confirmLabel="Hold" onClose={() => setHolding(null)} onConfirm={({ reason }) => run(() => api.post(`/admin/market/payouts/${holding.id}/hold`, { reason }), { success: 'Payout held', then: list.refetch })} />
    </>
  );
}
