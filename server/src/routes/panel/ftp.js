import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireScope } from '../../middleware/rbac.js';
import { HttpError } from '../../lib/errors.js';
import { createPanelFtpService, FTP_NAME, REL_PATH } from '../../services/panel-ftp.js';

// /api/panel/ftp — FTP virtual users of the pinned account (design §4.8).

const relPath = z.string().regex(REL_PATH, 'Relative path without ".." segments');
const quotaMb = z.number().int().min(0).max(1_000_000_000).nullable();
const createBody = z.object({ login: z.string().regex(FTP_NAME, 'Lowercase letters, digits, ".", "_" or "-"; max 32 chars'), password: fields.password, dir: relPath.default('public_html'), quotaMb: quotaMb.default(null) }).strict();
const passwordBody = z.object({ password: fields.password }).strict();
const quotaBody = z.object({ quotaMb }).strict();
const idParam = z.object({ id: fields.id });

async function scopeOf(ctx, req) {
  if (req.panel) return req.panel;
  if (typeof ctx.panel?.scope !== 'function') throw new HttpError(403, 'panel_scope_required', 'This endpoint needs a customer panel session');
  return ctx.panel.scope(req);
}

export function register(ctx) {
  ctx.panelFtp = createPanelFtpService(ctx);
  ctx.capabilities.register('ftp-virtual', { binaries: ['pure-pw', 'ftpasswd'], required: ['pure-pw', 'ftpasswd'] });
  const svc = () => ctx.panelFtp;

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(scopeOf(ctx, req).then((scope) => fn(scope, req, res))).then((d) => { if (!res.headersSent) res.status(status).json(d?.meta ? d : { data: d }); }).catch(next);
  r.use(requireScope('panel:files'));

  r.get('/accounts', wrap((scope) => svc().list(scope)));
  r.post('/accounts', validate({ body: createBody }), wrap((scope, req) => svc().create(scope, req.body, req), 201));
  r.put('/accounts/:id/password', validate({ params: idParam, body: passwordBody }), wrap((scope, req) => svc().setPassword(scope, req.params.id, req.body.password, req)));
  r.put('/accounts/:id/quota', validate({ params: idParam, body: quotaBody }), wrap((scope, req) => svc().setQuota(scope, req.params.id, req.body.quotaMb, req)));
  r.delete('/accounts/:id', validate({ params: idParam }), wrap((scope, req) => svc().remove(scope, req.params.id, req)));
  r.get('/accounts/:id/client-config', validate({ params: idParam }), wrap((scope, req) => svc().clientConfig(scope, req.params.id)));

  return { path: '/ftp', router: r };
}
