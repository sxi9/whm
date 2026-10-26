import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, KeyValue, StatusPill, formatMb } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, NumberInput, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { AccountPicker, useSelectedAccount } from '../../accounts/AccountPicker.jsx';

export default function LimitBandwidthUsage({ fn }) {
  const toast = useToast();
  const { user } = useAuth();
  const [username, setUsername] = useState('');
  const { account, refetch } = useSelectedAccount(username);
  const { data: all, refetch: refetchAll } = useApi('/account-functions/summary');
  const { data: enforcement, refetch: refetchEnforcement } = useApi('/account-functions/bandwidth-enforcement');
  const [limit, setLimit] = useState(null);
  const [unlimited, setUnlimited] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (account) { setLimit(account.bandwidth_limit_mb); setUnlimited(account.bandwidth_limit_mb == null); } }, [account]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { data } = await api.put(`/account-functions/bandwidth/${username}`, { limitMb: unlimited ? null : limit ?? 0 });
      toast.success(`${username}: bandwidth limit ${data.bandwidth_limit_mb == null ? 'removed' : `set to ${formatMb(data.bandwidth_limit_mb)}`}`);
      refetch(); refetchAll();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const toggleEnforcement = async (enabled) => {
    try { await api.put('/account-functions/bandwidth-enforcement', { enabled }); toast.success(enabled ? 'Accounts over their limit are suspended hourly' : 'Automatic suspension disabled'); refetchEnforcement(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Caps the monthly transfer of an account. Usage is counted from the web logs; with enforcement on, an account over its cap is suspended with a bandwidth reason until the counters reset on the 1st or an administrator unsuspends it." />
      <Card title="Select an account"><AccountPicker value={username} onChange={setUsername} /></Card>
      {account && (
        <form onSubmit={save}>
          <Card title={`${account.domain} (${account.username})`}>
            <KeyValue items={[['Used this month', formatMb(account.bandwidth_used_mb)], ['Current limit', formatMb(account.bandwidth_limit_mb)], ['Package default', formatMb(account.plan?.bandwidth_mb)], ['Status', <StatusPill key="s" status={account.suspended ? 'suspended' : 'active'}>{account.suspended ? `Suspended${account.suspend_reason ? `: ${account.suspend_reason}` : ''}` : 'Active'}</StatusPill>]]} />
            <ErrorBanner error={error} />
            <div className="form-grid" style={{ marginTop: 14 }}>
              <Field inline><Toggle checked={unlimited} onChange={setUnlimited} label="Unlimited bandwidth" /></Field>
              {!unlimited && <Field label="Monthly limit (MB)" error={error?.fields?.limitMb} help="1024 MB = 1 GB"><NumberInput value={limit} onChange={setLimit} min={0} nullable={false} /></Field>}
            </div>
            <FormActions><Button type="submit" variant="primary" loading={busy}>Save limit</Button></FormActions>
          </Card>
        </form>
      )}
      {user.role === 'root' && enforcement && (
        <Card title="Enforcement">
          <Field inline><Toggle checked={enforcement.enabled} onChange={toggleEnforcement} label="Suspend accounts that exceed their limit" description={`Checked hourly by the scheduler; suspension reason "${enforcement.reason}". Unsuspend Bandwidth Exceeders lifts them.`} /></Field>
        </Card>
      )}
      <Card title="All accounts" padded={false}>
        <DataTable
          columns={[
            { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
            { key: 'domain', label: 'Domain' },
            { key: 'bandwidth_used_mb', label: 'Used', align: 'right', render: (r) => formatMb(r.bandwidth_used_mb) },
            { key: 'bandwidth_limit_mb', label: 'Limit', align: 'right', render: (r) => formatMb(r.bandwidth_limit_mb) },
            { key: 'bandwidth_percent', label: 'Usage', render: (r) => (r.bandwidth_percent == null ? <span className="muted">unlimited</span> : <StatusPill status={r.over_bandwidth ? 'failed' : r.bandwidth_percent >= 80 ? 'warning' : 'ok'}>{r.bandwidth_percent}%</StatusPill>) },
          ]}
          rows={all || []} rowKey={(r) => r.username} dense
          rowActions={(r) => [{ label: 'Edit', primary: true, onClick: () => setUsername(r.username) }]}
        />
      </Card>
    </>
  );
}
