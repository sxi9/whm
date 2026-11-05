import { useCallback } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { ErrorBanner, Field, Select, TextInput } from '../../../../components/Form.jsx';
import { formatBytes } from '../../../../components/Common.jsx';
import { PanelCapabilityState, FeatureDisabledState } from '../../../../panel/PanelPage.jsx';
import { usePanelMe } from '../../../../panel/hooks/usePanel.js';
import { useT, translate } from '../../../../i18n/useT.js';

// Placeholders are filled after the lookup so a translation can reorder them.
export const fill = (text, params) => (params ? String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k]))) : text);

// For helpers that run outside a component (status labels, toasts built from
// data): the module-level catalogue, same fallback rule as useT().
export const tr = (key, fallback, params) => fill(translate(key, fallback), params);

export function useEmailT() {
  const base = useT();
  const t = useCallback((key, fallback, params) => fill(base.t(key, fallback), params), [base.t]);
  return { ...base, t };
}

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
  const { t } = useEmailT();
  if (!error) return null;
  if (isCapabilityError(error)) {
    return (
      <div className="banner banner-warning" role="alert">
        <AlertTriangle size={18} />
        <div>
          <strong>{t('panel.email.common.not_available', 'Not available on this server')}</strong>
          <p>{error.message}</p>
          <p className="muted">{t('panel.email.common.ask_provider_enable', 'Ask your hosting provider to enable it.')}</p>
        </div>
      </div>
    );
  }
  if (error.code === 'limit_reached') {
    return (
      <div className="banner banner-warning" role="alert">
        <AlertTriangle size={18} />
        <div><strong>{t('panel.email.common.plan_limit_reached', 'Plan limit reached')}</strong><p>{error.message}</p><p className="muted">{t('panel.email.common.ask_provider_plan', 'Ask your hosting provider about a larger plan.')}</p></div>
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

export function DomainSelect({ value, onChange, domains, label, help, error, allowAll = false, ...rest }) {
  const { t } = useEmailT();
  const text = label || t('panel.email.common.domain', 'Domain');
  const options = [...(allowAll ? [{ value: '', label: t('panel.email.common.all_domains', 'All domains') }] : []), ...domains.map((d) => ({ value: d, label: d }))];
  return (
    <Field label={text} help={help} error={error}>
      <Select value={value} onChange={onChange} options={options} aria-label={text} {...rest} />
    </Field>
  );
}

export function AddressInput({ localPart, domain, domains, onLocalPart, onDomain, error, help, disabled = false, autoFocus = false }) {
  const { t } = useEmailT();
  return (
    <Field label={t('panel.email.common.address', 'Address')} required error={error} help={help}>
      <div className="input-group">
        <TextInput value={localPart} onChange={(v) => onLocalPart(v.toLowerCase())} placeholder={t('panel.email.common.local_part_placeholder', 'name')} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label={t('panel.email.common.local_part', 'Local part')} disabled={disabled} autoFocus={autoFocus} />
        <span className="muted" style={{ alignSelf: 'center' }}>@</span>
        <Select value={domain} onChange={onDomain} options={domains.map((d) => ({ value: d, label: d }))} aria-label={t('panel.email.common.domain', 'Domain')} disabled={disabled} style={{ flex: 1 }} />
      </div>
    </Field>
  );
}

export function quotaText(quotaMb) {
  if (quotaMb == null || quotaMb === 0) return tr('panel.email.common.unlimited', 'Unlimited');
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
  const { t } = useEmailT();
  if (!result || result.applied !== false) return null;
  const reason = result.reason ? ` (${result.reason.replace(/_/g, ' ')})` : '';
  return <p className="muted">{t('panel.email.common.pending_note', 'Saved. The change on the mail server is pending{reason}; it is applied once the service is available.', { reason })}</p>;
}
