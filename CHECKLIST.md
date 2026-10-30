# WHM Control Panel — Build Checklist

> Living tracker. **Update this file on every push.** Legend: `[ ]` not started ·
> `[~]` scaffolded (route + page + API stub exist, not yet fully implemented) ·
> `[x]` implemented and verified (tests pass, reviewed).
>
> Design: [BLUEPRINT.md](BLUEPRINT.md) · Project memory/conventions: [CLAUDE.md](CLAUDE.md)

## Current state

- **Branch:** `claude/pensive-curie-9r0rcx` (continues `claude/trusting-cori-ifp7wy`) · **Last updated:** 2026-10-30 · **owner asks 2026-10-29:** application hosting first, then the 26-item live-server issue list (session upload), then a full audit — see *Owner's issue list* below
- **2026-10-30 (integration round):** platform-fixes leftovers integrated — shared-file findings closed by the integration agents; this unit added the agent op `web.module.enable` (`agent/test/web.test.js` 32 tests), `install.sh --stack full|web|none` / `--components` from the stack catalog, the panel TLS pair at `/etc/whm/tls/{cert,key}.pem` (`whm.conf.example`, legacy pair migrated on `--upgrade`), `WHM_FORCE_HTTPS` in the templates, and the manuals/INSTALL/README/contracts §34 for every round-1 unit.
- **2026-10-29/30:** Phase-6 verifier run done (11 confirmed findings fixed, `50d0f14`); **category 31 Application Manager landed** (`81417ea`, 3 functions); platform-fixes round 1 for the issue list built (9 units: installer profiles + install-from-panel + setup wizard, HTTPS/hostname/branded pages, super admin + hidden hub + hub authenticator, external-auth presets, Cloudflare DNS, account manager + chat (Support › Account Conversations → 216 functions), terminal latency, quota page, HST Panel rename) — review + fix round in progress; screenshots refreshed with the new pages.
- **Done:** full blueprint; license-server design (`docs/design/license-server.md`); plugin SDK reference code (`plugins/sdk/`, 56 tests passing); **Phase 0 foundation runs end-to-end** (boot → migrate → seed → login/forced password change → CSRF → status/services → packages CRUD → create a real Linux account → suspend/unsuspend/modify → terminate → audit).
- **Phase 1 shell is live:** React SPA with WHM-style top bar, searchable collapsible sidebar listing **all 212 functions in 30 categories**, home dashboard (Statistics + Tools grid + Favorites + service dots), login/2FA/forced-password-change, audit-log viewer, shared components (DataTable, forms, ConfigPage, ActionPage, ProgressLog, modals, toasts). 29 functions have real pages wired to the API (marked `[x]` below); the other 183 route to a placeholder page that names their build phase. Verified end to end with Playwright (login → create account via the form → lists/status/config pages → search).
- **Tests (06:50 on the 27th):** server 1135 / agent 462 / client 48 / hub 177 / hub-ui 97 / SDK 73 / sample plugin 13 / bundled plugins ×4 — all green (`npm test` runs every workspace, the SDK, the sample plugin and the bundled plugins); both builds (client, hub/ui), boot and Playwright pass.
- **Wave 1 landed** (`79097b1`, 2026-10-26 01:50): Security Center, DNS Functions, Database Services, IP Functions, SSL/TLS, Email, Software, Service Configuration, Development, Locales — 106/109 functions done (3 partial, noted inline), 222 new agent ops (267 total), migrations 002–012, 107 new pages; suites server 426 / agent 233 / client 5 green.
- **Wave-1 fix round done** (03:12): all 19 reviewer findings and the 6 integration seams closed per `docs/design/integration-contracts.md`; suites server 479 / agent 260 / client 5 green; final integration check passed.
- **Wave 2 landed** (19:00 UTC, 100 agent runs, 0 errors): Account Functions (incl. real vhost/DNS/mail provisioning on Create Account), Account Information, Multi Account, Resellers, Backup, Transfers, Server Status, System Health, Server Configuration, Networking Setup, Server Contacts, System Reboot — 67 functions built, 49 new agent ops (316 total), migrations 012–023; suites server 807 / agent 381 / client 7 green, build + boot + e2e pass. 10 reviewer findings stayed open after two in-wave fix rounds and were closed by the **wave-2 fix round** (20:40: 27 agent runs, 0 open, final integration check pass) together with the critic's 6 integration gaps (`docs/design/integration-contracts.md` §11–21).
- **Screenshots regenerated 08:03 UTC (27th)** (`974cb94`, captured from a panel holding a live trial license and an installed marketplace plugin): all 212 pages live + 17 flow shots incl. License tab, Manage Plugins › Marketplace and WHM Marketplace: all 212 function pages captured with label bars, **212/212 live** — galleries in `docs/screenshots/`.
- **Wave 3 landed** (00:03 on the 27th, 52 agent runs, 0 errors): Clusters, Themes, Market, cPanel, Support, Plugins — 16 functions; the three Plugins functions are real bundled SDK plugins (`plugins/bundled/net.whm.{server-monitoring,imunifyav,wp-toolkit}`) on the core host; migrations 025–030; suites server 1046 / agent 451 / client 30 green, build + boot + e2e pass. **Every one of the 212 functions is now built**; the wave-3 fix round (01:35, 19 agent runs after a resume from a container restart) closed every reviewer finding — only WHM Marketplace stays partial until Phase 5 wires the hub catalog.
- **Core plugin host merged** (20:55, `16286ee`): real implementation of the SDK host contract (signed packages, sandboxed plugins, per-plugin routes/jobs/cron/hooks, generic page renderer, sidebar injection); reviewed in 3 parity/security rounds with nothing open. Reseller nameservers now render into new zones (`521ae02`); the Server Profile's hidden categories are hidden by the shell (sidebar, Tools grid, search).
- **Deferred to the end (user decision):** license server, plugin marketplace, plugin host, sample + automated-backup plugins (Phase 5).

