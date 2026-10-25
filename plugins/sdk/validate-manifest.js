'use strict';

/**
 * WHM Plugin SDK — plugin.json manifest validator (hand-written, zero dependencies).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the vocabularies the SDK contract uses:
 * sidebar categories, permission scopes, the hook event catalog, settings field types,
 * UI page kinds, lifecycle/isolation enums. The marketplace, the panel host
 * (server/src/services/plugins.js), the mock host and manifest.schema.json all consume
 * these constants so they can never drift from each other.
 *
 * validateManifest(manifest) -> { ok: boolean, errors: [{ path, code, message }] }
 */

const semver = require('./semver');
const cron = require('./cron');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The 30 WHM sidebar categories (BLUEPRINT.md §13). "Plugins" is category 30. */
const CATEGORIES = Object.freeze([
  'Server Configuration',
  'Support',
  'Networking Setup',
  'Security Center',
  'Server Contacts',
  'Resellers',
  'Service Configuration',
  'Locales',
  'Backup',
  'Clusters',
  'System Reboot',
  'Server Status',
  'Account Information',
  'Account Functions',
  'Multi Account Functions',
  'Transfers',
  'Themes',
  'Packages',
  'DNS Functions',
  'Database Services',
  'IP Functions',
  'Software',
  'Email',
  'System Health',
  'cPanel',
  'SSL/TLS',
  'Market',
  'Restart Services',
  'Development',
  'Plugins',
]);

/** Agent op families (BLUEPRINT.md §8). Used by the agent:op:<family.op> scope. */
const AGENT_OP_FAMILIES = Object.freeze([
  'user', 'web', 'dns', 'mail', 'db', 'ftp', 'svc', 'net', 'ssl', 'sec', 'sys', 'fs',
]);

/** Fixed permission scopes → human description shown on the consent screen. */
const PERMISSIONS = Object.freeze({
  'accounts:read': 'Read hosting accounts (ctx.api.accounts.list / get)',
  'accounts:write': 'Suspend / unsuspend accounts and cancel pre-stage account hooks',
  'packages:read': 'Read hosting packages (ctx.api.packages.list)',
  'dns:read': 'Read DNS zones and records (ctx.api.dns.zones.*)',
  'backups:read': 'List and verify backup artefacts and destinations',
  'backups:write': 'Create, upload and delete backup artefacts',
  'backups:restore': 'Restore a backup artefact over an account (admin confirm token required)',
  'settings:own': 'Read and write the plugin\'s own settings (ctx.settings)',
  'store:own': 'Read and write the plugin\'s own key/value store and collections (ctx.store)',
  'schedule': 'Register cron schedules for the plugin\'s jobs (ctx.schedule)',
  'jobs': 'Run background jobs and query their status (ctx.jobs)',
  'events:emit': 'Emit events in the plugin\'s own namespace (ctx.events.emit)',
  'ui:sidebar': 'Add entries to the WHM sidebar and register UI pages (ctx.ui)',
  'api:routes': 'Expose HTTP routes under /api/plugins/<id>/ (ctx.http)',
  'contacts:notify': 'Send notifications through the Contact Manager (ctx.api.contacts.notify)',
  'system:read': 'Read host/system information and service status (ctx.api.system / services)',
  'audit:write': 'Write entries to the panel audit log (ctx.api.audit.record)',
  'crypto:own': 'Encrypt / decrypt with a plugin-scoped key, hashes and random tokens (ctx.crypto)',
  'fs:own': 'Read and write files inside the plugin data directory (ctx.fs)',
});

const PERMISSION_SCOPES = Object.freeze(Object.keys(PERMISSIONS));

