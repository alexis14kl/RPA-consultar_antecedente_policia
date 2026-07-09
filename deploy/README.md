# deploy/ — RPA 24/7 con systemd

Corre el RPA de antecedentes de forma estable 24/7: **una sola instancia de Chrome**,
auto-restart en crash y en reboot. Resuelve el problema de que los Chromium se **apilaban**
(el pool quedaba en `pool:0` → timeouts).

## Arquitectura (3 services + reciclado opcional)

```
rpa-xvfb.service     Xvfb :99 (display). En su propio unit: reciclar Chrome NO tira el display
   └─ rpa-chrome.service   launch_chrome_linux.sh (Chrome + Buster + hide-my-ip + gate proxy),
        │                  FOREGROUND=1 → systemd lo supervisa. ExecStartPre mata huérfanos por PUERTO.
        ├─ rpa-server.service          npx tsx server.ts (:4321). Espera al CDP antes de arrancar.
        └─ rpa-proxy-watchdog.service  rota el proxy hide-my-ip cuando Google BLOQUEA la IP.

rpa-recycle.timer    (OPT-IN) reinicia chrome+server cada 8h para limpiar memory-creep.
```

## Watchdog del proxy (rotación en caliente)
El proxy hide-my-ip cambia la IP, pero Google va **bloqueando esa IP con el tiempo**
(rate-limit → "Audio bloqueado por Google (0 bytes)" → el pool se seca → timeouts). El gate
del launcher solo rota **al arrancar**. `rpa-proxy-watchdog` cubre la operación 24/7: cuenta los
"Audio bloqueado" en el journal de `rpa-server`; si hay ≥2 en 40s y el pool está bajo (<2), le
ordena a la extensión rotar a otro server (`clearProxyConfig()`+`autoConnect()` en su service worker,
el mismo mecanismo que `wait_proxy.cjs`). Tunables por env: `WD_THRESHOLD`, `WD_WINDOW`, `WD_POOL_LOW`,
`WD_COOLDOWN`, `WD_CHECK_MS`.

## El fix de fondo
`launch_chrome_linux.sh` mataba lo previo con `pkill -9 chromium`, que **NO** mata un binario
llamado `chrome` (Chrome for Testing / Playwright). Por eso se apilaban. Ahora mata **por puerto**
(`pkill -f remote-debugging-port=9223`) → garantía de instancia única. systemd refuerza esto.

## Uso

```bash
# 1) instalar los units (no toca el servicio corriendo)
sudo bash deploy/install.sh

# 2) cutover: pasar de manual a systemd (breve downtime, con verificación)
sudo bash deploy/cutover.sh

# reciclado periódico (opcional)
sudo systemctl enable --now rpa-recycle.timer
```

## Operación

```bash
systemctl status rpa-chrome rpa-server        # estado
journalctl -u rpa-server -f                   # logs del server
journalctl -u rpa-chrome -f                   # logs de Chrome/proxy
systemctl restart rpa-chrome rpa-server       # reciclar a mano
curl -s localhost:4321/health                 # pool, activas, esperando
```

Rollback a manual: `FOREGROUND=0 bash launch_chrome_linux.sh & ; npx tsx server.ts`
