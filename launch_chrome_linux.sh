#!/usr/bin/env bash

CDP_PORT=9223
URL="https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"
CHROME="/usr/lib/chromium/chromium"
USER_DATA="$(dirname "$0")/chrome-cdp-profile"
XDISPLAY=:99

echo "[1] Limpiando procesos..."
pkill -9 chromium 2>/dev/null || true
sleep 1
rm -f /tmp/.X${XDISPLAY#:}-lock 2>/dev/null || true

echo "[2] Levantando Xvfb..."
Xvfb $XDISPLAY -screen 0 1280x800x24 >/dev/null 2>&1 &
export DISPLAY=$XDISPLAY
sleep 2

echo "[3] Preparando perfil..."
mkdir -p "$USER_DATA"
rm -f "$USER_DATA/Singleton*" 2>/dev/null || true

echo "[4] Lanzando Chromium..."
$CHROME \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=$CDP_PORT \
  --remote-allow-origins='*' \
  --user-data-dir="$USER_DATA" \
  --no-first-run \
  --no-default-browser-check \
  --disable-blink-features=AutomationControlled \
  --disable-web-security \
  --ignore-certificate-errors \
  --disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests,PrivacySandboxSettings4 \
  --load-extension="$(dirname "$0")/buster-ext" \
  "$URL" >/dev/null 2>&1 &

echo "[5] Esperando CDP..."
for i in $(seq 1 40); do
  sleep 1
  if curl -s http://127.0.0.1:$CDP_PORT/json/version >/dev/null; then
    echo "✅ CDP ACTIVO en ${i}s"
    exit 0
  fi
done

echo "❌ ERROR: CDP no levantó"
exit 1
