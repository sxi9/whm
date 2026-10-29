import path from 'node:path';
import { z } from 'zod';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, forbidden, unprocessable, HttpError, CapabilityError } from '../lib/errors.js';
import { fields } from '../lib/validate.js';
import { isRoot } from '../middleware/rbac.js';

// Application Manager. Attached as ctx.apps; other categories may call:
//   apps.removeAccountApps(username, req)   -> { removed: [ids], cleanup } | null (account termination hook)
//   apps.domainsFor(username, user)         -> [{ domain, type, docroot }]
// Every application is a row in `apps`; node/python apps run as `whm-app-<id>`
// systemd units bound to 127.0.0.1:<port> and are proxied through the account
// vhost's per-domain include; static apps are built as the user and served by
// Apache from their output directory. All host work goes through the `app.*`
// agent family (docs/design/application-manager.md §2).

export const KINDS = ['node', 'python', 'static'];
export const STATUSES = ['created', 'deploying', 'running', 'stopped', 'failed', 'built'];
export const START_MODES = ['file', 'npm-script', 'gunicorn', 'uvicorn'];
export const SCAFFOLD_TEMPLATES = ['express', 'flask', 'fastapi', 'static-files'];
export const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const MAX_APPS_PER_DOMAIN = 20;
const INDEX_CACHE_MS = 60 * 60 * 1000;

const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
const SCRIPT_NAME = /^[A-Za-z0-9:_.-]{1,64}$/;
const PIP_PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\[[A-Za-z0-9,._-]+\])?(==[0-9][0-9A-Za-z.+!-]{0,63})?$/;
const MODULE_SPEC = /^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*$/;
const NODE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const PYTHON_VERSION = /^3\.\d{1,2}(\.\d{1,3})?$/;
const GIT_URL = /^https:\/\/[A-Za-z0-9._-]+(:\d{1,5})?\/[A-Za-z0-9._/-]+(\.git)?$/;
const GIT_REF = /^(?!-)[A-Za-z0-9._/-]{1,128}$/;
const BASE_PATH = /^\/(?:[A-Za-z0-9._-]+\/?)*$/;
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const RUN_USER = /^[a-z][a-z0-9_-]{0,31}$/;
// Everything that becomes an ExecStart token must satisfy the agent's argToken.
const ARG_TOKEN = /^[A-Za-z0-9_@.:=,+/-]{1,256}$/;
// The root becomes WorkingDirectory=, PATH= and Alias/DocumentRoot arguments,
// so it is limited to the agent's unitPath character set.
const UNIT_PATH = /^[A-Za-z0-9._@+=,:/-]+$/;
// A path relative to the app root, usable as an argv token: no whitespace or
// shell characters, never starting with "-", no ".." segment.
const REL_PATH = /^(?!\.\.(?:\/|$))(?!.*\/\.\.(?:\/|$))[A-Za-z0-9_@.+][A-Za-z0-9_@.+/-]{0,199}$/;

const relPath = z.string().regex(REL_PATH, 'A relative path inside the application (letters, digits, ".", "_", "-", "/")');
const scriptName = z.string().regex(SCRIPT_NAME, 'npm script names use letters, digits, ":", "_", "." and "-"').refine((s) => !s.startsWith('-'), 'Script names cannot start with "-"');
const pipPackage = z.string().regex(PIP_PACKAGE, 'pip requirement such as gunicorn or flask==3.0.0');
const nodeVersion = z.string().regex(NODE_VERSION, 'Node.js versions look like 20.11.0');
const pythonVersion = z.string().regex(PYTHON_VERSION, 'Python versions look like 3.12');
const envValue = z.string().max(4096).regex(/^[^\0\r\n]*$/, 'Environment values are a single line');

const startSchema = z.object({
  mode: z.enum(START_MODES).optional(),
  entry: relPath.optional(),
  script: scriptName.optional(),
  module: z.string().regex(MODULE_SPEC, 'Module specs look like app:app').optional(),
  workers: z.number().int().min(1).max(32).optional(),
}).strict();
const buildSchema = z.object({
  install: z.enum(['npm', 'pip']).nullable().optional(),
  script: scriptName.nullable().optional(),
  optional: z.boolean().optional(),
  outputDir: relPath.nullable().optional(),
  extraPackages: z.array(pipPackage).max(20).optional(),
}).strict();
const limitsSchema = z.object({
  memoryMaxMb: z.number().int().min(64).max(65536).optional(),
  tasksMax: z.number().int().min(16).max(32768).optional(),
  cpuQuotaPercent: z.number().int().min(10).max(800).optional(),
}).strict();

export const schemas = {
  name: z.string().regex(APP_NAME, 'Letters, digits, spaces, ".", "_" and "-"; max 64 characters'),
  kind: z.enum(KINDS),
  status: z.enum(STATUSES),
  presetId: z.string().regex(SLUG, 'Preset ids are lowercase slugs'),
  slug: z.string().regex(SLUG, 'Lowercase letters, digits and "-"; max 48 characters'),
  basePath: z.string().max(128).regex(BASE_PATH, 'Base paths look like / or /api').refine((p) => !/(^|\/)\.\.?(\/|$)/.test(p), 'No "." or ".." segments'),
  root: fields.absPath.max(512).regex(UNIT_PATH, 'Only letters, digits and . _ @ + = , : - in the application path'),
  env: z.record(z.string().regex(ENV_KEY, 'Variable names are UPPER_CASE'), envValue).refine((o) => Object.keys(o).length <= 64, 'At most 64 variables'),
  envValue,
  start: startSchema,
  build: buildSchema,
  limits: limitsSchema,
  mode: z.enum(['development', 'production']),
  runtimeVersion: z.union([z.literal('system'), nodeVersion, pythonVersion]),
  nodeVersion,
  pythonVersion,
  relPath,
  pipPackage,
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('git'), url: z.string().max(512).regex(GIT_URL, 'Only https:// git URLs without credentials'), ref: z.string().regex(GIT_REF, 'Branch or tag name').optional() }).strict(),
    z.object({ type: z.literal('scaffold'), template: z.enum(SCAFFOLD_TEMPLATES) }).strict(),
    z.object({ type: z.literal('upload') }).strict(),
  ]),
};

// The fields a preset (built-in or custom template) may set and a create/update
// request may override; `preset_json` of custom templates is validated with it.
export const presetFieldsSchema = z.object({
  start: startSchema.nullable().optional(),
  build: buildSchema.nullable().optional(),
  websockets: z.boolean().optional(),
  spaFallback: z.boolean().optional(),
  runtimeVersion: schemas.runtimeVersion.optional(),
  mode: schemas.mode.optional(),
  limits: limitsSchema.optional(),
}).strict();

export const createSchema = presetFieldsSchema.extend({
  username: fields.username,
  name: schemas.name,
  kind: schemas.kind.optional(),
  preset: schemas.presetId.optional(),
  domain: fields.hostname,
  basePath: schemas.basePath.default('/'),
  root: schemas.root,
  env: schemas.env.optional(),
  source: schemas.source.optional(),
}).strict();

export const updateSchema = presetFieldsSchema.extend({ name: schemas.name.optional(), env: schemas.env.optional() }).strict();

export const templateSchema = z.object({
  slug: schemas.slug,
  name: z.string().trim().min(1).max(64),
  kind: schemas.kind,
  description: z.string().max(500).nullable().optional(),
  preset: presetFieldsSchema,
}).strict();

export const policySchema = z.object({
  portRange: z.tuple([z.number().int().min(1024).max(65535), z.number().int().min(1024).max(65535)]).refine(([lo, hi]) => lo < hi, 'The range must go upwards').optional(),
  allowResellers: z.boolean().optional(),
  defaultMemoryMb: z.number().int().min(64).max(65536).optional(),
}).strict();

const preset = (id, label, kind, framework, extra) => ({
  id, label, kind, framework, detect: { files: [], dependencies: [] }, install: null, build: null, start: null, outputDir: null,
  spaFallback: kind === 'static', websockets: kind !== 'static', scaffold: false, docs: null, description: '', ...extra,
});

