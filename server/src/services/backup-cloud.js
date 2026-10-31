import crypto from 'node:crypto';
import { notFound, conflict, badRequest, unprocessable } from '../lib/errors.js';

// Cloud storage for backups. Attached as ctx.backupCloud; ctx.backup calls it
// for the OAuth client registry, the browser flows that connect a Google
// Drive / OneDrive / Dropbox destination, the at-rest encryption keys and the
// provider catalog the UI renders. Every rclone call itself goes through
// ctx.backup (agent ops backup.rclone.*).
//
//   backupCloud.providers()                                   -> catalog + OAuth client state + rclone capability
//   backupCloud.setOauthApp(provider, { clientId, clientSecret }, req)
//   backupCloud.beginConnect({ provider, destination, redirectUri }) -> { url, state, codeVerifier }
//   backupCloud.completeConnect({ provider, destination, code, codeVerifier, redirectUri }, req)
//   backupCloud.newEncryptionKey() / encryptionKeyFile(destination, key)
//   backupCloud.agentConfig(config)                           -> the config the agent ops take (OAuth client merged in, UI-only fields dropped)

export const OAUTH_KINDS = ['gdrive', 'onedrive', 'dropbox'];
export const RCLONE_ONLY_KINDS = ['gdrive', 'onedrive', 'dropbox', 'azureblob', 'b2'];
export const CLOUD_KINDS = ['gdrive', 'onedrive', 'dropbox', 's3', 'azureblob', 'b2'];
// Fields the panel keeps on a destination that the agent schema does not take.
const PANEL_ONLY_FIELDS = ['accountName', 'accountEmail', 'connectedAt', 'cryptSince', 'transport', 'reauthRequired'];
const STATE_TTL_MS = 10 * 60 * 1000;

export const PROVIDERS = [
  { kind: 'gdrive', label: 'Google Drive', auth: 'oauth', description: 'Archives go to a folder in the connected Google account (Drive API, files the panel creates only).', setup: 'Google Cloud console › APIs & Services › Credentials › OAuth client ID (Web application), with the Google Drive API enabled.' },
  { kind: 'onedrive', label: 'Microsoft OneDrive', auth: 'oauth', description: 'Personal OneDrive or OneDrive for Business through Microsoft Graph.', setup: 'Microsoft Entra admin center › App registrations › New registration (Web platform), then a client secret under Certificates & secrets.' },
  { kind: 'dropbox', label: 'Dropbox', auth: 'oauth', description: 'A folder in the connected Dropbox account.', setup: 'Dropbox App Console › Create app (Scoped access, Full Dropbox), permissions files.content.write, files.content.read and files.metadata.read.' },
  { kind: 's3', label: 'Amazon S3 / S3-compatible', auth: 'keys', description: 'AWS S3 and compatible services (Wasabi, MinIO, Cloudflare R2, DigitalOcean Spaces) with an access key pair.', setup: 'An IAM user or access key with PutObject, GetObject, DeleteObject and ListBucket on the bucket.' },
  { kind: 'azureblob', label: 'Azure Blob Storage', auth: 'keys', description: 'A container in an Azure storage account, with the account key or a container SAS token.', setup: 'Azure portal › Storage account › Access keys, or a SAS with read, write, list and delete on the container.' },
  { kind: 'b2', label: 'Backblaze B2', auth: 'keys', description: 'A B2 bucket with an application key.', setup: 'Backblaze › Application Keys › Add a new application key restricted to the bucket.' },
];

// Provider endpoints are constants: the panel never fetches an operator-supplied URL here.
const OAUTH = {
  gdrive: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/drive.file',
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' },
    async profile(accessToken) {
      const about = await fetchJson('https://www.googleapis.com/drive/v3/about?fields=user', { headers: { Authorization: `Bearer ${accessToken}` } });
      return { accountName: about?.user?.displayName || about?.user?.emailAddress || 'Google account', accountEmail: about?.user?.emailAddress || null };
    },
  },
  onedrive: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'Files.ReadWrite offline_access User.Read',
    authorizeParams: { response_mode: 'query', prompt: 'select_account' },
    async profile(accessToken) {
      const me = await fetchJson('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${accessToken}` } });
      const drive = await fetchJson('https://graph.microsoft.com/v1.0/me/drive', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!drive?.id || !/^[A-Za-z0-9!_-]{1,128}$/.test(drive.id)) throw new Error('Microsoft Graph returned no usable drive id for this account');
      const driveType = ['personal', 'business', 'documentLibrary'].includes(drive.driveType) ? drive.driveType : 'personal';
      return { accountName: me?.displayName || me?.userPrincipalName || 'Microsoft account', accountEmail: me?.mail || me?.userPrincipalName || null, driveId: drive.id, driveType };
    },
  },
  dropbox: {
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scope: null,
    authorizeParams: { token_access_type: 'offline' },
    async profile(accessToken) {
      const acct = await fetchJson('https://api.dropboxapi.com/2/users/get_current_account', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
      return { accountName: acct?.name?.display_name || acct?.email || 'Dropbox account', accountEmail: acct?.email || null };
    },
  },
};

