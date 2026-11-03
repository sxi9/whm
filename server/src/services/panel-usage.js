import { HttpError } from '../lib/errors.js';
import { effectiveLimit } from './panel-databases.js';

// Customer panel: disk, bandwidth and object counts of one hosting account
// against its plan. Figures come from the accounts row (kept fresh by the
// account-information jobs), repquota when the quota capability exists, and a
// cached shallow `du` of the home run as the account. Refreshes reuse the
// server-wide disk refresh job (seam S9) and are rate limited per account.

export const DU_CACHE_MS = 5 * 60_000;
export const QUOTA_CACHE_MS = 60_000;
export const REFRESH_INTERVAL_MS = 10 * 60_000;
const DISK_REFRESH_JOB = 'account_info.disk_refresh';

const pct = (used, limit) => (limit == null || limit <= 0 ? null : Math.min(100, Math.round((used / limit) * 1000) / 10));

export function createPanelUsageService(ctx) {
  const { db, agent, settings, capabilities } = ctx;

  const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  const stmts = {
    account: db.prepare('SELECT id, username, domain, package_name, disk_used_mb, disk_quota_mb, bandwidth_used_mb, bandwidth_limit_mb, home_dir, updated_at FROM accounts WHERE id = ?'),
    domainsByType: db.prepare('SELECT type, COUNT(*) AS n FROM account_domains WHERE account_id = ? GROUP BY type'),
    mailboxes: db.prepare('SELECT COUNT(*) AS n FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.domain_id WHERE md.account_id = ?'),
    databases: db.prepare('SELECT COUNT(*) AS n FROM databases WHERE account_id = ?'),
    dbUsers: db.prepare('SELECT COUNT(*) AS n FROM db_users WHERE account_id = ?'),
    ftp: hasTable('ftp_accounts') ? db.prepare('SELECT COUNT(*) AS n FROM ftp_accounts WHERE account_id = ?') : null,
    forwarders: hasTable('mail_forwarders') ? db.prepare('SELECT COUNT(*) AS n FROM mail_forwarders WHERE account_id = ?') : null,
    autoresponders: hasTable('mail_autoresponders') ? db.prepare('SELECT COUNT(*) AS n FROM mail_autoresponders WHERE account_id = ?') : null,
    zones: db.prepare('SELECT COUNT(*) AS n FROM dns_zones WHERE account_id = ?'),
    bandwidthMonths: db.prepare('SELECT period, bytes FROM account_bandwidth WHERE account_id = ? ORDER BY period DESC LIMIT 12'),
  };

  const duCache = new Map();
  const quotaCache = { at: 0, users: null };
  const lastRefresh = new Map();
  const audit = (req, scope, entry) => req?.audit?.({ ...entry, target: scope.username, args: { ...(entry.args || {}), ...(scope.mode === 'acting' ? { actingAs: scope.username, by: scope.actor?.username } : {}) } });

  function counts(scope) {
    const byType = Object.fromEntries(stmts.domainsByType.all(scope.accountId).map((r) => [r.type, r.n]));
    const n = (stmt) => (stmt ? stmt.get(scope.accountId).n : null);
    return {
      domains: (byType.main || 0) + (byType.addon || 0),
      addons: byType.addon || 0, subdomains: byType.sub || 0, parked: (byType.parked || 0) + (byType.alias || 0),
      mailboxes: n(stmts.mailboxes), forwarders: n(stmts.forwarders), autoresponders: n(stmts.autoresponders),
      databases: n(stmts.databases), dbUsers: n(stmts.dbUsers), ftp: n(stmts.ftp), zones: n(stmts.zones),
    };
  }

  function limits(scope) {
    const l = (key) => effectiveLimit(scope, key);
    return {
      max_addons: l('max_addons'), max_subdomains: l('max_subdomains'), max_parked: l('max_parked'), max_domains: l('max_domains'),
      max_email: l('max_email'), max_sql: l('max_sql') ?? l('max_db'), max_ftp: l('max_ftp'), max_email_per_hour: l('max_email_per_hour'),
      disk_mb: l('disk_mb'), bandwidth_mb: l('bandwidth_mb'), quota_inodes: l('quota_inodes'),
    };
  }

  async function quotaFor(username) {
    if (!capabilities.has('quota')) return null;
    if (Date.now() - quotaCache.at > QUOTA_CACHE_MS || !quotaCache.users) {
      try {
        const r = await agent.op('user.quota_report', { filesystem: settings.get('account_info.quota', {})?.filesystem || '/' });
        quotaCache.users = r.available ? new Map(r.users.map((u) => [u.username, u])) : new Map();
        quotaCache.at = Date.now();
      } catch { quotaCache.users = quotaCache.users || new Map(); quotaCache.at = Date.now(); }
    }
    const u = quotaCache.users.get(username);
    return u ? { usedMb: u.usedMb ?? null, softMb: u.softMb ?? null, hardMb: u.hardMb ?? null, inodes: u.inodes ?? null, inodeLimit: u.inodeHard ?? u.inodeLimit ?? null } : null;
  }

  // Shallow du of the home as the account: the top-level breakdown of the usage
  // meter. Missing files.* ops (dev hosts) just leave it out.
  async function duFor(scope, home) {
    const key = `${scope.accountId}:${home}`;
    const hit = duCache.get(key);
    if (hit && Date.now() - hit.at < DU_CACHE_MS) return hit.value;
    let value = null;
    try {
      const r = await agent.op('files.du', { username: scope.username, path: home, depth: 1 });
      value = { totalKb: r.totalKb ?? r.total ?? null, entries: (r.entries || []).map((e) => ({ path: e.path, kb: e.kb ?? e.sizeKb ?? null })).slice(0, 200), at: new Date().toISOString() };
    } catch { value = null; }
    duCache.set(key, { at: Date.now(), value });
    return value;
  }

  async function usage(scope) {
    const a = stmts.account.get(scope.accountId);
    const home = a.home_dir || `${settings.get('basic.home_root', '/home')}/${scope.username}`;
    const [quota, du] = await Promise.all([quotaFor(scope.username), duFor(scope, home)]);
    const diskUsedMb = quota?.usedMb ?? a.disk_used_mb ?? 0;
    const diskQuotaMb = a.disk_quota_mb && a.disk_quota_mb > 0 ? a.disk_quota_mb : null;
    const bandwidthLimitMb = a.bandwidth_limit_mb && a.bandwidth_limit_mb > 0 ? a.bandwidth_limit_mb : null;
    const c = counts(scope);
    const l = limits(scope);
    const objects = [
      ['addons', 'max_addons'], ['subdomains', 'max_subdomains'], ['parked', 'max_parked'], ['mailboxes', 'max_email'], ['databases', 'max_sql'], ['ftp', 'max_ftp'],
    ].map(([key, limitKey]) => ({ key, used: c[key], limit: l[limitKey], percent: c[key] == null ? null : pct(c[key], l[limitKey]) }));
    return {
      account: { username: a.username, domain: a.domain, package: a.package_name, home },
      disk: { usedMb: diskUsedMb, quotaMb: diskQuotaMb, percent: pct(diskUsedMb, diskQuotaMb), source: quota ? 'repquota' : 'scan', inodes: quota?.inodes ?? null, inodeLimit: quota?.inodeLimit ?? null, lastRefresh: settings.get('account_info.disk_refreshed_at', null), breakdown: du },
      bandwidth: { usedMb: a.bandwidth_used_mb ?? 0, limitMb: bandwidthLimitMb, percent: pct(a.bandwidth_used_mb ?? 0, bandwidthLimitMb), months: stmts.bandwidthMonths.all(scope.accountId).map((m) => ({ period: m.period, mb: Math.round((m.bytes / 1048576) * 10) / 10 })) },
      counts: c, limits: l, objects,
      refresh: { lastRequestedAt: lastRefresh.get(scope.accountId) ?? null, intervalMs: REFRESH_INTERVAL_MS },
    };
  }

  function runningRefresh() {
    return ctx.jobs.list({ type: DISK_REFRESH_JOB, status: 'running', limit: 20 })[0] || ctx.jobs.list({ type: DISK_REFRESH_JOB, status: 'queued', limit: 20 })[0] || null;
  }

  // The disk refresh job is server-wide: a running or queued one is reused and
  // a new one is enqueued at most once per account per REFRESH_INTERVAL_MS.
  function refresh(scope, req) {
    if (!ctx.accountInfo?.enqueueDiskRefresh) throw new HttpError(501, 'capability_missing', 'Disk usage refresh is not available');
    const running = runningRefresh();
    if (running) return { job: { id: running.id }, reused: true };
    const last = lastRefresh.get(scope.accountId) ?? 0;
    if (Date.now() - last < REFRESH_INTERVAL_MS) throw new HttpError(429, 'rate_limited', `Usage was refreshed less than ${Math.round(REFRESH_INTERVAL_MS / 60000)} minutes ago; try again later`);
    const job = ctx.accountInfo.enqueueDiskRefresh(scope.ownerPrincipal);
    lastRefresh.set(scope.accountId, Date.now());
    duCache.clear();
    audit(req, scope, { action: 'panel.usage.refresh', args: { job: job.id } });
    return { job: { id: job.id }, reused: false };
  }

  return { usage, refresh, counts, limits, _caches: { duCache, quotaCache, lastRefresh } };
}
