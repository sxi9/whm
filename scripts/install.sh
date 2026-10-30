#!/usr/bin/env bash
# WHM control panel installer for systemd-based Linux (Ubuntu/Debian, RHEL/Alma/Rocky).
#
#   sudo bash scripts/install.sh                 # install from this checkout into /opt/whm
#   sudo bash scripts/install.sh --upgrade       # redeploy code, keep data/config, restart
#   sudo WHM_ADMIN_PASSWORD='...' bash scripts/install.sh   # choose the initial password
#   sudo bash scripts/install.sh --with-hub      # also install whm-hub (license server + marketplace)
#   sudo WHM_LICENSE_HUB_URL=https://hub.example.com:7443 bash scripts/install.sh   # pin another hub
#   sudo WHM_SUPERADMIN_SETUP_PASSWORD='...' bash scripts/install.sh   # super admin setup password, non-interactive
#   sudo bash scripts/install.sh --stack full    # also install the full hosting stack (web, PHP, MariaDB, DNS, mail, FTP, ...)
#   sudo bash scripts/install.sh --stack web     # Apache, PHP, MariaDB, Let's Encrypt, quotas, firewall only
#   sudo bash scripts/install.sh --stack none    # no host software now (the setup wizard and Service Manager install it later)
#   sudo bash scripts/install.sh --components apache,php,mysql,bind   # manual selection from the stack catalog
#
# What it does: installs Node.js 22 if missing, creates the whmpanel service user,
# copies the application to /opt/whm, installs dependencies and builds the UI,
# writes /etc/whm config, generates a self-signed TLS certificate for the panel
# (/etc/whm/tls/cert.pem + key.pem, the pair the hostname certificate step later
# replaces in place), optionally installs a hosting stack from the panel's own
# catalog (server/src/lib/stack-catalog.js: --stack full|web|none, --components a,b,c,
# or a menu on a terminal; WHM_STACK / WHM_STACK_COMPONENTS non-interactively),
# installs and starts whm-agentd (root) and whm-panel (unprivileged) units.
# The license hub defaults to https://licserver.hostingsignal.in (the vendor hub); only the
# super admin of the panel ever sees it. The super admin setup password (asked once on a
# terminal, or WHM_SUPERADMIN_SETUP_PASSWORD) is stored as a bcrypt hash in
# /etc/whm/superadmin.key (0600 root:root, in a directory the panel user cannot write);
# without it `whm-cli superadmin <user>` refuses.
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
TLS_DIR=$ETC_DIR/tls
LEGACY_TLS_DIR=$ETC_DIR/ssl
# Hosting stack: a profile key from the catalog (full, web) or none; --components lists
# component keys by hand. Empty = ask on a terminal (first install only), otherwise skip.
STACK=${WHM_STACK:-}
STACK_COMPONENTS=${WHM_STACK_COMPONENTS:-}
STACK_RESULT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --upgrade) UPGRADE=1 ;;
    --skip-node) SKIP_NODE=1 ;;
    --with-hub) WITH_HUB=1 ;;
    --stack) [ $# -ge 2 ] || { echo "--stack needs a value: full, web or none" >&2; exit 2; }; STACK=$2; shift ;;
    --stack=*) STACK=${1#--stack=} ;;
    --components) [ $# -ge 2 ] || { echo "--components needs a comma-separated list of component keys" >&2; exit 2; }; STACK_COMPONENTS=$2; shift ;;
    --components=*) STACK_COMPONENTS=${1#--components=} ;;
    -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$STACK" in
  ''|full|web|none) ;;
  manual) STACK=none ;;
  *) echo "unknown --stack profile: $STACK (use full, web or none)" >&2; exit 2 ;;
esac
if [ -n "$STACK_COMPONENTS" ]; then
  case "$STACK_COMPONENTS" in
    *[!a-z0-9,_-]*) echo "--components takes lowercase component keys separated by commas (got: $STACK_COMPONENTS)" >&2; exit 2 ;;
  esac
  STACK=components
fi
# An installed hub is upgraded together with the panel even without --with-hub.
if [ "$UPGRADE" -eq 1 ] && [ -f /etc/systemd/system/whm-hub.service ]; then WITH_HUB=1; fi

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

