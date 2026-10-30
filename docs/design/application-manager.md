# Application Manager — design and build contract

Category 31 (`application-manager`, icon `Rocket`), three functions already in `client/src/nav.js`:

| Function | key | What it does |
|---|---|---|
| Application Manager | `application-manager/application-manager` | Register, deploy, build, run, proxy, inspect and remove Node.js, Python and built-frontend applications per domain/base path. |
| Runtime Versions | `application-manager/runtime-versions` | Node.js and Python runtimes on the host; install/remove managed Node.js versions under `/opt/whm/runtimes/node/<version>`; defaults. |
| Application Templates | `application-manager/application-templates` | Built-in framework presets plus root-defined custom templates (presets saved with a name); "create an app from this template". |

Why this shape: cPanel's Application Manager needs Passenger; this panel instead runs each
application as its own **systemd unit as the account user**, bound to `127.0.0.1:<port>`, and
publishes it through the account's existing Apache vhost with a per-domain include
(`IncludeOptional <apache root>/whm-apps/<domain>.conf` — already rendered by `web.vhost.write`).
Static frontends (React, Angular, Vue, Svelte, static Next/Nuxt exports) are **built** as the user and
served by Apache from the build output directory with an SPA fallback. NGINX in front of Apache
already forwards `Upgrade`/`Connection` headers, so websockets pass through.

Everything below is binding for the builders. Names, shapes and error codes are the contract between
the agent family, the service/routes and the pages; each builder works against this file, not against
each other's code.

## 1. Kinds, presets and lifecycle

**Kinds**
- `node` — a long-running Node.js server (Express, NestJS, Next.js `next start`, Nuxt, custom). Needs a Node runtime. Proxied.
- `python` — a long-running WSGI/ASGI server in a venv (Flask/Django via gunicorn, FastAPI via uvicorn, or `python <file>`). Needs `python3` with `venv`. Proxied.
- `static` — a frontend built with Node (React/Vite, CRA, Angular, Vue, Svelte) or plain files; Apache serves the output directory; no process.

**Built-in presets** (`PRESETS` exported from `server/src/services/application-manager.js`; also served by `GET /api/apps/presets`). Each has `{ id, label, kind, framework, detect: { files: [...] }, install: 'npm'|'pip'|null, build: { script }|null, start: {...}|null, outputDir, spaFallback, websockets, docs }`:

| id | kind | install | build | start | outputDir |
|---|---|---|---|---|---|
| `express` | node | npm | — | `{ mode: 'file', entry: 'server.js' }` | — |
| `nestjs` | node | npm | `build` | `{ mode: 'file', entry: 'dist/main.js' }` | — |
| `nextjs` | node | npm | `build` | `{ mode: 'npm-script', script: 'start' }` | — |
| `nuxt` | node | npm | `build` | `{ mode: 'file', entry: '.output/server/index.mjs' }` | — |
| `node-custom` | node | npm | optional | `{ mode: 'npm-script', script: 'start' }` | — |
| `react-vite` | static | npm | `build` | — | `dist` |
| `react-cra` | static | npm | `build` | — | `build` |
| `angular` | static | npm | `build` | — | `dist/<project>/browser` (service resolves `<project>` from `angular.json` when inspecting; otherwise the user sets it) |
| `vue` | static | npm | `build` | — | `dist` |
| `svelte` | static | npm | `build` | — | `build` |
| `static-files` | static | — | — | — | `.` (the app root itself) |
| `flask` | python | pip | — | `{ mode: 'gunicorn', module: 'app:app' }` | — |
| `django` | python | pip | — | `{ mode: 'gunicorn', module: '<project>.wsgi:application' }` | — |
| `fastapi` | python | pip | — | `{ mode: 'uvicorn', module: 'main:app' }` | — |
| `python-custom` | python | pip | — | `{ mode: 'file', entry: 'main.py' }` | — |

**Start modes** (`start.mode`): `file` (node `<entry>` / python `<entry>`), `npm-script` (`npm run <script>`), `gunicorn` (`<venv>/bin/gunicorn <module> --bind 127.0.0.1:$PORT --workers <n>`), `uvicorn` (`<venv>/bin/uvicorn <module> --host 127.0.0.1 --port $PORT`). gunicorn/uvicorn are pip-installed into the venv by the deploy job when the mode needs them (`extraPackages`).

