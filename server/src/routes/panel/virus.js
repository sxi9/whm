import { validate, z, fields } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, wrap, accepted, relPath } from './index.js';
import { createPanelVirusService, SCAN_SCOPE_KEYS, JOB_SCAN } from '../../services/panel-virus.js';

// /api/panel/virus-scanner — mounted by routes/categories/panel.js behind
// panelScope. No panel:* token scope exists for this group, so starting a scan
// and deleting files are browser-session actions; status is readable with
// panel:read.

const scanBody = z.object({ scope: z.enum(SCAN_SCOPE_KEYS) }).strict();
const jobParam = z.object({ id: fields.id });
const removeBody = z.object({ paths: z.array(relPath).min(1).max(200) }).strict();

export function register(ctx) {
  ctx.panelVirus = createPanelVirusService(ctx);
  ctx.jobs.register(JOB_SCAN, (job) => ctx.panelVirus.run(job));
  const svc = () => ctx.panelVirus;
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'Virus scans can only be started from a browser session')) : next());

  const r = panelRouter(ctx, 'virus-scanner');
  r.get('/', wrap((req) => svc().status(req.panel, req)));
  r.post('/scans', sessionOnly, validate({ body: scanBody }), accepted((req) => svc().start(req.panel, req.body, req)));
  r.get('/scans/:id', validate({ params: jobParam }), wrap((req) => svc().getJob(req.panel, req.params.id)));
  r.get('/scans/:id/stream', validate({ params: jobParam }), (req, res, next) => {
    try { svc().streamJob(req.panel, req.params.id, req, res); } catch (err) { next(err); }
  });
  r.post('/infected/remove', sessionOnly, validate({ body: removeBody }), wrap((req) => svc().removeInfected(req.panel, req.body, req)));

  return { path: '/virus-scanner', router: r };
}
