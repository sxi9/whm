import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, Loading, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm, Modal } from '../../../components/Modal.jsx';
import { RequestError, BackupCapabilityBanner, DestinationFields, emptyDestination, cleanDestination, KIND_LABELS } from '../../backup/Shared.jsx';

const SCHEDULES = [
  { value: '0 2 * * *', label: 'Daily at 02:00' }, { value: '0 3 * * *', label: 'Daily at 03:00' }, { value: '0 2 * * 0', label: 'Weekly (Sunday 02:00)' },
  { value: '0 2 1 * *', label: 'Monthly (1st, 02:00)' }, { value: '0 */6 * * *', label: 'Every 6 hours' }, { value: 'custom', label: 'Custom cron expression…' },
];

export default function BackupConfiguration({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/backup/config');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [starting, setStarting] = useState(false);
  const runs = useApi('/backup/runs?limit=20');

  useEffect(() => { if (data?.settings) setDraft(data.settings); }, [data]);
  const dirty = useMemo(() => data?.settings && draft && JSON.stringify(draft) !== JSON.stringify(data.settings), [draft, data]);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const preset = SCHEDULES.some((s) => s.value === draft?.['backup.schedule']) ? draft['backup.schedule'] : 'custom';

  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(data.settings[k])));
      await api.put('/backup/config', changed);
      toast.success('Backup settings saved');
      await refetch();
    } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };

  const runNow = async () => {
    if (!(await confirm({ title: 'Run a backup now?', message: `Every included account (${data?.status?.includedAccounts ?? 0}) is archived to ${data?.settings?.['backup.local_dir']} and copied to the enabled destinations. This runs in the background.`, confirmLabel: 'Run backup' }))) return;
    setStarting(true);
    try { const { data: out } = await api.post('/backup/runs', {}); setJobId(out.job.id); toast.info('Backup run queued'); } catch (err) { toast.error(err); } finally { setStarting(false); }
  };

  const status = data?.status;
  return (
    <>
      <PageHeader fn={fn} description="Schedule nightly account archives (home directory, mail, databases, DNS zones and metadata), keep daily/weekly/monthly copies and send them to remote destinations." actions={<Button variant="primary" loading={starting} disabled={!status?.capability?.installed} onClick={runNow}>Run backup now</Button>} />
      {loading && !data && <Loading />}
      <RequestError error={error} onRetry={refetch} />
      <BackupCapabilityBanner status={status} onRetry={refetch} />
      {status && (
        <Card title="Status">
          <div className="stat-grid">
            <div className="stat"><div className="label">Backups</div><div className="value"><StatusPill status={data.settings['backup.enabled'] ? 'enabled' : 'disabled'} /></div></div>
            <div className="stat"><div className="label">Next scheduled run</div><div className="value" style={{ fontSize: 14 }}>{status.schedule?.enabled ? formatDate(status.schedule.next_run_at) : 'not scheduled'}</div></div>
            <div className="stat"><div className="label">Accounts included</div><div className="value">{status.includedAccounts} / {status.totalAccounts}</div></div>
            <div className="stat"><div className="label">Local directory</div><div className="value" style={{ fontSize: 14 }}><code>{status.localDir.path}</code> {status.localDir.exists === false && <span className="pill pill-warn">created on first run</span>}</div></div>
            <div className="stat"><div className="label">Last run</div><div className="value" style={{ fontSize: 14 }}>{status.lastRun ? <><StatusPill status={status.lastRun.status} /> {status.lastRun.accounts_ok} ok / {status.lastRun.accounts_failed} failed · {formatBytes(status.lastRun.bytes)}</> : 'never'}</div></div>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>Tools: {Object.entries(status.capability.binaries).map(([b, ok]) => <span key={b} className={`pill ${ok ? 'pill-ok' : 'pill-muted'}`} style={{ marginRight: 4 }}>{b}</span>)} — mysqldump is needed to include databases, curl for FTP/SFTP/WebDAV destinations. Choose which accounts are archived under <Link to="/backup/backup-user-selection">Backup User Selection</Link>.</p>
          {jobId && <ProgressLog jobId={jobId} onFinished={(e) => { if (e.type === 'done') toast.success(`Backup run finished: ${e.result?.ok ?? 0} ok, ${e.result?.failed ?? 0} failed`); else toast.error(e.error || 'Backup run failed'); refetch(); runs.refetch(); }} />}
        </Card>
      )}
      {draft && (
        <>
          <Card title="Global settings" subtitle="When and how the scheduled run happens.">
            <div className="form-grid">
              <Field inline><Toggle checked={draft['backup.enabled']} onChange={(v) => set('backup.enabled', v)} label="Enable scheduled backups" description="The cron entry below is created either way; it only fires when enabled." /></Field>
              <Field label="Schedule"><Select value={preset} onChange={(v) => set('backup.schedule', v === 'custom' ? (preset === 'custom' ? draft['backup.schedule'] : '0 2 * * *') : v)} options={SCHEDULES} /></Field>
              {preset === 'custom' && <Field label="Cron expression" help="minute hour day month weekday (server time)"><TextInput value={draft['backup.schedule']} onChange={(v) => set('backup.schedule', v)} /></Field>}
              <Field inline><Toggle checked={draft['backup.strict']} onChange={(v) => set('backup.strict', v)} label="Strict mode" description="Any failed component (a database dump, a missing home) fails the account and stops the run, instead of being recorded as a warning." /></Field>
              <Field inline><Toggle checked={draft['backup.skip_suspended']} onChange={(v) => set('backup.skip_suspended', v)} label="Skip suspended accounts" /></Field>
              <Field inline><Toggle checked={draft['backup.notify_on_failure']} onChange={(v) => set('backup.notify_on_failure', v)} label="Notify contacts when a run fails" description="Uses the Contact Manager channels subscribed to backup events." /></Field>
            </div>
          </Card>
          <Card title="Retention" subtitle="How many archives of each class are kept per account. A backup made on the 1st of the month is monthly, on a Sunday weekly, otherwise daily. Pinned backups are never pruned.">
            <div className="form-grid">
              <Field label="Daily backups to keep"><NumberInput value={draft['backup.retention_daily']} onChange={(v) => set('backup.retention_daily', v ?? 0)} nullable={false} min={0} /></Field>
              <Field label="Weekly backups to keep" help="0 disables the weekly class"><NumberInput value={draft['backup.retention_weekly']} onChange={(v) => set('backup.retention_weekly', v ?? 0)} nullable={false} min={0} /></Field>
              <Field label="Monthly backups to keep" help="0 disables the monthly class"><NumberInput value={draft['backup.retention_monthly']} onChange={(v) => set('backup.retention_monthly', v ?? 0)} nullable={false} min={0} /></Field>
              <Field inline><Toggle checked={draft['backup.prune_remote']} onChange={(v) => set('backup.prune_remote', v)} label="Also delete pruned archives from destinations" /></Field>
            </div>
          </Card>
          <Card title="What to back up" subtitle="Archives use the cPanel layout (homedir/, mysql/, dnszones/, cp/) so they can also be restored on cPanel hosts.">
            <div className="form-grid">
              <Field inline><Toggle checked={draft['backup.include_home']} onChange={(v) => set('backup.include_home', v)} label="Home directory" /></Field>
              <Field inline><Toggle checked={draft['backup.include_mail']} onChange={(v) => set('backup.include_mail', v)} label="Mail (the mail/ tree inside the home)" /></Field>
              <Field inline><Toggle checked={draft['backup.include_dbs']} onChange={(v) => set('backup.include_dbs', v)} label="Databases (mysqldump per database, users and grants)" /></Field>
              <Field inline><Toggle checked={draft['backup.include_dns']} onChange={(v) => set('backup.include_dns', v)} label="DNS zone files" /></Field>
              <Field inline><Toggle checked={draft['backup.include_metadata']} onChange={(v) => set('backup.include_metadata', v)} label="Account metadata (package, domains, routing, owner) needed to recreate the account" /></Field>
              <Field label="Excluded paths" help="Comma-separated, relative to the home directory"><TextInput value={(draft['backup.excludes'] || []).join(', ')} onChange={(v) => set('backup.excludes', v.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="tmp, logs, .cache" /></Field>
              <Field label="Compression level (gzip 1–9)"><NumberInput value={draft['backup.compression_level']} onChange={(v) => set('backup.compression_level', v ?? 6)} nullable={false} min={1} max={9} /></Field>
            </div>
          </Card>
          <Card title="Local storage" subtitle="Archives are always written locally first, then copied to each enabled destination.">
            <div className="form-grid">
              <Field label="Local backup directory" help="Must be under /backup, /var/backups/whm, /var/lib/whm or a home root; created with mode 0700."><TextInput value={draft['backup.local_dir']} onChange={(v) => set('backup.local_dir', v)} /></Field>
              <Field inline><Toggle checked={draft['backup.keep_local']} onChange={(v) => set('backup.keep_local', v)} label="Keep the local copy after a successful upload" description="Off: the local archive is deleted once at least one destination has it; restores fetch it back." /></Field>
              <Field inline><Toggle checked={draft['backup.default_include']} onChange={(v) => set('backup.default_include', v)} label="New accounts are included by default" /></Field>
            </div>
          </Card>
          <div className="sticky-actions">
            <ErrorBanner error={saveError} />
            <FormActions>
              <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
              <Button disabled={!dirty || saving} onClick={() => setDraft(data.settings)}>Reset</Button>
            </FormActions>
          </div>
        </>
      )}
      <Destinations />
      <Card title="Recent runs" padded={false}>
        <DataTable
          columns={[
            { key: 'created_at', label: 'Started', render: (r) => formatDate(r.created_at) },
            { key: 'kind', label: 'Kind' },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
            { key: 'accounts', label: 'Accounts', render: (r) => `${r.accounts_ok} ok / ${r.accounts_failed} failed of ${r.accounts_total}` },
            { key: 'bytes', label: 'Size', render: (r) => formatBytes(r.bytes) },
            { key: 'summary', label: 'Uploads / pruned', render: (r) => `${r.summary?.uploads ?? 0} uploaded${r.summary?.uploadFailures ? ` (${r.summary.uploadFailures} failed)` : ''} · ${r.summary?.pruned ?? 0} pruned` },
            { key: 'error', label: 'Error', render: (r) => r.error || '' },
            { key: 'started_by', label: 'By' },
          ]}
          rows={runs.data || []} loading={runs.loading} error={runs.error} rowKey={(r) => r.id} dense emptyText="No runs yet."
        />
      </Card>
    </>
  );
}

function Destinations() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/backup/destinations');
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [cfg, setCfg] = useState(emptyDestination('s3'));
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const open = (d) => {
    setEditing(d || 'new');
    setName(d?.name || '');
    setEnabled(d ? d.enabled : true);
    setCfg(d ? { ...emptyDestination(d.kind), ...Object.fromEntries(Object.entries(d.config).filter(([k]) => !k.startsWith('has_'))), kind: d.kind } : emptyDestination('s3'));
    setFormError(null); setTestResult(null);
  };

  const save = async () => {
    setBusy('save'); setFormError(null);
    try {
      const body = { name: name.trim(), enabled, config: cleanDestination(cfg, { editing: editing !== 'new' }) };
      if (editing === 'new') await api.post('/backup/destinations', body); else await api.put(`/backup/destinations/${editing.id}`, body);
      toast.success(editing === 'new' ? 'Destination added' : 'Destination saved');
      setEditing(null); refetch();
    } catch (err) { setFormError(err); } finally { setBusy(null); }
  };

  const testUnsaved = async () => {
    setBusy('test'); setFormError(null); setTestResult(null);
    try {
      const { data: r } = await api.post('/backup/destinations/test', { config: cleanDestination(cfg) });
      setTestResult(r);
    } catch (err) { setFormError(err); } finally { setBusy(null); }
  };

  const test = async (d) => {
    setBusy(`test-${d.id}`);
    try { const { data: r } = await api.post(`/backup/destinations/${d.id}/test`); if (r.ok) toast.success(`${d.name}: ${r.message}`); else toast.error(`${d.name}: ${r.message}`); refetch(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };

  const remove = async (d) => {
    if (!(await confirm({ title: `Delete destination ${d.name}?`, message: 'Archives already uploaded there are not deleted, but the panel can no longer fetch or prune them.', danger: true, confirmLabel: 'Delete' }))) return;
    try { await api.delete(`/backup/destinations/${d.id}`); toast.success('Destination deleted'); refetch(); } catch (err) { toast.error(err); }
  };

  const toggle = async (d) => {
    try { await api.put(`/backup/destinations/${d.id}`, { enabled: !d.enabled }); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <Card title="Additional destinations" subtitle="Every enabled destination receives a copy of each archive. Credentials are stored encrypted." actions={<Button onClick={() => open(null)}>Add destination</Button>} padded={false}>
      <DataTable
        columns={[
          { key: 'name', label: 'Name', render: (d) => <strong>{d.name}</strong> },
          { key: 'kind', label: 'Type', render: (d) => KIND_LABELS[d.kind] || d.kind },
          { key: 'target', label: 'Target', render: (d) => <code>{d.kind === 's3' ? `${d.config.bucket}/${d.config.prefix || ''}` : d.kind === 'webdav' ? d.config.url : d.kind === 'local' ? d.config.dir : `${d.config.username}@${d.config.host}:${d.config.port}/${d.config.path || ''}`}</code> },
          { key: 'enabled', label: 'Enabled', render: (d) => <StatusPill status={d.enabled ? 'enabled' : 'disabled'} /> },
          { key: 'lastTest', label: 'Last test', render: (d) => (d.lastTest ? <><StatusPill status={d.lastTest.ok ? 'ok' : 'failed'} /> <span className="muted">{formatDate(d.lastTest.at)} — {d.lastTest.message}</span></> : <span className="muted">never</span>) },
        ]}
        rows={data || []} loading={loading} error={error} rowKey={(d) => d.id} dense emptyText="No destinations. Archives stay in the local directory only."
        rowActions={(d) => [
          { label: busy === `test-${d.id}` ? 'Testing…' : 'Test', primary: true, disabled: Boolean(busy), onClick: () => test(d) },
          { label: 'Edit', onClick: () => open(d) },
          { label: d.enabled ? 'Disable' : 'Enable', onClick: () => toggle(d) },
          { label: 'Delete', danger: true, onClick: () => remove(d) },
        ]}
      />
      <Modal open={Boolean(editing)} title={editing === 'new' ? 'Add destination' : `Edit ${editing?.name}`} onClose={() => setEditing(null)} size="lg"
        footer={(
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button loading={busy === 'test'} disabled={Boolean(busy) || editing !== 'new'} onClick={testUnsaved} title={editing !== 'new' ? 'Save first, then test from the table' : undefined}>Test connection</Button>
            <Button variant="primary" loading={busy === 'save'} disabled={!name.trim() || Boolean(busy)} onClick={save}>{editing === 'new' ? 'Add' : 'Save'}</Button>
          </>
        )}>
        <ErrorBanner error={formError} />
        {testResult && <div className={`banner ${testResult.ok ? 'banner-info' : 'banner-error'}`}><div>{testResult.message} ({testResult.ms} ms)</div></div>}
        <div className="form-grid">
          <Field label="Name" required error={formError?.fields?.name}><TextInput value={name} onChange={setName} placeholder="offsite-s3" /></Field>
          <Field inline><Toggle checked={enabled} onChange={setEnabled} label="Enabled" /></Field>
        </div>
        <DestinationFields value={cfg} onChange={setCfg} errors={formError?.fields || {}} editing={editing !== 'new'} />
        <KeyValue items={[['Upload method', cfg.kind === 's3' ? 'Single signed PUT (AWS Signature V4) straight from the panel; archives above 5 GB exceed the single-PUT object limit of AWS and most providers' : cfg.kind === 'local' ? 'File copy' : 'curl with a private config file (credentials never appear on the command line)']]} />
      </Modal>
    </Card>
  );
}
