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
