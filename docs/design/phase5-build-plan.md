# Phase 5 build plan — license server, marketplace, hub UI, panel clients, SDK & plugins

Implementation plan for the deferred Phase 5 work. Designs of record: `docs/design/license-server.md`
(§16, binding), `docs/design/marketplace.md` (§18, binding), `docs/design/plugin-host.md` (the real host),
`plugins/sdk/` (committed SDK: `validate-manifest.js`, `mock-host.js`, `errors.js`, `semver.js`, `cron.js`).
Nothing in `plugins/sdk/*.js` is regenerated; everything below is built against it.

The work is **six independent units**. Two engineers run them **two at a time** in three rounds;
each unit lists the interfaces it *exposes* and *consumes* so a unit can be built against the
contract before its neighbour lands. Every unit ends with the listed commands green and no edits
outside its file list. Conventions from `CLAUDE.md` apply unchanged (ES modules, zod on every
route, `{ data, meta }` / `{ error }` envelopes, audit rows, no shell strings, `CapabilityError`).

## Rounds and dependencies

| Round | Engineer A | Engineer B | Why this pairing |
|---|---|---|---|
| 1 | **U1 hub/license** | **U6 SDK docs + sample + automated-backup + build-plugin** | neither consumes another unit; U6 produces `plugins/sdk/pack.js` and the golden `.whmplugin` fixtures U2 and U5 test against |
| 2 | **U2 hub/marketplace** (consumes U1 `hub/shared/*`, `ctx.licenses`, U6 `pack.js`) | **U4 panel license client** (consumes U1 `canonical.js` golden vectors + token shape; mocks the hub) | both are server-side; U4 only needs U1's *wire contract*, which is fixed in §16 |
| 3 | **U3 hub UI** (consumes U1 + U2 routes) | **U5 panel marketplace client** (consumes U2 catalog routes, U4 `ctx.license`, U6 fixtures; mocks the hub) | both are the last consumers |

Hard ordering: U2 starts after U1's `hub/shared/` exports exist (they are the first thing U1
writes, in its first day); U5 starts after U4 exports `ctx.license.get()/pluginSigningKids()`
(stub them if U4 is late — the shapes are below). U3 may start on the component copy and routing
while U2 is in progress and bind to real endpoints last.

---

## U1 — `hub/license`: the license server (§16)

