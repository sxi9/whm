import { z, fields } from '../lib/validate.js';
import { isValidCron } from '../lib/cron.js';

// The configuration cluster moves settings between peers key by key. Every
// key that may travel is listed here explicitly with the shape a peer must
// send; anything else (host identity, addresses, daemon selection, paths that
// are per-host state, timestamps, secrets) never leaves a server and is
// refused on arrival. `apply` names the owning service's validated update
// path, which stores the value and rewrites the daemon's configuration; keys
// without one are read from the settings table at runtime, so storing them is
// the whole change.

const int = (min, max) => z.number().int().min(min).max(max);
const bool = z.boolean();
const line = (max = 200) => z.string().max(max).regex(/^[^\r\n\0]*$/, 'Single line');
const emailOrEmpty = z.union([z.literal(''), fields.email]);
// Credentials embedded in a URL (https://user:pass@host/...) are a secret of
// the host that holds them: such a value is refused on receive and, since
// exportValue() runs the same schema, left out of what this server serves.
const withoutUserinfo = (v) => { if (v === '') return true; try { const u = new URL(v); return !u.username && !u.password; } catch { return false; } };
const httpsUrlOrEmpty = z.union([z.literal(''), z.string().max(500).regex(/^https?:\/\/[^\s\0'"<>]+$/, 'http(s) URL').refine(withoutUserinfo, 'A URL carrying credentials stays local')]);
const cron = fields.cron.refine((v) => isValidCron(v), 'Must be a valid 5-field cron expression');
const cipherList = z.string().max(2048).regex(/^[A-Za-z0-9:+!@_=-]*$/);
const cipherSuites = z.string().max(512).regex(/^[A-Za-z0-9_:]*$/);
const tlsVersion = z.enum(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']);
const homeRoot = fields.absPath.max(200).regex(/^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, 'A plain absolute directory such as /home');

const mpm = z.object({
  module: z.enum(['prefork', 'worker', 'event']), startServers: int(1, 10_000), minSpareServers: int(1, 10_000), maxSpareServers: int(1, 10_000),
  minSpareThreads: int(1, 100_000), maxSpareThreads: int(1, 100_000), threadsPerChild: int(1, 10_000), maxRequestWorkers: int(1, 100_000), maxConnectionsPerChild: int(0, 10_000_000), serverLimit: int(1, 20_000),
}).partial().strict();
// Apache's include. The per-host PHP default (defaultPhpVersion) is not part
// of it, and neither is customDirectives: free-form directives are code that
// a peer must never be able to write into this host's Apache configuration.
const apache = z.object({
  timeout: int(1, 86_400), keepAlive: bool, maxKeepAliveRequests: int(0, 100_000), keepAliveTimeout: int(1, 3600),
  serverTokens: z.enum(['Prod', 'Major', 'Minor', 'Min', 'OS', 'Full']), serverSignature: z.enum(['On', 'Off', 'EMail']), traceEnable: z.enum(['on', 'off', 'extended']), hostnameLookups: z.enum(['On', 'Off', 'Double']),
  serverAdmin: emailOrEmpty, directoryIndex: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)).min(1).max(20), fileETag: z.enum(['None', 'MTime Size', 'INode MTime Size', 'All']),
  limitRequestBody: int(0, 2_147_483_647), serverStatus: bool, mpm,
}).partial();
const logrotate = z.object({
  frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly', 'yearly']), rotate: int(0, 3650), compress: bool, delaycompress: bool, missingok: bool, notifempty: bool,
  dateext: bool, maxSize: z.union([z.literal(''), z.string().regex(/^\d{1,6}[kKmMgG]?$/)]), panelLogs: bool, accountLogs: bool, webServerLogs: bool, postrotateWeb: bool,
}).partial();
const webdisk = z.object({
  enabled: bool, port: int(1, 65535), sslPort: int(1, 65535), requireSsl: bool, allowDigestAuth: bool, allowAnonymousDiscovery: bool,
  maxUploadMb: int(1, 1_048_576), idleTimeoutMinutes: int(1, 1440), allowedAccounts: z.enum(['all', 'shell', 'none']),
}).partial();
// ipv6Listen depends on the host's addresses and stays local.
const webservices = z.object({
  apiEnabled: bool, tokenLifetimeMinutes: int(5, 525_600), sessionTimeoutMinutes: int(5, 10_080), maxConcurrentRequests: int(1, 100_000), rateLimitPerMinute: int(1, 1_000_000),
  allowedOrigins: z.array(z.string().max(253).regex(/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/)).max(50), enableCompression: bool, requestLogRetentionDays: int(1, 3650), exposeVersion: bool,
}).partial();
// The TLS block is handed over by SSL/TLS Configuration on each host and travels with the ssl group instead.
const exim = z.object({
  rblEnabled: bool, rbls: z.array(fields.hostname).max(20), domainRblEnabled: bool, domainRbls: z.array(fields.hostname).max(20),
  spfVerify: bool, spfReject: bool, dkimVerify: bool, dkimReject: bool, reverseDnsRequired: bool, verifySender: bool, requireHelo: bool,
  maxMessageSizeMb: int(1, 2048), smtpAcceptMax: int(1, 100_000), smtpAcceptMaxPerHost: int(1, 10_000), smtpAcceptQueuePerConnection: int(0, 10_000),
  ratelimitEnabled: bool, ratelimitMailThreshold: int(1, 100_000), ratelimitMailDelay: int(1, 300), ratelimitRcptThreshold: int(1, 100_000), ratelimitRcptDelay: int(1, 300),
  dictionaryAttackProtection: bool, maxUnknownCommands: int(0, 100), rcptFailLimit: int(1, 1000), rcptFailDelay: int(1, 300), recipientsMax: int(1, 100_000), recipientsMaxReject: bool,
  requireTlsForAuth: bool, logSelector: z.array(z.string().regex(/^[+-][a-z_]{1,40}$/)).max(40),
}).partial();
// Dovecot policy only: the TLS fields come from the ssl group and the on-disk
// mailbox layout (mailLocation, mailboxFormat) is per-host state.
const mailserver = z.object({
  protocols: z.array(z.enum(['imap', 'pop3', 'lmtp', 'sieve'])).min(1).max(4), maxUserIpConnections: int(1, 10_000), processLimit: int(1, 1_000_000), clientLimit: int(1, 1_000_000),
  ssl: z.enum(['yes', 'required', 'no']), disablePlaintextAuth: bool, loginGreeting: line(200), imapIdleNotifyIntervalMinutes: int(1, 60), pop3UidlFormat: z.string().max(64).regex(/^[A-Za-z0-9%._-]*$/),
}).partial();

const singleLine = (max) => z.string().max(max).regex(/^[^\r\n\0<>]*$/, 'A single line without angle brackets');
const hexColorOrEmpty = z.union([z.literal(''), z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'A #rgb or #rrggbb colour')]);
const httpUrlOrEmpty = z.union([z.literal(''), z.string().max(500).url().refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links').refine(withoutUserinfo, 'A URL carrying credentials stays local')]);
const themeSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
// What Market mirrors into market.providers: the resale catalogue of each SSL
// provider. Credentials and the enabled flag (which needs them) stay local.
const marketProduct = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), name: z.string().max(80).regex(/^[A-Za-z0-9 ._()&/-]*$/), price: z.number().min(0).max(1e6).nullable(), basePrice: z.number().min(0).max(1e6).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/), termMonths: int(1, 120), wildcard: bool,
}).partial({ price: true, basePrice: true, currency: true, termMonths: true, wildcard: true });
const marketProvider = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_.-]{0,31}$/), displayName: singleLine(80).min(1), enabled: bool, url: z.union([z.null(), z.string().max(512).regex(/^https:\/\/[^\s/$.?#][^\s]*$/i).refine(withoutUserinfo, 'A URL carrying credentials stays local')]),
  adapter: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), commissionPercent: z.number().min(0).max(100), products: z.array(marketProduct).max(50),
}).partial({ enabled: true, url: true, adapter: true, commissionPercent: true, products: true });

const bpkScope = z.enum(['non-root', 'accounts']);
const bpkSignal = z.enum(['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGHUP', 'SIGSTOP']);
const generator = z.enum(['awstats', 'webalizer', 'analog']);

export const CONFIG_GROUPS = {
  basic: { label: 'Basic setup', description: 'Contact address, nameservers, home root and default package. The hostname and addresses stay local.' },
  tweak: { label: 'Tweak settings', description: 'Mail limits, bandwidth and login behaviour.' },
  security: { label: 'Security policy', description: 'Password strength, brute-force protection, 2FA, login policy, security questions and SMTP restrictions. External authentication providers stay local.' },
  dns: { label: 'DNS defaults', description: 'TTLs, SOA timers and the SPF/DMARC/DKIM defaults. Resolvers and transfer ACLs stay local.' },
  mail: { label: 'Mail', description: 'Greylisting, filter messages and log defaults. Outbound addresses stay local.' },
  ssl: { label: 'SSL/TLS', description: 'AutoSSL settings and the TLS policy applied to Apache, Exim and Dovecot.' },
  backup: { label: 'Backups', description: 'Schedule, scope and retention; the local directory, destinations and their credentials stay local.' },
  software: { label: 'Software and updates', description: 'Update tier, automatic updates and the default PHP version. NGINX and EA4 profiles stay local.' },
  service_config: { label: 'Service configuration', description: 'Apache, Exim, Dovecot, logrotate, Web Disk and web services policy. Ports, bind addresses, FTP, the nameserver choice and custom Apache directives stay local.' },
  contacts: { label: 'Server contacts', description: 'Notification policy, checks and where system mail goes. The SMTP relay and its credentials stay local.' },
  system_health: { label: 'System health', description: 'Background process killer policy.' },
  stats: { label: 'Statistics', description: 'Log analysers and who may choose them.' },
  branding: { label: 'Branding and support', description: 'Customization (company name, colours, links, login notice), the default themes, Support Center settings and the Market catalogue. Logo and favicon files, provider credentials and whether a provider is enabled stay local.' },
};
// Groups shared when the operator has not chosen: the login policy and the
// update feed of a server are deliberately not replicated by default.
export const DEFAULT_GROUPS = Object.freeze(Object.keys(CONFIG_GROUPS).filter((g) => !['security', 'software'].includes(g)));

const K = {};
const def = (group, key, schema, apply = null) => { K[key] = { group, schema, apply }; };

def('basic', 'basic.contact_email', emailOrEmpty);
def('basic', 'basic.default_package', fields.packageName);
def('basic', 'basic.home_root', homeRoot);
def('basic', 'basic.nameservers', z.array(fields.hostname).max(4));

def('tweak', 'tweak.allow_remote_domains', bool);
def('tweak', 'tweak.login_theme', z.string().regex(/^[a-z0-9_-]{1,40}$/));
def('tweak', 'tweak.max_emails_per_hour', int(0, 1_000_000));
def('tweak', 'tweak.prevent_unlimited_bandwidth', bool);

def('security', 'security.2fa.required_for_root', bool);
def('security', 'security.cphulk.block_denylist_permanently', bool, 'cphulk');
def('security', 'security.cphulk.enabled', bool, 'cphulk');
def('security', 'security.cphulk.firewall_sync', bool, 'cphulk');
def('security', 'security.cphulk.history_retention_days', int(1, 3650), 'cphulk');
def('security', 'security.cphulk.lockout_minutes', int(1, 525_600), 'cphulk');
def('security', 'security.cphulk.max_failures_per_ip', int(1, 10_000), 'cphulk');
def('security', 'security.min_password_strength', int(0, 100));
for (const c of ['account', 'email', 'ftp', 'mysql', 'panel', 'ssh']) def('security', `security.password.strength.${c}`, int(0, 100).nullable());
def('security', 'security.policy.api_tokens_require_2fa', bool);
def('security', 'security.policy.disallow_concurrent_sessions', bool);
def('security', 'security.policy.password_max_age_days', int(0, 3650));
def('security', 'security.policy.require_2fa_for_resellers', bool);
def('security', 'security.policy.session_timeout_minutes', int(0, 525_600));
def('security', 'security.policy.verified_ip_login', bool);
def('security', 'security.questions.allow_custom', bool);
def('security', 'security.questions.enabled', bool);
def('security', 'security.questions.min_answer_length', int(1, 100));
def('security', 'security.questions.pool', z.array(line(200).min(1)).max(50));
def('security', 'security.questions.required_count', int(1, 10));
def('security', 'security.smtp_restrictions.enabled', bool, 'smtpRestrictions');

def('dns', 'dns.default_ttl', int(60, 2_592_000));
def('dns', 'dns.dkim_bits', z.union([z.literal(1024), z.literal(2048), z.literal(4096)]));
def('dns', 'dns.dkim_selector', z.string().regex(/^[a-z0-9_-]{1,63}$/));
def('dns', 'dns.dmarc_default', z.string().max(500).regex(/^v=DMARC1;[ -~]*$/, 'A DMARC record starting with v=DMARC1;'));
def('dns', 'dns.soa_expire', int(60, 31_536_000));
def('dns', 'dns.soa_minimum', int(60, 2_592_000));
def('dns', 'dns.soa_refresh', int(60, 31_536_000));
def('dns', 'dns.soa_retry', int(60, 31_536_000));
def('dns', 'dns.spf_default', z.string().max(500).regex(/^v=spf1[ -~]*$/, 'An SPF record starting with v=spf1'));

def('mail', 'mail.country_filter.message', line(200), 'filterMessages');
def('mail', 'mail.country_filter.source_url', httpsUrlOrEmpty);
def('mail', 'mail.domain_filter.message', line(200), 'filterMessages');
def('mail', 'mail.greylist.enabled', bool, 'greylist');
def('mail', 'mail.greylist.initial_delay_minutes', int(1, 1440), 'greylist');
def('mail', 'mail.greylist.message', line(200), 'greylist');
def('mail', 'mail.greylist.must_retry_hours', int(1, 168), 'greylist');
def('mail', 'mail.greylist.record_expires_days', int(1, 365), 'greylist');
def('mail', 'mail.log.default_window_hours', int(1, 720));

def('ssl', 'ssl.autossl.email', emailOrEmpty, 'autossl');
def('ssl', 'ssl.autossl.include_www', bool, 'autossl');
def('ssl', 'ssl.autossl.key_type', z.enum(['rsa', 'ecdsa']), 'autossl');
def('ssl', 'ssl.autossl.method', z.enum(['webroot', 'standalone']), 'autossl');
def('ssl', 'ssl.autossl.provider', z.enum(['disabled', 'certbot', 'acme.sh']), 'autossl');
def('ssl', 'ssl.autossl.renew_days', int(1, 89), 'autossl');
def('ssl', 'ssl.autossl.replace_custom', bool, 'autossl');
def('ssl', 'ssl.autossl.staging', bool, 'autossl');
def('ssl', 'ssl.tls.ciphers', cipherList, 'tls');
def('ssl', 'ssl.tls.ciphersuites', cipherSuites, 'tls');
def('ssl', 'ssl.tls.hsts_enabled', bool, 'tls');
def('ssl', 'ssl.tls.hsts_include_subdomains', bool, 'tls');
def('ssl', 'ssl.tls.hsts_max_age', int(0, 315_360_000), 'tls');
def('ssl', 'ssl.tls.hsts_preload', bool, 'tls');
def('ssl', 'ssl.tls.prefer_server_ciphers', bool, 'tls');
def('ssl', 'ssl.tls.preset', z.enum(['modern', 'intermediate', 'old', 'custom']), 'tls');
def('ssl', 'ssl.tls.protocols', z.array(tlsVersion).min(1).max(4), 'tls');
def('ssl', 'ssl.tls.services', z.array(z.enum(['apache', 'exim', 'dovecot', 'ftp', 'panel'])).max(5), 'tls');

def('backup', 'backup.compression_level', int(0, 9), 'backup');
def('backup', 'backup.default_include', bool, 'backup');
def('backup', 'backup.enabled', bool, 'backup');
def('backup', 'backup.excludes', z.array(z.string().min(1).max(200).regex(/^[^\0\r\n]+$/).refine((v) => !v.startsWith('/') && !v.split('/').includes('..'), 'Relative to the account home, without ".."')).max(100), 'backup');
for (const part of ['home', 'mail', 'dbs', 'dns', 'metadata']) def('backup', `backup.include_${part}`, bool, 'backup');
def('backup', 'backup.keep_local', bool, 'backup');
def('backup', 'backup.notify_on_failure', bool, 'backup');
def('backup', 'backup.prune_remote', bool, 'backup');
def('backup', 'backup.retention_daily', int(0, 3650), 'backup');
def('backup', 'backup.retention_monthly', int(0, 3650), 'backup');
def('backup', 'backup.retention_weekly', int(0, 3650), 'backup');
def('backup', 'backup.schedule', cron, 'backup');
def('backup', 'backup.skip_suspended', bool, 'backup');
def('backup', 'backup.strict', bool, 'backup');

def('software', 'php.default_version', z.string().regex(/^(?:ea-)?php\d{2,3}$|^\d\.\d{1,2}$|^system$/), 'phpDefault');
def('software', 'software.update_url', httpsUrlOrEmpty, 'panelUpdates');
def('software', 'software.updates.auto_os', bool, 'osUpdates');
def('software', 'updates.auto', bool, 'panelUpdates');
def('software', 'updates.notify_contact', bool);
def('software', 'updates.tier', z.enum(['stable', 'release', 'edge']), 'panelUpdates');

def('service_config', 'service_config.apache', apache, 'apache');
def('service_config', 'service_config.exim', exim, 'exim');
def('service_config', 'service_config.logrotate', logrotate, 'logrotate');
def('service_config', 'service_config.mailserver', mailserver, 'mailserver');
def('service_config', 'service_config.webdisk', webdisk, 'webdisk');
def('service_config', 'service_config.webservices', webservices, 'webservices');

def('contacts', 'contacts.check.cooldown_minutes', int(1, 10_080), 'contacts');
def('contacts', 'contacts.check.disk_threshold_percent', int(1, 100), 'contacts');
def('contacts', 'contacts.check.enabled', bool, 'contacts');
def('contacts', 'contacts.check.ssl_days', int(1, 365), 'contacts');
def('contacts', 'contacts.enabled', bool, 'contacts');
def('contacts', 'contacts.nobody_forward', z.array(fields.email).max(20), 'mailPreferences');
def('contacts', 'contacts.retention_days', int(1, 3650), 'contacts');
def('contacts', 'contacts.root_forward', z.array(fields.email).max(20), 'mailPreferences');
def('contacts', 'contacts.root_mail_events', z.array(z.string().regex(/^[a-z0-9_.-]{1,60}$/)).max(50), 'mailPreferences');
def('contacts', 'contacts.webhook.allow_private', bool, 'contacts');

def('system_health', 'system_health.bpk.enabled', bool, 'bpk');
def('system_health', 'system_health.bpk.exempt_users', z.array(fields.username).max(500), 'bpk');
def('system_health', 'system_health.bpk.notify', bool, 'bpk');
def('system_health', 'system_health.bpk.retention_days', int(1, 3650), 'bpk');
def('system_health', 'system_health.bpk.scope', bpkScope, 'bpk');
def('system_health', 'system_health.bpk.signal', bpkSignal, 'bpk');

def('stats', 'stats.allow_user_choice', bool, 'stats');
def('stats', 'stats.default_generator', generator, 'stats');
def('stats', 'stats.generators', z.object({ awstats: bool, webalizer: bool, analog: bool }).partial(), 'stats');
def('stats', 'stats.include_suspended', bool, 'stats');

def('branding', 'branding.chrome_color', hexColorOrEmpty, 'branding');
def('branding', 'branding.company_name', singleLine(80).min(1), 'branding');
def('branding', 'branding.docs_url', httpUrlOrEmpty, 'branding');
def('branding', 'branding.footer_text', singleLine(200), 'branding');
def('branding', 'branding.help_url', httpUrlOrEmpty, 'branding');
def('branding', 'branding.login_notice', z.string().max(2000).regex(/^[^\0]*$/), 'branding');
def('branding', 'branding.primary_color', hexColorOrEmpty, 'branding');
def('branding', 'branding.support_url', httpUrlOrEmpty, 'branding');
def('branding', 'branding.tagline', singleLine(120), 'branding');
def('branding', 'themes.account_default', themeSlug, 'themes');
def('branding', 'themes.allow_user_override', bool, 'themes');
def('branding', 'themes.default', themeSlug, 'themes');
def('branding', 'support.access.default_hours', int(1, 8760), 'support');
def('branding', 'support.access.max_hours', int(1, 8760), 'support');
def('branding', 'support.email', emailOrEmpty, 'support');
def('branding', 'support.portal_url', httpUrlOrEmpty, 'support');
def('branding', 'support.provider_name', singleLine(80), 'support');
def('branding', 'market.providers', z.array(marketProvider).max(50), 'market');

export const CONFIG_KEYS = Object.freeze(K);
export const GROUP_NAMES = Object.keys(CONFIG_GROUPS);
export const groupOfKey = (key) => CONFIG_KEYS[key]?.group ?? null;
export const isPushableKey = (key) => Object.hasOwn(CONFIG_KEYS, key);
export const keysOfGroup = (group) => Object.keys(CONFIG_KEYS).filter((k) => CONFIG_KEYS[k].group === group);

// Receiving is strict: a field this version does not know is refused rather
// than stored blindly. Exporting strips such fields (and the per-host ones
// listed above) so what leaves a server is exactly the allowlisted shape.
const strictOf = (schema) => (schema instanceof z.ZodObject ? schema.strict() : schema);
export function validateIncoming(key, value) {
  const d = CONFIG_KEYS[key];
  if (!d) return { ok: false, reason: 'not a shared setting' };
  const r = strictOf(d.schema).safeParse(value);
  if (!r.success) return { ok: false, reason: r.error.issues.map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).slice(0, 3).join('; ') };
  return { ok: true, value: r.data };
}
export function exportValue(key, value) {
  const d = CONFIG_KEYS[key];
  if (!d) return { ok: false };
  const r = d.schema.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false };
}

