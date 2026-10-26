import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, KeyValue, formatMb } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { ResellerPicker, ResellerStatusPill, UsageBar, Summary } from '../../resellers/Shared.jsx';

export default function ViewResellerUsageAndManageAccountStatus({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const [picked, setPicked] = useState('');
  const username = isRoot ? picked : user?.username;
  const overview = useApi(isRoot ? '/resellers/usage' : null, { enabled: isRoot });
  const { data, loading, error, refetch } = useApi(username ? `/resellers/${encodeURIComponent(username)}/usage` : null, { enabled: Boolean(username) });
  const [busy, setBusy] = useState(null);

  const act = async (label, fnc, name) => {
    setBusy(name);
    try { await fnc(); toast.success(label); refetch(); overview.refetch?.(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const suspend = async (a) => {
    if (!(await confirm({ title: `Suspend ${a.username}?`, message: `${a.domain} stops serving and its login is locked until unsuspended.`, confirmLabel: 'Suspend', danger: true }))) return;
    act(`Suspended ${a.username}`, () => api.post(`/accounts/${a.username}/suspend`, { reason: `Suspended from reseller usage (${username})` }), a.username);
  };
  const unsuspend = (a) => act(`Unsuspended ${a.username}`, () => api.post(`/accounts/${a.username}/unsuspend`), a.username);

  return (
    <>
      <PageHeader fn={fn} description="Compares each reseller's allocated and consumed resources with its limits, and lets you suspend or unsuspend its accounts in place." />
      {isRoot && (
        <Card title="All resellers" padded={false}>
          <ErrorBanner error={overview.error} onRetry={overview.refetch} />
          <DataTable
            columns={[
              { key: 'username', label: 'Reseller', render: (r) => <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicked(r.username)}><code>{r.username}</code></button> },
              { key: 'accounts', label: 'Accounts', render: (r) => <span style={r.usage.over_accounts ? { color: 'var(--bad)', fontWeight: 600 } : undefined}>{r.usage.accounts}{r.limits.max_accounts != null ? ` / ${r.limits.max_accounts}` : ''}{r.usage.suspended ? <small className="muted"> ({r.usage.suspended} suspended)</small> : null}</span> },
              { key: 'disk', label: 'Disk allocated', render: (r) => r.limits.max_disk_mb != null ? <UsageBar used={r.usage.disk_allocated_mb} max={r.limits.max_disk_mb} /> : `${formatMb(r.usage.disk_allocated_mb)} / unlimited` },
              { key: 'disk_used', label: 'Disk used', align: 'right', render: (r) => formatMb(r.usage.disk_used_mb) },
              { key: 'bw', label: 'Bandwidth allocated', render: (r) => r.limits.max_bandwidth_mb != null ? <UsageBar used={r.usage.bandwidth_allocated_mb} max={r.limits.max_bandwidth_mb} /> : `${formatMb(r.usage.bandwidth_allocated_mb)} / unlimited` },
              { key: 'bw_used', label: 'Bandwidth used', align: 'right', render: (r) => formatMb(r.usage.bandwidth_used_mb) },
              { key: 'status', label: 'Status', render: (r) => <ResellerStatusPill reseller={r} /> },
            ]}
            rows={overview.data || []} loading={overview.loading} rowKey={(r) => r.username} emptyText="No resellers yet."
          />
        </Card>
      )}
      {isRoot && <Card title="Reseller"><ResellerPicker value={picked} onChange={setPicked} /></Card>}
      <ErrorBanner error={error} onRetry={refetch} />
      {data && (
        <>
          <Card title={`${data.reseller}: usage against limits`} actions={isRoot && <Link className="btn btn-sm" to={`/resellers/reseller-center`}>Edit limits</Link>}>
            {data.suspended && <div className="banner banner-warning"><div><strong>Reseller privileges are suspended.</strong> The hosting accounts below still run.</div></div>}
            <Summary items={[['Accounts', `${data.usage.accounts}${data.limits.max_accounts != null ? ` / ${data.limits.max_accounts}` : ''}`], ['Suspended accounts', data.usage.suspended], ['Disk used', formatMb(data.usage.disk_used_mb)], ['Bandwidth used', formatMb(data.usage.bandwidth_used_mb)]]} />
            <KeyValue items={[
              ['Disk allocated', <UsageBar key="d" used={data.usage.disk_allocated_mb} max={data.limits.max_disk_mb} />],
              ['Bandwidth allocated', <UsageBar key="b" used={data.usage.bandwidth_allocated_mb} max={data.limits.max_bandwidth_mb} />],
              ['Overselling', `${data.limits.oversell_disk ? 'disk' : ''}${data.limits.oversell_disk && data.limits.oversell_bandwidth ? ', ' : ''}${data.limits.oversell_bandwidth ? 'bandwidth' : ''}` || 'off'],
              data.usage.unlimited_disk > 0 && ['Accounts with unlimited disk', data.usage.unlimited_disk],
              (data.usage.over_accounts || data.usage.over_disk || data.usage.over_bandwidth) && ['Over limits', [data.usage.over_accounts && 'accounts', data.usage.over_disk && 'disk', data.usage.over_bandwidth && 'bandwidth'].filter(Boolean).join(', ')],
            ]} />
          </Card>
          <Card title="Accounts" padded={false}>
            <DataTable
              columns={[
                { key: 'domain', label: 'Domain', render: (a) => <>{a.domain}<small className="muted" style={{ display: 'block' }}>{a.username}</small></> },
                { key: 'package_name', label: 'Package' },
                { key: 'disk', label: 'Disk', render: (a) => <UsageBar used={a.disk_used_mb} max={a.disk_quota_mb} /> },
                { key: 'bandwidth', label: 'Bandwidth', render: (a) => <UsageBar used={a.bandwidth_used_mb} max={a.bandwidth_limit_mb} /> },
                { key: 'suspended', label: 'Status', render: (a) => <StatusPill status={a.suspended ? 'suspended' : 'active'}>{a.suspended ? `Suspended${a.suspend_reason ? `: ${a.suspend_reason}` : ''}` : 'Active'}</StatusPill> },
              ]}
              rows={data.accounts} loading={loading} rowKey={(a) => a.username}
              rowActions={(a) => [a.suspended
                ? { label: 'Unsuspend', primary: true, disabled: busy === a.username, onClick: () => unsuspend(a) }
                : { label: 'Suspend', primary: true, danger: true, disabled: busy === a.username, onClick: () => suspend(a) }]}
              emptyText={`${data.reseller} owns no accounts.`}
            />
            <div className="card-body"><Button size="sm" onClick={() => refetch()}>Refresh</Button></div>
          </Card>
        </>
      )}
    </>
  );
}
