import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { HttpError } from '../lib/errors.js';
import { assertFeature } from '../routes/panel/index.js';
import { auditArgs } from './panel-domains.js';
import { panelApiAllowed } from '../middleware/shell.js';

// Terminal of the account panel (contract §68): the agent starts the account's
// login shell behind a unix socket (term.open, the shipped term-bridge.py run as
// the account); this process connects to that socket and relays bytes to the
// browser over a WebSocket. Opening a terminal is a session-only POST that mints
// a single-use token for the upgrade; the upgrade itself re-checks the session
// cookie, the user and the panel scope, so a token alone opens nothing.
//
//   panelTerminal.open / list / close           — the routes
//   panelTerminal.attachUpgrade(server)         — index.js, every listener
//   panelTerminal.handleUpgrade(req, socket, head)

export const FEATURE = 'terminal';
export const WS_PATH = '/api/panel/terminal/ws';
export const TOKEN_TTL_MS = 30_000;
export const FRAME_MAX = 8192;
export const FRAME_DATA = 0;
export const FRAME_RESIZE = 1;
export const SESSION_CHECK_MS = 15_000;
export const IDLE_MS = 15 * 60_000;
export const MAX_MS = 4 * 3600_000;
// The caps the relay enforces itself (the bridge keeps its own, but it runs as
// the account); mutable so tests can shrink them.
export const CAPS = { idleMs: IDLE_MS, maxMs: MAX_MS };
export const CLOSE_CODES = { unauthorized: 4401, forbidden: 4403, notFound: 4404, busy: 4409, ended: 4410, loggedOut: 4440 };
const SIZE = { cols: [20, 500], rows: [5, 200] };

// [type:1][length:2 BE][payload ≤ 8192], the bridge's framing; longer input is split.
export function encodeFrames(type, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  const frames = [];
  if (type === FRAME_RESIZE) {
    const header = Buffer.alloc(3);
    header[0] = type;
    header.writeUInt16BE(buf.length, 1);
    return [Buffer.concat([header, buf])];
  }
  for (let at = 0; at < buf.length; at += FRAME_MAX) {
    const chunk = buf.subarray(at, Math.min(buf.length, at + FRAME_MAX));
    const header = Buffer.alloc(3);
    header[0] = type;
    header.writeUInt16BE(chunk.length, 1);
    frames.push(Buffer.concat([header, chunk]));
  }
  return frames;
}

export function resizeFrame(cols, rows) {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(cols, 0);
  payload.writeUInt16BE(rows, 2);
  return encodeFrames(FRAME_RESIZE, payload)[0];
}

