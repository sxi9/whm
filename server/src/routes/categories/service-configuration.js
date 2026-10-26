import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot } from '../../middleware/rbac.js';
import { createServiceConfigService, FTP_SERVERS, DNS_SERVERS, SSL_SERVICES, TLS_VERSIONS } from '../../services/service-configuration.js';

// OpenSSL cipher-list / TLS 1.3 suite syntax: no whitespace or shell/config metacharacters.
const cipherList = z.string().max(2048).regex(/^[A-Za-z0-9:+!@_=-]*$/, 'OpenSSL cipher list such as ECDHE-RSA-AES256-GCM-SHA384:!aNULL');
const cipherSuites = z.string().max(512).regex(/^[A-Za-z0-9_:]*$/, 'Colon-separated TLS_* suite names');

const PEM_BODY = '[A-Za-z0-9+/=\\r\\n ]+';
const pemBlock = (label) => new RegExp(`^\\s*-----BEGIN ${label}-----\\r?\\n${PEM_BODY}-----END ${label}-----\\s*$`);
const keyPem = z.string().max(64 * 1024).regex(pemBlock('(?:RSA |EC |ENCRYPTED )?PRIVATE KEY'), 'Must be one PEM private key');
const certPem = z.string().max(64 * 1024).regex(pemBlock('CERTIFICATE'), 'Must be one PEM certificate');
const chainPem = z.string().max(256 * 1024).regex(new RegExp(`^\\s*(?:-----BEGIN CERTIFICATE-----\\r?\\n${PEM_BODY}-----END CERTIFICATE-----\\s*)+$`), 'Must be one or more PEM certificates');
const freeText = z.string().max(256 * 1024).regex(/^[^\0]*$/s);
const sizeSpec = z.string().regex(/^\d{1,6}[kKmMgG]?$/, 'Size such as 100M');
const int = (min, max) => z.number().int().min(min).max(max);

const mpmBody = z.object({
  module: z.enum(['prefork', 'worker', 'event']).optional(), startServers: int(1, 10_000).optional(), minSpareServers: int(1, 10_000).optional(), maxSpareServers: int(1, 10_000).optional(),
  minSpareThreads: int(1, 100_000).optional(), maxSpareThreads: int(1, 100_000).optional(), threadsPerChild: int(1, 10_000).optional(), maxRequestWorkers: int(1, 100_000).optional(), maxConnectionsPerChild: int(0, 10_000_000).optional(), serverLimit: int(1, 20_000).optional(),
}).strict();
const apacheBody = z.object({
  timeout: int(1, 86_400).optional(), keepAlive: z.boolean().optional(), maxKeepAliveRequests: int(0, 100_000).optional(), keepAliveTimeout: int(1, 3600).optional(),
  serverTokens: z.enum(['Prod', 'Major', 'Minor', 'Min', 'OS', 'Full']).optional(), serverSignature: z.enum(['On', 'Off', 'EMail']).optional(), traceEnable: z.enum(['on', 'off', 'extended']).optional(), hostnameLookups: z.enum(['On', 'Off', 'Double']).optional(),
  serverAdmin: z.union([z.literal(''), fields.email]).optional(), directoryIndex: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)).min(1).max(20).optional(), fileETag: z.enum(['None', 'MTime Size', 'INode MTime Size', 'All']).optional(),
  limitRequestBody: int(0, 2_147_483_647).optional(), serverStatus: z.boolean().optional(), mpm: mpmBody.optional(), customDirectives: freeText.optional(), defaultPhpVersion: z.string().regex(/^(?:ea-)?php\d{2,3}$|^\d\.\d{1,2}$|^system$/).nullable().optional(),
}).strict();

const logrotateBody = z.object({
  frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly', 'yearly']).optional(), rotate: int(0, 3650).optional(), compress: z.boolean().optional(), delaycompress: z.boolean().optional(), missingok: z.boolean().optional(), notifempty: z.boolean().optional(),
  dateext: z.boolean().optional(), maxSize: z.union([z.literal(''), sizeSpec]).optional(), panelLogs: z.boolean().optional(), accountLogs: z.boolean().optional(), webServerLogs: z.boolean().optional(), postrotateWeb: z.boolean().optional(),
}).strict();

const webdiskBody = z.object({
  enabled: z.boolean().optional(), port: int(1, 65535).optional(), sslPort: int(1, 65535).optional(), requireSsl: z.boolean().optional(), allowDigestAuth: z.boolean().optional(), allowAnonymousDiscovery: z.boolean().optional(),
  maxUploadMb: int(1, 1_048_576).optional(), idleTimeoutMinutes: int(1, 1440).optional(), allowedAccounts: z.enum(['all', 'shell', 'none']).optional(),
}).strict();

