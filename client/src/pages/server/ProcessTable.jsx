import { useState } from 'react';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { DataTable } from '../../components/DataTable.jsx';
import { Select, TextInput, Button } from '../../components/Form.jsx';
import { CapabilityNotice, formatBytes, formatDuration } from '../../components/Common.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

// `base` is the API prefix that serves /processes, /processes/:pid/signal and
// /processes/:pid/renice; the system-health prefix raises capability_missing
// (501) when procps is absent instead of returning an empty list.
export function ProcessTable({ manage = false, base = '/system-health' }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [sort, setSort] = useState('cpu');
  const [user, setUser] = useState('');
  const [limit, setLimit] = useState(200);
  const { data, loading, error, refetch } = useApi(`${base}/processes${queryString({ sort, user: user || undefined, limit })}`, { refreshMs: manage ? 0 : 10_000 });

  const signal = async (p, sig) => {
    if (!(await confirm({ title: `Send ${sig} to PID ${p.pid}?`, message: `${p.command} (${p.user})`, confirmLabel: 'Send', danger: sig === 'SIGKILL' }))) return;
    try { await api.post(`${base}/processes/${p.pid}/signal`, { signal: sig }); toast.success(`${sig} sent to ${p.pid}`); setTimeout(refetch, 500); } catch (err) { toast.error(err); }
  };
  const renice = async (p) => {
    const value = window.prompt(`New niceness for PID ${p.pid} (-20 highest priority … 19 lowest)`, '10');
    if (value == null) return;
    try { await api.post(`${base}/processes/${p.pid}/renice`, { niceness: Number(value) }); toast.success(`PID ${p.pid} reniced to ${value}`); refetch(); } catch (err) { toast.error(err); }
  };

  const missing = error && (error.code === 'capability_missing' || error.status === 501);
  if (missing) return <div className="card-body"><CapabilityNotice error={error} onRetry={() => api.post('/system/capabilities/refresh').then(() => refetch()).catch(toast.error)} /></div>;

  return (
    <DataTable
      columns={[
        { key: 'pid', label: 'PID', width: 80 },
        { key: 'user', label: 'User' },
        { key: 'cpuPercent', label: 'CPU %', align: 'right', render: (p) => p.cpuPercent.toFixed(1) },
        { key: 'memPercent', label: 'Mem %', align: 'right', render: (p) => p.memPercent.toFixed(1) },
        { key: 'rssBytes', label: 'RSS', align: 'right', render: (p) => formatBytes(p.rssBytes) },
        { key: 'elapsedSeconds', label: 'Running', render: (p) => formatDuration(p.elapsedSeconds) },
        { key: 'state', label: 'State', width: 70 },
        { key: 'command', label: 'Command', render: (p) => <><code>{p.command}</code> <small className="muted">{p.args}</small></> },
      ]}
      rows={data || []} loading={loading} error={error} rowKey={(p) => p.pid} dense
      rowActions={manage ? (p) => [{ label: 'Kill', primary: true, danger: true, onClick: () => signal(p, 'SIGTERM') }, { label: 'Force kill (SIGKILL)', danger: true, onClick: () => signal(p, 'SIGKILL') }, { label: 'Renice', onClick: () => renice(p) }] : undefined}
      toolbar={(
        <>
          <Select value={sort} onChange={setSort} options={[{ value: 'cpu', label: 'Sort by CPU' }, { value: 'mem', label: 'Sort by memory' }, { value: 'time', label: 'Sort by run time' }, { value: 'pid', label: 'Sort by PID' }]} style={{ width: 180 }} />
          <TextInput value={user} onChange={setUser} placeholder="Filter by user" style={{ width: 160 }} />
          <Select value={String(limit)} onChange={(v) => setLimit(Number(v))} options={['50', '200', '500', '2000']} style={{ width: 90 }} />
          <Button onClick={() => refetch()}>Refresh</Button>
        </>
      )}
    />
  );
}
