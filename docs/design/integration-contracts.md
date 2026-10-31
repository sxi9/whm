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

## 33. Application Manager seams (2026-10-29; design `docs/design/application-manager.md`)
- `web.vhost.write` renders `IncludeOptional "<apache root>/whm-apps/<domain>.conf"` into every VirtualHost block
  (after the PHP handler, before TLS). **application-manager owns that file** (`app.proxy.write`/`app.proxy.remove`,
  all apps of a domain in one file); service-configuration never writes it and a vhost re-render never touches it.
- `ctx.apps.removeAccountApps(username, req)` is called from `accounts.cleanupAccount` before `ctx.web.removeAccount`
  (units stopped and removed, includes dropped; the home goes with the Linux user).
- Allowed roots: `/opt/whm/runtimes` (managed Node.js), `/etc/whm/apps` (units + env files, under `/etc/whm`).
  Everything inside a home runs as the account through `runuser -u <user> --`.
- App units are `whm-app-<id>` (`svc.status/start/stop/restart/journal` work on them); ports from
  `apps.port_range`; `apps.allow_resellers` gates reseller mutations.

## 34. Platform-fixes seams (2026-10-30; designs `docs/design/https-defaults.md`, `docs/design/support-chat.md`)
- **`ctx.stack`** (core, `services/system-stack.js`, created in `routes/system.js` with the job `stack.install`):
  `status()`, `install({ profile | components }, user, req)` (one job at a time: a second request is refused while one
  runs), `capabilityInstall(cap, user, req)`, `serviceInstall(name, user, req)`, `setup.pending(user)` /
  `setup.complete({ skipped }, req)` (setting `setup.completed`; servers with accounts count as set up), `catalog()`,
  `profiles()`. The catalog `server/src/lib/stack-catalog.js` (`STACK_COMPONENTS`, `STACK_PROFILES`) is the single
  source of truth for packages per family, units, capability names and post-install steps; `scripts/install.sh
  --stack|--components` reads the same file. Post-install kinds: `a2enmod` → agent op `stack.apache_enmod`
  (Debian; rolls back on a failed configtest), `enable` → `svc.enable`, `initdb` → `stack.postgres_initdb` (RHEL).
  Any `CapabilityNotice` with a `capability` prop offers root *Install <X>* through
  `POST /api/system/capabilities/:cap/install` when the catalog has an entry. `POST /system/setup/complete` is on the
  license middleware's degraded allow-list so *Skip for now* works unlicensed.
- **`web.module.enable { modules }`** (agent, `ops/web.js`, ≤ 10 names `[a-z0-9_]{1,40}`): Debian — `a2query` decides,
  `a2enmod` only what is off, configtest, `a2dismod -f` of exactly what was switched on when Apache rejects it
  (`config_invalid`), then reload; RHEL — verifies against `httpd -M` and returns `{ skipped: true, missing, reason }`
  naming `conf.modules.d`. It is the op Apache Configuration should call to switch `mod_rewrite` on (the HTTPS
  redirect block is wrapped in `<IfModule mod_rewrite.c>`; `apache.status.rewriteModule === false` is the warning).
- **HTTPS defaults:** setting `panel.force_https` (default true; `config.forceHttps` / `WHM_FORCE_HTTPS` pins it,
  `app.js` reads it per request; `/api/health` and `/.well-known/acme-challenge/` exempt) and setting
  `web.force_https` (default true; `ctx.web.forceHttps()`, `ctx.web.apache.setForceHttps(enabled, req)` saves and
  re-renders every vhost; `web.vhost.write` takes `redirectHttps`). Panel TLS pair: `config.tlsCert/tlsKey` =
  `/etc/whm/tls/cert.pem` + `key.pem` on an installed host (`deploy/whm.conf.example`, `install.sh`, legacy
  `/etc/whm/ssl/panel.*` migrated on `--upgrade`); `ssl.service_cert.install` for `panel` writes exactly that pair
  and `watchTlsFiles` (`server/src/index.js`) swaps it in without a restart. The agent must leave the pair readable by
  the panel's service group (`WHM_AGENT_GROUP`), or the listener keeps the previous certificate.
- **Hostname vhost:** `ctx.web.ensureHostnameVhost(req, { hostname? })` (never throws; runs on `panel.started`, on a
  hostname change, on `landing` template save/reset and in the re-render job), `ctx.web.landingDocroot`
  (`/var/www/whm-default`), `ctx.web.isServerName(domain)` — **binding for account, addon, parked and sub-domain
  creation and for restores**: refuse the hostname and `www.<hostname>` before a Linux user exists; the vhost layer
  itself answers 409 `conflict`. `ctx.networking.reissueHostnameCertificate({ force }, req)` and the scheduled
  `renewHostnameCertificate(job)` (`hostname-certificate-renew`) install the hostname certificate for `panel`,
  `exim`, `dovecot`, `ftp` (`HOSTNAME_CERT_SERVICES`).
