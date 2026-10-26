import express, { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createCpanelService, AUDIENCES, SEVERITIES, IMAGE_KINDS, UPGRADE_JOB } from '../../services/cpanel.js';

const singleLine = (max) => z.string().trim().max(max).regex(/^[^\r\n\0<>]*$/, 'A single line without angle brackets');
const hexColor = z.union([z.literal(''), z.string().trim().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a #rgb or #rrggbb colour')]);
const httpUrl = z.union([z.literal(''), z.string().trim().max(500).url().refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links')]);
const brandingBody = z.object({
  companyName: singleLine(80).min(1).optional(),
  tagline: singleLine(120).optional(),
  primaryColor: hexColor.optional(),
  chromeColor: hexColor.optional(),
  helpUrl: httpUrl.optional(),
  docsUrl: httpUrl.optional(),
  supportUrl: httpUrl.optional(),
  loginNotice: z.string().max(2000).optional(),
  footerText: singleLine(200).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field', path: ['companyName'] });
const imageKind = z.object({ kind: z.enum(Object.keys(IMAGE_KINDS)) });
const isoDate = z.string().datetime({ offset: true }).nullable().optional();
const newsBody = z.object({
  title: singleLine(160).min(1),
  body: z.string().max(20_000).default(''),
  audience: z.enum(AUDIENCES).default('all'),
  severity: z.enum(SEVERITIES).default('info'),
  enabled: z.boolean().default(true),
  startsAt: isoDate,
  endsAt: isoDate,
}).strict();
const newsPatch = newsBody.partial().refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field', path: ['title'] });
const idParam = z.object({ id: fields.id });
const listName = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'Mailing list names use lowercase letters, digits, ".", "_" and "-"');
const listPassword = z.string().min(8, 'At least 8 characters').max(128).regex(/^[^\s-][^\0-\x1f\x7f]*$/, 'Passwords must not start with "-" or contain control characters');
const kid = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Key ids use letters, digits, ".", "_" and "-"');

export async function register(ctx) {
  ctx.cpanel = createCpanelService(ctx);
  const s = ctx.cpanel;
  ctx.jobs.register(UPGRADE_JOB, (job) => s.upgrade.run(job));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const status = (code, fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(code).json({ data: d })).catch(next);
  const sendImage = (req, res, next) => {
    try {
      const img = s.branding.image(req.params.kind);
      res.set('Cache-Control', 'private, max-age=86400');
      res.set('ETag', `"${img.sha256.slice(0, 16)}"`);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      if (req.get('if-none-match') === `"${img.sha256.slice(0, 16)}"`) return res.status(304).end();
      res.type(img.mime).sendFile(img.file);
    } catch (err) { next(err); }
  };
  const rawImage = express.raw({ type: () => true, limit: `${Math.max(...Object.values(IMAGE_KINDS).map((k) => k.maxBytes)) + 1024}b` });

  const r = Router();

  // Change Log
  r.get('/changelog', requireReseller, wrap(() => s.changelog.get()));

  // Customization
  r.get('/branding', wrap(() => s.branding.get()));
  r.put('/branding', requireRoot, validate({ body: brandingBody }), wrap((req) => s.branding.update(req.body, req)));
  r.get('/branding/:kind', validate({ params: imageKind }), sendImage);
  r.post('/branding/:kind', requireRoot, validate({ params: imageKind }), rawImage, status(201, (req) => s.branding.setImage(req.params.kind, req.body, req)));
  r.delete('/branding/:kind', requireRoot, validate({ params: imageKind }), wrap((req) => s.branding.removeImage(req.params.kind, req)));

  // Modify cPanel & WHM News
  r.get('/news/active', wrap((req) => s.news.active(req.user)));
  r.get('/news', requireRoot, validate({ query: z.object({ page: fields.page, pageSize: fields.pageSize, q: z.string().trim().max(200).optional(), status: z.enum(['active', 'scheduled', 'expired', 'disabled']).optional() }) }), wrap((req) => s.news.list(req.query)));
  r.post('/news', requireRoot, validate({ body: newsBody }), status(201, (req) => s.news.create(req.body, req.user, req)));
  r.get('/news/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.news.get(req.params.id)));
  r.put('/news/:id', requireRoot, validate({ params: idParam, body: newsPatch }), wrap((req) => s.news.update(req.params.id, req.body, req)));
  r.delete('/news/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.news.remove(req.params.id, req)));

  // Reset a Mailman Password
  r.get('/mailman', requireRoot, wrap(() => s.mailman.detect()));
  r.get('/mailman/lists', requireRoot, wrap(() => s.mailman.lists()));
  r.post('/mailman/lists/:list/password', requireRoot, validate({ params: z.object({ list: listName }), body: z.object({ password: listPassword }).strict() }), wrap((req) => s.mailman.resetPassword(req.params.list, req.body.password, req)));
  r.post('/mailman/site-password', requireRoot, validate({ body: z.object({ password: listPassword, creator: z.boolean().default(false) }).strict() }), wrap((req) => s.mailman.setSitePassword(req.body.password, req.body.creator, req)));

  // Upgrade to Latest Version
  r.get('/upgrade', requireRoot, wrap(() => s.upgrade.status()));
  r.post('/upgrade/check', requireRoot, wrap((req) => s.upgrade.check(req)));
  r.post('/upgrade/start', requireRoot, validate({ body: z.object({ allowUnverified: z.boolean().default(false), skipNode: z.boolean().default(false) }).strict().default({}) }), status(202, (req) => s.upgrade.start(req.body, req.user, req)));
  r.get('/upgrade/log', requireRoot, wrap(() => s.upgrade.log()));
  r.get('/upgrade/keys', requireRoot, wrap(() => s.releaseKeys.list()));
  r.post('/upgrade/keys', requireRoot, validate({ body: z.object({ kid, pem: z.string().max(4096).regex(/-----BEGIN PUBLIC KEY-----/, 'Paste a PEM public key') }).strict() }), status(201, (req) => s.releaseKeys.add(req.body.kid, req.body.pem, req)));
  r.delete('/upgrade/keys/:kid', requireRoot, validate({ params: z.object({ kid }) }), wrap((req) => s.releaseKeys.remove(req.params.kid, req)));

  // The client reads branding from /api/branding on load (every signed-in role);
  // the same handlers serve the logo and favicon.
  const b = Router();
  b.get('/', wrap(() => s.branding.get()));
  b.get('/:kind', validate({ params: imageKind }), sendImage);

  return [{ path: '/cpanel', router: r }, { path: '/branding', router: b }];
}
