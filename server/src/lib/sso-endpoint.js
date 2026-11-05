// The loopback address the signon code of a published application (Roundcube
// plugin, phpMyAdmin signon script) exchanges a panel token on: the panel's
// own listener, HTTPS when TLS is configured (the plain port then refuses
// /api with 426), the plain port otherwise. Rendered into the host
// configuration so a changed port never strands the exchange.
export const SSO_ENDPOINT_RE = /^https?:\/\/127\.0\.0\.1:\d{1,5}\/api\/panel\/sso\/(?:webmail|phpmyadmin)\/$/;

export function loopbackOrigin(config = {}) {
  const tls = Boolean(config.tls);
  const port = Number(tls ? config.tlsPort : config.port) || (tls ? 2087 : 2086);
  return `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
}

export function ssoEndpoint(config, kind) {
  return `${loopbackOrigin(config)}/api/panel/sso/${kind}/`;
}