**Scaffolds** (used when the app root is empty and `scaffold: true`): `express` (package.json + server.js listening on `process.env.PORT`), `flask` (requirements.txt + app.py), `fastapi` (requirements.txt + main.py), `static-files` (index.html). Every scaffold prints the app name and says it was created by the panel. React/Angular/Vue projects are not scaffolded (the user uploads or clones a project); the preset only tells the panel how to build and where the output is.

**Lifecycle** of an app row (`status`): `created` → (`deploying`) → `running` | `stopped` | `failed` | `built` (static, served) ; `last_error` carries the last failure text. The deploy job (`app.deploy`, 202) runs: prepare root (mkdir / git clone / scaffold) → runtime check → install deps → build → (static: expose output dir, write proxy include) / (node|python: write unit, write proxy include, enable+start) → reload Apache → record status. Each step logs to the job; a failing step leaves the row `failed` with `last_error` and the job failed. `rebuild` = install+build+restart; `deploy` = `git pull --ff-only` (when the app has a git source) then rebuild. `start|stop|restart` are inline (`svc.*`). Removing an app: stop + remove unit + rewrite the domain include (other apps on the domain stay) + reload + optional `app.purge` of the root.

**Ports**: allocated by the service from `settings['apps.port_range']` (default `[30000, 39999]`), unique across `apps.port`, stored on the row; the unit passes `PORT`/`HOST=127.0.0.1`.

**Ownership/RBAC**: root sees all; a reseller sees only apps of accounts they own (`ctx.accounts.get(username, user)` throws 403 for others; use it in every service method that takes an app or a username). Runtime installs/removals, templates CRUD and settings are root only. Every mutation audits (`app.create`, `app.deploy`, `app.rebuild`, `app.start|stop|restart`, `app.update`, `app.remove`, `app.runtime.install|remove`, `app.template.*`); env values are redacted in audit args (`env: { KEY: '[redacted]' }`).

**Limits**: per-app `memory_max_mb` (default 512, min 64, max 65536), `tasks_max` (default 256), `cpu_quota_percent` (default 100 = one core, max 800). Reseller/account caps are a later item (packages); not in this build.

## 2. Agent op family `app` — `agent/src/ops/app.js` (+ `agent/test/app.test.js`)

Rules: `exec(bin, argv[])` only; every path through `ctx.assertAllowedPath`; everything that touches a user tree runs **as the user via `runuser -u <username> --`** (pattern: `agent/src/ops/acct.js` `acct.archive_logs`); root never creates, removes or follows anything inside a home. `assertManaged(username)` (copy the acct.js helper: a real passwd entry, uid ≥ 1000, not a system user, home under an allowed root) before anything. The app root must be inside the account's home (`realpath` stays under `<home>/`, lstat not a symlink, owned by the account uid), never the home itself and never `<home>/public_html` itself for `node`/`python` (static apps may live under public_html).

Shared validators (export them for the tests): `appId = z.number().int().positive().max(1_000_000)`; `unitName = (id) => `whm-app-${id}``; `envKey = /^[A-Z_][A-Z0-9_]{0,63}$/`; `envValue = max 4096, no `\0`, no `\n`/`\r``; `argToken = /^[A-Za-z0-9_@.:=,+\/-]{1,256}$/` (no whitespace, quotes, `$`, `%`, `;`, `&`, `|`, `<`, `>`, backslash); `basePath = /^\/(?:[A-Za-z0-9._-]+\/?)*$/` max 128, no `..`; `nodeVersion = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/`; `scriptName = /^[A-Za-z0-9:_.-]{1,64}$/`; `pipPackage = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\[[A-Za-z0-9,._-]+\])?(==[0-9][0-9A-Za-z.+!-]{0,63})?$/`; `moduleSpec = /^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*$/`; `gitUrl = https://… only, max 512, `/^https:\/\/[A-Za-z0-9._-]+(:\d{1,5})?\/[A-Za-z0-9._\/-]+(\.git)?$/`` (no userinfo, no query); `gitRef = /^[A-Za-z0-9._\/-]{1,128}$/` not starting with `-`.

