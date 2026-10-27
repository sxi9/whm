import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, Select } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { FormModal, SecretOnce, limitLabel } from '../../widgets/index.jsx';

export const EDITIONS = ['trial', 'solo', 'pro', 'reseller', 'enterprise'];
export const LICENSE_STATUSES = ['pending', 'active', 'suspended', 'expired', 'revoked'];

// The product field: a select over the catalog when one is available
// (GET /v1/admin/products, or GET /v1/reseller/products whose price_cents is
// the reseller's wholesale price), else a free SKU input (with suggestions)
// so the hub, not the form, decides whether a SKU exists.
export function skuField({ products, suggestions = [], label = 'Product', withTerm = false, withPrice = false }) {
  const list = Array.isArray(products) ? products.filter((p) => p.active !== false) : [];
  const price = (p) => (withPrice && Number.isInteger(p.price_cents) ? ` · ${money(p.price_cents, p.currency)}` : '');
  if (list.length) return { key: 'sku', label, type: 'select', options: list.map((p) => ({ value: p.sku, label: `${p.name} (${p.edition}${withTerm && p.term ? `, ${p.term}` : ''})${price(p)}` })), required: true };
  return { key: 'sku', label: `${label} SKU`, required: true, placeholder: suggestions[0] || 'whm-pro-annual', suggestions, help: 'The SKU as defined by the vendor; an unknown SKU is refused by the hub.' };
}

// Issue / bulk-issue forms shared with the reseller portal: `base` is
// /admin or /reseller; the reseller variant has no reseller_id field.
export function IssueLicenseModal({ open, onClose, base, products, skuSuggestions, onIssued, reseller = false }) {
  const fields = [
    skuField({ products, suggestions: skuSuggestions, withTerm: true, withPrice: reseller }),
    { key: 'email', label: 'Customer e-mail', type: 'email', required: true, help: 'An existing customer is matched by e-mail; otherwise one is created.' },
    { key: 'name', label: 'Customer name' },
    { key: 'term_months', label: 'Term (months)', type: 'number', min: 1, max: 120 },
    { key: 'notes', label: 'Notes', type: 'textarea', rows: 2 },
    { key: 'external_ref', label: 'External reference', help: 'Billing system id, e.g. whmcs:5531' },
  ];
  if (!reseller) fields.push({ key: 'reseller_id', label: 'Reseller id (optional)', help: 'Issue on behalf of a reseller (rs_…)' });
  return (
    <FormModal open={open} title="Issue a license" fields={fields} onClose={onClose} submitLabel="Issue" onSubmit={async (d) => {
      const body = { sku: String(d.sku || '').trim(), customer: { email: d.email, ...(d.name ? { name: d.name } : {}) } };
      if (d.term_months) body.term_months = Number(d.term_months);
      if (d.notes) body.notes = d.notes;
      if (d.external_ref) body.external_ref = d.external_ref;
      if (d.reseller_id) body.reseller_id = d.reseller_id;
      const { data, meta } = await api.post(`${base}/licenses`, body);
      onIssued({ ...data, meta: meta || null });
    }} />
  );
}

export function BulkIssueModal({ open, onClose, base, products, skuSuggestions, onQueued }) {
  return (
    <FormModal open={open} title="Bulk issue" fields={[
      skuField({ products, suggestions: skuSuggestions }),
      { key: 'customer_id', label: 'Customer id', required: true, help: 'cus_… — every key is issued to this customer' },
      { key: 'count', label: 'Count', type: 'number', min: 1, max: 1000, required: true },
      { key: 'notes', label: 'Notes' },
    ]} onClose={onClose} submitLabel="Queue job" onSubmit={async (d) => {
      const { data } = await api.post(`${base}/licenses/bulk`, { sku: String(d.sku || '').trim(), customer_id: d.customer_id, count: Number(d.count), ...(d.notes ? { notes: d.notes } : {}) });
      onQueued(data.job);
    }} />
  );
}

