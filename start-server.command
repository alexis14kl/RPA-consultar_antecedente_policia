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

echo "[2/2] Iniciando servidor API REST en puerto 3000..."
echo
echo "  POST http://127.0.0.1:3000/consultar"
echo "  GET  http://127.0.0.1:3000/health"
echo
npx ts-node server.ts
