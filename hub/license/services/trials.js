import crypto from 'node:crypto';
import { HttpError, notFound } from '../../shared/errors.js';
import { newId, paginate, nowIso } from '../../shared/db.js';

export const TRIAL_SKU = 'whm-trial';

export function createTrialsService(ctx) {
  const db = ctx.dbs.license;
  const now = () => ctx.clock.now();
  const stmts = {
    byId: db.prepare('SELECT * FROM trials WHERE id = ?'),
    byFingerprint: db.prepare('SELECT id FROM trials WHERE fingerprint = ? LIMIT 1'),
    byEmail: db.prepare('SELECT id FROM trials WHERE email_hash = ? LIMIT 1'),
    byLicense: db.prepare('SELECT * FROM trials WHERE license_id = ?'),
    insert: db.prepare('INSERT INTO trials (id, customer_id, license_id, fingerprint, email_hash, ip, started_at) VALUES (@id, @customer_id, @license_id, @fingerprint, @email_hash, @ip, @started_at)'),
    convert: db.prepare('UPDATE trials SET converted_license_id = @converted, converted_at = @at WHERE id = @id'),
    reparent: db.prepare('UPDATE activations SET license_id = @to WHERE license_id = @from'),
    expireTrial: db.prepare("UPDATE licenses SET status = 'expired', notes = @notes, updated_at = @now WHERE id = @id"),
    expiring: db.prepare("SELECT t.*, l.expires_at, l.status FROM trials t JOIN licenses l ON l.id = t.license_id WHERE t.converted_at IS NULL AND l.status = 'active' AND l.expires_at <= ?"),
    funnel: db.prepare(`SELECT COUNT(*) AS started, SUM(CASE WHEN converted_at IS NOT NULL THEN 1 ELSE 0 END) AS converted,
      SUM(CASE WHEN converted_at IS NULL AND l.status = 'expired' THEN 1 ELSE 0 END) AS expired FROM trials t JOIN licenses l ON l.id = t.license_id`),
    abuse: db.prepare(`SELECT ip, COUNT(*) AS n FROM trials WHERE ip IS NOT NULL GROUP BY ip HAVING n > 1 ORDER BY n DESC LIMIT 50`),
  };
  const emailHash = (email) => crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');

  const svc = {
    emailHash,
    get(id) {
      const row = stmts.byId.get(id);
      if (!row) throw notFound('Trial');
      return row;
    },
    forLicense: (licenseId) => stmts.byLicense.get(licenseId) || null,
    list(query = {}) {
      const where = [];
      const params = {};
      if (query.converted === true) where.push('t.converted_at IS NOT NULL');
      if (query.converted === false) where.push('t.converted_at IS NULL');
      return paginate(db, { select: 't.*, l.status AS license_status, l.expires_at, l.key_prefix', from: 'trials t JOIN licenses l ON l.id = t.license_id', where, params, sortable: { started_at: 't.started_at' }, defaultSort: 'started_at', query: { dir: 'desc', ...query } });
    },
    // One trial per fingerprint and per e-mail hash.
    start(input) {
      ctx.licenses.lookupGuard.assertNotBlocked(input.ip);
      const hash = emailHash(input.email);
      if (stmts.byFingerprint.get(input.fingerprint) || stmts.byEmail.get(hash)) {
        throw new HttpError(409, 'trial_exists', 'A trial was already used on this server or e-mail');
      }
      const { license, key } = ctx.licenses.issue({ sku: TRIAL_SKU, customer: { email: input.email, name: input.email }, notify: false }, { actor: { principal: 'system', ip: input.ip } });
      const id = newId('trl', now());
      stmts.insert.run({ id, customer_id: license.customer_id, license_id: license.id, fingerprint: input.fingerprint, email_hash: hash, ip: input.ip || null, started_at: nowIso(now()) });
      const activation = ctx.activations.activate({ ...input, key });
      ctx.licenses.emit('trial.started', license, { trial_id: id, activation_id: activation.activation_id });
      ctx.mailer.send({ to: input.email, template: 'trial.started', data: { key_prefix: license.key_prefix, expires_at: license.expires_at, portal_url: ctx.config.license.vendor.portal_url || ctx.config.public_url } });
      ctx.audit.record({ principal: `activation:${activation.activation_id}`, ip: input.ip, action: 'trial.start', target: id, args: { hostname: input.hostname }, result: 'ok' });
      return { trial_id: id, key, token: activation.token, expires_at: license.expires_at, activation_id: activation.activation_id, checkin_interval_hours: activation.checkin_interval_hours, messages: activation.messages };
    },
    // Conversion re-parents the activation: the panel receives the new
    // edition at its next check-in without re-entering a key.
    convert(id, { sku, term_months }, { actor = null } = {}) {
      const trial = svc.get(id);
      if (trial.converted_at) throw new HttpError(409, 'already_converted', 'This trial was already converted');
      const old = ctx.licenses.get(trial.license_id);
      const issued = ctx.licenses.issue({ sku, customer_id: old.customer_id, term_months, reseller_id: old.reseller_id }, { actor });
      db.transaction(() => {
        stmts.reparent.run({ from: old.id, to: issued.license.id });
        stmts.expireTrial.run({ id: old.id, notes: `converted to ${issued.license.id}`, now: nowIso(now()) });
        stmts.convert.run({ id, converted: issued.license.id, at: nowIso(now()) });
      })();
      ctx.audit.record({ principal: actor?.principal ?? 'system', ip: actor?.ip ?? null, action: 'trial.convert', target: id, args: { sku, license_id: issued.license.id }, result: 'ok' });
      ctx.licenses.emit('trial.converted', issued.license, { trial_id: id, from_license_id: old.id });
      ctx.activations.pushMessage({ licenseId: issued.license.id }, { level: 'info', code: 'trial_converted', text: `Trial converted to ${issued.license.edition}` });
      return { license_id: issued.license.id, key: issued.key };
    },
    expireDue() {
      let n = 0;
      for (const row of stmts.expiring.all(nowIso(now()))) {
        stmts.expireTrial.run({ id: row.license_id, notes: 'trial ended', now: nowIso(now()) });
        ctx.licenses.emit('license.expired', ctx.licenses.get(row.license_id), { trial_id: row.id });
        n++;
      }
      return { expired: n };
    },
    funnel: () => ({ ...stmts.funnel.get(), abuse: stmts.abuse.all() }),
  };
  return svc;
}