**Create**
```
hub/package.json                      "@whm/hub", type module, deps: express ^4, better-sqlite3 ^11, zod ^3, helmet ^8,
                                      express-rate-limit ^7, bcryptjs, otplib, pino, pino-http; scripts: start, test (node --test "test/**/*.test.js"), dev
hub/src/index.js                      bootstrap(): config → shared db (license.db [+ marketplace.db when U2 registers]) → migrate → services → app → HTTPS :7443, loopback :7440 /healthz /metrics
hub/src/app.js                        helmet, pino-http, rate limits (§16.10 table), auth middlewares, mounts, error → envelope
hub/src/config.js                     /etc/whm-hub/hub.conf (yaml-ish key: value; or JSON) + env WHM_HUB_*; test override object
hub/shared/db.js                      openDb(path, { migrationsDir, logger }) → better-sqlite3 handle (WAL, foreign_keys), migrate() runner (0NN_*.sql, immutable)
hub/shared/crypto.js                  copy of server/src/lib/crypto.js (AES-256-GCM v1:, bcrypt, hashToken, totp) — keep byte-identical except the import style
hub/shared/canonical.js               canonicalize(value) → Buffer (JCS subset §16.4); throws on floats/NaN/undefined
hub/shared/keys.js                    loadSigningKeys(dir, { activeKid }) → { active, byKid }, kidOf(publicKey) (first 8 hex of sha256(raw 32 bytes)),
                                      sign(bytes, kid) → base64url, verify(bytes, sigB64url, kid), signResponse(res, body) sets X-WHM-Signature
hub/shared/keyfmt.js                  Crockford license keys WHM-XXXX-XXXX-XXXX-XXXX: generate(), normalize(), check(), hash()
hub/shared/auth.js                    apiKeyAuth({ ownerType }), requireScope('license:issue'), portalSession (express-session on SQLite), requireRole('vendor_admin'|…), csrf
hub/shared/validate.js                validate({ params, query, body }) + fields (same shape as the panel's lib/validate.js)
hub/shared/audit.js                   record(db, { principal, role, ip, action, target, args, result }) with the panel's redaction rules
hub/shared/webhooks.js                enqueue(ownerType, ownerId, event, data) → webhook_deliveries; deliver() with HMAC header + backoff (§16.7)
hub/shared/mailer.js                  templated SMTP (nodemailer-free: minimal SMTP over TLS, or `sendmail` argv) with a test transport
hub/shared/scheduler.js               ensure(name, cron, fn); runDue(); the §16.11 schedule list
hub/shared/nonce.js                   check(nonce, ts) → replay / skew errors (10-min table TTL, 300 s skew)
hub/shared/fingerprint.js             drift(storedComponents, newComponents) → score (0.5/0.3/0.2)
hub/license/migrations/001_license.sql   every table of §16.3 (CREATE TABLE IF NOT EXISTS, seed vendors row + products rows for the 5 editions)
hub/license/services/{products,customers,resellers,licenses,activations,trials,transfers,billing,reports,portal-users}.js
hub/license/routes/{public,reseller,admin,portal}.js      exactly the §16.7 tables
hub/scripts/gen-key.js                writes /etc/whm-hub/keys/<kid>.ed25519 (0600) and prints { kid, pub } for the panel's license-keys.json
hub/scripts/hub-cli.js                create-admin, issue (sku, email), revoke, status
hub/test/fixtures/keys/               fixed Ed25519 test pair (kid printed in fixtures/index.js) + canonical-vectors.json (golden JCS vectors)
hub/test/{canonical,keyfmt,token,activate,checkin,lifecycle,trials,resellers,webhooks,billing,security}.test.js
```

**Exposes (contract for U2, U3, U4)**
- `bootstrap({ dbDir, config })` returns `ctx = { config, logger, dbs: { license }, crypto, keys, audit, webhooks, mailer, scheduler, licenses, activations, customers, resellers, products, trials, billing, app, registerModule(fn) }`.
  `registerModule(fn)` is how U2 adds its DB, services, routes and hooks (`fn(ctx)` runs before `app` is finalised).
- `ctx.licenses.verifyToken(token) → { ok, payload, reason }` (same algorithm the panel uses; used by U2 downloads), `ctx.licenses.get(lid)`, `ctx.licenses.featureOf(lid, flag)`.
- `ctx.activations.pushMessage({ licenseId?|all: true }, { level, code, text })` — queued into the next check-in's `messages` (U2 kill-switch).
- `ctx.hooks.checkin.push(fn)` — `fn({ activation, usage })` runs on every check-in (U2 records `usage.plugins`).
- `ctx.hooks.billing.push(fn)` — `fn(source, event)` after the license handler (U2 purchases).
- `ctx.hooks.activationExtras.push(fn)` — `fn(activation) → object` merged into `/v1/activate` and `/v1/checkin` `data` (U2 supplies `plugin_signing_keys`).
- Wire contract with the panel is §16.6/§16.7 verbatim: token `WHMT1.<payload>.<sig>` with the §16.4 fields, signed responses, error codes `activation_limit`, `fingerprint_mismatch`, `revoked`, `trial_exists`, `quota_exceeded`, `over_limit`.
- `hub/test/fixtures/canonical-vectors.json` — U4 copies it verbatim into `server/test/fixtures/` (parity test both sides).

**Tests** — the §16.12 list, node:test, temp SQLite per file, fixed key pair: canonical vectors; keyfmt; token sign/verify, tamper, wrong/retired kid, skew boundaries, fp drift ≤/> 0.5; activate happy/limit/reclaim/3-per-30-days/nonce replay/skew; check-in statuses + drift update + usage + rate limit; lifecycle issue → renew → upgrade → downgrade refused/forced → suspend → revoke → rekey; trials once per fingerprint/e-mail; reseller quota, scoping, scope matrix; webhooks HMAC/backoff; billing idempotency per source; security (zod rejections, 429s, no raw machine-id in any row/log).

