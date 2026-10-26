import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Select, PasswordInput, Button, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm, Modal } from '../../../components/Modal.jsx';
import { RequestError, engineLabel } from '../../databases/Shared.jsx';

const EMPTY = { profile_name: '', engine: 'mariadb', host: 'localhost', port: null, admin_user: '', admin_password: '' };

export default function ManageDatabaseProfiles({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/databases/profiles');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(form.host.trim());

  const open = (profile) => {
    setEditing(profile || 'new');
    setForm(profile ? { profile_name: profile.profile_name, engine: profile.engine, host: profile.host, port: profile.port, admin_user: profile.admin_user || '', admin_password: '' } : EMPTY);
    setFormError(null);
  };

  const save = async () => {
    setBusy('save'); setFormError(null);
    try {
      const body = { profile_name: form.profile_name.trim(), engine: form.engine, host: form.host.trim().toLowerCase(), port: form.port || null, admin_user: form.admin_user.trim() || null };
      if (form.admin_password) body.admin_password = form.admin_password;
      if (editing === 'new') { if (!body.admin_password && body.admin_user) body.admin_password = null; await api.post('/databases/profiles', body); toast.success(`Profile ${body.profile_name} created`); }
      else { await api.put(`/databases/profiles/${editing.id}`, body); toast.success(`Profile ${body.profile_name} saved`); }
      setEditing(null);
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(null); }
  };

  const test = async (p) => {
    setBusy(`test:${p.id}`);
    try { const { data: res } = await api.post(`/databases/profiles/${p.id}/test`); if (res.ok) toast.success(`${p.profile_name}: connected as ${res.user} (${res.version})`); else toast.error(`${p.profile_name}: ${res.error}`); refetch(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const activate = async (p) => {
    const ok = await confirm({ title: `Activate ${p.profile_name}?`, message: 'Every database function (create, grants, processes, repair…) will run against this server from now on.', confirmLabel: 'Activate' });
    if (!ok) return;
    try { await api.post(`/databases/profiles/${p.id}/activate`); toast.success(`${p.profile_name} is now the active profile`); refetch(); } catch (err) { toast.error(err); }
  };
  const remove = async (p) => {
    const ok = await confirm({ title: `Delete profile ${p.profile_name}?`, message: 'Only the panel\'s connection profile is removed; the database server and its data are untouched.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try { await api.delete(`/databases/profiles/${p.id}`); toast.success(`${p.profile_name} deleted`); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Connection profiles for local and remote database servers. The active profile is the server every database function uses. Credentials are stored encrypted; the local profile may leave them blank to use /root/.my.cnf or socket authentication." actions={<><Button onClick={() => refetch()}>Refresh</Button><Button variant="primary" onClick={() => open(null)}>Add profile</Button></>} />
      <RequestError error={error} onRetry={refetch} />
      <Card title="Profiles" padded={false}>
        <DataTable
          columns={[
            { key: 'profile_name', label: 'Profile', render: (p) => <><strong>{p.profile_name}</strong>{p.is_active && <StatusPill status="ok"> active</StatusPill>}</> },
            { key: 'engine', label: 'Engine', render: (p) => engineLabel(p.engine) },
            { key: 'host', label: 'Server', render: (p) => <><code>{p.host}:{p.port}</code> <span className="muted">{p.is_local ? 'local' : 'remote'}</span></> },
            { key: 'admin_user', label: 'Credentials', render: (p) => (p.admin_user ? <>{p.admin_user} <StatusPill status={p.has_password ? 'ok' : 'warning'}>{p.has_password ? 'password stored' : 'no password'}</StatusPill></> : <span className="muted">/root/.my.cnf or socket</span>) },
            { key: 'status', label: 'Last test', render: (p) => (p.status ? <><StatusPill status={p.status.ok ? 'ok' : 'failed'}>{p.status.ok ? 'reachable' : 'failed'}</StatusPill> <span className="muted">{p.status.version || p.status.message} · {formatDate(p.status.tested_at)}</span></> : <span className="muted">never tested</span>) },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(p) => p.id}
          rowActions={(p) => [
            { label: busy === `test:${p.id}` ? 'Testing…' : 'Test connection', primary: true, onClick: () => test(p), disabled: busy === `test:${p.id}` },
            !p.is_active && { label: 'Activate', onClick: () => activate(p) },
            { label: 'Edit', onClick: () => open(p) },
            !p.is_active && { label: 'Delete', danger: true, onClick: () => remove(p) },
          ]}
          emptyText="No profiles. Add one to start managing databases."
        />
      </Card>
      <Modal open={Boolean(editing)} title={editing === 'new' ? 'Add database profile' : `Edit ${editing?.profile_name}`} onClose={() => setEditing(null)}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" loading={busy === 'save'} onClick={save} disabled={!form.profile_name || !form.host}>{editing === 'new' ? 'Create profile' : 'Save'}</Button></>}>
        <ErrorBanner error={formError} />
        <div className="form-grid">
          <Field label="Profile name" required error={formError?.fields?.profile_name}><TextInput value={form.profile_name} onChange={set('profile_name')} placeholder="Primary MariaDB" /></Field>
          <Field label="Engine" required><Select value={form.engine} onChange={set('engine')} options={[{ value: 'mariadb', label: 'MariaDB' }, { value: 'mysql', label: 'MySQL' }, { value: 'postgres', label: 'PostgreSQL' }]} /></Field>
          <Field label="Host" required error={formError?.fields?.host} help="localhost uses the Unix socket; anything else connects over TCP"><TextInput value={form.host} onChange={set('host')} /></Field>
          <Field label="Port" help={`Blank = ${form.engine === 'postgres' ? 5432 : 3306}`} error={formError?.fields?.port}><NumberInput value={form.port} onChange={set('port')} min={1} max={65535} /></Field>
          <Field label="Admin user" required={!isLocalHost} error={formError?.fields?.admin_user} help={isLocalHost ? 'Blank uses /root/.my.cnf or socket authentication' : 'A user with CREATE USER / GRANT OPTION on the remote server'}><TextInput value={form.admin_user} onChange={set('admin_user')} placeholder={form.engine === 'postgres' ? 'postgres' : 'root'} /></Field>
          <Field label="Admin password" error={formError?.fields?.admin_password} help={editing !== 'new' ? 'Leave blank to keep the stored password' : 'Stored encrypted (AES-256-GCM)'}><PasswordInput value={form.admin_password} onChange={set('admin_password')} showStrength={false} allowGenerate={false} /></Field>
        </div>
      </Modal>
    </>
  );
}
