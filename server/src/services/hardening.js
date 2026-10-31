import net from 'node:net';
import { CapabilityError, unprocessable } from '../lib/errors.js';
import { json } from '../db/index.js';

// Security Advisor › Hardening: five one-click items, each with a live status
// read from the host, Apply and Revert. The SQLite row per item holds what the
// operator asked for (the firewall baseline is put back from it at boot, like
// the panel's other firewall rules) and what Revert must restore; the host is
// always changed first and the row second.
//
// ctx.hardening.status()            -> { items: [{ id, label, status, ... }] }
// ctx.hardening.apply(item, body, req) / revert(item, req)
// ctx.hardening.fail2ban.unban({ jail, ip }, req), .install(user, req)
// ctx.hardening.firewall.plan()      -> the ports the baseline would allow
// ctx.hardening.findings()           -> Security Advisor findings, one per item
// ctx.hardening.reconcile(job)       -> boot re-apply of the firewall baseline

export const RECONCILE_JOB = 'hardening.reconcile';
export const ITEM_IDS = ['fail2ban', 'auto-updates', 'ssh', 'sysctl', 'firewall'];
export const F2B_JAILS = ['sshd', 'exim', 'dovecot', 'pure-ftpd', 'proftpd', 'apache-auth', 'apache-badbots', 'whm-panel'];
export const SSH_HARDENING = { PermitRootLogin: 'prohibit-password', MaxAuthTries: 4, LoginGraceTime: 30, X11Forwarding: 'no' };
const SSH_KEYS = Object.keys(SSH_HARDENING);
const ROOT_LOGIN_OK = new Set(['prohibit-password', 'without-password', 'no', 'forced-commands-only']);
// Values stricter than prohibit-password that an apply must never replace.
const ROOT_LOGIN_KEEP = new Set(['no', 'forced-commands-only']);
const ROOT_AUTHORIZED_KEYS = '/root/.ssh/authorized_keys';
const HUB_PORT = 7443;
// Accepted by the baseline before any port rule; shown in the plan, never sent as a port.
const BUILTIN_RULES = [{ port: 546, proto: 'udp', reasons: ['dhcpv6 client'], scope: 'IPv6 link-local, from port 547' }];
const ADVISOR_FIX = { label: 'Hardening', path: '/security-center/security-advisor#hardening' };

export const ITEMS = [
  { id: 'fail2ban', label: 'Fail2ban intrusion blocking', description: 'Bans addresses that repeatedly fail SSH, mail, FTP, Apache or panel logins (jail.d/whm.local + a filter for the panel log).', capability: 'fail2ban', grade: 'warning' },
  { id: 'auto-updates', label: 'Automatic security updates', description: 'unattended-upgrades (Debian/Ubuntu) or dnf-automatic (RHEL family) applying security updates only, never rebooting.', grade: 'warning' },
  { id: 'ssh', label: 'SSH daemon hardening', description: 'PermitRootLogin prohibit-password, MaxAuthTries 4, LoginGraceTime 30, X11Forwarding no — refused while root could not log in with a key.', capability: 'sshd', grade: 'warning' },
  { id: 'sysctl', label: 'Kernel network hardening', description: 'sysctl.d/90-whm-hardening.conf: reverse-path filtering, SYN cookies, no ICMP redirects or source routing, martians logged.', grade: 'info' },
  { id: 'firewall', label: 'Firewall baseline (default deny)', description: 'Only the panel, SSH, web, mail, DNS and FTP ports stay reachable; the input policy drops everything else. Needs your confirmation of the SSH port.', capability: 'firewall', grade: 'warning' },
];

export const sshChecks = (effective = {}) => ({
  PermitRootLogin: ROOT_LOGIN_OK.has(String(effective.permitrootlogin || 'yes').toLowerCase()),
  MaxAuthTries: Number(effective.maxauthtries || 6) <= SSH_HARDENING.MaxAuthTries,
  LoginGraceTime: Number(effective.logingracetime || 120) <= SSH_HARDENING.LoginGraceTime,
  X11Forwarding: String(effective.x11forwarding || 'no').toLowerCase() === 'no',
});

