import { validate, z, fields } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, wrap, created, accepted } from './index.js';
import { createPanelAppsService, APP_TYPES, APP_NAME_RE, LOGS_MAX_LINES, JOB_DEPS } from '../../services/panel-apps.js';

// /api/panel/apps — mounted by routes/categories/panel.js behind panelScope.
// No panel:* token scope exists for this group: the list and logs are readable
// with panel:read, every mutation is a browser-session action. The service
// pins paths, runtimes, domains, mounts and variables itself (422/404/409).

const relText = z.string().trim().min(1).max(256);
const envBody = z.record(z.string().max(64), z.string().max(1024)).refine((m) => Object.keys(m).length <= 64, 'At most 64 variables');
const createBody = z.object({
  name: z.string().trim().regex(APP_NAME_RE, '2 to 32 lowercase letters, digits or "-"'),
  type: z.enum(APP_TYPES),
  dir: relText,
  entry: relText,
  runtime: z.string().trim().max(16).optional(),
  domain: fields.hostname.optional(),
  mount: z.string().trim().max(200).optional(),
  websocket: z.boolean().optional(),
  env: envBody.optional(),
}).strict();
const updateBody = z.object({
  dir: relText.optional(), entry: relText.optional(), runtime: z.string().trim().max(16).optional(), domain: fields.hostname.optional(),
  mount: z.string().trim().max(200).optional(), websocket: z.boolean().optional(), env: envBody.optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'Nothing to update');
const idParam = z.object({ id: fields.id });
const logsQuery = z.object({ lines: z.coerce.number().int().min(1).max(LOGS_MAX_LINES).default(100) });
const removeQuery = z.object({ confirm: z.literal('true', { error: 'Pass confirm=true to remove the application' }) });

export function register(ctx) {
  ctx.panelApps = createPanelAppsService(ctx);
  ctx.jobs.register(JOB_DEPS, (job) => ctx.panelApps.runDeps(job));
  const svc = () => ctx.panelApps;
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'Applications can only be managed from a browser session')) : next());

  const r = panelRouter(ctx, 'apps');
  r.get('/', wrap((req) => svc().list(req.panel, req)));
  r.get('/runtimes', wrap((req) => svc().runtimes(req)));
  r.post('/', sessionOnly, validate({ body: createBody }), created((req) => svc().create(req.panel, req.body, req)));
  r.get('/jobs/:id', validate({ params: idParam }), wrap((req) => svc().getJob(req.panel, req.params.id)));
  r.get('/jobs/:id/stream', validate({ params: idParam }), (req, res, next) => {
    try { svc().streamJob(req.panel, req.params.id, req, res); } catch (err) { next(err); }
  });
  r.get('/:id', validate({ params: idParam }), wrap((req) => svc().get(req.panel, req.params.id, req)));
  r.put('/:id', sessionOnly, validate({ params: idParam, body: updateBody }), wrap((req) => svc().update(req.panel, req.params.id, req.body, req)));
  r.delete('/:id', sessionOnly, validate({ params: idParam, query: removeQuery }), wrap((req) => svc().remove(req.panel, req.params.id, req)));
  for (const action of ['start', 'stop', 'restart']) {
    r.post(`/:id/${action}`, sessionOnly, validate({ params: idParam, body: z.object({}).strict() }), wrap((req) => svc().control(req.panel, req.params.id, action, req)));
  }
  r.post('/:id/deps', sessionOnly, validate({ params: idParam, body: z.object({}).strict() }), accepted((req) => svc().deps(req.panel, req.params.id, req)));
  r.get('/:id/logs', validate({ params: idParam, query: logsQuery }), wrap((req) => svc().logs(req.panel, req.params.id, { lines: req.query.lines }, req)));

  return { path: '/apps', router: r };
}
