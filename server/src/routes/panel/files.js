import { validate, z } from '../../lib/validate.js';
import { panelRouter, wrap, created, accepted, relPath, requireFeature } from './index.js';
import { createPanelFilesService, relPathOrRoot, fileName, fileMode, archiveFormat, JOB_ARCHIVE, JOB_EXTRACT, MAX_TEXT_BYTES, MAX_UPLOAD_BYTES } from '../../services/panel-files.js';

// /api/panel/files — mounted by routes/categories/panel.js behind panelScope,
// so every handler finds the pinned account in req.panel.

const pathQuery = z.object({ path: relPathOrRoot });
const uploadParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });
const chunkBody = z.object({ data: z.string().min(1).max(1_800_000).regex(/^[A-Za-z0-9+/=]+$/, 'Chunk must be base64') }).strict();

export async function register(ctx) {
  const svc = createPanelFilesService(ctx);
  ctx.panelFiles = svc;
  ctx.capabilities.register('panel-files', { binaries: ['setpriv', 'runuser'], required: ['setpriv', 'runuser'] });
  ctx.capabilities.register('archive', { binaries: ['zip', 'unzip', 'tar', 'gzip'], required: ['zip', 'tar'] });
  ctx.jobs.register(JOB_ARCHIVE, (job) => svc.runArchiveJob(job));
  ctx.jobs.register(JOB_EXTRACT, (job) => svc.runExtractJob(job));

  const r = panelRouter(ctx, 'files');
  r.use(requireFeature('filemanager'));

  r.get('/list', validate({ query: pathQuery.extend({ limit: z.coerce.number().int().min(1).max(10000).default(2000) }) }), wrap((req) => svc.list(req.panel, req.query, req)));
  r.get('/stat', validate({ query: z.object({ path: relPath }) }), wrap((req) => svc.stat(req.panel, req.query, req)));
  r.get('/read', validate({ query: z.object({ path: relPath, maxBytes: z.coerce.number().int().min(1).max(MAX_TEXT_BYTES).default(1024 * 1024) }) }), wrap((req) => svc.read(req.panel, req.query, req)));
  r.put('/write', validate({ body: z.object({ path: relPath, content: z.string().max(MAX_TEXT_BYTES), mode: fileMode.optional() }).strict() }), wrap((req) => svc.write(req.panel, req.body, req)));
  r.post('/mkdir', validate({ body: z.object({ path: relPath, mode: fileMode.default('0755') }).strict() }), created((req) => svc.mkdir(req.panel, req.body, req)));
  r.post('/rename', validate({ body: z.object({ from: relPath, to: relPath, overwrite: z.boolean().default(false) }).strict() }), wrap((req) => svc.rename(req.panel, req.body, req)));
  r.post('/copy', validate({ body: z.object({ from: relPath, to: relPath }).strict() }), wrap((req) => svc.copy(req.panel, req.body, req)));
  r.post('/chmod', validate({ body: z.object({ path: relPath, mode: fileMode, recursive: z.boolean().default(false) }).strict() }), wrap((req) => svc.chmod(req.panel, req.body, req)));
  r.delete('/', validate({ body: z.object({ paths: z.array(relPath).min(1).max(200) }).strict() }), wrap((req) => svc.remove(req.panel, req.body, req)));
  // The service streams the file itself; the JSON envelope only carries errors raised before headers go out.
  r.get('/download', validate({ query: z.object({ path: relPath }) }), (req, res, next) => svc.download(req.panel, req.query, req, res).catch(next));

  r.post('/uploads', validate({ body: z.object({ path: relPathOrRoot, name: fileName, size: z.number().int().min(1).max(MAX_UPLOAD_BYTES), overwrite: z.boolean().default(false) }).strict() }), created((req) => svc.uploads.begin(req.panel, req.body, req)));
  r.get('/uploads/:id', validate({ params: uploadParam }), wrap((req) => svc.uploads.status(req.panel, req.params.id)));
  // The chunk body is dropped before the response so the automatic audit row
  // of this PUT carries the upload id only, never 1.8 MB of base64.
  r.put('/uploads/:id/chunks', validate({ params: uploadParam, body: chunkBody }), wrap((req) => { const { data } = req.body; req.body = {}; return svc.uploads.chunk(req.panel, req.params.id, data, req); }));
  r.post('/uploads/:id/finish', validate({ params: uploadParam }), wrap((req) => svc.uploads.finish(req.panel, req.params.id, req)));
  r.post('/uploads/:id/abort', validate({ params: uploadParam }), wrap((req) => svc.uploads.abort(req.panel, req.params.id, req)));

  r.post('/archive', validate({ body: z.object({ paths: z.array(relPath).min(1).max(500), dest: relPath, format: archiveFormat }).strict() }), accepted((req) => svc.enqueueArchive(req.panel, req.body, req)));
  r.post('/extract', validate({ body: z.object({ archive: relPath, dest: relPathOrRoot }).strict() }), accepted((req) => svc.enqueueExtract(req.panel, req.body, req)));
  r.get('/du', validate({ query: pathQuery.extend({ depth: z.coerce.number().int().min(0).max(2).default(1) }) }), wrap((req) => svc.du(req.panel, req.query, req)));

  return { path: '/files', router: r };
}
