import { HttpError } from './errors.js';

// Replay cache for the panel's signed requests: a nonce is accepted once within
// the TTL window and a timestamp more than `maxSkewS` from the hub clock is
// refused so a captured request cannot be replayed later.
export function createNonceStore(db, { ttlS = 600, maxSkewS = 300, now = () => Date.now() } = {}) {
  const stmts = {
    insert: db.prepare('INSERT OR IGNORE INTO nonces (nonce, seen_at) VALUES (?, ?)'),
    prune: db.prepare('DELETE FROM nonces WHERE seen_at < ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM nonces'),
  };
  return {
    ttlS,
    maxSkewS,
    check(nonce, ts) {
      const nowS = Math.floor(now() / 1000);
      if (!Number.isInteger(ts) || Math.abs(nowS - ts) > maxSkewS) {
        throw new HttpError(400, 'clock_skew', `Request timestamp is more than ${maxSkewS} s away from the server clock`);
      }
      if (typeof nonce !== 'string' || nonce.length < 16) throw new HttpError(400, 'invalid_nonce', 'Missing or short nonce');
      const res = stmts.insert.run(nonce, nowS);
      if (res.changes === 0) throw new HttpError(409, 'nonce_replay', 'This nonce was already used');
      return true;
    },
    prune() {
      return stmts.prune.run(Math.floor(now() / 1000) - ttlS).changes;
    },
    size: () => stmts.count.get().n,
  };
}
