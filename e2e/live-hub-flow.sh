#!/usr/bin/env bash
# Live hub + panel end-to-end flow (Phase 5): starts a whm-hub with fresh keys and
# a self-signed certificate, a panel pointed at it, then drives the real API of
# both through trial activation, check-in, developer publishing, marketplace
# install with consent, and revocation. Prints PASS/FAIL per step, stops both
# processes on exit (also on failure) and leaves every file under $SCRATCH.
#
#   SCRATCH=/tmp/whm-live-e2e HUB_PORT=7443 HUB_LB_PORT=7440 PANEL_PORT=2088 bash e2e/live-hub-flow.sh
#
# Needs: node 22 with the workspaces installed, openssl, curl, jq, the built
# client (client/dist; set BUILD_CLIENT=1 to build it first). Idempotent: every
# run starts from empty hub and panel data directories under $SCRATCH.
set -uo pipefail
REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
SCRATCH=${SCRATCH:-${TMPDIR:-/tmp}/whm-live-e2e}
HUB_PORT=${HUB_PORT:-7443}
HUB_LB_PORT=${HUB_LB_PORT:-7440}
PANEL_PORT=${PANEL_PORT:-2088}
PANEL_PASSWORD=${PANEL_PASSWORD:-'Live-E2e-Passw0rd!'}
HUB_ADMIN_EMAIL=${HUB_ADMIN_EMAIL:-admin@hub.test}
HUB_ADMIN_PASSWORD=${HUB_ADMIN_PASSWORD:-'Hub-Admin-Passw0rd!'}
DEV_EMAIL=${DEV_EMAIL:-dev@example.test}
DEV_PASSWORD=${DEV_PASSWORD:-'Dev-Portal-Passw0rd!'}
TRIAL_EMAIL=${TRIAL_EMAIL:-trial@example.test}
PLUGIN_ID=net.whm.sample-notes
HUB_URL="https://127.0.0.1:${HUB_PORT}"
PANEL_URL="http://127.0.0.1:${PANEL_PORT}"
HUB=$SCRATCH/hub
PANEL=$SCRATCH/panel-data
CERT=$HUB/tls/hub.crt
export NODE_PATH=$REPO/node_modules

mkdir -p "$SCRATCH" "$HUB/tls" "$HUB/keys" "$HUB/data" "$HUB/mail" "$SCRATCH/bin" "$SCRATCH/pkg" "$SCRATCH/dev"
LOG=$SCRATCH/live-e2e.log
: > "$LOG"
RESULTS=()
STEP=''
HUB_PID=''; PANEL_PID=''

log() { printf '%s\n' "$*" >> "$LOG"; }
say() { printf '%s\n' "$*"; log "$*"; }
step() { STEP="$1"; say "--- $1"; }
pass() { RESULTS+=("PASS  $STEP${1:+ — $1}"); say "PASS  $STEP${1:+ — $1}"; }
fail() { RESULTS+=("FAIL  $STEP — $1"); say "FAIL  $STEP — $1"; finish 1; }
finish() {
  local code=${1:-0}
  trap - EXIT
  # KEEP_RUNNING=1 leaves a green run's hub and panel up (for the Playwright flow); stop them with the pid files.
  if [ "$code" = 0 ] && [ "${KEEP_RUNNING:-0}" = 1 ]; then RESULTS+=("KEPT  hub and panel left running (pids in $SCRATCH/hub.pid, $SCRATCH/panel.pid)"); else stop_processes; fi
  echo
  echo "== live hub flow summary =="
  printf '%s\n' "${RESULTS[@]:-}"
  echo "log: $LOG"
  if [ "$code" = 0 ] && [ "${KEEP_RUNNING:-0}" = 1 ]; then echo "processes left running: hub pid ${HUB_PID:-none}, panel pid ${PANEL_PID:-none}"; else echo "processes stopped: hub pid ${HUB_PID:-none}, panel pid ${PANEL_PID:-none}"; fi
  exit "$code"
}
trap 'finish 1' EXIT

