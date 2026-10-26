import { json, paginate } from '../db/index.js';
import { notFound, conflict, badRequest, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

// Apache vhosts rendered by Service Configuration log to
// /var/log/whm/domlogs/<user>/<domain>[-ssl]-access.log (combined format).
export const DOMLOGS_ROOT = '/var/log/whm/domlogs';
const ACCESS_LOG = /-access\.log$/;
const READ_CAP = 32 * 1024 * 1024;
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
// Combined log format: host ident user [dd/Mon/yyyy:HH:MM:SS zone] "request" status bytes ...
const LOG_LINE = /^\S+ \S+ \S+ \[(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):[^\]]*\] "[^"]*" (\d{3}) (\d+|-)/;
const DOMAIN_TYPES = { parked: ['parked', 'alias'], sub: ['sub'], addon: ['addon'], main: ['main'], all: ['main', 'addon', 'sub', 'parked', 'alias'] };

export const currentPeriod = (d = new Date()) => d.toISOString().slice(0, 7);

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

// Sums response bytes per month over the complete lines of an access log
// chunk. The trailing partial line (still being written) is left for the next
// run; consumedBytes says how far the caller may advance its offset.
export function parseAccessLog(content) {
  const end = content.lastIndexOf('\n');
  const complete = end === -1 ? '' : content.slice(0, end + 1);
  const periods = {};
  let lines = 0;
  let requests = 0;
  for (const line of complete.split('\n')) {
    if (!line) continue;
    lines++;
    const m = LOG_LINE.exec(line);
    if (!m) continue;
    const month = MONTHS[m[2]];
    if (!month) continue;
    requests++;
    const period = `${m[3]}-${month}`;
    periods[period] = (periods[period] || 0) + (m[5] === '-' ? 0 : Number(m[5]));
  }
  return { periods, lines, requests, consumedBytes: Buffer.byteLength(complete) };
}

