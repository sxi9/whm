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
