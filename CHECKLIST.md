# WHM Control Panel — Build Checklist

> Living tracker. **Update this file on every push.** Legend: `[ ]` not started ·
> `[~]` scaffolded (route + page + API stub exist, not yet fully implemented) ·
> `[x]` implemented and verified (tests pass, reviewed).
>
> Design: [BLUEPRINT.md](BLUEPRINT.md) · Project memory/conventions: [CLAUDE.md](CLAUDE.md)

## Current state

- **Branch:** `claude/trusting-cori-ifp7wy` · **Last updated:** 2026-10-26 20:45 UTC
- **Done:** full blueprint; license-server design (`docs/design/license-server.md`); plugin SDK reference code (`plugins/sdk/`, 56 tests passing); **Phase 0 foundation runs end-to-end** (boot → migrate → seed → login/forced password change → CSRF → status/services → packages CRUD → create a real Linux account → suspend/unsuspend/modify → terminate → audit).
- **Phase 1 shell is live:** React SPA with WHM-style top bar, searchable collapsible sidebar listing **all 212 functions in 30 categories**, home dashboard (Statistics + Tools grid + Favorites + service dots), login/2FA/forced-password-change, audit-log viewer, shared components (DataTable, forms, ConfigPage, ActionPage, ProgressLog, modals, toasts). 29 functions have real pages wired to the API (marked `[x]` below); the other 183 route to a placeholder page that names their build phase. Verified end to end with Playwright (login → create account via the form → lists/status/config pages → search).
- **Tests:** server 93/93, agent 42/42 passing (`npm test`). Shared API test helper: `server/test/support/app.js`.
- **Wave 1 landed** (`79097b1`, 2026-10-26 01:50): Security Center, DNS Functions, Database Services, IP Functions, SSL/TLS, Email, Software, Service Configuration, Development, Locales — 106/109 functions done (3 partial, noted inline), 222 new agent ops (267 total), migrations 002–012, 107 new pages; suites server 426 / agent 233 / client 5 green.
- **Wave-1 fix round done** (03:12): all 19 reviewer findings and the 6 integration seams closed per `docs/design/integration-contracts.md`; suites server 479 / agent 260 / client 5 green; final integration check passed.
- **Wave 2 landed** (19:00 UTC, 100 agent runs, 0 errors): Account Functions (incl. real vhost/DNS/mail provisioning on Create Account), Account Information, Multi Account, Resellers, Backup, Transfers, Server Status, System Health, Server Configuration, Networking Setup, Server Contacts, System Reboot — 67 functions built, 49 new agent ops (316 total), migrations 012–023; suites server 807 / agent 381 / client 7 green, build + boot + e2e pass. 10 reviewer findings stayed open after two in-wave fix rounds and were closed by the **wave-2 fix round** (20:40: 27 agent runs, 0 open, final integration check pass) together with the critic's 6 integration gaps (`docs/design/integration-contracts.md` §11–21).
- **Screenshots regenerated 20:44 UTC** at `de77602` (wave-2 fix round landed): all 212 function pages captured with label bars, **196/212 live** (the 67 in-flight wave-2 pages included; 16 wave-3 placeholders remain) — galleries in `docs/screenshots/`.
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
| Plugin host (core prerequisite for cPanel › Manage Plugins and the Plugins category) | running since 19:12 in an isolated worktree (built, review round 2) | ~2 h | ~21:30 |
| **P2 wave 3** — Clusters, Themes, Market, cPanel, Support, Plugins (6) | pending | ~3 h | ~00:45 (27th) |
| Integrate wave 3 → **all 212 functions live** (+ core follow-ups: Server Profile hides categories in the shell, reseller nameservers into DNS zones) | pending | ~1.5 h | ~02:15 (27th) |
| **P5 deferred** — license server (`hub/license`), plugin host + marketplace (`hub/marketplace`, open dev registration with backend verification), `plugins/SDK.md`, sample plugin, automated-backup plugin | pending | ~5 h | ~07:15 (27th) |
| **P6** — hardening pass, full e2e on a provisioned VM, Security Advisor rules (incl. the Oct-2026 PHP advisory check), final docs, performance | pending | ~2.5 h | ~09:45 (27th) |
| **Total remaining** | | **~13 h wall-clock** (from 20:45 on the 26th) | |

Faster option: verification can be cut to one reviewer and one fix round per category
(~30% less time, less thorough). Not applied unless requested.

