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

- **2026-10-25:** Blueprint complete and pushed. Phase 0 foundation **in progress**: root
  workspace + `server/src/{config,logger}.js` + `lib/{errors,validate,crypto}.js` written;
  DB/migrations/seed, middleware, agent client/daemon, jobs/scheduler, first routes and the
  client skeleton still to write; nothing runs end-to-end yet. `plugins/sdk/` reference
  code committed (56 tests pass). License-server design saved under `docs/design/`.
- **Next:** finish P0 (DB → middleware → agent → routes → smoke test), then P1 shell with
  `nav.js` covering all 212 functions, then fan out P2+ category implementation.

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
