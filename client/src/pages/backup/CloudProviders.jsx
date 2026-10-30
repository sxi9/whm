import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { CapabilityNotice, KeyValue } from '../../components/Common.jsx';
import { Field, TextInput, PasswordInput, Button, ErrorBanner } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';

export const OAUTH_KINDS = ['gdrive', 'onedrive', 'dropbox'];
export const RCLONE_ONLY_KINDS = ['gdrive', 'onedrive', 'dropbox', 'azureblob', 'b2'];
// Fields the API returns on a destination that are never sent back on an edit.
export const READ_ONLY_FIELDS = ['cryptSince', 'accountName', 'accountEmail', 'connectedAt', 'driveId', 'driveType'];

export const connectUrl = (kind, id) => `/api/backup/destinations/oauth/${encodeURIComponent(kind)}/start?destination=${encodeURIComponent(id)}`;
// Mirrors the server default: everything but a plain local copy is encrypted.
export const encryptionOn = (cfg) => cfg.crypt ?? cfg.kind !== 'local';
export const needsRclone = (cfg) => RCLONE_ONLY_KINDS.includes(cfg.kind) || encryptionOn(cfg) || cfg.transport === 'rclone';

export function uploadMethod(cfg) {
  if (needsRclone(cfg)) return `rclone${encryptionOn(cfg) ? ' through an encrypted (crypt) remote: file names and contents are ciphertext in the cloud' : ''}; the configuration is rendered into a root-only temporary file for each transfer and removed afterwards`;
  if (cfg.kind === 's3') return 'Single signed PUT (AWS Signature V4) straight from the panel; archives above 5 GB exceed the single-PUT object limit of AWS and most providers (enable rclone transfers or encryption for multipart uploads)';
  if (cfg.kind === 'local') return 'File copy';
  return 'curl with a private config file (credentials never appear on the command line)';
}

export function destinationTarget(d) {
  const c = d.config || {};
  switch (d.kind) {
    case 's3': return `${c.bucket}/${c.prefix || ''}`;
    case 'azureblob': return `${c.account}/${c.container}/${c.prefix || ''}`;
    case 'b2': return `${c.bucket}/${c.prefix || ''}`;
    case 'gdrive': case 'onedrive': case 'dropbox': return `${d.connection?.account ? `${d.connection.account}: ` : ''}${c.folder || '/'}`;
    case 'webdav': return c.url;
    case 'local': return c.dir;
    default: return `${c.username}@${c.host}:${c.port}/${c.path || ''}`;
  }
}

