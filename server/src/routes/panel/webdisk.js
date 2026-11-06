import { validate, z, fields } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, wrap, requireFeature } from './index.js';
import { createPanelWebdiskService, PASSWORD_MIN_LENGTH, JOB_INSTALL, WEBDISK_PACKAGES } from '../../services/panel-webdisk.js';

const enabledBody = z.object({ enabled: z.boolean() }).strict();
const passwordBody = z.object({ password: z.string().min(PASSWORD_MIN_LENGTH, `At least ${PASSWORD_MIN_LENGTH} characters`).max(128) }).strict();
const idParam = z.object({ id: fields.id });

// Web Disk (contract §71): /api/panel/webdisk. Switching the daemon or setting
// its password mints a credential or a root-level unit, so both need a browser
// session; a panel:files token may read the status and the client recipes.
export function register(ctx) {
  ctx.panelWebdisk = createPanelWebdiskService(ctx);
  ctx.capabilities.register('rclone', { binaries: WEBDISK_PACKAGES, required: WEBDISK_PACKAGES });
  ctx.jobs.register(JOB_INSTALL, (job) => ctx.panelWebdisk.runInstall(job));
  const s = () => ctx.panelWebdisk;
  const r = panelRouter(ctx, 'files');
  r.use(requireFeature('webdisk'));
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'Web Disk can only be managed from a browser session')) : next());
  const maybeAccepted = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(d?.pending && d?.job ? 202 : 200).json({ data: d })).catch(next);
  r.get('/', wrap((req) => s().status(req.panel, req)));
  r.put('/', sessionOnly, validate({ body: enabledBody }), maybeAccepted((req) => s().setEnabled(req.panel, req.body, req)));
  r.put('/password', sessionOnly, validate({ body: passwordBody }), wrap((req) => s().setPassword(req.panel, req.body, req)));
  r.get('/clients', wrap((req) => s().clients(req.panel)));
  r.get('/jobs/:id', validate({ params: idParam }), wrap((req) => s().getJob(req.panel, req.params.id)));
  r.get('/jobs/:id/stream', validate({ params: idParam }), (req, res, next) => {
    try { s().streamJob(req.panel, req.params.id, req, res); } catch (err) { next(err); }
  });
  return { path: '/webdisk', router: r };
}
