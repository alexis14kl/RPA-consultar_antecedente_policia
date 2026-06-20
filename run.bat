@echo off
title Antecedentes Policia - Consulta Automatica
cd /d "%~dp0"

echo [1/2] Lanzando Chrome con Profile 1...
powershell -ExecutionPolicy Bypass -File "%~dp0launch_chrome.ps1"
if %errorlevel% NEQ 0 (
    echo ERROR: Chrome no pudo iniciar con CDP.
    pause
    exit /b 1
)

echo [2/2] Ejecutando consulta automatica...
echo.
npx ts-node browser.ts
echo.
echo === FIN ===
pause
