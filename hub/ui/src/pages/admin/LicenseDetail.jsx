import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill, Loading, formatDate } from '../../components/Common.jsx';
import { Button, ErrorBanner, Select, Toggle } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { KV, ReasonModal, FormModal, SecretOnce, limitLabel } from '../../widgets/index.jsx';
import { skuField } from './Licenses.jsx';

// Lifecycle actions shared with the reseller license drawer. `base` selects
// the scoped (/reseller) or unscoped (/admin) route family of §16.7.
export function LifecycleActions({ base, license, products, skuSuggestions, onChanged, admin = false }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [modal, setModal] = useState(null);
  const [rekeyed, setRekeyed] = useState(null);
  const id = license.id;
  const post = (path, body, success) => run(() => api.post(`${base}/licenses/${id}/${path}`, body), { success, then: onChanged });
  const status = license.status_now || license.status;
  const newProduct = skuField({ products, suggestions: skuSuggestions, label: 'New product' });
  return (
    <>
      <div className="inline-list">
        <Button variant="primary" disabled={busy} onClick={() => setModal('renew')}>Renew</Button>
        <Button disabled={busy} onClick={() => setModal('edition')}>Change edition</Button>
        {status === 'suspended'
          ? <Button disabled={busy} onClick={() => post('unsuspend', {}, 'License unsuspended')}>Unsuspend</Button>
          : <Button disabled={busy || status === 'revoked'} onClick={() => setModal('suspend')}>Suspend</Button>}
        <Button variant="danger" disabled={busy || status === 'revoked'} onClick={() => setModal('revoke')}>Revoke</Button>
        <Button disabled={busy} onClick={() => setModal('rekey')}>Re-key</Button>
        {admin && <Button disabled={busy} onClick={async () => { if (await confirm({ title: 'Lift re-activation limit', message: 'Allow more than 3 activations in 30 days for the next 7 days?' })) post('lift-reactivation-limit', { days: 7 }, 'Limit lifted for 7 days'); }}>Lift re-activation limit</Button>}
        {admin && <Button disabled={busy} onClick={() => setModal('message')}>Push message</Button>}
      </div>
      <SecretOnce label="New key" value={rekeyed?.key}>The previous key no longer resolves; existing activations keep working.</SecretOnce>
      <FormModal open={modal === 'renew'} title="Renew license" fields={[{ key: 'term_months', label: 'Months to add', type: 'number', min: 1, max: 120, required: true }]} initial={{ term_months: 12 }} onClose={() => setModal(null)} submitLabel="Renew"
        onSubmit={(d) => post('renew', { term_months: Number(d.term_months) }, 'Renewed')} />
      <FormModal open={modal === 'edition'} title="Change edition" fields={[newProduct, { key: 'force', label: 'Force (allow a downgrade below current usage)', type: 'select', options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes — the panel blocks new creation but keeps existing accounts' }] }]} initial={{ force: 'no' }} onClose={() => setModal(null)} submitLabel="Change"
        onSubmit={(d) => post('change-edition', { sku: String(d.sku || '').trim(), ...(d.force === 'yes' ? { force: true } : {}) }, 'Edition changed; applies at the next check-in')} />
      <ReasonModal open={modal === 'suspend'} title="Suspend license" confirmLabel="Suspend" onClose={() => setModal(null)} onConfirm={({ reason }) => post('suspend', { reason }, 'Suspended')} />
      <ReasonModal open={modal === 'revoke'} title="Revoke license" help="Every activation is blocked at its next check-in; this cannot be undone." confirmLabel="Revoke" onClose={() => setModal(null)} onConfirm={({ reason }) => post('revoke', { reason }, 'Revoked')} />
      <ReasonModal open={modal === 'rekey'} title="Issue a replacement key" danger={false} confirmLabel="Re-key" onClose={() => setModal(null)} onConfirm={async ({ reason }) => { const out = await run(() => api.post(`${base}/licenses/${id}/rekey`, { reason }), { success: 'New key issued', then: onChanged }); if (out) setRekeyed(out.data); }} />
      <FormModal open={modal === 'message'} title="Queue a message for the next check-in" fields={[{ key: 'level', label: 'Level', type: 'select', options: ['info', 'warning', 'critical'], required: true }, { key: 'code', label: 'Code', required: true, help: 'lower-case with underscores, e.g. renewal_available' }, { key: 'text', label: 'Text', type: 'textarea', required: true }]} initial={{ level: 'info' }} onClose={() => setModal(null)} submitLabel="Queue"
        onSubmit={(d) => post('messages', { level: d.level, code: d.code, text: d.text }, 'Message queued')} />
    </>
  );
}

export function ActivationsTable({ activations, base, licenseId, onChanged, extra = null }) {
  const { run, busy } = useAction();
  const [target, setTarget] = useState(null);
  const rows = activations || [];
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Server</th><th>Status</th><th>Panel</th><th>First seen</th><th>Last check-in</th><th>Drift</th><th /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="muted">No activations yet.</td></tr>}
            {rows.map((a) => (
              <tr key={a.id}>
                <td><strong>{a.hostname}</strong><br /><span className="muted">{a.public_ip} · {a.id}</span></td>
                <td><StatusPill status={a.status} /></td>
                <td>{a.panel_version} <span className="muted">{a.os}</span></td>
                <td>{formatDate(a.first_seen)}</td>
                <td>{formatDate(a.last_checkin)}</td>
                <td>{a.drift_events ?? 0}</td>
                <td>{a.status === 'active' && <Button size="sm" disabled={busy} onClick={() => setTarget(a)}>Deactivate</Button>}{extra?.(a)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ReasonModal open={Boolean(target)} title={`Deactivate ${target?.hostname || ''}`} confirmLabel="Deactivate" onClose={() => setTarget(null)}
        onConfirm={({ reason }) => run(() => api.post(`${base}/licenses/${licenseId}/activations/${target.id}/deactivate`, { reason }), { success: 'Deactivated; the panel learns it at its next check-in', then: onChanged })} />
    </>
  );
}

export default function LicenseDetail() {
  const { id } = useParams();
  const { data: lic, loading, error, refetch } = useApi(`/admin/licenses/${id}`);
  const products = useApi('/admin/products');
  const [showAll, setShowAll] = useState(false);
  if (loading && !lic) return <Loading />;
  if (error) return <ErrorBanner error={error} onRetry={refetch} />;
  if (!lic) return null;
  const features = Object.entries(lic.features || {}).filter(([, v]) => v).map(([k]) => k);
  return (
    <>
      <PageHeader title={`License ${lic.key_prefix}-…`} description={`${lic.edition} · ${lic.id}`} home="/admin" crumbs={[{ to: '/admin/licenses', label: 'Licenses' }]}
        actions={<StatusPill status={lic.status_now || lic.status} />} />
      <div className="two-col">
        <Card title="License">
          <KV items={[
            ['Status', <StatusPill status={lic.status_now || lic.status} />], ['Edition', `${lic.edition} (rank ${lic.rank ?? '—'})`], ['Issued', formatDate(lic.issued_at)], ['Starts', formatDate(lic.starts_at)],
            ['Expires', lic.expires_at ? `${formatDate(lic.expires_at)} (+${lic.grace_days} d grace)` : 'never'], ['Activations', `${(lic.activations || []).filter((a) => a.status === 'active').length} / ${limitLabel(lic.max_activations)}`],
            ['Customer', lic.customer ? <Link to={`/admin/customers?q=${encodeURIComponent(lic.customer.email)}`}>{lic.customer.name || lic.customer.email}</Link> : lic.customer_id],
            ['Reseller', lic.reseller_id ? <Link to={`/admin/resellers?q=${lic.reseller_id}`}>{lic.reseller_id}</Link> : 'vendor direct'], ['External ref', lic.external_ref], ['Issued by', lic.issued_by], ['Notes', lic.notes],
            lic.trial && ['Trial', `started ${formatDate(lic.trial.started_at)}${lic.trial.converted_at ? `, converted ${formatDate(lic.trial.converted_at)}` : ''}`],
          ]} />
        </Card>
        <Card title="Entitlements">
          <KV items={[['Accounts', limitLabel(lic.limits?.max_accounts)], ['Resellers', limitLabel(lic.limits?.max_resellers)], ['Domains per account', limitLabel(lic.limits?.max_domains_per_account)], ['Servers', limitLabel(lic.limits?.max_activations ?? lic.max_activations)]]} />
          <p style={{ marginTop: 10 }}><strong>Features</strong></p>
          <div className="inline-list">{features.length ? features.map((f) => <span key={f} className="pill pill-ok">{f}</span>) : <span className="muted">none</span>}</div>
          {lic.usage && <><p style={{ marginTop: 10 }}><strong>Last reported usage</strong></p><KV items={[['Accounts', lic.usage.accounts], ['Resellers', lic.usage.resellers], ['Domains', lic.usage.domains], ['Plugins', Array.isArray(lic.usage.plugins) ? lic.usage.plugins.map((p) => `${p.id}@${p.version}`).join(', ') || 'none' : '—']]} /></>}
        </Card>
      </div>
      <Card title="Actions" subtitle="Edition changes and suspensions reach the panel at its next check-in; the panel never gets an inbound connection.">
        <LifecycleActions base="/admin" license={lic} products={products.data} onChanged={refetch} admin />
      </Card>
      <Card title="Activations" subtitle="Deactivating frees a slot; the old server enters degraded mode on its next check-in.">
        <ActivationsTable activations={lic.activations} base="/admin" licenseId={lic.id} onChanged={refetch} />
      </Card>
      <div className="two-col">
        <Card title="Check-in history" actions={<Toggle checked={showAll} onChange={setShowAll} label="Show all 50" />}>
          <ul className="timeline">
            {(lic.checkins || []).slice(0, showAll ? 50 : 10).map((c) => <li key={c.id}><time>{formatDate(c.ts)}</time><span><StatusPill status={c.result === 'ok' || c.result === 'rotated' ? 'ok' : c.result} >{c.result}</StatusPill> {c.panel_version} · {c.accounts_used ?? 0} accounts · {c.ip}</span></li>)}
            {!(lic.checkins || []).length && <li><span className="muted">No check-ins yet.</span></li>}
          </ul>
        </Card>
        <Card title="Revocations">
          <ul className="timeline">
            {(lic.revocations || []).map((r) => <li key={r.id}><time>{formatDate(r.ts)}</time><span>{r.reason} <span className="muted">by {r.revoked_by}</span></span></li>)}
            {!(lic.revocations || []).length && <li><span className="muted">Never revoked.</span></li>}
          </ul>
        </Card>
      </div>
    </>
  );
}
