import { HttpError, notFound } from '../../shared/errors.js';
import { newId, paginate } from '../../shared/db.js';

// Revocations (§18.3/§18.4): yank hides, revoke propagates through the feed,
// takedown removes the plugin and suspends the developer; the kill-switch
// also queues a check-in message so every panel pulls the feed within one check-in.
export function createRevocationsService(m) {
  const { ctx, db } = m;
  const stmts = {
    insert: db.prepare('INSERT INTO revocations (id, plugin_id, version, severity, action, reason, revoked_by, ts) VALUES (@id, @plugin_id, @version, @severity, @action, @reason, @revoked_by, @ts)'),
    since: db.prepare('SELECT * FROM revocations WHERE ts > ? ORDER BY ts, id LIMIT 500'),
    head: db.prepare('SELECT MAX(ts) AS ts FROM revocations'),
    reason: db.prepare('SELECT reason FROM revocations WHERE plugin_id = ? AND (version IS NULL OR version = ?) ORDER BY ts DESC LIMIT 1'),
    revokeVersion: db.prepare("UPDATE plugin_versions SET status = 'revoked' WHERE plugin_id = @plugin_id AND (@version IS NULL OR version = @version) AND status IN ('approved', 'published', 'yanked')"),
  };
  const view = (r) => ({ id: r.id, plugin_id: r.plugin_id, version: r.version, severity: r.severity, action: r.action, reason: r.reason, ts: r.ts, revoked_by: r.revoked_by });

  const svc = {
    view,
    create({ plugin_id, version = null, severity, action, reason }, { by, ip } = {}) {
      const plugin = m.submissions.get(plugin_id);
      if (version) m.submissions.version(plugin_id, version);
      const id = newId('rvk', m.now());
      // ts is monotonic per hub: a second revocation in the same millisecond moves one ahead.
      const ts = Math.max(m.now(), (stmts.head.get().ts || 0) + 1);
      db.transaction(() => {
        stmts.insert.run({ id, plugin_id, version, severity, action, reason: reason || null, revoked_by: by, ts });
        stmts.revokeVersion.run({ plugin_id, version });
        m.submissions.recomputeLatest(plugin_id);
      })();
      m.audit({ principal: by, role: 'vendor', ip, action: 'version.revoke', target: version ? `${plugin_id}@${version}` : plugin_id, args: { severity, action, reason }, result: 'ok' });
      m.webhook(plugin.developer_id, 'version.revoked', { plugin_id, version, severity, action, reason });
      const dev = m.developers.get(plugin.developer_id);
      m.mail(dev.email, 'dev.submission_revoked', { display_name: dev.display_name, plugin_id, version, reason, severity });
      if (severity === 'critical') ctx.activations.pushMessage({ all: true }, { level: 'critical', code: 'plugin_revocations_pending', text: `Plugin ${plugin_id}${version ? `@${version}` : ''} was revoked; pull the revocation feed`, data: { plugin_id, version, head_ts: ts } });
      ctx.metrics?.inc('market_revocations_total', { severity });
      return view(db.prepare('SELECT * FROM revocations WHERE id = ?').get(id));
    },
    // Emergency kill-switch: whole plugin, critical, disable|uninstall, check-in message to every activation.
    killSwitch({ plugin_id, severity = 'critical', action = 'disable', reason }, actor = {}) {
      const out = svc.create({ plugin_id, version: null, severity, action, reason: reason || 'kill-switch' }, actor);
      if (severity !== 'critical') ctx.activations.pushMessage({ all: true }, { level: 'critical', code: 'plugin_revocations_pending', text: `Plugin ${plugin_id} was revoked; pull the revocation feed`, data: { plugin_id, head_ts: out.ts } });
      return out;
    },
    takedown(plugin_id, { reason, by, ip } = {}) {
      const plugin = m.submissions.get(plugin_id);
      const rev = svc.create({ plugin_id, version: null, severity: 'critical', action: 'uninstall', reason: reason || 'takedown' }, { by, ip });
      db.prepare("UPDATE plugins SET status = 'removed', updated_at = ? WHERE id = ?").run(m.nowIso(), plugin_id);
      const dev = m.developers.get(plugin.developer_id);
      if (dev.status !== 'suspended') m.developers.suspend(dev.id, { reason: `takedown:${plugin_id}`, by, ip });
      m.audit({ principal: by, role: 'vendor', ip, action: 'plugin.takedown', target: plugin_id, args: { reason }, result: 'ok' });
      return { revocation: rev, plugin_status: 'removed', developer_status: 'suspended' };
    },
    feed(since = 0) {
      const rows = stmts.since.all(Number(since) || 0).map(view);
      return { data: rows, head_ts: svc.headTs() };
    },
    headTs: () => stmts.head.get().ts || 0,
    reasonFor: (pluginId, version) => stmts.reason.get(pluginId, version)?.reason || null,
    list(query = {}) {
      const where = []; const params = {};
      if (query.plugin_id) { where.push('plugin_id = @plugin'); params.plugin = query.plugin_id; }
      if (query.severity) { where.push('severity = @severity'); params.severity = query.severity; }
      const page = paginate(db, { from: 'revocations', where, params, sortable: { ts: 'ts' }, defaultSort: 'ts', query: { dir: 'desc', ...query } });
      return { ...page, data: page.data.map((r) => ({ ...view(r), propagation: svc.propagation(r) })) };
    },
    // How many installs of the revoked plugin have checked in since the revocation.
    propagation(r) {
      const rows = db.prepare('SELECT state, last_seen FROM installs WHERE plugin_id = @plugin_id AND (@version IS NULL OR version = @version)').all({ plugin_id: r.plugin_id, version: r.version });
      const after = rows.filter((i) => new Date(i.last_seen).getTime() >= r.ts);
      return { installs: rows.length, reported_after: after.length, still_active: after.filter((i) => ['enabled', 'installed', 'disabled'].includes(i.state)).length };
    },
    pending: () => db.prepare("SELECT COUNT(*) AS n FROM revocations r WHERE EXISTS (SELECT 1 FROM installs i WHERE i.plugin_id = r.plugin_id AND (r.version IS NULL OR i.version = r.version) AND i.state IN ('enabled', 'installed') AND i.last_seen < datetime(r.ts / 1000, 'unixepoch'))").get().n,
  };
  return svc;
}
