import { json } from '../db/index.js';
import { notFound, conflict, badRequest, unprocessable, CapabilityError } from '../lib/errors.js';

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
//   web.removeVhost(domain, req)                    -> account panel (contract §33): web.vhost.remove + web_vhosts row; never a main vhost
//   web.vhostsForAccount(username)                  -> the account's web_vhosts rows, shaped
//   web.applyVirtualMail({ enabled }, req)          -> account panel (contract §36): Dovecot 98-whm-virtual-auth.conf + Exim router/transport/auth slots + spam DATA ACL
//   web.ftp.enableVirtualUsers(req)                 -> account panel (contract §37): pure-ftpd PureDB / proftpd AuthUserFile in the managed config
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
  ftp: { passivePortMin: 49152, passivePortMax: 65534, passiveAddress: '', tls: 'optional', maxClients: 50, maxPerIp: 8, anonymous: false, idleTimeoutMinutes: 15, chroot: true, virtualUsers: false },
  nameserver: { server: 'bind', role: 'master' },
  // Account panel mailboxes (applyVirtualMail). spamdAddress is Exim's spamd_address value.
  virtual_mail: { enabled: false, spamdAddress: '127.0.0.1 783' },
};
export const SPAMD_ADDRESS_RE = /^(?:\/[A-Za-z0-9._\/-]+|(?:\d{1,3}\.){3}\d{1,3} \d{1,5}|\[[0-9A-Fa-f:.]+\] \d{1,5}|[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])? \d{1,5})$/;

export const FTP_SERVERS = ['pure-ftpd', 'proftpd', 'vsftpd', 'disabled'];
export const DNS_SERVERS = ['bind', 'powerdns', 'disabled'];
export const SSL_SERVICES = ['exim', 'dovecot', 'apache', 'ftp', 'panel'];
const MANAGED = '# Managed by Keel';
// Apache writes per-domain logs as root, so they live in a root-owned tree the
// account can only read; /home/<user>/logs keeps the PHP-FPM error log the pool
// writes as the account.
export const DOMLOGS_ROOT = '/var/log/whm/domlogs';
export const domlogDir = (username) => `${DOMLOGS_ROOT}/${username}`;
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
  return { spf: layout?.support?.spf ?? has('SPF'), dkim: layout?.support?.dkim ?? has('DKIM'), contentScan: layout?.support?.contentScan ?? has('Content_Scanning') };
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
export function renderEximMain(s, layout, support = eximSupport(layout), vm = DEFAULTS.virtual_mail) {
  const debian = layout?.flavor === 'debian';
  const spam = Boolean(vm?.enabled && support.contentScan);
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
    if ((s.dkimVerify && support.dkim) || spam) lines.push(...macro('CHECK_DATA_LOCAL_ACL_FILE', layout.slots.acl_data.path));
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
  if (spam) lines.push('# SpamAssassin for the account panel\'s mailboxes (DATA ACL); only built-in to content-scanning Exim builds.', `spamd_address = ${vm.spamdAddress || DEFAULTS.virtual_mail.spamdAddress}`);
  return `${lines.join('\n')}\n`;
}

