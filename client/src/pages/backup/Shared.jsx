import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { CapabilityNotice, StatusPill, formatBytes, formatDate } from '../../components/Common.jsx';
import { Field, Select, TextInput, NumberInput, Toggle, Textarea, PasswordInput, ErrorBanner } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { READ_ONLY_FIELDS, encryptionOn } from './CloudProviders.jsx';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

export function RequestError({ error, onRetry }) {
  if (!error) return null;
  if (isCapabilityError(error)) return <CapabilityNotice error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export function useIsRoot() {
  const { user } = useAuth();
  return user?.role === 'root';
}

export const useBackupStatus = () => useApi('/backup/status');

// Shown on every backup page: tar/gzip missing means nothing can be archived.
export function BackupCapabilityBanner({ status, error, onRetry }) {
  if (error) return <RequestError error={error} onRetry={onRetry} />;
  if (!status) return null;
  if (status.capability?.installed) return null;
  return <CapabilityNotice error={{ code: 'capability_missing', message: 'tar and gzip are not installed on this server; archives cannot be created or restored until they are.' }} onRetry={onRetry} />;
}

export const KIND_LABELS = { gdrive: 'Google Drive', onedrive: 'Microsoft OneDrive', dropbox: 'Dropbox', s3: 'Amazon S3 / S3-compatible (Wasabi, MinIO, R2…)', azureblob: 'Azure Blob Storage', b2: 'Backblaze B2', sftp: 'SFTP', ftp: 'FTP / FTPS', webdav: 'WebDAV', local: 'Local directory' };

export function BackupRow({ backup }) {
  return (
    <span>
      <strong>{formatDate(backup.created_at)}</strong> · {formatBytes(backup.size)} · <StatusPill status={backup.status} /> <span className="pill pill-muted">{backup.retention_class}</span>
      {backup.pinned && <span className="pill pill-info">pinned</span>}
      {!backup.local_present && <span className="pill pill-warn">remote only</span>}
    </span>
  );
}

// Account → backup selection shared by the two restoration pages.
export function BackupPicker({ account, onAccountChange, backup, onBackupChange, requireLocal = false }) {
  const accounts = useApi('/backup/accounts');
  const backups = useApi(account ? `/backup/backups?account=${encodeURIComponent(account)}&pageSize=200&status=done` : null, { enabled: Boolean(account) });
  const [filter, setFilter] = useState('');

  useEffect(() => { if (backup && !backups.data?.some((b) => b.id === backup.id)) onBackupChange(null); }, [backups.data, backup, onBackupChange]);

  const options = useMemo(() => (accounts.data || [])
    .filter((a) => !filter || `${a.username} ${a.domain || ''} ${a.owner || ''}`.toLowerCase().includes(filter.toLowerCase()))
    .map((a) => ({ value: a.username, label: `${a.username}${a.domain ? ` — ${a.domain}` : ''}${a.exists ? '' : ' (account no longer exists)'} · ${a.backups} backup(s)` })), [accounts.data, filter]);

  return (
    <>
      <div className="form-grid">
        <Field label="Filter"><TextInput value={filter} onChange={setFilter} placeholder="Type to filter by user, domain or owner" /></Field>
        <Field label="Account" help={accounts.loading ? 'Loading accounts…' : `${(accounts.data || []).length} account(s) with or without backups`}>
          <Select value={account || ''} onChange={(v) => { onAccountChange(v); onBackupChange(null); }} options={options} placeholder={options.length ? 'Select an account' : 'No accounts'} />
        </Field>
      </div>
      <RequestError error={accounts.error} onRetry={accounts.refetch} />
      {account && (
        <>
          <RequestError error={backups.error} onRetry={backups.refetch} />
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: 32 }} /><th>Backup date</th><th>Archive</th><th>Size</th><th>Class</th><th>Copies</th></tr></thead>
              <tbody>
                {(backups.data || []).map((b) => (
                  <tr key={b.id} className={backup?.id === b.id ? 'is-selected' : ''} onClick={() => onBackupChange(b)} style={{ cursor: 'pointer' }}>
                    <td><input type="radio" name="backup" checked={backup?.id === b.id} onChange={() => onBackupChange(b)} aria-label={`Select backup ${b.id}`} /></td>
                    <td>{formatDate(b.created_at)}</td>
                    <td><code>{b.name}</code>{b.pinned && <span className="pill pill-info" style={{ marginLeft: 6 }}>pinned</span>}</td>
                    <td>{formatBytes(b.size)}</td>
                    <td><span className="pill pill-muted">{b.retention_class}</span></td>
                    <td>{b.local_present ? <span className="pill pill-ok">local</span> : <span className="pill pill-warn">remote only</span>}{' '}{b.uploads?.filter((u) => u.status === 'done').map((u) => <span key={u.id} className="pill pill-info" style={{ marginLeft: 4 }}>{u.destination}</span>)}</td>
                  </tr>
                ))}
                {!backups.loading && (backups.data || []).length === 0 && <tr><td colSpan={6} className="table-state">No completed backups for this account yet. <Link to="/backup/backup-configuration">Run a backup</Link> first.</td></tr>}
                {backups.loading && !backups.data && <tr><td colSpan={6} className="table-state"><span className="spinner" /> Loading…</td></tr>}
              </tbody>
            </table>
          </div>
          {requireLocal && backup && !backup.local_present && <div className="banner banner-warning"><div>This archive is not on local disk. Fetch it from a destination before browsing or restoring it.</div></div>}
          <CloudCopies account={account} onImported={backups.refetch} />
        </>
      )}
    </>
  );
}

