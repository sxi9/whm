import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PanelEvents, EVENT_NAME_RE } from '../lib/events.js';
export { PanelEvents, EVENT_NAME_RE };
import { loadPluginSdk as loadSdk, REPO_ROOT } from '../lib/plugin-sdk.js';
import { json, paginate } from '../db/index.js';
import { HttpError, notFound, forbidden, conflict, badRequest, unprocessable, CapabilityError } from '../lib/errors.js';
import { requireRoot, requireReseller } from '../middleware/rbac.js';
import { requireAuth } from '../middleware/auth.js';

// Development category. Attached as ctx.development; other categories may use:
//   ctx.events.emit(event, payload, { stage, req })   -> runs Manage Hooks listeners; a 'pre'
//                                                       stage throws HttpError(409 hook_rejected)
//   ctx.events.on(event, fn) / onAny(fn)              -> in-process listeners (fn receives the envelope)
//   ctx.development.tokens.create(input, user, req)   -> issue an API token for a user (scopes limited to
//                                                       ENFORCED_SCOPES; a token-authenticated req may only
//                                                       mint a subset of its own scopes, for itself, expiring no later)
//   ctx.development.appconfig.listFor(user, service)  -> AppConfig apps visible to a principal
//   ctx.development.openapi.collect()                 -> every mounted endpoint with its role

export { REPO_ROOT };
export const HOOKS_DIR = '/usr/local/whm/hooks';

// Fallback vocabulary used only when plugins/sdk is not shipped with this install.
const FALLBACK_EVENTS = {
  'account.created': { stages: ['pre', 'post'], cancellable: true, payload: '{ username, domain, owner, package, ip, contactEmail }' },
  'account.modified': { stages: ['pre', 'post'], cancellable: true, payload: '{ username, changes }' },
  'account.suspended': { stages: ['pre', 'post'], cancellable: true, payload: '{ username, reason }' },
  'account.unsuspended': { stages: ['pre', 'post'], cancellable: true, payload: '{ username }' },
  'account.terminated': { stages: ['pre', 'post'], cancellable: true, payload: '{ username, domain, keepDns }' },
  'login.failed': { stages: ['post'], cancellable: false, payload: '{ username, ip, reason }' },
  'login.succeeded': { stages: ['post'], cancellable: false, payload: '{ username, role, ip }' },
  'service.restarted': { stages: ['pre', 'post'], cancellable: false, payload: '{ service, unit, principal }' },
  'panel.started': { stages: ['post'], cancellable: false, payload: '{ hostVersion, bootedAt }' },
};

// The SDK loader lives in lib/plugin-sdk.js (shared with the plugin host); this
// keeps the flat { ...validate, path, version } shape the generator uses.
export function loadPluginSdk(root = REPO_ROOT) {
  const sdk = loadSdk(root);
  return sdk ? { ...sdk.validate, path: sdk.path, version: sdk.version } : null;
}

export const HOOK_SCRIPT_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const TOKEN_SCOPE_RE = /^(\*|[a-z][a-z0-9-]{1,30}:(read|write))$/;
export const APP_NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/;
export const ACL_RE = /^[a-z][a-z0-9-]{0,40}$/;

// WHM-style reseller ACL keys an AppConfig entry may require (suggestions; any
// key matching ACL_RE is accepted so plugin-defined ACLs work too).
export const KNOWN_ACLS = [
  'all', 'list-accts', 'create-acct', 'kill-acct', 'suspend-acct', 'edit-account', 'passwd', 'upgrade-account', 'rearrange-accts',
  'edit-dns', 'edit-mx', 'add-pkg', 'edit-pkg', 'viewglobalpackages', 'restart', 'show-bandwidth', 'ssl', 'ssl-info', 'ssl-buy',
  'mailcheck', 'quota', 'stats', 'status', 'news', 'locale-edit', 'manage-api-tokens', 'manage-hooks', 'thirdparty', 'clustering',
  'demo-setup', 'allow-shell', 'disallow-shell', 'basic-whm-functions', 'basic-system-info', 'cpanel-api', 'cpanel-integration',
];

// Only routes that opt in with requireScope() honour token scopes, and today
// that is the Development router alone. Tokens may only carry scopes that are
// actually enforced, so a scope never looks like a boundary it is not.
export const ENFORCED_SCOPES = ['*', 'development:read', 'development:write'];
export const UNRESTRICTED_AREAS = ['accounts', 'packages', 'dns', 'databases', 'email', 'ssl', 'security', 'software', 'system', 'ip', 'services', 'network', 'backup'];

const isUnrestrictedScopes = (scopes) => !scopes?.length || scopes.includes('*');

// Canonical token expiry stamp: 'YYYY-MM-DDTHH:MM:SSZ'. Accepts a Date, epoch
// ms, an ISO string or a legacy zone-less SQLite 'YYYY-MM-DD HH:MM:SS' (UTC).
export function utcStamp(value) {
  const text = typeof value === 'string' ? value.trim() : value;
  const normalised = typeof text === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const date = new Date(normalised);
  if (Number.isNaN(date.getTime())) throw unprocessable('Request validation failed', { expiresAt: ['must be a valid date'] });
  return `${date.toISOString().slice(0, 19)}Z`;
}
const SQL_UTC_STAMP = (modifier) => `strftime('%Y-%m-%dT%H:%M:%SZ', 'now'${modifier ? `, '${modifier}'` : ''})`;

export function roleOfStack(stack, inherited = 'any') {
  let role = inherited;
  for (const layer of stack || []) {
    if (layer.handle === requireRoot) role = 'root';
    else if (layer.handle === requireReseller && role !== 'root') role = 'reseller';
  }
  return role;
}