const webservicesBody = z.object({
  apiEnabled: z.boolean().optional(), tokenLifetimeMinutes: int(5, 525_600).optional(), sessionTimeoutMinutes: int(5, 10_080).optional(), maxConcurrentRequests: int(1, 100_000).optional(), rateLimitPerMinute: int(1, 1_000_000).optional(),
  allowedOrigins: z.array(z.string().max(253).regex(/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/, 'Origin such as https://panel.example.com')).max(50).optional(), enableCompression: z.boolean().optional(), requestLogRetentionDays: int(1, 3650).optional(), exposeVersion: z.boolean().optional(), ipv6Listen: z.boolean().optional(),
}).strict();

const eximBody = z.object({
  rblEnabled: z.boolean().optional(), rbls: z.array(fields.hostname).max(20).optional(), domainRblEnabled: z.boolean().optional(), domainRbls: z.array(fields.hostname).max(20).optional(),
  spfVerify: z.boolean().optional(), spfReject: z.boolean().optional(), dkimVerify: z.boolean().optional(), dkimReject: z.boolean().optional(), reverseDnsRequired: z.boolean().optional(), verifySender: z.boolean().optional(), requireHelo: z.boolean().optional(),
  maxMessageSizeMb: int(1, 2048).optional(), smtpAcceptMax: int(1, 100_000).optional(), smtpAcceptMaxPerHost: int(1, 10_000).optional(), smtpAcceptQueuePerConnection: int(0, 10_000).optional(),
  ratelimitEnabled: z.boolean().optional(), ratelimitMailThreshold: int(1, 100_000).optional(), ratelimitMailDelay: int(1, 300).optional(), ratelimitRcptThreshold: int(1, 100_000).optional(), ratelimitRcptDelay: int(1, 300).optional(),
  dictionaryAttackProtection: z.boolean().optional(), maxUnknownCommands: int(0, 100).optional(), rcptFailLimit: int(1, 1000).optional(), rcptFailDelay: int(1, 300).optional(), recipientsMax: int(1, 100_000).optional(), recipientsMaxReject: z.boolean().optional(),
  requireTlsForAuth: z.boolean().optional(), logSelector: z.array(z.string().regex(/^[+-][a-z_]{1,40}$/, 'log_selector item such as +subject')).max(40).optional(),
  // Normally handed over by SSL/TLS Configuration (ctx.web.applyEximTls); null drops the TLS options from the rendered file.
  tls: z.object({ minProtocol: z.enum(TLS_VERSIONS).optional(), protocols: z.array(z.enum(TLS_VERSIONS)).min(1).max(4).optional(), cipherList: cipherList.optional(), cipherSuites: cipherSuites.optional(), preferServerCiphers: z.boolean().optional() }).strict().nullable().optional(),
}).strict();

const mailserverBody = z.object({
  protocols: z.array(z.enum(['imap', 'pop3', 'lmtp', 'sieve'])).max(4).optional(), maxUserIpConnections: int(1, 10_000).optional(), processLimit: int(1, 1_000_000).optional(), clientLimit: int(1, 1_000_000).optional(),
  ssl: z.enum(['yes', 'required', 'no']).optional(), sslMinProtocol: z.enum(TLS_VERSIONS).optional(), sslCipherList: cipherList.optional(), sslCipherSuites: cipherSuites.optional(), sslPreferServerCiphers: z.boolean().optional(), disablePlaintextAuth: z.boolean().optional(),
  loginGreeting: z.string().max(200).regex(/^[^\n\r\0]*$/, 'Single line').optional(), imapIdleNotifyIntervalMinutes: int(1, 60).optional(), pop3UidlFormat: z.string().max(64).regex(/^[A-Za-z0-9%._-]*$/).optional(),
  mailLocation: z.string().max(200).regex(/^(maildir|mbox|mdbox|sdbox):[A-Za-z0-9~%/._:-]+$/, 'Dovecot mail_location such as maildir:~/mail').optional(), mailboxFormat: z.enum(['maildir', 'mbox', 'mdbox', 'sdbox']).optional(),
}).strict();

const ftpBody = z.object({
  passivePortMin: int(1024, 65535).optional(), passivePortMax: int(1024, 65535).optional(), passiveAddress: z.union([z.literal(''), fields.ipv4]).optional(), tls: z.enum(['off', 'optional', 'required']).optional(),
  maxClients: int(1, 100_000).optional(), maxPerIp: int(1, 10_000).optional(), anonymous: z.boolean().optional(), idleTimeoutMinutes: int(1, 1440).optional(), chroot: z.boolean().optional(),
}).strict();

const policyName = z.enum(['panel', 'accounts', 'webserver']);
const serviceName = z.enum(SSL_SERVICES);

