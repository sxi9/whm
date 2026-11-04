// The plain listener (index.js) serves the same Express app as the TLS one.
// Once a certificate is configured nothing may be served or accepted in clear:
// navigations are sent to the https port, API calls are refused outright so a
// fetch() never follows a redirect across origins (and no credential body is
// ever read), and GET /api/health keeps answering for monitors.

// A Host header is only ever echoed as a hostname or IP literal; the port is
// always the configured tlsPort so a client cannot steer the redirect.
const HOST_RE = /^(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?)(?::\d{1,5})?$/;

export function redirectHostname(hostHeader) {
  const m = HOST_RE.exec(String(hostHeader || '').trim());
  return m ? m[1] : null;
}

export function redirectTarget(req, tlsPort) {
  const host = redirectHostname(req.get('host'));
  if (!host) return null;
  const url = String(req.originalUrl || '/');
  const path = url.startsWith('/') ? url : '/';
  const port = Number(tlsPort) === 443 ? '' : `:${Number(tlsPort)}`;
  return `https://${host}${port}${path}`;
}

export const HEALTH_PATH = '/api/health';

export function tlsRedirect(config) {
  const tlsPort = Number(config.tlsPort) || 2087;
  const refuse = (res) => res.status(426).set('Upgrade', 'TLS/1.2, HTTP/1.1').set('Connection', 'close').json({
    error: { code: 'tls_required', message: `Use https on port ${tlsPort}` },
  });
  // Decided on the socket, never on req.secure: with trust proxy 'loopback'
  // any local process could mark a plain request https through
  // X-Forwarded-Proto. Operators terminating TLS on a proxy switch the guard
  // off with WHM_HTTP_REDIRECT=false.
  return (req, res, next) => {
    if (req.socket?.encrypted) return next();
    const isApi = req.path === '/api' || req.path.startsWith('/api/');
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (req.path === HEALTH_PATH) return next();
      if (!isApi) {
        const target = redirectTarget(req, tlsPort);
        if (target) return res.redirect(301, target);
      }
    }
    return refuse(res);
  };
}
