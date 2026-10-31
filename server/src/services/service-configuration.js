import { isIP } from 'node:net';
import { json } from '../db/index.js';
import { notFound, badRequest, conflict, unprocessable, CapabilityError } from '../lib/errors.js';

// Service Configuration. Attached as ctx.web (ctx.ftp aliases ctx.web.ftp);
// other categories may call:
//   web.detect() / web.status()
//   web.ensureVhost(username, req)                  -> render every vhost of an account (main + addon/sub; parked/alias as ServerAlias)
//                                                       never throws for a missing Apache: { applied: false, reason: 'capability_missing' }
//   web.syncAccount(username, req)                  -> alias of ensureVhost
//   web.removeAccount(username, req)                -> delete the account's vhosts and PHP-FPM pool
//   web.applySsl(domain, paths, req) / web.removeSsl(domain, req)      paths = { cert, key, chain?, fullchain? }
//   web.setRedirects(domain, [{ from, to, type, matchWww, keepPath }], req)
//   web.addAlias({ username, domain, alias, docroot }, req) / web.removeAlias({ username, alias }, req)
//   web.setAccountIpv6(username, address|null, req)
//   web.replaceIp(from, to, { accounts }, req)      -> { updated }
//   web.setPhpVersion(domain, version|null, req)    -> version as '8.3' or 'ea-php83'; per domain, kept across syncs
//   web.writePhpPool(username, version, settings, req)
//   web.setListenPorts({ http, https|null, bind|null }, req)  -> bind pins Listen and every vhost to that address
//   web.reload(req) / web.restart(req) / web.configtest()
//   web.ftp.setPassiveAddress({ ipv4 }, req)
//   web.ensureEximAclChain()                        -> email: makes sure the RCPT ACL chain (and its macro) exists before it writes its filters file
//   web.applyEximTls({ minProtocol, protocols, cipherList, cipherSuites, preferServerCiphers }, req)   -> ssl-tls presets for Exim
//   web.applyMailserverTls({ minProtocol, cipherList, cipherSuites, preferServerCiphers }, req)       -> ssl-tls presets for Dovecot
//   web.ensureHostnameVhost(req, { hostname? })      -> the 'server' vhost for the server's own name (branded landing page under
//                                                       web.landingDocroot); never throws: { applied, reason?, landingPage, defaultVhost }
//   web.ensureDefaultVhost(req, { hostname? })       -> the catch-all vhost (Debian conf-enabled/000-whm-default.conf, RHEL conf.d/+whm-default.conf:
//                                                       the landing page for the bare address and names no site claims, :80 and :443); never throws
//   web.removeDefaultVhost(req)                      -> delete the catch-all vhost file
//   web.removeDomain(domain, req)                    -> delete one domain's vhost (file + row), never the hostname's; account-functions
//                                                       calls it when an addon/sub domain is removed
//   web.forceHttps()                                 -> whether vhosts with a certificate redirect HTTP to HTTPS (setting web.force_https)
//   web.isServerName(domain)                         -> true for the server hostname and www.<hostname>: the vhost layer refuses to host
//                                                       them for an account (409), and accounts/domains must refuse them at creation
// The ones that change a live vhost/daemon persist the change first and then throw
// CapabilityError('apache' | 'ftp') when the daemon is missing; consumers map that
// to 'pending' / 'saved' (dns-functions, ip-functions, ssl-tls all do) and the next
// sync applies the stored spec. ensureVhost/syncAccount never throw for a missing
// Apache: { applied: false, reason: 'capability_missing' }.

export const DEFAULTS = {
  apache: { timeout: 300, keepAlive: true, maxKeepAliveRequests: 100, keepAliveTimeout: 5, serverTokens: 'Prod', serverSignature: 'Off', traceEnable: 'off', hostnameLookups: 'Off', serverAdmin: '', directoryIndex: ['index.php', 'index.html', 'index.htm'], fileETag: 'None', limitRequestBody: 0, serverStatus: true, mpm: { module: 'event', startServers: 2, minSpareServers: 5, maxSpareServers: 10, minSpareThreads: 25, maxSpareThreads: 75, threadsPerChild: 25, maxRequestWorkers: 150, maxConnectionsPerChild: 0, serverLimit: 16 }, customDirectives: '', defaultPhpVersion: null },
  logrotate: { frequency: 'daily', rotate: 14, compress: true, delaycompress: true, missingok: true, notifempty: true, dateext: false, maxSize: '', panelLogs: true, accountLogs: true, webServerLogs: false, postrotateWeb: true },
  webdisk: { enabled: true, port: 2077, sslPort: 2078, requireSsl: true, allowDigestAuth: true, allowAnonymousDiscovery: false, maxUploadMb: 2048, idleTimeoutMinutes: 30, allowedAccounts: 'all' },
  webservices: { apiEnabled: true, tokenLifetimeMinutes: 1440, sessionTimeoutMinutes: 60, maxConcurrentRequests: 200, rateLimitPerMinute: 600, allowedOrigins: [], enableCompression: true, requestLogRetentionDays: 30, exposeVersion: false, ipv6Listen: true },
  // `tls` is null until SSL/TLS Configuration hands a preset over (applyEximTls); nothing TLS-related is rendered before that.
  exim: { rblEnabled: true, rbls: ['zen.spamhaus.org', 'bl.spamcop.net'], domainRblEnabled: false, domainRbls: ['dbl.spamhaus.org'], spfVerify: true, spfReject: false, dkimVerify: true, dkimReject: false, reverseDnsRequired: false, verifySender: true, requireHelo: true, maxMessageSizeMb: 50, smtpAcceptMax: 100, smtpAcceptMaxPerHost: 10, smtpAcceptQueuePerConnection: 10, ratelimitEnabled: true, ratelimitMailThreshold: 10, ratelimitMailDelay: 1, ratelimitRcptThreshold: 50, ratelimitRcptDelay: 1, dictionaryAttackProtection: true, maxUnknownCommands: 3, rcptFailLimit: 4, rcptFailDelay: 10, recipientsMax: 100, recipientsMaxReject: true, requireTlsForAuth: true, logSelector: ['+smtp_connection', '+subject', '+tls_cipher'], tls: null },
  mailserver: { protocols: ['imap', 'pop3', 'lmtp'], maxUserIpConnections: 20, processLimit: 1000, clientLimit: 1000, ssl: 'required', sslMinProtocol: 'TLSv1.2', sslCipherList: '', sslCipherSuites: '', sslPreferServerCiphers: false, disablePlaintextAuth: true, loginGreeting: '', imapIdleNotifyIntervalMinutes: 2, pop3UidlFormat: '%08Xu%08Xv', mailLocation: 'maildir:~/mail', mailboxFormat: 'maildir' },
  ftp: { passivePortMin: 49152, passivePortMax: 65534, passiveAddress: '', tls: 'optional', maxClients: 50, maxPerIp: 8, anonymous: false, idleTimeoutMinutes: 15, chroot: true },
  nameserver: { server: 'bind', role: 'master' },
};

