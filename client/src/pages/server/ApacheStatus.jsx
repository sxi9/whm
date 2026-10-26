import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, StatusPill, Loading, formatBytes, formatDuration, formatDate } from '../../components/Common.jsx';
import { DataTable, useTableState } from '../../components/DataTable.jsx';
import { Button } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { RequestError } from '../security/Shared.jsx';

// Colours per scoreboard state, in the order mod_status lists them.
const STATE_COLORS = { waiting: 'var(--ok)', starting: 'var(--info)', reading: 'var(--primary)', sending: 'var(--warn)', keepalive: 'var(--info)', dns: 'var(--text-muted)', closing: 'var(--text-muted)', logging: 'var(--text-muted)', graceful: 'var(--warn)', idle: 'var(--text-muted)', open: 'var(--border)' };

function Scoreboard({ scoreboard }) {
  if (!scoreboard) return null;
  const byChar = Object.fromEntries(scoreboard.states.map((s) => [s.char, s]));
  const cells = [...scoreboard.raw];
  return (
    <>
      <div className="scoreboard" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 14px)', gap: 2, marginBottom: 12 }} aria-label="Worker scoreboard">
        {cells.map((c, i) => {
          const s = byChar[c];
          return <span key={i} title={s ? `${s.label} (${c})` : c} style={{ width: 14, height: 14, borderRadius: 3, background: s ? STATE_COLORS[s.key] : 'var(--bad)', border: '1px solid var(--border)' }} />;
        })}
      </div>
      <div className="table-wrap">
        <table className="dense">
          <thead><tr><th>Key</th><th>State</th><th className="align-right">Workers</th><th style={{ width: '40%' }}>Share</th></tr></thead>
          <tbody>
            {scoreboard.states.filter((s) => s.count > 0 || ['waiting', 'sending', 'open'].includes(s.key)).map((s) => (
              <tr key={s.key}>
                <td><code>{s.char}</code></td>
                <td><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: STATE_COLORS[s.key], marginRight: 6, verticalAlign: 'middle' }} />{s.label}</td>
                <td className="align-right">{s.count}</td>
                <td><div className="meter" style={{ marginTop: 0 }}><span style={{ width: `${scoreboard.total ? (s.count / scoreboard.total) * 100 : 0}%`, background: STATE_COLORS[s.key] }} /></div></td>
              </tr>
            ))}
            {scoreboard.other > 0 && <tr><td><code>?</code></td><td>Unknown state</td><td className="align-right">{scoreboard.other}</td><td /></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// mod_status marks a slot busy in these modes; "_" (waiting) and "." (open)
// are idle and hidden by default so the table shows what is being served.
const BUSY_MODES = ['S', 'R', 'W', 'K', 'D', 'C', 'L', 'G', 'I'];
const sortValue = (w, key) => (key === 'acc' ? w.acc?.child ?? -1 : key === 'mode' ? BUSY_MODES.indexOf(w.mode) : w[key]);

function WorkerTable({ enabled, refreshMs, reason }) {
  const { data, loading, error, refetch } = useApi('/server-status/apache/workers', { enabled, refreshMs });
  const table = useTableState({ sort: 'slot', dir: 'asc', pageSize: 1000 });
  const [busyOnly, setBusyOnly] = useState(true);
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = (data?.workers || []).filter((w) => (!busyOnly || BUSY_MODES.includes(w.mode)) && (!term || [w.vhost, w.client, w.request, w.protocol, String(w.pid ?? '')].some((v) => v && v.toLowerCase().includes(term))));
    const { sort, dir } = table.state;
    return [...list].sort((a, b) => {
      const av = sortValue(a, sort); const bv = sortValue(b, sort);
      const an = av == null; const bn = bv == null;
      if (an || bn) return an && bn ? 0 : an ? 1 : -1;
      const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return dir === 'desc' ? -c : c;
    });
  }, [data, busyOnly, q, table.state]);
  const has = (key) => (data?.columns || []).some((c) => c.key === key);
  const n = (v, digits = 2) => (v == null ? <span className="muted">—</span> : Number(v).toFixed(digits));
  const columns = [
    { key: 'slot', label: 'Srv', sortable: true, width: 70, render: (w) => <code title="Child server number - generation">{w.srv}</code> },
    { key: 'pid', label: 'PID', sortable: true, width: 80, render: (w) => (w.pid == null ? <span className="muted">—</span> : <code>{w.pid}</code>) },
    { key: 'acc', label: 'Acc', sortable: true, width: 110, render: (w) => <span title="Accesses this connection / this child / this slot">{w.acc ? `${w.acc.connection ?? '—'}/${w.acc.child ?? '—'}/${w.acc.slot ?? '—'}` : '—'}</span> },
    { key: 'mode', label: 'M', sortable: true, width: 140, render: (w) => <span title={w.stateLabel || w.mode}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: STATE_COLORS[w.stateKey] || 'var(--bad)', marginRight: 6, verticalAlign: 'middle' }} /><code>{w.mode}</code> <small className="muted">{w.stateLabel}</small></span> },
    has('cpuSeconds') && { key: 'cpuSeconds', label: 'CPU', sortable: true, align: 'right', render: (w) => n(w.cpuSeconds) },
    { key: 'secondsSinceRequest', label: 'SS', sortable: true, align: 'right', render: (w) => n(w.secondsSinceRequest, 0) },
    { key: 'requestMs', label: 'Req', sortable: true, align: 'right', render: (w) => n(w.requestMs, 0) },
    has('durationMs') && { key: 'durationMs', label: 'Dur', sortable: true, align: 'right', render: (w) => n(w.durationMs, 0) },
    { key: 'connKBytes', label: 'Conn', sortable: true, align: 'right', render: (w) => n(w.connKBytes, 1) },
    { key: 'childMBytes', label: 'Child', sortable: true, align: 'right', render: (w) => n(w.childMBytes) },
    { key: 'slotMBytes', label: 'Slot', sortable: true, align: 'right', render: (w) => n(w.slotMBytes) },
    { key: 'client', label: 'Client', sortable: true, render: (w) => (w.client ? <code>{w.client}</code> : <span className="muted">—</span>) },
    has('protocol') && { key: 'protocol', label: 'Protocol', sortable: true, width: 90 },
    { key: 'vhost', label: 'VHost', sortable: true, render: (w) => (w.vhost ? <code>{w.vhost}</code> : <span className="muted">—</span>) },
    { key: 'request', label: 'Request', sortable: true, render: (w) => (w.request ? <code style={{ wordBreak: 'break-all' }}>{w.request}</code> : <span className="muted">—</span>) },
  ].filter(Boolean);
  const summary = data?.summary;
  const subtitle = !enabled ? 'Available while mod_status answers' : data?.available ? `${summary.active} of ${summary.slots} slots active · ${summary.vhosts} vhost${summary.vhosts === 1 ? '' : 's'} · ${summary.clients} client${summary.clients === 1 ? '' : 's'} being served` : 'Per-slot rows need ExtendedStatus On';
  return (
    <Card title="Workers" subtitle={subtitle} padded={false} actions={enabled && <button className="btn btn-sm" onClick={() => refetch()}>Refresh</button>}>
      {!enabled && <div className="card-body muted">No worker table: {reason === 'module_missing' ? 'mod_status is not loaded.' : reason === 'apache_down' ? 'Apache is not running.' : 'the /server-status page did not answer.'}</div>}
      {enabled && error && <div className="card-body"><RequestError error={error} onRetry={refetch} /></div>}
      {enabled && !error && loading && !data && <div className="card-body"><Loading /></div>}
      {enabled && data && !data.available && data.instructions && (
        <div className="card-body">
          <div className="banner banner-warning" style={{ margin: 0 }}>
            <div>
              <strong>{data.instructions.title}</strong>
              <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>{data.instructions.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
              {data.reason === 'extended_off' && <p className="muted" style={{ marginTop: 6 }}>Edit the global configuration in <Link to="/service-configuration/apache-configuration">Apache Configuration</Link>, then reload from <Link to="/restart-services/http-server-apache">Restart Services</Link>.</p>}
            </div>
          </div>
        </div>
      )}
      {enabled && data?.available && (
        <DataTable
          dense columns={columns} rows={rows} rowKey={(w) => w.srv} sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort}
          emptyText={busyOnly ? 'No busy workers right now; untick "Busy only" to list idle and open slots' : 'No worker slots reported'}
          toolbar={<>
            <label className="toggle"><input type="checkbox" checked={busyOnly} onChange={(e) => setBusyOnly(e.target.checked)} /><span className="toggle-track"><span className="toggle-thumb" /></span><span className="toggle-text"><span className="toggle-label">Busy only</span></span></label>
            <input className="input" style={{ maxWidth: 260 }} placeholder="Filter by vhost, client, request…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter workers" />
            <span className="muted">{rows.length} of {data.workers.length} slots</span>
          </>}
        />
      )}
    </Card>
  );
}

