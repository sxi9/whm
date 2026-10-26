# Changelog

All notable changes to the WHM control panel are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The panel renders this file under
**cPanel › Change Log**; keep the newest release at the top and write entries for operators,
not for the commit log.

## [Unreleased]

### Added
- cPanel category: Change Log, Customization (branding, logos, help links, login notice),
  Manage Plugins settings and permission descriptions, cPanel & WHM News, Reset a Mailman
  Password, Upgrade to Latest Version (verified release download, detached installer run).

## [0.1.0] - 2026-10-26

### Added
- Phase 2 wave 3: Themes (theme manager with token overrides and CSS uploads), Clusters,
  Server Profile-aware shell, plugin host merge.
- Plugin host (core): real implementation of the SDK host contract — `.whmplugin`
  packages, Ed25519 signatures with trusted keys, in-process `vm` context, settings,
  store, jobs, schedules, hooks, HTTP routes and UI pages; Manage Plugins page.
- Phase 2 wave 2: Account Functions, Account Information, Multi-Account Functions,
  Resellers, Backup, Transfers, Server Status, System Health, Server Configuration,
  Networking Setup, Server Contacts, System Reboot (12 categories).
- Login and session policy enforcement: session timeout, single session, password
  maximum age, required two-factor authentication for root and resellers, API tokens
  requiring 2FA, verified-IP login notifications; OpenID Connect external login.
- Phase 2 wave 1: Security Center, DNS Functions, Database Services, IP Functions,
  SSL/TLS, Email, Software, Service Configuration, Development, Locales — 222 agent ops.
- Deployment: `scripts/install.sh` (fresh install and `--upgrade`), systemd units and
  configuration templates, `scripts/whm-cli.js` admin CLI, Playwright UI check.
- Labelled screenshot galleries for every one of the 212 functions.

### Changed
- Split-mode agent socket timeout raised to one hour with a per-call override.
- Reseller nameservers are rendered into zones created for their accounts.
- Agent `config_invalid` errors map to HTTP 422.

### Fixed
- Every reviewer finding and integration seam from the wave-1 and wave-2 builds
  (see `docs/design/integration-contracts.md`).

## [0.0.2] - 2026-10-25

### Added
- Phase 1 shell: React SPA with all 30 categories and 212 functions wired through
  `client/src/nav.js`, WHM-style layout, dashboard, login with 2FA and forced password
  change, audit log, shared components and 29 live pages.
- Convention-based registration for categories, agent ops and pages; shared test helper.
- vitest suites for the server (93) and the agent (42).

## [0.0.1] - 2026-10-25

### Added
- Phase 0 foundation: Express API, root agent op catalog (`sys`/`svc`/`user`/`fs`),
  SQLite schema and migrations, authentication, RBAC, CSRF, audit log, jobs and scheduler.
- Blueprint (`BLUEPRINT.md`), checklist (`CHECKLIST.md`) and project memory (`CLAUDE.md`).
- Plugin SDK reference implementation (`plugins/sdk/`) and the license-server design.
