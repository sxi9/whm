import { validate, z } from '../../lib/validate.js';
import { panelRouter, wrap } from './index.js';
import { createPanelLogsService, MAX_TAIL_BYTES } from '../../services/panel-logs.js';

const kind = z.enum(['apache', 'nginx']).default('apache');
// The name must come from the listing; the shape alone keeps "/" and ".." out of the query.
const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/, 'Must be a log file name from the listing');

export async function register(ctx) {
  ctx.panelLogs = createPanelLogsService(ctx);
  const s = ctx.panelLogs;

  const r = panelRouter(ctx, 'logs');
  r.get('/', validate({ query: z.object({ kind }) }), wrap((req) => s.list(req.panel, req.query)));
  r.get('/tail', validate({ query: z.object({ kind, file: fileName, bytes: z.coerce.number().int().min(1).max(MAX_TAIL_BYTES).default(64 * 1024) }) }), wrap((req) => s.tail(req.panel, req.query, req)));
  // The delegate streams the file itself; the JSON envelope is only used for errors raised before headers go out.
  r.get('/download', validate({ query: z.object({ kind, file: fileName }) }), (req, res, next) => s.download(req.panel, req.query, req, res).catch(next));
  r.get('/bandwidth', validate({ query: z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }) }), wrap((req) => s.bandwidth(req.panel, req.query)));
  r.get('/retention', wrap((req) => s.retention(req.panel)));
  r.put('/retention', validate({ body: z.object({ archiveLogs: z.boolean().optional(), removeOldArchives: z.boolean().optional() }).strict() }), wrap((req) => s.setRetention(req.panel, req.body, req)));

  return { path: '/logs', router: r };
}
