import crypto from 'node:crypto';
import { HttpError, notFound, forbidden } from '../../shared/errors.js';
import { json, newId, paginate, nowIso } from '../../shared/db.js';
import * as keyfmt from '../../shared/keyfmt.js';
import { canonicalize, canonicalString } from '../../shared/canonical.js';
import { parseSignatureHeader } from '../../shared/keys.js';

export const TOKEN_PREFIX = 'WHMT1';
export const SKEW_S = 300;
const TERM_MONTHS = { monthly: 1, annual: 12 };
const DAY_MS = 86_400_000;

export function addMonths(iso, months) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}

export function createLicensesService(ctx) {
  const db = ctx.dbs.license;
  const cfg = ctx.config.license;
  const stmts = {
    byId: db.prepare('SELECT * FROM licenses WHERE id = ?'),
    byHash: db.prepare('SELECT * FROM licenses WHERE key_hash = ?'),
    byPrefix: db.prepare('SELECT * FROM licenses WHERE key_prefix = ? ORDER BY issued_at'),
    byExternalRef: db.prepare('SELECT * FROM licenses WHERE external_ref = ? ORDER BY issued_at DESC'),
    insert: db.prepare(`INSERT INTO licenses (id, key_hash, key_prefix, product_id, edition, rank, term, limits_json, features_json, status, issued_at, starts_at, expires_at,
      grace_days, max_activations, customer_id, reseller_id, issued_by, notes, external_ref, created_at, updated_at)
      VALUES (@id, @key_hash, @key_prefix, @product_id, @edition, @rank, @term, @limits_json, @features_json, @status, @issued_at, @starts_at, @expires_at,
      @grace_days, @max_activations, @customer_id, @reseller_id, @issued_by, @notes, @external_ref, @issued_at, @issued_at)`),
    setStatus: db.prepare('UPDATE licenses SET status = @status, notes = COALESCE(@notes, notes), updated_at = @now WHERE id = @id'),
    setExpiry: db.prepare('UPDATE licenses SET expires_at = @expires_at, status = @status, updated_at = @now WHERE id = @id'),
    setEdition: db.prepare(`UPDATE licenses SET product_id = @product_id, edition = @edition, rank = @rank, term = @term, limits_json = @limits_json, features_json = @features_json,
      max_activations = @max_activations, grace_days = @grace_days, updated_at = @now WHERE id = @id`),
    setKey: db.prepare('UPDATE licenses SET key_hash = @key_hash, key_prefix = @key_prefix, updated_at = @now WHERE id = @id'),
    setOverride: db.prepare('UPDATE licenses SET reactivation_override_until = @until, updated_at = @now WHERE id = @id'),
    activeActivations: db.prepare("SELECT id, hostname, last_checkin, fingerprint FROM activations WHERE license_id = ? AND status = 'active' ORDER BY first_seen"),
    blockActivations: db.prepare("UPDATE activations SET status = 'blocked', deactivated_at = @now, deactivated_by = @by WHERE license_id = @id AND status = 'active'"),
    insertRevocation: db.prepare('INSERT INTO revocations (id, license_id, activation_id, reason, revoked_by, ts) VALUES (@id, @license_id, @activation_id, @reason, @revoked_by, @ts)'),
    lastCheckin: db.prepare('SELECT accounts_used, resellers_used, domains_used, ts FROM checkins WHERE license_id = ? ORDER BY id DESC LIMIT 1'),
    expireDue: db.prepare("SELECT id, expires_at, grace_days FROM licenses WHERE status = 'active' AND expires_at IS NOT NULL"),
    expiring: db.prepare("SELECT * FROM licenses WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > @from AND expires_at <= @to"),
    customerEmail: db.prepare('SELECT email, name FROM customers WHERE id = ?'),
    insertFailure: db.prepare('INSERT INTO lookup_failures (ip, ts) VALUES (?, ?)'),
    countFailures: db.prepare('SELECT COUNT(*) AS n FROM lookup_failures WHERE ip = ? AND ts >= ?'),
    pruneFailures: db.prepare('DELETE FROM lookup_failures WHERE ts < ?'),
    block: db.prepare('INSERT INTO ip_blocks (ip, until, reason, created_at) VALUES (@ip, @until, @reason, @now) ON CONFLICT (ip) DO UPDATE SET until = excluded.until, reason = excluded.reason'),
    blocked: db.prepare('SELECT until FROM ip_blocks WHERE ip = ?'),
    unblock: db.prepare('DELETE FROM ip_blocks WHERE ip = ?'),
  };

  const now = () => ctx.clock.now();

  function shape(row) {
    if (!row) return null;
    return { ...row, limits: json.parse(row.limits_json, {}), features: json.parse(row.features_json, {}), limits_json: undefined, features_json: undefined, key_hash: undefined };
  }

  function assertScope(row, scope) {
    if (!row) throw notFound('License');
    if (scope?.resellerId && row.reseller_id !== scope.resellerId) throw notFound('License');
    return row;
  }

  // active|grace|expired|suspended|revoked|pending as of `at` (ms).
  function statusAt(lic, at = now()) {
    if (lic.status === 'revoked' || lic.status === 'suspended' || lic.status === 'pending') return lic.status;
    if (lic.status === 'expired') return 'expired';
    if (!lic.expires_at) return 'active';
    const exp = new Date(lic.expires_at).getTime();
    if (at < exp) return 'active';
    if (at < exp + lic.grace_days * DAY_MS) return 'grace';
    return 'expired';
  }

  function eventData(lic, extra = {}) {
    return { license_id: lic.id, key_prefix: lic.key_prefix, edition: lic.edition, customer_id: lic.customer_id, reseller_id: lic.reseller_id, external_ref: lic.external_ref, expires_at: lic.expires_at, status: lic.status, ...extra };
  }

  function emit(event, lic, extra = {}) {
    const data = eventData(lic, extra);
    ctx.webhooks.enqueue(db, { ownerType: 'vendor', ownerId: 'vnd_default', event, data, now: now() });
    if (lic.reseller_id) ctx.webhooks.enqueue(db, { ownerType: 'reseller', ownerId: lic.reseller_id, event, data, now: now() });
    return data;
  }

  function audit(actor, action, target, args, result = 'ok') {
    ctx.audit.record({ principal: actor?.principal ?? actor?.label ?? 'system', ip: actor?.ip ?? null, action, target, args, result });
  }

  function expiryFor(snapshot, startsAt, termMonths) {
    if (snapshot.term === 'days') return new Date(new Date(startsAt).getTime() + (snapshot.term_days || cfg.trial_days) * DAY_MS).toISOString();
    if (snapshot.term === 'contract') return termMonths ? addMonths(startsAt, termMonths) : null;
    return addMonths(startsAt, termMonths || TERM_MONTHS[snapshot.term] || 12);
  }

  const svc = {
    shape,
    statusAt,
    emit,
    get(id, scope = null) {
      return shape(assertScope(stmts.byId.get(id), scope));
    },
    getRaw: (id) => stmts.byId.get(id) || null,
    findByKey(key) {
      const normalized = keyfmt.normalize(key);
      if (!normalized || !keyfmt.check(normalized)) return null;
      return shape(stmts.byHash.get(keyfmt.hash(normalized)));
    },
    findByPrefix: (prefix) => stmts.byPrefix.all(String(prefix).toUpperCase()).map(shape),
    findByExternalRef: (ref) => stmts.byExternalRef.all(ref).map(shape),
    list(query = {}, scope = null) {
      const where = [];
      const params = {};
      if (scope?.resellerId) { where.push('l.reseller_id = @reseller'); params.reseller = scope.resellerId; }
      if (query.q) { where.push('(l.key_prefix LIKE @q OR c.email LIKE @q OR c.name LIKE @q OR l.external_ref LIKE @q OR l.id LIKE @q OR EXISTS (SELECT 1 FROM activations a WHERE a.license_id = l.id AND (a.hostname LIKE @q OR a.public_ip LIKE @q)))'); params.q = `%${query.q}%`; }
      if (query.status) { where.push('l.status = @status'); params.status = query.status; }
      if (query.edition) { where.push('l.edition = @edition'); params.edition = query.edition; }
      if (query.customer_id) { where.push('l.customer_id = @customer'); params.customer = query.customer_id; }
      if (query.expiring_within) { where.push('l.expires_at IS NOT NULL AND l.expires_at <= @until'); params.until = nowIso(now() + query.expiring_within * DAY_MS); }
      const page = paginate(db, {
        select: 'l.*, c.email AS customer_email, c.name AS customer_name, (SELECT COUNT(*) FROM activations a WHERE a.license_id = l.id AND a.status = \'active\') AS active_activations',
        from: 'licenses l JOIN customers c ON c.id = l.customer_id', where, params,
        sortable: { issued_at: 'l.issued_at', expires_at: 'l.expires_at', edition: 'l.rank', status: 'l.status', key_prefix: 'l.key_prefix' }, defaultSort: 'issued_at', query: { dir: 'desc', ...query },
      });
      return { ...page, data: page.data.map(shape) };
    },
    activationsOf: (id) => stmts.activeActivations.all(id).map((a) => ({ id: a.id, hostname: a.hostname, last_checkin: a.last_checkin })),

    // Issue: the clear-text key is returned once and never stored.
    issue(input, { actor = null, scope = null } = {}) {
      const snapshot = ctx.products.snapshot(input.sku);
      if (scope?.resellerId) ctx.resellers.assertQuota(scope.resellerId, snapshot.edition, 1);
      const customer = input.customer_id ? ctx.customers.get(input.customer_id, scope) : ctx.customers.findOrCreate(input.customer, scope);
      const key = keyfmt.generate();
      const startsAt = input.starts_at || nowIso(now());
      const id = newId('lic', now());
      const row = {
        id, key_hash: keyfmt.hash(key), key_prefix: keyfmt.prefixOf(key), product_id: snapshot.product_id, edition: snapshot.edition, rank: snapshot.rank, term: snapshot.term,
        limits_json: JSON.stringify({ ...snapshot.limits, ...(input.limits || {}) }), features_json: JSON.stringify({ ...snapshot.features, ...(input.features || {}) }),
        status: new Date(startsAt).getTime() > now() ? 'pending' : 'active', issued_at: nowIso(now()), starts_at: startsAt,
        expires_at: expiryFor(snapshot, startsAt, input.term_months), grace_days: input.grace_days ?? snapshot.grace_days, max_activations: input.max_activations ?? snapshot.max_activations,
        customer_id: customer.id, reseller_id: scope?.resellerId || input.reseller_id || customer.reseller_id || null, issued_by: actor?.principal ? String(typeof actor.principal === 'string' ? actor.principal : actor.principal.type === 'api_key' ? `apikey:${actor.principal.keyId}` : `portal:${actor.principal.userId}`) : 'system',
        notes: input.notes || null, external_ref: input.external_ref || null,
      };
      stmts.insert.run(row);
      let quotaLeft = null;
      if (row.reseller_id) quotaLeft = ctx.resellers.consume(row.reseller_id, snapshot.edition, 1);
      const lic = svc.get(id);
      audit(actor, 'license.issue', id, { sku: input.sku, customer_id: customer.id, external_ref: row.external_ref });
      emit('license.issued', lic);
      if (input.notify !== false) ctx.mailer.send({ to: customer.email, template: 'license.issued', data: { name: customer.name, edition: lic.edition, key_prefix: lic.key_prefix, expires_at: lic.expires_at, portal_url: cfg.vendor.portal_url || ctx.config.public_url } });
      return { license: lic, key, quota_left: quotaLeft };
    },

    renew(id, { term_months }, { actor = null, scope = null } = {}) {
      const lic = svc.get(id, scope);
      if (lic.status === 'revoked') throw new HttpError(409, 'revoked', 'A revoked license cannot be renewed');
      if (lic.term === 'days') throw new HttpError(409, 'not_renewable', 'Trials are not renewable; convert the trial instead');
      const base = Math.max(now(), lic.expires_at ? new Date(lic.expires_at).getTime() : 0);
      const expiresAt = addMonths(new Date(base).toISOString(), term_months);
      const status = lic.status === 'expired' ? 'active' : lic.status;
      stmts.setExpiry.run({ id, expires_at: expiresAt, status, now: nowIso(now()) });
      const next = svc.get(id);
      audit(actor, 'license.renew', id, { term_months, expires_at: expiresAt });
      emit('license.renewed', next, { previous_expires_at: lic.expires_at });
      return next;
    },

    lastUsage(id) {
      const row = stmts.lastCheckin.get(id);
      return row ? { accounts: row.accounts_used ?? 0, resellers: row.resellers_used ?? 0, domains: row.domains_used ?? 0, ts: row.ts } : null;
    },

    changeEdition(id, { sku, force = false, prorate = false }, { actor = null, scope = null } = {}) {
      const lic = svc.get(id, scope);
      if (lic.status === 'revoked') throw new HttpError(409, 'revoked', 'A revoked license cannot change edition');
      const snapshot = ctx.products.snapshot(sku);
      if (scope?.resellerId && snapshot.rank > lic.rank) ctx.resellers.assertQuota(scope.resellerId, snapshot.edition, 1);
      const usage = svc.lastUsage(id);
      const activeCount = stmts.activeActivations.all(id).length;
      if (!force) {
        const over = {};
        if (usage && snapshot.limits.max_accounts !== -1 && usage.accounts > snapshot.limits.max_accounts) { over.accounts = usage.accounts; over.max_accounts = snapshot.limits.max_accounts; }
        if (usage && snapshot.limits.max_resellers !== -1 && usage.resellers > snapshot.limits.max_resellers) { over.resellers = usage.resellers; over.max_resellers = snapshot.limits.max_resellers; }
        if (activeCount > snapshot.max_activations) { over.activations = activeCount; over.max_activations = snapshot.max_activations; }
        if (Object.keys(over).length) throw Object.assign(new HttpError(409, 'over_limit', 'The license uses more than the new edition allows; pass force to downgrade anyway'), { extra: over });
      }
      stmts.setEdition.run({ id, product_id: snapshot.product_id, edition: snapshot.edition, rank: snapshot.rank, term: snapshot.term, limits_json: JSON.stringify(snapshot.limits), features_json: JSON.stringify(snapshot.features), max_activations: snapshot.max_activations, grace_days: snapshot.grace_days, now: nowIso(now()) });
      if (scope?.resellerId && snapshot.rank > lic.rank) ctx.resellers.consume(scope.resellerId, snapshot.edition, 1);
      const next = svc.get(id);
      audit(actor, 'license.change_edition', id, { sku, force, prorate, from: lic.edition, to: snapshot.edition });
      emit('license.edition_changed', next, { previous_edition: lic.edition, forced: force });
      ctx.activations.pushMessage({ licenseId: id }, { level: 'info', code: 'edition_changed', text: `License edition is now ${snapshot.edition}; new limits apply at this check-in` });
      return next;
    },

    suspend(id, { reason }, { actor = null, scope = null } = {}) {
      const lic = svc.get(id, scope);
      if (lic.status === 'revoked') throw new HttpError(409, 'revoked', 'License is revoked');
      stmts.setStatus.run({ id, status: 'suspended', notes: null, now: nowIso(now()) });
      audit(actor, 'license.suspend', id, { reason });
      emit('license.suspended', svc.get(id), { reason });
      return svc.get(id);
    },
    unsuspend(id, _input = {}, { actor = null, scope = null } = {}) {
      const lic = svc.get(id, scope);
      if (lic.status !== 'suspended') throw new HttpError(409, 'not_suspended', 'License is not suspended');
      const next = lic.expires_at && new Date(lic.expires_at).getTime() + lic.grace_days * DAY_MS <= now() ? 'expired' : 'active';
      stmts.setStatus.run({ id, status: next, notes: null, now: nowIso(now()) });
      audit(actor, 'license.unsuspend', id, {});
      return svc.get(id);
    },
    revoke(id, { reason }, { actor = null, scope = null } = {}) {
      const lic = svc.get(id, scope);
      if (lic.status === 'revoked') throw new HttpError(409, 'revoked', 'License is already revoked');
      const ts = nowIso(now());
      const by = actor?.principal ? (typeof actor.principal === 'string' ? actor.principal : `${actor.principal.type}:${actor.principal.keyId || actor.principal.userId}`) : 'system';
      db.transaction(() => {
        stmts.setStatus.run({ id, status: 'revoked', notes: null, now: ts });
        stmts.blockActivations.run({ id, now: ts, by });
        stmts.insertRevocation.run({ id: newId('rev', now()), license_id: id, activation_id: null, reason: reason || null, revoked_by: by, ts });
      })();
      audit(actor, 'license.revoke', id, { reason });
      emit('license.revoked', svc.get(id), { reason, revoked_at: ts });
      return svc.get(id);
    },
    // A new key for a lost one: the old hash stops resolving; tokens and
    // activations are untouched because they reference the license id.
    rekey(id, { reason } = {}, { actor = null, scope = null } = {}) {
      svc.get(id, scope);
      const key = keyfmt.generate();
      stmts.setKey.run({ id, key_hash: keyfmt.hash(key), key_prefix: keyfmt.prefixOf(key), now: nowIso(now()) });
      audit(actor, 'license.rekey', id, { reason });
      return { license: svc.get(id), key };
    },
    liftReactivationLimit(id, { days = 7 } = {}, { actor = null } = {}) {
      svc.get(id);
      const until = nowIso(now() + days * DAY_MS);
      stmts.setOverride.run({ id, until, now: nowIso(now()) });
      audit(actor, 'license.lift_reactivation_limit', id, { days });
      return svc.get(id);
    },
    featureOf(id, flag) {
      const lic = svc.get(id);
      return lic.features?.[flag] === true;
    },

    // §16.4 token: WHMT1.<base64url(canonical payload)>.<base64url(sig)>.
    issueToken({ license, activation, status }) {
      const key = ctx.keys.active('license');
      if (!key) throw new HttpError(503, 'no_active_key', 'No active license signing key');
      const iat = Math.floor(now() / 1000);
      const ttl = cfg.token_ttl_hours * 3600;
      const lexp = license.expires_at ? Math.floor(new Date(license.expires_at).getTime() / 1000) : null;
      const st = status || statusAt(license);
      let exp = iat + ttl;
      if (lexp != null && st !== 'expired') exp = Math.min(exp, lexp + license.grace_days * 86400);
      if (exp <= iat) exp = iat + ttl;
      const payload = {
        v: 1, iss: ctx.config.public_url, kid: key.kid, lid: license.id, aid: activation.id, cid: license.customer_id,
        ed: license.edition, rank: license.rank, lim: license.limits, feat: license.features, fp: activation.fingerprint,
        iat, nbf: iat - SKEW_S, exp, lexp, grace: license.grace_days, nonce: `n_${crypto.randomBytes(12).toString('hex')}`, status: st,
      };
      const bytes = canonicalize(payload);
      const t0 = process.hrtime.bigint();
      const sig = ctx.keys.sign(bytes, { kid: key.kid, purpose: 'license', encoding: 'base64url' });
      ctx.metrics?.observe('token_sign_latency', Number(process.hrtime.bigint() - t0) / 1e6);
      return { token: `${TOKEN_PREFIX}.${bytes.toString('base64url')}.${sig}`, payload };
    },
    // The same algorithm the panel runs offline; `now` in ms.
    verifyToken(token, { now: at = now(), skewS = SKEW_S } = {}) {
      if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: 'malformed' };
      let payload; let bytes;
      try {
        bytes = Buffer.from(parts[1], 'base64url');
        if (bytes.toString('base64url') !== parts[1]) return { ok: false, reason: 'malformed' };
        payload = JSON.parse(bytes.toString('utf8'));
      } catch { return { ok: false, reason: 'malformed' }; }
      if (!payload || typeof payload !== 'object' || payload.v !== 1 || typeof payload.kid !== 'string' || typeof payload.lid !== 'string' || typeof payload.aid !== 'string') return { ok: false, reason: 'malformed' };
      try { if (canonicalString(payload) !== bytes.toString('utf8')) return { ok: false, reason: 'not_canonical', payload }; } catch { return { ok: false, reason: 'not_canonical', payload }; }
      const key = ctx.keys.byKid(payload.kid);
      if (!key || key.purpose !== 'license') return { ok: false, reason: 'unknown_kid', payload };
      if (key.status === 'retired') return { ok: false, reason: 'retired_kid', payload };
      if (!ctx.keys.verify(bytes, parts[2], { kid: payload.kid, purpose: 'license', encoding: 'base64url' })) return { ok: false, reason: 'bad_signature', payload };
      const s = Math.floor(at / 1000);
      if (Number.isInteger(payload.nbf) && s < payload.nbf - skewS) return { ok: false, reason: 'not_yet_valid', payload };
      if (Number.isInteger(payload.exp) && s > payload.exp + skewS) return { ok: false, reason: 'expired', payload };
      return { ok: true, payload };
    },
    // Verifies X-WHM-Signature over a raw body the way the panel does.
    verifySigned(bodyBytes, header) {
      const parsed = parseSignatureHeader(header);
      if (!parsed) return false;
      return ctx.keys.verify(bodyBytes, parsed.sig, { kid: parsed.kid, purpose: 'license', encoding: 'base64url' });
    },

    // Failed key lookups beyond N/h per IP → 24 h block (§16.10).
    lookupGuard: {
      assertNotBlocked(ip) {
        const row = stmts.blocked.get(ip);
        if (row && row.until > now()) {
          throw Object.assign(new HttpError(429, 'blocked', 'Too many failed license lookups from this address'), { retryAfterS: Math.ceil((row.until - now()) / 1000) });
        }
        if (row) stmts.unblock.run(ip);
      },
      recordFailure(ip) {
        const t = now();
        stmts.insertFailure.run(ip, t);
        const n = stmts.countFailures.get(ip, t - cfg.lookup_block.windowMs).n;
        if (n >= cfg.lookup_block.failures) {
          stmts.block.run({ ip, until: t + cfg.lookup_block.blockMs, reason: 'failed_key_lookups', now: nowIso(t) });
          ctx.audit.record({ principal: 'system', ip, action: 'ip.block', target: ip, args: { failures: n }, result: 'ok' });
          return true;
        }
        return false;
      },
      unblock: (ip) => stmts.unblock.run(ip).changes > 0,
      prune: () => stmts.pruneFailures.run(now() - cfg.lookup_block.windowMs).changes,
    },

    // Scheduler jobs.
    expireDue() {
      const t = now();
      let n = 0;
      for (const row of stmts.expireDue.all()) {
        if (new Date(row.expires_at).getTime() + row.grace_days * DAY_MS > t) continue;
        stmts.setStatus.run({ id: row.id, status: 'expired', notes: null, now: nowIso(t) });
        const lic = svc.get(row.id);
        emit('license.expired', lic);
        const c = stmts.customerEmail.get(lic.customer_id);
        if (c) ctx.mailer.send({ to: c.email, template: 'license.expired', data: { edition: lic.edition, key_prefix: lic.key_prefix, expires_at: lic.expires_at } });
        n++;
      }
      return { expired: n };
    },
    expiringReminders(days = [30, 14, 7, 1]) {
      const t = now();
      let n = 0;
      for (const d of days) {
        const rows = stmts.expiring.all({ from: nowIso(t + (d - 1) * DAY_MS), to: nowIso(t + d * DAY_MS) });
        for (const row of rows) {
          const lic = shape(row);
          emit('license.expiring', lic, { days_left: d });
          const c = stmts.customerEmail.get(lic.customer_id);
          if (c) ctx.mailer.send({ to: c.email, template: 'license.expiring', data: { edition: lic.edition, key_prefix: lic.key_prefix, expires_at: lic.expires_at, days_left: d, portal_url: cfg.vendor.portal_url || ctx.config.public_url } });
          n++;
        }
      }
      return { reminders: n };
    },
    // Public support lookup: no PII, prefix only.
    statusByPrefix(prefix) {
      const rows = svc.findByPrefix(prefix);
      return { prefix: String(prefix).toUpperCase(), matches: rows.map((l) => ({ edition: l.edition, status: statusAt(l), expires_at: l.expires_at, max_activations: l.max_activations })) };
    },
    assertVisible(id, principal) {
      const row = stmts.byId.get(id);
      if (!row) throw notFound('License');
      if (principal?.ownerType === 'reseller' && row.reseller_id !== principal.ownerId) throw forbidden('That license belongs to another reseller', 'not_owned');
      return shape(row);
    },
  };
  return svc;
}