// What a destination holds for the account, with an import for copies the
// panel no longer knows about (a reinstall, an archive made on another
// server). Root only: destinations are server configuration.
export function CloudCopies({ account, onImported }) {
  const isRoot = useIsRoot();
  const destinations = useApi(isRoot ? '/backup/destinations' : null, { enabled: isRoot });
  const [destId, setDestId] = useState('');
  const listing = useApi(destId ? `/backup/destinations/${destId}/archives` : null, { enabled: Boolean(destId) });
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  if (!isRoot) return null;
  const rows = (listing.data?.archives || []).filter((a) => !account || a.username === account);
  const importOne = async (a) => {
    setBusy(a.name); setError(null);
    try { const { data } = await api.post(`/backup/destinations/${destId}/archives/import`, { name: a.name, encrypted: Boolean(a.encrypted) }); setJobId(data.job.id); } catch (err) { setError(err); } finally { setBusy(null); }
  };
  return (
    <details style={{ marginTop: 12 }}>
      <summary>Copies on destinations</summary>
      <p className="muted">List the archives a destination holds for this account and import one the panel does not list above (after a reinstall, or made on another server). Encrypted copies are decrypted with the destination's key.</p>
      <div className="form-grid">
        <Field label="Destination"><Select value={destId} onChange={setDestId} options={(destinations.data || []).map((d) => ({ value: String(d.id), label: `${d.name} — ${KIND_LABELS[d.kind] || d.kind}${d.encrypted ? ' (encrypted)' : ''}` }))} placeholder={(destinations.data || []).length ? 'Choose a destination' : 'No destinations configured'} /></Field>
      </div>
      <RequestError error={destinations.error || listing.error || error} onRetry={listing.refetch} />
      {listing.data?.warnings?.length > 0 && <div className="banner banner-warning"><div>{listing.data.warnings.join('; ')}</div></div>}
      {destId && (
        <div className="table-wrap">
          <table className="dense">
            <thead><tr><th>Archive</th><th>Size</th><th>Modified</th><th>Encrypted</th><th /></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={`${a.name}-${a.encrypted ? 1 : 0}`}>
                  <td><code>{a.name}</code></td>
                  <td>{formatBytes(a.sizeBytes)}</td>
                  <td>{a.mtime ? formatDate(a.mtime) : '—'}</td>
                  <td>{a.encrypted ? <span className="pill pill-ok">encrypted</span> : <span className="pill pill-muted">plain</span>}</td>
                  <td className="row-actions"><button className="btn btn-sm" disabled={Boolean(busy)} onClick={() => importOne(a)}>{busy === a.name ? 'Queuing…' : 'Import'}</button></td>
                </tr>
              ))}
              {!listing.loading && listing.data && rows.length === 0 && <tr><td colSpan={5} className="table-state">No archives for {account || 'this account'} on this destination.</td></tr>}
              {listing.loading && !listing.data && <tr><td colSpan={5} className="table-state"><span className="spinner" /> Listing…</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {jobId && <ProgressLog jobId={jobId} onFinished={(e) => { if (e.type === 'done') onImported?.(); }} />}
    </details>
  );
}

