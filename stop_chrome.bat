@echo off
title Cerrando Chrome CDP...
taskkill /f /im chrome.exe /t >nul 2>&1
if %errorlevel%==0 (
    echo Chrome cerrado.
) else (
    echo Chrome no estaba corriendo.
)
timeout /t 2 /nobreak >nul
