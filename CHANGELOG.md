# Changelog

All notable changes to the WHM control panel are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The panel renders this file under
**cPanel › Change Log**; keep the newest release at the top and write entries for operators,
not for the commit log.

## [Unreleased]

### Added
- **PHP source builds — every catalog PHP version installs on every supported host.** When no repository
  carries a version for the host (Ubuntu 26.04 "resolute" and `ppa:ondrej/php`), the catalog no longer marks it
  *Not available for this OS*: it is *Available* with `method: 'source'`, and Install (PHP Version Manager or
  Install Software › Runtimes, after a confirm that names php.net and the 15-minute build) compiles it from the
  official php.net release (`.tar.xz`, sha256 verified) into `/opt/keel/php/<minor>` with its own
  `keel-php<minor>-fpm` service, `/usr/local/bin/php<minor>` link and `lib/php.ini`. The build is a background
  agent run whose output streams into the job log (the last lines stay on failure); nothing is left behind when
  it fails. A built version is first class everywhere: *PHP x.y (Keel build)* with a **Keel build** pill in both
  pages, per-domain FPM pools (sockets under `/run/keel-php`), the INI editor, the CLI default and *Remove*
  (service, link and prefix). `POST /api/software/runtimes/install { runtime: 'php', version, method? }`
  (`package` | `source`; omitted = the server's choice, `package` on an unsupported repository answers `422`);
  `GET /api/software/php/catalog` and `GET /api/software/runtimes` carry `method` and `source`. Agent ops
  `pkg.php.build` / `pkg.php.build.finish`, shipped build script `agent/src/ops/php-build.sh` (parameters by
  environment only), allowed roots `/opt/keel/php` and `/run/keel-php`; contracts §51/§52, manual §22.2/§22.5.
- **Ports mirror cPanel:** the account panel is served on **2083** (HTTPS, `WHM_PANEL_PORT` / `panelPort`) and
  **2082** (plain, `WHM_PANEL_HTTP_PORT` / `panelHttpPort`); the administration shell stays on 2087/2086. The TLS
  panel listener opens only with a certificate and shares the certificate reload (SIGHUP / file change) with 2087;
  the plain one redirects (301) to 2083 and refuses `/api` (426) once TLS is on, like 2086. `0`/`off` disables a
  listener; a bind failure on 2082/2083 is logged and the administration listener keeps serving.
- **Shell detection** (`server/src/middleware/shell.js`): `req.shell` is `panel` when the request arrived on a panel
  port (socket port, never a header), else `admin`. On the panel shell only `/api/health`, `/api/auth/*`,
  `/api/branding*` and `/api/panel/*` are served; everything else under `/api` answers
  `403 { error: { code: 'wrong_port', message: 'The administration API is served on port 2087' } }`, and any page
  other than `/panel*`, `/login*` or an asset redirects to `/panel`.
- **Login policy:** on the panel shell an administrator or reseller login (password, 2FA completion, OpenID Connect)
  creates no session and answers `403 wrong_port` with `adminUrl: https://<host>:2087/login` (audit
  `auth.login.wrong_port`); the administration shell accepts every role as before.
- `GET /api/branding` and `GET /api/auth/me` carry `shell`; `/api/auth/me` gives administrators `panelUrl`
  (`https://<hostname>:2083/`), which is also the base of the password-reset mail link. Cluster self-detection knows
  the panel ports.
- `scripts/install.sh` prints both URLs and the firewall reminder for 2082, 2083, 2086 and 2087;
  `deploy/whm.conf.example`, `.env.example`, `docs/INSTALL.md` §2.2 and the configuration table, `docs/MANUAL.md`
  and `docs/MANUAL-partC.md` describe the split; `e2e/panel-check.cjs` runs the account sweep on `PANEL_BASE`
  (default `https://127.0.0.1:2083`).
- Tests: `server/test/shell-ports.test.js`.
- Software › PHP Version Manager (the former MultiPHP Manager, same URL): every PHP version of the
  catalog on one page with its state (installed, available, not available for this OS, unknown),
  PHP-FPM unit, default pill and domain count; per row Install (runtime installer job), Remove
  (`POST /api/software/php/remove` → job `software.php.remove` → agent `pkg.php.remove`; refused for
  the system default, the only version or a version domains use), Set as default, and an
  *Offered to accounts* switch (`PUT /api/software/php/offered`, setting `php.offered_versions`);
  `GET /api/software/php/catalog`; `?install=<version>` deep link. On Ubuntu the `ondrej/php` PPA is
  probed for the host's series first (agent `pkg.repo.status`), so a release it does not carry
  (26.04) is shown as unsupported instead of breaking `apt-get update`. Account panel › PHP versions:
  only offered versions are selectable (a version a domain already runs stays as "no longer offered"),
  a *Recommended* pill, *Your domains* usage counts and *Set all domains* (`PUT /api/panel/php/domains
  { version }`, `202` job with several domains; audit `panel.php.version_all`). Contract §52.
- Software › Install Software (the former Install Distro Packages page, same URL): one-click installs
  of PHP 8.5–7.4 (ondrej PPA on Ubuntu, packages.sury.org on Debian, Remi on RHEL), Node.js 24/22/20/18
  (official nodejs.org builds side by side under `/opt/keel/node/<major>` as `node<major>`; the panel's
  own Node.js is never touched), Python 3.13–3.9 (deadsnakes on Ubuntu), Ruby, Go, Composer and a tool
  grid (Git, ImageMagick, FFmpeg, Redis, Memcached, Certbot, BIND, ClamAV, …); `GET /api/software/runtimes`,
  `POST /api/software/runtimes/install|remove`, job `software.runtime.install` (adds the repository,
  refreshes the index only when one was added, restores the PHP CLI default the installer may have
  switched, re-detects and fails when still missing). Pages that find a tool missing (transfers, access
  grants, DNS cluster, Module Installers, PHP Version Manager, quotas, statistics software, phpMyAdmin,
  locales, IP functions) install it in place; the raw package search stays as the *Search* tab with
  `?tab=search&q=` deep links. Agent ops `pkg.os.release`, `pkg.repo.ensure` (enum: php, python, epel,
  remi), `pkg.node.list|install|remove`, `pkg.runtime.detect`; contract §51. Node tarballs are extracted
  with `--no-same-owner --no-same-permissions` and the extracted `bin/` must be root-owned before it goes
  live; every curl fetch pins `--proto-redir =https`; the composer probe runs with `--no-plugins
  --no-scripts` from `/`; `db.phpmyadmin.detect` adds `package` (bare package name) next to `packageHint`.
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
