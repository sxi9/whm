import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createSoftwareService } from '../../services/software.js';

// These mirror the agent's pkg.js schemas so bad names are refused with a 422
// before any op call, and the agent refuses them again regardless.
const pkgName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9+._-]{0,99}$/, 'Package names use letters, digits, "+", ".", "_" and "-" and cannot start with "-"');
const searchTerm = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9+._-]{0,63}$/, 'Search with letters, digits, "+", ".", "_" or "-"');
const perlModule = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_]*(::[A-Za-z0-9_]+)*$/, 'Perl module names look like Foo::Bar');
const moduleKind = z.enum(['pecl', 'pear', 'gem', 'pip']);
const moduleName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, 'Letters, digits, ".", "_" and "-" only');
const versionSpec = z.string().regex(/^[0-9][0-9A-Za-z.+~:-]{0,63}$/, 'Version must start with a digit');
const phpVersionId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,31}$/, 'PHP version id such as 8.3 or ea-php83');
const sapi = z.enum(['fpm', 'apache2', 'cli', 'php']).optional();
const iniKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/);
const iniValue = z.string().max(1024).regex(/^[^\r\n\0]*$/, 'Directive values are a single line');
const iniBody = z.object({ content: z.string().max(4 * 1024 * 1024).optional(), directives: z.record(iniKey, iniValue.nullable()).optional(), sapi, reloadFpm: z.boolean().optional() }).strict()
  .refine((b) => b.content != null || b.directives != null, { message: 'Provide content or directives', path: ['content'] });
const packagesBody = z.object({ packages: z.array(pkgName).min(1).max(200) });
const profileBody = z.object({ name: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/, 'Letters, digits, spaces, ".", "_", "+" or "-"'), description: z.string().max(500).optional(), packages: z.object({ debian: z.array(pkgName).max(500).default([]), rhel: z.array(pkgName).max(500).default([]) }).strict() }).strict();
const idParam = z.object({ id: fields.id });
const domainParam = z.object({ domain: fields.hostname });
const httpUrl = z.string().max(2048).url().refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');

