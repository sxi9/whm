import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const isProd = process.env.NODE_ENV === 'production';
// The HTTP→HTTPS guard fails safe: only an explicit "off" value disables it,
// a typo or an unexpected type keeps it on.
const REDIRECT_OFF = /^(false|0|no|off)$/i;
export const httpRedirectEnabled = (value) => !REDIRECT_OFF.test(String(value ?? '').trim());
// Account-panel listener ports: 0/off/false/no (or an unparsable value)
// disables that listener; anything else must be a TCP port.
const PORT_OFF = /^(false|0|no|off)$/i;
export const listenerPort = (value) => {
  const text = String(value ?? '').trim();
  if (!text || PORT_OFF.test(text)) return 0;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
};
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const defaults = {
  env: process.env.NODE_ENV || 'development',
  host: '0.0.0.0',
  port: 2086,
  tlsPort: 2087,
  tlsCert: null,
  tlsKey: null,
  // With TLS on, the plain listener only redirects (GET/HEAD) or refuses (426);
  // GET /api/health stays reachable. Ignored without a certificate.
  httpRedirect: true,
  // Account-panel listeners (cPanel's 2083/2082): they serve only /panel, the
  // login page and the panel API. panelPort opens only with TLS; panelHttpPort
  // redirects/refuses like `port` does with TLS and serves in clear without.
  panelPort: 2083,
  panelHttpPort: 2082,
  dataDir: isProd ? '/var/lib/whm' : path.resolve(process.cwd(), 'data'),
  mode: 'monolithic',
  agentSocket: '/run/whm-agent.sock',
  adminPassword: null,
  sessionSecret: null,
  logLevel: 'info',
  serveClient: isProd,
  clientDist: path.join(repoRoot, 'client', 'dist'),
  // Where plain-text brute-force protection bites: attempts per window per IP+user.
  loginRateLimit: { windowMs: 15 * 60 * 1000, max: 20 },
  sessionTtlMs: 8 * 60 * 60 * 1000,
  checkinIntervalMs: 60 * 1000,
  pluginsDir: null,
  pluginDataDir: null,
  pluginHookTimeoutMs: 30_000,
  pluginActivateTimeoutMs: 60_000,
  // License client (§16.8): the bootstrap hub URL used until a token names its issuer,
  // the pinned vendor keys, an optional private CA for the hub, and whether the
  // degraded/feature/capacity gates are enforced (on in production, off for dev/tests).
  licenseHubUrl: null,
  licenseKeysFile: null,
  licenseHubCa: null,
  licenseEnforce: isProd,
  licenseCheckinHours: 12,
};

function readConfigFile() {
  const candidates = [
    process.env.WHM_CONFIG,
    '/etc/whm/whm.conf',
    path.resolve(process.cwd(), 'whm.conf.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to read config file ${file}: ${err.message}`);
    }
  }
  return {};
}

