#!/usr/bin/env bash
# Regenerates every screenshot in docs/screenshots (flow shots, the account-panel flow, all 212 admin
# pages and every account-panel page) with
# label bars, and the gallery READMEs. Needs a running panel serving the built client.
#
#   BASE=https://127.0.0.1:2087 PASSWORD='<root password>' bash e2e/screenshots.sh
# The plain port only redirects (301) or refuses (426) once TLS is on, so the default is the TLS
# listener; the installer's certificate is self-signed (curl -k, ignoreHTTPSErrors in the scripts).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PASSWORD:?set PASSWORD to the root panel password}"
export BASE=${BASE:-https://127.0.0.1:2087}
export GIT_SHA=${GIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo working-tree)}
OUT=docs/screenshots
curl -skf "$BASE/api/health" >/dev/null || { echo "panel not reachable at $BASE (start it with WHM_SERVE_CLIENT=true after npm run build)" >&2; exit 1; }
OUT="$OUT" node e2e/ui-check.cjs
OUT="$OUT/panel-flow" node e2e/panel-check.cjs
OUT="$OUT" node e2e/screenshot-all.cjs
echo "screenshots updated in $OUT (label: $GIT_SHA)"