kill_pidfile() {
  local f=$1
  [ -f "$f" ] || return 0
  local pid; pid=$(cat "$f" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$f"
}
stop_processes() { kill_pidfile "$SCRATCH/panel.pid"; kill_pidfile "$SCRATCH/hub.pid"; }
wait_http() { # url expected-code tries
  local url=$1 code=$2 tries=${3:-60} got
  for _ in $(seq 1 "$tries"); do
    got=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$CERT" "$url" 2>/dev/null || true)
    [ "$got" = "$code" ] && return 0
    sleep 0.5
  done
  return 1
}

# ---- HTTP helpers: every call stores the body in $BODY and the status in $CODE
BODY=''; CODE=''
http() { # method url [json-body] [curl args...]
  local method=$1 url=$2 data=${3:-}; shift 3 || shift $#
  local out
  if [ -n "$data" ]; then
    out=$(curl -s --cacert "$CERT" -X "$method" "$url" -H 'Content-Type: application/json' -H 'Accept: application/json' --data "$data" -w '\n%{http_code}' "$@")
  else
    out=$(curl -s --cacert "$CERT" -X "$method" "$url" -H 'Accept: application/json' -w '\n%{http_code}' "$@")
  fi
  CODE=${out##*$'\n'}
  BODY=${out%$'\n'*}
  log ">> $method $url ${data:+$data}"
  log "<< $CODE ${BODY:0:600}"
}
hub_admin() { http "$1" "$HUB_URL$2" "${3:-}" -H "Authorization: Bearer $ADMIN_KEY"; }
hub_portal() { http "$1" "$HUB_URL$2" "${3:-}" -b "$SCRATCH/hub-admin.cookies" -c "$SCRATCH/hub-admin.cookies" -H "X-CSRF-Token: ${PORTAL_CSRF:-}"; }
hub_dev() { http "$1" "$HUB_URL$2" "${3:-}" -b "$SCRATCH/dev.cookies" -c "$SCRATCH/dev.cookies" -H "X-CSRF-Token: ${DEV_CSRF:-}"; }
panel() { http "$1" "$PANEL_URL$2" "${3:-}" -b "$SCRATCH/panel.cookies" -c "$SCRATCH/panel.cookies" -H "X-CSRF-Token: ${PANEL_CSRF:-}"; }
jqr() { printf '%s' "$BODY" | jq -r "$1" 2>/dev/null; }
expect_code() { [ "$CODE" = "$1" ] || fail "${2:-request} answered HTTP $CODE: ${BODY:0:300}"; }
totp() { node -e "const {authenticator}=require('otplib');const r=authenticator.timeRemaining();if(r<4)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,r*1000+200);console.log(authenticator.generate(process.argv[1]))" "$1"; }
b64() { printf '%s' "$1" | base64 -w0; }

# =============================================================================
step '1. hub up (keys, TLS, config, healthz, vendor admin)'
stop_processes
rm -rf "$HUB/data" "$HUB/keys" "$HUB/mail" "$PANEL" "$SCRATCH"/*.cookies "$SCRATCH/pkg" "$SCRATCH/dev"
mkdir -p "$HUB/data" "$HUB/keys" "$HUB/mail" "$SCRATCH/pkg" "$SCRATCH/dev"
if [ ! -f "$CERT" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj '/CN=127.0.0.1' \
    -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' -keyout "$HUB/tls/hub.key" -out "$CERT" >> "$LOG" 2>&1 || fail 'openssl could not create the self-signed certificate'
fi
# The hub's only mail transport is the local sendmail binary; this stand-in keeps every message as a file.
cat > "$SCRATCH/bin/sendmail" <<EOF
#!/bin/sh
cat > "$HUB/mail/\$(date +%s%N).eml"
EOF
chmod 755 "$SCRATCH/bin/sendmail"
HUB_CONF=$HUB/hub.conf
jq -n --arg url "$HUB_URL" --argjson port "$HUB_PORT" --argjson lb "$HUB_LB_PORT" --arg hub "$HUB" '{
  public_url: $url, serve_ui: false, host: "127.0.0.1", port: $port, loopback_port: $lb, trust_proxy: "loopback", log_level: "info",
  db_dir: ($hub + "/data"), master_key_file: ($hub + "/master.key"), insecure_http: false,
  tls: { cert: ($hub + "/tls/hub.crt"), key: ($hub + "/tls/hub.key") },
  keys: { dir: ($hub + "/keys"), active_kid: { license: null, plugin: null } },
  license: { backup_dir: null, mail: { from: "whm-hub@localhost", enabled: true, transport: "sendmail" }, vendor: { name: "WHM Vendor (live e2e)" } },
  marketplace: { packages_dir: ($hub + "/data/packages"), download_hmac_file: ($hub + "/keys/download.hmac"), review: { require_two_reviewers_for_high_risk: false } }
}' > "$HUB_CONF"
GEN="node $REPO/hub/scripts/gen-key.js --config $HUB_CONF"
$GEN --master --force >> "$LOG" 2>&1 || fail 'gen-key --master failed'
$GEN --hmac --force >> "$LOG" 2>&1 || fail 'gen-key --hmac failed'
LICENSE_KEY_JSON=$($GEN --license --json 2>> "$LOG") || fail 'gen-key --license failed'
PLUGIN_KEY_JSON=$($GEN --plugin --json 2>> "$LOG") || fail 'gen-key --plugin failed'
LICENSE_KID=$(printf '%s' "$LICENSE_KEY_JSON" | jq -r .kid)
PLUGIN_KID=$(printf '%s' "$PLUGIN_KEY_JSON" | jq -r .kid)
printf '%s' "$LICENSE_KEY_JSON" | jq '{keys: [{kid: .kid, pub: .pub, not_after: null}]}' > "$SCRATCH/license-keys.json"
curl -s -o /dev/null "http://127.0.0.1:${HUB_LB_PORT}/healthz" && fail "port $HUB_LB_PORT is already in use by another process"
curl -sk -o /dev/null "$HUB_URL/healthz" && fail "port $HUB_PORT is already in use by another process"
cd "$REPO"
PATH="$SCRATCH/bin:$PATH" WHM_HUB_CONFIG="$HUB_CONF" nohup node hub/src/index.js > "$SCRATCH/hub.log" 2>&1 &
HUB_PID=$!; echo "$HUB_PID" > "$SCRATCH/hub.pid"
wait_http "http://127.0.0.1:${HUB_LB_PORT}/healthz" 200 60 || fail "hub loopback /healthz did not answer 200 (see $SCRATCH/hub.log)"
wait_http "$HUB_URL/healthz" 200 20 || fail "hub public https /healthz did not answer 200"
http GET "$HUB_URL/healthz"
[ "$(jqr .data.keys.license)" = "$LICENSE_KID" ] && [ "$(jqr .data.keys.plugin)" = "$PLUGIN_KID" ] || fail "healthz keys do not match generated kids: $BODY"
http GET "$HUB_URL/v1/keys"; expect_code 200 'GET /v1/keys'
[ "$(jqr '.data.keys[0].kid')" = "$LICENSE_KID" ] || fail "license key bundle does not list $LICENSE_KID"
http GET "$HUB_URL/v1/market/keys"; expect_code 200 'GET /v1/market/keys'
printf '%s' "$BODY" | jq -e --arg k "$PLUGIN_KID" '.data.keys[] | select(.kid == $k and .status == "active")' > /dev/null || fail "plugin key bundle does not list $PLUGIN_KID as active"
ADMIN_JSON=$(cd "$REPO" && WHM_HUB_CONFIG="$HUB_CONF" node hub/scripts/hub-cli.js create-admin "$HUB_ADMIN_EMAIL" --password "$HUB_ADMIN_PASSWORD" --json 2>> "$LOG") || fail 'hub-cli create-admin failed'
ADMIN_ID=$(printf '%s' "$ADMIN_JSON" | jq -r .id)
pass "license kid $LICENSE_KID, plugin kid $PLUGIN_KID, vendor admin $ADMIN_ID"

# Vendor admin session → TOTP enrolment (every admin mutation needs a step-up) → an admin:* API key for the rest of the flow.
step '1b. hub admin: portal login, TOTP enrolment, admin API key'
hub_portal POST /v1/portal/login "$(jq -n --arg e "$HUB_ADMIN_EMAIL" --arg p "$HUB_ADMIN_PASSWORD" '{email:$e,password:$p}')"; expect_code 200 'portal login'
PORTAL_CSRF=$(jqr .data.csrfToken)
hub_portal POST /v1/portal/2fa/enroll '{}'; expect_code 200 '2fa enroll'
ADMIN_TOTP_SECRET=$(jqr .data.secret)
hub_portal POST /v1/portal/2fa/confirm "$(jq -n --arg c "$(totp "$ADMIN_TOTP_SECRET")" '{code:$c}')"; expect_code 200 '2fa confirm'
hub_portal POST /v1/admin/api-keys '{"name":"live-e2e","scopes":["admin:*"]}'; expect_code 201 'admin api key'
ADMIN_KEY=$(jqr .data.key)
[ -n "$ADMIN_KEY" ] && [ "$ADMIN_KEY" != null ] || fail 'no admin API key returned'
pass 'admin API key minted'

# =============================================================================
step '2. panel up, API login'
if [ "${BUILD_CLIENT:-0}" = 1 ] || [ ! -f "$REPO/client/dist/index.html" ]; then
  (cd "$REPO" && npm run build --workspace client >> "$LOG" 2>&1) || fail 'client build failed'
fi
curl -s -o /dev/null "$PANEL_URL/api/health" && fail "port $PANEL_PORT is already in use by another process"
cd "$REPO"
WHM_MODE=monolithic WHM_DATA_DIR="$PANEL" WHM_PORT="$PANEL_PORT" WHM_SERVE_CLIENT=true WHM_ADMIN_PASSWORD="$PANEL_PASSWORD" \
  WHM_LICENSE_HUB_URL="$HUB_URL" WHM_LICENSE_HUB_CA="$CERT" WHM_LICENSE_KEYS_FILE="$SCRATCH/license-keys.json" NODE_ENV=development \
  nohup node server/src/index.js > "$SCRATCH/panel.log" 2>&1 &
PANEL_PID=$!; echo "$PANEL_PID" > "$SCRATCH/panel.pid"
wait_http "$PANEL_URL/api/health" 200 90 || fail "panel /api/health did not answer 200 (see $SCRATCH/panel.log)"
panel POST /api/auth/login "$(jq -n --arg p "$PANEL_PASSWORD" '{username:"root",password:$p}')"; expect_code 200 'panel login'
PANEL_CSRF=$(jqr .data.csrfToken)
[ "$(jqr .data.mustEnroll2fa)" = false ] || fail 'root must enrol 2FA (policy) — the flow expects the default policy'
[ "$(jqr .data.user.mustChangePassword)" = false ] || fail 'root must change the password (WHM_ADMIN_PASSWORD was not applied)'
panel GET /api/auth/me; expect_code 200 'auth/me'
[ "$(jqr .data.license.status)" = unlicensed ] || fail "fresh panel is not unlicensed: $(jqr .data.license)"
pass "root session, csrf token, license status $(jqr .data.license.status)"

# =============================================================================
step '3. license: trial, hub activation, pinned plugin key, check-in'
panel POST /api/license/trial "$(jq -n --arg e "$TRIAL_EMAIL" '{email:$e}')"; expect_code 201 'POST /api/license/trial'
[ "$(jqr .data.status)" = active ] && [ "$(jqr .data.edition)" = trial ] || fail "trial did not activate: $(jqr .data)"
ACTIVATION_ID=$(jqr .data.activationId)
panel GET /api/license; expect_code 200 'GET /api/license'
[ "$(jqr .data.status)" = active ] && [ "$(jqr .data.tokenVerified)" = true ] || fail "GET /api/license: $(jqr '{status,tokenVerified,reason}')"
printf '%s' "$BODY" | jq -e --arg k "$PLUGIN_KID" '.data.pluginSigningKids | index($k)' > /dev/null || fail "plugin kid $PLUGIN_KID not pinned: $(jqr .data.pluginSigningKids)"
[ -f "$PANEL/plugin-keys/$PLUGIN_KID.pub" ] || fail "$PANEL/plugin-keys/$PLUGIN_KID.pub missing"
printf '%s' "$PLUGIN_KEY_JSON" | jq -j .pub | cmp -s - "$PANEL/plugin-keys/$PLUGIN_KID.pub" || fail 'pinned plugin key differs from the hub key'
hub_admin GET /v1/admin/activations; expect_code 200 'hub GET /v1/admin/activations'
printf '%s' "$BODY" | jq -e --arg a "$ACTIVATION_ID" '.data[] | select(.id == $a and .status == "active")' > /dev/null || fail "hub does not show activation $ACTIVATION_ID active"
hub_admin GET /v1/admin/trials; expect_code 200 'hub GET /v1/admin/trials'
[ "$(jqr '.data | length')" -ge 1 ] || fail 'hub shows no trial'
panel POST /api/license/checkin '{}'; expect_code 200 'POST /api/license/checkin'
[ "$(jqr .data.ok)" = true ] && [ "$(jqr .data.status)" = active ] || fail "check-in failed: $(jqr '{ok,code,message}')"
pass "trial active, activation $ACTIVATION_ID, plugin key pinned, check-in ok"

# =============================================================================
step '4. marketplace publishing (developer registration → verified → signed upload → published)'
hub_dev POST /v1/dev/register "$(jq -n --arg e "$DEV_EMAIL" --arg p "$DEV_PASSWORD" '{email:$e,password:$p,display_name:"Live E2E Developer"}')"; expect_code 202 'dev register'
DEV_ID=$(jqr .data.id)
VERIFY_TOKEN=''
for _ in $(seq 1 20); do
  VERIFY_TOKEN=$(grep -ho 'dev/verify-email/[A-Za-z0-9_-]*' "$HUB"/mail/*.eml 2>/dev/null | head -1 | sed 's#.*/##')
  [ -n "$VERIFY_TOKEN" ] && break
  sleep 0.3
done
[ -n "$VERIFY_TOKEN" ] || fail 'no verification mail captured by the sendmail stand-in'
hub_dev POST /v1/dev/verify-email "$(jq -n --arg t "$VERIFY_TOKEN" '{token:$t}')"; expect_code 200 'verify-email'
hub_dev POST /v1/dev/login "$(jq -n --arg e "$DEV_EMAIL" --arg p "$DEV_PASSWORD" '{email:$e,password:$p}')"; expect_code 200 'dev login'
DEV_CSRF=$(jqr .data.csrfToken)
hub_dev POST /v1/dev/2fa/start '{}'; expect_code 200 'dev 2fa start'
DEV_TOTP_SECRET=$(jqr .data.secret)
hub_dev POST /v1/dev/2fa/confirm "$(jq -n --arg c "$(totp "$DEV_TOTP_SECRET")" '{code:$c}')"; expect_code 200 'dev 2fa confirm'
# Vendor backend: assign the net.whm namespace and verify the developer (publishing is gated on this).
hub_admin POST "/v1/admin/market/developers/$DEV_ID/namespaces/net.whm/reassign" '{}'; expect_code 200 'admin namespace reassign'
hub_admin POST "/v1/admin/market/verifications/$DEV_ID/approve" '{"note":"live e2e"}'; expect_code 200 'admin developer approve'
[ "$(jqr .data.status)" = verified ] || fail "developer not verified: $(jqr .data.status)"
# Developer signing key with proof of possession.
openssl genpkey -algorithm ed25519 -out "$SCRATCH/dev/dev.pem" 2>> "$LOG" || fail 'openssl could not create the developer key'
openssl pkey -in "$SCRATCH/dev/dev.pem" -pubout -out "$SCRATCH/dev/dev.pub" 2>> "$LOG"
hub_dev POST /v1/dev/keys '{}'; expect_code 201 'dev key challenge'
CHALLENGE=$(jqr .data.challenge)
SIG=$(node -e "const c=require('crypto'),fs=require('fs');process.stdout.write(c.sign(null,Buffer.from(process.argv[1],'base64url'),c.createPrivateKey(fs.readFileSync(process.argv[2],'utf8'))).toString('base64'))" "$CHALLENGE" "$SCRATCH/dev/dev.pem")
hub_dev POST "/v1/dev/keys/$CHALLENGE" "$(jq -n --rawfile pub "$SCRATCH/dev/dev.pub" --arg sig "$SIG" '{public_key_pem:$pub,label:"live-e2e",sig:$sig}')"; expect_code 201 'dev key register'
DEV_KID=$(jqr .data.kid)
# Listing, package (DEV-SIGNATURE.json from scripts/build-plugin.js), upload with justifications.
hub_dev POST /v1/dev/plugins "$(jq -n --arg id "$PLUGIN_ID" '{id:$id,name:"Sample Notes",summary:"Reference plugin exercising every SDK extension point"}')"; expect_code 201 'dev listing create'
PKG=$SCRATCH/pkg/$PLUGIN_ID.whmplugin
BUILD_JSON=$(cd "$REPO" && node scripts/build-plugin.js plugins/sample-plugin --sign "$SCRATCH/dev/dev.pem" --dev --out "$PKG" --json 2>> "$LOG") || fail 'build-plugin failed'
PKG_VERSION=$(printf '%s' "$BUILD_JSON" | jq -r .manifest.version)
[ "$(printf '%s' "$BUILD_JSON" | jq -r .signature.kid)" = "$DEV_KID" ] || fail "package signed with $(printf '%s' "$BUILD_JSON" | jq -r .signature.kid), registered key is $DEV_KID"
JUST=$(jq -c '[.permissions[] | {key: ., value: ("Needed so the sample notes plugin can use " + . + " as documented in its README")}] | from_entries' "$REPO/plugins/sample-plugin/plugin.json")
UP=$(curl -s --cacert "$CERT" -X POST "$HUB_URL/v1/dev/plugins/$PLUGIN_ID/versions?channel=stable" -b "$SCRATCH/dev.cookies" -c "$SCRATCH/dev.cookies" -H "X-CSRF-Token: $DEV_CSRF" \
  -H 'Content-Type: application/gzip' -H "X-WHM-Justifications: $(b64 "$JUST")" -H "X-WHM-Changelog: $(b64 'Live e2e upload')" --data-binary "@$PKG" -w '\n%{http_code}')
CODE=${UP##*$'\n'}; BODY=${UP%$'\n'*}; log "<< upload $CODE ${BODY:0:600}"
expect_code 201 'version upload'
[ "$(jqr .data.status)" = in_review ] || fail "uploaded version is $(jqr .data.status), not in_review: $(jqr '.data.scan // .data')"
REVIEW_ID=$(jqr .data.review_id)
[ -n "$REVIEW_ID" ] && [ "$REVIEW_ID" != null ] || fail 'no review_id on the uploaded version'
hub_admin POST "/v1/admin/market/reviews/$REVIEW_ID/approve" '{"notes":"live e2e"}'; expect_code 200 'admin review approve'
[ "$(jqr .data.signed.kid)" = "$PLUGIN_KID" ] || fail "hub signed with $(jqr .data.signed.kid), expected $PLUGIN_KID"
hub_dev POST /v1/dev/2fa/stepup "$(jq -n --arg t "$(totp "$DEV_TOTP_SECRET")" '{totp:$t}')"; expect_code 200 'dev step-up'
hub_dev POST "/v1/dev/plugins/$PLUGIN_ID/versions/$PKG_VERSION/publish" '{"channel":"stable"}'; expect_code 200 'dev publish'
[ "$(jqr .data.status)" = published ] || fail "version is $(jqr .data.status)"
http GET "$HUB_URL/v1/market/catalog"; expect_code 200 'GET /v1/market/catalog'
printf '%s' "$BODY" | jq -e --arg id "$PLUGIN_ID" --arg v "$PKG_VERSION" '.data[] | select(.id == $id and .latest_version == $v)' > /dev/null \
  || printf '%s' "$BODY" | jq -e --arg id "$PLUGIN_ID" '.data[] | select(.id == $id)' > /dev/null || fail "catalog does not list $PLUGIN_ID: ${BODY:0:300}"
pass "developer $DEV_ID verified, key $DEV_KID, $PLUGIN_ID@$PKG_VERSION published (hub kid $PLUGIN_KID)"

# =============================================================================
step '5. panel marketplace: enable whm-hub, catalog, install → pending_consent → consent → enabled'
panel PUT /api/market/providers/whm-hub "$(jq -n --arg u "$HUB_URL" '{url:$u}')"; expect_code 200 'PUT whm-hub url'
panel POST /api/market/providers/whm-hub/enable '{}'; expect_code 200 'enable whm-hub'
panel GET /api/marketplace/status; expect_code 200 'GET /api/marketplace/status'
[ "$(jqr .data.enabled)" = true ] && [ "$(jqr .data.hubMismatch)" = false ] || fail "marketplace status: $(jqr '{enabled,hubMismatch,url,hubUrl}')"
panel GET /api/marketplace/catalog; expect_code 200 'GET /api/marketplace/catalog'
printf '%s' "$BODY" | jq -e --arg id "$PLUGIN_ID" '.data[] | select(.id == $id)' > /dev/null || fail "panel catalog does not list $PLUGIN_ID"
panel GET "/api/marketplace/plugins/$PLUGIN_ID"; expect_code 200 'GET /api/marketplace/plugins/:id'
panel POST /api/marketplace/install "$(jq -n --arg id "$PLUGIN_ID" '{pluginId:$id}')"; expect_code 202 'POST /api/marketplace/install'
JOB_ID=$(jqr .data.job.id)
JOB_STATUS=''
for _ in $(seq 1 120); do
  panel GET "/api/system/jobs/$JOB_ID"
  JOB_STATUS=$(jqr .data.status)
  case "$JOB_STATUS" in done|failed|cancelled) break;; esac
  sleep 0.5
done
[ "$JOB_STATUS" = done ] || fail "install job $JOB_ID ended $JOB_STATUS: $(jqr '.data.error // .data')"
[ "$(jqr .data.result.status)" = pending_consent ] || fail "install job result: $(jqr .data.result)"
REQUIRED=$(jqr '.data.result.required')
panel GET "/api/plugins/manage/$PLUGIN_ID"; expect_code 200 'GET /api/plugins/manage/:id (before consent)'
[ "$(jqr .data.state)" != enabled ] || fail 'plugin is enabled before consent'
panel POST "/api/marketplace/consent/$PLUGIN_ID" "$(jq -n --argjson p "$REQUIRED" '{permissions:$p}')"; expect_code 200 'POST /api/marketplace/consent/:id'
[ "$(jqr .data.plugin.state)" = enabled ] || fail "plugin state after consent: $(jqr .data.plugin.state)"
panel GET /api/plugins/manage; expect_code 200 'GET /api/plugins/manage'
printf '%s' "$BODY" | jq -e --arg id "$PLUGIN_ID" --arg k "$PLUGIN_KID" '.data[] | select(.id == $id and .state == "enabled" and .signed == true and .signer == $k and .source == "marketplace")' > /dev/null \
  || fail "manage list does not show $PLUGIN_ID enabled, signed by $PLUGIN_KID: $(printf '%s' "$BODY" | jq -c --arg id "$PLUGIN_ID" '.data[] | select(.id == $id) | {state,signed,signer,source,version}')"
panel GET "/api/plugins/$PLUGIN_ID/notes"; expect_code 200 'GET /api/plugins/net.whm.sample-notes/notes'
panel GET /api/marketplace/installs; expect_code 200 'GET /api/marketplace/installs'
printf '%s' "$BODY" | jq -e --arg id "$PLUGIN_ID" '.data[] | select(.pluginId == $id and .consentState == "consented")' > /dev/null || fail 'marketplace_installs row is not consented'
pass "installed $PLUGIN_ID@$PKG_VERSION through consent; plugin route answers"

# =============================================================================
step '6. revocation: hub admin revokes → panel poll → disabled, banner data, audit row'
hub_admin POST /v1/admin/market/revocations "$(jq -n --arg id "$PLUGIN_ID" --arg v "$PKG_VERSION" '{plugin_id:$id,version:$v,severity:"warning",action:"disable",reason:"Live e2e revocation"}')"; expect_code 201 'hub POST /v1/admin/market/revocations'
REV_ID=$(jqr .data.id)
panel POST /api/marketplace/revocations/poll '{}'; expect_code 200 'POST /api/marketplace/revocations/poll'
printf '%s' "$BODY" | jq -e --arg id "$PLUGIN_ID" '.data.applied[] | select(.pluginId == $id)' > /dev/null || fail "poll applied nothing: $BODY"
panel GET "/api/plugins/manage/$PLUGIN_ID"; expect_code 200 'GET /api/plugins/manage/:id (after revocation)'
[ "$(jqr .data.state)" = disabled ] || fail "plugin state after revocation: $(jqr .data.state)"
panel GET '/api/marketplace/revocations?unacknowledged=true'; expect_code 200 'GET /api/marketplace/revocations'
printf '%s' "$BODY" | jq -e --arg id "$PLUGIN_ID" '.data[] | select(.pluginId == $id and .acknowledgedAt == null and (.appliedTo | length) > 0)' > /dev/null || fail 'no unacknowledged marketplace_revocations row'
PANEL_REV_ID=$(printf '%s' "$BODY" | jq -r --arg id "$PLUGIN_ID" '[.data[] | select(.pluginId == $id)][0].id')
panel GET /api/marketplace/status; expect_code 200 'GET /api/marketplace/status'
[ "$(jqr .data.unacknowledgedRevocations)" -ge 1 ] || fail 'status does not report the unacknowledged revocation (banner data)'
panel POST "/api/plugins/manage/$PLUGIN_ID/enable" '{}'
[ "$CODE" = 409 ] && [ "$(jqr .error.code)" = plugin_revoked ] || fail "re-enable answered $CODE $(jqr .error.code), expected 409 plugin_revoked"
panel GET '/api/system/audit?action=plugin.revoked&pageSize=5'; expect_code 200 'GET /api/system/audit'
printf '%s' "$BODY" | jq -e --arg id "$PLUGIN_ID" '.data[] | select(.action == "plugin.revoked" and .target == $id)' > /dev/null || fail 'no plugin.revoked audit row'
panel GET /api/server-contacts/events; expect_code 200 'GET /api/server-contacts/events'
printf '%s' "$BODY" | jq -e 'tostring | test("plugin.revoked")' > /dev/null || fail 'plugin.revoked is not a Contact Manager event'
panel POST "/api/marketplace/revocations/$PANEL_REV_ID/ack" '{}'; expect_code 200 'ack revocation'
pass "revocation $REV_ID applied: disabled, banner row $PANEL_REV_ID, 409 plugin_revoked on enable, audit plugin.revoked"

# =============================================================================
step '6b. update path: 1.1.1 with one more scope → update stops at pending_consent → consent → enabled'
panel POST "/api/plugins/manage/$PLUGIN_ID/enable" '{}'; expect_code 200 're-enable after acknowledging the revocation'
[ "$(jqr .data.state)" = enabled ] || fail "plugin state after re-enable: $(jqr .data.state)"
SRC=$SCRATCH/pkg/src
rm -rf "$SRC"; cp -r "$REPO/plugins/sample-plugin" "$SRC"
NEXT_VERSION=$(jq -r '.version | split(".") | .[2] = ((.[2] | tonumber) + 1 | tostring) | join(".")' "$SRC/plugin.json")
jq --arg v "$NEXT_VERSION" '.version = $v | .permissions += ["packages:read"]' "$SRC/plugin.json" > "$SRC/plugin.json.tmp" && mv "$SRC/plugin.json.tmp" "$SRC/plugin.json"
PKG2=$SCRATCH/pkg/$PLUGIN_ID-$NEXT_VERSION.whmplugin
(cd "$REPO" && node scripts/build-plugin.js "$SRC" --sign "$SCRATCH/dev/dev.pem" --dev --out "$PKG2" --json >> "$LOG" 2>&1) || fail "build-plugin failed for $NEXT_VERSION"
JUST2=$(jq -c '[.permissions[] | {key: ., value: ("Needed so the sample notes plugin can use " + . + " as documented in its README")}] | from_entries' "$SRC/plugin.json")
UP=$(curl -s --cacert "$CERT" -X POST "$HUB_URL/v1/dev/plugins/$PLUGIN_ID/versions?channel=stable" -b "$SCRATCH/dev.cookies" -c "$SCRATCH/dev.cookies" -H "X-CSRF-Token: $DEV_CSRF" \
  -H 'Content-Type: application/gzip' -H "X-WHM-Justifications: $(b64 "$JUST2")" -H "X-WHM-Changelog: $(b64 'Adds packages:read')" --data-binary "@$PKG2" -w '\n%{http_code}')
CODE=${UP##*$'\n'}; BODY=${UP%$'\n'*}; log "<< upload $CODE ${BODY:0:600}"
expect_code 201 "upload $NEXT_VERSION"
[ "$(jqr .data.status)" = in_review ] || fail "uploaded $NEXT_VERSION is $(jqr .data.status): $(jqr '.data.scan // .data')"
hub_admin POST "/v1/admin/market/reviews/$(jqr .data.review_id)/approve" '{"notes":"live e2e update"}'; expect_code 200 "admin approve $NEXT_VERSION"
hub_dev POST /v1/dev/2fa/stepup "$(jq -n --arg t "$(totp "$DEV_TOTP_SECRET")" '{totp:$t}')"; expect_code 200 'dev step-up'
hub_dev POST "/v1/dev/plugins/$PLUGIN_ID/versions/$NEXT_VERSION/publish" '{"channel":"stable"}'; expect_code 200 "dev publish $NEXT_VERSION"
http GET "$HUB_URL/v1/market/plugins/$PLUGIN_ID"; expect_code 200 'GET /v1/market/plugins/:id'
[ "$(jqr .data.latest.version)" = "$NEXT_VERSION" ] || fail "hub latest is $(jqr .data.latest.version), expected $NEXT_VERSION"
panel POST /api/marketplace/updates/check '{}'; expect_code 200 'POST /api/marketplace/updates/check'
printf '%s' "$BODY" | jq -e --arg id "$PLUGIN_ID" --arg v "$NEXT_VERSION" --arg c "$PKG_VERSION" '.data[] | select(.id == $id and .latest == $v and .current == $c)' > /dev/null || fail "update check does not offer $NEXT_VERSION: $BODY"
panel POST "/api/marketplace/update/$PLUGIN_ID" '{}'; expect_code 202 'POST /api/marketplace/update/:id'
JOB_ID=$(jqr .data.job.id); JOB_STATUS=''
for _ in $(seq 1 120); do
  panel GET "/api/system/jobs/$JOB_ID"; JOB_STATUS=$(jqr .data.status)
  case "$JOB_STATUS" in done|failed|cancelled) break;; esac
  sleep 0.5
done
[ "$JOB_STATUS" = done ] || fail "update job $JOB_ID ended $JOB_STATUS: $(jqr '.data.error // .data')"
[ "$(jqr .data.result.status)" = pending_consent ] && [ "$(jqr .data.result.version)" = "$NEXT_VERSION" ] || fail "update job result: $(jqr .data.result)"
[ "$(jqr '.data.result.added | join(",")')" = 'packages:read' ] || fail "added scopes: $(jqr .data.result.added)"
REQUIRED=$(jqr '.data.result.required')
panel GET "/api/plugins/manage/$PLUGIN_ID"; expect_code 200 'GET /api/plugins/manage/:id (update held)'
[ "$(jqr .data.state)" != enabled ] && [ "$(jqr .data.version)" = "$NEXT_VERSION" ] || fail "held update: state $(jqr .data.state), version $(jqr .data.version)"
panel POST "/api/marketplace/consent/$PLUGIN_ID" "$(jq -n --argjson p "$REQUIRED" '{permissions:$p}')"; expect_code 200 'consent for the update'
[ "$(jqr .data.plugin.state)" = enabled ] && [ "$(jqr .data.plugin.version)" = "$NEXT_VERSION" ] || fail "after consent: $(jqr '.data.plugin | {state,version}')"
panel GET "/api/plugins/$PLUGIN_ID/notes"; expect_code 200 'plugin route after the update'
pass "$NEXT_VERSION published; update held at pending_consent (added packages:read), consented, enabled"

step '7. stop processes'
if [ "${KEEP_RUNNING:-0}" = 1 ]; then pass 'skipped (KEEP_RUNNING=1)'; else stop_processes; pass 'hub and panel stopped'; fi
finish 0
