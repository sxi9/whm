import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { json, paginate } from '../db/index.js';
import { DEFAULT_SETTINGS } from '../db/seed.js';
import { HttpError, notFound, conflict, forbidden, unprocessable } from '../lib/errors.js';
import { CONFIG_GROUPS, CONFIG_KEYS, GROUP_NAMES, groupOfKey, isPushableKey, keysOfGroup, validateIncoming, exportValue, APPLIERS } from './clusters-config.js';

export { CONFIG_GROUPS, CONFIG_KEYS, GROUP_NAMES, groupOfKey, isPushableKey, keysOfGroup };

// ctx.clusters — peers (other instances of this panel) for the DNS cluster and
// the configuration cluster. Peers are stored in the core dns_clusters table;
// everything else this module needs lives in its own tables. Exposed to other
// categories:
//   clusters.peers.list()                       -> peers with options and last check (tokens never included)
//   clusters.peers.request(peer, method, path, body) -> authenticated call to a peer's panel API
//   clusters.config.snapshot(groups)            -> the pushable settings of the given groups
//   clusters.events.record({ ... })             -> log an exchange with a peer
//   clusters.acceptsDnsPushes()                 -> the "Accept zones pushed by peers" toggle; the DNS
//                                                  module's zone import must refuse token pushes when false
//   clusters.dns.guardImport(req)               -> throws 403 for a token-authenticated request when it is off
// The allowlist of settings that may travel, their schemas and the owning
// services' apply paths live in ./clusters-config.js.

export const PEER_ROLES = ['write-only', 'sync', 'standalone'];
export const CLUSTER_SCOPE = 'clustering';
export const PUSH_JOB = 'clusters.config.push';
export const PUSH_SCHEDULE = 'config-cluster-push';
export const DNS_SYNC_SCHEDULE = 'dns-cluster-sync';
export const EVENT_KINDS = ['peer.test', 'dns.receive', 'config.push', 'config.pull', 'config.receive', 'config.export'];
// A cluster token is a root API token: requireScope() confines it only on
// routes that opt in (the peer endpoints here, Development), so everywhere
// else it acts as root. Shown wherever a token is issued or listed.
export const TOKEN_ACCESS_NOTE = 'Full root API access: scopes are enforced only by the cluster endpoints and the Development API, so a peer holding this token can reach every other API as root. Revoke it as soon as the peer is decommissioned or compromised.';

