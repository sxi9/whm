import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, ErrorBanner, Select } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { useAction } from '../../hooks/useAction.js';
import { ReasonModal, FormModal, KV } from '../../widgets/index.jsx';
import { EvidenceList } from './VerificationQueue.jsx';

function DeveloperDrawer({ id, onClose, onChanged }) {
  const { data, loading, error, refetch } = useApi(id ? `/admin/market/developers/${id}` : null);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [modal, setModal] = useState(null);
  const d = data;
  const changed = async () => { await refetch(); onChanged?.(); };
  const post = (path, body, success) => run(() => api.post(`/admin/market/developers/${id}/${path}`, body), { success, then: changed });
  return (
    <Modal open={Boolean(id)} title={d ? `${d.display_name} · ${d.email}` : 'Developer'} onClose={onClose} size="lg">
      <ErrorBanner error={error} onRetry={refetch} />
      {loading && !d && <p className="muted">Loading…</p>}
      {d && (
        <>
          <div className="inline-list" style={{ marginBottom: 12 }}>
            <StatusPill status={d.status} />
            {d.status === 'suspended' ? <Button size="sm" disabled={busy} onClick={() => post('reinstate', {}, 'Developer reinstated')}>Reinstate</Button> : <Button size="sm" disabled={busy} onClick={() => setModal('suspend')}>Suspend</Button>}
            <Button size="sm" disabled={busy} onClick={() => setModal('reverify')}>Trigger re-verification</Button>
            <Button size="sm" disabled={busy} onClick={() => setModal('share')}>Revenue share ({d.revenue_share_pct}%)</Button>
            <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => setModal('close')}>Close account</Button>
            <Link className="btn btn-sm" to="/admin/market/verifications">Verification queue</Link>
          </div>
          <div className="two-col">
            <div>
              <KV items={[['Slug', d.slug], ['Company', d.company], ['Website', d.website], ['Country', d.country], ['Support', d.support_email || d.support_url], ['Verified', d.verified_at ? `${formatDate(d.verified_at)} (re-verify ${formatDate(d.reverify_due_at)})` : 'never'], ['2FA', d.totp_enabled ? 'enabled' : 'off'], ['Payout details', d.has_payout ? 'on file (encrypted)' : 'missing'], ['Status reason', d.status_reason], ['Registered', formatDate(d.created_at)]]} />
              <p style={{ marginTop: 10 }}><strong>Namespaces</strong></p>
              <ul className="timeline">{(d.history?.namespaces || d.namespaces || []).map((n) => { const ns = typeof n === 'string' ? { ns: n } : n; return <li key={ns.ns}><time>{ns.status || ''}</time><span><code>{ns.ns}</code> {ns.domain && <span className="muted">({ns.domain})</span>} <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { if (await confirm({ title: 'Reassign namespace', message: `Reassign ${ns.ns} to this developer (dispute resolution)?` })) post(`namespaces/${encodeURIComponent(ns.ns)}/reassign`, {}, 'Namespace reassigned'); }}>Reassign here</Button></span></li>; })}</ul>
              <p style={{ marginTop: 10 }}><strong>Signing keys</strong></p>
              <div className="inline-list">{(d.history?.keys || []).map((k) => <span key={k.kid} className={`pill ${k.status === 'active' ? 'pill-ok' : 'pill-bad'}`}>{k.kid} · {k.status}</span>)}</div>
            </div>
            <div>
              <p><strong>Security events</strong></p>
              <ul className="timeline">{(d.history?.security_events || []).slice(0, 15).map((e, i) => <li key={i}><time>{formatDate(e.ts || e.created_at)}</time><span>{e.event || e.kind} {e.detail && <span className="muted">{typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)}</span>}</span></li>)}{!(d.history?.security_events || []).length && <li><span className="muted">None.</span></li>}</ul>
              <p style={{ marginTop: 10 }}><strong>Audit</strong></p>
              <ul className="timeline">{(d.history?.audit || []).slice(0, 15).map((a, i) => <li key={i}><time>{formatDate(a.ts)}</time><span><code>{a.action}</code> {a.target} <span className="muted">{a.result}</span></span></li>)}</ul>
              <p style={{ marginTop: 10 }}><strong>Evidence</strong></p>
              <EvidenceList verifications={d.history?.verifications} />
            </div>
          </div>
          <ReasonModal open={modal === 'suspend'} title="Suspend developer" help="Freezes publishing and hides unpublished versions; published versions stay installable unless revoked." confirmLabel="Suspend" onClose={() => setModal(null)} onConfirm={({ reason }) => post('suspend', { reason }, 'Developer suspended')} />
          <ReasonModal open={modal === 'reverify'} title="Trigger re-verification" label="Reason" required={false} danger={false} confirmLabel="Trigger" onClose={() => setModal(null)} onConfirm={({ reason }) => post('reverify', reason ? { reason } : {}, 'Developer moved to pending; uploads still accepted, publishing paused')} />
          <ReasonModal open={modal === 'close'} title="Close account" help="Moves the developer to rejected and revokes keys and sessions." confirmLabel="Close account" onClose={() => setModal(null)} onConfirm={({ reason }) => post('close', { reason }, 'Account closed')} />
          <FormModal open={modal === 'share'} title="Developer revenue share" fields={[{ key: 'pct', label: 'Developer share (%)', type: 'number', min: 0, max: 100, required: true }]} initial={{ pct: d.revenue_share_pct }} onClose={() => setModal(null)} submitLabel="Save"
            onSubmit={async (f) => { await api.put(`/admin/market/developers/${id}/revenue-share`, { pct: Number(f.pct) }); await changed(); }} />
        </>
      )}
    </Modal>
  );
}

export default function Developers() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const list = useListQuery('/admin/market/developers', { filters: { status } });
  const columns = [
    { key: 'display_name', label: 'Developer', sortable: true, render: (d) => <><strong>{d.display_name}</strong><br /><span className="muted">{d.email}</span></> },
    { key: 'slug', label: 'Slug' },
    { key: 'status', label: 'Status', sortable: true, render: (d) => <StatusPill status={d.status} /> },
    { key: 'namespaces', label: 'Namespaces', render: (d) => (d.namespaces || []).join(', ') || '—' },
    { key: 'totp_enabled', label: '2FA', render: (d) => <StatusPill status={d.totp_enabled ? 'enabled' : 'disabled'} /> },
    { key: 'verified_at', label: 'Verified', render: (d) => formatDate(d.verified_at) },
    { key: 'created_at', label: 'Registered', sortable: true, render: (d) => formatDate(d.created_at) },
  ];
  return (
    <>
      <PageHeader title="Developers" description="Search developers, inspect keys, namespaces, payouts, history and security events." home="/admin" />
      <Card padded={false}>
        <div className="filter-row" style={{ padding: '12px 16px 0' }}><Select value={status} onChange={setStatus} options={['pending', 'verified', 'rejected', 'suspended']} placeholder="Any status" /></div>
        <DataTable columns={columns} {...list.tableProps} searchable searchPlaceholder="E-mail, name, slug, namespace" emptyText="No developers" rowActions={(d) => [{ label: 'Open', primary: true, onClick: () => navigate(`/admin/market/developers/${d.id}`) }]} />
      </Card>
      <DeveloperDrawer id={id || null} onClose={() => navigate('/admin/market/developers')} onChanged={list.refetch} />
    </>
  );
}
