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
  `updates.rowUpdate(list, kind, id)` → `{ candidate, severity, reasons } | null` is what the catalogs attach:
  `GET /api/software/php/catalog` rows and `GET /api/software/runtimes` runtime/tool rows gain `update` (null when nothing
  is pending or the row is not installed).
- **Routes:** `GET /api/software/updates/critical` (requireRoot) → the list; `POST …/updates/critical/refresh` recomputes
  it. `POST /api/software/php/update { version }` (requireRoot, `phpVersionId`) → `202 { job, version, candidate, method:
  'package'|'source' }`, job `software.php.update`; `422` when the version is not installed, has nothing pending, or is
  affected with no candidate. `POST /api/software/runtimes/update { runtime, version? } | { tool }` (requireRoot, catalog
  enum, no `method`) → `202 { job, target, packages, method: 'package'|'node' }`, job `software.runtime.update`; `422` for
  `runtime: 'php'` (PHP goes through `/php/update`), a Node.js major not under `/opt/keel/node`, or packages none of which
  is installed. Audit `software.php.update { from, to, method, packages, jobId }` and `software.runtime.update`.
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
