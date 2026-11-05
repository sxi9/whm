import { isIP } from 'node:net';
import { HttpError } from '../lib/errors.js';

// Customer panel single sign-on tokens (contract §44). The panel mints a
// short-lived, single-use token for a browser hand-off into a published
// application; the application's signon code (Roundcube plugin, phpMyAdmin
// signon script) exchanges it over loopback for the credential that kind's
// handler produces. Attached as ctx.panelSso:
//   panelSso.issue({ kind, userId, account, payload, ttlMs })  -> { token, expiresAt }
//   panelSso.redeem(kind, token)                               -> { id, userId, account, payload } once; 404 sso_token_invalid after
//   panelSso.register(kind, handler)                           -> handler(claim, req) builds the exchange answer
//   panelSso.exchange(kind, token, req)                        -> loopback-only wrapper: redeem + handler + audit
// Only sha256(token) is stored; the payload is encrypted with lib/crypto.js.

export const SSO_KINDS = ['webmail', 'phpmyadmin'];
export const SSO_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
export const SSO_TOKEN_TTL_MS = 60_000;
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLoopbackAddress = (a) => typeof a === 'string' && (LOOPBACK.has(a) || (isIP(a) === 4 && a.startsWith('127.')) || (a.startsWith('::ffff:127.')));

// The exchange is only ever made by a process on this host: both the TCP peer
// and the address Express derived (trust proxy = loopback honours
// X-Forwarded-For from a loopback peer, so a forwarded header refuses too).
export function isLoopbackRequest(req) {
  if (req.headers?.['x-forwarded-for'] || req.headers?.['forwarded'] || req.headers?.['x-real-ip']) return false;
  return isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackAddress(req.ip);
}

export function createPanelSsoService(ctx) {
  const { db, crypto, settings } = ctx;
  const handlers = new Map();
  const stmts = {
    insert: db.prepare('INSERT INTO panel_sso_tokens (user_id, account, kind, token_hash, payload_enc, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
    byHash: db.prepare('SELECT * FROM panel_sso_tokens WHERE token_hash = ? AND kind = ?'),
    burn: db.prepare('UPDATE panel_sso_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL'),
    purge: db.prepare('DELETE FROM panel_sso_tokens WHERE expires_at < ?'),
  };

  const invalid = () => new HttpError(404, 'sso_token_invalid', 'This sign-on link is invalid, already used or has expired');

  function purge() {
    stmts.purge.run(new Date(Date.now() - PURGE_AFTER_MS).toISOString());
  }

  function issue({ kind, userId = null, account, payload = null, ttlMs = SSO_TOKEN_TTL_MS }) {
    if (!SSO_KINDS.includes(kind)) throw new Error(`unknown sso kind ${kind}`);
    purge();
    const token = crypto.randomToken(32);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    stmts.insert.run(userId, account, kind, crypto.hashToken(token), payload == null ? null : crypto.encrypt(JSON.stringify(payload)), expiresAt);
    return { token, expiresAt };
  }

  // One UPDATE … WHERE used_at IS NULL is the single-use guarantee: two
  // concurrent exchanges can both read the row, only one burns it.
  function redeem(kind, token) {
    if (!SSO_KINDS.includes(kind) || !SSO_TOKEN_RE.test(String(token || ''))) throw invalid();
    const row = stmts.byHash.get(crypto.hashToken(token), kind);
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) throw invalid();
    if (stmts.burn.run(new Date().toISOString(), row.id).changes !== 1) throw invalid();
    let payload = null;
    if (row.payload_enc) { try { payload = JSON.parse(crypto.decrypt(row.payload_enc)); } catch { payload = null; } }
    return { id: row.id, userId: row.user_id, account: row.account, kind: row.kind, payload };
  }

  function register(kind, handler) {
    if (!SSO_KINDS.includes(kind)) throw new Error(`unknown sso kind ${kind}`);
    handlers.set(kind, handler);
  }

  async function exchange(kind, token, req) {
    if (!isLoopbackRequest(req)) throw new HttpError(403, 'loopback_only', 'The sign-on exchange is only available from this server');
    if (settings.get('panel.enabled') === false) throw new HttpError(403, 'panel_disabled', 'The account panel is disabled on this server');
    const handler = handlers.get(kind);
    if (!handler) throw invalid();
    const claim = redeem(kind, token);
    const result = await handler(claim, req);
    ctx.auditRecord?.(req, { action: 'panel.sso.exchange', target: claim.account, args: { kind, tokenId: claim.id, userId: claim.userId, ...(claim.payload && typeof claim.payload === 'object' ? { subject: claim.payload.mailbox ?? claim.payload.user ?? null } : {}) }, result: 'ok' });
    return result;
  }

  return { issue, redeem, register, exchange, purge, kinds: SSO_KINDS, isLoopbackRequest };
}