**Commands**: `cd hub && npm install && npm test` · `node hub/src/index.js --check-config` boots against a temp dir and answers `GET /healthz`.

---

## U2 — `hub/marketplace`: developer verification, submissions, catalog, distribution (§18)

**Create**
```
hub/marketplace/index.js              register(ctx): opens marketplace.db, migrates, builds services, mounts routes, registers the U1 hooks
hub/marketplace/migrations/001_marketplace.sql    every table of §18.2–18.5 (+ categories seed)
hub/marketplace/lib/package.js        wraps plugins/sdk/pack.js: unpack (limits of plugin-host.md), packageDigest(dir, { exclude }), repackDeterministic(dir), sha256
hub/marketplace/lib/scanner-rules.js  the §18.3 reject/flag rule table as data (regex + tokeniser), typosquat distance
hub/marketplace/services/{developers,verification,keys,submissions,scanner,review,signing,catalog,distribution,entitlements,billing,revocations,payouts,stats,plugin-reviews}.js
hub/marketplace/routes/{public,developer,admin}.js        exactly the §18.4 and §18.8 tables
hub/marketplace/jobs.js               scan queue, verification re-checks (DNS TXT / well-known / GitHub), payouts-close, evidence purge (30 d), stale signed-URL cleanup
hub/test/market-*.test.js             (one file per §18.10 bullet)
```
**Edit**: `hub/src/index.js` — one line: `ctx.registerModule((await import('../marketplace/index.js')).register)`. `hub/package.json` — add `"@whm/plugin-sdk": "file:../plugins/sdk"` (CommonJS; load with `createRequire`).

**Exposes**
- Public routes of §18.4 (`/v1/market/catalog|categories|plugins/:id|plugins/:id/versions|download|updates|revocations|keys`) with the exact response shapes shown there; download descriptor errors `entitlement_required` 402, `feature_required` 403, `version_revoked` 410.
- Developer routes `/v1/dev/*` and admin routes `/v1/admin/market/*` (§18.8).
- Into U1 via hooks: `activationExtras` → `{ plugin_signing_keys: [{ kid, pub (PEM SPKI), status }] }`; `checkin` → upsert `installs`; `billing` → purchases/entitlements; `pushMessage` on kill-switch.
- Signing: `services/signing.js` writes `SIGNATURE.json = { kid, alg: 'ed25519', sig }` where `sig = ed25519(packageDigest(dir, { exclude: ['SIGNATURE.json'] }))` — the host's `packageDigest` rule, with `kid` from `signing_keys.purpose = 'plugin'`.

**Consumes**: U1 `hub/shared/*`, `ctx.licenses.verifyToken`, `ctx.hooks.*`; U6 `plugins/sdk/pack.js` (tar writer/digest/sign) and `plugins/sdk/validate-manifest.js`; U6 fixture packages `plugins/sample-plugin` (signed with the fixture developer key) for upload tests; the server's `packageDigest` for the parity test (`hub/test/market-package-parity.test.js` imports `server/src/services/plugins.js` directly — monorepo path, test-only).

**Tests**: the §18.10 list. The one test that must not be skipped: *approve → repack → sign → install on the real panel host* — boot the panel with `bootstrap()` from `server/test/support/app.js`, drop the hub's plugin public key into `<dataDir>/plugin-keys/<kid>.pub`, `POST /api/plugins/manage/install` with the signed bytes, assert `signed: true, signer: <kid>`, then flip `plugins.require_signature` on and assert an unsigned copy is refused.

**Commands**: `cd hub && npm test` · `cd server && npx vitest run plugin-host` (unchanged, proves no host edit was needed).

---

## U3 — `hub/ui`: vendor admin, developer and reseller portals