// The same deny rules on every layout (see renderEximMain for why Debian's
// macros are not enough). Exempting authenticated clients and loopback keeps
// submissions from the server's own users and webmail working. The chain ends
// with the Email category's filters file so one hook point serves both.
export function renderEximRcptAcl(s, support = { spf: true, dkim: true }, layout = null) {
  const emailAcl = layout?.emailAclFile || layout?.slots?.acl_rcpt?.includes || '/etc/exim/whm/acl-email-filters.conf';
  const lines = [`${MANAGED} (Exim Configuration Manager: RCPT ACL chain). Include inside acl_check_rcpt after the local/authenticated accepts, before the final accept.`];
  const unauth = ['        !authenticated = *', '        !hosts = : 127.0.0.1 : ::1'];
  if (s.dictionaryAttackProtection) {
    lines.push('# Dictionary attack protection: slow down and then drop clients that keep guessing recipients',
      `drop    condition = \${if > {$rcpt_fail_count}{${s.rcptFailLimit}}}`, '        message = Too many invalid recipients from your host', `        delay = ${s.rcptFailDelay}s`, '        log_message = Keel dictionary attack protection ($rcpt_fail_count failed recipients)',
      `warn    condition = \${if > {$rcpt_fail_count}{${Math.max(1, Math.floor(s.rcptFailLimit / 2))}}}`, `        delay = ${Math.max(1, Math.floor(s.rcptFailDelay / 2))}s`, '');
  }
  if (s.requireHelo) lines.push('# HELO/EHLO must precede MAIL FROM', 'deny', ...unauth, '        condition = ${if def:sender_helo_name{no}{yes}}', '        message = HELO/EHLO is required before MAIL FROM', '        log_message = Keel no HELO', '');
  if (s.rblEnabled && s.rbls.length) lines.push('# Realtime blackhole lists', 'deny', ...unauth, `        dnslists = ${s.rbls.join(' : ')}`, '        message = Rejected: $sender_host_address is listed at $dnslist_domain ($dnslist_text)', '        log_message = Keel RBL $dnslist_domain', '');
  if (s.domainRblEnabled && s.domainRbls.length) lines.push('# Domain blackhole lists', 'deny', ...unauth, `        dnslists = ${s.domainRbls.map((d) => `${d}/$sender_address_domain`).join(' : ')}`, '        message = Rejected: sender domain is listed at $dnslist_domain', '        log_message = Keel domain RBL $dnslist_domain', '');
  if (s.reverseDnsRequired) lines.push('# Require a reverse DNS entry for the sending host', 'deny', ...unauth, '        !verify = reverse_host_lookup', '        message = Your host has no reverse DNS (PTR) record', '        log_message = Keel no reverse DNS', '');
  if (s.verifySender) lines.push('# Sender address must be routable', 'deny', ...unauth, '        !verify = sender', '        message = Sender verification failed', '        log_message = Keel sender verify failed', '');
  if (s.spfVerify && !support.spf) lines.push('# SPF verification is enabled in the panel but this Exim build has no SPF support (exim4-daemon-light);', '# the spf conditions are left out so the configuration stays valid. Install exim4-daemon-heavy to enforce SPF.', '');
  else if (s.spfVerify) {
    lines.push('# SPF' + (s.spfReject ? ': reject on fail, tag softfail' : ': verify only, fail/softfail are tagged and logged'));
    if (s.spfReject) lines.push('deny', ...unauth, '        spf = fail', '        message = SPF check failed: $spf_smtp_comment', '        log_message = Keel SPF fail');
    lines.push('warn', ...unauth, `        spf = ${s.spfReject ? 'softfail' : 'fail : softfail'}`, '        add_header = $spf_received', '        log_message = Keel SPF $spf_result', '');
  }
  if (lines.length === 1) lines.push('# No RCPT protections are enabled.');
  lines.push('# Email filters (country / domain blocks, greylisting) are written by the Email category into this file:', `.include_if_exists ${emailAcl}`);
  return `${lines.join('\n')}\n`;
}

// $dkim_cur_signer is only set inside acl_smtp_dkim; in the DATA ACL the
// signers are the colon-separated $dkim_signers list.
export function renderEximDataAcl(s, support = { spf: true, dkim: true }, vm = DEFAULTS.virtual_mail, layout = null) {
  const lines = [`${MANAGED} (Exim Configuration Manager: DATA ACL). Include inside acl_check_data.`];
  if (s.dkimVerify && !support.dkim) lines.push('# DKIM verification is enabled in the panel but this Exim build has no DKIM support; the dkim conditions are left out.');
  else if (s.dkimVerify) {
    lines.push('# DKIM verification results', 'warn    dkim_status = pass', '        add_header = :at_start:X-WHM-DKIM: pass (signers $dkim_signers)',
      'warn    dkim_status = fail', '        add_header = :at_start:X-WHM-DKIM: fail (signers $dkim_signers)', '        log_message = Keel DKIM fail for $dkim_signers');
    if (s.dkimReject) lines.push('deny    !authenticated = *', '        dkim_status = fail', '        message = DKIM signature verification failed for $dkim_signers', '        log_message = Keel DKIM reject');
  } else lines.push('# DKIM verification is disabled.');
  if (vm?.enabled) lines.push('', ...renderEximSpamAcl(layout, support));
  return `${lines.join('\n')}\n`;
}

// --------------------------------------------- account panel virtual mail ---

// Paths the account panel's vmail ops write and the fragments below read; the
// agent's Exim layout carries them (contract §36), the fallback is the
// RHEL-style tree so previews render without a host.
const VMAIL_PATHS = (layout) => layout?.vmail || { passwdDir: '/etc/dovecot/whm/passwd', aliasesDir: `${layout?.whmDir || '/etc/exim/whm'}/aliases`, domainForward: `${layout?.whmDir || '/etc/exim/whm'}/domainfwd.lst`, autorespondersDir: `${layout?.whmDir || '/etc/exim/whm'}/autoresponders`, spamUsers: `${layout?.whmDir || '/etc/exim/whm'}/spam_users.lst`, autoreplyOnceDir: '/var/lib/whm/autoreply', dovecotBaseDir: '/var/run/dovecot' };
export const VMAIL_NAMES = { router: 'whm_virtual_user', transport: 'whm_dovecot_lmtp', auth: 'dovecot_plain', dovecotInclude: '98-whm-virtual-auth.conf' };

