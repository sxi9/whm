import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { json } from '../db/index.js';
import { SERVICE_REGISTRY } from '../db/seed.js';
import { notFound, forbidden, unprocessable, conflict, CapabilityError } from '../lib/errors.js';

// Server Configuration. Attached as ctx.serverConfig; other categories may call:
//   serverConfig.profile.summary()                 -> { name, label, hiddenCategories, services } (also in GET /api/system/status)
//   serverConfig.profile.allows(categorySlug)      -> false when the active profile hides a category
//   serverConfig.time.get()                        -> { now, timezone, ntp, ntpSynchronized, ntpService }
//   serverConfig.quota.status()                    -> quota tools + per-filesystem state (never throws CapabilityError)
//   serverConfig.quota.isEnabled(mountpoint?)      -> whether user quotas are active where account homes live
//   serverConfig.nodes.list()                      -> linked server nodes (tokens never included)
//   serverConfig.stats.settings()                  -> { generators, defaultGenerator, allowUserChoice }
// Lazily used when present: ctx.software.pkg.ensureInstalled (quota tools), ctx.software.update.status / panel.status
// (Update Preferences), ctx.serviceManager.configure (profile monitoring), ctx.contacts.notify (update summaries).

export const PROFILES = {
  standard: {
    label: 'Standard Node',
    description: 'Web, mail, DNS and database services on one server. Every category is shown.',
    services: null,
    hiddenCategories: [],
  },
  'dns-only': {
    label: 'DNS Node',
    description: 'Authoritative DNS only (BIND/PowerDNS cluster member). Accounts, mail, databases and web hosting are hidden.',
    services: ['named', 'sshd', 'cron', 'whm-agentd'],
    hiddenCategories: ['account-information', 'account-functions', 'multi-account-functions', 'transfers', 'packages', 'themes', 'email', 'database-services', 'cpanel', 'market', 'resellers', 'plugins'],
  },
  'mail-only': {
    label: 'Mail Node',
    description: 'Exim, Dovecot and SpamAssassin for remote accounts. DNS and database hosting are hidden.',
    services: ['exim', 'imap', 'spamd', 'sshd', 'cron', 'whm-agentd'],
    hiddenCategories: ['dns-functions', 'database-services', 'cpanel', 'market', 'themes', 'transfers', 'packages', 'resellers', 'plugins'],
  },
  'database-only': {
    label: 'Database Node',
    description: 'MySQL/MariaDB and PostgreSQL for remote accounts. DNS, mail and web hosting are hidden.',
    services: ['mysql', 'postgresql', 'sshd', 'cron', 'whm-agentd'],
    hiddenCategories: ['dns-functions', 'email', 'cpanel', 'market', 'themes', 'transfers', 'packages', 'resellers', 'plugins'],
  },
};
export const PROFILE_NAMES = Object.keys(PROFILES);
export const GENERATORS = ['awstats', 'webalizer', 'analog'];
export const UPDATE_TIERS = ['stable', 'release', 'current', 'edge'];
export const NODE_ROLES = ['dns', 'mail', 'database', 'web', 'backup'];

const STATS_JOB = 'server_config.stats.generate';
const STATS_SCHEDULE = 'stats-generation';
const STATS_CRON = '17 2 * * *';
const QUOTA_JOB = 'server_config.quota.enable';
const UPDATE_JOB = 'server_config.update.check';
const UPDATE_SCHEDULE = 'update-preferences-check';
const UPDATE_CRON = '23 4 * * 1';
const TERMINAL_SWEEP_MS = 60_000;

const CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server-configuration.marketplace.json');
const TIMEZONES = new Set(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []);
TIMEZONES.add('UTC');
TIMEZONES.add('Etc/UTC');

export const isValidTimezone = (tz) => TIMEZONES.has(tz);

// Decodes the terminal's byte stream into text without splitting multi-byte
// characters across two SSE events.
export function createTextDecoder() {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return (buf, final = false) => decoder.decode(buf, { stream: !final });
}

