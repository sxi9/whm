import { useState } from 'react';
import { useApi } from '../hooks/useApi.js';
import { queryString } from '../api/client.js';
import { PageHeader, Card, StatusPill, formatDate } from '../components/Common.jsx';
import { DataTable, useTableState } from '../components/DataTable.jsx';
import { Modal } from '../components/Modal.jsx';

export function AuditLogPage() {
  const t = useTableState({ pageSize: 50, sort: 'ts', dir: 'desc' });
  const { data, meta, loading, error } = useApi(`/system/audit${queryString(t.state)}`);
  const [open, setOpen] = useState(null);
  return (
    <>
      <PageHeader title="Audit log" description="Every privileged action performed through the panel, with who did it and from where. Secrets are redacted before storage." />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'ts', label: 'Time', sortable: true, width: 170, render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{formatDate(r.ts)}</span> },
            { key: 'principal', label: 'User', sortable: true, width: 120 },
            { key: 'role', label: 'Role', width: 80 },
            { key: 'ip', label: 'IP', width: 120 },
            { key: 'action', label: 'Action', sortable: true, width: 180, render: (r) => <code>{r.action}</code> },
            { key: 'target', label: 'Target', width: 150 },
            { key: 'result', label: 'Result', width: 90, render: (r) => <StatusPill status={r.result === 'ok' ? 'ok' : 'error'}>{r.result}</StatusPill> },
          ]}
          rowActions={(r) => (r.args_redacted ? [{ label: 'Details', primary: true, onClick: () => setOpen(r) }] : [])}
          rows={data || []} loading={loading} error={error} rowKey={(r) => r.id}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search action, target, user or IP…" emptyText="Privileged actions appear here as they happen." dense
        />
      </Card>
      <Modal open={Boolean(open)} title={open ? `${open.action} · ${formatDate(open.ts)}` : ''} onClose={() => setOpen(null)} size="lg">
        {open && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>{open.principal} ({open.role}) from {open.ip}{open.target ? ` · target ${open.target}` : ''} · {open.result}</p>
            <pre className="log">{open.args_redacted}</pre>
          </>
        )}
      </Modal>
    </>
  );
}