printf '\n\033[1m  HST Panel by Hostingsignal\033[0m  -  WHM control panel %s\n' "$([ "$UPGRADE" -eq 1 ] && echo upgrade || echo installer)"
printf '  %s\n\n' "Questions are asked on a terminal only; every answer can be given up front with the variables and flags named in --help."

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
command -v systemctl >/dev/null || die "systemd is required"
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$SRC_DIR/package.json" ] && [ -d "$SRC_DIR/server" ] || die "run this script from a WHM checkout (scripts/install.sh)"
if [ "$WITH_HUB" -eq 1 ]; then
  [ -f "$SRC_DIR/hub/package.json" ] && [ -f "$SRC_DIR/hub/src/index.js" ] || die "--with-hub needs the hub/ workspace in this checkout"
fi

if command -v apt-get >/dev/null; then PKG=apt; elif command -v dnf >/dev/null; then PKG=dnf; elif command -v yum >/dev/null; then PKG=yum; else die "no supported package manager (apt-get/dnf/yum)"; fi

# package_offered <name>: whether the package manager can install it (installed or in a
# repository). dpkg/apt need the index refreshed first (done before the first install).
package_offered() {
  case "$PKG" in
    apt) apt-cache show -- "$1" >/dev/null 2>&1 ;;
    dnf|yum) "$PKG" -q info -- "$1" >/dev/null 2>&1 || rpm -q -- "$1" >/dev/null 2>&1 ;;
    *) return 0 ;;
  esac
}

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
# Every name and address a client may use to reach this host goes into the SAN list:
# the FQDN and short name, localhost, every local address, the public address a cloud
# NAT hides from `hostname -I` (looked up over HTTPS, best effort), and the host of
# HUB_PUBLIC_URL when it is set. A certificate that only names the private address
# is refused by the panel as soon as it connects through the public one.
cert_sans() {
  local host=$1 extra=${2:-} out="DNS:$host,DNS:localhost,IP:127.0.0.1" short ip pub
  short=$(hostname -s 2>/dev/null || true)
  [ -n "$short" ] && [ "$short" != "$host" ] && out="$out,DNS:$short"
  for ip in $(hostname -I 2>/dev/null); do
    case ",$out," in *",IP:$ip,"*) ;; *) out="$out,IP:$ip" ;; esac
  done
  pub=$(curl -4 -fsS --max-time 4 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
  if printf '%s' "$pub" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
    case ",$out," in *",IP:$pub,"*) ;; *) out="$out,IP:$pub" ;; esac
  fi
  if [ -n "$extra" ]; then
    if printf '%s' "$extra" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
      case ",$out," in *",IP:$extra,"*) ;; *) out="$out,IP:$extra" ;; esac
    elif printf '%s' "$extra" | grep -Eq '^[A-Za-z0-9.-]+$'; then
      case ",$out," in *",DNS:$extra,"*) ;; *) out="$out,DNS:$extra" ;; esac
    fi
  fi
  printf '%s' "$out"
}

