# CLAUDE.md — project memory & working context

This file is loaded automatically by Claude Code at the start of every session. It is the
project's persistent memory: what we are building, the decisions already made, the
conventions to follow, the current state, and how to resume. **Keep it current: update
"Current state", `CHECKLIST.md` and `HANDOFF.md` (the brief for any other AI or engineer taking
over — user ask 2026-10-27) before every push.**

## What this project is

A production-grade, self-hostable **WHM (WebHost Manager) clone** — the cPanel server-admin
panel — that administers a **real Linux server**: Linux users and quotas, Apache/NGINX
vhosts and PHP-FPM, BIND DNS, Exim/Dovecot mail, MySQL/MariaDB, FTP, SSL/ACME, systemd
services, IPs, firewall, backups, transfers, resellers. It reproduces the entire WHM
interface (`trywhm.net`): **30 sidebar categories, 212 functions**, plus the home dashboard, plus our own 31st category **Application Manager** (3 functions: Node.js/Python/static-frontend apps, runtime versions, templates — 215 functions in total); it also serves the home
dashboard. It will also be **resold**: a license server, a plugin marketplace with
verified developers, and bundled plugins are part of the product (deferred to Phase 5).

- Design of record: `BLUEPRINT.md` (architecture, data model, security model, agent op
  families, API conventions, every function specified, roadmap).
- Live tracker: `CHECKLIST.md`.
- Deferred designs: `docs/design/license-server.md`; SDK reference code in `plugins/sdk/`.

## Decisions already made (do not re-litigate)

