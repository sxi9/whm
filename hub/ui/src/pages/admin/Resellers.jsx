import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, Field, NumberInput, ErrorBanner } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { useAction } from '../../hooks/useAction.js';
import { FormModal, KV, money, limitLabel } from '../../widgets/index.jsx';
import { EDITIONS } from './Licenses.jsx';

// Quota + wholesale pricing editor (PUT /admin/resellers/:id/quota).
export function QuotaEditor({ reseller, onSaved }) {
  const [quota, setQuota] = useState(() => Object.fromEntries(EDITIONS.map((e) => [e, reseller.quota?.[e] ?? 0])));
  const [pricing, setPricing] = useState(() => Object.fromEntries(EDITIONS.map((e) => [e, { monthly: reseller.pricing?.[e]?.monthly ?? 0, annual: reseller.pricing?.[e]?.annual ?? 0 }])));
  const { run, busy, error } = useAction();
  return (
    <>
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Edition</th><th>Quota (-1 = unlimited)</th><th>Issued</th><th>Left</th><th>Wholesale monthly (cents)</th><th>Wholesale annual (cents)</th></tr></thead>
          <tbody>
            {EDITIONS.map((e) => (
              <tr key={e}>
                <td>{e}</td>
                <td><NumberInput value={quota[e]} nullable={false} onChange={(v) => setQuota((q) => ({ ...q, [e]: v }))} min={-1} /></td>
                <td>{reseller.issued?.[e] ?? 0}</td>
                <td>{limitLabel(reseller.quota_left?.[e])}</td>
                <td><NumberInput value={pricing[e].monthly} nullable={false} onChange={(v) => setPricing((p) => ({ ...p, [e]: { ...p[e], monthly: v } }))} min={0} /></td>
                <td><NumberInput value={pricing[e].annual} nullable={false} onChange={(v) => setPricing((p) => ({ ...p, [e]: { ...p[e], annual: v } }))} min={0} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-actions"><Button variant="primary" loading={busy} onClick={() => run(() => api.put(`/admin/resellers/${reseller.id}/quota`, { quota, pricing }), { success: 'Quota and pricing saved', then: onSaved })}>Save quota & pricing</Button></div>
    </>
  );
}

export function StatementView({ statement }) {
  if (!statement) return null;
  return (
    <>
      <KV items={[['Total wholesale', money(statement.total_cents, statement.currency)], ['Licenses', statement.lines?.length ?? 0]]} />
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table>
          <thead><tr><th>Month</th><th>Licenses</th><th>Wholesale</th></tr></thead>
          <tbody>{(statement.months || []).map((m) => <tr key={m.month}><td>{m.month}</td><td>{m.licenses}</td><td>{money(m.wholesale_cents, statement.currency)}</td></tr>)}{!(statement.months || []).length && <tr><td colSpan={3} className="muted">Nothing issued yet.</td></tr>}</tbody>
        </table>
      </div>
    </>
  );
}

// Only a vendor_admin portal session may impersonate (API keys and
// vendor_support cannot); the hub asks for a TOTP step-up first.
export function canImpersonate(session, reseller) {
  return session?.kind === 'portal' && session.user?.role === 'vendor_admin' && !session.impersonating && reseller?.status === 'active';
}

export function ResellerDrawer({ id, onClose }) {
  const { data, loading, error, refetch } = useApi(id ? `/admin/resellers/${id}` : null);
  const statement = useApi(id ? `/admin/resellers/${id}/statement` : null);
  const { run, busy } = useAction();
  const { session, impersonate } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('quota');
  return (
    <Modal open={Boolean(id)} title={data ? `${data.name} · ${data.email}` : 'Reseller'} onClose={onClose} size="lg">
      <ErrorBanner error={error} onRetry={refetch} />
      {loading && !data && <p className="muted">Loading…</p>}
      {data && (
        <>
          <div className="inline-list" style={{ marginBottom: 12 }}>
            <StatusPill status={data.status} />
            {data.status === 'active' ? <Button size="sm" onClick={() => run(() => api.patch(`/admin/resellers/${id}`, { status: 'suspended' }), { success: 'Reseller suspended (keys and sessions refused)', then: refetch })}>Suspend</Button> : <Button size="sm" onClick={() => run(() => api.patch(`/admin/resellers/${id}`, { status: 'active' }), { success: 'Reseller active', then: refetch })}>Reactivate</Button>}
            <Button size="sm" onClick={() => setTab('quota')}>Quota & pricing</Button>
            <Button size="sm" onClick={() => setTab('statement')}>Statement</Button>
            <Button size="sm" onClick={() => setTab('brand')}>White-label</Button>
            {canImpersonate(session, data) && <Button size="sm" loading={busy} title="Act as this reseller's admin for 15 minutes (audited)" onClick={() => run(() => impersonate(data.id), { success: (r) => `Impersonating ${r?.reseller_name || data.name} until ${formatDate(r?.expires_at)}`, then: () => navigate('/reseller') })}>Impersonate</Button>}
          </div>
          {tab === 'quota' && <QuotaEditor key={data.updated_at || data.id} reseller={data} onSaved={refetch} />}
          {tab === 'statement' && <StatementView statement={statement.data} />}
          {tab === 'brand' && <BrandEditor reseller={data} onSaved={refetch} />}
        </>
      )}
    </Modal>
  );
}

function BrandEditor({ reseller, onSaved }) {
  const [brand, setBrand] = useState({ name: reseller.brand?.name || '', logo_url: reseller.brand?.logo_url || '', support_url: reseller.brand?.support_url || '' });
  const { run, busy } = useAction();
  return (
    <>
      <Field label="Portal name"><input className="input" value={brand.name} onChange={(e) => setBrand({ ...brand, name: e.target.value })} /></Field>
      <Field label="Logo URL"><input className="input" value={brand.logo_url} onChange={(e) => setBrand({ ...brand, logo_url: e.target.value })} /></Field>
      <Field label="Support URL"><input className="input" value={brand.support_url} onChange={(e) => setBrand({ ...brand, support_url: e.target.value })} /></Field>
      <Button variant="primary" loading={busy} onClick={() => run(() => api.patch(`/admin/resellers/${reseller.id}`, { brand: Object.fromEntries(Object.entries(brand).filter(([, v]) => v)) }), { success: 'Branding saved', then: onSaved })}>Save branding</Button>
    </>
  );
}

export default function Resellers() {
  const [params] = useSearchParams();
  const list = useListQuery('/admin/resellers', { initialQ: params.get('q') || '' });
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const columns = [
    { key: 'name', label: 'Reseller', render: (r) => <strong>{r.name}</strong> },
    { key: 'email', label: 'E-mail' },
    { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
    { key: 'issued', label: 'Issued', render: (r) => Object.entries(r.issued || {}).map(([e, n]) => `${e}: ${n}`).join(' · ') || '—' },
    { key: 'quota', label: 'Quota', render: (r) => Object.entries(r.quota || {}).map(([e, n]) => `${e}: ${limitLabel(n)}`).join(' · ') || '—' },
    { key: 'created_at', label: 'Since', render: (r) => formatDate(r.created_at) },
  ];
  return (
    <>
      <PageHeader title="Resellers" description="Sub-vendors issue licenses within a per-edition quota at wholesale prices." home="/admin" actions={<Button variant="primary" onClick={() => setCreating(true)}>New reseller</Button>} />
      <Card padded={false}>
        <DataTable columns={columns} {...list.tableProps} searchable emptyText="No resellers" rowActions={(r) => [{ label: 'Open', primary: true, onClick: () => setOpen(r.id) }]} />
      </Card>
      <FormModal open={creating} title="New reseller" fields={[{ key: 'name', label: 'Name', required: true }, { key: 'email', label: 'E-mail', type: 'email', required: true, help: 'A reseller_admin portal user is created under Integrations → Portal users' }]} onClose={() => setCreating(false)} submitLabel="Create"
        onSubmit={async (d) => { await api.post('/admin/resellers', { name: d.name, email: d.email }); list.refetch(); }} />
      <ResellerDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}
