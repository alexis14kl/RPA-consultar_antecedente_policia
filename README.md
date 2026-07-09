# Consulta Automatica de Antecedentes Judiciales

Automatiza la consulta en `antecedentes.policia.gov.co:7005` usando Playwright + Chrome DevTools Protocol (CDP).

---

## 📚 Documentación

| Guía | Para qué |
|---|---|
| [DEPENDENCIAS.md](DEPENDENCIAS.md) | **Versiones pineadas + orden de instalación** para levantar el VPS en minutos |
| [ANTIBAN_VPS.md](ANTIBAN_VPS.md) | **Cómo configurar el VPS para NO ser baneado** por reCAPTCHA (las capas anti-ban, el risk score) |
| [deploy/README.md](deploy/README.md) | **Stack systemd 24/7** (Xvfb + Chrome + server + watchdog) y los 3 comandos de operación |
| [deploy/buster-client/README.md](deploy/buster-client/README.md) | El **native host de Buster** (Simulate user interactions / input XTEST) |
| [FUTURO_API_CAPTCHA.md](FUTURO_API_CAPTCHA.md) | Diseño de la **API propia de tokens** de captcha (roadmap) |
| [IMPLEMENTACION_LINUX.md](IMPLEMENTACION_LINUX.md) | Guía original de implementación en Linux |

**Scripts de instalación** (reproducibles, con encabezado explicativo):
`deploy/install.sh` + `deploy/cutover.sh` (systemd) · `deploy/install_whisper_cpp.sh` (STT local) ·
`deploy/install_buster_client.sh` (native host) · `requirements.txt` (deps Python).

**Operación / diagnóstico:** `deploy/estado.sh` · `deploy/levantar.sh` · `deploy/rotar.sh` ·
`verify_buster_native.cjs` · `buster_settings.cjs`.

---

## Archivos

| Archivo | SO | Rol |
|---|---|---|
| `run.bat` | Windows | Entry point — lanza todo en un solo doble-clic |
| `launch_chrome.ps1` | Windows | Abre Chrome con Profile 1 + CDP activo |
| `run.command` | macOS | Entry point — doble-clic, equivalente de `run.bat` |
| `start-server.command` | macOS | Lanza Chrome (si hace falta) + servidor API REST |
| `stop_chrome.command` | macOS | Cierra Chrome |
| `launch_chrome.sh` | macOS | Clona Profile 1 a un dir dedicado y abre Chrome con CDP |
| `browser.ts` | ambos | Automatiza la consulta (Playwright via CDP) |
| `server.ts` | ambos | Servidor API REST (`POST /consultar`) sobre el mismo browser |
| `transcribe.py` | ambos | Transcribe el audio del reCAPTCHA — **whisper.cpp local** (principal) → Google STT |

---

## Uso — Windows

```
matar procesos
taskkill /f /im chrome.exe /t 2>$null; Start-Sleep -Seconds 2; Get-Process chrome -ErrorAction SilentlyContinue | Select-Object Name, Id


Doble-clic en run.bat
```

Eso es todo. El bat hace todo automáticamente.

---

## Uso — macOS

Requisitos: Google Chrome instalado, Node.js, y un **"Profile 1"** en Chrome con
la sesión de Google iniciada + la extensión **Buster** instalada (lo mismo que en
Windows). `python3` y `ffmpeg` (`brew install ffmpeg`) solo hacen falta para el
fallback de transcripción de audio — Buster resuelve el captcha sin ellos.

Primera vez (dar permisos de ejecución):

```bash
cd "ruta/al/proyecto"
npm install
chmod +x launch_chrome.sh run.command start-server.command stop_chrome.command
```

Consulta de una sola pasada (equivalente a `run.bat`):

```bash
./run.command        # o doble-clic en Finder
```

Servidor API REST:

```bash
./start-server.command
# POST http://127.0.0.1:3000/consultar  { "cedula": "1234567", "tipo": "cc" }
# GET  http://127.0.0.1:3000/health
```

### Diferencia clave de macOS: el directorio clonado

Desde **Chrome 136** el navegador **se niega a activar `--remote-debugging-port`
si `--user-data-dir` apunta al directorio de perfil por defecto** (error:
*"DevTools remote debugging requires a non-default data directory"*). Por eso en
Mac `launch_chrome.sh` **no usa el perfil real directamente**: lo clona con
`rsync` (excluyendo cachés) a `~/Library/Application Support/Google/Chrome-CDP`,
un directorio no-default donde CDP sí está permitido. El clon arrastra la
extensión Buster, las cookies y la sesión de Google del Profile 1 real, que
**nunca se modifica**. El clon se re-sincroniza en cada arranque.

---

## Como funciona el CDP

### Que es CDP

Chrome DevTools Protocol es una API que expone Chrome para control remoto. Se activa con el flag `--remote-debugging-port=<puerto>`. Playwright se conecta a ese puerto en vez de lanzar su propio Chromium.

### Por que CDP y no Playwright nativo

Playwright nativo lanza un Chromium limpio (sin perfil, sin extensiones). El sitio de la Policia usa reCAPTCHA v2 que detecta automatizacion. Usar el perfil real del usuario tiene:

