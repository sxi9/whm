# Changelog

All notable changes to the WHM control panel are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The panel renders this file under
**cPanel › Change Log**; keep the newest release at the top and write entries for operators,
not for the commit log.

## [Unreleased]

### Added
- **Calendars and Contacts (CalDAV/CardDAV) for every account.** Radicale from the distribution runs on loopback
  with bcrypt htpasswd logins the panel manages (`/etc/whm/radicale/users`, one collection tree per login) and is published
  as `/dav/` under the server hostname site; the admin installs and publishes it from *Service Configuration › Panel Web
  Services Configuration › Calendars (Radicale)* (`GET|POST|DELETE /api/service-config/dav[/install|/publish]`, job
  `dav.install`), the account panel's *Email › Calendars and contacts* page shows the server address, the account's DAV
  login (`<username>@<main domain>`, plus User Manager sub-users with the service on), sets or removes the DAV password
  (hashed by the panel; `PUT|DELETE /api/panel/email/calendars/:login/password`), lists the login's collections and
  carries Thunderbird / iOS / Android setup steps. Feature `caldav`, contract §70, migration `034h_panel-dav.sql`.
- **Account panel › Preferences › User manager.** Sub-users of a hosting account (cPanel's User Manager): a name on one
  of the account's domains with one password for every service — a mailbox (created through Email accounts, with its
  quota) and an FTP login limited to a folder of the account (created through FTP accounts), plus a *Calendars and
  contacts* flag for the CalDAV/CardDAV login. Switching a service on or off creates or removes it, the password reset
  reaches every enabled service, deleting the user removes its mailbox (with the mail) and its FTP login; never a Linux
  user. `GET|POST /api/panel/users`, `GET|PUT|DELETE /api/panel/users/:id`, `PUT /api/panel/users/:id/password`
  (session-only); plan feature `usermanager`, plan key `max_subusers`; migration `034g_panel-subusers.sql`. Contract §69,
  manual C §17.
- **Account panel › Advanced › Terminal.** A login shell of the account in the browser (xterm.js) when the plan grants
  shell access: the agent starts the shipped `term-bridge.py` as the account on a pty behind a unix socket under
  `/run/whm/term/<id>/` (first client only, 15 min idle, 4 h cap), the panel relays it over the WebSocket
  `/api/panel/terminal/ws` (single-use 30 s token + the session cookie, same-origin, one socket per shell, closed on
  logout); `POST/GET/DELETE /api/panel/terminal/sessions`, feature `terminal`, audit rows `panel.terminal.open/close`
  without content; a plan without shell answers 501 `shell_disabled` and the page says so. Requires `python3` on the host.
