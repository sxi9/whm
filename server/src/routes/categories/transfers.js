import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createTransfersService, RUN_KINDS, ARCHIVE_NAME, JOB_TYPES } from '../../services/transfers.js';

const bareHostname = z.string().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Must be a hostname or IP address');
const sshUser = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'Lowercase letters, digits, "_" or "-"');
const sessionBody = z.object({
  host: z.union([fields.ip, fields.hostname, bareHostname]),
  port: z.number().int().min(1).max(65535).default(22),
  user: sshUser.default('root'),
  authType: z.enum(['password', 'key']),
  password: z.string().min(1).max(256).regex(/^[^\n\r\0]+$/, 'Password must be a single line').optional(),
  privateKey: z.string().min(1).max(16 * 1024).optional(),
}).strict().refine((b) => (b.authType === 'password' ? Boolean(b.password) : Boolean(b.privateKey)), { message: 'Provide the credential matching the authentication type', path: ['password'] });
const transferOptions = z.object({ skipHome: z.boolean().optional(), skipDatabases: z.boolean().optional(), skipDns: z.boolean().optional(), overwrite: z.boolean().optional() }).strict();
const transferBody = z.object({
  sessionId: fields.id,
  accounts: z.array(z.object({ source: fields.username, username: fields.username.optional(), domain: fields.domain.optional(), package: fields.packageName.optional(), password: fields.password.optional() }).strict()).min(1).max(200),
  options: transferOptions.optional(),
}).strict();
const restoreBody = z.object({ path: fields.absPath, username: fields.username.optional(), domain: fields.domain.optional(), package: fields.packageName.optional(), password: fields.password.optional(), options: transferOptions.optional() }).strict();
const convertBody = z.object({
  domain: fields.domain,
  username: fields.username,
  package: fields.packageName.optional(),
  password: fields.password.optional(),
  contactEmail: fields.email.optional(),
  options: z.object({ copyFiles: z.boolean().optional(), removeSource: z.boolean().optional(), moveMail: z.boolean().optional(), moveDatabases: z.array(fields.dbName).max(100).optional() }).strict().optional(),
}).strict();
const archiveName = z.string().regex(ARCHIVE_NAME, 'Must end in .tar.gz, .tgz or .tar');
const uploadBody = z.object({ filename: archiveName, size: z.number().int().min(1).max(500 * 1024 * 1024 * 1024) }).strict();
// Base64 of UPLOAD_CHUNK_BYTES fits under the 2 MB JSON body limit.
const chunkBody = z.object({ data: z.string().min(1).max(1_800_000).regex(/^[A-Za-z0-9+/=]+$/, 'Chunk must be base64') }).strict();
const idParam = z.object({ id: fields.id });
const uploadParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });

export async function register(ctx) {
  ctx.transfers = createTransfersService(ctx);
  ctx.jobs.register(JOB_TYPES.transfer, (job) => ctx.transfers.runTransfer(job));
  ctx.jobs.register(JOB_TYPES.restore, (job) => ctx.transfers.runRestore(job));
  ctx.jobs.register(JOB_TYPES.convert_addon, (job) => ctx.transfers.runConvertAddon(job));
  ctx.jobs.register(JOB_TYPES.cleanup, (job) => ctx.transfers.cleanup(job));
  ctx.scheduler.ensure('transfers-cleanup', '40 4 * * 1', JOB_TYPES.cleanup);
  ctx.capabilities.register('ssh', { binaries: ['ssh', 'scp', 'ssh-keyscan'], required: ['ssh'] });
  ctx.capabilities.register('sshpass', { binaries: ['sshpass'] });

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const svc = () => ctx.transfers;

  r.get('/capabilities', requireReseller, wrap(() => svc().capabilityStatus()));

  // Transfer Tool: remote connections ---------------------------------------------
  r.get('/sessions', requireRoot, wrap((req) => svc().sessions.list(req.user)));
  r.post('/sessions', requireRoot, validate({ body: sessionBody }), wrap((req) => svc().sessions.create(req.body, req.user, req), 201));
  r.get('/sessions/:id', requireRoot, validate({ params: idParam }), wrap((req) => svc().sessions.get(req.params.id, req.user)));
  r.delete('/sessions/:id', requireRoot, validate({ params: idParam }), wrap((req) => svc().sessions.remove(req.params.id, req.user, req)));
  r.post('/sessions/:id/probe', requireRoot, validate({ params: idParam }), wrap((req) => svc().sessions.probe(req.params.id, req.user, req)));
  r.get('/sessions/:id/accounts', requireRoot, validate({ params: idParam, query: z.object({ refresh: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }),
    wrap((req) => svc().sessions.accounts(req.params.id, req.user, { refresh: req.query.refresh }, req)));
  r.post('/transfer/preview', requireRoot, validate({ body: transferBody }), wrap((req) => svc().previewTransfer(req.body, req.user)));
  r.post('/transfer', requireRoot, validate({ body: transferBody }), wrap((req) => svc().startTransfer(req.body, req.user, req), 202));

  // Transfer or Restore a cPanel Account ------------------------------------------
  r.get('/archives', requireRoot, wrap((req) => svc().archives.list(req.user)));
  r.post('/archives/inspect', requireRoot, validate({ body: z.object({ path: fields.absPath }).strict() }), wrap((req) => svc().archives.inspect(req.body.path, req.user, req)));
  r.post('/uploads', requireRoot, validate({ body: uploadBody }), wrap((req) => svc().uploads.begin(req.body, req.user, req), 201));
  r.get('/uploads/:id', requireRoot, validate({ params: uploadParam }), wrap((req) => svc().uploads.status(req.params.id, req.user)));
  r.put('/uploads/:id/chunks', requireRoot, validate({ params: uploadParam, body: chunkBody }), wrap((req) => svc().uploads.chunk(req.params.id, req.body.data, req.user, req)));
  r.post('/uploads/:id/finish', requireRoot, validate({ params: uploadParam }), wrap((req) => svc().uploads.finish(req.params.id, req.user, req)));
  r.delete('/uploads/:id', requireRoot, validate({ params: uploadParam }), wrap((req) => svc().uploads.abort(req.params.id, req.user, req)));
  r.post('/restore', requireRoot, validate({ body: restoreBody }), wrap((req) => svc().startRestore(req.body, req.user, req), 202));

  // Convert Addon Domain to Account -----------------------------------------------
  r.get('/addon-domains', requireReseller, wrap((req) => svc().listAddonDomains(req.user)));
  r.post('/convert-addon/preview', requireReseller, validate({ body: convertBody }), wrap((req) => svc().previewConvertAddon(req.body, req.user)));
  r.post('/convert-addon', requireReseller, validate({ body: convertBody }), wrap((req) => svc().startConvertAddon(req.body, req.user, req), 202));

  // Review Transfers and Restores -------------------------------------------------
  r.get('/runs', requireReseller, validate({ query: z.object({ kind: z.enum(RUN_KINDS).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }), wrap((req) => svc().listRuns(req.query, req.user)));
  r.get('/runs/:id', requireReseller, validate({ params: idParam }), wrap((req) => svc().getRun(req.params.id, req.user)));
  r.get('/jobs', requireReseller, validate({ query: z.object({ status: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(500).default(50) }) }), wrap((req) => svc().listJobs(req.query, req.user)));
  r.get('/jobs/:id', requireReseller, validate({ params: idParam }), wrap((req) => svc().getJob(req.params.id, req.user)));

  return { path: '/transfers', router: r };
}