| Op | Args (zod, `.strict()`) | Does | Returns / errors |
|---|---|---|---|
| `app.runtime.detect` | `{}` | System Node (`node`, `nodejs` on the search path → `--version`), managed Node (`/opt/whm/runtimes/node/<v>/bin/node`), Python interpreters (`python3`, `/usr/bin/python3.[0-9]*` → `--version`; `venv` support = `<python> -m venv --help` exits 0), `git`, `npm` per Node. Arch via `process.arch`. | `{ node: [{ version, bin, source: 'system'\|'managed', path }], python: [{ version, bin, source: 'system', venv: bool }], git: { installed, version }, arch }` |
| `app.runtime.node.install` | `{ version: nodeVersion }` timeoutMs 900_000 | Download `https://nodejs.org/dist/v<ver>/node-v<ver>-linux-<x64\|arm64>.tar.xz` and `SHASUMS256.txt` with `curl --fail --silent --show-error --location --proto =https --max-time 600 -o <file> <url>` into a private temp dir under `/opt/whm/runtimes/.tmp/<random>` (`ensurePrivateDir`), verify with `sha256sum --check --ignore-missing` on the filtered line (write a one-line checksum file), extract with `tar --extract --xz --file <tar> --directory <tmp> --no-same-owner --no-same-permissions`, then rename the `node-v<ver>-linux-<arch>` dir to `/opt/whm/runtimes/node/<ver>` (root-owned, 0755, `chmod -R go-w`). Refuse if the target exists (`exists`). | `{ version, path, bin, npm }`; `download_failed` / `checksum_mismatch` / `exists` |
| `app.runtime.node.remove` | `{ version: nodeVersion }` destructive | `rm -rf` `/opt/whm/runtimes/node/<ver>` (after `assertAllowedPath`, lstat is a directory, not a symlink). | `{ version, removed }` / `not_found` |
| `app.inspect` | `{ username, root: absPath }` | As root: `assertManaged`, root checks (exists, dir, owned, inside home). Reads **as the user** (`runuser -u u -- cat -- <root>/package.json`, max 256 KiB; same for `requirements.txt`, `angular.json`, listing with `runuser -u u -- ls -1A -- <root>` capped at 500 names). Detects framework hints: `package.json` deps (`next`, `nuxt`, `@nestjs/core`, `express`, `react-scripts`, `vite`, `@angular/core`, `vue`, `svelte`), scripts list, lockfile (`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`), `requirements.txt` names (`flask`, `django`, `fastapi`, `gunicorn`, `uvicorn`), `manage.py`, `wsgi.py`/`asgi.py`, `angular.json` project names, existing `dist`/`build` dirs. | `{ root, exists, empty, files: [...], packageJson: { name, scripts: {...}, dependencies: [names] }\|null, requirements: [names]\|null, angularProjects: [names], hints: { preset: id\|null, outputDir, startEntry, lockfile } }` ; `refused` when the root is outside the home / not owned |
| `app.prepare` | `{ username, root, source?: { gitUrl, ref? } , scaffold?: { template: enum(express,flask,fastapi,static-files), name } }` timeoutMs 900_000 | As the user: `mkdir -p -m 0755 -- <root>`; with `source`: the root must be empty, then `git -c core.hooksPath=/dev/null clone --depth 1 [--branch <ref>] -- <url> <root>` (env: `GIT_TERMINAL_PROMPT=0`, `HOME=<home>`); with `scaffold` and an empty root: write each file via `runuser -u u -- tee -- <root>/<file>` with `input`. Never both clone and scaffold. | `{ root, cloned: bool, scaffolded: [files] }`; `exists` (not empty) / `git_failed` (stderr tail) |
| `app.pull` | `{ username, root, ref? }` timeoutMs 600_000 | As the user in `cwd: root`: `git fetch --depth 1 origin [<ref>]` then `git reset --hard FETCH_HEAD` (`-c core.hooksPath=/dev/null`). | `{ root, head: <sha from git rev-parse HEAD> }` / `git_failed` |
| `app.step` | `{ username, root, step: enum('npm-install','npm-run','venv-create','pip-install'), runtime: { kind: enum(node,python), bin: absPath }, script?: scriptName, packages?: z.array(pipPackage).max(50), production?: bool }` timeoutMs 1_800_000 | As the user, `cwd: root`, env `HOME=<home>`, `PATH=<dir of runtime.bin>:<root>/.venv/bin:/usr/local/bin:/usr/bin:/bin`, `NODE_ENV` (`production` when `production`), `CI=1`, `npm_config_fund=false`, `npm_config_audit=false`, `npm_config_update_notifier=false`, `PIP_DISABLE_PIP_VERSION_CHECK=1`. `runtime.bin` must be `/opt/whm/runtimes/node/<v>/bin/node`, or a file in `/usr/bin`, `/usr/local/bin` (a `node`/`nodejs`/`python3*` basename). Steps: `npm-install` → `npm ci` when `package-lock.json` exists else `npm install` (plus `--omit=dev` when production and the preset has no build); `npm-run` → `npm run -- <script>`; `venv-create` → `<python> -m venv --upgrade-deps <root>/.venv` (fallback without `--upgrade-deps` on old Pythons); `pip-install` → `<root>/.venv/bin/pip install [-r requirements.txt if it exists] [packages…]`. Output: last 400 lines of stdout+stderr. | `{ step, code: 0, durationMs, output: [lines] }`; non-zero exit → `OpError('build_failed', <last line>, { output })` |
| `app.unit.write` | `{ id: appId, username, name: /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, root, exec: { bin: absPath, args: z.array(argToken).max(32) }, port: 1024–65535, env: z.record(envKey, envValue).max(64), pathDirs: z.array(absPath).max(4), mode: enum(development,production), limits: { memoryMaxMb, tasksMax, cpuQuotaPercent } }` | `bin` must be under `/opt/whm/runtimes/`, `/usr/bin/`, `/usr/local/bin/`, `<root>/.venv/bin/` or `<root>/node_modules/.bin/`. Writes `/etc/whm/apps/<id>.env` (0600 root, `KEY="escaped"` lines: `\\` and `\"` escaped; `%` written as `%%` nowhere — env files are not specifier-expanded) and `/etc/whm/apps/whm-app-<id>.service` (0644) rendered by the exported `renderUnit(spec)`; then `systemctl daemon-reload`, `systemctl enable /etc/whm/apps/whm-app-<id>.service` (links + enables). ExecStart tokens: `%` is forbidden by `argToken`; paths are quoted only if they contain spaces (they cannot). | `{ id, unit, path, envPath }` |
| `app.unit.remove` | `{ id }` destructive | `systemctl disable --now whm-app-<id>` (ignore not-found), unlink the two files if present, `daemon-reload`. | `{ id, removed }` |
| `app.proxy.write` | `{ domain: arg.hostname, apps: z.array({ id, kind: enum(proxy,static), basePath, port?, staticDir?: absPath, websockets: bool, spaFallback: bool }).max(20), reload: bool default true }` | `requireApache()`; file `<apache.root>/whm-apps/<domain>.conf` (dir created 0755). Rendered by exported `renderAppsInclude(domain, apps, { apacheVersion })`: a header `# Managed by WHM panel (applications for <domain>)` then per app: proxy → `ProxyPreserveHost On`, `RequestHeader set X-Forwarded-Proto "https" env=HTTPS`, `<Location "<base>">` `ProxyPass "http://127.0.0.1:<port>/" retry=0 timeout=120 [upgrade=websocket when websockets and Apache ≥ 2.4.47]` + `ProxyPassReverse …` `</Location>`; for websockets on older Apache add the `RewriteEngine On` / `RewriteCond %{HTTP:Upgrade} =websocket [NC]` / `RewriteRule ^<base>/?(.*)$ ws://127.0.0.1:<port>/$1 [P,L]` block. Base paths other than `/` are stripped (`ProxyPass "/api/" "http://127.0.0.1:port/"` — document that the app sees paths relative to the base). static → base `/`: `DocumentRoot "<staticDir>"`; other bases: `Alias "<base>" "<staticDir>"`; always `<Directory "<staticDir>">` `Options -Indexes +SymLinksIfOwnerMatch` `AllowOverride None` `Require all granted` [`FallbackResource "<base>/index.html"` when spaFallback] `</Directory>`. Empty `apps` → the file is removed. Ensures modules on Debian with `a2enmod -q proxy proxy_http proxy_wstunnel headers rewrite` (only when some proxy app exists; RHEL loads them from `00-proxy.conf`/`00-base.conf`, just check `httpd -M`). Then `configtest`; on failure restore the previous file (`writeApacheFile` pattern from web.js; copy the small helpers you need, do not import web.js internals that are not exported) and throw `config_invalid`; reload when `reload`. | `{ domain, path, apps: n, removed: bool, modules: { enabled: [...], missing: [...] }, reloaded }` |
| `app.static.expose` | `{ username, dir: absPath, runUser: /^[a-z][a-z0-9_-]{0,31}$/ }` | Makes `dir` (inside the home, owned by the user) readable by the web server: with `setfacl` → `setfacl -m u:<runUser>:x` on every directory from the home down to `dir`'s parent and `setfacl -R -m u:<runUser>:rX -m d:u:<runUser>:rX -- <dir>`; without it → `chmod o+x` on the chain and `chmod -R o+rX -- <dir>` **as the user** (`runuser`). | `{ dir, method: 'acl'\|'mode', chain: [...] }` |
| `app.purge` | `{ username, root }` destructive, timeoutMs 600_000 | As the user `rm -rf -- <root>` after the root checks (never the home, never `public_html` itself). | `{ root, removed }` |

