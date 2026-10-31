import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

const authState = { user: { id: 1, username: 'root', role: 'root' } };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: authState.user, refresh: async () => {} }) }));

// Pages read through useApi; the mock answers by path prefix so each render is
// a deterministic snapshot of one server state.
const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!enabled || !path) return { data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
    const hit = [...responses.entries()].find(([k]) => (k instanceof RegExp ? k.test(path) : path.startsWith(k)));
    const r = hit ? hit[1] : null;
    return { data: r?.data ?? null, meta: r?.meta ?? null, error: r?.error ?? null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { ProviderCards, EncryptionKeyNotice, ConnectLink, OAuthClientModal, destinationTarget, uploadMethod, needsRclone, encryptionOn, connectUrl, READ_ONLY_FIELDS } = await import('../src/pages/backup/CloudProviders.jsx');
const { cleanDestination, emptyDestination, destinationFormState, DestinationFields, CloudCopies, KIND_LABELS } = await import('../src/pages/backup/Shared.jsx');
const BackupConfiguration = (await import('../src/pages/fn/backup/backup-configuration.jsx')).default;

React.useLayoutEffect = React.useEffect;
const render = (el, { initialEntries } = {}) => renderToStaticMarkup(
  <ToastProvider><ConfirmProvider><MemoryRouter initialEntries={initialEntries}>{el}</MemoryRouter></ConfirmProvider></ToastProvider>,
);
const bare = (el) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

const provider = (kind, label, auth, extra = {}) => ({ kind, label, auth, description: `${label} description`, setup: `${label} setup steps`, destinations: 0, oauth: auth === 'oauth' ? { configured: false, app: null, redirectUri: `https://panel.example.com:2087/api/backup/destinations/oauth/${kind}/callback` } : null, ...extra });
const CATALOG = {
  rclone: { installed: true },
  providers: [
    provider('gdrive', 'Google Drive', 'oauth', { oauth: { configured: true, app: { clientId: '123.apps.googleusercontent.com', hasClientSecret: true }, redirectUri: 'https://panel.example.com:2087/api/backup/destinations/oauth/gdrive/callback' }, destinations: 1 }),
    provider('onedrive', 'Microsoft OneDrive', 'oauth'),
    provider('dropbox', 'Dropbox', 'oauth'),
    provider('s3', 'Amazon S3 / S3-compatible', 'keys'),
    provider('azureblob', 'Azure Blob Storage', 'keys'),
    provider('b2', 'Backblaze B2', 'keys'),
  ],
};
const DESTINATIONS = [
  { id: 1, name: 'google-drive', kind: 'gdrive', enabled: true, encrypted: true, engine: 'rclone', config: { folder: 'hst/backups', crypt: true, has_crypt_password: true, has_refresh_token: true, accountName: 'Alice Example' }, connection: { connected: true, account: 'Alice Example', email: 'alice@example.com', at: '2026-10-30T10:00:00Z' }, lastTest: { at: '2026-10-30 10:00:00', ok: true, message: 'Uploaded, listed and deleted a probe file' }, lastUpload: { at: '2026-10-30 02:00:00', ok: true, message: 'backup-10.30.2026_02-00-00_alice.tar.gz (alice)' } },
  { id: 2, name: 'offsite-s3', kind: 's3', enabled: true, encrypted: false, engine: 'native', config: { bucket: 'whm-backups', prefix: 'panel/', accessKey: 'AKIA', has_secret_key: true, crypt: false }, connection: null, lastTest: null, lastUpload: { at: '2026-10-30 02:00:00', ok: false, message: 'upload to s3: S3 responded 403 AccessDenied' } },
  { id: 3, name: 'dropbox-main', kind: 'dropbox', enabled: false, encrypted: true, engine: 'rclone', config: { folder: 'Apps/HST', crypt: true }, connection: { connected: false, account: null, email: null, at: null }, lastTest: null, lastUpload: null },
];

describe('cloud provider cards', () => {
  it('renders every provider by name, with the OAuth client state and the install prompt when rclone is missing', () => {
    const html = render(<ProviderCards catalog={CATALOG} onAdd={() => {}} onConfigure={() => {}} />);
    for (const name of ['Google Drive', 'Microsoft OneDrive', 'Dropbox', 'Amazon S3 / S3-compatible', 'Azure Blob Storage', 'Backblaze B2', 'Other storage']) expect(html).toContain(name);
    expect(html).toContain('OAuth client registered');
    expect(html).toContain('OAuth client needed');
    expect(html).toContain('Set up OAuth client');
    expect(html).toContain('1 configured');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Service not installed');
    const missing = render(<ProviderCards catalog={{ ...CATALOG, rclone: { installed: false } }} onAdd={() => {}} onConfigure={() => {}} />);
    expect(missing).toContain('Service not installed');
    expect(missing).toContain('rclone is not installed on this server');
    expect(missing).toContain('Install Distro Packages');
    expect(bare(<ProviderCards catalog={null} onAdd={() => {}} onConfigure={() => {}} />)).toBe('');
  });

  it('the OAuth client modal shows the redirect URI to register and keeps the stored secret on a blank update', () => {
    const html = render(<OAuthClientModal provider={CATALOG.providers[0]} open onClose={() => {}} />);
    expect(html).toContain('https://panel.example.com:2087/api/backup/destinations/oauth/gdrive/callback');
    expect(html).toContain('Leave blank to keep the stored secret');
    expect(html).toContain('Remove client');
    expect(html).toContain('Google Drive setup steps');
    const fresh = render(<OAuthClientModal provider={CATALOG.providers[1]} open onClose={() => {}} />);
    expect(fresh).toContain('Stored encrypted; never shown again');
    expect(fresh).not.toContain('Remove client');
  });

  it('shows the encryption key once with a download and links the OAuth connect flow', () => {
    const key = { cryptPassword: 'pw-plain-value', cryptPassword2: 'salt-plain-value', fileName: 'hst-backup-key-google-drive.txt', text: 'Password:  pw-plain-value' };
    const html = render(<EncryptionKeyNotice encryptionKey={key} destinationName="google-drive" onAcknowledge={() => {}} />);
    expect(html).toContain('shown only once');
    expect(html).toContain('pw-plain-value');
    expect(html).toContain('salt-plain-value');
    expect(html).toContain('Download key file');
    expect(html).toContain('I saved it');
    expect(bare(<EncryptionKeyNotice encryptionKey={null} destinationName="x" />)).toBe('');
    expect(render(<ConnectLink destination={DESTINATIONS[2]} />)).toContain('href="/api/backup/destinations/oauth/dropbox/start?destination=3"');
    expect(render(<ConnectLink destination={DESTINATIONS[2]} />)).toContain('Connect account');
    expect(render(<ConnectLink destination={DESTINATIONS[0]} />)).toContain('Reconnect');
    expect(bare(<ConnectLink destination={DESTINATIONS[1]} />)).toBe('');
    expect(connectUrl('gdrive', 7)).toBe('/api/backup/destinations/oauth/gdrive/start?destination=7');
  });
});

describe('destination form payloads for the cloud kinds', () => {
  it('defaults encryption on for everything but a local copy and routes encrypted or cloud kinds through rclone', () => {
    expect(encryptionOn(emptyDestination('s3'))).toBe(true);
    expect(encryptionOn(emptyDestination('local'))).toBe(false);
    expect(encryptionOn({ kind: 's3', crypt: false })).toBe(false);
    expect(needsRclone(emptyDestination('gdrive'))).toBe(true);
    expect(needsRclone({ kind: 's3', crypt: false })).toBe(false);
    expect(needsRclone({ kind: 's3', crypt: false, transport: 'rclone' })).toBe(true);
    expect(uploadMethod({ kind: 's3', crypt: false })).toMatch(/Signature V4/);
    expect(uploadMethod(emptyDestination('azureblob'))).toMatch(/rclone through an encrypted/);
    expect(uploadMethod({ kind: 'local' })).toBe('File copy');
  });

  it('sends only what the API takes: no read-only fields, blank secrets kept on edit, OAuth kinds carry the folder only', () => {
    expect(cleanDestination(emptyDestination('gdrive'))).toEqual({ kind: 'gdrive', folder: 'whm-backups' });
    expect(cleanDestination({ ...emptyDestination('gdrive'), crypt: false })).toEqual({ kind: 'gdrive', folder: 'whm-backups', crypt: false });
    const edited = cleanDestination({ kind: 'gdrive', folder: 'hst', crypt: true, cryptSince: '2026-10-30', accountName: 'Alice', accountEmail: 'a@x', connectedAt: 'now', driveId: 'b!x', driveType: 'business' }, { editing: true });
    expect(edited).toEqual({ kind: 'gdrive', folder: 'hst', crypt: true });
    for (const f of READ_ONLY_FIELDS) expect(edited).not.toHaveProperty(f);
    const azure = cleanDestination({ ...emptyDestination('azureblob'), account: 'acct', container: 'backups', sasToken: 'sv=1&sig=x' });
    expect(azure).toEqual({ kind: 'azureblob', account: 'acct', container: 'backups', sasToken: 'sv=1&sig=x' });
    expect(cleanDestination({ ...emptyDestination('azureblob'), account: 'acct', container: 'backups' }, { editing: true })).toMatchObject({ accountKey: '', sasToken: '' });
    expect(cleanDestination({ ...emptyDestination('b2'), keyId: 'id', bucket: 'whm-backups' }, { editing: true })).toEqual({ kind: 'b2', keyId: 'id', applicationKey: '', bucket: 'whm-backups' });
    expect(Object.keys(KIND_LABELS)).toEqual(['gdrive', 'onedrive', 'dropbox', 's3', 'azureblob', 'b2', 'sftp', 'ftp', 'webdav', 'local']);
  });

  it('describes targets per kind and renders the provider-specific fields with the encryption toggle', () => {
    expect(destinationTarget(DESTINATIONS[0])).toBe('Alice Example: hst/backups');
    expect(destinationTarget(DESTINATIONS[1])).toBe('whm-backups/panel/');
    expect(destinationTarget({ kind: 'azureblob', config: { account: 'acct', container: 'c', prefix: 'p' } })).toBe('acct/c/p');
    expect(destinationTarget({ kind: 'b2', config: { bucket: 'b' } })).toBe('b/');
    expect(destinationTarget({ kind: 'sftp', config: { username: 'u', host: 'h', port: 22, path: 'x' } })).toBe('u@h:22/x');
    const azure = render(<DestinationFields value={emptyDestination('azureblob')} onChange={() => {}} />);
    for (const label of ['Storage account', 'Container', 'Account key', 'SAS token', 'Encrypt archives at rest (recommended)']) expect(azure).toContain(label);
    const b2 = render(<DestinationFields value={emptyDestination('b2')} onChange={() => {}} />);
    for (const label of ['Application key ID', 'Application key', 'Bucket']) expect(b2).toContain(label);
    const gdrive = render(<DestinationFields value={emptyDestination('gdrive')} onChange={() => {}} />);
    expect(gdrive).toContain('Folder');
    expect(gdrive).toContain('Root folder ID (optional)');
    expect(gdrive).not.toContain('Secret key');
    const editingEncrypted = render(<DestinationFields value={{ ...emptyDestination('s3'), crypt: true }} onChange={() => {}} editing />);
    expect(editingEncrypted).toContain('Encrypted at rest');
    expect(editingEncrypted).not.toContain('Encrypt archives at rest (recommended)');
    expect(editingEncrypted).not.toContain('Transfer with rclone');
    const plainS3 = render(<DestinationFields value={{ ...emptyDestination('s3'), crypt: false }} onChange={() => {}} />);
    expect(plainS3).toContain('Transfer with rclone');
  });

  it('the edit form shows the stored encryption state, not the default, for a destination from before encryption existed', () => {
    const legacy = { id: 9, name: 'legacy-s3', kind: 's3', enabled: true, encrypted: false, engine: 'native', config: { bucket: 'old-bucket', prefix: '', accessKey: 'AKIA', has_secret_key: true }, connection: null };
    const seeded = destinationFormState(legacy);
    expect(seeded).toEqual({ kind: 's3', endpoint: '', region: 'us-east-1', bucket: 'old-bucket', prefix: '', accessKey: 'AKIA', secretKey: '', pathStyle: false, insecure: false, crypt: false });
    expect(destinationFormState(DESTINATIONS[0])).toMatchObject({ kind: 'gdrive', folder: 'hst/backups', crypt: true, accountName: 'Alice Example' });
    expect(destinationFormState({ ...legacy, encrypted: true, config: { ...legacy.config, crypt: true } }).crypt).toBe(true);
    // Toggle off (no checked input anywhere on a plain S3 form) and sent as false, so an unrelated edit keeps the destination plain.
    const html = render(<DestinationFields value={seeded} onChange={() => {}} editing />);
    expect(html).toContain('Encrypt archives at rest (recommended)');
    expect(html).not.toContain('checked=""');
    expect(cleanDestination(seeded, { editing: true })).toEqual({ kind: 's3', bucket: 'old-bucket', accessKey: 'AKIA', secretKey: '', region: 'us-east-1', pathStyle: false, insecure: false, crypt: false });
    expect(cleanDestination({ ...seeded, crypt: true }, { editing: true }).crypt).toBe(true);
    // Even without the seeding, an edit never shows the create-time default as checked.
    expect(render(<DestinationFields value={emptyDestination('s3')} onChange={() => {}} editing />)).not.toContain('checked=""');
    expect(render(<DestinationFields value={emptyDestination('s3')} onChange={() => {}} />)).toContain('checked=""');
  });
});

describe('Backup Configuration page with cloud destinations', () => {
  it('renders the provider cards, the destinations with encryption, connection and last-upload state', () => {
    responses.clear();
    responses.set('/backup/config', { data: { settings: { 'backup.enabled': true, 'backup.schedule': '0 2 * * *', 'backup.retention_daily': 7, 'backup.retention_weekly': 4, 'backup.retention_monthly': 3, 'backup.local_dir': '/backup', 'backup.include_home': true, 'backup.include_mail': true, 'backup.include_dbs': true, 'backup.include_dns': true, 'backup.include_metadata': true, 'backup.compression_level': 6, 'backup.strict': false, 'backup.keep_local': true, 'backup.prune_remote': true, 'backup.default_include': true, 'backup.skip_suspended': false, 'backup.excludes': ['tmp'], 'backup.notify_on_failure': true }, status: { capability: { installed: true, binaries: { tar: true, gzip: true, curl: true, mysqldump: false, rclone: true } }, localDir: { path: '/backup', exists: true }, schedule: { enabled: 1, next_run_at: '2026-10-31 02:00:00' }, destinations: DESTINATIONS, lastRun: null, includedAccounts: 2, totalAccounts: 2 } } });
    responses.set('/backup/runs', { data: [] });
    responses.set('/backup/destinations/providers', { data: CATALOG });
    responses.set('/backup/destinations', { data: DESTINATIONS });
    const html = render(<BackupConfiguration fn={{ key: 'backup-configuration', label: 'Backup Configuration', path: '/backup/backup-configuration' }} />, { initialEntries: ['/backup/backup-configuration'] });
    expect(html).toContain('Cloud storage');
    for (const name of ['Google Drive', 'Microsoft OneDrive', 'Dropbox', 'Azure Blob Storage', 'Backblaze B2']) expect(html).toContain(name);
    expect(html).toContain('google-drive');
    expect(html).toContain('Alice Example (alice@example.com)');
    expect(html).toContain('encrypted');
    expect(html).toContain('plain');
    expect(html).toContain('not connected');
    expect(html).toContain('/api/backup/destinations/oauth/dropbox/start?destination=3');
    expect(html).toContain('backup-10.30.2026_02-00-00_alice.tar.gz (alice)');
    expect(html).toContain('S3 responded 403 AccessDenied');
    expect(html).toContain('rclone</span>');
    expect(html).not.toContain('has_refresh_token');
  });

  it('shows an OAuth destination whose sign-in expired with the reconnect link', () => {
    responses.clear();
    const expired = { ...DESTINATIONS[0], connection: { ...DESTINATIONS[0].connection, reauthRequired: true }, lastUpload: { at: '2026-10-31 02:00:00', ok: false, message: 'upload to gdrive: fatal error (authentication or configuration) (oauth2: invalid_grant)' } };
    responses.set('/backup/config', { data: { settings: {}, status: { capability: { installed: true, binaries: { tar: true, rclone: true } }, localDir: { path: '/backup', exists: true }, schedule: null, destinations: [expired], lastRun: null, includedAccounts: 1, totalAccounts: 1 } } });
    responses.set('/backup/runs', { data: [] });
    responses.set('/backup/destinations/providers', { data: CATALOG });
    responses.set('/backup/destinations', { data: [expired] });
    const html = render(<BackupConfiguration fn={{ key: 'backup-configuration', label: 'Backup Configuration', path: '/backup/backup-configuration' }} />, { initialEntries: ['/backup/backup-configuration'] });
    expect(html).toContain('sign-in expired');
    expect(html).not.toContain('>connected<');
    expect(html).toContain('/api/backup/destinations/oauth/gdrive/start?destination=1');
    expect(html).toContain('Reconnect');
    responses.set('/backup/destinations', { data: DESTINATIONS });
    responses.set('/backup/config', { data: { settings: {}, status: { capability: { installed: true, binaries: { tar: true, rclone: true } }, localDir: { path: '/backup', exists: true }, schedule: null, destinations: DESTINATIONS, lastRun: null, includedAccounts: 1, totalAccounts: 1 } } });
    const fine = render(<BackupConfiguration fn={{ key: 'backup-configuration', label: 'Backup Configuration', path: '/backup/backup-configuration' }} />, { initialEntries: ['/backup/backup-configuration'] });
    expect(fine).toContain('>connected<');
    expect(fine).not.toContain('sign-in expired');
  });

  it('the restore picker lists the copies a destination holds for the account', () => {
    responses.clear();
    responses.set('/backup/destinations/1/archives', { data: { destination: DESTINATIONS[0], archives: [{ name: 'backup-10.30.2026_02-00-00_alice.tar.gz', sizeBytes: 4096, mtime: '2026-10-30T02:00:00Z', username: 'alice', encrypted: true }, { name: 'backup-10.30.2026_02-00-00_bob.tar.gz', sizeBytes: 4096, mtime: null, username: 'bob', encrypted: false }], warnings: [] } });
    responses.set('/backup/destinations', { data: DESTINATIONS });
    const html = render(<CloudCopies account="alice" />);
    expect(html).toContain('Copies on destinations');
    expect(html).toContain('google-drive — Google Drive (encrypted)');
    expect(html).toContain('offsite-s3 — Amazon S3');
    // Nothing is listed until a destination is chosen; the section itself is root-only.
    expect(html).not.toContain('backup-10.30.2026_02-00-00_alice.tar.gz');
    authState.user = { id: 2, username: 'resell1', role: 'reseller' };
    try { expect(bare(<CloudCopies account="alice" />)).toBe(''); } finally { authState.user = { id: 1, username: 'root', role: 'root' }; }
  });
});
