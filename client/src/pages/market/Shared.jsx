import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { StatusPill, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Button, ErrorBanner } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';

export const money = (p, c) => (p == null ? '—' : `${Number(p).toFixed(2)} ${c || 'USD'}`);
export const TYPE_LABELS = { ssl: 'SSL certificates', plugin: 'Plugins' };

// The adapter catalog is root-only; resellers get the provider list alone.
export function useProviders({ isRoot = false } = {}) {
  const providers = useApi('/market/providers');
  const adapters = useApi('/market/adapters', { enabled: isRoot });
  return { providers, adapters, refetch: () => { providers.refetch(); if (isRoot) adapters.refetch(); } };
}

export function ProviderStatus({ p }) {
  if (p.readOnly) {
    if (!p.installed) return <StatusPill status="not-installed">not installed</StatusPill>;
    return <StatusPill status={p.enabled ? 'enabled' : 'inactive'}>{p.enabled ? 'AutoSSL provider' : 'installed'}</StatusPill>;
  }
  if (p.enabled) return <StatusPill status="enabled" />;
  return <StatusPill status={p.configured ? 'disabled' : 'pending'}>{p.configured ? 'disabled' : 'needs configuration'}</StatusPill>;
}

export function LastTest({ p }) {
  if (!p.lastTest) return <span className="muted">never</span>;
  return <span title={p.lastTest.message}><StatusPill status={p.lastTest.ok ? 'ok' : 'failed'}>{p.lastTest.ok ? 'passed' : 'failed'}</StatusPill> <small className="muted">{formatDate(p.lastTest.at)}</small></span>;
}

const emptyProduct = () => ({ id: '', name: '', price: null, currency: 'USD', termMonths: 12, wildcard: false });

