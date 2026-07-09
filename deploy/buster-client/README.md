# buster-client (native host) — Linux

`buster-client-setup-linux-amd64` es el instalador oficial de dessant/buster-client
v0.3.0 (linux-amd64). Registra el native messaging host `org.buster.client` que le da
a la extensión Buster la capacidad **"Simulate user interactions"** (input real del OS
vía XTEST), un plus anti-detección de reCAPTCHA sobre el click sintético del DOM.

- sha256: 44c7e1d24b7469a728c7fa67f18d20fdf30da5c25909909bf52fd2fc04aa0652
- Fuente: https://github.com/dessant/buster-client/releases/tag/v0.3.0

Instalar/registrar en el VPS:  `sudo bash deploy/install_buster_client.sh`
(idempotente; ver el encabezado del script para el detalle del flujo).
