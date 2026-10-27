import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../../shared/errors.js';
import { json } from '../../shared/db.js';
import * as pkg from '../lib/package.js';

// Writes SIGNATURE.json = { kid, alg: 'ed25519', sig } over the host digest
// (everything except SIGNATURE.json, so DEV-SIGNATURE.json is covered) with
// the active plugin key, standard base64 with padding, and repacks the
// wrapper-stripped root deterministically. Re-signs every served version on
// key rotation (§18.9) and guards retirement while a key is referenced.
export function createSigningService(m) {
  const { ctx, db, cfg } = m;
  const stmts = {
    update: db.prepare('UPDATE plugin_versions SET package_sha256 = @sha, package_file = @file, package_bytes = @bytes, mkt_kid = @kid, mkt_signature = @sig, signed_at = @at WHERE id = @id'),
    history: db.prepare('INSERT OR REPLACE INTO plugin_version_signatures (version_id, mkt_kid, mkt_signature, package_sha256, file, signed_at) VALUES (?, ?, ?, ?, ?, ?)'),
    referenced: db.prepare('SELECT COUNT(*) AS n FROM plugin_versions WHERE mkt_kid = ?'),
    toResign: db.prepare("SELECT id FROM plugin_versions WHERE status IN ('approved', 'published', 'yanked') AND (mkt_kid IS NULL OR mkt_kid != ?) ORDER BY created_at"),
  };

  function signVersion(versionId, { by = 'system', kid = null } = {}) {
    const v = m.submissions.versionById(versionId);
    const active = ctx.keys.active('plugin');
    const useKid = kid || active?.kid;
    if (!useKid) throw new HttpError(503, 'no_active_key', 'No active plugin signing key');
    const keyRow = ctx.keys.byKid(useKid);
    if (!keyRow || keyRow.purpose !== 'plugin') throw new HttpError(500, 'key_purpose_mismatch', `Key "${useKid}" is not a plugin signing key`);
    const unpacked = pkg.unpack(fs.readFileSync(v.upload_file), { maxBytes: cfg.max_package_bytes });
    try {
      const root = pkg.stripWrapper(unpacked);
      fs.rmSync(path.join(root, pkg.SIGNATURE_FILE), { force: true });
      const digest = pkg.packageDigest(root);
      // Supply chain: the bytes being signed are the bytes that were scanned and reviewed.
      if (digest.toString('hex') !== v.package_digest) throw new HttpError(500, 'digest_mismatch', 'The stored upload no longer matches the reviewed digest');
      const sig = ctx.keys.sign(digest, { kid: useKid, purpose: 'plugin', encoding: 'base64' });
      pkg.writeSignature(root, pkg.SIGNATURE_FILE, { kid: useKid, sig });
      if (!pkg.verifyDigest(pkg.packageDigest(root), sig, keyRow.pub)) throw new HttpError(500, 'signature_invalid', 'The fresh signature does not verify with the committed host rule');
      const buf = pkg.repackDeterministic(root);
      const file = path.join(m.submissions.pluginDir(v.plugin_id), `${v.version}-${useKid}.whmplugin`);
      fs.writeFileSync(file, buf, { mode: 0o640 });
      const sha = pkg.sha256(buf);
      const at = m.nowIso();
      db.transaction(() => {
        stmts.update.run({ id: v.id, sha, file, bytes: buf.length, kid: useKid, sig, at });
        stmts.history.run(v.id, useKid, sig, sha, file, at);
      })();
      m.audit({ principal: by, role: 'vendor', ip: null, action: 'version.sign', target: `${v.plugin_id}@${v.version}`, args: { kid: useKid, sha256: sha, bytes: buf.length }, result: 'ok' });
      ctx.metrics?.inc('market_signed_packages_total');
      return { kid: useKid, sig, package_sha256: sha, package_bytes: buf.length, file };
    } finally {
      unpacked.cleanup();
    }
  }

  const svc = {
    signVersion,
    keyInUse: (kid) => stmts.referenced.get(kid).n,
    // keyActivated hook target: every approved/published/yanked version gets a
    // new SIGNATURE.json and file; the previous file stays for the installs history.
    resignAll(kid, { by = 'system' } = {}) {
      const ids = stmts.toResign.all(kid).map((r) => r.id);
      const state = { kid, total: ids.length, done: 0, failed: 0, started_at: m.nowIso(), finished_at: null, errors: [] };
      m.state.set(`resign:${kid}`, state);
      for (const id of ids) {
        try {
          const v = m.submissions.versionById(id);
          const previous = v.mkt_kid;
          const out = signVersion(id, { by, kid });
          m.webhook(m.submissions.get(v.plugin_id).developer_id, 'version.resigned', { plugin_id: v.plugin_id, version: v.version, kid, previous_kid: previous, package_sha256: out.package_sha256 });
          state.done++;
        } catch (err) {
          state.failed++;
          state.errors.push({ version_id: id, error: err.message });
          ctx.logger.error({ err, version: id }, 'resign failed');
        }
        m.state.set(`resign:${kid}`, state);
      }
      state.finished_at = m.nowIso();
      m.state.set(`resign:${kid}`, state);
      return state;
    },
    resignStatus() {
      const active = ctx.keys.active('plugin');
      const st = active ? m.state.get(`resign:${active.kid}`) : null;
      const backlog = active ? stmts.toResign.all(active.kid).length : 0;
      return { active_kid: active?.kid || null, backlog, last_run: st, keys_in_use: db.prepare('SELECT mkt_kid AS kid, COUNT(*) AS versions FROM plugin_versions WHERE mkt_kid IS NOT NULL GROUP BY mkt_kid').all() };
    },
    // beforeKeyRetire guard (§18.9): refused while any plugin_versions.mkt_kid references the key.
    guardRetire({ kid, purpose }) {
      if (purpose !== 'plugin') return;
      const n = svc.keyInUse(kid);
      if (n > 0) throw Object.assign(new Error(`${n} package version(s) are still signed with "${kid}"; run the re-sign job first`), { status: 409, code: 'key_in_use', extra: { versions: n } });
    },
    pluginSigningKeys: () => ctx.keys.listPublic('plugin'),
    signaturesOf: (versionId) => db.prepare('SELECT mkt_kid, package_sha256, file, signed_at FROM plugin_version_signatures WHERE version_id = ? ORDER BY signed_at').all(versionId).map((s) => ({ ...s, file: path.basename(s.file) })),
    manifestOf: (v) => json.parse(v.manifest_json, {}),
  };
  return svc;
}
