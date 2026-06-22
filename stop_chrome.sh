#!/bin/bash

echo "Cerrando Chrome / Chromium CDP..."

# matar procesos de Chrome/Chromium
pkill -f chrome 2>/dev/null
pkill -f chromium 2>/dev/null

# doble seguridad (por si quedó colgado)
killall chrome 2>/dev/null
killall chromium 2>/dev/null

if [ $? -eq 0 ]; then
    echo "Chrome cerrado."
else
    echo "Chrome no estaba corriendo."
fi

sleep 2