export function ProductsEditor({ value, onChange, commissionPercent = 0 }) {
  const list = value || [];
  const set = (i, patch) => onChange(list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const resale = (price) => (price == null || price === '' ? null : Math.round(Number(price) * (1 + Number(commissionPercent || 0) / 100) * 100) / 100);
  return (
    <div className="table-wrap">
      <table className="dense">
        <thead><tr><th>ID</th><th>Name</th><th>Vendor price</th><th>Currency</th><th>Months</th><th>Wildcard</th><th>Resale</th><th /></tr></thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={8} className="table-state">No products. Add one or synchronise from the vendor.</td></tr>}
          {list.map((p, i) => (
            <tr key={i}>
              <td><TextInput value={p.id} onChange={(v) => set(i, { id: v })} placeholder="dv" style={{ width: 110 }} /></td>
              <td><TextInput value={p.name} onChange={(v) => set(i, { name: v })} placeholder="Domain Validated" /></td>
              <td><NumberInput value={p.price} onChange={(v) => set(i, { price: v })} min={0} step="0.01" style={{ width: 100 }} /></td>
              <td><TextInput value={p.currency} onChange={(v) => set(i, { currency: v.toUpperCase() })} maxLength={3} style={{ width: 70 }} /></td>
              <td><NumberInput value={p.termMonths} onChange={(v) => set(i, { termMonths: v })} nullable={false} min={1} max={120} style={{ width: 80 }} /></td>
              <td><Toggle checked={p.wildcard} onChange={(v) => set(i, { wildcard: v })} /></td>
              <td className="muted">{money(resale(p.price), p.currency)}</td>
              <td><button type="button" className="btn btn-sm btn-icon btn-danger-ghost" aria-label="Remove product" onClick={() => onChange(list.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: '8px 0' }}><Button size="sm" icon={Plus} onClick={() => onChange([...list, emptyProduct()])}>Add product</Button></div>
    </div>
  );
}

const cleanProducts = (list) => (list || []).filter((p) => p.id || p.name).map((p) => ({
  id: String(p.id || '').trim(), name: String(p.name || p.id || '').trim(), price: p.price === '' || p.price == null ? null : Number(p.price),
  currency: (p.currency || 'USD').toUpperCase(), termMonths: Number(p.termMonths) || 12, wildcard: Boolean(p.wildcard),
}));

// Create (provider == null) or edit a provider's identity, URL, commission and products.
export function ProviderFormModal({ open, provider, adapters, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(provider);
  const blank = { name: '', displayName: '', type: 'ssl', adapter: 'manual', url: '', commissionPercent: 0, products: [] };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(provider ? { name: provider.name, displayName: provider.displayName, type: provider.type, adapter: provider.adapter, url: provider.url || '', commissionPercent: provider.commissionPercent, products: (provider.products || []).map((p) => ({ ...p, price: p.basePrice ?? p.price })) } : blank);
  }, [open, provider]);
  const adapter = (adapters || []).find((a) => a.id === form.adapter);
  // Read-only adapters are reflected from elsewhere and singleton ones ship as a built-in row.
  const addable = (adapters || []).filter((a) => !a.readOnly && !a.singleton);
  const creatable = addable.filter((a) => a.types.includes(form.type));
  const typeOptions = Object.entries(TYPE_LABELS).filter(([value]) => editing || !adapters || addable.some((a) => a.types.includes(value))).map(([value, label]) => ({ value, label }));
  const hasProducts = form.type === 'ssl';

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const products = cleanProducts(form.products);
      let data;
      if (editing) {
        ({ data } = await api.put(`/market/providers/${provider.name}`, { displayName: form.displayName.trim(), url: form.url.trim() || null, commissionPercent: Number(form.commissionPercent) || 0, ...(hasProducts ? { products } : {}) }));
      } else {
        ({ data } = await api.post('/market/providers', { name: form.name.trim(), displayName: form.displayName.trim(), type: form.type, adapter: form.adapter, ...(form.url.trim() ? { url: form.url.trim() } : {}), commissionPercent: Number(form.commissionPercent) || 0, ...(hasProducts ? { products } : {}) }));
      }
      toast.success(`${data.displayName} ${editing ? 'updated' : 'added'}`);
      onSaved?.(data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={editing ? `Edit ${provider?.displayName}` : 'Add a provider'} onClose={onClose} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!form.displayName.trim() || (!editing && !form.name.trim())} onClick={save}>{editing ? 'Save' : 'Add provider'}</Button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Identifier" required={!editing} help="Lowercase letters, digits, - and _. Used in orders and the API."><TextInput value={form.name} onChange={(v) => setForm({ ...form, name: v.toLowerCase() })} disabled={editing} placeholder="sectigo" /></Field>
        <Field label="Display name" required><TextInput value={form.displayName} onChange={(v) => setForm({ ...form, displayName: v })} placeholder="Sectigo" /></Field>
        <Field label="Type" help={!editing && typeOptions.length < Object.keys(TYPE_LABELS).length ? 'The plugin marketplace hub is built in: configure "WHM Marketplace (plugin hub)" in the list instead.' : undefined}><Select value={form.type} onChange={(v) => { const next = addable.find((a) => a.types.includes(v)); setForm({ ...form, type: v, adapter: next?.id || form.adapter }); }} disabled={editing} options={typeOptions} /></Field>
        <Field label="Adapter" help={adapter?.configFields?.length ? `Credentials (${adapter.configFields.map((f) => f.label).join(', ')}) are entered under Configure.` : 'No credentials needed.'}><Select value={form.adapter} onChange={(v) => setForm({ ...form, adapter: v })} disabled={editing} options={creatable.map((a) => ({ value: a.id, label: a.label }))} /></Field>
        <Field label={form.type === 'plugin' ? 'Hub URL' : 'Vendor URL'} required={adapter?.requiresUrl} help="https:// only"><TextInput value={form.url} onChange={(v) => setForm({ ...form, url: v })} placeholder="https://" /></Field>
        <Field label="Commission (%)" help="Added on top of the vendor price when the product is offered to resellers and accounts."><NumberInput value={form.commissionPercent} onChange={(v) => setForm({ ...form, commissionPercent: v })} nullable={false} min={0} max={100} step="0.5" /></Field>
      </div>
      {hasProducts && (
        <Field label="Products" help={adapter?.hasProducts ? 'Edit by hand or use "Sync products" on the provider once its API is configured.' : 'Vendor price per product; the resale column includes the commission.'}>
          <ProductsEditor value={form.products} onChange={(products) => setForm({ ...form, products })} commissionPercent={form.commissionPercent} />
        </Field>
      )}
    </Modal>
  );
}

// Credentials and URL of a provider. Secret fields show whether a value is stored;
// leaving one blank keeps it, "Clear" removes it.
export function ConfigureModal({ open, provider, adapters, onClose, onSaved }) {
  const toast = useToast();
  const adapter = (adapters || []).find((a) => a.id === provider?.adapter);
  const [url, setUrl] = useState('');
  const [values, setValues] = useState({});
  const [clear, setClear] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open || !provider) return;
    setError(null); setClear({});
    setUrl(provider.url || '');
    setValues(Object.fromEntries((adapter?.configFields || []).map((f) => [f.key, f.secret ? '' : provider.config?.[f.key] || ''])));
  }, [open, provider, adapter]);
  if (!provider) return null;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const config = {};
      for (const f of adapter?.configFields || []) {
        if (clear[f.key]) config[f.key] = null;
        else if (f.secret) { if (values[f.key]) config[f.key] = values[f.key]; } else config[f.key] = values[f.key] || null;
      }
      const { data } = await api.put(`/market/providers/${provider.name}/config`, { url: url.trim() || null, config });
      toast.success(`${data.displayName} configured`);
      onSaved?.(data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={`Configure ${provider.displayName}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <ErrorBanner error={error} />
      <p className="muted">{adapter?.label}. Credentials are stored encrypted and never shown again.</p>
      <Field label={provider.type === 'plugin' ? 'Hub URL' : 'Vendor URL'} required={adapter?.requiresUrl} help="https:// only"><TextInput value={url} onChange={setUrl} placeholder="https://" /></Field>
      {(adapter?.configFields || []).map((f) => (
        <Field key={f.key} label={f.label} required={f.required} help={f.help}>
          {f.secret ? (
            <div className="row-actions" style={{ alignItems: 'center' }}>
              <TextInput type="password" value={values[f.key] || ''} onChange={(v) => setValues({ ...values, [f.key]: v })} disabled={Boolean(clear[f.key])} placeholder={provider.secretsSet?.includes(f.key) ? 'Stored; leave blank to keep' : 'Not set'} autoComplete="new-password" />
              {provider.secretsSet?.includes(f.key) && <Toggle checked={Boolean(clear[f.key])} onChange={(v) => setClear({ ...clear, [f.key]: v })} label="Clear" />}
            </div>
          ) : <TextInput value={values[f.key] || ''} onChange={(v) => setValues({ ...values, [f.key]: v })} />}
        </Field>
      ))}
      {!adapter?.configFields?.length && <p className="muted">This adapter needs no credentials.</p>}
    </Modal>
  );
}

export function TestResultCard({ result }) {
  if (!result) return null;
  return (
    <div className={`banner ${result.result.ok ? 'banner-success' : 'banner-error'}`} role="status">
      <div><strong>{result.provider.displayName}: {result.result.ok ? 'test passed' : 'test failed'}</strong><p>{result.result.message}</p></div>
    </div>
  );
}