export function remoteStatusRequest({ scheme, hostname, port, token, verifyTls, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const mod = scheme === 'http' ? http : https;
    const req = mod.request({ method: 'GET', hostname, port, path: '/api/system/status', headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'whm-panel/link-server-nodes' }, timeout: timeoutMs, ...(scheme === 'https' ? { rejectUnauthorized: Boolean(verifyTls) } : {}) }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 1024 * 1024) body += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`timed out after ${timeoutMs / 1000}s`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

export function createServerConfigService(ctx) {
  const { db, agent, capabilities, settings, crypto: cryptoSvc, logger } = ctx;
  const audit = (req, entry) => req?.audit?.(entry);
  const S = (key, fallback) => settings.get(key, fallback);

  // --- Server Profile ------------------------------------------------------
  const serviceDefaults = Object.fromEntries(SERVICE_REGISTRY.map((s) => [s.name, (s.monitored ?? 1) === 1]));
  const profile = {
    current() { const name = S('profile.name', 'standard'); return PROFILES[name] ? name : 'standard'; },
    summary() {
      const name = profile.current();
      const def = PROFILES[name];
      return { name, label: def.label, hiddenCategories: def.hiddenCategories, services: def.services };
    },
    allows(categorySlug) { return !PROFILES[profile.current()].hiddenCategories.includes(categorySlug); },
    async get() {
      const name = profile.current();
      const rows = db.prepare('SELECT name, display_name, monitored FROM services ORDER BY position').all();
      return {
        current: name,
        profiles: PROFILE_NAMES.map((n) => ({ name: n, ...PROFILES[n], monitoredServices: PROFILES[n].services ?? Object.keys(serviceDefaults).filter((k) => serviceDefaults[k]) })),
        services: rows.map((r) => ({ name: r.name, displayName: r.display_name, monitored: Boolean(r.monitored) })),
        changedAt: S('profile.changed_at', null),
      };
    },
    async set(name, req) {
      const def = PROFILES[name];
      if (!def) throw unprocessable('Unknown server profile', { name: [`Must be one of ${PROFILE_NAMES.join(', ')}`] });
      const previous = profile.current();
      const rows = db.prepare('SELECT name, monitored FROM services').all();
      const changes = [];
      const tx = db.transaction(() => {
        for (const row of rows) {
          const monitored = def.services ? def.services.includes(row.name) : (serviceDefaults[row.name] ?? true);
          if (Boolean(row.monitored) !== monitored) {
            if (ctx.serviceManager?.configure) ctx.serviceManager.configure(row.name, { monitored });
            else db.prepare('UPDATE services SET monitored = ? WHERE name = ?').run(monitored ? 1 : 0, row.name);
            changes.push({ service: row.name, monitored });
          }
        }
        settings.setMany({ 'profile.name': name, 'profile.changed_at': new Date().toISOString() });
      });
      tx();
      audit(req, { action: 'server_config.profile.set', target: name, args: { previous, changes } });
      return { ...(await profile.get()), changes, previous };
    },
  };

  // --- Configure cPanel Analytics --------------------------------------------
  const analytics = {
    get() {
      return { enabled: Boolean(S('analytics.enabled', false)), participantId: S('analytics.participant_id', null), shareUsage: Boolean(S('analytics.share_usage', true)), shareErrors: Boolean(S('analytics.share_errors', false)), updatedAt: S('analytics.updated_at', null), collected: ['Pages opened and features used (by function key)', 'Panel version, OS family and the services installed', 'Anonymous error signatures when "share errors" is on'], notCollected: ['Hostnames, IP addresses, account or domain names', 'Settings values, logs, passwords or tokens'] };
    },
    update({ enabled, shareUsage, shareErrors }, req) {
      const values = { 'analytics.updated_at': new Date().toISOString() };
      if (enabled !== undefined) {
        values['analytics.enabled'] = enabled;
        if (enabled && !S('analytics.participant_id', null)) values['analytics.participant_id'] = crypto.randomUUID();
      }
      if (shareUsage !== undefined) values['analytics.share_usage'] = shareUsage;
      if (shareErrors !== undefined) values['analytics.share_errors'] = shareErrors;
      settings.setMany(values);
      audit(req, { action: 'server_config.analytics.update', args: { enabled, shareUsage, shareErrors } });
      return analytics.get();
    },
    rotateId(req) {
      settings.setMany({ 'analytics.participant_id': crypto.randomUUID(), 'analytics.updated_at': new Date().toISOString() });
      audit(req, { action: 'server_config.analytics.rotate_id' });
      return analytics.get();
    },
  };

  // --- Server Time -----------------------------------------------------------
  const NTP_UNITS = ['systemd-timesyncd', 'chronyd', 'chrony', 'ntpd', 'ntp', 'ntpsec'];
  const time = {
    async get() {
      await capabilities.ensureFresh();
      const state = await agent.op('sys.time.get');
      let ntpService = null;
      try {
        const { unit } = await agent.op('svc.resolve', { candidates: NTP_UNITS });
        if (unit) { const st = await agent.op('svc.status', { unit }); ntpService = { unit, active: st.active, state: st.state, enabled: st.enabled }; }
      } catch (err) { logger.warn({ err }, 'ntp unit lookup failed'); }
      return { ...state, ntpService, timedatectl: capabilities.has('timedatectl'), timezones: [...TIMEZONES].sort(), serverEpochMs: Date.now() };
    },
    async set({ timezone, ntp }, req) {
      if (timezone !== undefined && !isValidTimezone(timezone)) throw unprocessable('Unknown timezone', { timezone: ['Must be an IANA timezone such as Europe/London'] });
      await capabilities.ensureFresh();
      capabilities.require('timedatectl', 'timedatectl (systemd) is required to change the timezone or NTP synchronisation');
      const result = await agent.op('sys.time.set', { ...(timezone !== undefined ? { timezone } : {}), ...(ntp !== undefined ? { ntp } : {}) }, { req });
      audit(req, { action: 'server_config.time.set', args: { timezone, ntp } });
      return { ...result, ...(await time.get()) };
    },
  };

  // --- Initial Quota Setup -----------------------------------------------------
  const quota = {
    async status() {
      await capabilities.ensureFresh();
      const homeRoot = S('basic.home_root', '/home') || '/home';
      const state = await agent.op('quota.status');
      const holding = (p) => [...state.filesystems].filter((f) => p === f.mountpoint || p.startsWith(f.mountpoint.endsWith('/') ? f.mountpoint : `${f.mountpoint}/`)).sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0] || null;
      const homeFs = holding(homeRoot);
      const filesystems = state.filesystems.map((f) => ({ ...f, holdsHomes: f.mountpoint === homeFs?.mountpoint }));
      const toolsInstalled = capabilities.has('quota') && Boolean(state.tools.quotacheck && state.tools.quotaon);
      const lastJob = ctx.jobs.list({ type: QUOTA_JOB, limit: 1 })[0] ?? null;
      return {
        toolsInstalled, tools: state.tools, fstabPath: state.fstabPath, fstabPresent: state.fstabPresent, homeRoot, homeFilesystem: homeFs?.mountpoint ?? null,
        enabled: Boolean(homeFs && (homeFs.active.user === true || (homeFs.active.user == null && (homeFs.userQuotaMounted || homeFs.ext4QuotaFeature)))),
        filesystems, lastJob, installPackages: ['quota'], pkgAvailable: Boolean(ctx.software?.pkg?.ensureInstalled),
      };
    },
    async isEnabled(mountpoint) {
      const st = await quota.status();
      if (!mountpoint) return st.enabled;
      const fsEntry = st.filesystems.find((f) => f.mountpoint === mountpoint);
      return Boolean(fsEntry && (fsEntry.active.user === true || fsEntry.userQuotaMounted));
    },
    async enable({ mountpoint, groupQuota = true, updateFstab = false }, user, req) {
      await capabilities.ensureFresh();
      capabilities.require('quota', 'The quota tools (quotacheck, quotaon, repquota) are not installed. Install the "quota" package first.');
      const job = ctx.jobs.enqueue(QUOTA_JOB, { mountpoint, groupQuota, updateFstab }, { userId: user?.id ?? null });
      audit(req, { action: 'server_config.quota.enable', target: mountpoint, args: { groupQuota, updateFstab, jobId: job.id } });
      return { job };
    },
    async enableJob(job) {
      const { mountpoint, groupQuota, updateFstab } = job.params;
      job.progress(5, `preparing ${mountpoint}`);
      let fstab = null;
      if (updateFstab) {
        fstab = await job.agent.op('quota.fstab.enable', { mountpoint, groupQuota });
        job.log(fstab.changed ? `fstab: ${fstab.previousLine}  ->  ${fstab.line} (backup ${fstab.backup})` : 'fstab already has the quota options');
      }
      job.progress(20, 'quotacheck (this scans the whole filesystem)');
      const result = await job.agent.op('quota.enable', { mountpoint, groupQuota });
      for (const s of result.steps || []) job.log(`${s.step}: ${s.ok ? 'ok' : 'failed'} - ${s.detail}`, s.ok ? 'info' : 'warn');
      if (!result.enabled) job.log(result.reason === 'fstab_option_required' ? `Add the quota mount options to /etc/fstab: ${result.fstab}` : result.reason === 'reboot_required' ? 'Reboot the server so XFS picks up the quota mount options' : `Quotas are not active (${result.reason})`, 'warn');
      else job.log(`User quotas are active on ${mountpoint}`);
      job.progress(100, result.enabled ? 'quotas enabled' : 'manual step required');
      return { ...result, fstab };
    },
    async disable({ mountpoint }, req) {
      await capabilities.ensureFresh();
      capabilities.require('quota', 'The quota tools are not installed');
      const result = await agent.op('quota.disable', { mountpoint }, { req });
      audit(req, { action: 'server_config.quota.disable', target: mountpoint });
      return result;
    },
    async installTools(user, req) {
      if (!ctx.software?.pkg?.ensureInstalled) throw unprocessable('Package installation is not available; install the "quota" package manually');
      const result = await ctx.software.pkg.ensureInstalled(['quota'], { user, req });
      audit(req, { action: 'server_config.quota.install_tools', args: { missing: result.missing, jobId: result.job?.id ?? null } });
      return result;
    },
  };

  // --- Link Server Nodes -------------------------------------------------------
  const nodeStmts = {
    all: db.prepare('SELECT * FROM server_nodes ORDER BY name'),
    byId: db.prepare('SELECT * FROM server_nodes WHERE id = ?'),
    byName: db.prepare('SELECT id FROM server_nodes WHERE name = ?'),
    insert: db.prepare(`INSERT INTO server_nodes (name, hostname, port, scheme, username, api_token_enc, verify_tls, roles_json, enabled)
      VALUES (@name, @hostname, @port, @scheme, @username, @api_token_enc, @verify_tls, @roles_json, @enabled)`),
    update: db.prepare(`UPDATE server_nodes SET name = @name, hostname = @hostname, port = @port, scheme = @scheme, username = @username, api_token_enc = @api_token_enc, verify_tls = @verify_tls,
      roles_json = @roles_json, enabled = @enabled, updated_at = datetime('now') WHERE id = @id`),
    check: db.prepare(`UPDATE server_nodes SET status = @status, last_checked_at = datetime('now'), last_error = @last_error, remote_json = @remote_json WHERE id = @id`),
    remove: db.prepare('DELETE FROM server_nodes WHERE id = ?'),
  };
  const shapeNode = (row) => ({
    id: row.id, name: row.name, hostname: row.hostname, port: row.port, scheme: row.scheme, username: row.username, hasToken: Boolean(row.api_token_enc), verifyTls: Boolean(row.verify_tls),
    roles: json.parse(row.roles_json, []), enabled: Boolean(row.enabled), status: row.status, lastCheckedAt: row.last_checked_at, lastError: row.last_error, remote: json.parse(row.remote_json, null), createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const nodes = {
    list() { return nodeStmts.all.all().map(shapeNode); },
    get(id) { const row = nodeStmts.byId.get(id); if (!row) throw notFound('Linked server node'); return row; },
    create(input, req) {
      if (nodeStmts.byName.get(input.name)) throw conflict(`A node named "${input.name}" already exists`);
      const { lastInsertRowid } = nodeStmts.insert.run({ name: input.name, hostname: input.hostname, port: input.port, scheme: input.scheme, username: input.username, api_token_enc: cryptoSvc.encrypt(input.token), verify_tls: input.verifyTls ? 1 : 0, roles_json: JSON.stringify(input.roles), enabled: input.enabled ? 1 : 0 });
      audit(req, { action: 'server_config.nodes.create', target: input.name, args: { hostname: input.hostname, port: input.port, scheme: input.scheme, roles: input.roles } });
      return shapeNode(nodeStmts.byId.get(lastInsertRowid));
    },
    update(id, input, req) {
      const row = nodes.get(id);
      if (input.name && input.name !== row.name && nodeStmts.byName.get(input.name)) throw conflict(`A node named "${input.name}" already exists`);
      nodeStmts.update.run({
        id, name: input.name ?? row.name, hostname: input.hostname ?? row.hostname, port: input.port ?? row.port, scheme: input.scheme ?? row.scheme, username: input.username ?? row.username,
        api_token_enc: input.token ? cryptoSvc.encrypt(input.token) : row.api_token_enc, verify_tls: (input.verifyTls ?? Boolean(row.verify_tls)) ? 1 : 0,
        roles_json: JSON.stringify(input.roles ?? json.parse(row.roles_json, [])), enabled: (input.enabled ?? Boolean(row.enabled)) ? 1 : 0,
      });
      audit(req, { action: 'server_config.nodes.update', target: String(id), args: { ...input, token: input.token ? '[rotated]' : undefined } });
      return shapeNode(nodeStmts.byId.get(id));
    },
    remove(id, req) {
      const row = nodes.get(id);
      nodeStmts.remove.run(id);
      audit(req, { action: 'server_config.nodes.remove', target: row.name });
      return { id, removed: true };
    },
    async test(id, req) {
      const row = nodes.get(id);
      if (!row.api_token_enc) throw unprocessable('This node has no API token; edit it and add one first');
      const started = Date.now();
      let outcome;
      try {
        const token = cryptoSvc.decrypt(row.api_token_enc);
        const res = await remoteStatusRequest({ scheme: row.scheme, hostname: row.hostname, port: row.port, token, verifyTls: Boolean(row.verify_tls) });
        if (res.status === 200 && res.body?.data) {
          const d = res.body.data;
          outcome = { ok: true, remote: { hostname: d.hostname ?? null, version: d.panel?.version ?? null, mode: d.panel?.mode ?? null, profile: d.profile?.name ?? null, os: d.server?.os?.name ?? null, capabilities: d.capabilities ? Object.keys(d.capabilities).filter((k) => d.capabilities[k]) : [], accounts: d.counts?.accounts ?? null } };
        } else if (res.status === 401 || res.status === 403) {
          outcome = { ok: false, error: `the remote panel rejected the token (${res.status}${res.body?.error?.message ? `: ${res.body.error.message}` : ''})` };
        } else {
          outcome = { ok: false, error: `unexpected response ${res.status}${res.body?.error?.message ? `: ${res.body.error.message}` : ''}` };
        }
      } catch (err) {
        outcome = { ok: false, error: err.code === 'ETIMEDOUT' ? err.message : err.code === 'ECONNREFUSED' ? `connection refused on ${row.hostname}:${row.port}` : /certificate|self[- ]signed|CERT_/i.test(err.message) ? `TLS verification failed: ${err.message} (disable "Verify TLS certificate" for a self-signed panel)` : err.message };
      }
      nodeStmts.check.run({ id, status: outcome.ok ? 'ok' : 'error', last_error: outcome.ok ? null : outcome.error, remote_json: outcome.ok ? JSON.stringify(outcome.remote) : row.remote_json });
      audit(req, { action: 'server_config.nodes.test', target: row.name, args: { ok: outcome.ok, error: outcome.error ?? null, ms: Date.now() - started } });
      return { ...shapeNode(nodeStmts.byId.get(id)), test: { ...outcome, ms: Date.now() - started } };
    },
  };

  // --- Statistics Software Configuration -----------------------------------
  const stats = {
    settings() {
      const generators = { awstats: true, webalizer: false, analog: false, ...(S('stats.generators', {}) || {}) };
      return { generators, defaultGenerator: S('stats.default_generator', 'awstats'), allowUserChoice: Boolean(S('stats.allow_user_choice', true)), includeSuspended: Boolean(S('stats.include_suspended', false)) };
    },
    schedule() {
      const row = ctx.scheduler.list().find((r) => r.name === STATS_SCHEDULE) || null;
      return row ? { name: row.name, cron: row.cron, enabled: Boolean(row.enabled), lastRunAt: row.last_run_at, nextRunAt: row.next_run_at } : null;
    },
    async detect() {
      try { return await agent.op('stats.detect'); } catch (err) { logger.warn({ err }, 'stats.detect failed'); return { domlogsRoot: null, generators: {}, error: err.message }; }
    },
    async get() {
      const detect = await stats.detect();
      const domains = db.prepare('SELECT COUNT(*) AS n FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE a.suspended = 0').get().n;
      return { ...stats.settings(), detect, schedule: stats.schedule(), domains, lastRun: S('stats.last_run', null), lastJob: ctx.jobs.list({ type: STATS_JOB, limit: 1 })[0] ?? null, pkgAvailable: Boolean(ctx.software?.pkg?.ensureInstalled) };
    },
    alignSchedule() {
      const enabled = Object.values(stats.settings().generators).some(Boolean);
      const row = stats.schedule();
      if (row && row.enabled !== enabled) ctx.scheduler.update(STATS_SCHEDULE, { enabled });
    },
    async update(body, req) {
      const current = stats.settings();
      const values = {};
      if (body.generators) values['stats.generators'] = { ...current.generators, ...body.generators };
      if (body.defaultGenerator !== undefined) values['stats.default_generator'] = body.defaultGenerator;
      if (body.allowUserChoice !== undefined) values['stats.allow_user_choice'] = body.allowUserChoice;
      if (body.includeSuspended !== undefined) values['stats.include_suspended'] = body.includeSuspended;
      const next = { ...current, ...(values['stats.generators'] ? { generators: values['stats.generators'] } : {}), ...(body.defaultGenerator !== undefined ? { defaultGenerator: body.defaultGenerator } : {}) };
      if (Object.values(next.generators).some(Boolean) && !next.generators[next.defaultGenerator]) throw unprocessable('The default generator must be one of the enabled generators', { defaultGenerator: [`${next.defaultGenerator} is disabled`] });
      settings.setMany(values);
      if (body.cron !== undefined) ctx.scheduler.update(STATS_SCHEDULE, { cron: body.cron });
      ctx.scheduler.update(STATS_SCHEDULE, { enabled: body.enabled ?? Object.values(next.generators).some(Boolean) });
      audit(req, { action: 'server_config.stats.update', args: body });
      return stats.get();
    },
    async run({ generator, domain } = {}, user, req) {
      const detect = await stats.detect();
      const enabled = GENERATORS.filter((g) => stats.settings().generators[g]);
      const wanted = generator ? [generator] : enabled;
      const installed = wanted.filter((g) => detect.generators?.[g]?.installed);
      if (!installed.length) throw new CapabilityError('stats', `None of the selected statistics generators (${wanted.join(', ') || 'none enabled'}) is installed. Install awstats, webalizer or analog first.`);
      const job = ctx.jobs.enqueue(STATS_JOB, { generators: installed, domain: domain ?? null }, { userId: user?.id ?? null });
      audit(req, { action: 'server_config.stats.run', args: { generators: installed, domain: domain ?? null, jobId: job.id } });
      return { job, generators: installed, skipped: wanted.filter((g) => !installed.includes(g)) };
    },
    async generateJob(job) {
      const cfg = stats.settings();
      const detect = await job.agent.op('stats.detect');
      const generators = (job.params.generators?.length ? job.params.generators : GENERATORS.filter((g) => cfg.generators[g])).filter((g) => detect.generators?.[g]?.installed);
      if (!generators.length) { job.log('no enabled statistics generator is installed; nothing to do', 'warn'); return { domains: 0, generated: 0, skipped: 0, failed: 0 }; }
      const rows = db.prepare(`SELECT a.username, a.home_dir, d.domain FROM account_domains d JOIN accounts a ON a.id = d.account_id
        WHERE (@includeSuspended = 1 OR a.suspended = 0) AND (@domain IS NULL OR d.domain = @domain) AND d.type IN ('main', 'addon', 'sub') ORDER BY a.username, d.domain`).all({ includeSuspended: cfg.includeSuspended ? 1 : 0, domain: job.params.domain ?? null });
      const summary = { domains: rows.length, generators, generated: 0, skipped: 0, failed: 0, failures: [] };
      let i = 0;
      for (const row of rows) {
        for (const generator of generators) {
          try {
            const r = await job.agent.op('stats.generate', { generator, domain: row.domain, username: row.username, homeDir: row.home_dir || `${S('basic.home_root', '/home')}/${row.username}` });
            if (r.skipped) { summary.skipped++; job.log(`${generator} ${row.domain}: skipped (${r.reason === 'no_log' ? 'no access log yet' : r.reason})`); } else { summary.generated++; job.log(`${generator} ${row.domain}: ok -> ${r.outputDir}`); }
          } catch (err) {
            summary.failed++;
            if (summary.failures.length < 50) summary.failures.push({ generator, domain: row.domain, error: err.message });
            job.log(`${generator} ${row.domain}: ${err.message}`, 'error');
          }
        }
        job.progress(Math.round((++i / Math.max(1, rows.length)) * 95), `${i}/${rows.length} domains`);
      }
      settings.set('stats.last_run', { at: new Date().toISOString(), ...summary, failures: undefined });
      job.progress(100, 'finished');
      return summary;
    },
  };

  // --- Terminal ----------------------------------------------------------------
  const terminalSessions = new Map();
  let terminalSweeper = null;
  const terminal = {
    idleMs: () => Math.max(1, Number(S('terminal.idle_minutes', 15)) || 15) * 60_000,
    maxSessions: () => Math.max(1, Number(S('terminal.max_sessions', 3)) || 3),
    shape(s) { return { id: s.id, pid: s.pid, shell: s.shell, user: s.user.username, startedAt: new Date(s.startedAt).toISOString(), lastActivity: new Date(s.lastActivity).toISOString(), idleMinutes: terminal.idleMs() / 60_000, viewers: s.viewers }; },
    assertRoot(user) { if (user?.role !== 'root') throw forbidden('The terminal is available to the root administrator only'); },
    owned(id, user) {
      terminal.assertRoot(user);
      const s = terminalSessions.get(id);
      if (!s) throw notFound('Terminal session');
      if (s.user.id !== user.id) throw forbidden('This terminal session belongs to another administrator');
      return s;
    },
    list(user) { terminal.assertRoot(user); return { sessions: [...terminalSessions.values()].filter((s) => s.user.id === user.id).map(terminal.shape), idleMinutes: terminal.idleMs() / 60_000, maxSessions: terminal.maxSessions(), installed: capabilities.has('terminal') }; },
    async open({ shell = '/bin/bash', cols = 120, rows = 32 } = {}, req) {
      terminal.assertRoot(req.user);
      await capabilities.ensureFresh();
      capabilities.require('terminal', 'The "script" utility (package util-linux / bsdutils) is required for the in-browser terminal');
      const mine = [...terminalSessions.values()].filter((s) => s.user.id === req.user.id);
      if (mine.length >= terminal.maxSessions()) throw unprocessable(`At most ${terminal.maxSessions()} terminal sessions may be open at once; close one first`);
      const idleMinutes = Math.min(240, Math.max(1, Math.round(terminal.idleMs() / 60_000)));
      const opened = await agent.op('terminal.open', { shell, cols, rows, idleMinutes }, { req });
      const s = { id: opened.id, pid: opened.pid, shell, user: { id: req.user.id, username: req.user.username, role: req.user.role }, ip: req.ip ?? null, startedAt: Date.now(), lastActivity: Date.now(), offset: 0, viewers: 0 };
      terminalSessions.set(s.id, s);
      if (!terminalSweeper) { terminalSweeper = setInterval(() => terminal.sweep().catch((err) => logger.warn({ err }, 'terminal sweep failed')), TERMINAL_SWEEP_MS); terminalSweeper.unref(); }
      audit(req, { action: 'server_config.terminal.open', target: s.id, args: { shell, pid: opened.pid } });
      return terminal.shape(s);
    },
    async write(id, data, req) {
      const s = terminal.owned(id, req.user);
      s.lastActivity = Date.now();
      try {
        return await agent.op('terminal.write', { id, data });
      } catch (err) {
        if (err.code === 'not_found' || err.code === 'exited') { await terminal.forget(s, err.code === 'exited' ? 'exited' : 'expired'); throw notFound('Terminal session'); }
        throw err;
      }
    },
    async forget(s, reason, req) {
      terminalSessions.delete(s.id);
      try { await agent.op('terminal.close', { id: s.id }); } catch (err) { logger.debug({ err, id: s.id }, 'terminal close after end'); }
      const entry = { action: 'server_config.terminal.close', target: s.id, args: { reason, pid: s.pid, durationSeconds: Math.round((Date.now() - s.startedAt) / 1000) } };
      if (req) audit(req, entry); else ctx.auditRecord?.({ user: s.user, ip: s.ip }, entry);
    },
    async close(id, req) {
      const s = terminal.owned(id, req.user);
      await terminal.forget(s, 'closed', req);
      return { id, closed: true };
    },
    async sweep(now = Date.now()) {
      const expired = [];
      for (const s of [...terminalSessions.values()]) {
        if (now - s.lastActivity > terminal.idleMs()) { expired.push(s.id); await terminal.forget(s, 'idle_timeout'); }
      }
      return expired;
    },
    // Server-sent events: polls the agent for new output while the browser is
    // attached. Several tabs may watch one session; input goes through write().
    stream(id, req, res, { pollMs = 120, idlePollMs = 400 } = {}) {
      const s = terminal.owned(id, req.user);
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      const decode = createTextDecoder();
      let since = Math.max(0, s.offset - 64 * 1024);
      let closed = false;
      let timer = null;
      s.viewers++;
      send({ type: 'open', session: terminal.shape(s) });
      const finish = async (event) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        clearInterval(heartbeat);
        s.viewers = Math.max(0, s.viewers - 1);
        if (event) send(event);
        res.end();
      };
      const poll = async () => {
        if (closed) return;
        let r;
        try {
          r = await agent.op('terminal.read', { id, since });
        } catch (err) {
          if (closed) return;
          if (err.code === 'not_found') { await terminal.forget(s, 'expired'); return finish({ type: 'exit', reason: 'expired', message: 'The session expired or was closed' }); }
          return finish({ type: 'error', message: err.message });
        }
        if (closed) return;
        const buf = Buffer.from(r.data, 'base64');
        if (r.truncated && since > 0) send({ type: 'notice', message: 'some output was dropped from the scrollback' });
        if (buf.length) { since = r.offset; s.offset = r.offset; const text = decode(buf, r.exited); if (text) send({ type: 'output', data: text }); }
        if (r.exited) { await terminal.forget(s, 'exited'); return finish({ type: 'exit', code: r.exitCode, signal: r.signal }); }
        timer = setTimeout(poll, buf.length ? pollMs : idlePollMs);
        timer.unref?.();
      };
      const heartbeat = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15_000);
      heartbeat.unref?.();
      req.on('close', () => finish());
      poll();
    },
    sessionsForTest: () => terminalSessions,
  };

  // --- Update Preferences --------------------------------------------------------
  const updates = {
    schedule() {
      const row = ctx.scheduler.list().find((r) => r.name === UPDATE_SCHEDULE) || null;
      return row ? { name: row.name, cron: row.cron, enabled: Boolean(row.enabled), lastRunAt: row.last_run_at, nextRunAt: row.next_run_at } : null;
    },
    settings() {
      return { tier: S('updates.tier', 'stable'), auto: Boolean(S('updates.auto', true)), autoOs: Boolean(S('software.updates.auto_os', false)), notifyContact: Boolean(S('updates.notify_contact', true)) };
    },
    async get() {
      let panel = null; let os = null;
      try { panel = ctx.software?.panel?.status?.() ?? null; } catch (err) { logger.warn({ err }, 'panel update status failed'); }
      try { os = ctx.software?.update?.status ? await ctx.software.update.status({ cached: true }) : null; } catch (err) { os = err instanceof CapabilityError ? { unavailable: true, reason: err.message } : { unavailable: true, reason: err.message }; }
      const osSchedule = ctx.scheduler.list().find((r) => r.name === 'os-update-check') || null;
      return { ...updates.settings(), tiers: UPDATE_TIERS.map((t) => ({ value: t, label: { stable: 'Stable', release: 'Release', current: 'Current', edge: 'Edge (development builds)' }[t], description: { stable: 'Well-tested releases only; recommended for production.', release: 'Latest release as soon as it ships.', current: 'Release candidates ahead of general availability.', edge: 'Nightly development builds; expect breakage.' }[t] })), schedule: updates.schedule(), osSchedule: osSchedule ? { cron: osSchedule.cron, enabled: Boolean(osSchedule.enabled), lastRunAt: osSchedule.last_run_at } : null, panel, os, lastCheck: S('updates.last_check', null), softwareAvailable: Boolean(ctx.software) };
    },
    async update(body, req) {
      const values = {};
      if (body.tier !== undefined) values['updates.tier'] = body.tier;
      if (body.auto !== undefined) values['updates.auto'] = body.auto;
      if (body.notifyContact !== undefined) values['updates.notify_contact'] = body.notifyContact;
      if (body.autoOs !== undefined) values['software.updates.auto_os'] = body.autoOs;
      settings.setMany(values);
      if (body.cron !== undefined || body.scheduleEnabled !== undefined) ctx.scheduler.update(UPDATE_SCHEDULE, { ...(body.cron !== undefined ? { cron: body.cron } : {}), ...(body.scheduleEnabled !== undefined ? { enabled: body.scheduleEnabled } : {}) });
      audit(req, { action: 'server_config.updates.set', args: body });
      return updates.get();
    },
    check(user, req) {
      const job = ctx.jobs.enqueue(UPDATE_JOB, {}, { userId: user?.id ?? null });
      audit(req, { action: 'server_config.updates.check', args: { jobId: job.id } });
      return { job };
    },
    async checkJob(job) {
      const summary = { at: new Date().toISOString(), tier: S('updates.tier', 'stable'), panel: null, os: null };
      job.progress(10, 'checking the panel release feed');
      try {
        if (ctx.software?.panel?.check && S('software.update_url', '')) { const p = await ctx.software.panel.check(); summary.panel = { current: p.currentVersion, latest: p.latest?.version ?? null, updateAvailable: p.updateAvailable }; job.log(`panel ${p.currentVersion}: ${p.updateAvailable ? `update ${p.latest.version} available` : 'up to date'}`); } else job.log('no panel update URL configured; skipping the release feed');
      } catch (err) { job.log(`panel check failed: ${err.message}`, 'warn'); }
      job.progress(50, 'checking operating system packages');
      try {
        if (ctx.software?.update?.status) { const os = await ctx.software.update.status(); summary.os = { manager: os.manager, count: os.count, security: os.security, rebootRequired: os.rebootRequired }; job.log(`${os.count} package update(s) pending (${os.security} security)${os.rebootRequired ? '; reboot required' : ''}`); } else job.log('software category not available; skipping OS packages');
      } catch (err) { job.log(`OS update check skipped: ${err.message}`, 'warn'); }
      settings.set('updates.last_check', summary);
      if (S('updates.notify_contact', true) && (summary.panel?.updateAvailable || summary.os?.security > 0)) {
        try { await ctx.contacts?.notify?.('updates.available', summary); } catch (err) { job.log(`contact notification failed: ${err.message}`, 'warn'); }
      }
      job.progress(100, 'finished');
      return summary;
    },
  };

  // --- WHM Marketplace ------------------------------------------------------------
  let catalogCache = null;
  const marketplace = {
    catalog() {
      if (!catalogCache) catalogCache = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
      return catalogCache;
    },
    async list({ q, category } = {}) {
      const cat = marketplace.catalog();
      const snapshot = await capabilities.ensureFresh();
      const binaries = [...new Set(cat.items.flatMap((i) => i.binaries || []))];
      let present = {};
      if (binaries.length) { try { present = await agent.op('sys.binaries', { names: binaries }); } catch (err) { logger.warn({ err }, 'marketplace binary detection failed'); } }
      let pkgManager = null;
      try { pkgManager = (await ctx.software?.pkg?.detect?.())?.manager ?? null; } catch { pkgManager = null; }
      const items = cat.items.map((item) => {
        const viaCap = item.capability ? Boolean(snapshot.capabilities[item.capability]?.installed) : null;
        const viaBin = item.binaries?.length ? item.binaries.some((b) => present[b]) : null;
        const installed = viaCap === true || viaBin === true ? true : viaCap === null && viaBin === null ? null : false;
        const family = pkgManager === 'apt' ? 'apt' : pkgManager ? 'dnf' : null;
        return { ...item, installed, packagesForHost: family ? item.packages?.[family] ?? [] : [], installPath: '/software/install-distro-packages' };
      }).filter((i) => (!category || i.category === category) && (!q || `${i.name} ${i.description} ${i.vendor} ${i.category}`.toLowerCase().includes(q.toLowerCase())));
      return { phase: cat.phase, note: cat.note, packageManager: pkgManager, categories: [...new Set(cat.items.map((i) => i.category))].sort(), items, total: cat.items.length };
    },
  };

  return {
    profile, analytics, time, quota, nodes, stats, terminal, updates, marketplace,
    jobs: { [QUOTA_JOB]: quota.enableJob, [STATS_JOB]: stats.generateJob, [UPDATE_JOB]: updates.checkJob },
    schedules: [
      { name: STATS_SCHEDULE, cron: STATS_CRON, jobType: STATS_JOB },
      { name: UPDATE_SCHEDULE, cron: UPDATE_CRON, jobType: UPDATE_JOB },
    ],
  };
}
