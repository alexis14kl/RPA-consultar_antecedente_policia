import sys
import os
import re
import subprocess
import urllib.request
from whisper_paths import WhisperPaths

# ffmpeg: en Mac/Linux vive en el PATH (brew/apt) y no se toca nada. En Windows,
# si winget no actualizó el PATH de la sesión, exportá FFMPEG_DIR apuntando al
# bin de ffmpeg.
FFMPEG_DIR = os.environ.get("FFMPEG_DIR")
if FFMPEG_DIR and os.path.isdir(FFMPEG_DIR):
    os.environ["PATH"] = FFMPEG_DIR + os.pathsep + os.environ.get("PATH", "")

# --- whisper.cpp (STT LOCAL principal) ---------------------------------------
# C++ nativo, corre rápido en CPU y sin atarse a la versión de Python (el VPS es
# Python 3.8, donde faster-whisper no instala). Saca los audios "confusos" de
# reCAPTCHA que Buster no puede. Instalación reproducible: deploy/install_whisper_cpp.sh
#
# Rutas DINÁMICAS (VPS, Mac, PATH…) resueltas por WhisperPaths — sin hardcode de /root.
# Overrides: WHISPER_CPP_BIN, WHISPER_CPP_MODEL, WHISPER_CPP_HOME. El sitio colombiano
# sirve el audio en ESPAÑOL → se usa el modelo MULTILINGÜE ggml-base.bin (el .en devuelve
# "(speaking in foreign language)" y nunca resuelve). Idioma configurable con CAPTCHA_LANG.
_whisper_paths = WhisperPaths()

# Modelo faster-whisper (fallback si algún día se instala en un Python 3.9+). Multilingüe.
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")

# Idioma del audio del reCAPTCHA. El sitio de la policía (colombiano) lo sirve en español.
CAPTCHA_LANG = os.environ.get("CAPTCHA_LANG", "es")
GOOGLE_STT_LANG = os.environ.get("GOOGLE_STT_LANG", "es-CO")


def download_audio(url: str, dest: str):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
        "Referer": "https://www.google.com/recaptcha/",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as r:
        with open(dest, "wb") as f:
            f.write(r.read())


def mp3_to_wav(mp3_path: str, wav_path: str, rate: int = None):
    """Convierte a WAV. Si rate está seteado, resamplea mono a esa frecuencia
    (whisper.cpp requiere PCM 16 kHz mono)."""
    from pydub import AudioSegment
    audio = AudioSegment.from_file(mp3_path)
    if rate:
        audio = audio.set_frame_rate(rate).set_channels(1)
    audio.export(wav_path, format="wav")


def transcribe_whispercpp(mp3_path: str) -> str:
    """Transcripción LOCAL con whisper.cpp (multilingüe, idioma CAPTCHA_LANG). WAV 16 kHz mono."""
    whisper_bin, whisper_model = _whisper_paths.bin(), _whisper_paths.model()
    if not (whisper_bin and whisper_model):
        raise RuntimeError(f"whisper.cpp no instalado ({_whisper_paths.describe()})")
    wav = mp3_path.rsplit(".", 1)[0] + ".16k.wav"
    try:
        mp3_to_wav(mp3_path, wav, rate=16000)
        out = subprocess.run(
            [whisper_bin, "-m", whisper_model, "-f", wav, "-nt", "-l", CAPTCHA_LANG],
            check=True, capture_output=True, text=True, timeout=120,
        )
        # -nt (no timestamps) → stdout es solo el texto (a veces con espacios extra).
        return " ".join(out.stdout.split()).strip().lower()
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass


def transcribe_whisper(path: str) -> str:
    """Fallback: faster-whisper (CPU, int8) — solo si está instalado (Python 3.9+)."""
    from faster_whisper import WhisperModel
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(path, language=CAPTCHA_LANG, beam_size=1)
    return " ".join(seg.text for seg in segments).strip().lower()


def transcribe_google(wav_path: str) -> str:
    """Google Speech (web, gratis, rate-limitea). Es el motor por defecto de Buster."""
    import speech_recognition as sr
    r = sr.Recognizer()
    with sr.AudioFile(wav_path) as source:
        audio_data = r.record(source)
    return r.recognize_google(audio_data, language=GOOGLE_STT_LANG).lower()


def transcribe_google_mp3(mp3_path: str) -> str:
    """Google STT tomando un mp3 (convierte a wav primero)."""
    wav = mp3_path.rsplit(".", 1)[0] + ".g.wav"
    try:
        mp3_to_wav(mp3_path, wav)
        return transcribe_google(wav)
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass


def transcribe_wit(mp3_path: str) -> str:
    """Wit.ai — el motor CONFIGURABLE de Buster. Requiere WIT_AI_TOKEN (server access
    token, gratis en wit.ai). Sin token, se saltea."""
    token = os.environ.get("WIT_AI_TOKEN")
    if not token:
        raise RuntimeError("WIT_AI_TOKEN no seteado")
    wav = mp3_path.rsplit(".", 1)[0] + ".wit.wav"
    try:
        mp3_to_wav(mp3_path, wav, rate=16000)  # Wit prefiere PCM 16 kHz mono
        with open(wav, "rb") as f:
            body = f.read()
        req = urllib.request.Request(
            "https://api.wit.ai/speech?v=20230215",
            data=body,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "audio/wav"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8", "ignore")
        # Wit stremea varios objetos JSON parciales; el texto final es el último "text".
        best = ""
        for m in re.finditer(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"', raw):
            best = m.group(1)
        return best.strip().lower()
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass


# Motores de STT. "whisper" = whisper.cpp/faster-whisper (local). "google"/"wit" = los
# motores que usa Buster (Google Speech por defecto; Wit.ai configurable con token).
ENGINES = {
    "whisper": [transcribe_whispercpp, transcribe_whisper],
    "google": [transcribe_google_mp3],
    "wit": [transcribe_wit],
}


def transcribe_file(mp3_path: str, engine: str = "auto") -> str:
    """Transcribe con un motor específico (whisper|google|wit) o con la cadena completa
    si engine='auto'. Devuelve "" si no logra texto — el llamador decide reintentar con
    otro motor sobre el mismo audio, o pedir un audio nuevo."""
    if engine == "auto":
        order = ["whisper", "google"]
        if os.environ.get("WIT_AI_TOKEN"):
            order.append("wit")
    else:
        order = [engine]
    for eng in order:
        for fn in ENGINES.get(eng, []):
            try:
                text = fn(mp3_path)
                if text:
                    return text
            except Exception as e:
                print(f"{eng}/{fn.__name__} falló: {e}", file=sys.stderr)
    return ""


def transcribe(url: str) -> str:
    tmp = "captcha_audio.mp3"
    download_audio(url, tmp)
    return transcribe_file(tmp)


if __name__ == "__main__":
    # Uso: transcribe.py file <mp3> [engine]   (engine: whisper|google|wit|auto, default auto)
    if len(sys.argv) >= 3 and sys.argv[1] == "file":
        engine = sys.argv[3] if len(sys.argv) >= 4 else "auto"
        print(transcribe_file(sys.argv[2], engine))
    else:
        print(transcribe(sys.argv[1]))
