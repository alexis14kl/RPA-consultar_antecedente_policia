#!/usr/bin/env bash

echo "[STOP] Deteniendo todos los servicios..."

# Servidor Node
fuser -k 4321/tcp 2>/dev/null && echo "[OK] Servidor puerto 4321 cerrado." || true

# Cloudflared
pkill -f "cloudflared" 2>/dev/null && echo "[OK] Cloudflared cerrado." || true

# Chromium
pkill -9 -f "chromium" 2>/dev/null && echo "[OK] Chromium cerrado." || true

# Xvfb
pkill -f "Xvfb" 2>/dev/null && echo "[OK] Xvfb cerrado." || true

# Locks
rm -f /tmp/.X99-lock 2>/dev/null || true
rm -f "$HOME/chrome-cdp-profile/Singleton*" 2>/dev/null || true

echo "[DONE] Todo detenido."
