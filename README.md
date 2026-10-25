# WHM — WebHost Manager control panel

A production-grade, self-hostable **WHM-compatible hosting control panel**: the complete
WHM administrative interface (30 categories, 212 functions) that manages a **real Linux
server** — Linux users and quotas, Apache/NGINX and PHP-FPM, BIND DNS, Exim/Dovecot mail,
MySQL/MariaDB, FTP, SSL/ACME, systemd services, IPs, security, backups, transfers and
resellers — built on Node.js 22, Express, React and SQLite.

- Design of record: [`BLUEPRINT.md`](BLUEPRINT.md) · Progress: [`CHECKLIST.md`](CHECKLIST.md) · Conventions: [`CLAUDE.md`](CLAUDE.md)

## Architecture in one paragraph

A React single-page app talks to an Express API (`server/`) that runs **unprivileged** as
the `whmpanel` user. Every privileged operation (create a Linux user, write a vhost, reload
BIND, …) is sent as a named, schema-validated request over a Unix socket to `whm-agentd`
(`agent/`), a small root daemon that exposes an **allowlisted catalog of operations** and
only ever runs programs with `execFile(bin, argv[])` — never a shell string. The panel keeps
its own state (accounts, packages, zones, jobs, audit log, sessions) in SQLite so it keeps
working while the managed MySQL is being restarted or repaired. Features whose daemon is
not installed degrade to a clear "service not installed" prompt instead of failing.

## Requirements

- Linux with systemd: Ubuntu 22.04/24.04, Debian 12, RHEL/AlmaLinux/Rocky 8/9
- Node.js ≥ 22 (the installer adds it from NodeSource if missing)
- Root access on the server you want to manage

## Production install

```bash
git clone https://github.com/sxi9/whm.git
cd whm
sudo bash scripts/install.sh            # add WHM_ADMIN_PASSWORD='…' to choose the first password
```

The installer deploys to `/opt/whm`, creates the `whmpanel` service user, writes
`/etc/whm/{whm.conf,agent.conf,panel.env}`, generates a self-signed certificate, and starts
two units:

| Unit | Runs as | Purpose |
|---|---|---|
| `whm-agentd.service` | root | privileged operation catalog on `/run/whm-agent.sock` |
| `whm-panel.service` | whmpanel | API + web interface on **https://server:2087** (http: 2086) |

Log in as `root` with the generated password printed by the installer (also in
`/var/lib/whm/initial-admin-password.txt` — delete it after first login). You will be asked
to change it immediately. Open TCP 2086/2087 in your firewall.

Useful commands:

```bash
journalctl -u whm-panel -u whm-agentd -f          # logs
sudo node /opt/whm/scripts/whm-cli.js status      # counts, mode, ports
sudo node /opt/whm/scripts/whm-cli.js reset-password root
sudo bash scripts/install.sh --upgrade            # redeploy a newer checkout, keep data
```

## Development

```bash
npm install
cp .env.example .env         # monolithic mode, ./data, port 2086
npm run dev                  # API with --watch on :2086 + Vite dev server on :5173 (proxies /api)
npm test                     # vitest: server + agent suites
npm run build && WHM_SERVE_CLIENT=true npm start    # production-style single process
```

In development the API runs in **monolithic mode** (the op catalog executes in-process, so
run it as root if you want account creation to really create Linux users) and the first
boot writes `data/initial-admin-password.txt`.

## Configuration

Precedence: environment variables → `/etc/whm/whm.conf` (or `WHM_CONFIG`) → defaults.
See [`.env.example`](.env.example) and [`deploy/whm.conf.example`](deploy/whm.conf.example).
Key settings: `WHM_MODE` (`split` in production, `monolithic` for dev), `WHM_DATA_DIR`,
`WHM_PORT`/`WHM_TLS_PORT`, `WHM_TLS_CERT`/`WHM_TLS_KEY`, `WHM_SERVE_CLIENT`.
The agent's writable path roots can be widened in `/etc/whm/agent.conf`.

## Security model (summary)

- Privilege separation: web tier is non-root; only `whm-agentd` touches the system, through
  a fixed op catalog with zod-validated arguments; unknown ops and bad arguments are refused.
- No shell strings anywhere; identifiers that reach `argv` are validated (no leading `-`).
- Sessions: `httpOnly`/`sameSite=strict` cookies, CSRF token on every mutation, rate limits,
  brute-force blocking (cPHulk), optional TOTP two-factor authentication.
- RBAC: `root` and `reseller` roles; resellers only see accounts they own.
- Secrets at rest encrypted (AES-256-GCM, key in the data dir); API tokens stored hashed.
- Every mutating request and every privileged action is written to the audit log with
  secrets redacted.

Full detail: [`BLUEPRINT.md`](BLUEPRINT.md) §4, §8, §10.

## Repository layout

```
server/   Express API, services, SQLite migrations, tests      agent/    whm-agentd op catalog + executor
client/   React SPA (nav.js = all 212 functions)               plugins/  plugin SDK (Phase 5)
deploy/   systemd units + config templates                      scripts/  install.sh, whm-cli.js
docs/     saved design sections                                 BLUEPRINT.md · CHECKLIST.md · CLAUDE.md
```

## Status

See [`CHECKLIST.md`](CHECKLIST.md) for the live function-by-function status and the build
phases. Licensing, the plugin marketplace and bundled plugins are scheduled for Phase 5.
