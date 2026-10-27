import { HttpError, notFound } from '../../shared/errors.js';
import { json, newId, paginate, nowIso } from '../../shared/db.js';
import { drift as driftScore, DRIFT_THRESHOLD } from '../../shared/fingerprint.js';

const DAY_MS = 86_400_000;

export function createActivationsService(ctx) {
  const db = ctx.dbs.license;
  const cfg = ctx.config.license;
  const now = () => ctx.clock.now();
  const stmts = {
    byId: db.prepare('SELECT * FROM activations WHERE id = ?'),
    ofLicense: db.prepare('SELECT * FROM activations WHERE license_id = ? ORDER BY first_seen'),
    activeOfLicense: db.prepare("SELECT * FROM activations WHERE license_id = ? AND status = 'active' ORDER BY first_seen"),
    recentOfLicense: db.prepare('SELECT COUNT(*) AS n FROM activations WHERE license_id = ? AND first_seen >= ?'),
    insert: db.prepare(`INSERT INTO activations (id, license_id, fingerprint, fp_components_json, hostname, public_ip, panel_version, os, first_seen, last_checkin, token_kid, status)
      VALUES (@id, @license_id, @fingerprint, @fp_components_json, @hostname, @public_ip, @panel_version, @os, @first_seen, @first_seen, @token_kid, 'active')`),
    touch: db.prepare('UPDATE activations SET hostname = @hostname, public_ip = @public_ip, panel_version = COALESCE(@panel_version, panel_version), os = COALESCE(@os, os), last_checkin = @now, token_kid = @token_kid, checkin_failed_at = NULL WHERE id = @id'),
    updateFp: db.prepare('UPDATE activations SET fingerprint = @fingerprint, fp_components_json = @fp_components_json, drift_events = drift_events + 1 WHERE id = @id'),
    setStatus: db.prepare('UPDATE activations SET status = @status, deactivated_at = @now, deactivated_by = @by WHERE id = @id'),
    insertCheckin: db.prepare(`INSERT INTO checkins (activation_id, license_id, ts, panel_version, accounts_used, resellers_used, domains_used, usage_json, ip, result, latency_ms)
      VALUES (@activation_id, @license_id, @ts, @panel_version, @accounts_used, @resellers_used, @domains_used, @usage_json, @ip, @result, @latency_ms)`),
    checkins: db.prepare('SELECT * FROM checkins WHERE license_id = ? ORDER BY id DESC LIMIT ?'),
    pruneCheckins: db.prepare('DELETE FROM checkins WHERE ts < ?'),
    stale: db.prepare("SELECT a.*, l.key_prefix, l.edition FROM activations a JOIN licenses l ON l.id = a.license_id WHERE a.status = 'active' AND a.last_checkin < ? ORDER BY a.last_checkin"),
    missed: db.prepare("SELECT a.*, l.key_prefix, l.edition FROM activations a JOIN licenses l ON l.id = a.license_id WHERE a.status = 'active' AND a.last_checkin < ? AND a.checkin_failed_at IS NULL ORDER BY a.last_checkin"),
    markMissed: db.prepare('UPDATE activations SET checkin_failed_at = ? WHERE id = ? AND checkin_failed_at IS NULL'),
    insertMessage: db.prepare('INSERT INTO messages (license_id, level, code, text, data_json, created_at, expires_at) VALUES (@license_id, @level, @code, @text, @data_json, @created_at, @expires_at)'),
    pendingMessages: db.prepare(`SELECT m.* FROM messages m WHERE (m.license_id IS NULL OR m.license_id = @license_id) AND (m.expires_at IS NULL OR m.expires_at > @now)
      AND NOT EXISTS (SELECT 1 FROM message_deliveries d WHERE d.message_id = m.id AND d.activation_id = @activation_id) ORDER BY m.id`),
    markDelivered: db.prepare('INSERT OR IGNORE INTO message_deliveries (message_id, activation_id, delivered_at) VALUES (?, ?, ?)'),
    insertTransfer: db.prepare('INSERT INTO transfers (id, license_id, from_activation_id, to_activation_id, requested_at, completed_at, requested_by) VALUES (@id, @license_id, @from, @to, @at, @at, @by)'),
    countRecentCheckins: db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE activation_id = ? AND ts >= ?'),
    convertedFrom: db.prepare('SELECT 1 FROM trials WHERE license_id = ? AND converted_license_id = ?'),
  };

  function shape(row) {
    if (!row) return null;
    return { ...row, fp_components: json.parse(row.fp_components_json, {}) };
  }

  function publicList(licenseId) {
    return stmts.activeOfLicense.all(licenseId).map((a) => ({ id: a.id, hostname: a.hostname, last_checkin: a.last_checkin }));
  }

  function limitError(license) {
    const list = publicList(license.id);
    return Object.assign(new HttpError(409, 'activation_limit', `${list.length} of ${license.max_activations} activations in use`), { extra: { activations: list } });
  }

  function assertLicenseUsable(license) {
    const status = ctx.licenses.statusAt(license);
    if (status === 'revoked') throw new HttpError(403, 'revoked', 'License revoked');
    if (status === 'suspended') throw new HttpError(403, 'suspended', 'License is suspended');
    if (status === 'expired') throw new HttpError(403, 'expired', 'License has expired');
    if (status === 'pending') throw new HttpError(403, 'not_started', `License starts on ${license.starts_at}`);
    return status;
  }

  function assertReactivationAllowed(license) {
    if (license.reactivation_override_until && new Date(license.reactivation_override_until).getTime() > now()) return;
    const n = stmts.recentOfLicense.get(license.id, nowIso(now() - cfg.reactivation_limit.days * DAY_MS)).n;
    if (n >= cfg.reactivation_limit.count) {
      throw new HttpError(429, 'reactivation_limit', `This license was activated ${n} times in the last ${cfg.reactivation_limit.days} days; contact your vendor to lift the limit`);
    }
  }

  function createActivation(license, input, kid) {
    const id = newId('act', now());
    stmts.insert.run({
      id, license_id: license.id, fingerprint: input.fingerprint, fp_components_json: JSON.stringify(input.fp_components),
      hostname: input.hostname || null, public_ip: input.ip || null, panel_version: input.panel_version || null, os: input.os || null, first_seen: nowIso(now()), token_kid: kid,
    });
    return stmts.byId.get(id);
  }

  function pullMessages(activation, license) {
    const rows = stmts.pendingMessages.all({ license_id: license.id, activation_id: activation.id, now: nowIso(now()) });
    const at = nowIso(now());
    return rows.map((m) => {
      stmts.markDelivered.run(m.id, activation.id, at);
      return { level: m.level, code: m.code, text: m.text, ...(json.parse(m.data_json, null) ? { data: json.parse(m.data_json, null) } : {}) };
    });
  }

  function daysLeft(license) {
    return license.expires_at ? Math.max(0, Math.ceil((new Date(license.expires_at).getTime() - now()) / DAY_MS)) : null;
  }

  function finish(license, activation, { status, messages = [], extra = {} }) {
    const { token, payload } = ctx.licenses.issueToken({ license, activation, status });
    stmts.touch.run({ id: activation.id, hostname: activation.hostname, public_ip: activation.public_ip, panel_version: null, os: null, now: nowIso(now()), token_kid: payload.kid });
    return { token, activation_id: activation.id, checkin_interval_hours: cfg.checkin_interval_hours, messages, status, ...extra };
  }

  const svc = {
    shape,
    get(id) {
      const row = shape(stmts.byId.get(id));
      if (!row) throw notFound('Activation');
      return row;
    },
    find: (id) => shape(stmts.byId.get(id)),
    listForLicense: (licenseId) => stmts.ofLicense.all(licenseId).map((a) => ({ ...shape(a), fp_components_json: undefined })),
    publicList,
    list(query = {}) {
      const where = [];
      const params = {};
      if (query.stale_days) { where.push("a.status = 'active' AND a.last_checkin < @stale"); params.stale = nowIso(now() - query.stale_days * DAY_MS); }
      if (query.license_id) { where.push('a.license_id = @license'); params.license = query.license_id; }
      if (query.status) { where.push('a.status = @status'); params.status = query.status; }
      if (query.q) { where.push('(a.hostname LIKE @q OR a.public_ip LIKE @q OR l.key_prefix LIKE @q)'); params.q = `%${query.q}%`; }
      return paginate(db, { select: 'a.id, a.license_id, a.hostname, a.public_ip, a.panel_version, a.os, a.first_seen, a.last_checkin, a.status, a.drift_events, l.key_prefix, l.edition', from: 'activations a JOIN licenses l ON l.id = a.license_id', where, params, sortable: { last_checkin: 'a.last_checkin', first_seen: 'a.first_seen', hostname: 'a.hostname' }, defaultSort: 'last_checkin', query: { dir: 'desc', ...query } });
    },
    checkins: (licenseId, limit = 100) => stmts.checkins.all(licenseId, limit).map((c) => ({ ...c, usage: json.parse(c.usage_json, null), usage_json: undefined })),

    // §16.5 rule: drift 0 = same server; ≤ 0.5 = same activation with
    // replaced parts; > 0.5 = a different server.
    matchFingerprint(aid, fingerprint, components) {
      const a = svc.get(aid);
      if (a.fingerprint === fingerprint) return { ok: true, drift: 0 };
      const d = driftScore(a.fp_components, components);
      return { ok: d <= DRIFT_THRESHOLD, drift: d };
    },

    activate(input) {
      ctx.licenses.lookupGuard.assertNotBlocked(input.ip);
      const license = ctx.licenses.findByKey(input.key);
      if (!license) {
        ctx.licenses.lookupGuard.recordFailure(input.ip);
        throw new HttpError(404, 'invalid_key', 'Unknown license key');
      }
      const status = assertLicenseUsable(license);
      const kid = ctx.keys.active('license')?.kid || null;
      const messages = [];
      const run = db.transaction(() => {
        const active = stmts.activeOfLicense.all(license.id).map(shape);
        let activation = active.find((a) => a.fingerprint === input.fingerprint);
        let drifted = null;
        if (!activation) {
          const scored = active.map((a) => ({ a, d: driftScore(a.fp_components, input.fp_components) })).filter((x) => x.d <= DRIFT_THRESHOLD).sort((x, y) => x.d - y.d)[0];
          if (scored) { activation = scored.a; drifted = scored.d; }
        }
        if (activation) {
          if (drifted != null && drifted > 0) {
            stmts.updateFp.run({ id: activation.id, fingerprint: input.fingerprint, fp_components_json: JSON.stringify(input.fp_components) });
            messages.push({ level: 'info', code: 'fingerprint_updated', text: `Server fingerprint updated (drift ${drifted})` });
            ctx.audit.record({ principal: `activation:${activation.id}`, ip: input.ip, action: 'activation.fingerprint_updated', target: activation.id, args: { drift: drifted }, result: 'ok' });
          }
          stmts.touch.run({ id: activation.id, hostname: input.hostname || activation.hostname, public_ip: input.ip || null, panel_version: input.panel_version || null, os: input.os || null, now: nowIso(now()), token_kid: kid });
          return { activation: shape(stmts.byId.get(activation.id)), reused: true };
        }
        assertReactivationAllowed(license);
        if (active.length >= license.max_activations) {
          const stale = active.filter((a) => a.last_checkin && new Date(a.last_checkin).getTime() < now() - cfg.reclaim_days * DAY_MS).sort((x, y) => String(x.last_checkin).localeCompare(String(y.last_checkin)))[0];
          if (!stale) throw limitError(license);
          stmts.setStatus.run({ id: stale.id, status: 'reclaimed', now: nowIso(now()), by: 'auto-reclaim' });
          const created = createActivation(license, input, kid);
          ctx.audit.record({ principal: `activation:${created.id}`, ip: input.ip, action: 'activation.reclaim', target: stale.id, args: { stale_since: stale.last_checkin, hostname: input.hostname }, result: 'ok' });
          ctx.licenses.emit('license.transferred', license, { from_activation_id: stale.id, to_activation_id: created.id, reason: 'reclaimed' });
          messages.push({ level: 'info', code: 'activation_reclaimed', text: `Replaced stale activation ${stale.hostname || stale.id} (no check-in since ${stale.last_checkin})` });
          return { activation: shape(created), reclaimed: stale.id };
        }
        return { activation: shape(createActivation(license, input, kid)), created: true };
      });
      const { activation, reused } = run();
      if (!reused) {
        ctx.audit.record({ principal: `activation:${activation.id}`, ip: input.ip, action: 'license.activate', target: license.id, args: { hostname: input.hostname, panel_version: input.panel_version }, result: 'ok' });
        ctx.licenses.emit('license.activated', license, { activation_id: activation.id, hostname: input.hostname });
      }
      return finish(license, activation, { status, messages: [...messages, ...pullMessages(activation, license)] });
    },

    checkin(input) {
      const t0 = now();
      const verified = ctx.licenses.verifyToken(input.token);
      if (!verified.ok && verified.reason !== 'expired') throw new HttpError(401, 'invalid_token', `Token rejected: ${verified.reason}`);
      const payload = verified.payload;
      const activation = svc.find(payload.aid);
      if (!activation) throw new HttpError(401, 'invalid_token', 'Token does not match an activation');
      // A converted trial re-parents its activation; the panel still holds the trial token.
      if (activation.license_id !== payload.lid && !stmts.convertedFrom.get(payload.lid, activation.license_id)) throw new HttpError(401, 'invalid_token', 'Token does not match an activation');
      const license = ctx.licenses.get(activation.license_id);
      // The per-activation limit counts only check-ins that carried a valid
      // token, so a stranger who knows the activation id cannot exhaust it.
      const rl = cfg.rate_limits.checkin;
      if (stmts.countRecentCheckins.get(activation.id, nowIso(now() - rl.windowMs)).n >= rl.max) {
        throw Object.assign(new HttpError(429, 'rate_limited', 'Check-in limit reached for this activation'), { retryAfterS: Math.ceil(rl.windowMs / 1000) });
      }
      const record = (result, extra = {}) => stmts.insertCheckin.run({
        activation_id: activation.id, license_id: license.id, ts: nowIso(now()), panel_version: input.panel_version || null,
        accounts_used: input.usage?.accounts ?? null, resellers_used: input.usage?.resellers ?? null, domains_used: input.usage?.domains ?? null,
        usage_json: input.usage ? JSON.stringify({ ...input.usage, plugins: (input.usage.plugins || []).map((p) => ({ id: p.id, version: p.version, state: p.state })) }) : null,
        ip: input.ip || null, result, latency_ms: now() - t0, ...extra,
      });
      ctx.metrics?.inc('checkins_total', { result: 'received' });
      if (license.status === 'revoked') {
        record('revoked');
        ctx.metrics?.inc('checkins_total', { result: 'revoked' });
        const rev = db.prepare('SELECT ts, reason FROM revocations WHERE license_id = ? ORDER BY ts DESC LIMIT 1').get(license.id);
        throw Object.assign(new HttpError(403, 'revoked', `License revoked${rev?.reason ? `: ${rev.reason}` : ''}`), { extra: { revoked_at: rev?.ts || null } });
      }
      if (activation.status !== 'active') {
        record('deactivated');
        throw new HttpError(403, 'deactivated', `This activation was ${activation.status}`);
      }
      const messages = [];
      if (activation.fingerprint !== input.fingerprint) {
        const d = driftScore(activation.fp_components, input.fp_components);
        if (d > DRIFT_THRESHOLD) {
          record('fingerprint_mismatch');
          ctx.audit.record({ principal: `activation:${activation.id}`, ip: input.ip, action: 'activation.fingerprint_mismatch', target: activation.id, args: { drift: d }, result: 'error' });
          throw Object.assign(new HttpError(409, 'fingerprint_mismatch', 'This server does not match the activation; transfer the license or activate again'), { extra: { activations: publicList(license.id), drift: d } });
        }
        stmts.updateFp.run({ id: activation.id, fingerprint: input.fingerprint, fp_components_json: JSON.stringify(input.fp_components) });
        activation.fingerprint = input.fingerprint;
        activation.fp_components = input.fp_components;
        messages.push({ level: 'info', code: 'fingerprint_updated', text: `Server fingerprint updated (drift ${d})` });
        ctx.audit.record({ principal: `activation:${activation.id}`, ip: input.ip, action: 'activation.fingerprint_updated', target: activation.id, args: { drift: d }, result: 'ok' });
      }
      const status = ctx.licenses.statusAt(license);
      const kid = ctx.keys.active('license')?.kid;
      let result = status === 'active' ? (activation.token_kid && activation.token_kid !== kid ? 'rotated' : 'ok') : status;
      const lim = license.limits || {};
      if (input.usage && status === 'active') {
        const over = [];
        if (lim.max_accounts !== -1 && Number.isInteger(input.usage.accounts) && input.usage.accounts > lim.max_accounts) over.push(`accounts ${input.usage.accounts}/${lim.max_accounts}`);
        if (lim.max_resellers !== -1 && Number.isInteger(input.usage.resellers) && input.usage.resellers > lim.max_resellers) over.push(`resellers ${input.usage.resellers}/${lim.max_resellers}`);
        if (over.length) { result = 'over_limit'; messages.push({ level: 'warning', code: 'over_limit', text: `Usage exceeds the license limits: ${over.join(', ')}` }); }
      }
      if (status === 'grace') messages.push({ level: 'warning', code: 'grace', text: `License expired on ${license.expires_at}; ${license.grace_days}-day grace period running` });
      if (status === 'expired') messages.push({ level: 'critical', code: 'expired', text: 'License has expired; the panel is read-only until it is renewed' });
      if (status === 'suspended') messages.push({ level: 'critical', code: 'suspended', text: 'License is suspended' });
      if (status === 'active' && daysLeft(license) != null && daysLeft(license) <= 30) messages.push({ level: 'info', code: 'renewal_available', text: `Renew before ${license.expires_at}` });
      record(result);
      ctx.metrics?.inc('checkins_total', { result });
      stmts.touch.run({ id: activation.id, hostname: input.hostname || activation.hostname, public_ip: input.ip || null, panel_version: input.panel_version || null, os: input.os || null, now: nowIso(now()), token_kid: kid });
      for (const fn of ctx.hooks.checkin) {
        try { fn({ activation: { ...activation, status: 'active' }, license, usage: input.usage || {} }); } catch (err) { ctx.logger.error({ err }, 'checkin hook failed'); }
      }
      const out = finish(license, activation, {
        status, messages: [...messages, ...pullMessages(activation, license)],
        extra: { revoked: false, license: { edition: license.edition, expires_at: license.expires_at, days_left: daysLeft(license) } },
      });
      return out;
    },

    deactivateByToken({ token, reason, ip }) {
      const verified = ctx.licenses.verifyToken(token);
      if (!verified.ok && verified.reason !== 'expired') throw new HttpError(401, 'invalid_token', `Token rejected: ${verified.reason}`);
      const activation = svc.find(verified.payload.aid);
      if (!activation) throw notFound('Activation');
      return svc.deactivate(activation.id, { reason, by: `activation:${activation.id}`, ip });
    },
    deactivate(id, { reason, by = 'admin', ip = null, status = 'deactivated' } = {}) {
      const a = svc.get(id);
      if (a.status !== 'active') return { deactivated: false, status: a.status };
      stmts.setStatus.run({ id, status, now: nowIso(now()), by });
      ctx.audit.record({ principal: by, ip, action: `activation.${status === 'blocked' ? 'block' : status === 'reclaimed' ? 'reclaim' : 'deactivate'}`, target: id, args: { reason }, result: 'ok' });
      return { deactivated: true, status };
    },
    block: (id, opts = {}) => svc.deactivate(id, { ...opts, status: 'blocked' }),
    reclaim: (id, opts = {}) => svc.deactivate(id, { ...opts, status: 'reclaimed' }),

    // Atomic deactivate-old + activate-new; the old server learns at its next check-in.
    transfer(input) {
      ctx.licenses.lookupGuard.assertNotBlocked(input.ip);
      const license = ctx.licenses.findByKey(input.key);
      if (!license) { ctx.licenses.lookupGuard.recordFailure(input.ip); throw new HttpError(404, 'invalid_key', 'Unknown license key'); }
      const status = assertLicenseUsable(license);
      const from = svc.find(input.from_activation);
      if (!from || from.license_id !== license.id) throw notFound('Activation');
      if (from.status !== 'active') throw new HttpError(409, 'activation_inactive', `Activation is ${from.status}`);
      const kid = ctx.keys.active('license')?.kid || null;
      const created = db.transaction(() => {
        assertReactivationAllowed(license);
        stmts.setStatus.run({ id: from.id, status: 'transferred', now: nowIso(now()), by: 'transfer' });
        const a = createActivation(license, input, kid);
        stmts.insertTransfer.run({ id: newId('trf', now()), license_id: license.id, from: from.id, to: a.id, at: nowIso(now()), by: input.requested_by || `activation:${a.id}` });
        return shape(a);
      })();
      ctx.audit.record({ principal: `activation:${created.id}`, ip: input.ip, action: 'license.transfer', target: license.id, args: { from: from.id, to: created.id, hostname: input.hostname }, result: 'ok' });
      ctx.licenses.emit('license.transferred', license, { from_activation_id: from.id, to_activation_id: created.id, reason: 'transfer' });
      const out = finish(license, created, { status, messages: pullMessages(created, license) });
      return { ...out, transferred_from: from.id };
    },

    // Queued into the next check-in of the targeted panels (U2 kill-switch).
    pushMessage({ licenseId = null, all = false } = {}, { level = 'info', code, text, data = null, ttlDays = 30 }) {
      if (!all && !licenseId) throw new HttpError(422, 'validation_failed', 'pushMessage needs licenseId or all: true');
      if (!['info', 'warning', 'critical'].includes(level)) throw new HttpError(422, 'validation_failed', 'level must be info|warning|critical');
      const res = stmts.insertMessage.run({ license_id: all ? null : licenseId, level, code: String(code), text: String(text), data_json: data == null ? null : JSON.stringify(data), created_at: nowIso(now()), expires_at: ttlDays ? nowIso(now() + ttlDays * DAY_MS) : null });
      return { id: Number(res.lastInsertRowid) };
    },
    stale: (days = cfg.reclaim_days) => stmts.stale.all(nowIso(now() - days * DAY_MS)).map((a) => ({ id: a.id, license_id: a.license_id, key_prefix: a.key_prefix, edition: a.edition, hostname: a.hostname, last_checkin: a.last_checkin })),
    pruneCheckins: (days = cfg.checkin_retention_days) => ({ pruned: stmts.pruneCheckins.run(nowIso(now() - days * DAY_MS)).changes }),
    // Three consecutive missed check-ins alert the vendor once per episode
    // (§16.7 license.checkin_failed): checkin_failed_at marks the alert and a
    // successful check-in clears it, re-arming the activation.
    flagMissedCheckins() {
      const threshold = nowIso(now() - 3 * cfg.checkin_interval_hours * 3600_000);
      let n = 0;
      for (const a of stmts.missed.all(threshold)) {
        const lic = ctx.licenses.getRaw(a.license_id);
        if (!lic) continue;
        if (stmts.markMissed.run(nowIso(now()), a.id).changes === 0) continue;
        ctx.licenses.emit('license.checkin_failed', ctx.licenses.shape(lic), { activation_id: a.id, hostname: a.hostname, last_checkin: a.last_checkin });
        ctx.audit.record({ principal: 'system', ip: null, action: 'activation.checkin_failed', target: a.id, args: { license_id: a.license_id, last_checkin: a.last_checkin }, result: 'ok' });
        n++;
      }
      return { flagged: n };
    },
    recentCheckinCount: (aid, windowMs) => stmts.countRecentCheckins.get(aid, nowIso(now() - windowMs)).n,
  };

  return svc;
}
