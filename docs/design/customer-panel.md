# Customer panel ("the account panel") — design of record

Status: design, 2026-11-03. Target: the same `whm-panel` process serves `/panel` (SPA shell for
role `user`) and `/api/panel/*` (API). Nothing here replaces a WHM function; the account panel is
the cPanel side of the product, scoped to exactly one hosting account per session.

Everything below is derived from the code as it stands (`server/src/services/*`, `agent/src/ops/*`,
`client/src/*`) and from the conventions in `CLAUDE.md` and
`docs/design/integration-contracts.md`. Items marked **core follow-up** touch shared files and are
done by the integrator, never by a unit builder.

---

## 1. Goals and scope

### 1.1 Goals

- A role-`user` login lands on `/panel`, sees only its own account, and can do the day-to-day
  hosting work cPanel offers without ever reaching a WHM route.
- Zero new trust: every mutation goes through the existing allowlisted agent ops or new ops that
  run **as the account's uid** (`setpriv`/`runuser`), validated by zod on both sides.
- Reseller semantics stay intact: an action a reseller is not allowed to take on its own account
  (`ctx.resellers.assertAcl`) is also refused when the reseller's customer takes it.
- Degrades like the rest of the panel: a missing daemon is a `CapabilityError` → 501 → install
  prompt, never a broken page.

### 1.2 v1 function list (nav groups → functions)

