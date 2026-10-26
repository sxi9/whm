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
    byUsername: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.username = ?'),
    byDomain: db.prepare('SELECT 1 FROM account_domains WHERE domain = ?'),
    insert: db.prepare(`INSERT INTO accounts (username, domain, owner_id, package_id, package_name, ip, contact_email, plan_snapshot_json, shell, uid, gid, home_dir, disk_quota_mb, bandwidth_limit_mb)
      VALUES (@username, @domain, @owner_id, @package_id, @package_name, @ip, @contact_email, @plan, @shell, @uid, @gid, @home_dir, @disk_quota_mb, @bandwidth_limit_mb)`),
    insertDomain: db.prepare('INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, ?, ?, ?)'),
    domains: db.prepare('SELECT * FROM account_domains WHERE account_id = ? ORDER BY type, domain'),
    suspend: db.prepare("UPDATE accounts SET suspended = 1, suspend_reason = ?, suspended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"),
    unsuspend: db.prepare("UPDATE accounts SET suspended = 0, suspend_reason = NULL, suspended_at = NULL, updated_at = datetime('now') WHERE id = ?"),
    remove: db.prepare('DELETE FROM accounts WHERE id = ?'),
    update: db.prepare(`UPDATE accounts SET contact_email = @contact_email, package_id = @package_id, package_name = @package_name, plan_snapshot_json = @plan,
      ip = @ip, shell = @shell, disk_quota_mb = @disk_quota_mb, bandwidth_limit_mb = @bandwidth_limit_mb, demo_mode = @demo_mode, force_password_change = @force_password_change,
      owner_id = @owner_id, updated_at = datetime('now') WHERE id = @id`),
    packageByName: db.prepare('SELECT id FROM packages WHERE name = ?'),
    ownerByUsername: db.prepare("SELECT id FROM users WHERE username = ? AND role IN ('root', 'reseller')"),
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

  function load(username, user) {
    const row = stmts.byUsername.get(username);
    if (!row) throw notFound('Account');
    return visible(row, user);
  }

  // Real system provisioning is mandatory in production; in development on a host
  // without the tooling the account is still recorded so the UI can be exercised.
  function strict() { return config.env === 'production'; }

  function indexHtml(domain, username) {
    try { if (ctx.accountFunctions) return ctx.accountFunctions.renderTemplate('index', { domain, username }); } catch (err) { logger.warn({ err }, 'index template unavailable; using the built-in page'); }
    return defaultIndexHtml(domain);
  }

  // Web, DNS, mail and database provisioning run through the owning categories
  // when they are loaded. Each step records applied | pending (daemon missing,
  // applied on the next sync) | failed | skipped (category not present).
  async function provision(account, { ip, user, req, undo }) {
    const { username, domain, id } = account;
    const steps = {};
    const run = async (name, fn, rollback) => {
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
      const r = await ctx.dns.ensureZoneForDomain(domain, { ip: ip || undefined, accountId: id }, req);
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
    await attempt('web', async () => (ctx.web?.removeAccount ? ctx.web.removeAccount(username, req) : null));
    await attempt('databases', async () => (ctx.databases?.removeAccountData ? ctx.databases.removeAccountData(username, req) : null));
    await attempt('mail', async () => (ctx.mail?.removeDkimKey && capabilities.has('exim') ? ctx.mail.removeDkimKey(domain, req) : null));
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
      if (!isRoot(user)) { where.push('a.owner_id = @owner'); params.owner = user.id; }
      if (query.q) { where.push('(a.username LIKE @q OR a.domain LIKE @q OR a.contact_email LIKE @q OR u.username LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.suspended != null) { where.push('a.suspended = @suspended'); params.suspended = query.suspended ? 1 : 0; }
      if (query.package) { where.push('a.package_name = @package'); params.package = query.package; }
      if (query.owner) { where.push('u.username = @ownerName'); params.ownerName = query.owner; }
      const result = paginate(db, {
        select: 'a.*, u.username AS owner', from: 'accounts a JOIN users u ON u.id = a.owner_id', where, params,
        sortable: { username: 'a.username', domain: 'a.domain', owner: 'u.username', package: 'a.package_name', created_at: 'a.created_at', disk_used_mb: 'a.disk_used_mb', suspended: 'a.suspended' },
        defaultSort: 'username', query,
      });
      return { ...result, data: result.data.map(shape) };
    },

    get(username, user) {
      const account = load(username, user);
      return { ...shape(account), domains: stmts.domains.all(account.id) };
    },

    async create(input, user, req) {
      const username = input.username;
      if (RESERVED.has(username)) throw badRequest(`"${username}" is a reserved username`);
      if (stmts.byUsername.get(username)) throw conflict(`An account named "${username}" already exists`);
      if (stmts.byDomain.get(input.domain)) throw conflict(`The domain "${input.domain}" is already hosted on this server`);
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
      const homeRoot = settings.get('basic.home_root');
      const homeDir = `${homeRoot}/${username}`;
      const shell = plan.has_shell ? '/bin/bash' : '/usr/sbin/nologin';
      const ip = input.ip || settings.get('basic.shared_ip') || settings.get('basic.main_ip') || null;

      const undo = [];
      let sysUser = null;
      try {
        sysUser = await tryOp('user.create', { username, homeDir, shell, comment: `WHM account ${input.domain}` }, req, undo,
          () => agent.op('user.delete', { username, removeHome: true }, { req }));
        if (sysUser) {
          for (const sub of ['public_html', 'mail', 'etc', 'tmp', 'logs', 'ssl']) {
            await agent.op('fs.mkdir', { path: `${homeDir}/${sub}`, owner: username, mode: sub === 'public_html' ? '0750' : '0700' }, { req });
          }
          await agent.op('fs.write_file', { path: `${homeDir}/public_html/index.html`, content: indexHtml(input.domain, username), owner: username, mode: '0644', backup: false }, { req });
          if (input.password) await agent.op('user.set_password', { username, password: input.password }, { req });
          if (plan.disk_mb && capabilities.has('quota')) {
            await tryOp('user.set_quota', { username, softMb: plan.disk_mb, hardMb: Math.round(plan.disk_mb * 1.05), filesystem: '/' }, req, undo);
          }
        }

        const account = db.transaction(() => {
          const { lastInsertRowid } = stmts.insert.run({
            username, domain: input.domain, owner_id: ownerId, package_id: pkgRow.id, package_name: pkgName, ip,
            contact_email: input.contactEmail || null, plan: JSON.stringify(plan), shell,
            uid: sysUser?.uid ?? null, gid: sysUser?.gid ?? null, home_dir: homeDir,
            disk_quota_mb: plan.disk_mb, bandwidth_limit_mb: plan.bandwidth_mb,
          });
          stmts.insertDomain.run(lastInsertRowid, input.domain, 'main', `${homeDir}/public_html`);
          return stmts.byUsername.get(username);
        })();

        undo.push(() => Promise.resolve(stmts.remove.run(account.id)));
        const provisioning = await provision(account, { ip, user, req, undo });
        req?.audit?.({ action: 'account.create', target: username, args: { domain: input.domain, package: pkgName, owner: ownerId, ip, provisioning: Object.fromEntries(Object.entries(provisioning.steps).map(([k, v]) => [k, v.status])) } });
        return { ...shape(stmts.byUsername.get(username)), domains: stmts.domains.all(account.id), provisioning: { systemUser: Boolean(sysUser), ...Object.fromEntries(Object.entries(provisioning.steps).map(([k, v]) => [k, v.status])), steps: provisioning.steps } };
      } catch (err) {
        for (const step of undo.reverse()) await step().catch((e) => logger.error({ err: e }, 'rollback step failed'));
        throw err;
      }
    },

    async suspend(username, reason, user, req) {
      const account = load(username, user);
      if (account.suspended) throw conflict('Account is already suspended');
      if (account.uid != null) await tryOp('user.lock', { username }, req, []);
      stmts.suspend.run(reason || null, account.id);
      req?.audit?.({ action: 'account.suspend', target: username, args: { reason } });
      return shape(stmts.byUsername.get(username));
    },

    async unsuspend(username, user, req) {
      const account = load(username, user);
      if (!account.suspended) throw conflict('Account is not suspended');
      if (account.uid != null) await tryOp('user.unlock', { username }, req, []);
      stmts.unsuspend.run(account.id);
      req?.audit?.({ action: 'account.unsuspend', target: username });
      return shape(stmts.byUsername.get(username));
    },

    async terminate(username, { keepDns = false } = {}, user, req) {
      const account = load(username, user);
      const cleanup = await cleanupAccount(account, { keepDns }, req);
      if (account.uid != null) await tryOp('user.delete', { username, removeHome: true }, req, []);
      db.transaction(() => {
        stmts.remove.run(account.id);
        if (!keepDns) db.prepare('DELETE FROM dns_zones WHERE account_id = ?').run(account.id);
      })();
      req?.audit?.({ action: 'account.terminate', target: username, args: { domain: account.domain, keepDns, cleanup } });
      return { username, domain: account.domain, terminated: true };
    },

    async setPassword(username, password, user, req) {
      const account = load(username, user);
      if (account.uid != null) await tryOp('user.set_password', { username, password }, req, []);
      db.prepare("UPDATE accounts SET force_password_change = 0, updated_at = datetime('now') WHERE id = ?").run(account.id);
      req?.audit?.({ action: 'account.password', target: username });
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
      if (account.uid != null) {
        if (next.shell !== account.shell) await tryOp('user.set_shell', { username, shell: next.shell }, req, []);
        if (next.disk_quota_mb !== account.disk_quota_mb && capabilities.has('quota')) {
          await tryOp('user.set_quota', { username, softMb: next.disk_quota_mb || 0, hardMb: next.disk_quota_mb ? Math.round(next.disk_quota_mb * 1.05) : 0, filesystem: '/' }, req, []);
        }
      }
      stmts.update.run({ ...next, id: account.id, plan: next.plan_snapshot_json });
      req?.audit?.({ action: 'account.modify', target: username, args: input });
      return shape(stmts.byUsername.get(username));
    },

    domains: (username, user) => stmts.domains.all(load(username, user).id),
  };
}

function defaultIndexHtml(domain) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${domain}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f6f8;color:#1f2a37}main{text-align:center}h1{font-weight:600}</style></head>
<body><main><h1>${domain}</h1><p>This site is hosted but has no content yet. Upload your files to <code>public_html</code>.</p></main></body></html>
`;
}
