import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, CapabilityNotice, KeyValue, formatDate, formatBytes } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { ToolingNotice, Options, Steps, RunPanel, RunHistory, PackageSelect } from '../../transfers/Shared.jsx';

const OPTION_FIELDS = [
  { key: 'skipHome', label: 'Skip the home directory', description: 'Create the account without extracting homedir/' },
  { key: 'skipDatabases', label: 'Skip databases', description: 'Do not import mysql/*.sql and the saved grants' },
  { key: 'skipDns', label: 'Skip DNS zones', description: 'Create standard zones instead of the archived zone files' },
  { key: 'overwrite', label: 'Restore into an existing account', description: 'Merge the archive into a local account with the same username' },
];
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 10;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function readChunk(file, offset, size) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file.slice(offset, offset + size));
  });
}

// One chunk, retried with backoff on rate limiting (429 + Retry-After), gateway
// errors and lost connections. After a failure the server is asked how many
// bytes really arrived so the upload resumes from there instead of aborting or
// appending the same chunk twice.
async function sendChunk(id, data, onWait) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await api.request('PUT', `/transfers/uploads/${id}/chunks`, { data }, { raw: true });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      res = null;
    }
    if (res?.ok) return (await res.json()).data;
    if (res && !RETRY_STATUS.has(res.status)) throw new ApiError(res.status, await res.json().catch(() => null));
    if (res && attempt >= MAX_ATTEMPTS) throw new ApiError(res.status, await res.json().catch(() => null));
    const retryAfter = Number(res?.headers.get('Retry-After')) || 0;
    const wait = retryAfter ? retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
    onWait?.(wait, res?.status ?? 'network');
    await sleep(wait);
    const { data: status } = await api.get(`/transfers/uploads/${id}`);
    return { ...status, resumed: true };
  }
}

