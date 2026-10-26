import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, formatDate, formatBytes } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, FormActions, Toggle } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';

export const KIND_LABELS = { transfer: 'Transfer', restore: 'Restore', convert_addon: 'Addon conversion' };
export const STEP_TONE = { applied: 'ok', done: 'ok', pending: 'pending', failed: 'failed', skipped: 'disabled', queued: 'queued', running: 'running' };
export const stepPill = (status) => <StatusPill status={STEP_TONE[status] || status}>{status}</StatusPill>;

// Which local tools the transfer features need; shown on every page so a missing
// package is explained before a run fails.
export function ToolingNotice({ caps, needs = [] }) {
  if (!caps) return null;
  const missing = needs.filter((n) => caps[n] && !caps[n].installed);
  if (!missing.length) return null;
  return (
    <div className="banner banner-warning">
      <div>
        <strong>Missing tools on this server</strong>
        <ul>{missing.map((n) => <li key={n}>{caps[n].label}: install <code>{caps[n].packages}</code></li>)}</ul>
        <p className="muted">Install them via <Link to="/software/install-distro-packages">Install Distro Packages</Link>; steps that need them finish as "pending" or are refused until then.</p>
      </div>
    </div>
  );
}

export function Options({ value, onChange, fields }) {
  return (
    <div className="form-grid">
      {fields.map((f) => <Toggle key={f.key} checked={Boolean(value[f.key])} onChange={(v) => onChange({ ...value, [f.key]: v })} label={f.label} description={f.description} />)}
    </div>
  );
}

export function Warnings({ warnings }) {
  if (!warnings?.length) return null;
  return <div className="banner banner-warning"><div><strong>Before you run</strong><ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div></div>;
}

export function Totals({ items }) {
  return (
    <div className="stat-grid" style={{ marginBottom: 14 }}>
      {items.map(([label, value]) => <div className="stat" key={label}><div className="label">{label}</div><div className="value">{value ?? '—'}</div></div>)}
    </div>
  );
}

export function Steps({ step, labels }) {
  return (
    <div className="row-actions" style={{ marginBottom: 14 }}>
      {labels.map((label, i) => <span key={label} className={`pill ${step === i + 1 ? 'pill-info' : step > i + 1 ? 'pill-ok' : 'pill-muted'}`}>{i + 1}. {label}</span>)}
    </div>
  );
}

function StepList({ steps }) {
  const rows = [];
  for (const [name, value] of Object.entries(steps || {})) {
    if (name === 'plan' || value == null) continue;
    if (Array.isArray(value)) for (const v of value) rows.push({ name: `${name} ${v.name || v.domain || ''}`.trim(), status: v.status, detail: v.detail, extra: v.sizeBytes != null ? formatBytes(v.sizeBytes) : null, zone: v.zone || null });
    else if (typeof value === 'object') rows.push({ name, status: value.status, detail: value.detail });
  }
  if (!rows.length) return <span className="muted">—</span>;
  // A zone that could not be stored (no BIND) travels with its step so it can be imported by hand.
  return <ul style={{ margin: 0, paddingLeft: 16 }}>{rows.map((r, i) => <li key={i}><code>{r.name}</code> {stepPill(r.status)} {r.detail && <span className="muted">{r.detail}</span>}{r.extra && <span className="muted"> · {r.extra}</span>}{r.zone && <details><summary>Source zone text</summary><pre className="log" style={{ maxHeight: 240, overflow: 'auto' }}>{r.zone}</pre></details>}</li>)}</ul>;
}

