# DEPENDENCIAS — versiones pineadas para migrar el VPS en minutos

Manifest de todo lo que necesita el RPA de antecedentes para correr estable. Si migramos
a otro VPS, seguir el orden de abajo y en minutos queda igual. Versiones **verificadas**
en el VPS que dejó el servicio 5/5.

## Versiones (lo que corre hoy)

| Componente | Versión | Nota |
|---|---|---|
| OS | Ubuntu 20.04.6 LTS | x86_64, 2 cores, ~3.8 GB RAM |
| Node.js | v18.20.4 | corre `server.ts` vía `npx tsx` |
| npm | 10.7.0 | |
| Python | 3.8.10 | del sistema; **3.8 → faster-whisper NO instala** (por eso whisper.cpp) |
| Chrome for Testing | 149.0.7827.55 | `/usr/lib/chromium/chromium` (symlink a ms-playwright chromium-1228) |
| Playwright | ^1.61.0 | ver `package.json` |
| **whisper.cpp** | commit `6fc7c33b4c3a2cec83e4b65abd5e96a890480375` | STT local del audio; binario `whisper-cli` |
| modelo whisper | `ggml-base.en.bin` (~142 MB) | inglés, dígitos/palabras del reCAPTCHA |
| cmake | 3.16.3 | para compilar whisper.cpp |
| SpeechRecognition | 3.10.4 | fallback Google STT |
| pydub | 0.25.1 | conversión mp3→wav |
| buster-client | v0.3.0 | native host `org.buster.client` (input XTEST) |

### Paquetes de sistema (apt)
```
git build-essential cmake ffmpeg xvfb libxkbcommon-x11-0 chromium-browser
```
> `libxkbcommon-x11-0` es requisito del binario de buster-client (si falta, no arranca).

## Orden de instalación en un VPS nuevo

```bash
# 0) sistema
sudo apt-get update
sudo apt-get install -y git build-essential cmake ffmpeg xvfb libxkbcommon-x11-0 \
     nodejs npm python3 python3-pip

# 1) repo + deps node
git clone https://github.com/alexis14kl/RPA-consultar_antecedente_policia.git
cd RPA-consultar_antecedente_policia
npm install

# 2) deps python (fallback STT + conversión de audio)
pip3 install -r requirements.txt

# 3) whisper.cpp (STT local principal — pineado + modelo)
sudo bash deploy/install_whisper_cpp.sh

# 4) buster-client (native host, input XTEST)
sudo bash deploy/install_buster_client.sh     # requiere Chrome corriendo bajo Xvfb
#    y encender en Buster: simulateUserInput + navigateWithKeyboard (ver ANTIBAN_VPS.md)

# 5) systemd 24/7 (Xvfb + Chrome + server + watchdog)
sudo bash deploy/install.sh
sudo bash deploy/cutover.sh

# 6) verificar
curl -s localhost:4321/health      # → "pool" llegando a "pool_target":6
```

## Piezas del anti-ban / solver (contexto)
- `helpers/humanMouse.ts` — movimiento humano de fondo (baja el risk score). Ver `ANTIBAN_VPS.md`.
- `transcribe.py` — STT: **whisper.cpp** (principal) → faster-whisper (si Python ≥3.9) → Google STT.
  Configurable por env: `WHISPER_CPP_BIN`, `WHISPER_CPP_MODEL`, `AUDIO_MAX_ATTEMPTS`.
- `server.ts` — al fallar Buster en el audio, pide challenge NUEVO (reload) y reintenta con
  whisper.cpp hasta `AUDIO_MAX_ATTEMPTS` (default 3).

## Env vars útiles (server.ts)
| Env | Default | Qué hace |
|---|---|---|
| `PORT` / `HOST` | 4321 / 127.0.0.1 | puerto/host del API |
| `POOL_TARGET` | 6 | tokens en el pool |
| `WORKERS` | 2 | workers concurrentes |
| `AUDIO_MAX_ATTEMPTS` | 3 | reintentos de audio con whisper (reload + nuevo audio) |
| `WHISPER_CPP_BIN` | `/root/whisper.cpp/build/bin/whisper-cli` | binario whisper.cpp |
| `WHISPER_CPP_MODEL` | `/root/whisper.cpp/models/ggml-base.en.bin` | modelo |
| `CAPTCHA_TIMEOUT` | 35 | timeout del solve (s) |
