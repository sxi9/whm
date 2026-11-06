# HANDOFF — pick up the Keel build here

For any AI or engineer taking over. Everything stated here is on the branch
`claude/kind-meitner-dlnbas` of `github.com/sxi9/whm`; this file is updated at every milestone
together with `CHECKLIST.md` (tracker) and `CLAUDE.md` (conventions + memory). Read those two next.

**Last updated:** 2026-11-05 · live-host verification on `nova.hostingsignal.in` done, fixes committed (`813d367`, `f6038d8`, `6ed13e9`) and deployed, host steps applied · checklist: 212 admin functions + 39 account-panel functions done, P6 closed, P7 complete · next: Phase 8 (`docs/design/phase8-account-panel.md`)

## 1. What this is

**Keel** — a production-grade, self-hostable hosting control panel that administers a real Linux
server. It reproduces the complete WHM admin surface (**30 categories, 212 functions**, all built,
reviewed and fixed) under its own identity and design, plus the commercial layer: a **license
server**, a **plugin marketplace** with backend-verified developers, a plugin SDK, a sample plugin and
an automated-backup plugin. Phase 7 (started 2026-11-03, user ask) adds a **new design system**
(Apple-platform conventions: grouped surfaces, system typography, one accent, native-feeling
controls, light + dark), the **product's own identity** (no cPanel/WHM self-references in the UI),
and a **customer-facing account panel** (our own replacement for cPanel) for role `user`. The whole stack has
since been exercised on a real production host (§2, §4).

Stack: Node 22 + Express 4 + better-sqlite3 (panel) · React 18 + Vite + react-router 7 (UI) · root
agent daemon (`agent/`) over a Unix socket with an allowlisted op catalog (316 ops) · hub (`hub/`) =
license + marketplace service with its own React portals (`hub/ui`) · zod 4 everywhere.

## 2. State of play

| Area | State | Proof |
|---|---|---|
| Phases 0–5 (foundation, shell, all 212 functions, plugin host, hub, marketplace, docs) | done | `CHECKLIST.md`; suites green |
| **Phase 6 hardening** | **done** — the three audits' fixes (`b01bd30`) were verified read-only by an independent pass on 2026-11-03; it found one real bypass and six smaller gaps, all fixed (§4 history) | `agent/test/hardening.test.js`, `server/test/web-hardening.test.js`, `server/test/jobs-ownership.test.js` |
| Deferred items from the audits | **all closed**: zod 4 (`7788431`), react-router 7 (`c87c235`), root lockfile links the hub workspaces, `backup.db.import` runs as a temporary database-scoped user, 2FA disable re-verifies password/code, hub honours `ui_dist`, flaky tests made robust | gate below |
| **Phase 7 — design system** | done `2a83117` + sweep `74374de`: tokens/base CSS, sidebar-first shell with coloured icon tiles, translucent bars, Home, Login, every shared component; all 30 categories swept by agents with screenshot reviews and fix rounds (232 findings; majors fixed) | `docs/design/ui-design-system.md`; `docs/screenshots/` |
| **Phase 7 — identity** | done: default branding "Keel" (migration `028c`, operators change it under Panel › Customization), labels renamed with **stable keys/routes** via slug overrides in `client/src/nav.js`, i18n catalog, docs (README/INSTALL/MANUAL/SDK), server/agent/hub user-visible strings (legacy managed-block markers still recognised on upgraded hosts), support links, `keel@` sender, `KEEL-` ticket refs | `22001ff`…`643e0a6` |
| hub/ui portals | on the new kit (`18fe699`; `hub/ui/src/components/SYNC.md`) | hub-ui suite |
| **Provisioned-host verification** (`nova.hostingsignal.in`, Ubuntu 26.04, EC2) | **done 2026-11-04/05**: 10 probe areas (mail, FTP, MySQL, web/PHP/DNS, SSL, backups/cron/quota, admin API walk, account-panel API walk, security posture, log-derived bugs), 29 confirmed findings (1 refuted), each adversarially verified; every finding with a code component fixed in three rounds under two review lenses; host-side fixes applied (AutoSSL live, ManageSieve 2000 off, fail2ban jails, PureDB auth link, Cloudflare nameservers); the code fixes are **uncommitted and not yet deployed** — §4 lists the deploy and the remaining host steps | `server/test/{http-redirect,request-log,capabilities,services}.test.js`, `agent/test/pkg-backports.test.js`, `client/test/exim-virtual-mail.test.jsx`, extended panel-*/service-configuration/ssl-tls/security-center/vmail/ftp/db/files suites; `https://testuser.hostingsignal.in` serves a Let's Encrypt certificate |
| **2026-11-06 session 4** | **done and live at `5e31107`**: phpMyAdmin access (§41.2), PHP updater (§52/§63), Phase 8 P5 (§71–§72, 034i), pool bookkeeping fix, sidebar/dashboard UI round | `server/test/{software,service-configuration,panel-webdisk,panel-installers}.test.js`, `agent/test/{web,pkg-runtime,webdisk,app-install,apps}.test.js`, `client/test/{install-software,panel-webdisk,panel-installers,home-collapse,panel-databases}.test.jsx` |
| **2026-11-06 session 3** | **done and live at `a5d2d19`**: UI round (collapsing, menus, 332-screenshot sweep), direct updates + Updates column (§63), phpMyAdmin admin SSO (§44), Phase 8 P3 (§64–§67) and P4 (§68–§70), PHP removal guards + host-apps pool (§52/§41) | `client/test/{menu,home-collapse,home-updates,phpmyadmin-admin,panel-git,panel-apps,panel-terminal,panel-users,panel-calendars}.test.jsx`, `server/test/{panel-git,panel-apps,panel-terminal,panel-users,dav,auth-2fa-users}.test.js`, `agent/test/{git,apps,term,dav,pkg-runtime}.test.js` |
| **2026-11-06 PHP source builds + Phase 8 P2** | **done and live on nova**: every catalog PHP version installable (source builds into `/opt/keel/php`, contracts §51/§52), and P2 — plugin pages in /panel, Database Wizard, Errors, Optimize/Hotlink, Track DNS, Dynamic DNS, Virus Scanner, raw-chunk uploads, a11y/wording, quota note, spam docs (contracts §53–§62, migration 034e); §4 "Phase 8 P2 host steps" | `agent/test/{pkg-runtime,ops-imports,dns-track,files-htaccess-web,sec-clamav-as}.test.js`, `server/test/panel-{plugins,ddns,virus,htaccess-web,logs-errors,dns-track}.test.js`, `client/test/panel-{a11y,database-wizard,ddns,dns-track,htaccess-web,logs-errors,upload-transport,usage-scan-note,virus,plugins}.test.jsx` |
| **2026-11-06 software + ports** | **done and live on nova**: Install Software (one-click runtimes/tools, inline installs, contract §51), PHP Version Manager (§52, offered list, panel Set all domains), account panel on 2083/2082 with the admin shell on 2087/2086 (`middleware/shell.js`, `wrong_port` policy); §4 "2026-11-06" has the verification | `server/test/{software,panel-php,shell-ports}.test.js`, `agent/test/pkg-runtime.test.js`, `client/test/{install-software,panel-php,login-shell}.test.jsx` |
| **Phase 8 — account panel on the real host** (`docs/design/phase8-account-panel.md`) | **P0 + P1 done and live on nova 2026-11-05**: hostname site with `/webmail` + `/phpmyadmin`, delegation banners, lockout paths (P0); Roundcube/phpMyAdmin SSO, Sieve filters, mail routing + relay/IPv6, `.htaccess` family, Visitors, WordPress installer, preferences/2FA/folders, phone layout, i18n (P1); three live-found fixes after the P1 deploy (§4) | `CHECKLIST.md` Phase 8 table; §4 host steps; `server/test/panel-{sso,me,email-filters,htaccess,software,logs-stats}.test.js`, `agent/test/{vmail-sieve,files-htaccess,wp-install,stats,db,webmail,mail}.test.js`, `client/test/panel-{i18n-*,mobile,preferences,visitors,wordpress,htaccess,webmail-sso}.test.jsx` |
| **Phase 7 — account panel** (`/panel`, our cPanel replacement) | **done**: design `docs/design/customer-panel.md`; units U0–U5 + seams S1–S11 (contracts §33–40) + 39 pages in 13 groups, each adversarially reviewed and fixed; integration critics (3 lenses, 38 findings) closed; admin side ("Log in as", Panel › Customization › Account panel, reseller ACL `login-as`); manual Part C | `e2e/panel-check.cjs` 39/39, `server/test/panel-*.test.js`, `agent/test/{files,cron,vmail,webmail,ftp,backup-read}.test.js`, `client/test/panel-*.test.jsx`; galleries `docs/screenshots/pages/panel/` |