- **`ctx.dnsCloudflare`** (`services/dns-cloudflare.js`, migration `035_dns-cloudflare.sql`): `status(user)`,
  `configure({ apiToken }, user, req)` / `remove(user, req)` (root), `zones({ refresh })`, `zoneStatus(domain, user)`,
  `link(domain, { cloudflareZoneId? }, user, req)` / `unlink` (root; the account's zone id is recorded so a reseller
  cannot claim a foreign zone), `import(domain, user, req)`, `requestPush(domain, user, req)` (202; one job per zone,
  per-zone lock), `runPushJob(job)` (job `dns.cloudflare.push`; settings `dns.cloudflare.push_attempts` = 3,
  `dns.cloudflare.retry_backoff_ms` = `[5000, 20000, 60000]`; 4xx never retried). DNS Functions exposes
  `ctx.dns.loadZone(domain, user)` (ownership-checked zone row) and `ctx.dns.replaceRecordsFromProvider(domain,
  records, user, req)` (keeps SOA + apex NS, skips what the panel cannot hold, publishes without mirroring back); a
  publish of a linked zone queues a push and carries `mirror` in its result. The token never leaves the service.
- **`ctx.supportChat`** (`services/support-chat.js`, migrations `034_support-chat.sql` + `034b` backfill):
  `listConversations(query, user)`, `get(username, user, { before, limit })`, `post(username, body, user, req)`
  (audits `chars` only), `markRead`, `update(username, { status, subject }, user, req)`, `unread(user)`,
  `subscribe(accountId, fn)`. Read-only for other categories; scope is root → all, reseller → owned or managed
  accounts, `user` → the account named like the login. `accounts.manager_user_id` (`POST/PATCH /api/accounts
  { manager }`, `GET /api/accounts/managers`) defaults to the creator; a reseller may name itself or a root user.
  Events `support.chat.message` / `support.chat.status` carry no text.
- **Super admin** (migration `001e_users-superadmin.sql`, `users.superadmin`): `ctx.auth.isSuperadmin(user)`,
  `requireSuperadmin(ctx)` (`middleware/rbac.js`: root **and** flag). The flag is set only by `scripts/whm-cli.js
  superadmin <user>` after the setup password verifies against `config.superadminKeyFile` (`/etc/whm/superadmin.key`,
  `lib/superadmin-key.js`; `superadmin --init` writes it; the panel process never opens it). License key, hub
  origin, activations and hub answers go to the super admin only: `license.js` summaries, the marketplace client
  status (`url`/`hubUrl` null + `hubLabel` for others), `market.js` provider shape and the `whm-hub` config/test routes
  are gated; `config.licenseHubUrl` defaults to `https://licserver.hostingsignal.in`. The audit log keeps key prefix
  and hub text out.
- **Hub TOTP** (hub migrations `001d_portal-totp.sql`, `001e_portal-totp-step.sql`, marketplace
  `001b_developer-totp-step.sql`): vendor setting `hub.require_totp_for_admins` (default true) makes `vendor_admin`
  and `reseller_admin` enrol before anything outside `/v1/portal/*` answers (`403 totp_enrol_required`); codes are
  accepted once per time step (`portal_users.totp_last_step`, `developers.totp_last_step`; a replayed code answers `totp_reused` and, having verified, spends neither the wrong-code budget nor a failed-login strike); `PATCH /v1/portal/settings`
  toggles the rule (stepped-up vendor admin). Hub tests boot with the rule off unless `bootHub({ requireTotp: true })`.
- **Branding migrations:** `029c_support-branding.sql` (support provider name default → *Hostingsignal Support*),
  `011b_locales-branding.sql` (seeded locales translate the category as *HST Panel*). `client/src/brand.js` is the
  source of the product names; slugs, keys, routes and settings keep the `cpanel` identifiers.

