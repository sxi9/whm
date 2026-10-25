import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, formatMb } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

export default function DeletePackage({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/packages?pageSize=500');

  const remove = async (p) => {
    if (!(await confirm({ title: `Delete package "${p.name}"?`, message: 'Accounts are never deleted with a package; a package in use cannot be removed.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/packages/${encodeURIComponent(p.name)}`); toast.success(`Deleted "${p.name}"`); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'name', label: 'Package' },
            { key: 'disk_mb', label: 'Disk', render: (p) => formatMb(p.disk_mb) },
            { key: 'bandwidth_mb', label: 'Bandwidth', render: (p) => formatMb(p.bandwidth_mb) },
            { key: 'feature_list', label: 'Feature list' },
            { key: 'accounts', label: 'Accounts', align: 'right' },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(p) => p.name}
          rowActions={(p) => [{ label: p.accounts ? `In use (${p.accounts})` : 'Delete', primary: true, danger: true, disabled: p.accounts > 0 || p.name === 'default', onClick: () => remove(p) }]}
        />
      </Card>
    </>
  );
}