export const FTP_SERVERS = ['pure-ftpd', 'proftpd', 'vsftpd', 'disabled'];
export const DNS_SERVERS = ['bind', 'powerdns', 'disabled'];
export const SSL_SERVICES = ['exim', 'dovecot', 'apache', 'ftp', 'panel'];
const MANAGED = '# Managed by WHM panel';
// Apache writes per-domain logs as root, so they live in a root-owned tree the
// account can only read; /home/<user>/logs keeps the PHP-FPM error log the pool
// writes as the account.
export const DOMLOGS_ROOT = '/var/log/whm/domlogs';
export const domlogDir = (username) => `${DOMLOGS_ROOT}/${username}`;
// The server hostname's own vhost: no account behind it, served as Apache's run
// user from a root-owned docroot that holds the branded landing page.
export const LANDING_DOCROOT = '/var/www/whm-default';
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fallbackLanding = (name) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(name)}</title></head>
<body><main><h1>Ready to launch</h1><p>${escapeHtml(name)} is managed with Hostingsignal Panel. Sites hosted here publish by uploading to their account's <code>public_html</code>.</p></main></body></html>
`;
// /home/<user>/logs is owned and writable by the tenant, so logrotate must act
// there as that tenant (one `su <user>` stanza per account), never as root over
// a glob; only the root-owned domlogs tree is rotated as root.
const LOGROTATE_POLICIES = {
  panel: { paths: ['/var/log/whm/*.log'], copytruncate: true, postrotate: 'none' },
  accounts: { paths: [`${DOMLOGS_ROOT}/*/*.log`], su: { user: 'root', group: 'root' }, postrotate: 'apache-reload', perAccount: { subpath: 'logs/*.log', postrotate: 'none' } },
  webserver: { paths: ['/var/log/apache2/*.log', '/var/log/httpd/*log', '/var/log/nginx/*.log'], su: { user: 'root', group: 'root' }, postrotate: 'apache-reload' },
};

// 'ea-php83' / 'php83' / '8.3' -> '8.3'; 'system' is the single stock tree a
// RHEL host ships under /etc/php-fpm.d.
export function phpVersionId(value) {
  if (!value) return null;
  if (value === 'system') return 'system';
  const m = String(value).match(/^(?:ea-)?php(\d)(\d{1,2})$/) || String(value).match(/^(\d)\.(\d{1,2})$/);
  return m ? `${m[1]}.${m[2]}` : null;
}

// Which ACL conditions the installed Exim understands; unknown (no detect
// result or no "Support for:" line) means render everything.
export function eximSupport(layout) {
  const has = (f) => (Array.isArray(layout?.features) ? layout.features.includes(f) : true);
  return { spf: layout?.support?.spf ?? has('SPF'), dkim: layout?.support?.dkim ?? has('DKIM') };
}

// The TLS library Exim was built with decides the tls_require_ciphers syntax:
// GnuTLS (Debian/Ubuntu) takes a priority string, OpenSSL (RHEL) a cipher list.
export function eximTlsLibrary(layout) {
  if (layout?.support?.tls) return layout.support.tls;
  const features = Array.isArray(layout?.features) ? layout.features : null;
  if (features?.some((f) => /\bGnuTLS\b/.test(f))) return 'gnutls';
  if (features?.some((f) => /\bOpenSSL\b/.test(f))) return 'openssl';
  return layout?.flavor === 'debian' ? 'gnutls' : 'openssl';
}

export const TLS_VERSIONS = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
const GNUTLS_VERSIONS = { TLSv1: 'VERS-TLS1.0', 'TLSv1.1': 'VERS-TLS1.1', 'TLSv1.2': 'VERS-TLS1.2', 'TLSv1.3': 'VERS-TLS1.3' };

// Normalises a preset from SSL/TLS Configuration ({ minProtocol, protocols?,
// cipherList, cipherSuites, preferServerCiphers }) into what is stored.
export function tlsPolicyFrom(p) {
  if (!p) return null;
  const hasMin = p.minProtocol != null;
  if (hasMin && !TLS_VERSIONS.includes(p.minProtocol)) throw badRequest(`minProtocol must be one of ${TLS_VERSIONS.join(', ')}`);
  const protocols = Array.isArray(p.protocols) && p.protocols.length ? TLS_VERSIONS.filter((v) => p.protocols.includes(v)) : hasMin ? TLS_VERSIONS.slice(TLS_VERSIONS.indexOf(p.minProtocol)) : [];
  const minProtocol = hasMin ? p.minProtocol : protocols[0];
  if (!minProtocol || !protocols.length) throw badRequest(`A TLS policy needs minProtocol or protocols out of ${TLS_VERSIONS.join(', ')}`);
  return { minProtocol, protocols, cipherList: String(p.cipherList || ''), cipherSuites: String(p.cipherSuites || ''), preferServerCiphers: Boolean(p.preferServerCiphers) };
}

// Exim has no tls_prefer_server_ciphers: server preference is an openssl_options
// flag or %SERVER_PRECEDENCE in a GnuTLS priority string, and a GnuTLS build
// cannot take an OpenSSL cipher list, so only the floor and preference apply there.
export function renderEximTls(tls, library) {
  const lines = [`# TLS policy from SSL/TLS Configuration: minimum ${tls.minProtocol}${library === 'gnutls' ? ' (GnuTLS build: priority string, the cipher list cannot be translated)' : ''}.`];
  if (library === 'gnutls') {
    const priority = ['NORMAL', '-VERS-ALL', ...tls.protocols.map((v) => `+${GNUTLS_VERSIONS[v]}`), ...(tls.preferServerCiphers ? ['%SERVER_PRECEDENCE'] : [])];
    lines.push(`tls_require_ciphers = ${priority.join(':')}`);
  } else {
    if (tls.cipherList) lines.push(`tls_require_ciphers = ${tls.cipherList}`);
    const options = ['+no_sslv2', '+no_sslv3', ...TLS_VERSIONS.filter((v) => !tls.protocols.includes(v)).map((v) => `+no_${v.toLowerCase().replace('.', '_')}`), '+single_dh_use', '+no_ticket', ...(tls.preferServerCiphers ? ['+cipher_server_preference'] : [])];
    lines.push(`openssl_options = ${options.join(' ')}`);
  }
  return lines;
}

// ------------------------------------------------------------ renderers ---

const macro = (name, value) => [`.ifndef ${name}`, `${name} = ${value}`, '.endif'];
const SENTINEL = 'WHM_SERVICE_CONFIG';

// On Debian the stock acl_check_rcpt only *warns* (adds a header) for
// CHECK_RCPT_IP_DNSBLS / CHECK_RCPT_DOMAIN_DNSBLS / CHECK_RCPT_REVERSE_DNS and
// hard-rejects for CHECK_RCPT_SPF, so the real deny rules live in the RCPT
// chain on every layout; the macros here only tag and hook the fragments in.
// The same text goes into conf.d/main (split) or a localmacros block (unsplit):
// both are the main section, read before the distribution's own options.
// The sentinel macro lets the agent prove the slot is part of the generated
// configuration (`exim -bP macro WHM_SERVICE_CONFIG`).
export function renderEximMain(s, layout, support = eximSupport(layout)) {
  const debian = layout?.flavor === 'debian';
  const lines = [`${MANAGED} (Exim Configuration Manager: main options). Edit through the panel; manual changes are overwritten.`, `${layout?.sentinel || SENTINEL} = 1`];
  if (debian) {
    lines.push(...macro('MESSAGE_SIZE_LIMIT', `${s.maxMessageSizeMb}M`));
    lines.push('# The deny rules for RBLs, reverse DNS, HELO, sender verification and SPF are in the RCPT fragment below;', '# Debian\'s own CHECK_RCPT_* handling of these macros only adds X-Warning headers (SPF excepted).');
    if (s.rblEnabled && s.rbls.length) lines.push(...macro('CHECK_RCPT_IP_DNSBLS', s.rbls.join(' : ')));
    if (s.domainRblEnabled && s.domainRbls.length) lines.push(...macro('CHECK_RCPT_DOMAIN_DNSBLS', s.domainRbls.join(' : ')));
    if (s.spfVerify && s.spfReject && support.spf) lines.push(...macro('CHECK_RCPT_SPF', 'true'));
    else if (s.spfVerify && !support.spf) lines.push('# SPF is not compiled into this Exim build (exim4-daemon-light); install exim4-daemon-heavy for SPF checks.');
    if (s.reverseDnsRequired) lines.push(...macro('CHECK_RCPT_REVERSE_DNS', 'true'));
    if (s.verifySender) lines.push(...macro('CHECK_RCPT_VERIFY_SENDER', 'true'));
    // This is the single local RCPT hook both mail features share: the chain
    // file ends with an include of the Email category's filters. A definition
    // another component made first (the Email fallback macro from before this
    // module existed, or the admin's) is left alone and reported by detect.
    lines.push('# Hooks the RCPT ACL chain (panel protections + Email filters) into acl_check_rcpt.', ...macro('CHECK_RCPT_LOCAL_ACL_FILE', layout.slots.acl_rcpt.path));
    if (s.dkimVerify && support.dkim) lines.push(...macro('CHECK_DATA_LOCAL_ACL_FILE', layout.slots.acl_data.path));
    if (!s.requireTlsForAuth) lines.push(...macro('AUTH_SERVER_ALLOW_NOTLS_PASSWORDS', 'true'));
    if (s.logSelector.length) lines.push(...macro('MAIN_LOG_SELECTOR', s.logSelector.join(' ')));
  } else {
    lines.push(`message_size_limit = ${s.maxMessageSizeMb}M`);
    lines.push(`auth_advertise_hosts = ${s.requireTlsForAuth ? '${if eq{$tls_in_cipher}{}{}{*}}' : '*'}`);
    if (s.logSelector.length) lines.push(`log_selector = ${s.logSelector.join(' ')}`);
  }
  lines.push(`smtp_accept_max = ${s.smtpAcceptMax}`, `smtp_accept_max_per_host = ${s.smtpAcceptMaxPerHost}`, `smtp_accept_queue_per_connection = ${s.smtpAcceptQueuePerConnection}`);
  if (s.ratelimitEnabled) lines.push('smtp_ratelimit_hosts = *', `smtp_ratelimit_mail = ${s.ratelimitMailThreshold},${s.ratelimitMailDelay}s,1.5,30s`, `smtp_ratelimit_rcpt = ${s.ratelimitRcptThreshold},${s.ratelimitRcptDelay}s,1.5,30s`);
  if (s.dictionaryAttackProtection) lines.push(`smtp_max_unknown_commands = ${s.maxUnknownCommands}`, `recipients_max = ${s.recipientsMax}`, `recipients_max_reject = ${s.recipientsMaxReject ? 'true' : 'false'}`);
  if (s.tls) lines.push(...renderEximTls(s.tls, eximTlsLibrary(layout)));
  return `${lines.join('\n')}\n`;
}

// The same deny rules on every layout (see renderEximMain for why Debian's
// macros are not enough). Exempting authenticated clients and loopback keeps
// submissions from the server's own users and webmail working. The chain ends
// with the Email category's filters file so one hook point serves both.
export function renderEximRcptAcl(s, support = { spf: true, dkim: true }, layout = null) {
  const emailAcl = layout?.emailAclFile || layout?.slots?.acl_rcpt?.includes || '/etc/exim/whm/acl-email-filters.conf';
  const lines = [`${MANAGED} (Exim Configuration Manager: RCPT ACL chain). Include inside acl_check_rcpt after the local/authenticated accepts, before the final accept.`];
  // `::` inside a colon-separated Exim list is an escaped colon (the item would
  // become the host-name pattern `:1`), so the list uses `;` as its separator.
  const unauth = ['        !authenticated = *', '        !hosts = <; ; 127.0.0.1 ; ::1'];
  if (s.dictionaryAttackProtection) {
    lines.push('# Dictionary attack protection: slow down and then drop clients that keep guessing recipients',
      `drop    condition = \${if > {$rcpt_fail_count}{${s.rcptFailLimit}}}`, '        message = Too many invalid recipients from your host', `        delay = ${s.rcptFailDelay}s`, '        log_message = WHM dictionary attack protection ($rcpt_fail_count failed recipients)',
      `warn    condition = \${if > {$rcpt_fail_count}{${Math.max(1, Math.floor(s.rcptFailLimit / 2))}}}`, `        delay = ${Math.max(1, Math.floor(s.rcptFailDelay / 2))}s`, '');
  }
  if (s.requireHelo) lines.push('# HELO/EHLO must precede MAIL FROM', 'deny', ...unauth, '        condition = ${if def:sender_helo_name{no}{yes}}', '        message = HELO/EHLO is required before MAIL FROM', '        log_message = WHM no HELO', '');
  if (s.rblEnabled && s.rbls.length) lines.push('# Realtime blackhole lists', 'deny', ...unauth, `        dnslists = ${s.rbls.join(' : ')}`, '        message = Rejected: $sender_host_address is listed at $dnslist_domain ($dnslist_text)', '        log_message = WHM RBL $dnslist_domain', '');
  if (s.domainRblEnabled && s.domainRbls.length) lines.push('# Domain blackhole lists', 'deny', ...unauth, `        dnslists = ${s.domainRbls.map((d) => `${d}/$sender_address_domain`).join(' : ')}`, '        message = Rejected: sender domain is listed at $dnslist_domain', '        log_message = WHM domain RBL $dnslist_domain', '');
  if (s.reverseDnsRequired) lines.push('# Require a reverse DNS entry for the sending host', 'deny', ...unauth, '        !verify = reverse_host_lookup', '        message = Your host has no reverse DNS (PTR) record', '        log_message = WHM no reverse DNS', '');
  if (s.verifySender) lines.push('# Sender address must be routable', 'deny', ...unauth, '        !verify = sender', '        message = Sender verification failed', '        log_message = WHM sender verify failed', '');
  if (s.spfVerify && !support.spf) lines.push('# SPF verification is enabled in the panel but this Exim build has no SPF support (exim4-daemon-light);', '# the spf conditions are left out so the configuration stays valid. Install exim4-daemon-heavy to enforce SPF.', '');
  else if (s.spfVerify) {
    lines.push('# SPF' + (s.spfReject ? ': reject on fail, tag softfail' : ': verify only, fail/softfail are tagged and logged'));
    if (s.spfReject) lines.push('deny', ...unauth, '        spf = fail', '        message = SPF check failed: $spf_smtp_comment', '        log_message = WHM SPF fail');
    lines.push('warn', ...unauth, `        spf = ${s.spfReject ? 'softfail' : 'fail : softfail'}`, '        add_header = $spf_received', '        log_message = WHM SPF $spf_result', '');
  }
  if (lines.length === 1) lines.push('# No RCPT protections are enabled.');
  lines.push('# Email filters (country / domain blocks, greylisting) are written by the Email category into this file:', `.include_if_exists ${emailAcl}`);
  return `${lines.join('\n')}\n`;
}

// $dkim_cur_signer is only set inside acl_smtp_dkim; in the DATA ACL the
// signers are the colon-separated $dkim_signers list.
export function renderEximDataAcl(s, support = { spf: true, dkim: true }) {
  const lines = [`${MANAGED} (Exim Configuration Manager: DATA ACL). Include inside acl_check_data.`];
  if (s.dkimVerify && !support.dkim) lines.push('# DKIM verification is enabled in the panel but this Exim build has no DKIM support; the dkim conditions are left out.');
  else if (s.dkimVerify) {
    lines.push('# DKIM verification results', 'warn    dkim_status = pass', '        add_header = :at_start:X-WHM-DKIM: pass (signers $dkim_signers)',
      'warn    dkim_status = fail', '        add_header = :at_start:X-WHM-DKIM: fail (signers $dkim_signers)', '        log_message = WHM DKIM fail for $dkim_signers');
    if (s.dkimReject) lines.push('deny    !authenticated = *', '        dkim_status = fail', '        message = DKIM signature verification failed for $dkim_signers', '        log_message = WHM DKIM reject');
  } else lines.push('# DKIM verification is disabled.');
  return `${lines.join('\n')}\n`;
}

// Dovecot reads conf.d alphabetically and later files win: this file owns
// ssl=, protocols, limits and ciphers, and sorts after 90-whm-ssl-cert.conf
// (certificate paths from Manage Service SSL Certificates / ssl-tls), which
// writes nothing else. ssl_cipher_suites only exists from Dovecot 2.3.15.
export function dovecotSupportsCipherSuites(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return false;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  return maj > 2 || (maj === 2 && (min > 3 || (min === 3 && pat >= 15)));
}

export function renderDovecot(s, { version = null } = {}) {
  const lines = [`${MANAGED} (Mailserver Configuration). Protocols, limits, ssl= and ciphers live here; certificate paths come from 90-whm-ssl-cert.conf. Edit through the panel.`, `protocols = ${s.protocols.join(' ')}`];
  lines.push(`ssl = ${s.ssl}`, `ssl_min_protocol = ${s.sslMinProtocol}`, `disable_plaintext_auth = ${s.disablePlaintextAuth ? 'yes' : 'no'}`);
  if (s.sslCipherList) lines.push(`ssl_cipher_list = ${s.sslCipherList}`);
  if (s.sslCipherSuites && dovecotSupportsCipherSuites(version)) lines.push(`ssl_cipher_suites = ${s.sslCipherSuites}`);
  lines.push(`ssl_prefer_server_ciphers = ${s.sslPreferServerCiphers ? 'yes' : 'no'}`);
  lines.push(`mail_max_userip_connections = ${s.maxUserIpConnections}`, `default_process_limit = ${s.processLimit}`, `default_client_limit = ${s.clientLimit}`);
  if (s.mailLocation) lines.push(`mail_location = ${s.mailLocation}`);
  if (s.loginGreeting) lines.push(`login_greeting = ${s.loginGreeting}`);
  if (s.protocols.includes('imap')) lines.push('protocol imap {', `  mail_max_userip_connections = ${s.maxUserIpConnections}`, `  imap_idle_notify_interval = ${s.imapIdleNotifyIntervalMinutes} mins`, '}');
  if (s.protocols.includes('pop3')) lines.push('protocol pop3 {', `  mail_max_userip_connections = ${Math.max(1, Math.ceil(s.maxUserIpConnections / 2))}`, `  pop3_uidl_format = ${s.pop3UidlFormat}`, '}');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- service ---

export function createServiceConfigService(ctx) {
  const { db, agent, capabilities, settings, logger } = ctx;
  const op = (name, args, req) => agent.op(name, args, { req });
  const audit = (req, entry) => req?.audit?.(entry);

  const stmts = {
    vhostByDomain: db.prepare('SELECT * FROM web_vhosts WHERE domain = ?'),
    vhostsByUser: db.prepare('SELECT * FROM web_vhosts WHERE username = ? ORDER BY type, domain'),
    vhostsAll: db.prepare('SELECT * FROM web_vhosts ORDER BY username, type, domain'),
    vhostsByIp: db.prepare('SELECT * FROM web_vhosts WHERE ip = ?'),
    vhostsByType: db.prepare('SELECT * FROM web_vhosts WHERE type = ? ORDER BY domain'),
    upsertVhost: db.prepare(`INSERT INTO web_vhosts (domain, account_id, username, type, docroot, aliases_json, ip, ipv6, php_version, ssl_json, redirects_json, custom_directives, status)
      VALUES (@domain, @account_id, @username, @type, @docroot, @aliases_json, @ip, @ipv6, @php_version, @ssl_json, @redirects_json, @custom_directives, 'pending')
      ON CONFLICT (domain) DO UPDATE SET account_id = excluded.account_id, username = excluded.username, type = excluded.type, docroot = excluded.docroot, aliases_json = excluded.aliases_json, ip = excluded.ip, ipv6 = excluded.ipv6,
        php_version = excluded.php_version, ssl_json = excluded.ssl_json, redirects_json = excluded.redirects_json, custom_directives = excluded.custom_directives, updated_at = datetime('now')`),
    setVhostStatus: db.prepare(`UPDATE web_vhosts SET status = ?, error = ?, path = COALESCE(?, path), updated_at = datetime('now') WHERE domain = ?`),
    deleteVhost: db.prepare('DELETE FROM web_vhosts WHERE domain = ?'),
    poolsByUser: db.prepare('SELECT * FROM web_php_pools WHERE username = ? ORDER BY version'),
    poolByUserVersion: db.prepare('SELECT * FROM web_php_pools WHERE username = ? AND version = ?'),
    pools: db.prepare('SELECT * FROM web_php_pools ORDER BY username, version'),
    upsertPool: db.prepare(`INSERT INTO web_php_pools (username, version, settings_json, path, socket, status, error) VALUES (@username, @version, @settings_json, @path, @socket, @status, @error)
      ON CONFLICT (username, version) DO UPDATE SET settings_json = excluded.settings_json, path = excluded.path, socket = excluded.socket, status = excluded.status, error = excluded.error, updated_at = datetime('now')`),
    deletePools: db.prepare('DELETE FROM web_php_pools WHERE username = ?'),
    deletePool: db.prepare('DELETE FROM web_php_pools WHERE username = ? AND version = ?'),
    accountByUsername: db.prepare('SELECT * FROM accounts WHERE username = ?'),
    accountByDomain: db.prepare('SELECT * FROM accounts WHERE domain = ?'),
    accounts: db.prepare('SELECT * FROM accounts ORDER BY username'),
    accountDomains: db.prepare('SELECT * FROM account_domains WHERE account_id = ? ORDER BY type, domain'),
    accountDomain: db.prepare('SELECT d.*, a.username FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.domain = ?'),
    applies: db.prepare('SELECT * FROM service_config_applies'),
    applyFor: db.prepare('SELECT * FROM service_config_applies WHERE component = ?'),
    recordApply: db.prepare(`INSERT INTO service_config_applies (component, ok, summary, error, applied_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (component) DO UPDATE SET ok = excluded.ok, summary = excluded.summary, error = excluded.error, applied_at = excluded.applied_at`),
  };

  const getConf = (component) => ({ ...DEFAULTS[component], ...(settings.get(`service_config.${component}`, {}) || {}) });
  const setConf = (component, value) => settings.set(`service_config.${component}`, value);
  const recordApply = (component, ok, summary, error = null) => { stmts.recordApply.run(component, ok ? 1 : 0, JSON.stringify(summary ?? null), error); return lastApply(component); };
  const lastApply = (component) => { const r = stmts.applyFor.get(component); return r ? { at: r.applied_at, ok: Boolean(r.ok), summary: json.parse(r.summary, null), error: r.error } : null; };
  const hostname = () => settings.get('basic.hostname') || 'localhost';
  const forceHttps = () => settings.get('web.force_https', true) !== false;
  // The hostname vhost carries no account and must not count as one.
  const accountVhosts = () => stmts.vhostsAll.all().filter((r) => r.type !== 'server');

  // The server's own name (and www.<name>) is never hosted by an account: a
  // tenant vhost for it would answer with the hostname's certificate and
  // receive the panel's host-only session cookie from the admin's browser.
  const serverNames = () => { const name = String(hostname()).toLowerCase(); return HOSTNAME_RE.test(name) ? [name, `www.${name}`] : []; };
  const isServerName = (domain) => serverNames().includes(String(domain ?? '').trim().toLowerCase());
  function assertNotServerName(spec) {
    if (spec.type === 'server') return;
    const hit = [spec.domain, ...(spec.aliases || [])].find((d) => isServerName(d));
    if (hit) throw conflict(`${hit} is the server hostname; it cannot be hosted by an account`);
    if (stmts.vhostByDomain.get(spec.domain)?.type === 'server') throw conflict(`${spec.domain} is the server hostname's own virtual host; it cannot be hosted by an account`);
  }

  let detectCache = { at: 0, value: null };
  async function detect(force = false) {
    if (!force && detectCache.value && Date.now() - detectCache.at < 30_000) return detectCache.value;
    const value = await op('web.detect');
    detectCache = { at: Date.now(), value };
    return value;
  }
  const invalidate = () => { detectCache.at = 0; };

  function requireApache() { capabilities.require('apache', 'Apache is not installed on this server. Install apache2 (Debian/Ubuntu) or httpd (RHEL); the configuration you save is applied once it is.'); }

  // ------------------------------------------------------------- vhosts ---

  function shapeVhost(r) {
    return r && { id: r.id, domain: r.domain, accountId: r.account_id, username: r.username, type: r.type, docroot: r.docroot, aliases: json.parse(r.aliases_json, []), ip: r.ip, ipv6: r.ipv6, phpVersion: r.php_version, ssl: json.parse(r.ssl_json, null), redirects: json.parse(r.redirects_json, []), customDirectives: r.custom_directives || '', path: r.path, status: r.status, error: r.error, updatedAt: r.updated_at };
  }

  async function phpTrees() {
    const d = await detect().catch(() => null);
    return d?.php?.versions || [];
  }

  async function resolvePhpVersion(account) {
    const plan = json.parse(account.plan_snapshot_json, {});
    const wanted = phpVersionId(plan.php_version) || phpVersionId(getConf('apache').defaultPhpVersion) || phpVersionId(settings.get('php.default_version'));
    const trees = await phpTrees();
    if (!trees.length) return null;
    if (wanted && trees.some((t) => t.version === wanted)) return wanted;
    return trees[trees.length - 1].version;
  }

  // Builds the vhost specs an account needs from accounts + account_domains.
  // Only a row the same account wrote is carried over (certificate, custom
  // directives, IPv6, PHP version): another owner's row, the hostname's
  // included, is treated as absent. A tenant is never left on `*:80` while an
  // address is known (shared, then main, as account creation picks it): the
  // catch-all names every address, and Apache consults no `*` vhost for a
  // connection whose address another vhost names.
  function specsFor(account) {
    const home = account.home_dir || `${settings.get('basic.home_root') || '/home'}/${account.username}`;
    const domains = stmts.accountDomains.all(account.id);
    const aliases = domains.filter((d) => ['parked', 'alias'].includes(d.type)).map((d) => d.domain);
    const own = (row) => (row && row.type !== 'server' && row.username === account.username ? row : null);
    const existing = own(stmts.vhostByDomain.get(account.domain));
    const base = (domain, type, docroot, extraAliases = []) => {
      const prev = own(stmts.vhostByDomain.get(domain));
      return { domain, accountId: account.id, username: account.username, type, docroot, aliases: extraAliases, ip: account.ip || settings.get('basic.shared_ip') || settings.get('basic.main_ip') || null, ipv6: prev?.ipv6 ?? existing?.ipv6 ?? null, phpVersion: prev?.php_version ?? null, ssl: json.parse(prev?.ssl_json, null), redirects: json.parse(prev?.redirects_json, []), customDirectives: prev?.custom_directives || '', logDir: domlogDir(account.username) };
    };
    const specs = [base(account.domain, 'main', `${home}/public_html`, aliases)];
    for (const d of domains.filter((x) => ['addon', 'sub'].includes(x.type))) specs.push(base(d.domain, d.type, d.docroot || `${home}/public_html/${d.domain}`));
    return specs;
  }

  function storeSpec(spec) {
    assertNotServerName(spec);
    stmts.upsertVhost.run({ domain: spec.domain, account_id: spec.accountId ?? null, username: spec.username, type: spec.type, docroot: spec.docroot, aliases_json: JSON.stringify(spec.aliases || []), ip: spec.ip ?? null, ipv6: spec.ipv6 ?? null, php_version: spec.phpVersion ?? null, ssl_json: spec.ssl ? JSON.stringify(spec.ssl) : null, redirects_json: JSON.stringify(spec.redirects || []), custom_directives: spec.customDirectives || '' });
  }

  async function writeSpec(spec, req, { reload = true } = {}) {
    storeSpec(spec);
    if (!capabilities.has('apache')) { stmts.setVhostStatus.run('pending', 'Apache is not installed', null, spec.domain); return { domain: spec.domain, applied: false, reason: 'capability_missing' }; }
    try {
      const args = { domain: spec.domain, aliases: spec.aliases || [], docroot: spec.docroot, user: spec.username, redirects: spec.redirects || [], customDirectives: spec.customDirectives || '', reload, meta: { type: spec.type, account: spec.username } };
      if (spec.ip) args.ip = spec.ip;
      if (spec.ipv6) args.ipv6 = spec.ipv6;
      if (spec.phpVersion) args.phpVersion = spec.phpVersion;
      if (spec.ssl) args.ssl = { cert: spec.ssl.cert, key: spec.ssl.key, ...(spec.ssl.chain ? { chain: spec.ssl.chain } : {}), ...(spec.ssl.fullchain ? { fullchain: spec.ssl.fullchain } : {}) };
      // Only a vhost that can answer on HTTPS redirects to it; without a
      // certificate the redirect would send visitors to a handshake failure.
      args.redirectHttps = Boolean(spec.ssl) && forceHttps();
      args.logDir = spec.logDir || domlogDir(spec.username);
      const ports = listenPorts();
      args.port = ports.http;
      args.sslPort = ports.https;
      if (ports.bind) args.bind = ports.bind;
      const result = await op('web.vhost.write', args, req);
      stmts.setVhostStatus.run('applied', null, result.path, spec.domain);
      return { domain: spec.domain, applied: true, ...result };
    } catch (err) {
      stmts.setVhostStatus.run('failed', err.message, null, spec.domain);
      throw err;
    }
  }

  const listenPorts = () => ({ http: 80, https: 443, bind: null, ...(settings.get('service_config.apache_ports', null) || {}) });

  // Several vhosts changed by one action are written without a reload each and
  // Apache is reloaded once afterwards when at least one file was validated, so
  // a rejected last write cannot leave the earlier ones written but not live.
  async function reloadAfter(written, req) {
    if (!written) return { reloaded: false, unit: null };
    return op('web.reload', {}, req).catch((err) => { logger.warn({ err }, 'web: reload after vhost writes failed'); return { reloaded: false, unit: null, error: err.message }; });
  }

  function loadSpec(domain) {
    const row = stmts.vhostByDomain.get(domain);
    if (row) { const s = shapeVhost(row); s.logDir = domlogDir(s.username); return s; }
    const account = stmts.accountByDomain.get(domain);
    if (account) return specsFor(account)[0];
    const sub = stmts.accountDomain.get(domain);
    if (sub) { const acct = stmts.accountByUsername.get(sub.username); return specsFor(acct).find((s) => s.domain === domain) || null; }
    return null;
  }

  function requireSpec(domain) {
    const spec = loadSpec(domain);
    if (!spec) throw notFound(`A hosted domain named "${domain}"`);
    return spec;
  }

  // One pool per (account, PHP version): the pool file lives in that version's
  // tree, so an account whose domains run different versions has one of each.
  const poolSettingsFor = (username) => json.parse(stmts.poolsByUser.all(username)[0]?.settings_json, {});

  async function ensurePool(account, version, req) {
    const current = stmts.poolByUserVersion.get(account.username, version);
    if (current && current.status === 'applied') return { username: account.username, version, socket: current.socket, applied: true, unchanged: true };
    return writePhpPool(account.username, version, current ? json.parse(current.settings_json, {}) : poolSettingsFor(account.username), req);
  }

  async function writePhpPool(username, versionInput, poolSettings = {}, req) {
    const account = stmts.accountByUsername.get(username);
    if (!account) throw notFound(`Account "${username}"`);
    const version = phpVersionId(versionInput);
    if (!version) throw badRequest(`"${versionInput}" is not a PHP version`);
    const trees = await phpTrees();
    if (!trees.some((t) => t.version === version)) throw new CapabilityError('php', `PHP-FPM ${version} is not installed on this server (available: ${trees.map((t) => t.version).join(', ') || 'none'})`);
    const home = account.home_dir || `/home/${username}`;
    const args = { user: username, version, ...poolSettings, errorLog: poolSettings.errorLog || `${home}/logs/php-error.log`, tmpDir: poolSettings.tmpDir || `${home}/tmp` };
    try {
      const result = await op('web.phpfpm.pool.write', args, req);
      stmts.upsertPool.run({ username, version, settings_json: JSON.stringify(poolSettings), path: result.path, socket: result.socket, status: 'applied', error: null });
      audit(req, { action: 'web.phpfpm.pool.write', target: username, args: { version } });
      return { username, version, applied: true, ...result };
    } catch (err) {
      stmts.upsertPool.run({ username, version, settings_json: JSON.stringify(poolSettings), path: null, socket: null, status: 'failed', error: err.message });
      throw err;
    }
  }

  async function removePool(username, version, req) {
    if (capabilities.has('apache') || capabilities.has('php')) { try { await op('web.phpfpm.pool.remove', { user: username, version }, req); } catch (err) { logger.warn({ err, username, version }, 'web: pool removal failed'); } }
    stmts.deletePool.run(username, version);
  }

  // A per-domain choice (setPhpVersion) is kept; only domains without one get
  // the account's resolved version, and with Apache missing the stored values
  // are left untouched (no nulling) so nothing is lost before the daemon exists.
  // A vhost is never rendered without its PHP handler: when the pool cannot be
  // written the handler still points at the pool socket, so Apache answers 503
  // for .php instead of serving application source as static files.
  async function ensureVhost(usernameOrAccount, req) {
    const account = typeof usernameOrAccount === 'string' ? stmts.accountByUsername.get(usernameOrAccount) : usernameOrAccount;
    if (!account) throw notFound(`Account "${usernameOrAccount}"`);
    const specs = specsFor(account);
    for (const spec of specs) assertNotServerName(spec);
    const installed = capabilities.has('apache');
    let phpVersion = null;
    const poolErrors = {};
    if (installed) {
      phpVersion = await resolvePhpVersion(account);
      for (const spec of specs) spec.phpVersion = spec.phpVersion ?? phpVersion;
      for (const version of new Set(specs.map((s) => s.phpVersion).filter(Boolean))) {
        try { await ensurePool(account, version, req); } catch (err) { poolErrors[version] = err.message; logger.warn({ err, username: account.username, version }, 'web: PHP-FPM pool could not be written; the vhosts keep their PHP handler and answer 503 until it exists'); }
      }
      for (const pool of stmts.poolsByUser.all(account.username)) if (!specs.some((s) => s.phpVersion === pool.version)) await removePool(account.username, pool.version, req);
    }
    const results = [];
    let written = 0;
    for (const spec of specs) {
      if (!installed) { storeSpec(spec); stmts.setVhostStatus.run('pending', 'Apache is not installed', null, spec.domain); results.push({ domain: spec.domain, applied: false, reason: 'capability_missing' }); continue; }
      try {
        const result = await writeSpec(spec, req, { reload: false });
        written++;
        const poolError = spec.phpVersion ? poolErrors[spec.phpVersion] : null;
        if (poolError) {
          stmts.setVhostStatus.run('failed', `PHP-FPM ${spec.phpVersion} pool: ${poolError}`, result.path ?? null, spec.domain);
          results.push({ ...result, applied: false, reason: 'php_pool_failed', error: poolError });
        } else if (!spec.phpVersion) {
          // No PHP-FPM tree on this host: the vhost is served, but without a
          // handler .php files would be static content, so it is not "applied".
          const error = 'PHP-FPM is not installed; .php files are served as static content until a PHP-FPM tree exists and the account is synced again';
          stmts.setVhostStatus.run('failed', error, result.path ?? null, spec.domain);
          results.push({ ...result, applied: false, reason: 'php_missing', error });
        } else results.push(result);
      } catch (err) { results.push({ domain: spec.domain, applied: false, reason: err.code || 'error', error: err.message }); }
    }
    const reload = await reloadAfter(written, req);
    if (written) await refreshDefaultVhostAddresses(req);
    audit(req, { action: 'web.vhost.sync', target: account.username, args: { domains: specs.map((s) => s.domain), applied: results.filter((r) => r.applied).length } });
    return { username: account.username, applied: installed && results.every((r) => r.applied), reason: !installed ? 'capability_missing' : results.find((r) => !r.applied)?.reason ?? null, phpVersion, phpVersions: Object.fromEntries(specs.map((s) => [s.domain, s.phpVersion ?? null])), poolErrors, reload, vhosts: results };
  }

  async function removeAccount(username, req) {
    const rows = stmts.vhostsByUser.all(username);
    const removed = [];
    for (const r of rows) {
      if (capabilities.has('apache')) { try { await op('web.vhost.remove', { domain: r.domain, reload: false }, req); } catch (err) { logger.warn({ err, domain: r.domain }, 'web: vhost removal failed'); } }
      stmts.deleteVhost.run(r.domain);
      removed.push(r.domain);
    }
    const pools = stmts.poolsByUser.all(username);
    for (const pool of pools) await removePool(username, pool.version, req);
    stmts.deletePools.run(username);
    if (removed.length && capabilities.has('apache')) await op('web.reload', {}, req).catch((err) => logger.warn({ err }, 'web: reload after account removal failed'));
    audit(req, { action: 'web.account.remove', target: username, args: { domains: removed, pools: pools.map((p) => p.version) } });
    return { username, removed, pool: pools.length > 0, pools: pools.map((p) => p.version) };
  }

  // --------------------------------------------------------- hostname vhost ---

  function landingHtml(name) {
    try {
      if (typeof ctx.accountFunctions?.renderTemplate === 'function') return ctx.accountFunctions.renderTemplate('landing', { domain: name, username: '', ip: settings.get('basic.main_ip', '') || '' });
    } catch (err) { logger.warn({ err }, 'web: landing template unavailable; using the built-in page'); }
    return fallbackLanding(name);
  }

  // A bundle SSL/TLS installed for the hostname (AutoSSL writes one under
  // /etc/ssl/whm/<hostname>/) is picked up even before applySsl ran.
  function installedBundle(name) {
    try {
      const cert = ctx.ssl?.certForDomain?.(name);
      if (!cert || !(cert.installed > 0) || typeof ctx.ssl.bundlePaths !== 'function') return null;
      const p = ctx.ssl.bundlePaths(name);
      return { cert: p.cert, key: p.key, chain: p.chain || null, fullchain: p.fullchain || null };
    } catch { return null; }
  }

  async function writeLandingPage(name, req) {
    try {
      await op('fs.write_file', { path: `${LANDING_DOCROOT}/index.html`, content: landingHtml(name), owner: 'root', mode: '0644', backup: false }, req);
      return true;
    } catch (err) { logger.warn({ err }, 'web: landing page could not be written'); return false; }
  }

  async function apacheRunUser(installed) {
    const d = installed ? await detect().catch(() => null) : null;
    return d?.apache?.runUser || (d?.apache?.flavor === 'rhel' ? 'apache' : 'www-data');
  }

  // Every address a tenant vhost binds to: the catch-all must list them, since
  // Apache picks the first vhost of the most specific address set and a plain
  // _default_ never beats an IP-specific tenant vhost for that IP. The reverse
  // holds too: a tenant still on `*` (a row written before any address was
  // known) is never consulted once the catch-all names the connection
  // address, so while such a row exists the catch-all stays a plain _default_.
  function listenAddresses() {
    const rows = stmts.vhostsAll.all();
    if (rows.some((r) => r.type !== 'server' && !r.ip)) return [];
    const set = new Set();
    for (const r of rows) { if (r.ip) set.add(r.ip); if (r.ipv6) set.add(r.ipv6); }
    for (const key of ['basic.main_ip', 'basic.shared_ip', 'basic.main_ipv6']) { const v = String(settings.get(key, '') || '').trim(); if (v) set.add(v); }
    try { for (const row of db.prepare('SELECT address FROM ip_addresses').all()) if (row.address) set.add(String(row.address)); } catch { /* ip table absent */ }
    return [...set].filter((a) => isIP(a) > 0).sort().slice(0, 64);
  }

  const serverSsl = (name) => { const prev = stmts.vhostByDomain.get(name); return (prev?.type === 'server' ? json.parse(prev.ssl_json, null) : null) || installedBundle(name); };

  // The catch-all vhost (agent web.default_vhost.write): the landing page for
  // the bare address and for names no site claims, on the HTTP and HTTPS
  // ports, with the hostname's certificate when one is installed. Written
  // with the hostname vhost (boot, hostname change, template save, re-render
  // job) and whenever the hostname's certificate changes. Never throws.
  async function ensureDefaultVhost(req = null, { hostname: wanted = null } = {}) {
    const name = String(wanted || hostname()).trim().toLowerCase() || 'localhost';
    const installed = capabilities.has('apache');
    if (!installed) { recordApply('default_vhost', false, { hostname: name, pending: true }, 'Apache is not installed'); return { hostname: name, applied: false, reason: 'capability_missing', docroot: LANDING_DOCROOT }; }
    const user = await apacheRunUser(installed);
    const ports = listenPorts();
    const args = { hostname: name, docroot: LANDING_DOCROOT, user, addresses: listenAddresses(), port: ports.http, sslPort: ports.https, logDir: domlogDir(user), reload: true };
    if (ports.bind) args.bind = ports.bind;
    const ssl = serverSsl(name);
    if (ssl?.cert && ssl?.key) args.ssl = { cert: ssl.cert, key: ssl.key, ...(ssl.chain ? { chain: ssl.chain } : {}), ...(ssl.fullchain ? { fullchain: ssl.fullchain } : {}) };
    try {
      const r = await op('web.default_vhost.write', args, req);
      recordApply('default_vhost', true, { hostname: name, path: r.path ?? null, ssl: r.ssl ?? null, addresses: r.addresses ?? args.addresses, stockSite: r.stockSite ?? null, reloaded: Boolean(r.reloaded) });
      audit(req, { action: 'web.vhost.default', target: name, args: { docroot: LANDING_DOCROOT, addresses: args.addresses.length, ssl: r.ssl?.source ?? null, stockSite: r.stockSite?.disabled ?? false } });
      return { hostname: name, applied: true, docroot: LANDING_DOCROOT, path: r.path ?? null, ssl: r.ssl ?? null, addresses: r.addresses ?? args.addresses, stockSite: r.stockSite ?? null, reload: { reloaded: Boolean(r.reloaded), unit: r.unit ?? null } };
    } catch (err) {
      logger.warn({ err, hostname: name }, 'web: default vhost could not be written');
      recordApply('default_vhost', false, { hostname: name }, err.message);
      return { hostname: name, applied: false, reason: err.code || 'error', error: err.message, docroot: LANDING_DOCROOT };
    }
  }

  // Tenant vhosts bind to addresses the catch-all must name (a dedicated IP,
  // an IPv6, the first explicit address) or the catch-all is shadowed there,
  // and vice versa: after a vhost write the catch-all follows its address set.
  async function refreshDefaultVhostAddresses(req) {
    const last = lastApply('default_vhost');
    if (!last?.ok || last.summary?.removed || listenPorts().bind) return null;
    const want = listenAddresses();
    const have = Array.isArray(last.summary?.addresses) ? last.summary.addresses : [];
    if (want.length === have.length && want.every((a) => have.includes(a))) return null;
    return ensureDefaultVhost(req);
  }

  async function removeDefaultVhost(req = null) {
    if (!capabilities.has('apache')) return { removed: false, reason: 'capability_missing' };
    const r = await op('web.default_vhost.remove', {}, req);
    recordApply('default_vhost', true, { removed: Boolean(r.removed), path: r.path ?? null });
    audit(req, { action: 'web.vhost.default.remove', target: r.path ?? 'default', args: { removed: Boolean(r.removed) } });
    return { removed: Boolean(r.removed), path: r.path ?? null, reload: { reloaded: Boolean(r.reloaded), unit: r.unit ?? null } };
  }

  // One domain's vhost goes (file and row); the hostname's never does this
  // way and a main domain keeps its vhost until the account is removed.
  async function removeDomain(domain, req) {
    const row = stmts.vhostByDomain.get(domain);
    if (row?.type === 'server') throw conflict(`${domain} is the server hostname's own virtual host`);
    if (row?.type === 'main') throw conflict(`${domain} is the main domain of ${row.username}; terminate the account to remove it`);
    let removed = false;
    if (capabilities.has('apache')) {
      try { removed = Boolean((await op('web.vhost.remove', { domain, reload: true }, req)).removed); } catch (err) { logger.warn({ err, domain }, 'web: vhost removal failed'); }
    }
    if (row) stmts.deleteVhost.run(domain);
    audit(req, { action: 'web.vhost.domain.remove', target: domain, args: { removed, recorded: Boolean(row), username: row?.username ?? null } });
    return { domain, removed, recorded: Boolean(row), applied: removed || !capabilities.has('apache') };
  }

  // Renders the 'server' vhost for the server's own name: the branded landing
  // page from LANDING_DOCROOT, no PHP, the hostname's certificate when one is
  // installed. Any previous hostname's vhost goes away. The catch-all vhost is
  // refreshed afterwards so it carries the same certificate and addresses.
  // Never throws (boot and the hostname change report the outcome as a step).
  async function ensureHostnameVhost(req = null, { hostname: wanted = null } = {}) {
    const name = String(wanted || hostname()).trim().toLowerCase();
    if (!HOSTNAME_RE.test(name) || name === 'localhost' || name.endsWith('.localdomain')) {
      const landingPage = await writeLandingPage(name, req);
      const defaultVhost = await ensureDefaultVhost(req, { hostname: name });
      return { hostname: name, applied: false, reason: 'invalid_hostname', error: `"${name}" is not a fully qualified hostname; set one in Basic WebHost Manager Setup or Change Hostname`, landingPage, defaultVhost };
    }
    if (stmts.accountByDomain.get(name) || stmts.accountDomain.get(name)) return { hostname: name, applied: false, reason: 'hosted_domain', error: `${name} is a domain hosted by an account; its own virtual host serves it`, defaultVhost: await ensureDefaultVhost(req, { hostname: name }) };
    const installed = capabilities.has('apache');
    for (const stale of stmts.vhostsByType.all('server').filter((r) => r.domain !== name)) {
      if (installed) await op('web.vhost.remove', { domain: stale.domain, reload: false }, req).catch((err) => logger.warn({ err, domain: stale.domain }, 'web: previous hostname vhost could not be removed'));
      stmts.deleteVhost.run(stale.domain);
    }
    const landingPage = await writeLandingPage(name, req);
    const user = await apacheRunUser(installed);
    const prev = stmts.vhostByDomain.get(name);
    const spec = {
      domain: name, accountId: null, username: user, type: 'server', docroot: LANDING_DOCROOT, aliases: [],
      ip: settings.get('basic.main_ip', '') || settings.get('basic.shared_ip', '') || null, ipv6: settings.get('basic.main_ipv6', '') || null,
      phpVersion: null, ssl: json.parse(prev?.ssl_json, null) || installedBundle(name), redirects: [], customDirectives: prev?.custom_directives || '', logDir: domlogDir(user),
    };
    if (!installed) { storeSpec(spec); stmts.setVhostStatus.run('pending', 'Apache is not installed', null, name); return { hostname: name, applied: false, reason: 'capability_missing', docroot: LANDING_DOCROOT, landingPage, defaultVhost: await ensureDefaultVhost(req, { hostname: name }) }; }
    try {
      let result;
      try { result = await writeSpec(spec, req); } catch (err) {
        // A certificate row without its files on disk (restored panel data,
        // pruned bundle) must not cost the hostname its landing page.
        if (!(spec.ssl && err.code === 'not_found')) throw err;
        spec.ssl = null;
        result = await writeSpec(spec, req);
      }
      audit(req, { action: 'web.vhost.server', target: name, args: { docroot: LANDING_DOCROOT, user, ssl: Boolean(spec.ssl), redirectHttps: Boolean(spec.ssl) && forceHttps() } });
      return { hostname: name, docroot: LANDING_DOCROOT, landingPage, ...result, defaultVhost: await ensureDefaultVhost(req, { hostname: name }) };
    } catch (err) {
      logger.warn({ err, hostname: name }, 'web: hostname vhost could not be written');
      return { hostname: name, applied: false, reason: err.code || 'error', error: err.message, docroot: LANDING_DOCROOT, landingPage, defaultVhost: await ensureDefaultVhost(req, { hostname: name }) };
    }
  }

  if (typeof ctx.events?.on === 'function') {
    ctx.events.on('panel.started', () => ensureHostnameVhost(null).catch((err) => logger.warn({ err }, 'web: hostname vhost at boot failed')));
  }

  async function applySsl(domain, paths, req) {
    const spec = requireSpec(domain);
    if (!paths?.cert || !paths?.key) throw badRequest('applySsl needs { cert, key } paths');
    spec.ssl = { cert: paths.cert, key: paths.key, chain: paths.chain || null, fullchain: paths.fullchain || null };
    storeSpec(spec);
    requireApache();
    const result = await writeSpec(spec, req);
    audit(req, { action: 'web.ssl.apply', target: domain, args: { cert: paths.cert } });
    if (spec.type === 'server') result.defaultVhost = await ensureDefaultVhost(req, { hostname: domain });
    return result;
  }

  async function removeSsl(domain, req) {
    const spec = requireSpec(domain);
    spec.ssl = null;
    storeSpec(spec);
    requireApache();
    const result = await writeSpec(spec, req);
    audit(req, { action: 'web.ssl.remove', target: domain });
    if (spec.type === 'server') result.defaultVhost = await ensureDefaultVhost(req, { hostname: domain });
    return result;
  }

  async function setRedirects(domain, list, req) {
    const spec = requireSpec(domain);
    spec.redirects = (list || []).map((r) => ({ from: r.from || '/', to: r.to, type: String(r.type || '301'), matchWww: r.matchWww !== false, keepPath: r.keepPath !== false }));
    storeSpec(spec);
    requireApache();
    const result = await writeSpec(spec, req);
    audit(req, { action: 'web.redirects.set', target: domain, args: { count: spec.redirects.length } });
    return result;
  }

  async function addAlias({ username, domain, alias }, req) {
    const target = domain || stmts.accountByUsername.get(username)?.domain;
    const spec = requireSpec(target);
    if (!spec.aliases.includes(alias)) spec.aliases = [...spec.aliases, alias];
    storeSpec(spec);
    requireApache();
    const result = await writeSpec(spec, req);
    audit(req, { action: 'web.alias.add', target: spec.domain, args: { alias, username: spec.username } });
    return result;
  }

  async function removeAlias({ username, alias, domain }, req) {
    const target = domain || stmts.vhostsByUser.all(username).find((v) => json.parse(v.aliases_json, []).includes(alias))?.domain || stmts.accountByUsername.get(username)?.domain;
    const spec = requireSpec(target);
    spec.aliases = spec.aliases.filter((a) => a !== alias);
    storeSpec(spec);
    requireApache();
    const result = await writeSpec(spec, req);
    audit(req, { action: 'web.alias.remove', target: spec.domain, args: { alias, username: spec.username } });
    return result;
  }

  async function setAccountIpv6(username, address, req) {
    const account = stmts.accountByUsername.get(username);
    if (!account) throw notFound(`Account "${username}"`);
    const specs = stmts.vhostsByUser.all(username).map(shapeVhost);
    const list = specs.length ? specs : specsFor(account);
    for (const s of list) { s.ipv6 = address || null; storeSpec(s); }
    requireApache();
    const results = [];
    let written = 0;
    try {
      for (const s of list) { results.push(await writeSpec(s, req, { reload: false })); written++; }
    } finally { await reloadAfter(written, req); }
    const defaultVhost = await ensureDefaultVhost(req);
    audit(req, { action: 'web.ipv6.set', target: username, args: { address } });
    return { username, address, vhosts: results, defaultVhost };
  }

  async function replaceIp(from, to, { accounts } = {}, req) {
    let rows = stmts.vhostsByIp.all(from).map(shapeVhost);
    if (accounts?.length) rows = rows.filter((r) => accounts.includes(r.username));
    for (const r of rows) { r.ip = to; storeSpec(r); }
    if (!rows.length) return { updated: 0, domains: [], defaultVhost: await refreshDefaultVhostAddresses(req) };
    requireApache();
    let updated = 0;
    for (const r of rows) { try { await writeSpec(r, req, { reload: false }); updated++; } catch (err) { logger.warn({ err, domain: r.domain }, 'web: ip replacement failed'); } }
    await reloadAfter(updated, req);
    const defaultVhost = await ensureDefaultVhost(req);
    audit(req, { action: 'web.ip.replace', target: `${from} -> ${to}`, args: { updated, domains: rows.map((r) => r.domain) } });
    return { updated, domains: rows.map((r) => r.domain), defaultVhost };
  }

  // `reload: false` lets a caller batching many domains (MultiPHP Manager)
  // reload Apache once itself.
  async function setPhpVersion(domain, versionInput, req, { reload = true } = {}) {
    const spec = requireSpec(domain);
    const version = versionInput == null ? null : phpVersionId(versionInput);
    if (versionInput != null && !version) throw badRequest(`"${versionInput}" is not a PHP version`);
    requireApache();
    if (version) await ensurePool(stmts.accountByUsername.get(spec.username), version, req);
    spec.phpVersion = version;
    storeSpec(spec);
    const result = await writeSpec(spec, req, { reload });
    audit(req, { action: 'web.php.set', target: domain, args: { version } });
    return result;
  }

  // `bind` (e.g. 127.0.0.1 behind the Software category's nginx proxy) moves
  // every Listen and every vhost to that address; https: null releases 443.
  async function setListenPorts({ http, https = 443, bind = null }, req) {
    requireApache();
    const result = await op('web.ports.set', { http, https, bind }, req);
    settings.set('service_config.apache_ports', { http, https, bind });
    const rows = stmts.vhostsAll.all().map(shapeVhost);
    let written = 0;
    for (const r of rows) { try { await writeSpec(r, req, { reload: false }); written++; } catch (err) { logger.warn({ err, domain: r.domain }, 'web: vhost port rewrite failed'); } }
    await reloadAfter(written, req);
    // The catch-all binds to the same ports/address or the first tenant on
    // them answers the bare address again.
    const defaultVhost = await ensureDefaultVhost(req);
    audit(req, { action: 'web.ports.set', args: { http, https, bind, vhosts: rows.length } });
    return { ...result, vhosts: rows.length, defaultVhost };
  }

  async function syncAllJob(job) {
    const accounts = stmts.accounts.all();
    const summary = { accounts: accounts.length, applied: 0, pending: 0, failed: 0 };
    let i = 0;
    for (const a of accounts) {
      i++;
      job.progress((i / Math.max(1, accounts.length)) * 100, a.username);
      try {
        const r = await ensureVhost(a, null);
        if (r.applied) summary.applied++; else if (r.reason === 'capability_missing') summary.pending++; else summary.failed++;
        job.log(`${a.username}: ${r.vhosts.map((v) => `${v.domain} ${v.applied ? 'ok' : v.reason}`).join(', ')}`);
      } catch (err) { summary.failed++; job.log(`${a.username}: ${err.message}`, 'error'); }
    }
    const server = await ensureHostnameVhost(null);
    job.log(`${server.hostname}: hostname vhost ${server.applied ? 'ok' : server.reason}`);
    summary.hostname = { hostname: server.hostname, applied: Boolean(server.applied), reason: server.reason ?? null };
    recordApply('vhosts', summary.failed === 0, summary);
    return summary;
  }

  // ------------------------------------------------------------- apache ---

  const apache = {
    settings: () => getConf('apache'),
    async get() {
      await capabilities.ensureFresh();
      const d = await detect(true).catch((err) => ({ apache: { installed: false, error: err.message }, php: { versions: [] } }));
      const ports = listenPorts();
      const status = capabilities.has('apache') ? await op('web.status', { port: ports.http, bind: ports.bind }).catch((err) => ({ installed: true, error: err.message })) : { installed: false };
      const include = capabilities.has('apache') ? await op('web.global.read').catch(() => null) : null;
      const rows = accountVhosts().map(shapeVhost);
      return {
        installed: capabilities.has('apache'), detect: d.apache, php: d.php, nginx: d.nginx, status, include, settings: getConf('apache'), lastApply: lastApply('apache'), ports: listenPorts(), domlogsRoot: DOMLOGS_ROOT,
        forceHttps: forceHttps(), rewriteModule: Array.isArray(d.apache?.modules) ? d.apache.modules.some((m) => m.name === 'rewrite') : null,
        hostnameVhost: shapeVhost(stmts.vhostsByType.all('server')[0]) ?? null, landingDocroot: LANDING_DOCROOT, defaultVhost: lastApply('default_vhost'),
        vhosts: { total: rows.length, applied: rows.filter((r) => r.status === 'applied').length, pending: rows.filter((r) => r.status === 'pending').length, failed: rows.filter((r) => r.status === 'failed').length },
        pools: stmts.pools.all().map((p) => ({ username: p.username, version: p.version, socket: p.socket, status: p.status, error: p.error })),
      };
    },
    directives(s = getConf('apache')) {
      const d = { timeout: s.timeout, keepAlive: s.keepAlive, maxKeepAliveRequests: s.maxKeepAliveRequests, keepAliveTimeout: s.keepAliveTimeout, serverTokens: s.serverTokens, serverSignature: s.serverSignature, traceEnable: s.traceEnable, hostnameLookups: s.hostnameLookups, directoryIndex: s.directoryIndex, fileETag: s.fileETag, limitRequestBody: s.limitRequestBody, serverStatus: s.serverStatus, mpm: s.mpm, customDirectives: s.customDirectives || '' };
      if (s.serverAdmin) d.serverAdmin = s.serverAdmin;
      return d;
    },
    async update(input, req) {
      const current = getConf('apache');
      const next = { ...current, ...input, mpm: { ...current.mpm, ...(input.mpm || {}) } };
      if (next.mpm.module === 'prefork' ? next.mpm.minSpareServers > next.mpm.maxSpareServers : next.mpm.minSpareThreads > next.mpm.maxSpareThreads) throw unprocessable('Minimum spare must not exceed maximum spare', { mpm: ['min spare > max spare'] });
      setConf('apache', next);
      audit(req, { action: 'apache.config.update', args: input });
      if (!capabilities.has('apache')) { recordApply('apache', false, null, 'Apache is not installed'); throw new CapabilityError('apache', 'Apache is not installed on this server. The settings were saved and are applied once apache2/httpd is installed.'); }
      const applied = { include: null, mpm: null };
      try {
        const d = await detect(true);
        // The include is dry-run before the MPM switch (a restart) so a rejected
        // directive never leaves the host with the new MPM and the old include.
        const directives = apache.directives(next);
        const dry = await op('web.global.write', { directives, dryRun: true }, req);
        if (dry.ok === false) throw unprocessable(`Apache rejected the directives: ${String(dry.output || '').trim().split('\n').pop() || 'configtest failed'}`, { customDirectives: ['Rejected by apache2ctl -t'] });
        if (next.mpm.module && d.apache?.mpm && d.apache.mpm !== next.mpm.module) applied.mpm = await op('web.mpm.set', { module: next.mpm.module }, req);
        applied.include = await op('web.global.write', { directives, reload: true }, req);
        recordApply('apache', true, { path: applied.include.path, mpm: applied.mpm?.module ?? d.apache?.mpm ?? null, reloaded: applied.include.reloaded });
        invalidate();
      } catch (err) {
        recordApply('apache', false, null, err.message);
        throw err;
      }
      return { settings: next, applied, lastApply: lastApply('apache') };
    },
    async configtest(input = {}) {
      requireApache();
      const current = getConf('apache');
      const next = { ...current, ...input, mpm: { ...current.mpm, ...(input.mpm || {}) } };
      return op('web.global.write', { directives: apache.directives(next), dryRun: true });
    },
    async reload(req) { requireApache(); const r = await op('web.reload', {}, req); audit(req, { action: 'apache.reload' }); invalidate(); return r; },
    async restart(req) { requireApache(); const r = await op('web.restart', {}, req); audit(req, { action: 'apache.restart' }); invalidate(); return r; },
    // Flips the redirect and re-renders every vhost that has a certificate
    // (the only ones the flag changes) with one reload.
    async setForceHttps(enabled, req) {
      settings.set('web.force_https', Boolean(enabled));
      audit(req, { action: 'apache.force_https', args: { enabled: Boolean(enabled) } });
      const rows = stmts.vhostsAll.all().filter((r) => r.ssl_json).map((r) => { const s = shapeVhost(r); s.logDir = domlogDir(s.username); return s; });
      let written = 0;
      const failed = [];
      if (capabilities.has('apache')) {
        for (const spec of rows) { try { await writeSpec(spec, req, { reload: false }); written++; } catch (err) { failed.push({ domain: spec.domain, error: err.message }); } }
      }
      const reload = await reloadAfter(written, req);
      return { forceHttps: forceHttps(), vhosts: rows.length, written, failed, reload, applied: capabilities.has('apache') };
    },
    vhosts: {
      async list() {
        const rows = stmts.vhostsAll.all().map(shapeVhost);
        let live = [];
        if (capabilities.has('apache')) { try { live = (await op('web.vhost.list')).vhosts; } catch (err) { logger.warn({ err }, 'web: vhost listing failed'); } }
        const known = new Set(rows.map((r) => r.domain));
        const out = rows.map((r) => ({ ...r, live: live.find((l) => l.domain === r.domain) || null }));
        for (const l of live) if (!known.has(l.domain)) out.push({ domain: l.domain, username: l.meta?.user ?? null, type: l.meta?.type ?? 'unmanaged', docroot: l.meta?.docroot ?? null, status: 'unmanaged', path: l.path, live: l, aliases: l.meta?.aliases || [], ssl: l.meta?.ssl ? {} : null, redirects: [] });
        return out.sort((a, b) => a.domain.localeCompare(b.domain));
      },
      // The op's `meta` field would be mistaken for the list envelope by the route wrapper.
      async read(domain) { requireApache(); const { meta, ...rest } = await op('web.vhost.read', { domain }); return { ...rest, metadata: meta ?? null, spec: shapeVhost(stmts.vhostByDomain.get(domain)) ?? null }; },
      syncAll(user, req) {
        const job = ctx.jobs.enqueue('web.vhosts.sync', {}, { userId: user?.id ?? null });
        audit(req, { action: 'web.vhosts.sync_all', args: { job: job.id } });
        return { job };
      },
      async sync(username, req) { return ensureVhost(username, req); },
    },
  };

  // ---------------------------------------------------------- logrotate ---

  // The web server policy only names logs no distribution file already rotates
  // (logrotate reports duplicates as errors and the panel would roll back).
  const DISTRIBUTION_LOGS = { apache2: '/var/log/apache2/*.log', httpd: '/var/log/httpd/*log', nginx: '/var/log/nginx/*.log' };

  const logrotate = {
    settings: () => getConf('logrotate'),
    policy(name, s = getConf('logrotate'), { distribution = {} } = {}) {
      const base = LOGROTATE_POLICIES[name];
      const postrotate = (p) => (p === 'apache-reload' && !s.postrotateWeb ? 'none' : p);
      const covered = Object.entries(DISTRIBUTION_LOGS).filter(([k]) => distribution[k]).map(([, glob]) => glob);
      const paths = base.paths.filter((p) => !covered.includes(p));
      const policy = { name, paths, frequency: s.frequency, rotate: s.rotate, compress: s.compress, delaycompress: s.compress && s.delaycompress, missingok: s.missingok, notifempty: s.notifempty, dateext: s.dateext, copytruncate: Boolean(base.copytruncate), ...(s.maxSize ? { maxSize: s.maxSize } : {}), ...(base.su ? { su: base.su } : {}), postrotate: postrotate(base.postrotate), sharedscripts: true, coveredBy: Object.entries(DISTRIBUTION_LOGS).filter(([k]) => distribution[k] && base.paths.includes(DISTRIBUTION_LOGS[k])).map(([k]) => distribution[k]) };
      if (base.perAccount) {
        const stanzas = [{ paths: [...base.paths], su: base.su, postrotate: policy.postrotate }];
        for (const a of stmts.accounts.all()) {
          const home = a.home_dir || `${settings.get('basic.home_root') || '/home'}/${a.username}`;
          const glob = `${home}/${base.perAccount.subpath}`;
          stanzas.push({ paths: [glob], su: { user: a.username, group: a.username }, postrotate: base.perAccount.postrotate });
          policy.paths.push(glob);
        }
        policy.stanzas = stanzas;
      }
      return policy;
    },
    enabled(s = getConf('logrotate')) { return Object.keys(LOGROTATE_POLICIES).filter((n) => ({ panel: s.panelLogs, accounts: s.accountLogs, webserver: s.webServerLogs })[n]); },
    async get() {
      await capabilities.ensureFresh();
      const s = getConf('logrotate');
      const list = await op('web.logrotate.list').catch((err) => ({ dir: '/etc/logrotate.d', logrotate: false, policies: [], error: err.message }));
      const files = {};
      for (const name of Object.keys(LOGROTATE_POLICIES)) files[name] = await op('web.logrotate.read', { name }).catch(() => ({ name, exists: false, content: null }));
      return { installed: capabilities.has('logrotate'), settings: s, policies: Object.keys(LOGROTATE_POLICIES).map((name) => { const { coveredBy, ...preview } = logrotate.policy(name, s, { distribution: list.distribution || {} }); return { name, enabled: logrotate.enabled(s).includes(name), paths: preview.paths, coveredBy, perAccount: Boolean(LOGROTATE_POLICIES[name].perAccount), file: files[name], preview }; }), managed: list, lastApply: lastApply('logrotate') };
    },
    async update(input, req) {
      const next = { ...getConf('logrotate'), ...input };
      setConf('logrotate', next);
      audit(req, { action: 'logrotate.config.update', args: input });
      if (!capabilities.has('logrotate')) { recordApply('logrotate', false, null, 'logrotate is not installed'); throw new CapabilityError('logrotate', 'logrotate is not installed on this server. Install the logrotate package; the policy you saved is written once it is.'); }
      const results = {};
      try {
        const distribution = (await op('web.logrotate.list').catch(() => ({}))).distribution || {};
        for (const name of Object.keys(LOGROTATE_POLICIES)) {
          const { coveredBy, ...policy } = logrotate.policy(name, next, { distribution });
          if (logrotate.enabled(next).includes(name) && policy.paths.length) results[name] = { ...(await op('web.logrotate.write', policy, req)), coveredBy };
          else results[name] = { ...(await op('web.logrotate.remove', { name }, req)), coveredBy, note: coveredBy?.length && !policy.paths.length ? `Every log in this policy is already rotated by ${coveredBy.join(', ')}; nothing to write.` : null };
        }
        recordApply('logrotate', true, { policies: Object.keys(results) });
      } catch (err) { recordApply('logrotate', false, null, err.message); throw err; }
      return { settings: next, applied: results, lastApply: lastApply('logrotate') };
    },
    async run(name, force, req) {
      if (!LOGROTATE_POLICIES[name]) throw notFound(`Policy "${name}"`);
      capabilities.require('logrotate', 'logrotate is not installed on this server');
      const r = await op('web.logrotate.run', { name, force: Boolean(force) }, req);
      audit(req, { action: 'logrotate.run', target: name, args: { force: Boolean(force), ok: r.ok } });
      return r;
    },
  };

  // ------------------------------------------------- web disk / services ---

  // Web Disk and the panel's HTTP tuning are stored for services that do not
  // consume them yet (no WebDAV daemon ships with the panel; the API server
  // reads its limits from its own config), so `live: false` tells the page.
  const simpleSettings = (component, action) => ({
    get: () => ({ settings: getConf(component), lastUpdate: settings.get(`service_config.${component}_updated_at`, null), live: false }),
    update(input, req) {
      const next = { ...getConf(component), ...input };
      setConf(component, next);
      settings.set(`service_config.${component}_updated_at`, new Date().toISOString());
      audit(req, { action, args: input });
      return { settings: next, live: false };
    },
  });
  const webdisk = {
    ...simpleSettings('webdisk', 'webdisk.config.update'),
    update(input, req) {
      if (input.port != null && input.sslPort != null && input.port === input.sslPort) throw unprocessable('The plain and SSL ports must differ', { sslPort: ['Must differ from port'] });
      const next = { ...getConf('webdisk'), ...input };
      if (next.port === next.sslPort) throw unprocessable('The plain and SSL ports must differ', { sslPort: ['Must differ from port'] });
      setConf('webdisk', next);
      settings.set('service_config.webdisk_updated_at', new Date().toISOString());
      audit(req, { action: 'webdisk.config.update', args: input });
      return { settings: next, live: false };
    },
  };
  const webservices = simpleSettings('webservices', 'webservices.config.update');

  // --------------------------------------------------------------- exim ---

  const exim = {
    settings: () => getConf('exim'),
    async layout() { return op('web.exim.detect').catch((err) => ({ installed: false, error: err.message })); },
    preview(s = getConf('exim'), layout = null) {
      const l = layout?.slots ? layout : { flavor: 'rhel', splitConfig: false, emailAclFile: '/etc/exim/whm/acl-email-filters.conf', slots: { main: { path: '/etc/exim/whm/service_config.conf' }, acl_rcpt: { path: '/etc/exim/whm/acl-rcpt-local.conf', includes: '/etc/exim/whm/acl-email-filters.conf' }, acl_data: { path: '/etc/exim/whm/acl_data_whm.conf' } } };
      const support = eximSupport(layout);
      return { main: renderEximMain(s, l, support), acl_rcpt: renderEximRcptAcl(s, support, l), acl_data: renderEximDataAcl(s, support) };
    },
    warnings(s, layout) {
      const support = eximSupport(layout);
      const out = [];
      if (s.spfVerify && !support.spf) out.push('SPF is not compiled into this Exim build (Debian\'s exim4-daemon-light). The SPF rules are left out of the generated ACL so Exim keeps starting; install exim4-daemon-heavy to verify or reject on SPF.');
      if (s.dkimVerify && !support.dkim) out.push('DKIM is not compiled into this Exim build; the DKIM verification rules are left out of the DATA ACL.');
      return out;
    },
    // Slots whose content must be reached by Exim for the saved policy to be in
    // force: a written but unincluded RCPT fragment means none of the reject
    // rules run, so the apply is not reported as ok.
    // A hookable slot that was never written is merely pending (the next save
    // defines its macro); one that exists, is claimed elsewhere or needs a
    // manual include is inactive.
    inactive(s, slots, layout, { written = false } = {}) {
      const required = ['main', 'acl_rcpt', ...(s.dkimVerify && eximSupport(layout).dkim ? ['acl_data'] : [])];
      return required.filter((k) => slots?.[k] && slots[k].hooked === false && (written || slots[k].exists || slots[k].claimedBy || !slots[k].hookable));
    },
    async get() {
      await capabilities.ensureFresh();
      const layout = await exim.layout();
      const s = getConf('exim');
      let mailStatus = null;
      if (typeof ctx.mail?.status === 'function') { try { const st = await ctx.mail.status(); mailStatus = { installed: st.installed, queue: st.queue, filters: st.filters }; } catch { mailStatus = null; } }
      const installed = capabilities.has('exim') && layout.installed !== false;
      const rcpt = layout.slots?.acl_rcpt;
      return { installed, layout, settings: s, preview: exim.preview(s, layout.slots ? layout : null), support: { ...eximSupport(layout), tls: installed ? eximTlsLibrary(layout) : null }, warnings: installed ? exim.warnings(s, layout) : [], inactive: installed ? exim.inactive(s, layout.slots, layout) : [], lastApply: lastApply('exim'), mail: mailStatus, emailCategory: Boolean(ctx.mail), chain: rcpt ? { path: rcpt.path, emailAclFile: layout.emailAclFile ?? rcpt.includes ?? null, includesEmailFilters: rcpt.includesEmailFilters ?? null, hooked: rcpt.hooked ?? null, claimedBy: rcpt.claimedBy ?? null } : null };
    },
    requireInstalled(layout) {
      if (!capabilities.has('exim') || layout.installed === false) { recordApply('exim', false, null, 'Exim is not installed'); throw new CapabilityError('exim', 'Exim is not installed on this server. The settings were saved and are rendered into Exim once exim4/exim is installed.'); }
    },
    // Writes the three slots (macros last, so the files they point at exist
    // when the generated configuration is validated) and records the apply.
    async apply(next, layout, req) {
      const rendered = exim.preview(next, layout);
      const applied = {};
      let inactive = [];
      try {
        const slots = ['acl_data', 'acl_rcpt', 'main'];
        for (const [i, slot] of slots.entries()) applied[slot] = await op('web.exim.include.write', { slot, content: rendered[slot], reload: i === slots.length - 1 }, req);
        inactive = exim.inactive(next, applied, layout, { written: true });
        for (const slot of slots) applied[slot].applied = !inactive.includes(slot);
        const summary = { slots: Object.fromEntries(Object.entries(applied).map(([k, v]) => [k, { path: v.path, hooked: v.hooked }])), version: applied.main.version, inactive };
        const error = inactive.length ? `written, but Exim does not include ${inactive.map((k) => applied[k].path).join(', ')}${applied.acl_rcpt.claimedBy ? ` (CHECK_RCPT_LOCAL_ACL_FILE is used by ${applied.acl_rcpt.claimedBy})` : ''}; the rules in there are not in force` : null;
        recordApply('exim', inactive.length === 0, summary, error);
      } catch (err) { recordApply('exim', false, null, err.message); throw err; }
      return { applied, live: inactive.length === 0, inactive };
    },
    async update(input, req) {
      const next = { ...getConf('exim'), ...input };
      if (input.tls !== undefined) next.tls = tlsPolicyFrom(input.tls);
      if (next.rblEnabled && !next.rbls.length) throw unprocessable('Add at least one RBL or disable RBL checks', { rbls: ['Required when RBL checks are enabled'] });
      if (next.ratelimitEnabled && next.ratelimitRcptThreshold < next.ratelimitMailThreshold) throw unprocessable('The recipient threshold should be at least the message threshold', { ratelimitRcptThreshold: ['Lower than the message threshold'] });
      setConf('exim', next);
      audit(req, { action: 'exim.config.update', args: input });
      const layout = await exim.layout();
      exim.requireInstalled(layout);
      const result = await exim.apply(next, layout, req);
      return { settings: next, ...result, warnings: exim.warnings(next, layout), hints: layout.hints || [], lastApply: lastApply('exim') };
    },
    // Email's hook: before it writes acl-email-filters.conf it makes sure the
    // chain file (which ends with an include of that file) and the macro that
    // hooks the chain into acl_check_rcpt exist, rendering the saved or default
    // policy when Exim Configuration Manager was never saved. Throws
    // CapabilityError without Exim so the caller falls back to its own macro.
    async ensureEximAclChain(req = null) {
      await capabilities.ensureFresh();
      const layout = await exim.layout();
      if (!capabilities.has('exim') || layout.installed === false) throw new CapabilityError('exim', 'Exim is not installed on this server');
      const rcpt = layout.slots?.acl_rcpt;
      const main = layout.slots?.main;
      const complete = Boolean(rcpt?.exists && rcpt.includesEmailFilters !== false && main?.exists && lastApply('exim'));
      if (complete) return { created: false, path: rcpt.path, emailAclFile: layout.emailAclFile, hooked: rcpt.hooked ?? null, claimedBy: rcpt.claimedBy ?? null };
      const { applied, live } = await exim.apply(getConf('exim'), layout, req);
      audit(req, { action: 'exim.acl_chain.ensure', target: applied.acl_rcpt.path, args: { live } });
      return { created: true, path: applied.acl_rcpt.path, emailAclFile: layout.emailAclFile, hooked: applied.acl_rcpt.hooked ?? null, claimedBy: applied.acl_rcpt.claimedBy ?? null, live };
    },
    // SSL/TLS Configuration hands its preset over; the TLS options are rendered
    // into the main slot with everything else and validated the same way.
    async applyEximTls(preset, req) {
      const tls = tlsPolicyFrom(preset);
      const r = await exim.update({ tls }, req);
      return { path: r.applied.main.path, validated: Boolean(r.applied.main.validated), live: r.live, inactive: r.inactive, library: eximTlsLibrary(await exim.layout()), tls, reload: { reloaded: Boolean(r.applied.main.reloaded), unit: r.applied.main.unit ?? null }, hints: r.hints };
    },
  };

  // --------------------------------------------------------- mailserver ---

  const mailserver = {
    settings: () => getConf('mailserver'),
    async get() {
      await capabilities.ensureFresh();
      const d = await op('web.dovecot.detect').catch((err) => ({ installed: false, error: err.message }));
      const s = getConf('mailserver');
      return { installed: capabilities.has('dovecot') && d.installed !== false, detect: d, settings: s, preview: renderDovecot(s, { version: d.version }), cipherSuitesSupported: dovecotSupportsCipherSuites(d.version), lastApply: lastApply('dovecot') };
    },
    async update(input, req) {
      const next = { ...getConf('mailserver'), ...input };
      if (!next.protocols.length) throw unprocessable('Enable at least one protocol', { protocols: ['At least one of imap, pop3, lmtp'] });
      if (next.ssl === 'required' && !next.disablePlaintextAuth) next.disablePlaintextAuth = true;
      setConf('mailserver', next);
      audit(req, { action: 'mailserver.config.update', args: input });
      if (!capabilities.has('dovecot')) { recordApply('dovecot', false, null, 'Dovecot is not installed'); throw new CapabilityError('dovecot', 'Dovecot is not installed on this server. The settings were saved and are written to Dovecot once it is installed.'); }
      try {
        const d = await op('web.dovecot.detect').catch(() => ({ version: null }));
        const r = await op('web.dovecot.include.write', { content: renderDovecot(next, { version: d.version }), reload: true }, req);
        recordApply('dovecot', true, { path: r.path, validated: r.validated, reloaded: r.reloaded });
        return { settings: next, applied: r, lastApply: lastApply('dovecot') };
      } catch (err) { recordApply('dovecot', false, null, err.message); throw err; }
    },
    // SSL/TLS Configuration's preset for Dovecot: this file owns ssl_min_protocol,
    // ssl_cipher_list, ssl_cipher_suites and ssl_prefer_server_ciphers, so the
    // preset is stored here and re-rendered with the rest of the settings.
    async applyMailserverTls(preset, req) {
      const tls = tlsPolicyFrom(preset);
      const r = await mailserver.update({ sslMinProtocol: tls.minProtocol, sslCipherList: tls.cipherList, sslCipherSuites: tls.cipherSuites, sslPreferServerCiphers: tls.preferServerCiphers }, req);
      return { path: r.applied.path, validated: Boolean(r.applied.validated), tls, reload: { reloaded: Boolean(r.applied.reloaded), unit: r.applied.unit ?? null } };
    },
  };

  // ---------------------------------------------------------------- ftp ---

  function pkgService() {
    const p = ctx.pkg || ctx.software?.pkg;
    return p && typeof p.install === 'function' ? p : null;
  }

  async function installPackage(candidate, detectResult, user, req, action) {
    const pkg = pkgService();
    const manager = detectResult.packageManager ? detectResult.packageManager.replace('-get', '') : null;
    const name = (manager && candidate.packages[manager]) || candidate.packages.apt;
    if (!pkg) throw new CapabilityError(detectResult.role === 'ftp' ? 'ftp' : 'bind', `${candidate.label} is not installed on this server. Install the "${name}" package (the Software category is not loaded, so the panel cannot install it for you), then select it here.`);
    const { job } = await pkg.install([name], user, req);
    audit(req, { action, target: candidate.name, args: { package: name, job: job?.id ?? null } });
    return { job, package: name, server: candidate.name, pending: true };
  }

  const ftp = {
    settings: () => getConf('ftp'),
    selected: () => settings.get('service_config.ftp_server', 'pure-ftpd'),
    async get() {
      await capabilities.ensureFresh();
      const d = await op('web.service.detect', { role: 'ftp' }).catch((err) => ({ role: 'ftp', candidates: [], active: [], enabled: [], current: null, error: err.message }));
      const selected = ftp.selected();
      const active = d.current || null;
      let config = null;
      const activeCandidate = d.candidates.find((c) => c.name === (active || selected));
      if (activeCandidate?.installed) config = await op('web.ftp.config.read', { server: activeCandidate.name }).catch((err) => ({ error: err.message }));
      return { installed: capabilities.has('ftp'), selected, active, detect: d, settings: getConf('ftp'), config, pkgAvailable: Boolean(pkgService()), lastApply: lastApply('ftp'), recentJobs: ctx.jobs.list({ limit: 100 }).filter((j) => j.type === 'software.pkg.install' && (j.params?.packages || []).some((p) => /ftpd/.test(p))).slice(0, 5).map((j) => ({ id: j.id, status: j.status, params: j.params, created_at: j.created_at })) };
    },
    async select({ server, install = false }, user, req) {
      if (!FTP_SERVERS.includes(server)) throw badRequest(`server must be one of ${FTP_SERVERS.join(', ')}`);
      const d = await op('web.service.detect', { role: 'ftp' });
      const candidate = d.candidates.find((c) => c.name === server);
      if (server !== 'disabled' && !candidate?.unitName) {
        if (install) { settings.set('service_config.ftp_server', server); return installPackage(candidate, d, user, req, 'ftp.server.install'); }
        throw new CapabilityError('ftp', `${candidate.label} is not installed on this server. Tick "install" to add it through the package manager, or install the "${candidate.packages[(d.packageManager || 'apt-get').replace('-get', '')] || candidate.packages.apt}" package yourself.`);
      }
      const result = await op('web.service.select', { role: 'ftp', server }, req);
      settings.set('service_config.ftp_server', server);
      let config = null;
      if (server !== 'disabled') { try { config = await op('web.ftp.config.write', { server, settings: ftp.args(getConf('ftp')), restart: true }, req); } catch (err) { config = { error: err.message }; } }
      recordApply('ftp', config ? ftp.applied(config) : true, { server, steps: result.steps.length, written: config?.written ?? null }, config ? ftp.applyError(config) : null);
      audit(req, { action: 'ftp.server.select', target: server, args: { steps: result.steps } });
      invalidate();
      return { server, ...result, config };
    },
    args(s) {
      const out = { passivePortMin: s.passivePortMin, passivePortMax: s.passivePortMax, tls: s.tls, maxClients: s.maxClients, maxPerIp: s.maxPerIp, anonymous: s.anonymous, idleTimeoutMinutes: s.idleTimeoutMinutes, chroot: s.chroot, passiveAddress: s.passiveAddress || null };
      return out;
    },
    // A write only counts as applied when the daemon came back with it.
    applied: (r) => r.validated !== false && r.reloaded === true,
    applyError(r) {
      if (r.error && r.reloaded == null) return r.error;
      if (r.validated === false) return `the daemon rejected the configuration${r.error ? `: ${r.error}` : ''}`;
      if (r.reloaded !== true) return `the daemon was not restarted${r.unit ? ` (${r.unit}: ${r.error || 'restart failed'})` : ' (no systemd unit found)'}`;
      return r.error || null;
    },
    async updateSettings(input, req) {
      const next = { ...getConf('ftp'), ...input };
      if (next.passivePortMin > next.passivePortMax) throw unprocessable('Passive port range is inverted', { passivePortMax: ['Must be at least the minimum port'] });
      setConf('ftp', next);
      audit(req, { action: 'ftp.config.update', args: input });
      const d = capabilities.has('ftp') ? await op('web.service.detect', { role: 'ftp' }).catch(() => ({ candidates: [], current: null })) : { candidates: [], current: null };
      const target = d.candidates.find((c) => c.name === (d.current || ftp.selected()) && c.installed);
      if (!target && !d.current && ftp.selected() === 'disabled' && d.candidates.some((c) => c.installed)) { recordApply('ftp', false, null, 'FTP is disabled'); throw unprocessable('FTP is disabled under FTP Server Selection; the settings were saved and are applied once a daemon is selected there.', { server: ['Select an FTP daemon first'] }); }
      if (!target) { recordApply('ftp', false, null, 'No FTP daemon is installed'); throw new CapabilityError('ftp', 'No FTP daemon is installed on this server. Choose one under FTP Server Selection; the settings were saved and are applied when it is installed.'); }
      try {
        const r = await op('web.ftp.config.write', { server: target.name, settings: ftp.args(next), restart: true }, req);
        recordApply('ftp', ftp.applied(r), { server: target.name, written: r.written }, ftp.applyError(r));
        return { settings: next, applied: r, live: ftp.applied(r), lastApply: lastApply('ftp') };
      } catch (err) { recordApply('ftp', false, null, err.message); throw err; }
    },
    async setPassiveAddress({ ipv4 }, req) { return ftp.updateSettings({ passiveAddress: ipv4 || '' }, req); },
  };

  // --------------------------------------------------------- nameserver ---

  const nameserver = {
    settings: () => getConf('nameserver'),
    async get() {
      await capabilities.ensureFresh();
      const d = await op('web.service.detect', { role: 'dns' }).catch((err) => ({ role: 'dns', candidates: [], active: [], enabled: [], current: null, error: err.message }));
      let dnsLayout = null;
      if (typeof ctx.dns?.layout === 'function') { try { dnsLayout = await ctx.dns.layout(); } catch { dnsLayout = null; } }
      return { settings: getConf('nameserver'), active: d.current || null, detect: d, pkgAvailable: Boolean(pkgService()), dnsCategory: Boolean(ctx.dns), dnsLayout, zones: safeCount('SELECT COUNT(*) AS n FROM dns_zones'), lastApply: lastApply('nameserver'), recentJobs: ctx.jobs.list({ limit: 100 }).filter((j) => j.type === 'software.pkg.install' && (j.params?.packages || []).some((p) => /bind|pdns/.test(p))).slice(0, 5).map((j) => ({ id: j.id, status: j.status, params: j.params, created_at: j.created_at })) };
    },
    async select({ server, role = 'master', install = false }, user, req) {
      if (!DNS_SERVERS.includes(server)) throw badRequest(`server must be one of ${DNS_SERVERS.join(', ')}`);
      const d = await op('web.service.detect', { role: 'dns' });
      const candidate = d.candidates.find((c) => c.name === server);
      if (server !== 'disabled' && !candidate?.unitName) {
        if (install) { setConf('nameserver', { server, role }); return installPackage(candidate, d, user, req, 'nameserver.install'); }
        throw new CapabilityError(server === 'powerdns' ? 'powerdns' : 'bind', `${candidate.label} is not installed on this server. Tick "install" to add it through the package manager, or install the "${candidate.packages[(d.packageManager || 'apt-get').replace('-get', '')] || candidate.packages.apt}" package yourself.`);
      }
      const result = await op('web.service.select', { role: 'dns', server }, req);
      setConf('nameserver', { server, role });
      recordApply('nameserver', true, { server, role, steps: result.steps.length });
      audit(req, { action: 'nameserver.select', target: server, args: { role, steps: result.steps } });
      invalidate();
      await capabilities.refresh().catch(() => null);
      return { ...result, server, role };
    },
  };

  function safeCount(sql) { try { return db.prepare(sql).get().n; } catch { return null; } }

  // ------------------------------------------------------ service certs ---

  const certs = {
    async list() {
      await capabilities.ensureFresh();
      let rows;
      if (typeof ctx.ssl?.serviceCertStatus === 'function') rows = await ctx.ssl.serviceCertStatus();
      else {
        const files = await op('ssl.service_cert.status').catch(() => ({}));
        rows = SSL_SERVICES.map((service) => ({ service, ...(files[service] || { daemonPresent: null, hasCertificate: false, certificate: null }), stored: null, daysRemaining: files[service]?.certificate?.daysRemaining ?? null }));
      }
      const labels = { exim: 'Exim (SMTP)', dovecot: 'Dovecot (IMAP/POP3)', apache: 'Apache (default SSL vhost)', ftp: 'FTP server', panel: 'WHM panel (2087)' };
      return { openssl: capabilities.has('ssl'), sslCategory: Boolean(ctx.ssl), hostname: hostname(), services: rows.map((r) => ({ ...r, label: labels[r.service] || r.service, selfSigned: r.certificate?.selfSigned ?? null, expired: r.certificate?.expired ?? null, notAfter: r.certificate?.notAfter ?? r.stored?.notAfter ?? null, subject: r.certificate?.subjectText ?? null, issuer: r.certificate?.issuerText ?? null })) };
    },
    async install(service, pems, req) {
      if (!SSL_SERVICES.includes(service)) throw badRequest(`Unknown service "${service}"`);
      capabilities.require('ssl', 'openssl is not installed on this server; install the openssl package');
      const result = typeof ctx.ssl?.installServiceCert === 'function' ? await ctx.ssl.installServiceCert(service, pems, req) : await op('ssl.service_cert.install', { service, certPem: pems.certPem, keyPem: pems.keyPem, ...(pems.chainPem ? { chainPem: pems.chainPem } : {}) }, req);
      audit(req, { action: 'service_ssl.install', target: service, args: { issuer: result.certificate?.issuerText, notAfter: result.certificate?.notAfter } });
      return result;
    },
    async reset(service, { days = 365 } = {}, req) {
      if (!SSL_SERVICES.includes(service)) throw badRequest(`Unknown service "${service}"`);
      capabilities.require('ssl', 'openssl is not installed on this server; install the openssl package');
      // The agent's certificate names are lowercase-only; the mail SAN is the
      // hostname's parent domain (panel.example.com -> mail.example.com), never
      // the last two labels (which would give mail.co.uk).
      const host = hostname().toLowerCase();
      const labels = host.split('.');
      const sans = [...new Set([host, `www.${host}`, ...(labels.length >= 3 ? [`mail.${labels.slice(1).join('.')}`] : [])].filter((n) => /^[a-z0-9.-]+$/.test(n)))];
      const generated = await op('ssl.selfsigned.generate', { key: { type: 'rsa', bits: 2048 }, subject: { CN: host, O: 'WHM panel' }, sans, days }, req);
      const result = await certs.install(service, { certPem: generated.certPem, keyPem: generated.keyPem }, req);
      audit(req, { action: 'service_ssl.reset_self_signed', target: service, args: { days, host } });
      return { ...result, selfSigned: true, days };
    },
  };

  // -------------------------------------------------------------- status ---

  async function status() {
    await capabilities.ensureFresh();
    const d = await detect(true).catch(() => null);
    const applies = Object.fromEntries(stmts.applies.all().map((r) => [r.component, { at: r.applied_at, ok: Boolean(r.ok), error: r.error }]));
    return {
      apache: { installed: capabilities.has('apache'), flavor: d?.apache?.flavor ?? null, version: d?.apache?.version ?? null, mpm: d?.apache?.mpm ?? null, active: d?.apache?.unit?.active ?? null },
      nginx: { installed: capabilities.has('nginx') }, php: { installed: capabilities.has('php'), fpmVersions: (d?.php?.versions || []).map((v) => v.version) },
      exim: { installed: capabilities.has('exim'), flavor: d?.exim?.flavor ?? null }, dovecot: { installed: capabilities.has('dovecot') },
      ftp: { installed: capabilities.has('ftp'), selected: ftp.selected(), daemons: (d?.ftp?.daemons || []).map((x) => ({ name: x.name, active: x.unit?.active ?? null })) },
      dns: { bind: capabilities.has('bind'), powerdns: capabilities.has('powerdns'), selected: getConf('nameserver').server },
      logrotate: { installed: capabilities.has('logrotate') }, openssl: capabilities.has('ssl'), applies,
      vhosts: accountVhosts().length, pools: stmts.pools.all().length, forceHttps: forceHttps(),
    };
  }

  return {
    detect, status, apache, logrotate, webdisk, webservices, exim, mailserver, ftp, nameserver, certs,
    ensureVhost, syncAccount: ensureVhost, removeAccount, applySsl, removeSsl, setRedirects, addAlias, removeAlias, setAccountIpv6, replaceIp, setPhpVersion, writePhpPool, setListenPorts,
    reload: (req) => apache.reload(req), restart: (req) => apache.restart(req), configtest: () => op('web.configtest'),
    vhostFor: (domain) => shapeVhost(stmts.vhostByDomain.get(domain)) ?? null, syncAllJob,
    ensureHostnameVhost, ensureDefaultVhost, removeDefaultVhost, removeDomain, forceHttps, landingDocroot: LANDING_DOCROOT, isServerName,
    ensureEximAclChain: (req) => exim.ensureEximAclChain(req), applyEximTls: (preset, req) => exim.applyEximTls(preset, req), applyMailserverTls: (preset, req) => mailserver.applyMailserverTls(preset, req),
  };
}
