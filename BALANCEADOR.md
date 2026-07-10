# Arquitectura de balanceo de cargas (multi-instancia)

Rama experimental. **No mergear a `docker-v1` hasta probar en el VPS.**

## El problema que resuelve
El Chrome único es un **single point of failure**: si su IP se flagea o el proceso se
cae, se cae TODO el servicio (lo vivimos: crash-loop → 502). Un balanceador con **varias
instancias, cada una con su propia IP**, da redundancia + más throughput.

## El principio (clave)
**El ban de reCAPTCHA es a la IP, no al proceso de Chrome.** Por eso la redundancia tiene
que ser a nivel IP:
- Cada instancia corre su **propio Chrome + su propia extensión hide-my-ip → su propia IP**.
- Un flag en la IP de la instancia A **no afecta** la IP de la instancia B.
- El balanceador rutea a la instancia sana → failover invisible.

> ❌ Varios Chrome con la MISMA IP = mismo ban, no sirve.
> ✅ Un Chrome por IP, detrás del balanceador = redundancia real.

## Topología
```
                    cloudflared (alexis-madrigal.com)
                              │
                     balancer.cjs  :4300   ← health-check + failover + least-loaded
                       ┌──────┴──────┐
             rpa-server :4321   rpa-server-2 :4322
             rpa-chrome :9223   rpa-chrome-2 :9224
             hide-my-ip → IP_A  hide-my-ip → IP_B
```

`balancer.cjs`: chequea `/health` de cada backend cada 5s, rutea al de **mayor pool**
(más tokens listos); si uno cae (health=false), usa el otro. POST bufferea el body para
poder reintentar. `GET /balancer/status` muestra el estado de los backends.

## Deploy en el VPS (receta)

### 1. Launcher env-overridable (ya en esta rama)
`launch_chrome_linux.sh` ahora respeta `CDP_PORT`, `USER_DATA`, `XDISPLAY` por env
(antes hardcodeados) → se puede lanzar una 2ª instancia con otro puerto/perfil.

### 2. Segunda instancia (systemd)
`rpa-chrome-2.service` — igual a rpa-chrome pero:
```ini
Environment=DISPLAY=:99 FOREGROUND=1 WAIT_PROXY=1 CHROME_BIN=/usr/lib/chromium/chromium
Environment=CDP_PORT=9224
Environment=USER_DATA=/root/RPA-consultar_antecedente_policia/chrome-cdp-profile-2
```
`rpa-server-2.service` — igual a rpa-server pero:
```ini
Environment=PORT=4322 HOST=127.0.0.1 CDP_PORT=9224
Environment=POOL_TARGET=3   # más chico: 2 instancias en 2 cores, no saturar
```
`rpa-balancer.service`:
```ini
[Service]
WorkingDirectory=/root/RPA-consultar_antecedente_policia
Environment=BALANCER_PORT=4300
Environment=BACKENDS=http://127.0.0.1:4321,http://127.0.0.1:4322
ExecStart=/usr/bin/node balancer.cjs
Restart=always
```
La 2ª instancia carga las MISMAS extensiones (`buster-ext`, `hide-my-ip-ext`) en un perfil
distinto → Chrome les asigna una conexión de proxy distinta → **IP distinta.**

### 3. Apuntar cloudflared al balanceador
Cambiar el tunnel para que el origin sea `http://localhost:4300` (el balancer) en vez de
`:4321`. Así el usuario pega siempre al balanceador.

### 4. Screenshots (pendiente de resolver)
Cada instancia escribe sus PNG en su `screenshots/` local y arma `screenshot_url` con SU
`BASE_URL`. Opciones: (a) `SCREENSHOTS_DIR` compartido entre las dos instancias, o (b) setear
`BASE_URL` de ambas al balanceador y que el balancer sepa rutear `/screenshot/*`. Para v1:
dir compartido es lo más simple.

## ⚠️ Realidad de recursos (VPS 2 cores / 3.8 GB)
- **Standby idle** (2ª instancia arriba pero pool chico): factible (~500 MB extra).
- **Las dos a full**: 2 Chrome pelean por 2 cores → puede thrashear. Mitigar con
  `POOL_TARGET=2-3` por instancia y `WORKERS=1-2`.
- **El diseño ideal es 1 instancia por MÁQUINA** (VPS separados), no 2 en el mismo. Esta
  rama es el prototipo en un solo VPS; para producción real → horizontal en varias máquinas.

## Estado de la rama
- [x] `balancer.cjs` — router con health-check + failover
- [x] launcher env-overridable (CDP_PORT / USER_DATA / XDISPLAY)
- [x] esta doc
- [ ] systemd units de la 2ª instancia + balancer (crear en deploy/systemd/)
- [ ] screenshots compartidos
- [ ] deploy + prueba de recursos en el VPS
- [ ] apuntar cloudflared al balanceador
