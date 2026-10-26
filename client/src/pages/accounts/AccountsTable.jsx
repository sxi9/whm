import { useNavigate } from 'react-router-dom';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { DataTable, useTableState } from '../../components/DataTable.jsx';
import { StatusPill, formatMb, formatDate } from '../../components/Common.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

export function AccountsTable({ suspendedOnly = false, toolbar }) {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const t = useTableState({ sort: 'username' });
  const query = { ...t.state, suspended: suspendedOnly ? 'true' : undefined };
  const { data, meta, loading, error, refetch } = useApi(`/accounts${queryString(query)}`);

  const act = async (label, fn) => {
    try { await fn(); toast.success(label); refetch(); } catch (err) { toast.error(err); }
  };

  const columns = [
    { key: 'domain', label: 'Domain', sortable: true, render: (r) => <a href={`http://${r.domain}`} target="_blank" rel="noreferrer">{r.domain}</a> },
    { key: 'username', label: 'User', sortable: true, render: (r) => <code>{r.username}</code> },
    { key: 'owner', label: 'Owner', sortable: true },
    { key: 'package', label: 'Package', sortable: true, render: (r) => r.package_name },
    { key: 'ip', label: 'IP' },
    { key: 'disk_used_mb', label: 'Disk', sortable: true, align: 'right', render: (r) => `${formatMb(r.disk_used_mb)} / ${formatMb(r.disk_quota_mb)}` },
    { key: 'contact_email', label: 'Contact' },
    { key: 'created_at', label: 'Created', sortable: true, render: (r) => formatDate(r.created_at) },
    { key: 'suspended', label: 'Status', sortable: true, render: (r) => <StatusPill status={r.suspended ? 'suspended' : 'active'}>{r.suspended ? 'Suspended' : 'Active'}</StatusPill> },
  ];

  const rowActions = (r) => [
    { label: 'Modify', primary: true, onClick: () => navigate(`/account-functions/modify-an-account?username=${r.username}`) },
    r.suspended
      ? { label: 'Unsuspend', onClick: () => act(`Unsuspended ${r.username}`, () => api.post(`/accounts/${r.username}/unsuspend`)) }
      : { label: 'Suspend', onClick: async () => { if (await confirm({ title: `Suspend ${r.username}?`, message: 'The account\'s login is locked. Websites and mail are disabled until unsuspended.', confirmLabel: 'Suspend', danger: true })) act(`Suspended ${r.username}`, () => api.post(`/accounts/${r.username}/suspend`, { reason: 'Suspended from List Accounts' })); } },
    { label: 'Change password', onClick: () => navigate(`/account-functions/password-modification?username=${r.username}`) },
    { label: 'Upgrade/Downgrade', onClick: () => navigate(`/account-functions/upgrade-downgrade-an-account?username=${r.username}`) },
    { label: 'Bandwidth usage', onClick: () => navigate(`/account-information/view-bandwidth-usage?username=${r.username}`) },
    { label: 'Enhancements', onClick: () => navigate(`/account-information/manage-account-enhancements?username=${r.username}`) },
    { label: 'Terminate', danger: true, onClick: async () => { if (await confirm({ title: `Terminate ${r.username}?`, message: `This permanently deletes the Linux user, home directory, databases and DNS for ${r.domain}. This cannot be undone.`, confirmLabel: 'Terminate', danger: true, typeToConfirm: r.username })) act(`Terminated ${r.username}`, () => api.delete(`/accounts/${r.username}`)); } },
  ];

  return (
    <DataTable
      columns={columns} rows={data || []} loading={loading} error={error} rowKey={(r) => r.username}
      total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
      sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
      searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search user, domain, owner or email…"
      rowActions={rowActions} toolbar={toolbar}
      emptyText={suspendedOnly ? 'No suspended accounts.' : 'No accounts yet. Create one to get started.'}
    />
  );
}
