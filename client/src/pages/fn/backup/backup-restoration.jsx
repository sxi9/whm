import { useCallback, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, BackupCapabilityBanner, BackupPicker, FetchButton, useBackupStatus, useIsRoot } from '../../backup/Shared.jsx';

const DEFAULT_OPTIONS = { files: true, databases: true, dns: true, mail: true, overwrite: true, createAccount: true };

export default function BackupRestoration({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const isRoot = useIsRoot();
  const status = useBackupStatus();
  const [account, setAccount] = useState('');
  const [backup, setBackupState] = useState(null);
  const setBackup = useCallback((b) => setBackupState(b), []);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState(null);
  const [importPath, setImportPath] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const restores = useApi(`/backup/restores?limit=30&r=${refreshKey}`);
  const info = useApi(backup?.local_present ? `/backup/backups/${backup.id}/info` : null, { enabled: Boolean(backup?.local_present) });
  const accountExists = info.data?.metadata ? true : null;
  const setOpt = (k) => (v) => setOptions((o) => ({ ...o, [k]: v }));

  const restore = async () => {
    if (!backup) return;
    const ok = await confirm({
      title: `Restore ${backup.account} from ${formatDate(backup.created_at)}?`,
      message: `${options.files ? 'Files in the home directory are replaced by the archived versions' : 'Files are left alone'}${options.databases ? '; databases in the archive are re-imported (existing tables with the same names are replaced)' : ''}${options.dns ? '; DNS zones are reloaded from the archive' : ''}. Type the account name to confirm.`,
      typeToConfirm: backup.account, danger: true, confirmLabel: 'Restore',
    });
    if (!ok) return;
    setBusy(true); setRunError(null);
    try {
      const { data } = await api.post(`/backup/backups/${backup.id}/restore`, { kind: 'account', options });
      setJobId(data.job.id);
    } catch (err) { setRunError(err); } finally { setBusy(false); }
  };

  const importArchive = async () => {
    try {
      const { data } = await api.post('/backup/archives/import', { path: importPath.trim() });
      toast.success(`Registered ${data.name} for ${data.account}`);
      setImportPath(''); setAccount(data.account); setBackupState(null); setRefreshKey((k) => k + 1);
    } catch (err) { toast.error(err); }
  };

  const finished = (e) => {
    if (e.type === 'done') toast.success('Restore finished'); else toast.error(e.error || 'Restore failed');
    setRefreshKey((k) => k + 1); status.refetch();
  };

  return (
    <>
      <PageHeader fn={fn} description="Restore a complete account from one of its archives: home directory, databases and their users, DNS zones and mail routing. A terminated account is recreated from the metadata stored in the archive." />
      <BackupCapabilityBanner status={status.data} error={status.error} onRetry={status.refetch} />
      <Card title="1. Choose the account and the backup date">
        <BackupPicker key={refreshKey} account={account} onAccountChange={setAccount} backup={backup} onBackupChange={setBackup} requireLocal />
        <FetchButton backup={backup} onQueued={(id) => { setJobId(id); toast.info('Fetching the archive in the background'); }} />
      </Card>
      {backup && (
        <Card title="2. What to restore">
          <RequestError error={info.error} onRetry={info.refetch} />
          {info.data && (
            <KeyValue items={[
              ['Archive', <code>{backup.name}</code>],
              ['Created', `${formatDate(backup.created_at)} · ${formatBytes(backup.size)}`],
              ['Home directory', info.data.components.home ? 'included' : 'not in archive'],
              ['Databases', info.data.components.mysql.length ? info.data.components.mysql.map((m) => m.database).join(', ') : 'none'],
              ['DNS zones', info.data.components.dnszones.length ? info.data.components.dnszones.join(', ') : 'none'],
              ['Metadata', info.data.metadata ? `${info.data.metadata.account?.domain || ''} · package ${info.data.metadata.account?.package_name || '—'} · owner ${info.data.metadata.account?.owner || '—'}${info.data.metadata.source === 'cpmove' ? ' · from cPanel cp/<user>' : ''}` : 'none (the account must already exist)'],
              ['Other domains', info.data.metadata?.domains?.length ? info.data.metadata.domains.map((d) => `${d.domain} (${d.type})`).join(', ') : 'none'],
              ['sha256', <code style={{ fontSize: 11 }}>{backup.sha256}</code>],
            ]} />
          )}
          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field inline><Toggle checked={options.files} onChange={setOpt('files')} label="Home directory and mail" description="Archived files are written over the current ones with the account's ownership." /></Field>
            <Field inline><Toggle checked={options.overwrite} onChange={setOpt('overwrite')} label="Overwrite files that exist" description="Off: only files missing from the home directory are restored." disabled={!options.files} /></Field>
            <Field inline><Toggle checked={options.databases} onChange={setOpt('databases')} label="Databases, users and grants" description="Each schema is created if missing, then its dump is imported inside it (works for cPanel per-database dumps too); users keep their original passwords." /></Field>
            <Field inline><Toggle checked={options.dns} onChange={setOpt('dns')} label="DNS zones" description="Zone files are loaded into BIND (saved for later when BIND is missing)." /></Field>
            <Field inline><Toggle checked={options.mail} onChange={setOpt('mail')} label="Mail routing (local / remote / backup MX)" /></Field>
            <Field inline><Toggle checked={options.createAccount} onChange={setOpt('createAccount')} label="Recreate the account if it was terminated" description="Linux user, home, package, web vhost and the parked/addon/sub domains come from the archive metadata." /></Field>
          </div>
          <RequestError error={runError} />
          <FormActions>
            <Button variant="danger" loading={busy} disabled={!backup.local_present || !status.data?.capability?.installed} onClick={restore}>Restore account</Button>
            {accountExists === false && <span className="muted">The archive has no metadata; the account must exist before restoring.</span>}
          </FormActions>
          {jobId && <ProgressLog jobId={jobId} onFinished={finished} />}
        </Card>
      )}
      {!backup && jobId && <Card title="Progress"><ProgressLog jobId={jobId} onFinished={finished} /></Card>}
      {isRoot && (
        <Card title="Import an archive" subtitle="Register a cPanel or WHM account archive copied onto this server by hand (e.g. /backup/cpmove-user.tar.gz), then restore it above.">
          <div className="form-grid">
            <Field label="Archive path" help="Must be under the backup directory or /var/backups/whm (move files out of account homes as root first); the file name identifies the account."><TextInput value={importPath} onChange={setImportPath} placeholder="/backup/cpmove-alice.tar.gz" /></Field>
          </div>
          <p className="muted">cPanel cpmove archives restore the home directory, per-database dumps, DNS zones and the account (main, parked, addon and sub domains from cp/&lt;user&gt;, pds, addons and sds2). Database users kept in cPanel's mysql.sql are not recreated; add them again in Database Services after the restore.</p>
          <FormActions><Button disabled={!importPath.trim().startsWith('/')} onClick={importArchive}>Register archive</Button></FormActions>
        </Card>
      )}
      <Card title="Restore history" padded={false}>
        <DataTable
          columns={[
            { key: 'created_at', label: 'Requested', render: (r) => formatDate(r.created_at) },
            { key: 'account_name', label: 'Account' },
            { key: 'kind', label: 'Kind', render: (r) => (r.kind === 'account' ? 'full account' : 'files') },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
            { key: 'steps', label: 'Steps', render: (r) => Object.entries(r.summary?.steps || {}).map(([k, v]) => <span key={k} className={`pill pill-${v.status === 'done' ? 'ok' : v.status === 'failed' ? 'bad' : v.status === 'pending' ? 'warn' : 'muted'}`} style={{ marginRight: 4 }} title={v.detail}>{k}</span>) },
            { key: 'error', label: 'Error', render: (r) => r.error || '' },
            { key: 'started_by', label: 'By' },
          ]}
          rows={restores.data || []} loading={restores.loading} error={restores.error} rowKey={(r) => r.id} dense emptyText="No restores yet."
        />
      </Card>
    </>
  );
}
