import { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../../api/client.js';
import { Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { PeerForm } from './PeerForm.jsx';

// Peers are shared by both cluster pages; `focus` only changes which columns
// matter and the default role for a new peer.
export function PeerTable({ peers, roles, loading, onChanged, focus = 'dns', title = 'Cluster peers', subtitle }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [testing, setTesting] = useState(null);

  const save = async (body) => {
    setSaving(true);
    setFormError(null);
    try {
      if (editing?.id) { await api.patch(`/clusters/peers/${editing.id}`, body); toast.success(`${body.name} updated`); } else { await api.post('/clusters/peers', body); toast.success(`${body.name} added`); }
      setEditing(null);
      onChanged?.();
    } catch (err) { setFormError(err); } finally { setSaving(false); }
  };

  const test = async (p) => {
    setTesting(p.id);
    try {
      const { data } = await api.post(`/clusters/peers/${p.id}/test`);
      if (data.test.ok) toast.success(`${p.name} answered in ${data.test.ms} ms${data.test.remote?.hostname ? ` as ${data.test.remote.hostname}` : ''}${data.test.remote?.clusterAware === false ? ' (older panel without the Clusters module)' : ''}`);
      else toast.error(`${p.name}: ${data.test.error}`, { timeout: 12_000 });
    } catch (err) { toast.error(err); } finally { setTesting(null); onChanged?.(); }
  };

  const toggle = async (p, key, label) => {
    try { await api.patch(`/clusters/peers/${p.id}`, { [key]: !p[key] }); toast.success(`${p.name}: ${label} ${p[key] ? 'off' : 'on'}`); onChanged?.(); } catch (err) { toast.error(err); }
  };

  const remove = async (p) => {
    if (!(await confirm({ title: `Remove ${p.name}?`, message: `${p.host} is forgotten by both the DNS and the configuration cluster. Zones already pushed to it stay there; nothing is deleted on the peer.`, confirmLabel: 'Remove', danger: true }))) return;
    try { await api.delete(`/clusters/peers/${p.id}`); toast.success(`${p.name} removed`); onChanged?.(); } catch (err) { toast.error(err); }
  };

  const columns = [
    { key: 'name', label: 'Peer', render: (p) => <><strong>{p.name}</strong>{!p.enabled && <> <StatusPill status="disabled">disabled</StatusPill></>}<br /><code style={{ fontSize: 12 }}>{p.host}</code></> },
    { key: 'status', label: 'Reachable', render: (p) => (p.status === 'unknown' ? <span className="muted">not tested</span> : <span title={p.lastError || ''}><StatusPill status={p.status === 'ok' ? 'ok' : 'failed'}>{p.status === 'ok' ? 'yes' : 'no'}</StatusPill> <small className="muted">{formatDate(p.lastCheckedAt)}</small>{p.lastError && <><br /><small className="muted">{p.lastError.slice(0, 80)}</small></>}</span>) },
  ];
  if (focus === 'dns') {
    columns.push(
      { key: 'role', label: 'DNS role', render: (p) => <StatusPill status={p.role === 'standalone' ? 'disabled' : 'info'}>{p.role}</StatusPill> },
      { key: 'zones', label: 'Zones pushed', render: (p) => (p.role === 'standalone' ? <span className="muted">—</span> : <>{p.zones.ok} ok{p.zones.failed ? <>, <span style={{ color: 'var(--bad)' }}>{p.zones.failed} failed</span></> : null}<br /><small className="muted">{formatDate(p.lastSyncAt)}</small></>) },
    );
  } else {
    columns.push(
      { key: 'configEnabled', label: 'Receives config', render: (p) => <StatusPill status={p.configEnabled ? 'enabled' : 'disabled'}>{p.configEnabled ? 'yes' : 'no'}</StatusPill> },
      { key: 'remote', label: 'Peer panel', render: (p) => (p.remote ? <>{p.remote.hostname || '—'}{p.remote.version && <small className="muted"> v{p.remote.version}</small>}{p.remote.clusterAware === false && <><br /><small className="muted">no Clusters module</small></>}{p.remote.accepts && !p.remote.accepts.config && <><br /><small style={{ color: 'var(--warn)' }}>does not accept config pushes</small></>}</> : <span className="muted">—</span>) },
    );
  }
  columns.push({ key: 'hasToken', label: 'Token', render: (p) => <StatusPill status={p.hasToken ? 'ok' : 'warning'}>{p.hasToken ? 'set' : 'missing'}</StatusPill> });

  return (
    <>
      <Card title={title} subtitle={subtitle} padded={false} actions={<Button variant="primary" icon={Plus} size="sm" onClick={() => { setFormError(null); setEditing({}); }}>Add peer</Button>}>
        <DataTable dense rows={peers || []} loading={loading} rowKey={(p) => p.id} columns={columns}
          emptyText="No peers yet. Add another server running this panel, with an API token it issued."
          rowActions={(p) => [
            { label: testing === p.id ? 'Testing…' : 'Test', primary: true, disabled: testing != null, onClick: () => test(p) },
            { label: 'Edit', onClick: () => { setFormError(null); setEditing(p); } },
            focus === 'config' ? { label: p.configEnabled ? 'Stop sharing config' : 'Share config', onClick: () => toggle(p, 'configEnabled', 'configuration cluster') } : null,
            { label: p.enabled ? 'Disable' : 'Enable', onClick: () => toggle(p, 'enabled', 'peer') },
            { label: 'Remove', danger: true, onClick: () => remove(p) },
          ]}
        />
      </Card>
      <Modal open={Boolean(editing)} title={editing?.id ? `Edit ${editing.name}` : 'Add a cluster peer'} onClose={() => setEditing(null)} size="lg">
        {editing && <PeerForm key={editing.id || 'new'} initial={editing.id ? editing : undefined} roles={roles || ['write-only', 'sync', 'standalone']} saving={saving} error={formError} onSubmit={save} onCancel={() => setEditing(null)} focus={focus} />}
      </Modal>
    </>
  );
}
