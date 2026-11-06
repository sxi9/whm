# Cross-category contracts for the wave-1 fix round

These decisions resolve the seams the integration critic found. Every fixer must follow them;
they are authoritative over anything a builder did earlier.

## 1. Service names on ctx (authoritative)
`ctx.security` (security-center), `ctx.dns` (dns-functions), `ctx.databases` (database-services —
never `ctx.db`, which is the SQLite handle, and never `ctx.db_services`), `ctx.ip` (ip-functions),
`ctx.ssl` (ssl-tls), `ctx.mail` (email), `ctx.software` (software) **plus the alias
`ctx.pkg = ctx.software.pkg`** set by software's register(), `ctx.web` (service-configuration),
`ctx.development`, `ctx.locales`. Consumers reference them lazily inside methods and tolerate absence.

## 2. "Configure Remote Service IPs" hooks (ip-functions is the caller)
ip-functions calls, when present: `ctx.mail.setOutboundAddresses({ ipv4, ipv6 })`,
`ctx.dns.setOutboundAddresses({ ipv4, ipv6 })`, `ctx.databases.setClientAddresses({ ipv4, ipv6 })`.
- email implements `setOutboundAddresses` (Exim: `interface = <ipv4> ; <ipv6>` for the remote_smtp
  transport in the managed macro/include, validated with `exim -bV`, reload).
- dns-functions implements `setOutboundAddresses` (BIND options `query-source address <ipv4>;`,
  `query-source-v6 address <ipv6>;`, `notify-source`/`transfer-source` in the managed include,
  `named-checkconf`, reload).
- database-services implements `setClientAddresses` (MySQL client `[client] bind-address` in the
  credentials/defaults file used for remote profiles; recorded in settings).
Each returns `{ applied: true }` or throws CapabilityError when the daemon is missing. ip-functions
records per-service outcome and never fails the whole request because one hook is absent.

## 3. Dovecot drop-ins
service-configuration owns `97-whm-mailserver.conf` (protocols, limits, `ssl = …`,
`ssl_min_protocol`, `ssl_cipher_list`, `ssl_prefer_server_ciphers`).
ssl-tls writes ONLY `ssl_cert = </path` and `ssl_key = </path` (and `ssl_ca` when a chain exists) into
`90-whm-ssl-cert.conf` — nothing else — and removes any other directive from its drop-in.
TLS protocol/cipher presets for Dovecot and Exim chosen in "SSL/TLS Configuration" are applied by
calling `ctx.web.applyMailserverTls({ minProtocol, cipherList })` and `ctx.web.applyEximTls({ … })`,
which service-configuration implements (stores in its settings, re-renders its files, validates,
reloads). ssl-tls keeps ownership of the Apache SSL protocol/cipher include.

## 4. Exim local RCPT ACL chain (Debian split config and RHEL)
service-configuration owns the single hook point: on Debian the macro
`CHECK_RCPT_LOCAL_ACL_FILE` → `/etc/exim4/whm/acl-rcpt-local.conf`; on RHEL an equivalent include in
the managed block of `/etc/exim/exim.conf`. That ACL file is rendered by service-configuration (its
dictionary-attack / rate / RBL protections) and ENDS with
`.include_if_exists /etc/exim4/whm/acl-email-filters.conf` (Debian) or
`/etc/exim/whm/acl-email-filters.conf` (RHEL).
email writes ONLY `acl-email-filters.conf` (country/domain/greylist rules) and never the macro.
service-configuration exposes `ctx.web.ensureEximAclChain()` which creates the macro + chain file if
"Exim Configuration Manager" has never been saved; email calls it (when `ctx.web` exists) before
writing its file. Fallback when `ctx.web` is absent: email may set the macro itself (current code).

## 5. Exim layout detection (shared)
Put the Debian/RHEL Exim layout detection in a new helper module `agent/src/ops/exim-layout.js`
(pure functions, defines no ops; the loader imports it harmlessly) and use it from BOTH `mail.js`
and `web.js`. It must read `dc_use_split_config` from `/etc/exim4/update-exim4.conf.conf`: when
`'true'` use `conf.d/` fragments; when `'false'` (Debian default) write macros to
`/etc/exim4/exim4.conf.localmacros` and ACL hooks through the macros, then run
`update-exim4.conf` and validate with `exim -bV`. Never flip the operator's split-config setting.

## 6. Migrations
Never edit a migration that may already have been applied. Add a new file instead (e.g.
`002b_security-center-firewall.sql`) using `CREATE TABLE IF NOT EXISTS` / `INSERT OR IGNORE`; it is
fine for the original file to also contain the objects as long as both are idempotent.

## 7. Agent errors → HTTP
The core error handler now maps agent error codes: `capability_missing`/`binary_not_found` → 501,
`invalid_args` → 422, `not_found` → 404, `exists` → 409, and **any code starting with `invalid_`,
ending with `_mismatch`, or in {`config_invalid`, `refused`, `validation_failed`, `acme_failed`,
`unsupported`, `in_use`}** → 422 with the op's message. Services may let such AgentErrors propagate
instead of wrapping them; still wrap when a friendlier message is needed.

## 8. Write-after-apply ordering
Any mutation that changes the host must run the agent op FIRST and commit the SQLite change only
after it succeeds (or run both inside a try with compensation). A record must never say "applied"
when the host was not changed.

## 9. Scheduled jobs
A schedule must not enqueue persistent `jobs` rows for work that will be skipped. Toggle the
schedule's `enabled` flag (via `ctx.scheduler.update(name, { enabled })`) when the feature is
enabled/disabled, or check the precondition inside the scheduler-facing wrapper before enqueueing.

## 10. Reseller ACLs, limits and nameservers (resellers is the owner)
`ctx.resellers` (tolerate absence: every call below is `ctx.resellers?.<fn>?.(…)`) exposes:
- `hasAcl(user, key)` / `assertAcl(user, key)` — root is always allowed; a reseller whose ACLs were
  never saved (no `reseller_acls` rows) keeps ownership-only access; once saved, every key is stored
  with value 0/1 and an empty selection denies everything (`'all'` grants every key).
- `createPolicy(user, { pkgName, plan, ip })` and `modifyPolicy(user, account, { pkgName, diskQuotaMb,
  bandwidthLimitMb, ip })` — limits, allowed/global packages and IP delegation. Core `accounts.create`
  and `accounts.modify` call them; any category that creates or re-plans accounts by another path must too.
- `nameserversFor(ownerId)` → `string[]` (empty = server defaults). Core `accounts.create` passes it as
  `ctx.dns.ensureZoneForDomain(domain, { ip, accountId, nameservers })`. **dns-functions must consume
  `nameservers` (ns1/ns2 for the SOA/NS template) and fall back to `basic.nameservers` when absent**;
  until it does, zones for reseller-owned accounts advertise the server defaults and "Edit Reseller
  Nameservers and Privileges" counts as partial (resellers' test `passes the reseller's nameservers to
  DNS Functions` pins the call shape; `owns_nameservers` stays informational either way).
- `sharedIpFor(user)`, `delegatedAddresses(userId)` — the only addresses a reseller may assign.

ACL keys enforced by core (`services/accounts.js`): `create-acct`, `suspend-acct` (suspend/unsuspend),
`kill-acct` (terminate), `passwd`, `edit-account` (any modify), `upgrade-account` (package change),
`quota`, `limit-bandwidth`, `add-pkg-ip` (IP change), `viewglobalpackages`, `allow-unlimited-disk-pkgs`,
`allow-unlimited-bw-pkgs`. Keys each category must check on its own reseller-reachable routes
(`ctx.resellers?.assertAcl?.(req.user, key)` in the service): packages `add-pkg` (create/delete),
`edit-pkg`; account-functions/multi-account `rearrange-accts`, `demo-setup`, `add-pkg-shell`,
`show-bandwidth`, `acct-summary`, `list-accts`; dns-functions `add-dns`, `edit-dns`, `kill-dns`,
`clustering`; email `edit-mx`, `mailcheck`, `mail-queue`; ssl-tls `ssl`, `ssl-info`, `ssl-gencrt`,
`ssl-buy`; server-status/service-manager `status`, `stats`, `restart`; locales `locale-edit`;
development/API tokens `cpanel-api`, `thirdparty`; security `digest-auth`, `mysql-superuser`,
`disallow-shell`; server-contacts/news `news`. Until a category wires its key, that key is stored
but not enforced.

---

# Wave-2 contracts (binding; added after the wave-2 build)

## 11. Service names on ctx (authoritative, wave 2)
`ctx.accountFunctions` (account-functions), `ctx.accountInfo` (account-information),
`ctx.multiAccount` (multi-account-functions), `ctx.resellers`, `ctx.backup`, `ctx.transfers`,
`ctx.serverStatus` (server-status), `ctx.systemHealth` (system-health), `ctx.serverConfig`
(server-configuration), `ctx.networking` (networking-setup), `ctx.contacts` (server-contacts),
`ctx.systemReboot` (system-reboot). Hooks core relies on and that MUST keep their names/signatures:
`ctx.resellers.assertAcl/createPolicy/modifyPolicy/nameserversFor`,
`ctx.accountFunctions.mountpointFor/renderTemplate/runBandwidthEnforce/resetBandwidth`,
`ctx.serverConfig.profile.summary()`, `ctx.contacts.notify(event, payload)` and
`ctx.contacts.sendMail({ to, subject, text })`. Reference other services lazily inside methods and
tolerate absence (optional chaining).

## 12. Bandwidth: one owner per concern
- **account-information owns collection and the `account_bandwidth` table** (job
  `account_info.bandwidth_collect`). Its collect job MUST NOT call enforcement.
- **account-functions owns enforcement and reset**: the toggle, the schedule
  `account-bandwidth-enforce` (the only enforcement schedule) and `resetBandwidth`. To clear the
  current period it calls `ctx.accountInfo.resetPeriod(usernames)` (account-information adds this
  method; it deletes/zeroes the current period rows of its own table) and falls back to zeroing
  `accounts.bandwidth_used_mb` when the method is absent.
- `ctx.accountInfo.resetBandwidth` delegates to `ctx.accountFunctions.resetBandwidth` when present.
- account-information's domlog listing uses the op maximum (`limit: 10000`) and logs a warning
  through the job when a directory hits the cap; never silently under-count.

## 13. Update checks: software owns the schedule
software's `os-update-check` schedule (job `software.update.check`) is the single scheduled check.
server-configuration removes its `update-preferences-check` schedule (do not enqueue it; drop the
`scheduler.ensure` call and delete the row in a new `020b_` migration), reads "last check" from
software's settings through `ctx.software.update.status()`, and its "Check now" button enqueues software's
`software.update.check` job (`ctx.jobs.enqueue`), returning `202 { job }`. Update Preferences keeps owning the release channel / auto-update
preference settings and passes them to software through `ctx.software.panel.setPreferences(...)` if
that method exists, otherwise stores them under `updates.*` for software to read.

## 14. Vhost results and IP changes (service-configuration is the owner of the semantics)
`ctx.web.ensureVhost` may return `{ applied: false, reason: 'php_missing' | 'php_pool_failed', … }`
AFTER the vhost files were written and Apache reloaded; that is a PHP-handler warning, not a vhost
failure. Consumers changing an address MUST call `ctx.web.replaceIp(previousIp, newIp, { accounts:
[username] }, req)` (rewrites only the address; reports `updated`) instead of `ensureVhost`, and
treat `reason in { php_missing, php_pool_failed }` as applied-with-warning anywhere `ensureVhost` is
still used. Applies to multi-account-functions (Change Multiple Sites' IP Addresses) and
account-functions (Change Site's IP Address).

## 15. Long agent calls in split mode
`lib/agent-client.js` times out socket calls after 1 h unless `{ timeoutMs }` is passed. Every
service that calls an op declared with a longer agent-side `timeoutMs` (backup archive/restore/
import/upload/download; transfers rsync/extract/stream) passes `{ req, timeoutMs: <op timeout> +
60_000 }` from its `op()` helper (a LONG_OPS map keyed by op name).

## 16. Untrusted content is never recreated as root with special files
transfers: rsync uses `-rlpt` (never `-D`, `--devices`, `--specials`); archives are listed with
`tar -tvf` first and any member of type `b`/`c` (device) or with an absolute/`..` path is refused
with `invalid_archive` before extraction; agent tests cover both. backup's own archives are
produced by the panel, but `backup.files.restore` applies the same member filter.

## 17. Restores never widen privileges
backup: database-user grants from an archive are replayed only for databases that
`databaseClaim()` accepted for this account (reuse `parseGrant`/ownership); global (`*.*`) and
system-schema grants (mysql, information_schema, performance_schema, sys) are dropped. The agent
op `backup.db.restore_users` rejects `ON *.*` and system-schema grants itself (defence in depth)
and takes an `allowedDatabases` list. Restoring a terminated account re-adds every parked/addon/
sub domain from `metadata.domains` (insert `account_domains` rows and provision the vhost via
`ctx.web.ensureVhost`; record per-domain outcomes in `summary.steps.domains`).

## 18. Reseller-safe operations
transfers: "Move databases to the new account" is root-only because `ctx.databases.assign` is
root-only — the preview reports an `issue` for non-root callers and the page hides the toggle for
resellers; the reseller test covers it. `removeSource` on Convert Addon Domain is refused (issue,
re-checked before `fs.remove`) when the docroot equals the account's `home_dir` or
`<home_dir>/public_html`, or contains/equals another domain's docroot of that account.

## 19. Moving a live account (Rearrange an Account)
account-functions: lock the Linux user (`user.lock`) and record a `rearrange` suspension before the
first copy; unlock at the end. Remove the old tree ONLY when `acct.set_home` and the vhost rewrite
both succeeded; otherwise keep both trees, record the state in the job and tell the operator. On an
exception after the copy, remove the partial target tree and restore the previous home. Test: old
home kept when `ctx.web.ensureVhost` throws.

## 20. Migrations
`012` is used by both `012_account-functions.sql` and `012_development-token-expiry.sql` (a
documented exception; both apply in filename order). Never reuse a number: wave-2 categories own
013–023 as assigned; follow-ups are `0NNb_<slug>-<topic>.sql`, idempotent, never editing a
committed file.

## 21. Schedules and settings toggles
Where a feature has an enable/disable setting (process-log sampler, system-health BPK, bandwidth
enforcement), the setting is the single source of truth and the schedule row follows it; the
generic schedules endpoint (Configure cPanel Cron Jobs) may change cron/enabled too, so
`alignSchedule`/`syncSchedule` helpers must only write the row when the setting changed (compare
before writing), never on every page load.

## 22. Themes: account-default resolution (core-owned hook, pending)
`ctx.themes.resolveForPackage(pkg)` returns `pkg.theme` when that theme exists and is enabled,
otherwise the root-configured account default (`themes.account_default`). The one integration
point is core's `packages.snapshot(name)` (`server/src/services/packages.js`), which must return
`theme: ctx.themes?.resolveForPackage(pkg) ?? pkg.theme` so that every account created or
re-planned from a package (`accounts.create` / `accounts.update`) snapshots a live theme.
`createPackagesService(ctx)` already receives the full ctx; resolve lazily inside `snapshot()`
because themes registers after packages. Until this lands, `ctx.themes.accountDefaultApplied()`
(and `meta.accountDefaultApplied` on `GET /api/themes`) reports `false` by probing whether
`snapshot()` reaches `resolveForPackage`, and the Theme Manager tells root the setting is stored
but not applied. Required core follow-up: make the change and add a server test asserting an
account created from a package whose theme is disabled snapshots the account default.

## 23. Clusters: DNS pushes, configuration pushes and cluster tokens (clusters is the owner)
- **"Accept zones pushed by peers"** (`clusters.dns.accept_pushes`) must bite on the path peers
  actually use. The DNS module's `dns.sync` job posts to `POST /api/dns/zones/import` with an API
  token, so clusters mounts a guard router in front of that exact path (`register()` returns a
  second mount `{ path: '/dns/zones/import' }`; category routers mount alphabetically, so it runs
  before dns-functions) which refuses token-authenticated requests with 403 while the toggle is off
  and logs a `dns.receive` / `skipped` exchange event. Sessions (root importing a zone by hand) pass.
  Required dns-functions follow-ups so the guard is not the only line: (a) `POST /zones/import`
  calls `ctx.clusters?.dns?.guardImport?.(req)` first (lazy, tolerate absence), and (b) `runSync`
  targets `/api/clusters/dns/receive` when the peer's last test stored `remote_json.clusterAware`
  (`cluster_peer_options`), falling back to `/zones/import` for older panels. `ctx.clusters.acceptsDnsPushes()`
  exposes the toggle.
- **Configuration cluster allowlist** lives in `server/src/services/clusters-config.js`: an explicit
  key → `{ group, schema, apply }` map. Nothing outside it travels (host identity, addresses,
  daemon selection, per-host paths, `*_updated_at` / `last_*` stamps, secrets). A receiving server
  refuses keys it does not know locally, validates each value against the key's zod schema (strict
  for objects: unknown fields reject the whole key) and then calls the owning service's validated
  update path (`ctx.web.apache|exim|mailserver|logrotate|webdisk|webservices.update`,
  `ctx.ssl.tls.update` / `ctx.ssl.autossl.updateSettings`, `ctx.mail.greylist.update` /
  `ctx.mail.filters.setMessages`, `ctx.security.cphulk.updateSettings` / `ctx.security.smtp.set`,
  `ctx.backup.updateConfig`, `ctx.software.panel.updateSettings` / `update.setAuto` /
  `php.setSystemDefault`, `ctx.contacts.updateSettings` / `setMailPreferences`,
  `ctx.systemHealth.setConfig`, `ctx.serverConfig.stats.update`). Owners keep their contract:
  store, then write the host; throw `CapabilityError` when the daemon is missing. Clusters reports
  per key `applied` (reached the host or live from the DB), `stored` (saved, daemon missing) or
  `failed` (owner refused; `stored` flag says whether the value stuck). Owners adding a new
  cluster-worthy setting add it to the allowlist with its schema and apply name.
- **Cluster tokens** are root `api_tokens` rows with scopes `["clustering"]`, and `clustering` is a
  *confined* scope: `middleware/auth.js` keeps a registry `ctx.confinedScopes` (scope →
  `[{ method, path }]`, paths as mounted under `/api`), clusters' `register()` fills it with
  `CLUSTER_TOKEN_ROUTES` (`GET /api/clusters/ping`, `POST /api/clusters/dns/receive`,
  `GET /api/clusters/config/export`, `POST /api/clusters/config/receive`, `POST /api/dns/zones/import`),
  and `requireAuth` answers 403 `scope_confined` to a token whose scopes are all confined on any
  other route (core routers included). A token mixing in an unconfined scope is not confined and
  keeps the per-route `requireScope()` rules. Any category that hands tokens to other machines
  registers its scope the same way.
- **URL settings with credentials stay local.** `software.update_url` and
  `mail.country_filter.source_url` may carry basic-auth userinfo (Software sends it as a header);
  the allowlist schema refuses such a value on receive and `exportValue()` leaves it out of exports
  and pushes. A refused value is scrubbed from `req.body` before the request audit records it.

## 24. Core: capability detection is chunked (landed from the support task; core owns it)
`server/src/lib/capabilities.js` `refresh()` asks `sys.binaries` for at most 100 names per call
and merges the answers. The op's schema caps `names` at 100 and the categories already register
103 unique programs at boot, so without the chunking every boot would fail detection. This is a
core change made from a category task because boot depended on it; core owns it from here. Its
regression test lives in the core suite (`server/test/api.test.js`, "detects capabilities within
the agent schema limit"), not in a category suite. Categories must not raise the per-call limit
or bypass `ctx.capabilities.register` to get around it.

## 25. Support: `expiry-time` on root's authorized_keys (support is the owner)
`ctx.support.access.grant` writes the support engineer's key through `sec.ssh_keys.add` as
`expiry-time="YYYYMMDDHHMMSS" <key>`: host-local time, no `Z`. OpenSSH accepts the option since
7.7 but only parses the UTC `Z` form from 9.1; an older sshd drops the whole line ("bad key
options"), so the local form is the one that works everywhere. The exact string written is kept
in `support_access_grants.ssh_expiry` and surfaced as `ssh.expiry` next to `expiryTimeZone`
(the panel's `Intl` zone, i.e. `/etc/localtime`). Security Center's key listing shows the
options token as-is and must not rewrite it. `ctx.support.activeGrants()` lists grants whose key
may still be on the host.

---

# Wave-3 fix-round contracts (binding)

## 24. Service names on ctx (authoritative, wave 3)
`ctx.clusters`, `ctx.themes`, `ctx.market`, `ctx.cpanel`, `ctx.support`, `ctx.bundledPlugins`
(Plugins category); the core plugin host stays `ctx.plugins`. `ctx.events` (PanelEvents) is now
**created by core** in `server/src/index.js` before any category registers (class in
`server/src/lib/events.js`, re-exported by `services/development.js`); categories must never create
it, only use it.

## 25. Core items already done by the integrator (do not redo; build on them)
- `packages.snapshot()` resolves `theme` through `ctx.themes?.resolveForPackage?.(pkg) ?? pkg.theme`
  (contract §22 fulfilled); the themes fixer removes the "Not applied yet" probe/banners and asserts
  the behaviour in a test that creates an account from a package whose theme is disabled.
- `routes/index.js` accepts `{ path, router, public: true }` mounts from `register(ctx)`; public mounts
  are served **before** `requireAuth`. cpanel returns its `/branding` router as public and that router
  may only contain read-only `GET /` (no inline logo bytes; no PII) and `GET /:kind` image handlers —
  every mutation stays on the authenticated `/cpanel/branding*` routes. The login page then reads
  `/api/branding` unauthenticated (company name, logo, favicon, login notice).
- `middleware/audit.js` `redact()` summarises Buffers/typed arrays as `{ bytes: n }`, so raw uploads
  no longer bloat the audit log (cpanel may additionally replace `req.body` with a summary).

## 26. Clusters: token purpose and inbound trust
- Cluster tokens carry **one** of two scopes: `clustering:dns` (ping, `/api/clusters/dns/receive`,
  `/api/dns/zones/import`) or `clustering:config` (ping, `/api/clusters/config/export`,
  `/api/clusters/config/receive`). The DNS Cluster page issues `clustering:dns`, the Configuration
  Cluster page issues `clustering:config`; `requireScope` on each endpoint checks the matching scope
  (a legacy bare `clustering` token keeps working for DNS only and is flagged in the token list).
- `clusters.config.accept_pushes` defaults to **false** (new migration `025b_`), and the receiver
  enforces its own group selection: `config.diff()/receive()` reject keys whose group is not in this
  server's `clusters.config.groups` (`422 group_not_shared`). The 'security' and 'software' groups are
  excluded from the default selection.
- Successful inbound zone pushes are recorded in the exchange log: the import guard mounted in
  front of `POST /api/dns/zones/import` records `dns.receive` with status ok/failed from the response
  status (domain + serial from the body) for token-authenticated calls; `/api/clusters/dns/receive`
  stays as the logged equivalent.
- dns-functions (in this round): `POST /dns/zones/import` calls `ctx.clusters?.dns?.guardImport?.(req)`
  before importing (a thrown HttpError is returned as-is), and `runSync` prefers
  `/api/clusters/dns/receive` when the peer's `/api/clusters/ping` answers (cache the capability per
  peer for the run), falling back to `/api/dns/zones/import`.
- The configuration-cluster group list gains a `branding` group (branding.*, themes.*, support.*,
  market.providers) so Customization/Theme/Support settings replicate; `clusters.config.groups`
  defaults and `GROUP_NAMES` must agree (one source of truth).

## 27. cPanel
- Upgrade to Latest Version delegates the release check to Software: call
  `ctx.software.panel.check()` / read `ctx.software.panel.status()` (whatever software exposes for the
  panel release feed — read `services/software.js`), never fetch the feed itself; record nothing under
  `cpanel.upgrade.last_check` (remove the key, new `028b_` migration deletes it). The upgrade job
  itself stays in cpanel.
- The reseller ACL `news` is enforced: resellers with the ACL may create/edit/delete news items whose
  audience is `resellers`-owned accounts only (`audience: 'own'`), through `ctx.resellers.assertAcl`;
  root keeps everything. Remove the dead core `news.html` setting reader expectation (document that
  the key is unused; delete it in `028b_`).
- Logo upload route replaces `req.body` with `{ size }` before returning (belt and braces).

## 28. Support
- The `support-access-expiry` schedule is enabled only while live grants exist (`scheduler.update`
  on grant/end/expire; disabled at register when none).
- `access.grant` with `ssh: true` reads `sec.sshd.get` and refuses (`422`) when PermitRootLogin is
  `no`/`forced-commands-only` or PubkeyAuthentication is `no`, pointing at Security Center.
- Grants cannot be created from an API-token-authenticated request (`403` when
  `req.auth?.via === 'token'`); the SSH half of a grant never outlives the issuing session's policy.

## 29. Plugins / Market / Themes
- The Plugins category's agent ops stay where they are (`sec.imunify.*`, `sec.clamav.*`,
  `sec.netdev.read` in `agent/src/ops/sec.js`; `web.wp.*` in `agent/src/ops/web.js`) as a documented
  exception (CLAUDE.md records the ownership). Do not move them.
- `ctx.market.hub()` stays declared (Phase 5 consumer); market removes the dead `market.providers`
  seed dependency by tolerating the row from `006_ssl-tls.sql` (no migration edits).
- Themes: `tweak.login_theme` is reconciled with the themes table — the Tweak Settings option list is
  not themes' file, so themes exposes `themes.slugs()` and documents that `tweak.login_theme` is
  legacy; `packages.theme` is validated against enabled theme slugs on package create/update **by the
  core packages route** (integrator) — themes provides `themes.isEnabledSlug(slug)`.
- Migration numbers: `024_plugins.sql` (core host) and `030_plugins.sql` (category) coexist; never
  reuse a number; follow-ups are `0NNb_<slug>-<topic>.sql`.

## 30. Capabilities
`quota` is registered by both account-information and server-configuration: server-configuration
is the owner (Initial Quota Setup); account-information must not register it (remove the call).

## 31. Scope-confined API tokens (core, `ctx.confinedScopes`)
A category may add scope names to `ctx.confinedScopes` (a Set) in `register(ctx)`; a token whose
scopes are all confined is accepted only by routes guarded with `requireScope(<one of them>)` and is
refused everywhere else, so a `clustering:dns` token can push zones but never act as root. Clusters
registers `clustering:dns`, `clustering:config` and the legacy `clustering`.

## 32. cPanel seams
`ctx.cpanel.branding.get()` (public via `GET /api/branding`), `ctx.cpanel.news.active(user)` (audience
`own` keyed on `accounts.owner_id`), `ctx.cpanel.upgrade.status()` reads the release only through
`ctx.software.panel.status()` (which keeps the feed's `sha256`/`signature`/`keyId`); release keys live
under `/etc/whm/release-keys`. Bundled plugins' node:test suites run from the root `npm test`.

## 33. Customer panel: vhost seams (service-configuration)
- `ctx.web.removeVhost(domain, req)` → `{ domain, username, type, hadRow, removed, path?, reloaded? }`. Host first
  (`web.vhost.remove { domain, reload: true }` when Apache is present; a domain without a `web_vhosts` row is still
  tried on the host so a stale file goes too), then the row, then audit `web.vhost.remove`. Without Apache the row
  is dropped and `{ removed: false, reason: 'capability_missing' }` comes back (never a throw). A `main` vhost whose
  account still exists is refused with 409: only `removeAccount` drops it. The panel calls it for addon/sub domains
  after its own `account_domains.account_id` check.
- `ctx.web.vhostsForAccount(username)` → the account's `web_vhosts` rows shaped like `vhostFor`.

## 34. Customer panel: the `account_id` ownership branch (`ownsRow`)
`server/src/middleware/rbac.js` exports `ownsRow(user, row, { accountId = row.account_id })`: root sees every row,
a reseller the rows whose `owner_id` is its id, a role-`user` principal only rows whose account id equals
`user.accountId` (the pin the panel's `scope()` puts on the principal) — never through `owner_id`, username
equality or a missing pin. It is the check in dns-functions (`visible`, `loadAccount`, unpark, forwarding
set/remove), ssl-tls (`visible`, `resolveAccount`, `resolveDomain`), software (`resolveDomain`),
account-functions (`load`) and email (`assertDomain`, `visibleDomains` — whose statement now carries
`account_id`). Root/reseller behaviour is byte-identical. Any new ownership check in a category service uses
`ownsRow`, with `{ accountId: row.id }` for an accounts row.

## 35. Customer panel: `ctx.mail.ensureMailDomain(domain, accountId, req?)`
Upserts the `mail_domains` row for a mailbox domain: creates it with routing `auto` for `accountId`, claims an
unowned row (`account_id IS NULL`) without touching its routing, returns `{ domain, accountId, routing, created,
claimed }` and audits `mail.domain.ensure` when a row was created or claimed. A row that belongs to another
account is a 409 and is **never re-pointed**; an unknown account is 404. The panel verifies the domain is the
account's before calling (the row is not proof of ownership for anything else).

## 36. Customer panel: virtual mail (`ctx.web.applyVirtualMail({ enabled }, req)`)
Service-configuration owns every file Exim/Dovecot load for the panel's mailboxes; the panel's `vmail.*` ops own
the data files. Setting `service_config.virtual_mail = { enabled, spamdAddress }`; `ctx.web.virtualMail.status()`
reports slots/hooks/`live`.
- **Agent layout (`web.exim.detect`)** gains `user`/`group` (the Exim run user, `Debian-exim`/`exim`), `vmail`
  (`passwdDir /etc/dovecot/whm/passwd`, `aliasesDir <whmDir>/aliases`, `domainForward <whmDir>/domainfwd.lst`,
  `autorespondersDir <whmDir>/autoresponders`, `spamUsers <whmDir>/spam_users.lst`, `autoreplyOnceDir
  /var/lib/whm/autoreply`, `dovecotBaseDir /var/run/dovecot`) and three driver slots: `router`
  (`conf.d/router/350_whm_virtual_mail`), `transport` (`conf.d/transport/30_whm_virtual_mail`), `auth`
  (`conf.d/auth/25_whm_dovecot`) on split Debian (live by file order: 350 sorts after `300_real_local`, before
  `400_system_aliases`/`600_userforward`/`900_local_user`); whole files `<whmDir>/{router,transport,auth}_*.conf`
  the admin `.include`s once on unsplit Debian and RHEL (detect's `hints` say where; Debian's unsplit template has
  no driver hook, and localmacros is the main section). A slot is **hooked** when `exim -bP
  router_list|transport_list|authenticator_list` lists `whm_virtual_user`/`whm_dovecot_lmtp`/`dovecot_plain`;
  the router slot also reports `precedes` (false when a local-delivery router comes first, which is a hint and
  makes the apply not live). `web.exim.include.write/remove` take the three new slot names; `web.dovecot.include.*`
  take `name` ∈ {`97-whm-mailserver.conf`, `98-whm-virtual-auth.conf`} (an enum, no paths).
- **Rendering (service, exported for tests):** `renderDovecotVirtualAuth({ passwdDir, eximUser, eximGroup, version })`
  (passwd-file passdb/userdb on `<passwdDir>/%d` — `passwd_file_path = <passwdDir>/%{user | domain}` in the
  named-section syntax of Dovecot 2.4, chosen by `dovecotIsV24(version)` from `web.dovecot.detect` —,
  `username_filter = *@*`, `result_success = return-ok` / `result_failure = continue`, no `username_format`: every
  passwd line is **keyed by `local@domain`**, the login name on both versions; the stock system passdb/userdb of
  `10-auth.conf` run first because conf.d sorts `98-` after it and fall through on failure, so Linux accounts
  never reach the passwd files and virtual addresses never reach PAM successfully; `mail_plugins quota` with the
  limit from the passwd line — `userdb_quota_rule=*:bytes=N` with `userdb_mail=maildir:~/mail/<domain>/<local>`
  on 2.3, `userdb_quota_storage_size=N` with `userdb_mail_driver=maildir userdb_mail_path=… userdb_mail_inbox_path=…` on 2.4 (the INBOX path is pinned inside the Maildir because Debian's 2.4 `mail_inbox_path` defaults to `/var/mail/%{user}`), written by
  `vmail.passwd.set` after one `dovecot --version` probe per agent process (`dovecotFormat()`); `service auth {
  unix_listener auth-client }` and `service lmtp { unix_listener lmtp }` opened 0660 to the Exim user/group),
  `renderEximVirtualRouters`
  (`whm_domain_forward` → `whm_aliases_copy` (unseen, mailbox exists) → `whm_aliases` → `whm_autoreply` (unseen,
  no-loop conditions) → `whm_virtual_user` → `whm_aliases_default`; every `domains`/`local_parts` list is
  `${if exists{FILE}{lookup;FILE}{}}` because an unopenable lookup file in a list is fatal in Exim, and every file
  name is built from `$domain_data`/`$local_part_data` (dsearch/lsearch results, untainted) — never from
  `$domain`/`$local_part`; a mailbox is found with `lookup{$local_part@$domain_data}lsearch{<passwdDir>/$domain_data}`,
  the same key the passwd line carries; redirects carry `forbid_pipe forbid_file allow_fail allow_defer`),
  `renderEximVirtualTransports` (`whm_dovecot_lmtp` lmtp over `<dovecotBaseDir>/lmtp`, `whm_autoreply` with
  `once = <autoreplyOnceDir>/<local>@<domain>.db`), `renderEximVirtualAuths` (`dovecot_plain`/`dovecot_login`,
  `server_advertise_condition` only when Exim Configuration Manager's `requireTlsForAuth` is on — the auth slot is
  rewritten by every `exim.apply` while virtual mail is enabled). `renderEximMain` adds `spamd_address` and
  defines `CHECK_DATA_LOCAL_ACL_FILE` regardless of DKIM; `renderEximDataAcl` appends `renderEximSpamAcl` — both
  only on an Exim with `Content_Scanning` (`eximSupport().contentScan`; exim4-daemon-light gets a warning).
- **Apply order:** `web.vmail.prepare { enabled: true }` (creates the four directories — passwd dir 0750
  root:dovecot, aliases/autoresponders 0755 root, once-db dir 0750 owned by the Exim user — and adds the Exim user
  to group `dovecot` with `gpasswd -a`, because routing and RCPT-time recipient verification run as the Exim user
  and must read the root:dovecot 0640 passwd files; `{ enabled: false }` removes the membership) →
  `vmail.passwd.rekey {}` (one-time upgrade of every `<passwdDir>/<domain>` file: a line still keyed by a bare
  local part — written before the key carried the domain — becomes `local@<domain>:…`, with the 2.3 maildir/quota
  fields renamed on a 2.4 host; already-keyed lines, the header and anything unparseable are untouched, so a second
  run reports `changed: 0`; atomic write 0640 root:dovecot; `{ dryRun: true }` only counts; an agent without the
  op does not block the apply, the result carries `rekeyed.error` and a warning) → Dovecot include
  (validated with `doveconf -n`, rolled back on error) → Exim `transport`, `router` (no reload) → `exim.apply`
  (`acl_data`, `acl_rcpt`, `auth`, `main`; reload on main). Fragments identical to what the host has are not
  rewritten; `web.vmail.prepare` and the re-key always run. Disable removes the three slots,
  re-renders main/data ACL without spam, removes the Dovecot include. Audit `virtual_mail.apply` + `virtual_mail.applied`;
  `service_config_applies.virtual_mail` records `live` (`ctx.web.virtualMail.lastApplied()`). Missing Exim/Dovecot:
  CapabilityError (501) when enabling, `{ applied: false, reason: 'capability_missing' }` when disabling; the switch
  is saved either way.
- **Who calls it:** never a customer request. The panel runs it as the job `panel.virtual_mail.ensure`
  (`ctx.panelEmail.ensureVirtualMail(null, { force })`, memoised with a 10-minute backoff): queued once at boot by
  `routes/panel/email.js` through `ctx.panelEmail.requestVirtualMail('boot')` after the capability snapshot exists,
  and again by the first mailbox mutation that finds the wiring not live (`requestVirtualMail('mailbox')`); the
  request queues nothing when `panel.enabled` is off, Exim or Dovecot is missing, or a queued/running job of that
  type exists. Root triggers it from Service Configuration: `GET /api/service-config/virtual-mail` (status: slots,
  hooks, `live`, `check` from `vmail.render.check`, `manualIncludes`, `submissionPorts`, `lastApply`) and
  `POST /api/service-config/virtual-mail/apply { enabled }`.
- **Driver slots the agent cannot hook** (unsplit Debian template, monolithic RHEL config): `status().exim.manualIncludes`
  / `apply().manualIncludes` list `{ slot, section, file, line, where }` with `line = ".include_if_exists <slot
  file>"`, to be added once by the operator after `begin routers|transports|authenticators` (the router before the
  local-delivery routers), then `update-exim4.conf` and reload; `.include_if_exists` rather than `.include` because
  disabling the feature unlinks the slot files (`web.exim.include.remove`) and Exim must stay valid. `web.exim.detect`'s
  `hints` say the same.
