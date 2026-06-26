# Implementación en Linux — Guía Completa

Guía basada en la solución probada en Debian 12 ARM64.
Incluye consideraciones para **VPS real** (IP de datacenter).

---

## Requisitos del sistema

```bash
apt update
apt install -y chromium xvfb curl python3 python3-pip ffmpeg flac
```

---

## Dependencias Python

```bash
pip install pydub SpeechRecognition --break-system-packages
```

Verificar:
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

## Arranque completo (orden importante)

### Paso 1 — Lanzar Chrome con CDP

```bash
bash /home/droid/RPA-consultar_antecedente_policia/launch_chrome_linux.sh
```

Espera hasta ver: `✅ CDP ACTIVO en Xs`

### Paso 2 — Lanzar el servidor API

```bash
cd /home/droid/RPA-consultar_antecedente_policia
PORT=4321 npx ts-node server.ts
```

Espera hasta ver: `Servidor activo en http://127.0.0.1:4321`

### Paso 3 — Lanzar el tunnel de Cloudflare

```bash
cloudflared tunnel run --token TU_TOKEN_AQUI
```

Espera hasta ver: `Registered tunnel connection connIndex=0`

El token lo obtenés en: **Cloudflare Dashboard → Zero Trust → Networks → Tunnels → tu túnel → Configure → Token**

---

## Verificar que todo funciona

```bash
# Health local
curl http://127.0.0.1:4321/health

# Health por Cloudflare (pública)
curl https://TU_DOMINIO.alexis-madrigal.com/health
```

---

## Uso de la API

**Consultar antecedente:**
```bash
curl -X POST https://TU_DOMINIO.alexis-madrigal.com/consultar \
  -H "Content-Type: application/json" \
  -d '{"cedula":"1007601001","tipo":"cc"}'
```

**Respuesta:**
```json
{
  "ok": true,
  "cedula": "1007601001",
  "datos": {
    "cedula_consultada": "1007601001",
    "nombre": "NOMBRE APELLIDO",
    "tiene_antecedentes": false,
    "estado": "NO TIENE ASUNTOS PENDIENTES CON LAS AUTORIDADES JUDICIALES",
    "fecha_consulta": "23/06/2026",
    "hora_consulta": "11:38:21 PM"
  }
}
```

---

## Cómo funciona el CAPTCHA

El servidor resuelve el reCAPTCHA automáticamente en este orden:

1. **Sin challenge** — Google pasa el checkbox solo (IP con buena reputación)
2. **Audio nativo** — clickea `.help-button-holder` (botón audio del bframe). En IPs residenciales Google pasa el CAPTCHA en ~10s automáticamente
3. **Audio + transcripción** — captura el MP3 via CDP, convierte con pydub/ffmpeg, transcribe con Google STT
4. **Whisper** — fallback local (requiere instalación separada: `pip install openai-whisper`)

> **Nota:** El log dice "Buster resolvió" pero no es la extensión Buster — es el audio nativo del reCAPTCHA resuelto por la IP residencial.

---

## VPS real (IP de datacenter) — problema y solución

En VPS de AWS, DigitalOcean, GCP etc., **Google bloquea el audio del CAPTCHA** desde IPs de datacenter.

### Opción A — Proxy residencial (recomendada)

```bash
/usr/lib/chromium/chromium \
  --proxy-server="http://USUARIO:PASS@proxy.host:PORT" \
  ... (resto de flags)
```

Proveedores: Bright Data, Oxylabs, Smartproxy.

### Opción B — VPN residencial

Instalar VPN con exit node residencial (Mullvad, NordVPN).

### Opción C — Anti-captcha service

Usar 2captcha o Anti-Captcha y modificar `server.ts` para enviar el audio al servicio.

---

## Flags de Chrome explicados

| Flag | Por qué |
|------|---------|
| `--no-sandbox` | Requerido para correr como root |
| `--disable-dev-shm-usage` | Evita crashes por `/dev/shm` pequeño en VPS |
| `--disable-gpu` | Sin GPU física disponible |
| `--disable-blink-features=AutomationControlled` | Oculta que el browser es controlado |
| `--remote-allow-origins='*'` | Permite que Playwright conecte por CDP |

> **IMPORTANTE:** Usar `/usr/lib/chromium/chromium` directo, NO `/usr/bin/chromium`. El wrapper de Debian agrega flags que rompen el comportamiento del browser.

---

## Reinicio del servicio

```bash
# Matar todo
pkill -f "ts-node server.ts" || true
pkill -9 chromium || true
pkill -f cloudflared || true

# Relanzar en orden
bash /home/droid/RPA-consultar_antecedente_policia/launch_chrome_linux.sh
cd /home/droid/RPA-consultar_antecedente_policia && PORT=4321 npx ts-node server.ts &
cloudflared tunnel run --token TU_TOKEN &
```

---

## Problemas conocidos

| Error | Causa | Solución |
|-------|-------|----------|
| `CDP no levantó` | Lock de Xvfb sin limpiar | El script elimina `/tmp/.X99-lock` automáticamente |
| `Audio bloqueado (0 bytes)` | IP de datacenter | Ver sección VPS real |
| `pydub not found` | Dependencias no instaladas | `pip install pydub SpeechRecognition --break-system-packages` |
| `reCAPTCHA no resuelto dentro del timeout` | Google bloqueó temporalmente | Esperar 1-2 min y reintentar |
| `externally-managed-environment` | Debian 12 bloquea pip global | Usar `--break-system-packages` |
| `CDP no activo` | Chrome se cayó | Correr `launch_chrome_linux.sh` de nuevo |