| Date | Decision |
|---|---|
| 2026-10-25 | **Real server control, production-grade** — not a mock/demo. Every function performs real operations on the host when the subsystem exists. |
| 2026-10-25 | Stack: **Node.js 22 + Express 4 + better-sqlite3 (WAL) + React 18/Vite + React Router 6 + zod**. SQLite for the panel's own data (works even while the managed MySQL is down). |
| 2026-10-25 | **Privilege separation**: non-root `whm-panel` API process + root `whm-agentd` executing an allowlisted op catalog over a Unix socket. `WHM_MODE=monolithic` runs both in one root process using the same op modules. |
| 2026-10-25 | **All 212 WHM functions** must exist (sidebar entry, route, page, API endpoint, service). None omitted. |
| 2026-10-25 | Build order: Phase 0 foundation → P1 shell → P2 core hosting → P3 security/mail/SSL → P4 resellers/IP/backup/transfers → P5 software/platform **+ license server + marketplace + plugins (deferred here by the user)** → P6 hardening/deploy. |
| 2026-10-25 | License server, plugin marketplace (open developer registration, **backend verification before publishing**), sample plugin and automated-backup plugin: **do at the end**, build on what's already saved rather than regenerating. |
| 2026-10-25 | Panel ports mirror WHM: HTTP 2086, HTTPS 2087. |
| 2026-10-27 | **Phase 5 layout:** one hub process `whm-hub` (`hub/` workspace `@whm/hub`: `hub/src`, `hub/shared`, `hub/license`, `hub/marketplace`, `hub/ui`), JSON config `/etc/whm-hub/hub.conf`, unit `deploy/whm-hub.service`, ports 7443 (public) / 7440 (loopback). `docs/design/license-server.md` §16.1 paths are superseded by the errata table in `docs/design/phase5-build-plan.md`. |
| 2026-10-27 | **Signing:** `kid` = first 8 hex of sha256(raw Ed25519 public key) for license, plugin-signing and developer keys; tokens and `X-WHM-Signature` use base64url, package signatures (`SIGNATURE.json`, `DEV-SIGNATURE.json`) use standard base64 with padding — what the host decodes. `signing_keys` (with `purpose`) lives only in license.db, used through `ctx.keys`. |
| 2026-10-27 | **Panel identity:** `ctx.license` owns the hub URL (token `iss`, bootstrap `WHM_LICENSE_HUB_URL`) and the license key (License tab only); the Market Provider `whm-hub` row is just an enable switch (`hub_mismatch` if its origin differs). Enforcement gates (degraded 423, feature gates, capacity) run only when `config.licenseEnforce` is true (default true under `NODE_ENV=production`, false in dev/tests). |
| 2026-10-27 | **Plugins distribution:** the three monitoring/security/WordPress plugins **and the automated-backup plugin** are bundled (`plugins/bundled/*`, installed at boot, exempt from `plugins.require_signature`); the sample plugin `net.whm.sample-notes` is marketplace-distributed under the vendor developer `net.whm`. Marketplace installs go through the host's additive `install(input, { policy: { requireSigned, signers, activate: false, expectedId } })`; consent is compared against the installed, signature-verified manifest. |
| 2026-10-27 | `hub/ui` **copies** the panel's component kit (`hub/ui/src/components/SYNC.md` records the source commit) instead of importing across packages. Hub tests are `node --test`; hub/ui and the panel use vitest. |
| 2026-10-29 | **Product naming:** the hosted-account side is **HST Panel** by Hostingsignal; the admin side keeps the WHM name; `client/src/brand.js` is the source of the names (the sidebar category "cPanel" is labelled *HST Panel*). Slugs, keys, routes, settings and file names keep the `cpanel` identifiers (nav.js explicit-slug entries); branding defaults ship as migrations (`029c`, `011b`). |
| 2026-10-29 | **Super admin:** `users.superadmin` (migration `001e`) is set only by `whm-cli superadmin <user>` after the setup password verifies against `/etc/whm/superadmin.key` (bcrypt, `0600 root:root`, written by `superadmin --init` / the installer; the panel process never opens it). Only that user sees the license hub, key, activations and hub answers (License tab, marketplace client, Market Provider Manager, audit text); other roots get `403 superadmin_required` and a *managed by the panel owner* card. Panel hub default `https://licserver.hostingsignal.in` (`config.licenseHubUrl`, installer prompt default); hub portal admins must enrol TOTP (`hub.require_totp_for_admins`, default true). |
| 2026-10-29 | **HTTPS by default:** `panel.force_https` (2086 → 301 to 2087; `WHM_FORCE_HTTPS=false` / `forceHttps` pins it off) and `web.force_https` (every vhost with a certificate redirects HTTP → HTTPS, `<IfModule mod_rewrite.c>`, ACME path exempt). The panel's TLS pair is `/etc/whm/tls/cert.pem` + `key.pem` (`whm.conf.example`, `install.sh`, agent `ssl.service_cert.install` for `panel`, `watchTlsFiles` reloads it); a hostname change publishes A/AAAA/www/MX, renders the branded landing vhost (`ctx.web.ensureHostnameVhost`, hostname never a hosted domain: `ctx.web.isServerName`) and issues the hostname certificate for panel/Exim/Dovecot/FTP with a daily renewal schedule. |
| 2026-10-30 | **Stack installs** come from one catalog, `server/src/lib/stack-catalog.js`: the setup wizard, Service Manager › Server stack, `POST /api/system/stack/install` (`ctx.stack`) and `scripts/install.sh --stack full|web|none` / `--components …` all read it; never hard-code package lists elsewhere. |

## Non-negotiable conventions

**Security (this software runs as root):**
- Never build a shell string. All system calls go through the agent's `exec(bin, argv[])`
  (`child_process.execFile`), with the binary from an allowlist and every argv element
  validated by a zod schema in `server/src/lib/validate.js` / the op's schema. No `exec`,
  no template-string commands, ever.
- Every HTTP endpoint validates `params`/`query`/`body` with zod via `validate()`.
  Every agent op validates its args with its own schema. Unknown ops are rejected.
- RBAC on every route: `root` (all), `reseller` (owned accounts + delegated ACLs only),
  `user` (own account; phase 2). Re-check ownership inside services, not just middleware.
