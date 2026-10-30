import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { isValidCron } from '../../lib/cron.js';
import { forbidden, HttpError } from '../../lib/errors.js';
import { constantTimeEqual } from '../../lib/crypto.js';
import { createBackupService, SETTING_KEYS } from '../../services/backup.js';
import { createBackupCloudService, OAUTH_KINDS } from '../../services/backup-cloud.js';

const idParam = z.object({ id: fields.id });
const relPath = z.string().min(1).max(1024).regex(/^(?![-/])(?!.*(^|\/)\.\.(\/|$))[^\0\n\r]+$/, 'Relative path inside the archive without ".." segments');
const remotePath = z.string().max(512).regex(/^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._~/-]*$/, 'Letters, digits, "._~/-" and no ".."');
const archiveName = z.string().max(128).regex(/^(backup-\d{2}\.\d{2}\.\d{4}_\d{2}-\d{2}-\d{2}_|cpmove-)?[a-z][a-z0-9_-]{0,31}\.tar(\.gz)?$/, 'Not a WHM/cPanel account archive name');
const hostField = fields.hostname.or(fields.ip);
const secret = z.string().max(256).regex(/^[^\n\r\0]*$/);
const nonEmpty = z.string().min(1).max(256).regex(/^[^\n\r\0]+$/);
// Mirrors the agent's rclone.conf value rule: no quotes or comment markers at
// the start, no surrounding whitespace, no control characters.
const iniValue = (max) => z.string().max(max).regex(/^(?!["'`#;\s])(?:[^\n\r\0]*[^\s\n\r\0])?$/, 'No quotes, comment markers, surrounding whitespace or control characters');
// The WHATWG parser behind .url() strips tabs and newlines, so the agent's
// character class runs first: a URL that curl would read line by line is a
// field error on save, not an invalid_args at the first upload.
const url = z.string().max(2048).regex(/^https?:\/\/[^\s"'\\\x00-\x1f\x7f]+$/, 'http(s) URL without whitespace, quotes or control characters').url();
const port = z.number().int().min(1).max(65535);

// Mirrors the agent's destinationConfig so a bad configuration fails here with
// field errors instead of at the first upload. On an update a blank secret
// means "keep the stored one" and null removes it. OAuth kinds carry no
// credentials from the browser: the tokens come from the connect flow.
const destinationSchema = (mode) => {
  const optionalSecret = mode === 'update' ? secret.nullable().optional() : secret.optional();
  const optionalIni = (max) => (mode === 'update' ? iniValue(max).nullable().optional() : iniValue(max).optional());
  const requiredIni = (max) => (mode === 'update' ? iniValue(max).optional() : iniValue(max).min(1));
  const privateKey = mode === 'update' ? z.string().max(16384).nullable().optional() : z.string().max(16384).optional();
  const crypt = z.boolean().optional();
  const folder = remotePath.default('whm-backups');
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), dir: fields.absPath, crypt }).strict(),
    z.object({ kind: z.literal('ftp'), host: hostField, port: port.default(21), username: nonEmpty, password: mode === 'update' ? secret.nullable().default('') : secret.default(''), path: remotePath.default(''), tls: z.boolean().default(false), insecure: z.boolean().default(false), passive: z.boolean().default(true), crypt }).strict(),
    z.object({ kind: z.literal('sftp'), host: hostField, port: port.default(22), username: nonEmpty, password: optionalSecret, privateKey, hostKeySha256: z.string().regex(/^[A-Za-z0-9+/=]{40,48}$/).optional(), path: remotePath.default(''), insecure: z.boolean().default(false), crypt }).strict(),
    z.object({ kind: z.literal('webdav'), url, username: nonEmpty.optional(), password: optionalSecret, insecure: z.boolean().default(false), crypt }).strict(),
    z.object({ kind: z.literal('s3'), endpoint: url.optional(), region: z.string().regex(/^[a-z0-9-]{1,32}$/).default('us-east-1'), bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/), prefix: remotePath.default(''), accessKey: nonEmpty, secretKey: mode === 'update' ? secret.optional() : nonEmpty, pathStyle: z.boolean().default(false), insecure: z.boolean().default(false), transport: z.enum(['native', 'rclone']).optional(), crypt }).strict(),
    z.object({ kind: z.literal('gdrive'), folder, rootFolderId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), crypt }).strict(),
    z.object({ kind: z.literal('onedrive'), folder, crypt }).strict(),
    z.object({ kind: z.literal('dropbox'), folder, crypt }).strict(),
    z.object({ kind: z.literal('azureblob'), account: z.string().regex(/^[a-z0-9]{3,24}$/, 'Storage account name: 3–24 lowercase letters and digits'), container: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'Container name: 3–63 lowercase letters, digits and "-"'), prefix: remotePath.default(''), accountKey: optionalIni(256), sasToken: optionalIni(2048), endpoint: url.optional(), crypt }).strict(),
    z.object({ kind: z.literal('b2'), keyId: z.string().regex(/^[A-Za-z0-9]{1,64}$/, 'Application key ID'), applicationKey: requiredIni(256), bucket: z.string().regex(/^[A-Za-z0-9-]{6,63}$/, 'Bucket name: 6–63 letters, digits and "-"'), prefix: remotePath.default(''), crypt }).strict(),
  ]).superRefine((c, issues) => {
    // Without a pinned host key an SFTP login verifies nothing on a host that has no known_hosts yet.
    if (c.kind === 'sftp' && !c.hostKeySha256 && !c.insecure) issues.addIssue({ code: z.ZodIssueCode.custom, path: ['hostKeySha256'], message: 'Pin the server host key (SHA-256 fingerprint) or explicitly skip host key verification' });
    if (c.kind === 'azureblob' && mode === 'create' && !c.accountKey && !c.sasToken) issues.addIssue({ code: z.ZodIssueCode.custom, path: ['accountKey'], message: 'Enter the storage account key or a container SAS token' });
  });
};
const destinationConfig = destinationSchema('create');
const destinationUpdate = destinationSchema('update');
const destinationName = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, 'Letters, digits, spaces, "._-"');
const providerParam = z.object({ provider: z.enum(OAUTH_KINDS) });
const oauthAppBody = z.object({ clientId: iniValue(512).min(1), clientSecret: iniValue(512).optional() }).strict();