// A peer address is a hostname or IP, optionally with scheme and port; the
// panel's HTTPS port (2087) is assumed when none is given.
export const PEER_HOST_RE = /^(?:(https?):\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
export function parsePeerHost(host) {
  const text = String(host).trim();
  if (!PEER_HOST_RE.test(text)) throw unprocessable('Request validation failed', { host: ['Must be a hostname or IP, optionally with http(s):// and a port'] });
  const url = new URL(text.includes('://') ? text : `https://${text}`);
  if (!url.port) url.port = url.protocol === 'http:' ? '2086' : '2087';
  if (url.pathname !== '/' || url.search || url.hash) throw unprocessable('Request validation failed', { host: ['A peer address has no path'] });
  return url;
}

export function requestJson(url, { method = 'GET', body, token, verifyTls = true, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const mod = url.protocol === 'http:' ? http : https;
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'whm-panel/clusters' };
    if (payload != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = mod.request(url, { method, timeout: timeoutMs, headers, ...(url.protocol === 'https:' ? { rejectUnauthorized: Boolean(verifyTls) } : {}) }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (data.length < 4 * 1024 * 1024) data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, text: data.slice(0, 500) });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

export function describeNetworkError(err, url) {
  if (err.code === 'ETIMEDOUT') return err.message;
  if (err.code === 'ECONNREFUSED') return `connection refused on ${url.hostname}:${url.port}`;
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return `cannot resolve ${url.hostname}`;
  if (/certificate|self[- ]signed|CERT_|altname/i.test(err.message)) return `TLS verification failed: ${err.message} (turn off "Verify TLS certificate" for a self-signed panel)`;
  return err.message;
}

const errorOf = (res, fallback) => res.body?.error?.message || res.text?.slice(0, 120) || fallback;

export function createClustersService(ctx) {
  const { db, settings, crypto: cryptoSvc, logger } = ctx;
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req ?? null, entry));
  const S = (key, fallback) => settings.get(key, fallback);
  const localHostname = () => S('basic.hostname', '') || os.hostname();
  const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

  const stmts = {
    peers: db.prepare(`SELECT c.*, c.api_token_enc IS NOT NULL AS has_token, o.verify_tls, o.config_enabled, o.status, o.last_checked_at, o.last_error, o.remote_json
      FROM dns_clusters c LEFT JOIN cluster_peer_options o ON o.cluster_id = c.id ORDER BY c.name`),
    peerById: db.prepare(`SELECT c.*, c.api_token_enc IS NOT NULL AS has_token, o.verify_tls, o.config_enabled, o.status, o.last_checked_at, o.last_error, o.remote_json
      FROM dns_clusters c LEFT JOIN cluster_peer_options o ON o.cluster_id = c.id WHERE c.id = ?`),
    peerByName: db.prepare('SELECT id FROM dns_clusters WHERE name = ?'),
    peerByHost: db.prepare('SELECT id FROM dns_clusters WHERE remote_host = ?'),
    insertPeer: db.prepare('INSERT INTO dns_clusters (name, remote_host, api_token_enc, role, enabled) VALUES (@name, @remote_host, @api_token_enc, @role, @enabled)'),
    updatePeer: db.prepare('UPDATE dns_clusters SET name = @name, remote_host = @remote_host, api_token_enc = @api_token_enc, role = @role, enabled = @enabled WHERE id = @id'),
    deletePeer: db.prepare('DELETE FROM dns_clusters WHERE id = ?'),
    upsertOptions: db.prepare(`INSERT INTO cluster_peer_options (cluster_id, verify_tls, config_enabled) VALUES (@cluster_id, @verify_tls, @config_enabled)
      ON CONFLICT (cluster_id) DO UPDATE SET verify_tls = excluded.verify_tls, config_enabled = excluded.config_enabled, updated_at = datetime('now')`),
    checkOptions: db.prepare(`INSERT INTO cluster_peer_options (cluster_id, status, last_checked_at, last_error, remote_json) VALUES (@cluster_id, @status, datetime('now'), @last_error, @remote_json)
      ON CONFLICT (cluster_id) DO UPDATE SET status = excluded.status, last_checked_at = excluded.last_checked_at, last_error = excluded.last_error, remote_json = COALESCE(excluded.remote_json, cluster_peer_options.remote_json), updated_at = datetime('now')`),
    zoneSyncSummary: db.prepare(`SELECT cluster_id, SUM(status = 'ok') AS ok, SUM(status = 'failed') AS failed, MAX(synced_at) AS last FROM dns_zone_sync GROUP BY cluster_id`),
    tokens: db.prepare(`SELECT t.id, t.name, t.prefix, t.description, t.expires_at, t.last_used_at, t.created_at, t.created_ip, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.scopes = ? ORDER BY t.created_at DESC`),
    tokenById: db.prepare('SELECT t.*, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND t.scopes = ?'),
    insertToken: db.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at, prefix, description, created_ip) VALUES (@user_id, @name, @token_hash, @scopes, @expires_at, @prefix, @description, @created_ip)'),
    deleteToken: db.prepare('DELETE FROM api_tokens WHERE id = ?'),
    rootUser: db.prepare("SELECT id, username FROM users WHERE role = 'root' ORDER BY id LIMIT 1"),
    insertEvent: db.prepare('INSERT INTO cluster_events (cluster_id, kind, direction, source, status, message, details_json) VALUES (@cluster_id, @kind, @direction, @source, @status, @message, @details_json)'),
    pruneEvents: db.prepare("DELETE FROM cluster_events WHERE ts < datetime('now', ?)"),
    recentEvents: db.prepare('SELECT e.*, c.name AS peer FROM cluster_events e LEFT JOIN dns_clusters c ON c.id = e.cluster_id ORDER BY e.id DESC LIMIT ?'),
    settingRow: db.prepare('SELECT 1 FROM settings WHERE key = ?'),
  };
  const SCOPES_JSON = JSON.stringify([CLUSTER_SCOPE]);

  const shapePeer = (row, syncRows = null) => {
    const sync = syncRows?.get?.(row.id);
    return {
      id: row.id, name: row.name, host: row.remote_host, role: row.role, enabled: Boolean(row.enabled), hasToken: Boolean(row.has_token),
      verifyTls: row.verify_tls == null ? true : Boolean(row.verify_tls), configEnabled: Boolean(row.config_enabled),
      status: row.status || 'unknown', lastCheckedAt: row.last_checked_at ?? null, lastError: row.last_error ?? null, remote: json.parse(row.remote_json, null),
      lastSyncAt: row.last_sync_at ?? null, createdAt: row.created_at,
      zones: sync ? { ok: sync.ok, failed: sync.failed, lastAt: sync.last } : { ok: 0, failed: 0, lastAt: null },
    };
  };
  const loadPeer = (id) => { const row = stmts.peerById.get(id); if (!row) throw notFound('Cluster peer'); return row; };
  const syncSummary = () => new Map(stmts.zoneSyncSummary.all().map((r) => [r.cluster_id, r]));

  const events = {
    record({ clusterId = null, kind, direction, source = null, status, message = null, details = null }) {
      stmts.insertEvent.run({ cluster_id: clusterId, kind, direction, source, status, message, details_json: details == null ? null : JSON.stringify(details) });
    },
    recent: (limit = 20) => stmts.recentEvents.all(limit).map((e) => ({ ...e, details: json.parse(e.details_json, null), details_json: undefined })),
    list(query) {
      const where = [];
      const params = {};
      if (query.kind) { where.push('e.kind = @kind'); params.kind = query.kind; }
      if (query.clusterId) { where.push('e.cluster_id = @clusterId'); params.clusterId = query.clusterId; }
      if (query.status) { where.push('e.status = @status'); params.status = query.status; }
      if (query.q) { where.push('(e.message LIKE @q OR e.source LIKE @q OR c.name LIKE @q)'); params.q = `%${query.q}%`; }
      const page = paginate(db, { select: 'e.*, c.name AS peer', from: 'cluster_events e LEFT JOIN dns_clusters c ON c.id = e.cluster_id', where, params, query, sortable: { ts: 'e.id', kind: 'e.kind', status: 'e.status', peer: 'c.name' }, defaultSort: 'ts' });
      return { data: page.data.map((e) => ({ ...e, details: json.parse(e.details_json, null), details_json: undefined })), meta: page.meta };
    },
    prune() { const days = Number(S('clusters.events.retention_days', 90)) || 90; return stmts.pruneEvents.run(`-${days} days`).changes; },
  };

  const peers = {
    list() { const sync = syncSummary(); return stmts.peers.all().map((r) => shapePeer(r, sync)); },
    get(id) { return shapePeer(loadPeer(id), syncSummary()); },
    create(input, req) {
      const url = parsePeerHost(input.host);
      if (stmts.peerByName.get(input.name)) throw conflict(`A peer named "${input.name}" already exists`);
      if (stmts.peerByHost.get(input.host)) throw conflict(`A peer at ${input.host} already exists`);
      if (url.hostname === localHostname().toLowerCase()) throw unprocessable('Request validation failed', { host: ['That is this server'] });
      const id = db.transaction(() => {
        const { lastInsertRowid } = stmts.insertPeer.run({ name: input.name, remote_host: input.host, api_token_enc: cryptoSvc.encrypt(input.token), role: input.role, enabled: input.enabled === false ? 0 : 1 });
        stmts.upsertOptions.run({ cluster_id: lastInsertRowid, verify_tls: input.verifyTls === false ? 0 : 1, config_enabled: input.configEnabled ? 1 : 0 });
        return Number(lastInsertRowid);
      })();
      audit(req, { action: 'clusters.peer.create', target: input.name, args: { host: input.host, role: input.role, verifyTls: input.verifyTls !== false, configEnabled: Boolean(input.configEnabled) } });
      return peers.get(id);
    },
    update(id, input, req) {
      const row = loadPeer(id);
      if (input.host) parsePeerHost(input.host);
      if (input.name && input.name !== row.name && stmts.peerByName.get(input.name)) throw conflict(`A peer named "${input.name}" already exists`);
      if (input.host && input.host !== row.remote_host && stmts.peerByHost.get(input.host)) throw conflict(`A peer at ${input.host} already exists`);
      db.transaction(() => {
        stmts.updatePeer.run({ id, name: input.name ?? row.name, remote_host: input.host ?? row.remote_host, api_token_enc: input.token ? cryptoSvc.encrypt(input.token) : row.api_token_enc, role: input.role ?? row.role, enabled: (input.enabled ?? Boolean(row.enabled)) ? 1 : 0 });
        stmts.upsertOptions.run({ cluster_id: id, verify_tls: (input.verifyTls ?? (row.verify_tls == null ? true : Boolean(row.verify_tls))) ? 1 : 0, config_enabled: (input.configEnabled ?? Boolean(row.config_enabled)) ? 1 : 0 });
      })();
      audit(req, { action: 'clusters.peer.update', target: row.name, args: { ...input, token: input.token ? '[rotated]' : undefined } });
      return peers.get(id);
    },
    remove(id, req) {
      const row = loadPeer(id);
      stmts.deletePeer.run(id);
      audit(req, { action: 'clusters.peer.remove', target: row.name, args: { host: row.remote_host } });
      return { id, removed: true };
    },
    // Authenticated call to a peer's panel API; the caller interprets the response.
    async request(peerOrId, method, path, body, { timeoutMs } = {}) {
      const row = typeof peerOrId === 'object' && peerOrId.remote_host ? peerOrId : loadPeer(peerOrId);
      if (!row.api_token_enc) throw unprocessable(`Peer "${row.name}" has no API token; edit it and add one first`);
      const url = new URL(path, parsePeerHost(row.remote_host));
      const token = cryptoSvc.decrypt(row.api_token_enc);
      try {
        return await requestJson(url, { method, body, token, verifyTls: row.verify_tls == null ? true : Boolean(row.verify_tls), timeoutMs });
      } catch (err) {
        throw Object.assign(new Error(describeNetworkError(err, url)), { code: err.code, network: true });
      }
    },
    // Connectivity test: the peer's /api/clusters/ping says what it accepts; an
    // older panel without it still answers /api/system/status.
    async test(id, req) {
      const row = loadPeer(id);
      const started = Date.now();
      let outcome;
      try {
        let res = await peers.request(row, 'GET', '/api/clusters/ping', undefined, { timeoutMs: 10_000 });
        let viaPing = true;
        if (res.status === 404) { viaPing = false; res = await peers.request(row, 'GET', '/api/system/status', undefined, { timeoutMs: 10_000 }); }
        if (res.status === 200 && res.body?.data) {
          const d = res.body.data;
          outcome = viaPing
            ? { ok: true, remote: { hostname: d.hostname ?? null, version: d.version ?? null, accepts: d.accepts ?? null, groups: d.groups ?? null, clusterAware: true } }
            : { ok: true, remote: { hostname: d.hostname ?? null, version: d.panel?.version ?? null, accepts: null, groups: null, clusterAware: false } };
        } else if (res.status === 401 || res.status === 403) {
          outcome = { ok: false, error: `the peer rejected the token (${res.status}: ${errorOf(res, 'unauthorized')})` };
        } else {
          outcome = { ok: false, error: `unexpected response ${res.status}: ${errorOf(res, 'no details')}` };
        }
      } catch (err) {
        outcome = { ok: false, error: err.message };
      }
      stmts.checkOptions.run({ cluster_id: id, status: outcome.ok ? 'ok' : 'error', last_error: outcome.ok ? null : outcome.error, remote_json: outcome.ok ? JSON.stringify(outcome.remote) : null });
      const ms = Date.now() - started;
      events.record({ clusterId: id, kind: 'peer.test', direction: 'out', source: localHostname(), status: outcome.ok ? 'ok' : 'failed', message: outcome.ok ? `reachable in ${ms} ms` : outcome.error, details: outcome.ok ? outcome.remote : null });
      audit(req, { action: 'clusters.peer.test', target: row.name, args: { ok: outcome.ok, error: outcome.error ?? null, ms } });
      return { ...peers.get(id), test: { ...outcome, ms } };
    },
  };

  // Tokens a *remote* panel uses to reach this one: issued for the root user
  // with the "clustering" scope so they are recognisable and revocable here.
  const tokens = {
    list: () => stmts.tokens.all(SCOPES_JSON).map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, description: t.description, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, createdAt: t.created_at, createdIp: t.created_ip, username: t.username, scopes: [CLUSTER_SCOPE], access: 'root', accessNote: TOKEN_ACCESS_NOTE })),
    create(input, user, req) {
      const owner = user?.role === 'root' ? user : stmts.rootUser.get();
      if (!owner) throw notFound('Root user');
      let expiresAt = null;
      if (input.expiresInDays) expiresAt = `${new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString().slice(0, 19)}Z`;
      const secret = `whm_${cryptoSvc.randomToken(32)}`;
      const { lastInsertRowid } = stmts.insertToken.run({ user_id: owner.id, name: input.name, token_hash: cryptoSvc.hashToken(secret), scopes: SCOPES_JSON, expires_at: expiresAt, prefix: secret.slice(0, 12), description: input.description || `Cluster token for ${input.name}`, created_ip: req?.ip || null });
      audit(req, { action: 'clusters.token.create', target: input.name, args: { expiresAt, access: 'root', scopes: [CLUSTER_SCOPE] } });
      // Shown exactly once; only its hash is stored.
      return { ...tokens.list().find((t) => t.id === Number(lastInsertRowid)), token: secret };
    },
    revoke(id, req) {
      const row = stmts.tokenById.get(id, SCOPES_JSON);
      if (!row) throw notFound('Cluster token');
      stmts.deleteToken.run(id);
      audit(req, { action: 'clusters.token.revoke', target: row.name, args: { id, prefix: row.prefix } });
      return { id, revoked: true };
    },
  };

  const acceptsDnsPushes = () => Boolean(S('clusters.dns.accept_pushes', true));

  // What a peer learns about this server on a connectivity test.
  const identity = () => ({
    hostname: localHostname(), version: ctx.version ?? null, mode: ctx.config?.mode ?? null,
    accepts: { dns: acceptsDnsPushes() && typeof ctx.dns?.importZone === 'function', config: Boolean(S('clusters.config.accept_pushes', true)) },
    groups: GROUP_NAMES,
  });

  const dnsModule = () => { if (typeof ctx.dns?.enqueueSync !== 'function') throw new HttpError(501, 'capability_missing', 'The DNS Functions module is not loaded on this server, so zones cannot be synchronised'); return ctx.dns; };

  const dns = {
    // The toggle must bite on the path peers actually use: the DNS module's
    // sync job posts to /api/dns/zones/import with an API token. Mounted in
    // front of that route (see the router) and offered to the DNS module as
    // ctx.clusters.dns.guardImport(). Sessions (a root user importing a zone
    // by hand) are not peer pushes and pass.
    guardImport(req) {
      if (req?.auth?.via !== 'token' || acceptsDnsPushes()) return;
      const domain = req.body?.domain ?? null;
      events.record({ kind: 'dns.receive', direction: 'in', source: req.ip ?? null, status: 'skipped', message: `${domain ?? 'zone'}: refused, this server does not accept DNS pushes`, details: { domain, path: req.originalUrl ?? null } });
      throw forbidden('This server does not accept DNS pushes; enable them under Clusters > DNS Cluster');
    },
    overview() {
      events.prune();
      const schedule = ctx.scheduler.list().find((s) => s.name === DNS_SYNC_SCHEDULE) || null;
      let status = { clusters: [], zones: [] };
      try { status = ctx.dns?.syncStatus?.() ?? status; } catch (err) { logger.warn({ err }, 'dns sync status unavailable'); }
      return {
        hostname: localHostname(), peers: peers.list(), tokens: tokens.list(), zones: status.zones, roles: PEER_ROLES,
        settings: { verifyTls: Boolean(S('dns.cluster_verify_tls', true)), autoSync: Boolean(schedule?.enabled), acceptPushes: Boolean(S('clusters.dns.accept_pushes', true)) },
        schedule: schedule ? { name: schedule.name, cron: schedule.cron, enabled: Boolean(schedule.enabled), nextRunAt: schedule.next_run_at ?? null, lastRunAt: schedule.last_run_at ?? null } : null,
        dnsModule: typeof ctx.dns?.enqueueSync === 'function', bind: Boolean(ctx.capabilities?.has?.('bind')),
        events: events.recent(15),
      };
    },
    updateSettings(input, req) {
      if (input.verifyTls != null) settings.set('dns.cluster_verify_tls', Boolean(input.verifyTls));
      if (input.acceptPushes != null) settings.set('clusters.dns.accept_pushes', Boolean(input.acceptPushes));
      if (input.autoSync != null) {
        const updated = ctx.scheduler.update(DNS_SYNC_SCHEDULE, { enabled: Boolean(input.autoSync) });
        if (!updated) throw new HttpError(501, 'capability_missing', 'The DNS Functions module is not loaded, so there is no synchronisation schedule to toggle');
      }
      audit(req, { action: 'clusters.dns.settings', target: 'dns-cluster', args: input });
      return dns.overview().settings;
    },
    sync(input, user) {
      const mod = dnsModule();
      if (input.clusterId) {
        const row = loadPeer(input.clusterId);
        if (row.role === 'standalone') throw unprocessable(`Peer "${row.name}" is standalone and never receives zones; change its role first`);
        if (!row.enabled) throw unprocessable(`Peer "${row.name}" is disabled`);
      }
      return mod.enqueueSync({ domains: input.domains, clusterId: input.clusterId, force: true }, user);
    },
    // A master pushes a rendered zone here (Bearer token with the clustering scope).
    async receive(input, user, req) {
      if (!acceptsDnsPushes()) throw forbidden('This server does not accept DNS pushes; enable them under Clusters > DNS Cluster');
      if (typeof ctx.dns?.importZone !== 'function') throw new HttpError(501, 'capability_missing', 'The DNS Functions module is not loaded on this server, so zones cannot be received');
      const source = input.source || req?.ip || null;
      try {
        const zone = await ctx.dns.importZone({ domain: input.domain, body: input.body, serial: input.serial }, user, req);
        events.record({ kind: 'dns.receive', direction: 'in', source, status: 'ok', message: `${input.domain} serial ${zone?.serial ?? input.serial ?? '?'}`, details: { domain: input.domain, serial: zone?.serial ?? null } });
        audit(req, { action: 'clusters.dns.receive', target: input.domain, args: { source, serial: zone?.serial ?? input.serial ?? null } });
        return { domain: zone?.domain ?? input.domain, serial: zone?.serial ?? null, records: zone?.records?.length ?? null, receivedAt: nowStamp() };
      } catch (err) {
        events.record({ kind: 'dns.receive', direction: 'in', source, status: 'failed', message: `${input.domain}: ${err.message}`, details: { domain: input.domain } });
        throw err;
      }
    },
  };

  // A key is known here when the settings table or the seed defaults have it;
  // a peer cannot create settings this server has never heard of.
  const localExists = (key) => Boolean(stmts.settingRow.get(key)) || Object.hasOwn(DEFAULT_SETTINGS, key);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const localValue = (key) => { const r = exportValue(key, settings.get(key)); return r.ok ? r.value : null; };

  const config = {
    groups: () => GROUP_NAMES.map((name) => { const snap = config.snapshot([name]); return { name, ...CONFIG_GROUPS[name], keys: snap.keys, keyCount: snap.keys.length }; }),
    selectedGroups() { const list = S('clusters.config.groups', GROUP_NAMES); return (Array.isArray(list) ? list : GROUP_NAMES).filter((g) => GROUP_NAMES.includes(g)); },
    // The allowlisted keys of the given groups with their current values in
    // the shape that travels (per-host fields stripped). A key whose local
    // value does not fit its own schema is left out rather than exported.
    snapshot(groups = config.selectedGroups()) {
      const wanted = new Set(groups);
      const values = {};
      for (const g of wanted) {
        for (const key of keysOfGroup(g)) {
          if (!localExists(key)) continue;
          const r = exportValue(key, settings.get(key));
          if (r.ok) values[key] = r.value;
        }
      }
      return { groups: [...wanted], keys: Object.keys(values), values };
    },
    overview() {
      events.prune();
      const schedule = ctx.scheduler.list().find((s) => s.name === PUSH_SCHEDULE) || null;
      const selected = config.selectedGroups();
      return {
        hostname: localHostname(), peers: peers.list(), groups: config.groups(), selectedGroups: selected, keyCount: config.snapshot(selected).keys.length,
        settings: { groups: selected, autoPush: Boolean(S('clusters.config.auto_push', false)), acceptPushes: Boolean(S('clusters.config.accept_pushes', true)), lastPushAt: S('clusters.config.last_push_at', null), lastPullAt: S('clusters.config.last_pull_at', null) },
        schedule: schedule ? { name: schedule.name, cron: schedule.cron, enabled: Boolean(schedule.enabled), nextRunAt: schedule.next_run_at ?? null, lastRunAt: schedule.last_run_at ?? null } : null,
        events: events.recent(15).filter((e) => e.kind.startsWith('config.')),
      };
    },
    updateSettings(input, req) {
      if (input.groups) settings.set('clusters.config.groups', [...new Set(input.groups)]);
      if (input.acceptPushes != null) settings.set('clusters.config.accept_pushes', Boolean(input.acceptPushes));
      if (input.autoPush != null) {
        settings.set('clusters.config.auto_push', Boolean(input.autoPush));
        ctx.scheduler.update(PUSH_SCHEDULE, { enabled: Boolean(input.autoPush) });
      }
      audit(req, { action: 'clusters.config.settings', target: 'configuration-cluster', args: input });
      return config.overview().settings;
    },
    // What a peer gets when it pulls from this server.
    export(groups, req) {
      const list = groups?.length ? groups.filter((g) => GROUP_NAMES.includes(g)) : config.selectedGroups();
      const snap = config.snapshot(list);
      events.record({ kind: 'config.export', direction: 'out', source: req?.ip ?? null, status: 'ok', message: `${snap.keys.length} keys (${list.join(', ')}) served to ${req?.user?.username ?? 'peer'}`, details: { groups: list, keys: snap.keys.length } });
      return { hostname: localHostname(), exportedAt: nowStamp(), groups: list, settings: snap.values };
    },
    // Which of a peer's settings would change here. Rejected keys carry the
    // reason (not shared, unknown locally, or a value that fails the schema).
    diff(remote) {
      const changes = [];
      const rejected = [];
      const rejections = {};
      const reject = (key, reason) => { rejected.push(key); rejections[key] = reason; };
      for (const [key, value] of Object.entries(remote || {})) {
        if (!isPushableKey(key)) { reject(key, 'not a shared setting'); continue; }
        if (!localExists(key)) { reject(key, 'unknown on this server'); continue; }
        const v = validateIncoming(key, value);
        if (!v.ok) { reject(key, v.reason); continue; }
        const local = localValue(key);
        if (!same(local, v.value)) changes.push({ key, group: groupOfKey(key), local, remote: v.value, apply: CONFIG_KEYS[key].apply });
      }
      return { changes, rejected, rejections };
    },
    // Stores accepted values and hands each group to its owning service, which
    // validates again and rewrites the host configuration. Per key:
    //   applied  the owner wrote it to the host (or it has no host file and is live from the DB)
    //   stored   saved, but the daemon is missing so the host file waits (CapabilityError)
    //   failed   the owner refused it; `stored` says whether the value stuck in the DB
    async apply(changes, req) {
      const results = {};
      const plain = {};
      const byApplier = new Map();
      for (const c of changes) {
        if (c.apply) { if (!byApplier.has(c.apply)) byApplier.set(c.apply, []); byApplier.get(c.apply).push(c); } else plain[c.key] = c.remote;
      }
      if (Object.keys(plain).length) {
        settings.setMany(plain);
        for (const key of Object.keys(plain)) results[key] = { status: 'applied', stored: true, via: null, note: 'read from the settings database at runtime' };
      }
      for (const [name, list] of byApplier) {
        const values = Object.fromEntries(list.map((c) => [c.key, c.remote]));
        let outcome;
        try {
          const r = await APPLIERS[name](ctx, values, req);
          outcome = { status: r?.live === false ? 'stored' : 'applied', note: r?.live === false ? 'saved; no daemon consumes it yet' : null };
        } catch (err) {
          const capability = err?.status === 501 || err?.code === 'capability_missing';
          outcome = { status: capability ? 'stored' : 'failed', note: err?.message || String(err) };
          logger.warn({ err, applier: name, keys: Object.keys(values) }, 'cluster config apply failed');
        }
        for (const c of list) {
          const stored = same(localValue(c.key), c.remote);
          results[c.key] = { ...outcome, status: outcome.status === 'stored' && !stored ? 'failed' : outcome.status, stored, via: name };
        }
      }
      return results;
    },
    summarize(results) {
      const keys = Object.keys(results);
      const by = (status) => keys.filter((k) => results[k].status === status);
      return { applied: by('applied'), stored: by('stored'), failed: by('failed') };
    },
    // A peer pushes settings here (Bearer token with the clustering scope).
    async receive(input, req) {
      if (!S('clusters.config.accept_pushes', true)) throw forbidden('This server does not accept configuration pushes; enable them under Clusters > Configuration Cluster');
      const source = input.source || req?.ip || null;
      const { changes, rejected, rejections } = config.diff(input.settings);
      const results = await config.apply(changes, req);
      const sum = config.summarize(results);
      const applied = [...sum.applied, ...sum.stored];
      const unchanged = Object.keys(input.settings).length - changes.length - rejected.length;
      const message = `${sum.applied.length} applied, ${sum.stored.length} stored, ${sum.failed.length} failed, ${unchanged} unchanged, ${rejected.length} rejected`;
      events.record({ kind: 'config.receive', direction: 'in', source, status: sum.failed.length ? 'failed' : 'ok', message, details: { applied, failed: sum.failed, rejected, rejections, results, groups: input.groups ?? null } });
      audit(req, { action: 'clusters.config.receive', target: source, args: { applied, failed: sum.failed, rejected, rejections, unchanged } });
      return { applied, failed: sum.failed, unchanged, rejected, rejections, results, receivedAt: nowStamp() };
    },
    enqueuePush({ clusterIds, groups } = {}, user) {
      const targets = peers.list().filter((p) => p.enabled && p.configEnabled && (!clusterIds || clusterIds.includes(p.id)));
      if (!targets.length) throw unprocessable(clusterIds ? 'None of the selected peers is enabled for the configuration cluster' : 'No enabled peer takes part in the configuration cluster; edit a peer and turn on "Configuration cluster"');
      const job = ctx.jobs.enqueue(PUSH_JOB, { clusterIds: clusterIds ?? null, groups: groups ?? null, manual: true, userId: user?.id ?? null }, { userId: user?.id ?? null });
      return { job };
    },
    async runPush(jobCtx) {
      const { clusterIds, groups } = jobCtx.params;
      const list = groups?.length ? groups.filter((g) => GROUP_NAMES.includes(g)) : config.selectedGroups();
      const snap = config.snapshot(list);
      const targets = stmts.peers.all().filter((p) => p.enabled && p.config_enabled && (!clusterIds || clusterIds.includes(p.id)));
      const summary = { peers: targets.length, keys: snap.keys.length, groups: list, ok: 0, failed: 0, changed: 0 };
      if (!targets.length) { jobCtx.log('No enabled peer takes part in the configuration cluster; nothing pushed', 'warn'); return summary; }
      if (!snap.keys.length) { jobCtx.log('The selected groups contain no settings; nothing pushed', 'warn'); return summary; }
      const source = localHostname();
      let i = 0;
      for (const peer of targets) {
        i++;
        jobCtx.progress((i / targets.length) * 100, peer.name);
        try {
          const res = await peers.request(peer, 'POST', '/api/clusters/config/receive', { source, groups: list, settings: snap.values });
          if (res.status >= 200 && res.status < 300 && res.body?.data) {
            const d = res.body.data;
            summary.ok++; summary.changed += d.applied?.length ?? 0;
            const failed = d.failed?.length ? `, failed ${d.failed.map((k) => `${k} (${d.results?.[k]?.note ?? 'rejected by the peer'})`).join('; ')}` : '';
            jobCtx.log(`${peer.name}: ${d.applied?.length ?? 0} changed, ${d.unchanged ?? 0} unchanged${d.rejected?.length ? `, rejected ${d.rejected.join(', ')}` : ''}${failed}`, d.failed?.length ? 'warn' : 'info');
            events.record({ clusterId: peer.id, kind: 'config.push', direction: 'out', source, status: d.failed?.length ? 'failed' : 'ok', message: `${d.applied?.length ?? 0} changed, ${d.failed?.length ?? 0} failed, ${d.rejected?.length ?? 0} rejected`, details: { groups: list, keys: snap.keys.length, applied: d.applied ?? [], failed: d.failed ?? [], rejected: d.rejected ?? [], results: d.results ?? null } });
          } else {
            const msg = res.status === 404 ? 'the peer does not have the Clusters module (upgrade it)' : `HTTP ${res.status}: ${errorOf(res, 'no details')}`;
            summary.failed++; jobCtx.log(`${peer.name}: ${msg}`, 'error');
            events.record({ clusterId: peer.id, kind: 'config.push', direction: 'out', source, status: 'failed', message: msg, details: { groups: list, keys: snap.keys.length } });
          }
        } catch (err) {
          summary.failed++; jobCtx.log(`${peer.name}: ${err.message}`, 'error');
          events.record({ clusterId: peer.id, kind: 'config.push', direction: 'out', source, status: 'failed', message: err.message, details: { groups: list, keys: snap.keys.length } });
        }
      }
      settings.set('clusters.config.last_push_at', nowStamp());
      audit(null, { action: 'clusters.config.push', target: 'peers', args: summary });
      return summary;
    },
    // Pull from one peer: preview the differences, and apply them when asked.
    async pull({ clusterId, groups, apply = false }, req) {
      const row = loadPeer(clusterId);
      const list = groups?.length ? groups.filter((g) => GROUP_NAMES.includes(g)) : config.selectedGroups();
      const query = `?groups=${encodeURIComponent(list.join(','))}`;
      const fail = (code, message) => {
        events.record({ clusterId: row.id, kind: 'config.pull', direction: 'in', source: row.remote_host, status: 'failed', message });
        return new HttpError(502, code, `${row.name}: ${message}`);
      };
      let res;
      try { res = await peers.request(row, 'GET', `/api/clusters/config/export${query}`); } catch (err) { throw fail('peer_unreachable', err.message); }
      if (res.status === 404) throw fail('peer_unsupported', 'the peer does not have the Clusters module; upgrade it before pulling');
      if (res.status === 401 || res.status === 403) throw fail('peer_rejected', `the peer rejected the token (${res.status}: ${errorOf(res, 'unauthorized')})`);
      if (res.status !== 200 || !res.body?.data?.settings) throw fail('peer_error', `the peer answered ${res.status}: ${errorOf(res, 'no settings in the response')}`);
      const { changes, rejected, rejections } = config.diff(res.body.data.settings);
      let results = null;
      let sum = { applied: [], stored: [], failed: [] };
      if (apply) {
        results = await config.apply(changes, req);
        sum = config.summarize(results);
        settings.set('clusters.config.last_pull_at', nowStamp());
      }
      const message = apply ? `${sum.applied.length} applied, ${sum.stored.length} stored, ${sum.failed.length} failed, ${rejected.length} rejected` : `preview: ${changes.length} differ, ${rejected.length} rejected`;
      events.record({ clusterId: row.id, kind: 'config.pull', direction: 'in', source: res.body.data.hostname ?? row.remote_host, status: sum.failed.length ? 'failed' : 'ok', message, details: { groups: list, applied: [...sum.applied, ...sum.stored], failed: sum.failed, rejected, rejections, results, preview: !apply } });
      audit(req, { action: apply ? 'clusters.config.pull' : 'clusters.config.pull.preview', target: row.name, args: { groups: list, changes: changes.map((c) => c.key), failed: sum.failed, rejected, rejections } });
      return { peer: peers.get(row.id), source: res.body.data.hostname ?? null, groups: list, applied: apply, changes, rejected, rejections, results, received: Object.keys(res.body.data.settings).length };
    },
  };

  return { PEER_ROLES, GROUP_NAMES, CONFIG_GROUPS, CONFIG_KEYS, peers, tokens, events, dns, config, identity, acceptsDnsPushes };
}
