#!/usr/bin/env bash

CDP_PORT=9223
URL="https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"

CHROME="/usr/bin/chromium"
USER_DATA="$HOME/chrome-cdp-profile"

echo "Limpiando procesos..."
pkill -f chromium 2>/dev/null || true

echo "Creando perfil CDP..."
mkdir -p "$USER_DATA"

echo "Lanzando Chromium con CDP..."

"$CHROME" \
  --remote-debugging-port=$CDP_PORT \
  --remote-allow-origins="*" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --user-data-dir="$USER_DATA" \
  "$URL" &

echo "Esperando CDP..."

for i in $(seq 1 30); do
  sleep 1
  if curl -s http://127.0.0.1:$CDP_PORT/json/version >/dev/null; then
    echo "CDP OK en ${i}s"
    exit 0
  fi
done

echo "ERROR: CDP no levantó"
exit 1