| Group | Functions (v1) |
|---|---|
| Overview | Dashboard (usage meters, domains, quick links), Account details |
| Domains | Domains (list), Addon domains, Subdomains, Parked/alias domains, Redirects |
| DNS | Zone editor (A/AAAA/CNAME/MX/TXT/SRV/CAA on the account's zones) |
| SSL | SSL status per domain, AutoSSL "issue now", Install own certificate, Certificate storage |
| Files | File manager (browse/upload/download/edit/rename/chmod/delete/compress/extract), Disk usage |
| Email | Email accounts, Forwarders, Default address, Autoresponders, Spam settings, Deliverability + DKIM, Webmail link, Mail usage |
| Databases | Databases, Database users + grants, Remote MySQL hosts, phpMyAdmin link (MySQL/MariaDB; PostgreSQL where the active profile is pg) |
| FTP | FTP accounts (virtual users on pure-ftpd/proftpd; system-user-only on vsftpd) |
| Cron | Cron jobs (the account's crontab) |
| Backups | Generate home/full backup, list + download, restore files from a backup, upload an archive to restore |
| Logs | Access/error log tail + download, Bandwidth history |
| PHP | PHP version per domain, `.user.ini` editor |
| Security | Change password, Two-factor authentication, SSH keys |
| Usage | Disk / bandwidth / object counts against the plan |

### 1.3 Deferred (not v1)

phpMyAdmin and webmail SSO (link + prefilled username only), Dovecot Sieve mail filters, mailing
lists, calendars/contacts, Web Disk, Terminal, Git Version Control, Node/Python/Ruby apps,
hotlink/leech protection, IP blocker, Softaculous-style installers (the bundled WP Toolkit plugin
stays WHM-side), plugin pages inside `/panel` (SDK has no audience field), PostgreSQL remote hosts
(engine reports `supported:false`), per-recipient spam thresholds (needs PRDR), forced 2FA for
role `user` as a core auth policy (panel-level setting only, see §2.4).

---

## 2. Identity model

### 2.1 How an account user exists

Decision: **`account_users` link table**, not a column on `users`. SQLite has no
`ADD COLUMN IF NOT EXISTS`, so a table keeps the migration idempotent, and it lets `users` stay
untouched (core table, migration 001).

`server/src/db/migrations/033_panel.sql`:

```sql
CREATE TABLE IF NOT EXISTS account_users (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_id         INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  password_synced_at TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_account_users_account ON account_users(account_id);

CREATE TABLE IF NOT EXISTS panel_login_as (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ended_at    TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_panel_login_as_actor ON panel_login_as(actor_id, ended_at);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('panel.enabled', 'true'),
  ('panel.require_2fa_for_users', 'false'),
  ('panel.login_as_ttl_minutes', '60'),
  ('panel.login_as_acl', '"login-as"'),
  ('panel.webmail_url', '""'),
  ('panel.upload_chunk_bytes', '1310720');
```

Unit-owned sibling migrations (same number, lettered, one per build unit so parallel builders never
touch the same file): `033b_panel-mail.sql` (`mail_forwarders`, `mail_domain_forwarders`,
`mail_autoresponders`, `mail_spam_settings`; `mail_accounts` from 001 is reused),
`033c_panel-ftp.sql` (`ftp_accounts`), `033d_panel-files.sql` (`panel_uploads` registry is
in-memory like `transfers.uploads`; the migration only seeds `panel.files.*` settings).

Rules:

- `users.username = accounts.username` for the linked row (the convention `cpanel.js:329`,
  `resellers.js:724` and `development.appconfig.listFor` already rely on). The link table is the
  source of truth; **username equality alone never authorises anything**.
- Row creation: `ctx.panel.ensureUser(account)` is called (a) from
  `ctx.events.on('account.created')`, (b) by a boot-time backfill in `register(ctx)` for every
  account without an `account_users` row, (c) on demand by `POST /api/panel/admin/accounts/:username/user`.
  It inserts `users (username, email = contact_email, role 'user', password_hash = NULL,
  suspended = accounts.suspended)` and the link row. A demoted reseller (`resellers.reset()`
  leaves a role-`user` row with the account's username) is **adopted**: if a role-`user` row with
  that username already exists and has no link, it is linked rather than duplicated, and the
  adoption is audited (`panel.user.adopt`).
- `password_hash = NULL` means "cannot log in yet": `ctx.crypto.verifyPassword` fails on null.
- Termination cascades the rows (`ON DELETE CASCADE`), and the panel listens on
  `account.terminated` to call `sessionStore.destroyUserSessions(userId)` first.

### 2.2 Password sync with the Linux user

Two stores exist and must not drift: `users.password_hash` (bcrypt, panel login) and the Linux
password (`user.set_password`, used by FTP/SSH/IMAP system-user auth).

- Panel-side change (`POST /api/panel/security/password`): verify current (bcrypt) → agent
  `user.set_password {username, password}` (host first) → `users.password_hash` +
  `password_changed_at` → `account_users.password_synced_at` →
  `sessionStore.destroyUserSessions(userId)` (it destroys **every** session of the user; there
  is no "except" variant) followed by `req.session.regenerate` + re-assigning `userId`, the
  way `routes/auth.js` re-creates the session after `disallowConcurrentSessions` → audit
  `panel.password.change`. Password strength via `ctx.security.passwordStrength(pw, context)`
  when present; valid contexts are `account | email | ftp | mysql | panel | ssh`
  (`PASSWORD_CONTEXTS` in `security-center.js`): `account` for the hosting-account password,
  `email`/`ftp`/`mysql` for mailbox, FTP and database passwords.
- WHM-side change: **core follow-up (integrator, two lines)** — `accounts.create` (when
  `input.password`) and `accounts.setPassword` call `ctx.panel?.syncPassword(username, password)`
  after the agent op succeeds. `syncPassword` only writes the bcrypt hash (the Linux side was just
  set by the caller). This is the only way the panel can see the password: `account.created`
  deliberately omits it, and no agent op can verify a Linux password.
- Until the integrator lands that hook, `POST /api/panel/admin/accounts/:username/password`
  (requireReseller) does both writes and is what the WHM "Password Modification" page should call;
  divergence is recorded in `password_synced_at IS NULL` and shown as a warning on
  `GET /api/panel/admin/accounts/:username/user`.

### 2.3 2FA and session policy inheritance

- Everything keyed on the `users` row applies unchanged: session timeout, single session,
  password max age, verified-IP notify, cphulk, TOTP lockout. No change to `services/auth.js`.
- `needsEnrollment()` never forces role `user`. Panel setting `panel.require_2fa_for_users`
  (default false) is enforced by the panel's own middleware: when true and `!user.totpEnabled`, every
  `/api/panel/*` route except `/api/panel/me` returns `403 { code: 'two_factor_required' }` and the
  SPA routes to `/panel/security/two-factor` (which uses the existing `/api/auth/2fa/enroll|confirm`).
- `accounts.force_password_change` (per hosting account) is honoured by the panel middleware: only
  `/api/panel/me` and `/api/panel/security/password` pass; the SPA shows the forced-change page.
  `users.must_change_password` stays the per-login flag handled by `requireAuth`; the panel's
  password endpoint clears both.
- `accounts.demo_mode`: every non-GET `/api/panel/*` returns `403 { code: 'demo_mode' }`.

### 2.4 "Log in as" impersonation (root/reseller)

No session swap. The admin keeps its session and identity; the panel pins an acting-as context.

- `POST /api/panel/admin/login-as/:username` — `requireReseller`; ownership via
  `ctx.accounts.get(username, req.user)` (403 for non-owned); reseller ACL
  `ctx.resellers.assertAcl(req.user, settings['panel.login_as_acl'])` (default key `login-as`;
  root bypasses); refused when the account is suspended (409 `account_suspended`). Writes
  `panel_login_as` row, sets `req.session.panelActingAs = { accountId, username, id, by: req.user.id,
  expiresAt }`, audits `panel.login_as { target: username }`, returns `{ data: { account, expiresAt,
  url: '/panel' } }`.
- `POST /api/panel/admin/logout-as` clears it (`ended_at`), audit `panel.logout_as`.
- `ctx.panel.scope(req)` (§3) re-loads the account and **re-checks ownership and ACL on every
  request**; expiry, suspension or lost ownership ends the impersonation immediately
  (`403 { code: 'login_as_ended', reason }`).
- Every panel audit row written while acting carries `args.actingAs = username`, `args.by =
  admin username`; the core audit middleware already records `principal = admin`.
- The SPA shows a persistent banner ("Viewing *acct* as *admin* · ends in 42 min · Exit") driven by
  `GET /api/panel/me` → `{ actingAs }`.
- Refused while acting: `security/password`, `security/two-factor*`, `security/ssh-keys` writes,
  `/api/panel/tokens*` (403 `not_while_impersonating`). `/api/auth/*` endpoints act on the admin's
  own user row by construction, so they need no guard.
- TTL from `panel.login_as_ttl_minutes` (default 60, max 480).

### 2.5 Suspension

- `account.suspended` event → `users.suspended = 1` for the linked row +
  `destroyUserSessions(userId)`; `account.unsuspended` → `users.suspended = 0`. `attachUser`
  then rejects the session on its next request. Direct DB check as well: `scope()` returns
  `423 { code: 'account_suspended' }` for any request where `accounts.suspended = 1` (covers the
  window between the event and the next login and the acting-as case).

---

## 3. Authorization

### 3.1 `ctx.panel.scope(req)`

```js
// returns the single account for this session, or throws HttpError
scope(req) -> {
  account,        // accounts row, shaped (plan parsed, home_dir, uid, gid, ip, suspended…)
  accountId,
  username,       // account.username — the ONLY username services use
  mode: 'user' | 'acting',
  actor: req.user,            // the real principal (audit stays truthful)
  actingAs: null | { by, expiresAt },
  owner,          // users row of accounts.owner_id (root or the reseller)
  ownerPrincipal, // { id: owner.id, username: owner.username, role: owner.role }
  limits,         // ctx.accountInfo.effectiveLimits(username, ownerPrincipal)
  features,       // account.plan.features (record<string,boolean>)
}
```

Resolution order: (1) `req.user.role === 'user'` → `SELECT a.* FROM accounts a JOIN account_users
au ON au.account_id = a.id WHERE au.user_id = ?`; missing link → 403 `no_account`.
(2) `root|reseller` with `req.session.panelActingAs` → re-load by `accountId`, re-check
`ctx.accounts.get(username, req.user)` + ACL + expiry. (3) Otherwise 403 `panel_scope_required`
(an admin without an acting-as context has no business on `/api/panel/*`; `/api/panel/admin/*`
is the exception and uses `requireReseller` directly).

Middleware `panelScope(ctx)` runs `scope()` once per request, stores it as `req.panel`, then applies
the suspension/demo/force-password/2FA gates of §2.3–§2.5. The panel router mounts
`requireRole('user','root','reseller')` then `panelScope`.

### 3.2 Services take the pinned account

Every panel service method has the signature `method(scope, input, req)`. Services never accept a
username, account id, home path or zone name from the client that is not re-validated against
`scope.accountId`:

- Domains: `account_domains.account_id = scope.accountId` or `accounts.domain` equality.
- DNS zones: `dns_zones.account_id = scope.accountId`; subdomain names resolve via
  `ctx.dns.zoneFor(name)` and the containing zone must pass the same check.
- Mail: `mail_domains.account_id`, `mail_accounts.domain_id → mail_domains.account_id`,
  `mail_forwarders.account_id`, `mail_autoresponders.account_id`.
- Databases: name ∈ `ctx.databases.forAccount(username, SYSTEM_ROOT).databases/.users` (or
  `databases.account_id` / `db_users.account_id` directly).
- SSL: `ssl_certs.account_id`; domains through the domain check.
- Backups: `backups.account_name = username`.
- Files/cron/ftp: `username` only, home from `account.home_dir`; the agent re-derives home from
  `/etc/passwd` and runs as the uid.

### 3.3 Delegation principals

Existing services decide with `isRoot(user) || row.owner_id === user.id`. The panel calls them with
`scope.ownerPrincipal` (the account's real owner), never with the customer's `req.user`:

- A reseller-owned account delegates as the reseller → `ctx.resellers.assertAcl` inside those
  services keeps applying (e.g. `edit-dns`, `passwd`, `add-pkg-shell`).
- A root-owned account delegates as root. For methods that are root-only by construction
  (`ctx.databases.dropDatabase` on an unmapped row, `addAccessHost` without `account`) the panel
  **never** reaches them: it only calls the account-taking variants and pre-checks membership
  (§3.2). `SYSTEM_ROOT = { id: null, username: 'panel', role: 'root' }` is used only for
  read-only lookups (`forAccount`, `listDatabases({ account })`) exactly as `backup.js:159` does.
- Services that take no principal (`ctx.web.*`, `ctx.dns.upsertRecords`, `ctx.mail.setRouting`,
  `ctx.databases.run`) are reached only after the §3.2 check and with arguments the panel built.
- **Plan limits and "force" switches are the panel's job, never the delegate's.** Existing
  services waive them for root principals (`dns.parkDomain` checks `max_parked` only when
  `!isRoot(user)`; `ssl.autossl.issueNow` lets root `force`; `software.php.setDomainVersion`
  does not know the package's `php_version`), so a root-owned account delegating as root would
  bypass them. Every `max_*` (`max_addons`, `max_subdomains`, `max_parked`, `max_email`,
  `max_ftp`, `max_sql`, …) is counted and refused (409 `limit_reached`) by the panel service
  before the delegate call, and every boolean that widens behaviour (`force`, `createAccount`,
  `removeZone` on a zone the account does not own) is hard-coded by the panel.
- Ownership checks in existing services are **owner-level, not account-level**: `ssl.visible()`,
  `dns.visible()`, `email.assertDomain()`, `software.resolveDomain()` accept any row whose
  `owner_id` is the principal's. Two accounts of the same owner therefore look identical to them,
  which is why every id/name/domain in §3.2 is matched against `scope.accountId` **before**
  delegation (e.g. `ssl.install({ certId })` only checks `visible(cert, user)`; the panel
  refuses a `certId` whose `ssl_certs.account_id !== scope.accountId` first).

### 3.4 API tokens

`api_tokens` belong to `users` rows, so a customer can mint one from `/panel/security/tokens`.
The core token routes live under `/api/development/tokens*` behind `requireReseller`, so the
panel owns its own CRUD under `/api/panel/tokens` (same table, `user_id = req.user.id`, token
stored as SHA-256 only). Scopes are restricted to the `panel:*` family: `panel:read`, `panel:files`,
`panel:email`, `panel:dns`, `panel:databases`, `panel:backups`, `panel:cron`; `requireScope('panel:x')`
on the matching routers. `apiTokensRequire2fa` applies unchanged. Tokens are confined via
`ctx.confinedScopes` to `/api/panel/*` and `/api/auth/me`.

### 3.5 What role `user` can never do

- Reach any non-panel router: `/api/accounts`, `/api/system`, categories — all keep
  `requireReseller`/`requireRoot`. **Core follow-up (audit, integrator):** grep every category
  router mounted after `requireAuth` for handlers that rely only on `isRoot()` falling through; add
  `requireReseller` where a `user` session could otherwise reach the reseller branch
  (`GET /api/themes/active`, `/api/locales/active`, `/api/cpanel/news/active` are the intended
  auth-only exceptions and `/api/branding` is a `public: true` mount; `GET /api/plugins/ui` is
  already `requireReseller` and stays that way — plugin pages inside `/panel` are deferred).
- Edit NS/SOA/TTL of a zone, save raw zone text, use DNSSEC or templates.
- Add access hosts without the account pin, name databases outside its prefix, force AutoSSL
  re-issuance, choose a non-plan PHP version, exceed plan `max_*` limits.
- Impersonate, see other accounts, read root-owned files outside `/var/log/whm/domlogs/<user>`,
  change its own quota/bandwidth limit/shell/package, create a reseller.
- Run anything as root: every new op executes as the account uid or is a root-side rewrite of a
  panel-owned config file with regex-validated fields.

---

## 4. API surface — `/api/panel`

Conventions: all routes `validate()` with zod; success `{ data, meta }`; lists paginate with
`?page&pageSize&q&sort&dir`; long operations `202 { data: { job: { id } } }` via
`ctx.jobs.enqueue` (progress through the existing SSE); errors `{ error: { code, message,
fields? } }`. Common codes: `no_account`, `account_suspended` (423), `demo_mode`, `feature_disabled`
(403, package feature off), `limit_reached` (409, plan `max_*`), `capability_missing` (501),
`routing_not_applied` (surfaced as `meta.warnings`, never a failure), `login_as_ended`.
Every mutation audits with `target: scope.username` and the object name in `args`.

### 4.1 Overview / me

| Method | Path | Body / query | Delegates to | Notes |
|---|---|---|---|---|
| GET | `/me` | — | `scope()`, `auth.publicUser`, `ctx.accounts.get(username, ownerPrincipal)` (`accountFunctions.summary(user)` is a *list* of every account the principal owns, not a per-account summary) | `{ user, account:{username,domain,ip,package,plan,features,limits,suspended,forcePasswordChange,demoMode}, usage:{diskUsedMb,diskQuotaMb,bandwidthUsedMb,bandwidthLimitMb}, counts:{domains,subdomains,addons,parked,mailboxes,forwarders,databases,ftp}, actingAs, policy:{require2fa}, hostname, csrfToken }` |
| GET | `/overview/quick-links` | — | `ctx.development.appconfig.listFor(req.user,'cpanel')`, `ctx.cpanel.news.active(req.user)` | both already accept role `user` |

### 4.2 Domains

| Method | Path | Body | Delegates to | Errors |
|---|---|---|---|---|
| GET | `/domains` | `?type` | `account_domains` + `ctx.web.vhostFor(domain)` + `ctx.ssl.certForDomain` | — |
| POST | `/domains/addon` | `{ domain: fields.domain, docroot?: relPath, createZone?: bool=true }` | `ctx.dns.ensureZoneForDomain(domain,{ip:account.ip, accountId, nameservers: ctx.resellers.nameserversFor(owner_id)}, req)` → `files.mkdir { username, path, mode:'0750' }` **as the account** (never root `fs.mkdir`: its `mkdirSync` follows a symlink the tenant planted at `public_html`) → INSERT `account_domains('addon')` → `ctx.mail.setRouting(domain,'local', req)` (409 caught → warning) → `ctx.web.ensureVhost(username, req)` | `exists` 409 when the domain is any `accounts.domain` / `account_domains.domain` / `dns_zones.domain` of another account (the same lookups `dns-functions` makes with its private `domainHosted` statement — the panel has its own); `limit_reached` (`max_addons`, counted by the panel); `feature_disabled` (`features.addondomains`) |
| DELETE | `/domains/addon/:domain` | `?removeZone=true&removeDocroot=false` | `ctx.ssl.uninstall` if installed → `ctx.web.removeVhost(domain, req)` (new, §8 seam) → `ctx.dns.deleteZone(domain, ownerPrincipal, req)` → DELETE row, `mail_domains` cleanup → optional `files.remove` as user | `not_found` |
| POST | `/domains/sub` | `{ label: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, parent: fields.domain, docroot?: relPath }` | parent ∈ main/addon of the account; `files.mkdir` as the account (default `<home>/public_html/<label>` — stored explicitly) → INSERT `account_domains('sub')` → `ctx.dns.upsertRecords(zone, fqdn, 'A', [{value: account.ip}], req)` (+AAAA) → `ctx.web.ensureVhost` | `limit_reached` (`max_subdomains`), `feature_disabled` (`features.subdomains`) |
| DELETE | `/domains/sub/:domain` | `?removeDocroot` | `ctx.web.removeVhost` → `ctx.dns.upsertRecords(zone, fqdn, 'A', [])` → DELETE row | — |
| POST | `/domains/parked` | `{ domain, createZone? }` | `ctx.dns.parkDomain({ domain, account: username, createZone }, ownerPrincipal, req)` (it adds the ServerAlias through `ctx.web.addAlias`) | `parkDomain` enforces `max_parked` **only for non-root principals**, so the panel counts `account_domains WHERE type='parked'` against `plan.max_parked` itself (409 `limit_reached`) before delegating; `features.parkeddomains` |
| DELETE | `/domains/parked/:domain` | `?removeZone` | `ctx.dns.unparkDomain(domain, { removeZone }, ownerPrincipal, req)` | — |
| GET | `/domains/:domain/redirect` | — | `domain_forwarding` row via `ctx.dns.listForwarding` filtered | — |
| PUT | `/domains/:domain/redirect` | `{ targetUrl: url ≤2048, type?: 'permanent'\|'temporary', matchWww?, keepPath? }` | `ctx.dns.setForwarding(domain, …, ownerPrincipal, req)` | — |
| DELETE | `/domains/:domain/redirect` | — | `ctx.dns.removeForwarding` | — |

Addon/sub docroots: `relPath` = `/^(?!-)(?!.*(^|\/)\.\.(\/|$))[^\0\n]{1,512}$/` relative to
`public_html`, pinned under `account.home_dir` with `path.resolve` + prefix check before any op.

### 4.3 DNS

| Method | Path | Body | Delegates to |
|---|---|---|---|
| GET | `/dns/zones` | — | `dns_zones WHERE account_id = ?` (columns: `domain, serial, ttl, type, dnssec_enabled`; there is no `published` column — sync state, if shown, comes from `dns_zone_sync`) |
| GET | `/dns/zones/:domain` | — | `ctx.dns.getZone(domain, ownerPrincipal)`; NS and SOA rows stripped from the response |
| POST | `/dns/zones/:domain/records` | `{ name ≤253 default '@', type: enum A,AAAA,CNAME,MX,TXT,SRV,CAA, ttl: null\|int\|/^\d+[smhdw]?$/, priority: 0-65535\|null, value 1..4096 }.strict()` | `ctx.dns.addRecord(domain, body, ownerPrincipal, req)` |
| PUT | `/dns/zones/:domain/records/:id` | partial of the above; record must not be NS/SOA | `ctx.dns.updateRecord` |
| DELETE | `/dns/zones/:domain/records/:id` | — | `ctx.dns.deleteRecord`; refuses NS at apex (422 `protected_record`) |
| GET | `/dns/zones/:domain/email` | — | `ctx.dns.emailStatus(domain, ownerPrincipal)` |

Zone ownership: `dns_zones.account_id === scope.accountId`; `setTtl/setSoa/raw/validate/apply`
are not exposed.

### 4.4 SSL

| Method | Path | Body | Delegates to |
|---|---|---|---|
| GET | `/ssl/domains` | — | `ctx.ssl.hosts.list(ownerPrincipal)` filtered to `accountId` (there is no `ssl.domains`), + `autossl.lastEntryFor(domain)` (new helper reading `ssl_autossl_runs.entries_json`) |
| GET | `/ssl/domains/:domain` | — | `ctx.ssl.hosts.get(domain, ownerPrincipal)` |
| POST | `/ssl/domains/:domain/issue` | `{}` | `ctx.ssl.autossl.issueNow({ domain, force:false }, ownerPrincipal, req)` → 202 job; 501 when provider `disabled` |
| POST | `/ssl/domains/:domain/install` | `{ certId?: id, certPem?: pem ≤64KiB, keyPem?: pem, chainPem?: pem }` | `certId` must satisfy `ssl_certs.account_id === scope.accountId` (`ssl.install` only checks `visible()`, which is owner-level) → `ctx.ssl.install({ domain, certId, certPem, keyPem, chainPem, force:false }, ownerPrincipal, req)` |
| DELETE | `/ssl/domains/:domain` | — | `ctx.ssl.uninstall(domain, ownerPrincipal, req)` |
| GET | `/ssl/certs` | list | `ctx.ssl.storage.list(ownerPrincipal, { account: username })` (or `certs.list(query, user)` filtered by `account_id`) |
| POST | `/ssl/certs/csr` \| `/self-signed` \| `/upload` | as the ssl-tls routes, `account` forced to `username` | `ctx.ssl.certs.generateCsr` / `generateSelfSigned` / `upload` (`{ account, domain, … }, ownerPrincipal, req`) |
| GET | `/ssl/certs/:id/download?part=` | `part: cert\|csr\|chain\|fullchain` (never `key`) | `ctx.ssl.certs.download` after `ssl_certs.account_id` check |
| DELETE | `/ssl/certs/:id` | — | `ctx.ssl.certs.remove` |

### 4.5 Files

All paths are `relPath` relative to `account.home_dir`; the service resolves them and the agent
re-validates containment with realpath and runs as the uid (§5.3).

| Method | Path | Body / query | Op |
|---|---|---|---|
| GET | `/files/list` | `?path=&limit≤10000` | `files.list` |
| GET | `/files/stat` | `?path` | `files.stat` |
| GET | `/files/read` | `?path&maxBytes≤4MiB` | `files.read` (utf8 text editor; 422 `binary` when NUL found) |
| PUT | `/files/write` | `{ path, content: ≤4MiB }` | `files.write` |
| POST | `/files/mkdir` | `{ path, mode?: arg.mode }` | `files.mkdir` |
| POST | `/files/rename` | `{ from, to }` | `files.move` |
| POST | `/files/copy` | `{ from, to }` | `files.copy` |
| POST | `/files/chmod` | `{ path, mode, recursive?: bool }` | `files.chmod` |
| DELETE | `/files` | `{ paths: relPath[1..200] }` | `files.remove` (destructive; home itself refused) |
| GET | `/files/download?path` | streams `Content-Disposition: attachment` by looping `files.chunk_read` (8 MiB) | `files.chunk_read` |
| POST | `/files/uploads` | `{ path (dir), name: /^(?!\.\.?$)[^\0\/\n\r]{1,255}$/, size ≤ 20 GiB }` → `{ id }` | registry entry; `files.chunk_write { truncate:true }` on first chunk |
| PUT | `/files/uploads/:id/chunks` | `{ data: base64 ≤ panel.upload_chunk_bytes }` | `files.chunk_write { append:true }`; per-chunk audit suppressed |
| POST | `/files/uploads/:id/finish` \| `/abort` | — | finish audits `panel.files.upload`; abort removes partial |
| POST | `/files/archive` | `{ paths[1..500], dest: relPath, format: 'zip'\|'tar.gz' }` | 202 job `panel.files.archive` → `files.archive` |
| POST | `/files/extract` | `{ archive: relPath, dest: relPath }` | 202 job → `files.extract` |
| GET | `/files/du` | `?path&depth≤2` | `files.du`, cached 5 min per (account,path) in memory |

Gated by `features.filemanager`. Upload ceiling per request follows `express.json({ limit: '2mb' })`:
the `panel.upload_chunk_bytes` default 1 310 720 raw bytes (≈1.75 MB as base64) is
`transfers.UPLOAD_CHUNK_BYTES`, the value the transfers upload protocol already uses.

### 4.6 Email

Gated by `features.emailaccts` / `forwarders` / `autoresponders` / `defaultaddress` / `spamassassin`.

| Method | Path | Body | Delegates / ops |
|---|---|---|---|
| GET | `/email/accounts` | `?domain&q&page` | `mail_accounts` join `mail_domains` (account), usage via `vmail.quota.get` (doveadm) or `files.du` fallback |
| POST | `/email/accounts` | `{ localPart: /^[a-z0-9][a-z0-9._-]{0,63}$/, domain, password: fields.password, quotaMb: int 0..∞\|null }` | domain ∈ account domains → `ctx.mail.ensureMailDomain(domain, accountId)` (new seam; **409 when a `mail_domains` row exists with a different `account_id`**, `mail_domains.account_id` is nullable and must never be re-pointed) → `vmail.hash {password}` → `files.mkdir` maildir `mail/<domain>/<local>/{cur,new,tmp}` as user → `vmail.passwd.set` → INSERT `mail_accounts` (compensate: `vmail.passwd.remove`). `limit_reached` on `max_email`. `setRouting('local')` warning only |
| PUT | `/email/accounts/:id/password` | `{ password }` | `vmail.hash` → `vmail.passwd.set` (same line, new hash) → UPDATE `password_hash` |
| PUT | `/email/accounts/:id/quota` | `{ quotaMb }` | `vmail.passwd.set` (quota field) → UPDATE |
| PATCH | `/email/accounts/:id` | `{ suspended: bool }` | `vmail.passwd.set { disabled }` → UPDATE |
| DELETE | `/email/accounts/:id` | `?removeMail=false` | `vmail.passwd.remove` → DELETE row → optional `files.remove` maildir as user |
| GET | `/email/accounts/:id/client-settings` | — | computed `{ imap:{host,port,ssl}, pop3, smtp }` from `service_config.mailserver` + `basic.hostname` |
| GET | `/email/forwarders` | `?domain` | `mail_forwarders` |
| POST | `/email/forwarders` | `{ domain, localPart\|null (catch-all), destination: email \| ':fail:' \| ':blackhole:' }` | INSERT → `vmail.aliases.write { domain, entries }` (structured entries per §5.3, the op renders the file; compensate: delete row). Pipes/files never accepted |
| DELETE | `/email/forwarders/:id` | — | DELETE → `vmail.aliases.write` |
| GET/PUT | `/email/domains/:domain/default` | `{ action: 'fail'\|'blackhole'\|'forward', destination? }` | catch-all row (`local_part NULL`) |
| GET/PUT/DELETE | `/email/domains/:domain/forward` | `{ targetDomain: fields.domain }` | `mail_domain_forwarders` → `vmail.domainfwd.write` |
| GET | `/email/autoresponders` | — | `mail_autoresponders` |
| POST/PUT/DELETE | `/email/autoresponders[/:id]` | `{ address: email in account domains, fromName: singleLine ≤128, subject: singleLine ≤255, body: ≤64KiB, charset?: 'utf-8', intervalHours: 0..720, startAt?: iso, stopAt?: iso, enabled }` | `vmail.autoresponder.write/remove` |
| GET/PUT | `/email/spam` | `{ enabled, requiredScore: 1..20 step .1, autoDelete: bool, autoDeleteScore?, whitelist: email[≤200], blacklist: email[≤200] }` | `mail_spam_settings` → `files.mkdir .spamassassin 0700` + `files.write { path: .spamassassin/user_prefs, mode:'0600' }` **as the account** (root never writes inside the home tree; the rendered file is key/value lines only) → `vmail.spam_users.write` |
| GET | `/email/deliverability/:domain` | — | `ctx.mail.deliverability.check(domain, ownerPrincipal)` |
| POST | `/email/deliverability/:domain/fix` | `{ items: ('spf'\|'dkim'\|'dmarc')[] }` | `ctx.mail.deliverability.fix` |
| POST | `/email/dkim/:domain` | `{ rotate?: false }` | `ctx.dns.ensureDkim(domain, {}, ownerPrincipal, req)` |
| DELETE | `/email/dkim/:domain` | — | `ctx.dns.removeDkim` |
| GET | `/email/webmail` | — | `web.webmail.detect` + `panel.webmail_url` → `{ installed, url, prefillUser }` |
| GET | `/email/usage` | `?sinceHours≤168` | `ctx.mail.reports.delivery` + `stats.summary` post-filtered to exact account domains and mailboxes |

`ensureMailDomain` and the deliverability/DKIM ownership need the `account_id` branch
(§8 seams); until then the panel checks the domain itself and delegates with `ownerPrincipal`.

### 4.7 Databases

Engine from `ctx.databases.activeProfile()?.engine` (`status(user)` probes the agent on every call
and is for the WHM page); PostgreSQL branches omit hosts and access hosts. Gated by `features.mysql` / `features.postgres` / `features.phpmyadmin` and settings
`db.phpmyadmin.enabled`.

| Method | Path | Body | Delegates to (always with `account: username` / membership pre-check) |
|---|---|---|---|
| GET | `/databases` | — | `ctx.databases.listDatabases({ account: username, pageSize: 500 }, SYSTEM_ROOT)` joined with `forAccount(username, SYSTEM_ROOT)`; `meta.engineError` surfaced |
| POST | `/databases` | `{ name: /^[a-z0-9_]{1,54}$/, charset?, collation? }` | `createDatabase({ name: ensurePrefixed(name), account: username, … }, ownerPrincipal, req)` — prefix enforced by the panel regardless of `db.prefixing` |
| DELETE | `/databases/:name` | — | membership check → `dropDatabase(name, ownerPrincipal, req)` |
| POST | `/databases/:name/check` | `{ action: 'check'\|'repair'\|'optimize' }` | `enqueueRepair({ action, databases:[name] }, ownerPrincipal, req)` → 202 |
| GET | `/databases/users` | — | `forAccount(...).users` |
| POST | `/databases/users` | `{ name: /^[a-z0-9_]{1,22}$/, password: fields.password, databases?: dbName[] }` | `createUser({ name, password, account: username, databases }, ownerPrincipal, req)`; each database ∈ account |
| PUT | `/databases/users/:name/password` | `{ password }` | `setUserPassword` |
| DELETE | `/databases/users/:name` | — | `dropUser` |
| GET/PUT | `/databases/users/:name/grants` | `{ grants: [{ database, privileges: PRIVILEGES[] }] }` | `grantsFor` / `setGrants`; every `database` ∈ account |
| GET | `/databases/access-hosts` | — | `listAccessHosts({ account: username }, ownerPrincipal)` (MySQL only; global rows `editable:false`) |
| POST | `/databases/access-hosts` | `{ host: /^[A-Za-z0-9.%:_-]{1,255}$/ }` | `addAccessHost({ host, account: username }, …)` |
| DELETE | `/databases/access-hosts/:id` | — | row `account_id === accountId` → `removeAccessHost` |
| GET | `/databases/phpmyadmin` | — | `ctx.databases.phpMyAdmin(ownerPrincipal)` trimmed `{ installed, url, featureEnabled }` + user names |
| POST | `/databases/:name/dump` | `{}` | 202 job → `ctx.databases.dump({ path: <staging>/<random>.sql, databases:[name] }, req)` where `<staging>` = `/var/lib/whm/panel/dumps/<username>/` (root-created, `root:<account gid>` 0750, under the `/var/lib/whm` allowed root — **never a path inside the home**: `mysqldump --result-file` follows a symlink the tenant planted at `~/backups`) → `fs.chown { path, owner:'root', group:<account group> }` + mode 0640 → `files.copy` **as the account** from staging into `<home>/backups/<name>-<ts>.sql` → `fs.remove` staging file; download via `/files/download` |

### 4.8 FTP

| Method | Path | Body | Ops |
|---|---|---|---|
| GET | `/ftp/accounts` | — | `ftp_accounts` + `{ daemon, supported, mainLogin: username, host, port }`; `daemon` from `ctx.web.ftp.selected()` + `ctx.web.ftp.get()` (there is no `ftp.status()`), `supported = daemon !== 'vsftpd' && ftp.virtual.status().enabled` computed by the panel |
| POST | `/ftp/accounts` | `{ login: /^[a-z0-9][a-z0-9._-]{0,31}$/, password, dir: relPath, quotaMb: int\|null }` | `files.mkdir` dir as user → `ftp.user.add { daemon, login: '<login>@<domain>' or '<login>_<username>' per daemon, username, dir, quotaMb, password(stdin) }` (the op derives uid/gid/home from `username`, §5.4) → INSERT → `ftp.sync`. `limit_reached` on `max_ftp`; 501 on vsftpd (`supported:false`) |
| PUT | `/ftp/accounts/:id/password` | `{ password }` | `ftp.user.passwd` |
| PUT | `/ftp/accounts/:id/quota` | `{ quotaMb }` | `ftp.user.set_quota` |
| DELETE | `/ftp/accounts/:id` | — | `ftp.user.remove` → DELETE → `ftp.sync` |
| GET | `/ftp/accounts/:id/client-config` | — | computed FileZilla XML / plain settings |

The main system-user login is listed read-only; its password is the account password (§2.2).

### 4.9 Cron

| Method | Path | Body | Ops |
|---|---|---|---|
| GET | `/cron` | — | `cron.user.read { username }` → `{ env:[{key,value}], jobs:[{id (line hash), schedule, command, line}], exists }` |
| PUT | `/cron` | `{ env: [{ key: /^[A-Z_][A-Z0-9_]{0,63}$/, value: ≤1024 no \n }], jobs: [{ schedule: 5-field \| '@hourly'…'@reboot', command: /^[^\0\r\n]{1,2000}$/ }] ≤500 }` | server validates 5-field schedules with `lib/cron.js isValidCron` and the `@` aliases with its own list (`lib/cron.js` `ALIASES` has no `@reboot`), renders → `cron.user.write { username, content }`; `crontab` refusal (cron.deny) → 422 `refused` |
| DELETE | `/cron` | — | `cron.user.remove` |

Gated by `features.cron`; refused on `shell === /usr/sbin/nologin`? **No** — cron does not need a
login shell; only the feature flag gates it.

### 4.10 Backups

| Method | Path | Body | Delegates to |
|---|---|---|---|
| GET | `/backups` | list | `backups WHERE account_name = username` (own statement, not `ctx.backup.listBackups`) |
| POST | `/backups` | `{ kind: 'home'\|'full' }` | 202 job `panel.backup.generate` → `ctx.backup.archiveAccount(username, { destDir: localDir(), include: kind==='home' ? {home:true,mail:true,dbs:false,dns:false,metadata:true} : all }, ownerPrincipal, req)` (`loadAccount` accepts the owner; `SYSTEM_ROOT` is never used on a mutating path, §8.3); one running job per account (409 `busy`) |
| GET | `/backups/:id` | — | row + `ctx.backup.archiveInfo(id, ownerPrincipal)` after `account_name` check |
| GET | `/backups/:id/browse?prefix=` | — | `ctx.backup.inspect(id, prefix, ownerPrincipal)` |
| GET | `/backups/:id/download` | — | streams via `backup.archive.read_range { archive, offset, length ≤ 8MiB }` (new root-side op, archives are root 0600 under `/backup`) |
| POST | `/backups/:id/restore` | `{ paths: relPath[1..500], overwrite?: bool }` | `ctx.backup.enqueueRestore({ backupId, kind:'files', options:{ paths, overwrite } }, ownerPrincipal, req)` → 202 (`backup.files.restore` already extracts under `setpriv` as the account); `kind:'account'` never offered |
| DELETE | `/backups/:id` | — | only rows generated by the panel (`retention_class='panel'`; the column exists since 016, default `'daily'`) |
| POST | `/backups/uploads` … `/chunks` … `/finish` | transfers upload protocol into `localDir()`; finish → `ctx.backup.registerArchive(path, ownerPrincipal, req)`, which derives `account_name` from the archive name — the panel then **verifies the new row's `account_name === username`** and deletes row + file otherwise (422 `wrong_account`) | restore-from-upload |
| GET | `/backups/restores` | — | `backup_restores` rows for this account |

### 4.11 Logs

| Method | Path | Query | Delegates to |
|---|---|---|---|
| GET | `/logs` | `?kind=apache\|nginx` | `ctx.accountFunctions.logs.list(username, kind, ownerPrincipal)` filtered by `domainLogFile(d)` for the account's domains |
| GET | `/logs/tail` | `?kind&file&bytes≤1MiB` | path from the listing (never client-supplied) → `acct.read_range { path, owner: username, offset: max(0,size-bytes), length }` (`owner` makes the op refuse files not owned by root or that account; the basename must match its `LOG_NAME`) |
| GET | `/logs/download` | `?kind&file` | `ctx.accountFunctions.logs.download(username, kind, file, ownerPrincipal, req, res)` |
| GET | `/logs/bandwidth` | `?months≤24` | `ctx.accountInfo.bandwidthHistory(username, ownerPrincipal, months)` |
| GET/PUT | `/logs/retention` | `{ archiveLogs, removeOldArchives }` | `ctx.accountFunctions.logRetention.get/set` |

### 4.12 PHP

| Method | Path | Body | Delegates to |
|---|---|---|---|
| GET | `/php/versions` | — | `ctx.software.php.versions({ user: ownerPrincipal })` |
| GET | `/php/domains` | — | `ctx.software.php.domains(ownerPrincipal, { account: username, pageSize: 500 })` |
| PUT | `/php/domains/:domain` | `{ version: phpVersionId \| null }` | domain ∈ account → `ctx.software.php.setDomainVersion([domain], version, ownerPrincipal, req)` (single domain applies inline) |
| GET/PUT | `/php/domains/:domain/ini` | `{ directives: record<ini key, value> }` | `ctx.software.ini.readDomain/writeDomain` (`pkg.php.userini.*`, owner-enforced) |

### 4.13 Security

| Method | Path | Body | Delegates to |
|---|---|---|---|
| POST | `/security/password` | `{ currentPassword, newPassword: fields.password }` | §2.2 flow; refused while acting |
| GET | `/security/two-factor` | — | `{ enabled, required }` from `req.user.totpEnabled` + setting |
| POST | `/security/two-factor/enroll` \| `/confirm` \| `/disable` | as `/api/auth/2fa/*` | thin proxies to `ctx.auth.begin2faEnrollment/confirm2faEnrollment/disable2fa(req.user.id, …)`; refused while acting |
| GET | `/security/ssh-keys` | — | `files.read { path: .ssh/authorized_keys }` parsed to `[{ id (fingerprint), type, comment }]`; 501 unless `plan.has_shell` |
| POST | `/security/ssh-keys` | `{ key: /^(ssh-(rsa\|ed25519)\|ecdsa-sha2-nistp(256\|384\|521)) [A-Za-z0-9+\/=]{1,16384}( [^\n\r]{0,255})?$/ }` | `files.mkdir .ssh 0700` → `files.write authorized_keys` → `files.chmod 0600`, all as user |
| DELETE | `/security/ssh-keys/:fingerprint` | — | rewrite without the line |
| GET | `/security/sessions` | — | `sessions WHERE user_id = req.user.id` |
| DELETE | `/security/sessions` | — | `sessionStore.destroyUserSessions(userId)` then `req.session.regenerate` + re-assign `userId` (no "except" variant exists) |
| GET/POST/DELETE | `/tokens[/:id]` | `{ name, scopes: panel:* subset, expiresAt? }` | panel-owned CRUD on `api_tokens` for `req.user.id`; `apiTokensRequire2fa` honoured |

### 4.14 Usage

| Method | Path | Delegates to |
|---|---|---|
| GET | `/usage` | `accounts.disk_used_mb/disk_quota_mb/bandwidth_*`, `scope.limits`, counts per object type, `user.quota_report` filtered to `username` when capability `quota` exists, `files.du { path: '/', depth: 1 }` cached |
| POST | `/usage/refresh` | `ctx.accountInfo.enqueueDiskRefresh(ownerPrincipal)` → 202 (the job `account_info.disk_refresh` is **server-wide**, so the panel rate-limits it to one enqueue per account per 10 minutes and reuses a running job's id) |

### 4.15 Admin (root/reseller, `requireReseller`, no `panelScope`)

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/admin/accounts/:username/user` | — | link status, `passwordSyncedAt`, `totpEnabled`, last login |
| POST | `/admin/accounts/:username/user` | `{ password?: fields.password }` | `ensureUser` (+ optional password sync both stores) |
| POST | `/admin/accounts/:username/password` | `{ password }` | both stores (§2.2) |
| POST | `/admin/login-as/:username` \| `/admin/logout-as` | — | §2.4 |
| GET | `/admin/settings` / PUT | `{ enabled, require2faForUsers, loginAsTtlMinutes: 5..480, webmailUrl: url\|'' }` | `requireRoot`; settings `panel.*` |
| GET | `/admin/login-as/history` | `?page` | `panel_login_as` (root: all; reseller: own) |

---

## 5. New agent ops

Families are new files under `agent/src/ops/` (auto-imported). Every schema is `.strict()`, built
from `arg.*`; every op that touches an account tree takes `username: arg.username`, resolves the
home from `/etc/passwd` (`passwdHome`), runs `assertManaged(username)` (uid ≥ 1000, not
`SYSTEM_USERS`), checks `assertUnderHome(home, path)` (lexical + realpath containment) and
`ctx.assertAllowedPath` (homes live under an **allowed root** — `ctx.allowedRoots`, seeded from
`DEFAULT_ALLOWED_ROOTS` in `agent/src/lib.js` with `/home` first; there is no `HOME_ROOT`
constant on the agent, the server-side list is `accountFunctions.HOME_ROOTS`), then executes
**as the account**:
`exec('setpriv', ['--reuid', uid, '--regid', gid, '--clear-groups', '--no-new-privs', '--', bin, ...argv], { env: { HOME: home, PATH }, timeoutMs })`
— the argv `backup.files.restore` already uses (minus its `dac_read_search` caps); `acct.archive_logs`
and `web.wp.*` use `runuser -u <user> --`, which is the fallback when `setpriv` is absent.
Capability `panel-files` → binaries `setpriv`, `runuser`. `agent/src/ops/as-user.js` (new file,
owned by the files unit, imported by cron/ftp/vmail) re-exports `passwdHome` from `web.js` and
`assertRealPath` from `acct.js` (both already exported), carries its own copy of
`assertManaged`/`SYSTEM_USERS` (private in `user.js` and `acct.js`; a third copy until core
hoists them into `registry.js`) and owns `assertUnderHome` and `asUser`. No edit to
`web.js`/`acct.js`.

### 5.1 `files.*` (`agent/src/ops/files.js`, capability `panel-files`)

| Op | Schema | Execution | Destructive |
|---|---|---|---|
| `files.list` | `{ username, path: arg.absPath, limit: int ≤10000 = 2000 }` | as user: `find <path> -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%T@\t%m\t%u\t%f\0'` (`-P`, never follows); returns `{ entries:[{name,type,size,mtime,mode,owner}], truncated }` | no |
| `files.stat` | `{ username, path }` | as user `stat -c` on the path with `lstat` semantics (`-L` never) | no |
| `files.read` | `{ username, path, maxBytes: int ≤ 4MiB = 1MiB }` | as user `dd if=<path> bs=1M count=…` after `O_NOFOLLOW` size check; refuses non-regular files; returns utf8 + `binary:true` flag when NUL seen | no |
| `files.chunk_read` | `{ username, path, offset: int ≥0, length: int ≤ 8MiB }` | as user `dd … skip= count= iflag=skip_bytes,count_bytes`; base64 `{ data, size, eof, mtime }` | no |
| `files.write` | `{ username, path, content: arg.text, mode?: arg.mode }` | agent writes a 0600 temp under `/var/lib/whm/panel/tmp/` (`ensurePrivateDir`, an allowed root) owned by the account's uid, then **two** `exec` calls as user: `cp --no-dereference -- <tmp> <path>.whm-tmp`, then `mv -T -- <path>.whm-tmp <path>` (never a `&&` chain — there is no shell); refuses symlink targets; the temp is removed in `finally` | no |
| `files.chunk_write` | `{ username, path, data: base64 ≤ 3MiB, truncate?: bool=false }` | as user `dd if=<tmp> of=<path> conv=notrunc oflag=append` (append) or `dd if=<tmp> of=<path>` (truncate — `dd` truncates by default; no shell redirection anywhere) from the decoded temp | no |
| `files.mkdir` | `{ username, path, mode?: arg.mode='0755' }` | as user `mkdir -p -m <mode> -- <path>` | no |
| `files.move` | `{ username, from, to }` | as user `mv -n -T -- from to` (`-n`: refuse overwrite unless `overwrite:true` → `-f`) | no |
| `files.copy` | `{ username, from, to }` | as user `cp -a --no-dereference -- from to` | no |
| `files.remove` | `{ username, paths: absPath[1..200] }` | as user `rm -rf --one-file-system -- …`; refuses `home` itself and any path equal to an allowed root | **yes** |
| `files.chmod` | `{ username, path, mode, recursive?: bool }` | as user `chmod [-R] -- <mode> <path>` (never `-R` across symlinks: `--no-dereference` not available → recursive uses `find -P … -exec chmod`) | no |
| `files.du` | `{ username, path, depth: int 0..2 = 1 }` | as user `du -k --max-depth=<depth> --one-file-system -P -- <path>`, timeoutMs 600 s | no |
| `files.archive` | `{ username, paths: absPath[1..500], dest: absPath, format: 'zip'\|'tar.gz' }` | as user `zip -r -y -- dest paths…` / `tar -czf dest -- paths…` (cwd = home, paths relativised, none may start with `-`), via `nice -n 10 -- setpriv …`, timeoutMs 1 800 s; capability `archive` (zip, unzip, tar, gzip) | no |
| `files.extract` | `{ username, archive: absPath, dest: absPath }` | as user `unzip -o -- archive -d dest` / `tar -xzf archive -C dest --no-same-owner --no-absolute-filenames`; member names starting with `-` refused by `--`; timeoutMs 1 800 s | no |

Quota and ownership are enforced by the kernel because every write runs as the uid; a planted
symlink to `/etc/shadow` is unreadable to that uid.

### 5.2 `cron.*` (`agent/src/ops/cron.js`, capability `cron` → binary `crontab`)

| Op | Schema | Execution | Destructive |
|---|---|---|---|
| `cron.user.read` | `{ username }` | `crontab -u <username> -l` with `allowFailure`; exit 1 + "no crontab for" → `{ exists:false, raw:'' , env:[], jobs:[] }`; parses env lines and 5-field/`@` schedules | no |
| `cron.user.write` | `{ username, content: z.string().max(65536) }` | validates every line (blank / `#` / `KEY=VALUE` with `KEY /^[A-Z_][A-Z0-9_]*$/`, `SHELL` ∈ `arg.shell` / a 5-field schedule checked by the op's **own** field validator (the agent workspace cannot import `server/src/lib/cron.js`; the server validates with it first) or `@reboot|@yearly|@annually|@monthly|@weekly|@daily|@midnight|@hourly` + command `/^[^\0\r\n]{1,2000}$/`; no `\r`; ≤500 lines; no line starting with `-`), then `crontab -u <username> -` with `content` on **stdin** | **yes** |
| `cron.user.remove` | `{ username }` | `crontab -u <username> -r` | **yes** |

`-u` precedes `-`, and `arg.username` cannot start with `-`, so the username is never read as an
option. `/etc/cron.deny` refusals come back as `OpError('refused')` → 422.

### 5.3 `vmail.*` (`agent/src/ops/vmail.js`, capability `dovecot` + `exim`)

Files owned by the agent: `/etc/dovecot/whm/passwd/<domain>` (0640 root:dovecot),
`<eximConfDir>/whm/aliases/<domain>`, `<eximConfDir>/whm/domainfwd.lst`,
`<eximConfDir>/whm/autoresponders/<domain>/<local>`, `<eximConfDir>/whm/spam_users.lst` — all under
allowed roots; written with the `writeAtomic` pattern (a private per-file helper in `db.js`,
`pkg.js`, `web.js` — `vmail.js` carries its own) and validated (`doveconf -n`, `exim -bV`).
`validateExim`/`regenerateDebianConfig` are **private** to `mail.js`/`web.js`; `vmail.js` imports
the shared layout from `exim-layout.js` and implements the same validate-then-rollback sequence
itself (or core exports the two helpers from `mail.js` — integrator's call, one line).

| Op | Schema | Notes | Destructive |
|---|---|---|---|
| `vmail.hash` | `{ password: /^[^\n\0]{1,256}$/ }` | `doveadm pw -s SHA512-CRYPT` when present, else `openssl passwd -6 -stdin`; password on **stdin**; returns `{ hash }` (`$6$…`, validated against `SHADOW_HASH` from `transfer.js`) | no |
| `vmail.passwd.set` | `{ domain: arg.domain, localPart: /^[a-z0-9][a-z0-9._-]{0,63}$/, hash: SHADOW_HASH, username: arg.username, quotaBytes: int ≥0\|null, disabled?: bool }` | the op derives `uid/gid/home` from `/etc/passwd` via `assertManaged(username)` (the caller never supplies a uid or a home, so a panel bug cannot map a mailbox onto another account's tree); rewrites the domain passwd file line `local:hash:uid:gid::home::userdb_mail=maildir:~/mail/<domain>/<local> userdb_quota_rule=*:bytes=N [nologin=y]`; fields regex-validated (no `:`/newline) | no |
| `vmail.passwd.remove` | `{ domain, localPart }` | removes the line; file deleted when empty | **yes** |
| `vmail.passwd.list` | `{ domain }` | `{ users:[{ localPart, uid, gid, home, quotaBytes, disabled }] }` (no hashes) | no |
| `vmail.quota.get` | `{ user: emailAddress }` | `doveadm quota get -u <user>` → `{ bytes, limitBytes, messages }`; `capability_missing` without doveadm | no |
| `vmail.aliases.write` | `{ domain, entries: [{ localPart: /^[a-z0-9][a-z0-9._-]{0,63}$/ \| '*', targets: (emailAddress \| ':fail:' \| ':blackhole:')[1..50] }] ≤2000 }` | renders `local: a@b, c@d` lines; never accepts `|`, `/`, `${` | no |
| `vmail.aliases.remove` | `{ domain }` | deletes the file | **yes** |
| `vmail.domainfwd.write` | `{ entries: [{ domain, target: arg.domain }] ≤5000 }` | full rewrite of `domainfwd.lst` | no |
| `vmail.autoresponder.write` | `{ domain, localPart, fromName: singleLine ≤128, subject: singleLine ≤255, body: ≤64KiB, charset: /^[A-Za-z0-9._-]{1,32}$/, intervalHours: 0..720, startAt?: iso, stopAt?: iso }` | writes the body file + `<local>.conf` key/value headers; once-db under `/var/lib/whm/autoreply/` | no |
| `vmail.autoresponder.remove` | `{ domain, localPart }` | — | **yes** |
| `vmail.spam_users.write` | `{ entries: [{ domain, username: arg.username, enabled: bool, threshold: 10..200 (score×10), autoDelete: bool }] }` | lsearch file read by the DATA ACL | no |
| `vmail.render.check` | `{}` | `doveconf -n` + `exim -bV` + reports whether the `whm_virtual_user` router and `dovecot_plain` authenticator are present (`{ dovecot, exim, routerHooked, authHooked, hint }`) | no |

Server-side rendering of the Dovecot drop-in `98-whm-virtual-auth.conf` (passdb/userdb
passwd-file, quota plugin scoped to the passwd-file userdb, `service auth { unix_listener
auth-client }`, LMTP) and the Exim `router`/`transport`/`auth` slots (`whm_aliases` redirect with
`forbid_pipe forbid_file`, `whm_domain_forward`, `whm_autoreply` with the no-loop condition,
`whm_virtual_user` → `whm_dovecot_lmtp`, `dovecot_plain/login` authenticators, `spamd_address` +
DATA-ACL spam block) belongs to **service-configuration** (owner of those files, contract §3–§4):
`ctx.web.applyVirtualMail({ enabled }, req)` is the seam (§8). `web.exim.include.write`'s slot enum
gains `router`, `transport`, `auth` in that unit; `web.dovecot.include.write` gains `{ name:
'98-whm-virtual-auth.conf' }` restricted to a whm-prefixed basename allowlist.

### 5.4 `ftp.*` (`agent/src/ops/ftp.js`, capability `ftp-virtual` → `pure-pw` or `ftpasswd`)

| Op | Schema | Execution | Destructive |
|---|---|---|---|
| `ftp.user.add` | `{ daemon: 'pure-ftpd'\|'proftpd', login: /^[a-z0-9][a-z0-9._@-]{0,63}$/, password: /^[^\n\0]{1,256}$/, username: arg.username, dir: arg.absPath, quotaMb: int\|null }` (uid/gid from `assertManaged(username)`; `dir` must pass `assertUnderHome(passwdHome(username), dir)`) | pure-ftpd: `pure-pw useradd <login> -u <uid> -g <gid> -d <dir> [-N <mb>] -m` with the password twice on stdin; proftpd: `ftpasswd --passwd --file /etc/proftpd/ftpd.passwd --name … --uid … --gid … --home … --shell /bin/false --stdin` | no |
| `ftp.user.passwd` | `{ daemon, login, password }` | `pure-pw passwd <login> -m` / `ftpasswd --passwd … --change-password --stdin` | no |
| `ftp.user.set_quota` | `{ daemon, login, quotaMb }` | `pure-pw usermod <login> -N <mb> -m`; proftpd → `unsupported` | no |
| `ftp.user.remove` | `{ daemon, login }` | `pure-pw userdel <login> -m` / `ftpasswd --passwd … --delete-user` | **yes** |
| `ftp.user.list` | `{ daemon }` | `pure-pw list` / parse `ftpd.passwd` (no hashes) | no |
| `ftp.sync` | `{ daemon }` | `pure-pw mkdb`; proftpd: no-op + reload | no |
| `ftp.virtual.status` | `{}` | reports whether PureDB (`conf/PureDB` or `-l puredb:`) / `AuthUserFile`+`AuthOrder` are enabled in the daemon config (read-only) | no |

Enabling PureDB / `AuthUserFile` in the daemon config is a **service-configuration** change
(`ctx.web.ftp.enableVirtualUsers(req)`, seam §8): `AuthOrder mod_auth_file.c mod_auth_unix.c`
keeps system-user logins working. vsftpd reports `supported:false`.

### 5.5 Other

| Op | File | Schema | Notes |
|---|---|---|---|
| `web.webmail.detect` | `agent/src/ops/webmail.js` (new file, read-only) | `{}` | probes `/usr/share/roundcube`, `/var/lib/roundcube`, `/etc/roundcube/config.inc.php`, `/usr/share/nginx/html/roundcube`, `/var/www/roundcube`, `/usr/share/rainloop`, `/usr/share/snappymail`; reports `{ installed, flavor, path, version, apacheAlias }` — never reads config contents; capability `webmail` |
| `backup.archive.read_range` | `agent/src/ops/backup-read.js` (new file) | `{ archive: arg.absPath (under the backup allowed roots, basename matches `READ_NAME` — a private const in `backup.js`, duplicated verbatim in the new file with a parity test), offset: int, length: int ≤ 8MiB }` | root-side `O_RDONLY\|O_NOFOLLOW` read like `acct.read_range` (reuse `assertRealPath` from `acct.js`); archives are root 0600 so there is no as-user path |

Agent error → HTTP mapping is unchanged (`middleware/error.js`); `refused` → 422,
`capability_missing` → 501, `path_not_allowed` → 403.

---

## 6. Client — `/panel` shell

### 6.1 Files

```
client/src/panel/nav.js               PANEL_CATEGORY_DEFS → buildNav(defs, { basePath: '/panel', keyPrefix: 'panel' })
client/src/panel/registry.js          import.meta.glob('../pages/panel/*/*.jsx')  (admin glob './fn/*/*.jsx' untouched)
client/src/panel/PanelLayout.jsx      auth gate + ShellContext + banners (acting-as, suspended, force-password)
client/src/panel/PanelSidebar.jsx     groups from PANEL_CATEGORIES, favorites key 'whm.panel.favorites'
client/src/panel/PanelTopBar.jsx      search over PANEL_FUNCTIONS, user menu (password, 2FA, sign out)
client/src/panel/PanelHome.jsx        dashboard (GET /api/panel/me, /usage)
client/src/panel/PanelPage.jsx        generic wrapper: PageHeader with ShellContext {home:'/panel', i18nPrefix:'panel'}
client/src/panel/hooks/usePanel.js    usePanelMe(), usePanelApi(path) (useApi with '/panel' prefix), useScopeBanner()
client/src/auth/home.js               homePathFor(user), inShellFor(user, pathname)
client/src/pages/panel/<group>/<fn>.jsx  pages (default export ({ fn }))
```

Pages (`client/src/pages/panel/…`): `overview/dashboard.jsx`, `overview/account.jsx`;
`domains/domains.jsx`, `domains/addon-domains.jsx`, `domains/subdomains.jsx`,
`domains/parked-domains.jsx`, `domains/redirects.jsx`; `dns/zone-editor.jsx`; `ssl/status.jsx`,
`ssl/install.jsx`, `ssl/certificates.jsx`; `files/file-manager.jsx`, `files/disk-usage.jsx`;
`email/accounts.jsx`, `email/forwarders.jsx`, `email/default-address.jsx`,
`email/autoresponders.jsx`, `email/spam.jsx`, `email/deliverability.jsx`, `email/webmail.jsx`,
`email/usage.jsx`; `databases/databases.jsx`, `databases/users.jsx`, `databases/remote-hosts.jsx`,
`databases/phpmyadmin.jsx`; `ftp/accounts.jsx`; `cron/cron-jobs.jsx`; `backups/backups.jsx`,
`backups/restore.jsx`; `logs/access-logs.jsx`, `logs/bandwidth.jsx`; `php/versions.jsx`,
`php/ini.jsx`; `security/password.jsx`, `security/two-factor.jsx`, `security/ssh-keys.jsx`,
`security/sessions.jsx`, `security/tokens.jsx`; `usage/usage.jsx`.

`buildNav` is extracted from `nav.js` lines 304-317 and used by `nav.js` itself with defaults so
the 212 admin keys/paths stay byte-identical (`client/test/nav.test.js` unchanged); `nav.js` stays
import-free ESM (`e2e/screenshot-all.cjs` imports it from Node). Panel keys are
`panel:<group>/<fn>`, paths `/panel/<group>/<fn>`.

### 6.2 Routing a `user` session to `/panel` (core follow-up: `router.jsx`, `Login.jsx`, `Layout.jsx`)

- `router.jsx`: add `{ path: '/panel', element: <PanelLayout/>, children: [index PanelHome,
  'change-password', ...PANEL_FUNCTIONS routes, '*'] }` **before** the admin `/` entry. Only
  hand-edited routing file, per CLAUDE.md.
- `Login.jsx` lines 38/51: `const from = location.state?.from; navigate(from && inShellFor(user,
  from) ? from : homePathFor(user))` where `homePathFor = u => u?.role === 'user' ? '/panel' : '/'`.
- `Layout.jsx`: after the `!user` check, `if (user.role === 'user') return <Navigate to="/panel"
  replace/>` (before the `mustChangePassword` branch).
- `PanelLayout`: `!user` → `/login` with `state.from`; `user.role !== 'user' && !me.actingAs` →
  `/`; `me.account.forcePasswordChange` or `user.mustChangePassword` → `/panel/security/password`;
  `me.policy.require2fa && !user.totpEnabled` → `/panel/security/two-factor`. No
  `PluginNavProvider`, no `LicenseBanner`/`RevocationBanner`, no `/audit-log` link. All
  `localStorage` access wrapped in try/catch (client tests render in plain node).
- Admin shell link: the WHM account list row menu and the Account Information page get a
  "Log in as" action (`POST /api/panel/admin/login-as/:username` → `window.open('/panel')`); the
  panel's acting-as banner "Exit" calls `logout-as` and closes/returns to `/`. The admin-shell
  additions are in `client/src/pages/fn/list-accounts/*`-adjacent files — done by the integrator.

### 6.3 i18n

- Keys `panel.<group>/<fn>.label|description`, `panel-category.<group>`, `panel.shell.*`,
  `panel.common.*` added to `client/src/i18n/en.json` (server base catalog; migration 011 mirrors
  `en`). `PageHeader` reads `ShellContext.i18nPrefix` (default `fn`) and `home` (default `/`);
  the one-line change to `Common.jsx` is an integrator item. `useT()` works unchanged for role
  `user` (`/api/locales/active` is auth-only).

### 6.4 Design system

The panel UI is being restyled: pages use **only** the shared kit from `client/src/components/`
(`Card`, `KeyValue`, `StatusPill`, `EmptyState`, `DataTable`, `Form.jsx` fields, `Modal`
confirm, `Toast`, `ProgressLog`, `Brand`) and `client/src/icons.js` (`iconFor`, `colorFor`); no
page-local CSS beyond `client/src/theme/base.css` classes and the tokens in
`docs/design/ui-design-system.md`. Raw tables are wrapped in `.table-wrap`; icons are imported by
name. The file manager's tree/list and the zone editor's inline rows are composed from
`DataTable` + `Form` controls rather than new primitives; new primitives, if unavoidable, are
proposed to the design-system owner rather than added to `components/` by the unit.

Capability states: every page renders the `EmptyState` install prompt on 501 (`error.capability`)
and a "pending" pill when a mutation returns `applied:false, reason:'capability_missing'` (dev
hosts).

---

## 7. Tests

### 7.1 Server (`server/test/panel-*.test.js`, vitest + supertest, `bootstrap()` with mock agent)

| File | Covers |
|---|---|
| `panel-identity.test.js` | migration 033 idempotent (run twice); `account.created` → users + link row; backfill; adoption of a demoted reseller row; `account.suspended/unsuspended` flips `users.suspended` + destroys sessions; terminate cascades; `syncPassword` and the admin password endpoint write both stores; login as the account user succeeds, `password_hash NULL` fails |
| `panel-scope.test.js` | role `user` without link → 403; cross-account ids/domains/zones/db names → 404/403 for every router (table-driven over all mutating endpoints with a foreign fixture); admin without acting-as → 403; `login-as` ownership + ACL + TTL + suspension + stale ownership revokes mid-session; refused endpoints while acting; audit rows carry `actingAs/by`; demo mode; force-password; `require_2fa_for_users`; API token scope confinement |
| `panel-domains.test.js` | addon/sub/parked create/delete call order (`ensureZoneForDomain` → `fs.mkdir` → row → `ensureVhost`), compensation when the row insert fails, `max_addons/max_subdomains` and feature gates, `domainHosted` 409, docroot pinning (`../`, absolute, symlink parent refused), redirects |
| `panel-dns.test.js` | NS/SOA stripped and refused; record types restricted; subdomain → parent zone resolution; foreign zone 404 |
| `panel-ssl.test.js` | `issueNow` with `force:false` only; `key` part never downloadable; 501 when provider disabled |
| `panel-files.test.js` | relPath validation table (`..`, leading `-`, NUL, absolute, 513 chars); upload registry begin/chunk/finish/abort + expiry; download chunk loop and `Content-Length`; archive/extract jobs; per-chunk audit suppression; `features.filemanager` gate |
| `panel-email.test.js` | mailbox create order (`ensureMailDomain` → hash → maildir → passwd → row) and compensation; `routing_not_applied` becomes a warning; forwarder destination regex (pipe/file/`${` refused); autoresponder header single-line rule; spam prefs rendering; usage post-filter (`notexample.com` excluded); `max_email` |
| `panel-databases.test.js` | prefix forced even with `db.prefixing=false`; membership pre-check for drop/password/grants/access-host; pg branch hides hosts; `engineError` surfaced; phpMyAdmin trimmed shape |
| `panel-ftp.test.js` | daemon branching, vsftpd 501, `max_ftp`, dir pinned under home, password never in argv (mock agent asserts `input`) |
| `panel-cron.test.js` | render/parse round-trip, env key regex, `@` schedules, 500-line cap, `refused` → 422, feature gate |
| `panel-backups.test.js` | `account_name` scoping, `kind:'account'` never enqueued, one running job per account, download range loop, upload→register with forced `account_name` |
| `panel-logs.test.js` | file name must come from the listing; tail offset math; domain filter |
| `panel-security.test.js` | password flow (current wrong → 401, both stores written, other sessions destroyed), ssh key regex, 2FA proxies, token scopes limited to `panel:*` |

### 7.2 Agent (`agent/test/<family>.test.js`, schemas only — ops with side effects are never run)

- `files.test.js`: every op rejects `..`, non-absolute, NUL, 10 001-entry limit, mode `0778`,
  `username` `-root`/`root`/`Admin`; `assertUnderHome` unit tests with a temp home containing a
  symlink to `/etc` (lexical pass, realpath refuse) and a not-yet-existing target; `asUser` builds
  the exact `setpriv` argv.
- `cron.test.js`: line validator table (`\r`, `${`, leading `-`, 6-field schedule, `SHELL=/bin/zsh`
  refused, `@reboot` accepted, 501 lines refused); argv order `['-u', user, '-']`; content on stdin.
- `vmail.test.js`: passwd line fields reject `:`/newline/`${`; hash must match `SHADOW_HASH`;
  alias targets reject `|cmd`, `/path`, `:include:`; autoresponder subject/fromName single line;
  domain regex.
- `ftp.test.js`: login regex, password via stdin, `dir` under the account's own home only (a
  sibling home under the same allowed root is refused), daemon enum, no `uid`/`gid`/`home` in
  the schema.
- `webmail.test.js` / `backup-read.test.js`: schema + READ_NAME basename check.

### 7.3 Client (`client/test/`, `renderToStaticMarkup` + `MemoryRouter`, no jsdom)

- `panel-nav.test.js`: unique keys/paths, every panel registry key ∈ `PANEL_FUNCTION_BY_KEY`,
  paths start with `/panel/`, `buildNav` with defaults reproduces the 212 admin entries
  (`deepEqual` against a snapshot of `FUNCTIONS`), `searchPanelFunctions('mail')` hits email.
- `panel-layout.test.js`: role `root` without acting-as renders `<Navigate to="/">`; role `user`
  renders the sidebar; `homePathFor` table.
- `nav.test.js`, `nav-hidden.test.js` untouched and still green.

### 7.4 e2e

- `e2e/panel-check.cjs` (Playwright): root creates account `demo<suffix>` with a password → `POST
  /api/panel/admin/accounts/:u/user` → sign out → sign in as the account user → lands on `/panel`
  (`.panel-home`) → visit every `PANEL_FUNCTIONS` path, settle on `.page-header`, console errors
  fail → file manager creates and deletes a folder → cron adds a job (dev container has
  `crontab`? if not, expects the 501 `EmptyState`) → "Log in as" from root opens `/panel` with the
  banner → cleanup via `DELETE /api/accounts/demo<suffix>`.
- `e2e/screenshots.sh` gains `panel-screenshot.cjs` output under `docs/screenshots/panel/`; the
  admin `screenshot-all.cjs` and its "all 212 function pages" README line stay as they are.
- `e2e/live-panel-flow.sh` (optional, provisioned host): mailbox IMAP login via `doveadm auth
  test`, FTP virtual login, crontab visible in `crontab -u … -l`.

---

## 8. Build plan

### 8.1 Units (parallel, disjoint files)

| Unit | Owns (new files only) | Depends on |
|---|---|---|
| **U0 core-panel** | `server/src/db/migrations/033_panel.sql`, `server/src/services/panel.js` (`createPanelService`: ensureUser/backfill/syncPassword/scope/login-as/settings), `server/src/routes/categories/panel.js` (entry: mounts `routes/panel/*.js` sub-routers, `panelScope` middleware, `/admin/*`), `server/src/routes/panel/index.js` helper (`relPath`, `panelRouter(ctx, name)`), `server/test/panel-identity.test.js`, `panel-scope.test.js` | nothing; **built first** (others code against the `scope` shape above and a stub) |
| **U1 files+cron** | `agent/src/ops/as-user.js`, `files.js`, `cron.js`, `agent/test/files.test.js`, `cron.test.js`, `server/src/services/panel-files.js`, `panel-cron.js`, `server/src/routes/panel/files.js`, `cron.js`, `security.js` (ssh keys use files ops), tests | U0 scope shape |
| **U2 mail** | `033b_panel-mail.sql`, `agent/src/ops/vmail.js`, `webmail.js`, tests, `server/src/services/panel-email.js`, `routes/panel/email.js`, tests | U0; seams S3, S4 |
| **U3 domains+dns+ssl+php+logs** | `server/src/services/panel-domains.js`, `panel-dns.js`, `panel-ssl.js`, `panel-php.js`, `panel-logs.js`, `routes/panel/{domains,dns,ssl,php,logs}.js`, tests | U0; seams S1, S2 |
| **U4 databases+ftp+backups+usage** | `033c_panel-ftp.sql`, `agent/src/ops/ftp.js`, `backup-read.js`, tests, `server/src/services/panel-databases.js`, `panel-ftp.js`, `panel-backup.js`, `panel-usage.js`, `routes/panel/{databases,ftp,backups,usage}.js`, tests | U0; seam S5 |
| **U5 client shell** | `client/src/panel/*`, `client/src/auth/home.js`, `client/src/pages/panel/overview/*`, `client/test/panel-*.test.js`, i18n keys (appended block in `en.json` — single owner), `e2e/panel-check.cjs` | API contract (§4) only; pages for the other groups are built by **U6 client pages** (one builder per group, `client/src/pages/panel/<group>/*` disjoint) after U5 lands the shell |
| **Integrator** | `router.jsx`, `Login.jsx`, `Layout.jsx`, `Common.jsx` (ShellContext), `nav.js` (`buildNav` extraction), admin "Log in as" action, `accounts.js` `syncPassword` hooks, the §3.5 router audit, seams below, `CHECKLIST.md`, `CLAUDE.md`, `HANDOFF.md`, screenshots | after U0–U6 |

Rule: units never touch `service-configuration.js`, `dns-functions.js`, `ssl-tls.js`,
`software.js`, `email.js`, `database-services.js`, `backup.js`, `accounts.js`, `auth.js` or any
shared file; what they need from those services is listed as a seam, implemented by the
integrator (or the owning category) and stubbed in unit tests.

### 8.2 Integration seams (binding; to be appended to `docs/design/integration-contracts.md` §33+)

| # | Seam | Owner | Consumer |
|---|---|---|---|
| S1 | `ctx.web.removeVhost(domain, req)` (web.vhost.remove + `web_vhosts` delete, audit) and `ctx.web.vhostsForAccount(username)` | service-configuration | U3 |
| S2 | `account_id` branch in ownership checks: `dns-functions` `visible()/accountForDomain()`, `ssl-tls` `resolveDomain()/visible()`, `software` `resolveDomain()`, `account-functions` `load()`, `email` `assertDomain()` accept `user.role==='user' && row.account_id === user.accountId`. **Until landed**, the panel delegates with `ownerPrincipal` after its own check — the seam only removes the delegation | each category | U2, U3 |
| S3 | `ctx.mail.ensureMailDomain(domain, accountId)` (upsert `mail_domains` routing `auto`) | email | U2 |
| S4 | `ctx.web.applyVirtualMail({ enabled }, req)` renders `98-whm-virtual-auth.conf` and the Exim router/transport/auth slots + spam DATA-ACL block; `web.exim.include.write` slots `router|transport|auth`; `web.dovecot.include.write { name }` allowlist | service-configuration | U2 (calls it idempotently in `register()` when `panel.enabled` and capabilities exist; reports `routerHooked/authHooked` from `vmail.render.check` as a Security Advisor finding when false) |
| S5 | `ctx.web.ftp.enableVirtualUsers(req)` (PureDB / `AuthUserFile`+`AuthOrder`) | service-configuration | U4 |
| S6 | `accounts.create` / `accounts.setPassword` → `ctx.panel?.syncPassword(username, password)` | accounts (integrator) | U0 |
| S7 | `ctx.events` subscriptions `account.created|suspended|unsuspended|terminated` | development (exists) | U0 |
| S8 | `ctx.ssl.autossl.lastEntryFor(domain)` | ssl-tls | U3 |
| S9 | `ctx.accountInfo.effectiveLimits(username, ownerPrincipal)` (exists) | account-information | U0 |
| S10 | reseller ACL key `login-as` added to the ACL catalogue (default off for new resellers) | resellers | U0 |
| S11 | `features.*` keys used, all present in `DEFAULT_FEATURES` (`server/src/db/seed.js`, not `packages.js`): `filemanager, emailaccts, forwarders, autoresponders, defaultaddress, spamassassin, mysql, postgres, phpmyadmin, addondomains, subdomains, parkeddomains, redirects, cron, ftpaccts, sslmanager` (SSL status/install/storage), `autossl` ("issue now"), `backup, phpversion, errlog, rawlog` (logs), `passwordchange, ssh` (SSH keys), `api` (tokens). There is no `sslinstall`/`zoneedit` key: the zone editor is gated by nothing but ownership (as WHM's "Edit DNS Zone" is for resellers) — a new `zoneedit` key, if wanted, is added to `DEFAULT_FEATURES` by the integrator. Missing keys default **true** (cPanel semantics) | packages | all |

### 8.3 Review plan

- **Two lenses** (privileged / signing-grade): U0 (`scope()`, login-as, password sync), U1
  (`as-user.js`, `files.*`, `cron.*`), U2 agent side (`vmail.*` file rendering: Exim expansion
  injection, passwd-file field injection), U4 agent side (`ftp.*`, `backup.archive.read_range`),
  seam S4 (router ordering: `whm_virtual_user` must precede `local_user`/`userforward`; passdb
  ordering `result_success`). Lens A: adversarial tenant (symlink races, TOCTOU between service
  check and agent exec, argv/stdin injection, quota bypass, cross-account names). Lens B:
  authorization completeness — every endpoint in §4 enumerated with its §3.2 pre-check and the
  principal it delegates with; any delegation with `SYSTEM_ROOT` on a mutating path is a blocking
  finding.
- **One lens**: U3 services (delegation correctness only; the root-level work is in existing
  services), U5/U6 client, docs, i18n, e2e.
- One fix round + one re-review per unit (token-economy default); a second round only for
  blocking findings. Integration critic once, after the integrator lands the seams, with the §3.5
  router audit as its first item. Full gate before merge: `npm test` (server/agent/client), vite
  build, `e2e/ui-check.cjs` (admin regression), `e2e/panel-check.cjs`, then screenshots.

---

## 9. Open questions (with recommended defaults)

1. **Link table vs. `users.account_id` column.** Default: `account_users` table (idempotent
   migration, no ALTER on a core table, room for `password_synced_at`). Revisit only if a join per
   request shows up in profiling (it will not: one indexed lookup).
2. **Adopt demoted-reseller rows with the same username?** Default: adopt and audit
   (`resellers.reset()` documents "keeps its login for that account"); never create a second
   role-`user` row with that username (UNIQUE would refuse anyway).
3. **Where does the WHM password change sync the panel hash?** Default: S6 hook in `accounts.js`
   (two lines, integrator). Fallback until then: `/api/panel/admin/accounts/:u/password`. Never a
   PAM/`unix_chkpwd` verify op.
4. **Should root/resellers be allowed to open `/panel` without impersonating?** Default: no
   (`panel_scope_required`); impersonation is the only path, so every admin view is time-boxed and
   audited.
5. **Reseller ACL for "Log in as".** Default: new key `login-as`, off by default for existing
   resellers (root enables per reseller); root always allowed.
6. **Forced 2FA for customers.** Default: panel setting `panel.require_2fa_for_users=false`,
   enforced panel-side; not a core `needsEnrollment` change.
7. **Prefix enforcement when `db.prefixing=false`.** Default: panel always prefixes
   `<username>_` and documents the divergence from the WHM page.
8. **Subdomain docroot convention.** Default: `<home>/public_html/<label>` (cPanel-like, matches
   backup restore), stored explicitly in `account_domains.docroot` so `specsFor`'s fallback is
   never relied on.
9. **Autoresponders: Exim `autoreply` vs Dovecot Sieve.** Default: Exim autoreply transport
   (host-independent, works without the sieve plugin); Sieve `vacation` deferred.
10. **Mailbox hash scheme.** Default: SHA512-CRYPT (`doveadm pw` or `openssl passwd -6`), stored
    in `mail_accounts.password_hash`; bcrypt `{BLF-CRYPT}` not used (libc support not verified).
11. **Per-recipient spam thresholds.** Default: first-recipient semantics in the DATA ACL, documented
    as a limitation; PRDR deferred.
12. **FTP virtual-user login format.** Default: `<login>@<main-domain>` on pure-ftpd (cPanel
    convention), `<login>_<username>` on proftpd (`ftpasswd` names cannot contain `@` safely);
    vsftpd: system user only.
13. **Upload transport.** Default: base64 JSON chunks at 1.8 MB (reuses the transfers pattern and
    the existing rate limits); an `express.raw` octet-stream route is a later optimisation.
14. **Backup downloads for customers.** Default: allowed for panel-generated archives only
    (`retention_class='panel'`), root-side `read_range` op; scheduled system backups stay
    WHM-only.
15. **Plugin pages inside `/panel`.** Default: deferred; plugin HTTP routes can already target role
    `user` via `ctx.http.*({ roles:['user'] })`, UI audience needs an SDK bump.
16. **Behaviour when `panel.enabled=false`.** Default: `/api/panel/*` (except `/admin/settings`)
    returns 403 `panel_disabled`, `/panel` shows a disabled page; account-user rows are still
    created so enabling later needs no backfill.