function envOverrides() {
  const e = process.env;
  const out = {};
  if (e.WHM_HOST) out.host = e.WHM_HOST;
  if (e.WHM_PORT) out.port = Number(e.WHM_PORT);
  if (e.WHM_TLS_PORT) out.tlsPort = Number(e.WHM_TLS_PORT);
  if (e.WHM_TLS_CERT) out.tlsCert = e.WHM_TLS_CERT;
  if (e.WHM_TLS_KEY) out.tlsKey = e.WHM_TLS_KEY;
  if (e.WHM_HTTP_REDIRECT) out.httpRedirect = httpRedirectEnabled(e.WHM_HTTP_REDIRECT);
  if (e.WHM_PANEL_PORT !== undefined) out.panelPort = e.WHM_PANEL_PORT;
  if (e.WHM_PANEL_HTTP_PORT !== undefined) out.panelHttpPort = e.WHM_PANEL_HTTP_PORT;
  if (e.WHM_DATA_DIR) out.dataDir = path.resolve(e.WHM_DATA_DIR);
  if (e.WHM_MODE) out.mode = e.WHM_MODE;
  if (e.WHM_AGENT_SOCKET) out.agentSocket = e.WHM_AGENT_SOCKET;
  if (e.WHM_ADMIN_PASSWORD) out.adminPassword = e.WHM_ADMIN_PASSWORD;
  if (e.WHM_SESSION_SECRET) out.sessionSecret = e.WHM_SESSION_SECRET;
  if (e.WHM_LOG_LEVEL) out.logLevel = e.WHM_LOG_LEVEL;
  if (e.WHM_SERVE_CLIENT) out.serveClient = e.WHM_SERVE_CLIENT === 'true';
  if (e.WHM_CLIENT_DIST) out.clientDist = path.resolve(e.WHM_CLIENT_DIST);
  if (e.WHM_PLUGINS_DIR) out.pluginsDir = path.resolve(e.WHM_PLUGINS_DIR);
  if (e.WHM_PLUGIN_DATA_DIR) out.pluginDataDir = path.resolve(e.WHM_PLUGIN_DATA_DIR);
  if (e.WHM_PLUGIN_HOOK_TIMEOUT_MS) out.pluginHookTimeoutMs = Number(e.WHM_PLUGIN_HOOK_TIMEOUT_MS);
  if (e.WHM_PLUGIN_ACTIVATE_TIMEOUT_MS) out.pluginActivateTimeoutMs = Number(e.WHM_PLUGIN_ACTIVATE_TIMEOUT_MS);
  if (e.WHM_LICENSE_HUB_URL) out.licenseHubUrl = e.WHM_LICENSE_HUB_URL;
  if (e.WHM_LICENSE_KEYS_FILE) out.licenseKeysFile = path.resolve(e.WHM_LICENSE_KEYS_FILE);
  if (e.WHM_LICENSE_HUB_CA) out.licenseHubCa = path.resolve(e.WHM_LICENSE_HUB_CA);
  if (e.WHM_LICENSE_ENFORCE) out.licenseEnforce = e.WHM_LICENSE_ENFORCE === 'true';
  if (e.WHM_LICENSE_CHECKIN_HOURS) out.licenseCheckinHours = Number(e.WHM_LICENSE_CHECKIN_HOURS);
  return out;
}

// A secret that must survive restarts is generated once and kept in the data
// dir with owner-only permissions, so operators don't have to manage it by hand.
function persistedSecret(dataDir, name, bytes = 32) {
  const file = path.join(dataDir, name);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const value = crypto.randomBytes(bytes).toString('hex');
  fs.writeFileSync(file, value + '\n', { mode: 0o600 });
  return value;
}

// A panel port equal to an administration port (or to the other panel port)
// could not bind anyway, but shellFor() would still classify every request on
// that admin port as the panel shell and lock every administrator out. Such
// a listener is disabled and reported so index.js can warn about it.
export function disablePanelPortCollisions(cfg) {
  const disabled = [];
  const adminPorts = [['port', Number(cfg.port)], ['tlsPort', Number(cfg.tlsPort)]];
  for (const key of ['panelPort', 'panelHttpPort']) {
    if (!cfg[key]) continue;
    const hit = adminPorts.find(([, port]) => port === cfg[key]);
    if (!hit) continue;
    disabled.push({ key, port: cfg[key], collidesWith: hit[0] });
    cfg[key] = 0;
  }
  if (cfg.panelHttpPort && cfg.panelHttpPort === cfg.panelPort) {
    disabled.push({ key: 'panelHttpPort', port: cfg.panelHttpPort, collidesWith: 'panelPort' });
    cfg.panelHttpPort = 0;
  }
  return disabled;
}

export function loadConfig(overrides = {}) {
  const cfg = { ...defaults, ...readConfigFile(), ...envOverrides(), ...overrides };
  if (!['monolithic', 'split'].includes(cfg.mode)) {
    throw new Error(`WHM_MODE must be "monolithic" or "split", got "${cfg.mode}"`);
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o750 });
  cfg.dbPath = path.join(cfg.dataDir, 'whm.db');
  cfg.sessionSecret ||= persistedSecret(cfg.dataDir, 'session.secret');
  cfg.masterKeyHex = persistedSecret(cfg.dataDir, 'master.key');
  cfg.tls = Boolean(cfg.tlsCert && cfg.tlsKey);
  cfg.httpRedirect = httpRedirectEnabled(cfg.httpRedirect);
  cfg.panelPort = listenerPort(cfg.panelPort);
  cfg.panelHttpPort = listenerPort(cfg.panelHttpPort);
  cfg.disabledPanelPorts = disablePanelPortCollisions(cfg);
  cfg.pluginsDir = path.resolve(cfg.pluginsDir || path.join(cfg.dataDir, 'plugins'));
  cfg.pluginDataDir = path.resolve(cfg.pluginDataDir || path.join(cfg.dataDir, 'plugin-data'));
  return cfg;
}
