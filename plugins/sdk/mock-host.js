'use strict';

/**
 * WHM Plugin SDK — reference in-memory host for plugin unit tests.
 *
 *   const { createMockHost } = require('../sdk/mock-host');
 *   const host = createMockHost({ manifest, accounts, destinations, now });
 *   await host.load(require('../main'));            // activate + register hooks/jobs/cron/routes
 *   await host.fire('account.created', { username: 'bob' });
 *   await host.advance(24 * 3600 * 1000);            // runs due cron jobs, deterministic clock
 *   const res = await host.callRoute('GET', '/status');
 *   host.state.backups / host.state.notifications / host.state.logs ...
 *
 * Implements EVERY ctx method documented in plugins/SDK.md with the same signatures and
 * the same permission gate as the real host (server/src/services/plugins.js): calling a
 * gated method without the declared scope throws PermissionError. Zero dependencies.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const errors = require('./errors');
const semver = require('./semver');
const cron = require('./cron');
const V = require('./validate-manifest');

const {
  PluginError, PermissionError, ValidationError, NotFoundError, ConflictError,
  PathError, HookCancelled, IncompatibleError, LifecycleError,
} = errors;

const MOCK_MASTER_KEY = Buffer.alloc(32, 7); // fixed so ciphertexts are reproducible across runs
const MAX_STORE_VALUE_BYTES = 1024 * 1024;   // 1 MiB per value / document (same as the real host)
const MAX_FS_BYTES = 100 * 1024 * 1024;       // 100 MiB per plugin data dir

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

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

const SECRET_KEY_RE = /pass(word)?|secret|token|key|credential|authorization/i;
function redact(fields) {
  if (!isObj(fields)) return fields;
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : v;
  return out;
}

/** Match a stored document against a query (equality or {$gt,$gte,$lt,$lte,$ne,$in,$nin}). */
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
          default: throw new ValidationError(`unknown query operator ${op}`);
        }
      }
    } else if (JSON.stringify(val) !== JSON.stringify(cond)) {
      return false;
    }
  }
  return true;
}

