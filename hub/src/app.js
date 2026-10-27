import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { attachPrincipal, portalSession, csrf } from '../shared/auth.js';
import { createAudit } from '../shared/audit.js';
import { HttpError } from '../shared/errors.js';
import { ZodError } from 'zod';
import { publicRoutes } from '../license/routes/public.js';
import { resellerRoutes } from '../license/routes/reseller.js';
import { adminRoutes, billingWebhookRoutes, jobAliasRoutes } from '../license/routes/admin.js';
import { portalRoutes } from '../license/routes/portal.js';

function limiter({ max, windowMs }, { keyGenerator, message = 'Too many requests, slow down', skip, skipSuccessfulRequests = false } = {}) {
  return rateLimit({
    windowMs, limit: max, standardHeaders: 'draft-7', legacyHeaders: false, validate: false, keyGenerator, skip, skipSuccessfulRequests,
    handler: (_req, res) => res.status(429).json({ error: { code: 'rate_limited', message } }),
  });
}

const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const acceptedRequestId = (value) => (typeof value === 'string' && REQUEST_ID_RE.test(value) ? value : null);
// Portal routes that take a TOTP code from an already logged-in session: a
// hijacked session must not be able to walk the code space to step up,
// disable 2FA or change the password. Only wrong answers count.
export const TOTP_LIMITED_PATHS = ['/v1/portal/stepup', '/v1/portal/2fa', '/v1/portal/password'];

