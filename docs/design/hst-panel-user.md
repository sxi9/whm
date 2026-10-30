# HST Panel — the customer side (design of record)

Owner's ask (2026-10-30): "work on the user side cPanel account side … our panel name is HST Panel; cPanel is the
reference for the WHM side, Hostinger hPanel for the customer side (UI and features)". This document is the
contract for building it. The admin side (WHM) stays as it is; everything here is the hosted account's own panel.

## 1. Principals and access

- **Who logs in:** the `user` role (`users.role = 'user'`), one panel user per hosting account, linked by
  `accounts.id` ↔ `users.account_id` (migration `040_hst-user.sql` adds `users.account_id INTEGER REFERENCES accounts`
  and `users.force_password_change` reuse). Created automatically on account creation (`accounts.create` →
  `ctx.hstUsers.ensureForAccount(account, { password })`; the account's Linux password doubles as the first panel
  password unless a separate one is given), removed on termination, locked on suspension (login answers
  `account_suspended` with the reason, no panel access).
- **Where:** the same ports (2086/2087) and the same SPA bundle; after login a `user` lands on `/hst` (the customer
  shell) and never sees the WHM shell: `Layout.jsx` routes by role. Resellers/root may **impersonate** an account
  ("Log in as") through `POST /api/accounts/:username/impersonate` → a short-lived session flag
  `impersonating = { by, until }` shown as a banner; audited; impersonation never grants the customer more than the
  account has.
- **RBAC:** every customer endpoint is `requireUser` (role user **or** an impersonating root/reseller) and every
  service method resolves the account from the principal (`ctx.hst.accountOf(req)`), never from a request field.
  Package limits and feature lists (`feature_lists`) gate what a customer may use: a disabled feature hides the card
  and answers `403 feature_disabled`.
- **Security:** same session policy as WHM (CSRF, rate limits, optional 2FA, verified-IP), no API tokens for users in
  wave 1, audit rows with `principal = <username>` and `role = user`.

## 2. Information architecture (hPanel-style)

Left navigation (collapsible) with these sections; the dashboard is the home. Function pages live under
`client/src/pages/hst/<section>/<page>.jsx`, registered from `client/src/hstNav.js` (same pattern as `nav.js`:
single source of truth for sections, pages, routes, search; `client/test/hst-nav.test.js` checks counts).

| Section | Pages (wave) | Backed by |
|---|---|---|
| **Home** | Dashboard: website cards (domain, SSL state, PHP version, visits), usage meters (disk/bandwidth/inodes from `account_bandwidth` + `disk_used_mb`), quick actions, account manager card + unread support messages (1) | `ctx.accounts`, `ctx.accountInfo`, `ctx.supportChat` |
| **Websites** | Domains (main/addon/sub/parked: add/remove — the V1 service `accountFunctions.domains`), Redirects (`web.redirects` per domain), PHP version per domain (`software.php.setDomainVersion` scoped), Error pages, Hotlink/Index protection (1) | `ctx.accountFunctions`, `ctx.web`, `ctx.software` |
| **Files** | File Manager (browse/upload/download/rename/move/copy/delete/compress/extract/permissions/edit text, chrooted to the home, everything through agent ops that run as the account: new family `fs.user.*` with `runuser`), Disk usage, FTP accounts (`ftp.*` service: add/password/quota/delete), Backups: create/download account backup, restore from a backup, cloud copies when the admin allows (1) | new `agent/src/ops/fsuser.js`, `ctx.ftp` (service-configuration/ftp), `ctx.backup` |
| **Databases** | MySQL/MariaDB databases + users + privileges, Remote MySQL hosts, phpMyAdmin single-sign-on link (if installed), PostgreSQL when the host has it (1) | `ctx.databases` (account-scoped methods already exist for resellers; add the user scope) |
| **Email** | Accounts (create/password/quota/delete), Forwarders, Autoresponders, Filters, Spam settings, DKIM/SPF status + "fix" (publishes records), Webmail link, Mail client settings page (2) | `ctx.mail`, `ctx.dns` |
| **Domains › DNS** | Zone editor for the account's domains (A/AAAA/CNAME/MX/TXT/SRV/CAA, TTL), Cloudflare mirror state when linked (2) | `ctx.dns` (ownership checks exist) |
| **Security** | SSL/TLS (status per domain, AutoSSL run now, upload own certificate, force HTTPS toggle per domain), SSH access (keys, enable/disable when the package allows a shell), IP blocker, Password & 2FA for the panel login, Directory privacy (2) | `ctx.ssl`, `ctx.security` (ssh keys per user: new `sec.user_keys.*` ops as the account), `web.customDirectives` |
| **Advanced** | Cron jobs (account crontab through `cron.user.*` as the account), Apache handlers/MIME (customDirectives subset), Error log viewer (domlogs tail), Raw access logs download, Terminal (web shell as the account, when the package allows) (2) | agent ops as the account |
| **Apps** | Application Manager for the account (own apps only: create/deploy/logs/restart — reuses `ctx.apps` with the user scope), WordPress toolkit (installs on own domains, updates, staging later), one-click installers (WordPress, Laravel, Node/Express, Flask starters) (2) | `ctx.apps`, bundled WP Toolkit plugin |
| **Statistics** | Bandwidth + visitors (from the statistics software when installed; else domlog-derived counters), Resource usage history (3) | `ctx.accountInfo`, `ctx.serverStatus` |
| **Support** | Conversation with the account manager (reuses `ctx.supportChat` with the user scope — the "user side" the owner asked for), knowledge base links, server status page (1) | `ctx.supportChat`, `ctx.support` |
| **Account** | Profile + contact email + language, Password change, 2FA, Login history, Account manager details, Usage & limits, Billing links (hub later) (1) | `ctx.auth`, `ctx.accounts` |