export function LicenseTable({ base, filters, linkTo, initialQ = '' }) {
  const list = useListQuery(`${base}/licenses`, { filters, initialQ });
  const columns = [
    { key: 'key_prefix', label: 'Key', sortable: true, render: (r) => <Link to={linkTo(r)}><code>{r.key_prefix}-…</code></Link> },
    { key: 'edition', label: 'Edition', sortable: true },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusPill status={r.status} /> },
    { key: 'customer_email', label: 'Customer', render: (r) => <>{r.customer_name || ''} <span className="muted">{r.customer_email}</span></> },
    { key: 'active_activations', label: 'Servers', render: (r) => `${r.active_activations ?? 0} / ${limitLabel(r.max_activations)}` },
    { key: 'expires_at', label: 'Expires', sortable: true, render: (r) => (r.expires_at ? formatDate(r.expires_at) : <span className="muted">never</span>) },
    { key: 'issued_at', label: 'Issued', sortable: true, render: (r) => formatDate(r.issued_at) },
  ];
  return <DataTable columns={columns} {...list.tableProps} searchable searchPlaceholder="Key prefix, customer, hostname, IP, external ref…" emptyText="No licenses match" />;
}

export default function Licenses() {
  const [params, setParams] = useSearchParams();
  const products = useApi('/admin/products');
  const [issueOpen, setIssueOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [issued, setIssued] = useState(null);
  const [job, setJob] = useState(null);
  const filters = { status: params.get('status') || '', edition: params.get('edition') || '', expiring_within: params.get('expiring_within') || '' };
  const setFilter = (k, v) => { const next = new URLSearchParams(params); if (v) next.set(k, v); else next.delete(k); setParams(next); };
  return (
    <>
      <PageHeader title="Licenses" description="Search, issue and manage licenses. Clear-text keys are shown once." home="/admin"
        actions={<><Button onClick={() => setBulkOpen(true)}>Bulk issue</Button><Button variant="primary" onClick={() => setIssueOpen(true)}>Issue license</Button></>} />
      {issued && <Card title="License issued"><SecretOnce label={`${issued.edition} license ${issued.license_id}`} value={issued.key}>Give this key to the customer; it activates {issued.max_activations} server(s) and expires {issued.expires_at ? formatDate(issued.expires_at) : 'never'}.</SecretOnce><Link to={`/admin/licenses/${issued.license_id}`}>Open license</Link></Card>}
      {job && <Card title={`Bulk issue job ${job.id}`}><ProgressLog jobPath={`/admin/jobs/${job.id}`} renderResult={(j) => <><p>{j.result?.count} licenses issued. <a className="btn btn-sm" href={`/v1/admin/jobs/${j.id}?format=csv`}>Download CSV</a></p><pre className="log">{(j.result?.licenses || []).map((l) => `${l.key}  ${l.edition}  ${l.license_id}`).join('\n')}</pre></>} /></Card>}
      <Card padded={false}>
        <div className="filter-row" style={{ padding: '12px 16px 0' }}>
          <Select value={filters.status} onChange={(v) => setFilter('status', v)} options={LICENSE_STATUSES} placeholder="Any status" />
          <Select value={filters.edition} onChange={(v) => setFilter('edition', v)} options={EDITIONS} placeholder="Any edition" />
          <Select value={filters.expiring_within} onChange={(v) => setFilter('expiring_within', v)} options={[{ value: '7', label: 'Expiring in 7 days' }, { value: '30', label: 'Expiring in 30 days' }, { value: '90', label: 'Expiring in 90 days' }]} placeholder="Any expiry" />
        </div>
        <LicenseTable base="/admin" filters={filters} initialQ={params.get('q') || ''} linkTo={(r) => `/admin/licenses/${r.id}`} />
      </Card>
      <IssueLicenseModal open={issueOpen} onClose={() => setIssueOpen(false)} base="/admin" products={products.data} onIssued={setIssued} />
      <BulkIssueModal open={bulkOpen} onClose={() => setBulkOpen(false)} base="/admin" products={products.data} onQueued={setJob} />
    </>
  );
}
