import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const isProd = process.env.NODE_ENV === 'production';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const defaults = {
  env: process.env.NODE_ENV || 'development',
  host: '0.0.0.0',
  port: 2086,
  tlsPort: 2087,
  tlsCert: null,
  tlsKey: null,
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
  // License client (§16.8): the bootstrap hub URL used until a token names its issuer
  // (the vendor hub unless WHM_LICENSE_HUB_URL overrides it; only the super admin
  // ever sees it), the pinned vendor keys, an optional private CA for the hub, and
  // whether the degraded/feature/capacity gates are enforced (on in production, off
  // for dev/tests).
  licenseHubUrl: 'https://licserver.hostingsignal.in',
  licenseKeysFile: null,
  licenseHubCa: null,
  licenseEnforce: isProd,
  licenseCheckinHours: 12,
  // The super admin setup key (bcrypt hash, 0600 root). Unset = next to the
  // config file in use (/etc/whm/superadmin.key on an installed host, where
  // the panel user cannot replace it), or in the data directory when the
  // panel runs without a config file (dev checkouts, tests).
  superadminKeyFile: null,
};

function readConfigFile() {
  const candidates = [
    process.env.WHM_CONFIG,
    '/etc/whm/whm.conf',
    path.resolve(process.cwd(), 'whm.conf.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return { file, values: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      throw new Error(`Failed to read config file ${file}: ${err.message}`);
    }
  }
  return { file: null, values: {} };
}

function merged(overrides) {
  const { file, values } = readConfigFile();
  const cfg = { ...defaults, ...values, ...envOverrides(), ...overrides };
  cfg.configFile = file;
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.superadminKeyFile = path.resolve(cfg.superadminKeyFile || path.join(file ? path.dirname(file) : cfg.dataDir, 'superadmin.key'));
  return cfg;
}

function envOverrides() {
  const e = process.env;
  const out = {};
  if (e.WHM_HOST) out.host = e.WHM_HOST;
  if (e.WHM_PORT) out.port = Number(e.WHM_PORT);
  if (e.WHM_TLS_PORT) out.tlsPort = Number(e.WHM_TLS_PORT);
  if (e.WHM_TLS_CERT) out.tlsCert = e.WHM_TLS_CERT;
  if (e.WHM_TLS_KEY) out.tlsKey = e.WHM_TLS_KEY;
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
  if (e.WHM_SUPERADMIN_KEY_FILE) out.superadminKeyFile = path.resolve(e.WHM_SUPERADMIN_KEY_FILE);
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

// The merged configuration without touching the data directory: for tooling
// that must not create root-owned secrets before the panel's first boot.
export function readConfig(overrides = {}) {
  return merged(overrides);
}

export function loadConfig(overrides = {}) {
  const cfg = merged(overrides);
  if (!['monolithic', 'split'].includes(cfg.mode)) {
    throw new Error(`WHM_MODE must be "monolithic" or "split", got "${cfg.mode}"`);
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o750 });
  cfg.dbPath = path.join(cfg.dataDir, 'whm.db');
  cfg.sessionSecret ||= persistedSecret(cfg.dataDir, 'session.secret');
  cfg.masterKeyHex = persistedSecret(cfg.dataDir, 'master.key');
  cfg.tls = Boolean(cfg.tlsCert && cfg.tlsKey);
  cfg.pluginsDir = path.resolve(cfg.pluginsDir || path.join(cfg.dataDir, 'plugins'));
  cfg.pluginDataDir = path.resolve(cfg.pluginDataDir || path.join(cfg.dataDir, 'plugin-data'));
  return cfg;
}