self_signed_cert() {
  local dir=$1 name=$2 group=$3 extra=${4:-} host sans
  [ -f "$dir/$name.crt" ] && return 0
  host=$(hostname -f 2>/dev/null || hostname)
  sans=$(cert_sans "$host" "$extra")
  openssl req -x509 -newkey rsa:2048 -nodes -days 1095 -subj "/CN=$host" \
    -addext "subjectAltName=$sans" \
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
# One install at the project root: server, agent, client, hub and hub/ui are all npm
# workspaces of the root lockfile, so their packages are hoisted into one node_modules.
# Running npm ci inside hub/ again would wipe that tree (the panel then fails with
# "Cannot find package 'better-sqlite3'"). Dev tooling is pruned once every build is done.
( cd "$APP_DIR" && npm ci --no-audit --no-fund && npm run build --workspace client ) || die "npm ci / client build failed"
if [ "$WITH_HUB" -eq 1 ]; then
  if [ "${HUB_SKIP_UI:-0}" = "1" ]; then
    log "HUB_SKIP_UI=1: hub/ui is not built; set serve_ui to false in hub.conf or build it later"
  elif [ -f "$APP_DIR/hub/ui/package.json" ] && grep -q '"build"' "$APP_DIR/hub/ui/package.json"; then
    log "Building the hub portal (hub/ui)"
    if ! ( cd "$APP_DIR" && npm run build --workspace hub/ui ); then
      log "hub/ui build failed; the hub API still runs, the portal is served once hub/ui/dist exists (set serve_ui accordingly)"
    fi
  else
    log "hub/ui has no build script in this checkout; the hub API runs without the portal (set serve_ui to false if the warning bothers you)"
  fi
fi
( cd "$APP_DIR" && npm prune --omit=dev --no-audit --no-fund ) || log "npm prune failed; dev dependencies stay installed (harmless)"
chown -R root:root "$APP_DIR"
chmod -R o-w "$APP_DIR"

log "Preparing $ETC_DIR, $DATA_DIR, $LOG_DIR"
# $TLS_DIR holds the pair the panel listener reads (whm.conf tlsCert/tlsKey): the self-signed
# bootstrap pair now, the hostname certificate once Change Hostname installs it there
# (ssl.service_cert.install writes cert.pem/key.pem into this directory and the listener
# picks the new files up without a restart). root:whmpanel 0750, so the unprivileged panel
# can read what the root agent writes.
install -d -m 0750 -o root -g "$SERVICE_USER" "$ETC_DIR" "$TLS_DIR"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/plugins" "$LOG_DIR"
[ -f "$ETC_DIR/whm.conf" ] || install -m 0640 -o root -g "$SERVICE_USER" "$APP_DIR/deploy/whm.conf.example" "$ETC_DIR/whm.conf"
[ -f "$ETC_DIR/agent.conf" ] || install -m 0640 -o root -g root "$APP_DIR/deploy/agent.conf.example" "$ETC_DIR/agent.conf"
if [ ! -f "$ETC_DIR/panel.env" ]; then
  install -m 0640 -o root -g "$SERVICE_USER" "$APP_DIR/deploy/panel.env.example" "$ETC_DIR/panel.env"
  if [ -n "${WHM_ADMIN_PASSWORD:-}" ]; then printf 'WHM_ADMIN_PASSWORD=%s\n' "$WHM_ADMIN_PASSWORD" >> "$ETC_DIR/panel.env"; fi
fi

# License hub for the panel (Basic WebHost Manager Setup > License). Non-interactive via
# WHM_LICENSE_HUB_URL; --with-hub defaults to the hub installed on this host; otherwise ask
# once on a terminal with the vendor hub as the default (the panel itself falls back to it
# when the variable is unset). An existing WHM_LICENSE_HUB_URL line in panel.env is never changed.
DEFAULT_LICENSE_HUB_URL=https://licserver.hostingsignal.in
if ! grep -q '^WHM_LICENSE_HUB_URL=' "$ETC_DIR/panel.env"; then
  LICENSE_HUB_URL=${WHM_LICENSE_HUB_URL:-}
  if [ -z "$LICENSE_HUB_URL" ] && [ "$WITH_HUB" -eq 1 ]; then
    LICENSE_HUB_URL=$HUB_PUBLIC_URL
  fi
  if [ -z "$LICENSE_HUB_URL" ] && [ -t 0 ] && [ "$UPGRADE" -eq 0 ]; then
    printf 'License hub URL for this panel [%s]: ' "$DEFAULT_LICENSE_HUB_URL"
    read -r LICENSE_HUB_URL || LICENSE_HUB_URL=""
    LICENSE_HUB_URL=${LICENSE_HUB_URL:-$DEFAULT_LICENSE_HUB_URL}
  fi
  if [ -n "$LICENSE_HUB_URL" ]; then
    case "$LICENSE_HUB_URL" in
      https://*) printf 'WHM_LICENSE_HUB_URL=%s\n' "$LICENSE_HUB_URL" >> "$ETC_DIR/panel.env" ;;
      *) die "WHM_LICENSE_HUB_URL must start with https:// (got: $LICENSE_HUB_URL)" ;;
    esac
  fi
fi

# Super admin setup password: its bcrypt hash goes to $ETC_DIR/superadmin.key (0600 root:root;
# $ETC_DIR is root-owned, so the panel user can neither read nor replace it). `whm-cli superadmin
# <user>` grants the flag only after this password verifies; without the file the command refuses
# and points at `superadmin --init`. Non-interactive via WHM_SUPERADMIN_SETUP_PASSWORD; asked once
# on a terminal; never rewritten. A key an earlier build left in $DATA_DIR moves here.
if [ -f "$DATA_DIR/superadmin.key" ] && [ ! -f "$ETC_DIR/superadmin.key" ]; then
  log "Moving $DATA_DIR/superadmin.key to $ETC_DIR/superadmin.key"
  mv "$DATA_DIR/superadmin.key" "$ETC_DIR/superadmin.key"
  chown root:root "$ETC_DIR/superadmin.key"; chmod 0600 "$ETC_DIR/superadmin.key"