- Secrets at rest are encrypted with `lib/crypto.js` (AES-256-GCM, key in
  `$WHM_DATA_DIR/master.key`). Tokens are stored only as SHA-256 hashes. Passwords bcrypt.
- Every privileged/mutating action writes an `audit_log` row (principal, role, IP, action,
  target, redacted args, result).
- Session cookies `httpOnly`/`sameSite=lax`/`secure` when TLS (`lax`, not `strict`: the OIDC
  callback `GET /api/auth/external/:name/callback` is a cross-site top-level navigation that must
  carry the session holding the state and nonce, and real browsers drop a `strict` cookie there;
  mutations stay protected by the CSRF token); CSRF token on all mutations; rate limits on auth.
- Path inputs: absolute, no `..`, and services pin them under an allowed root.
- A missing subsystem (BIND, Exim, MySQL…) must raise `CapabilityError` → the UI shows an
  install prompt. It must never crash a page or fail opaquely.

**Code style:**
- ES modules, 2-space indent, single quotes, semicolons. Match surrounding code.
- Layers: `routes/` (thin: validate → service → envelope) → `services/` (all logic, DB,
  agent calls, audit) → `lib/agent-client.js` → `agent/src/ops/*` (execFile/templates).
  Routes never touch the DB or the agent directly.
- API envelope: success `{ data, meta }`; error `{ error: { code, message, fields? } }`.
  Lists paginate with `?page&pageSize&q&sort&dir` → `meta: { page, pageSize, total }`.
  Long operations return `202 { data: { job: { id } } }`.
- Frontend: `client/src/nav.js` is the single source of truth for categories, functions,
  routes and page keys. The router and sidebar are generated from it; never hand-add a
  route elsewhere. Pages live in `client/src/pages/<category-slug>/`.
- Comments only for constraints the code can't express. No comments narrating changes.
- Tests: vitest (unit, API via supertest with a temp SQLite DB and a mock agent); agent op
  schemas must have injection/traversal rejection tests. Run `npm test` before pushing.
- Commits: conventional prefixes (`feat:`, `fix:`, `docs:`, `wip:`, `test:`, `chore:`).
  Never put model names in commit messages, PR text, or code comments.

## Token economy (user ask, 2026-10-27 — keep the process lean)

What costs the most, measured over this build: category builders ~40 %, adversarial reviewers +
fix rounds ~45 % (they found real security defects in every wave — keep them, but one fix round
and one re-review is the default from here; a second round only for blocking findings),
integration critics ~5 %, everything else (snapshots, check-ins, status replies) < 10 %.
Defaults from now on:
- **Screenshots:** regenerate only at a phase milestone or when the user asks — not after every fix
  round (the capture itself is cheap in tokens, the commits are 24 MB each).
- **Keep-alive check-ins:** hourly, one short line, no narration unless something needs a decision.
- **Reviews:** two lenses for code that runs as root or signs/verifies anything; one lens for UI,
  docs and deploy work. Skip the integration critic for single-unit changes.
- **Reports to the user:** lead with the outcome, numbers once, no restating history.
- **Snapshots:** keep (a few hundred tokens each; they saved the work twice on container restarts).

## Category module contract (how every one of the 30 categories plugs in)

Nothing is registered by hand in shared files. Adding a category = adding files:

| Piece | Where | Discovered by |
|---|---|---|
| Bundled plugin (Plugins category) | `plugins/bundled/<id>/{plugin.json,main.js,test/}` validated by `plugins/sdk/validate-manifest.js`, tested with `plugins/sdk/mock-host.js`, installed/enabled by the category's `register(ctx)` via `ctx.plugins.install({ dir })` (idempotent) | `ctx.plugins` (core host) |
| Agent ops (privileged) | `agent/src/ops/<family>.js` — `defineOp('family.op', { schema, run, destructive })`, import `defineOp, arg, OpError` from `./registry.js`, `exec`/`hasBinary` from `../exec.js` | `agent/src/ops/index.js` auto-imports every file in the dir |
| DB tables | `server/src/db/migrations/0NN_<category-slug>.sql` (number assigned per category; `CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE` for defaults) | migration runner at boot |
| Service | `server/src/services/<category-slug>.js` → `createXService(ctx)`; attach in register as `ctx.<shortName>`; use other services via `ctx.<name>` **inside methods only** | — |
| Routes | `server/src/routes/categories/<category-slug>.js` → `export async function register(ctx) { …; return { path: '/<prefix>', router } }` (see that dir's README) | `routes/index.js` auto-mounts after auth |
| Jobs / schedules / capabilities | inside `register(ctx)`: `ctx.jobs.register(type, handler)`, `ctx.scheduler.ensure(name, cron, type)`, `ctx.capabilities.register(cap, { binaries, required })` | — |
| Pages | `client/src/pages/fn/<category-slug>/<function-slug>.jsx` default-exporting a component `({ fn })`; shared UI in `client/src/pages/<domain>/` | `pages/registry.js` via `import.meta.glob` |
| Tests | `server/test/<category-slug>.test.js` (vitest + supertest, boot via `bootstrap()` with a mock agent), `agent/test/<family>.test.js` (schemas reject injection; ops with side effects are never executed in tests) | `npm test` |

Per-op agent rules: args schema must reject anything not strictly needed (use `arg.*`
from `registry.js`); `exec(bin, argv[])` only; paths pass `ctx.assertAllowedPath()`; mark
`destructive: true` on anything that deletes/stops; return structured results.
Per-route rules: `requireRoot` for server-wide config and anything touching other
accounts, `requireReseller` + ownership check in the service for account-scoped reads;
long operations `202 { data: { job } }` via `ctx.jobs.enqueue`; `CapabilityError` when
the daemon is missing. Function keys/labels come from `client/src/nav.js` — a category's
list: `node --input-type=module -e "import {CATEGORIES} from './client/src/nav.js'; console.log(JSON.stringify(CATEGORIES.find(c=>c.slug==='dns-functions').functions.map(f=>[f.key,f.label,f.description]),null,1))"`.
Never edit `CHECKLIST.md`, `nav.js`, `registry.js`, `routes/index.js`, `ops/index.js`,
`app.js`, `index.js` or another category's files from a category task.

### Integration contracts (binding; full text in `docs/design/integration-contracts.md`)
- **Services on ctx:** `ctx.security`, `ctx.dns`, `ctx.databases` (never `ctx.db`, that is the
  SQLite handle), `ctx.ip`, `ctx.ssl`, `ctx.mail`, `ctx.software` (+ alias `ctx.pkg`),
  `ctx.web` (service-configuration: vhosts, PHP-FPM, Apache/Exim/Dovecot/FTP config),
  `ctx.development`, `ctx.locales`, `ctx.accounts`, `ctx.packages`, `ctx.system`,
  `ctx.serviceManager`, `ctx.auth`, `ctx.settings`, `ctx.jobs`, `ctx.scheduler`,
  `ctx.capabilities`; wave 2: `ctx.accountFunctions`, `ctx.accountInfo`, `ctx.multiAccount`,
  `ctx.resellers`, `ctx.backup`, `ctx.transfers`, `ctx.serverStatus`, `ctx.systemHealth`,
  `ctx.serverConfig`, `ctx.networking`, `ctx.contacts`, `ctx.systemReboot`; 2026-10-29: `ctx.apps` (Application Manager). Reference lazily inside
  methods; tolerate absence. Hooks core relies on: `resellers.assertAcl/createPolicy/modifyPolicy/
  nameserversFor`, `accountFunctions.mountpointFor/renderTemplate/runBandwidthEnforce/resetBandwidth`,
  `serverConfig.profile.summary()`, `contacts.notify(event, payload)` / `contacts.sendMail(...)`.
- **Wave-3 seams (binding, `docs/design/integration-contracts.md` §22–32):** cluster tokens carry `clustering:dns`
  or `clustering:config` and are confined to their endpoints via `ctx.confinedScopes`; inbound config pushes are
  opt-in and honour the receiver's group selection; cPanel's upgrade check goes through `ctx.software.panel.*`
  (feed `sha256`/`signature`/`keyId` kept); support grants never come from API tokens; `packages.theme` must be
  an enabled theme (`ctx.themes.isEnabledSlug`); `ctx.events` is created by core only.
- **Wave-2 seams (binding, `docs/design/integration-contracts.md` §11–21):** account-information owns
  bandwidth collection + `account_bandwidth`, account-functions owns enforcement/reset; software's
  `os-update-check` is the only update schedule; IP changes use `ctx.web.replaceIp` (ensureVhost's
  `php_missing`/`php_pool_failed` is a warning, not a vhost failure); long ops pass `timeoutMs`;
  untrusted archives/rsync never recreate device nodes as root; restores replay only grants for
  databases the account owns; migration `012` is shared by account-functions and development (documented
  exception — never reuse a number).
- **Remote service IP hooks:** `ctx.mail.setOutboundAddresses`, `ctx.dns.setOutboundAddresses`,
  `ctx.databases.setClientAddresses` ({ ipv4, ipv6 }); ip-functions is the caller.
- **Dovecot:** service-configuration owns `97-whm-mailserver.conf` (protocols, limits, `ssl=`,
  min protocol, ciphers); ssl-tls writes only cert/key/ca paths in `90-whm-ssl-cert.conf`; TLS
  presets go through `ctx.web.applyMailserverTls` / `ctx.web.applyEximTls`.
- **Exim local RCPT ACL:** service-configuration owns the macro/include and its ACL file ends
  with `.include_if_exists …/acl-email-filters.conf`; email writes only that file
  (`ctx.web.ensureEximAclChain()` first). Shared layout detection: `agent/src/ops/exim-layout.js`.
- **Migrations are immutable once committed** — add `0NNb_<slug>-<topic>.sql`, idempotent.
- **Host first, DB second:** run the agent op, then commit the SQLite change (or compensate).
- **Agent error → HTTP** (`middleware/error.js`): capability/binary missing 501, invalid_args 422,
  not_found 404, exists 409, path_not_allowed/unknown_op 403, agent_unavailable/timeout 503,
  `invalid_*`/`*_mismatch`/config_invalid/refused/acme_failed/unsupported/in_use → 422.
- **Schedules** must not enqueue jobs that will be skipped; toggle `enabled` with the feature.

## Repository layout

```
BLUEPRINT.md  CHECKLIST.md  CLAUDE.md  README.md  .env.example
server/   Express API + services + agent client        (npm workspace @whm/server)
agent/    whm-agentd: op catalog + privileged executor  (npm workspace @whm/agent)
client/   React SPA (Vite)                              (npm workspace @whm/client)
plugins/  plugin SDK (plugins/sdk/) + bundled plugins   (Phase 5)
hub/      license server + marketplace services        (Phase 5)
docs/design/  saved design sections awaiting integration into BLUEPRINT.md
scripts/  install.sh, admin CLI        deploy/  systemd units
```

## Running

```
npm install                       # all workspaces
cp .env.example .env              # dev defaults: monolithic mode, ./data, port 2086
npm run dev                       # API (node --watch) + Vite dev server with /api proxy
npm test                          # all workspaces
npm run build && WHM_SERVE_CLIENT=true npm start   # production-style single process
```
First boot seeds the `root` admin; the password comes from `WHM_ADMIN_PASSWORD` or is
generated into `$WHM_DATA_DIR/initial-admin-password.txt`.

## Current state (update every push)

- **2026-10-30: platform-fixes integration round.** Unit I4 landed the agent op `web.module.enable` (`agent/src/ops/web.js`,
  tests in `agent/test/web.test.js`), `install.sh --stack`/`--components` + the HST Panel banner, the panel TLS pair at
  `/etc/whm/tls/{cert,key}.pem` (legacy `/etc/whm/ssl/panel.*` migrated on `--upgrade`), `WHM_FORCE_HTTPS` in the deploy
  templates, and the docs for every round-1 unit (MANUAL A/B, INSTALL, README, contracts §34, CHECKLIST issue table).
  Open after this unit (see the integrator notes): the agent's `panel` certificate branch must leave `key.pem` readable
  by the panel's service group; `whm-cli install-stack` is not built (the installer flags cover the CLI ask).
- **2026-10-30 05:10 (session `claude/pensive-curie-9r0rcx`, owner asks of 2026-10-29: app hosting → issue list → full
  audit):** Phase-6 verifier run → 11 findings fixed (`50d0f14`); **category 31 Application Manager** (`81417ea`);
  **owner's 26-item issue list round 1** (`bf181a0`: installer profiles + install-from-panel + setup wizard, HTTPS by
  default + hostname DNS/certificate + branded landing, super admin + hidden hub + hub TOTP, external-auth presets,
  Cloudflare DNS, account manager + Support › Account Conversations (216 functions), terminal latency, quota page,
  HST Panel rename; 193 + 7 agents, 55 findings verified, integration round); deferred items closed (`533c0b9`: 2FA
  disable re-verification, hub `ui_dist`; lockfile; test timeout); screenshots refreshed (`8da0d63`, 216/216 live);
  `whm-cli stack-status / install-stack`. Gate at `bf181a0`: server 1309 / agent 573 / client 131 / hub 197 / hub-ui
  105 / SDK + plugins, builds, boot, Playwright. **Full audit bug-hunt** `wf_5bd01820-f02` was running at the end
  (fixes land as `fix(audit): …` commits). Open: zod 4, react-router 7, restricted-user `backup.db.import`, issue-list
  round 2 (`HANDOFF.md` §4).
