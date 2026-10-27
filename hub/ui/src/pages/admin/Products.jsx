import { useState } from 'react';
import { PageHeader, Card, StatusPill } from '../../components/Common.jsx';
import { Button, ErrorBanner, Field, NumberInput, TextInput, Select, Toggle } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { money, limitLabel } from '../../widgets/index.jsx';
import { EDITIONS } from './Licenses.jsx';

export const FEATURE_FLAGS = ['api', 'transfers', 'clusters', 'multi_server', 'marketplace_free', 'marketplace_paid', 'white_label', 'autossl_wildcard', 'sso', 'terminal', 'priority_support', 'custom_branding_builder'];
export const LIMIT_KEYS = ['max_accounts', 'max_resellers', 'max_domains_per_account', 'max_activations', 'grace_days'];
const TERMS = ['days', 'monthly', 'annual', 'contract'];

function ProductForm({ product, onClose, onSaved }) {
  const isNew = !product?.sku;
  const [draft, setDraft] = useState(() => ({
    sku: product?.sku || '', name: product?.name || '', edition: product?.edition || 'solo', rank: product?.rank ?? 20, term: product?.term || 'annual', term_days: product?.term_days ?? null,
    price_cents: product?.price_cents ?? 0, currency: product?.currency || 'USD', active: product?.active ?? true,
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, product?.limits?.[k] ?? (k === 'max_activations' ? 1 : k === 'grace_days' ? 7 : -1)])),
    features: Object.fromEntries(FEATURE_FLAGS.map((f) => [f, product?.features?.[f] === true])),
  }));
  const { run, busy, error } = useAction();
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const save = () => run(async () => {
    const body = { name: draft.name, edition: draft.edition, rank: Number(draft.rank), term: draft.term, term_days: draft.term === 'days' ? Number(draft.term_days || 14) : null, price_cents: Number(draft.price_cents), currency: draft.currency.toUpperCase(), active: draft.active, limits: draft.limits, features: draft.features };
    if (isNew) await api.post('/admin/products', { sku: draft.sku, ...body }); else await api.put(`/admin/products/${product.sku}`, body);
  }, { success: 'Product saved', then: async () => { await onSaved(); onClose(); } });
  return (
    <Modal open title={isNew ? 'New product' : `Edit ${product.sku}`} onClose={onClose} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save} disabled={!draft.name || (isNew && !draft.sku)}>Save</Button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="SKU" required help="lower-case, e.g. whm-pro-annual"><TextInput value={draft.sku} onChange={(v) => set('sku', v)} disabled={!isNew} /></Field>
        <Field label="Name" required><TextInput value={draft.name} onChange={(v) => set('name', v)} /></Field>
        <Field label="Edition"><Select value={draft.edition} onChange={(v) => set('edition', v)} options={EDITIONS} /></Field>
        <Field label="Rank" help="Editions are ordered: upgrades go up in rank"><NumberInput value={draft.rank} nullable={false} onChange={(v) => set('rank', v)} min={0} max={1000} /></Field>
        <Field label="Term"><Select value={draft.term} onChange={(v) => set('term', v)} options={TERMS} /></Field>
        {draft.term === 'days' && <Field label="Term days"><NumberInput value={draft.term_days} onChange={(v) => set('term_days', v)} min={1} max={3650} /></Field>}
        <Field label="Price (cents)"><NumberInput value={draft.price_cents} nullable={false} onChange={(v) => set('price_cents', v)} min={0} /></Field>
        <Field label="Currency"><TextInput value={draft.currency} onChange={(v) => set('currency', v)} maxLength={3} /></Field>
      </div>
      <Field inline><Toggle checked={draft.active} onChange={(v) => set('active', v)} label="Active (issuable)" /></Field>
      <h3>Limits (-1 = unlimited)</h3>
      <div className="form-grid">{LIMIT_KEYS.map((k) => <Field key={k} label={k}><NumberInput value={draft.limits[k]} nullable={false} onChange={(v) => set('limits', { ...draft.limits, [k]: v })} min={-1} /></Field>)}</div>
      <h3>Feature flags</h3>
      <div className="form-grid">{FEATURE_FLAGS.map((f) => <Field key={f} inline><Toggle checked={draft.features[f]} onChange={(v) => set('features', { ...draft.features, [f]: v })} label={f} /></Field>)}</div>
    </Modal>
  );
}

export default function Products() {
  const { data, error, refetch } = useApi('/admin/products');
  const [editing, setEditing] = useState(null);
  const rows = [...(data || [])].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return (
    <>
      <PageHeader title="Products" description="Editions matrix: limits × features × price. Licenses snapshot the product at issue time." home="/admin" actions={<Button variant="primary" onClick={() => setEditing({})}>New product</Button>} />
      <ErrorBanner error={error} onRetry={refetch} />
      <Card padded={false}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>SKU</th><th>Edition</th><th>Rank</th><th>Term</th><th>Price</th><th>Accounts</th><th>Resellers</th><th>Servers</th><th>Features</th><th>Active</th><th /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.sku}>
                  <td><strong>{p.name}</strong><br /><code>{p.sku}</code></td><td>{p.edition}</td><td>{p.rank}</td><td>{p.term}{p.term === 'days' ? ` (${p.term_days})` : ''}</td><td>{money(p.price_cents, p.currency)}</td>
                  <td>{limitLabel(p.limits?.max_accounts)}</td><td>{limitLabel(p.limits?.max_resellers)}</td><td>{limitLabel(p.limits?.max_activations)}</td>
                  <td><div className="inline-list">{Object.entries(p.features || {}).filter(([, v]) => v).map(([k]) => <span key={k} className="pill pill-muted">{k}</span>)}</div></td>
                  <td><StatusPill status={p.active ? 'active' : 'disabled'} /></td>
                  <td><Button size="sm" onClick={() => setEditing(p)}>Edit</Button></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={11} className="muted">No products.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      {editing && <ProductForm product={editing} onClose={() => setEditing(null)} onSaved={refetch} />}
    </>
  );
}