function compilePath(p) {
  const keys = [];
  const segs = p.replace(/\/+$/, '').split('/').map((seg) => {
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { re: new RegExp(`^${segs.join('/')}/?$`), keys };
}

/** Normalise a sandboxed relative path or throw PathError. */
function safeRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new PathError('path must be a non-empty string', rel);
  if (rel.includes('\0')) throw new PathError('path contains a NUL byte', rel);
  if (rel.includes('\\')) throw new PathError('backslashes are not allowed in paths', rel);
  if (path.posix.isAbsolute(rel)) throw new PathError('absolute paths are not allowed; paths are relative to ctx.plugin.dataDir', rel);
  const norm = path.posix.normalize(rel);
  if (norm === '..' || norm.startsWith('../')) throw new PathError('path escapes the plugin data directory', rel);
  return norm === '.' ? '' : norm.replace(/\/+$/, '');
}

function hkdfKey(pluginId) {
  return Buffer.from(crypto.hkdfSync('sha256', MOCK_MASTER_KEY, 'whm-plugin-crypto', pluginId, 32));
}

/**
 * @param {object} opts
 * @param {object} opts.manifest        plugin.json object (validated; invalid → throws ValidationError)
 * @param {Array}  [opts.accounts]      [{ username, domain, owner, suspended, package, ip, contactEmail, createdAt }]
 * @param {Array}  [opts.packages]      [{ name, disk_mb, bandwidth_mb, ... }]
 * @param {Array}  [opts.zones]         [{ domain, account, serial, ttl, records: [...] }]
 * @param {Array}  [opts.destinations]  [{ id, name, kind }]
 * @param {object} [opts.services]      { name: { active, enabled, pid } }
 * @param {object} [opts.systemInfo]    overrides for ctx.api.system.info()
 * @param {object} [opts.agentOps]      { 'svc.status': (args) => result } responders for ctx.agent.op
 * @param {function} [opts.fetch]       (url, init) => response for ctx.net.fetch
 * @param {object} [opts.settings]      initial setting values (override defaults)
 * @param {object} [opts.locales]       { en: { key: 'text' } } for ctx.i18n
 * @param {string} [opts.locale]        active locale (default "en")
 * @param {number|string|Date} [opts.now] initial clock (default 2026-01-01T00:00:00Z)
 * @param {string} [opts.hostVersion]   default "1.0.0"
 * @param {object} [opts.user]          default principal for callRoute (default root)
 * @param {boolean} [opts.strictEngines] check engines.whm on load (default true)
 */
function createMockHost(opts = {}) {
  const manifest = opts.manifest;
  const vr = V.validateManifest(manifest);
  if (!vr.ok) {
    throw new ValidationError(`invalid manifest: ${vr.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, vr.errors);
  }
  const pluginId = manifest.id;
  const hostVersion = opts.hostVersion || '1.0.0';
  const locale = opts.locale || (manifest.i18n && manifest.i18n.default) || 'en';
  const locales = opts.locales || {};
  const defaultUser = opts.user || { id: 1, username: 'root', role: 'root' };

  let clock = (() => {
    const n = opts.now === undefined ? Date.UTC(2026, 0, 1) : opts.now;
    const ms = typeof n === 'number' ? n : new Date(n).getTime();
    if (!Number.isFinite(ms)) throw new TypeError('createMockHost: invalid "now"');
    return ms;
  })();

  // ------------------------------------------------------------------ state
  const accounts = clone(opts.accounts || []).map((a) => ({
    username: a.username,
    domain: a.domain || `${a.username}.example.test`,
    owner: a.owner || 'root',
    suspended: !!a.suspended,
    suspendReason: a.suspendReason || null,
    package: a.package || 'default',
    ip: a.ip || '203.0.113.10',
    contactEmail: a.contactEmail || `${a.username}@example.test`,
    createdAt: a.createdAt || clock,
  }));
  const packages = clone(opts.packages || [{ name: 'default', disk_mb: 10240, bandwidth_mb: 102400, max_domains: 1 }]);
  const zones = clone(opts.zones || []);
  const destinations = clone(opts.destinations || []);
  const services = clone(opts.services || {});
  const agentOps = opts.agentOps || {};

  const state = {
    pluginId,
    lifecycle: 'loaded',          // loaded | activating | running | errored | stopped
    lastError: null,
    logs: [],
    cron: [],                     // { id, jobName, expr, params, nextRunAt, lastRunAt, source }
    jobs: [],                     // job records
    backups: [],                  // artefacts currently existing
    backupsCreated: [],
    backupsDeleted: [],
    uploads: [],
    restores: [],
    verifications: [],
    notifications: [],
    audit: [],
    store: { kv: {}, collections: {} },
    settings: {},
    routes: [],                   // { method, path, roles }
    pages: [],
    emitted: [],
    subscriptions: [],            // { event, stage }
    hookDeliveries: [],
    agentOps: [],
    requests: [],
    fs: {},                       // relative path → string|Buffer
    permissionsUsed: [],
    permissionDenials: [],        // { scope, method }
    suspensions: [],              // { username, action, reason }
    restoreTokens: [],
    migrations: [],
  };

  const granted = new Set(manifest.permissions || []);
  const settingFields = (manifest.settings && manifest.settings.fields) || [];
  for (const f of settingFields) if (f.default !== undefined) state.settings[f.key] = clone(f.default);
  if (opts.settings) {
    for (const [k, v] of Object.entries(opts.settings)) {
      const f = settingFields.find((x) => x.key === k);
      if (!f) throw new ValidationError(`createMockHost: unknown setting "${k}"`);
      const r = V.validateSettingValue(f, v);
      if (!r.ok) throw new ValidationError(`createMockHost: ${r.error}`);
      state.settings[k] = clone(v);
    }
  }

  let seq = 0;
  const nextId = (prefix) => `${prefix}_${String(++seq).padStart(4, '0')}`;

  let loaded = null;
  let routesOpen = true;
  const subscribers = [];        // { event, stage, fn }
  const settingListeners = [];
  const pending = new Set();     // running job promises
  const running = new Map();     // jobId → { ac, record }
  const jobHandlers = {};        // name → fn (when not using load())

  // ------------------------------------------------------------------ gate
  function useScope(scope) {
    if (!state.permissionsUsed.includes(scope)) state.permissionsUsed.push(scope);
  }
  function gate(scope, method) {
    if (!granted.has(scope)) {
      state.permissionDenials.push({ scope, method, ts: clock });
      throw new PermissionError(scope, method, pluginId);
    }
    useScope(scope);
  }

  // ------------------------------------------------------------------ log
  function log(level, msg, fields) {
    if (typeof msg !== 'string') throw new ValidationError('log message must be a string');
    if (fields !== undefined && !isObj(fields)) throw new ValidationError('log fields must be an object');
    state.logs.push({ ts: clock, level, plugin: pluginId, msg, ...(fields ? { fields: redact(fields) } : {}) });
  }
  const ctxLog = {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
  };

  // ------------------------------------------------------------------ settings
  function fieldOf(key) {
    const f = settingFields.find((x) => x.key === key);
    if (!f) throw new ValidationError(`unknown setting "${key}"`, [{ path: key, code: 'UNKNOWN_SETTING', message: 'not declared in manifest.settings' }]);
    return f;
  }
  const settings = {
    async get(key) {
      gate('settings:own', 'ctx.settings.get');
      fieldOf(key);
      return clone(state.settings[key]);
    },
    async getAll() {
      gate('settings:own', 'ctx.settings.getAll');
      return clone(state.settings);
    },
    async set(key, value) {
      gate('settings:own', 'ctx.settings.set');
      const f = fieldOf(key);
      const r = V.validateSettingValue(f, value);
      if (!r.ok) throw new ValidationError(r.error, [{ path: key, code: 'INVALID_VALUE', message: r.error }]);
      const previous = clone(state.settings[key]);
      if (value === undefined || value === null) delete state.settings[key];
      else state.settings[key] = clone(value);
      rebindSettingSchedules(key);
      for (const fn of settingListeners) {
        try { fn(key, clone(state.settings[key]), previous); } catch (err) { log('error', 'settings.onChange listener threw', { error: err.message }); }
      }
      return clone(state.settings[key]);
    },
    onChange(fn) {
      if (typeof fn !== 'function') throw new ValidationError('onChange requires a function');
      settingListeners.push(fn);
      return () => { const i = settingListeners.indexOf(fn); if (i !== -1) settingListeners.splice(i, 1); };
    },
  };

  // ------------------------------------------------------------------ store
  function checkKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 256) throw new ValidationError('store key must be a string of 1..256 characters');
    if (key.startsWith('__')) throw new ValidationError('store keys starting with "__" are reserved for the host');
  }
  function checkValue(value, what) {
    if (value === undefined) throw new ValidationError(`${what} must be JSON-serialisable (got undefined)`);
    let size;
    try { size = jsonSize(value); } catch { throw new ValidationError(`${what} must be JSON-serialisable`); }
    if (size > MAX_STORE_VALUE_BYTES) throw new ValidationError(`${what} exceeds ${MAX_STORE_VALUE_BYTES} bytes`);
  }
  function coll(name) {
    if (typeof name !== 'string' || !/^[a-z][a-zA-Z0-9_]*$/.test(name)) throw new ValidationError('collection name must match /^[a-z][a-zA-Z0-9_]*$/');
    if (!state.store.collections[name]) state.store.collections[name] = [];
    return state.store.collections[name];
  }
  function sortDocs(docs, sort) {
    if (!sort) return docs;
    const [[field, dir]] = Object.entries(sort);
    const d = dir === -1 || dir === 'desc' ? -1 : 1;
    return docs.slice().sort((a, b) => (a[field] < b[field] ? -d : a[field] > b[field] ? d : 0));
  }
  const store = {
    async get(key) { gate('store:own', 'ctx.store.get'); checkKey(key); return clone(state.store.kv[key]); },
    async set(key, value) { gate('store:own', 'ctx.store.set'); checkKey(key); checkValue(value, 'store value'); state.store.kv[key] = clone(value); return clone(value); },
    async delete(key) { gate('store:own', 'ctx.store.delete'); checkKey(key); const had = key in state.store.kv; delete state.store.kv[key]; return had; },
    async keys(prefix) { gate('store:own', 'ctx.store.keys'); return Object.keys(state.store.kv).filter((k) => !prefix || k.startsWith(prefix)).sort(); },
    collection(name) {
      if (typeof name !== 'string' || !/^[a-z][a-zA-Z0-9_]*$/.test(name)) throw new ValidationError('collection name must match /^[a-z][a-zA-Z0-9_]*$/');
      const label = `ctx.store.collection(${name})`;
      return {
        async insert(doc) {
          gate('store:own', `${label}.insert`);
          if (!isObj(doc)) throw new ValidationError('document must be an object');
          checkValue(doc, 'document');
          const rec = { ...clone(doc), id: doc.id !== undefined ? String(doc.id) : nextId('doc'), createdAt: clock, updatedAt: clock };
          const c = coll(name);
          if (c.some((d) => d.id === rec.id)) throw new ConflictError(`document "${rec.id}" already exists in ${name}`);
          c.push(rec);
          return clone(rec);
        },
        async find(query, options = {}) {
          gate('store:own', `${label}.find`);
          let docs = coll(name).filter((d) => matches(d, query));
          docs = sortDocs(docs, options.sort);
          const offset = options.offset || 0;
          const limit = options.limit === undefined ? docs.length : options.limit;
          return clone(docs.slice(offset, offset + limit));
        },
        async findOne(query) {
          gate('store:own', `${label}.findOne`);
          const d = coll(name).find((x) => matches(x, query));
          return d ? clone(d) : null;
        },
        async update(query, patch) {
          gate('store:own', `${label}.update`);
          if (!isObj(patch)) throw new ValidationError('patch must be an object');
          let n = 0;
          for (const d of coll(name)) {
            if (!matches(d, query)) continue;
            const { id, createdAt, ...rest } = patch; // eslint-disable-line no-unused-vars
            Object.assign(d, clone(rest), { updatedAt: clock });
            checkValue(d, 'document');
            n++;
          }
          return n;
        },
        async remove(query) {
          gate('store:own', `${label}.remove`);
          const c = coll(name);
          const before = c.length;
          state.store.collections[name] = c.filter((d) => !matches(d, query));
          return before - state.store.collections[name].length;
        },
        async count(query) { gate('store:own', `${label}.count`); return coll(name).filter((d) => matches(d, query)).length; },
      };
    },
  };

  // ------------------------------------------------------------------ api
  function findAccount(username) {
    const a = accounts.find((x) => x.username === username);
    if (!a) throw new NotFoundError('account', username);
    return a;
  }
  function artefactOf(id) {
    const b = state.backups.find((x) => x.id === id);
    if (!b) throw new NotFoundError('backup artefact', id);
    return b;
  }

  const api = {
    accounts: {
      async list(filter = {}) {
        gate('accounts:read', 'ctx.api.accounts.list');
        if (!isObj(filter)) throw new ValidationError('filter must be an object');
        let rows = accounts.slice();
        if (filter.owner !== undefined) rows = rows.filter((a) => a.owner === filter.owner);
        if (filter.suspended !== undefined) rows = rows.filter((a) => a.suspended === !!filter.suspended);
        const page = filter.page || 1;
        const pageSize = Math.min(filter.pageSize || 50, 500);
        const total = rows.length;
        return { data: clone(rows.slice((page - 1) * pageSize, page * pageSize)), meta: { page, pageSize, total } };
      },
      async get(username) {
        gate('accounts:read', 'ctx.api.accounts.get');
        return clone(findAccount(username));
      },
      async suspend(username, { reason } = {}) {
        gate('accounts:write', 'ctx.api.accounts.suspend');
        const a = findAccount(username);
        if (a.suspended) throw new ConflictError(`account "${username}" is already suspended`);
        a.suspended = true;
        a.suspendReason = reason || null;
        state.suspensions.push({ username, action: 'suspend', reason: reason || null, ts: clock });
        return clone(a);
      },
      async unsuspend(username) {
        gate('accounts:write', 'ctx.api.accounts.unsuspend');
        const a = findAccount(username);
        if (!a.suspended) throw new ConflictError(`account "${username}" is not suspended`);
        a.suspended = false;
        a.suspendReason = null;
        state.suspensions.push({ username, action: 'unsuspend', reason: null, ts: clock });
        return clone(a);
      },
    },
    packages: {
      async list() { gate('packages:read', 'ctx.api.packages.list'); return clone(packages); },
    },
    dns: {
      zones: {
        async list(filter = {}) {
          gate('dns:read', 'ctx.api.dns.zones.list');
          const rows = zones.filter((z) => filter.account === undefined || z.account === filter.account);
          return clone(rows.map(({ records, ...z }) => z)); // eslint-disable-line no-unused-vars
        },
        async get(domain) {
          gate('dns:read', 'ctx.api.dns.zones.get');
          const z = zones.find((x) => x.domain === domain);
          if (!z) throw new NotFoundError('dns zone', domain);
          return clone({ ...z, records: z.records || [] });
        },
      },
    },
    backups: {
      async create({ account, include, compression = 'gzip', encrypt = false } = {}) {
        gate('backups:write', 'ctx.api.backups.create');
        if (typeof account !== 'string') throw new ValidationError('backups.create: account is required');
        findAccount(account);
        const inc = include === undefined ? V.BACKUP_COMPONENTS.slice() : include;
        if (!Array.isArray(inc) || inc.some((c) => !V.BACKUP_COMPONENTS.includes(c))) throw new ValidationError(`include must be a subset of ${V.BACKUP_COMPONENTS.join(', ')}`);
        if (!V.COMPRESSIONS.includes(compression)) throw new ValidationError(`compression must be one of ${V.COMPRESSIONS.join(', ')}`);
        if (typeof encrypt !== 'boolean') throw new ValidationError('encrypt must be a boolean');
        if (encrypt) throw new PluginError('this host only produces gzip-compressed, unencrypted account archives', { code: 'UNSUPPORTED', status: 422 });
        const id = nextId('bk');
        const ext = compression === 'none' ? 'tar' : compression === 'zstd' ? 'tar.zst' : 'tar.gz';
        const artefact = {
          id,
          account,
          path: `/var/lib/whm/backups/${account}/${id}.${ext}${encrypt ? '.enc' : ''}`,
          size: 1024 * 1024 * (state.backupsCreated.length + 1),
          sha256: crypto.createHash('sha256').update(`${pluginId}:${id}`).digest('hex'),
          createdAt: clock,
          include: inc.slice(),
          compression,
          encrypted: encrypt,
        };
        state.backups.push(artefact);
        state.backupsCreated.push(clone(artefact));
        return clone(artefact);
      },
      async restore({ artefactId, account, confirmToken } = {}) {
        gate('backups:restore', 'ctx.api.backups.restore');
        if (typeof artefactId !== 'string' || typeof account !== 'string') throw new ValidationError('backups.restore: artefactId and account are required');
        artefactOf(artefactId);
        findAccount(account);
        const tok = state.restoreTokens.find((t) => t.token === confirmToken && !t.used);
        if (!tok || tok.artefactId !== artefactId || tok.account !== account || tok.expiresAt < clock) {
          throw new PermissionError('confirm-token', 'ctx.api.backups.restore', pluginId);
        }
        tok.used = true;
        const jobId = nextId('hostjob');
        state.restores.push({ artefactId, account, jobId, ts: clock, confirmedBy: tok.issuedBy });
        return { ok: true, jobId };
      },
      async list(filter = {}) {
        gate('backups:read', 'ctx.api.backups.list');
        return clone(state.backups.filter((b) => filter.account === undefined || b.account === filter.account));
      },
      async delete(artefactId) {
        gate('backups:write', 'ctx.api.backups.delete');
        const b = artefactOf(artefactId);
        state.backups = state.backups.filter((x) => x.id !== artefactId);
        state.backupsDeleted.push({ ...clone(b), deletedAt: clock });
        return { ok: true };
      },
      destinations: {
        async list() {
          gate('backups:read', 'ctx.api.backups.destinations.list');
          return clone(destinations.map((d) => ({ id: d.id, name: d.name, kind: d.kind })));
        },
      },
      async upload({ artefactId, destinationId } = {}) {
        gate('backups:write', 'ctx.api.backups.upload');
        const b = artefactOf(artefactId);
        const d = destinations.find((x) => x.id === destinationId);
        if (!d) throw new NotFoundError('backup destination', destinationId);
        const remotePath = `${d.kind}://${d.name}/${b.account}/${path.posix.basename(b.path)}`;
        state.uploads.push({ artefactId, destinationId, remotePath, sha256: b.sha256, ts: clock });
        return { ok: true, remotePath, sha256: b.sha256 };
      },
      async verify(artefactId) {
        gate('backups:read', 'ctx.api.backups.verify');
        const b = artefactOf(artefactId);
        state.verifications.push({ artefactId, ts: clock });
        return { ok: true, sha256: b.sha256, size: b.size, verifiedAt: clock };
      },
    },
    services: {
      async status(name) {
        gate('system:read', 'ctx.api.services.status');
        if (typeof name !== 'string') throw new ValidationError('service name is required');
        const s = services[name];
        if (!s) throw new NotFoundError('service', name);
        return { name, active: !!s.active, enabled: s.enabled !== false, pid: s.pid || null, since: s.since || null };
      },
    },
    system: {
      async info() {
        gate('system:read', 'ctx.api.system.info');
        return {
          hostname: 'whm.example.test',
          os: 'Ubuntu 24.04 LTS',
          kernel: '6.8.0',
          uptimeSec: 86400,
          load: [0.1, 0.1, 0.1],
          mem: { totalMb: 8192, usedMb: 2048 },
          disk: [{ mount: '/', totalMb: 102400, usedMb: 40960 }],
          panelVersion: hostVersion,
          ...(opts.systemInfo || {}),
        };
      },
    },
    contacts: {
      async notify({ event, subject, body, severity = 'info' } = {}) {
        gate('contacts:notify', 'ctx.api.contacts.notify');
        if (typeof event !== 'string' || !event.startsWith(`${pluginId}.`) || !V.isPluginEvent(event)) {
          throw new ValidationError(`notify event must be namespaced "${pluginId}.<name>"`);
        }
        if (typeof subject !== 'string' || !subject.trim()) throw new ValidationError('subject is required');
        if (typeof body !== 'string') throw new ValidationError('body must be a string');
        if (!V.SEVERITIES.includes(severity)) throw new ValidationError(`severity must be one of ${V.SEVERITIES.join(', ')}`);
        state.notifications.push({ event, subject, body, severity, ts: clock });
        return { ok: true, delivered: 1 };
      },
    },
    audit: {
      async record({ action, target, details } = {}) {
        gate('audit:write', 'ctx.api.audit.record');
        if (typeof action !== 'string' || !/^[a-z][a-z0-9_.-]*$/.test(action)) throw new ValidationError('action must match /^[a-z][a-z0-9_.-]*$/');
        if (target !== undefined && typeof target !== 'string') throw new ValidationError('target must be a string');
        const id = nextId('audit');
        state.audit.push({ id, ts: clock, principal: `plugin:${pluginId}`, role: 'plugin', action: `plugin:${pluginId}:${action}`, target: target || null, details: redact(details) || null });
        return { id };
      },
    },
  };

  // ------------------------------------------------------------------ agent
  const agent = {
    async op(name, args = {}) {
      if (typeof name !== 'string' || !/^[a-z]+(\.[a-z][a-zA-Z0-9]*)+$/.test(name)) throw new ValidationError('agent op name must look like "family.op"');
      gate(`agent:op:${name}`, 'ctx.agent.op');
      if (!isObj(args)) throw new ValidationError('agent op args must be an object');
      const responder = agentOps[name];
      const result = typeof responder === 'function' ? await responder(clone(args)) : (responder !== undefined ? clone(responder) : { ok: true });
      state.agentOps.push({ op: name, args: clone(args), result: clone(result), ts: clock });
      return result;
    },
  };

  // ------------------------------------------------------------------ jobs
  function jobRecord(id) {
    const r = state.jobs.find((j) => j.id === id);
    if (!r) throw new NotFoundError('job', id);
    return r;
  }
  function setProgress(record, pct, msg) {
    if (typeof pct !== 'number' || pct < 0 || pct > 100) throw new ValidationError('progress must be a number 0..100');
    if (record.status !== 'running') return;
    record.progress = Math.round(pct);
    if (msg !== undefined) record.message = String(msg);
    record.log.push({ ts: clock, pct: record.progress, msg: msg === undefined ? null : String(msg) });
  }
  async function execute(record, handler) {
    record.status = 'running';
    record.startedAt = clock;
    const ac = new AbortController();
    running.set(record.id, { ac, record });
    const job = {
      id: record.id,
      name: record.name,
      params: deepFreeze(clone(record.params)),
      signal: ac.signal,
      progress: (pct, msg) => setProgress(record, pct, msg),
      log: (msg) => { record.log.push({ ts: clock, pct: record.progress, msg: String(msg) }); },
      get cancelled() { return record.status === 'cancelled'; },
    };
    try {
      const result = await handler(job, ctx);
      if (record.status === 'cancelled') return;
      record.status = 'done';
      record.progress = 100;
      record.result = result === undefined ? null : clone(result);
    } catch (err) {
      if (record.status !== 'cancelled') {
        record.status = 'failed';
        record.error = { code: err.code || 'JOB_FAILED', message: err.message };
      }
    } finally {
      record.finishedAt = clock;
      running.delete(record.id);
    }
  }
  function startJob(name, params, trigger) {
    if (typeof name !== 'string' || !manifest.jobs || !manifest.jobs[name]) throw new ValidationError(`job "${name}" is not declared in manifest.jobs`);
    if (params !== undefined && !isObj(params)) throw new ValidationError('job params must be an object');
    const handler = (loaded && loaded.jobs && loaded.jobs[name]) || jobHandlers[name];
    if (typeof handler !== 'function') throw new NotFoundError('job handler', name);
    const record = {
      id: nextId('job'), plugin: pluginId, name, status: 'queued', progress: 0, message: null,
      params: clone(params || {}), result: null, error: null, trigger, log: [],
      createdAt: clock, startedAt: null, finishedAt: null,
    };
    state.jobs.push(record);
    const p = execute(record, handler);
    pending.add(p);
    p.finally(() => pending.delete(p));
    return { record, promise: p };
  }
  const jobs = {
    async run(name, params) { gate('jobs', 'ctx.jobs.run'); return startJob(name, params, 'manual').record.id; },
    async progress(jobId, pct, msg) { gate('jobs', 'ctx.jobs.progress'); setProgress(jobRecord(jobId), pct, msg); },
    async status(jobId) {
      gate('jobs', 'ctx.jobs.status');
      const { log: _log, ...r } = jobRecord(jobId); // eslint-disable-line no-unused-vars
      return clone(r);
    },
    async cancel(jobId) {
      gate('jobs', 'ctx.jobs.cancel');
      const r = jobRecord(jobId);
      if (r.status !== 'running' && r.status !== 'queued') return false;
      if (manifest.jobs[r.name].cancellable === false) throw new ConflictError(`job "${r.name}" is not cancellable`);
      r.status = 'cancelled';
      r.finishedAt = clock;
      const run = running.get(jobId);
      if (run) run.ac.abort();
      return true;
    },
  };

  // ------------------------------------------------------------------ schedule
  function resolveSchedule(schedule) {
    if (schedule.startsWith('setting:')) {
      const key = schedule.slice('setting:'.length);
      return state.settings[key] || null; // null → unscheduled until the setting is set
    }
    return schedule;
  }
  function addSchedule(expr, jobName, params, source, name) {
    const parsed = cron.parse(expr);
    state.cron.push({ id: nextId('cron'), name: name || jobName, jobName, expr: parsed.expr, params: clone(params || {}), nextRunAt: cron.next(parsed, clock), lastRunAt: null, source });
  }
  function rebindSettingSchedules(key) {
    for (const entry of manifest.cron || []) {
      if (entry.schedule !== `setting:${key}`) continue;
      state.cron = state.cron.filter((c) => !(c.source === 'manifest' && c.name === entry.name));
      const expr = resolveSchedule(entry.schedule);
      if (expr && entry.enabled !== false) addSchedule(expr, entry.job, entry.params, 'manifest', entry.name);
    }
  }
  const schedule = {
    async cron(expr, jobName, params) {
      gate('schedule', 'ctx.schedule.cron');
      if (typeof jobName !== 'string' || !manifest.jobs || !manifest.jobs[jobName]) throw new ValidationError(`job "${jobName}" is not declared in manifest.jobs`);
      if (params !== undefined && !isObj(params)) throw new ValidationError('params must be an object');
      if (state.cron.some((c) => c.source === 'runtime' && c.jobName === jobName)) throw new ConflictError(`job "${jobName}" already has a runtime schedule; unschedule it first`);
      addSchedule(expr, jobName, params, 'runtime');
      const c = state.cron[state.cron.length - 1];
      return { id: c.id, jobName, expr: c.expr, nextRunAt: c.nextRunAt };
    },
    async unschedule(jobName) {
      gate('schedule', 'ctx.schedule.unschedule');
      const before = state.cron.length;
      state.cron = state.cron.filter((c) => !(c.source === 'runtime' && c.jobName === jobName));
      return state.cron.length !== before;
    },
    async list() {
      gate('schedule', 'ctx.schedule.list');
      return clone(state.cron.map(({ id, name, jobName, expr, params, nextRunAt, lastRunAt, source }) => ({ id, name, jobName, expr, params, nextRunAt, lastRunAt, source })));
    },
  };

  // ------------------------------------------------------------------ events
  const events = {
    on(event, handler, { stage = 'post' } = {}) {
      if (typeof handler !== 'function') throw new ValidationError('handler must be a function');
      if (!V.isKnownEvent(event) && !V.isPluginEvent(event)) throw new ValidationError(`unknown event "${event}"`);
      if (!V.HOOK_STAGES.includes(stage)) throw new ValidationError('stage must be "pre" or "post"');
      if (V.isKnownEvent(event) && !V.EVENTS[event].stages.includes(stage)) throw new ValidationError(`event "${event}" has no "${stage}" stage`);
      if (V.isPluginEvent(event) && stage !== 'post') throw new ValidationError('plugin events only have a "post" stage');
      const sub = { event, stage, fn: handler };
      subscribers.push(sub);
      state.subscriptions.push({ event, stage });
      return () => events.off(event, handler);
    },
    off(event, handler) {
      const i = subscribers.findIndex((s) => s.event === event && s.fn === handler);
      if (i === -1) return false;
      subscribers.splice(i, 1);
      const j = state.subscriptions.findIndex((s) => s.event === event);
      if (j !== -1) state.subscriptions.splice(j, 1);
      return true;
    },
    async emit(event, payload = {}) {
      gate('events:emit', 'ctx.events.emit');
      if (typeof event !== 'string' || !V.isPluginEvent(event)) throw new ValidationError(`event must look like "<pluginId>.<name>" (got ${JSON.stringify(event)})`);
      if (!event.startsWith(`${pluginId}.`)) throw new PermissionError(`events:emit:${event}`, 'ctx.events.emit', pluginId);
      if (!isObj(payload)) throw new ValidationError('payload must be an object');
      checkValue(payload, 'event payload');
      state.emitted.push({ event, payload: clone(payload), ts: clock });
      const r = await deliver(event, 'post', payload, `plugin:${pluginId}`);
      return { delivered: r.delivered };
    },
  };

  async function deliver(event, stage, payload, principal) {
    const def = V.EVENTS[event];
    const cancellable = !!(def && stage === 'pre' && def.cancellable);
    const handlers = [];
    if (loaded && loaded.hooks) {
      for (const h of manifest.hooks || []) {
        if (h.event === event && (h.stage || 'post') === stage) handlers.push({ label: `hooks.${h.handler}`, fn: loaded.hooks[h.handler] });
      }
    }
    for (const s of subscribers) if (s.event === event && s.stage === stage) handlers.push({ label: 'events.on', fn: s.fn });
    const result = { event, stage, delivered: 0, cancelled: false, reason: null, errors: [] };
    const frozen = deepFreeze(clone(payload));
    for (const h of handlers) {
      const evt = {
        name: event,
        stage,
        payload: frozen,
        ts: clock,
        principal,
        cancellable,
        cancel(reason) {
          if (!cancellable) throw new PluginError(`hook ${stage}:${event} is not cancellable`, { code: 'HOOK_NOT_CANCELLABLE', status: 409 });
          gate(def.cancelScope, 'evt.cancel');
          throw new HookCancelled(String(reason || 'cancelled by plugin'), event);
        },
      };
      try {
        await h.fn(evt, ctx);
        result.delivered++;
      } catch (err) {
        if (err instanceof HookCancelled) {
          result.delivered++;
          result.cancelled = true;
          result.reason = err.reason;
          break;
        }
        result.errors.push({ handler: h.label, code: err.code || 'HOOK_ERROR', message: err.message });
        log('error', `hook handler ${h.label} threw for ${stage}:${event}`, { error: err.message, code: err.code });
      }
    }
    state.hookDeliveries.push(clone(result));
    return result;
  }

  // ------------------------------------------------------------------ http
  const routeTable = [];
  function register(method, routePath, a, b) {
    gate('api:routes', `ctx.http.${method.toLowerCase()}`);
    if (!routesOpen) throw new LifecycleError('routes can only be registered during routes()/activate()');
    if (typeof routePath !== 'string' || !V.API_ROUTE_PATTERN.test(routePath)) throw new ValidationError(`route path "${routePath}" must match ${V.API_ROUTE_PATTERN}`);
    const options = typeof a === 'function' ? {} : (a || {});
    const handler = typeof a === 'function' ? a : b;
    if (typeof handler !== 'function') throw new ValidationError('route handler must be a function');
    const roles = options.roles || ['root'];
    if (!Array.isArray(roles) || roles.some((r) => !['root', 'reseller', 'user'].includes(r))) throw new ValidationError('roles must be a subset of root|reseller|user');
    if (routeTable.some((r) => r.method === method && r.path === routePath)) throw new ConflictError(`route ${method} ${routePath} already registered`);
    routeTable.push({ method, path: routePath, roles, handler, ...compilePath(routePath) });
    state.routes.push({ method, path: routePath, roles: roles.slice() });
  }
  const http = {
    baseUrl: `/api/plugins/${pluginId}`,
    get: (p, a, b) => register('GET', p, a, b),
    post: (p, a, b) => register('POST', p, a, b),
    put: (p, a, b) => register('PUT', p, a, b),
    patch: (p, a, b) => register('PATCH', p, a, b),
    delete: (p, a, b) => register('DELETE', p, a, b),
  };

  async function callRoute(method, routePath, { params = {}, query = {}, body, user, headers = {} } = {}) {
    const m = String(method).toUpperCase();
    const route = routeTable.find((r) => r.method === m && r.re.test(routePath));
    const res = { statusCode: 200, headers: {}, body: undefined, sent: false };
    const send = (status, payload) => { res.statusCode = status; res.body = payload; res.sent = true; };
    if (!route) { send(404, { error: { code: 'NOT_FOUND', message: `no route ${m} ${routePath}` } }); return { status: 404, body: res.body, headers: {} }; }
    const principal = user || defaultUser;
    if (!route.roles.includes(principal.role)) {
      send(403, { error: { code: 'FORBIDDEN', message: `role "${principal.role}" may not call ${m} ${routePath}` } });
      return { status: 403, body: res.body, headers: {} };
    }
    const match = route.re.exec(routePath);
    const pathParams = {};
    route.keys.forEach((k, i) => { pathParams[k] = decodeURIComponent(match[i + 1]); });
    const req = {
      method: m, path: routePath, params: { ...params, ...pathParams }, query: clone(query) || {},
      body: clone(body), user: clone(principal), headers: clone(headers) || {}, requestId: nextId('req'), plugin: pluginId,
    };
    const resApi = {
      status(code) { if (!Number.isInteger(code) || code < 100 || code > 599) throw new ValidationError('invalid status code'); res.statusCode = code; return resApi; },
      set(name, value) { res.headers[String(name).toLowerCase()] = String(value); return resApi; },
      json(data) {
        if (res.sent) throw new ConflictError('response already sent');
        send(res.statusCode, res.statusCode >= 400 ? data : { data });
      },
      send(text) { if (res.sent) throw new ConflictError('response already sent'); send(res.statusCode, String(text)); },
      error(code, message, status = 400) { if (res.sent) throw new ConflictError('response already sent'); send(status, { error: { code, message } }); },
    };
    try {
      await route.handler(req, resApi);
      if (!res.sent) send(204, undefined);
    } catch (err) {
      const status = err instanceof PluginError ? err.status : 500;
      const payload = err instanceof PluginError ? err.toJSON() : { code: 'INTERNAL', message: 'plugin route failed' };
      log('error', `route ${m} ${routePath} threw`, { error: err.message, code: payload.code });
      send(status, { error: payload });
    }
    return { status: res.statusCode, body: res.body, headers: res.headers };
  }

  // ------------------------------------------------------------------ ui
  let pagesOpen = true;
  const ui = {
    async registerPage(descriptor) {
      gate('ui:sidebar', 'ctx.ui.registerPage');
      if (!pagesOpen) throw new LifecycleError('pages can only be registered during activate()');
      const c = { errors: [], add(p, code, message) { this.errors.push({ path: p, code, message }); } };
      V.validatePageDescriptor(descriptor, 'page', c, { jobs: Object.keys(manifest.jobs || {}), hasSettings: settingFields.length > 0 });
      if (c.errors.length) throw new ValidationError('invalid page descriptor', c.errors);
      if (state.pages.some((p) => p.route === descriptor.route)) throw new ConflictError(`page route "${descriptor.route}" already registered`);
      state.pages.push({ ...clone(descriptor), source: 'runtime' });
    },
  };

  // ------------------------------------------------------------------ crypto
  const pluginKey = hkdfKey(pluginId);
  const ctxCrypto = {
    async encrypt(plaintext) {
      gate('crypto:own', 'ctx.crypto.encrypt');
      if (typeof plaintext !== 'string') throw new ValidationError('encrypt expects a string');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', pluginKey, iv);
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `whm1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
    },
    async decrypt(ciphertext) {
      gate('crypto:own', 'ctx.crypto.decrypt');
      if (typeof ciphertext !== 'string' || !ciphertext.startsWith('whm1:')) throw new ValidationError('ciphertext must be a "whm1:" string produced by ctx.crypto.encrypt');
      const buf = Buffer.from(ciphertext.slice(5), 'base64');
      if (buf.length < 28) throw new ValidationError('ciphertext too short');
      const decipher = crypto.createDecipheriv('aes-256-gcm', pluginKey, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      try {
        return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
      } catch {
        throw new ValidationError('ciphertext authentication failed');
      }
    },
    randomToken(bytes = 32) {
      gate('crypto:own', 'ctx.crypto.randomToken');
      if (!Number.isInteger(bytes) || bytes < 8 || bytes > 1024) throw new ValidationError('bytes must be an integer 8..1024');
      return crypto.randomBytes(bytes).toString('hex');
    },
    sha256(input) {
      gate('crypto:own', 'ctx.crypto.sha256');
      if (typeof input !== 'string' && !Buffer.isBuffer(input)) throw new ValidationError('sha256 expects a string or Buffer');
      return crypto.createHash('sha256').update(input).digest('hex');
    },
  };

  // ------------------------------------------------------------------ fs
  const dataDir = `/var/lib/whm/plugins/${pluginId}`;
  const pluginDir = `/opt/whm/plugins/${pluginId}`;
  function fsUsage() { return Object.values(state.fs).reduce((n, v) => n + Buffer.byteLength(v), 0); }
  const fs = {
    async readFile(rel, { encoding = 'utf8' } = {}) {
      gate('fs:own', 'ctx.fs.readFile');
      const p = safeRel(rel);
      if (!(p in state.fs)) throw new NotFoundError('file', rel);
      const v = state.fs[p];
      const buf = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
      return encoding === null || encoding === 'buffer' ? Buffer.from(buf) : buf.toString(encoding);
    },
    async writeFile(rel, data) {
      gate('fs:own', 'ctx.fs.writeFile');
      const p = safeRel(rel);
      if (p === '') throw new PathError('cannot write to the data directory itself', rel);
      if (typeof data !== 'string' && !Buffer.isBuffer(data)) throw new ValidationError('writeFile expects a string or Buffer');
      if (Object.keys(state.fs).some((k) => k.startsWith(`${p}/`))) throw new PathError('path is a directory', rel);
      const delta = Buffer.byteLength(data) - (p in state.fs ? Buffer.byteLength(state.fs[p]) : 0);
      if (fsUsage() + delta > MAX_FS_BYTES) throw new PluginError('plugin data directory quota exceeded', { code: 'QUOTA_EXCEEDED', status: 507 });
      state.fs[p] = Buffer.isBuffer(data) ? Buffer.from(data) : data;
    },
    async list(rel = '.') {
      gate('fs:own', 'ctx.fs.list');
      const p = safeRel(rel);
      const prefix = p === '' ? '' : `${p}/`;
      const seen = new Map();
      for (const [k, v] of Object.entries(state.fs)) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) seen.set(rest, { name: rest, type: 'file', size: Buffer.byteLength(v), mtime: clock });
        else if (!seen.has(rest.slice(0, slash))) seen.set(rest.slice(0, slash), { name: rest.slice(0, slash), type: 'dir', size: 0, mtime: clock });
      }
      if (p !== '' && seen.size === 0 && !(p in state.fs)) throw new NotFoundError('directory', rel);
      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async remove(rel, { recursive = false } = {}) {
      gate('fs:own', 'ctx.fs.remove');
      const p = safeRel(rel);
      if (p === '') throw new PathError('cannot remove the data directory itself', rel);
      if (p in state.fs) { delete state.fs[p]; return true; }
      const children = Object.keys(state.fs).filter((k) => k.startsWith(`${p}/`));
      if (children.length === 0) return false;
      if (!recursive) throw new PathError('path is a non-empty directory; pass { recursive: true }', rel);
      for (const k of children) delete state.fs[k];
      return true;
    },
    async exists(rel) {
      gate('fs:own', 'ctx.fs.exists');
      const p = safeRel(rel);
      if (p === '') return true;
      return p in state.fs || Object.keys(state.fs).some((k) => k.startsWith(`${p}/`));
    },
    async mkdir(rel) {
      gate('fs:own', 'ctx.fs.mkdir');
      safeRel(rel); // directories are implicit in the mock; validation is what matters
    },
  };

  // ------------------------------------------------------------------ net
  const net = {
    async fetch(url, init = {}) {
      let u;
      try { u = new URL(String(url)); } catch { throw new ValidationError(`invalid URL ${JSON.stringify(url)}`); }
      if (u.protocol !== 'https:') throw new ValidationError('ctx.net.fetch only allows https: URLs');
      const scope = V.matchesNetScope(u.hostname, u.port, [...granted]);
      if (!scope) {
        const wanted = `net:outbound:${u.hostname}${u.port ? `:${u.port}` : ''}`;
        state.permissionDenials.push({ scope: wanted, method: 'ctx.net.fetch', ts: clock });
        throw new PermissionError(wanted, 'ctx.net.fetch', pluginId);
      }
      useScope(scope);
      const entry = { url: u.toString(), method: (init.method || 'GET').toUpperCase(), headers: clone(init.headers) || {}, body: init.body === undefined ? null : init.body, ts: clock };
      state.requests.push(entry);
      if (typeof opts.fetch === 'function') return opts.fetch(u.toString(), init);
      const text = '';
      return { ok: true, status: 200, headers: {}, text: async () => text, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    },
  };

  // ------------------------------------------------------------------ i18n
  const i18n = {
    locale: () => locale,
    t(key, vars = {}, loc = locale) {
      if (typeof key !== 'string') throw new ValidationError('i18n key must be a string');
      const table = locales[loc] || {};
      const fallback = locales[(manifest.i18n && manifest.i18n.default) || 'en'] || {};
      const raw = table[key] !== undefined ? table[key] : fallback[key] !== undefined ? fallback[key] : key;
      return String(raw).replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined ? String(vars[name]) : m));
    },
  };

  // ------------------------------------------------------------------ ctx
  const ctx = Object.freeze({
    plugin: Object.freeze({ id: pluginId, version: manifest.version, dir: pluginDir, dataDir, hostVersion, isolation: manifest.isolation || 'in-process' }),
    log: Object.freeze(ctxLog),
    settings: Object.freeze(settings),
    store: Object.freeze(store),
    api: deepFreeze(api),
    agent: Object.freeze(agent),
    jobs: Object.freeze(jobs),
    schedule: Object.freeze(schedule),
    events: Object.freeze(events),
    http: Object.freeze(http),
    ui: Object.freeze(ui),
    crypto: Object.freeze(ctxCrypto),
    fs: Object.freeze(fs),
    net: Object.freeze(net),
    i18n: Object.freeze(i18n),
    errors: Object.freeze({ ...errors }),
    now: () => clock,
  });

  // ------------------------------------------------------------------ host controls
  async function flush() {
    while (pending.size) await Promise.all([...pending]);
  }

  async function runDueCron(upTo) {
    for (;;) {
      await flush();
      const due = state.cron.filter((c) => c.nextRunAt <= upTo).sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
      if (!due) return;
      clock = Math.max(clock, due.nextRunAt);
      due.lastRunAt = clock;
      try {
        const { promise } = startJob(due.jobName, due.params, `cron:${due.name}`);
        await promise;
      } catch (err) {
        log('error', `cron "${due.name}" could not start job "${due.jobName}"`, { error: err.message });
      }
      due.nextRunAt = cron.next(due.expr, clock);
    }
  }

  async function advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new TypeError('advance(ms) expects a non-negative number');
    const target = clock + ms;
    await runDueCron(target);
    clock = target;
    await flush();
    return clock;
  }

  async function fire(event, payload = {}, { stage = 'post', principal = 'root' } = {}) {
    const def = V.EVENTS[event];
    if (!def && !V.isPluginEvent(event)) throw new ValidationError(`unknown event "${event}"`);
    if (def && !def.stages.includes(stage)) throw new ValidationError(`event "${event}" has no "${stage}" stage`);
    if (!def && stage !== 'post') throw new ValidationError('plugin events only have a "post" stage');
    return deliver(event, stage, payload, principal);
  }

  function fail(err) {
    state.lifecycle = 'errored';
    state.lastError = { code: err.code || 'ACTIVATE_FAILED', message: err.message };
    log('error', 'plugin activation failed', { error: err.message, code: err.code });
    return { ok: false, error: state.lastError };
  }

  /**
   * Verify + activate a plugin module the way the real host does:
   * engines check → hook/job handler presence → routes(router, ctx) → manifest pages + cron →
   * migrate(ctx, fromVersion) (when given) → activate(ctx). Failure ⇒ lifecycle "errored".
   */
  async function load(mod, { fromVersion, strictEngines = opts.strictEngines !== false } = {}) {
    if (!isObj(mod) && typeof mod !== 'function') return fail(new ValidationError('plugin entry module must export an object'));
    if (strictEngines && !semver.satisfies(hostVersion, manifest.engines.whm)) return fail(new IncompatibleError(pluginId, manifest.engines.whm, hostVersion));
    for (const h of manifest.hooks || []) {
      if (!mod.hooks || typeof mod.hooks[h.handler] !== 'function') return fail(new ValidationError(`manifest hook handler "${h.handler}" is not exported in module.exports.hooks`));
    }
    for (const name of Object.keys(manifest.jobs || {})) {
      if (!mod.jobs || typeof mod.jobs[name] !== 'function') return fail(new ValidationError(`manifest job "${name}" is not exported in module.exports.jobs`));
    }
    for (const k of ['activate', 'deactivate', 'routes', 'migrate']) {
      if (mod[k] !== undefined && typeof mod[k] !== 'function') return fail(new ValidationError(`module.exports.${k} must be a function`));
    }
    loaded = mod;
    state.lifecycle = 'activating';
    try {
      if (typeof mod.routes === 'function') await mod.routes(http, ctx);
      for (const pg of (manifest.ui && manifest.ui.pages) || []) {
        if (!state.pages.some((p) => p.route === pg.route)) state.pages.push({ ...clone(pg), source: 'manifest' });
      }
      for (const entry of manifest.cron || []) {
        if (entry.enabled === false) continue;
        const expr = resolveSchedule(entry.schedule);
        if (expr) addSchedule(expr, entry.job, entry.params, 'manifest', entry.name);
      }
      if (fromVersion !== undefined) {
        if (!semver.valid(fromVersion)) throw new ValidationError(`fromVersion "${fromVersion}" is not semver`);
        state.migrations.push({ from: fromVersion, to: manifest.version, ts: clock });
        if (typeof mod.migrate === 'function') await mod.migrate(ctx, fromVersion);
      }
      if (typeof mod.activate === 'function') await mod.activate(ctx);
    } catch (err) {
      return fail(err);
    } finally {
      routesOpen = false;
      pagesOpen = false;
    }
    state.lifecycle = 'running';
    return { ok: true };
  }

  async function unload() {
    if (!loaded) throw new LifecycleError('no plugin module loaded');
    try {
      if (typeof loaded.deactivate === 'function') await loaded.deactivate(ctx);
    } finally {
      for (const [, run] of running) run.ac.abort();
      state.cron = [];
      subscribers.length = 0;
      state.subscriptions.length = 0;
      state.lifecycle = 'stopped';
    }
    await flush();
  }

  function issueRestoreToken(artefactId, account, { issuedBy = 'root', ttlMs = 10 * 60 * 1000 } = {}) {
    const token = crypto.randomBytes(16).toString('hex');
    state.restoreTokens.push({ token, artefactId, account, issuedBy, expiresAt: clock + ttlMs, used: false });
    return token;
  }

  const host = {
    ctx,
    state,
    manifest,
    hostVersion,
    now: () => clock,
    advance,
    fire,
    callRoute,
    load,
    unload,
    flush,
    /** Register a job handler without load() (for testing a single job function). */
    registerJob(name, fn) {
      if (!manifest.jobs || !manifest.jobs[name]) throw new ValidationError(`job "${name}" is not declared in manifest.jobs`);
      if (typeof fn !== 'function') throw new ValidationError('job handler must be a function');
      jobHandlers[name] = fn;
    },
    /** Run a declared job to completion and return its final record (bypasses the `jobs` gate — host-triggered). */
    async runJob(name, params) {
      const { record, promise } = startJob(name, params, 'host');
      await promise;
      return clone(record);
    },
    issueRestoreToken,
    grant(scope) { if (!V.isKnownPermission(scope)) throw new ValidationError(`unknown scope "${scope}"`); granted.add(scope); },
    revoke(scope) { granted.delete(scope); },
    granted: () => [...granted].sort(),
    /** Declared scopes that no ctx call has exercised yet — tests assert this is []. */
    unusedPermissions() { return [...granted].filter((s) => !state.permissionsUsed.includes(s)).sort(); },
    /** Scopes that were required but not declared (from PermissionError throws). */
    deniedPermissions() { return [...new Set(state.permissionDenials.map((d) => d.scope))].sort(); },
    addAccount(a) { accounts.push({ username: a.username, domain: a.domain || `${a.username}.example.test`, owner: a.owner || 'root', suspended: !!a.suspended, suspendReason: null, package: a.package || 'default', ip: a.ip || '203.0.113.10', contactEmail: a.contactEmail || `${a.username}@example.test`, createdAt: clock }); },
    addDestination(d) { destinations.push(clone(d)); },
    setService(name, status) { services[name] = clone(status); },
  };
  return host;
}

module.exports = { createMockHost, MOCK_MASTER_KEY, MAX_STORE_VALUE_BYTES, MAX_FS_BYTES, ...errors };
