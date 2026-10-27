# WHM Plugin SDK — developer reference

This is the reference for writing, testing, packaging, signing and submitting a plugin for the
WHM panel. It is written against the committed SDK in `plugins/sdk/` (`validate-manifest.js`,
`mock-host.js`, `errors.js`, `semver.js`, `cron.js`, `pack.js`, `index.js`, `manifest.schema.json`)
and the real in-process host, `server/src/services/plugins.js` (design: `docs/design/plugin-host.md`).
The constants quoted here are the SDK's; when this document and the code disagree, the code wins
and this document has a bug.

Two complete plugins ship with the panel as worked examples:

- `plugins/sample-plugin/` (`net.whm.sample-notes`) — one of every extension point, distributed
  through the marketplace;
- `plugins/bundled/net.whm.automated-backup/` — a bundled plugin built on the backup API.

```
SDK_VERSION        1.0.0          plugins/sdk/index.js
HOST_API_VERSION   1.0.0          server/src/services/plugins.js (what engines.whm is matched against)
```

## 1. Anatomy of a plugin

A plugin is a directory (packaged as a `.whmplugin`, §12) with at least:

```
plugin.json          manifest (§2) — validated with validateManifest()
main.js              CommonJS entry module (manifest.main)
locales/<loc>.json   optional translations (§9)
pages/*.md|*.html    optional markdown/html page files (§7)
README.md, LICENSE   recommended; the marketplace shows README.md
```

`main.js` exports plain functions; the host calls them with a frozen context object `ctx` (§5):

```js
'use strict';
module.exports = {
  async activate(ctx) {},              // after routes/pages/cron are registered; may throw → state "errored"
  async deactivate(ctx) {},            // on disable/uninstall/shutdown
  async migrate(ctx, fromVersion) {},  // on upgrade, before activate(); fromVersion is the previous semver
  routes(router, ctx) {},              // register HTTP routes (needs api:routes)
  hooks: { handlerName(evt, ctx) {} }, // handlers named by manifest.hooks[].handler
  jobs: { jobName(job, ctx) {} },      // handlers named by manifest.jobs keys
};
```

Every handler the manifest names must be exported, or activation fails (`ValidationError`,
state `errored`, `last_error` on the Manage Plugins page). The sample plugin uses no `require()`
at all; what a plugin may require is listed in §11.

Inside the host, `require('whm/plugins/sdk')` returns the SDK (frozen): the error classes,
`validateManifest` and the constants, `semver`, `cron`, `createMockHost`. Error classes are also
on `ctx.errors`, which is the simplest way to throw a typed error from a route or a job. The
packer (`pack`, §12) is a **build-time** module: it reads and writes the filesystem, so it is
not part of what a plugin receives in-process (`require('whm/plugins/sdk').pack` is
`undefined`); tooling reaches it as `require('plugins/sdk').pack` or `require('plugins/sdk/pack')`.

## 2. The manifest (`plugin.json`)

`validateManifest(manifest) → { ok, errors: [{ path, code, message }] }` is the single source of
truth; `manifest.schema.json` mirrors it for editors. Unknown keys anywhere are errors
(`UNKNOWN_KEY`). Top-level keys:

| Key | Required | Rule |
|---|---|---|
| `$schema` | no | ignored |
| `id` | yes | reverse-DNS, ≥ 3 segments, `ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/`, ≤ 128 chars. Must start with a namespace the developer owns on the marketplace (§15); `net.whm.*`, `net.example.*` and every bundled id prefix are reserved |
| `name` | yes | non-empty, ≤ 80 chars |
| `version` | yes | strict semver (`1.2.3`, `1.2.3-rc.1+build`; no `v` prefix, no leading zeros) |
| `description` | yes | non-empty, ≤ 500 chars |
| `author` | yes | `{ name, email?, url? }`; `email` must look like an address, `url` an http(s) URL |
| `license` | yes | SPDX id or `"proprietary"` |
| `homepage` | no | http(s) URL |
| `engines` | yes | `{ whm: "<semver range>", node?: "<range>" }`; the host checks `semver.satisfies(HOST_API_VERSION, engines.whm)` at install and activation (`422 incompatible_host` / `IncompatibleError`) |
| `main` | yes | relative path to a `.js`/`.cjs` file inside the plugin (`RELATIVE_PATH_PATTERN`, no `..`, not absolute) |
| `permissions` | yes | array (may be empty) of scopes (§3); no duplicates; every scope the plugin needs must be listed |
| `hooks` | no | `[{ event, stage?: "pre"|"post" (default post), handler }]` — events from §4 or plugin events (`post` only); `handler` ∈ `module.exports.hooks`; a duplicate `stage:event:handler` is an error |
| `settings` | no | `{ groups?: [{ id, label }], fields: [field…] }` (§2.1); declaring any field requires `settings:own` |
| `jobs` | no | `{ <name>: { label, description?, timeoutSec? (1..86400), cancellable? } }`, names `JOB_NAME_PATTERN = /^[a-z][a-zA-Z0-9_-]*$/`; requires `jobs` |
| `cron` | no | `[{ name, job, schedule, params?, enabled? }]` — `schedule` is a cron expression or `"setting:<key>"` where the setting has type `cron`; requires `schedule` |
| `ui` | no | `{ sidebar?: [{ category, label, route, icon }], pages?: [page…] }` (§7); requires `ui:sidebar` |
| `isolation` | no | `"in-process"` (default) or `"process"` (accepted, currently runs in-process) |
| `i18n` | no | `{ default: "en", dir?: "locales" }` (§9) |
| `keywords` | no | ≤ 10 strings of ≤ 32 chars |

Supported range grammar for `engines.whm` (from `semver.js`): exact, `^`, `~`, `>= <`, `x`
ranges, hyphen ranges, `||`, `*`. Pre-releases only satisfy ranges that mention a pre-release.

### 2.1 Settings fields

```
SETTING_TYPES = text | number | select | multiselect | toggle | password | cron | textarea
```