export const PRESETS = [
  preset('express', 'Express', 'node', 'Express', { description: 'A Node.js server started from a file; listens on process.env.PORT.', detect: { files: ['server.js', 'app.js'], dependencies: ['express'] }, install: 'npm', start: { mode: 'file', entry: 'server.js' }, scaffold: true, docs: 'https://expressjs.com/' }),
  preset('nestjs', 'NestJS', 'node', 'NestJS', { description: 'Compiled with "npm run build", started from dist/main.js.', detect: { files: ['nest-cli.json'], dependencies: ['@nestjs/core'] }, install: 'npm', build: { script: 'build' }, start: { mode: 'file', entry: 'dist/main.js' }, docs: 'https://docs.nestjs.com/' }),
  preset('nextjs', 'Next.js', 'node', 'Next.js', { description: 'Built with "npm run build" and served by "npm run start" (next start).', detect: { files: ['next.config.js', 'next.config.mjs', 'next.config.ts'], dependencies: ['next'] }, install: 'npm', build: { script: 'build' }, start: { mode: 'npm-script', script: 'start' }, docs: 'https://nextjs.org/docs' }),
  preset('nuxt', 'Nuxt', 'node', 'Nuxt', { description: 'Built with "npm run build", started from the Nitro output.', detect: { files: ['nuxt.config.ts', 'nuxt.config.js'], dependencies: ['nuxt'] }, install: 'npm', build: { script: 'build' }, start: { mode: 'file', entry: '.output/server/index.mjs' }, docs: 'https://nuxt.com/docs' }),
  preset('node-custom', 'Node.js (custom)', 'node', null, { description: 'Any Node.js server: optional "npm run build", started with "npm run start".', detect: { files: ['package.json'], dependencies: [] }, install: 'npm', build: { script: 'build', optional: true }, start: { mode: 'npm-script', script: 'start' }, docs: 'https://nodejs.org/docs/latest/api/' }),
  preset('react-vite', 'React (Vite)', 'static', 'React', { description: 'Built with "npm run build"; Apache serves dist/ with an SPA fallback.', detect: { files: ['vite.config.js', 'vite.config.ts'], dependencies: ['vite', 'react'] }, install: 'npm', build: { script: 'build' }, outputDir: 'dist', docs: 'https://vite.dev/guide/' }),
  preset('react-cra', 'React (Create React App)', 'static', 'React', { description: 'Built with "npm run build"; Apache serves build/ with an SPA fallback.', detect: { files: [], dependencies: ['react-scripts'] }, install: 'npm', build: { script: 'build' }, outputDir: 'build', docs: 'https://create-react-app.dev/docs/deployment/' }),
  preset('angular', 'Angular', 'static', 'Angular', { description: 'Built with "npm run build"; Apache serves dist/<project>/browser (the project name comes from angular.json).', detect: { files: ['angular.json'], dependencies: ['@angular/core'] }, install: 'npm', build: { script: 'build' }, outputDir: 'dist/<project>/browser', docs: 'https://angular.dev/tools/cli/deployment' }),
  preset('vue', 'Vue', 'static', 'Vue', { description: 'Built with "npm run build"; Apache serves dist/ with an SPA fallback.', detect: { files: ['vite.config.js', 'vite.config.ts', 'vue.config.js'], dependencies: ['vue'] }, install: 'npm', build: { script: 'build' }, outputDir: 'dist', docs: 'https://vuejs.org/guide/best-practices/production-deployment' }),
  preset('svelte', 'Svelte', 'static', 'Svelte', { description: 'Built with "npm run build"; Apache serves build/ with an SPA fallback.', detect: { files: ['svelte.config.js'], dependencies: ['svelte', '@sveltejs/kit'] }, install: 'npm', build: { script: 'build' }, outputDir: 'build', docs: 'https://svelte.dev/docs/kit/adapter-static' }),
  preset('static-files', 'Static files', 'static', null, { description: 'Plain HTML/CSS/JS served by Apache from the application root; nothing is installed or built.', detect: { files: ['index.html'], dependencies: [] }, outputDir: '.', spaFallback: false, scaffold: true }),
  preset('flask', 'Flask', 'python', 'Flask', { description: 'A WSGI app served by gunicorn from a virtual environment (app:app).', detect: { files: ['app.py', 'wsgi.py'], dependencies: ['flask'] }, install: 'pip', start: { mode: 'gunicorn', module: 'app:app', workers: 2 }, scaffold: true, docs: 'https://flask.palletsprojects.com/' }),
  preset('django', 'Django', 'python', 'Django', { description: 'Served by gunicorn (<project>.wsgi:application); set the module to your project name.', detect: { files: ['manage.py'], dependencies: ['django'] }, install: 'pip', start: { mode: 'gunicorn', module: '<project>.wsgi:application', workers: 2 }, docs: 'https://docs.djangoproject.com/en/stable/howto/deployment/wsgi/gunicorn/' }),
  preset('fastapi', 'FastAPI', 'python', 'FastAPI', { description: 'An ASGI app served by uvicorn from a virtual environment (main:app).', detect: { files: ['main.py'], dependencies: ['fastapi'] }, install: 'pip', start: { mode: 'uvicorn', module: 'main:app' }, scaffold: true, docs: 'https://fastapi.tiangolo.com/deployment/manually/' }),
  preset('python-custom', 'Python (custom)', 'python', null, { description: 'Any Python server started from a file inside a virtual environment (python main.py).', detect: { files: ['requirements.txt'], dependencies: [] }, install: 'pip', start: { mode: 'file', entry: 'main.py' }, docs: 'https://docs.python.org/3/library/venv.html' }),
];

const KIND_DEFAULTS = {
  node: { install: 'npm', start: { mode: 'npm-script', script: 'start' } },
  python: { install: 'pip', start: { mode: 'file', entry: 'main.py' } },
  static: { install: null, outputDir: '.' },
};
const MODE_FIELD = { file: 'entry', 'npm-script': 'script', gunicorn: 'module', uvicorn: 'module' };
const KIND_MODES = { node: ['file', 'npm-script'], python: ['file', 'gunicorn', 'uvicorn'] };

const stripUndefined = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));

export function validateStart(kind, start) {
  if (kind === 'static') return null;
  if (!start || typeof start !== 'object') throw unprocessable(`A ${kind} application needs a start command`);
  if (!KIND_MODES[kind].includes(start.mode)) throw unprocessable(`Start mode "${start.mode ?? ''}" is not available for ${kind} applications (use ${KIND_MODES[kind].join(' or ')})`, { 'start.mode': ['Unsupported for this kind'] });
  const field = MODE_FIELD[start.mode];
  if (!start[field]) throw unprocessable(`Start mode "${start.mode}" needs "${field}"`, { [`start.${field}`]: ['Required'] });
  if (start.module && start.module.includes('<')) throw unprocessable('Replace <project> in the module spec with your project name', { 'start.module': ['Placeholder left in place'] });
  const out = { mode: start.mode, [field]: start[field] };
  if (start.mode === 'gunicorn') out.workers = start.workers ?? 2;
  return out;
}

// Merges a preset (built-in id or a custom template normalised by presets())
// with the caller's overrides into the start/build/flags an app row stores.
export function resolvePreset(presetId, overrides = {}, templates = []) {
  const base = presetId ? (PRESETS.find((p) => p.id === presetId) ?? templates.find((t) => t.id === presetId) ?? null) : null;
  if (presetId && !base) throw unprocessable(`Unknown preset "${presetId}"`, { preset: ['Unknown preset'] });
  const kind = overrides.kind ?? base?.kind;
  if (!kind) throw unprocessable('Choose a kind or a preset', { kind: ['Required without a preset'] });
  if (base && overrides.kind && overrides.kind !== base.kind) throw unprocessable(`Preset "${presetId}" builds ${base.kind} applications, not ${overrides.kind}`, { kind: ['Does not match the preset'] });
  const defaults = KIND_DEFAULTS[kind];
  let start = null;
  if (kind !== 'static') {
    const baseStart = base?.start ?? defaults.start;
    const o = stripUndefined(overrides.start);
    start = validateStart(kind, o.mode && o.mode !== baseStart.mode ? o : { ...baseStart, ...o });
  }
  const ob = stripUndefined(overrides.build);
  const build = {
    install: base ? base.install : defaults.install,
    script: base?.build?.script ?? null,
    optional: Boolean(base?.build?.optional),
    outputDir: kind === 'static' ? (base?.outputDir ?? defaults.outputDir) : null,
    extraPackages: base?.defaults?.extraPackages ?? [],
    ...ob,
  };
  if (ob.script !== undefined) build.optional = Boolean(ob.optional);
  if (kind === 'static') { build.outputDir = build.outputDir || '.'; if (build.install === 'pip') throw unprocessable('Static applications are built with npm', { 'build.install': ['npm or none'] }); }
  if (kind === 'node' && build.install === 'pip') throw unprocessable('Node.js applications install with npm', { 'build.install': ['npm or none'] });
  if (kind === 'python') { build.install = ob.install === null ? null : 'pip'; build.script = null; build.outputDir = null; }
  if (kind !== 'static') build.outputDir = null;
  if (!build.script) build.optional = false;
  return {
    kind,
    preset: base?.id ?? null,
    runtimeKind: kind === 'static' ? (build.install === 'npm' || build.script ? 'node' : null) : kind,
    start,
    build,
    websockets: kind === 'static' ? false : (overrides.websockets ?? base?.websockets ?? true),
    spaFallback: kind === 'static' ? (overrides.spaFallback ?? base?.spaFallback ?? true) : false,
    defaults: { runtimeVersion: overrides.runtimeVersion ?? base?.defaults?.runtimeVersion, mode: overrides.mode ?? base?.defaults?.mode, limits: { ...(base?.defaults?.limits ?? {}), ...stripUndefined(overrides.limits) } },
  };
}