**Create**
```
hub/ui/package.json  vite.config.js  index.html  src/main.jsx  src/router.jsx  src/api/client.js (fetch + CSRF + {data,meta} unwrap)
hub/ui/src/components/   COPIED from client/src/components: Common.jsx, DataTable.jsx, Form.jsx, Modal.jsx, Toast.jsx, ProgressLog.jsx, ConfigPage.jsx, ActionPage.jsx + client/src/styles base CSS
hub/ui/src/components/SYNC.md          source commit hash + list of files copied; "re-copy by hand, never import across packages"
hub/ui/src/auth/        login (password + TOTP), session context, role guard
hub/ui/src/pages/admin/ {Dashboard,Licenses,LicenseDetail,Customers,Resellers,Products,Trials,Integrations,Reports,Audit,
                         VerificationQueue,Developers,ReviewQueue,ReviewDetail,Catalog,Revocations,Entitlements,Payouts,ReviewModeration,SigningKeys}.jsx
hub/ui/src/pages/reseller/ {Dashboard,Licenses,Customers,Activations,ApiKeys,Statement}.jsx
hub/ui/src/pages/dev/   {Register,VerifyEmail,Profile,Verification,Keys,Plugins,PluginEdit,Versions,VersionDetail,Upload,Stats,Payouts,ApiKeys}.jsx
hub/ui/test/            vitest + @testing-library: render each page against a mocked api client; the two queues' approve/reject flows
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
server/src/services/license-keys.json         { "keys": [ { "kid", "pub", "not_after" } ] } — vendor keys (≥ 2); tests point config.licenseKeysFile at server/test/fixtures/license-keys.test.json
server/src/services/license.js                createLicenseService(ctx) → ctx.license (below); boot verify, check-in job 'license.checkin', state machine, events, key pinning
server/src/middleware/license.js              licenseGate(ctx) (degraded → 423 on mutations except the §16.8 allow-list), requireFeature(flag), featureGates map { '/transfers': 'transfers', '/clusters': 'clusters', '/server-config/terminal': 'terminal', '/development/api-tokens': 'api', '/themes/branding': 'white_label' }
server/src/routes/license.js                  GET /api/license · POST /key · /checkin · /deactivate · /trial · GET /activations (root; reachable in degraded mode)
server/src/db/migrations/031_license.sql      license_state, license_events (§16.8)
agent/src/ops/fingerprint.js                  defineOp('sys.fingerprint') read-only: hashes of machine-id, default-route MAC, root fs UUID (§16.5), never raw values
server/test/license.test.js  agent/test/fingerprint.test.js  server/test/fixtures/{canonical-vectors.json,license-keys.test.json}
client/src/pages/server-configuration/LicenseTab.jsx   key entry/replace, Check in now, edition/limits/features, activations (Deactivate / Transfer), Start trial, portal link
client/test/license.test.jsx
```
**Edit**: `server/src/index.js` (`ctx.license = createLicenseService(ctx)` before `createApp`; `license.boot()` after migrate), `server/src/app.js` (`licenseGate` right after `requireAuth`), `server/src/routes/index.js` (mount `/license` before the gate's effect), `server/src/services/accounts.js` (`ctx.license?.assertCapacity('accounts')` in `create()`), `server/src/services/resellers.js` (one line `ctx.license?.assertCapacity('resellers')` — the only category-file edit, coordinate with that category's owner), `server/src/services/system.js` (`status().license` from `ctx.license.summary()` — `Home.jsx` already renders `status.license.status`), `client/src/pages/fn/server-configuration/basic-webhost-manager-setup.jsx` (add the License tab), `client/src/components/Layout.jsx` (grace/degraded banner from `/api/auth/me.license`), `server/src/routes/auth.js` (`me` carries `license: { status, edition, daysLeft }`), `.env.example` (`WHM_LICENSE_HUB_URL`, `WHM_LICENSE_KEYS_FILE`).

