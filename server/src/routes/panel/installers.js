import { validate, z, fields } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, wrap, accepted } from './index.js';
import { wpPath, WP_ADMIN_USER, WP_TITLE, INSTALL_ID_RE } from '../../services/panel-software.js';
import { createPanelInstallersService, APP_IDS, JOB_INSTALL } from '../../services/panel-installers.js';

// /api/panel/software/installers — mounted by routes/categories/panel.js behind
// panelScope, beside the WordPress routes of software.js. No panel:* token
// scope exists for this group, so every mutation is a browser-session action;
// the list is readable with panel:read.

const installBody = z.object({
  domain: fields.domain,
  path: z.union([z.literal(''), wpPath]).default(''),
  title: z.string().trim().regex(WP_TITLE, 'A single line of at most 120 characters').optional(),
  adminUser: z.string().trim().regex(WP_ADMIN_USER, 'Letters, digits, ".", "_", "@" or "-"; max 60 characters').refine((v) => v.length >= 2, 'At least 2 characters').optional(),
  adminEmail: fields.email.optional(),
  adminPassword: z.string().min(8, 'At least 8 characters').max(128).regex(/^[^\0\r\n]+$/).optional(),
}).strict();
const appParam = z.object({ app: z.enum(APP_IDS) });
const idParam = z.object({ id: z.string().regex(INSTALL_ID_RE) });
const jobParam = z.object({ id: fields.id });
const removeQuery = z.object({ confirm: z.literal('true', { error: 'Pass confirm=true to remove the installation' }), database: z.enum(['true', 'false']).default('false') });

export function register(ctx) {
  ctx.panelInstallers = createPanelInstallersService(ctx);
  ctx.jobs.register(JOB_INSTALL, (job) => ctx.panelInstallers.runInstall(job));
  const svc = () => ctx.panelInstallers;
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'Application installs can only be managed from a browser session')) : next());

  const r = panelRouter(ctx, 'software');
  r.get('/', wrap((req) => svc().list(req.panel, req)));
  r.get('/jobs/:id', validate({ params: jobParam }), wrap((req) => svc().getJob(req.panel, req.params.id)));
  r.get('/jobs/:id/stream', validate({ params: jobParam }), (req, res, next) => {
    try { svc().streamJob(req.panel, req.params.id, req, res); } catch (err) { next(err); }
  });
  r.post('/:app', sessionOnly, validate({ params: appParam, body: installBody }), accepted((req) => svc().install(req.panel, req.params.app, req.body, req)));
  r.delete('/:id', sessionOnly, validate({ params: idParam, query: removeQuery }), wrap((req) => svc().remove(req.panel, req.params.id, { database: req.query.database === 'true' }, req)));

  return { path: '/software/installers', router: r };
}
