#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"

source "$HOME/.nvm/nvm.sh"
nvm use 22 >/dev/null

# Prevent stale shell variables overriding .env
for var in $(env | awk -F= '/^HD_/ {print $1}'); do
    unset "$var"
done
unset CADDY_HOST 2>/dev/null || true

set -a
source .env
set +a

FRONTEND_SERVER="$PWD/frontend/dist/frontend/server.js"
if [[ ! -f "$FRONTEND_SERVER" ]]; then
    echo "ERROR: deployed HedgeDoc frontend missing: $FRONTEND_SERVER"
    echo "Build and deploy frontend/dist before starting the service."
    exit 1
fi

if find "$PWD/frontend/src" -type f -newer "$FRONTEND_SERVER" -print -quit | grep -q .; then
    echo "ERROR: HedgeDoc frontend source is newer than the deployed frontend/dist build."
    echo "Rebuild and deploy frontend/dist before starting the service."
    exit 1
fi

cleanup() {
    trap - EXIT INT TERM
    echo
    echo "Stopping HedgeDoc..."
    kill "$BACKEND_PID" "$FRONTEND_PID" "$CADDY_PID" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting HedgeDoc backend dev on :${HD_BACKEND_PORT:-3100}"
yarn workspace @hedgedoc/backend start:dev &
BACKEND_PID=$!

echo "Starting deployed HedgeDoc frontend on :${HD_FRONTEND_PORT:-3101}"
yarn workspace @hedgedoc/frontend start &
FRONTEND_PID=$!

echo "Starting Caddy on ${CADDY_HOST:-:8180}"
yarn workspace @hedgedoc/dev-reverse-proxy start:dev &
CADDY_PID=$!

sleep 3

echo
echo "=== HedgeDoc services ==="
ss -ltnp | grep -E ':(3100|3101|8180)\b' || true
echo
echo "HedgeDoc: ${HD_BASE_URL}"
echo "Press Ctrl+C to stop all three."

wait
