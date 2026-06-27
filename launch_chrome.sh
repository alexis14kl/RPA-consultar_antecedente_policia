#!/usr/bin/env bash
# Lanzador macOS — alineado con launch_chrome_linux.sh.
# Carga Buster con --load-extension desde buster-ext/, igual que el VPS Linux.
#
# IMPORTANTE: Google Chrome (stable) IGNORA --load-extension desde ~Chrome 137.
# Por eso se usa CHROMIUM / "Chrome for Testing" (como en Linux se usa chromium),
# que sí honra --load-extension. Se auto-detecta el binario disponible.
#
# Perfil DEDICADO (no-default) para que Chrome 136+ permita el remote-debugging
# y para no tocar tu navegador de uso diario.
set -u

CDP_PORT=9223
URL="https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_DATA="$SCRIPT_DIR/chrome-cdp-profile"   # perfil dedicado (no-default)
EXT_DIR="$SCRIPT_DIR/buster-ext"             # extensión Buster desempaquetada

# ── Detectar un Chromium que honre --load-extension ────────────────────────
detect_chromium() {
  if [ -n "${CHROMIUM_BIN:-}" ] && [ -x "$CHROMIUM_BIN" ]; then echo "$CHROMIUM_BIN"; return; fi
  local cands=(
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
  )
  for c in "${cands[@]}"; do [ -x "$c" ] && { echo "$c"; return; }; done
  # Caché de Playwright (toma el chromium-* más reciente)
  local pw
  pw="$(ls -d "$HOME/Library/Caches/ms-playwright/"chromium-* 2>/dev/null | sort -V | tail -1)"
  if [ -n "$pw" ]; then
    local bin
    bin="$(find "$pw" -type f \( -name "Chromium" -o -name "Google Chrome for Testing" \) 2>/dev/null | head -1)"
    [ -x "$bin" ] && { echo "$bin"; return; }
  fi
  echo ""
}

CHROME="$(detect_chromium)"
if [ -z "$CHROME" ]; then
  echo "ERROR: No se encontró un Chromium que honre --load-extension."
  echo "  Instala uno con:  brew install --cask chromium"
  echo "             o:     npx playwright install chromium"
  echo "  (o define CHROMIUM_BIN=/ruta/al/Chromium)"
  exit 1
fi
if [ ! -d "$EXT_DIR" ]; then
  echo "ERROR: No se encontró la extensión Buster en: $EXT_DIR"
  exit 1
fi
echo "Chromium: $CHROME"

echo "[1] Limpiando solo la instancia CDP previa (no toca tu Chrome de uso diario)..."
pkill -9 -f "remote-debugging-port=$CDP_PORT" 2>/dev/null || true
pkill -9 -f "chrome-cdp-profile" 2>/dev/null || true
sleep 1

echo "[2] Preparando perfil dedicado..."
mkdir -p "$USER_DATA"
rm -f "$USER_DATA/SingletonLock" "$USER_DATA/SingletonSocket" "$USER_DATA/SingletonCookie" 2>/dev/null || true

echo "[3] Lanzando Chromium con Buster (--load-extension)..."
"$CHROME" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=$CDP_PORT \
  --remote-allow-origins='*' \
  --user-data-dir="$USER_DATA" \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-blink-features=AutomationControlled \
  --disable-web-security \
  --ignore-certificate-errors \
  --disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests,PrivacySandboxSettings4 \
  --disable-extensions-except="$EXT_DIR" \
  --load-extension="$EXT_DIR" \
  --window-position=-2000,0 \
  --window-size=1280,800 \
  "$URL" >/dev/null 2>&1 &

echo "[4] Esperando CDP..."
for i in $(seq 1 40); do
  sleep 1
  if curl -s --max-time 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
    echo "✅ CDP ACTIVO en ${i}s"
    exit 0
  fi
done

echo "❌ ERROR: CDP no levantó"
exit 1