- **Direct Update buttons for critical issues (PHP and other software).** The admin Home opens with an *Updates that
  need attention* card whenever something needs one: installed PHP versions hit by an advisory from the Security
  Advisor's list (critical when the advisory is critical/high), pending security or regular package updates of the
  runtimes, tools and web stack (Apache, NGINX, Exim, Dovecot, MariaDB/MySQL, PostgreSQL, FTP, OpenSSL — from the cached
  OS update check), and Node.js builds under `/opt/keel/node` behind nodejs.org's latest release; each row carries the
  current and candidate version, the reasons and an **Update** button that runs the right job after a confirm (a version
  with an advisory but nothing newer to install shows *no fix available yet*). PHP Version Manager rows show
  **Update to x.y.z**, Install Software lists the installed runtimes/tools with updates above its tabs, and a Security
  Advisor PHP finding renders **Update PHP x.y to …** next to its fix link. `GET /api/software/updates/critical`
  (cached 10 min, `POST …/refresh`), `POST /api/software/php/update { version }` → job `software.php.update`
  (packages: `pkg.upgrade` of the version's pending packages + FPM reload; Keel build: `pkg.php.build` +
  `pkg.php.build.finish`, which now **restarts** a running `keel-php<minor>-fpm` and reports whether it is enabled; the
  rebuild keeps the version listed while it runs and keeps the operator's `php.ini`), `POST
  /api/software/runtimes/update { runtime, version | tool }` → job `software.runtime.update` (packages or a fresh
  nodejs.org build); read-only agent ops `pkg.php.release` / `pkg.node.release` (cached 6 h in settings). Contract §63,
  manual §22.2/§22.5.
- **Collapsible dashboard sections.** Every category on the admin Home *Tools* card and every group on the
  account panel home is a disclosure: its header (chevron, icon tile, name, function count) collapses or expands
  the tiles, with *Collapse all* / *Expand all* on the card and the same chevron on the *Favorites* card; a filter
  keeps every matching section open. The choice is remembered in the browser (`whm.home.sections`,
  `keel.panel.home.sections`; `{ slug: false }` = collapsed, open by default). The account panel sidebar gains the
  admin sidebar's *Expand all* / *Collapse all*, and in both sidebars the category of the current page is opened
  once per navigation and can be closed again. Headers carry `aria-expanded` / `aria-controls` and work from the
  keyboard (shared hook `client/src/hooks/useCollapsedSections.js`; manual A "Home", C §1.1).
- **Account panel › Software › Application manager (P3-2).** A Node.js or Python program of the account runs as the
  systemd service `keel-app-<account>.<name>` (fixed hardened template under `/etc/whm/apps`, the account's own uid,
  `NoNewPrivileges`, `ProtectSystem=strict` with the home writable, private `/tmp`, journal logs) on a port from
  `panel.app_port_range` (default 31000–31999) and is published on a path of one of the account's domains through
  the vhost's new reverse-proxy mounts (`ProxyPass` to loopback, WebSocket upgrade optional); the panel enables
  Apache's `proxy`, `proxy_http`, `proxy_wstunnel` and `rewrite` itself on first publish. Create / edit (runtime picker from the
  host's Keel Node.js builds, system node and Python minors), start / stop / restart, logs, *Install dependencies*
  as a job (`npm install --omit=dev`, or `.venv` + `pip install -r requirements.txt`, run as the account), remove
  (files kept). `GET|POST /api/panel/apps`, `GET /api/panel/apps/runtimes`, `GET|PUT|DELETE /api/panel/apps/:id`,
  `POST …/:id/start|stop|restart|deps`, `GET …/:id/logs`; agent `apps.unit.*`, `apps.deps.install`, `apps.port.free`,
  `web.modules.status|enable`, `web.vhost.write { proxies }`; `ctx.web.setProxies`; feature `applicationmanager`;
  migration `034f` (`panel_apps`, `web_vhosts.proxies_json`); contract §65, manual C §16.3.
- **Account panel › Files › Git version control (P3-1).** Repositories under the account home (`~/repositories/<name>`
  by default, or any home-relative folder): create an empty one, clone a public `https://` or deploy-key `ssh://`
  repository (a 15-minute job the account follows live), adopt a folder that already holds one, *Pull* (`git pull
  --ff-only`, job), *Deploy* (the `deployment: tasks:` list of `.keel.yml` — `cp`, `rsync`, `mkdir`, `rm`, `chmod` on
  paths inside the home, one program per task, never a shell; *Check tasks* shows the plan), *Forget* and *Remove*
  (the repository folder only). Every git command runs as the account with `GIT_TERMINAL_PROMPT=0`,
  `GIT_CONFIG_NOSYSTEM=1` and only the https/ssh transports; `file:`, `ext::` and URLs with a user name or password
  answer `422`. Feature `gitversioncontrol`, table `panel_git_repos` (migration `034f`), `ctx.panelGit`,
  `GET|POST /api/panel/git`, `GET|DELETE /api/panel/git/:id`, `POST …/:id/pull|deploy`, agent `git.*`; contract §64,
  manual C §5.5. Host needs `git`.
- **PostgreSQL remote access hosts (P3-4).** On a local PostgreSQL profile, *Remote hosts* (account panel) and *Manage
  Database Access Hosts* (console) now work: each account gets a managed block in `pg_hba.conf` (`host <its databases>
  <its users> <address> scram-sha-256`, agent `db.pg.hba.write`, reloaded with `pg_reload_conf()`), written before the row
  is recorded and rewritten whenever the account's databases or users change. Hosts may be IPs, networks in CIDR form
  (`203.0.113.0/24`), `%` patterns on dotted quads (converted), host names or `.domain` suffixes; `%` alone means `all`.
  A PostgreSQL server on another machine keeps the "not available" answer. Contract §67, manual B §20.5, manual C §7.3.
- **Forced 2FA for account users as a core login policy.** *Security Center › Two-Factor Authentication* (and
  *Configure Security Policies*) gain *Require two-factor authentication for account users*
  (`security.2fa.required_for_users`): an account holder who signs in without an authenticator is flagged
  `mustEnroll2fa` exactly like root and resellers, sees only the enrolment page until enrolled, and cannot disable it
  afterwards. The account panel's own *Require 2FA for account users* switch keeps working; either switch enforces, the
  panel settings card says so, `GET /api/panel/me` carries `mustEnroll2fa`, and Security Advisor reports the policy as
  required when either is on. Contract §66, manual §4.4/§4.19, Part C C.3/C.9.1.
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
- **Account panel › Logs › Errors (P2-5):** the newest lines of every error log of the account's domains (Apache and
  NGINX, server-side and own-folder, live files only) in one page, newest first, with a domain filter, 100–1000 lines and a
  10 s follow; feature `errlog`, `GET /api/panel/logs/errors?lines&domain` over the existing owner-checked range read
  (contract §62, manual C §11.4).
