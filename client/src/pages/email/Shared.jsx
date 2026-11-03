import { useMemo, useState } from 'react';
import { Info, AlertTriangle } from 'lucide-react';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, CapabilityNotice, formatBytes } from '../../components/Common.jsx';
import { Field, Select, TextInput } from '../../components/Form.jsx';
import { RequestError, Tabs } from '../security/Shared.jsx';

export { RequestError, Tabs };

export const WINDOWS = [{ value: '1', label: 'Last hour' }, { value: '6', label: 'Last 6 hours' }, { value: '24', label: 'Last 24 hours' }, { value: '72', label: 'Last 3 days' }, { value: '168', label: 'Last 7 days' }, { value: '720', label: 'Last 30 days' }, { value: '0', label: 'Whole log' }];

export function WindowSelect({ value, onChange, inline = false }) {
  const select = <Select value={String(value)} onChange={onChange} options={WINDOWS} aria-label="Time window" />;
  return inline ? <Field inline>{select}</Field> : <Field label="Time window">{select}</Field>;
}

// GET /email/status once per page: tells the page whether Exim exists so it
// can show the install prompt before firing the real request.
export function useMailStatus() {
  return useApi('/email/status');
}

export function EximNotice({ status, onRetry }) {
  if (!status || status.installed) return null;
  return <CapabilityNotice error={{ code: 'capability_missing', message: 'Exim is not installed on this server. Install exim4 (Debian/Ubuntu) or exim (RHEL) to manage mail; the settings you save here are kept and applied once it is.' }} onRetry={onRetry} />;
}

// Only the current mainlog is scanned; when the chosen window reaches further
// back than its first line (daily rotation on Debian), say so.
export function LogNote({ meta }) {
  if (!meta) return null;
  if (meta.logExists === false) return <div className="banner banner-info"><Info size={18} /><div>The Exim main log ({meta.file}) does not exist yet; nothing has been logged on this host.</div></div>;
  const from = meta.logFrom ? Date.parse(`${meta.logFrom.replace(' ', 'T')}`) : null;
  const windowStart = meta.hours ? Date.now() - Number(meta.hours) * 3600_000 : null;
  const shortLog = from && (!windowStart || from > windowStart);
  if (meta.logTruncated) return <p className="muted">Only the most recent part of {meta.file} was scanned (window: {meta.hours ? `${meta.hours} h` : 'whole log'}){meta.logFrom ? `, starting ${meta.logFrom}` : ''}.</p>;
  if (shortLog) return <p className="muted">{meta.file} starts at {meta.logFrom}; earlier mail is in rotated log files, which are not scanned.</p>;
  return null;
}

export function StatGrid({ stats }) {
  return (
    <div className="stat-grid" style={{ marginBottom: 14 }}>
      {stats.filter(Boolean).map(([label, value, tone]) => (
        <div className="stat" key={label}><div className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{tone && <span className={`dot dot-${tone}`} />}{label}</div><div className="value">{value ?? '—'}</div></div>
      ))}
    </div>
  );
}

export function DeliveryStatusPill({ status }) {
  const map = { delivered: 'ok', failed: 'failed', deferred: 'warning', queued: 'pending', completed: 'ok', rejected: 'failed' };
  return <StatusPill status={map[status] || 'unknown'}>{status}</StatusPill>;
}

// Every filter mutation answers { ..., apply } so pages can tell "saved and live
// in Exim" from "saved, Exim missing" from "saved, Exim rejected it".
// "Applied" means the files were written and Exim accepted them; "enforced"
// additionally means the generated configuration includes them and the
// greylist lookup passed its self-test. Both shapes (a fresh apply result and
// the stored lastApply with its summary) are handled.
function applyState(apply) {
  const summary = apply?.summary && !apply.summary.country ? apply.summary : null;
  const hooked = apply?.hooked ?? summary?.hooked ?? null;
  const selfTest = apply?.selfTest ?? summary?.selfTest ?? null;
  const warnings = apply?.warnings || summary?.warnings || [];
  return { hooked, selfTestFailed: selfTest?.ok === false, warnings, notEnforced: hooked === false || selfTest?.ok === false };
}

export function applyMessage(apply, verb = 'Saved') {
  if (!apply) return verb;
  if (apply.applied) {
    const state = applyState(apply);
    if (state.notEnforced) return `${verb}; written to Exim but not enforced yet (see the notice on this page)`;
    return `${verb} and applied to Exim${apply.reloaded ? ' (reloaded)' : ''}`;
  }
  return `${verb}; not applied: ${apply.reason || 'unknown error'}`;
}

function applyDetail(apply) {
  if (!apply) return null;
  if (apply.ok === false || apply.applied === false) return `Not applied to Exim: ${apply.error || apply.reason || 'unknown error'}.`;
  const state = applyState(apply);
  if (state.hooked === false) return 'The filter files were written, but the generated Exim configuration does not include them yet.';
  if (state.selfTestFailed) return 'Applied to Exim, but the greylist lookup self-test failed.';
  return null;
}

export function ApplyBadge({ apply }) {
  if (!apply) return null;
  const failed = apply.ok === false || apply.applied === false;
  const state = failed ? null : applyState(apply);
  const label = failed ? 'Not applied' : state.notEnforced ? 'Not enforced' : 'Applied';
  const at = !failed && !state.notEnforced && apply.at ? new Date(apply.at.replace(' ', 'T') + 'Z').toLocaleString() : null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <StatusPill status={failed || state.notEnforced ? 'warning' : 'ok'}>{label}</StatusPill>
      {at && <span className="muted">{at}</span>}
    </span>
  );
}

export function IncludeHint({ apply }) {
  if (!apply) return null;
  const { warnings } = applyState(apply);
  const detail = applyDetail(apply);
  if (!apply.hint && !warnings.length && !detail) return null;
  const warn = warnings.length || detail;
  return (
    <div className={`banner ${warn ? 'banner-warning' : 'banner-info'}`}>
      {warn ? <AlertTriangle size={18} /> : <Info size={18} />}
      <div>{detail && <p>{detail}</p>}{warnings.map((w) => <p key={w}>{w}</p>)}{apply.hint && <p>{apply.hint}</p>}</div>
    </div>
  );
}

export function Bytes({ value }) { return <span>{formatBytes(value)}</span>; }

// Account chooser for mailbox pages (root-only list of hosting accounts).
export function AccountPicker({ value, onChange, accounts, label = 'Account' }) {
  const [filter, setFilter] = useState('');
  const options = useMemo(() => (accounts || []).filter((a) => !filter || `${a.username} ${a.domain}`.toLowerCase().includes(filter.toLowerCase())).map((a) => ({ value: a.username, label: `${a.username} — ${a.domain}${a.suspended ? ' (suspended)' : ''}` })), [accounts, filter]);
  return (
    <div className="form-grid">
      <Field label="Filter"><TextInput value={filter} onChange={setFilter} placeholder="Type to filter by user or domain" /></Field>
      <Field label={label} help={`${(accounts || []).length} account(s) available`}><Select value={value} onChange={onChange} options={options} placeholder={accounts?.length ? 'Select an account' : 'No accounts yet'} /></Field>
    </div>
  );
}

export function SectionCard({ title, subtitle, children, actions }) {
  return <Card title={title} subtitle={subtitle} actions={actions}>{children}</Card>;
}
