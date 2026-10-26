import { Router } from 'express';
import { validate, z } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createLocalesService } from '../../services/locales.js';
import { LOCALE_CODE_RE, STRING_KEY_RE, MAX_XML_BYTES } from '../../services/locales-xml.js';

// Codes are normalised like the XML parser does ("pt-BR" -> "pt_br") before the shape check.
const localeCode = z.string().trim().max(16).transform((s) => s.toLowerCase().replace(/-/g, '_')).pipe(z.string().regex(LOCALE_CODE_RE, 'Locale codes look like "es" or "pt_br"'));
const localeName = z.string().trim().min(1).max(80).regex(/^[^\r\n\0<>]*$/, 'Names are a single line without angle brackets');
const stringKey = z.string().regex(STRING_KEY_RE, 'Keys use letters, digits, ".", "_", "/" and "-"');
// eslint-disable-next-line no-control-regex
const stringValue = z.string().max(2000).regex(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/, 'Values cannot contain control characters');
const codeParam = z.object({ code: localeCode });
const configBody = z.object({ default: localeCode.optional(), enabled: z.array(localeCode).max(200).optional() }).strict()
  .refine((b) => b.default !== undefined || b.enabled !== undefined, { message: 'Provide default and/or enabled', path: ['default'] });
const copyBody = z.object({ code: localeCode, name: localeName.optional() }).strict();
const updateBody = z.object({ name: localeName.optional(), strings: z.record(stringKey, stringValue.nullable()).optional() }).strict()
  .refine((b) => b.name !== undefined || b.strings !== undefined, { message: 'Provide name and/or strings', path: ['strings'] });
const importBody = z.object({ xml: z.string().min(1).max(MAX_XML_BYTES), code: localeCode.optional(), name: localeName.optional(), mode: z.enum(['create', 'merge', 'replace']).default('merge'), dryRun: z.boolean().default(false) }).strict();

export async function register(ctx) {
  ctx.locales = createLocalesService(ctx);
  const s = ctx.locales;
  ctx.capabilities.register('glibc-locales', { binaries: ['locale', 'localedef', 'locale-gen'], required: ['locale'] });

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);

  // View Available Locales
  r.get('/', requireReseller, validate({ query: z.object({ q: z.string().trim().max(80).optional() }) }), wrap((req) => s.list(req.query)));
  r.get('/system', requireRoot, wrap(() => s.system()));
  r.get('/keys', requireReseller, wrap(() => s.keys()));
  // Every signed-in role loads its interface strings from here.
  r.get('/active', validate({ query: z.object({ code: localeCode.optional() }) }), wrap((req) => s.active(req.query)));

  // Configure Application Locales
  r.put('/config', requireRoot, validate({ body: configBody }), wrap((req) => s.configure(req.body, req)));

  // Locale XML Upload
  r.post('/xml', requireRoot, validate({ body: importBody }), (req, res, next) => Promise.resolve(s.importXml(req.body, req)).then((d) => res.status(d.dryRun || d.exists ? 200 : 201).json({ data: d })).catch(next));

  // Edit / Copy / Delete a Locale, Locale XML Download
  r.get('/:code', requireReseller, validate({ params: codeParam }), wrap((req) => s.get(req.params.code)));
  r.get('/:code/xml', requireReseller, validate({ params: codeParam }), wrap((req) => s.exportXml(req.params.code)));
  r.put('/:code', requireRoot, validate({ params: codeParam, body: updateBody }), wrap((req) => s.update(req.params.code, req.body, req)));
  r.post('/:code/copy', requireRoot, validate({ params: codeParam, body: copyBody }), created((req) => s.copy(req.params.code, req.body, req)));
  r.delete('/:code', requireRoot, validate({ params: codeParam }), wrap((req) => s.remove(req.params.code, req)));

  return { path: '/locales', router: r };
}