function rate(n, unit) {
  if (n == null) return '—';
  return `${n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${unit}`;
}

export default function ApacheStatus({ fn }) {
  const toast = useToast();
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const { data, loading, error, refetch } = useApi('/server-status/apache', { refreshMs: live ? 10_000 : 0 });

  const enable = async () => {
    setBusy(true);
    try {
      const { data: r } = await api.post('/server-status/apache/enable-status');
      toast.success(r.applied?.include?.reloaded ? 'Server status page enabled and Apache reloaded' : 'Server status page enabled');
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const s = data?.status;
  const workers = s ? (s.busyWorkers ?? 0) + (s.idleWorkers ?? 0) : null;
  return (
    <>
      <PageHeader fn={fn} actions={<>
        <label className="toggle" style={{ marginRight: 8 }}><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /><span className="toggle-track"><span className="toggle-thumb" /></span><span className="toggle-text"><span className="toggle-label">Auto-refresh</span></span></label>
        <button className="btn" onClick={() => refetch()}>Refresh</button>
      </>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="stat-grid" style={{ marginBottom: 18 }}>
            <div className="stat"><div className="label">Apache</div><div className="value"><StatusPill status={data.active ? 'active' : 'down'}>{data.active ? 'Running' : 'Down'}</StatusPill></div><small className="muted">{data.version || 'version unknown'}{data.mpm ? ` · MPM ${data.mpm}` : ''}</small></div>
            <div className="stat"><div className="label">Requests / sec</div><div className="value">{s ? rate(s.recent?.requestsPerSecond ?? s.requestsPerSecond, 'req/s') : '—'}</div><small className="muted">{s?.recent ? `last ${s.recent.windowSeconds}s · lifetime ${rate(s.requestsPerSecond, 'req/s')}` : 'lifetime average'}</small></div>
            <div className="stat"><div className="label">Throughput</div><div className="value">{s ? `${formatBytes(s.recent?.bytesPerSecond ?? s.bytesPerSecond)}/s` : '—'}</div><small className="muted">{s?.bytesPerRequest != null ? `${formatBytes(s.bytesPerRequest)} per request` : ''}</small></div>
            <div className="stat"><div className="label">Workers</div><div className="value">{s ? `${s.busyWorkers ?? 0} busy / ${s.idleWorkers ?? 0} idle` : '—'}</div>{s && <div className={`meter ${workers && s.busyWorkers / workers > 0.9 ? 'bad' : workers && s.busyWorkers / workers > 0.75 ? 'warn' : ''}`}><span style={{ width: `${workers ? (s.busyWorkers / workers) * 100 : 0}%` }} /></div>}</div>
            <div className="stat"><div className="label">Server uptime</div><div className="value">{s ? formatDuration(s.uptimeSeconds) : '—'}</div><small className="muted">{s?.totalAccesses != null ? `${s.totalAccesses.toLocaleString()} requests · ${formatBytes((s.totalKBytes || 0) * 1024)} served` : ''}</small></div>
          </div>

          {data.reason && data.instructions && (
            <div className="banner banner-warning">
              <div>
                <strong>{data.instructions.title}</strong>
                <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>{data.instructions.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
                {data.reason === 'apache_down' && <p className="muted" style={{ marginTop: 6 }}><Link to="/server-status/service-status">Service Status</Link> · <Link to="/restart-services/http-server-apache">Restart Apache</Link></p>}
                {data.reason === 'module_missing' && <p className="muted" style={{ marginTop: 6 }}>Modules are loaded by the distribution's Apache packages; after enabling, reload from <Link to="/restart-services/http-server-apache">Restart Services</Link>.</p>}
                {data.reason === 'unreachable' && data.configuredInPanel !== false && <p className="muted" style={{ marginTop: 6 }}>The <Link to="/service-configuration/apache-configuration">Apache Configuration</Link> include already renders the Location block; make sure the include is enabled and Apache was reloaded after the last save.</p>}
              </div>
              {data.canEnableFromPanel && <Button variant="primary" size="sm" loading={busy} onClick={enable}>Enable in Apache Configuration</Button>}
            </div>
          )}

          <WorkerTable enabled={Boolean(data.scoreboard)} refreshMs={live ? 10_000 : 0} reason={data.reason} />

          <div className="home">
            <div>
              <Card title="Worker scoreboard" subtitle={data.scoreboard ? `${data.scoreboard.used} of ${data.scoreboard.total} slots in use` : 'Scoreboard is available while mod_status answers'} padded={Boolean(data.scoreboard)}>
                {data.scoreboard ? <Scoreboard scoreboard={data.scoreboard} /> : <div className="card-body muted">No scoreboard: {data.reason === 'module_missing' ? 'mod_status is not loaded.' : data.reason === 'apache_down' ? 'Apache is not running.' : 'the /server-status page did not answer.'}</div>}
              </Card>
              {s && Object.keys(s.counters || {}).length > 0 && (
                <Card title="mod_status counters" subtitle={s.extended ? 'ExtendedStatus On' : 'ExtendedStatus is Off: enable it for per-request CPU and duration counters'} padded={false}>
                  <div className="table-wrap">
                    <table className="dense">
                      <thead><tr><th>Counter</th><th className="align-right">Value</th></tr></thead>
                      <tbody>{Object.entries(s.counters).map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td className="align-right">{String(v)}</td></tr>)}</tbody>
                    </table>
                  </div>
                </Card>
              )}
            </div>
            <div>
              <Card title="Server">
                <KeyValue items={[
                  ['Version', data.version], ['Built', data.built], ['MPM', data.mpm], ['Flavor', data.flavor === 'debian' ? 'Debian / Ubuntu (apache2)' : data.flavor === 'rhel' ? 'RHEL family (httpd)' : data.flavor],
                  ['Unit', data.unit?.unit ? <code>{data.unit.unit}</code> : null], ['Unit state', data.unit ? `${data.unit.state || 'unknown'}${data.unit.subState ? ` (${data.unit.subState})` : ''}` : null], ['Main PID', data.unit?.pid],
                  ['Loaded modules', data.modules], ['mod_status', <StatusPill status={data.modStatus ? 'enabled' : 'disabled'}>{data.modStatus ? 'loaded' : 'not loaded'}</StatusPill>],
                  ['Status probe', <code>{`${data.probe.host}:${data.probe.port}/server-status`}</code>], ['Managed vhosts', data.managedVhosts],
                  s && ['CPU load (Apache)', s.cpuLoad != null ? `${s.cpuLoad}%` : null], s && ['System load', s.load?.some((n) => n != null) ? s.load.map((n) => (n == null ? '—' : n.toFixed(2))).join(' / ') : null],
                  ['Checked', formatDate(data.checkedAt)],
                ]} />
              </Card>
              <Card title="About this page">
                <p className="muted" style={{ margin: 0 }}>Counters come from Apache's <code>mod_status</code> handler (<code>/server-status?auto</code>), fetched by the agent on the loopback address Apache listens on; the worker table is read from the HTML report (<code>/server-status</code>), which Apache only renders with <code>ExtendedStatus On</code>. "Requests / sec" over the last window is derived between two polls; the lifetime value is Apache's own average since its last restart.</p>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}