**Exposes (`ctx.license`)**
```js
get()            → { status: 'unlicensed'|'active'|'grace'|'degraded'|'expired'|'suspended'|'revoked', edition, rank, limits, features, activationId, lexp, exp, lastCheckinAt, nextCheckinAt, failCount, messages }   // sync, cached
summary()        → the Statistics row shape { status, edition, daysLeft, activations: '1/1', lastCheckinAt }
assertCapacity('accounts'|'resellers')   → throws HttpError 409 license_limit { limit, used }
hasFeature(flag) → boolean;   requireFeature(flag) → express middleware (403 feature_required)
isDegraded()     → boolean
activate(key, user, req) · checkin({ force }) · deactivate(reason) · startTrial(email) · activations()
pluginSigningKids() → ['7b2d4e10', …]   // kids pinned from the last signed activation/check-in; files in <dataDir>/plugin-keys/<kid>.pub, source=hub
on('status_changed'|'keys_changed', fn)
transport        → { request(url, { body, headers }) }  // replaced by tests with a mock hub
```
Key pinning lives here (U5 only reads `pluginSigningKids()`): every `plugin_signing_keys` entry
in a verified response is written to `plugin-keys/<kid>.pub`; retired ones are removed only if
`license_state.payload_json.pinnedKids` lists them (operator keys untouched).

**Consumes**: §16.6 wire contract (mocked), U1 golden vectors (copied), `ctx.contacts.notify` (tolerate absence), `ctx.agent.op('sys.fingerprint')`.

**Tests**: §16.12 "Panel `license.js`" paragraph: boot verify with pinned keys; cache; network failure stays `active` until `exp`; fake-clock timeline `active → grace → degraded`; degraded RBAC matrix (mutations 423, GETs + rescue routes allowed, **no agent op dispatched** on any license transition — assert `agent.calls` is empty); `assertCapacity`/`requireFeature` messages; events → `audit_log` + Contact Manager; `/api/license` payload shape; key pinning writes/removes files; tampered response signature rejected; agent op schema rejects anything but `{}` and never returns raw identifiers.

**Commands**: `cd server && npx vitest run` · `cd agent && npx vitest run` · `cd client && npx vitest run && npm run build` · `BASE=… PASSWORD=… node e2e/ui-check.cjs`.

---

## U5 — panel marketplace client (§18.6)

