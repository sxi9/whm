import { useEffect, useMemo, useState } from 'react';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, EmptyState, formatBytes, formatDuration, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Field, Select, NumberInput, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { RequestError, Tabs } from '../security/Shared.jsx';

const SERIES = {
  cpu: { label: 'CPU % (sum of ps %CPU, lifetime average per process)', key: 'cpuPercent', color: 'var(--primary)', unit: '%' },
  mem: { label: 'Memory % (all processes)', key: 'memPercent', color: 'var(--warn)', unit: '%' },
  load: { label: 'Load average (1 min)', key: 'load1', color: 'var(--ok)', unit: '' },
  userCpu: { label: 'CPU % (selected user, ps %CPU)', key: 'userCpuPercent', color: 'var(--info)', unit: '%' },
  userMem: { label: 'Memory % (selected user)', key: 'userMemPercent', color: 'var(--bad)', unit: '%' },
};

// Days are keyed by UTC date on the server, so times render in UTC too; a
// local-time clock would spill a day's samples into its neighbours.
function timeOf(at) {
  const d = new Date(at.replace(' ', 'T') + 'Z');
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// A dependency-free line chart: time on the x-axis, one line per metric, with a
// hover readout. Values are plotted on a shared 0..max scale per metric group.
function DayChart({ series, metrics }) {
  const [hover, setHover] = useState(null);
  const W = 760, H = 220, PL = 44, PR = 12, PT = 12, PB = 28;
  const points = series.filter((p) => metrics.some((m) => p[SERIES[m].key] != null));
  if (points.length < 2) return <div className="muted" style={{ padding: 12 }}>At least two samples are needed to draw a chart. The sampler runs every 5 minutes.</div>;
  const t0 = new Date(points[0].at.replace(' ', 'T') + 'Z').getTime();
  const t1 = new Date(points.at(-1).at.replace(' ', 'T') + 'Z').getTime();
  const x = (p) => PL + ((new Date(p.at.replace(' ', 'T') + 'Z').getTime() - t0) / Math.max(1, t1 - t0)) * (W - PL - PR);
  const max = Math.max(1, ...metrics.flatMap((m) => points.map((p) => p[SERIES[m].key] ?? 0))) * 1.1;
  const y = (v) => PT + (1 - (v ?? 0) / max) * (H - PT - PB);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(points[i]) - px) < Math.abs(x(points[best]) - px)) best = i;
    setHover(best);
  };
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Resource usage over the day">
        {ticks.map((t) => <g key={t}><line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray="3 3" /><text x={PL - 6} y={y(t) + 4} fontSize="10" textAnchor="end" fill="var(--text-muted)">{t >= 10 ? Math.round(t) : t.toFixed(1)}</text></g>)}
        {points.map((p, i) => (i % labelEvery === 0 ? <text key={p.id} x={x(p)} y={H - 8} fontSize="10" textAnchor="middle" fill="var(--text-muted)">{timeOf(p.at)}</text> : null))}
        {metrics.map((m) => <polyline key={m} fill="none" stroke={SERIES[m].color} strokeWidth="2" points={points.map((p) => `${x(p).toFixed(1)},${y(p[SERIES[m].key]).toFixed(1)}`).join(' ')} />)}
        {hover != null && <line x1={x(points[hover])} x2={x(points[hover])} y1={PT} y2={H - PB} stroke="var(--text-muted)" />}
        {hover != null && metrics.map((m) => <circle key={m} cx={x(points[hover])} cy={y(points[hover][SERIES[m].key])} r="4" fill={SERIES[m].color} />)}
      </svg>
      {hover != null && (
        <div className="card" style={{ position: 'absolute', top: 8, right: 8, padding: '8px 10px', fontSize: 12, pointerEvents: 'none' }}>
          <strong>{timeOf(points[hover].at)}</strong>
          {metrics.map((m) => <div key={m}><span style={{ display: 'inline-block', width: 8, height: 8, background: SERIES[m].color, marginRight: 6, borderRadius: 2 }} />{SERIES[m].label}: {points[hover][SERIES[m].key] == null ? '—' : `${Number(points[hover][SERIES[m].key]).toFixed(2)}${SERIES[m].unit}`}</div>)}
          <div className="muted">{points[hover].processCount} processes · {formatBytes(points[hover].memUsedBytes)} used</div>
        </div>
      )}
      <div className="row-actions" style={{ flexWrap: 'wrap', justifyContent: 'flex-start', gap: 12, padding: '8px 12px', fontSize: 12 }}>
        {metrics.map((m) => <span key={m}><span style={{ display: 'inline-block', width: 10, height: 10, background: SERIES[m].color, marginRight: 6, borderRadius: 2, verticalAlign: 'middle' }} />{SERIES[m].label}</span>)}
      </div>
    </div>
  );
}

