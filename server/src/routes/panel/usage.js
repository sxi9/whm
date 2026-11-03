import { Router } from 'express';
import { validate, z } from '../../lib/validate.js';
import { requireScope } from '../../middleware/rbac.js';
import { HttpError } from '../../lib/errors.js';
import { createPanelUsageService } from '../../services/panel-usage.js';

// /api/panel/usage — disk, bandwidth and object counts against the plan (design §4.14).

async function scopeOf(ctx, req) {
  if (req.panel) return req.panel;
  if (typeof ctx.panel?.scope !== 'function') throw new HttpError(403, 'panel_scope_required', 'This endpoint needs a customer panel session');
  return ctx.panel.scope(req);
}

export function register(ctx) {
  ctx.panelUsage = createPanelUsageService(ctx);
  const svc = () => ctx.panelUsage;

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(scopeOf(ctx, req).then((scope) => fn(scope, req, res))).then((d) => { if (!res.headersSent) res.status(status).json(d?.meta ? d : { data: d }); }).catch(next);
  r.use(requireScope('panel:read'));

  r.get('/', wrap((scope) => svc().usage(scope)));
  r.post('/refresh', validate({ body: z.object({}).strict() }), wrap((scope, req) => svc().refresh(scope, req), 202));

  return { path: '/usage', router: r };
}
