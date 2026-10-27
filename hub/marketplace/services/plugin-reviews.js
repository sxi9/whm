import { HttpError, notFound } from '../../shared/errors.js';
import { newId, paginate } from '../../shared/db.js';

const DAY_MS = 86_400_000;

// Customer reviews from the panel (§18.4 "Usage & reviews"): one per customer
// per plugin, installs ≥ 7 days old and seen within 30 days, trial refused,
// rate limited, bursts flagged; pending until moderated; one developer reply.
export function createPluginReviewsService(m) {
  const { ctx, db } = m;
  const stmts = {
    insert: db.prepare('INSERT INTO plugin_reviews (id, plugin_id, customer_id, license_id, rating, title, body, status, flagged, ip_hash, created_at) VALUES (@id, @plugin_id, @customer_id, @license_id, @rating, @title, @body, \'pending\', @flagged, @ip_hash, @created_at)'),
    install: db.prepare('SELECT MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen FROM installs WHERE plugin_id = ? AND license_id = ?'),
    existing: db.prepare('SELECT id FROM plugin_reviews WHERE plugin_id = ? AND customer_id = ?'),
    byId: db.prepare('SELECT * FROM plugin_reviews WHERE id = ?'),
    moderate: db.prepare('UPDATE plugin_reviews SET status = ?, moderated_by = ? WHERE id = ?'),
    reply: db.prepare('UPDATE plugin_reviews SET developer_reply = ?, developer_replied_at = ? WHERE id = ? AND developer_reply IS NULL'),
    burst: db.prepare('SELECT COUNT(*) AS n FROM plugin_reviews WHERE plugin_id = ? AND (ip_hash = ? OR customer_id = ?) AND created_at >= ?'),
    published: db.prepare("SELECT id, rating, title, body, developer_reply, developer_replied_at, created_at FROM plugin_reviews WHERE plugin_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 50"),
  };

  const svc = {
    submit({ token }, pluginId, { rating, title, body }, { ip } = {}) {
      const { license } = m.distribution.resolvePanel({ token });
      if (license.edition === 'trial') throw new HttpError(403, 'trial_license', 'Trial licenses cannot post reviews');
      const plugin = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
      if (!plugin || !['listed', 'unlisted'].includes(plugin.status)) throw notFound('Plugin');
      const inst = stmts.install.get(pluginId, license.id);
      if (!inst?.first_seen) throw new HttpError(403, 'install_required', 'Only licenses that installed the plugin can review it');
      if (new Date(inst.first_seen).getTime() > m.now() - 7 * DAY_MS) throw new HttpError(403, 'install_too_recent', 'Reviews open seven days after installation');
      if (new Date(inst.last_seen).getTime() < m.now() - 30 * DAY_MS) throw new HttpError(403, 'install_stale', 'The plugin has not been seen on this license for 30 days');
      if (stmts.existing.get(pluginId, license.customer_id)) throw new HttpError(409, 'review_exists', 'This customer already reviewed the plugin');
      const ipHash = m.hashIp(ip);
      m.limits.assert(`review-customer:${license.customer_id}`, 5, DAY_MS, 'Review limit reached for this customer');
      m.limits.assert(`review-ip:${ipHash}`, 20, DAY_MS, 'Review limit reached for this address');
      const flagged = stmts.burst.get(pluginId, ipHash, license.customer_id, m.nowIso(m.now() - DAY_MS)).n >= 2 ? 1 : 0;
      const id = newId('prv', m.now());
      stmts.insert.run({ id, plugin_id: pluginId, customer_id: license.customer_id, license_id: license.id, rating, title: title || null, body: body || null, flagged, ip_hash: ipHash, created_at: m.nowIso() });
      m.audit({ principal: `customer:${license.customer_id}`, role: 'customer', ip, action: 'plugin_review.submit', target: pluginId, args: { rating, flagged: !!flagged }, result: 'ok' });
      return { id, status: 'pending', flagged: !!flagged };
    },
    moderate(id, action, { by, ip } = {}) {
      const r = stmts.byId.get(id);
      if (!r) throw notFound('Review');
      const status = action === 'publish' ? 'published' : 'hidden';
      stmts.moderate.run(status, by, id);
      m.catalog.refreshRating(r.plugin_id);
      m.audit({ principal: by, role: 'vendor', ip, action: `plugin_review.${action}`, target: id, args: { plugin_id: r.plugin_id }, result: 'ok' });
      return stmts.byId.get(id);
    },
    reply(developer, id, text, { ip } = {}) {
      const r = stmts.byId.get(id);
      if (!r) throw notFound('Review');
      m.submissions.owned(developer, r.plugin_id);
      if (!stmts.reply.run(text, m.nowIso(), id).changes) throw new HttpError(409, 'already_replied', 'Developers reply once per review');
      m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'plugin_review.reply', target: id, args: null, result: 'ok' });
      return stmts.byId.get(id);
    },
    list(query = {}) {
      const where = []; const params = {};
      if (query.status) { where.push('status = @status'); params.status = query.status; }
      if (query.flagged) where.push('flagged = 1');
      if (query.plugin_id) { where.push('plugin_id = @plugin'); params.plugin = query.plugin_id; }
      return paginate(db, { select: 'id, plugin_id, customer_id, license_id, rating, title, body, status, flagged, moderated_by, developer_reply, created_at', from: 'plugin_reviews', where, params, sortable: { created_at: 'created_at', rating: 'rating' }, defaultSort: 'created_at', query: { dir: 'desc', ...query } });
    },
    forDeveloper: (developer, pluginId) => { m.submissions.owned(developer, pluginId); return db.prepare('SELECT id, rating, title, body, status, developer_reply, created_at FROM plugin_reviews WHERE plugin_id = ? ORDER BY created_at DESC').all(pluginId); },
    publishedFor: (pluginId) => stmts.published.all(pluginId),
  };
  return svc;
}
