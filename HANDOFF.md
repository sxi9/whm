# HANDOFF — pick up the WHM build here

For any AI or engineer taking over. Everything stated here is on the branch
`claude/trusting-cori-ifp7wy` of `github.com/sxi9/whm`; this file is updated at every milestone
together with `CHECKLIST.md` (tracker) and `CLAUDE.md` (conventions + memory). Read those two next.

**Last updated:** 2026-10-27 08:15 UTC · head `974cb94`+ · checklist 234 done / 1 partial / 1 open

## 1. What this is

A production-grade WHM (cPanel WebHost Manager) clone that administers a real Linux server —
**30 sidebar categories, all 212 WHM functions built, reviewed and fixed** — plus the commercial
layer the owner asked for: a **license server** for reselling the panel, a **plugin marketplace**
where anyone registers as a developer and must be **verified in the vendor backend** before
publishing, a plugin SDK with docs, a **sample plugin**, and an **automated-backup plugin**.

Stack: Node 22 + Express 4 + better-sqlite3 (panel) · React 18 + Vite (UI) · root agent daemon
(`agent/`) over a Unix socket with an allowlisted op catalog (316 ops) · hub (`hub/`) =
license + marketplace service with its own React portals (`hub/ui`).

## 2. State of play

| Area | State | Proof |
|---|---|---|
| Phase 0–4 (foundation, shell, all hosting categories) | done | `CHECKLIST.md` functions section; suites green |
| Phase 2 waves 1–3 + fix rounds (all 212 functions) | done, landed `6c693e4` | server 1081 / agent 457 / client 30 at that point |
| Core plugin host (`server/src/services/plugins.js`) | done, `16286ee` | 31 host tests + 7 tar tests |
| Phase 5 build (hub/license, hub/marketplace, hub/ui, panel license + marketplace clients, SDK.md, sample + automated-backup plugins) | done, landed `76483ef` | green gate: server 1135 / agent 462 / client 48 / hub 177 / hub-ui 97 + SDK + 5 plugin suites; both builds; boot; Playwright |
| Phase 5 docs/deploy (BLUEPRINT §16–18, `deploy/whm-hub.service`, `deploy/hub.conf.example`, `scripts/install.sh --with-hub`, README hub section) | done, `0be6f9c` | `bash -n`, hub `--check-config` |
| Phase 5 fix round (8 carried findings) | done, landed `e49e500` | gate: server 1135 / agent 462 / client 48 / hub 181 / hub-ui 105 + SDK + plugins |
| Live hub + panel end-to-end flow (`e2e/live-hub-flow.sh`), Phase-5 flow screenshots | done 08:10 — 11/11 PASS, no code fix needed | reviewer re-run green; screenshots `974cb94` |
| Install guide + user manual (`docs/INSTALL.md`, `docs/MANUAL.md`) | **running** (07:40) | — |
| Phase 6 hardening | pending | — |

Screenshots of every page (labelled, all 212 live) plus 17 flow shots incl. the Phase-5 pages are under
`docs/screenshots/` (last refresh `974cb94`, taken from a panel with a live trial license and an
installed marketplace plugin).

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
Panel → hub: `WHM_LICENSE_HUB_URL`, `WHM_LICENSE_KEYS_FILE` (pinned license public keys; the shipped
`server/src/services/license-keys.json` holds placeholders), `WHM_LICENSE_ENFORCE` (default on only
under `NODE_ENV=production`). Production install: `scripts/install.sh [--with-hub]`.

Dev container facts: 4 CPUs (run at most 2 agents), no Apache/BIND/Exim/MySQL daemons (every
page degrades to an install prompt — that is by design), Playwright + Chromium preinstalled.

## 4. What is left, in order

1. ~~Phase-5 fix round~~ — done (`e49e500`): signed fail-closed hub errors, deterministic token test,
   hub/ui dashboard fields, reseller entitlement/products routes, payouts statement, admin impersonation,
   hub/ui interaction tests, page-descriptor `origin` key.
