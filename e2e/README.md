# e2e — browser flows, screenshots and the live hub + panel flow

All scripts run against a panel that serves the built client (`npm run build --workspace client`,
then `WHM_SERVE_CLIENT=true`). Playwright with Chromium must be installed.

| Script | What it does |
|---|---|
| `ui-check.cjs` | Playwright flow: login → create an account through the form → core pages → search → Phase-5 pages (License tab, Manage Plugins › Marketplace, WHM Marketplace) → cleanup. `BASE=http://127.0.0.1:2086 PASSWORD='<root pw>' node e2e/ui-check.cjs` |
| `screenshot-all.cjs` | Every one of the 212 function pages plus the core pages, labelled, with gallery READMEs. |
| `screenshots.sh` | Runs both into `docs/screenshots/`. `BASE=… PASSWORD='…' bash e2e/screenshots.sh` |
| `live-hub-flow.sh` | The Phase-5 end-to-end flow against a real hub and a real panel (below). |

## Live hub + panel flow (`live-hub-flow.sh`)

Starts a `whm-hub` with freshly generated keys and a self-signed certificate, starts a panel
pointed at it, and drives both through the public, developer, admin and panel APIs:

1. hub up — `gen-key.js --master/--hmac/--license/--plugin`, `hub.conf`, TLS, `GET /healthz`,
   `GET /v1/keys`, `GET /v1/market/keys`, `hub-cli.js create-admin`; vendor admin portal login,
   TOTP enrolment, an `admin:*` API key;
2. panel up with `WHM_LICENSE_HUB_URL`, `WHM_LICENSE_HUB_CA` and `WHM_LICENSE_KEYS_FILE` (the
   hub's license public key), API login as root;
3. license — `POST /api/license/trial`, `GET /api/license` (active trial, pinned plugin-signing kid,
   `$WHM_DATA_DIR/plugin-keys/<kid>.pub`), the activation on the hub, `POST /api/license/checkin`;
4. developer publishing — `POST /v1/dev/register`, e-mail verification (the hub's `sendmail` is
   replaced by a stand-in on `PATH` that keeps every message as a file), developer TOTP, admin
   namespace reassignment of `net.whm` and developer approval, signing-key challenge, listing,
   `scripts/build-plugin.js --sign <dev key> --dev`, upload with permission justifications, admin
   review approval (the hub signs with its plugin key), developer publish, `GET /v1/market/catalog`;
5. panel marketplace — enable the `whm-hub` provider (same origin as the license hub),
   `GET /api/marketplace/catalog`, `POST /api/marketplace/install` → job `pending_consent`,
   `POST /api/marketplace/consent/:id`, `GET /api/plugins/manage` (enabled, signed by the hub kid),
   `GET /api/plugins/net.whm.sample-notes/notes`;
6. revocation — `POST /v1/admin/market/revocations` on the hub, `POST /api/marketplace/revocations/poll`
   on the panel, plugin disabled, `marketplace_revocations` row, status banner data, `409 plugin_revoked`
   on re-enable, `plugin.revoked` audit row, acknowledgement;
6b. update path — the plugin is re-enabled after the acknowledgement, a patch version with one more
   scope (`packages:read`) is built, uploaded, approved and published, `POST /api/marketplace/updates/check`
   offers it, `POST /api/marketplace/update/:id` installs it but holds the plugin disabled
   (`pending_consent`, `added: ["packages:read"]`), consent enables the new version;
7. both processes stopped (also on failure, through the pid files).

```bash
SCRATCH=/tmp/whm-live-e2e HUB_PORT=7443 HUB_LB_PORT=7440 PANEL_PORT=2088 bash e2e/live-hub-flow.sh
# KEEP_RUNNING=1 leaves the hub and the panel up after a green run (pid files in $SCRATCH),
# e.g. to take the Phase-5 screenshots against a panel with a real license and marketplace state:
KEEP_RUNNING=1 bash e2e/live-hub-flow.sh && OUT=docs/screenshots BASE=http://127.0.0.1:2088 PASSWORD='Live-E2e-Passw0rd!' bash e2e/screenshots.sh
kill "$(cat /tmp/whm-live-e2e/panel.pid)" "$(cat /tmp/whm-live-e2e/hub.pid)"
```

Every run starts from empty hub and panel data directories under `$SCRATCH` (the trial can only
be started once per server fingerprint and e-mail on a given hub). Needs `node`, `openssl`, `curl`,
`jq`; `BUILD_CLIENT=1` builds the client first. Other knobs: `PANEL_PASSWORD`, `HUB_ADMIN_EMAIL`,
`HUB_ADMIN_PASSWORD`, `DEV_EMAIL`, `DEV_PASSWORD`, `TRIAL_EMAIL`. The hub config written by the
script sets `review.require_two_reviewers_for_high_risk: false` so one admin approval signs the
sample plugin; the production default needs a second reviewer for high-risk versions.
