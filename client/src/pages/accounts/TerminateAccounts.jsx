import { useState } from 'react';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatMb } from '../../components/Common.jsx';
import { DataTable, useTableState } from '../../components/DataTable.jsx';
import { Toggle, Button } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

export default function TerminateAccounts({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const t = useTableState({ sort: 'username' });
  const { data, meta, loading, error, refetch } = useApi(`/accounts${queryString(t.state)}`);
  const [selected, setSelected] = useState([]);
  const [keepDns, setKeepDns] = useState(false);
  const [busy, setBusy] = useState(false);

  const terminate = async (usernames) => {
    const ok = await confirm({
      title: usernames.length === 1 ? `Terminate ${usernames[0]}?` : `Terminate ${usernames.length} accounts?`,
      message: 'This permanently removes the Linux users, home directories, databases, mail and DNS zones. It cannot be undone.',
      confirmLabel: 'Terminate', danger: true, typeToConfirm: usernames.length === 1 ? usernames[0] : 'TERMINATE',
    });
    if (!ok) return;
    setBusy(true);
    let done = 0;
    for (const u of usernames) {
      try { await api.delete(`/accounts/${u}?keepDns=${keepDns}`); done++; } catch (err) { toast.error(`${u}: ${err.message}`); }
    }
    setBusy(false);
    if (done) toast.success(`Terminated ${done} account(s)`);
    setSelected([]);
    refetch();
  };

  return (
    <>
      <PageHeader fn={fn} />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'username', label: 'User', sortable: true, render: (r) => <code>{r.username}</code> },
            { key: 'domain', label: 'Domain', sortable: true },
            { key: 'owner', label: 'Owner', sortable: true },
            { key: 'package', label: 'Package', render: (r) => r.package_name },
            { key: 'disk_used_mb', label: 'Disk used', align: 'right', render: (r) => formatMb(r.disk_used_mb) },
            { key: 'suspended', label: 'Status', render: (r) => <StatusPill status={r.suspended ? 'suspended' : 'active'}>{r.suspended ? 'Suspended' : 'Active'}</StatusPill> },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(r) => r.username}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch}
          selectable selected={selected} onSelectedChange={setSelected}
          rowActions={(r) => [{ label: 'Terminate', primary: true, danger: true, onClick: () => terminate([r.username]) }]}
          toolbar={(
            <>
              <Toggle checked={keepDns} onChange={setKeepDns} label="Keep DNS zones" />
              <Button variant="danger" disabled={!selected.length} loading={busy} onClick={() => terminate(selected)}>Terminate selected ({selected.length})</Button>
            </>
          )}
        />
      </Card>
    </>
  );
}
