import { validate, z, fields, patchOf } from '../../lib/validate.js';
import { panelRouter, wrap, created } from './index.js';
import { createPanelDnsService, PANEL_RECORD_TYPES } from '../../services/panel-dns.js';

const zoneParam = z.object({ domain: fields.hostname });
const recordParam = z.object({ domain: fields.hostname, id: fields.id });
const ttl = z.coerce.number().int().min(0).max(2147483647);
const recordTtl = z.preprocess((v) => (v === '' ? null : v), z.union([z.null(), ttl, z.string().regex(/^\d+[smhdw]?$/)]));
const recordBody = z.object({
  name: z.string().trim().max(253).default('@'),
  type: z.enum(PANEL_RECORD_TYPES),
  ttl: recordTtl.optional(),
  priority: z.number().int().min(0).max(65535).nullable().optional(),
  value: z.string().trim().min(1).max(4096),
});

export async function register(ctx) {
  ctx.panelDns = createPanelDnsService(ctx);
  const s = ctx.panelDns;

  const r = panelRouter(ctx, 'dns');
  r.get('/zones', wrap((req) => s.zones(req.panel)));
  r.get('/zones/:domain', validate({ params: zoneParam }), wrap((req) => s.zone(req.panel, req.params.domain)));
  r.post('/zones/:domain/records', validate({ params: zoneParam, body: recordBody.strict() }), created((req) => s.addRecord(req.panel, req.params.domain, req.body, req)));
  r.put('/zones/:domain/records/:id', validate({ params: recordParam, body: patchOf(recordBody).strict() }), wrap((req) => s.updateRecord(req.panel, req.params.domain, req.params.id, req.body, req)));
  r.delete('/zones/:domain/records/:id', validate({ params: recordParam }), wrap((req) => s.deleteRecord(req.panel, req.params.domain, req.params.id, req)));
  r.get('/zones/:domain/email', validate({ params: zoneParam }), wrap((req) => s.emailStatus(req.panel, req.params.domain)));

  return { path: '/dns', router: r };
}
