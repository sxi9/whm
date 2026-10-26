import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, KeyValue, formatDate } from '../../components/Common.jsx';
import { Button, ErrorBanner } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';

export { RequestError, Tabs, isCapabilityError } from '../security/Shared.jsx';

// Starts a background job from an API call and shows its live log until it
// finishes; the caller is told when it did so lists can refresh.
export function useJobRunner({ onFinished } = {}) {
  const toast = useToast();
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const start = useCallback(async (fn, label = 'Job') => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await fn();
      setJobId(data.job.id);
      toast.info(`${label} queued (job #${data.job.id})`);
      return data;
    } catch (err) {
      setError(err);
      toast.error(err);
      return null;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  const finished = useCallback((event) => {
    setBusy(false);
    onFinished?.(event);
  }, [onFinished]);
  return { jobId, busy, error, start, setJobId, finished };
}

export function JobPanel({ runner, title = 'Progress' }) {
  if (!runner.jobId) return null;
  return (
    <Card title={title} subtitle={`Job #${runner.jobId} · also visible under Server Status > Task Queue Monitor`}>
      <ProgressLog jobId={runner.jobId} onFinished={runner.finished} />
    </Card>
  );
}

// Which package manager this host uses; most Software pages show it in the header.
export function ManagerBadge({ detect }) {
  if (!detect) return null;
  if (!detect.manager) return <StatusPill status="not-installed">no package manager</StatusPill>;
  return <StatusPill status="ok">{detect.manager === 'apt' ? 'APT (Debian/Ubuntu)' : `${detect.manager.toUpperCase()} (RHEL family)`}</StatusPill>;
}

export function RebootBanner({ required }) {
  if (!required) return null;
  return (
    <div className="banner banner-warning">
      <div>
        <strong>Reboot required</strong>
        <p>The kernel or a core library was updated. Schedule a <Link to="/system-reboot/graceful-server-reboot">graceful reboot</Link> to finish applying it.</p>
      </div>
    </div>
  );
}

export function PhpVersionPill({ version, inherited }) {
  if (!version) return <span className="muted">—</span>;
  return <StatusPill status={inherited ? 'inactive' : 'ok'}>{version}{inherited ? ' (inherited)' : ''}</StatusPill>;
}

// Renders the recent jobs of some type(s) as a compact history table.
export function JobHistory({ jobs, emptyText = 'No runs yet', onSelect }) {
  if (!jobs?.length) return <p className="muted">{emptyText}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Job</th><th>Type</th><th>Status</th><th>Started</th><th>Message</th>{onSelect && <th />}</tr></thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>#{j.id}</td>
              <td><code>{j.type}</code></td>
              <td><StatusPill status={j.status} /></td>
              <td>{formatDate(j.started_at || j.created_at)}</td>
              <td className="small">{j.error || j.message || (j.result ? summarizeResult(j.result) : '—')}</td>
              {onSelect && <td className="actions-col"><Button size="sm" onClick={() => onSelect(j.id)}>Log</Button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summarizeResult(result) {
  if (!result || typeof result !== 'object') return String(result ?? '—');
  if (Array.isArray(result.packages)) return `${result.packages.length} package(s)`;
  if (result.upgraded != null) return `${result.upgraded} upgraded${result.rebootRequired ? ', reboot required' : ''}`;
  if (result.installed && Array.isArray(result.installed)) return `${result.installed.length} installed, ${result.removed?.length ?? 0} removed`;
  return 'done';
}

// One installer card: list of what is installed + an install form that queues a job.
export function InstallerCard({ title, subtitle, kind, listPath, installPath, nameLabel = 'Name', namePlaceholder, allowVersion = true, present, installHint, runner, disabledReason }) {
  const { data, loading, error, refetch } = useApi(listPath, { enabled: Boolean(present) });
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [q, setQ] = useState('');
  const items = (data?.items || []).filter((i) => !q || i.name.toLowerCase().includes(q.toLowerCase()));
  const install = () => runner.start(() => api.post(installPath, { name: name.trim(), ...(allowVersion && version.trim() ? { version: version.trim() } : {}) }), `${title}: install ${name.trim()}`).then((d) => { if (d) { setName(''); setVersion(''); } });

  return (
    <Card title={title} subtitle={subtitle} actions={<StatusPill status={present ? 'installed' : 'not-installed'}>{present ? 'available' : 'not installed'}</StatusPill>}>
      {!present && <p className="muted">{disabledReason || installHint}</p>}
      {present && (
        <>
          <div className="form-grid">
            <label className="field"><span className="field-label">{nameLabel}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={namePlaceholder} /></label>
            {allowVersion && <label className="field"><span className="field-label">Version (optional)</span><input className="input" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="latest" /></label>}
          </div>
          <div className="action-row"><Button variant="primary" loading={runner.busy} disabled={!name.trim()} onClick={install}>Install with {kind}</Button> <Button onClick={() => refetch()}>Refresh list</Button></div>
          <ErrorBanner error={error} onRetry={refetch} />
          {loading && !data && <p className="muted">Loading installed {kind} items…</p>}
          {data && (
            <>
              <input className="input" placeholder={`Filter ${items.length ? `${data.items.length} installed` : 'installed'}…`} value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
              <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
                <table>
                  <thead><tr><th>Name</th><th>Version</th></tr></thead>
                  <tbody>
                    {items.length === 0 && <tr><td colSpan={2} className="table-state">Nothing installed{q ? ' matching the filter' : ''}</td></tr>}
                    {items.slice(0, 500).map((i) => <tr key={i.name}><td><code>{i.name}</code></td><td>{i.version || i.state || '—'}</td></tr>)}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}

export function SettingsSummary({ items }) {
  return <KeyValue items={items} />;
}