function SettingsCard({ settings, days, onSaved }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setForm(settings), [settings]);
  const dirty = form && settings && ['enabled', 'topN', 'retentionDays'].some((k) => form[k] !== settings[k]);
  const save = async () => {
    if (form.retentionDays < settings.retentionDays) {
      const cutoff = new Date(Date.now() - form.retentionDays * 86_400_000).toISOString().slice(0, 10);
      const doomed = (days || []).filter((d) => d.day < cutoff);
      if (doomed.length && !(await confirm({ title: `Delete ${doomed.length} day${doomed.length === 1 ? '' : 's'} of process history?`, message: `Lowering retention to ${form.retentionDays} days removes every day before ${cutoff} (${doomed.reduce((n, d) => n + d.samples, 0)} samples) as soon as you save. This cannot be undone.`, confirmLabel: 'Save and delete', danger: true }))) return;
    }
    setBusy(true); setError(null);
    try {
      const { data } = await api.put('/server-status/process-log/settings', { enabled: form.enabled, topN: form.topN, retentionDays: form.retentionDays });
      toast.success(data.enabled ? 'Sampler settings saved' : 'Sampler paused');
      onSaved(data);
    } catch (err) { setError(err); toast.error(err); } finally { setBusy(false); }
  };
  if (!form) return null;
  return (
    <Card title="Sampler" subtitle={settings.schedule ? `${settings.schedule.cron} · next run ${settings.schedule.nextRunAt ? formatDate(settings.schedule.nextRunAt) : '—'}` : 'Schedule not registered'}>
      <ErrorBanner error={error} />
      <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Record processes every 5 minutes" description="This switch is authoritative; the process-log-sampler schedule under Server Configuration > Configure cPanel Cron Jobs follows it, and scheduled runs record nothing while it is off." />
      {settings.schedule && settings.schedule.enabled !== settings.enabled && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>The process-log-sampler schedule is currently {settings.schedule.enabled ? 'enabled' : 'paused'} in Configure cPanel Cron Jobs; it is realigned to this setting on the next save or panel restart.</div>
      )}
      <div className="form-grid" style={{ marginTop: 12 }}>
        <Field label="Processes per sample" help="Top N by CPU plus top N by memory, de-duplicated."><NumberInput value={form.topN} onChange={(v) => setForm({ ...form, topN: v })} min={1} max={200} nullable={false} /></Field>
        <Field label="Retention (days)" help="Older days are removed after each sample and immediately when you lower this value."><NumberInput value={form.retentionDays} onChange={(v) => setForm({ ...form, retentionDays: v })} min={1} max={90} nullable={false} /></Field>
      </div>
      <FormActions><Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>Save</Button></FormActions>
    </Card>
  );
}

