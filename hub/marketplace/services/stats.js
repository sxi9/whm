import { HttpError } from '../../shared/errors.js';
import { paginate } from '../../shared/db.js';

const DAY_MS = 86_400_000;

// Developer plugin stats and the vendor dashboard numbers (§18.7, §18.9 metrics).
export function createStatsService(m) {
  const { ctx, db } = m;
  const day = (iso) => String(iso).slice(0, 10);

  return {
    pluginStats(developer, pluginId, { from, to } = {}) {
      const plugin = m.submissions.owned(developer, pluginId);
      const fromIso = from || m.nowIso(m.now() - 30 * DAY_MS);
      const toIso = to || m.nowIso();
      if (new Date(fromIso).getTime() > new Date(toIso).getTime()) throw new HttpError(422, 'validation_failed', 'from must be before to');
      const downloads = db.prepare("SELECT substr(ts, 1, 10) AS day, COUNT(*) AS n FROM downloads d JOIN plugin_versions v ON v.id = d.version_id WHERE v.plugin_id = ? AND d.fetched_at IS NOT NULL AND d.ts >= ? AND d.ts <= ? GROUP BY day ORDER BY day").all(pluginId, fromIso, toIso);
      const installs = db.prepare('SELECT state, COUNT(*) AS n FROM installs WHERE plugin_id = ? AND last_seen >= ? GROUP BY state').all(pluginId, m.nowIso(m.now() - 30 * DAY_MS));
      const revenue = db.prepare("SELECT substr(paid_at, 1, 10) AS day, SUM(developer_cents) AS developer_cents, SUM(amount_cents) AS amount_cents, COUNT(*) AS n FROM purchases WHERE plugin_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at <= ? GROUP BY day ORDER BY day").all(pluginId, fromIso, toIso);
      const ratings = db.prepare("SELECT rating, COUNT(*) AS n FROM plugin_reviews WHERE plugin_id = ? AND status = 'published' GROUP BY rating").all(pluginId);
      return { plugin_id: pluginId, from: fromIso, to: toIso, install_count: plugin.install_count, installs_by_state: Object.fromEntries(installs.map((i) => [i.state, i.n])), downloads, revenue, rating_avg: plugin.rating_avg, rating_count: plugin.rating_count, ratings: Object.fromEntries(ratings.map((r) => [r.rating, r.n])) };
    },
    adminStats() {
      const since7 = m.nowIso(m.now() - 7 * DAY_MS);
      const since30 = m.nowIso(m.now() - 30 * DAY_MS);
      return {
        verification_queue: db.prepare("SELECT COUNT(*) AS n FROM developers WHERE status = 'pending' AND email_verified_at IS NOT NULL").get().n,
        review_queue: Object.fromEntries(db.prepare("SELECT v.risk, COUNT(*) AS n FROM reviews r JOIN plugin_versions v ON v.id = r.version_id WHERE r.state = 'open' GROUP BY v.risk").all().map((r) => [r.risk, r.n])),
        downloads_per_day: db.prepare('SELECT substr(ts, 1, 10) AS day, COUNT(*) AS n FROM downloads WHERE fetched_at IS NOT NULL AND ts >= ? GROUP BY day ORDER BY day').all(since7),
        revenue_30d: db.prepare("SELECT currency, SUM(amount_cents) AS amount_cents, SUM(vendor_cents) AS vendor_cents, SUM(developer_cents) AS developer_cents, COUNT(*) AS purchases FROM purchases WHERE status = 'paid' AND paid_at >= ? GROUP BY currency").all(since30),
        revocations: db.prepare('SELECT COUNT(*) AS n FROM revocations').get().n,
        revocations_pending: m.revocations.pending(),
        developers: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM developers GROUP BY status').all().map((r) => [r.status, r.n])),
        plugins: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM plugins GROUP BY status').all().map((r) => [r.status, r.n])),
        scan_queue_age_s: m.scanner.queueAge(),
        review_queue_age_s: m.review.queueAge(),
        resign: m.signing.resignStatus(),
        payouts_pending: db.prepare("SELECT COUNT(*) AS n FROM payouts WHERE status IN ('pending', 'approved')").get().n,
      };
    },
    auditList(query = {}) {
      const where = []; const params = {};
      if (query.action) { where.push('action LIKE @action'); params.action = `${query.action}%`; }
      if (query.target) { where.push('target = @target'); params.target = query.target; }
      if (query.q) { where.push('(principal LIKE @q OR target LIKE @q OR action LIKE @q)'); params.q = `%${query.q}%`; }
      return paginate(db, { from: 'audit_log', where, params, sortable: { ts: 'ts', id: 'id' }, defaultSort: 'id', query: { dir: 'desc', ...query } });
    },
    gauges() {
      return [
        ['scan_queue_age_seconds', m.scanner.queueAge()],
        ['review_queue_age_seconds', m.review.queueAge()],
        ['revocations_pending', m.revocations.pending()],
        ['signed_downloads_total', db.prepare('SELECT COUNT(*) AS n FROM downloads WHERE fetched_at IS NOT NULL').get().n],
        ['resign_backlog', m.signing.resignStatus().backlog],
      ];
    },
  };
}
