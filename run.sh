#!/bin/bash

echo "[1/2] Lanzando Chrome con Profile 1..."

# lanzar Chrome CDP (equivalente a launch_chrome.ps1)
powershell -ExecutionPolicy Bypass -File "./launch_chrome.ps1" 2>/dev/null

if [ $? -ne 0 ]; then
    echo "ERROR: Chrome no pudo iniciar con CDP."
    exit 1
fi

echo "[2/2] Ejecutando consulta automatica..."
echo ""

npx ts-node browser.ts

echo ""
echo "=== FIN ==="