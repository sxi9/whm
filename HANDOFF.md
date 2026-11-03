# HANDOFF — pick up the Keel build here

For any AI or engineer taking over. Everything stated here is on the branch
`claude/kind-meitner-dlnbas` of `github.com/sxi9/whm`; this file is updated at every milestone
together with `CHECKLIST.md` (tracker) and `CLAUDE.md` (conventions + memory). Read those two next.

**Last updated:** 2026-11-04 00:15 UTC · Phase 7 milestone 2 · checklist: 212 admin functions + 39 account-panel functions done, P6 closed, P7 complete

## 1. What this is

**Keel** — a production-grade, self-hostable hosting control panel that administers a real Linux
server. It reproduces the complete WHM admin surface (**30 categories, 212 functions**, all built,
reviewed and fixed) under its own identity and design, plus the commercial layer: a **license
server**, a **plugin marketplace** with backend-verified developers, a plugin SDK, a sample plugin and
an automated-backup plugin. Phase 7 (started 2026-11-03, user ask) adds a **new design system**
(Apple-platform conventions: grouped surfaces, system typography, one accent, native-feeling
controls, light + dark), the **product's own identity** (no cPanel/WHM self-references in the UI),
and — next — a **customer-facing account panel** (our own replacement for cPanel) for role `user`.

Stack: Node 22 + Express 4 + better-sqlite3 (panel) · React 18 + Vite + react-router 7 (UI) · root
agent daemon (`agent/`) over a Unix socket with an allowlisted op catalog (316 ops) · hub (`hub/`) =
license + marketplace service with its own React portals (`hub/ui`) · zod 4 everywhere.

## 2. State of play

| Area | State | Proof |
|---|---|---|
| Phases 0–5 (foundation, shell, all 212 functions, plugin host, hub, marketplace, docs) | done | `CHECKLIST.md`; suites green |
| **Phase 6 hardening** | **done** — the three audits' fixes (`b01bd30`) were verified read-only by an independent pass on 2026-11-03; it found one real bypass and six smaller gaps, all fixed (§4 history) | `agent/test/hardening.test.js`, `server/test/web-hardening.test.js`, `server/test/jobs-ownership.test.js` |
| Deferred items from the audits | **all closed**: zod 4 (`7788431`), react-router 7 (`c87c235`), root lockfile links the hub workspaces, `backup.db.import` runs as a temporary database-scoped user, 2FA disable re-verifies password/code, hub honours `ui_dist`, flaky tests made robust | gate below |
| **Phase 7 — design system** | done `2a83117` + sweep `74374de`: tokens/base CSS, sidebar-first shell with coloured icon tiles, translucent bars, Home, Login, every shared component; all 30 categories swept by agents with screenshot reviews and fix rounds (232 findings; majors fixed) | `docs/design/ui-design-system.md`; `docs/screenshots/` |
| **Phase 7 — identity** | done: default branding "Keel" (migration `028c`, operators change it under Panel › Customization), labels renamed with **stable keys/routes** via slug overrides in `client/src/nav.js`, i18n catalog, docs (README/INSTALL/MANUAL/SDK), server/agent/hub user-visible strings (legacy managed-block markers still recognised on upgraded hosts), support links, `keel@` sender, `KEEL-` ticket refs | `22001ff`…`643e0a6` |
| hub/ui portals | on the new kit (`18fe699`; `hub/ui/src/components/SYNC.md`) | hub-ui suite |
| **Phase 7 — account panel** (`/panel`, our cPanel replacement) | **done**: design `docs/design/customer-panel.md`; units U0–U5 + seams S1–S11 (contracts §33–40) + 39 pages in 13 groups, each adversarially reviewed and fixed; integration critics (3 lenses, 38 findings) closed; admin side ("Log in as", Panel › Customization › Account panel, reseller ACL `login-as`); manual Part C | `e2e/panel-check.cjs` 39/39, `server/test/panel-*.test.js`, `agent/test/{files,cron,vmail,webmail,ftp,backup-read}.test.js`, `client/test/panel-*.test.jsx`; galleries `docs/screenshots/pages/panel/` |

## 3. How to run and verify (from a fresh clone)