- **Exim `submissionPorts`** (`service_config.exim`, default false): `renderEximMain` adds `daemon_smtp_ports = 25 : 587`
  (STARTTLS), and `25 : 465 : 587` + `tls_on_connect_ports = 465` only once `exim.tls` (the preset from
  `applyEximTls`) exists — TLS on connect without a certificate would refuse every connection. The panel's
  `GET /email/accounts/:id/client-settings` advertises exactly that: 25/STARTTLS, 587/STARTTLS, or 465 with 587 as the
  alternative; `auth: 'password'` only while the wiring is live.
- **File formats the fragments read** (the panel's `vmail.*` ops write them; all under `<whmDir>/` must be readable
  by the Exim user, 0644): `aliases/<domain>` lsearch `local: a@b, :fail:, :blackhole:` with `*` as the default
  address; `domainfwd.lst` lsearch `domain: target-domain`; `autoresponders/<domain>/<local>` = body,
  `<local>.conf` = lsearch keys `from` (display name), `subject`, `charset`, `interval` (hours, 0 = every message),
  `start`/`stop` (epoch seconds), `enabled` (0/1); `spam_users.lst` lsearch `domain: user=<account> enabled=0|1
  threshold=<score×10> autodelete=0|1` (first recipient's domain decides; spamd must run so that `spam = <user>`
  can read `~/.spamassassin/user_prefs`). The Dovecot passwd line is the design's (§5.3 of customer-panel.md).
- **Spam availability** (`ctx.web.spamScanning({ fresh })` → `{ available, reason, detail, exim: { installed,
  contentScan, version, features, flavor }, spamd: { installed, active, unit } }`, memoised 60 s unless `fresh`):
  `spam = <user>` only exists in a content-scanning Exim (`exim -bV` lists `Content_Scanning`; Debian's
  `exim4-daemon-heavy`, while `-light` passes the capability check and ignores the condition) and needs the spamd
  unit active (`mail.spamd.config.read`; no unit on the host is unknown, not stopped). Reasons: `exim_missing`,
  `exim_no_content_scan`, `spamd_missing`, `spamd_not_running`. panel-email's `spam.get` returns it, `spam.set`
  refuses with 501 (`CapabilityError`) or 422 `spamd_not_running` after a fresh probe, and
  `ctx.panelEmail.spamStatus()` (`{ ...spamScanning, configuredAccounts }`) feeds the Security Advisor finding
  `panel.spam.scanning`. The Connect sheet (`accounts.clientSettings`) adds `smtp.ports { enabled, port465,
  port587 }`, `certificate { dovecot, exim }` from `ctx.ssl.serviceCertStatus()` (memoised 60 s), `virtualMailLive`,
  `warnings` and `passwordPolicy { context: 'email', minLength: 8, minStrength }` (also `meta.passwordPolicy` of the
  mailbox list, which now carries the wiring warning with or without rows).

## 37. Customer panel: virtual FTP users (`ctx.web.ftp.enableVirtualUsers(req)`)
Setting `service_config.ftp.virtualUsers` (default false) rendered by `web.ftp.config.write` as pure-ftpd
`PureDB /etc/pure-ftpd/pureftpd.pdb` (conf/PureDB on Debian; only ever switched **on** from here so a hand-enabled
PureDB stays) or proftpd `AuthUserFile /etc/proftpd/ftpd.passwd` + `AuthOrder mod_auth_file.c mod_auth_unix.c` in
`conf.d/whm.conf`; `ftpSettingsFrom` reads it back. The agent creates the empty passwd file (0600 root) and runs
`pure-pw mkdb` before the restart because pure-ftpd-wrapper/proftpd refuse a missing database; a daemon that does
not come back gets the previous files restored as for any other setting. Returns `{ daemon, enabled, live,
unchanged? }`, audits `ftp.virtual_users.enable`; vsftpd → `CapabilityError('ftp-virtual')` (501). The panel's
`ftp.*` ops use the same stock file locations (`FTP_VIRTUAL` in `agent/src/ops/web.js`).

## 38. Customer panel: password sync (`ctx.panel.syncPassword`)
`accounts.create` (when `input.password` and the Linux user was created) and `accounts.setPassword` call
`ctx.panel?.syncPassword(username, password)` **after** `user.set_password` succeeded, through a wrapper that
tolerates an absent panel and logs (never propagates) a sync failure: the host change is the truth, the bcrypt
copy follows. `account.created` still carries no password.

## 39. Customer panel: AutoSSL history (`ctx.ssl.autossl.lastEntryFor(domain)`)
Newest `ssl_autossl_runs` entry naming the hostname → `{ runId, trigger, provider, startedAt, finishedAt, status,
action, message }` or null (runs are pruned to 50, so the scan is bounded).

## 40. Customer panel: reseller ACL `login-as`
Key `login-as` ("Log in to Account Panels") in the Account Management group. It is in `EXPLICIT_ACLS`: an
unconfigured reseller (no privilege save yet) still gets every other privilege by ownership but not this one;
root always has it. Package features the panel gates on all exist in `DEFAULT_FEATURES` (no `zoneedit` key: the
zone editor is gated by ownership only).

## 41. Server hostname site and published applications (`ctx.web.hostname`, `ctx.web.hostApps`)
Service-configuration owns the Apache virtual host for `basic.hostname` and the drop-in directory where web
applications are published under that one name (Phase 8 P0-2; webmail = P0-1, phpMyAdmin = P0-5 are its callers).
Nothing is ever added to customer vhosts; the distro's global aliases (`conf-enabled/phpmyadmin.conf`,
`/etc/roundcube/apache.conf`) are the operator's to disable (`a2disconf`) — the panel never edits them.
- **Agent (`agent/src/ops/web.js`):**
  - `web.host.ensure { hostname (FQDN, lowercase), docroot='/var/www/keel-host', port=80, sslPort=443|null, bind?, ips=[] (≤64
    addresses), php=true, panelPort=2087, serverAdmin?, reload=true }` → `{ hostname, path, link, docroot, docrootCreated,
    indexWritten, appsDir, phpSocket, ssl, certificate: { fullchain, key, present }, changed, validated, reloaded, unit,
    warnings: [{ code, message }] }`.
    Renders `renderHostVhost()` into `sites-available/keel-host.conf` (+ `sites-enabled` link; RHEL `conf.d/keel-host.conf`).
    Both blocks open `<VirtualHost <ip>:<port> … *:<port>>` with every `ips` entry an interface holds (same `hostHasAddress`
    test as customer vhosts; behind NAT none qualifies and only the wildcard remains) — Apache serves a request from the vhosts
    bound to the connection's address and falls back to `*:port` only when none is, so without this the first IP-bound
    customer vhost would answer `https://<hostname>/` with its own certificate. `bind` replaces the whole list; the meta line
    records `ips` as bound. Contents:
    `:80` = ACME passthrough `Alias /.well-known/acme-challenge/ → /var/www/html/.well-known/acme-challenge/` (the webroot
    ssl-tls uses for the hostname) + `RedirectMatch 301` to https for everything else (only once a certificate is present);
    `:443` = `SSLCertificateFile /etc/ssl/whm/service/apache/fullchain.pem` + `key.pem` (the Manage Service SSL Certificates
    bundle; when either is missing the TLS block is left out and `warnings` carries `certificate_missing`); both blocks carry
    the www-pool PHP handler (`wwwPoolSocket()`: Debian `/run/php/php<ver>-fpm.sock`, RHEL/Remi `www.sock`, newest PHP first,
    never a tenant pool; `php_missing` warning otherwise) and `IncludeOptional <root>/keel-host.d/*.conf`. The docroot is
    created 0755 with a landing page (`renderHostIndex`) linking `https://<hostname>:<panelPort>/` and `/panel`; an existing
    `index.html` is kept. Idempotent: identical content → `changed:false`, no configtest, no reload. A file without the
    `# keel-host ` marker is never overwritten (`refused`). Every path is pinned (`/var/www`, `/etc/apache2|httpd`,
    `/etc/ssl/whm`, `/var/log/apache2|httpd`) before Apache is consulted.
  - `web.host.status {}` → `{ installed, flavor, path, link, exists, managed, enabled, hostname, meta, ssl, certificate,
    docroot, docrootExists, phpSocket, appsDir, apps }`; `web.host.remove { reload }` (destructive; drop-ins are kept).
  - `web.host.app.write { name /^[a-z][a-z0-9-]{0,31}$/, alias (URL path, no `..`), root (confPath under an allowed root —
    `/usr/share/roundcube`, `/var/lib/roundcube`, `/usr/share/phpmyadmin`, `/var/lib/phpmyadmin` plus `/etc/roundcube`,
    `/etc/phpmyadmin`, and the RHEL / tarball locations `/usr/share/roundcubemail`, `/etc/roundcubemail`,
    `/usr/share/phpMyAdmin`, `/etc/phpMyAdmin`, `/opt/phpmyadmin`, `/srv/phpmyadmin`, `/usr/share/nginx/html/roundcube`,
    `/usr/share/rainloop`, `/usr/share/snappymail` were added to `DEFAULT_ALLOWED_ROOTS`;
    every `PMA_DIRS`/`PMA_CONFIGS`/`WEBMAIL_CANDIDATES` entry except the cPanel one must stay under it — tests assert this),
    php=true, access='all'|'local'|'list', allowFrom[] (ip or
    cidr, required for `list`), options[] (signed `Indexes`/`FollowSymLinks`/`SymLinksIfOwnerMatch`/`MultiViews` or `None`;
    default `['-Indexes','+FollowSymLinks']`), directoryIndex[]?, allowOverride='None'|'All'|…, denyDirs[] (subdirectories
    answered `Require all denied`), reload=true }` → `{ name, alias (trailing slash dropped), root, path, phpSocket,
    vhostPresent, changed, validated, reloaded, unit, warnings }`. Renders `renderHostApp()` (`Alias` + `<Directory>`; `php:false`
    denies `*.php` instead of a handler) into `<root>/keel-host.d/<name>.conf`, validated with configtest and rolled back on
    error; `not_found` when `root` is not a directory; `hostname_vhost_missing` warning when the site is absent. Never raw text.
  - `web.host.app.remove { name, reload }` (destructive), `web.host.app.list {}` → `{ installed, appsDir, vhostPresent, apps[] }`.
- **Service (`ctx.web`, `server/src/services/service-configuration.js`):**
  - `ctx.web.hostname.ensure(req, { reload = true, strict = false })` → `{ hostname, url, written, changed, reloaded,
    validated, ssl, path, docroot, phpSocket, warnings }`. Non-strict (the hook form) never throws for a bare hostname
    (`written:false`, warning `hostname_not_fqdn`) or a missing Apache (`reason:'capability_missing'`); strict (the route and
    `hostApps.publish`) throws 422 / `CapabilityError('apache')`. Uses `service_config.apache_ports` (`port`, `sslPort`,
    `bind`) and `config.tlsPort`; passes `ips` = `basic.main_ip`, `basic.main_ipv6`, every distinct `accounts.ip` and every
    `ipv6_assignments.address` (validated, deduplicated, ≤64); records `service_config_applies.hostname_vhost`; audits
    `hostname_vhost.ensure` only when the file changed. `ensureVhost` re-runs it (non-strict, `reload:false`, one reload
    for both) after writing an account's vhosts whenever the site was applied before, so a newly assigned account IP never
    shadows the hostname site.
  - `ctx.web.hostname.status()` → `{ hostname, fqdn, apache, url, panelUrl, exists, enabled, managed, current, inSync, ssl,
    certificate, docroot, phpSocket, path, appsDir, apps[{ name, alias, root, php, managed, path, url, updatedAt }],
    lastApply, error }`.
  - `ctx.web.hostApps.publish({ name, alias, root, php?, access?, allowFrom?, options?, directoryIndex?, allowOverride?,
    denyDirs? }, req)` → `{ name, alias, root, url: 'https://<hostname><alias>/', path, changed, reloaded, validated,
    warnings }`: `hostname.ensure(strict, reload:false)` first, then `web.host.app.write`, then one `web.reload` when the
    site changed but the drop-in did not; audits `host_app.publish`. `ctx.web.hostApps.unpublish(name, req)` → `{ name,
    removed, reloaded, path }` (audit `host_app.unpublish`); `ctx.web.hostApps.list()` → `{ installed, hostname, appsDir,
    vhostPresent, apps[] }`. The spec is passed to the agent as given: an unknown or malformed field is `invalid_args` (422).
- **Who calls `ensure`:** `PUT /api/system/settings` when the body carries `basic.hostname` (Basic Setup; a failure is logged,
  never a failed save), `ctx.ssl.installServiceCert('apache', …)` after the bundle is written (so AutoSSL renewals, Manage
  Service SSL Certificates installs and self-signed resets keep the site current; the result carries `hostnameSite`), and
  root through `POST /api/service-config/hostname/apply { reload? }`. `GET /api/service-config/hostname` and
  `GET /api/service-config/host-apps` are `requireRoot`. Networking Setup › Change Hostname reaches it only through the
  service-cert reissue it triggers; call `ctx.web.hostname.ensure(req)` after `settings.set('basic.hostname', …)` if a
  path sets the hostname without reissuing.
- **Security Advisor:** probe `hostname.site` (finding id `hostname.site`): warning when a hostname certificate exists but no
  site answers for it, when the site is served without HTTPS, or when it still names an old hostname; info when neither
  site nor certificate exists; ok otherwise.
- **For webmail (U2) / phpMyAdmin (U3):** `publish({ name: 'webmail', alias: '/webmail', root: '/var/lib/roundcube/public_html',
  allowOverride: 'All', denyDirs: ['config','temp','logs','bin','SQL','vendor','installer','tests'] })` (never weaker than Debian's
  fragment: `AllowOverride All` keeps Roundcube's shipped `.htaccess` rules, the source/schema/vendor trees are denied outright for a
  layout that has them under the web root) and `publish({ name: 'phpmyadmin', alias: '/phpmyadmin', root: '/usr/share/phpmyadmin',
  options: ['+SymLinksIfOwnerMatch'], denyDirs: ['libraries','templates','setup'] })` (`setup/` is htpasswd-gated in Debian's
  fragment and denied here) were configtest-verified on nova; the returned
  `url` is what the panel should advertise instead of guessing `https://<hostname><alias>/`. Neither distro alias file is
  edited. phpMyAdmin (U3, `ctx.databases.phpmyadmin.publish/unpublish/status`, routes `GET|POST|DELETE
  /api/databases/phpmyadmin/publish`, root) publishes with `directoryIndex: ['index.php']` added and then disables Debian's
  global include through the agent op `db.phpmyadmin.global_conf.disable` (`a2disconf -q phpmyadmin` + `web.reload`;
  destructive; `unsupported` on RHEL where `conf.d/phpMyAdmin.conf` is a distro file) — the symlink is removed, never the
  file. `db.phpmyadmin.detect` reports `globalAlias { enabled, path, urlPath, a2disconf }`, `published` (the drop-in's spec
  marker) and `dbConfigured`; Security Advisor finding `phpmyadmin.global_alias`. Roundcube's global alias stays an
  operator step the Webmail status hints at while it is enabled.

### 41.1 Webmail addendum (`ctx.web.webmail`, P0-1)
- **Agent (`agent/src/ops/webmail.js`):**
  - `web.webmail.detect { lint = false }` → `{ installed, flavor, path (install root), root (web root: Debian
    `/var/lib/roundcube/public_html`, else the install root), version, configured, apacheAlias, published: { alias, file,
    managed, source: 'keel-host'|'distro' }|null, globalAlias: { alias, file }|null, config: { path, exists, ok, managed:
    { imapHost, smtpHost, productName }|null }|null }`. `WEBMAIL_CANDIDATES` lists `/var/lib/roundcube` (Debian, web root
    `public_html`, related `/usr/share/roundcube`) before `/usr/share/roundcube`, then RHEL's `/usr/share/roundcubemail`
    (config `/etc/roundcubemail/config.inc.php`; `config.write`/`remove` edit the detected install's config); `aliasesIn(text, roots)` matches an
    uncommented `Alias` (quoted or not) whose target resolves — symlinks followed — to any of the install's roots, and
    flags `global` for a line outside every `<VirtualHost>`. Sources, first match wins: `<apache root>/keel-host.d/*.conf`
    (`managed` when it carries the `# keel-host-app ` marker), the known distro fragments, then `conf-enabled/*.conf` +
    `sites-enabled/*.conf` (RHEL `conf.d/*.conf`), capped at 200 files / 256 KB each; `globalAlias` is a global match in a
    `conf-enabled`/`conf.d` fragment. `config.managed` is parsed from the Keel block only; `ok` is `php -n -l` of
    `config.inc.php` when `lint` is true (the only program the op ever runs). No exec otherwise.
  - `web.webmail.config.write { hostname (lowercase FQDN), imapScheme='ssl', imapPort=993, smtpScheme='tls', smtpPort=587,
    productName (1–80 chars, no control characters) }` → `{ path, changed, validated, values }`: merges
    `// BEGIN Keel (Webmail) … // END Keel (Webmail)` (`$config['imap_host']`, `$config['smtp_host']`,
    `$config['product_name']`, single-quoted with `\` and `'` escaped) at the end of `/etc/roundcube/config.inc.php` —
    in front of a trailing `?>` if there is one, replaced in place on later runs — then writes a sibling temp file, runs
    `php -n -l` on it and only then renames it over the original with the original owner and mode (`root:www-data 0640`
    on Debian), previous copy `0600` under `/var/lib/whm/backups/config/etc/roundcube/`. `not_found` when the file is
    missing (Roundcube not configured), `refused` for a symlink or a file that does not start with `<?php`,
    `capability_missing` (501) without `php`, `config_invalid` (422) when the lint fails (temp file removed, original kept).
    The only path it touches is `/etc/roundcube/config.inc.php` (+ the temp sibling and the backup); nothing else in the
    file — `des_key`, the Debian `include("/etc/roundcube/debian-db-roundcube.php")` — is parsed or rewritten.
  - `web.webmail.config.remove {}` (destructive) → `{ path, changed, validated }` strips the block the same way.
- **Service (`ctx.web.webmail`, service-configuration):**
  - `status()` → `{ installed, flavor, version, path, root, hostname, fqdn, apache, site: { exists, enabled, ssl, inSync,
    url }|null, published: { alias, file, managed, source, url }|null, url, globalAlias, config: { path, exists, ok,
    managed, expected: { imapHost, smtpHost, productName }|null, inSync }|null, lastApply, error }`; never throws for a
    missing install or Apache. `expected` is what a publish would write now (`ssl://<hostname>:993`, `tls://<hostname>:587`,
    branding `companyName` or `Keel`), so `inSync:false` means "publish again".
  - `publish(req, { reload = true })` → `{ installed, flavor, version, root, alias, url, path, changed, reloaded,
    validated, config: { path, changed, validated, values }|null, warnings }`: `CapabilityError('webmail')` (501) when
    nothing is installed, then `hostApps.publish({ name: 'webmail', alias: '/webmail', root, php: true, allowOverride: 'All',
    denyDirs: ['config','temp','logs','bin','SQL','vendor','installer','tests'], reload })` (so 501 apache / 422 non-FQDN / 422
    config_invalid come from there), then
    `web.webmail.config.write` for a Roundcube with `config.inc.php`. Records `service_config_applies.webmail`, audits
    `webmail.publish` (target = the URL) after `host_app.publish`. Idempotent: an unchanged drop-in and block are
    `changed:false`.
  - `unpublish(req)` → `{ name, removed, reloaded, path, config: { path, removed, validated }|null }`: `hostApps.unpublish
    ('webmail')` then `web.webmail.config.remove` only when a Keel block is present; audits `webmail.unpublish`.
- **Routes (`/api/service-config`, requireRoot):** `GET /webmail`, `POST /webmail/publish { reload? }`, `DELETE /webmail`.
- **Consumers:** `ctx.panelEmail.webmail(scope, query)` builds the account panel's URL from `panel.webmail_url` or
  `https://<ctx.web.hostname.hostname() ?? basic.hostname><published.alias ?? apacheAlias>/` and answers `{ …, alias,
  published }`; `ctx.panelEmail.webmailUrl()` (no scope) feeds `ctx.panel.quickLinks` → `webmailUrl`, so the home quick
  link and the Webmail page always agree. Detection stays cached 60 s in panel-email; a publish shows there within that.
  Panel › Customization › Account panel renders the status and the Publish/Unpublish actions (`WebmailPublishCard`).
- **Not done here:** SSO (P1-1); the installer never installs Roundcube; the distro `roundcube.conf` fragment is never
  disabled by the panel (its alias ships commented out on Debian, unlike phpMyAdmin's).
- **Truthful publish (P1, A3):** Apache accepting a drop-in is not the application answering (Ubuntu 26.04's Roundcube
  1.6.11 fatals on PHP 8.5 until `bootstrap.php` guards its `array_first()` polyfill). Agent `web.host.app.probe { alias,
  timeoutMs=5000 }` (`agent/src/ops/web.js`) does one GET to `https://127.0.0.1:<sslPort><alias>/` (http on `port` when the
  site has no certificate) with SNI and `Host` = the hostname from the site's meta line, `rejectUnauthorized:false`, no
  redirects, and answers `{ alias, url, hostname, port, tls, status, ok (200–399), location, error, phpFatal }`;
  `phpFatal` is the last `PHP Fatal error…` line of the last 64 KiB of `keel-host[-ssl]-error.log` when the status is
  5xx (`lastPhpFatal()`), 300 characters at most. `not_found` when `keel-host.conf` is not panel-managed. Service:
  `ctx.web.hostApps.probe(alias)` → `{ status, ok, url, error, phpFatal }` (never throws; `status:null, ok:null` when
  the probe itself failed) and `ctx.web.hostApps.warning(http, label)` → the one line an admin card shows
  (`Published but answering 500: <phpFatal | log hint>`, `… 404: the alias is not served …`, null when fine or
  unprobed). `webmail.status()` carries `http` + `warning` once the managed drop-in and the site exist;
  `webmail.publish()` probes after the reload (`http`, `warning`, `service_config_applies.webmail.ok` false and its
  `error` = the warning on a failing answer); `ctx.databases.phpmyadmin.status()` carries the same two fields.
  `WebmailPublishCard` shows the *Answers* row and the state `Published but answering <status>`.

### 41.2 Amendment: the hostname site runs on its own PHP-FPM pool (`keel-host`)
The site's PHP handler is no longer the distro www pool (`wwwPoolSocket()`, `/run/php/php8.5-fpm.sock`): that
socket disappears with the distro PHP, and a Keel source build has no www pool at all. Service-configuration now
owns one pool for the site, written in the tree of the **effective default** PHP version.
- **Agent (`agent/src/ops/web.js`):**
  - `web.host.pool.write { version, reload=true }` → `{ version, flavor, user, path, socket, others[{ version, flavor,
    path, socket }], bytes, changed, validated, reloaded, unit }`. Renders `renderHostPool(tree)` (through `renderPhpPool`
    with `name: 'keel-host'`) into `<poolDir>/keel-host.conf` of that version's `phpLayout()` tree (Debian
    `/etc/php/<ver>/fpm/pool.d`, Remi `/etc/opt/remi/php<nn>/php-fpm.d`, RHEL `/etc/php-fpm.d`, Keel build
    `/opt/keel/php/<ver>/etc/php-fpm.d`): `[keel-host]`, `user`/`group` = the tree's `listenOwner` (`www-data`, `apache`
    on RHEL), `listen = <socketDir>/php<ver>-fpm-keel-host.sock` (`/run/php`, `/run/keel-php`, `/run/php-fpm`, Remi's
    `/var/opt/remi/...`; `php-fpm-keel-host.sock` for the RHEL `system` tree), `pm = ondemand`, `max_children 10`,
    uploads/sessions/`sys_temp_dir` under `HOST_POOL.stateDir/tmp` = `/var/lib/keel-host/tmp` (0700, owned by the pool
    user; a symlink or a foreign owner there is `refused`), `error_log /var/lib/keel-host/php-error.log` (created empty
    0640, pool-owned). **Amendment 2026-11-06:** the state directory moved from `/var/lib/whm/keel-host` to its own
    allowed root `/var/lib/keel-host` (0750, pool user:group) — `/var/lib/whm` is 0750 `whmpanel:whmpanel`, so the pool
    user could not traverse it and every `session_start()` under the hostname site (phpMyAdmin, the signon script,
    Roundcube) failed `EACCES`. `ensureHostPoolState()` creates or repairs the new tree on every pool write, migrates
    nothing, and removes `HOST_POOL.legacyStateDir` (`tmp` first, then the directory) only when empty. The socket stays
    `listen.owner`/`listen.group` = the pool user with `listen.mode 0660`, which Apache (the same user) connects to. The
    signon script (`deploy/phpmyadmin/pma-signon.php`) checks the `files` handler's `session.save_path` (the `N;[mode;]/path`
    prefix stripped, PHP's temp dir when unset) is a writable directory before `session_start()` and answers a 500 page
    naming the fix instead of a warning and a redirect loop. No
    `open_basedir` (Roundcube/phpMyAdmin live under `/usr/share`, `/var/lib`, `/etc`). Tested with `php-fpm -t`
    (`--fpm-config` for a Keel build, like `web.phpfpm.pool.write`), restored on rejection (`config_invalid`), then
    that version's unit is reloaded. Idempotent (`changed:false`, no test, no reload). `capability_missing` when the
    version has no tree. `others` lists every other tree that still carries `keel-host.conf` (`hostPools()`), so the
    caller can drop them. **Amendment 2026-11-06 (review):** `ensureHostPoolState()` keeps `/var/lib/keel-host`
    root-owned (`0750 root:<pool gid>`) so the pool user cannot rename its entries; only `tmp` (0700) and
    `php-error.log` (0640, `nlink` 1) are chowned to the pool user, and every ownership/mode change goes through a
    descriptor opened `O_RDONLY | O_NOFOLLOW (| O_DIRECTORY)` + `fstat` → `fchown`/`fchmod` (a symlink is `ELOOP` →
    `refused`; no path-based chown/chmod anywhere). `phpLayout()` returns `{ versions, shadowed, installed }`: the
    distro tree of a minor a Keel build took over is moved to `shadowed` (`{ ...tree, shadowed: true }`), never
    selected for a pool, vhost or socket, but `hostPools()` lists its `keel-host.conf` flagged `shadowed: true`
    (`web.host.status.pools`; `phpSocket` comes from `hostPoolSocketOf(pools)`, the first unshadowed pool), and
    `web.host.pool.write` / `web.phpfpm.pool.write` / `web.host.pool.remove` / `web.phpfpm.pool.remove` for that
    minor also unlink the same pool file in the shadowed tree and reload the packaged unit, reporting
    `shadowedRemoved: { path, flavor, reloaded, unit }`. Service side (§52/§63): `setPhpVersion(domain, version, req,
    { reload, repool })` — `repool: true` rewrites the pool even when its `web_php_pools` row is `applied` (audit arg
    `repool`), and `php.resyncMinor` passes it through `applyPhpToDomains(job, domains, version, { repool: true })`;
    `php.packagesBlocker` also refuses ("The domains on PHP x.y still run on the distribution packages; run Update on
    PHP x.y first", field "Update PHP first") while `php.usage()[minor]` or the effective default is the minor and
    `software.php.keel_resynced[minor].version` is not the build's; the update job (after the minor resolves to
    `layout: 'keel'`, before the resync) and the `packages: true` removal job (before `pkg.php.remove`) run
    `pkg.php.default.set { version }` when the entry `isDefault` with a `packagedTwin` and `defaultBinary` is not the
    build's binary. Client: a `build: false` candidate renders *Move domains to the Keel build* with a primary button
    whatever its `severity`.
  - `web.host.pool.remove { version, reload=true }` (destructive) → `{ version, path, socket, removed, reloaded, unit }`;
    `removed:false` with `path:null` for a version with no tree.
  - `web.host.ensure` and `web.host.app.write` take an optional `phpSocket` (an absolute `*.sock` path under `/run`,
    `/var/run` or `/var/opt`) and render the handler from it. Without it the agent falls back to the newest tree's
    `keel-host` pool and only then to the distro www pool, so an old caller keeps working. `web.host.status` adds
    `pools[{ version, flavor, path, socket, units }]` and reports `phpSocket` from the site's own meta line.
- **Service (`ctx.web`):**
  - `ctx.web.hostname.ensure()` resolves the version first — Apache Configuration's pinned `defaultPhpVersion`, else
    `ctx.software.php.systemDefault().effective`, else the stored `php.default_version`, and the newest detected tree
    when the chosen one has none (the same order `resolvePhpVersion` uses for inherited domains) — writes the pool
    (`web.host.pool.write`), records
    `service_config_applies.hostname_php_pool` (`{ version, socket, path, flavor, user }`; a failed pool write is a
    failed apply and the 422/501 of the op, the site is left untouched), audits `hostname_php_pool.write` when the pool
    changed or one was removed, and passes `php: true, phpSocket` to `web.host.ensure`. **Order when the socket moves
    (amendment 2026-11-06):** the previous socket is the one of the last *successful* site apply
    (`service_config_applies.hostname_vhost.summary.phpSocket`, ignored when that apply recorded `appErrors`), so a
    failed apply forces the re-render; `web.host.ensure` is then called with `reload: false`, the drop-ins are
    re-rendered, Apache is reloaded once (`web.reload`), and only afterwards are the pools `others` names removed
    (`web.host.pool.remove`, each failure only logged) — the running Apache proxies to the old socket until that
    reload. A rejected `web.host.ensure`, a drop-in re-render error, or a move the caller asked not to reload
    (`reload:false`) keeps the stale pools (`removed: []`, removed on the next apply). The result adds `removed:
    string[]`; the pool audit carries `removed`. `pkg.php.remove` (§52 amendment): `php.hostAppsPhpVersion` reads the
    live `ctx.web.hostname.status().phpSocket` first (`/php<ver>-fpm.sock` and `/php<ver>-fpm-<pool>.sock`, so the
    keel-host socket of a distro tree or a Keel build resolves), then `ctx.web.hostApps.phpVersion()`, then the
    distribution default; `software.php.setSystemDefault` calls `resyncPhpDefault` before `queueDefaultResync` and
    answers `{ version, cli, web, host, job }` (`host` = the seam's answer, `null` without it, `{ applied:false, error }`
    when it threw; audit args add `hostApplied`, `hostSocket`, `hostError`). The agent op takes `extra?: pkgName[]`
    (≤200), the collateral confirmed at request time: with `force` a fresh simulation naming a package outside
    `requested ∪ own ∪ extra` is `refused` ("the removal would now also take …; confirm again", details `{ extra,
    confirmed, unexpected }`); the job params carry `{ version, force, extra }`. "Own" packages (never collateral):
    `php<ver>-*`, `php<ver>`, `libapache2-mod-php<ver>` and, on Debian, `php` and any `php-<ext>` whose `php<ver>-<ext>`
    is in the same transaction (a versionless `php-imagick` stays an honest extra). With no PHP-FPM installed the
    site is rendered with `php:false` and the result carries warning `php_missing`. Whenever the socket differs from the
    previously recorded one (first apply after this change, default moved) every panel-managed drop-in is re-rendered
    from its spec marker with the new socket (`reload:false` each, one `web.reload` at the end when the site itself was
    not reloaded); the result adds `phpVersion`, `apps[{ name, changed, phpSocket }]`. `hostApps.publish` passes
    `phpSocket` from the ensured site to `web.host.app.write` (not for `php:false` specs). `status()` adds `phpVersion`,
    `pools`, `phpPool` (the last pool apply).
  - `ctx.web.hostApps.phpVersion()` (synchronous) → `{ version, socket, path }` from the last successful pool apply, or
    `null` before the site was ever applied. **PHP Version Manager removal guard (`software.php.removeBlocker`):**
    refuse `pkg.php.remove` for that `version` ("the server hostname site runs on it; change the default first"), the
    way it refuses the Apache web default and pinned domains.
  - `ctx.web.hostApps.resyncPhpDefault(version, req)` → `{ hostname, applied, version, socket, changed, reloaded, apps,
    warnings, requested }` (never throws for a bare hostname or a missing Apache: `applied:false` with `reason`). **The
    seam for `PUT /api/software/php/default`:** `software.php.setSystemDefault()` calls it (tolerating absence:
    `await ctx.web?.hostApps?.resyncPhpDefault?.(version, req)`) right after `settings.set('php.default_version')`, before
    or beside `queueDefaultResync`, so changing the default moves the host apps too — including when no domain inherits
    the default and no job is queued. It is not hooked from service-configuration: `queueDefaultResync` lives in
    `software.js`.
- **Operator view:** `GET /api/service-config/hostname` shows `phpVersion`/`phpSocket`/`pools`; the pool file is
  `keel-host.conf` beside the tenant `whm-<user>.conf` pools; `pkg.php.remove` of a version other than the host one
  leaves nothing behind because `ensure` already dropped that tree's copy.

## 42. Customer panel: DNS delegation awareness (`ctx.panelDns.delegation`)
Public DNS for a hosted domain may be served elsewhere (the live host's zones are at Cloudflare while BIND answers only
locally), so a record written here is not published. `services/panel-dns.js` owns the check; nothing else resolves NS sets
for the panel.
- `ctx.panelDns.delegation(domain, { fresh = false })` → `{ domain, checkedDomain, delegatedHere: true|false|null,
  delegatedNs: string[], nameservers: [{ host, addresses, here }], checkedAt, error }`. Reads `dns.resolve` (NS, then A/AAAA
  of up to four nameservers, `timeoutMs: 3000`, `dns.resolvers` when set) for the name and, on ENODATA/ENOTFOUND, for
  each parent down to two labels (`checkedDomain` is the one that answered). A nameserver is "here" when one of its
  addresses is `basic.main_ip`/`basic.main_ipv6`, an account IP or a public interface address from `sys.info`, or when it
  carries `basic.hostname`/one of `basic.nameservers` and cannot be resolved (offline hosts). `delegatedHere:null` when
  nothing resolved (no banner anywhere: unknown is never an alarm). Memoised per name: ten minutes, one minute for null.
  `delegationOrNull(domain)` swallows errors for listings.
- **Carried on:** `GET /api/panel/dns/zones[/:domain]` and record writes (`delegation`), `GET /api/panel/domains` rows,
  `POST /api/panel/domains/{sub,addon}` (`dns.delegation` + `dns.records` / `delegation` + `records`, a `meta.warnings`
  line), `GET /api/panel/email/deliverability/:domain` (`delegation`, `records`), whose `/fix` writes nothing and answers
  `applied:false, reason:'not_delegated'` when `delegatedHere === false`.
- **Client:** `client/src/panel/DelegationBanner.jsx` (`DelegationBanner`, `DelegationBanners`, `RecordList`,
  `notDelegatedHere`, `managedAt`, `delegationText`) is the one rendering; pages pass the records to copy.

## 43. Customer panel: lockout paths (`ctx.panel.recovery`, `ctx.panel.adminReset2fa`)
Account users lose passwords and authenticators; neither recovery may widen what the console or the panel already allow.
- `ctx.panel.recovery.available()` → `panel.enabled && Boolean(ctx.contacts.sendMail)`; `GET /api/auth/reset` publishes it and
  `Login.jsx` shows *Forgot password?* only then.
- `ctx.panel.recovery.request({ username | email }, req)` (public `POST /api/auth/reset/request`, 202 always, the login
  limiter per address): matches role-`user` logins by username or by `accounts.contact_email` (case-insensitive, at most 5),
  skips suspended logins/accounts and accounts without a contact address, then **returns** — the token and the mail continue
  detached so the response time never tells a real login from an unknown one (`recovery.pending()` settles once that work
  and its audit row are done). Detached: three links per login per hour, insert `password_reset_tokens` (sha256 only,
  `expires_at` now + `RESET_TOKEN_TTL_MS` = 30 min, `requested_ip`), send through `ctx.contacts.sendMail({ to:
  contact_email, subject, body })` with `https://<basic.hostname>:<tlsPort>/login/reset/<token>` (http + `port` without TLS),
  and only after a delivered send void the login's earlier unused tokens; a failed send deletes the row just inserted (the
  earlier link keeps working, the attempt does not count toward the hourly limit). Audit `auth.reset.request` (`via`,
  `sent`, `reason`, `users`); the token never reaches a log.
