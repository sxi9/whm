import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError } from '../../server-configuration/Shared.jsx';

const ROLES = [['dns', 'DNS'], ['mail', 'Mail'], ['database', 'Database'], ['web', 'Web'], ['backup', 'Backup']];
const EMPTY = { name: '', hostname: '', port: 2087, scheme: 'https', username: 'root', token: '', verifyTls: true, roles: [], enabled: true };

function NodeForm({ initial, onSubmit, onCancel, busy, error, editing }) {
  const [form, setForm] = useState(initial);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleRole = (r) => setForm((f) => ({ ...f, roles: f.roles.includes(r) ? f.roles.filter((x) => x !== r) : [...f.roles, r] }));
  const fields = error?.fields || {};
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}>
      <ErrorBanner error={error && !error.fields ? error : null} />
      <div className="form-grid">
        <Field label="Name" required error={fields.name}><TextInput value={form.name} onChange={set('name')} placeholder="dns-node-2" /></Field>
        <Field label="Hostname or IP" required error={fields.hostname}><TextInput value={form.hostname} onChange={set('hostname')} placeholder="node2.example.com" /></Field>
        <Field label="Scheme" error={fields.scheme}><Select value={form.scheme} onChange={set('scheme')} options={[{ value: 'https', label: 'https (recommended)' }, { value: 'http', label: 'http (trusted network only)' }]} /></Field>
        <Field label="Port" error={fields.port}><NumberInput value={form.port} onChange={set('port')} min={1} max={65535} nullable={false} /></Field>
        <Field label="Remote username" help="The administrator who issued the token" error={fields.username}><TextInput value={form.username} onChange={set('username')} /></Field>
        <Field label={editing ? 'New API token (leave empty to keep)' : 'API token'} required={!editing} help="Created on the remote panel under Development › Manage API Tokens; stored encrypted and never shown again" error={fields.token}><TextInput type="password" value={form.token} onChange={set('token')} autoComplete="off" /></Field>
      </div>
      <Field label="Roles this node serves" error={fields.roles}>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 10 }}>
          {ROLES.map(([value, label]) => <label key={value} className="radio" style={{ cursor: 'pointer' }}><input type="checkbox" checked={form.roles.includes(value)} onChange={() => toggleRole(value)} /><span><strong>{label}</strong></span></label>)}
        </div>
      </Field>
      <Field inline><Toggle checked={form.verifyTls} onChange={set('verifyTls')} label="Verify the TLS certificate" description="Turn off only for a panel that still uses its self-signed certificate." disabled={form.scheme !== 'https'} /></Field>
      <Field inline><Toggle checked={form.enabled} onChange={set('enabled')} label="Enabled" description="Disabled nodes are kept but not offered to features that distribute work." /></Field>
      <FormActions>
        <Button type="submit" variant="primary" loading={busy}>{editing ? 'Save changes' : 'Link node'}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </FormActions>
    </form>
  );
}

export default function LinkServerNodes({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/server-config/nodes');
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [testing, setTesting] = useState(null);
  const [lastTest, setLastTest] = useState(null);

  const submit = async (form) => {
    setBusy(true); setFormError(null);
    const body = { ...form };
    if (modal.node && !body.token) delete body.token;
    try {
      if (modal.node) { await api.put(`/server-config/nodes/${modal.node.id}`, body); toast.success(`Node "${form.name}" updated`); } else { await api.post('/server-config/nodes', body); toast.success(`Node "${form.name}" linked`); }
      setModal(null); refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };
  const test = async (node) => {
    setTesting(node.id);
    try { const { data: d } = await api.post(`/server-config/nodes/${node.id}/test`); setLastTest(d); if (d.test.ok) toast.success(`${node.name}: connected in ${d.test.ms} ms`); else toast.error(`${node.name}: ${d.test.error}`); refetch(); } catch (err) { toast.error(err); } finally { setTesting(null); }
  };
  const remove = async (node) => {
    if (!(await confirm({ title: `Unlink ${node.name}?`, message: 'The stored token is deleted. Nothing changes on the remote server.', confirmLabel: 'Unlink', danger: true }))) return;
    try { await api.delete(`/server-config/nodes/${node.id}`); toast.success(`Node "${node.name}" unlinked`); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Register other panel servers this one can hand work to: DNS cluster members, remote mail or database nodes and backup targets. Each link stores an API token for the remote panel; Test connection calls its status endpoint." actions={<Button variant="primary" onClick={() => { setFormError(null); setModal({ node: null }); }}>Link a server node</Button>} />
      <RequestError error={error} onRetry={refetch} />
      <Card padded={false}>
        <DataTable
          rows={data || []} loading={loading} rowKey={(n) => n.id} emptyText="No linked nodes yet. Link a server node to get started."
          columns={[
            { key: 'name', label: 'Node', render: (n) => <><strong>{n.name}</strong>{!n.enabled && <> <StatusPill status="disabled">disabled</StatusPill></>}<br /><small className="muted"><code>{n.scheme}://{n.hostname}:{n.port}</code> as {n.username}</small></> },
            { key: 'roles', label: 'Roles', render: (n) => (n.roles.length ? n.roles.map((r) => <span key={r} className="pill pill-info" style={{ marginRight: 4 }}>{r}</span>) : <span className="muted">—</span>) },
            { key: 'status', label: 'Connection', render: (n) => <><StatusPill status={n.status === 'ok' ? 'ok' : n.status === 'error' ? 'failed' : 'unknown'}>{n.status === 'ok' ? 'reachable' : n.status === 'error' ? 'failed' : 'untested'}</StatusPill>{n.lastError && <><br /><small className="muted">{n.lastError}</small></>}</> },
            { key: 'remote', label: 'Remote panel', render: (n) => (n.remote ? <>{n.remote.hostname}<br /><small className="muted">v{n.remote.version} · {n.remote.profile || 'standard'} · {n.remote.accounts ?? '?'} accounts</small></> : <span className="muted">unknown until tested</span>) },
            { key: 'lastCheckedAt', label: 'Last tested', render: (n) => formatDate(n.lastCheckedAt) },
            { key: 'hasToken', label: 'Token', render: (n) => <StatusPill status={n.hasToken ? 'ok' : 'warning'}>{n.hasToken ? 'stored (encrypted)' : 'missing'}</StatusPill> },
          ]}
          rowActions={(n) => [
            { label: testing === n.id ? 'Testing…' : 'Test connection', primary: true, disabled: testing === n.id, onClick: () => test(n) },
            { label: 'Edit', onClick: () => { setFormError(null); setModal({ node: n }); } },
            { label: 'Unlink', danger: true, onClick: () => remove(n) },
          ]}
        />
      </Card>
      {lastTest && (
        <Card title={`Last test: ${lastTest.name}`} subtitle={lastTest.test.ok ? `connected in ${lastTest.test.ms} ms` : lastTest.test.error}>
          {lastTest.test.ok ? <pre className="log">{JSON.stringify(lastTest.remote, null, 2)}</pre> : <ErrorBanner error={{ message: lastTest.test.error }} />}
        </Card>
      )}
      <Modal open={Boolean(modal)} title={modal?.node ? `Edit ${modal.node.name}` : 'Link a server node'} onClose={() => setModal(null)} size="lg">
        {modal && <NodeForm key={modal.node?.id ?? 'new'} editing={Boolean(modal.node)} initial={modal.node ? { ...EMPTY, ...modal.node, token: '' } : EMPTY} onSubmit={submit} onCancel={() => setModal(null)} busy={busy} error={formError} />}
      </Modal>
    </>
  );
}
