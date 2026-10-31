# WHM User Manual

This manual describes the WHM control panel as it is built in this repository: what every
screen offers, who may use it, what happens on the server when you click, what has to be
installed for it to work, and the traps worth knowing. It is derived from the code
(`client/src/nav.js`, the pages under `client/src/pages/`, the routes and services under
`server/src/`), not from cPanel's documentation; where this panel differs from the
original WHM, this manual follows the panel.

Companion documents: [`README.md`](../README.md) (install, hub, configuration reference),
[`BLUEPRINT.md`](../BLUEPRINT.md) (architecture and the full function specification, §13),
[`plugins/SDK.md`](../plugins/SDK.md) (writing plugins), and the design notes under
[`docs/design/`](design/).

## Table of contents

- [Part A — Getting around](#part-a--getting-around)
  - [Signing in](#signing-in)
  - [The layout](#the-layout)
  - [Roles: root, reseller, user](#roles-root-reseller-user)
  - [How a change reaches the server](#how-a-change-reaches-the-server)
  - [Reading the function blocks](#reading-the-function-blocks)
- [Part A — Categories 1–15](#part-a--categories-115)
  - [1. Server Configuration](#1-server-configuration)
  - [2. Support](#2-support)
  - [3. Networking Setup](#3-networking-setup)
  - [4. Security Center](#4-security-center)
  - [5. Server Contacts](#5-server-contacts)
  - [6. Resellers](#6-resellers)
  - [7. Service Configuration](#7-service-configuration)
  - [8. Locales](#8-locales)
  - [9. Backup](#9-backup)
  - [10. Clusters](#10-clusters)
  - [11. System Reboot](#11-system-reboot)
  - [12. Server Status](#12-server-status)
  - [13. Account Information](#13-account-information)
  - [14. Account Functions](#14-account-functions)
  - [15. Multi Account Functions](#15-multi-account-functions)
- Part B — Categories 16–31 and appendices (Transfers, Themes, Packages, DNS Functions,
  Database Services, IP Functions, Software, Email, System Health, HST Panel, SSL/TLS, Market,
  Restart Services, Development, Plugins, Application Manager; licensing, marketplace, developer, hub-portal and
  troubleshooting appendices): [MANUAL-partB.md](MANUAL-partB.md).

---

# Part A — Getting around

## Signing in

The panel listens on **https://server:2087** and on **http://server:2086**. HTTPS is the
default: the installer generates a self-signed certificate (`/etc/whm/tls/cert.pem` + `key.pem`,
replaced by the hostname's Let's Encrypt certificate once *Networking Setup › Change Hostname* has
run), and port 2086 only answers with a redirect to 2087 (setting `panel.force_https`;
`WHM_FORCE_HTTPS=false` in `/etc/whm/panel.env` serves plain HTTP again). Open the address in a
browser; the login card shows the vendor branding set under *HST Panel › Customization* and, if one
is configured, a login notice.

**Naming.** The product is **HST Panel** by Hostingsignal: the hosted-account side carries that
name, the administrative side keeps the **WHM** name, and the sidebar category that cPanel calls
"cPanel" is *HST Panel* here (`client/src/brand.js` holds the names). Routes, setting keys, slugs and
file names keep the original `cpanel` identifiers, so bookmarks, API calls and stored settings did
not change with the labels.

### Username and password

The first administrator is `root`. Its password comes from `WHM_ADMIN_PASSWORD` at first boot
or is generated into `$WHM_DATA_DIR/initial-admin-password.txt`
(`/var/lib/whm/initial-admin-password.txt` in production; delete the file after the first
login). Resellers log in with the username they were given in *Resellers › Reseller Center*.

What the login path enforces (`server/src/services/auth.js`, `routes/auth.js`):

| Check | Behaviour |
|---|---|
| Brute-force block | With cPHulk enabled, an address with an active block gets `429 locked_out`; failures are counted per address and per window configured in *Security Center › cPHulk Brute Force Protection*. |
| Rate limit | 20 attempts per 15 minutes per address and user (`config.loginRateLimit`). |
| Session | Cookie session, `httpOnly`, `sameSite=lax` (not `strict`: the external-authentication callback `GET /api/auth/external/:name/callback` is a cross-site top-level navigation that must carry the session holding the OIDC state and nonce — a `strict` cookie is dropped there by real browsers; every mutation stays protected by the CSRF token), `secure` for TLS sessions (`auto`; `config.cookieSecure` forces it); 8 h lifetime by default (`sessionTtlMs`), shortened by the *idle session timeout* policy. |
| One session per user | When *One active session per user* is on, a new login destroys the user's other sessions. |
| Password age | When *Maximum password age* is set and the password is older, the login succeeds but the user is forced to change it before anything else. |

### Two-factor authentication (TOTP)

If the user has enrolled an authenticator, the login card switches to **Two-factor
authentication** after the password is accepted and asks for the 6-digit code
(`POST /api/auth/2fa/verify`). Enrolment is done on *Security Center › Two-Factor
Authentication* (also reachable from the user menu). When the security policy requires 2FA
for the user's role (`security.2fa.required_for_root`, `security.policy.require_2fa_for_resellers`)
and the user has not enrolled yet, the session is flagged `mustEnroll2fa`: the shell redirects every
page to the enrolment screen until a code has been confirmed.

### Forced password change

A user flagged `mustChangePassword` (first login of root, *Account Functions › Force Password
Change*, an expired password, or a reseller created with a generated password) is redirected to
**/change-password** and cannot open any other page until a new password is set. The page asks
for the new password twice and refuses anything whose strength score is below 65; the current
password is not asked for in the forced flow.

### Verified-IP login

With *Limit logins to verified IP addresses* on (*Security Center › Configure Security
Policies*), a successful login from an address the user has not used in the last 90 days is
still accepted but is logged as a warning and raises the `login.new_ip` event, which
*Server Contacts › Contact Manager* can deliver (and which is mailed to root when enabled under
*Edit System Mail Preferences*).

### External (OpenID Connect) login

When *Security Center › Manage External Authentications* has enabled providers and
`security.external_auth.enabled` is on, the login card shows a **Log in with …** button per
provider. It starts `GET /api/auth/external/<name>/start`; after the provider's callback the
panel looks up the identity link. Errors come back as query parameters on the login page:

| Error | Meaning |
|---|---|
| `external_not_linked` | The identity is not linked to a panel user. Log in with your password and link it under *Manage External Authentications* (the start URL with `?link=1`). |
| `external_state` | The sign-in state expired or did not match; try again. |
| `external_denied` / `external_failed` | The provider refused or the exchange failed. |

Providers can also auto-link by e-mail when `security.external_auth.auto_link_by_email` is on.
The token exchange follows the provider's discovery document: a provider whose
`token_endpoint_auth_methods_supported` lists only `client_secret_post` (Apple, Meta) receives the
client secret in the token request body instead of an HTTP Basic header; everything else uses
Basic. The redirect URI a provider must register is
`https://<hostname>:2087/api/auth/external/<identifier>/callback`.

## The layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ☰  WHM  [Search functions (Alt + /)]        hostname  📜 audit  🔔  user ▾│
├───────────────┬──────────────────────────────────────────────────────────┤
│ search        │ license / revocation banners                             │
│ expand/collap.│                                                          │
│ ⌂ Home        │ page header (title, description, actions)                │
│ ★ Favorites   │ cards …                                                  │
│ ▸ Server Conf.│                                                          │
│ ▸ Support     │                                                          │
│ … 30 categ.   │                                                          │
├───────────────┴──────────────────────────────────────────────────────────┤
│ footer: branding · Signed in as root (root)                               │
└──────────────────────────────────────────────────────────────────────────┘
```

**Top bar.** The menu button toggles the sidebar on small screens. The search box
(`Alt + /` focuses it) matches label, category and description of every function and of
every page an enabled plugin registers; the first eight hits appear in a list, arrow keys
move, Enter opens, Escape clears. The hostname is shown next to it. The scroll icon opens the
**Audit log**; the bell is a notification placeholder (it has no panel behind it yet). The
user menu holds *Change password*, *Two-factor authentication*, the Help / Documentation /
Support links set in branding, and *Log out*.

**Sidebar.** All 30 categories from `client/src/nav.js` in order, each with its function
count. The filter box narrows the tree to matching functions (categories with no match
disappear), *Expand all* / *Collapse all* set every category, and the bottom button collapses
the sidebar to icons. Open/closed state and the collapsed flag are remembered in the browser
(`localStorage`). Opening a page expands its category. Categories hidden by the active
*Server Profile* are left out of the sidebar, the Tools grid and search, but their URLs still
work.

**Home.** The dashboard shows the news banner (*HST Panel › Customization*), a marketplace
updates notice, a **Favorites** card, the **Tools** grid (every category with a filter box),
a **Statistics** card (user, hostname, main IP, load, uptime, OS, kernel, CPU, memory, disk `/`,
account and reseller counts, panel version and mode, license status; refreshed every 30 s)
and a **Service status** card with a coloured dot per monitored service.

**Favorites.** Click the star on any tool card to pin it; pinned tools appear in the
Favorites card on Home and in a *Favorites* group at the top of the sidebar. Favorites are
stored in the browser, not on the server, so they do not follow you to another machine.

**Audit log** (`/audit-log`, root only). Every privileged action with time, user, role, IP,
action, target, result and the redacted arguments; searchable and sortable, 50 rows per page.
Resellers who open it receive a 403 from the API.

**Task queue.** Long operations are background jobs; follow them in *Server Status › Task
Queue Monitor* or in the progress log the launching page shows (a live log streamed over
server-sent events). Queued jobs can be cancelled; running ones cannot.

**Banners.** A license in grace or degraded state puts a banner above every page
(*Basic WebHost Manager Setup › License* fixes it); a revoked marketplace plugin shows a
revocation banner.

## Roles: root, reseller, user

| Role | What it sees | What it may do |
|---|---|---|
| `root` | Every category and function (minus those hidden by the Server Profile). | Everything. All server-wide configuration, anything touching other owners' accounts, every destructive action. |
| `reseller` | The same sidebar. Account lists, usage, backups, locales and status pages are filtered to **accounts the reseller owns**; server-wide pages answer `403 forbidden` from the API, and the page shows that error. | Account operations on owned accounts, each gated by an **ACL** granted under *Resellers › Edit Reseller Nameservers and Privileges* (`create-acct`, `suspend-acct`, `kill-acct`, `passwd`, `quota`, `limit-bandwidth`, `add-pkg-shell`, `demo-setup`, `edit-account`, `upgrade-account`, `list-accts`, `news`, …). Missing ACL → 403. |
| `user` | Not implemented in this panel version: hosting-account owners have no panel login (`BLUEPRINT.md` §10 lists it as phase 2). | — |

Each function block below says **Root** or **Root, reseller** and names the ACL a reseller
needs where the service checks one. "Root, reseller (own accounts)" means the reseller sees
and acts on owned accounts only; ownership is re-checked inside the service, not just by the
route.

## How a change reaches the server

1. The page calls the JSON API (`/api/...`). Every request is validated with zod; a bad field
   comes back as `422` with per-field messages, which the form shows inline. Mutations carry
   the CSRF token and the role check of the route (`requireRoot`, `requireReseller`).
2. The route hands the request to a **service** (`server/src/services/<category>.js`), which
   holds the logic, re-checks ownership/ACLs, and writes an **audit log** row for every
   privileged or mutating action (secrets redacted).
3. Anything that touches the operating system goes through an **agent op**: a named,
   schema-validated request (`user.create`, `svc.restart`, `web.vhost.write`, …). In production
   (`WHM_MODE=split`) the non-root panel sends it over `/run/whm-agent.sock` to `whm-agentd`,
   a root daemon with a fixed catalog that only ever runs programs as `execFile(bin, argv[])`.
   In `WHM_MODE=monolithic` the same op modules run in-process. Unknown ops and arguments
   that fail the schema are refused.
4. **Host first, database second**: the op runs, then the panel's own SQLite record is
   committed (or compensated). Configuration writers validate first (`apachectl -t`,
   `sshd -t`, `exim -bV`, …) and roll back a rejected file.
5. **Long operations** (backups, restores, bulk changes, package installs, statistics,
   migrations) return `202 { job }` and run in the job queue; the page shows a live
   **progress log** and the job appears in *Task Queue Monitor*. Schedules
   (*Configure HST Panel Cron Jobs*) enqueue the same job types on a cron expression.
6. **Missing daemon.** When the subsystem a function needs is not installed (BIND, Exim,
   Dovecot, Apache, MySQL, quota tools, iptables/nftables, timedatectl, …) the service raises a
   capability error. The API answers `501` and the page replaces the form with a
   **"Service not installed"** notice that links to *Software › Install Distro Packages*; the
   rest of the panel keeps working. Several pages offer an *Install …* button that enqueues the
   package installation as a job.

Error codes you will see in toasts map as follows: `501` service/binary missing, `422`
invalid arguments or a refused configuration, `404` not found, `409` already exists,
`403` not allowed (role, ACL, path outside the agent's allowed roots, unknown op), `503`
agent unavailable or timed out, `423 license_degraded` when the license has lapsed and the
panel is read-only.

## Reading the function blocks

Each function below is documented as: purpose · **Who** · the fields and actions on the
screen · **Server** (what the route/service does) · **Needs** (daemon, setting) · **Gotchas**.
Labels and order are those of the sidebar. "Setting `x.y`" refers to a key in the panel's
settings table (editable where the page says, or raw under *Tweak Settings* for the keys it
lists).

---

# Part A — Categories 1–15

## 1. Server Configuration

Routes under `/api/server-config/*` and `/api/system/*`; everything here is **root only**.

**First login: the setup wizard.** On a fresh install the first root login (after the forced
password change and, when required, 2FA enrolment) opens the **HST Panel setup wizard** at `/setup`
instead of the dashboard, until the setting `setup.completed` is true. Steps: *Welcome* → *Server
basics* (hostname, contact e-mail, nameservers, main IP: the same settings as *Basic WebHost Manager
Setup*) → *Services* (profile cards **Full hosting stack**, **Web + database only**, or a manual
checklist of the stack catalog, from `GET /api/system/stack`) → *Install* (one job `stack.install`
with its progress log) → *Done* (`POST /api/system/setup/complete`). *Skip for now* completes the
wizard without installing anything; a server that already has hosting accounts is treated as set
up. The wizard works on a host without a package manager (the notice is shown and you can continue).
The same profiles are offered by the installer (`install.sh --stack full|web|none`,
`--components …`) and afterwards by *Service Manager › Server stack* (7.10).

#### 1.1 Basic WebHost Manager Setup

Contact details, main and shared IPs, nameservers and account defaults, plus the **License** tab.
**Who:** root.

Two tabs: **Settings** and **License** (`#license` in the URL opens it; the degraded-mode banner
links there).

| Settings tab (`PUT /api/system/settings`) | Meaning |
|---|---|
| Server contact email address (`basic.contact_email`) | Receives alerts, reports and license notices. |
| Hostname (`basic.hostname`) | Panel record only — does **not** change the system hostname (use *Networking Setup › Change Hostname*). |
| Main server IP address, Shared virtual host IP address | Primary IPv4; new accounts without a dedicated IP use the shared one. |
| Home directory root (`basic.home_root`) | New account homes are created under it. |
| Default package | Used when an account is created without a package. |
| Nameservers (`basic.nameservers`, list) | Written into every new DNS zone. |

The **License** tab (`/api/license/*`) shows status, edition, limits (hosting accounts,
resellers, servers, domains per account) and feature flags; lets you enter or replace the
license key (`WHM-XXXX-XXXX-XXXX-XXXX`, stored encrypted, never shown again), *Check in now*,
*Deactivate this server*, *Transfer here* from another activation when all seats are used,
*Start a free trial* (e-mail only; 14 days, 5 accounts, one per server fingerprint and
e-mail) and a list of recent license events.
Only the **super admin** sees this tab in full: the one root user flagged with
`sudo node /opt/whm/scripts/whm-cli.js superadmin <user>`, which asks for the super admin setup
password chosen at install time (its bcrypt hash lives in `/etc/whm/superadmin.key`, `0600
root:root`; `whm-cli superadmin --init` creates it, `--revoke <user>` clears the flag). Every other
root user gets a *Licensed — managed by the panel owner* card with status, edition and expiry,
`403 superadmin_required` on the license API, and never sees the hub address, the key prefix, the
activations or the hub's answers (the audit log names license events by activation id only). The
flag is never set from the web interface.
**Server:** settings are stored in SQLite; license actions talk to the hub named by
`WHM_LICENSE_HUB_URL` (bootstrap; the vendor hub `https://licserver.hostingsignal.in` when unset)
or by the token's issuer, verify every answer against the keys
pinned in the release, and check in every 12 h. **Needs:** a reachable hub over https for
activation; nothing for the Settings tab. **Gotchas:** with `licenseEnforce` on (default under
`NODE_ENV=production`) a lapsed license puts the panel into read-only degraded mode (`423` on
mutations; GETs, backups, restarts and unsuspend still work); sites keep running. The
*Market Provider Manager* `whm-hub` row is only the marketplace switch — the key lives here.

#### 1.2 Change Root Password

Rotate the Linux root password used for SSH and the console. **Who:** root.
Fields: *New root password* (with strength meter and generator), *Confirm*; a danger
confirmation precedes the change. **Server:** `POST /api/system/root-password` → agent op `user.set_password`, which feeds
`user:password` to `chpasswd` on stdin (never on a command line); audited without the secret. **Gotchas:** this is the OS account, not your WHM login — change that from the user menu.

#### 1.3 Configure HST Panel Analytics

Opt in or out of anonymous interface analytics. **Who:** root.
Toggles: *Send anonymous interface analytics* (off by default; generates a random participant
ID on first opt-in), *Include feature usage*, *Include anonymous error signatures*; **Rotate ID**
discards the link to previously submitted data. **Server:** `PUT /api/server-config/analytics`,
`POST …/analytics/rotate-id`; settings only. **Gotchas:** the *What is collected* card is the
authoritative list; nothing is sent while the first toggle is off.

#### 1.4 Configure HST Panel Cron Jobs

Schedules for the panel's own maintenance tasks. **Who:** root.
A table of every registered schedule (name, job type, editable **cron expression**, **Enabled**
toggle, last run, next run). **Server:** `GET/PATCH /api/system/schedules/:name`; schedules
enqueue jobs of their type into the queue (backups, AutoSSL, bandwidth accounting, disk usage,
quota checks, OS update check, statistics, process-log sampler, contact checks, cleanup).
**Gotchas:** the list is empty until features register their schedule; some features pause their
own schedule when nothing would run (statistics with no generator installed, bandwidth with no
web server) — the feature page shows *paused* with the reason. A schedule you disable here stays
off even if the feature is on.

#### 1.5 Initial Quota Setup

Enable and verify filesystem disk quotas. **Who:** root.
**Summary** card (tools installed? *Install quota tools* button or link to *Install Distro
Packages*) and a **Filesystems** card whose header holds *Also enable group quotas*; the table
(mount point, device, fstype, user-quota state, mounted with quota option, `/etc/fstab` entry, quota
files) has per-row actions **Enable quotas**, **Update fstab and enable** (danger) and **Turn off**;
the manual fstab diff and commands are under *Show manual steps* beneath the table (they follow the
group-quota switch; for XFS they end with a reboot instead of a remount, and for an XFS **root**
filesystem they start with the boot-loader command); a job card appears while
setup runs. **Server:** `POST /api/server-config/quota/enable`
runs as a job: rewrites the fstab line (backup `/etc/fstab.whm-bak`), remounts, `quotacheck`,
`quotaon`; `…/disable` runs `quotaoff`; `…/install-tools` installs the distro `quota` package as a
job. **XFS root filesystem** (the AlmaLinux/Rocky 9 default layout, `/home` inside `/`): the
initramfs mounts `/` from the kernel command line before `/etc/fstab` is read and XFS takes quota
options only at mount time, so fstab alone can never enable quotas there. The row shows *boot loader
change needed* (`/etc/fstab` column: *kernel args: rootflags= missing*) and **Update fstab and enable**
also puts `rootflags=uquota` (plus `gquota` with the group switch, merged with the flags already
there) on the kernel arguments — `grubby --update-kernel=ALL --args=rootflags=…` on the RHEL family,
`GRUB_CMDLINE_LINUX` in `/etc/default/grub` plus `update-grub`/`grub2-mkconfig` elsewhere (backup
`/etc/default/grub.whm-bak`) — and the job log prints the command it ran; quotas become active after
the next reboot (status `kernel_args_required` until the boot loader passes the flag, `reboot_required`
once it does; `quotacheck`/`quotaon` then follow from *Enable quotas*). **Needs:** `quota` tools; a
filesystem that supports user quotas (XFS applies the options only at mount time: reboot after the
change). **Gotchas:** without kernel quotas, packages' disk limits are recorded and measured by `du`
but not enforced; account creation records the limit as *pending* instead of failing.

#### 1.6 Link Server Nodes

Register other panel servers this one can hand work to. **Who:** root.
Table of nodes (name, `scheme://host:port` as user, roles, connection state, remote panel
version/profile/accounts, last tested, token stored?) with **Test connection**, **Edit**,
**Unlink**. The form asks for *Name*, *Hostname or IP*, *Scheme* (https recommended), *Port*,
*Remote username*, *API token* (created on the remote panel under *Development › Manage API
Tokens*; stored encrypted, never shown again), *Roles this node serves*, *Verify the TLS
certificate*, *Enabled*. **Server:** `/api/server-config/nodes*`; *Test* calls the remote panel's
API and records the answer. **Gotchas:** unlinking only deletes the stored token; nothing changes
on the remote server. DNS/configuration replication itself is set up under *Clusters*.

#### 1.7 Server Profile

Choose which roles this server fulfils. **Who:** root.
Radio choice between **Standard Node** (everything shown), **DNS Node**, **Mail Node** and
**Database Node**; cards show the services the profile monitors and the categories it hides;
**Apply profile** after a confirmation. **Server:** `PUT /api/server-config/profile` stores
`profile.name`, updates the monitored-service set in Service Manager and publishes
`profile.hiddenCategories` through `/api/auth/me`. **Gotchas:** hidden categories vanish from the
sidebar, Tools grid and search for everyone but stay reachable by URL and API, as in WHM.

#### 1.8 Server Time

Timezone and NTP synchronisation. **Who:** root.
Shows the current server time; *Find a timezone* filter, *Timezone* select, *Synchronise the
clock with NTP* toggle, **Apply**. **Server:** `PUT /api/server-config/time` → `timedatectl
set-timezone` / `set-ntp`. **Needs:** systemd's `timedatectl` (a capability notice replaces the
form otherwise). **Gotchas:** mail headers, logs and cron use this clock.

#### 1.9 Statistics Software Configuration

Web statistics generators and their schedule. **Who:** root.
**Generators** table (AWStats, Webalizer, Analog: installed?, enabled toggle, *Run* button),
*Default generator for new accounts*, *Let account owners choose their generator*, *Process
suspended accounts too*; **Schedule** card (*Rebuild statistics on a schedule*, cron expression);
*Generate now* action (job); **Last run** card. **Server:** `/api/server-config/stats*`; the run
merges plain and TLS domlogs (`/var/log/whm/domlogs/<user>/<domain>-access.log` and
`-ssl-access.log`) and writes reports under the output root. **Needs:** at least one generator
package installed. **Gotchas:** the schedule pauses itself while no enabled generator is installed
and resumes when one appears.

#### 1.10 Terminal

In-browser root shell. **Who:** root.
**Open terminal** starts a `/bin/bash` session; **Your sessions** lists your open sessions with
**Attach** and **Close**; a session ends after the configured idle time even while attached.
**Server:** `POST /api/server-config/terminal` opens a PTY through the agent (`terminal.open`),
output streams over `GET …/terminal/:id/stream` (SSE), keystrokes go to `POST …/input`;
open/close are audited. Output is long-polled from the agent (`terminal.read` with `waitMs`, up to
1 s) and relayed over SSE as it appears, keystrokes wake a pending read and the browser batches them
at 16 ms, so echo is immediate; in split mode restart `whm-agentd` together with `whm-panel` after
an upgrade (until then the stream falls back to 400 ms polling). Limits: `terminal.max_sessions`
(3) and `terminal.idle_minutes` (15, max 240). **Needs:** the `terminal` capability on the host. **Gotchas:** sessions belong to the
administrator who opened them; closing sends SIGHUP to the shell and whatever runs in it.

#### 1.11 Tweak Settings

Server-wide behaviour switches, grouped. **Who:** root.

| Group | Keys |
|---|---|
| Mail | Maximum hourly emails per domain (`tweak.max_emails_per_hour`, 0 = unlimited), Allow remote domains |
| Accounts | Prevent unlimited bandwidth on new accounts, Login theme (`jupiter`, `paper_lantern`) |
| Security | Minimum password strength (0–100), cPHulk on/off, failures per IP, block minutes, Require 2FA for root |
| System | Default DNS zone TTL, Default PHP version for new accounts, Update tier, Automatic updates, Interface analytics |
| Backups | Enable scheduled backups, schedule (cron), daily/weekly/monthly retention |

**Server:** `PUT /api/system/settings` (bulk key/value); audited. **Gotchas:** this is a raw
view of the same keys the dedicated pages edit (cPHulk, Update Preferences, Backup
Configuration…); the dedicated page also applies side effects (re-creating schedules,
re-applying firewall rules), the raw save does not always.

#### 1.12 Update Preferences

Release tier and automatic update policy. **Who:** root.
*Release tier* radio (`stable`, `release`, `current`, `edge`), *Panel updates: apply
automatically (recorded policy)*, *Apply operating system package updates automatically*,
*Notify the server contact when updates are available*; **Check now** runs the OS update check
as a job and reads the panel release feed; cards show the feed result, pending OS packages and
the last check. **Server:** `PUT /api/server-config/updates`, `POST …/updates/check` (202).
**Gotchas:** the panel does not update itself in place — the panel policy is a record; the OS
toggle is honoured by *Software*'s daily `os-update-check`, and packages are applied from
*Software › System Update*.

#### 1.13 WHM Marketplace

Browse and install add-ons and plugins. **Who:** root.
With the `whm-hub` provider enabled (*Market › Market Provider Manager*) the page lists the
hub's verified, signed plugins (install goes through the consent screen of *HST Panel › Manage
Plugins › Marketplace*); below it, a searchable **Distribution packages** catalog (host software
the package manager can install, filter by category). Without the hub it is a read-only preview.
**Server:** `GET /api/server-config/marketplace`, `GET /api/marketplace/status`. **Needs:** a
license with the `marketplace_free`/`marketplace_paid` feature for hub installs.

## 2. Support

Routes under `/api/support/*`.

#### 2.1 Create Support Ticket

Open a support request with a redacted system snapshot. **Who:** root (the ticket API is root
only).
Form: *Subject*, *Severity* (low / normal / high / critical), *Area*, *Description* (≥ 10
characters), *Reply-to address*, *Attach a system snapshot*; **Preview snapshot** shows exactly
what is attached (panel and OS versions, load, memory, disks, installed daemons, service
states). A **Tickets** table lists every ticket (reference, subject, severity, area, status,
e-mail delivery state, opened) with a detail modal offering **Resend**, **Download snapshot**,
**Close/Reopen**, **Delete**. **Server:** `POST /api/support/tickets` stores the ticket in
SQLite and mails it to the support address from *Support Center › Settings*; the reference is
the ticket id. **Needs:** a mail transport (Exim or the SMTP relay from *Contact Manager*) for
delivery; without an address the ticket is stored only. **Gotchas:** deleting removes the local
copy; anything already e-mailed stays with the provider.

#### 2.2 Grant HST Panel Support Access

Time-boxed access for support engineers. **Who:** root.
**Grant access** form: *Label* (ticket number; becomes the key comment and token name),
*Duration (hours)* (default and maximum from *Support Center › Settings*), *SSH access as root*,
*API token* with *Token scope* (full root / Development read-only / Development read-write),
*Note*. The result modal shows — **once** — the SSH private key, the login command, the
`authorized_keys` line with its `expiry-time` option, the API token and an example request.
**Grants** table (label, status, what, expires, granted by) with **Revoke** and **Retry cleanup**;
*Expire due grants now*. **Server:** `POST /api/support/access` generates a key pair through the
agent, appends it to `/root/.ssh/authorized_keys` with `expiry-time`, and creates an API token
with the same expiry; a 5-minute check ends overdue grants and removes keys. **Needs:** `sshd`
(OpenSSH ≥ 7.7 for `expiry-time`); with password/root login disabled the page warns and offers
only the token. **Gotchas:** the private key is not stored; a grant whose key could not be
removed stays in *cleanup pending* and is retried every five minutes (sshd refuses the key after
the deadline regardless).

#### 2.3 Support Center

Documentation, forums and support resources. **Who:** root, reseller (overview and docs).
Cards: **Tickets** (counts, *New ticket*), **Support access** (active grants, *Manage*),
**Diagnostics** (root: download a JSON bundle with snapshot, capabilities, services, failed jobs,
schedules, non-secret settings, recent audit entries), vendor/community links, *In this panel*
links, **Documentation shipped with this panel** (reads the repository's Markdown documents,
section by section, with copy/download), and **Settings** (root): *Support email address*,
*Provider name*, *Support portal URL*, *Default grant length*, *Maximum grant length*.
**Server:** `/api/support/center`, `/docs`, `/diagnostics`, `/settings`.

#### 2.4 Account Conversations

One support thread per hosting account between its **account manager** and the account. **Who:**
root (every account), reseller (accounts it owns or manages), the hosted-account login (`user`
role: its own thread, shown as *My support* with a banner naming the manager).
Conversation list on the left (filter, unread badges, closed pills, last message), the thread on
the right (day separators, *Load earlier messages*, **Close**/**Reopen** for the manager side) and a
composer (Ctrl+Enter sends, 4000 characters). `?account=<username>` opens a thread directly (the
*Conversation* button on the account summary). **Server:** `/api/support/chat*`; the thread is
created on the first message, a closed thread reopens on a new message, updates arrive live over
`GET …/chat/:username/stream` (SSE, with a fresh snapshot after every reconnect), the other party
gets a mail notice through *Contact Manager* when mail can leave the server, and the audit row of a
post records the length only, never the text. **Gotchas:** being the manager grants the
conversation, not the account's settings; the account side exists once the hosted-account login
creates `user` rows per account.

## 3. Networking Setup

Routes under `/api/networking/*`; **root only**.

#### 3.1 Change Hostname

Set the server's fully qualified hostname. **Who:** root.
Shows the current hostname, its installed certificate (issuer, expiry, the **Renewal** row with the
daily `hostname-certificate-renew` schedule) and the hostname landing vhost; form: *Hostname* (at
least three labels, no `www`, not an IP, not a reserved loopback name, not a domain hosted on this
server), *IP address for /etc/hosts* (blank = main IP, `127.0.1.1` when none), toggles *Update
/etc/hosts*, *Re-issue self-signed service certificates*, *Add DNS records for the hostname* (on by
default; needs the DNS module); **Preview /etc/hosts**, *Save toggles as defaults*, **Change
hostname** (type the new name to confirm), **Reissue hostname certificate**. The result lists each
step in order — system hostname, `/etc/hosts`, panel setting, self-signed service certificates,
**DNS** (A record, AAAA when the server has a public IPv6, `www.<hostname>` CNAME, MX to the host),
**landing** (the branded hostname page rendered from the `landing` web template into
`/var/www/whm-default`, served by a `server` vhost that no account can take over) and
**certificate** (the hostname's Let's Encrypt certificate through AutoSSL, installed for the panel,
Exim, Dovecot and FTP) — with its outcome. **Server:** `POST /api/networking/hostname` →
`hostnamectl set-hostname`, hosts-file rewrite, `basic.hostname`, certificates, zone records,
`ctx.web.ensureHostnameVhost`, `ctx.ssl.issueFor` + `installServiceCert`;
`POST /api/networking/hostname/certificate` repeats the certificate step; the schedule re-issues it
within AutoSSL's renewal window. **Needs:** `hostnamectl` (systemd); a public A record and an
AutoSSL provider for the certificate. **Gotchas:** the preview flags a conflict when the name is a
domain of an account (and account creation refuses the hostname in return); partial failures are
reported step by step, not rolled back; the panel's own certificate is live only when the agent
writes the pair the listener reads (`/etc/whm/tls/cert.pem` + `key.pem`, the installer's default —
the step says *pending* otherwise, see `docs/design/https-defaults.md`).

**The bare address (`http://<ip>/`, `https://<ip>/`).** Beside the hostname vhost the panel keeps a
**catch-all vhost** that serves the same landing page to any name or address no site answers for:
Debian `conf-enabled/000-whm-default.conf` (the stock `000-default` site is disabled), RHEL
`conf.d/+whm-default.conf`. It is written whenever the hostname page is, and again after a port, bind,
IP or hostname-certificate change; on 443 it carries the hostname's certificate when one is installed,
else the `apache` service certificate, the panel's own pair or a self-signed pair the panel generates
once under `/etc/ssl/whm/default/` — so `https://<ip>/` shows the page behind a certificate warning
instead of a random tenant's site or a handshake error. With NGINX in front, its `:443 default_server`
proxies to the same page. Its state is recorded with the other Apache applies
(`GET /api/service-config/apache` → `defaultVhost`; no page row yet); the page content is the `landing`
web template (14.20). It never redirects to HTTPS (a redirect of `http://<ip>/` would end on a
certificate warning) and runs no PHP.

#### 3.2 Resolver Configuration

DNS resolvers the server uses. **Who:** root.
Current configuration (read from `/etc/resolv.conf` or systemd-resolved, with a note on which
tool manages the file), presets, up to four resolver slots, *Search domains*, *Use these
resolvers for the panel's DNS checks*, *Replace /etc/resolv.conf with a static file* (take over
from the managing tool), **Test these resolvers** / **Test current** (live lookups), **Apply**,
and a **Change history** table (before/after/target). **Server:** `PUT /api/networking/resolvers`
writes to systemd-resolved or the file (`mode: auto|file`), restarts the service when needed;
history under `/api/networking/history?kind=resolvers`. **Gotchas:** when another tool
(NetworkManager, cloud-init) owns the file the save reports `applied: false` until you take
the file over.

## 4. Security Center

Routes under `/api/security/*`; **root only** except Two-Factor Authentication, where every
user manages their own enrolment.

#### 4.1 Apache mod_userdir Tweak

Control `http://host/~user/` URLs. **Who:** root.
*Enable mod_userdir* toggle and a per-account **Exclude these accounts** list; **Save and reload
Apache**. **Server:** `PUT /api/security/userdir` writes the managed include, validates with
`apachectl -t`, reloads; a rejected file is rolled back. **Needs:** Apache. **Gotchas:** `~user`
URLs bypass per-domain bandwidth accounting and SSL, hence the exclusions.

#### 4.2 SMTP Restrictions

Block outgoing SMTP (port 25) from everyone but mail-system users. **Who:** root.
One-button page: **Enable/Disable SMTP restrictions**, with per-family (IPv4/IPv6) state pills,
the firewall backend in use and warnings when the panel setting and the live rules disagree.
**Server:** `PUT /api/security/smtp-restrictions` installs owner-match rules through the agent;
the setting is re-applied at panel start and checked hourly. **Needs:** `iptables` or `nftables`.

#### 4.3 Compiler Access

Allow or deny compilers to unprivileged users. **Who:** root.
**Allow compilers / Deny compilers** with the list of binaries found (`gcc`, `cc`, `g++`,
`clang`). **Server:** `PUT /api/security/compilers` changes the binaries' modes through the agent.
**Gotchas:** the page is empty when no compiler is installed.

#### 4.4 Configure Security Policies

Login and session policies. **Who:** root.

| Field | Key | Enforced by |
|---|---|---|
| Require 2FA for root / for resellers | `security.2fa.required_for_root`, `security.policy.require_2fa_for_resellers` | login (`mustEnroll2fa` gate) |
| Only users with 2FA may create API tokens | `security.policy.api_tokens_require_2fa` | token auth middleware |
| Limit logins to verified IP addresses | `security.policy.verified_ip_login` | login (audit + `login.new_ip` notification) |
| Idle session timeout (minutes) | `security.policy.session_timeout_minutes` | session middleware (0 = server default `sessionTtlMs` from whm.conf, 8 h) |
| One active session per user | `security.policy.disallow_concurrent_sessions` | login destroys other sessions |
| Maximum password age (days) | `security.policy.password_max_age_days` | login forces a change |
| Minimum password strength | `security.min_password_strength` | every password set |

**Server:** plain settings (`PUT /api/system/settings`), read by `services/auth.js` through
`ctx.security.policy()`; every switch is enforced by core exactly as the table says
(`server/test/auth-policy.test.js`), the page's help text names the enforcement point, and the
Security Advisor reports a policy as *enforced* once it is on.

#### 4.5 cPHulk Brute Force Protection

Block repeated failed logins. **Who:** root.
Tabs: **Status & settings** (protection on/off, active blocks, failures and attempts in 24 h;
*Failures per IP before blocking*, *Block duration (minutes)* — also the counting window —,
*Keep login history (days)*, *Also drop blocked addresses in the firewall*, *Denylist entries
create permanent blocks*; top offending addresses), **Current blocks** (block an address or
CIDR for N minutes or permanently, **Unblock**, **Remove all**), **History** (every login
attempt, filter failures), **Allow/Deny lists**. **Server:** `/api/security/cphulk/*`; the login
path consults `cphulk_blocks`; with firewall sync the agent adds/removes firewall rules; a
maintenance job expires blocks and prunes history. **Gotchas:** panel logins are matched per
address — a CIDR is only blocked in the firewall and needs firewall sync; allowlisted exact
addresses are never blocked.

#### 4.6 Host Access Control

Per-service allow and deny rules (TCP wrappers). **Who:** root.
Ordered rule rows (*Source* address/CIDR, *Action* allow/deny, *Comment*, move up/down,
remove), **Save and write /etc/hosts.allow**, and the current `/etc/hosts.allow` and
`/etc/hosts.deny` contents. **Server:** `PUT /api/security/host-access` writes `hosts.allow`
(and `hosts.deny` only when the panel wrote it before). **Needs:** daemons linked with
`libwrap` (sshd, vsftpd, dovecot…); the page notes when libwrap is absent. **Gotchas:** a
`hosts.deny` with foreign rules is left untouched and keeps applying.

#### 4.7 Manage External Authentications

OpenID Connect providers for panel login. **Who:** root.
**Policy** card: *Allow external authentication on the login page*, *Automatically link by
verified e-mail*. **Providers** table (issuer, client ID, discovery state, linked users,
enabled) with **Discover**, **Edit**, **Enable/Disable**, **Delete**. **Add provider** first offers
vendor **presets** — Google, Microsoft Entra ID, Apple, Meta, Cloudflare Access, GitLab, Auth0,
Okta, Keycloak — pick one, enter the vendor-specific field (tenant ID, team name, host or issuer
URL) plus the OAuth client ID and secret, and register the shown redirect URI
`https://<hostname>:2087/api/auth/external/<identifier>/callback` at the provider; discovery runs on
creation and the provider is stored only when it validates. GitHub is listed as *not supported*
(OAuth 2.0 only, no OIDC). The generic form stays for anything else: *Identifier* (lowercase, used
in URLs), *Display name*, *Issuer URL* (discovery reads `/.well-known/openid-configuration`),
*Client ID*, *Client secret* (stored encrypted), *Scopes*, *Enabled*. **Server:**
`GET /api/security/external-auth/presets`, `POST /api/security/external-auth` with `{ preset, name,
clientId, clientSecret, fields }`, `/api/security/external-auth*`; login flow under
`/api/auth/external/:name/start|callback`. **Gotchas:** discovery refuses endpoints on other
hosts unless you explicitly allow them (the client secret is sent to the token endpoint); Microsoft
needs a specific tenant (`common`, `organizations` and `consumers` are refused); Apple requests no
scopes (subject only, no e-mail) and needs a pre-generated client-secret JWT (at most 6 months);
Meta uses the pinned Graph API token endpoint; Apple and Meta get the secret as `client_secret_post`.

#### 4.8 Manage root's SSH Keys

Generate, import and authorise root SSH keys. **Who:** root.
**Key pairs in /root/.ssh** (name, type, fingerprint, comment, authorized, created) with
**Authorize/De-authorize**, **View private key** (audited), **Copy public key**, **Delete key
pair**; **Authorized keys** (every key that may log in as root, including imported ones);
**Generate a new key** (*Name*, *Type* ed25519/rsa/ecdsa, *Bits*, *Comment*, *Passphrase* —
passed to `ssh-keygen` via its environment —, *Authorize immediately*); **Import a public key**.
**Server:** `/api/security/ssh/keys*` through agent ops on `/root/.ssh`. **Needs:** `ssh-keygen`
for generation.

#### 4.9 Manage Wheel Group Users

Who may become root with `su`. **Who:** root.
Pick a user and **Add to wheel** (or `sudo`, whichever group exists); members table with
**Remove**. **Server:** `POST/DELETE /api/security/wheel[/:username]` → `gpasswd -a` / `gpasswd -d`
through the agent. **Gotchas:** if neither group exists the page tells you to create one and
configure `pam_wheel` first.

#### 4.10 ModSecurity Configuration

Web application firewall engine settings. **Who:** root.
Status card and **Engine directives**: `SecRuleEngine` (On / DetectionOnly / Off),
`SecAuditEngine`, audit relevant status, audit log parts, request/response body access, body
limits and action, PCRE limits, `SecConnEngine`; empty = keep the distribution value.
**Save and reload Apache**. **Server:** `PUT /api/security/modsec/config` writes the managed
file, `apachectl -t`, reload, rollback on error. **Needs:** `mod_security2` (Debian:
`libapache2-mod-security2`; RHEL: `mod_security`).

#### 4.11 ModSecurity Tools

Review hits and manage rules. **Who:** root.
**Hits list** (parsed from the audit/error log; time, client, host, URI, rule id, message,
severity, action; **Disable rule** per row) and **Rules list** (every rule across the loaded
files: id, message, severity, phase, vendor/file, enable toggle; search; *Disabled only*).
**Server:** `GET /api/security/modsec/hits|rules`, `PUT …/rules/:id` adds/removes a
`SecRuleRemoveById` for the whole server and reloads Apache. **Gotchas:** prefer disabling one
rule over switching the engine to DetectionOnly.

#### 4.12 ModSecurity Vendors

Install and update rule vendors. **Who:** root.
**Installed vendors** (name, source URL, installed/updated, enabled toggle; **Update**,
**Remove**) and **Add a vendor** (*Name*, *Archive URL* over https — `.tar.gz/.bz2/.xz`,
`.tar` or `.zip` containing `rules/` and optional `crs-setup.conf`; presets for OWASP CRS 4.x and
Comodo). Installs and updates run as jobs with a progress log. **Server:**
`/api/security/modsec/vendors*`; archives are downloaded and extracted by the agent, Apache is
reloaded. **Gotchas:** the OWASP preset is disabled when the distribution's CRS package is
already active.

#### 4.13 Password Strength Configuration

Minimum password strength requirements. **Who:** root.
*Default minimum strength* (0–100; 65 rejects dictionary words and short passwords, 80 needs
mixed case and symbols) and **per-context overrides** (`security.password.strength.<context>`);
**Test a password** scores a candidate with the server's algorithm for a chosen context.
**Server:** settings; `POST /api/security/password-strength` scores without storing.

#### 4.14 Security Advisor

Scan the server for security weaknesses. **Who:** root.
**Scan now / Scan again** runs read-only probes (SSH, firewall, cPHulk, ModSecurity,
services, panel integrity via `MANIFEST.sha256`, `.htaccess` `Options` lines Apache refuses under
the account `AllowOverride` — `FollowSymLinks`, `All`, `ExecCGI`, `Includes`, see 7.1 — in every
document root, …) and groups findings by grade with
remediation links; the summary shows counts and the last scan time and trigger.
**Server:** `POST /api/security/advisor/scan`, last result from `GET /api/security/advisor`.
**PHP advisories:** one rule compares every installed PHP version (Debian trees, EasyApache
`ea-php*`, Remi `php*`) with the data-driven list in the `security.advisories` setting
(seeded with CVE-2026-109618/109619 "PHP2Shell" ranges and the EOL branches; CVE-2026-115560 is
listed without ranges until PHP publishes them). A finding names each affected version with the
version that fixes it and links to MultiPHP Manager, which shows the same badge. Edit the list on
the Security Advisor page (*Advisory list*); an entry without an id is dropped and counted as
invalid, a range the matcher cannot read makes that branch show as **unknown** rather than pass,
and a version whose patch level could not be read is reported as unknown too.
**Gotchas:** scans never change anything.

**Hardening card** (root; anchor `#hardening`; design `docs/design/hardening.md`). Five one-click items,
each with a status pill (*applied*, *not applied*, *not applicable*, *unknown*), live detail lines,
**Apply** / **Revert**, and **Apply N recommended** for the safe ones:

| Item | Apply does | Revert |
|---|---|---|
| **Fail2ban** | writes `/etc/fail2ban/jail.d/whm.local` (sshd aggressive, Exim, Dovecot, FTP, Apache auth/badbots and the **whm-panel** jail, enabled for the daemons this host runs) + `filter.d/whm-panel.conf` (failed panel logins from the journal, identifier `whm-panel`), `fail2ban-client -t`, enable + reload. Banned addresses are listed per jail with **Unban**; *Never banned from the panel* shows the address exempted from the panel jail only (yours by default). Missing package → **Install** (stack component) | files removed, Fail2ban left running |
| **Automatic security updates** | Debian: `20auto-upgrades` + `52whm-unattended-upgrades` (security pockets only, no automatic reboot), apt timers on; RHEL: `/etc/dnf/automatic.conf` (`upgrade_type security`, apply + download), `dnf-automatic.timer`. Missing package → a `software.pkg.install` job first (202) | originals restored, timer off |
| **SSH daemon** | `PermitRootLogin prohibit-password`, `MaxAuthTries 4`, `LoginGraceTime 30`, `X11Forwarding no` through the sshd drop-in (a stricter value in effect is kept). Refused while root could not log in with a key (no authorized key, `PubkeyAuthentication no`, …): the card hides Apply and links to *Manage root's SSH Keys* / *SSH Password Authorization Tweak* | the previous managed values |
| **Kernel network hardening** | `/etc/sysctl.d/90-whm-hardening.conf` (rp_filter, syncookies, no redirects/source routes, martian logging, ICMP broadcast/bogus), loaded with `sysctl -e -p` and rolled back if the kernel refuses | file removed, recorded values written back |
| **Firewall baseline** | default-deny INPUT with the panel's backend (`WHM_BASELINE` chain or nft table `inet whm`): the plan table lists what stays open — panel ports, every port root's sshd listens on, 80/443, mail/DNS/FTP + passive range when installed, the license hub's ports, your *extra TCP/UDP* — and you must type the SSH port you are connected on and tick *I can still reach SSH on port N*. Re-applied at boot while on. **Not applicable** while firewalld or ufw is active (they own the policy) | previous INPUT policy restored, chain removed |

Every apply/revert is audited (`security.hardening.*`); the scan adds one finding per item that is not
applied. **Server:** `GET /api/security/hardening`, `GET …/hardening/firewall/plan`,
`POST …/hardening/:item/apply|revert`, `POST …/hardening/fail2ban/unban|install`. **Gotchas:** the
panel jail reads the journal of `whm-panel.service` (a development run logs to the terminal and is
not seen); behind a reverse proxy it would ban the proxy's address, so leave it for the panel's own
listener; `rp_filter = 1` is strict — a multi-homed host with asymmetric routes needs Revert.

**Alerts panel.** The last security alerts the server raised (critical findings new since the previous
scan, PHP advisories, pending and applied security updates, panel security releases, administrator
notices) with severity and delivery state, and a link to *Contact Manager › Security notifications*
(5.1), where delivery is configured.

#### 4.15 Security Questions

Recovery question policy. **Who:** root.
*Require security questions*, *Questions each user must answer*, *Minimum answer length*,
*Allow users to write their own questions*, and the *Question pool*. **Server:** settings only
(`security.questions.*`). **Gotchas:** stored but **not enforced** — no login or password-reset
flow consumes these settings yet (the page says so).

#### 4.16 Shell Fork Bomb Protection

Per-user process and memory limits. **Who:** root.
Status, then *Maximum processes (nproc)* (WHM's classic default 35), *Maximum open files*,
*Maximum virtual memory (MB)*, *Exempt groups* (e.g. `wheel, sudo`); **Enable protection /
Save limits**, **Disable**. **Server:** `PUT /api/security/fork-bomb` writes
`/etc/security/limits.d/whm-forkbomb.conf` through the agent; root is always exempt.
**Needs:** `/etc/security/limits.d` (pam_limits).

#### 4.17 SSH Password Authorization Tweak

Toggle SSH password authentication and related sshd options. **Who:** root.
Effective configuration (with warnings when another file shadows a setting), then *Password
authentication*, *Permit root login* (yes / key only / forced commands only / no), *Public key
authentication*, *Permit empty passwords*, *Max authentication tries*, *Port*; **Save and
reload sshd**. **Server:** `PUT /api/security/ssh/config` writes the panel's drop-in, `sshd -t`,
reload, rollback on error. **Gotchas:** turning password auth off with no authorized root key
asks for an explicit override — it would lock root out; update the firewall before changing
the port.

#### 4.18 Traceroute Enable/Disable

Control traceroute availability. **Who:** root.
**Enable/Disable traceroute** for `traceroute`, `tracepath` and `mtr` (mode changes through
the agent). Empty when none is installed.

#### 4.19 Two-Factor Authentication

Time-based one-time passwords for panel logins. **Who:** every user for their own account;
the server policy card is root only.
**Your account**: status, **Set up two-factor authentication** (shows the secret and an
`otpauth://` URI to add to Google Authenticator, Authy, 1Password…; confirm with the current
6-digit code), **Disable**. **Server policy** (root): *Require two-factor authentication for
the root user*. **Server:** `POST /api/auth/2fa/enroll|confirm|disable`; the secret is stored
encrypted. **Gotchas:** when the policy requires 2FA for your role, this page is the only one
you can open until you enrol.

## 5. Server Contacts

Routes under `/api/server-contacts/*`; **root only**.

#### 5.1 Contact Manager

Notification channels and the events they receive. **Who:** root.
**Contacts** table (name, channel, address, events, minimum severity, last sent/error) with
**Test**, **Edit**, **Enable/Disable**, **Remove**, and **Add contact**:

| Field | Notes |
|---|---|
| Channel | Email · SMS (email-to-SMS gateway, ≤ 300 chars) · Slack incoming webhook · Pushover (user key + application token) · Webhook (JSON POST `{ event, severity, subject, body, data, hostname }`, optional HMAC `X-WHM-Signature`) |
| Address / URL / key | Secrets (webhook URLs, tokens, signing secret) are stored encrypted and shown masked |
| Minimum severity | info / warning / error / critical |
| Events | *Receive every event* or pick from the catalog (events marked *not raised yet* are reserved) |

**Notification settings**: *Send notifications*, *From address*, delivery-log retention,
**SMTP relay** (host, port, security none/STARTTLS/TLS, username, password, accept self-signed,
allow plaintext auth, prefer relay over Exim), **Webhooks** (*Allow webhooks to private
addresses*), *Send a test message*. **Monitoring checks**: run every 10 minutes
(`server-contacts-check` schedule) and raise `service.down`, `service.restored`,
`disk.space.low` and `ssl.expiring`; *Disk usage threshold*, *Repeat an open alert after*,
*Warn about certificates expiring within*; **Run checks now** (job). **Event catalog** and
**Delivery log** (every attempt, filter by status and event). **Server:**
`/api/server-contacts/*`; other modules call `ctx.contacts.notify(event, payload)`.
**Needs:** Exim or an SMTP relay for e-mail/SMS; Slack/Pushover/webhooks only need outbound
HTTPS. **Gotchas:** webhooks to private addresses are refused unless allowed.

**Security notifications card** (root; design `docs/design/security-alerts.md`). What the server tells
administrators — and, when you allow it, hosting accounts — when something security-relevant
happens: a critical Security Advisor finding that is new since the previous scan, a PHP advisory
matching an installed version, security updates pending or applied by *System Update*, a panel
release flagged as a security release, or a notice you write yourself. Settings: *Raise security
alerts* (off records nothing), *Mail hosting accounts about emergency updates* (default off), *Minimum
severity* (alerts below it are stored as *skipped*), *Digest window (minutes)* (default 60: the first
alert after a quiet period goes out at once, later ones inside the window are held and sent together;
`0` sends each alert immediately); **Save** / **Reset**. Actions: **Send a test alert** (administrators
only) and **Test with accounts too** (confirmed), **Deliver N waiting now**, **Send notice** (*Subject*,
*Message*, *Severity*, optionally every active account — an emergency notice in your own words). The
card warns when no administrator can receive alerts (no contact subscribed to the **Security alert**
event and root mail not routed — a fresh install routes it to root mail) or when no mail transport
exists; alerts nobody can receive stay *waiting* and go out as soon as a contact subscribes. The
table lists the last alerts with their delivery state. **Audience:** accounts only ever receive
applied-update notices (package names, no versions, "nothing is required from you"), your notices
and tests — never finding details, pending-update lists or panel release notes; suspended accounts
and accounts without a contact address are skipped, one mail per address. **Server:**
`/api/server-contacts/security-alerts*` (`PUT …/settings`, `POST …/test`, `…/raise`, `…/deliver`);
other modules call `ctx.securityAlerts.raise()`. **Gotchas:** mails are plain text today; on the RHEL
family pending updates are not flagged as security updates yet, so only the advisor, panel-release
and notice kinds fire there.

#### 5.2 Edit System Mail Preferences

Where system mail for root and `nobody` is delivered. **Who:** root.
*Forward root's mail to* and *Forward mail for nobody to* (local users or full addresses, up
to 20 each), **Send test to root**, **Events that also mail root** (independent of contacts),
and the read-only list of other `/etc/aliases` entries; **Save** rewrites only the `root` and
`nobody` lines and rebuilds the alias database. **Server:** `PUT /api/server-contacts/mail-preferences`
→ agent edits `/etc/aliases`, `newaliases`. **Needs:** Exim (or the SMTP relay, in which case
full addresses receive the events through it). **Gotchas:** the alias file is read through the
agent; when it cannot be read the forwarding list is unavailable but the event list still saves.

## 6. Resellers

Routes under `/api/resellers/*`. Reading one's own reseller record, delegated IPs, owned
accounts and usage is allowed to the reseller; everything else is **root only**.

#### 6.1 Change Ownership of an Account

Move one hosting account to root or another reseller. **Who:** root.
Pick the account, choose *New owner*, confirm. **Server:** `PUT /api/resellers/ownership/:username`
updates the owner; packages, IPs and DNS are unchanged; the new owner's limits are reported
(an over-limit reseller is flagged), not enforced.

#### 6.2 Change Ownership of Multiple Accounts

Bulk ownership changes. **Who:** root.
Table of all accounts with a filter by current owner and a search, multi-select, *New owner*,
**Move N to owner**; a result table shows each account's outcome and warnings. **Server:**
`POST /api/resellers/ownership { usernames, owner }`, reassigning one by one.

#### 6.3 Edit Reseller Nameservers and Privileges

ACLs and nameservers per reseller. **Who:** root.
Pick the reseller; **Nameservers** (blank entries fall back to the server's, from *Basic
WebHost Manager Setup*; *reseller owns its nameservers*); **Privileges** grouped as in WHM —
*Information* (list accounts, summaries, bandwidth, basic system info, news, third-party apps,
edit locales), *Account management* (create, terminate, suspend, upgrade, modify, passwords,
quotas, bandwidth limits, demo mode, rearrange, dedicated IPs, shell), *Packages*
(add/remove, edit, unlimited variants), *DNS* (edit/remove zones, clustering), *Mail*,
*Server* (status, restart services), *SSL* (manage, view, buy, generate) and **All Features
(root-level access)** (asks for confirmation). Named **ACL lists** can be saved and deleted for
reuse in Reseller Center. **Server:** `PUT /api/resellers/:username/privileges`,
`PUT/DELETE /api/resellers/acl-lists/:name`. **Gotchas:** account functions check these keys
inside the service (`suspend-acct`, `kill-acct`, `passwd`, `quota`, `limit-bandwidth`,
`add-pkg-shell`, `demo-setup`, `edit-account`, `upgrade-account`, `list-accts`, `news`).

#### 6.4 Email All Resellers

Broadcast a message to every reseller. **Who:** root.
Recipient list, *From address* (blank: `resellers.email_from`, then the notification sender),
*Subject*, *Body* (placeholders `{{username}}`, `{{accounts}}`, `{{hostname}}`); **Send**
runs as a job with a delivery log; **Recent broadcasts** keeps messages and addresses (root
only). **Server:** `POST /api/resellers/email` (202). **Needs:** a mail transport (501
otherwise).

#### 6.5 Manage Reseller's IP Delegation

IP addresses a reseller may assign. **Who:** root (a reseller can view its own).
Pick the reseller; table of delegatable addresses (address, family, interface, role,
delegated) with checkboxes, **Save delegation**; a second table explains why other addresses
cannot be delegated (main, reserved, dedicated, dynamic, delegated elsewhere). **Server:**
`PUT /api/resellers/:username/ips { addresses }`. **Gotchas:** delegated addresses plus the
reseller's shared IP are the only ones it may assign when creating accounts; an address can be
delegated to one reseller only.

#### 6.6 Manage Reseller's Shared IP

Default shared IP for a reseller. **Who:** root.
Radio list: *Server shared IP* or one of the main/delegated/free addresses; **Save shared IP**.
**Server:** `PUT /api/resellers/:username/shared-ip`. **Gotchas:** existing accounts are not
moved — use *Change Site's IP Address*.

#### 6.7 Reseller Center

Create and manage resellers and their limits. **Who:** root.
Table (username, e-mail, accounts/limit, disk allocated bar, privilege count, shared IP, last
login, status) with **Edit**, links to the privilege, delegation, accounts and usage pages,
**Suspend/Restore privileges** and **Remove reseller status**. **Add a reseller**: *Create from
an existing hosting account* or a standalone login (*Username*, *Email*, *Password* — blank
generates one shown once, with a forced change at first login), *Privileges (ACL list)*,
*Shared IP*, **Limits** (*Maximum accounts*, *Disk space (MB)*, *Bandwidth (MB / month)*,
*Allow disk overselling*, *Allow bandwidth overselling*), **Nameservers**, **Allowed
packages**. **Edit** adds *Notes* and the full privilege grid. **Server:**
`POST/PUT /api/resellers[/:username]`, `…/suspend`, `…/unsuspend`. **Gotchas:** suspending a
reseller's privileges locks the reseller login only; its hosting accounts keep running.

#### 6.8 Reset Resellers

Strip reseller privileges. **Who:** root.
Table with multi-select, **Reset selected**, **Reset all resellers**; confirmation states how
many accounts move to root. **Server:** `POST /api/resellers/reset`: ACLs, limits, nameservers
and delegated IPs are removed and the owned accounts are reassigned to root; the hosting
accounts themselves are untouched.

#### 6.9 Show Reseller Accounts

Accounts owned by a reseller. **Who:** root (any reseller), reseller (own).
Reseller picker (root), *Active only / Suspended / All* filter, searchable table (domain,
user, package, IP, disk, bandwidth, contact, created, status) with **Modify** and **Change
owner** links. **Server:** `GET /api/resellers/:username/accounts`.

#### 6.10 View Reseller Usage and Manage Account Status

Usage overview with suspend controls. **Who:** root (all resellers), reseller (own).
**All resellers** table (accounts, disk allocated/used, bandwidth allocated/used against limits,
status), a per-reseller usage card, and the reseller's **Accounts** table with per-row
**Suspend** (reason recorded) / **Unsuspend**. **Server:** `GET /api/resellers/usage`,
`GET /api/resellers/:username/usage`, suspension through `POST /api/accounts/:username/suspend|unsuspend`.

## 7. Service Configuration

Routes under `/api/service-config/*` and `/api/system/services*`; **root only** except
reading the service list.

#### 7.1 Apache Configuration

Global web server directives and includes. **Who:** root.
**Server** card (version, MPM, modules, vhost counts with *Sync vhosts* job; *Reload* /
*Restart*; the **HTTPS redirect** toggle *Redirect HTTP to HTTPS when a certificate is installed* —
setting `web.force_https`, on by default: every vhost with a certificate answers port 80 with a 301
to `https://`, the ACME challenge path excepted, sites without a certificate are not touched, and
saving re-renders every vhost; a warning appears while `mod_rewrite` is not loaded, because the
redirect block is wrapped in `<IfModule mod_rewrite.c>` — the agent op `web.module.enable`
(`a2enmod` on Debian with configtest and rollback, a `conf.modules.d` check on RHEL) switches it
on — and the **Hostname site** row names the hostname landing vhost). Tabs: **Global directives** (Timeout, KeepAlive, MaxKeepAliveRequests,
KeepAliveTimeout, ServerTokens, ServerSignature, TraceEnable, HostnameLookups, ServerAdmin,
FileETag, LimitRequestBody, *Default PHP-FPM version for new accounts*, DirectoryIndex list,
*Enable mod_status for localhost*), **MPM / workers** (module event/worker/prefork,
StartServers, ServerLimit, MaxRequestWorkers, MaxConnectionsPerChild, spare servers/threads,
ThreadsPerChild; switching the module restarts Apache), **Include editor** (custom directives
appended verbatim; **Test configuration**). **Server:** `PUT /api/service-config/apache`
renders `conf-enabled/whm.conf` or `conf.d/whm.conf`, validates with `apachectl -t`, reloads;
rejected saves are rolled back. **Needs:** Apache. **Gotchas:** a threaded MPM cannot be
enabled while `mod_php` is loaded — the page warns. Every account vhost renders its document
root with `Options -Indexes +SymLinksIfOwnerMatch` and `AllowOverride AuthConfig FileInfo Indexes
Limit Options=Indexes,MultiViews,SymLinksIfOwnerMatch,IncludesNOEXEC`, so an account `.htaccess`
may set only those four `Options` tokens (and `None`): Apache refuses any other token whatever its
`+`/`-` sign, and `All` outright, and every URL below such a line answers **500 Internal Server
Error** with `.htaccess: Option FollowSymLinks not allowed here` in the domain error log. Sites
brought in by the Transfer Tool, a cpmove restore, an addon conversion or a backup restore are
checked on arrival: `Options +FollowSymLinks` (Drupal, Joomla) is rewritten to the equivalent
`SymLinksIfOwnerMatch` in the account's own files and lines carrying `All`, `ExecCGI` or
`Includes` are named in the run log and the step; the Security Advisor reports the same for
existing accounts. `FollowSymLinks` is never enabled (it lets a docroot walk into other accounts'
web-server-readable files).

#### 7.2 HST Panel Log Rotation Configuration

Log rotation policy. **Who:** root.
**Policy**: frequency, rotations to keep, *Rotate when larger than*, compress, delaycompress,
missingok, notifempty, dateext, *Reload Apache after rotating account/web logs*; **Managed
policies** (panel, accounts, web server: files under `/etc/logrotate.d/whm-*`, *Run* and
*Force-rotate*); a **Preview** of the rendered files. **Server:** `PUT /api/service-config/logrotate`
writes the three files; `POST …/logrotate/:name/run`. **Needs:** `logrotate`.

#### 7.3 HST Panel Web Disk Configuration

WebDAV service settings. **Who:** root.
*Enable Web Disk*, *Plain port* (2077), *SSL port* (2078), idle timeout, maximum upload, *Who
may use Web Disk*, **Security** (*Require SSL*, *Allow Digest authentication*, *Answer
unauthenticated OPTIONS/PROPFIND*). **Server:** settings only (`PUT /api/service-config/webdisk`).
**Gotchas:** the panel does not ship a WebDAV daemon yet; the values are stored for a service
that does not run — the page says so.

#### 7.4 HST Panel Web Services Configuration

Tuning for the panel's own HTTP services. **Who:** root.
**API** (JSON API on/off, token lifetime, browser session timeout, rate limit, max concurrent
requests, request-log retention, allowed cross-origin origins) and **Transport** (compression,
IPv6 listen, expose version). **Server:** settings only. **Gotchas:** **not wired to the running
panel** — the listeners are configured by `/etc/whm/panel.env` and the session policy lives in
*Security Center › Configure Security Policies*; this page records intent.

#### 7.5 Exim Configuration Manager

Server-wide mail-server policy. **Who:** root.
Tabs: **RBLs & verification** (reject hosts in IP RBLs, domain RBLs, SPF verify/reject, DKIM
verify/reject, require reverse DNS, verify sender, require HELO), **Limits & rate limiting**
(`smtp_accept_max`, per host, queue per connection, `smtp_ratelimit_*` thresholds and delays),
**Dictionary attack protection** (unknown commands before drop, failed recipients before drop,
delay, `recipients_max` and reject), **Other** (message size, *Only advertise SMTP AUTH over
TLS*, extra log selectors), plus previews of the main options block, the RCPT ACL chain and
the DATA ACL fragment. **Save and apply to Exim**. **Server:** `PUT /api/service-config/exim`
renders the managed files, validates (`exim -bV`), reloads. **Needs:** Exim. **Gotchas:** the
page warns when Exim does not include the panel's RCPT ACL chain — rejection rules are then not
in force until the include exists (the Email category's filters rely on the same chain).

#### 7.6 FTP Server Selection

Choose the FTP daemon. **Who:** root.
**FTP server** selector (Pure-FTPd, ProFTPD, vsftpd, or *disabled*; install as a job when not
present) and **Daemon settings**: passive port range, passive address (NAT), *TLS* (off /
optional / required; certificates from *Manage Service SSL Certificates*), max clients, per IP,
idle timeout, chroot, anonymous logins. **Server:** `PUT /api/service-config/ftp/server`
enables and starts the chosen unit and stops/disables the alternatives; `…/ftp/settings`
renders the daemon's config and reloads it. **Gotchas:** active FTP sessions drop on a switch;
anonymous logins are ignored by the ProFTPD renderer.

#### 7.7 Mailserver Configuration

Dovecot IMAP/POP3 settings. **Who:** root.
**Protocols** (IMAP, POP3, LMTP, …), **Connections** (per-user-per-IP, process and client
limits, IDLE notify interval), **SSL** (`ssl` required/yes/no, minimum TLS protocol, cipher
list, TLS 1.3 suites, prefer server order, disable plaintext auth), **Mailboxes**
(`mail_location`, format for new accounts, POP3 UIDL format, login greeting), preview of
`conf.d/97-whm-mailserver.conf`. **Server:** `PUT /api/service-config/mailserver` writes that
file through the agent, which validates it before reloading Dovecot. **Needs:** Dovecot. **Gotchas:** disabling IMAP asks
for confirmation; certificate paths are owned by *SSL/TLS* (`90-whm-ssl-cert.conf`), not here.

#### 7.8 Manage Service SSL Certificates

Certificates for Exim, Dovecot, FTP, Apache's default host and the panel. **Who:** root.
Table per service (paths under `/etc/ssl/whm/service/<service>/`, subject, expiry) with
**Install** (certificate, private key, optional chain — key stored 0600 and encrypted in the
panel DB) and **Reset to self-signed** (new certificate for the hostname, N days).
**Server:** `POST /api/service-config/service-certs/:service[/self-signed]`, wiring the paths
into each daemon and reloading it. **Needs:** `openssl`.

#### 7.9 Nameserver Selection

Choose the DNS server software and role. **Who:** root.
*Role* (master / slave / standalone) and the daemon selector (BIND or PowerDNS, install as a
job, or *disabled*). **Server:** `PUT /api/service-config/nameserver` enables/starts the chosen
unit and disables the other; zones stay in the panel database and are written for the active
daemon. **Gotchas:** after an install job finishes, select the daemon again to enable it.

#### 7.10 Service Manager

Enable, monitor, install and repair services. **Who:** root (resellers can view the list).
A **Server stack** card on top lists the stack catalog grouped into installed and missing components
with checkboxes, **Install selected** and the profile buttons **Install full hosting stack
(recommended)** / **Web + database only** (one job `stack.install` with a progress log; a second
install while one runs is refused). The table (service, unit or the candidate units looked for,
status, *Start at boot*, *Monitor*, *Auto-restart*) offers **Install** for a service that is not
installed, **Repair** next to *Start* for one that is installed but failed (`systemctl
reset-failed` → restart → status + the last 30 journal lines in the answer), **Restart**,
**Stop/Start** and a journal view. Everywhere else in the panel a *Service not installed* notice
offers root an **Install <service>** button for the same catalog entry (Apache, Exim, ModSecurity,
the statistics generators, …) and shows the job inline. **Server:** `GET /api/system/services`,
`GET /api/system/stack`, `POST /api/system/stack/install { profile | components }` (202),
`POST …/capabilities/:cap/install` (202, 404 when the catalog has no entry),
`POST …/services/:name/install` (202), `POST …/services/:name/repair`, `POST …/services/:name/:verb`,
`PATCH …/services/:name`; the installer refreshes the package index first, runs the catalog's
post-install steps (Apache modules, PostgreSQL `initdb` on RHEL, unit enable, Apache reload on
RHEL after mod_security/php-fpm) and refreshes the capability registry; the monitor loop restarts
failed monitored services and raises `service.down`/`service.restored`. **Needs:** `apt-get`,
`dnf` or `yum` for installs. **Gotchas:** the monitored set follows the *Server Profile*; RHEL
packages that need EPEL are flagged in the catalog (`requires`).

## 8. Locales

Routes under `/api/locales/*`. Viewing, keys and XML download are open to resellers; configuring,
editing, copying, deleting and uploading are **root only**.

#### 8.1 Configure Application Locales

Default and available interface languages. **Who:** root.
*Default locale* (always enabled), an enable toggle per installed locale, **Save**; a
browser-only *Interface language for this browser* preference (stored locally, enabled locales
only). **Server:** `PUT /api/locales/config`.

#### 8.2 Copy a Locale

Duplicate a locale to customise it. **Who:** root.
*Source locale*, *New locale code* (`es`, `de_at`, `pt_br`…), *Display name*; **Copy locale**.
**Server:** `POST /api/locales/:code/copy`. **Gotchas:** the copy is disabled until enabled under
Configure Application Locales; copy the built-in English locale to start a new translation.

#### 8.3 Delete a Locale

Remove a custom locale. **Who:** root.
Table of custom locales (code, name, state, translated progress, updated) with **Download XML
first** and **Delete**. **Server:** `DELETE /api/locales/:code`. **Gotchas:** the built-in
English locale and the current default cannot be deleted.

#### 8.4 Edit a Locale

Edit translated strings. **Who:** root.
Pick the locale and *Display name*; the **Strings** editor shows every key next to its English
source with tabs *All / Untranslated / Translated / Unsaved / Not in catalog*, search and
paging; clearing a field falls back to English. **Server:** `PUT /api/locales/:code` (reports
changed/cleared counts). **Gotchas:** the English catalog is read-only.

#### 8.5 Locale XML Download

Export a locale. **Who:** root, reseller.
Pick a locale, **Preview**, **Download `<code>.xml`** (every translated string as
`<string key=…>`). **Server:** `GET /api/locales/:code/xml`.

#### 8.6 Locale XML Upload

Import a locale. **Who:** root.
File (≤ 2 MB) or pasted XML, optional *Locale code* and *Display name* overrides, mode
**Merge** / **Replace** / **Create only**; **Validate** (dry run, nothing written) then
**Import**. **Server:** `POST /api/locales/xml` (`dryRun` first). **Gotchas:** the built-in
English locale cannot be overwritten.

#### 8.7 View Available Locales

All installed locales. **Who:** root, reseller.
Table (code, name, state pills, translated progress, source, updated) with per-row links
(edit/copy/download for root, download for resellers) and, for root, the **Operating system
locale** card (`LANG`/`LC_*` from the host). **Server:** `GET /api/locales`, `GET /api/locales/system`.

## 9. Backup

Routes under `/api/backup/*`. Configuration, destinations, user selection, run history,
rescans and imports are **root only**; listing backups of owned accounts, fetching, browsing
and restoring them is allowed to resellers.

#### 9.1 Backup Configuration

Schedule, retention, scope and destinations. **Who:** root.
**Status** (enabled, next run, accounts included, local directory, last run; **Run backup
now** as a job with a progress log). **Global settings**: *Enable scheduled backups*,
*Schedule* (presets or custom cron), *Strict mode* (any failed component fails the account),
*Skip suspended accounts*, *Notify contacts when a run fails*. **Retention**: daily / weekly /
monthly counts (a backup on the 1st is monthly, on a Sunday weekly, otherwise daily; 0 disables
a class), *Also delete pruned archives from destinations*. **What to back up**: home, mail,
databases (mysqldump per database, users and grants), DNS zone files, account metadata,
*Excluded paths*, compression level. **Local storage**: *Local backup directory* (must be under
`/backup`, `/var/backups/whm`, `/var/lib/whm` or a home root; created 0700), *Keep the local copy
after a successful upload*, *New accounts are included by default*. **Additional destinations**:
Local directory, FTP/FTPS, SFTP (password or private key, host key pin), WebDAV, S3-compatible
(AWS, Backblaze B2, MinIO, Wasabi — single signed PUT with Signature V4); credentials encrypted;
**Test** before and after saving, **Enable/Disable**, **Delete**. **Recent runs** table.
**Server:** `PUT /api/backup/config`, `/destinations*`, `POST /api/backup/runs` (202). Archives
use the cPanel layout (`homedir/`, `mysql/`, `dnszones/`, `cp/`). **Needs:** `tar` and `gzip`
(a capability banner otherwise); `mysqldump` for databases. **Gotchas:** archives are always
written locally first, then copied to every enabled destination; deleting a destination does
not delete what is already uploaded there.

**Cloud storage card** (design and per-provider setup steps: `docs/design/backup-cloud.md`). Provider
cards for **Google Drive**, **Microsoft OneDrive**, **Dropbox**, **Amazon S3 / S3-compatible**
(Wasabi, MinIO, R2, Spaces), **Azure Blob Storage** (account key or SAS token) and **Backblaze B2**;
the existing local/FTP/SFTP/WebDAV kinds stay. Everything goes through **rclone** (capability
`rclone`; the card shows the install prompt until it exists). Google Drive, OneDrive and Dropbox sign
in with the provider's own consent screen: **register an OAuth client once** per provider (*Client
ID*, *Client secret*, from the Google Cloud console / Microsoft Entra app registration / Dropbox App
Console) with the redirect URI the card shows,
`https://<hostname>:2087/api/backup/destinations/oauth/<provider>/callback`, and open the panel at
that hostname when connecting. Adding a destination is three stages: the form (type, folder / bucket
/ container, credentials, *Encrypt archives at rest (recommended)* — on by default for every kind but
a plain local copy), then the **one-time encryption key** (password + salt, **Download key file**: it
is shown once, never again, and is what reads the archives outside the panel with `rclone config`),
then **Connect** (OAuth kinds) or the usual **Test**. Columns *Encryption*, *Connection* (**Connect /
Reconnect**; *sign-in expired* when a Google/Microsoft/Dropbox grant was revoked) and *Last upload*.
Encrypted destinations use an rclone `crypt` layer — file names and contents are ciphertext at the
provider — and **encryption cannot be switched off once enabled**; a destination from before this
feature keeps working unchanged and gets **Enable encryption** (new uploads only; older copies stay
readable through the plain path). Pruned copies are deleted outright (Drive trash and B2 hidden
versions are bypassed). **Server:** `GET /api/backup/destinations/providers`,
`PUT /api/backup/destinations/oauth-apps/:provider`, `GET …/destinations/oauth/:provider/start`,
`POST …/destinations/:id/encryption`. **Needs:** `rclone` (EPEL on the RHEL family). **Gotchas:** a
Google consent screen left in *Testing* issues tokens that expire after 7 days — publish it; the
redirect URI must match the hostname exactly.

#### 9.2 Backup Restoration

Restore a full account backup. **Who:** root; reseller for owned accounts.
**1. Choose the account and the backup date** (fetch a remote-only archive first, as a job).
**2. What to restore**: *Home directory and mail*, *Overwrite files that exist*, *Databases,
users and grants*, *DNS zones* (loaded into BIND or saved for later), *Mail routing*, *Recreate
the account if it was terminated* (Linux user, home, package, vhost). **Restore account** asks
you to type the account name. **Import an archive** registers a hand-copied cPanel/WHM archive
(`/backup/cpmove-user.tar.gz`, under the backup directory or `/var/backups/whm`). **Copies on
destinations** lists the archives a destination holds for the account (encrypted and plain copies
alike) with **Import**: the copy is downloaded and decrypted, verified against its checksum and
registered as a pinned import you can then restore (job `backup.cloud.fetch`). **Restore
history** shows each restore with its step outcomes. **Server:**
`POST /api/backup/backups/:id/restore { kind: 'account' }` (job), `POST /api/backup/archives/import`,
`GET /api/backup/destinations/:id/archives`, `POST …/destinations/:id/archives/import` (202).
**Gotchas:** database grants are replayed only for databases the account owns; untrusted
archives never recreate device nodes. Restored files are checked for `.htaccess` `Options`
lines the account vhost refuses (7.1): `FollowSymLinks` is rewritten to `SymLinksIfOwnerMatch`
in the account's own files, anything else (`All`, `ExecCGI`, `Includes`) is named in the restore
log and the `files` step, because such a site answers 500 until the line is changed.

#### 9.3 Backup User Selection

Include or exclude accounts. **Who:** root.
*Include accounts that have no explicit setting* (the default), filter *All / Included /
Excluded*, searchable table (account, owner, backups state with a *default* pill, last backup)
with per-row **Include/Exclude** and bulk **Include selected / Exclude selected**. **Server:**
`PUT /api/backup/selection`, `PUT /api/backup/config { 'backup.default_include' }`.

#### 9.4 File and Directory Restoration

Restore individual files. **Who:** root; reseller for owned accounts.
Choose account and date, browse the archive (breadcrumbs, filter, checkboxes; directories
restore recursively), *Overwrite existing files* (off keeps files already present), **Restore
N selected** (job), **Recent file restores**. **Server:** `GET /api/backup/backups/:id/browse`,
`POST …/restore { kind: 'files', options: { paths, overwrite } }`; files are written into the
home with the account's ownership.

## 10. Clusters

Routes under `/api/clusters/*`; **root only**. Peers authenticate to each other with cluster
tokens that carry a purpose (`clustering:dns` or `clustering:config`) and are confined to
those endpoints.

#### 10.1 Configuration Cluster

Share configuration with peer servers. **Who:** root.
**Peers** (shared with DNS Cluster: name, address — port 2087 assumed, token, DNS role,
*Configuration cluster* flag, *Verify TLS*, *Enabled*; **Test**), **Tokens for remote panels
(settings)** (issue — shown once — and revoke), **Shared settings** (tick the setting groups
that travel; only the keys listed per group are ever sent or accepted — host identity,
addresses and daemon selection never are; *Push automatically* every six hours; *Accept
settings pushed by peers*, off by default), **Push to peers** (job; each peer validates every
value and applies it through the module that owns it), **Pull from a peer** (preview the
differences, then apply), and the **Exchange log**. **Server:** `/api/clusters/config/*`,
`/peers`, `/tokens`. **Gotchas:** inbound pushes are opt-in on the receiver and honour its own
group selection; values applied where the daemon is missing are reported as *stored, daemon
missing*.

#### 10.2 DNS Cluster

Replicate DNS zones to other nameservers. **Who:** root.
Peers with a DNS role — **Write-only** (receives zones), **Sync** (receives, may push back),
**Standalone** (linked, never synchronised) —, **Tokens for remote panels (zones)**, **Zone
status per peer** (serial sent vs current, stale/failed, last push), **Push zones now** (all or
listed zones to one or every peer; job), settings *Push changed zones automatically*, *Accept
zones pushed by peers*, *Verify peer TLS certificates*. **Server:** `/api/clusters/dns/*`; the
hourly run re-sends stale zones. **Needs:** the DNS Functions module; BIND is optional on the
pushing server (zones live in the panel database and are pushed regardless). **Gotchas:**
revoking a token cuts the peer off immediately.

## 11. System Reboot

Routes under `/api/system-reboot/*`; **root only**.

#### 11.1 Forceful Server Reboot

Reboot immediately. **Who:** root.
Preflight card (reboot required by updates, running and queued jobs, systemctl present, last
panel reboot), *Reason* (audited), **Forceful Reboot** with a danger confirmation; after the
request the page polls `/api/health` and offers *Reload the panel* when the server is back.
**Server:** `POST /api/system-reboot/forceful` → `systemctl reboot --force` through the agent;
the request is recorded with the boot id so *completed* can be verified later. **Gotchas:**
unsaved data in running services may be lost; use only when a graceful reboot hangs.

#### 11.2 Graceful Server Reboot

Stop services cleanly, then reboot. **Who:** root.
Same page as above with **Graceful Reboot** → `systemctl reboot` (systemd stops services in
dependency order). **Needs:** `systemctl`. **Gotchas:** running jobs are marked failed when the
panel restarts, queued jobs resume after boot; transfers and backups must be started again.

## 12. Server Status

Routes under `/api/server-status/*` and `/api/system/*`. Apache status, the process log and
server information are **root only**; service status and the job list are visible to resellers.

#### 12.1 Apache Status

Live web server worker status. **Who:** root.
Stats (running, requests/s, throughput, busy/idle workers, uptime), **Worker scoreboard**,
**mod_status counters**, a **Workers** table (slot, PID, mode, CPU, SS, request time, client,
protocol, vhost, request; *busy only* filter; live refresh every 10 s), and **Enable in Apache
Configuration** when `mod_status` is not reachable. **Server:** `GET /api/server-status/apache[/workers]`
reads `http://localhost/server-status?auto`; `POST …/apache/enable-status` writes the include.
**Needs:** Apache with `mod_status` on localhost; `ExtendedStatus On` for per-request counters.

#### 12.2 Daily Process Log

Resource usage by process over time. **Who:** root.
A sampler records the top N processes by CPU and memory every 5 minutes
(`process-log-sampler` schedule). Pick a *Day* (UTC) and optionally a *User*; charts for CPU %,
memory % and load; tables **By program**, **By user** (CPU share), **Samples** (open one to see
its processes); **Sample now** (job), **Delete this day's log**; **Sampler** settings (*Record
processes every 5 minutes*, *Processes per sample*, *Retention (days)*). **Server:**
`/api/server-status/process-log/*`. **Gotchas:** lowering retention deletes older days
immediately (confirmed first); CPU % is `ps`'s lifetime average per process.

#### 12.3 Server Information

Hardware, OS, memory and disk details. **Who:** root.
Load averages, uptime, memory and swap meters, **System** (hostname, OS, kernel, CPU, panel),
**Memory**, **Disks**, **Network interfaces**; refreshes every 20 s. **Server:** `GET /api/system/info`
(reads `/proc`, `df`, interfaces through the agent).

#### 12.4 Service Status

Up/down state of monitored services. **Who:** root, reseller (view); actions root.
Table (service, unit, status Up/Down/Not installed, PID, memory, restarts, started) with
**Restart**, **Stop** (confirmed) / **Start**; refreshes every 15 s. **Server:**
`GET /api/system/services`, `POST /api/system/services/:name/:verb` → `systemctl`.

#### 12.5 Task Queue Monitor

Background jobs and their progress. **Who:** root, reseller (view; cancel is root).
Table of the last 200 jobs (id, type, status, progress bar, message/error, queued, finished)
refreshing every 5 s; **View log** opens the live progress log; **Cancel** for queued jobs.
**Server:** `GET /api/system/jobs`, `GET /api/system/jobs/:id/stream` (SSE), `POST …/cancel`.

## 13. Account Information

Routes under `/api/account-info/*` and `/api/accounts`. Lists are scoped to owned accounts
for resellers; the quota refresh, bandwidth collection and settings, and enhancement
definitions are **root only**.

#### 13.1 List Accounts

Search, inspect and act on hosting accounts. **Who:** root, reseller (own accounts).
Searchable, sortable table (domain, user, owner, package, IP, disk used/quota, contact,
created, status) with row actions **Modify**, **Suspend/Unsuspend**, **Change password**,
**Upgrade/Downgrade**, **Bandwidth usage**, **Enhancements**, **Terminate** (confirmed).
**Server:** `GET /api/accounts?page&pageSize&q&sort&dir`; actions call the account routes with
the ACL checks listed under Account Functions.

#### 13.2 List Parked Domains

Parked (alias) domains. **Who:** root, reseller (own).
Table of alias domains with the account, the domain they point at and the shared document
root; link to *Park a Domain*. **Server:** `GET /api/account-info/domains?type=parked`.

#### 13.3 List Subdomains

All subdomains. **Who:** root, reseller (own).
Same table for `type=sub` (root domain and document root).

#### 13.4 List Suspended Accounts

Accounts currently suspended. **Who:** root, reseller (own).
The List Accounts table filtered with `suspended=true`; the same row actions apply
(**Unsuspend** restores logins and web sites).

#### 13.5 Manage Account Enhancements

Add-on entitlements per account. **Who:** root defines enhancements; root and resellers
(ACL `upgrade-account`) assign them to owned accounts.
**Enhancements** table (name, id, limit chips, assigned count, enabled, created) with
**Edit**, **Enable/Disable**, **Delete**; **Create enhancement** (*Name*, *ID* slug,
*Description*, *Enabled*, **Limits** rows — key, type number/boolean/text, value; numbers
merge by the highest value across an account's enhancements, booleans OR). **Assign to an
account**: pick the account (`?username=` deep link), tick enhancements, **Save assignments**;
*Effective extra limits* shows the merged result. **Server:** `/api/account-info/enhancements*`,
`PUT /api/account-info/accounts/:username/enhancements`. **Gotchas:** package limits are not
affected by deleting an enhancement.

#### 13.6 Show Accounts Over Quota

Accounts exceeding disk quota. **Who:** root; reseller (own).
Tabs *Over quota / Near quota / All*, stats (usage source `repquota` or `du` scan, warn
threshold, last measured), **Refresh disk usage** (job; root), table (account, domain, owner,
package, used, quota, usage meter, status, measured) with **Change quota**, **Modify account**,
**Suspend** for over-quota accounts; root can open the raw **System quota report**. **Server:**
`GET /api/account-info/quota`, `POST …/quota/refresh` (202), `GET …/quota/report`. **Gotchas:**
without the quota tools usage is measured by the `account-disk-usage` schedule and limits are
advisory.

#### 13.7 View Bandwidth Usage

Bandwidth consumption per account. **Who:** root; reseller (own; reset needs ACL
`limit-bandwidth`).
Tabs *All / Near limit / Over limit*, period selector (month), stats (total, over-limit count
and whether enforcement suspends, warn threshold, last collection), **Collect now** (job; root),
table (account, domain, owner, transferred, limit, usage, status) with **History** (12-month
table with per-month reset), **Change limit**, **Reset this month**. **Bandwidth collection**
settings (root): *Warn at (% of limit)*, *Max bytes read per log file per run*, *Extra log
directories* (e.g. an NGINX log root inside the agent's allowed paths). **Server:**
`GET /api/account-info/bandwidth[/:username]`, `POST …/bandwidth/collect` (202),
`POST …/bandwidth/:username/reset`. Collection parses `/var/log/whm/domlogs/<user>/*-access.log`
hourly (`account-bandwidth` schedule) while a web server is installed. **Gotchas:** resetting
the month also unsuspends an account suspended for bandwidth.

## 14. Account Functions

Routes under `/api/accounts/*` and `/api/account-functions/*`. Resellers act on owned
accounts and need the ACL named in each block; *Rearrange an Account*, *Web Template Editor*
and the bandwidth-enforcement switch are **root only**.

#### 14.1 Change Site's IP Address

Move a site to a different IP. **Who:** root; reseller (own; the address must be its shared or
a delegated IP).
Pick the account; *New IP address* (root chooses from the IP Functions list, a free address
becomes dedicated to the account; resellers type one), confirm. **Server:**
`PUT /api/account-functions/ip/:username` updates the account record, rewrites the vhosts
through `ctx.web.replaceIp` and changes every A record that pointed at the old address in the
account's zones; the result card lists each step. **Needs:** Apache/BIND for the respective
steps (a missing daemon leaves that step pending, not failed).

#### 14.2 Create a New Account

Provision a hosting account. **Who:** root, reseller (ACL `create-acct`, within its limits and
package list).
**Domain information** (*Domain*, *Username* — lowercase, starts with a letter, ≤ 32 —,
*Password* (blank = set later), *Contact email*), **Package** (*Package*, *Dedicated IP
address*, *Owner* for root), **Account manager** (who answers the account's support thread in
*Support › Account Conversations*: defaults to the creator; root may name any root or reseller
user, a reseller may name itself or a root user; also on *Modify an Account*), **Provisioning** toggles (*Web server virtual host*, *DNS zone*
from the standard template with the server nameservers, *Local mail routing*). The result card
shows the state of each provisioning step. **Server:** `POST /api/accounts` creates the Linux
user and home tree through the agent, then runs each enabled step through its category
(`ctx.web.ensureVhost`, `ctx.dns.ensureZoneForDomain`, `ctx.mail.setRouting`, database
bootstrap) with compensation on failure; license capacity (`max_accounts`) and reseller limits
are checked first. **Gotchas:** a step whose daemon is missing stays *pending* until the
service is installed (then *Sync vhosts* / zone creation catches up); the default PHP version
comes from the package or `php.default_version`.

#### 14.3 Email All Users

Broadcast a message to all account owners. **Who:** root, reseller (own accounts).
*Which accounts* (all / active / suspended), *Owned by* (root), *From address*, *Subject*,
*Body* with `{{username}}`, `{{domain}}`, `{{hostname}}`; **Send** runs as a job with a
delivery log. **Server:** `POST /api/account-functions/email` (202). **Needs:** a mail transport.

#### 14.4 Force Password Change

Require accounts to change their password. **Who:** root, reseller (ACL `edit-account`).
Bulk flag page: account table with the *Change required* column, **Require change / Clear
requirement** per row, for the selection, or *for all*. **Server:**
`POST /api/account-functions/force-password-change`. **Gotchas:** the flag clears when the
password is changed (Password Modification); since account owners have no panel login in this
version, the flag matters for future user logins and for the record.

#### 14.5 Limit Bandwidth Usage

Set a bandwidth cap. **Who:** root, reseller (ACL `limit-bandwidth`); the enforcement switch
is root only.
Pick the account; *Unlimited bandwidth* or *Monthly limit (MB)*; **Enforcement** card
(*Suspend accounts that exceed their limit* — checked hourly); an **All accounts** table with
used/limit/usage. **Server:** `PUT /api/account-functions/bandwidth/:username`,
`PUT /api/account-functions/bandwidth-enforcement`. **Gotchas:** usage comes from the web logs;
with enforcement on, an account over its cap is suspended with a bandwidth reason and freed by
*Unsuspend Bandwidth Exceeders* or the monthly reset.

#### 14.6 Manage Account Suspension

Suspend or unsuspend with a reason. **Who:** root, reseller (ACL `suspend-acct`).
Pick the account; *Reason (shown to the account owner)*; **Suspend account** (confirmed) /
**Unsuspend account**. **Server:** `POST /api/accounts/:username/suspend|unsuspend` locks or
unlocks the Linux account (blocks SSH, FTP and mailbox logins) and asks Service Configuration
(`ctx.web.setSuspended`) to switch the sites to the suspended page or back. **Gotchas:** the
toast tells you when the web step could not be applied (no web hook or daemon) — logins are
still locked.

#### 14.7 Manage Demo Mode

Restrict accounts to read-only demo mode. **Who:** root, reseller (ACL `demo-setup`).
Bulk flag page (**Enable demo mode / Disable demo mode**). **Server:**
`POST /api/account-functions/demo-mode`. **Gotchas:** demo mode is a recorded account attribute
for the (future) account login; it changes nothing on the host.

#### 14.8 Manage Shell Access

Normal, jailed or no shell. **Who:** root, reseller (ACL `add-pkg-shell`).
Choose the shell to apply — *Disabled* (`/usr/sbin/nologin`), *Jailed shell*
(`/usr/local/bin/jailshell`, must exist), *Normal shell* (`/bin/bash`), *POSIX shell*
(`/bin/sh`) — then apply to a row or to the selection; the table shows the current shell and
whether the Linux user exists. **Server:** `PUT /api/account-functions/shell/:username` →
`usermod -s` through the agent. **Gotchas:** FTP and the panel keep working with no shell.

#### 14.9 Modify an Account

Change domain, owner, package and limits. **Who:** root, reseller (ACL `edit-account`;
owner change root only).
Pick the account; **Basic information** (*Contact email*, *Package* — re-applies its limits —,
*IP address*, *Owner*), **Resource limits** (*Disk quota (MB)*, *Monthly bandwidth limit (MB)*,
*Shell access*), **Privileges** (*Demo mode*, *Force password change*). **Server:**
`PATCH /api/accounts/:username`; quota and shell changes are applied to the Linux user.
**Gotchas:** the primary domain is not renamed here; blank limits mean unlimited.

**Domains panel** (below the account summary; design `docs/design/domains.md`). Every name the account
answers for — *main*, *addon*, *sub*, *parked* — with its document root, SSL, zone and vhost state,
and the package limits in use (addon / sub / parked, binding for resellers). **Add domain**: *Domain*,
*Type* (addon, sub-domain or parked), optional *Document root* (inside the home; defaults
`public_html/<domain>` for an addon, `public_html/<label>` for a sub-domain) and *Issue an AutoSSL
certificate when the name already resolves here*. The result shows one line per step — **docroot**
(created as the account, `0750 user:<web group>`, with the branded `index` page from the Web Template
Editor when the directory had none), **web** (vhost), **dns** (own zone for an addon, an `A` record in
the containing zone for a sub-domain, parked through the DNS parking rule), **mail** (local routing)
and **ssl** (issued only when the name already points at this server; otherwise *skipped* and picked
up by the daily AutoSSL run) — as *applied*, *pending* (daemon absent, written at the next sync),
*skipped* or *failed*. **Remove** (modal) optionally *also deletes the document root* (addon/sub only,
never a directory another domain of the account lives in). **Who:** root, reseller for owned accounts
(ACL `edit-account`): a reseller cannot claim a label under the server hostname, a name whose nearest
hosting account is not this one, or a name whose DNS zone belongs to another account (403). **Server:**
`GET/POST /api/account-functions/domains/:username`, `DELETE …/domains/:username/:domain?deleteFiles=true`.
**Gotchas:** `www.` names are refused (every vhost already answers for its `www.` alias); the hostname
and `www.<hostname>` are never claimable; restores never re-render the index page.

#### 14.10 Password Modification

Set an account's password. **Who:** root, reseller (ACL `passwd`).
Pick the account; *New password* (strength meter and generator). **Server:**
`POST /api/accounts/:username/password` → the Linux password through the agent (SSH/FTP and the
account's panel login); clears a pending force-change flag. **Gotchas:** must meet
`security.min_password_strength` / the `account` context override.

#### 14.11 Quota Modification

Change disk quota. **Who:** root, reseller (ACL `quota`).
Pick the account; *Unlimited disk space* or *Disk quota (MB)*; a **Quota report** table shows
live `repquota` figures next to the panel's record. **Server:**
`PUT /api/account-functions/quota/:username` → `setquota` (soft = quota, hard = +5 %) on the
filesystem holding the home. **Needs:** quota tools and an enabled filesystem (otherwise the
value is recorded and a 501 warning explains that it is not enforced).

#### 14.12 Raw Apache Log Download

Download raw web access logs. **Who:** root, reseller (own).
Pick the account; table of files (name, directory, size, last written) from
`/var/log/whm/domlogs/<user>` plus PHP-FPM logs, each with **Download**. **Server:**
`GET /api/account-functions/logs/apache/:username[/download?file=]`.

#### 14.13 Raw NGINX Log Download

Download raw NGINX logs. **Who:** root, reseller (own).
Same page for NGINX logs mentioning the account's domains under `/var/log/nginx` and any nginx
log in the account's home. **Gotchas:** empty until an NGINX vhost for the account has served
traffic.

#### 14.14 Rearrange an Account

Move an account's home to another partition. **Who:** root.
**Home partitions** table (`/home`, `/home2`, …: present, filesystem, free, used, accounts);
pick the account and *Move to* (only existing partitions); **Move account** runs as a job with
a progress log. **Server:** `POST /api/account-functions/rearrange/:username`: the account is
suspended for the duration, `rsync -a` copies the home, `usermod -d` points the user at the new
path and the vhosts are rewritten, then the old tree is removed and the account unsuspended; a
failure rolls back (home pointer restored) and unsuspends. **Needs:** `rsync`. **Gotchas:**
a per-account lock prevents two moves at once; create the target directory on the server first.

#### 14.15 Reset Account Bandwidth Limit

Clear bandwidth counters. **Who:** root, reseller (ACL `limit-bandwidth`).
Table with used/limit/status, *Unsuspend bandwidth-suspended accounts* toggle, **Reset
selected** / **Reset all**. **Server:** `POST /api/account-functions/bandwidth/reset`. The
scheduler resets every account on the 1st of each month.

#### 14.16 Terminate Accounts

Permanently remove accounts. **Who:** root, reseller (ACL `kill-acct`).
Searchable table with multi-select, *Keep DNS zones* toggle, **Terminate selected** (type the
username, or `TERMINATE` for several). **Server:** `DELETE /api/accounts/:username?keepDns=`
removes the account's SSL certificates, the vhosts, the account's databases and users, switches
mail routing to remote and removes DKIM keys, deletes the zones (unless kept), deletes the Linux
user and home tree, then the panel records. **Gotchas:** irreversible unless a backup exists — *Backup Restoration* can
recreate a terminated account from its archive.

#### 14.17 Unsuspend Bandwidth Exceeders

Bulk unsuspend accounts over bandwidth. **Who:** root, reseller (ACL `limit-bandwidth`).
Table of accounts over their monthly limit or suspended for it; *Also reset counters*;
**Unsuspend selected / Unsuspend all**. **Server:**
`POST /api/account-functions/bandwidth/unsuspend-exceeders`. **Gotchas:** without resetting the
counter, hourly enforcement suspends the account again.

#### 14.18 Upgrade/Downgrade an Account

Change an account's package. **Who:** root, reseller (ACL `upgrade-account`; its allowed
packages).
Pick the account; *New package*; **Upgrade/Downgrade**. **Server:**
`PATCH /api/accounts/:username { package }` re-applies the package limits (disk, bandwidth,
shell, PHP version).

#### 14.19 Web Log Retention

How long to keep web logs. **Who:** root, reseller (own).
Table (account, archive on/off, keep months, last archived, source account/server default)
with **Edit** (*Archive logs in the home directory* — monthly into `~/logs/archive` —,
*Remove old archives*, *Keep archives for (months)*) and **Archive now** (job, one account or
all). **Server:** `/api/account-functions/log-retention*`. **Gotchas:** rotation of the live
logs is *HST Panel Log Rotation Configuration*; this page only governs the per-account archives.

#### 14.20 Web Template Editor

Default and error page templates. **Who:** root.
Pick a page — *Default site page (new accounts)*, *Server hostname landing page*, *Suspended
account page*, *Site moved page*, *4xx error page* — edit the HTML (variables are HTML-escaped:
`{{company_name}}`, `{{tagline}}`, `{{logo_url}}`, `{{panel_url}}`, `{{domain}}`, `{{hostname}}`),
**Preview** (sandboxed iframe with sample values), **Save**, **Reset to default**. The stock
`index` and `landing` pages are the branded "Ready to launch" page with the company name, tagline
and logo from *HST Panel › Customization*. **Server:** `/api/account-functions/templates/:name`
under `/etc/whm/templates`; saving or resetting `landing` re-renders the hostname page at once (the
answer carries `rendered`). **Gotchas:** the default site page is written into `public_html` of
new accounts and the landing page is served for the hostname; the other templates are saved for
the web server configuration that will reference them, and the page says when a template is
"saved in the panel only".

## 15. Multi Account Functions

Routes under `/api/multi-account/*`. Runs are capped at `multi_account.max_batch` accounts
(500) and leave a per-account report (CSV/JSON).

#### 15.1 Change Multiple Sites' IP Addresses

Bulk IP changes. **Who:** root.
Three steps: **Select accounts and addresses** (filter by search, owner, package, IP, status;
*Address for every selected account* or a per-account choice from the IP Functions list;
options *Rewrite virtual hosts*, *Rewrite A records*, *Require installed services*),
**Review plan** (per account: current, new, *becomes dedicated*, A-record and vhost counts,
problems), **Run** (job with progress log, then the per-account outcome with step details).
**Recent runs** with **CSV/JSON report**. **Server:** `POST /api/multi-account/ip/preview`,
`POST /api/multi-account/ip` (202) → `ctx.web.replaceIp` and zone updates per account.
**Gotchas:** IPv4 only (IPv6 is assigned under IP Functions); with *Require installed
services* off, a missing daemon leaves the step pending instead of refusing the run.

#### 15.2 Modify/Upgrade Multiple Accounts

Bulk package and limit changes. **Who:** root, reseller (ACL `list-accts`; `demo-setup` for
demo mode, `add-pkg-shell` for shells or packages that grant one; owner change root only).
**Select accounts and changes**: tick the fields to change — *Package* (limits, shell and PHP
version follow), *Disk quota*, *Bandwidth limit*, *Shell*, *Contact email*, *Demo mode*,
*Force password change*, *Owner* — with *Apply the package's PHP version to the virtual hosts*
and *Require installed services*; **Review differences** (per account, what changes and what
is blocked); **Run** (job, outcome table, reports). **Server:**
`POST /api/multi-account/modify/preview`, `POST /api/multi-account/modify` (202); limits are
applied to the Linux user (quota, shell) and PHP-FPM pools where a package names a version.

---

The manual continues with categories 16–31 and the appendices in [MANUAL-partB.md](MANUAL-partB.md).