// The spam block of the DATA ACL: SpamAssassin for mailboxes whose owner turned
// it on. spam_users.lst (written by the panel's vmail.spam_users.write) is an
// lsearch file keyed by domain whose value holds key=value pairs; the first
// recipient's domain decides for the whole message (PRDR is not used). The
// scan runs as the hosting account so spamd reads ~/.spamassassin/user_prefs.
export function renderEximSpamAcl(layout, support = { contentScan: true }) {
  const file = VMAIL_PATHS(layout).spamUsers;
  if (!support.contentScan) return ['# The account panel\'s spam scanning needs an Exim built with content scanning (exim4-daemon-heavy); this build has none, so the block is left out.'];
  const threshold = '${extract{threshold}{$acl_m_whm_spam}{$value}{50}}';
  return [
    `# Account panel: SpamAssassin for mailboxes whose owner enabled it (${file}: "<domain>: user=<account> enabled=0|1 threshold=<score x10> autodelete=0|1"); the first recipient's domain decides.`,
    `warn    condition = \${if exists{${file}}}`,
    `        set acl_m_whm_spam = \${lookup{\${domain:\${extract{1}{,}{$recipients}}}}lsearch{${file}}{$value}{}}`,
    'warn    condition = ${if eq{${extract{enabled}{$acl_m_whm_spam}}}{1}}',
    '        spam = ${extract{user}{$acl_m_whm_spam}}:true/defer_ok',
    '        add_header = X-Spam-Score: $spam_score ($spam_bar)',
    `        add_header = X-Spam-Status: \${if >{$spam_score_int}{${threshold}}{Yes}{No}}, score=$spam_score required=\${eval:${threshold}/10}`,
    'discard condition = ${if eq{${extract{enabled}{$acl_m_whm_spam}}}{1}}',
    '        condition = ${if eq{${extract{autodelete}{$acl_m_whm_spam}}}{1}}',
    `        condition = \${if >{$spam_score_int}{${threshold}}}`,
    '        log_message = Keel spam auto-delete (score $spam_score)',
  ];
}

// Dovecot conf.d/98-whm-virtual-auth.conf: the account panel's mailboxes.
// Dovecot consults passdbs/userdbs in configuration order, and conf.d sorts
// this file after 10-auth.conf, so the stock system passdb/userdb answer first
// for the Linux accounts and fall through (their result_failure is `continue`)
// for addresses they do not know; username_filter keeps a system user from
// ever being looked up in a passwd file, and result_success = return-ok stops
// the chain once a mailbox matched. Exim reaches Dovecot through the
// auth-client socket (SMTP AUTH) and the lmtp socket (delivery), both opened to
// the Exim user. Quota rules come from the passwd file (userdb_quota_rule), so
// system users, who have none, stay unlimited.
export function renderDovecotVirtualAuth({ passwdDir = '/etc/dovecot/whm/passwd', eximUser = null, eximGroup = null } = {}) {
  const lines = [
    `${MANAGED} (Customer panel: virtual mailboxes). Rendered by Service Configuration for the account panel; manual changes are overwritten.`,
    `# Mailboxes live in ${passwdDir}/<domain> (root:dovecot 0640): one passwd-file line per mailbox with the hosting account's uid/gid/home`,
    '# and userdb_mail / userdb_quota_rule fields. The system passdb/userdb from 10-auth.conf run first (conf.d order) and continue on failure;',
    '# only logins with a domain part reach the passwd files below.',
    'auth_mechanisms = plain login',
    'passdb {',
    '  driver = passwd-file',
    `  args = scheme=SHA512-CRYPT username_format=%n ${passwdDir}/%d`,
    '  username_filter = *@*',
    '  result_success = return-ok',
    '  result_failure = continue',
    '  result_internalfail = continue',
    '}',
    'userdb {',
    '  driver = passwd-file',
    `  args = username_format=%n ${passwdDir}/%d`,
    '  result_success = return-ok',
    '  result_failure = continue',
    '}',
    '# Per-mailbox quota from the passwd file; no rule means unlimited.',
    'mail_plugins = $mail_plugins quota',
    'plugin {',
    '  quota = maildir:User quota',
    '}',
    'protocol imap {',
    '  mail_plugins = $mail_plugins imap_quota',
    '}',
  ];
  if (eximUser) {
    lines.push('# Exim: SMTP AUTH through the dovecot authenticators and delivery through LMTP.',
      'service auth {', '  unix_listener auth-client {', '    mode = 0660', `    user = ${eximUser}`, `    group = ${eximGroup || eximUser}`, '  }', '}',
      'service lmtp {', '  unix_listener lmtp {', '    mode = 0660', `    group = ${eximGroup || eximUser}`, '  }', '}');
  } else lines.push('# Exim is not installed: the auth-client and lmtp listeners keep their defaults until it is.');
  return `${lines.join('\n')}\n`;
}