/** Parameterised scope patterns. */
const AGENT_OP_SCOPE_PATTERN = new RegExp(
  `^agent:op:(${AGENT_OP_FAMILIES.join('|')})\\.[a-z][a-zA-Z0-9]*(\\.[a-z][a-zA-Z0-9]*)*$`,
);
const NET_OUTBOUND_SCOPE_PATTERN =
  /^net:outbound:(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(:([1-9]\d{0,4}))?$/;

const PERMISSION_PATTERNS = Object.freeze({
  'agent:op:<family.op>': AGENT_OP_SCOPE_PATTERN,
  'net:outbound:<host>': NET_OUTBOUND_SCOPE_PATTERN,
});

const HOOK_STAGES = Object.freeze(['pre', 'post']);

/**
 * Host event catalog. `stages` lists which stages the host fires; `cancellable` means a
 * `pre` handler may call evt.cancel(reason), which requires `cancelScope`.
 * Payload fields never include secrets.
 */
const EVENTS = Object.freeze({
  'account.created': { stages: ['pre', 'post'], cancellable: true, cancelScope: 'accounts:write', payload: '{ username, domain, owner, package, ip, contactEmail }' },
  'account.modified': { stages: ['pre', 'post'], cancellable: true, cancelScope: 'accounts:write', payload: '{ username, changes: { field: { from, to } } }' },
  'account.suspended': { stages: ['pre', 'post'], cancellable: true, cancelScope: 'accounts:write', payload: '{ username, reason }' },
  'account.unsuspended': { stages: ['pre', 'post'], cancellable: true, cancelScope: 'accounts:write', payload: '{ username }' },
  'account.terminated': { stages: ['pre', 'post'], cancellable: true, cancelScope: 'accounts:write', payload: '{ username, domain, keepDns }' },
  'package.changed': { stages: ['post'], cancellable: false, payload: '{ name, change: "created"|"modified"|"deleted" }' },
  'backup.started': { stages: ['post'], cancellable: false, payload: '{ jobId, account, include, destinationId? }' },
  'backup.completed': { stages: ['post'], cancellable: false, payload: '{ jobId, account, artefact: { id, path, size, sha256, createdAt } }' },
  'backup.failed': { stages: ['post'], cancellable: false, payload: '{ jobId, account, error: { code, message } }' },
  'backup.restored': { stages: ['pre', 'post'], cancellable: true, cancelScope: 'backups:restore', payload: '{ artefactId, account, principal }' },
  'dns.zone.changed': { stages: ['pre', 'post'], cancellable: false, payload: '{ domain, serial, change: "created"|"records"|"deleted" }' },
  'ssl.issued': { stages: ['post'], cancellable: false, payload: '{ domain, issuer, notAfter, autossl }' },
  'ssl.expiring': { stages: ['post'], cancellable: false, payload: '{ domain, notAfter, daysLeft }' },
  'login.failed': { stages: ['post'], cancellable: false, payload: '{ username, ip, reason }' },
  'login.succeeded': { stages: ['post'], cancellable: false, payload: '{ username, role, ip }' },
  'service.restarted': { stages: ['pre', 'post'], cancellable: false, payload: '{ service, unit, principal }' },
  'service.failed': { stages: ['post'], cancellable: false, payload: '{ service, unit, exitCode }' },
  'plugin.installed': { stages: ['post'], cancellable: false, payload: '{ pluginId, version }' },
  'plugin.enabled': { stages: ['post'], cancellable: false, payload: '{ pluginId, version }' },
  'plugin.disabled': { stages: ['post'], cancellable: false, payload: '{ pluginId, version }' },
  'plugin.uninstalled': { stages: ['post'], cancellable: false, payload: '{ pluginId, version, purged }' },
  'panel.started': { stages: ['post'], cancellable: false, payload: '{ hostVersion, bootedAt }' },
});

const EVENT_NAMES = Object.freeze(Object.keys(EVENTS));

/** Plugin-emitted events: "<reverse.dns.id>.<event>" → at least four dot-separated segments. */
const PLUGIN_EVENT_PATTERN = /^([a-z][a-z0-9-]*\.){3,}[a-z][a-z0-9_]*$/;

/** Reverse-DNS plugin id, at least three segments, e.g. "net.example.hello". */
const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/;
const ID_MAX_LENGTH = 128;

const SETTING_TYPES = Object.freeze([
  'text', 'number', 'select', 'multiselect', 'toggle', 'password', 'cron', 'textarea',
]);

const PAGE_KINDS = Object.freeze(['settings', 'table', 'form', 'action', 'markdown', 'html']);

const ISOLATION_MODES = Object.freeze(['in-process', 'process']);

const SEVERITIES = Object.freeze(['info', 'warning', 'critical']);

const BACKUP_COMPONENTS = Object.freeze(['home', 'mail', 'db', 'dns', 'ssl', 'cron']);
const COMPRESSIONS = Object.freeze(['gzip', 'zstd', 'none']);

/** Plugin lifecycle states persisted in plugins.state. */
const LIFECYCLE_STATES = Object.freeze([
  'pending_consent', 'disabled', 'enabled', 'errored', 'revoked',
]);

/** Job states (mirrors the panel `jobs` table vocabulary plus `cancelled`). */
const JOB_STATES = Object.freeze(['queued', 'running', 'done', 'failed', 'cancelled']);

const UI_ROUTE_PATTERN = /^\/(?:[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*)?$/;
const API_ROUTE_PATTERN = /^\/(?:[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)*)?$/;
const ICON_PATTERN = /^[a-z][a-z0-9-]*$/;
const SETTING_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
const JOB_NAME_PATTERN = /^[a-z][a-zA-Z0-9_-]*$/;
const HANDLER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_./-]+$/;

const TOP_LEVEL_KEYS = Object.freeze([
  '$schema', 'id', 'name', 'version', 'description', 'author', 'license', 'homepage',
  'engines', 'main', 'permissions', 'hooks', 'ui', 'settings', 'jobs', 'cron',
  'isolation', 'i18n', 'keywords',
]);

const SETTING_FIELD_KEYS = Object.freeze([
  'key', 'type', 'label', 'help', 'default', 'required', 'group', 'options', 'min', 'max',
  'integer', 'minLength', 'maxLength', 'pattern', 'placeholder', 'secret',
]);

const PAGE_KEYS = Object.freeze([
  'route', 'title', 'kind', 'icon', 'description', 'source', 'columns', 'fields', 'job',
  'confirm', 'content', 'file',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNonEmptyStr = (v) => isStr(v) && v.trim().length > 0;

function isHttpUrl(v) {
  if (!isStr(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isKnownPermission(scope) {
  return (
    isStr(scope) &&
    (PERMISSION_SCOPES.includes(scope) ||
      AGENT_OP_SCOPE_PATTERN.test(scope) ||
      NET_OUTBOUND_SCOPE_PATTERN.test(scope))
  );
}

function isKnownEvent(event) {
  return isStr(event) && Object.prototype.hasOwnProperty.call(EVENTS, event);
}

function isPluginEvent(event) {
  return isStr(event) && PLUGIN_EVENT_PATTERN.test(event);
}

/**
 * Does `host[:port]` (from a URL) match one of the granted net:outbound scopes?
 * "*.example.com" matches any sub-domain (but not example.com itself). A scope with a
 * port only matches that port; a scope without one matches any port.
 */
function matchesNetScope(hostname, port, scopes) {
  const h = String(hostname).toLowerCase();
  const p = port ? String(port) : '';
  for (const scope of scopes || []) {
    const m = NET_OUTBOUND_SCOPE_PATTERN.exec(scope);
    if (!m) continue;
    let spec = scope.slice('net:outbound:'.length);
    let specPort = '';
    const colon = spec.lastIndexOf(':');
    if (colon !== -1) {
      specPort = spec.slice(colon + 1);
      spec = spec.slice(0, colon);
    }
    if (specPort && specPort !== p) continue;
    if (spec.startsWith('*.')) {
      const suffix = spec.slice(1); // ".example.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return scope;
    } else if (spec === h) {
      return scope;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settings values
// ---------------------------------------------------------------------------

/**
 * Validate a runtime value against a settings field descriptor.
 * -> { ok: true } | { ok: false, error: string }
 */
function validateSettingValue(field, value) {
  const fail = (error) => ({ ok: false, error });
  const empty = value === undefined || value === null || value === '' ||
    (Array.isArray(value) && value.length === 0);
  if (empty) {
    return field.required ? fail(`"${field.key}" is required`) : { ok: true };
  }
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'password': {
      if (!isStr(value)) return fail(`"${field.key}" must be a string`);
      if (field.minLength !== undefined && value.length < field.minLength) return fail(`"${field.key}" must be at least ${field.minLength} characters`);
      if (field.maxLength !== undefined && value.length > field.maxLength) return fail(`"${field.key}" must be at most ${field.maxLength} characters`);
      if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) return fail(`"${field.key}" does not match ${field.pattern}`);
      return { ok: true };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`"${field.key}" must be a finite number`);
      if (field.integer && !Number.isInteger(value)) return fail(`"${field.key}" must be an integer`);
      if (field.min !== undefined && value < field.min) return fail(`"${field.key}" must be >= ${field.min}`);
      if (field.max !== undefined && value > field.max) return fail(`"${field.key}" must be <= ${field.max}`);
      return { ok: true };
    }
    case 'toggle':
      return typeof value === 'boolean' ? { ok: true } : fail(`"${field.key}" must be a boolean`);
    case 'select': {
      const allowed = (field.options || []).map((o) => o.value);
      return allowed.includes(value) ? { ok: true } : fail(`"${field.key}" must be one of ${allowed.join(', ')}`);
    }
    case 'multiselect': {
      if (!Array.isArray(value)) return fail(`"${field.key}" must be an array`);
      const allowed = (field.options || []).map((o) => o.value);
      if (new Set(value).size !== value.length) return fail(`"${field.key}" must not contain duplicates`);
      for (const v of value) if (!allowed.includes(v)) return fail(`"${field.key}" contains unknown option ${JSON.stringify(v)}`);
      return { ok: true };
    }
    case 'cron': {
      if (!isStr(value)) return fail(`"${field.key}" must be a cron string`);
      const r = cron.validate(value);
      return r.ok ? { ok: true } : fail(`"${field.key}": ${r.error}`);
    }
    default:
      return fail(`"${field.key}" has unknown type ${field.type}`);
  }
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

class Collector {
  constructor() { this.errors = []; }
  add(path, code, message) { this.errors.push({ path, code, message }); }
  get ok() { return this.errors.length === 0; }
}

function checkUnknownKeys(obj, allowed, path, c) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) c.add(`${path}.${k}`, 'UNKNOWN_KEY', `unknown key "${k}"`);
  }
}

/** Validate one settings field descriptor; returns true when structurally usable. */
function validateSettingsField(field, path, c, groupIds) {
  if (!isObj(field)) { c.add(path, 'TYPE', 'settings field must be an object'); return false; }
  checkUnknownKeys(field, SETTING_FIELD_KEYS, path, c);
  let usable = true;
  if (!isStr(field.key) || !SETTING_KEY_PATTERN.test(field.key)) {
    c.add(`${path}.key`, 'PATTERN', `key must match ${SETTING_KEY_PATTERN}`); usable = false;
  }
  if (!SETTING_TYPES.includes(field.type)) {
    c.add(`${path}.type`, 'UNKNOWN_SETTING_TYPE', `type must be one of ${SETTING_TYPES.join(', ')}`); usable = false;
  }
  if (!isNonEmptyStr(field.label)) c.add(`${path}.label`, 'REQUIRED', 'label is required');
  for (const k of ['help', 'placeholder', 'pattern', 'group']) {
    if (field[k] !== undefined && !isStr(field[k])) c.add(`${path}.${k}`, 'TYPE', `${k} must be a string`);
  }
  if (field.pattern !== undefined && isStr(field.pattern)) {
    try { new RegExp(field.pattern); } catch { c.add(`${path}.pattern`, 'PATTERN', 'pattern is not a valid regular expression'); }
  }
  for (const k of ['required', 'integer', 'secret']) {
    if (field[k] !== undefined && typeof field[k] !== 'boolean') c.add(`${path}.${k}`, 'TYPE', `${k} must be a boolean`);
  }
  for (const k of ['min', 'max', 'minLength', 'maxLength']) {
    if (field[k] !== undefined && typeof field[k] !== 'number') c.add(`${path}.${k}`, 'TYPE', `${k} must be a number`);
  }
  if (typeof field.min === 'number' && typeof field.max === 'number' && field.min > field.max) {
    c.add(`${path}.min`, 'RANGE', 'min must be <= max');
  }
  if (groupIds && field.group !== undefined && !groupIds.includes(field.group)) {
    c.add(`${path}.group`, 'UNKNOWN_GROUP', `group "${field.group}" is not declared in settings.groups`);
  }
  if (field.type === 'select' || field.type === 'multiselect') {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      c.add(`${path}.options`, 'REQUIRED', `${field.type} requires a non-empty options array`); usable = false;
    } else {
      const seen = new Set();
      field.options.forEach((o, i) => {
        if (!isObj(o) || !isStr(o.value) || !isNonEmptyStr(o.label)) {
          c.add(`${path}.options[${i}]`, 'TYPE', 'option must be { value: string, label: string }');
        } else if (seen.has(o.value)) {
          c.add(`${path}.options[${i}].value`, 'DUPLICATE', `duplicate option value "${o.value}"`);
        } else {
          seen.add(o.value);
        }
      });
    }
  } else if (field.options !== undefined) {
    c.add(`${path}.options`, 'UNEXPECTED', `options are only valid for select/multiselect`);
  }
  if (field.type === 'password' && field.default !== undefined) {
    c.add(`${path}.default`, 'SECRET_DEFAULT', 'password fields must not declare a default (secrets never live in the manifest)');
  } else if (usable && field.default !== undefined) {
    const r = validateSettingValue({ ...field, required: false }, field.default);
    if (!r.ok) c.add(`${path}.default`, 'INVALID_DEFAULT', `default is invalid: ${r.error}`);
  }
  return usable;
}

/**
 * Validate a UI page descriptor (manifest ui.pages[] or ctx.ui.registerPage()).
 * `refs` = { jobs: [names], hasSettings: boolean } for cross-reference checks.
 */
function validatePageDescriptor(page, path, c, refs = {}) {
  if (!isObj(page)) { c.add(path, 'TYPE', 'page must be an object'); return; }
  checkUnknownKeys(page, PAGE_KEYS, path, c);
  if (!isStr(page.route) || !UI_ROUTE_PATTERN.test(page.route)) {
    c.add(`${path}.route`, 'PATTERN', `route must match ${UI_ROUTE_PATTERN} (relative to /plugins/<id>)`);
  }
  if (!isNonEmptyStr(page.title)) c.add(`${path}.title`, 'REQUIRED', 'title is required');
  if (page.icon !== undefined && (!isStr(page.icon) || !ICON_PATTERN.test(page.icon))) {
    c.add(`${path}.icon`, 'PATTERN', 'icon must be a lucide icon name (kebab-case)');
  }
  if (page.description !== undefined && !isStr(page.description)) c.add(`${path}.description`, 'TYPE', 'description must be a string');
  if (!PAGE_KINDS.includes(page.kind)) {
    c.add(`${path}.kind`, 'UNKNOWN_PAGE_KIND', `kind must be one of ${PAGE_KINDS.join(', ')}`);
    return;
  }
  const needSource = () => {
    if (!isStr(page.source) || !API_ROUTE_PATTERN.test(page.source)) {
      c.add(`${path}.source`, 'REQUIRED', `${page.kind} pages need "source": a route path on the plugin router`);
    }
  };
  switch (page.kind) {
    case 'settings':
      if (refs.hasSettings === false) c.add(`${path}.kind`, 'NO_SETTINGS', 'a settings page requires a settings schema with at least one field');
      break;
    case 'table':
      needSource();
      if (page.columns !== undefined) {
        if (!Array.isArray(page.columns)) c.add(`${path}.columns`, 'TYPE', 'columns must be an array');
        else page.columns.forEach((col, i) => {
          if (!isObj(col) || !isNonEmptyStr(col.key) || !isNonEmptyStr(col.label)) {
            c.add(`${path}.columns[${i}]`, 'TYPE', 'column must be { key, label }');
          }
        });
      }
      break;
    case 'form':
      needSource();
      if (!Array.isArray(page.fields) || page.fields.length === 0) {
        c.add(`${path}.fields`, 'REQUIRED', 'form pages need a non-empty fields array (settings-field syntax)');
      } else {
        page.fields.forEach((f, i) => validateSettingsField(f, `${path}.fields[${i}]`, c));
      }
      break;
    case 'action':
      if (!isStr(page.job) || !JOB_NAME_PATTERN.test(page.job)) {
        c.add(`${path}.job`, 'REQUIRED', 'action pages need "job": a declared job name');
      } else if (refs.jobs && !refs.jobs.includes(page.job)) {
        c.add(`${path}.job`, 'UNKNOWN_JOB', `job "${page.job}" is not declared in manifest.jobs`);
      }
      if (page.confirm !== undefined && typeof page.confirm !== 'boolean') c.add(`${path}.confirm`, 'TYPE', 'confirm must be a boolean');
      break;
    case 'markdown':
      if (!isStr(page.content) && !(isStr(page.file) && RELATIVE_PATH_PATTERN.test(page.file) && page.file.endsWith('.md'))) {
        c.add(`${path}.content`, 'REQUIRED', 'markdown pages need "content" or a relative "file" ending in .md');
      }
      break;
    case 'html':
      if (!isStr(page.file) || !RELATIVE_PATH_PATTERN.test(page.file) || !page.file.endsWith('.html')) {
        c.add(`${path}.file`, 'REQUIRED', 'html pages need a relative "file" ending in .html (served in a sandboxed iframe)');
      }
      break;
    default:
      break;
  }
}

/**
 * Validate a complete plugin.json manifest object.
 * @param {any} manifest
 * @returns {{ ok: boolean, errors: Array<{path: string, code: string, message: string}> }}
 */
function validateManifest(manifest) {
  const c = new Collector();
  if (!isObj(manifest)) {
    c.add('', 'TYPE', 'manifest must be a JSON object');
    return { ok: false, errors: c.errors };
  }
  checkUnknownKeys(manifest, TOP_LEVEL_KEYS, '', c);

  // --- identity ----------------------------------------------------------
  if (!isStr(manifest.id)) c.add('id', 'REQUIRED', 'id is required (reverse-DNS string)');
  else if (!ID_PATTERN.test(manifest.id)) c.add('id', 'PATTERN', `id must be reverse-DNS with >= 3 segments, e.g. "net.example.hello" (${ID_PATTERN})`);
  else if (manifest.id.length > ID_MAX_LENGTH) c.add('id', 'LENGTH', `id must be <= ${ID_MAX_LENGTH} characters`);

  if (!isNonEmptyStr(manifest.name)) c.add('name', 'REQUIRED', 'name is required');
  else if (manifest.name.length > 80) c.add('name', 'LENGTH', 'name must be <= 80 characters');

  if (!isStr(manifest.version)) c.add('version', 'REQUIRED', 'version is required');
  else if (!semver.valid(manifest.version)) c.add('version', 'INVALID_SEMVER', `version "${manifest.version}" is not valid semver`);

  if (!isNonEmptyStr(manifest.description)) c.add('description', 'REQUIRED', 'description is required');
  else if (manifest.description.length > 500) c.add('description', 'LENGTH', 'description must be <= 500 characters');

  if (!isObj(manifest.author)) c.add('author', 'REQUIRED', 'author { name, email?, url? } is required');
  else {
    checkUnknownKeys(manifest.author, ['name', 'email', 'url'], 'author', c);
    if (!isNonEmptyStr(manifest.author.name)) c.add('author.name', 'REQUIRED', 'author.name is required');
    if (manifest.author.email !== undefined && (!isStr(manifest.author.email) || !EMAIL_PATTERN.test(manifest.author.email))) c.add('author.email', 'PATTERN', 'author.email must be an email address');
    if (manifest.author.url !== undefined && !isHttpUrl(manifest.author.url)) c.add('author.url', 'PATTERN', 'author.url must be an http(s) URL');
  }

  if (!isNonEmptyStr(manifest.license)) c.add('license', 'REQUIRED', 'license is required (SPDX identifier or "proprietary")');
  if (manifest.homepage !== undefined && !isHttpUrl(manifest.homepage)) c.add('homepage', 'PATTERN', 'homepage must be an http(s) URL');

  if (!isObj(manifest.engines)) c.add('engines', 'REQUIRED', 'engines { whm: "<semver range>" } is required');
  else {
    checkUnknownKeys(manifest.engines, ['whm', 'node'], 'engines', c);
    if (!isStr(manifest.engines.whm)) c.add('engines.whm', 'REQUIRED', 'engines.whm is required');
    else if (!semver.validRange(manifest.engines.whm)) c.add('engines.whm', 'INVALID_RANGE', `engines.whm "${manifest.engines.whm}" is not a valid semver range`);
    if (manifest.engines.node !== undefined && (!isStr(manifest.engines.node) || !semver.validRange(manifest.engines.node))) c.add('engines.node', 'INVALID_RANGE', 'engines.node must be a valid semver range');
  }

  if (!isStr(manifest.main)) c.add('main', 'REQUIRED', 'main (entry file) is required');
  else if (!RELATIVE_PATH_PATTERN.test(manifest.main) || !/\.c?js$/.test(manifest.main)) c.add('main', 'PATTERN', 'main must be a relative path to a .js/.cjs file inside the plugin directory');

  // --- permissions --------------------------------------------------------
  const perms = [];
  if (manifest.permissions === undefined) c.add('permissions', 'REQUIRED', 'permissions array is required (may be empty)');
  else if (!Array.isArray(manifest.permissions)) c.add('permissions', 'TYPE', 'permissions must be an array of scope strings');
  else {
    manifest.permissions.forEach((p, i) => {
      if (!isKnownPermission(p)) c.add(`permissions[${i}]`, 'UNKNOWN_PERMISSION', `unknown permission scope ${JSON.stringify(p)}`);
      else if (perms.includes(p)) c.add(`permissions[${i}]`, 'DUPLICATE', `duplicate permission "${p}"`);
      else perms.push(p);
    });
  }
  const has = (scope) => perms.includes(scope);
  const requirePerm = (scope, path, why) => {
    if (!has(scope)) c.add(path, 'MISSING_PERMISSION', `${why} requires permission "${scope}"`);
  };

  // --- settings -----------------------------------------------------------
  const settingFields = [];
  if (manifest.settings !== undefined) {
    if (!isObj(manifest.settings)) c.add('settings', 'TYPE', 'settings must be { groups?, fields }');
    else {
      checkUnknownKeys(manifest.settings, ['groups', 'fields'], 'settings', c);
      let groupIds;
      if (manifest.settings.groups !== undefined) {
        if (!Array.isArray(manifest.settings.groups)) c.add('settings.groups', 'TYPE', 'groups must be an array');
        else {
          groupIds = [];
          manifest.settings.groups.forEach((g, i) => {
            if (!isObj(g) || !isNonEmptyStr(g.id) || !isNonEmptyStr(g.label)) c.add(`settings.groups[${i}]`, 'TYPE', 'group must be { id, label }');
            else if (groupIds.includes(g.id)) c.add(`settings.groups[${i}].id`, 'DUPLICATE', `duplicate group "${g.id}"`);
            else groupIds.push(g.id);
          });
        }
      }
      if (!Array.isArray(manifest.settings.fields)) c.add('settings.fields', 'REQUIRED', 'settings.fields must be an array');
      else {
        const keys = new Set();
        manifest.settings.fields.forEach((f, i) => {
          const usable = validateSettingsField(f, `settings.fields[${i}]`, c, groupIds);
          if (usable) {
            if (keys.has(f.key)) c.add(`settings.fields[${i}].key`, 'DUPLICATE', `duplicate setting key "${f.key}"`);
            keys.add(f.key);
            settingFields.push(f);
          }
        });
        if (manifest.settings.fields.length > 0) requirePerm('settings:own', 'settings', 'declaring settings');
      }
    }
  }

  // --- jobs ---------------------------------------------------------------
  const jobNames = [];
  if (manifest.jobs !== undefined) {
    if (!isObj(manifest.jobs)) c.add('jobs', 'TYPE', 'jobs must be an object keyed by job name');
    else {
      for (const [name, def] of Object.entries(manifest.jobs)) {
        const p = `jobs.${name}`;
        if (!JOB_NAME_PATTERN.test(name)) c.add(p, 'PATTERN', `job name must match ${JOB_NAME_PATTERN}`);
        else jobNames.push(name);
        if (!isObj(def)) { c.add(p, 'TYPE', 'job definition must be an object'); continue; }
        checkUnknownKeys(def, ['label', 'description', 'timeoutSec', 'cancellable'], p, c);
        if (!isNonEmptyStr(def.label)) c.add(`${p}.label`, 'REQUIRED', 'job label is required');
        if (def.description !== undefined && !isStr(def.description)) c.add(`${p}.description`, 'TYPE', 'description must be a string');
        if (def.timeoutSec !== undefined && (!Number.isInteger(def.timeoutSec) || def.timeoutSec < 1 || def.timeoutSec > 86400)) c.add(`${p}.timeoutSec`, 'RANGE', 'timeoutSec must be an integer 1..86400');
        if (def.cancellable !== undefined && typeof def.cancellable !== 'boolean') c.add(`${p}.cancellable`, 'TYPE', 'cancellable must be a boolean');
      }
      if (Object.keys(manifest.jobs).length > 0) requirePerm('jobs', 'jobs', 'declaring jobs');
    }
  }

  // --- cron ---------------------------------------------------------------
  if (manifest.cron !== undefined) {
    if (!Array.isArray(manifest.cron)) c.add('cron', 'TYPE', 'cron must be an array');
    else {
      const names = new Set();
      manifest.cron.forEach((entry, i) => {
        const p = `cron[${i}]`;
        if (!isObj(entry)) { c.add(p, 'TYPE', 'cron entry must be an object'); return; }
        checkUnknownKeys(entry, ['name', 'job', 'schedule', 'params', 'enabled'], p, c);
        if (!isStr(entry.name) || !JOB_NAME_PATTERN.test(entry.name)) c.add(`${p}.name`, 'PATTERN', `cron name must match ${JOB_NAME_PATTERN}`);
        else if (names.has(entry.name)) c.add(`${p}.name`, 'DUPLICATE', `duplicate cron name "${entry.name}"`);
        else names.add(entry.name);
        if (!isStr(entry.job)) c.add(`${p}.job`, 'REQUIRED', 'cron.job is required');
        else if (!jobNames.includes(entry.job)) c.add(`${p}.job`, 'UNKNOWN_JOB', `job "${entry.job}" is not declared in manifest.jobs`);
        if (!isStr(entry.schedule)) c.add(`${p}.schedule`, 'REQUIRED', 'schedule is required: a cron expression or "setting:<key>"');
        else if (entry.schedule.startsWith('setting:')) {
          const key = entry.schedule.slice('setting:'.length);
          const f = settingFields.find((x) => x.key === key);
          if (!f) c.add(`${p}.schedule`, 'UNKNOWN_SETTING', `schedule references unknown setting "${key}"`);
          else if (f.type !== 'cron') c.add(`${p}.schedule`, 'INVALID_SETTING_TYPE', `setting "${key}" must be of type cron`);
        } else {
          const r = cron.validate(entry.schedule);
          if (!r.ok) c.add(`${p}.schedule`, 'INVALID_CRON', r.error);
        }
        if (entry.params !== undefined && !isObj(entry.params)) c.add(`${p}.params`, 'TYPE', 'params must be an object');
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') c.add(`${p}.enabled`, 'TYPE', 'enabled must be a boolean');
      });
      if (manifest.cron.length > 0) requirePerm('schedule', 'cron', 'declaring cron schedules');
    }
  }

  // --- hooks --------------------------------------------------------------
  if (manifest.hooks !== undefined) {
    if (!Array.isArray(manifest.hooks)) c.add('hooks', 'TYPE', 'hooks must be an array of { event, stage?, handler }');
    else {
      const seen = new Set();
      manifest.hooks.forEach((h, i) => {
        const p = `hooks[${i}]`;
        if (!isObj(h)) { c.add(p, 'TYPE', 'hook must be an object'); return; }
        checkUnknownKeys(h, ['event', 'stage', 'handler'], p, c);
        const stage = h.stage === undefined ? 'post' : h.stage;
        if (!HOOK_STAGES.includes(stage)) c.add(`${p}.stage`, 'INVALID_STAGE', `stage must be "pre" or "post"`);
        if (!isStr(h.event)) c.add(`${p}.event`, 'REQUIRED', 'event is required');
        else if (isKnownEvent(h.event)) {
          if (HOOK_STAGES.includes(stage) && !EVENTS[h.event].stages.includes(stage)) {
            c.add(`${p}.stage`, 'INVALID_STAGE', `event "${h.event}" has no "${stage}" stage (available: ${EVENTS[h.event].stages.join(', ')})`);
          }
        } else if (isPluginEvent(h.event)) {
          if (stage !== 'post') c.add(`${p}.stage`, 'INVALID_STAGE', 'plugin-emitted events only have a "post" stage');
        } else {
          c.add(`${p}.event`, 'UNKNOWN_EVENT', `unknown event "${h.event}" (not in the host catalog and not a plugin-namespaced event)`);
        }
        if (!isStr(h.handler) || !HANDLER_PATTERN.test(h.handler)) c.add(`${p}.handler`, 'PATTERN', 'handler must name an exported function in module.exports.hooks');
        const key = `${stage}:${h.event}:${h.handler}`;
        if (seen.has(key)) c.add(p, 'DUPLICATE', `duplicate hook ${key}`);
        seen.add(key);
      });
    }
  }

  // --- ui -----------------------------------------------------------------
  if (manifest.ui !== undefined) {
    if (!isObj(manifest.ui)) c.add('ui', 'TYPE', 'ui must be { sidebar?, pages? }');
    else {
      checkUnknownKeys(manifest.ui, ['sidebar', 'pages'], 'ui', c);
      const pageRoutes = [];
      if (manifest.ui.pages !== undefined) {
        if (!Array.isArray(manifest.ui.pages)) c.add('ui.pages', 'TYPE', 'ui.pages must be an array');
        else {
          manifest.ui.pages.forEach((pg, i) => {
            validatePageDescriptor(pg, `ui.pages[${i}]`, c, { jobs: jobNames, hasSettings: settingFields.length > 0 });
            if (isObj(pg) && isStr(pg.route)) {
              if (pageRoutes.includes(pg.route)) c.add(`ui.pages[${i}].route`, 'DUPLICATE', `duplicate page route "${pg.route}"`);
              pageRoutes.push(pg.route);
              if ((pg.kind === 'table' || pg.kind === 'form') && pg.source !== undefined) requirePerm('api:routes', `ui.pages[${i}]`, `a ${pg.kind} page backed by a plugin route`);
              if (pg.kind === 'action') requirePerm('jobs', `ui.pages[${i}]`, 'an action page');
            }
          });
        }
      }
      if (manifest.ui.sidebar !== undefined) {
        if (!Array.isArray(manifest.ui.sidebar)) c.add('ui.sidebar', 'TYPE', 'ui.sidebar must be an array');
        else {
          manifest.ui.sidebar.forEach((e, i) => {
            const p = `ui.sidebar[${i}]`;
            if (!isObj(e)) { c.add(p, 'TYPE', 'sidebar entry must be an object'); return; }
            checkUnknownKeys(e, ['category', 'label', 'route', 'icon'], p, c);
            if (!CATEGORIES.includes(e.category)) c.add(`${p}.category`, 'UNKNOWN_CATEGORY', `category must be one of the 30 WHM categories (${JSON.stringify(e.category)})`);
            if (!isNonEmptyStr(e.label)) c.add(`${p}.label`, 'REQUIRED', 'label is required');
            if (!isStr(e.route) || !UI_ROUTE_PATTERN.test(e.route)) c.add(`${p}.route`, 'PATTERN', `route must match ${UI_ROUTE_PATTERN}`);
            else if (!pageRoutes.includes(e.route)) c.add(`${p}.route`, 'UNKNOWN_ROUTE', `sidebar route "${e.route}" has no matching ui.pages entry`);
            if (!isStr(e.icon) || !ICON_PATTERN.test(e.icon)) c.add(`${p}.icon`, 'PATTERN', 'icon must be a lucide icon name (kebab-case)');
          });
          if (manifest.ui.sidebar.length > 0) requirePerm('ui:sidebar', 'ui.sidebar', 'sidebar entries');
        }
      }
      if (Array.isArray(manifest.ui.pages) && manifest.ui.pages.length > 0) requirePerm('ui:sidebar', 'ui.pages', 'registering UI pages');
    }
  }

  // --- misc ---------------------------------------------------------------
  if (manifest.isolation !== undefined && !ISOLATION_MODES.includes(manifest.isolation)) {
    c.add('isolation', 'UNKNOWN_ISOLATION', `isolation must be one of ${ISOLATION_MODES.join(', ')}`);
  }
  if (manifest.i18n !== undefined) {
    if (!isObj(manifest.i18n)) c.add('i18n', 'TYPE', 'i18n must be { default, dir? }');
    else {
      checkUnknownKeys(manifest.i18n, ['default', 'dir'], 'i18n', c);
      if (!isStr(manifest.i18n.default) || !LOCALE_PATTERN.test(manifest.i18n.default)) c.add('i18n.default', 'PATTERN', 'i18n.default must be a locale code like "en" or "pt-BR"');
      if (manifest.i18n.dir !== undefined && (!isStr(manifest.i18n.dir) || !RELATIVE_PATH_PATTERN.test(manifest.i18n.dir))) c.add('i18n.dir', 'PATTERN', 'i18n.dir must be a relative directory path');
    }
  }
  if (manifest.keywords !== undefined) {
    if (!Array.isArray(manifest.keywords) || manifest.keywords.length > 10 || !manifest.keywords.every((k) => isNonEmptyStr(k) && k.length <= 32)) {
      c.add('keywords', 'TYPE', 'keywords must be an array of at most 10 short strings');
    }
  }

  return { ok: c.ok, errors: c.errors };
}

module.exports = {
  // constants
  CATEGORIES,
  AGENT_OP_FAMILIES,
  PERMISSIONS,
  PERMISSION_SCOPES,
  PERMISSION_PATTERNS,
  AGENT_OP_SCOPE_PATTERN,
  NET_OUTBOUND_SCOPE_PATTERN,
  HOOK_STAGES,
  EVENTS,
  EVENT_NAMES,
  PLUGIN_EVENT_PATTERN,
  ID_PATTERN,
  ID_MAX_LENGTH,
  SETTING_TYPES,
  PAGE_KINDS,
  ISOLATION_MODES,
  SEVERITIES,
  BACKUP_COMPONENTS,
  COMPRESSIONS,
  LIFECYCLE_STATES,
  JOB_STATES,
  UI_ROUTE_PATTERN,
  API_ROUTE_PATTERN,
  ICON_PATTERN,
  SETTING_KEY_PATTERN,
  JOB_NAME_PATTERN,
  HANDLER_PATTERN,
  LOCALE_PATTERN,
  TOP_LEVEL_KEYS,
  SETTING_FIELD_KEYS,
  PAGE_KEYS,
  // functions
  validateManifest,
  validateSettingsField,
  validateSettingValue,
  validatePageDescriptor,
  isKnownPermission,
  isKnownEvent,
  isPluginEvent,
  matchesNetScope,
};
