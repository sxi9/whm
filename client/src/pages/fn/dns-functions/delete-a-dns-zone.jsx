import { useState } from 'react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';

export default function DeleteDnsZone({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const t = useTableState({ sort: 'domain' });
  const { data, meta, loading, error, refetch } = useApi(`/dns/zones${queryString(t.state)}`);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  const remove = async (domains) => {
    const ok = await confirm({
      title: domains.length === 1 ? `Delete zone ${domains[0]}?` : `Delete ${domains.length} zones?`,
      message: 'The zone file is removed from BIND and named is reloaded. The domain stops resolving from this server immediately. This cannot be undone.',
      confirmLabel: 'Delete', danger: true, typeToConfirm: domains.length === 1 ? domains[0] : 'DELETE',
    });
    if (!ok) return;
    setBusy(true);
    let done = 0;
    for (const d of domains) { try { await api.delete(`/dns/zones/${d}`); done++; } catch (err) { toast.error(`${d}: ${err.message}`); } }
    setBusy(false);
    if (done) toast.success(`Deleted ${done} zone(s)`);
    setSelected([]);
    refetch();
  };

  return (
    <>
      <PageHeader fn={fn} description="Remove zones from BIND and the panel. Zones still attached to an account are listed too; deleting one of those leaves the account without DNS." />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'domain', label: 'Zone', sortable: true, render: (z) => <code>{z.domain}</code> },
            { key: 'account', label: 'Account', sortable: true, render: (z) => z.account || <StatusPill status="warning">orphan</StatusPill> },
            { key: 'record_count', label: 'Records', sortable: true, align: 'right' },
            { key: 'serial', label: 'Serial', sortable: true, render: (z) => <code>{z.serial}</code> },
            { key: 'updated_at', label: 'Updated', sortable: true, render: (z) => formatDate(z.updated_at) },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(z) => z.domain}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search zones"
          selectable selected={selected} onSelectedChange={setSelected}
          rowActions={(z) => [{ label: 'Delete', primary: true, danger: true, onClick: () => remove([z.domain]) }]}
          toolbar={<Button variant="danger" disabled={!selected.length} loading={busy} onClick={() => remove(selected)}>Delete selected ({selected.length})</Button>}
          emptyText="No DNS zones exist yet."
        />
      </Card>
    </>
  );
}
