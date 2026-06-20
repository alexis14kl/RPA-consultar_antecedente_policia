#!/usr/bin/env bash
# Equivalente macOS de launch_chrome.ps1
# Lanza Google Chrome con CDP activo en 9223, usando una COPIA del Profile 1 real
# (que trae la extensión Buster + la sesión de Google).
#
# Por qué una copia y no el perfil real:
#   Desde Chrome 136 el navegador SE NIEGA a activar --remote-debugging-port
#   cuando --user-data-dir apunta al directorio por defecto ("DevTools remote
#   debugging requires a non-default data directory"). La solución es clonar el
#   perfil a un directorio dedicado (no-default) donde CDP sí está permitido.
set -u

CDP_PORT=9223
PROFILE_DIR="Profile 1"
URL="https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"

SRC_UD="$HOME/Library/Application Support/Google/Chrome"          # perfil real (NO se modifica)
CDP_UD="$HOME/Library/Application Support/Google/Chrome-CDP"      # clon dedicado (no-default)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -x "$CHROME" ]; then
  echo "ERROR: No se encontró Google Chrome en: $CHROME"
  exit 1
fi
if [ ! -d "$SRC_UD/$PROFILE_DIR" ]; then
  echo "ERROR: No existe el perfil de origen: $SRC_UD/$PROFILE_DIR"
  exit 1
fi

# 1) Matar Chrome y ESPERAR a que no quede ningún proceso (rsync necesita el origen cerrado)
pkill -9 -f "Google Chrome" 2>/dev/null || true
for i in $(seq 1 15); do pgrep -f "Google Chrome" >/dev/null 2>&1 || break; sleep 1; done

# 2) Clonar el perfil real → directorio CDP (incremental; excluye cachés regenerables)
echo "Sincronizando perfil → directorio CDP..."
mkdir -p "$CDP_UD/$PROFILE_DIR"
rsync -a --delete \
  --exclude 'Cache' --exclude 'Code Cache' --exclude 'GPUCache' \
  --exclude 'DawnWebGPUCache' --exclude 'DawnGraphiteCache' \
  --exclude 'GrShaderCache' --exclude 'ShaderCache' \
  --exclude 'Service Worker/CacheStorage' \
  "$SRC_UD/$PROFILE_DIR/" "$CDP_UD/$PROFILE_DIR/"
[ -f "$SRC_UD/Local State" ] && cp -f "$SRC_UD/Local State" "$CDP_UD/Local State"

# 3) Borrar locks de singleton del clon
rm -f "$CDP_UD/SingletonLock" "$CDP_UD/SingletonSocket" "$CDP_UD/SingletonCookie" 2>/dev/null || true
rm -f "$CDP_UD/$PROFILE_DIR/Current Session" "$CDP_UD/$PROFILE_DIR/Current Tabs" \
      "$CDP_UD/$PROFILE_DIR/Last Session" "$CDP_UD/$PROFILE_DIR/Last Tabs" 2>/dev/null || true
rm -f "$CDP_UD/$PROFILE_DIR/Sessions/"* 2>/dev/null || true

# 4) Corregir exit_type=Crashed en Preferences DEL CLON (no toca el perfil real)
PREFS="$CDP_UD/$PROFILE_DIR/Preferences"
if [ -f "$PREFS" ]; then
  python3 - "$PREFS" <<'PY' 2>/dev/null && echo "Preferences: exit_type=Normal, restore_on_startup=1" || echo "Aviso: no se pudo parchear Preferences (no crítico)"
import json, sys
p = sys.argv[1]
with open(p, "r", encoding="utf-8") as f:
    prefs = json.load(f)
prefs.setdefault("profile", {})
prefs["profile"]["exit_type"] = "Normal"
prefs["profile"]["exited_cleanly"] = True
prefs.setdefault("session", {})
prefs["session"]["restore_on_startup"] = 1
with open(p, "w", encoding="utf-8") as f:
    json.dump(prefs, f)
PY
fi

# 5) Lanzar Chrome con flags CDP (off-screen)
"$CHROME" \
  --remote-debugging-port=$CDP_PORT \
  --remote-allow-origins='*' \
  --user-data-dir="$CDP_UD" \
  --profile-directory="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --window-position=-2000,0 \
  --window-size=1280,800 \
  "$URL" >/dev/null 2>&1 &

echo "Chrome lanzado. Esperando CDP..."
for i in $(seq 1 30); do
  sleep 1
  if curl -s --max-time 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
    echo "CDP ACTIVO en ${i}s"
    exit 0
  fi
done

echo "ERROR: CDP no respondió"
exit 1
