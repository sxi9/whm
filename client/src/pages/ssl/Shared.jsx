import { useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { useApi } from '../../hooks/useApi.js';
import { StatusPill, KeyValue, CapabilityNotice, formatDate } from '../../components/Common.jsx';
import { Field, Select, Textarea, TextInput, Button, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

// Error display that distinguishes "install the daemon" from real failures.
export function RequestError({ error, onRetry }) {
  if (!error) return null;
  if (isCapabilityError(error)) return <CapabilityNotice error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="row-actions" role="tablist" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value} className={`btn btn-sm ${value === t.value ? 'btn-primary' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}{t.count != null && <span className="pill pill-muted" style={{ marginLeft: 6 }}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export const KEY_TYPES = [{ value: 'rsa', label: 'RSA' }, { value: 'ec', label: 'ECDSA (EC)' }];
export const RSA_BITS = ['2048', '3072', '4096'];
export const EC_CURVES = [{ value: 'prime256v1', label: 'P-256 (prime256v1)' }, { value: 'secp384r1', label: 'P-384 (secp384r1)' }];

export function downloadText(filename, content) {
  const blob = new Blob([content], { type: 'application/x-pem-file' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Expiry as a pill: red when expired or within 7 days, amber within 30.
export function ExpiryPill({ notAfter, daysRemaining }) {
  if (!notAfter) return <span className="muted">—</span>;
  const days = daysRemaining ?? Math.floor((new Date(notAfter).getTime() - Date.now()) / 86_400_000);
  const status = days < 0 ? 'failed' : days <= 7 ? 'failed' : days <= 30 ? 'warning' : 'ok';
  return <StatusPill status={status}>{days < 0 ? `expired ${-days}d ago` : `${days}d · ${formatDate(notAfter).split(',')[0]}`}</StatusPill>;
}

export function StatePill({ state }) {
  const map = { installed: 'ok', pending: 'pending', stored: 'inactive', unmanaged: 'unknown' };
  const label = { installed: 'installed', pending: 'files written · vhost pending', stored: 'stored', unmanaged: 'files only (not in panel)' };
  return <StatusPill status={map[state] || 'unknown'}>{label[state] || state}</StatusPill>;
}

// Read-only PEM block with copy and download buttons.
export function PemView({ label, value, filename, rows = 8 }) {
  const toast = useToast();
  if (!value) return null;
  return (
    <Field label={label}>
      <Textarea value={value} onChange={() => {}} rows={rows} mono readOnly />
      <div className="row-actions" style={{ marginTop: 6 }}>
        <Button size="sm" icon={Copy} onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success(`${label} copied`))}>Copy</Button>
        {filename && <Button size="sm" icon={Download} onClick={() => downloadText(filename, value)}>Download</Button>}
      </div>
    </Field>
  );
}

export function CertificateSummary({ certificate, chain }) {
  if (!certificate) return null;
  const c = certificate;
  return (
    <KeyValue items={[
      ['Common name', <code key="cn">{c.commonName || '—'}</code>],
      ['Alternative names', c.sans?.length ? c.sans.join(', ') : '—'],
      ['Issuer', c.selfSigned ? <StatusPill key="ss" status="warning">self-signed</StatusPill> : `${c.issuerCommonName || c.issuerText || '—'}${c.issuerOrganization ? ` (${c.issuerOrganization})` : ''}`],
      ['Valid from', formatDate(c.notBefore)],
      ['Expires', <ExpiryPill key="exp" notAfter={c.notAfter} daysRemaining={c.daysRemaining} />],
      ['Key', c.keyAlgorithm ? `${c.keyAlgorithm} ${c.keyBits ? `${c.keyBits} bit` : ''}${c.curve ? ` ${c.curve}` : ''}` : '—'],
      ['Signature', c.signatureAlgorithm],
      ['SHA-256 fingerprint', <code key="fp" className="small">{c.fingerprintSha256 || '—'}</code>],
      chain && ['Chain verification', <StatusPill key="chain" status={chain.ok ? 'ok' : 'warning'}>{chain.ok ? 'trusted by the system CA store' : chain.error || 'not verified'}</StatusPill>],
    ]} />
  );
}

// Picks one of the domains the caller may manage (accounts' main, addon, sub and parked domains).
export function DomainSelect({ value, onChange, allowCustom = true, placeholder = 'Select a domain…', help }) {
  const { data } = useApi('/ssl/domains');
  const [custom, setCustom] = useState(false);
  const options = (data || []).map((d) => ({ value: d.domain, label: `${d.domain} (${d.account}${d.type !== 'main' ? `, ${d.type}` : ''})${d.certificate ? ' · has certificate' : ''}` }));
  if (custom) {
    return (
      <>
        <TextInput value={value} onChange={onChange} placeholder="hostname.example.com" />
        <div className="field-help">{help || 'Any hostname this server answers for (root only).'} <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCustom(false)}>Pick from accounts</button></div>
      </>
    );
  }
  return (
    <>
      <Select value={value} onChange={onChange} options={options} placeholder={placeholder} />
      {allowCustom && <div className="field-help">{help} <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCustom(true)}>Type another hostname</button></div>}
    </>
  );
}

export function AccountSelect({ value, onChange, placeholder = 'Server (no account)' }) {
  const { data } = useApi('/accounts?pageSize=500&sort=username');
  return <Select value={value} onChange={onChange} options={(data || []).map((a) => ({ value: a.username, label: `${a.username} — ${a.domain}` }))} placeholder={placeholder} />;
}

// Shared key-generation fields (type / bits / curve) used by CSR and self-signed forms.
export function KeySpecFields({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <>
      <Field label="Key type"><Select value={value.type} onChange={(v) => set({ type: v })} options={KEY_TYPES} /></Field>
      {value.type === 'rsa'
        ? <Field label="Key size" help="2048 bits is the minimum CAs accept; 4096 is slower on every handshake."><Select value={String(value.bits)} onChange={(v) => set({ bits: Number(v) })} options={RSA_BITS} /></Field>
        : <Field label="Curve"><Select value={value.curve} onChange={(v) => set({ curve: v })} options={EC_CURVES} /></Field>}
    </>
  );
}

export function SubjectFields({ value, onChange }) {
  const set = (k) => (v) => onChange({ ...value, [k]: v });
  return (
    <>
      <Field label="Organization (O)"><TextInput value={value.O} onChange={set('O')} placeholder="Acme, Inc." /></Field>
      <Field label="Organizational unit (OU)"><TextInput value={value.OU} onChange={set('OU')} placeholder="IT" /></Field>
      <Field label="City (L)"><TextInput value={value.L} onChange={set('L')} /></Field>
      <Field label="State / province (ST)"><TextInput value={value.ST} onChange={set('ST')} /></Field>
      <Field label="Country (C)" help="Two-letter ISO code, e.g. US, DE."><TextInput value={value.C} onChange={(v) => set('C')(v.toUpperCase())} maxLength={2} style={{ maxWidth: 80 }} /></Field>
      <Field label="Contact email"><TextInput value={value.emailAddress} onChange={set('emailAddress')} type="email" /></Field>
    </>
  );
}

export function cleanSubject(subject) {
  return Object.fromEntries(Object.entries(subject).filter(([, v]) => v && String(v).trim()).map(([k, v]) => [k, String(v).trim()]));
}

export function parseSans(text) {
  return [...new Set(String(text || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}
