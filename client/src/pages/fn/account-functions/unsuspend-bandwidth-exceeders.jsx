import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, EmptyState, formatMb } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, Toggle, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';

export default function UnsuspendBandwidthExceeders({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/account-functions/bandwidth/exceeders');
  const [selected, setSelected] = useState([]);
  const [resetCounters, setResetCounters] = useState(true);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const suspended = (data || []).filter((a) => a.suspended_for_bandwidth);

  const run = async (usernames, all = false) => {
    const n = all ? suspended.length : usernames.length;
    if (!(await confirm({ title: `Unsuspend ${n} account(s)?`, message: resetCounters ? 'The accounts are unlocked and their bandwidth counters zeroed, so they are not suspended again at the next check.' : 'The accounts are unlocked. Without a counter reset they are suspended again at the next enforcement run if still over their limit.', confirmLabel: 'Unsuspend' }))) return;
    setBusy(true);
    try {
      const { data: res } = await api.post('/account-functions/bandwidth/unsuspend-exceeders', all ? { all: true, resetCounters } : { usernames, all: false, resetCounters });
      setLast(res);
      toast[res.failed.length ? 'warning' : 'success'](`Unsuspended ${res.unsuspended.length} account(s)${res.failed.length ? `, ${res.failed.length} failed` : ''}`);
      setSelected([]);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Accounts that are over their monthly bandwidth limit, or were suspended for exceeding it. Unsuspending lifts the lock; resetting the counter keeps the enforcement job from suspending them again this month." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <Card padded={false}>
        <ErrorBanner error={error} onRetry={refetch} />
        {data && !data.length ? <EmptyState title="No bandwidth exceeders">Every account is under its limit and none is suspended for bandwidth.</EmptyState> : (
          <DataTable
            columns={[
              { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
              { key: 'domain', label: 'Domain' },
              { key: 'owner', label: 'Owner' },
              { key: 'bandwidth_used_mb', label: 'Used', align: 'right', render: (r) => formatMb(r.bandwidth_used_mb) },
              { key: 'bandwidth_limit_mb', label: 'Limit', align: 'right', render: (r) => formatMb(r.bandwidth_limit_mb) },
              { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.suspended_for_bandwidth ? 'suspended' : r.suspended ? 'warning' : 'failed'}>{r.suspended_for_bandwidth ? 'Suspended for bandwidth' : r.suspended ? `Suspended: ${r.suspend_reason}` : 'Over limit (not suspended)'}</StatusPill> },
            ]}
            rows={data || []} loading={loading} rowKey={(r) => r.username} selectable selected={selected} onSelectedChange={setSelected}
            rowActions={(r) => [r.suspended_for_bandwidth && { label: 'Unsuspend', primary: true, onClick: () => run([r.username]) }]}
            toolbar={(
              <>
                <Toggle checked={resetCounters} onChange={setResetCounters} label="Also reset counters" />
                <Button variant="primary" disabled={!selected.length} loading={busy} onClick={() => run(selected)}>Unsuspend selected ({selected.length})</Button>
                <Button loading={busy} disabled={!suspended.length} onClick={() => run([], true)}>Unsuspend all ({suspended.length})</Button>
              </>
            )}
          />
        )}
      </Card>
      {last && (
        <Card title="Last run">
          <ul>
            {last.unsuspended.map((u) => <li key={u}><code>{u}</code> <StatusPill status="ok">unsuspended</StatusPill></li>)}
            {last.failed.map((f) => <li key={f.username}><code>{f.username}</code> <StatusPill status="failed">{f.error}</StatusPill></li>)}
          </ul>
        </Card>
      )}
    </>
  );
}