// The Exim routers for the account panel's mail. Every file lookup is guarded:
// a list option expands to nothing when its file is missing (an unopenable
// lookup file in a list is fatal in Exim), and file names are only ever built
// from dsearch/lsearch results ($domain_data, $local_part_data), which Exim
// treats as untainted, never from the tainted address itself.
export function renderEximVirtualRouters(layout) {
  const v = VMAIL_PATHS(layout);
  const conf = `${v.autorespondersDir}/$domain_data/$local_part_data.conf`;
  const lines = [
    `${MANAGED} (Customer panel: virtual mailboxes - routers). Must be loaded before the system aliases / userforward / local_user routers.`,
    `# Reads: ${v.domainForward} (domain forwarding), ${v.aliasesDir}/<domain> (forwarders, "*" = default address), ${v.autorespondersDir}/<domain>/<local>[.conf],`,
    `# ${v.passwdDir}/<domain> (mailboxes; Dovecot's passwd file, readable through group dovecot).`,
    '',
    '# Whole-domain forwarding: "<domain>: <target-domain>"',
    'whm_domain_forward:',
    '  driver = redirect',
    `  domains = \${if exists{${v.domainForward}}{lsearch;${v.domainForward}}{}}`,
    '  data = ${quote_local_part:$local_part}@$domain_data',
    '  allow_defer',
    '  forbid_pipe',
    '  forbid_file',
    '',
    '# Forwarders on addresses that are also mailboxes: forward and keep the mailbox copy.',
    'whm_aliases_copy:',
    '  driver = redirect',
    '  unseen',
    `  domains = \${if exists{${v.aliasesDir}}{dsearch;${v.aliasesDir}}{}}`,
    `  local_parts = \${if exists{${v.aliasesDir}/$domain_data}{lsearch;${v.aliasesDir}/$domain_data}{}}`,
    `  condition = \${if and{{exists{${v.passwdDir}/$domain_data}}{!eq{\${lookup{$local_part}lsearch{${v.passwdDir}/$domain_data}{found}{}}}{}}}}`,
    '  data = $local_part_data',
    '  allow_fail',
    '  allow_defer',
    '  forbid_pipe',
    '  forbid_file',
    '',
    '# Forwarders on addresses without a mailbox.',
    'whm_aliases:',
    '  driver = redirect',
    `  domains = \${if exists{${v.aliasesDir}}{dsearch;${v.aliasesDir}}{}}`,
    `  local_parts = \${if exists{${v.aliasesDir}/$domain_data}{lsearch;${v.aliasesDir}/$domain_data}{}}`,
    `  condition = \${if or{{!exists{${v.passwdDir}/$domain_data}}{eq{\${lookup{$local_part}lsearch{${v.passwdDir}/$domain_data}{found}{}}}{}}}}`,
    '  data = $local_part_data',
    '  allow_fail',
    '  allow_defer',
    '  forbid_pipe',
    '  forbid_file',
    '',
    '# Autoresponders (unseen: the message is still delivered). Never for bounces, list/bulk mail, auto-submitted mail or the mailbox itself.',
    'whm_autoreply:',
    '  driver = accept',
    '  unseen',
    `  domains = \${if exists{${v.autorespondersDir}}{dsearch;${v.autorespondersDir}}{}}`,
    `  local_parts = \${if exists{${v.autorespondersDir}/$domain_data}{dsearch;${v.autorespondersDir}/$domain_data}{}}`,
    '  condition = ${if and{\\',
    `      {exists{${conf}}}\\`,
    `      {!eq{\${lookup{enabled}lsearch{${conf}}{$value}{1}}}{0}}\\`,
    `      {>={$tod_epoch}{\${lookup{start}lsearch{${conf}}{$value}{0}}}}\\`,
    `      {<={$tod_epoch}{\${lookup{stop}lsearch{${conf}}{$value}{9999999999}}}}\\`,
    '      {!eq{$sender_address}{}}\\',
    '      {!match{$h_precedence:}{(?i)junk|bulk|list}}\\',
    '      {!def:h_list-id:}\\',
    '      {!def:h_x-autoreply:}\\',
    '      {!match{$h_auto-submitted:}{(?i)auto-}}\\',
    '      {!eq{$sender_address}{$local_part@$domain}}\\',
    '    }}',
    '  transport = whm_autoreply',
    '',
    '# Mailboxes: the local part is a line of the domain\'s passwd file.',
    `${VMAIL_NAMES.router}:`,
    '  driver = accept',
    `  domains = \${if exists{${v.passwdDir}}{dsearch;${v.passwdDir}}{}}`,
    `  local_parts = \${if exists{${v.passwdDir}/$domain_data}{lsearch;${v.passwdDir}/$domain_data}{}}`,
    `  transport = ${VMAIL_NAMES.transport}`,
    '',
    '# Default address of a domain ("*" in its forwarders file), for anything no mailbox or forwarder took.',
    'whm_aliases_default:',
    '  driver = redirect',
    `  domains = \${if exists{${v.aliasesDir}}{dsearch;${v.aliasesDir}}{}}`,
    `  condition = \${if and{{exists{${v.aliasesDir}/$domain_data}}{!eq{\${lookup{*}lsearch{${v.aliasesDir}/$domain_data}{$value}{}}}{}}}}`,
    `  data = \${lookup{*}lsearch{${v.aliasesDir}/$domain_data}{$value}}`,
    '  allow_fail',
    '  allow_defer',
    '  forbid_pipe',
    '  forbid_file',
  ];
  return `${lines.join('\n')}\n`;
}