export default function DailyProcessLog({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const days = useApi('/server-status/process-log/days');
  const [date, setDate] = useState('');
  const [user, setUser] = useState('');
  const [tab, setTab] = useState('processes');
  const [metrics, setMetrics] = useState(['cpu', 'load']);
  const [open, setOpen] = useState(null);
  const [sampling, setSampling] = useState(false);
  const available = days.data?.days || [];
  useEffect(() => { if (!date && available.length) setDate(available[0].day); }, [available, date]);
  const day = useApi(date ? `/server-status/process-log/day/${date}${queryString({ user: user || undefined })}` : null);
  const selected = available.find((d) => d.day === date);
  const effectiveMetrics = useMemo(() => (user ? metrics.map((m) => (m === 'cpu' ? 'userCpu' : m === 'mem' ? 'userMem' : m)) : metrics), [metrics, user]);

  const sampleNow = async () => {
    setSampling(true);
    try {
      const { data } = await api.post('/server-status/process-log/sample');
      toast.info(`Sample queued (job #${data.job.id}); the table refreshes in a few seconds.`);
      setTimeout(() => { days.refetch(true); day.refetch(true); setSampling(false); }, 2500);
    } catch (err) { toast.error(err); setSampling(false); }
  };
  const purge = async () => {
    if (!(await confirm({ title: `Delete the process log for ${date}?`, message: `${selected?.samples ?? 0} sample(s) and their process entries are removed. This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.delete(`/server-status/process-log/day/${date}`);
      toast.success(`Deleted the log for ${date}`);
      setDate('');
      days.refetch();
    } catch (err) { toast.error(err); }
  };
  const openSample = async (id) => {
    try { const { data } = await api.get(`/server-status/process-log/samples/${id}`); setOpen(data); } catch (err) { toast.error(err); }
  };
  const toggleMetric = (m) => setMetrics((cur) => (cur.includes(m) ? (cur.length > 1 ? cur.filter((x) => x !== m) : cur) : [...cur, m]));

  const users = day.data?.users || [];
  return (
    <>
      <PageHeader fn={fn} description="Every 5 minutes the panel records the busiest processes by CPU and memory. Pick a day (UTC) to see how the load developed, which programs and which users caused it. CPU figures are the %CPU column of ps: each process's lifetime average, summed, not an instantaneous reading." actions={<>
        <Button loading={sampling} onClick={sampleNow}>Sample now</Button>
        <button className="btn" onClick={() => { days.refetch(); day.refetch(); }}>Refresh</button>
      </>} />
      <RequestError error={days.error} onRetry={days.refetch} />
      {days.loading && !days.data && <Loading />}
      {days.data && (
        <>
          {!available.length && (
            <Card>
              <EmptyState title="No samples recorded yet">
                {days.data.settings.enabled ? <p>The sampler runs every 5 minutes while the panel is up; the first day appears after the first run. Use "Sample now" to record one immediately.</p> : <p>The sampler is paused. Enable it below or use "Sample now".</p>}
              </EmptyState>
            </Card>
          )}
          {available.length > 0 && (
            <Card>
              <div className="form-grid">
                <Field label="Day"><Select value={date} onChange={(v) => { setDate(v); setUser(''); }} options={available.map((d) => ({ value: d.day, label: `${d.day} · ${d.samples} samples · peak load ${d.peakLoad1 == null ? '—' : d.peakLoad1.toFixed(2)}` }))} /></Field>
                <Field label="User" help="Aggregate the day for one system user."><Select value={user} onChange={setUser} placeholder="All users" options={users.map((u) => ({ value: u.user, label: `${u.user} (${u.commands} program${u.commands === 1 ? '' : 's'})` }))} /></Field>
              </div>
              {selected && (
                <div className="stat-grid">
                  <div className="stat"><div className="label">Samples</div><div className="value">{selected.samples}</div><small className="muted">{selected.firstAt ? `${timeOf(selected.firstAt)} – ${timeOf(selected.lastAt)} UTC` : ''}</small></div>
                  <div className="stat"><div className="label">Peak load (1 min)</div><div className="value">{selected.peakLoad1 == null ? '—' : selected.peakLoad1.toFixed(2)}</div><small className="muted">average {selected.avgLoad1 == null ? '—' : selected.avgLoad1.toFixed(2)}</small></div>
                  <div className="stat"><div className="label">Peak CPU (ps %CPU)</div><div className="value">{selected.peakCpu == null ? '—' : `${selected.peakCpu.toFixed(1)}%`}</div><small className="muted">average {selected.avgCpu == null ? '—' : `${selected.avgCpu.toFixed(1)}%`}</small></div>
                  <div className="stat"><div className="label">Peak memory</div><div className="value">{selected.peakMem == null ? '—' : `${selected.peakMem.toFixed(1)}%`}</div><small className="muted">sum of process RSS shares</small></div>
                </div>
              )}
            </Card>
          )}
          {date && (
            <>
              <RequestError error={day.error} onRetry={day.refetch} />
              <Card title={`Usage over ${date}${user ? ` · ${user}` : ''}`} padded={false} actions={<div className="row-actions" style={{ flexWrap: 'wrap' }}>
                {['cpu', 'mem', 'load'].map((m) => <button key={m} className={`btn btn-sm ${metrics.includes(m) ? 'btn-primary' : ''}`} onClick={() => toggleMetric(m)}>{m === 'cpu' ? 'CPU' : m === 'mem' ? 'Memory' : 'Load'}</button>)}
              </div>}>
                {day.loading && !day.data ? <Loading /> : day.data ? <DayChart series={day.data.series} metrics={effectiveMetrics} /> : null}
              </Card>
              <Card padded={false}>
                <div style={{ padding: '14px 18px 0' }}>
                  <Tabs value={tab} onChange={setTab} tabs={[{ value: 'processes', label: 'By program', count: day.data?.processes.length }, { value: 'users', label: 'By user', count: users.length }, { value: 'samples', label: 'Samples', count: day.data?.samples }]} />
                </div>
                {tab === 'processes' && (
                  <DataTable
                    columns={[
                      { key: 'command', label: 'Program', render: (p) => <><code>{p.command}</code>{p.args && <div><small className="muted">{p.args}</small></div>}</> },
                      { key: 'user', label: 'User' },
                      { key: 'avgCpu', label: 'Avg CPU %', align: 'right', render: (p) => p.avgCpu.toFixed(1) },
                      { key: 'peakCpu', label: 'Peak CPU %', align: 'right', render: (p) => p.peakCpu.toFixed(1) },
                      { key: 'avgMem', label: 'Avg Mem %', align: 'right', render: (p) => p.avgMem.toFixed(1) },
                      { key: 'peakRssBytes', label: 'Peak RSS', align: 'right', render: (p) => formatBytes(p.peakRssBytes) },
                      { key: 'samples', label: 'Seen in', align: 'right', render: (p) => `${p.samples}/${day.data.samples}` },
                      { key: 'maxElapsedSeconds', label: 'Longest run', render: (p) => formatDuration(p.maxElapsedSeconds) },
                    ]}
                    rows={day.data?.processes || []} loading={day.loading} rowKey={(p) => `${p.user}:${p.command}`} emptyText="No processes recorded for this selection." dense
                  />
                )}
                {tab === 'users' && (
                  <DataTable
                    columns={[
                      { key: 'user', label: 'User', render: (u) => <code>{u.user}</code> },
                      { key: 'commands', label: 'Programs', align: 'right' },
                      { key: 'avgCpu', label: 'Avg CPU %', align: 'right', render: (u) => u.avgCpu.toFixed(1) },
                      { key: 'peakCpu', label: 'Peak CPU % (one process)', align: 'right', render: (u) => u.peakCpu.toFixed(1) },
                      { key: 'avgMem', label: 'Avg Mem %', align: 'right', render: (u) => u.avgMem.toFixed(1) },
                      { key: 'peakRssBytes', label: 'Peak RSS', align: 'right', render: (u) => formatBytes(u.peakRssBytes) },
                      { key: 'share', label: 'CPU share', render: (u) => { const total = users.reduce((n, x) => n + x.avgCpu, 0); return <div className="meter" style={{ marginTop: 0, minWidth: 100 }}><span style={{ width: `${total ? (u.avgCpu / total) * 100 : 0}%` }} /></div>; } },
                    ]}
                    rows={users} loading={day.loading} rowKey={(u) => u.user} emptyText="No users recorded for this day." dense
                    rowActions={(u) => [{ label: user === u.user ? 'Show all' : 'Filter', primary: user !== u.user, onClick: () => setUser(user === u.user ? '' : u.user) }]}
                  />
                )}
                {tab === 'samples' && (
                  <DataTable
                    columns={[
                      { key: 'at', label: 'Time (UTC)', render: (s) => timeOf(s.at) },
                      { key: 'load1', label: 'Load 1 / 5 / 15', render: (s) => [s.load1, s.load5, s.load15].map((n) => (n == null ? '—' : n.toFixed(2))).join(' / ') },
                      { key: 'cpuPercent', label: 'CPU %', align: 'right', render: (s) => s.cpuPercent.toFixed(1) },
                      { key: 'memPercent', label: 'Mem %', align: 'right', render: (s) => s.memPercent.toFixed(1) },
                      { key: 'memUsedBytes', label: 'Memory used', align: 'right', render: (s) => (s.memTotalBytes ? `${formatBytes(s.memUsedBytes)} / ${formatBytes(s.memTotalBytes)}` : '—') },
                      { key: 'processCount', label: 'Processes', align: 'right' },
                      ...(user ? [{ key: 'userCpuPercent', label: `${user} CPU %`, align: 'right', render: (s) => s.userCpuPercent.toFixed(1) }, { key: 'userProcesses', label: `${user} procs`, align: 'right' }] : []),
                    ]}
                    rows={day.data?.series || []} loading={day.loading} rowKey={(s) => s.id} emptyText="No samples." dense
                    rowActions={(s) => [{ label: 'Processes', primary: true, onClick: () => openSample(s.id) }]}
                  />
                )}
              </Card>
              <div className="action-row"><Button variant="danger" onClick={purge}>Delete this day's log</Button></div>
            </>
          )}
          <SettingsCard settings={days.data.settings} days={available} onSaved={() => days.refetch(true)} />
        </>
      )}
      <Modal open={Boolean(open)} title={open ? `Sample at ${formatDate(open.at)}` : ''} onClose={() => setOpen(null)} size="lg">
        {open && (
          <>
            <div className="stat-grid" style={{ marginBottom: 12 }}>
              <div className="stat"><div className="label">Load</div><div className="value">{open.load.map((n) => (n == null ? '—' : n.toFixed(2))).join(' / ')}</div></div>
              <div className="stat"><div className="label">CPU %</div><div className="value">{open.cpuPercent.toFixed(1)}</div></div>
              <div className="stat"><div className="label">Memory</div><div className="value">{formatBytes(open.memUsedBytes)}</div><small className="muted">of {formatBytes(open.memTotalBytes)}</small></div>
              <div className="stat"><div className="label">Processes</div><div className="value">{open.processCount}</div><small className="muted">{open.entries.length} recorded</small></div>
            </div>
            <DataTable
              columns={[
                { key: 'pid', label: 'PID', width: 80 },
                { key: 'user', label: 'User' },
                { key: 'cpuPercent', label: 'CPU %', align: 'right', render: (p) => p.cpuPercent.toFixed(1) },
                { key: 'memPercent', label: 'Mem %', align: 'right', render: (p) => p.memPercent.toFixed(1) },
                { key: 'rssBytes', label: 'RSS', align: 'right', render: (p) => formatBytes(p.rssBytes) },
                { key: 'elapsedSeconds', label: 'Running', render: (p) => formatDuration(p.elapsedSeconds) },
                { key: 'command', label: 'Command', render: (p) => <><code>{p.command}</code> <small className="muted">{p.args}</small></> },
              ]}
              rows={open.entries} rowKey={(p) => p.pid} dense
            />
            <p className="muted" style={{ marginTop: 10 }}>{open.entries.length ? <StatusPill status="info">historical</StatusPill> : null} Processes that are still running can be managed under System Health › Process Manager.</p>
          </>
        )}
      </Modal>
    </>
  );
}