| Field key | Applies to | Rule |
|---|---|---|
| `key` | all | `SETTING_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]*$/`, unique |
| `type`, `label` | all | required |
| `help`, `placeholder`, `group` | all | strings; `group` must be a declared `settings.groups[].id` |
| `default` | all but `password` | must validate against the field itself (`INVALID_DEFAULT`); a `password` default is refused (`SECRET_DEFAULT`: secrets never live in the manifest) |
| `required`, `secret` | all | booleans |
| `min`, `max`, `integer` | `number` | `min <= max` |
| `minLength`, `maxLength`, `pattern` | `text`, `textarea`, `password` | `pattern` is a JavaScript regular expression source tested against the whole value |
| `options` | `select`, `multiselect` | required non-empty `[{ value: string, label }]`, unique values; refused on other types |

Runtime values go through `validateSettingValue(field, value)`: empty values (`undefined`,
`null`, `''`, `[]`) are accepted unless `required`; `number` must be finite (and an integer when
`integer`); `toggle` must be a boolean; `select` one of the option values; `multiselect` an array of
distinct option values; `cron` a valid expression (`cron.validate`). There is no dynamic option
source: `multiselect`/`select` options are static, which is why the bundled Automated Backup
takes destination ids in a `textarea` and validates them at run time.

A `settings` page (§7) renders the fields grouped; password values are stored encrypted by the
host and returned masked (`'••••••'`); a masked value sent back leaves the stored one untouched.

## 3. Permissions

Each scope gates a set of `ctx` methods (§5). Calling a gated method without the scope throws
`PermissionError` (`PERMISSION_DENIED`, 403) and is recorded as a *permission denial* on the
Manage Plugins detail page; the consent screen shows the text below for each scope.

| Scope | Shown to the operator (`PERMISSIONS`, verbatim) |
|---|---|
| `accounts:read` | Read hosting accounts (ctx.api.accounts.list / get) |
| `accounts:write` | Suspend / unsuspend accounts and cancel pre-stage account hooks |
| `packages:read` | Read hosting packages (ctx.api.packages.list) |
| `dns:read` | Read DNS zones and records (ctx.api.dns.zones.*) |
| `backups:read` | List and verify backup artefacts and destinations |
| `backups:write` | Create, upload and delete backup artefacts |
| `backups:restore` | Restore a backup artefact over an account (admin confirm token required) |
| `settings:own` | Read and write the plugin's own settings (ctx.settings) |
| `store:own` | Read and write the plugin's own key/value store and collections (ctx.store) |
| `schedule` | Register cron schedules for the plugin's jobs (ctx.schedule) |
| `jobs` | Run background jobs and query their status (ctx.jobs) |
| `events:emit` | Emit events in the plugin's own namespace (ctx.events.emit) |
| `ui:sidebar` | Add entries to the WHM sidebar and register UI pages (ctx.ui) |
| `api:routes` | Expose HTTP routes under /api/plugins/<id>/ (ctx.http) |
| `contacts:notify` | Send notifications through the Contact Manager (ctx.api.contacts.notify) |
| `system:read` | Read host/system information and service status (ctx.api.system / services) |
| `audit:write` | Write entries to the panel audit log (ctx.api.audit.record) |
| `crypto:own` | Encrypt / decrypt with a plugin-scoped key, hashes and random tokens (ctx.crypto) |
| `fs:own` | Read and write files inside the plugin data directory (ctx.fs) |

Parameterised scopes (`PERMISSION_PATTERNS`):

- `agent:op:<family.op>` — one privileged agent op, families `user web dns mail db ftp svc net ssl sec sys fs`
  (`AGENT_OP_SCOPE_PATTERN`). Every call writes an `audit_log` row.
- `net:outbound:<host>[:port]` — `https://` fetches to that host (`NET_OUTBOUND_SCOPE_PATTERN`):
  `*.example.com` matches sub-domains but not `example.com`; a scope with a port matches only that
  port, a scope without one matches any port; an empty URL port counts as `443`
  (`matchesNetScope(hostname, port, scopes)`).

On the marketplace, every scope needs a justification (≥ 20 characters) and `accounts:write`,
`backups:restore`, any `agent:op:*` and any `net:outbound:*` mark a version *high-risk* (§15).
The mock host's `unusedPermissions()` lists declared scopes nothing exercised: keep it at `[]`.

## 4. Events

Hooks are declared in the manifest (`hooks[]`) or subscribed at runtime (`ctx.events.on`). A `pre`
handler of a *cancellable* event may call `evt.cancel(reason)`, which needs the event's `cancelScope`
and aborts the panel operation with `409 hook_rejected` ("<plugin name>: <reason>"). Payloads never
contain secrets.

| Event | Stages | Cancellable (scope) | Payload |
|---|---|---|---|
| `account.created` | pre, post | yes (`accounts:write`) | `{ username, domain, owner, package, ip, contactEmail }` |
| `account.modified` | pre, post | yes (`accounts:write`) | `{ username, changes: { field: { from, to } } }` |
| `account.suspended` | pre, post | yes (`accounts:write`) | `{ username, reason }` |
| `account.unsuspended` | pre, post | yes (`accounts:write`) | `{ username }` |
| `account.terminated` | pre, post | yes (`accounts:write`) | `{ username, domain, keepDns }` |
| `package.changed` | post | no | `{ name, change: "created"\|"modified"\|"deleted" }` |
| `backup.started` | post | no | `{ jobId, account, include, destinationId? }` |
| `backup.completed` | post | no | `{ jobId, account, artefact: { id, path, size, sha256, createdAt } }` |
| `backup.failed` | post | no | `{ jobId, account, error: { code, message } }` |
| `backup.restored` | pre, post | yes (`backups:restore`) | `{ artefactId, account, principal }` |
| `dns.zone.changed` | pre, post | no | `{ domain, serial, change: "created"\|"records"\|"deleted" }` |
| `ssl.issued` | post | no | `{ domain, issuer, notAfter, autossl }` |
| `ssl.expiring` | post | no | `{ domain, notAfter, daysLeft }` |
| `login.failed` | post | no | `{ username, ip, reason }` |
| `login.succeeded` | post | no | `{ username, role, ip }` |
| `service.restarted` | pre, post | no | `{ service, unit, principal }` |
| `service.failed` | post | no | `{ service, unit, exitCode }` |
| `plugin.installed` | post | no | `{ pluginId, version }` |
| `plugin.enabled` | post | no | `{ pluginId, version }` |
| `plugin.disabled` | post | no | `{ pluginId, version }` |
| `plugin.uninstalled` | post | no | `{ pluginId, version, purged }` |
| `panel.started` | post | no | `{ hostVersion, bootedAt }` |

