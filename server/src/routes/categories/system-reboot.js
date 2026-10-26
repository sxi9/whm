import { Router } from 'express';
import { validate, z } from '../../lib/validate.js';
import { requireRoot } from '../../middleware/rbac.js';
import { createSystemRebootService, REBOOT_MODES } from '../../services/system-reboot.js';

const modeParam = z.object({ mode: z.enum(REBOOT_MODES) });
const rebootBody = z.object({
  reason: z.string().trim().max(200).optional(),
  ignoreActiveWork: z.boolean().default(false),
}).strict();
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) });

export async function register(ctx) {
  ctx.systemReboot = createSystemRebootService(ctx);
  const s = ctx.systemReboot;

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);

  // Graceful / Forceful Server Reboot: pre-flight, trigger, history.
  r.get('/preflight', requireRoot, wrap(() => s.preflight()));
  r.get('/history', requireRoot, validate({ query: historyQuery }), wrap((req) => s.history(req.query.limit)));
  r.post('/:mode', requireRoot, validate({ params: modeParam, body: rebootBody }), wrap((req) => s.reboot(req.params.mode, req.body, req)));

  return { path: '/system-reboot', router: r };
}
