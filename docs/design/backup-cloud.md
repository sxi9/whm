# Cloud storage destinations with encryption — design of record

Owner's ask: "allow binding OneDrive, Google Drive, AWS, Azure Blob and others for storage;
all must be encrypted". Backup Configuration › Destinations gains provider cards for
Google Drive, Microsoft OneDrive, Dropbox, Amazon S3 / S3-compatible, Azure Blob Storage and
Backblaze B2, every destination is encrypted at rest by default, and the restore picker can
list and import the copies a destination holds.

## Provider matrix

| Kind | Label | Auth | Transport | Path inside the remote | Notes |
|---|---|---|---|---|---|
| `gdrive` | Google Drive | OAuth 2.0 (PKCE S256, `access_type=offline`, `prompt=consent`) | rclone `drive`, scope `drive.file` | `folder` (default `whm-backups`) | The panel only sees files it created. `rootFolderId` optional. |
| `onedrive` | Microsoft OneDrive | OAuth 2.0 (PKCE, scopes `Files.ReadWrite offline_access User.Read`) | rclone `onedrive` with `drive_id`/`drive_type` read from Graph `/me/drive` at connect time | `folder` | Personal and business drives. |
| `dropbox` | Dropbox | OAuth 2.0 (PKCE, `token_access_type=offline`) | rclone `dropbox` | `folder` | Scoped app with `files.content.write/read`, `files.metadata.read`. |
| `s3` | Amazon S3 / compatible | access key + secret | native SigV4 (as before) **or** rclone `s3` (`transport: 'rclone'`, or always when encrypted) | `bucket/prefix` | Wasabi, MinIO, R2, Spaces via `endpoint` + `pathStyle`. rclone lifts the 5 GB single-PUT limit (multipart). |
| `azureblob` | Azure Blob Storage | storage account key **or** container SAS token | rclone `azureblob` (`key` or `sas_url = <endpoint>/<container>?<sas>`) | `container/prefix` | `endpoint` optional for sovereign clouds. |
| `b2` | Backblaze B2 | application key id + key | rclone `b2` | `bucket/prefix` | — |
| `local`, `ftp`, `sftp`, `webdav` | (as before) | (as before) | curl / file copy, **or** rclone (`local`/`ftp`/`sftp`/`webdav` backends) when encrypted | `dir` / `path` / URL | SFTP host-key pinning is kept: the pinned key becomes rclone's `known_hosts_file`. |

