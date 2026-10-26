# CLAUDE.md — project memory & working context

This file is loaded automatically by Claude Code at the start of every session. It is the
project's persistent memory: what we are building, the decisions already made, the
conventions to follow, the current state, and how to resume. **Keep it current: update
"Current state" and `CHECKLIST.md` before every push.**

## What this project is

A production-grade, self-hostable **WHM (WebHost Manager) clone** — the cPanel server-admin
panel — that administers a **real Linux server**: Linux users and quotas, Apache/NGINX
vhosts and PHP-FPM, BIND DNS, Exim/Dovecot mail, MySQL/MariaDB, FTP, SSL/ACME, systemd
services, IPs, firewall, backups, transfers, resellers. It reproduces the entire WHM
interface (`trywhm.net`): **30 sidebar categories, 212 functions**, plus the home
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
- Session cookies `httpOnly`/`sameSite=strict`/`secure` when TLS; CSRF token on all
  mutations; rate limits on auth.
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

## Category module contract (how every one of the 30 categories plugs in)

Nothing is registered by hand in shared files. Adding a category = adding files:

| Piece | Where | Discovered by |
|---|---|---|
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
  `ctx.capabilities`, `ctx.contacts` (wave 2). Reference lazily inside methods; tolerate absence.
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

- **2026-10-25:** Blueprint complete and pushed. **Phase 0 foundation works end to end**
  (`npm install` → `node server/src/index.js` boots, migrates, seeds root; login with forced
  password change; CSRF; RBAC; status/services via real agent ops; packages CRUD; account
  create provisions a real Linux user + home tree, suspend locks it, terminate removes it;
  audit log with redaction; jobs + scheduler + SSE wired). Agent catalog: 40 ops across
  `sys`/`svc`/`user`/`fs`. `plugins/sdk/` reference code committed (56 tests pass).
  License-server design saved under `docs/design/`. Client workspace has only a manifest.
- **2026-10-25 (later): Phase 1 shell is live.** `client/` React SPA: `nav.js` (30
  categories / 212 functions, single source of truth for sidebar, Tools grid, router and
  search), WHM-style layout, dashboard, login/2FA/forced password, audit log, shared
  components, and 29 real pages (accounts, packages + feature manager, server status,
  service manager, restart services ×8, process manager, disk usage, basic setup, tweak
  settings, cron jobs, root password, 2FA). Unimplemented functions render
  `pages/FunctionPage.jsx` with their phase. `npm run build --workspace client` then
  `WHM_SERVE_CLIENT=true` serves it from the API. Playwright check script lives in the
  session scratchpad (`ui-check.cjs`): login → create account via form → pages → search.
- **Next:** finish vitest suites, then fan out P2 categories (Account Information/Functions
  remainder, DNS, Database Services, Service Configuration, Server Status remainder) with
  real `web`/`dns`/`db`/`mail` agent ops; add pages to `client/src/pages/registry.js`.
- **2026-10-26: Phase 2 wave 1 landed** (`79097b1`): Security Center, DNS Functions, Database
  Services, IP Functions, SSL/TLS, Email, Software, Service Configuration, Development, Locales —
  106/109 functions done, 222 new agent ops (267 total), migrations 002–012, 107 pages; suites
  server 426 / agent 233 / client 5. A **fix round** for the reviewers' open findings and the
  integration critic's seams is running (one fixer + verifier per category); the contracts it
  follows are in `docs/design/integration-contracts.md`. Then wave 2.
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

- Working branch: `claude/trusting-cori-ifp7wy` (push with `git push -u origin <branch>`).
- A multi-agent design run for the deferred Phase 5 items was paused:
  run id `wf_7104d0c5-441`, script
  `/root/.claude/projects/-home-user-whm/0c92c5a2-840d-518f-8036-382a362911d8/workflows/scripts/whm-license-marketplace-plugins-wf_7104d0c5-441.js`
  (only exists on the original session's machine). Its finished outputs are already in
  the repo (`docs/design/license-server.md`, `plugins/sdk/`). When resuming Phase 5, write
  `plugins/SDK.md` against the committed `plugins/sdk/` code and design the marketplace
  to match its packaging/signing constants — do not regenerate the SDK code.
- This dev container has 4 CPUs → at most 2 concurrent subagents; plan fan-outs accordingly.
- The container has `systemctl` and `useradd` but no Apache/BIND/Exim/MySQL daemons; the
  capability layer must make every page degrade gracefully here and work fully on a
  provisioned host.