Status, start/stop/restart/enable and logs use the existing `svc.status`, `svc.start|stop|restart`, `svc.journal` with `unit: 'whm-app-<id>'` — no new ops.

`renderUnit(spec)` (exported, pure):
```
[Unit]
Description=WHM application <name> (<username>)
After=network.target
[Service]
Type=simple
User=<username>
Group=<group>
WorkingDirectory=<root>
EnvironmentFile=/etc/whm/apps/<id>.env
Environment=PORT=<port> HOST=127.0.0.1 NODE_ENV=<mode> HOME=<home> PATH=<pathDirs joined>:/usr/local/bin:/usr/bin:/bin
ExecStart=<bin> <args>
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
KillSignal=SIGTERM
SyslogIdentifier=whm-app-<id>
MemoryMax=<memoryMaxMb>M
TasksMax=<tasksMax>
CPUQuota=<cpuQuotaPercent>%
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectControlGroups=yes
[Install]
WantedBy=multi-user.target
```

Tests (`agent/test/app.test.js`, vitest, same style as `agent/test/hardening.test.js`: mock `exec`, never run a real program with side effects): every schema rejects whitespace/quote/`%`/`$`/`;` in args and env, `..` and relative paths, roots outside the home, a symlinked root, `http://` git URLs and URLs with userinfo, bad versions; `renderUnit` and `renderAppsInclude` snapshots for proxy+websocket (new and old Apache), static root and static sub-path, multiple apps per domain, empty list → removed; `app.runtime.node.install` refuses an existing version and a checksum mismatch (mock exec for curl/sha256sum); `app.step` builds the exact argv for each step and refuses a `bin` outside the allowed dirs; `app.unit.write` refuses a `bin` outside the allowed dirs and renders `ExecStart` without shell metacharacters.

