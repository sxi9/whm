# Domains — who creates what for a hosted name

One page on the domain model of the admin side: the four kinds of name an account can hold, which
category creates the document root, the index page, the virtual host, the DNS zone, the mail routing
and the certificate, and the two virtual hosts that are not an account's at all (the hostname's
landing vhost and the catch-all default vhost).

## The rows

`account_domains` (migration `001`) holds every name an account answers for, one row each:

| `type` | What it is | `docroot` | Created by |
|---|---|---|---|
| `main` | the account's own domain (`accounts.domain`) | `<home>/public_html` | account creation (`services/accounts.js`) |
| `addon` | a second website on the account | `<home>/public_html/<domain>` by default | `ctx.accountFunctions.domains.add` |
| `sub` | a name under one of the account's domains | `<home>/public_html/<label>` by default (`shop.example.com` → `public_html/shop`) | `ctx.accountFunctions.domains.add` |
| `parked` / `alias` | another name for the main website | the main docroot (recorded, never created) | DNS Functions `parkDomain` (also reached through `domains.add({ type: 'parked' })`) |

A custom `docroot` must be an absolute path inside the account home, in the agent's path alphabet
(letters, digits, `. _ - ~ + @ =`, `/`, no `..`, no spaces or quotes), not the home, not one of the
account's reserved directories (`public_html`, `mail`, `etc`, `tmp`, `logs`, `ssl`, `.ssh`), not
the document root of another addon/sub domain of the account and not a directory that *holds*
another domain's document root (409: `rm -rf` of it would take that site; a directory *below*
another site's root, the `public_html` layout itself, is fine). The server hostname and
`www.<hostname>` are refused everywhere (`ctx.web.isServerName`); a name hosted by any account is
refused (409); `www.` names are refused because every vhost already answers for its `www.` alias.

**Who may claim a name** (`assertClaimable`, the rule DNS Functions' `parkDomain` applies to parked
names, run for every type before any host step): for a non-root caller the name must not be a label
under the server hostname (`ns1.<hostname>`, `mail.<hostname>`: only root hosts names there), the
account hosting the name or any parent label of it (`accounts.domain`, `account_domains.domain`,
nearest label first) must be the target account, and a DNS zone of exactly that name owned by
another account is never handed over (`ensureZoneForDomain` would reassign it). Root may still move
a name or a zone between accounts.

Package limits (`max_addons`, `max_subdomains`, `max_parked` in the plan snapshot) bind resellers;
root is not limited. Resellers reach only the accounts they own (`load(username, user)` in the
service), and `edit-account` is the ACL.

## Who creates the document root and the index page

