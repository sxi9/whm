import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, formatBytes, formatMb } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button } from '../../../components/Form.jsx';
import { AccountDiskTable } from '../../server/AccountDiskTable.jsx';

export default function DiskUsage({ fn }) {
  const { data, loading, error, refetch } = useApi('/system-health/disk');
  const filesystems = data?.filesystems || [];
  return (
    <>
      <PageHeader fn={fn} actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <Card title="Filesystems" padded={false}>
        <DataTable
          columns={[
            { key: 'filesystem', label: 'Filesystem', render: (d) => <code>{d.filesystem}</code> },
            { key: 'mountpoint', label: 'Mount point' },
            { key: 'sizeBytes', label: 'Size', align: 'right', render: (d) => formatBytes(d.sizeBytes) },
            { key: 'usedBytes', label: 'Used', align: 'right', render: (d) => formatBytes(d.usedBytes) },
            { key: 'availableBytes', label: 'Available', align: 'right', render: (d) => formatBytes(d.availableBytes) },
            { key: 'usedPercent', label: 'Usage', render: (d) => <div style={{ minWidth: 160 }}>{d.usedPercent}%<div className={`meter ${d.usedPercent > 90 ? 'bad' : d.usedPercent > 75 ? 'warn' : ''}`}><span style={{ width: `${d.usedPercent}%` }} /></div></div> },
          ]}
          rows={filesystems} loading={loading} error={error} rowKey={(d) => `${d.filesystem}:${d.mountpoint}`}
        />
      </Card>
      <Card title="Accounts" subtitle={data ? `${data.accounts.length} account(s) using ${formatMb(data.accountsTotalMb)} in total, as of the last disk-usage sample.` : undefined} padded={false}>
        <AccountDiskTable accounts={data?.accounts} loading={loading} error={error} />
      </Card>
    </>
  );
}
