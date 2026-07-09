#!/usr/bin/env bash
# Instala los systemd units del RPA (NO hace el cutover — eso es cutover.sh).
# Idempotente: se puede correr varias veces.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
UNITS="$REPO/deploy/systemd"

echo "[install] repo: $REPO"
chmod +x "$REPO/launch_chrome_linux.sh"

echo "[install] copiando units a /etc/systemd/system/"
cp "$UNITS/rpa-xvfb.service"   /etc/systemd/system/
cp "$UNITS/rpa-chrome.service" /etc/systemd/system/
cp "$UNITS/rpa-server.service" /etc/systemd/system/
cp "$UNITS/rpa-recycle.service" /etc/systemd/system/
cp "$UNITS/rpa-recycle.timer"   /etc/systemd/system/

systemctl daemon-reload
systemctl enable rpa-xvfb.service rpa-chrome.service rpa-server.service >/dev/null 2>&1 || true

echo "[install] OK. Units instalados y habilitados (arranque en boot)."
echo "  Reciclado periódico (opcional):  systemctl enable --now rpa-recycle.timer"
echo "  Cutover ahora:                    bash $REPO/deploy/cutover.sh"
