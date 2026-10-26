import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, StatusPill, Loading, formatBytes, formatDuration, formatDate } from '../../components/Common.jsx';
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
                <p className="muted" style={{ margin: 0 }}>Counters come from Apache's <code>mod_status</code> handler (<code>/server-status?auto</code>), fetched by the agent on the loopback address Apache listens on. "Requests / sec" over the last window is derived between two polls; the lifetime value is Apache's own average since its last restart.</p>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}
