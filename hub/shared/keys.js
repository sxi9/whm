import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.js';
import { canonicalize } from './canonical.js';

export const PURPOSES = ['license', 'plugin'];
export const STATUSES = ['pending', 'active', 'retiring', 'retired'];
const DEFAULT_ENCODING = { license: 'base64url', plugin: 'base64' };
const ENCODING_RE = { base64url: /^[A-Za-z0-9_-]+$/, base64: /^[A-Za-z0-9+/]+={0,2}$/ };

function toPublicKey(key) {
  if (typeof key === 'string' || Buffer.isBuffer(key)) return crypto.createPublicKey(key);
  return key.type === 'private' ? crypto.createPublicKey(key) : key;
}

// kid = first 8 hex characters of sha256(raw 32-byte public key). The raw key
// is the last 32 bytes of the SPKI DER encoding of an Ed25519 public key.
export function kidOf(publicKey) {
  const key = toPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('kidOf: not an Ed25519 key');
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der.subarray(der.length - 32)).digest('hex').slice(0, 8);
}

export function parseSignatureHeader(header) {
  const m = /^kid=([0-9a-f]{8}),sig=([A-Za-z0-9_-]+)$/.exec(String(header || '').trim());
  return m ? { kid: m[1], sig: m[2] } : null;
}

