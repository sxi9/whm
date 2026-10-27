# Phase 5 build plan — license server, marketplace, hub UI, panel clients, SDK & plugins

Implementation plan for the deferred Phase 5 work. Designs of record: `docs/design/license-server.md`
(§16, binding **as amended by the "§16 errata" table below**), `docs/design/marketplace.md` (§18, binding),
`docs/design/plugin-host.md` (the real host), `plugins/sdk/` (committed SDK: `validate-manifest.js`,
`mock-host.js`, `errors.js`, `semver.js`, `cron.js`, `index.js`). Nothing in the committed `plugins/sdk/*.js`
is regenerated; U6 adds `pack.js` and a one-line export. Everything below is built against them.

The work is **six independent units**. Two engineers run them **two at a time** in three rounds;
each unit lists the interfaces it *exposes* and *consumes* so a unit can be built against the
contract before its neighbour lands. Every unit ends with the listed commands green and no edits
outside its file list. Conventions from `CLAUDE.md` apply unchanged (ES modules, zod on every
route, `{ data, meta }` / `{ error }` envelopes, audit rows, no shell strings, `CapabilityError`).

## §16 errata (binding; applied by the integrator when §16 enters BLUEPRINT.md)

`license-server.md` predates the single-process hub and the marketplace. The following amendments are
the design of record; the file itself is left as saved and the integrator applies them while pasting
(integrator step 1). Dated 2026-10-27.

| §16 text | Reads as |
|---|---|
| §16.1 tree `hub/license/src/{index,app,config}.js`, `hub/license/src/db/*`, `hub/license/src/lib/*`, `hub/license/portal/`, `hub/marketplace/ see §17` | the §18.1 tree: `hub/src/{index,app,config}.js`, `hub/shared/db.js` + `hub/license/migrations/`, `hub/shared/{keys,canonical,keyfmt,fingerprint,webhooks,nonce,scheduler}.js`, `hub/license/{services,routes}/`, `hub/ui/`, `hub/marketplace/ see §18` |
| §16.1 `whm-license.service`; `/etc/whm-hub/license.conf` (yaml); logs `/var/log/whm-hub/license/*` | `whm-hub.service`; `/etc/whm-hub/hub.conf` (**JSON**, §16.1 keys under `license:`; `keys.active_kid: { license, plugin }`); logs `/var/log/whm-hub/{app,audit,access}.log` |
| §16.3 `signing_keys(kid, public_key, created_at, retired_at, status)` | `signing_keys(kid PRIMARY KEY, purpose TEXT NOT NULL CHECK (purpose IN ('license','plugin')), public_key, created_at, activated_at NULL, retired_at NULL, status)`, `status ∈ pending|active|retiring|retired`; the table lives in **license.db only** (U1); the marketplace reads it through `ctx.keys` |
| §16.3 (missing) | `portal_sessions(sid PRIMARY KEY, data, expires_at)` for `shared/auth.js` |
| §16.4 "the panel only *pins* keys shipped in its own code" | "**license** keys are compiled in and are the only keys hub responses are verified with; **plugin-signing** keys are delegated through license-signed activation/check-in responses (§18.6) and are used only by the host's `verifySignature()` for packages" |
| §16.6 check-in `usage: { accounts, resellers, domains }` | `usage: { accounts, resellers, domains, plugins: [ { id, version, state } ] }` (ids and versions only) |
| §16.6 activation/check-in `data` | gains `plugin_signing_keys: [ { kid, pub, status } ]` and `revocations_head_ts` (both inside the signed body; supplied by the marketplace through `ctx.hooks.activationExtras`) |
| §16.7 `GET/POST /v1/admin/signing-keys` · `POST …/:kid/retire` | `GET …?purpose=` · `POST … { purpose }` · `POST …/:kid/activate` · `POST …/:kid/retire` (refused `409 key_in_use` while a plugin key is referenced, §18.9) |
| §16.7 inbound billing | the license handler processes only events whose `metadata.whm_kind` is `license` or absent; `plugin_purchase` events belong to the marketplace `billing` hook (§18.5) |
| §16.8 "`§17`" (marketplace_paid), §16.12 "`hub/marketplace/` (§17)" | §18 |
| §16.8 degraded allow-list (abstract) | the concrete list in U4 below |

## Rounds and dependencies

| Round | Engineer A | Engineer B | Why this pairing |
|---|---|---|---|
| 1 | **U1 hub/license** | **U6 SDK docs + sample + automated-backup + build-plugin** | neither consumes another unit; U6 produces `plugins/sdk/pack.js` and the golden `.whmplugin` fixtures U2 and U5 test against |
| 2 | **U2 hub/marketplace** (consumes U1 `hub/shared/*`, `ctx.licenses`, `ctx.keys`, U6 `pack.js`) | **U4 panel license client** (consumes U1 `canonical.js` golden vectors + token shape; mocks the hub) | both are server-side; U4 only needs U1's *wire contract*, which is fixed in §16 + errata |
| 3 | **U3 hub UI** (consumes U1 + U2 routes) | **U5 panel marketplace client** (consumes U2 signed routes, U4 `ctx.license`, U6 fixtures; mocks the hub) | both are the last consumers |

Hard ordering: U2 starts after U1's `hub/shared/` exports and `ctx.keys` exist (they are the first thing U1
writes, in its first day); U5 starts after U4 exports `ctx.license.get()/token()/hubUrl()/hub.request()/
verifySigned()/pluginSigningKids()` (stub them if U4 is late — the shapes are below). U3 may start on the
component copy and routing while U2 is in progress and bind to real endpoints last.

---

## U1 — `hub/license`: the license server (§16 + errata)