- **2026-10-27 09:00: session ended during Phase 6 — continue from `HANDOFF.md` §4.** Phase 5 fix round
  landed (`e49e500`); the live hub + panel flow passed 11/11 with no code fix (`e2e/live-hub-flow.sh`);
  `docs/INSTALL.md` + `docs/MANUAL.md`/`MANUAL-partB.md` written and accuracy-reviewed (`029510f`); the
  three Phase-6 audits (privileged surface, web platform, advisor + performance) applied 21 fixes with
  tests (`b01bd30`) — the verifier did not run; their deferred items (zod 4 bump, react-router 7, root
  `npm install` for the hub workspaces, `backup.db.import` temp user, 2FA-disable re-verification,
  hub `ui_dist` config, one load-sensitive test) are listed in `HANDOFF.md` §4. Keep-alive Routine disabled.
- **2026-10-27 06:45: Phase 5 built** (`wf_c7084ffb-2df`, 49 runs, 0 errors, critic: nothing blocking):
  `hub/license` (§16: products/editions, customers, resellers, licenses, activations with fingerprint drift,
  trials, transfers, billing connectors, signed responses, check-in messages, portal users, signing keys with
  rotation; 177 node:test cases incl. marketplace), `hub/marketplace` (§18: developer registration + TOTP, verification
  queue with DNS/well-known/GitHub evidence, namespaces + PSL, uploads with static scan and review, hub signing,
  catalog/download/update/revocation feeds, entitlements, payouts), `hub/ui` (vendor admin, developer and reseller
  portals), panel `services/license.js` + `routes/license.js` + migration 031 (offline token verify with pinned
  `license-keys.json`, check-in schedule, grace/degraded mode, feature gates, License tab, banners), panel
  `services/marketplace-client.js` + migration 032 (Marketplace tab in Manage Plugins with consent screen,
  WHM Marketplace from the hub catalog, revocation polling + banner, developer mode). Integrator items done:
  BLUEPRINT §16–18, deploy unit + config template, `install.sh --with-hub`, README hub section, root workspaces
  (`hub`, `hub/ui`) + test/build scripts, Security Advisor "panel integrity" finding (`MANIFEST.sha256`), hub
  `ui_dist` config. Carried into the **Phase-5 fix round**: hub check-in `fingerprint_mismatch` answers with a
  fractional drift are sent unsigned (canonical form rejects non-integers), a flaky token test, hub/ui dashboard
  field names (`active`/`created`), reseller entitlement-grant route not mounted, host page-descriptor `source`
  label clash, hub/ui interaction tests — **fix round `wf_8f6db955-2a6` running since 06:55**. Then the live
  hub+panel end-to-end flow, the Phase-5 flow screenshots (License tab, Manage Plugins › Marketplace, WHM
  Marketplace — steps to add to `e2e/ui-check.cjs`; the user stopped a refresh at 07:05, do it with the
  end-to-end flow), tracker, then Phase 6. Phase 5 is committed as `76483ef`.
