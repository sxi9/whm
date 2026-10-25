# WHM Control Panel — Build Checklist

> Living tracker. **Update this file on every push.** Legend: `[ ]` not started ·
> `[~]` scaffolded (route + page + API stub exist, not yet fully implemented) ·
> `[x]` implemented and verified (tests pass, reviewed).
>
> Design: [BLUEPRINT.md](BLUEPRINT.md) · Project memory/conventions: [CLAUDE.md](CLAUDE.md)

## Current state

- **Branch:** `claude/trusting-cori-ifp7wy` · **Last updated:** 2026-10-25
- **Done:** full blueprint; license-server design (`docs/design/license-server.md`); plugin SDK reference code (`plugins/sdk/`, 56 tests passing); **Phase 0 foundation runs end-to-end** (boot → migrate → seed → login/forced password change → CSRF → status/services → packages CRUD → create a real Linux account → suspend/unsuspend/modify → terminate → audit).
- **In progress:** vitest unit + API suites for server and agent; then Phase 1 shell.
- **Deferred to the end (user decision):** license server, plugin marketplace, plugin host, sample + automated-backup plugins (Phase 5).

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
  - [ ] vitest unit + API tests (server, agent)
- [ ] **P1 Shell** — React layout (top bar, searchable collapsible sidebar with all 30 categories), home dashboard (Statistics + Tools grid + Favorites), login/2FA pages, shared components (DataTable, Form fields, ConfigPage, ActionPage, WizardPage, Toast, Modal, StatusPill, ProgressLog), `nav.js` as single source of truth, a route for every one of the 212 functions
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
- [ ] Basic WebHost Manager Setup
- [ ] Change Root Password
- [ ] Configure cPanel Analytics
- [ ] Configure cPanel Cron Jobs
- [ ] Initial Quota Setup
- [ ] Link Server Nodes
- [ ] Server Profile
- [ ] Server Time
- [ ] Statistics Software Configuration
- [ ] Terminal
- [ ] Tweak Settings
- [ ] Update Preferences
- [ ] WHM Marketplace

### 2. Support
- [ ] Create Support Ticket
- [ ] Grant cPanel Support Access
- [ ] Support Center

### 3. Networking Setup
- [ ] Change Hostname
- [ ] Resolver Configuration

### 4. Security Center
- [ ] Apache mod_userdir Tweak
- [ ] SMTP Restrictions
- [ ] Compiler Access
- [ ] Configure Security Policies
- [ ] cPHulk Brute Force Protection
- [ ] Host Access Control
- [ ] Manage External Authentications
- [ ] Manage root's SSH Keys
- [ ] Manage Wheel Group Users
- [ ] ModSecurity Configuration
- [ ] ModSecurity Tools
- [ ] ModSecurity Vendors
- [ ] Password Strength Configuration
- [ ] Security Advisor
- [ ] Security Questions
- [ ] Shell Fork Bomb Protection
- [ ] SSH Password Authorization Tweak
- [ ] Traceroute Enable/Disable
- [ ] Two-Factor Authentication

### 5. Server Contacts
- [ ] Contact Manager
- [ ] Edit System Mail Preferences

### 6. Resellers
- [ ] Change Ownership of an Account
- [ ] Change Ownership of Multiple Accounts
- [ ] Edit Reseller Nameservers and Privileges
- [ ] Email All Resellers
- [ ] Manage Reseller's IP Delegation
- [ ] Manage Reseller's Shared IP
- [ ] Reseller Center
- [ ] Reset Resellers
- [ ] Show Reseller Accounts
- [ ] View Reseller Usage and Manage Account Status

### 7. Service Configuration
- [ ] Apache Configuration
- [ ] cPanel Log Rotation Configuration
- [ ] cPanel Web Disk Configuration
- [ ] cPanel Web Services Configuration
- [ ] Exim Configuration Manager
- [ ] FTP Server Selection
- [ ] Mailserver Configuration
- [ ] Manage Service SSL Certificates
- [ ] Nameserver Selection
- [ ] Service Manager

### 8. Locales
- [ ] Configure Application Locales
- [ ] Copy a Locale
- [ ] Delete a Locale
- [ ] Edit a Locale
- [ ] Locale XML Download
- [ ] Locale XML Upload
- [ ] View Available Locales

### 9. Backup
- [ ] Backup Configuration
- [ ] Backup Restoration
- [ ] Backup User Selection
- [ ] File and Directory Restoration

### 10. Clusters
- [ ] Configuration Cluster
- [ ] DNS Cluster

### 11. System Reboot
- [ ] Forceful Server Reboot
- [ ] Graceful Server Reboot

### 12. Server Status
- [ ] Apache Status
- [ ] Daily Process Log
- [ ] Server Information
- [ ] Service Status
- [ ] Task Queue Monitor

### 13. Account Information
- [ ] List Accounts
- [ ] List Parked Domains
- [ ] List Subdomains
- [ ] List Suspended Accounts
- [ ] Manage Account Enhancements
- [ ] Show Accounts Over Quota
- [ ] View Bandwidth Usage