const settingsBody = z.object({
  'backup.enabled': z.boolean().optional(),
  'backup.schedule': fields.cron.refine(isValidCron, 'Must be a valid 5-field cron expression').optional(),
  'backup.retention_daily': z.number().int().min(0).max(3650).optional(),
  'backup.retention_weekly': z.number().int().min(0).max(520).optional(),
  'backup.retention_monthly': z.number().int().min(0).max(120).optional(),
  'backup.local_dir': fields.absPath.optional(),
  'backup.include_home': z.boolean().optional(),
  'backup.include_mail': z.boolean().optional(),
  'backup.include_dbs': z.boolean().optional(),
  'backup.include_dns': z.boolean().optional(),
  'backup.include_metadata': z.boolean().optional(),
  'backup.compression_level': z.number().int().min(1).max(9).optional(),
  'backup.strict': z.boolean().optional(),
  'backup.keep_local': z.boolean().optional(),
  'backup.prune_remote': z.boolean().optional(),
  'backup.default_include': z.boolean().optional(),
  'backup.skip_suspended': z.boolean().optional(),
  'backup.excludes': z.array(relPath).max(200).optional(),
  'backup.notify_on_failure': z.boolean().optional(),
}).strict().refine((b) => Object.keys(b).some((k) => SETTING_KEYS.includes(k)), 'No backup settings supplied');

const usernames = z.array(fields.username).min(1).max(1000);
const restoreBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), options: z.object({ files: z.boolean().optional(), databases: z.boolean().optional(), dns: z.boolean().optional(), mail: z.boolean().optional(), overwrite: z.boolean().optional(), createAccount: z.boolean().optional(), package: fields.packageName.optional() }).strict().default({}) }).strict(),
  z.object({ kind: z.literal('files'), options: z.object({ paths: z.array(relPath).min(1).max(500), overwrite: z.boolean().optional() }).strict() }).strict(),
]);

