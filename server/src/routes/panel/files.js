import express from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, wrap, created, accepted, relPath, requireFeature } from './index.js';
import { createPanelFilesService, relPathOrRoot, fileName, fileMode, archiveFormat, JOB_ARCHIVE, JOB_EXTRACT, MAX_TEXT_BYTES, MAX_UPLOAD_BYTES, MAX_CHUNK_BYTES } from '../../services/panel-files.js';
import { createPanelHtaccessService, dirPath, REALM, HTPASSWD_USER } from '../../services/panel-htaccess.js';

// /api/panel/files — mounted by routes/categories/panel.js behind panelScope,
// so every handler finds the pinned account in req.panel.

const pathQuery = z.object({ path: relPathOrRoot });
const uploadParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });
const chunkParam = uploadParam.extend({ index: z.coerce.number().int().min(0).max(1_000_000) });
// Only an octet-stream body is parsed, to the pinned ceiling (413 past it);
// express.json has already left any other content type untouched.
const rawChunk = express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK_BYTES });
const jobParam = z.object({ id: fields.id });

export async function register(ctx) {
  const svc = createPanelFilesService(ctx);
  ctx.panelFiles = svc;
  ctx.capabilities.register('panel-files', { binaries: ['setpriv', 'runuser', 'hexdump'], required: ['setpriv', 'runuser'] });
  ctx.capabilities.register('archive', { binaries: ['zip', 'unzip', 'tar', 'gzip'], required: ['zip', 'tar'] });
  ctx.jobs.register(JOB_ARCHIVE, (job) => svc.runArchiveJob(job));
  ctx.jobs.register(JOB_EXTRACT, (job) => svc.runExtractJob(job));

  const r = panelRouter(ctx, 'files');

  // Indexes and directory privacy (the .htaccess family, services/panel-htaccess.js)
  // have their own plan features, so they sit ahead of the file-manager gate.
  ctx.panelHtaccess ??= createPanelHtaccessService(ctx);
  const ht = ctx.panelHtaccess;
  const dirQuery = z.object({ path: dirPath });
  r.get('/htaccess', validate({ query: dirQuery }), wrap((req) => ht.get(req.panel, req.query, req)));
  r.post('/htaccess/probe', validate({ body: z.object({ path: dirPath }).strict() }), wrap((req) => ht.probe(req.panel, req.body, req)));
  r.get('/indexes', requireFeature('indexmanager'), validate({ query: dirQuery }), wrap((req) => ht.indexes.get(req.panel, req.query, req)));
  r.put('/indexes', requireFeature('indexmanager'), validate({ body: z.object({ path: dirPath, indexes: z.enum(['inherit', 'off', 'on']) }).strict() }), wrap((req) => ht.indexes.set(req.panel, req.body, req)));
  r.get('/privacy', requireFeature('dirprivacy'), validate({ query: dirQuery }), wrap((req) => ht.privacy.get(req.panel, req.query, req)));
  r.put('/privacy', requireFeature('dirprivacy'), validate({ body: z.object({ path: dirPath, enabled: z.boolean(), realm: z.string().trim().regex(REALM, 'Letters, digits, spaces and . _ ( ) \' -; max 64 characters').optional() }).strict() }), wrap((req) => ht.privacy.set(req.panel, req.body, req)));
  r.post('/privacy/users', requireFeature('dirprivacy'), validate({ body: z.object({ path: dirPath, user: z.string().regex(HTPASSWD_USER, 'Letters, digits and . _ @ -; max 64 characters'), password: fields.password }).strict() }), created((req) => ht.privacy.addUser(req.panel, req.body, req)));
  r.delete('/privacy/users', requireFeature('dirprivacy'), validate({ query: z.object({ path: dirPath, user: z.string().regex(HTPASSWD_USER) }) }), wrap((req) => ht.privacy.removeUser(req.panel, req.query, req)));

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
  // of this PUT carries the upload id and index only, never the bytes.
  r.put('/uploads/:id/chunks/:index', validate({ params: chunkParam }), rawChunk, wrap((req) => {
    const buf = req.body;
    req.body = {};
    if (!Buffer.isBuffer(buf)) throw new HttpError(415, 'unsupported_media_type', 'Send the chunk as application/octet-stream');
    return svc.uploads.chunk(req.panel, req.params.id, req.params.index, buf, req);
  }));
  r.post('/uploads/:id/finish', validate({ params: uploadParam }), wrap((req) => svc.uploads.finish(req.panel, req.params.id, req)));
  r.post('/uploads/:id/abort', validate({ params: uploadParam }), wrap((req) => svc.uploads.abort(req.panel, req.params.id, req)));

  r.post('/archive', validate({ body: z.object({ paths: z.array(relPath).min(1).max(500), dest: relPath, format: archiveFormat }).strict() }), accepted((req) => svc.enqueueArchive(req.panel, req.body, req)));
  r.post('/extract', validate({ body: z.object({ archive: relPath, dest: relPathOrRoot }).strict() }), accepted((req) => svc.enqueueExtract(req.panel, req.body, req)));
  r.get('/du', validate({ query: pathQuery.extend({ depth: z.coerce.number().int().min(0).max(2).default(1) }) }), wrap((req) => svc.du(req.panel, req.query, req)));

  // The account's archive/extract jobs (/api/system/jobs is reseller-only, so
  // a role-user principal follows its 202 jobs here).
  r.get('/jobs', wrap((req) => svc.listJobs(req.panel)));
  r.get('/jobs/:id', validate({ params: jobParam }), wrap((req) => svc.getJob(req.panel, req.params.id)));
  r.get('/jobs/:id/stream', validate({ params: jobParam }), (req, res, next) => { try { svc.streamJob(req.panel, req.params.id, req, res); } catch (err) { next(err); } });

  return { path: '/files', router: r };
}
