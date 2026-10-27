import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { Button, ErrorBanner, Select } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useApi } from '../../hooks/useApi.js';
import { SecretOnce, KV, limitLabel } from '../../widgets/index.jsx';
import { IssueLicenseModal, BulkIssueModal, LicenseTable, EDITIONS, LICENSE_STATUSES } from '../admin/Licenses.jsx';
import { LifecycleActions, ActivationsTable } from '../admin/LicenseDetail.jsx';

// Reseller products come from the public catalog of editions the quota names;
// /v1/admin/products is vendor-only, so the SKU list is derived from quota + pricing.
function useResellerProducts() {
  const quota = useApi('/reseller/quota');
  const editions = Object.entries(quota.data?.quota || {}).filter(([, n]) => n === -1 || n > 0).map(([e]) => e);
  const products = editions.flatMap((e) => (e === 'trial' ? [] : [{ sku: `whm-${e}-annual`, name: `${e} annual`, edition: e, term: 'annual' }, { sku: `whm-${e}-monthly`, name: `${e} monthly`, edition: e, term: 'monthly' }]));
  return { products, quota };
}

function LicenseDrawer({ id, products, onClose, onChanged }) {
  const { data: lic, loading, error, refetch } = useApi(id ? `/reseller/licenses/${id}` : null);
  const changed = async () => { await refetch(); onChanged?.(); };
  return (
    <Modal open={Boolean(id)} title={lic ? `License ${lic.key_prefix}-… (${lic.edition})` : 'License'} onClose={onClose} size="lg">
      <ErrorBanner error={error} onRetry={refetch} />
      {loading && !lic && <p className="muted">Loading…</p>}
      {lic && (
        <>
          <KV items={[['Status', <StatusPill status={lic.status_now || lic.status} />], ['Customer', lic.customer_id], ['Expires', lic.expires_at ? formatDate(lic.expires_at) : 'never'], ['Servers', `${(lic.activations || []).filter((a) => a.status === 'active').length} / ${limitLabel(lic.max_activations)}`], ['Accounts limit', limitLabel(lic.limits?.max_accounts)], ['Usage', lic.usage ? `${lic.usage.accounts} accounts · ${lic.usage.domains} domains` : '—'], ['Notes', lic.notes], ['External ref', lic.external_ref]]} />
          <h3 style={{ margin: '12px 0 8px' }}>Actions</h3>
          <LifecycleActions base="/reseller" license={lic} products={products} onChanged={changed} />
          <h3 style={{ margin: '12px 0 8px' }}>Activations</h3>
          <ActivationsTable activations={lic.activations} base="/reseller" licenseId={lic.id} onChanged={changed} />
        </>
      )}
    </Modal>
  );
}

export default function ResellerLicenses() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { products } = useResellerProducts();
  const [issueOpen, setIssueOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [issued, setIssued] = useState(null);
  const [job, setJob] = useState(null);
  const [tick, setTick] = useState(0);
  const filters = { status: params.get('status') || '', edition: params.get('edition') || '', expiring_within: params.get('expiring_within') || '', _t: tick || '' };
  const setFilter = (k, v) => { const next = new URLSearchParams(params); if (v) next.set(k, v); else next.delete(k); setParams(next); };
  return (
    <>
      <PageHeader title="My licenses" description="Issue within your quota; renew, suspend, revoke and re-key your own licenses." home="/reseller"
        actions={<><Button onClick={() => setBulkOpen(true)}>Bulk issue</Button><Button variant="primary" onClick={() => setIssueOpen(true)}>Issue license</Button></>} />
      {issued && <Card title="License issued"><SecretOnce label={`${issued.edition} license`} value={issued.key}>Hand this key to your customer. {issued.meta?.quota_left && `Quota left: ${JSON.stringify(issued.meta.quota_left)}`}</SecretOnce></Card>}
      {job && <Card title={`Bulk issue job ${job.id}`}><ProgressLog jobPath={`/reseller/jobs/${job.id}`} renderResult={(j) => <p>{j.result?.count} licenses issued. <a className="btn btn-sm" href={`/v1/reseller/jobs/${j.id}?format=csv`}>Download CSV</a></p>} /></Card>}
      <Card padded={false}>
        <div className="filter-row" style={{ padding: '12px 16px 0' }}>
          <Select value={filters.status} onChange={(v) => setFilter('status', v)} options={LICENSE_STATUSES} placeholder="Any status" />
          <Select value={filters.edition} onChange={(v) => setFilter('edition', v)} options={EDITIONS} placeholder="Any edition" />
          <Select value={filters.expiring_within} onChange={(v) => setFilter('expiring_within', v)} options={[{ value: '30', label: 'Expiring in 30 days' }, { value: '90', label: 'Expiring in 90 days' }]} placeholder="Any expiry" />
        </div>
        <LicenseTable base="/reseller" filters={filters} linkTo={(r) => `/reseller/licenses/${r.id}`} />
      </Card>
      <IssueLicenseModal reseller open={issueOpen} onClose={() => setIssueOpen(false)} base="/reseller" products={products} onIssued={(d) => { setIssued(d); setTick((t) => t + 1); }} />
      <BulkIssueModal open={bulkOpen} onClose={() => setBulkOpen(false)} base="/reseller" products={products} onQueued={setJob} />
      <LicenseDrawer id={id || null} products={products} onClose={() => navigate('/reseller/licenses')} onChanged={() => setTick((t) => t + 1)} />
    </>
  );
}
