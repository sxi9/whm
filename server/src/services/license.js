import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { canonicalize, canonicalString } from '../lib/canonical.js';
import { HttpError } from '../lib/errors.js';
import { redact } from '../middleware/audit.js';
import { json } from '../db/index.js';

// Panel-side license client (§16.8). The hub is only needed to activate, check
// in and renew: the token is verified offline against the license keys compiled
// into this release, and every hub answer the panel acts on is verified the same
// way before anything is stored. Nothing here ever touches the host: a license
// transition changes what the API accepts, never a vhost, zone or service.

export const STATUSES = ['unlicensed', 'active', 'grace', 'degraded', 'expired', 'suspended', 'revoked'];
export const SKEW_S = 300;
export const DRIFT_WEIGHTS = { machine_id: 0.5, mac: 0.3, disk: 0.2 };
export const DRIFT_THRESHOLD = 0.5;
export const CHECKIN_JOB = 'license.checkin';
export const CHECKIN_SCHEDULE = 'license.checkin';
const TOKEN_RE = /^WHMT1\.([A-Za-z0-9_-]{16,16384})\.([A-Za-z0-9_-]{80,100})$/;
const KID_RE = /^[0-9a-f]{8}$/;
const SIG_HEADER_RE = /^kid=([0-9a-f]{8}),sig=([A-Za-z0-9_-]+)$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DAY_S = 86400;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const EXPIRING_DAYS = [30, 14, 7, 1];
const EDITION_LABELS = { trial: 'Trial', solo: 'Solo', pro: 'Pro', reseller: 'Reseller', enterprise: 'Enterprise' };
const UPGRADE_HINT = { trial: 'Solo', solo: 'Pro', pro: 'Reseller' };
const DEFAULT_KEYS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'license-keys.json');
const PINNABLE_STATUSES = new Set(['active', 'retiring', 'pending']);
const TRUSTED_STATUSES = new Set(['active', 'retiring']);

const nowIso = (ms) => new Date(ms).toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// kid = first 8 hex of sha256(raw 32-byte public key); the raw key is the tail of the SPKI DER.
export function kidOf(publicKey) {
  const key = typeof publicKey === 'string' || Buffer.isBuffer(publicKey) ? crypto.createPublicKey(publicKey) : publicKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
  const der = key.export({ type: 'spki', format: 'der' });
  return sha256(der.subarray(der.length - 32)).slice(0, 8);
}

// Accepts an SPKI PEM, a base64 SPKI DER or the base64 raw 32-byte key.
export function publicKeyFrom(pub) {
  if (typeof pub !== 'string' || !pub.trim()) throw new Error('empty public key');
  if (pub.includes('-----BEGIN')) return crypto.createPublicKey(pub);
  const raw = Buffer.from(pub.trim(), 'base64');
  if (raw.length === 32) return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  return crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' });
}

// The compiled-in LICENSE keys: the only keys a hub response or token is ever
// verified with (§16.4 as amended). A broken entry is skipped, never fatal.
export function loadLicenseKeys(file = DEFAULT_KEYS_FILE, logger = null) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger?.error({ err, file }, 'license keys file is unreadable; no hub response can be verified');
    return [];
  }
  const out = [];
  for (const entry of Array.isArray(parsed?.keys) ? parsed.keys : []) {
    try {
      if (!KID_RE.test(entry.kid)) throw new Error('malformed kid');
      const publicKey = publicKeyFrom(entry.pub);
      if (kidOf(publicKey) !== entry.kid) throw new Error(`kid does not match the key (${kidOf(publicKey)})`);
      const notAfter = entry.not_after ? new Date(entry.not_after) : null;
      if (notAfter && Number.isNaN(notAfter.getTime())) throw new Error('invalid not_after');
      out.push({ kid: entry.kid, publicKey, pem: publicKey.export({ type: 'spki', format: 'pem' }), notAfter });
    } catch (err) {
      logger?.warn({ kid: entry?.kid, err }, 'skipping an invalid license key entry');
    }
  }
  if (!out.length) logger?.warn({ file }, 'no usable license keys are pinned; activation is impossible until the release ships keys');
  return out;
}

