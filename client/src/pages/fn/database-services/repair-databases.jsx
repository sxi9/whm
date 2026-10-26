import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { EngineBanner, RequestError, useDbStatus, useIsRoot } from '../../databases/Shared.jsx';

const ACTIONS = [
  { value: 'check', label: 'Check (mysqlcheck --check)' },
  { value: 'repair', label: 'Repair (mysqlcheck --repair)' },
  { value: 'optimize', label: 'Optimize (mysqlcheck --optimize)' },
  { value: 'analyze', label: 'Analyze (mysqlcheck --analyze)' },
];

export default function RepairDatabases({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const isRoot = useIsRoot();
  const status = useDbStatus();
  const { data, loading, error, refetch } = useApi('/databases/repair');
  const { data: dbs } = useApi('/databases/databases?pageSize=500');
  const [action, setAction] = useState('check');
  const [selected, setSelected] = useState([]);
  const [autoRepair, setAutoRepair] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState(null);
  const [busy, setBusy] = useState(false);
  const candidates = (dbs || []).filter((d) => !d.system && d.onServer !== false);
  const engine = status.data?.profile?.engine;

  const run = async () => {
    if (action !== 'check' && !(await confirm({ title: `${ACTIONS.find((a) => a.value === action).label}?`, message: `Tables are locked while ${action} runs; applications may stall until it finishes.`, confirmLabel: 'Run' }))) return;
    setBusy(true); setRunError(null); setResult(null);
    try {
      const body = { action, autoRepair };
      if (selected.length) body.databases = selected;
      const { data: res } = await api.post('/databases/repair', body);
      setJobId(res.job.id);
    } catch (err) { setRunError(err); } finally { setBusy(false); }
  };

  const finished = async (event) => {
    setResult(event.result || null);
    if (event.type === 'done') toast.success(`${action} finished: ${event.result?.summary?.tables ?? 0} table(s) processed`); else toast.error(event.error || 'Job failed');
    refetch();
  };

  return (
    <>
      <PageHeader fn={fn} description="Check, repair, optimize or analyze tables with mysqlcheck as a background job. Leave the selection empty to process every database you manage (root: all databases on the server)." actions={<Button onClick={() => { refetch(); status.refetch(); }}>Refresh</Button>} />
      <EngineBanner status={status.data} loading={status.loading} error={status.error} onRetry={status.refetch} />
      <Card title="Run">
        <RequestError error={runError} />
        {engine === 'postgres' && <div className="banner banner-info"><div>PostgreSQL profile: check runs <code>VACUUM (ANALYZE)</code>, optimize runs <code>VACUUM (FULL, ANALYZE)</code> per database.</div></div>}
        <div className="form-grid">
          <Field label="Operation"><Select value={action} onChange={setAction} options={ACTIONS} /></Field>
          {action === 'check' && engine !== 'postgres' && <Field inline><Toggle checked={autoRepair} onChange={setAutoRepair} label="Repair tables found corrupt (--auto-repair)" /></Field>}
        </div>
        <Field label="Databases" help={selected.length ? `${selected.length} selected` : isRoot ? 'None selected = all databases on the server' : 'None selected = every database of your accounts'}>
          <div className="row-actions" style={{ marginBottom: 8 }}>
            <Button size="sm" onClick={() => setSelected(candidates.map((d) => d.name))}>Select all</Button>
            <Button size="sm" onClick={() => setSelected([])}>Clear</Button>
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            {candidates.map((d) => <label key={d.name} className="radio"><input type="checkbox" checked={selected.includes(d.name)} onChange={() => setSelected((s) => (s.includes(d.name) ? s.filter((x) => x !== d.name) : [...s, d.name]))} /><span><strong><code>{d.name}</code></strong>{d.account && <small>{d.account}</small>}</span></label>)}
            {candidates.length === 0 && <span className="muted">No databases listed.</span>}
          </div>
        </Field>
        <FormActions><Button variant={action === 'check' ? 'primary' : 'danger'} loading={busy} onClick={run}>Run {action}</Button></FormActions>
        {jobId && <ProgressLog jobId={jobId} onFinished={finished} />}
        {result && (
          <>
            <div className="stat-grid" style={{ marginTop: 12 }}>
              {[['Tables', result.summary?.tables], ['OK', result.summary?.ok], ['Repaired', result.summary?.repaired], ['Warnings', result.summary?.warnings], ['Errors', result.summary?.errors]].map(([l, v]) => <div key={l} className="stat"><div className="label">{l}</div><div className="value">{v ?? 0}</div></div>)}
            </div>
            {result.results?.filter((r) => r.status !== 'ok').length > 0 && (
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                  <thead><tr><th>Table</th><th>Status</th><th>Messages</th></tr></thead>
                  <tbody>{result.results.filter((r) => r.status !== 'ok').map((r) => <tr key={r.table}><td><code>{r.table}</code></td><td><StatusPill status={r.status === 'error' ? 'failed' : r.status === 'repaired' ? 'ok' : 'warning'}>{r.status}</StatusPill></td><td className="muted">{r.messages.join(' | ')}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
      <Card title="Recent runs" padded={false}>
        <DataTable
          columns={[
            { key: 'created_at', label: 'Started', render: (r) => formatDate(r.created_at) },
            { key: 'action', label: 'Operation' },
            { key: 'databases', label: 'Databases', render: (r) => (r.databases.length ? r.databases.map((d) => <code key={d} style={{ marginRight: 6 }}>{d}</code>) : <em>all</em>) },
            { key: 'job_status', label: 'Job', render: (r) => <StatusPill status={r.job_status || 'unknown'} /> },
            { key: 'summary', label: 'Result', render: (r) => (r.summary ? `${r.summary.tables} tables · ${r.summary.ok} ok · ${r.summary.repaired} repaired · ${r.summary.errors} errors` : '—') },
            { key: 'started_by', label: 'By' },
          ]}
          rows={data?.runs || []} loading={loading} error={error} rowKey={(r) => r.id} dense emptyText="No runs yet."
        />
      </Card>
    </>
  );
}
