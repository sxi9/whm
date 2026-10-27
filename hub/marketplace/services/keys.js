import crypto from 'node:crypto';
import { HttpError, notFound } from '../../shared/errors.js';
import { newId } from '../../shared/db.js';
import { kidOf } from '../lib/package.js';

const CHALLENGE_TTL_MS = 10 * 60_000;

// Developer Ed25519 signing keys with proof of possession (§18.2 step 3).
// kid = first 8 hex of sha256(raw public key); unique across developer_keys
// and absent from signing_keys (ctx.keys.byKid) → 409 kid_conflict otherwise.
export function createDevKeysService(m) {
  const { ctx, db } = m;
  const stmts = {
    insertChallenge: db.prepare('INSERT INTO developer_key_challenges (challenge, developer_id, expires_at) VALUES (?, ?, ?)'),
    challenge: db.prepare('SELECT * FROM developer_key_challenges WHERE challenge = ?'),
    deleteChallenge: db.prepare('DELETE FROM developer_key_challenges WHERE challenge = ?'),
    pruneChallenges: db.prepare('DELETE FROM developer_key_challenges WHERE expires_at < ?'),
    byKid: db.prepare('SELECT * FROM developer_keys WHERE kid = ?'),
    insert: db.prepare("INSERT INTO developer_keys (id, developer_id, kid, public_key_pem, label, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)"),
    list: db.prepare('SELECT id, kid, label, status, created_at, revoked_at, revoked_reason FROM developer_keys WHERE developer_id = ? ORDER BY created_at'),
    active: db.prepare("SELECT * FROM developer_keys WHERE developer_id = ? AND kid = ? AND status = 'active'"),
    revoke: db.prepare("UPDATE developer_keys SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE developer_id = ? AND kid = ? AND status = 'active'"),
  };

  function parsePublicKey(pem) {
    let key;
    try { key = crypto.createPublicKey(String(pem)); } catch { throw new HttpError(422, 'invalid_public_key', 'public_key_pem must be a PEM SPKI public key'); }
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new HttpError(422, 'invalid_public_key', 'Only Ed25519 public keys are accepted');
    return key;
  }

  return {
    list: (developerId) => stmts.list.all(developerId),
    challenge(developer) {
      stmts.pruneChallenges.run(m.nowIso());
      const challenge = crypto.randomBytes(32).toString('base64url');
      stmts.insertChallenge.run(challenge, developer.id, m.nowIso(m.now() + CHALLENGE_TTL_MS));
      return { challenge, expires_in_s: CHALLENGE_TTL_MS / 1000, instructions: 'Sign the raw challenge bytes (base64url-decoded) with the private key and post { public_key_pem, label, sig } (standard base64) to /v1/dev/keys/<challenge>' };
    },
    register(developer, challenge, { public_key_pem, label, sig }, { ip } = {}) {
      const row = stmts.challenge.get(challenge);
      if (!row || row.developer_id !== developer.id || new Date(row.expires_at).getTime() < m.now()) throw new HttpError(404, 'challenge_invalid', 'Unknown or expired challenge');
      const key = parsePublicKey(public_key_pem);
      let ok = false;
      try { ok = crypto.verify(null, Buffer.from(challenge, 'base64url'), key, Buffer.from(sig, 'base64')); } catch { ok = false; }
      if (!ok) throw new HttpError(422, 'challenge_signature_invalid', 'The signature does not prove possession of the private key');
      const pem = key.export({ type: 'spki', format: 'pem' });
      const kid = kidOf(pem);
      if (stmts.byKid.get(kid) || ctx.keys.byKid(kid)) throw new HttpError(409, 'kid_conflict', `Key id "${kid}" is already registered`);
      const id = newId('dkey', m.now());
      stmts.insert.run(id, developer.id, kid, pem, label || null, m.nowIso());
      stmts.deleteChallenge.run(challenge);
      m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'developer.key.add', target: kid, args: { label }, result: 'ok' });
      m.mail(developer.email, 'dev.key_added', { display_name: developer.display_name, kid, label });
      return { id, kid, label: label || null, status: 'active' };
    },
    revoke(developer, kid, { reason, ip } = {}) {
      if (!stmts.revoke.run(m.nowIso(), reason || null, developer.id, kid).changes) throw notFound('Signing key');
      m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'developer.key.revoke', target: kid, args: { reason }, result: 'ok' });
      m.mail(developer.email, 'dev.key_revoked', { display_name: developer.display_name, kid, reason });
      if (/compromis/i.test(reason || '')) m.developers.triggerReverification(developer.id, 'key_compromised', { by: `developer:${developer.id}`, ip });
      return { revoked: true };
    },
    // Every verify is scoped by (developer_id, kid, status = 'active').
    activeKey: (developerId, kid) => stmts.active.get(developerId, kid) || null,
    find: (kid) => stmts.byKid.get(kid) || null,
  };
}
