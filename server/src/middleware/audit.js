const SECRET_KEYS = /pass(word)?|secret|token|key|cert|private|totp|csrf/i;

export function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return { bytes: value.byteLength };
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return value.slice(0, 500) + '…';
  return value;
}

export function createAudit({ db, logger }) {
  const insert = db.prepare(`INSERT INTO audit_log (principal, role, ip, action, target, args_redacted, result, request_id)
    VALUES (@principal, @role, @ip, @action, @target, @args, @result, @requestId)`);

  function record(req, { action, target = null, args = null, result = 'ok' }) {
    try {
      insert.run({
        principal: req?.user?.username ?? null,
        role: req?.user?.role ?? null,
        ip: req?.ip ?? null,
        action,
        target: target == null ? null : String(target),
        args: args == null ? null : JSON.stringify(redact(args)),
        result,
        requestId: req?.id ?? null,
      });
    } catch (err) {
      logger.error({ err, action }, 'failed to write audit log');
    }
  }

  // Every mutating request is recorded when it finishes, so no endpoint can be
  // forgotten. Services add richer, semantic entries on top via req.audit().
  function middleware(req, res, next) {
    req.audit = (entry) => record(req, entry);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.path.startsWith('/auth/login')) {
      // Express unwinds req.baseUrl and req.params before an error reaches the
      // app-level error handler, so the matched route is captured when it is set.
      let matched = null;
      Object.defineProperty(req, 'route', {
        configurable: true,
        enumerable: true,
        get: () => matched?.route,
        set(route) { matched = { route, baseUrl: req.baseUrl, params: { ...req.params } }; },
      });
      res.on('finish', () => {
        const routePath = matched?.route.path ?? req.path;
        record(req, {
          action: `${req.method} ${matched?.baseUrl ?? req.baseUrl}${routePath === '/' ? '' : routePath}`,
          target: Object.values(matched?.params ?? req.params ?? {}).join('/') || null,
          args: Buffer.isBuffer(req.body) ? { bytes: req.body.length } : req.body && Object.keys(req.body).length ? req.body : null,
          result: res.statusCode < 400 ? 'ok' : `error:${res.statusCode}`,
        });
      });
    }
    next();
  }

  return { record, middleware };
}
