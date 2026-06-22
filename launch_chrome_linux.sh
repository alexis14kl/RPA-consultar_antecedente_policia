#!/usr/bin/env bash

CDP_PORT=9223
URL="https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"

CHROME="/usr/bin/chromium"
USER_DATA="$HOME/chrome-cdp-profile"

echo "Limpiando procesos..."
pkill -f chromium 2>/dev/null || true

echo "Creando perfil CDP..."
mkdir -p "$USER_DATA"

echo "Lanzando Chromium con Xvfb + CDP..."

xvfb-run -a -s "-screen 0 1280x720x24" "$CHROME" \
  --remote-debugging-port=$CDP_PORT \
  --remote-allow-origins="*" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --user-data-dir="$USER_DATA" \
  "$URL" >/dev/null 2>&1 &

echo "Esperando CDP..."

for i in $(seq 1 30); do
  sleep 1
  curl -s http://127.0.0.1:$CDP_PORT/json/version >/dev/null && {
    echo "CDP OK en ${i}s"
    exit 0
  }
done

echo "ERROR: CDP no levantó"
exit 1