import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, formatBytes, formatMb, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { AccountDiskTable } from '../../server/AccountDiskTable.jsx';
import { JobCard } from '../../account-info/Shared.jsx';

export default function DiskUsage({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/system-health/disk');
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);
  const filesystems = data?.filesystems || [];

  const resample = async () => {
    setBusy(true);
    try {
      const res = await api.post('/system-health/disk/refresh');
      setJobId(res.data.job.id);
      toast.info('Measuring disk usage for every account…');
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const sampled = data ? (data.sampledAt ? `sampled ${formatDate(data.sampledAt)}` : 'not sampled yet') : null;
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
      <JobCard jobId={jobId} title="Disk usage resample" onFinished={() => { setJobId(null); refetch(); }} />
      <Card
        title="Accounts"
        subtitle={data ? `${data.accounts.length} account(s) using ${formatMb(data.accountsTotalMb)} in total, ${sampled}. Usage is measured every 6 hours; resample to refresh it now.` : undefined}
        actions={data?.canResample ? <Button size="sm" icon={RefreshCw} loading={busy || Boolean(jobId)} onClick={resample}>Resample now</Button> : null}
        padded={false}
      >
        <AccountDiskTable accounts={data?.accounts} loading={loading} error={error} />
      </Card>
    </>
  );
}
