import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createThemesService, SLUG_RE, BASES, MAX_CSS_BYTES, VARIABLE_CATALOG } from '../../services/themes.js';

const slug = z.string().trim().toLowerCase().regex(SLUG_RE, 'Slugs use lowercase letters, digits, "_" and "-"; max 32 chars');
const themeName = z.string().trim().min(1).max(80).regex(/^[^\r\n\0<>]*$/, 'Names are a single line without angle brackets');
const base = z.enum(BASES);
const tokenKey = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'Design token names use lowercase letters, digits and "-"');
const tokenValue = z.string().trim().max(120).nullable();
const variables = z.record(tokenKey, tokenValue);
const slugParam = z.object({ slug });
const createBody = z.object({ slug, name: themeName.optional(), base: base.optional(), variables: variables.optional(), copyFrom: slug.optional() }).strict();
const updateBody = z.object({ name: themeName.optional(), base: base.optional(), variables: variables.optional(), enabled: z.boolean().optional() }).strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field', path: ['name'] });
const cssBody = z.object({ css: z.string().max(MAX_CSS_BYTES) }).strict();
const configBody = z.object({ default: slug.optional(), accountDefault: slug.optional(), allowUserOverride: z.boolean().optional() }).strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide default, accountDefault and/or allowUserOverride', path: ['default'] });
const preferenceBody = z.object({ theme: slug.nullable() }).strict();
const packageParam = z.object({ name: fields.packageName });
const packageBody = z.object({ theme: slug }).strict();

export async function register(ctx) {
  ctx.themes = createThemesService(ctx);
  const s = ctx.themes;

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);

  // Theme Manager
  r.get('/', requireReseller, validate({ query: z.object({ q: z.string().trim().max(80).optional() }) }), wrap((req) => s.list(req.query)));
  r.get('/variables', requireReseller, wrap(() => VARIABLE_CATALOG));
  // Every signed-in role applies its theme from here on load.
  r.get('/active', wrap((req) => s.activeFor(req.user)));
  r.put('/preference', validate({ body: preferenceBody }), wrap((req) => s.setPreference(req.user, req.body.theme, req)));
  r.put('/config', requireRoot, validate({ body: configBody }), wrap((req) => s.configure(req.body, req)));

  r.get('/packages', requireReseller, wrap((req) => s.packages(req.user)));
  r.put('/packages/:name', requireReseller, validate({ params: packageParam, body: packageBody }), wrap((req) => s.assignPackage(req.params.name, req.body.theme, req.user, req)));

  r.post('/', requireRoot, validate({ body: createBody }), created((req) => s.create(req.body, req)));
  r.get('/:slug', requireReseller, validate({ params: slugParam }), wrap((req) => s.get(req.params.slug)));
  r.put('/:slug', requireRoot, validate({ params: slugParam, body: updateBody }), wrap((req) => s.update(req.params.slug, req.body, req)));
  r.put('/:slug/css', requireRoot, validate({ params: slugParam, body: cssBody }), wrap((req) => s.setCss(req.params.slug, req.body.css, req)));
  r.delete('/:slug/css', requireRoot, validate({ params: slugParam }), wrap((req) => s.clearCss(req.params.slug, req)));
  r.delete('/:slug', requireRoot, validate({ params: slugParam }), wrap((req) => s.remove(req.params.slug, req)));

  return { path: '/themes', router: r };
}