// Why PermitRootLogin prohibit-password would lock root out: no authorized key,
// or sshd would not consult it (PubkeyAuthentication off, AuthenticationMethods
// without a chain that works once passwords are refused, AuthorizedKeysFile
// pointing elsewhere). Null when a key login is possible.
export function sshKeyLoginBlocked(effective = {}, authorizedKeys = 0) {
  if (!(authorizedKeys > 0)) return 'Root has no authorized SSH key; authorize one first';
  if (String(effective.pubkeyauthentication || 'yes').toLowerCase() === 'no') return 'PubkeyAuthentication is off, so root could not log in with a key; switch it on first (SSH Password Authorization Tweak)';
  const methods = String(effective.authenticationmethods || 'any').trim().toLowerCase();
  if (methods && methods !== 'any') {
    const keyChain = methods.split(/\s+/).some((chain) => { const m = chain.split(','); return m.includes('publickey') && !m.includes('password') && !m.includes('keyboard-interactive'); });
    if (!keyChain) return `AuthenticationMethods "${effective.authenticationmethods}" leaves root no key login once passwords are refused`;
  }
  const files = String(effective.authorizedkeysfile ?? '').trim();
  if (files) {
    const resolved = files.split(/\s+/).map((f) => { const p = f.replace(/%h/g, '/root').replace(/%u/g, 'root').replace(/%%/g, '%'); return p.startsWith('/') ? p : `/root/${p}`; });
    if (!resolved.includes(ROOT_AUTHORIZED_KEYS)) return `AuthorizedKeysFile "${files}" does not read ${ROOT_AUTHORIZED_KEYS}, where root's authorized key is`;
  }
  return null;
}

const inPorts = (list, n) => list.some((p) => (typeof p === 'number' ? p === n : n >= p.from && n <= p.to));
// Express reports IPv4 clients of the dual-stack listener as ::ffff:a.b.c.d.
const clientIp = (req) => { const ip = String(req?.ip || '').replace(/^::ffff:/i, ''); return net.isIP(ip) ? ip : null; };

