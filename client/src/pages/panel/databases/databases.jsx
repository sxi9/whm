import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Plus } from 'lucide-react';
import { Card, StatusPill, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { NameField, QuotaStat, RequestError, EngineWarning, JobModal, InfoNote, engineLabel, isCapabilityError, isFeatureDisabled, joinCodes } from './parts/shared.jsx';

const CHARSETS = [{ value: '', label: 'Server default' }, { value: 'utf8mb4', label: 'utf8mb4 (recommended)' }, { value: 'utf8mb3', label: 'utf8mb3' }, { value: 'latin1', label: 'latin1' }];
const CHECK_ACTIONS = { check: 'Check', repair: 'Repair', optimize: 'Optimize' };

export function quotaOf(meta, me) {
  if (meta?.quota) return meta.quota;
  const plan = me?.account?.plan || {};
  const max = plan.max_sql ?? plan.max_db ?? null;
  const used = me?.counts?.databases ?? 0;
  return { max, used, remaining: max == null ? null : Math.max(0, max - used) };
}

export function filterRows(rows, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(needle) || (r.users || []).some((u) => u.toLowerCase().includes(needle)));
}

export default function Databases({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = usePanelMe();
  const { data, meta, loading, error, refetch } = usePanelApi('/databases');
  const [form, setForm] = useState({ name: '', charset: '', collation: '' });
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [job, setJob] = useState(null);
  const username = me?.account?.username || '';
  const prefix = meta?.prefix || `${username}_`;
  const engine = meta?.engine || 'mysql';
  const isPg = engine === 'postgres';
  const quota = quotaOf(meta, me);
  // Server convention (panel-databases create): null is unlimited, 0 means the plan has no databases.
  const notIncluded = quota.max === 0;
  const limitReached = quota.max != null && quota.used >= quota.max;
  const rows = useMemo(() => filterRows(data || [], q), [data, q]);
  const capability = isCapabilityError(error);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null);
    try {
      const body = { name: form.name.trim() };
      if (!isPg && form.charset) body.charset = form.charset;
      if (!isPg && form.collation.trim()) body.collation = form.collation.trim();
      const { data: res } = await panelApi.post('/databases', body);
      toast.success(`Database ${res.name} created`);
      setForm({ name: '', charset: '', collation: '' });
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const drop = async (row) => {
    const ok = await confirm({ title: `Delete ${row.name}?`, message: 'Every table and all data in this database are deleted permanently. Type the database name to confirm.', typeToConfirm: row.name, confirmLabel: 'Delete database', danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/databases/${encodeURIComponent(row.name)}`); toast.success(`${row.name} deleted`); refetch(); } catch (err) { toast.error(err); }
  };

  const check = async (row, action) => {
    try {
      const { data: res } = await panelApi.post(`/databases/${encodeURIComponent(row.name)}/check`, { action });
      setJob({ id: res.job.id, kind: action, database: row.name });
    } catch (err) { toast.error(err); }
  };

  const dump = async (row) => {
    try {
      const { data: res } = await panelApi.post(`/databases/${encodeURIComponent(row.name)}/dump`, {});
      setJob({ id: res.job.id, kind: 'dump', database: row.name });
    } catch (err) { toast.error(err); }
  };

  const onJobFinished = (event) => {
    if (event.type === 'done') {
      toast.success(job?.kind === 'dump' ? `Backup of ${job.database} saved${event.result?.file ? ` as ${event.result.file}` : ''}` : `${CHECK_ACTIONS[job?.kind] || 'Check'} finished for ${job?.database}`);
      setJob((j) => (j ? { ...j, result: event.result } : j));
      refetch();
    } else if (event.type === 'failed') toast.error(event.error || 'The job failed');
  };

  const createDisabled = busy || !form.name || limitReached;

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>Refresh</Button>}>
      <Card>
        <div className="stat-grid">
          <QuotaStat label="Databases" used={quota.used} max={quota.max} noun="databases" />
          <div className="stat"><div className="label">Database server</div><div className="value">{engineLabel(engine)}</div><div className="muted small">{capability ? 'Not installed on this server' : meta?.engineError ? 'Unreachable right now' : 'Connect from your site with host localhost'}</div></div>
          <div className="stat"><div className="label">Name prefix</div><div className="value"><code>{prefix}</code></div><div className="muted small">Every database name on this account starts with it</div></div>
        </div>
      </Card>

      <form onSubmit={create}>
        <Card title="Create a database" subtitle="Choose a short name; the prefix is added for you.">
          <PanelCapabilityState error={isCapabilityError(formError) ? formError : null} />
          <RequestError error={formError} />
          {limitReached && <InfoNote>{notIncluded ? 'Your plan does not include databases. Ask your hosting provider about a plan that includes them.' : `Your plan allows ${quota.max} database${quota.max === 1 ? '' : 's'} and all of them are in use. Delete one you no longer need or ask your hosting provider about a larger plan.`}</InfoNote>}
          <div className="form-grid">
            <NameField id="db-name" label="Database name" prefix={prefix} value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="shop" maxLength={54} error={formError?.fields?.name} disabled={limitReached} />
            {!isPg && (
              <Field label="Character set" help="Leave the default unless your application asks for a specific one" error={formError?.fields?.charset} htmlFor="db-charset">
                <Select id="db-charset" value={form.charset} onChange={(v) => setForm((f) => ({ ...f, charset: v }))} options={CHARSETS} disabled={limitReached} />
              </Field>
            )}
            {!isPg && form.charset && (
              <Field label="Collation" help={`Optional, for example ${form.charset}_unicode_ci`} error={formError?.fields?.collation} htmlFor="db-collation">
                <TextInput id="db-collation" value={form.collation} onChange={(v) => setForm((f) => ({ ...f, collation: v }))} placeholder={`${form.charset}_unicode_ci`} />
              </Field>
            )}
          </div>
          <FormActions>
            <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={createDisabled}>Create database</Button>
            {form.name && <span className="muted small">Creates <code>{prefix}{form.name}</code></span>}
          </FormActions>
        </Card>
      </form>

      <Card title="Databases" subtitle={data?.length ? `${data.length} on this account` : undefined} padded={false}>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        {meta?.engineError && <div className="card-body"><EngineWarning engineError={meta.engineError} /></div>}
        <DataTable
          columns={[
            { key: 'name', label: 'Database', render: (r) => <code>{r.name}</code> },
            { key: 'sizeBytes', label: 'Size', align: 'right', render: (r) => (r.sizeBytes == null ? <span className="muted">—</span> : formatBytes(r.sizeBytes)) },
            { key: 'tables', label: 'Tables', align: 'right', render: (r) => (r.tables ?? <span className="muted">—</span>) },
            { key: 'users', label: 'Users with access', render: (r) => (r.users?.length ? joinCodes(r.users) : <Link to="/panel/databases/users">Add a user</Link>) },
            { key: 'charset', label: 'Character set', render: (r) => (r.charset ? `${r.charset}${r.collation ? ` / ${r.collation}` : ''}` : <span className="muted">—</span>) },
            { key: 'created_at', label: 'Created', render: (r) => (r.created_at ? formatDate(r.created_at) : <span className="muted">—</span>) },
            { key: 'onServer', label: 'State', render: (r) => <StatusPill status={r.onServer === false ? 'failed' : r.onServer == null ? 'unknown' : 'ok'}>{r.onServer === false ? 'missing on server' : r.onServer == null ? 'not checked' : 'ready'}</StatusPill> },
          ]}
          rows={rows} loading={loading} error={capability ? null : error} rowKey={(r) => r.name}
          searchable={Boolean(data?.length)} q={q} onSearch={setQ} searchPlaceholder="Search databases or users"
          rowActions={(r) => [
            { label: 'Check', primary: true, onClick: () => check(r, 'check') },
            { label: 'Repair', onClick: () => check(r, 'repair') },
            { label: 'Optimize', onClick: () => check(r, 'optimize') },
            isPg ? null : { label: 'Download a backup', onClick: () => dump(r) },
            { label: 'Delete', danger: true, onClick: () => drop(r) },
          ]}
          emptyText={capability ? 'Your databases appear here once the database server is available.' : q ? 'No database matches the search.' : 'No databases yet. Create one above; it appears here together with its size and the users that can open it.'}
        />
      </Card>

      <JobModal job={job} title={job ? `${job.kind === 'dump' ? 'Backup of' : `${CHECK_ACTIONS[job.kind]} of`} ${job.database}` : ''} onClose={() => setJob(null)} onFinished={onJobFinished}>
        {job?.kind === 'dump' && !job.result && <p className="muted">The SQL file is written to the <code>backups</code> folder of your home directory.</p>}
        {job?.result?.file && <InfoNote>Saved as <code>{job.result.file}</code>{job.result.sizeBytes != null && <> ({formatBytes(job.result.sizeBytes)})</>}. <Link to="/panel/files/file-manager">Open the file manager</Link> to download it.</InfoNote>}
      </JobModal>
    </PanelPage>
  );
}
