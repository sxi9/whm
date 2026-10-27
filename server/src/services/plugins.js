import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import util from 'node:util';
import { createRequire } from 'node:module';
import { json } from '../db/index.js';
import { HttpError, CapabilityError, notFound, conflict } from '../lib/errors.js';
import { agentErrorStatus } from '../middleware/error.js';
import { loadPluginSdk, loadCommonJs, createPluginContext, freezeExports, freezeBuiltin, REPO_ROOT } from '../lib/plugin-sdk.js';
import { extractTar, TarError, UNSAFE_NAME_CHARS } from '../lib/tar.js';
import { PanelEvents } from '../lib/events.js';

// The in-process plugin host: the real implementation of the contract that
// plugins/sdk/mock-host.js documents. Attached as ctx.plugins. Every ctx.* method a
// plugin sees mirrors the mock host's signature, permission gate, validation and
// return shape; only the storage behind it differs (SQLite, the panel services,
// the agent, the data directory).

export const HOST_API_VERSION = '1.0.0';
export const MAX_STORE_VALUE_BYTES = 1024 * 1024;
export const MAX_FS_BYTES = 100 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024;
export const LOG_RING_SIZE = 1000;
export const RESTORE_TOKEN_TTL_MS = 10 * 60 * 1000;
export const PASSWORD_MASK = '••••••';
export const INSTALL_ROOTS = ['/root', '/home', '/tmp', '/opt'];
export const MAX_LOG_MSG_BYTES = 2 * 1024;
export const MAX_LOG_FIELDS_BYTES = 8 * 1024;
export const MAX_STORE_ROWS = 50_000;
export const MAX_DOCS_ROWS = 100_000;
export const HOOK_TIMEOUT_MS = 30_000;
export const ACTIVATE_TIMEOUT_MS = 60_000;
export const DENIAL_RING_SIZE = 50;
// Response headers a plugin route may not set on the panel origin: they would
// touch the session cookie, the CORS policy or the browser hardening headers.
export const BLOCKED_RESPONSE_HEADERS = /^(set-cookie|access-control-.*|content-security-policy(-report-only)?|strict-transport-security|x-frame-options)$/i;
const STRING_BODY_TYPES = /^(text\/plain|application\/json)(\s*;|$)/i;
// Every plugin runs inside the panel process until process isolation lands, so
// an installed plugin is trusted code; the install response and the Manage
// Plugins view carry this warning next to the permission list.
export const IN_PROCESS_WARNING = 'in-process';

const SECRET_KEY_RE = /pass(word)?|secret|token|key|credential|authorization/i;
const BUILTIN_REQUIRES = new Set(['crypto', 'path', 'url', 'util', 'buffer', 'events', 'stream', 'string_decoder', 'querystring', 'zlib', 'assert', 'timers']);
const KID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const nodeRequire = createRequire(import.meta.url);
const builtinCache = new Map();
function requireBuiltin(bare) {
  if (!builtinCache.has(bare)) builtinCache.set(bare, freezeBuiltin(nodeRequire(`node:${bare}`)));
  return builtinCache.get(bare);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const toMs = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const ms = new Date(/^\d{4}-\d{2}-\d{2} /.test(v) ? `${v.replace(' ', 'T')}Z` : v).getTime();
  return Number.isFinite(ms) ? ms : null;
};

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

function jsonSize(v) {
  return Buffer.byteLength(JSON.stringify(v) ?? 'null');
}

// Like the SDK's redact but recursive: `{ smtp: { password } }` is masked too.
function redact(value, depth = 0) {
  if (Array.isArray(value)) return depth > 6 ? '[…]' : value.map((v) => redact(v, depth + 1));
  if (!isObj(value)) return value;
  if (depth > 6) return '[…]';
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  return out;
}

function truncateUtf8(text, max) {
  if (Buffer.byteLength(text) <= max) return text;
  return `${Buffer.from(text).subarray(0, max - 1).toString('utf8').replace(/\uFFFD+$/, '')}…`;
}

