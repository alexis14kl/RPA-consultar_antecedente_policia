#!/usr/bin/env bash
# Cutover: pasa el RPA de arranque MANUAL (npx tsx + Chrome a mano) a systemd.
# Para los procesos manuales, arranca los services en orden, verifica /health y
# reengancha x11vnc (para el noVNC de fase de test).
# Rollback si falla: bash launch_chrome_linux.sh &   +   npx tsx server.ts
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

echo "[cutover] 1) parando procesos MANUALES (server, Chrome, x11vnc, Xvfb)..."
pkill -9 -f "server.ts" 2>/dev/null || true                     # node/tsx server.ts (y padres)
pkill -9 -f "remote-debugging-port=9223" 2>/dev/null || true    # Chrome manual
pkill -f x11vnc 2>/dev/null || true
pkill -9 -f "Xvfb :99" 2>/dev/null || true
sleep 2

echo "[cutover] 2) arrancando services (xvfb -> chrome -> server)..."
systemctl restart rpa-xvfb.service
sleep 2
systemctl restart rpa-chrome.service
echo "    esperando CDP en :9223..."
for i in $(seq 1 60); do curl -sf http://127.0.0.1:9223/json/version >/dev/null 2>&1 && { echo "    CDP OK (${i}s)"; break; }; sleep 1; done
systemctl restart rpa-server.service

echo "[cutover] 3) esperando /health en :4321..."
OK=0
for i in $(seq 1 40); do
  curl -sf --max-time 4 http://127.0.0.1:4321/health >/dev/null 2>&1 && { OK=1; break; }
  sleep 1
done

echo "[cutover] 4) reenganchando x11vnc al display :99 (noVNC de test)..."
pkill -f x11vnc 2>/dev/null || true; sleep 1
setsid x11vnc -display :99 -nopw -forever -shared -rfbport 5900 -bg >/tmp/x11vnc.log 2>&1 < /dev/null || true

echo ""
echo "[cutover] === ESTADO FINAL ==="
systemctl is-active rpa-xvfb.service rpa-chrome.service rpa-server.service | paste -d' ' <(echo "  xvfb chrome server:") -
echo "  instancias Chrome en :9223: $(pgrep -f 'remote-debugging-port=9223' | wc -l | tr -d ' ') proc (1 instancia = varios procs hijos, OK)"
echo "  /health: $(curl -s --max-time 5 http://127.0.0.1:4321/health 2>/dev/null | cut -c1-280)"
if [ "$OK" != "1" ]; then
  echo "  ⚠️  server NO respondió /health. Logs:  journalctl -u rpa-server -n 40 --no-pager"
  echo "  ⚠️  ROLLBACK manual:  cd $REPO && FOREGROUND=0 bash launch_chrome_linux.sh && npx tsx server.ts"
fi