const camel = (key) => key.split('.').pop().replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
const pick = (values, prefix) => Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [camel(k), v]));
const missing = (name) => { const err = new Error(`The ${name} module is not loaded on this server; the value is stored and takes effect once it is`); err.status = 501; err.code = 'capability_missing'; return err; };
const need = (svc, name) => { if (!svc) throw missing(name); return svc; };

// One entry per `apply` name: (ctx, values { settingKey: value }, req) → the
// owning service's own result. Each owner validates again, stores and writes
// the host configuration; a CapabilityError means the daemon is absent.
export const APPLIERS = {
  cphulk: (ctx, v, req) => need(ctx.security?.cphulk, 'Security Center').updateSettings(pick(v, 'security.cphulk.'), req),
  smtpRestrictions: (ctx, v, req) => need(ctx.security?.smtp, 'Security Center').set(Boolean(v['security.smtp_restrictions.enabled']), req),
  filterMessages: (ctx, v, req) => need(ctx.mail?.filters, 'Email').setMessages({ country: v['mail.country_filter.message'], domain: v['mail.domain_filter.message'] }, req),
  greylist: (ctx, v, req) => need(ctx.mail?.greylist, 'Email').update(pick(v, 'mail.greylist.'), req),
  autossl: (ctx, v, req) => need(ctx.ssl?.autossl, 'SSL/TLS').updateSettings(pick(v, 'ssl.autossl.'), req),
  tls(ctx, v, req) {
    const tls = need(ctx.ssl?.tls, 'SSL/TLS');
    const S = (k) => (v[`ssl.tls.${k}`] !== undefined ? v[`ssl.tls.${k}`] : ctx.settings.get(`ssl.tls.${k}`));
    const input = { preset: S('preset'), protocols: S('protocols'), ciphers: S('ciphers'), ciphersuites: S('ciphersuites'), preferServerCiphers: S('prefer_server_ciphers'), services: S('services'), hsts: { enabled: S('hsts_enabled'), maxAge: S('hsts_max_age'), includeSubdomains: S('hsts_include_subdomains'), preload: S('hsts_preload') } };
    return tls.update(input, req);
  },
  backup: (ctx, v, req) => need(ctx.backup, 'Backup').updateConfig(v, req),
  phpDefault: (ctx, v, req) => need(ctx.software?.php, 'Software').setSystemDefault(v['php.default_version'], req?.user ?? null, req),
  panelUpdates: (ctx, v, req) => need(ctx.software?.panel, 'Software').updateSettings({ url: v['software.update_url'], tier: v['updates.tier'], autoUpdate: v['updates.auto'] }, req),
  osUpdates: (ctx, v, req) => need(ctx.software?.update, 'Software').setAuto(v['software.updates.auto_os'], req),
  apache: (ctx, v, req) => need(ctx.web?.apache, 'Service Configuration').update(v['service_config.apache'], req),
  exim: (ctx, v, req) => need(ctx.web?.exim, 'Service Configuration').update(v['service_config.exim'], req),
  logrotate: (ctx, v, req) => need(ctx.web?.logrotate, 'Service Configuration').update(v['service_config.logrotate'], req),
  mailserver: (ctx, v, req) => need(ctx.web?.mailserver, 'Service Configuration').update(v['service_config.mailserver'], req),
  webdisk: (ctx, v, req) => need(ctx.web?.webdisk, 'Service Configuration').update(v['service_config.webdisk'], req),
  webservices: (ctx, v, req) => need(ctx.web?.webservices, 'Service Configuration').update(v['service_config.webservices'], req),
  contacts(ctx, v, req) {
    const c = need(ctx.contacts, 'Server Contacts');
    const patch = { enabled: v['contacts.enabled'], retentionDays: v['contacts.retention_days'] };
    const check = pick(v, 'contacts.check.');
    if (Object.keys(check).length) patch.check = check;
    if (v['contacts.webhook.allow_private'] !== undefined) patch.webhook = { allowPrivate: v['contacts.webhook.allow_private'] };
    return c.updateSettings(patch, req);
  },
  mailPreferences(ctx, v, req) {
    const c = need(ctx.contacts, 'Server Contacts');
    const patch = { rootMailEvents: v['contacts.root_mail_events'] };
    if (v['contacts.root_forward'] !== undefined) patch.forwardTo = v['contacts.root_forward'];
    if (v['contacts.nobody_forward'] !== undefined) patch.users = { nobody: v['contacts.nobody_forward'] };
    return c.setMailPreferences(patch, req);
  },
  bpk: (ctx, v, req) => need(ctx.systemHealth, 'System Health').setConfig(pick(v, 'system_health.bpk.'), req),
  stats: (ctx, v, req) => need(ctx.serverConfig?.stats, 'Server Configuration').update(pick(v, 'stats.'), req),
  branding: (ctx, v, req) => need(ctx.cpanel?.branding, 'cPanel (Customization)').update(pick(v, 'branding.'), req),
  themes(ctx, v, req) {
    const t = need(ctx.themes, 'Themes');
    const patch = {};
    if (v['themes.default'] !== undefined) patch.default = v['themes.default'];
    if (v['themes.account_default'] !== undefined) patch.accountDefault = v['themes.account_default'];
    if (v['themes.allow_user_override'] !== undefined) patch.allowUserOverride = v['themes.allow_user_override'];
    return t.configure(patch, req);
  },
  support(ctx, v, req) {
    const s = need(ctx.support, 'Support');
    const patch = {};
    if (v['support.email'] !== undefined) patch.email = v['support.email'];
    if (v['support.provider_name'] !== undefined) patch.providerName = v['support.provider_name'];
    if (v['support.portal_url'] !== undefined) patch.portalUrl = v['support.portal_url'];
    const access = pick(v, 'support.access.');
    if (Object.keys(access).length) patch.access = access;
    return s.updateSettings(patch, req);
  },
  // The provider table is Market's source of truth and the setting only mirrors
  // it, so the catalogue is applied provider by provider to the ones that exist
  // here. A provider this host does not have needs an adapter and credentials
  // that never travel, so it is reported rather than created.
  market(ctx, v, req) {
    const m = need(ctx.market, 'Market');
    const local = new Map((m.sslProviders?.() ?? []).map((p) => [p.name, p]));
    const skipped = [];
    for (const p of v['market.providers'] ?? []) {
      if (!local.has(p.name)) { skipped.push(p.name); continue; }
      const patch = { displayName: p.displayName };
      if (p.url !== undefined) patch.url = p.url;
      if (p.commissionPercent !== undefined) patch.commissionPercent = p.commissionPercent;
      if (p.products !== undefined) patch.products = p.products.map(({ basePrice, price, ...rest }) => ({ ...rest, price: basePrice ?? price ?? null }));
      m.update(p.name, patch, req);
    }
    if (skipped.length) { const err = new Error(`not created here (add the provider with its credentials first): ${skipped.join(', ')}`); err.code = 'unsupported'; err.status = 422; throw err; }
    return { live: true };
  },
};
