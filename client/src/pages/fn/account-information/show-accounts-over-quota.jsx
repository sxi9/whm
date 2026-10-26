import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, HardDrive } from 'lucide-react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, formatMb, formatDate, KeyValue } from '../../../components/Common.jsx';
import { Button } from '../../../components/Form.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { JobCard, Meter, RequestError, Tabs, Stat } from '../../account-info/Shared.jsx';

const SCOPES = [{ value: 'over', label: 'Over quota' }, { value: 'warn', label: 'Near quota' }, { value: 'all', label: 'All accounts' }];

export default function ShowAccountsOverQuota({ fn }) {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const [scope, setScope] = useState('over');
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const t = useTableState({ sort: 'percent', dir: 'desc' });
  const { data, meta, loading, error, refetch } = useApi(`/account-info/quota${queryString({ ...t.state, scope })}`);
  const report = useApi('/account-info/quota/report', { enabled: showReport && isRoot });
  const quota = meta?.quota;

  const refresh = async () => {
    setBusy(true);
    try { const { data: d } = await api.post('/account-info/quota/refresh'); setJobId(d.job.id); toast.info('Measuring disk usage for every account…'); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const act = async (label, fnc) => { try { await fnc(); toast.success(label); refetch(); } catch (err) { toast.error(err); } };

  const columns = [
    { key: 'username', label: 'Account', sortable: true, render: (r) => <code>{r.username}</code> },
    { key: 'domain', label: 'Domain', sortable: true },
    { key: 'owner', label: 'Owner', sortable: true },
    { key: 'package', label: 'Package', sortable: true, render: (r) => r.package_name },
    { key: 'disk_used_mb', label: 'Used', sortable: true, align: 'right', render: (r) => formatMb(r.disk_used_mb) },
    { key: 'disk_quota_mb', label: 'Quota', sortable: true, align: 'right', render: (r) => formatMb(r.disk_quota_mb) },
    { key: 'percent', label: 'Usage', sortable: true, render: (r) => <Meter percent={r.percent} warnAt={quota?.warnPercent ?? 90} /> },
    { key: 'status', label: 'Status', render: (r) => r.over ? <StatusPill status="failed">Over quota</StatusPill> : r.warn ? <StatusPill status="warning">Near quota</StatusPill> : r.suspended ? <StatusPill status="suspended">Suspended</StatusPill> : <StatusPill status="ok">OK</StatusPill> },
    { key: 'updated_at', label: 'Measured', render: (r) => formatDate(r.updated_at) },
  ];
  const rowActions = (r) => [
    { label: 'Change quota', primary: true, onClick: () => navigate(`/account-functions/quota-modification?username=${r.username}`) },
    { label: 'Modify account', onClick: () => navigate(`/account-functions/modify-an-account?username=${r.username}`) },
    !r.suspended && r.over ? { label: 'Suspend', danger: true, onClick: async () => { if (await confirm({ title: `Suspend ${r.username}?`, message: `${r.username} is using ${formatMb(r.disk_used_mb)} of its ${formatMb(r.disk_quota_mb)} quota. Suspending locks the login and disables its sites and mail.`, confirmLabel: 'Suspend', danger: true })) act(`Suspended ${r.username}`, () => api.post(`/accounts/${r.username}/suspend`, { reason: 'Disk quota exceeded' })); } } : null,
  ];

  return (
    <>
      <PageHeader fn={fn} description="Accounts whose measured disk usage has reached their quota. Figures come from repquota when disk quotas are enabled, otherwise from a scheduled du scan of each home directory (every 6 hours)."
        actions={isRoot && <Button icon={RefreshCw} loading={busy} onClick={refresh}>Refresh disk usage</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {meta && (
        <div className="stat-grid" style={{ marginBottom: 14 }}>
          <Stat label={SCOPES.find((s) => s.value === scope).label} value={meta.total} />
          <Stat label="Usage source" value={quota.installed ? 'repquota' : 'du scan'} hint={quota.installed ? 'Disk quotas are enforced by the kernel' : 'Quota tools not installed; limits are reported, not enforced'} />
          <Stat label="Warn threshold" value={`${quota.warnPercent}%`} hint="Accounts above this are listed as near quota" />
          <Stat label="Last measured" value={quota.lastRefresh ? formatDate(quota.lastRefresh) : 'never'} hint="Runs on the account-disk-usage schedule" />
        </div>
      )}
      {quota && !quota.installed && (
        <div className="banner banner-info"><HardDrive size={18} /><div><strong>Disk quotas are not enforced on this server</strong><p className="muted">The quota package is missing, so usage is measured with du and accounts over their allowance keep writing files. Install quota tools and run Initial Quota Setup to enforce limits; this list keeps working either way.</p></div></div>
      )}
      <JobCard jobId={jobId} title="Disk usage refresh" onFinished={() => refetch()} />
      <Card padded={false}>
        <div style={{ padding: '12px 14px 0' }}><Tabs tabs={SCOPES} value={scope} onChange={(v) => { setScope(v); t.setPage(1); }} /></div>
        <DataTable columns={columns} rows={data || []} loading={loading} error={null} rowKey={(r) => r.username}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search account, domain or owner…"
          rowActions={rowActions} emptyText={scope === 'over' ? 'No account is over its disk quota.' : scope === 'warn' ? 'No account is near its quota.' : 'No accounts yet.'} />
      </Card>
      {isRoot && (
        <Card title="System quota report" subtitle="Raw repquota figures for every Linux user on the filesystem, including users the panel does not manage" actions={<Button size="sm" onClick={() => { setShowReport(true); if (showReport) report.refetch(); }}>{showReport ? 'Reload' : 'Load report'}</Button>}>
          {!showReport && <p className="muted">Requires the quota package. Loads on demand because repquota walks the whole filesystem.</p>}
          {showReport && <RequestError error={report.error} onRetry={report.refetch} />}
          {showReport && report.data && (
            <>
              <KeyValue items={[['Filesystem', <code key="fs">{report.data.filesystem}</code>], ['Users reported', report.data.users.length]]} />
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead><tr><th>User</th><th>Domain</th><th className="align-right">Used</th><th className="align-right">Soft</th><th className="align-right">Hard</th><th>State</th></tr></thead>
                  <tbody>
                    {report.data.users.map((u) => (
                      <tr key={u.username}><td><code>{u.username}</code></td><td>{u.domain || <span className="muted">{u.managed ? '—' : 'not a panel account'}</span>}</td><td className="align-right">{formatMb(u.usedMb)}</td><td className="align-right">{u.softMb ? formatMb(u.softMb) : '—'}</td><td className="align-right">{u.hardMb ? formatMb(u.hardMb) : '—'}</td><td>{u.over ? <StatusPill status="failed">Over</StatusPill> : <StatusPill status="ok">OK</StatusPill>}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}
    </>
  );
}