export function renderEximVirtualTransports(layout) {
  const v = VMAIL_PATHS(layout);
  const user = layout?.user || 'Debian-exim';
  const group = layout?.group || user;
  const conf = `${v.autorespondersDir}/$domain_data/$local_part_data.conf`;
  const lines = [
    `${MANAGED} (Customer panel: virtual mailboxes - transports).`,
    '',
    `${VMAIL_NAMES.transport}:`,
    '  driver = lmtp',
    `  socket = ${v.dovecotBaseDir}/lmtp`,
    '  batch_max = 100',
    `  user = ${user}`,
    `  group = ${group}`,
    '  delivery_date_add',
    '  envelope_to_add',
    '  return_path_add',
    '',
    `# Autoresponder: body in ${v.autorespondersDir}/<domain>/<local>, headers in <local>.conf (lsearch keys from, subject, charset, interval, start, stop, enabled); one reply per sender and interval.`,
    'whm_autoreply:',
    '  driver = autoreply',
    `  user = ${user}`,
    `  group = ${group}`,
    `  file = ${v.autorespondersDir}/$domain_data/$local_part_data`,
    `  from = \${lookup{from}lsearch{${conf}}{\${quote:$value} <$local_part@$domain>}{$local_part@$domain}}`,
    '  to = $sender_address',
    `  subject = \${lookup{subject}lsearch{${conf}}{$value}{Auto-reply}}`,
    `  headers = "Auto-Submitted: auto-replied\\nX-Autoreply: yes\\nPrecedence: bulk\\nContent-Type: text/plain; charset=\${lookup{charset}lsearch{${conf}}{$value}{utf-8}}"`,
    `  once = ${v.autoreplyOnceDir}/$local_part_data@$domain_data.db`,
    `  once_repeat = \${lookup{interval}lsearch{${conf}}{\${if eq{$value}{0}{1s}{\${value}h}}}{0s}}`,
  ];
  return `${lines.join('\n')}\n`;
}

