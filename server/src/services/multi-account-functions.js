import { json } from '../db/index.js';
import { notFound, forbidden, unprocessable, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

// Multi Account Functions. Attached as ctx.multiAccount; other categories may call:
//   multiAccount.previewChangeIp({ changes, updateDns, updateVhosts }, user)
//   multiAccount.startChangeIp(input, user, req)            -> { job, run }
//   multiAccount.previewModify({ usernames|all|filter, changes }, user)
//   multiAccount.startModify(input, user, req)              -> { job, run }
//   multiAccount.listRuns({ kind, limit }, user) / getRun(id, user) / report(id, format, user)
// Per-account work goes through ctx.accounts.modify and, when loaded, ctx.ip
// (dedication), ctx.web (vhosts via replaceIp, PHP) and ctx.dns (A records). A
// missing daemon leaves an item 'pending' instead of failing the run; a 'failed'
// IP item has been rolled back to its previous address. IPv4 only, as in WHM.

export const RUN_KINDS = ['change_ip', 'modify'];
export const ITEM_STATUSES = ['queued', 'running', 'done', 'pending', 'failed', 'skipped', 'unchanged'];
export const MODIFY_FIELDS = ['package', 'diskQuotaMb', 'bandwidthLimitMb', 'shell', 'contactEmail', 'demoMode', 'forcePasswordChange', 'owner'];
const FIELD_LABELS = { package: 'package', diskQuotaMb: 'disk quota (MB)', bandwidthLimitMb: 'bandwidth limit (MB)', shell: 'shell', contactEmail: 'contact email', demoMode: 'demo mode', forcePasswordChange: 'force password change', owner: 'owner', phpVersion: 'PHP version' };

const familyOf = (ip) => (ip.includes(':') ? 6 : 4);
const isCapabilityMissing = (err) => err instanceof CapabilityError || err?.code === 'capability_missing' || err?.code === 'binary_not_found' || err?.status === 501;

// Spreadsheet-safe CSV: quotes doubled, formula-looking cells neutralised.
export function toCsv(headers, rows) {
  const cell = (v) => {
    let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function createMultiAccountService(ctx) {
  const { db, capabilities, settings, packages, logger, jobs } = ctx;
  const stmts = {
    all: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id ORDER BY a.username'),
    byOwner: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.owner_id = ? ORDER BY a.username'),
    byUsername: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.username = ?'),
    domains: db.prepare('SELECT domain, type FROM account_domains WHERE account_id = ? ORDER BY type, domain'),
    zonesOf: db.prepare('SELECT id, domain FROM dns_zones WHERE account_id = ? ORDER BY domain'),
    aRecordsWith: db.prepare("SELECT COUNT(*) AS n FROM dns_records r JOIN dns_zones z ON z.id = r.zone_id WHERE z.account_id = ? AND r.type = 'A' AND r.value = ?"),
    setIp: db.prepare("UPDATE accounts SET ip = ?, updated_at = datetime('now') WHERE id = ?"),
    ownerByUsername: db.prepare("SELECT id, username FROM users WHERE username = ? AND role IN ('root', 'reseller')"),
    userById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
    insertRun: db.prepare('INSERT INTO multi_account_runs (kind, created_by, requested_by, status, params_json) VALUES (@kind, @created_by, @requested_by, @status, @params_json)'),
    setRunJob: db.prepare('UPDATE multi_account_runs SET job_id = ? WHERE id = ?'),
    runStatus: db.prepare('UPDATE multi_account_runs SET status = ? WHERE id = ?'),
    finishRun: db.prepare("UPDATE multi_account_runs SET status = ?, totals_json = ?, finished_at = datetime('now') WHERE id = ?"),
    run: db.prepare('SELECT r.*, u.username AS created_by_name FROM multi_account_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ?'),
    runs: db.prepare('SELECT r.*, u.username AS created_by_name FROM multi_account_runs r LEFT JOIN users u ON u.id = r.created_by WHERE (@kind IS NULL OR r.kind = @kind) AND (@owner IS NULL OR r.created_by = @owner) ORDER BY r.id DESC LIMIT @limit'),
    insertItem: db.prepare('INSERT INTO multi_account_run_items (run_id, account_id, username, domain, status, detail, before_json, after_json, steps_json) VALUES (@run_id, @account_id, @username, @domain, @status, @detail, @before_json, @after_json, @steps_json)'),
    items: db.prepare('SELECT * FROM multi_account_run_items WHERE run_id = ? ORDER BY id'),
    queuedItems: db.prepare("SELECT * FROM multi_account_run_items WHERE run_id = ? AND status = 'queued' ORDER BY id"),
    itemStatus: db.prepare('UPDATE multi_account_run_items SET status = ? WHERE id = ?'),
    finishItem: db.prepare("UPDATE multi_account_run_items SET status = @status, detail = @detail, after_json = @after_json, steps_json = @steps_json, finished_at = datetime('now') WHERE id = @id"),
    itemCounts: db.prepare('SELECT status, COUNT(*) AS n FROM multi_account_run_items WHERE run_id = ? GROUP BY status'),
    pruneRuns: db.prepare("DELETE FROM multi_account_runs WHERE finished_at IS NOT NULL AND finished_at < datetime('now', ?)"),
    openRun: db.prepare("SELECT id FROM multi_account_runs WHERE id = ? AND status IN ('queued', 'running')"),
    failRunningItems: db.prepare("UPDATE multi_account_run_items SET status = 'failed', detail = ?, finished_at = datetime('now') WHERE run_id = ? AND status = 'running'"),
    skipQueuedItems: db.prepare("UPDATE multi_account_run_items SET status = 'skipped', detail = ?, finished_at = datetime('now') WHERE run_id = ? AND status = 'queued'"),
    runByJob: db.prepare('SELECT id FROM multi_account_runs WHERE job_id = ?'),
    orphanedRuns: db.prepare("SELECT r.id, r.job_id, j.status AS job_status, j.error AS job_error FROM multi_account_runs r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.status IN ('queued', 'running') AND (j.id IS NULL OR j.status NOT IN ('queued', 'running')) ORDER BY r.id"),
  };

  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req ?? null, entry));
  const maxBatch = () => Number(settings.get('multi_account.max_batch', 500)) || 500;

  // A request-like principal for the job worker so ctx.accounts / ctx.web / ctx.dns
  // audit and authorise as the user who started the run. Host operations run as
  // root, so a run whose user is gone is refused rather than given a root actor.
  function actorRequest(userId, requestId) {
    const user = userId ? stmts.userById.get(userId) : null;
    if (!user) throw unprocessable('The user who started this run no longer exists; nothing was changed', { user: ['Unknown user'] });
    const req = { user, ip: null, id: requestId ?? null };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    return req;
  }

  // A run whose job ended without reaching finishRun (it could not start, the
  // handler threw, the job was cancelled, the panel restarted mid-run) would
  // otherwise show as running forever: the item being worked on failed, the
  // queued ones never started.
  const abandonRun = db.transaction((runId, reason) => {
    if (!stmts.openRun.get(runId)) return false;
    stmts.failRunningItems.run(reason, runId);
    stmts.skipQueuedItems.run(reason, runId);
    stmts.finishRun.run('failed', JSON.stringify(totalsOf(runId)), runId);
    return true;
  });
  const orphanReason = (r) => (r.job_id == null || r.job_status == null ? 'the job driving this run no longer exists'
    : r.job_status === 'cancelled' ? 'the job was cancelled'
      : r.job_status === 'done' ? 'the job finished without recording the run'
        : r.job_error || 'the job failed');
  // jobs.start() marks the jobs interrupted by a restart as failed without
  // emitting events; the runs they drove are reconciled once the panel is up.
  function reconcileRuns() {
    const abandoned = [];
    for (const r of stmts.orphanedRuns.all()) if (abandonRun(r.id, orphanReason(r))) abandoned.push(r.id);
    if (abandoned.length) logger.warn({ runs: abandoned }, 'multi-account: finalised runs whose job ended without them');
    return abandoned;
  }
  jobs.onAny((event) => {
    if (event.type !== 'failed' && event.type !== 'cancelled') return;
    try {
      const run = stmts.runByJob.get(event.jobId);
      if (run) abandonRun(run.id, event.type === 'cancelled' ? 'the job was cancelled before it started' : event.error || 'the job failed');
    } catch (err) {
      logger.warn({ err, jobId: event.jobId }, 'multi-account: run could not be finalised after its job failed');
    }
  });
  ctx.events?.on?.('panel.started', () => { try { reconcileRuns(); } catch (err) { logger.warn({ err }, 'multi-account: run reconciliation at boot failed'); } });

  const summary = (a) => ({
    id: a.id, username: a.username, domain: a.domain, owner: a.owner, ip: a.ip, package_name: a.package_name, contact_email: a.contact_email,
    suspended: Boolean(a.suspended), demo_mode: Boolean(a.demo_mode), force_password_change: Boolean(a.force_password_change), shell: a.shell,
    disk_quota_mb: a.disk_quota_mb, disk_used_mb: a.disk_used_mb, bandwidth_limit_mb: a.bandwidth_limit_mb, bandwidth_used_mb: a.bandwidth_used_mb,
    systemUser: a.uid != null, created_at: a.created_at, updated_at: a.updated_at,
  });

  const visibleAccounts = (user) => (isRoot(user) ? stmts.all.all() : stmts.byOwner.all(user.id));

  function matches(a, filter = {}) {
    if (filter.q && !`${a.username} ${a.domain} ${a.owner} ${a.contact_email || ''}`.toLowerCase().includes(String(filter.q).toLowerCase())) return false;
    if (filter.owner && a.owner !== filter.owner) return false;
    if (filter.package && a.package_name !== filter.package) return false;
    if (filter.ip && a.ip !== filter.ip) return false;
    if (filter.suspended != null && Boolean(a.suspended) !== Boolean(filter.suspended)) return false;
    return true;
  }

  function load(username, user) {
    const row = stmts.byUsername.get(username);
    if (!row) throw notFound('Account');
    if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That account belongs to another reseller');
    return row;
  }

  // Explicit usernames or "all" (optionally narrowed by a filter). Unknown or
  // foreign accounts come back in `missing` so the caller reports them.
  // Enumerating "all" is the account list, so it needs the same privilege.
  function selectAccounts({ usernames, all, filter }, user) {
    if (all) {
      if (!isRoot(user)) ctx.resellers?.assertAcl?.(user, 'list-accts');
      return { accounts: visibleAccounts(user).filter((a) => matches(a, filter)), missing: [] };
    }
    const accounts = [];
    const missing = [];
    for (const u of [...new Set(usernames || [])]) {
      try { accounts.push(load(u, user)); } catch (err) { if (err.status === 404 || err.status === 403) missing.push(u); else throw err; }
    }
    return { accounts, missing };
  }

  function capabilityStatus() {
    return {
      web: { loaded: Boolean(ctx.web), installed: capabilities.has('apache'), label: 'Apache (virtual hosts)' },
      dns: { loaded: Boolean(ctx.dns), installed: capabilities.has('bind'), label: 'BIND (DNS zones)' },
      quota: { loaded: true, installed: capabilities.has('quota'), label: 'Disk quotas' },
      ip: { loaded: Boolean(ctx.ip), installed: Boolean(ctx.ip), label: 'IP Functions' },
      php: { loaded: Boolean(ctx.web?.setPhpVersion), installed: capabilities.has('php'), label: 'PHP-FPM' },
    };
  }

  // ------------------------------------------------------------------ runs ---

  function createRun(kind, { user, params, items }) {
    return db.transaction(() => {
      const { lastInsertRowid } = stmts.insertRun.run({ kind, created_by: user.id ?? null, requested_by: user.username, status: 'queued', params_json: JSON.stringify(params) });
      for (const it of items) {
        stmts.insertItem.run({
          run_id: lastInsertRowid, account_id: it.accountId ?? null, username: it.username, domain: it.domain ?? null, status: it.status,
          detail: it.detail ?? null, before_json: JSON.stringify(it.before ?? {}), after_json: JSON.stringify(it.after ?? {}), steps_json: JSON.stringify(it.steps ?? {}),
        });
      }
      return Number(lastInsertRowid);
    })();
  }

  function shapeRun(row, { withItems = false } = {}) {
    if (!row) return null;
    const run = { ...row, params: json.parse(row.params_json, {}), totals: json.parse(row.totals_json, {}), params_json: undefined, totals_json: undefined };
    if (withItems) run.items = stmts.items.all(row.id).map(shapeItem);
    return run;
  }
  const shapeItem = (r) => ({ ...r, before: json.parse(r.before_json, {}), after: json.parse(r.after_json, {}), steps: json.parse(r.steps_json, {}), before_json: undefined, after_json: undefined, steps_json: undefined });

  function loadRun(id, user) {
    const row = stmts.run.get(id);
    if (!row) throw notFound('Run');
    if (!isRoot(user) && row.created_by !== user.id) throw forbidden('That run belongs to another reseller');
    return row;
  }

  function totalsOf(runId) {
    const totals = { total: 0, done: 0, pending: 0, failed: 0, skipped: 0, unchanged: 0, queued: 0, running: 0 };
    for (const { status, n } of stmts.itemCounts.all(runId)) { totals[status] = n; totals.total += n; }
    return totals;
  }

  function finishItem(item, { status, detail, after, steps }) {
    stmts.finishItem.run({ id: item.id, status, detail: detail ?? null, after_json: JSON.stringify(after ?? {}), steps_json: JSON.stringify(steps ?? {}) });
  }

  // --------------------------------------------------------- change site IP ---

  // Checked by the preview and again by the job right before an account moves,
  // because another run or IP Functions may have reserved or dedicated the
  // address in between.
  function inventoryIssues(ip, username) {
    const ipSvc = ctx.ip;
    if (!ipSvc) return [];
    const known = ipSvc.get(ip);
    if (!known) return [`${ip} is not configured on this server; add it under IP Functions first`];
    const issues = [];
    if (known.reserved) issues.push(`${ip} is reserved (${known.reserved_reason || 'no reason given'})`);
    if (known.dedicated_to && known.dedicated_to !== username) issues.push(`${ip} is dedicated to ${known.dedicated_to}`);
    return issues;
  }

  const dnsStrict = () => ctx.config?.env === 'production';
  const sharedAddress = () => (ctx.ip ? ctx.ip.sharedIp() : settings.get('basic.shared_ip') || settings.get('basic.main_ip') || null);

  // Service Configuration's replaceIp rewrites only the address of the stored
  // vhosts (integration contract, wave 2 §4). The ensureVhost fallback re-renders
  // everything and reports the PHP handler state, which pre-exists the move and
  // is a warning here, never a reason to roll the account back. `touched` says
  // whether a stored spec now carries the new address and must be put back.
  async function rewriteVhosts(account, from, to, req) {
    if (ctx.web.replaceIp) {
      if (!from) return { status: 'skipped', detail: 'no previous address to replace in the stored virtual hosts', touched: false };
      let r;
      try { r = await ctx.web.replaceIp(from, to, { accounts: [account.username] }, req); } catch (err) {
        if (isCapabilityMissing(err)) return { status: 'pending', detail: 'Apache is not installed; the vhosts are written with the new address when it is', touched: true };
        throw err;
      }
      return r.updated > 0 ? { status: 'applied', detail: `${r.updated} vhost(s) rewritten (${r.domains.join(', ')})`, touched: true }
        : { status: 'skipped', detail: `no stored virtual host used ${from}; the next sync renders them with ${to}`, touched: false };
    }
    const web = await ctx.web.ensureVhost(account.username, req);
    const phpWarning = ['php_missing', 'php_pool_failed'].includes(web.reason);
    if (web.applied || phpWarning) {
      const warning = phpWarning ? web.vhosts?.find((v) => v.reason === web.reason)?.error || web.reason : null;
      return { status: 'applied', detail: `${web.vhosts?.length ?? 0} vhost(s) rewritten${web.reload?.reloaded ? ', web server reloaded' : ''}${warning ? `; PHP handler warning: ${warning}` : ''}`, warning, touched: true };
    }
    if (web.reason === 'capability_missing') return { status: 'pending', detail: 'Apache is not installed; the vhosts are written when it is', touched: true };
    return { status: 'failed', detail: web.vhosts?.find((v) => !v.applied)?.error || web.reason || 'vhost not applied', touched: false };
  }

  function previewChangeIp({ changes, updateDns = true, updateVhosts = true }, user) {
    if (changes.length > maxBatch()) throw unprocessable(`At most ${maxBatch()} accounts per run (multi_account.max_batch)`, { changes: ['Too many accounts'] });
    const ipSvc = ctx.ip;
    const shared = ipSvc ? ipSvc.sharedIp() : settings.get('basic.shared_ip') || settings.get('basic.main_ip') || null;
    const free = ipSvc ? new Set(ipSvc.freeAddresses(4).map((r) => r.address)) : new Set();
    const claimed = new Map();
    const seen = new Set();
    const items = [];
    for (const { username, ip } of changes) {
      const item = { username, domain: null, owner: null, from: null, to: ip, status: 'change', issues: [], dedicated: false, zones: 0, records: 0, vhosts: 0 };
      items.push(item);
      if (seen.has(username)) { item.status = 'blocked'; item.issues.push(`${username} is listed more than once`); continue; }
      seen.add(username);
      let account;
      try { account = load(username, user); } catch (err) { if (err.status === 404 || err.status === 403) { item.status = 'blocked'; item.issues.push('Account not found or not yours'); continue; } throw err; }
      Object.assign(item, { accountId: account.id, domain: account.domain, owner: account.owner, from: account.ip, vhosts: stmts.domains.all(account.id).length });
      if (account.ip === ip) { item.status = 'unchanged'; continue; }
      if (familyOf(ip) !== 4) { item.status = 'blocked'; item.issues.push(`${ip} is an IPv6 address; virtual hosts and A records need an IPv4 address (use "Assign IPv6 Address" under IP Functions instead)`); continue; }
      item.issues.push(...inventoryIssues(ip, username));
      if (ipSvc && !item.issues.length && ip !== shared && free.has(ip)) {
        if (claimed.has(ip)) item.issues.push(`${ip} is a free address that becomes dedicated to ${claimed.get(ip)}; it cannot be given to a second account`);
        else { claimed.set(ip, username); item.dedicated = true; }
      }
      if (item.issues.length) { item.status = 'blocked'; continue; }
      try {
        const zones = stmts.zonesOf.all(account.id);
        item.zones = zones.length;
        item.records = account.ip ? stmts.aRecordsWith.get(account.id, account.ip).n : 0;
      } catch (err) { logger.warn({ err }, 'multi-account: DNS tables unavailable for the preview'); }
    }
    const caps = capabilityStatus();
    const warnings = [];
    if (!ipSvc) warnings.push('IP Functions is not loaded: addresses are not validated against the server inventory');
    if (updateVhosts && caps.web.loaded && !caps.web.installed) warnings.push('Apache is not installed: vhost specs are stored and applied when it is (items finish as "pending")');
    if (updateVhosts && !caps.web.loaded) warnings.push('Service Configuration is not loaded: virtual hosts are not rewritten');
    if (updateDns && caps.dns.loaded && !caps.dns.installed) {
      warnings.push(dnsStrict() ? 'BIND is not installed: A records cannot be published on a production server, so every account with records to rewrite fails and is rolled back (install bind9/bind first, or run with "require installed services" to refuse the run)'
        : 'BIND is not installed: zone changes are saved and published when it is');
    }
    if (updateDns && !caps.dns.loaded) warnings.push('DNS Functions is not loaded: A records are not rewritten');
    const totals = {
      accounts: items.length, change: items.filter((i) => i.status === 'change').length, unchanged: items.filter((i) => i.status === 'unchanged').length, blocked: items.filter((i) => i.status === 'blocked').length,
      dedicated: items.filter((i) => i.dedicated).length, records: items.reduce((n, i) => n + (i.status === 'change' ? i.records : 0), 0), vhosts: items.reduce((n, i) => n + (i.status === 'change' ? i.vhosts : 0), 0),
    };
    return { items, totals, warnings, capabilities: caps, options: { updateDns, updateVhosts }, ok: totals.blocked === 0 && totals.change > 0 };
  }

  function requireDaemons(caps, { web, dns, quota, php }) {
    if (web && caps.web.loaded && !caps.web.installed) throw new CapabilityError('apache', 'Apache is not installed, so the virtual hosts cannot be rewritten now. Install apache2 (Debian/Ubuntu) or httpd (RHEL), or run without "require installed services" to queue the change.');
    if (dns && caps.dns.loaded && !caps.dns.installed) throw new CapabilityError('bind', 'BIND is not installed, so the DNS records cannot be published now. Install bind9 (Debian/Ubuntu) or bind (RHEL), or run without "require installed services" to save the zones for later.');
    if (quota && !caps.quota.installed) throw new CapabilityError('quota', 'The quota tools (setquota/repquota) are not installed, so disk quotas cannot be enforced now. Install the quota package, or run without "require installed services" to record the limits only.');
    if (php && caps.php.loaded && !caps.web.installed) throw new CapabilityError('apache', 'Apache is not installed, so the PHP version of the package cannot be applied to the virtual hosts now.');
  }

  function startChangeIp(input, user, req) {
    const preview = previewChangeIp(input, user);
    if (preview.totals.blocked) throw unprocessable('The plan has problems', { changes: preview.items.filter((i) => i.status === 'blocked').flatMap((i) => i.issues.map((m) => `${i.username}: ${m}`)) });
    if (!preview.totals.change) throw unprocessable('Every selected account already uses the requested address', { changes: ['Nothing to change'] });
    if (input.requireDaemons) requireDaemons(preview.capabilities, { web: preview.options.updateVhosts, dns: preview.options.updateDns });
    const params = { updateDns: preview.options.updateDns, updateVhosts: preview.options.updateVhosts, accounts: preview.totals.accounts };
    const items = preview.items.map((i) => ({
      accountId: i.accountId, username: i.username, domain: i.domain, status: i.status === 'unchanged' ? 'unchanged' : 'queued', detail: i.status === 'unchanged' ? `already uses ${i.to}` : null,
      before: { ip: i.from }, after: i.status === 'unchanged' ? { ip: i.to } : {}, steps: { plan: { ip: i.to, dedicated: i.dedicated, records: i.records, vhosts: i.vhosts } },
    }));
    const runId = createRun('change_ip', { user, params, items });
    const job = jobs.enqueue('multi_account.change_ip', { runId, userId: user.id ?? null }, { userId: user.id ?? null });
    stmts.setRunJob.run(job.id, runId);
    audit(req, { action: 'multi_account.ip.start', target: `run:${runId}`, args: { job: job.id, accounts: preview.totals.change, unchanged: preview.totals.unchanged, ...preview.options } });
    return { job, run: shapeRun(stmts.run.get(runId), { withItems: true }), preview };
  }

  async function changeAccountIp(account, ip, { updateDns, updateVhosts }, user, req) {
    const previous = account.ip;
    const ipSvc = ctx.ip;
    const steps = { ip: { status: 'applied', from: previous, to: ip }, dedicated: null, web: null, dns: [] };
    if (familyOf(ip) !== 4) throw unprocessable(`${ip} is an IPv6 address; this function moves accounts between IPv4 addresses only`, { ip: ['IPv4 required'] });
    const issues = inventoryIssues(ip, account.username);
    if (issues.length) throw unprocessable(issues.join('; '), { ip: issues });
    // ip-functions treats an address any account uses as taken, so the dedication
    // decision and allocateDedicated (which sets accounts.ip itself) come before
    // the row moves. Vhost and zone renderers then read the new accounts.ip; the
    // dedication and the row are put back when a later step throws or fails.
    // The checks above, the decision and the allocation share one synchronous
    // stretch so a concurrent run cannot claim the address in between.
    const dedicatedBefore = ipSvc ? ipSvc.all().filter((r) => r.dedicated_to === account.username).map((r) => r.address) : [];
    const keepsDedication = dedicatedBefore.includes(ip);
    const dedicate = Boolean(ipSvc) && !keepsDedication && ip !== ipSvc.sharedIp() && ipSvc.freeAddresses(4).some((r) => r.address === ip);
    const releases = Boolean(ipSvc) && dedicatedBefore.length > 0 && !keepsDedication;
    // Zones and vhosts of an account that never had its own address were
    // rendered with the shared address, so that is what gets replaced.
    const replaced = previous || sharedAddress();
    const applied = { released: false, dedicated: false, dns: [], web: false };
    let restored = false;
    const restore = async () => {
      if (restored) return;
      restored = true;
      if (applied.dedicated) ipSvc.releaseDedicated(account.id, req);
      if (applied.released) for (const address of dedicatedBefore) { try { ipSvc.allocateDedicated(account.id, req, { address }); } catch (err) { logger.warn({ err, address }, 'multi-account: could not re-dedicate the previous address'); } }
      stmts.setIp.run(previous, account.id);
      for (const { domain, name, values } of applied.dns) {
        try { await ctx.dns.upsertRecords(domain, name, 'A', values, req); } catch (err) { logger.warn({ err, domain, name }, 'multi-account: could not put the A record back'); }
      }
      if (applied.web) {
        try { if (ctx.web.replaceIp) await ctx.web.replaceIp(ip, replaced, { accounts: [account.username] }, req); else await ctx.web.ensureVhost(account.username, req); }
        catch (err) { if (!isCapabilityMissing(err)) logger.warn({ err, username: account.username }, 'multi-account: could not rewrite the vhosts with the previous address'); }
      }
      steps.ip = { status: 'rolled_back', from: previous, to: ip };
      steps.dedicated = null;
    };
    try {
      if (releases) { ipSvc.releaseDedicated(account.id, req); applied.released = true; }
      if (dedicate) { ipSvc.allocateDedicated(account.id, req, { address: ip }); applied.dedicated = true; }
      else stmts.setIp.run(ip, account.id);
      if (dedicate || keepsDedication) steps.dedicated = ip;
      if (!updateVhosts) steps.web = { status: 'skipped', detail: 'not requested' };
      else if (!ctx.web) steps.web = { status: 'skipped', detail: 'Service Configuration is not loaded' };
      else if (replaced === ip) steps.web = { status: 'skipped', detail: `the stored virtual hosts already use ${ip}` };
      else {
        const { touched, ...web } = await rewriteVhosts(account, replaced, ip, req);
        applied.web = touched;
        steps.web = web;
      }
      if (steps.web.status !== 'failed') {
        if (!updateDns) steps.dns.push({ domain: null, status: 'skipped', detail: 'not requested' });
        else if (!ctx.dns) steps.dns.push({ domain: null, status: 'skipped', detail: 'DNS Functions is not loaded' });
        else if (!replaced) steps.dns.push({ domain: null, status: 'skipped', detail: 'the account had no address to replace' });
        else if (replaced === ip) steps.dns.push({ domain: null, status: 'skipped', detail: `the zones already point at ${ip}` });
        else {
          const zones = stmts.zonesOf.all(account.id);
          if (!zones.length) steps.dns.push({ domain: null, status: 'skipped', detail: 'the account has no DNS zones' });
          for (const { domain } of zones) {
            let zone;
            try { zone = await ctx.dns.getZone(domain, user); } catch (err) { steps.dns.push({ domain, status: 'failed', detail: err.message }); break; }
            const stale = zone.records.filter((r) => r.type === 'A' && r.value === replaced);
            if (!stale.length) { steps.dns.push({ domain, status: 'skipped', detail: `no A record pointed at ${replaced}` }); continue; }
            for (const name of new Set(stale.map((r) => r.name))) {
              const current = zone.records.filter((r) => r.type === 'A' && r.name === name);
              const values = current.map((r) => ({ value: r.value === replaced ? ip : r.value, ttl: r.ttl }));
              try {
                const pub = await ctx.dns.upsertRecords(domain, name, 'A', values, req);
                applied.dns.push({ domain, name, values: current.map((r) => ({ value: r.value, ttl: r.ttl })) });
                steps.dns.push({ domain, name, status: pub?.applied ? 'applied' : 'pending', detail: pub?.applied ? 'A record updated and published' : pub?.reason || 'saved; published once BIND runs' });
              } catch (err) {
                // dns-functions restores the zone when it cannot publish in strict
                // (production) mode, so a daemon-missing error only means "pending"
                // when the new value really was saved.
                let saved = false;
                if (isCapabilityMissing(err)) { try { saved = (await ctx.dns.getZone(domain, user)).records.some((r) => r.type === 'A' && r.name === name && r.value === ip); } catch { saved = false; } }
                if (saved) { applied.dns.push({ domain, name, values: current.map((r) => ({ value: r.value, ttl: r.ttl })) }); steps.dns.push({ domain, name, status: 'pending', detail: err.message }); }
                else steps.dns.push({ domain, name, status: 'failed', detail: isCapabilityMissing(err) ? `${err.message}; the A record was not saved` : err.message });
              }
            }
            if (steps.dns.some((d) => d.domain === domain && d.status === 'failed')) break;
          }
        }
      }
      if (outcomeOf(steps).status === 'failed') await restore();
    } catch (err) {
      try { await restore(); } catch (undoErr) { logger.error({ err: undoErr, username: account.username }, 'multi-account: could not put the address back'); }
      throw err;
    }
    audit(req, { action: 'account.ip.change', target: account.username, args: { from: previous, to: ip, dedicated: steps.dedicated, web: steps.web?.status, dns: steps.dns.length, rolledBack: steps.ip.status === 'rolled_back', bulk: true } });
    return steps;
  }

  const outcomeOf = (steps) => {
    const all = [steps.web, steps.quota, steps.php, ...(steps.dns || [])].filter(Boolean);
    if (all.some((s) => s.status === 'failed')) return { status: 'failed', detail: all.filter((s) => s.status === 'failed').map((s) => `${s.domain || s.name || 'step'}: ${s.detail}`).join('; ') };
    if (all.some((s) => s.status === 'pending')) return { status: 'pending', detail: all.filter((s) => s.status === 'pending').map((s) => s.detail).filter((v, i, arr) => arr.indexOf(v) === i).join('; ') };
    return { status: 'done', detail: null };
  };

  async function runChangeIp(jobCtx) {
    const { runId, userId } = jobCtx.params;
    const run = stmts.run.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    let req;
    try { req = actorRequest(userId ?? run.created_by, `job:${jobCtx.job?.id ?? ''}`); } catch (err) { abandonRun(runId, err.message); throw err; }
    const user = req.user;
    const params = json.parse(run.params_json, {});
    stmts.runStatus.run('running', runId);
    const items = stmts.queuedItems.all(runId);
    jobCtx.log(`Changing the IP address of ${items.length} account(s)${params.updateVhosts ? ', rewriting virtual hosts' : ''}${params.updateDns ? ', rewriting A records' : ''}`);
    for (const [i, item] of items.entries()) {
      const steps = json.parse(item.steps_json, {});
      const ip = steps.plan?.ip;
      stmts.itemStatus.run('running', item.id);
      jobCtx.progress((i / items.length) * 100, `${item.username} → ${ip}`);
      const account = stmts.byUsername.get(item.username);
      if (!account || (!isRoot(user) && account.owner_id !== user.id)) { finishItem(item, { status: 'skipped', detail: 'account no longer exists or is not yours', steps }); jobCtx.log(`${item.username}: skipped (account gone)`, 'warn'); continue; }
      if (account.ip === ip) { finishItem(item, { status: 'unchanged', detail: `already uses ${ip}`, after: { ip }, steps }); jobCtx.log(`${item.username}: already uses ${ip}`); continue; }
      try {
        const result = await changeAccountIp(account, ip, params, user, req);
        const outcome = outcomeOf(result);
        const rolledBack = result.ip?.status === 'rolled_back';
        finishItem(item, { status: outcome.status, detail: rolledBack ? `${outcome.detail}; the account stays on ${account.ip || 'no address'}` : outcome.detail, after: { ip: rolledBack ? account.ip : ip }, steps: { ...steps, ...result } });
        jobCtx.log(`${item.username}: ${account.ip || 'unset'} → ${ip} (${outcome.status}${outcome.detail ? `: ${outcome.detail}` : ''})`, outcome.status === 'failed' ? 'error' : outcome.status === 'pending' ? 'warn' : 'info');
      } catch (err) {
        // changeAccountIp restores the row, dedication, records and vhosts before
        // rethrowing, so a thrown error always means the account kept its address.
        finishItem(item, { status: 'failed', detail: err.message, after: { ip: account.ip }, steps: { ...steps, ip: { status: 'rolled_back', from: account.ip, to: ip } } });
        jobCtx.log(`${item.username}: ${err.message}; the account stays on ${account.ip || 'no address'}`, 'error');
      }
    }
    const totals = totalsOf(runId);
    stmts.finishRun.run(totals.failed && totals.failed === items.length ? 'failed' : 'done', JSON.stringify(totals), runId);
    jobCtx.progress(100, `${totals.done} changed, ${totals.pending} pending, ${totals.failed} failed`);
    audit(req, { action: 'multi_account.ip.result', target: `run:${runId}`, args: totals });
    return { runId, ...totals };
  }

  // ---------------------------------------------------- modify / upgrade ---

  function planFor(name, user) {
    try { packages.get(name, user); } catch (err) { if (err.status === 404 || err.status === 403) throw unprocessable(`Package "${name}" ${err.status === 403 ? 'belongs to another reseller' : 'does not exist'}`, { 'changes.package': [err.status === 403 ? 'Not yours' : 'Unknown package'] }); throw err; }
    return packages.snapshot(name);
  }

  // Mirrors what ctx.accounts.modify does to the row, so the preview shows the
  // same values the job ends up writing.
  function nextState(account, changes, plan) {
    const next = { package_name: account.package_name, disk_quota_mb: account.disk_quota_mb, bandwidth_limit_mb: account.bandwidth_limit_mb, shell: account.shell, contact_email: account.contact_email, demo_mode: Boolean(account.demo_mode), force_password_change: Boolean(account.force_password_change), owner: account.owner };
    if (changes.contactEmail !== undefined) next.contact_email = changes.contactEmail;
    if (changes.demoMode !== undefined) next.demo_mode = changes.demoMode;
    if (changes.forcePasswordChange !== undefined) next.force_password_change = changes.forcePasswordChange;
    if (changes.diskQuotaMb !== undefined) next.disk_quota_mb = changes.diskQuotaMb;
    if (changes.bandwidthLimitMb !== undefined) next.bandwidth_limit_mb = changes.bandwidthLimitMb;
    if (changes.package) {
      next.package_name = changes.package; next.disk_quota_mb = plan.disk_mb; next.bandwidth_limit_mb = plan.bandwidth_mb;
      next.shell = plan.has_shell ? (account.shell === '/usr/sbin/nologin' ? '/bin/bash' : account.shell) : '/usr/sbin/nologin';
    }
    if (changes.shell) next.shell = changes.shell;
    if (changes.owner) next.owner = changes.owner;
    return next;
  }

  // Reseller privileges the bulk path must enforce itself (integration contract
  // §10); package/quota/bandwidth limits go through ctx.resellers.modifyPolicy
  // per account, as accounts.modify does again when the job runs.
  function assertModifyAcls(changes, user) {
    if (isRoot(user)) return;
    if (changes.demoMode !== undefined) ctx.resellers?.assertAcl?.(user, 'demo-setup');
    if (changes.shell && changes.shell !== '/usr/sbin/nologin') {
      ctx.resellers?.assertAcl?.(user, 'add-pkg-shell');
      if (ctx.resellers?.aclsFor?.(user.id)?.has('disallow-shell')) throw forbidden('Your reseller privileges forbid granting shell access (Disallow Shell Access); only /usr/sbin/nologin can be set');
    }
  }

  // A package with shell access grants a shell to accounts that had none; a
  // reseller needs the same privilege for that as for an explicit shell.
  function shellIssue(before, after, changes, user) {
    if (isRoot(user) || !changes.package || before.shell === after.shell || after.shell === '/usr/sbin/nologin') return null;
    if (ctx.resellers?.aclsFor?.(user.id)?.has('disallow-shell')) return `package "${changes.package}" grants shell access, which your reseller privileges forbid (Disallow Shell Access)`;
    if (ctx.resellers?.hasAcl && !ctx.resellers.hasAcl(user, 'add-pkg-shell')) return `package "${changes.package}" grants shell access, which needs the Shell Access (add-pkg-shell) privilege`;
    return null;
  }

  function policyIssue(account, next, changes, user) {
    if (isRoot(user) || !ctx.resellers?.modifyPolicy) return null;
    try {
      ctx.resellers.modifyPolicy(user, account, { pkgName: changes.package, diskQuotaMb: next.disk_quota_mb, bandwidthLimitMb: next.bandwidth_limit_mb });
      return null;
    } catch (err) {
      if (err.status === 403 || err.status === 409) return err.message;
      throw err;
    }
  }

  function previewModify({ usernames, all, filter, changes, applyPhp = true }, user) {
    if (changes.owner && !isRoot(user)) throw forbidden('Only root can move accounts to another owner');
    assertModifyAcls(changes, user);
    if (changes.owner && !stmts.ownerByUsername.get(changes.owner)) throw unprocessable(`Owner "${changes.owner}" is not a reseller`, { 'changes.owner': ['Unknown owner'] });
    const plan = changes.package ? planFor(changes.package, user) : null;
    const { accounts, missing } = selectAccounts({ usernames, all, filter }, user);
    if (accounts.length > maxBatch()) throw unprocessable(`At most ${maxBatch()} accounts per run (multi_account.max_batch)`, { usernames: ['Too many accounts'] });
    const fieldMap = { package_name: 'package', disk_quota_mb: 'diskQuotaMb', bandwidth_limit_mb: 'bandwidthLimitMb', shell: 'shell', contact_email: 'contactEmail', demo_mode: 'demoMode', force_password_change: 'forcePasswordChange', owner: 'owner' };
    const items = accounts.map((a) => {
      const before = nextState(a, {}, null);
      const after = nextState(a, changes, plan);
      const diff = Object.entries(fieldMap).filter(([col]) => before[col] !== after[col]).map(([col, field]) => ({ field, label: FIELD_LABELS[field], from: before[col], to: after[col] }));
      // Re-applying the current package resyncs its snapshot, as WHM's upgrade flow does.
      if (changes.package && before.package_name === after.package_name) diff.push({ field: 'package', label: `${FIELD_LABELS.package} (re-apply)`, from: before.package_name, to: after.package_name });
      const currentPhp = json.parse(a.plan_snapshot_json, {})?.php_version ?? null;
      const phpChanges = applyPhp && changes.package && plan?.php_version && (before.package_name !== after.package_name || currentPhp !== plan.php_version);
      const php = phpChanges ? { version: plan.php_version, from: currentPhp, available: Boolean(ctx.web?.setPhpVersion) } : null;
      if (php && php.available) diff.push({ field: 'phpVersion', label: FIELD_LABELS.phpVersion, from: currentPhp, to: plan.php_version });
      const issue = diff.length ? shellIssue(before, after, changes, user) || policyIssue(a, after, changes, user) : null;
      return { accountId: a.id, username: a.username, domain: a.domain, owner: a.owner, status: issue ? 'blocked' : diff.length ? 'change' : 'unchanged', issues: issue ? [issue] : [], before, after, changes: diff, php, quota: after.disk_quota_mb !== before.disk_quota_mb };
    });
    for (const u of missing) items.push({ username: u, domain: null, owner: null, status: 'blocked', issues: ['Account not found or not yours'], before: {}, after: {}, changes: [], php: null, quota: false });
    const caps = capabilityStatus();
    const warnings = [];
    if (items.some((i) => i.quota) && !caps.quota.installed) warnings.push('Quota tools are not installed: disk limits are recorded but not enforced on the filesystem until they are');
    if (items.some((i) => i.php) && !ctx.web?.setPhpVersion) warnings.push('Service Configuration is not loaded: the package\'s PHP version is not applied to the virtual hosts');
    if (items.some((i) => i.php?.available) && !caps.web.installed) warnings.push('Apache is not installed: the PHP version is stored with the vhost spec and applied when it is');
    const totals = { accounts: items.length, change: items.filter((i) => i.status === 'change').length, unchanged: items.filter((i) => i.status === 'unchanged').length, blocked: items.filter((i) => i.status === 'blocked').length, fields: Object.keys(changes).length };
    return { items, totals, warnings, capabilities: caps, changes, plan, ok: totals.blocked === 0 && totals.change > 0 };
  }

  function startModify(input, user, req) {
    const preview = previewModify(input, user);
    if (preview.totals.blocked) throw unprocessable('Some accounts cannot be modified', { usernames: preview.items.filter((i) => i.status === 'blocked').map((i) => `${i.username}: ${i.issues.join(', ')}`) });
    if (!preview.totals.change) throw unprocessable('The selected accounts already have these values', { changes: ['Nothing to change'] });
    if (input.requireDaemons) requireDaemons(preview.capabilities, { quota: preview.items.some((i) => i.quota), php: preview.items.some((i) => i.php?.available) });
    const params = { changes: input.changes, applyPhp: input.applyPhp !== false, selection: input.all ? { all: true, filter: input.filter ?? null } : { usernames: input.usernames }, accounts: preview.totals.accounts };
    const items = preview.items.map((i) => ({
      accountId: i.accountId, username: i.username, domain: i.domain, status: i.status === 'unchanged' ? 'unchanged' : 'queued', detail: i.status === 'unchanged' ? 'already has these values' : null,
      before: i.before, after: i.status === 'unchanged' ? i.after : {}, steps: { plan: { changes: i.changes, php: i.php?.available ? i.php.version : null, quota: i.quota } },
    }));
    const runId = createRun('modify', { user, params, items });
    const job = jobs.enqueue('multi_account.modify', { runId, userId: user.id ?? null }, { userId: user.id ?? null });
    stmts.setRunJob.run(job.id, runId);
    audit(req, { action: 'multi_account.modify.start', target: `run:${runId}`, args: { job: job.id, accounts: preview.totals.change, unchanged: preview.totals.unchanged, changes: input.changes } });
    return { job, run: shapeRun(stmts.run.get(runId), { withItems: true }), preview };
  }

  async function runModify(jobCtx) {
    const { runId, userId } = jobCtx.params;
    const run = stmts.run.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    let req;
    try { req = actorRequest(userId ?? run.created_by, `job:${jobCtx.job?.id ?? ''}`); } catch (err) { abandonRun(runId, err.message); throw err; }
    const user = req.user;
    const { changes = {}, applyPhp = true } = json.parse(run.params_json, {});
    const patch = Object.fromEntries(Object.entries(changes).filter(([k, v]) => MODIFY_FIELDS.includes(k) && v !== undefined));
    stmts.runStatus.run('running', runId);
    const items = stmts.queuedItems.all(runId);
    jobCtx.log(`Modifying ${items.length} account(s): ${Object.entries(patch).map(([k, v]) => `${FIELD_LABELS[k] || k} = ${v === null ? 'unlimited' : v}`).join(', ')}`);
    let phpApplied = 0;
    for (const [i, item] of items.entries()) {
      const steps = json.parse(item.steps_json, {});
      stmts.itemStatus.run('running', item.id);
      jobCtx.progress((i / items.length) * 100, item.username);
      const account = stmts.byUsername.get(item.username);
      if (!account || (!isRoot(user) && account.owner_id !== user.id)) { finishItem(item, { status: 'skipped', detail: 'account no longer exists or is not yours', steps }); jobCtx.log(`${item.username}: skipped (account gone)`, 'warn'); continue; }
      try {
        const updated = await ctx.accounts.modify(item.username, patch, user, req);
        const result = { account: { status: 'applied', detail: `${steps.plan?.changes?.length ?? 0} field(s) updated` } };
        if (steps.plan?.quota) {
          // accounts.modify reports the setquota outcome itself (applied,
          // pending until Initial Quota Setup, or failed) whenever it ran it.
          const limit = updated.disk_quota_mb == null ? 'unlimited' : `${updated.disk_quota_mb} MB`;
          result.quota = updated.quota ? { status: updated.quota.status, detail: `${limit}: ${updated.quota.detail}` }
            : account.uid == null ? { status: 'skipped', detail: 'no system user on this host' }
              : !capabilities.has('quota') ? { status: 'pending', detail: 'quota tools are not installed; the limit is enforced once they are' }
                : { status: 'unchanged', detail: `the account already had ${limit}` };
        }
        if (applyPhp && steps.plan?.php && ctx.web?.setPhpVersion) {
          try { await ctx.web.setPhpVersion(account.domain, steps.plan.php, req, { reload: false }); phpApplied++; result.php = { status: 'applied', detail: `PHP ${steps.plan.php} applied to ${account.domain}` }; }
          catch (err) {
            if (isCapabilityMissing(err)) result.php = { status: 'pending', detail: 'Apache is not installed; the PHP version is applied with the vhost' };
            else if (err.status === 404) result.php = { status: 'skipped', detail: 'no virtual host is stored for the domain yet' };
            else result.php = { status: 'failed', detail: err.message };
          }
        }
        const outcome = outcomeOf(result);
        const after = nextState(stmts.byUsername.get(item.username), {}, null);
        finishItem(item, { status: outcome.status, detail: outcome.detail, after, steps: { ...steps, ...result } });
        jobCtx.log(`${item.username}: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ''}`, outcome.status === 'failed' ? 'error' : outcome.status === 'pending' ? 'warn' : 'info');
      } catch (err) {
        const status = isCapabilityMissing(err) ? 'pending' : 'failed';
        finishItem(item, { status, detail: err.message, steps });
        jobCtx.log(`${item.username}: ${err.message}`, status === 'failed' ? 'error' : 'warn');
      }
    }
    // The vhosts were written without a reload each; one reload makes them live.
    if (phpApplied && ctx.web?.reload) {
      try { await ctx.web.reload(req); jobCtx.log(`Web server reloaded once for ${phpApplied} PHP change(s)`); }
      catch (err) { jobCtx.log(`Web server reload failed after ${phpApplied} PHP change(s): ${err.message}`, 'warn'); logger.warn({ err }, 'multi-account: web reload after PHP changes failed'); }
    }
    const totals = totalsOf(runId);
    stmts.finishRun.run(totals.failed && totals.failed === items.length ? 'failed' : 'done', JSON.stringify(totals), runId);
    jobCtx.progress(100, `${totals.done} modified, ${totals.pending} pending, ${totals.failed} failed`);
    audit(req, { action: 'multi_account.modify.result', target: `run:${runId}`, args: totals });
    return { runId, ...totals };
  }

  // --------------------------------------------------------------- reports ---

  function report(id, format, user) {
    const run = shapeRun(loadRun(id, user), { withItems: true });
    const stamp = String(run.created_at || '').replace(/[^0-9]/g, '').slice(0, 12) || 'run';
    if (format === 'json') return { filename: `multi-account-${run.kind}-${run.id}-${stamp}.json`, contentType: 'application/json; charset=utf-8', body: JSON.stringify(run, null, 2) };
    const headers = ['run', 'kind', 'username', 'domain', 'status', 'detail', 'before', 'after', 'steps', 'finished_at'];
    const rows = run.items.map((it) => [run.id, run.kind, it.username, it.domain, it.status, it.detail, it.before, it.after, it.steps, it.finished_at]);
    return { filename: `multi-account-${run.kind}-${run.id}-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', body: toCsv(headers, rows) };
  }

  function cleanup(jobCtx) {
    const days = Math.max(1, Number(settings.get('multi_account.run_retention_days', 90)) || 90);
    const removed = stmts.pruneRuns.run(`-${days} days`).changes;
    jobCtx?.log?.(`Removed ${removed} run(s) older than ${days} days`);
    return { removed, days };
  }

  return {
    listAccounts(query, user) {
      if (!isRoot(user)) ctx.resellers?.assertAcl?.(user, 'list-accts');
      const rows = visibleAccounts(user);
      const data = rows.filter((a) => matches(a, query)).map(summary);
      const sortKey = query.sort || 'username';
      const dir = query.dir === 'desc' ? -1 : 1;
      data.sort((a, b) => { const x = a[sortKey] ?? ''; const y = b[sortKey] ?? ''; return (x < y ? -1 : x > y ? 1 : 0) * dir; });
      const uniq = (key) => [...new Set(rows.map((a) => a[key]).filter(Boolean))].sort();
      return { data, meta: { total: data.length, all: rows.length, filters: { owners: uniq('owner'), packages: uniq('package_name'), ips: uniq('ip') }, maxBatch: maxBatch() } };
    },
    capabilities: capabilityStatus,
    ipAddresses() {
      const usage = new Map();
      for (const a of stmts.all.all()) if (a.ip) usage.set(a.ip, (usage.get(a.ip) || 0) + 1);
      if (ctx.ip) {
        const shared = ctx.ip.sharedIp();
        return ctx.ip.all().filter((r) => r.family === 4).map((r) => ({ address: r.address, family: r.family, is_main: r.is_main, reserved: r.reserved, reserved_reason: r.reserved_reason, dedicated_to: r.dedicated_to, shared: r.address === shared, accounts: usage.get(r.address) || 0, selectable: !r.reserved && !r.dedicated_to }));
      }
      const main = settings.get('basic.main_ip') || null;
      const shared = settings.get('basic.shared_ip') || main;
      return [...new Set([main, shared, ...usage.keys()].filter((a) => a && familyOf(a) === 4))].map((address) => ({ address, family: 4, is_main: address === main, reserved: false, reserved_reason: null, dedicated_to: null, shared: address === shared, accounts: usage.get(address) || 0, selectable: true }));
    },
    previewChangeIp, startChangeIp, runChangeIp,
    previewModify, startModify, runModify,
    listRuns({ kind, limit = 50 } = {}, user) {
      return stmts.runs.all({ kind: kind ?? null, owner: isRoot(user) ? null : user.id, limit }).map((r) => ({ ...shapeRun(r), totals: Object.keys(json.parse(r.totals_json, {})).length ? json.parse(r.totals_json, {}) : totalsOf(r.id) }));
    },
    reconcileRuns,
    getRun: (id, user) => { const run = shapeRun(loadRun(id, user), { withItems: true }); return { ...run, totals: Object.keys(run.totals).length ? run.totals : totalsOf(run.id) }; },
    report, cleanup,
    selectAccounts, capabilityStatus,
  };
}
