#!/usr/bin/env bash

CDP_PORT=9223
URL="https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"
CHROME="${CHROME_BIN:-/usr/lib/chromium/chromium}"   # CHROME_BIN permite usar Chrome for Testing (docker); default = chromium de Debian (nativo)
DIR="$(cd "$(dirname "$0")" && pwd)"
USER_DATA="$DIR/chrome-cdp-profile"
XDISPLAY=:99

# Extensiones que se auto-inyectan: Buster (resuelve reCAPTCHA) + hide-my-ip
# (enruta la salida por un proxy no-datacenter, evita el bloqueo de Google).
# Ambas arrancan solas. WAIT_PROXY=0 desactiva la espera del proxy.
EXTS="$DIR/buster-ext,$DIR/hide-my-ip-ext"
WAIT_PROXY="${WAIT_PROXY:-1}"

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

echo "[4] Lanzando Chromium (Buster + hide-my-ip)..."
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
  --disable-extensions-except="$EXTS" \
  --load-extension="$EXTS" \
  "$URL" >/dev/null 2>&1 &

echo "[5] Esperando CDP..."
CDP_OK=0
for i in $(seq 1 40); do
  sleep 1
  if curl -s http://127.0.0.1:$CDP_PORT/json/version >/dev/null; then
    echo "✅ CDP ACTIVO en ${i}s"
    CDP_OK=1
    break
  fi
done
if [ "$CDP_OK" != "1" ]; then echo "❌ ERROR: CDP no levantó"; exit 1; fi

if [ "$WAIT_PROXY" = "1" ]; then
  echo "[6] Esperando proxy hide-my-ip (auto-connect)..."
  DIRECT_IP="$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null)"
  if [ -f "$DIR/wait_proxy.cjs" ]; then
    node "$DIR/wait_proxy.cjs" "$CDP_PORT" "$DIRECT_IP" "${PROXY_WAIT_SECS:-50}" || \
      echo "⚠️  Proxy no confirmado — el navegador puede seguir en IP directa (reintenta solo cada 60s)."
  fi
fi
exit 0
