#!/usr/bin/env bash
# Equivalente macOS de run.bat — doble-clic para lanzar todo.
cd "$(dirname "$0")" || exit 1

echo "[1/2] Lanzando Chrome con Profile 1..."
bash ./launch_chrome.sh
if [ $? -ne 0 ]; then
  echo "ERROR: Chrome no pudo iniciar con CDP."
  read -n 1 -s -r -p "Presiona una tecla para salir..."
  exit 1
fi

# Fallback de transcripción de audio: usar el venv del proyecto y el ffmpeg de Homebrew.
if [ -x "./.venv/bin/python3" ]; then export PYTHON="$(pwd)/.venv/bin/python3"; fi
if command -v ffmpeg >/dev/null 2>&1; then export FFMPEG_DIR="$(cd "$(dirname "$(command -v ffmpeg)")" && pwd)"; fi

echo "[2/2] Ejecutando consulta automatica..."
echo
npx ts-node browser.ts
echo
echo "=== FIN ==="
read -n 1 -s -r -p "Presiona una tecla para salir..."
