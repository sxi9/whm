# WHM — Installation guide

This guide covers installing, upgrading, backing up and removing the WHM control panel (the
panel + its root agent) and the optional **whm-hub** (license server + plugin marketplace).
Every path, flag, port and variable below is taken from the code in this repository:
[`scripts/install.sh`](../scripts/install.sh), [`server/src/config.js`](../server/src/config.js),
[`agent/src/index.js`](../agent/src/index.js), [`hub/src/config.js`](../hub/src/config.js),
[`hub/scripts/gen-key.js`](../hub/scripts/gen-key.js), [`hub/scripts/hub-cli.js`](../hub/scripts/hub-cli.js),
the unit files and templates under [`deploy/`](../deploy/) and [`.env.example`](../.env.example).

Related documents: [`README.md`](../README.md) (overview), [`BLUEPRINT.md`](../BLUEPRINT.md)
(architecture and every function; §16–18 license, plugins, marketplace),
[`plugins/SDK.md`](../plugins/SDK.md) (plugin development), [`design/license-server.md`](design/license-server.md),
[`design/marketplace.md`](design/marketplace.md), [`design/plugin-host.md`](design/plugin-host.md).

## Table of contents

1. [What you get](#1-what-you-get)
   - [Components](#11-components)
   - [Deployment modes: split and monolithic](#12-deployment-modes-split-and-monolithic)
2. [Requirements](#2-requirements)
   - [Operating system and tools](#21-operating-system-and-tools)
   - [Ports](#22-ports)
   - [Daemons the panel manages](#23-daemons-the-panel-manages)
3. [Quick start for development](#3-quick-start-for-development)
4. [Production install with scripts/install.sh](#4-production-install-with-scriptsinstallsh)
   - [Flags](#41-flags)
   - [Environment overrides](#42-environment-overrides)
   - [What the installer does, step by step](#43-what-the-installer-does-step-by-step)
   - [What it creates](#44-what-it-creates)
   - [TLS](#45-tls)
   - [Post-install checks](#46-post-install-checks)
   - [First login](#47-first-login)
5. [The hub: license server and marketplace](#5-the-hub-license-server-and-marketplace)
   - [Installing the hub](#51-installing-the-hub)
   - [Keys: what gen-key.js generates and what to pin where](#52-keys-what-gen-keyjs-generates-and-what-to-pin-where)
   - [The first vendor admin](#53-the-first-vendor-admin)
   - [Issuing the first license](#54-issuing-the-first-license)
   - [Connecting a panel to the hub](#55-connecting-a-panel-to-the-hub)
   - [hub.conf reference](#56-hubconf-reference)
   - [hub.env and secrets](#57-hubenv-and-secrets)
6. [Upgrades, backups and uninstall](#6-upgrades-backups-and-uninstall)
   - [Upgrading](#61-upgrading)
   - [Backing up the panel](#62-backing-up-the-panel)
   - [Backing up the hub](#63-backing-up-the-hub)
   - [Uninstalling](#64-uninstalling)
7. [Configuration reference](#7-configuration-reference)
   - [Panel: WHM_* variables and whm.conf keys](#71-panel-whm_-variables-and-whmconf-keys)
   - [Agent: whm-agentd variables and agent.conf](#72-agent-whm-agentd-variables-and-agentconf)
   - [Hub: WHM_HUB_* variables](#73-hub-whm_hub_-variables)
   - [Installer-only variables](#74-installer-only-variables)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. What you get

### 1.1 Components

| Component | Code | Runs as | What it is |
|---|---|---|---|
| **Panel** (`whm-panel`) | `server/` (Express API, services, SQLite) + `client/` (React SPA built to `client/dist`) | `whmpanel` (unprivileged) in production | The WHM web interface and its API: 31 categories, 215 functions (212 WHM functions + Application Manager), sessions, RBAC, audit log, jobs, scheduler, plugin host, license client and marketplace client. Keeps its own state in `whm.db` (SQLite, WAL) under the data directory. |
| **Agent** (`whm-agentd`) | `agent/` | root | A small daemon listening on a Unix socket (`/run/whm-agent.sock`) that executes an **allowlisted catalog of named operations** (create a Linux user, write a vhost, reload BIND, …). It only ever runs programs with `execFile(bin, argv[])`; there is deliberately no "run this command" op. |
| **Hub** (`whm-hub`, optional) | `hub/` (API) + `hub/ui/` (vendor-admin, reseller and developer portal) | `whmhub` | The **license server** (keys, activations, check-ins, trials, resellers, billing webhooks) and the **plugin marketplace** (developer verification, signed packages, catalog, revocations, entitlements). Only a vendor who resells the panel runs one; panels only *pull* from it, so a hub outage never affects a running panel. |

The panel listens on HTTP **2086** and, when a certificate is configured, HTTPS **2087**
(`server/src/index.js`). The hub listens on HTTPS **7443** and a loopback-only HTTP port **7440**
for `/healthz` and `/metrics` (`hub/src/index.js`).

### 1.2 Deployment modes: split and monolithic

`WHM_MODE` (`server/src/config.js`) accepts exactly two values; anything else aborts the boot with
`WHM_MODE must be "monolithic" or "split"`.

| Mode | How privileged operations run | When to use |
|---|---|---|
| **`split`** | The API process runs as the non-root `whmpanel` user and sends every privileged operation as a JSON request over `WHM_AGENT_SOCKET` to `whm-agentd`, which runs as root. The socket is `0660 root:<WHM_AGENT_GROUP>` (`whmpanel` by default), so only the panel can reach it. | **Production.** This is what `scripts/install.sh` configures (`deploy/panel.env.example` sets `WHM_MODE=split`; `whm-panel.service` `Requires=whm-agentd.service`). The web tier runs under systemd hardening (`ProtectSystem=strict`, `NoNewPrivileges`, …) and never touches the host directly. |
| **`monolithic`** | One process runs the API **and** executes the same op modules in-process (`server/src/lib/agent-client.js` picks the in-process client). | **Development and tests** (`.env.example` default). Because the ops run inside the API process, the process must itself be root for operations such as account creation to really create Linux users; as an ordinary user, those ops fail and the UI reports the error. |

In both modes the ops, their argument schemas and the allowed path roots are identical
(`agent/src/ops/*`, `agent/src/lib.js`).

---

## 2. Requirements

### 2.1 Operating system and tools

- **Linux with systemd.** `install.sh` aborts with `systemd is required` when `systemctl` is
  missing, and with `no supported package manager` unless `apt-get`, `dnf` or `yum` exists.
  The README names Ubuntu 22.04/24.04, Debian 12 and RHEL/AlmaLinux/Rocky 8/9.
- **Root** to install (`run as root (sudo)`) and to manage the server.
- **Node.js ≥ 22** (`package.json` `engines.node >=22`). The installer installs it from NodeSource
  when `node` is missing or older than 22, unless `--skip-node` is given; it then re-checks and
  aborts with `Node.js >= 22 is required`.
- **Build prerequisites** installed by the installer: on apt `ca-certificates curl gnupg openssl
  build-essential python3 rsync tar`; on dnf/yum `ca-certificates curl openssl gcc-c++ make python3
  rsync tar`. The compiler and `python3` are needed to build `better-sqlite3`; `openssl` generates the
  self-signed certificates; `rsync` deploys the checkout.
- **Disk.** The install holds the application under `/opt/whm` (sources, `node_modules`, the built
  SPA), the panel data under `/var/lib/whm` (SQLite database, plugins, plugin data) and, with a hub,
  `/var/lib/whm-hub` (databases, uploaded packages of up to `marketplace.max_package_bytes` = 20 MiB
  each) plus hourly database backups under `/var/backups/whm-hub` (48 kept by default). The code
  does not check for a minimum free space.
- **Outbound HTTPS** from the installer host to NodeSource (Node install) and the npm registry
  (`npm ci`), and from panels to their hub.

### 2.2 Ports

| Port | Process | Bound to | Purpose |
|---|---|---|---|
| **2086/tcp** | whm-panel | `WHM_HOST` (default `0.0.0.0`) | HTTP interface and API. Always opened. |
| **2087/tcp** | whm-panel | `WHM_HOST` | HTTPS interface; opened only when both `WHM_TLS_CERT` and `WHM_TLS_KEY` (or `tlsCert`/`tlsKey` in `whm.conf`) are set. Minimum TLS 1.2. |
| **7443/tcp** | whm-hub | `host` (default `0.0.0.0`) | Hub HTTPS: `/v1/*` license API, `/v1/market/*`, `/v1/dev/*`, `/v1/admin/*`, `/v1/reseller/*`, `/v1/portal/*`, and the portal SPA at `/` when `serve_ui` is on. |
| **7440/tcp** | whm-hub | `127.0.0.1` only | `/healthz` and `/metrics`. `loopback_port: 0` disables it. Never expose it. |
| `/run/whm-agent.sock` | whm-agentd | Unix socket, `0660 root:whmpanel` | Panel → agent requests (split mode). |

Open 2086 and 2087 (and 7443 on a hub host) in your firewall; the installer prints the reminder.

### 2.3 Daemons the panel manages

The panel administers whatever is installed on the host. At boot each category registers the
binaries it needs with the capability registry (`ctx.capabilities.register(name, { binaries,
required })`); the registry is refreshed after the agent self-check (`capabilities.refresh()` in
`server/src/index.js`). Registered capabilities and the binary that must exist for each:

| Capability | Required binary (any of) | Also used |
|---|---|---|
| `bind` | `named` | `rndc`, `named-checkzone`, `named-checkconf`, `dnssec-keygen`, `dnssec-signzone` |
| `powerdns` | `pdns_server` | `pdns_control`, `pdnsutil` |
| `exim` | `exim` or `exim4` | `exiqgrep`, `update-exim4.conf`, `greylistd`, `sqlite3` |
| `mysql` | `mysqld`, `mariadbd`, `mysql` or `mariadb` | `mysqlcheck`, `mysqldump`, `mysql_upgrade` and the `mariadb-*` equivalents |
| `postgres` | `psql` | `pg_dump`, `runuser` |
| `nginx` | `nginx` | |
| `php` | `php` | `php-fpm` |
| `ssl` | `openssl` | |
| `acme` | `certbot` or `acme.sh` | |
| `sshd` | `sshd` | `ssh-keygen` |
| `ssh` | `ssh` | `scp`, `ssh-keyscan`; `sshpass` is optional (transfers) |
| `quota` | `repquota` and `setquota` | `quotacheck`, `quotaon`, `quotaoff` |
| `pkg` | `apt-get`, `dnf` or `yum` | `dpkg-query`, `rpm`; `rpm` is its own capability |
| `backup` | `tar` | `gzip`, `curl`, `mysqldump`/`mariadb-dump` |
| `logrotate` | `logrotate` | |
| `procps` | `ps` | `renice` |
| `terminal` | `script` | `bash` |
| `timedatectl`, `hostnamectl`, `resolvectl` (or `systemd-resolve`), `iproute2` (`ip`) | the named binary | networking, time and hostname functions |
| `jailshell` | `jailshell` | |
| `glibc-locales` | `locale` | `localedef`, `locale-gen` |
| `perl`, `cpan` (`cpanm`/`cpan`), `pecl`, `pear`, `gem`, `pip` (`pip3`/`pip`) | the named binary | Software category installers |
| `imunifyav` (`imunify-antivirus`), `clamav` (`clamscan`), `wpcli` (`wp`) | the named binary | bundled plugins |

Other functions check for their binary at call time: `agent/src/exec.js` resolves a program name
in `/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin` and rejects with
`binary_not_found` when it is absent.

**When a daemon is absent** nothing crashes: the agent answers `capability_missing` or
`binary_not_found`, `server/src/middleware/error.js` maps both to **HTTP 501**, and the page shows an
install prompt for the missing service instead of its controls. Features whose daemon exists work
fully. The agent also confines every path argument to an allowlist of roots
(`DEFAULT_ALLOWED_ROOTS` in `agent/src/lib.js`: `/home`, `/var/lib/whm`, `/etc/whm`, `/var/log/whm`,
`/etc/apache2`, `/etc/httpd`, `/etc/nginx`, `/var/www`, `/etc/bind`, `/var/named`, `/etc/exim*`,
`/etc/dovecot`, `/etc/mysql`, `/etc/letsencrypt`, `/backup`, `/var/backups/whm`, …); it can be widened
with `extraAllowedRoots` in `/etc/whm/agent.conf`.

---

## 3. Quick start for development

```bash
git clone https://github.com/sxi9/whm.git
cd whm
npm install                    # installs every workspace: server, agent, client, hub, hub/ui
cp .env.example .env           # monolithic mode, ./data, HTTP 2086, no TLS
npm run dev                    # API with node --watch on :2086 + Vite dev server on :5173 (proxies /api)
```

- `npm run dev` runs `node --watch --env-file-if-exists=../.env src/index.js` inside `server/`
  (`server/package.json`) and `vite` inside `client/` (`client/vite.config.js`: port 5173,
  `/api` proxied to the API). Open **http://localhost:5173/**.
- `.env` is only read by the `dev` script. `npm start` (`node src/index.js`) reads no `.env`; pass
  variables on the command line.
- The data directory is `WHM_DATA_DIR` resolved against the server process's working directory
  (`path.resolve(process.cwd(), 'data')` when unset and `NODE_ENV` is not `production`). Started
  through the npm scripts the process runs in `server/`, so `./data` is **`server/data`**. It is
  created on boot (`0750`) and holds `whm.db`, `session.secret`, `master.key`, `plugins/`,
  `plugin-data/` and `plugin-keys/`. `data/`, `*.db` and `.env` are git-ignored.
- **Monolithic mode runs the agent ops in-process**: run the API as root (`sudo -E npm run dev` or
  `sudo node server/src/index.js`) if you want account creation to really create Linux users.
  As an ordinary user the pages load and the privileged ops fail with a visible error.
- **First root password.** On the first boot the seed (`server/src/db/seed.js`) creates the `root`
  administrator. With `WHM_ADMIN_PASSWORD` set, that password is used. Otherwise a 20-character
  password is generated and written (mode `0600`) to **`<data dir>/initial-admin-password.txt`**:

  ```
  username: root
  password: <generated>
  ```

  and the account is flagged `must_change_password`: the SPA redirects to `/change-password`
  until you set a new one. Delete the file afterwards.
- **2FA enrolment.** Go to *Security Center › Two-Factor Authentication*
  (`/security-center/two-factor-authentication`; API `POST /api/auth/2fa/enroll` then
  `POST /api/auth/2fa/confirm { code }`). 2FA becomes mandatory for root when the setting
  `security.2fa.required_for_root` is on (`server/src/services/auth.js`); the session then carries
  `mustEnroll2fa` and the SPA allows nothing but the enrolment page and `/change-password`
  (`client/src/components/Layout.jsx`). It is optional by default.

Production-style single process (serves the built SPA from the API, no Vite):

```bash
npm run build                                   # client/dist (+ hub/ui/dist)
WHM_SERVE_CLIENT=true npm start                 # http://127.0.0.1:2086/
```

Tests and checks:

```bash
npm test                                        # all workspaces (server, agent, client, hub, hub/ui) + SDK, sample and bundled plugins
cd hub && npm test                              # hub suite alone (node --test)
BASE=http://127.0.0.1:2086 PASSWORD='<root password>' node e2e/ui-check.cjs   # Playwright end-to-end against a served build
```

To run a development hub next to a development panel, see [§5.5](#55-connecting-a-panel-to-the-hub)
(`npm run hub`, `WHM_LICENSE_HUB_URL`, `WHM_LICENSE_KEYS_FILE`, `WHM_LICENSE_HUB_CA`).

---

## 4. Production install with scripts/install.sh

```bash
git clone https://github.com/sxi9/whm.git
cd whm
sudo bash scripts/install.sh
```

The script must run as root, from a checkout (it checks for `package.json` and `server/` next to
`scripts/`), on a systemd host with apt-get/dnf/yum. `sudo bash scripts/install.sh --help` prints the
header comment.

### 4.1 Flags

| Flag | Effect |
|---|---|
| *(none)* | Fresh install (or re-run) from this checkout into `/opt/whm`. |
| `--upgrade` | Redeploy the code, dependencies, UI build and units; keep data and configuration; restart. Also upgrades an installed hub automatically (`/etc/systemd/system/whm-hub.service` present) without `--with-hub`. See [§6.1](#61-upgrading). |
| `--with-hub` | Additionally install **whm-hub** on this host (user, directories, config, keys, certificate, unit). Requires `hub/package.json` and `hub/src/index.js` in the checkout. |
| `--skip-node` | Do not install Node.js from NodeSource; the installed `node` must still be ≥ 22. |
| `-h`, `--help` | Print usage and exit. |

Any other argument aborts with `unknown option`.

### 4.2 Environment overrides

Set these in the environment of the `sudo bash scripts/install.sh` call.

| Variable | Default | Effect |
|---|---|---|
| `WHM_APP_DIR` | `/opt/whm` | Where the application is deployed. Substituted into both panel units. |
| `WHM_DATA_DIR` | `/var/lib/whm` | Panel data directory. Substituted into `whm-panel.service` (`ReadWritePaths`, `/var/lib/whm` occurrences). Note that the installed `panel.env` and `whm.conf` templates still say `/var/lib/whm`; edit them if you change this. |
| `WHM_ADMIN_PASSWORD` | *(generated)* | Appended to `/etc/whm/panel.env` on a first install so the seed creates `root` with this password instead of generating one. |
| `WHM_LICENSE_HUB_URL` | `https://licserver.hostingsignal.in` (local hub with `--with-hub`) | Written to `panel.env` as the bootstrap license hub. Must start with `https://`. With `--with-hub` it defaults to the hub's public URL; on a terminal (first install, not `--upgrade`) the script asks once with the vendor hub `https://licserver.hostingsignal.in` as the default, which the panel also uses when the variable is unset. An existing `WHM_LICENSE_HUB_URL=` line is never changed. Only the super admin sees the hub address in the panel. |
| `WHM_SUPERADMIN_SETUP_PASSWORD` | *(ask)* | The **super admin setup password** (at least 12 characters). Its bcrypt hash is written to `/var/lib/whm/superadmin.key` (`0600 root:root`); on a terminal (first install, not `--upgrade`) the script asks for it once (blank skips: run `whm-cli superadmin --init` later). `whm-cli superadmin <user>` only grants the super admin flag after this password verifies ([§4.7](#47-first-login)). |
| `HUB_PUBLIC_URL` | `https://<hostname -f>:7443` | Hub `public_url` (the `iss` of every token). On an installed hub, the only hub.conf value an upgrade writes back. |
| `HUB_DATA_DIR` | `/var/lib/whm-hub` | Hub databases, packages, PSL file. On an installed hub a *different* value aborts: move the directory by hand (see [§6.1](#61-upgrading)). |
| `HUB_ADMIN_EMAIL` | *(unset)* | First-install only: create the vendor-admin portal user with this e-mail and print the password. |
| `HUB_ADMIN_PASSWORD` | *(generated)* | Password for that admin (passed as `WHM_HUB_ADMIN_PASSWORD` to `hub-cli.js create-admin`). |
| `HUB_SKIP_UI` | `0` | `1` skips installing/building `hub/ui`; set `serve_ui` to `false` in `hub.conf` or build later with `npm run build --prefix hub/ui`. |

Fixed in the script (not overridable): `/etc/whm`, `/var/log/whm`, service user `whmpanel`,
hub user `whmhub`, `/etc/whm-hub`, `/var/log/whm-hub`, `/var/backups/whm-hub`, hub ports 7443/7440,
Node major version 22.

### 4.3 What the installer does, step by step

1. **Prerequisites** – `apt-get update` + the package list in [§2.1](#21-operating-system-and-tools).
2. **Node.js** – installs Node 22 from NodeSource (`deb.nodesource.com/setup_22.x` or
   `rpm.nodesource.com/setup_22.x`) if `node` is missing or < 22 and `--skip-node` is not given;
   records the binary path (`NODE_BIN`) for the units.
3. **Service user** – `useradd --system --home-dir /var/lib/whm --no-create-home --shell
   /usr/sbin/nologin whmpanel` (falls back to `/sbin/nologin`).
4. **Deploy** – `rsync -a --delete` of the checkout to `/opt/whm`, excluding `node_modules`,
   `client/dist`, `hub/ui/dist`, `data` and `.git`.
5. **Build** – in `/opt/whm`: `npm ci --no-audit --no-fund`, `npm run build --workspace client`,
   `npm prune --omit=dev`. With `--with-hub`: `npm ci --omit=dev` in `hub/`, then `hub/ui` is
   installed (`npm ci` with a lockfile, `npm install` without) and built; its `node_modules` is
   removed after the build. A failed UI build is logged, not fatal.
6. **Ownership** – `/opt/whm` is `root:root`, world-unwritable.
7. **Config and data directories** – creates `/etc/whm` and `/etc/whm/ssl` (`0750 root:whmpanel`),
   `/var/lib/whm`, `/var/lib/whm/plugins` and `/var/log/whm` (`0750 whmpanel:whmpanel`); installs
   `whm.conf`, `agent.conf` and `panel.env` from `deploy/*.example` **only if missing**; appends
   `WHM_ADMIN_PASSWORD` to a new `panel.env`.
8. **License hub URL** – see `WHM_LICENSE_HUB_URL` above.
9. **Super admin setup password** – see `WHM_SUPERADMIN_SETUP_PASSWORD` above; writes
   `/var/lib/whm/superadmin.key` through `whm-cli.js superadmin --init` (no database access, so it runs
   before the first boot without creating root-owned secrets).
10. **Panel TLS** – generates `/etc/whm/ssl/panel.{crt,key}` if absent ([§4.5](#45-tls)).
11. **Hub** (`--with-hub`) – [§5.1](#51-installing-the-hub). If the hub certificate was generated in this
    run, a copy is installed as `/etc/whm/hub-ca.pem` (`0640 root:whmpanel`) and
    `WHM_LICENSE_HUB_CA=/etc/whm/hub-ca.pem` is appended to `panel.env` so the same-host panel trusts it.
12. **Units** – writes `/etc/systemd/system/whm-agentd.service` and `whm-panel.service` from
    `deploy/`, substituting the node binary, `/opt/whm` and `/var/lib/whm`; `systemctl daemon-reload`,
    `enable whm-agentd whm-panel`, `restart whm-agentd`, then `restart whm-panel`.
13. **Summary** – after 2 s, if `whm-panel` is active: prints the URL, the login, the password (from
    `initial-admin-password.txt` or "the WHM_ADMIN_PASSWORD you set"), log and firewall hints and the
    configured hub. Otherwise `whm-panel failed to start; see: journalctl -u whm-panel -n 50`.

### 4.4 What it creates

| Path | Owner / mode | Contents |
|---|---|---|
| `/opt/whm` | `root:root`, `o-w` | The application (`server/`, `agent/`, `client/dist`, `hub/`, `plugins/`, `scripts/`, `deploy/`). |
| `/etc/whm/whm.conf` | `0640 root:whmpanel` | Panel JSON config (template `deploy/whm.conf.example`: ports, TLS paths, `dataDir`, `mode: split`, `agentSocket`, `serveClient`, `clientDist`, `logLevel`, `trustProxy`, `sessionTtlMs`, `loginRateLimit`). |
| `/etc/whm/agent.conf` | `0640 root:root` | Agent JSON config: `extraAllowedRoots: []`. |
| `/etc/whm/panel.env` | `0640 root:whmpanel` | `EnvironmentFile` of `whm-panel.service`: `NODE_ENV=production`, `WHM_CONFIG=/etc/whm/whm.conf`, `WHM_MODE=split`, `WHM_DATA_DIR=/var/lib/whm`, `WHM_AGENT_SOCKET=/run/whm-agent.sock`, `WHM_SERVE_CLIENT=true`, `WHM_LOG_LEVEL=info`, plus `WHM_ADMIN_PASSWORD`, `WHM_LICENSE_HUB_URL`, `WHM_LICENSE_HUB_CA` when applicable. |
| `/etc/whm/ssl/panel.crt`, `panel.key` | `0640 root:whmpanel` | Self-signed panel certificate. |
| `/etc/whm/hub-ca.pem` | `0640 root:whmpanel` | Copy of a same-host hub's self-signed certificate (only when the installer generated it). |
| `/var/lib/whm` | `0750 whmpanel:whmpanel` | `whm.db` (+ `-wal`/`-shm`), `session.secret`, `master.key` (AES-256-GCM key for secrets at rest), `initial-admin-password.txt`, `plugins/`, `plugin-data/`, `plugin-keys/`. |
| `/var/lib/whm/superadmin.key` | `0600 root:root` | bcrypt hash of the super admin setup password (`{ "v": 1, "hash", "created_at" }`). The panel process cannot read it; only `whm-cli superadmin` does. |
| `/var/log/whm` | `0750 whmpanel:whmpanel` | Writable log directory (process output itself goes to the journal). |
| `/run/whm-agent.sock` | `0660 root:whmpanel` | Created by `whm-agentd` at start. |
| `/etc/systemd/system/whm-agentd.service` | | `User=root`, `WorkingDirectory=/opt/whm/agent`, `ExecStart=<node> /opt/whm/agent/src/index.js`, env `WHM_AGENT_SOCKET`, `WHM_AGENT_GROUP=whmpanel`, `WHM_AGENT_CONFIG=/etc/whm/agent.conf`, `Restart=always`. |
| `/etc/systemd/system/whm-panel.service` | | `User=whmpanel`, `Requires=whm-agentd.service`, `EnvironmentFile=/etc/whm/panel.env`, `ExecStart=<node> /opt/whm/server/src/index.js`, hardening (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths=/var/lib/whm /var/log/whm`, `ReadOnlyPaths=/etc/whm /opt/whm`). |

### 4.5 TLS

`self_signed_cert` in the installer runs
`openssl req -x509 -newkey rsa:2048 -nodes -days 1095 -subj "/CN=<hostname -f>" -addext "subjectAltName=DNS:<host>,IP:<first IP>"`
and writes `panel.crt`/`panel.key` (`0640 root:whmpanel`) once; an existing certificate is never
overwritten. The panel opens HTTPS 2087 because `whm.conf` points `tlsCert`/`tlsKey` at these files
(`WHM_TLS_CERT`/`WHM_TLS_KEY` override them). Replace the pair with a CA-issued one from the panel
under *SSL/TLS › Manage Service SSL Certificates*, or by overwriting the two files and restarting
`whm-panel`. Session cookies are marked `secure` whenever TLS is on (`server/src/app.js`).

Browsers warn about the self-signed certificate until it is replaced; HTTP on 2086 stays available.

### 4.6 Post-install checks

```bash
systemctl status whm-agentd whm-panel            # both active
journalctl -u whm-panel -u whm-agentd -f         # "whm-agentd listening", "WHM panel listening (https)" / "(http)"
ls -l /run/whm-agent.sock                        # srw-rw---- root whmpanel
curl -k https://127.0.0.1:2087/api/auth/csrf     # {"data":{"csrfToken":"…"}}
sudo node /opt/whm/scripts/whm-cli.js status     # panel/agent state and counts (reads /etc/whm/whm.conf)
```

A line `whm-agentd is not reachable; privileged operations will fail until it starts` in the panel log
means the socket could not be opened (see [§8](#8-troubleshooting)).

### 4.7 First login

1. Open `https://<server-ip>:2087/` (or `http://…:2086/`). Accept the self-signed certificate.
2. Log in as **`root`** with the password the installer printed — generated ones are in
   `/var/lib/whm/initial-admin-password.txt` (`awk '/^password:/{print $2}' …`). With
   `WHM_ADMIN_PASSWORD` the file does not exist.
3. A generated password is flagged *must change*: the panel sends you to **Change password** first.
   Then delete `initial-admin-password.txt`.
4. Enrol TOTP under *Security Center › Two-Factor Authentication* (required once
   `security.2fa.required_for_root` is enabled there).
5. **Make yourself the super admin.** The super admin is the one root user who owns the panel: only
   that user sees the license hub address, the license key, the activations and the hub answers, and
   only that user can activate, transfer, check in or deactivate the license. Every other root user
   gets a *Licensed — managed by the panel owner* card (status, edition, expiry) and `403
   superadmin_required` on the license API. The flag is never set from the web interface:
   ```bash
   sudo node /opt/whm/scripts/whm-cli.js superadmin root      # asks for the setup password
   sudo node /opt/whm/scripts/whm-cli.js superadmin --revoke root
   ```
   The command verifies the password against `/var/lib/whm/superadmin.key` (bcrypt) and refuses
   otherwise; without the file it explains how to create it: `whm-cli superadmin --init` (prompts twice,
   or reads `WHM_SUPERADMIN_SETUP_PASSWORD`; replacing an existing key needs the current password).
   Grants and revocations are audited (`auth.superadmin.grant` / `.revoke`, principal `whm-cli`).
6. As the super admin, enter the license key under *Server Configuration › Basic WebHost Manager
   Setup › License* ([§5.5](#55-connecting-a-panel-to-the-hub)). The hub is
   `https://licserver.hostingsignal.in` unless `WHM_LICENSE_HUB_URL` says otherwise.

Lost password later: `sudo node /opt/whm/scripts/whm-cli.js reset-password root` (prompts without echo
when the password is omitted). Other commands: `create-admin <user> [pw]`, `list-users` (shows the
`superadmin` column), `unlock-ip <ip>` (removes cPHulk blocks), `status` (reports `superadmins` and
whether `superadmin.key` exists), `superadmin --init | <user> | --revoke <user>`.

---

## 5. The hub: license server and marketplace

Run a hub only if you resell the panel. One Node process (`hub/src/index.js`) serves both the license
API and the marketplace, backed by `license.db` and `marketplace.db` (SQLite, migrations in
`hub/license/migrations/` and `hub/marketplace/migrations/`) and the portal SPA from `hub/ui/dist`.

### 5.1 Installing the hub

```bash
sudo bash scripts/install.sh --with-hub                                   # panel + hub on this host
sudo HUB_PUBLIC_URL=https://hub.example.com:7443 HUB_ADMIN_EMAIL=you@example.com \
     bash scripts/install.sh --with-hub                                   # public URL + first portal admin
```

`install_hub` in the script:

1. Creates the `whmhub` system user (home `/var/lib/whm-hub`, nologin).
2. Creates `/etc/whm-hub` and `/etc/whm-hub/ssl` (`0750 root:whmhub`), `/etc/whm-hub/keys`
   (`0700 whmhub`), `/var/lib/whm-hub`, `/var/lib/whm-hub/packages`, `/var/log/whm-hub` and
   `/var/backups/whm-hub` (`0750 whmhub`).
3. Installs `/etc/whm-hub/hub.conf` from `deploy/hub.conf.example` **if missing** and, for a new file
   only, sets `public_url`, `db_dir`, `tls.cert`/`tls.key`, `keys.dir`, `marketplace.packages_dir`,
   `marketplace.download_hmac_file`, `marketplace.public_suffix_list` and `license.backup_dir` to the
   paths above (values are set with Node, never interpolated into the JSON).
4. Writes `/etc/whm-hub/hub.env` **if missing** ([§5.7](#57-hubenv-and-secrets)).
5. Generates a self-signed `/etc/whm-hub/ssl/hub.{crt,key}` if absent (same `openssl` call as the
   panel, owner group `whmhub`).
6. Generates keys with `hub/scripts/gen-key.js --config /etc/whm-hub/hub.conf` if absent:
   `--master` → `/etc/whm-hub/master.key`; `--hmac` → `/etc/whm-hub/keys/download.hmac`; and, when no
   `*.ed25519` exists yet, `--license --json` and `--plugin --json` (the first key of each purpose becomes
   **active**), recording their kids in `hub.conf` `keys.active_kid.{license,plugin}` (informational;
   the `signing_keys` table is authoritative). Everything is handed to `whmhub` afterwards
   (`master.key` and `keys/*` `0600`, `keys/` `0700`).
7. Writes `/etc/systemd/system/whm-hub.service` from `deploy/whm-hub.service` (node binary,
   `/opt/whm`, data and backup directories substituted; `User=whmhub`, `EnvironmentFile=/etc/whm-hub/hub.env`,
   `ReadWritePaths=` data, log, backup dirs and `/etc/whm-hub/keys`; `ReadOnlyPaths=/etc/whm-hub /opt/whm`),
   enables and restarts it.
8. With `HUB_ADMIN_EMAIL` (first install only): `hub-cli.js create-admin <email> --json`.

The summary prints the hub URL, config/key/data locations, the firewall rule (`allow TCP 7443`,
never 7440), the generated **license** key as a ready-to-pin JSON entry, the plugin key kid, the
portal admin credentials (or the `create-admin` command) and the `issue` command for a first license.

Validate an installed configuration at any time:

```bash
sudo WHM_HUB_CONFIG=/etc/whm-hub/hub.conf node /opt/whm/hub/src/index.js --check-config
```

It boots against temporary databases with ephemeral keys and answers `/healthz` (exit 0 on 200).
It is not side-effect free: the marketplace module creates `marketplace.packages_dir` from the file
being checked, so run it against the installed `hub.conf`, not against the template.

### 5.2 Keys: what gen-key.js generates and what to pin where

`node hub/scripts/gen-key.js <mode> [--config <hub.conf>] [--dir <keys dir>] [--db-dir <dir>] [--json] [--out <file>] [--force]`

| Mode | Writes | Purpose | Pin where |
|---|---|---|---|
| `--master` | `master_key_file` (default `/etc/whm-hub/master.key`, `0600`), 32 random bytes as hex | AES-256-GCM key for every secret the hub stores (billing secrets, job results, encrypted OAuth secret). Refuses to overwrite without `--force` (which makes every stored secret unreadable). If the hub starts without one it generates `<db_dir>/master.key` and logs a warning. | Nowhere; back it up offline. |
| `--hmac` | `<keys.dir>/download.hmac` (32 random bytes, `0600`) | HMAC key for the single-use signed package download URLs (`marketplace.download_url_ttl_s`). `--force` to replace (existing URLs stop verifying). | Nowhere. |
| `--license [--activate]` | `<keys.dir>/<kid>.ed25519` (`0600`) + a `signing_keys` row in `license.db` with `purpose = license` | Signs license tokens (`WHMT1.<payload>.<sig>`) **and every hub response a panel acts on**. The first license key is activated automatically; later ones stay `pending` until `hub-cli.js activate-key <kid>` or `POST /v1/admin/signing-keys/:kid/activate`. | **Every panel release that must trust this hub**: add `{ "kid", "pub", "not_after": null }` to `server/src/services/license-keys.json` (shape `{ "keys": [ … ] }`), or point a panel at a file of the same shape with `WHM_LICENSE_KEYS_FILE`. Panels verify tokens and hub answers **only** against that set (`loadLicenseKeys` in `server/src/services/license.js`); an online key list cannot add trust. |
| `--plugin [--activate]` | same, `purpose = plugin` | Signs `SIGNATURE.json` of approved marketplace packages. | **No manual step**: panels receive `plugin_signing_keys` inside their license-signed activation and check-in answers and write them to `$WHM_DATA_DIR/plugin-keys/<kid>.pub`. |

`kid` = first 8 hex characters of `sha256(raw 32-byte Ed25519 public key)` (`kidOf()`); the panel
skips a pinned entry whose kid does not match its key. The repository ships two **placeholder** license
keys in `license-keys.json` that have no private half: replace them with your hub's `{ kid, pub }`
before building a release, otherwise activation can never verify.

Rotation (README): ship a new license key in a panel release first, activate it on the hub later,
keep the old key `retiring` for at least twice `license.token_ttl_hours`, then retire it. Private keys
never leave `/etc/whm-hub/keys/`. Operator-signed plugins you distribute yourself use the same
`plugin-keys/<kid>.pub` directory on each panel (see [`plugins/SDK.md`](../plugins/SDK.md) and
`scripts/build-plugin.js --sign key.pem`).

### 5.3 The first vendor admin

```bash
cd /opt/whm/hub
sudo WHM_HUB_CONFIG=/etc/whm-hub/hub.conf node scripts/hub-cli.js create-admin you@example.com
# → { "id": "…", "email": "you@example.com", "role": "vendor_admin", "password": "<generated>" }
```

`create-admin <email> [--password <pw>] [--role <role>]` creates a portal user (default role
`vendor_admin`); the password comes from `--password`, `WHM_HUB_ADMIN_PASSWORD` or is generated (20
characters) and printed once. `hub-cli.js` boots the hub services in-process, so run it as root (or
`whmhub`) with `WHM_HUB_CONFIG` (or `--config`) pointing at the installed config; options `--db-dir`,
`--keys-dir`, `--json`. After a CLI run as root, restore ownership:
`chown -R whmhub:whmhub /var/lib/whm-hub` (the installer does this itself).

Log in at `https://<hub>/login` (`POST /v1/portal/login { email, password, totp? }`). **The first
login of an admin lands on the enrolment page:** `hub.require_totp_for_admins` (a vendor setting, on
by default) makes every `vendor_admin` and `reseller_admin` enrol an authenticator app (QR code,
secret and `otpauth://` URI under *Security › Two-factor authentication*, `POST /v1/portal/2fa/enroll`
→ `/confirm`) before anything outside `/v1/portal/*` answers (`403 totp_enrol_required`; the login
answer and `/v1/portal/me` carry `totp_enrol_required: true`). Once enabled, login asks for the code
(`401 totp_required` without it), sensitive actions re-prompt for a fresh one (step-up,
`license.stepup_max_age_s`), and five wrong codes pause the account's TOTP for 15 minutes
(`429 totp_rate_limited`). Support and staff roles may enrol voluntarily; a stepped-up vendor admin can
switch the rule off and on under *Admin › Security › Portal policy* (`GET/PATCH /v1/portal/settings`),
which applies to open sessions at once. API keys are unaffected. Developers already enrol the same
way on the developer portal.

### 5.4 Issuing the first license

From the CLI:

```bash
cd /opt/whm/hub
sudo WHM_HUB_CONFIG=/etc/whm-hub/hub.conf node scripts/hub-cli.js issue whm-pro-annual customer@example.com --months 12
# → { "license_id": "lic_…", "key": "WHM-XXXX-XXXX-XXXX-XXXX", "edition": "pro", "expires_at": "…", "max_activations": N }
```

`issue <sku> <email> [--months N] [--name <customer name>]` prints the key **once**. SKUs seeded by
`hub/license/migrations/001_license.sql`: `whm-trial`, `whm-solo-monthly`, `whm-solo-annual`,
`whm-pro-monthly`, `whm-pro-annual`, `whm-reseller-annual-5`, `whm-enterprise` (editions trial, solo,
pro, reseller, enterprise). Other CLI commands: `revoke <license_id> [--reason text]`,
`status` (health, keys, schedules) / `status <lic_id | WHM-XXXX prefix>`, `activate-key <kid>`.

From the portal: *Admin › Licenses* (`/admin/licenses`; API `POST /v1/admin/licenses`, bulk
`POST /v1/admin/licenses/bulk`, then `renew`, `change-edition`, `suspend`, `unsuspend`, `revoke`,
`rekey`, per-activation `deactivate`). Resellers issue within quota through the reseller portal or
`POST /v1/reseller/licenses`.

### 5.5 Connecting a panel to the hub

1. **Tell the panel where the hub is.** The panel defaults to the vendor hub
   `https://licserver.hostingsignal.in`; `WHM_LICENSE_HUB_URL=https://hub.example.com:7443` in
   `/etc/whm/panel.env` (the installer writes it from the variable, the local hub, or the prompt)
   points it elsewhere — it must be `https://`. This is only the **bootstrap** address used to activate,
   start a trial or recover; once a token exists the panel talks to the hub named in the token's `iss`
   (`hubUrl()` in `services/license.js`). The address is shown only to the super admin
   ([§4.7](#47-first-login)); every other root user sees the restricted license card and
   `403 superadmin_required` on the license routes.
2. **Trust the hub's certificate.** Panels speak HTTPS only. For a self-signed hub set
   `WHM_LICENSE_HUB_CA=/etc/whm/hub-ca.pem` to a copy of `hub.crt` readable by `whmpanel` (done by
   the installer for a same-host hub it generated the certificate for). A CA-issued certificate needs
   nothing.
3. **Pin the license key** in the panel release (`server/src/services/license-keys.json`) or with
   `WHM_LICENSE_KEYS_FILE=/etc/whm/license-keys.json` ([§5.2](#52-keys-what-gen-keyjs-generates-and-what-to-pin-where)).
   Without a usable key the panel logs `no usable license keys are pinned; activation is impossible`.
4. **Restart** `whm-panel`, then, as the super admin, open *Server Configuration › Basic WebHost
   Manager Setup › License* (`/server-configuration/basic-webhost-manager-setup#license`). The tab
   shows the status, hub, edition, limits and features, and offers:
   - **Activate with a license key** — enter `WHM-XXXX-XXXX-XXXX-XXXX` (`POST /api/license/key`). If the
     license has no free activation, a *Transfer* dialog lists the other servers; transferring puts the
     other server into read-only mode at its next check-in.
   - **Start free trial** — e-mail only (`POST /api/license/trial` → hub `POST /v1/trial`):
     `license.trial_days` = 14 days, one trial per server fingerprint and per e-mail; refused with
     `409 already_licensed` while a token exists. Converting the trial on the hub
     (`POST /v1/admin/trials/:id/convert { sku }` or the portal) keeps the activation.
   - **Check in now**, **Deactivate this server**, activations list, and a link to the vendor portal.
5. **Check-ins** run every `WHM_LICENSE_CHECKIN_HOURS` (default 12; the hub's
   `license.checkin_interval_hours` is told to the panel at activation). Activation binds the key to a
   server fingerprint (machine-id, default-route MAC, root filesystem UUID).
6. **Enforcement.** With `WHM_LICENSE_ENFORCE=true` (the default under `NODE_ENV=production`) a lapsed,
   revoked or unverifiable license puts the panel into **read-only degraded mode**: mutations answer
   `423 license_degraded`, GETs and the rescue allow-list keep working, and customer sites, mail and
   databases are never touched. Edition feature gates answer `403 feature_required`. In development the
   gates are off unless you set the variable.

The marketplace is a separate switch: enable the `whm-hub` row under *Market › Market Provider
Manager* (it holds no key; it answers `hub_mismatch` if its origin differs from the license hub), then
install plugins from *HST Panel › Manage Plugins › Marketplace* or *Server Configuration › WHM Marketplace*.

Development hub next to a development panel:

```bash
# hub: a throw-away config with a self-signed cert and keys
mkdir -p /tmp/hubdev/keys && cd /tmp/hubdev && openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=localhost -keyout hub.key -out hub.crt
cat > hub.conf <<'EOF'
{ "public_url": "https://localhost:7443", "db_dir": "/tmp/hubdev", "master_key_file": "/tmp/hubdev/master.key",
  "tls": { "cert": "/tmp/hubdev/hub.crt", "key": "/tmp/hubdev/hub.key" }, "keys": { "dir": "/tmp/hubdev/keys" },
  "license": { "mail": { "transport": "none" }, "backup_dir": null } }
EOF
cd /home/user/whm/hub
node scripts/gen-key.js --config /tmp/hubdev/hub.conf --master
node scripts/gen-key.js --config /tmp/hubdev/hub.conf --hmac
node scripts/gen-key.js --config /tmp/hubdev/hub.conf --license --json   # copy { kid, pub } into a keys file
node scripts/gen-key.js --config /tmp/hubdev/hub.conf --plugin
WHM_HUB_CONFIG=/tmp/hubdev/hub.conf npm start                            # or from the repo root: WHM_HUB_CONFIG=… npm run hub
# panel
WHM_LICENSE_HUB_URL=https://localhost:7443 WHM_LICENSE_KEYS_FILE=/tmp/hubdev/license-keys.json \
WHM_LICENSE_HUB_CA=/tmp/hubdev/hub.crt npm run dev
```

(`license-keys.json` there is `{ "keys": [ { "kid": "…", "pub": "<PEM from gen-key>", "not_after": null } ] }`.)

### 5.6 hub.conf reference

`/etc/whm-hub/hub.conf` is JSON (no comments; template [`deploy/hub.conf.example`](../deploy/hub.conf.example)),
validated by the zod schema in `hub/src/config.js`; the `marketplace` section is validated by
`marketplaceConfigSchema` in `hub/marketplace/index.js`. Precedence: config file → `WHM_HUB_*`
environment (deep-merged on top) → defaults. An invalid file aborts with
`invalid hub configuration: <key>: <message>`. The file location is `WHM_HUB_CONFIG` (default
`/etc/whm-hub/hub.conf`).

| Key | Default | Meaning |
|---|---|---|
| `public_url` | `https://licserver.hostingsignal.in` | URL panels and portals use; `iss` of every token. The installer writes `HUB_PUBLIC_URL` (default `https://<hostname -f>:7443`) into a new hub.conf. |
| `serve_ui` | `false` (template: `true`) | Serve `hub/ui/dist` at `/` with SPA fallback for `/login`, `/admin/*`, `/reseller/*`, `/dev/*`. Logs `serve_ui is set but hub/ui/dist is missing` when the build is absent. |
| `ui_dist` | *(unset)* | Alternative build directory. The server reads the `WHM_HUB_UI_DIST` environment variable for this (`uiDistDir()` in `hub/src/app.js`). |
| `host` | `0.0.0.0` | Bind address. |
| `port` | `7443` | Public listener (1–65535). |
| `loopback_port` | `7440` | `127.0.0.1` listener for `/healthz` and `/metrics`; `0` disables it. |
| `trust_proxy` | `"loopback"` | Express `trust proxy` (boolean, string or number). |
| `log_level` | `info` | pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. |
| `db_dir` | `/var/lib/whm-hub` | `license.db`, `marketplace.db`, generated `session.secret`, fallback `master.key`. |
| `master_key_file` | `/etc/whm-hub/master.key` | Hex AES-256 key from `gen-key.js --master`. |
| `master_key` | *(unset)* | 64-hex key inline (tests only). |
| `session_secret` | generated into `<db_dir>/session.secret` | Portal session secret (min 16 chars). |
| `cookie_secure` | *(auto)* | Force the portal cookie `secure` flag. |
| `insecure_http` | `false` | Listen on plain HTTP when `tls` is null — only behind a TLS-terminating proxy. Otherwise the hub refuses to start: `TLS is required`. |
| `tls.cert` / `tls.key` | `null` (required unless `insecure_http`) | PEM pair for the public listener; both or neither (a half pair is treated as null). |
| `keys.dir` | `/etc/whm-hub/keys` | `<kid>.ed25519` private keys and `download.hmac`. |
| `keys.active_kid.license` / `.plugin` | `null` | 8-hex kid to promote a `pending` key when the database has no active key of that purpose; otherwise informational. |
| `license.token_ttl_hours` | `168` | Token lifetime. |
| `license.checkin_interval_hours` | `12` | Check-in interval told to panels. |
| `license.default_grace_days` | `7` | Grace after expiry. |
| `license.trial_days` | `14` | Trial length. |
| `license.reclaim_days` | `30` | An activation silent this long may be reclaimed. |
| `license.reactivation_limit` | `{ "count": 3, "days": 30 }` | Re-activations per license per window. |
| `license.nonce_ttl_s` | `600` | Replay-cache TTL; must be ≥ 2 × `max_skew_s`. |
| `license.max_skew_s` | `300` | Accepted clock skew. |
| `license.session_ttl_hours` | `12` | Portal session lifetime. |
| `license.stepup_max_age_s` | `300` | TOTP step-up freshness (min 30). |
| `license.checkin_retention_days` | `90` | `checkins` rows pruned after this. |
| `license.lookup_block` | `{ "failures": 20, "windowMs": 3600000, "blockMs": 86400000 }` | Failed key lookups per IP before a block. |
| `license.backup_dir` | `/var/backups/whm-hub` | Hourly `license.db` backup target; `null` disables. |
| `license.backup_keep` | `48` | Backups kept. |
| `license.mail.from` | `whm-hub@localhost` | Sender. |
| `license.mail.enabled` | `true` | Outbound mail on/off. |
| `license.mail.transport` | `sendmail` | `sendmail` or `none` (records only). |
| `license.billing.stripe.secret`, `.whmcs.secret`, `.paddle.secret` | *(unset)* | Inbound webhook secrets — prefer `hub.env`. |
| `license.rate_limits.<group>` | `activate` 10/h, `checkin` 12/h, `trial` 3/24 h, `recover` 3/h, `reseller` 600/h, `admin` 1200/h, `portal_login` 10/15 min, `public` 600/h | `{ "max", "windowMs" }` per route group (windowMs ≥ 1000). |
| `license.vendor.name` | `WHM Vendor` | Shown in mails and panel messages. |
| `license.vendor.support_email`, `.portal_url` | *(unset)* | Optional contact and portal link. |
| `marketplace.packages_dir` | `<db_dir>/packages` | Signed `.whmplugin` store. |
| `marketplace.max_package_bytes` | `20971520` | Upload limit (min 1024). |
| `marketplace.download_url_ttl_s` | `900` | Signed download URL lifetime (min 60). |
| `marketplace.download_hmac_file` | `<keys.dir>/download.hmac` | From `gen-key.js --hmac`. |
| `marketplace.scan.av_command` | `null` | Optional AV argv, e.g. `["clamscan", "--no-summary"]`. |
| `marketplace.review.require_two_reviewers_for_high_risk` | `true` | Second reviewer for high-risk scopes. |
| `marketplace.revenue_share_pct` | `70` | 0–100. |
| `marketplace.payout_min_cents` | `5000` | Minimum payout. |
| `marketplace.currencies` | `["USD", "EUR"]` | Three-letter codes, at least one. |
| `marketplace.github_oauth` | `null` | `{ client_id, client_secret \| client_secret_enc, redirect_url }`; absent → the GitHub verification method answers `501 github_not_configured`. No environment variable exists for it. |
| `marketplace.public_suffix_list` | `<db_dir>/public_suffix_list.dat` | Refreshed weekly (`psl-refresh`); `hub/shared/psl.dat` is the fallback. |
| `marketplace.reserved_namespaces`, `.reserved_brands` | `[]` | Added to the built-in reserved list. |
| `marketplace.bundled_ids` | directory names under `plugins/bundled/` | Plugin ids reserved for bundled plugins. |
| `marketplace.host_api_versions` | `["1.0.0"]` | Host API versions a submission's `engines.whm` must intersect. |
| `marketplace.evidence_purge_days` | `30` | ID documents deleted this long after a decision. |
| `marketplace.session_ttl_hours` / `.stepup_max_age_s` | `12` / `300` | Developer portal sessions. |
| `marketplace.disposable_domains` | `mailinator.com`, `guerrillamail.com`, `10minutemail.com`, `tempmail.com`, `yopmail.com`, `trashmail.com` | Rejected registration e-mail domains. |
| `marketplace.rate_limits.<group>` | `register` 5/24 h, `upload` 10/24 h, `recheck` 5/h, `verification` 10/24 h, `download` 60/h, `feed` 30/h, `catalog` 600/h, `dev_login` 30/15 min | `{ "max", "windowMs" }`. |

Scheduled hub jobs (`hub/shared/scheduler.js`, `hub/marketplace/jobs.js`): `expire-licenses` (`5 * * * *`),
`expiring-reminders`, `stale-activations`, `trial-expiry`, `webhook-retry`, `nonce-prune`, `checkin-prune`,
`db-backup` (`50 * * * *`), `scan-queue`, `verification-rechecks`, `reverify-due`, `payouts-close`,
`evidence-purge`, `download-purge`, `resign-packages`, `psl-refresh`, `entitlement-expiry`,
`market-housekeeping`.

### 5.7 hub.env and secrets

`/etc/whm-hub/hub.env` (`0640 root:whmhub`) is the unit's `EnvironmentFile`. The installer writes:

```
NODE_ENV=production
WHM_HUB_CONFIG=/etc/whm-hub/hub.conf
WHM_HUB_DB_DIR=/var/lib/whm-hub
WHM_HUB_LOG_LEVEL=info
# WHM_HUB_STRIPE_SECRET=
# WHM_HUB_WHMCS_SECRET=
# WHM_HUB_PADDLE_SECRET=
```

Billing webhook secrets belong here, not in `hub.conf`. Any `WHM_HUB_*` key from
[§7.3](#73-hub-whm_hub_-variables) can be added; `hub.env` overrides `hub.conf`. The GitHub OAuth client
secret is the exception: it goes into `hub.conf` as `marketplace.github_oauth.client_secret` (or
`client_secret_enc`, pre-encrypted with the master key). Secrets at rest: `master.key` (`0600 whmhub`)
and `keys/*` (`0600`, directory `0700`). `--upgrade` never rewrites `hub.env`, `hub.conf`, keys or
certificates.

---

## 6. Upgrades, backups and uninstall

### 6.1 Upgrading

```bash
cd /path/to/whm && git pull            # or unpack the new release
sudo bash scripts/install.sh --upgrade
```

What happens: the checkout is rsync'ed over `/opt/whm` (`--delete`, excluding `node_modules`,
`client/dist`, `hub/ui/dist`, `data`, `.git`), dependencies are reinstalled and the UI rebuilt, the
units are rewritten and the services restarted. An installed hub is upgraded in the same run.

**Preserved** (never rewritten once present): `/etc/whm/whm.conf`, `agent.conf`, `panel.env` (including
`WHM_LICENSE_HUB_URL`/`WHM_LICENSE_HUB_CA`), `/etc/whm/ssl/*`, `/var/lib/whm` (database, keys, plugins),
`/etc/whm-hub/hub.conf`, `hub.env`, `master.key`, `keys/`, `ssl/`, `/var/lib/whm-hub`. For the hub, the
data and backup directories are read back from `hub.env`/`hub.conf` so `HUB_DATA_DIR` need not be
repeated; a *different* `HUB_DATA_DIR` aborts before anything is touched. Only an explicit
`HUB_PUBLIC_URL` updates `public_url`. The installer does not ask for a hub URL on `--upgrade`.

**Migrations** run automatically at the next boot. The panel's runner (`server/src/db/index.js`)
records applied files in `schema_migrations` and applies every not-yet-applied `*.sql` from
`server/src/db/migrations/` in sorted order; the hub does the same for `hub/license/migrations/` and
`hub/marketplace/migrations/` (`hub/shared/db.js`). Migrations are immutable once released; fixes ship as
`0NNb_*.sql` files. Take a backup before upgrading.

Moving the hub data directory by hand: stop `whm-hub`, move the directory, edit `WHM_HUB_DB_DIR` in
`hub.env` and `db_dir`, `marketplace.packages_dir`, `marketplace.public_suffix_list` in `hub.conf`, then
run `--upgrade` so the unit's `ReadWritePaths` follow.

### 6.2 Backing up the panel

Everything the panel owns is under the data directory and `/etc/whm`:

| What | Where | Note |
|---|---|---|
| Database | `/var/lib/whm/whm.db` (+ `whm.db-wal`, `whm.db-shm`) | SQLite in WAL mode. Copy it with `sqlite3 /var/lib/whm/whm.db ".backup /root/whm-$(date +%F).db"`, or stop `whm-panel` and copy all three files. |
| Secrets | `/var/lib/whm/master.key`, `session.secret` | `master.key` decrypts every secret in the database (AES-256-GCM); without it a restored database has unreadable credentials. Back it up with the database, protect it. |
| Plugins | `/var/lib/whm/plugins/`, `plugin-data/`, `plugin-keys/` | Installed packages, their data, pinned public keys. |
| Config | `/etc/whm/` | `whm.conf`, `agent.conf`, `panel.env`, `ssl/`, `hub-ca.pem`. |

Restore: install the same release, stop `whm-panel`, put the files back with owner `whmpanel:whmpanel`
(`/var/lib/whm`) and `root:whmpanel` (`/etc/whm`), start the service. Hosted accounts (home
directories, vhosts, zones, mailboxes, databases) live on the host, not in the panel; use the Backup
category and the Automated Backup plugin for those.

### 6.3 Backing up the hub

- **`license.db`** is backed up by the hub itself: the `db-backup` job runs every hour at minute 50
  (`LICENSE_SCHEDULES`), writes `<license.backup_dir>/license-<timestamp>.db` with SQLite's online
  `.backup`, and keeps the newest `license.backup_keep` (48) files. `backup_dir: null` disables it.
- **`marketplace.db`** and **`packages/`** (under `db_dir`) have no scheduled backup in the code: copy
  them yourself (`sqlite3 … ".backup"` for the database; the package store is plain files).
- **`/etc/whm-hub`**: `hub.conf`, `hub.env`, `master.key` and `keys/*.ed25519` + `download.hmac`.
  The design (`design/license-server.md`) calls for the signing keys to be backed up separately,
  offline and encrypted: losing the active license key means every panel release that pins it can no
  longer verify a new hub; losing `master.key` makes stored secrets unreadable.
- Ship the backup directory off-host (the hub does not upload it).

### 6.4 Uninstalling

There is no uninstall script. Reverse what `install.sh` created (this removes the panel and the hub
only; Linux accounts, vhosts, zones and mail created through the panel stay on the host):

```bash
sudo systemctl disable --now whm-panel whm-agentd
sudo rm -f /etc/systemd/system/whm-panel.service /etc/systemd/system/whm-agentd.service
sudo systemctl daemon-reload
sudo rm -rf /opt/whm /etc/whm /var/lib/whm /var/log/whm /run/whm-agent.sock
sudo userdel whmpanel

# hub, if installed
sudo systemctl disable --now whm-hub
sudo rm -f /etc/systemd/system/whm-hub.service
sudo systemctl daemon-reload
sudo rm -rf /etc/whm-hub /var/lib/whm-hub /var/log/whm-hub /var/backups/whm-hub
sudo userdel whmhub
```

Deactivate the panel's license first (*License › Deactivate this server*) so the activation is
released for another server.

---

## 7. Configuration reference

### 7.1 Panel: WHM_* variables and whm.conf keys

Precedence (`loadConfig()` in `server/src/config.js`): environment variables → config file
(`WHM_CONFIG`, else `/etc/whm/whm.conf`, else `./whm.conf.json` in the working directory) → defaults.
`isProd` below means `NODE_ENV=production`.

| Variable | `whm.conf` key | Default | Meaning |
|---|---|---|---|
| `NODE_ENV` | `env` | `development` | `production` switches the defaults of `dataDir`, `serveClient` and `licenseEnforce`. |
| `WHM_CONFIG` | — | `/etc/whm/whm.conf` | Path of the JSON config file. |
| `WHM_HOST` | `host` | `0.0.0.0` | Bind address for both listeners. |
| `WHM_PORT` | `port` | `2086` | HTTP port. |
| `WHM_TLS_PORT` | `tlsPort` | `2087` | HTTPS port (only with cert + key). |
| `WHM_TLS_CERT` | `tlsCert` | `null` | PEM certificate; HTTPS is enabled when both cert and key are set. |
| `WHM_TLS_KEY` | `tlsKey` | `null` | PEM private key. |
| `WHM_DATA_DIR` | `dataDir` | `/var/lib/whm` (prod) / `./data` (dev, relative to cwd) | Data directory: `whm.db`, `session.secret`, `master.key`, plugin dirs. Created `0750` at boot. |
| `WHM_MODE` | `mode` | `monolithic` | `split` or `monolithic` ([§1.2](#12-deployment-modes-split-and-monolithic)). |
| `WHM_AGENT_SOCKET` | `agentSocket` | `/run/whm-agent.sock` | Agent socket path (split mode). |
| `WHM_ADMIN_PASSWORD` | `adminPassword` | `null` | Initial root password on first boot; otherwise generated into `initial-admin-password.txt`. |
| `WHM_SESSION_SECRET` | `sessionSecret` | generated into `<dataDir>/session.secret` | Session cookie signing secret. |
| `WHM_LOG_LEVEL` | `logLevel` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `WHM_SERVE_CLIENT` | `serveClient` | `true` in prod, `false` otherwise | Serve the built SPA from `clientDist` (`'true'` to enable). |
| `WHM_CLIENT_DIST` | `clientDist` | `<repo>/client/dist` | Built SPA directory. |
| `WHM_PLUGINS_DIR` | `pluginsDir` | `<dataDir>/plugins` | Installed plugin packages. |
| `WHM_PLUGIN_DATA_DIR` | `pluginDataDir` | `<dataDir>/plugin-data` | Per-plugin sandboxed data. |
| `WHM_PLUGIN_HOOK_TIMEOUT_MS` | `pluginHookTimeoutMs` | `30000` | Plugin hook timeout. |
| `WHM_PLUGIN_ACTIVATE_TIMEOUT_MS` | `pluginActivateTimeoutMs` | `60000` | Plugin activation timeout. |
| `WHM_LICENSE_HUB_URL` | `licenseHubUrl` | `https://licserver.hostingsignal.in` | Bootstrap hub URL (https) for activation/trial/recovery; the token's `iss` wins afterwards. Visible to the super admin only. |
| `WHM_LICENSE_KEYS_FILE` | `licenseKeysFile` | `server/src/services/license-keys.json` | Pinned vendor LICENSE public keys (`{ "keys": [ { kid, pub, not_after } ] }`). |
| `WHM_LICENSE_HUB_CA` | `licenseHubCa` | `null` | PEM CA/certificate to trust for the hub (self-signed hubs). |
| `WHM_LICENSE_ENFORCE` | `licenseEnforce` | `true` in prod, `false` otherwise | `'true'` enables the degraded (423), feature (403) and capacity gates. |
| `WHM_LICENSE_CHECKIN_HOURS` | `licenseCheckinHours` | `12` | Check-in interval. |
| — | `sessionTtlMs` | `28800000` (8 h) | Session lifetime and cookie `maxAge`. |
| — | `loginRateLimit` | `{ "windowMs": 900000, "max": 20 }` | Login and 2FA attempts per window per IP+user. |
| — | `checkinIntervalMs` | `60000` | Defined in `config.js` but not consumed by any code in this release; setting it has no effect. |
| — | `trustProxy` | `"loopback"` | Express `trust proxy` (`server/src/app.js`). |
| — | `cookieSecure` | *(unset)* | `true` forces the `secure` cookie flag without TLS (behind a TLS proxy). |

Keys without a variable are set in `whm.conf` only (the file is merged verbatim).

### 7.2 Agent: whm-agentd variables and agent.conf

| Variable | Default | Meaning |
|---|---|---|
| `WHM_AGENT_SOCKET` | `/run/whm-agent.sock` | Socket to listen on; the parent directory is created, a stale socket file removed. |
| `WHM_AGENT_GROUP` | `whmpanel` | Group that owns the socket (`chown root:<gid>`, `chmod 0660`). If the group does not exist in `/etc/group` the chown is skipped silently and the socket stays `root:root 0660` (only root can reach it); the `whm-agentd listening` log line shows the group name it looked for. `could not set socket ownership` is logged only when chown/chmod itself fails. |
| `WHM_AGENT_CONFIG` | `/etc/whm/agent.conf` | JSON config: `{ "extraAllowedRoots": [ … ] }` appended to `DEFAULT_ALLOWED_ROOTS`. An unparsable file logs `invalid agent config, using defaults`. |

Programs are resolved in `/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin` with
`PATH` set to the same list and `LANG=LC_ALL=C` (`agent/src/exec.js`). The agent logs JSON lines to
stdout (the journal).

### 7.3 Hub: WHM_HUB_* variables

Each variable maps to a `hub.conf` key (`ENV_MAP` in `hub/src/config.js`); the default is that key's
default from [§5.6](#56-hubconf-reference). Booleans accept `1`, `true`, `yes`.

| Variable | hub.conf key |
|---|---|
| `WHM_HUB_CONFIG` | *(path of hub.conf; default `/etc/whm-hub/hub.conf`)* |
| `WHM_HUB_PUBLIC_URL` | `public_url` |
| `WHM_HUB_SERVE_UI` | `serve_ui` (bool) |
| `WHM_HUB_UI_DIST` | `ui_dist` — also read directly by the SPA server |
| `WHM_HUB_HOST` | `host` |
| `WHM_HUB_PORT` | `port` (int) |
| `WHM_HUB_LOOPBACK_PORT` | `loopback_port` (int) |
| `WHM_HUB_LOG_LEVEL` | `log_level` |
| `WHM_HUB_DB_DIR` | `db_dir` |
| `WHM_HUB_MASTER_KEY_FILE` | `master_key_file` |
| `WHM_HUB_SESSION_SECRET` | `session_secret` |
| `WHM_HUB_INSECURE_HTTP` | `insecure_http` (bool) |
| `WHM_HUB_TLS_CERT` / `WHM_HUB_TLS_KEY` | `tls.cert` / `tls.key` |
| `WHM_HUB_KEYS_DIR` | `keys.dir` |
| `WHM_HUB_ACTIVE_LICENSE_KID` / `WHM_HUB_ACTIVE_PLUGIN_KID` | `keys.active_kid.license` / `.plugin` |
| `WHM_HUB_MAIL_FROM` | `license.mail.from` |
| `WHM_HUB_STRIPE_SECRET` / `WHM_HUB_WHMCS_SECRET` / `WHM_HUB_PADDLE_SECRET` | `license.billing.{stripe,whmcs,paddle}.secret` |
| `WHM_HUB_ADMIN_PASSWORD` | *(not a config key: password for `hub-cli.js create-admin`)* |

### 7.4 Installer-only variables

`WHM_APP_DIR`, `WHM_DATA_DIR`, `WHM_ADMIN_PASSWORD`, `WHM_LICENSE_HUB_URL`, `WHM_SUPERADMIN_SETUP_PASSWORD`,
`HUB_PUBLIC_URL`, `HUB_DATA_DIR`, `HUB_ADMIN_EMAIL`, `HUB_ADMIN_PASSWORD`, `HUB_SKIP_UI` — see
[§4.2](#42-environment-overrides).

---

## 8. Troubleshooting

**`whm-agentd is not reachable; privileged operations will fail until it starts`** (panel log) or
`503 agent_unavailable` / `Cannot reach whm-agentd at /run/whm-agent.sock` on pages.
- `systemctl status whm-agentd`; `journalctl -u whm-agentd -n 50`. The agent logs
  `whm-agentd listening` with the socket, group and op count when it is up.
- `ls -l /run/whm-agent.sock` must show `srw-rw---- root whmpanel`. If it shows `root root`, the
  `whmpanel` group is missing or `WHM_AGENT_GROUP` names a group that does not exist: the agent then
  skips the chown silently (the socket stays `root:root 0660`, so the non-root panel cannot connect) and
  only the `group` field of its `whm-agentd listening` log line tells you which name it looked for.
  `could not set socket ownership` is logged only when chown/chmod itself fails. Create the
  group/user or fix the variable in the unit, then restart `whm-agentd`.
- `WHM_AGENT_SOCKET` must be identical in `panel.env` and `whm-agentd.service`.
- In **monolithic** mode there is no socket at all; `agent self-check failed` means an op failed
  in-process, usually because the API is not running as root.
- `503 timeout` is an op that exceeded its timeout (default 1 h for the socket call; each op has its
  own `exec` timeout).

**`EACCES: permission denied` on the data dir / database / `session.secret`**
- `/var/lib/whm` must be `whmpanel:whmpanel` (`0750`); `whm.db`, `-wal`, `-shm`, `master.key`,
  `session.secret` must be owned by `whmpanel` (running `whm-cli.js` or the server as root once can
  leave root-owned files: `chown -R whmpanel:whmpanel /var/lib/whm`).
- `whm-panel.service` uses `ProtectSystem=strict`; only `ReadWritePaths=/var/lib/whm /var/log/whm`
  are writable. If you changed `WHM_DATA_DIR`, `WHM_PLUGINS_DIR` or `WHM_PLUGIN_DATA_DIR` to another
  location, add it with a drop-in (`systemctl edit whm-panel` → `[Service] ReadWritePaths=/new/path`).
  The same applies to the hub (`/var/lib/whm-hub`, `/var/log/whm-hub`, `/var/backups/whm-hub`,
  `/etc/whm-hub/keys`); a `packages_dir` elsewhere needs an extra `ReadWritePaths=`.
- `/etc/whm` is `0750 root:whmpanel`; `panel.env`/`whm.conf` must stay group-readable by `whmpanel`.

**`EADDRINUSE` / port in use**
- The panel binds 2086 and 2087 (only with TLS); the hub 7443 and 7440. Find the holder with
  `ss -ltnp | grep -E ':(2086|2087|7443|7440)'`. Change `WHM_PORT`/`WHM_TLS_PORT` (`panel.env` or
  `whm.conf`) or `port`/`loopback_port` in `hub.conf`, then restart. A second panel instance started by
  hand (e.g. `npm start`) while the unit runs is the usual cause.

**TLS**
- The panel starts HTTPS only when **both** `WHM_TLS_CERT` and `WHM_TLS_KEY` (or `tlsCert`/`tlsKey`)
  are set and readable by `whmpanel`; otherwise only HTTP 2086 is open. Files under `/etc/whm/ssl` are
  `0640 root:whmpanel`.
- Browser warning: the installer's certificate is self-signed (`CN=<hostname>`, 3 years). Replace it
  via *SSL/TLS › Manage Service SSL Certificates* or by overwriting `panel.crt`/`panel.key`.
- The hub refuses to start with `TLS is required: set tls.cert/tls.key in hub.conf (or insecure_http:
  true behind a TLS proxy)`.
- Panel → hub: `WHM_LICENSE_HUB_URL must start with https://` (installer) / `hub_not_configured` (API).
  A self-signed hub needs `WHM_LICENSE_HUB_CA` pointing at a copy of `hub.crt` readable by `whmpanel`;
  `cannot read WHM_LICENSE_HUB_CA` means the file is missing or unreadable. Do not pin a CA-issued hub
  certificate as a CA.
- Minimum TLS version is 1.2 for both panel and hub.

**Node version**
- `Node.js >= 22 is required (found: …)`: the installer could not install Node (no network to
  NodeSource, or `--skip-node` with an old binary). Install Node 22 yourself and re-run with
  `--skip-node`, or let the installer fetch it.
- The units hard-code the node binary found at install time (`ExecStart=<path>/node …`). After
  upgrading Node to a different path, run `install.sh --upgrade` to rewrite the units.
- `better-sqlite3` fails to build when the compiler toolchain is missing: the installer adds
  `build-essential`/`gcc-c++ make python3`; run `npm ci` again afterwards.

**Panel boots but shows an install prompt for a service**
- The daemon is absent on this host (HTTP 501, see [§2.3](#23-daemons-the-panel-manages)). Install it
  and reload the page; the capability registry is refreshed on restart. The development container
  used to build this project has no Apache/BIND/Exim/MySQL, so every such page degrades there.

**Login**
- `rate_limited` — more than 20 login/2FA attempts in 15 minutes per IP+user; wait or adjust
  `loginRateLimit` in `whm.conf`.
- cPHulk block: `sudo node /opt/whm/scripts/whm-cli.js unlock-ip <ip>`.
- Lost root password: `whm-cli.js reset-password root`.
- Stuck on 2FA: `security.2fa.required_for_root` is on and no device is enrolled; the panel only lets
  you enrol or change the password until it is.
- `403 superadmin_required` on `/api/license/*`, or the License tab says *managed by the panel owner*:
  this root user is not the super admin. Grant it with `whm-cli superadmin <user>` (needs the setup
  password; `whm-cli superadmin --init` creates `/var/lib/whm/superadmin.key` when it is missing).
- Hub portal: `403 totp_enrol_required` means `hub.require_totp_for_admins` is on and this admin has
  not confirmed an authenticator yet — finish enrolment under *Security*; `429 totp_rate_limited`
  means five wrong codes in a row, wait 15 minutes.

**License**
- `no usable license keys are pinned` — `license-keys.json` (or `WHM_LICENSE_KEYS_FILE`) has no
  valid entry whose kid matches its key; pin the hub's license key ([§5.2](#52-keys-what-gen-keyjs-generates-and-what-to-pin-where)).
- `The stored license token cannot be verified against the license keys shipped with this release` —
  the hub rotated to a key this panel does not pin; ship the key and check in again.
- `423 license_degraded` on every change — the license lapsed, was revoked, the fingerprint drifted,
  or the token cannot be verified; the panel is read-only until a valid key is activated
  (*Basic WebHost Manager Setup › License*). Set `WHM_LICENSE_ENFORCE=false` only on a panel that is
  not resold.

**Hub**
- `invalid hub configuration: …` — the schema names the key; `nonce_ttl_s must be at least 2 ×
  max_skew_s` is the one cross-field rule.
- `serve_ui is set but hub/ui/dist is missing; run npm run build --prefix hub/ui` — build the portal
  (needs dev dependencies) or set `serve_ui: false`.
- `curl -s http://127.0.0.1:7440/healthz` must report `ok: true` with both `keys.license` and
  `keys.plugin` set; `ok: false` with a null key means no active signing key of that purpose
  (`gen-key.js --license|--plugin --activate`, `hub-cli.js activate-key <kid>`). `clock: false` means
  the host clock is off by more than a day.
- `no master key found; generated one in the data directory` — `master_key_file` is unreadable by
  `whmhub`; the hub used `<db_dir>/master.key` instead. Fix the path or permissions before storing any
  secret, or stored secrets will not decrypt after the fix.
- After running `hub-cli.js` as root, `chown -R whmhub:whmhub /var/lib/whm-hub` if the service then
  fails with a permission error on `license.db`.
