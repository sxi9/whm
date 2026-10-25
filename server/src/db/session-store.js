import session from 'express-session';

// express-session store backed by the panel's own SQLite database, so sessions
// survive restarts without a separate daemon.
export class SqliteSessionStore extends session.Store {
  constructor(db, { ttlMs, pruneIntervalMs = 10 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(`INSERT INTO sessions (sid, user_id, data, expires_at) VALUES (@sid, @userId, @data, @expiresAt)
        ON CONFLICT (sid) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, expires_at = excluded.expires_at`),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      destroyUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
      length: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at >= ?'),
      clear: db.prepare('DELETE FROM sessions'),
    };
    this.timer = setInterval(() => this.prune(), pruneIntervalMs);
    this.timer.unref();
  }

  expiry(sess) {
    const cookieExpiry = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
    return cookieExpiry || Date.now() + (this.ttlMs || 24 * 60 * 60 * 1000);
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid);
      if (!row || row.expires_at < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      this.stmts.set.run({ sid, userId: sess.userId ?? null, data: JSON.stringify(sess), expiresAt: this.expiry(sess) });
      cb?.(null);
    } catch (err) { cb?.(err); }
  }

  touch(sid, sess, cb) {
    try { this.stmts.touch.run(this.expiry(sess), sid); cb?.(null); } catch (err) { cb?.(err); }
  }

  destroy(sid, cb) {
    try { this.stmts.destroy.run(sid); cb?.(null); } catch (err) { cb?.(err); }
  }

  // Used when a password changes or an account is suspended: log out everywhere.
  destroyUserSessions(userId) {
    this.stmts.destroyUser.run(userId);
  }

  length(cb) {
    try { cb(null, this.stmts.length.get(Date.now()).n); } catch (err) { cb(err); }
  }

  clear(cb) {
    try { this.stmts.clear.run(); cb?.(null); } catch (err) { cb?.(err); }
  }

  prune() {
    try { this.stmts.prune.run(Date.now()); } catch { /* best effort */ }
  }

  close() {
    clearInterval(this.timer);
  }
}