Waves: (1) first — the shell, dashboard, websites/domains, files, databases, support, account; (2) email, DNS,
security, advanced, apps; (3) statistics and polish. Each wave: builders per section with disjoint files, two review
lenses on anything that runs as root or touches another tenant's data, one fix round, full gate, screenshots.

## 3. Look and feel

- Reference: Hostinger hPanel's clean cards, big primary actions, status chips, and a left sidebar with sections;
  cPanel's density is not the goal. Reuse the panel's component kit (`client/src/components/*`) and theme tokens;
  branding from `client/src/brand.js` and the admin's Customization settings (`/api/branding`).
- Mobile first: the sidebar collapses to a drawer; every table has a card layout under 720 px.
- Every destructive action confirms with the object's name; every long operation streams its job log inline.
- Empty states explain what the page does and how to start (hPanel style), never a bare table.

## 4. Backend seams (binding)

- `ctx.hst` (new service `server/src/services/hst.js`): `accountOf(req)`, `requireFeature(account, feature)`,
  `limits(account)` (package snapshot + usage), `ensureForAccount(account, opts)` / `removeForAccount`,
  `impersonate(username, actor, req)`.
- Routes under `/api/hst/*` (one router per section under `server/src/routes/hst/<section>.js`, auto-mounted by
  `routes/index.js` after auth like `routes/categories/*`; middleware `requireUser` from `middleware/rbac.js`).
  Everything a page needs is served there, even when the logic lives in an admin service: the hst route calls the
  admin service with the resolved account and the user principal; admin services gain `forAccount`-style methods
  only where their existing reseller scope is not enough.
- Agent ops that act inside the home run **as the account** (`runuser -u <user> --`), never as root: file manager
  (`fsuser.*`), crontab (`cron.user.*`), SSH keys (`sec.user_keys.*`), terminal (`terminal.open` with `user`).
  Paths are validated against the account's real home (realpath, no symlink escape), sizes capped (uploads through
  the panel ≤ 512 MB per file, editor ≤ 4 MB), archives extracted as the user with device/special files refused.
- Jobs started from the customer side carry the account's user id as `created_by` so the user can follow them
  (`GET /api/hst/jobs/:id` mirrors the system jobs endpoints, scoped).
- Events: `hst.user.created|removed|login`, `account.suspended` locks sessions; `support.message` unread badge.
- Emails: welcome mail with the panel URL on account creation (Contact Manager template `account.welcome`),
  password resets through the existing reset flow (magic link, 30 min).

## 5. Data model additions

```sql
-- 040_hst-user.sql
ALTER TABLE users ADD COLUMN account_id INTEGER REFERENCES accounts (id) ON DELETE CASCADE;   -- guarded 0NNb pattern
CREATE INDEX IF NOT EXISTS idx_users_account ON users (account_id);
CREATE TABLE IF NOT EXISTS hst_sessions_impersonation (sid TEXT PRIMARY KEY, actor_user_id INTEGER NOT NULL, account_id INTEGER NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ftp_accounts (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE, username TEXT NOT NULL UNIQUE, home TEXT NOT NULL, quota_mb INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS hst_login_history (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, ip TEXT, ua TEXT, ok INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
```
Email accounts, databases, DNS zones, SSL certificates, apps and support threads already have tables keyed by
`account_id` or `username`.

## 6. Tests and gate

- `server/test/hst-*.test.js`: every section's routes with a `user` principal of account A must never read or change
  account B (by id, username, domain, path, job id); impersonation audit; feature gating; suspension lock.
- `agent/test/fsuser.test.js`, `cron-user.test.js`, `user-keys.test.js`: schema rejections, path escape refusal,
  runuser argv, archive safety.
- `client/test/hst-*.test.jsx`: nav counts, dashboard renders with empty data, file manager actions call the right
  routes; `e2e/ui-check.cjs` gets a customer flow (create account → log in as its user → dashboard → files →
  database → support message) and `e2e/screenshot-all.cjs` captures every `hstNav.js` page under
  `docs/screenshots/hst/`.
- Manual: `docs/MANUAL-partC.md` "HST Panel for customers" (every page), `docs/INSTALL.md` note on the customer login
  URL and the welcome mail.