// Turns an app.inspect result into the preset the create form should preselect.
export function guessPreset(insp) {
  const by = (id) => PRESETS.find((p) => p.id === id) ?? null;
  const deps = new Set(insp?.packageJson?.dependencies || []);
  const scripts = insp?.packageJson?.scripts || {};
  const reqs = new Set((insp?.requirements || []).map((n) => String(n).toLowerCase()));
  const files = new Set(insp?.files || []);
  let found = insp?.hints?.preset ? by(insp.hints.preset) : null;
  let outputDir; let start;
  if (!found && insp?.packageJson) {
    if (deps.has('next')) found = by('nextjs');
    else if (deps.has('nuxt')) found = by('nuxt');
    else if (deps.has('@nestjs/core')) found = by('nestjs');
    else if (deps.has('@angular/core')) found = by('angular');
    else if (deps.has('react-scripts')) found = by('react-cra');
    else if (deps.has('vite') && (deps.has('react') || deps.has('react-dom'))) found = by('react-vite');
    else if (deps.has('svelte') || deps.has('@sveltejs/kit')) found = by('svelte');
    else if (deps.has('vue')) found = by('vue');
    else if (deps.has('express')) found = by('express');
    else found = by(scripts.start || !files.has('index.html') ? 'node-custom' : 'static-files');
  } else if (!found && (insp?.requirements || files.has('manage.py') || files.has('app.py') || files.has('main.py'))) {
    if (reqs.has('django') || files.has('manage.py')) found = by('django');
    else if (reqs.has('fastapi')) found = by('fastapi');
    else if (reqs.has('flask')) found = by('flask');
    else found = by('python-custom');
  } else if (!found && files.has('index.html')) found = by('static-files');
  if (found?.id === 'angular' && insp?.angularProjects?.[0]) outputDir = `dist/${insp.angularProjects[0]}/browser`;
  if (found?.id === 'express') {
    const entry = insp?.hints?.startEntry || (files.has('server.js') ? 'server.js' : files.has('app.js') ? 'app.js' : files.has('index.js') ? 'index.js' : null);
    if (entry && REL_PATH.test(entry)) start = { mode: 'file', entry };
  }
  if (found?.id === 'node-custom' && !scripts.start && insp?.hints?.startEntry && REL_PATH.test(insp.hints.startEntry)) start = { mode: 'file', entry: insp.hints.startEntry };
  return { preset: found, outputDir: outputDir ?? (found?.kind === 'static' ? (insp?.hints?.outputDir || found?.outputDir) : null) ?? null, start: start ?? found?.start ?? null, lockfile: insp?.hints?.lockfile ?? null };
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1; }
  return 0;
}

// The nodejs.org release index → the newest release of the current line and of
// every LTS line that still has Linux builds, newest first.
export function selectNodeReleases(index, { max = 40 } = {}) {
  const rows = (Array.isArray(index) ? index : [])
    .filter((r) => typeof r?.version === 'string' && /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(r.version) && Array.isArray(r.files) && r.files.some((f) => /^linux-(x64|arm64)$/.test(f)))
    .map((r) => ({ version: r.version.slice(1), major: Number(r.version.slice(1).split('.')[0]), lts: typeof r.lts === 'string' ? r.lts : false, date: typeof r.date === 'string' ? r.date : null }));
  const latest = new Map();
  for (const r of rows) { const cur = latest.get(r.major); if (!cur || compareSemver(r.version, cur.version) > 0) latest.set(r.major, r); }
  const majors = [...latest.values()].sort((a, b) => b.major - a.major);
  const out = [];
  for (const r of majors) {
    if (!r.lts && out.length) continue;
    out.push({ version: r.version, lts: r.lts, date: r.date, line: r.lts ? 'lts' : 'current' });
    if (out.length >= max) break;
  }
  return out;
}

