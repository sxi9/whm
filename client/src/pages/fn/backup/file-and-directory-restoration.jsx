import { useCallback, useEffect, useState } from 'react';
import { Folder, File, Link2, CornerLeftUp } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, BackupCapabilityBanner, BackupPicker, FetchButton, useBackupStatus } from '../../backup/Shared.jsx';

const ROOT = 'homedir';

export default function FileAndDirectoryRestoration({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const status = useBackupStatus();
  const [account, setAccount] = useState('');
  const [backup, setBackupState] = useState(null);
  const setBackup = useCallback((b) => { setBackupState(b); setPrefix(ROOT); setSelected([]); }, []);
  const [prefix, setPrefix] = useState(ROOT);
  const [selected, setSelected] = useState([]);
  const [overwrite, setOverwrite] = useState(true);
  const [filter, setFilter] = useState('');
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const listing = useApi(backup?.local_present ? `/backup/backups/${backup.id}/browse?prefix=${encodeURIComponent(prefix)}` : null, { enabled: Boolean(backup?.local_present) });
  const restores = useApi(`/backup/restores?limit=30&r=${refreshKey}`);

  useEffect(() => { setFilter(''); }, [prefix]);

  const rel = (p) => p.slice(ROOT.length + 1);
  const crumbs = prefix.split('/');
  const entries = (listing.data?.entries || []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (p) => setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));

  const restore = async () => {
    if (!backup || !selected.length) return;
    const ok = await confirm({
      title: `Restore ${selected.length} item(s) into /home/${backup.account}?`,
      message: `${overwrite ? 'Existing files with the same names are overwritten' : 'Only files that do not exist yet are written'}; ownership is set to ${backup.account}. ${selected.slice(0, 5).map(rel).join(', ')}${selected.length > 5 ? ', …' : ''}`,
      danger: overwrite, confirmLabel: 'Restore',
    });
    if (!ok) return;
    setBusy(true); setRunError(null);
    try {
      const { data } = await api.post(`/backup/backups/${backup.id}/restore`, { kind: 'files', options: { paths: selected.map(rel), overwrite } });
      setJobId(data.job.id);
    } catch (err) { setRunError(err); } finally { setBusy(false); }
  };

  const finished = (e) => {
    if (e.type === 'done') { toast.success('Files restored'); setSelected([]); } else toast.error(e.error || 'Restore failed');
    setRefreshKey((k) => k + 1);
  };

  return (
    <>
      <PageHeader fn={fn} description="Browse an account archive and restore individual files or directories into the account's home directory with the right ownership." />
      <BackupCapabilityBanner status={status.data} error={status.error} onRetry={status.refetch} />
      <Card title="1. Choose the account and the backup date">
        <BackupPicker key={refreshKey} account={account} onAccountChange={setAccount} backup={backup} onBackupChange={setBackup} requireLocal />
        <FetchButton backup={backup} onQueued={(id) => { setJobId(id); toast.info('Fetching the archive in the background'); }} />
      </Card>
      {backup?.local_present && (
        <Card title="2. Pick files and directories" subtitle="Directories are restored with everything inside them." actions={<span className="muted">{selected.length} selected</span>}>
          <nav className="breadcrumbs" aria-label="Archive path">
            {crumbs.map((c, i) => {
              const p = crumbs.slice(0, i + 1).join('/');
              return <span key={p}>{i > 0 && <span>› </span>}{i === crumbs.length - 1 ? <span className="current">{i === 0 ? `/home/${backup.account}` : c}</span> : <a href="#" onClick={(e) => { e.preventDefault(); setPrefix(p); }}>{i === 0 ? `/home/${backup.account}` : c}</a>}</span>;
            })}
          </nav>
          <div className="form-grid">
            <Field label="Filter this directory"><TextInput value={filter} onChange={setFilter} placeholder="Type to filter" /></Field>
          </div>
          <RequestError error={listing.error} onRetry={listing.refetch} />
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: 32 }} /><th>Name</th><th>Size</th><th>Files</th><th>Modified</th><th>Owner</th><th>Mode</th></tr></thead>
              <tbody>
                {prefix !== ROOT && <tr><td /><td colSpan={6}><a href="#" onClick={(e) => { e.preventDefault(); setPrefix(prefix.split('/').slice(0, -1).join('/')); }}><CornerLeftUp size={14} /> ..</a></td></tr>}
                {listing.loading && !listing.data && <tr><td colSpan={7} className="table-state"><span className="spinner" /> Reading the archive…</td></tr>}
                {entries.map((e) => (
                  <tr key={e.path} className={selected.includes(e.path) ? 'is-selected' : ''}>
                    <td><input type="checkbox" checked={selected.includes(e.path)} onChange={() => toggle(e.path)} aria-label={`Select ${e.name}`} /></td>
                    <td>
                      {e.type === 'dir' ? <Folder size={14} /> : e.type === 'link' ? <Link2 size={14} /> : <File size={14} />}{' '}
                      {e.type === 'dir' ? <a href="#" onClick={(ev) => { ev.preventDefault(); setPrefix(e.path); }}>{e.name}</a> : e.name}
                      {e.target && <span className="muted"> → {e.target}</span>}
                    </td>
                    <td>{formatBytes(e.size)}</td>
                    <td>{e.type === 'dir' ? e.files : ''}</td>
                    <td>{e.mtime}</td>
                    <td className="muted">{e.owner}</td>
                    <td><code>{e.mode}</code></td>
                  </tr>
                ))}
                {listing.data && entries.length === 0 && <tr><td colSpan={7} className="table-state">Empty directory.</td></tr>}
              </tbody>
            </table>
          </div>
          {listing.data?.truncated && <p className="muted">Only the first {listing.data.entries.length} of {listing.data.total} entries are shown; use the filter or open a subdirectory.</p>}
          {selected.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <strong>Selected</strong>
              <ul>{selected.map((p) => <li key={p}><code>{rel(p)}</code> <button className="btn btn-sm btn-ghost" onClick={() => toggle(p)}>remove</button></li>)}</ul>
            </div>
          )}
          <div className="form-grid">
            <Field inline><Toggle checked={overwrite} onChange={setOverwrite} label="Overwrite existing files" description="Off: files already present in the home directory are kept (tar --skip-old-files)." /></Field>
          </div>
          <RequestError error={runError} />
          <FormActions><Button variant={overwrite ? 'danger' : 'primary'} loading={busy} disabled={!selected.length} onClick={restore}>Restore {selected.length || ''} selected</Button></FormActions>
          {jobId && <ProgressLog jobId={jobId} onFinished={finished} />}
        </Card>
      )}
      {!backup?.local_present && jobId && <Card title="Progress"><ProgressLog jobId={jobId} onFinished={(e) => { finished(e); setRefreshKey((k) => k + 1); }} /></Card>}
      <Card title="Recent file restores" padded={false}>
        <DataTable
          columns={[
            { key: 'created_at', label: 'Requested', render: (r) => formatDate(r.created_at) },
            { key: 'account_name', label: 'Account' },
            { key: 'paths', label: 'Paths', render: (r) => (r.options?.paths || []).slice(0, 4).map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>) },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
            { key: 'detail', label: 'Result', render: (r) => r.summary?.steps?.files?.detail || r.error || '' },
            { key: 'started_by', label: 'By' },
          ]}
          rows={(restores.data || []).filter((r) => r.kind === 'files')} loading={restores.loading} error={restores.error} rowKey={(r) => r.id} dense emptyText="No file restores yet."
        />
      </Card>
    </>
  );
}