- **Review fixes (P2):** chunk uploads decide `truncate` before the agent call so two chunks in flight never wipe each
  other; the DDNS limiter counts only the public update (the panel page is never 429 behind a shared address), `POST`/
  `DELETE` are session-only, `GET /api/panel/dns/ddns/update` takes the token as the HTTP basic password and the request log
  redacts path tokens (DDNS and SSO); Track DNS refuses loopback, private, link-local and multicast targets (422);
  Feature Manager labels `traceroute`, `dbwizard`, `plugins`; contract sections renumbered 53–62 in order.
- **Account panel › DNS › Track DNS (P2-7):** record lookups (`dig +short`, A/AAAA/MX/NS/TXT/CNAME/SOA/PTR) and route
  traces (`traceroute -n -w 2 -m 20`, 60 s cap, one at a time per account) from the server, read-only, with the target
  pinned by the route, the agent schema and the argv (`GET /api/panel/dns/track/lookup?name=&type=`,
  `GET /api/panel/dns/track/trace?host=`, agent `dns.lookup` / `dns.trace`). Feature `traceroute` (new in the default
  feature list); needs `dnsutils` and `traceroute` on the host (501 with the package otherwise). Contract §60, manual C §3.3.
- **Account panel wording and accessibility (P2-12):** `501 shell_disabled` and the other plan-setting codes
  (`PLAN_SETTING_CODES` in `panel/PanelPage.jsx`) read "Not included in your plan" instead of "Not available on this server";
  the user menu is a real `role="menu"` with `menuitem` entries that closes on Escape and on a click outside; every usage bar
  is a `progressbar` with its percentage and figure (`panel/Meter.jsx`); the domain-type tabs on *Domains* carry
  `aria-controls` and arrow-key movement; the home page links a domain as `https://` when a valid certificate is installed on
  it (from `GET /api/panel/domains`). `e2e/panel-check.cjs` asserts all of it (step 3c). Contract §59, manual C.6.
- **Account panel › Databases › Database wizard (P2-4):** a three-step page (database → user → privileges) that
  composes the existing `POST /api/panel/databases`, `POST /api/panel/databases/users` and
  `PUT /api/panel/databases/users/:name/grants` calls — no new routes; every step is saved as it is taken and the final
  card shows the connection details. Nav `databases/wizard`, plan feature `dbwizard` (new in the default feature list,
  on; the calls stay gated by `mysql`/`postgres`), i18n `panel.databases.wizard_*`. Contract §61, manual C §7.5.
- **Account panel › Usage quota source note (P2-13):** when disk figures come from the scan rather than `repquota`, a
  banner above the meters states the scan age and time, warns past a day (and before any scan) with the *Refresh
  figures* hint, and the disk tile reads *From the last scan, {age}*. No new route or feature (contract §58, manual C §14.1).
