import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, DownloadLink, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, FormActions } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { ItemStatus, Totals } from './AccountSelector.jsx';

const reportHref = (id, format) => `/api/multi-account/runs/${id}/report?format=${format}`;

function StepList({ steps }) {
  const rows = [];
  for (const [name, value] of Object.entries(steps || {})) {
    if (name === 'plan' || value == null) continue;
    if (Array.isArray(value)) for (const v of value) rows.push({ name: `${name}${v.domain ? ` ${v.name ? `${v.name === '@' ? '' : `${v.name}.`}` : ''}${v.domain}` : ''}`, status: v.status, detail: v.detail });
    else if (typeof value === 'object') rows.push({ name, status: value.status, detail: value.detail ?? (value.to != null ? `${value.from ?? 'unset'} → ${value.to}` : null) });
    else rows.push({ name, status: 'done', detail: String(value) });
  }
  if (!rows.length) return <span className="muted">—</span>;
  return <ul style={{ margin: 0, paddingLeft: 16 }}>{rows.map((r, i) => <li key={i}><code>{r.name}</code> <StatusPill status={r.status === 'applied' ? 'ok' : r.status === 'skipped' ? 'disabled' : r.status}>{r.status}</StatusPill> {r.detail && <span className="muted">{r.detail}</span>}</li>)}</ul>;
}

// Live progress of a bulk job, then the per-account outcome with the report links.
export function RunPanel({ job, runId, title, describeItem, onReset, onFinished }) {
  const toast = useToast();
  const [finished, setFinished] = useState(false);
  const { data: run, refetch } = useApi(finished ? `/multi-account/runs/${runId}` : null, { enabled: finished });
  const done = useCallback((ev) => {
    setFinished(true);
    onFinished?.(ev);
    if (ev.type === 'done') toast.success(ev.result ? `${ev.result.done} applied, ${ev.result.pending} pending, ${ev.result.failed} failed` : 'Run finished');
    else toast.error(ev.error || 'Run failed');
  }, [onFinished, toast]);
  return (
    <>
      <Card title={title}>
        <ProgressLog jobId={job.id} onFinished={done} />
        <FormActions>
          <Button onClick={onReset}>Start another run</Button>
          {finished && <DownloadLink href={reportHref(runId, 'csv')}>Download CSV report</DownloadLink>}
          {finished && <DownloadLink href={reportHref(runId, 'json')}>Download JSON report</DownloadLink>}
          {finished && <Button variant="ghost" onClick={() => refetch()}>Refresh</Button>}
        </FormActions>
      </Card>
      {run && <RunDetail run={run} describeItem={describeItem} />}
    </>
  );
}

export function RunDetail({ run, describeItem }) {
  const t = run.totals || {};
  return (
    <Card title={`Run #${run.id} · ${run.kind === 'change_ip' ? 'IP change' : 'modify/upgrade'}`} subtitle={`Started ${formatDate(run.created_at)} by ${run.requested_by || run.created_by_name || '—'}${run.finished_at ? ` · finished ${formatDate(run.finished_at)}` : ''}`} padded={false}>
      <div className="card-body">
        <Totals items={[['Accounts', t.total], ['Applied', t.done], ['Pending', t.pending], ['Failed', t.failed], ['Unchanged', t.unchanged], ['Skipped', t.skipped]]} />
      </div>
      <DataTable
        columns={[
          { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
          { key: 'domain', label: 'Domain' },
          { key: 'status', label: 'Status', render: (r) => <ItemStatus status={r.status} /> },
          { key: 'change', label: 'Change', render: (r) => (describeItem ? describeItem(r) : null) ?? <span className="muted">—</span> },
          { key: 'steps', label: 'Steps', render: (r) => <StepList steps={r.steps} /> },
          { key: 'detail', label: 'Detail', render: (r) => r.detail || <span className="muted">—</span> },
        ]}
        rows={run.items || []} rowKey={(r) => r.id} dense emptyText="No accounts in this run."
      />
    </Card>
  );
}

// Past runs of one kind with a drill-down and report downloads.
export function RunHistory({ kind, describeItem, refreshKey }) {
  const { data, loading, error, refetch } = useApi(`/multi-account/runs?kind=${kind}&limit=25`);
  const [openId, setOpenId] = useState(null);
  useEffect(() => { if (refreshKey) refetch(); }, [refreshKey, refetch]);
  const { data: open } = useApi(openId ? `/multi-account/runs/${openId}` : null, { enabled: Boolean(openId) });
  return (
    <>
      <Card title="Recent runs" padded={false} actions={<Button size="sm" variant="ghost" onClick={() => refetch()}>Refresh</Button>}>
        <DataTable
          columns={[
            { key: 'id', label: 'Run', render: (r) => `#${r.id}` },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
            { key: 'totals', label: 'Result', render: (r) => <span className="muted">{r.totals?.total ?? 0} accounts · {r.totals?.done ?? 0} applied · {r.totals?.pending ?? 0} pending · {r.totals?.failed ?? 0} failed</span> },
            { key: 'requested_by', label: 'By', render: (r) => r.requested_by || r.created_by_name || '—' },
            { key: 'created_at', label: 'Started', render: (r) => formatDate(r.created_at) },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(r) => r.id} dense emptyText="No runs yet."
          rowActions={(r) => [
            { label: openId === r.id ? 'Hide' : 'Details', primary: true, onClick: () => setOpenId(openId === r.id ? null : r.id) },
            { label: 'CSV report', onClick: () => { window.location.href = reportHref(r.id, 'csv'); } },
            { label: 'JSON report', onClick: () => { window.location.href = reportHref(r.id, 'json'); } },
          ]}
        />
      </Card>
      {openId && open && <RunDetail run={open} describeItem={describeItem} />}
    </>
  );
}