`rclone` is a new capability (binary `rclone`, registered by the backup category; the stack
catalog component and the `CapabilityNotice` label are the integrator's — see the hand-off).
Without it, every cloud kind and every encrypted destination answers `501 capability_missing`
with `capability: 'rclone'`, and the provider cards show the install prompt. Plain
local/FTP/SFTP/WebDAV/S3 destinations keep working without rclone exactly as before.

## What is stored where

| Data | Where | Protection |
|---|---|---|
| Destination configuration (`folder`, `bucket`, `account`, `prefix`, flags) | `backup_destinations.config_enc` (JSON) | AES-256-GCM with the panel master key (`lib/crypto.js`) |
| Provider credentials: `secretKey`, `accountKey`, `sasToken`, `applicationKey`, `password`, `privateKey` | same JSON | same; the API returns `has_<field>` booleans only |
| OAuth refresh token (`refreshToken`), account display name/email, `driveId`/`driveType`, `connectedAt` | same JSON | same; never in responses, logs or audit rows (field names match the audit redaction regex: `token`, `key`, `secret`, `password`) |
| Encryption key (`cryptPassword`, `cryptPassword2`) + `crypt: true`, `cryptSince` | same JSON | same; **returned exactly once** (`encryptionKey` on the create / enable-encryption response) with a downloadable text |
| OAuth client per provider (`client_id`, `client_secret_enc`) | `backup_oauth_apps` | secret encrypted; `hasClientSecret` only in responses |
| Per-copy transport (`backup_uploads.encrypted`) | `backup_uploads` | — |
| Last upload outcome per destination (`last_upload_at/ok/message`) | `backup_destinations` | — |
| OAuth flow state (`state`, PKCE `code_verifier`, destination id, redirect URI, timestamp) | the root session (`req.session.backupOauth`), 10 min TTL, consumed on the first callback | server-side session store |
| rclone configuration | **never on disk permanently**: rendered per call into `/tmp/whm/backup-rclone-<random>/rclone` (0600, root) by the agent and removed in `finally` | secrets never reach argv or `/proc` |

Migration `039_backup-cloud.sql` rebuilds `backup_destinations` with the widened `kind`
CHECK (keeping `backup_uploads.destination_id` links across the `DROP TABLE`), adds
`backup_uploads.encrypted` and the `backup_oauth_apps` table.

## Encryption model

- An encrypted destination is an **rclone `crypt` remote** (`[whm]`) wrapping the backend
  remote (`[whmbase]`): `filename_encryption = standard`, `directory_name_encryption = true`,
  so file **names and contents** are ciphertext at rest; the provider sees opaque blobs.
- The key is a random **password** (32 random bytes, base64url) and **salt** (`password2`,
  24 random bytes) generated per destination by `services/backup-cloud.js newEncryptionKey()`,
  stored in `config_enc`, and rendered into `rclone.conf` in rclone's own obscured form
  (`rcloneObscure`: AES-256-CTR under rclone's compiled-in key, verified against rclone's
  test vectors). The operator receives the plain password + salt once with a download; the
  file explains how to read the archives with `rclone config` outside the panel.
- **On by default** for every new destination except a plain `local` copy (`crypt` omitted
  → on); the UI shows the toggle before creation. **Not switchable off once enabled**:
  `PUT` with `crypt: false` on an encrypted destination is `409`.
- A destination created before this unit (plain S3/WebDAV/SFTP/FTP/local) keeps working
  unchanged and gets an **Enable encryption** action (`POST /destinations/:id/encryption`)
  that only affects new uploads: each `backup_uploads` row records `encrypted`, and fetches,
  prunes and listings use the transport that wrote the copy (`agentConfig(row, { encrypted })`
  strips the crypt layer for plain copies). `GET /destinations/:id/archives` lists both
  layers with `encrypted` per entry.
- Restores decrypt through the same crypt remote (`backup.rclone.download`), then the usual
  sha256 verification against the recorded checksum applies.
- Token rotation: rclone writes a refreshed OAuth token back into its (temporary) config;
  the agent diffs it (`readTokenUpdate`) and returns `tokenUpdate`; the service persists the
  new refresh token (`backup.destination.token_rotated` audit row, no token in it).

## Agent ops (`agent/src/ops/backup.js`, family `backup.rclone.*`)

| Op | Args | Behaviour |
|---|---|---|
| `backup.rclone.test` | `{ config }` | `copyto` a probe, `lsjson` it, `deletefile`; `ok:false` + reason instead of throwing (capability/path/args errors still throw) |
| `backup.rclone.upload` | `{ config, file, remoteName? }` | `copyto`, then `lsjson` to confirm presence and size (decrypted size through crypt) |
| `backup.rclone.download` | `{ config, remoteName, dest }` | `copyto` into the local directory, 0600, sha256; partial file removed on failure |
| `backup.rclone.list` | `{ config }` | `lsjson --files-only`, archive names only; exit code 3 (no such directory) → empty |
| `backup.rclone.delete` | `{ config, remoteName }` (destructive) | `deletefile`; exit 3/4 → `removed:false` |

Every call: `rclone --config <tmp> --cache-dir <tmp>/cache --contimeout 30s --timeout 5m
--retries 3 --retries-sleep 5s --low-level-retries 10 --stats 0 --log-level ERROR
[--no-check-certificate] <cmd> …`, `HOME` pointed at the temp dir, exec timeout 2 h for
transfers / 5 min otherwise; stderr's last line is reported with every configured secret
scrubbed and rclone's exit code mapped to a reason. Config values are validated with the
`iniValue` rule (no leading quote/comment marker, no surrounding whitespace, no control
characters) so the INI reader cannot reinterpret them. The curl/S3 ops refuse a
configuration that belongs to rclone (`unsupported`), so the service's routing is the only
path.

## OAuth flows

```
GET /api/backup/destinations/oauth/:provider/start?destination=<id>   (root, session only)
   → state + PKCE verifier + redirect URI into req.session.backupOauth
   → 302 to the provider's consent page
GET /api/backup/destinations/oauth/:provider/callback?code&state       (root, session only)
   → state compared in constant time, 10 min TTL, consumed on first use
   → code exchanged server-side (fetch, https only, 15 s timeout, no redirects, body ≤ 256 KB)
   → profile read (display name; OneDrive also /me/drive for drive_id/drive_type)
   → refresh token + account stored on the destination (encrypted)
   → 302 /backup/backup-configuration?cloud=connected&destination=<id>
     or ?cloud=error&message=<reason>
```

The redirect URI the panel sends is `<scheme>://<host of the request>/api/backup/
destinations/oauth/<provider>/callback`; the one to register with the provider is the
panel's canonical address, shown on the OAuth client card:

`https://<hostname>:2087/api/backup/destinations/oauth/<provider>/callback`

Open the panel at that hostname when connecting. The code is single-use and bound to the
PKCE verifier and the client secret, so the request log line carrying it is not reusable.

### OAuth app setup per provider

**Google Drive** — Google Cloud console › *APIs & Services* › *Enabled APIs* › enable
**Google Drive API**; *OAuth consent screen* (External, add the test users or publish);
*Credentials* › *Create credentials* › *OAuth client ID* › type **Web application** ›
*Authorised redirect URIs*: `https://<hostname>:2087/api/backup/destinations/oauth/gdrive/callback`.
Copy the client ID and secret into the panel. Scope requested: `drive.file`.

**Microsoft OneDrive** — Microsoft Entra admin center › *App registrations* › *New
registration*; supported account types: "Accounts in any organizational directory and
personal Microsoft accounts"; platform **Web**, redirect URI
`https://<hostname>:2087/api/backup/destinations/oauth/onedrive/callback`. Under
*Certificates & secrets* add a client secret (note its expiry; re-enter it in the panel when
rotated). *API permissions*: Microsoft Graph delegated `Files.ReadWrite`, `offline_access`,
`User.Read`. Copy the Application (client) ID and the secret value.

**Dropbox** — Dropbox App Console › *Create app* › Scoped access › **Full Dropbox** (or App
folder if archives may live under `Apps/<app>`); *Permissions*: `files.metadata.read`,
`files.content.read`, `files.content.write`, `account_info.read`; *Settings* › *Redirect
URIs*: `https://<hostname>:2087/api/backup/destinations/oauth/dropbox/callback`. Copy the
App key (client ID) and App secret. Apps in development mode allow up to 50 users.

**Amazon S3** — IAM user or role access key with `s3:PutObject`, `s3:GetObject`,
`s3:DeleteObject`, `s3:ListBucket` (and `s3:AbortMultipartUpload` for rclone transfers) on
the bucket. **Azure Blob** — storage account › *Access keys*, or a container SAS with
read/write/list/delete. **Backblaze B2** — *Application Keys* › key restricted to the bucket
with read/write/list/delete.

## API summary

| Route | Purpose |
|---|---|
| `GET /backup/destinations/providers` | catalog, OAuth client state, `rclone.installed` |
| `GET/PUT/DELETE /backup/destinations/oauth-apps[/:provider]` | OAuth client registry (`clientId`, `clientSecret` write-only) |
| `GET /backup/destinations/oauth/:provider/start?destination=` / `…/callback` | the browser flow above |
| `POST /backup/destinations` | create; `encryptionKey` returned once when encryption is on |
| `PUT /backup/destinations/:id` | update; `crypt: false` on an encrypted destination → 409; turning it on returns the key once |
| `POST /backup/destinations/:id/encryption` | enable encryption on a plain destination (key returned once) |
| `GET /backup/destinations/:id/archives` | copies on the destination with `encrypted` per entry (both layers) |
| `POST /backup/destinations/:id/archives/import` `{ name, encrypted }` | 202 job `backup.cloud.fetch`: download (decrypt), verify, register as a pinned `import` backup |

UI: Backup Configuration › *Cloud storage* (provider cards, names only; OAuth client
modal with the redirect URI and setup steps; rclone install prompt), the destination form
per kind with the *Encrypt archives at rest* toggle, the encryption-key notice with
download after creation / enabling, *Connect* / *Reconnect* for OAuth kinds, the
*Encryption*, *Connection* and *Last upload* columns, and in the restore picker a *Copies on
destinations* section listing a destination's archives for the account with *Import*.
