// Which shell a request belongs to is decided by the port it arrived on, never
// by a header: the account-panel listeners (config.panelPort / panelHttpPort)
// serve only the account panel, everything else is the administration shell.
// The ports are read from config at request time so tests can set them once
// their ephemeral listeners are bound.

export const PANEL_SHELL = 'panel';
export const ADMIN_SHELL = 'admin';

// What the account-panel SPA calls (client/src/panel, client/src/pages/panel):
// its own API, the session routes, the public branding (login page + logo
// images), the health probe, and the two exact routes every signed-in role
// loads on start (interface strings via i18n/useT.js, the active theme via
// theme/ThemeLoader.jsx). Anything else under /api is administration.
export const PANEL_API_ALLOW = ['/api/health', '/api/auth', '/api/branding', '/api/panel', '/api/locales/active', '/api/themes/active'];
// The administration of the account panel (log in as, password and 2FA
// resets, settings) lives under /api/panel but belongs to the admin shell:
// a session cookie or token is host-scoped, not port-scoped, so an admin
// principal must not be able to drive it through the exposed panel ports.
export const PANEL_API_DENY = ['/api/panel/admin'];

const underPrefix = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);
export const panelApiAllowed = (path) => !PANEL_API_DENY.some((prefix) => underPrefix(path, prefix)) && PANEL_API_ALLOW.some((prefix) => underPrefix(path, prefix));

// Paths the panel shell serves as navigations; every other page is sent to /panel.
const PANEL_NAV_PREFIXES = ['/panel', '/login'];
export const panelNavigationAllowed = (path) => PANEL_NAV_PREFIXES.some((prefix) => underPrefix(path, prefix));

export function shellFor(req, config) {
  const port = Number(req.socket?.localPort);
  if (!port) return ADMIN_SHELL;
  const panelPorts = [config.panelPort, config.panelHttpPort].map(Number).filter((p) => p > 0);
  return panelPorts.includes(port) ? PANEL_SHELL : ADMIN_SHELL;
}

export const shellDetect = (config) => (req, _res, next) => { req.shell = shellFor(req, config); next(); };

// The address account holders sign in at: the TLS panel listener when it is
// open, else the plain one, else the administration origin (/panel there).
export function accountPanelUrl(config, host) {
  const hostname = host || 'localhost';
  if (config.tls) return config.panelPort ? `https://${hostname}:${config.panelPort}` : `https://${hostname}:${config.tlsPort}`;
  return config.panelHttpPort ? `http://${hostname}:${config.panelHttpPort}` : `http://${hostname}:${config.port}`;
}

// Where administrators and resellers sign in; shown to one refused on a
// panel listener (login error body, branding on the panel shell).
export const adminLoginUrl = (config, host) => `https://${host || 'localhost'}:${Number(config.tlsPort) || 2087}/login`;

export function wrongPortBody(config, message) {
  const tlsPort = Number(config.tlsPort) || 2087;
  return { error: { code: 'wrong_port', message: message || `The administration API is served on port ${tlsPort}` } };
}

// Mounted on /api after shellDetect: the panel listeners answer only the
// account panel's API.
export const panelApiGuard = (config) => (req, res, next) => {
  if (req.shell !== PANEL_SHELL) return next();
  const path = String(req.originalUrl || req.url || '/').split('?')[0];
  if (panelApiAllowed(path)) return next();
  return res.status(403).json(wrongPortBody(config));
};

// Mounted on /api after attachUser: an administrator or reseller principal
// that reaches a panel listener (a session or token minted on the admin
// port) may only read and log out there; every mutation belongs to the
// administration shell. An audited "Log in as" session acts as the account
// and keeps working, because it is the account user's panel being driven.
export const panelPrincipalGuard = (config) => (req, res, next) => {
  if (req.shell !== PANEL_SHELL || !req.user || req.user.role === 'user' || req.session?.panelActingAs) return next();
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const path = String(req.originalUrl || req.url || '/').split('?')[0];
  if (path === '/api/auth/logout') return next();
  return res.status(403).json(wrongPortBody(config, `Administrators and resellers use port ${Number(config.tlsPort) || 2087}`));
};
