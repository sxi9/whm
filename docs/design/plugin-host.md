# Plugin host (core) — design of record

The panel's in-process plugin host. It is the **real** implementation of the contract that
`plugins/sdk/mock-host.js` documents: every `ctx.*` method, gate, error class and return shape
of the mock host must exist here with the same semantics (the mock's header comment names
`server/src/services/plugins.js` as the real host — that is this file). Plugins are
CommonJS packages validated by `plugins/sdk/validate-manifest.js`.

## Files

| Piece | Path |
|---|---|
| SDK loader (CJS → ESM) | `server/src/lib/plugin-sdk.js` — `loadPluginSdk()` → `{ validate, errors, semver, cron, path, version, loadCommonJs }` (move `loadCommonJs`/`loadPluginSdk` out of `services/development.js`, which then imports them from here and keeps exporting `loadPluginSdk` for compatibility) |
| tar reader | `server/src/lib/tar.js` — pure JS ustar/gnu reader over a gunzipped buffer: `listTar(buf)` → entries `{ name, type, size, mode }`, `extractTar(buf, destDir, { maxBytes = 50 MiB, maxEntries = 2000 })`. Refuses absolute names, `..` segments, NUL, symlinks/hardlinks/devices/fifos (only `0`/`5` and GNU `L` long names), and size overflow. Never spawns a process. |
| host service | `server/src/services/plugins.js` — `createPluginHost(ctx)` attached as `ctx.plugins` |
| core routes | `server/src/routes/plugins.js` — mounted in `routes/index.js` as `api.use('/plugins', pluginRoutes(ctx))` right after `/packages` |
| migration | `server/src/db/migrations/024_plugins.sql` |
| scheduler | `server/src/lib/scheduler.js` gains `remove(name)` (DELETE by name) and `listPrefix(prefix)` |
| bootstrap | `server/src/index.js`: `ctx.plugins = createPluginHost(ctx)` before `createApp`; after `createApp` → `await ctx.plugins.loadAll()` (never throws; a failing plugin becomes `errored`). `start()`/shutdown calls `ctx.plugins.stopAll()` |
| client | `client/src/pages/plugins/PluginPage.jsx` (generic renderer), `client/src/hooks/usePluginNav.js`, one dynamic route `plugins/:pluginId/*` in `router.jsx`, sidebar/tools/search merge in the layout |
| tests | `server/test/plugin-host.test.js`, `server/test/tar.test.js`, `client/test/plugin-page.test.jsx` (render each page kind) |
| docs | this file + `plugins/SDK.md` is written in Phase 5 (do not write it now) |

## Storage (migration 024)

```
plugins            (id TEXT PK, name, version, manifest_json, state TEXT CHECK (installed|enabled|disabled|errored),
                    last_error, source TEXT (upload|path|bundled|marketplace), signer, package_sha256, signed INTEGER,
                    installed_at, updated_at, enabled_at)
plugin_settings    (plugin_id, key, value_json, updated_at, PK (plugin_id, key))        -- password-type values are ctx.crypto.encrypt'ed
plugin_store       (plugin_id, key, value_json, updated_at, PK (plugin_id, key))
plugin_docs        (plugin_id, collection, id, doc_json, created_at, updated_at, PK (plugin_id, collection, id))
plugin_logs        (id INTEGER PK, plugin_id, ts, level, msg, fields_json)             -- ring buffer, keep newest 1000 per plugin
```
Jobs use the core `jobs` table with type `plugin:<id>:<job>`; schedules use the core
`schedules` table with name `plugin:<id>:<cronName>` (manifest cron) or
`plugin:<id>:runtime:<job>` (ctx.schedule.cron) and job type `plugin:<id>:<job>`.

Files: code in `config.pluginsDir` (default `$WHM_DATA_DIR/plugins/<id>/`, this is `ctx.plugin.dir`),
data in `config.pluginDataDir` (default `$WHM_DATA_DIR/plugin-data/<id>/`, this is `ctx.plugin.dataDir`).
Add both to `config.js` with env `WHM_PLUGINS_DIR` / `WHM_PLUGIN_DATA_DIR`.

## Package format `.whmplugin`