| Name | Document root | Index page |
|---|---|---|
| main | `fs.mkdir { owner: <user>, group: <web group>, mode: '0750' }` at account creation (root creates, then hands the directory to the account; the web server's group so `www-data`/`apache` can walk it) | `fs.write_file` of the `index` web template (`renderTemplate('index', { domain, username })`) into `public_html/index.html` |
| addon / sub | agent op **`web.docroot.ensure`** (`agent/src/ops/web.js`): `runuser -u <user> -- mkdir -p -m 0750 <docroot>`, then root hands the new directory to the web server's group through an `O_NOFOLLOW` directory descriptor that must belong to the account (`0750 <user>:<web group>`, the same layout as the main docroot). Nothing is created unless the path resolves inside the account's real home (`assertUnderHome`: a planted link refuses with `path_not_allowed`), the user is a managed one (uid ≥ 1000) and the directory is not a reserved one. | the same op writes `index.html` **as the account** (`runuser … tee`) and only when the directory has no `index.html` yet; the content is `renderTemplate('index', { domain, username, hostname })` — the branded "Ready to launch" page, replaced by whatever the owner uploads |
| parked / alias | none (shares the main docroot) | none |

Restores and transfers deliberately do **not** re-render the index page: they bring the account's own
files back and an index page would overwrite content. Only creation renders it.

Removal (`domains.remove(username, domain, { deleteFiles })`) deletes the files only when asked, only
for addon/sub domains, only when no other domain of the account lives in the directory (a document
root equal to it or anywhere below it, `public_html` included: `rm -rf` would take that site too), and
only as the account (`web.docroot.remove`: `runuser -u <user> -- rm -rf <docroot>`, never the home,
`public_html` or a reserved directory). Root never writes or removes anything below a home it does
not own.

## Virtual hosts

Service Configuration (`ctx.web`, `services/service-configuration.js`) renders one Apache vhost per
`main`, `addon` and `sub` row (`web_vhosts`), with the account's parked/alias names as `ServerAlias`
of the main vhost. `domains.add` calls `ctx.web.vhosts.sync(username)` after the row is inserted;
`domains.remove` calls `ctx.web.removeDomain(domain)` (file + row, never the main domain or the
hostname) before the row goes. Apache absent means the row is kept `pending` and written by the next
sync; the step says so.

Two vhosts belong to no account:

- **The hostname vhost** (`type = 'server'`, `ctx.web.ensureHostnameVhost`): `ServerName <hostname>`,
  docroot `/var/www/whm-default` with the `landing` web template, the hostname's certificate when one
  is installed, HTTP → HTTPS redirect under `web.force_https`. Written at boot (`panel.started`), on a
  hostname change, when the `landing` template is saved and by the re-render job.
- **The catch-all default vhost** (`ctx.web.ensureDefaultVhost`, agent `web.default_vhost.write`):
  the owner's finding "no custom landing page on the IP address". Written right after the hostname
  vhost every time it runs, whenever the hostname's certificate is installed or removed through
  `ctx.web.applySsl` / `removeSsl`, at the end of `setListenPorts`, `replaceIp` and `setAccountIpv6`
  (a port, bind or address change would otherwise leave it on the old ones until the next boot), and
  after any `ensureVhost` whose address set differs from the one recorded for the catch-all
  (`service_config_applies.default_vhost.summary.addresses`). Its place in the load order is
  structural, never lexical: a tenant file such as `0-0.com.conf`, `0.io.conf` or `00.net.conf` sorts
  before any digit-led name. Debian: `conf-available/000-whm-default.conf` + its `conf-enabled` link,
  which `apache2.conf` includes before `sites-enabled/*.conf` (a copy an earlier panel left under
  `sites-available`/`sites-enabled` is removed on the next write; the stock `000-default` site is
  disabled with `a2dissite`, re-enabled if the configtest rejects ours). RHEL, where `conf.d/*.conf`
  is the only glob: `conf.d/+whm-default.conf` (`+` is 0x2B, below `-`, `.` and every character a
  domain may start with), ahead of `ssl.conf`'s `_default_:443` and `welcome.conf`. It is
  `<VirtualHost _default_:80 <every tenant address>:80>` and the same on the HTTPS port inside
  `<IfModule ssl_module>`: Apache picks the first vhost of the most specific address set, so a plain
  `_default_` would never beat an IP-specific tenant vhost for the bare IP; listing every address the
  tenant vhosts bind to (`web_vhosts.ip`/`ipv6`, the main/shared addresses, `ip_addresses`) makes the
  catch-all the first vhost of every set. The reverse holds too: Apache consults no `*:80` vhost for
  a connection whose address another vhost names, so a tenant vhost is never rendered on `*` while
  an address is known (`specsFor`: the account's IP, else the shared, else the main address, as
  account creation picks it), and while a tenant row still has no address (written before any was
  known) the catch-all stays a plain `_default_` until the next sync binds that row.
  `ServerName default.invalid` so it never steals the hostname
  from the hostname vhost. Docroot `/var/www/whm-default` (the landing page), `AllowOverride None`, no
  PHP, no redirect (a redirect of `http://<ip>/` to HTTPS would end on a certificate warning). The
  certificate on 443: the hostname's bundle when installed, else the first pair the panel controls —
  the `apache` service certificate (`/etc/ssl/whm/service/apache/`), the panel listener's pair
  (`/etc/whm/tls/`), or a self-signed pair generated once with openssl under `/etc/ssl/whm/default/`;
  with none (no openssl) only the HTTP block is rendered. Behind the NGINX proxy (Apache bound to
  `127.0.0.1:<port>`, no HTTPS listener) the vhost binds to the loopback port only. The outcome is
  recorded in `service_config_applies` as `default_vhost` (`GET /api/service-config/apache` →
  `defaultVhost`), audited as `web.vhost.default`, and never fails the caller.

## DNS

`domains.add` publishes through DNS Functions (`ctx.dns`): an addon gets its own zone
(`ensureZoneForDomain(domain, { ip, accountId, nameservers })`, the reseller's nameservers when it
has some); a sub domain gets an `A` record in the zone that contains it (`zoneFor` +
`upsertRecords(zone, name, 'A', [{ value: ip }])`) **only when that zone belongs to the same
account** (`zoneFor` carries `account_id`; `upsertRecords` has no owner check of its own) — a
containing zone of another account leaves the step `skipped` with the reason, root excepted — or
its own zone when no zone holds it; a parked domain's zone is `parkDomain`'s. A zone of exactly the
added name that another account owns is refused up front (403, see *who may claim a name*) and, as a
second line, reported `failed` by the DNS step instead of being reassigned. BIND absent keeps the
zone/record recorded and `pending`. Removal deletes an addon's zone (`deleteZone`, owner-checked in
DNS Functions), a sub's `A` records (same owner rule as above) or its own zone, and `unparkDomain`
handles parked names. Mail routing follows: addon/sub domains are added to Exim's local domains
(`ctx.mail.setRouting(domain, 'local')`) and set back to `remote` on removal.

