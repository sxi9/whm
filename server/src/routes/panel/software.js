import { validate, z, fields } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, wrap, accepted } from './index.js';
import { createPanelSoftwareService, wpPath, WP_ADMIN_USER, WP_TITLE, WP_LOCALE, INSTALL_ID_RE, JOB_INSTALL, JOB_UPDATE } from '../../services/panel-software.js';

// /api/panel/software — mounted by routes/categories/panel.js behind panelScope.
// No panel:* token scope exists for this group, so every mutation is a
// browser-session action; the list is readable with panel:read.

const installBody = z.object({
  domain: fields.domain,
  path: z.union([z.literal(''), wpPath]).default(''),
  title: z.string().trim().regex(WP_TITLE, 'A single line of at most 120 characters'),
  adminUser: z.string().trim().regex(WP_ADMIN_USER, 'Letters, digits, ".", "_", "@" or "-"; max 60 characters'),
  adminEmail: fields.email,
  adminPassword: z.string().min(8, 'At least 8 characters').max(128).regex(/^[^\0\r\n]+$/).optional(),
  locale: z.string().regex(WP_LOCALE, 'A WordPress locale such as en_US or de_DE').optional(),
}).strict();
const idParam = z.object({ id: z.string().regex(INSTALL_ID_RE) });
const jobParam = z.object({ id: fields.id });
const removeQuery = z.object({ confirm: z.literal('true', { error: 'Pass confirm=true to remove the installation' }), database: z.enum(['true', 'false']).default('false') });

export function register(ctx) {
  ctx.panelSoftware = createPanelSoftwareService(ctx);
  ctx.jobs.register(JOB_INSTALL, (job) => ctx.panelSoftware.runInstall(job));
  ctx.jobs.register(JOB_UPDATE, (job) => ctx.panelSoftware.runUpdate(job));
  const svc = () => ctx.panelSoftware;
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'WordPress installs can only be managed from a browser session')) : next());

  const r = panelRouter(ctx, 'software');
  r.get('/wordpress', wrap((req) => svc().list(req.panel, req)));
  r.post('/wordpress', sessionOnly, validate({ body: installBody }), accepted((req) => svc().install(req.panel, req.body, req)));
  r.get('/wordpress/jobs/:id', validate({ params: jobParam }), wrap((req) => svc().getJob(req.panel, req.params.id)));
  r.get('/wordpress/jobs/:id/stream', validate({ params: jobParam }), (req, res, next) => {
    try { svc().streamJob(req.panel, req.params.id, req, res); } catch (err) { next(err); }
  });
  r.post('/wordpress/:id/update', sessionOnly, validate({ params: idParam, body: z.object({}).strict() }), accepted((req) => svc().update(req.panel, req.params.id, req)));
  r.delete('/wordpress/:id', sessionOnly, validate({ params: idParam, query: removeQuery }), wrap((req) => svc().remove(req.panel, req.params.id, { database: req.query.database === 'true' }, req)));

  return { path: '/software', router: r };
}