### 14. Account Functions
- [ ] Change Site's IP Address
- [ ] Create a New Account
- [ ] Email All Users
- [ ] Force Password Change
- [ ] Limit Bandwidth Usage
- [ ] Manage Account Suspension
- [ ] Manage Demo Mode
- [ ] Manage Shell Access
- [ ] Modify an Account
- [ ] Password Modification
- [ ] Quota Modification
- [ ] Raw Apache Log Download
- [ ] Raw NGINX Log Download
- [ ] Rearrange an Account
- [ ] Reset Account Bandwidth Limit
- [ ] Terminate Accounts
- [ ] Unsuspend Bandwidth Exceeders
- [ ] Upgrade/Downgrade an Account
- [ ] Web Log Retention
- [ ] Web Template Editor

### 15. Multi Account Functions
- [ ] Change Multiple Sites' IP Addresses
- [ ] Modify/Upgrade Multiple Accounts

### 16. Transfers
- [ ] Convert Addon Domain to Account
- [ ] Review Transfers and Restores
- [ ] Transfer or Restore a cPanel Account
- [ ] Transfer Tool

### 17. Themes
- [ ] Theme Manager

### 18. Packages
- [ ] Add a Package
- [ ] Delete a Package
- [ ] Edit a Package
- [ ] Feature Manager

### 19. DNS Functions
- [ ] Add a DNS Zone
- [ ] Add an A Entry for Your Hostname
- [ ] Delete a DNS Zone
- [ ] DNS Zone Manager
- [ ] Edit Zone Templates
- [ ] Email DNS Record Manager
- [ ] Email Routing Configuration
- [ ] Enable DKIM/SPF Globally
- [ ] Nameserver Record Report
- [ ] Park a Domain
- [ ] Perform a DNS Cleanup
- [ ] Set Zone TTL
- [ ] Setup/Edit Domain Forwarding
- [ ] Synchronize DNS Records

### 20. Database Services
- [ ] Change Database Root Password
- [ ] Change Database User Password
- [ ] Database Map Tool
- [ ] Edit Database Configuration
- [ ] Manage Database Access Hosts
- [ ] Manage Database Profiles
- [ ] Manage Database Users
- [ ] Manage Databases
- [ ] phpMyAdmin
- [ ] Repair Databases
- [ ] Show Database Processes
- [ ] Upgrade Database Version

### 21. IP Functions
- [ ] IPv6 Ranges
- [ ] Add a New IP Address
- [ ] Assign IPv6 Address
- [ ] Configure Remote Service IPs
- [ ] IP Migration Wizard
- [ ] Rebuild the IP Address Pool
- [ ] Show IP Address Usage
- [ ] Show or Delete Current IP Addresses
- [ ] Show/Edit Reserved IPs

### 22. Software
- [ ] Install a Perl Module
- [ ] Install Distro Packages
- [ ] Module Installers
- [ ] MultiPHP INI Editor
- [ ] MultiPHP Manager
- [ ] NGINX Manager
- [ ] Rebuild RPM Database
- [ ] System Update
- [ ] Update Server Software
- [ ] EasyApache 4

### 23. Email
- [ ] Email Deliverability
- [ ] Filter Incoming Emails by Country
- [ ] Filter Incoming Emails by Domain
- [ ] Greylisting
- [ ] Mail Delivery Reports
- [ ] Mail Queue Manager
- [ ] Mail Troubleshooter
- [ ] Mailbox Conversion
- [ ] Repair Mailbox Permissions
- [ ] Spamd Startup Configuration
- [ ] View Mail Statistics Summary
- [ ] View Relayers
- [ ] View Sent Summary

### 24. System Health
- [ ] Background Process Killer
- [ ] Process Manager
- [ ] Show Current Disk Usage
- [ ] Show Current Running Processes

### 25. cPanel
- [ ] Change Log
- [ ] Customization
- [ ] Manage Plugins
- [ ] Modify cPanel & WHM News
- [ ] Reset a Mailman Password
- [ ] Upgrade to Latest Version

### 26. SSL/TLS
- [ ] Generate an SSL Certificate and Signing Request
- [ ] Install an SSL Certificate on a Domain
- [ ] Manage AutoSSL
- [ ] Manage SSL Hosts
- [ ] Purchase and Install an SSL Certificate
- [ ] SSL Storage Manager
- [ ] SSL/TLS Configuration

### 27. Market
- [ ] Market Provider Manager

### 28. Restart Services
- [ ] Database Server
- [ ] DNS Server
- [ ] HTTP Server (Apache)
- [ ] IMAP Server
- [ ] Mail Server (Exim)
- [ ] Mailing List Manager (Mailman)
- [ ] PHP-FPM service for Apache
- [ ] SSH Server (OpenSSH)

### 29. Development
- [ ] OpenAPI Documentation for cPanel
- [ ] OpenAPI Documentation for WHM
- [ ] Apps Managed by AppConfig
- [ ] cPanel Development Forum
- [ ] cPanel Plugin File Generator
- [ ] Developer Documentation
- [ ] Manage API Tokens
- [ ] Manage Hooks

### 30. Plugins
- [ ] ImunifyAV
- [ ] Server Monitoring
- [ ] WP Toolkit

## Cross-cutting

- [ ] Home dashboard: Statistics panel, Tools grid, Favorites, global search
- [ ] Login, 2FA enrollment/verification, forced password change
- [ ] Audit log viewer
- [ ] Job queue + progress streaming (SSE)
- [ ] Capability detection + "service not installed" prompts
- [ ] Unit tests (vitest) · API tests (supertest) · agent op schema tests · e2e (playwright)
- [ ] `scripts/install.sh`, `deploy/whm-panel.service`, `deploy/whm-agentd.service`
- [ ] README (install / run / deploy / security)