- **2026-10-27 03:25: Phase 5 round 1 done** — `plugins/SDK.md` (developer reference against the real host),
  `plugins/sdk/pack.js` (deterministic tar + sign/verify, parity-tested against `services/plugins.js`),
  `scripts/build-plugin.js`, the sample plugin `plugins/sample-plugin` (`net.whm.sample-notes`, node:test, signed
  fixture) and the **automated-backup plugin** as a fourth bundled plugin `plugins/bundled/net.whm.automated-backup`
  (schedule/scope/retention/destinations/locks/run history/restore with confirm token) — unit passed both reviewers.
  `hub/` workspace (`@whm/hub`): `hub/license` built (64 files, node:test suite, `hub/shared/*` helpers) with 3
  reviewer findings left (check-in error path, app.js:55 auth seam, token test) for the Phase-5 fix round. Round 2
  (hub/marketplace + panel license client) running; round 3 (hub/ui + panel marketplace client) follows.
- **2026-10-27 00:03: Phase 2 wave 3 landed** — Clusters, Themes, Market, cPanel, Support, Plugins (16
  functions; migrations 025–030; `ctx.clusters/themes/market/cpanel/support/bundledPlugins`). The Plugins
  category's three functions are bundled SDK plugins under `plugins/bundled/<id>/` installed through
  `ctx.plugins.install({ dir })`; its agent ops live in the sec/web families as a documented exception
  (`sec.imunify.*`, `sec.clamav.*`, `sec.netdev.read`, `web.wp.*`). **All 212 functions are built.** Core
  follow-ups done by the integrator: `packages.snapshot()` resolves `theme` via `ctx.themes.resolveForPackage`
  (contract §22); `routes/index.js` serves `{ public: true }` mounts before `requireAuth` (login-page
  branding); `middleware/audit.js` summarises Buffers as `{ bytes }`; `ctx.events` (PanelEvents, now
  `lib/events.js`) is created by core at bootstrap. The **wave-3 fix round** (01:35 on the 27th, 19 runs, 0 open per category) closed
  the 10 findings (cluster token scopes + opt-in config pushes, cPanel upgrade check via Software, support
  grant guards, DNS import guard, single quota capability); the integrator then closed the core items the
  fixers could not touch (see the wave-3 seams above). **Phase 2 is complete.** Next: Phase 5.
