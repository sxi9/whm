# Part B — Categories 16–30 and appendices

This is the second half of the WHM User Manual. Part A (getting around, conventions and categories 1–15)
is [MANUAL.md](MANUAL.md); installation is covered in [INSTALL.md](INSTALL.md).

## Contents of Part B

- [16. Transfers](#16-transfers)
- [17. Themes](#17-themes)
- [18. Packages](#18-packages)
- [19. DNS Functions](#19-dns-functions)
- [20. Database Services](#20-database-services)
- [21. IP Functions](#21-ip-functions)
- [22. Software](#22-software)
- [23. Email](#23-email)
- [24. System Health](#24-system-health)
- [25. HST Panel](#25-hst-panel)
- [26. SSL/TLS](#26-ssltls)
- [27. Market](#27-market)
- [28. Restart Services](#28-restart-services)
- [29. Development](#29-development)
- [30. Plugins](#30-plugins)
- [31. Application Manager](#31-application-manager)
- [Appendix A. Licensing from the panel](#appendix-a-licensing-from-the-panel)
- [Appendix B. Plugins and the Marketplace](#appendix-b-plugins-and-the-marketplace)
- [Appendix C. For plugin developers](#appendix-c-for-plugin-developers)
- [Appendix D. Hub portals](#appendix-d-hub-portals)
- [Appendix E. Troubleshooting](#appendix-e-troubleshooting)

Conventions in this part are the same as in Part A. **Who** names the role the route accepts: *root* means
`requireRoot`; *root or reseller* means `requireReseller`, where the service re-checks that a reseller only
touches accounts, domains or packages it owns. **Server** describes what the panel does through the root
agent (`whm-agentd`) and in its own SQLite database. **Needs** names the capability the page probes; when
the binary is absent the API answers `501 capability_missing` and the page shows an install prompt instead of
failing (see [Appendix E](#appendix-e-troubleshooting)). Long operations answer `202 { job }` and stream their
log on the page and in *Server Status › Task Queue Monitor*. Function names, descriptions and URL paths come
from [`client/src/nav.js`](../client/src/nav.js); the API prefixes from
[`server/src/routes/categories/`](../server/src/routes/categories/).

---

## 16. Transfers

Sidebar category 16. API prefix `/api/transfers`. The whole category is **feature-gated**: on an enforcing
panel the license must carry the `transfers` flag (Pro edition and above, [Appendix A.6](#a6-edition-limits-and-feature-gates)),
otherwise every request answers `403 feature_required`. Capabilities registered here: `ssh` (`ssh`, `scp`,
`ssh-keyscan`) and `sshpass`; `rsync`, `tar` and `mysql` are checked before a run starts. A weekly schedule
`transfers-cleanup` (Mondays 04:40) removes expired sessions and stale staging files.

#### 16.1 Convert Addon Domain to Account

- **Purpose:** promote an addon domain of an existing account into a hosting account of its own.
- **Who:** root or reseller (only addon domains of accounts the reseller owns are listed).
- **Screen:** *Addon domains* table (domain, owning account); *Plan* form: new username, package, password,
  contact e-mail, and the options *Copy the document root*, *Delete the files from the old account
  afterwards* (`removeSource`), *Move mailboxes of the domain*, *Move databases to the new account* (a list of
  database names). *Preview* shows the plan; *Convert* starts it.
- **Server:** `POST /convert-addon/preview` computes the steps; `POST /convert-addon` answers `202` with a
  job of type `transfer.convert_addon`. The job creates the account through `ctx.accounts.create`, copies the
  document root with the agent, moves the selected databases (re-assigned with grants limited to the new
  account), moves mail and routing, and writes a run record visible in *Review Transfers and Restores*.
- **Needs:** the hosting subsystems involved; a missing daemon leaves that step `pending` instead of failing
  the whole conversion.
- **Gotchas:** `removeSource` deletes the files from the old account after the copy succeeded; keep it off for
  a first run. Database names must be ones the source account owns.

#### 16.2 Review Transfers and Restores

- **Purpose:** history and logs of every transfer, restore and conversion.
- **Who:** root or reseller (resellers see runs for their own accounts).
- **Screen:** *Transfers and restores* table with filters *Kind* (`transfer`, `restore`, `convert_addon`) and
  *Status*; opening a run shows the per-account items (`queued`, `running`, `done`, `pending`, `failed`,
  `skipped`) and the job log. *Job queue entries* lists every `transfer.*` and `restore.*` job, including
  restores started from other tools (the Backup category hands its restores to this service).
- **Server:** `GET /runs`, `GET /runs/:id`, `GET /jobs`, `GET /jobs/:id` read the panel database only.

#### 16.3 Transfer or Restore an HST Panel Account

- **Purpose:** import an account from a `cpmove-<user>.tar.gz` or a full cPanel backup archive.
- **Who:** root.
- **Screen:** *Archives on this server* (archives already in the staging directory, with *Inspect*); *Upload an
  archive* (browser upload, sent in chunks and resumed automatically after a hiccup); *Or enter the path of an
  archive*; *Restore as* (username, main domain, package, new password) and the options skip home, skip
  databases, skip DNS, overwrite an existing account. *Restore account* starts the job.
- **Server:** uploads go through `POST /uploads` (filename must end in `.tar.gz`, `.tgz` or `.tar`;
  declared size up to 500 GB), `PUT /uploads/:id/chunks` (base64 chunks of 1,310,720 bytes) and
  `POST /uploads/:id/finish`; files land in the staging directory (`transfers.staging_dir`, default
  `/var/lib/whm/transfers`). `POST /archives/inspect` has the agent list the archive. `POST /restore` answers
  `202` with a `restore.cpmove` job that unpacks as root with device nodes never recreated, creates the account,
  restores the home directory, imports database dumps **only after the agent scanned them** into databases named
  after the local account, rebuilds database users from the parsed grants limited to that account, restores the
  DNS zone through `ctx.dns` and sets mail routing.
- **Needs:** `tar`; `mysql` for database import; BIND and Exim for the DNS and mail steps (otherwise those
  items stay `pending`).
- **Gotchas:** a path entered by hand must be absolute and under an allowed root; anything else is refused with
  `403 path_not_allowed`. Leaving the password empty keeps the password hash found in the archive.

#### 16.4 Transfer Tool

- **Purpose:** migrate many accounts from another cPanel/WHM server over SSH.
- **Who:** root.
- **Screen:** *Connect to the source server* (remote server, SSH port 22, SSH user `root`, authentication
  *password* or *private key*); *Open connections* (reusable sessions with their expiry); *Select accounts*
  (the remote account list, refreshable, up to 200 per run) with per-account overrides for the new username,
  domain, package and password ("leave empty to copy the password hash from the source, needs root there");
  *Options* (skip home, skip databases, skip DNS, overwrite); *Plan* preview; *Start transfer*; *Forget* drops a
  connection.
- **Server:** `POST /sessions` probes the host over SSH and stores the credential encrypted
  (`lib/crypto.js`); sessions expire `transfers.session_ttl_hours` (default 24) after last use.
  `GET /sessions/:id/accounts` reads the remote account list (cached, `?refresh=true` re-reads).
  `POST /transfer/preview` and `POST /transfer` (`202`, job `transfer.remote`): per account, the job copies the
  home directory with `rsync`, dumps databases on the source and imports them as in 16.3, recreates the zone and
  routing, and records a run.
- **Needs:** `ssh` (and `sshpass` for password logins; the API says so with a `501` and the package name —
  connect with a private key instead), `rsync`, `tar`, `mysql`.
- **Gotchas:** private keys are limited to 16 KB and must be unencrypted; passwords must be a single line. A
  remote server without root access cannot hand over password hashes, so set passwords explicitly.

---

## 17. Themes

Sidebar category 17. API prefix `/api/themes`.

#### 17.1 Theme Manager

- **Purpose:** the panel's interface themes: which one is the default, which one new accounts get, per-user
  overrides, custom themes built from design tokens and CSS.
- **Who:** root manages themes and defaults; root or reseller lists themes and assigns a theme to packages they
  own; every signed-in role sets its own preference.
- **Screen:** *Installed themes* (slug, name, base scheme, enabled, built-in); *Create a theme* (slug, display
  name, base scheme `light`/`dark`, *Start from* an existing theme, token values, optional CSS up to 256 KB);
  *Default themes* (*Panel default*, *Default for new accounts*, *Per-user overrides* on/off); *Your theme*
  (*Preferred theme*, applies to your own sessions on every device); *Theme per package*.
- **Server:** themes live in the panel database; uploaded CSS is written to
  `$WHM_DATA_DIR/themes/<slug>.css`. Token names are the catalog served by `GET /themes/variables` (`bg`,
  `surface`, `border`, `border-strong`, `text`, `text-muted`, `text-faint`, `chrome*`, `primary*`, `ok`,
  `warn`, `bad`, `info` and their `-soft` variants, `radius`, `radius-lg`, `sidebar-w`). `GET /themes/active`
  tells the browser what to apply on load. A package records its theme in the plan snapshot of every account
  created from it; a disabled or missing theme falls back to the account default.
- **Gotchas:** slugs are lowercase, up to 32 characters, and `active`, `variables`, `packages`, `preference`,
  `config` are reserved. Changing *Default themes* (`PUT /themes/config`) is gated by the `white_label` license
  feature on an enforcing panel. The Tweak Settings key `tweak.login_theme` is legacy and not consulted; the
  login screen paints the last theme the browser cached.

---

## 18. Packages

Sidebar category 18. API prefix `/api/packages` (core route, [`server/src/routes/accounts.js`](../server/src/routes/accounts.js)).

#### 18.1 Add a Package

- **Purpose:** create a hosting plan that *Create a New Account* and *Upgrade/Downgrade* resolve into concrete limits.
- **Who:** root or reseller (reseller packages are owned by the reseller and bounded by the reseller's own limits).
- **Screen:** name, disk (MB), bandwidth (MB), max domains / subdomains / addon domains / parked domains /
  databases / e-mail accounts / FTP accounts / e-mails per hour, inode quota, PHP version, feature list, shell
  access, dedicated IP, CGI, digest authentication, theme (`0` or empty = unlimited where the field allows it).
- **Server:** a row in `packages`; nothing on the host changes until an account is created from it.
  `packages.snapshot()` resolves limits, the feature list and the theme (through *Theme Manager*) at account
  creation time.
- **Gotchas:** `theme` must name an enabled theme; `feature_list` must exist.

#### 18.2 Delete a Package

- **Purpose:** remove a plan no account uses.
- **Who:** root or reseller (own packages).
- **Screen:** pick the package, confirm.
- **Server:** `DELETE /packages/:name`; refused with `409` while any account references the package
  ("move them to another package first").

#### 18.3 Edit a Package

- **Purpose:** change a plan's limits and features, or rename it.
- **Who:** root or reseller (own packages).
- **Screen:** the same form as *Add a Package* plus *New name*.
- **Server:** updates the row only. Accounts already created keep the limits recorded in their plan
  snapshot; apply the new limits with *Account Functions › Upgrade/Downgrade an Account* or
  *Multi Account Functions › Modify/Upgrade Multiple Accounts*.

#### 18.4 Feature Manager

- **Purpose:** feature lists: which HST Panel-side features a plan grants (addon domains, subdomains, file manager,
  FTP, e-mail accounts, forwarders, autoresponders, SpamAssassin, MySQL, phpMyAdmin, PostgreSQL, cron, SSH,
  backup, bandwidth, …).
- **Who:** root creates, edits and deletes lists; root or reseller reads them and picks one for a package.
- **Screen:** list of feature lists with the number of packages using each; editor with one toggle per feature.
- **Server:** `feature_lists` rows (`features_json`). Two built-ins are seeded: `default` (the catalog
  in `server/src/db/seed.js`, PostgreSQL and SSH off) and `disabled` (everything off); they cannot be deleted.
  A package's feature list is copied into the account snapshot at creation time.

---

## 19. DNS Functions

Sidebar category 19. API prefix `/api/dns`. Capability `bind` (`named`, `rndc`, `named-checkzone`,
`named-checkconf`, `dnssec-keygen`, `dnssec-signzone`; required: `named`). Schedules: `dns-cluster-sync`
(hourly at :20, job `dns.sync`) and `dns-resign` (03:15 daily, re-signs DNSSEC zones). Zones are kept in the
panel database **and** written as zone files through the agent; every write runs `named-checkzone` first and
reloads `named` afterwards (a failed reload is reported as a warning, the zone stays written).

#### 19.1 Add a DNS Zone

- **Purpose:** create a zone from a template, optionally attached to an account.
- **Who:** root or reseller (zone for an owned account).
- **Screen:** domain, IP address, template, account, default TTL.
- **Server:** `POST /zones` renders the template (variables such as the domain, IP and the nameservers
  from Basic Setup or the reseller's nameservers), validates, writes the zone file, reloads BIND and records the
  zone and its records. Default TTL falls back to the setting `dns.default_ttl` (14400).
- **Gotchas:** a zone that already exists answers `409 exists`.

#### 19.2 Add an A Entry for Your Hostname

- **Purpose:** make sure the server's hostname resolves in a zone this server serves.
- **Who:** root.
- **Screen:** current status (hostname, zone that covers it, existing A record) and an optional *Override IP
  address*; one button adds the record.
- **Server:** `POST /hostname` adds or updates the A record in the covering zone (the main IP from Basic
  Setup unless overridden) and reloads.

#### 19.3 Delete a DNS Zone

- **Purpose:** remove a zone and its file.
- **Who:** root or reseller (own accounts' zones).
- **Screen:** zone picker, confirmation.
- **Server:** `DELETE /zones/:domain` removes the file, reloads BIND and deletes the rows.
- **Gotchas:** the hosted domain and account stay; only DNS is removed.

#### 19.4 DNS Zone Manager

- **Purpose:** edit records in a zone, the SOA, DNSSEC, or the raw zone file.
- **Who:** root or reseller for records, SOA, raw editing; DNSSEC is root only.
- **Screen:** *Select a zone*; record table with add/edit/delete (types A, AAAA, CNAME, MX, TXT, SRV, NS, CAA,
  PTR; name, TTL or blank to inherit `$TTL`, priority, value); SOA fields (primary, hostmaster, refresh, retry,
  expire, minimum); raw editor with *Validate* and *Save*; DNSSEC toggle with the DS material.
- **Server:** records are rows (`POST/PUT/DELETE /zones/:domain/records`); each change bumps the serial,
  renders the file, `named-checkzone`s it and reloads. The raw editor (`PUT /zones/:domain/raw`, up to 2 MB)
  parses the file back into rows. DNSSEC (`PUT /zones/:domain/dnssec`) generates keys with `dnssec-keygen`,
  signs with `dnssec-signzone` and re-signs nightly through `dns-resign`.
- **Gotchas:** values never pass shell characters; the validators refuse them with `422`.

#### 19.5 Edit Zone Templates

- **Purpose:** the templates new zones are rendered from.
- **Who:** root.
- **Screen:** *Templates* list; *Create a new template* / *Edit template* editor; *Preview with domain* (and IP).
- **Server:** templates are stored in the panel database (`GET/POST/PUT/DELETE /templates`,
  `POST /templates/:name/preview`); names are lowercase, up to 40 characters.

#### 19.6 Email DNS Record Manager

- **Purpose:** SPF, DKIM and DMARC for one domain, plus the MX overview.
- **Who:** root or reseller (own domains).
- **Screen:** *Select a domain*; *Mail exchangers*; *SPF* (allow A/AAAA `+a`, allow MX `+mx`, extra `ip4:` /
  `ip6:`, `include:`, *Everyone else* qualifier, or the raw record); *DKIM* (selector, key size 1024/2048/4096,
  *Rotate*, *Remove*); *DMARC* (policy `p`, subdomain policy `sp`, `pct`, `rua`, `ruf`, `adkim`, `aspf`, or the
  raw value).
- **Server:** SPF and DMARC are TXT records in the zone. DKIM (`POST /zones/:domain/email/dkim`)
  generates an RSA key pair in the panel, stores the private key encrypted and hands it to Exim through
  `ctx.mail.installDkimKey` (selector default from `dns.dkim_selector`, size from `dns.dkim_bits`), and
  publishes the public key as `<selector>._domainkey` TXT.
- **Gotchas:** DKIM signing only happens when Exim is installed; without it the record is published but
  nothing signs.

#### 19.7 Email Routing Configuration

- **Purpose:** whether mail for a domain is delivered locally, to a remote exchanger, or held as backup.
- **Who:** root or reseller (own domains).
- **Screen:** per-domain routing `local` / `remote` / `backup` / `auto`; *External mail exchangers* (host,
  priority, lowest first).
- **Server:** `PUT /routing/:domain` rewrites the MX records and calls `ctx.mail.setRouting`, which
  updates Exim's local and relay domain lists. The answer carries `applied: true` only when `exim -bP` confirms
  Exim reads those lists; with Exim present but not reading them the routing is saved and the API answers
  `409 routing_not_applied` with a hint.

#### 19.8 Enable DKIM/SPF Globally

- **Purpose:** apply SPF, DKIM and DMARC (`p=none`) to every domain, or a chosen list.
- **Who:** root.
- **Screen:** *Current status* (how many domains have each record); *What to enable* checkboxes; *Run*.
- **Server:** `POST /email/enable-all` answers `202` with a `dns.email_auth_all` job that applies the
  per-domain logic of 19.6 to each zone and logs the outcome.

#### 19.9 Nameserver Record Report

- **Purpose:** verify that each zone's NS records point at nameservers that resolve and answer.
- **Who:** root or reseller.
- **Screen:** *Run report* (optional single domain, *Max zones to check* up to 500); *Results* table.
- **Server:** `GET /nameserver-report` resolves the NS names and the nameserver addresses; read-only.

#### 19.10 Park a Domain

- **Purpose:** alias a domain onto an account.
- **Who:** root or reseller (own accounts).
- **Screen:** *Park a domain* (domain, account, IP address, *Create a DNS zone for the domain*); *Parked
  domains* table with *Remove* (optionally removing the zone).
- **Server:** `POST /parked` records the alias, asks the web category to add the name to the account's
  vhost, and creates a zone when requested; `DELETE /parked/:domain?removeZone=true` undoes both.

#### 19.11 Perform a DNS Cleanup

- **Purpose:** reconcile the panel's zone list with the zone directory.
- **Who:** root.
- **Screen:** *Orphaned zones* (no account and no hosted domain behind them), *Zone files not known to the panel*
  (imported automatically when valid; unparsable ones are listed), *Zones missing on disk*, *Last cleanup*;
  *Run cleanup* with a domain selection or *all*, and *republish* to rewrite missing files.
- **Server:** `GET /cleanup` builds the report by listing the zone directory through the agent;
  `POST /cleanup` deletes the selected orphans and republishes.

#### 19.12 Set Zone TTL

- **Purpose:** change the default `$TTL` of one or many zones.
- **Who:** root or reseller (own zones).
- **Screen:** zone selection, *New TTL* in seconds.
- **Server:** `PUT /zones/:domain/ttl` or `POST /zones/ttl` (bulk, up to 500 zones); each zone is
  rewritten, checked and reloaded.

#### 19.13 Setup/Edit Domain Forwarding

- **Purpose:** HTTP redirects for whole domains.
- **Who:** root or reseller (own domains); *Apply* is root.
- **Screen:** domain, *Redirect to* URL, type permanent/temporary, *Also redirect www.<domain>*, *Keep the request
  path*; list with *Remove*.
- **Server:** rules are stored (`PUT /forwarding/:domain`) and rendered into the web server by
  `POST /forwarding/apply` through the web category.

#### 19.14 Synchronize DNS Records

- **Purpose:** push zones to the DNS cluster peers configured in *Clusters › DNS Cluster*.
- **Who:** root.
- **Screen:** *Cluster peers*, *Zone sync status* (outcome of the last push per zone and peer), *Synchronise
  now* (all zones or a selection, optionally one peer).
- **Server:** `POST /sync` enqueues `dns.sync`; the job sends each zone to every enabled peer whose role
  is `write-only` or `sync` using that peer's cluster token (scope `clustering:dns`) and records the result.
  With no peers the job logs "No DNS cluster peers are configured" and ends. Inbound pushes arrive on
  `POST /zones/import` and are subject to the Clusters category's accept-pushes switch.

---

## 20. Database Services

Sidebar category 20. API prefix `/api/databases`. Capabilities `mysql` (`mysqld`/`mariadbd` plus the client
tools) and `postgres` (`psql`, `pg_dump`). All work runs against the **active database profile** (20.6); the
panel's own data lives in SQLite, so these pages work even when MySQL is down.

#### 20.1 Change Database Root Password

- **Purpose:** rotate the database superuser password.
- **Who:** root.
- **Screen:** *New password*, confirmation.
- **Server:** `PUT /root-password` changes the password on the server and updates the stored admin
  credential of the active profile (encrypted).

#### 20.2 Change Database User Password

- **Purpose:** reset one database user's password.
- **Who:** root or reseller (users mapped to own accounts).
- **Screen:** *Select a user*, *New password*.
- **Server:** `PUT /users/:name/password`.

#### 20.3 Database Map Tool

- **Purpose:** map databases and database users to hosting accounts (quotas, backups and termination follow
  the map).
- **Who:** root.
- **Screen:** *Databases* and *Database users* tables with an account picker per row; clearing the account
  unassigns.
- **Server:** `POST /map/assign` updates the mapping in the panel database only.

#### 20.4 Edit Database Configuration

- **Purpose:** tune `[mysqld]` options.
- **Who:** root.
- **Screen:** *Server status*; *Options* (known tunables with inline help, *Add another option* for any other
  name, blank keeps the distribution default); *Managed include contents*; *Distribution [mysqld] settings*
  (what the server reads before the include); *Restart the server after saving*; *Restart* alone.
- **Server:** `PUT /config` writes a managed include file through the agent (optionally replacing it),
  `POST /restart` restarts the unit, `GET /variables` reads the live variables.
- **Gotchas:** values are limited to `A-Za-z0-9_./:%,+=-`; a value the server rejects at restart surfaces as
  `422 config_invalid`.

#### 20.5 Manage Database Access Hosts

- **Purpose:** remote hosts allowed to connect as an account's database users.
- **Who:** root or reseller (own accounts); server-wide hosts are root.
- **Screen:** *Allow a remote host* (host, IP, or wildcard such as `203.0.113.%` / `%.example.com`, *Scope*);
  list with *Remove host*.
- **Server:** `POST /access-hosts` re-provisions the account's users at the new host; `DELETE` drops them.

#### 20.6 Manage Database Profiles

- **Purpose:** local and remote database servers the panel can manage.
- **Who:** root.
- **Screen:** *Profiles* table (name, engine `mysql`/`mariadb`/`postgres`, host, port, local flag, active);
  form with admin user and password; *Test*, *Activate*, *Delete*.
- **Server:** `POST /profiles/:id/test` connects with the stored credential; `POST /profiles/:id/activate`
  makes it the profile every other page uses (audited `db.profile.activate`). Credentials are encrypted at rest.
- **Gotchas:** *Configure Remote Service IPs* (21.4) sets the source address used for remote profiles.

#### 20.7 Manage Database Users

- **Purpose:** create users and grants.
- **Who:** root or reseller (own accounts).
- **Screen:** *Create a database user* (user name, password, owner account, *Hosts*, *Grant ALL PRIVILEGES on*
  selected databases); *Database users* table (*Show system users*), per-user grants editor and *Drop user*.
- **Server:** `POST /users` creates the user at each host and applies the grants; `PUT /users/:name/grants`
  replaces them. Privileges are checked against the engine's list (MySQL or PostgreSQL). User names typed
  without a prefix get the account prefix added.

#### 20.8 Manage Databases

- **Purpose:** create and drop databases.
- **Who:** root or reseller (own accounts).
- **Screen:** *Create a database* (name, owner account, charset/collation); *Databases* table (*Show system
  databases*), *Drop database*.
- **Server:** `POST /databases` / `DELETE /databases/:name`; the account's package quota (`max_db`) is
  enforced in the service.

#### 20.9 phpMyAdmin

- **Purpose:** find or point at a phpMyAdmin installation.
- **Who:** root or reseller reads the status; the override is root.
- **Screen:** *Status* (installed, version, PHP available, URL); *Web server configuration* (the detected alias);
  *URL override* (absolute `http(s)://` URL or a path on this server; blank uses the detected alias on the
  server hostname).
- **Server:** `GET /phpmyadmin` runs the agent's `db.phpmyadmin.detect`; `PUT /phpmyadmin` stores
  `db.phpmyadmin.url`.
- **Gotchas:** a protocol-relative `//host/...` value is refused so resellers cannot be sent to a foreign origin.

#### 20.10 Repair Databases

- **Purpose:** check, repair, optimise or analyse tables.
- **Who:** root or reseller (own databases).
- **Screen:** *Run* (operation `check`/`repair`/`optimize`/`analyze`, database selection, *Repair tables found
  corrupt (--auto-repair)*); *Recent runs* with logs.
- **Server:** `POST /repair` answers `202` with a `db.repair` job running `mysqlcheck`/`mariadb-check`.

#### 20.11 Show Database Processes

- **Purpose:** the live process list.
- **Who:** root.
- **Screen:** table with *Auto-refresh (5s)* and *Hide sleeping*; *Kill* (whole connection or query only).
- **Server:** `GET /processes`, `POST /processes/:id/kill`.

#### 20.12 Upgrade Database Version

- **Purpose:** upgrade the database server package.
- **Who:** root.
- **Screen:** *Current server* (engine, version, package); *Upgrade* (target package name such as
  `mariadb-server`, *Dump all databases before upgrading*); *Recent upgrade jobs*.
- **Server:** `POST /upgrade` answers `202` with a `db.upgrade` job: optional full dump through the
  agent, package install through the OS package manager, then `mysql_upgrade`/`mariadb-upgrade`.
- **Needs:** the `pkg` capability (`apt-get`, `dnf` or `yum`).

---

## 21. IP Functions

Sidebar category 21. API prefix `/api/ip`. Capability `iproute2` (`ip`). The panel keeps an **inventory** of
addresses (bound, reserved, dynamic) in its database; host state is read live from `ip addr`.

#### 21.1 IPv6 Ranges

- **Purpose:** IPv6 networks the panel may hand out to accounts.
- **Who:** root.
- **Screen:** *IPv6 ranges* table; *Add a range* (name, CIDR such as `2001:db8:1::/64`, interface, enabled,
  notes); per range: the accounts allowed to draw from it and a *preview* of the next addresses.
- **Server:** rows only; addresses are bound when assigned (21.3).

#### 21.2 Add a New IP Address

- **Purpose:** bind one address or a range of addresses to an interface.
- **Who:** root.
- **Screen:** *Currently bound addresses*; *New IP address* (address, optional *Last address* for a range,
  netmask or prefix, interface, *Reserve the new address(es)* with a note); *Result*.
- **Server:** `POST /addresses` runs `ip addr add` through the agent for each address and records it in
  the inventory so it is re-added at boot.
- **Gotchas:** a `/0` prefix is refused (it would install an on-link default route).

#### 21.3 Assign IPv6 Address

- **Purpose:** give an account an IPv6 address from a range (or a specific one).
- **Who:** root or reseller (own accounts; the range must have been opened to that account by root).
- **Screen:** *Assign an IPv6 address* (account, range or specific address); *Current IPv6 assignments* with *Remove*.
- **Server:** binds the address, adds AAAA records through `ctx.dns` and updates the vhost through
  `ctx.web.setAccountIpv6`; a missing daemon leaves the value `saved` for later.

#### 21.4 Configure Remote Service IPs

- **Purpose:** the source address each outbound service uses.
- **Who:** root.
- **Screen:** IPv4 and IPv6 source address for *Outgoing mail (SMTP)*, *DNS (outbound queries / cluster sync)*,
  *Remote MySQL / MariaDB*, *FTP (passive / data connections)*, *Panel API (outbound requests)*.
- **Server:** `PUT /remote-services` stores the values and calls the owning category's hook
  (`ctx.mail.setOutboundAddresses`, `ctx.dns.setOutboundAddresses`, `ctx.databases.setClientAddresses`,
  `ctx.ftp.setPassiveAddress`). Exim reports `applied: true` only once `exim -bP` shows the address; otherwise
  `409 outbound_not_applied` with a hint.

#### 21.5 IP Migration Wizard

- **Purpose:** renumber the server: old address → new address, several mappings in order.
- **Who:** root.
- **Screen:** *Address mappings*; *Migration plan* (preview: affected accounts, zones, vhosts); options *Rewrite
  DNS records*, *Rewrite virtual hosts*, *Remove old addresses*, interface and prefix for new addresses, dry run;
  *Recent migrations*.
- **Server:** `POST /migration` answers `202` with an `ip.migrate` job: bind new addresses, rewrite
  zones (`ctx.dns`), replace the IP in vhosts (`ctx.web.replaceIp`), update account records, optionally remove
  the old addresses; every step is logged.

#### 21.6 Rebuild the IP Address Pool

- **Purpose:** resynchronise the inventory with the host.
- **Who:** root.
- **Screen:** *IP address pool* (state of every address after the last rebuild); *Rebuild*.
- **Server:** `POST /pool/rebuild` reads `ip addr`, imports unknown addresses (DHCP/SLAAC and privacy
  addresses as *dynamic*, never re-added at boot) and recomputes free/used.

#### 21.7 Show IP Address Usage

- **Purpose:** which account uses each address.
- **Who:** root or reseller (own accounts).
- **Screen:** *IP address usage*; *Addresses used by accounts but not in the inventory*.

#### 21.8 Show or Delete Current IP Addresses

- **Purpose:** addresses bound to the server, with removal.
- **Who:** root.
- **Screen:** *Host summary*, *Bound IP addresses* (delete per row), *Addresses on the host that are not in the
  inventory*.
- **Server:** `DELETE /addresses/:address` runs `ip addr del` and removes the inventory row; the server's
  main IP cannot be removed (`400`), and an address in use by a service or an account is refused with `409`
  ("… is in use … Move those first").

#### 21.9 Show/Edit Reserved IPs

- **Purpose:** exclude addresses from allocation.
- **Who:** root.
- **Screen:** *Reserved IP addresses* with a reason per address; bulk edit.
- **Server:** `PUT /reserved/:address` or `PUT /reserved` (up to 1000 items).

---

## 22. Software

Sidebar category 22. API prefix `/api/software`. Capabilities: `pkg` (`apt-get`, `dnf`, `yum`), `rpm`, `php`,
`nginx`, `perl`, `cpan` (`cpanm` or `cpan`), `pecl`, `pear`, `gem`, `pip`. Schedules: `os-update-check` (05:41
daily, the only update schedule on the panel) and `nginx-proxy-sync` (hourly at :23, enabled only while the
proxy is on). Package-manager work runs as jobs; the installer runs detached on the host and is polled, so a
`dist-upgrade` never has to fit in one agent round trip.

#### 22.1 Install a Perl Module

- **Purpose:** install modules from CPAN.
- **Who:** root.
- **Screen:** *Install from CPAN* (module names such as `Foo::Bar`, up to 50; *Skip the module test suites*,
  on by default); *Installed modules*; *Previous installs*; *Install log*.
- **Server:** `POST /perl/install` → `202` job using `cpanm` when available, otherwise `cpan` with
  default answers.

#### 22.2 Install Distro Packages

- **Purpose:** install or remove OS packages.
- **Who:** root.
- **Screen:** detected manager; search (`GET /pkg/search`), package info, *Packages* list with install (option
  *no recommends*) and *Remove* (option *purge*), *update index*, recent operations.
- **Server:** `POST /pkg/install` / `/pkg/remove` / `/pkg/update-index` answer `202` with jobs.
- **Gotchas:** package names cannot start with `-`; the agent re-validates them.

#### 22.3 Module Installers

- **Purpose:** PECL, PEAR, Ruby gems and Python packages.
- **Who:** root.
- **Screen:** *Available installers* (which tools exist; missing ones are regular distro packages); one tab per
  kind with the installed list and an install form (name, optional version); *Install log*.
- **Server:** `POST /modules/:kind/install` → `202` job. `pip` installs into the system interpreter and
  retries with `--break-system-packages` on PEP 668 distributions; `gem` runs `--no-document`; a PECL
  extension still needs `extension=<name>.so` in the INI editor.

#### 22.4 MultiPHP INI Editor

- **Purpose:** php.ini directives per PHP version (and SAPI) or per domain.
- **Who:** root for versions; root or reseller for own domains.
- **Screen:** *Scope* (PHP version + SAPI `fpm`/`apache2`/`cli`/`php`, or domain); directive editor or the raw
  file; *Reload PHP-FPM after saving*.
- **Server:** `PUT /php/ini/:version` writes the version's INI through the agent; `PUT /php/ini/domain/:domain`
  writes the domain's pool/user INI. Directive values are single-line; the file is capped at 4 MB.

#### 22.5 MultiPHP Manager

- **Purpose:** PHP version per domain and the system default.
- **Who:** root or reseller (own domains); the system default is root.
- **Screen:** *Installed PHP versions* (detected from `/etc/php/*`, `/opt/cpanel/ea-php*`, Remi SCL and the stock
  `php` package; a version affected by a listed PHP advisory carries a badge naming the CVE and the fixed
  version, from the same rule as Security Advisor 4.14); *System default PHP version*; *PHP version per domain*
  (searchable, paged 500 at a time — the MultiPHP INI Editor's domain picker filters the same list); *PHP-FPM
  pools*; *Applying PHP version to the web server* progress.
- **Server:** `PUT /php/domains` calls `ctx.web.setPhpVersion` per domain (a job when more than one
  domain); `PUT /php/default` updates the default and FPM.

#### 22.6 NGINX Manager

- **Purpose:** NGINX as a reverse proxy (and cache) in front of Apache.
- **Who:** root.
- **Screen:** *Status*; *Install NGINX* (job); *Reverse proxy* (enable, Apache backend ports HTTP/HTTPS, enable
  response caching, cache size MB, cache TTL for 200/301/302); *whm-proxy.conf* preview; configtest; start /
  stop / restart / reload; *Install log*.
- **Server:** `PUT /nginx` renders `whm-proxy.conf` and moves Apache to the loopback backend ports
  through `ctx.web.setListenPorts`; NGINX terminates 80/443 and forwards with `X-Forwarded-*`. HTTPS server
  blocks are rendered for every domain with an installed certificate (plus `www.` and parked names); any other
  name is refused rather than served with a neighbour's certificate. `POST /nginx/sync` re-renders from the
  current domains and certificates; SSL/TLS and account changes call it inline and the hourly schedule is a
  safety net.

#### 22.7 Rebuild RPM Database

- **Purpose:** repair a corrupt RPM database.
- **Who:** root.
- **Screen:** *Rebuild RPM database* (job) and *Rebuild log*; on Debian-family hosts the page says *Not
  applicable on this server*.
- **Server:** `POST /rpmdb/rebuild` → `202` job running `rpm --rebuilddb` through the agent.

#### 22.8 System Update

- **Purpose:** apply OS updates.
- **Who:** root.
- **Screen:** *Pending updates* (the recorded nightly check; *refresh* re-runs the simulation) with *Select all*
  or a package subset; options *Refresh the package index first*, *Full upgrade (dist-upgrade)*, *Remove unused
  dependencies afterwards*; *Apply updates automatically every night*; *Previous runs*, *Update log*.
- **Server:** `POST /update/run` → `202` job; `PUT /update/auto` toggles the nightly auto-apply that
  rides on the `os-update-check` schedule.

#### 22.9 Update Server Software

- **Purpose:** the panel's own release check (not the OS).
- **Who:** root.
- **Screen:** *Panel version* (current, latest seen, last check); *Update settings* (*Update feed URL*, *Release
  tier* `stable`/`release`/`edge`, *Notify when a new version is published*); *Check now*.
- **Server:** `POST /panel/update/check` fetches the feed at `software.update_url` and records the latest
  release with its `sha256`, `signature` and `keyId`; credentials in the URL are redacted in the audit log. The
  actual upgrade is *HST Panel › Upgrade to Latest Version* (25.6), which reads this record.

#### 22.10 EasyApache 4

- **Purpose:** declarative Apache/PHP profiles built from OS packages.
- **Who:** root.
- **Screen:** *Currently installed web stack*; *Profiles* (name, description, Debian and RHEL package lists,
  *Additional packages*; copy, diff against the host); *Provision* (options remove extras, remove dependents);
  *Build history*, *Build log*.
- **Server:** `POST /ea4/profiles/:id/build` → `202` job installing and removing packages through the
  package manager so the host matches the profile.

---

## 23. Email

Sidebar category 23. API prefix `/api/email`. Capability `exim` (`exim` or `exim4`, `exiqgrep`,
`update-exim4.conf`, `greylistd`, `sqlite3`). Schedule `mail-greylist-purge` (03:40 daily). Service
Configuration owns Exim's main configuration and the RCPT ACL chain; this category writes only the filter ACL
file that chain includes (`ctx.web.ensureEximAclChain()` runs first).

#### 23.1 Email Deliverability

- **Purpose:** SPF, DKIM, DMARC, MX and reverse DNS health per domain.
- **Who:** root or reseller (own domains).
- **Screen:** domain list with a status per check; *Fix* installs the missing SPF / DKIM / DMARC records
  (through DNS Functions 19.6) and the DKIM signing key.
- **Server:** `GET /deliverability/:domain`, `POST /deliverability/:domain/fix` with `items`.

#### 23.2 Filter Incoming Emails by Country

- **Purpose:** block or allow SMTP clients by country network lists.
- **Who:** root.
- **Screen:** *Add a country* (ISO code, name, action block/allow, enabled); *Filtered countries*; per country
  *Upload a CIDR list* (file or pasted networks, replace or append, lists over the JSON limit must be fetched)
  or *Download* from the configured source; *Mode*; the rejection *Message*; *Apply*.
- **Server:** networks are stored per country; `POST /filters/country/:code/fetch` downloads from
  `mail.country_filter.source_url` (an `https://` template containing `{cc}`, ipdeny-style `.zone` files are
  accepted); `POST /filters/apply` renders every filter into the Exim ACL file and validates it.
- **Gotchas:** the source URL must be set before *Download* works; nothing is applied until *Apply*.

#### 23.3 Filter Incoming Emails by Domain

- **Purpose:** block or allow sender domains.
- **Who:** root.
- **Screen:** *Add a domain* (domain, list block/allow, comment); *Rules* with enable/disable and *Remove*;
  *Rejection message* (sent in the SMTP 550 response); *Apply*.
- **Server:** rows plus the shared `POST /filters/apply`.

#### 23.4 Greylisting

- **Purpose:** defer unknown sender triplets to cut spam.
- **Who:** root.
- **Screen:** *Status* (greylistd present, enabled); *Settings* (enable, initial deferral minutes, must retry
  within hours, records expire after days, deferral message); *Trusted hosts and domains* (type host /
  sender domain / recipient domain, value, comment); *Greylist records* with search and purge.
- **Server:** `PUT /greylist/settings` configures `greylistd` and the ACL; triplets are read from its
  SQLite store; the daily purge job removes expired records.
- **Needs:** `greylistd` and `sqlite3`.

#### 23.5 Mail Delivery Reports

- **Purpose:** trace what happened to messages.
- **Who:** root.
- **Screen:** *Search* (sender, recipient, outcome delivered/failed/deferred/queued/completed, window in hours),
  paginated results.
- **Server:** `GET /reports` parses Exim's main log through the agent.

#### 23.6 Mail Queue Manager

- **Purpose:** inspect and act on the Exim queue.
- **Who:** root.
- **Screen:** queue table (filters frozen, older than N minutes, search); message detail (headers, a body
  excerpt and the delivery log from `exim -Mvh/-Mvb/-Mvl`); per-message *Deliver* / *Freeze* / *Thaw* /
  *Delete*; *Queue-wide actions* on everything matching the current filter; *Flush* (optional force) runs as a
  job.
- **Server:** `POST /queue/{deliver,freeze,thaw,remove}` with message ids, `POST /queue/bulk`,
  `POST /queue/flush` → `202` job `mail.queue.flush`.

#### 23.7 Mail Troubleshooter

- **Purpose:** diagnose delivery to one address.
- **Who:** root.
- **Screen:** *Address to test*; results for *Domain*, *MX records*, *SMTP connectivity*, *Exim routing
  (exim -bt)*.
- **Server:** `POST /troubleshoot`; addresses that start with `-` are refused (they would look like an
  option to Exim).

#### 23.8 Mailbox Conversion

- **Purpose:** convert a user's mail store between `maildir`, `mbox`, `mdbox` and `sdbox`.
- **Who:** root.
- **Screen:** *Account*, *Detected mail storage*, *Conversion* (optional Dovecot user, source format and path,
  target format and path, *Dry run*); *Progress*.
- **Server:** `POST /mailbox/convert` → `202` job `mail.mailbox.convert` running `doveadm sync`.
  Paths are relative, without `..`, and limited to plain path characters because they become part of a
  Dovecot location string.
- **Needs:** Dovecot (`doveadm`).

#### 23.9 Repair Mailbox Permissions

- **Purpose:** fix ownership and permissions of mail directories.
- **Who:** root.
- **Screen:** account selection or *all*; *Repair progress*.
- **Server:** `POST /mailbox/repair` → `202` job `mail.mailbox.repair`.

#### 23.10 Spamd Startup Configuration

- **Purpose:** how the SpamAssassin daemon starts.
- **Who:** root.
- **Screen:** *Start-up* (start at boot `ENABLED=1`, nightly rule updates `CRON=1`); *Capacity* (max/min children,
  max/min spare, max connections per child, scan timeout); *Network* (listen address, port, allowed client IPs,
  local only); *Daemon* (run as user, nice level, syslog facility); *Users and preferences* (create prefs,
  allow tell, helper home directory); *Current file*; *Disable*.
- **Server:** `PUT /spamd` renders spamd's environment file through the agent and restarts the unit.
  Values are rendered verbatim, so paths are limited to `A-Za-z0-9._-` segments.

#### 23.11 View Mail Statistics Summary

- **Purpose:** mail volume statistics.
- **Who:** root.
- **Screen:** *Volume by hour*, *Top senders*, *Top destination domains*, *Top connecting hosts* for a window
  in hours.
- **Server:** `GET /stats/summary` from the Exim log.

#### 23.12 View Relayers

- **Purpose:** who relays mail through this server.
- **Who:** root.
- **Screen:** table of authenticated users with client hosts, envelope senders, recipients, message counts,
  failures, first/last seen and volume.
- **Server:** `GET /stats/relayers`.

#### 23.13 View Sent Summary

- **Purpose:** outbound mail summary.
- **Who:** root.
- **Screen:** paginated senders for a window, filter *authenticated*.
- **Server:** `GET /stats/sent`.

---

## 24. System Health

Sidebar category 24. API prefix `/api/system-health` (Process Manager, Show Current Running Processes and Show
Current Disk Usage also exist on the core `/api/system` routes). Capability `procps` (`ps`, `renice`).

#### 24.1 Background Process Killer

- **Purpose:** kill processes whose names are on a disallowed list (IRC bots, sniffers and the like).
- **Who:** root.
- **Screen:** configuration (enabled, signal `SIGKILL`/`SIGTERM`/`SIGINT`/`SIGHUP`/`SIGSTOP`, notify contacts,
  scope `non-root` or `accounts`, exempt users, retention days); pattern list (add, rename, enable, note;
  `generic-sniffers` stands for the usual packet sniffers); *Matches now*; *Scan* (dry run or kill); kill history
  with filters and *Clear*; scan runs.
- **Server:** the schedule `system-health-bpk` (job `system-health.bpk.scan`, every 10 minutes) follows the
  enabled switch and the pattern list; a manual `POST /bpk/scan` runs immediately. `ps` truncates names to 15 characters, so a longer
  pattern also matches its 15-character prefix.

#### 24.2 Process Manager

- **Purpose:** inspect, signal and renice processes.
- **Who:** root.
- **Screen:** process table sorted by CPU, memory, PID or time (up to 5000 rows, filter by user); per process
  *Signal* (`SIGTERM` default, `SIGKILL`, `SIGHUP`, `SIGINT`, `SIGSTOP`, `SIGCONT`) and *Renice* (−20…19).
- **Server:** `POST /processes/:pid/signal`, `POST /processes/:pid/renice`; audited.

#### 24.3 Show Current Disk Usage

- **Purpose:** filesystem and per-account disk usage.
- **Who:** root.
- **Screen:** *Filesystems*, *Accounts*, *Disk usage resample* (job).
- **Server:** `GET /disk`; `POST /disk/refresh` → `202` job that re-measures account directories.

#### 24.4 Show Current Running Processes

- **Purpose:** a read-only snapshot of running processes.
- **Who:** root.
- **Screen:** the same table as 24.2 without actions.

---

## 25. HST Panel

Sidebar category 25. API prefix `/api/cpanel`; the branding read endpoints are also served unauthenticated at
`/api/branding` so the login page can paint the company name, logo, favicon and notice.

#### 25.1 Change Log

- **Purpose:** what changed in each release.
- **Who:** root or reseller.
- **Screen:** *This server* (installed version), *Releases* parsed from `CHANGELOG.md`; an empty state when the
  file is missing.

#### 25.2 Customization

- **Purpose:** branding: company name, colours, logos, help links, login notice.
- **Who:** root.
- **Screen:** *Company* (name, tagline, footer text); *Colours* (primary, chrome; applied on top of the active
  theme, a theme that sets the same token wins); *Help and documentation links* (help, documentation, support
  URLs); *Login page notice* (plain text or simple Markdown, served to anyone who opens the login page); image
  uploads: logo (up to 512 KB) and favicon (up to 128 KB) with *Remove*.
- **Server:** `PUT /branding` stores the fields; `POST /branding/:kind` takes raw image bytes
  (`image/*`), stored under `$WHM_DATA_DIR/branding/` and served with an ETag.
- **Gotchas:** `white_label`/`custom_branding_builder` are license flags in the edition catalog, but the only
  branding route gated on an enforcing panel is Theme Manager's `PUT /themes/config`.

#### 25.3 Manage Plugins

- **Purpose:** install, enable, disable, configure and remove plugins; the Marketplace tab.
- **Who:** root.
- **Screen:** see [Appendix B](#appendix-b-plugins-and-the-marketplace). Tabs *Installed* and *Marketplace*;
  *Signature policy* (*Require signed packages*, *Developer mode (sideloading)*); *Install a plugin* (upload a
  `.whmplugin` or give a path under the data directory, `/root`, `/home`, `/tmp` or `/opt`); *Installed plugins*
  with enable/disable, settings, logs, jobs, *Uninstall* and *Uninstall and purge*.

#### 25.4 Modify HST Panel & WHM News

- **Purpose:** news items shown to users in the panel.
- **Who:** root for every item; a reseller holding the `news` ACL manages items for its own accounts.
- **Screen:** *News items* with status (active, scheduled, expired, disabled); form: title, body (up to 20,000
  characters), audience, severity, enabled, *Show from*, *Show until*.
- **Server:** rows; `GET /news/active` is what the shell renders for the signed-in principal.

#### 25.5 Reset a Mailman Password

- **Purpose:** reset a mailing list's administrator password or the Mailman site password.
- **Who:** root.
- **Screen:** *Mailing lists* (detected lists); *Reset a list administrator password* (runs Mailman's
  `change_pw`); *Site password* (`mmsitepass`; *Set the list-creator password instead of the site password*).
- **Server:** `POST /mailman/lists/:list/password`, `POST /mailman/site-password`.
- **Needs:** Mailman (`mailman` binary); passwords may not start with `-`.

#### 25.6 Upgrade to Latest Version

- **Purpose:** download, verify and run a new panel release.
- **Who:** root.
- **Screen:** *Version* (installed, latest from the Software feed, *Check*); *Trusted release-signing keys* (key
  id + PEM public key, *Remove*); *Start upgrade* (option *I understand this release cannot be verified* →
  `allowUnverified`, *skip Node*); *Upgrade progress* streams the installer output until the panel restarts;
  *Last upgrade*; *Manual upgrade* instructions.
- **Server:** `POST /upgrade/start` → `202` job: the panel downloads the archive to
  `$WHM_DATA_DIR/upgrades/`, performs an early checksum check, then hands the path plus the feed's checksum,
  signature and key id to the agent (`cpanel.upgrade.*` ops), which copies, verifies against the trusted keys
  under `$WHM_DATA_DIR/release-keys/`, unpacks in its own staging area and runs the installer detached. After the
  restart `upgrade.reconcile()` settles the record.
- **Gotchas:** without a trusted key the upgrade is refused unless `allowUnverified` is checked. The feed URL
  and tier live in *Software › Update Server Software*.

---

## 26. SSL/TLS

Sidebar category 26. API prefix `/api/ssl`. Capabilities `ssl` (`openssl`) and `acme` (`certbot` or
`acme.sh`). Schedule `autossl-daily` (03:17). Installed bundles live under `/etc/ssl/whm/<domain>/`; keys
in storage are encrypted with the panel master key and every key view or download is audited.

#### 26.1 Generate an SSL Certificate and Signing Request

- **Purpose:** create a private key with a CSR or a self-signed certificate.
- **Who:** root or reseller (own accounts).
- **Screen:** *Certificate details* (account, domain/common name, additional SANs up to 100, key RSA
  2048/3072/4096 or EC `prime256v1`/`secp384r1`, *What to generate*, *Valid for (days)* for self-signed);
  *Subject* (O, OU, L, ST, C, e-mail); result with the key shown once; *Recent signing requests*.
- **Server:** `POST /certs/csr` or `/certs/self-signed` run `openssl` through the agent; key and CSR are
  stored encrypted in SSL storage under the owning account.

#### 26.2 Install an SSL Certificate on a Domain

- **Purpose:** deploy a certificate to a domain's vhost.
- **Who:** root or reseller (own domains).
- **Screen:** *Domain*; *Use a stored certificate* or *Or paste the certificate* (certificate PEM, private key PEM
  — optional when a matching key is already stored, CA bundle); *Certificate preview*; *Install even if the
  certificate does not cover this domain or has expired* (`force`).
- **Server:** `POST /install` validates that the key matches, writes the bundle and calls
  `ctx.web.applySsl`; NGINX is re-synced when the proxy is on.
- **Gotchas:** passphrase-protected keys are refused with a hint (`openssl pkey -in key.pem -out plain.pem`).

#### 26.3 Manage AutoSSL

- **Purpose:** automatic issuance and renewal with an ACME client.
- **Who:** root; *issue now for one domain* is root or reseller.
- **Screen:** *Provider* (`disabled`, `certbot`, `acme.sh`; account e-mail; validation `webroot`/`standalone`;
  staging CA; key type RSA/ECDSA; renew when fewer than N days remain; *Also cover www.<domain>*; *Replace
  manually installed certificates*); *Domains* (every known domain and whether the next pass acts on it);
  *Excluded accounts and domains* (kind, value, reason); *Run now* (optionally one domain or account, force);
  *Previous runs* with streamed logs.
- **Server:** `POST /autossl/run` → `202` job `ssl.autossl.run`; the job calls the ACME client through
  the agent and installs the result as in 26.2. Account creation also issues a certificate synchronously
  through `ssl.issueFor`.

#### 26.4 Manage SSL Hosts

- **Purpose:** installed certificates and their expiry.
- **Who:** root or reseller (own domains).
- **Screen:** *Installed certificates* (domain, issuer, expiry, source) with *Uninstall*.
- **Server:** `DELETE /hosts/:domain` removes the bundle and calls `ctx.web.removeSsl`.

#### 26.5 Purchase and Install an SSL Certificate

- **Purpose:** order a certificate from a provider configured in *Market*.
- **Who:** root or reseller.
- **Screen:** *Providers* (enabled SSL providers from Market Provider Manager); *Order a certificate* (provider,
  product, domain, account, existing CSR or a new one, *Organization (for OV/EV products)*); *Orders*; per order
  the CSR to submit, *Complete* (paste certificate and CA bundle, provider order reference) and *Cancel order*.
- **Server:** orders are rows; *Complete* installs the pasted certificate as in 26.2. Credentials for
  `rest` adapters are stored with the provider.

#### 26.6 SSL Storage Manager

- **Purpose:** stored keys, CSRs and certificates.
- **Who:** root or reseller (own accounts).
- **Screen:** *Stored items* with filters (account, kind, installed), download of each part (`cert`, `key`,
  `csr`, `chain`, `fullchain`), *Show key* (audited), delete a part or the whole item; *Upload to SSL storage*
  (account, domain, PEM parts).

#### 26.7 SSL/TLS Configuration

- **Purpose:** protocols, ciphers and HSTS for Apache, Exim and Dovecot; service certificates.
- **Who:** root.
- **Screen:** *Profile* (Mozilla-style presets `modern` / `intermediate` / `old`, or `custom`); *Protocols*
  (TLSv1…TLSv1.3); *Cipher list (TLS ≤ 1.2)*, *TLS 1.3 cipher suites*, *Prefer the server's cipher order*;
  *Apply to* (apache, exim, dovecot); *HTTP Strict Transport Security* (enable, max-age, includeSubDomains,
  preload); service certificates for `exim`, `dovecot`, `apache`, `ftp` and `panel`.
- **Server:** Apache gets a managed include from this page; Exim and Dovecot are rendered by Service
  Configuration, which receives the protocol floor and ciphers; every daemon's configuration is validated and
  rolled back if rejected. `POST /service-certs/:service` installs a certificate for that service.
- **Gotchas:** enable HSTS only once every site on the server works over HTTPS.

---

## 27. Market

Sidebar category 27. API prefix `/api/market`.

#### 27.1 Market Provider Manager

- **Purpose:** the providers that supply certificates to *Purchase and Install an SSL Certificate* and the
  single plugin marketplace hub for *WHM Marketplace*.
- **Who:** root manages; root or reseller lists.
- **Screen:** *Overview*; *Providers* table (name, display name, type `ssl`/`plugin`, adapter, URL, enabled,
  commission, products); *Add provider* (adapters `manual`, `rest`; the `acme` rows are reflected from Manage
  AutoSSL and the `hub` row is the built-in `whm-hub` singleton); per provider *Configure* (URL, adapter
  config such as credentials), *Enable*/*Disable*, *Test*, *Sync products*, *Delete provider* (type the name to
  confirm).
- **Server:** `market_providers` is the source of truth; every SSL provider change is mirrored into the
  `market.providers` setting SSL/TLS reads. Credentials are encrypted.
- **Gotchas:** the `whm-hub` row is **only an enable switch** for the marketplace: the hub URL the panel trusts
  and the license key are owned by the license client. If the row's URL differs from the origin that issued
  the license, the marketplace reports `hub_mismatch` and installs are refused until they match (Appendix B).

---

## 28. Restart Services

Sidebar category 28. All eight functions use the same page (`client/src/pages/server/RestartService.jsx`) and
`POST /api/system/services/<name>/restart`, root only; the service names map to the registry rows seeded in
`server/src/db/seed.js`, and each row lists the systemd unit candidates the agent tries in order. The page shows
the current unit status, restarts on confirmation, re-reads the status and writes an audit row
`service.restart`. *Service Configuration › Service Manager* exposes the other verbs (start, stop, reload,
enable, disable) and the journal.

| Function | Service name | Unit candidates |
|---|---|---|
| 28.1 Database Server | `mysql` | `mariadb`, `mysql`, `mysqld` |
| 28.2 DNS Server | `named` | `named`, `bind9` |
| 28.3 HTTP Server (Apache) | `httpd` | `apache2`, `httpd` |
| 28.4 IMAP Server | `imap` | `dovecot` |
| 28.5 Mail Server (Exim) | `exim` | `exim4`, `exim` |
| 28.6 Mailing List Manager (Mailman) | `mailman` | `mailman3`, `mailman` (not monitored by default) |
| 28.7 PHP-FPM service for Apache | `php-fpm` | `php-fpm`, `php8.3-fpm`, `php8.2-fpm`, `php8.1-fpm` |
| 28.8 SSH Server (OpenSSH) | `sshd` | `ssh`, `sshd` |

- **Gotchas:** when none of the candidates is installed the API answers `404` ("An installed unit for …") and
  the page shows the install prompt. Restarting a service is one of the few mutations still allowed while the
  license is degraded (Appendix A.5).

---

## 29. Development

Sidebar category 29. API prefix `/api/development`. Besides the role, every route here also requires the
`development:read` or `development:write` scope when the caller is an API token. Schedule
`development-maintenance` (03:23 daily) prunes hook run logs and expired tokens.

#### 29.1 OpenAPI Documentation for HST Panel

- **Purpose:** the API reference for the account-side (`cpanel` scope) endpoints.
- **Who:** root or reseller.
- **Screen:** endpoint browser generated from the mounted routers; download `openapi.json?scope=cpanel`.

#### 29.2 OpenAPI Documentation for WHM

- **Purpose:** the admin API reference.
- **Who:** root or reseller.
- **Screen:** the same browser with `scope=whm`, each endpoint annotated with the role it requires.

#### 29.3 Apps Managed by AppConfig

- **Purpose:** third-party apps that appear in WHM, HST Panel or Webmail menus.
- **Who:** root; *Launchable by you* is root or reseller.
- **Screen:** *Registered applications* (identifier, display name, URL, entry URL, service `whm`/`cpanel`/`webmail`,
  description, icon, required ACLs, required feature-list keys, show in menus, enabled); *Import an AppConfig
  file* (parsed from the cPanel text format, `POST /appconfig/parse`); export per app; *Unregister*.
- **Server:** rows; `GET /appconfig/launch` returns the enabled, displayed apps whose ACLs the current
  session holds.

#### 29.4 HST Panel Development Forum

- **Purpose:** a developer landing page (there is no external forum).
- **Who:** root or reseller.
- **Screen:** *Quickstart* and *Runtime* cards linking to API tokens, API endpoints, hooks, the event catalog,
  AppConfig apps and the Plugin SDK served under *Developer Documentation*.

#### 29.5 HST Panel Plugin File Generator

- **Purpose:** scaffold a plugin that validates against the SDK manifest contract.
- **Who:** root.
- **Screen:** *Plugin identity* (reverse-DNS id with at least three segments, name, version, description, author,
  e-mail, homepage, license, category, keywords); *Permissions* (each scope is shown on the consent screen;
  implied scopes are added automatically); *Hooks* (event + stage); options *Settings schema*, *Background job +
  nightly cron*, *Sidebar page* and category, *Isolation* (`in-process` or `process`); *Preview*, *Generate*
  (downloads `plugin.json`, `index.js`, `README.md`), *Validate* a pasted manifest.
- **Server:** `POST /plugin-generator/generate` renders the files in memory; nothing is installed.

#### 29.6 Developer Documentation

- **Purpose:** the developer guides shipped with the install.
- **Who:** root or reseller.
- **Screen:** *Documents* (the Plugin SDK reference and the others under `GET /docs`), *Sections*, *Where to
  start*, *Copy*.

#### 29.7 Manage API Tokens

- **Purpose:** create and revoke API tokens.
- **Who:** root or reseller (resellers manage their own tokens; root sees everyone's and can *Issue for user*).
- **Screen:** *API tokens* (name, user, scopes, expiry, last use); *Create API token* (name, description,
  *Development API scopes* — only the enforced scopes `*`, `development:read`, `development:write` can be
  granted, expiry in days or at a date); *Token created* (shown once, *Copy token*); *Using a token*; *Rename
  token*, *Expire*, *Revoke*; per-token usage.
- **Server:** tokens are stored as SHA-256 hashes; `POST /tokens` is gated by the `api` license feature
  on an enforcing panel and refused for principals without 2FA (core login policy). A token-authenticated
  caller may only mint a subset of its own scopes, for itself, expiring no later than itself.

#### 29.8 Manage Hooks

- **Purpose:** run executables when panel events fire.
- **Who:** root.
- **Screen:** *Hook settings* (run hooks on/off, default timeout, *Keep run log entries*); *Event catalog*
  (events the panel emits, from the SDK vocabulary; cancellable events accept a blocking `pre` hook); *Hook
  scripts* (files under `/usr/local/whm/hooks`, created through the agent; editor up to 256 KB); *Registered
  hooks* (name, event, stage `pre`/`post`, script, blocking, timeout, position, enabled; *Test* with a payload);
  *Emit an event* (any catalog event, with a JSON payload up to 64 KB); *Run log* (exit code, duration, output).
- **Server:** the JSON envelope arrives on the script's stdin. A **blocking `pre` hook that exits
  non-zero or times out rejects the operation**: the originating request answers `409 hook_rejected` with the
  hook's message. Plugins register handlers for the same events through the SDK.

---

## 30. Plugins

Sidebar category 30. The three functions are **bundled SDK plugins** under `plugins/bundled/<id>/`, installed
into the plugin host at boot (job `plugins.bundled.ensure`), exempt from `plugins.require_signature`, and
served by the host under `/api/plugins/<id>/*`; their function pages talk to the host and to
`/api/bundled-plugins/*` (root: enable, disable, reinstall; root or reseller: status). A fourth bundled plugin,
**Automated Backup**, appears under the *Backup* category sidebar (30.4). Their settings, logs and jobs are also
reachable from *HST Panel › Manage Plugins*.

#### 30.1 ImunifyAV

- **Purpose:** malware scanning. Drives the ImunifyAV CLI when it is installed and otherwise runs scheduled
  ClamAV scans of account home directories.
- **Who:** root (the plugin registers its routes root-only; resellers see "only available to the server
  administrator").
- **Screen:** *Scanner* (which engine is present, install prompts *Install ImunifyAV (as root)* / *Or install
  ClamAV for the fallback scan*); *Start a malware scan* (directory to scan); *Malicious files* (account,
  file, signature, detected, status); *Quarantine* (needs ImunifyAV); *Clear findings*. Plugin pages:
  *ImunifyAV settings* (scan schedule, default `0 3 * * 0`; notify contacts about findings; use ClamAV when
  ImunifyAV is absent; largest file to scan in MB) and *Malware findings*.
- **Server:** agent ops `sec.imunify.*` and `sec.clamav.*` (allowed to the plugin through
  `agent:op:` permissions); findings in the plugin store; notifications through Contact Manager.
- **Needs:** `imunify-antivirus` or `clamscan`.

#### 30.2 Server Monitoring

- **Purpose:** load, memory, disk and network samples with threshold alerts.
- **Who:** root.
- **Screen:** *Current* (1-minute load, memory used, disk used on the fullest mount, network in/out); *History*
  (load 1/5/15, memory, disk, network throughput over a range). Plugin pages: *Monitoring settings* (collect
  samples, interval 1–60 minutes, retention 1–30 days, network interface, send alerts, load / memory % / disk %
  thresholds, alert cooldown) and *Alert history*.
- **Server:** samples are taken on an in-process timer (network counters at most every 5 minutes through
  `sec.netdev.read`), kept in the plugin store and pruned by the retention window; crossed thresholds raise a
  Contact Manager notification. Job *Sample metrics* takes one sample now.

#### 30.3 WP Toolkit

- **Purpose:** discover and manage WordPress sites with WP-CLI.
- **Who:** root or reseller for own accounts (WordPress install); plugin pages root.
- **Screen:** *WP-CLI* status; *WordPress sites* (account, path, URL, version, updates, maintenance, hardening
  check with *Update* / maintenance toggle / fix); *Install WordPress* (account, directory below `public_html`,
  site URL, title, admin user/e-mail/password, database name/user/password, table prefix, locale); *Recent
  installs*. Plugin pages: *WP Toolkit settings* (discovery schedule, default every 6 hours; search depth below
  `public_html`, default 3) and *Discover sites now*.
- **Server:** `POST /bundled-plugins/wp-toolkit/install` → `202` job that creates the database and user
  through Database Services, checks the vhost and runs the WP-CLI installer as the account user. Discovery,
  inspection, updates, maintenance mode and hardening go through the `web.wp.*` agent ops.
- **Needs:** `wp` (WP-CLI); MySQL for installs.

#### 30.4 Automated Backup (bundled, under Backup)

- **Purpose:** scheduled account backups with per-account locks, verification, upload to destinations,
  day/week/month retention, run history and token-confirmed restores.
- **Who:** root.
- **Screen** (plugin pages, sidebar *Backup › Automated Backup*)**:** *Automated Backup settings* (scope `all` /
  packages / accounts, components `home`, `mail`, `db`, `dns`, `ssl`, `cron`; verify; request encryption;
  schedule as a UTC cron, empty disables; daily/weekly/monthly archives to keep; destination ids from *Backup
  Configuration*; notify on failure or always; accounts in parallel; lock TTL); *Backup history*; *Backup
  destinations*; *Archives*; *Account locks* (release a stale lock); *Run backups now*; *Restore an archive*.
- **Server:** jobs `run`, `prune`, `restore`; hooks on `backup.completed`, `backup.failed`,
  `account.terminated`. A restore needs a short-lived confirm token issued by root at *Manage Plugins › Issue
  restore token* (`POST /api/plugins/manage/net.whm.automated-backup/restore-token { artefactId, account }`).
- **Gotchas:** retention removes local archives only; destination copies follow that destination's own
  retention. This panel version writes gzip-compressed, unencrypted archives; a request for encryption is
  recorded as a run warning.

---

## 31. Application Manager

Sidebar category 31 — an addition of this panel, not a WHM function. It hosts **Node.js**, **Python** and
**built frontend** applications (React, Angular, Vue, Svelte, static exports) next to the PHP sites of an
account, without Passenger: each Node/Python app runs as its own systemd unit **as the account user** on
`127.0.0.1:<port>`, and the account's Apache virtual host publishes it (reverse proxy with websockets) or
serves the built frontend directly (SPA fallback). NGINX in front of Apache passes everything through.
Design and API contract: `docs/design/application-manager.md`.

#### 31.1 Application Manager

- **Purpose:** register, deploy, build, run and remove applications per domain and base path.
- **Who:** root (all accounts) and resellers (their own accounts; `apps.allow_resellers`).
- **Screen:** the applications table (name, kind, account, URL, runtime, status with the live unit state, port;
  actions *Open*, *Logs*, *Start/Stop/Restart*, *Rebuild*, *Deploy* (git sources), *Edit*, *Remove*) and
  *Create application*, a three-step dialog: **Where** (account → one of its domains, base path such as `/` or
  `/api`, application root inside the home — *Inspect* reads `package.json`/`requirements.txt`/`angular.json`
  as the user and guesses the preset), **What** (kind and preset, start/build fields prefilled from the preset,
  runtime version, source: files already uploaded, a `https://` git repository and branch, or a starter
  scaffold for Express/Flask/FastAPI/static), **Settings** (development/production, environment variables,
  websockets, SPA fallback, memory/task/CPU limits). Submitting queues the deploy job whose log streams into the
  page; the app detail shows status, journal lines, environment editor, source and the last error.
- **Server:** the deploy job runs `app.prepare` (mkdir / `git clone` / scaffold, all as the user), `app.step`
  (`npm ci`/`npm install`, `npm run <build>`, `python -m venv`, `pip install -r requirements.txt` [+ gunicorn/
  uvicorn]), `app.unit.write` (unit `/etc/whm/apps/whm-app-<id>.service` + root-only env file, `systemctl
  enable`), `app.proxy.write` (`<apache root>/whm-apps/<domain>.conf`, configtest with rollback, modules
  `proxy proxy_http proxy_wstunnel headers rewrite` on Debian), `app.static.expose` (ACL or mode bits so the
  web server can read a built frontend), then `svc.start`. Logs come from `journalctl -u whm-app-<id>`.
  Everything that touches the account tree runs through `runuser -u <account>`; root never creates, removes
  or follows anything inside a home. Ports come from `apps.port_range` (default 30000–39999).
- **Needs:** Apache (`web.vhost.*`), systemd, Node.js (system or managed) for Node/static apps, `python3` with
  `venv` for Python apps, `git` for git sources. Missing pieces show the usual install prompt.
- **Status values:** `created` → `deploying` → `running` / `built` (static) / `stopped` / `failed` (with the
  last error on the row).

#### 31.2 Runtime Versions

- **Purpose:** which Node.js and Python runtimes applications may use.
- **Who:** root (resellers read).
- **Screen:** *Node.js* (system `node` plus managed versions under `/opt/whm/runtimes/node/<version>`, the
  apps using each, default, *Remove*; *Install a version* from the LTS/current list fetched from nodejs.org
  or a typed version — a job downloads the official tarball, verifies it against `SHASUMS256.txt` and unpacks it
  root-owned), *Python* (detected interpreters, venv support, an install hint for `python3-venv`/`python3-pip`
  through *Install Distro Packages*), *git*, the defaults form, and a *Policy* card (`GET`/`PUT /api/apps/settings`,
  root: whether resellers may create and control applications, the port range).
- **Server:** `app.runtime.detect`, `app.runtime.node.install` (curl → sha256sum → tar, into a private
  temporary directory, refuses an existing version or a checksum mismatch), `app.runtime.node.remove`
  (refused while an app uses it).

#### 31.3 Application Templates

- **Purpose:** the framework presets behind *Create application* and custom templates.
- **Who:** root (resellers read).
- **Screen:** built-in preset cards (kind, install/build/start, output directory, websockets, SPA fallback) and
  the custom templates table (name, slug, kind, preset fields) with create/edit/delete; *Use template* opens
  the create dialog with the preset selected.
- **Server:** built-ins live in code (`PRESETS`), custom ones in `app_templates`; `GET /api/apps/presets`
  serves both.

## Appendix A. Licensing from the panel

The license client is [`server/src/services/license.js`](../server/src/services/license.js); the gate is
[`server/src/middleware/license.js`](../server/src/middleware/license.js); routes are
[`server/src/routes/license.js`](../server/src/routes/license.js) (root only, mounted before the gate so they
stay reachable in every state). Installing and connecting a hub is covered in
[`INSTALL.md` §5](INSTALL.md#5-the-hub-license-server-and-marketplace).

### A.1 Where and when enforcement applies

- Enforcement is on only when `licenseEnforce` is true: the default under `NODE_ENV=production`, off in
  development and tests, overridable with `WHM_LICENSE_ENFORCE=true|false`. With enforcement off the License tab
  still works but nothing is blocked.
- The hub the panel talks to is the `iss` of its signed token, or `WHM_LICENSE_HUB_URL` before the first
  activation (the tab says "No hub is configured" otherwise). Every hub answer must be signed by one of the
  license keys pinned in `server/src/services/license-keys.json` (`WHM_LICENSE_KEYS_FILE`); an unsigned or
  wrongly signed answer is rejected with `502 hub_signature_invalid` and nothing is stored.
- **Nothing on the host ever changes because of license state.** A transition changes what the API accepts;
  vhosts, zones, mailboxes, databases and services are untouched.

### A.2 The License tab

*Server Configuration › Basic WebHost Manager Setup › License* (`/server-configuration/basic-webhost-manager-setup#license`).

| Card | What it does |
|---|---|
| **License** | status pill, edition, days left, last/next check-in, activation id, hostname and fingerprint; *Check in now* (`POST /api/license/checkin`, forced). |
| **Activate with a license key** / **Replace the license key** | enter `WHM-XXXX-XXXX-XXXX-XXXX`; the key is stored encrypted and never shown again; *Activate with the stored key* re-activates without retyping. `POST /api/license/key`. |
| **Edition limits and features** | the `lim` and `feat` maps of the verified token: limits are enforced when accounts or resellers are created; features gate whole functions (A.6). |
| **Activations** | this server with *Deactivate this server* (`POST /api/license/deactivate`, releases the activation; the panel becomes read-only here until a key is activated again) and the other known activations with *Transfer here*. |
| **Start a free trial** | e-mail address → `POST /api/license/trial`: 14 days, 5 hosting accounts, one trial per server fingerprint and e-mail; converts to a paid edition without re-activation. |
| **Recent license events** | the `license_events` log (also written to the audit log and sent to Contact Manager). |

The Home dashboard shows a License row (status, edition, days left, activations `1/N`, last check-in) and a
persistent banner while the license is in `grace` or any degraded state.

### A.3 Activation, check-in, transfer

- **Activate:** the panel sends the key and its fingerprint (`sys.fingerprint`: machine id, MAC, disk, weighted
  0.5/0.3/0.2) to `/v1/activate`; the hub answers with a signed token (`WHMT1.<payload>.<sig>`) that the panel
  verifies offline against the pinned keys (clock skew 300 s, fingerprint drift ≤ 0.5) and stores. When every
  activation of the key is in use the tab opens *All activations are in use* listing them with *Transfer here*.
- **Transfer:** *Transfer here* repeats the activation with `transferFrom=<activation id>` → `/v1/transfers`;
  the hub moves the activation to this server.
- **Check-in:** the schedule `license.checkin` runs every `licenseCheckinHours` (default 12, from
  `WHM_LICENSE_CHECKIN_HOURS`; the hub may send a different interval, 1–168 h). A successful check-in stores
  a fresh token and resets the failure count. A network or 5xx failure keeps the cached token and backs off;
  the third consecutive failure notifies the contacts (`license.checkin_failed`). The hub can also send
  messages (shown on the tab) and clock-skew warnings, and it distributes the **plugin signing keys** the
  marketplace client trusts.
- **Expiry warnings** at 30, 14, 7 and 1 days (`license.expiring`).

### A.4 Statuses

`unlicensed`, `active`, `grace`, `degraded`, `expired`, `suspended`, `revoked`. `active` and `grace` are the
licensed states. After the token's `exp` passes without a fresh one the panel is in `grace` for `grace` days
from the token (default 7; Enterprise 30), then `degraded` (`grace_elapsed`). A token that fails verification,
a fingerprint that drifted too far (`fingerprint_mismatch`) or a hub answer of `revoked`/`suspended` move the
panel out of the licensed states immediately. Each transition records an event and a Contact Manager
notification (`license.grace_started`, `license.degraded`, `license.expired`, `license.revoked`,
`license.suspended`) and emits the hook event `license.status_changed`.

### A.5 Grace and degraded mode: exactly what is blocked

While the panel is **not** in a licensed state (and enforcement is on), the gate answers
`423 license_degraded` to every request **except**:

- every `GET`, `HEAD` and `OPTIONS` (reads always work);
- `ALL /auth/*` and `ALL /license/*` (log in, change the key, check in, start a trial);
- `POST /system/services/:name/restart|start|reload`;
- `ALL /backup/*` (you can always rescue data);
- `POST /accounts/:username/unsuspend`;
- `GET /plugins/ui` and `GET /plugins/ui/:id/file`.

The error body carries `status` and `action: "/server-configuration/basic-webhost-manager-setup#license"`; the
SPA turns it into a banner with a link. Marketplace installs and updates refuse with the same code
(browsing still works). `grace` is **not** degraded: everything works, with a warning banner.

### A.6 Edition limits and feature gates

Editions and their flags are data on the hub ([BLUEPRINT §16.2](../BLUEPRINT.md)): Trial (1 server, 5
accounts, `marketplace_free`), Solo (25 accounts, `+ api`), Pro (unlimited accounts, 5 resellers,
`+ marketplace_paid, transfers, autossl_wildcard`), Reseller (`+ clusters, white_label, multi_server`),
Enterprise (all, `+ sso, priority_support, custom_branding_builder`, 30-day grace).

- **Limits** (`max_accounts`, `max_resellers`; `-1` = unlimited) are checked by `assertCapacity` when an account
  or reseller is created: `409 license_limit` — "Your Solo license allows 25 hosting accounts (25 in use).
  Upgrade to Pro to add more." Downgrades never delete anything over the new limit.
- **Feature gates** on an enforcing, licensed panel (`403 feature_required`, body `fields.feature`):

| Route(s) | Feature |
|---|---|
| everything under `/api/transfers` | `transfers` |
| everything under `/api/clusters`, and `POST /api/dns/zones/import` | `clusters` |
| everything under `/api/server-config/terminal` | `terminal` |
| `POST /api/development/tokens` | `api` |
| `PUT /api/themes/config` | `white_label` |
| `POST /api/marketplace/install`, `POST /api/marketplace/update/:id` — only for plugins whose pricing is not `free` | `marketplace_paid` |

`ALL` rows gate reads too; a degraded panel has no entitlements, so there the degraded rules apply instead.

---

## Appendix B. Plugins and the Marketplace

Code: the plugin host [`server/src/services/plugins.js`](../server/src/services/plugins.js) (`/api/plugins/manage/*`),
the marketplace client [`server/src/services/marketplace-client.js`](../server/src/services/marketplace-client.js)
(`/api/marketplace/*`), the page [`client/src/pages/fn/cpanel/manage-plugins.jsx`](../client/src/pages/fn/cpanel/manage-plugins.jsx).
Design: [`BLUEPRINT.md` §17–18](../BLUEPRINT.md), [`design/plugin-host.md`](design/plugin-host.md),
[`design/marketplace.md`](design/marketplace.md).

### B.1 What a plugin is, in operator terms

A plugin is a `.whmplugin` package (a gzip'ed tar with `plugin.json` and `main.js` at its root, up to 20 MB)
that runs **inside the panel process**, sandboxed to the permissions its manifest declares: `settings:own`,
`store:own`, `jobs`, `schedule`, `api:routes`, `ui:sidebar`, `contacts:notify`, `audit:write`, `accounts:read`,
`backups:*`, `fs:own`, `net:outbound:<host>`, and `agent:op:<op>` for each privileged operation it may call.
Everything it does is logged under its id and audited. Three install sources exist: **bundled** (shipped with
the panel, installed at boot), **sideloaded** (upload or a path on the server) and **marketplace** (downloaded
from the hub). Host API version is `1.0.0`; a manifest whose `engines.whm` does not match is refused with
`422 incompatible_host`.

### B.2 Manage Plugins (HST Panel › Manage Plugins)

Root only.

| Element | Behaviour |
|---|---|
| **Signature policy › Require signed packages** | setting `plugins.require_signature`. On: packages without a valid Ed25519 `SIGNATURE.json` from a key in `$WHM_DATA_DIR/plugin-keys/<kid>.pub` are refused (`422 unsigned_package`). Bundled plugins are exempt. Turning it off asks for confirmation ("Anyone with root access to the panel will be able to install packages that no trusted key has verified"). |
| **Developer mode (sideloading)** | setting `plugins.developer_mode`. Once the marketplace hub is enabled, uploads and path installs of unsigned packages are refused (`unsigned_package: enable plugins.developer_mode to sideload while the marketplace is enabled`) unless this is on; it also lets a revoked plugin be re-enabled without acknowledging the revocation. Keep it off on production servers. |
| **Install a plugin** | upload a package (`POST /api/plugins/manage/install`, body `application/gzip`) or give an absolute path under the data directory, `/root`, `/home`, `/tmp` or `/opt` (anything else: `403 path_not_allowed`). Installs are additive: the plugin is installed disabled and then enabled. |
| **Installed plugins** | id, name, version, source, signed/unsigned, enabled, permissions count; row actions *Enable*, *Disable*, *Details*, *Uninstall* (keeps settings, store and logs for a later re-install), *Uninstall and purge* (also deletes settings, stored data, logs and the data directory; cannot be undone). |
| **Details** | manifest, granted permissions, warnings (`in-process`, `unsigned`), the plugin's directory and data directory, **Settings** (the manifest's typed fields, validated server-side), **Logs** (last 100 lines, `GET …/logs?limit=`), **Jobs** (run a manifest job with parameters → `202`), and for Automated Backup *Issue restore token*. |

### B.3 The Marketplace tab (and WHM Marketplace)

The tab appears on *Manage Plugins* (`#marketplace`); *Server Configuration › WHM Marketplace* (root only)
shows the same catalog plus the static *Distribution packages* catalog of host software; without the hub
provider it is a read-only preview.

- **Prerequisites:** the `whm-hub` provider enabled in *Market Provider Manager*; a license token on this
  panel (`422 license_required` otherwise); the provider URL must share its origin with the hub that issued the
  license (`409 hub_mismatch`, shown as a red banner); the hub must be reached over `https://`.
- **Browse:** search, category, channel `stable`/`beta`, sort by installs/rating/updated/name, featured;
  cards show the developer (with a verified badge), category, pricing and compatibility; *Details* opens the
  listing with versions, permissions and reviews. Root can leave a review (rating 1–5).
- **Install:** *Install* opens a modal listing every permission scope with the developer's justification;
  confirming sends `POST /api/marketplace/install { pluginId, consent: { permissions } }` → `202` job. The job
  downloads the signed descriptor and package, checks the size (≤ 20 MiB) and the sha256 announced in the
  signed descriptor (`422 sha256_mismatch`), verifies `SIGNATURE.json` against the **hub plugin signing keys
  delivered by the license check-in**, installs with `activate: false`, and compares the consent against the
  installed, signature-verified manifest. If the installed package needs scopes you did not consent to (for
  example a newer version), the job ends `pending_consent` with the plugin disabled and the consent screen
  reopens with the added scopes; `POST /api/marketplace/consent/:id` records them and enables the plugin.
  Installing over a sideloaded or bundled copy is refused (`409 not_marketplace`); an older version than the
  installed one is refused unless `allowDowngrade`.
- **Updates:** the schedule `marketplace-update-check` runs nightly around 04:00 (random minute); *Check for
  updates* runs it now. Pending updates appear on the tab, on the Home dashboard (security updates in a warning
  banner) and per card (*Update to x.y.z*). An update is the install flow again, with consent re-checked.
- **Revocations:** the schedule `marketplace-revocations` polls the hub's revocation feed every 6 hours; a feed
  that fails signature or freshness checks is refused (`502 hub_feed_stale`). A revocation that applies to an
  installed plugin disables it according to the hub's `action`, writes an audit row `plugin.revoked`, notifies
  the contacts, and shows a banner until root acknowledges it (`POST /api/marketplace/revocations/:id/ack`).
  Re-enabling a revoked plugin before acknowledging answers `409 plugin_revoked` (developer mode bypasses this).
- **Uninstall:** *Uninstall (keep data)* or *Uninstall and purge*, as in B.2.

### B.4 What signing means for an operator

- `SIGNATURE.json` in a package is an Ed25519 signature over the package digest, made either by **the hub**
  (marketplace packages, verified with the plugin signing keys the hub distributes at check-in and rotates) or
  by **you** (`scripts/build-plugin.js --sign <key.pem>`, verified with a public key you placed under
  `$WHM_DATA_DIR/plugin-keys/<kid>.pub`, `kid` = first 8 hex of sha256 of the raw public key).
- A valid signature proves the bytes were not altered since that key signed them. It says nothing about what
  the code does: the permission list on the consent screen does. Read it.
- `DEV-SIGNATURE.json` is the developer's signature the hub checks at upload; panels do not verify it.
- Bundled plugins are trusted by their location and are never subject to `plugins.require_signature`.
- *Security Advisor* reports a "panel integrity" finding when `MANIFEST.sha256` of the install no longer
  matches, which covers the bundled plugins too.

---

## Appendix C. For plugin developers

- **Reference:** [`plugins/SDK.md`](../plugins/SDK.md) — manifest, permissions, events, the `ctx.*` API, lifecycle,
  pages and sidebar, jobs and cron, errors, the trust model and sandbox, packaging, signatures, testing with
  `createMockHost`, submitting, versioning. The scaffold from *Development › HST Panel Plugin File Generator*
  (29.5) validates against the same contract; `plugins/sample-plugin` (`net.whm.sample-notes`) is a complete
  worked example with tests.
- **Build:** `node scripts/build-plugin.js <dir> [--out file.whmplugin] [--sign <private.pem> [--dev]] [--kid <kid>]
  [--exclude <pattern>]... [--include-tests] [--allow-secrets] [--json]`. The packer is deterministic (same
  input, same bytes). `--sign <pem> --dev` writes `DEV-SIGNATURE.json` (what a marketplace upload must carry);
  `--sign <pem>` without `--dev` writes an operator `SIGNATURE.json` for panels that trust your key. A source
  tree containing a PEM private key is refused unless `--allow-secrets`; locally signed packages never pass the
  marketplace scanner. Generate a key with `openssl genpkey -algorithm ed25519` and keep it offline.
- **Submitting to the marketplace** (`SDK.md` §15): **register** on the developer portal (e-mail verification,
  TOTP enrolment is required before any claim, key or publish) → **claim a namespace** (a reverse-DNS prefix you
  own: `net.acme` ↔ `acme.net`; public-suffix and reserved prefixes such as `net.whm` are refused) and **verify**
  it with a DNS TXT `_whm-dev.<domain>` record or `https://<domain>/.well-known/whm-developer.txt` (optionally a
  GitHub organisation or an ID document); a reviewer approves → **register an Ed25519 signing key** with a
  challenge signature → **submit** a version (upload the `--dev`-signed package with a justification for every
  permission) → **automated scan** (manifest, signature, file types, static scan, permission risk, secrets,
  typosquatting) → **human review** → `approved` (the hub signs and repacks) → **publish** to `stable` or `beta`.
  Resubmit a rejected version as a new version number. You may later **yank** a version; the vendor may revoke.

---

## Appendix D. Hub portals

The hub ([`hub/`](../hub/), ports 7443 public and 7440 loopback) serves three single-page portals from one
`hub/ui` build: `/admin/*` (vendor admin), `/reseller/*` and `/dev/*` (developer). Portal accounts
(`portal_users`) log in with password and TOTP; developer accounts are separate (`/dev/login`, `/dev/register`).
Creating the first vendor admin and issuing the first license from the command line (`hub/scripts/hub-cli.js
create-admin | issue | revoke | status | activate-key`) is described in [`INSTALL.md` §5.3–5.4](INSTALL.md#53-the-first-vendor-admin).

### D.1 Vendor admin (`/admin`)

| Screen | What it manages (API under `/v1/admin`) |
|---|---|
| Dashboard | activations per edition, check-ins, expiring licenses, failed check-ins, verification and review queue sizes, revocations (`/reports/dashboard`, `/stats`). |
| Licenses, License detail | search, issue, bulk issue, renew, change edition, suspend / unsuspend, revoke, rekey, lift the reactivation limit, send a message to the panel, activations (deactivate one), check-in history, events. |
| Customers | CRUD of customers (the people licenses are issued to). |
| Resellers | CRUD, quota per edition, wholesale pricing, statement, impersonate (audited). |
| Products | the editions matrix: limits, feature flags, price, rank. |
| Trials | trials started/converted, convert a trial to a paid license. |
| Integrations | hub API keys, outbound webhooks (test, deliver now, replay, delivery log), billing connectors (Stripe, WHMCS, Paddle webhooks under `/v1/admin/billing/webhooks`). |
| Reports, Audit | CSV/DB export, the hub audit log, scheduled jobs (`/schedules`, run now), IP block list. |
| Signing keys | license, plugin-signing and developer keys with `purpose`; create, activate, retire (rotation; the marketplace re-sign status is on `market/catalog`). |
| Security | portal users and roles, password resets, 2FA. |
| **Market › Verifications** | the **developer verification queue**: evidence results (DNS, well-known, GitHub), uploaded documents, approve / reject with reasons, request more evidence. |
| Market › Developers | developer accounts: suspend, reinstate, re-verify, close, revenue share, reassign a namespace. |
| **Market › Reviews** | the **plugin review queue**: scan report, permissions and justifications, approve / request changes / reject; publish or yank a version from the catalog. |
| Market › Catalog | listings (listed, unlisted, featured), categories, takedowns. |
| **Market › Revocations** | create a revocation (plugin, version, severity, action, reason) or a kill-switch; panels pick it up on their next poll. |
| Market › Entitlements, Payouts, Plugin reviews | grants and refunds of paid plugins, payout periods (close, approve, mark paid, hold), moderation of user reviews. |

### D.2 Developer portal (`/dev`)

Register → verify e-mail → profile and 2FA (*Security*: sessions, password) → *Verification* (claim namespaces,
evidence instructions, re-check) → *Keys* (add with challenge, revoke) → *Plugins* (create a listing, assets,
pricing) → *Upload* and *Versions* (scan report, review status and reasons, publish to stable/beta, yank) →
*Stats* (installs, downloads, ratings) → *Payouts* (statements as CSV) → *API keys* and *Webhooks*.

### D.3 Reseller portal (`/reseller`)

*Dashboard* (quota left per edition, expiring), *Licenses* (issue within quota, bulk issue, detail),
*Customers*, *Activations* (deactivate), *API keys*, *Statement* (invoices), *Security*. Reseller-granted plugin
entitlements go through `POST /v1/reseller/entitlements`.

---

## Appendix E. Troubleshooting

### E.1 Error codes you will meet

Every API error is `{ error: { code, message, fields? } }`; the pages show the message and, where present, the
per-field hints.

| Code (HTTP) | Meaning | What to do |
|---|---|---|
| `capability_missing` / `binary_not_found` (501) | the daemon or tool the function needs is not installed on the host (`error.capability` names it). | Install it (the page offers the package name or an install job where one exists, e.g. NGINX, ImunifyAV), then use the install prompt's re-check (`POST /api/system/capabilities/refresh`; capabilities are also re-probed on the next page load). |
| `license_degraded` (423) | the panel is not in a licensed state and enforcement is on; the request was a mutation outside the allow list of [A.5](#a5-grace-and-degraded-mode-exactly-what-is-blocked). | Open the License tab (`error.action`), activate a key, check in, or start a trial. Reads, backups, service restarts and unsuspends still work. |
| `feature_required` (403) | the edition lacks the flag named in `fields.feature`. | Upgrade the license, or turn enforcement off on a non-production panel. |
| `license_limit` (409) | `max_accounts` / `max_resellers` reached. | Upgrade the edition or remove accounts. |
| `hub_signature_invalid` (502) | an answer from the hub was not signed by a pinned license key. | Check `WHM_LICENSE_HUB_URL` points at *your* hub and that `license-keys.json` on the panel holds the hub's current license public key (INSTALL.md §5.2); after a key rotation on the hub, redeploy the keys file. Nothing from that answer was stored. |
| `hub_mismatch` (409) | the `whm-hub` market provider URL and the license issuer differ. | Fix the provider URL in Market Provider Manager (it must share the origin of the token's `iss`). |
| `hub_unreachable` (503), `hub_feed_stale` (502), `download_failed` (503), `sha256_mismatch` (422) | marketplace transport problems: the hub is down, its feed failed verification, or the package bytes differ from the signed descriptor. | Retry later; a persistent `sha256_mismatch` means the download is being tampered with or the hub's descriptor is wrong — do not sideload the file. |
| `unsigned_package` (422) | the package has no valid `SIGNATURE.json` and either *Require signed packages* is on, or the marketplace hub is enabled and *Developer mode* is off (sideloads), or it is a marketplace package without a hub signature. | Sign the package with a trusted operator key, enable developer mode on a development panel, or install it from the marketplace. |
| `incompatible_host` (422) | the manifest's `engines.whm` does not match host API `1.0.0`. | Ask the developer for a compatible version. |
| `plugin_revoked` (409) | you tried to enable a plugin a revocation disabled. | Acknowledge the revocation banner first (or replace the plugin). |
| `pending_consent` (job result) / `consent_incomplete` (422) | the installed version needs scopes not yet consented to. | Review and confirm them on the consent screen. |
| `hook_rejected` (409) | a blocking `pre` hook in *Manage Hooks* exited non-zero or timed out, or a plugin `pre` hook cancelled the event. | Read the hook's message, check *Run log*, fix or disable the hook. |
| `routing_not_applied` / `outbound_not_applied` (409) | Exim is installed but its running configuration does not read the panel's lists. | Follow the `hint` (usually *Service Configuration › Exim Configuration Manager* to install the managed includes). |
| `path_not_allowed` / `unknown_op` (403) | an input path is outside the allowed roots, or an op is not in the agent catalog. | Use a path under the documented roots; an unknown op after an upgrade means panel and agent versions differ — restart both. |
| `agent_unavailable` / `timeout` (503) | `whm-agentd` is not reachable on `WHM_AGENT_SOCKET`, or an op exceeded its timeout. | `systemctl status whm-agentd`; `journalctl -u whm-agentd`. |
| `validation_failed` (422), `bad_json` (400), `too_large` (413) | input errors; `fields` lists each problem. | Fix the input (JSON bodies are capped at 2 MB; package uploads at 20 MB). |
| `conflict` (409), `not_found` (404), `exists` (409), `in_use` (422) | the record already exists, is missing, or is referenced elsewhere. | — |
| `internal` (500) | unexpected; the body carries `requestId`. | Find the request id in the panel journal. |

### E.2 Where the logs are

- **Panel, agent and hub:** systemd journal, identifiers `whm-panel`, `whm-agentd`, `whm-hub`
  (`journalctl -u whm-panel -f`). Level via `WHM_LOG_LEVEL` (default `info`). In development the processes log
  to stdout.
- **Audit log:** the `audit_log` table in `$WHM_DATA_DIR/whm.db`, shown at *Audit log* in the top-right menu
  (`/audit-log`, root; `GET /api/system/audit` with filters, `GET /api/system/audit/logins` for login attempts).
  Every mutating request writes one row (principal, role, IP, action, target, redacted args, result).
- **Jobs:** each job keeps its own log lines (`GET /api/system/jobs/:id`), streamed live over SSE; *Server Status
  › Task Queue Monitor* lists them.
- **Plugins:** per-plugin log lines in the panel database (`Manage Plugins › Details › Logs`,
  `GET /api/plugins/manage/:id/logs`), also mirrored into the panel journal under the plugin id.
- **License and marketplace:** `license_events` (License tab › Recent license events), `marketplace_revocations`
  (the Marketplace tab), both also in the audit log.
- **Hooks:** *Development › Manage Hooks › Run log* (exit code, duration, output; pruned to *Keep run log entries*).
- **Daemons the panel manages:** *Service Configuration › Service Manager › journal* reads `journalctl -u <unit>`
  through the agent.

### E.3 How jobs and schedules work

- A **job** is a row in `jobs` executed by an in-process worker pool (two concurrent jobs by default); it
  carries a type registered by the owning category (`transfer.remote`, `ssl.autossl.run`, `db.repair`, …),
  parameters, progress, log lines and a result. Routes that start one answer `202 { data: { job: { id } } }`;
  the page subscribes to `GET /api/system/jobs/:id/stream` (SSE) and shows the log. Only a *queued* job can be
  cancelled (`POST /api/system/jobs/:id/cancel`); a running one finishes or fails. Jobs survive a panel restart
  as records; a job that was running during the restart is marked failed on boot.
- A **schedule** is a row in `schedules` (name, cron, job type, enabled, params) declared by the owning
  category with `ctx.scheduler.ensure(...)`; a minute-resolution scheduler enqueues the job when the cron matches.
  Operators tune cron and enabled on *Server Configuration › Configure HST Panel Cron Jobs* (`PATCH
  /api/system/schedules/:name`). Schedules follow their feature: for example `nginx-proxy-sync` is enabled only
  while the proxy is on, `system-health-bpk` follows the Background Process Killer switch, and
  `license.checkin` is enabled only once a token exists. Schedules in this part: `transfers-cleanup`,
  `dns-cluster-sync`, `dns-resign`, `os-update-check`, `nginx-proxy-sync`, `mail-greylist-purge`,
  `system-health-bpk`, `autossl-daily`, `development-maintenance`, `license.checkin`,
  `marketplace-update-check`, `marketplace-revocations`, plus the plugins' own crons.
- A job must never do nothing silently: when its feature is off or its binary is missing it logs why and
  returns `{ skipped }`.

### E.4 Resetting the root password and other recoveries

`scripts/whm-cli.js` runs on the server with the panel's environment (`WHM_DATA_DIR`, `WHM_CONFIG` or the
same `.env`/`panel.env` the service uses), as root in a production install so it can open `whm.db`:

```
node scripts/whm-cli.js status                                # data dir, mode, port, users, accounts, packages, running jobs, active blocks
node scripts/whm-cli.js reset-password <username> [password]  # sets a new panel password (prompts when omitted)
node scripts/whm-cli.js create-admin <username> [password]    # creates another root-role panel user
node scripts/whm-cli.js list-users
node scripts/whm-cli.js unlock-ip <ip>                        # deletes the cPHulk block rows for that address
```

- **Lost panel root password:** `node scripts/whm-cli.js reset-password root`. The next login forces a password change when
  the policy requires it. This changes the **panel** login only; the Linux root password is changed from
  *Server Configuration › Change Root Password*.
- **Locked out by 2FA:** `reset-password` leaves TOTP enabled, and there is no administrative control to clear
  another user's TOTP: `POST /api/auth/2fa/disable` acts on the caller only, and *Security Center › Two-Factor
  Authentication* offers *Disable* only in the *Your account* card. The panel issues no backup codes. Recovery
  means signing in with the authenticator (or the secret shown at enrolment), or clearing the user's TOTP columns
  in `$WHM_DATA_DIR/whm.db` by hand with the panel stopped:
  `sqlite3 /var/lib/whm/whm.db "UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL WHERE username = 'root';"`
  then `systemctl start whm-panel`. If the policy requires 2FA for that role, the next login enrols again.
- **Blocked IP:** `node scripts/whm-cli.js unlock-ip <ip>`.
- **Panel degraded after a hub outage:** nothing on the host stopped; activate or check in from the License
  tab once the hub is back. If the hub's license key rotated, update `license-keys.json` first
  (`hub_signature_invalid` otherwise).
- **First boot password:** `WHM_ADMIN_PASSWORD` or `$WHM_DATA_DIR/initial-admin-password.txt`
  ([INSTALL.md §4.7](INSTALL.md#47-first-login)).
