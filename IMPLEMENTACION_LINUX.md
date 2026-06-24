# Implementación en Linux — Guía Completa

Guía basada en la solución probada en Debian 12 ARM64 (AVF VM).
Incluye consideraciones específicas para **VPS real** (IP de datacenter).

---

## Requisitos del sistema

```bash
apt update
apt install -y chromium xvfb curl python3 python3-pip ffmpeg
```

> **ffmpeg es obligatorio** — lo usa pydub para convertir MP3 a WAV antes de transcribir.

---

## Dependencias Python

```bash
pip install pydub SpeechRecognition --break-system-packages
```

> No instalar `openai-whisper` a menos que tengas +4GB RAM disponibles.
> Se usa como fallback si Google STT falla.

Verificar que quedó bien:
```bash
python3 -c "import pydub, speech_recognition; print('OK')"
```

---

## Dependencias Node

```bash
cd /ruta/al/proyecto
npm install
```

---

## Lanzar Chrome con CDP

**IMPORTANTE:** No usar `/usr/bin/chromium` — el wrapper de Debian agrega flags que rompen extensiones y el comportamiento del browser. Usar el binario directo:

```bash
/usr/lib/chromium/chromium  # ← binario real
/usr/bin/chromium           # ← wrapper Debian, NO usar
```

El script `launch_chrome_linux.sh` ya está configurado correctamente:

```bash
bash launch_chrome_linux.sh
```

Lo que hace internamente:
1. Mata procesos chromium anteriores
2. Elimina `/tmp/.X99-lock` (evita error "Server already active")
3. Levanta Xvfb en display `:99`
4. Lanza Chromium con flags anti-detección
5. Espera hasta 40s a que CDP responda en puerto 9223

---

## Iniciar el servidor API

```bash
cd /ruta/al/proyecto
npx ts-node server.ts
```

El servidor queda escuchando en `http://127.0.0.1:3000`.

---

## Uso de la API

**Health check:**
```bash
curl http://127.0.0.1:3000/health
```

**Consultar antecedente:**
```bash
curl -X POST http://127.0.0.1:3000/consultar \
  -H "Content-Type: application/json" \
  -d '{"cedula":"1007601001","tipo":"cc"}'
```

---

## Solución CAPTCHA — cómo funciona

El servidor resuelve el reCAPTCHA en este orden:

1. **Sin challenge** — si Google pasa el checkbox solo (IP con buena reputación)
2. **Audio nativo** — hace click en `.help-button-holder` (botón de audio del bframe). En IPs residenciales Google suele pasar el CAPTCHA automáticamente en ~10s
3. **Audio + transcripción** — captura el MP3 del audio challenge via CDP, lo convierte con pydub/ffmpeg, transcribe con Google STT
4. **Whisper** — fallback local si Google STT falla (requiere instalación previa)

---

## VPS real (IP de datacenter) — problema y solución

En un VPS de AWS, DigitalOcean, GCP, etc., **Google bloquea la descarga del audio del CAPTCHA** desde IPs de datacenter. Los pasos 2 y 3 de arriba fallarán.

### Opción A — Proxy residencial (recomendada para producción)

Usar un proxy con IP residencial para las requests del browser:

1. Contratar un proxy residencial (Bright Data, Oxylabs, Smartproxy, etc.)
2. Agregar el flag al launch script:

```bash
/usr/lib/chromium/chromium \
  --proxy-server="http://USUARIO:PASS@proxy.host:PORT" \
  ... (resto de flags)
```

### Opción B — VPN residencial en el servidor

Instalar una VPN con exit node residencial (Mullvad, NordVPN con IP residencial).
El tráfico completo del servidor saldrá por IP residencial.

### Opción C — Anti-captcha service

Usar un servicio de resolución de CAPTCHA (2captcha, Anti-Captcha).
Requiere modificar `server.ts` para enviar el audio al servicio externo.

### Opción D — Rotación de IPs

Si el VPS es de un proveedor cloud con IPs elásticas, rotar la IP cuando Google bloquee.

---

## Flags de Chrome explicados

| Flag | Por qué |
|------|---------|
| `--no-sandbox` | Requerido para correr como root |
| `--disable-dev-shm-usage` | Evita crashes por `/dev/shm` pequeño en VPS |
| `--disable-gpu` | Sin GPU física disponible |
| `--disable-blink-features=AutomationControlled` | Oculta que el browser es controlado por automation |
| `--remote-allow-origins='*'` | Permite que Playwright conecte por CDP |

---

## Reinicio del servicio

Si el servidor se cae o hay que reiniciarlo:

```bash
# 1. Matar procesos anteriores
pkill -f "ts-node server.ts" || true
pkill -9 chromium || true

# 2. Lanzar Chrome
bash /ruta/al/proyecto/launch_chrome_linux.sh

# 3. Lanzar servidor
cd /ruta/al/proyecto
npx ts-node server.ts
```

---

## Problemas conocidos

| Error | Causa | Solución |
|-------|-------|----------|
| `CDP no levantó` | Lock de Xvfb sin limpiar | El script ya elimina `/tmp/.X99-lock` automáticamente |
| `Audio bloqueado (0 bytes)` | IP de datacenter | Ver sección VPS real arriba |
| `pydub not found` | Dependencias no instaladas | `pip install pydub SpeechRecognition --break-system-packages` |
| `CAPTCHA timeout` | Google detectó automatización | Agregar proxy residencial |
| `externally-managed-environment` | Debian 12 bloquea pip global | Usar `--break-system-packages` o un venv |
