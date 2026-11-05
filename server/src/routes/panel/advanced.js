import { validate, z, fields } from '../../lib/validate.js';
import { panelRouter, wrap } from './index.js';
import { createPanelHtaccessService, ERROR_CODES } from '../../services/panel-htaccess.js';

// /api/panel/advanced — mounted by routes/categories/panel.js behind panelScope.
// Custom error pages (feature errpgs): one HTML file per status code under
// <docroot>/errors plus the ErrorDocument lines of the panel-managed .htaccess
// block. No token scope is granted for this group, so mutations are session-only.

const codeParam = z.object({ code: z.enum(ERROR_CODES) });
const domainQuery = z.object({ domain: fields.domain });
const pageBody = z.object({
  domain: fields.domain,
  title: z.string().trim().max(120).regex(/^[^\0\r\n]*$/, 'One line').default(''),
  message: z.string().max(4000).regex(/^[^\0]*$/).default(''),
}).strict();

export async function register(ctx) {
  ctx.panelHtaccess ??= createPanelHtaccessService(ctx);
  const svc = ctx.panelHtaccess;

  const r = panelRouter(ctx, 'advanced');
  r.get('/error-pages', validate({ query: domainQuery }), wrap((req) => svc.errorPages.list(req.panel, req.query, req)));
  r.put('/error-pages/:code', validate({ params: codeParam, body: pageBody }), wrap((req) => svc.errorPages.set(req.panel, { ...req.body, code: req.params.code }, req)));
  r.delete('/error-pages/:code', validate({ params: codeParam, query: domainQuery.extend({ deleteFile: z.enum(['true', 'false']).transform((v) => v === 'true').default(true) }) }), wrap((req) => svc.errorPages.remove(req.panel, { domain: req.query.domain, code: req.params.code, deleteFile: req.query.deleteFile }, req)));

  return { path: '/advanced', router: r };
}