Plugin-emitted events are `"<plugin id>.<event>"` (`PLUGIN_EVENT_PATTERN`, ≥ 4 dot-separated
segments, e.g. `net.whm.sample-notes.note_created`), `post` stage only, and a plugin may emit
only in its own namespace (`events:emit`). Other plugins may subscribe to them by name.

The handler receives `evt = { name, stage, payload (deep-frozen), ts, principal, cancellable,
cancel(reason) }` and `ctx`. `cancel()` on a non-cancellable delivery throws
`PluginError HOOK_NOT_CANCELLABLE` (409). Errors thrown by `post` handlers are logged to the plugin
log and never propagate. Every delivery races `HOOK_TIMEOUT_MS = 30 000` ms: a `post` handler that
times out is logged and recorded under *hook timeouts*; a `pre` handler that times out **vetoes
the operation** when the plugin holds the event's cancel scope (otherwise it is only logged).

## 5. The context: `ctx.*`

`ctx` is frozen. Every method below exists on the mock host and on the real host with the same
signature, gate and errors; the *host differences* paragraphs come from `docs/design/plugin-host.md`.
All methods return promises unless noted. `ValidationError` is thrown for bad arguments everywhere.

### 5.1 `ctx.plugin` (no gate)

`{ id, version, dir, dataDir, hostVersion, isolation }`. `dir` is the installed code
(`$WHM_DATA_DIR/plugins/<id>/`), `dataDir` the writable data directory
(`$WHM_DATA_DIR/plugin-data/<id>/`, what `ctx.fs` is rooted at). `ctx.now()` is `Date.now()` on the
host and the deterministic clock on the mock. `ctx.errors` holds the error classes (§10).

### 5.2 `ctx.log` (no gate)

