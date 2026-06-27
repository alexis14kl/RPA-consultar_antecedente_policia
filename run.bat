@echo off
title Antecedentes Policia - RPA Server
cd /d "%~dp0"

echo [1/2] Lanzando Chrome con Buster...
powershell -ExecutionPolicy Bypass -File "%~dp0launch_chrome.ps1"
if %errorlevel% NEQ 0 (
    echo ERROR: Chrome no pudo iniciar con CDP.
    pause
    exit /b 1
)

echo [2/2] Iniciando servidor RPA...
echo.
set PORT=4321
set WORKERS=2
npx tsx server.ts
echo.
echo === SERVIDOR DETENIDO ===
pause
