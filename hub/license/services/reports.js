import { HttpError } from '../../shared/errors.js';
import { nowIso } from '../../shared/db.js';

const DAY_MS = 86_400_000;

export function createReportsService(ctx) {
  const db = ctx.dbs.license;
  const now = () => ctx.clock.now();
  const q = {
    activationsByEdition: db.prepare("SELECT l.edition, COUNT(*) AS active FROM activations a JOIN licenses l ON l.id = a.license_id WHERE a.status = 'active' GROUP BY l.edition"),
    activationsOverTime: db.prepare("SELECT substr(first_seen, 1, 10) AS day, COUNT(*) AS created FROM activations WHERE first_seen >= ? GROUP BY day ORDER BY day"),
    checkinsPerHour: db.prepare("SELECT substr(ts, 1, 13) AS hour, COUNT(*) AS n, SUM(CASE WHEN result NOT IN ('ok', 'rotated') THEN 1 ELSE 0 END) AS failed FROM checkins WHERE ts >= ? GROUP BY hour ORDER BY hour"),
    renewalsDue: db.prepare("SELECT substr(expires_at, 1, 7) AS month, COUNT(*) AS due FROM licenses WHERE status = 'active' AND expires_at BETWEEN ? AND ? GROUP BY month"),
    renewed: db.prepare("SELECT substr(ts, 1, 7) AS month, COUNT(*) AS completed FROM audit_log WHERE action = 'license.renew' AND ts >= ? GROUP BY month"),
    lapsed: db.prepare("SELECT substr(expires_at, 1, 7) AS month, COUNT(*) AS lapsed FROM licenses WHERE status = 'expired' AND expires_at >= ? GROUP BY month"),
    churn: db.prepare(`SELECT edition, reseller_id, COUNT(*) AS expired_not_renewed FROM licenses WHERE status = 'expired' AND expires_at <= ? AND term != 'days' GROUP BY edition, reseller_id`),
    resellers: db.prepare('SELECT id, name, quota_json, issued_json FROM resellers ORDER BY name'),
    versions: db.prepare("SELECT COALESCE(panel_version, 'unknown') AS panel_version, COUNT(*) AS n FROM activations WHERE status = 'active' GROUP BY panel_version ORDER BY n DESC"),
    expiringSoon: db.prepare("SELECT COUNT(*) AS n FROM licenses WHERE status = 'active' AND expires_at BETWEEN ? AND ?"),
    webhookFailures: db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status IN ('failed', 'retrying')"),
    failedCheckins: db.prepare("SELECT COUNT(*) AS n FROM checkins WHERE ts >= ? AND result NOT IN ('ok', 'rotated')"),
  };
  const EXPORTS = {
    licenses: 'SELECT id, key_prefix, edition, status, issued_at, starts_at, expires_at, grace_days, max_activations, customer_id, reseller_id, external_ref FROM licenses ORDER BY issued_at',
    activations: 'SELECT id, license_id, hostname, public_ip, panel_version, os, first_seen, last_checkin, status, drift_events FROM activations ORDER BY first_seen',
    customers: 'SELECT id, reseller_id, name, email, company, country, external_ref, status, created_at FROM customers ORDER BY created_at',
  };

  function csv(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
  }

  return {
    dashboard() {
      const t = now();
      return {
        activations_by_edition: q.activationsByEdition.all(),
        checkins_last_24h: q.checkinsPerHour.all(nowIso(t - DAY_MS)),
        expiring_30d: q.expiringSoon.get(nowIso(t), nowIso(t + 30 * DAY_MS)).n,
        failed_checkins_24h: q.failedCheckins.get(nowIso(t - DAY_MS)).n,
        webhook_failures: q.webhookFailures.get().n,
        trial_funnel: ctx.trials.funnel(),
      };
    },
    activations: ({ days = 90 } = {}) => ({ by_edition: q.activationsByEdition.all(), over_time: q.activationsOverTime.all(nowIso(now() - days * DAY_MS)), panel_versions: q.versions.all() }),
    renewals: ({ months = 12 } = {}) => {
      const t = now();
      return { due: q.renewalsDue.all(nowIso(t), nowIso(t + months * 30 * DAY_MS)), completed: q.renewed.all(nowIso(t - months * 30 * DAY_MS)), lapsed: q.lapsed.all(nowIso(t - months * 30 * DAY_MS)) };
    },
    churn: () => ({ rows: q.churn.all(nowIso(now() - 30 * DAY_MS)) }),
    resellers: () => q.resellers.all().map((r) => ({ id: r.id, name: r.name, quota: JSON.parse(r.quota_json || '{}'), issued: JSON.parse(r.issued_json || '{}'), quota_left: ctx.resellers.quotaLeft(r.id) })),
    versions: () => q.versions.all(),
    exportCsv(table) {
      const sql = EXPORTS[table];
      if (!sql) throw new HttpError(422, 'validation_failed', 'table must be licenses|activations|customers');
      return csv(db.prepare(sql).all());
    },
    csv,
  };
}
