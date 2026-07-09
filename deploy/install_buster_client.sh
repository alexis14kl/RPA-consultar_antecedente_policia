#!/usr/bin/env bash
# deploy/install_buster_client.sh
# Instala y registra el CLIENTE NATIVO de Buster (org.buster.client) para que la
# extensión pueda "Simulate user interactions" (input real del OS vía XTEST) — un
# plus anti-detección sobre el click sintético del DOM.
#
# Por qué es no-trivial:
#  1) El setup oficial es un flujo WEB interactivo: levanta un HTTP server local con
#     un token de sesión y espera que la extensión Buster le haga POST. Headless no
#     sirve. Acá capturamos puerto+token con un `xdg-open` falso y disparamos el
#     install nosotros con curl.
#  2) getLocation() del setup RECHAZA correr como root; pero install() NO chequea →
#     le pegamos directo a /api/v1/setup/install pasando los dirs a mano.
#  3) Chrome se lanza con --user-data-dir, y en Linux el dir de native hosts del
#     usuario se deriva del user-data-dir (no de ~/.config). Además dejamos copias en
#     los paths de sistema (/etc/...) como red de seguridad.
#  4) El binario cliente necesita libxkbcommon-x11-0 (si falta, ni arranca).
#
# Idempotente. Correr como root en el VPS. No reinicia Chrome (el native host se lee
# lazy en cada connectNative; ya queda activo para el próximo solve).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SETUP_BIN="${SETUP_BIN:-$REPO/deploy/buster-client/buster-client-setup-linux-amd64}"
BUSTER_ID="${BUSTER_ID:-ikipmhhkkggibbeeafdabcehocahnicl}"
CDP_PORT="${CDP_PORT:-9223}"
APP_DIR="${APP_DIR:-/root/.local/opt/buster}"

echo "[buster-client] repo=$REPO"
[ -x "$SETUP_BIN" ] || { chmod +x "$SETUP_BIN" 2>/dev/null || true; }
[ -f "$SETUP_BIN" ] || { echo "ERROR: no existe $SETUP_BIN"; exit 1; }

# 0) Dependencia de runtime del cliente (XTEST/xkb). Si falta, el binario no ejecuta.
if ! ldconfig -p 2>/dev/null | grep -q libxkbcommon-x11; then
  echo "[buster-client] instalando libxkbcommon-x11-0..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y libxkbcommon-x11-0 >/dev/null 2>&1 || \
    echo "  (aviso) no se pudo instalar libxkbcommon-x11-0 automáticamente"
fi

# 1) Detectar el user-data-dir del Chrome que corre (para colocar el manifest donde
#    Chrome realmente lo busca). Fallback al perfil por defecto del repo.
USER_DATA="$(pgrep -af "remote-debugging-port=$CDP_PORT" 2>/dev/null | grep -oE 'user-data-dir=[^ ]+' | head -1 | cut -d= -f2 || true)"
USER_DATA="${USER_DATA:-$REPO/chrome-cdp-profile}"
echo "[buster-client] user-data-dir=$USER_DATA"

# 2) Detectar el ID real de la extensión Buster desde el CDP (si está vivo).
DETECTED_ID="$(curl -s --max-time 5 "http://127.0.0.1:$CDP_PORT/json" 2>/dev/null | grep -oE 'chrome-extension://[a-p]{32}' | sort -u | grep -v pekcnopmdcbjdgmpnpkndppflpldnkkp | head -1 | sed 's#chrome-extension://##' || true)"
[ -n "$DETECTED_ID" ] && BUSTER_ID="$DETECTED_ID"
echo "[buster-client] buster_ext_id=$BUSTER_ID"

# 3) Correr el setup con opener falso para capturar puerto + token de sesión.
FAKEBIN="$(mktemp -d)"; URLFILE="$(mktemp)"
: > "$URLFILE"
for opener in xdg-open x-www-browser www-browser sensible-browser gnome-open gio; do
  cat > "$FAKEBIN/$opener" <<EOF
#!/bin/sh
echo "\$@" >> "$URLFILE"
EOF
  chmod +x "$FAKEBIN/$opener"
done

echo "[buster-client] lanzando setup (captura de sesión)..."
PATH="$FAKEBIN:$PATH" HOME=/root setsid "$SETUP_BIN" >/tmp/buster-setup.out 2>&1 </dev/null &
for _ in $(seq 1 60); do [ -s "$URLFILE" ] && break; sleep 0.2; done

URL="$(grep -oE "http://127\.0\.0\.1:[0-9]+/buster/setup\?session=[a-f0-9-]+" "$URLFILE" 2>/dev/null | head -1 || true)"
[ -n "$URL" ] || { echo "ERROR: no se capturó la URL del setup"; cat "$URLFILE" /tmp/buster-client-setup-log.txt 2>/dev/null; exit 1; }
PORT="$(echo "$URL" | sed -E 's#.*127\.0\.0\.1:([0-9]+)/.*#\1#')"
SESSION="$(echo "$URL" | sed -E 's#.*session=##')"
echo "[buster-client] setup en :$PORT"

# 4) Install directo (skip /location por el chequeo de root). Extrae el binario a
#    APP_DIR y escribe el manifest en manifestDir con allowed_origins de la ext.
HTTP="$(curl -s -o /tmp/buster-install.out -w '%{http_code}' --max-time 20 \
  -X POST "http://127.0.0.1:$PORT/api/v1/setup/install" \
  --data-urlencode "session=$SESSION" \
  --data-urlencode "appDir=$APP_DIR" \
  --data-urlencode "manifestDir=/root/.config/google-chrome/NativeMessagingHosts" \
  --data-urlencode "browser=chrome" \
  --data-urlencode "targetEnv=chrome" \
  --data-urlencode "extension=chrome-extension://$BUSTER_ID/")"
curl -s --max-time 5 -X POST "http://127.0.0.1:$PORT/api/v1/setup/close" --data-urlencode "session=$SESSION" >/dev/null 2>&1 || true
pkill -f "$SETUP_BIN" 2>/dev/null || true
rm -rf "$FAKEBIN" "$URLFILE"
[ "$HTTP" = "200" ] || { echo "ERROR: install HTTP=$HTTP"; cat /tmp/buster-install.out 2>/dev/null; exit 1; }
[ -x "$APP_DIR/buster-client" ] || { echo "ERROR: no se extrajo el cliente en $APP_DIR"; exit 1; }
echo "[buster-client] cliente en $APP_DIR/buster-client"

# 5) Replicar el manifest en todos los dirs donde Chrome (for Testing) puede buscar.
SRC=/root/.config/google-chrome/NativeMessagingHosts/org.buster.client.json
for base in \
  "$USER_DATA/NativeMessagingHosts" \
  "/etc/opt/chrome/native-messaging-hosts" \
  "/etc/chromium/native-messaging-hosts" \
  "/etc/opt/chrome-for-testing/native-messaging-hosts" \
  "/root/.config/google-chrome-for-testing/NativeMessagingHosts" \
  "/root/.config/chromium/NativeMessagingHosts"; do
  mkdir -p "$base" && cp "$SRC" "$base/org.buster.client.json"
done
echo "[buster-client] manifest replicado (user-data-dir + /etc + ~/.config)"

# 6) Verificación opcional (si hay node + playwright y el CDP vivo).
if command -v node >/dev/null 2>&1 && [ -f "$REPO/verify_buster_native.cjs" ]; then
  echo "[buster-client] verificando connectNative..."
  ( cd "$REPO" && node verify_buster_native.cjs ) || true
fi
echo "[buster-client] LISTO."