gzip'ed tar with `plugin.json` and `main.js` (and other files, `locales/*.json`) at the root
(a single top-level directory wrapper is also accepted and stripped). Optional `SIGNATURE.json`
`{ "kid": "<key id>", "alg": "ed25519", "sig": "<base64>" }` where `sig` is an Ed25519 signature
over the SHA-256 digest of the canonical file list (`sha256( join('\n', sorted(`${name} ${sha256hex(content)}`)) )`
excluding `SIGNATURE.json`). Trusted public keys: `*.pub` (PEM, SPKI) files in
`$WHM_DATA_DIR/plugin-keys/`, `kid` = file basename. Setting `plugins.require_signature`
(default `false`; the Manage Plugins UI shows a warning while it is off) refuses unsigned or
unverifiable packages with 422 `unsigned_package`. A verified package records `signer = kid`.
Max package 20 MiB compressed, 50 MiB extracted.

Install sources: `POST /api/plugins/manage/install` with raw body (`application/gzip` or
`application/octet-stream`, `express.raw({ limit: '20mb' })`) **or** JSON `{ "path": "/abs/file.whmplugin" }`
(root only, path must pass `ctx.agent`-style allowed-root rules: under `$WHM_DATA_DIR`, `/root`, `/home`, `/tmp`, `/opt`)
**or** `{ "dir": "/abs/dir" }` (an unpacked plugin directory, used by tests and bundled plugins).

## Lifecycle

