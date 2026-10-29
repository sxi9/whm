import { badRequest, conflict, unprocessable } from '../lib/errors.js';
import { fields } from '../lib/validate.js';

export const HOSTS_PATH = '/etc/hosts';
export const RESOLV_PATH = '/etc/resolv.conf';
export const RESOLVED_DROPIN = '/etc/systemd/resolved.conf.d/whm-resolvers.conf';
export const RESOLVED_UNIT = 'systemd-resolved';
// Debian's conventional loopback entry for the local hostname when no stable IP exists.
export const LOOPBACK_HOSTNAME_IP = '127.0.1.1';
export const MAX_RESOLVERS = 4;
// Per-name budget of a live resolver test; the names run in parallel per server.
export const RESOLVER_TEST_TIMEOUT_MS = 1500;
export const DEFAULT_TEST_NAMES = ['example.com', 'example.net'];
// Services whose certificate is the hostname's: the panel listener, mail and
// FTP. Apache's "default SSL vhost" is the hostname vhost itself (ctx.web).
export const HOSTNAME_CERT_SERVICES = ['panel', 'exim', 'dovecot', 'ftp'];
const LANDING_DOCROOT = '/var/www/whm-default';

// A DNS AAAA record only helps when the address is reachable from outside:
// loopback, link-local, unique-local and v4-mapped addresses are left out.
export function isPublicIpv6(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || !v.includes(':')) return false;
  if (v === '::' || v === '::1' || v.startsWith('::ffff:') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return false;
  if (/^f[cd][0-9a-f]{2}:/.test(v)) return false;
  return fields.ipv6.safeParse(v).success;
}

const RESERVED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'localhost6', 'localhost6.localdomain6', 'ip6-localhost', 'ip6-loopback', 'ip6-localnet', 'ip6-mcastprefix', 'ip6-allnodes', 'ip6-allrouters', 'ip6-allhosts']);
const RESERVED_LABELS = new Set(['localhost', 'localhost6', 'ip6-localhost', 'ip6-loopback']);
const RESERVED_SUFFIXES = ['.localdomain', '.local', '.localhost', '.arpa', '.internal', '.invalid', '.example', '.test'];
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const RESOLVER_PRESETS = [
  { name: 'Cloudflare', nameservers: ['1.1.1.1', '1.0.0.1'] },
  { name: 'Google', nameservers: ['8.8.8.8', '8.8.4.4'] },
  { name: 'Quad9', nameservers: ['9.9.9.9', '149.112.112.112'] },
  { name: 'Local BIND (127.0.0.1)', nameservers: ['127.0.0.1'] },
];

export function normalizeHostname(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.+$/, '');
}

// WHM's hostname rules: a fully qualified name of at least three labels that is
// not a reserved/local name, does not start with "www" and is not an IP literal.
export function validateHostname(value) {
  const hostname = normalizeHostname(value);
  const problems = [];
  if (!hostname) return { hostname, ok: false, problems: ['A hostname is required'] };
  if (hostname.length > 253) problems.push('Hostnames are limited to 253 characters');
  const labels = hostname.split('.');
  if (labels.some((l) => !LABEL_RE.test(l))) problems.push('Labels may only use letters, digits and "-", cannot start or end with "-", and are limited to 63 characters');
  if (labels.length < 3) problems.push('Use a fully qualified name with at least three labels, like host.example.com (a bare domain cannot be the server hostname)');
  if (/^\d+$/.test(labels.at(-1))) problems.push('The hostname cannot be an IP address');
  if (labels[0] === 'www') problems.push('The hostname cannot start with "www"');
  if (RESERVED_HOSTNAMES.has(hostname)) problems.push(`"${hostname}" is reserved for the loopback interface`);
  else if (RESERVED_LABELS.has(labels[0])) problems.push(`The short name "${labels[0]}" is reserved for the loopback interface`);
  for (const suffix of RESERVED_SUFFIXES) if (hostname.endsWith(suffix)) problems.push(`Names ending in "${suffix}" are not resolvable on the public internet`);
  return { hostname, ok: problems.length === 0, problems: [...new Set(problems)] };
}

export function parseHosts(text) {
  return String(text ?? '').split('\n').map((raw) => {
    const hash = raw.indexOf('#');
    const body = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    const comment = hash >= 0 ? raw.slice(hash) : null;
    if (!body) return { raw, ip: null, names: [], comment };
    const [ip, ...names] = body.split(/\s+/);
    return { raw, ip, names, comment };
  });
}

function renderHostsLine(line) {
  if (!line.ip) return line.raw;
  const body = `${line.ip}\t${line.names.join(' ')}`;
  return line.comment ? `${body} ${line.comment}` : body;
}

