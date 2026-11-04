import { AlertTriangle, Info } from 'lucide-react';
import { ErrorBanner, Field, TextInput } from '../../../../components/Form.jsx';
import { Modal } from '../../../../components/Modal.jsx';
import { ProgressLog } from '../../../../components/ProgressLog.jsx';
import { percentOf, meterTone } from '../../../../panel/hooks/usePanel.js';

export const PRIVILEGES = ['ALL PRIVILEGES', 'ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE', 'CREATE TEMPORARY TABLES', 'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'INDEX', 'INSERT', 'LOCK TABLES', 'REFERENCES', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'UPDATE'];
export const PG_PRIVILEGES = ['ALL PRIVILEGES', 'CONNECT', 'CREATE', 'TEMPORARY'];

export const engineLabel = (engine) => ({ mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL' }[engine] || 'MySQL');

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

export function isFeatureDisabled(error) {
  return Boolean(error) && error.status === 403 && error.code === 'feature_disabled';
}

export function isLimitReached(error) {
  return Boolean(error) && (error.code === 'limit_reached' || (error.status === 409 && /allows/.test(error.message || '')));
}

// Errors a form shows itself: plan limits as an info notice, validation with
// its fields, everything else as the plain error banner. Capability errors are
// rendered by PanelCapabilityState next to it, never twice.
export function RequestError({ error, onRetry }) {
  if (!error || isCapabilityError(error) || isFeatureDisabled(error)) return null;
  if (isLimitReached(error)) {
    return (
      <div className="banner banner-warning" role="alert">
        <AlertTriangle size={18} />
        <div><strong>Plan limit reached</strong><p>{error.message}</p><p className="muted">Ask your hosting provider about a larger plan, or remove something you no longer need.</p></div>
      </div>
    );
  }
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

// Fixed, non-editable prefix in front of a name input: the panel always creates
// `<username>_<name>`, whatever the user types.
export function PrefixedInput({ prefix, value, onChange, placeholder, maxLength, id, disabled }) {
  return (
    <div className="input-group">
      <input className="input" value={prefix} readOnly tabIndex={-1} aria-label="Fixed prefix" style={{ flex: '0 0 auto', width: `calc(${prefix.length}ch + 32px)` }} />
      <TextInput id={id} value={value} onChange={(v) => onChange(v.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder={placeholder} maxLength={maxLength} disabled={disabled} autoCapitalize="none" spellCheck={false} />
    </div>
  );
}

export function NameField({ label, prefix, value, onChange, placeholder, maxLength, error, help, id, disabled, required = true }) {
  const full = `${prefix}${value || ''}`;
  return (
    <Field label={label} required={required} error={error} help={help ?? (value ? <>Will be created as <code>{full}</code></> : 'Lowercase letters, digits and underscores')} htmlFor={id}>
      <PrefixedInput id={id} prefix={prefix} value={value} onChange={onChange} placeholder={placeholder} maxLength={maxLength} disabled={disabled} />
    </Field>
  );
}

// "3 of 10" with a meter; unlimited plans (null) show the count alone and a plan
// limit of 0 says the object is not included (the server's assertLimit convention).
export function QuotaStat({ label, used, max, noun }) {
  const unlimited = max == null;
  const notIncluded = max === 0;
  const percent = unlimited || notIncluded ? null : percentOf(used, max);
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{used ?? 0}{!unlimited && !notIncluded && <span className="muted" style={{ fontSize: 15, fontWeight: 500 }}> of {max}</span>}</div>
      <div className="muted small">{unlimited ? `No limit on ${noun} in this plan` : notIncluded ? `No ${noun} in your plan` : percent >= 100 ? `Plan limit reached` : `${Math.max(0, max - (used ?? 0))} more allowed by the plan`}</div>
      {percent != null && <div className={`meter ${meterTone(percent)}`}><span style={{ width: `${percent}%` }} /></div>}
    </div>
  );
}

export function EngineWarning({ engineError }) {
  if (!engineError) return null;
  return (
    <div className="banner banner-warning">
      <AlertTriangle size={18} />
      <div><strong>Database server unreachable</strong><p>{engineError.message} Sizes and table counts are unavailable; the list shows the panel's records.</p></div>
    </div>
  );
}

export function InfoNote({ children }) {
  return <div className="banner banner-info"><Info size={18} /><div>{children}</div></div>;
}

// The account follows its own database jobs here: /api/system/jobs is reseller-only.
export const jobStreamPath = (id) => `/panel/databases/jobs/${id}/stream`;

// A 202 job followed live; closes on request, the parent refetches on finish.
export function JobModal({ job, title, onClose, onFinished, children }) {
  return (
    <Modal open={Boolean(job)} title={title} onClose={onClose} size="lg" footer={<button className="btn btn-primary" onClick={onClose}>Close</button>}>
      {children}
      {job && <ProgressLog jobId={job.id} onFinished={onFinished} streamPath={jobStreamPath} />}
    </Modal>
  );
}

export function joinCodes(list, empty = 'none') {
  if (!list?.length) return <span className="muted">{empty}</span>;
  return list.map((h, i) => <span key={h}>{i > 0 && ' '}<code>{h}</code></span>);
}
