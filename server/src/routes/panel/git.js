import { validate, z, fields } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, wrap, accepted } from './index.js';
import { createPanelGitService, repoName, repoDir, gitUrl, JOB_CLONE, JOB_PULL, JOB_DEPLOY } from '../../services/panel-git.js';

// /api/panel/git — mounted by routes/categories/panel.js behind panelScope.
// No panel:* token scope exists for this group: every mutation is a
// browser-session action; the list and the detail are readable with panel:read.

const createBody = z.object({
  name: repoName,
  dir: z.union([z.literal(''), repoDir]).optional(),
  url: z.union([z.literal(''), gitUrl]).optional(),
  adopt: z.boolean().optional(),
}).strict().refine((b) => !(b.url && b.adopt), { message: 'A clone cannot adopt an existing repository', path: ['adopt'] });
const idParam = z.object({ id: fields.id });
const deployBody = z.object({ dryRun: z.boolean().optional() }).strict();
const removeQuery = z.object({ confirm: z.literal('true', { error: 'Pass confirm=true to remove the repository' }), files: z.enum(['true', 'false']).default('true') });

export function register(ctx) {
  ctx.panelGit = createPanelGitService(ctx);
  ctx.jobs.register(JOB_CLONE, (job) => ctx.panelGit.runClone(job));
  ctx.jobs.register(JOB_PULL, (job) => ctx.panelGit.runPull(job));
  ctx.jobs.register(JOB_DEPLOY, (job) => ctx.panelGit.runDeploy(job));
  const svc = () => ctx.panelGit;
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'Repositories can only be managed from a browser session')) : next());

  const r = panelRouter(ctx, 'git');
  r.get('/', wrap((req) => svc().list(req.panel, req)));
  r.post('/', sessionOnly, validate({ body: createBody }), (req, res, next) => {
    Promise.resolve(svc().create(req.panel, { ...req.body, dir: req.body.dir || undefined, url: req.body.url || undefined }, req))
      .then(({ status, data }) => res.status(status).json({ data })).catch(next);
  });
  r.get('/jobs/:id', validate({ params: idParam }), wrap((req) => svc().getJob(req.panel, req.params.id)));
  r.get('/jobs/:id/stream', validate({ params: idParam }), (req, res, next) => {
    try { svc().streamJob(req.panel, req.params.id, req, res); } catch (err) { next(err); }
  });
  r.get('/:id', validate({ params: idParam }), wrap((req) => svc().get(req.panel, req.params.id, req)));
  r.post('/:id/pull', sessionOnly, validate({ params: idParam, body: z.object({}).strict() }), accepted((req) => svc().pull(req.panel, req.params.id, req)));
  r.post('/:id/deploy', sessionOnly, validate({ params: idParam, body: deployBody }), accepted((req) => svc().deploy(req.panel, req.params.id, { dryRun: req.body.dryRun }, req)));
  r.delete('/:id', sessionOnly, validate({ params: idParam, query: removeQuery }), wrap((req) => svc().remove(req.panel, req.params.id, { files: req.query.files === 'true' }, req)));

  return { path: '/git', router: r };
}