## 3. Panel — migration, service, routes, jobs

**Migration** `server/src/db/migrations/033_application-manager.sql` (`CREATE TABLE IF NOT EXISTS`, idempotent):

```sql
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('node','python','static')),
  preset TEXT,
  domain TEXT NOT NULL,
  base_path TEXT NOT NULL DEFAULT '/',
  root TEXT NOT NULL,
  start_json TEXT NOT NULL DEFAULT '{}',        -- { mode, entry|script|module, workers }
  build_json TEXT NOT NULL DEFAULT '{}',        -- { install: 'npm'|'pip'|null, script: 'build'|null, outputDir, extraPackages: [] }
  runtime_kind TEXT,                            -- 'node' | 'python' | NULL (static-files)
  runtime_version TEXT,                         -- requested version ('20.11.0', 'system', '3.12')
  runtime_bin TEXT,                             -- resolved at deploy
  port INTEGER UNIQUE,
  mode TEXT NOT NULL DEFAULT 'production' CHECK (mode IN ('development','production')),
  env_enc TEXT,                                 -- ctx.crypto.encrypt(JSON of env)
  websockets INTEGER NOT NULL DEFAULT 1,
  spa_fallback INTEGER NOT NULL DEFAULT 1,
  memory_max_mb INTEGER NOT NULL DEFAULT 512,
  tasks_max INTEGER NOT NULL DEFAULT 256,
  cpu_quota_percent INTEGER NOT NULL DEFAULT 100,
  source_json TEXT,                             -- { type: 'git', url, ref } | { type: 'upload' } | { type: 'scaffold', template }
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','deploying','running','stopped','failed','built')),
  last_error TEXT,
  last_job_id INTEGER,
  unit TEXT,                                    -- 'whm-app-<id>' once written
  proxy_path TEXT,                              -- include file written for the domain
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (domain, base_path)
);
CREATE INDEX IF NOT EXISTS idx_apps_account ON apps (account_id);
CREATE INDEX IF NOT EXISTS idx_apps_domain ON apps (domain);
CREATE TABLE IF NOT EXISTS app_runtimes (        -- managed Node installs (system runtimes are detected live)
  kind TEXT NOT NULL, version TEXT NOT NULL, path TEXT NOT NULL, bin TEXT NOT NULL,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (kind, version)
);
CREATE TABLE IF NOT EXISTS app_templates (        -- custom presets (built-ins live in code)
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('node','python','static')),
  preset_json TEXT NOT NULL, description TEXT, created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('apps.port_range', '[30000,39999]'), ('apps.default_node', '"system"'), ('apps.default_python', '"system"'),
  ('apps.default_memory_mb', '512'), ('apps.allow_resellers', 'true');
```

