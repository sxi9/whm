import { useState } from 'react';
import { queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, Select, Button } from '../../../components/Form.jsx';
import { RequestError, WindowSelect, StatGrid, LogNote } from '../../email/Shared.jsx';

export default function ViewSentSummary({ fn }) {
  const table = useTableState({ pageSize: 50 });
  const [hours, setHours] = useState('24');
  const [auth, setAuth] = useState('');
  const path = `/email/stats/sent${queryString({ ...table.state, hours, authenticated: auth || undefined })}`;
  const { data, meta, loading, error, refetch } = useApi(path);
  const t = meta?.totals;
  return (
    <>
      <PageHeader fn={fn} description="Outbound mail grouped by sender: authenticated SMTP users, local scripts (user@host) and envelope senders, with how many of their messages were delivered, deferred or bounced." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {t && <StatGrid stats={[['Messages', t.received], ['Delivered', t.delivered], ['Failed', t.failed, t.failed ? 'bad' : null], ['Deferred', t.deferred, t.deferred ? 'warn' : null], ['Volume', formatBytes(t.bytes)], ['Authenticated', t.authenticated]]} />}
      <LogNote meta={meta} />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'sender', label: 'Sender', sortable: true, render: (r) => <><code>{r.sender}</code> {r.authenticated && <StatusPill status="ok">authenticated</StatusPill>}</> },
            { key: 'messages', label: 'Messages', sortable: true, align: 'right' },
            { key: 'recipients', label: 'Recipients', sortable: true, align: 'right' },
            { key: 'delivered', label: 'Delivered', sortable: true, align: 'right' },
            { key: 'failed', label: 'Failed', sortable: true, align: 'right', render: (r) => <span className={r.failed ? 'text-bad' : ''}>{r.failed}</span> },
            { key: 'deferred', label: 'Deferred', align: 'right' },
            { key: 'bytes', label: 'Volume', sortable: true, align: 'right', render: (r) => formatBytes(r.bytes) },
            { key: 'last_seen', label: 'Last message', sortable: true, render: (r) => formatDate(r.lastSeen) },
            { key: 'hosts', label: 'From hosts', render: (r) => r.hosts.slice(0, 3).map((h) => <div key={h}><code>{h}</code></div>) },
          ]}
          rows={data || []} loading={loading} total={meta?.total ?? null} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
          sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort} rowKey={(r) => r.sender} dense emptyText="No outbound mail in this window."
          searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder="Filter senders"
          toolbar={<><Field inline><Select value={auth} onChange={(v) => { setAuth(v); table.setPage(1); }} options={[{ value: 'true', label: 'Authenticated only' }, { value: 'false', label: 'Unauthenticated only' }]} placeholder="All senders" /></Field><WindowSelect value={hours} onChange={(v) => { setHours(v); table.setPage(1); }} /></>}
        />
      </Card>
    </>
  );
}