## 3. How to run and verify (from a fresh clone)

```bash
npm install                                   # all workspaces (server, agent, client, hub, hub/ui)
cp .env.example .env                          # dev: monolithic mode, ./data, port 2086
npm run build                                 # client + hub/ui
WHM_DATA_DIR=./data WHM_PORT=2086 WHM_SERVE_CLIENT=true node server/src/index.js
#   first boot seeds root; password from WHM_ADMIN_PASSWORD or $WHM_DATA_DIR/initial-admin-password.txt
npm test                                      # every workspace + plugins/sdk + sample plugin + bundled plugins
BASE=https://127.0.0.1:2087 PASSWORD='<root pw>' node e2e/ui-check.cjs       # Playwright flow (http://127.0.0.1:2086 only without TLS)
BASE=https://127.0.0.1:2087 PASSWORD='<root pw>' bash e2e/screenshots.sh     # all 212 pages + galleries
```
Hub in dev: `node hub/scripts/gen-key.js --master|--hmac|--license|--plugin` against a temp
config, then `node hub/src/index.js` (config via `WHM_HUB_CONFIG=<file>`; `--check-config` boots
once and exits); `node hub/scripts/hub-cli.js create-admin <email>` / `issue <sku> <email>`.
Panel → hub: `WHM_LICENSE_HUB_URL`, `WHM_LICENSE_KEYS_FILE`, `WHM_LICENSE_ENFORCE` (default on only
under `NODE_ENV=production`). Production install: `scripts/install.sh [--with-hub]`.

Dev container facts: 4 CPUs (agents are API-bound, 6–10 concurrent were fine), no Apache/BIND/
Exim/MySQL daemons (every page degrades to an install prompt — by design), Playwright + Chromium
preinstalled, `/tmp/whm` must exist for the agent tests (they create it).

UI work loop that proved efficient: boot the API on a side port with a scratch data dir, run
`npx vite --port 5173` with `WHM_API_URL` pointing at it, and screenshot routes through the dev
server (live source, both colour schemes) — see `docs/design/ui-design-system.md` for the rules.

## 4. Where the previous session ended — and where to continue

**The provisioned-host verification (item 1 of the previous handoff) was done on the real production host
on 2026-11-04/05** — `nova.hostingsignal.in`, Ubuntu 26.04 on EC2, installed with `scripts/install.sh`, one
hosting account `testuser` (`testuser.hostingsignal.in`). Ten probe agents walked every host-touching path
(account-panel and admin API, mail, FTP, MySQL, web/PHP/DNS, SSL, backups/cron/quota, security posture,
log-derived bugs), each finding was re-verified adversarially (29 confirmed, 1 refuted), and the code findings
were fixed in three rounds (fixers per area, two review lenses, re-review). The findings and fix reports live
only in that session's scratchpad; what matters is recorded here and in `CHECKLIST.md`/`CHANGELOG.md`.

**State of the tree:** committed as `813d367` (the audit fixes, 93 files), `f6038d8` and `6ed13e9` (two defects
only the real Dovecot 2.4 / Debian pure-ftpd showed, found while verifying the deploy), and **deployed to
`/opt/whm` with `scripts/install.sh --upgrade`**; `~/whm` on the host is the same branch (applied with `git am`, so
its commit ids differ until it is reset to `origin`). Gate on the host clone before the deploy: server 1442 /
agent 635 (+3 cases that only fail because the binary they assume absent exists there) / client 277 / hub 186 /
hub-ui 105 / SDK 73 / plugins 48; both Playwright flows green before and after. Round 3's re-review raised one
more major, fixed by hand: `ssl-tls.js resolveDomain` treats only the configured `basic.hostname` as the server
(any other unowned name root addresses stays a web host, so a stranger's certificate can never reach the
panel/daemons); `writePanelPair` refuses without a panel group and uses `lstat`/`lchown` on the legacy entries.
Live-found and fixed afterwards: Dovecot 2.4 strips the domain for LMTP by default (`protocol lmtp {
auth_username_format = %{user | lower} }` in the fragment); Debian's 2.4 `mail_inbox_path = /var/mail/%{user}`
makes a virtual Maildir user try to create `/var/mail/<address>` (`userdb_mail_inbox_path` on every passwd line,
re-key adds it); Debian's `pure-ftpd-wrapper` has no `CertFile` directive and refused to start (the combined PEM
now goes to the compiled-in `/etc/ssl/private/pure-ftpd.pem`, only `conf/TLS` is written).