export function RunDetail({ run }) {
  const t = run.totals || {};
  return (
    <Card title={`Run #${run.id} · ${KIND_LABELS[run.kind] || run.kind}`} subtitle={`${run.source ? `Source ${run.source} · ` : ''}started ${formatDate(run.created_at)} by ${run.requested_by || run.created_by_name || '—'}${run.finished_at ? ` · finished ${formatDate(run.finished_at)}` : ''}`} padded={false}>
      <div className="card-body">
        <Totals items={[['Accounts', t.total], ['Done', t.done], ['Pending', t.pending], ['Failed', t.failed], ['Skipped', t.skipped]]} />
      </div>
      <DataTable
        columns={[
          { key: 'source_username', label: 'Source', render: (r) => (r.source_username ? <code>{r.source_username}</code> : <span className="muted">—</span>) },
          { key: 'username', label: 'Account', render: (r) => <code>{r.username}</code> },
          { key: 'domain', label: 'Domain' },
          { key: 'status', label: 'Status', render: (r) => stepPill(r.status) },
          { key: 'steps', label: 'Steps', render: (r) => <StepList steps={r.steps} /> },
          { key: 'detail', label: 'Detail', render: (r) => r.detail || <span className="muted">—</span> },
        ]}
        rows={run.items || []} rowKey={(r) => r.id} dense emptyText="No accounts in this run."
      />
      {run.job?.logs?.length > 0 && (
        <div className="card-body">
          <h3 style={{ marginTop: 0 }}>Job log</h3>
          <pre className="log">{run.job.logs.map((l) => `${l.ts}  ${l.level.toUpperCase().padEnd(5)}  ${l.line}`).join('\n')}</pre>
        </div>
      )}
    </Card>
  );
}

// Live progress of a transfer/restore job followed by the per-account outcome.
export function RunPanel({ job, runId, title, onReset, resetLabel = 'Start another' }) {
  const toast = useToast();
  const [finished, setFinished] = useState(false);
  const { data: run, refetch } = useApi(finished ? `/transfers/runs/${runId}` : null, { enabled: finished });
  const done = useCallback((ev) => {
    setFinished(true);
    if (ev.type === 'done') toast.success(ev.result ? `${ev.result.done} done, ${ev.result.pending} pending, ${ev.result.failed} failed` : 'Run finished');
    else toast.error(ev.error || 'Run failed');
  }, [toast]);
  return (
    <>
      <Card title={title}>
        <ProgressLog jobId={job.id} onFinished={done} />
        <FormActions>
          <Button onClick={onReset}>{resetLabel}</Button>
          {finished && <Button variant="ghost" onClick={() => refetch()}>Refresh</Button>}
          <Link className="btn btn-ghost" to="/transfers/review-transfers-and-restores">Review all runs</Link>
        </FormActions>
      </Card>
      {run && <RunDetail run={run} />}
    </>
  );
}

export function RunHistory({ kind, refreshKey, limit = 10 }) {
  const { data, loading, error, refetch } = useApi(`/transfers/runs?${kind ? `kind=${kind}&` : ''}limit=${limit}`);
  const [openId, setOpenId] = useState(null);
  useEffect(() => { if (refreshKey) refetch(); }, [refreshKey, refetch]);
  const { data: open } = useApi(openId ? `/transfers/runs/${openId}` : null, { enabled: Boolean(openId) });
  return (
    <>
      <Card title="Recent runs" padded={false} actions={<Button size="sm" variant="ghost" onClick={() => refetch()}>Refresh</Button>}>
        <DataTable
          columns={[
            { key: 'id', label: 'Run', render: (r) => `#${r.id}` },
            { key: 'kind', label: 'Kind', render: (r) => KIND_LABELS[r.kind] || r.kind },
            { key: 'source', label: 'Source', render: (r) => (r.source ? <code>{r.source}</code> : '—') },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
            { key: 'totals', label: 'Result', render: (r) => <span className="muted">{r.totals?.total ?? 0} account(s) · {r.totals?.done ?? 0} done · {r.totals?.pending ?? 0} pending · {r.totals?.failed ?? 0} failed</span> },
            { key: 'requested_by', label: 'By', render: (r) => r.requested_by || r.created_by_name || '—' },
            { key: 'created_at', label: 'Started', render: (r) => formatDate(r.created_at) },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(r) => r.id} dense emptyText="No runs yet."
          rowActions={(r) => [{ label: openId === r.id ? 'Hide' : 'Details', primary: true, onClick: () => setOpenId(openId === r.id ? null : r.id) }]}
        />
      </Card>
      {openId && open && <RunDetail run={open} />}
    </>
  );
}

export function PackageSelect({ value, onChange, placeholder = 'Server default package' }) {
  const { data: packages } = useApi('/packages?pageSize=500');
  return (
    <select className="input select" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {(packages || []).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
    </select>
  );
}
