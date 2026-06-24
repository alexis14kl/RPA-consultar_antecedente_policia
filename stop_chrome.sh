#!/usr/bin/env bash

echo "[STOP] Cerrando Chromium/CDP de forma segura..."

# 1. Intento limpio primero (SIGTERM)
pkill -f "chromium.*--remote-debugging-port=9223" 2>/dev/null || true
pkill -f "chrome.*--remote-debugging-port=9223" 2>/dev/null || true

sleep 2

# 2. Verificar si quedó vivo algo
PIDS=$(pgrep -f "chromium|chrome" || true)

if [ -n "$PIDS" ]; then
  echo "[WARN] Procesos aún vivos: $PIDS"
  echo "[STOP] Forzando kill -9..."

  echo "$PIDS" | xargs kill -9 2>/dev/null || true
fi

# 3. Liberar puertos CDP si quedan colgados
if command -v lsof >/dev/null 2>&1; then
  PORT_PID=$(lsof -t -i :9223 2>/dev/null || true)
  if [ -n "$PORT_PID" ]; then
    echo "[STOP] Liberando puerto 9223 PID: $PORT_PID"
    kill -9 $PORT_PID 2>/dev/null || true
  fi
fi

# 4. Limpieza de locks del perfil
USER_DATA="$HOME/chrome-cdp-profile"

rm -f "$USER_DATA/SingletonLock" 2>/dev/null || true
rm -f "$USER_DATA/SingletonSocket" 2>/dev/null || true
rm -f "$USER_DATA/SingletonCookie" 2>/dev/null || true

echo "[OK] Chromium/CDP cerrado limpio."