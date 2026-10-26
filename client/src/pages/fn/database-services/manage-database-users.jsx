import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, TextInput, PasswordInput, Toggle, Button, FormActions, ErrorBanner, passwordStrength } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm, Modal } from '../../../components/Modal.jsx';
import { EngineBanner, RequestError, AccountSelect, GrantsModal, useDbStatus, useIsRoot } from '../../databases/Shared.jsx';

export default function ManageDatabaseUsers({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const isRoot = useIsRoot();
  const status = useDbStatus();
  const t = useTableState({ sort: 'name' });
  const [showSystem, setShowSystem] = useState(false);
  const { data, meta, loading, error, refetch } = useApi(`/databases/users${queryString({ ...t.state, system: showSystem })}`);
  const { data: dbs } = useApi('/databases/databases?pageSize=500');
  const [form, setForm] = useState({ name: '', password: '', account: '', databases: [], hosts: '' });
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [grantsFor, setGrantsFor] = useState(null);
  const [pwFor, setPwFor] = useState(null);
  const [pw, setPw] = useState('');
  const [pwError, setPwError] = useState(null);
  const engine = status.data?.profile?.engine;
  const prefix = form.account && status.data?.prefixing ? `${form.account}_` : '';
  const grantable = (dbs || []).filter((d) => !d.system && (!form.account || d.account === form.account));

  const create = async (e) => {
    e.preventDefault();
    if (passwordStrength(form.password) < 65) { setFormError({ message: 'Choose a stronger password (minimum strength 65)', fields: { password: ['Too weak'] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const body = { name: form.name.trim().toLowerCase(), password: form.password };
      if (form.account) body.account = form.account;
      if (form.databases.length) body.databases = form.databases;
      if (!form.account && form.hosts.trim()) body.hosts = form.hosts.split(/[\s,]+/).filter(Boolean);
      const { data: res } = await api.post('/databases/users', body);
      toast.success(`User ${res.name} created at ${res.hosts?.length ? res.hosts.join(', ') : 'the server'}`);
      setForm((f) => ({ ...f, name: '', password: '', databases: [] }));
      refetch(); status.refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const drop = async (row) => {
    const ok = await confirm({ title: `Drop user ${row.name}?`, message: `The user is removed at every host (${row.hosts?.join(', ') || 'all'}) together with its privileges. Applications using it will lose access.`, confirmLabel: 'Drop user', danger: true });
    if (!ok) return;
    try { await api.delete(`/databases/users/${encodeURIComponent(row.name)}`); toast.success(`${row.name} dropped`); refetch(); status.refetch(); } catch (err) { toast.error(err); }
  };

  const changePassword = async () => {
    if (passwordStrength(pw) < 65) { setPwError({ message: 'Choose a stronger password (minimum strength 65)' }); return; }
    setBusy(true); setPwError(null);
    try { await api.put(`/databases/users/${encodeURIComponent(pwFor.name)}/password`, { password: pw }); toast.success(`Password changed for ${pwFor.name}`); setPwFor(null); setPw(''); } catch (err) { setPwError(err); } finally { setBusy(false); }
  };

  const toggleDb = (name) => setForm((f) => ({ ...f, databases: f.databases.includes(name) ? f.databases.filter((d) => d !== name) : [...f.databases, name] }));

  return (
    <>
      <PageHeader fn={fn} description="Create database users, set their privileges per database and rotate their passwords. Users created for an account are prefixed with the account name and provisioned at localhost plus every allowed remote access host." actions={<Button onClick={() => { refetch(); status.refetch(); }}>Refresh</Button>} />
      <EngineBanner status={status.data} loading={status.loading} error={status.error} onRetry={status.refetch} />
      <form onSubmit={create}>
        <Card title="Create a database user">
          <RequestError error={formError && !formError.fields ? formError : null} />
          {formError?.fields && <ErrorBanner error={formError} />}
          <div className="form-grid">
            <AccountSelect value={form.account} onChange={(v) => setForm((f) => ({ ...f, account: v, databases: [] }))} label="Owner account" allowNone={isRoot} help={isRoot ? 'Optional for root: an unassigned user is server-wide' : undefined} />
            <Field label="User name" required error={formError?.fields?.name} help={prefix ? `Will be created as ${prefix}${form.name || '…'}` : 'Lowercase letters, digits and underscores'}>
              <div className="input-group">{prefix && <span className="btn" style={{ pointerEvents: 'none' }}>{prefix}</span>}<TextInput value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="app" /></div>
            </Field>
            <Field label="Password" required error={formError?.fields?.password}><PasswordInput value={form.password} onChange={(v) => setForm((f) => ({ ...f, password: v }))} /></Field>
            {isRoot && !form.account && engine !== 'postgres' && <Field label="Hosts" help="Comma-separated; blank means localhost only" error={formError?.fields?.hosts}><TextInput value={form.hosts} onChange={(v) => setForm((f) => ({ ...f, hosts: v }))} placeholder="localhost, 203.0.113.%" /></Field>}
          </div>
          <Field label="Grant ALL PRIVILEGES on" help={grantable.length ? 'Fine-tune privileges afterwards with "Privileges"' : form.account ? 'This account has no databases yet' : 'Select an account to see its databases'}>
            <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {grantable.map((d) => <label key={d.name} className="radio"><input type="checkbox" checked={form.databases.includes(d.name)} onChange={() => toggleDb(d.name)} /><span><strong><code>{d.name}</code></strong></span></label>)}
            </div>
          </Field>
          <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!form.name || !form.password || (!isRoot && !form.account)}>Create user</Button></FormActions>
        </Card>
      </form>
      <Card title="Database users" padded={false}>
        <DataTable
          columns={[
            { key: 'name', label: 'User', sortable: true, render: (r) => <><code>{r.name}</code>{r.system && <StatusPill status="info"> system</StatusPill>}</> },
            { key: 'account', label: 'Account', sortable: true, render: (r) => (r.account ? r.account : <span className="muted">{isRoot ? <Link to="/database-services/database-map-tool">unmapped</Link> : '—'}</span>) },
            { key: 'hosts', label: 'Hosts', render: (r) => (r.hosts?.length ? r.hosts.map((h) => <code key={h} style={{ marginRight: 6 }}>{h}</code>) : <span className="muted">—</span>) },
            { key: 'grants', label: 'Privileges', render: (r) => (r.grants?.length ? r.grants.map((g) => <div key={g.database}><code>{g.database}</code> <span className="muted">{g.privileges.join(', ')}</span></div>) : <span className="muted">{r.mapped ? 'none recorded' : '—'}</span>) },
            { key: 'onServer', label: 'State', render: (r) => <StatusPill status={r.onServer === false ? 'failed' : r.onServer === null ? 'unknown' : 'ok'}>{r.onServer === false ? 'missing on server' : r.onServer === null ? 'server unreachable' : 'present'}</StatusPill> },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(r) => r.name}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search users or accounts"
          toolbar={isRoot && <Toggle checked={showSystem} onChange={setShowSystem} label="Show system users" />}
          rowActions={(r) => (r.system ? [] : [
            { label: 'Privileges', primary: true, onClick: () => setGrantsFor(r) },
            { label: 'Change password', onClick: () => { setPwFor(r); setPw(''); setPwError(null); } },
            { label: 'Drop', danger: true, onClick: () => drop(r) },
          ])}
          emptyText={error ? 'Could not load users.' : 'No database users yet.'}
        />
        {meta?.engineError && <div className="card-body"><div className="banner banner-warning"><div><strong>Server unreachable</strong><p>{meta.engineError.message} Showing the panel's records only.</p></div></div></div>}
      </Card>
      <GrantsModal user={grantsFor} engine={engine} onClose={() => setGrantsFor(null)} onSaved={(res) => { toast.success(`Privileges saved for ${res.name} (${res.changes.length} change${res.changes.length === 1 ? '' : 's'})`); refetch(); }} />
      <Modal open={Boolean(pwFor)} title={`Change password for ${pwFor?.name}`} onClose={() => setPwFor(null)} size="sm" footer={<><Button onClick={() => setPwFor(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={changePassword} disabled={!pw}>Change password</Button></>}>
        <ErrorBanner error={pwError} />
        <Field label="New password" required><PasswordInput value={pw} onChange={setPw} /></Field>
        <p className="muted">Applied at every host the user exists at. Update the application configuration afterwards.</p>
      </Modal>
    </>
  );
}