**Service** `server/src/services/application-manager.js` → `createApplicationManagerService(ctx)` attached as `ctx.apps`. Public methods (all `user` args are `req.user`; every one that names an account or app re-checks ownership through `ctx.accounts.get(username, user)`):

- `list(query, user)` → paginated `{ data, meta }` (`q` on name/domain/username, filters `account`, `kind`, `status`; sort `name|domain|username|status|updated_at`). Rows shaped: `{ id, name, kind, preset, username, domain, basePath, root, url: 'https://<domain><basePath>', port, mode, runtime: { kind, version, bin }, status, lastError, unit, websockets, spaFallback, limits: { memoryMaxMb, tasksMax, cpuQuotaPercent }, source, start, build, env: { KEY: value } (root and owning reseller only), createdAt, updatedAt }`.
- `get(id, user)` → shaped row + `live: { unit status from svc.status or null }` for node/python.
- `create(input, user, req)` → validates the domain belongs to the account (`account_domains` main/addon/sub or `accounts.domain`), base path unique per domain, allocates a port (node/python), resolves the preset into `start_json`/`build_json` (user overrides win), encrypts env, inserts, enqueues `app.deploy` with `{ appId, scaffold, source }`, audits → `{ app, job }`.
- `update(id, input, user, req)` → name, env, start, build, mode, limits, websockets, spaFallback, runtime_version; rewrites the unit/proxy when the app is deployed (inline ops), restarts when running; returns the shaped row. Changing `domain`/`basePath`/`root` is not allowed (remove and re-create).
- `control(id, verb: start|stop|restart, user, req)` → `svc.<verb>` on the unit (static apps → 422 `unsupported`), updates `status`, returns `{ id, verb, live }`.
- `rebuild(id, user, req)` → 202 job `app.rebuild`; `deploy(id, user, req)` → 202 job `app.deploy` with `{ appId, pull: true }` (422 when the app has no git source).
- `logs(id, { lines }, user)` → `svc.journal` lines (static → the Apache access/error log tail is out of scope; return `{ lines: [] , note }`).
- `inspect({ username, root }, user)` → `app.inspect` result plus the preset guess resolved against `PRESETS`.
- `remove(id, { deleteFiles }, user, req)` → stop + `app.unit.remove` + rewrite the domain include + `app.purge` when asked + delete row; tolerant of a missing agent capability (removes the row anyway, reports what failed in `cleanup`).
- `removeAccountApps(username, req)` → called by account termination (core hook already in `services/accounts.js` `cleanupAccount`): removes every app of the account without purging files (the home goes with the user).
- `domainsFor(username, user)` → `[ { domain, type, docroot } ]` for the create form.
- `presets()` → built-ins + custom templates (custom carry `custom: true, id`).
- `runtimes.list()` → `app.runtime.detect` merged with `app_runtimes` and the defaults; `runtimes.available()` → fetches `https://nodejs.org/dist/index.json` (server-side `fetch`, 10 s timeout, cached 1 h in memory; returns LTS + current lines: `{ version, lts, date }` max 40 entries; on network failure returns `{ available: [], error }` with 200); `runtimes.installNode(version, user, req)` → 202 job `app.runtime.install`; `runtimes.removeNode(version, user, req)` → refuses (409) while an app uses it; `runtimes.setDefaults({ node, python })`.
- `templates.list|create|update|remove` (root), `preset_json` validated with the same preset schema as `create` overrides.
- `jobs`: `{ 'app.deploy': handler, 'app.rebuild': handler, 'app.runtime.install': handler }` registered by the route module; handlers take the job ctx (`{ params, log, progress, agent }`) and must call the service's internal `runDeploy(appId, { pull, scaffold, source }, job)`.

