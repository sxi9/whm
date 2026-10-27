#!/usr/bin/env bash
# WHM control panel installer for systemd-based Linux (Ubuntu/Debian, RHEL/Alma/Rocky).
#
#   sudo bash scripts/install.sh                 # install from this checkout into /opt/whm
#   sudo bash scripts/install.sh --upgrade       # redeploy code, keep data/config, restart
#   sudo WHM_ADMIN_PASSWORD='...' bash scripts/install.sh   # choose the initial password
#   sudo bash scripts/install.sh --with-hub      # also install whm-hub (license server + marketplace)
#   sudo WHM_LICENSE_HUB_URL=https://hub.example.com:7443 bash scripts/install.sh   # pin the vendor hub
#
# What it does: installs Node.js 22 if missing, creates the whmpanel service user,
# copies the application to /opt/whm, installs dependencies and builds the UI,
# writes /etc/whm config, generates a self-signed TLS certificate for the panel,
# installs and starts whm-agentd (root) and whm-panel (unprivileged) units.
# With --with-hub it additionally creates the whmhub user, /etc/whm-hub (hub.conf, hub.env,
# master key, signing keys, download HMAC), /var/lib/whm-hub and /var/log/whm-hub, and
# installs whm-hub.service (HTTPS :7443, loopback :7440). HUB_* variables override the
# hub defaults (HUB_PUBLIC_URL, HUB_DATA_DIR, HUB_ADMIN_EMAIL, HUB_ADMIN_PASSWORD, HUB_SKIP_UI).
# An installed hub is upgraded with --upgrade (no --with-hub needed): code, dependencies, portal
# build and unit are redeployed; hub.conf, hub.env, keys and certificates are never rewritten
# (only an explicit HUB_PUBLIC_URL updates public_url). The data and backup directories are
# read from the installed hub.env/hub.conf, so HUB_DATA_DIR need not be repeated on upgrade.
set -euo pipefail

APP_DIR=${WHM_APP_DIR:-/opt/whm}
ETC_DIR=/etc/whm
DATA_DIR=${WHM_DATA_DIR:-/var/lib/whm}
LOG_DIR=/var/log/whm
SERVICE_USER=whmpanel
NODE_MAJOR=22
UPGRADE=0
SKIP_NODE=0
WITH_HUB=0
HUB_USER=whmhub
HUB_ETC_DIR=/etc/whm-hub
# Explicit overrides are remembered: on an installed hub they are the only values written back.
HUB_DATA_DIR_SET=${HUB_DATA_DIR:+1}
HUB_PUBLIC_URL_SET=${HUB_PUBLIC_URL:+1}
HUB_DATA_DIR=${HUB_DATA_DIR:-/var/lib/whm-hub}
HUB_LOG_DIR=/var/log/whm-hub
HUB_BACKUP_DIR=/var/backups/whm-hub
HUB_PORT=7443
HUB_LOOPBACK_PORT=7440
HUB_SELF_SIGNED=0
for arg in "$@"; do
  case "$arg" in
    --upgrade) UPGRADE=1 ;;
    --skip-node) SKIP_NODE=1 ;;
    --with-hub) WITH_HUB=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
# An installed hub is upgraded together with the panel even without --with-hub.
if [ "$UPGRADE" -eq 1 ] && [ -f /etc/systemd/system/whm-hub.service ]; then WITH_HUB=1; fi

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
command -v systemctl >/dev/null || die "systemd is required"
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$SRC_DIR/package.json" ] && [ -d "$SRC_DIR/server" ] || die "run this script from a WHM checkout (scripts/install.sh)"
if [ "$WITH_HUB" -eq 1 ]; then
  [ -f "$SRC_DIR/hub/package.json" ] && [ -f "$SRC_DIR/hub/src/index.js" ] || die "--with-hub needs the hub/ workspace in this checkout"
fi

if command -v apt-get >/dev/null; then PKG=apt; elif command -v dnf >/dev/null; then PKG=dnf; elif command -v yum >/dev/null; then PKG=yum; else die "no supported package manager (apt-get/dnf/yum)"; fi

install_packages() {
  case "$PKG" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" ;;
    dnf) dnf install -y -q "$@" ;;
    yum) yum install -y -q "$@" ;;
  esac
}

log "Installing build prerequisites"
case "$PKG" in
  apt) apt-get update -q; install_packages ca-certificates curl gnupg openssl build-essential python3 rsync tar ;;
  dnf|yum) install_packages ca-certificates curl openssl gcc-c++ make python3 rsync tar ;;
