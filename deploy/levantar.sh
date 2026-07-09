#!/usr/bin/env bash
# Levanta / recupera TODO el stack del RPA en minutos, en orden y con verificación.
# Úsalo cuando "no consulta" o quedó raro: reinicia limpio y confirma que volvió.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

echo "[levantar] 1) reiniciando servicios en orden (xvfb → chrome → server → watchdog)..."
systemctl restart rpa-xvfb.service
sleep 2
systemctl restart rpa-chrome.service

echo "[levantar] 2) esperando CDP en :9223..."
for i in $(seq 1 60); do curl -sf http://127.0.0.1:9223/json/version >/dev/null 2>&1 && { echo "    CDP OK (${i}s)"; break; }; sleep 1; done

systemctl restart rpa-server.service rpa-proxy-watchdog.service

echo "[levantar] 3) esperando pool ≥1 (warmup del proxy, puede tardar 1-3 min)..."
for i in $(seq 1 48); do
  p=$(curl -s --max-time 4 http://127.0.0.1:4321/health 2>/dev/null | grep -oE '"pool":[0-9]+' | cut -d: -f2)
  [ "${p:-0}" -ge 1 ] && { echo "    ✅ pool=$p — API arriba en ~$((i*5))s"; break; }
  [ $((i % 4)) -eq 0 ] && echo "    ...warmup ($((i*5))s)"
  sleep 5
done

echo ""
bash "$REPO/deploy/estado.sh"
