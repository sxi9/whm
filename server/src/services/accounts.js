import { json, paginate } from '../db/index.js';
import { notFound, conflict, forbidden, badRequest, HttpError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

const RESERVED = new Set(['root', 'admin', 'administrator', 'nobody', 'www', 'mail', 'ftp', 'mysql', 'whm', 'cpanel', 'whmpanel']);

// A provisioning step that fails because the daemon is absent, or with a
// client-fault status the owning category chose (409 routing_not_applied…),
// is recorded on the account; anything else aborts and rolls the account back.
const softFailure = (err) => err?.code === 'capability_missing' || err?.code === 'binary_not_found' || (err instanceof HttpError && err.status < 500 && err.status !== 404);

export function createAccountsService(ctx) {
  const { db, agent, capabilities, packages, settings, config, logger } = ctx;
  const stmts = {
    byUsername: db.prepare(`SELECT a.*, u.username AS owner, m.username AS manager, m.role AS manager_role, m.email AS manager_email
      FROM accounts a JOIN users u ON u.id = a.owner_id LEFT JOIN users m ON m.id = a.manager_user_id WHERE a.username = ?`),
    byDomain: db.prepare('SELECT 1 FROM account_domains WHERE domain = ?'),
    insert: db.prepare(`INSERT INTO accounts (username, domain, owner_id, manager_user_id, package_id, package_name, ip, contact_email, plan_snapshot_json, shell, uid, gid, home_dir, disk_quota_mb, bandwidth_limit_mb)
      VALUES (@username, @domain, @owner_id, @manager_user_id, @package_id, @package_name, @ip, @contact_email, @plan, @shell, @uid, @gid, @home_dir, @disk_quota_mb, @bandwidth_limit_mb)`),
    insertDomain: db.prepare('INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, ?, ?, ?)'),
    domains: db.prepare('SELECT * FROM account_domains WHERE account_id = ? ORDER BY type, domain'),
    suspend: db.prepare("UPDATE accounts SET suspended = 1, suspend_reason = ?, suspended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"),
    unsuspend: db.prepare("UPDATE accounts SET suspended = 0, suspend_reason = NULL, suspended_at = NULL, updated_at = datetime('now') WHERE id = ?"),
    remove: db.prepare('DELETE FROM accounts WHERE id = ?'),
    update: db.prepare(`UPDATE accounts SET contact_email = @contact_email, package_id = @package_id, package_name = @package_name, plan_snapshot_json = @plan,
      ip = @ip, shell = @shell, disk_quota_mb = @disk_quota_mb, bandwidth_limit_mb = @bandwidth_limit_mb, demo_mode = @demo_mode, force_password_change = @force_password_change,
      owner_id = @owner_id, manager_user_id = @manager_user_id, updated_at = datetime('now') WHERE id = @id`),
    packageByName: db.prepare('SELECT id FROM packages WHERE name = ?'),
    ownerByUsername: db.prepare("SELECT id FROM users WHERE username = ? AND role IN ('root', 'reseller')"),
    managerByUsername: db.prepare("SELECT id, username, role, email, suspended FROM users WHERE username = ? AND role IN ('root', 'reseller')"),
    managers: db.prepare("SELECT id, username, role, email FROM users WHERE role IN ('root', 'reseller') AND suspended = 0 ORDER BY CASE role WHEN 'root' THEN 0 ELSE 1 END, username"),
    deleteMailDomains: db.prepare('DELETE FROM mail_domains WHERE account_id = ?'),
    deleteMailDomain: db.prepare('DELETE FROM mail_domains WHERE domain = ?'),
  };

  function shape(row) {
    if (!row) return null;
    return {
      ...row,
      suspended: Boolean(row.suspended), demo_mode: Boolean(row.demo_mode), force_password_change: Boolean(row.force_password_change),
      plan: json.parse(row.plan_snapshot_json, {}), plan_snapshot_json: undefined,
      systemUser: row.uid != null,
    };
  }

  function visible(account, user) {
    if (!isRoot(user) && account.owner_id !== user.id) throw forbidden('That account belongs to another reseller');
    return account;
  }

  // The server's own name (and www.<name>) has its own landing vhost; an
  // account for it would answer with the hostname certificate and receive the
  // panel's session cookie. Service Configuration owns the rule; without it
  // the panel's hostname setting decides.
  function isServerName(domain) {
    if (typeof ctx.web?.isServerName === 'function') return ctx.web.isServerName(domain);
    const name = String(settings.get('basic.hostname', '') || '').trim().toLowerCase();
    const d = String(domain || '').trim().toLowerCase();
    return Boolean(name) && (d === name || d === `www.${name}`);
  }

  // The manager is a root or reseller user. A reseller may name itself or a
  // root user; handing an account to another reseller is root's decision.
  function resolveManager(username, user) {
    const manager = stmts.managerByUsername.get(username);
    if (!manager || manager.suspended) throw notFound(`Manager "${username}"`);
    if (!isRoot(user) && manager.id !== user.id && manager.role !== 'root') throw forbidden('A reseller may only assign itself or a root user as the account manager');
    return manager;
  }

  function load(username, user) {
    const row = stmts.byUsername.get(username);
    if (!row) throw notFound('Account');
    return visible(row, user);
  }

  // Real system provisioning is mandatory in production; in development on a host
  // without the tooling the account is still recorded so the UI can be exercised.
  function strict() { return config.env === 'production'; }

  // Scheduler-driven calls carry no request; the row is still written (principal null).
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const quotaArgs = (username, mb, filesystem) => ({ username, softMb: mb || 0, hardMb: mb ? Math.round(mb * 1.05) : 0, filesystem });
  // Quotas are per filesystem: /home (or /home2 after a rearrange) is often its own.
  async function homeFilesystem(dir) {
    try { return (await ctx.accountFunctions?.mountpointFor?.(dir)) || '/'; } catch { return '/'; }
  }
  // Apache walks the document root as its own user (www-data on Debian/Ubuntu,
  // apache on RHEL: the names apacheLayout hardcodes), which is not in the
  // account's group, so public_html gets the web server's group (cPanel's
  // user:nobody layout). Debian ships www-data before Apache is installed; on
  // RHEL the group only exists with httpd, and fs.mkdir rejects an unknown one.
  async function webServerGroup(req) {
    for (const name of ['www-data', 'apache']) {
      try { if ((await agent.op('user.get', { username: name }, { req }))?.uid != null) return name; } catch { /* absent: no group */ }
    }
    return null;
  }
  // Installed quota tools do not mean quotas are enabled on the home filesystem
  // (fstab usrquota + quotaon, Initial Quota Setup): setquota then exits 1. The
  // limit stays on the account and the outcome is reported; it never unwinds a
  // creation or blocks a change.
  async function applyQuota(username, mb, homeDir, req) {
    const args = quotaArgs(username, mb, await homeFilesystem(homeDir));
    try {
      await agent.op('user.set_quota', args, { req });
      return { status: 'applied', detail: `${mb ? `${mb} MB` : 'unlimited'} on ${args.filesystem}`, filesystem: args.filesystem };
    } catch (err) {
      if (!['capability_missing', 'binary_not_found', 'quota_not_enabled', 'path_not_allowed', 'command_failed', 'spawn_failed'].includes(err.code)) throw err;
      logger.warn({ op: 'user.set_quota', code: err.code, username }, `${err.message} — the quota is recorded but not enforced`);
      const pending = err.code === 'capability_missing' || err.code === 'binary_not_found' || err.code === 'quota_not_enabled';
      return { status: pending ? 'pending' : 'failed', detail: `${err.message}; enable quotas on ${args.filesystem} with Initial Quota Setup, then set the limit again in Quota Modification`, filesystem: args.filesystem };
    }
  }
  // A reseller grants a shell only with add-pkg-shell and never with
  // disallow-shell (the rule of account-functions.setShell and the bulk modify).
  function shellIssue(user) {
    if (isRoot(user) || !ctx.resellers?.hasAcl) return null;
    if (ctx.resellers.aclsFor?.(user.id)?.has('disallow-shell')) return 'Your reseller privileges forbid granting shell access (Disallow Shell Access); only /usr/sbin/nologin can be set';
    if (!ctx.resellers.hasAcl(user, 'add-pkg-shell')) return 'Your reseller privileges do not include "Grant Shell Access" (add-pkg-shell)';
    return null;
  }
  // The web side of a suspension (every vhost pointed at the suspended page) is
  // Service Configuration's: ctx.web.setSuspended(username, suspended, req) ->
  // { applied, reason }. Without the hook the Linux lock alone applies and the
  // caller is told; a web failure never leaves the account half-suspended.
  async function applyWebSuspension(username, suspended, req) {
    if (!ctx.web) return { applied: false, reason: 'web_category_missing' };
    if (!ctx.web.setSuspended) return { applied: false, reason: 'web_hook_missing' };
    try {
      const r = await ctx.web.setSuspended(username, suspended, req);
      return { applied: Boolean(r?.applied), reason: r?.reason ?? null };
    } catch (err) {
      logger.warn({ err, username, suspended }, 'web suspension hook failed');
      return { applied: false, reason: err.message };
    }
  }

  function indexHtml(domain, username) {
    try { if (ctx.accountFunctions) return ctx.accountFunctions.renderTemplate('index', { domain, username }); } catch (err) { logger.warn({ err }, 'index template unavailable; using the built-in page'); }
    return defaultIndexHtml(domain);
  }

  // Web, DNS, mail and database provisioning run through the owning categories
  // when they are loaded. Each step records applied | pending (daemon missing,
  // applied on the next sync) | failed | skipped (category not present).
  async function provision(account, { ip, req, undo, want }) {
    const { username, domain, id } = account;
    const steps = {};
    const run = async (name, fn, rollback) => {
      if (want[name] === false) { steps[name] = { status: 'skipped', detail: 'not requested' }; return; }
      try {
        const out = await fn();
        steps[name] = out;
        if (rollback && out.status !== 'skipped') undo.push(rollback);
      } catch (err) {
        if (!softFailure(err)) throw err;
        steps[name] = { status: err.code === 'capability_missing' || err.code === 'binary_not_found' ? 'pending' : 'failed', detail: err.message };
      }
    };
    await run('web', async () => {
      if (!ctx.web) return { status: 'skipped', detail: 'Service Configuration is not loaded' };
      const r = await ctx.web.ensureVhost(username, req);
      return { status: r.applied ? 'applied' : r.reason === 'capability_missing' ? 'pending' : 'failed', detail: r.applied ? `${r.vhosts?.length ?? 1} vhost(s) written${r.reload?.reloaded ? ', web server reloaded' : ''}` : r.reason === 'capability_missing' ? 'Apache is not installed; the vhost is written when it is' : (r.vhosts?.find((v) => !v.applied)?.error || r.reason), phpVersion: r.phpVersion ?? null };
    }, () => ctx.web.removeAccount(username, null));
    await run('dns', async () => {
      if (!ctx.dns) return { status: 'skipped', detail: 'DNS Functions is not loaded' };
      const nameservers = ctx.resellers?.nameserversFor?.(account.owner_id) ?? [];
      const r = await ctx.dns.ensureZoneForDomain(domain, { ip: ip || undefined, accountId: id, nameservers: nameservers.length ? nameservers : undefined }, req);
      return { status: r.applied ? 'applied' : r.reason === 'capability_missing' || r.applied === false ? 'pending' : 'applied', detail: r.applied ? `zone ${domain} loaded into BIND (serial ${r.serial})` : r.created === false && !r.reason ? 'zone already existed and is now owned by this account' : 'BIND is not installed; the zone is published when it is', serial: r.serial ?? null, created: r.created ?? null };
    }, () => ctx.dns.removeZonesForAccount(id, null));
    await run('mail', async () => {
      if (!ctx.mail?.setRouting) return { status: 'skipped', detail: 'Email is not loaded' };
      const r = await ctx.mail.setRouting(domain, 'local', req);
      return { status: r.applied ? 'applied' : 'pending', detail: r.applied ? `${domain} added to Exim's local domains` : r.reason || 'Exim is not installed; the domain is routed when it is', routing: r.routing };
    });
    await run('database', async () => {
      if (!ctx.databases) return { status: 'skipped', detail: 'Database Services is not loaded' };
      const profile = ctx.databases.activeProfile?.() ?? null;
      const plan = json.parse(account.plan_snapshot_json, {});
      if (!profile) return { status: 'pending', detail: 'No active database profile; databases can be created once one is configured' };
      if (!capabilities.has('mysql') && !capabilities.has('postgres')) return { status: 'pending', detail: `${profile.engine || 'MySQL'} client tools are not installed; the account may create databases once they are` };
      return { status: 'applied', detail: `ready on profile ${profile.profile_name || profile.name || 'default'} (${plan.max_db == null ? 'unlimited' : plan.max_db} database(s) allowed)`, prefix: `${username}_` };
    });
    return { steps };
  }

  // Everything the categories created for an account goes before the Linux
  // user and the rows; a subsystem that cannot be cleaned is reported, logged
  // and never blocks the termination.
  async function cleanupAccount(account, { keepDns }, req) {
    const { username, domain, id } = account;
    const cleanup = {};
    const attempt = async (name, fn) => { try { const r = await fn(); if (r) cleanup[name] = r; } catch (err) { logger.warn({ err, username, step: name }, 'termination cleanup step failed'); cleanup[name] = { error: err.message }; } };
    await attempt('ssl', async () => (ctx.ssl?.removeAccountCerts ? ctx.ssl.removeAccountCerts(id, req) : null));
    await attempt('apps', async () => (ctx.apps?.removeAccountApps ? ctx.apps.removeAccountApps(username, req) : null));
    await attempt('web', async () => (ctx.web?.removeAccount ? ctx.web.removeAccount(username, req) : null));
    await attempt('databases', async () => (ctx.databases?.removeAccountData ? ctx.databases.removeAccountData(username, req) : null));
    // Every hosted domain leaves Exim's local-domain list on termination (WHM
    // drops it from /etc/localdomains); the rows go afterwards so the list is
    // rewritten while the routing row still says "remote".
    await attempt('mail', async () => {
      if (!ctx.mail) return null;
      const domains = [...new Set([domain, ...stmts.domains.all(id).map((d) => d.domain)])];
      const result = { routing: [], dkim: null };
      for (const d of domains) {
        if (!ctx.mail.setRouting) break;
        try { const r = await ctx.mail.setRouting(d, 'remote', req); result.routing.push({ domain: d, applied: r.applied }); } catch (err) {
          if (!softFailure(err)) throw err;
          result.routing.push({ domain: d, applied: false, detail: err.message });
        }
      }
      db.transaction(() => { stmts.deleteMailDomains.run(id); for (const d of domains) stmts.deleteMailDomain.run(d); })();
      if (ctx.mail.removeDkimKey && capabilities.has('exim')) result.dkim = await ctx.mail.removeDkimKey(domain, req);
      return result;
    });
    if (!keepDns) await attempt('dns', async () => (ctx.dns?.removeZonesForAccount ? ctx.dns.removeZonesForAccount(id, req) : null));
    return cleanup;
  }

  async function tryOp(name, args, req, steps, undo) {
    try {
      const result = await agent.op(name, args, { req });
      if (undo) steps.push(undo);
      return result;
    } catch (err) {
      if (strict() || !['capability_missing', 'binary_not_found', 'path_not_allowed', 'command_failed', 'spawn_failed'].includes(err.code)) throw err;
      logger.warn({ op: name, code: err.code }, `${err.message} — continuing without system provisioning (development mode)`);
      return null;
    }
  }

  return {
    list(query, user) {
      const where = [];
      const params = {};
      if (!isRoot(user)) { ctx.resellers?.assertAcl?.(user, 'list-accts'); where.push('a.owner_id = @owner'); params.owner = user.id; }
      if (query.q) { where.push('(a.username LIKE @q OR a.domain LIKE @q OR a.contact_email LIKE @q OR u.username LIKE @q OR m.username LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.suspended != null) { where.push('a.suspended = @suspended'); params.suspended = query.suspended ? 1 : 0; }
      if (query.package) { where.push('a.package_name = @package'); params.package = query.package; }
      if (query.owner) { where.push('u.username = @ownerName'); params.ownerName = query.owner; }
      if (query.manager) { where.push('m.username = @managerName'); params.managerName = query.manager; }
      const result = paginate(db, {
        select: 'a.*, u.username AS owner, m.username AS manager, m.role AS manager_role', from: 'accounts a JOIN users u ON u.id = a.owner_id LEFT JOIN users m ON m.id = a.manager_user_id', where, params,
        sortable: { username: 'a.username', domain: 'a.domain', owner: 'u.username', manager: 'm.username', package: 'a.package_name', created_at: 'a.created_at', disk_used_mb: 'a.disk_used_mb', suspended: 'a.suspended' },
        defaultSort: 'username', query,
      });
      return { ...result, data: result.data.map(shape) };
    },

    // Reading an account (the row, its domains) is the List Accounts privilege;
    // the internal load() used by the mutations stays bound to their own ACLs.
    get(username, user) {
      if (!isRoot(user)) ctx.resellers?.assertAcl?.(user, 'list-accts');
      const account = load(username, user);
      return { ...shape(account), domains: stmts.domains.all(account.id) };
    },

    // Who may be named as an account manager by this caller.
    managers(user) {
      return stmts.managers.all().filter((m) => isRoot(user) || m.role === 'root' || m.id === user.id).map((m) => ({ username: m.username, role: m.role, email: m.email }));
    },

    async create(input, user, req) {
      const username = input.username;
      if (RESERVED.has(username)) throw badRequest(`"${username}" is a reserved username`);
      if (stmts.byUsername.get(username)) throw conflict(`An account named "${username}" already exists`);
      if (stmts.byDomain.get(input.domain)) throw conflict(`The domain "${input.domain}" is already hosted on this server`);
      if (isServerName(input.domain)) throw conflict(`"${input.domain}" is the server hostname; it cannot be hosted by an account`);
      ctx.license?.assertCapacity?.('accounts');
      const pkgName = input.package || settings.get('basic.default_package');
      const pkgRow = stmts.packageByName.get(pkgName);
      if (!pkgRow) throw notFound(`Package "${pkgName}"`);
      const plan = packages.snapshot(pkgName);
      let ownerId = user.id;
      if (input.owner && isRoot(user)) {
        const owner = stmts.ownerByUsername.get(input.owner);
        if (!owner) throw notFound(`Owner "${input.owner}"`);
        ownerId = owner.id;
      }
      const managerId = input.manager ? resolveManager(input.manager, user).id : user.id;
      const homeRoot = settings.get('basic.home_root');
      const homeDir = `${homeRoot}/${username}`;
      // As in WHM, a reseller who may not grant shells creates the account without one.
      const shellWithheld = plan.has_shell ? shellIssue(user) : null;
      const shell = plan.has_shell && !shellWithheld ? '/bin/bash' : '/usr/sbin/nologin';
      // Resellers are bound by their limits, ACLs, package list and IP delegation (Reseller Center).
      const policy = !isRoot(user) && ctx.resellers?.createPolicy ? ctx.resellers.createPolicy(user, { pkgName, plan, ip: input.ip }) : null;
      const ip = input.ip || policy?.sharedIp || settings.get('basic.shared_ip') || settings.get('basic.main_ip') || null;

      const undo = [];
      let sysUser = null;
      let quota = null;
      try {
        sysUser = await tryOp('user.create', { username, homeDir, shell, comment: `WHM account ${input.domain}` }, req, undo,
          () => agent.op('user.delete', { username, removeHome: true }, { req }));
        if (sysUser) {
          const group = await webServerGroup(req);
          for (const sub of ['public_html', 'mail', 'etc', 'tmp', 'logs', 'ssl']) {
            await agent.op('fs.mkdir', { path: `${homeDir}/${sub}`, owner: username, ...(sub === 'public_html' && group ? { group } : {}), mode: sub === 'public_html' ? '0750' : '0700' }, { req });
          }
          await agent.op('fs.write_file', { path: `${homeDir}/public_html/index.html`, content: indexHtml(input.domain, username), owner: username, mode: '0644', backup: false }, { req });
          if (input.password) await agent.op('user.set_password', { username, password: input.password }, { req });
          if (plan.disk_mb && capabilities.has('quota')) quota = await applyQuota(username, plan.disk_mb, homeDir, req);
        }

        const account = db.transaction(() => {
          const { lastInsertRowid } = stmts.insert.run({
            username, domain: input.domain, owner_id: ownerId, manager_user_id: managerId, package_id: pkgRow.id, package_name: pkgName, ip,
            contact_email: input.contactEmail || null, plan: JSON.stringify(plan), shell,
            uid: sysUser?.uid ?? null, gid: sysUser?.gid ?? null, home_dir: homeDir,
            disk_quota_mb: plan.disk_mb, bandwidth_limit_mb: plan.bandwidth_mb,
          });
          stmts.insertDomain.run(lastInsertRowid, input.domain, 'main', `${homeDir}/public_html`);
          return stmts.byUsername.get(username);
        })();

        undo.push(() => Promise.resolve(stmts.remove.run(account.id)));
        const provisioning = await provision(account, { ip, user, req, undo, want: { web: true, dns: true, mail: true, ...(input.provision || {}) } });
        const steps = { ...(quota ? { quota } : {}), ...provisioning.steps };
        const statuses = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.status]));
        audit(req, { action: 'account.create', target: username, args: { domain: input.domain, package: pkgName, owner: ownerId, manager: managerId, ip, shell, ...(shellWithheld ? { shellWithheld } : {}), provisioning: statuses } });
        return { ...shape(stmts.byUsername.get(username)), domains: stmts.domains.all(account.id), provisioning: { systemUser: Boolean(sysUser), ...statuses, steps } };
      } catch (err) {
        for (const step of undo.reverse()) await step().catch((e) => logger.error({ err: e }, 'rollback step failed'));
        throw err;
      }
    },

    async suspend(username, reason, user, req) {
      const account = load(username, user);
      ctx.resellers?.assertAcl?.(user, 'suspend-acct');
      if (account.suspended) throw conflict('Account is already suspended');
      // user.lock locks the password and expires the account, so every PAM
      // login is refused (SSH with keys too, FTP, IMAP/POP, cron); the web
      // sites go through the hook.
      if (account.uid != null) await tryOp('user.lock', { username }, req, []);
      stmts.suspend.run(reason || null, account.id);
      const web = await applyWebSuspension(username, true, req);
      audit(req, { action: 'account.suspend', target: username, args: { reason, web, ...(req ? {} : { by: user?.username ?? 'scheduler' }) } });
      return { ...shape(stmts.byUsername.get(username)), web };
    },

    async unsuspend(username, user, req) {
      const account = load(username, user);
      ctx.resellers?.assertAcl?.(user, 'suspend-acct');
      if (!account.suspended) throw conflict('Account is not suspended');
      if (account.uid != null) await tryOp('user.unlock', { username }, req, []);
      stmts.unsuspend.run(account.id);
      const web = await applyWebSuspension(username, false, req);
      audit(req, { action: 'account.unsuspend', target: username, args: { web, ...(req ? {} : { by: user?.username ?? 'scheduler' }) } });
      return { ...shape(stmts.byUsername.get(username)), web };
    },

    async terminate(username, { keepDns = false } = {}, user, req) {
      const account = load(username, user);
      ctx.resellers?.assertAcl?.(user, 'kill-acct');
      const cleanup = await cleanupAccount(account, { keepDns }, req);
      if (account.uid != null) await tryOp('user.delete', { username, removeHome: true }, req, []);
      db.transaction(() => {
        stmts.remove.run(account.id);
        if (!keepDns) db.prepare('DELETE FROM dns_zones WHERE account_id = ?').run(account.id);
      })();
      audit(req, { action: 'account.terminate', target: username, args: { domain: account.domain, keepDns, cleanup } });
      return { username, domain: account.domain, terminated: true };
    },

    async setPassword(username, password, user, req) {
      const account = load(username, user);
      ctx.resellers?.assertAcl?.(user, 'passwd');
      if (account.uid != null) await tryOp('user.set_password', { username, password }, req, []);
      db.prepare("UPDATE accounts SET force_password_change = 0, updated_at = datetime('now') WHERE id = ?").run(account.id);
      audit(req, { action: 'account.password', target: username });
      return { username };
    },

    async modify(username, input, user, req) {
      const account = load(username, user);
      const next = { ...account };
      if (input.contactEmail !== undefined) next.contact_email = input.contactEmail;
      if (input.ip !== undefined) next.ip = input.ip;
      if (input.demoMode !== undefined) next.demo_mode = input.demoMode ? 1 : 0;
      if (input.forcePasswordChange !== undefined) next.force_password_change = input.forcePasswordChange ? 1 : 0;
      if (input.diskQuotaMb !== undefined) next.disk_quota_mb = input.diskQuotaMb;
      if (input.bandwidthLimitMb !== undefined) next.bandwidth_limit_mb = input.bandwidthLimitMb;
      if (input.package) {
        const pkgRow = stmts.packageByName.get(input.package);
        if (!pkgRow) throw notFound(`Package "${input.package}"`);
        const plan = packages.snapshot(input.package);
        next.package_id = pkgRow.id; next.package_name = input.package; next.plan_snapshot_json = JSON.stringify(plan);
        next.disk_quota_mb = plan.disk_mb; next.bandwidth_limit_mb = plan.bandwidth_mb;
        next.shell = plan.has_shell ? (account.shell === '/usr/sbin/nologin' ? '/bin/bash' : account.shell) : '/usr/sbin/nologin';
      }
      if (input.shell) next.shell = input.shell;
      if (input.owner && isRoot(user)) {
        const owner = stmts.ownerByUsername.get(input.owner);
        if (!owner) throw notFound(`Owner "${input.owner}"`);
        next.owner_id = owner.id;
      }
      if (input.manager === null) next.manager_user_id = null;
      else if (input.manager) next.manager_user_id = resolveManager(input.manager, user).id;
      // Resellers stay within their ACLs, limits, package list and IP delegation after creation too.
      if (!isRoot(user)) {
        if (next.demo_mode !== account.demo_mode) ctx.resellers?.assertAcl?.(user, 'demo-setup');
        if (next.shell !== account.shell && next.shell !== '/usr/sbin/nologin') { const issue = shellIssue(user); if (issue) throw forbidden(issue); }
        ctx.resellers?.modifyPolicy?.(user, account, { pkgName: input.package, diskQuotaMb: next.disk_quota_mb, bandwidthLimitMb: next.bandwidth_limit_mb, ip: next.ip });
      }
      let quota = null;
      if (account.uid != null) {
        if (next.shell !== account.shell) await tryOp('user.set_shell', { username, shell: next.shell }, req, []);
        if (next.disk_quota_mb !== account.disk_quota_mb && capabilities.has('quota')) quota = await applyQuota(username, next.disk_quota_mb, account.home_dir || `${settings.get('basic.home_root')}/${username}`, req);
      }
      stmts.update.run({ ...next, id: account.id, plan: next.plan_snapshot_json });
      audit(req, { action: 'account.modify', target: username, args: quota ? { ...input, quota: quota.status } : input });
      return { ...shape(stmts.byUsername.get(username)), ...(quota ? { quota } : {}) };
    },

    domains(username, user) {
      if (!isRoot(user)) ctx.resellers?.assertAcl?.(user, 'list-accts');
      return stmts.domains.all(load(username, user).id);
    },
  };
}

function defaultIndexHtml(domain) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${domain}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f6f8;color:#1f2a37}main{text-align:center}h1{font-weight:600}</style></head>
<body><main><h1>${domain}</h1><p>This site is hosted but has no content yet. Upload your files to <code>public_html</code>.</p></main></body></html>
`;
}
