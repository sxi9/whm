# Phase 8 — account panel on a real host: prioritized plan

Scope read: `docs/design/customer-panel.md` (§1.3, §4.6–4.7, §9), `client/src/panel/*`, all 39 page components under `client/src/pages/panel/`, `server/src/routes/panel/*.js`, `server/src/services/panel-*.js`, the agent probes (`webmail.js`, `db.js`), contracts §33–40, `HANDOFF.md` §4, `docs/MANUAL-partC.md` §6.7/7.4.

Host facts used (nova.hostingsignal.in, 2026-11-05): Ubuntu 26.04, Apache + php8.5-fpm, BIND, Exim (unsplit Debian template, `exim4-daemon-light` unless the operator changed it), Dovecot 2.4.2, MariaDB, pure-ftpd (PureDB on), certbot/AutoSSL on, public DNS for `hostingsignal.in` at Cloudflare, no Roundcube, no phpMyAdmin (both available as distro packages: roundcube 1.6.11, phpmyadmin 5.2.3), account `testuser` with a live cert for `testuser.hostingsignal.in`, mail wiring in progress (HANDOFF §4 steps 3–5).

## What the code does today for the §9 open defaults

| Item | State in code |
|---|---|
| Webmail (§9 / §1.3) | Link + prefilled `_user` only. Agent probe `agent/src/ops/webmail.js:10-17` finds the first of `/usr/share/roundcube`, `/var/lib/roundcube`…; `aliasFor()` (`:58-64`) only accepts an *uncommented* `Alias` whose target `path.resolve`-equals the detected root. Service `server/src/services/panel-email.js:711-723` builds `https://<basic.hostname><alias>/` or uses `panel.webmail_url`. Page `client/src/pages/panel/email/webmail.jsx:9-13` appends `?_user=`. No SSO, no Dovecot master user anywhere. |
| phpMyAdmin | Probe `agent/src/ops/db.js:852-885`; service `server/src/services/database-services.js:1019-1029` → `https://<hostname><urlPath>`; panel trims it `server/src/services/panel-databases.js:233-240`; page `client/src/pages/panel/databases/phpmyadmin.jsx:11-15` appends `?pma_username=`. No signon. `db_users` has no password column (`server/src/db/migrations/001_init.sql:200-206`). |
| Sieve filters | Nothing. Only the Dovecot `sieve` protocol toggle in `server/src/services/service-configuration.js:511-512`. Autoresponders are Exim `autoreply` (`panel-email.js:528-534`). |
| Per-recipient spam thresholds | `mail_spam_settings` is per *account*; rendered to a server-wide lsearch keyed by domain (`panel-email.js:615-622`, `vmail.spam_users.write`). The DATA ACL takes the first recipient's domain (`service-configuration.js:231`); no PRDR. `spamd_address` is only honoured by content-scanning Exim builds (`service-configuration.js:173`). |
| Plugin pages in `/panel` | `GET /api/plugins/ui` is `requireReseller` (`server/src/routes/plugins.js:42-43`); `uiCatalog()` has no audience (`server/src/services/plugins.js:1788-1790`); manifest `ui.sidebar/pages` have no audience field (`plugins/sdk/validate-manifest.js:633-667`); plugin HTTP routes accept `roles:['user']` (`plugins/sdk/mock-host.js:771-772`, dispatch `plugins.js:1001-1002`) but a `user` principal reaches a handler with no `req.panel` scope. |
| Forced 2FA for customers | Panel-level only: `panel.require_2fa_for_users`, enforced twice (`server/src/routes/categories/panel.js:45-47` and `server/src/services/panel.js:458`), surfaced via `/me.policy.require2fa` and `panelRedirect` (`client/src/panel/PanelLayout.jsx:32`); disable refused while required (`server/src/routes/panel/security.js:116`). Core `needsEnrollment` excludes role `user` (`server/src/services/auth.js:99`); Security Center's policy summary does not mention it (`security-center.js:908-909, 1233`). |

## P0 — customer-blocking on the live host