fi
if [ ! -f "$ETC_DIR/superadmin.key" ]; then
  SUPERADMIN_SETUP_PASSWORD=${WHM_SUPERADMIN_SETUP_PASSWORD:-}
  if [ -z "$SUPERADMIN_SETUP_PASSWORD" ] && [ -t 0 ] && [ "$UPGRADE" -eq 0 ]; then
    printf 'Super admin setup password (at least 12 characters; blank to set it later with "whm-cli superadmin --init"): '
    read -rs SUPERADMIN_SETUP_PASSWORD || SUPERADMIN_SETUP_PASSWORD=""
    echo
    if [ -n "$SUPERADMIN_SETUP_PASSWORD" ]; then
      printf 'Repeat it: '
      read -rs SUPERADMIN_SETUP_PASSWORD_AGAIN || SUPERADMIN_SETUP_PASSWORD_AGAIN=""
      echo
      [ "$SUPERADMIN_SETUP_PASSWORD" = "$SUPERADMIN_SETUP_PASSWORD_AGAIN" ] || die "the super admin setup passwords do not match"
    fi
  fi
  if [ -n "$SUPERADMIN_SETUP_PASSWORD" ]; then
    log "Storing the super admin setup password hash in $ETC_DIR/superadmin.key"
    WHM_CONFIG="$ETC_DIR/whm.conf" WHM_DATA_DIR="$DATA_DIR" WHM_SUPERADMIN_KEY_FILE="$ETC_DIR/superadmin.key" WHM_SUPERADMIN_SETUP_PASSWORD="$SUPERADMIN_SETUP_PASSWORD" \
      "$NODE_BIN" "$APP_DIR/scripts/whm-cli.js" superadmin --init >/dev/null
    chown root:root "$ETC_DIR/superadmin.key"; chmod 0600 "$ETC_DIR/superadmin.key"
  else
    log "No super admin setup password given: run \"sudo node $APP_DIR/scripts/whm-cli.js superadmin --init\" before granting the super admin"
  fi
  unset SUPERADMIN_SETUP_PASSWORD SUPERADMIN_SETUP_PASSWORD_AGAIN
fi