- `ctx.panel.recovery.confirm({ token, password }, req)` (public `POST /api/auth/reset/confirm`): unknown, spent or
  expired → `400 reset_token_invalid`; panel off → `403 panel_disabled`; the row is burned (`used_at`, one `UPDATE … WHERE
  used_at IS NULL`) before the write, then `changePasswordForUser(userId, { newPassword, recovery: true })` — the §2.2 flow
  (host first, both stores, `password_synced_at`, sessions destroyed) with the demo/suspended gates kept and the
  `passwordchange` feature and `require_2fa_for_users` gates skipped. Audit `auth.reset.confirm`.
- `recovery`/`force` on `changePassword` never come from a request body (strict schemas on `/api/auth/password` and
  `/api/panel/security/password`).
- `ctx.panel.adminReset2fa(username, user, req)` (`POST /api/panel/admin/accounts/:username/2fa/reset`, `requireReseller` +
  `ctx.accounts.get` ownership, the bar of the admin password set): clears `totp_secret_enc`/`totp_enabled` on the linked
  role-`user` row only, destroys its sessions, audits `panel.admin.2fa.reset` (`userId`, `wasEnabled`); answers
  `{ username, totpEnabled:false, wasEnabled, enrollmentRequired }`. 404 when the account has no login row.
- Migration `034_panel-recovery.sql` (`password_reset_tokens`); rows older than a day past expiry are purged on the next request.

## 44. Customer panel: single sign-on into published applications (`ctx.panelSso`, webmail first)
A browser hand-off from the panel into an application published under the hostname site (Roundcube now, phpMyAdmin
in P1-2): the panel mints a short-lived single-use token, the application's signon code exchanges it **over loopback
only** for a credential that kind's handler produces. The master credential never leaves the server any other way.
- **Table (`034b_panel-sso.sql`):** `panel_sso_tokens (id, user_id → users, account TEXT, kind 'webmail'|'phpmyadmin',
  token_hash sha256 UNIQUE, payload_enc (lib/crypto.js, JSON), expires_at, used_at, created_at)`; generic across kinds.
  Rows older than a day past expiry are purged on the next issue.
- **Service (`services/panel-sso.js`, created by `routes/categories/panel.js` before the sub-routers load):**
  - `ctx.panelSso.issue({ kind, userId, account, payload, ttlMs = 60_000 })` → `{ token, expiresAt }`; `token` is
    `crypto.randomToken(32)` (43 base64url chars, matches `SSO_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/`).
  - `ctx.panelSso.redeem(kind, token)` → `{ id, userId, account, kind, payload }` exactly once: unknown, spent, expired or
    wrong-kind → `404 sso_token_invalid`; the burn is one `UPDATE … SET used_at WHERE id = ? AND used_at IS NULL` whose
    `changes === 1` is the single-use guarantee.
  - `ctx.panelSso.register(kind, handler)` — `handler(claim, req)` builds the exchange answer; **phpMyAdmin registers
    `'phpmyadmin'` the same way** (P1-2) and gets the route, loopback check, burn and audit for free.
  - `ctx.panelSso.exchange(kind, token, req)` — `isLoopbackRequest(req)` (socket peer **and** `req.ip` loopback, and no
    `X-Forwarded-For`/`Forwarded`/`X-Real-IP` header: `trust proxy = loopback` would otherwise honour a forwarded address
    from the loopback peer) else `403 loopback_only` without burning the token; `403 panel_disabled` with the panel off;
    then redeem → handler → audit `panel.sso.exchange` (target = account, `kind`, `tokenId`, `userId`, `subject`).
- **Route:** `GET /api/panel/sso/:kind/:token` is a **public mount** (`{ path: '/panel/sso', public: true }`, served before
  `requireAuth`; `kind` ∈ `SSO_KINDS`, token validated by the regex → 422 otherwise) — the signon code has no session.
- **Webmail kind (P1-1):**
  - Dovecot master user `keel-master` (`WEBMAIL_SSO` in service-configuration: `masterUser`, `masterFile
    /etc/dovecot/whm/master-users`, separator `*`, plugin `keel_sso`, settings `panel.webmail.sso`,
    `panel.webmail.master_enc`, `panel.login_as_webmail`). `renderDovecotVirtualAuth({ …, masterFile })` adds
    `auth_master_user_separator = *` and a `master = yes` passwd-file passdb (`passdb master-users { driver = passwd-file;
    master = yes; passwd_file_path = <masterFile>; result_success = continue }` on 2.4, `passdb { driver = passwd-file;
    args = <masterFile>; master = yes; result_success = continue }` on 2.3) **before** the virtual passdb, only while
    `panel.webmail.sso` is on and a master credential exists (`virtualMail.renderDovecot` reads the settings, so the boot
    job and every apply render it). `result_success = continue` keeps the mailbox lookup (existence, `disabled`) in force.
  - Agent `vmail.master.write { user /^[a-z][a-z0-9_-]{0,31}$/, hash (crypt) }` → `{ user, path, changed }`: whole file
    `# managed\n<user>:{SHA512-CRYPT}<hash>\n`, atomic 0640 root:dovecot; `vmail.master.remove {}` (destructive).
  - `ctx.web.webmail.sso.set({ enabled?, loginAs? }, req)` (`PUT /api/panel/admin/webmail/sso`, requireRoot): on enable,
    `capabilities.require('dovecot')`, the password is `crypto.randomPassword(32)` generated **once** (kept across
    off/on), `vmail.hash` → `vmail.master.write` (host first) → `panel.webmail.master_enc` (`crypto.encrypt`) →
    `panel.webmail.sso = true`; then, when `service_config.virtual_mail.enabled` and both daemons exist,
    `virtualMail.apply({ enabled: true })` re-renders the include (reload), and for a published Roundcube
    `writeWebmailConfig` (plugin install + block). Disable: setting off, `vmail.master.remove`, the same re-render and
    block rewrite without the plugin (the plugin directory stays). Audit `webmail.sso.set`; `service_config_applies
    .webmail_sso`. `sso.status()` / `GET /api/panel/admin/webmail/sso` and `ctx.web.webmail.status().sso` →
    `{ enabled, loginAs, masterUser, masterFile, masterConfigured, plugin: { name, installed, loaded }, dovecot:
    { rendered, path }|null, lastApply }`. `sso.credentials()` → `{ user, password, host: 'ssl://<hostname>:993' }`
    (409 unless on) — called by the exchange handler only.
  - `ctx.panelEmail.webmail(scope)` adds `sso: true` only for the panel-published Roundcube (never for
    `panel.webmail_url`); `ctx.panelEmail.webmailSso(scope, { mailbox }, req)` (`POST /api/panel/email/webmail/sso`,
    session only → `403 session_required` for API tokens; feature `emailaccts`; the mailbox must be the account's and not
    suspended → 404/409; `409` while SSO is unavailable; `403 not_while_impersonating` while acting unless
    `panel.login_as_webmail`) → `{ url: '<webmail url>?_keel=<token>', mailbox, expiresAt }`, audit
    `panel.email.webmail.sso` (`mailbox`, `expiresAt`, `actingAs`/`by`). The registered handler answers
    `{ user: '<mailbox>*keel-master', password, host, mailbox }` (the plugin takes the master user from the part after
    `*`, or from an optional `masterUser` field). `clientSettings` carries `webmail` (the same URL) and `webmailSso`.
  - Roundcube plugin `deploy/roundcube/keel_sso/` (`keel_sso.php` + `composer.json`; `install.sh` rsyncs `deploy/` into
    the app dir, so it lives at `/opt/whm/deploy/roundcube/keel_sso`): hook `startup` on every task; with `?_keel=` it
    GETs `<keel_sso_endpoint><token>` (the Keel block's `$config['keel_sso_endpoint']`, rendered from the panel's own
    listener by `lib/sso-endpoint.js` `ssoEndpoint(config, 'webmail')` — `https://127.0.0.1:<tlsPort>/api/panel/sso/webmail/`
    with TLS, `http://127.0.0.1:<port>/…` without; default `https://127.0.0.1:2087/…` when absent; peer verification is
    skipped **only** when the endpoint host is loopback). **One Roundcube user record per mailbox:** the plugin splits the
    answer's `user` at `*` (or takes `masterUser` when present), sets `imap_auth_type = smtp_auth_type = 'PLAIN'`,
    `imap_auth_cid = smtp_auth_cid = <master>`, `imap_auth_pw = smtp_auth_pw = <master password>` and calls
    `$rcmail->login(<mailbox>, <master password>, $host)` — SASL PLAIN with the mailbox as authorization identity and the
    master user as authentication identity (Dovecot master passdb; Exim's dovecot authenticators pass it through for
    SMTP), so password logins and single sign-on share the `users` row, identities, contacts and settings. The master
    user is kept in `$_SESSION['keel_sso']`, the master password is the encrypted session password, and the six settings
    are re-applied on every request of that session. With a session already open: the token is still exchanged (burned);
    the same mailbox → redirect to `_task=mail` with the token stripped; another mailbox → `kill_session()` and the new
    login; a failed exchange leaves the open mailbox with a notice. Without a session any failure → login form with a
    notice. `auth_master_user_separator = *` stays in the Dovecot fragment (the `<mailbox>*<master>` form remains valid
    for `doveadm auth test`).
  - Agent `web.webmail.plugin.install { source }` (`source` must match `<deploy>/roundcube/<name>` under an allowed root —
    `/opt/whm/deploy/roundcube` added to `DEFAULT_ALLOWED_ROOTS` — and contain `<name>.php`): copies the top-level
    `.php/.json/.js/.css/.txt/.md` files into `<install>/plugins/<name>` as root:root 0755/0644 with a `.keel_plugin`
    marker; refuses a symlinked plugins dir or a destination Keel did not create. `web.webmail.plugin.remove { name }`
    (destructive, marker required). `web.webmail.detect` gains `plugins: { dir, keel: [names] }|null`;
    `web.webmail.config.write` gains `plugins: [names]` → `$config['plugins'][] = '<name>';` lines inside the Keel block
    (after the distro's `$config['plugins'] = [...]`) and `ssoEndpoint?` (pinned by `SSO_ENDPOINT_RE`
    `^https?://127\.0\.0\.1:\d{1,5}/api/panel/sso/webmail/$`) → `$config['keel_sso_endpoint'] = '…';`;
    `readConfigBlock()` returns `plugins` and `ssoEndpoint` (`null` when absent), `status().config.inSync` compares both
    (`writeWebmailConfig` passes the endpoint only when the plugin is on).
- **Client:** `pages/panel/email/webmail.jsx` `WebmailOpenButton` / `openWebmailSso` (POST, then the window opened on
  the click navigates; plain `?_user=` link when `sso` is false or the mailbox is suspended), reused by the mailbox
  connection sheet; Panel › Customization › Webmail card `WebmailSsoSettings` (toggle + "allow while logged in as").

