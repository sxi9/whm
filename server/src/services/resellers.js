import crypto from 'node:crypto';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, forbidden, badRequest, unprocessable, HttpError, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

// Resellers. Attached as ctx.resellers; other categories may call:
//   resellers.aclsFor(userId)                 -> Set of granted ACL keys ('all' = every privilege)
//   resellers.hasAcl(user, key)               -> root always true; resellers per reseller_acls
//   resellers.assertAcl(user, key)            -> throws 403 unless hasAcl
//   resellers.createPolicy(user, { pkgName, plan, ip }) -> throws when a reseller's limits or
//                                                package/IP delegation forbid the account; returns { sharedIp }
//   resellers.modifyPolicy(user, account, { pkgName, diskQuotaMb, bandwidthLimitMb, ip })
//                                             -> same checks for an existing account's new values
//   resellers.nameserversFor(ownerId)         -> the owner's nameservers ([] when the server defaults apply).
//                                                accounts.create hands them to ctx.dns.ensureZoneForDomain as
//                                                { nameservers }, which renders them into the zone's NS/SOA.
//   resellers.sharedIpFor(user)               -> the reseller's shared IP or null
//   resellers.delegatedAddresses(userId)      -> ip_addresses rows delegated to a reseller
//   resellers.isReseller(username)
// ACLs are "configured" once any privilege editor saved them: every ACL key is
// then stored with value 0/1, so an empty selection denies everything. A reseller
// with no rows at all is only reachable outside this API (every create path
// writes the full set and migration 015c seeds legacy rows with the default
// list at boot); per integration contract 10 such a row is unrestricted by
// ACLs and bounded only by account ownership.
// Privilege suspension sets users.suspended (the panel login is the reseller's
// WHM access); the hosting account itself is left alone, as in WHM. The flag is
// cleared again only when this feature set it (privileges_suspended), so a login
// suspension applied for another reason survives unsuspend and reset.

export const ACL_GROUPS = [
  { key: 'standard', label: 'Standard Privileges', acls: [
    { key: 'list-accts', label: 'List Accounts', help: 'See the accounts the reseller owns' },
    { key: 'acct-summary', label: 'Account Summary', help: 'View account details and summaries' },
    { key: 'show-bandwidth', label: 'View Account Bandwidth Usage' },
    { key: 'basic-system-info', label: 'Basic System Information', help: 'Server status pages and load' },
    { key: 'news', label: 'Modify News', help: 'Edit the news shown to owned accounts' },
    { key: 'thirdparty', label: 'Allow Third-Party Applications' },
    { key: 'locale-edit', label: 'Edit Locales' },
    { key: 'cpanel-api', label: 'Access the panel API', help: 'Issue and use API tokens' },
  ] },
  { key: 'accounts', label: 'Account Management', acls: [
    { key: 'create-acct', label: 'Create Accounts' },
    { key: 'kill-acct', label: 'Terminate Accounts', help: 'Permanently remove owned accounts' },
    { key: 'suspend-acct', label: 'Suspend / Unsuspend Accounts' },
    { key: 'upgrade-account', label: 'Upgrade / Downgrade Accounts' },
    { key: 'edit-account', label: 'Modify Accounts', help: 'Change contact, quota, shell and other account settings' },
    { key: 'passwd', label: 'Change Account Passwords' },
    { key: 'quota', label: 'Modify Disk Quotas' },
    { key: 'limit-bandwidth', label: 'Limit Bandwidth Usage' },
    { key: 'demo-setup', label: 'Manage Demo Mode' },
    { key: 'rearrange-accts', label: 'Rearrange Accounts', help: 'Move home directories between partitions' },
    { key: 'add-pkg-ip', label: 'Assign Dedicated IP Addresses' },
    { key: 'add-pkg-shell', label: 'Grant Shell Access' },
  ] },
  { key: 'packages', label: 'Package Privileges', acls: [
    { key: 'add-pkg', label: 'Add / Remove Packages' },
    { key: 'edit-pkg', label: 'Edit Packages' },
    { key: 'viewglobalpackages', label: 'Use Global Packages', help: 'Create accounts with packages owned by root' },
    { key: 'allow-unlimited-pkgs', label: 'Unlimited Account Packages', help: 'Packages without a maximum on domains, mailboxes or databases' },
    { key: 'allow-unlimited-disk-pkgs', label: 'Unlimited Disk Packages', help: 'Packages with no disk quota even when the reseller has a disk limit' },
    { key: 'allow-unlimited-bw-pkgs', label: 'Unlimited Bandwidth Packages', help: 'Packages with no bandwidth limit even when the reseller has a bandwidth limit' },
  ] },
  { key: 'dns', label: 'DNS', acls: [
    { key: 'edit-dns', label: 'Edit DNS Zones', help: 'Zone editor for owned domains' },
    { key: 'kill-dns', label: 'Remove DNS Zones' },
    { key: 'add-dns', label: 'Add DNS Zones' },
    { key: 'clustering', label: 'DNS Clustering' },
  ] },
  { key: 'mail', label: 'Email', acls: [
    { key: 'mailcheck', label: 'Troubleshoot Mail Delivery' },
    { key: 'edit-mx', label: 'Edit MX Entries' },
    { key: 'mail-queue', label: 'View the Mail Queue' },
  ] },
  { key: 'server', label: 'Server', acls: [
    { key: 'status', label: 'View Server Status' },
    { key: 'stats', label: 'View Server Information and Statistics' },
    { key: 'restart', label: 'Restart Services' },
    { key: 'ssl', label: 'Manage SSL Certificates', help: 'Install certificates for owned domains' },
    { key: 'ssl-info', label: 'View SSL Certificates' },
    { key: 'ssl-buy', label: 'Purchase SSL Certificates' },
    { key: 'ssl-gencrt', label: 'Generate SSL Certificates and CSRs' },
  ] },
  { key: 'security', label: 'Security', acls: [
    { key: 'digest-auth', label: 'Enable Digest Authentication' },
    { key: 'mysql-superuser', label: 'MySQL Super User', help: 'Full MySQL access through the panel' },
    { key: 'disallow-shell', label: 'Disallow Shell Access', help: 'Never grant shells, even if the package allows it' },
  ] },
  { key: 'root', label: 'Root Access', acls: [
    { key: 'all', label: 'All Features (root-level access)', help: 'Grants every privilege, including ones not listed here. Use only for trusted administrators.' },
  ] },
];
export const ACL_KEYS = ACL_GROUPS.flatMap((g) => g.acls.map((a) => a.key));
const ACL_SET = new Set(ACL_KEYS);

