const SECRET_KEYS = /pass(word)?|secret|token|key|cert|private|totp|csrf|fingerprint|fp_components|machine_id|mac|disk/i;

// The panel's redaction rules plus the hub's own: license keys, tokens and
// fingerprint components never reach the audit table or a log line.
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

export function principalLabel(principal) {
  if (!principal) return null;
  if (principal.type === 'api_key') return `apikey:${principal.keyId}`;
  if (principal.type === 'portal') return `portal:${principal.userId}`;
  if (principal.type === 'panel') return `activation:${principal.activationId}`;
  return principal.label || null;
}

export function record(db, { principal = null, role = null, ip = null, action, target = null, args = null, result = 'ok', ts }) {
  db.prepare(`INSERT INTO audit_log (ts, principal, role, ip, action, target, args_redacted, result)
    VALUES (@ts, @principal, @role, @ip, @action, @target, @args, @result)`).run({
    ts: ts || new Date().toISOString(),
    principal: typeof principal === 'string' ? principal : principalLabel(principal),
    role: role ?? principal?.role ?? principal?.ownerType ?? null,
    ip,
    action,
    target: target == null ? null : String(target),
    args: args == null ? null : JSON.stringify(redact(args)),
    result,
  });
}

export function createAudit({ db, logger, now = () => Date.now() }) {
  function safeRecord(entry) {
    try { record(db, { ts: new Date(now()).toISOString(), ...entry }); } catch (err) { logger?.error({ err, action: entry.action }, 'failed to write audit log'); }
  }

  // Every mutating request is recorded when it finishes; services add richer
  // semantic rows on top through req.audit().
  function middleware(req, res, next) {
    req.audit = (entry) => safeRecord({ principal: req.principal, ip: req.ip, ...entry });
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      res.on('finish', () => {
        safeRecord({
          principal: req.principal,
          ip: req.ip,
          action: `${req.method} ${req.baseUrl}${req.route?.path && req.route.path !== '/' ? req.route.path : ''}`.trim() || `${req.method} ${req.originalUrl.split('?')[0]}`,
          target: Object.values(req.params || {}).join('/') || null,
          args: req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && Object.keys(req.body).length ? req.body : null,
          result: res.statusCode < 400 ? 'ok' : `error:${res.statusCode}`,
        });
      });
    }
    next();
  }

  return { record: safeRecord, middleware };
}
