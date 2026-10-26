import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Button, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useResellerCatalog, Summary } from '../../resellers/Shared.jsx';

export default function ChangeOwnershipOfMultipleAccounts({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/accounts?pageSize=500&sort=username');
  const catalog = useResellerCatalog();
  const [selected, setSelected] = useState([]);
  const [filter, setFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const accounts = data || [];
  const rows = accounts.filter((a) => (!filter || `${a.username} ${a.domain} ${a.owner}`.toLowerCase().includes(filter.toLowerCase())) && (!ownerFilter || a.owner === ownerFilter));
  const owners = catalog.data?.owners || [];

  const apply = async () => {
    if (!(await confirm({ title: `Move ${selected.length} account(s) to ${owner}?`, message: 'Each account is reassigned individually; accounts already owned by the target are reported as unchanged.', confirmLabel: 'Change ownership' }))) return;
    setBusy(true);
    try {
      const { data: res } = await api.post('/resellers/ownership', { usernames: selected, owner });
      setLast(res);
      toast.success(`${res.changed} account(s) moved to ${res.owner}${res.failed ? `, ${res.failed} not changed` : ''}`);
      setSelected([]);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Select accounts and reassign them to root or a reseller in one go. Filter by current owner to move a whole reseller's portfolio." />
      <Summary items={[['Accounts', data ? accounts.length : null], ['Shown', rows.length], ['Selected', selected.length]]} />
      <Card padded={false}>
        <ErrorBanner error={error || catalog.error} onRetry={refetch} />
        <DataTable
          columns={[
            { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
            { key: 'domain', label: 'Domain' },
            { key: 'owner', label: 'Current owner' },
            { key: 'package_name', label: 'Package' },
            { key: 'suspended', label: 'Status', render: (r) => <StatusPill status={r.suspended ? 'suspended' : 'active'}>{r.suspended ? 'Suspended' : 'Active'}</StatusPill> },
          ]}
          rows={rows} loading={loading} rowKey={(r) => r.username} selectable selected={selected} onSelectedChange={setSelected}
          searchable q={filter} onSearch={setFilter} searchPlaceholder="Filter by user, domain or owner"
          toolbar={(
            <>
              <Field inline><Select value={ownerFilter} onChange={setOwnerFilter} options={owners.map((o) => ({ value: o.username, label: `owned by ${o.username}` }))} placeholder="Any current owner" /></Field>
              <Field inline><Select value={owner} onChange={setOwner} options={owners.map((o) => ({ value: o.username, label: `${o.username} (${o.role})` }))} placeholder="New owner…" /></Field>
              <Button variant="primary" disabled={!selected.length || !owner} loading={busy} onClick={apply}>Move {selected.length} to {owner || '…'}</Button>
            </>
          )}
          emptyText="No accounts match."
        />
      </Card>
      {last && (
        <Card title={`Last run: ${last.changed} moved to ${last.owner}`} padded={false}>
          <DataTable dense columns={[
            { key: 'username', label: 'Account', render: (r) => <code>{r.username}</code> },
            { key: 'changed', label: 'Result', render: (r) => <StatusPill status={r.changed ? 'done' : 'failed'}>{r.changed ? `moved from ${r.previous_owner}` : r.error}</StatusPill> },
            { key: 'warnings', label: 'Warnings', render: (r) => r.warnings?.join('; ') || <span className="muted">—</span> },
          ]} rows={last.results} rowKey={(r) => r.username} />
        </Card>
      )}
    </>
  );
}
