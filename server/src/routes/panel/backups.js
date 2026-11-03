import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireScope } from '../../middleware/rbac.js';
import { HttpError } from '../../lib/errors.js';
import { createPanelBackupService, UPLOAD_NAME, REL_PATH } from '../../services/panel-backup.js';

// /api/panel/backups — backups of the pinned account (design §4.10). Generation
// and restores are jobs (202); downloads stream the archive through the
// root-side range op; uploads reuse the transfers chunk protocol.

const relPath = z.string().regex(REL_PATH, 'Relative path without ".." segments');
const generateBody = z.object({ kind: z.enum(['home', 'full']).default('home') }).strict();
const restoreBody = z.object({ paths: z.array(relPath).min(1).max(500), overwrite: z.boolean().default(false) }).strict();
const browseQuery = z.object({ prefix: z.string().regex(/^(?![-/])(?!.*(^|\/)\.\.(\/|$))[^\0\n\r]{0,1024}$/).optional() }).strict();
const uploadBody = z.object({ name: z.string().regex(UPLOAD_NAME, 'Must be a .tar.gz, .tgz or .tar archive name'), size: z.number().int().min(1).max(500 * 1024 * 1024 * 1024) }).strict();
const chunkBody = z.object({ data: z.string().min(1).max(1_800_000).regex(/^[A-Za-z0-9+/=]+$/, 'Chunk must be base64') }).strict();
const idParam = z.object({ id: fields.id });
const uploadParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });

async function scopeOf(ctx, req) {
  if (req.panel) return req.panel;
  if (typeof ctx.panel?.scope !== 'function') throw new HttpError(403, 'panel_scope_required', 'This endpoint needs a customer panel session');
  return ctx.panel.scope(req);
}

export function register(ctx) {
  ctx.panelBackup = createPanelBackupService(ctx);
  ctx.jobs.register('panel.backup.generate', (job) => ctx.panelBackup.runGenerate(job));
  const svc = () => ctx.panelBackup;

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(scopeOf(ctx, req).then((scope) => fn(scope, req, res))).then((d) => { if (!res.headersSent) res.status(status).json(d?.meta ? d : { data: d }); }).catch(next);
  r.use(requireScope('panel:backups'));

  r.get('/', validate({ query: pagination }), wrap((scope, req) => svc().list(scope, req.query)));
  r.post('/', validate({ body: generateBody }), wrap((scope, req) => svc().generate(scope, req.body, req), 202));
  r.get('/restores', wrap((scope) => svc().restores(scope)));
  r.post('/uploads', validate({ body: uploadBody }), wrap((scope, req) => svc().beginUpload(scope, req.body, req), 201));
  r.get('/uploads/:id', validate({ params: uploadParam }), wrap((scope, req) => svc().uploadStatus(scope, req.params.id)));
  r.put('/uploads/:id/chunks', validate({ params: uploadParam, body: chunkBody }), wrap((scope, req) => svc().uploadChunk(scope, req.params.id, req.body.data, req)));
  r.post('/uploads/:id/finish', validate({ params: uploadParam }), wrap((scope, req) => svc().finishUpload(scope, req.params.id, req), 201));
  r.post('/uploads/:id/abort', validate({ params: uploadParam }), wrap((scope, req) => svc().abortUpload(scope, req.params.id, req)));
  r.get('/:id', validate({ params: idParam }), wrap((scope, req) => svc().get(scope, req.params.id)));
  r.get('/:id/browse', validate({ params: idParam, query: browseQuery }), wrap((scope, req) => svc().browse(scope, req.params.id, req.query.prefix)));
  r.get('/:id/download', validate({ params: idParam }), wrap((scope, req, res) => svc().download(scope, req.params.id, res, req)));
  r.post('/:id/restore', validate({ params: idParam, body: restoreBody }), wrap((scope, req) => svc().restore(scope, req.params.id, req.body, req), 202));
  r.delete('/:id', validate({ params: idParam }), wrap((scope, req) => svc().remove(scope, req.params.id, req)));

  return { path: '/backups', router: r };
}