### 2026-11-06 (session 4): phpMyAdmin access, PHP updater, Phase 8 P5, pool fix, UI round (deployed `5e31107`)

- **Owner complaints closed.** phpMyAdmin "cannot be accessed": the hostname site's `keel-host` FPM pool kept PHP sessions under
  `/var/lib/whm/keel-host` which the pool user cannot traverse (`/var/lib/whm` is 0750 `whmpanel`) — `session_start` failed and
  the SSO looped. Hotfixed live, then codified: state dir `/var/lib/keel-host` (own allowed root; root-owned dir, pool-owned
  `tmp` 0700 and `php-error.log` 0640, repaired by descriptor-only chown/chmod on every `web.host.pool.write`; contract §41.2),
  signon script answers a clear 500 page when the session dir is unwritable; the legacy dir is left in place on nova (not
  empty) — `sudo rm -r /var/lib/whm/keel-host` is safe now. The account panel's "Open phpMyAdmin" opened `window.open(url,
  '_blank', 'noopener')`, which returns `null`, so the page navigated the main tab — fixed. "No PHP version updater": the
  Updates column was there but a packaged minor with an advisory had nothing clickable; now the Keel build of a minor wins over
  the distro tree (`packagedTwin`), the row offers *Security update · x.y.z from php.net* (source build + resync with `repool`,
  `/usr/bin/php` relinked) or *Move domains to the Keel build*, and *Remove packages* drops the unused distro packages.
- **Found by the acceptance:** `testuser.hostingsignal.in` answered 503 — its vhost proxied to `/run/keel-php/php8.4-fpm-testuser.sock`
  while the 8.4 tree (rebuilt earlier that day) had no `whm-testuser.conf`; the `web_php_pools` row said `applied`, so
  `ensurePool` never rewrote it. Fixed (`fs.stat` on the row's path before trusting it) and both accounts re-synced with
  `POST /api/service-config/apache/vhosts/sync`. Any host whose Keel tree was rebuilt before `5e31107` needs that sync once.
- **Phase 8 P5 host facts:** `rclone` 1.60 installed by the first Web Disk enable (job); `a2enmod proxy proxy_http headers` by
  the panel; migration 034i applied by `install.sh --upgrade`. Web Disk writes land after rclone's VFS write-back (a few
  seconds; `--vfs-cache-mode writes`), MOVE/COPY work through the proxy (`ProxyPreserveHost`). Joomla 6.2.0 needs PHP ≥ 8.3
  (catalog enforces it); Drupal has no non-interactive MySQL installer without Composer, so the page hands over to
  `core/install.php` with the database pre-configured. Release pins are a static table in `agent/src/ops/app-install.js`
  (bump = edit the table with the new sha256).
- **Acceptance on nova (keel-ops → Log in as testuser):** Web Disk enable (rclone install job) → PROPFIND 207, wrong password
  401, PUT 201 → `/home/testuser/probe-webdisk.txt` owned by testuser, MKCOL 201, MOVE 201, DELETE 204, `.ssh`/`.keel` 404,
  disable → 405 and unit inactive. Joomla at `/probe-joomla` (configuration.php 0640, database `testuser_joomla`) and Drupal at
  `/probe-drupal` (settings.php 0640, installer link) installed and removed with their databases; the Joomla/Drupal HTTP GETs
  during the run answered 503 because of the pool defect above (resolved afterwards; the site serves PHP 8.4.27 again). PHP
  8.5 row (Keel 8.5.12 over distro 8.5.4) offered *Move domains to the Keel build*, the job finished, catalog clean.
  the sidebar reopens after collapse (the aside's backdrop-filter had trapped the fixed expand button inside the zero-width aside; the expand control now lives outside it — floating bottom-left and in the top bar beside the brand — and the aside slides width/opacity both ways with focus handed over), Home / panel Home sections and both sidebars' category lists animate open and closed (`components/Collapse.jsx`, grid-rows transition, closed content inert, reduced motion honoured), dashboard tool cards carry a 38 px coloured icon tile with 15 px titles and 13 px descriptions on a wider grid. Verified in a real browser on nova (both shells): collapse → width 0, floating and top-bar expand buttons outside the aside, reopen from either, state persists over reload; section close → rows 0px, inert, hidden; reopen settled; phone drawer unaffected; dark mode checked.
- **Gate on the host clone at the deploy:** server 1800 (+1 host-env, ClamAV present) / client 656 / agent 913 (+4 host-env) / hub 186 / hub-ui 105 / SDK green / build green. Known host-environment cases unchanged.
- **Deferred:** mailing lists (mlmmj not packaged for this release); a stale `D:\claude\whm-p4` worktree folder remains on the
  laptop (merged, no junctions) — remove with `git worktree remove` after checking for junctions.

### 2026-11-06 (session 3): UI round, direct updates, phpMyAdmin admin SSO, Phase 8 P3 + P4, PHP removal guards (deployed `a5d2d19`)

- **Live incident and guards.** The owner removed the distribution's PHP 8.5 from PHP Version Manager after making a Keel
  build the default; apt took `roundcube-core` and `phpmyadmin` with it and the hostname-site apps ran on the distro
  `php8.5-fpm` socket, so webmail and phpMyAdmin answered 403/404. Restored by hand (packages reinstalled, Roundcube's
  `array_first()` guard re-applied for PHP 8.5, webmail re-published to bring the `keel_sso` plugin back). Code now simulates
  every packaged PHP removal and refuses collateral (root can force after the list), never removes the version the host
  apps run on, and gives the hostname site its own `keel-host` FPM pool in the effective default's tree (works with Keel
  builds; moved on default change; stale pools removed only after the site points elsewhere).
- **Host steps done on nova:** `a2enmod proxy proxy_http proxy_wstunnel` (by the panel on the first app publish);
  `radicale` + `python3-bcrypt` and `a2enmod headers` by the Calendars card; nothing by hand except the restoration above.
  Migrations 034f (git repos, apps, vhost proxies), 034g (sub-users), 034h (DAV) applied by `install.sh --upgrade`.
- **Acceptance on nova (keel-ops → Log in as testuser):** Git: clone of a public repo, pull, `.keel.yml` dry run and deploy
  served at `/probe-git/`, remove. Apps: `probe-app` published at `/probe-app` (unit `User=testuser`, `ProtectSystem=strict`,
  `NoNewPrivileges`), ACME path stays Apache, stop → 503, start → 200, logs, delete removed unit/file/proxy. Updates: catalog
  rows carry `update`/`updates` stamps; critical list empty. phpMyAdmin: admin sign-on lands on phpMyAdmin with
  `keel_pma_admin`, open-as-testuser lands with `testuser_pma` (grants only on `testuser_wp`). P4 and guard acceptance:
  Guards: `POST /api/software/php/remove { version: '8.5' }` → 422 "PHP 8.5 runs the hostname site's keel-signon and
  phpMyAdmin and webmail …"; the unused Keel 8.3 build removed cleanly; a source build over the packaged 8.5 and a second
  Keel 8.4 → 422. Host pool: after `POST /api/service-config/hostname/apply` the site renders
  `/run/keel-php/php8.4-fpm-keel-host.sock` (pool `keel-host.conf` in the Keel 8.4 tree) and webmail / phpMyAdmin /
  pma-signon answer 200. P4: Calendars installed and published by the card (Radicale 3.6.0 active, `/dav/` 302), DAV
  password set for `testuser@testuser.hostingsignal.in`, PROPFIND 207 with it and 401 without, password removed;
  sub-user `probe.sub` with mail + FTP (doveadm user found, FTP 226, FTP 530 after disabling, both gone after delete);
  Terminal: shell granted to testuser, a session opened and `id` over the WebSocket answered `uid=1001(testuser)` in
  `/home/testuser`, closed, shell revoked (501 `shell_disabled` afterwards). Two live-found fixes: the terminal gate now
  also honours a per-account shell, and Radicale's users file moved to `/etc/radicale/users`.
- **Known host-environment test cases:** agent `dns.test.js` `$INCLUDE`, `resolver.test.js`, `vmail.test.js` purge,
  `sec-malware.test.js` (ClamAV present); server `plugins.test.js` capability case (ClamAV present). Windows-only:
  path-separator cases in `panel-domains`, `panel-ftp`, `panel-security`, `panel-software`, `plugin-host`,
  `database-services` backup path, SDK `pack.test.js`, and the en-IN locale case in `client/test/panel-usage.test.jsx`.
- **Deferred to P5:** Web Disk (needs a per-user WebDAV daemon or mpm-itk), mailing lists (Mailman 3), Softaculous-style
  installers beyond WordPress.

### Phase 8 P2 host steps + PHP source builds (done on nova 2026-11-06, deployed `a3d9b8f`)

- **Host packages added:** `clamav-daemon` (enabled; note it only starts once `freshclam` has fetched the databases),
  `dnsutils`, `traceroute`. Apache `deflate` and `rewrite` were already enabled. Migration `034e_panel-ddns.sql` applied by
  `install.sh --upgrade`.
- **PHP source builds:** the first panel-driven build (PHP 8.4.27) took 29 minutes on the 2-vCPU host; the build
  dependencies (`build-essential` and the `-dev` libraries, ~25 packages) stay installed. A build leaves
  `/opt/keel/php/<minor>`, `/etc/systemd/system/keel-php<minor>-fpm.service`, `/usr/local/bin/php<minor>`; removal through
  the panel takes all three away. Two lessons from the deploy: an op module must never import `agent/src/lib.js`
  (top-level-await deadlock → whm-agentd exit 13 → the panel's dependency failed; `agent/test/ops-imports.test.js`), and a
  domain set back to "inherit" must be rendered with the resolved default handler (it served `.php` as source for a minute
  on testuser until restored).
- **Acceptance run as keel-ops → Log in as testuser** (scripts lived in the session scratchpad; probe objects removed,
  `public_html` back to the owner's files): Errors page, Track DNS (+422 cases), DDNS `not_delegated`, wizard calls,
  Optimize/Hotlink over HTTPS, Virus Scanner with EICAR, 2 MB raw-chunk upload with sha256 match, usage source `repquota`,
  live Let's Encrypt certificate on the domain. Not exercised: a plugin panel page (reinstall `net.whm.sample-notes` from the
  regenerated signed fixture to see *Software › Plugins › Notes about my account*), `e2e/panel-check.cjs` (root TOTP).
- **Known host-environment test cases on nova (4):** agent `dns.test.js` `$INCLUDE`, `resolver.test.js` upstream,
  `vmail.test.js` purge, and since P2 `sec-malware.test.js` "no scanner" plus server `plugins.test.js` "capability detection"
  — both assume ClamAV is absent.

### 2026-11-06: Install Software, PHP Version Manager and the account panel on port 2083 (deployed `d724062`)

The owner's ask: no more detours to the distro package page when a PHP, Node or Python version is needed, a PHP
version manager where every version is listed and accounts pick what they prefer, and cPanel-style ports (accounts on
2083, admin on 2087). Three workflow rounds (runtime installs, PHP Version Manager, port split), each with security +
correctness review lenses and one fix round; gate on the host clone at the deploy: server 1601 / client 481 / agent 761
(+3 known host-env) / hub 186 / hub-ui 105 / SDK green / client build green.

- **Install Software** (`/software/install-distro-packages`, relabelled; contract §51): tabs Runtimes (PHP 8.5–7.4,
  Node.js 24/22/20/18 as official nodejs.org builds under `/opt/keel/node/<major>` with `node<major>`/`npm<major>`/
  `npx<major>` links, Python 3.13–3.9, Ruby, Go, Composer), Tools, Search, Installed, History. Job
  `software.runtime.install` = `pkg.repo.ensure` → `pkg.update_index` (only when a repo was added) → `pkg.install` /
  `pkg.node.install` → PHP CLI default restored → capabilities refresh → `pkg.runtime.detect`. Every page that used to
  link to the distro page installs inline (`InstallPackages.jsx`, `RuntimeInstaller`); Module Installers shows the packages
  per installer. **Ubuntu PPA rule:** `pkg.repo.ensure` probes `https://ppa.launchpadcontent.net/<ppa>/ubuntu/dists/<codename>/InRelease`
  first and answers `unsupported` on 404 — `ppa:ondrej/php` has no series for 26.04 "resolute" (deadsnakes has), so on
  nova PHP 8.4/8.3/… show as "not available for this OS" and an install job fails with that message without touching
  `/etc/apt/sources.list.d`. Only the versioned `/usr/local/bin/{node,npm,npx}<16–30>` links are agent-writable, never
  `/usr/local/bin` itself (`NODE_LINK_PATHS` in `agent/src/lib.js`).