export async function register(ctx) {
  ctx.backupCloud = createBackupCloudService(ctx);
  ctx.backup = createBackupService(ctx);
  ctx.jobs.register('backup.run', (job) => ctx.backup.runBackupJob(job));
  ctx.jobs.register('backup.restore', (job) => ctx.backup.runRestoreJob(job));
  ctx.jobs.register('backup.fetch', (job) => ctx.backup.runFetchJob(job));
  ctx.jobs.register('backup.cloud.fetch', (job) => ctx.backup.runCloudFetchJob(job));
  ctx.scheduler.ensure('backup-run', ctx.settings.get('backup.schedule', '0 2 * * *') || '0 2 * * *', 'backup.run', { kind: 'scheduled' });
  ctx.backup.syncSchedule();
  ctx.capabilities.register('backup', { binaries: ['tar', 'gzip', 'curl', 'mysqldump', 'mariadb-dump'], required: ['tar'] });
  ctx.capabilities.register('rclone', { binaries: ['rclone'], required: ['rclone'] });

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const svc = () => ctx.backup;
  const cloud = () => ctx.backupCloud;

  // Backup Configuration ---------------------------------------------------------
  r.get('/config', requireRoot, wrap(async () => ({ settings: svc().config(), status: await svc().status() })));
  r.put('/config', requireRoot, validate({ body: settingsBody }), wrap((req) => svc().updateConfig(req.body, req)));
  r.get('/status', requireReseller, wrap((req) => svc().status(req.user)));

  // Cloud storage: provider catalog, OAuth clients and the browser flow that
  // connects a Google Drive / OneDrive / Dropbox destination. The flow is
  // session-only: a Bearer token cannot complete a browser redirect and must
  // not be able to attach an account to a destination.
  r.get('/destinations/providers', requireRoot, wrap(() => cloud().providers()));
  r.get('/destinations/oauth-apps', requireRoot, wrap(() => cloud().listOauthApps()));
  r.put('/destinations/oauth-apps/:provider', requireRoot, validate({ params: providerParam, body: oauthAppBody }), wrap((req) => cloud().setOauthApp(req.params.provider, req.body, req)));
  r.delete('/destinations/oauth-apps/:provider', requireRoot, validate({ params: providerParam }), wrap((req) => cloud().removeOauthApp(req.params.provider, req)));

  const oauthRedirectUri = (req, provider) => `${req.protocol}://${req.get('host')}/api/backup/destinations/oauth/${encodeURIComponent(provider)}/callback`;
  const backToPage = (res, params) => res.redirect(`/backup/backup-configuration?${new URLSearchParams(params).toString()}`);
  const sessionOnly = (req) => { if (req.auth?.via !== 'session') throw forbidden('Connecting a cloud account is a browser flow; sign in to the panel to start it'); };

  r.get('/destinations/oauth/:provider/start', requireRoot, validate({ params: providerParam, query: z.object({ destination: fields.id }) }), (req, res, next) => {
    try {
      sessionOnly(req);
      const destination = svc().loadDestination(req.query.destination);
      const redirectUri = oauthRedirectUri(req, req.params.provider);
      const flow = cloud().beginConnect({ provider: req.params.provider, destination, redirectUri });
      // The exchange must quote the exact URI the consent was asked for.
      req.session.backupOauth = { provider: req.params.provider, destinationId: destination.id, state: flow.state, codeVerifier: flow.codeVerifier, redirectUri, at: Date.now() };
      req.audit({ action: 'backup.destination.connect.start', target: destination.name, args: { provider: req.params.provider } });
      res.redirect(flow.url);
    } catch (err) { next(err); }
  });

  r.get('/destinations/oauth/:provider/callback', requireRoot, validate({
    params: providerParam,
    query: z.object({ code: z.string().min(1).max(4096).optional(), state: z.string().min(1).max(256).optional(), error: z.string().max(200).optional(), error_description: z.string().max(1000).optional() }),
  }), async (req, res, next) => {
    const pending = req.session?.backupOauth;
    if (req.session) delete req.session.backupOauth;
    try {
      sessionOnly(req);
      if (req.query.error) return backToPage(res, { cloud: 'error', message: req.query.error_description || req.query.error });
      const stale = !pending || pending.provider !== req.params.provider || !req.query.state || !req.query.code || !constantTimeEqual(pending.state, req.query.state) || Date.now() - pending.at > cloud().stateTtlMs;
      if (stale) return backToPage(res, { cloud: 'error', message: 'The sign-in did not match a pending request (it expired or was started from another session); start it again' });
      const fields = await cloud().completeConnect({ provider: req.params.provider, code: req.query.code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri || oauthRedirectUri(req, req.params.provider) });
      const destination = svc().connectDestination(pending.destinationId, fields, req);
      return backToPage(res, { cloud: 'connected', destination: String(destination.id) });
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) return backToPage(res, { cloud: 'error', message: err.message });
      return next(err);
    }
  });

  r.get('/destinations', requireRoot, wrap(() => svc().listDestinations()));
  r.post('/destinations', requireRoot, validate({ body: z.object({ name: destinationName, enabled: z.boolean().optional(), config: destinationConfig }).strict() }),
    wrap((req) => svc().createDestination({ name: req.body.name, kind: req.body.config.kind, enabled: req.body.enabled, config: req.body.config }, req), 201));
  r.post('/destinations/test', requireRoot, validate({ body: z.object({ config: destinationConfig }).strict() }), wrap((req) => svc().testDestinationConfig(req.body.config, req)));
  r.put('/destinations/:id', requireRoot, validate({ params: idParam, body: z.object({ name: destinationName.optional(), enabled: z.boolean().optional(), config: destinationUpdate.optional() }).strict() }),
    wrap((req) => svc().updateDestination(req.params.id, req.body, req)));
  r.delete('/destinations/:id', requireRoot, validate({ params: idParam }), wrap((req) => svc().removeDestination(req.params.id, req)));
  r.post('/destinations/:id/test', requireRoot, validate({ params: idParam }), wrap((req) => svc().testDestination(req.params.id, req)));
  r.post('/destinations/:id/encryption', requireRoot, validate({ params: idParam }), wrap((req) => svc().enableEncryption(req.params.id, req)));
  r.get('/destinations/:id/archives', requireRoot, validate({ params: idParam }), wrap((req) => svc().listRemote(req.params.id, req)));
  r.post('/destinations/:id/archives/import', requireRoot, validate({ params: idParam, body: z.object({ name: archiveName, encrypted: z.boolean().optional() }).strict() }),
    wrap((req) => svc().enqueueImportRemote(req.params.id, req.body, req.user, req), 202));

  // Backup User Selection --------------------------------------------------------
  r.get('/selection', requireRoot, validate({ query: z.object({ q: z.string().trim().max(200).optional(), owner: fields.username.optional(), enabled: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }),
    wrap((req) => svc().listSelection(req.query)));
  r.put('/selection', requireRoot, validate({ body: z.object({ usernames, enabled: z.boolean() }).strict() }), wrap((req) => svc().setSelection(req.body.usernames, req.body.enabled, req)));

  // Archives / runs --------------------------------------------------------------
  r.get('/backups', requireReseller, validate({ query: pagination.extend({ account: fields.username.optional(), status: z.enum(['done', 'failed']).optional() }) }), wrap((req) => svc().listBackups(req.query, req.user)));
  r.get('/accounts', requireReseller, wrap((req) => svc().accountsOverview(req.user)));
  r.post('/runs', requireReseller, validate({ body: z.object({ accounts: usernames.optional() }).strict() }), wrap((req) => svc().enqueueRun({ accounts: req.body.accounts, kind: 'manual' }, req.user, req), 202));
  r.get('/runs', requireRoot, validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }), wrap((req) => svc().listRuns(req.query)));
  r.get('/runs/:id', requireRoot, validate({ params: idParam }), wrap((req) => svc().getRun(req.params.id)));
  r.post('/rescan', requireRoot, wrap((req) => svc().rescan(req.user, req)));
  r.post('/archives/import', requireRoot, validate({ body: z.object({ path: fields.absPath }).strict() }), wrap((req) => svc().registerArchive(req.body.path, req.user, req), 201));

  r.get('/backups/:id', requireReseller, validate({ params: idParam }), wrap((req) => svc().getBackup(req.params.id, req.user)));
  r.get('/backups/:id/info', requireReseller, validate({ params: idParam }), wrap((req) => svc().archiveInfo(req.params.id, req.user)));
  r.get('/backups/:id/browse', requireReseller, validate({ params: idParam, query: z.object({ prefix: relPath.default('homedir') }) }), wrap((req) => svc().inspect(req.params.id, req.query.prefix, req.user)));
  r.put('/backups/:id/pin', requireRoot, validate({ params: idParam, body: z.object({ pinned: z.boolean() }).strict() }), wrap((req) => svc().pinBackup(req.params.id, req.body.pinned, req.user, req)));
  r.delete('/backups/:id', requireRoot, validate({ params: idParam, query: z.object({ remote: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }),
    wrap((req) => svc().deleteBackup(req.params.id, { remote: req.query.remote !== false }, req.user, req)));
  r.post('/backups/:id/fetch', requireReseller, validate({ params: idParam }), wrap((req) => svc().enqueueFetch(req.params.id, req.user, req), 202));

  // Backup Restoration / File and Directory Restoration -------------------------
  r.post('/backups/:id/restore', requireReseller, validate({ params: idParam, body: restoreBody }),
    wrap((req) => svc().enqueueRestore({ backupId: req.params.id, kind: req.body.kind, options: req.body.options }, req.user, req), 202));
  r.get('/restores', requireReseller, validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), account: fields.username.optional() }) }), wrap((req) => svc().listRestores(req.query, req.user)));
  r.get('/restores/:id', requireReseller, validate({ params: idParam }), wrap((req) => svc().getRestore(req.params.id, req.user)));

  return { path: '/backup', router: r };
}