- **Account panel › Email › Spam filters, thresholds documented (P2-2):** a *How spam scoring works* card on the page
  and manual C §6.5 explain per-account thresholds the cPanel way (one `required_score` per account, auto-delete as a
  second higher score, allow/block lists overriding the score) and that the threshold only acts once the mail server
  hands mail to a scanner — a host on the light Exim build without content scanning (nova) delivers mail unscored and
  the page says so instead of saving; no PRDR / per-recipient thresholds. Text only (i18n `panel.email.spam.how_*`,
  `panel.email.spam.no_scan_thresholds`); existing feature `spamassassin`.
- **Optimize website and Hotlink protection in the account panel (P2-6):** two pages under *Advanced*. Optimize website
  (feature `optimizews`, new in the default feature list) writes an `<IfModule mod_deflate.c>` block with
  `AddOutputFilterByType DEFLATE` for a pinned MIME catalogue (all or a chosen subset) into a folder's panel-managed `.htaccess`
  block; Hotlink protection (feature `hotlink`) writes referer rules into `public_html/.htaccess` — the account's own domains are
  always allowed, extra hosts, a pinned extension catalogue, "allow direct requests" and an optional 302 target that may not be a
  protected type itself. Both go through the grammar-checked block with the loopback probe and rollback
  (`GET|PUT /api/panel/advanced/optimize`, `GET|PUT /api/panel/advanced/hotlink`, contract §54, manual C §15.2–15.3).
- **Plugin pages in the account panel (P2-1):** a plugin page may declare `audience: "panel"` (SDK 1.1.0, `HOST_API_VERSION`
  1.1.0; table, form, markdown and html pages only; pages without the key stay administration pages) and then appears under
  *Software › Plugins* in the account panel at `/panel/plugins/<id>/<route>`, fed by `GET /api/panel/plugins/ui`,
  `GET /api/panel/plugins/ui/:id/file` and `ANY /api/panel/plugins/:id/*`, which only reach routes with `roles: ['user']` and hand
  the handler the pinned account as `req.panel`; admin pages and admin-only handlers never answer through the panel, and an
  account login can no longer call `/api/plugins/<id>/*` directly. Plan feature `plugins` (default on). The sample plugin ships
  one panel page (`/my-notes`). Contract §53.
- **Account panel › Files › File manager upload transport (P2-11):** chunks travel raw
  (`PUT /api/panel/files/uploads/:id/chunks/:index`, `application/octet-stream`, `express.raw` pinned to 2 MiB) instead of
  base64 JSON; the chunk size is pinned per upload and every chunk is written at its offset as the account (agent
  `files.chunk_write { offset }`), so an upload interrupted by a connection loss resumes from the server's
  `receivedChunks` list instead of starting over; files can be dropped onto the listing or the upload dialog (folders are
  skipped with a note). Contract §57; tests `server/test/panel-files.test.js`, `client/test/panel-upload-transport.test.jsx`,
  `agent/test/files.test.js`.
- **Account panel › Security › Virus scanner (P2-9):** on-demand ClamAV scans of the home, `mail/` or `public_html/`
  run as the account itself (`clamdscan --fdpass`, agent `sec.clamav.scan_as`, 15-minute cap, job `panel.clamav.scan`
  followed on the page); infected files are listed with their signature and can be deleted through the file manager's
  own path checks. `GET /api/panel/virus-scanner`, `POST …/scans { scope }` (202), `GET …/scans/:id[/stream]`,
  `POST …/infected/remove`. Feature `virusscan`; needs `clamav-daemon` on the host (contract §56).
- **Account panel › DNS › Dynamic DNS (P2-8):** a private update URL per A/AAAA record
  (`GET /api/panel/dns/ddns/:token?ip=`, public, rate-limited, token stored hashed; `GET|POST /api/panel/dns/ddns`,
  `DELETE …/:id` behind the panel scope; feature `ddns`; migration `034e`; contract §55). Refused for zones whose public
  DNS is managed elsewhere.
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
- Row "more actions" (⋯) menus and the admin shell's user menu closed as soon as the pointer moved
  onto them (the floating menu sat outside the wrapper whose `mouseleave` closed it). Every popover
  menu now shares `useMenu` / `Menu`: opens on click, closes on an outside press, Escape (focus
  returns to the button), Tab or a route change; arrow keys move between the items.
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