function Uploader({ onInspected }) {
  const inputRef = useRef(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const upload = async (file) => {
    if (!file) return;
    setError(null); setProgress({ sent: 0, total: file.size, name: file.name, note: null });
    let id = null;
    try {
      const { data: begun } = await api.post('/transfers/uploads', { filename: file.name, size: file.size });
      id = begun.id;
      const chunkBytes = begun.chunkBytes || 1_048_576;
      let offset = 0;
      while (offset < file.size) {
        const data = await readChunk(file, offset, chunkBytes);
        const status = await sendChunk(id, data, (wait, why) => setProgress((p) => ({ ...p, note: `${why === 429 ? 'rate limited' : `retrying (${why})`}, waiting ${Math.ceil(wait / 1000)} s` })));
        offset = status.received;
        setProgress({ sent: Math.min(file.size, offset), total: file.size, name: file.name, note: status.resumed ? 'resumed' : null });
      }
      const { data } = await api.post(`/transfers/uploads/${id}/finish`);
      onInspected(data.archive);
    } catch (err) {
      setError(err);
      if (id) api.delete(`/transfers/uploads/${id}`).catch(() => {});
    } finally { setProgress(null); if (inputRef.current) inputRef.current.value = ''; }
  };
  const pct = progress ? Math.round((progress.sent / progress.total) * 100) : 0;
  return (
    <Card title="Upload an archive" subtitle="cpmove-<user>.tar.gz or a full cPanel backup; sent in chunks into the staging directory and resumed automatically after a hiccup.">
      <CapabilityNotice error={error} />
      {error && error.status !== 501 && <ErrorBanner error={error} />}
      <input ref={inputRef} type="file" accept=".tar.gz,.tgz,.tar,application/gzip,application/x-tar" className="input" onChange={(e) => upload(e.target.files?.[0])} disabled={Boolean(progress)} />
      {progress && (
        <div className="progress-head" style={{ marginTop: 10 }}>
          <div className="progress-bar"><span style={{ width: `${pct}%` }} /></div>
          <span className="muted">{pct}% · {formatBytes(progress.sent)} of {formatBytes(progress.total)} · {progress.name}{progress.note ? ` · ${progress.note}` : ''}</span>
        </div>
      )}
    </Card>
  );
}

function PickArchive({ caps, onInspected }) {
  const { data, loading, error, refetch } = useApi('/transfers/archives');
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(null);
  const [inspectError, setInspectError] = useState(null);
  const inspect = async (file) => {
    setBusy(file); setInspectError(null);
    try { const { data: info } = await api.post('/transfers/archives/inspect', { path: file }); onInspected(info); } catch (err) { setInspectError(err); } finally { setBusy(null); }
  };
  return (
    <>
      <ToolingNotice caps={caps} needs={['tar']} />
      <Uploader onInspected={onInspected} />
      <Card title="Archives on this server" subtitle={data ? `Looking in ${data.dirs.join(', ')}` : undefined} padded={false} actions={<Button size="sm" variant="ghost" onClick={() => refetch()}>Refresh</Button>}>
        <ErrorBanner error={error} onRetry={refetch} />
        <CapabilityNotice error={inspectError} />
        {inspectError && inspectError.status !== 501 && <ErrorBanner error={inspectError} />}
        <DataTable
          columns={[
            { key: 'name', label: 'Archive', render: (a) => <code>{a.name}</code> },
            { key: 'dir', label: 'Directory', render: (a) => <code>{a.dir}</code> },
            { key: 'sizeBytes', label: 'Size', align: 'right', render: (a) => formatBytes(a.sizeBytes) },
            { key: 'mtime', label: 'Modified', render: (a) => formatDate(a.mtime) },
          ]}
          rows={data?.archives || []} loading={loading} rowKey={(a) => a.path} dense emptyText="No .tar.gz archives found. Upload one above or copy it into the staging directory."
          rowActions={(a) => [{ label: busy === a.path ? 'Inspecting…' : 'Inspect', primary: true, disabled: Boolean(busy), onClick: () => inspect(a.path) }]}
        />
        <div className="card-body">
          <div className="form-grid">
            <Field label="Or enter the path of an archive" help="Absolute path under /home, /backup or the staging directory"><TextInput value={manual} onChange={setManual} placeholder="/backup/cpmove-user.tar.gz" /></Field>
          </div>
          <FormActions><Button onClick={() => inspect(manual.trim())} disabled={!manual.trim().startsWith('/')} loading={busy === manual.trim()}>Inspect</Button></FormActions>
        </div>
      </Card>
    </>
  );
}

function RestoreForm({ archive, onBack, onStarted }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [form, setForm] = useState({ username: '', domain: '', package: '', password: '' });
  const [options, setOptions] = useState({ skipHome: false, skipDatabases: false, skipDns: false, overwrite: false });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const username = form.username.trim() || archive.username || '';
  const domain = (form.domain.trim() || archive.config?.domain || '').toLowerCase();
  const start = async () => {
    const ok = await confirm({ title: `Restore ${archive.top} as ${username}?`, message: `${domain} is created as the main domain${archive.hasHomedir && !options.skipHome ? ', the home directory is extracted' : ''}${archive.databases.length && !options.skipDatabases ? `, ${archive.databases.length} database(s) imported` : ''}.`, confirmLabel: 'Restore account' });
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      const body = { path: archive.path, options, ...(form.username.trim() ? { username: form.username.trim() } : {}), ...(form.domain.trim() ? { domain: form.domain.trim().toLowerCase() } : {}), ...(form.package ? { package: form.package } : {}), ...(form.password ? { password: form.password } : {}) };
      const { data } = await api.post('/transfers/restore', body);
      toast.success(`Restoring ${username}`);
      onStarted(data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <>
      <Card title={`Archive: ${archive.top}`} subtitle={`${archive.path} · ${formatBytes(archive.sizeBytes)} · ${formatDate(archive.mtime)}`} actions={<Button size="sm" variant="ghost" onClick={onBack}>Choose another archive</Button>}>
        <KeyValue items={[
          ['Account in archive', <span key="u"><code>{archive.username || '?'}</code> {archive.localExists ? <StatusPill status="warning">exists here ({archive.localDomain})</StatusPill> : <StatusPill status="ok">new</StatusPill>}</span>],
          ['Main domain', <span key="d">{archive.config?.domain || <span className="muted">not recorded</span>} {archive.domainHostedBy && <StatusPill status="warning">hosted by {archive.domainHostedBy}</StatusPill>}</span>],
          ['Package on source', archive.config?.plan || '—'],
          ['Contact', archive.config?.contactEmail || '—'],
          ['Home directory', archive.hasHomedir ? 'present' : 'missing'],
          ['Password', archive.hasShadow ? 'hash saved in the archive (kept unless you set a new one)' : 'not in the archive: set one below or afterwards under Password Modification'],
          ['Databases', archive.databases.length ? archive.databases.join(', ') : 'none'],
          ['Database users', archive.hasGrants ? 'grants saved' : 'none'],
          ['DNS zones', archive.zones.length ? archive.zones.join(', ') : 'none'],
          ['Extra domains', [archive.hasAddons && 'addon', archive.hasParked && 'parked', archive.hasSubdomains && 'subdomains'].filter(Boolean).join(', ') || 'none'],
        ]} />
      </Card>
      <Card title="Restore as">
        <CapabilityNotice error={error} />
        {error && error.status !== 501 && <ErrorBanner error={error} />}
        <div className="form-grid">
          <Field label="Username" help={`Leave empty to keep ${archive.username || 'the archived name'}`} error={error?.fields?.username}><TextInput value={form.username} onChange={(v) => setForm((f) => ({ ...f, username: v }))} placeholder={archive.username || ''} /></Field>
          <Field label="Main domain" help={archive.config?.domain ? `Defaults to ${archive.config.domain}` : 'Required: the archive has no domain'} error={error?.fields?.domain}><TextInput value={form.domain} onChange={(v) => setForm((f) => ({ ...f, domain: v }))} placeholder={archive.config?.domain || 'example.com'} /></Field>
          <Field label="Package" help={archive.config?.plan ? `Source used "${archive.config.plan}"` : undefined}><PackageSelect value={form.package} onChange={(v) => setForm((f) => ({ ...f, package: v }))} /></Field>
          <Field label="New password" help={archive.hasShadow ? 'Leave empty to keep the password saved in the archive' : 'At least 8 characters; without it the account cannot log in until one is set'} error={error?.fields?.password}><TextInput type="password" value={form.password} onChange={(v) => setForm((f) => ({ ...f, password: v }))} autoComplete="new-password" /></Field>
        </div>
        <Options value={options} onChange={setOptions} fields={OPTION_FIELDS} />
        <FormActions><Button variant="primary" onClick={start} loading={busy} disabled={!username || !domain}>Restore account</Button></FormActions>
      </Card>
    </>
  );
}

export default function TransferOrRestoreACpanelAccount({ fn }) {
  const { data: caps } = useApi('/transfers/capabilities');
  const [archive, setArchive] = useState(null);
  const [run, setRun] = useState(null);
  const [historyKey, setHistoryKey] = useState(0);
  const step = run ? 3 : archive ? 2 : 1;
  return (
    <>
      <PageHeader fn={fn} description="Imports one account from a cPanel-compatible account archive (cpmove-<user>.tar.gz / pkgacct backup, the format this panel's own backups use): the account is created, the home directory extracted, databases and grants imported, zones, addon and parked domains recreated. To migrate from a live server use the Transfer Tool.">
        <p className="muted">Migrating from a running server? Use the <Link to="/transfers/transfer-tool">Transfer Tool</Link>.</p>
      </PageHeader>
      <Steps step={step} labels={['Choose archive', 'Options', 'Restore']} />
      {step === 1 && <PickArchive caps={caps} onInspected={setArchive} />}
      {step === 2 && <RestoreForm archive={archive} onBack={() => setArchive(null)} onStarted={(r) => { setRun(r); setHistoryKey((k) => k + 1); }} />}
      {step === 3 && <RunPanel job={run.job} runId={run.run.id} title={`Restoring ${run.run.items?.[0]?.username || archive.username}`} resetLabel="Restore another archive" onReset={() => { setRun(null); setArchive(null); }} />}
      <RunHistory kind="restore" refreshKey={historyKey} />
    </>
  );
}