### P0-1 Webmail on the real host: install Roundcube, publish it under the server hostname, fix detection
- Goal: `/panel/email/webmail` opens a working Roundcube instead of "Webmail is not set up on this server" (`webmail.jsx:20-26`).
- Why it fails today even after `apt install roundcube`: (a) Debian ships `/etc/roundcube/apache.conf` with the `Alias` lines commented out → `apacheAlias` null → `url` null; (b) even uncommented, the Alias targets `/var/lib/roundcube` while `WEBMAIL_CANDIDATES` matches `/usr/share/roundcube` first (`webmail.js:11-12`) and `aliasFor` requires exact root equality (`:61`); (c) `https://<hostname>/…` (`panel-email.js:714`) assumes an Apache vhost for the server hostname with a valid certificate — nothing renders one.
- Work: (1) `webmail.js`: treat `/var/lib/roundcube` and `/usr/share/roundcube` as the same install (resolve symlinks / accept either root in `aliasFor`); parse `Alias` lines inside `<VirtualHost>` blocks and `conf-enabled/keel-*.conf`. (2) New service-configuration op + seam `ctx.web.webmail.publish({ path: '/webmail', root })` writing `/etc/apache2/conf-available/keel-webmail.conf` (managed file, `a2enconf`) scoped to the server-hostname vhost (P0-2), never editing `/etc/roundcube/apache.conf`; admin action under Panel › Customization › Account panel next to `webmailUrl` (`client/src/pages/fn/cpanel/customization.jsx:234-235`). (3) Roundcube config managed block (`/etc/roundcube/config.inc.php` or a Keel include): `imap_host = ssl://<hostname>:993` (or `localhost:143` STARTTLS), `smtp_host = tls://localhost:587` once P0-3 is done, `product_name` from branding. (4) Panel home quick link: `QuickLinks` gets `webmailUrl` only from the setting (`server/src/services/panel.js:394`; `client/src/panel/PanelHome.jsx:145` passes `null`) — use the detected URL too.
- Files: `agent/src/ops/webmail.js` (+test), `server/src/services/service-configuration.js` (seam, contract addendum), `server/src/services/panel-email.js:700-723`, `server/src/services/panel.js:387-396`, `client/src/panel/PanelHome.jsx`, `client/src/pages/fn/cpanel/customization.jsx`, `docs/MANUAL-partC.md` §6.7, `docs/INSTALL.md`.
- Host: `apt install roundcube roundcube-core roundcube-mysql` (dbconfig creates the `roundcube` DB on MariaDB), P0-2 vhost + certificate.
- Acceptance (live): as `testuser`, `/panel/email/webmail` shows "available", "Open webmail" lands on `https://nova.hostingsignal.in/webmail/` with the mailbox prefilled and a valid certificate; `GET /api/panel/email/webmail` → `installed:true, flavor:'roundcube', url` set with `panel.webmail_url` empty; IMAP login via Roundcube succeeds with a panel-created mailbox.
- Effort: M.

### P0-2 Server-hostname vhost with the service certificate (shared prerequisite)
- Goal: `https://nova.hostingsignal.in/` is served by a panel-managed Apache vhost carrying the AutoSSL hostname certificate, so `/webmail`, `/phpmyadmin` and the client-settings hostnames (`panel-email.js:131, 368`) do not land on the first customer vhost with a mismatched certificate.
- Work: `ctx.web.ensureHostnameVhost()` in service-configuration (docroot `/var/www/keel-host`, aliases from P0-1/P0-5, optional redirect of `/` to `https://host:2087`); run from `basic.hostname` change and from the service-cert install path; Security Advisor finding when absent.
- Files: `server/src/services/service-configuration.js`, `agent/src/ops/web.js` (vhost template `:462` area), `server/src/services/ssl-tls.js` (service-cert apply), docs.
- Host: HANDOFF §4 step 5 (`POST /api/ssl/autossl/run {"domain":"nova.hostingsignal.in"}`), FTP/Dovecot/Exim service certs.
- Acceptance: `curl -vI https://nova.hostingsignal.in/` shows the hostname cert and the Keel landing page; `openssl s_client -connect nova.hostingsignal.in:993` and `:21 -starttls ftp` show the same cert; Thunderbird autoconfig with the values from "Connect" (`client/src/pages/panel/email/accounts.jsx:120-143`) connects without warnings.
- Effort: M.

