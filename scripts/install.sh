#!/usr/bin/env bash
# WHM control panel installer for systemd-based Linux (Ubuntu/Debian, RHEL/Alma/Rocky).
#
#   sudo bash scripts/install.sh                 # install from this checkout into /opt/whm
#   sudo bash scripts/install.sh --upgrade       # redeploy code, keep data/config, restart
#   sudo WHM_ADMIN_PASSWORD='...' bash scripts/install.sh   # choose the initial password
#
# What it does: installs Node.js 22 if missing, creates the whmpanel service user,
# copies the application to /opt/whm, installs dependencies and builds the UI,
# writes /etc/whm config, generates a self-signed TLS certificate for the panel,
# installs and starts whm-agentd (root) and whm-panel (unprivileged) units.
set -euo pipefail

APP_DIR=${WHM_APP_DIR:-/opt/whm}
ETC_DIR=/etc/whm
DATA_DIR=${WHM_DATA_DIR:-/var/lib/whm}
LOG_DIR=/var/log/whm
SERVICE_USER=whmpanel
NODE_MAJOR=22
UPGRADE=0
SKIP_NODE=0
for arg in "$@"; do
  case "$arg" in
    --upgrade) UPGRADE=1 ;;
    --skip-node) SKIP_NODE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
command -v systemctl >/dev/null || die "systemd is required"
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$SRC_DIR/package.json" ] && [ -d "$SRC_DIR/server" ] || die "run this script from a WHM checkout (scripts/install.sh)"

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

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating service user $SERVICE_USER"
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /sbin/nologin "$SERVICE_USER"
fi

log "Deploying application to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude '*/node_modules' --exclude 'client/dist' --exclude data --exclude '.git' \
  "$SRC_DIR"/ "$APP_DIR"/

log "Installing dependencies and building the web interface"
( cd "$APP_DIR" && npm ci --no-audit --no-fund && npm run build --workspace client && npm prune --omit=dev --no-audit --no-fund )
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

if [ ! -f "$ETC_DIR/ssl/panel.crt" ]; then
  log "Generating a self-signed TLS certificate for the panel (replace via SSL/TLS › Manage Service SSL Certificates)"
  HOST=$(hostname -f 2>/dev/null || hostname)
  openssl req -x509 -newkey rsa:2048 -nodes -days 1095 -subj "/CN=$HOST" \
    -addext "subjectAltName=DNS:$HOST,IP:$(hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1)" \
    -keyout "$ETC_DIR/ssl/panel.key" -out "$ETC_DIR/ssl/panel.crt" >/dev/null 2>&1
  chown root:"$SERVICE_USER" "$ETC_DIR/ssl/panel.key" "$ETC_DIR/ssl/panel.crt"
  chmod 0640 "$ETC_DIR/ssl/panel.key" "$ETC_DIR/ssl/panel.crt"
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
else
  die "whm-panel failed to start; see: journalctl -u whm-panel -n 50"
fi
