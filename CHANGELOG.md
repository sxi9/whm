# Changelog

All notable changes to the WHM control panel are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The panel renders this file under
**cPanel › Change Log**; keep the newest release at the top and write entries for operators,
not for the commit log.

## [Unreleased]

### Added
- Live-host verification (2026-11-04/05): the panel was audited on a production Ubuntu 26.04
  install (Exim unsplit layout, Dovecot 2.4, MariaDB, pure-ftpd, BIND, certbot); the fixes below
  come from its 29 confirmed findings.
- Virtual mailboxes are wired into Exim and Dovecot by the panel itself: job
  `panel.virtual_mail.ensure` at boot and on the first mailbox, admin status/apply under
  Service Configuration › Exim Configuration Manager ("Virtual mailboxes" card,
  `GET/POST /api/service-config/virtual-mail[/apply]`); Dovecot 2.3 and 2.4 fragments; on an
  unsplit Debian or RHEL layout the exact `.include_if_exists` lines to add once are shown.
- Exim Configuration Manager: "Submission ports 465/587" (`submissionPorts`; 465 only with the
  Exim TLS preset) and Dovecot-backed SMTP AUTH; the account panel's mail client settings follow it.
- HTTP→HTTPS: with a certificate configured, port 2086 redirects pages to 2087 and refuses API
  calls with 426 `tls_required` (`WHM_HTTP_REDIRECT` / `httpRedirect`, default on; `GET /api/health`
  stays reachable); the TLS pair reloads on SIGHUP or when the files change.
- AutoSSL can issue for the server hostname (`basic.hostname`, root only) and installs the result on
  the panel, Exim, Dovecot and Apache; `www.` is left out up front when it has no DNS record or
  points elsewhere.
- Security Advisor: account-panel mail wiring findings (`panel.mail.*`) and a distribution-backport
  check for PHP advisories (`pkg.php.backports` reads the package changelog on Debian/RHEL).
- Hub: vendor admins must enrol TOTP before using the API (`license.require_admin_totp`, default on).
- Account panel: database job progress for role `user` (`/api/panel/databases/jobs/:id[/stream]`);
  FTP connection details show the daemon's effective TLS mode with a hint when it differs from the
  configured one.
- Install Distro Packages search accepts up to four words.
- cPanel category: Change Log, Customization (branding, logos, help links, login notice),
  Manage Plugins settings and permission descriptions, cPanel & WHM News, Reset a Mailman
  Password, Upgrade to Latest Version (verified release download, detached installer run).

### Changed
- Dovecot passwd-file lines are keyed `local@domain` on every Dovecot version; existing files are
  re-keyed once (`vmail.passwd.rekey`) before the new configuration is applied.
- The panel service certificate is written to `/etc/whm/ssl/panel.crt` and `panel.key` (0640,
  group `whmpanel`), the pair the installer configures; a legacy `/etc/whm/tls` pair is kept only
  while `panel.env`/`whm.conf` still point at it.
- Dovecot 2.4 service certificates use `ssl_server_cert_file`/`ssl_server_key_file`.
- PHP-FPM service unit is discovered as the newest `php<major>.<minor>-fpm` unit present
  (migration `001d` updates existing installs); versioned `php-fpm` binaries count for the `php`
  capability.
- Capabilities refresh after package install/remove jobs; a 501 is logged at warn without a
  synthetic stack trace, 400/404/409/413/422 at info.
- Group names are resolved with `getent` (NSS) before falling back to `/etc/group`.
- e2e scripts default to `https://127.0.0.1:2087` and accept the installer's self-signed certificate.
- `scripts/install.sh` installs every workspace with one root `npm ci` and prunes dev dependencies last.

### Fixed
- Subdomain and addon docroots were created `user:user 0750`, so Apache answered 403; they are now
  handed to the web server group by root (0755 only when no web server is installed).
- `db.revoke` emitted `REVOKE ALL PRIVILEGES, GRANT OPTION ON db.*` (syntax error): changing or
  narrowing grants failed.
- Virtual FTP logins could not log in on Debian: pure-ftpd loads PureDB only through
  `/etc/pure-ftpd/auth/50puredb`, which is now detected and created.
- Mailbox creation returned no warning while Exim/Dovecot were not serving the mailbox
  (`virtual_mail_not_live`).
- The 97-whm-mailserver.conf fragment used Dovecot 2.3 names rejected by 2.4; ManageSieve's
  deprecated port 2000 is disabled when sieve is a protocol.
- File manager: a double-click resolved the second click against the new directory
  (`public_html/public_html`).
- `/api/panel/logs` listed the main domain twice; "No certificate is installed on X not found".
- Manage Service SSL Certificates named `/etc/whm/tls` for the panel certificate.
- Hub TOTP-enrolment hold no longer blocks the portal shell and assets, and compares the `/v1`
  path case-insensitively.

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