// loadSigningKeys(dir, db, { activeKids }) -> the key ring. Rows live in
// signing_keys (license.db); private keys are <dir>/<kid>.ed25519 PEM files
// and never leave this module. `activeKids` (hub.conf keys.active_kid) only
// promotes a pending key when the database has no active key of that purpose;
// afterwards the database status is the source of truth.
export function loadSigningKeys(dir, db, { activeKids = {}, logger, now = () => Date.now() } = {}) {
  const stmts = {
    all: db.prepare('SELECT * FROM signing_keys ORDER BY created_at, kid'),
    insert: db.prepare(`INSERT INTO signing_keys (kid, purpose, public_key, created_at, activated_at, status)
      VALUES (@kid, @purpose, @public_key, @created_at, @activated_at, @status)`),
    setStatus: db.prepare('UPDATE signing_keys SET status = @status, activated_at = COALESCE(@activated_at, activated_at), retired_at = COALESCE(@retired_at, retired_at) WHERE kid = @kid'),
  };
  let ring = new Map();
  let activeByPurpose = {};

  function loadPrivate(kid, publicPem) {
    const file = path.join(dir, `${kid}.ed25519`);
    if (!fs.existsSync(file)) return null;
    try {
      const priv = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
      if (priv.asymmetricKeyType !== 'ed25519' || kidOf(priv) !== kid) {
        logger?.warn({ kid, file }, 'signing key file does not match its database row; ignoring');
        return null;
      }
      const derivedPub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
      if (crypto.createPublicKey(publicPem).export({ type: 'spki', format: 'pem' }) !== derivedPub) {
        logger?.warn({ kid, file }, 'signing key file public half differs from the database row; ignoring');
        return null;
      }
      return priv;
    } catch (err) {
      logger?.warn({ kid, err }, 'unreadable signing key file; ignoring');
      return null;
    }
  }

  function reload() {
    const next = new Map();
    for (const row of stmts.all.all()) {
      let publicKey;
      try { publicKey = crypto.createPublicKey(row.public_key); } catch { logger?.warn({ kid: row.kid }, 'signing_keys row has an invalid public key'); continue; }
      next.set(row.kid, {
        kid: row.kid, purpose: row.purpose, status: row.status,
        createdAt: row.created_at, activatedAt: row.activated_at, retiredAt: row.retired_at,
        publicKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
        privateKey: loadPrivate(row.kid, row.public_key),
      });
    }
    ring = next;
    activeByPurpose = {};
    for (const purpose of PURPOSES) {
      const actives = [...ring.values()].filter((k) => k.purpose === purpose && k.status === 'active');
      const wanted = activeKids?.[purpose] || null;
      let chosen = actives.find((k) => k.kid === wanted) || actives.sort((a, b) => String(b.activatedAt).localeCompare(String(a.activatedAt)))[0] || null;
      if (!chosen && wanted && ring.get(wanted)?.purpose === purpose && ring.get(wanted).status === 'pending') {
        const at = new Date(now()).toISOString();
        stmts.setStatus.run({ kid: wanted, status: 'active', activated_at: at, retired_at: null });
        chosen = ring.get(wanted);
        chosen.status = 'active';
        chosen.activatedAt = at;
        logger?.info({ kid: wanted, purpose }, 'activated signing key named by keys.active_kid');
      } else if (wanted && chosen && chosen.kid !== wanted) {
        logger?.warn({ purpose, configured: wanted, active: chosen.kid }, 'keys.active_kid differs from the database; the database wins');
      }
      activeByPurpose[purpose] = chosen;
    }
  }

  function requirePurpose(purpose) {
    if (!PURPOSES.includes(purpose)) throw new HttpError(500, 'invalid_key_purpose', `Unknown key purpose "${purpose}"`);
  }

  function entry(kid) {
    return ring.get(kid) || null;
  }

  function publicView(k) {
    return { kid: k.kid, purpose: k.purpose, status: k.status, pub: k.publicPem, created_at: k.createdAt, activated_at: k.activatedAt, retired_at: k.retiredAt, has_private_key: !!k.privateKey };
  }

  const api = {
    dir,
    reload,
    active(purpose) {
      requirePurpose(purpose);
      const k = activeByPurpose[purpose];
      return k ? { kid: k.kid, purpose: k.purpose, privateKey: k.privateKey, publicPem: k.publicPem, status: k.status } : null;
    },
    byKid(kid) {
      const k = entry(kid);
      return k ? publicView(k) : null;
    },
    list(purpose) {
      return [...ring.values()].filter((k) => !purpose || k.purpose === purpose).map(publicView);
    },
    // Retired keys are never published: panels drop them and nothing may verify with them.
    listPublic(purpose) {
      requirePurpose(purpose);
      return [...ring.values()].filter((k) => k.purpose === purpose && k.status !== 'retired').map((k) => ({ kid: k.kid, pub: k.publicPem, status: k.status }));
    },
    sign(bytes, { kid, purpose, encoding } = {}) {
      requirePurpose(purpose);
      const k = kid ? entry(kid) : activeByPurpose[purpose];
      if (!k) throw new HttpError(500, kid ? 'unknown_kid' : 'no_active_key', kid ? `No signing key "${kid}"` : `No active ${purpose} signing key`);
      if (k.purpose !== purpose) throw new HttpError(500, 'key_purpose_mismatch', `Key "${k.kid}" is a ${k.purpose} key and cannot sign for purpose "${purpose}"`);
      if (k.status === 'retired') throw new HttpError(500, 'key_retired', `Key "${k.kid}" is retired`);
      if (!k.privateKey) throw new HttpError(500, 'key_unavailable', `Private key for "${k.kid}" is not loadable`);
      const enc = encoding || DEFAULT_ENCODING[purpose];
      if (!ENCODING_RE[enc]) throw new HttpError(500, 'invalid_encoding', `Unknown signature encoding "${enc}"`);
      return crypto.sign(null, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), k.privateKey).toString(enc);
    },
    verify(bytes, sig, { kid, purpose, encoding } = {}) {
      requirePurpose(purpose);
      const k = entry(kid);
      if (!k || k.purpose !== purpose || k.status === 'retired') return false;
      const enc = encoding || DEFAULT_ENCODING[purpose];
      if (typeof sig !== 'string' || !ENCODING_RE[enc]?.test(sig)) return false;
      try {
        return crypto.verify(null, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), k.publicKey, Buffer.from(sig, enc));
      } catch {
        return false;
      }
    },
    // Every hub response the panel acts on carries X-WHM-Signature over the
    // canonical body, signed with the active license key.
    signResponse(res, body) {
      const k = activeByPurpose.license;
      if (!k) throw new HttpError(503, 'no_active_key', 'No active license signing key');
      const sig = api.sign(canonicalize(body), { kid: k.kid, purpose: 'license', encoding: 'base64url' });
      res.set('X-WHM-Signature', `kid=${k.kid},sig=${sig}`);
      return body;
    },
    // Creates a key pair on disk (0600) and its pending row. Used by gen-key.js
    // and POST /v1/admin/signing-keys; activation is a separate, audited step.
    generate(purpose, { status = 'pending', activate = false } = {}) {
      requirePurpose(purpose);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const kid = kidOf(publicKey);
      const file = path.join(dir, `${kid}.ed25519`);
      fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
      const pub = publicKey.export({ type: 'spki', format: 'pem' });
      const at = new Date(now()).toISOString();
      stmts.insert.run({ kid, purpose, public_key: pub, created_at: at, activated_at: activate ? at : null, status: activate ? 'active' : status });
      reload();
      return { kid, pub, purpose, status: activate ? 'active' : status };
    },
    // Registers an existing public key row (tests, imports of pre-generated
    // key files). The private half must already sit in `dir` to be usable.
    register({ kid, purpose, publicPem, status = 'pending', activatedAt = null }) {
      requirePurpose(purpose);
      const derived = kidOf(publicPem);
      if (kid && kid !== derived) throw new HttpError(422, 'kid_mismatch', `kid "${kid}" does not match the public key (${derived})`);
      stmts.insert.run({ kid: derived, purpose, public_key: publicPem, created_at: new Date(now()).toISOString(), activated_at: activatedAt, status });
      reload();
      return api.byKid(derived);
    },
    setStatus(kid, status, { activatedAt = null, retiredAt = null } = {}) {
      if (!STATUSES.includes(status)) throw new HttpError(422, 'invalid_status', `Unknown key status "${status}"`);
      stmts.setStatus.run({ kid, status, activated_at: activatedAt, retired_at: retiredAt });
      reload();
    },
  };
  reload();
  return api;
}
