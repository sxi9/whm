import { useState } from 'react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';

const STATUS_LABEL = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

export default function TaskQueueMonitor({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/system/jobs?limit=200', { refreshMs: 5000 });
  const [open, setOpen] = useState(null);
  const cancel = async (job) => { try { await api.post(`/system/jobs/${job.id}/cancel`); toast.success('Job cancelled'); refetch(); } catch (err) { toast.error(err); } };
  return (
    <>
      <PageHeader fn={fn} description="Background jobs: backups, transfers, bulk changes and builds. Open a job to follow its live log." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'id', label: '#', width: 60 },
            { key: 'type', label: 'Type', render: (j) => <code>{j.type}</code> },
            { key: 'status', label: 'Status', render: (j) => <StatusPill status={j.status}>{STATUS_LABEL[j.status] || j.status}</StatusPill> },
            { key: 'progress', label: 'Progress', render: (j) => <div className="progress-bar" style={{ width: 120 }}><span style={{ width: `${j.progress}%` }} /></div> },
            { key: 'message', label: 'Message', render: (j) => j.message || j.error || '' },
            { key: 'created_at', label: 'Queued', render: (j) => formatDate(j.created_at) },
            { key: 'finished_at', label: 'Finished', render: (j) => formatDate(j.finished_at) },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(j) => j.id} emptyText="No background jobs yet. Backups, transfers and bulk changes appear here when they are queued."
          rowActions={(j) => [{ label: 'View log', primary: true, onClick: () => setOpen(j) }, j.status === 'queued' ? { label: 'Cancel', danger: true, onClick: () => cancel(j) } : null]}
          dense
        />
      </Card>
      <Modal open={Boolean(open)} title={open ? `Job #${open.id} · ${open.type}` : ''} onClose={() => setOpen(null)} size="lg">
        {open && <ProgressLog jobId={open.id} onFinished={() => refetch()} />}
      </Modal>
    </>
  );
}
