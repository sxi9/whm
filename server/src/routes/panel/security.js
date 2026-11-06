import crypto from 'node:crypto';
import path from 'node:path';
import { validate, z, fields } from '../../lib/validate.js';
import { panelRouter, wrap, created, assertFeature } from './index.js';
import { HttpError, notFound, conflict, unprocessable, forbidden } from '../../lib/errors.js';
import { createPanelHtaccessService, ipOrCidr } from '../../services/panel-htaccess.js';

// /api/panel/security — mounted by routes/categories/panel.js behind panelScope.
// The password and session flows are the core panel service's (§2.2,
// ctx.panel.changePassword / reestablish / sessions); this module adds the
// 2FA proxies onto ctx.auth and the SSH-key editor on top of the files ops.
// API tokens live at /api/panel/tokens in the core entry.

export const SSH_KEY = /^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]{1,16384}( [^\n\r]{0,255})?$/;
export const MAX_SSH_KEYS = 50;
const KEY_TYPE = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export function fingerprintOf(b64) {
  const raw = Buffer.from(b64, 'base64');
  const digest = crypto.createHash('sha256').update(raw).digest();
  return { id: digest.toString('hex'), fingerprint: `SHA256:${digest.toString('base64').replace(/=+$/, '')}`, bits: raw.length * 8 };
}

// Parses authorized_keys into entries; lines that are not keys (comments,
// unknown formats) are kept verbatim so a rewrite never drops them.
export function parseAuthorizedKeys(text) {
  const entries = [];
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    if (line.trimStart().startsWith('#')) { entries.push({ raw: line, key: null }); continue; }
    const tokens = line.trim().split(/\s+/);
    const at = tokens.findIndex((t) => KEY_TYPE.test(t));
    if (at < 0 || !tokens[at + 1] || !/^[A-Za-z0-9+/=]+$/.test(tokens[at + 1])) { entries.push({ raw: line, key: null }); continue; }
    const { id, fingerprint, bits } = fingerprintOf(tokens[at + 1]);
    entries.push({ raw: line, key: { id, fingerprint, type: tokens[at], bits, comment: tokens.slice(at + 2).join(' '), options: tokens.slice(0, at).join(' ') } });
  }
  return entries;
}

export function createPanelSecurityService(ctx) {
  const { agent, settings } = ctx;

  const audit = (req, scope, action, args = {}) => {
    const entry = { action, target: scope.username, args: scope.mode === 'acting' ? { ...args, actingAs: scope.username, by: scope.actor?.username } : args };
    if (req?.audit) req.audit(entry); else ctx.auditRecord?.(req ?? null, entry);
  };
  const op = (name, args, req) => agent.op(name, args, { req });
  const require2fa = () => Boolean(settings.get('panel.require_2fa_for_users', false)) || Boolean(settings.get('security.2fa.required_for_users', false));

  function requireScopeShape(scope) {
    if (!scope?.username || !scope.accountId) throw new HttpError(403, 'panel_scope_required', 'No hosting account is bound to this session');
  }
  function refuseActing(scope) {
    requireScopeShape(scope);
    if (scope.mode === 'acting' || scope.actingAs) throw new HttpError(403, 'not_while_impersonating', 'This change can only be made by the account user, not while logged in as the account');
  }

  function sshGate(scope) {
    requireScopeShape(scope);
    assertFeature(scope, 'ssh');
    if (!scope.account?.plan?.has_shell) throw new HttpError(501, 'shell_disabled', 'This account has no shell access, so SSH keys cannot be used');
    const home = scope.account?.home_dir;
    if (!home || !path.isAbsolute(home)) throw new HttpError(409, 'no_home', 'This account has no home directory on the server yet');
    return { dir: path.join(path.resolve(home), '.ssh'), file: path.join(path.resolve(home), '.ssh', 'authorized_keys') };
  }

  async function readKeys(scope, req) {
    const { file } = sshGate(scope);
    try {
      const r = await op('files.read', { username: scope.username, path: file, maxBytes: 1024 * 1024 }, req);
      if (r.binary) throw new HttpError(422, 'binary', 'authorized_keys is not a text file');
      return parseAuthorizedKeys(r.content);
    } catch (err) {
      if (err?.agentError && err.code === 'not_found') return [];
      throw err;
    }
  }

  async function writeKeys(scope, entries, req) {
    const { dir, file } = sshGate(scope);
    const content = entries.map((e) => e.raw).join('\n') + (entries.length ? '\n' : '');
    await op('files.mkdir', { username: scope.username, path: dir, mode: '0700' }, req);
    await op('files.write', { username: scope.username, path: file, content, mode: '0600' }, req);
  }

  const shapeKey = (e) => ({ id: e.key.id, fingerprint: e.key.fingerprint, type: e.key.type, bits: e.key.bits, comment: e.key.comment, options: e.key.options });

  return {
    async changePassword(scope, body, req) {
      refuseActing(scope);
      assertFeature(scope, 'passwordchange');
      const r = await ctx.panel.changePassword(scope, body, req);
      const { csrfToken } = await ctx.panel.reestablish(req);
      return { ...r, csrfToken };
    },

    twoFactor(scope, req) {
      requireScopeShape(scope);
      return { enabled: Boolean(req.user.totp_enabled), required: require2fa(), pendingEnrollment: Boolean(req.session?.mustEnroll2fa) };
    },
    enroll2fa(scope, req) {
      refuseActing(scope);
      const r = ctx.auth.begin2faEnrollment(req.user.id);
      audit(req, scope, 'panel.2fa.enroll', {});
      return r;
    },
    confirm2fa(scope, { code }, req) {
      refuseActing(scope);
      ctx.auth.confirm2faEnrollment(req.user.id, code);
      if (req.session) req.session.mustEnroll2fa = false;
      audit(req, scope, 'panel.2fa.enable', {});
      return { enabled: true };
    },
    async disable2fa(scope, body, req) {
      refuseActing(scope);
      if (require2fa()) throw forbidden('Two-factor authentication is required for account users by the panel policy');
      await ctx.auth.disable2fa(req.user.id, body);
      audit(req, scope, 'panel.2fa.disable', { via: body.code ? 'code' : 'password' });
      return { enabled: false };
    },

    async listSshKeys(scope, req) {
      const entries = await readKeys(scope, req);
      return entries.filter((e) => e.key).map(shapeKey);
    },
    async addSshKey(scope, { key }, req) {
      refuseActing(scope);
      const line = key.trim();
      const [type, b64, ...rest] = line.split(/\s+/);
      const { id, fingerprint, bits } = fingerprintOf(b64);
      if (bits < 32) throw unprocessable('Request validation failed', { key: ['Not a valid public key'] });
      const entries = await readKeys(scope, req);
      if (entries.some((e) => e.key?.id === id)) throw conflict('That key is already authorised');
      if (entries.filter((e) => e.key).length >= MAX_SSH_KEYS) throw conflict(`At most ${MAX_SSH_KEYS} keys can be authorised`);
      entries.push({ raw: line, key: { id, fingerprint, type, bits, comment: rest.join(' '), options: '' } });
      await writeKeys(scope, entries, req);
      audit(req, scope, 'panel.ssh_key.add', { fingerprint, type, comment: rest.join(' ') });
      return shapeKey(entries.at(-1));
    },
    async removeSshKey(scope, id, req) {
      refuseActing(scope);
      const entries = await readKeys(scope, req);
      const victim = entries.find((e) => e.key?.id === id);
      if (!victim) throw notFound('SSH key');
      await writeKeys(scope, entries.filter((e) => e !== victim), req);
      audit(req, scope, 'panel.ssh_key.remove', { fingerprint: victim.key.fingerprint, type: victim.key.type });
      return { removed: true, fingerprint: victim.key.fingerprint };
    },

    listSessions(scope, req) {
      requireScopeShape(scope);
      return ctx.panel.sessions(scope, req);
    },
    async endSessions(scope, req) {
      refuseActing(scope);
      ctx.sessionStore.destroyUserSessions(req.user.id);
      const { csrfToken } = await ctx.panel.reestablish(req);
      audit(req, scope, 'panel.sessions.end', {});
      return { ended: true, csrfToken };
    },
  };
}

