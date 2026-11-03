import { AlertTriangle, Info } from 'lucide-react';
import { ErrorBanner, Field, Select } from '../../../../components/Form.jsx';
import { formatBytes } from '../../../../components/Common.jsx';
import { PanelCapabilityState, FeatureDisabledState } from '../../../../panel/PanelPage.jsx';
import { usePanelMe } from '../../../../panel/hooks/usePanel.js';

export const isCapabilityError = (error) => Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
export const isFeatureDisabled = (error) => Boolean(error) && error.status === 403 && error.code === 'feature_disabled';

// One place for every request outcome a panel page meets: plan feature off,
// daemon missing, or an ordinary failure with its field errors.
export function PanelRequestError({ error, fn, onRetry }) {
  if (!error) return null;
  if (isFeatureDisabled(error)) return <FeatureDisabledState fn={fn} />;
  if (isCapabilityError(error)) return <PanelCapabilityState error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

// A mutation that failed: 501 is a banner (the form stays), the rest a plain error banner.
export function MutationError({ error }) {
  if (!error) return null;
  if (isCapabilityError(error)) {
    return (
      <div className="banner banner-warning" role="alert">
        <AlertTriangle size={18} />
        <div>
          <strong>Not available on this server</strong>
          <p>{error.message}</p>
          <p className="muted">Ask your hosting provider to enable it.</p>
        </div>
      </div>
    );
  }
  if (error.code === 'limit_reached') {
    return (
      <div className="banner banner-warning" role="alert">
        <AlertTriangle size={18} />
        <div><strong>Plan limit reached</strong><p>{error.message}</p><p className="muted">Ask your hosting provider about a larger plan.</p></div>
      </div>
    );
  }
  return <ErrorBanner error={error} />;
}

export function InfoNote({ children }) {
  return <div className="banner banner-info"><Info size={18} /><div>{children}</div></div>;
}

export const fieldError = (error, key) => (error?.fields?.[key] ? error.fields[key] : null);

// The hostnames of this account: the API's meta.domains when a list carries it,
// otherwise the session's account record.
export function useAccountDomains(metaDomains) {
  const { me } = usePanelMe();
  if (Array.isArray(metaDomains) && metaDomains.length) return metaDomains;
  const main = me?.account?.domain;
  const rows = (me?.account?.domains || []).map((d) => d.domain);
  return [...new Set([main, ...rows].filter(Boolean))];
}

export function DomainSelect({ value, onChange, domains, label = 'Domain', help, error, allowAll = false, ...rest }) {
  const options = [...(allowAll ? [{ value: '', label: 'All domains' }] : []), ...domains.map((d) => ({ value: d, label: d }))];
  return (
    <Field label={label} help={help} error={error}>
      <Select value={value} onChange={onChange} options={options} aria-label={label} {...rest} />
    </Field>
  );
}

export function AddressInput({ localPart, domain, domains, onLocalPart, onDomain, error, help, disabled = false, autoFocus = false }) {
  return (
    <Field label="Address" required error={error} help={help}>
      <div className="input-group">
        <input className="input" value={localPart} onChange={(e) => onLocalPart(e.target.value.toLowerCase())} placeholder="name" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Local part" disabled={disabled} autoFocus={autoFocus} />
        <span className="muted" style={{ alignSelf: 'center' }}>@</span>
        <Select value={domain} onChange={onDomain} options={domains.map((d) => ({ value: d, label: d }))} aria-label="Domain" disabled={disabled} style={{ flex: 1 }} />
      </div>
    </Field>
  );
}

export function quotaText(quotaMb) {
  if (quotaMb == null || quotaMb === 0) return 'Unlimited';
  return formatBytes(quotaMb * 1024 * 1024);
}

// Converts an ISO timestamp to the value a datetime-local input takes, and back.
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function PendingNote({ result }) {
  if (!result || result.applied !== false) return null;
  return <p className="muted">Saved. The change on the mail server is pending{result.reason ? ` (${result.reason.replace(/_/g, ' ')})` : ''}; it is applied once the service is available.</p>;
}
