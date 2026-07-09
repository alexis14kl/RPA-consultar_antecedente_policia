#!/usr/bin/env bash
# Fuerza una rotación del proxy hide-my-ip AHORA (a otra IP), a mano.
# Útil si sospechás que la IP actual está bloqueada y no querés esperar al watchdog.
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
ANTES=$(timeout 15 node proxy_ctl.cjs status 2>/dev/null)
echo "[rotar] IP antes: ${ANTES:-?}"
echo "[rotar] rotando..."
NUEVA=$(timeout 25 node proxy_ctl.cjs rotate 2>/dev/null)
echo "[rotar] ✅ IP nueva: ${NUEVA:-?}"