export function FetchButton({ backup, onQueued }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!backup || backup.local_present) return null;
  const fetchIt = async () => {
    setBusy(true); setError(null);
    try { const { data } = await api.post(`/backup/backups/${backup.id}/fetch`); onQueued?.(data.job.id); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <>
      <button className="btn" disabled={busy} onClick={fetchIt}>{busy ? 'Queuing…' : 'Fetch archive from destination'}</button>
      <RequestError error={error} />
    </>
  );
}

const EMPTY = {
  local: { dir: '/backup/offsite' },
  ftp: { host: '', port: 21, username: '', password: '', path: '', tls: false, insecure: false, passive: true },
  sftp: { host: '', port: 22, username: '', password: '', privateKey: '', hostKeySha256: '', path: '', insecure: false },
  webdav: { url: '', username: '', password: '', insecure: false },
  s3: { endpoint: '', region: 'us-east-1', bucket: '', prefix: '', accessKey: '', secretKey: '', pathStyle: false, insecure: false },
  gdrive: { folder: 'whm-backups' },
  onedrive: { folder: 'whm-backups' },
  dropbox: { folder: 'whm-backups' },
  azureblob: { account: '', container: '', prefix: '', accountKey: '', sasToken: '', endpoint: '' },
  b2: { keyId: '', applicationKey: '', bucket: '', prefix: '' },
};

export function emptyDestination(kind) { return { kind, ...EMPTY[kind] }; }

const SECRET_FIELDS = ['password', 'secretKey', 'privateKey', 'accountKey', 'sasToken', 'applicationKey'];

