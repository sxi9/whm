import { validate, z, fields } from '../../lib/validate.js';
import { panelRouter, wrap, created, relPath } from './index.js';
import { createPanelDomainsService, SUB_LABEL } from '../../services/panel-domains.js';

// Mounted by routes/categories/panel.js under /api/panel after panelScope has
// pinned req.panel (design §3.1); without it the request is refused here too.
const domainParam = z.object({ domain: fields.domain });
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true').optional();
const redirectBody = z.object({
  targetUrl: z.string().trim().min(1).max(2048),
  type: z.enum(['permanent', 'temporary']).optional(),
  matchWww: z.boolean().optional(),
  keepPath: z.boolean().optional(),
}).strict();

export async function register(ctx) {
  ctx.panelDomains = createPanelDomainsService(ctx);
  const s = ctx.panelDomains;
  // Create results carry meta.warnings (routing not applied, vhost pending), so the envelope is kept.
  const createdWithMeta = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json(d?.meta ? d : { data: d })).catch(next);

  const r = panelRouter(ctx, 'domains');
  r.get('/', validate({ query: z.object({ type: z.enum(['main', 'addon', 'sub', 'parked']).optional() }) }), wrap((req) => s.list(req.panel, req.query)));

  r.post('/addon', validate({ body: z.object({ domain: fields.domain, docroot: relPath.optional(), createZone: z.boolean().default(true) }).strict() }),
    createdWithMeta((req) => s.addAddon(req.panel, req.body, req)));
  r.delete('/addon/:domain', validate({ params: domainParam, query: z.object({ removeZone: boolQuery, removeDocroot: boolQuery }) }),
    wrap((req) => s.removeAddon(req.panel, req.params.domain, { removeZone: req.query.removeZone ?? true, removeDocroot: req.query.removeDocroot ?? false }, req)));

  r.post('/sub', validate({ body: z.object({ label: z.string().toLowerCase().regex(SUB_LABEL, 'Letters, digits and "-", max 63 chars'), parent: fields.domain, docroot: relPath.optional() }).strict() }),
    createdWithMeta((req) => s.addSub(req.panel, req.body, req)));
  r.delete('/sub/:domain', validate({ params: domainParam, query: z.object({ removeDocroot: boolQuery }) }),
    wrap((req) => s.removeSub(req.panel, req.params.domain, { removeDocroot: req.query.removeDocroot ?? false }, req)));

  r.post('/parked', validate({ body: z.object({ domain: fields.domain, createZone: z.boolean().default(true) }).strict() }),
    created((req) => s.addParked(req.panel, req.body, req)));
  r.delete('/parked/:domain', validate({ params: domainParam, query: z.object({ removeZone: boolQuery }) }),
    wrap((req) => s.removeParked(req.panel, req.params.domain, { removeZone: req.query.removeZone ?? true }, req)));

  r.get('/:domain/redirect', validate({ params: domainParam }), wrap((req) => s.getRedirect(req.panel, req.params.domain)));
  r.put('/:domain/redirect', validate({ params: domainParam, body: redirectBody }), wrap((req) => s.setRedirect(req.panel, req.params.domain, req.body, req)));
  r.delete('/:domain/redirect', validate({ params: domainParam }), wrap((req) => s.removeRedirect(req.panel, req.params.domain, req)));

  return { path: '/domains', router: r };
}
