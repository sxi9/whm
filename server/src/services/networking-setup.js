import { badRequest, conflict, unprocessable } from '../lib/errors.js';

export const HOSTS_PATH = '/etc/hosts';
export const RESOLV_PATH = '/etc/resolv.conf';
export const RESOLVED_DROPIN = '/etc/systemd/resolved.conf.d/whm-resolvers.conf';
export const RESOLVED_UNIT = 'systemd-resolved';
// Debian's conventional loopback entry for the local hostname when no stable IP exists.
export const LOOPBACK_HOSTNAME_IP = '127.0.1.1';
export const MAX_RESOLVERS = 4;

const RESERVED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'localhost6', 'localhost6.localdomain6', 'ip6-localhost', 'ip6-loopback']);
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
// and the previous hostname dropped everywhere else, preserving every other
// entry, comment and blank line. Idempotent: `changed` is false when the file
// already says exactly this.
export function updateHostsFile(text, { ip, hostname, previous = null, ipv6 = null }) {
  const fqdn = normalizeHostname(hostname);
  const short = fqdn.split('.')[0];
  const prev = previous ? normalizeHostname(previous) : null;
  const prevShort = prev && prev !== fqdn ? prev.split('.')[0] : null;
  const drop = new Set([fqdn, short]);
  if (prev && prev !== fqdn) drop.add(prev);
  const original = String(text ?? '');
  const lines = parseHosts(original);
  const kept = [];
  for (const line of lines) {
    if (!line.ip) { kept.push(line); continue; }
    const hadPrev = prev ? line.names.includes(prev) : false;
    const names = line.names.filter((n) => {
      const lower = n.toLowerCase();
      if (drop.has(lower)) return false;
      if (hadPrev && prevShort && lower === prevShort && !RESERVED_HOSTNAMES.has(lower)) return false;
      return true;
    });
    if (!names.length && !line.comment) continue;
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
    else if (key === 'search' || key === 'domain') search = rest.map((s) => s.toLowerCase());
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

  async function mainAddresses(info) {
    const ipv4 = settings.get('basic.main_ip', '') || firstGlobal(info, 'IPv4');
    const ipv6 = settings.get('basic.main_ipv6', '') || null;
    return { ipv4: ipv4 || null, ipv6, detectedIpv4: firstGlobal(info, 'IPv4'), configuredIpv4: settings.get('basic.main_ip', '') || null };
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

  async function resolveWith(name, server, timeoutMs = 3000) {
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
        hosts = { path: HOSTS_PATH, exists: file.exists, entry: entry && { ip: entry.ip, names: entry.names }, ok: Boolean(entry && (entry.ip === addresses.ipv4 || entry.ip === LOOPBACK_HOSTNAME_IP)), error: null };
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
      return {
        current, configured, inSync: Boolean(current && configured && current === configured),
        validation: current ? validateHostname(current) : { hostname: '', ok: false, problems: ['No hostname is set'] },
        ip: addresses.ipv4, ipv6: addresses.ipv6, detectedIp: addresses.detectedIpv4, configuredIp: addresses.configuredIpv4,
        hosts, dns, resolves,
        capability: { hostnamectl: capabilities.has('hostnamectl'), dns: Boolean(ctx.dns?.ensureHostnameA) },
        defaults: { updateHosts: settings.get('networking.hostname.update_hosts', true) !== false, addDnsRecord: settings.get('networking.hostname.add_dns_record', true) !== false },
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
      const result = updateHostsFile(file.content, { ip: targetIp, ipv6: ipv6 || addresses.ipv6, hostname: check.hostname, previous: info?.hostname ?? settings.get('basic.hostname', '') });
      const conflictRow = hostedDomainConflict(check.hostname);
      return { hostname: check.hostname, ip: targetIp, ipv6: ipv6 || addresses.ipv6, path: HOSTS_PATH, before: file.content, after: result.content, changed: result.changed, entry: result.entry, previous: info?.hostname ?? null, conflict: conflictRow ? { account: conflictRow.username, type: conflictRow.type } : null };
    },

    // Order matters: hostnamectl first (the host is the source of truth), then
    // /etc/hosts, then the panel's own setting, then the optional DNS record.
    async setHostname({ hostname, ip, ipv6, updateHosts = true, addDnsRecord = false }, req) {
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
          const result = updateHostsFile(file.content, { ip: targetIp, ipv6: ipv6 || addresses.ipv6, hostname: fqdn, previous });
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

      if (addDnsRecord) {
        if (!ctx.dns?.ensureHostnameA) {
          steps.push({ step: 'dns', ok: false, skipped: true, error: 'DNS Functions are not available on this panel' });
        } else {
          try {
            const r = await ctx.dns.ensureHostnameA({ ip: /^\d+\.\d+\.\d+\.\d+$/.test(targetIp) && targetIp !== LOOPBACK_HOSTNAME_IP ? targetIp : undefined }, req?.user, req);
            steps.push({ step: 'dns', ok: true, detail: `${r.recordName} IN A ${r.ip} in zone ${r.zone}${r.createdZone ? ` (zone ${r.createdZone} created)` : ''}`, zone: r.zone, createdZone: r.createdZone ?? null });
          } catch (err) {
            steps.push({ step: 'dns', ok: false, error: err.message, code: err.code ?? null, capability: err.capability ?? null });
          }
        }
      }

      recordChange('hostname', req, { hostname: previous }, { hostname: fqdn, ip: targetIp }, steps.map((s) => `${s.step}:${s.ok ? 'ok' : 'failed'}`).join(','));
      audit(req, { action: 'networking.hostname.set', target: fqdn, args: { previous, ip: targetIp, updateHosts, addDnsRecord, steps: steps.map((s) => ({ step: s.step, ok: s.ok })) } });
      return {
        hostname: fqdn, previous, ip: targetIp, steps, ok: steps.every((s) => s.ok),
        // Daemons read the hostname at start-up; these are the ones that embed it.
        restartHint: ['exim', 'imap', 'httpd'],
      };
    },

    // ------------------------------------------------------------- resolvers
    async resolverStatus() {
      await capabilities.ensureFresh();
      const current = await readResolvers();
      const resolved = await resolvedUnitStatus();
      let dropIn = null;
      if (current.managedBy === 'systemd-resolved' || resolved.active) {
        try { const f = await readFile(RESOLVED_DROPIN); dropIn = f.exists ? { path: RESOLVED_DROPIN, content: f.content } : null; } catch { dropIn = null; }
      }
      const target = current.managedBy === 'systemd-resolved' ? 'resolved' : 'file';
      return {
        path: RESOLV_PATH, raw: current.raw, nameservers: current.nameservers, search: current.search, options: current.options,
        managedBy: current.managedBy, target, writePath: target === 'resolved' ? RESOLVED_DROPIN : RESOLV_PATH,
        resolved, dropIn,
        panel: { resolvers: settings.get('dns.resolvers', []) || [], search: settings.get('networking.resolvers.search', []) || [] },
        presets: RESOLVER_PRESETS, max: MAX_RESOLVERS,
        lastChange: shapeChange(stmts.lastChange.get('resolvers')),
      };
    },

    async setResolvers({ nameservers, search = [], applyToDns = true, mode = 'auto', test = true }, req) {
      const unique = [...new Set(nameservers)];
      if (unique.length !== nameservers.length) throw unprocessable('Duplicate nameserver', { nameservers: ['Each nameserver may only be listed once'] });
      if (unique.some((ns) => /^(0\.0\.0\.0|::|255\.255\.255\.255|22[4-9]\.|23\d\.|ff)/i.test(ns))) throw unprocessable('Invalid nameserver', { nameservers: ['Unspecified, broadcast and multicast addresses cannot be resolvers'] });
      const before = await readResolvers();
      const target = mode === 'auto' ? (before.managedBy === 'systemd-resolved' ? 'resolved' : 'file') : mode;
      const notes = [];
      let restarted = null;
      let path = RESOLV_PATH;
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
        if (before.managedBy === 'systemd-resolved') notes.push('/etc/resolv.conf was managed by systemd-resolved; it has been replaced with a static file. Disable systemd-resolved or it may regenerate the file.');
        else if (['networkmanager', 'resolvconf', 'dhcp'].includes(before.managedBy)) notes.push(`/etc/resolv.conf was generated by ${before.managedBy}; that tool may overwrite the panel's file on the next network event.`);
        await agent.op('sys.resolvers.set', { nameservers: unique, search }, { req });
      }
      settings.set('networking.resolvers.search', search);
      if (applyToDns) settings.set('dns.resolvers', unique);
      const after = await readResolvers();
      const applied = target === 'resolved' ? null : after.nameservers.join(',') === unique.join(',');
      const summary = { nameservers: unique, search };
      recordChange('resolvers', req, { nameservers: before.nameservers, search: before.search }, summary, target);
      audit(req, { action: 'networking.resolvers.set', target: path, args: { nameservers: unique, search, applyToDns, target, restarted, applied } });
      const result = { target, path, nameservers: unique, search, restarted, applied, appliedToDns: Boolean(applyToDns), notes, managedBy: after.managedBy };
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
      const targets = [...new Set((names?.length ? names : [validateHostname(hostname).ok ? hostname : null, 'example.com', 'cpanel.net'].filter(Boolean)).map(normalizeHostname))].slice(0, 5);
      const results = await Promise.all(servers.slice(0, 8).map(async (server) => {
        const lookups = [];
        for (const name of targets) lookups.push(await resolveWith(name, server));
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