```bash
npm install                                   # all workspaces (server, agent, client, hub, hub/ui)
cp .env.example .env                          # dev: monolithic mode, ./data, port 2086
npm run build                                 # client + hub/ui
WHM_DATA_DIR=./data WHM_PORT=2086 WHM_SERVE_CLIENT=true node server/src/index.js
#   first boot seeds root; password from WHM_ADMIN_PASSWORD or $WHM_DATA_DIR/initial-admin-password.txt
npm test                                      # every workspace + plugins/sdk + sample plugin + bundled plugins
BASE=http://127.0.0.1:2086 PASSWORD='<root pw>' node e2e/ui-check.cjs        # Playwright flow
BASE=http://127.0.0.1:2086 PASSWORD='<root pw>' bash e2e/screenshots.sh      # all 212 pages + galleries
```
Hub in dev: `node hub/scripts/gen-key.js --master|--hmac|--license|--plugin` against a temp
config, then `node hub/src/index.js` (config via `WHM_HUB_CONFIG=<file>`; `--check-config` boots
once and exits); `node hub/scripts/hub-cli.js create-admin <email>` / `issue <sku> <email>`.
Panel → hub: `WHM_LICENSE_HUB_URL`, `WHM_LICENSE_KEYS_FILE`, `WHM_LICENSE_ENFORCE` (default on only
under `NODE_ENV=production`). Production install: `scripts/install.sh [--with-hub]`.

Dev container facts: 4 CPUs (agents are API-bound, 6–10 concurrent were fine), no Apache/BIND/
Exim/MySQL daemons (every page degrades to an install prompt — by design), Playwright + Chromium
preinstalled, `/tmp/whm` must exist for the agent tests (they create it).

UI work loop that proved efficient: boot the API on a side port with a scratch data dir, run
`npx vite --port 5173` with `WHM_API_URL` pointing at it, and screenshot routes through the dev
server (live source, both colour schemes) — see `docs/design/ui-design-system.md` for the rules.

## 4. Where the previous session ended — and where to continue

**Phase 7 is complete (milestone 2 landed 2026-11-04 ~00:15 UTC).** Everything the user asked for on
2026-11-03 is on the branch: the new design system across every admin page, the product's own identity
(Keel), the hardening close-out, and the customer-facing **account panel** at `/panel` with its 39
functions, admin controls and manual. The full gate, both Playwright flows and the screenshot galleries
(admin + account panel) are green at the head of the branch.

### Continue from here (in order)

1. **Provisioned-host verification.** The dev container has no Apache/BIND/Exim/Dovecot/MySQL/FTP
   daemons, so every host-touching path of the account panel (virtual mailboxes through the Exim/Dovecot
   fragments of contracts §33–40, FTP virtual users, AutoSSL issue, PHP-FPM pools, crontab, quotas) was
   verified by unit tests against mocked ops plus the real as-root `files`/`backup-read` tests. Run
   `scripts/install.sh` on a VM with the daemons, create an account, log in as it and walk Part C of the
   manual; the Security Advisor reports `routerHooked/authHooked` when the virtual-mail fragments are
   not live.
2. **Open design defaults to revisit with real usage** (`docs/design/customer-panel.md` §9): phpMyAdmin
   and webmail SSO (links + prefilled username today), Sieve filters, per-recipient spam thresholds,
   plugin pages inside `/panel` (SDK audience field), forced 2FA for customers as a core policy.