esac

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; }
if [ "$SKIP_NODE" -eq 0 ] && ! node_ok; then
  log "Installing Node.js $NODE_MAJOR (NodeSource)"
  case "$PKG" in
    apt) curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -; install_packages nodejs ;;
    dnf|yum) curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -; install_packages nodejs ;;
  esac
fi
node_ok || die "Node.js >= $NODE_MAJOR is required (found: $(node --version 2>/dev/null || echo none))"
NODE_BIN=$(command -v node)
log "Using $($NODE_BIN --version) at $NODE_BIN"

# hub_setting <WHM_HUB_* name or -> <hub.conf dotted key>: the effective value of an installed
# hub, resolved the way hub/src/config.js does (hub.env overrides hub.conf). Empty when unset.
hub_setting() {
  local v=""
  if [ "$1" != - ] && [ -f "$HUB_ETC_DIR/hub.env" ]; then v=$(sed -n "s/^$1=//p" "$HUB_ETC_DIR/hub.env" | head -1); fi
  if [ -z "$v" ] && [ -f "$HUB_ETC_DIR/hub.conf" ]; then
    v=$("$NODE_BIN" -e 'let c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
for (const k of process.argv[2].split(".")) c = (c && typeof c === "object") ? c[k] : undefined;
if (typeof c === "string") process.stdout.write(c);' "$HUB_ETC_DIR/hub.conf" "$2")
  fi
  printf '%s' "$v"
}

# An installed hub keeps its directories: the unit's writable paths and every later step follow
# the recorded values, not the defaults. Moving the data directory is a manual operation.
if [ "$WITH_HUB" -eq 1 ] && [ -f "$HUB_ETC_DIR/hub.conf" ]; then
  HUB_RECORDED_DATA_DIR=$(hub_setting WHM_HUB_DB_DIR db_dir)
  if [ -n "$HUB_RECORDED_DATA_DIR" ]; then
    if [ -n "$HUB_DATA_DIR_SET" ] && [ "$HUB_DATA_DIR" != "$HUB_RECORDED_DATA_DIR" ]; then
      die "HUB_DATA_DIR=$HUB_DATA_DIR differs from the installed hub's data directory $HUB_RECORDED_DATA_DIR; stop whm-hub, move the directory and edit $HUB_ETC_DIR/hub.env (WHM_HUB_DB_DIR) and hub.conf (db_dir, marketplace.*) first"
    fi
    HUB_DATA_DIR=$HUB_RECORDED_DATA_DIR
  fi
  HUB_RECORDED_BACKUP_DIR=$(hub_setting - license.backup_dir)
  [ -z "$HUB_RECORDED_BACKUP_DIR" ] || HUB_BACKUP_DIR=$HUB_RECORDED_BACKUP_DIR
  [ -n "$HUB_PUBLIC_URL_SET" ] || HUB_PUBLIC_URL=$(hub_setting WHM_HUB_PUBLIC_URL public_url)
fi
HUB_PUBLIC_URL=${HUB_PUBLIC_URL:-https://$(hostname -f 2>/dev/null || hostname):$HUB_PORT}

create_system_user() {
  local user=$1 home=$2
  if ! id "$user" >/dev/null 2>&1; then
    log "Creating service user $user"
    useradd --system --home-dir "$home" --no-create-home --shell /usr/sbin/nologin "$user" 2>/dev/null \
      || useradd --system --home-dir "$home" --no-create-home --shell /sbin/nologin "$user"
  fi
}

# self_signed_cert <dir> <base name> <owner group>: one certificate per listener, replaceable later.
self_signed_cert() {
  local dir=$1 name=$2 group=$3 host ip
  [ -f "$dir/$name.crt" ] && return 0
  host=$(hostname -f 2>/dev/null || hostname)
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  openssl req -x509 -newkey rsa:2048 -nodes -days 1095 -subj "/CN=$host" \
    -addext "subjectAltName=DNS:$host,IP:${ip:-127.0.0.1}" \
    -keyout "$dir/$name.key" -out "$dir/$name.crt" >/dev/null 2>&1
  chown root:"$group" "$dir/$name.key" "$dir/$name.crt"
  chmod 0640 "$dir/$name.key" "$dir/$name.crt"
}

create_system_user "$SERVICE_USER" "$DATA_DIR"

log "Deploying application to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude '*/node_modules' --exclude 'client/dist' --exclude 'hub/ui/dist' --exclude data --exclude '.git' \
  "$SRC_DIR"/ "$APP_DIR"/

log "Installing dependencies and building the web interface"
( cd "$APP_DIR" && npm ci --no-audit --no-fund && npm run build --workspace client && npm prune --omit=dev --no-audit --no-fund )
if [ "$WITH_HUB" -eq 1 ]; then
  log "Installing hub dependencies"
  ( cd "$APP_DIR/hub" && npm ci --omit=dev --no-audit --no-fund )
  # The portal is its own npm package (not a root workspace): npm ci with a lockfile, npm install
  # without one. Build tooling is removed after the build; serve_ui only needs hub/ui/dist.
  if [ "${HUB_SKIP_UI:-0}" = "1" ]; then
    log "HUB_SKIP_UI=1: hub/ui is not built; set serve_ui to false in hub.conf or build it later"
  elif [ -f "$APP_DIR/hub/ui/package.json" ] && grep -q '"build"' "$APP_DIR/hub/ui/package.json"; then
    log "Building the hub portal (hub/ui)"
    if [ -f "$APP_DIR/hub/ui/package-lock.json" ]; then HUB_UI_INSTALL=(npm ci --no-audit --no-fund); else HUB_UI_INSTALL=(npm install --no-audit --no-fund); fi
    if ( cd "$APP_DIR/hub/ui" && "${HUB_UI_INSTALL[@]}" && npm run build ); then
      rm -rf "$APP_DIR/hub/ui/node_modules"
    else
      log "hub/ui build failed; the hub API still runs, the portal is served once hub/ui/dist exists (set serve_ui accordingly)"
    fi
  else
    log "hub/ui has no build script in this checkout; the hub API runs without the portal (set serve_ui to false if the warning bothers you)"
  fi
fi
chown -R root:root "$APP_DIR"
chmod -R o-w "$APP_DIR"

log "Preparing $ETC_DIR, $DATA_DIR, $LOG_DIR"
install -d -m 0750 -o root -g "$SERVICE_USER" "$ETC_DIR" "$ETC_DIR/ssl"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/plugins" "$LOG_DIR"
[ -f "$ETC_DIR/whm.conf" ] || install -m 0640 -o root -g "$SERVICE_USER" "$APP_DIR/deploy/whm.conf.example" "$ETC_DIR/whm.conf"
[ -f "$ETC_DIR/agent.conf" ] || install -m 0640 -o root -g root "$APP_DIR/deploy/agent.conf.example" "$ETC_DIR/agent.conf"
if [ ! -f "$ETC_DIR/panel.env" ]; then
  install -m 0640 -o root -g "$SERVICE_USER" "$APP_DIR/deploy/panel.env.example" "$ETC_DIR/panel.env"
  if [ -n "${WHM_ADMIN_PASSWORD:-}" ]; then printf 'WHM_ADMIN_PASSWORD=%s\n' "$WHM_ADMIN_PASSWORD" >> "$ETC_DIR/panel.env"; fi
fi

# License hub for the panel (Basic WebHost Manager Setup > License). Non-interactive via
# WHM_LICENSE_HUB_URL; --with-hub defaults to the hub installed on this host; otherwise ask
# once on a terminal. An existing WHM_LICENSE_HUB_URL line in panel.env is never changed.
if ! grep -q '^WHM_LICENSE_HUB_URL=' "$ETC_DIR/panel.env"; then
  LICENSE_HUB_URL=${WHM_LICENSE_HUB_URL:-}
  if [ -z "$LICENSE_HUB_URL" ] && [ "$WITH_HUB" -eq 1 ]; then
    LICENSE_HUB_URL=$HUB_PUBLIC_URL
  fi
  if [ -z "$LICENSE_HUB_URL" ] && [ -t 0 ] && [ "$UPGRADE" -eq 0 ]; then
    printf 'License hub URL for this panel (https://..., blank to configure later via WHM_LICENSE_HUB_URL): '
    read -r LICENSE_HUB_URL || LICENSE_HUB_URL=""
  fi
  if [ -n "$LICENSE_HUB_URL" ]; then
    case "$LICENSE_HUB_URL" in
      https://*) printf 'WHM_LICENSE_HUB_URL=%s\n' "$LICENSE_HUB_URL" >> "$ETC_DIR/panel.env" ;;
      *) die "WHM_LICENSE_HUB_URL must start with https:// (got: $LICENSE_HUB_URL)" ;;
    esac
  fi
fi

if [ ! -f "$ETC_DIR/ssl/panel.crt" ]; then
  log "Generating a self-signed TLS certificate for the panel (replace via SSL/TLS › Manage Service SSL Certificates)"
  self_signed_cert "$ETC_DIR/ssl" panel "$SERVICE_USER"
fi

# hub_conf_set <hub.conf> key=value...: hub.conf is JSON, so values are set with node instead
# of sed and nothing is interpolated into the document. Arguments arrive as argv, never as code.
hub_conf_set() {
  "$NODE_BIN" - "$@" <<'EOF'
const fs = require('node:fs');
const [file, ...pairs] = process.argv.slice(2);
const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const pair of pairs) {
  const i = pair.indexOf('=');
  const keys = pair.slice(0, i).split('.');
  let cur = conf;
  for (const k of keys.slice(0, -1)) cur = (cur[k] && typeof cur[k] === 'object') ? cur[k] : (cur[k] = {});
  cur[keys.at(-1)] = pair.slice(i + 1);
}
fs.writeFileSync(file, JSON.stringify(conf, null, 2) + '\n');
EOF
}

