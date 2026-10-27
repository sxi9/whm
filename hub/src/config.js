import fs from 'node:fs';
import { z } from 'zod';

// /etc/whm-hub/hub.conf is JSON. Every value can be overridden by
// WHM_HUB_* environment variables and, in tests, by an override object.
const rateLimit = (max, windowMs) => z.object({ max: z.number().int().min(1).default(max), windowMs: z.number().int().min(1000).default(windowMs) }).default({ max, windowMs });

const schema = z.object({
  public_url: z.string().url().default('https://localhost:7443'),
  serve_ui: z.boolean().default(false),
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(7443),
  loopback_port: z.number().int().min(0).max(65535).default(7440),
  trust_proxy: z.union([z.boolean(), z.string(), z.number()]).default('loopback'),
  log_level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  db_dir: z.string().default('/var/lib/whm-hub'),
  master_key_file: z.string().default('/etc/whm-hub/master.key'),
  master_key: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  session_secret: z.string().min(16).optional(),
  cookie_secure: z.boolean().optional(),
  insecure_http: z.boolean().default(false),
  tls: z.object({ cert: z.string(), key: z.string() }).nullable().default(null),
  keys: z.object({
    dir: z.string().default('/etc/whm-hub/keys'),
    active_kid: z.object({ license: z.string().regex(/^[0-9a-f]{8}$/).nullable().default(null), plugin: z.string().regex(/^[0-9a-f]{8}$/).nullable().default(null) }).default({}),
  }).default({}),
  license: z.object({
    token_ttl_hours: z.number().int().min(1).default(168),
    checkin_interval_hours: z.number().int().min(1).default(12),
    default_grace_days: z.number().int().min(0).default(7),
    trial_days: z.number().int().min(1).default(14),
    reclaim_days: z.number().int().min(1).default(30),
    reactivation_limit: z.object({ count: z.number().int().min(1).default(3), days: z.number().int().min(1).default(30) }).default({}),
    nonce_ttl_s: z.number().int().min(60).default(600),
    max_skew_s: z.number().int().min(0).default(300),
    session_ttl_hours: z.number().int().min(1).default(12),
    stepup_max_age_s: z.number().int().min(30).default(300),
    checkin_retention_days: z.number().int().min(1).default(90),
    lookup_block: z.object({ failures: z.number().int().min(1).default(20), windowMs: z.number().int().default(3600_000), blockMs: z.number().int().default(24 * 3600_000) }).default({}),
    backup_dir: z.string().nullable().default('/var/backups/whm-hub'),
    backup_keep: z.number().int().min(1).default(48),
    mail: z.object({ from: z.string().default('whm-hub@localhost'), enabled: z.boolean().default(true), transport: z.enum(['sendmail', 'none']).default('sendmail') }).default({}),
    billing: z.object({
      stripe: z.object({ secret: z.string().optional() }).default({}),
      whmcs: z.object({ secret: z.string().optional() }).default({}),
      paddle: z.object({ secret: z.string().optional() }).default({}),
    }).default({}),
    rate_limits: z.object({
      activate: rateLimit(10, 3600_000),
      checkin: rateLimit(12, 3600_000),
      trial: rateLimit(3, 24 * 3600_000),
      recover: rateLimit(3, 3600_000),
      reseller: rateLimit(600, 3600_000),
      admin: rateLimit(1200, 3600_000),
      portal_login: rateLimit(10, 15 * 60_000),
      public: rateLimit(600, 3600_000),
    }).default({}),
    vendor: z.object({ name: z.string().default('WHM Vendor'), support_email: z.string().email().optional(), portal_url: z.string().url().optional() }).default({}),
  }).default({}).refine((l) => l.nonce_ttl_s >= 2 * l.max_skew_s, { message: 'nonce_ttl_s must be at least 2 × max_skew_s or a pruned nonce could be replayed', path: ['nonce_ttl_s'] }),
  marketplace: z.record(z.unknown()).default({}),
});

const ENV_MAP = {
  WHM_HUB_PUBLIC_URL: ['public_url'],
  WHM_HUB_SERVE_UI: ['serve_ui', 'bool'],
  WHM_HUB_HOST: ['host'],
  WHM_HUB_PORT: ['port', 'int'],
  WHM_HUB_LOOPBACK_PORT: ['loopback_port', 'int'],
  WHM_HUB_LOG_LEVEL: ['log_level'],
  WHM_HUB_DB_DIR: ['db_dir'],
  WHM_HUB_MASTER_KEY_FILE: ['master_key_file'],
  WHM_HUB_SESSION_SECRET: ['session_secret'],
  WHM_HUB_INSECURE_HTTP: ['insecure_http', 'bool'],
  WHM_HUB_TLS_CERT: ['tls.cert'],
  WHM_HUB_TLS_KEY: ['tls.key'],
  WHM_HUB_KEYS_DIR: ['keys.dir'],
  WHM_HUB_ACTIVE_LICENSE_KID: ['keys.active_kid.license'],
  WHM_HUB_ACTIVE_PLUGIN_KID: ['keys.active_kid.plugin'],
  WHM_HUB_MAIL_FROM: ['license.mail.from'],
  WHM_HUB_STRIPE_SECRET: ['license.billing.stripe.secret'],
  WHM_HUB_WHMCS_SECRET: ['license.billing.whmcs.secret'],
  WHM_HUB_PADDLE_SECRET: ['license.billing.paddle.secret'],
};

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = cur[p] = typeof cur[p] === 'object' && cur[p] !== null ? cur[p] : {};
  cur[parts.at(-1)] = value;
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(extra)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  return out;
}

export function loadConfig({ file, overrides = {}, env = process.env } = {}) {
  const confFile = file || env.WHM_HUB_CONFIG || '/etc/whm-hub/hub.conf';
  let fromFile = {};
  if (fs.existsSync(confFile)) {
    try { fromFile = JSON.parse(fs.readFileSync(confFile, 'utf8')); } catch (err) { throw new Error(`cannot parse ${confFile}: ${err.message}`); }
  }
  const fromEnv = {};
  for (const [name, [path, kind]] of Object.entries(ENV_MAP)) {
    if (env[name] == null || env[name] === '') continue;
    const raw = env[name];
    setPath(fromEnv, path, kind === 'int' ? Number(raw) : kind === 'bool' ? ['1', 'true', 'yes'].includes(raw.toLowerCase()) : raw);
  }
  const merged = deepMerge(deepMerge(fromFile, fromEnv), overrides);
  if (merged.tls && (!merged.tls.cert || !merged.tls.key)) merged.tls = null;
  const result = schema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '_'}: ${i.message}`).join('; ');
    throw new Error(`invalid hub configuration: ${issues}`);
  }
  return { ...result.data, config_file: confFile };
}

export { schema as configSchema };
