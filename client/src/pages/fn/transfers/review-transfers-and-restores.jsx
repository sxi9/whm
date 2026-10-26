import { useState } from 'react';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Button } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { KIND_LABELS, RunDetail, Totals } from '../../transfers/Shared.jsx';

function Runs() {
  const [kind, setKind] = useState('');
  const { data, loading, error, refetch } = useApi(`/transfers/runs?limit=200${kind ? `&kind=${kind}` : ''}`, { refreshMs: 15000 });
  const [openId, setOpenId] = useState(null);
  const { data: open } = useApi(openId ? `/transfers/runs/${openId}` : null, { enabled: Boolean(openId) });
  const rows = data || [];
  const sum = (key) => rows.reduce((n, r) => n + (r.totals?.[key] || 0), 0);
  return (
    <>
      <Totals items={[['Runs', rows.length], ['Accounts', sum('total')], ['Done', sum('done')], ['Pending', sum('pending')], ['Failed', sum('failed')]]} />
      <Card title="Transfers and restores" padded={false} actions={<Button size="sm" variant="ghost" onClick={() => refetch()}>Refresh</Button>}>
        <div className="card-body">
          <div className="form-grid">
            <Field label="Kind"><Select value={kind} onChange={setKind} options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))} placeholder="All kinds" /></Field>
          </div>
        </div>
        <DataTable
          columns={[
            { key: 'id', label: 'Run', render: (r) => `#${r.id}` },
            { key: 'kind', label: 'Kind', render: (r) => KIND_LABELS[r.kind] || r.kind },
            { key: 'source', label: 'Source', render: (r) => (r.source ? <code>{r.source}</code> : '—') },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
            { key: 'totals', label: 'Accounts', render: (r) => <span className="muted">{r.totals?.total ?? 0} · {r.totals?.done ?? 0} done · {r.totals?.pending ?? 0} pending · {r.totals?.failed ?? 0} failed</span> },
            { key: 'requested_by', label: 'By', render: (r) => r.requested_by || r.created_by_name || '—' },
            { key: 'created_at', label: 'Started', render: (r) => formatDate(r.created_at) },
            { key: 'finished_at', label: 'Finished', render: (r) => formatDate(r.finished_at) },
          ]}
          rows={rows} loading={loading} error={error} rowKey={(r) => r.id} dense emptyText="No transfers or restores have run yet."
          rowActions={(r) => [{ label: openId === r.id ? 'Hide' : 'Details and log', primary: true, onClick: () => setOpenId(openId === r.id ? null : r.id) }]}
        />
      </Card>
      {openId && open && <RunDetail run={open} />}
    </>
  );
}

function Jobs() {
  const [status, setStatus] = useState('');
  const { data, loading, error, refetch } = useApi(`/transfers/jobs?limit=200${status ? `&status=${status}` : ''}`, { refreshMs: 15000 });
  const [openId, setOpenId] = useState(null);
  const { data: job } = useApi(openId ? `/transfers/jobs/${openId}` : null, { enabled: Boolean(openId) });
  return (
    <>
      <Card title="Job queue entries" subtitle="Every transfer.* and restore.* job, including restores started from other tools." padded={false} actions={<Button size="sm" variant="ghost" onClick={() => refetch()}>Refresh</Button>}>
        <div className="card-body">
          <div className="form-grid">
            <Field label="Status"><Select value={status} onChange={setStatus} options={['queued', 'running', 'done', 'failed', 'cancelled']} placeholder="Any status" /></Field>
          </div>
        </div>
        <DataTable
          columns={[
            { key: 'id', label: 'Job', render: (j) => `#${j.id}` },
            { key: 'type', label: 'Type', render: (j) => <code>{j.type}</code> },
            { key: 'status', label: 'Status', render: (j) => <StatusPill status={j.status} /> },
            { key: 'progress', label: 'Progress', render: (j) => `${j.progress}%${j.message ? ` · ${j.message}` : ''}` },
            { key: 'run', label: 'Run', render: (j) => (j.run ? `#${j.run.id} (${KIND_LABELS[j.run.kind] || j.run.kind})` : '—') },
            { key: 'created_by_name', label: 'By', render: (j) => j.created_by_name || '—' },
            { key: 'created_at', label: 'Queued', render: (j) => formatDate(j.created_at) },
            { key: 'finished_at', label: 'Finished', render: (j) => formatDate(j.finished_at) },
            { key: 'error', label: 'Error', render: (j) => j.error || <span className="muted">—</span> },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(j) => j.id} dense emptyText="No transfer or restore jobs."
          rowActions={(j) => [{ label: openId === j.id ? 'Hide log' : 'Log', primary: true, onClick: () => setOpenId(openId === j.id ? null : j.id) }]}
        />
      </Card>
      {openId && job && (
        <Card title={`Job #${job.id} · ${job.type}`} subtitle={`${job.status} · queued ${formatDate(job.created_at)}${job.finished_at ? ` · finished ${formatDate(job.finished_at)}` : ''}`}>
          {['queued', 'running'].includes(job.status)
            ? <ProgressLog jobId={job.id} />
            : <pre className="log">{(job.logs || []).map((l) => `${l.ts}  ${l.level.toUpperCase().padEnd(5)}  ${l.line}`).join('\n') || 'No log lines.'}</pre>}
          {job.result && <pre className="log">{JSON.stringify(job.result, null, 2)}</pre>}
        </Card>
      )}
    </>
  );
}

export default function ReviewTransfersAndRestores({ fn }) {
  const [tab, setTab] = useState('runs');
  return (
    <>
      <PageHeader fn={fn} description="Every transfer, cpmove restore and addon conversion with its per-account outcome, the steps that are still pending (for example zones waiting for BIND) and the full job log." />
      <div className="row-actions" style={{ marginBottom: 14 }}>
        <Button size="sm" variant={tab === 'runs' ? 'primary' : 'default'} onClick={() => setTab('runs')}>Runs</Button>
        <Button size="sm" variant={tab === 'jobs' ? 'primary' : 'default'} onClick={() => setTab('jobs')}>Job log</Button>
      </div>
      {tab === 'runs' ? <Runs /> : <Jobs />}
    </>
  );
}
