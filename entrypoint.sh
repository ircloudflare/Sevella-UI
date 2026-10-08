#!/bin/sh
set -e

# UUID: use the one provided via env, otherwise generate a fresh one on every boot
if [ -z "$VLESS_UUID" ]; then
  VLESS_UUID=$(cat /proc/sys/kernel/random/uuid)
fi

# WebSocket path: random-ish default so it isn't guessable, override with WS_PATH env var
if [ -z "$WS_PATH" ]; then
  WS_PATH="vless-$(head -c 8 /proc/sys/kernel/random/uuid | tr -d '-')"
else
  WS_PATH="${WS_PATH#/}"
fi

XRAY_INTERNAL_PORT="${XRAY_INTERNAL_PORT:-10086}"

export VLESS_UUID
export WS_PATH
export XRAY_INTERNAL_PORT
export PORT="${PORT:-8080}"

echo "[entrypoint] UUID:        $VLESS_UUID"
echo "[entrypoint] WS path:     /$WS_PATH"
echo "[entrypoint] Xray local port: $XRAY_INTERNAL_PORT"
echo "[entrypoint] Dashboard/public port: $PORT"

sed \
  -e "s|UUID_PLACEHOLDER|$VLESS_UUID|g" \
  -e "s|WSPATH_PLACEHOLDER|$WS_PATH|g" \
  -e "s|XRAY_PORT_PLACEHOLDER|$XRAY_INTERNAL_PORT|g" \
  /app/xray-config.template.json > /app/xray-config.json

# Start Xray in the background
/usr/local/bin/xray run -c /app/xray-config.json &
XRAY_PID=$!

# If Xray dies, bring the whole container down so Sevalla restarts it
( wait "$XRAY_PID"; echo "[entrypoint] xray exited, stopping container"; kill 0 ) &

# Foreground process: the dashboard + WS-proxy server
exec node /app/server.js