Capabilities registered in `register(ctx)`: `node` (`['node','nodejs']`), `python` (`['python3']`), `git` (`['git']`), `acl` (`['setfacl']`). Apache missing → the deploy job still prepares/builds and marks the app `failed` with `last_error = 'Apache is not installed…'` after the build? No: it raises `CapabilityError('apache')` **before** doing anything, and `create` itself refuses with 501 when neither Apache nor systemd is available (the page shows the install prompt). Node/python missing → 501 with the capability named.

Errors → HTTP via the existing `middleware/error.js` mapping (`build_failed`, `git_failed`, `checksum_mismatch`, `download_failed` → 422; `refused` → 422; `exists` → 409).

**Routes** `server/src/routes/categories/application-manager.js` → `{ path: '/apps', router }`:

| Method | Path | Role | Body / query → service |
|---|---|---|---|
| GET | `/apps` | reseller | `pagination` + `account?`, `kind?`, `status?` → `list` |
| POST | `/apps` | reseller | `{ username, name, kind, preset?, domain, basePath='/', root (absolute, under the home; the service rejects others), start?, build?, runtimeVersion?, mode?, env?, websockets?, spaFallback?, limits?, source?: { type: 'git', url, ref? } \| { type: 'scaffold', template } \| { type: 'upload' } }` → 202 `{ app, job }` |
| GET | `/apps/presets` | reseller | → `presets()` |
| POST | `/apps/inspect` | reseller | `{ username, root }` → `inspect` |
| GET | `/apps/accounts/:username/domains` | reseller | → `domainsFor` |
| GET | `/apps/runtimes` | reseller | → `runtimes.list()` |
| GET | `/apps/runtimes/node/available` | root | → `runtimes.available()` |
| POST | `/apps/runtimes/node/install` | root | `{ version }` → 202 |
| DELETE | `/apps/runtimes/node/:version` | root | → remove |
| PUT | `/apps/runtimes/defaults` | root | `{ node?, python? }` |
| GET/POST | `/apps/templates` ; PUT/DELETE `/apps/templates/:id` | root | templates CRUD |
| GET | `/apps/:id` | reseller | → `get` |
| PUT | `/apps/:id` | reseller | partial update → `update` |
| DELETE | `/apps/:id` | reseller | `?deleteFiles=true` → `remove` |
| POST | `/apps/:id/:verb(start\|stop\|restart)` | reseller | → `control` |
| POST | `/apps/:id/rebuild` ; `/apps/:id/deploy` | reseller | → 202 |
| GET | `/apps/:id/logs` | reseller | `lines` 1–2000 default 200 → `logs` |

Route order: literal paths (`/apps/presets`, `/apps/runtimes…`, `/apps/templates…`, `/apps/inspect`, `/apps/accounts/…`) **before** `/apps/:id`.

