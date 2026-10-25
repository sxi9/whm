import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, formatBytes } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';

export default function DiskUsage({ fn }) {
  const { data, loading, error, refetch } = useApi('/system/disk');
  return (
    <>
      <PageHeader fn={fn} actions={<button className="btn" onClick={() => refetch()}>Refresh</button>} />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'filesystem', label: 'Filesystem', render: (d) => <code>{d.filesystem}</code> },
            { key: 'mountpoint', label: 'Mount point' },
            { key: 'sizeBytes', label: 'Size', align: 'right', render: (d) => formatBytes(d.sizeBytes) },
            { key: 'usedBytes', label: 'Used', align: 'right', render: (d) => formatBytes(d.usedBytes) },
            { key: 'availableBytes', label: 'Available', align: 'right', render: (d) => formatBytes(d.availableBytes) },
            { key: 'usedPercent', label: 'Usage', render: (d) => <div style={{ minWidth: 160 }}>{d.usedPercent}%<div className={`meter ${d.usedPercent > 90 ? 'bad' : d.usedPercent > 75 ? 'warn' : ''}`}><span style={{ width: `${d.usedPercent}%` }} /></div></div> },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(d) => `${d.filesystem}:${d.mountpoint}`}
        />
      </Card>
    </>
  );
}