**Create**
```
hub/package.json                      "@whm/hub", type module, deps: express ^4, express-session ^1, better-sqlite3 ^11, zod ^3, helmet ^8,
                                      express-rate-limit ^7, bcryptjs, otplib, pino, pino-http; scripts: start, test (node --test "test/**/*.test.js"), dev
hub/src/index.js                      bootstrap(): config → shared db (license.db [+ marketplace.db when U2 registers]) → migrate → keys → services → app → HTTPS :7443, loopback :7440 /healthz /metrics
hub/src/app.js                        helmet, pino-http, rate limits (§16.10 table), auth middlewares, mounts, error → envelope
hub/src/config.js                     /etc/whm-hub/hub.conf (JSON, schema-validated with zod: { public_url, serve_ui, license: {…§16.1…}, keys: { dir, active_kid: { license, plugin } }, marketplace: {…§18.1…} }) + env WHM_HUB_* overrides; test override object
hub/shared/db.js                      openDb(path, { migrationsDir, logger }) → better-sqlite3 handle (WAL, foreign_keys), migrate() runner (0NN_*.sql, immutable)
hub/shared/crypto.js                  createCrypto(masterKeyHex) — copy of server/src/lib/crypto.js (AES-256-GCM v1:, bcrypt, hashToken, totp), byte-identical except the import style;
                                      the hub key is the hex in /etc/whm-hub/master.key (0600 whmhub, created by hub/scripts/gen-key.js --master; config.master_key_file)
hub/shared/canonical.js               canonicalize(value) → Buffer (JCS subset §16.4); throws on floats/NaN/undefined
hub/shared/keys.js                    loadSigningKeys(dir, db, { activeKids: { license, plugin } }) → { active(purpose) → { kid, purpose, privateKey, publicPem }, byKid(kid), listPublic(purpose) → [{ kid, pub (PEM SPKI), status }] },
                                      kidOf(publicKey) (first 8 hex of sha256(raw 32 bytes)), sign(bytes, { kid, purpose, encoding: 'base64url' | 'base64' }) → string (throws key_purpose_mismatch when the kid's
                                      purpose ≠ purpose), verify(bytes, sig, { kid, purpose, encoding }), signResponse(res, body) → sets X-WHM-Signature with the active license key (base64url)
hub/shared/keyfmt.js                  Crockford license keys WHM-XXXX-XXXX-XXXX-XXXX: generate(), normalize(), check(), hash()
hub/shared/auth.js                    apiKeyAuth({ ownerType }), requireScope('license:issue'), portalSession (express-session + a 40-line SQLite store over portal_sessions), requireRole('vendor_admin'|…), requireStepUp(maxAgeS), csrf
hub/shared/validate.js                validate({ params, query, body }) + fields (same shape as the panel's lib/validate.js)
hub/shared/audit.js                   record(db, { principal, role, ip, action, target, args, result }) with the panel's redaction rules
hub/shared/webhooks.js                enqueue(db, { ownerType, ownerId, event, data }) → <ownerType>_webhook_deliveries (vendor|reseller → license.db webhook_*; developer → marketplace.db developer_webhook_*);
                                      deliver(db, { fetch = safeFetch }) with HMAC header + backoff (§16.7)
hub/shared/mailer.js                  templated mail; transport = `sendmail -t -i` via child_process.execFile (argv only, body on stdin) or a test transport that records; no SMTP client
hub/shared/scheduler.js               ensure(name, cron, fn); runDue(); the §16.11 schedule list
hub/shared/nonce.js                   check(nonce, ts) → replay / skew errors (10-min table TTL, 300 s skew)
hub/shared/fingerprint.js             drift(storedComponents, newComponents) → score (0.5/0.3/0.2)
hub/shared/safe-fetch.js              safeFetch(url, { timeoutMs = 5000, maxBytes = 4096, allowPorts = [443] }) and safeResolveTxt(name): the §18.2 SSRF policy
                                      (resolve first, refuse loopback/private/link-local/ULA/multicast/unspecified/own addresses, connect to the resolved IP, redirect: 'error', no credentials, TLS on)
hub/shared/psl.js                     registrableDomain(host) / isPublicSuffix(host) over hub/shared/psl.dat (bundled PSL snapshot, refreshable)
hub/license/migrations/001_license.sql   every table of §16.3 as amended (signing_keys with purpose/activated_at, portal_sessions; CREATE TABLE IF NOT EXISTS, seed vendors row + products rows for the 5 editions)
hub/license/services/{products,customers,resellers,licenses,activations,trials,transfers,billing,reports,portal-users,signing-keys}.js
hub/license/routes/{public,reseller,admin,portal}.js      exactly the §16.7 tables as amended (signing-keys with purpose/activate)
hub/scripts/gen-key.js                --license | --plugin: writes /etc/whm-hub/keys/<kid>.ed25519 (0600), inserts the signing_keys row with purpose and prints { kid, pub };
                                      --master: writes /etc/whm-hub/master.key; --hmac: writes /etc/whm-hub/keys/download.hmac (32 random bytes)
hub/scripts/hub-cli.js                create-admin, issue (sku, email), revoke, status, activate-key <kid>
hub/test/fixtures/keys/               fixed Ed25519 test pairs for purpose license AND plugin (kids printed in fixtures/index.js) + canonical-vectors.json (golden JCS vectors)
hub/test/{canonical,keyfmt,token,activate,checkin,lifecycle,trials,resellers,webhooks,billing,security,keys,safe-fetch}.test.js
```

**Exposes (contract for U2, U3, U4)**
- `bootstrap({ dbDir, config })` returns `ctx = { config, logger, dbs: { license }, crypto, keys, audit, webhooks, mailer, scheduler, safeFetch, psl, licenses, activations, customers, resellers, products, trials, billing, app, hooks, registerModule(fn) }`.
  `registerModule(fn)` is how U2 adds its DB, services, routes and hooks (`fn(ctx)` runs before `app` is finalised).
