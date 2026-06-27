@echo off
title Deteniendo RPA...

echo [1] Matando servidor Node (tsx/server.ts)...
taskkill /f /im node.exe /t >nul 2>&1
if %errorlevel%==0 (echo    Node detenido.) else (echo    Node no estaba corriendo.)

echo [2] Matando Chrome CDP...
taskkill /f /im chrome.exe /t >nul 2>&1
if %errorlevel%==0 (echo    Chrome cerrado.) else (echo    Chrome no estaba corriendo.)

echo [3] Limpiando locks de perfil...
if exist "%~dp0chrome-cdp-profile\Singleton*" del /f /q "%~dp0chrome-cdp-profile\Singleton*" >nul 2>&1
if exist "%LOCALAPPDATA%\Google\Chrome\User Data\Singleton*" del /f /q "%LOCALAPPDATA%\Google\Chrome\User Data\Singleton*" >nul 2>&1

echo.
echo === Todo detenido. ===
timeout /t 2 /nobreak >nul
