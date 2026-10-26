import { useNavigate } from 'react-router-dom';
import { queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { DataTable, useTableState } from '../../components/DataTable.jsx';
import { StatusPill, formatDate } from '../../components/Common.jsx';

// Shared by List Parked Domains and List Subdomains: one account_domains query
// filtered by type, with the owning account, its owner and the parent domain.
export function DomainsTable({ type, emptyText, parentLabel = 'Parent domain', toolbar }) {
  const navigate = useNavigate();
  const t = useTableState({ sort: 'domain' });
  const { data, meta, loading, error } = useApi(`/account-info/domains${queryString({ ...t.state, type })}`);

  const columns = [
    { key: 'domain', label: 'Domain', sortable: true, render: (r) => <a href={`http://${r.domain}`} target="_blank" rel="noreferrer">{r.domain}</a> },
    type === 'parked' ? { key: 'type', label: 'Kind', sortable: true, render: (r) => <StatusPill status="info">{r.type === 'alias' ? 'Alias' : 'Parked'}</StatusPill> } : null,
    { key: 'parent', label: parentLabel, render: (r) => r.parent },
    { key: 'username', label: 'Account', sortable: true, render: (r) => <code>{r.username}</code> },
    { key: 'account_domain', label: 'Main domain', sortable: true },
    { key: 'owner', label: 'Owner', sortable: true },
    { key: 'docroot', label: 'Document root', render: (r) => r.docroot ? <code className="small">{r.docroot}</code> : <span className="muted">—</span> },
    { key: 'created_at', label: 'Created', sortable: true, render: (r) => formatDate(r.created_at) },
    { key: 'suspended', label: 'Status', render: (r) => <StatusPill status={r.suspended ? 'suspended' : 'active'}>{r.suspended ? 'Suspended' : 'Active'}</StatusPill> },
  ].filter(Boolean);

  const rowActions = (r) => [
    { label: 'DNS zone', primary: true, onClick: () => navigate(`/dns-functions/dns-zone-manager?domain=${encodeURIComponent(r.parent === r.domain ? r.domain : r.domain)}`) },
    { label: 'Modify account', onClick: () => navigate(`/account-functions/modify-an-account?username=${r.username}`) },
    { label: 'Bandwidth', onClick: () => navigate(`/account-information/view-bandwidth-usage?username=${r.username}`) },
  ];

  return (
    <DataTable
      columns={columns} rows={data || []} loading={loading} error={error} rowKey={(r) => r.id}
      total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
      sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
      searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search domain, account or owner…"
      rowActions={rowActions} toolbar={toolbar} emptyText={emptyText}
    />
  );
}
