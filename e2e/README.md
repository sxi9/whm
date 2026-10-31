# e2e — browser flows, screenshots and the live hub + panel flow

All scripts run against a panel that serves the built client (`npm run build --workspace client`,
then `WHM_SERVE_CLIENT=true`). Playwright with Chromium must be installed.

| Script | What it does |
|---|---|
| `ui-check.cjs` | Playwright flow: login → create an account through the form → core pages → search → Phase-5 pages (License tab, Manage Plugins › Marketplace, WHM Marketplace) → Application Manager (18–20) → issue-2 pages (21–27, below) → sidebar count → cleanup. `BASE=http://127.0.0.1:2086 PASSWORD='<root pw>' node e2e/ui-check.cjs` |
| `screenshot-all.cjs` | Every one of the 212 function pages plus the core pages, labelled, with gallery READMEs. |
| `screenshots.sh` | Runs both into `docs/screenshots/`. `BASE=… PASSWORD='…' bash e2e/screenshots.sh` |
| `live-hub-flow.sh` | The Phase-5 end-to-end flow against a real hub and a real panel (below). |

## `ui-check.cjs` steps 21–27 (issue-2 round)

Each step waits for an element that exists on a host without the daemons (the card itself, or the
install prompt a page shows instead of an action), takes a labelled shot and must add no page,
console or 5xx error:

| Shot | Page | Waits for |
|---|---|---|
| `21-modify-account-domains` | `/account-functions/modify-an-account?username=demo<suffix>` (the account the flow created; `AccountPicker` reads `?username=`) | the Domains panel (`.domains-panel h3`) with its rows |
| `22-manage-ssl-hosts` | `/ssl-tls/manage-ssl-hosts` | the "Server hostname" card (or the capability notice) |
| `23-multiphp-manager` | `/software/multiphp-manager` | the root-only "Install a PHP version" card with its branch table or install prompt |
| `24-install-distro-packages` | `/software/install-distro-packages` | the Catalog tab (the default) with its groups |
| `24b-install-distro-packages-search` | same page | the "Search repositories" tab clicked, its search box shown (typing a search must click that tab first) |
| `25-contact-manager` | `/server-contacts/contact-manager` | the "Security notifications" card |
| `26-security-advisor` | `/security-center/security-advisor` | the "Hardening" card with its item rows (every item reads not applied / not applicable here, never a 501) |
| `27-backup-configuration` | `/backup/backup-configuration` | the "Cloud storage" card above Destinations |

`screenshot-all.cjs` waits for the same cards on those pages (`PAGE_WAITS`) and lists the flow
shots 18–27 in the gallery.

## Live hub + panel flow (`live-hub-flow.sh`)

Starts a `whm-hub` with freshly generated keys and a self-signed certificate, starts a panel
pointed at it, and drives both through the public, developer, admin and panel APIs:

1. hub up — `gen-key.js --master/--hmac/--license/--plugin`, `hub.conf`, TLS, `GET /healthz`,
   `GET /v1/keys`, `GET /v1/market/keys`, `hub-cli.js create-admin`; vendor admin portal login,
   TOTP enrolment, an `admin:*` API key;
2. panel up with `WHM_LICENSE_HUB_URL`, `WHM_LICENSE_HUB_CA` and `WHM_LICENSE_KEYS_FILE` (the
   hub's license public key) and an empty `WHM_CONFIG` file (so an installed `/etc/whm/whm.conf`
   is never read), API login as root;
2b. super admin — `POST /api/license/trial` answers `403 superadmin_required` for a plain root user;
   `whm-cli superadmin --init` writes the setup-password key file (`$WHM_SUPERADMIN_KEY_FILE`,
   0600, under the panel data directory here), a wrong setup password is refused, `whm-cli
   superadmin root` grants the flag and the session from step 2 sees `superadmin: true` on
   `GET /api/auth/me` without logging in again, `auth.superadmin.grant` audit row;
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

Ten steps in all (1, 1b, 2, 2b, 3, 4, 5, 6, 6b, 7 are the labels in the summary; a green run
prints ten `PASS` lines). TOTP codes are minted by a helper that waits for the next 30-second
step when a secret's code was already used in the current one: both hubs accept a code once per
account.

```bash
SCRATCH=/tmp/whm-live-e2e HUB_PORT=7443 HUB_LB_PORT=7440 PANEL_PORT=2088 bash e2e/live-hub-flow.sh
# KEEP_RUNNING=1 leaves the hub and the panel up after a green run (pid files in $SCRATCH),
# e.g. to take the Phase-5 screenshots against a panel with a real license and marketplace state:
KEEP_RUNNING=1 bash e2e/live-hub-flow.sh && OUT=docs/screenshots BASE=http://127.0.0.1:2088 PASSWORD='Live-E2e-Passw0rd!' bash e2e/screenshots.sh
kill "$(cat /tmp/whm-live-e2e/panel.pid)" "$(cat /tmp/whm-live-e2e/hub.pid)"
```

Every run starts from empty hub and panel data directories under `$SCRATCH` (the trial can only
be started once per server fingerprint and e-mail on a given hub). Needs `node`, `openssl`, `curl`,
`jq`; `BUILD_CLIENT=1` builds the client first. Other knobs: `PANEL_PASSWORD`,
`SUPERADMIN_SETUP_PASSWORD`, `HUB_ADMIN_EMAIL`, `HUB_ADMIN_PASSWORD`, `DEV_EMAIL`, `DEV_PASSWORD`,
`TRIAL_EMAIL`. The hub config written by the
script sets `review.require_two_reviewers_for_high_risk: false` so one admin approval signs the
sample plugin; the production default needs a second reviewer for high-risk versions.

> The run log under `$SCRATCH` records response bodies of the throwaway hub (admin API key, TOTP secrets, CSRF tokens). It is test-only material; delete the scratch directory after use and never point the script at a production hub.
