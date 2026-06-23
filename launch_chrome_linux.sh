#!/usr/bin/env bash

CDP_PORT=9223
USER_DATA="/tmp/chrome-cdp"

echo "[1] limpiando..."
pkill -f chromium || true

echo "[2] creando perfil..."
rm -rf "$USER_DATA"
mkdir -p "$USER_DATA"

echo "[3] lanzando con Xvfb..."

xvfb-run -a -s "-screen 0 1280x720x24" chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-port=$CDP_PORT \
  --user-data-dir="$USER_DATA" \
  https://google.com >/dev/null 2>&1 &

echo "[4] esperando CDP..."

for i in $(seq 1 30); do
  sleep 1
  curl -s http://127.0.0.1:$CDP_PORT/json/version >/dev/null && {
    echo "CDP OK"
    exit 0
  }
done

echo "CDP FALLÓ"
exit 1