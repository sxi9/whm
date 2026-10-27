import { HttpError, notFound } from '../../shared/errors.js';
import { json, paginate } from '../../shared/db.js';
import * as pkg from '../lib/package.js';

const DAY_MS = 86_400_000;

// Public catalog reads (§18.4) and vendor catalog control.
export function createCatalogService(m) {
  const { ctx, db } = m;

  function latestFor(pluginId, channel) {
    const rows = db.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? AND status = 'published'").all(pluginId);
    const pool = channel === 'beta' ? rows : rows.filter((v) => v.channel === 'stable');
    return pool.sort((a, b) => pkg.semver.compare(b.version, a.version))[0] || null;
  }
  function versionView(v) {
    return { version: v.version, channel: v.channel, published_at: v.published_at, engines_whm: v.engines_whm, package_sha256: v.package_sha256, package_bytes: v.package_bytes, permissions: json.parse(v.permissions_json, []), kid: v.mkt_kid };
  }
  function entry(p, channel) {
    const latest = latestFor(p.id, channel);
    const dev = m.developers.find(p.developer_id);
    const cat = p.category_id ? db.prepare('SELECT slug, name FROM categories WHERE id = ?').get(p.category_id) : null;
    return {
      id: p.id, name: p.name, slug: p.slug, summary: p.summary, developer: dev ? m.developers.card(dev) : null, category: cat || null, pricing: json.parse(p.pricing_json, { model: 'free' }),
      latest: latest ? { version: latest.version, channel: latest.channel, published_at: latest.published_at, engines_whm: latest.engines_whm } : null,
      install_count: p.install_count, rating_avg: p.rating_avg, rating_count: p.rating_count, featured: !!p.featured,
      icon_url: p.icon_file_id ? `${ctx.config.public_url}/v1/market/assets/${p.id}/${p.icon_file_id}` : null, updated_at: p.updated_at,
    };
  }

  const svc = {
    latestFor, versionView,
    catalog(query = {}) {
      const channel = query.channel || 'stable';
      const where = ["p.status = 'listed'", `${channel === 'beta' ? '(p.latest_stable_version IS NOT NULL OR p.latest_beta_version IS NOT NULL)' : 'p.latest_stable_version IS NOT NULL'}`];
      const params = {};
      if (query.q) { where.push('(p.name LIKE @q OR p.summary LIKE @q OR p.keywords_json LIKE @q OR p.id LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.category) { where.push('c.slug = @category'); params.category = query.category; }
      if (query.featured) where.push('p.featured = 1');
      const page = paginate(db, { select: 'p.*', from: 'plugins p LEFT JOIN categories c ON c.id = p.category_id', where, params, sortable: { installs: 'p.install_count', rating: 'p.rating_avg', updated: 'p.updated_at', name: 'p.name' }, defaultSort: query.sort || 'installs', query: { dir: query.dir || 'desc', ...query, sort: query.sort || 'installs' } });
      return { ...page, data: page.data.map((p) => entry(p, channel)) };
    },
    categories() {
      return db.prepare("SELECT c.id, c.slug, c.name, c.position, (SELECT COUNT(*) FROM plugins p WHERE p.category_id = c.id AND p.status = 'listed' AND p.latest_stable_version IS NOT NULL) AS count FROM categories c ORDER BY c.position").all();
    },
    detail(id, { host = null } = {}) {
      const p = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
      if (!p || !['listed', 'unlisted'].includes(p.status)) throw notFound('Plugin');
      const stable = latestFor(id, 'stable');
      const beta = latestFor(id, 'beta');
      const latest = stable || beta;
      const just = latest ? json.parse(latest.permission_justifications_json, {}) : {};
      const versions = db.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? AND status = 'published' ORDER BY published_at DESC").all(id);
      return {
        ...entry(p, 'beta'), description_md: p.description_md, keywords: json.parse(p.keywords_json, []), homepage: p.homepage, support_url: p.support_url, license_spdx: p.license_spdx,
        screenshots: m.submissions.assetsOf(id).filter((a) => a.kind !== 'icon'),
        permissions: latest ? json.parse(latest.permissions_json, []).map((s) => ({ scope: s, description: pkg.sdk.PERMISSIONS[s] || (s.startsWith('agent:op:') ? 'Run the named privileged agent operation' : s.startsWith('net:outbound:') ? 'Outbound HTTPS to the named host' : null), justification: just[s] || null })) : [],
        compatibility: latest ? { engines_whm: latest.engines_whm, host, compatible: host ? safeSatisfies(host, latest.engines_whm) : null } : null,
        versions: { stable: stable ? versionView(stable) : null, beta: beta ? versionView(beta) : null, all: versions.map(versionView) },
        changelog: versions.map((v) => ({ version: v.version, channel: v.channel, published_at: v.published_at, changelog_md: v.changelog_md })),
        reviews: m.pluginReviews.publishedFor(id),
        bundled_editions: json.parse(p.bundled_editions_json, []),
      };
    },
    versions(id) {
      const p = db.prepare('SELECT status FROM plugins WHERE id = ?').get(id);
      if (!p || !['listed', 'unlisted'].includes(p.status)) throw notFound('Plugin');
      return db.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? AND status = 'published' ORDER BY published_at DESC").all(id).map(versionView);
    },
    keys: () => ({ keys: ctx.keys.listPublic('plugin').map((k) => ({ ...k, purpose: 'plugin' })) }),
    // install_count: installs rows in enabled|installed|disabled, last_seen ≤ 30 d,
    // on an active activation of a non-trial license.
    refreshCounts(pluginId = null) {
      const since = m.nowIso(m.now() - 30 * DAY_MS);
      const rows = db.prepare(`SELECT plugin_id, license_id, activation_id FROM installs WHERE state IN ('enabled', 'installed', 'disabled') AND last_seen >= ? ${pluginId ? 'AND plugin_id = ?' : ''}`).all(...(pluginId ? [since, pluginId] : [since]));
      const counts = new Map();
      const licenseCache = new Map();
      for (const r of rows) {
        if (!licenseCache.has(r.license_id)) {
          const lic = ctx.licenses.getRaw(r.license_id);
          licenseCache.set(r.license_id, lic && lic.edition !== 'trial');
        }
        if (!licenseCache.get(r.license_id)) continue;
        const a = ctx.activations.find(r.activation_id);
        if (!a || a.status !== 'active') continue;
        counts.set(r.plugin_id, (counts.get(r.plugin_id) || 0) + 1);
      }
      const ids = pluginId ? [pluginId] : db.prepare('SELECT id FROM plugins').all().map((p) => p.id);
      const upd = db.prepare('UPDATE plugins SET install_count = ? WHERE id = ?');
      db.transaction(() => { for (const id of ids) upd.run(counts.get(id) || 0, id); })();
      return Object.fromEntries(ids.map((id) => [id, counts.get(id) || 0]));
    },
    refreshRating(pluginId) {
      const r = db.prepare("SELECT AVG(rating) AS avg, COUNT(*) AS n FROM plugin_reviews WHERE plugin_id = ? AND status = 'published'").get(pluginId);
      db.prepare('UPDATE plugins SET rating_avg = ?, rating_count = ? WHERE id = ?').run(r.n ? Math.round(r.avg * 100) / 100 : null, r.n, pluginId);
    },
    adminList(query = {}) {
      const where = []; const params = {};
      if (query.status) { where.push('status = @status'); params.status = query.status; }
      if (query.q) { where.push('(id LIKE @q OR name LIKE @q)'); params.q = `%${query.q}%`; }
      const page = paginate(db, { from: 'plugins', where, params, sortable: { created_at: 'created_at', name: 'name', install_count: 'install_count' }, defaultSort: 'created_at', query: { dir: 'desc', ...query } });
      return { ...page, data: page.data.map((p) => m.submissions.shapePlugin(p)) };
    },
    adminGet(id) {
      const p = m.submissions.get(id);
      return { ...m.submissions.shapePlugin(p), versions: m.submissions.versionsOf(id).map((v) => m.submissions.shapeVersion(v)), developer: m.developers.publicView(m.developers.get(p.developer_id)), assets: m.submissions.assetsOf(id) };
    },
    adminPatch(id, patch, { by, ip } = {}) {
      m.submissions.get(id);
      const sets = []; const params = { id, now: m.nowIso() };
      if (patch.status !== undefined) { if (!['draft', 'listed', 'unlisted', 'removed'].includes(patch.status)) throw new HttpError(422, 'validation_failed', 'Unknown status'); sets.push('status = @status'); params.status = patch.status; }
      if (patch.featured !== undefined) { sets.push('featured = @featured'); params.featured = patch.featured ? 1 : 0; }
      if (patch.category_id !== undefined) { if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(patch.category_id)) throw new HttpError(422, 'validation_failed', 'Unknown category'); sets.push('category_id = @category_id'); params.category_id = patch.category_id; }
      if (patch.bundled_editions !== undefined) { sets.push('bundled_editions_json = @bundled'); params.bundled = JSON.stringify(patch.bundled_editions); }
      if (sets.length) db.prepare(`UPDATE plugins SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
      m.audit({ principal: by, role: 'vendor', ip, action: 'plugin.admin_patch', target: id, args: patch, result: 'ok' });
      return svc.adminGet(id);
    },
    createCategory({ slug, name, position = 0 }, { by, ip } = {}) {
      if (!/^[a-z0-9-]{2,40}$/.test(slug)) throw new HttpError(422, 'validation_failed', 'slug must be lower-case letters, digits and dashes');
      if (db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(slug)) throw new HttpError(409, 'conflict', 'Category exists');
      const id = `cat_${slug.replace(/-/g, '_')}`;
      db.prepare('INSERT INTO categories (id, slug, name, position) VALUES (?, ?, ?, ?)').run(id, slug, name, position);
      m.audit({ principal: by, role: 'vendor', ip, action: 'category.create', target: id, args: { slug, name }, result: 'ok' });
      return { id, slug, name, position };
    },
  };
  function safeSatisfies(host, range) { try { return pkg.semver.satisfies(host, range); } catch { return false; } }
  return svc;
}
