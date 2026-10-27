import fs from 'node:fs';
import path from 'node:path';
import { HttpError, notFound } from '../../shared/errors.js';
import { newId, json, paginate } from '../../shared/db.js';
import * as pkg from '../lib/package.js';
import { skeleton } from '../lib/scanner-rules.js';

export const PRICING_MODELS = ['free', 'one_time', 'subscription'];
const EDITABLE = ['name', 'summary', 'description_md', 'category_id', 'keywords', 'homepage', 'support_url', 'license_spdx', 'pricing'];
const ASSET_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plugin';
}

// Listings, uploads (§18.3 "Upload"), publish and yank. Uploaded bytes are
// immutable: the file is written once and hashed on arrival.
export function createSubmissionsService(m) {
  const { ctx, db, cfg } = m;
  const stmts = {
    plugin: db.prepare('SELECT * FROM plugins WHERE id = ?'),
    bySlug: db.prepare('SELECT id FROM plugins WHERE slug = ?'),
    insertPlugin: db.prepare(`INSERT INTO plugins (id, developer_id, name, name_skeleton, slug, summary, description_md, category_id, keywords_json, homepage, support_url, license_spdx, pricing_json, status, created_at, updated_at)
      VALUES (@id, @developer_id, @name, @name_skeleton, @slug, @summary, @description_md, @category_id, @keywords_json, @homepage, @support_url, @license_spdx, @pricing_json, 'draft', @now, @now)`),
    versions: db.prepare('SELECT * FROM plugin_versions WHERE plugin_id = ? ORDER BY created_at DESC'),
    version: db.prepare('SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ?'),
    versionById: db.prepare('SELECT * FROM plugin_versions WHERE id = ?'),
    insertVersion: db.prepare(`INSERT INTO plugin_versions (id, plugin_id, version, channel, status, manifest_json, permissions_json, engines_whm, permission_justifications_json, changelog_md, upload_sha256, upload_file, package_bytes, extracted_bytes, package_digest, dev_kid, dev_signature, created_at)
      VALUES (@id, @plugin_id, @version, @channel, 'uploaded', @manifest_json, @permissions_json, @engines_whm, @permission_justifications_json, @changelog_md, @upload_sha256, @upload_file, @package_bytes, @extracted_bytes, @package_digest, @dev_kid, @dev_signature, @created_at)`),
    insertFile: db.prepare('INSERT INTO plugin_files (version_id, path, sha256, bytes, text) VALUES (?, ?, ?, ?, ?)'),
    files: db.prepare('SELECT path, sha256, bytes FROM plugin_files WHERE version_id = ? ORDER BY path'),
    setStatus: db.prepare('UPDATE plugin_versions SET status = @status, published_at = COALESCE(@published_at, published_at), yanked_at = COALESCE(@yanked_at, yanked_at), yanked_reason = COALESCE(@yanked_reason, yanked_reason), channel = COALESCE(@channel, channel) WHERE id = @id'),
  };

  function get(id) {
    const row = stmts.plugin.get(id);
    if (!row) throw notFound('Plugin');
    return row;
  }
  function owned(developer, id) {
    const row = get(id);
    if (row.developer_id !== developer.id) throw notFound('Plugin');
    return row;
  }
  function shapePlugin(p) {
    return { ...p, keywords: json.parse(p.keywords_json, []), pricing: json.parse(p.pricing_json, { model: 'free' }), bundled_editions: json.parse(p.bundled_editions_json, []), featured: !!p.featured, keywords_json: undefined, pricing_json: undefined, bundled_editions_json: undefined, name_skeleton: undefined };
  }
  function shapeVersion(v, { full = false } = {}) {
    const out = {
      id: v.id, plugin_id: v.plugin_id, version: v.version, channel: v.channel, status: v.status, engines_whm: v.engines_whm, permissions: json.parse(v.permissions_json, []),
      permission_justifications: json.parse(v.permission_justifications_json, {}), changelog_md: v.changelog_md, upload_sha256: v.upload_sha256, package_sha256: v.package_sha256, package_bytes: v.package_bytes,
      extracted_bytes: v.extracted_bytes, package_digest: v.package_digest, dev_kid: v.dev_kid, mkt_kid: v.mkt_kid, signed_at: v.signed_at, risk: v.risk, scan_report: json.parse(v.scan_report_json, null),
      review_id: v.review_id, published_at: v.published_at, yanked_at: v.yanked_at, yanked_reason: v.yanked_reason, created_at: v.created_at,
    };
    if (full) { out.manifest = json.parse(v.manifest_json, {}); out.files = stmts.files.all(v.id); }
    return out;
  }
  function validatePricing(p) {
    if (!p || !PRICING_MODELS.includes(p.model)) throw new HttpError(422, 'validation_failed', `pricing.model must be one of ${PRICING_MODELS.join(', ')}`);
    if (p.model === 'free') return { model: 'free' };
    if (!Number.isInteger(p.cents) || p.cents < 100 || p.cents > 100_000_000) throw new HttpError(422, 'validation_failed', 'pricing.cents must be an integer between 100 and 100000000');
    const currency = String(p.currency || cfg.currencies[0]).toUpperCase();
    if (!cfg.currencies.includes(currency)) throw new HttpError(422, 'validation_failed', `currency must be one of ${cfg.currencies.join(', ')}`);
    if (p.model === 'one_time') return { model: 'one_time', cents: p.cents, currency };
    if (!['month', 'year'].includes(p.interval)) throw new HttpError(422, 'validation_failed', 'pricing.interval must be month or year');
    const trial = p.trial_days == null ? 0 : p.trial_days;
    if (!Number.isInteger(trial) || trial < 0 || trial > 90) throw new HttpError(422, 'validation_failed', 'pricing.trial_days must be 0..90');
    return { model: 'subscription', cents: p.cents, currency, interval: p.interval, trial_days: trial };
  }
  function pluginDir(id) {
    const dir = path.join(cfg.packages_dir, id);
    fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true, mode: 0o750 });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true, mode: 0o750 });
    return dir;
  }
  function publishedVersions(pluginId, channel) {
    return stmts.versions.all(pluginId).filter((v) => ['published', 'yanked', 'revoked', 'approved'].includes(v.status) && (!channel || v.channel === channel));
  }

  const svc = {
    get, owned, shapePlugin, shapeVersion, validatePricing, publishedVersions, pluginDir,
    version(pluginId, version) {
      const row = stmts.version.get(pluginId, version);
      if (!row) throw notFound('Version');
      return row;
    },
    versionById(id) {
      const row = stmts.versionById.get(id);
      if (!row) throw notFound('Version');
      return row;
    },
    versionsOf: (pluginId) => stmts.versions.all(pluginId),
    listFor(developer, query = {}) {
      const page = paginate(db, { from: 'plugins', where: ['developer_id = @dev'], params: { dev: developer.id }, sortable: { created_at: 'created_at', name: 'name', status: 'status' }, defaultSort: 'created_at', query: { dir: 'desc', ...query } });
      return { ...page, data: page.data.map(shapePlugin) };
    },
    create(developer, input, { ip } = {}) {
      const id = String(input.id);
      if (!pkg.sdk.ID_PATTERN.test(id) || id.length > pkg.sdk.ID_MAX_LENGTH) throw new HttpError(422, 'validation_failed', 'id must be a reverse-DNS plugin id with at least three segments');
      if (!m.developers.ownsNamespaceFor(developer, id)) throw new HttpError(403, 'namespace_not_owned', `"${id}" is not under one of your namespaces`);
      if (stmts.plugin.get(id)) throw new HttpError(409, 'plugin_exists', 'A listing with that id already exists');
      if (input.category_id && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(input.category_id)) throw new HttpError(422, 'validation_failed', 'Unknown category');
      let slug = input.slug ? slugify(input.slug) : slugify(input.name);
      for (let i = 2; stmts.bySlug.get(slug); i++) slug = `${slugify(input.name)}-${i}`;
      stmts.insertPlugin.run({
        id, developer_id: developer.id, name: input.name, name_skeleton: skeleton(input.name), slug, summary: input.summary || null, description_md: input.description_md || null, category_id: input.category_id || 'cat_other',
        keywords_json: JSON.stringify(input.keywords || []), homepage: input.homepage || null, support_url: input.support_url || null, license_spdx: input.license_spdx || null, pricing_json: JSON.stringify(validatePricing(input.pricing || { model: 'free' })), now: m.nowIso(),
      });
      m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'plugin.create', target: id, args: { name: input.name }, result: 'ok' });
      return shapePlugin(get(id));
    },
    update(developer, id, patch, { ip, admin = false } = {}) {
      const p = admin ? get(id) : owned(developer, id);
      const sets = []; const params = { id, now: m.nowIso() };
      for (const k of EDITABLE) {
        if (patch[k] === undefined) continue;
        if (k === 'keywords') { sets.push('keywords_json = @keywords'); params.keywords = JSON.stringify(patch.keywords); continue; }
        if (k === 'pricing') { sets.push('pricing_json = @pricing'); params.pricing = JSON.stringify(validatePricing(patch.pricing)); continue; }
        if (k === 'category_id' && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(patch.category_id)) throw new HttpError(422, 'validation_failed', 'Unknown category');
        if (k === 'name') { sets.push('name_skeleton = @name_skeleton'); params.name_skeleton = skeleton(patch.name); }
        sets.push(`${k} = @${k}`); params[k] = patch[k];
      }
      if (sets.length) db.prepare(`UPDATE plugins SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
      m.audit({ principal: admin ? (patch._by || 'vendor') : `developer:${developer.id}`, role: admin ? 'vendor' : 'developer', ip, action: 'plugin.update', target: p.id, args: patch, result: 'ok' });
      return shapePlugin(get(id));
    },
    addAsset(developer, id, { kind, content_type, data, position = 0 }, { ip } = {}) {
      owned(developer, id);
      const ext = ASSET_TYPES[content_type];
      if (!ext) throw new HttpError(422, 'validation_failed', 'content_type must be image/png, image/jpeg or image/svg+xml');
      const buf = Buffer.from(String(data), 'base64');
      if (!buf.length || buf.length > MAX_ASSET_BYTES) throw new HttpError(422, 'validation_failed', `asset must be 1 byte to ${MAX_ASSET_BYTES} bytes`);
      const fileId = `${newId('ast', m.now())}.${ext}`;
      fs.writeFileSync(path.join(pluginDir(id), 'assets', fileId), buf, { mode: 0o640 });
      const aid = newId('ast', m.now());
      db.prepare('INSERT INTO plugin_assets (id, plugin_id, kind, file_id, content_type, bytes, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(aid, id, kind, fileId, content_type, buf.length, position, m.nowIso());
      if (kind === 'icon') db.prepare('UPDATE plugins SET icon_file_id = ?, updated_at = ? WHERE id = ?').run(fileId, m.nowIso(), id);
      m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'plugin.asset.add', target: id, args: { kind, bytes: buf.length }, result: 'ok' });
      return { id: aid, kind, url: `${ctx.config.public_url}/v1/market/assets/${id}/${fileId}`, bytes: buf.length, position };
    },
    deleteAsset(developer, id, aid) {
      owned(developer, id);
      const row = db.prepare('SELECT * FROM plugin_assets WHERE id = ? AND plugin_id = ?').get(aid, id);
      if (!row) throw notFound('Asset');
      db.prepare('DELETE FROM plugin_assets WHERE id = ?').run(aid);
      fs.rmSync(path.join(cfg.packages_dir, id, 'assets', row.file_id), { force: true });
      if (row.kind === 'icon') db.prepare('UPDATE plugins SET icon_file_id = NULL WHERE id = ? AND icon_file_id = ?').run(id, row.file_id);
      return { deleted: true };
    },
    assetsOf: (id) => db.prepare('SELECT id, kind, file_id, content_type, bytes, position FROM plugin_assets WHERE plugin_id = ? ORDER BY kind, position').all(id).map((a) => ({ id: a.id, kind: a.kind, content_type: a.content_type, bytes: a.bytes, position: a.position, url: `${ctx.config.public_url}/v1/market/assets/${id}/${a.file_id}` })),
    assetFile(id, fileId) {
      const row = db.prepare('SELECT * FROM plugin_assets WHERE plugin_id = ? AND file_id = ?').get(id, fileId);
      if (!row || !/^[A-Za-z0-9_.-]+$/.test(fileId)) throw notFound('Asset');
      return { file: path.join(cfg.packages_dir, id, 'assets', fileId), content_type: row.content_type };
    },

    // §18.3 upload: raw .whmplugin → immutable upload file + plugin_versions row,
    // then the automated scan (synchronous, so the answer carries its result).
    async upload(developer, pluginId, buffer, { channel = 'stable', changelog_md = null, justifications = null } = {}, { ip } = {}) {
      m.developers.assertCanUpload(developer, pluginId);
      const plugin = owned(developer, pluginId);
      m.limits.assert(`upload:${developer.id}`, cfg.rate_limits.upload.max, cfg.rate_limits.upload.windowMs, 'Upload limit reached (10 per day)');
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(422, 'invalid_package', 'Send the .whmplugin bytes as the request body');
      if (buffer.length > cfg.max_package_bytes) throw new HttpError(413, 'too_large', `Packages may be at most ${cfg.max_package_bytes} bytes`);
      const unpacked = pkg.unpack(buffer, { maxBytes: cfg.max_package_bytes });
      try {
        const root = pkg.stripWrapper(unpacked);
        if (fs.existsSync(path.join(root, pkg.SIGNATURE_FILE))) throw new HttpError(422, 'reserved_file', 'SIGNATURE.json is written by the marketplace; remove it from the upload');
        const manifest = pkg.readManifest(root);
        const vr = pkg.validateManifest(manifest);
        if (!vr.ok) throw new HttpError(422, 'invalid_manifest', `plugin.json is invalid: ${vr.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, Object.fromEntries(vr.errors.map((e) => [e.path || '_', [e.message]])));
        if (manifest.id !== pluginId) throw new HttpError(422, 'id_mismatch', `plugin.json id "${manifest.id}" does not match the listing "${pluginId}"`);
        if (!pkg.semver.valid(manifest.version)) throw new HttpError(422, 'invalid_manifest', 'version must be semver');
        if (stmts.version.get(pluginId, manifest.version)) throw new HttpError(409, 'version_exists', `Version ${manifest.version} was already uploaded; uploaded bytes are immutable`);
        for (const v of publishedVersions(pluginId, channel)) {
          if (pkg.semver.compare(manifest.version, v.version) <= 0) throw new HttpError(422, 'version_not_greater', `Version ${manifest.version} is not greater than ${v.version} on the ${channel} channel`);
        }
        const devSig = pkg.readSignature(root, pkg.DEV_SIGNATURE_FILE);
        if (!devSig) throw new HttpError(422, 'dev_signature_missing', 'DEV-SIGNATURE.json is required (scripts/build-plugin.js --sign <key> --dev)');
        const key = m.devKeys.activeKey(developer.id, devSig.kid);
        if (!key) throw new HttpError(403, 'dev_signature_invalid', `DEV-SIGNATURE.json names key "${devSig.kid}", which is not an active signing key of your account`);
        const devDigest = pkg.packageDigest(root, { exclude: [pkg.SIGNATURE_FILE, pkg.DEV_SIGNATURE_FILE] });
        if (!pkg.verifyDigest(devDigest, devSig.sig, key.public_key_pem)) throw new HttpError(422, 'dev_signature_invalid', 'DEV-SIGNATURE.json does not match the package contents');
        const digest = pkg.packageDigest(root).toString('hex');
        const files = pkg.fileList(root);
        const id = newId('ver', m.now());
        const uploadFile = path.join(pluginDir(pluginId), 'uploads', `${manifest.version}.whmplugin`);
        fs.writeFileSync(uploadFile, buffer, { mode: 0o640, flag: 'wx' });
        const previous = stmts.versions.all(pluginId)[0];
        const inherited = previous ? json.parse(previous.permission_justifications_json, {}) : {};
        const just = { ...Object.fromEntries(Object.entries(inherited).filter(([k]) => (manifest.permissions || []).includes(k))), ...(justifications || {}) };
        db.transaction(() => {
          stmts.insertVersion.run({
            id, plugin_id: pluginId, version: manifest.version, channel, manifest_json: JSON.stringify(manifest), permissions_json: JSON.stringify(manifest.permissions || []), engines_whm: manifest.engines?.whm || '*',
            permission_justifications_json: JSON.stringify(just), changelog_md, upload_sha256: pkg.sha256(buffer), upload_file: uploadFile, package_bytes: buffer.length, extracted_bytes: unpacked.extractedBytes,
            package_digest: digest, dev_kid: devSig.kid, dev_signature: devSig.sig, created_at: m.nowIso(),
          });
          for (const f of files) stmts.insertFile.run(id, f.path, f.sha256, f.bytes, pkg.isTextPath(f.path) && f.bytes <= 262_144 ? fs.readFileSync(path.join(root, f.path), 'utf8') : null);
        })();
        m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'version.upload', target: `${pluginId}@${manifest.version}`, args: { channel, sha256: pkg.sha256(buffer), bytes: buffer.length, dev_kid: devSig.kid }, result: 'ok' });
        if (plugin.status === 'draft' && !plugin.name) svc.update(developer, pluginId, { name: manifest.name });
        await m.scanner.scan(id, { root });
        return shapeVersion(svc.versionById(id));
      } finally {
        unpacked.cleanup();
      }
    },
    async updateVersion(developer, pluginId, version, patch, { ip } = {}) {
      owned(developer, pluginId);
      const v = svc.version(pluginId, version);
      if (!['uploaded', 'scanning', 'scan_failed', 'in_review', 'changes_requested'].includes(v.status)) throw new HttpError(409, 'version_frozen', `A ${v.status} version cannot be edited; upload a new version`);
      const just = patch.permission_justifications ? { ...json.parse(v.permission_justifications_json, {}), ...patch.permission_justifications } : null;
      db.prepare('UPDATE plugin_versions SET changelog_md = COALESCE(@changelog, changelog_md), permission_justifications_json = COALESCE(@just, permission_justifications_json) WHERE id = @id').run({ id: v.id, changelog: patch.changelog_md ?? null, just: just ? JSON.stringify(just) : null });
      m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'version.update', target: `${pluginId}@${version}`, args: patch, result: 'ok' });
      if (['scan_failed', 'in_review', 'changes_requested'].includes(v.status) && just) await m.scanner.scan(v.id);
      return shapeVersion(svc.versionById(v.id));
    },
    publish(developer, pluginId, version, { channel } = {}, { ip, by = null } = {}) {
      const plugin = by ? get(pluginId) : owned(developer, pluginId);
      const dev = m.developers.get(plugin.developer_id);
      m.developers.assertCanPublish(dev);
      const v = svc.version(pluginId, version);
      if (v.status !== 'approved') throw new HttpError(409, 'not_approved', `Only approved versions can be published (this one is ${v.status})`);
      if (!v.mkt_kid || !v.package_file || !fs.existsSync(v.package_file)) throw new HttpError(409, 'not_signed', 'The version has no signed package yet');
      const ch = channel || v.channel;
      for (const other of publishedVersions(pluginId, ch)) {
        if (other.id !== v.id && other.status === 'published' && pkg.semver.compare(v.version, other.version) <= 0) throw new HttpError(422, 'version_not_greater', `${v.version} is not greater than published ${other.version} on ${ch}`);
      }
      db.transaction(() => {
        stmts.setStatus.run({ id: v.id, status: 'published', published_at: m.nowIso(), yanked_at: null, yanked_reason: null, channel: ch });
        db.prepare(`UPDATE plugins SET ${ch === 'beta' ? 'latest_beta_version' : 'latest_stable_version'} = ?, status = CASE WHEN status = 'draft' THEN 'listed' ELSE status END, updated_at = ? WHERE id = ?`).run(v.version, m.nowIso(), pluginId);
      })();
      m.audit({ principal: by || `developer:${developer.id}`, role: by ? 'vendor' : 'developer', ip, action: 'version.publish', target: `${pluginId}@${version}`, args: { channel: ch }, result: 'ok' });
      m.webhook(plugin.developer_id, 'version.published', { plugin_id: pluginId, version, channel: ch, package_sha256: v.package_sha256, kid: v.mkt_kid });
      m.mail(dev.email, 'dev.submission_published', { display_name: dev.display_name, plugin_id: pluginId, version, channel: ch });
      return shapeVersion(svc.versionById(v.id));
    },
    yank(developer, pluginId, version, { reason }, { ip, by = null } = {}) {
      const plugin = by ? get(pluginId) : owned(developer, pluginId);
      const v = svc.version(pluginId, version);
      if (v.status !== 'published') throw new HttpError(409, 'not_published', `Only published versions can be yanked (this one is ${v.status})`);
      db.transaction(() => {
        stmts.setStatus.run({ id: v.id, status: 'yanked', published_at: null, yanked_at: m.nowIso(), yanked_reason: reason || null, channel: null });
        svc.recomputeLatest(pluginId);
      })();
      m.audit({ principal: by || `developer:${developer.id}`, role: by ? 'vendor' : 'developer', ip, action: 'version.yank', target: `${pluginId}@${version}`, args: { reason }, result: 'ok' });
      m.webhook(plugin.developer_id, 'version.yanked', { plugin_id: pluginId, version, reason });
      return shapeVersion(svc.versionById(v.id));
    },
    recomputeLatest(pluginId) {
      const pub = stmts.versions.all(pluginId).filter((v) => v.status === 'published');
      const latest = (ch) => pub.filter((v) => v.channel === ch).sort((a, b) => pkg.semver.compare(b.version, a.version))[0]?.version || null;
      db.prepare('UPDATE plugins SET latest_stable_version = ?, latest_beta_version = ?, updated_at = ? WHERE id = ?').run(latest('stable'), latest('beta'), m.nowIso(), pluginId);
    },
  };
  return svc;
}