// Express 4 stores a mounted router's prefix only as a RegExp; this recovers the
// literal path (and parameter names) from the form path-to-regexp produces.
export function mountPathOf(layer) {
  if (layer.regexp?.fast_slash) return '';
  let src = layer.regexp?.source || '';
  src = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\$$/, '');
  let i = 0;
  src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys?.[i++]?.name ?? 'param'}`);
  return src.replace(/\\\//g, '/').replace(/\\\./g, '.');
}

export function collectRoutes(app) {
  const out = [];
  const walk = (stack, prefix, state) => {
    let { role, auth } = state;
    for (const layer of stack) {
      if (layer.handle === requireAuth) auth = true;
      else if (layer.handle === requireRoot) role = 'root';
      else if (layer.handle === requireReseller && role !== 'root') role = 'reseller';
      if (layer.route) {
        const routePath = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of routePath) {
          for (const method of Object.keys(layer.route.methods).filter((m) => layer.route.methods[m] && m !== '_all')) {
            const full = (prefix + (p === '/' ? '' : p)) || '/';
            out.push({ method: method.toUpperCase(), path: full, role: roleOfStack(layer.route.stack, role), auth: auth || roleOfStack(layer.route.stack, role) !== 'any' });
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPathOf(layer), { role, auth });
      }
    }
  };
  walk(app._router?.stack || [], '', { role: 'any', auth: false });
  const seen = new Set();
  return out.filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .filter((r) => r.path.startsWith('/api') && !/^\/api\/?$/.test(r.path) && !r.path.includes('*'))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

const METHOD_ORDER = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4 };

export function buildOpenApi(routes, { title, version, scope, hostname }) {
  const paths = {};
  const tags = new Set();
  for (const r of routes) {
    const oaPath = r.path.replace(/^\/api/, '').replace(/:([A-Za-z0-9_]+)\??/g, '{$1}') || '/';
    const params = [...oaPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
    const tag = oaPath.split('/')[1] || 'root';
    tags.add(tag);
    const op = {
      tags: [tag],
      summary: `${r.method} ${oaPath}`,
      operationId: `${r.method.toLowerCase()}${oaPath.replace(/\{([^}]+)\}/g, 'By-$1').split(/[^A-Za-z0-9]+/).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join('')}`,
      'x-whm-role': r.role,
      parameters: params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      responses: {
        200: { description: 'Success envelope', content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } },
        401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        403: { description: 'Forbidden (role, ownership, scope or CSRF)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        422: { description: 'Validation failed (error.fields lists each problem)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        501: { description: 'Required daemon is not installed on this server (error.capability)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
    if (r.method === 'GET' && /s$/.test(oaPath.split('/').pop() || '')) {
      op.parameters.push(...['page', 'pageSize', 'q', 'sort', 'dir'].map((name) => ({ name, in: 'query', required: false, schema: { type: name === 'page' || name === 'pageSize' ? 'integer' : 'string' }, description: 'List endpoints paginate with these when supported' })));
    }
    if (['POST', 'PUT', 'PATCH'].includes(r.method)) {
      op.requestBody = { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };
      op.responses[202] = { description: 'Accepted: long-running work queued as a job', content: { 'application/json': { schema: { $ref: '#/components/schemas/JobEnvelope' } } } };
    }
    if (r.auth) op.security = [{ sessionCookie: [], csrfToken: [] }, { bearerToken: [] }];
    (paths[oaPath] ||= {})[r.method.toLowerCase()] = op;
  }
  for (const p of Object.values(paths)) {
    const ordered = Object.fromEntries(Object.entries(p).sort((a, b) => (METHOD_ORDER[a[0].toUpperCase()] ?? 9) - (METHOD_ORDER[b[0].toUpperCase()] ?? 9)));
    Object.keys(p).forEach((k) => delete p[k]);
    Object.assign(p, ordered);
  }
  return {
    openapi: '3.0.3',
    info: {
      title, version,
      description: scope === 'cpanel'
        ? 'Account-scoped endpoints: everything a reseller or account principal may call for the accounts they own. Root-only server configuration is omitted; see the WHM reference for the full surface.'
        : 'Every HTTP endpoint mounted by this panel, generated from the live Express router. Responses use the { data, meta } / { error } envelope; mutations need the X-CSRF-Token header with a session, or a Bearer API token.',
      'x-generated-at': new Date().toISOString(),
      'x-host': hostname || null,
    },
    servers: [{ url: '/api', description: 'This panel' }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'whm.sid', description: 'Browser session from POST /auth/login' },
        csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'Required with the session cookie on POST/PUT/PATCH/DELETE' },
        bearerToken: { type: 'http', scheme: 'bearer', description: 'API token from Development > Manage API Tokens (CSRF exempt)' },
      },
      schemas: {
        Envelope: { type: 'object', properties: { data: {}, meta: { type: 'object', properties: { page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' } }, additionalProperties: true } }, required: ['data'] },
        JobEnvelope: { type: 'object', properties: { data: { type: 'object', properties: { job: { type: 'object', properties: { id: { type: 'integer' }, type: { type: 'string' }, status: { type: 'string' } } } } } } },
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } }, capability: { type: 'string' } }, required: ['code', 'message'] } }, required: ['error'] },
      },
    },
  };
}

// Minimal POSIX ustar writer so the plugin skeleton downloads as a .tar.gz with
// zero dependencies. Entries are { path, content, mode? }.
export function createTarGz(entries, { mtime = Math.floor(Date.now() / 1000) } = {}) {
  const blocks = [];
  const header = (name, size, type, mode) => {
    const buf = Buffer.alloc(512);
    const put = (str, offset, length) => buf.write(String(str).slice(0, length), offset, length, 'utf8');
    const octal = (n, offset, length) => put(n.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    let prefix = '';
    let base = name;
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/', 154);
      prefix = name.slice(0, cut); base = name.slice(cut + 1);
    }
    put(base, 0, 100); octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(mtime, 136, 12);
    put('        ', 148, 8); put(type, 156, 1); put('ustar\0', 257, 6); put('00', 263, 2); put('root', 265, 32); put('root', 297, 32); octal(0, 329, 8); octal(0, 337, 8); put(prefix, 345, 155);
    let sum = 0;
    for (const b of buf) sum += b;
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return buf;
  };
  const dirs = new Set();
  for (const e of entries) {
    const parts = e.path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/') + '/';
      if (!dirs.has(d)) { dirs.add(d); blocks.push(header(d, 0, '5', 0o755)); }
    }
    const data = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8');
    blocks.push(header(e.path, data.length, '0', e.mode ?? 0o644), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

export function parseAppConfig(text) {
  const out = { acls: [], features: [] };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-z_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'name') out.name = value.toLowerCase();
    else if (key === 'displayname') out.displayName = value;
    else if (key === 'url') out.url = value;
    else if (key === 'entryurl') out.entryUrl = value;
    else if (key === 'service') out.service = value.toLowerCase();
    else if (key === 'acls') out.acls.push(...value.split(/[\s,]+/).filter(Boolean));
    else if (key === 'features' || key === 'feature') out.features.push(...value.split(/[\s,]+/).filter(Boolean));
    else if (key === 'icon') out.icon = value;
    else if (key === 'description') out.description = value;
    else if (key === 'user') out.user = value;
    else if (key === 'phpconfig' || key === 'phpHandler') (out.phpopts ||= {})[key] = value;
  }
  if (!out.displayName && out.name) out.displayName = out.name;
  return out;
}

export function renderAppConfig(app) {
  const lines = [`# Generated by WHM panel (Apps Managed by AppConfig)`, `name=${app.name}`, `service=${app.service}`, `url=${app.url}`, `displayname=${app.displayName}`];
  if (app.entryUrl) lines.push(`entryurl=${app.entryUrl}`);
  if (app.acls.length) lines.push(`acls=${app.acls.join(',')}`);
  if (app.features.length) lines.push(`features=${app.features.join(',')}`);
  if (app.icon) lines.push(`icon=${app.icon}`);
  if (app.description) lines.push(`description=${app.description}`);
  return lines.join('\n') + '\n';
}

