# HANDOFF — pick up the HST Panel / WHM build here

For any AI or engineer taking over. Everything stated here is on the branch
`claude/pensive-curie-9r0rcx` of `github.com/sxi9/whm` (the repository's default branch is still
`claude/trusting-cori-ifp7wy`, which this branch continues — open a pull request from this branch when
the owner wants it merged). This file is updated at every milestone together with `CHECKLIST.md`
(tracker) and `CLAUDE.md` (conventions + memory). Read those two next.

**Last updated:** 2026-10-30 14:15 UTC · checklist 239 done / 1 partial / 0 open · the full audit bug-hunt and its
integration round are landed (`b100fd3`, `06843dd`); the final gate is green — see §2 and §4.

## 1. What this is

A production-grade WHM (cPanel WebHost Manager) clone that administers a real Linux server —
**31 sidebar categories, 216 functions**: the 212 WHM functions plus our own **Application Manager**
category (Node.js, Python and built-frontend apps) and **Support › Account Conversations** — plus the
commercial layer the owner asked for: a **license server** for reselling the panel, a **plugin marketplace**
with verified developers, a plugin SDK with docs, a sample plugin and an automated-backup plugin.
Since 2026-10-29 the hosted-account side is branded **HST Panel by Hostingsignal** (`client/src/brand.js`;
the admin side keeps the WHM name; slugs, keys, settings and file names keep the `cpanel` identifiers).

Stack: Node 22 + Express 4 + better-sqlite3 (panel) · React 18 + Vite (UI) · root agent daemon
(`agent/`) over a Unix socket with an allowlisted op catalog (369 ops) · hub (`hub/`) = license +
marketplace service with its own React portals (`hub/ui`).

## 2. State of play

| Area | State | Proof |
|---|---|---|
| Phases 0–5 (foundation, shell, all 212 WHM functions, plugin host, hub, docs, screenshots) | done (see the 27 Oct history in `CHECKLIST.md`) | suites green at each milestone |
| Phase 6 hardening | done: three audits (27 Oct) + the independent verifier run (29 Oct, 49 agents) → 11 confirmed findings fixed `50d0f14` (dump screen sql_mode trap + MariaDB sandbox header, reseller job list in SQL, `totp_guard` persistence, advisory unknown ranges, EasyApache/Remi ids, INI-editor picker, audit empty-body test) | `agent/test/hardening.test.js`, `server/test/{jobs-ownership,web-hardening,security-center}.test.js` |
| **Category 31 — Application Manager** (owner ask) | done `81417ea`: design `docs/design/application-manager.md`; agent family `app.*` (12 ops), `ctx.apps`, migration 033, 3 pages, 15 framework presets; two review lenses + fix round (21 findings) | `agent/test/app.test.js` 43, `server/test/application-manager.test.js` 37, `client/test/application-manager.test.jsx` 22 |
| **Owner's 26-item issue list, round 1** (`CHECKLIST.md` › *Owner's issue list*) | done `bf181a0`: 9 units, 13 adversarial reviews (55 findings, 3 refuters each), fix round, integration round `wf_52f47b76-660` (regression review, 3 findings fixed) | gate below |
| Deferred items from the 27 Oct handoff | closed: root `npm install` lockfile links hub workspaces; web-hardening timeout; hub `ui_dist` (`uiDistDir(config)`); 2FA disable re-verifies code/password. **Open:** zod 3 → 4, react-router-dom 6 → 7, `backup.db.import` as a restricted temp user (its dump screen now matches `transfer.mysql.import`) | §4 |
| **Full audit bug-hunt** (owner ask: "find more bugs") | done: 28 lens × scope finders → 112 reports → 81 confirmed by refuters (6 blocking / 47 major / 28 minor) → 84 fixes by 49 grouped fixers `b100fd3`; integration round `06843dd` (web-server group on restored docroots, confined tokens never attach a user outside their endpoints, reseller tokens honour the `cpanel-api` ACL, run-row sweeps after restarts, quota kernel-args guidance, `SymLinksIfOwnerMatch` vhost defaults, sshd socket drop-in, SELinux install step, ErrorBoundary, docs); regression review 2 findings fixed | `scratchpad` notes `audit-outcome.md`; suites below |
| Screenshots | refreshed after the final gate (see the commit after `06843dd`): 216/216 pages live + 22 flow shots (setup wizard, Application Manager, HST Panel labels, install prompts on every "not installed" page) | `docs/screenshots/` |

**Final gate (2026-10-30 14:03 UTC, `06843dd`):** server 1360 (52 files) · agent 651 (34 files) · client 206 (32 files) ·
hub 211 (node --test) · hub/ui 105 · plugins/sdk 73 · sample plugin 13 · 4 bundled plugins · `vite build` client + hub/ui ·
monolithic boot · `e2e/ui-check.cjs` (login → setup wizard → account → pages → search → 217 sidebar links, no console/5xx
errors). Run it with the scratchpad `gate.sh` pattern: random panel port, check the boot log for EADDRINUSE before Playwright.

