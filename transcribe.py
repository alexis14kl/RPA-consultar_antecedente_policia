import sys
import os
import subprocess
import urllib.request

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
WHISPER_CPP_BIN = os.environ.get("WHISPER_CPP_BIN", "/root/whisper.cpp/build/bin/whisper-cli")
WHISPER_CPP_MODEL = os.environ.get("WHISPER_CPP_MODEL", "/root/whisper.cpp/models/ggml-base.en.bin")

# Modelo faster-whisper (fallback si algún día se instala en un Python 3.9+).
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base.en")


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
    """Transcripción LOCAL con whisper.cpp (base.en). Requiere WAV 16 kHz mono."""
    if not (os.path.exists(WHISPER_CPP_BIN) and os.path.exists(WHISPER_CPP_MODEL)):
        raise RuntimeError(f"whisper.cpp no instalado ({WHISPER_CPP_BIN})")
    wav = mp3_path.rsplit(".", 1)[0] + ".16k.wav"
    try:
        mp3_to_wav(mp3_path, wav, rate=16000)
        out = subprocess.run(
            [WHISPER_CPP_BIN, "-m", WHISPER_CPP_MODEL, "-f", wav, "-nt", "-l", "en"],
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
    segments, _ = model.transcribe(path, language="en", beam_size=1)
    return " ".join(seg.text for seg in segments).strip().lower()


def transcribe_google(wav_path: str) -> str:
    """Último fallback: API web gratis de Google (rate-limitea)."""
    import speech_recognition as sr
    r = sr.Recognizer()
    with sr.AudioFile(wav_path) as source:
        audio_data = r.record(source)
    return r.recognize_google(audio_data, language="en-US").lower()


def transcribe_file(mp3_path: str) -> str:
    # 1) whisper.cpp local (principal). 2) faster-whisper si existe. 3) Google STT web.
    for fn in (transcribe_whispercpp, transcribe_whisper):
        try:
            text = fn(mp3_path)
            if text:
                return text
        except Exception as e:
            print(f"{fn.__name__} falló: {e}", file=sys.stderr)
    wav = mp3_path.replace(".mp3", ".wav")
    try:
        mp3_to_wav(mp3_path, wav)
        text = transcribe_google(wav)
        try:
            os.remove(wav)
        except OSError:
            pass
        return text
    except Exception as e1:
        raise RuntimeError(f"Transcripción falló (whisper.cpp + faster-whisper + Google STT): {e1}")


def transcribe(url: str) -> str:
    tmp = "captcha_audio.mp3"
    download_audio(url, tmp)
    return transcribe_file(tmp)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "file":
        print(transcribe_file(sys.argv[2]))
    else:
        print(transcribe(sys.argv[1]))
