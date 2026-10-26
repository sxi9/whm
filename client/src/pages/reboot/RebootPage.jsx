import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Power } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { ActionPage } from '../../components/ActionPage.jsx';
import { Card, StatusPill, KeyValue, Loading, CapabilityNotice, formatDuration, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, ErrorBanner } from '../../components/Form.jsx';
import { DataTable } from '../../components/DataTable.jsx';

const MODES = {
  graceful: {
    buttonLabel: 'Graceful Reboot',
    summary: 'systemd stops every service in dependency order (web, mail, databases, the panel itself) and then reboots. Use this unless the server is unresponsive.',
    command: 'systemctl reboot',
  },
  forceful: {
    buttonLabel: 'Forceful Reboot',
    summary: 'Reboots immediately without waiting for services to stop. Unsaved data in running services (database writes, mail in transit) may be lost. Use only when a graceful reboot hangs.',
    command: 'systemctl reboot --force',
  },
};

const HEALTH_POLL_MS = 3000;
const HEALTH_TIMEOUT_MS = 20 * 60 * 1000;

// After the reboot command is accepted the panel goes away with the host. This
// polls the public /api/health endpoint until it fails (host going down) and
// then succeeds again (panel back), so the operator sees when they can continue.
export function RebootWatcher({ startedAt, mode }) {
  const [phase, setPhase] = useState('waiting');
  const [checks, setChecks] = useState(0);
  const [backAt, setBackAt] = useState(null);
  const seenOffline = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const began = Date.now();
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - began > HEALTH_TIMEOUT_MS) { setPhase('timeout'); return; }
      let up = false;
      try { const res = await api.get('/health'); up = Boolean(res?.data?.ok); } catch { up = false; }
      if (cancelled) return;
      setChecks((n) => n + 1);
      if (!up) {
        seenOffline.current = true;
        setPhase('offline');
      } else if (seenOffline.current) {
        setPhase('online');
        setBackAt(new Date());
        return;
      }
      setTimeout(tick, HEALTH_POLL_MS);
    };
    const first = setTimeout(tick, HEALTH_POLL_MS);
    return () => { cancelled = true; clearTimeout(first); };
  }, []);

  const label = {
    waiting: 'Reboot command accepted; waiting for the server to go down…',
    offline: 'Server is rebooting — the panel is offline. This page keeps checking…',
    online: 'The server is back online. You can continue using the panel.',
    timeout: 'The panel has not answered for 20 minutes. Check the server console or your provider’s out-of-band access.',
  }[phase];
  const tone = { waiting: 'banner-info', offline: 'banner-warning', online: 'banner-success', timeout: 'banner-error' }[phase];
  const Icon = phase === 'online' ? CheckCircle2 : phase === 'timeout' ? AlertTriangle : Clock;
  return (
    <div className={`banner ${tone}`} role="status" aria-live="polite">
      <Icon size={18} />
      <div>
        <strong>{label}</strong>
        <p className="muted">{mode} reboot requested {formatDate(startedAt)} · {checks} health check(s){backAt ? ` · back ${backAt.toLocaleTimeString()}` : ''}</p>
        {phase === 'online' && <button className="btn btn-sm" onClick={() => window.location.reload()}>Reload the panel</button>}
      </div>
    </div>
  );
}