## 3. How to run and verify (from a fresh clone)

```bash
npm install                                   # all workspaces (server, agent, client, hub, hub/ui)
cp .env.example .env                          # dev: monolithic mode, ./data, port 2086
npm run build                                 # client + hub/ui
WHM_DATA_DIR=./data WHM_PORT=2086 WHM_SERVE_CLIENT=true node server/src/index.js
#   first boot seeds root; password from WHM_ADMIN_PASSWORD or $WHM_DATA_DIR/initial-admin-password.txt
#   first root login opens the HST Panel setup wizard (/setup); "Skip for now" completes it
npm test                                      # every workspace + plugins/sdk + sample plugin + bundled plugins
BASE=http://127.0.0.1:2086 PASSWORD='<root pw>' node e2e/ui-check.cjs        # Playwright flow (skips the wizard itself)
BASE=http://127.0.0.1:2086 PASSWORD='<root pw>' bash e2e/screenshots.sh      # every page + galleries, label bars
```
The session scratchpad's `gate.sh` did exactly this on a random port (the dev container may have stray
listeners on 2097–2099 from earlier agent runs; pick a free port).
Hub in dev: `node hub/scripts/gen-key.js --master|--hmac|--license|--plugin` against a temp config, then
`node hub/src/index.js` (`WHM_HUB_CONFIG=<file>`; `--check-config` boots once and exits);
`node hub/scripts/hub-cli.js create-admin <email>` / `issue <sku> <email>`. Hub portal admins must enrol an
authenticator app (`hub.require_totp_for_admins`, default true; `hub/test/support.js` relaxes it for tests).
Panel → hub: `WHM_LICENSE_HUB_URL` (default `https://licserver.hostingsignal.in`), `WHM_LICENSE_KEYS_FILE`,
`WHM_LICENSE_ENFORCE` (default on only under `NODE_ENV=production`). **Super admin:** only a root user flagged by
`node scripts/whm-cli.js superadmin <user>` (after `superadmin --init` stored the setup password hash in
`/etc/whm/superadmin.key`) sees the license hub, key and activations; `e2e/live-hub-flow.sh` step 2b does this.
Production install: `scripts/install.sh [--with-hub] [--stack full|web|none]` (HST Panel banner, interactive
stack menu, super admin setup password, TLS pair `/etc/whm/tls/{cert,key}.pem`); later `whm-cli stack-status`
/ `whm-cli install-stack --profile full|web | --select a,b,c`.

Dev container facts: 4 CPUs (run at most 2 agents), no Apache/BIND/Exim/MySQL daemons (every page degrades to
an install prompt with an *Install* button for root — by design), Playwright + Chromium preinstalled.

## 4. Where the previous session ended — and where to continue

**Session of 2026-10-29/30** (owner AFK, "take all decisions, keep working"). Order of the owner's asks:
(1) application hosting → done; (2) the 26-item issue list → round 1 done (table in `CHECKLIST.md`);
(3) "full audit, find more bugs" → done: one finder round (7 lenses × 4 scopes), 81 confirmed findings, fixes
`b100fd3`, companions `06843dd`. The confirmed list with every fixer's notes is in the session scratchpad
(`audit-outcome.md`, gone with the container) — the git log of those two commits is the durable record. A second
finder round was not run (the first was already 112 reports; the dedupe/verify pattern is in the script notes
of `CLAUDE.md` › Resume notes).

### Continue from here (in order)

1. **Audit residuals** (small, listed by the fixers): a cheap agent op for `quota.active` so capabilities can say
   "enforceable"; `required: true` on ConfigPage number fields whose schemas refuse null (Tweak Settings, security
   policies/questions); existing hosts keep the old `+FollowSymLinks` vhost block until every vhost is rewritten once
   (Apache Configuration › save, or `ctx.web.vhosts.syncAll`); `server/test/security-center.test.js` mocks still return
   the pre-audit agent shapes (passing); surface `web.detect().selinux` in Server Profile / System Health;
   `e2e/live-hub-flow.sh` pins the hub mail transport to sendmail (fine outside systemd).
2. **Owner's issue list, round 2** — the items round 1 left partial or interpreted narrowly:
   - #21 "index page option while creating license groups" on the hub side (the panel's landing/index
     templates exist; the hub has no license-group page option yet).
   - #26 "more features" for the hub is open-ended — ask the owner which (billing, reseller self-service, …).
   - #17 the account (end-user) side of the support chat lights up when the hosted-account login lands (the
     `user` role can read its own thread through the API; there is no cPanel-style user UI yet).
   - #23 Cloudflare: the domain's nameservers must point at Cloudflare for the mirrored zone to serve; a
     "switch nameservers" helper is not built.
   - #12 GitHub sign-in needs an OAuth 2.0 + user-API flow (no OIDC) — listed as unsupported in the presets.
   - Support Center external links still point at cpanel.net documentation (no Hostingsignal docs URLs exist).
