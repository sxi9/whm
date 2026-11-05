import { useEffect, useRef, useState } from 'react';
import { Copy, Download, Clock } from 'lucide-react';
import { Card, StatusPill, KeyValue, formatDate } from '../../../../components/Common.jsx';
import { ErrorBanner } from '../../../../components/Form.jsx';
import { ProgressLog } from '../../../../components/ProgressLog.jsx';
import { PanelCapabilityState, FeatureDisabledState, PendingPill } from '../../../../panel/PanelPage.jsx';
import { usePanelMe } from '../../../../panel/hooks/usePanel.js';
import { useT } from '../../../../i18n/useT.js';
import { fill } from '../../../../i18n/fill.js';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

export function isFeatureDisabled(error) {
  return Boolean(error) && error.status === 403 && error.code === 'feature_disabled';
}

// One error display for a panel request: plan gate, missing daemon, or a plain failure.
// The 501 state sits on its own card surface unless `inline` (already inside a card or modal).
export function RequestError({ error, fn, onRetry, inline = false }) {
  if (!error) return null;
  if (isFeatureDisabled(error)) return <FeatureDisabledState fn={fn} />;
  if (isCapabilityError(error)) {
    const state = <PanelCapabilityState error={error} onRetry={onRetry} />;
    return inline ? state : <Card>{state}</Card>;
  }
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

// The job stream (/api/system/jobs/:id/stream) answers 403 for role `user`, so a
// customer gets a notice and periodic refetches instead of the live log.
export function canStreamJobs(me) {
  const role = me?.user?.role;
  return role === 'root' || role === 'reseller';
}

export function JobProgress({ jobId, onFinished, message, pollMs = 5000, polls = 12 }) {
  const { t } = useT();
  const { me } = usePanelMe();
  const streaming = canStreamJobs(me);
  const finishedRef = useRef(onFinished);
  useEffect(() => { finishedRef.current = onFinished; }, [onFinished]);
  useEffect(() => {
    if (!jobId || streaming) return undefined;
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      finishedRef.current?.();
      if (n >= polls) clearInterval(timer);
    }, pollMs);
    return () => clearInterval(timer);
  }, [jobId, streaming, pollMs, polls]);
  if (!jobId) return null;
  if (streaming) return <ProgressLog jobId={jobId} onFinished={onFinished} />;
  return (
    <div className="banner banner-info" data-job={jobId}>
      <Clock size={18} />
      <div>
        <strong>{message ?? t('panel.ssl.job_started', 'Started; this screen updates in a minute.')}</strong>
        <p className="muted">{t('panel.ssl.job_background', 'The server is working on it in the background; there is nothing else to do here.')}</p>
      </div>
    </div>
  );
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
  const { t } = useT();
  const r = webResult(web, detail);
  if (r.applied) return <StatusPill status="ok">{t('panel.ssl.web_applied', 'applied')}</StatusPill>;
  return <PendingPill result={r} />;
}

export function ExpiryPill({ notAfter, daysRemaining }) {
  const { t } = useT();
  if (!notAfter) return <span className="muted">—</span>;
  const days = daysRemaining ?? Math.floor((new Date(notAfter).getTime() - Date.now()) / 86_400_000);
  const status = days < 0 ? 'failed' : days <= 7 ? 'failed' : days <= 30 ? 'warning' : 'ok';
  const date = formatDate(notAfter).split(',')[0];
  return <StatusPill status={status}>{days < 0 ? fill(t('panel.ssl.expired_ago', 'expired {days} days ago'), { days: -days }) : fill(t('panel.ssl.days_left', '{days} days · {date}'), { days, date })}</StatusPill>;
}

export function StatePill({ state }) {
  const { t } = useT();
  const map = { installed: 'ok', pending: 'pending', stored: 'unknown', unmanaged: 'unknown' };
  const label = { installed: t('panel.ssl.state_installed', 'installed'), pending: t('panel.ssl.state_pending', 'files written, web server pending'), stored: t('panel.ssl.state_stored', 'stored'), unmanaged: t('panel.ssl.state_unmanaged', 'files only') };
  return <StatusPill status={map[state] || 'unknown'}>{label[state] || state}</StatusPill>;
}

export function TypePill({ type }) {
  const { t } = useT();
  const label = { main: t('panel.ssl.type_main', 'main'), addon: t('panel.ssl.type_addon', 'addon'), sub: t('panel.ssl.type_sub', 'subdomain'), parked: t('panel.ssl.type_parked', 'parked'), alias: t('panel.ssl.type_alias', 'alias') };
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
  const { t } = useT();
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
          <button type="button" className="btn btn-sm" onClick={copy}><Copy size={14} /> {copied ? t('panel.ssl.copied', 'Copied') : t('panel.ssl.copy', 'Copy')}</button>
          {filename && <button type="button" className="btn btn-sm" onClick={() => downloadText(filename, value)}><Download size={14} /> {fill(t('panel.ssl.save_as', 'Save as {filename}'), { filename })}</button>}
        </div>
      </div>
    </div>
  );
}

export function CertificateSummary({ certificate, chain }) {
  const { t } = useT();
  if (!certificate) return null;
  const c = certificate;
  return (
    <KeyValue items={[
      [t('panel.ssl.issued_to', 'Issued to'), c.commonName || c.subjectText],
      c.sans?.length > 0 && [t('panel.ssl.also_covers', 'Also covers'), c.sans.join(', ')],
      [t('panel.ssl.issued_by', 'Issued by'), c.selfSigned ? t('panel.ssl.self_signed', 'Self-signed') : c.issuerCommonName || c.issuerText],
      [t('panel.ssl.valid_from', 'Valid from'), c.notBefore && formatDate(c.notBefore)],
      [t('panel.ssl.expires', 'Expires'), <ExpiryPill key="e" notAfter={c.notAfter} daysRemaining={c.daysRemaining} />],
      c.keyAlgorithm && [t('panel.ssl.key', 'Key'), `${c.keyAlgorithm}${c.keyBits ? ` ${c.keyBits}-bit` : ''}${c.curve ? ` (${c.curve})` : ''}`],
      c.fingerprintSha256 && [t('panel.ssl.fingerprint', 'Fingerprint (SHA-256)'), <code key="f" className="small">{c.fingerprintSha256}</code>],
      chain && [t('panel.ssl.chain', 'Chain'), chain.ok ? <StatusPill key="c" status="ok">{t('panel.ssl.chain_verified', 'verified')}</StatusPill> : <StatusPill key="c" status="warning">{chain.error || t('panel.ssl.chain_not_verified', 'not verified')}</StatusPill>],
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
