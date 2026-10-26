import { useState } from 'react';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, formatBytes } from '../../../components/Common.jsx';
import { Button } from '../../../components/Form.jsx';
import { RequestError, WindowSelect, StatGrid, LogNote } from '../../email/Shared.jsx';

function Bar({ value, max, tone }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return <div className="progress-bar" style={{ minWidth: 120 }}><span className={tone ? `bg-${tone}` : ''} style={{ width: `${pct}%` }} /></div>;
}

export default function ViewMailStatisticsSummary({ fn }) {
  const [hours, setHours] = useState('24');
  const { data, loading, error, refetch } = useApi(`/email/stats/summary?hours=${hours}`, { refreshMs: 60_000 });
  const t = data?.totals;
  const maxHour = Math.max(1, ...(data?.byHour || []).map((h) => h.received + h.delivered));
  return (
    <>
      <PageHeader fn={fn} description="Mail volume on this server from the Exim main log: messages received, deliveries, failures, deferrals and SMTP-time rejections, by hour and by destination domain." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <Card><div className="form-grid"><WindowSelect value={hours} onChange={setHours} /></div></Card>
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <p className="muted">Scanning the log…</p>}
      {t && (
        <>
          <StatGrid stats={[['Received', t.received], ['Delivered', t.delivered], ['Failed', t.failed, t.failed ? 'bad' : null], ['Deferred', t.deferred, t.deferred ? 'warn' : null], ['Rejected at SMTP', t.rejected, t.rejected ? 'warn' : null], ['Volume', formatBytes(t.bytes)], ['Authenticated', t.authenticated], ['Relaying users', data.relayers]]} />
          <LogNote meta={data} />
          <Card title="Volume by hour" padded={false}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Hour</th><th>Received</th><th>Delivered</th><th>Failed</th><th>Deferred</th><th style={{ width: '40%' }} /></tr></thead>
                <tbody>
                  {data.byHour.length === 0 && <tr><td colSpan={6} className="table-state">No mail in this window.</td></tr>}
                  {data.byHour.map((h) => <tr key={h.hour}><td><code>{h.hour}:00</code></td><td>{h.received}</td><td>{h.delivered}</td><td className={h.failed ? 'text-bad' : ''}>{h.failed}</td><td>{h.deferred}</td><td><Bar value={h.received + h.delivered} max={maxHour} /></td></tr>)}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="form-grid">
            <Card title="Top destination domains" padded={false}>
              <div className="table-wrap"><table><thead><tr><th>Domain</th><th>Delivered</th><th>Failed</th><th>Deferred</th></tr></thead><tbody>
                {data.topDomains.length === 0 && <tr><td colSpan={4} className="table-state">—</td></tr>}
                {data.topDomains.map((d) => <tr key={d.domain}><td><code>{d.domain}</code></td><td>{d.delivered}</td><td className={d.failed ? 'text-bad' : ''}>{d.failed}</td><td>{d.deferred}</td></tr>)}
              </tbody></table></div>
            </Card>
            <Card title="Top senders" padded={false}>
              <div className="table-wrap"><table><thead><tr><th>Sender</th><th>Messages</th><th>Recipients</th><th>Volume</th></tr></thead><tbody>
                {data.topSenders.length === 0 && <tr><td colSpan={4} className="table-state">—</td></tr>}
                {data.topSenders.map((s) => <tr key={s.sender}><td><code>{s.sender}</code></td><td>{s.messages}</td><td>{s.recipients}</td><td>{formatBytes(s.bytes)}</td></tr>)}
              </tbody></table></div>
            </Card>
          </div>
          <Card title="Top connecting hosts">
            {data.topHosts.length ? <KeyValue items={data.topHosts.slice(0, 15).map((h) => [h.host, `${h.messages} message(s)`])} /> : <p className="muted">No remote connections logged in this window.</p>}
          </Card>
        </>
      )}
    </>
  );
}
