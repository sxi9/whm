import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Plus } from 'lucide-react';
import { Card, StatusPill, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, plural } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { NameField, QuotaStat, RequestError, EngineWarning, JobModal, InfoNote, engineLabel, isCapabilityError, isFeatureDisabled, joinCodes } from './parts/shared.jsx';

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
  const { t } = useT();
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
  const checkLabel = (kind) => t(`panel.databases.action_${kind}`, CHECK_ACTIONS[kind] || 'Check');
  const charsets = [{ value: '', label: t('panel.databases.charset_default', 'Server default') }, { value: 'utf8mb4', label: t('panel.databases.charset_utf8mb4', 'utf8mb4 (recommended)') }, { value: 'utf8mb3', label: 'utf8mb3' }, { value: 'latin1', label: 'latin1' }];

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null);
    try {
      const body = { name: form.name.trim() };
      if (!isPg && form.charset) body.charset = form.charset;
      if (!isPg && form.collation.trim()) body.collation = form.collation.trim();
      const { data: res } = await panelApi.post('/databases', body);
      toast.success(fill(t('panel.databases.created', 'Database {name} created'), { name: res.name }));
      setForm({ name: '', charset: '', collation: '' });
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const drop = async (row) => {
    const ok = await confirm({ title: fill(t('panel.databases.delete_title', 'Delete {name}?'), { name: row.name }), message: t('panel.databases.delete_message', 'Every table and all data in this database are deleted permanently. Type the database name to confirm.'), typeToConfirm: row.name, confirmLabel: t('panel.databases.delete_confirm', 'Delete database'), danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/databases/${encodeURIComponent(row.name)}`); toast.success(fill(t('panel.databases.deleted', '{name} deleted'), { name: row.name })); refetch(); } catch (err) { toast.error(err); }
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
      toast.success(job?.kind === 'dump'
        ? fill(t('panel.databases.backup_saved', 'Backup of {database} saved'), { database: job.database }) + (event.result?.file ? ` ${fill(t('panel.databases.backup_saved_as', 'as {file}'), { file: event.result.file })}` : '')
        : fill(t('panel.databases.check_finished', '{action} finished for {database}'), { action: checkLabel(job?.kind), database: job?.database }));
      setJob((j) => (j ? { ...j, result: event.result } : j));
      refetch();
    } else if (event.type === 'failed') toast.error(event.error || t('panel.databases.job_failed', 'The job failed'));
  };

  const createDisabled = busy || !form.name || limitReached;

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      <Card>
        <div className="stat-grid">
          <QuotaStat label={t('panel.databases.databases', 'Databases')} used={quota.used} max={quota.max} noun={t('panel.databases.noun', 'databases')} />
          <div className="stat"><div className="label">{t('panel.databases.engine', 'Database server')}</div><div className="value">{engineLabel(engine)}</div><div className="muted small">{capability ? t('panel.databases.engine_missing', 'Not installed on this server') : meta?.engineError ? t('panel.databases.engine_down', 'Unreachable right now') : t('panel.databases.engine_connect', 'Connect from your site with host localhost')}</div></div>
          <div className="stat"><div className="label">{t('panel.databases.prefix', 'Name prefix')}</div><div className="value"><code>{prefix}</code></div><div className="muted small">{t('panel.databases.prefix_help', 'Every database name on this account starts with it')}</div></div>
        </div>
      </Card>

      <form onSubmit={create}>
        <Card title={t('panel.databases.create_title', 'Create a database')} subtitle={t('panel.databases.create_subtitle', 'Choose a short name; the prefix is added for you.')}>
          <PanelCapabilityState error={isCapabilityError(formError) ? formError : null} />
          <RequestError error={formError} />
          {limitReached && <InfoNote>{notIncluded ? t('panel.databases.plan_none', 'Your plan does not include databases. Ask your hosting provider about a plan that includes them.') : plural(t, 'panel.databases.plan_full', quota.max, 'Your plan allows {count} database and all of them are in use. Delete one you no longer need or ask your hosting provider about a larger plan.', 'Your plan allows {count} databases and all of them are in use. Delete one you no longer need or ask your hosting provider about a larger plan.')}</InfoNote>}
          <div className="form-grid">
            <NameField id="db-name" label={t('panel.databases.name', 'Database name')} prefix={prefix} value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="shop" maxLength={54} error={formError?.fields?.name} disabled={limitReached} />
            {!isPg && (
              <Field label={t('panel.databases.charset', 'Character set')} help={t('panel.databases.charset_help', 'Leave the default unless your application asks for a specific one')} error={formError?.fields?.charset} htmlFor="db-charset">
                <Select id="db-charset" value={form.charset} onChange={(v) => setForm((f) => ({ ...f, charset: v }))} options={charsets} disabled={limitReached} />
              </Field>
            )}
            {!isPg && form.charset && (
              <Field label={t('panel.databases.collation', 'Collation')} help={fill(t('panel.databases.collation_help', 'Optional, for example {example}'), { example: `${form.charset}_unicode_ci` })} error={formError?.fields?.collation} htmlFor="db-collation">
                <TextInput id="db-collation" value={form.collation} onChange={(v) => setForm((f) => ({ ...f, collation: v }))} placeholder={`${form.charset}_unicode_ci`} />
              </Field>
            )}
          </div>
          <FormActions>
            <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={createDisabled}>{t('panel.databases.create_button', 'Create database')}</Button>
            {form.name && <span className="muted small">{t('panel.databases.creates', 'Creates')} <code>{prefix}{form.name}</code></span>}
          </FormActions>
        </Card>
      </form>

      <Card title={t('panel.databases.databases', 'Databases')} subtitle={data?.length ? fill(t('panel.databases.count_on_account', '{count} on this account'), { count: data.length }) : undefined} padded={false}>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        {meta?.engineError && <div className="card-body"><EngineWarning engineError={meta.engineError} /></div>}
        <DataTable
          columns={[
            { key: 'name', label: t('panel.databases.col_database', 'Database'), render: (r) => <code>{r.name}</code> },
            { key: 'sizeBytes', label: t('panel.databases.col_size', 'Size'), align: 'right', render: (r) => (r.sizeBytes == null ? <span className="muted">—</span> : formatBytes(r.sizeBytes)) },
            { key: 'tables', label: t('panel.databases.col_tables', 'Tables'), align: 'right', render: (r) => (r.tables ?? <span className="muted">—</span>) },
            { key: 'users', label: t('panel.databases.col_users', 'Users with access'), render: (r) => (r.users?.length ? joinCodes(r.users, t('panel.databases.none', 'none')) : <Link to="/panel/databases/users">{t('panel.databases.add_user', 'Add a user')}</Link>) },
            { key: 'charset', label: t('panel.databases.charset', 'Character set'), render: (r) => (r.charset ? `${r.charset}${r.collation ? ` / ${r.collation}` : ''}` : <span className="muted">—</span>) },
            { key: 'created_at', label: t('panel.databases.col_created', 'Created'), render: (r) => (r.created_at ? formatDate(r.created_at) : <span className="muted">—</span>) },
            { key: 'onServer', label: t('panel.databases.col_state', 'State'), render: (r) => <StatusPill status={r.onServer === false ? 'failed' : r.onServer == null ? 'unknown' : 'ok'}>{r.onServer === false ? t('panel.databases.state_missing', 'missing on server') : r.onServer == null ? t('panel.databases.state_unchecked', 'not checked') : t('panel.databases.state_ready', 'ready')}</StatusPill> },
          ]}
          rows={rows} loading={loading} error={capability ? null : error} rowKey={(r) => r.name}
          searchable={Boolean(data?.length)} q={q} onSearch={setQ} searchPlaceholder={t('panel.databases.search', 'Search databases or users')}
          rowActions={(r) => [
            { label: checkLabel('check'), primary: true, onClick: () => check(r, 'check') },
            { label: checkLabel('repair'), onClick: () => check(r, 'repair') },
            { label: checkLabel('optimize'), onClick: () => check(r, 'optimize') },
            isPg ? null : { label: t('panel.databases.download_backup', 'Download a backup'), onClick: () => dump(r) },
            { label: t('common.delete', 'Delete'), danger: true, onClick: () => drop(r) },
          ]}
          emptyText={capability ? t('panel.databases.empty_capability', 'Your databases appear here once the database server is available.') : q ? t('panel.databases.empty_search', 'No database matches the search.') : t('panel.databases.empty', 'No databases yet. Create one above; it appears here together with its size and the users that can open it.')}
        />
      </Card>

      <JobModal job={job} title={job ? `${job.kind === 'dump' ? t('panel.databases.backup_of', 'Backup of') : fill(t('panel.databases.action_of', '{action} of'), { action: checkLabel(job.kind) })} ${job.database}` : ''} onClose={() => setJob(null)} onFinished={onJobFinished}>
        {job?.kind === 'dump' && !job.result && <p className="muted">{t('panel.databases.dump_where_before', 'The SQL file is written to the')} <code>backups</code> {t('panel.databases.dump_where_after', 'folder of your home directory.')}</p>}
        {job?.result?.file && <InfoNote>{t('panel.databases.saved_as', 'Saved as')} <code>{job.result.file}</code>{job.result.sizeBytes != null && <> ({formatBytes(job.result.sizeBytes)})</>}. <Link to="/panel/files/file-manager">{t('panel.databases.open_file_manager', 'Open the file manager')}</Link> {t('panel.databases.to_download', 'to download it.')}</InfoNote>}
      </JobModal>
    </PanelPage>
  );
}
