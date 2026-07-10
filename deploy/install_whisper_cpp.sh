#!/usr/bin/env bash
# deploy/install_whisper_cpp.sh
# Instala whisper.cpp (STT LOCAL para el audio de reCAPTCHA) de forma reproducible.
# transcribe.py lo usa como transcriptor principal. Resuelve los audios "confusos"
# que Buster no puede, sin atarse a la versión de Python (el VPS es 3.8, donde
# faster-whisper no instala).
#
# Idempotente. Correr como root en el VPS:  sudo bash deploy/install_whisper_cpp.sh
set -euo pipefail

WHISPER_DIR="${WHISPER_DIR:-/root/whisper.cpp}"
# Commit PINEADO (el que dejó el servicio estable). Cambiar solo a propósito.
WHISPER_COMMIT="${WHISPER_COMMIT:-6fc7c33b4c3a2cec83e4b65abd5e96a890480375}"
WHISPER_MODEL_NAME="${WHISPER_MODEL_NAME:-base}"   # base MULTILINGÜE: el audio del reCAPTCHA es ESPAÑOL (sitio colombiano); base.en no lo saca
MODEL_FILE="models/ggml-${WHISPER_MODEL_NAME}.bin"

echo "[whisper.cpp] deps de sistema (git, build-essential, cmake, ffmpeg)..."
export DEBIAN_FRONTEND=noninteractive
apt-get install -y git build-essential cmake ffmpeg >/dev/null 2>&1 || \
  echo "  (aviso) revisá manualmente: git build-essential cmake ffmpeg"

echo "[whisper.cpp] clonar + pinear commit $WHISPER_COMMIT"
if [ ! -d "$WHISPER_DIR/.git" ]; then
  git clone https://github.com/ggerganov/whisper.cpp "$WHISPER_DIR"
fi
cd "$WHISPER_DIR"
git fetch origin >/dev/null 2>&1 || true
git checkout "$WHISPER_COMMIT" 2>/dev/null || echo "  (aviso) no se pudo pinear el commit, uso el HEAD actual"

echo "[whisper.cpp] build (cmake, Release)..."
cmake -B build -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build build -j"$(nproc)" --config Release >/dev/null
BIN="$WHISPER_DIR/build/bin/whisper-cli"
[ -x "$BIN" ] || { echo "ERROR: no se generó whisper-cli"; exit 1; }

echo "[whisper.cpp] modelo $WHISPER_MODEL_NAME (~142MB)..."
# El script oficial (models/download-ggml-model.sh) usa 'curl --retry-all-errors',
# flag que NO existe en el curl de Ubuntu 20.04 → descarga directa de HuggingFace.
if [ ! -f "$MODEL_FILE" ]; then
  curl -L --fail -o "$MODEL_FILE" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL_NAME}.bin"
fi

echo "[whisper.cpp] test (jfk.wav)..."
"$BIN" -m "$MODEL_FILE" -f samples/jfk.wav -nt 2>/dev/null | head -2

echo "[whisper.cpp] LISTO"
echo "  bin:    $BIN"
echo "  modelo: $WHISPER_DIR/$MODEL_FILE"
echo "  transcribe.py los toma por default (o via WHISPER_CPP_BIN / WHISPER_CPP_MODEL)."