# json_conf_set <file.conf> key=value...: whm.conf and hub.conf are JSON, so values are set
# with node instead of sed and nothing is interpolated into the document. Arguments arrive
# as argv, never as code.
json_conf_set() {
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

# json_conf_get <file.conf> <dotted key>: prints a string value, empty when unset.
json_conf_get() {
  [ -f "$1" ] || return 0
  "$NODE_BIN" -e 'let c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
for (const k of process.argv[2].split(".")) c = (c && typeof c === "object") ? c[k] : undefined;
if (typeof c === "string") process.stdout.write(c);' "$1" "$2"
}

# Panel TLS. A fresh install gets a self-signed pair in $TLS_DIR. An install from an earlier
# build has whm.conf pointing at $LEGACY_TLS_DIR/panel.{crt,key}, where the hostname
# certificate step never writes: that pair is copied to $TLS_DIR and whm.conf is pointed
# there, so the panel keeps serving the same certificate and later installs become live.
# Explicit WHM_TLS_CERT/WHM_TLS_KEY lines in panel.env are respected and left alone.
if [ "$(json_conf_get "$ETC_DIR/whm.conf" tlsCert)" = "$LEGACY_TLS_DIR/panel.crt" ] && ! grep -q '^WHM_TLS_CERT=' "$ETC_DIR/panel.env"; then
  if [ -f "$LEGACY_TLS_DIR/panel.crt" ] && [ -f "$LEGACY_TLS_DIR/panel.key" ]; then
    log "Moving the panel certificate from $LEGACY_TLS_DIR/panel.{crt,key} to $TLS_DIR/{cert,key}.pem"
    [ -f "$TLS_DIR/cert.pem" ] || install -m 0640 -o root -g "$SERVICE_USER" "$LEGACY_TLS_DIR/panel.crt" "$TLS_DIR/cert.pem"
    [ -f "$TLS_DIR/key.pem" ] || install -m 0640 -o root -g "$SERVICE_USER" "$LEGACY_TLS_DIR/panel.key" "$TLS_DIR/key.pem"
  fi
  json_conf_set "$ETC_DIR/whm.conf" "tlsCert=$TLS_DIR/cert.pem" "tlsKey=$TLS_DIR/key.pem"
fi
if [ ! -f "$TLS_DIR/cert.pem" ] || [ ! -f "$TLS_DIR/key.pem" ]; then
  log "Generating a self-signed TLS certificate for the panel in $TLS_DIR (Change Hostname replaces it with a Let's Encrypt one; SSL/TLS › Manage Service SSL Certificates installs your own)"
  rm -f "$TLS_DIR/cert.pem" "$TLS_DIR/key.pem"
  self_signed_cert "$TLS_DIR" panel "$SERVICE_USER"
  mv "$TLS_DIR/panel.crt" "$TLS_DIR/cert.pem"
  mv "$TLS_DIR/panel.key" "$TLS_DIR/key.pem"
fi

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
    HUB_PUBLIC_HOST=$(printf '%s' "$HUB_PUBLIC_URL" | sed -E 's#^[a-z]+://##; s#[:/].*$##')
    self_signed_cert "$HUB_ETC_DIR/ssl" hub "$HUB_USER" "$HUB_PUBLIC_HOST"
    HUB_SELF_SIGNED=1
  fi

  # Deployment values are written once, into a hub.conf this run created. An installed hub.conf
  # (public_url, a CA-issued tls.* pair, custom directories) is left alone on --upgrade; only an
  # explicitly supplied HUB_PUBLIC_URL updates public_url.
  if [ "$conf_new" -eq 1 ]; then
    json_conf_set "$conf" "public_url=$HUB_PUBLIC_URL" \
      "db_dir=$HUB_DATA_DIR" "tls.cert=$HUB_ETC_DIR/ssl/hub.crt" "tls.key=$HUB_ETC_DIR/ssl/hub.key" \
      "keys.dir=$HUB_ETC_DIR/keys" "marketplace.packages_dir=$HUB_DATA_DIR/packages" \
      "marketplace.download_hmac_file=$HUB_ETC_DIR/keys/download.hmac" "marketplace.public_suffix_list=$HUB_DATA_DIR/public_suffix_list.dat" \
      "license.backup_dir=$HUB_BACKUP_DIR"
  elif [ -n "$HUB_PUBLIC_URL_SET" ]; then
    log "Updating public_url in $conf (HUB_PUBLIC_URL given)"
    json_conf_set "$conf" "public_url=$HUB_PUBLIC_URL"
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
    json_conf_set "$conf" "keys.active_kid.license=$("$NODE_BIN" -p 'JSON.parse(process.argv[1]).kid' "$HUB_LICENSE_KEY_JSON")" \
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

# A panel installed next to its hub trusts the hub's license signing key without a manual
# step: the key this run generated is merged into /etc/whm/license-keys.json (shape
# { "keys": [ { kid, pub, not_after } ] }) and the panel is pointed at that file. Nothing
# from the key is interpolated into shell; node reads it from the environment.
if [ -n "${HUB_LICENSE_KEY_JSON:-}" ]; then
  LICENSE_KEYS_FILE=$ETC_DIR/license-keys.json
  [ -f "$LICENSE_KEYS_FILE" ] || printf '{ "keys": [] }\n' > "$LICENSE_KEYS_FILE"
  HUB_LICENSE_KEY_JSON="$HUB_LICENSE_KEY_JSON" "$NODE_BIN" -e '
const fs = require("node:fs");
const file = process.argv[1];
const k = JSON.parse(process.env.HUB_LICENSE_KEY_JSON);
let doc = { keys: [] };
try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
if (!Array.isArray(doc.keys)) doc.keys = [];
if (!doc.keys.some((e) => e && e.kid === k.kid)) doc.keys.push({ kid: k.kid, pub: k.pub, not_after: null });
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
console.log(`  pinned hub license key ${k.kid} in ${file}`);' -- "$LICENSE_KEYS_FILE"
  chown root:"$SERVICE_USER" "$LICENSE_KEYS_FILE"; chmod 0640 "$LICENSE_KEYS_FILE"
  if ! grep -q '^WHM_LICENSE_KEYS_FILE=' "$ETC_DIR/panel.env"; then
    printf 'WHM_LICENSE_KEYS_FILE=%s\n' "$LICENSE_KEYS_FILE" >> "$ETC_DIR/panel.env"
  fi
fi


# ---------------------------------------------------------------- hosting stack ---
# The panel's stack catalog (server/src/lib/stack-catalog.js) is the single source of
# truth for what a profile installs: package names per family, the systemd units to
# enable, Apache modules to switch on and the PostgreSQL initdb step. The same catalog
# drives the setup wizard and Service Manager › Server stack, so an install from here and
# one from the panel end in the same state. The catalog is read with node; nothing from
# it is evaluated as shell.
STACK_CATALOG=$APP_DIR/server/src/lib/stack-catalog.js

# stack_profiles: one line per profile, "key<TAB>label<TAB>description".
stack_profiles() {
  "$NODE_BIN" --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const m = await import(pathToFileURL(process.argv[1]).href);
for (const p of m.STACK_PROFILES) console.log([p.key, p.label, p.description].join("\t"));
' -- "$STACK_CATALOG"
}

# stack_plan <full|web|components> <component list> <debian|rhel>: tab-separated plan lines
# (component, pkg, requires, a2enmod, enable, initdb). Exits 2 on an unknown key.
stack_plan() {
  "$NODE_BIN" --input-type=module -e '
const [catalog, mode, list, family] = process.argv.slice(1);
const { pathToFileURL } = await import("node:url");
const m = await import(pathToFileURL(catalog).href);
let keys;
if (mode === "components") {
  keys = [...new Set(list.split(",").map((k) => k.trim()).filter(Boolean))];
  const unknown = keys.filter((k) => !m.componentByKey(k));
  if (!keys.length || unknown.length) { console.error(`unknown stack components: ${unknown.join(", ") || "(none given)"}; known keys: ${m.STACK_COMPONENT_KEYS.join(", ")}`); process.exit(2); }
} else {
  keys = m.profileComponents(mode);
  if (!keys) { console.error(`unknown stack profile: ${mode}`); process.exit(2); }
}
const out = [];
for (const key of keys) {
  const c = m.componentByKey(key);
  out.push(["component", c.key, c.label].join("\t"));
  for (const pkg of c.packages?.[family] || []) out.push(["pkg", pkg].join("\t"));
  if (c.requires?.[family]) out.push(["requires", c.key, c.requires[family]].join("\t"));
  for (const step of c.postInstall || []) {
    if (step.kind === "a2enmod") for (const mod of step.modules) out.push(["a2enmod", mod].join("\t"));
    else if (step.kind === "enable") out.push(["enable", (step.units || (step.unit ? [step.unit] : c.units) || []).join(" ")].join("\t"));
    else if (step.kind === "initdb") out.push("initdb");
  }
}
process.stdout.write(out.join("\n") + "\n");
' -- "$STACK_CATALOG" "$1" "$2" "$3"
}

# install_stack <full|web|components> <component list>: packages first, then the Apache
# modules, the PostgreSQL cluster and the units, in the catalog's order. Every failure
# after the package step is logged and skipped: the panel's Service Manager shows the
# remaining work (Install / Repair) once it is up.
install_stack() {
  local mode=$1 list=$2 family plan kind a b epel=0 initdb=0 unit group
  local -a pkgs=() mods=() enables=() comps=()
  case "$PKG" in apt) family=debian ;; *) family=rhel ;; esac
  plan=$(stack_plan "$mode" "$list" "$family") || { STACK_RESULT="not installed: unknown profile or component (see above)"; return 1; }
  while IFS=$'\t' read -r kind a b; do
    case "$kind" in
      component) comps+=("$a") ;;
      pkg) pkgs+=("$a") ;;
      requires) epel=1; log "$a: $b" ;;
      a2enmod) mods+=("$a") ;;
      enable) enables+=("$a") ;;
      initdb) initdb=1 ;;
    esac
  done <<< "$plan"
  [ ${#pkgs[@]} -gt 0 ] || { STACK_RESULT="nothing to install for ${comps[*]:-no components}"; return 0; }
  mapfile -t pkgs < <(printf '%s\n' "${pkgs[@]}" | awk '!seen[$0]++')
  log "Installing the hosting stack (${comps[*]}): ${#pkgs[@]} packages"
  if [ "$epel" -eq 1 ] && [ "$family" = rhel ]; then
    install_packages epel-release || log "epel-release could not be installed; packages that need EPEL may fail below"
  fi
  # A package the distribution no longer ships (php-opcache is built into PHP ≥ 8.5 on
  # Ubuntu 26.04, for example) would fail the whole transaction; skip it and say so.
  local -a offered=() skipped=()
  local p
  for p in "${pkgs[@]}"; do
    if package_offered "$p"; then offered+=("$p"); else skipped+=("$p"); fi
  done
  [ ${#skipped[@]} -gt 0 ] && log "Not offered by this distribution, skipped: ${skipped[*]}"
  pkgs=("${offered[@]}")
  [ ${#pkgs[@]} -gt 0 ] || { STACK_RESULT="nothing to install: none of the packages is offered by this distribution"; return 0; }
  if ! install_packages "${pkgs[@]}"; then
    STACK_RESULT="package installation failed (see above); re-run with --stack/--components, or use Service Manager › Server stack in the panel"
    return 1
  fi
  if [ ${#mods[@]} -gt 0 ] && command -v a2enmod >/dev/null; then
    mapfile -t mods < <(printf '%s\n' "${mods[@]}" | awk '!seen[$0]++')
    for a in "${mods[@]}"; do a2enmod -q "$a" >/dev/null 2>&1 || log "a2enmod $a failed (module not available on this release?)"; done
  fi
  if [ "$initdb" -eq 1 ] && command -v postgresql-setup >/dev/null && [ ! -f /var/lib/pgsql/data/PG_VERSION ]; then
    postgresql-setup --initdb >/dev/null 2>&1 || log "postgresql-setup --initdb failed; initialise the cluster by hand before starting postgresql"
  fi
  for group in "${enables[@]}"; do
    for unit in $group; do
      if systemctl list-unit-files --type=service --no-legend --plain "$unit.service" 2>/dev/null | grep -q "^$unit.service"; then
        systemctl enable --now "$unit.service" >/dev/null 2>&1 || log "could not enable/start $unit (Service Manager › Repair shows the journal)"
        break
      fi
    done
  done
  if [ "$family" = debian ] && [ ${#mods[@]} -gt 0 ] && systemctl is-active --quiet apache2.service; then
    if apache2ctl -t >/dev/null 2>&1; then systemctl reload apache2.service || true; else log "apache2ctl -t failed after enabling modules; fix the configuration and reload apache2"; fi
  fi
  STACK_RESULT="installed ${comps[*]} (${#pkgs[@]} packages)"
}

# Which stack to install: --stack/--components or WHM_STACK/WHM_STACK_COMPONENTS, else a
# menu on a terminal during a first install. --upgrade asks nothing (pass --stack to add
# software to an existing install); non-interactive runs install nothing and leave it to
# the setup wizard. Profiles come from the catalog, so the menu matches the wizard.
if [ -z "$STACK" ] && [ -t 0 ] && [ "$UPGRADE" -eq 0 ]; then
  echo
  echo "Which hosting software should this server run? The first login can also choose this (setup wizard),"
  echo "and Service Manager › Server stack installs more at any time."
  STACK_MENU_KEYS=()
  n=0
  while IFS=$'\t' read -r key label description; do
    n=$((n + 1)); STACK_MENU_KEYS+=("$key")
    case "$key" in manual) printf '  %d) %s - nothing now\n' "$n" "None" ;; *) printf '  %d) %s - %s\n' "$n" "$label" "$description" ;; esac
  done < <(stack_profiles)
  printf 'Choice [1]: '
  read -r STACK_CHOICE || STACK_CHOICE=""
  STACK_CHOICE=${STACK_CHOICE:-1}
  case "$STACK_CHOICE" in
    *[!0-9]*) die "enter the number of a choice" ;;
  esac
  [ "$STACK_CHOICE" -ge 1 ] && [ "$STACK_CHOICE" -le "$n" ] || die "choice out of range"
  STACK=${STACK_MENU_KEYS[$((STACK_CHOICE - 1))]}
  [ "$STACK" != manual ] || STACK=none
fi
case "$STACK" in
  full|web) install_stack "$STACK" "" || true ;;
  components) install_stack components "$STACK_COMPONENTS" || true ;;
  none) STACK_RESULT="skipped (--stack none): the setup wizard offers the same profiles at the first login" ;;
  *) STACK_RESULT="not chosen (no terminal): the setup wizard offers the profiles at the first login, or re-run with --stack full|web" ;;
esac

# RHEL family with SELinux: Apache and every PHP-FPM pool run confined as httpd_t, which may
# neither search /home/<user> nor write the docroot, tmp and logs trees under it, nor append to
# the per-domain logs, so every hosted site answers 403 until the homedir booleans are on and the
# trees are labelled. The agent applies exactly these booleans and file contexts on every vhost
# and PHP-FPM pool write (agent/src/ops/web.js ensureSelinuxWebAccess); doing it once here labels
# accounts that already exist and makes the first vhost work. semanage
# (policycoreutils-python-utils) is also what the agent needs to label a changed SSH port.
# Every failure is logged, never fatal: the agent repeats the steps and reports them.
apply_selinux_web_policy() {
  local mode name type rule
  local -a off=()
  command -v getenforce >/dev/null || return 0
  mode=$(getenforce 2>/dev/null || true)
  case "$mode" in Enforcing|Permissive) ;; *) return 0 ;; esac
  log "SELinux is $mode: allowing httpd to serve account homes"
  if ! command -v semanage >/dev/null; then
    install_packages policycoreutils-python-utils || log "policycoreutils-python-utils could not be installed: the panel labels with chcon (lost on a relabel) until semanage exists"
  fi
  for name in httpd_enable_homedirs httpd_read_user_content httpd_can_network_connect httpd_can_sendmail; do
    if getsebool "$name" 2>/dev/null | grep -q -- '--> *off$'; then off+=("$name=on"); fi
  done
  if [ ${#off[@]} -gt 0 ]; then
    setsebool -P "${off[@]}" || log "setsebool -P ${off[*]} failed: hosted sites answer 403 until the booleans are on"
  fi
  if command -v semanage >/dev/null; then
    while IFS=$'\t' read -r type rule; do
      [ -n "$rule" ] || continue
      if ! semanage fcontext -a -t "$type" "$rule" >/dev/null 2>&1; then
        semanage fcontext -l 2>/dev/null | grep -qF -- "$rule" || log "semanage fcontext -a -t $type '$rule' failed"
      fi
    done <<'EOF'
httpd_sys_rw_content_t	/home/[^/]+/public_html(/.*)?
httpd_sys_rw_content_t	/home/[^/]+/tmp(/.*)?
httpd_sys_rw_content_t	/home/[^/]+/logs(/.*)?
httpd_log_t	/var/log/whm/domlogs(/.*)?
EOF
    restorecon -R /home "$LOG_DIR" >/dev/null 2>&1 || log "restorecon -R /home $LOG_DIR failed; run it by hand so existing accounts are labelled"
  fi
}
case "$PKG" in apt) ;; *) apply_selinux_web_policy ;; esac

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
  echo "  Firewall:  allow TCP 2086 and 2087 (2086 only redirects to 2087; WHM_FORCE_HTTPS=false in $ETC_DIR/panel.env serves plain HTTP)"
  echo "  TLS:       $TLS_DIR/cert.pem + key.pem (self-signed until Networking Setup › Change Hostname issues the hostname certificate)"
  echo "  Stack:     ${STACK_RESULT:-nothing installed}"
  if grep -q '^WHM_LICENSE_HUB_URL=' "$ETC_DIR/panel.env"; then
    echo "  License:   hub $(sed -n 's/^WHM_LICENSE_HUB_URL=//p' "$ETC_DIR/panel.env" | head -1) — the super admin enters the key under Server Configuration › Basic WebHost Manager Setup › License"
  else
    echo "  License:   hub $DEFAULT_LICENSE_HUB_URL (default) — the super admin enters the key under Server Configuration › Basic WebHost Manager Setup › License"
  fi
  if [ -f "$ETC_DIR/superadmin.key" ]; then
    echo "  Super admin: sudo node $APP_DIR/scripts/whm-cli.js superadmin root   (asks for the setup password; only that user sees the license hub and key)"
  else
    echo "  Super admin: sudo node $APP_DIR/scripts/whm-cli.js superadmin --init, then: superadmin root"
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
