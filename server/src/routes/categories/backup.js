import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { isValidCron } from '../../lib/cron.js';
import { createBackupService, SETTING_KEYS } from '../../services/backup.js';

const idParam = z.object({ id: fields.id });
const relPath = z.string().min(1).max(1024).regex(/^(?![-/])(?!.*(^|\/)\.\.(\/|$))[^\0\n\r]+$/, 'Relative path inside the archive without ".." segments');
const remotePath = z.string().max(512).regex(/^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._~/-]*$/, 'Letters, digits, "._~/-" and no ".."');
const hostField = fields.hostname.or(fields.ip);
const secret = z.string().max(256).regex(/^[^\n\r\0]*$/);
const nonEmpty = z.string().min(1).max(256).regex(/^[^\n\r\0]+$/);
const url = z.string().url().max(2048).refine((u) => /^https?:\/\//.test(u), 'http(s) URL required');
const port = z.number().int().min(1).max(65535);

// Mirrors the agent's destinationConfig so a bad configuration fails here with
// field errors instead of at the first upload. On an update a blank secret
// means "keep the stored one" and null removes it.
const destinationSchema = (mode) => {
  const optionalSecret = mode === 'update' ? secret.nullable().optional() : secret.optional();
  const privateKey = mode === 'update' ? z.string().max(16384).nullable().optional() : z.string().max(16384).optional();
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), dir: fields.absPath }).strict(),
    z.object({ kind: z.literal('ftp'), host: hostField, port: port.default(21), username: nonEmpty, password: mode === 'update' ? secret.nullable().default('') : secret.default(''), path: remotePath.default(''), tls: z.boolean().default(false), insecure: z.boolean().default(false), passive: z.boolean().default(true) }).strict(),
    z.object({ kind: z.literal('sftp'), host: hostField, port: port.default(22), username: nonEmpty, password: optionalSecret, privateKey, hostKeySha256: z.string().regex(/^[A-Za-z0-9+/=]{40,48}$/).optional(), path: remotePath.default(''), insecure: z.boolean().default(false) }).strict(),
    z.object({ kind: z.literal('webdav'), url, username: nonEmpty.optional(), password: optionalSecret, insecure: z.boolean().default(false) }).strict(),
    z.object({ kind: z.literal('s3'), endpoint: url.optional(), region: z.string().regex(/^[a-z0-9-]{1,32}$/).default('us-east-1'), bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/), prefix: remotePath.default(''), accessKey: nonEmpty, secretKey: mode === 'update' ? secret : nonEmpty, pathStyle: z.boolean().default(false), insecure: z.boolean().default(false) }).strict(),
  ]).superRefine((c, issues) => {
    // Without a pinned host key an SFTP login verifies nothing on a host that has no known_hosts yet.
    if (c.kind === 'sftp' && !c.hostKeySha256 && !c.insecure) issues.addIssue({ code: z.ZodIssueCode.custom, path: ['hostKeySha256'], message: 'Pin the server host key (SHA-256 fingerprint) or explicitly skip host key verification' });
  });
};
const destinationConfig = destinationSchema('create');
const destinationUpdate = destinationSchema('update');
const destinationName = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, 'Letters, digits, spaces, "._-"');

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
  ctx.backup = createBackupService(ctx);
  ctx.jobs.register('backup.run', (job) => ctx.backup.runBackupJob(job));
  ctx.jobs.register('backup.restore', (job) => ctx.backup.runRestoreJob(job));
  ctx.jobs.register('backup.fetch', (job) => ctx.backup.runFetchJob(job));
  ctx.scheduler.ensure('backup-run', ctx.settings.get('backup.schedule', '0 2 * * *') || '0 2 * * *', 'backup.run', { kind: 'scheduled' });
  ctx.backup.syncSchedule();
  ctx.capabilities.register('backup', { binaries: ['tar', 'gzip', 'curl', 'mysqldump', 'mariadb-dump'], required: ['tar'] });

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const svc = () => ctx.backup;

  // Backup Configuration ---------------------------------------------------------
  r.get('/config', requireRoot, wrap(async () => ({ settings: svc().config(), status: await svc().status() })));
  r.put('/config', requireRoot, validate({ body: settingsBody }), wrap((req) => svc().updateConfig(req.body, req)));
  r.get('/status', requireReseller, wrap((req) => svc().status(req.user)));

  r.get('/destinations', requireRoot, wrap(() => svc().listDestinations()));
  r.post('/destinations', requireRoot, validate({ body: z.object({ name: destinationName, enabled: z.boolean().optional(), config: destinationConfig }).strict() }),
    wrap((req) => svc().createDestination({ name: req.body.name, kind: req.body.config.kind, enabled: req.body.enabled, config: req.body.config }, req), 201));
  r.post('/destinations/test', requireRoot, validate({ body: z.object({ config: destinationConfig }).strict() }), wrap((req) => svc().testDestinationConfig(req.body.config, req)));
  r.put('/destinations/:id', requireRoot, validate({ params: idParam, body: z.object({ name: destinationName.optional(), enabled: z.boolean().optional(), config: destinationUpdate.optional() }).strict() }),
    wrap((req) => svc().updateDestination(req.params.id, req.body, req)));
  r.delete('/destinations/:id', requireRoot, validate({ params: idParam }), wrap((req) => svc().removeDestination(req.params.id, req)));
  r.post('/destinations/:id/test', requireRoot, validate({ params: idParam }), wrap((req) => svc().testDestination(req.params.id, req)));
  r.get('/destinations/:id/archives', requireRoot, validate({ params: idParam }), wrap((req) => svc().listRemote(req.params.id, req)));

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
