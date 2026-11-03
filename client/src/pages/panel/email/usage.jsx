import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, StatusPill, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { PanelPage } from '../../../panel/PanelPage.jsx';
import { usePanelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, quotaText } from './parts/Shared.jsx';

export const WINDOWS = [{ value: '1', label: 'Last hour' }, { value: '6', label: 'Last 6 hours' }, { value: '24', label: 'Last 24 hours' }, { value: '72', label: 'Last 3 days' }, { value: '168', label: 'Last 7 days' }];

const STATUS = { delivered: 'ok', completed: 'ok', failed: 'failed', rejected: 'failed', deferred: 'warning', queued: 'pending' };

export function DeliveryPill({ status }) {
  return <StatusPill status={STATUS[status] || 'unknown'}>{status}</StatusPill>;
}

export function Totals({ totals, storage }) {
  const tiles = [
    ['Messages', totals.messages], ['Sent', totals.sent], ['Received', totals.received], ['Delivered', totals.delivered],
    ['Failed', totals.failed, totals.failed ? 'bad' : null], ['Deferred', totals.deferred, totals.deferred ? 'warn' : null], ['Queued', totals.queued, totals.queued ? 'warn' : null],
  ];
  return (
    <div className="stat-grid" style={{ marginBottom: 18 }}>
      {tiles.map(([label, value, tone]) => (
        <div className="stat" key={label}><div className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{tone && <span className={`dot dot-${tone}`} />}{label}</div><div className="value">{value ?? 0}</div></div>
      ))}
      {storage && (
        <div className="stat"><div className="label">Mailboxes</div><div className="value">{storage.limit != null && storage.limit > 0 ? `${storage.mailboxes} of ${storage.limit}` : storage.mailboxes}</div><div className="muted" style={{ fontSize: 12.5 }}>{storage.quotaMb ? `${quotaText(storage.quotaMb)} allotted` : 'No quotas set'}</div></div>
      )}
    </div>
  );
}

export function LogNote({ log, hours }) {
  if (!log) return null;
  if (log.exists === false) return <p className="muted">The mail server has not logged anything yet.</p>;
  if (log.truncated) return <p className="muted">Only the most recent part of the mail log was scanned for the last {hours} h.</p>;
  if (log.from) return <p className="muted">Log entries start {formatDate(log.from)}; earlier mail is in rotated logs and not counted.</p>;
  return null;
}

export default function MailUsage({ fn }) {
  const [hours, setHours] = useState('24');
  const { data, error, loading, refetch } = usePanelApi(`/email/usage?sinceHours=${hours}`);
  const windowSelect = <select className="input select" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Time window">{WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}</select>;
  return (
    <PanelPage fn={fn} actions={windowSelect}>
      {error && <Card><PanelRequestError error={error} fn={fn} onRetry={refetch} /></Card>}
      {loading && !data && !error && <Card><p className="muted">Reading the mail log…</p></Card>}
      {data && (
        <>
          <Totals totals={data.totals} storage={data.storage} />
          <LogNote log={data.log} hours={data.hours} />
          <div className="grid-2">
            <Card title="Per mailbox" subtitle="Messages sent from and received by each mailbox." padded={false}>
              <DataTable dense columns={[
                { key: 'address', label: 'Mailbox', render: (r) => <code>{r.address}</code> },
                { key: 'sent', label: 'Sent', align: 'right' },
                { key: 'received', label: 'Received', align: 'right' },
                { key: 'failed', label: 'Failed', align: 'right', render: (r) => (r.failed ? <span className="field-message" style={{ marginTop: 0 }}>{r.failed}</span> : 0) },
              ]} rows={data.mailboxes} rowKey={(r) => r.address} emptyText="No mailboxes yet. Create one under Email accounts and its traffic is counted here." />
            </Card>
            <Card title="Per domain" subtitle="Traffic the mail server saw for each of your domains." padded={false}>
              <DataTable dense columns={[
                { key: 'domain', label: 'Domain', render: (r) => <code>{r.domain}</code> },
                { key: 'delivered', label: 'Delivered', align: 'right', render: (r) => r.delivered ?? 0 },
                { key: 'deferred', label: 'Deferred', align: 'right', render: (r) => r.deferred ?? 0 },
                { key: 'failed', label: 'Failed', align: 'right', render: (r) => (r.failed ? <span className="field-message" style={{ marginTop: 0 }}>{r.failed}</span> : 0) },
              ]} rows={data.byDomain || []} rowKey={(r) => r.domain} emptyText="Nothing was sent or received for your domains in this window." />
            </Card>
          </div>
          <Card title="Recent messages" subtitle="The latest entries of the mail log for your domains and mailboxes." padded={false}>
            <DataTable dense columns={[
              { key: 'arrivedAt', label: 'Time', render: (r) => <span className="muted">{formatDate(r.arrivedAt)}</span> },
              { key: 'sender', label: 'From', render: (r) => <code>{r.sender || '<>'}</code> },
              { key: 'recipient', label: 'To', render: (r) => <code>{r.recipient}</code> },
              { key: 'subject', label: 'Subject', render: (r) => r.subject || <span className="muted">—</span> },
              { key: 'size', label: 'Size', align: 'right', render: (r) => (r.size != null ? formatBytes(r.size) : '—') },
              { key: 'status', label: 'Status', render: (r) => <><DeliveryPill status={r.status} />{r.detail && <div className="muted" style={{ fontSize: 12 }}>{r.detail}</div>}</> },
            ]} rows={data.recent || []} rowKey={(r) => r.id} emptyText="No messages in this window. Sent and received mail shows up here as the mail server logs it." />
          </Card>
        </>
      )}
      <p className="muted">Storage per mailbox is shown under <Link to="/panel/email/accounts">Email accounts</Link>.</p>
    </PanelPage>
  );
}
