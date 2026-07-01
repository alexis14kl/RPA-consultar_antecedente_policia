#!/usr/bin/env bash
set -euo pipefail

# Limpieza al recibir señal: mata la app, el Chromium (CDP 9223) y Xvfb.
cleanup() {
  local exit_code=$?
  if [[ -n "${APP_PID:-}" ]] && kill -0 "${APP_PID}" 2>/dev/null; then
    kill -TERM "${APP_PID}" 2>/dev/null || true
    wait "${APP_PID}" 2>/dev/null || true
  fi
  pkill -TERM -f "chromium.*remote-debugging-port=9223" 2>/dev/null || true
  pkill -TERM -f "Xvfb :99" 2>/dev/null || true
  exit "${exit_code}"
}
trap cleanup INT TERM EXIT

mkdir -p /app/chrome-cdp-profile /app/screenshots
rm -f /tmp/.X99-lock /app/chrome-cdp-profile/Singleton* 2>/dev/null || true

# Subsistema de audio virtual: reCAPTCHA usa el AudioContext del navegador como señal
# anti-bot. Sin dispositivo de audio, Chromium parece bot → Google bloquea el audio del
# challenge (0 bytes). PulseAudio + un null sink le dan un dispositivo de audio realista.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR" || true
pulseaudio -D --exit-idle-time=-1 2>/dev/null || true
sleep 1
pactl load-module module-null-sink sink_name=dummy 2>/dev/null || true
pactl list short sinks 2>/dev/null && echo "[AUDIO] null sink activo" || echo "[AUDIO] pulseaudio no respondió (seguimos igual)"

# Usar Chrome for Testing (build de Google) en vez del chromium de Debian: Google confía
# en su propio build y no le bloquea el audio del reCAPTCHA. launch_chrome_linux.sh lee CHROME_BIN.
export CHROME_BIN="$(ls -d "${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"/chromium-*/chrome-linux/chrome 2>/dev/null | sort -V | tail -1)"
if [ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ]; then echo "[CHROME] Chrome for Testing: $CHROME_BIN"; else echo "[CHROME] CfT no hallado — usará Debian chromium"; unset CHROME_BIN; fi

# Levanta Xvfb + Chromium con Buster (CDP en 127.0.0.1:9223) y espera a que el CDP responda.
bash /app/launch_chrome_linux.sh

# Arranca la app (el CMD del Dockerfile) y queda esperándola.
"$@" &
APP_PID=$!
wait "${APP_PID}"
