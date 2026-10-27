# HANDOFF — pick up the WHM build here

For any AI or engineer taking over. Everything stated here is on the branch
`claude/trusting-cori-ifp7wy` of `github.com/sxi9/whm`; this file is updated at every milestone
together with `CHECKLIST.md` (tracker) and `CLAUDE.md` (conventions + memory). Read those two next.

**Last updated:** 2026-10-27 09:00 UTC · the session that built this has ENDED here · checklist 234 done / 1 partial / 1 open

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
| Install guide + user manual (`docs/INSTALL.md`, `docs/MANUAL.md` + `docs/MANUAL-partB.md`) | done 08:35 — accuracy-reviewed, 10 findings fixed, all 212 functions present once | linked from README |
| **Phase 6 hardening** | three audits done, fixes landed `b01bd30`; full gate green 09:05; **the verifier (per-fix review) was stopped before it ran** — see §4 | gate table in §4 |

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

## 4. Where the previous session ended — and where to continue

**Ended at 09:00 UTC, 27 Oct 2026.** Everything is committed and pushed; no workflow is running; the
keep-alive Routine is disabled; no panel/hub process is left running. Phases 0–5 are complete and
verified end to end (including the live hub + panel flow). **Phase 6 is three-quarters done**: the
three hardening audits ran and applied their fixes with tests, but the independent verifier that
re-checks those fixes was stopped before it ran, so the next session starts there.

### Continue from here (in order)

1. **Verify the Phase-6 fixes** (what the stopped verifier would have done). Run the full gate:
   `npm test` (every workspace + SDK + plugins), `npm run build`, a monolithic boot with a temp data
   dir, `e2e/ui-check.cjs` against a served build. The final gate run by the ending session is
   recorded at the end of this section. Then open each fix and confirm it is real, minimal and tested:
   - privileged surface (auditor A, 16 findings, 10 fixed): `agent/src/ops/backup.js` `backup.db.import`
     now screens mysql client commands (`system`, `\!`, `source`, `tee`…) before `source <file>`;
     `agent/src/ops/fs.js` `fs.write_file` temp/backup files are created O_EXCL/O_NOFOLLOW (symlink
     plant in account-writable trees); `server/src/routes/system.js` job endpoints are now ownership-
     checked for resellers; plus schema/flag/`--` tightenings across ops with rejection tests
     (`agent/test/hardening*.test.js`, `server/test/jobs*.test.js`).
   - web platform (auditor B, 12 findings, 7 fixed): helmet/CSP/cookie/CSRF/rate-limit/session
     tightenings in `server/src/app.js`, `server/src/middleware/*`, hub `app.js`/`shared/auth.js`/`nonce.js`;
     tests `server/test/web-hardening.test.js`, `hub/test/web-hardening.test.js`.
   - advisor + performance (auditor C, 8 findings, 4 fixed): Security Advisor PHP advisory rule — data-
     driven `security.advisories` setting seeded by `server/src/db/migrations/002c_security-center-advisories.sql`
     with CVE-2026-109618/109619 ("PHP2Shell": PHP < 8.5.12 / 8.4.27 / 8.3.36 / 8.2.35) and EOL
     8.1/8.0/7.4; CVE-2026-115560 (the "another unpatched" advisory, 23 Oct) is seeded without version
     ranges because none were published — update it when PHP publishes the fix; MultiPHP Manager shows
     the badge; `server/test/perf/{seed.js,list-endpoints.test.js}` asserts list endpoints stay under
     150 ms with no table scan on 20k rows, with the index migrations the auditor added.
2. **Close the deferred items the audits left** (each is small except the first two):
   - `zod` 3.x → 4.6.7 (GHSA-mrhx-c7xc-m3w5, high; memory exhaustion on oversized constrained
     collections) — a major bump touching every schema in server/agent/hub; do it as its own commit with
     the full gate. Until then the API body-size limits bound the exposure.
   - `react-router-dom` 6 → 7 (GHSA-wrjc-x8rr-h8h6 open redirect, GHSA-337j-9hxr-rhxg) — client only.
   - Run `npm install` once at the root so `package-lock.json` links the `hub` and `hub/ui` workspaces
     (`npm ls` reports `@whm/hub`/`@whm/hub-ui` UNMET; they only run because deps are hoisted).
   - `backup.db.import` still executes the dump's SQL as the MySQL admin — switch to a temporary
     restricted user like `transfer.mysql.import` does.
   - `POST /api/auth/2fa/disable` should re-verify the password or a current code.
   - `hub/src/app.js` `uiDistDir()` honours only `WHM_HUB_UI_DIST`; also read `config.ui_dist`
     (accepted by the schema since `029510f`); fix the sentence in `docs/INSTALL.md` §5.6 afterwards.
   - `server/test/web-hardening.test.js` "never accepts the same code twice" can exceed 5 s under full-
     suite load — raise its timeout or isolate it.
   - Accepted risks to re-judge if the threat model changes: certbot webroot under account docroots,
     `find -exec chmod` TOCTOU in `mail.mailbox.fix_perms`, ModSecurity vendor archives unpacked as
     root, `z.any()` on tweak-settings/schedule values, rolling sessions without an absolute cap.
3. **Finish Phase 6 and close out**: tick `- [ ] **P6 Hardening & deploy**` in `CHECKLIST.md`, set the
   last partial (SSL › Purchase and Install a Certificate — needs a real provider account) to done or
   document it as "vendor account required", refresh screenshots if any page changed
   (`bash e2e/screenshots.sh`), update this file, `CHECKLIST.md` and `CLAUDE.md`, push.
4. **Optional, after that**: e2e on a provisioned host (`scripts/install.sh` on a VM with Apache/BIND/
   Exim/MySQL to exercise the real agent ops — never possible in the dev container), the hub portals in
   a browser (the live flow drove them through the API), and the "Push now"/impersonation gaps listed
   in `docs/design/phase5-build-plan.md` cross-unit table as DEFERRED.

### Final gate recorded by the ending session (09:0x UTC, head of branch)

Run at 09:05 UTC on `b01bd30` (the auditors' fixes) with the dev panel stopped — **all green**:

| Suite | Result |
|---|---|
| server (vitest) | 43 files, 1158 passed |
| agent (vitest) | 501 passed, 2 skipped |
| client (vitest) | 52 passed |
| hub (node --test) | 184 passed, 0 failed |
| hub/ui (vitest) | 105 passed |
| plugins/sdk, sample plugin, 4 bundled plugins (node --test) | all passed |
| `vite build` client + hub/ui | ok |
| monolithic boot with a temp data dir (migrate, seed, `/api/health`) | ok |

So the audit fixes do not break anything; what the stopped verifier still owed is the *reading* in
step 1 above (is each fix real, minimal and tested), not a red suite. `e2e/ui-check.cjs` and the
screenshot refresh were not re-run after the audit fixes (the pages they touch: Security Advisor and
MultiPHP Manager badge).

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

## 6. Automation (none running)

- The hourly keep-alive Routine `trig_015b4oBVtePikCYJAcFwKkTK` on the owner's account is **disabled**
  (09:00 UTC); it belonged to the ended session. Delete it or leave it off.
- No workflow run is in progress. The multi-agent scripts the ended session used live only on its
  machine; their inputs (design docs, contracts) are in `docs/design/`. A new session needs none of
  them — the remaining work in §4 is ordinary engineering.

## 7. Where things are

```
BLUEPRINT.md   design of record (§1–18)       CHECKLIST.md  tracker + timeline     HANDOFF.md  this file
docs/INSTALL.md  installation guide            docs/MANUAL.md + MANUAL-partB.md  user manual (every function)
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
