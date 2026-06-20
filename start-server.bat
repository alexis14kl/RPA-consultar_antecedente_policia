@echo off
title Antecedentes Policia - Servidor API
cd /d "%~dp0"

echo [1/2] Verificando Chrome CDP...
powershell -Command "try { Invoke-WebRequest http://127.0.0.1:9223/json/version -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel% EQU 0 (
    echo Chrome CDP ya activo en puerto 9223. Saltando lanzamiento.
) else (
    echo Lanzando Chrome off-screen con CDP...
    powershell -ExecutionPolicy Bypass -File "%~dp0launch_chrome.ps1"
    if %errorlevel% NEQ 0 (
        echo ERROR: Chrome no pudo iniciar con CDP.
        pause
        exit /b 1
    )
)

echo [2/2] Iniciando servidor API REST en puerto 3000...
echo.
echo  POST http://127.0.0.1:3000/consultar
echo  GET  http://127.0.0.1:3000/health
echo.
npx ts-node server.ts