export function createAccountInformationService(ctx) {
  const { db, agent, capabilities, settings, logger } = ctx;

  const stmts = {
    accountByUsername: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.username = ?'),
    accountsForJobs: db.prepare('SELECT id, username, domain, home_dir, disk_quota_mb, disk_used_mb, bandwidth_limit_mb, suspended FROM accounts ORDER BY username'),
    setDiskUsed: db.prepare("UPDATE accounts SET disk_used_mb = ?, updated_at = datetime('now') WHERE id = ?"),
    setBandwidthUsed: db.prepare("UPDATE accounts SET bandwidth_used_mb = ?, updated_at = datetime('now') WHERE id = ?"),
    addBandwidth: db.prepare('INSERT INTO account_bandwidth (account_id, period, bytes) VALUES (?, ?, ?) ON CONFLICT (account_id, period) DO UPDATE SET bytes = bytes + excluded.bytes'),
    periodBytes: db.prepare('SELECT bytes FROM account_bandwidth WHERE account_id = ? AND period = ?'),
    history: db.prepare('SELECT period, bytes FROM account_bandwidth WHERE account_id = ? AND period >= ? ORDER BY period'),
    periods: db.prepare('SELECT DISTINCT period FROM account_bandwidth ORDER BY period DESC LIMIT 36'),
    deleteBandwidth: db.prepare('DELETE FROM account_bandwidth WHERE account_id = ? AND period = ?'),
    deleteBandwidthAll: db.prepare('DELETE FROM account_bandwidth WHERE account_id = ?'),
    source: db.prepare('SELECT * FROM account_bandwidth_sources WHERE account_id = ? AND path = ?'),
    sources: db.prepare('SELECT path, bytes_processed, size, lines, last_seen_at FROM account_bandwidth_sources WHERE account_id = ? ORDER BY path'),
    upsertSource: db.prepare(`INSERT INTO account_bandwidth_sources (account_id, path, bytes_processed, size, lines, last_seen_at) VALUES (@account_id, @path, @bytes_processed, @size, @lines, datetime('now'))
      ON CONFLICT (account_id, path) DO UPDATE SET bytes_processed = excluded.bytes_processed, size = excluded.size, lines = account_bandwidth_sources.lines + excluded.lines, last_seen_at = excluded.last_seen_at`),
    domainsOf: db.prepare("SELECT account_id, domain FROM account_domains WHERE account_id IN (SELECT value FROM json_each(?)) AND type IN ('main', 'addon')"),
    enhancementBySlug: db.prepare('SELECT * FROM account_enhancements WHERE enhancement_id = ?'),
    enhancementByName: db.prepare('SELECT id FROM account_enhancements WHERE name = ?'),
    insertEnhancement: db.prepare('INSERT INTO account_enhancements (enhancement_id, name, description, limits_json, enabled) VALUES (@enhancement_id, @name, @description, @limits_json, @enabled)'),
    updateEnhancement: db.prepare("UPDATE account_enhancements SET name = @name, description = @description, limits_json = @limits_json, enabled = @enabled, updated_at = datetime('now') WHERE id = @id"),
    deleteEnhancement: db.prepare('DELETE FROM account_enhancements WHERE id = ?'),
    assignmentsOf: db.prepare(`SELECT e.*, s.assigned_at, s.assigned_by FROM account_enhancement_assignments s JOIN account_enhancements e ON e.id = s.enhancement_id WHERE s.account_id = ? ORDER BY e.name`),
    assign: db.prepare('INSERT OR IGNORE INTO account_enhancement_assignments (account_id, enhancement_id, assigned_by) VALUES (?, ?, ?)'),
    unassign: db.prepare('DELETE FROM account_enhancement_assignments WHERE account_id = ? AND enhancement_id = ?'),
    clearAssignments: db.prepare('DELETE FROM account_enhancement_assignments WHERE account_id = ?'),
    accountsOfEnhancement: db.prepare(`SELECT a.id, a.username, a.domain, a.suspended, u.username AS owner, a.owner_id, s.assigned_at, s.assigned_by FROM account_enhancement_assignments s
      JOIN accounts a ON a.id = s.account_id JOIN users u ON u.id = a.owner_id WHERE s.enhancement_id = ? ORDER BY a.username`),
    rootUser: db.prepare("SELECT id, username, role FROM users WHERE role = 'root' ORDER BY id LIMIT 1"),
    systemAudit: db.prepare("INSERT INTO audit_log (principal, role, ip, action, target, args_redacted, result) VALUES ('system', 'root', NULL, ?, ?, ?, 'ok')"),
  };

  const bwSettings = () => ({ suspendOnExceed: false, suspendReason: 'Bandwidth limit exceeded', warnPercent: 80, maxLogBytes: READ_CAP, extraLogDirs: [], ...(settings.get('account_info.bandwidth') || {}) });
  const quotaSettings = () => ({ warnPercent: 90, filesystem: '/', ...(settings.get('account_info.quota') || {}) });
  const toMb = (bytes) => Math.round(bytes / 1048576);
  const pct = (used, limit) => (limit > 0 ? Math.round((used / limit) * 1000) / 10 : null);

  function loadAccount(username, user) {
    const row = stmts.accountByUsername.get(username);
    if (!row) throw notFound('Account');
    if (!isRoot(user) && row.owner_id !== user.id) throw notFound('Account');
    return row;
  }

  const ownerWhere = (user, where, params) => { if (!isRoot(user)) { where.push('a.owner_id = @owner'); params.owner = user.id; } };

  function shapeEnhancement(row, extra = {}) {
    if (!row) return null;
    return { id: row.enhancement_id, name: row.name, description: row.description, limits: json.parse(row.limits_json, {}), enabled: Boolean(row.enabled), created_at: row.created_at, updated_at: row.updated_at, ...extra };
  }

  // Domain lists ----------------------------------------------------------------
  function listDomains(query, user) {
    const types = DOMAIN_TYPES[query.type || 'all'];
    const where = [`d.type IN (${types.map((_, i) => `@t${i}`).join(', ')})`];
    const params = Object.fromEntries(types.map((t, i) => [`t${i}`, t]));
    ownerWhere(user, where, params);
    if (query.q) { where.push('(d.domain LIKE @q OR a.username LIKE @q OR a.domain LIKE @q OR u.username LIKE @q)'); params.q = `%${query.q}%`; }
    if (query.account) { where.push('a.username = @account'); params.account = query.account; }
    const result = paginate(db, {
      select: 'd.id, d.domain, d.type, d.docroot, d.php_version, d.created_at, a.id AS account_id, a.username, a.domain AS account_domain, a.suspended, a.ip, u.username AS owner',
      from: 'account_domains d JOIN accounts a ON a.id = d.account_id JOIN users u ON u.id = a.owner_id', where, params,
      sortable: { domain: 'd.domain', type: 'd.type', username: 'a.username', account_domain: 'a.domain', owner: 'u.username', created_at: 'd.created_at' },
      defaultSort: 'domain', query,
    });
    // A subdomain belongs to whichever main/addon domain of its account it ends with.
    const ids = [...new Set(result.data.map((r) => r.account_id))];
    const parents = ids.length ? stmts.domainsOf.all(JSON.stringify(ids)) : [];
    const data = result.data.map((r) => {
      const candidates = parents.filter((p) => p.account_id === r.account_id && r.domain !== p.domain && r.domain.endsWith(`.${p.domain}`)).map((p) => p.domain).sort((a, b) => b.length - a.length);
      return { ...r, suspended: Boolean(r.suspended), parent: candidates[0] || r.account_domain };
    });
    return { data, meta: { ...result.meta, type: query.type || 'all' } };
  }

  // Disk quota ------------------------------------------------------------------
  function quota(query, user) {
    const { warnPercent } = quotaSettings();
    const where = [];
    const params = { warn: warnPercent };
    ownerWhere(user, where, params);
    const scope = query.scope || 'over';
    if (scope === 'over') where.push('a.disk_quota_mb > 0 AND a.disk_used_mb >= a.disk_quota_mb');
    else if (scope === 'warn') where.push('a.disk_quota_mb > 0 AND a.disk_used_mb * 100.0 / a.disk_quota_mb >= @warn');
    if (query.q) { where.push('(a.username LIKE @q OR a.domain LIKE @q OR u.username LIKE @q)'); params.q = `%${query.q}%`; }
    const percentSql = 'CASE WHEN a.disk_quota_mb > 0 THEN a.disk_used_mb * 100.0 / a.disk_quota_mb END';
    const result = paginate(db, {
      select: `a.id, a.username, a.domain, a.package_name, a.disk_quota_mb, a.disk_used_mb, a.suspended, a.home_dir, a.updated_at, u.username AS owner, ${percentSql} AS percent`,
      from: 'accounts a JOIN users u ON u.id = a.owner_id', where, params,
      sortable: { username: 'a.username', domain: 'a.domain', owner: 'u.username', package: 'a.package_name', disk_used_mb: 'a.disk_used_mb', disk_quota_mb: 'a.disk_quota_mb', percent: percentSql },
      defaultSort: 'percent', query: { dir: 'desc', ...query },
    });
    const data = result.data.map((r) => ({
      ...r, suspended: Boolean(r.suspended), percent: r.percent == null ? null : Math.round(r.percent * 10) / 10,
      over: r.disk_quota_mb > 0 && r.disk_used_mb >= r.disk_quota_mb, warn: r.disk_quota_mb > 0 && r.percent >= warnPercent,
    }));
    return { data, meta: { ...result.meta, scope, quota: { installed: capabilities.has('quota'), warnPercent, lastRefresh: settings.get('account_info.disk_refreshed_at', null), source: capabilities.has('quota') ? 'repquota' : 'du' } } };
  }

  async function quotaReport(filesystem) {
    capabilities.require('quota', 'Disk quotas are not installed on this server (the quota package is missing); usage figures come from the scheduled disk scan instead. Install quota tools and run Initial Quota Setup to enforce limits.');
    const report = await agent.op('user.quota_report', { filesystem: filesystem || quotaSettings().filesystem });
    if (!report.available) throw new CapabilityError('quota', 'repquota is not available on this server; usage figures come from the scheduled disk scan instead.');
    const accounts = new Map(stmts.accountsForJobs.all().map((a) => [a.username, a]));
    return {
      filesystem: filesystem || quotaSettings().filesystem,
      users: report.users.map((u) => ({ ...u, managed: accounts.has(u.username), domain: accounts.get(u.username)?.domain ?? null, over: u.hardMb > 0 ? u.usedMb >= u.hardMb : u.softMb > 0 && u.usedMb >= u.softMb })),
    };
  }

  // Refreshes accounts.disk_used_mb: repquota numbers when quotas are enabled,
  // otherwise `du` over each home directory. Runs on a schedule and on demand.
  async function refreshDiskUsage(job) {
    const accounts = stmts.accountsForJobs.all();
    const { filesystem } = quotaSettings();
    let report = null;
    if (capabilities.has('quota')) {
      try {
        const r = await agent.op('user.quota_report', { filesystem });
        if (r.available) report = new Map(r.users.map((u) => [u.username, u]));
        job.log(report ? `repquota reported ${report.size} user(s) on ${filesystem}` : 'repquota not available; falling back to du');
      } catch (err) { job.log(`repquota failed (${err.message}); falling back to du`, 'warn'); }
    } else job.log('Disk quotas are not installed; measuring home directories with du');
    const summary = { accounts: accounts.length, measured: 0, failed: 0, over: [], source: report ? 'repquota' : 'du' };
    for (const [i, a] of accounts.entries()) {
      job.progress((i / Math.max(1, accounts.length)) * 100, a.username);
      let usedMb = report?.get(a.username)?.usedMb ?? null;
      if (usedMb == null) {
        if (!a.home_dir) { summary.failed++; continue; }
        try { usedMb = toMb((await agent.op('fs.du', { path: a.home_dir })).bytes); } catch (err) { summary.failed++; job.log(`${a.username}: ${err.message}`, 'warn'); continue; }
      }
      stmts.setDiskUsed.run(usedMb, a.id);
      summary.measured++;
      if (a.disk_quota_mb > 0 && usedMb >= a.disk_quota_mb) { summary.over.push(a.username); job.log(`${a.username} is over quota: ${usedMb} / ${a.disk_quota_mb} MB`, 'warn'); }
    }
    settings.set('account_info.disk_refreshed_at', new Date().toISOString());
    job.progress(100, `${summary.measured} account(s) measured, ${summary.over.length} over quota`);
    return summary;
  }

  // Bandwidth -------------------------------------------------------------------
  function bandwidth(query, user) {
    const { warnPercent } = bwSettings();
    const period = query.period || currentPeriod();
    const where = [];
    const params = { period, warn: warnPercent };
    ownerWhere(user, where, params);
    const usedMbSql = 'COALESCE(b.bytes, 0) / 1048576.0';
    const percentSql = `CASE WHEN a.bandwidth_limit_mb > 0 THEN ${usedMbSql} * 100.0 / a.bandwidth_limit_mb END`;
    const scope = query.scope || 'all';
    if (scope === 'over') where.push(`a.bandwidth_limit_mb > 0 AND ${usedMbSql} >= a.bandwidth_limit_mb`);
    else if (scope === 'warn') where.push(`a.bandwidth_limit_mb > 0 AND ${percentSql} >= @warn`);
    if (query.q) { where.push('(a.username LIKE @q OR a.domain LIKE @q OR u.username LIKE @q)'); params.q = `%${query.q}%`; }
    const result = paginate(db, {
      select: `a.id, a.username, a.domain, a.package_name, a.bandwidth_limit_mb, a.suspended, a.suspend_reason, u.username AS owner, COALESCE(b.bytes, 0) AS bytes, ${percentSql} AS percent`,
      from: 'accounts a JOIN users u ON u.id = a.owner_id LEFT JOIN account_bandwidth b ON b.account_id = a.id AND b.period = @period', where, params,
      sortable: { username: 'a.username', domain: 'a.domain', owner: 'u.username', bytes: 'COALESCE(b.bytes, 0)', bandwidth_limit_mb: 'a.bandwidth_limit_mb', percent: percentSql },
      defaultSort: 'bytes', query: { dir: 'desc', ...query },
    });
    const data = result.data.map((r) => {
      const usedMb = toMb(r.bytes);
      return { ...r, suspended: Boolean(r.suspended), usedMb, percent: r.percent == null ? null : Math.round(r.percent * 10) / 10, over: r.bandwidth_limit_mb > 0 && usedMb >= r.bandwidth_limit_mb, warn: r.bandwidth_limit_mb > 0 && r.percent >= warnPercent };
    });
    const totalWhere = [`b.period = @period`];
    const totalParams = { period };
    if (!isRoot(user)) { totalWhere.push('a.owner_id = @owner'); totalParams.owner = user.id; }
    const total = db.prepare(`SELECT COALESCE(SUM(b.bytes), 0) AS bytes FROM account_bandwidth b JOIN accounts a ON a.id = b.account_id WHERE ${totalWhere.join(' AND ')}`).get(totalParams).bytes;
    const periods = [...new Set([currentPeriod(), ...stmts.periods.all().map((p) => p.period)])].sort().reverse();
    return { data, meta: { ...result.meta, period, periods, scope, totalBytes: total, warnPercent, lastCollect: settings.get('account_info.bandwidth_collected_at', null), suspendOnExceed: bwSettings().suspendOnExceed } };
  }

  function bandwidthHistory(username, user, months = 12) {
    const account = loadAccount(username, user);
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - (months - 1));
    const from = currentPeriod(start);
    const rows = new Map(stmts.history.all(account.id, from).map((r) => [r.period, r.bytes]));
    const series = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      const period = currentPeriod(d);
      series.push({ period, bytes: rows.get(period) || 0 });
    }
    const limitMb = account.bandwidth_limit_mb;
    return {
      username, domain: account.domain, owner: account.owner, limitMb, suspended: Boolean(account.suspended), suspend_reason: account.suspend_reason,
      months: series.map((s) => ({ ...s, usedMb: toMb(s.bytes), percent: pct(toMb(s.bytes), limitMb) })),
      sources: stmts.sources.all(account.id),
    };
  }

  async function collectAccount(account, conf, job) {
    const dirs = [`${DOMLOGS_ROOT}/${account.username}`, ...(conf.extraLogDirs || []).map((d) => `${String(d).replace(/\/+$/, '')}/${account.username}`)];
    const out = { files: 0, lines: 0, requests: 0, bytes: 0, skipped: 0 };
    const maxBytes = Math.min(READ_CAP, Math.max(65536, Number(conf.maxLogBytes) || READ_CAP));
    for (const dir of dirs) {
      let listing;
      try { listing = await agent.op('fs.list', { path: dir, limit: 1000 }); } catch (err) {
        if (!['op_failed', 'not_found'].includes(err.code)) job.log(`${account.username}: cannot list ${dir}: ${err.message}`, 'warn');
        continue;
      }
      for (const entry of listing.entries || []) {
        if (entry.type !== 'file' || !ACCESS_LOG.test(entry.name) || !entry.size) continue;
        const file = `${dir}/${entry.name}`;
        const prev = stmts.source.get(account.id, file);
        let from = prev?.bytes_processed ?? 0;
        if (entry.size < from) { job.log(`${file} was rotated; parsing from the start`); from = 0; }
        if (entry.size === from) continue;
        let want = entry.size - from;
        if (want > maxBytes) { job.log(`${file}: ${want - maxBytes} byte(s) skipped (more than the ${maxBytes}-byte read limit were appended since the last run)`, 'warn'); from = entry.size - maxBytes; want = maxBytes; out.skipped += entry.size - maxBytes - (prev?.bytes_processed ?? 0); }
        let res;
        try { res = await agent.op('sys.read_file', { path: file, maxBytes: want, tail: true }); } catch (err) { job.log(`${file}: ${err.message}`, 'warn'); continue; }
        // The file may have grown between listing and reading; the read starts
        // at size - want, so anchor the offset on what was actually returned.
        const position = Math.max(0, res.size - Math.min(res.size, want));
        const parsed = parseAccessLog(res.content);
        db.transaction(() => {
          for (const [period, bytes] of Object.entries(parsed.periods)) if (bytes > 0) stmts.addBandwidth.run(account.id, period, bytes);
          stmts.upsertSource.run({ account_id: account.id, path: file, bytes_processed: position + parsed.consumedBytes, size: res.size, lines: parsed.lines });
        })();
        out.files++; out.lines += parsed.lines; out.requests += parsed.requests;
        out.bytes += Object.values(parsed.periods).reduce((s, b) => s + b, 0);
      }
    }
    return out;
  }

  async function systemSuspend(account, reason) {
    const root = stmts.rootUser.get();
    const user = { id: root?.id ?? 1, username: 'system', role: 'root' };
    await ctx.accounts.suspend(account.username, reason, user, null);
    stmts.systemAudit.run('account.suspend', account.username, JSON.stringify({ reason, usedMb: account.usedMb, limitMb: account.bandwidth_limit_mb, by: 'account_info.bandwidth_collect' }));
  }

  // Parses every account's Apache access logs incrementally into monthly totals,
  // then enforces the bandwidth limit when the operator enabled that.
  async function collectBandwidth(job) {
    const conf = bwSettings();
    const accounts = stmts.accountsForJobs.all();
    const period = currentPeriod();
    const summary = { accounts: accounts.length, files: 0, lines: 0, requests: 0, bytes: 0, exceeded: [], suspended: [], period };
    for (const [i, a] of accounts.entries()) {
      job.progress((i / Math.max(1, accounts.length)) * 90, a.username);
      let r;
      try { r = await collectAccount(a, conf, job); } catch (err) { job.log(`${a.username}: ${err.message}`, 'warn'); continue; }
      summary.files += r.files; summary.lines += r.lines; summary.requests += r.requests; summary.bytes += r.bytes;
      const usedMb = toMb(stmts.periodBytes.get(a.id, period)?.bytes || 0);
      stmts.setBandwidthUsed.run(usedMb, a.id);
      if (a.bandwidth_limit_mb > 0 && usedMb >= a.bandwidth_limit_mb) {
        summary.exceeded.push(a.username);
        if (conf.suspendOnExceed && !a.suspended) {
          try {
            await systemSuspend({ ...a, usedMb }, conf.suspendReason || 'Bandwidth limit exceeded');
            summary.suspended.push(a.username);
            job.log(`${a.username} suspended: ${usedMb} / ${a.bandwidth_limit_mb} MB used in ${period}`, 'warn');
          } catch (err) { job.log(`${a.username}: exceeded its limit but could not be suspended: ${err.message}`, 'error'); }
        } else job.log(`${a.username} exceeded its limit: ${usedMb} / ${a.bandwidth_limit_mb} MB in ${period}`, 'warn');
      }
    }
    settings.set('account_info.bandwidth_collected_at', new Date().toISOString());
    job.progress(100, `${summary.files} log file(s), ${summary.requests} request(s), ${summary.exceeded.length} account(s) over limit`);
    return summary;
  }

  function bandwidthSettings() {
    return { settings: bwSettings(), logsRoot: DOMLOGS_ROOT, lastCollect: settings.get('account_info.bandwidth_collected_at', null), readCap: READ_CAP };
  }

  function updateBandwidthSettings(input, req) {
    const next = { ...bwSettings(), ...input };
    settings.set('account_info.bandwidth', next);
    req?.audit?.({ action: 'account_info.bandwidth.settings', args: input });
    return bandwidthSettings();
  }

  function resetBandwidth(username, { all = false, period = currentPeriod() } = {}, user, req) {
    const account = loadAccount(username, user);
    db.transaction(() => {
      if (all) stmts.deleteBandwidthAll.run(account.id); else stmts.deleteBandwidth.run(account.id, period);
      stmts.setBandwidthUsed.run(all || period === currentPeriod() ? 0 : toMb(stmts.periodBytes.get(account.id, currentPeriod())?.bytes || 0), account.id);
    })();
    req?.audit?.({ action: 'account_info.bandwidth.reset', target: username, args: { all, period } });
    return { username, all, period };
  }

  // Enhancements ------------------------------------------------------------------
  const enhancements = {
    list(query) {
      const where = [];
      const params = {};
      if (query.q) { where.push('(e.name LIKE @q OR e.enhancement_id LIKE @q OR e.description LIKE @q)'); params.q = `%${query.q}%`; }
      const result = paginate(db, {
        select: 'e.*, (SELECT COUNT(*) FROM account_enhancement_assignments s WHERE s.enhancement_id = e.id) AS assigned',
        from: 'account_enhancements e', where, params,
        sortable: { name: 'e.name', id: 'e.enhancement_id', assigned: 'assigned', created_at: 'e.created_at' }, defaultSort: 'name', query,
      });
      return { ...result, data: result.data.map((r) => shapeEnhancement(r, { assigned: r.assigned })) };
    },
    get(id) {
      const row = stmts.enhancementBySlug.get(id);
      if (!row) throw notFound('Enhancement');
      return shapeEnhancement(row, { assigned: stmts.accountsOfEnhancement.all(row.id).length });
    },
    create(input, req) {
      const slug = input.id || slugify(input.name);
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) throw badRequest('The enhancement id must be lowercase letters, digits, "_" or "-"');
      if (stmts.enhancementBySlug.get(slug)) throw conflict(`An enhancement with id "${slug}" already exists`);
      if (stmts.enhancementByName.get(input.name)) throw conflict(`An enhancement named "${input.name}" already exists`);
      stmts.insertEnhancement.run({ enhancement_id: slug, name: input.name, description: input.description || '', limits_json: JSON.stringify(input.limits || {}), enabled: input.enabled === false ? 0 : 1 });
      req?.audit?.({ action: 'enhancement.create', target: slug, args: input });
      return enhancements.get(slug);
    },
    update(id, input, req) {
      const row = stmts.enhancementBySlug.get(id);
      if (!row) throw notFound('Enhancement');
      if (input.name && input.name !== row.name && stmts.enhancementByName.get(input.name)) throw conflict(`An enhancement named "${input.name}" already exists`);
      stmts.updateEnhancement.run({
        id: row.id, name: input.name ?? row.name, description: input.description ?? row.description,
        limits_json: input.limits ? JSON.stringify(input.limits) : row.limits_json, enabled: input.enabled == null ? row.enabled : input.enabled ? 1 : 0,
      });
      req?.audit?.({ action: 'enhancement.update', target: id, args: input });
      return enhancements.get(id);
    },
    remove(id, req) {
      const row = stmts.enhancementBySlug.get(id);
      if (!row) throw notFound('Enhancement');
      const assigned = stmts.accountsOfEnhancement.all(row.id).length;
      stmts.deleteEnhancement.run(row.id);
      req?.audit?.({ action: 'enhancement.delete', target: id, args: { unassignedFrom: assigned } });
      return { id, deleted: true, unassignedFrom: assigned };
    },
    accounts(id, user) {
      const row = stmts.enhancementBySlug.get(id);
      if (!row) throw notFound('Enhancement');
      return stmts.accountsOfEnhancement.all(row.id).filter((a) => isRoot(user) || a.owner_id === user.id).map((a) => ({ ...a, suspended: Boolean(a.suspended), owner_id: undefined }));
    },
    forAccount(username, user) {
      const account = loadAccount(username, user);
      return stmts.assignmentsOf.all(account.id).map((r) => shapeEnhancement(r, { assigned_at: r.assigned_at, assigned_by: r.assigned_by }));
    },
    // The union of every assigned enhancement's limits: numeric limits take the
    // highest value, booleans OR together, strings keep the last assignment.
    effectiveLimits(username, user) {
      const merged = {};
      for (const e of enhancements.forAccount(username, user)) {
        if (!e.enabled) continue;
        for (const [k, v] of Object.entries(e.limits)) {
          if (typeof v === 'number' && typeof merged[k] === 'number') merged[k] = Math.max(merged[k], v);
          else if (typeof v === 'boolean' && typeof merged[k] === 'boolean') merged[k] = merged[k] || v;
          else merged[k] = v;
        }
      }
      return merged;
    },
    setForAccount(username, ids, user, req) {
      const account = loadAccount(username, user);
      const rows = ids.map((id) => { const r = stmts.enhancementBySlug.get(id); if (!r) throw notFound(`Enhancement "${id}"`); return r; });
      db.transaction(() => {
        stmts.clearAssignments.run(account.id);
        for (const r of rows) stmts.assign.run(account.id, r.id, user?.username ?? null);
      })();
      req?.audit?.({ action: 'enhancement.assign', target: username, args: { enhancements: ids } });
      return enhancements.forAccount(username, user);
    },
    assign(username, id, user, req) {
      const account = loadAccount(username, user);
      const row = stmts.enhancementBySlug.get(id);
      if (!row) throw notFound('Enhancement');
      const { changes } = stmts.assign.run(account.id, row.id, user?.username ?? null);
      if (!changes) throw conflict(`${username} already has "${row.name}"`);
      req?.audit?.({ action: 'enhancement.assign', target: username, args: { enhancement: id } });
      return enhancements.forAccount(username, user);
    },
    unassign(username, id, user, req) {
      const account = loadAccount(username, user);
      const row = stmts.enhancementBySlug.get(id);
      if (!row) throw notFound('Enhancement');
      if (!stmts.unassign.run(account.id, row.id).changes) throw notFound('Assignment');
      req?.audit?.({ action: 'enhancement.unassign', target: username, args: { enhancement: id } });
      return enhancements.forAccount(username, user);
    },
  };

  function overview(user) {
    const where = [];
    const params = { period: currentPeriod() };
    ownerWhere(user, where, params);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const counts = db.prepare(`SELECT COUNT(*) AS accounts, SUM(a.suspended) AS suspended,
      SUM(CASE WHEN a.disk_quota_mb > 0 AND a.disk_used_mb >= a.disk_quota_mb THEN 1 ELSE 0 END) AS over_quota,
      SUM(CASE WHEN a.bandwidth_limit_mb > 0 AND COALESCE(b.bytes, 0) / 1048576.0 >= a.bandwidth_limit_mb THEN 1 ELSE 0 END) AS over_bandwidth
      FROM accounts a LEFT JOIN account_bandwidth b ON b.account_id = a.id AND b.period = @period ${w}`).get(params);
    const domains = db.prepare(`SELECT d.type, COUNT(*) AS n FROM account_domains d JOIN accounts a ON a.id = d.account_id ${w} GROUP BY d.type`).all(params);
    return { ...counts, suspended: counts.suspended || 0, domains: Object.fromEntries(domains.map((d) => [d.type, d.n])), period: params.period };
  }

  return {
    listDomains, quota, quotaReport, refreshDiskUsage, bandwidth, bandwidthHistory, collectBandwidth, bandwidthSettings, updateBandwidthSettings, resetBandwidth, enhancements, overview,
    enqueueDiskRefresh: (user) => ctx.jobs.enqueue('account_info.disk_refresh', {}, { userId: user?.id ?? null }),
    enqueueBandwidthCollect: (user) => ctx.jobs.enqueue('account_info.bandwidth_collect', {}, { userId: user?.id ?? null }),
  };
}
