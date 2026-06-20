@echo off
title Antecedentes Policia - Servidor API
cd /d "%~dp0"

echo [1/2] Lanzando Chrome minimizado con CDP...
powershell -ExecutionPolicy Bypass -File "%~dp0launch_chrome.ps1"
if %errorlevel% NEQ 0 (
    echo ERROR: Chrome no pudo iniciar con CDP.
    pause
    exit /b 1
)

echo [2/2] Iniciando servidor API REST en puerto 3000...
echo.
echo  POST http://127.0.0.1:3000/consultar
echo  GET  http://127.0.0.1:3000/health
echo.
npx ts-node server.ts