function keyPrefixOf(body) {
  const k = String(body?.key || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return k ? k.slice(0, 7) : '-';
}

// The per-activation check-in limit (rate_limits.checkin) is enforced inside
// activations.checkin() after the token verifies; only per-IP buckets live here.
export function buildLimiters(ctx) {
  const rl = ctx.config.license.rate_limits;
  return {
    activate: limiter(rl.activate, { keyGenerator: (req) => `${req.ip}|${keyPrefixOf(req.body)}` }),
    trial: limiter(rl.trial, { keyGenerator: (req) => req.ip }),
    recover: limiter(rl.recover, { keyGenerator: (req) => req.ip }),
    public: limiter(rl.public, { keyGenerator: (req) => req.ip }),
    reseller: limiter(rl.reseller, { keyGenerator: (req) => req.principal?.keyId || req.principal?.userId || req.ip }),
    admin: limiter(rl.admin, { keyGenerator: (req) => req.principal?.keyId || req.principal?.userId || req.ip }),
    portalLogin: limiter(rl.portal_login, { keyGenerator: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}` }),
    totp: limiter(rl.portal_login, { keyGenerator: (req) => (req.session?.userId ? `user|${req.session.userId}` : req.ip), skipSuccessfulRequests: true, message: 'Too many wrong codes, wait before trying again' }),
  };
}

// §16.6 signed route: POST bodies carry nonce + ts (echoed in X-WHM-Nonce /
// X-WHM-Timestamp), the nonce is single-use within the TTL, the timestamp
// within the skew, and every response — error or data — echoes the nonce in
// `meta` and carries X-WHM-Signature over its canonical body.
export function signedMiddleware(ctx) {
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const nonce = req.get('x-whm-nonce') || null;
    const originalJson = res.json.bind(res);
    // Fail closed: a body the hub cannot sign never leaves as an unsigned
    // 2xx/4xx. A non-canonical value (a float) becomes a signed 500 and is
    // logged with the route; a hub with no usable key (no_active_key) answers
    // that 5xx itself, unsigned, because nothing can be signed at all — the
    // panel rejects the unsigned answer as hub_signature_invalid (502) and,
    // like any transient hub error, backs off and keeps its last state.
    res.json = (payload) => {
      const out = { ...payload, meta: { ...(payload?.meta || {}), nonce } };
      try {
        ctx.keys.signResponse(res, out);
        return originalJson(out);
      } catch (err) {
        const route = `${req.method} ${req.originalUrl.split('?')[0]}`;
        ctx.logger.error({ err, requestId: req.id, route, status: res.statusCode }, 'cannot sign response');
        res.removeHeader('X-WHM-Signature');
        if (err instanceof HttpError && err.status >= 500) {
          res.status(err.status);
          return originalJson({ error: { code: err.code, message: err.message, requestId: req.id }, meta: { nonce } });
        }
        const failure = { error: { code: 'signing_failed', message: 'The hub could not sign its response', requestId: req.id }, meta: { nonce } };
        res.status(500);
        try { ctx.keys.signResponse(res, failure); } catch { res.removeHeader('X-WHM-Signature'); }
        return originalJson(failure);
      }
    };
    try {
      if (req.bodyError) throw req.bodyError;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const tsHeader = Number(req.get('x-whm-timestamp'));
      if (!nonce || body.nonce !== nonce) throw new HttpError(400, 'nonce_mismatch', 'X-WHM-Nonce must equal body.nonce');
      if (!NONCE_RE.test(nonce)) throw new HttpError(400, 'invalid_nonce', 'A nonce is 16 to 128 URL-safe characters');
      if (!Number.isInteger(tsHeader) || body.ts !== tsHeader) throw new HttpError(400, 'timestamp_mismatch', 'X-WHM-Timestamp must equal body.ts');
      ctx.nonce.check(nonce, tsHeader);
      req.whm = { nonce, ts: tsHeader };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof HttpError) {
      const body = { error: { code: err.code, message: err.message, ...(err.extra || {}) } };
      if (err.fields) body.error.fields = err.fields;
      if (err.retryAfterS) res.set('Retry-After', String(err.retryAfterS));
      return res.status(err.status).json(body);
    }
    // Hook-raised errors (e.g. a beforeKeyRetire guard) may be plain Errors carrying status + code.
    if (Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 && typeof err.code === 'string' && /^[a-z_]+$/.test(err.code)) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message || err.code, ...(err.extra || {}) } });
    }
    if (err instanceof ZodError) {
      const fields = {};
      for (const issue of err.issues) (fields[issue.path.join('.') || '_'] ||= []).push(issue.message);
      return res.status(422).json({ error: { code: 'validation_failed', message: 'Validation failed', fields } });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON' } });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request body too large' } });
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return res.status(409).json({ error: { code: 'conflict', message: 'A record with that identifier already exists' } });
    if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return res.status(409).json({ error: { code: 'conflict', message: 'The record is referenced by other data' } });
    logger.error({ err, requestId: req.id, path: req.originalUrl }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error', requestId: req.id } });
  };
}

export function createApp(ctx) {
  const { config, logger } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trust_proxy);
  app.use((req, _res, next) => { req.id = acceptedRequestId(req.get('x-request-id')) || crypto.randomUUID(); next(); });
  if (config.log_level !== 'silent') {
    app.use(pinoHttp({
      logger, genReqId: (req) => req.id,
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }), res: (res) => ({ statusCode: res.statusCode }) },
    }));
  }
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], upgradeInsecureRequests: config.tls ? [] : null } },
    crossOriginEmbedderPolicy: false,
    hsts: config.tls ? undefined : false,
  }));

  app.get('/healthz', (_req, res) => {
    const h = ctx.health();
    res.status(h.ok ? 200 : 503).json({ data: h });
  });

  app.use('/v1/admin/billing/webhooks', billingWebhookRoutes(ctx));
  // §16.6: errors on signed routes are signed too, including a body that does
  // not parse. The parser's error for a POST that carries X-WHM-Nonce is held
  // on req.bodyError until signedMiddleware has installed the signing wrapper
  // and rethrows it; every other request fails here, unsigned, as before.
  const jsonParser = express.json({ limit: '1mb' });
  app.use((req, res, next) => jsonParser(req, res, (err) => {
    if (err && req.method === 'POST' && req.get('x-whm-nonce')) { req.bodyError = err; return next(); }
    next(err);
  }));
  if (!config.tls && config.cookie_secure === false) logger.warn('cookie_secure is false: the portal session cookie is sent over plain HTTP');
  app.use(portalSession(ctx));
  app.use(attachPrincipal(ctx));
  app.use(csrf({ exempt: ['/v1/portal/login', '/v1/portal/csrf'] }));
  const audit = createAudit({ db: ctx.dbs.license, logger, now: () => ctx.clock.now() });
  app.use(audit.middleware);

  app.limiters = buildLimiters(ctx);
  app.signed = (...handlers) => [signedMiddleware(ctx), ...handlers];
  ctx.app = app;
  app.use(TOTP_LIMITED_PATHS, app.limiters.totp);

  app.use('/v1', publicRoutes(ctx));
  app.use('/v1/reseller', resellerRoutes(ctx));
  app.use('/v1/admin', adminRoutes(ctx));
  app.use('/v1/portal', portalRoutes(ctx));
  app.use('/v1/jobs', jobAliasRoutes(ctx));
  return app;
}

// 404 + error handler + optional SPA go last, after every module mounted its routes.
// The SPA (hub/ui, built by `npm run build --prefix hub/ui`) is served from
// hub/ui/dist at "/" when serve_ui is set: hashed assets with a long cache,
// index.html (never cached) for every other extension-less GET so the
// client-side router owns /login, /admin/*, /reseller/* and /dev/*.
// WHM_HUB_UI_DIST points at another build directory.
const STATIC_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.map', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.json', '.txt', '.woff', '.woff2', '.ttf', '.webmanifest', '.html']);
// Client-side route prefixes: a reverse-DNS segment inside them (plugin id
// net.acme.js, catalog id com.foo.json) is a route param, never a file.
const SPA_PREFIX_RE = /^\/(admin|reseller|dev|login)(\/|$)/;

export function isSpaPath(reqPath) {
  if (reqPath.startsWith('/assets/')) return false;
  if (SPA_PREFIX_RE.test(reqPath)) return true;
  return !STATIC_EXTENSIONS.has(path.extname(reqPath).toLowerCase());
}

export function uiDistDir(config = {}) {
  return process.env.WHM_HUB_UI_DIST || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../ui/dist');
}

export function finalizeApp(ctx) {
  const { app, config, logger } = ctx;
  app.use('/v1', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such API endpoint' } }));
  const uiDist = uiDistDir(config);
  if (config.serve_ui && fs.existsSync(path.join(uiDist, 'index.html'))) {
    app.use(express.static(uiDist, { index: false, maxAge: '1h', fallthrough: true }));
    app.get('*', (req, res, next) => {
      // Missing build files answer 404, not index.html; route params such as
      // a semver segment ("/versions/1.0.0") or a plugin id are not files.
      if (!isSpaPath(req.path)) return next();
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(uiDist, 'index.html'));
    });
  } else if (config.serve_ui) {
    logger.warn({ dist: uiDist }, 'serve_ui is set but hub/ui/dist is missing; run `npm run build --prefix hub/ui`');
  }
  app.use(errorHandler(logger));
  return app;
}

export function createLoopbackApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => { const h = ctx.health(); res.status(h.ok ? 200 : 503).json({ data: h }); });
  app.get('/metrics', (_req, res) => res.type('text/plain; version=0.0.4').send(ctx.metrics.render()));
  return app;
}
