#!/usr/bin/env bash
# Equivalente macOS de start-server.bat — arranca Chrome (si hace falta) + servidor API.
cd "$(dirname "$0")" || exit 1

echo "[1/2] Verificando Chrome CDP..."
if curl -s --max-time 2 "http://127.0.0.1:9223/json/version" >/dev/null 2>&1; then
  echo "Chrome CDP ya activo en puerto 9223. Saltando lanzamiento."
else
  echo "Lanzando Chrome off-screen con CDP..."
  bash ./launch_chrome.sh
  if [ $? -ne 0 ]; then
    echo "ERROR: Chrome no pudo iniciar con CDP."
    read -n 1 -s -r -p "Presiona una tecla para salir..."
    exit 1
  fi
fi

# Fallback de transcripción de audio (cuando Buster no resuelve el reCAPTCHA):
# usar el venv del proyecto y el ffmpeg de Homebrew si están disponibles.
if [ -x "./.venv/bin/python3" ]; then
  export PYTHON="$(pwd)/.venv/bin/python3"
  echo "Transcripción de audio: venv → $PYTHON"
fi
if command -v ffmpeg >/dev/null 2>&1; then
  export FFMPEG_DIR="$(cd "$(dirname "$(command -v ffmpeg)")" && pwd)"
fi

echo "[2/2] Iniciando servidor API REST en puerto 3000..."
echo
echo "  POST http://127.0.0.1:3000/consultar"
echo "  GET  http://127.0.0.1:3000/health"
echo
npx ts-node server.ts
