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

echo "[2/2] Ejecutando consulta automatica..."
echo
npx ts-node browser.ts
echo
echo "=== FIN ==="
read -n 1 -s -r -p "Presiona una tecla para salir..."