## 35. Full-audit seams (2026-10-30; `fix(audit): full audit round 1`, `b100fd3`, and its integration round)
- **The web-server group on document roots** (accounts, service-configuration and transfers share it): Apache walks a
  docroot as its own user (`www-data` on Debian/Ubuntu, `apache` on RHEL — `web.detect().apache.runUser`, the names
  `apacheLayout` hardcodes), which is in no account's group, so every docroot the panel creates or receives is
  `<user>:<web group>` with mode `0750` (cPanel's `user:nobody` layout) and the home stays `0700`-style private.
  `accounts.webServerGroup(req)` is the probe (`user.get` for `www-data`, then `apache`; `null` when neither exists,
  e.g. before Apache is installed — the docroot is then `user:user` until the next write puts the group on it);
  `fs.mkdir { owner, group, mode: '0750' }` at account creation, `fs.chown { owner, group }` after a transfer
  (`transfers.shareDocroot`: rsync `--chown`, cpmove extract, addon copy; the result carries `webGroup`).
  Addon/sub-domain docroots are created by `ctx.accountFunctions.domains.add` through the agent op
  **`web.docroot.ensure`** (§36.1; 2026-10-31 — this paragraph used to say they were not created and named
  `fs.mkdir { owner, group, mode: '0750' }` for whoever added it): `runuser -u <user> -- mkdir -p -m 0750` as the
  account, then root hands the directory to the web server's group through an `O_NOFOLLOW` directory descriptor
  that must belong to the account — the resulting layout is the same `0750 <user>:<web group>` as the main
  docroot, never `0755`. Never widen the mode instead (`0755`/`o+x` on a home lets every local user read other
  accounts' files), and never give the web server the account's group.
- **`.htaccess` `Options` under the hardened `AllowOverride`** (web, transfers, backup, security-center): account
  vhosts render `AllowOverride AuthConfig FileInfo Indexes Limit Options=Indexes,MultiViews,SymLinksIfOwnerMatch,
  IncludesNOEXEC` (`DOCROOT_ALLOW_OVERRIDE`, agent `web.js`), and Apache's `set_options()` refuses in a `.htaccess`
  any other token whatever its sign, and `All` outright — the whole directory then answers 500 with only the
  domain error log saying why. Every category that writes files into an account (transfers: rsync, cpmove
  extract, addon copy; backup: both restore kinds) therefore calls `lib/htaccess.js reconcileHtaccess(agent,
  { roots, username, req, log })` after its chown step: the agent op `web.htaccess.audit { roots, username, fix }`
  walks the roots without following links, rewrites `FollowSymLinks` → `SymLinksIfOwnerMatch` **in place and only
  in files the account's uid owns** (fstat on the open descriptor, never uid 0), and returns `rewritten` /
  `unsupported` (`{ file, line, tokens }`), which the caller logs (warn for what it could not fix) and attaches to
  its step as `htaccessRewritten` / `htaccessUnsupported`. The Security Advisor runs the same op read-only
  (`fix: false`) over every `public_html` plus the `account_domains.docroot`s outside it (`htaccess.options`
  finding). The allowed tokens are stated in MANUAL 7.1; nothing re-enables `FollowSymLinks`.
- **Account suspension = password lock + account expiry** (`user.lock` → `usermod -L -e 1 <user>`, `user.unlock` →
  `usermod -U -e '' <user>`): `-L` alone only prefixes the hash, which sshd under `UsePAM` and key logins never
  consult; the expiry (day 1) makes every PAM account stage — SSH with keys, FTP, IMAP/POP, cron — refuse the user.
  Existing sessions are not killed (the op stays non-destructive; the Rearrange/move flow calls it too), so a
  category that must end them does it explicitly and audited. Callers add no second mechanism (shell swap, key
  removal): unlock would have to undo it.
- **Confined API tokens never attach a user outside their endpoints** (`middleware/auth.js`): a token whose scopes
  are confined (`ctx.confinedScopes`: `clustering:dns`, `clustering:config`, §31) always gets `req.auth.confinedTo`,
  but `req.user` only on a request matching one of its `{ method, path }` entries (`confinementAllows`);
  `requireAuth` answers `403 scope_confined` before `401`. Consequently a route mounted before `requireAuth`
  (`{ public: true }` mounts such as `/api/branding`, `/api/auth/*` including the OIDC `?link=1` path) sees no
  principal for a confined token and must never act for a user it did not authenticate itself. Reseller tokens
  also stop authenticating once the `cpanel-api` ACL is revoked (`ctx.resellers.hasAcl`, checked per request).
- **Run rows are swept on `panel.started`:** every service that keeps a run table beside a job (transfers
  `transfer_runs`/items, backup `backup_runs` + `backup_restores`, multi-account runs/items) subscribes
  `ctx.events.on('panel.started', reconcileRuns)` and `ctx.jobs.onAny('failed' | 'cancelled')`, and marks a row
  still `running` whose job is not running any more as `failed` ("interrupted by a panel restart") with its open
  items `skipped`; `lib/jobs.js` recovers only the job rows (`recoverStale`) and emits no event for them. A new
  category with run rows copies the recipe (abandon-run helper + the two hooks) and never leaves a row `running`
  with no live job.
- **SameSite=lax session cookie:** `app.js` sets `sameSite: 'lax'` (not `strict`) because the external-auth callback
  is a cross-site top-level navigation that must carry the session with the OIDC state/nonce; the CSRF token
  remains the mutation guard, so no route may rely on the cookie's SameSite for that.

## 36. Issue-2 seams (2026-10-31; designs `docs/design/domains.md`, `php-versions.md`, `security-alerts.md`, `hardening.md`, `backup-cloud.md`; round `wf_08bc14d9-ea9`)

### 36.1 Landing vhost, domains and the hostname certificate (V1; service-configuration, account-functions, ssl-tls)
- **`ctx.web.ensureDefaultVhost(req, { hostname? })`** (never throws; records `service_config_applies.default_vhost`,
  audit `web.vhost.default`, reported as `defaultVhost` by `GET /api/service-config/apache`) renders the **catch-all
  vhost** through the agent op `web.default_vhost.write` (`read` / `remove` beside it): the branded landing page for
  the bare IP. It runs at the end of every `ensureHostnameVhost` path (boot, hostname change, `landing` template
  save, re-render job), from `applySsl`/`removeSsl` when the hostname's certificate changes, at the end of
  `setListenPorts`, `replaceIp` and `setAccountIpv6`, and after any `ensureVhost` whose address set differs from the
  recorded one. **`ctx.web.removeDefaultVhost(req)`** drops it; **`ctx.web.removeDomain(domain, req)`** removes a
  domain's vhost file + row and refuses the main domain and the hostname.
- **Files, structural load order** (`agent/src/ops/web.js`, `DEFAULT_VHOST_NAMES`): Debian
  `conf-available/000-whm-default.conf` + its `conf-enabled/` link (`apache2.conf` includes `conf-enabled` before
  `sites-enabled`; a copy an earlier panel left under `sites-available`/`sites-enabled` is removed on the next
  write/remove and reported as `legacy`), the stock `000-default` site disabled with `a2dissite` (re-enabled when
  the configtest rejects ours); RHEL `conf.d/+whm-default.conf` (`+` sorts below `-`, `.` and every digit/letter,
  ahead of `ssl.conf`'s `_default_:443` and `welcome.conf`). `<VirtualHost _default_:80 <every tenant address>:80>`
  plus the same on the HTTPS port inside `<IfModule ssl_module>`, **`ServerName default.invalid`** (so it never
  steals the hostname from the hostname vhost), docroot `/var/www/whm-default`, `AllowOverride None`, no PHP, no
  redirect. **Certificate fallback chain** on 443: the hostname's installed bundle → the `apache` service
  certificate (`/etc/ssl/whm/service/apache/`) → the panel listener's pair (`/etc/whm/tls/`) → a self-signed pair
  generated once with openssl under `/etc/ssl/whm/default/` (`DEFAULT_SSL_DIR`) → none: HTTP block only. Behind
  the NGINX proxy the vhost binds to the loopback port only; software's `writeProxy` passes the same pair
  (`defaultServerPair()`: the hostname bundle, else the pair the catch-all recorded) as `pkg.nginx.proxy.write
  { defaultServer }` so nginx's `:443 default_server` proxies `https://<ip>/` to Apache instead of answering 444.
- **`ctx.accountFunctions.domains.list(username, user)` / `add(username, { domain, type: addon|sub|parked,
  docroot?, autossl? }, user, req)` / `remove(username, domain, { deleteFiles }, user, req)`**; routes
  `GET|POST /api/account-functions/domains/:username`, `DELETE /api/account-functions/domains/:username/:domain
  ?deleteFiles=true` (`requireReseller`, ownership re-checked, ACL `edit-account`, package limits `max_addons` /
  `max_subdomains` / `max_parked` bind resellers). Steps `{ docroot, web, dns, mail, ssl }` each
  `applied|pending|skipped|failed`; audit `account.domain.add|remove`. Parked names delegate to
  `ctx.dns.parkDomain` / `unparkDomain`.
- **Claimability rule (`assertClaimable`, run for every type before any host step; binding for anything that
  hands a name to an account):** for a non-root caller the name must not be a label under the server hostname
  (`ns1.<hostname>`, `mail.<hostname>` — root only), the **nearest hosting account** of the name or any parent
  label (`accounts.domain`, `account_domains.domain`) must be the target account, and a DNS zone of **exactly**
  that name owned by another account is never reassigned (`ensureZoneForDomain` would). Sub-domain `A` records
  touch a containing zone only when `zoneFor(...).account_id` is the account (root excepted); otherwise the DNS
  step is `skipped`. `ctx.web.isServerName` refuses the hostname and `www.<hostname>` everywhere. The rule lives
  in `account-functions.js` (`accountHosting`/`assertClaimable`); exposing it as `ctx.dns.assertDomainClaimable`
  and deduplicating with `parkDomain`'s check is open.
- **Document roots: agent ops `web.docroot.ensure` / `web.docroot.remove`** — everything inside a home runs as the
  account: `runuser -u <user> -- mkdir -p -m 0750 <docroot>`, then `0750 <user>:<web group>` through an
  `O_NOFOLLOW` directory descriptor owned by the account (`assertUnderHome`: a planted link is
  `path_not_allowed`; uid ≥ 1000; reserved directories refused); `index.html` is written as the account
  (`runuser … tee`) only when absent, from `renderTemplate('index', { domain, username, hostname })` (≤ 512 KiB,
  the template editor's limit). `remove` is `runuser -u <user> -- rm -rf <docroot>`, never the home,
  `public_html`, a reserved directory or a docroot another domain of the account lives in or below
  (`domains.remove` only passes `deleteFiles` when no other row's docroot equals or sits under it;
  `validateDocroot` answers 409 for a docroot that *contains* another domain's). Restores and transfers never
  re-render the index page.
- **`GET /api/ssl/hosts`** → `{ hosts, serverHostname, … }`: `serverHostname` (root only, `ssl.hosts.server()`) =
  the hostname's installed certificate, the `panel`/`exim`/`dovecot`/`ftp` service certificates with
  `coversHostname`, the `hostname-certificate-renew` schedule, the AutoSSL provider + the last run entry scoped to
  the hostname, the landing vhost and the reissue path; the hostname's own host row carries `hostname: true`.
  Reissue is `POST /api/networking/hostname/certificate`; download reuses `GET /api/ssl/certs/:id/download`.

### 36.2 PHP version installer (V2; software, agent `pkg.*`)
- Routes (`requireRoot`): **`GET /api/software/php/installable`** (`requirePkg()` only — works with no PHP on the
  host; rows `{ version, id, label, offered, installed, installedVersion, candidate, source, fpmUnit, layout,
  stock, isDefault, isCliDefault, inUse, usage, inUseDetail, advisories, removable }`, `recent` = last ten jobs),
  **`POST /api/software/php/install { version /^\d\.\d$/ }`** (202, job `software.php.install`; 422 outside
  `PHP_BRANCHES` 7.4 … 8.5, 409 already installed, 409 while any `software.php.*` / `software.pkg.*` /
  `software.system.update` / `software.nginx.install` / `software.ea4.build` job holds the package manager),
  **`DELETE /api/software/php/versions/:id`** (202, job `software.php.remove`; 404 / 409 system default / 409 CLI
  default / 409 "still used by …" / 422 non-versioned layout; the job re-runs `phpRemovalCheck` and passes
  `purge: true`).
- Agent ops: **`pkg.php.sources.detect { branches? }`** (os-release, source + `configured`, one `apt-cache policy`
  / `rpm -q` + `dnf list` call for every branch's `-fpm` package and `php-fpm`, `stock` from the distribution's
  own entry, `source.supported:false` with the reason when a path is outside the agent's roots),
  **`pkg.php.source.enable { source: ondrej|sury|remi, wait }`** (idempotent; a refresh that fails right after the
  entry was added undoes it and answers `refused`), **`pkg.php.source.rollback { source }`** (destructive; the
  same undo for the detached path — the install job calls it when the failed run had `changed: true`),
  **`pkg.php.install { version, extensions?, wait }`** (names no repository offers are skipped, missing `-fpm` →
  `unsupported` before anything runs), **`pkg.php.remove { version, purge?, wait }`** (destructive; only a
  `debian`/`remi` `discoverPhp()` entry, refuses the branch `/usr/bin/php` resolves to).
- **Sources, one per family** (`PHP_SOURCES`, `agent/src/ops/pkg.js`): Ubuntu / `ID_LIKE ubuntu` →
  `ppa:ondrej/php` via `add-apt-repository -y -n`; Debian → `packages.sury.org/php` (keyring
  `/etc/apt/keyrings/whm-sury-php.{gpg,asc}`, list `/etc/apt/sources.list.d/whm-sury-php.list`); RHEL family →
  Remi **SCL** packages `php8x-php-*` (`epel-release`, `remi-release-<major>.rpm`, `crb`/`powertools`,
  `makecache`), never the modular stream (it replaces the single system PHP). **Allowed roots** added for the
  sury path: `/etc/apt/keyrings`, `/etc/apt/sources.list.d` (`agent/src/lib.js`).
- **Extensions come from the stack catalog** (`componentByKey('php').packages[family]` in
  `server/src/lib/stack-catalog.js`, `php-mysql` → `mysql`, `fpm/cli/common` dropped); the agent's
  `PHP_EXTENSIONS` is only the fallback. The install job snapshots `php.versions()` first and keeps the previous
  default (`keepPreviousDefault`: pins `php.default_version`, `pkg.php.default.set` back when `/usr/bin/php`
  moved). Usage (`phpUsageOf`) counts every pinning store — `account_domains.php_version`,
  `web_vhosts.php_version`, `web_php_pools.version`, `packages.php_version`,
  `accounts.plan_snapshot_json.php_version`, `apache.settings().defaultPhpVersion` — normalised to the branch;
  a `ctx.web.phpVersionUsage(branch)` seam may replace the two web queries later.

### 36.3 Security alerts (V3; server-contacts, security-center, software)
- **`ctx.securityAlerts`** (`services/security-alerts.js`, created by the Server Contacts module right after
  `ctx.contacts`; migrations **`037_security-alerts.sql`** — `security_alerts`, `security_alert_deliveries`,
  settings `security.alerts.enabled|notify_accounts|min_severity|digest_minutes` — and
  **`037b_security-alerts-root-mail.sql`**, which appends `security.alert` to `contacts.root_mail_events` once).
  **`raise({ kind, severity?, title, body, dedupeKey, source?, data?, force?, defer? })`** is synchronous and
  idempotent per `dedupeKey` for 24 h (older key retired as `<key>#<id>`), records nothing while disabled, stores
  below-minimum alerts as `skipped`, audits `security.alerts.raise` without the body.
  **`onAdvisorScan(run, { previousCritical })`** (called by `security-center.js advisor.scan()`, result exposed as
  `run.alerts`, the scan never fails on it) raises one alert per critical finding new since the previous run
  (`php.advisory.*` findings → kind `php.advisory`). `recipientsChanged()` is called by the contacts service on
  create/update/mail-preferences so alerts that found no recipient (`skipped: no_recipients`, state stays
  `pending`) go out once someone subscribes.
- **Contacts event `security.alert`** (group Security, default severity critical) in `server-contacts.js`
  `EVENTS`; admins receive one `ctx.contacts.notify('security.alert', { subject, body, severity, data: { alerts } })`
  per delivery run. **`software.panel.status().latest.security`** is a new boolean from the release feed
  (`security: true` or `tags: ['security']`); `software.js` raises `updates.security_available` (nightly check,
  deduped on the sorted security set, re-alerted only when an entry is new — `software.updates.security_alerted`),
  `updates.security_applied` (result gains `securityApplied`) and `panel.security_release` (manual check and the
  `panel-update-check` schedule `23 6 * * *`, job `software.panel.check`, enabled only while
  `software.update_url` is set).
- **Routes (root):** `GET /api/server-contacts/security-alerts` (overview), `GET …/security-alerts/alerts?limit`,
  `PUT …/security-alerts/settings`, `POST …/security-alerts/test { includeAccounts }` (202), `POST
  …/security-alerts/raise { title, body, severity?, notifyAccounts? }` (202), `POST …/security-alerts/deliver`
  (202; 501 `CapabilityError` when accounts are to be mailed without a transport, 422 while disabled).
- **Audience rule (binding):** hosting accounts only ever receive `updates.security_applied`, administrator
  notices (`manual`) and tests, each rendered with `accountText()` (package names without versions, never finding
  details), and only when `security.alerts.notify_accounts` is on or the test/notice stored `data.notifyAccounts`;
  a generic flush honours the per-row choice. Advisor findings, PHP advisories, pending updates and panel
  releases are admin-only. Suspended accounts and accounts without a usable `contact_email` are skipped.
- **Digest without a cron schedule:** the first alert after a quiet window is delivered at once; alerts raised
  within `digest_minutes` of a delivery are `held` and flushed by an unref'd timer (pending rows re-scheduled at
  boot by the register hook); `digest_minutes = 0` = immediate. Delivery runs (`security.alerts.deliver`) are
  serialised in-process; the account step inserts a `security_alert_deliveries` claim row before each send
  (unique per alert + account). Both transports still put only `text/plain` on the wire (`renderMail().html` is
  produced but unused until `server-contacts-smtp.js buildMessage` and `mail.sendmail` accept an `html` part).
  On the RHEL family nothing is flagged as a security update until `pkg.upgradable` consults
  `dnf updateinfo list --security` (open).

### 36.4 Curated package catalog (V4; software, agent `pkg.*`)
- **`server/src/lib/package-catalog.js`** (`PACKAGE_GROUPS`, `PACKAGE_CATALOG`, `resolveEntry`, `packagesFor`,
  `phpRuntimePackages`): 79 entries in 8 groups (Web, PHP extensions, Databases, Mail, Security, Tools,
  Monitoring, Hosting services); an entry that is also a stack component links to it with `stack` and takes its
  packages, capability, units and repository notes from `stack-catalog.js` (a package list is never maintained
  twice); PHP extensions carry `php: { debian, rhel }` suffixes expanded per installed PHP version, `phpVersioned`
  names the packages that mean the per-version set; every `configure` path is validated against `nav.js`.
- **Agent op `pkg.offers { names, provides? }`** — one `apt-cache policy` / `rpm -q` + `dnf list` call for up to
  ~150 names (`provides: true` additionally resolves RHEL Provides through `rpm -q --whatprovides` and
  `dnf -q -C repoquery --whatprovides=`, capped at 50, answer carries `provider`). The service caches the answer
  for **15 minutes** (`OFFERS_TTL_MS`) and drops it after every package job or `?refresh=true`. `pkg.available`
  (one call per name) stays for `system-stack`; switching it to `pkg.offers` is open.
- **Dedupe rules** (`pkg.search`, `dedupeSearchResults` / `pickMain`): one row per piece of software; folded
  variants are `-dev/-devel/-dbg/-dbgsym/-debuginfo/-doc/-docs/-common/-data/-static/-source`, `:arch` and `-arch`
  suffixes, per-version infixes (`php8.3-`, `python3.12-`, `postgresql-16`), lib so-versions and language-binding
  prefixes/suffixes; `KIND_RANK` picks the headline (flavor < common < runtime < version < arch < dev < source <
  doc < debug); `collapsed` counts folded variants, `hidden` the names beyond the cap; `all=true` lifts the cap.
- **Routes (root):** `GET /api/software/pkg/catalog?q&group&refresh`, `POST /api/software/pkg/catalog/:key/install
  { phpVersion? }` (202; the job asks `pkg.offers` first and skips names no repository carries, failing only when
  nothing of the entry is offered). **Deep link:** `/software/install-distro-packages?entry=<key>` highlights the
  entry (`?q=` is the search fallback); WHM Marketplace's *Add* / *Open in catalog* use `installDistroHref({ entry,
  q })`.

### 36.5 Hardening (V5; security-center, agent `hardening.*`)
- **`ctx.hardening`** (`services/hardening.js`, created by the Security Center module after `ctx.security`;
  migration **`038_hardening.sql`** — `hardening_state(item, desired, params_json, previous_json, …)` + the
  `security.hardening.fail2ban.*` defaults): `status()`, `apply(item, body, req)`, `revert(item, req)`,
  `fail2ban.unban/install`, `firewall.plan()`, `findings()` (one advisor finding per item, fix link
  `/security-center/security-advisor#hardening`), `reconcile(job)`. Items `fail2ban`, `auto-updates`, `ssh`,
  `sysctl`, `firewall`; states `applied | not_applied | not_applicable | unknown`. Host first, row second.
- **Agent ops** (`agent/src/ops/hardening.js`; op names carry no digits, so Fail2ban's family is `jails`):
  `hardening.jails.status|apply|revert|unban`, `hardening.updates.status|apply|revert`,
  `hardening.sysctl.status|apply|revert`, `hardening.firewall.status|apply|revert`. Every revert, `unban` and
  `firewall.apply` is `destructive`; files carry `Managed by WHM panel (Hardening)` and an unmanaged original is
  kept as `<file>.whm-orig` (`.whm-orig.disabled` under `apt.conf.d`). **Allowed roots added:** `/etc/fail2ban`,
  `/etc/apt/apt.conf.d`, `/etc/dnf/automatic.conf`, `/etc/sysctl.d`.
- **Files:** `/etc/fail2ban/filter.d/whm-panel.conf` + `/etc/fail2ban/jail.d/whm.local` (the panel jail watches
  the journal with `journalmatch = SYSLOG_IDENTIFIER=whm-panel`, the identifier `deploy/whm-panel.service` sets;
  pino-http's `POST /api/auth/login|2fa` answered 401/403; `banaction` follows the panel's firewall backend;
  `ignoreip` loopback only, the `[whm-panel]` exemption from `ignoreIps` or the applying address); Debian
  `/etc/apt/apt.conf.d/20auto-upgrades` + `52whm-unattended-upgrades` (`#clear` of the origin lists, security
  pockets only, no automatic reboot; `50unattended-upgrades` left alone); RHEL `/etc/dnf/automatic.conf` keys
  rewritten in place; `/etc/sysctl.d/90-whm-hardening.conf` loaded with `sysctl -e -p FILE`. SSH goes through
  the existing `sec.sshd.get/set` + `sec.ssh_keys.list` (refused 422 while root could not log in with a key).
- **Firewall baseline** via the boot reconcile job: `WHM_BASELINE` chain appended to INPUT (iptables/ip6tables)
  or table `inet whm` (nft), policy switched to drop last; the plan opens the panel ports, every port root's
  real sshd listens on (`ss -ltnpeH` + `/proc` uid/exe check, socket units merged), 80/443, mail/DNS/FTP + passive
  range, the hub's live ports, `extraTcp`/`extraUdp`. Three guards (UI confirmation typing the SSH port, API
  `confirmSshPort` + live checks, agent re-check). `not_applicable` while **firewalld or ufw** is active.
  Persistence = `hardening_state.desired` + job `hardening.reconcile` at boot (like `WHM_BLOCK`), never
  iptables-persistent files. Capability `fail2ban` is registered by the Security Center module; the install goes
  through `ctx.stack.capabilityInstall('fail2ban')`; a missing `unattended-upgrades`/`dnf-automatic` is installed
  as a `software.pkg.install` job (202).
- Routes (root): `GET /api/security/hardening`, `GET /api/security/hardening/firewall/plan`,
  `POST /api/security/hardening/:item/apply` (202 when a job is returned), `POST
  /api/security/hardening/:item/revert`, `POST /api/security/hardening/fail2ban/unban`,
  `POST /api/security/hardening/fail2ban/install`. Audit `security.hardening.apply|revert`,
  `security.hardening.fail2ban.unban`.

### 36.6 Encrypted cloud storage (V6; backup, agent `backup.rclone.*`)
- **`ctx.backupCloud`** (`services/backup-cloud.js`) is created by the backup category and **used only through
  `ctx.backup`** (provider catalog, OAuth client registry, PKCE flows + code exchange, per-destination key
  generation, `agentConfig(row, { encrypted })`, `needsRclone`). Other categories and the plugin host call
  **`ctx.backup.uploadFile(destinationId, file, req)` → `{ remotePath, encrypted }`** (routes through
  `backup.destination.upload` or `backup.rclone.upload`, persists rotated tokens, flags `reauthRequired`); never
  `ctx.agent.op('backup.destination.upload', …)` with `destinationConfig()` — that carries panel-only fields the
  strict schema rejects and fails for every cloud or encrypted destination (`unsupported`). Callers that keep an
  upload row store **`backup_uploads.encrypted`**: listings, fetches, prunes and deletes use the transport that
  wrote the copy.
- **Capability `rclone`** (binary `rclone`, registered by the backup category; stack component `rclone`, EPEL on
  the RHEL family; `CapabilityNotice` label `rclone`): every cloud kind and every encrypted destination answers
  501 `capability_missing` with `capability: 'rclone'` without it; plain local/FTP/SFTP/WebDAV/S3 keep the
  curl/SigV4 path. **Op family `backup.rclone.test|upload|download|list|delete`** (`delete` destructive): a
  root-only `rclone.conf` rendered per call under `/tmp/whm/backup-rclone-<random>/` (0600, `HOME` and
  `--cache-dir` inside it, removed in `finally`), fixed flags, exec timeout 2 h for transfers / 5 min otherwise,
  secrets never on argv, stderr scrubbed of every configured secret (timeouts and spawn failures included),
  `use_trash = false` (Drive) / `hard_delete = true` (B2). **`backup.destination.*` refuses rclone
  configurations** (`unsupported`), so the service's routing is the only path; config values pass the `iniValue`
  rule.
- **Encryption:** rclone `crypt` remote `[whm]` wrapping `[whmbase]` (names and contents encrypted); password +
  salt per destination (`newEncryptionKey()`), rendered in rclone's obscured form (`rcloneObscure`), returned
  **once** (`encryptionKey` on create / enable / an update that turns it on). **On by default except a plain
  `local` copy** (`crypt` omitted → on); **"crypt cannot be switched off once enabled" → `PUT` with
  `crypt: false` is 409**; `POST /api/backup/destinations/:id/encryption` enables it on an old destination
  (new uploads only). Pre-039 rows report `config.crypt: false` explicitly.
- **OAuth (gdrive, onedrive, dropbox):** `GET /api/backup/destinations/oauth/:provider/start?destination=` (root,
  session only; state + PKCE verifier + redirect URI in `req.session.backupOauth`, 10 min TTL) and
  `…/oauth/:provider/callback` (constant-time state check, consumed once, server-side exchange over https with a
  15 s timeout / no redirects / 256 KB cap, then `302 /backup/backup-configuration?cloud=connected|error`). The
  redirect URI to register with the provider is **`https://<hostname>:2087/api/backup/destinations/oauth/<provider>/callback`**;
  the one sent is derived from the request host, so connect from the canonical hostname. OAuth clients live in
  `backup_oauth_apps` (`client_secret_enc`; `GET/PUT/DELETE /api/backup/destinations/oauth-apps[/:provider]`);
  tokens never come from the browser (OAuth kinds take `folder`/`crypt` only).
- **Migration `039_backup-cloud.sql`** rebuilds `backup_destinations` with the widened `kind` CHECK (`gdrive`,
  `onedrive`, `dropbox`, `azureblob`, `b2` added; `backup_uploads.destination_id` and `backups.destination_id`
  links parked across the DROP), adds `last_upload_at/ok/message`, `backup_uploads.encrypted` and
  `backup_oauth_apps`. Routes: `GET /api/backup/destinations/providers`, `GET /api/backup/destinations/:id/archives`
  (both layers, `encrypted` per entry), `POST …/:id/archives/import { name, encrypted }` (202, job
  `backup.cloud.fetch`: download/decrypt, verify, register as a pinned import).
