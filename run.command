#!/usr/bin/env bash
# Lanzador macOS — doble clic en Finder para arrancar todo.
cd "$(dirname "$0")" || exit 1

echo "[1/2] Lanzando Chrome con Buster..."
bash ./launch_chrome.sh
if [ $? -ne 0 ]; then
  echo "ERROR: Chrome no pudo iniciar con CDP."
  read -n 1 -s -r -p "Presiona una tecla para salir..."
  exit 1
fi

echo "[2/2] Iniciando servidor RPA..."
echo
export PORT=4321
export WORKERS=2
npx tsx server.ts
echo
echo "=== SERVIDOR DETENIDO ==="
read -n 1 -s -r -p "Presiona una tecla para salir..."