export function createHardeningService(ctx) {
  const { db, agent, capabilities, settings, config, logger } = ctx;
  const stmts = {
    get: db.prepare('SELECT * FROM hardening_state WHERE item = ?'),
    all: db.prepare('SELECT * FROM hardening_state'),
    put: db.prepare(`INSERT INTO hardening_state (item, desired, params_json, previous_json, applied_at, reverted_at, updated_at)
      VALUES (@item, @desired, @params_json, @previous_json, @applied_at, @reverted_at, datetime('now'))
      ON CONFLICT (item) DO UPDATE SET desired = excluded.desired, params_json = excluded.params_json, previous_json = excluded.previous_json,
        applied_at = COALESCE(excluded.applied_at, hardening_state.applied_at), reverted_at = COALESCE(excluded.reverted_at, hardening_state.reverted_at), updated_at = excluded.updated_at`),
  };
  const op = (name, args, req) => agent.op(name, args, { req });
  const rowOf = (item) => { const r = stmts.get.get(item); return r ? { desired: Boolean(r.desired), params: json.parse(r.params_json, {}), previous: json.parse(r.previous_json, null), appliedAt: r.applied_at, revertedAt: r.reverted_at } : { desired: false, params: {}, previous: null, appliedAt: null, revertedAt: null }; };
  const record = (item, desired, { params = {}, previous = null } = {}) => stmts.put.run({ item, desired: desired ? 1 : 0, params_json: JSON.stringify(params), previous_json: previous == null ? null : JSON.stringify(previous), applied_at: desired ? new Date().toISOString() : null, reverted_at: desired ? null : new Date().toISOString() });
  const audit = (req, entry) => req?.audit?.(entry);
  const itemMeta = (id) => ITEMS.find((i) => i.id === id);
  const shape = (id, status, detail = {}, extra = {}) => ({ ...itemMeta(id), status, ...rowOf(id), detail, ...extra });

  // ------------------------------------------------------------ fail2ban ---
  const fail2ban = {
    config() {
      return {
        bantime: Number(settings.get('security.hardening.fail2ban.bantime_seconds')) || 3600,
        findtime: Number(settings.get('security.hardening.fail2ban.findtime_seconds')) || 600,
        maxretry: Number(settings.get('security.hardening.fail2ban.maxretry')) || 5,
      };
    },
    // Jails for the daemons this host runs; the panel jail is always on.
    jailsFor() {
      const jails = ['whm-panel'];
      if (capabilities.has('sshd')) jails.push('sshd');
      if (capabilities.has('exim')) jails.push('exim');
      if (capabilities.has('dovecot')) jails.push('dovecot');
      if (capabilities.has('ftp')) {
        const bins = capabilities.snapshot().capabilities.ftp?.binaries || {};
        if (bins['pure-ftpd']) jails.push('pure-ftpd');
        if (bins.proftpd) jails.push('proftpd');
      }
      if (capabilities.has('apache')) jails.push('apache-auth', 'apache-badbots');
      return jails;
    },
    async status() {
      const live = await op('hardening.jails.status');
      if (!live.installed) return shape('fail2ban', 'not_applied', { ...live, reason: 'Fail2ban is not installed', installable: true });
      const applied = live.configured && live.running === true;
      return shape('fail2ban', applied ? 'applied' : 'not_applied', { ...live, reason: !live.configured ? 'The panel jails are not written' : live.running ? null : 'fail2ban is not running' });
    },
    async apply(body = {}, req) {
      const live = await op('hardening.jails.status');
      if (!live.installed) throw new CapabilityError('fail2ban', 'Fail2ban is not installed on this server');
      const cfg = fail2ban.config();
      // The panel jail exempts the chosen addresses, by default the one this apply
      // came from, so the operator cannot ban themselves out of the panel; the
      // other jails never exempt anyone.
      const own = clientIp(req);
      const params = {
        jails: body.jails?.length ? [...new Set(body.jails)] : fail2ban.jailsFor(),
        bantime: body.bantimeSeconds ?? cfg.bantime, findtime: body.findtimeSeconds ?? cfg.findtime, maxretry: body.maxretry ?? cfg.maxretry,
        panelPorts: [...new Set([config.port, config.tlsPort].filter(Boolean))],
        ignoreIps: Array.isArray(body.ignoreIps) ? [...new Set(body.ignoreIps)] : own ? [own] : [],
      };
      const result = await op('hardening.jails.apply', params, req);
      settings.setMany({ 'security.hardening.fail2ban.bantime_seconds': params.bantime, 'security.hardening.fail2ban.findtime_seconds': params.findtime, 'security.hardening.fail2ban.maxretry': params.maxretry });
      record('fail2ban', true, { params });
      audit(req, { action: 'security.hardening.apply', target: 'fail2ban', args: { jails: params.jails, bantime: params.bantime, findtime: params.findtime, maxretry: params.maxretry, ignoreIps: params.ignoreIps } });
      return { item: 'fail2ban', ...result };
    },
    async revert(req) {
      const result = await op('hardening.jails.revert', {}, req);
      record('fail2ban', false);
      audit(req, { action: 'security.hardening.revert', target: 'fail2ban', args: result });
      return { item: 'fail2ban', ...result };
    },
    async unban({ jail, ip }, req) {
      capabilities.require('fail2ban', 'Fail2ban is not installed on this server');
      const result = await op('hardening.jails.unban', { jail, ip }, req);
      audit(req, { action: 'security.hardening.fail2ban.unban', target: ip, args: { jail } });
      return result;
    },
    install(user, req) {
      if (typeof ctx.stack?.capabilityInstall !== 'function') throw unprocessable('Package installation is not available on this panel');
      return ctx.stack.capabilityInstall('fail2ban', user, req);
    },
  };

  // ------------------------------------------------------- auto updates ---
  const updates = {
    async status() {
      const live = await op('hardening.updates.status');
      if (!live.family) return shape('auto-updates', 'not_applicable', { ...live, reason: 'No supported package manager (apt-get, dnf or yum) was found' });
      if (!live.installed) return shape('auto-updates', 'not_applied', { ...live, reason: `The ${live.packages.join(', ')} package is not installed`, installable: Boolean(ctx.software?.pkg?.install) });
      const applied = live.configured && live.active === true && live.timerEnabled !== false;
      return shape('auto-updates', applied ? 'applied' : 'not_applied', { ...live, reason: !live.configured ? 'The panel policy files are not written' : live.active === false ? 'The periodic schedule is off' : live.timerEnabled === false ? 'The systemd timer is not enabled' : null });
    },
    async apply(_body, req) {
      const live = await op('hardening.updates.status');
      if (!live.family) throw new CapabilityError('pkg', 'No supported package manager (apt-get, dnf or yum) was found on this server');
      if (!live.installed) {
        if (typeof ctx.software?.pkg?.install !== 'function') throw unprocessable(`Install the ${live.packages.join(', ')} package first (Software › Install Distro Packages)`);
        const { job } = ctx.software.pkg.install(live.packages, req?.user, req);
        audit(req, { action: 'security.hardening.apply', target: 'auto-updates', args: { installing: live.packages, jobId: job.id } });
        return { item: 'auto-updates', installing: live.packages, job };
      }
      const result = await op('hardening.updates.apply', {}, req);
      record('auto-updates', true, { params: { family: live.family } });
      audit(req, { action: 'security.hardening.apply', target: 'auto-updates', args: { family: live.family, files: result.files } });
      return { item: 'auto-updates', ...result };
    },
    async revert(req) {
      const result = await op('hardening.updates.revert', {}, req);
      record('auto-updates', false);
      audit(req, { action: 'security.hardening.revert', target: 'auto-updates', args: result });
      return { item: 'auto-updates', ...result };
    },
  };

  // ---------------------------------------------------------------- ssh ---
  const ssh = {
    async status() {
      if (!capabilities.has('sshd')) return shape('ssh', 'not_applicable', { reason: 'OpenSSH server is not installed' });
      const cfg = await op('sec.sshd.get');
      const keys = await op('sec.ssh_keys.list').catch(() => ({ authorized: [] }));
      const checks = sshChecks(cfg.effective || {});
      const failing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
      const authorizedKeys = keys.authorized?.length ?? 0;
      return shape('ssh', failing.length ? 'not_applied' : 'applied', {
        checks, failing, authorizedKeys, effective: Object.fromEntries(SSH_KEYS.map((k) => [k, cfg.effective?.[k.toLowerCase()] ?? null])), managed: cfg.managed || {}, shadowed: cfg.shadowed || [],
        reason: failing.length ? `${failing.join(', ')} ${failing.length === 1 ? 'is' : 'are'} not hardened` : null, blocked: sshKeyLoginBlocked(cfg.effective || {}, authorizedKeys),
      });
    },
    async apply(_body, req) {
      capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server');
      const keys = await op('sec.ssh_keys.list').catch(() => ({ authorized: [] }));
      const cfg = await op('sec.sshd.get');
      const e = cfg.effective || {};
      const blocked = sshKeyLoginBlocked(e, keys.authorized?.length ?? 0);
      if (blocked) throw unprocessable(`Restricting root SSH login to keys would lock root out of SSH: ${blocked}`, { authorizedKeys: [blocked] });
      // Never loosen a stricter value another file already applies.
      const current = String(e.permitrootlogin || '').toLowerCase();
      const target = {
        PermitRootLogin: ROOT_LOGIN_KEEP.has(current) ? current : SSH_HARDENING.PermitRootLogin,
        MaxAuthTries: Math.min(SSH_HARDENING.MaxAuthTries, Number(e.maxauthtries) || SSH_HARDENING.MaxAuthTries),
        LoginGraceTime: Math.min(SSH_HARDENING.LoginGraceTime, Number(e.logingracetime) || SSH_HARDENING.LoginGraceTime),
        X11Forwarding: 'no',
      };
      const previous = Object.fromEntries(SSH_KEYS.map((k) => [k, cfg.managed?.[k] ?? null]));
      const result = await op('sec.sshd.set', { settings: target }, req);
      record('ssh', true, { params: target, previous: rowOf('ssh').desired ? rowOf('ssh').previous : previous });
      audit(req, { action: 'security.hardening.apply', target: 'ssh', args: target });
      return { item: 'ssh', ...result };
    },
    async revert(req) {
      capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server');
      const row = rowOf('ssh');
      const restoreValues = Object.fromEntries(SSH_KEYS.map((k) => {
        const v = row.previous?.[k] ?? null;
        return [k, v == null ? null : (k === 'MaxAuthTries' || k === 'LoginGraceTime') ? Number(v) : String(v)];
      }));
      const result = await op('sec.sshd.set', { settings: restoreValues }, req);
      record('ssh', false, { previous: null });
      audit(req, { action: 'security.hardening.revert', target: 'ssh', args: restoreValues });
      return { item: 'ssh', ...result };
    },
  };

  // ------------------------------------------------------------- sysctl ---
  const sysctl = {
    async status() {
      const live = await op('hardening.sysctl.status');
      if (live.checked === 0) return shape('sysctl', 'not_applicable', { ...live, reason: 'This kernel or container exposes none of the network hardening keys' });
      return shape('sysctl', live.applied ? 'applied' : 'not_applied', { ...live, reason: !live.configured ? 'The sysctl.d file is not written' : live.mismatched.length ? `${live.mismatched.length} key(s) hold another value (a later sysctl.d file or /etc/sysctl.conf wins)` : null });
    },
    async apply(_body, req) {
      const result = await op('hardening.sysctl.apply', {}, req);
      const row = rowOf('sysctl');
      record('sysctl', true, { previous: row.desired && row.previous ? row.previous : result.previous });
      audit(req, { action: 'security.hardening.apply', target: 'sysctl', args: { path: result.path, keys: Object.keys(result.previous || {}).length } });
      return { item: 'sysctl', ...result };
    },
    async revert(req) {
      const row = rowOf('sysctl');
      const restore = Object.fromEntries(Object.entries(row.previous || {}).filter(([, v]) => /^\d{1,10}$/.test(String(v))));
      const result = await op('hardening.sysctl.revert', { restore }, req);
      record('sysctl', false, { previous: null });
      audit(req, { action: 'security.hardening.revert', target: 'sysctl', args: { restored: result.restored } });
      return { item: 'sysctl', ...result };
    },
  };

  // ----------------------------------------------------------- firewall ---
  const firewall = {
    // Every port the baseline keeps open, from what this host runs.
    async plan({ extraTcp = [], extraUdp = [] } = {}, live = null) {
      const fw = live || await op('hardening.firewall.status');
      let sshPorts = fw.sshdPorts || [];
      let sshSource = fw.sshdSocket || 'listening';
      if (!sshPorts.length) {
        const cfg = await op('sec.sshd.get').catch(() => null);
        sshPorts = [Number(cfg?.effective?.port) || 22];
        sshSource = cfg ? 'sshd configuration' : 'default';
      }
      const tcp = new Map();
      const udp = new Map();
      const add = (map, p, why) => { const key = typeof p === 'number' ? String(p) : `${p.from}-${p.to}`; if (!map.has(key)) map.set(key, { port: p, reasons: [] }); map.get(key).reasons.push(why); };
      for (const p of [config.port, config.tlsPort].filter(Boolean)) add(tcp, p, 'panel');
      for (const p of sshPorts) add(tcp, p, 'ssh');
      add(tcp, 80, 'web'); add(tcp, 443, 'web');
      if (capabilities.has('exim')) for (const p of [25, 465, 587]) add(tcp, p, 'mail (smtp)');
      if (capabilities.has('dovecot')) for (const p of [110, 143, 993, 995]) add(tcp, p, 'mail (imap/pop3)');
      if (capabilities.has('bind') || capabilities.has('powerdns')) { add(tcp, 53, 'dns'); add(udp, 53, 'dns'); }
      if (capabilities.has('ftp')) {
        add(tcp, 21, 'ftp');
        const f = ctx.web?.ftp?.settings?.() || {};
        const from = Number(f.passivePortMin) || 49152; const to = Number(f.passivePortMax) || 65534;
        if (from <= to) add(tcp, { from, to }, 'ftp passive');
      }
      if (fw.hubUnit) for (const p of (fw.hubPorts?.length ? fw.hubPorts : [HUB_PORT])) add(tcp, p, 'license hub');
      for (const p of extraTcp) add(tcp, p, 'extra');
      for (const p of extraUdp) add(udp, p, 'extra');
      return { backend: fw.backend, sshPorts, sshSource, tcp: [...tcp.values()], udp: [...udp.values()], builtin: BUILTIN_RULES, conflicts: fw.conflicts, extraTcp, extraUdp };
    },
    async status() {
      const live = await op('hardening.firewall.status');
      if (!capabilities.has('firewall') || !live.backend) return shape('firewall', 'not_applied', { ...live, reason: 'No supported firewall (iptables or nftables) is installed', installable: true });
      if (live.conflicts?.firewalld || live.conflicts?.ufw) return shape('firewall', 'not_applicable', { ...live, reason: `${live.conflicts.firewalld ? 'firewalld' : 'ufw'} is active and owns the input policy` });
      const row = rowOf('firewall');
      return shape('firewall', live.applied ? 'applied' : 'not_applied', { ...live, reason: live.applied ? null : row.desired ? 'The baseline is enabled but not active (lost on reboot or a firewall restart); it is re-applied at boot' : 'The input policy accepts everything not explicitly blocked' });
    },
    requireBackend(live) {
      capabilities.require('firewall', 'No firewall tooling (iptables or nftables) is installed on this server');
      if (!live.backend) throw new CapabilityError('firewall', 'Only iptables and nftables backends are supported; install iptables or nft');
      return live.backend;
    },
    async apply(body = {}, req, { reconcile = false } = {}) {
      const live = await op('hardening.firewall.status');
      firewall.requireBackend(live);
      if (live.conflicts?.firewalld || live.conflicts?.ufw) throw unprocessable(`${live.conflicts.firewalld ? 'firewalld' : 'ufw'} is active and owns the input policy; manage the baseline there or stop it first`);
      const row = rowOf('firewall');
      const extras = { extraTcp: body.extraTcp ?? row.params.extraTcp ?? [], extraUdp: body.extraUdp ?? row.params.extraUdp ?? [] };
      const plan = await firewall.plan(extras, live);
      if (!plan.sshPorts.length) throw unprocessable('The SSH port could not be determined; the baseline was not applied');
      if (!reconcile) {
        const confirmed = Number(body.confirmSshPort);
        if (!Number.isInteger(confirmed)) throw unprocessable('Confirm the SSH port you are reaching this server on before applying the baseline', { confirmSshPort: ['Required: the SSH port you can still reach'] });
        if (!plan.sshPorts.includes(confirmed)) throw unprocessable(`sshd is listening on port ${plan.sshPorts.join(', ')}, not ${confirmed}; the baseline was not applied`, { confirmSshPort: [`Must be one of ${plan.sshPorts.join(', ')}`] });
      }
      const tcp = plan.tcp.map((e) => e.port);
      const udp = plan.udp.map((e) => e.port);
      const unreachable = plan.sshPorts.filter((p) => !inPorts(tcp, p));
      if (unreachable.length) throw unprocessable(`SSH port ${unreachable.join(', ')} would be blocked; the baseline was not applied`);
      const result = await op('hardening.firewall.apply', { tcp, udp, sshPorts: plan.sshPorts }, req);
      record('firewall', true, { params: { ...extras, tcp: tcp.map((p) => (typeof p === 'number' ? p : `${p.from}-${p.to}`)), udp: udp.map((p) => (typeof p === 'number' ? p : `${p.from}-${p.to}`)) }, previous: row.desired && row.previous ? row.previous : { policy: result.previousPolicy } });
      audit(req, { action: 'security.hardening.apply', target: 'firewall', args: { backend: result.backend, tcp: result.tcp, udp: result.udp, sshPorts: plan.sshPorts, reconcile } });
      return { item: 'firewall', plan, ...result };
    },
    async revert(req) {
      const live = await op('hardening.firewall.status');
      firewall.requireBackend(live);
      const row = rowOf('firewall');
      const restorePolicy = row.previous?.policy === 'DROP' ? 'DROP' : 'ACCEPT';
      const result = await op('hardening.firewall.revert', { restorePolicy }, req);
      record('firewall', false, { params: row.params, previous: null });
      audit(req, { action: 'security.hardening.revert', target: 'firewall', args: { backend: result.backend, restorePolicy } });
      return { item: 'firewall', ...result };
    },
  };

  const handlers = { fail2ban, 'auto-updates': updates, ssh, sysctl, firewall };

  async function status() {
    const items = [];
    for (const meta of ITEMS) {
      try { items.push(await handlers[meta.id].status()); } catch (err) {
        const capability = err instanceof CapabilityError || err?.code === 'capability_missing' || err?.code === 'binary_not_found';
        items.push(shape(meta.id, capability ? 'not_applied' : 'unknown', { reason: err.message, installable: capability, error: capability ? null : err.message }));
      }
    }
    return { items, generatedAt: new Date().toISOString() };
  }

  const apply = (item, body, req) => {
    if (!handlers[item]) throw unprocessable(`Unknown hardening item "${item}"`);
    return handlers[item].apply(body, req);
  };
  const revert = (item, req) => {
    if (!handlers[item]) throw unprocessable(`Unknown hardening item "${item}"`);
    return handlers[item].revert(req);
  };

  // One finding per item for the Security Advisor: not applied → the item's
  // grade; applied → ok; not applicable → skipped.
  async function findings() {
    const { items } = await status();
    const out = [];
    for (const it of items) {
      if (it.status === 'not_applicable') continue;
      if (it.status === 'applied') { out.push({ id: `hardening.${it.id}`, grade: 'ok', title: `${it.label}: applied` }); continue; }
      out.push({ id: `hardening.${it.id}`, grade: it.status === 'unknown' ? 'info' : it.grade, title: `${it.label} is not applied`, detail: [it.detail?.reason, it.detail?.blocked, it.description].filter(Boolean).join('\n'), fix: ADVISOR_FIX });
    }
    return out;
  }

  // The baseline lives in the kernel only: like WHM_BLOCK it is gone after a
  // reboot, so the job worker puts it back when the operator left it on.
  async function reconcile(job) {
    const row = rowOf('firewall');
    if (!row.desired) return { firewall: { desired: false } };
    if (!capabilities.has('firewall')) return { firewall: { desired: true, reapplied: false, error: 'no firewall tooling is installed' } };
    try {
      const live = await op('hardening.firewall.status');
      if (!live.backend) return { firewall: { desired: true, reapplied: false, error: 'no supported firewall backend' } };
      if (live.applied) return { firewall: { desired: true, reapplied: false, applied: true } };
      const result = await firewall.apply({}, null, { reconcile: true });
      job?.log?.(`firewall baseline re-applied (${result.backend}: tcp ${result.tcp.join(', ')})`);
      return { firewall: { desired: true, reapplied: true, backend: result.backend } };
    } catch (err) {
      job?.log?.(`firewall baseline not re-applied: ${err.message}`, 'warn');
      logger.warn({ err }, 'hardening: firewall baseline not re-applied');
      return { firewall: { desired: true, reapplied: false, error: err.message } };
    }
  }

  return { ITEMS, RECONCILE_JOB, status, apply, revert, findings, reconcile, desired: (item) => rowOf(item).desired, state: rowOf, fail2ban, updates, ssh, sysctl, firewall };
}