- **phpMyAdmin kind (P1-2, `ctx.databases.phpmyadmin.sso` + `ctx.panelDatabases.phpMyAdminSso`):**
  - Credential: a hidden per-account MySQL user `<account>_pma` (`signonUserFor()`, `PHPMYADMIN_SSO` in
    database-services) at `localhost` only, holding one `GRANT ALL PRIVILEGES ON \`<db>\`.*` (agent `db.grant`) per row
    of `databases` the account owns at sign-on time — **never a prefix pattern**: usernames may contain `_`, so
    `bob\_%` would also match every database of an account `bob_shop` (the `db.grant.wildcard` op was removed). Every
    sign-on drops and recreates the user (`db.user.drop` when `db.users.list` shows it, then `db.user.create` with a
    fresh `crypto.randomPassword(32)`), so it holds exactly the grants issued then; a database created afterwards is
    covered by the next sign-on (tokens live 60 s). `signon()` answers `409 sso_unavailable` before any op when
    `<account>_pma` exceeds the engine's user-name limit (`SIGNON_NAME_MAX`: MySQL 32, MariaDB 80). The audit
    `db.phpmyadmin.signon` lists the `databases` granted. The row is kept in `db_users` (so terminate's `removeAccountData` drops it) but it is **hidden**: not in
    `forAccount().users` (panel lists, backups), `listUsers` marks it `hidden: true` and drops it unless `?system=true`,
    the user functions (drop / password / grants) answer `400` for it, the panel's `ownedUser` says 404, and the
    `pma` name is reserved for the account (`400`). No migration: the suffix convention derives it.
  - Switch `panel.phpmyadmin.sso` (`GET|PUT /api/databases/phpmyadmin/sso { enabled }`, requireRoot; audit
    `phpmyadmin.sso.set`): on (MySQL/MariaDB profile, phpMyAdmin installed **and published by the panel** else 409),
    host first — `ctx.web.hostApps.publish({ name: 'keel-signon', alias: '/keel', root: <deploy>/phpmyadmin, php: true,
    options: ['-Indexes', '-FollowSymLinks'], directoryIndex: ['pma-signon.php'] })` then agent
    `db.phpmyadmin.signon.write { signonUrl: '/keel/pma-signon.php', logoutUrl: '/phpmyadmin/', sessionName:
    'KeelPmaSignon', endpoint: ssoEndpoint(config, 'phpmyadmin') }` (`endpoint` pinned by `PMA_SSO_ENDPOINT_RE`
    `^https?://127\.0\.0\.1:\d{1,5}/api/panel/sso/phpmyadmin/$`; renders `/etc/phpmyadmin/conf.d/keel-signon.php`:
    `defined('KEEL_SSO_ENDPOINT') || define('KEEL_SSO_ENDPOINT', '…');` first, then server 2 = a copy of server 1 with cookie
    auth, server 1 → `auth_type = 'signon'`, `SignonSession`, `SignonURL`, `LogoutURL`, `ServerDefault = 1`; `php -l`
    on a temp copy before the atomic write; refuses to overwrite a file without the Keel marker; `db.phpmyadmin.signon.remove`
    is destructive, marker required; `db.phpmyadmin.detect` gains `signon: { path, exists, managed, confDir }`) — then
    the setting. Off: setting, then drop-in and script removed; the hidden users stay. `phpmyadmin.publish()` re-applies
    both while the switch is on (`result.sso`, warning `sso_not_applied`), `unpublish()` removes them and keeps the switch.
    `/opt/whm/deploy/phpmyadmin` is in `DEFAULT_ALLOWED_ROOTS` (read root of the published app).
  - `ctx.databases.phpMyAdmin(user).sso` is true only for the panel's own publication (never the URL override), with the
    drop-in in place and the feature on; `ctx.panelDatabases.phpMyAdmin(scope)` carries it as `sso`.
  - `POST /api/panel/databases/phpmyadmin/sso {}` (session only → `403 session_required`; feature `phpmyadmin` +
    `mysql`; `409 sso_unavailable` while off) → `signon(username)` rotates the user, `panelSso.issue({ kind:
    'phpmyadmin', payload: { user, password, host: 'localhost' } })` → `{ url: 'https://<hostname>/keel/pma-signon.php?_keel=
    <token>', user, expiresAt }`, audit `panel.db.phpmyadmin.sso` (`user`, `expiresAt`; never the password) plus
    `db.phpmyadmin.signon`. The registered handler answers the decrypted payload once (`404 sso_token_invalid` without
    one, `409 sso_unavailable` once the switch is off), audited as `panel.sso.exchange` with `subject = user`.
  - Script `deploy/phpmyadmin/pma-signon.php` (served as `/keel/pma-signon.php` by the hostname site's PHP-FPM www pool):
    with `?_keel=` it GETs `<endpoint><token>` — the `KEEL_SSO_ENDPOINT` constant of the agent-written drop-in
    (`/etc/phpmyadmin/conf.d/keel-signon.php`, included in a scope of its own; it is the one file phpMyAdmin and the
    script both read), else a `KEEL_SSO_ENDPOINT` request variable / environment entry, else
    `https://127.0.0.1:2087/api/panel/sso/phpmyadmin/`; peer verification skipped only for a loopback host), starts the
    `KeelPmaSignon` session (cookie path `/`, `HttpOnly`,
    `Secure` on HTTPS, `SameSite=Lax`, id regenerated, session emptied), stores `PMA_single_signon_user|password|host`
    and redirects to `/phpmyadmin/index.php?server=1`. Without a token (phpMyAdmin's logout and failed-signon landing)
    it shows phpMyAdmin's `PMA_single_signon_error_message` if any and links the cookie login `/phpmyadmin/index.php?server=2`.
    The token never appears in the page or a log.
  - Client: `pages/panel/databases/phpmyadmin.jsx` `PhpMyAdminOpenButton` / `openPhpMyAdminSso` (window-open-first,
    plain link when `sso` is false); Panel › Customization › Account panel `PhpMyAdminSsoCard` (toggle, requires the
    publication first).
  - **Administration shell (`ctx.databases.phpmyadmin.sso.open({ account? }, user, req)`, `POST
    /api/databases/phpmyadmin/open`, requireReseller + session only → `403 session_required` for API tokens, body
    `{ account?: username }` strict):** `409` before any op when phpMyAdmin is not published or `phpMyAdmin(user).sso`
    is false (the message names the `panel.phpmyadmin.sso` switch). Without `account`: root only (`403` otherwise) →
    `sso.signonAdmin(user, req)` — the hidden user `PHPMYADMIN_SSO.adminUser = 'keel_pma_admin'` at `localhost`,
    dropped when `db.users.list` shows it and created again with a fresh `crypto.randomPassword(32)`, then agent
    **`db.grant.global { user, hosts }`** (`GRANT ALL PRIVILEGES ON *.* TO user@host WITH GRANT OPTION; FLUSH
    PRIVILEGES`; on errno 1044/1045/1227 — the connecting root cannot pass the option on — retried without `WITH GRANT
    OPTION` and answered `grantOption: false`; `root` refused); never mapped in `db_users`, hidden through
    `SYSTEM_USERS` (listed only with `?system=true`, `400` from the user functions); audit `db.phpmyadmin.signon.admin`
    (`actor`, `created`, `hosts`, `grantOption`). With `account`: `ctx.accounts.get(account, user)` (404 / 403 for a
    reseller's foreign account) then **the same `sso.signon(account, req)` the panel uses** — `<account>_pma` with
    grants on that account's databases only — audit `db.phpmyadmin.signon.as` (`account`, `user`, `actor`,
    `expiresAt`). Both mint `panelSso.issue({ kind: 'phpmyadmin', userId: user.id, account: account ?? 'keel_pma_admin',
    payload: { user, password, host } })` and answer `{ url: '<signonUrl>?_keel=<token>', user, account|null,
    expiresAt, grantOption|null }` through the same `signonUrl` helper; the registered handler and the single-use burn
    are unchanged. Client: `pages/fn/database-services/phpmyadmin.jsx` `openPhpMyAdminAs({ account? })`
    (window-open-first), **Open phpMyAdmin (all databases)** (root, `sso` on) + *Open as an account* card
    (`AccountPicker`), and the **phpMyAdmin** row action on List Accounts (`pages/accounts/AccountsTable.jsx`).
    The popup is opened **without the `noopener` feature** (the HTML spec makes `window.open` return `null` with it)
    and `w.opener = null` severs it by hand, so the shell only falls back to `location.assign` when the popup was blocked.
  - **`keel_pma_admin` lifetime:** the user holds `ALL PRIVILEGES ON *.*`, so it never outlives a phpMyAdmin login.
    `signonAdmin` arms a drop after `PHPMYADMIN_SSO.adminTtlMs` (1440 s, phpMyAdmin's default `LoginCookieValidity`;
    `ctx.config.phpmyadminAdminTtlMs` overrides it in tests), re-armed at every sign-on; `sso.set({ enabled: false })`
    and `phpmyadmin.unpublish` drop it through `removeSignon` (reported as `applied.adminUser` / `sso.adminUser`
    `{ user, dropped, reason, error? }`); the category's `register(ctx)` drops a leftover at start-up
    (`sso.dropAdmin(null, { reason: 'startup' })`, best-effort, never fatal); audit `db.phpmyadmin.signon.admin.drop`
    (`reason`: `expired` | `sso_off` | `unpublish` | `startup` | `manual`, no principal when no request). Root may also
    drop it by hand through `DELETE /api/databases/users/keel_pma_admin` (`dropUser` exempts it from `SYSTEM_USERS`;
    password and grants stay `400`). `sso.adminDropArmed()` tells whether a drop is pending.

## 45. Customer panel: Sieve mail filters (`ctx.panelEmail.filters`, `vmail.sieve.*`)
Structured rules in the panel's own table, Sieve rendered by the panel, compiled and installed by the agent as the account.
- **Dovecot side (service-configuration owns it):** `renderDovecotVirtualAuth({ …, sieve })` loads the `sieve` plugin for
  `protocol lmtp` only and emits `renderDovecotSieve(v24)` **only when `sieve` is true** — `virtualMail.renderDovecot`
  passes `capabilities.has('sieve')` (sievec present ⇒ Pigeonhole installed); without it the fragment carries no `sieve`
  token at all, because Dovecot loads plugins at delivery time, not in `doveconf -n`, and an unconditional line would
  fail every LMTP delivery on a host without dovecot-sieve (re-apply the wiring after installing the package): 2.4 `sieve_script personal { type = personal; path = ~/mail/%{user | domain}/
  %{user | username}/sieve; active_path = ~/mail/%{user | domain}/.%{user | username}.sieve }` + `sieve_script keel_account { type = before; path =
  ~/mail/sieve-global/keel.sieve }`; 2.3 `plugin { sieve = file:~/mail/%d/%n/sieve;active=~/mail/%d/.%n.sieve;
  sieve_before = ~/mail/sieve-global/keel.sieve }`. `SIEVE_PATHS` names the pieces; `agent/src/ops/vmail.js`
  `sievePaths(home, scope, mailbox)` builds the same paths (`agent/test/vmail-sieve.test.js` keeps them in step).
  A missing script is skipped by Pigeonhole, so mailboxes without rules cost nothing. ManageSieve stays off. The active link
  sits beside the maildir, never inside it: Maildir++ takes every dot entry of the maildir root for a folder, and a symlink
  there failed LMTP with "Not a directory" on nova (Dovecot 2.4.2); `panel.email.account.delete` with `removeMail` drops it.
- **Agent ops** (`vmail.sieve.write { username, scope: 'mailbox'|'account', mailbox?, script }`, `vmail.sieve.test` same
  args, `vmail.sieve.remove { username, scope, mailbox? }`, destructive): the home comes from `/etc/passwd`
  (`assertManaged`), paths are pinned with `accountPath` (lexical + symlink containment under `/home`), a mailbox must have
  a real maildir, and every command runs under the account uid (`as-user.js`: `mkdir -p -m 0700`, `dd` from stdin,
  `chmod 0600`, `sievec <stage> <stage>.svbin`, `mv -f -T`, `ln -s -T` + `mv -T` for the active symlink). The live
  script and the active symlink change only after a clean compile; a failed compile is `invalid_sieve` (→ 422) with
  `details.errors[{ line, message }]` and the staged pair is removed. `sievec` missing → `capability_missing` (501,
  capability `sieve` registered by `routes/panel/email.js` with binaries `['sievec']`). `vmail.sieve.test` runs
  `sievec -d` on the staged copy and answers `{ ok, errors, warnings }`.
- **Panel service** (`ctx.panelEmail.filters.list/create/update/remove/reorder/test`, routes `GET|POST
  /api/panel/email/filters?mailbox=<id>`, `PUT|DELETE …/filters/:id`, `POST …/filters/reorder|test`, and
  `/api/panel/email/global-filters…` for the account scope; feature `emailfilters`): the mailbox id is matched against the
  pinned account (`loadMailbox`, 404 otherwise), a row reached by id must belong to the route's scope family. Host first:
  the whole script of the scope is rendered from the rows as they would be after the change (`renderSieve`, enabled rows
  in `position` order, `require` only for the extensions used) and written; the rows change afterwards. An emptied scope
  calls `vmail.sieve.remove`. Grammar (`normalizeRules`): 1–10 conditions (`from|to|subject|body|any_header|custom`+`name`,
  `contains|is|matches|not_contains`, single-line values ≤ 998 chars, escaped as `\\` and `\"` inside quoted strings),
  1–5 actions (`fileinto :create` with a folder name free of quotes, slashes and leading/trailing/doubled dots; `redirect`
  to a plain address, ≤ 4 per rule; `discard`; `stop`). Audit `panel.email.filter.*`. Table `panel_mail_filters`
  (migration `034c`, `mailbox_id` cascades from `mail_accounts`; `001`'s `mail_filters` is the admin Email ACL table,
  unrelated). Setting `panel.mail.max_filters_per_scope` (100).

## 47. Customer panel: the `.htaccess` family (`ctx.panelHtaccess`, agent `files.htaccess.*` / `files.htpasswd.*` / `files.errorpages.*`)
Directory privacy, Indexes, the IP blocker and Error pages share one panel-managed block per directory; nothing is stored in SQLite.
- **Agent** (`agent/src/ops/htaccess.js`, every command as the account through `as-user.js`):
  `files.htaccess.get { username, path }` → `{ path, rel, exists, managed, spec, foreign, size }`;
  `files.htaccess.set { username, path, block: spec | null, probe?: { url, ip = 127.0.0.1 } }` renders the block from the
  structured spec (`denyIps: [ip|cidr] ≤ 500`, `errorDocuments: { 400|401|403|404|500|503: '/errors/<name>.html' }`,
  `indexes: inherit|off|on`, `auth: { realm, userFile } | null`) between `# BEGIN Keel` / `# END Keel`, validates every
  rendered line against the closed grammar (`validateBlock`), merges it into `<path>/.htaccess` keeping everything outside the
  markers byte for byte (`mergeBlock`; `null` removes the block and the file when nothing else is in it), refuses a symlinked
  or > 1 MiB file and a `BEGIN` without `END` (`config_invalid`), pins `path` under `<home>/public_html` (`path_not_allowed`)
  and `auth.userFile` to `<home>/.keel/htpasswd/<16 hex>`; with `probe` it GETs the URL against `ip` (Host header, SNI,
  certificates unverified, 5 s, no redirects) and on a `500` restores the previous content before throwing `config_invalid`
  `{ probe }`. `files.htaccess.probe { username, url, ip }` → `{ status | null, location, error }`.
  `files.htpasswd.set { username, id, entries: [{ user, hash: bcrypt }], group? }` writes `<home>/.keel/htpasswd/<id>` (`.keel`
  and `.keel/htpasswd` `0711`; the file `0640` handed to `group` by root on an `O_NOFOLLOW` descriptor of a regular file the
  account owns, `0644` without a group); `files.htpasswd.get` parses it back (`ignored` counts non-bcrypt lines).
  `files.errorpages.write { username, docroot, code, title, message }` renders the text-only template into
  `<docroot>/errors/<code>.html`; `files.errorpages.list { username, docroot }` reports every code (`managed` only for pages
  carrying the `<!-- keel-errorpage {…} -->` comment). None of these ops is destructive; `stagedWrite` is exported from
  `files.js` for them.
- **Service** `ctx.panelHtaccess` (`services/panel-htaccess.js`, created by whichever of `routes/panel/{advanced,files,security}.js`
  loads first): `resolveDir(scope, rel)` pins a client path under the home and under the deepest document root of
  `ctx.panelDomains.allDomains(scope)` (main/addon/sub; `422` otherwise) and derives the probe URL
  (`https` when `ctx.ssl.certForDomain(domain).state === 'installed'`); every write is read → patch spec → `files.htaccess.set`
  with the probe (`config_invalid` surfaces as `422`). `ipBlocker.get/add/remove` (feature `ipblocker`, always
  `public_html`), `indexes.get/set` (`indexmanager`), `privacy.get/set/addUser/removeUser` (`dirprivacy`; hashes from
  `ctx.crypto.hashPassword` rewritten to `$2y$`, `htpasswdId(rel)` = sha256 prefix, the password file is created before the
  block names it, group from `web.detect().apache.runUser`), `errorPages.list/set/remove` (`errpgs`). Audit
  `panel.ipblocker.*`, `panel.indexes.set`, `panel.dirprivacy.*`, `panel.errorpages.*`.
- **Routes:** `GET|POST|DELETE /api/panel/security/ip-blocker` (mutations session-only), `GET /files/htaccess`,
  `POST /files/htaccess/probe`, `GET|PUT /files/indexes`, `GET|PUT /files/privacy`, `POST|DELETE /files/privacy/users`
  (ahead of the `filemanager` gate; token scope `panel:files`), `GET /advanced/error-pages`, `PUT|DELETE
  /advanced/error-pages/:code` (no token scope). Features `ipblocker` and `dirprivacy` are new in `DEFAULT_FEATURES`;
  `indexmanager` and `errpgs` already existed (a feature list without the new keys means enabled).
- **Host:** `mod_authz_core`, `mod_authz_host`, `mod_auth_basic`, `mod_authn_file` (Debian default set) and
  `AllowOverride All` on the document root (the vhost template already grants it). Not changed by this unit: `renderVhost`.

## 46. Per-domain mail routing in the account panel and the Exim outbound relay / IPv6 settings (P1-4, A3)
- **Routing (`ctx.panelEmail.routing`, `server/src/services/panel-email.js`):** `list(scope)` → `{ data: [row…], meta: {
  hostname, values: ['auto','local','remote'] } }`, `get(scope, domain)` → row, `set(scope, domain, { routing }, req)` → row +
  `{ applied, reason, hint }`. A row is `{ domain, type, routing ('auto' unless a mail_domains row of this account says
  otherwise), effective ('remote' | 'local'), mailboxes, canRemote (= mailboxes === 0), mx, delegation, hints }`. Routes
  (`routes/panel/email.js`, `panelScope`): `GET /api/panel/email/routing`, `GET|PUT /api/panel/email/domains/:domain/routing
  { routing: 'auto'|'local'|'remote' }` (strict). Rules: the domain must be the account's (§3.2: 404, never 403); `remote` with
  mailboxes → `409 mailboxes_exist`; `set` runs `ensureMailDomain` (§35: claims the row, never re-points another account's), then
  `ctx.mail.setRouting(domain, routing, req)` (§ Email) — a `routing_not_applied` from there becomes `applied:false` with its
  `reason`/`hint`, every other error propagates; audit `panel.email.routing.set`. The first mailbox still turns an *auto*
  domain into *local*, but a domain explicitly routed `remote` is refused (`409 routing_remote`, checked right after
  `ensureMailDomain`, before any host write) instead of being flipped back.
- **MX seam (`ctx.mail.mxStatus(domain)`, `server/src/services/email.js`):** `{ ok, error, records: [{ exchange, priority }]
  (sorted), exchanges, pointsHere }` using the category's resolver (`deliverability.useResolver` in tests) and
  `serverAddresses()`; `pointsHere` is null without resolvable exchangers. No port-25 banner probe, no audit, no `exim -bt`
  (the admin `troubleshoot` keeps those).
- **Page:** `client/src/pages/panel/email/routing.jsx` (nav `Email › Email routing`, slug `routing`, no feature gate):
  one row per domain, `ROUTING_OPTIONS` with *remote* disabled while `canRemote` is false, `mxSummary(mx, hostname)` for the
  MX column, `PendingPill` on `applied:false`, the `DelegationBanner` (§42) with `mxRecords(row)` = `MX 10 <hostname>` for a
  locally delivered domain whose MX does not point here.
- **Exim settings (`service_config.exim`, service-configuration):** `ipv6: 'auto'|'on'|'off'` (default `auto`) and
  `smarthost: null | { host, port (587), requireTls (true), auth: null | { user, passwordEnc } }`. The route schema takes
  `smarthost.auth.password` (plain, optional on a re-save: the stored `passwordEnc` is kept for the same `user`; a new login
  without a password → 422) and tolerates the echoed `passwordSet`; `publicEximSettings(s)` is what leaves the service
  (`auth: { user, passwordSet }`), so `GET /api/service-config/exim` / the `PUT` answer never carry the secret and the audit
  row is redacted by key. `renderEximMain(s, layout, support, vm, host)` renders `disable_ipv6 = true` when
  `eximIpv6Disabled(s, host)` (`off`, or `auto` with `host.ipv6Global === false` from `hostHasGlobalIpv6(sys.info)`: a
  non-loopback, non-fe80::/10, non-fc00::/7 IPv6 address on any interface; null = unknown = not rendered) and, on Debian with
  a relay, the `.ifndef`-guarded `REMOTE_SMTP_SMARTHOST_HOSTS_REQUIRE_TLS = *` when `requireTls`. `exim.get()` adds
  `ipv6: { setting, hostGlobal, disabled }` and `smarthost` (= `exim.smarthostStatus()`: the saved setting next to
  `mail.smarthost.status`). `exim.apply()` runs `mail.smarthost.write` (reload deferred to the main-slot write) before the
  slots when `next.smarthost` is set, `mail.smarthost.remove` when the previous settings had one and the next do not, and
  reports `smarthost: { …, applied: hooked && precedes !== false, hints }`; a written-but-not-loaded router makes the
  apply not ok (`live:false`) and its hint joins `hints`. `exim.outboundProbe({ fresh })` → `{ installed, smarthost: { host,
  port }|null, port25: { host, port, ok, error, ms }|null }` through `mail.outbound.probe` against
  `gmail-smtp-in.l.google.com` then `alt1.…` (first success wins, memoised 10 min); Security Advisor probe `mail.outbound`
  adds `mail.outbound.port25` (ok with a relay or a reachable MX, info "Outbound port 25 appears to be blocked" otherwise).
- **Agent (`agent/src/ops/mail.js`):** `mail.outbound.probe { host (hostname|IP), port=25, timeoutMs≤5000 }` → `{ host, port,
  ok, error, ms }` (`tcpProbe`: connect only, nothing sent). `mail.smarthost.status {}` → `{ configured, host, port, auth,
  routerFile, passwdFile, transportFile, authFile, hookable, hooked, precedes, hints }`. `mail.smarthost.write { host, port=587,
  user?, password? (both or neither), requireTls=true, reload=true }` → `{ …, hookable, validated, hooked, precedes, hints,
  reloaded, unit }`: `smarthostLayout(layout)` puts the `whm_smarthost` router (`renderSmarthostRouter`: `manualroute`,
  `domains = ! +local_domains : ! +relay_to_domains` on Debian / `! +local_domains` elsewhere, `route_list = * host::port
  byname`, `host_find_failed = defer`, `no_more`) in `conf.d/router/150_whm_smarthost` (split Debian, live by itself),
  `<whm>/router_whm_smarthost.conf` (unsplit Debian / RHEL: one manual `.include_if_exists` directly after `begin routers`,
  reported in `hints`); Debian reuses the template's unconditional `remote_smtp_smarthost` transport and `plain`/`login`
  authenticators, so the credential is a managed block in `/etc/exim4/passwd.client` (`mergeSmarthostPasswd`, 0640
  root:Debian-exim, the distro comments kept; `user`/`password` are `/^[^\0\r\n:]+$/` because that file and Debian's
  `${extract{2}{:}…}` authenticators split on `:`); non-Debian layouts get `transport_whm_smarthost.conf`
  (`renderSmarthostTransport`: `hosts_require_tls`/`hosts_require_auth`), `auth_whm_smarthost.conf` (`renderSmarthostAuth`:
  PLAIN/LOGIN client authenticators keyed by `$host`, carets doubled) and `<whm>/smarthost.passwd` (0640 root:exim). Every
  write is followed by `update-exim4.conf` (Debian) + `exim -bV` with a full rollback on rejection, then `-bP router_list`
  decides `hooked` and `precedes` (no `dnslookup`/`dnslookup_relay_to_domains`/`lookuphost`/`smarthost` before it).
  `mail.smarthost.remove { reload }` (destructive) removes the files/block the same way. Verified on nova (unsplit Debian,
  Exim 4.99.1): generated from a temp copy of `/etc/exim4`, `exim -bV` clean, `disable_ipv6` true,
  `REMOTE_SMTP_SMARTHOST_HOSTS_REQUIRE_TLS=*`, `whm_smarthost` first in `router_list` (dnslookup tenth), `exim -bt
  someone@example.org` → `router = whm_smarthost, transport = remote_smtp_smarthost, host smtp.gmail.com port=587`, local
  addresses still take `system_aliases`/`userforward`.
- **`mergeEximBlock` (`agent/src/ops/web.js`):** when the block being merged sets `disable_ipv6`, every `disable_ipv6 = …`
  line outside the block is dropped (Exim: "option set for the second time" is fatal — reproduced on nova); without it in the
  block the operator's line is left alone. `validateExim` also recognises that message.
- **Not done here:** the installer does not add the unsplit `.include_if_exists` line (same rule as the virtual-mail slots,
  CLAUDE.md 2026-11-05); `DCconfig_smarthost`/`DCsmarthost` cannot switch an unsplit `internet` template through localmacros
  alone (`DCconfig_internet=1` is defined after localmacros and `dnslookup` precedes the template's own smarthost router),
  hence the Keel router.

## 48. Customer panel: Visitors — GoAccess web statistics (`ctx.panelLogs.stats`, agent `stats.goaccess.*`) (P1-5)
Reports are the account's own files, rendered and read back as the account; nothing is stored in SQLite.
- **Agent** (`agent/src/ops/stats.js`, the AWStats family's file): `stats.goaccess.detect` → `{ installed, bin, version,
  packages: { apt: ['goaccess'], dnf: ['goaccess'] }, statsDir: '.keel/stats', nice, ionice }`.
  `stats.goaccess.run { username, domain, logFiles? }` (`timeoutMs` 180 s): `goaccess` must exist (`capability_missing`
  otherwise), the user must be a managed account (`as-user.js assertManaged`), every log — `domainLogFiles(username, domain)`
  by default, i.e. `/var/log/whm/domlogs/<user>/<domain>-access.log` and `-ssl-access.log` — must sit directly in
  `/var/log/whm/domlogs/<user>/` and be named `<domain>-…` (`path_not_allowed`); missing or empty logs are dropped and an
  empty set answers `{ skipped: true, reason: 'no_log' }` without running anything. Output goes to
  `<home>/.keel/stats/` (`accountPath` pins it under the home through symlinks; `.keel` `0711`, `stats` `0750`, both
  `mkdir -p` **as the account**); goaccess runs as the account through `asUserArgv` + `nice -n 10` wrapped in
  `ionice -c 2 -n 7` (`ioniceArgv`, skipped when absent), 120 s, `--no-global-config --log-format=COMBINED
  --output=<domain>.tmp.html --output=<domain>.tmp.json -` (`goaccessArgv`; goaccess 1.9 insists on `.html/.json/.csv`
  output names and checks `--output=json` as a path in the working directory): the log is opened **by root** (the
  account cannot traverse `/var/log/whm`, 0750 whmpanel) — both logs merged in time order into a private `/tmp/whm`
  scratch file when a domain has the plain and the TLS log — and handed to goaccess as stdin (`stdinFd`); the HTML is
  renamed into `<domain>.html` only when the run succeeded, the JSON staging file is read back as the account and
  removed (256 MiB cap) and only its summary (`summarizeGoaccess`: `version 1`,
  `period`, `totals { requests, validRequests, failedRequests, visitors, files, notFound, referrers, bandwidth, logBytes }`,
  `days` ≤ 31 newest, and the top ten `pages`, `staticFiles`, `notFound`, `referrers`, `countries`, `statusCodes`,
  `browsers`, `os` as `{ label, hits, visitors, bytes }`; never the hosts panel) is written as
  `<domain>.summary.json` (`0640`, `stagedWrite`). Returns `{ domain, username, skipped: false, logFiles, html, summary,
  generatedAt, totals }`. Not destructive. No new allowed root (`/home*`, `/var/log/whm`).
- **Service** `ctx.panelLogs.stats` (`services/panel-logs.js`): `summary(scope)` (feature `webstats`; `501` through
  `CapabilityError('goaccess')` when `detect` says not installed) reads each web domain's summary with `files.read` as the
  account (`main` first, then `addon`/`sub` alphabetically; parked aliases have no log of their own), strips `logFiles`, and
  reports `{ goaccess, cooldownSeconds, schedule, domains: [{ domain, type, available, generatedAt, running: { id, status } |
  null, cooldownUntil, error, summary }] }`. `generate(scope, domain, req)`: own domain (`404` otherwise), `409 busy` while any
  `panel.stats.generate` job of the account is queued/running, `429 generate_cooldown` (`fields.retryAfterSeconds`) within
  setting `panel.stats.generate_cooldown_s` (600) of the last request for that domain (derived from the jobs table), then
  enqueues `panel.stats.generate { username, accountId, domain, actor }` and audits `panel.stats.generate`. `run(job)`:
  with `username` one account/domain; without, every `suspended = 0` account whose `plan_snapshot_json.features.webstats`
  is not `false`, over `accounts.domain` + `account_domains` of type main/addon/sub, logging per domain, counting
  `{ accounts, generated, skipped, failed }`; the scheduled run first answers `skipped: 'panel_disabled'` when the
  panel is off and `skipped: 'goaccess_missing'` when `stats.goaccess.detect` says not installed (no account walked,
  one `warn` line, no error — the schedule exists on every host); a `capability_missing`/`binary_not_found` from a
  run stops it with `skipped: 'goaccess_missing'` as well, any other failure is logged and the run continues. `report(scope, domain, req, res)` streams `<domain>.html` through `files.chunk_read`
  (2 MiB pieces, `Content-Length` from the first) with `Content-Type: text/html; charset=utf-8`,
  `Content-Security-Policy: sandbox allow-scripts; frame-ancestors 'self'` (overrides helmet's `frame-ancestors 'none'`
  for this response only), `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Cache-Control: private,
  no-store`; `404` when no report exists.
- **Routes** (`routes/panel/logs.js`, token scope `panel:logs`): `GET /api/panel/logs/stats`, `POST
  /api/panel/logs/stats/:domain/generate` (202), `GET /api/panel/logs/stats/:domain/report`. The router registers the job
  and `ctx.scheduler.ensure('panel-stats-generate', '50 1 * * *', 'panel.stats.generate')`.
- **Client:** `pages/panel/logs/visitors.jsx` (nav `Logs › Visitors`, key `panel:logs/visitors`, feature `webstats`): the
  full report is embedded only as `<iframe sandbox="allow-scripts" referrerPolicy="no-referrer" src="/api/panel/logs/stats/
  <domain>/report">`, never inlined; the page polls `/logs/stats` every 5 s while a job runs. Feature `webstats` is new in
  `DEFAULT_FEATURES` (`seed.js`) and the Feature Manager labels (a list without the key means enabled).
- **Host:** `goaccess` (`apt install goaccess`; INSTALL.md), `setpriv` or `runuser`; `nice`/`ionice` optional. The domlog
  directory is `root:<account> 0750` with `0644` files, so the account can read its own logs. GeoIP is a system-wide
  GoAccess setting; the countries panel appears only when it is configured.

## 49. Customer panel: WordPress installs (`ctx.panelSoftware`, agent `web.wp.fetch/configure/webinstall/remove/requirements`) (P1-7)
- **Agent** (`agent/src/ops/wp-install.js`, a second file for the `web.wp.*` family so `web.js` is not pulled into an import
  cycle through `as-user.js`/`files.js`; the WP-CLI ops in `web.js` are unchanged and reused): every path goes through
  `accountPath()` (home from `/etc/passwd`, lexical + real containment, allowed roots), every file action runs as the account
  through `asUser()`; root only downloads into `/tmp/whm` and `lstat`s inside the tree.
  `web.wp.requirements {}` → `{ wpcli, php, phpMysql (php -m: mysqli|pdo_mysql, null without php), unzip, asUser }`.
  `web.wp.fetch { username, path, timeoutMs ≤ 120000, maxBytes ≤ 96 MiB }` (destructive): refuses a tree that already holds
  `wp-config.php`/`wp-settings.php` (`exists`) and the home itself; downloads `WP_DOWNLOAD_URL` (`https://wordpress.org/latest.zip`,
  https-only redirects ≤ 5, Content-Length and streamed size bounded, zip magic checked) onto a `0600` root scratch descriptor,
  compares the streamed SHA-1 with `WP_CHECKSUM_URL` (`checksum_mismatch` → 422), shares the copy `root:<gid> 0640` by descriptor
  (never by path), lists it as the account (`unzip -Z /dev/fd/0`), `checkWordPressMembers` (only `wordpress/…` members, files and
  directories only, then `files.js` `checkArchiveMembers` for traversal/links/.ssh; the release must carry `wp-settings.php` and
  `wp-includes`), refuses when a top-level name already exists in the target, `mkdir -p`, `unzip -o -q /dev/fd/0 -d <target>`,
  `mv -t <target> -- <target>/wordpress/<name>…`, `rmdir`; on any failure what this run created is removed as the account
  (`details.cleanup`, "left in place" when that failed too). Returns `{ path, bytes, sha1, members, version }`.
  `web.wp.configure { username, path, dbName, dbUser, dbPassword, dbHost='localhost', tablePrefix='wp_' }` (destructive):
  requires an unpacked tree, refuses an existing `wp-config.php`, renders `renderWpConfig()` (PHP single-quoted strings escaped,
  eight 64-char salts from the CSPRNG — `WP_SALT_KEYS` —, `utf8mb4`, `WP_DEBUG false`, `FS_METHOD direct`), writes it through
  `files.js` `stagedWrite` as the account `0600`, lints with `php -l` as the account when php exists (the file is removed on a
  failed lint).
  `web.wp.webinstall { username, path, url, title, adminUser, adminEmail, adminPassword, locale='en_US', ip='127.0.0.1',
  timeoutMs ≤ 300000 }` (destructive): requires `wp-config.php` + `wp-admin/install.php`, POSTs the step-2 form
  (`weblog_title, user_name, admin_password(2), pw_weak, admin_email, language`) to `<url>/wp-admin/install.php?step=2` against `ip`
  with the URL's `Host` (SNI, certificates unverified; the scheme of `url` decides `is_ssl()` and so the `siteurl` WordPress
  stores); `parseInstallResponse` → success on "Success!"/"has been installed", `exists` on "already installed", otherwise
  `command_failed` with the installer's own message. The password travels in the request body only.
  `web.wp.remove { username, path, mode: 'tree' | 'entries' }` (destructive): requires a WordPress tree (`wp-settings.php` +
  `wp-includes`), never the home; `tree` = `rm -rf --one-file-system -- <path>`, `entries` = only the release's own top-level
  names (`WP_TOP_LEVEL`) that exist, for a site that shares a document root.
- **Service** `ctx.panelSoftware` (`services/panel-software.js`, created by `routes/panel/software.js`): `list(scope, req)` runs
  `web.wp.requirements` and `web.wp.discover { usernames: [account] }` and keeps the installs under one of
  `ctx.panelDomains.allDomains(scope)`'s main/addon/sub docroots (deepest wins; `id` = `installIdOf(abs)` = sha256 prefix,
  `databaseOwned` = the `DB_NAME` of `wp-config.php` is a `databases` row of this account); `install(scope, body, req)` →
  `resolveSite` (404 foreign domain, 422 bad folder, 409 already a WordPress tree), `requirements.canInstall` (= `asUser && (wpcli
  || php && phpMysql && unzip)`, else `CapabilityError('wordpress')` → 501 with `INSTALL_HINT`), then
  `ctx.panelDatabases.createForApp(scope, { base: 'wp' })` (first free `<user>_wp[N]` for both database and user; quota via
  `create`, `409 limit_reached` before anything exists; a failed user drops the database), then job `panel.wp.install` with
  `adminPasswordEnc`/`dbPasswordEnc` (`ctx.crypto.encrypt`), `method: 'wpcli' | 'web'`. The job runs as the owner principal
  read back at run time (`jobScope`, as the dump job): `web.wp.install` on a WP-CLI host, else `fetch → configure → webinstall`;
  on failure `compensate()` removes the unpacked files (`web.wp.remove`, `entries` when the site is the docroot itself, unless the
  agent already reported `details.cleanup`) and drops user then database through `ctx.panelDatabases.dropUser/drop`; audit
  `panel.wp.install` / `.done` / `.failed`. `update(scope, id, req)` needs `requirements.wpcli` (else `CapabilityError('wpcli')`),
  job `panel.wp.update` → `web.wp.update { kind: 'core' }`. `remove(scope, id, { database }, req)` → `web.wp.remove` then, only
  with `database:true` and `databaseOwned`, the user of the same name (if the account's) and the database. `getJob/streamJob`
  as in panel-databases, restricted to `JOB_TYPES` with `params.accountId === scope.accountId`; `shapeJob` strips the
  `*Enc` fields, `ownerId` and `accountId`. The generated admin password is in the 202 body once (`generatedPassword: true`),
  never in the job or the audit.
- **Routes** (`/api/panel/software`, `panelRouter(ctx, 'software')` — no `panel:software` token scope exists, so mutations are
  session-only and the list needs `panel:read`): `GET /wordpress`, `POST /wordpress` (202), `GET /wordpress/jobs/:id[/stream]`,
  `POST /wordpress/:id/update` (202), `DELETE /wordpress/:id?confirm=true&database=true|false` (422 without `confirm=true`).
- **Shared edits:** `panel-databases.createForApp(scope, { base, password? }, req)` → `{ database, user, password, hosts }`;
  `DEFAULT_FEATURES.wordpress = true` (+ FeatureManager label); nav group *Software* (icon `Package`, colour `software`),
  `panel-category.software` / `panel.software/wordpress.*` in `en.json`.
- **Host:** `php-mysql` (`php8.5-mysql` on nova — present), `unzip` (present), outbound HTTPS to wordpress.org, `setpriv`;
  WP-CLI optional (`wp` in `PATH`; absent on nova, so installs take the web path and *Update* answers 501). Not changed by this
  unit: the WP-CLI ops in `web.js` (`runuser`-based, reviewed: every command and the chmod/rm already run as the account).

## 50. Customer panel: preferences, the 2FA policy seam and mailbox folders (`ctx.panel.preferences`, `ctx.panel.assertTwoFactor`, `vmail.mailbox.*`) (P1-8, P1-9, P1-12)
- **Preferences** (`services/panel.js`, migration `034d_panel-preferences.sql`: `users.locale` + `panel_account_prefs
  (account_id PK → accounts, email2, notify_quota, notify_bandwidth, notify_password_change, updated_at)`):
  `ctx.panel.preferences.get(scope)` → `{ email, email2, notify: { quota, bandwidth, passwordChange }, locale, locales:
  [{ code, name }] (enabled rows of ctx.locales.list()), defaultLocale }`, also under `GET /api/panel/me` as `preferences`
  (and `user.locale`). `setContact(scope, { email, email2?, notify?, currentPassword? }, req)` (async) first verifies
  `currentPassword` against the linked login's bcrypt hash unless `scope.mode === 'acting'` (`422` with
  `fields.currentPassword` when missing, `401` when wrong, `403` when the login is not the account's: the address is the
  recovery address, so a hijacked session alone cannot move it), then writes `accounts.contact_email` (the same
  column the console and the forgot-password lookup use), mirrors it to the linked login's `users.email`, upserts the
  prefs row (unmentioned switches keep their value), audits `panel.me.contact` (`email`, `email2`, `notify`,
  `previousEmail`; never the password) and, when the address changed, mails the **previous** address a detached notice
  through `ctx.contacts.sendMail` (`[<company>] Contact address changed for <username>`); route
  `PUT /api/panel/me/contact` is session-only and takes `currentPassword` (1–256 chars, optional in the schema, required
  by the service unless acting). `setLocale(scope, { locale }, req)` refuses while
  acting (`403 not_while_impersonating`: the row is the administrator's), accepts `null`/`''` to clear and only codes in
  `ctx.locales.enabledCodes()` (`422` with `fields.locale`), audits `panel.me.locale`; route `PUT /api/panel/me/locale`.
  The SPA adopts `user.locale` once per load (`adoptUserLocale` in `i18n/useT.js`, called by `usePanelMeLoader` outside
  "Log in as") by setting the browser preference, so the stored language follows the login across browsers.
- **Seam for notifiers:** `ctx.panel.preferences.notifyFor(username)` → `{ to: [contact_email, email2].filter(Boolean),
  notify: { quota, bandwidth, passwordChange } }` or `null` for an unknown account. Whoever mails a customer about disk
  quota or bandwidth (account-information / account-functions today send nothing to customers) must consult it. The panel
  itself honours `passwordChange`: after every successful `changePassword` (panel page, forced change through the core
  route, mailed reset) a plain notice goes to each address through `ctx.contacts.sendMail`, detached and best effort.
- **One 2FA policy check:** `ctx.panel.assertTwoFactor(user, path = null)` throws `403 two_factor_required` when
  `panel.require_2fa_for_users` is on, `user.role === 'user'` and `totp_enabled` is 0, unless `path` is `/me` or starts
  with `/security/two-factor`. `panelScope` (routes/categories/panel.js) calls it with `req.path` for `mode === 'user'`;
  `changePasswordForUser` (the `/api/auth/password` seam) calls it without a path on the non-forced branch. No other code
  reads the setting for enforcement. `ctx.panel.settings.get()` adds `linkedUsers` and `usersWithoutTotp` (role-`user`
  logins joined to `account_users`, with `totp_enabled = 0`), shown under the toggle in *Panel › Customization › Account
  panel* and reported by Security Advisor as `panel.2fa.policy` (`ok` when required, `info` when optional; `fix` →
  `/cpanel/customization`).
- **Mailbox folders** (agent `vmail.js`, root `doveadm`, no path involved): `vmail.mailbox.status { user: <local@domain> }`
  → `{ user, folders: [{ name, messages, bytes (vsize), unseen }] }` from `doveadm -f tab mailbox status -u <user>
  'messages vsize unseen' '*'` (INBOX first; `not_found` on "User doesn't exist", `capability_missing` without doveadm).
  `vmail.mailbox.expunge { user, folder, olderThanDays? }` (destructive, 300 s): `folder` matches `FOLDER`
  (`/^(?!\.)(?!.*\.\.)(?!.*\.$)[^\0-\x1f\x7f"\*%]{1,200}$/`), `olderThanDays` is an integer 7–3650 and is **required unless
  the folder is `Trash` or `Junk`** (schema refine); the op checks the folder exists (`not_found`), runs `doveadm expunge -u
  <user> mailbox <folder> [savedbefore <N>d] all` with every word a separate argv element, and answers `{ before, after,
  removed }` from a status call on either side. `services/panel-email.js` mirrors the constants (`EMPTIABLE_FOLDERS`,
  `EXPUNGE_MIN_DAYS`, `EXPUNGE_MAX_DAYS`, `FOLDER_NAME`) and exposes `folders.list(scope, id)` /
  `folders.empty(scope, id, folder, { olderThanDays }, req)` (`loadMailbox` ownership, `capabilities.require('dovecot')`,
  audit `panel.email.folder.empty`), routes `GET /api/panel/email/accounts/:id/folders` and `POST
  …/accounts/:id/folders/:folder/empty`. Dovecot 2.4 prints the tab header in its own column order
  (`mailbox messages unseen vsize` on nova); the parser keys by header name.
- **Delivery tracking:** `ctx.panelEmail.usageMessages(scope, { sinceHours, q, status, page, pageSize })` → `{ data:
  [{ id, key, arrivedAt, sender, recipient, status, subject, size, detail, deliveredAt, remoteHost }], meta: { page,
  pageSize, total, hours, q, status, log } }`: `ctx.mail.reports.delivery({ hours, page: 1, pageSize: 20000 })`
  post-filtered to the account's domains and authenticated mailboxes (as `usage()`), then `status` (one of
  `MESSAGE_STATUSES`) and a case-insensitive `q` over sender/recipient/subject/detail/id, then paged (`pageSize` ≤ 100,
  default 25). Route `GET /api/panel/email/usage/messages`. `GET /email/usage` keeps its `recent` (100 rows) for
  compatibility.

## 51. Software: one-click runtime installs (`ctx.software.runtimes`, agent `pkg.repo.ensure` / `pkg.node.*` / `pkg.runtime.detect`)
- **Purpose:** *Software › Install Software* (nav slug stays `install-distro-packages`, no new nav function) offers a
  curated catalog of PHP, Node.js, Python, Ruby, Go, Composer and common tools with one-click installs, and every page
  that finds a package missing installs it in place (`InstallPackages` / `RuntimeInstaller` in the client) instead of
  sending the operator to the raw package search, which stays as the *Search* tab. The catalog is static data in
  `services/software-runtimes.js`: `RUNTIMES` (`php` 8.5…7.4 with the ondrej/sury/Remi package lists per version,
  `nodejs` 24/22/20/18 via `installer: 'node'`, `python` 3.13…3.9, and the `single` runtimes `ruby`, `go`, `composer`),
  `TOOLS` (`git`, `imagemagick`, `ffmpeg`, `redis`, `memcached`, `certbot`, `unzip`, `build-essential`, `python3-pip`,
  `cpanminus`, `php-pear`, `openssh-server`, `bind`, `iproute2`, `locales`, `goaccess`, `clamav`; each a `debian` and a
  `rhel` package list), with `resolveInstall({ runtime, version, tool }, family)` → `{ kind, key, label, version,
  packages, repos, installer, major? }` (422 for a version outside the catalog, a missing version, or a family with no
  packages; `single` runtimes ignore `version`), `reposFor`, `packagesFor`, `runtimeNote` and `detectedVersion` exported
  for tests.
- **Agent ops** (`ops/pkg.js`; `DEFAULT_ALLOWED_ROOTS` gains `/etc/apt/sources.list.d`, `/etc/apt/keyrings`,
  `/etc/yum.repos.d`, `/opt/keel/node` and only the versioned links `/usr/local/bin/node<major>` / `npm<major>` / `npx<major>` for majors 16–30 (`NODE_LINK_PATHS` in `agent/src/lib.js`; never `/usr/local/bin` itself); test overrides `WHM_APT_SOURCES_DIR` / `WHM_APT_KEYRINGS_DIR` /
  `WHM_YUM_REPOS_DIR` / `WHM_NODE_DIR` must stay under an allowed root, as `PKG_RUN_DIR` does):
  `pkg.os.release` (read-only) → `{ id, idLike, versionId, codename, family: 'debian' | 'rhel' | null }` from
  `/etc/os-release` (pure `parseOsRelease(text)`).
  `pkg.repo.ensure { repo: 'php' | 'python' | 'epel' | 'remi' }` (enum, nothing free-form; idempotent) → `{ repo, family,
  action: 'present' | 'added' | 'unsupported', detail }`: Ubuntu adds `ppa:ondrej/php` / `ppa:deadsnakes/ppa` through
  `add-apt-repository -y --no-update` (installing `software-properties-common` first when missing; present when a file
  under `/etc/apt/sources.list.d` mentions `ppa.launchpadcontent.net/<owner>/<ppa>` or the legacy `ppa.launchpad.net`
  host); Debian `php` fetches `https://packages.sury.org/php/apt.gpg` (`curl -fsSL --proto =https --max-time 60` into a
  temp file under `/etc/apt/keyrings`, renamed to `keel-sury-php.gpg`, 0644) and writes
  `/etc/apt/sources.list.d/keel-sury-php.list` (`deb [signed-by=…] https://packages.sury.org/php/ <codename> main`);
  Debian `python` → `unsupported` (distro version only); RHEL `epel` → `dnf -y -q install epel-release`, `remi` →
  `dnf -y -q install https://rpms.remirepo.net/enterprise/remi-release-<major>.rpm` (`<major>` 8, 9 or 10, else
  `unsupported`), present when `rpm -q <name>` exits 0; `php` on RHEL ensures epel then remi, `python` on RHEL is
  `present` (AppStream). Writes go through `writeAtomic` / `O_EXCL|O_NOFOLLOW`; the op never refreshes the index (the
  caller runs `pkg.update_index`).
  `pkg.node.list` → `{ system: { version, path } | null, versions: [{ major, version, path, bin }] }` from
  `/opt/keel/node/<major>/bin/node` plus `node` on PATH. `pkg.node.install { major: int 16–30, wait? }` installs the
  official nodejs.org build side by side under `/opt/keel/node/<major>`: `SHASUMS256.txt` of `latest-v<major>.x` (pure
  `pickNodeTarball(shasums, major, arch)` → `{ file, sha256, version }`, arch `x64` / `arm64`), download with
  `curl -fsSL --proto =https --max-time 600` into a mkdtemp `/opt/keel/node/.tmp-<rand>`, sha256 verified with
  `node:crypto` (pure `verifySha256(buffer, hex)`; a mismatch refuses and leaves no partial directory), `tar -xJf`,
  atomic rename (an existing major is renamed to `.old-<rand>` and removed), then symlinks `/usr/local/bin/node<major>`,
  `npm<major>`, `npx<major>` (lstat-checked: only a symlink that already points under `/opt/keel/node` is replaced) →
  `{ major, version, path, bin, symlinks }`. `pkg.node.remove { major }` (destructive) removes the directory and the three
  symlinks when they point into it. `pkg.runtime.detect` (read-only, probes with `hasBinary` + `--version`, 15 s each,
  never installs) → `{ os, php: [{ id, version }], node: <pkg.node.list>, python: [{ minor, version, bin }] (3.8–3.14 on
  PATH), ruby, go, composer, perl: version | null }`.
- **Service** (`services/software.js`, `ctx.software.runtimes`): `catalog()` → `{ family, os, manager, capability,
  runtimes: [{ key, label, single, installer, versions: [{ id, label, installed, version, packages, repo, note, path?,
  bin? }] }], tools: [{ key, label, packages, installed }] }` from ONE `pkg.runtime.detect` plus ONE `pkg.list_installed`
  (prefix list over every tool package; `installed: null` without a package manager); `note` carries the hints
  ("deadsnakes on Ubuntu, distro version only on Debian", "installed under /opt/keel/node/<major>, the panel's own
  Node.js stays untouched", "Remi collection, /opt/remi/php<nn>"). `install({ runtime, version } | { tool }, user, req)`
  → `{ job, target, packages }` (202; job type `software.runtime.install`, audit `software.runtime.install` with target
  `php:8.3` / `nodejs:22` / `bind`). `remove({ runtime: 'nodejs', version })` → job `software.runtime.remove`
  (`pkg.node.remove`); PHP and Python packages are removed from the *Installed* tab as before. `recent()` → the last 20
  jobs of either type. `modules.installers()` adds `family` and `packages: { php: [php-pear, php-dev], perl:
  [cpanminus], ruby: [ruby-full], python3: [python3-pip] }` (RHEL: `php-pear php-devel`, `perl-App-cpanminus`,
  `ruby ruby-devel`, `python3-pip`) so Module Installers and Install a Perl Module install a missing installer in place.
- **Job steps** (`software.runtime.install`, each logged with progress): (1) for every repo in `plan.repos`
  `pkg.repo.ensure { repo }` — `'unsupported'` fails the job with the agent's `detail`, and one `'added'` triggers a single
  `pkg.update_index` through `runLongOp`; (2) `runLongOp(job, 'pkg.install', { packages })` with the exact catalog list,
  or `runLongOp(job, 'pkg.node.install', { major })` for Node.js (no distro package); (3) PHP only:
  `pkg.php.versions().defaultId` is read before the install and, when the installer moved the CLI default (ondrej's
  alternatives prefer the newest), `pkg.php.default.set` puts the previous default back and the job log says so;
  (4) `capabilities.refresh()`; (5) `pkg.runtime.detect` again — a runtime still missing fails the job; result
  `{ kind, runtime | tool, version, packages, installed: true, detected, method: 'package' | 'node' | 'source', path?, bin?, symlinks? }`.
- **PHP source builds (2026-11-06):** `RUNTIMES.php.source = true`; a PHP version whose repository has no packages for
  the host (`pkg.repo.status` → `supported: false`, or the probe failed / `null`) is still `state: 'available'` with
  `method: 'source'` (`note` "Built from the official php.net source into /opt/keel/php/<minor> (about 15 minutes);
  packages from <repo> are not available for <os>"); repo-backed versions are `method: 'package'`; `state:
  'unsupported'` only without any package manager (`capability: false`). `catalog()` makes ONE `pkg.repo.status { repo:
  'php' }` for this and every PHP row carries `state`, `method`, `source` (an installed Keel build), `repoStatus` and
  `prefix` (`/opt/keel/php/<minor>`) for source rows; the runtime entry carries `source: true`.
  `resolveInstall({ runtime: 'php', version }, family, { method: 'source' })` → `{ installer: 'php-source', minor, deps:
  PHP_BUILD_DEPS[family], prefix, packages: [], repos: [] }` (422 without a family, or for a runtime without a source
  build; `PHP_BUILD_DEPS` / `PHP_SOURCE_PREFIX` / `INSTALL_METHODS` are exported). `install({ runtime: 'php', version,
  method? })`: `method` is optional (`package` | `source`, PHP only — 422 elsewhere); omitted, the service probes the
  repo and picks `package` when it is present or supported, `source` otherwise; `method: 'package'` on a repo with no
  series is a 422 (`fields.method: ['source']`). Audit args and the 202 body carry `method` (and `prefix`).
  Job steps for `installer: 'php-source'`: progress 5 "installing build dependencies" → `runLongOp(job, 'pkg.install',
  { packages: deps })` → 15 "downloading and building PHP <minor>" → `runLongOp(job, 'pkg.php.build', { minor })` (a
  background run polled through `pkg.run.status`, every output line forwarded to the job log; when a failed run produced
  more than the 2000 lines the job keeps, its last 40 lines are logged again before the failure) → 90 "registering the
  PHP-FPM unit" → `pkg.php.build.finish { minor }` → `{ minor, version, prefix, binary, unit, active, link }` (never
  called when the build failed) → the CLI-default restore check → `capabilities.refresh()` → `pkg.runtime.detect`
  must report the minor. Result adds `{ method: 'source', prefix, unit, link, release, binary, deps }`. The route body
  gains `method?: enum('package', 'source')`.
- **Routes** (`routes/categories/software.js`, all `requireRoot`): `GET /api/software/runtimes`,
  `GET /api/software/runtimes/recent`, `POST /api/software/runtimes/install` with `{ runtime: enum(RUNTIME_KEYS),
  version?: /^\d+(\.\d+)?$/ }` or `{ tool: enum(TOOL_KEYS) }` (strict, exactly one of the two, no version with a tool)
  → 202, `POST /api/software/runtimes/remove { runtime: 'nodejs', version }` → 202. A version outside the catalog is a
  422 from the service; package installs without a package manager answer 501 while the catalog itself always loads.
- **Invariants:** repositories are picked from the enum only, never from a request string; the panel's own Node.js
  (`node` on PATH) is never replaced — catalog builds live under `/opt/keel/node/<major>` and are reached as
  `node<major>`; the PHP CLI default the operator chose survives a PHP install; the agent writes only under the added
  allowed roots and every command is an argv array; nothing was removed from the raw package search. Node tarballs are
  extracted with `tar --no-same-owner --no-same-permissions` and every entry of the extracted `bin/` must be owned by
  the agent's own uid (root) before the tree is renamed into `/opt/keel/node/<major>` — a foreign uid fails the op with
  `extract_failed`, so no hosting account ever owns a binary that root or `node<major>` users execute; every `curl`
  fetch (sury key, SHASUMS256.txt, tarball) carries `--proto =https --proto-redir =https`, so a redirect can never
  downgrade to plaintext; `pkg.runtime.detect` probes composer with `--no-plugins --no-scripts` and every probe runs
  with `cwd: '/'`, so no project `composer.json` can load code into a root process.

## 52. PHP Version Manager (`ctx.software.php.catalog/remove/setOffered/offeredVersions/usage`, agent `pkg.php.remove`, `pkg.repo.status`)
- **Purpose:** *Software › PHP Version Manager* (nav key/route stay `software/multiphp-manager` via `{ slug }`) shows EVERY
  PHP version of the one-click catalog (§51) plus whatever else is installed, with Install / Remove / Set as default
  and an "Offered to accounts" switch per version; the account panel (`/panel/php/versions`) lets the holder pick a
  version per domain or for all domains at once, restricted to what the root offers and the plan allows.
- **Agent, PPA series probe (`probePpaSeries(ppa, codename)`, exported):** `curl -fsSI --proto =https --proto-redir
  =https --max-time 20 -o /dev/null -w %{http_code} https://ppa.launchpadcontent.net/<owner>/<ppa>/ubuntu/dists/<codename>/InRelease`
  (`allowFailure`) → `{ supported: true }` on 200, `{ supported: false, status }` on 404, `{ supported: null, error }` when
  the probe itself failed. `ensurePpa` (inside `pkg.repo.ensure`) probes before `add-apt-repository` and answers
  `{ action: 'unsupported', detail: 'ppa:<owner>/<ppa> has no packages for Ubuntu <version> <codename>; …' }` on a 404
  series (ondrej/php has no `resolute` series; an added absent series breaks every later `apt-get update`); a failed
  probe falls through to the add so offline installs keep working.
- **Agent, `pkg.repo.status { repo: php|python|epel|remi }`** (read-only, never writes) →
  `{ repo, family, present: bool, supported: true|false|null, detail }`. Ubuntu: `present` = the PPA is in
  `sources.list.d`, `supported` = true when present else the probe; Debian php: present = sury list exists, supported true;
  Debian python: supported false; RHEL: epel/remi/php via `rpm -q`, Remi only on EL 8/9/10, python always
  present+supported (AppStream); unknown family: supported false.
- **Agent, `pkg.php.remove { version: phpVersionId, purge?: false, wait?: true }`** (destructive): resolves the version with
  `discoverPhp()` (`phpDiscovery.discover`, swappable by tests), `OpError('refused')` when it is the CLI default or the only
  installed version, `not_found` when unknown or when no package of the build is installed. Packages come from the
  package manager under the layout glob (`phpPackageGlob`: Debian `php<ver>-*` via `dpkg-query -W -f '${binary:Package}\n'`,
  Remi/SCL `<id>-php-*`, EA4 `<id>-*`, RHEL stock `php-*` + `php` via `rpm -qa --qf '%{NAME}\n'`), filtered to the prefix
  and the package-name alphabet, then `apt-get remove|purge -y -q <APT_DPKG_OPTS> -- <pkgs>` / `dnf|yum -y -q remove --
  <pkgs>` through `runLong` (kind `remove`, `wait: false` capable) → `{ version, manager, packages, purge, background,
  code|run, output }`. `/etc/php/<ver>` stays unless `purge: true`.
- **Service (`ctx.software.php`):** `catalog()` → `{ family, os, manager, capability, phpCapability, effectiveDefault,
  configuredDefault, offered: string[]|null, versions: [{ id, catalogVersion, label, state: 'installed'|'available'|
  'unsupported'|'unknown', installed, version, binary, iniPath, fpmInstalled, fpmActive, fpmUnit, isDefault (CLI),
  isSystemDefault, offered, domains, packages, repo, repoStatus: { present, supported, detail }|null, advisories, note }] }`
  from ONE `pkg.php.versions` (skipped without the `php` capability), ONE `runtimes.catalog()` and ONE `pkg.repo.status`
  per distinct repo (a failing probe → `repoStatus: null`, state `'unknown'`, Install still allowed). State: installed →
  `installed`; not installed and (`repo === null` or `repoStatus.present` or `repoStatus.supported === true`) →
  `available`; `supported === false` → `unsupported` with `note = repoStatus.detail`; otherwise `unknown`. Installed versions
  outside the catalog (ea-php83, a distro-only build) are appended as `installed` with `catalogVersion: null`; `id` is
  the installed id when a catalog row matched an installed build, the catalog version otherwise. **Since 2026-11-06** the
  not-installed state comes from §51's availability rule: `supported === false` or a failed probe → `state: 'available'`
  with `method: 'source'` (the php.net build, `prefix: '/opt/keel/php/<minor>'`, `packages: []`, the source note), a
  present/supported repo → `method: 'package'`; `unsupported` (`method: null`) only without a package manager. Every row
  carries `method`, `source` and `layout`; an installed Keel build (agent `pkg.php.versions` entry with `layout: 'keel'`,
  `source: true`, label "PHP <minor> (Keel build)", binary `/opt/keel/php/<minor>/bin/php`, unit `keel-php<minor>-fpm`,
  ini `<prefix>/lib/php.ini`) shows `source: true`, `method: 'source'`, `prefix` and `packages: []`. `usage()` → `{ [id]:
  count }` from one SQL over `account_domains.php_version` (a main domain without a row inherits and counts for nothing).
  `offeredVersions()` → ids or null (= every installed version). `setOffered(ids|null, user, req)` validates each id
  against the installed versions (422 `versions`), persists setting `php.offered_versions`, audits `software.php.offered`,
  returns `{ offered }`. `remove(version, user, req)` → 422 (`version` field) when not installed, when it is
  `effectiveDefault`, when it is the only installed version or when `usage()[version] > 0` (message carries the count);
  otherwise job `software.php.remove { version }` → `runLongOp(job, 'pkg.php.remove', { version })`, `capabilities.refresh()`,
  the id dropped from `php.offered_versions`; audit `software.php.remove`; returns `{ job, version }` (202); job result
  `{ version, packages, removed: true, layout?, prefix? }` (`layout: 'keel'` + `prefix` when the agent removed a source build:
  unit disabled and deleted, `/usr/local/bin/php<minor>` link and `/opt/keel/php/<minor>` removed, `/etc/php` untouched).
  `runtimes.remove` stays Node.js-only and points PHP to this manager.
- **Routes (`/api/software`, all `requireRoot`):** `GET /php/catalog`, `GET /php/usage`, `PUT /php/offered { versions:
  phpVersionId[] (≤50) | null }`, `POST /php/remove { version }` → 202 `{ job, version }`.
- **Amendment 2026-11-06 (removal guards; a live host lost webmail and phpMyAdmin when the distribution's PHP 8.5 was
  removed, since apt removed the dependants `roundcube-core` and `phpmyadmin` with `php8.5-*`):**
  - *Agent* `pkg.php.remove { version, purge?, force?: false, dry?: false, wait? }`: for a packaged layout the removal
    is simulated first through the same helper as `pkg.remove_simulate` (`apt-get -s -q -o Debug::NoLocking=true
    remove|purge -- <pkgs>` / `dnf|yum -q remove --assumeno -- <pkgs>`); every simulated package that is neither a
    requested one nor under the version's own prefix is `extra`. `dry: true` → `{ version, layout, manager, packages,
    purge, dry: true, remove: string[], extra: string[], output }` and removes nothing (a Keel build answers `extra: []`).
    `extra.length && !force` → `OpError('refused', 'Removing PHP x.y would also remove a, b; …', { version, packages,
    extra })` (422). With `force: true` the argv is unchanged (only the version's packages are named; the package
    manager takes the dependants) and the result adds `{ forced: true, extra }`.
  - *Service* `php.removeBlocker(version)` also refuses the version the hostname site's applications run on:
    `php.hostAppsOn(version, versions, defaultId)` lists the PHP apps of `ctx.web.hostApps.list()` (`php !== false`,
    `managed !== false`; labels `webmail`, `phpMyAdmin`) when `php.hostAppsPhpVersion(versions, defaultId)` equals the
    version — that is `ctx.web.hostApps.phpVersion()` when service-configuration exposes it, else the version whose
    socket `ctx.web.hostname.status().phpSocket` names (`/run/php/php<ver>-fpm.sock`, or a socket path containing
    `/<id>/`), else the distribution default (`pkg.php.versions` `defaultId`). `php.remove(version, user, req, { force })`
    then calls `pkg.php.remove { version, dry: true }` and answers 422 `{ message: 'Removing PHP x.y would also remove
    a, b — move webmail and phpMyAdmin to another version first, or force the removal', fields: { version: [...],
    extra: string[] } }` (`php.collateralMessage`) unless `force`; the job gets `{ version, force? }`, passes `force`
    to the agent, logs a warning, and its result adds `{ extra, forced: true }`. Audit `software.php.remove` args carry
    `{ force, forced, extra }`. Response: `{ job, version, extra, forced }`.
  - *Route* `POST /php/remove { version, force?: boolean }` (root only).
- **Amendment 2026-11-06 (a Keel build wins over the distribution tree of its minor; the PHP version updater, §63):**
  - *Agent discovery* (`discoverPhp`, `preferKeelBuilds(versions)` exported, `phpLayout`): a Keel build under
    `/opt/keel/php/<minor>` is THE entry for that minor — id stays the minor, `layout: 'keel'`, binary
    `/opt/keel/php/<minor>/bin/php`, `packagePrefix: null` — and the distribution tree of the same minor is no longer
    listed; the entry reports it as `packagedTwin: { binary, layout, packagePrefix, fpmUnit, poolDir, version }`
    (`version` is the twin binary's `PHP_VERSION`, filled by `pkg.php.versions` / `pkg.runtime.detect`, `null` from the
    synchronous discovery). `defaultId` resolves to the minor when `/usr/bin/php` points at either binary. `phpLayout`
    lists the Keel tree alone for that minor (no `<minor>-pkg` tree: nothing needs it; pools left in `/etc/php/<minor>`
    keep running on the packaged unit and go with the packages). A tree of the same minor without a build is unchanged.
  - *Agent* `pkg.php.remove { version, packages?: false, … }`: `packages: true` on a minor whose entry carries
    `packagedTwin` removes the DISTRIBUTION PACKAGES only (the twin's layout glob, simulated first, `extra`/`force` as
    before; `refused` while `/usr/bin/php` resolves to the twin binary) and never touches the prefix, unit or link —
    the result adds `{ packagesOnly: true, keelPrefix }`; `packages: true` on anything else is `not_found`. Without it
    the minor removes the Keel build (prefix, unit, link) exactly as before and the packages become the minor again.
  - *Service* `php.catalog()` row for a minor with both: label `PHP <minor> (Keel build)`, `version` = the build's,
    `layout: 'keel'`, `source: true`, `method: 'source'`, `prefix`, plus `packagedTwin: { binary, version, packagePrefix,
    fpmUnit }`, `packagePrefix` (the twin's, so the package layout can still be removed) and `note` "Distribution packages
    <v> remain installed and unused; Remove packages drops them without touching the Keel build." `php.remove(version,
    user, req, { force, packages })`: `packages: true` skips the default / usage / plan guards (the build keeps serving the
    minor) and refuses only a minor without a twin and the hostname site still rendering on the packages' socket
    (`/run/php/php<minor>-fpm*.sock`, "Update PHP first"); job `software.php.remove { version, packages: true }` → agent
    `packages: true`; result `{ version, packages, removed: true, packagesOnly: true, keelKept: true, prefix }`; the
    offered list is untouched; audit args carry `packages`.
  - *`resolveInstall(req, family, { method, installed, latest })`*: a source build over a packaged minor is allowed when
    `latest` (php.net's newest release of that minor, looked up by `runtimes.install` when `method: 'source'` meets a
    packaged install) is newer than the packaged version — the update path — and still `422` otherwise ("php.net's
    latest x.y release (v) is not newer; remove those packages first"). `detectedVersion` passes `packagedTwin` through.
  - *Route* `POST /php/remove { version, force?, packages?: boolean }` (root only).
  - *Catalog/install:* `resolveInstall(input, family, { method, installed })` takes the `detectedVersion()` answer for
    the minor: an existing Keel build (`source`/`layout: 'keel'`) → 422 "already installed as a Keel build" for any
    method; a distribution tree with `method: 'source'` → 422 "PHP x.y is installed from packages; remove those packages
    first if you want a Keel build". `runtimes.install` runs `pkg.runtime.detect` once per request for PHP, defaults an
    installed distro minor to `method: 'package'` even when the repository probe says unsupported, and the catalog row
    of such a minor stays `state: 'installed', method: 'package'` (never a source offer).
  - *Build script* `php-build.sh` writes `lib/conf.d/10-opcache.ini` only when `<php-config --extension-dir>/opcache.so`
    exists after `make install`.
- **Account panel (`ctx.panelPhp`):** `versions(scope)` filters by the plan's `php_versions` AND the root's offered list; a
  version pinned on one of the account's web domains stays listed with `legacy: true` (never selectable); each entry carries
  `usage` (this account's domains on it) and the answer adds `offered: bool` (a root list exists), `usage: { [id]: n }`,
  `recommended` (first non-legacy id without a `critical` advisory). `setAll(scope, version|null, { domains? }, req)` →
  `PUT /api/panel/php/domains { version: phpVersionId|null, domains?: hostname[] }` — omitted domains = every web hostname
  (main/addon/sub, never parked/alias; a foreign or parked name is a 404), one `software.php.setDomainVersion` call (job
  when more than one domain), audit `panel.php.version_all`, returns `{ domains, phpVersion, job: { id }|null, results }`
  (202 with a job). `setVersion` uses the same selectability check (422 on a non-offered or legacy version).
- **Invariants:** the system default and a version any domain is pinned to are never removed; the last installed
  version is never removed; the offered list is a panel-only filter — root and reseller listings (`GET /php/versions`)
  are unchanged; a PPA is added only after its series answered 200 (or the probe could not run); `pkg.repo.status` never
  writes; every package name on the removal argv came from the package manager's own listing under a fixed glob.

## 53. Plugin pages in the account panel (`ui.pages[].audience`, `ctx.plugins.uiCatalog({ audience })`, `/api/panel/plugins`) (P2-1)
- **SDK (`plugins/sdk/validate-manifest.js`, `HOST_API_VERSION` 1.1.0):** `ui.pages[]` and `ctx.ui.registerPage()` descriptors take
  `audience: 'admin' | 'panel'` (`PAGE_AUDIENCES`); a missing key means `'admin'`, so every 1.0 manifest keeps its meaning and
  `engines.whm: "^1.0.0"` still satisfies the host. Only `PANEL_PAGE_KINDS = table | form | markdown | html` may be panel pages
  (`AUDIENCE_KIND`: settings and action pages drive root-only manage routes); a `ui.sidebar[]` entry may not point at a panel page
  (`AUDIENCE`: the admin sidebar is admin-only, the panel lists its pages itself). `manifest.schema.json` mirrors the enum.
- **Host (`server/src/services/plugins.js`):** `uiCatalog({ audience = 'admin' })` — admin: `[{ id, name, version, sidebar, pages }]`
  with only admin pages; panel: `[{ id, name, version, pages }]` with only panel pages, plugins without one omitted. `pageFile(id, rel,
  { audience = 'admin' })` only serves a file declared by a page of that audience (404 otherwise). `dispatch(id, req, res, { panel })`:
  with a panel scope the route must list the `'user'` role whoever the principal is (an administrator logged in as the account
  included; 403 `FORBIDDEN` otherwise) and the handler gets `req.panel = { username, accountId, domain, mode: 'user' | 'acting',
  actingAs: { by, expiresAt } | null }`; without a scope (the `/api/plugins/<id>` path) a role-user principal is refused outright, so
  `req.panel` is always present when `req.user.role === 'user'`. The mock host (`callRoute(method, path, { panel })`) does the same.
- **Routes (`server/src/routes/panel/plugins.js`, behind `panelScope`, feature `plugins`, no `panel:*` token scope — reads with
  `panel:read`, mutations session-only):** `GET /api/panel/plugins/ui` → the panel catalog; `GET /api/panel/plugins/ui/:id/file?path=`
  → `{ kind, content }`; `ANY /api/panel/plugins/:id/*` → `dispatch` with `req.panel`. 501 `capability_missing` without the host,
  403 `feature_disabled` when the plan turns `plugins` off (seeded `true`), 404 for a disabled plugin.
- **Client:** `panel/hooks/usePanelPlugins.js` (`PanelPluginProvider` in `PanelLayout`, enabled by `hasFeature('plugins')`;
  `panelPluginEntries` → function-like entries `{ key: 'panel-plugin:<id>:<route>', path: '/panel/plugins/<id><route>',
  categorySlug: 'software' }` appended to the Software group by `withPluginEntries` for the sidebar, the home grid and search),
  `panel/PanelPluginPage.jsx` on route `plugins/:pluginId/*` (reuses `pages/plugins/PluginPage.jsx`'s `PluginPageView` with
  `baseUrl=/panel/plugins/<id>` and `uiBase=/panel/plugins/ui`), nav function `panel:software/plugins` (`/panel/software/plugins`,
  feature `plugins`) listing every panel page per plugin. The admin shell is unchanged (`GET /api/plugins/ui` carries admin pages only).
- **Sample plugin:** `net.whm.sample-notes` ships `/my-notes` (`audience: 'panel'`, table over `GET /my-notes` with `roles: ['user']`,
  filtered by `req.panel.username`); the signed fixture was regenerated.
- **Invariants:** an admin page or an admin-only handler is never reachable through the panel scope; a panel handler never trusts a
  username from the request; a page's data and files come only from the panel endpoints, which never answer without a pinned account.
- Tests: `plugins/sdk/test/validate-manifest.test.js`, `plugins/sample-plugin/test/main.test.js`, `server/test/panel-plugins.test.js`,
  `client/test/panel-plugins.test.jsx`.

## 54. Customer panel: Optimize website and Hotlink protection (`ctx.panelHtaccess.optimize/hotlink`, agent grammar in `htaccess-web.js`) (P2-6)
Both are new fields of the one panel-managed `.htaccess` block of §47; nothing is stored in SQLite and no new agent op exists.
- **Agent** (`agent/src/ops/htaccess-web.js`, imported by `htaccess.js`): `blockSchema` gains `deflate: { types: [DEFLATE_TYPES…] ≥ 1 } | null`
  and `hotlink: { hosts: [hostname] 1..100, extensions: [HOTLINK_EXTENSIONS…] ≥ 1, allowBlank = true, redirect: url | null } | null`.
  `DEFLATE_TYPES` is the pinned MIME catalogue (HTML, plain/XML text, CSS, JavaScript, JSON, XML feeds, SVG, fonts — never
  images, video or archives); `HOTLINK_EXTENSIONS` the pinned extension catalogue (image, audio/video, pdf/zip/rar/7z — never a
  script extension). `renderBlock` emits, inside `<IfModule mod_deflate.c>`, `  AddOutputFilterByType DEFLATE <types>` (catalogue
  order, six per line) and, inside `<IfModule mod_rewrite.c>`, `  RewriteEngine On`, `  RewriteCond %{HTTP_REFERER} !^$` (only when
  `allowBlank`), one `  RewriteCond %{HTTP_REFERER} !^https?://(www\.)?<host with dots escaped>(:[0-9]+)?(/|$) [NC]` per host and
  `  RewriteRule \.(ext|…)$ - [F,NC,L]` or `  RewriteRule \.(ext|…)$ <redirect> [R=302,NC,L]`. The grammar (`WEB_GRAMMAR`, part of
  `validateBlock`) accepts exactly those lines: a host must round-trip through the escape, extensions must be catalogue members
  without repeats, the target is `-` for `F` and a `HOTLINK_REDIRECT` URL for `R=302`. `HOTLINK_REDIRECT` is `http(s)://<hostname>[:port][/path][?query]`
  over `[A-Za-z0-9._~!*'(),:@&=+;/-]` only — no whitespace, quote, backslash, `$`, `%`, `#` or brackets, so no back-reference, variable
  expansion or flag can be smuggled into the substitution — and a target whose path ends in a protected extension is refused
  (`redirectLoops`) so the redirect cannot loop. `parseBlock` reads the fields back; a rule without any host line counts as `foreign`.
  Hosts are stored as given (the service strips `www.`); the rule allows both forms.
- **Service** `ctx.panelHtaccess` (`services/panel-htaccess.js`, which now resolves paths with `path.posix`):
  `optimize.get(scope, { path })` → `{ path, domain, mode: off|all|custom, types, available, managed }`;
  `optimize.set(scope, { path, mode, types })` (feature `optimizews`, folder pinned by `resolveDir`, `custom` with no catalogue
  type → 422; audit `panel.optimize.set`). `hotlink.get(scope)` → `{ path: 'public_html', domain, enabled, hosts (extra only),
  extensions, allowBlank, redirect, domains (the account's own hostnames without www., main first), available, defaults, max, managed }`;
  `hotlink.set(scope, { enabled, hosts, extensions, allowBlank, redirect })` (feature `hotlink`; always `public_html`, so addon and
  subdomain folders inherit; the account's own domains from `ctx.panelDomains.allDomains` — main, addon, sub, parked — are always
  allowed and the body's `hosts` are the extras, `www.` stripped, deduplicated, 100 in all; `enabled` with no extension or a looping
  redirect → 422; audit `panel.hotlink.set` with counts, never the host list). Both write through the §47 `patch` → `files.htaccess.set`
  path with the loopback probe (`config_invalid` → 422, file restored). `service.constants` exposes the catalogues to the route.
- **Routes** (`routes/panel/advanced.js`, no token scope → mutations session-only): `GET /api/panel/advanced/optimize?path=`,
  `PUT /api/panel/advanced/optimize { path, mode, types? }`, `GET /api/panel/advanced/hotlink`, `PUT /api/panel/advanced/hotlink
  { enabled, hosts?, extensions?, allowBlank?, redirect? }` (hosts `fields.hostname`, extensions from the catalogue, redirect
  `HOTLINK_REDIRECT`).
- **Client:** `pages/panel/advanced/optimize-website.jsx` (FolderPicker, three modes, grouped type picker) and
  `pages/panel/advanced/hotlink-protection.jsx` (status, own domains, extra hosts, direct-request switch, grouped extensions, redirect);
  nav `advanced/optimize-website` (feature `optimizews`, new in `DEFAULT_FEATURES`) and `advanced/hotlink-protection` (feature `hotlink`,
  already seeded); keys `panel.advanced.*`.
- **Host:** `mod_deflate` and `mod_rewrite` enabled (Debian's default set has deflate; rewrite is what WordPress permalinks already
  need); both blocks are `IfModule`-guarded so a host without them serves the site unchanged. Verify with
  `curl -sI -H 'Accept-Encoding: gzip' https://<domain>/` → `Content-Encoding: gzip`, and an image with `-H 'Referer: https://evil.example/'`
  → 403 while the own referer → 200.
- Tests: `agent/test/files-htaccess-web.test.js`, `server/test/panel-htaccess-web.test.js`, `client/test/panel-htaccess-web.test.jsx`.

## 55. Customer panel: Dynamic DNS (`ctx.panelDdns`, public `GET /api/panel/dns/ddns/:token`) (P2-8)
A per-record credential that moves one A/AAAA record of the account's own zone to the caller's address without a
session. `services/panel-ddns.js` owns tokens and the public call; the record write goes through `ctx.dns.updateRecord`
with the account's `ownerPrincipal`, so the zone-editor rules (ownership, protected types, publish, `delegation`) apply.
- **Storage (migration `034e_panel-ddns.sql`):** `panel_ddns_tokens(id, account_id, zone_id, record_id, label, token_hash
  UNIQUE, last_ip, last_used_at, updates, created_at)` — every foreign key cascades, so a token dies with its record
  (zone rewrite, record deleted) or account. The token is `crypto.randomToken(32)` (43 base64url chars), stored as
  `crypto.hashToken` (SHA-256 hex), looked up by hash and confirmed with `constantTimeEqual`; the plain value leaves the
  server once, in the `create` answer.
- **Scoped routes (`routes/panel/ddns.js`, `panelRouter(ctx, 'dns')`, feature `ddns`, scope `panel:dns`):**
  `GET /api/panel/dns/ddns` → `{ tokens: [{ id, label, zone, recordId, name, host, type, value, lastIp, lastUsedAt,
  updates, createdAt }], zones: [{ domain, delegation, records: [{ id, name, type, value, host }] }], baseUrl, max }` (the
  zones come from `ctx.panelDns.zones`, `records` are the zone's A/AAAA rows only, `max` = 20 per account);
  `POST /api/panel/dns/ddns { domain: hostname, recordId, label?: ≤64 }` → 201 `{ token, secret, url, delegation }` —
  404 for a zone or record not of this account, 422 for a record that is not A/AAAA, 422 `not_delegated` when
  `delegation.delegatedHere === false` (a record written here would not be published), 409 `limit_reached` at 20;
  `DELETE /api/panel/dns/ddns/:id` → `{ revoked: true, id }`. Audit `panel.dns.ddns.create` / `panel.dns.ddns.revoke`.
  `POST` and `DELETE` are `sessionOnly` (403 `session_required` over an API token, as for `/panel/tokens`: a token never
  mints a credential that outlives it); `GET` stays readable with `panel:read`/`panel:dns`.
- **Public route (mounted before `requireAuth`, like `/panel/sso`; a `routes/panel/*.js` mount marked `public: true`
  is lifted to `/panel<path>` by `routes/categories/panel.js`):** `GET /api/panel/dns/ddns/:token[?ip=][&format=text]`,
  express-rate-limit 60 calls / 15 min per address, attached to the public handlers only (the scoped list/create/revoke
  share the prefix and are never counted). `GET /api/panel/dns/ddns/update[?ip=][&format=text]` is the same call with the
  token as the HTTP basic password, any user name (`routes/panel/ddns.js` `headerToken`), for clients that keep secrets
  out of paths; `update` cannot collide with a token (not 43 chars). Not `Bearer`: `attachUser` reads every Bearer
  header as an API token and answers 401 for an unknown one before the public mounts run. The pino request serializer
  redacts the token of both path forms (`app.js` `redactLoggedUrl`, also for `/panel/sso/:kind/:token`).
  The token must match `^[A-Za-z0-9_-]{43}$` and exist, else
  `404 token_unknown` (malformed, unknown and revoked look alike); a suspended account answers 423. `ip` is the
  query value or, absent that, `req.ip` with Node's `::ffff:` prefix stripped; it must be an IPv4 for an A record and an
  IPv6 for an AAAA record (`fields.ipv4` / `fields.ipv6`), else 422 with `fields.ip`. An unchanged value writes
  nothing (`changed:false`); otherwise `ctx.dns.updateRecord(domain, recordId, { value }, owner, req)` runs and the
  answer carries its `serial` and `applied`. Answer `{ zone, host, type, ip, changed, serial, applied }`, or with
  `format=text` the ddclient-style `good <ip>` / `nochg <ip>` line. `last_ip`/`last_used_at`/`updates` are kept per
  token; audit `panel.dns.ddns.update` (target = account username, args carry the caller address).
- **Client:** `pages/panel/dns/dynamic-dns.jsx` (nav `dns/dynamic-dns`, feature `ddns`, i18n `panel.ddns.*`): the
  token table with revoke, a create modal (zone → A/AAAA record → label; zones with `delegatedHere === false` are
  listed disabled) and the one-time URL modal with a cron example; a `DelegationBanner` per zone served elsewhere.
- **Invariants:** no session, cookie or CSRF on the public call — the token is the whole credential and it is never
  echoed by any listing; the write path is the zone editor's (NS/SOA stay unreachable because only A/AAAA rows can be
  bound); a zone whose public DNS is elsewhere never gets a token; the rate limiter is per caller address and separate
  from the login limiter.

## 56. Customer panel: Virus scanner (`ctx.panelVirus`, agent `sec.clamav.scan_as`) (P2-9)
- **Agent** (`agent/src/ops/sec-clamav-as.js`, its own family file so `sec.js` never imports `as-user.js`):
  `sec.clamav.scan_as { username, path, maxDurationSec ≤ 900 }` → `accountPath()` (home from `/etc/passwd`, lexical + real
  containment, allowed roots) then `clamdscan --fdpass --no-summary --infected --stdout -- <real path>` through `asUser()`
  (`setpriv`/`runuser`, `nice -n 10`), so the account opens every file itself and clamd scans by descriptor: nothing the
  account cannot read is scanned and a planted symlink reaches only what the account may already reach. `timeoutMs`
  15 min at the op (`CLAMAV_AS_TIMEOUT_MS`) and the exec; a timeout is `OpError('timeout')`. Output parsed with
  `parseClamscanOutput` (`FOUND` / `ERROR` lines kept apart); exit 2 with nothing parsed → `capability_missing` when clamd
  is not reachable, `not_found` for a missing path, else `command_failed`. Returns
  `{ username, home, path, infected: [{ file, signature }], errors: [{ file, error }], exitCode, durationMs }`.
- **Service** `ctx.panelVirus` (`services/panel-virus.js`, created by `routes/panel/virus.js`, feature `virusscan`):
  `status(scope, req)` → `{ scanner: { installed, version, signatures, databaseAgeSec } (sec.clamav.detect; absent agent
  op → installed:false), scopes, active, history }`; `start(scope, { scope: 'home' | 'mail' | 'public_html' }, req)` pins
  the folder under `account.home_dir` (`targetOf`, 422 otherwise), `501 CapabilityError('clamav')` without the engine,
  `409 scan_running` (fields.job) while this account has a `panel.clamav.scan` job queued or running, then enqueues
  `panel.clamav.scan { accountId, username, ownerId, actor, scope, path, rel }` (audit `panel.clamav.scan`). The job
  (`run`) acts for the owner read back at run time (`jobScope`, as WordPress), re-derives the path from the account row,
  calls `sec.clamav.scan_as` with a 15 min + 30 s client timeout, logs each finding, and returns
  `{ scope, path, infected: [{ file (relative to the home), signature }], errors, exitCode, durationMs, finishedAt }`
  (audit `.done` / `.failed`). `removeInfected(scope, { paths }, req)` delegates to `ctx.panelFiles.remove` (its pinning,
  `.ssh` guard, `filemanager` gate and audit) and audits `panel.clamav.remove`. `getJob/streamJob/history` restricted to
  `JOB_TYPES` with `params.accountId === scope.accountId`; `shapeJob` strips `ownerId`, `accountId` and the absolute `path`.
- **Routes** (`/api/panel/virus-scanner`, `panelRouter(ctx, 'virus-scanner')` — no token scope, mutations session-only):
  `GET /`, `POST /scans` (202), `GET /scans/:id[/stream]`, `POST /infected/remove { paths: relPath[1..200] }`.
- **Shared edits:** `DEFAULT_FEATURES.virusscan = true` (+ FeatureManager label), nav *Security › Virus scanner*
  (`slug: 'virus-scanner'`, phase 2), `panel.security/virus-scanner.*` + `panel.virus.*` in `en.json`.
- **Host:** `clamav-daemon` running with its socket reachable by account users (Debian default `LocalSocketMode 666`,
  `/var/run/clamav/clamd.ctl`) and a signature database fetched by `freshclam`; `setpriv` (present). Not changed: the
  root-side `sec.clamav.scan/targets` ops used by the ImunifyAV plugin.

## 57. Customer panel: upload transport — raw chunks by index, resume from the received list (P2-11)
- **Replaces** the JSON `PUT /api/panel/files/uploads/:id/chunks { data: <base64> }` appender (no other caller used it;
  the backups and transfers upload routes keep their own JSON chunk bodies and are not touched).
- **Begin** `POST /api/panel/files/uploads { path, name, size, overwrite }` → `201 { id, path, name, size, received, chunks,
  chunkBytes, chunkCount, receivedChunks: [], expiresAt }`. `chunkBytes` is **pinned per upload** when it begins
  (`panel.upload_chunk_bytes`, default 1,310,720, clamped to 1 KiB … `MAX_CHUNK_BYTES` = 2 MiB so the base64 form stays
  under the agent's 3 MiB `chunk_write` bound); `chunkCount = ceil(size / chunkBytes)`. Chunk *i* is the bytes
  `[i·chunkBytes, min((i+1)·chunkBytes, size))`.
- **Chunk** `PUT /api/panel/files/uploads/:id/chunks/:index` with `Content-Type: application/octet-stream` and the raw bytes
  (`express.raw`, limit `MAX_CHUNK_BYTES` → `413 too_large` past it; any other content type → `415 unsupported_media_type`;
  empty body, an index ≥ `chunkCount` or a length other than the chunk's → `422`). The server writes it at its offset as
  the account (`files.chunk_write { offset, truncate }`: the first chunk written truncates the file to its offset, every
  later one keeps the rest, so chunks arrive in any order) and answers the status shape with `receivedChunks` (sorted
  indices) and `received` (bytes). A chunk sent twice (a retry whose first answer was lost) is written again and counted
  once. `req.body` is replaced by `{}` before the response so the automatic audit row carries `<id>/<index>` as target and
  no args. Quota stays the kernel's verdict (a failed `dd` surfaces as the agent error).
- **Resume** `GET /api/panel/files/uploads/:id` → the same shape; the client sends `missingChunks(chunkCount,
  receivedChunks)` and nothing else. **Finish** `POST …/finish` needs every chunk (`422` with the first missing indices in
  `fields.data`), audits `panel.files.upload { path, bytes, chunks }` once; **abort** removes the part if anything was
  written.
- **Client** (`files/parts/UploadModal.jsx`): `uploadFile()` sends chunks sequentially with `api.putRaw` (`api.sendRaw(method,…)`
  in `api/client.js`); a transport failure (fetch rejected, 408/429/502/503/504) waits `RESUME_DELAYS_MS` (1 s … 30 s, 8
  tries), re-reads the status and continues with what is missing; any other error aborts. Drag-and-drop: the file list
  (`fm-droptarget`, `filesOfDrop()` keeps files, counts folders) and the upload dialog both accept a drop; folders are
  reported, never uploaded. No new page: the transport ships under the existing *Files › File manager* nav entry and the
  `filemanager` feature; i18n keys `panel.files.drop_here|drop_to_upload|upload_reconnecting|folders_skipped_one|_other`.
- **Agent:** `files.chunk_write` gains `offset` (int ≥ 0, default 0); argv `dd of=<target> bs=1M seek=<offset>
  oflag=seek_bytes [conv=notrunc] status=none` (`chunkWriteArgv`), GNU coreutils ≥ 8.20. No host step.
- Tests: `server/test/panel-files.test.js` (uploads), `client/test/panel-upload-transport.test.jsx`,
  `agent/test/files.test.js` (offset schema + argv).

## 58. Customer panel: quota source note on the Usage page (P2-13)
- **No new route, op, migration, nav entry or feature flag.** `GET /api/panel/usage` is unchanged: `disk.source` is
  `'repquota'` when the quota capability answered for the account, else `'scan'`, and `disk.lastRefresh` is the
  server-wide `account_info.disk_refreshed_at` setting (ISO string, SQLite `YYYY-MM-DD HH:MM:SS` or `null`). The page
  ships under the existing *Usage › Usage* entry and the `usage` feature.
- **Client (`client/src/pages/panel/usage/usage.jsx`):** `scanAge(lastRefresh, now)` → `null` without a parsable
  timestamp, else `{ ms, tone }` with `tone` `ok` under 24 h (`SCAN_STALE_MS`), `warn` from 24 h, `bad` from 7 days
  (`SCAN_OLD_MS`); `ageLabel(ms, t)` renders *just now / {n} minutes ago / {n} hours ago / {n} days ago*.
  `ScanSourceNote({ disk, now, t })` renders nothing when `disk.source !== 'scan'`; otherwise a kit banner above the stat
  grid (`data-scan-source="ok|warn|bad|never"`): `banner-info` + `role="status"` for a fresh scan, `banner-warning` +
  `role="alert"` with the *Refresh figures* hint when stale or when there was never a scan (then the disk value is
  called out as the plan figure, not a measurement). The disk tile's note becomes *From the last scan, {age}*.
- i18n keys `panel.usage.age_just_now|age_minutes|age_hours|age_days`, `panel.usage.scan_source_title|scan_source_text|
  scan_source_never|scan_source_never_text|scan_source_hint`. Tests: `client/test/panel-usage-scan-note.test.jsx`.

## 59. Customer panel: wording and accessibility (`PLAN_SETTING_CODES`, `panel/Meter.jsx`, menu/tabs ARIA, https home links) (P2-12)

- **Plan-setting errors by code, not status.** `client/src/panel/PanelPage.jsx` exports `PLAN_SETTING_CODES`
  (`shell_disabled`, `feature_disabled`, `plan_disabled`), `isPlanSettingError(error)` and `isCapabilityError(error)` (501 /
  `capability_missing` / `binary_not_found` **minus** the plan codes). `PanelCapabilityState` renders a plan code as
  *Not included in your plan* (`panel.shell.feature_disabled_title`, the server's `message`, `feature_disabled_help`) and
  only a real capability error as *Not available on this server*. A server route that refuses because of a plan setting
  keeps its status (`501 shell_disabled` from `routes/panel/security.js`) but must use one of the listed codes; a new plan
  code is added to `PLAN_SETTING_CODES`, never matched by status.
- **Meters.** `client/src/panel/Meter.jsx` exports `Meter({ percent, label, text, name, tone, style })`: `role="progressbar"`
  with `aria-valuemin/max/now` (clamped 0–100, rounded), `aria-valuetext` = the figure shown and `aria-label` =
  `panel.shell.meter_value` (`{label}: {text}`); with `percent == null` it is `aria-hidden`. Every panel bar goes through it
  (`PanelHome.UsageMeters`, `usage/usage.jsx` `Meter` → `Stat` passes `label` and `value + sub`, `email/accounts.jsx` quota and
  plan meters). `.meter` markup (`<div class="meter tone"><span style="width:n%">`) and `data-meter` are unchanged.
- **User menu.** `PanelTopBar.jsx`: the button carries `aria-haspopup="menu"`, `aria-expanded`, `aria-controls="panel-user-menu"`
  and `aria-label` (`panel.shell.user_menu`); the popup is `role="menu"` `id="panel-user-menu"` `aria-labelledby`, every entry
  `role="menuitem"` (the meta row is `presentation`); while open, **Escape** closes and refocuses the button, `mousedown` /
  `touchstart` outside the `.menu` closes. The `onMouseLeave` close is gone.
- **Domain tabs.** `domains/domains.jsx`: the segmented filter is `role="tablist"` (`aria-label` `panel.domains.filter_label`),
  each button `role="tab"` `id="panel-domains-tab-<key>"` `aria-controls="panel-domains-list"` with roving `tabIndex` and
  ArrowLeft/ArrowRight; the table sits in `<div id="panel-domains-list" role="tabpanel" aria-labelledby=…>`.
- **https home links.** `Meter.jsx` exports `sslLive(ssl)` (`installed && state !== 'stored' && !expired && (daysRemaining == null
  || > 0)`) and `siteUrl(domain, ssl)`. `PanelHome` loads `GET /api/panel/domains` (the list the Domains page uses; not gated by
  `sslmanager`) and hands `DomainsList` a `{ [domain]: rows[].ssl }` map; the link is `https://<domain>` when live, else `http://`.
  The decision uses that endpoint rather than `/ssl/domains` because it needs no plan feature and already carries the trimmed
  certificate per hostname.
- i18n keys `panel.shell.meter_value`, `panel.shell.user_menu`, `panel.domains.filter_label`. No route, migration, nav entry or
  feature flag. Tests: `client/test/panel-a11y.test.jsx`, additions in `panel-layout.test.js`, `panel-overview.test.js`;
  `e2e/panel-check.cjs` step 3c (menu roles + Escape + click-outside, progressbars, `aria-controls`, https link vs the API's `ssl`).


## 60. Customer panel: Track DNS (`ctx.panelDnsTrack`, agent `dns.lookup` / `dns.trace`) (P2-7)
Two read-only probes run on this server for the account: a record lookup with `dig` and a route trace with
`traceroute`. Nothing is written and nothing is scoped to the account's own zones (any public name may be looked up, as in
cPanel's Track DNS); the only caller input is one name or address, pinned by three schemas in a row (route, agent op,
`exec` argv) so it can never become an option or a shell token. A literal address must be public (`isPublicAddress` in
`services/panel-dns-track.js`, mirrored in the agent op): loopback, unspecified, 10/8, 172.16/12, 192.168/16, 100.64/10,
169.254/16, 224/4, 240/4, ::1, fc00::/7, fe80::/10, ff00::/8 and the v4-mapped forms answer 422, and the agent also refuses
the bare label `localhost`, so the host is never used to map its own network or probe a metadata endpoint.
- **Agent ops (`agent/src/ops/dns-track.js`):** `dns.lookup { name: hostname | IPv6, type: A|AAAA|MX|NS|TXT|CNAME|SOA|PTR =
  'A' }` runs `dig +short +time=3 +tries=1 <name> <type>` (for `PTR` with a literal address: `dig +short +time=3 +tries=1
  -x <ip>`), 15 s cap, `allowFailure`, → `{ name, type, answers: [line], notes: [';;' diagnostics], error: null | 'timeout' |
  'failed', exitCode, output }`. `dns.trace { host: hostname | IPv6 }` runs `traceroute -n -w 2 -m 20 <host>`, 60 s cap, →
  `{ host, header, target: ip | null, hops: [{ hop, address, addresses[], rtts[ms], timeouts }], reached, error: null |
  'unknown_host' | 'timeout' | 'failed', exitCode, output }`; a run killed by the cap answers `error: 'timeout'` with no
  hops instead of throwing. A missing program throws `capability_missing` with `details.package` = `dnsutils` /
  `traceroute` (the hint the operator installs; `bind-utils` on RHEL). The agent hostname regex refuses a leading `-`,
  spaces, `/`, upper case and anything over 253 characters; an IPv4 matches it, an IPv6 goes through `arg.ipv6`.
- **Service (`services/panel-dns-track.js`, `ctx.panelDnsTrack`):** `lookup(scope, { name, type }, req)` → `{ name, type,
  answers, notes, error, checkedAt }`; `trace(scope, { host }, req)` → `{ host, target, hops, reached, error, output,
  checkedAt }`. Both require the scope (`panel_scope_required` 403) and feature `traceroute` (403 `feature_disabled`;
  seeded `true` in the default list). One trace at a time per account: a second call while one runs answers
  `409 busy`. An agent `capability_missing` / `binary_not_found` becomes `CapabilityError(<package>)` (501, `capability`
  = `dnsutils` or `traceroute`).
- **Routes (`routes/panel/dns-track.js`, `panelRouter(ctx, 'dns')`, scope `panel:dns`, reads so `panel:read` tokens pass):**
  `GET /api/panel/dns/track/lookup?name=&type=` and `GET /api/panel/dns/track/trace?host=`; `name` / `host` must be
  `fields.hostname` (lower-cased, at least one dot) or `fields.ip`, `type` one of the eight; anything else is 422
  `validation_failed` with `fields.name` / `fields.host` / `fields.type` before the agent is called. No audit rows: nothing
  changes.
- **Client (`pages/panel/dns/track.jsx`, nav `dns/track`, feature `traceroute`, i18n `panel.dnstrack.*`):** two cards
  (*Domain lookup*: name defaulted to the account's main domain + type select; *Trace route*: host), results as tables
  (`data-lookup="<name>"` / `data-trace="<host>"`), 501 → `PanelCapabilityState`, 403 `feature_disabled` →
  `FeatureDisabledState`, other errors in `ErrorBanner`. Exports `LookupResult`, `TraceResult`, `isTarget`, `LOOKUP_TYPES`.
- **Invariants:** no shell, a pinned argv with the target as the last element (after `-x` for reverse lookups), no name
  ever starts with `-`; read-only, no DB access; the feature gate and the panel scope stay in front of every call; the
  60 s trace cap is the agent's, the API waits 65 s for it. Tests: `agent/test/dns-track.test.js` (schemas refuse
  injection before `exec`, argv pinning, parsers, capability hint), `server/test/panel-dns-track.test.js` (422 on
  injection, feature gate, 501 with the package capability, 409 busy, shapes), `client/test/panel-dns-track.test.jsx`
  (nav/feature/catalogue, forms, result tables, 501/403 states). Host packages: `dnsutils`, `traceroute`.
## 61. Customer panel: Database wizard (`pages/panel/databases/wizard.jsx` over `ctx.panelDatabases`) (P2-4)
A guided three-step page, client-side only: it composes the existing panel database calls and adds no route, service
method, migration or agent op. Every step is a real write, so a run abandoned after step 1 or 2 leaves a database (and a
user) that the Databases / Database users pages manage as usual — the wizard never holds unsaved state across a reload.
- **Step 1 (database):** `POST /api/panel/databases { name, charset? }` (MySQL only shows the charset; PostgreSQL sends
  the name alone) → `201 { name }`. The page reads `GET /api/panel/databases` for `meta.prefix`, `meta.engine` and
  `meta.quota` and applies the Databases page rules (`quotaOf`): `max === 0` → "not included", `used >= max` → the form
  is disabled with the plan notice, 501 → `PanelCapabilityState` above the form, 403 `feature_disabled` →
  `FeatureDisabledState`.
- **Step 2 (user):** `POST /api/panel/databases/users { name, password }` → `201 { name, hosts, grants: [] }`. The name
  is prefilled with the short database name; the password must reach `passwordStrength ≥ 65` as on the users page and is
  never kept after the call. No `databases` array is sent: access is granted in step 3 so the customer sees and may trim
  it. A link to Database users lets the customer leave here and attach an existing user instead.
- **Step 3 (grants):** `PUT /api/panel/databases/users/:user/grants { grants: toPayload(matrix) }` with the
  `PrivilegeGrid` of `parts/GrantsEditor.jsx` over a one-column matrix (`initialMatrix(database)` = `ALL PRIVILEGES`
  ticked; the engine's privilege list from `parts/shared.jsx`). An empty set sends `grants: []` ("Finish without
  access"). The answer's `changes` count is toasted.
- **Done:** a `KeyValue` card with database, user, host `localhost` and the privilege summary (`summarizePrivileges`),
  plus "Create another" (resets every field) and links to the two management pages.
- **Nav / feature / i18n:** `databases/wizard` (`panel:databases/wizard`, label *Database wizard*) with plan feature
  `dbwizard` (seeded `true` in `DEFAULT_FEATURES`; it only hides the entry — the API calls stay gated by `mysql` /
  `postgres` as before, so a plan without databases still answers 403 here). Keys `panel.databases/wizard.*` and
  `panel.databases.wizard_*`; shared strings reuse the `panel.databases.*` keys of the other pages.
- **Invariants:** nothing on this page bypasses the per-call checks of `panel-databases.js` (prefixing, ownership of the
  database named in the grants, plan limits, audit rows `panel.db.create` / `panel.db.user.create` /
  `panel.db.grants`); the wizard sends only names the server already returned. Tests:
  `client/test/panel-database-wizard.test.jsx` (nav/feature/catalogue, the three states of step 1, 501/403, helpers).

## 62. Customer panel: Errors page (`ctx.panelLogs.errors`, `GET /api/panel/logs/errors`) (P2-5)
No new agent op, table or setting: the page is a second reader over the listing and range read that the Access logs tail
already uses (§4.11 of the customer-panel design).
- **Service:** `ctx.panelLogs.errors(scope, { lines = 300, domain = null }, req)` → `{ lines, domain, domains, files, warnings,
  apache, nginx }`; `files: [{ name, kind: 'apache'|'nginx', domain | null, location: 'server'|'home', size, mtime,
  lines: [string… newest first], truncated }]`, newest `mtime` first. The feature is `errlog` (not `rawlog`: cPanel gates the
  Errors page separately). Both web servers are listed through the existing `listing(scope, kind)`; an absent NGINX
  (`CapabilityError`) is skipped and reported as `nginx: false`, never as an error. A file qualifies when its name matches
  `ERROR_LOG` = `/[._-](ssl[._-]?)?error(_log|\.log)?$/i` — the live log only, never a rotated `.1` or archived `.gz` copy — and
  its `domain` is the longest own hostname whose `domainLogFile` pattern matches (null for a file under `~/logs`). The
  range read per file is `min(MAX_TAIL_BYTES, max(64 KiB, lines × 256))` bytes from the end through the same `acct.read_range`
  with the account as owner; `lines` is capped at `ERRORS_MAX_LINES` (1000); `truncated` is true when the read started
  inside the file or more lines were read than returned. `domain` must be one of the account's own hostnames (404 otherwise).
- **Route:** `GET /api/panel/logs/errors?lines=1..1000&domain=` (`fields.domain`, optional), 403 `feature_disabled`,
  501 when no web server is installed at all (the Apache listing's own capability error passes through).
- **Client:** `pages/panel/logs/errors.jsx` (key `panel:logs/errors`, nav *Logs › Errors*, feature `errlog`): domain filter,
  100/300/500/1000 lines, follow every 10 s, one card per file with the lines newest first. Keys `panel.logs/errors.*` and
  `panel.logs.errors_*`; shared strings reuse `panel.logs.*`.
- Tests: `server/test/panel-logs-errors.test.js`, `client/test/panel-logs-errors.test.jsx`.

## 63. Critical updates (`ctx.software.updates.critical`, `software.php.update`, `software.runtime.update`, agent `pkg.php.release` / `pkg.node.release`)
One list feeds the admin Home banner, the PHP Version Manager rows, Install Software and the Security Advisor's PHP
findings, so every page agrees on what needs an update and what runs when the operator presses **Update**.
- **Service:** `ctx.software.updates.critical({ versions?, fresh? })` → `{ checkedAt, packagesCheckedAt, items }`, root only
  (the routes), cached in memory for 10 minutes (`fresh: true` recomputes; `updates.invalidate()` drops the cache, which
  every update job does when it finishes). It never throws: each probe is isolated and a failure only costs its items.
  `items[]` = `{ kind: 'php'|'runtime'|'tool'|'package', id, label, current, candidate, severity: 'critical'|'security'|'update',
  reasons: string[], packages: string[], action: { method: 'POST', path, body } | null }` sorted critical → security →
  update, then by label; PHP items also carry `layout` and `unit`. Sources:
  1. **PHP advisories** — every installed version from `php.versions()` (or the `versions` the caller already fetched) with
     its `advisories` from `ctx.security.phpAdvisories.forVersion`, minus the ones the last advisor run reported as
     `php.advisory.<id>.backported` for that version. A `critical` grade (= advisory severity critical/high) gives severity
     `critical`, any other advisory `security`. `candidate` is the pending package candidate of the version's
     `packagePrefix` (below) or, for a Keel build (`layout: 'keel'`), the newest php.net release of that minor when it is
     newer than `version`; without either the item stays with `candidate: null, action: null` ("no fix available yet").
  2. **Pending package updates** from the cached OS update check (setting `software.updates.last_check`, written by the
     `os-update-check` schedule, System Update runs and these jobs): matched by `packagePrefix` to PHP versions, by
     `packagesFor(entry, family)` to the catalog runtimes (PHP excluded, Node.js never packaged) and tools, and by prefix to
     the web stack (`apache2`/`httpd`, `nginx`, `exim4`, `dovecot-*`, `mariadb-*`, `mysql-server`, `postgresql-*`,
     `pure-ftpd`, `proftpd`, `openssl` — `kind: 'package'`, action `POST /software/update/run { packages, dist: false,
     refreshIndex: false }`). `security: true` on any hit → `security`, else `update`. Nothing is simulated on a page load:
     without a recorded check there are no package items (`packagesCheckedAt: null`).
  3. **Keel Node builds** — every major from `pkg.node.list` whose nodejs.org latest (`pkg.node.release`) is newer →
     `kind: 'runtime', id: 'nodejs:<major>'`, severity `update`.
  Release lookups are cached six hours in the settings `software.php.releases` / `software.node.releases`
  (`{ [minor|major]: { version, sha256, file, at } }`); a failed lookup serves the stale entry.
  `updates.rowUpdate(list, kind, id)` → `{ candidate, severity, reasons, current, source, checkedAt } | null` is what the
  catalogs attach: `GET /api/software/php/catalog` rows and `GET /api/software/runtimes` runtime/tool rows gain `update`
  (null when nothing is pending or the row is not installed).
  **Amendment (always-visible update state, 2026-11-06):** every item carries `source: 'package' | 'release' | null`
  (pending packages / an upstream php.net or nodejs.org release / an advisory with nothing newer) and the list carries
  `releasesCheckedAt` (the newest release-cache entry consulted this round, null when no Keel build or Node major asked
  upstream). `rowUpdate` adds `current` and `checkedAt` (`packagesCheckedAt` for a package source, `releasesCheckedAt` for a
  release, else `checkedAt`). Both catalogs carry a top-level `updates: { checkedAt, packagesCheckedAt, releasesCheckedAt }
  | null` (`updates.stamp(list)`), so a row with `update: null` is rendered as *Up to date* as of those times instead of
  showing nothing: the PHP Version Manager and Install Software PHP rows have an **Updates** column (*Checking…* until
  the catalog has `updates`; *Up to date · <version>* + *Distribution packages · checked …* for a package row; *Latest
  php.net release · checked …* for a Keel build whose patch equals php.net's latest — no rebuild is offered then;
  *Update available: x.y.z* / *Security update* + **Update**; *Advisory · no fix available yet*). `updates.refresh()`
  (`POST …/updates/critical/refresh`, the pages' **Check for updates**) now forces the php.net / nodejs.org lookups past
  their six-hour cache (`critical({ fresh: true, releases: true })`) and re-records the OS update simulation
  (`pkg.upgradable`, no index refresh) when `software.updates.last_check` is older than six hours; `critical({ fresh:
  true })` alone (the Security Advisor, `php.update`) keeps the release cache. The client helpers live in
  `pages/fn/software/multiphp-manager.jsx` (`updateState`, `PhpUpdateCell`, `phpUpdateBody`, `phpUpdateMessage`,
  `checkForUpdates`) and Install Software renders its PHP card itself (`PhpCard`), handing the other runtimes to
  `RuntimeInstaller({ only })`.
- **Routes:** `GET /api/software/updates/critical` (requireRoot) → the list; `POST …/updates/critical/refresh` recomputes
  it. `POST /api/software/php/update { version }` (requireRoot, `phpVersionId`) → `202 { job, version, candidate, method:
  'package'|'source' }`, job `software.php.update`; `422` when the version is not installed, has nothing pending, or is
  affected with no candidate. `POST /api/software/runtimes/update { runtime, version? } | { tool }` (requireRoot, catalog
  enum, no `method`) → `202 { job, target, packages, method: 'package'|'node' }`, job `software.runtime.update`; `422` for
  `runtime: 'php'` (PHP goes through `/php/update`), a Node.js major not under `/opt/keel/node`, or packages none of which
  is installed. Audit `software.php.update { from, to, method, packages, jobId }` and `software.runtime.update`.
- **Amendment 2026-11-06 (the PHP version updater: a packaged minor with an advisory no package fixes is updated from
  php.net by a source build; §52 amendment of the same date for the discovery precedence):**
  - *`critical()` PHP items* carry `method: 'package' | 'source' | null` and `build: boolean | null` (null without a
    candidate). A packaged version (`layout` ≠ `keel`) with an open advisory and NO pending package of its prefix, whose
    minor is in `PHP_SOURCE_MINORS`, asks php.net (`releaseFor('php', minor)`, same six-hour cache) and, when that release
    is newer than the installed one, becomes `{ candidate: '<release>', severity: 'critical' | 'security', source:
    'release', method: 'source', build: true, reasons: [...advisories, 'php.net released x.y.z; no distribution package
    carries a fix, so it is built from source'] }`; without a newer release it stays `candidate: null` ("Advisory · no fix
    available yet"). A Keel build whose minor still carries `packagedTwin` (§52) and whose domains were never re-rendered
    on it (setting `software.php.keel_resynced[minor].version` ≠ the build's version) is listed with `candidate` = its own
    version, `severity: 'update'`, `method: 'source'`, `build: false` — the update is the resync alone; once php.net is
    newer the item is the rebuild (`build: true`) as before. `rowUpdate` passes `method` and `build` through.
  - *`php.update(version)`* → `{ job, version, candidate, method, build }`; job `software.php.update { …, method, build,
    family? }`. `method: 'source'` runs: (`build`) `pkg.install { packages: PHP_BUILD_DEPS[family] }` → `pkg.php.build {
    minor }` → `pkg.php.build.finish { minor }` (the unit must come back) → `capabilities.refresh()` → `pkg.php.versions`
    (the minor MUST now resolve to `layout: 'keel'`, else the job fails before any domain moves) → `php.resyncMinor`:
    every domain pinned to the minor (`account_domains.php_version`, suspended accounts excluded) plus the inherited ones
    when the minor is the effective default, through `applyPhpToDomains` (`ctx.web.setPhpVersion`, Apache reloaded after
    the last), then the hostname site through `ctx.web.hostApps.resyncPhpDefault(effectiveDefault)` when it runs on the
    minor (`php.hostAppsPhpVersion`) or the minor is the default → setting `software.php.keel_resynced[minor] = { version,
    at }` → re-detect and log the new `PHP_VERSION`. Result adds `build` and `resync: { domains, pinned, inherited,
    applied, failed, host }`; a resync in which no domain could be moved fails the job. The package method is unchanged.
    Without a package manager for the build dependencies the request is `422`. Audit args add `build`.
  - *Client* (`updateState` → `{ kind, candidate, reasons, method, build, checkedAt }`): the Updates column reads
    *Security update · x.y.z from php.net* + red **Update** (`phpUpdateDanger`: critical or security) for a source
    candidate driven by an advisory, *Update available: x.y.z from php.net* for a plain Keel rebuild, *Move domains to the
    Keel build x.y.z* for the resync-only item, *Advisory · no fix available yet* only without a candidate, *Up to date*
    otherwise — so the advisory badge ("update to x.y.z") and the column never contradict. The confirm for a packaged row
    (`phpUpdateMessage`, button "Build and update") says the build replaces the packaged version for every domain on the
    minor and the hostname site, takes about 15 minutes, and that the packages stay installed; a row with
    `packagedTwin` shows the packages note and a **Remove packages** action (`phpRemovePackagesBody` → `POST
    /software/php/remove { version, packages: true, force? }`, same refused-extras flow as Remove).
- **Job `software.php.update`** (params `{ version, layout, candidate, current, packages, unit, method }`), in order:
  `method: 'package'` → `pkg.upgrade { packages, dist: false }` through `runLongOp` (apt `install --only-upgrade` / dnf
  `upgrade` of exactly those names), `svc.reload { unit }` of the version's FPM unit (a failure is logged, not fatal),
  `pkg.upgradable` recorded as the new cached check (so the banner drops the packages at once); `method: 'source'` →
  `pkg.php.build { minor }` (the build dir is separate; `make install` over the existing prefix) then
  `pkg.php.build.finish { minor }`, which **restarts** the already registered unit (`restarted: true`) instead of
  `enable --now`, failing the job when the unit does not come back. Then `capabilities.refresh()`, `pkg.php.versions` to
  log the new `PHP_VERSION`, `updates.invalidate()`. Result `{ version, layout, method, from, to, candidate, packages,
  restarted, updated: true }`.
- **Job `software.runtime.update`** (params `{ kind, key, version, family, packages, major }`): `nodejs` →
  `pkg.node.install { major }` (atomic tree swap, the panel's own node untouched); packages → `pkg.upgrade { packages,
  dist: false }` + recorded `pkg.upgradable`; then `capabilities.refresh()`, `pkg.runtime.detect` for a runtime,
  `updates.invalidate()`. Result `{ kind, runtime|tool, version, packages, updated: true, detected, method }`.
- **Agent:** `pkg.php.release { minor }` → `{ minor, version, filename, sha256 }` (php.net JSON index over https,
  `parsePhpRelease`); `pkg.node.release { major }` → `{ major, arch, version, file, sha256 }` (SHASUMS256 of
  `latest-v<major>.x`, `pickNodeTarball`); both read-only, 2-minute budget, same schemas as the installers.
  `pkg.php.build.finish` decides from the unit's state, not its file: a `keel-php<minor>-fpm` that is active before the
  op is `systemctl restart`ed (`restarted: true`); one that is not running — the file exists but its first `enable --now`
  failed, or the admin stopped or disabled it — gets `enable --now` as on a first install. The result carries `enabled`
  (from `systemctl is-enabled`) beside `active`. A rebuild over a live prefix (`php-build.sh`) keeps `.keel-build-ok`, so
  the running version stays listed by `pkg.php.versions` / `phpLayout` for the whole build and after a failed one (only a
  prefix the run created is removed), and it never rewrites `lib/php.ini` or `lib/conf.d/10-opcache.ini` once they exist
  — the operator's INI edits survive an update; `etc/php-fpm.conf` and `keel-idle.conf` stay panel-owned and are
  regenerated.
- **Security Advisor:** the PHP probe calls `critical({ versions, fresh: true })` after `markDistroBackports`; an open hit
  with a candidate gets `candidate` on its `versions[]` entry and the finding gains `actions: [{ label: 'Update PHP x.y to
  <candidate>', path: '/software/php/update', body: { version } }]`. `FindingRow` renders `actions` generically (one button
  per entry, confirm, job panel), so other findings may carry actions later.
- **Client:** `pages/home/UpdatesBanner.jsx` (`UpdatesBanner({ kinds?, title?, subtitle? })`, root only, hidden while
  empty) on the admin Home and, narrowed by kind, above the Runtimes (`php`, `runtime`) and Tools (`tool`) tabs of Install
  Software; `updateRequest(item)` → `[path, body]` is exactly the server's `action`. PHP Version Manager rows render
  **Update to <candidate>** / *no fix available yet* from `row.update`.
- Tests: `server/test/software.test.js` ("Critical updates and direct Update buttons"), `server/test/security-center.test.js`
  (advisory actions), `agent/test/pkg-runtime.test.js` (release ops, finish restart), `client/test/home-updates.test.jsx`,
  `client/test/install-software.test.jsx`, `client/test/security-advisor.test.jsx`.
## 64. Customer panel: Git Version Control (`ctx.panelGit`, agent `git.*`, `.keel.yml` deployment) (P3-1)
Repositories live under the account home (`~/repositories/<name>` by default or any home-relative folder) and are
rows of `panel_git_repos` (migration `034f_panel-git-apps.sql`, shared with P3-2: `account_id, name, dir, url,
created_at, last_pull_at, last_deploy_at`, unique `(account_id, name)` and `(account_id, dir)`). Feature
`gitversioncontrol` (seeded on). Nav *Files › Git version control* (`panel:files/git`, slug `git`).
- **Agent ops (`agent/src/ops/git.js`, no `lib.js` import):** every command runs as the account through
  `as-user.js` (`asUser` → `setpriv`/`runuser`) with `GIT_ENV` = `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_ASKPASS=/bin/true`, `GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'` and the
  `GIT_CONFIG_*` triple `protocol.allow=never`, `protocol.https.allow=always`, `protocol.ssh.allow=always`
  (submodules included). `dir`/`root` are absolute paths pinned by `accountPath` (lexically and through symlinks,
  `protectSshDir` on every writing op); the home itself and a symlinked directory are refused.
  `git.init { username, dir }` (mkdir -p + `git init`, `exists` when `.git` is there) → info; `git.clone { username,
  dir, url }` (`gitUrl`: `https://host[:port]/path`, `ssh://git@host[:port]/path`, `git@host:path`, no other
  userinfo, no `file:`/`ext::`/`http:`, no `..`, ≤ 512; dir must not exist; `git clone -- url dir`, 15 min; a failed
  clone removes the partial dir and maps to `refused` (credentials wanted), `not_found` (no such repository / host)
  or `command_failed` with the last 20 stderr lines in `details.stderr`) → info + `url, output`; `git.list { username,
  root }` → `{ root, rel, exists, repos: [{ path, rel, name }] }` (immediate subfolders holding `.git`, `find -P`);
  `git.info { username, dir }` → `{ path, rel, branch, head: { sha, short, subject, date } | null, remotes: [{ name,
  url, push }], dirty, lastPullAt (mtime of .git/FETCH_HEAD), hasKeelYml }`; `git.pull { username, dir }` (`git pull
  --ff-only --no-rebase`, 10 min; `refused` without a remote, on a non-fast-forward or when credentials are wanted) →
  info + `{ from, updated, output }`; `git.deploy { username, dir, dryRun }` reads `.keel.yml` as the account (regular
  file ≤ 64 KiB), `parseKeelYml` takes only the `deployment: tasks:` block list (≤ 50 tasks), `splitTask` refuses
  `$ \` ; | & < >` and newlines, `planTasks` pins each task to `TASK_PROGRAMS` (`cp`, `rsync`, `mkdir`, `rm`, `chmod`
  with their option allow-lists; chmod modes without setuid/setgid) and resolves every other word with
  `resolveTaskPath` (repository-relative, `~/` = home, absolute under the home; `..` and escapes refused; `rm`/`chmod`
  never on the home itself), inserts `--` before the paths and runs the tasks one by one with `asUser(program,
  argv, { cwd: repo })`, 5 min each, stopping at the first non-zero exit (`details.results` carries what ran) →
  `{ path, rel, dryRun, tasks: [{ index, line, program, argv, ran, code, output }] }`; `git.remove { username, dir }`
  (destructive; `rm -rf -- dir` as the account, only when `.git` is there) → `{ removed }`. `capability_missing`
  without `git` on the host.
- **Service `ctx.panelGit` (`server/src/services/panel-git.js`):** `list(scope, req)` → `{ data: [{ id, name, dir,
  url, createdAt, lastPullAt, lastDeployAt, present }], meta: { total, max: 50, defaultRoot: 'repositories',
  unregistered: [{ dir, name }] } }` (`present` from `git.list` on the default root, `null` for folders elsewhere);
  `create(scope, { name, dir?, url?, adopt? }, req)` → `{ status: 201, data: { …row, info } }` (`git.init`, or
  `git.info` when `adopt`) or `{ status: 202, data: { job, name, dir, url } }` (job `panel.git.clone`); the folder is
  `resolveDir`-pinned under the home (422), may not equal, sit inside or hold another registered folder (409), names
  are unique per account (409), 50 repositories at most (`limit_reached`); `get(scope, id, req)` → `{ …row, info |
  null, missing }`; `pull` → job `panel.git.pull`; `deploy(scope, id, { dryRun })` → job `panel.git.deploy`;
  `remove(scope, id, { files = true })` (`git.remove` then the row); `getJob` / `streamJob` as §49 (the account's own
  job types only; `accountId`, `ownerId`, `abs` stripped from the view). Jobs act for the account owner read back at
  run time (`jobScope`, as the WordPress jobs); a clone inserts the row only when git succeeded and stamps
  `last_pull_at`; pull/deploy stamp their columns on success (a dry run stamps nothing). Audit `panel.git.init`,
  `panel.git.adopt`, `panel.git.clone(.done|.failed)`, `panel.git.pull(.done|.failed)`, `panel.git.deploy(.done|.failed)`,
  `panel.git.remove`.
- **Routes (`routes/panel/git.js`, `/api/panel/git`, no `panel:*` token scope — mutations are session-only, reads
  need `panel:read`):** `GET /`, `POST / { name: repoName, dir?: repoDir, url?: gitUrl, adopt?: boolean }` (`url`
  and `adopt` exclusive) → 201 | 202, `GET /jobs/:id`, `GET /jobs/:id/stream`, `GET /:id`, `POST /:id/pull {}`,
  `POST /:id/deploy { dryRun? }`, `DELETE /:id?confirm=true&files=true|false`. `gitUrl`, `repoName`
  (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, not `.git`-suffixed) and `repoDir` (file-manager `relPath` grammar) are
  exported by the service so the 422 happens before any job exists.
- **Client:** `pages/panel/files/git.jsx` (list with *Open / Pull / Deploy / Forget / Remove*, *New repository*
  sheet with name, clone URL, folder and *Use the existing folder*, detail card for `?repo=<id>` with *Pull*, *Check
  tasks* (dry run), *Deploy*, *Remove* and a file-manager link, deployment guide with the `.keel.yml` example, job
  modal over `ProgressLog` with `jobStreamPath = /panel/git/jobs/:id/stream`). Keys `panel.files/git.*` and
  `panel.git.*`; client-side `nameProblem` / `urlProblem` / `dirProblem` mirror the server grammar.
- Tests: `agent/test/git.test.js`, `server/test/panel-git.test.js`, `client/test/panel-git.test.jsx`.

## 65. Customer panel: Application Manager — Node.js and Python apps (`ctx.panelApps`, agent `apps.*`, vhost `proxies`) (P3-2)
An account's program runs as a systemd service under the account's own uid and is published on a path of one of its
domains through an Apache reverse proxy on loopback. Feature `applicationmanager` (seeded on). Migration `034f`
(shared with P3-1): table `panel_apps` (`account_id, name, type, dir, entry, runtime, port UNIQUE, domain, mount,
websocket, env_json, status, error`; `UNIQUE (account_id, name)`, `UNIQUE (account_id, domain, mount)` — every lookup by
domain or mount is scoped by `account_id`, so a row never answers for a domain another account holds later) and
`web_vhosts.proxies_json`.
- **Unit (agent `apps.unit.write { username, name, type: node|python, dir, entry, runtime, port, env, memoryMax? }`):**
  name `[a-z0-9-]{2,32}`; `dir`/`entry` home-relative (`APP_REL_RE`: no leading `/` or `-`, no `..`, no spaces, quotes or
  `%` — they go verbatim into `WorkingDirectory=`/`ExecStart=`), resolved through `as-user.js` (`assertManaged`,
  `accountPath`, symlinks confined to the home) and both must exist (`not_found` otherwise); `runtime` is a Keel Node
  major (`/opt/keel/node/<major>/bin/node`, `WHM_NODE_DIR` in tests), `system` (node/python3 on the agent's PATH) or a
  Python minor (`python3.x` on PATH) and is resolved as root; `env` keys `[A-Z_][A-Z0-9_]*`, values one line ≤ 1024,
  ≤ 64 entries, `PORT HOME USER LOGNAME PATH` refused (the panel sets them). The template is fixed
  (`renderUnit`): `User=`/`Group=` the account, `WorkingDirectory=<home>/<dir>`, `Environment="PORT=…"`, `HOME`, a
  `PATH` that starts with the interpreter's bin dir, `NODE_ENV=production` for node, the variables (systemd
  double-quoted, `\` and `"` escaped, `%` doubled so no specifier is expanded), `ExecStart=<interpreter> <home>/<dir>/<entry>` or `<dir>/.venv/bin/python …`
  when the venv exists, `Restart=on-failure`, `NoNewPrivileges=true`, `ProtectSystem=strict` + `ReadWritePaths=<home>`,
  `PrivateTmp=true`, `ProtectKernelTunables`, `ProtectControlGroups`, `RestrictSUIDSGID`, journal output with
  `SyslogIdentifier=keel-app-<username>.<name>` (the unit name: `.` separates the parts because `-` is legal in both a
  username and an app name), `MemoryMax=` only when the server passes one (plan key `app_memory_mb`). The file is `/etc/whm/apps/<username>/<name>.service` (directory `0700`, file `0600`: it holds the account's variables and systemd reads it as root; allowed root `/etc/whm/apps`; a file not
  starting with the managed header is never overwritten or deleted), linked with `systemctl link` (an existing
  `/etc/systemd/system/<unit>.service` that is not the panel's link is `refused` before the file is written), then `daemon-reload`, `enable`,
  `restart`; the result carries `started` / `startError` and the unit status. `/etc/systemd/system` itself is never an
  allowed root.
- **Other agent ops:** `apps.unit.remove { username, name }` (`disable --now`, drop the link, delete the file,
  `daemon-reload`, `reset-failed`), `apps.unit.control { …, action: start|stop|restart }` (404 when the unit is not
  installed), `apps.unit.status` (`systemctl show`: `installed, active, state, subState, enabled, pid, startedAt,
  memoryBytes, restarts, result`), `apps.unit.logs { lines 1..500 }` (`journalctl -u <unit> -n N --no-pager -o cat`),
  `apps.deps.install { username, dir, type, runtime }` (as the account via `asUser`, `nice`, 20 min: node `npm install
  --omit=dev --no-audit --no-fund` when `package.json` exists; python `python3.x -m venv .venv` once, then
  `.venv/bin/python -m pip install -r requirements.txt` when the file exists; returns `steps[{ step, command, code,
  output (last 80 lines) }]` and `skipped`), `apps.port.free { port 1024..65535 }` (`ss -ltn`; `free: null,
  checked: false` without `ss`).
- **Vhost proxies:** `web.vhost.write` takes `proxies: [{ path, port ≥ 1024, websocket }]` (≤ 20, `PROXY_PATH_RE`: `/`
  or `/seg(/seg)*` of `[A-Za-z0-9._-]`, no dot segments, each path once). `renderProxies` emits, inside
  `<IfModule proxy_http_module>` in both the HTTP and the TLS block: `ProxyPreserveHost On`, `ProxyRequests Off`,
  `ProxyPass "/.well-known/acme-challenge/" "!"` ahead of every mount (mod_proxy takes the first match, so the certbot
  webroot stays with Apache even under a root mount), a `<IfModule proxy_wstunnel_module>` + `<IfModule rewrite_module>`
  rewrite (`RewriteCond %{REQUEST_URI} !^/.well-known/`, `RewriteCond %{HTTP:Upgrade} websocket` → `ws://127.0.0.1:<port>/$1`
  `[P,L]`) for mounts with `websocket`, then per mount, longest first, `RedirectMatch 301 "^/path$" "/path/"` (non-root
  only), `ProxyPass "/path/" "http://127.0.0.1:<port>/"` and `ProxyPassReverse`. The meta line counts `proxies`; a
  vhost without proxies renders byte for byte as before. `ctx.web.setProxies(domain, proxies, req)` stores
  `proxies_json` on the row (kept by `specsFor`/`storeSpec` across every later sync), rewrites the vhost and audits
  `web.proxies.set`.
- **Apache modules:** `web.modules.status { modules? }` (read-only; `{ flavor, a2tools, modules: {name: bool},
  missing }`) and `web.modules.enable { modules: enum[proxy, proxy_http, proxy_wstunnel, rewrite], reload }` (Debian `a2enmod -q`
  per missing module, configtest — `a2dismod` again and `config_invalid` on failure — then reload; `capability_missing`
  without a2enmod). Only the server calls `enable`, as root, from `panelApps.publish` before the first app of a host
  is published; the call is audited as `web.modules.enable`.
- **Service `ctx.panelApps`:** `list(scope, req)` → `{ data: [app…], meta: { total, sites, portRange, apache, limit } }`;
  app = `{ id, name, type, dir, entry, runtime, port, domain, mount, websocket, env, status, error, unit, url,
  createdAt, updatedAt, service: { state, subState, pid, startedAt, memoryBytes, restarts, enabled } | null }`
  (`status` is the live unit state: `running` / `stopped` / `failed` / `pending` when no unit exists); `get`;
  `runtimes(req)` (`pkg.runtime.detect`, 60 s cache: `node[{ id: '<major>'|'system', label, version, keel }]`,
  `python[{ id: '3.x'|'system', … }]`, `portRange`); `create(scope, { name, type, dir, entry, runtime?, domain?,
  mount?, websocket?, env? }, req)` — 422 for the grammar, 404 for a domain that is not one of the account's
  `main|addon|sub` websites, 409 for a taken name or `(domain, mount)`, 409 `limit_reached` on plan key `max_apps`,
  501 without Apache (checked before anything is written); the port is the lowest in `panel.app_port_range`
  (`[min, max]` or `{ min, max }`, default 31000–31999, host-wide) no row holds and `apps.port.free` does not refuse;
  host first: `apps.unit.write`, then the row (an insert that loses a race on the name, mount or port removes the unit
  again and answers 409), then modules + `setProxies(domain, proxiesFor(scope, domain))` (a failed publish keeps the
  row with `status: failed` and rethrows); `update(scope, id, patch, req)` (same pins; a move re-renders
  the old and the new domain), `remove` (unit, row, proxy — the application files are never touched; `filesKept`),
  `control(scope, id, start|stop|restart, req)`, `logs(scope, id, { lines })`, `deps(scope, id, req)` → job
  `panel.apps.deps` (`runDeps` → `apps.deps.install`, each step's output in the job log), `getJob` / `streamJob` as the
  WordPress installer. Audit `panel.apps.create|update|remove|start|stop|restart|deps(.done)` (variables never
  appear, only their keys) and `web.modules.enable`. Seams: `countForDomain(scope, domain)` — `panelDomains.removeAddon`
  / `removeSub` answer 409 `in_use` while it is non-zero (move or remove the apps first); `removeAccountApps(username,
  req)` — `accounts.cleanupAccount` step `apps`, before `web`: every unit of the account is stopped, disabled and
  unlinked and the rows deleted, so no root-level service outlives the tenant.
- **Routes (`routes/panel/apps.js`, no token scope — reads with `panel:read`, mutations session-only):**
  `GET /api/panel/apps`, `GET /api/panel/apps/runtimes`, `POST /api/panel/apps` → 201, `GET|PUT|DELETE
  /api/panel/apps/:id` (`DELETE …?confirm=true`), `POST …/:id/start|stop|restart`, `POST …/:id/deps` → 202 `{ job }`,
  `GET …/:id/logs?lines=1..500`, `GET …/jobs/:id[/stream]`.
- **Client:** `pages/panel/software/apps.jsx` (key `panel:software/apps`, nav *Software › Application manager*, feature
  `applicationmanager`): create card (type, folder, start file, runtime picker from `/apps/runtimes`, domain, path,
  WebSockets switch, `KEY=value` variables), table with status pills and PID/memory, row actions Start/Stop,
  Restart, Logs (modal over `GET …/logs`), Install dependencies (job modal over `ProgressLog` with `jobStreamPath =
  /panel/apps/jobs/:id/stream`), Edit (sheet; saving rewrites and restarts the unit), Remove. Keys
  `panel.software/apps.*` and `panel.apps.*`; `parseEnv` / `formProblems` mirror the server grammar.
- **Host steps:** Apache `proxy`, `proxy_http`, `proxy_wstunnel`, `rewrite` are enabled by the panel on first publish (a2enmod);
  nothing else — Node.js builds come from Install Software, `python3-venv` (and `python3-pip`) must be installed for
  Python apps.
- Tests: `agent/test/apps.test.js`, `server/test/panel-apps.test.js`, `client/test/panel-apps.test.jsx`.

## 66. Forced 2FA for account users as a core policy (`security.2fa.required_for_users`, `auth.policy().require2faForUsers`) (P3-3)
No new agent op, table, migration, nav entry or feature flag: one seeded setting (`server/src/db/seed.js`, default
`false`; `clusters-config.js` exports it in the `security` group) read by the core login policy.
- **Core policy:** `ctx.security.policy()` and `ctx.auth.policy()` carry `require2faForUsers`. `needsEnrollment` in
  `services/auth.js` flags a `role === 'user'` login without `totp_enabled` exactly as it flags root/resellers: the login
  answer and `GET /api/auth/me` carry `mustEnroll2fa: true`, the session is flagged, and `auth.disable2fa` (the core
  `POST /api/auth/2fa/disable`) refuses while the policy stands.
- **Session gate:** `requireAuth` (`middleware/auth.js`) keeps answering `403 two_factor_required` to everything outside
  `/api/auth/*` for a flagged session, **plus** `GET /api/panel/me` and `/api/panel/security/two-factor*`
  (`PANEL_ENROLMENT_OPEN`): account users enrol through the panel's own routes, so without that opening the panel shell
  would loop on 403 instead of landing on the enrolment page. The panel's `confirm2fa` clears the session flag as the core
  confirm route does.
- **Either switch enforces:** `ctx.panel.assertTwoFactor(user, path)` (§50) throws when `panel.require_2fa_for_users`
  **or** `security.2fa.required_for_users` is on; `routes/panel/security.js` (`required`, the Disable refusal),
  `adminReset2fa.enrollmentRequired` and `GET /api/panel/me` `policy.require2fa` follow the same OR. `GET /api/panel/me`
  also carries `mustEnroll2fa` (session flag, or mode `user` without an authenticator under either switch), so a session
  that was open when the switch turned on is sent to the enrolment page by the shell (`panelRedirect`) on its next load.
- **Admin surfaces:** the switch *Require two-factor authentication for account users* sits next to the root one on
  *Security Center › Two-Factor Authentication* (server policy card, `PUT /api/system/settings`) and next to the
  root/reseller ones on *Configure Security Policies*. `ctx.panel.settings.get()` adds `coreRequire2faForUsers` and
  *Panel › Customization › Account panel* states under its own toggle that the core switch exists (and that it is on);
  Security Advisor's `panel.2fa.policy` reads `required` when either switch is on.
- Tests: `server/test/auth-2fa-users.test.js`, `client/test/security-2fa-users.test.jsx`.

## 67. PostgreSQL remote access hosts (`db_access_hosts` on a PostgreSQL profile, agent `db.pg.hba.write`) (P3-4)
PostgreSQL has no per-host users: who may connect from where is `pg_hba.conf`. Access hosts of a PostgreSQL profile are
therefore **managed blocks in that file**, one per account, written by the agent and reloaded with `pg_reload_conf()`.
No new table or setting; the existing `db_access_hosts` rows (raw host as typed) are the source and the block is derived.
- **Agent op `db.pg.hba.write { username, hosts[], databases[], users[], credentials? }`** (`agent/src/ops/db.js`):
  `hosts` are `pg_hba.conf` addresses (`pgHbaAddress`: `all`, an IP, a CIDR network, a host name or a `.domain` suffix — never
  `samehost`/`samenet`, never `%` patterns), `databases`/`users` are `pgName` identifiers that **must carry the
  `<username>_` prefix** (`refused` otherwise: a block may only open the account's own objects). The file is `SHOW hba_file`
  through the profile credentials, else the newest `/etc/postgresql/<ver>/<cluster>/pg_hba.conf` or
  `/var/lib/pgsql[/<ver>]/data/pg_hba.conf` (allowed roots `PG_HBA_ROOTS` in `managed-paths.js`). The block
  `# BEGIN Keel remote access: <username>` … `# END Keel remote access: <username>` holds one line per address,
  `host <db1,db2> <user1,user2> <address> scram-sha-256` (a bare IP becomes `/32` or `/128`), appended at the **end** of the
  file (first-match: the distribution's local/peer lines stay in front); an empty host, database or user list removes the
  block. The rewrite keeps the file's owner, group and mode (the postgres user must still read it) and leaves a
  `.whm-bak`. Reload: `SELECT pg_reload_conf()`, else `systemctl reload <pg unit>`; the result is
  `{ path, username, hosts, databases, users, lines, changed, reloaded, reloadError }`. `capability_missing` when no file is
  found, `config_invalid` on an unterminated block.
- **Service (`ctx.databases`):** `pgHbaAddress(host)` (exported) converts a stored host: `%` → `all`, `203.0.113.%` →
  `203.0.113.0/24` (one, two or three octets), IPs, CIDR networks, host names and `.domain` suffixes pass, anything else
  (`_`, a `%` inside a name) is `null` → `400`. `listAccessHosts` reports `supported: true` for MySQL and for a **local**
  PostgreSQL profile (`is_local` or a loopback host); a remote PostgreSQL profile keeps `supported: false` and
  `addAccessHost` answers `422 unsupported`. `addAccessHost` on PostgreSQL writes the block of the account (or, for a
  global host, of every account that owns a database or user) **before** the row is inserted (host first) and answers
  `{ …, address, applied: [{ account, path, reloaded, lines }], failed: [{ account, error }] }`; `removeAccessHost`
  rewrites the blocks without the row, honouring a global rule that still grants the same host, then deletes the row.
  `createDatabase`/`dropDatabase`/`createUser`/`dropUser` call `refreshPgHba(account)` when the account has remote hosts,
  so the block always names the current objects; a failure there is logged, never undoes the object. A CIDR host on a
  MySQL profile is `400` (the route schema admits the `/n` suffix for both engines).
- **Routes:** unchanged paths. Admin `POST /api/databases/access-hosts { host, account? }` and panel
  `POST /api/panel/databases/access-hosts { host }` accept `[A-Za-z0-9.%:_-]{1,255}(/\d{1,3})?`; the panel's
  `ctx.panelDatabases.listAccessHosts` follows the delegate's `supported` flag and `addAccessHost` passes `address` through.
- **Client:** `pages/panel/databases/remote-hosts.jsx` reads `meta.engine`: on PostgreSQL the help names networks and the
  `pg_hba.conf` rule, the connection card shows port `5432`, `describeHost` labels a CIDR as *network*; `supported: false`
  (remote PostgreSQL) keeps the empty state. Keys `panel.databases.host_help_pg_*`, `host_invalid_chars_pg`, `host_network`;
  `host_pg_title/text` and `hosts_empty_pg` reworded. Feature flag: the existing `postgres` plan feature (the page's nav
  entry keeps `mysql`, as the whole Databases group does). No migration.
- Tests: `agent/test/db-pg-hba.test.js`, `server/test/database-services.test.js` (PostgreSQL suite),
  `server/test/panel-databases.test.js`, `client/test/panel-databases.test.jsx`.

## 68. Customer panel: Terminal (`ctx.panelTerminal`, agent `term.*`, `term-bridge.py`, WebSocket `/api/panel/terminal/ws`) (P4-1)
A login shell **of the account** in the browser, only when the plan grants shell (`plan.has_shell`; otherwise `501
shell_disabled`, the `PLAN_SETTING_CODES` wording of §59). Feature `terminal` (seeded on). No migration. Dependencies:
`ws` (server), `@xterm/xterm` + `@xterm/addon-fit` (client).
- **Agent (`agent/src/ops/term.js`):** `term.open { username, cols 20–500, rows 5–200 }` runs the shipped static bridge
  `agent/src/ops/term-bridge.py` (python3; parameters by argv and environment only: socket path, cols, rows, idle
  seconds, max seconds, `SHELL/HOME/USER/LOGNAME/TERM/LANG/PATH`) **as the account** through `asUserArgv` (setpriv
  `--no-new-privs`, no supplementary groups) with only three pipes inherited (control stdin, `ready`/`exit` stdout,
  stderr). The shell is the account's `/etc/passwd` entry: it must be absolute, executable and not `nologin`/`false`
  (`shell_disabled`), and the bridge execs it as a login shell (`-bash`) on a pty from the home. Socket layout:
  `/run/whm/term` is `root:whmpanel 0711` (allowed root `TERM_RUN_DIR` in `managed-paths.js`, `/run/whm` itself stays
  closed), the agent creates `/run/whm/term/<id>/` as `account:whmpanel 0710`, the bridge binds `pty.sock` there
  (umask `0117` → `0660`) and the agent, after `ready`, checks it without following links (a socket owned by the
  account's uid), hands it to group `whmpanel` and gives the directory back to `root:whmpanel 0710` (while the account owns it, a shell could swap the socket for a link to another one — the agent's own — before the panel connects; the bridge's own unlink then fails and is ignored). The bridge serves the **first client only** (the listener closes and
  the path is unlinked on accept), bridges pty ↔ socket, exits on hangup (shell exit, client gone, agent pipe gone,
  SIGHUP/SIGTERM), after **15 min idle** and after **4 h** at most, then SIGHUPs the shell (SIGKILL after 2 s). The panel relay enforces the same two caps itself (`CAPS.idleMs` / `CAPS.maxMs` from the agent's `startedAt`; close reasons `idle` / `max`, `term.close` issued), since the bridge runs as the account and can be stopped by it, and it checks with `lstat` that the path is a unix socket right before connecting. `accounts.cleanupAccount` calls `panelTerminal.endAccountSessions(username)` first of all its steps (close reason `account_removed`, `cleanup.terminal = { ended }`). Wire
  format client → bridge: `[type u8][length u16 BE][payload ≤ 8192]`, type 0 keyboard bytes, type 1 resize (`cols u16,
  rows u16`); bridge → client: raw pty bytes. Control from the agent on stdin: `resize <cols> <rows>\n`. Returns
  `{ id (32 hex), username, socket, pid, startedAt, cols, rows }`. `term.resize { id, cols, rows }` (control line),
  `term.close { id }` (SIGHUP then SIGKILL, the session directory is removed when the bridge exits), `term.list
  { username }` (live sessions of that account). Limits: 32 per host, 4 per account; `capability_missing` without
  python3. Nothing the user types ever passes through the agent.
- **Service (`ctx.panelTerminal`, `services/panel-terminal.js`):** `open(scope, { cols?, rows? }, req)` gates scope
  shape, feature, `plan.has_shell` (501 `shell_disabled`, also when the agent answers `shell_disabled` because passwd
  is behind the plan) and the home, calls `term.open`, keeps `{ id, accountId, username, userId, socket, … }` in memory,
  mints a **single-use `wsToken`** (32 random bytes base64url, stored as its sha256, 30 s, bound to the session's user
  id) and audits `panel.terminal.open { id, cols, rows }`; `list(scope)` reconciles with `term.list` and reports
  `{ id, startedAt, cols, rows, connected, pid }`; `close(scope, id)` → `term.close`, audit `panel.terminal.close
  { id, reason: 'closed' }`. Every end of a terminal (browser gone, shell exit, logout, account removal) writes one
  `panel.terminal.close` row with its `reason`; the content is never audited or logged.
  **Upgrade** (`attachUpgrade(server)`, called by `index.js` on all four listeners — admin and panel, TLS and plain —
  so a "log in as" session on 2087 works too): path must be exactly `/api/panel/terminal/ws` and pass
  `panelApiAllowed` (`/api/panel/terminal` is listed on its own in `PANEL_API_ALLOW`), the `Origin` host must equal the
  `Host` header, the `whm.sid` cookie is unsigned with the session secret and looked up in `ctx.sessionStore`
  (user not suspended), `ctx.panel.scope()` runs on the session (acting-as included) and must name the terminal's
  account, the token is consumed on first presentation (a token presented with another user's cookie is burnt too),
  and a terminal that already has a socket answers `409`. Relay: binary frames or `{ type: 'input', data }` →
  type-0 frames (split at 8 KiB), `{ type: 'resize', cols, rows }` → a type-1 frame (clamped), unix bytes → binary
  messages, `{ type: 'ready' }` once the socket connected. Every 15 s the relay re-reads the session store and closes
  the terminal (`4440`, `reason: 'logged_out'`) when the session is gone or belongs to someone else; close codes
  `4401/4403/4404/4409/4410/4440`.
- **Routes (`routes/panel/terminal.js`, all session-only, feature `terminal`):** `GET /api/panel/terminal/sessions`,
  `POST /api/panel/terminal/sessions { cols?, rows? }` → `201 { id, wsToken, expiresInSeconds: 30, cols, rows,
  startedAt }`, `DELETE /api/panel/terminal/sessions/:id` → `{ id, closed: true }` (404 for another account's id).
- **Client:** `pages/panel/advanced/terminal.jsx` (nav `advanced/terminal`, feature `terminal`, phase 4): xterm.js
  loaded on demand with the fit addon, opens one shell on mount, **Reconnect** (a new shell: the bridge takes one
  client) and **Disconnect** actions, status pill, copy/paste hint with a *Copy selection* button, the idle/cap note,
  and the "not included in your plan" state straight from `me.account.plan.has_shell === false` (no request made).
  Keys `panel.terminal.*`.
- Tests: `agent/test/term.test.js` (schemas, the shell gate, control/close bookkeeping, the allowed root),
  `server/test/panel-terminal.test.js` (a local socket server speaking the bridge framing behind a real listener and
  `ws` client: 501/403/422, relay, resize, one socket per session, origin/cookie/token refusals, token expiry,
  logout closes, audits), `client/test/panel-terminal.test.jsx`. Host acceptance: grant shell to the account, open a
  terminal, `id` → the account's uid, `pwd` → its home; revoke → 501.

## 69. Customer panel: User Manager — sub-users as a composition of the account's mailbox and FTP services (`ctx.panelUsers`, `panel_subusers`) (P4-2)
A sub-user (cPanel User Manager) is **never a Linux user**: it is a name on one of the account's domains whose enabled
services are objects the account already owns, created and removed through the panel services that own them. Nothing
here talks to the agent directly, so every rule of Email accounts (feature `emailaccts`, `max_email`, Dovecot capability,
remote routing 409, maildir as the account) and FTP accounts (feature `ftpaccts`, `max_ftp`, PureDB/AuthUserFile, home
pinned under the account home by `resolveUnderHome`) applies unchanged.
- **Migration `034g_panel-subusers.sql`:** `panel_subusers (id, account_id → accounts ON DELETE CASCADE, username, domain,
  full_name, contact_email, services_json, created_at, updated_at, UNIQUE (username, domain))`. `username` matches
  `SUBUSER_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/` (the intersection of a mailbox local part and an FTP name). `services_json`
  is `{ email: { enabled, quotaMb, mailboxId }, ftp: { enabled, homeDir, accountId }, dav: { enabled } }`
  (`normalizeServices()` fills the defaults; `DEFAULT_SERVICES` carries `dav: { enabled: false }` for P4-3). The ids
  point at `mail_accounts.id` / `ftp_accounts.id`; the password is **never stored** here (each service keeps its own
  hash), so switching a service on later needs the password again (`422 password_required`).
- **Service `ctx.panelUsers`** (`services/panel-users.js`, every method takes the pinned scope and asserts feature
  `usermanager`; plan key `max_subusers`, `null` = unlimited): `list(scope)` → `{ data: [user], meta: { total, max,
  domains, features: { email, ftp }, defaults } }`; `get`; `create(scope, { username, domain, password, fullName,
  contactEmail, services })` — domain must be one of the account's (`404` otherwise), order **mailbox → FTP → row**: the
  mailbox through `ctx.panelEmail.accounts.create` (local part = username, the sub-user's domain, the given quota or the
  default), the FTP login through `ctx.panelFtp.create` (name = username, so the daemon login is `<username>@<main
  domain>` on pure-ftpd, `dir` = `homeDir` under the home); an FTP failure removes the mailbox just created, a row failure
  removes both; `update(scope, id, { fullName?, contactEmail?, services?, password? })` — a service switched off is
  removed (mailbox **with its mail**), switched on is created (password required), a mailbox quota change goes through
  `accounts.setQuota`, an FTP home change is remove + recreate (password required), `dav.enabled` switched off calls
  `panelDav.forgetLogin(scope, login, req, 'dav_off')` (htpasswd line + `panel_dav_logins` row), and a password sent with any
  edit is applied to every service that stays on (one password for all services; a service created or recreated in the same
  edit already carries it), `changed` then lists `password`; `setPassword(scope, id, password)` →
  `{ id, login, changed, applied: ['email'|'ftp'] }` through `accounts.setPassword` / `panelFtp.setPassword`;
  `remove(scope, id)` → `{ id, login, removed, services: [...] }` removes the mailbox (with mail), the FTP login and, with
  `dav` on, the DAV login through `panelDav.forgetLogin(..., 'subuser_removed')` (`services` lists `dav` when a line was removed); a
  service row already deleted elsewhere (404 from the owner) is tolerated. The shape reports `services.email.present` /
  `services.ftp.present` (`false` when the owning row vanished, `null` when the service is off) and `services.dav.login`.
  Password strength: `ctx.security.passwordStrength(pw, 'account')` here, then each owner's own context check. Audit
  `panel.users.create` (`{ login, services }`), `panel.users.update` (`{ login, changed: ['ftp:off', 'email:quota', …] }`),
  `panel.users.password` (`{ login, applied }`), `panel.users.delete` (`{ login, removed }`) — never the password — on top
  of the owners' own `panel.email.account.*` / `panel.ftp.*` rows.
- **Read seam for P4-3:** `ctx.panelUsers.davLogins(accountId)` → `[{ id, login: '<username>@<domain>' }]` for every
  sub-user with `dav.enabled`.
- **Routes `routes/panel/users.js`** (`panelRouter(ctx, 'users')`: no `panel:users` token scope exists, so the group is
  **session-only**; `requireFeature('usermanager')` on the router): `GET /api/panel/users`, `POST /api/panel/users
  { username, domain, password, fullName?, contactEmail?, services?: { email?: { enabled, quotaMb? }, ftp?: { enabled,
  homeDir? }, dav?: { enabled } } }` → `201 { data, meta: { warnings } }` (the mailbox's routing warnings), `GET /api/panel/users/:id`,
  `PUT /api/panel/users/:id { fullName?, contactEmail?, services?, password? }` → `{ data, meta: { warnings, changed } }`,
  `PUT /api/panel/users/:id/password { password }`, `DELETE /api/panel/users/:id`. Bodies are `.strict()`; `homeDir`
  follows `REL_PATH` of panel-ftp (no `..`, no leading `-`).
- **Client:** group **Preferences** (`['Preferences', 'Settings', …]` in `client/src/panel/nav.js`, icon `Settings` and
  tile colour `preferences` in `panel/icons.js`) with the function `users` (feature `usermanager`, seeded `true` in
  `DEFAULT_FEATURES`); page `pages/panel/preferences/users.jsx` (list with service badges, add/edit sheet with the
  service switches, password reset; the *Calendars and contacts* switch shows only with plan feature `caldav`). Keys
  `panel-category.preferences`, `panel.preferences/users.*`, `panel.users.*`.
- **Side effect noted for other units:** `panel-ftp.js` `resolveUnderHome` and the create audit now use `path.posix`
  (account homes are Linux paths), so `server/test/panel-ftp.test.js` also passes on a Windows checkout.
- Tests: `server/test/panel-users.test.js` (14), `client/test/panel-users.test.jsx` (7).

## 70. Customer panel: Calendars and Contacts — Radicale CalDAV/CardDAV (`ctx.dav`, `ctx.panelDav`, agent `dav.*`, host app `proxy`) (P4-3)
One Radicale per server, from the distribution, never reachable but through the hostname site's reverse proxy; one htpasswd
file the panel owns; one collection tree per DAV login; the panel hashes every password itself.
- **Agent ops (`agent/src/ops/dav.js`; constants `RADICALE`/`RADICALE_ROOTS` in `managed-paths.js`, roots `/etc/radicale` and
  `/var/lib/radicale` added to `lib.js`):** `dav.status {}` → `{ installed, version, bcrypt, listen: { host: '127.0.0.1', port: 5232 },
  packages, config: { path, exists, managed, inSync, meta }, users: { path, exists, count }, storage: { path, exists }, unit: { name,
  present, active, enabled, pid } }`; `dav.install { restart? }` (packages are **not** its job — the server installs `radicale` and
  `python3-bcrypt` through `pkg.install` first) renders `/etc/radicale/config` from `renderRadicaleConfig()` (constants only:
  `hosts = 127.0.0.1:5232`, `[auth] type = htpasswd`, `htpasswd_filename = /etc/radicale/users`, `htpasswd_encryption = bcrypt`,
  `[rights] type = owner_only`, `[storage] filesystem_folder = /var/lib/radicale/collections`, `[web] type = internal`; marker line
  `# keel-radicale {json}`; the distro file is copied once to `config.keel-orig`), creates `/etc/radicale` 0750 and the users file
  0640 root:radicale (atomic temp + rename, symlinks refused), chowns the store to `radicale`, `systemctl enable --now` and restarts
  on change, `command_failed` with the journal tail when the unit is not active afterwards; `capability_missing` without the
  `radicale` binary or group. `dav.user.set { login, hash }` — `login` matches `DAV_LOGIN_RE` (`local@domain`, lowercase, no `:`),
  `hash` matches `BCRYPT_RE` (`$2a|b|y$NN$` + 53 chars) — upserts the line (foreign/comment lines kept verbatim) and answers
  `{ login, path, created, replaced }`; `dav.user.remove { login }` (destructive) → `{ login, path, removed }`, the collections stay;
  `dav.collections { login }` (read-only) lists `collection-root/<login>/*/` with `.Radicale.props` → `{ login, path, exists,
  collections: [{ name, kind: calendar|addressbook|other, tag, displayName, description, color, items, updatedAt }] }`.
- **Host app proxy (`web.host.app.write`, §41 extension):** the spec takes `proxy: { port (≥ 1024), scriptName? }` **instead of**
  `root` (exactly one; `php` is forced false). `renderHostProxyApp` writes `RedirectMatch 301 "^/dav$" "/dav/"`,
  `ProxyPass "/dav/" "http://127.0.0.1:<port>/" retry=0` + `ProxyPassReverse` inside `<IfModule proxy_http_module>`, and a
  `<Location "/dav/">` with the access rule and `RequestHeader set X-Script-Name "/dav"` / `X-Forwarded-Proto https` inside
  `<IfModule headers_module>`; the meta line carries `proxy: { port, scriptName, target }`, `root: null`. Missing `proxy`,
  `proxy_http` or `headers` is a `proxy_modules_missing` warning on the write; `web.modules.status/enable` now accept `headers`
  (`HOST_PROXY_MODULES`), the Application Manager's `PROXY_MODULES` default is unchanged.
- **Admin service `ctx.dav` (`server/src/services/dav.js`, attached by `routes/categories/service-configuration.js`, capability
  `radicale`):** `status()` → the op's fields plus `pkgAvailable, hostname, fqdn, apache, site, published: { alias, file, managed,
  proxy, url } | null, url, serverUrl, modules: { missing, loaded } | null, http, warning, lastApply (component `dav` in
  `service_config_applies`), recentJobs`; `install(user, req)` → `202 { job, packages, pending: true }` running job `dav.install`:
  `pkg.install { packages: ['radicale','python3-bcrypt'], noRecommends: true }` (synchronous through the agent, 45 min call timeout)
  when `dav.status.installed` is false → `capabilities.refresh()` → agent `dav.install` → `publish()` when Apache and an FQDN
  hostname exist (a publish failure is a warning, the job still succeeds); `publish(req, { reload })` → `web.modules.status` +
  `web.modules.enable` for the missing ones (`reload: false`), `hostApps.publish({ name: 'dav', alias: '/dav', php: false,
  proxy: { port: 5232, scriptName: '/dav' }, options: ['None'], reload })`, probe, `recordApply('dav')`, audit `dav.publish`;
  `unpublish(req)` (audit `dav.unpublish`); for the panel: `available()`, `serverUrl()`, `setUser(login, hash, req)` (refuses a
  non-bcrypt value with 500 before the agent sees it), `removeUser`, `collections` (never throws). Routes: `GET /api/service-config/dav`,
  `POST …/dav/install`, `POST …/dav/publish { reload? }`, `DELETE …/dav` (root). Card: *Service Configuration › Panel Web Services
  Configuration › Calendars (Radicale)* (`client/src/pages/service-config/DavCard.jsx`, `davState()` for the status line).
- **Panel service `ctx.panelDav` (`services/panel-dav.js`, routes `routes/panel/dav.js` at `/api/panel/email/calendars`, scope
  `panel:email`, feature `caldav`):** the DAV logins of an account are its own `<username>@<main domain>` (`kind: 'account'`) plus every
  P4-2 sub-user with `services.dav.enabled` (`ctx.panelUsers.davLogins(accountId)` when loaded, else a tolerant read of
  `panel_subusers`; absence = none). Logins are addresses on domains the account owns, so they cannot collide across accounts; a
  `panel_dav_logins` row (migration `034h`: `account_id, login UNIQUE, subuser_id, created_at, updated_at`) records that a password
  exists and a row owned by another account answers `409 login_taken`. `GET /` → `{ available, serverUrl, hostname, logins:
  [{ login, kind, subuserId, hasPassword, passwordSetAt, urls: { principal, caldav, carddav, discovery } }], passwordMinLength: 8 }`;
  `PUT /:login/password { password ≥ 8 }` (session only, 403 `session_required` for tokens) → `ctx.crypto.hashPassword` (bcrypt 12)
  → `ctx.dav.setUser` → row upsert, audit `panel.dav.password.set { login, kind, created }`; `DELETE /:login/password` → `removeUser`
  (a missing htpasswd file is not an error) → row delete, audit `panel.dav.password.remove`; `GET /:login/collections`. Two
  hooks bypass the listing: `forgetLogin(scope, login, req, reason)` (P4-2, a row of another account is never touched; audit
  `panel.dav.password.remove { login, kind: 'subuser', removed, reason }`) and `removeAccountLogins(accountId, req)`, which
  `accounts.cleanupAccount` runs before the `panel_dav_logins` rows cascade (`cleanup.dav = { logins: [{ login, removed }] }`). A login
  outside the account's list is `404`; Radicale absent is `501 radicale`. The User Manager's password does **not** propagate to DAV.
- **Client:** `pages/panel/email/calendars.jsx` (nav `Email › Calendars and contacts`, slug `calendars`, feature `caldav`; keys
  `panel.email.calendars.*`, `panel.email/calendars.label/description`): status card with *Open web page*, *Set a DAV password*
  form (`PasswordInput`), logins table with *Collections* and *Remove*, `CollectionsCard`, `ClientSetup` (Thunderbird, iOS, Android
  DAVx⁵, macOS). Feature flag `caldav: true` seeded in `DEFAULT_FEATURES`.
- **Host steps:** none beyond what the Install button does (`apt-get install radicale python3-bcrypt`, `a2enmod proxy proxy_http
  headers`); the operator may run them by hand on a host without the Software category.
- Tests: `agent/test/dav.test.js`, `server/test/dav.test.js`, `client/test/panel-calendars.test.jsx`. Host acceptance: Install from
  the card, `https://<hostname>/dav/` answers Radicale's page, set a DAV password for the account, `curl -u <login>:<pw> -X PROPFIND
  https://<hostname>/dav/<login>/` → 207, remove the password → 401.

## 71. Customer panel: Web Disk — the home over WebDAV, one rclone daemon per account (`ctx.panelWebdisk`, agent `webdisk.*`, `unit-helpers.js`, host app `proxy.path`/`preserveHost`) (P5-1)
cPanel's Web Disk the Keel way: no shared WebDAV listener. Each account that switches Web Disk on gets its own `rclone serve webdav`
running **as the account**, bound to loopback, published by the hostname site at `https://<hostname>/webdisk/<username>/`; the
htpasswd file lives in the account's home and the panel hashes the password itself.
- **Shared unit machinery (`agent/src/ops/unit-helpers.js`):** what `apps.unit.*` used to carry inline — `APPS_DIR`
  (`/etc/whm/apps`), `MANAGED_PREFIX` (`# Managed by Keel`), `appsDir()`, `writeAtomic` (0600 under a 0700 directory),
  `requireSystemd`, `systemctl`, `linkedTo`, `parseShow`, `unitStatus`, `installUnit({ unit, file, content })` (refuses a file
  or link the panel did not create, `systemctl link` once, `daemon-reload`, `enable`, `restart`, returns `{ unit, path, bytes,
  started, startError, status }`), `removeUnit({ unit, file })` (`disable --now`, unlink, delete, `reset-failed`) and
  `controlUnit(unit, action)`. `apps.js` imports them and re-exports `APPS_DIR`/`parseShow`; the module registers no op and never
  imports `lib.js`.
- **Agent ops (`agent/src/ops/webdisk.js`):** `webdisk.unit.write { username, port 1024–65535 }` → `capability_missing` without
  `rclone` on the PATH (resolved as root, never from the account), `not_found` while `~/.keel/webdisk.htpasswd` is missing (the
  password comes first), then renders `keel-webdisk-<username>` from `renderUnit()` (constants only: `User=<username>`,
  `Group=<gid>`, `WorkingDirectory=<home>`, `ExecStart=<rclone> serve webdav <home> --addr 127.0.0.1:<port> --baseurl
  /webdisk/<username> --htpasswd <home>/.keel/webdisk.htpasswd --config /dev/null --cache-dir <home>/.keel/webdisk-cache
  --vfs-cache-mode writes --dir-cache-time 5s --umask 022 --log-level NOTICE --exclude /.ssh/** --exclude /.keel/**` (rclone
  anchors a leading `/` to the served root: the home's own `.ssh` — the panel's `ssh_managed` policy must not be bypassed over
  WebDAV — and `.keel`, which holds the htpasswd file the daemon authenticates against, are hidden from the share, nothing
  deeper), `NoNewPrivileges`, `ProtectSystem=strict`,
  `ReadWritePaths=<home>`, `PrivateTmp`, `ProtectKernelTunables`, `ProtectControlGroups`, `RestrictSUIDSGID`, marker
  `# whm-webdisk {json}`) into `/etc/whm/apps/<username>/keel-webdisk-<username>.service` and installs it through `installUnit`
  → `{ unit, path, bytes, started, startError, status, port, baseUrl, rclone }`. `webdisk.unit.remove { username }` (destructive)
  → `{ unit, path, removed }`; `webdisk.unit.control { username, action: start|stop|restart }` (destructive); `webdisk.unit.status
  { username }` → `parseShow` fields + `{ path, port, baseUrl, htpasswd: { path, exists }, rclone: { installed } }`.
  `webdisk.htpasswd.set { username, login, hash }` — `login` matches `WEBDISK_LOGIN_RE` (`[a-z0-9][a-z0-9._-]{0,63}`, no `:`; every `arg.username` fits),
  `hash` matches dav.js's `BCRYPT_RE` — runs **as the account** (`mkdir -p -m 700 ~/.keel`, `chmod 700`, then files.js's
  `stagedWrite` = `dd` → `chmod 600` → `mv -T`) and writes the single line `login:hash`; `webdisk.htpasswd.remove { username }`
  (destructive, `rm -f` as the account). Every path is pinned under the home through `accountPath` (symlinks confined); an unknown
  or system account is refused before anything runs. The allowed roots are unchanged (`/home`, `/etc/whm/apps`).
- **Hostname-site proxy (`web.host.app.write`, §41 addendum):** `proxy` gains `path` (an alias-shaped prefix kept on the way
  upstream: `ProxyPass /webdisk/<u>/ → http://127.0.0.1:<port>/webdisk/<u>/`, what rclone's `--baseurl` expects and what keeps the
  `<D:href>`s in PROPFIND answers absolute) and `preserveHost` (`ProxyPreserveHost On` inside the `<Location>`, so a WebDAV
  MOVE/COPY `Destination` on the public name passes Go's host check). The meta line records `proxy.target` with the path; Radicale's
  `/dav` drop-in is rendered exactly as before.
- **Panel service `ctx.panelWebdisk` (`services/panel-webdisk.js`, routes `routes/panel/webdisk.js` at `/api/panel/webdisk`,
  scope `panel:files`, feature `webdisk` — already in `DEFAULT_FEATURES`; capability `rclone` registered there; job
  `panel.webdisk.install`):** table `panel_webdisk` (migration `034i`: `account_id UNIQUE, enabled, port UNIQUE, login UNIQUE,
  has_password, password_set_at, status, error, created_at, updated_at`), one row per account created on first use with
  `login = <username>` (unique by construction; a row of another account answers `409 login_taken`) and a port picked like the
  Application Manager does (`portRange` of `panel.app_port_range`, rows of `panel_apps` **and** `panel_webdisk` excluded,
  `apps.port.free` probed; `panel-apps.js`'s own picker excludes both tables too, so a disabled disk's kept port is never handed
  to an app). A switch-on re-probes the kept port and moves the row to a fresh pick when something listens there (audit
  `panel.webdisk.port.move { from, to }`). `GET /` → `{ enabled, login, port, hasPassword, passwordSetAt, status: disabled|active|failed, error,
  serverUrl, hostname, fqdn, available: { rclone, apache, published }, unit: { unit, installed, active, state, pid, restarts,
  startedAt } | null, passwordMinLength: 8, packages: ['rclone'], pending, recentJobs }`. `PUT /password { password ≥ 8 }`
  (session only) → `ctx.crypto.hashPassword` → `webdisk.htpasswd.set` → row, and when the disk is on `webdisk.unit.control
  restart` (rclone reads the file at start), audit `panel.webdisk.password.set { login, created, restarted }` (never the password
  or the hash). `PUT / { enabled }` (session only): off → `hostApps.unpublish('webdisk-<u>')` + `webdisk.unit.remove` → row
  `enabled = 0` (port and password kept), audit `panel.webdisk.disable`; on → `409 password_required` without a password, `409
  hostname_required` without an FQDN, `501 apache` without Apache; without `rclone` → `202 { pending: true, job }` running
  `panel.webdisk.install` (`pkg.install { packages: ['rclone'], noRecommends: true }` synchronously through the job's agent,
  `capabilities.refresh()`, then the same enable; `409` while one is already queued); with it → `webdisk.unit.write` →
  `web.modules.status/enable` for `proxy proxy_http headers` (reload deferred) → `hostApps.publish({ name: 'webdisk-<u>', alias:
  '/webdisk/<u>', php: false, proxy: { port, scriptName, path: '/webdisk/<u>', preserveHost: true }, options: ['None'], reload: true
  })` → row `enabled = 1, status = active|failed`; a failed publish removes the unit again and leaves `status = failed`. The drop-in
  name is `appNameFor(username)` (`webdisk-<username>`, or a hashed form when `_` or the length would break the host app
  grammar). `GET /clients` → `{ serverUrl, hostname, login, port: 443, clients: [{ id: windows, url, unc }, { id: macos, url },
  { id: ios, url }, { id: android, url }, { id: linux, url, gvfs, davfs }] }`; `GET /jobs/:id[/stream]` for the install job (the
  account's own jobs only). Hooks: `listAll()` feeds the admin card; `removeAccount(username, accountId, req)` runs from
  `accounts.cleanupAccount` (`cleanup.webdisk = { login, port, enabled, unitRemoved, unpublished }`) before the home and the row go;
  `rewrite(username, req)` → `{ enabled, rewritten, started, unit, port }` re-runs `webdisk.unit.write` with the row's port when
  the disk is on (the unit bakes the home into its paths) and is called by account-functions' rearrange job after `usermod -d`
  and the vhost rewrite, logged in the job (audit `panel.webdisk.rewrite`); a disabled or absent row answers `{ enabled: false,
  rewritten: false }`.
- **Admin:** `GET /api/service-config/webdisk` now answers `{ settings, lastUpdate, live, disks: [{ username, domain, login,
  enabled, port, status, error, hasPassword, url, updatedAt }], hostname, apache }`; the *Web Disk Configuration* page lists the
  accounts' Web Disks above the legacy port settings (stored only; nothing listens on 2077/2078).
- **Client:** `pages/panel/files/webdisk.jsx` (nav `Files › Web Disk`, slug `webdisk`, feature `webdisk`; keys
  `panel.webdisk.*`, `panel.files/webdisk.label/description`): status card with the switch (disabled until a password exists; a
  `202` streams the install job through `ProgressLog` on `/panel/webdisk/jobs/:id/stream`), *Web Disk password* form, *Connect
  your devices* (Windows UNC `\\<host>@SSL\webdisk\<u>`, macOS, iOS Files, Android, Linux GNOME/davfs2).
- **Host steps:** `apt-get install rclone` is done by the first enable (job); `a2enmod proxy proxy_http headers` by the enable.
  Nothing else.
- Tests: `agent/test/webdisk.test.js`, `server/test/panel-webdisk.test.js`, `client/test/panel-webdisk.test.jsx`. Host
  acceptance: set a password and switch on for `testuser`, `curl -u testuser:<pw> -X PROPFIND https://<hostname>/webdisk/testuser/`
  → 207, `curl -u … -T probe.txt https://<hostname>/webdisk/testuser/probe-webdisk.txt` → the file in `/home/testuser` owned by
  `testuser`, `-X DELETE` removes it, switch off → 404.

## 72. Customer panel: one-click installers — Joomla and Drupal (`ctx.panelInstallers`, agent `web.app.*`, feature `installers`) (P5-2)
The WordPress pipeline (§50) generalised to a small catalog: the release pins live in the agent, the panel process never
names an archive, root only downloads/hashes and looks at metadata, everything inside the home runs as the account.
- **Release pins (`agent/src/ops/app-install.js` `APP_RELEASES`, frozen):** `joomla` → `Joomla_<v>-Stable-Full_Package.zip`
  from the GitHub release of `joomla/joomla-cms` (flat archive, `root: null`, signature `installation/joomla.php`,
  `libraries/src/Version.php`, `administrator/index.php`), `drupal` → `https://ftp.drupal.org/files/projects/drupal-<v>.tar.gz`
  (`root: drupal-<v>`, signature `core/lib/Drupal.php`, `index.php`, `sites/default/default.settings.php`); each with
  `version, url (https only), sha256 (the publisher's: GitHub asset digest / release notes for Joomla, the drupal.org release
  page for Drupal), bytes, format (zip|tar), requires: { php }, topLevel` (what a removal inside a shared docroot may delete:
  only names the archive or the installer puts there — Joomla ships `htaccess.txt`/`robots.txt.dist`, so a site's own `.htaccess`
  (the panel-managed rules of §47) and `robots.txt` are never listed and never removed).
  Bumping a release = editing this table (`agent/test/app-install.test.js` pins the shape). Current: Joomla 6.2.0, Drupal 11.4.11.
- **Agent ops:** `web.app.catalog {}` → `{ apps: { <id>: { name, version, url, sha256, bytes, format, requires } } }`;
  `web.app.requirements {}` → `{ php, phpVersion, phpMysql, unzip, tar, asUser }`; `web.app.discover { usernames, maxDepth?, maxDirs? }`
  → `{ installs: [{ username, home, app, path, relative, version, dbName, dbUser, dbHost, dbPrefix, configured, pendingInstaller }],
  missing }` (Joomla = `libraries/src/Version.php` + `administrator/`, `configuration.php` parsed; Drupal = `core/lib/Drupal.php` +
  `sites/`, `sites/default/settings.php` parsed; root reads through `readSiteFile`, lstat-guarded, 512 KiB cap);
  `web.app.fetch { username, path, app, timeoutMs?≤180 s, maxBytes?≤128 MiB }` (destructive) → `{ path, app, bytes, sha256,
  members, version, topLevel }`: refuses the home itself and a directory that already holds any web application (`exists`),
  downloads the pinned URL into `/tmp/whm` (0600, `O_EXCL|O_NOFOLLOW`, https only including redirects, Content-Length and
  byte count bound, magic bytes checked), `checksum_mismatch` when the SHA-256 differs — before anything is listed —,
  then as the account: `unzip -Z` / `tar --list --verbose` on `/dev/fd/0`, `checkAppMembers` (files and directories only,
  no `..`/empty/`.` components, every member under the release root when it has one, `checkArchiveMembers` for links/.ssh,
  the signature files present, `exists` when a top-level entry is already there), unpack into `<target>/.keel-unpack-<rand>`,
  `mv -t <target>` the top-level entries, remove the stage; a failure removes what this run created (`details.cleanup`);
  `web.app.joomla.install { username, path, url, title, adminUser (≥2), adminEmail, adminPassword (≥12), dbName, dbUser,
  dbPassword, dbHost?, dbPrefix? ([a-z][a-z0-9]{0,13}_) }` (destructive) runs `php -d memory_limit=512M installation/joomla.php
  install --site-name … --admin-user … --admin-username … --admin-email … --db-type=mysqli --db-host … --db-user … --db-name …
  --db-prefix … --db-encryption=0 --public-folder=` as the account with `adminPassword\n` + `dbPassword\n` on stdin
  (`joomlaInstallArgv` never carries a password; Joomla asks for the two missing options in that order, `SHELL_INTERACTIVE=1`),
  requires "Joomla has been installed" and `configuration.php` afterwards (`command_failed` with the installer's last error
  line otherwise), `chmod 0640 configuration.php` (a failure is a `warning`), removes a leftover `installation/` →
  `{ path, url, adminUrl, version, warning }`; `web.app.drupal.configure { username, path, dbName, dbUser, dbPassword, dbHost?,
  dbPrefix? ('' | prefix), trustedHosts: [hostname…] }` (destructive) writes `sites/default/settings.php` through `stagedWrite`
  (0640; `$databases['default']['default']` with the core mysql driver namespace/autoload, `hash_salt` 64 random chars,
  `config_sync_directory = sites/default/files/config_<32 random>/sync`, anchored `trusted_host_patterns`, `update_free_access`
  FALSE, `settings.local.php` include), creates `sites/default/files` 0755, `php -l` when php exists (the file is removed on a
  lint failure) → `{ path, mode, linted, syncDir, installPath: 'core/install.php', version }`; `web.app.remove { username, path,
  app, mode: tree|entries }` (destructive) → `{ path, app, mode, removed }` (`entries` = the release's `topLevel` names only).
  All paths go through `accountPath` (managed uid ≥ 1000, home from passwd, lexical + realpath containment, allowed roots).
- **Server `ctx.panelInstallers` (`services/panel-installers.js`, routes `routes/panel/installers.js` mounted at
  `/api/panel/software/installers`, scope `panel:software` = session-only mutations, feature `installers`):** `APPS` holds the
  page-facing descriptors (`id, name, description, site, dbBase (joomla|drupal), finish (cli|web), adminPath, installPath?,
  fields, passwordMin`); the pins come from `web.app.catalog` (cached 10 min). `list(scope)` → `{ data: rows, meta: { total,
  requirements, canInstall, hint, catalog: [{ …APPS[id], version, url, sha256, bytes, requires, available, supported
  (`phpSatisfies(phpVersion, requires.php)`), canInstall, hint }], sites, prefix } }`, rows = `discover` filtered to the
  account's docroots: `{ id (= installIdOf(abs), §50), app, name, path, domain, under, url, adminUrl, installUrl (Drupal with
  `core/install.php` still present), version, database, dbUser, dbHost, dbPrefix, configured, isDocroot, databaseOwned }`.
  `install(scope, app, body)`: `requireFields` per `APPS[app].fields` (422 `{ fields }`; Joomla password ≥ 12), `resolveSite`
  (§50 rules: 404 foreign domain, 422 path), 409 when any app already sits there, 501 `installers` when the entry is not
  `canInstall`, `panelDatabases.createForApp({ base: dbBase })`, Joomla `dbPrefix = randomTablePrefix()` (`[a-z][a-z0-9]{4}_`),
  job `panel.app.install` with encrypted `adminPasswordEnc`/`dbPasswordEnc` → `202 { job, id, app, name, version, domain,
  path, url, adminUrl, installUrl, database, dbUser, dbHost, finish, adminUser?, adminEmail?, generatedPassword?,
  adminPassword? (once) }`. `runInstall`: `jobScope` as §50 → `web.app.fetch` → Joomla `web.app.joomla.install` | Drupal
  `web.app.drupal.configure { trustedHosts: [domain, www.domain] }` → result `{ id, app, name, domain, path, url, adminUrl,
  installUrl, version, database, dbUser, adminUser, finish, note }`; a failure runs `compensate` (agent cleanup note, else
  `web.app.remove`, then drop user + database) and audits `panel.app.install.failed`. `remove(scope, id, { database })` →
  `web.app.remove` (`entries` on a docroot) + drop of the owned database/user as §50 → `{ id, app, name, domain, path,
  removed, files, database, dbUser, databaseKept }`. `getJob`/`streamJob` confined to `panel.app.install` jobs of the account.
  Audit `panel.app.install` / `.done` / `.failed`, `panel.app.remove`; secrets never in params views or audit.
- **Client:** the P5-3 catalog page (`pages/panel/software/installers.jsx` → `parts/InstallerCatalog.jsx`, `parts/catalog.js`)
  reads this API through its `shared(id)` entries (`list: /software/installers`, `install: /software/installers/<id>`,
  rows filtered by `app`, state from `meta.catalog[]`); nav `Software › Installers` (`?app=joomla|drupal`), feature
  `installers` seeded true, Feature Manager label *One-click installers (Joomla, Drupal)*.
- **Host steps:** none beyond PHP ≥ 8.3 with `php-mysql`, `unzip` and `tar` on the command line (all already on nova).
- Tests: `agent/test/app-install.test.js` (pins, schemas, archive guard, rendering/parsing, Joomla argv without passwords, a
  real-account run under `WHM_TEST_ACCOUNT`), `server/test/panel-installers.test.js` (12), the P5-3 `client/test/panel-installers.test.jsx`.
  Host acceptance: Joomla into `/probe-joomla` on testuser → HTTPS 200 from Joomla, remove with database; Drupal into
  `/probe-drupal` → `core/install.php` answers 200, remove with database.