### P0-3 Mail that actually works from the panel's point of view (wiring live, submission ports, truthful client settings)
- Goal: a mailbox created in `/panel/email/accounts` can log in (IMAP), send (SMTP AUTH on 587/465) and the "Connect" sheet tells the truth.
- Code defects: `accounts.jsx:138` prints "Authentication: Required — same username and password" unconditionally; the API returns `smtp.auth = null` while the wiring is not live (`panel-email.js:218-224`) — render the `auth`/`submissionPorts` flags ("Sending is not enabled yet — ask your provider" when `auth` is null; warn that port 25 is blocked by most ISPs when `submissionPorts:false`). The list's `virtualMailWarning` only appears when rows exist; the empty state (`accounts.jsx:247`) should also say when the wiring is not live. `accounts.jsx:58` help "At least 8 characters" vs server `passwordStrength(pw,'email')` (`panel-email.js:207-212`) — show the server's minimum.
- Host (operator, HANDOFF §4 steps 3–4): the three `.include_if_exists` lines in `exim4.conf.template`, `POST /api/service-config/virtual-mail/apply`, `submissionPorts` on, EC2 SG 465/587, Exim TLS preset. Spam settings (`/panel/email/spam`) additionally need `exim4-daemon-heavy` + `spamassassin`/`spamd`; `spam.jsx:117` only warns when the binary is missing, a `light` daemon passes the capability check and silently ignores `spam =` — add a Security Advisor/`vmail.render.check` finding "Exim without content scanning" and `available:false` in `spam.get` (`panel-email.js:625-628`).
- Acceptance: `doveadm auth test user@testuser.hostingsignal.in` ok; `swaks --auth --server nova.hostingsignal.in:587 --tls` sends; a mail with `X-Spam-Score` arrives at a filtered mailbox; Connect sheet shows 587/465 with "Authentication: required".
- Effort: S (code) + host steps.

### P0-4 DNS delegation awareness (public DNS is at Cloudflare)
- Goal: stop reporting success for DNS changes with no public effect. On nova every zone-editor record (`client/src/pages/panel/dns/zone-editor.jsx`), every subdomain A record, addon zones (`addon-domains.jsx:36` "Create a DNS zone" default on) and the Deliverability "Fix" (`panel-email.js:669-675` writes BIND; `check` reads the public resolver, `server/src/services/email.js:308-424`) land in BIND, which is not authoritative.
- Work: `panel-dns.js` gains `delegation(domain)` reusing dns-functions' delegation logic (`server/src/services/dns-functions.js:1015-1028`, cached 10 min): `{ delegatedHere, delegatedNs[] }`; `GET /dns/zones` and `/domains` carry it; zone editor, subdomains, addon form, deliverability and SSL status render a persistent banner "DNS for this domain is managed at <ns>; records you add here are not published — add them there as well"; addon form defaults `createZone` off when the parent is not delegated here; Deliverability "Fix" returns the records to copy.
- Files: `server/src/services/panel-dns.js`, `panel-domains.js`, `panel-email.js:664-676`, `client/src/pages/panel/dns/zone-editor.jsx`, `domains/subdomains.jsx`, `domains/addon-domains.jsx:30-36`, `email/deliverability.jsx`, `ssl/status.jsx`.
- Acceptance: on `testuser.hostingsignal.in` the zone editor shows the Cloudflare banner; creating `blog.testuser…` yields a result card saying the record must be added at Cloudflare; after adding it there `dig` resolves and AutoSSL "Issue now" succeeds.
- Effort: M.

### P0-5 phpMyAdmin: install from the distro, publish under the hostname vhost, truthful link
- Work: `apt install phpmyadmin` (apache2, dbconfig creates the control user — already in `SYSTEM_USERS`, `database-services.js:56`); detection works (`db.js:852-854`), but `a2disconf phpmyadmin` and publish through the same `keel-*.conf` mechanism as P0-1 so the alias lives only in the hostname vhost. `pma_username` as a GET parameter is ignored by phpMyAdmin 5.x cookie auth — verify; if confirmed drop the prefill wording in `phpmyadmin.jsx:38, 51` until P1-2.
- Files: `agent/src/ops/db.js`, `server/src/services/database-services.js:1019-1036`, `client/src/pages/panel/databases/phpmyadmin.jsx`, docs §7.4.
- Acceptance: `GET /api/panel/databases/phpmyadmin` → `installed:true, url:'https://nova.hostingsignal.in/phpmyadmin/'`; logging in with a user created in `/panel/databases/users` shows only `testuser_*` databases.
- Effort: S.

