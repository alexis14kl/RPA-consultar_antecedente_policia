# Configurar el VPS para NO ser baneado por reCAPTCHA

Guía de la configuración que dejó el servicio **estable 5/5** (antecedentes de policía,
`server.ts` en el VPS `82.39.109.26`). Escrita después de diagnosticar y resolver el ban.

> **TL;DR — la lección clave:** el problema **NUNCA fue la IP**. reCAPTCHA no da un "ban
> duro" por IP: calcula un **risk score** de comportamiento. Una IP de datacenter suma
> sospecha base, pero lo que **volteaba la balanza** era el comportamiento robótico
> (clicks sin movimiento de mouse). Se comprobó: **por VNC (mouse real) pasaba, por robot
> no — con la MISMA IP.** La solución fue hacer que el RPA se comporte como humano, no
> cambiar de IP.

---

## 1. Por qué baneaba (el diagnóstico)

| Señal que sube el risk score | Cómo lo mitigamos |
|---|---|
| Sin movimiento de mouse (clicks instantáneos) | `helpers/humanMouse.ts` mueve el cursor con patrones humanos |
| Clicks sintéticos del DOM (no input real del OS) | **buster-client** nativo → input por XTEST |
| `navigator.webdriver = true` (automatización) | flag `--disable-blink-features=AutomationControlled` |
| Muchos solves seguidos desde la misma IP | **pool de tokens** (reusa el token ~110s, resuelve menos) |
| Audio challenge dependiente de servicio remoto rate-limiteado | speech **local** (Gemini Nano) + `transcribe.py` (whisper) |
| IP de datacenter quemada con el tiempo | proxy hide-my-ip + **watchdog** que rota al bloquear |

Ninguna capa sola alcanza; **es la suma**. La que más movió la aguja fue el mouse humano.

---

## 2. Las capas anti-ban (en orden de impacto)

### 2.1. Movimiento de mouse humano — `helpers/humanMouse.ts`  ⭐ el fix principal
Mueve el cursor **en paralelo** al solve, con curvas Bézier, easing e-in-out y micro-jitter.
**Solo mueve — nunca clickea** (para no contaminar la lógica del RPA). Baja el risk score →
el **checkbox de reCAPTCHA pasa gratis** la mayoría de las veces.

- Se engancha en el solver del pool: `const stop = startHumanMouse(page); ... ; stop();`
- **NO lo quites ni lo desactives.** Sin esto vuelve el ban (85% de bloqueo → ~0 con él).

### 2.2. buster-client nativo — "Simulate user interactions"
Hace que la extensión Buster use **input REAL del sistema operativo (XTEST)** en vez de
eventos sintéticos del DOM. Instala el native host `org.buster.client`.

```bash
sudo bash deploy/install_buster_client.sh
```

Y **encender los toggles** en los settings de Buster (equivalente a la página de opciones):
- `simulateUserInput = true`  (Simulate user interactions)
- `navigateWithKeyboard = true`
- `autoUpdateClientApp = true`

> **GOTCHA del manifest:** como Chrome se lanza con `--user-data-dir`, en Linux el native
> host del usuario va en **`{user-data-dir}/NativeMessagingHosts/`**, NO en `~/.config/...`.
> El script ya lo replica ahí + en `/etc/opt/chrome/native-messaging-hosts` (red de
> seguridad). Verificar con `verify_buster_native.cjs` → debe dar `CONECTADO_OK`.

### 2.3. Flags de Chrome anti-automatización — `launch_chrome_linux.sh`
El Chrome se lanza (bajo Xvfb `:99`) con, entre otros:
```
--disable-blink-features=AutomationControlled   # oculta navigator.webdriver
--no-sandbox --disable-dev-shm-usage --disable-gpu   # correr como root/headless estable
--remote-debugging-address=127.0.0.1 --remote-debugging-port=9223   # CDP solo localhost
--user-data-dir=.../chrome-cdp-profile           # perfil persistente (mantiene settings/cookies)
--load-extension=.../buster-ext,.../hide-my-ip-ext
```
> **No uses un Chrome for Testing "pelado".** El perfil persistente + los flags son parte
> del disfraz. Reusar el mismo `chrome-cdp-profile` mantiene la reputación/cookies.

### 2.4. Pool de tokens (resolver MENOS)
`server.ts` mantiene un **pool de tokens de reCAPTCHA** (`POOL_TARGET=6`, `MAX_WORKERS=2`)
y **reusa cada token dentro de su ventana de validez (~110s)**. Menos solves = menos
exposición a reCAPTCHA = menos riesgo de bloqueo. Un `pool` lleno en `/health` es la señal
de que el solver está sano.