const EMPTY_LIMITS = { max_accounts: null, max_disk_mb: null, max_bandwidth_mb: null, owns_nameservers: 0, nameservers: '[]', shared_ip: null, allowed_packages: '[]', oversell_disk: 0, oversell_bandwidth: 0, privileges_suspended: 0, suspended_reason: null, account_id: null, notes: null };

const resellerLimit = (message) => new HttpError(409, 'reseller_limit', message);

// Static paths mounted before GET /:username; a reseller with one of these
// names could never be read back.
export const RESERVED_USERNAMES = ['usage', 'catalog', 'email', 'reset', 'ownership', 'acl-lists'];

// A quota/limit of 0 is "unlimited" throughout the panel (setquota 0), like NULL.
const OWNED_STATS = `SELECT owner_id, COUNT(*) AS accounts, SUM(suspended) AS suspended, COALESCE(SUM(disk_used_mb), 0) AS disk_used_mb, COALESCE(SUM(disk_quota_mb), 0) AS disk_allocated_mb, SUM(CASE WHEN disk_quota_mb IS NULL OR disk_quota_mb = 0 THEN 1 ELSE 0 END) AS unlimited_disk,
  COALESCE(SUM(bandwidth_used_mb), 0) AS bandwidth_used_mb, COALESCE(SUM(bandwidth_limit_mb), 0) AS bandwidth_allocated_mb, SUM(CASE WHEN bandwidth_limit_mb IS NULL OR bandwidth_limit_mb = 0 THEN 1 ELSE 0 END) AS unlimited_bandwidth FROM accounts`;