### P0-6 Lockout paths a customer hits on day one
- Gaps: `client/src/pages/Login.jsx` has no "forgot password"; `two-factor.jsx:104` promises "Your hosting provider can reset the second factor" — verify an admin route exists for a role-`user` row (else add `POST /api/panel/admin/accounts/:username/2fa/reset` + a row action next to "Log in as").
- Work: password reset by e-mail to `accounts.contact_email` (`ctx.contacts.sendMail`): `POST /api/auth/reset/request` (public, rate-limited, always 202), signed single-use token (30 min, SHA-256 stored), `POST /api/auth/reset/confirm` → `ctx.panel.changePasswordForUser` (`panel.js:573`); login link only when `panel.enabled`. Admin 2FA reset audited `panel.admin.2fa.reset`.
- Files: `server/src/routes/auth.js`, `server/src/services/panel.js`, `server/src/routes/categories/panel.js:98-100`, `client/src/pages/Login.jsx`, accounts row menu. Migration `034_panel-recovery.sql` (`password_reset_tokens`) — landed; P1 migrations continue at `034b`.
- Acceptance: request a reset for `testuser`, receive the mail at the contact address, set a new password, log in to `/panel`, FTP main login works (`password_synced_at` set).
- Effort: M.

## P1 — major feature gaps