export const clampSize = (v, [min, max], fallback) => {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

// express-session's cookie: "s:<sid>.<base64 hmac-sha256>", any of the configured secrets.
export function unsignSessionCookie(raw, secrets) {
  if (typeof raw !== 'string' || !raw.startsWith('s:')) return null;
  const signed = raw.slice(2);
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const sid = signed.slice(0, dot);
  const mac = signed.slice(dot + 1);
  for (const secret of [].concat(secrets).filter((s) => typeof s === 'string' && s)) {
    const expected = crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '');
    const a = Buffer.from(expected);
    const b = Buffer.from(mac);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return sid;
  }
  return null;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

// A browser upgrade must come from this panel's own origin: the Origin header
// (always sent by browsers on WebSocket upgrades) must name the Host.
export function sameOrigin(origin, host) {
  if (!origin || !host) return false;
  try { return new URL(origin).host.toLowerCase() === String(host).toLowerCase(); } catch { return false; }
}

export function createPanelTerminalService(ctx) {
  const { db, logger } = ctx;
  const sessions = new Map();
  const tokens = new Map();
  const userById = db.prepare('SELECT id, username, email, role, totp_enabled, must_change_password, suspended FROM users WHERE id = ?');
  const op = (name, args, req) => ctx.agent.op(name, args, { req });
  const audit = (req, scope, action, args = {}) => {
    const entry = { action, target: scope.username, args: auditArgs(scope, args) };
    if (req?.audit) req.audit(entry); else ctx.auditRecord?.(req ?? null, entry);
  };

  function gate(scope) {
    if (!scope?.username || !scope.accountId) throw new HttpError(403, 'panel_scope_required', 'No hosting account is bound to this session');
    assertFeature(scope, FEATURE);
    if (!scope.account?.plan?.has_shell) throw new HttpError(501, 'shell_disabled', 'Shell access is not included in your hosting plan, so the terminal cannot be opened');
    const home = scope.account?.home_dir;
    if (!home || !path.isAbsolute(home)) throw new HttpError(409, 'no_home', 'This account has no home directory on the server yet');
  }

  const shape = (s) => ({ id: s.id, startedAt: s.startedAt, cols: s.cols, rows: s.rows, connected: Boolean(s.ws), pid: s.pid });
  const ownSession = (scope, id) => {
    const s = sessions.get(id);
    if (!s || s.accountId !== scope.accountId) throw new HttpError(404, 'not_found', 'Terminal session not found');
    return s;
  };

  function pruneTokens(now = Date.now()) {
    for (const [hash, t] of tokens) if (t.expiresAt <= now) tokens.delete(hash);
  }

  async function open(scope, body, req) {
    gate(scope);
    const cols = clampSize(body?.cols, SIZE.cols, 120);
    const rows = clampSize(body?.rows, SIZE.rows, 32);
    let r;
    try {
      r = await op('term.open', { username: scope.username, cols, rows }, req);
    } catch (err) {
      // The plan grants shell but /etc/passwd still says nologin: the host is behind the plan, which is a 501 for the customer too.
      if (err?.agentError && err.code === 'shell_disabled') throw new HttpError(501, 'shell_disabled', 'Shell access is not enabled for this account on the server yet');
      throw err;
    }
    const s = { id: r.id, accountId: scope.accountId, username: scope.username, userId: scope.actor?.id ?? req?.user?.id ?? null, socket: r.socket, pid: r.pid ?? null, startedAt: r.startedAt || new Date().toISOString(), cols, rows, ws: null, actingBy: scope.mode === 'acting' ? scope.actingAs?.by ?? null : null };
    sessions.set(s.id, s);
    const wsToken = crypto.randomBytes(32).toString('base64url');
    pruneTokens();
    tokens.set(ctx.crypto.hashToken(wsToken), { id: s.id, userId: s.userId, expiresAt: Date.now() + TOKEN_TTL_MS });
    audit(req, scope, 'panel.terminal.open', { id: s.id, cols, rows });
    return { id: s.id, wsToken, expiresInSeconds: TOKEN_TTL_MS / 1000, cols, rows, startedAt: s.startedAt };
  }

  async function list(scope, req) {
    gate(scope);
    let live = null;
    try { live = new Set((await op('term.list', { username: scope.username }, req)).map((t) => t.id)); } catch (err) {
      if (!(err?.agentError && ['capability_missing', 'agent_unavailable'].includes(err.code))) throw err;
    }
    const out = [];
    for (const s of sessions.values()) {
      if (s.accountId !== scope.accountId) continue;
      if (live && !live.has(s.id)) { end(s, 'ended', CLOSE_CODES.ended); continue; }
      out.push(shape(s));
    }
    return out;
  }

  async function close(scope, id, req) {
    gate(scope);
    const s = ownSession(scope, id);
    await op('term.close', { id: s.id }, req);
    end(s, 'closed', CLOSE_CODES.ended, { req, scope });
    return { id: s.id, closed: true };
  }

  // Drops the session everywhere: the browser socket, the unix socket, the map;
  // one audit row per terminal whatever ends it.
  function end(s, reason, code = CLOSE_CODES.ended, { req = null, scope = null } = {}) {
    if (!sessions.delete(s.id)) return;
    try { s.ws?.close(code, reason); } catch { /* already closed */ }
    try { s.unix?.destroy(); } catch { /* already closed */ }
    clearInterval(s.checker);
    clearTimeout(s.hardTimer);
    clearTimeout(s.idleTimer);
    const entry = { action: 'panel.terminal.close', target: s.username, args: scope ? auditArgs(scope, { id: s.id, reason }) : { id: s.id, reason, ...(s.actingBy ? { actingAs: s.username, by: s.actingBy } : {}) } };
    if (req?.audit) req.audit(entry); else ctx.auditRecord?.(req ?? null, entry);
  }

  // Closes the terminals of a user whose panel session went away (logout,
  // suspension, expiry): every relay re-reads the session store on a timer.
  function sessionStillValid(s) {
    if (!s.sid || !ctx.sessionStore) return Promise.resolve(true);
    return new Promise((resolve) => ctx.sessionStore.get(s.sid, (err, sess) => resolve(!err && Boolean(sess) && sess.userId === s.userId)));
  }

  // The agent only hands over a socket it verified, but the path is also checked
  // here right before connecting: never a file, a pipe or a link to another socket.
  function isUnixSocket(p) {
    if (process.platform === 'win32') return true;
    try { return fs.lstatSync(p).isSocket(); } catch { return false; }
  }

  // The idle and hard caps are enforced here as well as in the bridge, which
  // runs as the account and can be stopped by it.
  function capBy(s, reason) {
    op('term.close', { id: s.id }).catch(() => {});
    end(s, reason, CLOSE_CODES.ended);
  }
  function touch(s) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => capBy(s, 'idle'), CAPS.idleMs);
    s.idleTimer.unref?.();
  }

  function relay(ws, s) {
    s.ws = ws;
    if (!isUnixSocket(s.socket)) {
      logger.warn({ id: s.id, socket: s.socket }, 'terminal socket is not a unix socket');
      capBy(s, 'ended');
      return;
    }
    const unix = net.createConnection(s.socket);
    s.unix = unix;
    s.ws = ws;
    s.hardTimer = setTimeout(() => capBy(s, 'max'), Math.max(0, new Date(s.startedAt).getTime() + CAPS.maxMs - Date.now()));
    s.hardTimer.unref?.();
    touch(s);
    unix.on('connect', () => { try { ws.send(JSON.stringify({ type: 'ready', id: s.id, cols: s.cols, rows: s.rows })); } catch { /* closed */ } });
    unix.on('data', (buf) => { touch(s); if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true }); });
    unix.on('error', (err) => { logger.debug({ err, id: s.id }, 'terminal socket error'); end(s, 'ended', CLOSE_CODES.ended); });
    unix.on('close', () => end(s, 'ended', CLOSE_CODES.ended));
    ws.on('message', (data, isBinary) => {
      if (unix.destroyed) return;
      touch(s);
      if (isBinary) { for (const f of encodeFrames(FRAME_DATA, Buffer.isBuffer(data) ? data : Buffer.from(data))) unix.write(f); return; }
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch { msg = null; }
      if (msg?.type === 'resize') {
        s.cols = clampSize(msg.cols, SIZE.cols, s.cols);
        s.rows = clampSize(msg.rows, SIZE.rows, s.rows);
        unix.write(resizeFrame(s.cols, s.rows));
      } else if (msg?.type === 'input' && typeof msg.data === 'string') {
        for (const f of encodeFrames(FRAME_DATA, msg.data)) unix.write(f);
      }
    });
    ws.on('close', () => { if (sessions.has(s.id)) { s.ws = null; unix.destroy(); } });
    ws.on('error', () => { try { unix.destroy(); } catch { /* ignore */ } });
    s.checker = setInterval(() => check(s), SESSION_CHECK_MS);
    s.checker.unref?.();
  }

  async function check(s) {
    if (!sessions.has(s.id) || (await sessionStillValid(s))) return false;
    op('term.close', { id: s.id }).catch(() => {});
    end(s, 'logged_out', CLOSE_CODES.loggedOut);
    return true;
  }
  const checkSessions = () => Promise.all([...sessions.values()].map(check));

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

  const reject = (socket, status, text) => {
    try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    socket.destroy();
  };

  // Resolves the panel scope of the upgrade the way the API does: session
  // cookie → user (not suspended) → ctx.panel.scope on a request-shaped object.
  function principalOf(req) {
    const sid = unsignSessionCookie(parseCookies(req.headers.cookie)['whm.sid'], ctx.config.sessionSecret);
    if (!sid) return Promise.resolve(null);
    return new Promise((resolve) => ctx.sessionStore.get(sid, (err, sess) => {
      if (err || !sess?.userId) return resolve(null);
      const user = userById.get(sess.userId);
      if (!user || user.suspended) return resolve(null);
      resolve({ sid, sess, user });
    }));
  }

  async function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://panel');
    if (url.pathname !== WS_PATH) { reject(socket, 404, 'Not Found'); return; }
    if (!panelApiAllowed(url.pathname)) { reject(socket, 403, 'Forbidden'); return; }
    if (!sameOrigin(req.headers.origin, req.headers.host)) { reject(socket, 403, 'Forbidden'); return; }
    const principal = await principalOf(req).catch(() => null);
    if (!principal) { reject(socket, 401, 'Unauthorized'); return; }
    const token = url.searchParams.get('token') || '';
    pruneTokens();
    const hash = ctx.crypto.hashToken(token);
    const t = token ? tokens.get(hash) : null;
    if (t) tokens.delete(hash);
    if (!t || t.userId !== principal.user.id) { reject(socket, 403, 'Forbidden'); return; }
    const s = sessions.get(t.id);
    if (!s) { reject(socket, 404, 'Not Found'); return; }
    let scope;
    try { scope = ctx.panel.scope({ user: principal.user, session: principal.sess }); } catch { reject(socket, 403, 'Forbidden'); return; }
    if (scope.accountId !== s.accountId) { reject(socket, 403, 'Forbidden'); return; }
    if (s.ws) { reject(socket, 409, 'Conflict'); return; }
    s.sid = principal.sid;
    wss.handleUpgrade(req, socket, head, (ws) => relay(ws, s));
  }

  function attachUpgrade(server) {
    server.on('upgrade', (req, socket, head) => {
      handleUpgrade(req, socket, head).catch((err) => { logger.error({ err }, 'terminal upgrade failed'); reject(socket, 500, 'Internal Server Error'); });
    });
    return server;
  }

  // accounts.cleanupAccount hook and tests: drop every terminal of an account.
  function endAccountSessions(username, reason = 'account_removed') {
    const ended = [];
    for (const s of [...sessions.values()]) if (s.username === username) { op('term.close', { id: s.id }).catch(() => {}); end(s, reason); ended.push(s.id); }
    return ended.length ? { ended: ended.length } : null;
  }

  return { open, list, close, handleUpgrade, attachUpgrade, endAccountSessions, checkSessions, sessions, tokens };
}
