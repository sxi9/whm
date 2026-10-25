import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, StatusPill } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toggle } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useServiceActions } from './ServiceStatus.jsx';

export default function ServiceManager({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch, setData } = useApi('/system/services');
  const run = useServiceActions(refetch);

  const configure = async (s, patch) => {
    setData((rows) => rows.map((r) => (r.name === s.name ? { ...r, ...patch } : r)));
    try { await api.patch(`/system/services/${s.name}`, patch); } catch (err) { toast.error(err); refetch(); }
  };
  const unit = async (s, enable) => {
    try { await api.post(`/system/services/${s.name}/${enable ? 'enable' : 'disable'}`); toast.success(`${s.displayName} ${enable ? 'enabled' : 'disabled'} at boot`); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Choose which services start at boot and which the panel monitors and restarts automatically when they fail." />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'displayName', label: 'Service', render: (s) => <><div>{s.displayName}</div><small className="muted">{s.unit ? <code>{s.unit}</code> : `looks for: ${s.candidates.join(', ')}`}</small></> },
            { key: 'state', label: 'Status', render: (s) => <StatusPill status={s.active ? 'active' : s.installed ? 'down' : 'not-installed'}>{s.active ? 'Up' : s.installed ? 'Down' : 'Not installed'}</StatusPill> },
            { key: 'unitEnabled', label: 'Start at boot', render: (s) => <Toggle checked={Boolean(s.unitEnabled)} disabled={!s.installed} onChange={(v) => unit(s, v)} /> },
            { key: 'monitored', label: 'Monitor', render: (s) => <Toggle checked={s.monitored} onChange={(v) => configure(s, { monitored: v })} /> },
            { key: 'restartOnFailure', label: 'Auto-restart', render: (s) => <Toggle checked={s.restartOnFailure} onChange={(v) => configure(s, { restartOnFailure: v })} /> },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(s) => s.name}
          rowActions={(s) => (!s.installed ? [] : [{ label: 'Restart', primary: true, onClick: () => run(s, 'restart') }, s.active ? { label: 'Stop', danger: true, onClick: () => run(s, 'stop') } : { label: 'Start', onClick: () => run(s, 'start') }])}
        />
      </Card>
    </>
  );
}
