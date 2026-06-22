#!/usr/bin/env bash
# Equivalente macOS de stop_chrome.bat — cierra Chrome.
if pkill -f "Google Chrome" 2>/dev/null; then
  echo "Chrome cerrado."
else
  echo "Chrome no estaba corriendo."
fi
sleep 2