**Create**
```
server/src/services/marketplace-client.js     createMarketplaceClient(ctx) → ctx.marketplace (below); jobs 'marketplace.install', 'marketplace.update', 'marketplace.revocations', 'marketplace.update-check'
server/src/routes/marketplace.js              GET /api/marketplace/status · /catalog · /categories · /plugins/:id · /plugins/:id/versions · /updates · /revocations ·
                                              POST /install { pluginId, version?, channel?, consent? } → 202 · POST /update/:id → 202 · DELETE /:id?purge · POST /revocations/:id/ack · POST /plugins/:id/reviews
server/src/db/migrations/032_marketplace.sql  marketplace_installs, marketplace_revocations, marketplace_state (§18.6)
client/src/pages/cpanel/MarketplaceTab.jsx    catalog grid, search/category, detail drawer (permissions via describePermission + justifications, versions, reviews), Install/Update/Uninstall, ConsentModal
client/src/pages/cpanel/ConsentModal.jsx      scopes + SDK descriptions + justifications + TrustNotice; posts consent
client/src/components/RevocationBanner.jsx    red banner until acknowledged
client/test/marketplace.test.jsx  server/test/marketplace-client.test.js
```
**Edit**: `server/src/routes/index.js` (mount `/marketplace` after `/plugins`), `server/src/index.js` (`ctx.marketplace = createMarketplaceClient(ctx)`), `server/src/services/plugins.js` (**additive only**: `install(input, { user, req, policy })` with `policy = { requireSigned: true, signers: [kid] }` → 422 `unsigned_package` / `untrusted_signer` regardless of `plugins.require_signature`; `source: 'marketplace'` passed through; one new test block in `server/test/plugin-host.test.js`), `client/src/pages/fn/cpanel/manage-plugins.jsx` (Marketplace tab + "Sideloaded" label + developer-mode switch `plugins.developer_mode` + "Issue restore token" button on the detail view), `client/src/pages/fn/server-configuration/whm-marketplace.jsx` (hub catalog when `GET /api/marketplace/status.enabled`, static catalog under "Distribution packages"), `client/src/components/Layout.jsx` (mount `RevocationBanner`), `server/src/services/server-contacts.js` event catalog (`plugin.revoked`, `plugin.update_available` — coordinate with that category's owner; it is the only category-file edit).

**Exposes (`ctx.marketplace`)**
```js
status()                → { enabled, url, licenseStatus, hubKids, lastRevocationTs, pendingUpdates }
catalog(query), plugin(id), versions(id), updates()
install({ pluginId, version, channel, consent }, user, req) → { job }   // consent.permissions must equal the version's list, else job ends 'pending_consent' with { required: [...] }
update(id, user, req) → { job };  uninstall(id, { purge }, user, req)
pollRevocations()       → { applied: [...] }   // also called by license.js on message plugin_revocations_pending
transport               → { request(url, opts) }  // mocked in tests, like market.js
```
**Consumes**: U2 public routes (mocked with recorded JSON fixtures in `server/test/fixtures/hub/`), U4 `ctx.license.get()/pluginSigningKids()/requireFeature('marketplace_paid')/isDegraded()/on('…')`, `ctx.market.hub()` (exists), `ctx.plugins.install/enable/disable/uninstall/get` (exist), U6 signed fixture package for the end-to-end install test.

**Tests**: §18.10 "Panel client" bullet, plus: static catalog served when the hub row is disabled; `transport` never called with `http://`; cache file removed after install; `plugins.developer_mode` gate for unsigned uploads; consent recorded with `consented_by`; update that adds scopes ends `pending_consent`; revocation ack clears the banner; reseller sees WHM Marketplace read-only.

**Commands**: `cd server && npx vitest run` · `cd client && npx vitest run && npm run build` · `e2e/ui-check.cjs` · screenshots refresh (`e2e/screenshots.sh`) for Manage Plugins → Marketplace and WHM Marketplace.

---

## U6 — `plugins/SDK.md`, `plugins/sdk/pack.js`, sample plugin, automated-backup plugin, `scripts/build-plugin.js`

**Create**
```
plugins/SDK.md                        the developer reference, written against the committed SDK and the real host (plugin-host.md): manifest (every key, vocabularies from validate-manifest.js), permissions table (PERMISSIONS text verbatim), events catalog, every ctx.* method with signature/gate/errors (mirror mock-host.js 1:1, note the host differences plugin-host.md lists), lifecycle (install → installed → enable → migrate(from) → activate → disable → uninstall; ACTIVATE_TIMEOUT_MS, HOOK_TIMEOUT_MS), pages/kinds, jobs/cron, i18n, limits (MAX_* constants), trust model, packaging .whmplugin (tar rules, 20/50 MiB), DEV-SIGNATURE.json & SIGNATURE.json (§18.3 rule, kid rule), testing with createMockHost, submission to the marketplace (§18.2–18.3), changelog/versioning rules
plugins/sdk/pack.js                   CommonJS, zero deps: packDirectory(dir, { exclude }) → gzip tar Buffer (ustar, sorted entries, mtime 0, mode 0644/0755, no links), unpack(buf, dest, { maxBytes, maxEntries }) (same refusals as server/src/lib/tar.js), packageDigest(dir, { exclude = ['SIGNATURE.json'] }) → Buffer, sign(digest, privateKeyPem) → base64, verify(digest, sigB64, publicKeyPem), kidOf(publicKeyPem), writeSignature(dir, fileName, { kid, sig })
plugins/sdk/test/pack.test.js         round-trip, determinism (two packs byte-identical), refusals, parity: packageDigest(dir) equals server/src/services/plugins.js packageDigest(dir) (dynamic import) and extractTar(server) accepts pack.js output
scripts/build-plugin.js               node scripts/build-plugin.js <dir> [--out file.whmplugin] [--sign <private.pem> [--dev]] [--kid <kid>]: validateManifest → pack → optional DEV-SIGNATURE.json (--dev, excludes both signature files) or SIGNATURE.json (local trusted-key signing for operators) → prints sha256 + kid; refuses an invalid manifest
plugins/sample-plugin/                id net.whm.sample-notes — one of every extension point: settings (every field type), hooks (pre cancellable + post), jobs (cancellable + locked), cron (setting-bound + fixed), pages (settings, table, form, action, markdown, html), routes with roles, store kv + collection, fs, crypto, net.fetch with a scope, events.emit, i18n (en + de), migrate(from); plugin.json, main.js, locales/, README.md, package.json (test: node --test), test/*.test.js against createMockHost (every extension point asserted)
plugins/automated-backup/             id net.whm.automated-backup: settings (scope all|packages|accounts list, include components, schedule cron, retention daily/weekly/monthly counts, destinations multiselect fed by ctx.api.backups.destinations.list, verify toggle, encrypt toggle*, notifications on failure/success, max parallel, lock TTL); jobs run (per-account lock in ctx.store kv `lock:<account>` with TTL, create → verify → upload per destination → record), prune (retention by day/week/month buckets, delete artefacts + remote copies), restore (requires { artefactId, account, confirmToken } from POST /api/plugins/manage/net.whm.automated-backup/restore-token); cron `schedule` → run; hooks backup.completed/backup.failed (records host-initiated backups too), account.terminated (drops locks/history); run history collection `runs` + page table; pages: settings, history (table), run-now (action), restore (form); routes GET /runs, GET /locks, POST /locks/:account/release (root); notifications via ctx.api.contacts.notify; README.md; test/*.test.js (schedule advance runs the job, locks block overlap and expire, retention keeps the right buckets, restore refuses a bad/used token, destinations upload recorded, failure notifies, host-initiated backups appear in history, encrypt:true surfaces UNSUPPORTED as a run warning)
```
\* the host only produces gzip, unencrypted archives (`COMPRESSIONS = ['gzip']`, `encrypt:true` → `UNSUPPORTED` 422); the plugin cannot read archive bytes (`ctx.fs` is its data dir), so the toggle requests encryption from the host and records the refusal as a warning — documented in README and SDK.md.

**Exposes**: `plugins/sdk/pack.js` (U2 and U5 consume), signed fixtures `plugins/sample-plugin/test/fixtures/{dev.pem,dev.pub,sample-notes-signed.whmplugin}` regenerated by `test/build-fixture.js` (U2 upload tests, U5 install tests), `scripts/build-plugin.js` (hub docs and README point at it).

**Consumes**: the committed SDK only; `server/src/services/plugins.js` and `server/src/lib/tar.js` in the parity test (test-time import, no runtime dependency).

**Commands**: `npm test --prefix plugins/sdk` · `node --test plugins/sample-plugin/test` · `node --test plugins/automated-backup/test` · `node scripts/build-plugin.js plugins/sample-plugin --out /tmp/x.whmplugin` then `cd server && npx vitest run plugin-host` (install the produced file via `{ path }` in a one-off test).

---

## Cross-unit contracts in one place

| Contract | Owner | Consumers | Fixed by |
|---|---|---|---|
| `.whmplugin` format, `packageDigest`, `SIGNATURE.json { kid, alg, sig }`, `plugin-keys/<kid>.pub`, `KID_RE` | existing host (`services/plugins.js`) | U2, U5, U6 | plugin-host.md — **no change** |
| `DEV-SIGNATURE.json` = same digest with both signature files excluded | §18.3 | U2, U6 | marketplace.md |
| `kid` = first 8 hex of `sha256(raw 32-byte public key)` for license, plugin and developer keys | §16.4 | U1, U2, U4, U6 | license-server.md |
| JCS canonical form + golden vectors | U1 `hub/shared/canonical.js` | U4 copy | `hub/test/fixtures/canonical-vectors.json` |
| Token payload, activation/check-in request/response, error codes, signed responses | §16.4–16.6 | U1, U4 | license-server.md |
| `plugin_signing_keys` in activation/check-in `data` | U2 via U1 `activationExtras` | U4 pins, U5 reads | marketplace.md §18.6 |
| Catalog/download/revocation response shapes | U2 | U5 | marketplace.md §18.4 |
| `ctx.license` surface | U4 | U5, core | this plan |
| `ctx.marketplace` surface | U5 | client, integrator | this plan |
| `plugins/sdk/pack.js` API | U6 | U2, U5, `scripts/build-plugin.js` | this plan |
| Host `install()` `policy` option (additive) | U5 | U5 only | this plan |

Anything not listed is internal to its unit. A unit that needs more from another unit adds a
row here first (the integrator merges the doc), then builds.

## Integrator checklist (after round 3)

1. **BLUEPRINT.md**: insert `docs/design/license-server.md` as §16 (verbatim), a §17 *Plugin SDK & host*
   (summary + pointers to `plugins/SDK.md` and `docs/design/plugin-host.md`), `docs/design/marketplace.md`
   as §18; extend the TOC, §5 layout (`hub/`, `plugins/`, `scripts/build-plugin.js`), §6 tables
   (`license_state`, `license_events`, `marketplace_*`), §13.27 Market and §13.30 Plugins (marketplace install),
   §14 roadmap row **P7 Commercial** (from §16.12) and §15 test list (hub suite, parity tests).
2. **Root `package.json`**: workspaces `+ hub`, `+ hub/ui`; `test` script adds `npm test --prefix hub`,
   `--prefix hub/ui`, `node --test plugins/sample-plugin/test plugins/automated-backup/test`; `build` adds `hub/ui`.
3. **Deploy**: `deploy/whm-hub.service` (`User=whmhub`, `EnvironmentFile=/etc/whm-hub/hub.env`,
   `ReadWritePaths=/var/lib/whm-hub /var/log/whm-hub`, `ReadOnlyPaths=/etc/whm-hub`), `deploy/hub.conf.example`;
   `scripts/install.sh --with-hub` (creates `whmhub`, `/etc/whm-hub`, `/var/lib/whm-hub`, runs `hub/scripts/gen-key.js`
   for a license key **and** a plugin key, prints the `{ kid, pub }` pairs to paste into `license-keys.json`), and
   `scripts/install.sh` (panel) writes `WHM_LICENSE_HUB_URL` into `/etc/whm/panel.env` when asked.
4. **Bundled plugins**: `plugins/automated-backup` is installed at boot like the three bundled ones only if the
   owner decides so; default is *marketplace-distributed* (seed it and `sample-plugin` into the hub catalog fixtures
   and the vendor developer `net.whm`, verified). Record the decision in `CLAUDE.md`.
5. **Server Contacts** event catalog gains `license.*` (§16.8) and `plugin.revoked`, `plugin.update_available`;
   **Security Advisor** gains the manifest-integrity finding (§16.10) — small edits in those categories.
6. **CHECKLIST.md**: tick the "Deferred work" items, add the hub suite counts and the e2e/screenshot refresh;
   **README.md**: hub section (install, ports 7443/7440, key generation, first license, marketplace developer flow);
   **CLAUDE.md**: current-state entry, decisions table (copy-not-import for hub/ui, marketplace-distributed plugins,
   additive host `policy` option), "Resume notes" (disable the keep-alive Routine when CHECKLIST is done).
7. **Green gate before push**: `npm test` (all workspaces + SDK + plugins), `npm run build`, boot in monolithic
   mode with a temp data dir and the hub on `:7443` with test keys: activate a trial from Basic Setup → License,
   enable the `whm-hub` provider, install `net.whm.sample-notes` from the Marketplace tab through the consent
   screen, revoke it from the admin portal, watch the banner appear; `e2e/ui-check.cjs`; `e2e/screenshots.sh`; commit.