- Sesion de Google activa → reCAPTCHA confia mas y no pide challenge duro
- Extension Buster instalada → puede resolver el challenge de audio automaticamente
- Cookies reales → comportamiento de navegador humano

### Flujo de arranque

```
run.bat
  └─ launch_chrome.ps1
       ├─ taskkill chrome.exe          (eliminar instancia previa)
       ├─ borrar LOCK files             (evitar singleton block)
       ├─ Start-Process chrome.exe      (lanzar con flags CDP)
       │    --remote-debugging-port=9223
       │    --user-data-dir="...User Data"
       │    --profile-directory="Profile 1"
       │    --disable-session-crashed-bubble   ← CRITICO
       │    --restore-last-session=0           ← CRITICO
       └─ esperar hasta http://127.0.0.1:9223/json/version responde

  └─ npx ts-node browser.ts
       └─ chromium.connectOverCDP("http://127.0.0.1:9223")
```

### Flags criticos

| Flag | Por que |
|---|---|
| `--disable-session-crashed-bubble` | Sin este flag Chrome muestra dialogo de recuperacion de sesion y NO bindea el puerto CDP |
| `--restore-last-session=0` | Evita que Chrome restaure tabs anteriores que pueden bloquear la inicializacion |
| `--profile-directory=Profile 1` | Carga el perfil con Buster instalado y sesion Google activa |
| `--remote-allow-origins=*` | Permite que Playwright (cualquier origen) se conecte al CDP |

### Por que Start-Process y no start "" en CMD

`start "" chrome.exe args` en CMD.exe no bindea el puerto CDP cuando se llama desde un proceso hijo (Node.js, otro CMD). Causa: Chrome hereda un contexto de sesion Windows incorrecto.

`Start-Process` de PowerShell lanza Chrome en el contexto correcto del usuario con acceso al desktop session → CDP bindea correctamente.

---

## Flujo de automatizacion (browser.ts)

```
1. Conectar a CDP (puerto 9223)
2. Navegar a index.xhtml
3. Aceptar terminos  → click #aceptaOption:0
4. Click continuar   → click #continuarBtn
5. Llenar formulario → #cedulaTipo = "cc", #cedulaInput = CC
6. Click reCAPTCHA checkbox
7. Verificar si paso sin challenge (sesion Google confiable)
8. Si hay challenge:
   a. Click boton audio (#recaptcha-audio-button) en bframe
   b. Esperar Buster (#solver-button) hasta 30s → click si aparece
   c. Si Buster no aparece: descargar audio via iframe fetch
   d. Transcribir con transcribe.py (Google STT + Whisper fallback)
   e. Llenar #audio-response y verificar
9. Submit → click #j_idt17
10. Extraer resultado de body
11. page.goBack() → volver al formulario para nueva consulta
```

---

## Solucion del reCAPTCHA

### Buster (principal)

Extension Chrome instalada en Profile 1. ID: `mpbjkejclgfgadiemmefgebjfooflfhl`

- Inyecta `#solver-button` dentro del iframe `bframe` de Google
- Solo aparece en **modo audio** (no en imagen)
- Descarga el audio, lo manda a Wit.ai, tipea la respuesta automaticamente

### Audio CDP (fallback)

Si Buster no inyecta el boton:
1. Capturar URL del audio del bframe (`.rc-audiochallenge-tdownload-link`)
2. Descargar MP3 via `bframe.evaluate(fetch(url))` con cookies del iframe
3. Guardar como `captcha_audio.mp3`
4. Transcribir con `transcribe.py`

### Por que a veces falla el audio

Google bloquea descargas de audio cuando detecta IP sospechosa o muchos intentos. En ese caso el MP3 llega con 0 bytes o con audio de calibracion (ruido). La sesion de Google en Profile 1 reduce la frecuencia de challenges duros.

---

## Diagnostico rapido

| Sintoma | Causa | Solucion |
|---|---|---|
| CDP no responde | Chrome muestra dialogo de recuperacion | Agregar `--disable-session-crashed-bubble` |
| CDP no responde | Instancia previa bloqueando puerto | Matar chrome.exe + borrar LOCK files |
| CDP no responde desde Node.js | Chrome hereda contexto incorrecto | Usar PowerShell `Start-Process`, no `exec()` de Node |
| Buster no aparece | Perfil equivocado cargado (sin extension) | Verificar `--profile-directory=Profile 1` |
| Audio 0 bytes | Bloqueo IP de Google | Esperar, cambiar IP, o resolver manualmente |
| Singleton block | Chrome envia args a instancia existente | Matar TODOS los procesos chrome.exe antes de lanzar |
| (macOS) CDP no responde | `--user-data-dir` apunta al perfil por defecto (Chrome 136+ lo bloquea) | Usar el dir clonado `Chrome-CDP` (lo hace `launch_chrome.sh`) |
| (macOS) Buster no aparece | El clon quedó desactualizado | Re-ejecutar `launch_chrome.sh` (re-sincroniza el perfil) |
