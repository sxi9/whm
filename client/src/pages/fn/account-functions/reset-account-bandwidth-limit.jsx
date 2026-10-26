import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatMb } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, Toggle, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';

export default function ResetAccountBandwidthLimit({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/account-functions/summary');
  const [selected, setSelected] = useState([]);
  const [unsuspend, setUnsuspend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);

  const reset = async (usernames, all = false) => {
    const n = all ? (data || []).length : usernames.length;
    if (!(await confirm({ title: `Reset bandwidth counters for ${n} account(s)?`, message: 'The current month\'s transfer counter is zeroed. Accounts suspended for exceeding their bandwidth are unsuspended when the option is on.', confirmLabel: 'Reset' }))) return;
    setBusy(true);
    try {
      const { data: res } = await api.post('/account-functions/bandwidth/reset', all ? { all: true, unsuspend } : { usernames, unsuspend });
      setLast(res);
      toast.success(`Reset ${res.reset.length} account(s)${res.unsuspended.length ? `, unsuspended ${res.unsuspended.join(', ')}` : ''}`);
      setSelected([]);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Clears the current month's bandwidth counter of selected accounts. The scheduler does this for every account on the 1st of each month." />
      <Card padded={false}>
        <ErrorBanner error={error} onRetry={refetch} />
        <DataTable
          columns={[
            { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
            { key: 'domain', label: 'Domain' },
            { key: 'owner', label: 'Owner' },
            { key: 'bandwidth_used_mb', label: 'Used', align: 'right', render: (r) => formatMb(r.bandwidth_used_mb) },
            { key: 'bandwidth_limit_mb', label: 'Limit', align: 'right', render: (r) => formatMb(r.bandwidth_limit_mb) },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.suspended ? 'suspended' : r.over_bandwidth ? 'warning' : 'active'}>{r.suspended ? `Suspended${/^bandwidth/i.test(r.suspend_reason || '') ? ' (bandwidth)' : ''}` : r.over_bandwidth ? 'Over limit' : 'Active'}</StatusPill> },
          ]}
          rows={data || []} loading={loading} rowKey={(r) => r.username} selectable selected={selected} onSelectedChange={setSelected}
          rowActions={(r) => [{ label: 'Reset', primary: true, onClick: () => reset([r.username]) }]}
          toolbar={(
            <>
              <Toggle checked={unsuspend} onChange={setUnsuspend} label="Unsuspend bandwidth-suspended accounts" />
              <Button variant="primary" disabled={!selected.length} loading={busy} onClick={() => reset(selected)}>Reset selected ({selected.length})</Button>
              <Button loading={busy} disabled={!data?.length} onClick={() => reset([], true)}>Reset all</Button>
            </>
          )}
        />
      </Card>
      {last && <Card title="Last reset"><p>Period <code>{last.period}</code>: reset {last.reset.length} account(s){last.unsuspended.length ? `; unsuspended ${last.unsuspended.join(', ')}` : ''}{last.missing.length ? `; not found: ${last.missing.join(', ')}` : ''}.</p></Card>}
    </>
  );
}