## Phases

- [x] **Blueprint** — architecture, data model, security model, all 30 categories / 212 functions specified
- [ ] **P0 Foundation** — workspace, config, SQLite schema + migrations + seed, session auth + bcrypt + TOTP 2FA, RBAC, CSRF, validation, audit log, agent protocol + `whm-agentd` skeleton, capability detection, jobs + scheduler
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
- [ ] **P2 Core hosting** — Account Information, Account Functions, Multi Account, Packages + Feature Manager, DNS Functions + Zone Manager, Database Services, Service Configuration + Service Manager, Restart Services, Server Status, System Health
- [ ] **P3 Security & mail** — Security Center, Email, Exim/Dovecot config, SSL/TLS + AutoSSL (ACME)
- [ ] **P4 Resellers, IP, backup, transfers** — Resellers, IP Functions, Backup + scheduler + destinations, Transfers + Transfer Tool, Networking Setup, Server Contacts, System Reboot
- [ ] **P5 Software & platform** — Software (MultiPHP, EasyApache, updates), Locales, Clusters, Themes, Market, cPanel section, Development (API tokens, hooks, OpenAPI), Support, **license client + hub/license server, plugin host + plugin marketplace, sample + automated-backup plugins** *(deferred items land here)*
- [ ] **P6 Hardening & deploy** — `scripts/install.sh`, systemd units, panel TLS, Security Advisor rules, docs, e2e tests, performance pass

## Deferred work (do at the end — Phase 5)

- [x] License server design (saved: `docs/design/license-server.md`; to be integrated as BLUEPRINT §16)
- [x] Plugin SDK reference code: `plugins/sdk/` — mock host with permission gate, manifest validator + constants, JSON Schema, semver/cron helpers, errors, 56 passing tests
- [ ] `plugins/SDK.md` — binding plugin contract document (BLUEPRINT §17)
- [ ] Plugin marketplace design (BLUEPRINT §18): open developer registration → backend verification queue → submission → automated scan → human review → marketplace signing → publish/revoke; catalog API; panel integration
- [ ] `plugins/sample-plugin/` — canonical template exercising every extension point, with tests
- [ ] `plugins/automated-backup/` — cron schedule, scope, per-account locks, destinations, checksum verify, daily/weekly/monthly retention, restore, notifications, with tests
- [ ] Panel: `server/src/services/plugins.js` (plugin host), `license.js`, `marketplace-client.js`
- [ ] `hub/license/` and `hub/marketplace/` services
- Paused orchestration run to resume from: `wf_7104d0c5-441` (see CLAUDE.md → Resume notes)

## Functions — all 30 categories (212)

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
- [~] WHM Marketplace *(static catalog with installed detection; marketplace install arrives with Phase 5)*

### 2. Support
- [ ] Create Support Ticket
- [ ] Grant cPanel Support Access
- [ ] Support Center

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
- [ ] Configuration Cluster
- [ ] DNS Cluster

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
- [ ] Theme Manager

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
- [ ] Change Log
- [ ] Customization
- [ ] Manage Plugins
- [ ] Modify cPanel & WHM News
- [ ] Reset a Mailman Password
- [ ] Upgrade to Latest Version

### 26. SSL/TLS
- [x] Generate an SSL Certificate and Signing Request
- [x] Install an SSL Certificate on a Domain
- [x] Manage AutoSSL
- [x] Manage SSL Hosts
- [~] Purchase and Install an SSL Certificate *(Provider list from settings market.providers (default cpstore, disabled), order flow records an ssl_orders row + generates/stores a CSR (wil)*
- [x] SSL Storage Manager
- [x] SSL/TLS Configuration

### 27. Market
- [ ] Market Provider Manager

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
- [ ] ImunifyAV
- [ ] Server Monitoring
- [ ] WP Toolkit

## Cross-cutting

- [x] Home dashboard: Statistics panel, Tools grid, Favorites, global search
- [x] Login, 2FA enrollment/verification, forced password change
- [x] Audit log viewer
- [x] Job queue + progress streaming (SSE) — Task Queue Monitor
- [x] Capability detection + "service not installed" prompts
- [ ] Unit tests (vitest) · API tests (supertest) · agent op schema tests · e2e (playwright)
- [ ] `scripts/install.sh`, `deploy/whm-panel.service`, `deploy/whm-agentd.service`
- [ ] README (install / run / deploy / security)
