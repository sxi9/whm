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
// (dedication), ctx.web (vhosts, PHP) and ctx.dns (A records). A missing daemon
// leaves an item 'pending' instead of failing the run.

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

  // Marks every queued item skipped and the run failed when it cannot start.
  function abandonRun(runId, reason) {
    db.transaction(() => {
      for (const item of stmts.queuedItems.all(runId)) finishItem(item, { status: 'skipped', detail: reason, steps: json.parse(item.steps_json, {}) });
      stmts.finishRun.run('failed', JSON.stringify(totalsOf(runId)), runId);
    })();
  }

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
  function selectAccounts({ usernames, all, filter }, user) {
    if (all) return { accounts: visibleAccounts(user).filter((a) => matches(a, filter)), missing: [] };
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

  function previewChangeIp({ changes, updateDns = true, updateVhosts = true }, user) {
    if (changes.length > maxBatch()) throw unprocessable(`At most ${maxBatch()} accounts per run (multi_account.max_batch)`, { changes: ['Too many accounts'] });
    const ipSvc = ctx.ip;
    const shared = ipSvc ? ipSvc.sharedIp() : settings.get('basic.shared_ip') || settings.get('basic.main_ip') || null;
    const free = ipSvc ? new Set([...ipSvc.freeAddresses(4), ...ipSvc.freeAddresses(6)].map((r) => r.address)) : new Set();
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
      if (ipSvc) {
        const known = ipSvc.get(ip);
        if (!known) item.issues.push(`${ip} is not configured on this server; add it under IP Functions first`);
        else {
          if (known.reserved) item.issues.push(`${ip} is reserved (${known.reserved_reason || 'no reason given'})`);
          if (known.dedicated_to && known.dedicated_to !== username) item.issues.push(`${ip} is dedicated to ${known.dedicated_to}`);
          if (ip !== shared && free.has(ip)) {
            if (claimed.has(ip)) item.issues.push(`${ip} is a free address that becomes dedicated to ${claimed.get(ip)}; it cannot be given to a second account`);
            else { claimed.set(ip, username); item.dedicated = true; }
          }
        }
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
    if (updateDns && caps.dns.loaded && !caps.dns.installed) warnings.push('BIND is not installed: zone changes are saved and published when it is');
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
    // ip-functions treats an address any account uses as taken, so the dedication
    // decision and allocateDedicated (which sets accounts.ip itself) come before
    // the row moves. Vhost and zone renderers then read the new accounts.ip; the
    // dedication and the row are put back when a later step throws.
    const dedicatedBefore = ipSvc ? ipSvc.all().filter((r) => r.dedicated_to === account.username).map((r) => r.address) : [];
    const keepsDedication = dedicatedBefore.includes(ip);
    const dedicate = Boolean(ipSvc) && !keepsDedication && ip !== ipSvc.sharedIp() && ipSvc.freeAddresses(familyOf(ip)).some((r) => r.address === ip);
    const releases = Boolean(ipSvc) && dedicatedBefore.length > 0 && !keepsDedication;
    const restore = () => {
      if (dedicate) ipSvc.releaseDedicated(account.id, req);
      if (releases) for (const address of dedicatedBefore) { try { ipSvc.allocateDedicated(account.id, req, { address }); } catch (err) { logger.warn({ err, address }, 'multi-account: could not re-dedicate the previous address'); } }
      stmts.setIp.run(previous, account.id);
    };
    if (releases) ipSvc.releaseDedicated(account.id, req);
    if (dedicate) ipSvc.allocateDedicated(account.id, req, { address: ip });
    else stmts.setIp.run(ip, account.id);
    if (dedicate || keepsDedication) steps.dedicated = ip;
    try {
      if (!updateVhosts) steps.web = { status: 'skipped', detail: 'not requested' };
      else if (!ctx.web) steps.web = { status: 'skipped', detail: 'Service Configuration is not loaded' };
      else {
        const web = await ctx.web.ensureVhost(account.username, req);
        steps.web = web.applied ? { status: 'applied', detail: `${web.vhosts?.length ?? 0} vhost(s) rewritten${web.reload?.reloaded ? ', web server reloaded' : ''}` }
          : web.reason === 'capability_missing' ? { status: 'pending', detail: 'Apache is not installed; the vhosts are written when it is' }
            : { status: 'failed', detail: web.vhosts?.find((v) => !v.applied)?.error || web.reason || 'vhost not applied' };
      }
      if (!updateDns) steps.dns.push({ domain: null, status: 'skipped', detail: 'not requested' });
      else if (!ctx.dns) steps.dns.push({ domain: null, status: 'skipped', detail: 'DNS Functions is not loaded' });
      else if (!previous) steps.dns.push({ domain: null, status: 'skipped', detail: 'the account had no address to replace' });
      else {
        for (const { domain } of stmts.zonesOf.all(account.id)) {
          try {
            const zone = await ctx.dns.getZone(domain, user);
            const stale = zone.records.filter((r) => r.type === 'A' && r.value === previous);
            if (!stale.length) { steps.dns.push({ domain, status: 'skipped', detail: 'no A record pointed at the old address' }); continue; }
            for (const name of new Set(stale.map((r) => r.name))) {
              const values = zone.records.filter((r) => r.type === 'A' && r.name === name).map((r) => ({ value: r.value === previous ? ip : r.value, ttl: r.ttl }));
              const pub = await ctx.dns.upsertRecords(domain, name, 'A', values, req);
              steps.dns.push({ domain, name, status: pub?.applied ? 'applied' : 'pending', detail: pub?.applied ? 'A record updated and published' : pub?.reason || 'saved; published once BIND runs' });
            }
          } catch (err) {
            if (isCapabilityMissing(err)) steps.dns.push({ domain, status: 'pending', detail: err.message });
            else steps.dns.push({ domain, status: 'failed', detail: err.message });
          }
        }
      }
    } catch (err) {
      try { restore(); } catch (undoErr) { logger.error({ err: undoErr, username: account.username }, 'multi-account: could not put the address back'); }
      throw err;
    }
    audit(req, { action: 'account.ip.change', target: account.username, args: { from: previous, to: ip, dedicated: steps.dedicated, web: steps.web?.status, dns: steps.dns.length, bulk: true } });
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
        finishItem(item, { status: outcome.status, detail: outcome.detail, after: { ip }, steps: { ...steps, ...result } });
        jobCtx.log(`${item.username}: ${account.ip || 'unset'} → ${ip} (${outcome.status}${outcome.detail ? `: ${outcome.detail}` : ''})`, outcome.status === 'failed' ? 'error' : outcome.status === 'pending' ? 'warn' : 'info');
      } catch (err) {
        const status = isCapabilityMissing(err) ? 'pending' : 'failed';
        finishItem(item, { status, detail: err.message, steps });
        jobCtx.log(`${item.username}: ${err.message}`, status === 'failed' ? 'error' : 'warn');
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

  function previewModify({ usernames, all, filter, changes, applyPhp = true }, user) {
    if (changes.owner && !isRoot(user)) throw forbidden('Only root can move accounts to another owner');
    if (changes.owner && !stmts.ownerByUsername.get(changes.owner)) throw unprocessable(`Owner "${changes.owner}" is not a reseller`, { 'changes.owner': ['Unknown owner'] });
    const plan = changes.package ? planFor(changes.package, user) : null;
    const { accounts, missing } = selectAccounts({ usernames, all, filter }, user);
    if (accounts.length > maxBatch()) throw unprocessable(`At most ${maxBatch()} accounts per run (multi_account.max_batch)`, { usernames: ['Too many accounts'] });
    const fieldMap = { package_name: 'package', disk_quota_mb: 'diskQuotaMb', bandwidth_limit_mb: 'bandwidthLimitMb', shell: 'shell', contact_email: 'contactEmail', demo_mode: 'demoMode', force_password_change: 'forcePasswordChange', owner: 'owner' };
    const items = accounts.map((a) => {
      const before = nextState(a, {}, null);
      const after = nextState(a, changes, plan);
      const diff = Object.entries(fieldMap).filter(([col]) => before[col] !== after[col]).map(([col, field]) => ({ field, label: FIELD_LABELS[field], from: before[col], to: after[col] }));
      const php = applyPhp && changes.package && plan?.php_version ? { version: plan.php_version, available: Boolean(ctx.web?.setPhpVersion) } : null;
      if (php && php.available) diff.push({ field: 'phpVersion', label: FIELD_LABELS.phpVersion, from: null, to: plan.php_version });
      return { accountId: a.id, username: a.username, domain: a.domain, owner: a.owner, status: diff.length ? 'change' : 'unchanged', issues: [], before, after, changes: diff, php, quota: after.disk_quota_mb !== before.disk_quota_mb };
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
          result.quota = account.uid == null ? { status: 'skipped', detail: 'no system user on this host' }
            : capabilities.has('quota') ? { status: 'applied', detail: `quota set to ${updated.disk_quota_mb == null ? 'unlimited' : `${updated.disk_quota_mb} MB`}` }
              : { status: 'pending', detail: 'quota tools are not installed; the limit is enforced once they are' };
        }
        if (applyPhp && steps.plan?.php && ctx.web?.setPhpVersion) {
          try { await ctx.web.setPhpVersion(account.domain, steps.plan.php, req); result.php = { status: 'applied', detail: `PHP ${steps.plan.php} applied to ${account.domain}` }; }
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
        return ctx.ip.all().map((r) => ({ address: r.address, family: r.family, is_main: r.is_main, reserved: r.reserved, reserved_reason: r.reserved_reason, dedicated_to: r.dedicated_to, shared: r.address === shared, accounts: usage.get(r.address) || 0, selectable: !r.reserved }));
      }
      const main = settings.get('basic.main_ip') || null;
      const shared = settings.get('basic.shared_ip') || main;
      return [...new Set([main, shared, ...usage.keys()].filter(Boolean))].map((address) => ({ address, family: familyOf(address), is_main: address === main, reserved: false, reserved_reason: null, dedicated_to: null, shared: address === shared, accounts: usage.get(address) || 0, selectable: true }));
    },
    previewChangeIp, startChangeIp, runChangeIp,
    previewModify, startModify, runModify,
    listRuns({ kind, limit = 50 } = {}, user) {
      return stmts.runs.all({ kind: kind ?? null, owner: isRoot(user) ? null : user.id, limit }).map((r) => ({ ...shapeRun(r), totals: Object.keys(json.parse(r.totals_json, {})).length ? json.parse(r.totals_json, {}) : totalsOf(r.id) }));
    },
    getRun: (id, user) => { const run = shapeRun(loadRun(id, user), { withItems: true }); return { ...run, totals: Object.keys(run.totals).length ? run.totals : totalsOf(run.id) }; },
    report, cleanup,
    selectAccounts, capabilityStatus,
  };
}
