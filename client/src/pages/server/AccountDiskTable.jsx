import { Link } from 'react-router-dom';
import { DataTable } from '../../components/DataTable.jsx';
import { formatMb, StatusPill } from '../../components/Common.jsx';

// Per-account consumption as last measured by the quota/disk sampler.
export function AccountDiskTable({ accounts, loading, error }) {
  return (
    <DataTable dense rows={accounts || []} loading={loading} error={error} rowKey={(a) => a.username} emptyText="No accounts yet."
      columns={[
        { key: 'username', label: 'Account', render: (a) => <><Link to={`/account-functions/modify-an-account?username=${encodeURIComponent(a.username)}`}>{a.username}</Link>{a.suspended && <> <StatusPill status="suspended">Suspended</StatusPill></>}</> },
        { key: 'domain', label: 'Domain' },
        { key: 'owner', label: 'Owner' },
        { key: 'homeDir', label: 'Home', render: (a) => <code>{a.homeDir}</code> },
        { key: 'diskUsedMb', label: 'Used', align: 'right', render: (a) => formatMb(a.diskUsedMb) },
        { key: 'diskQuotaMb', label: 'Quota', align: 'right', render: (a) => formatMb(a.diskQuotaMb) },
        { key: 'usedPercent', label: 'Usage', render: (a) => (a.usedPercent == null ? <span className="muted">unlimited</span> : <div style={{ minWidth: 160 }}>{a.usedPercent}%<div className={`meter ${a.usedPercent >= 90 ? 'bad' : a.usedPercent >= 75 ? 'warn' : ''}`}><span style={{ width: `${a.usedPercent}%` }} /></div></div>) },
      ]}
    />
  );
}
