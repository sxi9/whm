import { useState } from 'react';
import { Modal } from '../components/Modal.jsx';
import { Field, TextInput, Textarea, Select, Button, ErrorBanner } from '../components/Form.jsx';

// Hub-native building blocks shared by the three portals.

export function Stat({ label, value, hint, tone }) {
  return <div className={`stat ${tone ? `stat-${tone}` : ''}`}><div className="label">{label}</div><div className="value">{value ?? '—'}</div>{hint && <div className="hint">{hint}</div>}</div>;
}
export function StatGrid({ children }) { return <div className="stat-grid">{children}</div>; }

export function money(cents, currency = 'USD') {
  if (cents == null || Number.isNaN(Number(cents))) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(cents) / 100); } catch { return `${(Number(cents) / 100).toFixed(2)} ${currency}`; }
}

export function shortDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

export function limitLabel(v) {
  return v === -1 ? 'unlimited' : v == null ? '—' : String(v);
}

export function SecretOnce({ label = 'Shown once', value, children }) {
  if (!value) return null;
  return <div className="secret-once"><strong>{label}</strong><code>{value}</code><span className="muted">{children || 'Copy it now; the hub stores only a hash.'}</span></div>;
}

export function JsonBlock({ value }) {
  return <pre className="code-block">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function MiniBars({ points, valueKey = 'n', labelKey = 'day' }) {
  const rows = Array.isArray(points) ? points : [];
  const max = Math.max(1, ...rows.map((p) => Number(p[valueKey]) || 0));
  if (!rows.length) return <p className="muted">No data yet.</p>;
  return <div className="mini-bars" aria-label="bar chart">{rows.map((p) => <span key={p[labelKey]} title={`${p[labelKey]}: ${p[valueKey]}`} style={{ height: `${Math.max(4, (Number(p[valueKey]) || 0) / max * 100)}%` }} />)}</div>;
}

export function Tabs({ tabs, value, onChange }) {
  return <div className="tabs" role="tablist">{tabs.map((t) => <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}>{t.label}</button>)}</div>;
}

// A modal that collects a reason (and optional extra select) before a
// dangerous action: suspend, revoke, reject, hold, yank …
export function ReasonModal({ open, title, label = 'Reason', confirmLabel = 'Confirm', danger = true, onClose, onConfirm, options = null, optionsLabel = 'Code', required = true, help }) {
  const [reason, setReason] = useState('');
  const [code, setCode] = useState(options?.[0]?.value || options?.[0] || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await onConfirm({ reason: reason.trim(), code: options ? code : undefined }); setReason(''); onClose(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title={title} onClose={onClose} size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={required && !reason.trim()} onClick={submit}>{confirmLabel}</Button></>}>
      <ErrorBanner error={error} />
      {options && <Field label={optionsLabel}><Select value={code} onChange={setCode} options={options} /></Field>}
      <Field label={label} help={help}><Textarea value={reason} onChange={setReason} rows={3} /></Field>
    </Modal>
  );
}

// Modal form with a list of { key, label, type, options, help, required } fields.
export function FormModal({ open, title, fields, initial = {}, onClose, onSubmit, submitLabel = 'Save', size = 'md' }) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const submit = async () => {
    setBusy(true); setError(null);
    try { await onSubmit(draft); onClose(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const missing = fields.some((f) => f.required && (draft[f.key] === undefined || draft[f.key] === null || draft[f.key] === ''));
  return (
    <Modal open={open} title={title} onClose={onClose} size={size} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={missing} onClick={submit}>{submitLabel}</Button></>}>
      <ErrorBanner error={error} />
      {fields.map((f) => (
        <Field key={f.key} label={f.label} help={f.help} required={f.required} error={error?.fields?.[f.key]}>
          {f.type === 'select' ? <Select value={draft[f.key]} onChange={(v) => set(f.key, v)} options={f.options} placeholder={f.placeholder} />
            : f.type === 'textarea' ? <Textarea value={draft[f.key]} onChange={(v) => set(f.key, v)} rows={f.rows || 4} mono={f.mono} />
              : f.type === 'number' ? <TextInput type="number" value={draft[f.key] ?? ''} onChange={(v) => set(f.key, v === '' ? null : Number(v))} min={f.min} max={f.max} />
                : <TextInput type={f.type || 'text'} value={draft[f.key] ?? ''} onChange={(v) => set(f.key, v)} placeholder={f.placeholder} />}
        </Field>
      ))}
    </Modal>
  );
}

export function KV({ items }) {
  return <dl className="kv">{items.filter(Boolean).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v ?? <span className="muted">—</span>}</dd></div>)}</dl>;
}
