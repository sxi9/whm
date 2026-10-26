import { useState } from 'react';
import { queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Button } from '../../../components/Form.jsx';
import { RequestError, WindowSelect, StatGrid, LogNote } from '../../email/Shared.jsx';

export default function ViewRelayers({ fn }) {
  const table = useTableState({ pageSize: 50 });
  const [hours, setHours] = useState('24');
  const path = `/email/stats/relayers${queryString({ ...table.state, hours })}`;
  const { data, meta, loading, error, refetch } = useApi(path);
  const t = meta?.totals;
  return (
    <>
      <PageHeader fn={fn} description="Who relayed mail through this server after authenticating (SMTP AUTH) or from a local process. A single user with thousands of recipients usually means a compromised mailbox or script." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {t && <StatGrid stats={[['Relayers', meta.total], ['Authenticated messages', t.authenticated], ['All messages', t.received], ['Failed deliveries', t.failed, t.failed ? 'bad' : null]]} />}
      <LogNote meta={meta} />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'user', label: 'Authenticated as', sortable: true, render: (r) => <><code>{r.user}</code>{r.mechanism && <div className="muted">{r.mechanism}</div>}</> },
            { key: 'messages', label: 'Messages', sortable: true, align: 'right' },
            { key: 'recipients', label: 'Recipients', sortable: true, align: 'right', render: (r) => <span className={r.recipients > 500 ? 'text-bad' : ''}>{r.recipients}</span> },
            { key: 'failed', label: 'Failed', sortable: true, align: 'right' },
            { key: 'bytes', label: 'Volume', sortable: true, align: 'right', render: (r) => formatBytes(r.bytes) },
            { key: 'firstSeen', label: 'First seen', render: (r) => formatDate(r.firstSeen) },
            { key: 'last_seen', label: 'Last seen', sortable: true, render: (r) => formatDate(r.lastSeen) },
            { key: 'hosts', label: 'Client hosts', render: (r) => <>{r.hosts.slice(0, 4).map((h) => <div key={h}><code>{h}</code></div>)}{r.hosts.length > 4 && <div className="muted">+{r.hosts.length - 4} more</div>}</> },
            { key: 'senders', label: 'Envelope senders', render: (r) => r.senders.slice(0, 3).map((s) => <div key={s}><code>{s}</code></div>) },
          ]}
          rows={data || []} loading={loading} total={meta?.total ?? null} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
          sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort} rowKey={(r) => r.user} dense emptyText="Nobody relayed mail in this window."
          searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder="Filter by user or sender"
          toolbar={<WindowSelect value={hours} onChange={(v) => { setHours(v); table.setPage(1); }} />}
        />
      </Card>
    </>
  );
}
