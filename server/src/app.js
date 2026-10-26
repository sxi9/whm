import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { SqliteSessionStore } from './db/session-store.js';
import { attachUser } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { createAudit } from './middleware/audit.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiRouter } from './routes/index.js';

export async function createApp(ctx) {
  const { config, db, logger, crypto: cryptoSvc } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 'loopback');

  app.use((req, _res, next) => { req.id = req.get('x-request-id') || crypto.randomUUID(); next(); });
  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.id,
    autoLogging: { ignore: (req) => req.url.startsWith('/api/system/jobs/') && req.url.endsWith('/stream') },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.tls ? undefined : false,
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  const sessionStore = ctx.sessionStore || (ctx.sessionStore = new SqliteSessionStore(db, { ttlMs: config.sessionTtlMs }));
  app.use(session({
    name: 'whm.sid',
    secret: config.sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'strict', secure: config.tls || config.cookieSecure === true, maxAge: config.sessionTtlMs, path: '/' },
  }));

  app.use('/api/auth/login', rateLimit({ windowMs: config.loginRateLimit.windowMs, limit: config.loginRateLimit.max, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'rate_limited', message: 'Too many login attempts, please wait' } } }));
  app.use('/api/auth/2fa', rateLimit({ windowMs: config.loginRateLimit.windowMs, limit: config.loginRateLimit.max, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'rate_limited', message: 'Too many attempts, please wait' } } }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, skip: (req) => req.url.includes('/stream') }));

  // OIDC callbacks arrive as top-level navigations with the session cookie; the
  // redirect target lives on the same origin, so the SPA fallback below serves it.
  app.use('/api', attachUser(ctx));
  app.use('/api', csrfProtection);
  const audit = createAudit(ctx);
  ctx.auditRecord = audit.record;
  app.use('/api', audit.middleware);
  app.use('/api', await apiRouter(ctx));
  app.use('/api', notFoundHandler);

  if (config.serveClient && fs.existsSync(path.join(config.clientDist, 'index.html'))) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h', immutable: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
  } else if (config.serveClient) {
    logger.warn({ dist: config.clientDist }, 'WHM_SERVE_CLIENT is set but client/dist is missing; run "npm run build"');
  }

  app.use(errorHandler(logger));
  return app;
}