- **2026-10-26 20:55: core plugin host merged** (`16286ee`, built in an isolated worktree from
  `docs/design/plugin-host.md`, 3 parity/security review rounds, 0 open): `ctx.plugins`
  (`services/plugins.js`) is the real implementation of the SDK contract in `plugins/sdk/mock-host.js`
  — signed `.whmplugin` packages (pure-JS tar reader `lib/tar.js`, Ed25519 keys in
  `$WHM_DATA_DIR/plugin-keys/`, setting `plugins.require_signature`), sandboxed `ctx.fs`/require/net,
  per-plugin routes under `/api/plugins/<id>/`, manage API under `/api/plugins/manage/*`, `GET /api/plugins/ui`
  feeds the sidebar/tools/search (`client/src/hooks/usePluginNav.js`), generic renderer
  `client/src/pages/plugins/PluginPage.jsx` for manifest page kinds. Migration 024. `HOST_API_VERSION = 1.0.0`.
  Bundled plugins live under `plugins/bundled/<id>/` and are installed by their owning category with
  `ctx.plugins.install({ dir })`. `plugins/SDK.md` is still Phase 5.
- **Login/session policy is enforced in core** (`services/auth.js`, `middleware/auth.js`,
  `routes/auth.js`): session timeout, single session, password max age (users.password_changed_at
  via migration 001b), required 2FA for root/resellers (session flag `mustEnroll2fa` gates
  everything but `/auth/*`; the SPA redirects to the 2FA page), API tokens require 2FA,
  verified-IP login (new address → audit + `ctx.contacts.notify('login.new_ip')`). Public
  OIDC routes `GET /api/auth/external[/:name/start|/callback]` use `ctx.security.externalAuth`
  (state+nonce in session; `?link=1` links the current user). Tests: `server/test/auth-policy.test.js`.