// Fixed https provider endpoints only; redirects are not followed, the body is
// capped and only the fields the panel needs are read back. Tokens are never
// logged: the caller receives the parsed object and nothing else is kept.
export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15_000, maxBytes = 256 * 1024 } = {}) {
  if (!url.startsWith('https://')) throw new Error('only https:// provider endpoints are contacted');
  const res = await globalThis.fetch(url, { method, headers: { Accept: 'application/json', ...headers }, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  let text = '';
  if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('the provider response is too large');
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (res.status >= 300 && res.status < 400) throw new Error(`the provider answered with a redirect (HTTP ${res.status})`);
  if (!res.ok) {
    const code = typeof json?.error === 'string' ? json.error : json?.error?.code || json?.error?.message || json?.error_summary;
    throw new Error(`HTTP ${res.status}${code ? ` ${String(code).slice(0, 120)}` : ''}${typeof json?.error_description === 'string' ? `: ${json.error_description.slice(0, 200)}` : ''}`);
  }
  if (json === null) throw new Error('the provider response is not JSON');
  return json;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const pkceChallenge = (verifier) => b64url(crypto.createHash('sha256').update(verifier).digest());

export function authorizationUrl(provider, { clientId, redirectUri, state, codeChallenge }) {
  const p = OAUTH[provider];
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state, code_challenge: codeChallenge, code_challenge_method: 'S256', ...p.authorizeParams });
  if (p.scope) params.set('scope', p.scope);
  return `${p.authorizeUrl}?${params.toString()}`;
}

export function createBackupCloudService(ctx) {
  const { db, crypto: panelCrypto, capabilities, settings } = ctx;
  const stmts = {
    apps: db.prepare('SELECT provider, client_id, created_by, updated_at FROM backup_oauth_apps ORDER BY provider'),
    app: db.prepare('SELECT * FROM backup_oauth_apps WHERE provider = ?'),
    upsertApp: db.prepare(`INSERT INTO backup_oauth_apps (provider, client_id, client_secret_enc, created_by, updated_at) VALUES (@provider, @client_id, @client_secret_enc, @created_by, datetime('now'))
      ON CONFLICT (provider) DO UPDATE SET client_id = excluded.client_id, client_secret_enc = excluded.client_secret_enc, created_by = excluded.created_by, updated_at = datetime('now')`),
    deleteApp: db.prepare('DELETE FROM backup_oauth_apps WHERE provider = ?'),
    destinationsOfKind: db.prepare('SELECT COUNT(*) AS n FROM backup_destinations WHERE kind = ?'),
  };
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req ?? null, entry));

  // The address the providers must be told about: the panel's own hostname on
  // its TLS port, whatever address the browser happens to use right now.
  function redirectUri(provider) {
    const host = String(settings.get('basic.hostname', '') || '').trim().toLowerCase() || 'localhost';
    const config = ctx.config || {};
    const origin = config.tls === false ? `http://${host}:${config.port ?? 2086}` : `https://${host}:${config.tlsPort ?? 2087}`;
    return `${origin}/api/backup/destinations/oauth/${provider}/callback`;
  }

  function shapeApp(row) {
    return row ? { provider: row.provider, clientId: row.client_id, hasClientSecret: true, updated_at: row.updated_at, created_by: row.created_by } : null;
  }

  async function providers() {
    await capabilities.ensureFresh();
    const apps = new Map(stmts.apps.all().map((r) => [r.provider, r]));
    return {
      rclone: { installed: capabilities.has('rclone') },
      providers: PROVIDERS.map((p) => ({
        ...p,
        oauth: p.auth === 'oauth' ? { configured: apps.has(p.kind), app: shapeApp(apps.get(p.kind)), redirectUri: redirectUri(p.kind) } : null,
        destinations: stmts.destinationsOfKind.get(p.kind).n,
      })),
    };
  }

  function listOauthApps() {
    return OAUTH_KINDS.map((provider) => ({ provider, redirectUri: redirectUri(provider), ...(shapeApp(stmts.app.get(provider)) || { clientId: null, hasClientSecret: false }) }));
  }

  // An empty secret on an update keeps the stored one.
  function setOauthApp(provider, { clientId, clientSecret }, req) {
    if (!OAUTH_KINDS.includes(provider)) throw notFound('OAuth provider');
    const current = stmts.app.get(provider);
    const secret = clientSecret || null;
    if (!secret && !current) throw unprocessable('The client secret is required', { clientSecret: ['Required when registering the client'] });
    stmts.upsertApp.run({ provider, client_id: clientId, client_secret_enc: secret ? panelCrypto.encrypt(secret) : current.client_secret_enc, created_by: req?.user?.username ?? null });
    audit(req, { action: 'backup.oauth_app.set', target: provider, args: { clientId, secretChanged: Boolean(secret) } });
    return { provider, redirectUri: redirectUri(provider), ...shapeApp(stmts.app.get(provider)) };
  }

  function removeOauthApp(provider, req) {
    if (!stmts.app.get(provider)) throw notFound('OAuth client');
    stmts.deleteApp.run(provider);
    audit(req, { action: 'backup.oauth_app.remove', target: provider });
    return { provider, removed: true };
  }

  function oauthApp(provider) {
    const row = stmts.app.get(provider);
    if (!row) throw conflict(`No OAuth client is registered for ${PROVIDERS.find((p) => p.kind === provider)?.label || provider}; add its client ID and secret under Backup Configuration › Cloud storage first`);
    return { clientId: row.client_id, clientSecret: panelCrypto.decrypt(row.client_secret_enc) };
  }

  function beginConnect({ provider, destination, redirectUri: uri }) {
    if (!OAUTH_KINDS.includes(provider)) throw notFound('OAuth provider');
    if (destination.kind !== provider) throw badRequest(`Destination "${destination.name}" is a ${destination.kind} destination, not ${provider}`);
    const app = oauthApp(provider);
    const state = panelCrypto.randomToken(24);
    const codeVerifier = panelCrypto.randomToken(48);
    return { url: authorizationUrl(provider, { clientId: app.clientId, redirectUri: uri, state, codeChallenge: pkceChallenge(codeVerifier) }), state, codeVerifier, ttlMs: STATE_TTL_MS };
  }

  // Exchanges the code server-side and reads the account's display name (and
  // the drive id OneDrive needs); returns the fields to merge into the
  // destination config. Nothing of the token response is logged or returned
  // beyond the refresh token itself.
  async function completeConnect({ provider, code, codeVerifier, redirectUri: uri }) {
    const p = OAUTH[provider];
    if (!p) throw notFound('OAuth provider');
    const app = oauthApp(provider);
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: uri, client_id: app.clientId, client_secret: app.clientSecret, code_verifier: codeVerifier });
    let tokens;
    try {
      tokens = await fetchJson(p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    } catch (err) { throw badRequest(`${PROVIDERS.find((x) => x.kind === provider).label} refused the authorization code: ${err.message}`); }
    const refreshToken = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : '';
    if (!refreshToken || /[\s"'`#;\0]/.test(refreshToken) || refreshToken.length > 8192) throw badRequest('The provider returned no refresh token. Remove the panel from the account\'s connected apps and connect again so a new consent is granted.');
    const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : '';
    let profile;
    try { profile = await p.profile(accessToken); } catch (err) { throw badRequest(`The account could not be read after connecting: ${err.message}`); }
    return { refreshToken, ...profile, connectedAt: new Date().toISOString() };
  }

  // rclone's crypt remote takes a password and a salt ("password2"); both are
  // random, stored encrypted on the destination and shown to the operator once.
  function newEncryptionKey() {
    return { cryptPassword: panelCrypto.randomToken(32), cryptPassword2: panelCrypto.randomToken(24) };
  }

  function encryptionKeyFile(destination, key) {
    const label = PROVIDERS.find((p) => p.kind === destination.kind)?.label || destination.kind;
    const text = [
      `HST Panel backup encryption key — destination "${destination.name}" (${label})`,
      `Generated ${new Date().toISOString()}`,
      '',
      'Archives on this destination are encrypted with rclone\'s crypt backend',
      '(filename and content encryption). Without this key the files in the',
      'cloud cannot be read, by the panel after a reinstall or by anyone else.',
      '',
      `Password:  ${key.cryptPassword}`,
      `Salt:      ${key.cryptPassword2}`,
      '',
      'To read the archives outside the panel, run "rclone config", create the',
      'backend remote for the storage account, then a remote of type "crypt"',
      'on top of it (filename_encryption = standard, directory_name_encryption',
      '= true) and enter the password and the salt above when asked.',
      '',
    ].join('\n');
    return { fileName: `hst-backup-key-${destination.name.replace(/[^A-Za-z0-9._-]+/g, '-')}.txt`, text };
  }

  // What the agent ops take: OAuth client credentials merged in for OAuth
  // kinds, panel-only bookkeeping dropped.
  function agentConfig(config) {
    const out = {};
    for (const [k, v] of Object.entries(config)) if (!PANEL_ONLY_FIELDS.includes(k)) out[k] = v;
    if (OAUTH_KINDS.includes(config.kind)) {
      if (!config.refreshToken) throw conflict(`This ${PROVIDERS.find((p) => p.kind === config.kind).label} destination is not connected yet; use "Connect" to sign in to the account`);
      Object.assign(out, oauthApp(config.kind));
    }
    return out;
  }

  const needsRclone = (config) => RCLONE_ONLY_KINDS.includes(config.kind) || Boolean(config.crypt) || config.transport === 'rclone';

  return { providers, listOauthApps, setOauthApp, removeOauthApp, redirectUri, beginConnect, completeConnect, newEncryptionKey, encryptionKeyFile, agentConfig, needsRclone, stateTtlMs: STATE_TTL_MS };
}
