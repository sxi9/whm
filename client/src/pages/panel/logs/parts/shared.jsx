import { AlertTriangle } from 'lucide-react';
import { ErrorBanner } from '../../../../components/Form.jsx';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

export function isFeatureDisabled(error) {
  return Boolean(error) && error.status === 403 && error.code === 'feature_disabled';
}

export function RequestError({ error, onRetry }) {
  if (!error || isCapabilityError(error) || isFeatureDisabled(error)) return null;
  if (error.status === 503 && error.code === 'service_unavailable') {
    return <div className="banner banner-warning" role="alert"><AlertTriangle size={18} /><div><strong>Temporarily unavailable</strong><p>{error.message}</p><p className="muted">Try again in a moment; if it keeps happening, tell your hosting provider.</p></div></div>;
  }
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

// "2026-11" → "November 2026"
export function periodLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return String(period || '—');
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function currentPeriod(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Log files are named after the domain they belong to (domain, domain-ssl_log,
// domain-bytes_log, access.log.1 …); a domain filter keeps the files whose name
// starts with it.
export function filesForDomain(files, domain) {
  if (!domain) return files || [];
  const d = domain.toLowerCase();
  return (files || []).filter((f) => f.name.toLowerCase().startsWith(d));
}

export function domainOfFile(name, domains) {
  const n = String(name || '').toLowerCase();
  return (domains || []).map((d) => d.toLowerCase()).filter((d) => n.startsWith(d)).sort((a, b) => b.length - a.length)[0] || null;
}

export const LOCATION_LABELS = { server: 'Web server', home: 'Your logs folder' };
