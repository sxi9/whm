import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, Loading, formatBytes, formatDuration } from '../../components/Common.jsx';
import { ErrorBanner } from '../../components/Form.jsx';

function Meter({ used, total }) {
  const pct = total ? Math.round((used / total) * 100) : 0;
  return <div className={`meter ${pct > 90 ? 'bad' : pct > 75 ? 'warn' : ''}`}><span style={{ width: `${pct}%` }} /></div>;
}

export default function ServerInformation({ fn }) {
  const { data, loading, error, refetch } = useApi('/system/info', { refreshMs: 20_000 });
  if (loading && !data) return <><PageHeader fn={fn} /><Loading /></>;
  if (error) return <><PageHeader fn={fn} /><ErrorBanner error={error} onRetry={refetch} /></>;
  const { memory: m } = data;
  return (
    <>
      <PageHeader fn={fn} actions={<button className="btn" onClick={() => refetch()}>Refresh</button>} />
      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <div className="stat"><div className="label">Load average (1 / 5 / 15 min)</div><div className="value">{data.loadAverage.map((n) => n.toFixed(2)).join(' / ')}</div></div>
        <div className="stat"><div className="label">Uptime</div><div className="value">{formatDuration(data.uptimeSeconds)}</div></div>
        <div className="stat"><div className="label">Memory in use</div><div className="value">{formatBytes(m.totalBytes - m.availableBytes)}</div><Meter used={m.totalBytes - m.availableBytes} total={m.totalBytes} /></div>
        <div className="stat"><div className="label">Swap in use</div><div className="value">{formatBytes(m.swapTotalBytes - m.swapFreeBytes)}</div><Meter used={m.swapTotalBytes - m.swapFreeBytes} total={m.swapTotalBytes} /></div>
      </div>
      <div className="home">
        <div>
          <Card title="System">
            <KeyValue items={[['Hostname', data.hostname], ['Operating system', data.os.name], ['Kernel', `${data.os.kernel} (${data.os.arch})`], ['CPU', `${data.cpu.count} × ${data.cpu.model}${data.cpu.speedMHz ? ` @ ${data.cpu.speedMHz} MHz` : ''}`], ['Node.js', data.node], ['Agent', `pid ${data.agentPid}, uid ${data.agentUid}`]]} />
          </Card>
          <Card title="Memory">
            <KeyValue items={[['Total', formatBytes(m.totalBytes)], ['Available', formatBytes(m.availableBytes)], ['Free', formatBytes(m.freeBytes)], ['Buffers', formatBytes(m.buffersBytes)], ['Cached', formatBytes(m.cachedBytes)], ['Swap total', formatBytes(m.swapTotalBytes)], ['Swap free', formatBytes(m.swapFreeBytes)]]} />
          </Card>
        </div>
        <div>
          <Card title="Disks" padded={false}>
            <div className="table-wrap">
              <table className="dense">
                <thead><tr><th>Mount</th><th className="align-right">Size</th><th className="align-right">Used</th><th>Usage</th></tr></thead>
                <tbody>{data.disks.map((d) => <tr key={d.filesystem + d.mountpoint}><td><div>{d.mountpoint}</div><small className="muted">{d.filesystem}</small></td><td className="align-right">{formatBytes(d.sizeBytes)}</td><td className="align-right">{formatBytes(d.usedBytes)}</td><td style={{ minWidth: 90 }}>{d.usedPercent}%<Meter used={d.usedPercent} total={100} /></td></tr>)}</tbody>
              </table>
            </div>
          </Card>
          <Card title="Network interfaces" padded={false}>
            <div className="table-wrap">
              <table className="dense">
                <thead><tr><th>Interface</th><th>Addresses</th></tr></thead>
                <tbody>{data.interfaces.map((i) => <tr key={i.name}><td><code>{i.name}</code></td><td>{i.addresses.length ? i.addresses.map((a) => <div key={a.address}><code>{a.address}</code> <span className="muted">{a.family}</span></div>) : <span className="muted">—</span>}</td></tr>)}</tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
