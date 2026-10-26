import { Link } from 'react-router-dom';
import { Card, CapabilityNotice } from '../../components/Common.jsx';
import { ErrorBanner } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

export function RequestError({ error, onRetry }) {
  if (!error) return null;
  if (isCapabilityError(error)) return <CapabilityNotice error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export function JobCard({ jobId, title, onFinished }) {
  if (!jobId) return null;
  return (
    <Card title={title} subtitle={<span>Also visible in <Link to="/server-status/task-queue-monitor">Task Queue Monitor</Link></span>}>
      <ProgressLog jobId={jobId} onFinished={onFinished} />
    </Card>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="row-actions" role="tablist" style={{ marginBottom: 14, flexWrap: 'wrap', justifyContent: 'flex-start' }}>
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={`btn btn-sm ${value === t.value ? 'btn-primary' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}{t.count != null && <span className="pill pill-muted" style={{ marginLeft: 6 }}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// Usage bar: percent of a limit, null when the account is unlimited.
export function Meter({ percent, warnAt = 80 }) {
  if (percent == null) return <span className="muted">Unlimited</span>;
  const tone = percent >= 100 ? 'bad' : percent >= warnAt ? 'warn' : '';
  return (
    <div style={{ minWidth: 120 }}>
      <span style={{ fontSize: 12 }}>{percent}%</span>
      <div className={`meter ${tone}`} style={{ marginTop: 4 }} aria-label={`${percent}% of limit`}><span style={{ width: `${Math.min(100, percent)}%` }} /></div>
    </div>
  );
}

export function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

export function periodLabel(period) {
  if (!period) return '—';
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
