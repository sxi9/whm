#!/usr/bin/env bash
# Regenerates every screenshot in docs/screenshots (flow shots + every function page) with
# label bars, and the gallery READMEs. Needs a running panel serving the built client.
#
#   BASE=http://127.0.0.1:2086 PASSWORD='<root password>' bash e2e/screenshots.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PASSWORD:?set PASSWORD to the root panel password}"
export BASE=${BASE:-http://127.0.0.1:2086}
export GIT_SHA=${GIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo working-tree)}
OUT=docs/screenshots
curl -sf "$BASE/api/health" >/dev/null || { echo "panel not reachable at $BASE (start it with WHM_SERVE_CLIENT=true after npm run build)" >&2; exit 1; }
OUT="$OUT" node e2e/ui-check.cjs
OUT="$OUT" node e2e/screenshot-all.cjs
echo "screenshots updated in $OUT (label: $GIT_SHA)"
