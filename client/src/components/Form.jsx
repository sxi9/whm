import { useMemo, useState } from 'react';
import { Eye, EyeOff, RefreshCw } from 'lucide-react';

export function Field({ label, help, error, required, children, inline = false, htmlFor }) {
  const errors = Array.isArray(error) ? error : error ? [error] : [];
  return (
    <div className={`field ${inline ? 'field-inline' : ''} ${errors.length ? 'field-error' : ''}`}>
      {label && <label className="field-label" htmlFor={htmlFor}>{label}{required && <span className="required">*</span>}</label>}
      <div className="field-control">
        {children}
        {help && !errors.length && <div className="field-help">{help}</div>}
        {errors.map((e, i) => <div key={i} className="field-message">{e}</div>)}
      </div>
    </div>
  );
}

export function TextInput({ value, onChange, type = 'text', ...rest }) {
  return <input className="input" type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

export function NumberInput({ value, onChange, nullable = true, ...rest }) {
  return (
    <input className="input" type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? (nullable ? null : 0) : Number(e.target.value))} {...rest} />
  );
}

export function Textarea({ value, onChange, rows = 6, mono = false, ...rest }) {
  return <textarea className={`input textarea ${mono ? 'mono' : ''}`} rows={rows} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

export function Select({ value, onChange, options, placeholder, ...rest }) {
  return (
    <select className="input select" value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>))}
    </select>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {(label || description) && (
        <span className="toggle-text">
          {label && <span className="toggle-label">{label}</span>}
          {description && <span className="toggle-description">{description}</span>}
        </span>
      )}
    </label>
  );
}

export function RadioGroup({ value, onChange, options, name }) {
  return (
    <div className="radio-group">
      {options.map((o) => (
        <label key={o.value} className="radio">
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span><strong>{o.label}</strong>{o.description && <small>{o.description}</small>}</span>
        </label>
      ))}
    </div>
  );
}

export function passwordStrength(pw) {
  if (!pw) return 0;
  let score = Math.min(40, pw.length * 4);
  if (/[a-z]/.test(pw)) score += 10;
  if (/[A-Z]/.test(pw)) score += 15;
  if (/\d/.test(pw)) score += 15;
  if (/[^A-Za-z0-9]/.test(pw)) score += 20;
  if (/(.)\1{2,}/.test(pw)) score -= 15;
  if (/^(password|123456|qwerty|letmein)/i.test(pw)) score = 5;
  return Math.max(0, Math.min(100, score));
}

export function generatePassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function PasswordInput({ value, onChange, showStrength = true, allowGenerate = true, minStrength = 65, ...rest }) {
  const [visible, setVisible] = useState(false);
  const strength = useMemo(() => passwordStrength(value), [value]);
  const level = strength >= 80 ? 'strong' : strength >= minStrength ? 'good' : strength >= 40 ? 'weak' : 'very-weak';
  return (
    <div className="password-input">
      <div className="input-group">
        <input className="input" type={visible ? 'text' : 'password'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" {...rest} />
        <button type="button" className="btn btn-icon" onClick={() => setVisible((v) => !v)} aria-label={visible ? 'Hide password' : 'Show password'}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        {allowGenerate && <button type="button" className="btn btn-icon" onClick={() => { onChange(generatePassword()); setVisible(true); }} aria-label="Generate password" title="Generate"><RefreshCw size={16} /></button>}
      </div>
      {showStrength && (
        <div className={`strength strength-${level}`}>
          <div className="strength-bar"><span style={{ width: `${strength}%` }} /></div>
          <span className="strength-text">Strength: {strength} {value && strength < minStrength ? `(minimum ${minStrength})` : ''}</span>
        </div>
      )}
    </div>
  );
}

export function FormActions({ children, align = 'left' }) {
  return <div className={`form-actions form-actions-${align}`}>{children}</div>;
}

export function Button({ children, variant = 'default', loading = false, icon: Icon, size, type = 'button', ...rest }) {
  return (
    <button type={type} className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${loading ? 'is-loading' : ''}`} disabled={loading || rest.disabled} {...rest}>
      {loading ? <span className="spinner" /> : Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}

export function isBlank(value) {
  return value === null || value === undefined || value === '';
}

// Messages a failed request attached to one field (the API's error.fields),
// for display next to that field instead of only in the banner.
export function fieldErrors(error, key) {
  const v = error?.fields?.[key];
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

// Generic error banner for a failed request (shows field errors when present).
export function ErrorBanner({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="banner banner-error" role="alert">
      <div>
        <strong>{error.message}</strong>
        {error.fields && (
          <ul>{Object.entries(error.fields).map(([k, v]) => <li key={k}><code>{k}</code>: {Array.isArray(v) ? v.join(', ') : String(v)}</li>)}</ul>
        )}
        {error.requestId && <small>Request ID: {error.requestId}</small>}
      </div>
      {onRetry && <button className="btn btn-sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}