`debug|info|warn|error(msg: string, fields?: object)`. Lines go to the plugin log ring
(`plugin_logs`, newest `LOG_RING_SIZE = 1000` per plugin, shown on Manage Plugins) and the panel
logger. Field keys matching `/pass(word)?|secret|token|key|credential|authorization/i` are redacted
to `'[REDACTED]'` — note that this includes a field literally called `key`; name such fields
`setting`, `name`, etc. The host truncates `msg` to 2 KiB and `fields` to 8 KiB and redacts nested
objects too (the SDK's redaction is shallow).

### 5.3 `ctx.settings` (gate `settings:own`)

| Method | Returns / throws |
|---|---|
| `get(key)` | the value (default when unset); `ValidationError UNKNOWN_SETTING` for an undeclared key |
| `getAll()` | `{ key: value }` of every declared field |
| `set(key, value)` | validates with `validateSettingValue` (`ValidationError` with `fields: [{ path, code: 'INVALID_VALUE' }]`), stores, re-binds `setting:<key>` cron schedules, calls `onChange` listeners; `null`/`undefined` clears the value |
| `onChange(fn)` (sync, no gate) | registers `fn(key, value, previous)`; returns an unsubscribe function; listener errors are logged |

Password values are encrypted at rest by the host. The operator edits settings on a `settings` page
or through `PUT /api/plugins/manage/<id>/settings`.

### 5.4 `ctx.store` (gate `store:own`)

Key/value: `get(key)`, `set(key, value) → value`, `delete(key) → boolean`, `keys(prefix?) → sorted
string[]`. Keys are 1..256 characters; keys starting with `__` are reserved for the host. Values must
be JSON-serialisable and ≤ `MAX_STORE_VALUE_BYTES = 1 MiB`.

Collections: `collection(name)` (name `/^[a-z][a-zA-Z0-9_]*$/`, sync) returns

| Method | Behaviour |
|---|---|
| `insert(doc)` | adds `id` (given, or `doc_0001`-style), `createdAt`, `updatedAt` (ms); `ConflictError` on a duplicate id; returns the stored document |
| `find(query?, { sort?, limit?, offset? })` | documents matching the query; `sort` is `{ field: 1 \| -1 \| 'desc' }` (one field) |
| `findOne(query)` | first match or `null` |
| `update(query, patch)` | shallow-merges `patch` (`id` and `createdAt` are ignored), bumps `updatedAt`; returns the count |
| `remove(query)` | returns the count removed |
| `count(query?)` | count |

Query syntax: `{ field: value }` equality (deep, JSON-compared) or operators
`{ field: { $gt, $gte, $lt, $lte, $ne, $in: [], $nin: [] } }`; unknown operators are a
`ValidationError`. Host caps: `MAX_STORE_ROWS = 50 000` keys and `MAX_DOCS_ROWS = 100 000`
documents per plugin (`PluginError QUOTA_EXCEEDED`, 507).

### 5.5 `ctx.api` — panel services

Calls run with a synthetic principal `plugin:<id>` (role `plugin` in audit rows). When the
corresponding panel module is not loaded (`ctx.dns`, `ctx.backup`, `ctx.contacts`), the host throws
`PluginError SERVICE_UNAVAILABLE` (503) where the mock answers from its fixtures.

| Method | Gate | Returns / errors |
|---|---|---|
| `accounts.list({ owner?, suspended?, page?, pageSize? (≤ 500) })` | `accounts:read` | `{ data: [{ username, domain, owner, suspended, suspendReason, package, ip, contactEmail, createdAt }], meta: { page, pageSize, total } }` |
| `accounts.get(username)` | `accounts:read` | the account; `NotFoundError('account')` |
| `accounts.suspend(username, { reason? })` | `accounts:write` | the account; `ConflictError` when already suspended |
| `accounts.unsuspend(username)` | `accounts:write` | the account; `ConflictError` when not suspended |
| `packages.list()` | `packages:read` | `[{ name, disk_mb, bandwidth_mb, … }]` |
| `dns.zones.list({ account? })` | `dns:read` | zones without records |
| `dns.zones.get(domain)` | `dns:read` | the zone with `records`; `NotFoundError('dns zone')` |
| `backups.create({ account, include?, compression?, encrypt? })` | `backups:write` | artefact `{ id, account, path, size, sha256, createdAt, include, compression, encrypted }`. `include` ⊆ `BACKUP_COMPONENTS = home mail db dns ssl cron` (default all); `compression` ∈ `COMPRESSIONS = ['gzip']`; **`encrypt: true` → `PluginError UNSUPPORTED` (422)**: the panel only produces gzip-compressed, unencrypted archives |
| `backups.list({ account? })` | `backups:read` | artefacts |
| `backups.verify(artefactId)` | `backups:read` | `{ ok, sha256, size, verifiedAt }`; `NotFoundError('backup artefact')` |
| `backups.upload({ artefactId, destinationId })` | `backups:write` | `{ ok, remotePath, sha256 }`; `NotFoundError('backup destination')`; audited as `plugin.backup.upload` |
| `backups.delete(artefactId)` | `backups:write` | `{ ok: true }` — **removes the local artefact only**; a copy already uploaded to a destination stays and is governed by that destination's own retention (there is no API to delete a remote copy) |
| `backups.destinations.list()` | `backups:read` | `[{ id, name, kind }]` |
| `backups.restore({ artefactId, account, confirmToken })` | `backups:restore` | `{ ok, jobId }`. `confirmToken` is single-use, 10 minutes, issued to root by `POST /api/plugins/manage/<id>/restore-token { artefactId, account }` for exactly that artefact and account; anything else is `PermissionError('confirm-token')` |
| `services.status(name)` | `system:read` | `{ name, active, enabled, pid, since }`; `NotFoundError('service')` |
| `system.info()` | `system:read` | `{ hostname, os, kernel, uptimeSec, load, mem: { totalMb, usedMb }, disk: [{ mount, totalMb, usedMb }], panelVersion }` |
| `contacts.notify({ event, subject, body, severity? })` | `contacts:notify` | `{ ok, delivered }`; `event` must be `"<plugin id>.<name>"`; `severity` ∈ `SEVERITIES = info warning critical` |
| `audit.record({ action, target?, details? })` | `audit:write` | `{ id }`; `action` `/^[a-z][a-z0-9_.-]*$/`, stored as `plugin:<id>:<action>` with redacted details |

### 5.6 `ctx.agent.op(name, args?)` (gate `agent:op:<name>`)

Runs one allow-listed privileged op of the root agent (`family.op`, args object). Every call
writes an `audit_log` row (`principal plugin:<id>`, action `plugin.agent.op`, target = op name,
redacted args, `result` `ok` or `error:<code>`). Agent errors surface with their `code`
(`invalid_args`, `not_found`, `capability_missing`, …).

### 5.7 `ctx.jobs` (gate `jobs`)

| Method | Behaviour |
|---|---|
| `run(name, params?) → jobId (string)` | enqueues a declared job (`ValidationError` otherwise) |
| `status(jobId)` | `{ id, plugin, name, status, progress, message, params, result, error, trigger, createdAt, startedAt, finishedAt }`; `status` ∈ `JOB_STATES = queued running done failed cancelled`; `error.code` is the thrown error's `code` (`JOB_TIMEOUT`, `JOB_CANCELLED`, a plugin code, else `JOB_FAILED`) |
| `progress(jobId, pct, msg?)` | 0..100 |
| `cancel(jobId) → boolean` | `ConflictError` when the job is declared `cancellable: false`; aborts a running job's `signal` |

A job handler is `async (job, ctx) => result` with `job = { id, name, params (frozen), signal
(AbortSignal), progress(pct, msg?), log(msg), cancelled }`. The returned value becomes
`result`; a thrown error fails the job. Host job rows are `plugin:<id>:<job>` in the panel
`jobs` table and appear on the Manage Plugins page and the action pages' progress log.
`timeoutSec` (default host timeout otherwise) ends the job with `JOB_TIMEOUT`.

### 5.8 `ctx.schedule` (gate `schedule`)

Manifest `cron[]` entries are managed by the host (schedule rows `plugin:<id>:<cronName>`); a
`setting:<key>` schedule is created, replaced or removed whenever that `cron`-type setting changes
and is simply absent while the setting is empty. Runtime schedules: `cron(expr, jobName, params?)`
→ `{ id, jobName, expr, nextRunAt }` (`ConflictError` when the job already has a runtime schedule),
`unschedule(jobName) → boolean`, `list() → [{ id, name, jobName, expr, params, nextRunAt,
lastRunAt, source: 'manifest' | 'runtime' }]`. Expressions are 5-field UTC cron (`cron.js`: ranges,
steps, lists, names, `@hourly|@daily|@weekly|@monthly|@yearly`; Vixie day-of-month OR day-of-week).

### 5.9 `ctx.events`

`on(event, handler, { stage = 'post' })` (no gate; `ValidationError` for an unknown event or a
stage the event lacks) returns an unsubscribe function; `off(event, handler)` detaches runtime
subscriptions only (manifest hooks cannot be removed); `emit(event, payload?)` (gate `events:emit`)
→ `{ delivered }`; the event must be in the plugin's own namespace (`PermissionError
events:emit:<event>` otherwise) and the payload JSON-serialisable (≤ 1 MiB).

### 5.10 `ctx.http` (gate `api:routes`)

`baseUrl` (`/api/plugins/<id>`) and `get|post|put|patch|delete(path, [options], handler)` with
`options.roles ⊆ ['root', 'reseller', 'user']` (default `['root']`). Routes may only be registered
during `routes()`/`activate()` (`LifecycleError` later); paths match `API_ROUTE_PATTERN`
(`/items/:id` style parameters); a duplicate method+path is a `ConflictError`.

Handlers are `async (req, res)` with `req = { method, path, params, query, body, user: { id,
username, role }, headers, requestId, plugin }` and `res.status(code).json(data)` (wrapped as
`{ data }`; a status ≥ 400 is sent as given), `res.send(text)`, `res.set(name, value)` and
`res.error(code, message, status = 400)`. Nothing sent → `204`. A thrown `PluginError` becomes
`{ error: { code, message, details? } }` with its `status`; any other error is `500 INTERNAL` plus a
plugin log line. The panel's auth and CSRF apply (routes sit behind `requireAuth`); the host refuses
`Set-Cookie`, `Access-Control-*`, `Content-Security-Policy`, `Strict-Transport-Security` and
`X-Frame-Options` headers and only allows `text/plain` or `application/json` content types.

### 5.11 `ctx.ui.registerPage(descriptor)` (gate `ui:sidebar`)

Registers a page at runtime (only during `activate()`); same descriptor rules as manifest pages
(§7), `ConflictError` on a duplicate route. **Known host limitation (HOST_API_VERSION 1.0.0):** the
page catalog (`GET /api/plugins/ui`) overwrites every page's `source` key with the label of where
the page came from (`'manifest'` or `'runtime'`), and the panel's generic renderer builds the data
URL of a `table`/`form` page from that same key. Until the host stores the label under a separate
key, `table` and `form` pages — whether declared in the manifest or registered here — fetch
`/api/plugins/<id>manifest` and render no rows. Register only kinds without a `source` here
(markdown, html, settings, action), keep data pages in the manifest, and read their data through
the plugin's routes (`GET <baseUrl><route>`) or a `markdown`/`html` page until the fix lands.

### 5.12 `ctx.crypto` (gate `crypto:own`)

`encrypt(plaintext: string) → 'whm1:<base64>'` and `decrypt(ciphertext)` with AES-256-GCM under a
plugin-scoped key (HKDF-SHA256 of the panel master key, info = plugin id; the mock uses
`MOCK_MASTER_KEY` so ciphertexts are reproducible); `randomToken(bytes = 32) → hex` (8..1024);
`sha256(string | Buffer) → hex`. Decrypting foreign or tampered ciphertext is a `ValidationError`.

### 5.13 `ctx.fs` (gate `fs:own`)

Sandboxed to `ctx.plugin.dataDir`; paths are relative (`PathError` for absolute paths, `..`, NUL
bytes, backslashes; the host also refuses symlinks). `readFile(rel, { encoding = 'utf8' | null |
'buffer' })` (`NotFoundError('file')`), `writeFile(rel, string | Buffer)`, `list(rel = '.') →
[{ name, type: 'file' | 'dir', size, mtime }]`, `remove(rel, { recursive })` (a non-empty directory
needs `recursive: true`), `exists(rel)`, `mkdir(rel)`. Quota `MAX_FS_BYTES = 100 MiB`
(`QUOTA_EXCEEDED`, 507). Host differences: directories are real (`remove()` of an empty directory
returns `true`; `readFile()` of a directory is a `PathError`), the mock's directories are implicit.

### 5.14 `ctx.net.fetch(url, init?)` (gate `net:outbound:<host>`)

`https:` only; the URL's host and port must match a declared scope (§3). Returns a fetch-like
response. Host: 30 s timeout, redirects re-checked per hop (max 3; `Authorization`,
`Proxy-Authorization`, `Cookie` dropped when the origin changes). The mock records requests in
`state.requests` and answers with `opts.fetch` or an empty 200.

### 5.15 `ctx.i18n` (no gate)

`locale()` and `t(key, vars?, locale?)`: looks the key up in `<dir>/<locale>.json`, then the
manifest default locale, then returns the key; `{name}` placeholders are replaced from `vars` (§9).

## 6. Lifecycle

```
install ──► installed ──enable──► (migrate(from) when upgrading) ──► activate ──► enabled
                                                                            │
                                  disable ◄─────────────────────────────────┘
uninstall(purge?) removes the code (and, with purge, data dir, settings, store, documents, logs)
```

- **install** (`POST /api/plugins/manage/install`, raw `.whmplugin`, `{ path }` or `{ dir }`):
  unpack to staging → `validateManifest` (`422 invalid_manifest` with the error list) → engines
  check (`422 incompatible_host`) → `main` must exist → signature policy (§13) → atomic directory
  swap → row `installed`. Re-installing an existing id keeps its state; an enabled plugin is
  re-activated with `migrate(previousVersion)`.
- **enable**: load `main.js` (§11) → export checks → `routes(router, ctx)` → manifest pages →
  manifest cron → `migrate(ctx, from)` when upgrading → `activate(ctx)` → `enabled`. The whole
  sequence races `ACTIVATE_TIMEOUT_MS = 60 000` ms; a failure or timeout rolls everything back and
  leaves the plugin `errored` with `last_error` (`ACTIVATE_TIMEOUT`). One activation per id at a
  time.
- **disable**: `deactivate(ctx)` → routes, subscriptions and schedules removed, running jobs
  aborted → `disabled`.
- **uninstall**: disable → code removed; `?purge=true` also removes the data directory,
  settings, store, documents and logs → `plugin.uninstalled`.
- At boot `loadAll()` enables every row in state `enabled`; a failing plugin becomes `errored`
  and never stops the panel.

`LIFECYCLE_STATES = pending_consent disabled enabled errored revoked` is the marketplace-facing
vocabulary; the host rows use `installed | enabled | disabled | errored`.

## 7. Pages and the sidebar

`ui.sidebar[]` entries (`{ category, label, route, icon }`) appear in the named WHM category (one of
the 30 in `CATEGORIES`; unknown → *Plugins*), the Tools grid and search; each `route` must have a
matching `ui.pages[]` entry. Routes are relative to `/plugins/<id>` and match
`UI_ROUTE_PATTERN = /^\/(?:[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*)?$/`; icons are lucide names
(kebab-case). Every page has `route`, `title`, `kind`, optional `icon`, `description`, and per kind:

| `kind` | Extra keys | Rendered as |
|---|---|---|
| `settings` | — (needs a settings schema) | the settings form, `PUT /api/plugins/manage/<id>/settings` |
| `table` | `source` (a plugin route path), `columns?: [{ key, label }]` | `GET <baseUrl><source>` into a data table (needs `api:routes`) |
| `form` | `source`, `fields` (settings-field syntax) | a form that `POST`s to `<baseUrl><source>` (needs `api:routes`) |
| `action` | `job` (a declared job), `confirm?` | a confirm button that runs the job and streams its progress (needs `jobs`) |
| `markdown` | `content` or `file` (relative `*.md`) | a safe markdown renderer (no raw HTML) |
| `html` | `file` (relative `*.html`) | a sandboxed `<iframe>` (`sandbox=""`: no scripts reach the panel, no API access) |

Resellers see the pages of enabled plugins (`GET /api/plugins/ui`); whether their calls succeed
depends on the route `roles` (§5.10).

The `source` of `table` and `form` pages is validated and stored as you declare it, but the
current host replaces it with the origin label in the served catalog (see §5.11), so those two
kinds do not load data in the panel today; their routes work and are the stable contract.

## 8. Jobs and cron

Declare jobs in `manifest.jobs`, implement them in `module.exports.jobs`, start them from a cron
entry, an `action` page, `ctx.jobs.run()` or `POST /api/plugins/manage/<id>/jobs/<name>`
(root). Keep handlers idempotent and honour `job.signal`; report `job.progress()` so the
action page's log is useful. Manifest cron entries with `enabled: false` are not registered;
a `setting:<key>` schedule follows the setting. Do not schedule work that will be skipped: bind
the schedule to a setting and leave it empty instead (Automated Backup does exactly that).

## 9. i18n

Put `<locale>.json` files (`LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/`, flat `{ key: "text" }`)
in `manifest.i18n.dir` (default `locales`). `ctx.i18n.t('digest.subject', { count: 3 })` replaces
`{count}`; missing keys fall back to the default locale, then to the key itself. Invalid JSON is
logged and ignored. The mock host takes `{ locales: { en: {...}, de: {...} }, locale: 'de' }`.

## 10. Errors

All errors are `PluginError` subclasses with a stable `code`, an HTTP `status` and optional
`details`; `toJSON()` gives the panel envelope body. Throw them from routes and jobs.

| Class | code | status |
|---|---|---|
| `PluginError(message, { code, status, details })` | `PLUGIN_ERROR` (default) | 500 |
| `PermissionError(scope, method, pluginId)` | `PERMISSION_DENIED` | 403 |
| `ValidationError(message, fields?)` | `VALIDATION_ERROR` | 400 |
| `NotFoundError(resource, id)` | `NOT_FOUND` | 404 |
| `ConflictError(message, details?)` | `CONFLICT` | 409 |
| `PathError(message, path)` | `PATH_REJECTED` | 400 |
| `HookCancelled(reason, event)` | `HOOK_CANCELLED` | 409 |
| `IncompatibleError(pluginId, range, hostVersion)` | `INCOMPATIBLE_HOST` | 422 |
| `CronError(message, expr)` | `INVALID_CRON` | 400 |
| `LifecycleError(message, details?)` | `LIFECYCLE` | 409 |

Host-only codes seen by plugins: `UNSUPPORTED` (422, encrypted backups), `QUOTA_EXCEEDED` (507),
`SERVICE_UNAVAILABLE` (503), `HOOK_NOT_CANCELLABLE` (409), `JOB_TIMEOUT`, `JOB_CANCELLED`.

## 11. Trust model and the module sandbox

Every plugin runs **inside the panel process** (as `whm-panel`, or as root in monolithic mode).
`main.js` and its relative modules are evaluated in a dedicated `vm` context with the ECMAScript
intrinsics plus `Buffer`, `URL`/`URLSearchParams`, `TextEncoder`/`TextDecoder`,
`AbortController`/`AbortSignal`, timers, `structuredClone`, `atob`/`btoa`, `performance` and a
`console` that writes to the plugin log. `process`, `global` and `fetch` are `undefined`;
`eval`/`new Function` are disabled; dynamic `import()` is unavailable. `require()` resolves only:

- relative files inside the plugin directory (no symlink escapes),
- `whm/plugins/sdk` (frozen copy of the SDK's enumerable exports; the filesystem-backed `pack`
  module is deliberately not among them),
- the built-in allow-list `crypto path url util buffer events stream string_decoder querystring
  zlib assert timers` (with or without `node:`), handed out as frozen copies.

Anything else throws `PermissionError('require:<spec>')`. **This is a convenience barrier, not a
security boundary**: host objects reachable from `ctx` expose the panel realm, so the permission
gates and audit trail are an enforced contract for well-behaved code and a review aid, not
protection against a hostile package. Consequences for you as a developer:

- `POST /api/plugins/manage/install` always warns `in-process`; unsigned packages warn `unsigned`.
- Signed packages from trusted keys are the real control: operators may set
  `plugins.require_signature`, which refuses unverifiable packages (`422 unsigned_package`).
- Every `ctx.agent.op` and backup upload is audited with `principal plugin:<id>`.
- The marketplace static scan rejects packages containing `child_process`, `fs`, `net`, `http`,
  `vm`, `worker_threads`, `module`, `process.`, `eval`, `new Function`, `Reflect.`, `globalThis`,
  `import(`, `WebAssembly`, computed `constructor` access or escaped identifiers — they are broken
  or hostile either way (§15).
- `isolation: 'process'` is accepted but runs in-process today (a warning is logged once).

## 12. Packaging: `.whmplugin`

A `.whmplugin` is a gzip'ed ustar archive with `plugin.json` and `main.js` at the root (a single
top-level wrapper directory is tolerated and stripped). Rules enforced by the host tar reader and
by `pack.js`:

- regular files and directories only — no symlinks, hard links, devices, fifos, PAX headers;
- entry names: relative, no `..`, no NUL/whitespace/control characters, no backslashes
  (`UNSAFE_NAME_CHARS = /[\s\x00-\x1f\x7f]/`), no duplicates, no file/directory conflicts;
- limits: `MAX_PACKAGE_BYTES = 20 MiB` compressed, `MAX_EXTRACTED_BYTES = 50 MiB` extracted,
  `MAX_ENTRIES = 2000` entries;
- marketplace file-type allow-list: `.js .cjs .json .md .html .css .svg .png .jpg .txt .map`,
  `LICENSE`, `README`.

Build with the SDK packer, which is deterministic (sorted entries, mtime 0, uid/gid 0, mode
0644/0755, gzip level 9 — two builds of the same tree are byte-identical):

```
node scripts/build-plugin.js <dir> [--out file.whmplugin] [--sign <private.pem> [--dev]] [--kid <kid>]
                             [--exclude <pattern>]... [--include-tests] [--allow-secrets] [--json]
```

It refuses an invalid manifest and, unless signing locally (`--sign` without `--dev`), a source
directory that already contains `SIGNATURE.json`. It also refuses to package any file whose first
bytes hold a PEM private key (`-----BEGIN … PRIVATE KEY-----`, e.g. a signing key under `test/`
with `--include-tests`) unless `--allow-secrets` is given: a locally signed package never passes
the marketplace scanner, so this is the only guard. By default `node_modules/`, `.git/`, `test/`,
`tests/`, `*.whmplugin` and `.DS_Store` are excluded. It prints the package sha256, the digest, the
kid and the entry count. Programmatically, from build tooling and tests only — never from plugin
code, where the module is not exposed (§1, §11) — via `require('plugins/sdk').pack` or
`require('plugins/sdk/pack')`:

| Function | Purpose |
|---|---|
| `packDirectory(dir, { exclude, level })` → Buffer | deterministic gzip tar of the files in `dir` |
| `unpack(buf, dest, { maxBytes, maxEntries })` → entries | extract with the host's refusals |
| `listPackage(buf)` → `[{ name, type, size, mode }]` | inspect without writing |
| `packageRoot(dir)` | the directory holding `plugin.json` (strips one wrapper) |
| `packageDigest(dir, { exclude = ['SIGNATURE.json'] })` → Buffer(32) | the signed digest (§13) |
| `sign(digest, privateKeyPem)` → string | Ed25519, **standard base64 with padding** |
| `verify(digest, sigB64, publicKeyPem)` → boolean | exactly what the host decodes |
| `kidOf(publicKeyPem)` | first 8 hex of `sha256(raw 32-byte public key)` |
| `generateKeyPair()` → `{ privateKeyPem, publicKeyPem, kid }` | PKCS#8 / SPKI PEM |
| `writeSignature(dir, 'SIGNATURE.json' \| 'DEV-SIGNATURE.json', { kid, sig })` | writes `{ kid, alg: 'ed25519', sig }` |
| `readSignature(dir, fileName)`, `verifySignatureFile(dir, fileName, publicKeyPem)` | read / check a signature file |
| `sha256(data)` → hex, `walkFiles(dir, { exclude })`, `safeEntryName(name)` | helpers |

`PackError` (`code: 'invalid_package'`) is thrown for every refusal.

## 13. Signatures: `DEV-SIGNATURE.json` and `SIGNATURE.json`

The host verifies a package through its **canonical digest**:

```
packageDigest(root) = sha256( join('\n', sorted( `${relativePath} ${sha256hex(fileBytes)}` )) )
```

over every file under the (wrapper-stripped) root **except `SIGNATURE.json`**. Entry names may
not contain whitespace or control characters, which keeps the form injective. A root
`SIGNATURE.json` is

```json
{ "kid": "3f9a1c77", "alg": "ed25519", "sig": "<standard base64, padded>" }
```

where `sig = Ed25519(privateKey, packageDigest(root))`, encoded as **standard base64 with
padding** — the exact string `Buffer.from(sig, 'base64')` decodes in the host (license tokens
and the hub's `X-WHM-Signature` header use base64url instead; package signatures never do).
`kid` is the first 8 hex characters of `sha256(raw 32-byte public key)` and must match
`KID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`; the host looks the key up as
`$WHM_DATA_DIR/plugin-keys/<kid>.pub` (PEM SPKI). A verified package records `signer = kid`;
a tampered file is `422 invalid_signature`; an unknown kid is treated as unsigned (and refused
when `plugins.require_signature` is on).

Two signature files exist because two parties sign:

| File | Written by | Signs | Excludes |
|---|---|---|---|
| `DEV-SIGNATURE.json` | the developer (`build-plugin --sign dev.pem --dev`) | proves the upload comes from a registered key | `SIGNATURE.json` **and** `DEV-SIGNATURE.json` |
| `SIGNATURE.json` | the marketplace hub on approval (never the developer: an upload containing it is `422 reserved_file`) | what panels verify | `SIGNATURE.json` only — the developer's signature file is itself covered |

Because the hub signs everything but its own file, a published package verifies on a panel
byte-for-byte with the committed host code, and the developer signature stays valid after the hub
adds its file (`plugins/sdk/test/pack.test.js` and `plugins/sample-plugin/test/fixture.test.js`
assert both). Operators who distribute their own plugins sign them locally with `build-plugin
--sign key.pem` (no `--dev`) and drop `<kid>.pub` into `plugin-keys/`. Bundled plugins
(`plugins/bundled/*`, installed with `source: 'bundled'`) ship with the release and are exempt
from the signature gates.

## 14. Testing with `createMockHost`

`plugins/sdk/mock-host.js` is an in-memory implementation of §5 with the same gates and errors,
a deterministic clock and inspectable state. Use `node --test`:

```js
const { createMockHost } = require('../../sdk');           // path to plugins/sdk
const manifest = require('../plugin.json');
const mod = require('../main');

const host = createMockHost({
  manifest, now: Date.UTC(2026, 0, 1),
  accounts: [{ username: 'alice', domain: 'alice.test', owner: 'root', package: 'gold' }],
  packages: [{ name: 'gold' }], destinations: [{ id: 'offsite', name: 'S3', kind: 's3' }],
  services: { apache2: { active: true } }, agentOps: { 'svc.status': () => ({ ok: true }) },
  settings: { schedule: '0 2 * * *' }, locales: { en: require('../locales/en.json') }, locale: 'en',
  fetch: async (url, init) => ({ ok: true, status: 200 }),
});
await host.load(mod);                                       // { ok: true } | { ok: false, error }
await host.load(mod, { fromVersion: '1.0.2' });             // runs migrate(ctx, '1.0.2')
await host.fire('account.created', { username: 'bob' }, { stage: 'pre' });   // → { delivered, cancelled, reason, errors }
await host.advance(2 * 3600e3);                             // runs due cron jobs, moves the clock
const res = await host.callRoute('POST', '/notes', { body: {}, user: { id: 2, username: 'r', role: 'reseller' } });
const rec = await host.runJob('digest', { source: 'manual' });               // final job record
host.registerJob('run', async (job, ctx) => mod.jobs.run(job, patchedCtx));  // test one handler without load()
host.issueRestoreToken(artefactId, 'alice', { ttlMs });
host.grant('accounts:write'); host.revoke('accounts:write');
host.unusedPermissions();  host.deniedPermissions();        // keep the first at []
host.state;   // logs, jobs, cron, backups, backupsCreated, backupsDeleted, uploads, restores, verifications,
              // notifications, audit, store, settings, routes, pages, emitted, subscriptions, hookDeliveries,
              // agentOps, requests, fs, permissionsUsed, permissionDenials, suspensions, restoreTokens, migrations
await host.unload();                                        // deactivate(), clears schedules and subscriptions
```

Points worth knowing: `load()` makes `module.exports.jobs` the job handlers, so to test a job
against a patched `ctx` create a host *without* `load()` and `registerJob()` a wrapper (see the
Automated Backup tests); the mock's directories are implicit (`mkdir` is a no-op, `exists('dir')`
is true once a file is inside); ids (`doc_`, `job_`, `bk_`) share one counter per host; the host
has a few stricter behaviours listed in §5.

Run the SDK suite with `npm test --prefix plugins/sdk`; a plugin's own suite with `npm test` in
its directory (`package.json` `"type": "commonjs"`, `"test": "node --test \"test/*.test.js\""`).
`node --test` needs file globs, not directories (`node --test test/` fails with
`MODULE_NOT_FOUND` on Node 22); from the repository root:

```
node --test "plugins/sample-plugin/test/*.test.js" "plugins/bundled/net.whm.automated-backup/test/*.test.js"
```

## 15. Submitting to the marketplace

The marketplace (`docs/design/marketplace.md` §18) distributes signed packages to panels. The
developer flow:

1. **Register** (`POST /v1/dev/register { email, password, display_name }`), verify the e-mail,
   complete the profile and **enrol TOTP** — required before any namespace claim, key change,
   API key, e-mail/payout change or publish.
2. **Claim a namespace**: a reverse-DNS prefix of ≥ 2 segments you own (`net.acme` ↔ domain
   `acme.net`; the registrable domain is computed with the Public Suffix List, so `io.github` or
   `com` cannot be claimed and `io.github.<org>` goes through the GitHub-organisation method as
   `com.github.<org>`). Plugin ids must start with a claimed namespace (`net.acme` covers
   `net.acme.cache-boost`, never `net.acme-evil.x`). Reserved: `net.whm`, `net.trywhm`,
   `net.example`, `com.cpanel`, `net.cpanel`, `com.whm`, vendor brands and every bundled id prefix.
3. **Prove it**: DNS `TXT _whm-dev.<domain>` = `whm-dev-verify=<token>` or
   `https://<domain>/.well-known/whm-developer.txt` with the token, on exactly the namespace's
   domain or its registrable parent (optionally a GitHub organisation link or an ID document).
   Automated checks are inputs; a reviewer approves (`verified`, re-verification after 12 months)
   or rejects with a reason.
4. **Register an Ed25519 signing key** with proof of possession: `POST /v1/dev/keys` returns a
   32-byte challenge; `POST /v1/dev/keys/:challenge { public_key_pem, label, sig }` with
   `sig = ed25519(challenge)` (base64). The kid (§13 rule) must be unique across developer keys
   and absent from the hub's own keys (`409 kid_conflict`). Generate the pair with
   `pack.generateKeyPair()` or `openssl genpkey -algorithm ed25519`; keep the private key offline.
5. **Upload** `POST /v1/dev/plugins/:id/versions` (raw `.whmplugin`, ≤ 20 MiB) built with
   `build-plugin --sign <key.pem> --dev`, plus a justification for every permission. Upload rule:
   `status IN ('verified', 'pending') AND verified_at IS NOT NULL` (a previously verified developer
   back in `pending` may still upload; never-verified accounts cannot); the namespace must cover
   the id; `version` must be new and greater than every published version on the channel; the
   package must contain `DEV-SIGNATURE.json` from an *active* key of *this* developer and no
   `SIGNATURE.json`.
6. **Automated scan** (any failure → `scan_failed` with the report): manifest, engines, developer
   signature, file-type allow-list, the static scan (§11), permission justifications and risk,
   size and dependency checks, secret patterns, optional AV, and a typosquat check of the name /
   slug / id skeleton against every other developer's plugins, bundled plugins and reserved brands.
7. **Human review** → `approved` (the hub writes `SIGNATURE.json` and repacks deterministically),
   then **publish** to `stable` or `beta` — publishing always requires `status = 'verified'`.
   `changes_requested`/`rejected` come with structured reasons; resubmit as a **new version**
   (uploaded bytes are immutable).

After publication: developers may **yank** a version (hidden, no new installs); admins **revoke**
(panels disable it through the revocation feed) or take a plugin down. Installs on a panel go
through a **consent screen** listing the scopes with the texts of §3 and your justifications; an
update that adds scopes is held `pending_consent` (plugin disabled) until root consents, so declare
what you need up front.

## 16. Versioning and changelog rules

- Semver, strictly: a new `permissions` entry, a removed route/page/setting or a changed data
  shape is a **major**; new optional features are a **minor**; fixes are a **patch**. Pre-releases
  (`1.2.0-beta.1`) go to the `beta` channel.
- Versions are immutable once uploaded; re-upload as a new version.
- Every version carries a changelog (`changelog_md` on upload; keep `CHANGELOG.md` in the
  package too): one section per version, newest first, with *Added / Changed / Fixed / Removed /
  Security* bullets and an explicit **Permissions** line whenever scopes change (it is highlighted
  in review and on the consent screen).
- `engines.whm` names the host API range you tested against; widen it only after testing on the
  new host version. `HOST_API_VERSION` is independent of the panel's release number.
- Implement `migrate(ctx, fromVersion)` for every store/settings shape change and keep it
  idempotent (upgrades can be retried after a failed activation); never rename a setting key
  without migrating its value.

## 17. Backups: what a plugin can and cannot do

Backup plugins build on `ctx.api.backups` (§5.5). Keep three facts in mind:

- **Remote copies are governed by the destination's own retention.** `ctx.api.backups.delete`
  removes the local artefact only; there is no SDK call that deletes a copy from a destination.
  Record uploads you leave behind (the bundled Automated Backup marks them `remote: 'retained'`).
- **Archives are gzip and unencrypted** on this host version (`COMPRESSIONS = ['gzip']`,
  `encrypt: true` → `UNSUPPORTED`). A plugin cannot encrypt them itself: `ctx.fs` is the plugin
  data directory, archive bytes are not readable through the SDK. Surface the refusal as a warning.
- **Restores need an operator token** issued by `POST /api/plugins/manage/<id>/restore-token`;
  pass it to `ctx.api.backups.restore` unchanged and keep it out of anything the host persists:
  job params are stored (`jobs.params_json`, shown on the Manage Plugins job list), the store and
  collections are on disk. The bundled Automated Backup parks the token in memory under a random
  reference for at most its 10-minute lifetime, enqueues only the reference and redeems it once in
  the job (a reference orphaned by a restart fails with `PERMISSION_DENIED`; request a new token).

`backup.completed` / `backup.failed` hooks fire for every archive the host produces, including the
ones your own plugin requested — deduplicate by artefact id.