export async function register(ctx) {
  ctx.web = createServiceConfigService(ctx);
  ctx.ftp = ctx.web.ftp;
  ctx.capabilities.register('logrotate', { binaries: ['logrotate'], required: ['logrotate'] });
  ctx.capabilities.register('powerdns', { binaries: ['pdns_server', 'pdns_control', 'pdnsutil'], required: ['pdns_server'] });
  ctx.jobs.register('web.vhosts.sync', (job) => ctx.web.syncAllJob(job));

  const w = () => ctx.web;
  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const accepted = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(d?.job || d?.pending ? 202 : 200).json({ data: d })).catch(next);

  r.get('/status', requireRoot, wrap(() => w().status()));

  // Apache Configuration
  r.get('/apache', requireRoot, wrap(() => w().apache.get()));
  r.put('/apache', requireRoot, validate({ body: apacheBody }), wrap((req) => w().apache.update(req.body, req)));
  r.post('/apache/configtest', requireRoot, validate({ body: apacheBody }), wrap((req) => w().apache.configtest(req.body)));
  r.post('/apache/reload', requireRoot, wrap((req) => w().apache.reload(req)));
  r.post('/apache/restart', requireRoot, wrap((req) => w().apache.restart(req)));
  r.get('/apache/vhosts', requireRoot, wrap(() => w().apache.vhosts.list()));
  r.get('/apache/vhosts/:domain', requireRoot, validate({ params: z.object({ domain: fields.hostname }) }), wrap((req) => w().apache.vhosts.read(req.params.domain)));
  r.post('/apache/vhosts/sync', requireRoot, validate({ body: z.object({ username: fields.username.optional() }).strict() }), accepted((req) => (req.body.username ? w().apache.vhosts.sync(req.body.username, req) : w().apache.vhosts.syncAll(req.user, req))));

  // cPanel Log Rotation Configuration
  r.get('/logrotate', requireRoot, wrap(() => w().logrotate.get()));
  r.put('/logrotate', requireRoot, validate({ body: logrotateBody }), wrap((req) => w().logrotate.update(req.body, req)));
  r.post('/logrotate/:name/run', requireRoot, validate({ params: z.object({ name: policyName }), body: z.object({ force: z.boolean().default(false) }).strict() }), wrap((req) => w().logrotate.run(req.params.name, req.body.force, req)));

  // cPanel Web Disk / Web Services Configuration
  r.get('/webdisk', requireRoot, wrap(() => w().webdisk.get()));
  r.put('/webdisk', requireRoot, validate({ body: webdiskBody }), wrap((req) => w().webdisk.update(req.body, req)));
  r.get('/webservices', requireRoot, wrap(() => w().webservices.get()));
  r.put('/webservices', requireRoot, validate({ body: webservicesBody }), wrap((req) => w().webservices.update(req.body, req)));

  // Exim Configuration Manager
  r.get('/exim', requireRoot, wrap(() => w().exim.get()));
  r.put('/exim', requireRoot, validate({ body: eximBody }), wrap((req) => w().exim.update(req.body, req)));

  // Mailserver Configuration (Dovecot)
  r.get('/mailserver', requireRoot, wrap(() => w().mailserver.get()));
  r.put('/mailserver', requireRoot, validate({ body: mailserverBody }), wrap((req) => w().mailserver.update(req.body, req)));

  // FTP Server Selection (+ daemon settings)
  r.get('/ftp', requireRoot, wrap(() => w().ftp.get()));
  r.put('/ftp/server', requireRoot, validate({ body: z.object({ server: z.enum(FTP_SERVERS), install: z.boolean().default(false) }).strict() }), accepted((req) => w().ftp.select(req.body, req.user, req)));
  r.put('/ftp/settings', requireRoot, validate({ body: ftpBody }), wrap((req) => w().ftp.updateSettings(req.body, req)));

  // Nameserver Selection
  r.get('/nameserver', requireRoot, wrap(() => w().nameserver.get()));
  r.put('/nameserver', requireRoot, validate({ body: z.object({ server: z.enum(DNS_SERVERS), role: z.enum(['master', 'slave', 'standalone']).default('master'), install: z.boolean().default(false) }).strict() }), accepted((req) => w().nameserver.select(req.body, req.user, req)));

  // Manage Service SSL Certificates
  r.get('/service-certs', requireRoot, wrap(() => w().certs.list()));
  r.post('/service-certs/:service', requireRoot, validate({ params: z.object({ service: serviceName }), body: z.object({ certPem, keyPem, chainPem: chainPem.optional() }).strict() }), wrap((req) => w().certs.install(req.params.service, req.body, req)));
  r.post('/service-certs/:service/self-signed', requireRoot, validate({ params: z.object({ service: serviceName }), body: z.object({ days: int(1, 3650).default(365) }).strict() }), wrap((req) => w().certs.reset(req.params.service, req.body, req)));

  return { path: '/service-config', router: r };
}
