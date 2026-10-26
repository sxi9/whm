import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, formatMb } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { ResellerStatusPill, Summary } from '../../resellers/Shared.jsx';

export default function ResetResellers({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/resellers?pageSize=500&sort=username');
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const rows = data || [];

  const reset = async (usernames, all = false) => {
    const n = all ? rows.length : usernames.length;
    const accounts = (all ? rows : rows.filter((r) => usernames.includes(r.username))).reduce((s, r) => s + r.usage.accounts, 0);
    if (!(await confirm({ title: `Reset ${n} reseller(s)?`, message: `Privileges, limits, nameservers and delegated IPs are removed and ${accounts} account(s) move to root. The hosting accounts and the logins themselves are kept.`, confirmLabel: 'Reset resellers', danger: true, typeToConfirm: 'RESET' }))) return;
    setBusy(true);
    try {
      const { data: res } = await api.post('/resellers/reset', all ? { all: true } : { usernames });
      setLast(res);
      toast.success(`${res.results.filter((r) => r.reset).length} reseller(s) reset; accounts moved to ${res.moved_to}`);
      setSelected([]);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Strips reseller privileges without touching hosting accounts: the accounts a reseller owns are reassigned to root, its ACLs, limits and delegated IPs are cleared and its login becomes a plain user. Re-add it in Reseller Center to restore." />
      <Summary items={[['Resellers', data ? rows.length : null], ['Selected', selected.length], ['Accounts affected', rows.filter((r) => selected.includes(r.username)).reduce((s, r) => s + r.usage.accounts, 0)]]} />
      <Card padded={false}>
        <ErrorBanner error={error} onRetry={refetch} />
        <DataTable
          columns={[
            { key: 'username', label: 'Reseller', render: (r) => <code>{r.username}</code> },
            { key: 'email', label: 'Email' },
            { key: 'accounts', label: 'Accounts', align: 'right', render: (r) => r.usage.accounts },
            { key: 'disk', label: 'Disk used', align: 'right', render: (r) => formatMb(r.usage.disk_used_mb) },
            { key: 'ips', label: 'Delegated IPs', render: (r) => r.delegated_ips.join(', ') || <span className="muted">—</span> },
            { key: 'status', label: 'Status', render: (r) => <ResellerStatusPill reseller={r} /> },
          ]}
          rows={rows} loading={loading} rowKey={(r) => r.username} selectable selected={selected} onSelectedChange={setSelected}
          rowActions={(r) => [{ label: 'Reset', primary: true, danger: true, onClick: () => reset([r.username]) }]}
          toolbar={(
            <>
              <Button variant="danger" disabled={!selected.length} loading={busy} onClick={() => reset(selected)}>Reset selected ({selected.length})</Button>
              <Button variant="danger-ghost" disabled={!rows.length} loading={busy} onClick={() => reset([], true)}>Reset all resellers</Button>
            </>
          )}
          emptyText="There are no resellers to reset."
        />
      </Card>
      {last && (
        <Card title="Last reset">
          <ul>
            {last.results.map((r) => <li key={r.username}><code>{r.username}</code>: {r.reset ? `reset; ${r.accounts_moved.length} account(s) moved to ${last.moved_to}${r.ips_released.length ? `, released ${r.ips_released.join(', ')}` : ''}${r.login_suspended ? '; login suspended (no hosting account)' : ''}` : r.reason}</li>)}
            {last.missing.map((u) => <li key={u}><code>{u}</code>: not a reseller</li>)}
          </ul>
        </Card>
      )}
    </>
  );
}