## SSL

`domains.add({ autossl: true })` (the default) issues a certificate through `ctx.ssl.issueFor` only
when AutoSSL has a provider and the name already resolves (`dns.resolve`) to one of the server's
addresses (the account's IP, the main or shared IP); a name that still points elsewhere is reported as
`skipped`, never ordered, so the ACME rate limits are not burnt on names that cannot validate. The
daily AutoSSL run picks such names up later. Removal uninstalls an installed certificate
(`ctx.ssl.uninstall`) before the vhost goes.

The hostname's certificate is Networking Setup's (`POST /api/networking/hostname/certificate`,
the `certificate` step of a hostname change, the `hostname-certificate-renew` schedule): issued
through AutoSSL once the hostname resolves to the public IPv4, installed for `panel`, `exim`,
`dovecot`, `ftp`, handed to the hostname vhost and the catch-all vhost through the web hook. Manage
SSL Hosts shows it as the **Server hostname** row (root only; `GET /api/ssl/hosts` →
`serverHostname`: certificate, the services and whether their copy covers the hostname, the renewal
schedule, the AutoSSL provider and the last run entry for the hostname, the landing vhost) with
*Reissue* (that endpoint) and *Download* (`GET /api/ssl/certs/:id/download`); the hostname's own host
row carries `hostname: true` and is labelled instead of showing an account.

## API

- `GET /api/account-functions/domains/:username` → `{ username, domain, home, suspended, systemUser,
  domains: [{ id, domain, type, docroot, createdAt, ssl, zone, vhost }], limits: { addon, sub, parked:
  { used, max } }, capabilities }`
- `POST /api/account-functions/domains/:username` `{ domain, type: addon|sub|parked, docroot?,
  autossl? }` → `201 { domain, type, docroot, username, parent, steps: { docroot, web, dns, mail,
  ssl }, entry }` — every step is `{ status: applied|pending|skipped|failed, detail }`
- `DELETE /api/account-functions/domains/:username/:domain?deleteFiles=true` → `{ domain, type,
  removed: true, steps: { ssl?, web, dns, mail, files } }`

Both mutations are `requireReseller` with ownership re-checked in the service and audited as
`account.domain.add` / `account.domain.remove` (target = the domain, args = username, type, docroot
and the step statuses). The UI is the **Domains** panel under the account summary (Modify an Account,
reached from List Accounts → Modify): the table, the add form (domain, type, optional document root,
AutoSSL switch) and Remove with an "also delete the document root" switch.
