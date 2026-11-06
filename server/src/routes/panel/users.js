import { validate, z, fields } from '../../lib/validate.js';
import { panelRouter, wrap, requireFeature } from './index.js';
import { createPanelUsersService, SUBUSER_NAME } from '../../services/panel-users.js';
import { REL_PATH } from '../../services/panel-ftp.js';

// /api/panel/users — sub-users of the pinned account (contract §69). No token
// scope exists for this group: session-only, like Software.

const username = z.string().regex(SUBUSER_NAME, 'Lowercase letters, digits, ".", "_" or "-"; must start with a letter or digit; max 32 chars');
const singleLine = (max) => z.string().trim().max(max).regex(/^[^\n\r\0]*$/, 'Must be a single line');
const contactEmail = z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Must be an email address').transform((s) => s.toLowerCase());
const quotaMb = z.number().int().min(0).max(1_000_000_000).nullable();
const homeDir = z.string().regex(REL_PATH, 'Relative path without ".." segments');
const servicesBody = z.object({
  email: z.object({ enabled: z.boolean(), quotaMb: quotaMb.optional() }).strict().optional(),
  ftp: z.object({ enabled: z.boolean(), homeDir: homeDir.optional() }).strict().optional(),
  dav: z.object({ enabled: z.boolean() }).strict().optional(),
}).strict();
const createBody = z.object({
  username, domain: fields.domain, password: fields.password,
  fullName: singleLine(128).default(''), contactEmail: contactEmail.nullable().default(null),
  services: servicesBody.default({}),
}).strict();
const updateBody = z.object({
  fullName: singleLine(128).optional(), contactEmail: contactEmail.nullable().optional(),
  services: servicesBody.optional(), password: fields.password.optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'Nothing to update');
const passwordBody = z.object({ password: fields.password }).strict();
const idParam = z.object({ id: fields.id });

const createdWithMeta = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json(d?.meta ? d : { data: d })).catch(next);

export function register(ctx) {
  ctx.panelUsers = createPanelUsersService(ctx);
  const svc = () => ctx.panelUsers;

  const r = panelRouter(ctx, 'users');
  r.use(requireFeature('usermanager'));
  r.get('/', wrap((req) => svc().list(req.panel)));
  r.post('/', validate({ body: createBody }), createdWithMeta((req) => svc().create(req.panel, req.body, req)));
  r.get('/:id', validate({ params: idParam }), wrap((req) => svc().get(req.panel, req.params.id)));
  r.put('/:id', validate({ params: idParam, body: updateBody }), wrap((req) => svc().update(req.panel, req.params.id, req.body, req)));
  r.put('/:id/password', validate({ params: idParam, body: passwordBody }), wrap((req) => svc().setPassword(req.panel, req.params.id, req.body.password, req)));
  r.delete('/:id', validate({ params: idParam }), wrap((req) => svc().remove(req.panel, req.params.id, req)));

  return { path: '/users', router: r };
}