function compilePath(p) {
  const keys = [];
  const segs = p.replace(/\/+$/, '').split('/').map((seg) => {
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { re: new RegExp(`^${segs.join('/')}/?$`), keys };
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function walkFiles(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, base, out);
    else if (ent.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function dirUsage(dir) {
  let total = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) { try { total += fs.lstatSync(full).size; } catch { /* vanished */ } }
    }
  };
  walk(dir);
  return total;
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Canonical content digest of an unpacked package (SIGNATURE.json excluded).
export function packageDigest(dir) {
  const lines = walkFiles(dir).filter((f) => f !== 'SIGNATURE.json').sort().map((f) => `${f} ${sha256Hex(fs.readFileSync(path.join(dir, f)))}`);
  return crypto.createHash('sha256').update(lines.join('\n')).digest();
}

export function createPluginHost(ctx) {
  const { db, config, logger } = ctx;
  const sdk = loadPluginSdk();
  const V = sdk?.validate;
  const E = sdk?.errors;
  const semver = sdk?.semver;
  const cron = sdk?.cron;
  const sdkExports = sdk ? freezeExports({ ...(sdk.index || { ...sdk.validate, ...sdk.errors, semver: sdk.semver, cron: sdk.cron }) }) : null;
  const pluginsDir = config.pluginsDir;
  const pluginDataDir = config.pluginDataDir;
  const keysDir = path.join(config.dataDir, 'plugin-keys');
  const log = logger.child ? logger.child({ module: 'plugins' }) : logger;

  const stmts = {
    rows: db.prepare('SELECT * FROM plugins ORDER BY name COLLATE NOCASE, id'),
    row: db.prepare('SELECT * FROM plugins WHERE id = ?'),
    upsert: db.prepare(`INSERT INTO plugins (id, name, version, manifest_json, state, last_error, source, signer, package_sha256, signed, updated_at)
      VALUES (@id, @name, @version, @manifest_json, @state, NULL, @source, @signer, @package_sha256, @signed, datetime('now'))
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, version = excluded.version, manifest_json = excluded.manifest_json, state = excluded.state, last_error = NULL,
        source = excluded.source, signer = excluded.signer, package_sha256 = excluded.package_sha256, signed = excluded.signed, updated_at = excluded.updated_at`),
    setState: db.prepare(`UPDATE plugins SET state = ?, last_error = ?, updated_at = datetime('now'), enabled_at = CASE WHEN ? = 'enabled' THEN datetime('now') ELSE enabled_at END WHERE id = ?`),
    remove: db.prepare('DELETE FROM plugins WHERE id = ?'),
    setting: db.prepare('SELECT value_json FROM plugin_settings WHERE plugin_id = ? AND key = ?'),
    settingsAll: db.prepare('SELECT key, value_json FROM plugin_settings WHERE plugin_id = ?'),
    settingPut: db.prepare(`INSERT INTO plugin_settings (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT (plugin_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`),
    settingSeed: db.prepare('INSERT OR IGNORE INTO plugin_settings (plugin_id, key, value_json) VALUES (?, ?, ?)'),
    settingDel: db.prepare('DELETE FROM plugin_settings WHERE plugin_id = ? AND key = ?'),
    settingsPurge: db.prepare('DELETE FROM plugin_settings WHERE plugin_id = ?'),
    kv: db.prepare('SELECT value_json FROM plugin_store WHERE plugin_id = ? AND key = ?'),
    kvPut: db.prepare(`INSERT INTO plugin_store (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT (plugin_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`),
    kvDel: db.prepare('DELETE FROM plugin_store WHERE plugin_id = ? AND key = ?'),
    kvKeys: db.prepare('SELECT key FROM plugin_store WHERE plugin_id = ? ORDER BY key'),
    kvPurge: db.prepare('DELETE FROM plugin_store WHERE plugin_id = ?'),
    kvCount: db.prepare('SELECT COUNT(*) AS n FROM plugin_store WHERE plugin_id = ?'),
    docs: db.prepare('SELECT id, doc_json FROM plugin_docs WHERE plugin_id = ? AND collection = ? ORDER BY rowid'),
    docInsert: db.prepare('INSERT INTO plugin_docs (plugin_id, collection, id, doc_json) VALUES (?, ?, ?, ?)'),
    docUpdate: db.prepare(`UPDATE plugin_docs SET doc_json = ?, updated_at = datetime('now') WHERE plugin_id = ? AND collection = ? AND id = ?`),
    docDelete: db.prepare('DELETE FROM plugin_docs WHERE plugin_id = ? AND collection = ? AND id = ?'),
    docsPurge: db.prepare('DELETE FROM plugin_docs WHERE plugin_id = ?'),
    docsCount: db.prepare('SELECT COUNT(*) AS n FROM plugin_docs WHERE plugin_id = ?'),
    logInsert: db.prepare('INSERT INTO plugin_logs (plugin_id, level, msg, fields_json) VALUES (?, ?, ?, ?)'),
    logPrune: db.prepare('DELETE FROM plugin_logs WHERE plugin_id = ? AND id NOT IN (SELECT id FROM plugin_logs WHERE plugin_id = ? ORDER BY id DESC LIMIT ?)'),
    logs: db.prepare('SELECT id, ts, level, msg, fields_json FROM plugin_logs WHERE plugin_id = ? ORDER BY id DESC LIMIT ?'),
    logsPurge: db.prepare('DELETE FROM plugin_logs WHERE plugin_id = ?'),
    jobsFor: db.prepare("SELECT * FROM jobs WHERE type LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?"),
    jobCancelled: db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?"),
    jobCancelRunning: db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status = 'running'"),
    audit: db.prepare('INSERT INTO audit_log (principal, role, ip, action, target, args_redacted, result, request_id) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL)'),
    accountByUsername: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.username = ?'),
    backupUpload: db.prepare('INSERT INTO backup_uploads (backup_id, destination_id, destination_name, remote_path, status, error) VALUES (?, ?, ?, ?, ?, ?)'),
  };

  const live = new Map();
  const activations = new Map();
  const restoreTokens = new Map();
  let processIsolationWarned = false;

  function requireSdk() {
    if (!sdk) throw new CapabilityError('plugin-sdk', 'The plugin SDK (plugins/sdk) is not installed with this panel, so plugins cannot be loaded');
    return sdk;
  }

  const bus = () => (ctx.events ||= new PanelEvents(logger));
  const err422 = (code, message, fields) => new HttpError(422, code, message, fields);

  // ------------------------------------------------------------------ entries
  function dirsOf(id) {
    return { dir: path.join(pluginsDir, id), dataDir: path.join(pluginDataDir, id) };
  }

  function createEntry(row) {
    const manifest = json.parse(row.manifest_json, null) || {};
    const { dir, dataDir } = dirsOf(row.id);
    const entry = {
      id: row.id, manifest, dir, dataDir, module: null, ctx: null, state: 'loaded', lastError: null,
      granted: new Set(manifest.permissions || []),
      permissionsUsed: [], permissionDenials: [], deniedCounts: {}, hookTimeouts: [], logWrites: 0,
      routes: [], pages: [], subscribers: [], settingListeners: [], locales: {},
      running: new Map(), routesOpen: false, pagesOpen: false,
      logger: logger.child ? logger.child({ plugin: row.id }) : logger,
    };
    entry.ctx = buildCtx(entry);
    return entry;
  }

  function principalOf(entry) {
    return { id: null, username: `plugin:${entry.id}`, role: 'root' };
  }

  function requestOf(entry) {
    const req = { user: { id: null, username: `plugin:${entry.id}`, role: 'plugin' }, ip: null, id: null, get: () => undefined };
    req.audit = (e) => ctx.auditRecord?.(req, e);
    return req;
  }

  // ------------------------------------------------------------------ gate
  function useScope(entry, scope) {
    if (!entry.permissionsUsed.includes(scope)) entry.permissionsUsed.push(scope);
  }
  // The detail view shows the newest denials; a plugin that retries a denied
  // call on every tick must not grow memory, so the rest is kept as a counter.
  function recordDenial(entry, scope, method) {
    entry.permissionDenials.push({ scope, method, ts: Date.now() });
    if (entry.permissionDenials.length > DENIAL_RING_SIZE) entry.permissionDenials.shift();
    entry.deniedCounts[scope] = (entry.deniedCounts[scope] || 0) + 1;
  }
  function gate(entry, scope, method) {
    if (!entry.granted.has(scope)) {
      recordDenial(entry, scope, method);
      throw new E.PermissionError(scope, method, entry.id);
    }
    useScope(entry, scope);
  }

  // ------------------------------------------------------------------ log
  function writeLog(entry, level, msg, fields) {
    if (typeof msg !== 'string') throw new E.ValidationError('log message must be a string');
    if (fields !== undefined && !isObj(fields)) throw new E.ValidationError('log fields must be an object');
    const text = truncateUtf8(msg, MAX_LOG_MSG_BYTES);
    let safe = null;
    if (fields) {
      safe = redact(fields);
      let encoded;
      try { encoded = JSON.stringify(safe); } catch { encoded = undefined; }
      if (encoded === undefined) safe = { fields: '[not serialisable]' };
      else if (Buffer.byteLength(encoded) > MAX_LOG_FIELDS_BYTES) safe = { truncated: true, fields: truncateUtf8(encoded, MAX_LOG_FIELDS_BYTES) };
    }
    try {
      stmts.logInsert.run(entry.id, level, text, safe ? JSON.stringify(safe) : null);
      if (++entry.logWrites % 50 === 0) stmts.logPrune.run(entry.id, entry.id, LOG_RING_SIZE);
    } catch (e) { log.warn({ err: e, plugin: entry.id }, 'plugin log write failed'); }
    const child = entry.logger;
    (child[level] || child.info).call(child, safe || {}, text);
  }
  function readLogs(id, limit) {
    return stmts.logs.all(id, limit).map((r) => ({ id: r.id, ts: r.ts, level: r.level, msg: r.msg, fields: json.parse(r.fields_json, null) }));
  }

  // ------------------------------------------------------------------ settings
  const settingFields = (entry) => (entry.manifest.settings && entry.manifest.settings.fields) || [];
  function fieldOf(entry, key) {
    const f = settingFields(entry).find((x) => x.key === key);
    if (!f) throw new E.ValidationError(`unknown setting "${key}"`, [{ path: key, code: 'UNKNOWN_SETTING', message: 'not declared in manifest.settings' }]);
    return f;
  }
  function decodeSetting(field, valueJson) {
    const v = json.parse(valueJson, undefined);
    if (field?.type === 'password' && typeof v === 'string') {
      try { return ctx.crypto.decrypt(v); } catch { return undefined; }
    }
    return v;
  }
  function readSetting(entry, key) {
    const row = stmts.setting.get(entry.id, key);
    return row ? decodeSetting(fieldOf(entry, key), row.value_json) : undefined;
  }
  function readSettings(entry) {
    const out = {};
    const fields = settingFields(entry);
    for (const row of stmts.settingsAll.all(entry.id)) {
      const f = fields.find((x) => x.key === row.key);
      if (!f) continue;
      const v = decodeSetting(f, row.value_json);
      if (v !== undefined) out[row.key] = v;
    }
    return out;
  }
  function seedSettingDefaults(entry) {
    for (const f of settingFields(entry)) if (f.default !== undefined) stmts.settingSeed.run(entry.id, f.key, JSON.stringify(f.default));
  }
  function writeSetting(entry, field, value) {
    if (value === undefined || value === null) { stmts.settingDel.run(entry.id, field.key); return; }
    const stored = field.type === 'password' ? ctx.crypto.encrypt(String(value)) : value;
    stmts.settingPut.run(entry.id, field.key, JSON.stringify(stored));
  }
  // Shared by ctx.settings.set and the Manage Plugins API (which skips the gate).
  function setSetting(entry, key, value) {
    const f = fieldOf(entry, key);
    const r = V.validateSettingValue(f, value);
    if (!r.ok) throw new E.ValidationError(r.error, [{ path: key, code: 'INVALID_VALUE', message: r.error }]);
    const previous = clone(readSetting(entry, key));
    writeSetting(entry, f, value);
    const current = clone(readSetting(entry, key));
    if (entry.state === 'enabled' || entry.state === 'activating') rebindSettingSchedules(entry, key);
    for (const fn of entry.settingListeners) {
      try { fn(key, clone(current), previous); } catch (err) { writeLog(entry, 'error', 'settings.onChange listener threw', { error: err.message }); }
    }
    return current;
  }
  function settingsApi(entry) {
    return {
      async get(key) { gate(entry, 'settings:own', 'ctx.settings.get'); fieldOf(entry, key); return clone(readSetting(entry, key)); },
      async getAll() { gate(entry, 'settings:own', 'ctx.settings.getAll'); return readSettings(entry); },
      async set(key, value) { gate(entry, 'settings:own', 'ctx.settings.set'); return setSetting(entry, key, value); },
      onChange(fn) {
        if (typeof fn !== 'function') throw new E.ValidationError('onChange requires a function');
        entry.settingListeners.push(fn);
        return () => { const i = entry.settingListeners.indexOf(fn); if (i !== -1) entry.settingListeners.splice(i, 1); };
      },
    };
  }

  // ------------------------------------------------------------------ store
  function checkKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 256) throw new E.ValidationError('store key must be a string of 1..256 characters');
    if (key.startsWith('__')) throw new E.ValidationError('store keys starting with "__" are reserved for the host');
  }
  function checkRowCap(count, max, what) {
    if (count >= max) throw new E.PluginError(`plugin ${what} quota exceeded (${max} rows)`, { code: 'QUOTA_EXCEEDED', status: 507 });
  }
  function checkValue(value, what) {
    if (value === undefined) throw new E.ValidationError(`${what} must be JSON-serialisable (got undefined)`);
    let size;
    try { size = jsonSize(value); } catch { throw new E.ValidationError(`${what} must be JSON-serialisable`); }
    if (size > MAX_STORE_VALUE_BYTES) throw new E.ValidationError(`${what} exceeds ${MAX_STORE_VALUE_BYTES} bytes`);
  }
  function checkCollection(name) {
    if (typeof name !== 'string' || !/^[a-z][a-zA-Z0-9_]*$/.test(name)) throw new E.ValidationError('collection name must match /^[a-z][a-zA-Z0-9_]*$/');
  }
  function matches(doc, query) {
    if (!query) return true;
    for (const [field, cond] of Object.entries(query)) {
      const val = doc[field];
      if (isObj(cond) && Object.keys(cond).some((k) => k.startsWith('$'))) {
        for (const [op, arg] of Object.entries(cond)) {
          switch (op) {
            case '$gt': if (!(val > arg)) return false; break;
            case '$gte': if (!(val >= arg)) return false; break;
            case '$lt': if (!(val < arg)) return false; break;
            case '$lte': if (!(val <= arg)) return false; break;
            case '$ne': if (val === arg) return false; break;
            case '$in': if (!Array.isArray(arg) || !arg.includes(val)) return false; break;
            case '$nin': if (!Array.isArray(arg) || arg.includes(val)) return false; break;
            default: throw new E.ValidationError(`unknown query operator ${op}`);
          }
        }
      } else if (JSON.stringify(val) !== JSON.stringify(cond)) {
        return false;
      }
    }
    return true;
  }
  function sortDocs(docs, sort) {
    if (!sort) return docs;
    const [[field, dir]] = Object.entries(sort);
    const d = dir === -1 || dir === 'desc' ? -1 : 1;
    return docs.slice().sort((a, b) => (a[field] < b[field] ? -d : a[field] > b[field] ? d : 0));
  }
  const allDocs = (entry, name) => stmts.docs.all(entry.id, name).map((r) => json.parse(r.doc_json, {}));
  function nextDocId(entry) {
    const row = stmts.kv.get(entry.id, '__seq');
    const n = (row ? Number(json.parse(row.value_json, 0)) : 0) + 1;
    stmts.kvPut.run(entry.id, '__seq', JSON.stringify(n));
    return `doc_${String(n).padStart(4, '0')}`;
  }
  function storeApi(entry) {
    return {
      async get(key) { gate(entry, 'store:own', 'ctx.store.get'); checkKey(key); const row = stmts.kv.get(entry.id, key); return row ? json.parse(row.value_json, undefined) : undefined; },
      async set(key, value) {
        gate(entry, 'store:own', 'ctx.store.set'); checkKey(key); checkValue(value, 'store value');
        if (!stmts.kv.get(entry.id, key)) checkRowCap(stmts.kvCount.get(entry.id).n, MAX_STORE_ROWS, 'store');
        stmts.kvPut.run(entry.id, key, JSON.stringify(value));
        return clone(value);
      },
      async delete(key) { gate(entry, 'store:own', 'ctx.store.delete'); checkKey(key); return stmts.kvDel.run(entry.id, key).changes > 0; },
      async keys(prefix) { gate(entry, 'store:own', 'ctx.store.keys'); return stmts.kvKeys.all(entry.id).map((r) => r.key).filter((k) => k !== '__seq' && (!prefix || k.startsWith(prefix))).sort(); },
      collection(name) {
        checkCollection(name);
        const label = `ctx.store.collection(${name})`;
        return {
          async insert(doc) {
            gate(entry, 'store:own', `${label}.insert`);
            if (!isObj(doc)) throw new E.ValidationError('document must be an object');
            checkValue(doc, 'document');
            checkRowCap(stmts.docsCount.get(entry.id).n, MAX_DOCS_ROWS, 'document');
            const now = Date.now();
            const rec = { ...clone(doc), id: doc.id !== undefined ? String(doc.id) : nextDocId(entry), createdAt: now, updatedAt: now };
            try { stmts.docInsert.run(entry.id, name, rec.id, JSON.stringify(rec)); } catch (e) {
              if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new E.ConflictError(`document "${rec.id}" already exists in ${name}`);
              throw e;
            }
            return clone(rec);
          },
          async find(query, options = {}) {
            gate(entry, 'store:own', `${label}.find`);
            let docs = allDocs(entry, name).filter((d) => matches(d, query));
            docs = sortDocs(docs, options.sort);
            const offset = options.offset || 0;
            const limit = options.limit === undefined ? docs.length : options.limit;
            return docs.slice(offset, offset + limit);
          },
          async findOne(query) { gate(entry, 'store:own', `${label}.findOne`); return allDocs(entry, name).find((d) => matches(d, query)) || null; },
          async update(query, patch) {
            gate(entry, 'store:own', `${label}.update`);
            if (!isObj(patch)) throw new E.ValidationError('patch must be an object');
            const { id, createdAt, ...rest } = patch; // eslint-disable-line no-unused-vars
            let n = 0;
            const tx = db.transaction(() => {
              for (const d of allDocs(entry, name)) {
                if (!matches(d, query)) continue;
                Object.assign(d, clone(rest), { updatedAt: Date.now() });
                checkValue(d, 'document');
                stmts.docUpdate.run(JSON.stringify(d), entry.id, name, d.id);
                n++;
              }
            });
            tx();
            return n;
          },
          async remove(query) {
            gate(entry, 'store:own', `${label}.remove`);
            let n = 0;
            const tx = db.transaction(() => { for (const d of allDocs(entry, name)) if (matches(d, query)) n += stmts.docDelete.run(entry.id, name, d.id).changes; });
            tx();
            return n;
          },
          async count(query) { gate(entry, 'store:own', `${label}.count`); return allDocs(entry, name).filter((d) => matches(d, query)).length; },
        };
      },
    };
  }

  // ------------------------------------------------------------------ panel service bridge
  function unavailable(label) {
    return new E.PluginError(`${label} is not available on this server`, { code: 'SERVICE_UNAVAILABLE', status: 503 });
  }
  function requireService(name, label) {
    const svc = ctx[name];
    if (!svc) throw unavailable(label);
    return svc;
  }
  // Panel errors (HttpError / agent errors) become SDK errors so plugins see one vocabulary.
  function translate(err, { resource, id } = {}) {
    if (err instanceof E.PluginError) return err;
    if (err instanceof CapabilityError) return new E.PluginError(err.message, { code: 'SERVICE_UNAVAILABLE', status: 503 });
    if (err instanceof HttpError) {
      if (err.status === 404) return new E.NotFoundError(resource || 'resource', id);
      if (err.status === 409) return new E.ConflictError(err.message);
      if (err.status === 400 || err.status === 422) return new E.ValidationError(err.message, err.fields);
      return new E.PluginError(err.message, { code: String(err.code || 'PANEL_ERROR').toUpperCase(), status: err.status });
    }
    if (err?.agentError) {
      const status = agentErrorStatus(err.code);
      if (status === 404) return new E.NotFoundError(resource || 'resource', id);
      return new E.PluginError(err.message, { code: String(err.code || 'AGENT_ERROR').toUpperCase(), status, details: err.details });
    }
    return err;
  }
  async function bridge(fn, map) {
    try { return await fn(); } catch (err) { throw translate(err, map); }
  }

  const shapeAccount = (a) => ({
    username: a.username, domain: a.domain, owner: a.owner, suspended: Boolean(a.suspended), suspendReason: a.suspend_reason ?? null,
    package: a.package_name ?? null, ip: a.ip ?? null, contactEmail: a.contact_email ?? null, createdAt: toMs(a.created_at),
  });
  const shapeZone = ({ records, soa, ...z }) => ({ // eslint-disable-line no-unused-vars
    domain: z.domain, account: z.account ?? null, serial: z.serial ?? null, ttl: z.ttl ?? null, updatedAt: z.updated_at ?? null, recordCount: z.record_count ?? null,
  });
  const includeFromComponents = (components) => {
    const inc = components?.include;
    if (!isObj(inc)) return V.BACKUP_COMPONENTS.slice();
    const out = [];
    if (inc.home) out.push('home');
    if (inc.mail) out.push('mail');
    if (inc.dbs) out.push('db');
    if (inc.dns) out.push('dns');
    return out;
  };
  const shapeArtefact = (b) => ({
    id: String(b.id), account: b.account, path: b.path, size: b.size ?? null, sha256: b.sha256 ?? null, createdAt: toMs(b.created_at),
    include: includeFromComponents(b.components), compression: 'gzip', encrypted: false, status: b.status,
  });
  const artefactIdOf = (artefactId) => {
    const n = Number(artefactId);
    if (!Number.isInteger(n) || n <= 0) throw new E.NotFoundError('backup artefact', artefactId);
    return n;
  };

  function apiFor(entry) {
    const user = principalOf(entry);
    const req = requestOf(entry);
    const accounts = () => requireService('accounts', 'accounts service');
    const findAccount = async (username) => {
      const row = stmts.accountByUsername.get(username);
      if (!row) throw new E.NotFoundError('account', username);
      return row;
    };
    const artefactOf = async (artefactId) => {
      const backup = requireService('backup', 'backup service');
      return bridge(() => backup.getBackup(artefactIdOf(artefactId), user), { resource: 'backup artefact', id: artefactId });
    };
    return {
      accounts: {
        async list(filter = {}) {
          gate(entry, 'accounts:read', 'ctx.api.accounts.list');
          if (!isObj(filter)) throw new E.ValidationError('filter must be an object');
          const page = filter.page || 1;
          const pageSize = Math.min(filter.pageSize || 50, 500);
          const query = { page, pageSize };
          if (filter.owner !== undefined) query.owner = filter.owner;
          if (filter.suspended !== undefined) query.suspended = Boolean(filter.suspended);
          const r = await bridge(() => accounts().list(query, user));
          return { data: r.data.map(shapeAccount), meta: { page, pageSize, total: r.meta.total } };
        },
        async get(username) {
          gate(entry, 'accounts:read', 'ctx.api.accounts.get');
          return shapeAccount(await bridge(() => accounts().get(username, user), { resource: 'account', id: username }));
        },
        async suspend(username, { reason } = {}) {
          gate(entry, 'accounts:write', 'ctx.api.accounts.suspend');
          const a = await findAccount(username);
          if (a.suspended) throw new E.ConflictError(`account "${username}" is already suspended`);
          return shapeAccount(await bridge(() => accounts().suspend(username, reason || null, user, req), { resource: 'account', id: username }));
        },
        async unsuspend(username) {
          gate(entry, 'accounts:write', 'ctx.api.accounts.unsuspend');
          const a = await findAccount(username);
          if (!a.suspended) throw new E.ConflictError(`account "${username}" is not suspended`);
          return shapeAccount(await bridge(() => accounts().unsuspend(username, user, req), { resource: 'account', id: username }));
        },
      },
      packages: {
        async list() {
          gate(entry, 'packages:read', 'ctx.api.packages.list');
          const r = await bridge(() => requireService('packages', 'packages service').list({ pageSize: 500 }, user));
          return clone(r.data);
        },
      },
      dns: {
        zones: {
          async list(filter = {}) {
            gate(entry, 'dns:read', 'ctx.api.dns.zones.list');
            const dns = requireService('dns', 'DNS service');
            const query = { pageSize: 500 };
            if (filter.account !== undefined) query.account = filter.account;
            const r = await bridge(() => dns.listZones(query, user));
            return r.data.map(shapeZone);
          },
          async get(domain) {
            gate(entry, 'dns:read', 'ctx.api.dns.zones.get');
            const dns = requireService('dns', 'DNS service');
            const z = await bridge(() => dns.getZone(domain, user), { resource: 'dns zone', id: domain });
            return { ...shapeZone(z), soa: clone(z.soa) ?? null, records: clone(z.records) || [] };
          },
        },
      },
      backups: {
        async create({ account, include, compression = 'gzip', encrypt = false } = {}) {
          gate(entry, 'backups:write', 'ctx.api.backups.create');
          if (typeof account !== 'string') throw new E.ValidationError('backups.create: account is required');
          await findAccount(account);
          const inc = include === undefined ? V.BACKUP_COMPONENTS.slice() : include;
          if (!Array.isArray(inc) || inc.some((c) => !V.BACKUP_COMPONENTS.includes(c))) throw new E.ValidationError(`include must be a subset of ${V.BACKUP_COMPONENTS.join(', ')}`);
          if (!V.COMPRESSIONS.includes(compression)) throw new E.ValidationError(`compression must be one of ${V.COMPRESSIONS.join(', ')}`);
          if (typeof encrypt !== 'boolean') throw new E.ValidationError('encrypt must be a boolean');
          if (compression !== 'gzip' || encrypt) throw new E.PluginError('this host only produces gzip-compressed, unencrypted account archives', { code: 'UNSUPPORTED', status: 422 });
          const backup = requireService('backup', 'backup service');
          const r = await bridge(() => backup.archiveAccount(account, { include: { home: inc.includes('home'), mail: inc.includes('mail'), dbs: inc.includes('db'), dns: inc.includes('dns') } }, user, req), { resource: 'account', id: account });
          return { ...shapeArtefact(r), include: inc.slice() };
        },
        async restore({ artefactId, account, confirmToken } = {}) {
          gate(entry, 'backups:restore', 'ctx.api.backups.restore');
          if (typeof artefactId !== 'string' || typeof account !== 'string') throw new E.ValidationError('backups.restore: artefactId and account are required');
          const artefact = await artefactOf(artefactId);
          await findAccount(account);
          const tok = restoreTokens.get(String(confirmToken));
          if (!tok || tok.used || tok.pluginId !== entry.id || tok.artefactId !== artefactId || tok.account !== account || tok.expiresAt < Date.now()) {
            throw new E.PermissionError('confirm-token', 'ctx.api.backups.restore', entry.id);
          }
          if (artefact.account !== account) throw new E.ValidationError(`artefact ${artefactId} belongs to account "${artefact.account}", not "${account}"`);
          tok.used = true;
          const backup = requireService('backup', 'backup service');
          const r = await bridge(() => backup.enqueueRestore({ backupId: artefactIdOf(artefactId), kind: 'account', options: {} }, user, req), { resource: 'backup artefact', id: artefactId });
          return { ok: true, jobId: String(r.job.id) };
        },
        async list(filter = {}) {
          gate(entry, 'backups:read', 'ctx.api.backups.list');
          const backup = requireService('backup', 'backup service');
          const query = { pageSize: 500 };
          if (filter.account !== undefined) query.account = filter.account;
          const r = await bridge(() => backup.listBackups(query, user));
          return r.data.map(shapeArtefact);
        },
        async delete(artefactId) {
          gate(entry, 'backups:write', 'ctx.api.backups.delete');
          await artefactOf(artefactId);
          const backup = requireService('backup', 'backup service');
          await bridge(() => backup.deleteBackup(artefactIdOf(artefactId), {}, user, req), { resource: 'backup artefact', id: artefactId });
          return { ok: true };
        },
        destinations: {
          async list() {
            gate(entry, 'backups:read', 'ctx.api.backups.destinations.list');
            const backup = requireService('backup', 'backup service');
            return backup.listDestinations().map((d) => ({ id: String(d.id), name: d.name, kind: d.kind }));
          },
        },
        async upload({ artefactId, destinationId } = {}) {
          gate(entry, 'backups:write', 'ctx.api.backups.upload');
          const b = await artefactOf(artefactId);
          const backup = requireService('backup', 'backup service');
          const dest = backup.listDestinations().find((d) => String(d.id) === String(destinationId));
          if (!dest) throw new E.NotFoundError('backup destination', destinationId);
          if (!b.path || b.local_present === false) throw new E.ConflictError('the archive is not on local disk');
          const target = `${artefactId}->${dest.name}`;
          let r;
          try {
            r = await bridge(() => ctx.agent.op('backup.destination.upload', { config: backup.destinationConfig(dest.id), file: b.path }, { req }));
          } catch (err) {
            req.audit({ action: 'plugin.backup.upload', target, args: { artefactId, destinationId: String(dest.id), file: b.path }, result: `error:${err.code || 'failed'}` });
            throw err;
          }
          stmts.backupUpload.run(Number(b.id), dest.id, dest.name, r.remotePath ?? null, 'done', null);
          req.audit({ action: 'plugin.backup.upload', target, args: { artefactId, destinationId: String(dest.id), file: b.path, remotePath: r.remotePath ?? null } });
          return { ok: true, remotePath: r.remotePath ?? null, sha256: b.sha256 ?? null };
        },
        async verify(artefactId) {
          gate(entry, 'backups:read', 'ctx.api.backups.verify');
          const b = await artefactOf(artefactId);
          if (!b.path) throw new E.ConflictError('the archive is not on local disk');
          const r = await bridge(() => ctx.agent.op('backup.archive.verify', { archive: b.path, ...(b.sha256 ? { sha256: b.sha256 } : {}) }, { req }), { resource: 'backup artefact', id: artefactId });
          if (r.ok === false) throw new E.PluginError(`archive ${artefactId} failed verification: sha256 ${r.sha256} does not match ${b.sha256}`, { code: 'CHECKSUM_MISMATCH', status: 422 });
          return { ok: true, sha256: r.sha256, size: r.sizeBytes ?? b.size ?? null, verifiedAt: Date.now() };
        },
      },
      services: {
        async status(name) {
          gate(entry, 'system:read', 'ctx.api.services.status');
          if (typeof name !== 'string') throw new E.ValidationError('service name is required');
          const s = await bridge(() => requireService('serviceManager', 'service manager').status(name), { resource: 'service', id: name });
          if (s.installed === false) throw new E.NotFoundError('service', name);
          return { name, active: Boolean(s.active), enabled: s.enabled !== false, pid: s.pid || null, since: s.startedAt || s.since || null };
        },
      },
      system: {
        async info() {
          gate(entry, 'system:read', 'ctx.api.system.info');
          const i = await bridge(() => requireService('system', 'system service').info());
          const mb = (b) => (b == null ? null : Math.round(b / 1048576));
          return {
            hostname: i.hostname, os: i.os?.name ?? null, kernel: i.os?.kernel ?? null, uptimeSec: i.uptimeSeconds ?? null, load: i.loadAverage || [],
            mem: { totalMb: mb(i.memory?.totalBytes), usedMb: i.memory ? mb(i.memory.totalBytes - (i.memory.availableBytes ?? i.memory.freeBytes ?? 0)) : null },
            disk: (i.disks || []).map((d) => ({ mount: d.mountpoint, totalMb: mb(d.sizeBytes), usedMb: mb(d.usedBytes) })),
            panelVersion: HOST_API_VERSION,
          };
        },
      },
      contacts: {
        async notify({ event, subject, body, severity = 'info' } = {}) {
          gate(entry, 'contacts:notify', 'ctx.api.contacts.notify');
          if (typeof event !== 'string' || !event.startsWith(`${entry.id}.`) || !V.isPluginEvent(event)) throw new E.ValidationError(`notify event must be namespaced "${entry.id}.<name>"`);
          if (typeof subject !== 'string' || !subject.trim()) throw new E.ValidationError('subject is required');
          if (typeof body !== 'string') throw new E.ValidationError('body must be a string');
          if (!V.SEVERITIES.includes(severity)) throw new E.ValidationError(`severity must be one of ${V.SEVERITIES.join(', ')}`);
          const contacts = requireService('contacts', 'contact manager');
          const r = await bridge(() => contacts.notify({ event, subject, body, severity }, undefined, req));
          return { ok: true, delivered: r?.sent ?? 0 };
        },
      },
      audit: {
        async record({ action, target, details } = {}) {
          gate(entry, 'audit:write', 'ctx.api.audit.record');
          if (typeof action !== 'string' || !/^[a-z][a-z0-9_.-]*$/.test(action)) throw new E.ValidationError('action must match /^[a-z][a-z0-9_.-]*$/');
          if (target !== undefined && typeof target !== 'string') throw new E.ValidationError('target must be a string');
          const safe = redact(details);
          const { lastInsertRowid } = stmts.audit.run(`plugin:${entry.id}`, 'plugin', `plugin:${entry.id}:${action}`, target || null, safe == null ? null : JSON.stringify(safe), 'ok');
          return { id: String(lastInsertRowid) };
        },
      },
    };
  }

  // ------------------------------------------------------------------ agent
  function agentApi(entry) {
    const req = requestOf(entry);
    return {
      async op(name, args = {}) {
        if (typeof name !== 'string' || !/^[a-z]+(\.[a-z][a-zA-Z0-9]*)+$/.test(name)) throw new E.ValidationError('agent op name must look like "family.op"');
        gate(entry, `agent:op:${name}`, 'ctx.agent.op');
        if (!isObj(args)) throw new E.ValidationError('agent op args must be an object');
        const safeArgs = redact(clone(args));
        try {
          const result = await bridge(() => ctx.agent.op(name, clone(args), { req }));
          req.audit({ action: 'plugin.agent.op', target: name, args: safeArgs });
          return result;
        } catch (err) {
          req.audit({ action: 'plugin.agent.op', target: name, args: safeArgs, result: `error:${err.code || 'failed'}` });
          throw err;
        }
      },
    };
  }

  // ------------------------------------------------------------------ jobs
  const jobType = (id, name) => `plugin:${id}:${name}`;
  function shapeJob(entry, j) {
    const wrapped = isObj(j.params) && 'trigger' in j.params ? j.params : { trigger: 'manual', params: j.params };
    return {
      id: String(j.id), plugin: entry.id, name: j.type.slice(jobType(entry.id, '').length), status: j.status, progress: j.progress, message: j.message ?? null,
      params: wrapped.params || {}, result: j.result ?? null, error: j.error && j.status !== 'cancelled' ? { code: j.error_code || 'JOB_FAILED', message: j.error } : null, trigger: wrapped.trigger,
      createdAt: toMs(j.created_at), startedAt: toMs(j.started_at), finishedAt: toMs(j.finished_at),
    };
  }
  function ownJob(entry, jobId) {
    const n = Number(jobId);
    let j = null;
    try { if (Number.isInteger(n) && n > 0) j = ctx.jobs.get(n); } catch { j = null; }
    if (!j || !j.type.startsWith(jobType(entry.id, ''))) throw new E.NotFoundError('job', jobId);
    return j;
  }
  function checkJobName(entry, name) {
    if (typeof name !== 'string' || !entry.manifest.jobs || !entry.manifest.jobs[name]) throw new E.ValidationError(`job "${name}" is not declared in manifest.jobs`);
  }
  function enqueueJob(entry, name, params, trigger, userId = null) {
    checkJobName(entry, name);
    if (params !== undefined && !isObj(params)) throw new E.ValidationError('job params must be an object');
    const handler = entry.module?.jobs?.[name];
    if (typeof handler !== 'function') throw new E.NotFoundError('job handler', name);
    return ctx.jobs.enqueue(jobType(entry.id, name), { trigger, params: clone(params || {}) }, { userId });
  }
  function setProgress(run, pct, msg) {
    if (typeof pct !== 'number' || pct < 0 || pct > 100) throw new E.ValidationError('progress must be a number 0..100');
    if (!run || run.cancelled) return;
    run.coreCtx.progress(Math.round(pct), msg === undefined ? null : String(msg));
  }
  // The core job worker calls this for every plugin:<id>:<job> type.
  async function runPluginJob(id, name, coreCtx) {
    const entry = live.get(id);
    if (!entry || entry.state !== 'enabled') throw new Error(`plugin ${id} is not enabled`);
    const handler = entry.module?.jobs?.[name];
    if (typeof handler !== 'function') throw new Error(`plugin ${id} does not export job "${name}"`);
    const def = entry.manifest.jobs[name] || {};
    const ac = new AbortController();
    const run = { ac, cancelled: false, coreCtx };
    entry.running.set(coreCtx.job.id, run);
    const params = deepFreeze(clone(isObj(coreCtx.params) && 'params' in coreCtx.params ? coreCtx.params.params : coreCtx.params) || {});
    const job = {
      id: String(coreCtx.job.id), name, params, signal: ac.signal,
      progress: (pct, msg) => setProgress(run, pct, msg),
      log: (msg) => coreCtx.log(String(msg)),
      get cancelled() { return run.cancelled; },
    };
    let timer = null;
    try {
      const work = handler(job, entry.ctx);
      const timeout = def.timeoutSec ? new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new E.PluginError(`job "${name}" exceeded ${def.timeoutSec}s`, { code: 'JOB_TIMEOUT', status: 504 })); }, def.timeoutSec * 1000); timer.unref(); }) : null;
      const result = timeout ? await Promise.race([work, timeout]) : await work;
      if (run.cancelled) throw new E.PluginError('cancelled', { code: 'JOB_CANCELLED', status: 409 });
      return result === undefined ? null : clone(result);
    } catch (err) {
      if (run.cancelled) throw new E.PluginError('cancelled', { code: 'JOB_CANCELLED', status: 409 });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      entry.running.delete(coreCtx.job.id);
    }
  }
  function cancelJob(entry, j) {
    if (j.status !== 'running' && j.status !== 'queued') return false;
    const name = j.type.slice(jobType(entry.id, '').length);
    if (entry.manifest.jobs?.[name]?.cancellable === false) throw new E.ConflictError(`job "${name}" is not cancellable`);
    if (j.status === 'queued') {
      try { ctx.jobs.cancel(j.id); } catch { return false; }
      return true;
    }
    abortRun(entry, j.id);
    return true;
  }
  // The row flips to cancelled right away (the mock's immediate transition); the
  // core worker still records done/failed when the handler settles, so the row
  // is corrected again then.
  function abortRun(entry, jobId) {
    const run = entry.running.get(jobId);
    if (run) { run.cancelled = true; run.ac.abort(); }
    stmts.jobCancelRunning.run(jobId);
    const off = ctx.jobs.subscribe(jobId, (ev) => { if (ev.type === 'done' || ev.type === 'failed') { stmts.jobCancelled.run(jobId); off(); } });
  }
  function jobsApi(entry) {
    return {
      async run(name, params) { gate(entry, 'jobs', 'ctx.jobs.run'); return String(enqueueJob(entry, name, params, 'manual').id); },
      async progress(jobId, pct, msg) { gate(entry, 'jobs', 'ctx.jobs.progress'); const j = ownJob(entry, jobId); setProgress(j.status === 'running' ? entry.running.get(j.id) : null, pct, msg); },
      async status(jobId) { gate(entry, 'jobs', 'ctx.jobs.status'); return shapeJob(entry, ownJob(entry, jobId)); },
      async cancel(jobId) { gate(entry, 'jobs', 'ctx.jobs.cancel'); return cancelJob(entry, ownJob(entry, jobId)); },
    };
  }

  // ------------------------------------------------------------------ schedule
  const schedPrefix = (id) => `plugin:${id}:`;
  const manifestSchedName = (id, cronName) => `${schedPrefix(id)}${cronName}`;
  const runtimeSchedName = (id, jobName) => `${schedPrefix(id)}runtime:${jobName}`;
  function resolveSchedule(entry, schedule) {
    if (schedule.startsWith('setting:')) {
      const v = readSetting(entry, schedule.slice('setting:'.length));
      return v || null;
    }
    return schedule;
  }
  function parseCron(expr) {
    return cron.parse(expr).expr; // throws the SDK's CronError (a ValidationError)
  }
  function addSchedule(entry, name, expr, jobName, params, trigger) {
    const parsed = parseCron(expr);
    ctx.scheduler.remove(name);
    ctx.scheduler.ensure(name, parsed, jobType(entry.id, jobName), { trigger, params: clone(params || {}) });
    return ctx.scheduler.listPrefix(name).find((r) => r.name === name);
  }
  function shapeSchedule(entry, r) {
    const rest = r.name.slice(schedPrefix(entry.id).length);
    const runtime = rest.startsWith('runtime:');
    return {
      id: String(r.id), name: runtime ? r.job_type.slice(jobType(entry.id, '').length) : rest, jobName: r.job_type.slice(jobType(entry.id, '').length), expr: r.cron,
      params: r.params?.params || {}, nextRunAt: toMs(r.next_run_at), lastRunAt: toMs(r.last_run_at), source: runtime ? 'runtime' : 'manifest', enabled: Boolean(r.enabled),
    };
  }
  function syncManifestCron(entry, onlyKey) {
    for (const c of entry.manifest.cron || []) {
      if (onlyKey !== undefined && c.schedule !== `setting:${onlyKey}`) continue;
      const name = manifestSchedName(entry.id, c.name);
      ctx.scheduler.remove(name);
      if (c.enabled === false) continue;
      const expr = resolveSchedule(entry, c.schedule);
      if (!expr) continue;
      try { addSchedule(entry, name, expr, c.job, c.params, `cron:${c.name}`); } catch (err) { writeLog(entry, 'error', `cron "${c.name}" has an invalid schedule`, { error: err.message }); }
    }
  }
  const rebindSettingSchedules = (entry, key) => syncManifestCron(entry, key);
  function removeSchedules(entry) {
    for (const r of ctx.scheduler.listPrefix(schedPrefix(entry.id))) ctx.scheduler.remove(r.name);
  }
  function scheduleApi(entry) {
    return {
      async cron(expr, jobName, params) {
        gate(entry, 'schedule', 'ctx.schedule.cron');
        checkJobName(entry, jobName);
        if (params !== undefined && !isObj(params)) throw new E.ValidationError('params must be an object');
        const name = runtimeSchedName(entry.id, jobName);
        if (ctx.scheduler.listPrefix(name).some((r) => r.name === name)) throw new E.ConflictError(`job "${jobName}" already has a runtime schedule; unschedule it first`);
        const row = addSchedule(entry, name, expr, jobName, params, `cron:${jobName}`);
        return { id: String(row.id), jobName, expr: row.cron, nextRunAt: toMs(row.next_run_at) };
      },
      async unschedule(jobName) { gate(entry, 'schedule', 'ctx.schedule.unschedule'); return ctx.scheduler.remove(runtimeSchedName(entry.id, jobName)); },
      async list() { gate(entry, 'schedule', 'ctx.schedule.list'); return ctx.scheduler.listPrefix(schedPrefix(entry.id)).map((r) => shapeSchedule(entry, r)); },
    };
  }

  // ------------------------------------------------------------------ events
  const DELIVERED = 'plugin:delivered';
  function subscribe(entry, event, stage, fn, label) {
    if (entry.state !== 'activating' && entry.state !== 'enabled') throw new E.LifecycleError('event handlers can only be registered while the plugin is active');
    const def = V.EVENTS[event];
    const cancellable = Boolean(def && stage === 'pre' && def.cancellable);
    const listener = async (envelope) => {
      if ((envelope.stage || 'post') !== stage) return undefined;
      const evt = {
        name: event, stage, payload: deepFreeze(clone(envelope.payload || {})), ts: toMs(envelope.at) ?? Date.now(), principal: envelope.principal ?? null, cancellable,
        cancel(reason) {
          if (!cancellable) throw new E.PluginError(`hook ${stage}:${event} is not cancellable`, { code: 'HOOK_NOT_CANCELLABLE', status: 409 });
          gate(entry, def.cancelScope, 'evt.cancel');
          throw new E.HookCancelled(String(reason || 'cancelled by plugin'), event);
        },
      };
      // A handler that never settles would hang the panel request that emitted the
      // event, so every delivery is raced against a timeout. A timed-out pre hook
      // of a plugin that holds the cancel scope vetoes the operation: skipping its
      // judgement would silently bypass the policy it exists to enforce, and the
      // operator sees the error and can disable the plugin. Without that scope the
      // plugin could not have cancelled anyway, so the timeout is only logged.
      const timeoutMs = Number(config.pluginHookTimeoutMs) > 0 ? Number(config.pluginHookTimeoutMs) : HOOK_TIMEOUT_MS;
      let timer = null;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new E.PluginError(`hook ${label} did not settle within ${timeoutMs} ms`, { code: 'HOOK_TIMEOUT', status: 504 })), timeoutMs); timer.unref(); });
      try {
        await Promise.race([fn(evt, entry.ctx), timeout]);
        return DELIVERED;
      } catch (err) {
        if (err instanceof E.HookCancelled) throw new HttpError(409, 'hook_rejected', `${entry.manifest.name}: ${err.reason}`);
        if (err?.code === 'HOOK_TIMEOUT') {
          entry.hookTimeouts.push({ event, stage, handler: label, timeoutMs, ts: Date.now() });
          if (entry.hookTimeouts.length > 50) entry.hookTimeouts.shift();
          writeLog(entry, 'error', `hook handler ${label} timed out for ${stage}:${event}`, { timeoutMs });
          if (stage === 'pre' && cancellable && entry.granted.has(def.cancelScope)) throw new HttpError(409, 'hook_rejected', `${entry.manifest.name}: hook ${label} timed out after ${timeoutMs} ms`);
          return { error: err.message };
        }
        writeLog(entry, 'error', `hook handler ${label} threw for ${stage}:${event}`, { error: err.message, code: err.code });
        return { error: err.message };
      } finally {
        clearTimeout(timer);
      }
    };
    const off = bus().on(event, listener);
    const sub = { event, stage, fn, label, off };
    entry.subscribers.push(sub);
    return sub;
  }
  function unsubscribeAll(entry) {
    for (const s of entry.subscribers.splice(0)) { try { s.off(); } catch { /* bus gone */ } }
  }
  function eventsApi(entry) {
    const req = requestOf(entry);
    const events = {
      on(event, handler, { stage = 'post' } = {}) {
        if (typeof handler !== 'function') throw new E.ValidationError('handler must be a function');
        if (!V.isKnownEvent(event) && !V.isPluginEvent(event)) throw new E.ValidationError(`unknown event "${event}"`);
        if (!V.HOOK_STAGES.includes(stage)) throw new E.ValidationError('stage must be "pre" or "post"');
        if (V.isKnownEvent(event) && !V.EVENTS[event].stages.includes(stage)) throw new E.ValidationError(`event "${event}" has no "${stage}" stage`);
        if (V.isPluginEvent(event) && stage !== 'post') throw new E.ValidationError('plugin events only have a "post" stage');
        subscribe(entry, event, stage, handler, 'events.on');
        return () => events.off(event, handler);
      },
      // Manifest hooks are not reachable from off(): a plugin cannot detach a
      // policy its manifest declares by passing the same function.
      off(event, handler) {
        const i = entry.subscribers.findIndex((s) => s.label === 'events.on' && s.event === event && s.fn === handler);
        if (i === -1) return false;
        const [s] = entry.subscribers.splice(i, 1);
        s.off();
        return true;
      },
      async emit(event, payload = {}) {
        gate(entry, 'events:emit', 'ctx.events.emit');
        if (typeof event !== 'string' || !V.isPluginEvent(event)) throw new E.ValidationError(`event must look like "<pluginId>.<name>" (got ${JSON.stringify(event)})`);
        if (!event.startsWith(`${entry.id}.`)) throw new E.PermissionError(`events:emit:${event}`, 'ctx.events.emit', entry.id);
        if (!isObj(payload)) throw new E.ValidationError('payload must be an object');
        checkValue(payload, 'event payload');
        const r = await bus().emit(event, clone(payload), { stage: 'post', req });
        return { delivered: (r.results || []).filter((x) => x === DELIVERED).length };
      },
    };
    return events;
  }

  // ------------------------------------------------------------------ http
  function httpApi(entry) {
    const register = (method, routePath, a, b) => {
      gate(entry, 'api:routes', `ctx.http.${method.toLowerCase()}`);
      if (!entry.routesOpen) throw new E.LifecycleError('routes can only be registered during routes()/activate()');
      if (typeof routePath !== 'string' || !V.API_ROUTE_PATTERN.test(routePath)) throw new E.ValidationError(`route path "${routePath}" must match ${V.API_ROUTE_PATTERN}`);
      const options = typeof a === 'function' ? {} : (a || {});
      const handler = typeof a === 'function' ? a : b;
      if (typeof handler !== 'function') throw new E.ValidationError('route handler must be a function');
      const roles = options.roles || ['root'];
      if (!Array.isArray(roles) || roles.some((r) => !['root', 'reseller', 'user'].includes(r))) throw new E.ValidationError('roles must be a subset of root|reseller|user');
      if (entry.routes.some((r) => r.method === method && r.path === routePath)) throw new E.ConflictError(`route ${method} ${routePath} already registered`);
      entry.routes.push({ method, path: routePath, roles: roles.slice(), handler, ...compilePath(routePath) });
    };
    return {
      baseUrl: `/api/plugins/${entry.id}`,
      get: (p, a, b) => register('GET', p, a, b),
      post: (p, a, b) => register('POST', p, a, b),
      put: (p, a, b) => register('PUT', p, a, b),
      patch: (p, a, b) => register('PATCH', p, a, b),
      delete: (p, a, b) => register('DELETE', p, a, b),
    };
  }

  // Express handler for /api/plugins/:id/* (mounted after requireAuth).
  async function dispatch(id, req, res) {
    const entry = live.get(id);
    const m = String(req.method).toUpperCase();
    const routePath = req.path || '/';
    if (!entry || entry.state !== 'enabled') { res.status(404).json({ error: { code: 'NOT_FOUND', message: `plugin "${id}" is not enabled` } }); return; }
    const route = entry.routes.find((r) => r.method === m && r.re.test(routePath));
    if (!route) { res.status(404).json({ error: { code: 'NOT_FOUND', message: `no route ${m} ${routePath}` } }); return; }
    const principal = req.user;
    if (!route.roles.includes(principal.role)) { res.status(403).json({ error: { code: 'FORBIDDEN', message: `role "${principal.role}" may not call ${m} ${routePath}` } }); return; }
    const match = route.re.exec(routePath);
    const pathParams = {};
    try {
      route.keys.forEach((k, i) => { pathParams[k] = decodeURIComponent(match[i + 1]); });
    } catch {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'malformed path parameter' } });
      return;
    }
    const { cookie, authorization, ...headers } = req.headers; // eslint-disable-line no-unused-vars
    const facadeReq = {
      method: m, path: routePath, params: pathParams, query: clone(req.query) || {}, body: Buffer.isBuffer(req.body) ? req.body : clone(req.body),
      user: { id: principal.id, username: principal.username, role: principal.role }, headers: clone(headers) || {}, requestId: req.id, plugin: entry.id, ip: req.ip,
    };
    const state = { statusCode: 200, sent: false };
    const send = (status, payload) => {
      state.sent = true;
      if (payload === undefined) res.status(status).end();
      else if (typeof payload === 'string') res.status(status).type(res.get('content-type') || 'text/plain').send(payload);
      else res.status(status).json(payload);
    };
    const facadeRes = {
      status(code) { if (!Number.isInteger(code) || code < 100 || code > 599) throw new E.ValidationError('invalid status code'); state.statusCode = code; return facadeRes; },
      set(name, value) {
        const header = String(name).trim();
        if (!/^[A-Za-z0-9-]+$/.test(header) || BLOCKED_RESPONSE_HEADERS.test(header)) throw new E.ValidationError(`plugin routes may not set the "${header}" header`);
        if (header.toLowerCase() === 'content-type' && !STRING_BODY_TYPES.test(String(value))) throw new E.ValidationError('plugin routes may only send text/plain or application/json bodies');
        res.set(header, String(value));
        return facadeRes;
      },
      json(data) { if (state.sent) throw new E.ConflictError('response already sent'); send(state.statusCode, state.statusCode >= 400 ? data : { data }); },
      send(text) { if (state.sent) throw new E.ConflictError('response already sent'); send(state.statusCode, String(text)); },
      error(code, message, status = 400) { if (state.sent) throw new E.ConflictError('response already sent'); send(status, { error: { code, message } }); },
    };
    try {
      await route.handler(facadeReq, facadeRes);
      if (!state.sent) send(204, undefined);
    } catch (err) {
      const status = err instanceof E.PluginError ? err.status : 500;
      const payload = err instanceof E.PluginError ? err.toJSON() : { code: 'INTERNAL', message: 'plugin route failed' };
      writeLog(entry, 'error', `route ${m} ${routePath} threw`, { error: err.message, code: payload.code });
      if (!state.sent) send(status, { error: payload });
    }
  }

  // ------------------------------------------------------------------ ui
  function uiApi(entry) {
    return {
      async registerPage(descriptor) {
        gate(entry, 'ui:sidebar', 'ctx.ui.registerPage');
        if (!entry.pagesOpen) throw new E.LifecycleError('pages can only be registered during activate()');
        const c = { errors: [], add(p, code, message) { this.errors.push({ path: p, code, message }); } };
        V.validatePageDescriptor(descriptor, 'page', c, { jobs: Object.keys(entry.manifest.jobs || {}), hasSettings: settingFields(entry).length > 0 });
        if (c.errors.length) throw new E.ValidationError('invalid page descriptor', c.errors);
        if (entry.pages.some((p) => p.route === descriptor.route)) throw new E.ConflictError(`page route "${descriptor.route}" already registered`);
        entry.pages.push({ ...clone(descriptor), source: 'runtime' });
      },
    };
  }

  // ------------------------------------------------------------------ crypto
  function cryptoApi(entry) {
    const master = Buffer.from(config.masterKeyHex, 'hex');
    const key = Buffer.from(crypto.hkdfSync('sha256', master, 'whm-plugin-crypto', entry.id, 32));
    return {
      async encrypt(plaintext) {
        gate(entry, 'crypto:own', 'ctx.crypto.encrypt');
        if (typeof plaintext !== 'string') throw new E.ValidationError('encrypt expects a string');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return `whm1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
      },
      async decrypt(ciphertext) {
        gate(entry, 'crypto:own', 'ctx.crypto.decrypt');
        if (typeof ciphertext !== 'string' || !ciphertext.startsWith('whm1:')) throw new E.ValidationError('ciphertext must be a "whm1:" string produced by ctx.crypto.encrypt');
        const buf = Buffer.from(ciphertext.slice(5), 'base64');
        if (buf.length < 28) throw new E.ValidationError('ciphertext too short');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(12, 28));
        try { return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'); } catch { throw new E.ValidationError('ciphertext authentication failed'); }
      },
      randomToken(bytes = 32) {
        gate(entry, 'crypto:own', 'ctx.crypto.randomToken');
        if (!Number.isInteger(bytes) || bytes < 8 || bytes > 1024) throw new E.ValidationError('bytes must be an integer 8..1024');
        return crypto.randomBytes(bytes).toString('hex');
      },
      sha256(input) {
        gate(entry, 'crypto:own', 'ctx.crypto.sha256');
        if (typeof input !== 'string' && !Buffer.isBuffer(input)) throw new E.ValidationError('sha256 expects a string or Buffer');
        return crypto.createHash('sha256').update(input).digest('hex');
      },
    };
  }

  // ------------------------------------------------------------------ fs
  function safeRel(rel) {
    if (typeof rel !== 'string' || rel.length === 0) throw new E.PathError('path must be a non-empty string', rel);
    if (rel.includes('\0')) throw new E.PathError('path contains a NUL byte', rel);
    if (rel.includes('\\')) throw new E.PathError('backslashes are not allowed in paths', rel);
    if (path.posix.isAbsolute(rel)) throw new E.PathError('absolute paths are not allowed; paths are relative to ctx.plugin.dataDir', rel);
    const norm = path.posix.normalize(rel);
    if (norm === '..' || norm.startsWith('../')) throw new E.PathError('path escapes the plugin data directory', rel);
    return norm === '.' ? '' : norm.replace(/\/+$/, '');
  }
  function fsApi(entry) {
    const root = entry.dataDir;
    const resolve = (rel) => {
      const p = safeRel(rel);
      let cur = root;
      for (const seg of p === '' ? [] : p.split('/')) {
        cur = path.join(cur, seg);
        let st = null;
        try { st = fs.lstatSync(cur); } catch { break; }
        if (st.isSymbolicLink()) throw new E.PathError('symbolic links are not allowed inside the plugin data directory', rel);
      }
      return { p, abs: path.join(root, p) };
    };
    const lstat = (abs) => { try { return fs.lstatSync(abs); } catch { return null; } };
    const assertParentsAreDirs = (p, rel) => {
      let cur = root;
      for (const seg of p.split('/').slice(0, -1)) {
        cur = path.join(cur, seg);
        const st = lstat(cur);
        if (st && !st.isDirectory()) throw new E.PathError('a parent of the path is a file', rel);
      }
    };
    return {
      async readFile(rel, { encoding = 'utf8' } = {}) {
        gate(entry, 'fs:own', 'ctx.fs.readFile');
        const { abs } = resolve(rel);
        const st = lstat(abs);
        if (!st) throw new E.NotFoundError('file', rel);
        if (st.isDirectory()) throw new E.PathError('path is a directory', rel);
        const buf = fs.readFileSync(abs);
        return encoding === null || encoding === 'buffer' ? buf : buf.toString(encoding);
      },
      async writeFile(rel, data) {
        gate(entry, 'fs:own', 'ctx.fs.writeFile');
        const { p, abs } = resolve(rel);
        if (p === '') throw new E.PathError('cannot write to the data directory itself', rel);
        if (typeof data !== 'string' && !Buffer.isBuffer(data)) throw new E.ValidationError('writeFile expects a string or Buffer');
        const st = lstat(abs);
        if (st?.isDirectory()) throw new E.PathError('path is a directory', rel);
        assertParentsAreDirs(p, rel);
        const delta = Buffer.byteLength(data) - (st ? st.size : 0);
        if (dirUsage(root) + delta > MAX_FS_BYTES) throw new E.PluginError('plugin data directory quota exceeded', { code: 'QUOTA_EXCEEDED', status: 507 });
        fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o750 });
        fs.writeFileSync(abs, data, { mode: 0o640 });
      },
      async list(rel = '.') {
        gate(entry, 'fs:own', 'ctx.fs.list');
        const { p, abs } = resolve(rel);
        const st = lstat(abs);
        if (!st) { if (p === '') return []; throw new E.NotFoundError('directory', rel); }
        if (!st.isDirectory()) return [];
        return fs.readdirSync(abs, { withFileTypes: true })
          .filter((d) => d.isFile() || d.isDirectory())
          .map((d) => { const s = fs.lstatSync(path.join(abs, d.name)); return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size: d.isDirectory() ? 0 : s.size, mtime: s.mtimeMs }; })
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      async remove(rel, { recursive = false } = {}) {
        gate(entry, 'fs:own', 'ctx.fs.remove');
        const { p, abs } = resolve(rel);
        if (p === '') throw new E.PathError('cannot remove the data directory itself', rel);
        const st = lstat(abs);
        if (!st) return false;
        if (!st.isDirectory()) { fs.unlinkSync(abs); return true; }
        if (fs.readdirSync(abs).length > 0 && !recursive) throw new E.PathError('path is a non-empty directory; pass { recursive: true }', rel);
        fs.rmSync(abs, { recursive: true, force: true });
        return true;
      },
      async exists(rel) { gate(entry, 'fs:own', 'ctx.fs.exists'); const { p, abs } = resolve(rel); return p === '' ? true : lstat(abs) !== null; },
      async mkdir(rel) {
        gate(entry, 'fs:own', 'ctx.fs.mkdir');
        const { p, abs } = resolve(rel);
        if (p !== '') assertParentsAreDirs(`${p}/`, rel);
        if (lstat(abs)?.isDirectory() === false) throw new E.PathError('path is a file', rel);
        fs.mkdirSync(abs, { recursive: true, mode: 0o750 });
      },
    };
  }

  // ------------------------------------------------------------------ net
  const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];
  function stripCredentialHeaders(headers) {
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      const copy = new Headers(headers);
      for (const h of CREDENTIAL_HEADERS) copy.delete(h);
      return copy;
    }
    if (Array.isArray(headers)) return headers.filter(([k]) => !CREDENTIAL_HEADERS.includes(String(k).toLowerCase()));
    if (isObj(headers)) return Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.includes(k.toLowerCase())));
    return headers;
  }
  function netApi(entry) {
    return {
      async fetch(url, init = {}) {
        const check = (u) => {
          if (u.protocol !== 'https:') throw new E.ValidationError('ctx.net.fetch only allows https: URLs');
          const scope = V.matchesNetScope(u.hostname, u.port || '443', [...entry.granted]);
          if (!scope) {
            const wanted = `net:outbound:${u.hostname}${u.port ? `:${u.port}` : ''}`;
            recordDenial(entry, wanted, 'ctx.net.fetch');
            throw new E.PermissionError(wanted, 'ctx.net.fetch', entry.id);
          }
          useScope(entry, scope);
        };
        let u;
        try { u = new URL(String(url)); } catch { throw new E.ValidationError(`invalid URL ${JSON.stringify(url)}`); }
        check(u);
        const doFetch = globalThis.fetch;
        if (typeof doFetch !== 'function') throw new E.PluginError('outbound HTTP is not available in this runtime', { code: 'SERVICE_UNAVAILABLE', status: 503 });
        let current = u;
        let hopInit = { ...init };
        for (let hop = 0; hop <= 3; hop++) {
          const response = await doFetch(current.toString(), { ...hopInit, redirect: 'manual', signal: init.signal || AbortSignal.timeout(30_000) });
          const location = response.status >= 300 && response.status < 400 ? response.headers?.get?.('location') : null;
          if (!location) return response;
          if (hop === 3) throw new E.PluginError('too many redirects', { code: 'TOO_MANY_REDIRECTS', status: 502 });
          const previous = current;
          current = new URL(location, current);
          check(current);
          // Like fetch's "follow" mode: 301/302/303 turn the request into a body-less GET; 307/308 replay it,
          // and credentials never travel to another origin.
          if (response.status === 301 || response.status === 302 || response.status === 303) {
            const { body, ...rest } = hopInit; // eslint-disable-line no-unused-vars
            hopInit = { ...rest, method: 'GET' };
          }
          if (current.origin !== previous.origin && hopInit.headers) hopInit = { ...hopInit, headers: stripCredentialHeaders(hopInit.headers) };
        }
        return undefined;
      },
    };
  }

  // ------------------------------------------------------------------ i18n
  function loadLocales(entry) {
    const dirName = (entry.manifest.i18n && entry.manifest.i18n.dir) || 'locales';
    const dir = path.join(entry.dir, dirName);
    const out = {};
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
      if (!/^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f)) continue;
      try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (err) { writeLog(entry, 'warn', `locale file ${f} is not valid JSON`, { error: err.message }); }
    }
    return out;
  }
  function i18nApi(entry) {
    const locale = (entry.manifest.i18n && entry.manifest.i18n.default) || 'en';
    return {
      locale: () => locale,
      t(key, vars = {}, loc = locale) {
        if (typeof key !== 'string') throw new E.ValidationError('i18n key must be a string');
        const table = entry.locales[loc] || {};
        const fallback = entry.locales[locale] || {};
        const raw = table[key] !== undefined ? table[key] : fallback[key] !== undefined ? fallback[key] : key;
        return String(raw).replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined ? String(vars[name]) : m));
      },
    };
  }

  // ------------------------------------------------------------------ ctx
  function buildCtx(entry) {
    const m = entry.manifest;
    return Object.freeze({
      plugin: Object.freeze({ id: entry.id, version: m.version, dir: entry.dir, dataDir: entry.dataDir, hostVersion: HOST_API_VERSION, isolation: m.isolation || 'in-process' }),
      log: Object.freeze({
        debug: (msg, fields) => writeLog(entry, 'debug', msg, fields),
        info: (msg, fields) => writeLog(entry, 'info', msg, fields),
        warn: (msg, fields) => writeLog(entry, 'warn', msg, fields),
        error: (msg, fields) => writeLog(entry, 'error', msg, fields),
      }),
      settings: Object.freeze(settingsApi(entry)),
      store: Object.freeze(storeApi(entry)),
      api: deepFreeze(apiFor(entry)),
      agent: Object.freeze(agentApi(entry)),
      jobs: Object.freeze(jobsApi(entry)),
      schedule: Object.freeze(scheduleApi(entry)),
      events: Object.freeze(eventsApi(entry)),
      http: Object.freeze(httpApi(entry)),
      ui: Object.freeze(uiApi(entry)),
      crypto: Object.freeze(cryptoApi(entry)),
      fs: Object.freeze(fsApi(entry)),
      net: Object.freeze(netApi(entry)),
      i18n: Object.freeze(i18nApi(entry)),
      errors: Object.freeze({ ...E }),
      now: () => Date.now(),
    });
  }

  // ------------------------------------------------------------------ module loading
  function loadModule(entry) {
    const realDir = fs.realpathSync(entry.dir);
    const mainFile = path.resolve(entry.dir, entry.manifest.main);
    if (mainFile !== realDir && !fs.realpathSync(mainFile).startsWith(realDir + path.sep)) throw new E.ValidationError('manifest.main resolves outside the plugin directory');
    const resolve = (spec, from, target) => {
      if (target) {
        let real;
        try { real = fs.realpathSync(target); } catch { throw new E.PluginError(`cannot resolve "${spec}" from ${path.relative(entry.dir, from)}`, { code: 'MODULE_NOT_FOUND', status: 500 }); }
        if (real !== realDir && !real.startsWith(realDir + path.sep)) throw new E.PermissionError(`require:${spec}`, 'require', entry.id);
        return undefined;
      }
      if (spec === 'whm/plugins/sdk') return sdkExports;
      const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
      if (BUILTIN_REQUIRES.has(bare)) return requireBuiltin(bare);
      throw new E.PermissionError(`require:${spec}`, 'require', entry.id);
    };
    const consoleLog = (level) => (...args) => { try { writeLog(entry, level, util.format(...args)); } catch { /* never let console throw into plugin code */ } };
    const pluginConsole = Object.freeze({ log: consoleLog('info'), info: consoleLog('info'), warn: consoleLog('warn'), error: consoleLog('error'), debug: consoleLog('debug'), trace: consoleLog('debug') });
    const context = createPluginContext({ console: pluginConsole });
    return loadCommonJs(mainFile, new Map(), { resolve, context });
  }

  // ------------------------------------------------------------------ lifecycle
  function persistState(id, state, lastError = null) {
    stmts.setState.run(state, lastError ? JSON.stringify(lastError) : null, state, id);
  }
  function fail(entry, err) {
    entry.state = 'errored';
    entry.lastError = { code: err.code || 'ACTIVATE_FAILED', message: err.message };
    try { writeLog(entry, 'error', 'plugin activation failed', { error: err.message, code: err.code }); } catch { /* best effort */ }
    rollback(entry);
    persistState(entry.id, 'errored', entry.lastError);
    live.set(entry.id, entry);
    return { ok: false, error: entry.lastError };
  }
  function rollback(entry) {
    unsubscribeAll(entry);
    try { removeSchedules(entry); } catch { /* scheduler unavailable */ }
    for (const jobId of [...entry.running.keys()]) abortRun(entry, jobId);
    entry.routes.length = 0;
    entry.pages.length = 0;
    entry.settingListeners.length = 0;
    entry.routesOpen = false;
    entry.pagesOpen = false;
  }
  function emitHost(event, payload) {
    try { bus().emit(event, payload, { stage: 'post' }).catch(() => {}); } catch { /* bus unavailable */ }
  }

  async function activate(entry, { from } = {}) {
    const mod = entry.module;
    const m = entry.manifest;
    if (!isObj(mod) && typeof mod !== 'function') return fail(entry, new E.ValidationError('plugin entry module must export an object'));
    if (!semver.satisfies(HOST_API_VERSION, m.engines.whm)) return fail(entry, new E.IncompatibleError(entry.id, m.engines.whm, HOST_API_VERSION));
    for (const h of m.hooks || []) {
      if (!mod.hooks || typeof mod.hooks[h.handler] !== 'function') return fail(entry, new E.ValidationError(`manifest hook handler "${h.handler}" is not exported in module.exports.hooks`));
    }
    for (const name of Object.keys(m.jobs || {})) {
      if (!mod.jobs || typeof mod.jobs[name] !== 'function') return fail(entry, new E.ValidationError(`manifest job "${name}" is not exported in module.exports.jobs`));
    }
    for (const k of ['activate', 'deactivate', 'routes', 'migrate']) {
      if (mod[k] !== undefined && typeof mod[k] !== 'function') return fail(entry, new E.ValidationError(`module.exports.${k} must be a function`));
    }
    if ((m.isolation || 'in-process') === 'process' && !processIsolationWarned) {
      processIsolationWarned = true;
      log.warn({ plugin: entry.id }, 'isolation "process" is not available yet; the plugin runs in-process');
    }
    entry.state = 'activating';
    entry.routesOpen = true;
    entry.pagesOpen = true;
    // The whole sequence races a timeout: a routes()/migrate()/activate() that
    // never settles must not keep the panel from booting or the operator from
    // reaching Manage Plugins. Once the timeout has won, a late step finds the
    // entry errored and stops instead of registering into a rolled-back plugin.
    const timeoutMs = Number(config.pluginActivateTimeoutMs) > 0 ? Number(config.pluginActivateTimeoutMs) : ACTIVATE_TIMEOUT_MS;
    const stillActivating = () => { if (entry.state !== 'activating') throw new E.LifecycleError('activation was aborted'); };
    let timer = null;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new E.PluginError(`activation did not settle within ${timeoutMs} ms`, { code: 'ACTIVATE_TIMEOUT', status: 504 })), timeoutMs); timer.unref(); });
    const sequence = (async () => {
      fs.mkdirSync(entry.dataDir, { recursive: true, mode: 0o750 });
      entry.locales = loadLocales(entry);
      for (const name of Object.keys(m.jobs || {})) ctx.jobs.register(jobType(entry.id, name), (coreCtx) => runPluginJob(entry.id, name, coreCtx));
      for (const h of m.hooks || []) subscribe(entry, h.event, h.stage || 'post', mod.hooks[h.handler], `hooks.${h.handler}`);
      if (typeof mod.routes === 'function') await mod.routes(entry.ctx.http, entry.ctx);
      stillActivating();
      for (const pg of (m.ui && m.ui.pages) || []) {
        if (!entry.pages.some((p) => p.route === pg.route)) entry.pages.push({ ...clone(pg), source: 'manifest' });
      }
      syncManifestCron(entry);
      if (from !== undefined) {
        if (!semver.valid(from)) throw new E.ValidationError(`fromVersion "${from}" is not semver`);
        if (typeof mod.migrate === 'function') await mod.migrate(entry.ctx, from);
        stillActivating();
      }
      if (typeof mod.activate === 'function') await mod.activate(entry.ctx);
      stillActivating();
    })();
    sequence.catch(() => {});
    try {
      await Promise.race([sequence, timeout]);
    } catch (err) {
      return fail(entry, err);
    } finally {
      clearTimeout(timer);
      entry.routesOpen = false;
      entry.pagesOpen = false;
    }
    entry.state = 'enabled';
    entry.lastError = null;
    persistState(entry.id, 'enabled');
    return { ok: true };
  }

  async function deactivate(entry) {
    try {
      if (entry.module && typeof entry.module.deactivate === 'function') await entry.module.deactivate(entry.ctx);
    } catch (err) {
      writeLog(entry, 'error', 'deactivate() threw', { error: err.message });
    } finally {
      rollback(entry);
      entry.state = 'stopped';
    }
  }

  function requireRow(id) {
    const row = stmts.row.get(id);
    if (!row) throw notFound(`Plugin "${id}"`);
    return row;
  }

  // Callers (the marketplace client) may veto an activation: every guard runs
  // with (id, row) and a thrown HttpError reaches the manage route unchanged.
  const guards = { enable: [] };

  // One activation per id at a time: a second caller awaits the first instead of
  // registering hooks and schedules twice.
  async function enable(id, options = {}) {
    requireSdk();
    const row = requireRow(id);
    if (live.get(id)?.state !== 'enabled') for (const guard of guards.enable) await guard(id, row);
    const pending = activations.get(id);
    if (pending) return pending;
    const p = enableNow(id, options).finally(() => { if (activations.get(id) === p) activations.delete(id); });
    activations.set(id, p);
    return p;
  }

  async function enableNow(id, { from, req } = {}) {
    const row = requireRow(id);
    const existing = live.get(id);
    if (existing && (existing.state === 'enabled' || existing.state === 'activating')) return shapeRow(stmts.row.get(id));
    if (existing) live.delete(id);
    if (!json.parse(row.manifest_json, null)) {
      persistState(id, 'errored', { code: 'INVALID_MANIFEST', message: 'stored manifest is unreadable' });
      return shapeRow(stmts.row.get(id));
    }
    const entry = createEntry(row);
    live.set(id, entry);
    seedSettingDefaults(entry);
    try {
      entry.module = loadModule(entry);
    } catch (err) {
      fail(entry, err);
      return shapeRow(stmts.row.get(id));
    }
    const r = await activate(entry, { from });
    if (r.ok) {
      req?.audit?.({ action: 'plugin.enable', target: id });
      emitHost('plugin.enabled', { pluginId: id, version: entry.manifest.version });
    }
    return shapeRow(stmts.row.get(id));
  }

  async function disable(id, { req, keepState = false } = {}) {
    const row = requireRow(id);
    const entry = live.get(id);
    if (entry) {
      await deactivate(entry);
      live.delete(id);
    }
    if (!keepState) {
      persistState(id, 'disabled');
      req?.audit?.({ action: 'plugin.disable', target: id });
      emitHost('plugin.disabled', { pluginId: id, version: row.version });
    }
    return shapeRow(stmts.row.get(id));
  }

  async function uninstall(id, { purge = false, req } = {}) {
    const row = requireRow(id);
    if (live.has(id)) await disable(id, { keepState: true });
    const { dir, dataDir } = dirsOf(id);
    removeDir(dir);
    for (const r of ctx.scheduler.listPrefix(schedPrefix(id))) ctx.scheduler.remove(r.name);
    db.transaction(() => {
      stmts.remove.run(id);
      if (purge) {
        stmts.settingsPurge.run(id);
        stmts.kvPurge.run(id);
        stmts.docsPurge.run(id);
        stmts.logsPurge.run(id);
      }
    })();
    if (purge) removeDir(dataDir);
    req?.audit?.({ action: 'plugin.uninstall', target: id, args: { purge, version: row.version } });
    emitHost('plugin.uninstalled', { pluginId: id, version: row.version, purged: Boolean(purge) });
    return { id, uninstalled: true, purged: Boolean(purge) };
  }

  async function loadAll() {
    if (!sdk) { log.warn('plugins/sdk is not installed; the plugin host is inactive'); return []; }
    const results = [];
    for (const row of stmts.rows.all()) {
      if (row.state !== 'enabled') continue;
      try {
        results.push(await enable(row.id));
      } catch (err) {
        log.error({ err, plugin: row.id }, 'plugin failed to load');
        try { persistState(row.id, 'errored', { code: err.code || 'LOAD_FAILED', message: err.message }); } catch { /* db unavailable */ }
      }
    }
    return results;
  }

  async function stopAll() {
    for (const [id, entry] of [...live]) {
      try { await deactivate(entry); } catch (err) { log.error({ err, plugin: id }, 'plugin failed to stop'); }
      live.delete(id);
    }
  }

  // ------------------------------------------------------------------ install
  const bundledDir = path.join(REPO_ROOT, 'plugins');
  function assertInstallRoot(real) {
    const allowed = [config.dataDir, bundledDir, ...INSTALL_ROOTS];
    const roots = allowed.map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
    if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) throw new HttpError(403, 'path_not_allowed', `Plugins may only be installed from ${allowed.join(', ')}`);
  }
  function assertInstallPath(p) {
    let real;
    try { real = fs.realpathSync(p); } catch { throw notFound(`Package file ${p}`); }
    assertInstallRoot(real);
    if (!fs.statSync(real).isFile()) throw err422('invalid_package', `${p} is not a file`);
    return real;
  }
  function assertInstallDir(p) {
    let real;
    try { real = fs.realpathSync(p); } catch { throw notFound(`Plugin directory ${p}`); }
    assertInstallRoot(real);
    if (!fs.statSync(real).isDirectory()) throw err422('invalid_package', `${p} is not a directory`);
    return real;
  }

  function copyTree(src, dst, counters = { entries: 0, bytes: 0 }) {
    fs.mkdirSync(dst, { recursive: true, mode: 0o750 });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, ent.name);
      const to = path.join(dst, ent.name);
      const st = fs.lstatSync(from);
      if (UNSAFE_NAME_CHARS.test(ent.name) || ent.name.includes('\\')) throw err422('invalid_package', `file names may not contain whitespace, control characters or backslashes (${JSON.stringify(ent.name)})`);
      if (st.isSymbolicLink()) throw err422('invalid_package', `plugin directories may not contain symbolic links (${ent.name})`);
      if (++counters.entries > 2000) throw err422('invalid_package', 'plugin has more than 2000 files');
      if (st.isDirectory()) { copyTree(from, to, counters); continue; }
      if (!st.isFile()) throw err422('invalid_package', `unsupported file type: ${ent.name}`);
      counters.bytes += st.size;
      if (counters.bytes > MAX_EXTRACTED_BYTES) throw err422('invalid_package', `plugin exceeds ${MAX_EXTRACTED_BYTES} bytes`);
      fs.copyFileSync(from, to);
    }
  }

  function unpackPackage(buffer, staging) {
    if (buffer.length > MAX_PACKAGE_BYTES) throw err422('invalid_package', `package exceeds ${MAX_PACKAGE_BYTES} bytes`);
    let tar;
    try { tar = zlib.gunzipSync(buffer, { maxOutputLength: MAX_EXTRACTED_BYTES + 1024 }); } catch (err) { throw err422('invalid_package', `package is not a gzip'ed tar: ${err.message}`); }
    try { extractTar(tar, staging, { maxBytes: MAX_EXTRACTED_BYTES }); } catch (err) {
      if (err instanceof TarError) throw err422('invalid_package', err.message, err.entry ? { entry: [err.entry] } : undefined);
      throw err;
    }
  }

  // A package may wrap everything in one top-level directory; that wrapper is stripped.
  function packageRoot(staging) {
    if (fs.existsSync(path.join(staging, 'plugin.json'))) return staging;
    const ents = fs.readdirSync(staging, { withFileTypes: true });
    if (ents.length === 1 && ents[0].isDirectory() && fs.existsSync(path.join(staging, ents[0].name, 'plugin.json'))) return path.join(staging, ents[0].name);
    throw err422('invalid_manifest', 'package has no plugin.json at its root');
  }

  // The marketplace client reports whether the hub row is on; a sideload then
  // needs developer mode (§18.6). Bundled and marketplace packages are exempt.
  function marketplaceEnabled() {
    try { return ctx.marketplace?.status?.().enabled === true; } catch { return false; }
  }

  // `policy` (marketplace installs): requireSigned demands a valid signature
  // from one of `signers` whatever plugins.require_signature says; install()
  // also honours policy.expectedId (manifest id must match) and policy.activate.
  function verifySignature(root, { source = 'upload', policy = null } = {}) {
    const sigFile = path.join(root, 'SIGNATURE.json');
    const bundled = source === 'bundled';
    const strict = policy?.requireSigned === true;
    const required = strict || (!bundled && ctx.settings.get('plugins.require_signature', false) === true);
    const sideloadGated = !bundled && source !== 'marketplace' && marketplaceEnabled() && ctx.settings.get('plugins.developer_mode', false) !== true;
    const unverifiable = ({ code, message, warnings }) => {
      if (strict) throw err422(code, message);
      if (required) throw err422('unsigned_package', message);
      if (sideloadGated) throw err422('unsigned_package', 'enable plugins.developer_mode to sideload while the marketplace is enabled');
      return { signed: false, signer: null, warnings: ['unsigned', ...warnings] };
    };
    if (!fs.existsSync(sigFile)) return unverifiable({ code: 'unsigned_package', message: strict ? 'Marketplace packages must carry a SIGNATURE.json from a hub signing key' : 'This server only accepts signed plugin packages (plugins.require_signature is on)', warnings: [] });
    let sig;
    try { sig = JSON.parse(fs.readFileSync(sigFile, 'utf8')); } catch { throw err422('invalid_signature', 'SIGNATURE.json is not valid JSON'); }
    if (!isObj(sig) || typeof sig.kid !== 'string' || !KID_RE.test(sig.kid) || sig.alg !== 'ed25519' || typeof sig.sig !== 'string') throw err422('invalid_signature', 'SIGNATURE.json must be { kid, alg: "ed25519", sig }');
    if (strict && Array.isArray(policy.signers) && !policy.signers.includes(sig.kid)) throw err422('untrusted_signer', `The package is signed with key "${sig.kid}", which is not a marketplace signing key this panel trusts`);
    const keyFile = path.join(keysDir, `${sig.kid}.pub`);
    if (!fs.existsSync(keyFile)) return unverifiable({ code: 'untrusted_signer', message: `No trusted key "${sig.kid}" in ${keysDir}; the package cannot be verified`, warnings: [`unknown signing key "${sig.kid}"`] });
    let key;
    try { key = crypto.createPublicKey(fs.readFileSync(keyFile, 'utf8')); } catch { throw err422('invalid_signature', `trusted key "${sig.kid}" is not a valid PEM public key`); }
    if (key.asymmetricKeyType !== 'ed25519') throw err422('invalid_signature', `trusted key "${sig.kid}" is not an Ed25519 key`);
    let ok = false;
    try { ok = crypto.verify(null, packageDigest(root), key, Buffer.from(sig.sig, 'base64')); } catch { ok = false; }
    if (!ok) throw err422('invalid_signature', 'The package signature does not match its contents');
    return { signed: true, signer: sig.kid, warnings: [] };
  }

  // `source: 'bundled'` is honoured only for directories that ship in the release.
  function isBundledDir(real) {
    let root = path.join(REPO_ROOT, 'plugins', 'bundled');
    try { root = fs.realpathSync(root); } catch { /* keep the nominal path */ }
    return real === root || real.startsWith(root + path.sep);
  }

  async function install(input, { user, req, policy = null } = {}) {
    requireSdk();
    fs.mkdirSync(pluginsDir, { recursive: true, mode: 0o750 });
    fs.mkdirSync(pluginDataDir, { recursive: true, mode: 0o750 });
    const stagingRoot = path.join(pluginsDir, '.staging');
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o750 });
    const staging = path.join(stagingRoot, crypto.randomBytes(8).toString('hex'));
    let source = 'upload';
    let packageSha = null;
    try {
      if (Buffer.isBuffer(input.buffer)) {
        if (input.source === 'marketplace') source = 'marketplace';
        packageSha = sha256Hex(input.buffer);
        unpackPackage(input.buffer, staging);
      } else if (typeof input.path === 'string') {
        source = 'path';
        const file = assertInstallPath(input.path);
        if (fs.statSync(file).size > MAX_PACKAGE_BYTES) throw err422('invalid_package', `package exceeds ${MAX_PACKAGE_BYTES} bytes`);
        const buffer = fs.readFileSync(file);
        packageSha = sha256Hex(buffer);
        unpackPackage(buffer, staging);
      } else if (typeof input.dir === 'string') {
        const real = assertInstallDir(input.dir);
        source = input.source === 'bundled' && isBundledDir(real) ? 'bundled' : 'path';
        copyTree(real, staging);
      } else {
        throw err422('invalid_package', 'Provide a .whmplugin body, { path } or { dir }');
      }
      const root = packageRoot(staging);
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')); } catch (err) { throw err422('invalid_manifest', `plugin.json is not valid JSON: ${err.message}`); }
      const vr = V.validateManifest(manifest);
      if (!vr.ok) throw err422('invalid_manifest', `plugin.json is invalid: ${vr.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, vr.errors);
      if (!semver.satisfies(HOST_API_VERSION, manifest.engines.whm)) throw err422('incompatible_host', `Plugin "${manifest.id}" requires WHM ${manifest.engines.whm} but this host provides ${HOST_API_VERSION}`);
      // Refused before any signature check or rename: a package the caller
      // requested under one id never touches a plugin installed under another.
      if (typeof policy?.expectedId === 'string' && manifest.id !== policy.expectedId) throw err422('plugin_id_mismatch', `The package declares plugin id ${manifest.id}, not ${policy.expectedId}`);
      const mainFile = path.resolve(root, manifest.main);
      if (!mainFile.startsWith(root + path.sep) || !fs.existsSync(mainFile) || !fs.statSync(mainFile).isFile()) throw err422('invalid_manifest', `main "${manifest.main}" does not exist in the package`);
      const sig = verifySignature(root, { source, policy });
      if (!packageSha) packageSha = packageDigest(root).toString('hex');

      const id = manifest.id;
      const previous = stmts.row.get(id);
      const wasEnabled = previous?.state === 'enabled';
      // policy.activate === false leaves an upgraded plugin disabled: the caller
      // decides (after a consent check) whether the new code may run.
      const reactivate = wasEnabled && policy?.activate !== false;
      const previousVersion = previous?.version ?? null;
      if (previous && live.has(id)) await disable(id, { keepState: true });
      const { dir } = dirsOf(id);
      // The backup lives in the staging area: "<id>.previous" would be a legal id
      // of another installed plugin.
      const old = path.join(stagingRoot, `${id}.previous-${crypto.randomBytes(4).toString('hex')}`);
      if (fs.existsSync(dir)) fs.renameSync(dir, old);
      try {
        fs.renameSync(root, dir);
      } catch (err) {
        if (fs.existsSync(old)) fs.renameSync(old, dir);
        throw err;
      }
      removeDir(old);
      stmts.upsert.run({
        id, name: manifest.name, version: manifest.version, manifest_json: JSON.stringify(manifest), state: wasEnabled ? (reactivate ? 'enabled' : 'disabled') : (previous ? previous.state === 'errored' ? 'disabled' : previous.state : 'installed'),
        source, signer: sig.signer, package_sha256: packageSha, signed: sig.signed ? 1 : 0,
      });
      req?.audit?.({ action: 'plugin.install', target: id, args: { version: manifest.version, previousVersion, source, signed: sig.signed, signer: sig.signer, sha256: packageSha, by: user?.username } });
      emitHost('plugin.installed', { pluginId: id, version: manifest.version });
      if (reactivate) await enable(id, { from: previousVersion !== manifest.version ? previousVersion : undefined });
      return { plugin: shapeRow(stmts.row.get(id)), warnings: [...sig.warnings, IN_PROCESS_WARNING], previousVersion, wasEnabled };
    } finally {
      removeDir(staging);
    }
  }

  // ------------------------------------------------------------------ manage API helpers
  function shapeRow(row) {
    if (!row) return null;
    const manifest = json.parse(row.manifest_json, {});
    const entry = live.get(row.id);
    return {
      id: row.id, name: row.name, version: row.version, description: manifest.description ?? null, author: manifest.author ?? null, state: entry?.state === 'enabled' ? 'enabled' : row.state,
      lastError: json.parse(row.last_error, null), permissions: manifest.permissions || [], sidebar: manifest.ui?.sidebar || [],
      signed: Boolean(row.signed), signer: row.signer, source: row.source, installedAt: row.installed_at, updatedAt: row.updated_at, enabledAt: row.enabled_at,
      hostVersion: HOST_API_VERSION, compatible: semver ? semver.satisfies(HOST_API_VERSION, manifest.engines?.whm || '*') : null,
    };
  }
  function maskedValues(entry) {
    const values = readSettings(entry);
    for (const f of settingFields(entry)) if (f.type === 'password' && values[f.key] !== undefined && values[f.key] !== '') values[f.key] = PASSWORD_MASK;
    return values;
  }
  function entryFor(id) {
    const row = requireRow(id);
    return live.get(id) || createEntry(row);
  }

  function detail(id) {
    const row = requireRow(id);
    const entry = entryFor(id);
    return {
      ...shapeRow(row),
      manifest: entry.manifest,
      settings: { groups: entry.manifest.settings?.groups || [], fields: settingFields(entry), values: maskedValues(entry) },
      schedules: ctx.scheduler.listPrefix(schedPrefix(id)).map((r) => shapeSchedule(entry, r)),
      jobs: stmts.jobsFor.all(`${jobType(id, '').replace(/[\\%_]/g, '\\$&')}%`, 20).map((j) => shapeJob(entry, { ...j, params: json.parse(j.params_json, {}), result: json.parse(j.result_json, null) })),
      permissionsUsed: entry.permissionsUsed.slice(), permissionDenials: entry.permissionDenials.slice(), permissionDenialCounts: { ...entry.deniedCounts }, hookTimeouts: entry.hookTimeouts.slice(),
      isolation: entry.manifest.isolation || 'in-process', warnings: [IN_PROCESS_WARNING, ...(row.signed ? [] : ['unsigned'])],
      pages: entry.pages.slice(), routes: entry.routes.map((r) => ({ method: r.method, path: r.path, roles: r.roles })),
      logs: readLogs(id, 100), dir: entry.dir, dataDir: entry.dataDir, requireSignature: ctx.settings.get('plugins.require_signature', false) === true,
    };
  }

  function updateSettings(id, values, req) {
    const entry = entryFor(id);
    if (!isObj(values)) throw new HttpError(422, 'validation_failed', 'Settings must be an object');
    const fields = {};
    const fieldsOf = settingFields(entry);
    for (const [key, value] of Object.entries(values)) {
      const f = fieldsOf.find((x) => x.key === key);
      if (!f) { fields[key] = ['not declared in the plugin manifest']; continue; }
      if (f.type === 'password' && value === PASSWORD_MASK) continue;
      const r = V.validateSettingValue(f, value);
      if (!r.ok) fields[key] = [r.error];
    }
    if (Object.keys(fields).length) throw new HttpError(422, 'validation_failed', 'Some settings are invalid', fields);
    for (const [key, value] of Object.entries(values)) {
      const f = fieldsOf.find((x) => x.key === key);
      if (f.type === 'password' && value === PASSWORD_MASK) continue;
      setSetting(entry, key, value);
    }
    const audited = {};
    for (const [key, value] of Object.entries(values)) audited[key] = fieldsOf.find((x) => x.key === key)?.type === 'password' ? PASSWORD_MASK : value;
    // The request-level audit row reads req.body once the response has finished;
    // the audit redactor matches key names, not manifest types, so password
    // values are masked in place here.
    for (const target of new Set([values, req?.body].filter(isObj))) {
      for (const [key, value] of Object.entries(audited)) if (value === PASSWORD_MASK) target[key] = PASSWORD_MASK;
    }
    req?.audit?.({ action: 'plugin.settings.update', target: id, args: audited });
    return maskedValues(entry);
  }

  function runJob(id, name, params, user, req) {
    const entry = live.get(id);
    if (!entry || entry.state !== 'enabled') throw conflict(`Plugin "${id}" is not enabled`);
    if (!entry.manifest.jobs?.[name]) throw notFound(`Job "${name}"`);
    let job;
    try { job = enqueueJob(entry, name, params, 'manual', user?.id ?? null); } catch (err) { throw err instanceof E.PluginError ? new HttpError(err.status, err.code.toLowerCase(), err.message) : err; }
    req?.audit?.({ action: 'plugin.job.run', target: `${id}:${name}`, args: { jobId: job.id, params } });
    return job;
  }

  function issueRestoreToken(id, artefactId, account, user) {
    requireRow(id);
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + RESTORE_TOKEN_TTL_MS;
    for (const [k, t] of restoreTokens) if (t.expiresAt < Date.now() || t.used) restoreTokens.delete(k);
    restoreTokens.set(token, { token, pluginId: id, artefactId: String(artefactId), account, issuedBy: user?.username ?? 'root', expiresAt, used: false });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  function uiCatalog() {
    return [...live.values()].filter((e) => e.state === 'enabled').map((e) => ({ id: e.id, name: e.manifest.name, version: e.manifest.version, sidebar: e.manifest.ui?.sidebar || [], pages: e.pages.slice() }));
  }

  function pageFile(id, rel) {
    const entry = live.get(id);
    if (!entry || entry.state !== 'enabled') throw notFound(`Plugin "${id}"`);
    const page = entry.pages.find((p) => p.file === rel);
    if (!page) throw notFound('Page file');
    const abs = path.resolve(entry.dir, rel);
    const realDir = fs.realpathSync(entry.dir);
    if (!fs.existsSync(abs) || !fs.realpathSync(abs).startsWith(realDir + path.sep)) throw notFound('Page file');
    return { path: abs, kind: page.kind, content: fs.readFileSync(abs, 'utf8') };
  }

  return {
    HOST_API_VERSION,
    sdkAvailable: () => Boolean(sdk),
    dirs: () => ({ pluginsDir, pluginDataDir, keysDir }),
    list: () => stmts.rows.all().map(shapeRow),
    get: (id) => shapeRow(requireRow(id)),
    detail,
    install, enable, disable, uninstall, loadAll, stopAll, guards,
    settings: (id) => { const entry = entryFor(id); return { fields: settingFields(entry), values: maskedValues(entry) }; },
    updateSettings,
    logs: (id, limit = 100) => { requireRow(id); return readLogs(id, limit); },
    runJob,
    issueRestoreToken,
    uiCatalog,
    pageFile,
    dispatch,
    isLive: (id) => live.get(id)?.state === 'enabled',
    entry: (id) => live.get(id) || null,
  };
}