export function createApplicationManagerService(ctx) {
  const { db, agent, capabilities, settings, logger } = ctx;
  const op = (name, args = {}, req, opts = {}) => agent.op(name, args, { req, ...opts });
  const S = (key, fallback) => { const v = settings.get(key, fallback); return v === undefined || v === null ? fallback : v; };
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const enqueue = (type, params, user) => ctx.jobs.enqueue(type, params, { userId: user?.id ?? null });
  const likeEscape = (text) => String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
  const redactEnv = (env) => (env ? Object.fromEntries(Object.keys(env).map((k) => [k, '[redacted]'])) : undefined);

  const stmts = {
    byId: db.prepare('SELECT * FROM apps WHERE id = ?'),
    byAccount: db.prepare('SELECT * FROM apps WHERE account_id = ? ORDER BY id'),
    byUsername: db.prepare('SELECT * FROM apps WHERE username = ? ORDER BY id'),
    byDomain: db.prepare('SELECT * FROM apps WHERE domain = ? ORDER BY LENGTH(base_path) DESC, base_path'),
    byDomainBase: db.prepare('SELECT id FROM apps WHERE domain = ? AND base_path = ?'),
    roots: db.prepare('SELECT id, root FROM apps WHERE username = ?'),
    ports: db.prepare('SELECT port FROM apps WHERE port IS NOT NULL'),
    countDomain: db.prepare('SELECT COUNT(*) AS n FROM apps WHERE domain = ?'),
    insert: db.prepare(`INSERT INTO apps (account_id, username, name, kind, preset, domain, base_path, root, start_json, build_json, runtime_kind, runtime_version, port, mode, env_enc, websockets, spa_fallback, memory_max_mb, tasks_max, cpu_quota_percent, source_json, created_by)
      VALUES (@account_id, @username, @name, @kind, @preset, @domain, @base_path, @root, @start_json, @build_json, @runtime_kind, @runtime_version, @port, @mode, @env_enc, @websockets, @spa_fallback, @memory_max_mb, @tasks_max, @cpu_quota_percent, @source_json, @created_by)`),
    delete: db.prepare('DELETE FROM apps WHERE id = ?'),
    accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    nodeUsage: db.prepare("SELECT runtime_version AS version, COUNT(*) AS n FROM apps WHERE runtime_kind = 'node' GROUP BY runtime_version"),
    appsUsingNode: db.prepare("SELECT id, name, username FROM apps WHERE runtime_kind = 'node' AND runtime_version = ?"),
    runtimesAll: db.prepare('SELECT * FROM app_runtimes ORDER BY kind, version'),
    runtimeGet: db.prepare('SELECT * FROM app_runtimes WHERE kind = ? AND version = ?'),
    runtimeInsert: db.prepare('INSERT OR REPLACE INTO app_runtimes (kind, version, path, bin) VALUES (?, ?, ?, ?)'),
    runtimeDelete: db.prepare('DELETE FROM app_runtimes WHERE kind = ? AND version = ?'),
    templatesAll: db.prepare('SELECT * FROM app_templates ORDER BY name'),
    templateById: db.prepare('SELECT * FROM app_templates WHERE id = ?'),
    templateBySlug: db.prepare('SELECT * FROM app_templates WHERE slug = ?'),
    templateInsert: db.prepare('INSERT INTO app_templates (slug, name, kind, preset_json, description, created_by) VALUES (?, ?, ?, ?, ?, ?)'),
    templateUpdate: db.prepare(`UPDATE app_templates SET slug = ?, name = ?, kind = ?, preset_json = ?, description = ?, updated_at = datetime('now') WHERE id = ?`),
    templateDelete: db.prepare('DELETE FROM app_templates WHERE id = ?'),
  };

  const COLUMNS = new Set(['name', 'start_json', 'build_json', 'runtime_kind', 'runtime_version', 'runtime_bin', 'port', 'mode', 'env_enc', 'websockets', 'spa_fallback', 'memory_max_mb', 'tasks_max', 'cpu_quota_percent', 'source_json', 'status', 'last_error', 'last_job_id', 'unit', 'proxy_path']);
  function patch(id, values) {
    const keys = Object.keys(values).filter((k) => COLUMNS.has(k));
    if (!keys.length) return;
    db.prepare(`UPDATE apps SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...Object.fromEntries(keys.map((k) => [k, values[k]])), id });
  }

  const requireApache = () => capabilities.require('apache', 'Apache is not installed on this server; applications are published through the account vhost. Install apache2 (Debian/Ubuntu) or httpd (RHEL) first.');
  const requireSystemd = () => capabilities.require('systemd', 'systemd is required to run applications as services on this server');
  function requireRuntime(kind, version) {
    if (kind === 'node') {
      if (version !== 'system' && stmts.runtimeGet.get('node', version)) return;
      if (!capabilities.has('node')) throw new CapabilityError('node', version === 'system' ? 'Node.js is not installed on this server; install the nodejs package or a managed version under Runtime Versions' : `Node.js ${version} is not installed; install it under Runtime Versions`);
    }
    if (kind === 'python') capabilities.require('python', 'Python 3 is not installed on this server; install python3 and python3-venv (Software › Install Distro Packages)');
  }
  function checkRuntimeVersion(kind, version) {
    if (!kind) return null;
    const v = version ?? (kind === 'node' ? S('apps.default_node', 'system') : S('apps.default_python', 'system'));
    if (v === 'system') return v;
    if (kind === 'node' && !NODE_VERSION.test(v)) throw unprocessable(`"${v}" is not a Node.js version (use 20.11.0 or system)`, { runtimeVersion: ['Not a Node.js version'] });
    if (kind === 'python' && !PYTHON_VERSION.test(v)) throw unprocessable(`"${v}" is not a Python version (use 3.12 or system)`, { runtimeVersion: ['Not a Python version'] });
    return v;
  }
  function assertMutator(user) {
    if (!isRoot(user) && !S('apps.allow_resellers', true)) throw forbidden('Resellers may not manage applications on this server');
  }

  const homeOf = (account) => account.home_dir || `${S('basic.home_root', '/home')}/${account.username}`;
  const account = (username, user) => ctx.accounts.get(username, user);

  function load(id, user) {
    const row = stmts.byId.get(id);
    if (!row) throw notFound('Application');
    return { row, account: account(row.username, user) };
  }

  function encryptEnv(env) { return env && Object.keys(env).length ? ctx.crypto.encrypt(JSON.stringify(env)) : null; }
  function decryptEnv(row) {
    if (!row.env_enc) return {};
    try { return json.parse(ctx.crypto.decrypt(row.env_enc), {}); } catch (err) { logger.warn({ err, app: row.id }, 'application env could not be decrypted'); return {}; }
  }

  function shape(r, { env = true } = {}) {
    if (!r) return null;
    return {
      id: r.id, name: r.name, kind: r.kind, preset: r.preset, username: r.username, accountId: r.account_id, domain: r.domain, basePath: r.base_path, root: r.root,
      url: `https://${r.domain}${r.base_path}`, port: r.port, mode: r.mode,
      runtime: { kind: r.runtime_kind, version: r.runtime_version, bin: r.runtime_bin },
      status: r.status, lastError: r.last_error, lastJobId: r.last_job_id, unit: r.unit, proxyPath: r.proxy_path,
      websockets: Boolean(r.websockets), spaFallback: Boolean(r.spa_fallback),
      limits: { memoryMaxMb: r.memory_max_mb, tasksMax: r.tasks_max, cpuQuotaPercent: r.cpu_quota_percent },
      source: json.parse(r.source_json, null), start: json.parse(r.start_json, null), build: json.parse(r.build_json, {}),
      ...(env ? { env: decryptEnv(r) } : {}),
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  function domainsFor(username, user) {
    const a = account(username, user);
    const home = homeOf(a);
    const out = [];
    const seen = new Set();
    const mainRow = a.domains.find((d) => d.type === 'main');
    out.push({ domain: a.domain, type: 'main', docroot: mainRow?.docroot || `${home}/public_html` });
    seen.add(a.domain);
    for (const d of a.domains) {
      if (!['addon', 'sub'].includes(d.type) || seen.has(d.domain)) continue;
      out.push({ domain: d.domain, type: d.type, docroot: d.docroot || `${home}/public_html/${d.domain}` });
      seen.add(d.domain);
    }
    return out;
  }

  function checkRoot(root, kind, a) {
    const home = homeOf(a);
    const norm = path.posix.normalize(root).replace(/\/+$/, '');
    if (!norm.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(norm)) throw unprocessable('The application root must be an absolute path', { root: ['Invalid path'] });
    if (norm === home) throw unprocessable('The application root cannot be the home directory itself', { root: ['Choose a directory inside the home'] });
    if (!norm.startsWith(`${home}/`)) throw unprocessable(`The application root must be inside ${home}/`, { root: ['Outside the account home'] });
    if (kind !== 'static' && norm === `${home}/public_html`) throw unprocessable('Node.js and Python applications cannot use public_html itself as their root; use a directory such as <home>/apps/<name>', { root: ['Not allowed for this kind'] });
    for (const seg of norm.slice(home.length + 1).split('/')) if (seg.startsWith('.') && seg !== '.') throw unprocessable('The application root cannot be inside a hidden directory', { root: ['Hidden directory'] });
    return norm;
  }

  function portRange() {
    const r = S('apps.port_range', [30000, 39999]);
    return Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 1024 && r[1] <= 65535 && r[0] < r[1] ? r : [30000, 39999];
  }
  function allocatePort() {
    const [lo, hi] = portRange();
    const used = new Set(stmts.ports.all().map((r) => r.port));
    for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
    throw conflict(`No free application port left in ${lo}-${hi}; widen apps.port_range`);
  }

  // --- presets and templates --------------------------------------------------
  function shapeTemplate(r) {
    return r && { id: r.id, slug: r.slug, name: r.name, kind: r.kind, description: r.description, preset: json.parse(r.preset_json, {}), createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  function customPresets() {
    return stmts.templatesAll.all().map(shapeTemplate).map((t) => {
      const p = t.preset;
      return {
        id: t.slug, label: t.name, kind: t.kind, framework: null, custom: true, templateId: t.id, description: t.description || '', detect: { files: [], dependencies: [] },
        install: p.build?.install === undefined ? KIND_DEFAULTS[t.kind].install : p.build.install,
        build: p.build?.script ? { script: p.build.script, optional: Boolean(p.build.optional) } : null,
        start: p.start ?? (t.kind === 'static' ? null : KIND_DEFAULTS[t.kind].start),
        outputDir: t.kind === 'static' ? (p.build?.outputDir ?? '.') : null,
        spaFallback: t.kind === 'static' ? (p.spaFallback ?? true) : false,
        websockets: t.kind === 'static' ? false : (p.websockets ?? true),
        scaffold: false, docs: null,
        defaults: { runtimeVersion: p.runtimeVersion, mode: p.mode, limits: p.limits ?? {}, extraPackages: p.build?.extraPackages ?? [] },
      };
    });
  }
  const presets = () => [...PRESETS, ...customPresets()];
  function templateInput(input) {
    const preset = presetFieldsSchema.parse(input.preset ?? {});
    // Rejects a start/build combination the kind cannot run.
    resolvePreset(null, { ...preset, kind: input.kind });
    return { preset, description: input.description ?? null };
  }
  const templates = {
    list() { return stmts.templatesAll.all().map(shapeTemplate); },
    get(id) { const row = stmts.templateById.get(id); if (!row) throw notFound('Template'); return shapeTemplate(row); },
    create(input, user, req) {
      if (PRESETS.some((p) => p.id === input.slug)) throw conflict(`"${input.slug}" is a built-in preset`);
      if (stmts.templateBySlug.get(input.slug)) throw conflict(`A template with slug "${input.slug}" already exists`);
      const { preset, description } = templateInput(input);
      const { lastInsertRowid } = stmts.templateInsert.run(input.slug, input.name, input.kind, JSON.stringify(preset), description, user?.id ?? null);
      audit(req, { action: 'app.template.create', target: input.slug, args: { name: input.name, kind: input.kind, preset } });
      return shapeTemplate(stmts.templateById.get(lastInsertRowid));
    },
    update(id, input, req) {
      const cur = stmts.templateById.get(id);
      if (!cur) throw notFound('Template');
      const slug = input.slug ?? cur.slug;
      if (slug !== cur.slug && (PRESETS.some((p) => p.id === slug) || stmts.templateBySlug.get(slug))) throw conflict(`"${slug}" is already taken`);
      const merged = { slug, name: input.name ?? cur.name, kind: input.kind ?? cur.kind, description: input.description === undefined ? cur.description : input.description, preset: input.preset ?? json.parse(cur.preset_json, {}) };
      const { preset, description } = templateInput(merged);
      stmts.templateUpdate.run(merged.slug, merged.name, merged.kind, JSON.stringify(preset), description, id);
      audit(req, { action: 'app.template.update', target: merged.slug, args: { name: merged.name, kind: merged.kind, preset } });
      return shapeTemplate(stmts.templateById.get(id));
    },
    remove(id, req) {
      const cur = stmts.templateById.get(id);
      if (!cur) throw notFound('Template');
      stmts.templateDelete.run(id);
      audit(req, { action: 'app.template.remove', target: cur.slug });
      return { id, slug: cur.slug, removed: true };
    },
  };

  // --- host work shared by deploy, update and remove ---------------------------
  const npmFor = (nodeBin) => path.posix.join(path.posix.dirname(nodeBin), 'npm');
  function execFor(kind, start, runtimeBin, root, port) {
    let exec;
    if (kind === 'node' && start.mode === 'file') exec = { bin: runtimeBin, args: [start.entry] };
    else if (kind === 'node' && start.mode === 'npm-script') exec = { bin: npmFor(runtimeBin), args: ['run', '--', start.script] };
    else if (kind === 'python' && start.mode === 'file') exec = { bin: `${root}/.venv/bin/python`, args: [start.entry] };
    else if (kind === 'python' && start.mode === 'gunicorn') exec = { bin: `${root}/.venv/bin/gunicorn`, args: [start.module, '--bind', `127.0.0.1:${port}`, '--workers', String(start.workers || 2)] };
    else if (kind === 'python' && start.mode === 'uvicorn') exec = { bin: `${root}/.venv/bin/uvicorn`, args: [start.module, '--host', '127.0.0.1', '--port', String(port)] };
    else throw unprocessable(`Start mode "${start?.mode}" is not available for ${kind} applications`);
    for (const a of exec.args) if (!ARG_TOKEN.test(a)) throw unprocessable(`Start argument "${a}" contains characters that cannot be passed to the service`);
    return exec;
  }
  function unitSpec(row, start, env, runtimeBin) {
    const root = row.root;
    return {
      id: row.id, username: row.username, name: row.name, root,
      exec: execFor(row.kind, start, runtimeBin, root, row.port),
      port: row.port, env, mode: row.mode,
      pathDirs: row.kind === 'node' ? [path.posix.dirname(runtimeBin), `${root}/node_modules/.bin`] : [`${root}/.venv/bin`],
      limits: { memoryMaxMb: row.memory_max_mb, tasksMax: row.tasks_max, cpuQuotaPercent: row.cpu_quota_percent },
    };
  }
  function staticDirOf(row, build = json.parse(row.build_json, {})) {
    const dir = path.posix.normalize(path.posix.join(row.root, build.resolvedOutputDir || build.outputDir || '.'));
    if (dir !== row.root && !dir.startsWith(`${row.root}/`)) throw unprocessable('The output directory must be inside the application root', { 'build.outputDir': ['Outside the root'] });
    return dir;
  }
  function proxyEntry(r) {
    if (r.kind === 'static') return { id: r.id, kind: 'static', basePath: r.base_path, staticDir: staticDirOf(r), websockets: false, spaFallback: Boolean(r.spa_fallback) };
    return { id: r.id, kind: 'proxy', basePath: r.base_path, port: r.port, websockets: Boolean(r.websockets), spaFallback: false };
  }
  // Rewrites <apache root>/whm-apps/<domain>.conf from every published app of
  // the domain (longest base path first: ProxyPass takes the first match).
  // The domain's document root travels with every include write so an app
  // published at "/" leaves /.well-known/acme-challenge on it (AutoSSL webroot).
  const docrootStmts = {
    domain: db.prepare('SELECT d.docroot, d.type, a.home_dir, a.username FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.domain = ?'),
    main: db.prepare('SELECT home_dir, username FROM accounts WHERE domain = ?'),
  };
  const DOCROOT_RE = /^\/[A-Za-z0-9_.\/-]+$/;
  function docrootFor(domain) {
    const homeOf = (r) => r.home_dir || `${settings.get('basic.home_root') || '/home'}/${r.username}`;
    const d = docrootStmts.domain.get(domain);
    let docroot = null;
    if (d) docroot = d.docroot || (d.type === 'main' ? `${homeOf(d)}/public_html` : `${homeOf(d)}/public_html/${domain}`);
    else { const m = docrootStmts.main.get(domain); if (m) docroot = `${homeOf(m)}/public_html`; }
    return docroot && DOCROOT_RE.test(docroot) ? docroot : null;
  }
  async function writeProxy(domain, { include = null, exclude = null, override = null } = {}, call) {
    const rows = stmts.byDomain.all(domain).filter((r) => r.id !== exclude && (r.id === include || r.proxy_path)).map((r) => (override && r.id === override.id ? override : r));
    const docroot = docrootFor(domain);
    return call('app.proxy.write', { domain, apps: rows.map(proxyEntry), reload: true, ...(docroot ? { docroot } : {}) });
  }
  async function webRunUser(call) {
    try { const d = await call('web.detect', {}); if (RUN_USER.test(d?.apache?.runUser ?? '')) return d.apache.runUser; } catch (err) { logger.warn({ err }, 'web.detect failed; assuming www-data'); }
    return 'www-data';
  }
  async function resolveRuntime(kind, version, call) {
    let detected = { node: [], python: [] };
    try { detected = await call('app.runtime.detect', {}); } catch (err) { logger.warn({ err }, 'app.runtime.detect failed'); }
    if (kind === 'node') {
      const list = (detected.node || []).filter((n) => n.present !== false);
      let hit = version === 'system' || !version ? list.find((n) => n.source === 'system') : (list.find((n) => n.source === 'managed' && n.version === version) || list.find((n) => n.version === version));
      if (!hit && version !== 'system') { const r = stmts.runtimeGet.get('node', version); if (r) hit = { version, bin: r.bin, path: r.path, source: 'managed' }; }
      if (!hit) throw new CapabilityError('node', version === 'system' || !version ? 'Node.js is not installed on this server' : `Node.js ${version} is not installed on this server`);
      return { kind, version: hit.version, bin: hit.bin, source: hit.source };
    }
    const list = (detected.python || []).filter((p) => p.venv);
    const hit = version === 'system' || !version ? list[0] : list.find((p) => p.version === version || String(p.version).startsWith(`${version}.`));
    if (!hit) throw new CapabilityError('python', (detected.python || []).length ? `Python ${version === 'system' ? '3' : version} with venv support is not installed; install python3-venv` : 'Python 3 is not installed on this server');
    return { kind, version: hit.version, bin: hit.bin, source: hit.source };
  }
  async function liveStatus(unit, req) {
    if (!unit) return null;
    try { return await op('svc.status', { unit }, req); } catch (err) { logger.debug({ err, unit }, 'svc.status failed'); return null; }
  }

  // The deploy pipeline (jobs app.deploy / app.rebuild): prepare → runtime →
  // install → build → publish → start. A failing step leaves the row `failed`.
  async function runDeploy(appId, { pull = false, scaffold = null, source = null, prepare = false, resume = false } = {}, job) {
    const row = stmts.byId.get(appId);
    if (!row) throw notFound('Application');
    const acct = stmts.accountById.get(row.account_id);
    if (!acct) throw notFound('Account');
    const log = (line, level) => job?.log?.(line, level);
    const progress = (pct, msg) => job?.progress?.(pct, msg);
    const jobAgent = job?.agent ?? agent;
    const call = (name, args = {}, opts = {}) => jobAgent.op(name, args, opts);
    requireApache();
    if (row.kind !== 'static') requireSystemd();
    const { username, root } = row;
    const start = json.parse(row.start_json, null);
    const build = json.parse(row.build_json, {});
    const env = decryptEnv(row);
    patch(appId, { status: 'deploying', last_error: null, last_job_id: job?.job?.id ?? row.last_job_id });
    const logOutput = (r, label) => { for (const line of r.output || []) log(line); log(`${label} finished in ${Math.round((r.durationMs || 0) / 1000)}s`); };
    try {
      let fresh = prepare;
      if (prepare && resume) {
        // A retry of a deploy whose clone or scaffold never finished: only an
        // empty root is prepared again; one that has files is pulled or kept.
        const insp = await call('app.inspect', { username, root });
        fresh = !insp.exists || insp.empty;
        if (!fresh) log(`${root} already has files; ${pull && source?.gitUrl ? 'pulling the latest commit' : 'keeping them'}`);
      }
      if (fresh) {
        progress(5, 'Preparing the application directory');
        const args = { username, root };
        if (source?.gitUrl) args.source = { gitUrl: source.gitUrl, ...(source.ref ? { ref: source.ref } : {}) };
        else if (scaffold) args.scaffold = { template: scaffold, name: row.name };
        const prep = await call('app.prepare', args, { timeoutMs: 900_000 });
        log(prep.cloned ? `Cloned ${source.gitUrl}${source.ref ? ` (${source.ref})` : ''} into ${root}` : prep.scaffolded?.length ? `Created ${prep.scaffolded.join(', ')} in ${root}` : `Application directory ${root} is ready`);
      } else if (pull) {
        const src = json.parse(row.source_json, null);
        if (src?.type !== 'git') throw unprocessable('This application has no git source to pull from');
        progress(5, 'Pulling the latest commit');
        const r = await call('app.pull', { username, root, ...(src.ref ? { ref: src.ref } : {}) }, { timeoutMs: 600_000 });
        log(`Pulled ${src.url}${src.ref ? ` (${src.ref})` : ''}: ${String(r.head || '').slice(0, 12)}`);
      }
      let runtime = null;
      if (row.runtime_kind) {
        progress(15, 'Resolving the runtime');
        runtime = await resolveRuntime(row.runtime_kind, row.runtime_version, call);
        patch(appId, { runtime_bin: runtime.bin });
        log(`Using ${row.runtime_kind} ${runtime.version} (${runtime.bin})`);
      }
      if (build.install === 'npm') {
        progress(30, 'Installing npm dependencies');
        logOutput(await call('app.step', { username, root, step: 'npm-install', runtime: { kind: 'node', bin: runtime.bin }, production: row.mode === 'production' && !build.script }, { timeoutMs: 1_800_000 }), 'npm install');
      } else if (build.install === 'pip') {
        progress(25, 'Creating the virtual environment');
        logOutput(await call('app.step', { username, root, step: 'venv-create', runtime: { kind: 'python', bin: runtime.bin } }, { timeoutMs: 600_000 }), 'venv');
        const packages = [...(build.extraPackages || [])];
        if (['gunicorn', 'uvicorn'].includes(start?.mode) && !packages.some((p) => p.split(/[=[]/)[0] === start.mode)) packages.push(start.mode);
        progress(35, 'Installing pip requirements');
        logOutput(await call('app.step', { username, root, step: 'pip-install', runtime: { kind: 'python', bin: runtime.bin }, packages }, { timeoutMs: 1_800_000 }), 'pip install');
      }
      if (build.script) {
        let run = true;
        if (build.optional) {
          const insp = await call('app.inspect', { username, root });
          run = Boolean(insp.packageJson?.scripts?.[build.script]);
          if (!run) log(`package.json has no "${build.script}" script; skipping the build`);
        }
        if (run) {
          progress(55, `Running npm run ${build.script}`);
          logOutput(await call('app.step', { username, root, step: 'npm-run', runtime: { kind: 'node', bin: runtime.bin }, script: build.script, production: row.mode === 'production' }, { timeoutMs: 1_800_000 }), `npm run ${build.script}`);
        }
      }
      let staticDir = null;
      let unit = null;
      if (row.kind === 'static') {
        let outputDir = build.outputDir || '.';
        if (outputDir.includes('<project>')) {
          const insp = await call('app.inspect', { username, root });
          const project = insp.angularProjects?.[0];
          if (!project || !REL_PATH.test(project)) throw unprocessable('Could not read the project name from angular.json; set the output directory explicitly');
          outputDir = outputDir.replace('<project>', project);
        }
        build.resolvedOutputDir = outputDir;
        staticDir = staticDirOf(row, build);
        patch(appId, { build_json: JSON.stringify(build) });
        progress(70, 'Exposing the build output to the web server');
        const runUser = await webRunUser(call);
        const exposed = await call('app.static.expose', { username, dir: staticDir, runUser });
        log(`${staticDir} readable by ${runUser} (${exposed.method})`);
      } else {
        unit = `whm-app-${appId}`;
        progress(70, 'Writing the service unit');
        const current = stmts.byId.get(appId) ?? row;
        const written = await call('app.unit.write', unitSpec({ ...current, build_json: JSON.stringify(build) }, json.parse(current.start_json, null), decryptEnv(current), runtime.bin));
        patch(appId, { unit });
        log(`Service unit ${written.unit || unit} written`);
      }
      progress(80, 'Publishing through Apache');
      const proxy = await writeProxy(row.domain, { include: appId }, call);
      patch(appId, { proxy_path: proxy.path ?? null });
      log(`Apache include ${proxy.path} rewritten for ${row.domain} (${proxy.apps} application${proxy.apps === 1 ? '' : 's'})${proxy.reloaded ? ', Apache reloaded' : ''}`);
      if (unit) {
        progress(90, 'Starting the service');
        await call(row.unit ? 'svc.restart' : 'svc.start', { unit });
        log(`${unit} ${row.unit ? 'restarted' : 'started'} on 127.0.0.1:${row.port}`);
      }
      const status = unit ? 'running' : 'built';
      patch(appId, { status, last_error: null });
      progress(100, status === 'running' ? 'Running' : 'Built and served');
      return { id: appId, status, unit, port: row.port, url: `https://${row.domain}${row.base_path}`, staticDir, proxyPath: proxy.path ?? null };
    } catch (err) {
      patch(appId, { status: 'failed', last_error: String(err.message || err).slice(0, 2000) });
      throw err;
    }
  }

  async function runtimeInstallJob(job) {
    const { version } = job.params;
    job.progress(5, `Downloading Node.js ${version}`);
    job.log(`Downloading Node.js ${version} from nodejs.org and verifying SHASUMS256`);
    const r = await job.agent.op('app.runtime.node.install', { version }, { timeoutMs: 900_000 });
    stmts.runtimeInsert.run('node', r.version, r.path, r.bin);
    job.log(`Node.js ${r.version} installed at ${r.path}`);
    job.progress(100, 'Installed');
    return { version: r.version, path: r.path, bin: r.bin, npm: r.npm ?? npmFor(r.bin) };
  }

  // Stops, unlinks and unpublishes one app; every step is reported, none blocks.
  async function teardown(row, { purge = false } = {}, req) {
    const cleanup = {};
    const attempt = async (name, fn) => {
      try { cleanup[name] = (await fn()) ?? { ok: true }; } catch (err) { logger.warn({ err, app: row.id, step: name }, 'application cleanup step failed'); cleanup[name] = { error: err.message, code: err.code ?? null }; }
    };
    if (row.unit) {
      if (!capabilities.has('systemd')) cleanup.unit = { skipped: 'systemd is not available' };
      else {
        await attempt('stop', () => op('svc.stop', { unit: row.unit }, req));
        await attempt('unit', () => op('app.unit.remove', { id: row.id }, req));
      }
    }
    if (row.proxy_path) {
      if (!capabilities.has('apache')) cleanup.proxy = { skipped: 'Apache is not installed' };
      else await attempt('proxy', () => writeProxy(row.domain, { exclude: row.id }, (n, a, o) => op(n, a, req, o)));
    }
    if (purge) await attempt('purge', () => op('app.purge', { username: row.username, root: row.root }, req, { timeoutMs: 600_000 }));
    return cleanup;
  }

  function jobActive(row) {
    if (!row.last_job_id) return false;
    try { return ['queued', 'running'].includes(ctx.jobs.get(row.last_job_id).status); } catch { return false; }
  }
  // An app that never published anything may still be missing its clone or
  // scaffold, so a retried deploy or rebuild prepares the root again.
  function resumeParams(row) {
    if (row.unit || row.proxy_path) return {};
    const source = json.parse(row.source_json, null);
    return { prepare: true, resume: true, scaffold: source?.type === 'scaffold' ? source.template : null, source: source?.type === 'git' ? { gitUrl: source.url, ref: source.ref ?? null } : null };
  }

  // --- public API --------------------------------------------------------------
  function list(query, user) {
    const where = [];
    const params = {};
    if (!isRoot(user)) { where.push('a.owner_id = @owner'); params.owner = user.id; }
    if (query.account) { where.push('x.username = @account'); params.account = query.account; }
    if (query.kind) { where.push('x.kind = @kind'); params.kind = query.kind; }
    if (query.status) { where.push('x.status = @status'); params.status = query.status; }
    if (query.q) { where.push(`(x.name LIKE @q ESCAPE '\\' OR x.domain LIKE @q ESCAPE '\\' OR x.username LIKE @q ESCAPE '\\')`); params.q = `%${likeEscape(query.q)}%`; }
    const result = paginate(db, {
      select: 'x.*', from: 'apps x JOIN accounts a ON a.id = x.account_id', where, params, query,
      sortable: { name: 'x.name', domain: 'x.domain', username: 'x.username', status: 'x.status', updated_at: 'x.updated_at', created_at: 'x.created_at', kind: 'x.kind' },
      defaultSort: 'name',
    });
    return { ...result, data: result.data.map((r) => shape(r)) };
  }

  async function get(id, user) {
    const { row } = load(id, user);
    return { ...shape(row), live: row.kind === 'static' ? null : await liveStatus(row.unit) };
  }

  async function create(input, user, req) {
    assertMutator(user);
    const a = account(input.username, user);
    requireApache();
    let presetId = input.preset ?? null;
    if (input.source?.type === 'scaffold') {
      presetId ??= input.source.template;
      if (presetId !== input.source.template) throw unprocessable(`The "${input.source.template}" scaffold goes with the "${input.source.template}" preset`, { 'source.template': ['Does not match the preset'] });
    }
    const resolved = resolvePreset(presetId, input, customPresets());
    if (resolved.kind !== 'static') requireSystemd();
    const runtimeVersion = checkRuntimeVersion(resolved.runtimeKind, resolved.defaults.runtimeVersion);
    requireRuntime(resolved.runtimeKind, runtimeVersion);
    if (input.source?.type === 'git') capabilities.require('git', 'git is not installed on this server; install it to deploy from a repository');
    if (!domainsFor(input.username, user).some((d) => d.domain === input.domain)) throw unprocessable(`Domain "${input.domain}" does not belong to account "${input.username}"`, { domain: ['Not one of the account domains'] });
    const basePath = input.basePath.length > 1 ? input.basePath.replace(/\/+$/, '') : '/';
    if (stmts.byDomainBase.get(input.domain, basePath)) throw conflict(`An application already serves ${input.domain}${basePath}`);
    if (stmts.countDomain.get(input.domain).n >= MAX_APPS_PER_DOMAIN) throw conflict(`At most ${MAX_APPS_PER_DOMAIN} applications per domain`);
    const root = checkRoot(input.root, resolved.kind, a);
    for (const other of stmts.roots.all(input.username)) {
      if (other.root === root || root.startsWith(`${other.root}/`) || other.root.startsWith(`${root}/`)) throw conflict(`The directory ${root} overlaps application #${other.id} (${other.root})`);
    }
    const mode = resolved.defaults.mode ?? 'production';
    const limits = { memoryMaxMb: Number(S('apps.default_memory_mb', 512)) || 512, tasksMax: 256, cpuQuotaPercent: 100, ...stripUndefined(resolved.defaults.limits) };
    const build = resolved.build;
    const source = input.source ? (input.source.type === 'git' ? { type: 'git', url: input.source.url, ref: input.source.ref ?? null } : input.source.type === 'scaffold' ? { type: 'scaffold', template: input.source.template } : { type: 'upload' }) : { type: 'upload' };
    const env = input.env ?? {};
    const id = db.transaction(() => Number(stmts.insert.run({
      account_id: a.id, username: a.username, name: input.name, kind: resolved.kind, preset: resolved.preset, domain: input.domain, base_path: basePath, root,
      start_json: JSON.stringify(resolved.start ?? {}), build_json: JSON.stringify(build), runtime_kind: resolved.runtimeKind, runtime_version: runtimeVersion,
      port: resolved.kind === 'static' ? null : allocatePort(), mode, env_enc: encryptEnv(env), websockets: resolved.websockets ? 1 : 0, spa_fallback: resolved.spaFallback ? 1 : 0,
      memory_max_mb: limits.memoryMaxMb, tasks_max: limits.tasksMax, cpu_quota_percent: limits.cpuQuotaPercent, source_json: JSON.stringify(source), created_by: user?.id ?? null,
    }).lastInsertRowid))();
    let job;
    try {
      job = enqueue('app.deploy', { appId: id, prepare: true, scaffold: source.type === 'scaffold' ? source.template : null, source: source.type === 'git' ? { gitUrl: source.url, ref: source.ref } : null }, user);
    } catch (err) { stmts.delete.run(id); throw err; }
    patch(id, { last_job_id: job.id });
    audit(req, { action: 'app.create', target: String(id), args: { username: a.username, name: input.name, kind: resolved.kind, preset: resolved.preset, domain: input.domain, basePath, root, runtimeVersion, mode, source, env: redactEnv(env), jobId: job.id } });
    return { app: shape(stmts.byId.get(id)), job };
  }

  async function update(id, input, user, req) {
    assertMutator(user);
    const { row } = load(id, user);
    if (jobActive(row)) throw conflict('A deployment of this application is running; wait for it to finish');
    const curStart = json.parse(row.start_json, null);
    const curBuild = json.parse(row.build_json, {});
    const values = {};
    if (input.name !== undefined) values.name = input.name;
    if (input.start !== undefined) {
      if (row.kind === 'static') throw unprocessable('Static applications have no start command', { start: ['Not applicable'] });
      const o = stripUndefined(input.start);
      values.start_json = JSON.stringify(validateStart(row.kind, o.mode && o.mode !== curStart?.mode ? o : { ...(curStart ?? {}), ...o }));
    }
    let build = curBuild;
    if (input.build !== undefined) {
      const ob = stripUndefined(input.build);
      if (row.kind === 'python' && ob.install === 'npm') throw unprocessable('Python applications install with pip', { 'build.install': ['pip or none'] });
      if (row.kind !== 'python' && ob.install === 'pip') throw unprocessable('Only Python applications install with pip', { 'build.install': ['npm or none'] });
      build = { ...curBuild, ...ob };
      if (ob.outputDir !== undefined) delete build.resolvedOutputDir;
      if (ob.script !== undefined) build.optional = Boolean(ob.optional);
      if (row.kind === 'static') build.outputDir = build.outputDir || '.';
      values.build_json = JSON.stringify(build);
      if (row.kind === 'static') {
        const runtimeKind = build.install === 'npm' || build.script ? 'node' : null;
        values.runtime_kind = runtimeKind;
        values.runtime_version = runtimeKind ? checkRuntimeVersion('node', input.runtimeVersion ?? (row.runtime_kind === 'node' ? row.runtime_version : undefined)) : null;
        if (!runtimeKind) values.runtime_bin = null;
      }
    }
    if (input.runtimeVersion !== undefined && values.runtime_version === undefined) {
      const kind = values.runtime_kind === undefined ? row.runtime_kind : values.runtime_kind;
      if (!kind) throw unprocessable('This application has no runtime', { runtimeVersion: ['Not applicable'] });
      values.runtime_version = checkRuntimeVersion(kind, input.runtimeVersion);
      requireRuntime(kind, values.runtime_version);
    }
    if (input.env !== undefined) values.env_enc = encryptEnv(input.env);
    if (input.mode !== undefined) values.mode = input.mode;
    if (input.websockets !== undefined) values.websockets = row.kind !== 'static' && input.websockets ? 1 : 0;
    if (input.spaFallback !== undefined) values.spa_fallback = row.kind === 'static' && input.spaFallback ? 1 : 0;
    if (input.limits) {
      if (input.limits.memoryMaxMb !== undefined) values.memory_max_mb = input.limits.memoryMaxMb;
      if (input.limits.tasksMax !== undefined) values.tasks_max = input.limits.tasksMax;
      if (input.limits.cpuQuotaPercent !== undefined) values.cpu_quota_percent = input.limits.cpuQuotaPercent;
    }
    // Host first, DB second: the unit and the include are rewritten from the
    // candidate row and the change is persisted only once the host accepted it.
    const next = { ...row, ...values };
    const applied = { unit: false, restarted: false, proxy: false, rebuildRequired: false };
    const unitKeys = ['name', 'start_json', 'env_enc', 'mode', 'memory_max_mb', 'tasks_max', 'cpu_quota_percent'];
    const rewriteUnit = Boolean(next.unit && next.runtime_bin && unitKeys.some((k) => values[k] !== undefined));
    const rewriteProxy = Boolean(next.proxy_path && (values.websockets !== undefined || values.spa_fallback !== undefined));
    if (rewriteUnit) requireSystemd();
    if (rewriteProxy) requireApache();
    const call = (n, a, o) => op(n, a, req, o);
    if (rewriteUnit) {
      await call('app.unit.write', unitSpec(next, json.parse(next.start_json, null), decryptEnv(next), next.runtime_bin));
      applied.unit = true;
    }
    if (rewriteProxy) {
      try {
        await writeProxy(next.domain, { override: next }, call);
      } catch (err) {
        if (applied.unit) await call('app.unit.write', unitSpec(row, curStart, decryptEnv(row), row.runtime_bin)).catch((e) => logger.warn({ err: e, app: id }, 'could not restore the unit after a failed include rewrite'));
        throw err;
      }
      applied.proxy = true;
    }
    patch(id, values);
    if (rewriteUnit && next.status === 'running') {
      try {
        await call('svc.restart', { unit: next.unit });
      } catch (err) {
        patch(id, { status: 'failed', last_error: String(err.message || err).slice(0, 2000) });
        throw err;
      }
      applied.restarted = true;
    }
    if (values.build_json !== undefined || (values.runtime_version !== undefined && values.runtime_version !== row.runtime_version)) applied.rebuildRequired = next.status !== 'created';
    audit(req, { action: 'app.update', target: String(id), args: { ...input, env: redactEnv(input.env), applied } });
    return { ...shape(stmts.byId.get(id)), applied };
  }

  async function control(id, verb, user, req) {
    assertMutator(user);
    const { row } = load(id, user);
    if (row.kind === 'static') throw new HttpError(422, 'unsupported', 'Static applications are served by Apache and have no process to control');
    if (!row.unit) throw new HttpError(422, 'unsupported', 'The application has not been deployed yet');
    requireSystemd();
    await op(`svc.${verb}`, { unit: row.unit }, req);
    patch(id, { status: verb === 'stop' ? 'stopped' : 'running' });
    audit(req, { action: `app.${verb}`, target: String(id), args: { unit: row.unit, username: row.username } });
    return { id, verb, status: verb === 'stop' ? 'stopped' : 'running', live: await liveStatus(row.unit, req) };
  }

  async function rebuild(id, user, req) {
    assertMutator(user);
    const { row } = load(id, user);
    requireApache();
    if (row.kind !== 'static') requireSystemd();
    if (jobActive(row)) throw conflict('A deployment of this application is already running');
    const job = enqueue('app.rebuild', { appId: id, ...resumeParams(row) }, user);
    patch(id, { last_job_id: job.id });
    audit(req, { action: 'app.rebuild', target: String(id), args: { username: row.username, jobId: job.id } });
    return { app: shape(stmts.byId.get(id)), job };
  }

  async function deploy(id, user, req) {
    assertMutator(user);
    const { row } = load(id, user);
    const source = json.parse(row.source_json, null);
    if (source?.type !== 'git') throw unprocessable('Only applications deployed from a git repository can pull; use Rebuild for uploaded code', { source: ['No git source'] });
    requireApache();
    if (row.kind !== 'static') requireSystemd();
    capabilities.require('git', 'git is not installed on this server');
    if (jobActive(row)) throw conflict('A deployment of this application is already running');
    const job = enqueue('app.deploy', { appId: id, pull: true, ...resumeParams(row) }, user);
    patch(id, { last_job_id: job.id });
    audit(req, { action: 'app.deploy', target: String(id), args: { username: row.username, url: source.url, ref: source.ref ?? null, jobId: job.id } });
    return { app: shape(stmts.byId.get(id)), job };
  }

  async function logs(id, { lines = 200 } = {}, user) {
    const { row } = load(id, user);
    if (row.kind === 'static') return { id, unit: null, lines: [], note: 'Static applications are served by Apache; use the domain access and error logs.' };
    if (!row.unit) return { id, unit: null, lines: [], note: 'The application has not been deployed yet.' };
    const r = await op('svc.journal', { unit: row.unit, lines });
    return { id, unit: row.unit, lines: r.lines || [] };
  }

  async function inspect({ username, root }, user) {
    const a = account(username, user);
    const norm = checkRoot(root, 'static', a);
    const result = await op('app.inspect', { username, root: norm });
    const guess = guessPreset(result);
    return { ...result, root: result.root ?? norm, preset: guess.preset, suggestion: { preset: guess.preset?.id ?? null, kind: guess.preset?.kind ?? null, outputDir: guess.outputDir, start: guess.start, lockfile: guess.lockfile } };
  }

  async function remove(id, { deleteFiles = false } = {}, user, req) {
    assertMutator(user);
    const { row } = load(id, user);
    if (jobActive(row)) throw conflict('A deployment of this application is still running; wait for it to finish');
    const cleanup = await teardown(row, { purge: deleteFiles }, req);
    stmts.delete.run(id);
    audit(req, { action: 'app.remove', target: String(id), args: { username: row.username, name: row.name, domain: row.domain, basePath: row.base_path, root: row.root, deleteFiles, cleanup } });
    return { id, removed: true, cleanup };
  }

  // Account termination: the home goes with the user, so nothing is purged.
  async function removeAccountApps(username, req) {
    const rows = stmts.byUsername.all(username);
    if (!rows.length) return null;
    const cleanup = {};
    for (const row of rows) {
      cleanup[row.id] = await teardown(row, { purge: false }, req);
      stmts.delete.run(row.id);
      audit(req, { action: 'app.remove', target: String(row.id), args: { username, name: row.name, domain: row.domain, basePath: row.base_path, reason: 'account termination', cleanup: cleanup[row.id] } });
    }
    return { removed: rows.map((r) => r.id), cleanup };
  }

  // --- runtimes -----------------------------------------------------------------
  let indexCache = { at: 0, data: null };
  const runtimes = {
    async list() {
      let detected = { node: [], python: [], git: { installed: capabilities.has('git'), version: null }, arch: process.arch };
      let error = null;
      try { detected = { ...detected, ...(await op('app.runtime.detect', {})) }; } catch (err) { error = err.message; logger.warn({ err }, 'app.runtime.detect failed'); }
      const usage = Object.fromEntries(stmts.nodeUsage.all().map((r) => [r.version ?? 'system', r.n]));
      const defaults = { node: S('apps.default_node', 'system'), python: S('apps.default_python', 'system') };
      const node = (detected.node || []).map((n) => ({ ...n, managed: n.source === 'managed', missing: n.present === false, apps: (usage[n.version] ?? 0) + (n.source === 'system' ? (usage.system ?? 0) : 0), default: n.source === 'system' ? defaults.node === 'system' : defaults.node === n.version }));
      for (const m of stmts.runtimesAll.all().filter((m) => m.kind === 'node')) {
        const hit = node.find((n) => n.source === 'managed' && n.version === m.version);
        if (hit) hit.installedAt = m.installed_at;
        else node.push({ version: m.version, bin: m.bin, path: m.path, source: 'managed', managed: true, missing: true, installedAt: m.installed_at, apps: usage[m.version] ?? 0, default: defaults.node === m.version });
      }
      node.sort((a, b) => (a.source === b.source ? compareSemver(b.version, a.version) : a.source === 'system' ? -1 : 1));
      const python = (detected.python || []).map((p) => ({ ...p, default: defaults.python === 'system' ? false : (p.version === defaults.python || String(p.version).startsWith(`${defaults.python}.`)) }));
      if (python.length && defaults.python === 'system') { const first = python.find((p) => p.venv) ?? python[0]; first.default = true; }
      return {
        node, python, git: detected.git ?? { installed: false, version: null }, arch: detected.arch ?? process.arch, defaults, error,
        policy: policy.get(),
        capabilities: Object.fromEntries(['apache', 'systemd', 'node', 'python', 'git', 'acl'].map((c) => [c, capabilities.has(c)])),
      };
    },
    async available() {
      if (indexCache.data && Date.now() - indexCache.at < INDEX_CACHE_MS) return indexCache.data;
      const url = S('apps.node_index_url', NODE_INDEX_URL);
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': `whm-panel/${ctx.version ?? 'dev'}` }, signal: AbortSignal.timeout(10_000), redirect: 'follow' });
        if (!res.ok) throw new Error(`nodejs.org answered HTTP ${res.status}`);
        const index = await res.json();
        if (!Array.isArray(index)) throw new Error('unexpected release index format');
        const installed = new Set(stmts.runtimesAll.all().filter((m) => m.kind === 'node').map((m) => m.version));
        indexCache = { at: Date.now(), data: { available: selectNodeReleases(index).map((r) => ({ ...r, installed: installed.has(r.version) })), fetchedAt: new Date().toISOString(), source: url, error: null } };
        return indexCache.data;
      } catch (err) {
        logger.warn({ err, url }, 'could not fetch the Node.js release index');
        return { available: [], fetchedAt: null, source: url, error: err.message };
      }
    },
    async installNode(version, user, req) {
      if (stmts.runtimeGet.get('node', version)) throw conflict(`Node.js ${version} is already installed`);
      const job = enqueue('app.runtime.install', { kind: 'node', version }, user);
      audit(req, { action: 'app.runtime.install', target: version, args: { kind: 'node', jobId: job.id } });
      return { version, job };
    },
    async removeNode(version, user, req) {
      const users = stmts.appsUsingNode.all(version);
      if (users.length) throw conflict(`Node.js ${version} is used by ${users.length} application${users.length === 1 ? '' : 's'} (${users.map((u) => `#${u.id} ${u.name}`).join(', ')})`);
      if (S('apps.default_node', 'system') === version) settings.set('apps.default_node', 'system');
      let removed = false;
      try { removed = Boolean((await op('app.runtime.node.remove', { version }, req)).removed); } catch (err) { if (err.code !== 'not_found' || !stmts.runtimeGet.get('node', version)) throw err; }
      stmts.runtimeDelete.run('node', version);
      audit(req, { action: 'app.runtime.remove', target: version, args: { kind: 'node', removed } });
      return { version, removed };
    },
    setDefaults({ node, python } = {}, req) {
      const values = {};
      if (node !== undefined) {
        if (node !== 'system' && !NODE_VERSION.test(node)) throw unprocessable('Default Node.js must be "system" or a version such as 20.11.0', { node: ['Invalid'] });
        if (node !== 'system' && !stmts.runtimeGet.get('node', node)) throw unprocessable(`Node.js ${node} is not a managed version on this server`, { node: ['Not installed'] });
        values['apps.default_node'] = node;
      }
      if (python !== undefined) {
        if (python !== 'system' && !PYTHON_VERSION.test(python)) throw unprocessable('Default Python must be "system" or a version such as 3.12', { python: ['Invalid'] });
        values['apps.default_python'] = python;
      }
      settings.setMany(values);
      audit(req, { action: 'app.runtime.defaults', args: values });
      return { node: S('apps.default_node', 'system'), python: S('apps.default_python', 'system') };
    },
  };

  const policy = {
    get: () => ({ portRange: portRange(), allowResellers: Boolean(S('apps.allow_resellers', true)), defaultMemoryMb: Number(S('apps.default_memory_mb', 512)) || 512 }),
    update(input, req) {
      const values = {};
      if (input.portRange) values['apps.port_range'] = input.portRange;
      if (input.allowResellers !== undefined) values['apps.allow_resellers'] = input.allowResellers;
      if (input.defaultMemoryMb !== undefined) values['apps.default_memory_mb'] = input.defaultMemoryMb;
      settings.setMany(values);
      audit(req, { action: 'app.policy', args: values });
      return policy.get();
    },
  };

  const jobs = {
    'app.deploy': (job) => runDeploy(job.params.appId, job.params, job),
    'app.rebuild': (job) => runDeploy(job.params.appId, { ...job.params, pull: false }, job),
    'app.runtime.install': (job) => runtimeInstallJob(job),
  };

  return { list, get, create, update, control, rebuild, deploy, logs, inspect, remove, removeAccountApps, domainsFor, presets, runtimes, templates, policy, jobs, runDeploy, shape };
}