// Provider cards: names and what each needs, no logos. OAuth providers need a
// registered client before a destination can be added.
export function ProviderCards({ catalog, error, onRetry, onAdd, onConfigure }) {
  if (error) return error.status === 501 || error.code === 'capability_missing' ? <CapabilityNotice error={error} capability="rclone" onRetry={onRetry} /> : <ErrorBanner error={error} onRetry={onRetry} />;
  if (!catalog) return null;
  return (
    <>
      {!catalog.rclone?.installed && <CapabilityNotice error={{ code: 'capability_missing', message: 'rclone is not installed on this server. Cloud providers (Google Drive, OneDrive, Dropbox, Azure Blob, Backblaze B2) and encrypted uploads need it; plain local, FTP, SFTP, WebDAV and S3 destinations keep working without it.' }} capability="rclone" onRetry={onRetry} />}
      <div className="tool-grid">
        {catalog.providers.map((p) => (
          <div key={p.kind} className="tool-card" data-provider={p.kind}>
            <div className="tool-link" style={{ padding: '10px 12px' }}>
              <strong>{p.label}</strong>
              <small>{p.description}</small>
              <small>
                <span className={`pill ${p.auth === 'oauth' ? 'pill-info' : 'pill-muted'}`}>{p.auth === 'oauth' ? 'Sign-in (OAuth)' : 'Access keys'}</span>{' '}
                {p.oauth && (p.oauth.configured ? <span className="pill pill-ok">OAuth client registered</span> : <span className="pill pill-warn">OAuth client needed</span>)}{' '}
                {p.destinations > 0 && <span className="pill pill-muted">{p.destinations} configured</span>}
              </small>
              <div className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 6, flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-primary" onClick={() => onAdd(p.kind)} disabled={Boolean(p.oauth) && !p.oauth.configured} title={p.oauth && !p.oauth.configured ? 'Register the OAuth client first' : undefined}>Add destination</button>
                {p.oauth && <button className="btn btn-sm" onClick={() => onConfigure(p)}>{p.oauth.configured ? 'OAuth client' : 'Set up OAuth client'}</button>}
              </div>
            </div>
          </div>
        ))}
        <div className="tool-card" data-provider="other">
          <div className="tool-link" style={{ padding: '10px 12px' }}>
            <strong>Other storage</strong>
            <small>SFTP, FTP / FTPS, WebDAV (Nextcloud, ownCloud) or a second local directory, with the same at-rest encryption.</small>
            <div className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 6 }}>
              <button className="btn btn-sm btn-primary" onClick={() => onAdd('sftp')}>Add destination</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function OAuthClientModal({ provider, open, onClose, onSaved }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setClientId(provider?.oauth?.app?.clientId || ''); setClientSecret(''); setError(null); }, [provider, open]);
  if (!provider) return null;
  const configured = Boolean(provider.oauth?.configured);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { clientId: clientId.trim() };
      if (clientSecret) body.clientSecret = clientSecret;
      await api.put(`/backup/destinations/oauth-apps/${provider.kind}`, body);
      onSaved?.(); onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(null);
    try { await api.delete(`/backup/destinations/oauth-apps/${provider.kind}`); onSaved?.(); onClose(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  let origin = '';
  try { origin = new URL(provider.oauth?.redirectUri || '').origin; } catch { origin = ''; }
  return (
    <Modal open={open} title={`${provider.label} — OAuth client`} onClose={onClose} size="lg"
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          {configured && <Button variant="danger" disabled={busy} onClick={remove}>Remove client</Button>}
          <Button variant="primary" loading={busy} disabled={!clientId.trim() || (!configured && !clientSecret)} onClick={save}>Save</Button>
        </>
      )}>
      <ErrorBanner error={error} />
      <p className="muted">{provider.setup}</p>
      <KeyValue items={[
        ['Redirect URI to register', <code>{provider.oauth?.redirectUri}</code>],
        origin && ['Open the panel at', <span><code>{origin}</code> when connecting an account, so the sign-in returns to the address the provider knows.</span>],
      ]} />
      <div className="form-grid">
        <Field label="Client ID" required error={error?.fields?.clientId}><TextInput value={clientId} onChange={setClientId} autoComplete="off" /></Field>
        <Field label="Client secret" required={!configured} error={error?.fields?.clientSecret} help={configured ? 'Leave blank to keep the stored secret' : 'Stored encrypted; never shown again'}><PasswordInput value={clientSecret} onChange={setClientSecret} showStrength={false} allowGenerate={false} autoComplete="new-password" /></Field>
      </div>
      <p className="muted">Step-by-step instructions for each provider: manual, Backup › Cloud storage (docs/design/backup-cloud.md).</p>
    </Modal>
  );
}

export function downloadTextFile(fileName, text) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// Shown once, right after a destination is created or encryption is enabled.
export function EncryptionKeyNotice({ encryptionKey, destinationName, onAcknowledge }) {
  if (!encryptionKey) return null;
  return (
    <div className="banner banner-warning" data-testid="encryption-key">
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>Save the encryption key for {destinationName} now — it is shown only once.</strong>
        <p>Archives on this destination are encrypted before they leave the server (file names and contents). The panel keeps the key encrypted in its database; without your own copy the archives cannot be read after a reinstall or from another machine. Encryption cannot be turned off later.</p>
        <KeyValue items={[['Password', <code>{encryptionKey.cryptPassword}</code>], ['Salt', <code>{encryptionKey.cryptPassword2}</code>]]} />
        <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn btn-sm btn-primary" onClick={() => downloadTextFile(encryptionKey.fileName, encryptionKey.text)}>Download key file</button>
          {onAcknowledge && <button className="btn btn-sm" onClick={onAcknowledge}>I saved it</button>}
        </div>
      </div>
    </div>
  );
}

export function ConnectLink({ destination, className = 'btn btn-sm' }) {
  if (!destination || !OAUTH_KINDS.includes(destination.kind)) return null;
  return <a className={className} href={connectUrl(destination.kind, destination.id)}>{destination.connection?.connected ? 'Reconnect' : 'Connect account'}</a>;
}
