import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createSupportService, TICKET_CATEGORIES, TICKET_SEVERITIES, TICKET_STATUSES, GRANT_STATUSES } from '../../services/support.js';

const idParam = z.object({ id: fields.id });
const singleLine = (max) => z.string().trim().min(1).max(max).regex(/^[^\r\n\0]*$/, 'Must be a single line');
const email = fields.email.regex(/^[A-Za-z0-9_]/, 'May not start with "-"');
const docSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/);
const listQuery = (statuses, sorts) => z.object({
  page: fields.page, pageSize: fields.pageSize, q: z.string().trim().max(100).optional(),
  status: z.enum(statuses).optional(), sort: z.enum(sorts).optional(), dir: z.enum(['asc', 'desc']).optional(),
});
const ticketBody = z.object({
  subject: singleLine(200),
  description: z.string().trim().min(10, 'Describe the problem in at least 10 characters').max(20_000),
  category: z.enum(TICKET_CATEGORIES).default('general'),
  severity: z.enum(TICKET_SEVERITIES).default('normal'),
  contactEmail: z.union([z.literal(''), email]).optional(),
  includeSnapshot: z.boolean().default(true),
}).strict();
const ticketPatch = z.object({ status: z.enum(TICKET_STATUSES) }).strict();
// The label becomes the key comment and the token name, so it is kept to the
// characters an authorized_keys line and an argv element accept.
const grantBody = z.object({
  label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/, 'Letters, digits, "_", "." or "-"; max 48 chars'),
  hours: z.number().int().min(1).max(8760).optional(),
  ssh: z.boolean().default(true),
  apiToken: z.boolean().default(true),
  tokenScopes: z.array(z.enum(['*', 'development:read', 'development:write'])).max(3).optional(),
  note: z.string().trim().max(500).regex(/^[^\0]*$/).optional(),
}).strict();
const settingsBody = z.object({
  email: z.union([z.literal(''), email]).optional(),
  providerName: singleLine(80).optional(),
  portalUrl: z.union([z.literal(''), z.string().url().max(500).refine((u) => /^https?:\/\//.test(u), 'Must be an http(s) URL')]).optional(),
  access: z.object({ defaultHours: z.number().int().min(1).max(8760).optional(), maxHours: z.number().int().min(1).max(8760).optional() }).strict().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change', path: ['_'] });

export async function register(ctx) {
  ctx.support = createSupportService(ctx);
  const s = ctx.support;
  ctx.jobs.register(s.JOB_EXPIRE, (job) => s.access.expireDue({ log: job.log }));
  ctx.scheduler.ensure(s.SCHEDULE_EXPIRE, '*/5 * * * *', s.JOB_EXPIRE);

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);

  // Support Center
  r.get('/center', requireReseller, wrap((req) => s.center(req.user)));
  r.get('/docs', requireReseller, wrap(() => s.docs.list()));
  r.get('/docs/:slug', requireReseller, validate({ params: z.object({ slug: docSlug }), query: z.object({ section: docSlug.optional() }) }), wrap((req) => s.docs.get(req.params.slug, req.query.section)));
  r.get('/diagnostics', requireRoot, (req, res, next) => {
    s.diagnostics(req).then((bundle) => {
      res.set('Content-Disposition', `attachment; filename="whm-diagnostics-${bundle.generatedAt.replace(/[:.]/g, '-')}.json"`);
      res.json({ data: bundle });
    }).catch(next);
  });
  r.get('/settings', requireRoot, wrap(() => s.settings()));
  r.put('/settings', requireRoot, validate({ body: settingsBody }), wrap((req) => s.updateSettings(req.body, req)));

  // Create Support Ticket
  r.get('/snapshot', requireRoot, wrap(() => s.snapshot()));
  r.get('/tickets', requireRoot, validate({ query: listQuery(TICKET_STATUSES, ['created_at', 'severity', 'status', 'subject']) }), wrap((req) => s.tickets.list(req.query)));
  r.post('/tickets', requireRoot, validate({ body: ticketBody }), created((req) => s.tickets.create(req.body, req.user, req)));
  r.get('/tickets/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.tickets.get(req.params.id)));
  r.patch('/tickets/:id', requireRoot, validate({ params: idParam, body: ticketPatch }), wrap((req) => s.tickets.setStatus(req.params.id, req.body.status, req)));
  r.post('/tickets/:id/resend', requireRoot, validate({ params: idParam }), wrap((req) => s.tickets.resend(req.params.id, req)));
  r.delete('/tickets/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.tickets.remove(req.params.id, req)));

  // Grant cPanel Support Access
  r.get('/access', requireRoot, validate({ query: listQuery(GRANT_STATUSES, ['created_at', 'expires_at', 'status', 'label']) }), wrap((req) => s.access.list(req.query)));
  r.get('/access/status', requireRoot, wrap(() => s.access.status()));
  r.post('/access', requireRoot, validate({ body: grantBody }), created((req) => s.access.grant(req.body, req.user, req)));
  r.post('/access/expire-due', requireRoot, wrap((req) => s.access.expireDue({ req })));
  r.get('/access/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.access.get(req.params.id)));
  r.delete('/access/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.access.revoke(req.params.id, req.user, req)));

  return { path: '/support', router: r };
}
