#!/usr/bin/env bash

CDP_PORT="${CDP_PORT:-9223}"   # override por env para una 2ª instancia (balanceo de cargas)
URL="https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"
CHROME="${CHROME_BIN:-/usr/lib/chromium/chromium}"   # CHROME_BIN permite usar Chrome for Testing (docker); default = chromium de Debian (nativo)
# Fallback: si ese binario no existe, usar el Chrome de Playwright (chrome-linux*/chrome).
if [ ! -x "$CHROME" ]; then
  CHROME="$(ls -d /root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)"
fi
DIR="$(cd "$(dirname "$0")" && pwd)"
USER_DATA="${USER_DATA:-$DIR/chrome-cdp-profile}"   # perfil propio por instancia (balanceo)
XDISPLAY="${XDISPLAY:-:99}"

# Extensiones que se auto-inyectan: Buster (resuelve reCAPTCHA) + hide-my-ip
# (enruta la salida por un proxy no-datacenter, evita el bloqueo de Google).
# Ambas arrancan solas. WAIT_PROXY=0 desactiva la espera del proxy.
EXTS="$DIR/buster-ext,$DIR/hide-my-ip-ext"
WAIT_PROXY="${WAIT_PROXY:-1}"
FOREGROUND="${FOREGROUND:-0}"   # 1 = quedarse atado a Chrome (para correr bajo systemd)

echo "[1] Limpiando instancias previas en :$CDP_PORT (por PUERTO, no por nombre)..."
# OJO: 'pkill chromium' NO mata un binario llamado "chrome" (Chrome for Testing) -> las
# instancias se APILABAN al relanzar y ahogaban el pool. Matar por puerto/perfil cubre ambos.
pkill -9 -f "remote-debugging-port=$CDP_PORT" 2>/dev/null || true
pkill -9 -f "user-data-dir=$USER_DATA" 2>/dev/null || true
pkill -9 chromium 2>/dev/null || true
sleep 1

echo "[2] Levantando Xvfb (si no está ya)..."
if ! pgrep -f "Xvfb $XDISPLAY" >/dev/null 2>&1; then
  rm -f /tmp/.X${XDISPLAY#:}-lock 2>/dev/null || true
  Xvfb $XDISPLAY -screen 0 1280x800x24 >/dev/null 2>&1 &
  sleep 2
fi
export DISPLAY=$XDISPLAY

echo "[3] Preparando perfil..."
mkdir -p "$USER_DATA"
rm -f "$USER_DATA/Singleton*" 2>/dev/null || true

echo "[4] Lanzando Chrome ($CHROME) con Buster + hide-my-ip..."
"$CHROME" \
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
CHROME_PID=$!

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
if [ "$CDP_OK" != "1" ]; then echo "❌ ERROR: CDP no levantó"; kill "$CHROME_PID" 2>/dev/null; exit 1; fi

if [ "$WAIT_PROXY" = "1" ]; then
  echo "[6] Esperando proxy hide-my-ip (auto-connect)..."
  DIRECT_IP="$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null)"
  if [ -f "$DIR/wait_proxy.cjs" ]; then
    node "$DIR/wait_proxy.cjs" "$CDP_PORT" "$DIRECT_IP" "${PROXY_WAIT_SECS:-90}" || \
      echo "⚠️  Proxy no confirmado — el navegador puede seguir en IP directa (reintenta solo cada 60s)."
  fi
fi

# systemd (FOREGROUND=1): quedarse atado al proceso de Chrome. Si Chrome muere, este script
# termina y el service (Restart=always) levanta UNA sola instancia nueva (no se apilan).
if [ "$FOREGROUND" = "1" ]; then
  echo "[7] FOREGROUND — esperando a Chrome (PID $CHROME_PID)..."
  wait "$CHROME_PID"
  echo "Chrome terminó; saliendo para que systemd reinicie."
fi
exit 0