export function createResellersService(ctx) {
  const { db, agent, capabilities, settings, sessionStore } = ctx;

  const stmts = {
    userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (username, email, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?)'),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    setEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),
    setUserSuspended: db.prepare('UPDATE users SET suspended = ? WHERE id = ?'),
    limits: db.prepare('SELECT * FROM reseller_limits WHERE reseller_id = ?'),
    upsertLimits: db.prepare(`INSERT INTO reseller_limits (reseller_id, max_accounts, max_disk_mb, max_bandwidth_mb, owns_nameservers, nameservers, shared_ip, allowed_packages, oversell_disk, oversell_bandwidth, privileges_suspended, suspended_reason, account_id, notes)
      VALUES (@reseller_id, @max_accounts, @max_disk_mb, @max_bandwidth_mb, @owns_nameservers, @nameservers, @shared_ip, @allowed_packages, @oversell_disk, @oversell_bandwidth, @privileges_suspended, @suspended_reason, @account_id, @notes)
      ON CONFLICT (reseller_id) DO UPDATE SET max_accounts = excluded.max_accounts, max_disk_mb = excluded.max_disk_mb, max_bandwidth_mb = excluded.max_bandwidth_mb, owns_nameservers = excluded.owns_nameservers,
        nameservers = excluded.nameservers, shared_ip = excluded.shared_ip, allowed_packages = excluded.allowed_packages, oversell_disk = excluded.oversell_disk, oversell_bandwidth = excluded.oversell_bandwidth,
        privileges_suspended = excluded.privileges_suspended, suspended_reason = excluded.suspended_reason, account_id = excluded.account_id, notes = excluded.notes, updated_at = datetime('now')`),
    deleteLimits: db.prepare('DELETE FROM reseller_limits WHERE reseller_id = ?'),
    acls: db.prepare('SELECT acl_key, value FROM reseller_acls WHERE reseller_id = ? ORDER BY acl_key'),
    aclCount: db.prepare('SELECT COUNT(*) AS n FROM reseller_acls WHERE reseller_id = ? AND value = 1'),
    clearAcls: db.prepare('DELETE FROM reseller_acls WHERE reseller_id = ?'),
    insertAcl: db.prepare('INSERT OR REPLACE INTO reseller_acls (reseller_id, acl_key, value) VALUES (?, ?, ?)'),
    aclLists: db.prepare('SELECT * FROM reseller_acl_lists ORDER BY builtin DESC, name'),
    aclList: db.prepare('SELECT * FROM reseller_acl_lists WHERE name = ?'),
    upsertAclList: db.prepare("INSERT INTO reseller_acl_lists (name, acls_json) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET acls_json = excluded.acls_json, updated_at = datetime('now')"),
    deleteAclList: db.prepare('DELETE FROM reseller_acl_lists WHERE name = ? AND builtin = 0'),
    accountByUsername: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.username = ?'),
    accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    accountsOwned: db.prepare('SELECT id, username, domain, ip, package_name, suspended, suspend_reason, disk_quota_mb, disk_used_mb, bandwidth_limit_mb, bandwidth_used_mb, contact_email, created_at FROM accounts WHERE owner_id = ? ORDER BY username'),
    ownerStats: db.prepare(`${OWNED_STATS} WHERE owner_id = ? GROUP BY owner_id`),
    insertBroadcast: db.prepare('INSERT INTO reseller_broadcasts (subject, body, from_address, requested_by) VALUES (?, ?, ?, ?)'),
    broadcastById: db.prepare('SELECT * FROM reseller_broadcasts WHERE id = ?'),
    broadcastJob: db.prepare('UPDATE reseller_broadcasts SET job_id = ? WHERE id = ?'),
    broadcastStatus: db.prepare("UPDATE reseller_broadcasts SET status = ?, sent_json = ?, failed_json = ?, finished_at = datetime('now') WHERE id = ?"),
    broadcasts: db.prepare('SELECT * FROM reseller_broadcasts ORDER BY id DESC LIMIT ?'),
    setOwner: db.prepare("UPDATE accounts SET owner_id = ?, updated_at = datetime('now') WHERE id = ?"),
    reassignOwner: db.prepare("UPDATE accounts SET owner_id = ?, updated_at = datetime('now') WHERE owner_id = ?"),
    rootUser: db.prepare("SELECT id, username, role FROM users WHERE role = 'root' ORDER BY id LIMIT 1"),
    owners: db.prepare("SELECT id, username, role FROM users WHERE role IN ('root', 'reseller') ORDER BY role DESC, username"),
    packages: db.prepare('SELECT p.id, p.name, p.owner_id, u.username AS owner FROM packages p LEFT JOIN users u ON u.id = p.owner_id ORDER BY p.name'),
    packageByName: db.prepare('SELECT id, name, owner_id FROM packages WHERE name = ?'),
    ips: db.prepare('SELECT i.*, a.username AS dedicated_account, d.username AS delegated_user FROM ip_addresses i LEFT JOIN accounts a ON a.id = i.dedicated_to LEFT JOIN users d ON d.id = i.delegated_to ORDER BY i.family, i.is_main DESC, i.address'),
    ipByAddress: db.prepare('SELECT i.*, d.username AS delegated_user FROM ip_addresses i LEFT JOIN users d ON d.id = i.delegated_to WHERE i.address = ?'),
    delegatedTo: db.prepare('SELECT * FROM ip_addresses WHERE delegated_to = ? ORDER BY family, address'),
    setDelegated: db.prepare('UPDATE ip_addresses SET delegated_to = ? WHERE address = ?'),
    clearDelegated: db.prepare('UPDATE ip_addresses SET delegated_to = NULL WHERE delegated_to = ?'),
  };

  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(req ?? null, entry));
  const hostname = () => settings.get('basic.hostname', '') || 'localhost';
  const parseList = (v) => { const out = json.parse(v, []); return Array.isArray(out) ? out : []; };

  function loadUser(username) {
    const user = stmts.userByUsername.get(username);
    if (!user) throw notFound(`Reseller "${username}"`);
    return user;
  }
  function loadReseller(username) {
    const user = loadUser(username);
    if (user.role !== 'reseller') throw notFound(`Reseller "${username}"`);
    return user;
  }
  const limitsOf = (userId) => ({ ...EMPTY_LIMITS, ...(stmts.limits.get(userId) || {}) });
  function aclState(userId) {
    const rows = stmts.acls.all(userId);
    return { configured: rows.length > 0, granted: new Set(rows.filter((r) => r.value === 1).map((r) => r.acl_key)) };
  }
  const aclsOf = (userId) => [...aclState(userId).granted];

  // Notes are root's private remarks about a reseller and never reach the reseller itself.
  function shapeLimits(row, { forRoot = true } = {}) {
    return {
      max_accounts: row.max_accounts, max_disk_mb: row.max_disk_mb, max_bandwidth_mb: row.max_bandwidth_mb,
      oversell_disk: Boolean(row.oversell_disk), oversell_bandwidth: Boolean(row.oversell_bandwidth),
      owns_nameservers: Boolean(row.owns_nameservers), nameservers: parseList(row.nameservers), shared_ip: row.shared_ip,
      allowed_packages: parseList(row.allowed_packages), ...(forRoot ? { notes: row.notes ?? null } : {}),
    };
  }

  function stats(userId) {
    const row = stmts.ownerStats.get(userId);
    return {
      accounts: row?.accounts ?? 0, suspended: row?.suspended ?? 0, disk_used_mb: Math.round(row?.disk_used_mb ?? 0), disk_allocated_mb: row?.disk_allocated_mb ?? 0, unlimited_disk: row?.unlimited_disk ?? 0,
      bandwidth_used_mb: Math.round(row?.bandwidth_used_mb ?? 0), bandwidth_allocated_mb: row?.bandwidth_allocated_mb ?? 0, unlimited_bandwidth: row?.unlimited_bandwidth ?? 0,
    };
  }

  const percent = (used, max) => (max > 0 ? Math.round((used / max) * 100) : null);

  function shape(user, { withAcls = true, forRoot = true } = {}) {
    const limits = limitsOf(user.id);
    const s = stats(user.id);
    const account = limits.account_id ? stmts.accountById.get(limits.account_id) : stmts.accountByUsername.get(user.username);
    const acls = withAcls ? aclsOf(user.id) : undefined;
    return {
      id: user.id, username: user.username, email: user.email ?? account?.contact_email ?? null, role: user.role,
      suspended: Boolean(limits.privileges_suspended) || Boolean(user.suspended), suspended_reason: limits.suspended_reason ?? null,
      configured: Boolean(stmts.limits.get(user.id)), created_at: user.created_at, last_login_at: user.last_login_at,
      account: account ? { id: account.id, username: account.username, domain: account.domain, suspended: Boolean(account.suspended) } : null,
      limits: shapeLimits(limits, { forRoot }), acls, acl_count: withAcls ? acls.length : stmts.aclCount.get(user.id).n, acls_configured: aclState(user.id).configured,
      delegated_ips: stmts.delegatedTo.all(user.id).map((r) => r.address),
      usage: { ...s, accounts_percent: percent(s.accounts, limits.max_accounts), disk_percent: percent(s.disk_allocated_mb, limits.max_disk_mb), bandwidth_percent: percent(s.bandwidth_allocated_mb, limits.max_bandwidth_mb),
        over_accounts: limits.max_accounts != null && s.accounts > limits.max_accounts, over_disk: limits.max_disk_mb != null && !limits.oversell_disk && s.disk_allocated_mb > limits.max_disk_mb, over_bandwidth: limits.max_bandwidth_mb != null && !limits.oversell_bandwidth && s.bandwidth_allocated_mb > limits.max_bandwidth_mb },
    };
  }

  function validateAcls(acls = []) {
    const unknown = acls.filter((a) => !ACL_SET.has(a));
    if (unknown.length) throw unprocessable(`Unknown ACL key(s): ${unknown.join(', ')}`, { acls: unknown.map((a) => `"${a}" is not a known privilege`) });
    return [...new Set(acls)];
  }

  // Another reseller's packages are never visible to this one (packages.js hides them),
  // so they cannot be put on its allowed list either.
  function validatePackages(names = [], userId) {
    for (const n of names) {
      const pkg = stmts.packageByName.get(n);
      if (!pkg) throw unprocessable(`Package "${n}" does not exist`, { allowedPackages: [`Unknown package "${n}"`] });
      if (pkg.owner_id != null && pkg.owner_id !== userId) throw unprocessable(`Package "${n}" belongs to another reseller`, { allowedPackages: [`"${n}" is owned by another reseller`] });
    }
    return [...new Set(names)];
  }

  function validateSharedIp(address, userId) {
    if (address == null) return null;
    const row = stmts.ipByAddress.get(address);
    if (!row) throw unprocessable(`${address} is not an IP address of this server`, { sharedIp: ['Add it under IP Functions first'] });
    if (row.dedicated_to) throw conflict(`${address} is dedicated to account ${stmts.accountById.get(row.dedicated_to)?.username ?? row.dedicated_to} and cannot be a shared IP`);
    if (row.reserved) throw conflict(`${address} is reserved${row.reserved_reason ? ` (${row.reserved_reason})` : ''} and cannot be a shared IP`);
    if (!row.managed) throw badRequest(`${address} is a dynamic address owned by the host and cannot be a shared IP`);
    if (row.delegated_to && row.delegated_to !== userId && !row.is_main && settings.get('basic.shared_ip') !== address) throw conflict(`${address} is delegated to ${row.delegated_user}; delegate it to this reseller first`);
    return row.address;
  }

  function writeLimits(userId, current, input) {
    const next = { ...current, reseller_id: userId };
    if (input.maxAccounts !== undefined) next.max_accounts = input.maxAccounts;
    if (input.maxDiskMb !== undefined) next.max_disk_mb = input.maxDiskMb;
    if (input.maxBandwidthMb !== undefined) next.max_bandwidth_mb = input.maxBandwidthMb;
    if (input.oversellDisk !== undefined) next.oversell_disk = input.oversellDisk ? 1 : 0;
    if (input.oversellBandwidth !== undefined) next.oversell_bandwidth = input.oversellBandwidth ? 1 : 0;
    if (input.ownsNameservers !== undefined) next.owns_nameservers = input.ownsNameservers ? 1 : 0;
    if (input.nameservers !== undefined) next.nameservers = JSON.stringify([...new Set(input.nameservers.map((n) => n.toLowerCase().replace(/\.$/, '')))]);
    if (input.sharedIp !== undefined) next.shared_ip = validateSharedIp(input.sharedIp, userId);
    if (input.allowedPackages !== undefined) next.allowed_packages = JSON.stringify(validatePackages(input.allowedPackages, userId));
    if (input.notes !== undefined) next.notes = input.notes;
    if (input.accountId !== undefined) next.account_id = input.accountId;
    stmts.upsertLimits.run(next);
    return next;
  }

  function writeAcls(userId, acls) {
    const granted = new Set(acls);
    db.transaction(() => {
      stmts.clearAcls.run(userId);
      for (const key of ACL_KEYS) stmts.insertAcl.run(userId, key, granted.has(key) ? 1 : 0);
    })();
  }

  function resolveAclList(name) {
    const row = stmts.aclList.get(name);
    if (!row) throw notFound(`ACL list "${name}"`);
    return validateAcls(parseList(row.acls_json));
  }

  function assertSelfOrRoot(username, user) {
    if (!isRoot(user) && user.username !== username) throw forbidden('Resellers can only view their own reseller settings');
  }

  // --- Create / update ----------------------------------------------------------

  function assertPromotable(username, existingUser) {
    if (existingUser?.role === 'root') throw badRequest('The root user cannot be made a reseller');
    if (existingUser?.role === 'reseller') throw conflict(`"${username}" is already a reseller`);
  }

  async function create(input, user, req) {
    const { username } = input;
    if (RESERVED_USERNAMES.includes(username)) throw unprocessable(`"${username}" is a reserved name`, { username: [`Reserved names: ${RESERVED_USERNAMES.join(', ')}`] });
    const existingUser = stmts.userByUsername.get(username);
    assertPromotable(username, existingUser);
    const account = stmts.accountByUsername.get(username);
    if (input.fromAccount && !account) throw notFound(`Hosting account "${username}"`);
    // A hosting account becomes a reseller only on request; a standalone reseller never silently takes one over.
    if (!input.fromAccount && account) throw conflict(`"${username}" is a hosting account; set fromAccount to make it a reseller`);
    if (!input.fromAccount && !existingUser && !input.password) throw unprocessable('A password is required for a standalone reseller', { password: ['Required unless the reseller is created from an existing hosting account'] });
    const acls = input.aclList ? resolveAclList(input.aclList) : validateAcls(input.acls ?? resolveAclList(settings.get('resellers.default_acl_list', 'standard')));
    const generated = !input.password && !existingUser?.password_hash;
    const password = input.password || (generated ? crypto.randomBytes(12).toString('base64url') : null);
    const hash = password ? await ctx.crypto.hashPassword(password) : null;
    const email = input.email ?? existingUser?.email ?? account?.contact_email ?? null;

    const created = db.transaction(() => {
      // Re-read inside the transaction: the bcrypt hash above yields, so a concurrent create may have won.
      const current = stmts.userByUsername.get(username);
      assertPromotable(username, current);
      if (Boolean(current) !== Boolean(existingUser)) throw conflict(`"${username}" was created concurrently; retry`);
      let id;
      if (existingUser) {
        id = existingUser.id;
        stmts.setRole.run('reseller', id);
        if (email !== existingUser.email) stmts.setEmail.run(email, id);
        if (hash) db.prepare("UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = datetime('now') WHERE id = ?").run(hash, generated ? 1 : 0, id);
        // Root is explicitly re-enabling this login (a reset standalone reseller is parked suspended).
        if (existingUser.suspended) stmts.setUserSuspended.run(0, id);
      } else {
        id = Number(stmts.insertUser.run(username, email, hash, 'reseller', generated || input.forcePasswordChange ? 1 : 0).lastInsertRowid);
      }
      writeLimits(id, { ...EMPTY_LIMITS }, { ...input, accountId: account?.id ?? null });
      writeAcls(id, acls);
      // A reseller created from a hosting account owns that account, as in WHM.
      if (account) stmts.setOwner.run(id, account.id);
      return id;
    })();
    audit(req, { action: 'reseller.create', target: username, args: { fromAccount: Boolean(account), acls: acls.length, maxAccounts: input.maxAccounts ?? null, maxDiskMb: input.maxDiskMb ?? null, email, loginRestored: Boolean(existingUser?.suspended) } });
    const out = shape(stmts.userById.get(created));
    if (generated) out.initialPassword = password;
    return out;
  }

  function update(username, input, user, req) {
    const reseller = loadReseller(username);
    db.transaction(() => {
      writeLimits(reseller.id, limitsOf(reseller.id), input);
      if (input.email !== undefined) stmts.setEmail.run(input.email, reseller.id);
      if (input.aclList) writeAcls(reseller.id, resolveAclList(input.aclList));
      else if (input.acls) writeAcls(reseller.id, validateAcls(input.acls));
    })();
    audit(req, { action: 'reseller.update', target: username, args: input });
    return shape(stmts.userById.get(reseller.id));
  }

  function setPrivileges(username, { acls, aclList, nameservers, ownsNameservers }, user, req) {
    const reseller = loadReseller(username);
    const granted = aclList ? resolveAclList(aclList) : validateAcls(acls ?? aclsOf(reseller.id));
    db.transaction(() => {
      writeAcls(reseller.id, granted);
      if (nameservers !== undefined || ownsNameservers !== undefined) writeLimits(reseller.id, limitsOf(reseller.id), { nameservers, ownsNameservers });
    })();
    audit(req, { action: 'reseller.privileges', target: username, args: { acls: granted, aclList: aclList ?? null, nameservers: nameservers ?? null, ownsNameservers: ownsNameservers ?? null } });
    return shape(stmts.userById.get(reseller.id));
  }

  function setSuspended(username, { suspend, reason }, user, req) {
    const reseller = loadReseller(username);
    const limits = limitsOf(reseller.id);
    if (suspend && limits.privileges_suspended) throw conflict(`${username}'s reseller privileges are already suspended`);
    if (!suspend && !limits.privileges_suspended) throw conflict(`${username}'s reseller privileges are not suspended`);
    db.transaction(() => {
      stmts.upsertLimits.run({ ...limits, reseller_id: reseller.id, privileges_suspended: suspend ? 1 : 0, suspended_reason: suspend ? (reason || null) : null });
      stmts.setUserSuspended.run(suspend ? 1 : 0, reseller.id);
    })();
    if (suspend) sessionStore?.destroyUserSessions?.(reseller.id);
    audit(req, { action: suspend ? 'reseller.suspend' : 'reseller.unsuspend', target: username, args: { reason } });
    return shape(stmts.userById.get(reseller.id));
  }

  // Reset Resellers: the panel user loses the reseller role, ACLs, limits and
  // delegated IPs; owned accounts move to root. A reseller created from a hosting
  // account keeps its login for that account; a standalone one owns nothing any
  // more, so its login is parked suspended until root promotes it again.
  function reset({ usernames, all }, user, req) {
    const root = stmts.rootUser.get();
    const targets = all ? stmts.owners.all().filter((u) => u.role === 'reseller') : usernames.map((u) => stmts.userByUsername.get(u)).filter(Boolean);
    const missing = all ? [] : usernames.filter((u) => !targets.some((t) => t.username === u));
    const results = [];
    for (const target of targets) {
      if (target.role !== 'reseller') { results.push({ username: target.username, reset: false, reason: `${target.username} is not a reseller` }); continue; }
      const owned = stmts.accountsOwned.all(target.id).map((a) => a.username);
      const delegated = stmts.delegatedTo.all(target.id).map((a) => a.address);
      const limits = limitsOf(target.id);
      const hasAccount = Boolean((limits.account_id && stmts.accountById.get(limits.account_id)) || stmts.accountByUsername.get(target.username));
      const loginSuspended = !hasAccount || (Boolean(stmts.userById.get(target.id)?.suspended) && !limits.privileges_suspended);
      db.transaction(() => {
        stmts.reassignOwner.run(root.id, target.id);
        stmts.clearDelegated.run(target.id);
        stmts.clearAcls.run(target.id);
        stmts.deleteLimits.run(target.id);
        stmts.setRole.run('user', target.id);
        stmts.setUserSuspended.run(loginSuspended ? 1 : 0, target.id);
      })();
      sessionStore?.destroyUserSessions?.(target.id);
      results.push({ username: target.username, reset: true, accounts_moved: owned, ips_released: delegated, login_suspended: loginSuspended });
    }
    audit(req, { action: 'reseller.reset', target: all ? 'all' : usernames.join(','), args: { reset: results.filter((r) => r.reset).map((r) => r.username), missing } });
    return { results, missing, moved_to: root.username };
  }

  // --- ACL lists ---------------------------------------------------------------

  const aclLists = {
    list: () => stmts.aclLists.all().map((r) => ({ name: r.name, acls: parseList(r.acls_json), builtin: Boolean(r.builtin), updated_at: r.updated_at })),
    save(name, acls, req) {
      const row = stmts.aclList.get(name);
      if (row?.builtin) throw conflict(`"${name}" is a built-in ACL list; save under another name`);
      stmts.upsertAclList.run(name, JSON.stringify(validateAcls(acls)));
      audit(req, { action: 'reseller.acl_list.save', target: name, args: { acls: acls.length } });
      return { name, acls: validateAcls(acls), builtin: false };
    },
    remove(name, req) {
      const row = stmts.aclList.get(name);
      if (!row) throw notFound(`ACL list "${name}"`);
      if (row.builtin) throw conflict('Built-in ACL lists cannot be deleted');
      stmts.deleteAclList.run(name);
      audit(req, { action: 'reseller.acl_list.delete', target: name });
      return { name, deleted: true };
    },
  };

  // --- IP delegation / shared IP ---------------------------------------------------

  // A reseller sees only the addresses it may use (its delegated ones and the
  // shared IPs) and never which other tenants hold the rest.
  function delegation(username, user) {
    assertSelfOrRoot(username, user);
    const reseller = loadReseller(username);
    const limits = limitsOf(reseller.id);
    const sharedIp = settings.get('basic.shared_ip') || null;
    const root = isRoot(user);
    const addresses = stmts.ips.all().map((r) => ({
      address: r.address, family: r.family, interface: r.interface, is_main: Boolean(r.is_main), reserved: Boolean(r.reserved), managed: Boolean(r.managed),
      dedicated_to: root ? r.dedicated_account ?? null : null, delegated_to: root ? r.delegated_user ?? null : r.delegated_to === reseller.id ? username : null,
      delegated: r.delegated_to === reseller.id, server_shared: r.address === sharedIp, reseller_shared: r.address === limits.shared_ip,
      delegatable: Boolean(r.managed) && !r.is_main && !r.reserved && !r.dedicated_to && (r.delegated_to == null || r.delegated_to === reseller.id),
    })).filter((a) => root || a.delegated || a.server_shared || a.reseller_shared);
    return { reseller: username, shared_ip: limits.shared_ip, server_shared_ip: sharedIp, addresses, delegated: addresses.filter((a) => a.delegated).map((a) => a.address) };
  }

  function setDelegation(username, { addresses }, user, req) {
    const reseller = loadReseller(username);
    const wanted = [...new Set(addresses)];
    const rows = wanted.map((a) => {
      const row = stmts.ipByAddress.get(a);
      if (!row) throw unprocessable(`${a} is not an IP address of this server`, { addresses: [`Unknown address ${a}`] });
      if (row.is_main) throw badRequest(`${a} is the server's main IP and cannot be delegated`);
      if (row.reserved) throw conflict(`${a} is reserved${row.reserved_reason ? ` (${row.reserved_reason})` : ''}`);
      if (row.dedicated_to) throw conflict(`${a} is dedicated to an account and cannot be delegated`);
      if (!row.managed) throw badRequest(`${a} is a dynamic address owned by the host and cannot be delegated`);
      if (row.delegated_to && row.delegated_to !== reseller.id) throw conflict(`${a} is already delegated to ${row.delegated_user}`);
      return row;
    });
    const before = stmts.delegatedTo.all(reseller.id).map((r) => r.address);
    const after = rows.map((r) => r.address);
    const limits = limitsOf(reseller.id);
    const sharedIpCleared = Boolean(limits.shared_ip) && before.includes(limits.shared_ip) && !after.includes(limits.shared_ip) && !isServerSharedAddress(limits.shared_ip);
    db.transaction(() => {
      stmts.clearDelegated.run(reseller.id);
      for (const r of rows) stmts.setDelegated.run(reseller.id, r.address);
      if (sharedIpCleared) stmts.upsertLimits.run({ ...limits, reseller_id: reseller.id, shared_ip: null });
    })();
    const added = after.filter((a) => !before.includes(a));
    const removed = before.filter((a) => !after.includes(a));
    audit(req, { action: 'reseller.ip_delegation', target: username, args: { added, removed, sharedIpCleared: sharedIpCleared ? limits.shared_ip : null } });
    return { reseller: username, delegated: after, added, removed, shared_ip_cleared: sharedIpCleared ? limits.shared_ip : null };
  }

  function setSharedIp(username, { sharedIp }, user, req) {
    const reseller = loadReseller(username);
    const next = writeLimits(reseller.id, limitsOf(reseller.id), { sharedIp });
    audit(req, { action: 'reseller.shared_ip', target: username, args: { sharedIp: next.shared_ip } });
    return { reseller: username, shared_ip: next.shared_ip, effective_shared_ip: next.shared_ip || settings.get('basic.shared_ip') || settings.get('basic.main_ip') || null };
  }

  // --- Ownership -----------------------------------------------------------------

  function ownerByName(name) {
    const owner = stmts.userByUsername.get(name);
    if (!owner || !['root', 'reseller'].includes(owner.role)) throw notFound(`Owner "${name}" (must be root or a reseller)`);
    return owner;
  }

  function changeOwner(username, { owner }, user, req) {
    const account = stmts.accountByUsername.get(username);
    if (!account) throw notFound(`Account "${username}"`);
    const target = ownerByName(owner);
    if (target.id === account.owner_id) throw conflict(`${username} is already owned by ${owner}`);
    stmts.setOwner.run(target.id, account.id);
    const warnings = [];
    if (target.role === 'reseller') {
      const limits = limitsOf(target.id);
      const s = stats(target.id);
      if (limits.max_accounts != null && s.accounts > limits.max_accounts) warnings.push(`${owner} now owns ${s.accounts} account(s), over the limit of ${limits.max_accounts}`);
      if (limits.max_disk_mb != null && !limits.oversell_disk && s.disk_allocated_mb > limits.max_disk_mb) warnings.push(`${owner} now has ${s.disk_allocated_mb} MB of disk allocated, over the limit of ${limits.max_disk_mb} MB`);
    }
    audit(req, { action: 'account.owner.change', target: username, args: { from: account.owner, to: owner, warnings } });
    return { username, domain: account.domain, previous_owner: account.owner, owner, warnings };
  }

  function changeOwnerBulk({ usernames, owner }, user, req) {
    ownerByName(owner);
    const results = [];
    for (const u of usernames) {
      try { results.push({ ...changeOwner(u, { owner }, user, req), changed: true }); } catch (err) { results.push({ username: u, changed: false, error: err.message, code: err.code }); }
    }
    audit(req, { action: 'account.owner.change_bulk', target: owner, args: { requested: usernames.length, changed: results.filter((r) => r.changed).map((r) => r.username), failed: results.filter((r) => !r.changed).map((r) => r.username) } });
    return { owner, results, changed: results.filter((r) => r.changed).length, failed: results.filter((r) => !r.changed).length };
  }

  // --- Accounts / usage ----------------------------------------------------------------

  function accounts(username, query, user) {
    assertSelfOrRoot(username, user);
    const reseller = loadReseller(username);
    const where = ['a.owner_id = @owner'];
    const params = { owner: reseller.id };
    if (query.q) { where.push('(a.username LIKE @q OR a.domain LIKE @q OR a.contact_email LIKE @q)'); params.q = `%${query.q}%`; }
    if (query.suspended != null) { where.push('a.suspended = @suspended'); params.suspended = query.suspended ? 1 : 0; }
    const result = paginate(db, {
      select: 'a.id, a.username, a.domain, a.ip, a.package_name, a.contact_email, a.suspended, a.suspend_reason, a.disk_quota_mb, a.disk_used_mb, a.bandwidth_limit_mb, a.bandwidth_used_mb, a.created_at', from: 'accounts a', where, params,
      sortable: { username: 'a.username', domain: 'a.domain', package: 'a.package_name', created_at: 'a.created_at', disk_used_mb: 'a.disk_used_mb', bandwidth_used_mb: 'a.bandwidth_used_mb', suspended: 'a.suspended' }, defaultSort: 'username', query,
    });
    return { ...result, data: result.data.map((a) => ({ ...a, suspended: Boolean(a.suspended), disk_percent: percent(a.disk_used_mb, a.disk_quota_mb), bandwidth_percent: percent(a.bandwidth_used_mb, a.bandwidth_limit_mb) })), meta: { ...result.meta, reseller: username } };
  }

  function usage(username, user) {
    assertSelfOrRoot(username, user);
    const reseller = loadReseller(username);
    const detail = shape(reseller, { withAcls: false, forRoot: isRoot(user) });
    const list = stmts.accountsOwned.all(reseller.id).map((a) => ({ ...a, suspended: Boolean(a.suspended), disk_percent: percent(a.disk_used_mb, a.disk_quota_mb), bandwidth_percent: percent(a.bandwidth_used_mb, a.bandwidth_limit_mb), over_disk: a.disk_quota_mb > 0 && a.disk_used_mb >= a.disk_quota_mb, over_bandwidth: a.bandwidth_limit_mb > 0 && a.bandwidth_used_mb >= a.bandwidth_limit_mb }));
    return { reseller: username, suspended: detail.suspended, limits: detail.limits, usage: detail.usage, accounts: list };
  }

  function usageAll() {
    return stmts.owners.all().filter((u) => u.role === 'reseller').map((u) => { const d = shape(stmts.userById.get(u.id), { withAcls: false }); return { username: d.username, email: d.email, suspended: d.suspended, limits: d.limits, usage: d.usage, account: d.account }; });
  }

  // --- Email all resellers ---------------------------------------------------------------

  function recipients() {
    const rows = stmts.owners.all().filter((u) => u.role === 'reseller').map((u) => shape(stmts.userById.get(u.id), { withAcls: false }));
    const withEmail = rows.filter((r) => r.email);
    return { total: rows.length, withoutEmail: rows.length - withEmail.length, recipients: withEmail.map((r) => ({ username: r.username, email: r.email, accounts: r.usage.accounts, suspended: r.suspended })) };
  }

  function senderFor() {
    if (ctx.contacts?.sendMail) return { kind: 'contacts', send: (msg, req) => ctx.contacts.sendMail(msg, req) };
    if (ctx.mail?.sendNotification) return { kind: 'mail', send: (msg, req) => ctx.mail.sendNotification(msg, req) };
    return { kind: 'agent', send: (msg, req) => agent.op('mail.sendmail', { from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text }, { req }) };
  }

  // Job records (params, result, logs) are readable by every reseller through
  // /api/jobs, so the message and the addresses never go into them: the job
  // carries only the broadcast id and the handler resolves recipients when it runs.
  function emailAll({ subject, text, from }, user, req) {
    const sender = senderFor();
    if (sender.kind !== 'contacts' && !capabilities.has('exim')) throw new CapabilityError('exim', 'Exim is not installed, so the panel cannot send email. Install exim4 (Debian/Ubuntu) or exim (RHEL) to email resellers.');
    const list = recipients();
    if (!list.recipients.length) throw unprocessable('No reseller has an email address', { subject: ['Nothing to send'] });
    const sendFrom = from || settings.get('resellers.email_from', '') || settings.get('mail.notification_from', '') || `root@${hostname()}`;
    const broadcastId = Number(stmts.insertBroadcast.run(subject, text, sendFrom, user.username).lastInsertRowid);
    const job = ctx.jobs.enqueue('resellers.email_all', { broadcastId, requestedBy: user.username }, { userId: user.id });
    stmts.broadcastJob.run(job.id, broadcastId);
    audit(req, { action: 'reseller.email_all', target: 'resellers', args: { subject, recipients: list.recipients.length, from: sendFrom, job: job.id, broadcast: broadcastId } });
    return { job, broadcast: broadcastId, recipients: list.recipients.length, from: sendFrom };
  }

  const fill = (template, vars) => String(template).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => (vars[k] ?? ''));

  function shapeBroadcast(row) {
    return { id: row.id, subject: row.subject, from: row.from_address, requested_by: row.requested_by, job_id: row.job_id, status: row.status, sent: parseList(row.sent_json), failed: parseList(row.failed_json), created_at: row.created_at, finished_at: row.finished_at };
  }

  async function runEmailAll(jobCtx) {
    const { broadcastId, requestedBy } = jobCtx.params;
    const row = stmts.broadcastById.get(broadcastId);
    if (!row) throw new Error(`Broadcast ${broadcastId} no longer exists`);
    const { subject, body: text, from_address: from } = row;
    const list = recipients().recipients;
    const sender = senderFor();
    const sent = [];
    const failed = [];
    jobCtx.log(`Sending broadcast #${broadcastId} to ${list.length} reseller(s) via ${sender.kind}`);
    for (const [i, r] of list.entries()) {
      const vars = { username: r.username, email: r.email, hostname: hostname(), accounts: r.accounts };
      try {
        await sender.send({ to: r.email, from, subject: fill(subject, vars), text: fill(text, vars) }, null);
        sent.push(r.username);
        jobCtx.log(`${r.username}: accepted`);
      } catch (err) {
        failed.push({ username: r.username, email: r.email, error: err.message });
        jobCtx.log(`${r.username}: ${err.message}`, 'warn');
        if (err.code === 'capability_missing' || err.code === 'binary_not_found' || err.status === 501) { jobCtx.log('Mail server is not available; stopping', 'error'); break; }
      }
      jobCtx.progress(((i + 1) / list.length) * 100, `${sent.length} sent, ${failed.length} failed`);
    }
    stmts.broadcastStatus.run(failed.length ? (sent.length ? 'partial' : 'failed') : 'done', JSON.stringify(sent), JSON.stringify(failed), broadcastId);
    ctx.auditRecord?.(null, { action: 'reseller.email_all.result', target: requestedBy, args: { subject, broadcast: broadcastId, sent: sent.length, failed: failed.length } });
    return { broadcast: broadcastId, sent, failed: failed.map((f) => ({ username: f.username, error: f.error })), total: list.length };
  }

  // Root-only: what was sent and to whom (addresses included), per broadcast.
  function emailHistory(limit = 50) {
    return stmts.broadcasts.all(limit).map(shapeBroadcast);
  }

  // --- Hooks for other categories ---------------------------------------------------------

  const aclsFor = (userId) => aclState(userId).granted;
  function hasAcl(user, key) {
    if (!user) return false;
    if (isRoot(user)) return true;
    if (user.role !== 'reseller') return false;
    const { configured, granted } = aclState(user.id);
    return !configured || granted.has('all') || granted.has(key);
  }
  const ACL_LABELS = Object.fromEntries(ACL_GROUPS.flatMap((g) => g.acls.map((a) => [a.key, a.label])));
  function assertAcl(user, key) {
    if (!hasAcl(user, key)) throw forbidden(`Your reseller privileges do not include "${ACL_LABELS[key] || key}"`);
  }
  const isServerSharedAddress = (address) => address === (settings.get('basic.shared_ip') || null) || address === (settings.get('basic.main_ip') || null);
  // reseller_limits.shared_ip is free text checked at write time; the address may
  // since have been removed under IP Functions, dedicated, reserved or delegated to
  // another reseller, so it only counts while the write-time rule still holds.
  function effectiveSharedIp(userId, limits = stmts.limits.get(userId)) {
    const address = limits?.shared_ip ?? null;
    if (!address) return null;
    const row = stmts.ipByAddress.get(address);
    if (!row || row.dedicated_to) return null;
    if (row.is_main || isServerSharedAddress(address)) return address;
    if (row.reserved || !row.managed) return null;
    return row.delegated_to == null || row.delegated_to === userId ? address : null;
  }
  function sharedIpFor(user) {
    if (!user || isRoot(user)) return null;
    return effectiveSharedIp(user.id);
  }
  function nameserversFor(ownerId) {
    const row = ownerId ? stmts.limits.get(ownerId) : null;
    return row ? parseList(row.nameservers) : [];
  }

  // Shared by the create and modify policies. `exclude` is the account being
  // changed, so its current allocation does not count against the limit twice.
  function policyContext(user) {
    const limits = { ...EMPTY_LIMITS, ...(stmts.limits.get(user.id) || {}) };
    if (limits.privileges_suspended) throw forbidden('Your reseller privileges are suspended');
    const { configured, granted } = aclState(user.id);
    return {
      limits, configured,
      allowed: (key) => !configured || granted.has('all') || granted.has(key),
      explicitly: (key) => configured && (granted.has('all') || granted.has(key)),
    };
  }

  // Global (root-owned) packages are subject to the allowed list and the
  // viewglobalpackages privilege; another reseller's packages are never usable.
  function assertPackageUsable(user, pol, pkgName) {
    const pkg = pkgName ? stmts.packageByName.get(pkgName) : null;
    if (!pkg || pkg.owner_id === user.id) return;
    const allowedPackages = parseList(pol.limits.allowed_packages);
    const usable = pkg.owner_id == null && (allowedPackages.length ? allowedPackages.includes(pkg.name) : pol.allowed('viewglobalpackages'));
    if (!usable) throw forbidden(`Package "${pkg.name}" is not available to your reseller account`);
  }

  function assertAllocation(pol, kind, { allocated, next, unlimitedAcl, label }) {
    const { limits } = pol;
    const max = kind === 'disk' ? limits.max_disk_mb : limits.max_bandwidth_mb;
    const oversell = kind === 'disk' ? limits.oversell_disk : limits.oversell_bandwidth;
    if (max == null || oversell) return;
    // 0 is "no quota" for setquota and for packages, so it needs the unlimited ACL like NULL.
    if (next == null || next === 0) { if (!pol.explicitly(unlimitedAcl)) throw resellerLimit(`Unlimited ${label} is not allowed while your reseller ${label} limit is set`); return; }
    if (allocated + next > max) throw resellerLimit(`This account would allocate ${allocated + next} MB of ${label}, over your reseller limit of ${max} MB`);
  }

  function assertIpUsable(user, pol, ip) {
    if (!ip) return;
    const row = stmts.ipByAddress.get(ip);
    const usable = ip === effectiveSharedIp(user.id, pol.limits) || ip === (settings.get('basic.shared_ip') || null) || (row && row.delegated_to === user.id);
    if (!usable) throw forbidden(`${ip} is not delegated to your reseller account`);
  }

  // Called by accounts.create for resellers. Limits apply only once Reseller
  // Center wrote a limits row; ACLs once a privilege editor saved them.
  function createPolicy(user, { pkgName, plan = {}, ip } = {}) {
    if (!user || isRoot(user)) return { sharedIp: null };
    const pol = policyContext(user);
    if (!pol.allowed('create-acct')) throw forbidden('Your reseller privileges do not include creating accounts');
    const s = stats(user.id);
    if (pol.limits.max_accounts != null && s.accounts >= pol.limits.max_accounts) throw resellerLimit(`You have reached your limit of ${pol.limits.max_accounts} account(s)`);
    assertPackageUsable(user, pol, pkgName);
    assertAllocation(pol, 'disk', { allocated: s.disk_allocated_mb, next: plan.disk_mb ?? null, unlimitedAcl: 'allow-unlimited-disk-pkgs', label: 'disk space' });
    assertAllocation(pol, 'bandwidth', { allocated: s.bandwidth_allocated_mb, next: plan.bandwidth_mb ?? null, unlimitedAcl: 'allow-unlimited-bw-pkgs', label: 'bandwidth' });
    assertIpUsable(user, pol, ip);
    return { sharedIp: effectiveSharedIp(user.id, pol.limits) };
  }

  // Called by accounts.modify for resellers with the values the account will
  // have after the change; only what actually changes is checked, so an
  // account that already exceeds a later-lowered limit can still be edited.
  function modifyPolicy(user, account, { pkgName, diskQuotaMb, bandwidthLimitMb, ip } = {}) {
    if (!user || isRoot(user)) return;
    const pol = policyContext(user);
    if (!pol.allowed('edit-account')) throw forbidden('Your reseller privileges do not include modifying accounts');
    const packageChanged = pkgName && pkgName !== account.package_name;
    const diskChanged = diskQuotaMb !== undefined && diskQuotaMb !== account.disk_quota_mb;
    const bwChanged = bandwidthLimitMb !== undefined && bandwidthLimitMb !== account.bandwidth_limit_mb;
    const ipChanged = ip && ip !== account.ip;
    if (packageChanged && !pol.allowed('upgrade-account')) throw forbidden('Your reseller privileges do not include upgrading or downgrading accounts');
    if (diskChanged && !packageChanged && !pol.allowed('quota')) throw forbidden('Your reseller privileges do not include modifying disk quotas');
    if (bwChanged && !packageChanged && !pol.allowed('limit-bandwidth')) throw forbidden('Your reseller privileges do not include limiting bandwidth');
    if (ipChanged && !pol.allowed('add-pkg-ip')) throw forbidden('Your reseller privileges do not include assigning IP addresses');
    if (packageChanged) assertPackageUsable(user, pol, pkgName);
    const s = stats(user.id);
    if (diskChanged) assertAllocation(pol, 'disk', { allocated: s.disk_allocated_mb - (account.disk_quota_mb || 0), next: diskQuotaMb, unlimitedAcl: 'allow-unlimited-disk-pkgs', label: 'disk space' });
    if (bwChanged) assertAllocation(pol, 'bandwidth', { allocated: s.bandwidth_allocated_mb - (account.bandwidth_limit_mb || 0), next: bandwidthLimitMb, unlimitedAcl: 'allow-unlimited-bw-pkgs', label: 'bandwidth' });
    if (ipChanged) assertIpUsable(user, pol, ip);
  }

  function catalog() {
    const sharedIp = settings.get('basic.shared_ip') || null;
    return {
      aclGroups: ACL_GROUPS, aclLists: aclLists.list(), defaultAclList: settings.get('resellers.default_acl_list', 'standard'),
      packages: stmts.packages.all().map((p) => ({ name: p.name, owner: p.owner ?? 'root' })),
      addresses: stmts.ips.all().filter((r) => r.managed && !r.dedicated_to).map((r) => ({ address: r.address, family: r.family, is_main: Boolean(r.is_main), reserved: Boolean(r.reserved), delegated_to: r.delegated_user ?? null, server_shared: r.address === sharedIp })),
      defaultNameservers: settings.get('basic.nameservers', []), serverSharedIp: sharedIp, mainIp: settings.get('basic.main_ip') || null,
      owners: stmts.owners.all().map((u) => ({ username: u.username, role: u.role })),
      candidateAccounts: db.prepare("SELECT a.username, a.domain, a.contact_email FROM accounts a LEFT JOIN users u ON u.username = a.username WHERE u.id IS NULL OR u.role = 'user' ORDER BY a.username").all(),
      mail: { available: Boolean(ctx.contacts?.sendMail) || capabilities.has('exim') },
    };
  }

  return {
    ACL_GROUPS,
    list(query) {
      const where = ["u.role = 'reseller'"];
      const params = {};
      if (query.q) { where.push('(u.username LIKE @q OR u.email LIKE @q)'); params.q = `%${query.q}%`; }
      const result = paginate(db, { select: 'u.*', from: 'users u', where, params, sortable: { username: 'u.username', created_at: 'u.created_at', last_login_at: 'u.last_login_at' }, defaultSort: 'username', query });
      return { ...result, data: result.data.map((u) => shape(u, { withAcls: false })) };
    },
    get(username, user) { assertSelfOrRoot(username, user); return shape(loadReseller(username), { forRoot: isRoot(user) }); },
    catalog, create, update, setPrivileges, setSuspended, reset, aclLists,
    delegation, setDelegation, setSharedIp, changeOwner, changeOwnerBulk, accounts, usage, usageAll,
    recipients, emailAll, runEmailAll, emailHistory,
    aclsFor, hasAcl, assertAcl, sharedIpFor, nameserversFor, createPolicy, modifyPolicy, delegatedAddresses: (userId) => stmts.delegatedTo.all(userId),
    isReseller: (username) => stmts.userByUsername.get(username)?.role === 'reseller',
  };
}
