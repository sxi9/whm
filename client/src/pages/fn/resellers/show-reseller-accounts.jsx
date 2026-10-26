import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, formatMb, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, Select, ErrorBanner } from '../../../components/Form.jsx';
import { ResellerPicker, useReseller, Summary } from '../../resellers/Shared.jsx';

export default function ShowResellerAccounts({ fn }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [picked, setPicked] = useState('');
  const username = user?.role === 'root' ? picked : user?.username;
  const { reseller } = useReseller(username);
  const t = useTableState({ sort: 'username' });
  const [suspended, setSuspended] = useState('');
  const { data, meta, loading, error, refetch } = useApi(username ? `/resellers/${encodeURIComponent(username)}/accounts${queryString({ ...t.state, suspended: suspended || undefined })}` : null, { enabled: Boolean(username) });

  return (
    <>
      <PageHeader fn={fn} description="Every hosting account owned by a reseller, with its package, address and usage." />
      {user?.role === 'root' && <Card title="Reseller"><ResellerPicker value={picked} onChange={setPicked} /></Card>}
      {reseller && <Summary items={[['Accounts', reseller.usage.accounts], ['Suspended', reseller.usage.suspended], ['Disk used', formatMb(reseller.usage.disk_used_mb)], ['Bandwidth used', formatMb(reseller.usage.bandwidth_used_mb)], ['Account limit', reseller.limits.max_accounts ?? 'Unlimited']]} />}
      {username && (
        <Card title={`Accounts owned by ${username}`} padded={false} actions={<Field inline><Select value={suspended} onChange={setSuspended} options={[{ value: 'false', label: 'Active only' }, { value: 'true', label: 'Suspended only' }]} placeholder="All accounts" /></Field>}>
          <ErrorBanner error={error} onRetry={refetch} />
          <DataTable
            columns={[
              { key: 'domain', label: 'Domain', sortable: true, render: (r) => <a href={`http://${r.domain}`} target="_blank" rel="noreferrer">{r.domain}</a> },
              { key: 'username', label: 'User', sortable: true, render: (r) => <code>{r.username}</code> },
              { key: 'package', label: 'Package', sortable: true, render: (r) => r.package_name },
              { key: 'ip', label: 'IP' },
              { key: 'disk_used_mb', label: 'Disk', sortable: true, align: 'right', render: (r) => `${formatMb(r.disk_used_mb)} / ${formatMb(r.disk_quota_mb)}` },
              { key: 'bandwidth_used_mb', label: 'Bandwidth', sortable: true, align: 'right', render: (r) => `${formatMb(r.bandwidth_used_mb)} / ${formatMb(r.bandwidth_limit_mb)}` },
              { key: 'contact_email', label: 'Contact' },
              { key: 'created_at', label: 'Created', sortable: true, render: (r) => formatDate(r.created_at) },
              { key: 'suspended', label: 'Status', sortable: true, render: (r) => <StatusPill status={r.suspended ? 'suspended' : 'active'}>{r.suspended ? 'Suspended' : 'Active'}</StatusPill> },
            ]}
            rows={data || []} loading={loading} rowKey={(r) => r.username} total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
            sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort} searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search user, domain or email…"
            rowActions={(r) => [{ label: 'Modify', primary: true, onClick: () => navigate(`/account-functions/modify-an-account?username=${r.username}`) }, { label: 'Change owner', onClick: () => navigate(`/resellers/change-ownership-of-an-account?username=${r.username}`) }]}
            emptyText={`${username} owns no accounts${suspended ? ' matching this filter' : ''}.`}
          />
        </Card>
      )}
    </>
  );
}