export async function register(ctx) {
  ctx.software = createSoftwareService(ctx);
  const s = ctx.software;
  for (const [type, handler] of Object.entries(s.jobs)) ctx.jobs.register(type, handler);
  ctx.scheduler.ensure('os-update-check', '41 5 * * *', 'software.update.check');
  ctx.scheduler.ensure('nginx-proxy-sync', '*/10 * * * *', 'software.nginx.sync');
  ctx.capabilities.register('pkg', { binaries: ['apt-get', 'dnf', 'yum', 'dpkg-query', 'rpm'], required: ['apt-get', 'dnf', 'yum'] });
  ctx.capabilities.register('rpm', { binaries: ['rpm'], required: ['rpm'] });
  ctx.capabilities.register('php', { binaries: ['php', 'php-fpm'], required: ['php'] });
  ctx.capabilities.register('nginx', { binaries: ['nginx'], required: ['nginx'] });
  ctx.capabilities.register('perl', { binaries: ['perl'], required: ['perl'] });
  ctx.capabilities.register('cpan', { binaries: ['cpanm', 'cpan'], required: ['cpanm', 'cpan'] });
  ctx.capabilities.register('pecl', { binaries: ['pecl'], required: ['pecl'] });
  ctx.capabilities.register('pear', { binaries: ['pear'], required: ['pear'] });
  ctx.capabilities.register('gem', { binaries: ['gem', 'ruby'], required: ['gem'] });
  ctx.capabilities.register('pip', { binaries: ['pip3', 'pip', 'python3'], required: ['pip3', 'pip'] });

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);
  const accepted = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(202).json({ data: d })).catch(next);
  // 202 when the service queued a job for the slow part, 200 when it finished inline.
  const maybeAccepted = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(d?.job ? 202 : 200).json({ data: d })).catch(next);

  // Install Distro Packages
  r.get('/pkg/detect', requireRoot, wrap(() => s.pkg.detect()));
  r.get('/pkg/installed', requireRoot, validate({ query: pagination.extend({ q: searchTerm.optional() }) }), wrap((req) => s.pkg.installed(req.query)));
  r.get('/pkg/search', requireRoot, validate({ query: z.object({ q: searchTerm, limit: z.coerce.number().int().min(1).max(500).default(100) }) }), wrap((req) => s.pkg.search(req.query.q, req.query.limit)));
  r.get('/pkg/info/:name', requireRoot, validate({ params: z.object({ name: pkgName }) }), wrap((req) => s.pkg.info(req.params.name)));
  r.get('/pkg/recent', requireRoot, wrap(() => s.pkg.recent()));
  r.post('/pkg/install', requireRoot, validate({ body: packagesBody.extend({ noRecommends: z.boolean().default(false) }).strict() }), accepted((req) => s.pkg.install(req.body.packages, req.user, req, { noRecommends: req.body.noRecommends })));
  r.post('/pkg/remove', requireRoot, validate({ body: packagesBody.extend({ purge: z.boolean().default(false) }).strict() }), accepted((req) => s.pkg.remove(req.body.packages, req.user, req, { purge: req.body.purge })));
  r.post('/pkg/update-index', requireRoot, accepted((req) => s.pkg.updateIndex(req.user, req)));

  // System Update
  r.get('/update/status', requireRoot, wrap(() => s.update.status()));
  r.post('/update/run', requireRoot, validate({ body: z.object({ dist: z.boolean().default(true), autoremove: z.boolean().default(false), refreshIndex: z.boolean().default(true), packages: z.array(pkgName).max(200).optional() }).strict() }), accepted((req) => s.update.run(req.body, req.user, req)));
  r.put('/update/auto', requireRoot, validate({ body: z.object({ autoApply: z.boolean() }).strict() }), wrap((req) => s.update.setAuto(req.body.autoApply, req)));

  // Rebuild RPM Database
  r.get('/rpmdb', requireRoot, wrap(() => s.rpm.status()));
  r.post('/rpmdb/rebuild', requireRoot, accepted((req) => s.rpm.rebuild(req.user, req)));

  // Install a Perl Module
  r.get('/perl/modules', requireRoot, wrap(() => s.perl.list()));
  r.post('/perl/install', requireRoot, validate({ body: z.object({ modules: z.array(perlModule).min(1).max(50), notest: z.boolean().default(true) }).strict() }), accepted((req) => s.perl.install(req.body.modules, { notest: req.body.notest }, req.user, req)));

  // Module Installers
  r.get('/modules/installers', requireRoot, wrap(() => s.modules.installers()));
  r.get('/modules/:kind', requireRoot, validate({ params: z.object({ kind: moduleKind }) }), wrap((req) => s.modules.list(req.params.kind)));
  r.post('/modules/:kind/install', requireRoot, validate({ params: z.object({ kind: moduleKind }), body: z.object({ name: moduleName, version: versionSpec.optional() }).strict() }), accepted((req) => s.modules.install(req.params.kind, req.body, req.user, req)));

  // Update Server Software
  r.get('/panel/update', requireRoot, wrap(() => s.panel.status()));
  r.post('/panel/update/check', requireRoot, wrap((req) => s.panel.check(req)));
  r.put('/panel/update/settings', requireRoot, validate({ body: z.object({ url: z.union([z.literal(''), httpUrl]).optional(), tier: z.enum(['stable', 'release', 'edge']).optional(), autoUpdate: z.boolean().optional() }).strict() }), wrap((req) => s.panel.updateSettings(req.body, req)));

  // MultiPHP Manager
  r.get('/php/versions', requireReseller, validate({ query: z.object({ modules: z.enum(['true', 'false']).default('false') }) }), wrap((req) => s.php.versions({ modules: req.query.modules === 'true' })));
  r.put('/php/default', requireRoot, validate({ body: z.object({ version: phpVersionId }).strict() }), maybeAccepted((req) => s.php.setSystemDefault(req.body.version, req.user, req)));
  r.get('/php/domains', requireReseller, validate({ query: z.object({ account: fields.username.optional(), q: z.string().trim().max(200).optional() }) }), wrap((req) => s.php.domains(req.user, req.query)));
  r.put('/php/domains', requireReseller, validate({ body: z.object({ domains: z.array(fields.hostname).min(1).max(500), version: phpVersionId.nullable() }).strict() }), maybeAccepted((req) => s.php.setDomainVersion(req.body.domains, req.body.version, req.user, req)));
  r.get('/php/pools', requireRoot, validate({ query: z.object({ version: phpVersionId.optional() }) }), wrap((req) => s.php.pools(req.query.version)));

  // MultiPHP INI Editor
  r.get('/php/ini/directives', requireReseller, wrap(() => s.ini.directives()));
  r.get('/php/ini/domain/:domain', requireReseller, validate({ params: domainParam }), wrap((req) => s.ini.readDomain(req.params.domain, req.user)));
  r.put('/php/ini/domain/:domain', requireReseller, validate({ params: domainParam, body: iniBody }), wrap((req) => s.ini.writeDomain(req.params.domain, req.body, req.user, req)));
  r.get('/php/ini/:version', requireRoot, validate({ params: z.object({ version: phpVersionId }), query: z.object({ sapi }) }), wrap((req) => s.ini.readVersion(req.params.version, req.query.sapi)));
  r.put('/php/ini/:version', requireRoot, validate({ params: z.object({ version: phpVersionId }), body: iniBody }), wrap((req) => s.ini.writeVersion(req.params.version, req.body, req)));

  // NGINX Manager
  r.get('/nginx', requireRoot, wrap(() => s.nginx.status()));
  r.get('/nginx/config', requireRoot, wrap(async () => ({ content: await s.nginx.readConfig() })));
  r.post('/nginx/install', requireRoot, accepted((req) => s.nginx.install(req.user, req)));
  r.put('/nginx', requireRoot, validate({ body: z.object({ enabled: z.boolean().optional(), cache: z.boolean().optional(), apachePort: z.number().int().min(1).max(65535).optional(), apacheSslPort: z.number().int().min(1).max(65535).optional(), cacheMaxSizeMb: z.number().int().min(64).max(1_048_576).optional(), cacheTtl: z.string().regex(/^\d{1,5}[smhd]?$/, 'e.g. 10m, 1h').optional() }).strict() }), wrap((req) => s.nginx.configure(req.body, req)));
  r.post('/nginx/sync', requireRoot, wrap((req) => s.nginx.sync(req, { requireInstalled: true })));
  r.post('/nginx/configtest', requireRoot, wrap(() => s.nginx.configtest()));
  r.post('/nginx/:verb', requireRoot, validate({ params: z.object({ verb: z.enum(['start', 'stop', 'restart', 'reload']) }) }), wrap((req) => s.nginx.control(req.params.verb, req)));

  // EasyApache 4
  r.get('/ea4/profiles', requireRoot, wrap(() => s.ea4.profiles()));
  r.get('/ea4/catalog', requireRoot, wrap(() => s.ea4.catalog()));
  r.get('/ea4/installed', requireRoot, wrap(() => s.ea4.installed()));
  r.get('/ea4/builds', requireRoot, wrap(() => s.ea4.builds()));
  r.post('/ea4/profiles', requireRoot, validate({ body: profileBody }), created((req) => s.ea4.create(req.body, req)));
  r.get('/ea4/profiles/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.ea4.get(req.params.id)));
  r.put('/ea4/profiles/:id', requireRoot, validate({ params: idParam, body: profileBody.partial() }), wrap((req) => s.ea4.update(req.params.id, req.body, req)));
  r.delete('/ea4/profiles/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.ea4.remove(req.params.id, req)));
  r.post('/ea4/profiles/:id/copy', requireRoot, validate({ params: idParam, body: z.object({ name: profileBody.shape.name }).strict() }), created((req) => s.ea4.copy(req.params.id, req.body.name, req)));
  r.get('/ea4/profiles/:id/diff', requireRoot, validate({ params: idParam }), wrap((req) => s.ea4.diff(req.params.id)));
  r.post('/ea4/profiles/:id/build', requireRoot, validate({ params: idParam, body: z.object({ removeExtras: z.boolean().default(false), removeDependents: z.boolean().default(false) }).strict() }), accepted((req) => s.ea4.build(req.params.id, req.body, req.user, req)));

  return { path: '/software', router: r };
}
