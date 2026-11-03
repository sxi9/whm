import { useMemo, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { Card, KeyValue, StatusPill } from '../../../../components/Common.jsx';
import { Toggle, Button, ErrorBanner } from '../../../../components/Form.jsx';
import { Modal } from '../../../../components/Modal.jsx';
import { PanelCapabilityState, PendingPill } from '../../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe } from '../../../../panel/hooks/usePanel.js';

export const isFeatureDisabled = (err) => Boolean(err) && err.status === 403 && err.code === 'feature_disabled';
export const isCapabilityError = (err) => Boolean(err) && (err.status === 501 || err.code === 'capability_missing' || err.code === 'binary_not_found');
export const isLimitError = (err) => Boolean(err) && err.code === 'limit_reached';

export const TYPE_LABELS = { main: 'Main domain', addon: 'Addon domain', sub: 'Subdomain', parked: 'Parked domain', alias: 'Parked domain' };
export const typeLabel = (type) => TYPE_LABELS[type] || type;
export const isParked = (row) => row.type === 'parked' || row.type === 'alias';

// GET /panel/domains: every hostname of the account plus meta.counts / meta.limits.
export function useDomains() {
  const res = usePanelApi('/domains');
  const rows = useMemo(() => res.data || [], [res.data]);
  return { ...res, rows, counts: res.meta?.counts || null, limits: res.meta?.limits || null };
}

// The page is gated by the plan feature of its function, or by a 403 the API answered.
export function useFeatureGate(fn, ...errors) {
  const { hasFeature } = usePanelMe();
  if (fn?.feature && hasFeature && !hasFeature(fn.feature)) return true;
  return errors.some(isFeatureDisabled);
}

export function limitReached(count, limit) {
  return limit != null && limit >= 0 && count >= limit;
}

export function LimitNotice({ count, limit, noun }) {
  if (limit == null) return null;
  if (limitReached(count, limit)) {
    return (
      <div className="banner banner-warning">
        <AlertTriangle size={18} />
        <div>
          <strong>{limit === 0 ? `Your plan does not include ${noun}` : `All ${limit} ${noun} of your plan are in use`}</strong>
          <p className="muted">{limit === 0 ? 'Ask your hosting provider about a plan that includes them.' : 'Remove one to make room, or ask your hosting provider about a larger plan.'}</p>
        </div>
      </div>
    );
  }
  return null;
}

// Plan limits as the server enforces them (assertLimit): null is unlimited, 0 is
// a closed door, any other value is the cap.
export function usageText(count, limit, noun) {
  if (limit == null) return `${count} ${noun} · no plan limit`;
  if (limit === 0) return `No ${noun} in your plan`;
  return `${count} of ${limit} ${noun}`;
}

export function allowedText(limit) {
  if (limit == null) return 'no plan limit';
  if (limit === 0) return 'none in your plan';
  return `of ${limit} allowed`;
}

export function WarningsBanner({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div className="banner banner-info">
      <Info size={18} />
      <div>
        <strong>Saved, with notes from the server</strong>
        <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      </div>
    </div>
  );
}

// Errors a form could not place on a field: plan limits, conflicts, missing
// daemons. Field errors stay next to their inputs.
export function RequestError({ error, onRetry }) {
  if (!error || error.fields) return null;
  if (isCapabilityError(error)) return <PanelCapabilityState error={error} onRetry={onRetry} />;
  if (isLimitError(error)) {
    return (
      <div className="banner banner-warning" role="alert">
        <AlertTriangle size={18} />
        <div><strong>Plan limit reached</strong><p>{error.message}</p></div>
      </div>
    );
  }
  return <ErrorBanner error={error} />;
}

export function VhostPill({ vhost }) {
  if (!vhost) return <span className="muted">—</span>;
  const status = vhost.status || 'unknown';
  const label = { active: 'Serving', pending: 'Pending', failed: 'Failed', error: 'Failed', disabled: 'Disabled' }[status] || status;
  return <span title={vhost.error || ''}><StatusPill status={status}>{label}</StatusPill></span>;
}

export function SslPill({ ssl }) {
  if (!ssl) return <StatusPill status="unknown">None</StatusPill>;
  if (ssl.installed) {
    const days = ssl.daysRemaining;
    const tone = days != null && days <= 7 ? 'warning' : 'ok';
    return <span title={ssl.issuer || ''}><StatusPill status={tone}>{days != null ? `Valid · ${days} d` : 'Installed'}</StatusPill></span>;
  }
  return <StatusPill status={ssl.state || 'pending'} />;
}

// Document roots are shown relative to the home directory, as the customer sees them.
export function DocrootCode({ docroot, homeDir }) {
  if (!docroot) return <span className="muted">—</span>;
  const shown = homeDir && docroot.startsWith(`${homeDir}/`) ? `~/${docroot.slice(homeDir.length + 1)}` : docroot;
  return <code title={docroot}>{shown}</code>;
}

export function AppliedPill({ result, okLabel = 'Applied' }) {
  if (!result) return <span className="muted">—</span>;
  if (result.applied === false) return <PendingPill result={result} />;
  return <StatusPill status="ok">{okLabel}</StatusPill>;
}

// The outcome of a create: the row plus what happened on the host.
export function CreateResult({ title, items, warnings, onDismiss }) {
  return (
    <Card title={title} actions={onDismiss && <Button size="sm" onClick={onDismiss}>Dismiss</Button>}>
      <WarningsBanner warnings={warnings} />
      <KeyValue items={items} />
    </Card>
  );
}

// Removal with per-domain options (zone, document root); confirmed by typing nothing,
// the options are the decision.
export function RemoveDomainModal({ open, domain, title, options, onClose, onConfirm }) {
  const [choice, setChoice] = useState(() => Object.fromEntries((options || []).map((o) => [o.key, Boolean(o.default)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try { await onConfirm(choice); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title={title || `Remove ${domain}?`} onClose={busy ? undefined : onClose} size="sm"
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={confirm} loading={busy}>Remove</Button>
        </>
      )}>
      <RequestError error={error} />
      <p>{domain} stops being served by this account. Visitors get an error until the name points somewhere else.</p>
      {(options || []).map((o) => (
        <Toggle key={o.key} checked={choice[o.key]} onChange={(v) => setChoice((c) => ({ ...c, [o.key]: v }))} label={o.label} description={o.description} />
      ))}
    </Modal>
  );
}
