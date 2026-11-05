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
import { tlsRedirect } from './middleware/tls-redirect.js';
import { shellDetect, panelApiGuard, panelPrincipalGuard, panelNavigationAllowed, PANEL_SHELL } from './middleware/shell.js';
import { apiRouter } from './routes/index.js';
import { requestLogLevel, requestLogMessage, requestLogObject } from './lib/request-log.js';

// A caller may name its request for log correlation, but only with a short
// plain id; anything else is replaced so logs and error bodies stay clean.
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const acceptedRequestId = (value) => (typeof value === 'string' && REQUEST_ID_RE.test(value) ? value : null);
// Streams are matched on the path alone: a query string is never consulted,
// so "?x=/stream" cannot opt a request out of the limiter or the access log.
export const isStreamRequest = (req) => /\/stream$/i.test(String(req.originalUrl ?? req.url ?? '').split('?')[0]);
// Job streams (system and the account panel's) are long-lived SSE responses
// that would log one access line per open tab; they are kept out of the log.
const JOB_STREAM_RE = /\/jobs\/[^/]+\/stream$/i;
export const skipsAccessLog = (req) => {
  const url = String(req.originalUrl ?? req.url ?? '').split('?')[0];
  return isStreamRequest(req) && (url.startsWith('/api/system/jobs/') || JOB_STREAM_RE.test(url));
};

// A DDNS update token and an SSO exchange token travel in the path; the
// request log must not keep them (the DDNS one stays valid until revoked).
const PATH_SECRET_RE = /(\/panel\/(?:dns\/ddns|sso\/[a-z]+)\/)[A-Za-z0-9_-]{32,128}(?=[/?#]|$)/;
export const redactLoggedUrl = (url) => String(url ?? '').replace(PATH_SECRET_RE, '$1[redacted]');

export async function createApp(ctx) {
  const { config, db, logger, crypto: cryptoSvc } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 'loopback');

  app.use((req, _res, next) => { req.id = acceptedRequestId(req.get('x-request-id')) || crypto.randomUUID(); next(); });
  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.id,
    autoLogging: { ignore: skipsAccessLog },
    customLogLevel: (_req, res, err) => requestLogLevel(res, err),
    customErrorMessage: (_req, res, err) => requestLogMessage(res, err),
    customErrorObject: (_req, res, err, obj) => requestLogObject(res, err, obj),
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: redactLoggedUrl(req.url), ip: req.remoteAddress }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }));
  app.use(shellDetect(config));
  if (config.tls && config.httpRedirect !== false) app.use(tlsRedirect(config));
  app.use('/api', panelApiGuard(config));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
        // Helmet's default would make browsers rewrite the SPA's own API calls
        // to https on a plain-HTTP (port 2086 only) install.
        upgradeInsecureRequests: config.tls ? [] : null,
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
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, skip: isStreamRequest }));

  // OIDC callbacks arrive as top-level navigations with the session cookie; the
  // redirect target lives on the same origin, so the SPA fallback below serves it.
  app.use('/api', attachUser(ctx));
  app.use('/api', panelPrincipalGuard(config));
  app.use('/api', csrfProtection);
  const audit = createAudit(ctx);
  ctx.auditRecord = audit.record;
  app.use('/api', audit.middleware);
  app.use('/api', await apiRouter(ctx));
  app.use('/api', notFoundHandler);

  // The account-panel listeners open on the account panel: any other page
  // navigation (not an asset, not the login page) lands on /panel.
  app.get('*', (req, res, next) => {
    if (req.shell !== PANEL_SHELL || path.extname(req.path) || panelNavigationAllowed(req.path)) return next();
    res.redirect(302, '/panel');
  });

  if (config.serveClient && fs.existsSync(path.join(config.clientDist, 'index.html'))) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h', immutable: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
  } else if (config.serveClient) {
    logger.warn({ dist: config.clientDist }, 'WHM_SERVE_CLIENT is set but client/dist is missing; run "npm run build"');
  }

  app.use(errorHandler(logger));
  return app;
}
