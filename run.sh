#!/bin/bash
# Lanzador Linux/VPS — equivalente a run.bat para entornos headless.
cd "$(dirname "$0")" || exit 1

echo "[1/2] Lanzando Chrome con Buster..."
bash ./launch_chrome_linux.sh
if [ $? -ne 0 ]; then
  echo "ERROR: Chrome no pudo iniciar con CDP."
  exit 1
fi

echo "[2/2] Iniciando servidor RPA..."
echo
export PORT=4321
export WORKERS=2
npx tsx server.ts
echo
echo "=== SERVIDOR DETENIDO ==="
