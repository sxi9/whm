import { useEffect, useState } from 'react';
import { queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable, useTableState } from '../../components/DataTable.jsx';
import { Select } from '../../components/Form.jsx';

const KIND_LABEL = { 'peer.test': 'Connectivity test', 'dns.receive': 'Zone received', 'config.push': 'Settings pushed', 'config.pull': 'Settings pulled', 'config.receive': 'Settings received', 'config.export': 'Settings served' };

// Every exchange with a peer, newest first. `kinds` narrows the kind filter to the page's own area.
export function ExchangeLog({ kinds, version = 0 }) {
  const table = useTableState({ pageSize: 20 });
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const { page, pageSize, q } = table.state;
  const path = `/clusters/events${queryString({ page, pageSize, q, kind, status })}`;
  const { data, meta, loading, error, refetch } = useApi(path);
  useEffect(() => { if (version) refetch(true); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = data || [];

  return (
    <Card title="Exchange log" subtitle="What was sent to and received from peers." padded={false}>
      <DataTable dense rows={rows} loading={loading} error={error} rowKey={(e) => e.id} total={meta?.total ?? null} page={page} pageSize={pageSize} onPageChange={table.setPage}
        searchable q={q} onSearch={table.setSearch} searchPlaceholder="Search messages or peers"
        toolbar={(
          <>
            <Select value={kind} onChange={(v) => { setKind(v); table.setPage(1); }} placeholder="All kinds" options={(kinds || Object.keys(KIND_LABEL)).map((k) => ({ value: k, label: KIND_LABEL[k] || k }))} />
            <Select value={status} onChange={(v) => { setStatus(v); table.setPage(1); }} placeholder="Any outcome" options={[{ value: 'ok', label: 'OK' }, { value: 'failed', label: 'Failed' }]} />
          </>
        )}
        emptyText="Nothing exchanged yet."
        columns={[
          { key: 'ts', label: 'When', width: 160, render: (e) => formatDate(e.ts) },
          { key: 'kind', label: 'Kind', render: (e) => <>{KIND_LABEL[e.kind] || e.kind} <small className="muted">{e.direction === 'in' ? '← in' : '→ out'}</small></> },
          { key: 'peer', label: 'Peer / source', render: (e) => e.peer || e.source || <span className="muted">—</span> },
          { key: 'status', label: 'Outcome', render: (e) => <StatusPill status={e.status === 'ok' ? 'ok' : e.status === 'skipped' ? 'warning' : 'failed'}>{e.status}</StatusPill> },
          { key: 'message', label: 'Details', render: (e) => <span style={{ wordBreak: 'break-word' }}>{e.message || '—'}{e.details?.applied?.length ? <><br /><small className="muted">{e.details.applied.join(', ')}</small></> : null}</span> },
        ]}
      />
    </Card>
  );
}
