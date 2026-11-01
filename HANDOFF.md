# HANDOFF — pick up the HST Panel / WHM build here

For any AI or engineer taking over. Everything stated here is on the branch
`claude/pensive-curie-9r0rcx` of `github.com/sxi9/whm` (the repository's default branch is still
`claude/trusting-cori-ifp7wy`, which this branch continues — open a pull request from this branch when
the owner wants it merged). This file is updated at every milestone together with `CHECKLIST.md`
(tracker) and `CLAUDE.md` (conventions + memory). Read those two next.

**Last updated:** 2026-11-01 (owner ask: "handoff till whatever we done till now") · checklist 239 done / 1 partial /
0 open (functions) · the owner's **issue list 2** is in the tree (six units V1–V6 + integration units J1–J4) · the
post-integration review left **9 confirmed + 12 unverified findings open, none fixed** (the account's spend limit
stopped the run before the fix round) — the list with fix recipes is §4.1 · gate of this commit in §2.

## 1. What this is

A production-grade WHM (cPanel WebHost Manager) clone that administers a real Linux server —
**31 sidebar categories, 216 functions**: the 212 WHM functions plus our own **Application Manager**
category (Node.js, Python and built-frontend apps) and **Support › Account Conversations** — plus the
commercial layer the owner asked for: a **license server** for reselling the panel, a **plugin marketplace**
with verified developers, a plugin SDK with docs, a sample plugin and an automated-backup plugin.
Since 2026-10-29 the hosted-account side is branded **HST Panel by Hostingsignal** (`client/src/brand.js`;
the admin side keeps the WHM name; slugs, keys, settings and file names keep the `cpanel` identifiers).
The customer-side panel itself (the hosted account's own UI, hPanel-style) is designed, not built — §4.3.

Stack: Node 22 + Express 4 + better-sqlite3 (panel) · React 18 + Vite (UI) · root agent daemon
(`agent/`) over a Unix socket with an allowlisted op catalog (394 ops) · hub (`hub/`) = license +
marketplace service with its own React portals (`hub/ui`).

## 2. State of play

| Area | State | Proof |
|---|---|---|
| Phases 0–5 (foundation, shell, all 212 WHM functions, plugin host, hub, docs, screenshots) | done (see the 27 Oct history in `CHECKLIST.md`) | suites green at each milestone |
| Phase 6 hardening | done: three audits (27 Oct) + the independent verifier run (29 Oct, 49 agents) → 11 confirmed findings fixed `50d0f14` | `agent/test/hardening.test.js`, `server/test/{jobs-ownership,web-hardening,security-center}.test.js` |
| **Category 31 — Application Manager** (owner ask) | done `81417ea`: design `docs/design/application-manager.md`; agent family `app.*` (12 ops), `ctx.apps`, migration 033, 3 pages, 15 framework presets | `agent/test/app.test.js`, `server/test/application-manager.test.js`, `client/test/application-manager.test.jsx` |
| **Owner's 26-item issue list, round 1** (`CHECKLIST.md` › *Owner's issue list*) | done `bf181a0`: 9 units, 13 adversarial reviews (55 findings), fix round, integration round | gate of 2026-10-30 |
| **Full audit bug-hunt** (owner ask: "find more bugs") | done: 112 reports → 81 confirmed → 84 fixes `b100fd3`; integration round `06843dd` | gate of 2026-10-30 |
| **Owner's issue list 2** (ten asks, `CHECKLIST.md` › *Owner's issue list 2*) | **8 of 10 in code**: V1 catch-all landing vhost on the bare IP (80/443) + per-account Domains panel + hostname card on Manage SSL Hosts, V2 PHP version installer (ppa:ondrej / packages.sury.org / Remi SCL) + tool installers, V3 security alert mails, V4 curated package catalog (80 entries), V5 Hardening card (fail2ban incl. the panel jail, auto-updates, sshd, sysctl, firewall), V6 encrypted cloud storage (rclone + crypt, OAuth providers) — commits `972ee72` … `45685a5` (six builders, two review lenses for root-level code, three refuters per finding, 55 confirmed findings fixed). Asks #3/#9 (customer side) are designed: `docs/design/hst-panel-user.md` + `docs/design/hst-wave1-build-plan.md`. **Integration units J1–J4** landed (`e520965`, `da80325`): agent allowed roots for sury, nginx `:443 default_server` proxying to the landing vhost, `dnf updateinfo` security flags, multipart/alternative alert mails, plugin-host uploads via `ctx.backup.uploadFile`, `rclone` stack component + catalog entry, access-log query redaction, Install buttons (cpanminus, rclone), e2e steps 21–27, docs (contracts §36, MANUAL, INSTALL, README) | post-integration review (4 lenses, 22 findings): **9 confirmed + 12 unverified open** — §4.1; blocking regression (rclone catalog link) fixed by hand in this commit |
| Deferred items from the 27 Oct handoff | closed: lockfile links hub workspaces; web-hardening timeout; hub `ui_dist`; 2FA disable re-verifies. **Open:** zod 3 → 4, react-router-dom 6 → 7, `backup.db.import` as a restricted temp user | §4.4 |
| Screenshots | refreshed 2026-11-01 after the gate of `99fe542`: every page plus the 27-step flow (Domains panel, Server hostname card, Install a PHP version, Catalog tab, Security notifications, Hardening, Cloud storage) with label bars and gallery READMEs | `docs/screenshots/` |

