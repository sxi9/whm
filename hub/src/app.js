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
import { adminRoutes, billingWebhookRoutes } from '../license/routes/admin.js';
import { portalRoutes } from '../license/routes/portal.js';

function limiter({ max, windowMs }, { keyGenerator, message = 'Too many requests, slow down', skip } = {}) {
  return rateLimit({
    windowMs, limit: max, standardHeaders: 'draft-7', legacyHeaders: false, validate: false, keyGenerator, skip,
    handler: (_req, res) => res.status(429).json({ error: { code: 'rate_limited', message } }),
  });
}

function keyPrefixOf(body) {
  const k = String(body?.key || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return k ? k.slice(0, 7) : '-';
}

function activationIdOf(body) {
  try {
    const payload = JSON.parse(Buffer.from(String(body?.token || '').split('.')[1] || '', 'base64url').toString('utf8'));
    return typeof payload?.aid === 'string' ? payload.aid : null;
  } catch { return null; }
}

export function buildLimiters(ctx) {
  const rl = ctx.config.license.rate_limits;
  return {
    activate: limiter(rl.activate, { keyGenerator: (req) => `${req.ip}|${keyPrefixOf(req.body)}` }),
    checkin: limiter(rl.checkin, { keyGenerator: (req) => activationIdOf(req.body) || req.ip, message: 'Check-in limit reached for this activation' }),
    trial: limiter(rl.trial, { keyGenerator: (req) => req.ip }),
    recover: limiter(rl.recover, { keyGenerator: (req) => req.ip }),
    public: limiter(rl.public, { keyGenerator: (req) => req.ip }),
    reseller: limiter(rl.reseller, { keyGenerator: (req) => req.principal?.keyId || req.principal?.userId || req.ip }),
    admin: limiter(rl.admin, { keyGenerator: (req) => req.principal?.keyId || req.principal?.userId || req.ip }),
    portalLogin: limiter(rl.portal_login, { keyGenerator: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}` }),
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
    res.json = (payload) => {
      const out = { ...payload, meta: { ...(payload?.meta || {}), nonce } };
      try { ctx.keys.signResponse(res, out); } catch (err) { ctx.logger.error({ err }, 'cannot sign response'); }
      return originalJson(out);
    };
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const tsHeader = Number(req.get('x-whm-timestamp'));
      if (!nonce || body.nonce !== nonce) throw new HttpError(400, 'nonce_mismatch', 'X-WHM-Nonce must equal body.nonce');
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
  app.use((req, _res, next) => { req.id = req.get('x-request-id') || crypto.randomUUID(); next(); });
  if (config.log_level !== 'silent') {
    app.use(pinoHttp({
      logger, genReqId: (req) => req.id,
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }), res: (res) => ({ statusCode: res.statusCode }) },
    }));
  }
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } },
    crossOriginEmbedderPolicy: false,
    hsts: config.tls ? undefined : false,
  }));

  app.get('/healthz', (_req, res) => {
    const h = ctx.health();
    res.status(h.ok ? 200 : 503).json({ data: h });
  });

  app.use('/v1/admin/billing/webhooks', billingWebhookRoutes(ctx));
  app.use(express.json({ limit: '1mb' }));
  app.use(portalSession(ctx));
  app.use(attachPrincipal(ctx));
  app.use(csrf({ exempt: ['/v1/portal/login', '/v1/portal/csrf'] }));
  const audit = createAudit({ db: ctx.dbs.license, logger, now: () => ctx.clock.now() });
  app.use(audit.middleware);

  app.limiters = buildLimiters(ctx);
  app.signed = (...handlers) => [signedMiddleware(ctx), ...handlers];
  ctx.app = app;

  app.use('/v1', publicRoutes(ctx));
  app.use('/v1/reseller', resellerRoutes(ctx));
  app.use('/v1/admin', adminRoutes(ctx));
  app.use('/v1/portal', portalRoutes(ctx));
  return app;
}

// 404 + error handler + optional SPA go last, after every module mounted its routes.
export function finalizeApp(ctx) {
  const { app, config, logger } = ctx;
  app.use('/v1', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such API endpoint' } }));
  const uiDist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../ui/dist');
  if (config.serve_ui && fs.existsSync(path.join(uiDist, 'index.html'))) {
    app.use(express.static(uiDist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(uiDist, 'index.html')));
  } else if (config.serve_ui) {
    logger.warn({ dist: uiDist }, 'serve_ui is set but hub/ui/dist is missing');
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