// Markdown section index: every "## " heading with a slug, so the UI can jump.
export function indexSections(text) {
  const sections = [];
  const lines = text.split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) return;
    const m = line.match(/^(##|###)\s+(.+?)\s*$/);
    if (!m) return;
    const title = m[2].replace(/[*`]/g, '');
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    sections.push({ level: m[1].length, title, slug, line: i + 1 });
  });
  return sections;
}

export function extractSection(text, slug) {
  const sections = indexSections(text);
  const idx = sections.findIndex((s) => s.slug === slug);
  if (idx < 0) return null;
  const start = sections[idx].line - 1;
  const next = sections.slice(idx + 1).find((s) => s.level <= sections[idx].level);
  const lines = text.split('\n');
  return lines.slice(start, next ? next.line - 1 : lines.length).join('\n').trim() + '\n';
}

export function createDevelopmentService(ctx) {
  const { db, agent, settings, crypto, logger } = ctx;
  let sdk = loadPluginSdk();

  const stmts = {
    tokenById: db.prepare('SELECT t.*, u.username, u.role FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ?'),
    tokenCountForUser: db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?'),
    insertToken: db.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at, prefix, description, created_ip) VALUES (@user_id, @name, @token_hash, @scopes, @expires_at, @prefix, @description, @created_ip)'),
    deleteToken: db.prepare('DELETE FROM api_tokens WHERE id = ?'),
    // expires_at is always 'YYYY-MM-DDTHH:MM:SSZ' (see utcStamp): the Bearer
    // authenticator parses it with new Date(), which treats a zone-less
    // 'YYYY-MM-DD HH:MM:SS' as local time, so the 'Z' is what makes expiry
    // correct on non-UTC hosts. SQL comparisons use the same shape lexically.
    deleteExpiredTokens: db.prepare(`DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < ${SQL_UTC_STAMP('-30 days')}`),
    // Backdated one second so strict '<' comparisons see it expired at once.
    expireToken: db.prepare(`UPDATE api_tokens SET expires_at = ${SQL_UTC_STAMP('-1 second')} WHERE id = ?`),
    renameToken: db.prepare('UPDATE api_tokens SET name = @name, description = @description WHERE id = @id'),
    tokenAudit: db.prepare('SELECT ts, action, target, result, ip FROM audit_log WHERE principal = ? AND ts >= ? ORDER BY id DESC LIMIT 25'),
    userByUsername: db.prepare('SELECT id, username, role FROM users WHERE username = ?'),
    hooks: db.prepare('SELECT * FROM hooks ORDER BY event, stage, position, id'),
    hookById: db.prepare('SELECT * FROM hooks WHERE id = ?'),
    hooksFor: db.prepare('SELECT * FROM hooks WHERE event = ? AND stage = ? AND enabled = 1 ORDER BY position, id'),
    insertHook: db.prepare('INSERT INTO hooks (event, stage, action, enabled, name, description, blocking, timeout_sec, position) VALUES (@event, @stage, @action, @enabled, @name, @description, @blocking, @timeout_sec, @position)'),
    updateHook: db.prepare('UPDATE hooks SET event = @event, stage = @stage, action = @action, enabled = @enabled, name = @name, description = @description, blocking = @blocking, timeout_sec = @timeout_sec, position = @position WHERE id = @id'),
    setHookEnabled: db.prepare('UPDATE hooks SET enabled = ? WHERE id = ?'),
    deleteHook: db.prepare('DELETE FROM hooks WHERE id = ?'),
    hookRan: db.prepare("UPDATE hooks SET last_run_at = datetime('now'), last_status = ?, run_count = run_count + 1, fail_count = fail_count + ? WHERE id = ?"),
    insertRun: db.prepare('INSERT INTO hook_runs (hook_id, hook_name, event, stage, trigger, status, exit_code, duration_ms, stdout, stderr, payload) VALUES (@hook_id, @hook_name, @event, @stage, @trigger, @status, @exit_code, @duration_ms, @stdout, @stderr, @payload)'),
    pruneRuns: db.prepare('DELETE FROM hook_runs WHERE id NOT IN (SELECT id FROM hook_runs ORDER BY id DESC LIMIT ?)'),
    runsLast24h: db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) AS failed FROM hook_runs WHERE created_at > datetime('now', '-1 day')"),
    hooksUsingScript: db.prepare('SELECT COUNT(*) AS n FROM hooks WHERE action = ?'),
    apps: db.prepare('SELECT * FROM appconfig_apps ORDER BY service, display_name'),
    appById: db.prepare('SELECT * FROM appconfig_apps WHERE id = ?'),
    appByName: db.prepare('SELECT * FROM appconfig_apps WHERE name = ?'),
    insertApp: db.prepare('INSERT INTO appconfig_apps (name, display_name, url, service, description, icon, acls_json, features_json, display, enabled, entry_url, phpopts_json) VALUES (@name, @display_name, @url, @service, @description, @icon, @acls_json, @features_json, @display, @enabled, @entry_url, @phpopts_json)'),
    updateApp: db.prepare("UPDATE appconfig_apps SET name = @name, display_name = @display_name, url = @url, service = @service, description = @description, icon = @icon, acls_json = @acls_json, features_json = @features_json, display = @display, enabled = @enabled, entry_url = @entry_url, phpopts_json = @phpopts_json, updated_at = datetime('now') WHERE id = @id"),
    deleteApp: db.prepare('DELETE FROM appconfig_apps WHERE id = ?'),
    resellerAcls: db.prepare('SELECT acl_key FROM reseller_acls WHERE reseller_id = ? AND value = 1'),
    counts: {
      tokens: db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < ${SQL_UTC_STAMP()} THEN 1 ELSE 0 END) AS expired FROM api_tokens`),
      hooks: db.prepare('SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM hooks'),
      apps: db.prepare('SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM appconfig_apps'),
    },
  };

  const isRoot = (user) => user?.role === 'root';
  const events = () => ctx.events;
  const eventCatalog = () => (sdk?.EVENTS ? sdk.EVENTS : FALLBACK_EVENTS);

  // --- API tokens -------------------------------------------------------------
  function shapeToken(row) {
    if (!row) return null;
    const expired = Boolean(row.expires_at) && new Date(utcStamp(row.expires_at)) < new Date();
    return {
      id: row.id, userId: row.user_id, username: row.username, role: row.role, name: row.name, description: row.description, prefix: row.prefix,
      scopes: json.parse(row.scopes, []), expiresAt: row.expires_at, expired, lastUsedAt: row.last_used_at, createdAt: row.created_at, createdIp: row.created_ip,
    };
  }

  function loadToken(id, user) {
    const row = stmts.tokenById.get(id);
    if (!row) throw notFound(`API token ${id}`);
    if (!isRoot(user) && row.user_id !== user.id) throw forbidden('You can only manage your own API tokens');
    return row;
  }

  const tokens = {
    scopes: () => ({
      wildcard: '*', scopes: ENFORCED_SCOPES, enforcedPrefix: '/api/development', unrestrictedAreas: UNRESTRICTED_AREAS,
      note: 'Scopes only restrict the Development API (/api/development). Every other area is not scope-aware yet: there a token always acts with its user\'s full role, whatever scopes it carries. A token without scopes inherits the full role everywhere. To limit what a token can reach outside Development, issue it for a user with a narrower role.',
    }),
    list(query, user) {
      const where = [];
      const params = {};
      if (!isRoot(user)) { where.push('t.user_id = @userId'); params.userId = user.id; }
      if (query.q) { where.push('(t.name LIKE @q OR u.username LIKE @q OR t.prefix LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.user && isRoot(user)) { where.push('u.username = @user'); params.user = query.user; }
      const page = paginate(db, {
        select: 't.*, u.username, u.role', from: 'api_tokens t JOIN users u ON u.id = t.user_id', where, params, query,
        sortable: { name: 't.name', created_at: 't.created_at', last_used_at: 't.last_used_at', expires_at: 't.expires_at', username: 'u.username' }, defaultSort: 'created_at',
      });
      return { data: page.data.map(shapeToken), meta: page.meta };
    },
    get(id, user) { return shapeToken(loadToken(id, user)); },
    async create(input, user, req) {
      const scopes = [...new Set(input.scopes || [])];
      const unenforced = scopes.filter((s) => !ENFORCED_SCOPES.includes(s));
      if (unenforced.length) throw unprocessable('Request validation failed', { scopes: [`Only scopes the panel enforces can be granted (${ENFORCED_SCOPES.join(', ')}); rejected: ${unenforced.join(', ')}`] });
      // A request authenticated by a token may not mint anything the issuing
      // token could not do itself: same user, a subset of its scopes, no later expiry.
      const issuer = req?.auth?.via === 'token' && req.auth.tokenId ? stmts.tokenById.get(req.auth.tokenId) : null;
      if (issuer && input.username && input.username !== user.username) throw forbidden('An API token can only issue tokens for its own user');
      let owner = user;
      if (input.username && input.username !== user.username) {
        if (!isRoot(user)) throw forbidden('Only root can issue tokens for other users');
        owner = stmts.userByUsername.get(input.username);
        if (!owner) throw notFound(`User "${input.username}"`);
      }
      let expiresAt = null;
      if (input.expiresAt) expiresAt = utcStamp(input.expiresAt);
      else if (input.expiresInDays) expiresAt = utcStamp(Date.now() + input.expiresInDays * 86_400_000);
      if (issuer) {
        const issuerScopes = json.parse(issuer.scopes, []);
        if (!isUnrestrictedScopes(issuerScopes)) {
          if (isUnrestrictedScopes(scopes)) throw forbidden(`This API token is limited to ${issuerScopes.join(', ')} and cannot issue a token with unrestricted access`);
          const extra = scopes.filter((s) => !issuerScopes.includes(s));
          if (extra.length) throw forbidden(`This API token cannot grant scopes it does not hold: ${extra.join(', ')}`);
        }
        if (issuer.expires_at) {
          const issuerExpiry = utcStamp(issuer.expires_at);
          if (!expiresAt || expiresAt > issuerExpiry) expiresAt = issuerExpiry;
        }
      }
      const max = settings.get('development.tokens.max_per_user') ?? 50;
      if (stmts.tokenCountForUser.get(owner.id).n >= max) throw conflict(`This user already has ${max} API tokens; revoke one first`);
      const secret = `whm_${crypto.randomToken(32)}`;
      const { lastInsertRowid } = stmts.insertToken.run({
        user_id: owner.id, name: input.name, token_hash: crypto.hashToken(secret), scopes: JSON.stringify(scopes), expires_at: expiresAt,
        prefix: secret.slice(0, 12), description: input.description || null, created_ip: req?.ip || null,
      });
      req?.audit?.({ action: 'development.token.create', target: `${owner.username}/${input.name}`, args: { scopes, expiresAt, issuedBy: issuer ? `api-token#${issuer.id}` : 'session' } });
      // The secret is returned exactly once; only its SHA-256 is stored.
      return { ...shapeToken(stmts.tokenById.get(lastInsertRowid)), token: secret };
    },
    update(id, input, user, req) {
      const row = loadToken(id, user);
      stmts.renameToken.run({ id, name: input.name ?? row.name, description: input.description === undefined ? row.description : input.description });
      req?.audit?.({ action: 'development.token.update', target: `${row.username}/${row.name}`, args: input });
      return shapeToken(stmts.tokenById.get(id));
    },
    revoke(id, user, req) {
      const row = loadToken(id, user);
      stmts.deleteToken.run(id);
      req?.audit?.({ action: 'development.token.revoke', target: `${row.username}/${row.name}`, args: { id, prefix: row.prefix } });
      return { id, revoked: true, name: row.name };
    },
    expireNow(id, user, req) {
      const row = loadToken(id, user);
      stmts.expireToken.run(id);
      req?.audit?.({ action: 'development.token.expire', target: `${row.username}/${row.name}`, args: { id } });
      return shapeToken(stmts.tokenById.get(id));
    },
    usage(id, user) {
      const row = loadToken(id, user);
      const t = shapeToken(row);
      const activity = stmts.tokenAudit.all(row.username, row.created_at);
      return { token: t, activity, note: 'The panel records when a token last authenticated. Activity lists this user\'s audited actions since the token was issued (session and token use are not distinguished).' };
    },
    cleanup() { return { removedExpired: stmts.deleteExpiredTokens.run().changes }; },
  };

  // --- Hooks -----------------------------------------------------------------
  function shapeHook(row) {
    if (!row) return null;
    const cat = eventCatalog()[row.event];
    return {
      id: row.id, name: row.name || row.action, description: row.description, event: row.event, stage: row.stage, script: row.action, enabled: Boolean(row.enabled),
      blocking: Boolean(row.blocking), timeoutSec: row.timeout_sec, position: row.position, lastRunAt: row.last_run_at, lastStatus: row.last_status, runCount: row.run_count, failCount: row.fail_count,
      createdAt: row.created_at, known: Boolean(cat), cancellable: Boolean(cat?.cancellable) && row.stage === 'pre',
    };
  }

  function validateHookInput(input) {
    const cat = eventCatalog()[input.event];
    if (cat && !cat.stages.includes(input.stage)) throw unprocessable('Request validation failed', { stage: [`Event "${input.event}" only fires at: ${cat.stages.join(', ')}`] });
  }

  function recordRun(hook, envelope, trigger, run) {
    try {
      stmts.insertRun.run({
        hook_id: hook.id ?? null, hook_name: hook.name || hook.action, event: envelope.event, stage: envelope.stage, trigger, status: run.status,
        exit_code: run.exitCode ?? null, duration_ms: run.durationMs ?? null, stdout: (run.stdout || '').slice(-8000) || null, stderr: (run.stderr || '').slice(-4000) || null,
        payload: JSON.stringify(envelope).slice(0, 8000),
      });
      if (hook.id) stmts.hookRan.run(run.status, run.status === 'ok' ? 0 : 1, hook.id);
      stmts.pruneRuns.run(settings.get('development.hooks.keep_runs') ?? 500);
    } catch (err) { logger.error({ err }, 'could not record hook run'); }
  }

  async function runHook(hook, envelope, trigger) {
    const started = Date.now();
    let run;
    try {
      const res = await agent.op('hook.run', { name: hook.action, event: envelope.event, stage: envelope.stage, payload: JSON.stringify(envelope), timeoutMs: (hook.timeout_sec || 30) * 1000 });
      run = { status: res.ok === false ? 'failed' : 'ok', exitCode: res.exitCode ?? 0, durationMs: res.durationMs ?? Date.now() - started, stdout: res.stdout || '', stderr: res.stderr || '' };
    } catch (err) {
      if (err?.agentError && err.code === 'unknown_op') {
        if (trigger === 'test') throw new CapabilityError('whm-agentd', 'The agent daemon on this server does not provide the hook.run operation; upgrade whm-agentd to run hooks');
        run = { status: 'error', exitCode: null, durationMs: Date.now() - started, stdout: '', stderr: 'agent does not support hook.run' };
      } else {
        run = { status: 'error', exitCode: null, durationMs: Date.now() - started, stdout: '', stderr: err.message };
      }
      logger.warn({ hook: hook.action, event: envelope.event, err: err.message }, 'hook could not run');
    }
    recordRun(hook, envelope, trigger, run);
    return { hook: hook.name || hook.action, script: hook.action, ...run };
  }

  async function dispatch(envelope) {
    if (settings.get('development.hooks.enabled') === false) return { skipped: 'hooks disabled' };
    const rows = stmts.hooksFor.all(envelope.event, envelope.stage);
    const results = [];
    for (const hook of rows) {
      const r = await runHook(hook, envelope, 'event');
      results.push(r);
      // Only an explicit non-zero exit vetoes: a script that cannot run must not lock operators out.
      if (envelope.stage === 'pre' && hook.blocking && r.status === 'failed') {
        const reason = (r.stderr || r.stdout || '').trim().split('\n').pop() || `exit status ${r.exitCode}`;
        throw new HttpError(409, 'hook_rejected', `Hook "${hook.name || hook.action}" rejected ${envelope.event}: ${reason}`);
      }
    }
    return results;
  }

  const hooks = {
    dispatch,
    events: () => Object.entries(eventCatalog()).map(([name, def]) => ({ name, stages: def.stages, cancellable: Boolean(def.cancellable), payload: def.payload, custom: false })),
    list() { return stmts.hooks.all().map(shapeHook); },
    get(id) {
      const row = stmts.hookById.get(id);
      if (!row) throw notFound(`Hook ${id}`);
      return shapeHook(row);
    },
    create(input, req) {
      validateHookInput(input);
      const { lastInsertRowid } = stmts.insertHook.run({
        event: input.event, stage: input.stage, action: input.script, enabled: input.enabled === false ? 0 : 1, name: input.name || input.script, description: input.description || null,
        blocking: input.blocking === false ? 0 : 1, timeout_sec: input.timeoutSec ?? settings.get('development.hooks.default_timeout_sec') ?? 30, position: input.position ?? 0,
      });
      req?.audit?.({ action: 'development.hook.create', target: `${input.event}:${input.stage}`, args: input });
      return shapeHook(stmts.hookById.get(lastInsertRowid));
    },
    update(id, input, req) {
      const row = stmts.hookById.get(id);
      if (!row) throw notFound(`Hook ${id}`);
      const merged = {
        id, event: input.event ?? row.event, stage: input.stage ?? row.stage, action: input.script ?? row.action, enabled: input.enabled == null ? row.enabled : input.enabled ? 1 : 0,
        name: input.name ?? row.name, description: input.description === undefined ? row.description : input.description, blocking: input.blocking == null ? row.blocking : input.blocking ? 1 : 0,
        timeout_sec: input.timeoutSec ?? row.timeout_sec, position: input.position ?? row.position,
      };
      validateHookInput(merged);
      stmts.updateHook.run(merged);
      req?.audit?.({ action: 'development.hook.update', target: String(id), args: input });
      return shapeHook(stmts.hookById.get(id));
    },
    setEnabled(id, enabled, req) {
      if (!stmts.hookById.get(id)) throw notFound(`Hook ${id}`);
      stmts.setHookEnabled.run(enabled ? 1 : 0, id);
      req?.audit?.({ action: enabled ? 'development.hook.enable' : 'development.hook.disable', target: String(id) });
      return shapeHook(stmts.hookById.get(id));
    },
    remove(id, req) {
      const row = stmts.hookById.get(id);
      if (!row) throw notFound(`Hook ${id}`);
      stmts.deleteHook.run(id);
      req?.audit?.({ action: 'development.hook.delete', target: `${row.event}:${row.stage}`, args: { script: row.action } });
      return { id, deleted: true };
    },
    async test(id, payload, req) {
      const row = stmts.hookById.get(id);
      if (!row) throw notFound(`Hook ${id}`);
      const def = eventCatalog()[row.event];
      const envelope = { event: row.event, stage: row.stage, payload: payload ?? { sample: true, shape: def?.payload ?? null }, at: new Date().toISOString(), principal: req?.user?.username ?? null, role: req?.user?.role ?? null, ip: req?.ip ?? null, test: true };
      const result = await runHook(row, envelope, 'test');
      req?.audit?.({ action: 'development.hook.test', target: row.action, args: { event: row.event } });
      return result;
    },
    async emit(event, stage, payload, req) {
      const def = eventCatalog()[event];
      if (def && !def.stages.includes(stage)) throw unprocessable('Request validation failed', { stage: [`Event "${event}" only fires at: ${def.stages.join(', ')}`] });
      const result = await events().emit(event, payload, { stage, req });
      req?.audit?.({ action: 'development.event.emit', target: `${event}:${stage}` });
      return result;
    },
    runs(query) {
      const where = [];
      const params = {};
      if (query.hookId) { where.push('hook_id = @hookId'); params.hookId = query.hookId; }
      if (query.event) { where.push('event = @event'); params.event = query.event; }
      if (query.status) { where.push('status = @status'); params.status = query.status; }
      // Newest first unless the caller sorts explicitly (the pagination schema defaults dir to asc).
      return paginate(db, { select: 'id, hook_id AS hookId, hook_name AS hookName, event, stage, trigger, status, exit_code AS exitCode, duration_ms AS durationMs, stdout, stderr, created_at AS createdAt', from: 'hook_runs', where, params, query: { ...query, dir: query.sort ? query.dir : 'desc' }, sortable: { created_at: 'id', id: 'id' }, defaultSort: 'created_at' });
    },
    settings: () => ({ enabled: settings.get('development.hooks.enabled') !== false, defaultTimeoutSec: settings.get('development.hooks.default_timeout_sec') ?? 30, keepRuns: settings.get('development.hooks.keep_runs') ?? 500, dir: HOOKS_DIR }),
    updateSettings(input, req) {
      if (input.enabled != null) settings.set('development.hooks.enabled', input.enabled);
      if (input.defaultTimeoutSec != null) settings.set('development.hooks.default_timeout_sec', input.defaultTimeoutSec);
      if (input.keepRuns != null) settings.set('development.hooks.keep_runs', input.keepRuns);
      req?.audit?.({ action: 'development.hooks.settings', args: input });
      return hooks.settings();
    },
    recentEvents: () => events()?.recent ?? [],
    scripts: {
      async list() {
        try {
          const res = await agent.op('hook.list');
          return { dir: HOOKS_DIR, exists: res.exists !== false, scripts: (res.scripts || []).map((s) => ({ ...s, hooks: stmts.hooksUsingScript.get(s.name).n })) };
        } catch (err) {
          if (err?.agentError && err.code === 'unknown_op') throw new CapabilityError('whm-agentd', 'The agent daemon on this server does not provide hook operations; upgrade whm-agentd');
          throw err;
        }
      },
      async init(req) {
        await agent.op('fs.mkdir', { path: HOOKS_DIR, owner: 'root', mode: '0755' }, { req });
        req?.audit?.({ action: 'development.hooks.dir.create', target: HOOKS_DIR });
        return { dir: HOOKS_DIR, created: true };
      },
      async read(name) {
        const res = await agent.op('fs.read_file', { path: `${HOOKS_DIR}/${name}`, maxBytes: 1024 * 1024 });
        return { name, path: res.path, content: res.content, size: res.size, hooks: stmts.hooksUsingScript.get(name).n };
      },
      async write(name, content, req) {
        if (!content.startsWith('#!')) throw unprocessable('Request validation failed', { content: ['A hook script must start with a #! interpreter line (for example #!/bin/sh)'] });
        const res = await agent.op('fs.write_file', { path: `${HOOKS_DIR}/${name}`, content, owner: 'root', mode: '0700', backup: true }, { req });
        req?.audit?.({ action: 'development.hooks.script.write', target: name, args: { bytes: res.bytes } });
        return { name, path: res.path, bytes: res.bytes };
      },
      async remove(name, req) {
        await agent.op('fs.remove', { path: `${HOOKS_DIR}/${name}` }, { req });
        req?.audit?.({ action: 'development.hooks.script.delete', target: name });
        return { name, deleted: true, hooksReferencing: stmts.hooksUsingScript.get(name).n };
      },
    },
  };

  // --- AppConfig ---------------------------------------------------------------
  function shapeApp(row) {
    if (!row) return null;
    return {
      id: row.id, name: row.name, displayName: row.display_name, url: row.url, entryUrl: row.entry_url, service: row.service, description: row.description, icon: row.icon,
      acls: json.parse(row.acls_json, []), features: json.parse(row.features_json, []), display: Boolean(row.display), enabled: Boolean(row.enabled), phpopts: json.parse(row.phpopts_json, {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  function appRecord(input, existing = {}) {
    const acls = input.acls ?? existing.acls ?? ['all'];
    return {
      id: existing.id, name: input.name ?? existing.name, display_name: input.displayName ?? existing.displayName ?? input.name, url: input.url ?? existing.url, entry_url: input.entryUrl === undefined ? existing.entryUrl ?? null : input.entryUrl,
      service: input.service ?? existing.service ?? 'whm', description: input.description === undefined ? existing.description ?? null : input.description, icon: input.icon === undefined ? existing.icon ?? null : input.icon,
      acls_json: JSON.stringify([...new Set(acls)]), features_json: JSON.stringify([...new Set(input.features ?? existing.features ?? [])]),
      display: (input.display ?? existing.display ?? true) ? 1 : 0, enabled: (input.enabled ?? existing.enabled ?? true) ? 1 : 0, phpopts_json: JSON.stringify(input.phpopts ?? existing.phpopts ?? {}),
    };
  }

  const appconfig = {
    acls: () => KNOWN_ACLS,
    list() { return stmts.apps.all().map(shapeApp); },
    get(id) {
      const row = stmts.appById.get(id);
      if (!row) throw notFound(`AppConfig app ${id}`);
      return shapeApp(row);
    },
    create(input, req) {
      if (stmts.appByName.get(input.name)) throw conflict(`An app named "${input.name}" is already registered`);
      const { lastInsertRowid } = stmts.insertApp.run(appRecord(input));
      req?.audit?.({ action: 'development.appconfig.register', target: input.name, args: input });
      return shapeApp(stmts.appById.get(lastInsertRowid));
    },
    update(id, input, req) {
      const existing = appconfig.get(id);
      if (input.name && input.name !== existing.name && stmts.appByName.get(input.name)) throw conflict(`An app named "${input.name}" is already registered`);
      stmts.updateApp.run(appRecord(input, existing));
      req?.audit?.({ action: 'development.appconfig.update', target: existing.name, args: input });
      return shapeApp(stmts.appById.get(id));
    },
    remove(id, req) {
      const existing = appconfig.get(id);
      stmts.deleteApp.run(id);
      req?.audit?.({ action: 'development.appconfig.unregister', target: existing.name });
      return { id, deleted: true, name: existing.name };
    },
    parse: (text) => parseAppConfig(text),
    export(id) { const app = appconfig.get(id); return { name: app.name, filename: `${app.name}.conf`, content: renderAppConfig(app) }; },
    // Apps a principal may launch: root sees everything; a reseller needs every
    // listed ACL (or "all"); account users only see cpanel/webmail apps.
    listFor(user, service) {
      const granted = isRoot(user) ? null : new Set(user?.role === 'reseller' ? stmts.resellerAcls.all(user.id).map((r) => r.acl_key) : []);
      return appconfig.list().filter((a) => a.enabled && a.display && (!service || a.service === service)).filter((a) => {
        if (isRoot(user)) return true;
        if (a.service === 'whm' && user?.role !== 'reseller') return false;
        if (a.acls.includes('all') && a.service !== 'whm') return true;
        if (a.acls.includes('all')) return user?.role === 'reseller';
        return a.acls.every((acl) => granted.has(acl));
      });
    },
  };

  // --- Plugin generator ----------------------------------------------------------
  function requireSdk() {
    if (!sdk) throw new CapabilityError('plugin-sdk', 'The plugin SDK (plugins/sdk) is not installed with this panel, so plugin skeletons cannot be validated or generated');
    return sdk;
  }

  function buildManifest(input) {
    const permissions = [...new Set(input.permissions || [])];
    const hooksList = (input.hooks || []).map((h) => ({ event: h.event, stage: h.stage || 'post', handler: `on${h.event.split('.').map((p) => p[0].toUpperCase() + p.slice(1)).join('')}${h.stage === 'pre' ? 'Pre' : ''}` }));
    const manifest = {
      $schema: 'https://whm.local/plugins/sdk/manifest.schema.json',
      id: input.id, name: input.name, version: input.version || '1.0.0', description: input.description, author: { name: input.authorName, ...(input.authorEmail ? { email: input.authorEmail } : {}), ...(input.authorUrl ? { url: input.authorUrl } : {}) },
      license: input.license || 'MIT', ...(input.homepage ? { homepage: input.homepage } : {}), engines: { whm: `>=${ctx.version || '0.1.0'}`, node: '>=22' }, main: 'index.js', permissions,
    };
    if (hooksList.length) manifest.hooks = hooksList;
    if (input.withSettings) {
      manifest.settings = { fields: [
        { key: 'greeting', type: 'text', label: 'Greeting', help: 'Shown on the plugin page', default: 'Hello from your plugin', maxLength: 80 },
        { key: 'notify', type: 'toggle', label: 'Send notifications', default: false },
      ] };
      if (!permissions.includes('settings:own')) manifest.permissions.push('settings:own');
    }
    if (input.withJob) {
      manifest.jobs = { housekeeping: { label: 'Housekeeping', description: 'Example background job', timeoutSec: 600, cancellable: true } };
      manifest.cron = [{ name: 'nightly', job: 'housekeeping', schedule: '0 3 * * *', enabled: true }];
      for (const p of ['jobs', 'schedule']) if (!manifest.permissions.includes(p)) manifest.permissions.push(p);
    }
    if (input.withPage) {
      manifest.ui = {
        pages: [{ route: '/', title: input.name, kind: 'markdown', icon: 'puzzle', content: `# ${input.name}\n\n${input.description}` }],
        sidebar: [{ category: input.category || 'Plugins', label: input.name, route: '/', icon: 'puzzle' }],
      };
      if (!manifest.permissions.includes('ui:sidebar')) manifest.permissions.push('ui:sidebar');
    }
    if (input.isolation) manifest.isolation = input.isolation;
    if (input.keywords?.length) manifest.keywords = input.keywords;
    return manifest;
  }

  function renderIndexJs(manifest) {
    const hookFns = (manifest.hooks || []).map((h) => `  ${h.handler}: async (evt, ctx) => {\n    ctx.log.info({ payload: evt.payload }, '${h.event} (${h.stage})');${h.stage === 'pre' ? `\n    // return evt.cancel('reason') to veto the operation (requires the cancel scope)` : ''}\n  },`).join('\n');
    return `'use strict';

// ${manifest.name} — generated by WHM > Development > cPanel Plugin File Generator.
// The host loads this file, calls activate(ctx) once the plugin is enabled and
// deactivate() before it is disabled or upgraded. ctx exposes exactly what the
// permissions in plugin.json grant: ctx.api, ctx.settings, ctx.store, ctx.jobs,
// ctx.schedule, ctx.events, ctx.ui, ctx.http, ctx.log, ctx.crypto, ctx.fs.

module.exports = {
  async activate(ctx) {
    ctx.log.info('${manifest.id} v${manifest.version} activated');${manifest.settings ? `
    const greeting = await ctx.settings.get('greeting');
    ctx.log.info({ greeting }, 'settings loaded');` : ''}
  },

  async deactivate(ctx) {
    ctx.log.info('${manifest.id} deactivated');
  },
${manifest.jobs ? `
  jobs: {
    housekeeping: async (job, ctx) => {
      job.progress(10, 'starting');
      // Do the work here; call job.log() for the live log and check job.cancelled.
      job.progress(100, 'done');
      return { ok: true };
    },
  },
` : ''}
  hooks: {
${hookFns || '    // Add { event, handler } entries to plugin.json and export the handlers here.'}
  },
};
`;
  }

  function renderReadme(manifest, s) {
    const perms = manifest.permissions.map((p) => `- \`${p}\` — ${s.PERMISSIONS?.[p] || 'parameterised scope'}`).join('\n') || '- none';
    const hookList = (manifest.hooks || []).map((h) => `- \`${h.event}\` (${h.stage}) → \`hooks.${h.handler}\``).join('\n') || '- none';
    return `# ${manifest.name}

${manifest.description}

| | |
|---|---|
| Plugin id | \`${manifest.id}\` |
| Version | ${manifest.version} |
| Requires WHM | ${manifest.engines.whm} |
| License | ${manifest.license} |

## Layout

- \`plugin.json\` — the manifest. Validate it with \`node -e "console.log(require('whm/plugins/sdk').validateManifest(require('./plugin.json')))"\`.
- \`index.js\` — entry point exporting \`activate\`, \`deactivate\`, \`hooks\`${manifest.jobs ? ', `jobs`' : ''}.
- \`README.md\` — this file.

## Permissions requested

${perms}

## Hooks

${hookList}

## Developing

1. Edit \`index.js\`; use \`createMockHost({ manifest })\` from the SDK to exercise it without a panel.
2. Package: \`tar -czf ${manifest.id}-${manifest.version}.tar.gz ${manifest.id}/\`.
3. Install from WHM > Plugins (or upload to the marketplace once verified).

Generated by WHM > Development > cPanel Plugin File Generator (SDK ${s.version || 'bundled'}).
`;
  }

  const pluginGen = {
    useSdk(value) { sdk = value === undefined ? loadPluginSdk() : value; return Boolean(sdk); },
    available: () => Boolean(sdk),
    vocabulary() {
      const s = requireSdk();
      return {
        sdkVersion: s.version, categories: s.CATEGORIES, permissions: Object.entries(s.PERMISSIONS).map(([scope, description]) => ({ scope, description })),
        permissionPatterns: Object.keys(s.PERMISSION_PATTERNS || {}), events: Object.entries(s.EVENTS).map(([name, def]) => ({ name, stages: def.stages, cancellable: def.cancellable, payload: def.payload })),
        settingTypes: s.SETTING_TYPES, pageKinds: s.PAGE_KINDS, isolationModes: s.ISOLATION_MODES, idPattern: String(s.ID_PATTERN),
      };
    },
    preview(input) {
      const s = requireSdk();
      const manifest = buildManifest(input);
      const validation = s.validateManifest(manifest);
      const files = [
        { path: 'plugin.json', content: JSON.stringify(manifest, null, 2) + '\n' },
        { path: 'index.js', content: renderIndexJs(manifest) },
        { path: 'README.md', content: renderReadme(manifest, s) },
        { path: '.gitignore', content: 'node_modules/\n*.tar.gz\n' },
      ];
      return { manifest, validation, files, dirname: manifest.id };
    },
    generate(input, req) {
      const preview = pluginGen.preview(input);
      if (!preview.validation.ok) throw unprocessable('The generated manifest does not validate', Object.fromEntries(preview.validation.errors.map((e) => [e.path || '_', [`${e.code}: ${e.message}`]])));
      const tar = createTarGz(preview.files.map((f) => ({ path: `${preview.dirname}/${f.path}`, content: f.content })));
      req?.audit?.({ action: 'development.plugin.generate', target: preview.manifest.id, args: { version: preview.manifest.version, permissions: preview.manifest.permissions } });
      return { filename: `${preview.manifest.id}-${preview.manifest.version}.tar.gz`, contentType: 'application/gzip', size: tar.length, base64: tar.toString('base64'), files: preview.files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content) })), manifest: preview.manifest, validation: preview.validation };
    },
    validate(manifest) { return requireSdk().validateManifest(manifest); },
  };

  // --- OpenAPI -------------------------------------------------------------------
  const openapi = {
    collect() {
      if (!ctx.app) throw new HttpError(503, 'not_ready', 'The HTTP router is not mounted yet');
      return collectRoutes(ctx.app);
    },
    routesFor(scope) {
      const all = openapi.collect();
      return scope === 'cpanel' ? all.filter((r) => r.role !== 'root' && !r.path.startsWith('/api/health')) : all;
    },
    spec(scope = 'whm') {
      const routes = openapi.routesFor(scope);
      return buildOpenApi(routes, { title: scope === 'cpanel' ? 'cPanel (account) API' : 'WHM API', version: ctx.version || '0.0.0', scope, hostname: settings.get('basic.hostname') });
    },
    endpoints(scope = 'whm') {
      const routes = openapi.routesFor(scope);
      const groups = new Map();
      for (const r of routes) {
        const prefix = `/${r.path.replace(/^\/api\/?/, '').split('/')[0] || ''}`;
        if (!groups.has(prefix)) groups.set(prefix, { prefix, endpoints: [] });
        groups.get(prefix).endpoints.push(r);
      }
      const list = [...groups.values()].map((g) => ({ ...g, count: g.endpoints.length, roles: { root: g.endpoints.filter((e) => e.role === 'root').length, reseller: g.endpoints.filter((e) => e.role === 'reseller').length, any: g.endpoints.filter((e) => e.role === 'any').length } }));
      return { scope, total: routes.length, groups: list, byMethod: routes.reduce((acc, r) => { acc[r.method] = (acc[r.method] || 0) + 1; return acc; }, {}) };
    },
  };

  // --- Developer documentation ---------------------------------------------------
  const DOCS = [
    { slug: 'blueprint', title: 'Blueprint (design of record)', file: 'BLUEPRINT.md', summary: 'Architecture, data model, security model, agent op families, every function, roadmap.' },
    { slug: 'readme', title: 'README', file: 'README.md', summary: 'Installing, running and operating the panel.' },
    { slug: 'category-modules', title: 'Category route modules', file: 'server/src/routes/categories/README.md', summary: 'How a sidebar category plugs its routes and services into the API.' },
    { slug: 'function-pages', title: 'Function pages', file: 'client/src/pages/fn/README.md', summary: 'How React pages are auto-registered from nav.js.' },
    { slug: 'license-server', title: 'License server design', file: 'docs/design/license-server.md', summary: 'Deferred design for licensing and the plugin marketplace.' },
    { slug: 'plugin-manifest-schema', title: 'Plugin manifest schema', file: 'plugins/sdk/manifest.schema.json', summary: 'JSON Schema for plugin.json.', type: 'json' },
  ];

  const docs = {
    list() {
      return DOCS.map((d) => {
        const file = path.join(REPO_ROOT, d.file);
        let stat = null;
        try { stat = fs.statSync(file); } catch { /* not shipped with this install */ }
        const text = stat && d.type !== 'json' ? fs.readFileSync(file, 'utf8') : null;
        return { slug: d.slug, title: d.title, file: d.file, summary: d.summary, type: d.type || 'markdown', available: Boolean(stat), size: stat?.size ?? null, updatedAt: stat?.mtime?.toISOString() ?? null, sections: text ? indexSections(text).filter((s) => s.level === 2).length : 0 };
      });
    },
    get(slug, section) {
      const d = DOCS.find((x) => x.slug === slug);
      if (!d) throw notFound(`Document "${slug}"`);
      const file = path.join(REPO_ROOT, d.file);
      if (!fs.existsSync(file)) throw notFound(`Document "${slug}" is not shipped with this install (${d.file})`);
      const text = fs.readFileSync(file, 'utf8');
      const sections = d.type === 'json' ? [] : indexSections(text);
      if (section) {
        const content = extractSection(text, section);
        if (content == null) throw notFound(`Section "${section}" in ${d.file}`);
        return { slug, title: d.title, file: d.file, type: d.type || 'markdown', section, content, sections };
      }
      return { slug, title: d.title, file: d.file, type: d.type || 'markdown', content: text, sections };
    },
  };

  // --- Overview ----------------------------------------------------------------------
  async function overview() {
    const tokensRow = stmts.counts.tokens.get();
    const hooksRow = stmts.counts.hooks.get();
    const appsRow = stmts.counts.apps.get();
    const runs = stmts.runsLast24h.get();
    let scripts = null;
    try { scripts = await hooks.scripts.list(); } catch (err) { scripts = { error: err.message, code: err.code }; }
    let endpoints = 0;
    try { endpoints = openapi.collect().length; } catch { /* router not mounted */ }
    return {
      panel: { version: ctx.version, mode: ctx.config.mode, node: process.version },
      tokens: { total: tokensRow.total, expired: tokensRow.expired || 0 },
      hooks: { total: hooksRow.total, enabled: hooksRow.enabled || 0, runs24h: runs.n, failed24h: runs.failed || 0, enabledGlobally: settings.get('development.hooks.enabled') !== false, dir: HOOKS_DIR, scripts },
      apps: { total: appsRow.total, enabled: appsRow.enabled || 0 },
      api: { endpoints, specUrl: '/api/development/openapi.json' },
      events: { catalog: Object.keys(eventCatalog()).length, listeners: ctx.events ? ctx.events.anyListeners.size + ctx.events.eventNames().reduce((n, e) => n + ctx.events.listenerCount(e), 0) : 0, recent: hooks.recentEvents().slice(0, 10) },
      sdk: { available: Boolean(sdk), version: sdk?.version ?? null, path: sdk?.path ?? null },
      docs: docs.list().filter((d) => d.available).length,
    };
  }

  return {
    tokens, hooks, appconfig, pluginGen, openapi, docs, overview,
    jobs: {
      'development.maintenance': async (job) => {
        const removed = tokens.cleanup();
        stmts.pruneRuns.run(settings.get('development.hooks.keep_runs') ?? 500);
        job.log(`removed ${removed.removedExpired} API token(s) expired for more than 30 days; pruned hook runs`);
        return removed;
      },
    },
  };
}

// Wires the core services that exist at boot into the event bus so Manage Hooks
// fires for real operations without those services knowing about hooks.
export function wireCoreEvents(ctx) {
  const { events } = ctx;
  if (!events || events.wired) return;
  events.wired = true;
  const wrap = (target, method, pre, post) => {
    const original = target?.[method];
    if (typeof original !== 'function') return;
    target[method] = async function wrapped(...args) {
      const req = args.find((a) => a && typeof a === 'object' && 'user' in a && 'ip' in a && typeof a.get === 'function') || null;
      const payload = pre(...args);
      if (payload) await events.emit(payload.event, payload.payload, { stage: 'pre', req });
      const result = await original.apply(this, args);
      const after = post ? post(result, ...args) : payload;
      if (after) events.emit(after.event, after.payload, { stage: 'post', req }).catch(() => {});
      return result;
    };
  };
  const accounts = ctx.accounts;
  wrap(accounts, 'create', (input, user) => ({ event: 'account.created', payload: { username: input.username, domain: input.domain, owner: input.owner || user?.username || null, package: input.package || null, ip: input.ip || null, contactEmail: input.contactEmail || input.email || null } }));
  wrap(accounts, 'suspend', (username, reason) => ({ event: 'account.suspended', payload: { username, reason: reason || null } }));
  wrap(accounts, 'unsuspend', (username) => ({ event: 'account.unsuspended', payload: { username } }));
  wrap(accounts, 'terminate', (username, opts) => ({ event: 'account.terminated', payload: { username, keepDns: Boolean(opts?.keepDns) } }), (result, username, opts) => ({ event: 'account.terminated', payload: { username, domain: result?.domain ?? null, keepDns: Boolean(opts?.keepDns) } }));
  wrap(accounts, 'modify', (username, input) => ({ event: 'account.modified', payload: { username, changes: Object.fromEntries(Object.entries(input || {}).filter(([k]) => !/pass/i.test(k)).map(([k, v]) => [k, { to: v }])) } }));
  wrap(ctx.serviceManager, 'action', (name, verb) => (verb === 'restart' ? { event: 'service.restarted', payload: { service: name, unit: ctx.capabilities?.unitFor?.(name) ?? null } } : null));

  const auth = ctx.auth;
  if (auth && typeof auth.login === 'function') {
    const login = auth.login;
    auth.login = async function wrappedLogin(input) {
      try {
        const result = await login.call(this, input);
        if (result?.user) events.emit('login.succeeded', { username: result.user.username, role: result.user.role, ip: input.ip }, { stage: 'post' }).catch(() => {});
        return result;
      } catch (err) {
        events.emit('login.failed', { username: input?.username ?? null, ip: input?.ip ?? null, reason: err.code || err.message }, { stage: 'post' }).catch(() => {});
        throw err;
      }
    };
  }
}