- **PHP Version Manager** (`/software/multiphp-manager`, relabelled; contract §52): `GET /api/software/php/catalog`
  (every catalog version with state installed/available/unsupported/unknown, FPM, defaults, domain/vhost/plan counts,
  `repoStatus`), `POST /api/software/php/remove` (job `software.php.remove` → agent `pkg.php.remove`; refused for the
  system or CLI default, the only version, a version pinned on a domain, vhost, plan or in Apache Configuration — and
  re-checked when the job runs), `PUT /api/software/php/offered` (setting `php.offered_versions`; the account panel offers
  only those, a version a domain already runs stays listed as "no longer offered"), Set as default (existing flow).
  Account panel › PHP versions: *Recommended* pill, *Your domains* counts, *Set all domains* (`PUT /api/panel/php/domains
  { version, domains? }`, `202` with a job for several domains, audit `panel.php.version_all`).
- **Ports** (`server/src/middleware/shell.js`, `server/test/shell-ports.test.js`): `panelPort` 2083 (TLS, shares the
  certificate reload with 2087) and `panelHttpPort` 2082 (301 → 2083, 426 for `/api`) next to 2087/2086; `req.shell` is
  decided by the socket's local port, never a header. On the panel shell only `/api/health`, `/api/auth/*`, `/api/branding*`,
  `/api/panel/*` (minus `/api/panel/admin/*`), `/api/locales/active` and `/api/themes/active` are served, everything else
  answers `403 wrong_port`; any page other than `/panel*`/`/login*` redirects to `/panel`; an administrator or reseller login
  there (password, 2FA, OIDC) creates no session and answers `403 wrong_port` with `adminUrl` (the login page shows the link;
  branding carries `shell` and `adminUrl`); an admin cookie minted on 2087 may only read and log out on 2083 unless it is an
  audited "Log in as" session. `GET /api/auth/me` gives admins `panelUrl` (`https://<hostname>:2083/`), which is also the
  password-reset mail base. `install.sh` prints both URLs and the firewall list 2082/2083/2086/2087; `e2e/panel-check.cjs`
  takes `PANEL_BASE`. A panel port that collides with an admin port is disabled with a warning; a bind failure on
  2082/2083 never takes 2087 down.