## Timeline (actual + estimated)

Times are UTC on 2026-10-25/26. Estimates assume the build keeps running continuously
with the current limit of **2 concurrent agents** (4-CPU container); every step is
checkpointed to git, so an interrupted session resumes from `CLAUDE.md`/this file.
Measured so far: a category builder takes ~35–45 min, each verification round ~10 min,
a fix round ~15 min; most categories need one fix round.

| Step | Status | Took / estimate | Done at / ETA |
|---|---|---|---|
| Blueprint (architecture + all 212 functions) | done | 15 min | 17:13 |
| License-server design + plugin SDK reference code (paused run) | done | 40 min | 17:51 |
| P0 Foundation (API, agent, DB, auth, jobs) + smoke test | done | ~1 h | 18:17 |
| P1 Shell (UI, nav for 212 functions, 29 live pages, Playwright check) | done | 20 min | 18:36 |
| Test suites (server 93, agent 42) + fixes | done | 25 min (background) | 18:48 |
| Convention refactor, deploy (installer, systemd, CLI, README), e2e, screenshots | done | 25 min | 19:09 |
| **P2 wave 1** — Security Center, DNS, Databases, IP, SSL/TLS, Email, Software, Service Configuration, Development, Locales (10 categories, op families) | done — 106/109 functions, 88 agent runs | 6 h 54 min | 01:41 |
| Integrate wave 1 (suites 426/233/5 green, build, e2e, screenshots, checklist, push `79097b1`) | done | 20 min | 01:50 |
| Wave-1 fix round (reviewers' 19 open findings + 6 integration seams; 1 fixer + 1 verifier per category, 8 categories) | done — 0 open, final integration check pass; suites 479 / 260 / 5 | 1 h 27 min | 03:12 |
| **P2 wave 2** — Account Functions completion (vhost/DNS/mail provisioning), Account Information, Multi Account, Resellers, Backup, Transfers, Server Status, System Health, Server Configuration, Networking, Contacts, Reboot (12) | done — 67 functions, 100 agent runs, 10 findings carried to the fix round (container recycled 05:38–14:26; resumed from cache) | 6 h 50 min of run time (+ 9 h stall) | 19:00 |
| Integrate wave 2 (suites/build/boot/e2e, contracts §11–21, checklist, screenshots) | done | 25 min | 19:25 |
| Wave-2 fix round (10 open findings + 6 critic gaps; 1 fixer + 1 verifier per category, 12 categories) | done — 0 open, final integration check pass; suites server 861 / agent 410 / client 7, build + boot + e2e | 1 h 35 min | 20:40 |
| Plugin host (core prerequisite for cPanel › Manage Plugins and the Plugins category) | done — built in an isolated worktree, 3 review rounds, 0 open, merged `16286ee` | 1 h 45 min | 20:55 |
| **P2 wave 3** — Clusters, Themes, Market, cPanel, Support, Plugins (6; the three Plugins functions ship as real bundled SDK plugins) | done — 16 functions, 52 agent runs, 10 findings carried to the fix round | 3 h 13 min | 00:03 (27th) |
| Integrate wave 3 (suites 1046/451/30 green, build, boot, e2e; core: theme hook, public branding mounts, buffer-safe audit, core-owned event bus) → **all 212 functions built** | done | 25 min | 00:30 (27th) |
| Wave-3 fix round (10 open findings + critic gaps; 8 categories incl. dns-functions and account-information follow-ups) | done — 0 open per category; integrator closed the core items (release-feed integrity fields, package theme validation, seed cleanup, core-only event bus, bundled-plugin tests in `npm test`) | 1 h 20 min (+ 1 h container restart) | 01:35 (27th) |
| **P5** — marketplace design (`docs/design/marketplace.md`, 683 lines, + six-unit build plan; two critique passes, 26 findings resolved) | done | 55 min | 01:40 (27th) |
| **P5 build** — license server (`hub/license`), marketplace (`hub/marketplace`, open dev registration with backend verification), hub UI, panel license + marketplace clients, `plugins/SDK.md`, sample plugin, automated-backup plugin — 3 rounds × 2 units, each verified (`wf_c7084ffb-2df`) | done — 6 units, 49 agent runs, 0 errors; critic: nothing blocking at the seams | 5 h | 06:45 (27th) |
| Integrate Phase 5 — docs/deploy half 05:40 (`0be6f9c`); code half (workspaces + scripts, Security Advisor integrity finding, hub ui_dist, errata); green gate: server 1135 / agent 462 / client 48 / hub 177 / hub-ui 97 + SDK + sample + 4 bundled plugins, both builds, boot, e2e | done | 1 h | 06:50 (27th) |
| Phase-5 fix round (`wf_8f6db955-2a6`: signed fail-closed hub errors, deterministic token test, hub/ui dashboard fields, reseller entitlement + products routes, payouts statement, admin impersonation, hub/ui interaction tests, page-descriptor `origin`) | done — 0 open; landed `e49e500`; gate server 1135 / agent 462 / client 48 / hub 181 / hub-ui 105 + SDK + 5 plugin suites, builds, boot | 45 min (+ 20 min container restart) | 07:40 (27th) |
| Live hub + panel end-to-end flow (`e2e/live-hub-flow.sh`: hub with generated keys + TLS → trial activation + key pinning + check-in → developer registration, e-mail verify, TOTP, namespace, signed upload, admin review, hub signing, publish → provider enable → install → pending_consent → consent → revoke → disable + banner + audit → update 1.1.1 held for consent) | done — 11/11 steps PASS on the first live run, **no code fix needed**; reviewer re-ran it green; Playwright steps 15–17 + full screenshot refresh (`974cb94`) | 45 min | 08:10 (27th) |
| Install guide + user manual (`docs/INSTALL.md` 903 lines; `docs/MANUAL.md` + `MANUAL-partB.md` 2936 lines: every flag/env var, all 212 functions, hub portals, plugins, licensing, troubleshooting; accuracy reviewer fixed 10 findings) — user ask 07:40 | done | 55 min | 08:35 (27th) |
| **P6** — hardening: three audits done (36 findings: 21 fixed with tests, 8 accepted risks, 7 deferred — list in `HANDOFF.md` §4); Security Advisor PHP-advisory rule (CVE-2026-109618/109619) + perf indexes landed `b01bd30` | audits done 08:50; full gate green 09:05; **verifier not run — session ended** | 30 min | 09:05 (27th) |
| Phase-6 verification (49 agents: 3 areas × lenses, 3 refuters per finding, docs check, critic) → 11 confirmed findings fixed with tests (`50d0f14`); fresh-clone gate fixes | done | 2 h | 2026-10-29 21:00 |
| **Category 31 — Application Manager** (design `docs/design/application-manager.md`; agent family `app.*`, `ctx.apps`, migration 033, 3 pages, 15 presets; 2 review lenses + fix round, 21 findings closed; gate server 1201 / agent 547 / client 74) — owner ask | done, `81417ea` | 3 h | 2026-10-29 21:20 |
| **Platform fixes round 1** — the owner's 26-item issue list as 9 units (U1 installer/stack/setup wizard/install-from-panel, U2 HTTPS/hostname/branded pages, U3 HST Panel rename, U4 super admin + hidden hub + hub TOTP, U5 external-auth presets, U6 Cloudflare DNS, U7 account manager + chat, U8 terminal latency, U9 quota page) — 13 reviews, 55 findings verified, fix round (33 fixed, 18 cross-unit leftovers) | done — `wf_d0005cdd-38a` (193 agents) + integration round `wf_52f47b76-660` (5 agents + regression review, 3 findings fixed); gate server 1309 / agent 573 / client 131 / hub 197 | 7 h | 2026-10-30 05:00 |
| Full audit bug-hunt (lens × scope finders until dry, 3 refuters each, grouped fixes) — owner ask | pending | ~4 h | — |
| Final gate + screenshots + HANDOFF/CLAUDE.md rewrite (correction notes from the verifier's docs check) | pending | 1 h | — |
| **Total remaining** | | **~5 h** (fix round, audit, final gate) | |

Faster option: verification can be cut to one reviewer and one fix round per category
(~30% less time, less thorough). Not applied unless requested.

## Phases

- [x] **Blueprint** — architecture, data model, security model, all 30 categories / 212 functions specified
- [x] **P0 Foundation** — workspace, config, SQLite schema + migrations + seed, session auth + bcrypt + TOTP 2FA, RBAC, CSRF, validation, audit log, agent protocol + `whm-agentd` skeleton, capability detection, jobs + scheduler
  - [x] root workspace (`package.json`, `.gitignore`, `.env.example`)
  - [x] `server/src/config.js`, `logger.js`, `lib/errors.js`, `lib/validate.js`, `lib/crypto.js`
  - [x] `server/src/db/` (migrations, seed, session store)
  - [x] middleware (auth, rbac, csrf, audit, error)
  - [x] `lib/agent-client.js` (monolithic + socket), `lib/capabilities.js`, `lib/cron.js`, `lib/jobs.js` (SSE), `lib/scheduler.js`
  - [x] `agent/` daemon + op catalog (`sys`, `svc`, `user`, `fs` real — 40 ops; `web`/`dns`/`db`/`mail`/`net`/`ssl`/`sec` families arrive with their categories)
  - [x] routes/services: auth (login, 2FA, password), system (status, processes, services, jobs, schedules, settings, audit), accounts, packages + feature lists
  - [x] `npm install`, boot, end-to-end API smoke test (all steps green)
  - [x] vitest unit + API tests — server 93 tests (cron, validate, crypto, jobs/scheduler, full API incl. RBAC/CSRF/rollback/audit/2FA), agent 42 tests (registry injection rejection, path sandbox, exec, side-effect-free ops)
- [x] **P1 Shell** — React layout (top bar, searchable collapsible sidebar with all 30 categories), home dashboard (Statistics + Tools grid + Favorites), login/2FA pages, shared components (DataTable, Form fields, ConfigPage, ActionPage, Toast, Modal, StatusPill, ProgressLog), `nav.js` as single source of truth, a route for every one of the 212 functions *(WizardPage arrives with Transfer Tool / IP Migration in P4)*
- [x] **P2 Core hosting** — Account Information, Account Functions, Multi Account, Packages + Feature Manager, DNS Functions + Zone Manager, Database Services, Service Configuration + Service Manager, Restart Services, Server Status, System Health
- [x] **P3 Security & mail** — Security Center, Email, Exim/Dovecot config, SSL/TLS + AutoSSL (ACME)
- [x] **P4 Resellers, IP, backup, transfers** — Resellers, IP Functions, Backup + scheduler + destinations, Transfers + Transfer Tool, Networking Setup, Server Contacts, System Reboot
- [x] **P5 Software & platform** — Software (MultiPHP, EasyApache, updates), Locales, Clusters, Themes, Market, cPanel section, Development (API tokens, hooks, OpenAPI), Support, **license client + hub/license server, plugin host + plugin marketplace, sample + automated-backup plugins** *(deferred items land here)*
- [ ] **P6 Hardening & deploy** — `scripts/install.sh`, systemd units, panel TLS, Security Advisor rules, docs, e2e tests, performance pass

## Deferred work (do at the end — Phase 5)

- [x] License server design (saved: `docs/design/license-server.md`; to be integrated as BLUEPRINT §16)
- [x] Plugin SDK reference code: `plugins/sdk/` — mock host with permission gate, manifest validator + constants, JSON Schema, semver/cron helpers, errors, 56 passing tests
- [x] `plugins/SDK.md` — binding plugin contract document (BLUEPRINT §17) *(written against the real host; Phase-5 round 1)*
- [x] Plugin marketplace design (BLUEPRINT §18; `docs/design/marketplace.md`, 683 lines, two critique passes): open developer registration → backend verification queue → submission → automated scan → human review → marketplace signing → publish/revoke; catalog API; panel integration
- [x] `plugins/sample-plugin/` (`net.whm.sample-notes`) — canonical template exercising every extension point, node:test suite, signed `.whmplugin` fixture
- [x] `plugins/bundled/net.whm.automated-backup/` (fourth bundled plugin) — cron schedule, scope, per-account locks, destinations, checksum verify, daily/weekly/monthly retention, restore, notifications, with tests
- [x] Panel: `server/src/services/plugins.js` (plugin host), `license.js` + `routes/license.js` + migration 031 (offline verify, check-in, grace/degraded, feature gates, License tab, banners), `marketplace-client.js` + migration 032 (Marketplace tab with consent, hub catalog, revocation polling, developer mode)
- [x] `hub/license/`, `hub/marketplace/` (181 node:test cases) and `hub/ui/` (105 tests; vendor admin, developer and reseller portals) — built, reviewed, fix round closed (`e49e500`); live hub+panel end-to-end flow in progress
- `plugins/sdk/pack.js` + `scripts/build-plugin.js` — pack/sign/verify `.whmplugin` packages (parity-tested against the host) — done (round 1)

## Owner's issue list (2026-10-29, live server 3.7.253.240) — status

Legend: **done** = built, reviewed, fix round closed, in the tree · **built** = built, review/fix round still running · **partial** · **open**.
Round history: platform-fixes build (9 units) → adversarial review (two lenses for root/signing code) → fix round (`platform-leftovers.md`) → integration round 2026-10-30 (shared files, agent op `web.module.enable`, installer `--stack`/`/etc/whm/tls`, docs).

| # | Finding | Status / where |
|---|---|---|
| 1 | Installer does not ask which stack to install (2 presets + manual) | done — `scripts/install.sh --stack full\|web\|none` (+ numbered menu on a terminal, `WHM_STACK`), `--components a,b,c` for a manual pick; both read the panel's `stack-catalog.js`; first-login setup wizard (`/setup`) offers the same profiles |
| 2 | Missing services show Restart instead of Install | done — Service Manager: Install / Repair actions, server stack card (one `stack.install` job at a time, package index refreshed first) |
| 3 | Refresh package index shows the job but no list | done — switches to the Installed packages tab after the job |
| 4 | Initial Quota Setup has extra cards | done — two cards (Summary, Filesystems with the group-quota switch in its header), manual steps behind *Show manual steps*; MANUAL §1.5 updated |
| 5 | HTTPS by default everywhere | done — panel 2086→2087 redirect (`panel.force_https`, `WHM_FORCE_HTTPS`), vhost HTTP→HTTPS when a certificate exists (`web.force_https`, toggle in Apache Configuration), ACME path exempt, panel pair at `/etc/whm/tls/{cert,key}.pem` (installer + `whm.conf`) so the hostname certificate goes live without a restart; agent op `web.module.enable` for mod_rewrite |
| 6 | `timedatectl` rejects Asia/Calcutta | done — host zone list (`sys.time.zones`), ICU legacy ids mapped to current names |
| 7 | Statistics Software Configuration says "not installed" with no install button | done — per-generator Install buttons (install-from-panel) |
| 8 | Web terminal slow and laggy | done — long-polled `terminal.read` (waitMs), input wake-up without idle spacing, bounded relay rate, 16 ms client flush |
| 9 | WHM Marketplace "Install" redirects instead of installing | done — installs the host packages inline with a job log |
| 10 | Install missing services directly; Repair broken ones | done — same as 2 (`svc.reset_failed` + restart + journal tail) |
| 11 | SMTP Restrictions: iptables RULE_APPEND failed (nf_tables) | done — REJECT rule carries `-p tcp` (`agent/test/sec-smtp.test.js`) |
| 12 | External authentication presets (Google, Meta, Apple, Cloudflare…) | done — preset cards: Google, Microsoft, Apple, Meta, Cloudflare Access, GitLab, Auth0/Okta/Keycloak/generic; GitHub listed as unsupported (no OIDC); discovery must validate before a preset is stored |
| 13 | ModSecurity configuration/tools/vendors "not installed" | done — Install button on the three pages (capability `modsecurity` → packages; Apache reloaded on RHEL) |
| 14 | Contact Manager: Exim not installed | done — Install Exim from the notice |
| 15 | No mail transport in System Mail Preferences | done — same install path |
| 16 | Apache Configuration shows not installed | done — Install Apache from the notice; stack profile installs it |
| 17 | Account manager on create/modify + support chat | done — `accounts.manager_user_id` (034 + 034b backfill), Support › Account Conversations (manager ↔ account, SSE, message text kept out of the audit log), manager column in List Accounts |
| 18 | Rename cPanel → HST Panel | done — `client/src/brand.js`, labels renamed with stable slugs, `en.json` catalog, migrations `029c`/`011b`, manuals and README naming note |
| 19 | First install asks which services to use | done — installer menu + setup wizard step "Services" (profiles Full / Web + database / Manual); *Skip for now* allowed while unlicensed |
| 20 | Two CLI commands: default stack install, manual selection | done — `install.sh --stack full` (default profile; also with `--upgrade` on an installed panel) and `install.sh --components apache,php,…` (manual selection); the API equivalent is `POST /api/system/stack/install`. A `whm-cli install-stack` alias is not built (would duplicate `install.sh`; listed in HANDOFF as optional) |
| 21 | Branded index/welcome page for new sites and the hostname, editable | done — templates `index` + `landing` (Web Template Editor, live re-render on save), hostname landing vhost no account can take over (`ctx.web.isServerName`); license-group option deferred to the hub |
| 22 | Hostname records recreated + SSL installed automatically | done — Change Hostname: A/AAAA/www/MX records, certificate step (ACME) installed for panel/exim/dovecot/ftp, *Reissue hostname certificate*, daily renewal schedule |
| 23 | Cloudflare DNS management | done — DNS Zone Manager › Cloudflare (token, link/import/push with per-zone lock and bounded retries, sync log), migration 035 |
| 24 | Hide the license hub from everyone but the super admin; password-protected setup command | done — `users.superadmin` (001e), `whm-cli superadmin` gated by the setup password (`/etc/whm/superadmin.key`, root-owned), License tab, marketplace/market hub origin and audit text hidden for other roots |
| 25 | Installer: company logo, friendlier flow | done — HST Panel banner, stack menu, hub URL and super admin prompts (each with a non-interactive variable), TLS/stack/super-admin lines in the summary |
| 26 | Hub: `licserver.hostingsignal.in` default, hidden calls, authenticator support on all dashboards | done — default URLs, server-side-only hub calls, forced TOTP enrolment (`hub.require_totp_for_admins`), login/step-up with once-per-step codes for vendor, reseller and developer portal users |
| — | "Full audit, find more bugs" | pending — `full-audit` workflow after the fix round |

## Functions — all 31 categories (216)

### 1. Server Configuration
- [x] Basic WebHost Manager Setup
- [x] Change Root Password
- [x] Configure cPanel Analytics
- [x] Configure cPanel Cron Jobs
- [x] Initial Quota Setup
- [x] Link Server Nodes
- [x] Server Profile
- [x] Server Time
- [x] Statistics Software Configuration
- [x] Terminal
- [x] Tweak Settings
- [x] Update Preferences
- [x] WHM Marketplace *(hub catalog when the `whm-hub` provider is enabled — confirmed in the live hub+panel flow; static catalog as the fallback)*

### 2. Support
- [x] Create Support Ticket
- [x] Grant cPanel Support Access
- [x] Support Center
- [x] Account Conversations *(our addition 2026-10-29: one thread per account between the account manager and the account)*

### 3. Networking Setup
- [x] Change Hostname
- [x] Resolver Configuration

### 4. Security Center
- [x] Apache mod_userdir Tweak
- [x] SMTP Restrictions
- [x] Compiler Access
- [x] Configure Security Policies
- [x] cPHulk Brute Force Protection
- [x] Host Access Control
- [x] Manage External Authentications
- [x] Manage root's SSH Keys
- [x] Manage Wheel Group Users
- [x] ModSecurity Configuration
- [x] ModSecurity Tools
- [x] ModSecurity Vendors
- [x] Password Strength Configuration
- [x] Security Advisor
- [x] Security Questions
- [x] Shell Fork Bomb Protection
- [x] SSH Password Authorization Tweak
- [x] Traceroute Enable/Disable
- [x] Two-Factor Authentication

### 5. Server Contacts
- [x] Contact Manager
- [x] Edit System Mail Preferences

### 6. Resellers
- [x] Change Ownership of an Account
- [x] Change Ownership of Multiple Accounts
- [x] Edit Reseller Nameservers and Privileges
- [x] Email All Resellers
- [x] Manage Reseller's IP Delegation
- [x] Manage Reseller's Shared IP
- [x] Reseller Center
- [x] Reset Resellers
- [x] Show Reseller Accounts
- [x] View Reseller Usage and Manage Account Status

### 7. Service Configuration
- [x] Apache Configuration
- [x] cPanel Log Rotation Configuration
- [x] cPanel Web Disk Configuration
- [x] cPanel Web Services Configuration
- [x] Exim Configuration Manager
- [x] FTP Server Selection
- [x] Mailserver Configuration
- [x] Manage Service SSL Certificates
- [x] Nameserver Selection
- [x] Service Manager

### 8. Locales
- [x] Configure Application Locales
- [x] Copy a Locale
- [x] Delete a Locale
- [x] Edit a Locale
- [x] Locale XML Download
- [x] Locale XML Upload
- [x] View Available Locales

### 9. Backup
- [x] Backup Configuration
- [x] Backup Restoration
- [x] Backup User Selection
- [x] File and Directory Restoration

### 10. Clusters
- [x] Configuration Cluster
- [x] DNS Cluster

### 11. System Reboot
- [x] Forceful Server Reboot
- [x] Graceful Server Reboot

### 12. Server Status
- [x] Apache Status
- [x] Daily Process Log
- [x] Server Information
- [x] Service Status
- [x] Task Queue Monitor

### 13. Account Information
- [x] List Accounts
- [x] List Parked Domains
- [x] List Subdomains
- [x] List Suspended Accounts
- [x] Manage Account Enhancements
- [x] Show Accounts Over Quota
- [x] View Bandwidth Usage

### 14. Account Functions
- [x] Change Site's IP Address
- [x] Create a New Account
- [x] Email All Users
- [x] Force Password Change
- [x] Limit Bandwidth Usage
- [x] Manage Account Suspension
- [x] Manage Demo Mode
- [x] Manage Shell Access
- [x] Modify an Account
- [x] Password Modification
- [x] Quota Modification
- [x] Raw Apache Log Download
- [x] Raw NGINX Log Download
- [x] Rearrange an Account
- [x] Reset Account Bandwidth Limit
- [x] Terminate Accounts
- [x] Unsuspend Bandwidth Exceeders
- [x] Upgrade/Downgrade an Account
- [x] Web Log Retention
- [x] Web Template Editor

### 15. Multi Account Functions
- [x] Change Multiple Sites' IP Addresses
- [x] Modify/Upgrade Multiple Accounts

### 16. Transfers
- [x] Convert Addon Domain to Account
- [x] Review Transfers and Restores
- [x] Transfer or Restore a cPanel Account
- [x] Transfer Tool

### 17. Themes
- [x] Theme Manager

### 18. Packages
- [x] Add a Package
- [x] Delete a Package
- [x] Edit a Package
- [x] Feature Manager

### 19. DNS Functions
- [x] Add a DNS Zone
- [x] Add an A Entry for Your Hostname
- [x] Delete a DNS Zone
- [x] DNS Zone Manager
- [x] Edit Zone Templates
- [x] Email DNS Record Manager
- [x] Email Routing Configuration
- [x] Enable DKIM/SPF Globally
- [x] Nameserver Record Report
- [x] Park a Domain
- [x] Perform a DNS Cleanup
- [x] Set Zone TTL
- [x] Setup/Edit Domain Forwarding
- [x] Synchronize DNS Records

### 20. Database Services
- [x] Change Database Root Password
- [x] Change Database User Password
- [x] Database Map Tool
- [x] Edit Database Configuration
- [x] Manage Database Access Hosts
- [x] Manage Database Profiles
- [x] Manage Database Users
- [x] Manage Databases
- [x] phpMyAdmin
- [x] Repair Databases
- [x] Show Database Processes
- [x] Upgrade Database Version

### 21. IP Functions
- [x] IPv6 Ranges
- [x] Add a New IP Address
- [x] Assign IPv6 Address
- [x] Configure Remote Service IPs
- [x] IP Migration Wizard
- [x] Rebuild the IP Address Pool
- [x] Show IP Address Usage
- [x] Show or Delete Current IP Addresses
- [x] Show/Edit Reserved IPs

### 22. Software
- [x] Install a Perl Module
- [x] Install Distro Packages
- [x] Module Installers
- [x] MultiPHP INI Editor
- [x] MultiPHP Manager
- [x] NGINX Manager
- [x] Rebuild RPM Database
- [x] System Update
- [x] Update Server Software
- [x] EasyApache 4

### 23. Email
- [x] Email Deliverability
- [x] Filter Incoming Emails by Country
- [x] Filter Incoming Emails by Domain
- [x] Greylisting
- [x] Mail Delivery Reports
- [x] Mail Queue Manager
- [x] Mail Troubleshooter
- [x] Mailbox Conversion
- [x] Repair Mailbox Permissions
- [x] Spamd Startup Configuration
- [x] View Mail Statistics Summary
- [x] View Relayers
- [x] View Sent Summary

### 24. System Health
- [x] Background Process Killer
- [x] Process Manager
- [x] Show Current Disk Usage
- [x] Show Current Running Processes

### 25. cPanel
- [x] Change Log
- [x] Customization
- [x] Manage Plugins
- [x] Modify cPanel & WHM News
- [x] Reset a Mailman Password
- [x] Upgrade to Latest Version

### 26. SSL/TLS
- [x] Generate an SSL Certificate and Signing Request
- [x] Install an SSL Certificate on a Domain
- [x] Manage AutoSSL
- [x] Manage SSL Hosts
- [~] Purchase and Install an SSL Certificate *(Provider list from settings market.providers (default cpstore, disabled), order flow records an ssl_orders row + generates/stores a CSR (wil)*
- [x] SSL Storage Manager
- [x] SSL/TLS Configuration

### 27. Market
- [x] Market Provider Manager

### 28. Restart Services
- [x] Database Server
- [x] DNS Server
- [x] HTTP Server (Apache)
- [x] IMAP Server
- [x] Mail Server (Exim)
- [x] Mailing List Manager (Mailman)
- [x] PHP-FPM service for Apache
- [x] SSH Server (OpenSSH)

### 29. Development
- [x] OpenAPI Documentation for cPanel
- [x] OpenAPI Documentation for WHM
- [x] Apps Managed by AppConfig
- [x] cPanel Development Forum
- [x] cPanel Plugin File Generator
- [x] Developer Documentation
- [x] Manage API Tokens
- [x] Manage Hooks

### 30. Plugins
- [x] ImunifyAV
- [x] Server Monitoring
- [x] WP Toolkit

### 31. Application Manager *(our addition — user ask 2026-10-29: Node.js, Python, React/Angular… app hosting)*
- [x] Application Manager
- [x] Runtime Versions
- [x] Application Templates

## Cross-cutting

- [x] Home dashboard: Statistics panel, Tools grid, Favorites, global search
- [x] Login, 2FA enrollment/verification, forced password change
- [x] Audit log viewer
- [x] Job queue + progress streaming (SSE) — Task Queue Monitor
- [x] Capability detection + "service not installed" prompts
- [x] Unit tests (vitest) · API tests (supertest) · agent op schema tests · e2e (playwright)
- [x] `scripts/install.sh`, `deploy/whm-panel.service`, `deploy/whm-agentd.service`
- [x] README (install / run / deploy / security)
