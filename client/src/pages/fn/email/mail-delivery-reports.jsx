import { useState } from 'react';
import { queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Button, FormActions } from '../../../components/Form.jsx';
import { RequestError, WindowSelect, StatGrid, LogNote, DeliveryStatusPill } from '../../email/Shared.jsx';

export default function MailDeliveryReports({ fn }) {
  const table = useTableState({ pageSize: 50 });
  const [form, setForm] = useState({ sender: '', recipient: '', status: '', hours: '24' });
  const [filter, setFilter] = useState(null);
  const path = filter ? `/email/reports${queryString({ ...table.state, ...filter })}` : null;
  const { data, meta, loading, error, refetch } = useApi(path, { enabled: Boolean(filter) });
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const search = (e) => { e?.preventDefault?.(); table.setPage(1); setFilter({ sender: form.sender.trim() || undefined, recipient: form.recipient.trim() || undefined, status: form.status || undefined, hours: form.hours }); };

  return (
    <>
      <PageHeader fn={fn} description="Traces each message through the Exim main log: who sent it, which recipients were delivered, deferred or failed, and the remote server's answer." />
      <Card title="Search">
        <form onSubmit={search}>
          <div className="form-grid">
            <Field label="Sender" help="Envelope sender or authenticated user (substring)"><TextInput value={form.sender} onChange={set('sender')} placeholder="alice@example.com" /></Field>
            <Field label="Recipient" help="Substring"><TextInput value={form.recipient} onChange={set('recipient')} placeholder="bob@example.org" /></Field>
            <Field label="Outcome"><Select value={form.status} onChange={set('status')} options={['delivered', 'failed', 'deferred', 'queued', 'completed']} placeholder="Any outcome" /></Field>
            <WindowSelect value={form.hours} onChange={set('hours')} />
          </div>
          <FormActions><Button type="submit" variant="primary" loading={loading}>Search</Button>{filter && <Button onClick={() => refetch()}>Refresh</Button>}</FormActions>
        </form>
      </Card>
      <RequestError error={error} onRetry={refetch} />
      {meta && <StatGrid stats={[['Messages in window', meta.messages], ['Delivery lines', meta.total], ['SMTP rejects', meta.rejects, meta.rejects ? 'warn' : null]]} />}
      <LogNote meta={meta} />
      {filter && (
        <Card padded={false}>
          <DataTable
            columns={[
              { key: 'arrived_at', label: 'Received', sortable: true, render: (r) => formatDate(r.arrivedAt) },
              { key: 'sender', label: 'Sender', sortable: true, render: (r) => <><code>{r.sender}</code>{r.authUser && <div className="muted">auth: {r.authUser}</div>}</> },
              { key: 'recipient', label: 'Recipient', sortable: true, render: (r) => <code>{r.recipient || '—'}</code> },
              { key: 'status', label: 'Outcome', sortable: true, render: (r) => <DeliveryStatusPill status={r.status} /> },
              { key: 'detail', label: 'Detail', render: (r) => <><div>{r.detail}</div>{r.remoteHost && <div className="muted">{r.transport} → {r.remoteHost}</div>}</> },
              { key: 'size', label: 'Size', sortable: true, render: (r) => formatBytes(r.size) },
              { key: 'id', label: 'Message id', render: (r) => <code>{r.id}</code> },
            ]}
            rows={data || []} loading={loading} total={meta?.total ?? null} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
            sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort} rowKey={(r) => r.key} dense emptyText="No deliveries match in this window."
          />
        </Card>
      )}
    </>
  );
}
