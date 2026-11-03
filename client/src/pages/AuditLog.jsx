import { useApi } from '../hooks/useApi.js';
import { queryString } from '../api/client.js';
import { PageHeader, Card, StatusPill, formatDate } from '../components/Common.jsx';
import { DataTable, useTableState } from '../components/DataTable.jsx';

export function AuditLogPage() {
  const t = useTableState({ pageSize: 50, sort: 'ts', dir: 'desc' });
  const { data, meta, loading, error } = useApi(`/system/audit${queryString(t.state)}`);
  return (
    <>
      <PageHeader title="Audit log" description="Every privileged action performed through the panel, with who did it and from where. Secrets are redacted before storage." />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'ts', label: 'Time', sortable: true, width: 170, render: (r) => formatDate(r.ts) },
            { key: 'principal', label: 'User', sortable: true, width: 120 },
            { key: 'role', label: 'Role', width: 80 },
            { key: 'ip', label: 'IP', width: 120 },
            { key: 'action', label: 'Action', sortable: true, render: (r) => <code>{r.action}</code> },
            { key: 'target', label: 'Target', width: 150 },
            { key: 'result', label: 'Result', width: 90, render: (r) => <StatusPill status={r.result === 'ok' ? 'ok' : 'error'}>{r.result}</StatusPill> },
            { key: 'args_redacted', label: 'Details', width: 260, render: (r) => r.args_redacted ? <code className="small" title={r.args_redacted}>{r.args_redacted.length > 160 ? `${r.args_redacted.slice(0, 160)}…` : r.args_redacted}</code> : null },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(r) => r.id}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search action, target, user or IP…" emptyText="Privileged actions appear here as they happen." dense
        />
      </Card>
    </>
  );
}