- **Verified on nova (2026-11-06):** `https://nova.hostingsignal.in:2083/` → 302 `/panel`, `/api/accounts` there → 403
  `wrong_port`, keel-ops login on 2083 → 403 with the 2087 link and no cookie, 2082 → 301 to 2083 and 426 for `/api`,
  2086 → 2087 unchanged; catalog: 8.5 installed (system + CLI default, 2 domains), 8.4–7.4 unsupported with the resolute
  note; Node 20 installed through the panel (`/opt/keel/node/20`, `node20` v20.20.2, `npm20` 10.8.2, `/usr/bin/node`
  still v22.23.4) and removed again (links and tree gone); PHP 8.4 install job failed with the PPA message and no sources
  file was added; removing 8.5 refused; offered list round trip; Log in as testuser reads `/api/panel/php/versions`
  (recommended 8.5, usage `{8.5: 1}`) and `/php/domains` on 2083 while `/api/accounts` and `login-as` stay refused there.
  The EC2 security group already passes 2082/2083 (connections were refused, not dropped, before the deploy).
- **Open for the owner:** nothing new. PHP versions other than 8.5 become installable on nova as soon as
  `ppa:ondrej/php` publishes a resolute series (the catalog re-probes on every load); until then the Ubuntu LTS path
  (noble) is the one that offers 8.4/8.3/…

### What was found and fixed (code)

- **Mail (the biggest gap):** the virtual-mail Exim/Dovecot wiring was never applied (no caller, no route) and
  the Dovecot fragment used 2.3 syntax that Dovecot 2.4.2 rejects. Now: job `panel.virtual_mail.ensure` runs at
  boot and on the first mailbox when not live, admin `GET/POST /api/service-config/virtual-mail[/apply]` (+ a
  card on Exim Configuration Manager), 2.3/2.4-aware `98-whm-virtual-auth.conf` and `97-whm-mailserver.conf`
  (ManageSieve 2000 disabled when `sieve` is a protocol), passwd lines keyed `local@domain` with the one-time
  `vmail.passwd.rekey` run before the include is written, Exim routers looking up the full address, the
  `dovecot_plain/login` authenticators, the new Exim setting `submissionPorts` (587 always, 465 only with the
  TLS preset), mailbox create/list warn `virtual_mail_not_live`, and the Security Advisor reports
  `panel.mail.*` (router/auth/transport hooked, submission). The panel never edits `exim4.conf.template`: on an
  unsplit Debian host the status/apply result prints the three `.include_if_exists` lines to add by hand.
- **Web/DB/FTP:** sub/addon docroots were `user:user 0750` (Apache 403) → `files.mkdir { group }` hands the leaf
  to the web run user by root through an `O_NOFOLLOW|O_DIRECTORY` descriptor (0755 only when no web server is
  installed); `db.revoke` emitted `REVOKE ALL PRIVILEGES, GRANT OPTION ON db.*` (1064) → two statements, 1141
  tolerated; pure-ftpd never loaded PureDB without `/etc/pure-ftpd/auth/50puredb` → `ftp.virtual.status` checks
  the link and `web.ftp.config.write` creates it; the account panel now reports the daemon's effective FTP
  TLS state, never the saved setting.
- **Services/software:** php-fpm unit discovery by `php<major>.<minor>-fpm` pattern + migration `001d`; the
  capability snapshot refreshes after package jobs and `ensureFresh(30 s)` before a 501; 501 logged at warn
  without a synthetic stack, 400/404/409/413/422 at info (`lib/request-log.js`); `pkg.search` accepts 1–4
  words as separate argv tokens.
- **TLS:** port 2086 served the login over plain HTTP → `middleware/tls-redirect.js` (301 for pages, 426
  `tls_required` for `/api`, `WHM_HTTP_REDIRECT`/`httpRedirect` fail-safe parse, `GET /api/health` passes);
  the https listener reloads its pair on SIGHUP or file change and fails loudly when the pair is unreadable;
  the panel service cert now lands in `/etc/whm/ssl/panel.{crt,key}` 0640 root:whmpanel; Dovecot 2.4 drop-in
  uses `ssl_server_*_file`; AutoSSL skips `www.` without a DNS record and can issue for `basic.hostname`
  (root only, webroot `/var/www/html`, installed on panel/exim/dovecot/apache, renewed daily); group lookups
  via `getent`.
- **Panel/UI:** scoped `/api/panel/databases/jobs/:id[/stream]` for role users; file-manager double-click no
  longer resolves against the new directory; duplicate main domain in `/api/panel/logs`; doubled "not found"
  message; Manage Service SSL Certificates note; e2e scripts default to `https://127.0.0.1:2087` with
  `ignoreHTTPSErrors`.
- **Advisor/hub:** PHP advisory hits are checked against the distro changelog (`pkg.php.backports`, Debian
  and RHEL layouts; `8.5.4-0ubuntu1.5` is reported as carrying the CVE-2026-109619 fix); the hub enforces TOTP
  enrolment for vendor admins (`license.require_admin_totp`, default true; SPA/assets stay reachable, only
  `/v1/*` is held). `scripts/install.sh` runs one root `npm ci` for every workspace and prunes dev deps last.