// Strips blanks the API would reject and keeps the shape of the agent schema.
// On an edit a blank secret is sent as '' so the server keeps the stored one;
// what the API only reports (connected account, key date) never goes back.
export function cleanDestination(cfg, { editing = false } = {}) {
  const out = { kind: cfg.kind };
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'kind' || READ_ONLY_FIELDS.includes(k)) continue;
    if (v === '' || v === null || v === undefined) {
      if ((cfg.kind === 'ftp' && k === 'password') || (editing && SECRET_FIELDS.includes(k))) out[k] = '';
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function DestinationFields({ value, onChange, errors = {}, editing = false }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const err = (k) => errors[`config.${k}`];
  const secretHelp = editing ? 'Leave blank to keep the stored value' : undefined;
  const oauth = ['gdrive', 'onedrive', 'dropbox'].includes(value.kind);
  return (
    <div className="form-grid">
      <Field label="Type" required><Select value={value.kind} onChange={(kind) => onChange(emptyDestination(kind))} options={Object.entries(KIND_LABELS).map(([k, label]) => ({ value: k, label }))} disabled={editing} /></Field>
      {oauth && <Field label="Folder" error={err('folder')} help="Path inside the connected account; created on the first upload. The account is connected after saving."><TextInput value={value.folder} onChange={(v) => set('folder', v.trim())} placeholder="whm-backups" /></Field>}
      {value.kind === 'gdrive' && <Field label="Root folder ID (optional)" error={err('rootFolderId')} help="Drive folder ID to use as the root instead of My Drive (shared drives, a dedicated folder)"><TextInput value={value.rootFolderId || ''} onChange={(v) => set('rootFolderId', v.trim())} /></Field>}
      {value.kind === 'azureblob' && (
        <>
          <Field label="Storage account" required error={err('account')}><TextInput value={value.account} onChange={(v) => set('account', v.trim().toLowerCase())} /></Field>
          <Field label="Container" required error={err('container')}><TextInput value={value.container} onChange={(v) => set('container', v.trim().toLowerCase())} /></Field>
          <Field label="Prefix (folder)" error={err('prefix')}><TextInput value={value.prefix} onChange={(v) => set('prefix', v.trim())} placeholder="hst/" /></Field>
          <Field label="Account key" error={err('accountKey')} help={secretHelp || 'Either the account key or a container SAS token'}><PasswordInput value={value.accountKey} onChange={(v) => set('accountKey', v)} showStrength={false} allowGenerate={false} autoComplete="new-password" /></Field>
          <Field label="SAS token" error={err('sasToken')} help={secretHelp || 'Query string of a container SAS with read, write, list and delete (used when no account key is given)'}><PasswordInput value={value.sasToken} onChange={(v) => set('sasToken', v.trim())} showStrength={false} allowGenerate={false} autoComplete="new-password" /></Field>
          <Field label="Endpoint (optional)" error={err('endpoint')} help="Leave empty for the public cloud; e.g. https://account.blob.core.chinacloudapi.cn"><TextInput value={value.endpoint} onChange={(v) => set('endpoint', v.trim())} /></Field>
        </>
      )}
      {value.kind === 'b2' && (
        <>
          <Field label="Application key ID" required error={err('keyId')}><TextInput value={value.keyId} onChange={(v) => set('keyId', v.trim())} autoComplete="off" /></Field>
          <Field label="Application key" required={!editing} error={err('applicationKey')} help={secretHelp}><PasswordInput value={value.applicationKey} onChange={(v) => set('applicationKey', v.trim())} showStrength={false} allowGenerate={false} autoComplete="new-password" /></Field>
          <Field label="Bucket" required error={err('bucket')}><TextInput value={value.bucket} onChange={(v) => set('bucket', v.trim())} /></Field>
          <Field label="Prefix (folder)" error={err('prefix')}><TextInput value={value.prefix} onChange={(v) => set('prefix', v.trim())} placeholder="hst/" /></Field>
        </>
      )}
      {value.kind === 'local' && <Field label="Directory" required error={err('dir')} help="A second local copy, e.g. a mounted drive under /backup or /var/backups/whm"><TextInput value={value.dir} onChange={(v) => set('dir', v)} /></Field>}
      {(value.kind === 'ftp' || value.kind === 'sftp') && (
        <>
          <Field label="Host" required error={err('host')}><TextInput value={value.host} onChange={(v) => set('host', v.trim().toLowerCase())} placeholder="backup.example.com" /></Field>
          <Field label="Port" error={err('port')}><NumberInput value={value.port} onChange={(v) => set('port', v ?? (value.kind === 'ftp' ? 21 : 22))} nullable={false} min={1} max={65535} /></Field>
          <Field label="Username" required error={err('username')}><TextInput value={value.username} onChange={(v) => set('username', v)} autoComplete="off" /></Field>
          <Field label="Password" error={err('password')} help={secretHelp}><PasswordInput value={value.password} onChange={(v) => set('password', v)} showStrength={false} allowGenerate={false} autoComplete="new-password" /></Field>
          <Field label="Remote directory" error={err('path')} help={value.kind === 'ftp' ? 'Relative to the login directory; start with / for an absolute path' : 'Absolute path, or ~/dir for the home directory'}><TextInput value={value.path} onChange={(v) => set('path', v)} placeholder={value.kind === 'ftp' ? 'backups' : '~/backups'} /></Field>
        </>
      )}
      {value.kind === 'ftp' && (
        <>
          <Field inline><Toggle checked={value.tls} onChange={(v) => set('tls', v)} label="Require TLS (FTPS, explicit)" /></Field>
          <Field inline><Toggle checked={value.passive} onChange={(v) => set('passive', v)} label="Passive mode" /></Field>
          <Field inline><Toggle checked={value.insecure} onChange={(v) => set('insecure', v)} label="Skip TLS certificate verification" description="Only for self-signed servers you control" /></Field>
        </>
      )}
      {value.kind === 'sftp' && (
        <>
          <Field label="Private key (PEM, optional)" error={err('privateKey')} help={secretHelp || 'Used instead of, or in addition to, the password'}><Textarea value={value.privateKey} onChange={(v) => set('privateKey', v)} rows={4} mono /></Field>
          <Field label="Host key SHA-256" required={!value.insecure} error={err('hostKeySha256')} help="Base64 fingerprint as printed by ssh-keyscan host | ssh-keygen -lf -. Pins the server identity; required unless verification is skipped below."><TextInput value={value.hostKeySha256} onChange={(v) => set('hostKeySha256', v.trim())} /></Field>
          <Field inline><Toggle checked={value.insecure} onChange={(v) => set('insecure', v)} label="Skip host key verification" description="Not recommended: the connection can be intercepted. Ignored when a fingerprint is set." /></Field>
        </>
      )}
      {value.kind === 'webdav' && (
        <>
          <Field label="URL" required error={err('url')} help="Collection the archives are uploaded into, e.g. https://cloud.example.com/remote.php/dav/files/user/backups"><TextInput value={value.url} onChange={(v) => set('url', v.trim())} /></Field>
          <Field label="Username" error={err('username')}><TextInput value={value.username} onChange={(v) => set('username', v)} autoComplete="off" /></Field>
          <Field label="Password" error={err('password')} help={secretHelp}><PasswordInput value={value.password} onChange={(v) => set('password', v)} showStrength={false} allowGenerate={false} autoComplete="new-password" /></Field>
          <Field inline><Toggle checked={value.insecure} onChange={(v) => set('insecure', v)} label="Skip TLS certificate verification" /></Field>
        </>
      )}
      {value.kind === 's3' && (
        <>
          <Field label="Bucket" required error={err('bucket')}><TextInput value={value.bucket} onChange={(v) => set('bucket', v.trim())} /></Field>
          <Field label="Region" error={err('region')}><TextInput value={value.region} onChange={(v) => set('region', v.trim())} placeholder="us-east-1" /></Field>
          <Field label="Endpoint (optional)" error={err('endpoint')} help="Leave empty for AWS; e.g. https://s3.us-west-004.backblazeb2.com for B2, http://minio.local:9000 for MinIO"><TextInput value={value.endpoint} onChange={(v) => set('endpoint', v.trim())} /></Field>
          <Field label="Key prefix (folder)" error={err('prefix')}><TextInput value={value.prefix} onChange={(v) => set('prefix', v.trim())} placeholder="whm/" /></Field>
          <Field label="Access key" required error={err('accessKey')}><TextInput value={value.accessKey} onChange={(v) => set('accessKey', v.trim())} autoComplete="off" /></Field>
          <Field label="Secret key" required={!editing} error={err('secretKey')} help={secretHelp}><PasswordInput value={value.secretKey} onChange={(v) => set('secretKey', v)} showStrength={false} allowGenerate={false} autoComplete="new-password" /></Field>
          <Field inline><Toggle checked={value.pathStyle} onChange={(v) => set('pathStyle', v)} label="Path-style addressing" description="Required by MinIO and some self-hosted gateways" /></Field>
          <Field inline><Toggle checked={value.insecure} onChange={(v) => set('insecure', v)} label="Skip TLS certificate verification" /></Field>
          {!encryptionOn(value) && <Field inline><Toggle checked={value.transport === 'rclone'} onChange={(v) => set('transport', v ? 'rclone' : 'native')} label="Transfer with rclone" description="Multipart uploads (no 5 GB single-object limit); needs rclone on the server. Encrypted destinations always use it." /></Field>}
        </>
      )}
      {editing && value.crypt
        ? <Field inline><span className="pill pill-ok">Encrypted at rest</span> <span className="muted">Archives on this destination are encrypted (rclone crypt). Encryption cannot be turned off.</span></Field>
        : <Field inline><Toggle checked={encryptionOn(value)} onChange={(v) => set('crypt', v)} label="Encrypt archives at rest (recommended)" description="File names and contents are encrypted before they leave the server (rclone crypt). A key is generated and shown once after saving; keep a copy. It cannot be turned off later." /></Field>}
    </div>
  );
}