install_hub() {
  local conf="$HUB_ETC_DIR/hub.conf" conf_new=0

  log "Preparing $HUB_ETC_DIR, $HUB_DATA_DIR, $HUB_LOG_DIR"
  create_system_user "$HUB_USER" "$HUB_DATA_DIR"
  install -d -m 0750 -o root -g "$HUB_USER" "$HUB_ETC_DIR" "$HUB_ETC_DIR/ssl"
  install -d -m 0700 -o "$HUB_USER" -g "$HUB_USER" "$HUB_ETC_DIR/keys"
  install -d -m 0750 -o "$HUB_USER" -g "$HUB_USER" "$HUB_DATA_DIR" "$HUB_DATA_DIR/packages" "$HUB_LOG_DIR" "$HUB_BACKUP_DIR"
  if [ ! -f "$conf" ]; then
    install -m 0640 -o root -g "$HUB_USER" "$APP_DIR/deploy/hub.conf.example" "$conf"
    conf_new=1
  fi
  if [ ! -f "$HUB_ETC_DIR/hub.env" ]; then
    {
      echo "# Environment for whm-hub.service (mode 0640 root:$HUB_USER). WHM_HUB_* keys override hub.conf."
      echo "NODE_ENV=production"
      echo "WHM_HUB_CONFIG=$conf"
      echo "WHM_HUB_DB_DIR=$HUB_DATA_DIR"
      echo "WHM_HUB_LOG_LEVEL=info"
      echo "# Billing webhook secrets live here, never in hub.conf. The GitHub OAuth client secret has no"
      echo "# environment variable: it goes in hub.conf (marketplace.github_oauth.client_secret or client_secret_enc)."
      echo "# WHM_HUB_STRIPE_SECRET="
      echo "# WHM_HUB_WHMCS_SECRET="
      echo "# WHM_HUB_PADDLE_SECRET="
    } > "$HUB_ETC_DIR/hub.env"
    chown root:"$HUB_USER" "$HUB_ETC_DIR/hub.env"; chmod 0640 "$HUB_ETC_DIR/hub.env"
  fi
  if [ ! -f "$HUB_ETC_DIR/ssl/hub.crt" ]; then
    log "Generating a self-signed TLS certificate for the hub (replace $HUB_ETC_DIR/ssl/hub.{crt,key} with a real one; panels only talk https)"
    self_signed_cert "$HUB_ETC_DIR/ssl" hub "$HUB_USER"
    HUB_SELF_SIGNED=1
  fi

  # Deployment values are written once, into a hub.conf this run created. An installed hub.conf
  # (public_url, a CA-issued tls.* pair, custom directories) is left alone on --upgrade; only an
  # explicitly supplied HUB_PUBLIC_URL updates public_url.
  if [ "$conf_new" -eq 1 ]; then
    hub_conf_set "$conf" "public_url=$HUB_PUBLIC_URL" \
      "db_dir=$HUB_DATA_DIR" "tls.cert=$HUB_ETC_DIR/ssl/hub.crt" "tls.key=$HUB_ETC_DIR/ssl/hub.key" \
      "keys.dir=$HUB_ETC_DIR/keys" "marketplace.packages_dir=$HUB_DATA_DIR/packages" \
      "marketplace.download_hmac_file=$HUB_ETC_DIR/keys/download.hmac" "marketplace.public_suffix_list=$HUB_DATA_DIR/public_suffix_list.dat" \
      "license.backup_dir=$HUB_BACKUP_DIR"
  elif [ -n "$HUB_PUBLIC_URL_SET" ]; then
    log "Updating public_url in $conf (HUB_PUBLIC_URL given)"
    hub_conf_set "$conf" "public_url=$HUB_PUBLIC_URL"
  fi

  # Keys: master key (AES-256-GCM for stored secrets), download HMAC, one LICENSE and one
  # PLUGIN signing key (the first key of a purpose becomes active). gen-key.js runs as root
  # and the results are handed to the service user afterwards.
  local genkey=("$NODE_BIN" "$APP_DIR/hub/scripts/gen-key.js" --config "$conf")
  [ -f "$HUB_ETC_DIR/master.key" ] || { log "Generating the hub master key"; "${genkey[@]}" --master >/dev/null; }
  [ -f "$HUB_ETC_DIR/keys/download.hmac" ] || { log "Generating the download URL HMAC key"; "${genkey[@]}" --hmac >/dev/null; }
  HUB_LICENSE_KEY_JSON=""
  HUB_PLUGIN_KEY_JSON=""
  if ! ls "$HUB_ETC_DIR/keys"/*.ed25519 >/dev/null 2>&1; then
    log "Generating the hub signing keys (purpose license + plugin)"
    HUB_LICENSE_KEY_JSON=$("${genkey[@]}" --license --json)
    HUB_PLUGIN_KEY_JSON=$("${genkey[@]}" --plugin --json)
    # Record the active kids in hub.conf (informational: the signing_keys table is authoritative).
    hub_conf_set "$conf" "keys.active_kid.license=$("$NODE_BIN" -p 'JSON.parse(process.argv[1]).kid' "$HUB_LICENSE_KEY_JSON")" \
      "keys.active_kid.plugin=$("$NODE_BIN" -p 'JSON.parse(process.argv[1]).kid' "$HUB_PLUGIN_KEY_JSON")"
  fi
  chown -R "$HUB_USER":"$HUB_USER" "$HUB_ETC_DIR/keys" "$HUB_DATA_DIR" "$HUB_LOG_DIR" "$HUB_BACKUP_DIR"
  chown "$HUB_USER":"$HUB_USER" "$HUB_ETC_DIR/master.key"
  chmod 0600 "$HUB_ETC_DIR/master.key" "$HUB_ETC_DIR/keys"/*
  chmod 0700 "$HUB_ETC_DIR/keys"

  log "Installing whm-hub.service"
  # ReadWritePaths follow the recorded data and backup directories (ProtectSystem=strict).
  sed "s#/usr/bin/node#$NODE_BIN#g; s#/opt/whm#$APP_DIR#g; s#/var/lib/whm-hub#$HUB_DATA_DIR#g; s#/var/backups/whm-hub#$HUB_BACKUP_DIR#g" "$APP_DIR/deploy/whm-hub.service" > /etc/systemd/system/whm-hub.service
  systemctl daemon-reload
  systemctl enable whm-hub >/dev/null
  systemctl restart whm-hub

  if [ "$UPGRADE" -eq 0 ] && [ -n "${HUB_ADMIN_EMAIL:-}" ]; then
    log "Creating the vendor admin portal user $HUB_ADMIN_EMAIL"
    HUB_ADMIN_OUT=$(cd "$APP_DIR/hub" && WHM_HUB_CONFIG="$conf" WHM_HUB_ADMIN_PASSWORD="${HUB_ADMIN_PASSWORD:-}" "$NODE_BIN" scripts/hub-cli.js create-admin "$HUB_ADMIN_EMAIL" --json) || HUB_ADMIN_OUT=""
    chown -R "$HUB_USER":"$HUB_USER" "$HUB_DATA_DIR"
  fi
}

if [ "$WITH_HUB" -eq 1 ]; then install_hub; fi

# A panel on the same host trusts the hub's freshly generated self-signed certificate through
# WHM_LICENSE_HUB_CA (a copy readable by whmpanel). Only written for a certificate this run
# generated: a CA-issued hub certificate must not be pinned as a CA.
if [ "${HUB_SELF_SIGNED:-0}" -eq 1 ] && ! grep -q '^WHM_LICENSE_HUB_CA=' "$ETC_DIR/panel.env"; then
  install -m 0640 -o root -g "$SERVICE_USER" "$HUB_ETC_DIR/ssl/hub.crt" "$ETC_DIR/hub-ca.pem"
  printf 'WHM_LICENSE_HUB_CA=%s\n' "$ETC_DIR/hub-ca.pem" >> "$ETC_DIR/panel.env"
fi

log "Installing systemd units"
sed "s#/usr/bin/node#$NODE_BIN#g; s#/opt/whm#$APP_DIR#g" "$APP_DIR/deploy/whm-agentd.service" > /etc/systemd/system/whm-agentd.service
sed "s#/usr/bin/node#$NODE_BIN#g; s#/opt/whm#$APP_DIR#g; s#/var/lib/whm#$DATA_DIR#g" "$APP_DIR/deploy/whm-panel.service" > /etc/systemd/system/whm-panel.service
systemctl daemon-reload
systemctl enable whm-agentd whm-panel >/dev/null
systemctl restart whm-agentd
sleep 1
systemctl restart whm-panel

sleep 2
if systemctl is-active --quiet whm-panel; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  log "WHM is running"
  echo
  echo "  URL:       https://${IP:-<server-ip>}:2087/   (HTTP: http://${IP:-<server-ip>}:2086/)"
  echo "  Login:     root"
  if [ -f "$DATA_DIR/initial-admin-password.txt" ]; then
    echo "  Password:  $(awk '/^password:/{print $2}' "$DATA_DIR/initial-admin-password.txt")   (from $DATA_DIR/initial-admin-password.txt — delete it after logging in)"
  else
    echo "  Password:  the WHM_ADMIN_PASSWORD you set, or the existing one (upgrade)"
  fi
  echo
  echo "  Logs:      journalctl -u whm-panel -u whm-agentd -f"
  echo "  Firewall:  allow TCP 2086 and 2087"
  if grep -q '^WHM_LICENSE_HUB_URL=' "$ETC_DIR/panel.env"; then
    echo "  License:   hub $(sed -n 's/^WHM_LICENSE_HUB_URL=//p' "$ETC_DIR/panel.env" | head -1) — enter the key under Server Configuration › Basic WebHost Manager Setup › License"
  fi
else
  die "whm-panel failed to start; see: journalctl -u whm-panel -n 50"
fi

if [ "$WITH_HUB" -eq 1 ]; then
  sleep 1
  if systemctl is-active --quiet whm-hub; then
    log "whm-hub is running"
    echo
    echo "  Hub URL:   $(hub_setting WHM_HUB_PUBLIC_URL public_url)   (HTTPS :$HUB_PORT; /healthz and /metrics on 127.0.0.1:$HUB_LOOPBACK_PORT)"
    echo "  Config:    $HUB_ETC_DIR/hub.conf, $HUB_ETC_DIR/hub.env; keys in $HUB_ETC_DIR/keys; data in $HUB_DATA_DIR"
    echo "  Logs:      journalctl -u whm-hub -f"
    echo "  Firewall:  allow TCP $HUB_PORT (never expose $HUB_LOOPBACK_PORT)"
    if [ -n "${HUB_LICENSE_KEY_JSON:-}" ]; then
      echo
      echo "  Signing keys generated (pin the LICENSE key in server/src/services/license-keys.json of every panel release"
      echo "  that must trust this hub, or point WHM_LICENSE_KEYS_FILE at a file with the same shape):"
      echo
      printf '%s\n' "$HUB_LICENSE_KEY_JSON" | "$NODE_BIN" -e '
const k = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
console.log(`  license key   kid ${k.kid}  (${k.file})`);
console.log(JSON.stringify({ kid: k.kid, pub: k.pub, not_after: null }, null, 2).replace(/^/gm, "  "));'
      printf '%s\n' "$HUB_PLUGIN_KEY_JSON" | "$NODE_BIN" -e '
const k = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
console.log(`\n  plugin key    kid ${k.kid}  (${k.file}) — panels pin it automatically from license activation; no manual step`);'
    fi
    if [ -n "${HUB_ADMIN_OUT:-}" ]; then
      echo
      printf '%s\n' "$HUB_ADMIN_OUT" | "$NODE_BIN" -e '
const u = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
console.log(`  Portal admin: ${u.email}  password: ${u.password}`);'
    else
      echo
      echo "  Portal admin: cd $APP_DIR/hub && sudo WHM_HUB_CONFIG=$HUB_ETC_DIR/hub.conf node scripts/hub-cli.js create-admin you@example.com"
    fi
    echo "  First license: cd $APP_DIR/hub && sudo WHM_HUB_CONFIG=$HUB_ETC_DIR/hub.conf node scripts/hub-cli.js issue whm-pro-annual customer@example.com --months 12"
  else
    echo "whm-hub failed to start; see: journalctl -u whm-hub -n 50" >&2
  fi
fi