- `install(input, { user, req })`: unpack to a temp dir under `pluginsDir/.staging/` → read + `validateManifest`
  (errors → 422 `invalid_manifest` with the SDK's error list as `fields`) → `semver.satisfies(HOST_API_VERSION, manifest.engines.whm)`
  (422 `incompatible_host`) → signature policy → if the id exists: keep `previousVersion`, replace the directory atomically
  (rename old to `.previous`, new into place; remove `.previous` after success) → upsert row (`state` stays `enabled`
  if it was enabled → re-activate with `migrate(from)`; new installs are `installed`) → audit `plugin.install` → `ctx.events.emit('plugin.installed')`.
- `enable(id)`: load module (below) → `activate` sequence exactly like the mock's `load()`:
  engines check → handler presence checks → `routes(http, ctx)` → manifest pages → manifest cron → `migrate(ctx, from)`
  when upgrading → `activate(ctx)` → state `enabled`; failure ⇒ state `errored` + `last_error`, everything registered is rolled back.
- `disable(id)`: `deactivate(ctx)` → remove routes, event subscriptions, schedules (`plugin:<id>:*`), abort running jobs → `disabled`.
- `uninstall(id, { purge })`: disable → delete plugin dir → `purge` also deletes data dir, settings, store, docs, logs → event.
- `loadAll()` at boot: enable every row with state `enabled`; failures become `errored` and never stop the boot.
- `HOST_API_VERSION = '1.0.0'` (the plugin API version, independent of the panel's package version; `ctx.plugin.hostVersion`).

Module loading: `main.js` is CommonJS. Evaluate with `vm.compileFunction` wrapper (same technique as
`loadCommonJs`) with a `require` that resolves: relative paths inside the plugin dir only (realpath must stay inside;
no symlink escape), `whm/plugins/sdk` → the loaded SDK exports, and Node built-ins from an allowlist
(`crypto, path, url, util, buffer, events, stream, string_decoder, querystring, zlib, assert, timers`, with or without
`node:`). Everything else throws `PermissionError('require:<spec>')`. `isolation: 'process'` is accepted but runs
in-process for now (log a warning once; process isolation arrives with the marketplace).

## ctx (mirror the mock host 1:1)

`ctx.plugin { id, version, dir, dataDir, hostVersion, isolation }`, `ctx.log` (also writes `plugin_logs` and the panel
logger child `{ plugin: id }`, fields redacted with the mock's SECRET_KEY_RE), `ctx.settings` (DB-backed; same
`validateSettingValue`; `onChange`; setting-bound cron rebinding), `ctx.store` (kv + collections with the mock's query
operators, `MAX_STORE_VALUE_BYTES`, ids `doc_0001`-style per plugin via a counter stored in `plugin_store` under
`__seq`), `ctx.api.*` (below), `ctx.agent.op` (gate `agent:op:<name>` then `ctx.agent.op(name, args, { req })`),
`ctx.jobs`, `ctx.schedule`, `ctx.events`, `ctx.http` (`baseUrl = /api/plugins/<id>`), `ctx.ui.registerPage`,
`ctx.crypto` (HKDF-SHA256 from `config.masterKeyHex` with info `whm-plugin-crypto`, salt = plugin id, `whm1:` format),
`ctx.fs` (real files under dataDir; `safeRel`; lstat → refuse symlinks; quota `MAX_FS_BYTES`), `ctx.net.fetch`
(https only, `matchesNetScope`, 30 s timeout, `redirect: 'manual'` re-checked per hop, max 3 hops),
`ctx.i18n` (loads `<dir>/<manifest.i18n.dir>/<locale>.json`), `ctx.errors`, `ctx.now()` (= Date.now()).
Gate semantics identical to the mock (`PermissionError` with the same arguments) and the host records
`permissionsUsed`/`permissionDenials` per plugin for the Manage Plugins detail view.

`ctx.api` maps onto panel services with a synthetic principal `{ id: null, username: 'plugin:<id>', role: 'root' }`
and `req = { user, ip: null, audit: (e) => ctx.audit? ... }` (write audit rows with `principal = plugin:<id>`, `role = plugin`):
accounts.list/get/suspend/unsuspend → `ctx.accounts.list(query, user)` / `get` / `suspend(username, reason, user, req)` /
`unsuspend` (rows reshaped to the mock's account shape); packages.list → `ctx.packages.list({ pageSize: 500 }, user).data`;
dns.zones.list/get → `ctx.dns.listZones` / `getZone`; backups.* → `ctx.backup` (find the real method names in
`server/src/services/backup.js`; where a mock method has no counterpart, implement it faithfully on top of the backup
tables/ops — restore requires a confirm token issued by `POST /api/plugins/manage/:id/restore-token`);
services.status → `ctx.serviceManager.status(name)`; system.info → `ctx.system.info()` reshaped; contacts.notify →
`ctx.contacts.notify(event, { subject, body, severity })` (absent → `ServiceUnavailable`-style PluginError 503);
audit.record → insert into `audit_log`. Missing optional services (`ctx.dns`, `ctx.backup`, `ctx.contacts`) raise
`PluginError('… is not available on this server', { code: 'SERVICE_UNAVAILABLE', status: 503 })`.

Jobs: on enable, register `plugin:<id>:<job>` with `ctx.jobs.register`; the handler builds the mock's `job` object
(`id, name, params (frozen), signal, progress, log, cancelled`) over the core job ctx and calls the plugin's handler
with `(job, pluginCtx)`; `ctx.jobs.run` → `enqueue` (returns the id as a string), `status` → the mock's record shape,
`cancel` → core cancel for queued + AbortController for running (`cancellable: false` ⇒ `ConflictError`).

Events: manifest hooks and `ctx.events.on` subscribe on `ctx.events` (PanelEvents, created by the development
category; subscribe lazily on enable and tolerate absence). Envelope → the mock's `evt` (`name, stage, payload (frozen),
ts, principal, cancellable, cancel()`); a `pre` cancel throws `HttpError(409, 'hook_rejected', '<plugin name>: <reason>')`
so the panel's existing hook contract applies; errors in `post` handlers are logged (plugin log) and never propagate.
`ctx.events.emit` (namespace-checked) → `ctx.events.emit(event, payload, { stage: 'post' })`.

HTTP: per-plugin Express router created on enable; the core router dispatches `/api/plugins/:id/*` to it
(after `requireAuth`); role check per route (`roles`, default `['root']`); `req`/`res` facades exactly as the mock's
`callRoute`; `PluginError` → `{ error: err.toJSON() }` with `err.status`, anything else → 500 `{ error: { code: 'INTERNAL' } }`
and a plugin log line. Plugin ids have ≥ 3 dot-separated segments, so the reserved first segments `manage` and `ui`
never collide.

## Core manage API (`routes/plugins.js`, root only unless noted)

```
GET    /api/plugins/manage                       list [{ id, name, version, state, lastError, permissions, sidebar, signed, signer, source, installedAt }]
POST   /api/plugins/manage/install               raw .whmplugin body | { path } | { dir }  → 201 { plugin, warnings: ['unsigned'] }
GET    /api/plugins/manage/:id                   detail: manifest, settings (schema + values, password fields masked as '••••••'),
                                                 schedules, recent jobs, permissionsUsed/denials, logs (last 100)
POST   /api/plugins/manage/:id/enable | /disable
DELETE /api/plugins/manage/:id?purge=true
GET    /api/plugins/manage/:id/settings          values (passwords masked)
PUT    /api/plugins/manage/:id/settings          { key: value, ... } validated per field; a masked password value leaves the stored one untouched
GET    /api/plugins/manage/:id/logs?limit=
POST   /api/plugins/manage/:id/jobs/:name        { params } → 202 { job } (root; resellers only when the page descriptor allows: pages carry `roles`? no — keep root)
POST   /api/plugins/manage/:id/restore-token     { artefactId, account } → { token, expiresAt }
GET    /api/plugins/ui                           (root + reseller) [{ id, name, sidebar: [...], pages: [...] }] for enabled plugins
ALL    /api/plugins/:id/*                        plugin routes
```
Use `validate()` with zod for every param/body; `fields.*` from `lib/validate.js` where they fit; plugin id param
regex = SDK `ID_PATTERN`.

## Client

`usePluginNav()` fetches `/plugins/ui` once (cached in a context) and returns extra sidebar entries
`{ category, label, path: '/plugins/<id>' + route, icon }`; the layout merges them into the matching category
(by label; unknown category → 'Plugins') for the sidebar, the Tools grid and search. `PluginPage` renders by
`kind`: `settings` (fields from the manifest → Form components, PUT settings), `table` (GET `${baseUrl}${source}`,
DataTable with `columns`), `form` (fields → POST `${baseUrl}${action}`), `action` (confirm → POST manage job →
`ProgressLog` over the existing job SSE stream), `markdown` (render with the existing markdown helper if any, else a
minimal safe renderer: no raw HTML), `html` (sandboxed `<iframe sandbox="" srcdoc=…>`). Unknown route → NotFound.
Use the shared components (`PageHeader`, `Card`, `DataTable`, `Form`, `ActionPage`/`ProgressLog`, `Toast`). Never
`import * as icons`.

## Tests (must pass before the build is reported)

`server/test/plugin-host.test.js` (vitest + supertest via `test/support/app.js`): build a plugin from the SDK fixtures
(`fullManifest()`; write a `main.js` equivalent of `fullModule()` into a temp dir) and cover: install from `{ dir }`
(201, `warnings: ['unsigned']`), install from a generated tar (write a tiny tar writer in the test or in
`test/support/tar.js`), invalid manifest → 422 with fields, incompatible engines → 422, tar with `../` / absolute /
symlink / device entries → 422, enable → routes reachable under `/api/plugins/net.example.hello/items` with role
enforcement (reseller allowed on POST, user 403), 404 for unknown routes, settings GET/PUT (validation error 422,
password masked, `setting:schedule` rebinding creates/updates the `schedules` row), store kv + collection queries,
job run via manage → `waitForJob` → result + progress, cron rows exist and are removed on disable, hooks: POST
/accounts with username `blocked` → 409 `hook_rejected`, normal create delivers the post hook, `ctx.events.emit`
namespace check, permission gate (manifest without `accounts:read` → PermissionError surfaced as 403 from a route),
fs sandbox (`../x` → PathError), crypto round-trip, `net.fetch` scope denial (no network: stub `globalThis.fetch`),
disable → routes 404 + schedules gone + jobs aborted, uninstall purge → files + rows gone, `loadAll()` with a
plugin whose activate throws → state `errored`, panel still serves `/api/health`, signature: generate an Ed25519
key pair in the test, drop the public key into `plugin-keys/`, signed package verifies (`signer`), tampered
package → 422, `plugins.require_signature = true` refuses unsigned.
`server/test/tar.test.js`: reader edge cases. Keep the existing suites green: `cd server && npx vitest run`.