export function normalizeLicenseKey(input) {
  let s = String(input || '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.startsWith('WHM')) s = s.slice(3);
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(s)) return null;
  return `WHM-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

export function fingerprintDrift(stored, current) {
  if (!stored || !current) return null;
  let drift = 0;
  for (const [name, weight] of Object.entries(DRIFT_WEIGHTS)) if (stored[name] !== current[name]) drift += weight;
  return Math.round(drift * 100) / 100;
}

// Offline binding is stricter than the hub's drift arithmetic: a changed
// machine-id means a cloned or reinstalled host (§16.5) even when the NIC and
// disk still match, so it never passes without the hub re-checking it.
export function fingerprintMismatch(stored, current) {
  const drift = fingerprintDrift(stored, current);
  return drift == null || drift > DRIFT_THRESHOLD || stored.machine_id !== current.machine_id;
}

export function decodeToken(token) {
  const m = TOKEN_RE.exec(String(token || ''));
  if (!m) return null;
  const bytes = Buffer.from(m[1], 'base64url');
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return { payload, bytes, sig: m[2] };
}

export function createLicenseService(ctx) {
  const { db, config, logger, crypto: cryptoSvc } = ctx;
  const log = logger.child ? logger.child({ module: 'license' }) : logger;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const clock = { now: typeof config.licenseNow === 'function' ? config.licenseNow : () => Date.now() };
  const keys = loadLicenseKeys(config.licenseKeysFile || DEFAULT_KEYS_FILE, log);
  const keysDir = path.join(config.dataDir, 'plugin-keys');
  const configCheckinHours = Number(config.licenseCheckinHours) > 0 ? Number(config.licenseCheckinHours) : 12;
  // The hub's checkin_interval_hours (stored from the last verified answer) wins over the config default.
  const checkinHours = () => (Number.isInteger(cache.meta.checkinIntervalHours) && cache.meta.checkinIntervalHours >= 1 && cache.meta.checkinIntervalHours <= 168 ? cache.meta.checkinIntervalHours : configCheckinHours);

  const stmts = {
    state: db.prepare('SELECT * FROM license_state WHERE id = 1'),
    save: db.prepare(`UPDATE license_state SET key_enc = @key_enc, token = @token, payload_json = @payload_json, activation_id = @activation_id, status = @status,
      last_checkin_at = @last_checkin_at, last_ok_at = @last_ok_at, next_checkin_at = @next_checkin_at, fail_count = @fail_count, messages_json = @messages_json, updated_at = @updated_at WHERE id = 1`),
    event: db.prepare('INSERT INTO license_events (ts, event, detail_json) VALUES (?, ?, ?)'),
    events: db.prepare('SELECT id, ts, event, detail_json FROM license_events ORDER BY id DESC LIMIT ?'),
    pruneEvents: db.prepare('DELETE FROM license_events WHERE id NOT IN (SELECT id FROM license_events ORDER BY id DESC LIMIT 500)'),
    audit: db.prepare(`INSERT INTO audit_log (principal, role, ip, action, target, args_redacted, result, request_id) VALUES (@principal, @role, @ip, @action, @target, @args, @result, NULL)`),
    accounts: db.prepare('SELECT COUNT(*) AS n FROM accounts'),
    resellers: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'reseller'"),
    domains: db.prepare('SELECT COUNT(*) AS n FROM account_domains'),
    plugins: db.prepare('SELECT id, version, state FROM plugins ORDER BY id LIMIT 500'),
  };
  if (!stmts.state.get()) db.prepare('INSERT OR IGNORE INTO license_state (id) VALUES (1)').run();

  // In-memory cache so get() is synchronous for middleware.
  const cache = { row: null, meta: {}, payload: null, verification: null, fingerprint: null, effective: null };

  function reload() {
    cache.row = stmts.state.get();
    cache.meta = json.parse(cache.row.payload_json, {}) || {};
    const decoded = cache.row.token ? decodeToken(cache.row.token) : null;
    cache.payload = decoded?.payload ?? null;
    cache.verification = cache.row.token ? verifyToken(cache.row.token) : null;
    return cache.row;
  }

  function persist(patch) {
    const row = cache.row || stmts.state.get();
    const next = { ...row, ...patch, updated_at: nowIso(clock.now()) };
    stmts.save.run({
      key_enc: next.key_enc ?? null, token: next.token ?? null, payload_json: next.payload_json ?? '{}', activation_id: next.activation_id ?? null, status: next.status ?? 'unlicensed',
      last_checkin_at: next.last_checkin_at ?? null, last_ok_at: next.last_ok_at ?? null, next_checkin_at: next.next_checkin_at ?? null, fail_count: next.fail_count ?? 0,
      messages_json: next.messages_json ?? '[]', updated_at: next.updated_at,
    });
    reload();
  }

  function saveMeta(patch) {
    persist({ payload_json: JSON.stringify({ ...cache.meta, ...patch }) });
  }

  // ---- events, audit, notifications ---------------------------------------

  // Contact Manager registers after boot(); a transition found at boot waits
  // here until it exists (flushed by index.js after createApp and by get()).
  const pendingNotifications = [];
  const MAX_PENDING = 50;

  function sendNotification({ event, subject, severity, data }) {
    try {
      Promise.resolve(ctx.contacts.notify(event, { subject, severity, data }))
        .catch((err) => log.warn({ err, event }, 'license notification failed'));
    } catch (err) {
      log.warn({ err, event }, 'license notification failed');
    }
  }

  function flushNotifications() {
    if (!pendingNotifications.length || typeof ctx.contacts?.notify !== 'function') return 0;
    const batch = pendingNotifications.splice(0, pendingNotifications.length);
    for (const n of batch) sendNotification(n);
    return batch.length;
  }

  function recordEvent(event, detail = {}, { notify = true, severity, subject, req = null } = {}) {
    try {
      stmts.event.run(nowIso(clock.now()), event, JSON.stringify(redact(detail)));
      stmts.pruneEvents.run();
      stmts.audit.run({ principal: req?.user?.username ?? null, role: req?.user?.role ?? null, ip: req?.ip ?? null, action: event, target: cache.meta.keyPrefix ?? null, args: JSON.stringify(redact(detail)), result: 'ok' });
    } catch (err) {
      log.error({ err, event }, 'failed to record license event');
    }
    if (notify) {
      const n = { event, subject: subject || `License: ${event.replace(/^license\./, '').replace(/_/g, ' ')}`, severity, data: redact(detail) };
      if (typeof ctx.contacts?.notify === 'function') sendNotification(n);
      else if (pendingNotifications.length < MAX_PENDING) pendingNotifications.push(n);
      else log.warn({ event }, 'license notification dropped: contact manager unavailable');
    }
  }

  function emit(name, payload) {
    try { emitter.emit(name, payload); } catch (err) { log.warn({ err, name }, 'license listener failed'); }
  }

  // ---- token verification ------------------------------------------------

  function keyByKid(kid, at = clock.now()) {
    const key = keys.find((k) => k.kid === kid);
    if (!key) return null;
    if (key.notAfter && key.notAfter.getTime() <= at) return null;
    return key;
  }

  function verifyToken(token, { at = clock.now() } = {}) {
    const decoded = decodeToken(token);
    if (!decoded) return { ok: false, reason: 'malformed' };
    const { payload, bytes, sig } = decoded;
    if (payload.v !== 1 || typeof payload.kid !== 'string' || typeof payload.lid !== 'string' || typeof payload.aid !== 'string' || typeof payload.fp !== 'string') return { ok: false, reason: 'malformed', payload };
    try { if (canonicalString(payload) !== bytes.toString('utf8')) return { ok: false, reason: 'not_canonical', payload }; } catch { return { ok: false, reason: 'not_canonical', payload }; }
    const key = keyByKid(payload.kid, at);
    if (!key) return { ok: false, reason: keys.some((k) => k.kid === payload.kid) ? 'retired_kid' : 'unknown_kid', payload };
    let ok = false;
    try { ok = crypto.verify(null, bytes, key.publicKey, Buffer.from(sig, 'base64url')); } catch { ok = false; }
    if (!ok) return { ok: false, reason: 'bad_signature', payload };
    const s = Math.floor(at / 1000);
    if (Number.isInteger(payload.nbf) && s < payload.nbf - SKEW_S) return { ok: false, reason: 'not_yet_valid', payload };
    return { ok: true, payload, expired: Number.isInteger(payload.exp) && s > payload.exp + SKEW_S };
  }

  function verifySigned(body, header) {
    const m = SIG_HEADER_RE.exec(String(header || '').trim());
    if (!m) return false;
    const key = keyByKid(m[1]);
    if (!key) return false;
    let bytes;
    try { bytes = canonicalize(JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body))); } catch { return false; }
    try { return crypto.verify(null, bytes, key.publicKey, Buffer.from(m[2], 'base64url')); } catch { return false; }
  }

  // ---- fingerprint --------------------------------------------------------

  async function currentFingerprint({ refresh = false } = {}) {
    if (cache.fingerprint && !refresh) return cache.fingerprint;
    try {
      const fp = await ctx.agent.op('sys.fingerprint', {});
      if (!fp || typeof fp.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(fp.fingerprint) || !fp.components || !['machine_id', 'mac', 'disk'].every((k) => HEX64.test(fp.components[k]))) {
        log.warn('agent returned an unusable fingerprint');
        return null;
      }
      cache.fingerprint = { fingerprint: fp.fingerprint, components: { machine_id: fp.components.machine_id, mac: fp.components.mac, disk: fp.components.disk } };
      return cache.fingerprint;
    } catch (err) {
      log.warn({ err: err.message }, 'fingerprint unavailable (agent not reachable?)');
      return null;
    }
  }

  // ---- status -------------------------------------------------------------

  const isLicensedState = (s) => s === 'active' || s === 'grace';

  function evaluate(now = clock.now()) {
    const row = cache.row;
    if (!row?.token || !cache.payload) return { status: 'unlicensed', reason: row?.status === 'unlicensed' ? null : 'no_token' };
    if (!cache.verification?.ok) return { status: 'degraded', reason: cache.verification?.reason || 'invalid_token' };
    if (cache.meta.fingerprintMismatch) return { status: 'degraded', reason: 'fingerprint_mismatch' };
    if (['revoked', 'suspended', 'expired', 'degraded'].includes(row.status)) return { status: row.status, reason: cache.meta.statusReason || null };
    const p = cache.payload;
    if (['revoked', 'suspended', 'expired'].includes(p.status)) return { status: p.status, reason: 'token_status' };
    const s = Math.floor(now / 1000);
    if (Number.isInteger(p.exp) && s > p.exp + SKEW_S) {
      const graceDays = Number.isInteger(p.grace) ? p.grace : 7;
      return s <= p.exp + graceDays * DAY_S ? { status: 'grace', reason: 'token_expired' } : { status: 'degraded', reason: 'grace_elapsed' };
    }
    return { status: p.status === 'grace' ? 'grace' : 'active', reason: null };
  }

  const TRANSITION_EVENTS = { grace: 'license.grace_started', degraded: 'license.degraded', expired: 'license.expired', revoked: 'license.revoked', suspended: 'license.suspended' };

  // Persists the effective status and fires the §16.8 events exactly once per
  // change. `previous` lets a caller that already persisted a hub-reported
  // status announce the transition from the state before its own write.
  function settle({ req = null, previous = null } = {}) {
    const from = previous ?? cache.row.status;
    const { status, reason } = evaluate();
    if (status !== cache.row.status) persist({ status, payload_json: JSON.stringify({ ...cache.meta, statusReason: reason ?? null }) });
    if (status !== from) {
      const detail = { from, to: status, reason: reason ?? cache.meta.statusReason ?? null, edition: cache.payload?.ed ?? null, activationId: cache.row.activation_id ?? null };
      recordEvent('license.status_changed', detail, { notify: false, req });
      const event = TRANSITION_EVENTS[status] || (status === 'active' ? 'license.activated' : null);
      if (event) recordEvent(event, detail, { req, severity: status === 'active' ? 'info' : status === 'grace' ? 'warning' : 'error', subject: status === 'active' ? 'License active' : `License ${status}${detail.reason ? ` (${detail.reason})` : ''}` });
      emit('status_changed', { from, to: status, reason: detail.reason });
      ctx.events?.emit?.('license.status_changed', { from, to: status, reason: detail.reason, edition: cache.payload?.ed ?? null })?.catch?.(() => {});
    }
    return status;
  }

  const enforce = () => config.licenseEnforce === true;
  const daysLeft = () => (cache.verification?.ok && Number.isInteger(cache.payload?.lexp) ? Math.max(0, Math.ceil((cache.payload.lexp * 1000 - clock.now()) / (DAY_S * 1000))) : null);

  // Entitlements are only reported from a token whose signature verified (an
  // expired one still counts: the hub signed it); anything else is shown as
  // unverified so the UI never displays what a tampered row claims.
  const tokenVerified = () => Boolean(cache.verification?.ok);

  function get() {
    flushNotifications();
    const status = settle();
    const p = tokenVerified() ? cache.payload : null;
    const row = cache.row;
    return {
      status, enforce: enforce(), degraded: !isLicensedState(status), reason: cache.meta.statusReason ?? null,
      tokenVerified: tokenVerified(), hasToken: Boolean(row.token),
      edition: p?.ed ?? null, editionLabel: p ? EDITION_LABELS[p.ed] || p.ed : null, rank: p?.rank ?? null,
      limits: p?.lim ?? {}, features: p?.feat ?? {},
      activationId: row.activation_id ?? null, licenseId: p?.lid ?? null, keyPrefix: cache.meta.keyPrefix ?? null, hasKey: Boolean(row.key_enc),
      hubUrl: hubUrl(), bootstrapHubUrl: config.licenseHubUrl || null,
      iat: p?.iat ?? null, exp: p?.exp ?? null, lexp: p?.lexp ?? null, grace: p?.grace ?? null, daysLeft: daysLeft(),
      lastCheckinAt: row.last_checkin_at ?? null, lastOkAt: row.last_ok_at ?? null, nextCheckinAt: row.next_checkin_at ?? null, failCount: row.fail_count ?? 0,
      messages: json.parse(row.messages_json, []) || [],
      fingerprint: cache.fingerprint?.fingerprint ?? null, hostname: hostname(),
      pluginSigningKids: pluginSigningKids(), conflictKids: cache.meta.conflictKids ?? [], revocationsHeadTs: cache.meta.revocationsHeadTs ?? null,
      knownActivations: cache.meta.knownActivations ?? [], hubDriftPct: cache.meta.hubDriftPct ?? null, checkinIntervalHours: checkinHours(),
    };
  }

  function summary() {
    const l = get();
    const max = l.limits?.max_activations;
    return { status: l.status, edition: l.edition, daysLeft: l.daysLeft, activations: l.activationId ? `1/${max == null ? '?' : max === -1 ? 'unlimited' : max}` : '0/0', lastCheckinAt: l.lastCheckinAt };
  }

  function summaryForShell() {
    const l = get();
    return { status: l.status, edition: l.edition, daysLeft: l.daysLeft, enforce: l.enforce, degraded: l.degraded, reason: l.reason, action: '/server-configuration/basic-webhost-manager-setup#license' };
  }

  // What a root user who is not the panel owner may know: state, edition and
  // expiry. No hub, no key, no activation, no fingerprint, no hub messages.
  function restrictedView() {
    const l = get();
    return {
      restricted: true, status: l.status, enforce: l.enforce, degraded: l.degraded, reason: l.reason, tokenVerified: l.tokenVerified,
      edition: l.edition, editionLabel: l.editionLabel, limits: l.limits, features: l.features,
      lexp: l.lexp, daysLeft: l.daysLeft, lastCheckinAt: l.lastCheckinAt,
    };
  }

  const token = () => cache.row?.token ?? null;
  // Only a signed `iss` may steer hub calls; an unverifiable token falls back to the bootstrap hub.
  const hubUrl = () => (tokenVerified() && typeof cache.payload?.iss === 'string' && /^https:\/\//.test(cache.payload.iss) ? cache.payload.iss : config.licenseHubUrl || null);
  const isDegraded = () => !isLicensedState(settle());
  const hasFeature = (flag) => cache.payload?.feat?.[flag] === true && isLicensedState(settle());
  const editionLabel = () => (cache.payload ? EDITION_LABELS[cache.payload.ed] || cache.payload.ed : 'current');

  function requireFeature(flag) {
    return (req, _res, next) => {
      if (!enforce() || hasFeature(flag)) return next();
      next(new HttpError(403, 'feature_required', `Your ${editionLabel()} license does not include "${flag}". Upgrade your license to use this function.`, { feature: [flag] }));
    };
  }

  function assertCapacity(kind) {
    if (!enforce() || !cache.payload) return;
    const limitKey = kind === 'accounts' ? 'max_accounts' : kind === 'resellers' ? 'max_resellers' : null;
    if (!limitKey) throw new Error(`unknown capacity "${kind}"`);
    const limit = cache.payload.lim?.[limitKey];
    if (!Number.isInteger(limit) || limit < 0) return;
    const used = (kind === 'accounts' ? stmts.accounts : stmts.resellers).get().n;
    if (used < limit) return;
    const what = kind === 'accounts' ? 'hosting accounts' : 'resellers';
    const hint = UPGRADE_HINT[cache.payload.ed] ? ` Upgrade to ${UPGRADE_HINT[cache.payload.ed]} to add more.` : '';
    const err = new HttpError(409, 'license_limit', `Your ${editionLabel()} license allows ${limit} ${what} (${used} in use).${hint}`, { limit, used });
    err.limit = limit;
    err.used = used;
    throw err;
  }

  // ---- hub transport & signed requests ------------------------------------

  const transport = {
    // `maxBytes` is for package downloads (ctx.marketplace); signed JSON answers keep the 1 MiB default.
    request(url, { method = 'POST', body, headers = {}, timeoutMs = 30_000, maxBytes = MAX_RESPONSE_BYTES } = {}) {
      return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (err) { return reject(err); }
        if (u.protocol !== 'https:') return reject(new Error('the license hub must be reached over https'));
        const options = { method, headers: { ...headers, 'Content-Length': body ? Buffer.byteLength(body) : 0 }, timeout: timeoutMs, rejectUnauthorized: true };
        if (config.licenseHubCa) {
          try { options.ca = fs.readFileSync(config.licenseHubCa); } catch (err) { return reject(new Error(`cannot read WHM_LICENSE_HUB_CA: ${err.message}`)); }
        }
        const req = https.request(u, options, (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(new Error(`hub response too large (over ${maxBytes} bytes)`)); return; } chunks.push(c); });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    },
  };

  const hub = {
    async request(pathname, body = {}, { timeoutMs = 30_000 } = {}) {
      const base = hubUrl();
      if (!base) throw new HttpError(422, 'hub_not_configured', 'No license hub is configured: set WHM_LICENSE_HUB_URL (the vendor hub) before activating');
      let url;
      try { url = new URL(pathname, base); } catch { throw new HttpError(422, 'hub_url_invalid', `The license hub URL "${base}" is not valid`); }
      if (url.protocol !== 'https:') throw new HttpError(422, 'hub_url_insecure', 'The license hub URL must use https://');
      if (!keys.length) throw new HttpError(422, 'no_pinned_keys', 'This release ships no license keys; hub responses cannot be verified');
      const nonce = `n_${crypto.randomBytes(16).toString('hex')}`;
      const ts = Math.floor(clock.now() / 1000);
      const payload = Buffer.from(JSON.stringify({ ...body, nonce, ts }));
      let res;
      try {
        res = await service.transport.request(url.href, {
          method: 'POST', body: payload, timeoutMs,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-WHM-Nonce': nonce, 'X-WHM-Timestamp': String(ts), 'User-Agent': `whm-panel/${ctx.version}` },
        });
      } catch (err) {
        throw new HttpError(503, 'hub_unreachable', `The license hub at ${url.origin} could not be reached: ${err.message}`);
      }
      const header = res.headers?.['x-whm-signature'] ?? res.headers?.['X-WHM-Signature'];
      if (!verifySigned(res.body, header)) throw new HttpError(502, 'hub_signature_invalid', `The answer from ${url.origin} is not signed by a trusted license key`);
      const parsed = JSON.parse(res.body.toString('utf8'));
      if (parsed?.meta?.nonce !== nonce) throw new HttpError(502, 'hub_nonce_mismatch', 'The hub answer does not echo this request (possible replay)');
      if (res.status >= 400 || parsed.error) {
        const e = parsed.error || {};
        const { code, message, ...extra } = e;
        const status = res.status === 401 || res.status === 400 ? 422 : res.status >= 500 ? 502 : res.status;
        const err = new HttpError(status, typeof code === 'string' ? code : 'hub_error', typeof message === 'string' ? message : 'The license hub refused the request', Object.keys(extra).length ? extra : undefined);
        err.hub = true;
        throw err;
      }
      return { data: parsed.data, meta: parsed.meta };
    },
  };

  // ---- request bodies -----------------------------------------------------

  function hostname() {
    const h = String(ctx.settings?.get?.('basic.hostname') || os.hostname() || '').toLowerCase();
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(h) && h.length <= 253 ? h : null;
  }

  async function panelFields({ refresh = false } = {}) {
    const fp = await currentFingerprint({ refresh });
    if (!fp) throw new HttpError(503, 'fingerprint_unavailable', 'The server fingerprint could not be read (is whm-agentd running?)');
    const out = { fingerprint: fp.fingerprint, fp_components: fp.components, panel_version: String(ctx.version || '0.0.0').replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 32) || '0.0.0' };
    const h = hostname();
    if (h) out.hostname = h;
    const osName = `${os.platform()} ${os.release()}`.replace(/[^0-9A-Za-z._ -]/g, '').slice(0, 64).trim();
    if (osName) out.os = osName;
    return out;
  }

  function usage() {
    return {
      accounts: stmts.accounts.get().n, resellers: stmts.resellers.get().n, domains: stmts.domains.get().n,
      plugins: stmts.plugins.all().filter((p) => /^[a-z0-9.-]{3,128}$/.test(p.id) && /^[0-9A-Za-z.+-]{1,32}$/.test(p.version)).map((p) => ({ id: p.id, version: p.version, state: ['installed', 'enabled', 'disabled', 'errored', 'activating'].includes(p.state) ? p.state : 'installed' })),
    };
  }

  function nextCheckinAt(now = clock.now(), { failCount = 0, hours = checkinHours() } = {}) {
    const base = failCount > 0 ? Math.min(hours, Math.pow(2, failCount - 1) * 0.25) * 3600 * 1000 : hours * 3600 * 1000;
    const jitter = (crypto.randomInt(0, 2 * 20 * 60) - 20 * 60) * 1000;
    return nowIso(now + Math.max(60_000, base + jitter));
  }

  // ---- plugin signing keys (§18.6 pinning) --------------------------------

  function pinPluginKeys(list, { req = null } = {}) {
    if (!Array.isArray(list)) return;
    const pinned = cache.meta.pluginKeys || {};
    const previousConflicts = new Set(cache.meta.conflictKids || []);
    const next = {};
    const conflicts = new Set();
    const seen = new Set();
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o750 });
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || !KID_RE.test(entry.kid) || !PINNABLE_STATUSES.has(entry.status)) continue;
      const { kid, status } = entry;
      if (seen.has(kid)) continue;
      seen.add(kid);
      if (keys.some((k) => k.kid === kid)) { recordEvent('license.plugin_key_conflict', { kid, reason: 'collides with a license key' }, { req, severity: 'error' }); conflicts.add(kid); continue; }
      let pem;
      try {
        const key = publicKeyFrom(entry.pub);
        if (key.asymmetricKeyType !== 'ed25519' || kidOf(key) !== kid) throw new Error('kid mismatch');
        pem = key.export({ type: 'spki', format: 'pem' });
      } catch (err) {
        log.warn({ kid, err: err.message }, 'ignoring an invalid plugin signing key from the hub');
        continue;
      }
      const hash = sha256(pem);
      const file = path.join(keysDir, `${kid}.pub`);
      let existing = null;
      try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = null; }
      const ours = Boolean(pinned[kid]) && existing !== null && sha256(existing) === pinned[kid].sha256;
      if (existing !== null && existing !== pem && !ours) {
        conflicts.add(kid);
        if (!previousConflicts.has(kid)) recordEvent('license.plugin_key_conflict', { kid, file, reason: 'an operator-installed key with this id has different content; it was kept and the hub key is not trusted' }, { req, severity: 'error' });
        continue;
      }
      // A pre-existing identical file belongs to the operator: trusted, but never ours to remove.
      const operator = existing !== null && !ours ? true : Boolean(pinned[kid]?.operator);
      if (existing !== pem) {
        try { fs.writeFileSync(file, pem, { mode: 0o640 }); fs.chmodSync(file, 0o640); } catch (err) { log.error({ err, kid }, 'cannot write plugin signing key'); continue; }
      }
      next[kid] = operator ? { status, sha256: hash, operator: true } : { status, sha256: hash };
    }
    for (const [kid, info] of Object.entries(pinned)) {
      if (next[kid] || conflicts.has(kid) || info.operator) continue;
      const file = path.join(keysDir, `${kid}.pub`);
      try {
        if (fs.existsSync(file) && sha256(fs.readFileSync(file, 'utf8')) === info.sha256) fs.unlinkSync(file);
      } catch (err) { log.warn({ err, kid }, 'cannot remove a retired plugin signing key'); }
    }
    const before = JSON.stringify({ pluginKeys: pinned, conflictKids: [...previousConflicts].sort() });
    const after = JSON.stringify({ pluginKeys: next, conflictKids: [...conflicts].sort() });
    saveMeta({ pluginKeys: next, conflictKids: [...conflicts].sort() });
    if (before !== after) {
      recordEvent('license.plugin_keys_updated', { kids: pluginSigningKids(), conflicts: [...conflicts] }, { notify: false, req });
      emit('keys_changed', { kids: pluginSigningKids(), conflicts: [...conflicts] });
    }
  }

  function pluginSigningKids() {
    const conflicts = new Set(cache.meta.conflictKids || []);
    return Object.entries(cache.meta.pluginKeys || {}).filter(([kid, info]) => TRUSTED_STATUSES.has(info.status) && !conflicts.has(kid)).map(([kid]) => kid).sort();
  }

  // ---- applying verified hub answers --------------------------------------

  function handleMessages(messages, { req = null } = {}) {
    const list = Array.isArray(messages) ? messages.filter((m) => m && typeof m === 'object' && typeof m.code === 'string').slice(0, 50) : [];
    for (const m of list) {
      const msg = { level: ['info', 'warning', 'error'].includes(m.level) ? m.level : 'info', code: m.code, text: typeof m.text === 'string' ? m.text : m.code, data: m.data ?? null };
      if (m.code === 'fingerprint_updated') recordEvent('license.fingerprint_changed', { text: msg.text, data: msg.data }, { req, severity: 'warning' });
      else if (m.code === 'clock_skew') recordEvent('license.clock_skew', { text: msg.text }, { req, notify: false });
      emit('message', msg);
    }
    return list;
  }

  function maybeNotifyExpiring({ req = null } = {}) {
    const p = cache.payload;
    if (!Number.isInteger(p?.lexp) || p.status !== 'active') return;
    const days = daysLeft();
    const notified = cache.meta.expiringNotified?.lexp === p.lexp ? cache.meta.expiringNotified.days : [];
    const due = EXPIRING_DAYS.filter((t) => days <= t && !notified.includes(t));
    if (!due.length) return;
    // The threshold is recorded before notifying so two concurrent check-ins cannot both pass the once-per-threshold guard.
    saveMeta({ expiringNotified: { lexp: p.lexp, days: [...notified, ...due] } });
    recordEvent('license.expiring', { daysLeft: days, expiresAt: nowIso(p.lexp * 1000), edition: p.ed }, { req, severity: days <= 7 ? 'error' : 'warning', subject: `License expires in ${days} day${days === 1 ? '' : 's'}` });
  }

  // Stores a verified answer: the token must verify against the pinned keys and
  // be bound to this server before it replaces what we have.
  async function applyAnswer(data, { key = null, source, req = null }) {
    if (!data || typeof data.token !== 'string') throw new HttpError(502, 'hub_answer_invalid', 'The hub answer carries no token');
    const v = verifyToken(data.token);
    if (!v.ok) throw new HttpError(502, 'hub_token_invalid', `The hub issued a token this panel cannot verify (${v.reason})`);
    const fp = await currentFingerprint();
    if (fp && v.payload.fp !== fp.fingerprint && fingerprintMismatch(cache.meta.fpComponents, fp.components)) {
      throw new HttpError(502, 'hub_token_invalid', 'The hub issued a token for a different server fingerprint');
    }
    const now = clock.now();
    const meta = { ...cache.meta, fingerprintMismatch: false, statusReason: null, hubDriftPct: null, fpComponents: fp?.components ?? cache.meta.fpComponents ?? null, lastAnswerAt: nowIso(now), lastAnswerSource: source };
    if (key) meta.keyPrefix = key.slice(0, 8);
    meta.checkinIntervalHours = Number.isInteger(data.checkin_interval_hours) && data.checkin_interval_hours >= 1 && data.checkin_interval_hours <= 168 ? data.checkin_interval_hours : null;
    const hours = meta.checkinIntervalHours ?? configCheckinHours;
    if (data.license && typeof data.license === 'object') meta.license = { edition: data.license.edition ?? null, expiresAt: data.license.expires_at ?? null, daysLeft: data.license.days_left ?? null };
    const status = ['active', 'grace', 'expired', 'suspended', 'revoked'].includes(v.payload.status) ? v.payload.status : 'active';
    const previous = cache.row.status;
    persist({
      key_enc: key ? cryptoSvc.encrypt(key) : cache.row.key_enc, token: data.token, payload_json: JSON.stringify(meta), activation_id: typeof data.activation_id === 'string' ? data.activation_id : v.payload.aid,
      status, last_checkin_at: nowIso(now), last_ok_at: nowIso(now), next_checkin_at: nextCheckinAt(now, { hours }), fail_count: 0, messages_json: JSON.stringify(handleMessages(data.messages, { req })),
    });
    if (Number.isInteger(data.revocations_head_ts)) {
      saveMeta({ revocationsHeadTs: data.revocations_head_ts });
      emit('message', { level: 'info', code: 'revocations_head_ts', value: data.revocations_head_ts, text: 'revocation feed head' });
    }
    if (data.plugin_signing_keys !== undefined) pinPluginKeys(data.plugin_signing_keys, { req });
    syncSchedule();
    maybeNotifyExpiring({ req });
    return settle({ req, previous });
  }

  // activation_limit / fingerprint_mismatch answers carry the hub's view of the
  // license's servers and, for a mismatch, how far this server drifted from the
  // stored fingerprint as an integer percent (`drift_pct`, §16.5).
  function rememberActivations(err) {
    const list = Array.isArray(err?.fields?.activations) ? err.fields.activations.slice(0, 50).map((a) => ({ id: String(a.id ?? ''), hostname: a.hostname ?? null, last_checkin: a.last_checkin ?? null })) : null;
    const pct = err?.fields?.drift_pct;
    const hubDriftPct = Number.isInteger(pct) && pct >= 0 && pct <= 100 ? pct : null;
    if (list || hubDriftPct != null) saveMeta({ ...(list ? { knownActivations: list } : {}), hubDriftPct });
  }

  // ---- public operations --------------------------------------------------

  async function activate(keyInput, user, req, { transferFrom = null } = {}) {
    let key = keyInput ? normalizeLicenseKey(keyInput) : null;
    if (keyInput && !key) throw new HttpError(422, 'invalid_key', 'A license key looks like WHM-XXXX-XXXX-XXXX-XXXX', { key: ['Malformed license key'] });
    if (!key) {
      if (!cache.row.key_enc) throw new HttpError(422, 'key_required', 'Enter the license key to activate this server', { key: ['Required'] });
      key = cryptoSvc.decrypt(cache.row.key_enc);
    }
    const fields = await panelFields({ refresh: true });
    const body = transferFrom ? { key, from_activation: transferFrom, ...fields } : { key, ...fields };
    let answer;
    try {
      answer = await hub.request(transferFrom ? '/v1/transfers' : '/v1/activate', body);
    } catch (err) {
      if (err.code === 'activation_limit' || err.code === 'fingerprint_mismatch') rememberActivations(err);
      recordEvent('license.activation_failed', { code: err.code, message: err.message, keyPrefix: key.slice(0, 8), transferFrom }, { req, notify: false });
      throw err;
    }
    const status = await applyAnswer(answer.data, { key, source: transferFrom ? 'transfer' : 'activate', req });
    saveMeta({ knownActivations: [], hubDriftPct: null });
    recordEvent('license.activate', { edition: cache.payload?.ed ?? null, activationId: cache.row.activation_id, keyPrefix: key.slice(0, 8), transferFrom, status }, { req, notify: false });
    return get();
  }

  async function checkin({ force = false } = {}, { req = null, job = null } = {}) {
    if (!cache.row.token) {
      if (req) throw new HttpError(409, 'unlicensed', 'No license is active on this server; enter a key first');
      return { ok: false, skipped: 'unlicensed' };
    }
    if (!force && cache.row.next_checkin_at && new Date(cache.row.next_checkin_at).getTime() > clock.now()) return { ok: true, skipped: 'not_due', nextCheckinAt: cache.row.next_checkin_at };
    const now = clock.now();
    let fields;
    try {
      fields = await panelFields({ refresh: true });
    } catch (err) {
      return failedCheckin(err, { now, req, job });
    }
    try {
      const answer = await hub.request('/v1/checkin', { token: cache.row.token, ...fields, usage: usage() });
      const status = await applyAnswer(answer.data, { source: 'checkin', req });
      job?.log?.(`check-in ok: ${status}`);
      return { ok: true, status, license: get() };
    } catch (err) {
      return failedCheckin(err, { now, req, job });
    }
  }

  function failedCheckin(err, { now, req, job }) {
    const code = err.code || 'error';
    job?.log?.(`check-in failed: ${code} ${err.message}`, 'warn');
    if (code === 'revoked' || code === 'deactivated' || code === 'suspended' || code === 'fingerprint_mismatch') {
      if (code === 'fingerprint_mismatch') rememberActivations(err);
      const status = code === 'revoked' ? 'revoked' : code === 'suspended' ? 'suspended' : 'degraded';
      const previous = cache.row.status;
      persist({ status, last_checkin_at: nowIso(now), next_checkin_at: nextCheckinAt(now), fail_count: 0, payload_json: JSON.stringify({ ...cache.meta, statusReason: code, fingerprintMismatch: code === 'fingerprint_mismatch' }) });
      const final = settle({ req, previous });
      recordEvent(`license.checkin_${code}`, { message: err.message }, { req, notify: false });
      syncSchedule();
      return { ok: false, status: final, code, message: err.message, license: get() };
    }
    const failCount = (cache.row.fail_count || 0) + 1;
    persist({ last_checkin_at: nowIso(now), next_checkin_at: nextCheckinAt(now, { failCount }), fail_count: failCount });
    recordEvent('license.checkin_failed', { code, message: err.message, failCount }, { req, notify: failCount === 3, severity: 'warning', subject: `License check-in failed ${failCount} times` });
    const status = settle({ req });
    return { ok: false, status, code, message: err.message, failCount, license: get() };
  }

  async function deactivate(reason, user, req) {
    if (!cache.row.token) throw new HttpError(409, 'unlicensed', 'This server has no active license');
    let hubResult = null;
    try {
      hubResult = (await hub.request('/v1/deactivate', { token: cache.row.token, ...(reason ? { reason } : {}) })).data;
    } catch (err) {
      // The hub no longer knows this activation: clearing locally is the right outcome.
      if (!['deactivated', 'revoked', 'not_found', 'invalid_token', 'expired'].includes(err.code)) throw err;
      hubResult = { deactivated: false, reason: err.code };
    }
    const previous = cache.row.status;
    persist({ token: null, activation_id: null, status: 'unlicensed', next_checkin_at: null, fail_count: 0, messages_json: '[]', payload_json: JSON.stringify({ ...cache.meta, statusReason: 'deactivated', fingerprintMismatch: false, knownActivations: [] }) });
    recordEvent('license.deactivated', { reason: reason ?? null, hub: hubResult, from: previous }, { req, severity: 'warning', subject: 'License deactivated on this server' });
    emit('status_changed', { from: previous, to: 'unlicensed', reason: 'deactivated' });
    syncSchedule();
    return { deactivated: true, hub: hubResult, license: get() };
  }

  async function startTrial(email, user, req) {
    if (cache.row.token) throw new HttpError(409, 'already_licensed', 'This server already has a license; deactivate it before starting a trial');
    const fields = await panelFields({ refresh: true });
    let answer;
    try {
      answer = await hub.request('/v1/trial', { email, ...fields });
    } catch (err) {
      recordEvent('license.trial_failed', { code: err.code, message: err.message }, { req, notify: false });
      throw err;
    }
    const key = typeof answer.data?.key === 'string' ? normalizeLicenseKey(answer.data.key) || answer.data.key : null;
    await applyAnswer(answer.data, { key, source: 'trial', req });
    recordEvent('license.trial_started', { edition: cache.payload?.ed ?? 'trial', expiresAt: answer.data.expires_at ?? null, activationId: cache.row.activation_id }, { req, notify: false });
    return get();
  }

  function activations() {
    const l = get();
    const current = l.activationId ? { id: l.activationId, hostname: l.hostname, fingerprint: l.fingerprint, lastCheckinAt: l.lastOkAt, status: l.status, current: true } : null;
    return { current, others: (cache.meta.knownActivations || []).filter((a) => a.id !== l.activationId), max: l.limits?.max_activations ?? null };
  }

  function events(limit = 50) {
    return stmts.events.all(Math.min(Math.max(1, limit), 500)).map((r) => ({ id: r.id, ts: r.ts, event: r.event, detail: json.parse(r.detail_json, null) }));
  }

  // ---- scheduling ---------------------------------------------------------

  // The cron follows next_checkin_at (interval + jitter, or the failure
  // backoff): it fires at that minute and at every interval after it, and each
  // answer re-derives it, so the designed jitter spreads the scheduled runs.
  function checkinCron(nextAt, hours) {
    const at = new Date(nextAt);
    if (Number.isNaN(at.getTime())) return null;
    const step = Math.min(24, Math.max(1, Math.round(hours)));
    const hoursList = [];
    // The scheduler matches local time.
    for (let h = at.getHours(); hoursList.length < 24 / step && !hoursList.includes(h); h = (h + step) % 24) hoursList.push(h);
    return `${at.getMinutes()} ${hoursList.sort((a, b) => a - b).join(',')} * * *`;
  }

  function syncSchedule() {
    try {
      const hours = checkinHours();
      const cron = checkinCron(cache.row.next_checkin_at, hours) || `${crypto.randomInt(0, 60)} */${Math.min(23, hours)} * * *`;
      ctx.scheduler.ensure(CHECKIN_SCHEDULE, cron, CHECKIN_JOB);
      ctx.scheduler.update(CHECKIN_SCHEDULE, { cron, enabled: Boolean(cache.row.token) });
    } catch (err) {
      log.warn({ err }, 'cannot sync the license check-in schedule');
    }
  }

  ctx.jobs.register(CHECKIN_JOB, async (job) => {
    job.log('license check-in');
    const result = await checkin({ force: true }, { job });
    if (result.skipped) job.log(`skipped: ${result.skipped}`);
    return { ok: result.ok, status: result.status ?? null, code: result.code ?? null, skipped: result.skipped ?? null };
  });

  async function boot() {
    reload();
    let newMismatch = false;
    if (cache.row.token && cache.payload) {
      const fp = await currentFingerprint({ refresh: true });
      let mismatch = false;
      if (fp && cache.payload.fp !== fp.fingerprint) {
        mismatch = fingerprintMismatch(cache.meta.fpComponents, fp.components);
        if (!mismatch) log.info({ drift: fingerprintDrift(cache.meta.fpComponents, fp.components) }, 'server fingerprint drifted within tolerance; the hub updates it at the next check-in');
      }
      newMismatch = mismatch && !cache.meta.fingerprintMismatch;
      if (mismatch !== Boolean(cache.meta.fingerprintMismatch)) {
        // Back on the original hardware: the hub-independent degradation lifts and the token decides again.
        const restored = !mismatch && cache.meta.statusReason === 'fingerprint_mismatch';
        saveMeta({ fingerprintMismatch: mismatch, statusReason: mismatch ? 'fingerprint_mismatch' : restored ? null : cache.meta.statusReason ?? null });
        if (restored) persist({ status: ['active', 'grace', 'expired', 'suspended', 'revoked'].includes(cache.payload.status) ? cache.payload.status : 'active' });
      }
      if (mismatch && cache.row.status !== 'degraded') persist({ status: 'degraded' });
      if (!cache.verification?.ok) log.error({ reason: cache.verification?.reason }, 'stored license token does not verify against the pinned keys');
    }
    settle();
    syncSchedule();
    // A check-in is due, or the hub must arbitrate a fingerprint the panel refused offline.
    if (cache.row.token && (newMismatch || !cache.row.next_checkin_at || new Date(cache.row.next_checkin_at).getTime() <= clock.now())) {
      try { ctx.jobs.enqueue(CHECKIN_JOB, { reason: newMismatch ? 'fingerprint_mismatch' : 'boot' }); } catch (err) { log.warn({ err }, 'cannot enqueue the boot check-in'); }
    }
    const l = get();
    log.info({ status: l.status, edition: l.edition, enforce: l.enforce, keys: keys.map((k) => k.kid) }, 'license state loaded');
    return l;
  }

  reload();

  const service = {
    boot, get, summary, summaryForShell, restrictedView, token, hubUrl, isDegraded, hasFeature, requireFeature, assertCapacity,
    activate, checkin, deactivate, startTrial, activations, events, pluginSigningKids, verifySigned, verifyToken,
    hub, transport, clock, keys: () => keys.map((k) => ({ kid: k.kid, notAfter: k.notAfter ? k.notAfter.toISOString() : null })),
    on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn); },
    enforce, flushNotifications,
    // Test seams: reload the cached row after a direct DB edit; apply a signed answer by hand.
    _reload: reload, _settle: settle, _pinPluginKeys: pinPluginKeys,
  };
  return service;
}
