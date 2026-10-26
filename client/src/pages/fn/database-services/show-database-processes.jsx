import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatDuration } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Toggle, Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, engineLabel } from '../../databases/Shared.jsx';

export default function ShowDatabaseProcesses({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [live, setLive] = useState(true);
  const [hideSleeping, setHideSleeping] = useState(false);
  const { data, loading, error, refetch } = useApi('/databases/processes', { refreshMs: live ? 5000 : 0 });
  const rows = (data?.processes || []).filter((p) => !hideSleeping || !/^(sleep|idle)$/i.test(p.command || ''));

  const kill = async (p, queryOnly) => {
    const ok = await confirm({ title: queryOnly ? `Kill query ${p.id}?` : `Kill connection ${p.id}?`, message: queryOnly ? 'The running statement is aborted; the connection stays open.' : `The connection of ${p.user}@${p.host} is closed and its statement rolled back.`, confirmLabel: 'Kill', danger: true });
    if (!ok) return;
    try { await api.post(`/databases/processes/${p.id}/kill`, { queryOnly }); toast.success(`${queryOnly ? 'Query' : 'Connection'} ${p.id} killed`); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Live connections and running statements on the active database server (SHOW PROCESSLIST). Kill a runaway query or an idle connection." actions={<><Toggle checked={live} onChange={setLive} label="Auto-refresh (5s)" /><Button onClick={() => refetch()}>Refresh</Button></>} />
      <RequestError error={error} onRetry={refetch} />
      {data && (
        <Card title={`${rows.length} process${rows.length === 1 ? '' : 'es'}${data.profile ? ` on ${data.profile.profile_name} (${engineLabel(data.profile.engine)})` : ''}`} padded={false} actions={<Toggle checked={hideSleeping} onChange={setHideSleeping} label="Hide sleeping" />}>
          <DataTable
            columns={[
              { key: 'id', label: 'ID', width: 70 },
              { key: 'user', label: 'User', render: (p) => <code>{p.user}</code> },
              { key: 'host', label: 'Host', render: (p) => <code>{p.host}</code> },
              { key: 'db', label: 'Database', render: (p) => p.db || <span className="muted">—</span> },
              { key: 'command', label: 'Command', render: (p) => <StatusPill status={/^(sleep|idle)$/i.test(p.command || '') ? 'inactive' : 'active'}>{p.command}</StatusPill> },
              { key: 'time', label: 'Time', render: (p) => (p.time >= 60 ? formatDuration(p.time) : `${p.time}s`) },
              { key: 'state', label: 'State', render: (p) => p.state || <span className="muted">—</span> },
              { key: 'info', label: 'Statement', render: (p) => (p.info ? <code title={p.info}>{p.info.length > 120 ? `${p.info.slice(0, 120)}…` : p.info}</code> : <span className="muted">—</span>) },
            ]}
            rows={rows} loading={loading && !data} rowKey={(p) => p.id} dense
            rowActions={(p) => [p.info ? { label: 'Kill query', primary: true, danger: true, onClick: () => kill(p, true) } : null, { label: 'Kill connection', danger: true, primary: !p.info, onClick: () => kill(p, false) }]}
            emptyText="No client connections."
          />
        </Card>
      )}
    </>
  );
}
