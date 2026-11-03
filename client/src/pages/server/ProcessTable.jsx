import { useState } from 'react';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { DataTable } from '../../components/DataTable.jsx';
import { Select, TextInput, NumberInput, Field, FormActions, Button } from '../../components/Form.jsx';
import { CapabilityNotice, formatBytes, formatDuration } from '../../components/Common.jsx';
import { useToast } from '../../components/Toast.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';

const nowrap = (v) => <span style={{ whiteSpace: 'nowrap' }}>{v}</span>;
const commandCell = (command, args) => (
  <div style={{ maxWidth: 420, wordBreak: 'break-all' }}><code>{command}</code> {args && <small className="muted">{args}</small>}</div>
);

// `base` is the API prefix that serves /processes, /processes/:pid/signal and
// /processes/:pid/renice; the system-health prefix raises capability_missing
// (501) when procps is absent instead of returning an empty list.
export function ProcessTable({ manage = false, base = '/system-health' }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [sort, setSort] = useState('cpu');
  const [user, setUser] = useState('');
  const [limit, setLimit] = useState(200);
  const [renicing, setRenicing] = useState(null);
  const [niceness, setNiceness] = useState(10);
  const [saving, setSaving] = useState(false);
  const { data, loading, error, refetch } = useApi(`${base}/processes${queryString({ sort, user: user || undefined, limit })}`, { refreshMs: manage ? 0 : 10_000 });

  const signal = async (p, sig) => {
    if (!(await confirm({ title: `Send ${sig} to PID ${p.pid}?`, message: `${p.command} (${p.user})`, confirmLabel: 'Send', danger: sig === 'SIGKILL' }))) return;
    try { await api.post(`${base}/processes/${p.pid}/signal`, { signal: sig }); toast.success(`${sig} sent to ${p.pid}`); setTimeout(refetch, 500); } catch (err) { toast.error(err); }
  };
  const niceValid = Number.isInteger(niceness) && niceness >= -20 && niceness <= 19;
  const renice = async () => {
    const p = renicing;
    if (!p || !niceValid) return;
    setSaving(true);
    try { await api.post(`${base}/processes/${p.pid}/renice`, { niceness }); toast.success(`PID ${p.pid} reniced to ${niceness}`); setRenicing(null); refetch(); } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  const missing = error && (error.code === 'capability_missing' || error.status === 501);
  if (missing) return <div className="card-body"><CapabilityNotice error={error} onRetry={() => api.post('/system/capabilities/refresh').then(() => refetch()).catch(toast.error)} /></div>;

  return (
    <>
      <DataTable
        columns={[
          { key: 'pid', label: 'PID', width: 80 },
          { key: 'user', label: 'User' },
          { key: 'cpuPercent', label: 'CPU %', align: 'right', width: 80, render: (p) => nowrap(p.cpuPercent.toFixed(1)) },
          { key: 'memPercent', label: 'Mem %', align: 'right', width: 80, render: (p) => nowrap(p.memPercent.toFixed(1)) },
          { key: 'rssBytes', label: 'RSS', align: 'right', width: 90, render: (p) => nowrap(formatBytes(p.rssBytes)) },
          { key: 'elapsedSeconds', label: 'Running', width: 100, render: (p) => nowrap(formatDuration(p.elapsedSeconds)) },
          { key: 'state', label: 'State', width: 70 },
          { key: 'command', label: 'Command', render: (p) => commandCell(p.command, p.args) },
        ]}
        rows={data || []} loading={loading} error={error} rowKey={(p) => p.pid} dense
        rowActions={manage ? (p) => [{ label: 'Kill', primary: true, danger: true, onClick: () => signal(p, 'SIGTERM') }, { label: 'Force kill (SIGKILL)', danger: true, onClick: () => signal(p, 'SIGKILL') }, { label: 'Renice', onClick: () => { setNiceness(10); setRenicing(p); } }] : undefined}
        toolbar={(
          <>
            <Select value={sort} onChange={setSort} options={[{ value: 'cpu', label: 'Sort by CPU' }, { value: 'mem', label: 'Sort by memory' }, { value: 'time', label: 'Sort by run time' }, { value: 'pid', label: 'Sort by PID' }]} style={{ width: 180 }} />
            <TextInput value={user} onChange={setUser} placeholder="Filter by user" style={{ width: 160 }} />
            <Select value={String(limit)} onChange={(v) => setLimit(Number(v))} options={['50', '200', '500', '2000']} style={{ width: 90 }} />
            <Button onClick={() => refetch()}>Refresh</Button>
          </>
        )}
      />
      <Modal open={Boolean(renicing)} title={renicing ? `Renice PID ${renicing.pid}` : ''} onClose={() => setRenicing(null)} size="sm">
        {renicing && (
          <>
            <p className="muted" style={{ marginTop: 0 }}><code>{renicing.command}</code> ({renicing.user})</p>
            <Field label="Niceness" help="-20 is the highest priority, 19 the lowest. Only root can lower a value." error={niceValid ? undefined : 'Enter a whole number between -20 and 19.'}>
              <NumberInput value={niceness} onChange={setNiceness} min={-20} max={19} step={1} style={{ width: 120 }} />
            </Field>
            <FormActions align="right">
              <Button onClick={() => setRenicing(null)}>Cancel</Button>
              <Button variant="primary" loading={saving} disabled={!niceValid} onClick={renice}>Renice</Button>
            </FormActions>
          </>
        )}
      </Modal>
    </>
  );
}
