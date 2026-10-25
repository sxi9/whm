import net from 'node:net';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, badRequest, CapabilityError } from '../lib/errors.js';

// Security Center. Attached as ctx.security; other categories may call:
//   security.policy()                         -> current login/session policy settings
//   security.passwordStrength(pw, context)    -> { score, minimum, ok }
//   security.cphulk.isBlocked(ip) / isAllowlisted(ip) / block(ip, opts) / unblock(ip)
//   security.firewall.block(ip) / unblock(ip) / list()
//   security.reloadApache(req)                -> uses ctx.web.reload when that category exists
//   security.modsec.detect() / security.ssh.config() / security.externalAuth.*

const KNOWN_SERVICES = ['ALL', 'sshd', 'vsftpd', 'proftpd', 'pure-ftpd', 'exim', 'dovecot', 'imap', 'pop3', 'named', 'mysqld', 'whm-panel', 'ftpd', 'telnetd'];
const PASSWORD_CONTEXTS = ['account', 'email', 'ftp', 'mysql', 'panel', 'ssh'];

export function passwordStrength(pw) {
  if (!pw) return 0;
  let score = Math.min(40, pw.length * 4);
  if (/[a-z]/.test(pw)) score += 10;
  if (/[A-Z]/.test(pw)) score += 15;
  if (/\d/.test(pw)) score += 15;
  if (/[^A-Za-z0-9]/.test(pw)) score += 20;
  if (/(.)\1{2,}/.test(pw)) score -= 15;
  if (/^(password|123456|qwerty|letmein)/i.test(pw)) score = 5;
  return Math.max(0, Math.min(100, score));
}

export function ipInCidr(ip, cidr) {
  const [network, prefixStr] = cidr.split('/');
  if (prefixStr === undefined) return ip === network;
  const family = net.isIP(ip);
  if (!family || family !== net.isIP(network)) return false;
  const prefix = Number(prefixStr);
  const toBits = (addr) => {
    if (family === 4) return addr.split('.').map((o) => Number(o).toString(2).padStart(8, '0')).join('');
    const [head, tail = ''] = addr.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    return groups.map((g) => parseInt(g || '0', 16).toString(2).padStart(16, '0')).join('');
  };
  return toBits(ip).slice(0, prefix) === toBits(network).slice(0, prefix);
}