// SMTP AUTH against Dovecot for the virtual mailboxes (system users keep
// authenticating through Dovecot as well, since its PAM passdb comes first).
// Rendered with the Exim Configuration Manager's requireTlsForAuth and
// rewritten whenever that policy is applied.
export function renderEximVirtualAuths(layout, { requireTls = true } = {}) {
  const v = VMAIL_PATHS(layout);
  const one = (name, mech) => [
    `${name}:`, '  driver = dovecot', `  public_name = ${mech}`, `  server_socket = ${v.dovecotBaseDir}/auth-client`, '  server_set_id = $auth1',
    ...(requireTls ? ['  server_advertise_condition = ${if def:tls_in_cipher}'] : []),
  ];
  return `${[`${MANAGED} (Customer panel: virtual mailboxes - SMTP AUTH through Dovecot).`, '', ...one(VMAIL_NAMES.auth, 'PLAIN'), '', ...one('dovecot_login', 'LOGIN')].join('\n')}\n`;
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
  function specsFor(account) {
    const home = account.home_dir || `${settings.get('basic.home_root') || '/home'}/${account.username}`;
    const domains = stmts.accountDomains.all(account.id);
    const aliases = domains.filter((d) => ['parked', 'alias'].includes(d.type)).map((d) => d.domain);
    const existing = stmts.vhostByDomain.get(account.domain);
    const base = (domain, type, docroot, extraAliases = []) => {
      const prev = stmts.vhostByDomain.get(domain);
      return { domain, accountId: account.id, username: account.username, type, docroot, aliases: extraAliases, ip: account.ip || settings.get('basic.shared_ip') || null, ipv6: prev?.ipv6 ?? existing?.ipv6 ?? null, phpVersion: prev?.php_version ?? null, ssl: json.parse(prev?.ssl_json, null), redirects: json.parse(prev?.redirects_json, []), customDirectives: prev?.custom_directives || '', logDir: domlogDir(account.username) };
    };
    const specs = [base(account.domain, 'main', `${home}/public_html`, aliases)];
    for (const d of domains.filter((x) => ['addon', 'sub'].includes(x.type))) specs.push(base(d.domain, d.type, d.docroot || `${home}/public_html/${d.domain}`));
    return specs;
  }

  function storeSpec(spec) {
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

  // The account panel drops an addon/sub vhost (contract §33): file first,
  // row second. A main vhost only goes with its account (removeAccount).
  async function removeVhost(domain, req) {
    const row = stmts.vhostByDomain.get(domain);
    if (row?.type === 'main' && stmts.accountByUsername.get(row.username)) throw conflict(`${domain} is the main domain of ${row.username}; remove the account to drop its vhost`);
    let result = { removed: false, reason: 'capability_missing' };
    if (capabilities.has('apache')) result = await op('web.vhost.remove', { domain, reload: true }, req);
    stmts.deleteVhost.run(domain);
    audit(req, { action: 'web.vhost.remove', target: domain, args: { username: row?.username ?? null, type: row?.type ?? null, removed: Boolean(result.removed), hadRow: Boolean(row) } });
    return { domain, username: row?.username ?? null, type: row?.type ?? null, hadRow: Boolean(row), ...result };
  }

  const vhostsForAccount = (username) => stmts.vhostsByUser.all(username).map(shapeVhost);

  async function applySsl(domain, paths, req) {
    const spec = requireSpec(domain);
    if (!paths?.cert || !paths?.key) throw badRequest('applySsl needs { cert, key } paths');
    spec.ssl = { cert: paths.cert, key: paths.key, chain: paths.chain || null, fullchain: paths.fullchain || null };
    storeSpec(spec);
    requireApache();
    const result = await writeSpec(spec, req);
    audit(req, { action: 'web.ssl.apply', target: domain, args: { cert: paths.cert } });
    return result;
  }

  async function removeSsl(domain, req) {
    const spec = requireSpec(domain);
    spec.ssl = null;
    storeSpec(spec);
    requireApache();
    const result = await writeSpec(spec, req);
    audit(req, { action: 'web.ssl.remove', target: domain });
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
    audit(req, { action: 'web.ipv6.set', target: username, args: { address } });
    return { username, address, vhosts: results };
  }

  async function replaceIp(from, to, { accounts } = {}, req) {
    let rows = stmts.vhostsByIp.all(from).map(shapeVhost);
    if (accounts?.length) rows = rows.filter((r) => accounts.includes(r.username));
    for (const r of rows) { r.ip = to; storeSpec(r); }
    if (!rows.length) return { updated: 0, domains: [] };
    requireApache();
    let updated = 0;
    for (const r of rows) { try { await writeSpec(r, req, { reload: false }); updated++; } catch (err) { logger.warn({ err, domain: r.domain }, 'web: ip replacement failed'); } }
    await reloadAfter(updated, req);
    audit(req, { action: 'web.ip.replace', target: `${from} -> ${to}`, args: { updated, domains: rows.map((r) => r.domain) } });
    return { updated, domains: rows.map((r) => r.domain) };
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
    audit(req, { action: 'web.ports.set', args: { http, https, bind, vhosts: rows.length } });
    return { ...result, vhosts: rows.length };
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
      const rows = stmts.vhostsAll.all().map(shapeVhost);
      return {
        installed: capabilities.has('apache'), detect: d.apache, php: d.php, nginx: d.nginx, status, include, settings: getConf('apache'), lastApply: lastApply('apache'), ports: listenPorts(), domlogsRoot: DOMLOGS_ROOT,
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
      const vm = getConf('virtual_mail');
      const out = { main: renderEximMain(s, l, support, vm), acl_rcpt: renderEximRcptAcl(s, support, l), acl_data: renderEximDataAcl(s, support, vm, l) };
      if (vm.enabled) out.auth = renderEximVirtualAuths(l, { requireTls: s.requireTlsForAuth });
      return out;
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
      const vm = getConf('virtual_mail');
      const required = ['main', 'acl_rcpt', ...((s.dkimVerify && eximSupport(layout).dkim) || (vm.enabled && eximSupport(layout).contentScan) ? ['acl_data'] : [])];
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
        const slots = ['acl_data', 'acl_rcpt', ...(rendered.auth ? ['auth'] : []), 'main'];
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

  // ------------------------------------------------ virtual mail (panel) ---

  // The account panel's mailboxes (contract §36): Dovecot's passwd-file
  // passdb/userdb drop-in plus Exim's router/transport/auth fragments and the
  // spam block of the DATA ACL. The panel calls apply({ enabled: true }) at
  // every boot, so a fragment is only rewritten when it differs from what the
  // host has; the host preparation (directories, Exim's read access to the
  // passwd files) is idempotent and runs every time.
  const virtualMail = {
    settings: () => getConf('virtual_mail'),
    renderDovecot(layout, dovecot) {
      return renderDovecotVirtualAuth({ passwdDir: dovecot?.passwdDir || VMAIL_PATHS(layout).passwdDir, eximUser: layout?.installed === false ? null : layout?.user || null, eximGroup: layout?.group || null });
    },
    render(layout, dovecot) {
      return { dovecot: virtualMail.renderDovecot(layout, dovecot), router: renderEximVirtualRouters(layout), transport: renderEximVirtualTransports(layout), auth: renderEximVirtualAuths(layout, { requireTls: getConf('exim').requireTlsForAuth }) };
    },
    warnings(layout) {
      const out = [];
      if (!eximSupport(layout).contentScan) out.push('This Exim build has no content scanning (Debian\'s exim4-daemon-light), so the mailboxes\' spam filtering is left out; install exim4-daemon-heavy and apply again.');
      if (!getConf('mailserver').protocols.includes('lmtp')) out.push('Dovecot\'s lmtp protocol is disabled under Mailserver Configuration; Exim cannot deliver to the virtual mailboxes until it is enabled.');
      return out;
    },
    async status() {
      await capabilities.ensureFresh();
      const layout = await exim.layout();
      const dovecot = capabilities.has('dovecot') ? await op('web.dovecot.detect').catch((err) => ({ installed: false, error: err.message })) : { installed: false };
      const s = getConf('virtual_mail');
      const slots = Object.fromEntries(['router', 'transport', 'auth'].map((k) => [k, layout.slots?.[k] ? { path: layout.slots[k].path, exists: layout.slots[k].exists, hooked: layout.slots[k].hooked ?? null, precedes: layout.slots[k].precedes ?? null, hookable: layout.slots[k].hookable } : null]));
      const installed = capabilities.has('exim') && layout.installed !== false && capabilities.has('dovecot') && dovecot.installed !== false;
      const live = installed && s.enabled && Object.values(slots).every((x) => x?.hooked) && slots.router.precedes !== false && Boolean(dovecot.includes?.virtualAuth?.exists);
      return { enabled: s.enabled, installed, exim: { installed: capabilities.has('exim') && layout.installed !== false, slots, hints: layout.hints || [] }, dovecot: { installed: capabilities.has('dovecot') && dovecot.installed !== false, include: dovecot.includes?.virtualAuth ?? null, passwdDirExists: dovecot.passwdDirExists ?? null }, live, warnings: installed ? virtualMail.warnings(layout) : [], lastApply: lastApply('virtual_mail') };
    },
    async apply({ enabled } = {}, req) {
      const current = getConf('virtual_mail');
      const next = { ...current, enabled: Boolean(enabled) };
      if (!SPAMD_ADDRESS_RE.test(next.spamdAddress || '')) throw unprocessable('spamdAddress must be "host port" or a socket path', { spamdAddress: ['e.g. 127.0.0.1 783'] });
      setConf('virtual_mail', next);
      audit(req, { action: 'virtual_mail.apply', args: { enabled: next.enabled } });
      await capabilities.ensureFresh();
      const layout = await exim.layout();
      const missing = !capabilities.has('exim') || layout.installed === false ? 'exim' : !capabilities.has('dovecot') ? 'dovecot' : null;
      if (missing) {
        recordApply('virtual_mail', false, null, `${missing === 'exim' ? 'Exim' : 'Dovecot'} is not installed`);
        if (!next.enabled) return { enabled: false, applied: false, live: false, reason: 'capability_missing', missing };
        throw new CapabilityError(missing, `${missing === 'exim' ? 'Exim' : 'Dovecot'} is not installed on this server. Virtual mailboxes are saved as enabled and are wired in once both Exim and Dovecot exist.`);
      }
      const dovecot = await op('web.dovecot.detect').catch((err) => ({ installed: false, error: err.message }));
      const rendered = virtualMail.render(layout, dovecot);
      const result = { enabled: next.enabled, applied: true, exim: {}, dovecot: null, prepared: null, warnings: [], hints: [], live: false };
      try {
        if (next.enabled) {
          result.prepared = await op('web.vmail.prepare', { enabled: true }, req);
          const dcInclude = dovecot.includes?.virtualAuth;
          result.dovecot = dcInclude?.exists && dcInclude.content === rendered.dovecot
            ? { path: dcInclude.path, unchanged: true, validated: true, reloaded: false }
            : await op('web.dovecot.include.write', { name: VMAIL_NAMES.dovecotInclude, content: rendered.dovecot, reload: true }, req);
          // Transports before routers (the router names its transport), each
          // validated by the agent; the main slot reloads Exim at the end.
          for (const slot of ['transport', 'router']) {
            const s = layout.slots?.[slot];
            result.exim[slot] = s?.exists && s.content === rendered[slot] && s.hooked
              ? { slot, path: s.path, unchanged: true, validated: true, hooked: true, precedes: s.precedes ?? null, reloaded: false }
              : await op('web.exim.include.write', { slot, content: rendered[slot], reload: false }, req);
          }
          const main = await exim.apply(getConf('exim'), layout, req);
          result.exim.auth = main.applied.auth;
          result.exim.acl_data = { path: main.applied.acl_data.path, hooked: main.applied.acl_data.hooked ?? null, live: !main.inactive.includes('acl_data') };
          result.warnings = virtualMail.warnings(layout);
          result.hints = (await exim.layout()).hints || [];
          const unhooked = ['router', 'transport', 'auth'].filter((k) => !result.exim[k]?.hooked);
          const ordered = result.exim.router?.precedes !== false;
          result.live = unhooked.length === 0 && ordered && result.dovecot.validated !== false;
          const error = unhooked.length ? `written, but Exim does not load ${unhooked.map((k) => result.exim[k]?.path).join(', ')}` : !ordered ? `the ${VMAIL_NAMES.router} router is loaded after a local-delivery router` : null;
          recordApply('virtual_mail', result.live, { exim: Object.fromEntries(Object.entries(result.exim).map(([k, v]) => [k, { path: v.path, hooked: v.hooked ?? null }])), dovecot: result.dovecot.path }, error);
        } else {
          for (const slot of ['router', 'transport', 'auth']) result.exim[slot] = await op('web.exim.include.remove', { slot }, req);
          await exim.apply(getConf('exim'), layout, req);
          result.dovecot = await op('web.dovecot.include.remove', { name: VMAIL_NAMES.dovecotInclude }, req);
          result.prepared = await op('web.vmail.prepare', { enabled: false }, req);
          recordApply('virtual_mail', true, { removed: true });
        }
      } catch (err) { recordApply('virtual_mail', false, null, err.message); throw err; }
      audit(req, { action: 'virtual_mail.applied', args: { enabled: next.enabled, live: result.live, hints: result.hints.length } });
      return { ...result, lastApply: lastApply('virtual_mail') };
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
      const out = { passivePortMin: s.passivePortMin, passivePortMax: s.passivePortMax, tls: s.tls, maxClients: s.maxClients, maxPerIp: s.maxPerIp, anonymous: s.anonymous, idleTimeoutMinutes: s.idleTimeoutMinutes, chroot: s.chroot, passiveAddress: s.passiveAddress || null, virtualUsers: Boolean(s.virtualUsers) };
      return out;
    },
    // The account panel's FTP logins (contract §37): pure-ftpd's PureDB or
    // proftpd's AuthUserFile+AuthOrder in the managed configuration. Saved as a
    // setting so every later apply keeps it; vsftpd has no virtual users.
    async enableVirtualUsers(req) {
      await capabilities.ensureFresh();
      const d = capabilities.has('ftp') ? await op('web.service.detect', { role: 'ftp' }).catch(() => ({ candidates: [], current: null })) : { candidates: [], current: null };
      const target = d.candidates.find((c) => c.name === (d.current || ftp.selected()) && c.installed);
      if (target?.name === 'vsftpd' || (!target && ftp.selected() === 'vsftpd')) throw new CapabilityError('ftp-virtual', 'vsftpd serves system users only; select pure-ftpd or proftpd under FTP Server Selection for per-account FTP logins');
      if (getConf('ftp').virtualUsers && target && lastApply('ftp')?.ok) return { daemon: target.name, enabled: true, unchanged: true, lastApply: lastApply('ftp') };
      const r = await ftp.updateSettings({ virtualUsers: true }, req);
      audit(req, { action: 'ftp.virtual_users.enable', target: target?.name ?? ftp.selected(), args: { live: r.live } });
      return { daemon: target?.name ?? ftp.selected(), enabled: true, ...r };
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
      const labels = { exim: 'Exim (SMTP)', dovecot: 'Dovecot (IMAP/POP3)', apache: 'Apache (default SSL vhost)', ftp: 'FTP server', panel: 'Keel panel (2087)' };
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
      const generated = await op('ssl.selfsigned.generate', { key: { type: 'rsa', bits: 2048 }, subject: { CN: host, O: 'Keel' }, sans, days }, req);
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
      vhosts: stmts.vhostsAll.all().length, pools: stmts.pools.all().length,
    };
  }

  return {
    detect, status, apache, logrotate, webdisk, webservices, exim, mailserver, ftp, nameserver, certs,
    ensureVhost, syncAccount: ensureVhost, removeAccount, applySsl, removeSsl, setRedirects, addAlias, removeAlias, setAccountIpv6, replaceIp, setPhpVersion, writePhpPool, setListenPorts,
    reload: (req) => apache.reload(req), restart: (req) => apache.restart(req), configtest: () => op('web.configtest'),
    vhostFor: (domain) => shapeVhost(stmts.vhostByDomain.get(domain)) ?? null, syncAllJob, removeVhost, vhostsForAccount,
    ensureEximAclChain: (req) => exim.ensureEximAclChain(req), applyEximTls: (preset, req) => exim.applyEximTls(preset, req), applyMailserverTls: (preset, req) => mailserver.applyMailserverTls(preset, req),
    virtualMail, applyVirtualMail: (input, req) => virtualMail.apply(input, req),
  };
}