3. **Dependency bumps** as their own commits with the full gate: `zod` 3.x → 4.x (GHSA-mrhx-c7xc-m3w5; every
   schema in server/agent/hub), `react-router-dom` 6 → 7 (client + hub/ui).
4. `backup.db.import` still sources the dump as the MySQL admin — switch to a temporary restricted user like
   `transfer.mysql.import` (`withImportUser`).
5. Accepted risks to re-judge if the threat model changes: certbot webroot under account docroots,
   `find -exec chmod` TOCTOU in `mail.mailbox.fix_perms`, ModSecurity vendor archives unpacked as root,
   `z.any()` on tweak-settings/schedule values, rolling sessions without an absolute cap.
6. Optional: e2e on a provisioned host (`scripts/install.sh --stack full` on a VM) to exercise the real agent ops;
   the hub portals in a browser; the "Push now"/impersonation gaps in `docs/design/phase5-build-plan.md`.

### Corrections to the 27 Oct handoff (found by the verifier's docs check)

The op count was 352 then (369 now); the live hub flow has 9 steps (not "11/11"; now 10 with the super-admin
step 2b); the screenshot refresh commit was `5f61846` (not `974cb94`); `docs/design/marketplace.md` is 691
lines; the hub `shared/auth.js`/`nonce.js` files were not part of the Phase-6 range; the "36 findings: 21/8/7"
arithmetic cannot be reconstructed (only 5 accepted risks were ever named — they are the list in item 5 above);
the keep-alive Routine from that session no longer exists.

## 5. Rules that matter (full text in `CLAUDE.md`)

- Runs as root: never a shell string; every system call is an allowlisted agent op with a zod schema and
  `execFile(argv[])`; paths pinned under allowed roots; destructive ops marked; everything inside an account
  tree runs as the account through `runuser`.
- Every route validates with zod, has RBAC (root / reseller / user, super admin for the license hub), writes an
  audit row (free text — body, text, message, content, env — is redacted whole); secrets encrypted at rest.
- Category module contract: new categories/plugins add files, never edit shared files.
- Migrations are immutable once committed (`0NNb_` follow-ups); host first, DB second.
- `client/src/nav.js` is the single source of truth for the 216 functions (explicit slugs keep routes stable
  when labels change).
- Integration contracts (binding) in `docs/design/integration-contracts.md` §1–34.
- Token economy: screenshots only at milestones or on request; one fix round + one re-review; two review
  lenses only for root-level, auth or signing code.
- Update `CHECKLIST.md`, `CLAUDE.md` and this file before every push.

## 6. Automation (none that survives this session)

Workflow scripts (Application Manager build, platform fixes, integration round, full audit) live only in the
session scratchpad; their outputs are in the repository. Safety check-in reminders were scheduled through the
session's own tools and die with it. A new session needs none of them — the remaining work in §4 is ordinary
engineering.

## 7. Where things are

```
BLUEPRINT.md   design of record (§1–18, §13.31 Application Manager)   CHECKLIST.md  tracker + owner's issue list   HANDOFF.md  this file
docs/INSTALL.md  installation guide (stack profiles, super admin, TLS pair, hub)   docs/MANUAL.md + MANUAL-partB.md  user manual (31 categories)
CLAUDE.md      conventions + memory          docs/design/  contracts (§1–34), application-manager, https-defaults, dns-cloudflare, support-chat, plugin host, marketplace, license
server/        panel API (routes/categories/<slug>.js, services/<slug>.js, db/migrations 001–035 + letter follow-ups, lib/stack-catalog.js)
agent/         whm-agentd op families (sys svc user fs sec dns db net ssl mail pkg web hook acct backup transfer app stack terminal …)
client/        React SPA (nav.js, brand.js, pages/fn/<category>/<function>.jsx auto-registered, pages/Setup.jsx wizard, pages/apps, pages/support)
plugins/       sdk/ (contract + mock host + pack.js), SDK.md, sample-plugin/, bundled/net.whm.{server-monitoring,imunifyav,wp-toolkit,automated-backup}
hub/           license + marketplace service (src/, shared/, license/, marketplace/, scripts/, test/) and ui/ portals (TOTP for all portal users)
deploy/        whm-panel.service, whm-agentd.service, whm-hub.service, config templates (TLS pair /etc/whm/tls)
scripts/       install.sh (--with-hub, --upgrade, --stack), whm-cli.js (status, users, superadmin, stack-status, install-stack), build-plugin.js
e2e/           ui-check.cjs (flow incl. setup wizard), screenshot-all.cjs (every page), screenshots.sh, live-hub-flow.sh (hub+panel, 10 steps), README.md
docs/screenshots/  labelled captures + galleries (216/216 live)
```