export function createSecurityCenterService(ctx) {
  const { db, agent, capabilities, settings, crypto, config, logger } = ctx;

  const stmts = {
    hostRules: db.prepare('SELECT * FROM host_access_rules ORDER BY position, id'),
    clearHostRules: db.prepare('DELETE FROM host_access_rules'),
    insertHostRule: db.prepare('INSERT INTO host_access_rules (service, source, action, comment, position) VALUES (?, ?, ?, ?, ?)'),
    activeBlocks: db.prepare(`SELECT * FROM cphulk_blocks WHERE expires_at IS NULL OR expires_at > datetime('now') ORDER BY created_at DESC`),
    activeBlockByIp: db.prepare(`SELECT * FROM cphulk_blocks WHERE ip = ? AND (expires_at IS NULL OR expires_at > datetime('now')) LIMIT 1`),
    blockById: db.prepare('SELECT * FROM cphulk_blocks WHERE id = ?'),
    insertBlock: db.prepare('INSERT INTO cphulk_blocks (ip, reason, expires_at) VALUES (?, ?, ?)'),
    expireBlock: db.prepare(`UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE id = ?`),
    expireBlocksByIp: db.prepare(`UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE ip = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`),
    expireAllBlocks: db.prepare(`UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE expires_at IS NULL OR expires_at > datetime('now')`),
    purgeBlocks: db.prepare(`DELETE FROM cphulk_blocks WHERE expires_at IS NOT NULL AND expires_at < datetime('now', ?)`),
    purgeAttempts: db.prepare(`DELETE FROM login_attempts WHERE created_at < datetime('now', ?)`),
    lists: db.prepare('SELECT * FROM cphulk_lists ORDER BY kind, ip'),
    listByKind: db.prepare('SELECT * FROM cphulk_lists WHERE kind = ? ORDER BY ip'),
    listById: db.prepare('SELECT * FROM cphulk_lists WHERE id = ?'),
    insertList: db.prepare('INSERT INTO cphulk_lists (kind, ip, comment) VALUES (?, ?, ?)'),
    deleteList: db.prepare('DELETE FROM cphulk_lists WHERE id = ?'),
    attemptStats: db.prepare(`SELECT COUNT(*) AS attempts, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures FROM login_attempts WHERE created_at > datetime('now', '-1 day')`),
    topOffenders: db.prepare(`SELECT ip, COUNT(*) AS failures, MAX(created_at) AS last_seen FROM login_attempts WHERE ok = 0 AND created_at > datetime('now', '-1 day') GROUP BY ip ORDER BY failures DESC LIMIT 10`),
    disabledRules: db.prepare('SELECT * FROM modsec_disabled_rules ORDER BY rule_id'),
    disableRule: db.prepare('INSERT OR REPLACE INTO modsec_disabled_rules (rule_id, reason) VALUES (?, ?)'),
    enableRule: db.prepare('DELETE FROM modsec_disabled_rules WHERE rule_id = ?'),
    vendors: db.prepare('SELECT * FROM modsec_vendors ORDER BY name'),
    vendorByName: db.prepare('SELECT * FROM modsec_vendors WHERE name = ?'),
    insertVendor: db.prepare('INSERT INTO modsec_vendors (name, url, enabled) VALUES (?, ?, ?)'),
    updateVendor: db.prepare("UPDATE modsec_vendors SET url = @url, enabled = @enabled, installed_at = datetime('now') WHERE id = @id"),
    setVendorEnabled: db.prepare('UPDATE modsec_vendors SET enabled = ? WHERE id = ?'),
    deleteVendor: db.prepare('DELETE FROM modsec_vendors WHERE id = ?'),
    providers: db.prepare('SELECT * FROM external_auth_providers ORDER BY name'),
    providerByName: db.prepare('SELECT * FROM external_auth_providers WHERE name = ?'),
    insertProvider: db.prepare('INSERT INTO external_auth_providers (name, display_name, issuer_url, client_id, client_secret_enc, scopes, enabled) VALUES (@name, @display_name, @issuer_url, @client_id, @client_secret_enc, @scopes, @enabled)'),
    updateProvider: db.prepare(`UPDATE external_auth_providers SET display_name = @display_name, issuer_url = @issuer_url, client_id = @client_id, client_secret_enc = @client_secret_enc, scopes = @scopes, enabled = @enabled, discovery_json = @discovery_json, updated_at = datetime('now') WHERE id = @id`),
    deleteProvider: db.prepare('DELETE FROM external_auth_providers WHERE id = ?'),
    providerLinks: db.prepare('SELECT COUNT(*) AS n FROM external_auth_links WHERE provider_id = ?'),
    linkFind: db.prepare('SELECT l.*, u.username, u.role FROM external_auth_links l JOIN users u ON u.id = l.user_id WHERE l.provider_id = ? AND l.subject = ?'),
    linkInsert: db.prepare('INSERT OR REPLACE INTO external_auth_links (provider_id, user_id, subject, email) VALUES (?, ?, ?, ?)'),
    lastRun: db.prepare('SELECT * FROM security_advisor_runs ORDER BY id DESC LIMIT 1'),
    insertRun: db.prepare(`INSERT INTO security_advisor_runs (trigger, finished_at, summary_json, findings_json) VALUES (?, datetime('now'), ?, ?)`),
    pruneRuns: db.prepare('DELETE FROM security_advisor_runs WHERE id NOT IN (SELECT id FROM security_advisor_runs ORDER BY id DESC LIMIT 20)'),
    rootUser: db.prepare("SELECT username, totp_enabled FROM users WHERE role = 'root' ORDER BY id LIMIT 1"),
    shellAccounts: db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE shell NOT IN ('/usr/sbin/nologin', '/usr/local/bin/jailshell')"),
    accountUsers: db.prepare('SELECT username FROM accounts ORDER BY username'),
  };

  const op = (name, args, req) => agent.op(name, args, { req });

  // Apache reloads are owned by the Service Configuration / web category when it
  // exists; until then (or on a host where it is absent) go through systemd.
  async function reloadApache(req) {
    if (typeof ctx.web?.reload === 'function') return ctx.web.reload(req);
    await capabilities.ensureFresh();
    const unit = capabilities.unitFor('httpd');
    if (!unit) throw new CapabilityError('apache', 'Apache is not installed on this server');
    return op('svc.reload', { unit }, req);
  }

  function requireFirewallBackend(detect) {
    capabilities.require('firewall', 'No firewall tooling (iptables or nftables) is installed on this server');
    if (!detect.backend) throw new CapabilityError('firewall', 'Only iptables and nftables backends are supported; install iptables or nft');
    return detect.backend;
  }

  let modsecCache = { at: 0, layout: null };
  async function detectModsec(force = false) {
    if (!force && modsecCache.layout && Date.now() - modsecCache.at < 60_000) return modsecCache.layout;
    const layout = await op('sec.modsec.detect');
    modsecCache = { at: Date.now(), layout };
    return layout;
  }
  async function requireModsec() {
    capabilities.require('apache', 'Apache is not installed; ModSecurity runs as an Apache module');
    const layout = await detectModsec();
    if (!layout.installed) throw new CapabilityError('modsecurity', 'ModSecurity is not installed (no /etc/modsecurity or mod_security.conf found). Install libapache2-mod-security2 / mod_security.');
    return layout;
  }

  const hostAccess = {
    list() {
      return stmts.hostRules.all().map((r) => ({ id: r.id, service: r.service, source: r.source, action: r.action, comment: r.comment, position: r.position }));
    },
    async files() { return op('sec.hosts_allow.read'); },
    async replace(rules, req) {
      db.transaction(() => {
        stmts.clearHostRules.run();
        rules.forEach((r, i) => stmts.insertHostRule.run(r.service, r.source, r.action, r.comment || null, i));
      })();
      const result = await op('sec.hosts_allow.write', { rules: rules.map((r) => ({ service: r.service, source: r.source, action: r.action, ...(r.comment ? { comment: r.comment } : {}) })) }, req);
      req?.audit?.({ action: 'security.host_access.update', args: { rules: rules.length } });
      return { rules: hostAccess.list(), written: result };
    },
    services: () => KNOWN_SERVICES,
  };

  const ssh = {
    async config() {
      capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server');
      const cfg = await op('sec.sshd.get');
      const keys = await op('sec.ssh_keys.list').catch(() => ({ authorized: [] }));
      return { ...cfg, authorizedKeyCount: keys.authorized?.length ?? 0 };
    },
    async setConfig(settingsIn, req) {
      capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server');
      const result = await op('sec.sshd.set', { settings: settingsIn }, req);
      req?.audit?.({ action: 'security.sshd.update', args: settingsIn });
      return result;
    },
    async keys() {
      capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server');
      return op('sec.ssh_keys.list');
    },
    async importKey(publicKey, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.add', { publicKey }, req);
      req?.audit?.({ action: 'security.ssh_keys.authorize', target: result.fingerprint });
      return result;
    },
    async generate(input, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.generate', input, req);
      req?.audit?.({ action: 'security.ssh_keys.generate', target: input.name, args: { type: input.type, bits: input.bits, authorize: input.authorize } });
      return result;
    },
    async authorize(name, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.authorize', { name }, req);
      req?.audit?.({ action: 'security.ssh_keys.authorize', target: name });
      return result;
    },
    async deauthorize(fingerprint, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.remove', { fingerprint }, req);
      req?.audit?.({ action: 'security.ssh_keys.deauthorize', target: fingerprint });
      return result;
    },
    async deletePair(name, deauthorize, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.delete_pair', { name, deauthorize }, req);
      req?.audit?.({ action: 'security.ssh_keys.delete', target: name, args: { deauthorize } });
      return result;
    },
    async exportPrivate(name, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.export', { name }, req);
      req?.audit?.({ action: 'security.ssh_keys.export_private', target: name });
      return result;
    },
  };

  const cphulk = {
    settings() {
      return {
        enabled: Boolean(settings.get('security.cphulk.enabled')),
        maxFailuresPerIp: settings.get('security.cphulk.max_failures_per_ip'),
        lockoutMinutes: settings.get('security.cphulk.lockout_minutes'),
        firewallSync: Boolean(settings.get('security.cphulk.firewall_sync')),
        historyRetentionDays: settings.get('security.cphulk.history_retention_days'),
        blockDenylistPermanently: Boolean(settings.get('security.cphulk.block_denylist_permanently')),
      };
    },
    updateSettings(input, req) {
      const map = { enabled: 'security.cphulk.enabled', maxFailuresPerIp: 'security.cphulk.max_failures_per_ip', lockoutMinutes: 'security.cphulk.lockout_minutes', firewallSync: 'security.cphulk.firewall_sync', historyRetentionDays: 'security.cphulk.history_retention_days', blockDenylistPermanently: 'security.cphulk.block_denylist_permanently' };
      const values = {};
      for (const [k, v] of Object.entries(input)) if (v !== undefined && map[k]) values[map[k]] = v;
      settings.setMany(values);
      req?.audit?.({ action: 'security.cphulk.settings', args: values });
      return cphulk.settings();
    },
    overview() {
      const stats = stmts.attemptStats.get();
      return { settings: cphulk.settings(), blocks: cphulk.blocks(), stats: { attempts24h: stats.attempts || 0, failures24h: stats.failures || 0, activeBlocks: stmts.activeBlocks.all().length, topOffenders: stmts.topOffenders.all() } };
    },
    blocks: () => stmts.activeBlocks.all().map((b) => ({ ...b, permanent: b.expires_at == null })),
    isBlocked: (ip) => Boolean(stmts.activeBlockByIp.get(ip)),
    isAllowlisted: (ip) => stmts.listByKind.all('allow').some((e) => ipInCidr(ip, e.ip)),
    history(query) {
      const where = [];
      const params = {};
      if (query.q) { where.push('(ip LIKE @q OR username LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.failed) where.push('ok = 0');
      return paginate(db, { select: '*', from: 'login_attempts', where, params, sortable: { created_at: 'created_at', ip: 'ip', username: 'username' }, defaultSort: 'created_at', query: { ...query, dir: query.dir || 'desc' } });
    },
    async block(ip, { minutes = null, reason = 'manual block', firewall = false } = {}, req) {
      if (cphulk.isAllowlisted(ip)) throw conflict(`${ip} is on the allowlist`);
      if (stmts.activeBlockByIp.get(ip)) throw conflict(`${ip} is already blocked`);
      const { lastInsertRowid } = stmts.insertBlock.run(ip, reason, minutes ? new Date(Date.now() + minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19) : null);
      let firewalled = false;
      if (firewall || settings.get('security.cphulk.firewall_sync')) {
        try { await firewallApi.block(ip, req); firewalled = true; } catch (err) { logger.warn({ err, ip }, 'cPHulk: firewall block failed'); }
      }
      req?.audit?.({ action: 'security.cphulk.block', target: ip, args: { minutes, reason, firewalled } });
      return { ...stmts.blockById.get(lastInsertRowid), firewalled };
    },
    async unblock(id, req) {
      const row = stmts.blockById.get(id);
      if (!row) throw notFound('Block');
      stmts.expireBlocksByIp.run(row.ip);
      let firewalled = false;
      if (settings.get('security.cphulk.firewall_sync') && capabilities.has('firewall')) {
        try { await firewallApi.unblock(row.ip, req); firewalled = true; } catch (err) { logger.warn({ err, ip: row.ip }, 'cPHulk: firewall unblock failed'); }
      }
      req?.audit?.({ action: 'security.cphulk.unblock', target: row.ip });
      return { ip: row.ip, unblocked: true, firewalled };
    },
    async flush(req) {
      const n = stmts.expireAllBlocks.run().changes;
      if (settings.get('security.cphulk.firewall_sync') && capabilities.has('firewall')) {
        try { await op('sec.firewall.flush', {}, req); } catch (err) { logger.warn({ err }, 'cPHulk: firewall flush failed'); }
      }
      req?.audit?.({ action: 'security.cphulk.flush', args: { blocks: n } });
      return { cleared: n };
    },
    lists: () => stmts.lists.all(),
    addToList(kind, ip, comment, req) {
      if (stmts.lists.all().some((e) => e.kind === kind && e.ip === ip)) throw conflict(`${ip} is already on the ${kind} list`);
      const { lastInsertRowid } = stmts.insertList.run(kind, ip, comment || null);
      if (kind === 'allow') stmts.expireBlocksByIp.run(ip);
      if (kind === 'deny' && settings.get('security.cphulk.block_denylist_permanently') && !ip.includes('/') && !stmts.activeBlockByIp.get(ip)) stmts.insertBlock.run(ip, 'denylist', null);
      req?.audit?.({ action: `security.cphulk.${kind}list.add`, target: ip, args: { comment } });
      return stmts.listById.get(lastInsertRowid);
    },
    removeFromList(id, req) {
      const row = stmts.listById.get(id);
      if (!row) throw notFound('List entry');
      stmts.deleteList.run(id);
      if (row.kind === 'deny') db.prepare("UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE ip = ? AND reason = 'denylist' AND expires_at IS NULL").run(row.ip);
      req?.audit?.({ action: `security.cphulk.${row.kind}list.remove`, target: row.ip });
      return { removed: true };
    },
    // Hourly job: purge history, expire blocks that match the allowlist and keep
    // the firewall chain equal to "active blocks + permanent denylist".
    async maintenance(job) {
      const days = Number(settings.get('security.cphulk.history_retention_days')) || 30;
      const purgedAttempts = stmts.purgeAttempts.run(`-${days} days`).changes;
      const purgedBlocks = stmts.purgeBlocks.run(`-${days} days`).changes;
      let lifted = 0;
      for (const b of stmts.activeBlocks.all()) if (cphulk.isAllowlisted(b.ip)) { stmts.expireBlock.run(b.id); lifted++; }
      const result = { purgedAttempts, purgedBlocks, liftedAllowlisted: lifted, firewall: null };
      if (settings.get('security.cphulk.firewall_sync') && capabilities.has('firewall')) {
        try {
          const detect = await op('sec.firewall.detect');
          if (detect.backend) {
            const desired = new Set([...stmts.activeBlocks.all().map((b) => b.ip), ...stmts.listByKind.all('deny').map((e) => e.ip)]);
            const current = new Set((await op('sec.firewall.list')).entries.map((e) => e.ip));
            let added = 0; let removed = 0;
            for (const ip of desired) if (!current.has(ip)) { await op('sec.firewall.block', { ip }); added++; }
            for (const ip of current) if (!desired.has(ip)) { await op('sec.firewall.unblock', { ip }); removed++; }
            result.firewall = { backend: detect.backend, added, removed, total: desired.size };
          }
        } catch (err) {
          job?.log?.(`firewall sync skipped: ${err.message}`, 'warn');
          result.firewall = { error: err.message };
        }
      }
      job?.log?.(`cPHulk maintenance: ${JSON.stringify(result)}`);
      return result;
    },
  };

  const firewallApi = {
    async status() {
      const detect = await op('sec.firewall.detect');
      if (!capabilities.has('firewall') || !detect.backend) return { ...detect, installed: false, entries: [] };
      const list = await op('sec.firewall.list');
      return { ...detect, installed: true, entries: list.entries };
    },
    async block(ip, req) {
      requireFirewallBackend(await op('sec.firewall.detect'));
      const result = await op('sec.firewall.block', { ip }, req);
      req?.audit?.({ action: 'security.firewall.block', target: ip });
      return result;
    },
    async unblock(ip, req) {
      requireFirewallBackend(await op('sec.firewall.detect'));
      const result = await op('sec.firewall.unblock', { ip }, req);
      req?.audit?.({ action: 'security.firewall.unblock', target: ip });
      return result;
    },
    async list() { requireFirewallBackend(await op('sec.firewall.detect')); return (await op('sec.firewall.list')).entries; },
  };

  const smtp = {
    async status() {
      const state = await op('sec.smtp_restrict.get');
      return { ...state, installed: capabilities.has('firewall') && Boolean(state.backend) };
    },
    async set(enabled, req) {
      requireFirewallBackend(await op('sec.firewall.detect'));
      const result = await op('sec.smtp_restrict.set', { enabled }, req);
      req?.audit?.({ action: 'security.smtp_restrictions.set', args: { enabled } });
      return result;
    },
  };

  const compilers = {
    status: () => op('sec.compiler_access.get'),
    async set(allow, req) {
      const result = await op('sec.compiler_access.set', { allow }, req);
      req?.audit?.({ action: 'security.compiler_access.set', args: { allow } });
      return result;
    },
  };

  const traceroute = {
    status: () => op('sec.traceroute.get'),
    async set(enabled, req) {
      const result = await op('sec.traceroute.set', { enabled }, req);
      req?.audit?.({ action: 'security.traceroute.set', args: { enabled } });
      return result;
    },
  };

  const forkBomb = {
    status: () => op('sec.fork_bomb.get'),
    async set(input, req) {
      const result = await op('sec.fork_bomb.set', input, req);
      req?.audit?.({ action: 'security.fork_bomb.set', args: input });
      return result;
    },
  };

  const wheel = {
    async group() {
      for (const g of ['wheel', 'sudo']) {
        const info = await op('user.groups.members', { group: g });
        if (info.exists) return info;
      }
      return { group: 'wheel', exists: false, members: [] };
    },
    async list() {
      const group = await wheel.group();
      const linux = await op('user.list_managed').catch(() => []);
      const candidates = [...new Set([...linux.map((u) => u.username), ...stmts.accountUsers.all().map((a) => a.username)])].filter((u) => !group.members.includes(u)).sort();
      return { ...group, candidates };
    },
    async add(username, req) {
      const group = await wheel.group();
      if (!group.exists) throw badRequest('Neither a "wheel" nor a "sudo" group exists on this server');
      if (group.members.includes(username)) throw conflict(`${username} is already in ${group.group}`);
      await op('user.groups.set_membership', { username, group: group.group, member: true }, req);
      req?.audit?.({ action: 'security.wheel.add', target: username, args: { group: group.group } });
      return wheel.list();
    },
    async remove(username, req) {
      const group = await wheel.group();
      if (!group.exists) throw badRequest('Neither a "wheel" nor a "sudo" group exists on this server');
      if (!group.members.includes(username)) throw notFound(`${username} in ${group.group}`);
      await op('user.groups.set_membership', { username, group: group.group, member: false }, req);
      req?.audit?.({ action: 'security.wheel.remove', target: username, args: { group: group.group } });
      return wheel.list();
    },
  };

  const userdir = {
    async status() {
      const state = await op('sec.userdir.get');
      return { ...state, installed: Boolean(state.installed) && capabilities.has('apache'), accounts: stmts.accountUsers.all().map((a) => a.username) };
    },
    async set({ enabled, excludeUsers }, req) {
      capabilities.require('apache', 'Apache is not installed on this server');
      const result = await op('sec.userdir.set', { enabled, excludeUsers, homeRoot: settings.get('basic.home_root') || '/home' }, req);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      req?.audit?.({ action: 'security.userdir.set', args: { enabled, excludeUsers } });
      return { ...result, reload };
    },
  };

  const modsec = {
    detect: detectModsec,
    async status() {
      capabilities.require('apache', 'Apache is not installed; ModSecurity runs as an Apache module');
      const layout = await detectModsec(true);
      if (!layout.installed) return { installed: false, layout };
      const config = await op('sec.modsec.get_config');
      return { installed: true, layout, ...config, disabledRules: stmts.disabledRules.all(), vendors: stmts.vendors.all().map((v) => ({ ...v, enabled: Boolean(v.enabled) })) };
    },
    async setConfig(directives, req) {
      await requireModsec();
      const result = await op('sec.modsec.set_config', { directives }, req);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      req?.audit?.({ action: 'security.modsec.config', args: directives });
      return { ...result, reload };
    },
    async rules(query) {
      await requireModsec();
      const { files, rules, truncated } = await op('sec.modsec.list_rules', { limit: 20000 });
      const disabled = new Set(stmts.disabledRules.all().map((r) => r.rule_id));
      let list = rules.map((r) => ({ ...r, disabled: disabled.has(r.id) }));
      if (query.q) { const q = query.q.toLowerCase(); list = list.filter((r) => String(r.id).includes(q) || (r.msg || '').toLowerCase().includes(q) || (r.file || '').toLowerCase().includes(q) || (r.tag || '').toLowerCase().includes(q)); }
      if (query.vendor) list = list.filter((r) => (r.vendor || 'base') === query.vendor);
      if (query.disabled) list = list.filter((r) => r.disabled);
      const page = query.page || 1; const pageSize = query.pageSize || 50;
      return { data: list.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, total: list.length, files: files.length, truncated } };
    },
    disabledRules: () => stmts.disabledRules.all(),
    async setRuleDisabled(ruleId, disabled, reason, req) {
      await requireModsec();
      if (disabled) stmts.disableRule.run(ruleId, reason || null); else stmts.enableRule.run(ruleId);
      const ids = stmts.disabledRules.all().map((r) => r.rule_id);
      const result = await op('sec.modsec.set_disabled', { ids }, req);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      req?.audit?.({ action: disabled ? 'security.modsec.rule.disable' : 'security.modsec.rule.enable', target: String(ruleId), args: { reason } });
      return { ruleId, disabled, ids, path: result.path, reload };
    },
    async hits(limit) {
      await requireModsec();
      return op('sec.modsec.hits', { limit });
    },
    vendors: () => stmts.vendors.all().map((v) => ({ ...v, enabled: Boolean(v.enabled) })),
    async addVendor({ name, url, enabled = true }, user, req) {
      await requireModsec();
      if (stmts.vendorByName.get(name)) throw conflict(`Vendor "${name}" already exists`);
      stmts.insertVendor.run(name, url, enabled ? 1 : 0);
      req?.audit?.({ action: 'security.modsec.vendor.add', target: name, args: { url } });
      return { vendor: stmts.vendorByName.get(name), job: ctx.jobs.enqueue('security.modsec.vendor.install', { name }, { userId: user?.id ?? null }) };
    },
    async updateVendor(name, user, req) {
      await requireModsec();
      const vendor = stmts.vendorByName.get(name);
      if (!vendor) throw notFound('Vendor');
      req?.audit?.({ action: 'security.modsec.vendor.update', target: name });
      return { vendor, job: ctx.jobs.enqueue('security.modsec.vendor.install', { name }, { userId: user?.id ?? null }) };
    },
    async setVendorEnabled(name, enabled, req) {
      await requireModsec();
      const vendor = stmts.vendorByName.get(name);
      if (!vendor) throw notFound('Vendor');
      stmts.setVendorEnabled.run(enabled ? 1 : 0, vendor.id);
      const applied = await modsec.applyVendors(req);
      req?.audit?.({ action: 'security.modsec.vendor.toggle', target: name, args: { enabled } });
      return { ...stmts.vendorByName.get(name), enabled, applied };
    },
    async removeVendor(name, req) {
      await requireModsec();
      const vendor = stmts.vendorByName.get(name);
      if (!vendor) throw notFound('Vendor');
      stmts.deleteVendor.run(vendor.id);
      await op('sec.modsec.vendor.remove', { name }, req);
      const applied = await modsec.applyVendors(req);
      req?.audit?.({ action: 'security.modsec.vendor.remove', target: name });
      return { removed: true, applied };
    },
    async applyVendors(req) {
      const vendors = stmts.vendors.all().map((v) => ({ name: v.name, enabled: Boolean(v.enabled) }));
      const result = await op('sec.modsec.vendors.apply', { vendors }, req);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      return { ...result, reload };
    },
    async installVendorJob(job) {
      const vendor = stmts.vendorByName.get(job.params.name);
      if (!vendor) throw new Error(`vendor "${job.params.name}" no longer exists`);
      job.log(`Downloading ${vendor.url}`);
      job.progress(10, 'downloading');
      const result = await agent.op('sec.modsec.vendor.install', { name: vendor.name, url: vendor.url });
      job.log(`Installed ${result.ruleFiles} rule files (${result.rules} rules) into ${result.dir}`);
      job.progress(70, 'applying includes');
      stmts.updateVendor.run({ id: vendor.id, url: vendor.url, enabled: vendor.enabled });
      const applied = await modsec.applyVendors(null);
      job.log(applied.reload?.error ? `Apache reload failed: ${applied.reload.error}` : 'Apache reloaded');
      job.progress(100, 'done');
      return { ...result, applied };
    },
  };

  function policy() {
    return {
      verifiedIpLogin: Boolean(settings.get('security.policy.verified_ip_login')),
      passwordMaxAgeDays: Number(settings.get('security.policy.password_max_age_days')) || 0,
      require2faForRoot: Boolean(settings.get('security.2fa.required_for_root')),
      require2faForResellers: Boolean(settings.get('security.policy.require_2fa_for_resellers')),
      sessionTimeoutMinutes: Number(settings.get('security.policy.session_timeout_minutes')) || 0,
      disallowConcurrentSessions: Boolean(settings.get('security.policy.disallow_concurrent_sessions')),
      apiTokensRequire2fa: Boolean(settings.get('security.policy.api_tokens_require_2fa')),
    };
  }

  function passwordPolicy(password, context = 'account') {
    const fallback = Number(settings.get('security.min_password_strength')) || 0;
    const specific = PASSWORD_CONTEXTS.includes(context) ? settings.get(`security.password.strength.${context}`) : null;
    const minimum = specific == null ? fallback : Number(specific);
    const score = passwordStrength(password);
    return { score, minimum, ok: score >= minimum, context };
  }

  const externalAuth = {
    shape(row) {
      if (!row) return null;
      return { id: row.id, name: row.name, displayName: row.display_name, issuerUrl: row.issuer_url, clientId: row.client_id, hasClientSecret: Boolean(row.client_secret_enc), scopes: row.scopes, enabled: Boolean(row.enabled), discovery: json.parse(row.discovery_json, null), links: stmts.providerLinks.get(row.id).n, createdAt: row.created_at, updatedAt: row.updated_at };
    },
    list: () => stmts.providers.all().map(externalAuth.shape),
    get(name) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      return externalAuth.shape(row);
    },
    create(input, req) {
      if (stmts.providerByName.get(input.name)) throw conflict(`Provider "${input.name}" already exists`);
      stmts.insertProvider.run({ name: input.name, display_name: input.displayName, issuer_url: input.issuerUrl.replace(/\/+$/, ''), client_id: input.clientId, client_secret_enc: input.clientSecret ? crypto.encrypt(input.clientSecret) : null, scopes: input.scopes || 'openid email profile', enabled: input.enabled === false ? 0 : 1 });
      req?.audit?.({ action: 'security.external_auth.create', target: input.name, args: { issuerUrl: input.issuerUrl, clientId: input.clientId } });
      return externalAuth.get(input.name);
    },
    update(name, input, req) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      const issuer = input.issuerUrl ? input.issuerUrl.replace(/\/+$/, '') : row.issuer_url;
      stmts.updateProvider.run({
        id: row.id, display_name: input.displayName ?? row.display_name, issuer_url: issuer, client_id: input.clientId ?? row.client_id,
        client_secret_enc: input.clientSecret ? crypto.encrypt(input.clientSecret) : row.client_secret_enc, scopes: input.scopes ?? row.scopes,
        enabled: input.enabled == null ? row.enabled : input.enabled ? 1 : 0, discovery_json: issuer === row.issuer_url ? row.discovery_json : null,
      });
      req?.audit?.({ action: 'security.external_auth.update', target: name, args: input });
      return externalAuth.get(name);
    },
    remove(name, req) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      stmts.deleteProvider.run(row.id);
      req?.audit?.({ action: 'security.external_auth.delete', target: name });
      return { deleted: true };
    },
    async discover(name, req) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      const url = `${row.issuer_url}/.well-known/openid-configuration`;
      let doc;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        doc = await res.json();
      } catch (err) {
        throw badRequest(`OpenID discovery failed for ${url}: ${err.message}`);
      }
      const discovery = { issuer: doc.issuer, authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint, userinfoEndpoint: doc.userinfo_endpoint, jwksUri: doc.jwks_uri, scopesSupported: doc.scopes_supported || [], fetchedAt: new Date().toISOString() };
      if (!discovery.authorizationEndpoint || !discovery.tokenEndpoint) throw badRequest('The discovery document lacks authorization_endpoint or token_endpoint');
      db.prepare("UPDATE external_auth_providers SET discovery_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(discovery), row.id);
      req?.audit?.({ action: 'security.external_auth.discover', target: name });
      return externalAuth.get(name);
    },
    // Helpers for the auth category to wire a login/link flow:
    authorizationUrl(name, { state, nonce, redirectUri }) {
      const p = externalAuth.get(name);
      if (!p.enabled) throw badRequest(`Provider "${name}" is disabled`);
      if (!p.discovery?.authorizationEndpoint) throw badRequest(`Run discovery for "${name}" first`);
      const u = new URL(p.discovery.authorizationEndpoint);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: p.clientId, redirect_uri: redirectUri, scope: p.scopes, state, nonce })) if (v) u.searchParams.set(k, v);
      return u.toString();
    },
    async exchangeCode(name, { code, redirectUri }) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      const discovery = json.parse(row.discovery_json, null);
      if (!discovery?.tokenEndpoint) throw badRequest(`Run discovery for "${name}" first`);
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: row.client_id });
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
      if (row.client_secret_enc) headers.Authorization = `Basic ${Buffer.from(`${row.client_id}:${crypto.decrypt(row.client_secret_enc)}`).toString('base64')}`;
      const res = await fetch(discovery.tokenEndpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw badRequest(`Token exchange failed: HTTP ${res.status}`);
      const tokens = await res.json();
      let claims = null;
      if (tokens.id_token) { try { claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8')); } catch { claims = null; } }
      if (discovery.userinfoEndpoint && tokens.access_token) {
        const info = await fetch(discovery.userinfoEndpoint, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (info?.ok) claims = { ...(claims || {}), ...(await info.json()) };
      }
      return { claims, tokens: { tokenType: tokens.token_type, expiresIn: tokens.expires_in } };
    },
    findLinkedUser(name, subject) {
      const row = stmts.providerByName.get(name);
      return row ? stmts.linkFind.get(row.id, subject) || null : null;
    },
    link(name, { userId, subject, email }) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      stmts.linkInsert.run(row.id, userId, subject, email || null);
      return stmts.linkFind.get(row.id, subject);
    },
  };

  // Read-only scanner. Every probe is isolated so one failing check never hides
  // the rest; "fix" links point at the panel's own pages.
  const advisor = {
    last() {
      const row = stmts.lastRun.get();
      return row ? { id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, trigger: row.trigger, summary: json.parse(row.summary_json, {}), findings: json.parse(row.findings_json, []) } : null;
    },
    async scan(trigger = 'manual', req) {
      const findings = [];
      const add = (f) => findings.push({ grade: 'info', ...f });
      const probe = async (id, title, fn) => {
        try { await fn(); } catch (err) { add({ id, grade: 'info', title: `Could not check: ${title}`, detail: err.message }); }
      };
      await capabilities.ensureFresh();

      await probe('ssh', 'SSH configuration', async () => {
        if (!capabilities.has('sshd')) { add({ id: 'ssh.installed', grade: 'info', title: 'OpenSSH server is not installed', detail: 'No sshd binary was found, so SSH hardening checks were skipped.' }); return; }
        const cfg = await op('sec.sshd.get');
        const e = cfg.effective;
        const pw = (e.passwordauthentication || 'yes').toLowerCase();
        add(pw === 'yes'
          ? { id: 'ssh.password', grade: 'warning', title: 'SSH password authentication is enabled', detail: 'Attackers can brute-force passwords over SSH. Prefer key-based authentication and disable passwords once a key is authorized.', fix: { label: 'SSH Password Authorization Tweak', path: '/security-center/ssh-password-authorization-tweak' } }
          : { id: 'ssh.password', grade: 'ok', title: 'SSH password authentication is disabled' });
        const root = (e.permitrootlogin || 'yes').toLowerCase();
        add(root === 'yes'
          ? { id: 'ssh.root', grade: 'warning', title: 'Root may log in over SSH with a password', detail: `PermitRootLogin is "${root}". Set it to prohibit-password or no.`, fix: { label: 'SSH Password Authorization Tweak', path: '/security-center/ssh-password-authorization-tweak' } }
          : { id: 'ssh.root', grade: 'ok', title: `Root SSH login is restricted (PermitRootLogin ${root})` });
        if (e.port && e.port !== '22') add({ id: 'ssh.port', grade: 'ok', title: `SSH listens on a non-default port (${e.port})` });
      });

      await probe('2fa', 'two-factor authentication', async () => {
        const root = stmts.rootUser.get();
        const required = Boolean(settings.get('security.2fa.required_for_root'));
        if (root && !root.totp_enabled) add({ id: '2fa.root', grade: 'critical', title: 'The root panel user has no two-factor authentication', detail: 'A leaked root password gives full control of the server. Enroll an authenticator app.', fix: { label: 'Two-Factor Authentication', path: '/security-center/two-factor-authentication' } });
        else add({ id: '2fa.root', grade: 'ok', title: 'Root has two-factor authentication enabled' });
        if (!required) add({ id: '2fa.policy', grade: 'warning', title: 'Two-factor authentication is not required for root', detail: 'Enable the policy so it cannot be silently disabled.', fix: { label: 'Two-Factor Authentication', path: '/security-center/two-factor-authentication' } });
      });

      await probe('firewall', 'firewall', async () => {
        const detect = await op('sec.firewall.detect');
        if (!capabilities.has('firewall') || !detect.backend) add({ id: 'firewall.present', grade: 'critical', title: 'No supported firewall is installed', detail: 'Install iptables or nftables so the panel can block abusive addresses and restrict SMTP.', fix: { label: 'cPHulk Brute Force Protection', path: '/security-center/cphulk-brute-force-protection' } });
        else {
          add({ id: 'firewall.present', grade: 'ok', title: `Firewall available (${detect.backend})` });
          const smtpState = await op('sec.smtp_restrict.get');
          add(smtpState.enabled
            ? { id: 'smtp.restricted', grade: 'ok', title: 'Outbound SMTP is restricted to mail services' }
            : { id: 'smtp.restricted', grade: 'warning', title: 'SMTP restrictions are disabled', detail: 'Compromised scripts can send spam directly on port 25. Restrict outbound SMTP to root and the mail groups.', fix: { label: 'SMTP Restrictions', path: '/security-center/smtp-restrictions' } });
        }
      });

      await probe('cphulk', 'cPHulk', async () => {
        add(settings.get('security.cphulk.enabled')
          ? { id: 'cphulk.enabled', grade: 'ok', title: `cPHulk brute force protection is on (${settings.get('security.cphulk.max_failures_per_ip')} failures → ${settings.get('security.cphulk.lockout_minutes')} min block)` }
          : { id: 'cphulk.enabled', grade: 'warning', title: 'cPHulk brute force protection is disabled', detail: 'Repeated failed panel logins are not being blocked.', fix: { label: 'cPHulk Brute Force Protection', path: '/security-center/cphulk-brute-force-protection' } });
      });

      await probe('packages', 'outdated packages', async () => {
        const pkg = ctx.pkg;
        const fn = pkg && (pkg.outdated || pkg.listUpdates || pkg.updates);
        if (typeof fn !== 'function') { add({ id: 'pkg.updates', grade: 'info', title: 'Package update check unavailable', detail: 'The Software category is not loaded on this panel yet.' }); return; }
        const result = await fn.call(pkg);
        const count = Array.isArray(result) ? result.length : Number(result?.count ?? result?.total ?? 0);
        add(count > 0
          ? { id: 'pkg.updates', grade: 'warning', title: `${count} package update${count === 1 ? '' : 's'} available`, detail: 'Outdated packages may carry known vulnerabilities.', fix: { label: 'Update System Software', path: '/software/update-system-software' } }
          : { id: 'pkg.updates', grade: 'ok', title: 'All distribution packages are up to date' });
      });

      await probe('filesystem', 'filesystem permissions', async () => {
        const fsScan = await op('sec.scan.filesystem', { root: settings.get('basic.home_root') || '/home', limit: 25 });
        for (const f of fsScan.sensitive) if (!f.ok) add({ id: `fs.${f.path}`, grade: 'critical', title: `${f.path} is too permissive (${f.mode})`, detail: `Expected at most ${f.maxMode}.` });
        if (fsScan.worldWritable.length) add({ id: 'fs.world_writable', grade: 'warning', title: `${fsScan.worldWritable.length} world-writable director${fsScan.worldWritable.length === 1 ? 'y' : 'ies'} under ${fsScan.root}`, detail: fsScan.worldWritable.slice(0, 10).join(', ') });
        else if (fsScan.scanned) add({ id: 'fs.world_writable', grade: 'ok', title: `No world-writable directories found under ${fsScan.root} (depth 3)` });
      });

      await probe('settings', 'panel settings', async () => {
        const min = Number(settings.get('security.min_password_strength')) || 0;
        add(min < 50
          ? { id: 'password.strength', grade: 'warning', title: `Minimum password strength is low (${min})`, detail: 'Raise it to at least 65 to reject weak account and panel passwords.', fix: { label: 'Password Strength Configuration', path: '/security-center/password-strength-configuration' } }
          : { id: 'password.strength', grade: 'ok', title: `Minimum password strength is ${min}` });
        if (!config.tls) add({ id: 'panel.tls', grade: 'warning', title: 'The panel is served over plain HTTP', detail: 'Credentials and session cookies travel unencrypted. Configure WHM_TLS_CERT/WHM_TLS_KEY to serve on port 2087.' });
        else add({ id: 'panel.tls', grade: 'ok', title: 'The panel is served over HTTPS' });
        const fb = await op('sec.fork_bomb.get');
        add(fb.enabled ? { id: 'forkbomb', grade: 'ok', title: 'Shell fork bomb protection is enabled' } : { id: 'forkbomb', grade: 'info', title: 'Shell fork bomb protection is disabled', detail: 'Users with shell access can exhaust process and memory limits.', fix: { label: 'Shell Fork Bomb Protection', path: '/security-center/shell-fork-bomb-protection' } });
        const cc = await op('sec.compiler_access.get');
        if (cc.installed) add(cc.allowed ? { id: 'compilers', grade: 'info', title: 'Compilers are available to all users', detail: 'Exploit kits often need a compiler. Deny access unless accounts need it.', fix: { label: 'Compiler Access', path: '/security-center/compiler-access' } } : { id: 'compilers', grade: 'ok', title: 'Compilers are restricted to privileged users' });
        const shells = stmts.shellAccounts.get().n;
        if (shells > 0) add({ id: 'accounts.shell', grade: 'info', title: `${shells} hosting account${shells === 1 ? ' has' : 's have'} shell access` });
      });

      await probe('apache', 'web server hardening', async () => {
        if (!capabilities.has('apache')) return;
        const layout = await detectModsec(true);
        if (!layout.installed) add({ id: 'modsec.installed', grade: 'warning', title: 'ModSecurity is not installed', detail: 'A web application firewall blocks common injection and scanner traffic.', fix: { label: 'ModSecurity Configuration', path: '/security-center/modsecurity-configuration' } });
        else {
          const cfg = await op('sec.modsec.get_config');
          add(cfg.effective.SecRuleEngine === 'On' ? { id: 'modsec.engine', grade: 'ok', title: 'ModSecurity rule engine is on' } : { id: 'modsec.engine', grade: 'warning', title: `ModSecurity rule engine is ${cfg.effective.SecRuleEngine || 'Off'}`, fix: { label: 'ModSecurity Configuration', path: '/security-center/modsecurity-configuration' } });
          if (!stmts.vendors.all().some((v) => v.enabled)) add({ id: 'modsec.vendors', grade: 'info', title: 'No ModSecurity vendor rule set is enabled', fix: { label: 'ModSecurity Vendors', path: '/security-center/modsecurity-vendors' } });
        }
        const ud = await op('sec.userdir.get');
        if (ud.enabled) add({ id: 'userdir', grade: 'info', title: 'Apache mod_userdir (~user URLs) is enabled', detail: 'Sites served from ~user URLs share the main IP and bypass per-domain SSL.', fix: { label: 'Apache mod_userdir Tweak', path: '/security-center/apache-mod-userdir-tweak' } });
      });

      await probe('hostaccess', 'host access control', async () => {
        if (!stmts.hostRules.all().length) add({ id: 'hostaccess', grade: 'info', title: 'No host access rules are defined', detail: 'TCP wrappers can limit SSH and FTP to trusted networks.', fix: { label: 'Host Access Control', path: '/security-center/host-access-control' } });
      });

      const order = { critical: 0, warning: 1, info: 2, ok: 3 };
      findings.sort((a, b) => order[a.grade] - order[b.grade]);
      const summary = { critical: 0, warning: 0, info: 0, ok: 0 };
      for (const f of findings) summary[f.grade]++;
      const { lastInsertRowid } = stmts.insertRun.run(trigger, JSON.stringify(summary), JSON.stringify(findings));
      stmts.pruneRuns.run();
      req?.audit?.({ action: 'security.advisor.scan', args: summary });
      return { id: Number(lastInsertRowid), trigger, finishedAt: new Date().toISOString(), summary, findings };
    },
  };

  return {
    reloadApache,
    policy,
    passwordStrength: passwordPolicy,
    passwordContexts: PASSWORD_CONTEXTS,
    hostAccess, ssh, cphulk, firewall: firewallApi, smtp, compilers, traceroute, forkBomb, wheel, userdir, modsec, externalAuth, advisor,
  };
}
