#!/usr/bin/env bash
set -e

CDP_PORT=9223
URL="https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"

# Detectar Chromium automáticamente (evita /usr/bin/chromium roto)
CHROME_PATHS=(
  "/usr/bin/chromium"
  "/usr/bin/chromium-browser"
  "/snap/bin/chromium"
)

CHROME=""

for p in "${CHROME_PATHS[@]}"; do
  if [ -x "$p" ]; then
    CHROME="$p"
    break
  fi
done

if [ -z "$CHROME" ]; then
  echo "ERROR: Chromium no encontrado"
  exit 1
fi

USER_DATA="$HOME/chrome-cdp-profile"

echo "[1] Limpiando procesos..."
pkill -f chromium 2>/dev/null || true
pkill -f chrome 2>/dev/null || true

echo "[2] Creando perfil CDP..."
mkdir -p "$USER_DATA"

echo "[3] Verificando Xvfb..."
if ! command -v xvfb-run >/dev/null 2>&1; then
  echo "ERROR: xvfb-run no instalado. Ejecuta:"
  echo "apt install -y xvfb"
  exit 1
fi

echo "[4] Lanzando Chromium con CDP..."

# IMPORTANTE: sin redirect total al inicio para debugging
xvfb-run -a -s "-screen 0 1280x720x24" \
"$CHROME" \
  --remote-debugging-port=$CDP_PORT \
  --remote-allow-origins="*" \
  --no-first-run \
  --no-default-browser-check \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-software-rasterizer \
  --user-data-dir="$USER_DATA" \
  --window-size=1280,720 \
  "$URL" >/dev/null 2>&1 &

echo "[5] Esperando CDP..."

for i in $(seq 1 40); do
  sleep 1

  if curl -s --max-time 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null; then
    echo "CDP OK en ${i}s"
    exit 0
  fi
done

echo "ERROR: CDP no levantó"
exit 1