2. ~~Live hub + panel flow~~ — done: `e2e/live-hub-flow.sh` (parameterised by `SCRATCH`, `HUB_PORT`,
   `PANEL_PORT`, …; see `e2e/README.md`) brings up a hub with generated keys and TLS and a panel on :2088 and
   drives trial → publish → install with consent → revoke → update; 11/11 steps PASS, Playwright steps 15–17 added.
   Note: its run log records response bodies (throwaway hub secrets) under the scratch dir — delete it after use.
3. **Phase 6 hardening**: `npm audit` + pin fixes; sweep every agent op for argv/schema/path rules
   (`agent/src/ops/*`); review rate limits, CSRF, helmet headers, session policy end to end;
   Security Advisor rules incl. a check for the Oct-2026 PHP advisory (flag affected PHP versions
   from MultiPHP Manager); performance pass on list endpoints; final README/BLUEPRINT pass;
   e2e against a provisioned host if one is available. Then tick P5/P6 in `CHECKLIST.md`, set the
   partials to done, and disable the keep-alive routine (see §6).

## 5. Rules that matter (full text in `CLAUDE.md`)

- Runs as root: never a shell string; every system call is an allowlisted agent op with a zod
  schema and `execFile(argv[])`; paths pinned under allowed roots; destructive ops marked.
- Every route validates with zod, has RBAC, writes an audit row; secrets encrypted at rest.
- Category module contract: new categories/plugins add files, never edit shared files.
- Migrations are immutable once committed (`0NNb_` follow-ups); host first, DB second.
- `client/src/nav.js` is the single source of truth for the 212 functions.
- Integration contracts (binding) in `docs/design/integration-contracts.md` §1–32.
- Token economy: screenshots only at milestones; one fix round + one re-review; two review lenses
  only for root-level or signing code.
- Update `CHECKLIST.md`, `CLAUDE.md` and this file before every push.

## 6. Automation that is running

- A self-scheduled hourly Routine on the owner's account, "WHM build keep-alive check-in"
  (`trig_015b4oBVtePikCYJAcFwKkTK`, minute :09), wakes the original session to resume its
  workflow runs after container restarts and snapshot work to git. It belongs to that session;
  another AI should ignore it (or the owner can delete it) and simply work from this file.
- Multi-agent workflow scripts live only on the original session's machine
  (`~/.claude/projects/…/workflows/scripts/`): `whm-build-categories` (3 waves), `whm-fix-wave`,
  `whm-plugin-host`, `whm-marketplace-design`, `whm-phase5-build`, `whm-phase5-docs-deploy`,
  `whm-phase5-fix`. Their inputs (design docs, contracts) are all in the repo under `docs/design/`.

## 7. Where things are

```
BLUEPRINT.md   design of record (§1–18)       CHECKLIST.md  tracker + timeline     HANDOFF.md  this file
CLAUDE.md      conventions + memory            docs/design/  contracts, plugin host, marketplace, license, phase-5 plan
server/        panel API (routes/categories/<slug>.js, services/<slug>.js, db/migrations 001–032)
agent/         whm-agentd op families (sys svc user fs sec dns db net ssl mail pkg web hook acct backup transfer …)
client/        React SPA (pages/fn/<category>/<function>.jsx auto-registered; pages/plugins/PluginPage.jsx)
plugins/       sdk/ (contract + mock host + pack.js), SDK.md, sample-plugin/, bundled/net.whm.{server-monitoring,imunifyav,wp-toolkit,automated-backup}
hub/           license + marketplace service (src/, shared/, license/, marketplace/, scripts/, test/) and ui/ portals
deploy/        whm-panel.service, whm-agentd.service, whm-hub.service, config templates
scripts/       install.sh (--with-hub, --upgrade), whm-cli.js, build-plugin.js
e2e/           ui-check.cjs (flow), screenshot-all.cjs (every page), screenshots.sh, live-hub-flow.sh (hub+panel end-to-end), README.md
docs/screenshots/  labelled captures + galleries
```
