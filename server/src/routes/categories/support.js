import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot, requireReseller, requireRole } from '../../middleware/rbac.js';
import { createSupportService, TICKET_CATEGORIES, TICKET_SEVERITIES, TICKET_STATUSES, GRANT_STATUSES } from '../../services/support.js';
import { createSupportChatService, CONVERSATION_STATUSES, MESSAGE_MAX_CHARS } from '../../services/support-chat.js';

// Account Conversations are the one Support surface the hosted-account login uses.
const requireParticipant = requireRole('root', 'reseller', 'user');
const accountParam = z.object({ username: fields.username });
const chatListQuery = z.object({
  page: fields.page, pageSize: fields.pageSize, q: z.string().trim().max(100).optional(),
  status: z.enum(CONVERSATION_STATUSES).optional(), unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['activity', 'username', 'domain', 'unread', 'status']).default('activity'), dir: z.enum(['asc', 'desc']).default('desc'),
});
const chatThreadQuery = z.object({ before: fields.id.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });
const messageBody = z.object({ body: z.string().regex(/^[^\0]*$/).transform((v) => v.replace(/\r\n?/g, '\n').trim()).pipe(z.string().min(1, 'Write a message first').max(MESSAGE_MAX_CHARS, `Messages are limited to ${MESSAGE_MAX_CHARS} characters`)) }).strict();
const conversationPatch = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
  subject: z.string().trim().min(1).max(200).regex(/^[^\r\n\0]*$/, 'Must be a single line').optional(),
}).strict().refine((b) => b.status !== undefined || b.subject !== undefined, { message: 'Nothing to change', path: ['_'] });

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
  ctx.supportChat = createSupportChatService(ctx);
  const s = ctx.support;
  const chat = ctx.supportChat;
  ctx.jobs.register(s.JOB_EXPIRE, (job) => s.access.expireDue({ log: job.log }));
  ctx.scheduler.ensure(s.SCHEDULE_EXPIRE, '*/5 * * * *', s.JOB_EXPIRE);
  s.syncSchedule();

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);

  // Support Center
  r.get('/center', requireReseller, wrap((req) => s.center(req.user)));
  r.get('/docs', requireReseller, wrap((req) => s.docs.list(req.user)));
  r.get('/docs/:slug', requireReseller, validate({ params: z.object({ slug: docSlug }), query: z.object({ section: docSlug.optional() }) }), wrap((req) => s.docs.get(req.params.slug, req.query.section, req.user)));
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

  // Account Conversations
  r.get('/chat', requireParticipant, validate({ query: chatListQuery }), wrap((req) => chat.listConversations(req.query, req.user)));
  r.get('/chat/unread', requireParticipant, wrap((req) => chat.unread(req.user)));
  r.get('/chat/:username', requireParticipant, validate({ params: accountParam, query: chatThreadQuery }), wrap((req) => chat.get(req.params.username, req.user, req.query)));
  r.get('/chat/:username/stream', requireParticipant, validate({ params: accountParam }), (req, res, next) => {
    let snapshot;
    try { snapshot = chat.get(req.params.username, req.user, { limit: 50 }); } catch (err) { return next(err); }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'snapshot', ...snapshot });
    const unsubscribe = chat.subscribe(snapshot.account.id, send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });
  r.post('/chat/:username/messages', requireParticipant, validate({ params: accountParam, body: messageBody }), (req, res, next) => {
    Promise.resolve(chat.post(req.params.username, req.body.body, req.user, req)).then((d) => {
      // The request-level audit row is written when the response finishes and
      // would carry the message text; it records the length instead.
      req.body = { chars: req.body.body.length };
      res.status(201).json({ data: d });
    }).catch(next);
  });
  r.post('/chat/:username/read', requireParticipant, validate({ params: accountParam }), wrap((req) => chat.markRead(req.params.username, req.user)));
  r.patch('/chat/:username', requireReseller, validate({ params: accountParam, body: conversationPatch }), wrap((req) => chat.update(req.params.username, req.body, req.user, req)));

  return { path: '/support', router: r };
}
