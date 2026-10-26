import { useCallback, useState } from 'react';
import { api } from '../../api/client.js';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, EmptyState, formatDate, formatDuration } from '../../components/Common.jsx';
import { Button, ErrorBanner } from '../../components/Form.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { formatRate } from './BundledPlugin.jsx';

const RANGES = [['1h', 'Last hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days']];
const W = 640;
const H = 150;
const PAD = { top: 14, right: 12, bottom: 22, left: 44 };

// One series (or two, for network in/out) as a thin line with a dashed
// threshold rule and a hover crosshair. Values are drawn in text tokens, the
// line in the primary hue; the threshold crossing is also named in the tile,
// so colour is never the only signal.
export function Sparkline({ series, threshold, format = (v) => String(v), unit = '', label, from, to }) {
  const [hover, setHover] = useState(null);
  const lists = series.filter((s) => s.points.some((p) => p.v != null));
  if (!lists.length) return <p className="muted">No samples in this range yet.</p>;
  const all = lists.flatMap((s) => s.points.map((p) => p.v)).filter((v) => v != null);
  const maxValue = Math.max(1e-9, ...all, threshold || 0) * 1.1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (ts) => PAD.left + ((ts - from) / Math.max(1, to - from)) * plotW;
  const y = (v) => PAD.top + plotH - (v / maxValue) * plotH;
  const pathOf = (points) => {
    let d = '';
    let pen = false;
    for (const p of points) {
      if (p.v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)} `;
      pen = true;
    }
    return d;
  };
  const ticks = [0, 0.5, 1].map((f) => (maxValue / 1.1) * f);
  const base = lists[0].points;
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const ts = from + ((px - PAD.left) / plotW) * (to - from);
    let best = 0;
    for (let i = 1; i < base.length; i++) if (Math.abs(base[i].ts - ts) < Math.abs(base[best].ts - ts)) best = i;
    setHover(best);
  };
  const timeLabel = (ts) => { const d = new Date(ts); return to - from > 36 * 3600e3 ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00` : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const hovered = hover == null ? null : base[hover];
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} style={{ display: 'block' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--text-faint)">{format(v)}{unit}</text>
          </g>
        ))}
        {threshold > 0 && threshold <= maxValue && (
          <g>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(threshold)} y2={y(threshold)} stroke="var(--warn)" strokeWidth="1.5" strokeDasharray="5 4" />
            <text x={W - PAD.right} y={y(threshold) - 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">alert at {format(threshold)}{unit}</text>
          </g>
        )}
        {lists.map((s, i) => <path key={s.key} d={pathOf(s.points)} fill="none" stroke={i === 0 ? 'var(--primary)' : 'var(--text-muted)'} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={i === 0 ? undefined : '3 3'} />)}
        {hovered && <line x1={x(hovered.ts)} x2={x(hovered.ts)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--border-strong)" strokeWidth="1" />}
        {hovered && lists.map((s, i) => { const p = s.points[hover]; return p?.v == null ? null : <circle key={s.key} cx={x(p.ts)} cy={y(p.v)} r="4" fill={i === 0 ? 'var(--primary)' : 'var(--text-muted)'} stroke="var(--surface)" strokeWidth="2" />; })}
        <text x={PAD.left} y={H - 6} fontSize="10" fill="var(--text-muted)">{timeLabel(from)}</text>
        <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize="10" fill="var(--text-muted)">{timeLabel(to)}</text>
        {lists.length > 1 && lists.map((s, i) => <text key={s.key} x={PAD.left + i * 70} y={PAD.top - 3} fontSize="10" fill="var(--text-muted)">{i === 0 ? '━' : '┄'} {s.label}</text>)}
      </svg>
      {hovered && (
        <div className="card" style={{ position: 'absolute', top: 2, left: `${(x(hovered.ts) / W) * 100}%`, transform: `translateX(${x(hovered.ts) > W / 2 ? '-105%' : '5%'})`, padding: '6px 10px', fontSize: 12, pointerEvents: 'none', boxShadow: 'var(--shadow)' }}>
          <strong>{new Date(hovered.ts).toLocaleString()}</strong>
          {lists.map((s) => <div key={s.key}>{s.label}: {s.points[hover]?.v == null ? '—' : `${format(s.points[hover].v)}${unit}`}</div>)}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, over, sub }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value ?? '—'} {over && <StatusPill status="warning">over threshold</StatusPill>}</div>
      {sub && <div className="muted" style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

export function ServerMonitoringOverview({ base, status }) {
  const toast = useToast();
  const [range, setRange] = useState('24h');
  const [jobId, setJobId] = useState(null);
  const metrics = useApi(`${base}/metrics?range=${range}`, { refreshMs: 60_000 });
  const live = useApi(`${base}/status`, { refreshMs: 60_000 });
  const sample = useMutation(useCallback(async () => {
    const res = await api.post(`${base}/sample`, {});
    setJobId(res.data.jobId);
    return res.data;
  }, [base]));
  const d = metrics.data;
  const s = live.data;
  const latest = d?.latest;
  const points = d?.points || [];
  const seriesOf = (key) => points.map((p) => ({ ts: p.ts, v: p[key] }));
  const th = d?.thresholds || s?.thresholds || {};
  const over = (key, v) => th[key] > 0 && v != null && v >= th[key];
  const mb = (v) => (v == null ? '—' : v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`);
  return (
    <>
      <Card title="Current" subtitle={s?.lastSampleAt ? `Last sample ${formatDate(new Date(s.lastSampleAt).toISOString())} · ${s.sampleCount} samples kept for ${s.retentionDays} days · sampled every ${s.intervalMin ?? 1} min in-process` : `No sample yet: the plugin samples the host every ${s?.intervalMin ?? 1} minute${(s?.intervalMin ?? 1) === 1 ? '' : 's'} on an in-process timer while it is enabled.`}
        actions={<><Button size="sm" loading={sample.loading} onClick={() => sample.mutate().catch((e) => toast.error(e))}>Sample now</Button><Button size="sm" onClick={() => { metrics.refetch(); live.refetch(); }}>Refresh</Button></>}>
        <ErrorBanner error={live.error || metrics.error} onRetry={() => { metrics.refetch(); live.refetch(); }} />
        <div className="stat-grid">
          <Tile label="Load (1 / 5 / 15 min)" value={latest ? latest.load?.map((l) => l.toFixed(2)).join(' / ') : null} over={over('load1', latest?.load1)} sub={th.load1 > 0 ? `alert at ${th.load1}` : 'load alert off'} />
          <Tile label="Memory used" value={latest?.memPct != null ? `${latest.memPct}%` : null} over={over('memPct', latest?.memPct)} sub={latest ? `${mb(latest.memUsedMb)} of ${mb(latest.memTotalMb)}` : null} />
          <Tile label="Disk used (fullest mount)" value={latest?.diskPct != null ? `${latest.diskPct}%` : null} over={over('diskPct', latest?.diskPct)} sub={latest?.disks?.length ? latest.disks.map((x) => `${x.mount} ${x.pct ?? '?'}%`).join(' · ') : null} />
          <Tile label="Network in / out" value={latest?.net ? `${formatRate(latest.net.rxRate)} / ${formatRate(latest.net.txRate)}` : null} sub={latest?.uptimeSec != null ? `up ${formatDuration(latest.uptimeSec)}` : null} />
        </div>
        {s?.activeAlerts?.length > 0 && (
          <div className="banner banner-warning" style={{ marginTop: 14 }}>
            <div>
              <strong>{s.activeAlerts.length} active alert{s.activeAlerts.length === 1 ? '' : 's'}</strong>
              <ul>{s.activeAlerts.map((a) => <li key={a.key}>{a.metric} above {a.threshold}{a.unit} since {formatDate(new Date(a.since).toISOString())}</li>)}</ul>
            </div>
          </div>
        )}
        {s && !s.enabled && <p className="banner banner-info" style={{ display: 'block', marginTop: 14 }}>Sampling is switched off in the plugin settings; the timer is stopped and nothing is collected.</p>}
        {s?.enabled && s.collector && !s.collector.running && <p className="banner banner-warning" style={{ display: 'block', marginTop: 14 }}>The sampling timer is not running; disable and re-enable the plugin to restart it.</p>}
        {s?.collector?.lastError && <p className="banner banner-warning" style={{ display: 'block', marginTop: 14 }}>Last sample failed: {s.collector.lastError.message}</p>}
        {jobId && <ProgressLog jobId={jobId} onFinished={(ev) => { if (ev.type === 'done') { toast.success('Sample recorded'); metrics.refetch(); live.refetch(); } else toast.error(ev.error || 'Sampling failed'); }} />}
      </Card>
      <Card title="History" actions={<div style={{ display: 'flex', gap: 6 }}>{RANGES.map(([k, l]) => <Button key={k} size="sm" variant={range === k ? 'primary' : 'default'} onClick={() => setRange(k)}>{l}</Button>)}</div>}>
        {metrics.loading && !d && <Loading />}
        {d && points.length === 0 && <EmptyState title="No samples in this range">The first sample appears within one sampling interval of enabling the plugin; use "Sample now" to take one immediately.</EmptyState>}
        {d && points.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
            <div><h3>Load (1 min)</h3><Sparkline label="1-minute load" series={[{ key: 'load1', label: 'load', points: seriesOf('load1') }]} threshold={th.load1} format={(v) => v.toFixed(1)} from={d.from} to={d.to} /></div>
            <div><h3>Memory used</h3><Sparkline label="Memory used" series={[{ key: 'memPct', label: 'memory', points: seriesOf('memPct') }]} threshold={th.memPct} format={(v) => Math.round(v)} unit="%" from={d.from} to={d.to} /></div>
            <div><h3>Disk used</h3><Sparkline label="Disk used" series={[{ key: 'diskPct', label: 'disk', points: seriesOf('diskPct') }]} threshold={th.diskPct} format={(v) => Math.round(v)} unit="%" from={d.from} to={d.to} /></div>
            <div><h3>Network</h3><Sparkline label="Network throughput" series={[{ key: 'rx', label: 'in', points: seriesOf('rxRate') }, { key: 'tx', label: 'out', points: seriesOf('txRate') }]} format={(v) => formatRate(v)} from={d.from} to={d.to} /></div>
          </div>
        )}
        {d && points.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary className="muted">Table view ({points.length} points)</summary>
            <DataTable dense columns={[{ key: 'ts', label: 'Time', render: (r) => new Date(r.ts).toLocaleString() }, { key: 'load1', label: 'Load' }, { key: 'memPct', label: 'Memory %' }, { key: 'diskPct', label: 'Disk %' }, { key: 'rxRate', label: 'In', render: (r) => formatRate(r.rxRate) }, { key: 'txRate', label: 'Out', render: (r) => formatRate(r.txRate) }]} rows={points.slice(-60).reverse()} rowKey={(r) => r.ts} />
          </details>
        )}
      </Card>
    </>
  );
}
