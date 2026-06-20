# Consulta Automatica de Antecedentes Judiciales

Automatiza la consulta en `antecedentes.policia.gov.co:7005` usando Playwright + Chrome DevTools Protocol (CDP).

---

## Archivos

| Archivo | Rol |
|---|---|
| `run.bat` | Entry point — lanza todo en un solo doble-clic |
| `launch_chrome.ps1` | Abre Chrome con Profile 1 + CDP activo |
| `browser.ts` | Automatiza la consulta (Playwright via CDP) |
| `transcribe.py` | Transcribe audio del reCAPTCHA si es necesario |

---

## Uso

```
matar procesos
taskkill /f /im chrome.exe /t 2>$null; Start-Sleep -Seconds 2; Get-Process chrome -ErrorAction SilentlyContinue | Select-Object Name, Id


Doble-clic en run.bat
```

Eso es todo. El bat hace todo automáticamente.

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