**Tests** `server/test/application-manager.test.js` (vitest + supertest, `createTestApp` with a mock agent answering `app.*`, `svc.*`, `sys.binaries` for node/python/git/apache/systemctl): create → 202 + job runs the full deploy sequence (assert the op call order and args: prepare → step npm-install → step npm-run build → unit.write → proxy.write → svc.enable/start), static React app → no unit, `app.static.expose` + proxy static block, python app → venv-create, pip-install with gunicorn in `packages`; reseller cannot see/control another reseller's app (403/404); base path uniqueness (409); port allocation unique and inside the range; env redacted in audit rows and absent for other users; remove rewrites the domain include with the remaining apps and purges when asked; `removeAccountApps` on termination; runtime install job + refusal to remove a runtime in use; capability missing → 501; `presets()` contains every built-in id.

## 4. Pages — `client/src/pages/fn/application-manager/*.jsx` (+ shared `client/src/pages/apps/*.jsx`)

Use the shared kit (`components/*`, `pages/software/Shared.jsx` `useJobRunner`/`JobPanel`/`JobHistory`/`Tabs`/`RequestError`, `Common.jsx` `CapabilityNotice`). Pages receive `{ fn }` and start with `<PageHeader fn={fn} />`. Import icons by name. Wrap raw tables in `.table-wrap`.

- `application-manager.jsx` — table of apps (name, kind badge, account, URL (link), runtime, status pill with live state, port, actions: Open, Logs, Start/Stop/Restart, Rebuild, Deploy (git only), Edit, Remove). "Create application" opens a 3-step modal: **1. Where** (account select → domains of that account; base path; app root suggested as `<home>/apps/<slug>` or `<home>/public_html/<slug>` for static; "Inspect" button → `/apps/inspect` fills the preset guess), **2. What** (kind + preset cards, start/build fields prefilled from the preset and editable, runtime version from `/apps/runtimes`, source: upload (already there) / git URL + ref / scaffold template), **3. Settings** (mode, env editor key/value rows, websockets, SPA fallback, limits). Submit → 202 → `JobPanel` streams the deploy log; the table refetches on finish. App detail drawer/modal: live status, journal tail with refresh, env editor (save → PUT), source, last error. Capability banner when Apache/systemd/node/python is missing (501 → `CapabilityNotice`).
- `runtime-versions.jsx` — Node: system + managed versions table (version, source, path, apps using it, default radio, Remove), "Install a version" (available list from `/apps/runtimes/node/available` grouped LTS/current, or a typed version) → 202 + job panel; Python: detected interpreters with venv support flag and an install hint (`python3-venv`/`python3-pip` via Software › Install Distro Packages with a link); git presence; defaults form (`PUT /apps/runtimes/defaults`).
- `application-templates.jsx` — preset catalog cards (built-in, read-only, with the fields they set) + custom templates table with create/edit (name, slug, kind, JSON preset fields in a form, not raw JSON) and delete; "Use template" navigates to `/application-manager/application-manager?preset=<id>` which pre-selects it in the create modal.
- `client/test/application-manager.test.jsx` (renderToStaticMarkup like `client/test/security-advisor.test.jsx`): the preset card list renders every preset, the apps table renders status pills and the create modal's step 2 prefills from a preset.

## 5. Docs and tracker (integrator items)

- `docs/MANUAL-partB.md`: new section `## 31. Application Manager` (before Appendix A) in the manual's function-block format; `docs/MANUAL.md` table of contents; `README.md` and `BLUEPRINT.md` §13 entry (`### 13.31 Application Manager`) and the "212 functions" counts → 215 / 30 → 31 everywhere (`CLAUDE.md`, `HANDOFF.md`, `CHECKLIST.md` `### 31. Application Manager`, `e2e/screenshot-all.cjs` text, `docs/screenshots` READMEs on the next refresh).
- `docs/design/integration-contracts.md` §33: the vhost include seam (`IncludeOptional <apache root>/whm-apps/<domain>.conf`, owned by application-manager; service-configuration never writes it), `ctx.apps.removeAccountApps` hook, the `/opt/whm/runtimes` allowed root, `ctx.apps` on the service list.
