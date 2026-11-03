import { validate } from '../../lib/validate.js';
import { panelRouter, wrap, requireFeature } from './index.js';
import { createPanelCronService, crontabBody } from '../../services/panel-cron.js';

// /api/panel/cron — mounted by routes/categories/panel.js behind panelScope.

export async function register(ctx) {
  const svc = createPanelCronService(ctx);
  ctx.panelCron = svc;
  ctx.capabilities.register('cron', { binaries: ['crontab'], required: ['crontab'] });

  const r = panelRouter(ctx, 'cron');
  r.use(requireFeature('cron'));
  r.get('/', wrap((req) => svc.get(req.panel, req)));
  r.put('/', validate({ body: crontabBody }), wrap((req) => svc.set(req.panel, req.body, req)));
  r.delete('/', wrap((req) => svc.remove(req.panel, req)));

  return { path: '/cron', router: r };
}