export function PreflightSummary({ data }) {
  const active = data.activeWork;
  return (
    <>
      <KeyValue items={[
        ['Hostname', data.hostname ? <code key="h">{data.hostname}</code> : null],
        ['Uptime', data.uptimeSeconds != null ? formatDuration(data.uptimeSeconds) : null],
        ['Load average', data.loadAverage ? data.loadAverage.map((n) => n.toFixed(2)).join(' / ') : null],
        ['systemd', <StatusPill key="sd" status={data.capability.systemd ? 'installed' : 'not-installed'}>{data.capability.systemd ? 'systemctl available' : 'systemctl missing'}</StatusPill>],
        ['Reboot required by updates', data.rebootRequired == null ? <span key="rr" className="muted">unknown</span> : <StatusPill key="rr" status={data.rebootRequired ? 'warning' : 'ok'}>{data.rebootRequired ? 'Yes — pending kernel/library updates' : 'No'}</StatusPill>],
        ['Running jobs', <StatusPill key="rj" status={data.jobs.running ? 'warning' : 'ok'}>{data.jobs.running}</StatusPill>],
        ['Queued jobs', <StatusPill key="qj" status={data.jobs.queued ? 'warning' : 'ok'}>{data.jobs.queued}</StatusPill>],
        ['Active transfers', data.transfers.available ? <StatusPill key="tr" status={data.transfers.count ? 'warning' : 'ok'}>{data.transfers.count}</StatusPill> : <span key="tr" className="muted">transfers module not loaded</span>],
        ['Active backups', data.backups.available ? <StatusPill key="bk" status={data.backups.count + data.restores.count ? 'warning' : 'ok'}>{data.backups.count + data.restores.count}</StatusPill> : <span key="bk" className="muted">backup module not loaded</span>],
        data.lastRequest && ['Last panel reboot', <span key="lr">{data.lastRequest.mode} by {data.lastRequest.principal || 'unknown'} {formatDate(data.lastRequest.requested_at)} · <StatusPill status={data.lastRequest.status === 'failed' ? 'failed' : data.lastRequest.completed ? 'done' : 'pending'}>{data.lastRequest.status === 'failed' ? 'failed' : data.lastRequest.completed ? 'completed' : 'not yet rebooted'}</StatusPill></span>],
      ]} />
      {active ? (
        <div className="banner banner-warning">
          <AlertTriangle size={18} />
          <div>
            <strong>Work in progress will be interrupted</strong>
            <ul>{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            <small>Running jobs are marked failed when the panel restarts; queued jobs resume after boot. Transfers and backups must be started again.</small>
          </div>
        </div>
      ) : (
        <div className="banner banner-success"><CheckCircle2 size={18} /><div><strong>No jobs, transfers or backups are running</strong><small>The server is idle from the panel’s point of view.</small></div></div>
      )}
      {!data.capability.systemd && (
        <div className="banner banner-error"><AlertTriangle size={18} /><div><strong>systemctl is not installed</strong><small>The panel reboots through systemd. Without it the reboot request is refused.</small></div></div>
      )}
      {data.jobs.items.length > 0 && (
        <DataTable
          dense
          columns={[
            { key: 'id', label: 'Job' },
            { key: 'type', label: 'Type', render: (j) => <code>{j.type}</code> },
            { key: 'status', label: 'Status', render: (j) => <StatusPill status={j.status} /> },
            { key: 'progress', label: 'Progress', align: 'right', render: (j) => `${j.progress ?? 0}%` },
            { key: 'message', label: 'Message', render: (j) => j.message || <span className="muted">—</span> },
            { key: 'started_at', label: 'Started', render: (j) => formatDate(j.started_at || j.created_at) },
          ]}
          rows={data.jobs.items} rowKey={(j) => j.id}
        />
      )}
    </>
  );
}

export function RebootHistory() {
  const { data, loading, error } = useApi('/system-reboot/history?limit=10');
  if (!loading && !error && !(data || []).length) return null;
  return (
    <Card title="Recent reboot requests" subtitle="Reboots requested through the panel. Completed means the kernel boot id changed after the request." padded={false}>
      <DataTable
        dense
        columns={[
          { key: 'requested_at', label: 'Requested', render: (r) => formatDate(r.requested_at) },
          { key: 'mode', label: 'Mode', render: (r) => <StatusPill status={r.mode === 'forceful' ? 'warning' : 'info'}>{r.mode}</StatusPill> },
          { key: 'principal', label: 'By', render: (r) => r.principal || <span className="muted">—</span> },
          { key: 'reason', label: 'Reason', render: (r) => r.reason || <span className="muted">—</span> },
          { key: 'status', label: 'Result', render: (r) => <StatusPill status={r.status === 'failed' ? 'failed' : 'ok'}>{r.status === 'failed' ? `failed: ${r.error}` : 'triggered'}</StatusPill> },
          { key: 'warnings', label: 'Interrupted work', render: (r) => (r.preflight?.warnings?.length ? r.preflight.warnings.join('; ') : <span className="muted">none</span>) },
        ]}
        rows={data || []} loading={loading} error={error} rowKey={(r) => r.id}
      />
    </Card>
  );
}

export default function RebootPage({ fn, mode }) {
  const spec = MODES[mode];
  const preflight = useApi('/system-reboot/preflight', { refreshMs: 15_000 });
  const [reason, setReason] = useState('');
  const data = preflight.data;
  const warnings = data?.warnings || [];
  const confirmMessage = [
    `${spec.buttonLabel.toLowerCase()} of ${data?.hostname || 'this server'} (${spec.command}). Every connection to this server will drop and the panel will be unavailable until it is back.`,
    mode === 'forceful' ? 'Services are NOT stopped cleanly; data held in memory by running services may be lost.' : null,
    warnings.length ? `Work in progress: ${warnings.join('; ')}.` : null,
  ].filter(Boolean).join(' ');

  return (
    <>
      <ActionPage
        fn={fn}
        danger
        buttonLabel={spec.buttonLabel}
        confirmMessage={confirmMessage}
        typeToConfirm="REBOOT"
        run={async () => {
          const { data: result } = await api.post(`/system-reboot/${mode}`, { reason: reason.trim() || undefined, ignoreActiveWork: warnings.length > 0 });
          return result;
        }}
        renderResult={(result) => (
          <>
            <KeyValue items={[
              ['Result', <StatusPill key="r" status="ok">reboot command accepted</StatusPill>],
              ['Mode', result.mode],
              ['Command', <code key="c">{spec.command}</code>],
              result.reason && ['Reason', result.reason],
              ['Requested', formatDate(result.requested_at)],
            ]} />
            <RebootWatcher startedAt={result.requested_at} mode={result.mode} />
          </>
        )}
      >
        <div className="banner banner-info"><Power size={18} /><div><strong>{spec.buttonLabel}</strong><p>{spec.summary}</p><small>Runs <code>{spec.command}</code> through the agent, records the request in the audit log and in the reboot history, and then watches for the panel to come back.</small></div></div>
        {preflight.loading && !data && <Loading text="Running pre-flight checks…" />}
        <CapabilityNotice error={preflight.error} onRetry={() => preflight.refetch()} />
        {preflight.error && preflight.error.code !== 'capability_missing' && <ErrorBanner error={preflight.error} onRetry={() => preflight.refetch()} />}
        {data && <PreflightSummary data={data} />}
        <Field label="Reason (optional)" help="Recorded in the audit log and the reboot history, for example “kernel update” or “stuck NFS mount”.">
          <TextInput value={reason} onChange={setReason} maxLength={200} placeholder="Why is the server being rebooted?" />
        </Field>
      </ActionPage>
      <RebootHistory />
    </>
  );
}