### 2.5. Speech local (audio challenge sin depender de remoto)
- Buster: `speechService=managed` + `enableManagedLocalServices=true` (Gemini Nano local).
- RPA: `transcribe.py` usa **whisper local** (offline, sin rate-limit) y cae a Google STT
  solo si falta. Evita el "Wit.ai could not detect any speech" y los bloqueos por audio.

### 2.6. Proxy + rotación (capa secundaria, NO la principal)
`hide-my-ip` cambia la IP; `rpa-proxy-watchdog` la **rota cuando Google bloquea** (cuenta
"Audio bloqueado" en el journal y dispara `clearProxyConfig()`+`autoConnect()`). Es refuerzo,
no la solución — con el mouse humano la IP de datacenter ya suele pasar.

---

## 3. Estabilidad 24/7 (por qué está 5/5) — systemd

El servicio se cae si se **apilan Chromium** (el pool queda en `pool:0` → timeouts). Se
resolvió con systemd + matar **por puerto** (no `pkill chromium`, que no mata el binario
`chrome`). Units:

```
rpa-xvfb.service            Xvfb :99 (display en su propio unit)
 └─ rpa-chrome.service      launch_chrome_linux.sh (Chrome+Buster+proxy), FOREGROUND=1
     ├─ rpa-server.service          npx tsx server.ts (:4321), espera al CDP
     └─ rpa-proxy-watchdog.service  rota el proxy al bloquear
rpa-recycle.timer           (opcional) reinicia cada 8h contra memory-creep
```

Instalar: `sudo bash deploy/install.sh` → `sudo bash deploy/cutover.sh`.

> **GOTCHA:** si quedan CDPs/Chromium EXTRA abiertos (debug, cdp-engine :12001, otro
> :9223), el **pool se traba en `pool:0`**. Fix: cerrar los Chromium de más.

---

## 4. Operación — 3 comandos

```bash
bash deploy/estado.sh      # 👁️  servicios, pool, IP del proxy, última rotación, captchas, RAM + veredicto
bash deploy/levantar.sh    # 🚑  levantar/recuperar el stack en minutos (reinicia en orden, espera el pool)
bash deploy/rotar.sh       # 🔁  forzar rotación del proxy ahora (IP antes/después)
```

Verificación rápida de salud (solver funcionando = pool lleno):
```bash
curl -s localhost:4321/health    # → "pool":6,"pool_target":6  = sano
```

---

## 5. Checklist para replicar en un VPS nuevo

1. Chrome/Chromium + Xvfb + Node + Playwright + Python venv (con whisper).
2. `libxkbcommon-x11-0` instalada (la necesita buster-client).
3. Extensiones `buster-ext` y `hide-my-ip-ext` en el repo, cargadas por el launcher.
4. `bash deploy/install.sh` (systemd) + `bash deploy/cutover.sh`.
5. `bash deploy/install_buster_client.sh` (native host) → verificar `CONECTADO_OK`.
6. Encender `simulateUserInput` + `navigateWithKeyboard` en Buster.
7. Confirmar `helpers/humanMouse.ts` enganchado en el solver de `server.ts`.
8. `curl localhost:4321/health` → `pool` llegando a `pool_target`.

---

## 6. Lo que NO hay que hacer (rompe el anti-ban)

- ❌ Quitar/desactivar `humanMouse.ts` → vuelve el comportamiento robótico → ban.
- ❌ Lanzar Chrome sin `--disable-blink-features=AutomationControlled`.
- ❌ Borrar/recrear `chrome-cdp-profile` en cada arranque (pierde reputación y el native host).
- ❌ Poner el native host en `~/.config/...` (con `--user-data-dir` va en el user-data-dir).
- ❌ Depender solo del audio/servicio remoto para el challenge (rate-limit → bloqueo).
- ❌ Dejar Chromium extra abiertos (traba el pool en `pool:0`).
- ❌ Subir `POOL_TARGET`/`MAX_WORKERS` muy alto: más solves simultáneos desde una IP = más
  riesgo. Si Google bloquea, **bajar** la concurrencia, no subirla.

---

*Acceso al VPS y push: ver `deploy/README.md` y la memoria del proyecto. Estado al escribir
esto: servicio estable, `pool 6/6`, consultas respondiendo (ej. `1007601005 → NO TIENE
ASUNTOS PENDIENTES`).*
