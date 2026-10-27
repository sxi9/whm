import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, notFound, unprocessable } from '../../shared/errors.js';
import { newId, json } from '../../shared/db.js';
import * as pkg from '../lib/package.js';

// Download descriptors, the single-use HMAC download URL, the update feed
// (§18.4). Every step re-checks the live license and activation rows.
export function createDistributionService(m) {
  const { ctx, db, cfg } = m;
  const stmts = {
    insert: db.prepare('INSERT INTO downloads (id, version_id, license_id, activation_id, ip_hash, panel_version, ts, expires_at, result) VALUES (@id, @version_id, @license_id, @activation_id, @ip_hash, @panel_version, @ts, @expires_at, @result)'),
    byId: db.prepare('SELECT * FROM downloads WHERE id = ?'),
    consume: db.prepare("UPDATE downloads SET fetched_at = ?, result = 'fetched' WHERE id = ? AND fetched_at IS NULL"),
    installRow: db.prepare('SELECT 1 FROM installs WHERE license_id = ? AND plugin_id = ? AND version = ?'),
    purge: db.prepare('DELETE FROM downloads WHERE expires_at < ? OR (fetched_at IS NOT NULL AND fetched_at < ?)'),
  };

  function loadHmacKey() {
    const file = cfg.download_hmac_file;
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, key, { mode: 0o600 });
    ctx.logger.warn({ file }, 'download.hmac was missing; generated one (run hub/scripts/gen-key.js --hmac for production)');
    return key;
  }
  const hmacKey = loadHmacKey();
  const sigOf = (dlId, activationId, exp) => crypto.createHmac('sha256', hmacKey).update(`${dlId}|${activationId}|${exp}`).digest('base64url');

  // Token → live license + activation, with the §18.4 refusals.
  function resolvePanel({ token, fingerprint, fp_components }) {
    const verified = ctx.licenses.verifyToken(token);
    if (!verified.ok) throw new HttpError(401, 'invalid_token', `Token rejected: ${verified.reason}`);
    const payload = verified.payload;
    if (!['active', 'grace'].includes(payload.status)) throw new HttpError(403, 'license_inactive', `The license token is ${payload.status}`);
    const license = ctx.licenses.getRaw(payload.lid) ? ctx.licenses.get(payload.lid) : null;
    if (!license || !['active', 'grace'].includes(ctx.licenses.statusAt(license))) throw new HttpError(403, 'license_inactive', `The license is ${license ? ctx.licenses.statusAt(license) : 'unknown'}`);
    const activation = ctx.activations.find(payload.aid);
    if (!activation || activation.status !== 'active' || activation.license_id !== license.id) throw new HttpError(403, 'activation_inactive', `The activation is ${activation?.status || 'unknown'}`);
    if (fingerprint) {
      const match = activation.fingerprint === fingerprint ? { ok: true } : fp_components ? ctx.activations.matchFingerprint(activation.id, fingerprint, fp_components) : { ok: false };
      if (!match.ok) throw new HttpError(403, 'fingerprint_mismatch', 'This server does not match the activation');
    }
    return { payload, license, activation };
  }

  function pickVersion(plugin, version, channel) {
    if (version) {
      const row = db.prepare('SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ?').get(plugin.id, version);
      if (!row || !['published', 'yanked', 'revoked'].includes(row.status)) throw notFound('Version');
      return row;
    }
    const latest = m.catalog.latestFor(plugin.id, channel || 'stable');
    if (!latest) throw notFound('Published version');
    return latest;
  }

  const svc = {
    resolvePanel, sigOf,
    descriptor(input, { ip } = {}) {
      // §18.4: the descriptor is bound to the machine, so a copied license_state cannot download elsewhere.
      if (!input.fingerprint) throw unprocessable('fingerprint is required', { fingerprint: ['Required'] });
      const { license, activation } = resolvePanel(input);
      m.limits.assert(`download:${activation.id}`, cfg.rate_limits.download.max, cfg.rate_limits.download.windowMs, 'Download limit reached for this activation');
      const plugin = db.prepare('SELECT * FROM plugins WHERE id = ?').get(input.plugin_id);
      if (!plugin || !['listed', 'unlisted'].includes(plugin.status)) throw notFound('Plugin');
      const v = pickVersion(plugin, input.version, input.channel);
      const pricing = json.parse(plugin.pricing_json, { model: 'free' });
      const feature = pricing.model === 'free' ? 'marketplace_free' : 'marketplace_paid';
      if (license.features?.[feature] !== true || (pricing.model !== 'free' && license.edition === 'trial')) {
        throw Object.assign(new HttpError(403, 'feature_required', `Your ${license.edition} license does not include ${pricing.model === 'free' ? 'marketplace plugins' : 'paid plugins'}`), { extra: { feature } });
      }
      const ent = m.entitlements.check(license, plugin);
      if (!ent.ok) throw Object.assign(new HttpError(402, 'entitlement_required', `${plugin.name} is a paid plugin`), { extra: { pricing, buy_url: m.billing.buyUrl(plugin, license), entitlement: ent.status ? { kind: ent.kind, status: ent.status } : null } });
      if (v.status === 'revoked') throw Object.assign(new HttpError(410, 'version_revoked', 'This version was revoked'), { extra: { reason: m.revocations.reasonFor(plugin.id, v.version) } });
      if (v.status === 'yanked' && !stmts.installRow.get(license.id, plugin.id, v.version)) throw Object.assign(new HttpError(410, 'version_yanked', 'This version was withdrawn'), { extra: { reason: v.yanked_reason } });
      if (!v.package_file || !fs.existsSync(v.package_file)) throw new HttpError(503, 'package_unavailable', 'The signed package is not available yet');
      if (input.host_api && !safeSatisfies(input.host_api, v.engines_whm)) throw Object.assign(new HttpError(422, 'incompatible_host', `${plugin.id}@${v.version} requires WHM ${v.engines_whm}`), { extra: { engines_whm: v.engines_whm } });
      const id = newId('dl', m.now());
      const exp = Math.floor(m.now() / 1000) + cfg.download_url_ttl_s;
      stmts.insert.run({ id, version_id: v.id, license_id: license.id, activation_id: activation.id, ip_hash: m.hashIp(ip), panel_version: input.panel_version || null, ts: m.nowIso(), expires_at: new Date(exp * 1000).toISOString(), result: 'issued' });
      m.audit({ principal: `activation:${activation.id}`, role: 'panel', ip, action: 'download.issue', target: `${plugin.id}@${v.version}`, args: { license_id: license.id, kid: v.mkt_kid }, result: 'ok' });
      ctx.metrics?.inc('market_signed_downloads_total');
      return {
        url: `${ctx.config.public_url}/v1/market/packages/${id}?exp=${exp}&sig=${sigOf(id, activation.id, exp)}`,
        sha256: v.package_sha256, bytes: v.package_bytes, kid: v.mkt_kid, version: v.version, plugin_id: plugin.id, expires_at: new Date(exp * 1000).toISOString(),
        entitlement: { kind: ent.kind, status: ent.status },
      };
    },
    // Serves the current signed package once per dl_ id, bound to the activation.
    serve(dlId, { exp, sig }, { ip } = {}) {
      const row = stmts.byId.get(dlId);
      const expN = Number(exp);
      if (!row || !Number.isInteger(expN)) throw new HttpError(403, 'download_signature_invalid', 'Unknown download');
      const expected = sigOf(dlId, row.activation_id, expN);
      if (typeof sig !== 'string' || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) || new Date(row.expires_at).getTime() !== expN * 1000) throw new HttpError(403, 'download_signature_invalid', 'The download URL signature is invalid');
      if (expN * 1000 < m.now()) throw new HttpError(410, 'download_expired', 'The download URL has expired');
      const activation = ctx.activations.find(row.activation_id);
      const license = ctx.licenses.getRaw(row.license_id) ? ctx.licenses.get(row.license_id) : null;
      if (!activation || activation.status !== 'active' || !license || !['active', 'grace'].includes(ctx.licenses.statusAt(license))) throw new HttpError(403, 'activation_inactive', 'The activation or license is no longer active');
      if (!stmts.consume.run(m.nowIso(), dlId).changes) throw new HttpError(410, 'download_consumed', 'This download URL was already used');
      const v = m.submissions.versionById(row.version_id);
      if (!v.package_file || !fs.existsSync(v.package_file)) throw new HttpError(503, 'package_unavailable', 'The package file is missing');
      m.audit({ principal: `activation:${row.activation_id}`, role: 'panel', ip, action: 'download.fetch', target: `${v.plugin_id}@${v.version}`, args: { dl: dlId }, result: 'ok' });
      return { file: v.package_file, sha256: v.package_sha256, bytes: v.package_bytes, name: `${v.plugin_id}-${v.version}.whmplugin` };
    },
    // Update feed: `latest` never lower than `current`; unknown ids answered too.
    updates({ token, installed, host, channel }, { ip } = {}) {
      const { activation } = resolvePanel({ token });
      m.limits.assert(`updates:${activation.id}`, cfg.rate_limits.feed.max, cfg.rate_limits.feed.windowMs, 'Update feed limit reached for this activation');
      const out = [];
      for (const inst of installed) {
        const plugin = db.prepare('SELECT * FROM plugins WHERE id = ?').get(inst.id);
        const candidates = plugin ? db.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? AND status = 'published'").all(plugin.id).filter((v) => (channel === 'beta' || v.channel === 'stable') && (!host || safeSatisfies(host, v.engines_whm))) : [];
        const best = candidates.sort((a, b) => pkg.semver.compare(b.version, a.version))[0];
        const latest = best && pkg.semver.valid(inst.version) && pkg.semver.compare(best.version, inst.version) > 0 ? best.version : inst.version;
        const security = !!db.prepare('SELECT 1 FROM revocations WHERE plugin_id = ? AND (version IS NULL OR version = ?)').get(inst.id, inst.version);
        out.push({ id: inst.id, current: inst.version, latest, channel: best?.channel || channel || 'stable', security, changelog_url: plugin ? `${ctx.config.public_url}/v1/market/plugins/${plugin.id}/versions` : null, known: !!plugin });
      }
      m.audit({ principal: `activation:${activation.id}`, role: 'panel', ip, action: 'updates.poll', target: null, args: { installed: installed.length }, result: 'ok' });
      return out;
    },
    purge() {
      return { purged: stmts.purge.run(m.nowIso(m.now() - 86_400_000), m.nowIso(m.now() - 86_400_000)).changes };
    },
  };
  function safeSatisfies(host, range) { try { return pkg.semver.satisfies(host, range); } catch { return false; } }
  return svc;
}
