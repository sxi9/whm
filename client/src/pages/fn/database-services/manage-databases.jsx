import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatBytes } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, TextInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { EngineBanner, RequestError, AccountSelect, useDbStatus, useIsRoot } from '../../databases/Shared.jsx';

export default function ManageDatabases({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const isRoot = useIsRoot();
  const status = useDbStatus();
  const t = useTableState({ sort: 'name' });
  const [filterAccount, setFilterAccount] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const { data, meta, loading, error, refetch } = useApi(`/databases/databases${queryString({ ...t.state, account: filterAccount, system: showSystem })}`);
  const [form, setForm] = useState({ name: '', account: '' });
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const engine = status.data?.profile?.engine;
  const prefix = form.account && status.data?.prefixing ? `${form.account}_` : '';

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null);
    try {
      const body = { name: form.name.trim().toLowerCase() };
      if (form.account) body.account = form.account;
      const { data: res } = await api.post('/databases/databases', body);
      toast.success(`Database ${res.name} created${res.account ? ` for ${res.account}` : ''}`);
      setForm((f) => ({ ...f, name: '' }));
      refetch(); status.refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const drop = async (row) => {
    const ok = await confirm({ title: `Drop database ${row.name}?`, message: 'Every table and all data in this database are deleted permanently. Type the database name to confirm.', typeToConfirm: row.name, confirmLabel: 'Drop database', danger: true });
    if (!ok) return;
    try { await api.delete(`/databases/databases/${encodeURIComponent(row.name)}`); toast.success(`${row.name} dropped`); refetch(); status.refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Create and drop databases on the active database server. Databases created for an account are prefixed with the account name (cPanel style) and count against the package's database limit." actions={<Button onClick={() => { refetch(); status.refetch(); }}>Refresh</Button>} />
      <EngineBanner status={status.data} loading={status.loading} error={status.error} onRetry={status.refetch} />
      <form onSubmit={create}>
        <Card title="Create a database">
          <RequestError error={formError} />
          <div className="form-grid">
            <AccountSelect value={form.account} onChange={(v) => setForm((f) => ({ ...f, account: v }))} label="Owner account" allowNone={isRoot} help={isRoot ? 'Optional for root: an unassigned database is server-wide' : undefined} />
            <Field label="Database name" required error={formError?.fields?.name} help={prefix ? `Will be created as ${prefix}${form.name || '…'}` : 'Lowercase letters, digits and underscores'}>
              <div className="input-group">{prefix && <span className="btn" style={{ pointerEvents: 'none' }}>{prefix}</span>}<TextInput value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="shop" /></div>
            </Field>
          </div>
          <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!form.name || (!isRoot && !form.account)}>Create database</Button></FormActions>
        </Card>
      </form>
      <Card title="Databases" padded={false}>
        <DataTable
          columns={[
            { key: 'name', label: 'Database', sortable: true, render: (r) => <><code>{r.name}</code>{r.system && <StatusPill status="info"> system</StatusPill>}</> },
            { key: 'account', label: 'Account', sortable: true, render: (r) => (r.account ? <Link to={`/account-information/list-accounts?q=${r.account}`}>{r.account}</Link> : <span className="muted">{isRoot ? <Link to="/database-services/database-map-tool">unmapped</Link> : '—'}</span>) },
            { key: 'users', label: 'Users with access', render: (r) => (r.users?.length ? r.users.map((u) => <code key={u} style={{ marginRight: 6 }}>{u}</code>) : <span className="muted">none</span>) },
            { key: 'sizeBytes', label: 'Size', sortable: true, align: 'right', render: (r) => (r.sizeBytes == null ? '—' : formatBytes(r.sizeBytes)) },
            { key: 'tables', label: 'Tables', align: 'right', render: (r) => r.tables ?? '—' },
            { key: 'charset', label: 'Charset', render: (r) => (r.charset ? `${r.charset}${r.collation ? ` / ${r.collation}` : ''}` : '—') },
            { key: 'onServer', label: 'State', render: (r) => <StatusPill status={r.onServer === false ? 'failed' : r.onServer === null ? 'unknown' : 'ok'}>{r.onServer === false ? 'missing on server' : r.onServer === null ? 'server unreachable' : 'present'}</StatusPill> },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(r) => r.name}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search databases or accounts"
          toolbar={isRoot && <Toggle checked={showSystem} onChange={setShowSystem} label="Show system databases" />}
          rowActions={(r) => [r.system ? null : { label: 'Drop', primary: true, danger: true, onClick: () => drop(r) }]}
          emptyText={error ? 'Could not load databases.' : 'No databases yet.'}
        />
        {meta?.engineError && <div className="card-body"><div className="banner banner-warning"><div><strong>Server unreachable</strong><p>{meta.engineError.message} Showing the panel's records only.</p></div></div></div>}
        {engine === 'postgres' && <div className="card-body muted">PostgreSQL profile: databases are created with the account's user as owner once a user is granted ALL PRIVILEGES.</div>}
      </Card>
    </>
  );
}