### Host-side changes already applied on nova

AutoSSL enabled (Let's Encrypt via certbot, e-mail `admin@hostingsignal.in`, `includeWww: false`) and a
production certificate issued and applied for `testuser.hostingsignal.in` (https verified publicly);
Dovecot's deprecated ManageSieve port 2000 disabled; fail2ban jails exim/dovecot/pure-ftpd
(`/etc/fail2ban/jail.d/keel.local`); `/etc/pure-ftpd/auth/50puredb -> ../conf/PureDB` (virtual FTP logins
work); `basic.nameservers` = `roman/betty.ns.cloudflare.com` and the testuser zone's NS/SOA updated;
`basic.contact_email` set.

### Done on the host after the deploy (2026-11-04 19:40–20:00 UTC)

1. Gate, commit, deploy — see "State of the tree" above.
2. **Virtual mail is live:** the three `.include_if_exists` lines were added to `/etc/exim4/exim4.conf.template`
   (backup `exim4.conf.template.bak-vmail-*`), `update-exim4.conf`/`exim4 -bV`/reload, then
   `POST /api/service-config/virtual-mail/apply` → `routerHooked/transportHooked/authHooked: true`. Verified with
   a throwaway mailbox: `doveadm auth test`, IMAPS LIST, SMTP AUTH on 587 (STARTTLS) and 465 (TLS), inbound
   LMTP delivery, IMAPS read-back, `doveadm quota get`, panel usage; relay from a foreign IP refused (`exim -bh`).
3. **Submission ports:** `submissionPorts` on, Exim + Dovecot TLS preset applied → 25/465/587 listening.
   **Still to do by the operator: open 465 and 587 (and 25 inbound, if this server is to receive internet
   mail) in the EC2 security group — they time out from outside today.**
4. **Service certificates:** AutoSSL for `nova.hostingsignal.in` issued and installed on panel, exim, dovecot,
   apache and ftp (`/etc/ssl/private/pure-ftpd.pem`); the hub got the same pair by hand
   (`/etc/whm-hub/ssl/hub.{crt,key}` 0640 root:whmhub) and `WHM_LICENSE_HUB_CA` was commented out of
   `panel.env` (the chain validates with the system CAs; license check-in green). `/etc/whm` and `/etc/whm-hub`
   were backed up to `/root/etc-whm*.bak-*` before the deploy.
5. **2FA:** `security.2fa.required_for_root` is on — root must enrol an authenticator at the next login. An
   automation admin `keel-ops` (role root, TOTP enrolled) exists for scripted verification; its password and TOTP
   secret are in `/root/keel-ops.env` (0600). The hub vendor admin still has to enrol in the portal (held until
   then).
6. Security Advisor after the rescan: only root-2FA (now enforced), 3 pending security package updates
   (unattended-upgrades), and the two deferred items below remain.
7. **Deliberately not applied — operator decisions:** ModSecurity/OWASP CRS (`DetectionOnly` first, then
   `On`), scheduled backups (`backup.enabled` + a destination), delegating DNS to BIND (public DNS stays at
   Cloudflare, so every panel-created subdomain must also be added there), PHP-FPM pool
   `open_basedir`/`disable_functions`, SMTP restrictions, Apache `ServerTokens`/`ServerSignature`.
8. **Known leftovers (minor, not blocking):** the MultiPHP Manager badge still flags a backported PHP version
   (synchronous `phpAdvisories.forVersion`); the panel is not restarted automatically after a panel-cert
   install (the file watch covers it within seconds). Pre-existing on the host clone, not a regression:
   `agent/test/vmail.test.js` "purge never executes a program", `web.test.js` "per-domain log directories",
   `dns.test.js` `$INCLUDE` and `resolver.test.js` "missing resolvectl" fail on a host where the binary they
   assume absent exists (run the agent suite as root there: `sudo npx vitest run`).
9. **Next: Phase 8 — the account panel on a real host**, planned in `docs/design/phase8-account-panel.md`
   (P0: server-hostname vhost, Roundcube + phpMyAdmin from the distro packages published under it, truthful
   mail client settings, DNS-delegation awareness, password/2FA recovery; P1: webmail/phpMyAdmin SSO, Sieve
   filters, mail routing, visitor stats, the `.htaccess` family, WordPress installer, preferences, 2FA UX,
   i18n, mobile). Use `keel-ops` (`/root/keel-ops.env`) for scripted verification on nova. Then the earlier
   list: the minor critic findings from milestone 2, hub portals in a browser, the DEFERRED items in
   `docs/design/phase5-build-plan.md`.

### Phase 8 P1 host steps (done on nova 2026-11-05 after `install.sh --upgrade` from the P1 commits)

P1 (SSO, Sieve filters, routing + relay, `.htaccess` family, Visitors, WordPress, preferences, phone layout, i18n;
contracts §44–§50, migrations `034b`–`034d`) is deployed and verified on nova. Order for another host (`keel-ops`
session, CSRF token on every write):

1. `install.sh --upgrade` (rsyncs `deploy/roundcube` + `deploy/phpmyadmin`, applies the migrations, restarts the units;
   the boot job re-renders `98-whm-virtual-auth.conf` with the Sieve lines when `sievec` is present and reloads Dovecot).
2. **Exim:** add `.include_if_exists /etc/exim4/whm/router_whm_smarthost.conf` right after the virtual-mail include under
   `begin routers` in `/etc/exim4/exim4.conf.template` (operator line, the panel never edits the template), then
   `update-exim4.conf && exim4 -bV && systemctl reload exim4`. Save the Exim Configuration Manager once
   (`PUT /api/service-config/exim {"ipv6":"auto"}`): the Keel main block then carries `disable_ipv6 = true` on a host
   without a global IPv6 route and the agent drops a hand-added duplicate outside the blocks (Exim refuses a second
   definition). `grep -c '^disable_ipv6' /etc/exim4/exim4.conf.localmacros` → 1.
3. **Webmail SSO:** `PUT /api/panel/admin/webmail/sso {"enabled":true}` → master user `keel-master` in
   `/etc/dovecot/whm/master-users`, plugin in `/var/lib/roundcube/plugins/keel_sso`, `keel_sso` + `keel_sso_endpoint` in the
   Keel block of `config.inc.php`. `loginAs` stays off (an administrator acting as the account cannot open mailboxes).
4. **phpMyAdmin SSO:** `PUT /api/databases/phpmyadmin/sso {"enabled":true}` → `keel-host.d/keel-signon.conf` (`/keel`),
   `/etc/phpmyadmin/conf.d/keel-signon.php` (server 1 signon, server 2 cookie login), `curl -sI …/keel/pma-signon.php` → 200.
5. Acceptance as `testuser` (login-as): `POST /api/panel/email/webmail/sso {mailbox}` → URL → 302 into `_task=mail`
   (replay of the link lands on the login form; `SELECT username FROM users` in the `roundcube` database shows the
   mailbox only); `POST /api/panel/databases/phpmyadmin/sso {}` → 302 to `index.php?server=1`, `SHOW GRANTS FOR
   'testuser_pma'@'localhost'` lists the account's databases only, replay 403; a filter with `fileinto Junk` then
   `exim4 -odf` two local messages → `.Junk/new` 1, `new` 1 (`journalctl -u dovecot` shows `sieve: … stored mail into
   mailbox 'Junk'`); `POST …/folders/Junk/empty` removes it; directory privacy 401 → 200 with the user; IP blocker and a
   custom 404 appear in `public_html/.htaccess` and Apache serves the page; `POST /api/panel/logs/stats/<domain>/generate`
   → report 200 within ~30 s (10 min cooldown per domain); `POST /api/panel/software/wordpress` → job done, `/p1blog/` 200
   with the site title, removed with `database=true`. Scratchpad scripts of this session: `live/p1-accept.sh`, `p1-accept2.sh`.
6. Not run on nova: `e2e/panel-check.cjs` (phone + pseudo-locale passes) — it logs in as root, whose TOTP is not enrolled.

**Found on the host and fixed in code (commits after the P1 feature commit):** the `.dovecot.sieve` active link in the
maildir root is a Maildir++ "folder" to Dovecot 2.4 (LMTP 451 "Not a directory" on every filtered delivery) → the link is
`~/mail/<domain>/.<local>.sieve` now; goaccess 1.9.4 wants `.html/.json/.csv` output names and checks `--output=json` as
a path in the working directory → staging files `<domain>.tmp.html/.tmp.json`, and the account cannot traverse
`/var/log/whm` (0750 whmpanel) → root opens/merges the domlog and goaccess reads it on stdin; the agent's `fetch` lost the race
between Node's 250 ms happy-eyeballs attempt and a 238 ms round trip to wordpress.org → `ipv4first` + 2.5 s attempts
in `agent/src/index.js`.

### Phase 8 P0 host steps (done on nova 2026-11-05 after `install.sh --upgrade` from the Phase 8 commit)

Phase 8 P0 (plan `docs/design/phase8-account-panel.md`, trackers in `CHECKLIST.md`) is deployed: the server-hostname site
(contract §41), Roundcube + phpMyAdmin published under it, truthful mail client settings, DNS-delegation banners (§42) and
the lockout paths (§43, migration `034_panel-recovery.sql`). Steps 2–6 below were run and verified on nova (a panel-created
mailbox logged in to `https://nova.hostingsignal.in/webmail/`, a panel-created DB user logged in to `/phpmyadmin/` and saw
only its database; the advisor shows `hostname.site` and `phpmyadmin.global_alias` ok). **Found on the host while doing so:**

- Ubuntu 26.04 ships Roundcube 1.6.11 with PHP 8.5, where `array_first()` is a builtin: `/webmail/` answered 500
  ("Cannot redeclare function array_first() in program/lib/Roundcube/bootstrap.php"). The polyfill was wrapped in
  `if (!function_exists('array_first'))` by hand (backup `bootstrap.php.bak-keel-20261105`; a package upgrade will
  overwrite the fix, which the upstream 1.6.12+ package no longer needs). P1 should make the publish step probe the URL
  and surface the HTTP status / the PHP fatal in the admin card instead of reporting success from `php -l` alone.
- Exim tried the Outlook MX's AAAA targets first ("Network is unreachable") on a host with no global IPv6 route:
  `disable_ipv6 = true` was appended to `/etc/exim4/exim4.conf.localmacros` *outside* the Keel managed blocks (the file is
  shared; never overwrite it — a Keel copy sits in `/var/lib/whm/backups/config/etc/exim4/`). EC2 also blocks outbound
  port 25, so the reset mail for `testuser` stays in the queue: the owner must lift the restriction with AWS or configure
  a smarthost (P1 mail-routing unit: `ipv6` and `smarthost` settings in Exim Configuration Manager).

The original order (`keel-ops` session from `/root/keel-ops.env` for the API calls; every POST needs the CSRF token from
`GET /api/auth/csrf`) for another host:

1. **Packages (done on 2026-11-05 while the units were built):** `apt install roundcube roundcube-core roundcube-mysql
   phpmyadmin dovecot-sieve goaccess` — dbconfig created the `roundcube` and `phpmyadmin` databases on MariaDB. If they are
   missing on another host, install them first; the publish steps answer `501 capability_missing` without them.
2. **Hostname site:** `POST /api/service-config/hostname/apply {}` → `written:true, ssl:true` (the Apache service certificate
   for `nova.hostingsignal.in` is already installed). `GET /api/service-config/hostname` must show `inSync:true, ssl:true`.
   `curl -vI https://nova.hostingsignal.in/` shows the hostname certificate and the Keel landing page (the first customer
   vhost no longer answers for the hostname).
3. **Publish webmail:** `POST /api/service-config/webmail/publish {}` → `url: "https://nova.hostingsignal.in/webmail/"`,
   `config.validated:true` (the Keel block in `/etc/roundcube/config.inc.php` points IMAP at `ssl://nova…:993` and SMTP at
   `tls://nova…:587`). Verify: `curl -vI https://nova.hostingsignal.in/webmail/` → 200 with the hostname certificate;
   `curl -sI https://nova.hostingsignal.in/webmail/bin/` and `…/webmail/SQL/` → 403 (or 404 on the Debian web-root layout);
   `GET /api/panel/email/webmail` as `testuser` → `installed:true, url` set with `panel.webmail_url` empty; log in to Roundcube
   with a panel-created mailbox. Debian's own `/etc/roundcube/apache.conf` keeps its Alias lines commented out — nothing
   edits it.
4. **Publish phpMyAdmin:** `POST /api/databases/phpmyadmin/publish {}` → `url: "https://nova.hostingsignal.in/phpmyadmin/"`,
   `globalAlias.disabled:true` (`a2disconf phpmyadmin`: the distro's global Alias stops answering on customer sites). Verify:
   `curl -sI https://nova.hostingsignal.in/phpmyadmin/` → 200; `curl -sI https://nova.hostingsignal.in/phpmyadmin/setup/` →
   403; `curl -sI https://testuser.hostingsignal.in/phpmyadmin/` → 404; `GET /api/panel/databases/phpmyadmin` as `testuser`
   → `installed:true, url` = the hostname URL; logging in with a user created in `/panel/databases/users` shows only
   `testuser_*` databases.
5. **Security Advisor** rescan: `hostname.site` and `phpmyadmin.global_alias` are green; the `panel.mail.*` flags stay green.
6. **Lockout paths:** with `basic.contact_email` set on `testuser` (*Modify an Account*), the login page shows *Forgot
   password?*; request a reset for `testuser`, open the mailed link, set a new password, log in to `/panel`, FTP main login
   works (`password_synced_at` set). The admin side: *Reset 2FA* in the accounts row menu (audit `panel.admin.2fa.reset`).
7. Trackers: gate numbers of the deploy commit are in `CLAUDE.md` Current state and `CHECKLIST.md`.

### Hardening history (for the record)

The Phase-6 verifier (read-only, 2026-11-03) confirmed every audit fix as real, minimal and tested,
corrected the §4.1 wording of the previous handoff (the "web platform" fixes that landed are: CSP
`upgrade-insecure-requests` off without TLS, request-id validation, stream matching on path only,
Buffer bodies in audit, panel TOTP lockout + replay refusal, hub TOTP limiter — not cookie/CSRF/
session changes), and found: (1) **HIGH** a dump-screen bypass via `sql_mode` (`NO_BACKSLASH_ESCAPES`
makes the mysql client tokenise `\'` differently from the screen) — fixed in `transfer.js`
`sqlModeRefusal` (raw-line refusal of mode switches and expression-set modes; mysqldump's
`@OLD_SQL_MODE` idiom still passes) plus a GLOBAL `sql_mode` check before `source`; (2) `fs.write_file`
backed up through a symlinked path — now only regular files are backed up and a parent that is a
directory link is refused; (3) reseller job lists filtered after `LIMIT` — now filtered in SQL
(`jobs.list({ createdBy })`); (4) `ssl.js` dev regression on a root-owned `/tmp/whm`; (5)
enrollment confirmation now goes through the rate-limited `verifyTotp` (without the replay record);
(6) perf budget relaxed under `CI`. Accepted risks unchanged: certbot webroot under account
docroots, `find -exec chmod` TOCTOU in `mail.mailbox.fix_perms`, ModSecurity vendor archives unpacked
as root, `z.any()` on tweak-settings/schedule values, rolling sessions without an absolute cap, the
TOTP lockout maps living in memory (reset on restart). The PHP advisory seed (`002c`) is
`INSERT OR IGNORE`: when PHP publishes the CVE-2026-115560 ranges, ship a `002d` that updates the
setting only while it still equals the seed, or edit it in Security Advisor.

### Gate for the live-host fixes

To be recorded at deploy (the working tree was verified per suite on the host during the fix rounds, not as
one full gate). The milestone-2 numbers below are the last full gate at the head of the branch.

### Gate recorded at milestone 2 (head of branch)

| Suite | Result |
|---|---|
| server (vitest, zod 4) | 59 files, 1402 passed |
| agent (vitest) | 35 files, 615 passed, 2 skipped |
| client (vitest, react-router 7) | 268 passed |
| hub (node --test) | 184 passed |
| hub/ui (vitest) | 105 passed |
| plugins/sdk, sample plugin, 4 bundled plugins | all passed |
| `vite build` client + hub/ui | ok |
| monolithic boot + `e2e/ui-check.cjs` (admin flow) + `e2e/panel-check.cjs` (account user signs in, 39 panel pages, file manager, "Log in as") | pass, no console/5xx errors |

## 5. Rules that matter (full text in `CLAUDE.md`)

- Runs as root: never a shell string; every system call is an allowlisted agent op with a zod
  schema and `execFile(argv[])`; paths pinned under allowed roots; destructive ops marked.
- Every route validates with zod, has RBAC, writes an audit row; secrets encrypted at rest.
- zod 4 conventions: two-argument `z.record`, `.prefault({})` for nested defaults, `patchOf()` for
  PATCH bodies derived from a create schema with defaults, `fields.ipv4/ipv6/ip` (v3-parity IPv6).
- Category module contract: new categories/plugins add files, never edit shared files.
- Migrations are immutable once committed (`0NNb_` follow-ups); host first, DB second.
- `client/src/nav.js` is the single source of truth for the 212 functions; a label rename pins its
  slug with the fourth element `{ slug }` so keys, routes and files never change.
- UI: `docs/design/ui-design-system.md` is the contract (tokens only, shared components, naming).
- Token economy: screenshots at milestones; one fix round + one re-review; two review lenses only
  for root-level or signing code.
- Update `CHECKLIST.md`, `CLAUDE.md` and this file before every push.

## 6. Automation (none running)

No scheduled task is active. The multi-agent scripts used in this phase live only on the session's
machine; their inputs (design docs, contracts, `docs/design/ui-design-system.md`) are in the repo.

## 7. Where things are

```
BLUEPRINT.md   design of record (§1–18)       CHECKLIST.md  tracker + timeline     HANDOFF.md  this file
docs/INSTALL.md  installation guide            docs/MANUAL.md + MANUAL-partB.md + MANUAL-partC.md  user manual (every function + the account panel)
CLAUDE.md      conventions + memory            docs/design/  contracts, plugin host, marketplace, license, phase-5 plan,
                                                             ui-design-system.md, customer-panel.md
server/        panel API (routes/categories/<slug>.js, services/<slug>.js, routes/panel/*.js + services/panel*.js for the account panel, db/migrations 001–033c incl. 001d; middleware/tls-redirect.js, lib/request-log.js)
agent/         whm-agentd op families (sys svc user fs sec dns db net ssl mail pkg pkg-backports web hook acct backup transfer files cron vmail webmail ftp backup-read; as-user helper)
client/        React SPA (theme/, components/, pages/fn/<category>/<function>.jsx auto-registered; panel/ shell + pages/panel/<group>/ for the account panel; i18n/en.json)
plugins/       sdk/ (contract + mock host + pack.js), SDK.md, sample-plugin/, bundled/net.whm.{server-monitoring,imunifyav,wp-toolkit,automated-backup}
hub/           license + marketplace service (src/, shared/, license/, marketplace/, scripts/, test/) and ui/ portals
deploy/        whm-panel.service, whm-agentd.service, whm-hub.service, config templates
scripts/       install.sh (--with-hub, --upgrade), whm-cli.js, build-plugin.js
e2e/           ui-check.cjs (flow), screenshot-all.cjs (every page), screenshots.sh, live-hub-flow.sh, README.md
docs/screenshots/  labelled captures + galleries
```