3. **Minor critic findings left as-is** (listed in the critic result, all minor): FTP `dir` passwd-field
   alphabet (`ftp.user.add` should reuse vmail's `HOME_FIELD` rule), docroot alphabet vs `confPath` on
   addon creation, FTP `enableVirtualUsers` retried from a customer request without backoff,
   `panel.changePassword` host-first without a compensating revert, migration `033c` header edited after
   its first commit (no runtime effect; record as an exception like `012`).
4. Optional afterwards: hub portals in a browser, the DEFERRED items in `docs/design/phase5-build-plan.md`.

### Hardening history (for the record)

The Phase-6 verifier (read-only, 2026-11-03) confirmed every audit fix as real, minimal and tested,
corrected the §4.1 wording of the previous handoff (the "web platform" fixes that landed are: CSP
`upgrade-insecure-requests` off without TLS, request-id validation, stream matching on path only,
Buffer bodies in audit, panel TOTP lockout + replay refusal, hub TOTP limiter — not cookie/CSRF/
session changes), and found: (1) **HIGH** a dump-screen bypass via `sql_mode` (`NO_BACKSLASH_ESCAPES`
makes the mysql client tokenise `\'` differently from the screen) — fixed in `transfer.js`
`sqlModeRefusal` (raw-line refusal of mode switches and expression-set modes; mysqldump's
`@OLD_SQL_MODE` idiom still passes) plus a GLOBAL `sql_mode` check before `source`; (2) `fs.write_file`
backed up through a symlinked path — now only regular files are backed up and a parent that is a
directory link is refused; (3) reseller job lists filtered after `LIMIT` — now filtered in SQL
(`jobs.list({ createdBy })`); (4) `ssl.js` dev regression on a root-owned `/tmp/whm`; (5)
enrollment confirmation now goes through the rate-limited `verifyTotp` (without the replay record);
(6) perf budget relaxed under `CI`. Accepted risks unchanged: certbot webroot under account
docroots, `find -exec chmod` TOCTOU in `mail.mailbox.fix_perms`, ModSecurity vendor archives unpacked
as root, `z.any()` on tweak-settings/schedule values, rolling sessions without an absolute cap, the
TOTP lockout maps living in memory (reset on restart). The PHP advisory seed (`002c`) is
`INSERT OR IGNORE`: when PHP publishes the CVE-2026-115560 ranges, ship a `002d` that updates the
setting only while it still equals the seed, or edit it in Security Advisor.

### Gate recorded at milestone 2 (head of branch)

| Suite | Result |
|---|---|
| server (vitest, zod 4) | 59 files, 1402 passed |
| agent (vitest) | 35 files, 615 passed, 2 skipped |
| client (vitest, react-router 7) | 268 passed |
| hub (node --test) | 184 passed |
| hub/ui (vitest) | 105 passed |
| plugins/sdk, sample plugin, 4 bundled plugins | all passed |
| `vite build` client + hub/ui | ok |
| monolithic boot + `e2e/ui-check.cjs` (admin flow) + `e2e/panel-check.cjs` (account user signs in, 39 panel pages, file manager, "Log in as") | pass, no console/5xx errors |

## 5. Rules that matter (full text in `CLAUDE.md`)

- Runs as root: never a shell string; every system call is an allowlisted agent op with a zod
  schema and `execFile(argv[])`; paths pinned under allowed roots; destructive ops marked.
- Every route validates with zod, has RBAC, writes an audit row; secrets encrypted at rest.
- zod 4 conventions: two-argument `z.record`, `.prefault({})` for nested defaults, `patchOf()` for
  PATCH bodies derived from a create schema with defaults, `fields.ipv4/ipv6/ip` (v3-parity IPv6).
- Category module contract: new categories/plugins add files, never edit shared files.
- Migrations are immutable once committed (`0NNb_` follow-ups); host first, DB second.
- `client/src/nav.js` is the single source of truth for the 212 functions; a label rename pins its
  slug with the fourth element `{ slug }` so keys, routes and files never change.
- UI: `docs/design/ui-design-system.md` is the contract (tokens only, shared components, naming).
- Token economy: screenshots at milestones; one fix round + one re-review; two review lenses only
  for root-level or signing code.
- Update `CHECKLIST.md`, `CLAUDE.md` and this file before every push.

## 6. Automation (none running)

No scheduled task is active. The multi-agent scripts used in this phase live only on the session's
machine; their inputs (design docs, contracts, `docs/design/ui-design-system.md`) are in the repo.

## 7. Where things are

```
BLUEPRINT.md   design of record (§1–18)       CHECKLIST.md  tracker + timeline     HANDOFF.md  this file
docs/INSTALL.md  installation guide            docs/MANUAL.md + MANUAL-partB.md + MANUAL-partC.md  user manual (every function + the account panel)
CLAUDE.md      conventions + memory            docs/design/  contracts, plugin host, marketplace, license, phase-5 plan,
                                                             ui-design-system.md, customer-panel.md
server/        panel API (routes/categories/<slug>.js, services/<slug>.js, routes/panel/*.js + services/panel*.js for the account panel, db/migrations 001–033c)
agent/         whm-agentd op families (sys svc user fs sec dns db net ssl mail pkg web hook acct backup transfer files cron vmail webmail ftp backup-read; as-user helper)
client/        React SPA (theme/, components/, pages/fn/<category>/<function>.jsx auto-registered; panel/ shell + pages/panel/<group>/ for the account panel; i18n/en.json)
plugins/       sdk/ (contract + mock host + pack.js), SDK.md, sample-plugin/, bundled/net.whm.{server-monitoring,imunifyav,wp-toolkit,automated-backup}
hub/           license + marketplace service (src/, shared/, license/, marketplace/, scripts/, test/) and ui/ portals
deploy/        whm-panel.service, whm-agentd.service, whm-hub.service, config templates
scripts/       install.sh (--with-hub, --upgrade), whm-cli.js, build-plugin.js
e2e/           ui-check.cjs (flow), screenshot-all.cjs (every page), screenshots.sh, live-hub-flow.sh, README.md
docs/screenshots/  labelled captures + galleries
```
