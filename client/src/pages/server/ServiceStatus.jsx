import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, formatBytes, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

export function useServiceActions(refetch) {
  const toast = useToast();
  const confirm = useConfirm();
  return async (service, verb) => {
    if (verb === 'stop' && !(await confirm({ title: `Stop ${service.displayName}?`, message: 'Clients using this service will be disconnected.', confirmLabel: 'Stop', danger: true }))) return;
    try {
      const { data } = await api.post(`/system/services/${service.name}/${verb}`);
      toast.success(`${service.displayName}: ${verb} → ${data.status?.state || 'ok'}`);
      refetch();
    } catch (err) { toast.error(err); }
  };
}

export default function ServiceStatus({ fn }) {
  const { user } = useAuth();
  const { data, loading, error, refetch } = useApi('/system/services', { refreshMs: 15_000 });
  const run = useServiceActions(refetch);
  const rows = (data || []).filter((s) => s.monitored);
  return (
    <>
      <PageHeader fn={fn} actions={<button className="btn" onClick={() => refetch()}>Refresh</button>} />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'displayName', label: 'Service' },
            { key: 'unit', label: 'Unit', render: (s) => (s.unit ? <code>{s.unit}</code> : <span className="muted">not installed</span>) },
            { key: 'state', label: 'Status', render: (s) => <StatusPill status={s.active ? 'active' : s.installed ? 'down' : 'not-installed'}>{s.active ? 'Up' : s.installed ? 'Down' : 'Not installed'}</StatusPill> },
            { key: 'pid', label: 'PID' },
            { key: 'memoryBytes', label: 'Memory', align: 'right', render: (s) => formatBytes(s.memoryBytes) },
            { key: 'restarts', label: 'Restarts', align: 'right' },
            { key: 'startedAt', label: 'Started', render: (s) => (s.startedAt ? formatDate(s.startedAt) : '—') },
          ]}
          rows={rows} loading={loading} error={error} rowKey={(s) => s.name}
          rowActions={(s) => (user.role !== 'root' || !s.installed ? [] : [
            { label: 'Restart', primary: true, onClick: () => run(s, 'restart') },
            s.active ? { label: 'Stop', danger: true, onClick: () => run(s, 'stop') } : { label: 'Start', onClick: () => run(s, 'start') },
          ])}
          dense
        />
      </Card>
    </>
  );
}