- **Screenshots are a deliverable the user wants kept current:** after every wave/milestone run
  `BASE=… PASSWORD=… bash e2e/screenshots.sh` (needs the built client served by the API); it
  stamps a label bar on every image and rewrites the gallery READMEs under `docs/screenshots/`.
  Commit the result.
- **Deploy + tests:** `scripts/install.sh` (prod install, `--upgrade`), `deploy/*.service`
  + config templates, `scripts/whm-cli.js` (status / reset-password / create-admin /
  unlock-ip), `e2e/ui-check.cjs` (Playwright: login → create account → pages; run with
  `BASE=… PASSWORD=… node e2e/ui-check.cjs` against a served build). vitest: server 93,
  agent 42. Phase 2 category build runs as a 3-wave workflow (see task #4); after each
  wave: run both suites + vite build + e2e, update CHECKLIST.md, commit, push, next wave.
- **Frontend rules learned:** import icons by name (never `import * as icons`), resolve
  category icons through `client/src/icons.js`; wrap raw tables in `.table-wrap`; JSX
  string attributes do not interpolate — use `{`template`}`.
- **Dev tip:** never `pkill -f` a pattern that also appears in the same command line (it
  kills the shell). Use the PID file the start command writes, or match exact argv via /proc.

## Resume notes

- Working branch: `claude/pensive-curie-9r0rcx` (push with `git push -u origin <branch>`); the repository's
  default branch is still `claude/trusting-cori-ifp7wy`, which this branch continues — open a PR when the owner wants it merged.
- **No run survives the container.** The 2026-10-29/30 session drove four multi-agent runs (Application Manager
  build, platform fixes round 1, integration round, full audit) from scripts in its scratchpad; their outputs are
  in the git log. The pattern that works here: builders per unit with disjoint file lists, two adversarial
  reviewers for root-level/auth/signing code (one otherwise), three refuters per finding, one fix round, an
  integration round for cross-unit leftovers, then the full gate (`npm test`, builds, boot, `e2e/ui-check.cjs`).
  Remaining work is listed in `HANDOFF.md` §4.
- This dev container has 4 CPUs → at most 2 concurrent subagents; plan fan-outs accordingly.
- The container has `systemctl` and `useradd` but no Apache/BIND/Exim/MySQL daemons; the
  capability layer must make every page degrade gracefully here and work fully on a
  provisioned host.
