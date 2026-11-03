# Part C — The account panel

The **account panel** is the customer-facing side of Keel: what a hosting-account owner sees at
**`/panel`** on the same server, in the same process, as the administrative console described in
Parts A and B. It is scoped to exactly **one hosting account per session** and offers the
day-to-day work cPanel offers: domains, DNS records, certificates, files, mailboxes, databases,
FTP logins, cron jobs, backups, logs, PHP, security and usage.

This part is derived from the code as it stands: the navigation in
[`client/src/panel/nav.js`](../client/src/panel/nav.js) (14 groups, 39 functions), the shell under
[`client/src/panel/`](../client/src/panel/README.md), the routers under
[`server/src/routes/panel/`](../server/src/routes/panel/) and
[`server/src/routes/categories/panel.js`](../server/src/routes/categories/panel.js), the services
`server/src/services/panel*.js`, the agent op families `files`, `cron`, `vmail`, `ftp`, `webmail`
and `backup-read`, and the design of record
[`docs/design/customer-panel.md`](design/customer-panel.md). Where the design mentions something
the code does not implement yet, this part says it is not available in this version rather than
describing it.

## Contents of Part C

- [C.1 Who gets a login](#c1-who-gets-a-login)
- [C.2 Signing in and where it lands](#c2-signing-in-and-where-it-lands)
- [C.3 Password and two-factor rules](#c3-password-and-two-factor-rules)
- [C.4 Suspended, demo and forced-change states](#c4-suspended-demo-and-forced-change-states)
- [C.5 "Log in as": when an administrator views your account](#c5-log-in-as-when-an-administrator-views-your-account)
- [C.6 The layout](#c6-the-layout)
- [C.7 How the panel keeps to one account](#c7-how-the-panel-keeps-to-one-account)
- [C.8 Reading the function blocks](#c8-reading-the-function-blocks)
- Groups: [1. Overview](#1-overview) · [2. Domains](#2-domains) · [3. DNS](#3-dns) · [4. SSL](#4-ssl) ·
  [5. Files](#5-files) · [6. Email](#6-email) · [7. Databases](#7-databases) · [8. FTP](#8-ftp) ·
  [9. Cron](#9-cron) · [10. Backups](#10-backups) · [11. Logs](#11-logs) · [12. PHP](#12-php) ·
  [13. Security](#13-security) · [14. Usage](#14-usage)
- [C.9 Administering the account panel](#c9-administering-the-account-panel)
- [C.10 Troubleshooting](#c10-troubleshooting)

---

## C.1 Who gets a login

**Every hosting account has a panel login with the account's username.** The login is a
role-`user` row in the panel's `users` table linked to the account through the `account_users`
table (migration `033_panel.sql`); username equality alone never authorises anything, the link
does. The row is created (`services/panel.js` `ensureUser`):

- when an account is created (the `account.created` event, after the Linux user exists);
- at boot, for every account that has no link yet (a backfill; the log line
  `panel: linked account users` reports how many were created or adopted);
- on demand by an administrator (`POST /api/panel/admin/accounts/:username/user`, [C.9](#c9-administering-the-account-panel)).

Two special cases:

| Case | Behaviour |
|---|---|
| **Demoted reseller.** *Resellers › Reseller Center › Reset* leaves a role-`user` row with the account's username. | The row is **adopted**, never duplicated: it is linked to the account and the adoption is audited (`panel.user.adopt`). Its password keeps working. |
| **Username of an administrator.** The account's username is also a `root` or `reseller` login. | No panel user is created (`reason: username_is_admin`); the administrator uses "Log in as" instead. |

A freshly linked login has **no password** until one is set: the panel stores a bcrypt copy of the
account password (`users.password_hash`) and a login against an empty hash always fails. The copy
is written when the account is created **with** a password, by *Account Functions › Password
Modification*, by the panel's own *Security › Password* page, or by the admin endpoints in C.9. The
Linux password (FTP, SSH, system-user IMAP) and the panel copy are kept together: the Linux side is
changed first, the hash second, and `account_users.password_synced_at` records the last time both
were written. A login whose hash was never synced shows the warning `password_not_synced` to
administrators.

**Suspension and termination follow the account.** *Suspend* flips the login's `suspended` flag
and destroys its sessions; *Unsuspend* clears it; *Terminate* removes the login (cascade) after
destroying its sessions (`panel.user.remove` in the audit log).

## C.2 Signing in and where it lands

Account users sign in on the **same login page** as administrators (`http://server:2086/login`,
`https://server:2087/login` when TLS is configured, see Part A *Signing in*) with the account
username and password. After a successful login a role-`user` session lands on **`/panel`**
(`client/src/auth/home.js` `landingFor`); a remembered location is honoured only when it is inside
`/panel`, so a user is never sent to a console route and an administrator is never bounced into
the account panel by a stale link.

Everything the login path enforces for administrators applies unchanged, because it is keyed on
the `users` row (`services/auth.js`): cPHulk blocks, the 20-per-15-minutes rate limit, the cookie
session (`httpOnly`, `sameSite=strict`, `secure` over TLS, 8 h by default), the idle-session
timeout, *One active session per user*, *Maximum password age*, the verified-IP notification and
TOTP at login when the user has enrolled an authenticator.

The first request of the shell is `GET /api/panel/me`, which returns the account (username, main
domain, IP, package, plan, features, limits, contact e-mail, home directory, shell, domains), the
usage summary, object counts, the acting-as context, the policy flags and a CSRF token. When that
call is refused the shell is replaced by a full-page notice instead of a page:

| `/api/panel/me` answer | Notice |
|---|---|
| `403 panel_disabled` | *The account panel is switched off* — the operator set `panel.enabled=false` ([C.9](#c9-administering-the-account-panel)). |
| `403 no_account` | *No hosting account is linked to this login* — a role-`user` row without an `account_users` link. |
| `403 panel_scope_required` | *Choose an account to view* — an administrator opened `/panel` without "Log in as"; the notice offers *Back to the console*. |
| `403 login_as_ended` | *The "Log in as" session has ended* (reason in [C.5](#c5-log-in-as-when-an-administrator-views-your-account)). |
| `423 account_suspended` | the account is suspended; sign out and contact the provider. |

Administrators (root, resellers) **cannot browse `/panel` as themselves**: the only way in is
"Log in as" (C.5). That is deliberate — every administrator view of a customer panel is time-boxed
and audited.

## C.3 Password and two-factor rules

- **Changing the password** is done on *Security › Password* (`/panel/security/password`;
  `/panel/change-password` redirects there). The current password is verified first, the new one
  must pass the server's password-strength policy for the `account` context (*Security Center ›
  Password Strength Configuration*), the Linux password is set through the agent (`chpasswd`, the
  secret on stdin), then the panel hash is written and **every session of the login is ended** —
  the one you are using is re-created on the spot, with a fresh CSRF token. Requires the plan
  feature `passwordchange`. Not possible while an administrator is viewing the account (C.5).
- **Forced change.** When *Account Functions › Force Password Change* is set on the account, or the
  login carries `mustChangePassword` (password older than the maximum age), the panel answers
  `403 password_change_required` to everything but `/me` and the password endpoint and the shell
  redirects to the password page with the banner *A new password is required*. The password change
  clears both flags.
- **Two-factor authentication** is TOTP, enrolled on *Security › Two-factor authentication* (the
  same enrolment the console uses: secret and QR code, then a 6-digit code to confirm). Once
  enabled, the login page asks for the code after the password. The console policies that *force*
  enrolment (`required_for_root`, `require_2fa_for_resellers`) never apply to account users;
  instead the operator can turn on the panel setting **Require 2FA for account users**
  (`panel.require_2fa_for_users`). While it is on and the login has no authenticator, every panel
  request except `/me` and the two-factor pages answers `403 two_factor_required` and the shell
  redirects to the enrolment page; disabling 2FA is refused.
- **API tokens** (*Security › API tokens*) are subject to the console's *API tokens require 2FA*
  security policy: with it on, a login without an authenticator cannot create one.
- Credentials are changed from a browser session only: an API token that reaches the password,
  two-factor, SSH-key or session endpoints with a mutation gets `403 session_required`.

## C.4 Suspended, demo and forced-change states

The scope middleware (`panelScope` in `routes/categories/panel.js`) runs once per request, after
the account is loaded, and applies the account's state before any page logic:

| State | Effect | Banner |
|---|---|---|
| `accounts.suspended = 1` | `423 account_suspended` on every request (also for an administrator who is viewing the account). | *This account is suspended* |
| `accounts.demo_mode = 1` (*Account Functions › Manage Demo Mode*) | every non-GET request answers `403 demo_mode`; pages still load. | *Demo mode — this account is read-only* |
| `accounts.force_password_change = 1` or `users.must_change_password = 1` | only `/me` and `/security/password` pass (`403 password_change_required`). | *A new password is required* |
| `panel.require_2fa_for_users` and no authenticator | only `/me` and `/security/two-factor*` pass (`403 two_factor_required`). | redirect to the enrolment page |

## C.5 "Log in as": when an administrator views your account

Root, or a reseller who owns the account and holds the `login-as` privilege, can open the account
panel **as the account** from *List Accounts* (row menu › **Log in as**). There is no session swap:
the administrator keeps its own session and identity, and the panel pins an *acting-as* context on
it for a limited time (`panel.login_as_ttl_minutes`, default 60, 5–480). The console opens `/panel`
in a new tab.

What the account owner and the administrator see while it lasts:

- A persistent banner **"Viewing *account* as *admin* · ends in *N* min · Exit"** on every page, and
  the footer reads *Signed in as admin (viewing account)*. **Exit** ends the impersonation
  (`POST /api/panel/admin/logout-as`), closes the tab the console opened or returns to the console.
- The acting context is **re-checked on every request**: it ends immediately, with
  `403 login_as_ended` and the full-page notice *The "Log in as" session has ended*, when the TTL
  passes (`expired`), the account is suspended (`account_suspended`) or removed
  (`account_removed`), the reseller no longer owns it (`ownership`), the privilege was withdrawn
  (`acl`), or another "Log in as" replaced it (`replaced`). Each end is audited
  (`panel.login_as.ended` with the reason).
- Starting it is refused for a **suspended** account (`409 account_suspended`: unsuspend first),
  from an API token (it needs a browser session), and for a reseller without the privilege (403).
- **What is refused while acting** (`403 not_while_impersonating`): changing the account
  password; enrolling, confirming or disabling two-factor authentication; adding or removing SSH
  keys; listing or ending the account's sessions; creating or revoking API tokens. The user menu
  hides *Change password* and *Two-factor authentication* in this mode. Everything else — files,
  mail, domains, databases, backups, cron — works and is audited with the **administrator as the
  principal** and `actingAs: <account>`, `by: <admin>` in the arguments, so the audit log never
  attributes an administrator's change to the customer.

The acting context is also what a reseller's customer inherits in reverse: an action the reseller
may not take on its own accounts (a missing reseller ACL such as `edit-dns`) is refused when the
customer of that reseller takes it, because the panel delegates to the existing services as the
account's **owner** ([C.7](#c7-how-the-panel-keeps-to-one-account)).

## C.6 The layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ☰  Keel [Search tools (Alt /)]                       account ▾  user ▾   │
├───────────────┬──────────────────────────────────────────────────────────┤
│ Favorites     │ acting-as / suspended / forced-password / demo banners   │
│ Overview      │                                                          │
│ Domains       │  Page header (breadcrumb to /panel, star to favourite)   │
│ DNS           │  Cards, tables, forms                                    │
│ SSL           │                                                          │
│ Files         │                                                          │
│ Email  …      │                                                          │
├───────────────┴──────────────────────────────────────────────────────────┤
│ company · tagline                           Signed in as <user>          │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Sidebar:** the 14 groups and their functions from `nav.js`, as group tiles on the home page
  and as an expandable list. A function that names a plan feature (`feature` in `nav.js`) is
  **hidden when the package sets that feature to `false`**; a feature key the package does not
  mention counts as enabled (cPanel semantics). Favourites are stored in the browser
  (`localStorage` key `whm.panel.favorites`, separate from the console's) and the collapsed state
  under `whm.panel.sidebar.*`.
- **Top bar:** a search over the panel functions (**Alt /** focuses it; eight best matches by
  label, group and description), the account chip and the user menu (*Change password*,
  *Two-factor authentication*, the help/documentation/support links from *Panel › Customization*,
  *Sign out*). There is no audit-log link and no notification bell, no license or marketplace
  banner and no plugin navigation in this shell (plugin pages inside `/panel` are not available in
  this version).
- **Branding** (company name, tagline, logo, colours, footer text) is the one configured under
  *Panel › Customization*; the login page shows the same.
- Labels come from the locale catalogue under the keys `panel.<group>/<function>.label` and
  `panel.shell.*`, so *Locales* translations apply.

## C.7 How the panel keeps to one account

1. The page calls `/api/panel/...`. Every request is validated with zod (bad fields come back as
   `422` with per-field messages) and carries the CSRF token.
2. `panelScope` resolves **the one account of the session**: for a role-`user` login the linked
   account; for an administrator the acting-as account (C.5). Services receive that scope and
   never take a username, account id, home path or zone name from the client without matching it
   against the pinned account first (`404`/`403` otherwise).
3. Where the panel reuses a console service (DNS, SSL, databases, backups, PHP, logs) it calls it
   **as the account's owner** — root for root-owned accounts, the reseller for reseller-owned ones
   — so reseller ACLs keep applying. **Plan limits are the panel's own job**: every `max_*` of the
   package (`max_addons`, `max_subdomains`, `max_parked`, `max_email`, `max_ftp`, `max_sql`) is
   counted by the panel and refused with `409 limit_reached` before anything is delegated, and
   every "force" switch of the console services is hard-coded off.
4. Anything that touches the account's files **runs as the account's uid** (`setpriv`, or
   `runuser` where `setpriv` is missing — capability `panel-files`): the file manager, maildir
   creation, document roots, `.user.ini`, `.spamassassin/user_prefs`, `authorized_keys`, dumps
   copied into `~/backups`. Quota and permissions are therefore enforced by the kernel, and a
   symlink planted in the home cannot reach anything the account could not read itself.
5. Mail, cron and FTP logins go through root-side agent ops that rewrite panel-owned files
   (Dovecot passwd files, Exim alias and forwarding lists, the user crontab, the virtual-user
   database) with every field regex-validated and secrets on stdin, never on a command line.
6. **Host first, database second** and **long operations as jobs** apply as in the console:
   archive/extract, backup generation and restores, AutoSSL issuance, database checks and dumps
   return `202 { job }` and the page follows the job's progress log.
7. **Missing daemon.** When the subsystem a screen needs is not installed (Dovecot, Exim,
   `crontab`, `pure-pw`/`ftpasswd`, `setpriv`/`runuser`, `zip`/`tar`, BIND, MySQL, Apache/NGINX,
   OpenSSL, an ACME client), the API answers `501` and the page shows **"Not available on this
   server — ask your hosting provider to enable it"** with a *Re-check* button; the rest of the
   panel keeps working. On a development host a mutation may instead succeed with `applied:false`
   (for example `reason: capability_missing`), which the page shows as a **Pending** pill: the
   panel's record was saved and the host change will be made once the daemon exists. A console
   category that is not loaded at all answers `503 service_unavailable`.
8. **Not included in your plan.** A function whose feature the package disables answers
   `403 feature_disabled`; the page shows *Not included in your plan* with a link back to the
   dashboard.

What a panel login **can never do**, by construction: reach any console route (every one of them
needs root or reseller), see another account, edit NS/SOA records, zone TTLs, raw zone text,
DNSSEC or templates, force a certificate re-issue, pick a PHP version the plan does not offer,
name a database outside its prefix, add a remote host for another account, change its own quota,
bandwidth limit, shell or package, download a certificate's private key, or run anything as root.

## C.8 Reading the function blocks

Each function below is documented as: **Purpose** · **Who** (the plan feature that must not be
disabled, "any plan" otherwise, and whether an administrator viewing the account may use it) ·
**Screen** (the fields and actions; limits in brackets) · **Server** (the route and what it does
on the host) · **Needs** (daemon or capability) · **Gotchas**. Routes are relative to
`/api/panel`. Paths you type are always **relative to your home directory**, without a leading
`/` or `-` and without `..` segments (512 characters at most); the server resolves and pins them
under the home before anything runs.

---

## 1. Overview

#### 1.1 Dashboard

- **Purpose:** usage at a glance, your domains and quick links. The `/panel` home page.
- **Who:** any plan; also while acting.
- **Screen:** greeting; **usage meters** (disk, bandwidth this month, addon domains, subdomains and
  the other object counts against their limits, coloured by percentage); the **Domains** table
  (main, addon, sub and parked domains with their document roots; *Manage* when the plan allows
  addon domains); **Quick links**: the application shortcuts an administrator published for the
  cPanel audience in *Development › Application Manager*, the active news items of *Panel ›
  Modify Panel News* and the webmail link when one is configured; the favourite functions tiles.
- **Server:** `GET /me`, `GET /usage`, `GET /overview/quick-links`.
- **Gotchas:** the usage card ignores a `501` from `/usage` (quota tools missing) and falls back
  to the figures of the account record; *Details* opens [14. Usage](#14-usage).

#### 1.2 Account details

- **Purpose:** your account, plan limits and included features.
- **Who:** any plan; also while acting.
- **Screen:** username, main domain, IP, package name, contact e-mail, home directory, shell,
  creation date, server hostname; the plan's limits (effective limits as *Account Information ›
  Manage Account Enhancements* computes them) and the feature list with what is on and off.
- **Server:** `GET /me` only.

## 2. Domains

Routes under `/domains` (`services/panel-domains.js`). A domain is "yours" when it is the
account's main domain or a row of `account_domains` for this account; every operation re-checks
that before delegating.

#### 2.1 Domains

- **Purpose:** every domain on this account and where it is served from.
- **Who:** any plan; also while acting.
- **Screen:** table of main, addon, sub and parked domains with type, document root, PHP version
  and creation date; the counts and the plan limits `max_addons`, `max_subdomains`, `max_parked`.
- **Server:** `GET /domains?type=main|addon|sub|parked`. The main-domain row is synthesised from
  the account record when no row exists for it.

#### 2.2 Addon domains

- **Purpose:** host additional websites on this account.
- **Who:** feature `addondomains`; limit `max_addons`; also while acting.
- **Screen:** *Domain*; *Document root* (relative to `public_html`, default a folder named after
  the domain); *Create DNS zone* (default on). Per row: *Remove* with *Remove the DNS zone*
  (default on) and *Remove the document root* (default off).
- **Server:** `POST /domains/addon` → `409 exists` if the domain is hosted anywhere on this server
  (another account's main domain, addon, subdomain or zone); otherwise the zone is created with the
  account's IP and the owner's nameservers (*DNS Functions*), the document root is created as the
  account (`0750`), the row is stored, mail routing is set to *local* and the account's vhosts are
  regenerated. `DELETE /domains/addon/:domain?removeZone&removeDocroot` uninstalls the certificate
  if one is installed, removes the vhost, deletes the zone and any redirect, drops the row and the
  mail domain, and optionally removes the document root **as the account** (the home and
  `public_html` themselves are never removed: `reason: protected`).
- **Needs:** the web server category for the vhost, BIND for the zone, Exim for routing — each
  missing piece becomes a **warning** in the answer (`meta.warnings`: "The DNS category is not
  loaded", "Mail routing … was saved but not applied", "Web server: php_missing"), never a failed
  addon.
- **Gotchas:** the document root must stay under `public_html` (`422`); a symlink planted there
  cannot be followed because the directory is created as the account.

#### 2.3 Subdomains

- **Purpose:** sections of your sites under their own hostname.
- **Who:** feature `subdomains`; limit `max_subdomains`; also while acting.
- **Screen:** *Label* (letters, digits and `-`, 63 characters), *Parent* (the main domain or one of
  your addon domains), *Document root* (default `public_html/<label>`). *Remove* with *Remove the
  document root*.
- **Server:** `POST /domains/sub` creates the directory as the account, stores the row, adds an
  `A` record (and `AAAA` when the account has an IPv6 address) for the full name to the parent's
  zone **when this account owns that zone**, and regenerates the vhosts. `DELETE /domains/sub/:fqdn`
  removes the vhost, clears those records and the row.
- **Gotchas:** when the parent's zone is not on this account the answer carries the warning *No
  DNS zone of this account contains <name>; add the records yourself*.

#### 2.4 Parked domains

- **Purpose:** aliases that show the same site as another domain.
- **Who:** feature `parkeddomains`; limit `max_parked` (counted by the panel, even for root-owned
  accounts); also while acting.
- **Screen:** *Domain*, *Create DNS zone*. *Remove* with *Remove the DNS zone*.
- **Server:** `POST /domains/parked` → *DNS Functions › Park a Domain* as the owner (zone plus
  `ServerAlias` on the main vhost); `DELETE /domains/parked/:domain?removeZone` → unpark.

#### 2.5 Redirects

- **Purpose:** send visitors from one address to another.
- **Who:** feature `redirects`; also while acting.
- **Screen:** per domain: *Target URL* (up to 2048 characters), *Type* permanent (301) or
  temporary (302), *Also match www.*, *Keep the path*. *Remove*.
- **Server:** `GET/PUT/DELETE /domains/:domain/redirect` → the domain forwarding of *DNS
  Functions* (`ctx.dns.setForwarding`), applied to the vhost by that category.

## 3. DNS

#### 3.1 Zone editor

- **Purpose:** A, AAAA, CNAME, MX, TXT, SRV and CAA records for your domains.
- **Who:** any plan (the zone editor is gated by ownership only, there is no `zoneedit` feature in
  this version); also while acting.
- **Screen:** the list of zones this account owns (domain, serial, default TTL, type, DNSSEC flag,
  record count); per zone the records with *Name* (default `@`, up to 253 characters), *Type*,
  *TTL* (blank for the zone default, a number of seconds or `300s`/`5m`/`1h`/`1d`/`1w`),
  *Priority* (0–65535, MX and SRV), *Value* (up to 4096 characters); *Add*, inline edit, *Delete*;
  an **E-mail records** summary (SPF, DKIM, DMARC) per zone.
- **Server:** `GET /dns/zones`, `GET /dns/zones/:domain` (NS and SOA records are stripped from the
  answer), `POST /dns/zones/:domain/records`, `PUT …/records/:id`, `DELETE …/records/:id`,
  `GET /dns/zones/:domain/email`. All through *DNS Functions* as the owner, which writes the zone
  file, validates it and reloads BIND.
- **Needs:** BIND (`named`); without it `501`. Without the DNS category loaded `503`.
- **Gotchas:** NS and SOA records answer `422 protected_record` ("managed by the server
  administrator"); changing the zone TTL or SOA, editing raw zone text, DNSSEC and zone templates
  are console functions and are not available here.

## 4. SSL

Routes under `/ssl` (`services/panel-ssl.js`), all behind the plan feature `sslmanager`. Every
certificate id is checked against `ssl_certs.account_id` before *SSL/TLS* is asked to do anything.

#### 4.1 SSL status

- **Purpose:** certificates installed on each domain.
- **Who:** feature `sslmanager`; also while acting.
- **Screen:** every domain of the account (main, addon, sub, parked) with the installed certificate
  (subject, issuer, valid from/until, days remaining, expired, AutoSSL or self-signed), the last
  AutoSSL attempt for the domain when the server records one, the AutoSSL provider state and
  whether the web server is linked. *Uninstall* per domain.
- **Server:** `GET /ssl/domains`, `GET /ssl/domains/:domain`, `DELETE /ssl/domains/:domain`.

#### 4.2 Install certificate

- **Purpose:** issue a free certificate or install your own.
- **Who:** feature `sslmanager`; issuing also needs `autossl`; also while acting.
- **Screen:** **Issue now** per domain (AutoSSL); **Install your own**: pick a stored certificate
  of this account, or paste *Certificate* (PEM, ≤ 64 KiB), *Private key* (unencrypted PEM) and
  *Chain* (one or more PEM certificates, ≤ 256 KiB).
- **Server:** `POST /ssl/domains/:domain/issue` → `202` job (*SSL/TLS › AutoSSL* "issue now",
  never forced); `POST /ssl/domains/:domain/install { certId | certPem, keyPem, chainPem }` →
  *Install an SSL Certificate on a Domain* as the owner, never forced.
- **Needs:** OpenSSL; an ACME client (`certbot` or `acme.sh`) and the AutoSSL provider enabled in
  *SSL/TLS › Manage AutoSSL* — otherwise *Issue now* answers `501` ("AutoSSL is not enabled on
  this server; ask your provider to turn it on").
- **Gotchas:** a certificate id that belongs to another account of the same owner is refused
  before the console service sees it.

#### 4.3 Certificates

- **Purpose:** certificates, keys and signing requests stored for this account.
- **Who:** feature `sslmanager`; also while acting.
- **Screen:** the account's storage (filter by kind `cert|key|csr`, installed yes/no) and a storage
  summary; **Generate a CSR** / **Generate a self-signed certificate** (*Domain* or
  `*.wildcard`, up to 100 SANs, key RSA 2048/3072/4096 or EC `prime256v1`/`secp384r1`, subject
  O/OU/L/ST/C/e-mail; self-signed *Days* 1–3650, default 365); **Upload** (certificate, key, chain
  or CSR in PEM); per item *Download* (`cert`, `csr`, `chain` or `fullchain`) and *Delete*.
- **Server:** `GET /ssl/certs`, `GET /ssl/certs/storage`, `POST /ssl/certs/csr`,
  `POST /ssl/certs/self-signed`, `POST /ssl/certs/upload`, `GET /ssl/certs/:id/download?part=`,
  `DELETE /ssl/certs/:id` — *SSL/TLS › SSL Storage Manager* with the account forced to yours.
- **Gotchas:** the **private key is never downloadable** (`part=key` is not accepted).

## 5. Files

Routes under `/files` (`services/panel-files.js`); the whole group needs the plan feature
`filemanager`. Every operation is an agent op of the `files.*` family executed **as the account**
(capability `panel-files`: `setpriv` or `runuser`).

#### 5.1 File manager

- **Purpose:** browse, upload, edit and organise the files of your sites.
- **Who:** feature `filemanager`; also while acting.
- **Screen:** a directory listing (name, type, size, modified, mode, owner; up to 10,000 entries
  per directory, 2,000 by default, with a *truncated* notice), **New folder** (mode, default
  `0755`), **Upload** (any size up to 20 GiB, sent in chunks of `panel.upload_chunk_bytes` —
  1,310,720 bytes — with *Overwrite*), **Download**, **Edit** (text files up to 4 MiB in the
  editor; a file containing a NUL byte is refused as *binary*), **Rename/Move** (with
  *Overwrite*), **Copy**, **Permissions** (octal mode, *Recursive*), **Delete** (1–200 paths),
  **Compress** (1–500 paths into a `.zip` or `.tar.gz`) and **Extract** (into a folder) — the last
  two as jobs with a progress log.
- **Server:** `GET /files/list|stat|read|download`, `PUT /files/write`, `POST /files/mkdir|rename|
  copy|chmod`, `DELETE /files`, `POST /files/uploads` → `PUT /files/uploads/:id/chunks` →
  `POST /files/uploads/:id/finish|abort`, `POST /files/archive|extract` (`202`). Writes go through a
  private temporary file and an atomic rename; downloads are streamed in 8 MiB ranges.
- **Needs:** `setpriv`/`runuser` (capability `panel-files`); `zip`, `unzip`, `tar`, `gzip` for
  compress/extract (capability `archive`). A home directory must exist (`409 no_home` otherwise).
- **Gotchas:** at most 20 uploads in progress per account; an upload that is idle for 6 hours is
  discarded; an upload onto an existing file is refused unless *Overwrite* is set (`409 exists`);
  the home directory itself can never be deleted; symlinks are never followed; disk quota is
  enforced by the kernel, so a full quota surfaces as a failed write.

#### 5.2 Disk usage

- **Purpose:** which folders use the most space.
- **Who:** feature `filemanager` (the group's router gates it); also while acting.
- **Screen:** a `du` of the chosen folder, one or two levels deep, with sizes per entry.
- **Server:** `GET /files/du?path=&depth=0..2` runs `du` as the account; the result is cached for
  five minutes per path (`cached: true` in the answer). An upload or write clears the cache.

## 6. Email

Routes under `/email` (`services/panel-email.js`); agent ops `vmail.*` (capabilities `dovecot`
and `exim`). Mailboxes are **virtual users**: a Dovecot passwd-file per domain under
`/etc/dovecot/whm/passwd/`, maildirs under `~/mail/<domain>/<local>/` owned by the account, and
Exim alias, forwarding, autoresponder and spam lists under the Exim configuration directory. The
first mailbox mutation on a server also applies the Dovecot/Exim virtual-mail wiring through
*Service Configuration* (the `whm_virtual_user` router and the `dovecot_plain` authenticator);
when Exim is installed but still ignores the panel's lists the answer carries the warning
`routing_not_applied` with a hint for the administrator.

#### 6.1 Email accounts

- **Purpose:** mailboxes on your domains.
- **Who:** feature `emailaccts`; limit `max_email`; also while acting.
- **Screen:** mailboxes per domain (address, quota, used space and messages — from Dovecot's quota
  when `doveadm` exists, else a `du` of the maildir — suspended flag); **Create** with *Name*
  (lowercase letters, digits, `.`, `_`, `-`; 64 characters), *Domain* (one of yours), *Password*
  (strength policy, `email` context), *Quota* in MB (default `panel.mail.default_quota_mb`, 1024;
  `0` or blank for unlimited); per mailbox *Change password*, *Change quota*, *Suspend/Unsuspend*
  (login disabled, mail still delivered), *Delete* with *Also delete the mail*, and **Client
  settings** (IMAP 993 / 143, POP3 995 / 110 as the Dovecot protocols allow, SMTP 465 or 587 with
  STARTTLS, the server hostname, the webmail URL).
- **Server:** `GET /email/accounts`, `POST /email/accounts` (the mail domain is claimed for this
  account — `409` when it belongs to another account —, the password is hashed as SHA512-CRYPT by
  `doveadm pw` or `openssl passwd -6` with the secret on stdin, the maildir is created as the
  account, the passwd-file line is written, the row stored, routing set to *local*),
  `PUT /email/accounts/:id/password|quota`, `PATCH /email/accounts/:id { suspended }`,
  `DELETE /email/accounts/:id?removeMail`, `GET /email/accounts/:id/client-settings`.
- **Needs:** Dovecot and Exim (`501` without them; `openssl` or `mkpasswd` to hash passwords).
- **Gotchas:** a mailbox imported without a password hash cannot have its quota or state changed
  until a password is set (`422 no_password`); the console's *Email* category sees the same
  `mail_accounts` rows.

#### 6.2 Forwarders

- **Purpose:** copy or redirect incoming mail to another address.
- **Who:** feature `forwarders`; also while acting.
- **Screen:** forwarders per domain; **Add** with *Address* (local part, or blank for the whole
  domain), *Domain*, *Destination* (an e-mail address, `:fail:` to bounce, `:blackhole:` to
  discard); *Delete*. **Domain forwarding**: forward every address of a domain to the same local
  parts at *another domain*.
- **Server:** `GET/POST /email/forwarders`, `DELETE /email/forwarders/:id` → the domain's Exim
  alias file is re-rendered; `GET/PUT/DELETE /email/domains/:domain/forward { targetDomain }` →
  the domain-forwarding list.
- **Gotchas:** a blank local part is stored as the domain's **default address** (6.3); a
  forwarder cannot point at itself; at most `panel.mail.max_forwarders_per_domain` (200) per
  domain; pipes, files, `:include:` and Exim expansions are not accepted as destinations.

#### 6.3 Default address

- **Purpose:** what happens to mail for addresses that do not exist.
- **Who:** feature `defaultaddress`; also while acting.
- **Screen:** per domain: *Bounce* (`:fail:`), *Discard* (`:blackhole:`) or *Forward to* an
  address.
- **Server:** `GET/PUT /email/domains/:domain/default { action, destination }` — the catch-all
  entry (`*`) of the domain's alias file.

#### 6.4 Autoresponders

- **Purpose:** automatic replies while you are away.
- **Who:** feature `autoresponders`; also while acting.
- **Screen:** *Address* (at one of your domains), *From name* (one line, 128), *Subject* (one
  line, 255), *Body* (up to 64 KiB), *Character set* (default `utf-8`), *Reply at most every N
  hours* (0–720, default 24), *Start*/*Stop* (optional dates), *Enabled*.
- **Server:** `GET/POST /email/autoresponders`, `GET/PUT/DELETE /email/autoresponders/:id` →
  Exim's autoreply transport (body file plus a header file per address; the "already replied"
  database lives under `/var/lib/whm/autoreply/`). Dovecot Sieve is not used.

#### 6.5 Spam filters

- **Purpose:** scoring thresholds, allow and block lists.
- **Who:** feature `spamassassin`; also while acting.
- **Screen:** *Enabled*, *Required score* (1–20, one decimal), *Auto-delete* above a score,
  *Allow list* and *Block list* (up to 200 addresses each).
- **Server:** `GET/PUT /email/spam` → `~/.spamassassin/user_prefs` written **as the account**
  (`0600`, key/value lines only) and the Exim per-domain spam list (threshold ×10, auto-delete).
- **Needs:** SpamAssassin and Exim with the panel's DATA ACL.
- **Gotchas:** per-recipient thresholds are not available in this version.

#### 6.6 Deliverability

- **Purpose:** SPF, DKIM and DMARC records for your domains.
- **Who:** any plan; also while acting.
- **Screen:** per domain the check result for SPF, DKIM and DMARC with **Fix** per item; the DKIM
  key state with **Generate/Install** (optionally *Rotate*) and **Remove**.
- **Server:** `GET /email/deliverability/:domain`, `POST /email/deliverability/:domain/fix { items }`
  (*Email › Email Deliverability*), `GET/POST/DELETE /email/dkim/:domain` (*DNS Functions* DKIM).
- **Needs:** the DNS zone of the domain on this account (`zone: false` otherwise), BIND, Exim's
  DKIM signing.

#### 6.7 Webmail

- **Purpose:** read your mail in the browser.
- **Who:** any plan; also while acting.
- **Screen:** a link to the webmail with the mailbox name prefilled (the chosen mailbox when it is
  yours, else your first mailbox), or a notice that none is installed.
- **Server:** `GET /email/webmail?user=` → the agent probes the usual Roundcube, RainLoop and
  SnappyMail locations (read-only, cached 60 s); the URL is `panel.webmail_url` when the operator
  set one, else `https://<hostname>/<alias>/` from the detected Apache alias.
- **Gotchas:** link and prefilled username only — single sign-on into the webmail is not
  available in this version.

#### 6.8 Mail usage

- **Purpose:** messages sent and delivered recently.
- **Who:** feature `emailaccts`; also while acting.
- **Screen:** totals, per domain and per mailbox for the last 1–168 hours (default 24), plus
  storage (mailboxes, quota allocated, `max_email`).
- **Server:** `GET /email/usage?sinceHours=` → *Email › Mail Delivery Reports* and *View Mail
  Statistics* filtered to exactly this account's domains and mailboxes.
- **Needs:** Exim logs readable by the panel (`501` otherwise).

## 7. Databases

Routes under `/databases` (`services/panel-databases.js`). The engine is the active profile of
*Database Services* (MySQL/MariaDB, or PostgreSQL); the plan feature is `mysql`, or `postgres`
when the profile is PostgreSQL. Names are **always prefixed `<username>_`** — the panel adds the
prefix when it is missing, regardless of the console's `db.prefixing` setting.

#### 7.1 Databases

- **Purpose:** databases on this account.
- **Who:** feature `mysql`/`postgres`; limit `max_sql` (or the package's `max_db`); also while
  acting.
- **Screen:** your databases with size and users; the quota (used/remaining) and the prefix;
  **Create** with *Name* (lowercase letters, digits, `_`; 54 characters, 64 including the
  prefix), *Character set* and *Collation* (MySQL only); per database **Check / Repair /
  Optimize** (job), **Export** (job: the dump is staged by root under
  `/var/lib/whm/panel/dumps/<username>/`, copied **as the account** into
  `~/backups/<database>-<timestamp>.sql`, and the staging file removed — download it with the
  file manager), **Delete**.
- **Server:** `GET /databases`, `POST /databases`, `DELETE /databases/:name`,
  `POST /databases/:name/check { action }` (`202`), `POST /databases/:name/dump` (`202`) — all
  through *Database Services* as the owner with the account pinned.
- **Needs:** the database server reachable with the panel's credentials (`meta.engineError`
  explains a connection failure; `501` when the client binaries are missing).

#### 7.2 Database users

- **Purpose:** users and the privileges they hold on each database.
- **Who:** feature `mysql`/`postgres`; also while acting.
- **Screen:** users with hosts (MySQL) and grants; **Create** with *Name* (22 characters, 32 with
  the prefix), *Password* (strength policy, `mysql` context), *Databases* to grant on; per user
  *Change password*, **Privileges** per database (the engine's privilege list), *Delete*.
- **Server:** `GET/POST /databases/users`, `PUT /databases/users/:name/password`,
  `DELETE /databases/users/:name`, `GET/PUT /databases/users/:name/grants`. Every database named in
  a grant must be yours.

#### 7.3 Remote hosts

- **Purpose:** hosts allowed to connect to your databases from outside.
- **Who:** feature `mysql`; also while acting.
- **Screen:** the server-wide hosts (read-only) and yours; **Add** *Host* (name, IP or `%`
  pattern); *Remove* on your own rows.
- **Server:** `GET/POST /databases/access-hosts`, `DELETE /databases/access-hosts/:id` → *Database
  Services › Additional MySQL Access Hosts* with the account pinned.
- **Gotchas:** PostgreSQL profiles have no remote hosts here (`422 unsupported`; the list says
  `supported: false`).

#### 7.4 phpMyAdmin

- **Purpose:** open the database administration tool.
- **Who:** feature `phpmyadmin`; also while acting.
- **Screen:** a link when phpMyAdmin is installed and enabled in the console
  (`db.phpmyadmin.enabled`), with your database user names to log in with.
- **Server:** `GET /databases/phpmyadmin`.
- **Gotchas:** link only, no single sign-on; nothing is offered on a PostgreSQL profile.

## 8. FTP

#### 8.1 FTP accounts

- **Purpose:** extra logins limited to a folder of your account.
- **Who:** feature `ftpaccts`; limit `max_ftp`; also while acting.
- **Screen:** the **main login** (the account username; its password is the account password,
  C.3) and the extra logins; connection details (host from the server hostname or your main
  domain, port `panel.ftp.port` (21), TLS as configured in *Service Configuration › FTP Server
  Configuration*); **Create** with *Name* (lowercase letters, digits, `.`, `_`, `-`; 32
  characters), *Password* (strength policy, `ftp` context), *Directory* (relative to home, default
  `public_html`), *Quota* in MB (pure-ftpd only); per login *Change password*, *Change quota*,
  *Delete*, **Client configuration** (settings and a FileZilla XML to import).
- **Server:** `GET /ftp/accounts`, `POST /ftp/accounts` → the directory is created as the account,
  then `ftp.user.add` (password on stdin; uid, gid and home are derived by the agent from
  `/etc/passwd`, never from the request), the row stored and the virtual-user database rebuilt;
  `PUT /ftp/accounts/:id/password|quota`, `DELETE /ftp/accounts/:id`,
  `GET /ftp/accounts/:id/client-config`.
- **Needs:** pure-ftpd (`pure-pw`) or ProFTPD (`ftpasswd`), capability `ftp-virtual`, with virtual
  users enabled in the daemon (PureDB / `AuthUserFile`) — the panel asks *Service Configuration* to
  enable them on the first login created when it can; otherwise `501`.
- **Gotchas:** the login name is `<name>@<main domain>` on pure-ftpd and `<name>_<username>` on
  ProFTPD; **vsftpd serves system users only**, so the page answers `501` and offers the main
  login alone; quotas are not supported on ProFTPD (`422 unsupported`).

## 9. Cron

#### 9.1 Cron jobs

- **Purpose:** commands that run on a schedule — the account's own crontab.
- **Who:** feature `cron`; also while acting. No login shell is needed.
- **Screen:** *Environment* lines (`KEY=value`; keys `[A-Z_][A-Z0-9_]`, values one line up to
  1024 characters; `SHELL` restricted to the shells the server allows) and *Jobs* (a 5-field
  schedule or `@reboot`, `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`,
  `@hourly`; a command of up to 2000 characters on one line); up to 500 lines in all; **Save**
  rewrites the whole crontab, **Remove crontab** deletes it.
- **Server:** `GET /cron` (`crontab -u <user> -l`, parsed), `PUT /cron` (validated with the
  panel's cron parser, rendered and fed to `crontab -u <user> -` on stdin), `DELETE /cron`
  (`crontab -u <user> -r`).
- **Needs:** `crontab` (capability `cron`).
- **Gotchas:** a user listed in `/etc/cron.deny` gets `422 refused`; a command that starts with a
  schedule-looking field is refused to catch a misplaced column; comments in a hand-written crontab
  are not preserved by a save from the panel (only env lines and jobs are rendered).

## 10. Backups

Routes under `/backups` (`services/panel-backup.js`); plan feature `backup`. The panel lists every
backup of the account (including the server's scheduled ones) but lets you **download and delete
only the archives generated or uploaded from the panel** (`retention_class = panel`).

#### 10.1 Backups

- **Purpose:** generate and download backups of your account.
- **Who:** feature `backup`; also while acting.
- **Screen:** the account's archives (kind *home*, *full* or *upload*, size, status, date,
  downloadable yes/no), the running job if any; **Generate** *Home* (home directory, mail and
  metadata) or *Full* (adds databases and DNS zones); per archive *Browse* (list contents by
  prefix), *Download*, *Delete*.
- **Server:** `GET /backups`, `POST /backups { kind }` → `202` job `panel.backup.generate`
  (*Backup* category's account archiver into the server's local backup directory, as the owner),
  `GET /backups/:id`, `GET /backups/:id/browse?prefix=`, `GET /backups/:id/download` (streamed in
  8 MiB ranges through a root-side read op, since archives are root-only files),
  `DELETE /backups/:id`.
- **Needs:** the *Backup* category and `tar`; `503` when the category is not loaded.
- **Gotchas:** one running backup per account (`409 busy`); a scheduled system backup is listed
  but answers `403 not_downloadable` / `403 not_deletable`.

#### 10.2 Restore

- **Purpose:** put files back from a backup or an uploaded archive.
- **Who:** feature `backup`; also while acting.
- **Screen:** pick an archive and the *Paths* to restore (1–500, relative to the home), *Overwrite
  existing files*; **Upload an archive** (`.tar.gz`, `.tgz` or `.tar`, up to 500 GiB, sent in
  chunks) to restore from; the list of past restores.
- **Server:** `POST /backups/:id/restore { paths, overwrite }` → `202` (*Backup* files restore,
  which extracts as the account); `POST /backups/uploads` → `PUT …/chunks` → `POST …/finish`:
  the archive is inspected and **must belong to this account** (`422 wrong_account`, file
  deleted otherwise), its checksum verified, then registered as a panel archive;
  `GET /backups/restores` (last 50).
- **Gotchas:** a whole-account restore (system user, databases, DNS, package) is a console
  function (*Backup › Backup Restoration*) and is never offered here.

## 11. Logs

#### 11.1 Access logs

- **Purpose:** web server access and error logs for your domains.
- **Who:** feature `rawlog`; also while acting.
- **Screen:** *Apache* or *NGINX* logs of your domains with size and date; **Tail** the last 1 KiB
  to 1 MiB (default 64 KiB, starting at a line boundary), **Download**; *Log retention*: *Archive
  logs monthly* and *Remove old archives* (the same switches as *Account Functions*).
- **Server:** `GET /logs?kind=apache|nginx`, `GET /logs/tail?file&bytes`, `GET /logs/download?file`,
  `GET/PUT /logs/retention`. The file name must come from the listing; the tail is read by a
  root-side range op that refuses files not owned by root or by this account.
- **Needs:** Apache or NGINX writing per-domain logs under the server's domlogs directory.

#### 11.2 Bandwidth

- **Purpose:** traffic per month against your plan.
- **Who:** feature `bandwidth`; also while acting.
- **Screen:** monthly totals for the last 1–24 months (default 12), the plan limit and the log
  sources counted.
- **Server:** `GET /logs/bandwidth?months=` → *Account Information › View Bandwidth Usage* for
  this account.
- **Needs:** the bandwidth collection schedule running (*Account Information*).

## 12. PHP

#### 12.1 PHP versions

- **Purpose:** the PHP version each domain runs.
- **Who:** feature `phpversion`; also while acting.
- **Screen:** the versions installed on the server — **restricted to the package's
  `php_versions` list when the package names one** — with the server default and advisories; per
  domain the current version and a selector (*inherit* to follow the default).
- **Server:** `GET /php/versions`, `GET /php/domains`, `PUT /php/domains/:domain { version | null }`
  → *Software › MultiPHP Manager* as the owner, one domain at a time (PHP-FPM pool and vhost
  rewritten inline).
- **Needs:** PHP-FPM and the *Software* category (`503` when not loaded).
- **Gotchas:** a version the plan does not offer answers `422` ("Pick one of the offered
  versions").

#### 12.2 PHP settings

- **Purpose:** per-domain `.user.ini` directives.
- **Who:** feature `phpversion`; also while acting.
- **Screen:** per domain the file path, whether it exists, the parsed directives and the basic
  ones; edit *key = value* pairs (keys `[A-Za-z_][A-Za-z0-9_.]`, values one line up to 1024
  characters; an empty value removes the directive).
- **Server:** `GET/PUT /php/domains/:domain/ini { directives }` → *Software › MultiPHP INI Editor*
  (`pkg.php.userini.*`), owner-enforced.

## 13. Security

Routes under `/security` and `/tokens`. Mutations here are **session-only** (an API token gets
`403 session_required`) and **refused while an administrator is viewing the account**
(`403 not_while_impersonating`).

#### 13.1 Password

- **Purpose:** change the password for this account.
- **Who:** feature `passwordchange`; never while acting.
- **Screen:** *Current password*, *New password* (strength meter), confirm.
- **Server:** `POST /security/password` — see [C.3](#c3-password-and-two-factor-rules): Linux
  password first, panel hash second, forced-change flags cleared, all sessions ended and this one
  re-created (the page receives a new CSRF token).
- **Gotchas:** the current password must match the panel's copy; an account whose password was
  never synced (set only on the Linux side before the panel existed) needs an administrator to set
  it once (C.9). On a development host without the Linux user the change is recorded with
  `host.applied: false`.

#### 13.2 Two-factor authentication

- **Purpose:** protect sign-in with a one-time code.
- **Who:** any plan; never while acting.
- **Screen:** state (*enabled*, *required by policy*, *enrolment pending*); **Enable** shows the
  secret and QR code and asks for a 6-digit code to confirm; **Disable** asks for the password or
  a current code.
- **Server:** `GET /security/two-factor`, `POST /security/two-factor/enroll|confirm|disable` —
  thin proxies to the console's enrolment (`/api/auth/2fa/*` logic) for this login.
- **Gotchas:** *Disable* answers `403` while the operator requires 2FA for account users.

#### 13.3 SSH keys

- **Purpose:** public keys allowed to open a shell on this account.
- **Who:** feature `ssh` (off in the default feature list, so the entry is hidden on most plans)
  **and** shell access on the package (`has_shell`; `501 shell_disabled` otherwise); never while
  acting.
- **Screen:** the keys in `~/.ssh/authorized_keys` (type, bits, SHA256 fingerprint, comment,
  options); **Add** an OpenSSH public-key line (`ssh-ed25519`, `ssh-rsa` or `ecdsa-sha2-nistp*`,
  optional comment); *Remove*.
- **Server:** `GET/POST /security/ssh-keys`, `DELETE /security/ssh-keys/:fingerprint` → the file
  is read and rewritten **as the account** (`.ssh` `0700`, file `0600`); lines that are not keys
  (comments, unknown formats) are preserved verbatim.
- **Gotchas:** at most 50 keys; a duplicate answers `409`; `409 no_home` when the account has no
  home directory yet.

#### 13.4 Sessions

- **Purpose:** where this account is signed in.
- **Who:** any plan; never while acting (listing included).
- **Screen:** the login's active sessions (short id, expiry); **Sign out everywhere** ends them
  all and re-creates the current one.
- **Server:** `GET /security/sessions`, `DELETE /security/sessions`.

#### 13.5 API tokens

- **Purpose:** tokens for scripts that use the panel API.
- **Who:** feature `api`; never while acting; 2FA when the console's *API tokens require 2FA*
  policy is on.
- **Screen:** tokens (name, scopes, prefix, expiry, last use); **Create** with *Name* (letters,
  digits, spaces and `. _ - ( ) /`, 64 characters), *Scopes*, optional *Expires at* (in the
  future) — the token value is shown **once**; *Revoke*.
- **Server:** `GET/POST /tokens`, `GET/DELETE /tokens/:id`; stored as a SHA-256 hash with its first
  8 characters as the prefix; up to `development.tokens.max_per_user` (50) per login.
- **Scopes:** a token is sent as `Authorization: Bearer <token>`. `panel:read` (the default when
  none is chosen) allows every GET; a mutation needs the group's scope:

| Scope | Mutations it allows |
|---|---|
| `panel:files` | File manager and FTP accounts |
| `panel:email` | every Email function |
| `panel:dns` | Zone editor |
| `panel:databases` | Databases, users, remote hosts |
| `panel:backups` | Backups and Restore |
| `panel:cron` | Cron jobs |

- **Gotchas:** domains, SSL, PHP, log retention and usage refresh cannot be changed with a token
  (their routers have no grantable scope); security settings and tokens themselves are
  session-only. A token of a panel login reaches only `/api/panel/*` (every console route needs
  root or reseller) and `/api/auth/me`.

## 14. Usage

#### 14.1 Usage

- **Purpose:** disk, bandwidth and object counts against your plan.
- **Who:** any plan; also while acting.
- **Screen:** **Disk** (used, quota, percentage, inodes when the server has quota tools — source
  `repquota` — else the last scan; a top-level breakdown of the home from a cached shallow `du`;
  the time of the last server-wide disk refresh), **Bandwidth** (this month against the limit and
  the monthly history), **Objects** (domains, subdomains, addon and parked domains, mailboxes,
  forwarders, databases, FTP accounts against their limits), the effective limits of the plan;
  **Refresh** asks the server to re-measure disk usage.
- **Server:** `GET /usage`; `POST /usage/refresh` → `202` (reuses *Account Information*'s
  server-wide disk-refresh job, a running one is reused).
- **Gotchas:** a refresh is accepted once per account every 10 minutes (`429 rate_limited`);
  `501` when the account-information category is not available.

---

## C.9 Administering the account panel

The administrative endpoints live under `/api/panel/admin/*` (`routes/categories/panel.js`) and
need a root or reseller session; they are never behind the account scope.

### C.9.1 Panel settings (root)

The settings are edited under **Panel › Customization › Account panel** (root only; resellers see
the Customization page without the tab, as the API is root-only). The tab holds the *Account
panel* card (the four fields below, saved with a single PUT of the changed fields) and the *Log in
as history* table ([C.9.4](#c94-login-as-history)). The API is `GET/PUT /api/panel/admin/settings`:

| Field (setting key) | Meaning |
|---|---|
| `enabled` (`panel.enabled`, default `true`) | Off: every `/api/panel/*` request except this one answers `403 panel_disabled` and `/panel` shows *The account panel is switched off*. Account logins are still created and kept in sync, so turning it on later needs no backfill. |
| `require2faForUsers` (`panel.require_2fa_for_users`, default `false`) | Force account users to enrol an authenticator before using the panel ([C.3](#c3-password-and-two-factor-rules)); also blocks them from disabling it. |
| `loginAsTtlMinutes` (`panel.login_as_ttl_minutes`, default 60, 5–480) | How long a "Log in as" context lasts. |
| `webmailUrl` (`panel.webmail_url`, default empty) | An `http(s)` URL shown as the webmail link and in client settings; empty means auto-detect. |

The answer also reports the read-only `loginAsAcl` (`panel.login_as_acl`, default `login-as`) and
`uploadChunkBytes` (`panel.upload_chunk_bytes`, 1,310,720). Other panel keys in the settings table
with no form: `panel.mail.default_quota_mb` (1024), `panel.mail.max_forwarders_per_domain` (200),
`panel.ftp.port` (21). **These three have no form**: change them with the API from a root session.
Every change, from the page or the API, is audited as `panel.settings.update`.

### C.9.2 "Log in as" from List Accounts

*Account Information › List Accounts* › row menu › **Log in as** calls
`POST /api/panel/admin/login-as/:username` and opens `/panel` in a new tab
(`client/src/pages/accounts/AccountsTable.jsx`). Requirements and behaviour are those of
[C.5](#c5-log-in-as-when-an-administrator-views-your-account): ownership of the account, the
`login-as` privilege for resellers, an unsuspended account, a browser session. Starting a second
"Log in as" replaces the first. **Exit** in the panel banner, or
`POST /api/panel/admin/logout-as`, ends it (the context lives in the console session, so signing
out drops it too; the history row then closes at its expiry). The "Log in as"
action on the *Account Information* pages mentioned by the design is not available in this
version — use *List Accounts*.

### C.9.3 The reseller privilege `login-as`

*Resellers › Edit Reseller Nameservers and Privileges* › *Account privileges* › **Log in to Account
Panels** (`login-as`). It is an **explicit** privilege: unlike the rest of the catalogue it is
never implied by ownership for a reseller whose privileges were never edited, and it is off until
root grants it. Root always may. The key the panel checks is `panel.login_as_acl`.

### C.9.4 Login-as history

`GET /api/panel/admin/login-as/history?page&pageSize&sort&dir` lists `panel_login_as`: actor,
account, started, expires, ended, IP and an `active` flag. Root sees every row, a reseller only its
own. The same list is shown as the *Log in as history* table under *Panel › Customization ›
Account panel* (when, admin, account, from, ended, status: active / ended / expired), paged by this
endpoint. The audit log (*Audit log* in the console top bar) carries the matching rows `panel.login_as`, `panel.logout_as` and `panel.login_as.ended`
(with `reason`), and every panel action performed while acting carries `actingAs` and `by`.

### C.9.5 Linking logins and syncing passwords

| Endpoint | Purpose |
|---|---|
| `GET /api/panel/admin/accounts/:username/user` | link status: `linked`, `passwordSet`, `passwordSyncedAt`, `totpEnabled`, `suspended`, `lastLoginAt`, `lastLoginIp`, `warnings` (`password_not_synced`). |
| `POST /api/panel/admin/accounts/:username/user { password? }` | create or adopt the login (idempotent) and, with a password, set it in both stores. |
| `POST /api/panel/admin/accounts/:username/password { password }` | set the Linux password and the panel hash together (audited `panel.password.admin_set`). |

In normal use none of these is needed: *Create a New Account* with a password and *Account
Functions › Password Modification* already write the panel hash after the Linux password
(`services/accounts.js` `syncPanelPassword`). They are for accounts that predate the panel, for
imported or transferred accounts whose password the panel never saw, and for a login that reports
`password_not_synced`. Resellers may use them on their own accounts.

---

## C.10 Troubleshooting

### C.10.1 Error codes you will meet in the account panel

Every API error is `{ error: { code, message, fields? } }`; pages show the message and the
per-field hints. Console-wide codes (`validation_failed`, `agent_unavailable`, `path_not_allowed`,
`license_degraded`, …) are in Part B, Appendix E.

| Code (HTTP) | Meaning | What to do |
|---|---|---|
| `no_account` (403) | the login is a role-`user` row without an `account_users` link. | Link it: `POST /api/panel/admin/accounts/:username/user` (C.9.5), or terminate the orphan login. |
| `panel_scope_required` (403) | an administrator opened `/panel` or `/api/panel/*` without "Log in as". | Use *List Accounts › Log in as*. |
| `panel_disabled` (403) | `panel.enabled` is off. | Turn it on with `PUT /api/panel/admin/settings`. |
| `login_as_ended` (403) | the acting context ended: `expired`, `account_suspended`, `account_removed`, `ownership`, `acl`, `replaced`, `logout`. | Start "Log in as" again from the console (after fixing the reason: unsuspend, grant `login-as`, …). |
| `not_while_impersonating` (403) | password, 2FA, SSH keys, sessions or tokens while viewing the account. | Only the account user can do this; use C.9.5 to set a password. |
| `session_required` (403) | a security mutation from an API token. | Do it from a browser session. |
| `account_suspended` (423 in the panel; 409 on "Log in as") | the account is suspended. | Unsuspend it in the console. |
| `demo_mode` (403) | the account is in demo mode. | *Account Functions › Manage Demo Mode*. |
| `password_change_required` (403) | a forced password change is pending. | Change the password on *Security › Password*. |
| `two_factor_required` (403) | the panel policy requires 2FA (or the token policy does) and the login has none. | Enrol on *Security › Two-factor authentication*. |
| `feature_disabled` (403) | the package sets the named feature to `false`. | Change the package's feature list in *Packages › Feature Manager*, or upgrade the account. |
| `limit_reached` (409) | a plan `max_*` is used up (`max_addons`, `max_subdomains`, `max_parked`, `max_email`, `max_ftp`, `max_sql`, forwarders per domain). | Remove something or raise the limit in the package. |
| `exists` (409) | the domain is hosted elsewhere on the server, the mailbox/forwarder/FTP login/file already exists. | Pick another name, or *Overwrite* for files. |
| `capability_missing` / `binary_not_found` (501) | the daemon or tool behind the screen is missing: `panel-files` (`setpriv`/`runuser`), `archive` (`zip`/`tar`), `cron` (`crontab`), `dovecot`, `exim`, `ftp-virtual` (`pure-pw`/`ftpasswd`), BIND, OpenSSL, an ACME client, the database client, quota tools. | Install it on the host (*Software › Install Distro Packages*), then *Re-check* on the page. |
| `shell_disabled` (501) | SSH keys on a package without shell access. | Grant shell access in the package or with *Account Functions › Manage Shell Access*. |
| `service_unavailable` (503) | a console category the function delegates to is not loaded (DNS, SSL, Software, Backup, Account Functions, Account Information, Email). | Check the panel journal for the category's registration error. |
| `no_home` (409) | the account has no home directory on this server yet. | Create the Linux user (the account was created without one, or the home was moved). |
| `protected_record` (422) | an NS or SOA record in the zone editor. | Edit it in *DNS Functions › Edit DNS Zone*. |
| `binary` (422) | the file editor was asked to open a file with NUL bytes. | Download it instead. |
| `wrong_account` (422) | an uploaded backup archive belongs to another account. | Upload an archive generated for this account. |
| `busy` (409) | a backup of the account is already running. | Wait for the job. |
| `not_downloadable` / `not_deletable` (403) | a scheduled system backup, not a panel one. | Ask the administrator (*Backup › Backup Restoration*). |
| `unsupported` (422) | FTP quota on ProFTPD, remote hosts on PostgreSQL. | — |
| `refused` (422) | `crontab` refused the user (`/etc/cron.deny`) or Exim/Dovecot rejected the rendered file. | Fix the deny list; check `exim -bV` / `doveconf -n` on the host. |
| `rate_limited` (429) | usage refresh within 10 minutes of the last one. | Wait. |
| `routing_not_applied` (warning in `meta.warnings`) | Exim is installed but does not read the panel's lists yet; the mailbox or domain was saved. | *Service Configuration › Exim Configuration Manager* — install the managed includes (the warning carries a `hint`). |
| `password_not_synced` (warning, admin status) | the panel never saw the account password. | Set it once with `POST /api/panel/admin/accounts/:username/password` or *Password Modification*. |

### C.10.2 Symptoms

- **"Invalid credentials" for an account that exists.** The login has no password yet
  (`passwordSet: false` in C.9.5), the account is suspended, or the account's username is also an
  administrator's (`username_is_admin`: no panel user is created). Set the password through
  *Password Modification* or C.9.5.
- **A function is missing from the sidebar.** The package sets its feature to `false`
  (`visibleCategories` hides it); SSH keys are hidden by default (`ssh: false` in the default
  feature list), as is anything on the *disabled* feature list.
- **Every write shows a "Pending" pill.** The host lacks the daemon on a development server and the
  mutation came back `applied: false`; the panel record exists and the host change is made once the
  daemon is present (the password change does not tolerate this under `NODE_ENV=production`).
- **Mailboxes exist but cannot log in over IMAP/SMTP.** Exim or Dovecot still ignore the panel's
  virtual-user files: the first mailbox mutation applies the wiring through *Service
  Configuration*; the Security Advisor and the `routing_not_applied` warning say which part is
  missing (`routerHooked`, `authHooked` from `vmail.render.check`).
- **"Log in as" opens the panel and immediately shows "The session has ended".** The TTL elapsed
  before the tab loaded (raise `loginAsTtlMinutes`), the reseller lost `login-as`, or the account
  was suspended between the click and the first request.
- **Where the audit trail is.** Every panel mutation writes an `audit_log` row with
  `target = <account username>` and an action prefixed `panel.` (`panel.files.upload`,
  `panel.email.account.create`, `panel.cron.set`, `panel.password.change`, `panel.login_as`, …),
  visible in the console's *Audit log*; while acting, `principal` is the administrator and the
  arguments carry `actingAs` and `by`.
