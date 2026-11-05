import { validate, z, fields } from '../../lib/validate.js';
import { panelRouter, wrap, accepted } from './index.js';
import { createPanelLogsService, MAX_TAIL_BYTES, ERRORS_DEFAULT_LINES, ERRORS_MAX_LINES, STATS_JOB, STATS_SCHEDULE } from '../../services/panel-logs.js';

const statsDomain = z.object({ domain: fields.domain });

const kind = z.enum(['apache', 'nginx']).default('apache');
// The name must come from the listing; the shape alone keeps "/" and ".." out of the query.
const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/, 'Must be a log file name from the listing');

export async function register(ctx) {
  ctx.panelLogs = createPanelLogsService(ctx);
  const s = ctx.panelLogs;

  const r = panelRouter(ctx, 'logs');
  r.get('/', validate({ query: z.object({ kind }) }), wrap((req) => s.list(req.panel, req.query)));
  r.get('/tail', validate({ query: z.object({ kind, file: fileName, bytes: z.coerce.number().int().min(1).max(MAX_TAIL_BYTES).default(64 * 1024) }) }), wrap((req) => s.tail(req.panel, req.query, req)));
  r.get('/errors', validate({ query: z.object({ lines: z.coerce.number().int().min(1).max(ERRORS_MAX_LINES).default(ERRORS_DEFAULT_LINES), domain: fields.domain.optional() }) }), wrap((req) => s.errors(req.panel, req.query, req)));
  // The delegate streams the file itself; the JSON envelope is only used for errors raised before headers go out.
  r.get('/download', validate({ query: z.object({ kind, file: fileName }) }), (req, res, next) => s.download(req.panel, req.query, req, res).catch(next));
  r.get('/bandwidth', validate({ query: z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }) }), wrap((req) => s.bandwidth(req.panel, req.query)));
  r.get('/retention', wrap((req) => s.retention(req.panel)));
  r.put('/retention', validate({ body: z.object({ archiveLogs: z.boolean().optional(), removeOldArchives: z.boolean().optional() }).strict() }), wrap((req) => s.setRetention(req.panel, req.body, req)));

  // Visitors (GoAccess): summaries from the account's own stats directory, on-demand generation as a job,
  // and the full HTML report streamed with a sandbox CSP for the page's iframe.
  ctx.jobs.register(STATS_JOB, (job) => s.stats.run(job));
  try { ctx.scheduler?.ensure?.(STATS_SCHEDULE.name, STATS_SCHEDULE.cron, STATS_JOB); } catch (err) { ctx.logger?.warn?.({ err }, 'panel logs: statistics schedule not registered'); }
  r.get('/stats', wrap((req) => s.stats.summary(req.panel)));
  r.post('/stats/:domain/generate', validate({ params: statsDomain }), accepted((req) => s.stats.generate(req.panel, req.params.domain, req)));
  r.get('/stats/:domain/report', validate({ params: statsDomain }), (req, res, next) => s.stats.report(req.panel, req.params.domain, req, res).catch(next));

  return { path: '/logs', router: r };
}