// Returns the hosts file with `hostname` (and its short name) mapped to `ip`
// and the previous hostname(s) dropped everywhere else, preserving every other
// entry, comment and blank line. Idempotent: `changed` is false when the file
// already says exactly this. `previous` takes the kernel hostname and the
// panel's own setting: the kernel may report the short name while the file
// lists the FQDN, so on a line that carried a previous name every alias that
// shares its first label goes too. Loopback names (localhost,
// localhost.localdomain, ip6-*) are never dropped, whatever the previous or
// new hostname was: on a stock Debian ("localhost") or RHEL
// ("localhost.localdomain") image the first hostname change would otherwise
// leave the box without a localhost mapping.
export function updateHostsFile(text, { ip, hostname, previous = null, ipv6 = null }) {
  const fqdn = normalizeHostname(hostname);
  const short = fqdn.split('.')[0];
  const prevs = [...new Set((Array.isArray(previous) ? previous : [previous]).map((p) => (p ? normalizeHostname(p) : null)).filter((p) => p && p !== fqdn && !RESERVED_HOSTNAMES.has(p)))];
  const prevShorts = new Set(prevs.map((p) => p.split('.')[0]).filter((l) => l !== short && !RESERVED_HOSTNAMES.has(l)));
  const drop = new Set([fqdn, short, ...prevs].filter((n) => n && !RESERVED_HOSTNAMES.has(n)));
  const original = String(text ?? '');
  const lines = parseHosts(original);
  const kept = [];
  for (const line of lines) {
    if (!line.ip) { kept.push(line); continue; }
    const lowerNames = line.names.map((n) => n.toLowerCase());
    const hadPrev = lowerNames.some((n) => prevs.includes(n) || prevShorts.has(n));
    const names = line.names.filter((n) => {
      const lower = n.toLowerCase();
      if (drop.has(lower)) return false;
      if (hadPrev && !RESERVED_HOSTNAMES.has(lower) && prevShorts.has(lower.split('.')[0])) return false;
      return true;
    });
    if (!names.length) {
      if (line.comment) kept.push({ raw: line.comment, ip: null, names: [], comment: line.comment });
      continue;
    }
    kept.push({ ...line, names });
  }
  const targets = [[ip, 'IPv4'], ipv6 ? [ipv6, 'IPv6'] : null].filter(Boolean);
  const newNames = short && short !== fqdn && !RESERVED_HOSTNAMES.has(short) ? [fqdn, short] : [fqdn];
  for (const [address] of targets) {
    const existing = kept.find((l) => l.ip === address);
    if (existing) existing.names = [...newNames, ...existing.names.filter((n) => !newNames.includes(n.toLowerCase()))];
    else {
      let at = kept.length;
      while (at > 0 && !kept[at - 1].ip) at--;
      kept.splice(at, 0, { raw: '', ip: address, names: [...newNames], comment: null });
    }
  }
  let content = kept.map(renderHostsLine).join('\n').replace(/\n{3,}/g, '\n\n');
  if (!content.endsWith('\n')) content += '\n';
  return { content, changed: content !== original, entry: { ip, names: newNames }, hostname: fqdn };
}

// Where /etc/resolv.conf comes from decides where the panel must write.
export function detectResolverManager(text) {
  const t = String(text ?? '');
  if (/Managed by WHM panel/i.test(t)) return 'whm';
  if (/127\.0\.0\.53|stub-resolv\.conf|systemd-resolved/i.test(t)) return 'systemd-resolved';
  if (/NetworkManager/i.test(t)) return 'networkmanager';
  if (/resolvconf/i.test(t)) return 'resolvconf';
  if (/dhclient|dhcpcd/i.test(t)) return 'dhcp';
  return 'file';
}

export function parseResolvConf(text) {
  const nameservers = [];
  let search = [];
  const options = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'nameserver' && rest[0]) nameservers.push(rest[0]);
    // systemd-resolved writes "search ." (the root domain) into its stub file.
    else if (key === 'search' || key === 'domain') search = rest.map((s) => s.toLowerCase()).filter((s) => s !== '.');
    else if (key === 'options') options.push(...rest);
  }
  return { nameservers, search, options, managedBy: detectResolverManager(text) };
}

export function renderResolvedDropIn({ nameservers, search = [] }) {
  const lines = ['# Managed by WHM panel (Resolver Configuration); edit there, not here.', '[Resolve]', `DNS=${nameservers.join(' ')}`];
  if (search.length) lines.push(`Domains=${search.join(' ')}`);
  return lines.join('\n') + '\n';
}

