import { useState } from 'react';
import { Card, StatusPill, CapabilityNotice, formatDate } from '../../components/Common.jsx';
import { ErrorBanner, Button } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';

export const isCapabilityError = (error) => Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');

// Error display that distinguishes "install the daemon" from real failures.
export function RequestError({ error, onRetry }) {
  if (!error) return null;
  if (isCapabilityError(error)) return <CapabilityNotice error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export function JobCard({ jobId, title = 'Background job', onFinished }) {
  if (!jobId) return null;
  return <Card title={title}><ProgressLog jobId={jobId} onFinished={onFinished} /></Card>;
}

export function LastJob({ job }) {
  if (!job) return <StatusPill status="pending">never run</StatusPill>;
  return <StatusPill status={job.status}>last run: {job.status} · {formatDate(job.finished_at || job.created_at)}</StatusPill>;
}

export function YesNo({ value, yes = 'yes', no = 'no', unknown = 'unknown' }) {
  if (value == null) return <StatusPill status="unknown">{unknown}</StatusPill>;
  return <StatusPill status={value ? 'ok' : 'inactive'}>{value ? yes : no}</StatusPill>;
}

// Small inline cron editor used by the schedule cards.
export function CronField({ value, onChange, onSave, saving }) {
  const [draft, setDraft] = useState(value);
  const dirty = draft !== value;
  return (
    <div className="input-group">
      <input className="input" value={draft} onChange={(e) => { setDraft(e.target.value); onChange?.(e.target.value); }} style={{ width: 160, fontFamily: 'var(--mono)' }} aria-label="Cron expression" />
      {dirty && <Button size="sm" variant="primary" loading={saving} onClick={() => onSave(draft)}>Save</Button>}
    </div>
  );
}
