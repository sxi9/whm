import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, TextInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, engineLabel } from '../../databases/Shared.jsx';

// With no candidate from the package manager the Select can only show "Other
// package…" and never fires onChange, so the typed name is the target even
// though nothing was explicitly selected.
export function resolveTarget({ target, customTarget, options }) {
  const customMode = target === '__custom' || (!options.length && !target);
  return { customMode, chosen: customMode ? customTarget.trim() : target || options[0]?.value || '' };
}

export default function UpgradeDatabaseVersion({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/databases/upgrade');
  const [target, setTarget] = useState('');
  const [customTarget, setCustomTarget] = useState('');
  const [backup, setBackup] = useState(true);
  const [jobId, setJobId] = useState(null);
  const [runError, setRunError] = useState(null);
  const [busy, setBusy] = useState(false);
  const options = (data?.packages?.available || []).map((p) => ({ value: p.name, label: `${p.name} → ${p.candidate}${p.installed ? ` (installed ${p.installed})` : ''}` }));
  const { customMode, chosen } = resolveTarget({ target, customTarget, options });

  const run = async () => {
    const ok = await confirm({ title: `Upgrade to ${chosen}?`, message: `${backup ? 'All databases are dumped to the backup directory first. ' : ''}The package is installed through the system package manager, the server restarts and system tables are upgraded. Downgrades are not supported; keep the backup until applications have been verified.`, confirmLabel: 'Start upgrade', danger: true, typeToConfirm: 'UPGRADE' });
    if (!ok) return;
    setBusy(true); setRunError(null);
    try { const { data: res } = await api.post('/databases/upgrade', { target: chosen, backup }); setJobId(res.job.id); } catch (err) { setRunError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Upgrade the local MySQL/MariaDB server through the distribution package manager, with a full dump beforehand and mysql_upgrade afterwards. Switching between MySQL and MariaDB is a reinstall: back up, remove the old server packages, then install the new one." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="Current server">
            {data.error && <div className="banner banner-warning"><div><strong>Server not reachable</strong><p>{data.error.message}</p></div></div>}
            <KeyValue items={[
              ['Profile', data.profile ? `${data.profile.profile_name} (${engineLabel(data.profile.engine)}${data.local ? ', local' : ', remote'})` : '—'],
              ['Running version', data.version ? `${data.version.version} ${data.version.comment ? `— ${data.version.comment}` : ''}` : '—'],
              ['Package manager', <StatusPill key="p" status={data.installerAvailable ? 'ok' : 'warning'}>{data.installerAvailable ? `${data.packageManager} — packages are installed through it` : 'not detected — no package can be installed from this panel'}</StatusPill>],
              ['Installed server packages', data.packages?.installed?.length ? data.packages.installed.map((p) => `${p.name} ${p.version}`).join(', ') : 'none detected'],
              ['Pre-upgrade backups', <code key="b">{data.backupDir}</code>],
            ]} />
          </Card>
          <Card title="Upgrade">
            <RequestError error={runError} />
            {!data.local && <div className="banner banner-info"><div>The active profile is a remote server; upgrade it on that host. Switch to the local profile under <Link to="/database-services/manage-database-profiles">Manage Database Profiles</Link> to upgrade this server.</div></div>}
            <div className="form-grid">
              <Field label="Target package" help={options.length ? 'Candidates offered by the package manager' : 'No candidate found; enter the package name'}>
                <Select value={target || options[0]?.value || '__custom'} onChange={setTarget} options={[...options, { value: '__custom', label: 'Other package…' }]} />
              </Field>
              {customMode && <Field label="Package name" required><TextInput value={customTarget} onChange={setCustomTarget} placeholder="mariadb-server" /></Field>}
            </div>
            <Field inline><Toggle checked={backup} onChange={setBackup} label="Dump all databases before upgrading" description="mysqldump --all-databases into the backup directory (recommended)" /></Field>
            <FormActions><Button variant="danger" loading={busy} onClick={run} disabled={!chosen || !data.local || !data.installerAvailable}>Upgrade database server</Button></FormActions>
            {jobId && <ProgressLog jobId={jobId} onFinished={(e) => { if (e.type === 'done') toast[e.result?.available === false || e.result?.alreadyCurrent ? 'warning' : 'success'](e.result?.available === false || e.result?.alreadyCurrent ? e.result.reason : `Upgrade finished: ${e.result?.versionAfter || 'done'}`); else toast.error(e.error || 'Upgrade failed'); refetch(); }} />}
          </Card>
          <Card title="Recent upgrade jobs" padded={false}>
            <DataTable
              columns={[
                { key: 'created_at', label: 'Started', render: (j) => formatDate(j.created_at) },
                { key: 'target', label: 'Target', render: (j) => <code>{j.params?.target}</code> },
                { key: 'status', label: 'Job', render: (j) => <StatusPill status={j.status} /> },
                { key: 'result', label: 'Result', render: (j) => (j.error ? <span className="muted">{j.error}</span> : j.result ? (j.result.available === false ? <span className="muted">not available: no package manager</span> : j.result.alreadyCurrent ? <span className="muted">already current ({j.result.versionBefore || '?'}); server not restarted</span> : `${j.result.versionBefore || '?'} → ${j.result.versionAfter || '?'}${j.result.backup ? ` · backup ${j.result.backup.path}` : ''}`) : '—') },
              ]}
              rows={data.recentJobs || []} rowKey={(j) => j.id} dense emptyText="No upgrade jobs yet."
            />
          </Card>
        </>
      )}
    </>
  );
}