- `ctx.keys` — `active('license'|'plugin')`, `byKid(kid)` (any purpose; U2 uses it to refuse developer kids that collide), `listPublic('plugin') → [{ kid, pub, status }]` (status `pending|active|retiring`; retired excluded), `sign(bytes, { kid, purpose, encoding })`, `verify(...)`. **U1 owns `signing_keys`, the key files and `/v1/admin/signing-keys*`; U2 consumes only.**
- `ctx.licenses.verifyToken(token) → { ok, payload, reason }` (same algorithm the panel uses; used by U2 downloads), `ctx.licenses.get(lid)` (live row), `ctx.licenses.featureOf(lid, flag)`; `ctx.activations.get(aid)` (live row incl. `status`, `fingerprint`, `fp_components_json`), `ctx.activations.matchFingerprint(aid, fingerprint, components) → { ok, drift }` (§16.5 rule).
- `ctx.activations.pushMessage({ licenseId?|all: true }, { level, code, text })` — queued into the next check-in's `messages` (U2 kill-switch).
- `ctx.hooks.checkin.push(fn)` — `fn({ activation, license, usage })` runs on every check-in (U2 records `usage.plugins` for active activations only).
- `ctx.hooks.billing.push(fn)` — `fn(source, event, meta)` after the license handler; `meta.whm_kind` is the discriminator (§18.5) and the license handler skips `plugin_purchase` events.
- `ctx.hooks.activationExtras.push(fn)` — `fn(activation) → object` merged into `/v1/activate` and `/v1/checkin` `data` **before signing** (U2 supplies `plugin_signing_keys` and `revocations_head_ts`).
- `ctx.hooks.keyActivated.push(fn)` (`fn({ kid, purpose, previousKid })`, after `POST …/:kid/activate`) and `ctx.hooks.beforeKeyRetire.push(fn)` (`fn({ kid, purpose })` may throw `409 key_in_use`) — U2 registers the re-sign job and the retire guard (§18.9).
- `ctx.app.signed(router)` — wraps a `POST` route in the §16.6 nonce/timestamp checks and `signResponse` (U2's `/v1/market/download|updates|revocations|plugins/:id/reviews`).
- Wire contract with the panel is §16.6/§16.7 verbatim as amended: token `WHMT1.<payload>.<sig>` with the §16.4 fields, signed responses, error codes `activation_limit`, `fingerprint_mismatch`, `revoked`, `trial_exists`, `quota_exceeded`, `over_limit`.
- `hub/test/fixtures/canonical-vectors.json` — U4 copies it verbatim into `server/test/fixtures/` (parity test both sides).

**Tests** — the §16.12 list, node:test, temp SQLite per file, fixed key pairs: canonical vectors; keyfmt; token sign/verify, tamper, wrong/retired kid, skew boundaries, fp drift ≤/> 0.5; activate happy/limit/reclaim/3-per-30-days/nonce replay/skew; check-in statuses + drift update + usage (incl. `plugins`) + rate limit + `activationExtras` merged inside the signed body; lifecycle issue → renew → upgrade → downgrade refused/forced → suspend → revoke → rekey; trials once per fingerprint/e-mail; reseller quota, scoping, scope matrix; webhooks HMAC/backoff per owner type/db; billing idempotency per source + `whm_kind` routing; keys: purpose enforced on `sign()` (`key_purpose_mismatch`), `activate` flips statuses and fires the hook, `retire` honours `beforeKeyRetire`, `listPublic` never lists retired, `encoding` option exact strings; safe-fetch refusal matrix (§18.10); security (zod rejections, 429s, no raw machine-id in any row/log).

**Commands**: `cd hub && npm install && npm test` · `node hub/src/index.js --check-config` boots against a temp dir and answers `GET /healthz`.

---

## U2 — `hub/marketplace`: developer verification, submissions, catalog, distribution (§18)

**Create**
```
hub/marketplace/index.js              register(ctx): opens marketplace.db, migrates, builds services, mounts routes, registers the U1 hooks (checkin, billing, activationExtras, keyActivated, beforeKeyRetire)
hub/marketplace/migrations/001_marketplace.sql    every table of §18.2–18.5 EXCEPT signing_keys (license.db, U1) (+ categories seed)
hub/marketplace/lib/package.js        wraps plugins/sdk/pack.js: unpack (limits of plugin-host.md), stripWrapper(dir), packageDigest(dir, { exclude }), repackDeterministic(dir), sha256
hub/marketplace/lib/namespace.js      normalize(ns) (lower-case, IDNA), domainOf(ns), covers(ns, id) = id.startsWith(ns + '.'), isReserved(ns, config), evidenceHostAllowed(ns, host) (exact domain or registrable parent via ctx.psl), conflicts(ns, existing)
hub/marketplace/lib/scanner-rules.js  the §18.3 reject/flag rule table as data (tokeniser + rules incl. computed constructor, Reflect, escapes, file-type allow-list), skeleton() (NFKC + confusables table) + Damerau-Levenshtein
hub/marketplace/services/{developers,verification,keys,submissions,scanner,review,signing,catalog,distribution,entitlements,billing,revocations,payouts,stats,plugin-reviews,dev-security}.js
hub/marketplace/routes/{public,developer,admin}.js        exactly the §18.4 and §18.8 tables (public: GET catalog routes + ctx.app.signed POST routes)
hub/marketplace/jobs.js               scan queue, verification re-checks (DNS TXT / well-known / GitHub via ctx.safeFetch; 5/h per developer), payouts-close, evidence purge (30 d),
                                      download row purge (expired/consumed), resign-packages (on keyActivated), psl-refresh (weekly)
hub/test/market-*.test.js             (one file per §18.10 bullet)
```
**Edit**: `hub/src/index.js` — one line: `ctx.registerModule((await import('../marketplace/index.js')).register)`. `hub/package.json` — add `"@whm/plugin-sdk": "file:../plugins/sdk"` (CommonJS; load with `createRequire`).

**Exposes**
- Public GET routes of §18.4 (`/v1/market/catalog|categories|plugins/:id|plugins/:id/versions|keys`) and signed POST routes (`/v1/market/download|updates|revocations|plugins/:id/reviews`) with the exact response shapes shown there; download descriptor errors `entitlement_required` 402, `feature_required` / `license_inactive` / `activation_inactive` / `fingerprint_mismatch` 403, `version_yanked` / `version_revoked` / `download_consumed` 410.
- Developer routes `/v1/dev/*` and admin routes `/v1/admin/market/*` (§18.8), incl. the step-up (†) and lockout rules of §18.9.
- Into U1 via hooks: `activationExtras` → `{ plugin_signing_keys: ctx.keys.listPublic('plugin'), revocations_head_ts }`; `checkin` → upsert `installs` (active activations only); `billing` → purchases/entitlements for `whm_kind = plugin_purchase`; `pushMessage` on kill-switch; `keyActivated` → `resign-packages`; `beforeKeyRetire` → `409 key_in_use` while referenced.
- Signing: `services/signing.js` writes `SIGNATURE.json = { kid, alg: 'ed25519', sig }` with `kid = ctx.keys.active('plugin').kid` and `sig = ctx.keys.sign(packageDigest(root, { exclude: ['SIGNATURE.json'] }), { kid, purpose: 'plugin', encoding: 'base64' })` — **standard base64 with padding**, the host's `packageDigest` rule; the parity test asserts the string byte-for-byte against what `server/src/services/plugins.js` verifies and `pack.js verify()` accepts. Re-sign on rotation per §18.9.
- Download URL: `sig = HMAC-SHA256(/etc/whm-hub/keys/download.hmac, "dl_id|activation_id|exp")`, single-use `dl_` ids.

**Consumes**: U1 `hub/shared/*`, `ctx.keys`, `ctx.licenses.verifyToken/get/featureOf`, `ctx.activations.get/matchFingerprint`, `ctx.hooks.*`, `ctx.app.signed`, `ctx.safeFetch`, `ctx.psl`, `ctx.webhooks.enqueue(db, …)`; U6 `plugins/sdk/pack.js` (tar writer/digest/sign) and `plugins/sdk/validate-manifest.js`; U6 fixture packages `plugins/sample-plugin` (signed with the fixture developer key) for upload tests; the server's `packageDigest` for the parity test (`hub/test/market-package-parity.test.js` imports `server/src/services/plugins.js` directly — monorepo path, test-only).

**Tests**: the §18.10 list. The one test that must not be skipped: *approve → repack → sign → install on the real panel host* — boot the panel with `bootstrap()` from `server/test/support/app.js`, drop the hub's plugin public key into `<dataDir>/plugin-keys/<kid>.pub`, `POST /api/plugins/manage/install` with the signed bytes, assert `signed: true, signer: <kid>`, then flip `plugins.require_signature` on and assert an unsigned copy is refused (a `{ dir }` install of `plugins/bundled/net.whm.server-monitoring` with `source: 'bundled'` must still succeed — the bundled exemption of §18.6 is a U5 host edit; until it lands this assertion is skipped with a note).

**Commands**: `cd hub && npm test` · `cd server && npx vitest run plugin-host` (unchanged until U5, proves no host edit was needed for signing parity).

---

## U3 — `hub/ui`: vendor admin, developer and reseller portals

**Create**
```
hub/ui/package.json  vite.config.js  index.html  src/main.jsx  src/router.jsx  src/api/client.js (fetch + CSRF + {data,meta} unwrap + step-up re-prompt on 403 totp_stepup_required)
hub/ui/src/components/   COPIED from client/src/components: Common.jsx, DataTable.jsx, Form.jsx, Modal.jsx, Toast.jsx, ProgressLog.jsx, ConfigPage.jsx, ActionPage.jsx + client/src/styles base CSS
hub/ui/src/components/SYNC.md          source commit hash + list of files copied; "re-copy by hand, never import across packages"
hub/ui/src/auth/        login (password + TOTP), session context, role guard, StepUpModal
hub/ui/src/pages/admin/ {Dashboard,Licenses,LicenseDetail,Customers,Resellers,Products,Trials,Integrations,Reports,Audit,
                         VerificationQueue,Developers,ReviewQueue,ReviewDetail,Catalog,Revocations,Entitlements,Payouts,ReviewModeration,SigningKeys}.jsx
hub/ui/src/pages/reseller/ {Dashboard,Licenses,Customers,Activations,ApiKeys,Statement}.jsx
hub/ui/src/pages/dev/   {Register,VerifyEmail,Profile,Security,Verification,Keys,Plugins,PluginEdit,Versions,VersionDetail,Upload,Stats,Payouts,ApiKeys,Webhooks}.jsx
hub/ui/test/            vitest + @testing-library: render each page against a mocked api client; the two queues' approve/reject flows; step-up prompt
                        DEVIATION (fix round 1, 2026-10-27): neither @testing-library/react nor jsdom is installable in this checkout
                        (no npm install), so pages render through react-dom/server against mocked hooks and the approve/reject and
                        step-up flows are covered as the pure functions the pages call (queues.js, createApiClient step-up retry).
                        Integrator: add @testing-library/react + jsdom to hub/ui devDependencies and one interaction test per queue.
hub/ui/src/pages/admin/Security.jsx   portal account security (TOTP enrol/confirm/disable via /v1/portal/2fa/*, password via /v1/portal/password),
                        mounted at /admin/security and /reseller/security (fix round 1)
                        DEFERRED (fix round 2): the §16.9 "impersonate-reseller (audited)" screen waits for the U1 route recorded in the
                        cross-unit table; the Shell's 2FA indicator is advisory (the hub alone enforces license.stepup_max_age_s).
```
**Edit**: `hub/src/app.js` — serve `hub/ui/dist` at `/` (SPA fallback) when `config.serve_ui`.

**Decision — copy, not import.** The panel components reach into panel-only modules
(`api/client.js`, `AuthContext`, `icons.js`); a relative import would couple two deployables and
break the hub when the panel UI moves. The copy is a snapshot with `SYNC.md`; the integrator
re-syncs when the panel kit changes.

**Consumes**: U1 portal/admin/reseller routes, U2 admin/developer routes. Mock the API in tests;
bind to real endpoints last.

**Commands**: `cd hub/ui && npm install && npx vitest run && npm run build` · `cd hub && npm test` (SPA fallback test).

---

## U4 — panel license client (§16.8)

**Create**
```
server/src/lib/canonical.js                   byte-identical port of hub/shared/canonical.js
server/src/services/license-keys.json         { "keys": [ { "kid", "pub", "not_after" } ] } — vendor LICENSE keys (≥ 2); tests point config.licenseKeysFile at server/test/fixtures/license-keys.test.json
server/src/services/license.js                createLicenseService(ctx) → ctx.license (below); boot verify, check-in job 'license.checkin', state machine, events, key pinning, hub.request
server/src/middleware/license.js              licenseGate(ctx) (degraded → 423 on mutations except the allow-list below), requireFeature(flag), featureGates (below)
server/src/routes/license.js                  GET /api/license · POST /key · /checkin · /deactivate · /trial · GET /activations (root; reachable in degraded mode)
server/src/db/migrations/031_license.sql      license_state, license_events (§16.8)
agent/src/ops/fingerprint.js                  defineOp('sys.fingerprint') read-only: hashes of machine-id, default-route MAC, root fs UUID (§16.5), never raw values
server/test/license.test.js  agent/test/fingerprint.test.js  server/test/fixtures/{canonical-vectors.json,license-keys.test.json}
client/src/pages/server-configuration/LicenseTab.jsx   key entry/replace (the ONLY place a key is entered), hub URL display, Check in now, edition/limits/features, activations (Deactivate / Transfer), Start trial, portal link
client/test/license.test.jsx
```
**Edit**: `server/src/index.js` (`ctx.license = createLicenseService(ctx)` before `createApp`; `license.boot()` after migrate), `server/src/app.js` (`licenseGate` right after `requireAuth`), `server/src/routes/index.js` (mount `/license` before the gate's effect), `server/src/services/accounts.js` (`ctx.license?.assertCapacity('accounts')` in `create()`), `server/src/services/resellers.js` (one line `ctx.license?.assertCapacity('resellers')` — the only category-file edit, coordinate with that category's owner), `server/src/services/system.js` (`status().license` from `ctx.license.summary()` — `Home.jsx` already renders `status.license.status`), `client/src/pages/fn/server-configuration/basic-webhost-manager-setup.jsx` (add the License tab), `client/src/components/Layout.jsx` (grace/degraded banner from `/api/auth/me.license`), `server/src/routes/auth.js` (`me` carries `license: { status, edition, daysLeft }`), `.env.example` (`WHM_LICENSE_HUB_URL`, `WHM_LICENSE_KEYS_FILE`).

**Hub URL precedence.** `config.licenseHubUrl` (env `WHM_LICENSE_HUB_URL`, default the vendor's public hub) is
the **bootstrap** URL used for `/v1/activate` and `/v1/trial` when no token exists. Once a token exists,
`hubUrl()` returns `token.iss` and every call goes there. The Market Provider Manager `whm-hub` row is not a
URL source for the license client; U5 checks that its origin equals `hubUrl()` (`hub_mismatch`).

**Feature gates and the degraded allow-list (concrete, as mounted today)**
```js
featureGates = {                       // method + /api path prefix → feature flag (403 feature_required)
  'ALL /transfers': 'transfers',
  'ALL /clusters': 'clusters',
  'ALL /dns/zones/import': 'clusters',          // the clusters guard mount
  'ALL /server-config/terminal': 'terminal',
  'POST /development/tokens': 'api',            // API-token creation only; listing/expiring stays allowed
  'PUT /themes/config': 'white_label',          // branding config
  'POST /marketplace/install': 'marketplace_paid',   // applied by U5 only when the plugin's pricing is not free
  'POST /marketplace/update/:id': 'marketplace_paid',
};
degradedAllow = [                      // mutations still allowed in degraded mode (everything else non-GET → 423 license_degraded)
  'ALL /auth/*', 'ALL /license/*',
  'POST /system/services/:name/restart', 'POST /system/services/:name/start', 'POST /system/services/:name/reload',
  'ALL /backup/*',                               // rescue data: backups, restores, destinations
  'POST /accounts/:username/unsuspend',
  'GET /plugins/ui', 'GET /plugins/ui/:id/file', // the shell needs the plugin nav even when degraded
];
```
GETs are never gated. `/api/marketplace/*` and `/api/plugins/manage/install` mutations are degraded like
everything else (§18.6).

**Exposes (`ctx.license`)**
```js
get()            → { status: 'unlicensed'|'active'|'grace'|'degraded'|'expired'|'suspended'|'revoked', edition, rank, limits, features, activationId, keyPrefix, hubUrl, lexp, exp, lastCheckinAt, nextCheckinAt, failCount, messages }   // sync, cached
summary()        → the Statistics row shape { status, edition, daysLeft, activations: '1/1', lastCheckinAt }
token()          → 'WHMT1.…' | null             // the current token (never logged); U5 sends it in signed POST bodies
hubUrl()         → token.iss when a token exists, else config.licenseHubUrl
assertCapacity('accounts'|'resellers')   → throws HttpError 409 license_limit { limit, used }
hasFeature(flag) → boolean;   requireFeature(flag) → express middleware (403 feature_required)
isDegraded()     → boolean
activate(key, user, req) · checkin({ force }) · deactivate(reason) · startTrial(email) · activations()
pluginSigningKids() → ['7b2d4e10', …]   // active + retiring kids pinned from the last signed activation/check-in; files in <dataDir>/plugin-keys/<kid>.pub; conflicts excluded
hub.request(path, body, { timeoutMs = 30000 } = {})   // POST hubUrl()+path with { ...body, nonce, ts } and X-WHM-Nonce/X-WHM-Timestamp through `transport`;
                 //   verifies X-WHM-Signature (kid ∈ compiled-in license keys, canonical body, echoed nonce) → { data, meta } or throws
                 //   HttpError 502 hub_signature_invalid | hub_nonce_mismatch | hub_unreachable (503); never follows redirects; https only
verifySigned(bodyBuffer, signatureHeader) → boolean   // same verification for callers that hold a raw response
on('status_changed'|'keys_changed'|'message', fn)      // 'message' delivers check-in messages such as plugin_revocations_pending and the signed revocations_head_ts
transport        → { request(url, { method, body, headers, timeoutMs, maxBytes = 1 MiB }) }  // replaced by tests with a mock hub; U5 mocks THIS, never its own transport; U5 passes maxBytes = 20 MiB for package downloads
```
Key pinning lives here (U5 only reads `pluginSigningKids()`): every `plugin_signing_keys` entry
(`active`, `retiring`, `pending`) in a verified response is written to `plugin-keys/<kid>.pub`; a kid missing
from the list is removed only if `license_state.payload_json.pinnedKids` lists it; an existing file not in
`pinnedKids` (or with different content) is never overwritten — audit `license.plugin_key_conflict`, notify,
exclude the kid (§18.6). The signed `revocations_head_ts` is stored in `license_state.payload_json` and
emitted as `on('message')` `{ code: 'revocations_head_ts', value }` for U5.

**Consumes**: §16.6 wire contract (mocked), U1 golden vectors (copied), `ctx.contacts.notify` (tolerate absence), `ctx.agent.op('sys.fingerprint')`.

**Tests**: §16.12 "Panel `license.js`" paragraph: boot verify with pinned keys; cache; network failure stays `active` until `exp`; fake-clock timeline `active → grace → degraded`; degraded RBAC matrix over the **concrete** lists above (every listed mutation allowed, `POST /api/accounts` / `PUT /api/packages/:name` / `POST /api/dns/zones` / `POST /api/plugins/manage/install` → 423, all GETs 200, **no agent op dispatched** on any license transition — assert `agent.calls` is empty); feature-gate matrix (`POST /api/development/tokens` 403 without `api`, `GET /api/development/tokens` 200; `PUT /api/themes/config` 403 without `white_label`; `/api/dns/zones/import` 403 without `clusters`); `assertCapacity`/`requireFeature` messages; events → `audit_log` + Contact Manager; `/api/license` payload shape; key pinning writes/removes files, retiring kept, operator-file conflict preserved + audited; `hub.request` rejects a tampered signature, a wrong nonce echo, an unknown kid, an `http://` URL; `hubUrl()` precedence; agent op schema rejects anything but `{}` and never returns raw identifiers.

**Commands**: `cd server && npx vitest run` · `cd agent && npx vitest run` · `cd client && npx vitest run && npm run build` · `BASE=… PASSWORD=… node e2e/ui-check.cjs`.

---

## U5 — panel marketplace client (§18.6)

**Create**
```
server/src/services/marketplace-client.js     createMarketplaceClient(ctx) → ctx.marketplace (below); jobs 'marketplace.install', 'marketplace.update', 'marketplace.revocations', 'marketplace.update-check'; registers the host enable guard
server/src/routes/marketplace.js              GET /api/marketplace/status · /catalog · /categories · /plugins/:id · /plugins/:id/versions · /updates · /revocations ·
                                              POST /install { pluginId, version?, channel?, consent?, allowDowngrade? } → 202 · POST /update/:id → 202 · POST /consent/:id { permissions } ·
                                              DELETE /:id?purge · POST /revocations/:id/ack · POST /plugins/:id/reviews
server/src/db/migrations/032_marketplace.sql  marketplace_installs, marketplace_revocations, marketplace_state (§18.6)
client/src/pages/cpanel/MarketplaceTab.jsx    catalog grid, search/category, detail drawer (permissions via describePermission + justifications, versions, reviews), Install/Update/Uninstall, ConsentModal, hub_mismatch notice
client/src/pages/cpanel/ConsentModal.jsx      scopes + SDK descriptions + justifications + TrustNotice; posts /consent/:id with the `required` list the job returned
client/src/components/RevocationBanner.jsx    red banner until acknowledged
client/test/marketplace.test.jsx  server/test/marketplace-client.test.js  server/test/fixtures/hub/*.json
```
**Edit**:
- `server/src/routes/index.js` (mount `/marketplace` after `/plugins`), `server/src/index.js` (`ctx.marketplace = createMarketplaceClient(ctx)` after `ctx.license`).
- `server/src/services/plugins.js` — **additive host edits, all four listed here and nowhere else**:
  1. `install(input, { user, req, policy })` with `policy = { requireSigned: true, signers: [kid…], activate: true|false }`: `requireSigned` → `422 unsigned_package` / `422 untrusted_signer` regardless of `plugins.require_signature`; `activate: false` → an upgraded plugin is left `disabled` (state persisted, no `enable()` call) and the result gains `wasEnabled: boolean`; `source: 'marketplace'` passed through.
  2. `verifySignature(root, { source })` developer-mode gate: when `ctx.marketplace?.status().enabled === true` and `source ∉ { 'bundled', 'marketplace' }`, an unsigned or unverifiable package needs `ctx.settings.get('plugins.developer_mode') === true`, else `422 unsigned_package` "enable plugins.developer_mode to sideload while the marketplace is enabled". `source: 'bundled'` is exempt from both gates.
  3. `source = 'bundled'` only when `fs.realpathSync(input.dir)` is under `REPO_ROOT/plugins/bundled/`; otherwise the install is recorded as `path` (closes the "root sideloads anything as bundled" hole).
  4. `guards = { enable: [] }` exported on the host; `enable(id)` runs every guard `fn(id, row)` before activation and lets a thrown `HttpError` propagate (the marketplace client pushes the `409 plugin_revoked` guard). Covers `POST /api/plugins/manage/:id/enable` and programmatic `ctx.plugins.enable()`.
  One new test block in `server/test/plugin-host.test.js` covers all four (policy refusals, `activate: false` leaves the upgrade disabled and reports `wasEnabled`, developer-mode gate on/off with the hub enabled, bundled exemption, non-repo dir downgraded to `path`, enable guard refuses).
- `server/src/services/market-adapters.js` (Market category — coordinated edit): remove the `licenseKey` config field from the `hub` adapter; `test()` probes `/v1/status/<prefix>` with `ctx.license?.get().keyPrefix` (passed in through `io`) or `/v1/keys` when none; `server/src/services/market.js` `hub()` returns `{ enabled, url }` with a comment pointing at `ctx.license` as the owner of key and URL. No migration: stored `licenseKey` values are never read again.
- `client/src/pages/fn/cpanel/manage-plugins.jsx` (Marketplace tab + "Sideloaded" label + developer-mode switch `plugins.developer_mode` + "Issue restore token" button on the detail view), `client/src/pages/fn/server-configuration/whm-marketplace.jsx` (hub catalog when `GET /api/marketplace/status.enabled`, static catalog under "Distribution packages"), `client/src/pages/fn/market/market-provider-manager.jsx` (hub row: link "License key is entered under Basic Setup → License"), `client/src/components/Layout.jsx` (mount `RevocationBanner`), `server/src/services/server-contacts.js` event catalog (`plugin.revoked`, `plugin.update_available`, `license.plugin_key_conflict` — coordinate with that category's owner).

**Exposes (`ctx.marketplace`)**
```js
status()                → { enabled, url, hubUrl, hubMismatch: boolean, licenseStatus, hubKids, lastRevocationTs, revocationsHeadTs, pendingUpdates }
catalog(query), plugin(id), versions(id), updates()
install({ pluginId, version, channel, consent, allowDowngrade }, user, req) → { job }
   // job finishes done with result { status: 'installed', pluginId, version }
   // or done with result { status: 'pending_consent', pluginId, version, required: [scope…], added: [scope…], justifications } (plugin installed, disabled)
   // failures: failed with error_code downgrade_refused | hub_mismatch | sha256_mismatch | unsigned_package | untrusted_signer | incompatible_host | license_degraded | entitlement_required | …
consent(id, permissions, user, req) → { plugin }   // compares with ctx.plugins.get(id).manifest.permissions, enables, records consent
update(id, user, req) → { job };  uninstall(id, { purge }, user, req)
pollRevocations()       → { applied: [...] }   // also called by license.js messages plugin_revocations_pending / revocations_head_ts
```
`ctx.marketplace` has **no transport of its own**: every hub call goes through `ctx.license.hub.request()`
(signed POSTs) or, for public GET catalog reads, `ctx.license.transport.request()` with `hubUrl()`; tests mock
`ctx.license.transport` only.

**Consumes**: U2 public GET routes and signed POST routes (mocked with recorded JSON fixtures in `server/test/fixtures/hub/`), U4 `ctx.license.get()/token()/hubUrl()/hub.request()/verifySigned()/pluginSigningKids()/requireFeature('marketplace_paid')/isDegraded()/on('…')`, `ctx.market.hub()` (exists; `{ enabled, url }` after the adapter edit), `ctx.plugins.install/enable/disable/uninstall/get/guards` (exist + the four additive edits above), U6 signed fixture package for the end-to-end install test.

**Tests**: §18.10 "Panel client" bullet in full, plus: static catalog served when the hub row is disabled; `ctx.license.transport` never called with `http://`; cache file removed after install; consent recorded with `consented_by`; `pending_consent` result shape; reseller sees WHM Marketplace read-only; `requireFeature('marketplace_paid')` applied only to paid plugins.

**Commands**: `cd server && npx vitest run` · `cd client && npx vitest run && npm run build` · `e2e/ui-check.cjs` · screenshots refresh (`e2e/screenshots.sh`) for Manage Plugins → Marketplace and WHM Marketplace.

---

## U6 — `plugins/SDK.md`, `plugins/sdk/pack.js`, sample plugin, automated-backup plugin, `scripts/build-plugin.js`

**Create**
```
plugins/SDK.md                        the developer reference, written against the committed SDK and the real host (plugin-host.md): manifest (every key, vocabularies from validate-manifest.js), permissions table (PERMISSIONS text verbatim), events catalog, every ctx.* method with signature/gate/errors (mirror mock-host.js 1:1, note the host differences plugin-host.md lists), lifecycle (install → installed → enable → migrate(from) → activate → disable → uninstall; ACTIVATE_TIMEOUT_MS, HOOK_TIMEOUT_MS), pages/kinds, jobs/cron, i18n, limits (MAX_* constants), trust model, packaging .whmplugin (tar rules, 20/50 MiB), DEV-SIGNATURE.json & SIGNATURE.json (§18.3 rule, kid rule, **standard base64 with padding**), testing with createMockHost, submission to the marketplace (§18.2–18.3: namespaces, TOTP, key challenge, upload rule), changelog/versioning rules, "backups: remote copies are governed by the destination's own retention; ctx.api.backups.delete removes the local artefact only"
plugins/sdk/pack.js                   CommonJS, zero deps: packDirectory(dir, { exclude }) → gzip tar Buffer (ustar, sorted entries, mtime 0, mode 0644/0755, no links), unpack(buf, dest, { maxBytes, maxEntries }) (same refusals as server/src/lib/tar.js), packageDigest(dir, { exclude = ['SIGNATURE.json'] }) → Buffer, sign(digest, privateKeyPem) → standard base64 with padding, verify(digest, sigB64, publicKeyPem) (accepts the exact string the host decodes), kidOf(publicKeyPem), writeSignature(dir, fileName, { kid, sig })
plugins/sdk/test/pack.test.js         round-trip, determinism (two packs byte-identical), refusals, parity: packageDigest(dir) equals server/src/services/plugins.js packageDigest(dir) (dynamic import), extractTar(server) accepts pack.js output, and the host's verifySignature accepts a SIGNATURE.json written by sign() (exact base64 string)
scripts/build-plugin.js               node scripts/build-plugin.js <dir> [--out file.whmplugin] [--sign <private.pem> [--dev]] [--kid <kid>]: validateManifest → pack → optional DEV-SIGNATURE.json (--dev, excludes both signature files) or SIGNATURE.json (local trusted-key signing for operators) → prints sha256 + kid; refuses an invalid manifest and a source dir that already contains SIGNATURE.json unless --sign without --dev
plugins/sample-plugin/                id net.whm.sample-notes — one of every extension point: settings (every field type), hooks (pre cancellable + post), jobs (cancellable + locked), cron (setting-bound + fixed), pages (settings, table, form, action, markdown, html), routes with roles, store kv + collection, fs, crypto, net.fetch with a scope, events.emit, i18n (en + de), migrate(from); plugin.json, main.js, locales/, README.md, package.json (test: node --test), test/*.test.js against createMockHost (every extension point asserted)
plugins/bundled/net.whm.automated-backup/   id net.whm.automated-backup (BUNDLED — decision below): permissions backups:read backups:write backups:restore accounts:read packages:read settings:own store:own schedule jobs contacts:notify ui:sidebar api:routes;
                                      settings: scope (select all|packages|accounts), packages/accounts (textarea, one per line, pattern), include components (multiselect over BACKUP_COMPONENTS), schedule (text, cron pattern), retention daily/weekly/monthly (number), destinations (textarea: destination ids one per line, pattern ^[A-Za-z0-9_-]{1,64}$; validated at run time against ctx.api.backups.destinations.list() — unknown ids become a run warning and are skipped), verify (boolean), encrypt (boolean*), notify_on (select failure|success|both|never), max_parallel (number), lock_ttl_minutes (number);
                                      jobs: run (per-account lock in ctx.store kv `lock:<account>` with TTL, create → verify → upload per destination → record), prune (retention by day/week/month buckets; deletes LOCAL artefacts through ctx.api.backups.delete; remote copies are left to the destination's own retention and recorded as remote: 'retained' in the run history), restore (requires { artefactId, account, confirmToken } from POST /api/plugins/manage/net.whm.automated-backup/restore-token);
                                      cron `schedule` → run; hooks backup.completed/backup.failed (records host-initiated backups too), account.terminated (drops locks/history); run history collection `runs`; pages: settings, history (table), destinations (table listing ctx.api.backups.destinations.list() so the operator can copy ids), run-now (action), restore (form); routes GET /runs, GET /locks, POST /locks/:account/release (root); notifications via ctx.api.contacts.notify; README.md; test/*.test.js (schedule advance runs the job, locks block overlap and expire, retention keeps the right buckets and asserts mock `backupsDeleted` only, unknown destination id → warning, restore refuses a bad/used token, destinations upload recorded, failure notifies, host-initiated backups appear in history, encrypt:true surfaces UNSUPPORTED as a run warning)
```
\* the host only produces gzip, unencrypted archives (`COMPRESSIONS = ['gzip']`, `encrypt:true` → `UNSUPPORTED` 422); the plugin cannot read archive bytes (`ctx.fs` is its data dir), so the toggle requests encryption from the host and records the refusal as a warning — documented in README and SDK.md. The SDK has no dynamic option source for `multiselect` (`validate-manifest.js` requires a static `options` array) and no API to delete a remote copy (`backups.create/list/delete/upload/verify/restore/destinations.list` only), which is why destinations are ids in a `textarea` and prune is local-only.

**Edit**: `plugins/sdk/index.js` — one line: `pack: require('./pack')` added to `module.exports` (the only change to committed SDK code; `SDK_VERSION` stays `1.0.0`; the existing `test/*.test.js` glob already runs `pack.test.js`). `server/src/services/plugins-bundled.js` (Plugins category — coordinated edit): a fourth `BUNDLED_PLUGINS` entry `{ id: 'net.whm.automated-backup', fnKey: null, label: 'Automated Backup', roles: ['root'] }`; the ensure/repair code tolerates `fnKey: null` (no function page; the plugin's own `ui:sidebar` pages carry its UI).

**Decision — automated-backup is bundled.** It lives at `plugins/bundled/net.whm.automated-backup/` and is
installed and enabled at boot by `plugins-bundled.js` like the three existing bundled plugins (`install({ dir,
source: 'bundled' })`, exempt from the signature gates per §18.6), so a fresh install without a hub gets it.
It is **not** seeded into the hub catalog and is never updated from the hub (bundled plugins update with the
panel release). `net.whm.sample-notes` is the marketplace-distributed one: seeded into the hub catalog
fixtures under the vendor developer `net.whm` (verified) and used by the integrator's green gate. Recorded in
`CLAUDE.md` by the integrator (step 4).

**Exposes**: `plugins/sdk/pack.js` (U2 and U5 consume; `sdk.pack` export), signed fixtures `plugins/sample-plugin/test/fixtures/{dev.pem,dev.pub,sample-notes-signed.whmplugin}` regenerated by `test/build-fixture.js` (U2 upload tests, U5 install tests), `scripts/build-plugin.js` (hub docs and README point at it).

**Consumes**: the committed SDK only; `server/src/services/plugins.js` and `server/src/lib/tar.js` in the parity test (test-time import, no runtime dependency).

**Commands**: `npm test --prefix plugins/sdk` · `node --test plugins/sample-plugin/test` · `node --test plugins/bundled/net.whm.automated-backup/test` · `node scripts/build-plugin.js plugins/sample-plugin --out /tmp/x.whmplugin` then `cd server && npx vitest run plugin-host` (install the produced file via `{ path }` in a one-off test) · `cd server && npx vitest run plugins-bundled` (fourth bundled plugin installs at boot).

---

## Cross-unit contracts in one place

| Contract | Owner | Consumers | Fixed by |
|---|---|---|---|
| `.whmplugin` format, `packageDigest`, `SIGNATURE.json { kid, alg, sig }`, `plugin-keys/<kid>.pub`, `KID_RE` | existing host (`services/plugins.js`) | U2, U5, U6 | plugin-host.md — unchanged |
| **Signature encoding**: `SIGNATURE.json.sig` and `DEV-SIGNATURE.json.sig` are standard base64 **with padding**; license tokens and `X-WHM-Signature` are base64url; `keys.sign()`/`pack.js sign()` take/emit exactly that | §18.3 | U1, U2, U6, host | marketplace.md §18.3 |
| `DEV-SIGNATURE.json` = same digest with both signature files excluded; upload rule `status IN ('verified','pending') AND verified_at IS NOT NULL`, publish requires `verified` | §18.2–18.3 | U2, U6 | marketplace.md |
| `kid` = first 8 hex of `sha256(raw 32-byte public key)` for license, plugin and developer keys; developer kids unique across `developer_keys` and absent from `signing_keys` | §16.4, §18.2 | U1, U2, U4, U6 | license-server.md, marketplace.md |
| **`signing_keys` with `purpose`** lives in license.db; `ctx.keys.active(purpose)/byKid/listPublic('plugin')/sign({ kid, purpose, encoding })`; `hub.conf keys.active_kid: { license, plugin }`; `/v1/admin/signing-keys` (`purpose`, `activate`, `retire` + hooks `keyActivated`/`beforeKeyRetire`) | U1 | U2, U3 | this plan (§16 errata) |
| **Trust chain**: hub responses verified only against compiled-in license keys; plugin keys only verify packages; `sign()` refuses cross-purpose | §18 preamble, §18.9 | U1, U2, U4, U5 | marketplace.md |
| JCS canonical form + golden vectors | U1 `hub/shared/canonical.js` | U4 copy | `hub/test/fixtures/canonical-vectors.json` |
| Token payload, activation/check-in request/response (incl. `usage.plugins`, `plugin_signing_keys`, `revocations_head_ts`), error codes, signed responses, `ctx.app.signed` | §16.4–16.6 + errata | U1, U2, U4 | license-server.md + this plan |
| `plugin_signing_keys` (`active` + `retiring` + `pending`) in activation/check-in `data`; panel pins them, never overwrites an operator file | U2 via U1 `activationExtras` | U4 pins, U5 reads | marketplace.md §18.6 |
| Signed panel API: `POST /v1/market/download|updates|revocations|plugins/:id/reviews` shapes; feed freshness (`now` ± 300 s, monotonic, `head_ts`) | U2 | U5 | marketplace.md §18.4, §18.6 |
| Download URL: HMAC over `dl_id|activation_id|exp` with `/etc/whm-hub/keys/download.hmac`, single-use; live license/activation/fingerprint checks | U2 (key from U1 `gen-key.js --hmac`) | U5 | marketplace.md §18.4 |
| **`ctx.license` surface** incl. `token()`, `hubUrl()`, `hub.request()`, `verifySigned()`, `keyPrefix`, `on('message')` | U4 | U5, core | this plan |
| **Hub identity**: `ctx.license` owns URL (`token.iss`, bootstrap `WHM_LICENSE_HUB_URL`) and key (License tab only); `market.hub()` → `{ enabled, url }`, origin must equal `hubUrl()` else `hub_mismatch`; adapter `licenseKey` field removed | U4 + U5 | Market category, client | this plan, marketplace.md §18.6 |
| `ctx.marketplace` surface; job result shapes (`done` + `{ status: 'installed' | 'pending_consent', … }`); consent compared with the installed manifest | U5 | client, integrator | this plan |
| **Host additive edits** (`policy: { requireSigned, signers, activate }` + `wasEnabled`; developer-mode gate in `verifySignature()` with `source` exemptions `bundled`/`marketplace`; `bundled` only under `plugins/bundled/`; `guards.enable`) | U5 (`services/plugins.js`, tested in `plugin-host.test.js`) | U5, U6 (bundled exemption), Plugins category | this plan, marketplace.md §18.6 |
| Revocation matching: any `plugins` row with matching id and `signer ∈ hubKids`; `critical` also same-id unsigned; re-enable guard `409 plugin_revoked` | U5 | host, client | marketplace.md §18.6 |
| `plugins/sdk/pack.js` API + `sdk.pack` export | U6 | U2, U5, `scripts/build-plugin.js` | this plan |
| Automated-backup: bundled under `plugins/bundled/net.whm.automated-backup/`, fourth `BUNDLED_PLUGINS` entry (`fnKey: null`); destinations as ids (textarea); prune local-only | U6 | Plugins category, integrator | this plan |
| Billing discriminator `metadata.whm_kind ∈ license|plugin_purchase`; magic links single-use/15 min/e-mail-bound | §18.5 + errata | U1, U2 | marketplace.md, this plan |
| `shared/webhooks.js enqueue(db, …)` with `ownerType = 'developer'` → marketplace.db `developer_webhook_*`; `shared/safe-fetch.js` for every developer-supplied host | U1 | U2 | this plan |
| Feature-gate map and degraded allow-list (concrete paths) | U4 | core tests, U5 | this plan |
| **`transport.request(url, { method, body, headers, timeoutMs, maxBytes })`** honours a per-call `maxBytes` (default `MAX_RESPONSE_BYTES` = 1 MiB for signed JSON answers; U5 passes `MAX_PACKAGE_BYTES` = 20 MiB with a 60 s timeout for package downloads, §18.6) and rejects with "hub response too large" above it | U4 (`services/license.js`) | U5 (`fetchPackage`) | this plan (U5 fix round 2) |
| Host `policy.expectedId`: `install()` answers `422 plugin_id_mismatch` right after manifest validation, before `verifySignature()` and the directory swap, when `manifest.id !== policy.expectedId`; U5 passes the requested `pluginId` | U5 (`services/plugins.js`) | U5 | this plan (U5 fix round 2) |
| `market.update/configure/setEnabled` of the `whm-hub` row call `ctx.marketplace?.onHubChanged?.()` (lazy, tolerates absence) so the marketplace schedules flip with the row; `requireHub()`/catalog reads never write | Market category (`services/market.js`) + U5 | U5 | this plan (U5 fix round 2) |
| **Reseller catalog**: `GET /v1/reseller/products` (scope `license:read`) → `{ data: [ { sku, name, edition, term, term_days, price_cents, currency, active, limits, features } ] }`, active products only, every edition (the UI narrows to `quota_left`); until it exists the reseller forms take a free SKU input and the hub's 404 `Product not found` is the error | U1 (`license/routes/reseller.js`) | U3 (`pages/reseller/Licenses.jsx` `useResellerProducts`) | this plan (fix round 1) |
| **Reseller brand in the portal session**: `GET /v1/portal/me` and `POST /v1/portal/login` carry `reseller: { id, name, brand: { name?, logo_url?, support_url? } }` (from `resellers.brand_json`) for users with `reseller_id`; absent for vendor users | U1 (`license/routes/portal.js`) | U3 (`auth/AuthContext.jsx brandOf()`, `shell/Shell.jsx`; https URLs only) | this plan (fix round 1) |
| **Impersonate reseller (§16.9, DEFERRED)**: `POST /v1/admin/resellers/:id/impersonate` † (vendor_admin, step-up) → `{ data: { expires_at } }` after rebinding the portal session to a short-lived (≤ 1 h) `reseller_admin` scope for that reseller, `audit_log` rows `reseller.impersonate` on start and `reseller.impersonate_end` on `POST /v1/portal/impersonate/end` or expiry; `/v1/portal/me` carries `impersonating: { reseller_id, by, expires_at }`. No hub route exists yet, so the vendor Resellers drawer has no Impersonate action; U3 adds it (banner + "End impersonation" in the Shell) when U1 lands the route | U1 (`license/routes/admin.js`, `portal.js`) | U3 (`pages/admin/Resellers.jsx`, `shell/Shell.jsx`) | this plan (fix round 2) |

Anything not listed is internal to its unit. A unit that needs more from another unit adds a
row here first (the integrator merges the doc), then builds.

## Integrator checklist (after round 3)

1. **BLUEPRINT.md**: insert `docs/design/license-server.md` as §16 **verbatim except for the "§16 errata" table
   above**: replace the §16.1 tree and table with the §18.1 ones, apply the §16.3 (`signing_keys.purpose`,
   `portal_sessions`), §16.4 (pinning wording), §16.6 (`usage.plugins`, `plugin_signing_keys`,
   `revocations_head_ts`), §16.7 (signing-keys routes, `whm_kind`) amendments, and change every "§17" that means
   the marketplace to "§18"; a §17 *Plugin SDK & host* (summary + pointers to `plugins/SDK.md` and
   `docs/design/plugin-host.md`); `docs/design/marketplace.md` as §18 (its §18.1 erratum box may be shortened
   to one sentence once §16 is amended in place); extend the TOC, §5 layout (`hub/`, `plugins/`,
   `scripts/build-plugin.js`), §6 tables (`license_state`, `license_events`, `marketplace_*`), §13.27 Market
   (hub row = enable switch, key under License tab) and §13.30 Plugins (marketplace install, consent, developer
   mode, bundled exemption), §14 roadmap row **P7 Commercial** (from §16.12) and §15 test list (hub suite,
   parity tests, SSRF and namespace fixtures).
2. **Root `package.json`**: workspaces `+ hub`, `+ hub/ui`; `test` script adds `npm test --prefix hub`,
   `--prefix hub/ui`, `node --test plugins/sample-plugin/test plugins/bundled/net.whm.automated-backup/test`; `build` adds `hub/ui`.
3. **Deploy**: `deploy/whm-hub.service` (`User=whmhub`, `EnvironmentFile=/etc/whm-hub/hub.env`,
   `ReadWritePaths=/var/lib/whm-hub /var/log/whm-hub`, `ReadOnlyPaths=/etc/whm-hub`), `deploy/hub.conf.example`
   (JSON); `scripts/install.sh --with-hub` (creates `whmhub`, `/etc/whm-hub`, `/var/lib/whm-hub`, runs
   `hub/scripts/gen-key.js --master`, `--hmac`, `--license` **and** `--plugin`, sets `keys.active_kid` in
   `hub.conf`, prints the license `{ kid, pub }` to paste into `license-keys.json`), and `scripts/install.sh`
   (panel) writes `WHM_LICENSE_HUB_URL` into `/etc/whm/panel.env` when asked.
4. **Bundled plugins**: `plugins/bundled/net.whm.automated-backup` is installed at boot by `plugins-bundled.js`
   (U6 decision above); `plugins/sample-plugin` is seeded into the hub catalog fixtures under the vendor developer
   `net.whm` (verified). Record both in `CLAUDE.md`'s decisions table together with the bundled signature
   exemption and the developer-mode gate.
5. **Server Contacts** event catalog gains `license.*` (§16.8), `license.plugin_key_conflict`, `plugin.revoked`,
   `plugin.update_available`; **Security Advisor** gains the manifest-integrity finding (§16.10) — small edits in
   those categories.
6. **CHECKLIST.md**: tick the "Deferred work" items, add the hub suite counts and the e2e/screenshot refresh;
   **README.md**: hub section (install, ports 7443/7440, key generation incl. purpose, first license, marketplace
   developer flow: TOTP, namespace evidence, key challenge, upload, review, publish); **CLAUDE.md**: current-state
   entry, decisions table (copy-not-import for hub/ui, automated-backup bundled / sample plugin marketplace-distributed,
   additive host `policy`/guard edits, `ctx.license` owns hub identity, standard-base64 package signatures, JSON
   `hub.conf`), "Resume notes" (disable the keep-alive Routine when CHECKLIST is done).
7. **Green gate before push**: `npm test` (all workspaces + SDK + plugins), `npm run build`, boot in monolithic
   mode with a temp data dir and the hub on `:7443` with test keys: activate a trial from Basic Setup → License,
   enable the `whm-hub` provider (same origin → no `hub_mismatch`), install `net.whm.sample-notes` from the
   Marketplace tab through the consent screen, publish a 1.0.1 with one more scope and confirm the update stops
   at `pending_consent` with the plugin disabled, consent, revoke it from the admin portal, watch the banner appear
   and the enable button answer `plugin_revoked`; `e2e/ui-check.cjs`; `e2e/screenshots.sh`; commit.