export async function register(ctx) {
  const svc = createPanelSecurityService(ctx);
  ctx.panelSecurity = svc;
  // Credentials are changed from a browser session only: an API token must
  // never be able to rotate the password or the second factor.
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'Log in to the panel to change security settings')) : next());
  const code = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

  const r = panelRouter(ctx, 'read');
  r.post('/password', sessionOnly, validate({ body: z.object({ currentPassword: z.string().min(1).max(256), newPassword: fields.password }).strict() }), wrap((req) => svc.changePassword(req.panel, req.body, req)));
  r.get('/two-factor', wrap((req) => svc.twoFactor(req.panel, req)));
  r.post('/two-factor/enroll', sessionOnly, wrap((req) => svc.enroll2fa(req.panel, req)));
  r.post('/two-factor/confirm', sessionOnly, validate({ body: z.object({ code }).strict() }), wrap((req) => svc.confirm2fa(req.panel, req.body, req)));
  r.post('/two-factor/disable', sessionOnly, validate({ body: z.object({ password: z.string().max(1024).optional(), code: code.optional() }).strict() }), wrap((req) => svc.disable2fa(req.panel, req.body, req)));
  r.get('/ssh-keys', wrap((req) => svc.listSshKeys(req.panel, req)));
  r.post('/ssh-keys', sessionOnly, validate({ body: z.object({ key: z.string().trim().regex(SSH_KEY, 'An OpenSSH public key line (ssh-ed25519, ssh-rsa or ecdsa-sha2-nistp*)') }).strict() }), created((req) => svc.addSshKey(req.panel, req.body, req)));
  r.delete('/ssh-keys/:fingerprint', sessionOnly, validate({ params: z.object({ fingerprint: z.string().regex(FINGERPRINT) }) }), wrap((req) => svc.removeSshKey(req.panel, req.params.fingerprint, req)));
  r.get('/sessions', wrap((req) => svc.listSessions(req.panel, req)));
  r.delete('/sessions', sessionOnly, wrap((req) => svc.endSessions(req.panel, req)));

  // IP blocker (feature ipblocker): "Require not ip" in the panel-managed block
  // of public_html/.htaccess (services/panel-htaccess.js).
  ctx.panelHtaccess ??= createPanelHtaccessService(ctx);
  const ht = ctx.panelHtaccess;
  const ipBody = z.object({ ip: ipOrCidr }).strict();
  r.get('/ip-blocker', wrap((req) => ht.ipBlocker.get(req.panel, req)));
  r.post('/ip-blocker', sessionOnly, validate({ body: ipBody }), created((req) => ht.ipBlocker.add(req.panel, req.body, req)));
  r.delete('/ip-blocker', sessionOnly, validate({ query: ipBody }), wrap((req) => ht.ipBlocker.remove(req.panel, req.query, req)));

  return { path: '/security', router: r };
}
