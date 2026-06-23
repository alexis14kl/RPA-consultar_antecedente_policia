#!/usr/bin/env bash

CDP_PORT=9223
URL="https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"

CHROME="/usr/bin/chromium"
USER_DATA="$HOME/chrome-cdp-profile"

echo "[1] Limpiando procesos..."
pkill -f chromium || true
sleep 2

echo "[2] Preparando perfil..."
mkdir -p "$USER_DATA"

echo "[3] Lanzando Chromium (modo estable CDP)..."

$CHROME \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-port=$CDP_PORT \
  --remote-allow-origins="*" \
  --user-data-dir="$USER_DATA" \
  --window-size=1280,800 \
  --start-maximized \
  "$URL" >/dev/null 2>&1 &

echo "[4] Esperando CDP..."

for i in $(seq 1 40); do
  sleep 1
  if curl -s http://127.0.0.1:$CDP_PORT/json/version >/dev/null; then
    echo "✅ CDP ACTIVO en ${i}s"
    exit 0
  fi
done

echo "❌ ERROR: CDP no levantó"
exit 1