import { useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { StatusPill, KeyValue, formatDate } from '../../../../components/Common.jsx';
import { ErrorBanner } from '../../../../components/Form.jsx';
import { PanelCapabilityState, FeatureDisabledState, PendingPill } from '../../../../panel/PanelPage.jsx';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

export function isFeatureDisabled(error) {
  return Boolean(error) && error.status === 403 && error.code === 'feature_disabled';
}

// One error display for a panel request: plan gate, missing daemon, or a plain failure.
export function RequestError({ error, fn, onRetry }) {
  if (!error) return null;
  if (isFeatureDisabled(error)) return <FeatureDisabledState fn={fn} />;
  if (isCapabilityError(error)) return <PanelCapabilityState error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export const WEB_TYPES = ['main', 'addon', 'sub', 'parked', 'alias'];

// The hostnames an account answers for: the main domain plus every row of /me.
export function accountDomains(me) {
  const rows = (me?.account?.domains || []).filter((d) => !d.type || WEB_TYPES.includes(d.type));
  const main = me?.account?.domain;
  const list = main && !rows.some((d) => d.domain === main) ? [{ domain: main, type: 'main' }, ...rows] : rows;
  return list.map((d) => ({ domain: d.domain, type: d.type || 'main', docroot: d.docroot || null }));
}

// A host-side result that did not reach the web server reads as "pending" for the customer.
export function webResult(web, detail) {
  if (web === 'applied') return { applied: true };
  return { applied: false, reason: typeof detail === 'string' && detail ? detail : typeof web === 'string' ? web : 'pending' };
}

export function WebStatus({ web, detail }) {
  const r = webResult(web, detail);
  if (r.applied) return <StatusPill status="ok">applied</StatusPill>;
  return <PendingPill result={r} />;
}

export function ExpiryPill({ notAfter, daysRemaining }) {
  if (!notAfter) return <span className="muted">—</span>;
  const days = daysRemaining ?? Math.floor((new Date(notAfter).getTime() - Date.now()) / 86_400_000);
  const status = days < 0 ? 'failed' : days <= 7 ? 'failed' : days <= 30 ? 'warning' : 'ok';
  const date = formatDate(notAfter).split(',')[0];
  return <StatusPill status={status}>{days < 0 ? `expired ${-days} days ago` : `${days} days · ${date}`}</StatusPill>;
}

export function StatePill({ state }) {
  const map = { installed: 'ok', pending: 'pending', stored: 'unknown', unmanaged: 'unknown' };
  const label = { installed: 'installed', pending: 'files written, web server pending', stored: 'stored', unmanaged: 'files only' };
  return <StatusPill status={map[state] || 'unknown'}>{label[state] || state}</StatusPill>;
}

export function TypePill({ type }) {
  const label = { main: 'main', addon: 'addon', sub: 'subdomain', parked: 'parked', alias: 'alias' };
  return <StatusPill status="unknown">{label[type] || type}</StatusPill>;
}

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

// Read-only PEM block with copy and save buttons (used for generated CSRs and keys).
export function PemView({ label, value, filename, rows = 8, help }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-control">
        <textarea className="input textarea mono" rows={rows} readOnly value={value} spellCheck={false} />
        {help && <div className="field-help">{help}</div>}
        <div className="form-actions" style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-sm" onClick={copy}><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
          {filename && <button type="button" className="btn btn-sm" onClick={() => downloadText(filename, value)}><Download size={14} /> Save as {filename}</button>}
        </div>
      </div>
    </div>
  );
}

export function CertificateSummary({ certificate, chain }) {
  if (!certificate) return null;
  const c = certificate;
  return (
    <KeyValue items={[
      ['Issued to', c.commonName || c.subjectText],
      c.sans?.length > 0 && ['Also covers', c.sans.join(', ')],
      ['Issued by', c.selfSigned ? 'Self-signed' : c.issuerCommonName || c.issuerText],
      ['Valid from', c.notBefore && formatDate(c.notBefore)],
      ['Expires', <ExpiryPill key="e" notAfter={c.notAfter} daysRemaining={c.daysRemaining} />],
      c.keyAlgorithm && ['Key', `${c.keyAlgorithm}${c.keyBits ? ` ${c.keyBits}-bit` : ''}${c.curve ? ` (${c.curve})` : ''}`],
      c.fingerprintSha256 && ['Fingerprint (SHA-256)', <code key="f" className="small">{c.fingerprintSha256}</code>],
      chain && ['Chain', chain.ok ? <StatusPill key="c" status="ok">verified</StatusPill> : <StatusPill key="c" status="warning">{chain.error || 'not verified'}</StatusPill>],
    ]} />
  );
}

export const KEY_TYPES = [{ value: 'rsa', label: 'RSA' }, { value: 'ec', label: 'ECDSA' }];
export const RSA_BITS = ['2048', '3072', '4096'];
export const EC_CURVES = [{ value: 'prime256v1', label: 'P-256 (prime256v1)' }, { value: 'secp384r1', label: 'P-384 (secp384r1)' }];

export function parseSans(text) {
  return [...new Set(String(text || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export function cleanSubject(subject) {
  return Object.fromEntries(Object.entries(subject || {}).filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => [k, String(v).trim()]));
}

// Trailing newline: the API's PEM shapes end with the END line and optional whitespace.
export function pem(text) {
  const v = String(text || '').trim();
  return v ? `${v}\n` : '';
}