**Gate of this commit (2026-11-01):** server 1488 (58 files) · agent 774 + 1 skipped (39 files) · client 265 (40 files) · hub 212 (`npm test`) · hub/ui 105 · plugins/sdk 73 · sample plugin 13 · bundled plugins 15 / 9 / 8 / 5 · `vite build` client + hub/ui · monolithic boot on a random port · `e2e/ui-check.cjs` 27 steps (login → setup wizard → account → pages incl. the Issue-2 cards → search → 217 sidebar links, no console/5xx errors). The open §4.1 findings are behaviour defects the suites do not cover; green here does not mean they are fixed.

**Previous gate (2026-10-30 14:03 UTC, `06843dd`):** server 1360 · agent 651 · client 206 · hub 211 · hub/ui 105 ·
plugins/sdk 73 · sample plugin 13 · 4 bundled plugins · builds · monolithic boot · `e2e/ui-check.cjs`.

## 3. How to run and verify (from a fresh clone)

```bash
npm install                                   # all workspaces (server, agent, client, hub, hub/ui)
cp .env.example .env                          # dev: monolithic mode, ./data, port 2086
npm run build                                 # client + hub/ui
WHM_DATA_DIR=./data WHM_PORT=2086 WHM_SERVE_CLIENT=true node server/src/index.js
#   first boot seeds root; password from WHM_ADMIN_PASSWORD or $WHM_DATA_DIR/initial-admin-password.txt
#   first root login opens the HST Panel setup wizard (/setup); "Skip for now" completes it
npm test                                      # every workspace + plugins/sdk + sample plugin + bundled plugins
BASE=http://127.0.0.1:2086 PASSWORD='<root pw>' node e2e/ui-check.cjs        # Playwright flow, 27 steps (skips the wizard itself)
BASE=http://127.0.0.1:2086 PASSWORD='<root pw>' bash e2e/screenshots.sh      # every page + galleries, label bars
```
Run the gate on a random port (the dev container may have stray listeners from earlier agent runs) and check
the boot log for `EADDRINUSE` before Playwright. Hub tests: `cd hub && npm test` (a bare `node --test` in `hub/`
also picks up `hub/ui`'s vitest files and reports two false failures); `cd hub/ui && npx vitest run`.
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
/ `whm-cli install-stack --profile full|web | --select a,b,c`. The owner's live host applies a pull with
`install.sh --upgrade` from their own session; this environment cannot reach it.

Dev container facts: 4 CPUs (run at most 2 agents), no Apache/BIND/Exim/MySQL/pure-ftpd daemons (every page
degrades to an install prompt with an *Install* button for root — by design), Playwright + Chromium preinstalled.

## 4. Where the previous session ended — and where to continue

**Picking this up from another account (2026-11-01):** clone `github.com/sxi9/whm`, check out
`claude/pensive-curie-9r0rcx` (last commits: `99fe542` handoff + gate, then the screenshot refresh), run §3's
install/test commands once to confirm green, then start with §4.1 (the open review findings) — each item names the
file, line, defect and fix. Nothing is in flight: no workflow, no scheduled check-in, no half-applied change.

**Session of 2026-10-30/31 → 11-01** (owner AFK: "take all decisions, keep working"; asks: the ten-item issue
list 2, then "handoff till whatever we done till now"). What happened, in order:

1. **Issue-2 round** — six builders (V1 landing vhost + domains + hostname SSL, V2 PHP installer, V3 security
   alert mails, V4 package catalog, V5 hardening, V6 cloud storage; disjoint file lists) → two adversarial
   lenses for root-level code → three refuters per finding (55 confirmed) → one fix round → `45685a5`.
   Designs: `docs/design/{domains,php-versions,security-alerts,hardening,backup-cloud}.md`; seams: contracts §36.
2. **Integration round** (`wf_640f0500-d30`) — J1 agent/packages, J2 mail/backup/core, J3 client/e2e, J4 docs
   built and landed (`e520965`, `da80325`); four review lenses (attack V1, attack V5/V6, security diff, regression
   suites) → 22 findings. The account's **individual spend limit** cut the run at 02:40 UTC: 10 findings were
   verified (9 confirmed; `service-configuration.js:563` was refuted by one of its two refuters and kept as minor),
   12 were never verified, and the three fixers never ran.
3. **This handoff** — the blocking regression (`server/src/lib/package-catalog.js` had no `rclone` entry, server
   suite red) and the NGINX Manager label for the new `catchAll === 'proxy'` state were fixed by hand; the full
   gate re-run (§2); the wave-1 build plan of the customer side was saved to the repo.

### Continue from here (in order)

1. **Fix the open findings of the Issue-2 integration review.** None is fixed; each carries the reviewer's fix.
   Confirmed by two refuters (one for the item marked †):
   - **major** `server/src/services/account-functions.js:1050` — a reseller's addon under another account's
     DNS-only zone creates a child zone that shadows that tenant's records. Fix: in `assertClaimable` also look at
     the containing zone (`ctx.dns.zoneFor(domain)`) and refuse (403) when `zone.account_id` is set and differs,
     for every domain type; in `provisionDns` never `ensureZoneForDomain` under a foreign containing zone
     (status failed/skipped) — root stays the only caller that may.
   - **major** `account-functions.js:1042` — orphan zones (the server hostname's parent zone, disk-imported
     zones) are handed to a reseller's account by `domains.add` and deleted by `domains.remove`. Fix: non-root
     refuses when `zoneFor(domain)` returns a zone with `account_id == null` or one containing the server
     hostname (DNS Functions' `createZone` conflicts on an existing zone and `parkDomain` never reassigns);
     `provisionDns` passes `accountId` only for a new or already-owned zone; `remove` deletes only owned zones.
   - **major** `server/src/services/service-configuration.js:695` — uninstalling the hostname certificate leaves
     the catch-all vhost pointing at deleted files; every later Apache configtest fails until reboot. Fix: refresh
     the catch-all (`ensureDefaultVhost`) before, and regardless of, the hostname vhost write in `removeSsl` /
     `applySsl` (try/finally), and make ssl-tls `uninstall()` call `ctx.web.removeSsl` before
     `ssl.bundle.remove_for_domain`.
   - **major** `agent/src/ops/hardening.js:115` — the panel fail2ban filter is evaded by a raw quote in the login
     URL query. Fix: escape-aware regex `(?:[?#](?:[^"\\]|\\.)*)?` (fail2ban's Python `re` supports it) or log
     only the pathname in the pino request serializer; tests in `agent/test/hardening-ops.test.js` with
     `?x=\"` and `?x=\\`.
   - **major** `agent/src/ops/hardening.js:885` — the firewall revert applies the recorded IPv4 INPUT policy to
     ip6tables as well. Fix: `applyFirewallBaseline` returns `previousPolicies { iptables, ip6tables }`, stored in
     `hardening_state.previous`; `hardening.firewall.revert` takes `restorePolicy { ipv4, ipv6 }` (zod object), a
     family without a recorded value defaults to ACCEPT; agent test with mixed captured policies.
   - **minor** `account-functions.js:860` — non-normalised document roots (`//`, `/./`) bypass the taken /
     contains / shared checks and let `deleteFiles` remove another domain's docroot. Fix: reject
     `path.posix.normalize(docroot) !== docroot` in `validateDocroot`, compare normalised paths in `holds()`,
     mirror in the route's `docrootPath` regex; test `/home/bob//www` and `/home/bob/./www` → 422.
   - **minor** † `service-configuration.js:563` — the catch-all silently drops addresses beyond 64, leaving the
     first tenant vhost as the default on the dropped IPs. Fix: raise or remove the agent-side cap, or record
     `summary.truncated` in `service_config_applies.default_vhost` and surface it on
     `GET /api/service-config/apache`.
   - **minor** `server/src/services/backup.js:294` — a saved plain-S3 destination whose config says transport
     `rclone` is served by the native S3 path. Fix: decide the engine from the stored configuration
     (`isRcloneConfig(destinationConfig(row))` before `agentConfig` strips panel-only fields) in `testDestination`,
     `uploadBackup`, `uploadFile`, `listRemote`, the fetch jobs and the delete path.
   - **minor** `agent/src/ops/hardening.js:838` — a non-functional ip6tables makes the whole baseline apply fail.
     Fix: probe each family first (`-S INPUT`), skip a family whose probe exits non-zero (`families.ipv6: null`
     in the result, like `firewallStatus`), fail only when the iptables family rejects a rule.
   Reported but never verified (treat as claims — verify, then fix):
   - minor `agent/src/ops/web.js:1104` — the generated self-signed pair creates `/etc/ssl/whm` with mode 0700
     when it does not exist yet (create the parent 0755, only the `default` leaf 0700).
   - minor `agent/src/ops/pkg.js:1745` — the nginx HTTPS catch-all in proxy mode forwards certificate-less tenant
     names to Apache's landing vhost (render `map $host $whm_catchall { default 1; <ssl-less domains> 0; }` and
     `return 444` for them, so only the hostname, bare IPs and unknown names reach the landing page).
   - minor `pkg.js:772` — `parseUpdateinfoNames` reads only the last token, so dnf5's column layout flags nothing
     (scan every token for the NVRA pattern; add the dnf5 sample to the agent test).
   - minor `server/src/app.js:48` — `redactUrl` leaves credential keys in the fragment and in nested query values;
     minor `server/src/middleware/error.js:54` — the unhandled-error log writes the raw URL. Fix both by moving
     `redactUrl` to `server/src/lib/redact-url.js`, redacting `#…` like `?…`, and using it in `error.js`.
   - minor `server/src/services/backup.js:778` — `uploadFile` (the plugin-host path) records neither the OAuth
     re-auth outcome (`noteAuthOutcome`) nor the last-upload state (`stmts.uploadOutcome`) that `uploadBackup` does.
   - minor `hub/package.json` — bare `node --test` picks up `hub/ui`'s vitest files; use `npm test` (noted in §3).
   - docs out of date against the integration code: `docs/design/integration-contracts.md` §36.3 says alert mails
     are text/plain only (both transports now send multipart/alternative when `html` is given; `ctx.contacts.mail /
     notify` forward `html` to email contacts and root mail only, 1 MiB cap); §36 calls the RHEL security flag open
     (`flagRpmSecurity` now consults `dnf -q updateinfo list --security` / `yum updateinfo list security`); §36.4
     documents a `pkg.offers` signature the op rejects (it is `{ packages }`, 1–300 names) and a system-stack path
     that no longer exists (`unofferedPackages` asks `pkg.offers`, falls back to `pkg.available` on `unknown_op`);
     line ~566 describes a `supported:false` allowed-roots check that J1 removed from `pkg.php.sources.detect`;
     same for `docs/MANUAL.md` (~854), `docs/INSTALL.md` (~1049), `docs/design/php-versions.md` ("Allowed roots
     (integrator)" paragraph), `docs/design/domains.md` ("nginx :443 default_server answers 444") and
     `docs/design/https-defaults.md` (bare-address row).
   Fixed by hand in this handoff commit: the `rclone` catalog entry (`package-catalog.js`, count 80 in the docs)
   and the NGINX Manager `proxy` label.

2. **Integrator leftovers reported by J1–J4** (small, none done): a sync `ctx.web.defaultVhostStatus()` accessor
   so `software.js defaultServerPair()` stops reading `service_config_applies` directly; the Account cell of
   `client/src/pages/account-info/DomainsTable.jsx` as a link to Modify an Account › Domains; a help line on the
   Contact email field of `client/src/pages/accounts/CreateAccount.jsx` (line ~89) and `ModifyAccount.jsx`
   ("Security notices and emergency updates are mailed to this address"); the InstallerCard hint in
   `client/src/pages/software/Shared.jsx` ("the table refreshes when it has finished" — Module Installers now
   refetches); an optional unattended-upgrades / dnf-automatic stack component (hardening's auto-updates item has
   no capability name to hang it on); `ctx.dns.assertDomainClaimable` shared with `parkDomain`; the agent's
   `panel` certificate branch must leave `key.pem` readable by the panel's service group (from round 1).

3. **HST Panel wave 1 (customer side — the owner's asks #3 and #9).** Design: `docs/design/hst-panel-user.md`.
   Build plan with the binding contract (`ctx.hst`, `requireUser`, `/api/hst/<section>` routers discovered from
   `server/src/routes/hst/*.js`, `client/src/hstNav.js` + `pages/hst/registry.js`, impersonation, the `fsuser.*` /
   `ftpuser.*` op families run as the account) and seven disjoint units (H0 server core, H1 client shell, H2
   websites + support, H3a files, H3b FTP + backups, H4 databases, H5 flow + docs): `docs/design/hst-wave1-build-plan.md`.
   Waves 2–3 (mail, advanced, apps, security pages) follow the design's information architecture.

4. **Earlier open items (unchanged):** dependency bumps as their own commits with the full gate — `zod` 3 → 4
   (GHSA-mrhx-c7xc-m3w5; every schema in server/agent/hub) and `react-router-dom` 6 → 7 (client + hub/ui);
   `backup.db.import` sourcing the dump as the MySQL admin (switch to a temporary restricted user like
   `transfer.mysql.import`); audit residuals (a cheap `quota.active` op, `required: true` on ConfigPage number fields
   whose schemas refuse null, old `+FollowSymLinks` blocks until every vhost is rewritten once, `web.detect().selinux`
   in Server Profile, `e2e/live-hub-flow.sh` pinning the hub mail transport); issue-list-1 round-2 items (#21 hub
   index page option for license groups, #26 "more hub features" — ask the owner which, #23 a Cloudflare
   "switch nameservers" helper, #12 GitHub sign-in needs OAuth 2.0 + user API, Support Center links still point
   at cpanel.net); accepted risks to re-judge if the threat model changes (certbot webroot under account docroots,
   `find -exec chmod` TOCTOU in `mail.mailbox.fix_perms`, ModSecurity vendor archives unpacked as root, `z.any()` on
   tweak-settings/schedule values, rolling sessions without an absolute cap).

5. **Live-host checks only the owner's session can run** (3.7.253.240 is unreachable from here): PHP 8.4 install
   from MultiPHP Manager on Debian (packages.sury.org path), an rclone destination end to end (OAuth client +
   crypt + *Test* + a backup upload), the landing page on the bare IP over 80 and 443 with the nginx proxy on,
   the hostname certificate row on Manage SSL Hosts after a hostname change, a security alert test mail (HTML
   with the plain-text alternative), the Hardening card's Apply/Revert for fail2ban and the firewall baseline.

### Corrections to earlier handoffs

The 27 Oct op count was 352 (369 on 30 Oct, 394 now); the live hub flow has 10 steps (with the super-admin step
2b); the screenshot refresh commit was `5f61846`; the "36 findings: 21/8/7" arithmetic of the 27 Oct handoff cannot
be reconstructed (only the 5 accepted risks in §4.4 were ever named); the keep-alive Routine from that session no
longer exists. No migration `036` exists (the Issue-2 round used 037–039; addon/sub/parked domains reuse the
existing tables).

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
- Integration contracts (binding) in `docs/design/integration-contracts.md` §1–36.
- Token economy: screenshots only at milestones or on request; one fix round + one re-review; two review
  lenses only for root-level, auth or signing code.
- Credentials the owner pasted into the chat (SSH key, panel and hub passwords) are never written into the
  repository, docs, logs or commit messages.
- Update `CHECKLIST.md`, `CLAUDE.md` and this file before every push.

## 6. Automation (none that survives this session)

Workflow scripts (Application Manager build, platform fixes, audit, Issue-2 round, Issue-2 integration, HST
wave 1) lived only in the session scratchpad; their outputs are in the repository and the HST wave-1 script's
contract is preserved in `docs/design/hst-wave1-build-plan.md`. Safety check-in reminders were scheduled
through the session's own tools and die with it. **Spend limit:** on 2026-10-31 at 02:40 UTC the account's
individual spend limit stopped 27 of the 55 agents of the integration run ("You've hit your individual spend
limit · ask your admin for a higher limit") — the verify and fix phases are the ones cut off first; a new session
should expect the same cap and run the §4.1 fixes as small, sequential steps (or by hand) before any new fan-out.

## 7. Where things are

```
BLUEPRINT.md   design of record (§1–18, §13.31 Application Manager)   CHECKLIST.md  tracker + owner's issue lists 1 and 2   HANDOFF.md  this file
docs/INSTALL.md  installation guide (stack profiles, super admin, TLS pair, hub)   docs/MANUAL.md + MANUAL-partB.md  user manual (31 categories)
CLAUDE.md      conventions + memory          docs/design/  contracts (§1–36), application-manager, https-defaults, dns-cloudflare, support-chat,
                                                           domains, php-versions, security-alerts, hardening, backup-cloud, hst-panel-user + hst-wave1-build-plan,
                                                           plugin host, marketplace, license
server/        panel API (routes/categories/<slug>.js, services/<slug>.js, db/migrations 001–039 + letter follow-ups, lib/stack-catalog.js, lib/package-catalog.js)
agent/         whm-agentd op families (sys svc user fs sec dns db net ssl mail pkg web hook acct backup transfer app stack terminal hardening …)
client/        React SPA (nav.js, brand.js, pages/fn/<category>/<function>.jsx auto-registered, pages/Setup.jsx wizard, pages/apps, pages/support,
               pages/accounts/DomainsPanel.jsx, pages/software/PackageCatalog.jsx, pages/security/Hardening.jsx)
plugins/       sdk/ (contract + mock host + pack.js), SDK.md, sample-plugin/, bundled/net.whm.{server-monitoring,imunifyav,wp-toolkit,automated-backup}
hub/           license + marketplace service (src/, shared/, license/, marketplace/, scripts/, test/) and ui/ portals (TOTP for all portal users)
deploy/        whm-panel.service, whm-agentd.service, whm-hub.service, config templates (TLS pair /etc/whm/tls)
scripts/       install.sh (--with-hub, --upgrade, --stack), whm-cli.js (status, users, superadmin, stack-status, install-stack), build-plugin.js
e2e/           ui-check.cjs (27-step flow incl. setup wizard), screenshot-all.cjs (every page), screenshots.sh, live-hub-flow.sh (hub+panel, 10 steps), README.md
docs/screenshots/  labelled captures + galleries (refreshed 2026-11-01 with the Issue-2 pages and the 27-step flow)
```
