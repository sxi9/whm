import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createBundledPluginsService, WP_INSTALL_JOB } from '../../services/plugins-bundled.js';

// Plugins category: ImunifyAV, Server Monitoring and WP Toolkit are bundled
// plugins on the SDK (plugins/bundled/<id>), served by the core plugin host
// under /api/plugins/<id>/*. This module installs them at boot and exposes the
// enable / disable / repair actions the function pages use, plus the one-click
// WordPress install that needs the panel's database and vhost services.
// The path is /bundled-plugins because /plugins belongs to the host router.

const ID_RE = /^net\.whm\.[a-z][a-z0-9-]*$/;
const idParam = z.object({ id: z.string().max(64).regex(ID_RE, 'Bundled plugin id') });
const wpInstallBody = z.object({
  username: fields.username,
  directory: z.string().max(200).regex(/^[A-Za-z0-9._\/-]*$/, 'Relative directory below public_html').default(''),
  url: z.string().max(300).regex(/^https?:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{2,5})?(\/[A-Za-z0-9._~\-/]*)?$/i, 'http(s) URL').optional(),
  title: z.string().trim().min(1).max(120).regex(/^[^\0\r\n]+$/),
  adminUser: z.string().regex(/^[a-z0-9][a-z0-9._@-]{0,59}$/i, 'Letters, digits, ".", "_", "@" or "-"'),
  adminEmail: fields.email.optional(),
  adminPassword: fields.password,
  dbName: fields.dbName,
  dbUser: z.string().regex(/^[a-z0-9_]{1,32}$/, 'Lowercase letters, digits or "_"; max 32 chars').optional(),
  dbPassword: fields.password.optional(),
  tablePrefix: z.string().regex(/^[a-z0-9_]{1,20}_$/, 'Lowercase, ending in "_"').default('wp_'),
  locale: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?(_[a-z]+)?$/).default('en_US'),
}).strict();

export async function register(ctx) {
  ctx.bundledPlugins = createBundledPluginsService(ctx);
  const s = ctx.bundledPlugins;
  ctx.jobs.register(WP_INSTALL_JOB, (job) => s.runWordPressInstall(job));
  ctx.capabilities.register('imunifyav', { binaries: ['imunify-antivirus'], required: ['imunify-antivirus'] });
  ctx.capabilities.register('clamav', { binaries: ['clamscan', 'freshclam', 'clamdscan'], required: ['clamscan'] });
  ctx.capabilities.register('wpcli', { binaries: ['wp', 'runuser'], required: ['wp'] });

  // The bundled plugins install into the host at boot. Test suites opt in
  // (overrides.bundledPlugins = true) so the core plugin-host suite keeps an
  // empty host to assert against.
  const auto = ctx.config.bundledPlugins ?? ctx.config.env !== 'test';
  if (auto && ctx.plugins?.sdkAvailable?.()) await s.ensureInstalled();

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const status = (code, fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(code).json({ data: d })).catch(next);

  r.get('/', requireReseller, wrap((req) => s.list(req.user)));
  r.get('/wp-toolkit/accounts', requireReseller, wrap((req) => s.accountsForInstall(req.user)));
  r.get('/wp-toolkit/installs', requireReseller, wrap((req) => s.wordPressInstalls(req.user)));
  r.post('/wp-toolkit/install', requireReseller, validate({ body: wpInstallBody }), status(202, (req) => s.installWordPress(req.body, req.user, req)));
  r.get('/:id', requireReseller, validate({ params: idParam }), wrap((req) => s.status(req.params.id, req.user)));
  r.post('/:id/enable', requireRoot, validate({ params: idParam }), wrap((req) => s.enable(req.params.id, req)));
  r.post('/:id/disable', requireRoot, validate({ params: idParam }), wrap((req) => s.disable(req.params.id, req)));
  r.post('/:id/reinstall', requireRoot, validate({ params: idParam }), wrap((req) => s.reinstall(req.params.id, req)));

  return { path: '/bundled-plugins', router: r };
}