### P1-1 Roundcube single sign-on (Dovecot master user + one-time token + Keel Roundcube plugin)
- Design: (1) service-configuration renders a master passdb into `98-whm-virtual-auth.conf` (contract §36): `auth_master_user_separator = *`, `passdb passwd-file { master = yes; args = /etc/dovecot/whm/master-users }` before the virtual passdb, 2.3/2.4 variants; master password generated once, stored encrypted (`lib/crypto.js`) under `panel.webmail.master_enc`, written by a new op `vmail.master.write { hash }`. (2) `POST /api/panel/email/webmail/sso { mailbox }` (session-only, mailbox must be the account's, audited) → `{ url }` with a 60 s single-use token (`panel_sso_tokens`, migration `034b_panel-sso.sql` — `034_panel-recovery.sql` is taken by P0-6 and migrations are immutable once committed). (3) Keel-shipped Roundcube plugin `keel_sso` (PHP, `/var/lib/roundcube/plugins/keel_sso`) hooks `startup`, exchanges `?_keel=<token>` against loopback `GET https://127.0.0.1:2087/api/panel/sso/webmail/<token>` (loopback-only, once) and calls `$rcmail->login("$user*$masterUser", $masterPassword, $host)`. (4) `webmail.jsx` uses SSO when `sso:true`. Refused while impersonating unless `panel.login_as_webmail` is on (audited).
- Files: `server/src/db/migrations/034b_panel-sso.sql`, `server/src/services/panel-email.js`, `server/src/routes/panel/email.js:129`, `server/src/routes/categories/panel.js` (loopback exchange outside `panelScope`), `agent/src/ops/vmail.js`, `server/src/services/service-configuration.js`, `deploy/roundcube/keel_sso/` (+ `scripts/install.sh` copy step), `client/src/pages/panel/email/webmail.jsx`, contracts §36, manual §6.7.
- Prereq: P0-1, P0-2, P0-3, Dovecot restart. Acceptance: "Open" → Roundcube inbox without a login form; token replay 404; `doveadm auth test 'user@dom*keel-master' <masterpw>` succeeds and the plain password still works; audit row. Effort: L (two review lenses).

### P1-2 phpMyAdmin signon
- Design: `auth_type = 'signon'` via `/etc/phpmyadmin/conf.d/keel-signon.php` (Debian globs `conf.d/*.php`) pointing `SignonURL` at a Keel-shipped `/keel/pma-signon.php` under the hostname vhost. Credential: hidden per-account SSO user `<username>_pma` with `GRANT ALL ON \`<username>\_%\`.*`, password rotated on every signon (`db.user.set_password`); one-time token exchange (same table as P1-1) returns `{ user, password, host }`; `pma-signon.php` sets `$_SESSION['PMA_single_signon_*']`. Hide `*_pma` from `listUsers` (`panel-databases.js:159-163`) and WHM lists; exclude from backup grant replay.
- Files: `server/src/services/panel-databases.js`, `server/src/routes/panel/databases.js`, `server/src/services/database-services.js` (wildcard grant helper, hidden-user flag via a follow-up migration), `deploy/phpmyadmin/keel-signon.php` + `conf.d` drop-in, `client/src/pages/panel/databases/phpmyadmin.jsx`.
- Acceptance: "Open phpMyAdmin" → logged in, sees `testuser_*` only; wildcard grant visible; password differs between signons; user hidden in `/panel/databases/users`. Effort: M/L.

### P1-3 Email filters (Sieve): per-mailbox and account-wide
- Design: `dovecot-sieve` (Pigeonhole), `mail_plugins = $mail_plugins sieve` on LMTP in `98-whm-virtual-auth.conf`, `sieve = file:~/mail/%d/%n/sieve;active=~/mail/%d/%n/.dovecot.sieve`, `sieve_before = ~/mail/sieve-global`. Scripts rendered server-side from structured rules (`mail_filters` table, migration `034c_panel-mail-filters.sql` — `034` is P0-6's recovery table, `034b` is reserved for P1-1: scope mailbox|account, name, match[] {header, op contains|is|matches, value}, action fileinto|discard|redirect|stop, order) — never free-form Sieve; written as the account uid through `files.write`, compiled with `sievec` under `as-user` before activation. Pages `email/filters.jsx`, `email/global-filters.jsx`; nav entries with feature `emailfilters`. ManageSieve stays off.
- Files: `agent/src/ops/vmail.js` (`vmail.sieve.compile`), `server/src/services/panel-email.js`, `server/src/routes/panel/email.js`, `server/src/services/service-configuration.js`, `client/src/panel/nav.js`, two pages, `server/src/db/seed.js`.
- Host: `apt install dovecot-sieve`, wiring live. Acceptance: rule "Subject contains [test] → Junk"; `sievec -d` passes; LMTP-delivered test lands in Junk; values with `"` and `\` do not break the script. Effort: L.

### P1-4 Email routing per domain (local / remote / backup MX)
- Work: `GET/PUT /email/domains/:domain/routing { routing: 'auto'|'local'|'remote' }` → `ctx.mail.setRouting` after the §3.2 domain check; refuse `remote` while mailboxes exist (409); page `email/routing.jsx` showing the MX lookup (reuse `email.js:349-352`). Today the panel only forces `local` on first mailbox (`panel-email.js:195-205`).
- Acceptance: set remote → `exim -bt someone@testuser…` routes via dnslookup; local → `whm_virtual_user`. Effort: M.

### P1-5 Web statistics (Visitors)
- Work: GoAccess (`apt install goaccess`): daily job `panel.stats.generate` renders a static HTML report per domain from `/var/log/whm/domlogs/<user>/<domain>-access.log` into `<home>/.keel/stats/<domain>.html` as the account uid, plus a JSON summary for an in-panel "Visitors" page; HTML served in a sandboxed iframe route `GET /logs/stats/:domain/report` (`Content-Security-Policy: sandbox`). New `agent/src/ops/stats.js` (`stats.goaccess.run`, `--log-format=COMBINED`, timeouts), `server/src/services/panel-logs.js`, `routes/panel/logs.js`, page, nav `Visitors` (feature `webstats`).
- Acceptance: after requests to the site the Visitors page shows them (or after "Generate now"); report renders without CSP errors. Effort: M.

### P1-6 Directory privacy, IP blocker, custom error pages, indexes (the `.htaccess` family)
- Work: agent op `files.htaccess.set { username, path, block }` rendering a `# BEGIN Keel`…`# END Keel` block (`Require not ip <validated ip/cidr>`, `ErrorDocument 404 /errors/404.html`, `Options -Indexes`, `AuthType Basic` + `AuthUserFile <home>/.keel/htpasswd/<id>`), bcrypt htpasswd hashes generated server-side. Pages `security/ip-blocker.jsx`, `files/directory-privacy.jsx`, `advanced/error-pages.jsx`, `files/indexes.jsx`. Verify the vhost template's `AllowOverride` covers AuthConfig Limit Indexes FileInfo (today `AllowOverride All`).
- Acceptance: blocked IP gets 403; protected `/private` 401 then 200; custom 404 served; listing becomes 403. Effort: M (pages S once the op exists).

### P1-7 WordPress install from the panel
- Work: `POST /software/wordpress { domain, path, title, adminUser, adminEmail }` → 202 job creating DB + user via `panel-databases`, download/unpack via existing `web.wp.*` ops as the account, `wp-config.php`; page `software/wordpress.jsx` listing installs (detected by `wp-config.php`), "Open admin", "Update" (wp-cli if present). Nav group Software (feature `wordpress`). Files: `agent/src/ops/web.js` (as-user review), new `server/src/services/panel-software.js`, `routes/panel/software.js`, page, nav. Host: `php8.5-mysql`, `curl`/`unzip`, optional `wp-cli`.
- Acceptance: install at `testuser.hostingsignal.in/blog`, `/blog/wp-admin` logs in; files owned by `testuser`; DB visible in `/panel/databases`. Effort: L.

### P1-8 Preferences: contact info, language, notifications
- Work: `PUT /me/contact { email, email2?, notify: {quota, bandwidth, passwordChange} }` writing `accounts.contact_email` (+ `users.email`, audited); `PUT /me/locale` storing `users.locale`, SPA honouring it in `useT()`; page `overview/preferences.jsx`. Today `contactEmail` is read-only (`client/src/pages/panel/overview/account.jsx:52`). Depends on P1-10. Effort: S/M.

### P1-9 Two-factor UX and the "core policy" question
- Work: QR code for `otpauthUrl` (`client/src/pages/panel/security/two-factor.jsx:86-92` shows secret + raw URL only; dependency-free QR SVG encoder shared with the admin page); recovery codes if `ctx.auth` supports them, else say so. Policy: keep panel-side enforcement but remove the duplicate check (`routes/categories/panel.js:45-47` vs `services/panel.js:458`), show "Account panel users: required/optional" in Security Center's policy summary (`security-center.js:1233`), and list how many linked users lack TOTP when switching the setting on. Effort: S.

### P1-10 Internationalisation of the 38 untranslated pages
- Only `overview/account.jsx` calls `useT()`; `PanelPage.jsx:60-63, 79-83, 93-96, 105-106` and the home greetings are hard-coded English; `en.json` has 157 `panel.*` keys (shell/labels only). Work: per-group `panel.<group>.*` keys, pages switched to `t()` for every user-visible string, `PanelPage.jsx` states translated, a pseudo-locale pass in `panel-check.cjs`. Effort: L (one builder per page group).

### P1-11 Mobile layout fixes
- Defects: `client/src/theme/base.css:112,119` `.page-header-actions { flex: none }` → header buttons overflow at 375 px (`domains/domains.jsx:41-47`, `ssl/status.jsx:113-115`, `phpmyadmin.jsx:31`); `base.css:290-291` `.search .input { width: 280px }`; `base.css:126-129` `.kv > div` two-column squeezes long values (`overview/account.jsx:53`, `email/accounts.jsx:125-131`); `PanelTopBar.jsx:49` shows `Alt /` on touch; `.home-hero` (`base.css:138`); `PanelHome.jsx:102` inline quick-link row; file-manager toolbar (14 icons) untested below 640 px. Work: `@media (max-width: 640px)` rules, `kbd` hidden on coarse pointers, toolbar overflow menu; Playwright run of `panel-check.cjs` at 390×844 added to the gate. Effort: M.

### P1-12 Track delivery and mailbox disk usage
- Work: `GET /email/usage/messages?q&status&page` (post-filtered delegate; today `email/usage.jsx` shows the last 100 rows, `panel-email.js:756`), per-mailbox folders via `doveadm mailbox status` (new `vmail.mailbox.status`), "Empty folder" via `doveadm expunge` restricted to Trash/Junk/older-than-N. Effort: M.

## P2 — polish and deferred design items

- P2-1 Plugin pages inside `/panel` (§9.15): SDK `ui.pages[].audience: 'admin'|'panel'` (`validate-manifest.js:383-667`), `HOST_API_VERSION` 1.1.0; host `uiCatalog({ audience })` (`plugins.js:1788`), `GET /api/panel/plugins/ui` + `/file` behind `panelScope`, plugin `dispatch` attaches `req.panel` for `roles:['user']` handlers (`plugins.js:994-1002`); client panel variant of `usePluginNav` reusing `pages/plugins/PluginPage.jsx`. Effort L.
- P2-2 Per-recipient spam thresholds (§9.11): PRDR (`prdr_enable`, `acl_smtp_data_prdr`) keyed by full recipient, or document per-account as matching cPanel. Effort M / S.
- P2-3 Forced 2FA as a core `auth.policy()` flag (`auth.js:36-37, 99`, `middleware/auth.js:84`) — only if one switch for all roles is wanted. Effort S.
- P2-4 MySQL Database Wizard (3-step form). Effort S.
- P2-5 Errors page (last N lines of every `*-error.log`, from the existing tail API, `logs/access-logs.jsx:54`). Effort S.
- P2-6 Optimize website (mod_deflate), hotlink protection via the P1-6 op. Effort S each.
- P2-7 Track DNS (`dig`/`traceroute` read-only ops, strict host regex). Effort S.
- P2-8 Dynamic DNS (token-authenticated A-record update; meaningful once delegation is "here"). Effort M.
- P2-9 Virus scanner (reuse `sec.clamav.*` as the account via `clamdscan --fdpass`). Effort M.
- P2-10 Terminal / Git / Web Disk / Mailing lists / Calendars / User Manager — deferred (§1.3).
- P2-11 Upload transport (§9.13): `express.raw` octet-stream chunks with drag-and-drop. Effort M.
- P2-12 Wording/a11y: `PanelPage.jsx:60-63` "ask your provider" for a 501 `shell_disabled` that is a plan setting (`routes/panel/security.js:61`) — map by `error.code`; `PanelTopBar.jsx:62-78` menu closes only on `onMouseLeave`, no `role="menuitem"`, no Escape; meters (`PanelHome.jsx:46`, `usage/usage.jsx:37`, `email/accounts.jsx:28`) lack `role="progressbar"`; `domains/domains.jsx:62-64` tabs without `aria-controls`; `PanelHome.jsx:65` links every domain as `http://` even with a certificate. Effort S.
- P2-13 Quota source note `usage/usage.jsx:105` — show the scan age prominently when figures come from the scan. Effort S.

## Items that would mislead on nova today
1. Webmail/phpMyAdmin URLs assume a hostname vhost + cert (`panel-email.js:714`, `database-services.js:1024`) — P0-2.
2. Roundcube detection cannot see a Debian install (`webmail.js:11-12, 58-64`) — P0-1.
3. "Authentication: Required" and port-25-only SMTP in the Connect sheet (`email/accounts.jsx:138`) — P0-3.
4. DNS edits/fixes silently unpublished because Cloudflare is authoritative — P0-4.
5. Spam settings accepted on a non-content-scanning Exim (`spam.jsx:117`, `service-configuration.js:173`) — P0-3.
6. `pma_username` GET prefill likely ignored by phpMyAdmin 5 (`phpmyadmin.jsx:14`) — P0-5/P1-2.
7. `http://` domain links on the home page despite AutoSSL (`PanelHome.jsx:65`) — P2-12.
8. "Your hosting provider can reset the second factor" (`two-factor.jsx:104`) and no forgot-password path — P0-6.
9. IMAP/FTP certificate mismatch until service certs are installed (HANDOFF §4.5) — P0-2.

## Suggested sequencing
P0-2 → P0-1 + P0-5 (same vhost/publish mechanism) → P0-3 (host steps already queued) → P0-4 → P0-6; then P1-1/P1-2 (share the SSO token table and loopback exchange; two review lenses), P1-3 + P1-4 (mail), P1-6 (`.htaccess` op unlocks four pages), P1-5, P1-7, P1-8/P1-9, with P1-10/P1-11 as parallel page-group sweeps like Phase 7.