export function createNetworkingSetupService(ctx) {
  const { db, agent, settings, capabilities, logger } = ctx;
  const stmts = {
    insertChange: db.prepare('INSERT INTO networking_changes (kind, principal, before_json, after_json, detail) VALUES (@kind, @principal, @before, @after, @detail)'),
    changes: db.prepare('SELECT * FROM networking_changes WHERE (@kind IS NULL OR kind = @kind) ORDER BY id DESC LIMIT @limit'),
    lastChange: db.prepare('SELECT * FROM networking_changes WHERE kind = ? ORDER BY id DESC LIMIT 1'),
    domainOwner: db.prepare('SELECT a.username, d.type FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.domain = ? UNION SELECT username, \'main\' AS type FROM accounts WHERE domain = ? LIMIT 1'),
  };

  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req ?? null, entry));
  const parseJson = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
  const shapeChange = (row) => (!row ? null : { id: row.id, kind: row.kind, principal: row.principal, before: parseJson(row.before_json), after: parseJson(row.after_json), detail: row.detail, createdAt: row.created_at });
  const recordChange = (kind, req, before, after, detail = null) => {
    stmts.insertChange.run({ kind, principal: req?.user?.username ?? null, before: JSON.stringify(before ?? null), after: JSON.stringify(after ?? null), detail });
  };

  async function hostInfo() {
    try { return await agent.op('sys.info', {}); } catch (err) { logger.warn({ err }, 'sys.info unavailable'); return null; }
  }

  function firstGlobal(info, family) {
    const skip = family === 'IPv4' ? /^(127\.|169\.254\.)/ : /^(::1$|fe80:)/i;
    return info?.interfaces?.flatMap((i) => i.addresses || []).find((a) => a.family === family && !skip.test(a.address))?.address ?? null;
  }

  // Settings written by other modules are not trusted to be well formed: a bad
  // address must never reach /etc/hosts.
  const validAddress = (value, schema) => {
    const v = String(value ?? '').trim();
    return v && schema.safeParse(v).success ? v : null;
  };

  async function mainAddresses(info) {
    const ipv4 = validAddress(settings.get('basic.main_ip', ''), fields.ipv4) || firstGlobal(info, 'IPv4');
    const ipv6 = validAddress(settings.get('basic.main_ipv6', ''), fields.ipv6);
    return { ipv4: ipv4 || null, ipv6, detectedIpv4: firstGlobal(info, 'IPv4'), configuredIpv4: validAddress(settings.get('basic.main_ip', ''), fields.ipv4) };
  }

  async function readFile(path) {
    try {
      const res = await agent.op('fs.read_file', { path });
      return { exists: true, content: res?.content ?? '' };
    } catch (err) {
      if (err.code === 'not_found' || /ENOENT/.test(err.message || '')) return { exists: false, content: '' };
      throw err;
    }
  }

  async function writeRootFile(path, content, req) {
    return agent.op('fs.write_file', { path, content, backup: true, mode: '0644', owner: 'root' }, { req });
  }

  function hostedDomainConflict(hostname) {
    return stmts.domainOwner.get(hostname, hostname) || null;
  }

  async function resolveWith(name, server, timeoutMs = RESOLVER_TEST_TIMEOUT_MS) {
    const started = Date.now();
    try {
      const r = await agent.op('dns.resolve', { name, type: 'A', servers: server ? [server] : undefined, timeoutMs });
      return { name, answers: r?.answers ?? [], error: r?.error ?? null, ms: Date.now() - started, ok: !r?.error && (r?.answers?.length ?? 0) > 0 };
    } catch (err) {
      return { name, answers: [], error: err.code || 'EFAIL', ms: Date.now() - started, ok: false };
    }
  }

  async function readResolvers() {
    let raw = '';
    let nameservers = [];
    try {
      const r = await agent.op('sys.resolvers.get', {});
      raw = r?.raw ?? '';
      nameservers = r?.nameservers ?? [];
    } catch (err) {
      logger.warn({ err }, 'could not read resolv.conf');
    }
    const parsed = parseResolvConf(raw);
    if (!parsed.nameservers.length && nameservers.length) parsed.nameservers = nameservers;
    return { raw, ...parsed };
  }

  async function resolvedUnitStatus() {
    if (!capabilities.has('systemd')) return { installed: false, active: false };
    try {
      const st = await agent.op('svc.status', { unit: RESOLVED_UNIT });
      return { installed: Boolean(st.installed), active: Boolean(st.active) };
    } catch { return { installed: false, active: false }; }
  }

  // What systemd-resolved actually forwards to; the stub file only ever lists 127.0.0.53.
  async function resolvedUpstream(resolved) {
    if (!resolved.active || !capabilities.has('resolvectl')) return null;
    try {
      const r = await agent.op('resolver.upstream', {});
      if (!Array.isArray(r?.servers)) return null;
      return { source: r.source ?? 'resolvectl', global: r.global ?? [], links: r.links ?? [], servers: r.servers };
    } catch (err) {
      logger.warn({ err }, 'resolvectl dns failed');
      return null;
    }
  }

  const isLoopback = (ip) => /^127\./.test(ip || '') || ip === '::1';
  const previousHostnames = (info) => [info?.hostname, settings.get('basic.hostname', '')].filter(Boolean);

  // lstat view of /etc/resolv.conf: a symlink into /run/systemd/resolve means
  // systemd-resolved owns the file even when its contents do not say so.
  async function inspectResolvFile() {
    try {
      const r = await agent.op('resolver.inspect', {});
      return { exists: Boolean(r?.exists), isSymlink: Boolean(r?.isSymlink), isRegular: Boolean(r?.isRegular), target: r?.target ?? null, managedByResolved: Boolean(r?.managedByResolved) };
    } catch (err) {
      logger.warn({ err }, 'could not inspect /etc/resolv.conf');
      return { exists: null, isSymlink: null, isRegular: null, target: null, managedByResolved: false, error: err.message };
    }
  }

  const resolvedOwnsFile = (current, file) => current.managedBy === 'systemd-resolved' || file.managedByResolved;

  // Service certificates are the only thing the panel renders from the hostname
  // (Apache, Exim and Dovecot read it from the kernel at start-up, hence the
  // restart hint). Self-signed ones are re-issued for the new name; a CA-issued
  // certificate is never overwritten, only reported.
  async function refreshServiceCerts(fqdn, reissue, req) {
    const certs = ctx.web?.certs;
    if (!certs?.list) return { step: 'certs', ok: true, skipped: true, error: 'Service Configuration is not available on this panel' };
    try {
      const listed = await certs.list();
      const namesOf = (c) => [c?.commonName, ...(c?.sans || [])].filter(Boolean).map((n) => String(n).toLowerCase());
      const stale = (listed.services || []).filter((svc) => svc.hasCertificate && svc.certificate && !namesOf(svc.certificate).includes(fqdn));
      const reissued = [];
      const manual = [];
      const failed = [];
      for (const svc of stale) {
        if (!reissue || !svc.certificate.selfSigned) { manual.push(svc.service); continue; }
        try {
          await certs.reset(svc.service, {}, req);
          reissued.push(svc.service);
        } catch (err) {
          failed.push({ service: svc.service, error: err.message, code: err.code ?? null, capability: err.capability ?? null });
        }
      }
      const detail = [
        reissued.length ? `re-issued self-signed certificate for ${reissued.join(', ')}` : null,
        manual.length ? `${manual.join(', ')}: certificate names another host; re-issue it from Manage Service SSL Certificates` : null,
        !stale.length ? 'no service certificate names the old host' : null,
      ].filter(Boolean).join('; ');
      return { step: 'certs', ok: failed.length === 0, detail, reissued, manual, failed, ...(failed.length ? { error: failed.map((f) => `${f.service}: ${f.error}`).join('; '), code: failed[0].code, capability: failed[0].capability } : {}) };
    } catch (err) {
      return { step: 'certs', ok: false, error: err.message, code: err.code ?? null, capability: err.capability ?? null };
    }
  }

  // Every record the hostname needs, published through DNS Functions: the A
  // record (creating the parent zone when needed), AAAA for a public IPv6,
  // www as a CNAME and an MX pointing at the host itself. The A record decides
  // the step; the rest are reported one by one.
  async function publishHostnameRecords(fqdn, { ipv4, ipv6 }, req) {
    if (!ctx.dns?.ensureHostnameA) return { step: 'dns', ok: false, skipped: true, error: 'DNS Functions are not available on this panel' };
    try {
      const r = await ctx.dns.ensureHostnameA({ ip: ipv4 || undefined }, req?.user, req);
      const records = [{ type: 'A', name: fqdn, value: r.ip, ok: true }];
      const extra = [];
      if (ipv6) extra.push(['AAAA', fqdn, [{ value: ipv6 }]]);
      extra.push(['CNAME', `www.${fqdn}`, [{ value: fqdn }]], ['MX', fqdn, [{ priority: 0, value: fqdn }]]);
      if (typeof ctx.dns.upsertRecords === 'function') {
        for (const [type, name, values] of extra) {
          try { await ctx.dns.upsertRecords(r.zone, name, type, values, req); records.push({ type, name, value: values[0].value, ok: true }); } catch (err) { records.push({ type, name, value: values[0].value, ok: false, error: err.message }); }
        }
      } else records.push(...extra.map(([type, name, values]) => ({ type, name, value: values[0].value, ok: false, error: 'DNS Functions has no record API on this panel' })));
      const failed = records.filter((x) => !x.ok);
      return {
        step: 'dns', ok: failed.length === 0, zone: r.zone, createdZone: r.createdZone ?? null, records,
        detail: `${records.filter((x) => x.ok).map((x) => `${x.name} IN ${x.type} ${x.value}`).join(', ')} in zone ${r.zone}${r.createdZone ? ` (zone ${r.createdZone} created)` : ''}`,
        ...(failed.length ? { error: failed.map((x) => `${x.type} ${x.name}: ${x.error}`).join('; ') } : {}),
      };
    } catch (err) {
      return { step: 'dns', ok: false, error: err.message, code: err.code ?? null, capability: err.capability ?? null };
    }
  }

  // The hostname's own vhost (branded landing page) comes from Service Configuration.
  async function ensureLanding(fqdn, req) {
    if (typeof ctx.web?.ensureHostnameVhost !== 'function') return { step: 'landing', ok: true, skipped: true, error: 'Service Configuration is not available on this panel' };
    try {
      const r = await ctx.web.ensureHostnameVhost(req, { hostname: fqdn });
      if (r.applied) return { step: 'landing', ok: true, detail: `${fqdn} serves the landing page from ${r.docroot || LANDING_DOCROOT}${r.ssl ? ' (HTTPS)' : ''}`, docroot: r.docroot ?? null, ssl: Boolean(r.ssl), landingPage: Boolean(r.landingPage) };
      if (r.reason === 'capability_missing') return { step: 'landing', ok: true, skipped: true, capability: 'apache', detail: `Apache is not installed; the ${fqdn} virtual host is stored and written once it is`, landingPage: Boolean(r.landingPage) };
      return { step: 'landing', ok: false, error: r.error || r.reason || 'virtual host not written', code: r.reason ?? null, landingPage: Boolean(r.landingPage) };
    } catch (err) {
      return { step: 'landing', ok: false, error: err.message, code: err.code ?? null, capability: err.capability ?? null };
    }
  }

  // ssl.issueFor only knows hosted domains; the server's own name is never one
  // (setHostname refuses it), so the AutoSSL issuer takes a synthetic row for it.
  async function issueCertificate(fqdn, user, req, { force, autossl }) {
    try { return await ctx.ssl.issueFor(fqdn, user, req, { force }); } catch (err) {
      if (!(err.status === 404 || err.code === 'not_found') || typeof ctx.ssl.autossl?.issue !== 'function') throw err;
      const row = { domain: fqdn, account: null, accountId: null, type: 'server', suspended: false, docroot: ctx.web?.landingDocroot || LANDING_DOCROOT, certificate: ctx.ssl.certForDomain?.(fqdn) ?? null };
      const result = await ctx.ssl.autossl.issue(row, autossl, { force, req });
      audit(req, { action: 'ssl.autossl.issue', target: fqdn, args: { provider: autossl.provider, renewed: result.renewed, hostname: true } });
      return result;
    }
  }

  function issuedPems(certId, user) {
    const row = certId != null && typeof ctx.ssl.certs?.raw === 'function' ? ctx.ssl.certs.raw(certId, user) : null;
    if (!row?.cert_pem || !row.key_enc) throw new Error('The issued certificate was not stored with its private key');
    return { certPem: row.cert_pem, keyPem: ctx.crypto.decrypt(row.key_enc), ...(row.chain_pem ? { chainPem: row.chain_pem } : {}) };
  }

  // Issues the hostname's certificate through AutoSSL once the name resolves
  // to this server, then installs it for the panel, mail and FTP; the hostname
  // vhost gets it through the issuer's web hook. Every outcome is a step.
  async function issueHostnameCertificate(fqdn, { ip, force = false }, req) {
    const ssl = ctx.ssl;
    if (typeof ssl?.autossl?.settings !== 'function' || typeof ssl.installServiceCert !== 'function') return { step: 'certificate', ok: true, skipped: true, error: 'SSL/TLS is not available on this panel' };
    try {
      const autossl = ssl.autossl.settings();
      if (autossl.provider === 'disabled') return { step: 'certificate', ok: true, skipped: true, capability: 'acme', error: 'AutoSSL is disabled; choose a provider under SSL/TLS › Manage AutoSSL, then re-issue the hostname certificate' };
      const detect = await ssl.autossl.detect();
      if (!detect?.providers?.includes(autossl.provider)) return { step: 'certificate', ok: true, skipped: true, capability: 'acme', code: 'capability_missing', error: `${autossl.provider} is not installed on this server; install it, then re-issue the hostname certificate` };
      const publicIp = ip && !isLoopback(ip) && ip !== LOOPBACK_HOSTNAME_IP && fields.ipv4.safeParse(ip).success ? ip : null;
      const lookup = await resolveWith(fqdn, null, 3000);
      if (!publicIp || !lookup.answers.includes(publicIp)) {
        return { step: 'certificate', ok: false, skipped: true, answers: lookup.answers, error: `${fqdn} does not resolve to ${publicIp || 'a public address of this server'} yet (${lookup.answers.length ? `answers: ${lookup.answers.join(', ')}` : lookup.error || 'no answer'}); re-issue the hostname certificate once DNS has propagated` };
      }
      const user = req?.user ?? { role: 'root' };
      const issued = await issueCertificate(fqdn, user, req, { force, autossl });
      const pems = issuedPems(issued.cert?.id, user);
      const installed = [];
      const failed = [];
      for (const service of HOSTNAME_CERT_SERVICES) {
        try { await ssl.installServiceCert(service, pems, req); installed.push(service); } catch (err) { failed.push({ service, error: err.message, code: err.code ?? null }); }
      }
      const issuer = issued.certificate?.issuerCommonName || issued.certificate?.issuerText || autossl.provider;
      return {
        step: 'certificate', ok: failed.length === 0, certId: issued.cert?.id ?? null, issuer, notAfter: issued.certificate?.notAfter ?? null, renewed: issued.renewed ?? null, web: issued.web ?? null, installed, failed,
        detail: `${issuer} certificate for ${fqdn}${issued.certificate?.notAfter ? ` until ${issued.certificate.notAfter}` : ''}; installed for ${installed.join(', ') || 'no service'}; hostname vhost ${issued.web || 'pending'}`,
        ...(failed.length ? { error: failed.map((f) => `${f.service}: ${f.error}`).join('; '), code: failed[0].code } : {}),
      };
    } catch (err) {
      return { step: 'certificate', ok: false, error: err.message, code: err.code ?? null, capability: err.capability ?? null };
    }
  }

  const service = {
    // -------------------------------------------------------------- hostname
    async hostnameStatus() {
      await capabilities.ensureFresh();
      const info = await hostInfo();
      const current = info?.hostname ?? null;
      const configured = settings.get('basic.hostname', '') || null;
      const addresses = await mainAddresses(info);
      let hosts = { path: HOSTS_PATH, exists: false, entry: null, ok: false, error: null };
      try {
        const file = await readFile(HOSTS_PATH);
        const lines = parseHosts(file.content).filter((l) => l.ip);
        const entry = current ? lines.find((l) => l.names.some((n) => n.toLowerCase() === current.toLowerCase())) || null : null;
        // A loopback mapping is what most images ship and is valid without a stable IP.
        const loopback = Boolean(entry && isLoopback(entry.ip));
        hosts = { path: HOSTS_PATH, exists: file.exists, entry: entry && { ip: entry.ip, names: entry.names }, ok: Boolean(entry && (entry.ip === addresses.ipv4 || entry.ip === addresses.ipv6 || loopback)), loopback, error: null };
      } catch (err) {
        hosts.error = err.message;
      }
      let dns = null;
      if (ctx.dns?.hostnameStatus) {
        try {
          const s = await ctx.dns.hostnameStatus();
          dns = { available: true, zone: s.zone, suggestedZone: s.suggestedZone, record: s.record, recordName: s.recordName, resolves: s.resolves };
        } catch (err) {
          dns = { available: true, error: err.message, code: err.code ?? null };
        }
      }
      let resolves = dns?.resolves ?? null;
      if (!resolves && current && validateHostname(current).ok) {
        const r = await resolveWith(current, null);
        resolves = { answers: r.answers, error: r.error, matches: Boolean(addresses.ipv4 && r.answers.includes(addresses.ipv4)) };
      }
      let certificate = null;
      let landing = null;
      try { certificate = (configured && ctx.ssl?.certForDomain?.(configured)) || null; } catch { certificate = null; }
      try { landing = (configured && ctx.web?.vhostFor?.(configured)) || null; } catch { landing = null; }
      return {
        current, configured, inSync: Boolean(current && configured && current === configured),
        validation: current ? validateHostname(current) : { hostname: '', ok: false, problems: ['No hostname is set'] },
        ip: addresses.ipv4, ipv6: addresses.ipv6, detectedIp: addresses.detectedIpv4, configuredIp: addresses.configuredIpv4,
        hosts, dns, resolves,
        certificate: certificate ? { id: certificate.id, issuer: certificate.issuer, notAfter: certificate.notAfter, daysRemaining: certificate.daysRemaining, expired: certificate.expired, autossl: certificate.autossl, state: certificate.state, selfSigned: certificate.selfSigned } : null,
        landing: landing ? { domain: landing.domain, status: landing.status, docroot: landing.docroot, ssl: Boolean(landing.ssl), error: landing.error ?? null } : null,
        capability: { hostnamectl: capabilities.has('hostnamectl'), dns: Boolean(ctx.dns?.ensureHostnameA), ssl: typeof ctx.ssl?.issueFor === 'function', web: typeof ctx.web?.ensureHostnameVhost === 'function' },
        defaults: service.hostnameDefaults(),
        lastChange: shapeChange(stmts.lastChange.get('hostname')),
      };
    },

    async previewHostname({ hostname, ip, ipv6 }) {
      const check = validateHostname(hostname);
      if (!check.ok) throw unprocessable('That hostname cannot be used', { hostname: check.problems });
      const info = await hostInfo();
      const addresses = await mainAddresses(info);
      const targetIp = ip || addresses.ipv4 || LOOPBACK_HOSTNAME_IP;
      const file = await readFile(HOSTS_PATH);
      const result = updateHostsFile(file.content, { ip: targetIp, ipv6: ipv6 || addresses.ipv6, hostname: check.hostname, previous: previousHostnames(info) });
      const conflictRow = hostedDomainConflict(check.hostname);
      return { hostname: check.hostname, ip: targetIp, ipv6: ipv6 || addresses.ipv6, path: HOSTS_PATH, before: file.content, after: result.content, changed: result.changed, entry: result.entry, previous: info?.hostname ?? null, conflict: conflictRow ? { account: conflictRow.username, type: conflictRow.type } : null };
    },

    // Order matters: hostnamectl first (the host is the source of truth), then
    // /etc/hosts, the panel's own setting, the service certificates, the DNS
    // records, the hostname's landing vhost and last its certificate (which
    // needs the records and the vhost in place).
    async setHostname({ hostname, ip, ipv6, updateHosts = true, addDnsRecord = true, reissueServiceCerts = true, issueCertificate: wantCertificate = true }, req) {
      const check = validateHostname(hostname);
      if (!check.ok) throw unprocessable('That hostname cannot be used', { hostname: check.problems });
      const fqdn = check.hostname;
      const owner = hostedDomainConflict(fqdn);
      if (owner) throw conflict(`${fqdn} is a domain hosted by account "${owner.username}"; the server hostname must not be a hosted domain`);
      await capabilities.ensureFresh();
      capabilities.require('hostnamectl', 'hostnamectl (systemd) is not installed, so the system hostname cannot be changed from the panel. Install systemd or set the hostname on the console.');

      const info = await hostInfo();
      const addresses = await mainAddresses(info);
      const previous = info?.hostname ?? settings.get('basic.hostname', '') ?? null;
      const targetIp = ip || addresses.ipv4 || LOOPBACK_HOSTNAME_IP;
      const steps = [];

      await agent.op('sys.hostname.set', { hostname: fqdn }, { req });
      steps.push({ step: 'hostname', ok: true, detail: `hostnamectl set-hostname ${fqdn}` });

      if (updateHosts) {
        try {
          const file = await readFile(HOSTS_PATH);
          const result = updateHostsFile(file.content, { ip: targetIp, ipv6: ipv6 || addresses.ipv6, hostname: fqdn, previous: previousHostnames(info) });
          if (result.changed) await writeRootFile(HOSTS_PATH, result.content, req);
          steps.push({ step: 'hosts', ok: true, changed: result.changed, detail: `${HOSTS_PATH}: ${result.entry.ip} ${result.entry.names.join(' ')}` });
        } catch (err) {
          logger.warn({ err }, 'hostname changed but /etc/hosts could not be updated');
          steps.push({ step: 'hosts', ok: false, error: err.message, code: err.code ?? null });
        }
      } else {
        steps.push({ step: 'hosts', ok: true, skipped: true, detail: `${HOSTS_PATH} left unchanged` });
      }

      settings.set('basic.hostname', fqdn);
      steps.push({ step: 'settings', ok: true, detail: 'basic.hostname updated' });

      steps.push(await refreshServiceCerts(fqdn, reissueServiceCerts, req));

      const publicIpv4 = fields.ipv4.safeParse(targetIp).success && targetIp !== LOOPBACK_HOSTNAME_IP && !isLoopback(targetIp) ? targetIp : null;
      if (addDnsRecord) {
        const v6 = ipv6 || addresses.ipv6;
        steps.push(await publishHostnameRecords(fqdn, { ipv4: publicIpv4, ipv6: isPublicIpv6(v6) ? v6 : null }, req));
      }

      steps.push(await ensureLanding(fqdn, req));
      if (wantCertificate) steps.push(await issueHostnameCertificate(fqdn, { ip: publicIpv4 }, req));

      recordChange('hostname', req, { hostname: previous }, { hostname: fqdn, ip: targetIp }, steps.map((s) => `${s.step}:${s.ok ? 'ok' : 'failed'}`).join(','));
      audit(req, { action: 'networking.hostname.set', target: fqdn, args: { previous, ip: targetIp, updateHosts, addDnsRecord, reissueSelfSigned: reissueServiceCerts, hostnameTls: wantCertificate, steps: steps.map((s) => ({ step: s.step, ok: s.ok })) } });
      return {
        hostname: fqdn, previous, ip: targetIp, steps, ok: steps.every((s) => s.ok),
        // Daemons read the hostname at start-up; these are the ones that embed it.
        restartHint: ['exim', 'imap', 'httpd'],
      };
    },

    // "Reissue hostname certificate": the landing vhost is made current first
    // so the issuer's web hook has somewhere to install the certificate.
    async reissueHostnameCertificate({ force = true } = {}, req) {
      const check = validateHostname(settings.get('basic.hostname', ''));
      if (!check.ok) throw unprocessable('Set a fully qualified hostname first', { hostname: check.problems });
      const fqdn = check.hostname;
      await capabilities.ensureFresh();
      const addresses = await mainAddresses(await hostInfo());
      const publicIpv4 = addresses.ipv4 && !isLoopback(addresses.ipv4) ? addresses.ipv4 : null;
      const steps = [await ensureLanding(fqdn, req), await issueHostnameCertificate(fqdn, { ip: publicIpv4, force }, req)];
      audit(req, { action: 'networking.hostname.certificate', target: fqdn, args: { force, ip: publicIpv4, steps: steps.map((s) => ({ step: s.step, ok: s.ok })) } });
      return { hostname: fqdn, ip: publicIpv4, steps, ok: steps.every((s) => s.ok) };
    },

    hostnameDefaults() {
      return { updateHosts: settings.get('networking.hostname.update_hosts', true) !== false, addDnsRecord: settings.get('networking.hostname.add_dns_record', true) !== false };
    },

    setHostnameDefaults({ updateHosts, addDnsRecord }, req) {
      const before = service.hostnameDefaults();
      if (updateHosts != null) settings.set('networking.hostname.update_hosts', Boolean(updateHosts));
      if (addDnsRecord != null) settings.set('networking.hostname.add_dns_record', Boolean(addDnsRecord));
      const after = service.hostnameDefaults();
      audit(req, { action: 'networking.hostname.defaults', target: 'settings', args: { before, after } });
      return after;
    },

    // ------------------------------------------------------------- resolvers
    async resolverStatus() {
      await capabilities.ensureFresh();
      const current = await readResolvers();
      const resolved = await resolvedUnitStatus();
      const file = await inspectResolvFile();
      if (current.managedBy !== 'systemd-resolved' && file.managedByResolved) current.managedBy = 'systemd-resolved';
      let dropIn = null;
      if (current.managedBy === 'systemd-resolved' || resolved.active) {
        try { const f = await readFile(RESOLVED_DROPIN); dropIn = f.exists ? { path: RESOLVED_DROPIN, content: f.content } : null; } catch { dropIn = null; }
      }
      // Mirrors what mode "auto" does: the drop-in only matters while the unit runs.
      const target = current.managedBy === 'systemd-resolved' && resolved.active ? 'resolved' : 'file';
      const upstream = await resolvedUpstream(resolved);
      return {
        path: RESOLV_PATH, raw: current.raw, nameservers: current.nameservers, search: current.search, options: current.options,
        managedBy: current.managedBy, target, writePath: target === 'resolved' ? RESOLVED_DROPIN : RESOLV_PATH,
        resolved: { ...resolved, upstream }, dropIn, file,
        // Taking the file over only sticks once systemd-resolved no longer regenerates it.
        takeOverAllowed: !(resolvedOwnsFile(current, file) && resolved.active),
        panel: { resolvers: settings.get('dns.resolvers', []) || [], search: settings.get('networking.resolvers.search', []) || [] },
        presets: RESOLVER_PRESETS, max: MAX_RESOLVERS,
        lastChange: shapeChange(stmts.lastChange.get('resolvers')),
      };
    },

    async setResolvers({ nameservers, search = [], applyToDns = true, mode = 'auto', test = true }, req) {
      const unique = [...new Set(nameservers)];
      if (unique.length !== nameservers.length) throw unprocessable('Duplicate nameserver', { nameservers: ['Each nameserver may only be listed once'] });
      // Exact matches for the unspecified addresses (so ::1 and ::ffff: stay
      // usable), prefixes for broadcast and multicast.
      if (unique.some((ns) => ns === '0.0.0.0' || ns === '::' || ns === '255.255.255.255' || /^(22[4-9]|23\d)\./.test(ns) || /^ff[0-9a-f]{2}:/i.test(ns))) throw unprocessable('Invalid nameserver', { nameservers: ['Unspecified, broadcast and multicast addresses cannot be resolvers'] });
      const before = await readResolvers();
      const fileBefore = await inspectResolvFile();
      if (before.managedBy !== 'systemd-resolved' && fileBefore.managedByResolved) before.managedBy = 'systemd-resolved';
      const resolved = await resolvedUnitStatus();
      // A drop-in is only read by a running systemd-resolved: with the unit
      // stopped (the state the take-over flow asks for) auto mode writes the
      // static file instead of starting a unit the admin just stopped.
      const target = mode === 'auto' ? (before.managedBy === 'systemd-resolved' && resolved.active ? 'resolved' : 'file') : mode;
      if (target === 'resolved' && !resolved.installed) throw unprocessable('systemd-resolved is not installed on this server, so there is nothing to write a drop-in for; write /etc/resolv.conf directly instead', { mode: ['systemd-resolved is not installed; use mode "file" or "auto"'] });
      const notes = [];
      let restarted = null;
      let replacedSymlink = false;
      let path = RESOLV_PATH;
      if (target === 'file' && resolvedOwnsFile(before, fileBefore)) {
        if (resolved.active) throw unprocessable('systemd-resolved is running and regenerates /etc/resolv.conf; stop and disable it first (systemctl disable --now systemd-resolved) or keep writing through its drop-in', { mode: ['systemd-resolved must be stopped before /etc/resolv.conf can be replaced with a static file'] });
      }
      if (target === 'resolved') {
        path = RESOLVED_DROPIN;
        await writeRootFile(RESOLVED_DROPIN, renderResolvedDropIn({ nameservers: unique, search }), req);
        try {
          await agent.op('svc.restart', { unit: RESOLVED_UNIT }, { req });
          restarted = true;
        } catch (err) {
          restarted = false;
          notes.push(`systemd-resolved could not be restarted (${err.message}); run "systemctl restart systemd-resolved" to apply`);
        }
      } else {
        const written = await agent.op('resolver.write_static', { nameservers: unique, search }, { req });
        replacedSymlink = Boolean(written?.replacedSymlink);
        if (replacedSymlink) notes.push(`/etc/resolv.conf was a symlink to ${written.previousTarget || 'another file'}; it has been replaced with a regular file (the previous contents are in /etc/resolv.conf.whm-bak).`);
        if (resolvedOwnsFile(before, fileBefore)) notes.push(`systemd-resolved is ${resolved.installed ? 'stopped' : 'not installed'}; keep it disabled (systemctl disable systemd-resolved) or it recreates the stub on its next start.`);
        else if (['networkmanager', 'resolvconf', 'dhcp'].includes(before.managedBy)) notes.push(`/etc/resolv.conf was generated by ${before.managedBy}; that tool may overwrite the panel's file on the next network event.`);
      }
      settings.set('networking.resolvers.search', search);
      if (applyToDns) settings.set('dns.resolvers', unique);
      const after = await readResolvers();
      const fileAfter = target === 'resolved' ? fileBefore : await inspectResolvFile();
      // A static write only counts when the file now holds the servers and is a
      // regular file: writing through a surviving symlink lands in tmpfs.
      const applied = target === 'resolved' ? null : after.nameservers.join(',') === unique.join(',') && fileAfter.isRegular === true && fileAfter.isSymlink !== true;
      if (target === 'file' && applied === false && fileAfter.isSymlink) notes.push(`/etc/resolv.conf is still a symlink to ${fileAfter.target || 'another file'}; the servers were not applied to a static file.`);
      const summary = { nameservers: unique, search };
      recordChange('resolvers', req, { nameservers: before.nameservers, search: before.search }, summary, target);
      audit(req, { action: 'networking.resolvers.set', target: path, args: { nameservers: unique, search, applyToDns, target, restarted, applied, replacedSymlink } });
      const result = { target, path, nameservers: unique, search, restarted, applied, replacedSymlink, appliedToDns: Boolean(applyToDns), notes, managedBy: after.managedBy, file: fileAfter };
      if (test) result.test = await service.testResolvers({ nameservers: unique });
      return result;
    },

    // Resolves each name against each server separately so a dead resolver is
    // visible even when the others answer.
    async testResolvers({ nameservers, names } = {}) {
      let servers = nameservers?.length ? [...new Set(nameservers)] : null;
      if (!servers) servers = (await readResolvers()).nameservers;
      if (!servers.length) throw badRequest('No resolvers are configured to test');
      const hostname = settings.get('basic.hostname', '');
      const targets = [...new Set((names?.length ? names : [validateHostname(hostname).ok ? hostname : null, ...DEFAULT_TEST_NAMES].filter(Boolean)).map(normalizeHostname))].slice(0, 5);
      // All names of a server at once, so a dead resolver costs one timeout, not one per name.
      const results = await Promise.all(servers.slice(0, 8).map(async (server) => {
        const lookups = await Promise.all(targets.map((name) => resolveWith(name, server)));
        const ok = lookups.filter((l) => l.ok);
        return { server, ok: ok.length === lookups.length, reachable: ok.length > 0 || lookups.some((l) => l.error === 'ENOTFOUND' || l.error === 'ENODATA'), lookups, avgMs: ok.length ? Math.round(ok.reduce((n, l) => n + l.ms, 0) / ok.length) : null };
      }));
      return { names: targets, servers: results, healthy: results.filter((r) => r.ok).length, total: results.length };
    },

    history({ kind = null, limit = 50 } = {}) {
      return stmts.changes.all({ kind, limit }).map(shapeChange);
    },
  };

  return service;
}
